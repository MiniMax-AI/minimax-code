import { Type } from '@sinclair/typebox';
import {
  defineRuntimeTool,
  repairRuntimeToolInput,
  validateRuntimeToolInput,
  type RuntimeTool,
  type RuntimeToolInputValidation,
  type ToolExecutionContext,
} from '@mavis/agent-core/tools';
import { TOOL_SEARCH_MAX_RESULT_BYTES } from './bounded-tool-search.js';

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
  readonly registry: ReadonlyMap<string, RuntimeTool>;
  readonly referenceRegistry: ReadonlyMap<string, McpInvokeReferenceTarget>;
  readonly resolve: (input: McpInvokeInput) => McpInvokeTargetResolution;
  readonly pendingResolutions: WeakMap<object, ResolvedMcpInvokeTarget>;
  readonly authorizedInputs: WeakMap<object, ResolvedMcpInvokeTarget>;
}

const METADATA = new WeakMap<RuntimeTool, McpInvokeMetadata>();
const MCP_INVOKE_METADATA = Symbol('mavis.mcp-invoke.metadata');
const MAX_ARGUMENTS_JSON_BYTES = 256 * 1024;
const MAX_ARGUMENTS_JSON_DEPTH = 64;
const MAX_ARGUMENTS_JSON_NODES = 10_000;
const UNSAFE_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_RECEIVED_PREVIEW_LENGTH = 60;
const ARGUMENT_TYPE_GUIDANCE =
  'Send each value with its schema type: numbers and booleans unquoted, arrays as JSON arrays, objects as JSON objects; or pass the whole object as a JSON string in arguments_json.';

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
          'Arguments object for the target tool; omitted means {} with tool_name. Values keep their JSON types: numbers and booleans unquoted, arrays as JSON arrays, objects as JSON objects.',
      }),
    ),
    arguments_json: Type.Optional(
      Type.String({
        description:
          'The same arguments object encoded as a JSON string, preserving exact types. Accepted with tool_name or tool_ref; omit arguments when using it. Size-limited.',
      }),
    ),
  });
  const metadata: McpInvokeMetadata = {
    registry,
    referenceRegistry,
    resolve: (input) => resolveTarget(input, registry, referenceRegistry),
    pendingResolutions: new WeakMap(),
    authorizedInputs: new WeakMap(),
  };
  const tool = defineRuntimeTool({
    name: 'mcp_invoke',
    description:
      'Execute an on-demand tool, including built-in scheduled-task management and integrations. Pass exactly one selector: `tool_name` from tool_search, or an opaque `tool_ref` supplied by an installed Plugin Skill. ' +
      'Pass the target arguments as `arguments` or as the type-preserving `arguments_json` string (required by Host tool contracts), never both.',
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
    if (hasToolRef && registry.has(selector)) {
      return {
        kind: 'error',
        message: `"${selector}" is a tool_name, not a tool_ref. Call mcp_invoke with tool_name: "${selector}".`,
      };
    }
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
  if (!isRecord(prepared)) {
    return { kind: 'error', message: `Prepared arguments for "${selector}" must be an object.` };
  }
  const inputSchema = reference?.inputSchema ?? target.def.schema;
  // Built-in deferred tools get lossless repair of transport artifacts (stringified
  // scalars, {"item": ...} array wrappers, JSON-text objects/arrays). Host-bound
  // tool_ref payloads stay structure-preserving.
  let finalArguments: Record<string, unknown> = prepared;
  let mismatch: string | undefined;
  if (selectorKind === 'tool_name') {
    const repaired = repairRuntimeToolInput(inputSchema, prepared);
    mismatch = formatMismatch(inputSchema, selector, repaired.value, repaired.validation, false);
    if (!mismatch && isRecord(repaired.value)) finalArguments = repaired.value;
  } else {
    mismatch = schemaMismatch(inputSchema, selector, prepared, true);
  }
  if (mismatch) return { kind: 'error', message: mismatch };
  return {
    kind: 'resolved',
    selectorKind,
    selector,
    target,
    arguments: finalArguments,
    inputSchema,
    ...(reference?.pluginName ? { pluginName: reference.pluginName } : {}),
  };
}

type DecodedArguments =
  | { readonly kind: 'resolved'; readonly arguments: Record<string, unknown> }
  | { readonly kind: 'error'; readonly message: string };

function decodeArguments(
  input: McpInvokeInput,
  selectorKind: 'tool_name' | 'tool_ref',
): DecodedArguments {
  const hasArguments = Object.prototype.hasOwnProperty.call(input, 'arguments');
  const hasArgumentsJson = Object.prototype.hasOwnProperty.call(input, 'arguments_json');
  if (selectorKind === 'tool_name' && !hasArguments && !hasArgumentsJson) {
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
  return decodeArgumentsJson(input.arguments_json, selectorKind);
}

/**
 * Host references (`tool_ref`) keep the size, depth and node limits. A `tool_name`
 * call gets no limits beyond those of `arguments`, which arrive already parsed from
 * the tool call; only a `__proto__` key is refused, so a later merge of the decoded
 * object cannot reach a prototype.
 */
function decodeArgumentsJson(
  text: unknown,
  selectorKind: 'tool_name' | 'tool_ref',
): DecodedArguments {
  if (typeof text !== 'string') {
    return { kind: 'error', message: 'arguments_json must be a JSON string.' };
  }
  const bounded = selectorKind === 'tool_ref';
  if (bounded && Buffer.byteLength(text, 'utf8') > MAX_ARGUMENTS_JSON_BYTES) {
    return {
      kind: 'error',
      message: `arguments_json must not exceed ${MAX_ARGUMENTS_JSON_BYTES} UTF-8 bytes.`,
    };
  }
  let decoded: unknown;
  let protoKey = false;
  const reviver = (key: string, value: unknown): unknown => {
    if (key === '__proto__') protoKey = true;
    return value;
  };
  try {
    decoded = JSON.parse(text, bounded ? undefined : reviver) as unknown;
  } catch {
    return { kind: 'error', message: 'arguments_json is not valid JSON.' };
  }
  if (!isRecord(decoded)) {
    return { kind: 'error', message: 'arguments_json must encode a JSON object.' };
  }
  const structuralError = bounded
    ? validateDecodedJson(decoded, 'arguments_json')
    : protoKey
      ? 'arguments_json contains the disallowed object key "__proto__".'
      : undefined;
  if (structuralError) return { kind: 'error', message: structuralError };
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
  hostReference: boolean,
): string | undefined {
  return formatMismatch(
    inputSchema,
    selector,
    prepared,
    validateRuntimeToolInput(inputSchema, prepared),
    hostReference,
  );
}

function formatMismatch(
  inputSchema: RuntimeTool['def']['schema'],
  selector: string,
  value: unknown,
  validation: RuntimeToolInputValidation,
  hostReference: boolean,
): string | undefined {
  if (validation.valid) return undefined;
  if (validation.reason === 'unsupported') {
    return `${hostReference ? 'Host schema' : 'Schema'} validation is unavailable for "${selector}".`;
  }
  if (hostReference) {
    return `Arguments do not match the schema for "${selector}":\n${validation.issues.join('\n')}`;
  }
  const issues = validation.issues.map(
    (issue, index) => `${issue}${describeReceived(value, validation.paths?.[index])}`,
  );
  let schemaLine: string | undefined;
  try {
    const schemaText = JSON.stringify(inputSchema);
    // tool_search reports a definition this large as `oversized`; attaching it to every
    // failed call would push the error into an artifact and hide the issues above.
    schemaLine =
      Buffer.byteLength(schemaText, 'utf8') > TOOL_SEARCH_MAX_RESULT_BYTES
        ? 'input_schema omitted: it exceeds the tool_search response budget and needs a smaller tool contract.'
        : `input_schema: ${schemaText}`;
  } catch {
    // e.g. BigInt keywords: the issues still stand without the schema text.
  }
  return [
    `Arguments do not match the schema for "${selector}":`,
    ...issues,
    ARGUMENT_TYPE_GUIDANCE,
    ...(schemaLine === undefined ? [] : [schemaLine]),
  ].join('\n');
}

/** Pointer walks past this many steps give up on the preview. */
const MAX_POINTER_STEPS = 1_000;

function describeReceived(value: unknown, pointer: string | undefined): string {
  if (pointer === undefined) return '';
  const targets = pointerTargets(value, pointer);
  // None: the walk gave up or found nothing. Several keys spelling the same
  // pointer: any preview might show another field.
  if (targets === undefined || targets.length !== 1) return '';
  let text: string;
  try {
    text = JSON.stringify(targets[0]) ?? String(targets[0]);
  } catch {
    // e.g. BigInt, cycles, or nesting deep enough to overflow the stack.
    return '';
  }
  if (text.length > MAX_RECEIVED_PREVIEW_LENGTH) {
    text = `${text.slice(0, MAX_RECEIVED_PREVIEW_LENGTH - 3)}...`;
  }
  return ` (received ${text})`;
}

/**
 * Values `pointer` can reach by walking whole keys of `value`, stopping at two.
 * Validator paths do not escape keys (`a/b` is one key or two), and appended
 * property names may be `~`-escaped, so both spellings of a key are tried.
 * `undefined` when the walk exceeds its step budget.
 */
function pointerTargets(value: unknown, pointer: string): unknown[] | undefined {
  const targets: unknown[] = [];
  let steps = 0;
  const visit = (current: unknown, offset: number): boolean => {
    if (targets.length > 1) return true;
    steps += 1;
    if (steps > MAX_POINTER_STEPS) return false;
    if (offset === pointer.length) {
      targets.push(current);
      return true;
    }
    if (pointer[offset] !== '/') return true;
    const start = offset + 1;
    if (Array.isArray(current)) {
      const end = pointer.indexOf('/', start);
      const token = pointer.slice(start, end === -1 ? undefined : end);
      return /^(0|[1-9]\d*)$/.test(token) && Number(token) < current.length
        ? visit(current[Number(token)], start + token.length)
        : true;
    }
    if (!isRecord(current)) return true;
    for (const key of Object.keys(current)) {
      const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1');
      for (const token of escaped === key ? [key] : [key, escaped]) {
        const next = start + token.length;
        const whole = next === pointer.length || pointer[next] === '/';
        if (whole && pointer.startsWith(token, start) && !visit(current[key], next)) return false;
      }
    }
    return true;
  };
  return visit(value, 0) ? targets : undefined;
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
