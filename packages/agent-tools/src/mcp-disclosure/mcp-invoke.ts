import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  defineRuntimeTool,
  type RuntimeTool,
  type ToolExecutionContext,
} from '@mavis/agent-core/tools';

export interface McpInvokeReferenceTarget {
  readonly tool: RuntimeTool;
  readonly pluginName: string;
  readonly inputSchema: RuntimeTool['def']['schema'];
}

export interface McpInvokeInput {
  readonly tool_name?: string;
  readonly tool_ref?: string;
  readonly arguments?: Record<string, unknown>;
  readonly arguments_json?: string;
}

export type McpInvokeTargetResolution =
  | {
      readonly kind: 'resolved';
      readonly selectorKind: 'tool_name' | 'tool_ref';
      readonly selector: string;
      readonly target: RuntimeTool;
      readonly arguments: Record<string, unknown>;
      readonly inputSchema: RuntimeTool['def']['schema'];
      readonly pluginName?: string;
    }
  | { readonly kind: 'error'; readonly message: string };

type ResolvedMcpInvokeTarget = Extract<McpInvokeTargetResolution, { readonly kind: 'resolved' }>;

interface McpInvokeMetadata {
  readonly resolve: (input: McpInvokeInput) => McpInvokeTargetResolution;
  readonly pendingResolutions: WeakMap<object, ResolvedMcpInvokeTarget>;
  readonly authorizedInputs: WeakMap<object, ResolvedMcpInvokeTarget>;
  readonly registry: ReadonlyMap<string, RuntimeTool>;
  readonly referenceRegistry: ReadonlyMap<string, McpInvokeReferenceTarget>;
}

const METADATA = new WeakMap<RuntimeTool, McpInvokeMetadata>();
const MCP_INVOKE_METADATA = Symbol('mavis.mcp-invoke.metadata');
const MAX_ARGUMENTS_JSON_BYTES = 256 * 1024;
const MAX_ARGUMENTS_JSON_DEPTH = 64;
const MAX_ARGUMENTS_JSON_NODES = 10_000;
const UNSAFE_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

interface McpInvokeMetadataCarrier {
  readonly [MCP_INVOKE_METADATA]?: McpInvokeMetadata;
}

export function createMcpInvokeTool<TCtx extends ToolExecutionContext = ToolExecutionContext>(
  registry: ReadonlyMap<string, RuntimeTool>,
  referenceRegistry: ReadonlyMap<string, McpInvokeReferenceTarget> = new Map(),
): RuntimeTool {
  const schema = Type.Object({
    tool_name: Type.Optional(
      Type.String({ description: 'Exact tool name from a prior tool_search result.' }),
    ),
    tool_ref: Type.Optional(
      Type.String({ description: 'Opaque tool reference supplied by an installed Plugin Skill.' }),
    ),
    arguments: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          'Free-form arguments object used with tool_name and accepted for legacy tool_ref calls. Omitted tool_name arguments default to an empty object. Host tool contracts use arguments_json instead.',
      }),
    ),
    arguments_json: Type.Optional(
      Type.String({
        description:
          'A JSON-encoded object string available only with tool_ref. Omit arguments when using this field. Runtime validation applies a bounded UTF-8 byte limit.',
      }),
    ),
  });
  const metadata: McpInvokeMetadata = {
    resolve: (input) => resolveTarget(input, registry, referenceRegistry),
    pendingResolutions: new WeakMap(),
    authorizedInputs: new WeakMap(),
    registry,
    referenceRegistry,
  };
  const tool = defineRuntimeTool({
    name: 'mcp_invoke',
    description:
      'Execute a deferred tool. Pass exactly one selector. `tool_name` from tool_search uses free-form `arguments` (or an empty object when omitted). ' +
      'An opaque `tool_ref` supplied by an installed Plugin Skill accepts legacy `arguments` or the structure-preserving ' +
      '`arguments_json` string required by current Host tool contracts, never both.',
    schema,
    execute: async (ctx, input: McpInvokeInput, signal, onUpdate) => {
      const authorized = metadata.authorizedInputs.get(input);
      if (authorized) metadata.authorizedInputs.delete(input);
      const resolution = authorized ?? metadata.resolve(input);
      if (resolution.kind === 'error') return errorResult(resolution.message);
      if (resolution.selectorKind === 'tool_ref' && !authorized) {
        return errorResult(
          'Host-bound tool_ref execution was not admitted by the Host policy pipeline.',
        );
      }
      return resolution.target.impl.execute(
        ctx as TCtx,
        resolution.arguments as never,
        signal,
        onUpdate,
      );
    },
  });
  // RuntimeTool decorators use object spread. Keep the private symbol
  // enumerable so those immutable clones retain the turn-local gateway
  // registry without exposing it in JSON or the model-facing definition.
  Object.defineProperty(tool, MCP_INVOKE_METADATA, {
    value: metadata,
    enumerable: true,
  });
  METADATA.set(tool, metadata);
  return tool;
}

/** Resolves the real target for Host policy without exposing the hidden registry to the model. */
export function resolveMcpInvokeTarget(
  tool: RuntimeTool,
  input: unknown,
): McpInvokeTargetResolution | undefined {
  const metadata = readMetadata(tool);
  if (!metadata) return undefined;
  const parsed = readInput(input);
  const resolution = metadata.resolve(parsed);
  if (resolution.kind === 'resolved') metadata.pendingResolutions.set(parsed, resolution);
  return resolution;
}

/** One-shot admission marker consumed by the subsequent Host-bound execution of this input object. */
export function authorizeMcpInvokeReference(
  tool: RuntimeTool,
  input: unknown,
): McpInvokeTargetResolution {
  const metadata = readMetadata(tool);
  if (!metadata) return { kind: 'error', message: 'Tool is not an mcp_invoke gateway.' };
  const parsed = readInput(input);
  const pending = metadata.pendingResolutions.get(parsed);
  if (!pending && typeof parsed.tool_ref === 'string' && parsed.tool_ref.length > 0) {
    return {
      kind: 'error',
      message: 'Host-bound tool_ref was not resolved by the Host policy pipeline.',
    };
  }
  const resolution = pending ?? metadata.resolve(parsed);
  metadata.pendingResolutions.delete(parsed);
  if (resolution.kind === 'error') return resolution;
  const mismatch = schemaMismatch(
    resolution.inputSchema,
    resolution.selector,
    resolution.arguments,
    resolution.selectorKind === 'tool_ref',
  );
  if (mismatch) return { kind: 'error', message: mismatch };
  let authorizedArguments: Record<string, unknown>;
  try {
    authorizedArguments = structuredClone(resolution.arguments);
  } catch {
    return { kind: 'error', message: 'Host-bound arguments could not be snapshotted safely.' };
  }
  const snapshotMismatch = schemaMismatch(
    resolution.inputSchema,
    resolution.selector,
    authorizedArguments,
    resolution.selectorKind === 'tool_ref',
  );
  if (snapshotMismatch) return { kind: 'error', message: snapshotMismatch };
  metadata.authorizedInputs.set(parsed, { ...resolution, arguments: authorizedArguments });
  return resolution;
}

/** Revokes a prior Host admission when execution cannot cross the final delivery seam. */
export function revokeMcpInvokeReferenceAuthorization(tool: RuntimeTool, input: unknown): void {
  const metadata = readMetadata(tool);
  if (!metadata) return;
  const parsed = readInput(input);
  metadata.pendingResolutions.delete(parsed);
  metadata.authorizedInputs.delete(parsed);
}

function readMetadata(tool: RuntimeTool): McpInvokeMetadata | undefined {
  return METADATA.get(tool) ?? (tool as McpInvokeMetadataCarrier)[MCP_INVOKE_METADATA];
}

function resolveTarget(
  input: McpInvokeInput,
  registry: ReadonlyMap<string, RuntimeTool>,
  referenceRegistry: ReadonlyMap<string, McpInvokeReferenceTarget>,
): McpInvokeTargetResolution {
  const hasToolName = typeof input.tool_name === 'string' && input.tool_name.length > 0;
  const hasToolRef = typeof input.tool_ref === 'string' && input.tool_ref.length > 0;
  if (hasToolName === hasToolRef) {
    return { kind: 'error', message: 'Pass exactly one of tool_name or tool_ref.' };
  }
  const selectorKind = hasToolName ? 'tool_name' : 'tool_ref';
  const selector = (hasToolName ? input.tool_name : input.tool_ref) as string;
  const reference = hasToolRef ? referenceRegistry.get(selector) : undefined;
  const target = hasToolName ? registry.get(selector) : reference?.tool;
  if (!target) {
    return {
      kind: 'error',
      message: hasToolName
        ? 'Unknown tool_name. Use tool_search only if it is available in this turn. For Host-bound tools, fully read the Plugin Skill and use the exact tool_ref from its Host tool contracts.'
        : 'Unknown or unavailable tool_ref. Re-read the installed Plugin Skill before retrying.',
    };
  }
  const decoded = decodeArguments(input, selectorKind);
  if (decoded.kind === 'error') return decoded;
  let prepared: unknown;
  try {
    prepared = target.def.prepareArguments
      ? target.def.prepareArguments(decoded.arguments)
      : decoded.arguments;
  } catch (error) {
    return {
      kind: 'error',
      message: `Arguments could not be prepared for "${selector}": ${boundedError(error)}`,
    };
  }
  const inputSchema = reference?.inputSchema ?? target.def.schema;
  const mismatch = schemaMismatch(inputSchema, selector, prepared, selectorKind === 'tool_ref');
  if (mismatch) return { kind: 'error', message: mismatch };
  return {
    kind: 'resolved',
    selectorKind,
    selector,
    target,
    arguments: isRecord(prepared) ? prepared : {},
    inputSchema,
    ...(reference?.pluginName ? { pluginName: reference.pluginName } : {}),
  };
}

function decodeArguments(
  input: McpInvokeInput,
  selectorKind: 'tool_name' | 'tool_ref',
):
  | { readonly kind: 'resolved'; readonly arguments: Record<string, unknown> }
  | { readonly kind: 'error'; readonly message: string } {
  const hasArguments = Object.prototype.hasOwnProperty.call(input, 'arguments');
  const hasArgumentsJson = Object.prototype.hasOwnProperty.call(input, 'arguments_json');
  if (selectorKind === 'tool_name' && hasArgumentsJson) {
    return {
      kind: 'error',
      message: 'arguments_json is only available with tool_ref; pass arguments with tool_name.',
    };
  }
  if (selectorKind === 'tool_name' && !hasArguments) {
    return { kind: 'resolved', arguments: {} };
  }
  if (hasArguments === hasArgumentsJson) {
    return { kind: 'error', message: 'Pass exactly one of arguments or arguments_json.' };
  }
  if (hasArguments) {
    if (!isRecord(input.arguments)) {
      return { kind: 'error', message: 'arguments must be a JSON object.' };
    }
    if (selectorKind === 'tool_ref') {
      const structuralError = validateDecodedJson(input.arguments, 'arguments');
      if (structuralError) return { kind: 'error', message: structuralError };
      let serialized: string;
      try {
        serialized = JSON.stringify(input.arguments);
      } catch {
        return { kind: 'error', message: 'arguments must contain only serializable JSON values.' };
      }
      if (Buffer.byteLength(serialized, 'utf8') > MAX_ARGUMENTS_JSON_BYTES) {
        return {
          kind: 'error',
          message: `arguments must not exceed ${MAX_ARGUMENTS_JSON_BYTES} UTF-8 bytes.`,
        };
      }
    }
    return { kind: 'resolved', arguments: input.arguments };
  }
  if (typeof input.arguments_json !== 'string') {
    return { kind: 'error', message: 'arguments_json must be a JSON string.' };
  }
  if (Buffer.byteLength(input.arguments_json, 'utf8') > MAX_ARGUMENTS_JSON_BYTES) {
    return {
      kind: 'error',
      message: `arguments_json must not exceed ${MAX_ARGUMENTS_JSON_BYTES} UTF-8 bytes.`,
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.arguments_json) as unknown;
  } catch {
    return { kind: 'error', message: 'arguments_json is not valid JSON.' };
  }
  if (!isRecord(decoded)) {
    return { kind: 'error', message: 'arguments_json must encode a JSON object.' };
  }
  const structuralError = validateDecodedJson(decoded, 'arguments_json');
  if (structuralError) {
    return {
      kind: 'error',
      message: structuralError,
    };
  }
  return { kind: 'resolved', arguments: decoded };
}

function validateDecodedJson(
  value: unknown,
  fieldName: 'arguments' | 'arguments_json',
): string | undefined {
  const pending: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodeCount += 1;
    if (nodeCount > MAX_ARGUMENTS_JSON_NODES) {
      return `${fieldName} must not exceed ${MAX_ARGUMENTS_JSON_NODES} JSON nodes.`;
    }
    if (current.depth > MAX_ARGUMENTS_JSON_DEPTH) {
      return `${fieldName} must not exceed a depth of ${MAX_ARGUMENTS_JSON_DEPTH}.`;
    }
    if (Array.isArray(current.value)) {
      if (visited.has(current.value)) return `${fieldName} must not contain circular values.`;
      visited.add(current.value);
      if (nodeCount + pending.length + current.value.length > MAX_ARGUMENTS_JSON_NODES) {
        return `${fieldName} must not exceed ${MAX_ARGUMENTS_JSON_NODES} JSON nodes.`;
      }
      for (const nested of current.value) {
        pending.push({ value: nested, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(current.value)) {
      if (
        current.value === null ||
        typeof current.value === 'string' ||
        typeof current.value === 'boolean' ||
        (typeof current.value === 'number' && Number.isFinite(current.value))
      ) {
        continue;
      }
      return `${fieldName} must contain only JSON values.`;
    }
    if (visited.has(current.value)) return `${fieldName} must not contain circular values.`;
    visited.add(current.value);
    const prototype = Object.getPrototypeOf(current.value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return `${fieldName} must contain only plain JSON objects.`;
    }
    const entries = Object.entries(current.value);
    if (nodeCount + pending.length + entries.length > MAX_ARGUMENTS_JSON_NODES) {
      return `${fieldName} must not exceed ${MAX_ARGUMENTS_JSON_NODES} JSON nodes.`;
    }
    for (const [key, nested] of entries) {
      if (UNSAFE_JSON_KEYS.has(key)) {
        return `${fieldName} contains the disallowed object key "${key}".`;
      }
      pending.push({ value: nested, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function schemaMismatch(
  inputSchema: RuntimeTool['def']['schema'],
  selector: string,
  prepared: unknown,
  failClosed: boolean,
): string | undefined {
  try {
    if (Value.Check(inputSchema, prepared)) return undefined;
    const issues = [...Value.Errors(inputSchema, prepared)]
      .slice(0, 8)
      .map((error) => `${error.path}: ${error.message}`);
    const summary = `Arguments do not match the schema for "${selector}":\n${issues.join('\n')}`;
    return failClosed ? summary : `${summary}\ninput_schema: ${JSON.stringify(inputSchema)}`;
  } catch {
    // Plain JSON Schema from an MCP server has no TypeBox internal symbols.
    return failClosed ? `Host schema validation is unavailable for "${selector}".` : undefined;
  }
}

function readInput(value: unknown): McpInvokeInput {
  if (!isRecord(value)) return { arguments: {} };
  return value as unknown as McpInvokeInput;
}

function errorResult(text: string) {
  return {
    tool_name: 'mcp_invoke',
    text,
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 512);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Assembly-only access; adding built-in targets preserves the existing Host reference bindings. */
export function getMcpInvokeRegistries(
  tool: RuntimeTool,
): Pick<McpInvokeMetadata, 'registry' | 'referenceRegistry'> | undefined {
  return readMetadata(tool);
}
