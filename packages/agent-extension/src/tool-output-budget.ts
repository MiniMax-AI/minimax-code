import type { AgentExtension, AfterToolCallHandler, TurnAssemblyCtx } from '@mavis/agent-runtime';
import { isSourceReferenceMarkerBlock } from './source-reference-marker.js';

type TextBlock = { readonly type: 'text'; readonly text: string };

export interface ToolOutputArtifactInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly text: string;
  readonly originalBytes: number;
  readonly sensitive: boolean;
}

export interface ToolOutputArtifact {
  readonly reference: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ToolOutputBudgetExtensionOptions {
  readonly maxInlineBytes: number;
  /** Live host-owned override. Missing, invalid or throwing values keep maxInlineBytes. */
  readonly getMaxInlineBytes?: () => number | undefined;
  /** Head/tail bytes retained only when artifact persistence fails. */
  readonly fallbackPreviewBytes?: number;
  readonly perToolMaxInlineBytes?: Readonly<Record<string, number>>;
  readonly sensitiveTools?: readonly string[];
  readonly writeArtifact: (
    input: ToolOutputArtifactInput,
  ) => ToolOutputArtifact | Promise<ToolOutputArtifact>;
  readonly onArtifactError?: (
    error: unknown,
    input: ToolOutputArtifactInput,
  ) => void | Promise<void>;
  readonly id?: string;
  readonly description?: string;
}

/**
 * Externalizes oversized textual tool output while leaving media blocks in
 * the model-visible result. Artifact storage, access control, retention and
 * cleanup stay behind the injected writer owned by the host.
 */
export function toolOutputBudgetExtension(
  options: ToolOutputBudgetExtensionOptions,
): AgentExtension {
  const defaultMaxInlineBytes = positiveInteger(options.maxInlineBytes, 'maxInlineBytes');
  const fallbackPreviewBytes = positiveInteger(
    options.fallbackPreviewBytes ?? Math.min(defaultMaxInlineBytes, 2_048),
    'fallbackPreviewBytes',
  );
  const perTool = normalizePerToolLimits(options.perToolMaxInlineBytes);
  const sensitiveTools = new Set(options.sensitiveTools ?? []);

  const afterToolCall: AfterToolCallHandler = async (toolContext, _signal, turnCtx) => {
    // A run_code (PTC) child result goes to the program, not to the model
    // context, so it is not this budget's to cut: a receipt would hand the
    // script a pointer instead of its data (and its structured data would be
    // dropped as a rewritten result). Only results the model sees, including
    // run_code's own outer result, are externalized. Pi sets parentToolCallId
    // only on PTC child calls (pi-agent-core AfterToolCallContext).
    if (toolContext.parentToolCallId) return undefined;
    // A receipt is only a safe replacement when this exact turn can recover
    // the archived result. Keep the original ToolResult otherwise.
    if (!toolContext.context.tools?.some((tool) => tool.name === 'read')) return undefined;

    const textBlocks = toolContext.result.content.filter(
      (block): block is Extract<(typeof toolContext.result.content)[number], { type: 'text' }> =>
        block.type === 'text',
    );
    if (textBlocks.length === 0) return undefined;

    // Count every text byte, including host-generated markers.
    const text = textBlocks.map((block) => block.text).join('\n');
    const originalBytes = Buffer.byteLength(text);
    const toolName = toolContext.toolCall.name;
    const limit =
      perTool.get(toolName) ??
      readLiveMaxInlineBytes(options.getMaxInlineBytes, defaultMaxInlineBytes);
    if (originalBytes <= limit) return undefined;

    const sourceMarkerBlocks = boundedSourceReferenceMarkers(textBlocks, Math.min(limit, 4_096));
    const retainedMarkers = new Set(sourceMarkerBlocks);
    // Keep original structured payloads parseable. Bounded host hints stay in
    // context; every other block (including oversized hints) is archived.
    const artifactText = textBlocks
      .filter((block) => !retainedMarkers.has(block))
      .map((block) => block.text)
      .join('\n');

    const artifactInput = buildArtifactInput(
      turnCtx,
      toolContext.toolCall.id,
      toolName,
      toolContext.args,
      artifactText,
      originalBytes,
      sensitiveTools.has(toolName),
    );
    const mediaBlocks = toolContext.result.content.filter((block) => block.type !== 'text');

    try {
      const artifact = await options.writeArtifact(artifactInput);
      const receipt = buildExternalizedReceipt({
        artifact,
        toolName,
        args: toolContext.args,
        isError: toolContext.isError,
      });
      return {
        // Preserve only bounded, host-created citation hints after archiving.
        content: [{ type: 'text', text: receipt }, ...sourceMarkerBlocks, ...mediaBlocks],
        details: mergeBudgetDetails(toolContext.result.details, {
          externalized: true,
          fallback: false,
          original_bytes: originalBytes,
          reference: artifact.reference,
          ...(artifact.metadata ?? {}),
        }),
      };
    } catch (error) {
      await notifyArtifactError(options.onArtifactError, error, artifactInput);
      const notice = `\n\n[tool output truncated: ${originalBytes} bytes; artifact persistence failed]\n\n`;
      return {
        content: [
          { type: 'text', text: headTailPreview(text, fallbackPreviewBytes, notice) },
          ...mediaBlocks,
        ],
        details: mergeBudgetDetails(toolContext.result.details, {
          externalized: false,
          fallback: true,
          original_bytes: originalBytes,
        }),
      };
    }
  };

  return {
    id: options.id ?? 'tool-output-budget',
    description:
      options.description ??
      'Externalize oversized textual tool results and replace them with a recovery receipt.',
    init(pi) {
      pi.on('after_tool_call', afterToolCall);
    },
  };
}

function boundedSourceReferenceMarkers(
  textBlocks: readonly TextBlock[],
  limit: number,
): TextBlock[] {
  const sourceMarkerBlocks: TextBlock[] = [];
  let remainingBytes = limit;
  textBlocks.forEach((block) => {
    if (!isSourceReferenceMarkerBlock(block)) return;
    const bytes = Buffer.byteLength(block.text) + 1;
    if (bytes > remainingBytes) return;
    remainingBytes -= bytes;
    sourceMarkerBlocks.push(block);
  });
  return sourceMarkerBlocks;
}

function buildArtifactInput(
  ctx: TurnAssemblyCtx,
  toolCallId: string,
  toolName: string,
  args: unknown,
  text: string,
  originalBytes: number,
  sensitive: boolean,
): ToolOutputArtifactInput {
  return {
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    agentName: ctx.agentName,
    workspaceDir: ctx.workspaceDir,
    toolCallId,
    toolName,
    args,
    text,
    originalBytes,
    sensitive,
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`toolOutputBudgetExtension: ${field} must be a positive integer`);
  }
  return value;
}

function readLiveMaxInlineBytes(
  getMaxInlineBytes: (() => number | undefined) | undefined,
  fallback: number,
): number {
  try {
    const value = getMaxInlineBytes?.();
    return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function normalizePerToolLimits(
  limits: Readonly<Record<string, number>> | undefined,
): ReadonlyMap<string, number> {
  const normalized = new Map<string, number>();
  for (const [toolName, value] of Object.entries(limits ?? {})) {
    normalized.set(toolName, positiveInteger(value, `perToolMaxInlineBytes.${toolName}`));
  }
  return normalized;
}

function headTailPreview(text: string, budgetBytes: number, notice: string): string {
  const headBytes = Math.ceil(budgetBytes / 2);
  const tailBytes = Math.floor(budgetBytes / 2);
  return `${takeUtf8Start(text, headBytes)}${notice}${takeUtf8End(text, tailBytes)}`;
}

function takeUtf8Start(text: string, budgetBytes: number): string {
  let used = 0;
  let result = '';
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (used + bytes > budgetBytes) break;
    result += char;
    used += bytes;
  }
  return result;
}

function takeUtf8End(text: string, budgetBytes: number): string {
  let used = 0;
  let start = text.length;
  let cursor = text.length;
  while (cursor > 0) {
    const end = cursor;
    cursor -= 1;
    if (
      isLowSurrogate(text.charCodeAt(cursor)) &&
      cursor > 0 &&
      isHighSurrogate(text.charCodeAt(cursor - 1))
    ) {
      cursor -= 1;
    }
    const bytes = Buffer.byteLength(text.slice(cursor, end));
    if (used + bytes > budgetBytes) break;
    start = cursor;
    used += bytes;
  }
  return text.slice(start);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function buildExternalizedReceipt(input: {
  readonly artifact: ToolOutputArtifact;
  readonly toolName: string;
  readonly args: unknown;
  readonly isError: boolean;
}): string {
  const toolName = truncateUtf8(normalizeReceiptText(input.toolName), 64) || 'tool';
  const source = readReceiptSource(input.toolName, input.args);
  const sourceLine = source ? `Source: ${truncateUtf8(source, 256)}\n` : '';
  const errorLine = input.isError ? 'Result: error\n' : '';
  const chunkedInstruction =
    input.artifact.metadata?.read_format === 'chunked_jsonl_v1'
      ? "\nArtifact format: chunked JSONL; concatenate each chunk row's text field in index order."
      : '';
  return `[Tool output externalized
Tool: ${toolName}
${sourceLine}${errorLine}Artifact: ${input.artifact.reference}${chunkedInstruction}

Recover the needed facts from this artifact now, before answering, inferring, or searching another source.
Search this artifact first with bounded rg/grep when available, then read the relevant ranges with read(path, offset, limit).
If artifact search is unavailable, use bounded read directly.
Do not read or print the entire artifact in a single call.
When complete content is required, continue with bounded reads until all of it has been read.
Do not treat this receipt as evidence.]`;
}

function readReceiptSource(toolName: string, args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const canonicalToolName = normalizeReceiptText(toolName).toLowerCase();
  if (canonicalToolName === 'grep') {
    const pattern = readReceiptSourceField(args, 'pattern');
    const path = readReceiptSourceField(args, 'path') ?? readReceiptSourceField(args, 'file_path');
    const source = [pattern, path].filter((field): field is string => Boolean(field)).join('; ');
    if (source) return source;
  }
  for (const key of ['query', 'url', 'pattern', 'path', 'file_path'] as const) {
    const source = readReceiptSourceField(args, key);
    if (source) return source;
  }
  return undefined;
}

function readReceiptSourceField(
  args: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = args[key];
  if (typeof value !== 'string') return undefined;
  // Source is only a receipt anchor. Bound it before whitespace normalization
  // so a huge tool argument cannot add another full-string scan here.
  const normalized = normalizeReceiptText(takeUtf8Start(value, 512));
  return normalized ? `${key}=${JSON.stringify(normalized)}` : undefined;
}

function normalizeReceiptText(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const ellipsis = '…';
  const ellipsisBytes = Buffer.byteLength(ellipsis);
  if (maxBytes <= ellipsisBytes) return '';
  return takeUtf8Start(value, maxBytes - ellipsisBytes) + ellipsis;
}

function mergeBudgetDetails(
  details: unknown,
  budget: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const base = isRecord(details)
    ? details
    : details === undefined
      ? {}
      : { original_details: details };
  return { ...base, tool_output_budget: budget };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function notifyArtifactError(
  observer: ToolOutputBudgetExtensionOptions['onArtifactError'],
  error: unknown,
  input: ToolOutputArtifactInput,
): Promise<void> {
  if (!observer) return;
  try {
    await observer(error, input);
  } catch {
    // Observability must not replace the bounded fallback result.
  }
}
