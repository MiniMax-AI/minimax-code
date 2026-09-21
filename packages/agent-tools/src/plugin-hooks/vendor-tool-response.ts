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

const NO_NEWLINE_MARKER = '\\ No newline at end of file';

export function withCompatibleEditToolResponse(
  result: ToolResult,
  input: {
    readonly filePath: string;
    readonly oldString: string;
    readonly newString: string;
    readonly originalFile: string;
    readonly updatedFile: string;
    readonly replaceAll: boolean;
    readonly userModified: boolean;
  },
): ToolResult {
  const structuredPatch =
    parseStructuredPatch(result.details?.patch) ??
    wholeFileStructuredPatch(input.originalFile, input.updatedFile);
  if (!structuredPatch) return result;
  return withPluginHookCompatibleToolResponse(result, {
    filePath: input.filePath,
    oldString: input.oldString,
    newString: input.newString,
    originalFile: input.originalFile,
    structuredPatch,
    userModified: input.userModified,
    replaceAll: input.replaceAll,
  });
}

function parseStructuredPatch(patch: unknown): CompatibleStructuredPatchHunk[] | undefined {
  if (typeof patch !== 'string') return undefined;
  let parsed: ReturnType<typeof parsePatch>[number] | undefined;
  try {
    parsed = parsePatch(patch)[0];
  } catch {
    // Hook compatibility is an enhancement; malformed vendor metadata must
    // never turn a successful edit into a failed tool call.
    return undefined;
  }
  if (!parsed) return undefined;
  return parsed.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
  }));
}

/**
 * Rebuild the single hunk jsdiff emits for a whole-file replacement, without
 * running Myers.
 *
 * `details.patch` is dropped whenever the bounded diff gives up, and a
 * Compatible PostToolUse handler is skipped outright when `structuredPatch` is
 * missing, so the hook contract cannot be allowed to depend on the unified
 * patch surviving that bound. Replacing every old line with every new line is
 * a correct but deliberately imprecise description of the edit: it is the
 * coarsest hunk that still round-trips, and it costs one pass over the two
 * strings instead of O((N+M)·D). Payload stays O(N), the same order as
 * `originalFile`, which this response already carries in full.
 */
function wholeFileStructuredPatch(
  originalFile: string,
  updatedFile: string,
): CompatibleStructuredPatchHunk[] | undefined {
  const oldLines = splitPatchLines(originalFile);
  const newLines = splitPatchLines(updatedFile);
  if (oldLines.length === 0 && newLines.length === 0) return undefined;
  return [
    {
      oldStart: 1,
      oldLines: oldLines.length,
      newStart: 1,
      newLines: newLines.length,
      lines: [
        ...oldLines.map((line) => `-${line}`),
        ...(endsWithoutNewline(originalFile) ? [NO_NEWLINE_MARKER] : []),
        ...newLines.map((line) => `+${line}`),
        ...(endsWithoutNewline(updatedFile) ? [NO_NEWLINE_MARKER] : []),
      ],
    },
  ];
}

function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function endsWithoutNewline(text: string): boolean {
  return text !== '' && !text.endsWith('\n');
}
