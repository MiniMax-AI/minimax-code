import type {
  TuiStructuredPreview,
  TuiStructuredPreviewBlock,
  TuiStructuredPreviewState,
} from '../types/runtime-models.js';

const MAX_INLINE_PREVIEW_BYTES = 64 * 1024;
const MAX_INLINE_DIFF_LINES = 400;

export interface BuildTuiToolPreviewInput {
  readonly toolName?: string;
  readonly status?: string | number;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: unknown;
}

export function buildTuiToolPreview(
  call: BuildTuiToolPreviewInput,
): TuiStructuredPreview | undefined {
  const toolName = normalizeToolName(call.toolName);
  const input = parseRecord(call.input);
  if (!toolName) return undefined;

  const state = resolvePreviewState(call.status, call.error);
  const blocks = isEditTool(toolName)
    ? buildEditBlocks(input ?? {}, call.output)
    : isWriteTool(toolName)
      ? input
        ? buildWriteBlocks(input)
        : []
      : [];
  if (blocks.length === 0) return undefined;
  return { schemaVersion: 1, state, blocks };
}

function buildEditBlocks(
  input: Readonly<Record<string, unknown>>,
  output: unknown,
): TuiStructuredPreviewBlock[] {
  const path = readString(input, ['path', 'filePath', 'file_path']);
  const resultDiff = readToolResultDiff(output);
  if (resultDiff) {
    return [
      resultDiff.omitted === undefined
        ? createDiffBlock(path, resultDiff.diff)
        : createOmittedDiffBlock(path, resultDiff.diff, resultDiff.omitted),
    ];
  }

  return readEditPairs(input).map(({ oldText, newText }) => {
    const diff = [
      ...oldText.split('\n').map((line) => `- ${line}`),
      ...newText.split('\n').map((line) => `+ ${line}`),
    ].join('\n');
    return createDiffBlock(path, diff);
  });
}

function buildWriteBlocks(input: Readonly<Record<string, unknown>>): TuiStructuredPreviewBlock[] {
  const path = readString(input, ['path', 'filePath', 'file_path']);
  const content = readString(input, ['content', 'fileContent', 'file_content']);
  if (content === undefined) return [];
  const byteCount = utf8ByteLength(content);
  if (content.includes('\0')) {
    return [
      {
        kind: 'summary',
        ...(path ? { path } : {}),
        message: 'Binary content cannot be previewed safely.',
        reason: 'binary',
        byteCount,
      },
    ];
  }
  if (byteCount > MAX_INLINE_PREVIEW_BYTES) {
    return [
      {
        kind: 'summary',
        ...(path ? { path } : {}),
        message: `File preview omitted because it is ${formatByteCount(byteCount)}.`,
        reason: 'too-large',
        byteCount,
      },
    ];
  }
  return [
    {
      kind: 'file',
      ...(path ? { path } : {}),
      content,
      lineCount: content.split('\n').length,
      truncated: false,
    },
  ];
}

function createDiffBlock(path: string | undefined, rawDiff: string): TuiStructuredPreviewBlock {
  const lines = rawDiff.split('\n');
  const byteCount = utf8ByteLength(rawDiff);
  const visibleLines = lines.slice(0, MAX_INLINE_DIFF_LINES);
  const byteLimited = byteCount > MAX_INLINE_PREVIEW_BYTES;
  let diff = visibleLines.join('\n');
  if (byteLimited) diff = truncateUtf8(diff, MAX_INLINE_PREVIEW_BYTES);
  const omittedLines = Math.max(0, lines.length - diff.split('\n').length);
  return {
    kind: 'diff',
    ...(path ? { path } : {}),
    diff,
    addedLines: countChangedLines(lines, '+'),
    removedLines: countChangedLines(lines, '-'),
    truncated: omittedLines > 0 || byteLimited,
    ...(omittedLines > 0 ? { omittedLines } : {}),
  };
}

// The edit tool replaces the diff body with a one-line notice once it hits its own
// bounds, so the body carries no `+`/`-` lines. Rendering that as a diff block reports
// `+0 -0`, which reads as "nothing changed" on exactly the largest edits.
function createOmittedDiffBlock(
  path: string | undefined,
  message: string,
  omittedReason: string,
): TuiStructuredPreviewBlock {
  return {
    kind: 'summary',
    ...(path ? { path } : {}),
    message,
    reason: omittedReason === 'timeout' ? 'unavailable' : 'too-large',
  };
}

interface ToolResultDiff {
  readonly diff: string;
  readonly omitted?: string;
}

function readToolResultDiff(output: unknown): ToolResultDiff | undefined {
  const root = parseRecord(output);
  if (!root) return undefined;
  const candidates = [root, parseRecord(root.result), parseRecord(root.output)].filter(
    (candidate): candidate is Readonly<Record<string, unknown>> => candidate !== undefined,
  );
  for (const candidate of candidates) {
    const details = parseRecord(candidate.details);
    const diff = details ? readString(details, ['diff', 'previewDiff', 'preview_diff']) : undefined;
    if (diff) {
      const omitted = details ? readString(details, ['diffOmitted', 'diff_omitted']) : undefined;
      return omitted === undefined ? { diff } : { diff, omitted };
    }
  }
  return undefined;
}

function readEditPairs(
  input: Readonly<Record<string, unknown>>,
): Array<{ oldText: string; newText: string }> {
  const rawEdits = parseArray(input.edits);
  const pairs = (rawEdits ?? []).flatMap((candidate) => {
    const edit = parseRecord(candidate);
    const oldText = edit ? readString(edit, ['oldText', 'old_text']) : undefined;
    const newText = edit ? readString(edit, ['newText', 'new_text']) : undefined;
    return oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [];
  });
  const legacyOldText = readString(input, ['oldText', 'old_text']);
  const legacyNewText = readString(input, ['newText', 'new_text']);
  if (legacyOldText !== undefined && legacyNewText !== undefined) {
    pairs.push({ oldText: legacyOldText, newText: legacyNewText });
  }
  return pairs;
}

function resolvePreviewState(
  status: string | number | undefined,
  error: unknown,
): TuiStructuredPreviewState {
  if (hasError(error) || isFailedStatus(status)) return 'not-applied';
  return isSuccessfulStatus(status) ? 'applied' : 'proposed';
}

function isSuccessfulStatus(status: string | number | undefined): boolean {
  return (
    status === 2 ||
    status === '2' ||
    status === 'completed' ||
    status === 'complete' ||
    status === 'done' ||
    status === 'finished' ||
    status === 'succeeded' ||
    status === 'success'
  );
}

function isFailedStatus(status: string | number | undefined): boolean {
  return status === 3 || status === '3' || status === 'failed' || status === 'error';
}

function hasError(error: unknown): boolean {
  return error !== undefined && error !== null && error !== '';
}

function normalizeToolName(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/gu, '');
  return normalized || undefined;
}

function isEditTool(name: string): boolean {
  return name === 'edit' || name === 'editfile' || name === 'replace';
}

function isWriteTool(name: string): boolean {
  return name === 'write' || name === 'writefile' || name === 'createfile';
}

function parseRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const parsed = parseJson(value);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Readonly<Record<string, unknown>>)
    : undefined;
}

function parseArray(value: unknown): readonly unknown[] | undefined {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readString(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function countChangedLines(lines: readonly string[], prefix: '+' | '-'): number {
  return lines.filter((line) => line.startsWith(prefix) && !line.startsWith(prefix.repeat(3)))
    .length;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}
