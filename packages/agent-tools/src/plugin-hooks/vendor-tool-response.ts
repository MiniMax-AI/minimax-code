import type { ToolResult } from '@mavis/agent-core/tools';
import { parsePatch } from 'diff';

/**
 * Non-serializable source-owned channel for exact vendor PostToolUse values.
 *
 * Tool implementations attach a value only while they still own every field
 * required by the vendor schema.  The hook bridge must not reconstruct these
 * values from model-facing text because that text may be truncated, decorated,
 * or otherwise lossy.
 */
export const PLUGIN_HOOK_COMPATIBLE_TOOL_RESPONSE = Symbol.for(
  'mavis.pluginHooks.compatibleToolResponse',
);
export const PLUGIN_HOOK_CODEX_TOOL_RESPONSE = Symbol.for('mavis.pluginHooks.codexToolResponse');

interface ToolResultDetailsWithVendorResponse extends Record<string, unknown> {
  [PLUGIN_HOOK_COMPATIBLE_TOOL_RESPONSE]?: Readonly<Record<string, unknown>>;
  [PLUGIN_HOOK_CODEX_TOOL_RESPONSE]?: unknown;
}

interface HookToolResultView {
  readonly details?: unknown;
}

export function withPluginHookCompatibleToolResponse(
  result: ToolResult,
  response: Readonly<Record<string, unknown>>,
): ToolResult {
  return {
    ...result,
    details: withPluginHookCompatibleToolResponseDetails(result.details, response),
  };
}

export function withPluginHookCompatibleToolResponseDetails(
  details: ToolResult['details'],
  response: Readonly<Record<string, unknown>>,
): ToolResultDetailsWithVendorResponse {
  return Object.assign(
    { ...(details ?? {}) },
    { [PLUGIN_HOOK_COMPATIBLE_TOOL_RESPONSE]: response },
  );
}

export function readPluginHookCompatibleToolResponse(
  result: HookToolResultView,
): Readonly<Record<string, unknown>> | undefined {
  return (result.details as ToolResultDetailsWithVendorResponse | undefined)?.[
    PLUGIN_HOOK_COMPATIBLE_TOOL_RESPONSE
  ];
}

export function withPluginHookCodexToolResponse(result: ToolResult, response: unknown): ToolResult {
  return {
    ...result,
    details: withPluginHookCodexToolResponseDetails(result.details, response),
  };
}

export function withPluginHookCodexToolResponseDetails(
  details: ToolResult['details'],
  response: unknown,
): ToolResultDetailsWithVendorResponse {
  return Object.assign({ ...(details ?? {}) }, { [PLUGIN_HOOK_CODEX_TOOL_RESPONSE]: response });
}

export function readPluginHookCodexToolResponse(result: HookToolResultView): unknown | undefined {
  return (result.details as ToolResultDetailsWithVendorResponse | undefined)?.[
    PLUGIN_HOOK_CODEX_TOOL_RESPONSE
  ];
}

/** Attach Compatible's BashOutput only from Pi's source-owned split stream facts. */
export function withCompatibleBashToolResponseFromPiDetails(result: ToolResult): ToolResult {
  const response = compatibleBashToolResponseFromPiDetails(result.details);
  return response ? withPluginHookCompatibleToolResponse(result, response) : result;
}

export function compatibleBashToolResponseFromPiDetails(
  details: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const processOutput = nestedRecord(details, 'processOutput');
  if (
    !processOutput ||
    typeof processOutput.stdout !== 'string' ||
    typeof processOutput.stderr !== 'string' ||
    typeof processOutput.interrupted !== 'boolean' ||
    processOutput.stdoutTruncated !== false ||
    processOutput.stderrTruncated !== false
  ) {
    return undefined;
  }
  const rawOutputPath = optionalString(processOutput.rawOutputPath);
  return {
    stdout: processOutput.stdout,
    stderr: processOutput.stderr,
    interrupted: processOutput.interrupted,
    ...(rawOutputPath ? { rawOutputPath } : {}),
  };
}

/** Build Compatible's FileReadOutput from Pi's undecorated text-file facts. */
export function compatibleReadToolResponseFromPiDetails(
  details: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const file = nestedRecord(details, 'textFile');
  if (
    !file ||
    typeof file.path !== 'string' ||
    typeof file.content !== 'string' ||
    !nonNegativeInteger(file.numLines) ||
    !positiveInteger(file.startLine) ||
    !positiveInteger(file.totalLines) ||
    typeof file.wholeFileAutoTruncated !== 'boolean'
  ) {
    return undefined;
  }
  return {
    type: 'text',
    file: {
      filePath: file.path,
      content: file.content,
      numLines: file.numLines,
      startLine: file.startLine,
      totalLines: file.totalLines,
      ...(file.wholeFileAutoTruncated ? { truncatedByTokenCap: true } : {}),
    },
  };
}

export function withCompatibleGlobToolResponse(
  result: ToolResult,
  input: {
    readonly durationMs: number;
    readonly filenames: readonly string[];
    readonly truncated: boolean;
    readonly totalMatches: number;
    readonly countIsComplete: boolean;
  },
): ToolResult {
  return withPluginHookCompatibleToolResponse(result, {
    durationMs: input.durationMs,
    numFiles: input.filenames.length,
    filenames: [...input.filenames],
    truncated: input.truncated,
    totalMatches: input.totalMatches,
    countIsComplete: input.countIsComplete,
  });
}

function nestedRecord(value: unknown, key: string): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const nested = (value as Readonly<Record<string, unknown>>)[key];
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Readonly<Record<string, unknown>>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function withCompatibleGrepToolResponse(
  result: ToolResult,
  input: {
    readonly mode: 'content' | 'files_with_matches' | 'count';
    readonly filenames: readonly string[];
    readonly numLines?: number;
    readonly numMatches?: number;
    readonly totalFiles?: number;
    readonly content?: string;
    readonly appliedLimit: number;
    readonly appliedOffset: number;
  },
): ToolResult {
  return withPluginHookCompatibleToolResponse(result, {
    mode: input.mode,
    numFiles: input.filenames.length,
    filenames: [...input.filenames],
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.numLines !== undefined ? { numLines: input.numLines } : {}),
    ...(input.numMatches !== undefined ? { numMatches: input.numMatches } : {}),
    ...(input.totalFiles !== undefined ? { totalFiles: input.totalFiles } : {}),
    appliedLimit: input.appliedLimit,
    appliedOffset: input.appliedOffset,
  });
}

interface CompatibleStructuredPatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

export function withCompatibleEditToolResponse(
  result: ToolResult,
  input: {
    readonly filePath: string;
    readonly oldString: string;
    readonly newString: string;
    readonly originalFile: string;
    readonly replaceAll: boolean;
    readonly userModified: boolean;
  },
): ToolResult {
  return withPluginHookCompatibleToolResponse(result, {
    filePath: input.filePath,
    oldString: input.oldString,
    newString: input.newString,
    originalFile: input.originalFile,
    structuredPatch: parseStructuredPatch(result.details?.patch),
    userModified: input.userModified,
    replaceAll: input.replaceAll,
  });
}

/**
 * `structuredPatch` is a required array in the Compatible file-edit response,
 * and the upstream tool already sends `[]` when its own diff gives up, so an
 * unavailable patch degrades to the empty array. Dropping the field instead
 * makes the runner skip the handler before it starts, and describing the edit
 * as one whole-file hunk pushes the payload past the runner's input limit.
 */
function parseStructuredPatch(patch: unknown): CompatibleStructuredPatchHunk[] {
  if (typeof patch !== 'string') return [];
  let parsed: ReturnType<typeof parsePatch>[number] | undefined;
  try {
    parsed = parsePatch(patch)[0];
  } catch {
    // Hook compatibility is an enhancement; malformed vendor metadata must
    // never turn a successful edit into a failed tool call.
    return [];
  }
  if (!parsed) return [];
  return parsed.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
  }));
}
