/**
 * Host-neutral `read` tool: the desktop LocalReadTool with its file IO behind
 * the CoreToolHost port. The desktop subclass passes physical-fs, so the
 * behavior there is unchanged; other hosts pass their own filesystem.
 */

import {
  attachProgrammaticErrorData,
  type ToolExecutionContext,
  type ToolImpl,
  type ToolResult,
  withProgrammaticResult,
} from '@mavis/agent-core/tools';
import { createReadTool, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent/tools';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  IMAGE_DIMENSION_HEADER_BYTES,
  parseImageDimensionsFromBytes,
} from '@mavis/shared/image-dimensions';
import { fileURLToPath } from 'node:url';

import {
  inferReadVideoMimeType,
  readVideoAsToolResult,
  type ReadVideoCapabilities,
} from '../shared/read-video.js';
import {
  checkBlockedDeviceRead,
  checkNonRegularFileRead,
  detectBinaryRead,
  detectPiSupportedImageMimeTypeFromFile,
} from '../shared/read-guards.js';
import { isPdfReadPath, readPdfAsToolResult } from '../shared/read-pdf.js';
import { isNotebookReadPath, readNotebookAsToolResult } from '../shared/read-notebook.js';
import { piReadResultToToolResult, readErrorResult } from '../shared/read-result.js';
import { READ_MAX_LINE_CHARS } from '../shared/read-contract.js';
import { withDesktopCompletenessReport } from '../desktop/ptc-result-projection.js';
import {
  applyDesktopTextLimit,
  DESKTOP_READ_TEXT_MAX_BYTES,
  isPtcChildCall,
  limitDesktopPrefixLines,
  PTC_CHILD_FULL_OUTPUT_MAX_BYTES,
  withDesktopOutputContinuation,
} from '../desktop/output-limit.js';
import { LocalReadToolDef, type LocalReadToolInput } from './defs.js';
import { resolveCandidatePath } from './paths.js';
import type { CoreToolFs, CoreToolHost } from './ports.js';

/** Context fields the read tool consumes; multimodal reads gate on the model capabilities. */
export interface CoreReadContext extends ToolExecutionContext {
  readonly parentAgentConfig?: {
    readonly model?: { readonly capabilities?: ReadVideoCapabilities };
  };
}

export class CoreReadTool<Ctx extends CoreReadContext = CoreReadContext> implements ToolImpl<
  typeof LocalReadToolDef.schema,
  Ctx
> {
  private readonly tool: AgentTool;
  /**
   * For run_code children: no line limit, and Pi's byte limit raised to
   * PTC_CHILD_FULL_OUTPUT_MAX_BYTES, so an over-budget window is cut by Pi
   * before it becomes one huge numbered string (the read then falls back).
   */
  private readonly uncappedTool: AgentTool;

  constructor(
    private readonly workspaceRoot: string,
    private readonly host: CoreToolHost,
  ) {
    // The host's request media extension encodes every tool result image to
    // `requestMedia.image`; a second resize here would cap it and add a note.
    const options = {
      autoResizeImages: false,
      operations: {
        access: (path: string) => host.fs.access(path),
        readFile: (path: string) => host.fs.readFile(path),
        detectImageMimeType: (path: string) =>
          detectPiSupportedImageMimeTypeFromFile(path, host.fs),
      },
    };
    this.tool = createReadTool(workspaceRoot, options);
    this.uncappedTool = createReadTool(workspaceRoot, {
      ...options,
      truncation: { maxLines: Number.POSITIVE_INFINITY, maxBytes: PTC_CHILD_FULL_OUTPUT_MAX_BYTES },
    });
  }

  async execute(
    ctx: Ctx,
    input: LocalReadToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    try {
      return await this.read(ctx, input, signal);
    } catch (error) {
      // Pi keeps only the message; PTC data still says what kind of read failed.
      attachProgrammaticErrorData(error, { kind: readKind(input.path) });
      throw error;
    }
  }

  private async read(
    ctx: Ctx,
    input: LocalReadToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const readAbs = await resolveReadPath(input.path, this.workspaceRoot, this.host);

    // Guard order (design doc §3): the device check comes first because
    // every later step that opens the file (binary sampling, PDF/notebook
    // parsing, pi itself) would hang forever on /dev/zero-style paths.
    const deviceError = checkBlockedDeviceRead(readAbs);
    if (deviceError)
      return withReadKind(readErrorResult(LocalReadToolDef.name, deviceError), 'text');

    // Closes the FIFO/socket/block-device blind spot the path-only device
    // guard misses (one stat, follows symlinks) — a named pipe would block
    // the whole turn just like /dev/zero.
    const irregularError = await checkNonRegularFileRead(readAbs, this.host.fs);
    if (irregularError) {
      return withReadKind(readErrorResult(LocalReadToolDef.name, irregularError), 'text');
    }

    // pi natively inlines images (jpg/png/gif/webp). Video is not part of
    // pi's built-in mime detection, so we mirror cloud-runtime here: when
    // the path looks like an inline-capable video, run the shared helper
    // first and fall through to pi only when (a) the extension is not a
    // recognised video, or (b) the candidate path does not exist (let pi's
    // NFD / curly-quote / AM-PM fallbacks have a chance to find the file).
    const videoMime = inferReadVideoMimeType(readAbs);
    if (videoMime) {
      try {
        return withReadKind(
          await readVideoAsToolResult({
            toolName: LocalReadToolDef.name,
            absolutePath: readAbs,
            mimeType: videoMime,
            capabilities: ctx.parentAgentConfig?.model?.capabilities,
            signal,
            fs: this.host.fs,
          }),
          'video',
        );
      } catch (err) {
        if (!isFsNotFoundError(err)) throw err;
        // ENOENT — let pi retry with its macOS-aware path variants.
      }
    }

    // PDF / notebook dispatch: these never reach pi (which would read them
    // as UTF-8 garbage / raw JSON).
    if (isPdfReadPath(readAbs)) {
      return withReadKind(
        await readPdfAsToolResult({
          toolName: LocalReadToolDef.name,
          absolutePath: readAbs,
          pages: input.pages,
          signal,
          fs: this.host.fs,
        }),
        'pdf',
      );
    }
    if (isNotebookReadPath(readAbs)) {
      return withReadKind(
        await readNotebookAsToolResult({
          toolName: LocalReadToolDef.name,
          absolutePath: readAbs,
          signal,
          fs: this.host.fs,
        }),
        'notebook',
      );
    }

    // Binary guard: pi would decode anything else as UTF-8 — turn silent
    // garbage into an explicit, recoverable tool error.
    const binary = await detectBinaryRead(readAbs, this.host.fs);
    if (binary.binary) {
      return withReadKind(readErrorResult(LocalReadToolDef.name, binary.message), 'text');
    }

    // Strip `pages` before delegating: pi's read schema does not know the
    // parameter, and models occasionally send it for non-PDF files.
    const { pages: _pages, ...piInput } = input;
    // A run_code child reads the whole file, or exactly offset/limit: Pi's
    // 2000-line / 50 KB head limit, the 2000-character line cap and the
    // Desktop 24 KiB cap are for the model (see isPtcChildCall). Over
    // PTC_CHILD_FULL_OUTPUT_MAX_BYTES it gets the direct-call page and the
    // offset to continue instead, like a Bash child's preview.
    if (
      isPtcChildCall(ctx) &&
      !(await fileOverPtcReadBudget(readAbs, input.limit, this.host.fs))
    ) {
      const res = await this.uncappedTool.execute('', piInput, signal);
      const result = piReadResultToToolResult(LocalReadToolDef.name, res, {
        offset: input.offset,
        maxLineChars: Number.POSITIVE_INFINITY,
      });
      if (!textOverPtcReadBudget(result)) {
        return withReadProgrammaticResult(result, input.limit, readCapSkipped(result));
      }
    }
    const res = await this.tool.execute('', piInput, signal);
    const result = piReadResultToToolResult(LocalReadToolDef.name, res, {
      offset: input.offset,
    });
    return withReadProgrammaticResult(
      limitDesktopReadTextResult(result, input.offset),
      input.limit,
    );
  }
}

/**
 * A child read without `limit` would return the whole file: over the budget
 * it takes the direct-call path without loading the file twice. With a
 * `limit` the window may be small even in a large file, so only its text is
 * checked (textOverPtcReadBudget). An unreadable size is left to Pi.
 */
async function fileOverPtcReadBudget(
  path: string,
  limit: number | undefined,
  fs: CoreToolFs,
): Promise<boolean> {
  if (limit !== undefined) return false;
  try {
    return (await fs.stat(path)).size > PTC_CHILD_FULL_OUTPUT_MAX_BYTES;
  } catch {
    return false;
  }
}

/** Pi cut the window at the raised byte limit, or the numbered text is still over it. */
function textOverPtcReadBudget(result: ToolResult): boolean {
  const truncation = result.details?.truncation as { truncated?: unknown } | undefined;
  return (
    truncation?.truncated === true ||
    Buffer.byteLength(result.text, 'utf8') > PTC_CHILD_FULL_OUTPUT_MAX_BYTES
  );
}

/**
 * Whether a direct read would have cut this uncapped child read. The Desktop
 * 24 KiB check also covers Pi's 50 KB limit, since the numbered text is never
 * shorter than the file text it shows.
 */
function readCapSkipped(result: ToolResult): boolean {
  const textFile = result.details?.textFile as
    | { readonly content?: unknown; readonly numLines?: unknown }
    | undefined;
  if (!textFile || typeof textFile.content !== 'string') return false;
  if (Buffer.byteLength(result.text, 'utf8') > DESKTOP_READ_TEXT_MAX_BYTES) return true;
  if (typeof textFile.numLines === 'number' && textFile.numLines > DEFAULT_MAX_LINES) return true;
  return textFile.content
    .split('\n')
    .some(
      (line) => line.length > READ_MAX_LINE_CHARS && Array.from(line).length > READ_MAX_LINE_CHARS,
    );
}

/**
 * PTC payload of a text read: the window's original text without line
 * numbers, cut exactly where the output was cut (Desktop 24 KiB prefix,
 * 2000-character lines) so data never shows more than the model text, plus
 * the completeness statement. A read that stopped at the caller's `limit`
 * with lines left is complete but reports hasMore and the next line offset.
 */
function withReadProgrammaticResult(
  result: ToolResult,
  limit: number | undefined,
  uncappedOutput = false,
): ToolResult {
  const data = readTextData(result);
  if (!data) {
    const image = readImageData(result);
    return withDesktopCompletenessReport(
      LocalReadToolDef.name,
      result,
      image ? { data: image } : {},
    );
  }
  // Only a caller's `limit` stops a complete read early; without one Pi reads
  // to the end or marks a cut. Same condition and offset as Pi's own
  // "[N more lines in file. Use offset=X to continue.]" (Pi core/tools/read.ts),
  // whose line count includes the empty piece after a trailing newline, so
  // data and model text never disagree.
  const more =
    limit !== undefined && Number.isSafeInteger(limit) && limit > 0
      ? data.startLine - 1 + limit < data.totalLines
      : false;
  return withDesktopCompletenessReport(LocalReadToolDef.name, result, {
    data,
    ...(more && limit !== undefined
      ? { more: { nextOffset: data.startLine + limit, offsetUnit: 'line' as const } }
      : {}),
    ...(uncappedOutput ? { uncappedOutput } : {}),
  });
}

/**
 * Metadata of an image read. autoResizeImages is off, so Pi returns the file
 * itself (the request media step sizes it later, reported as media delivery)
 * and its size is also the original size. Only the header is decoded.
 */
function readImageData(result: ToolResult): Record<string, unknown> | undefined {
  const images = result.content.filter((block) => block.type === 'image');
  const image = images.length === 1 ? images[0] : undefined;
  if (!image || image.type !== 'image' || !image.mimeType.startsWith('image/')) return undefined;
  const headerChars = Math.ceil(IMAGE_DIMENSION_HEADER_BYTES / 3) * 4;
  const size = parseImageDimensionsFromBytes(
    Buffer.from(image.data.slice(0, headerChars), 'base64'),
  );
  return {
    kind: 'image',
    mimeType: image.mimeType,
    ...(size
      ? {
          width: size.width,
          height: size.height,
          originalWidth: size.width,
          originalHeight: size.height,
        }
      : {}),
  };
}

type ReadKind = 'text' | 'image' | 'pdf' | 'notebook' | 'video';

function withReadKind(result: ToolResult, kind: ReadKind): ToolResult {
  return withProgrammaticResult(result, { data: { kind } });
}

/** What a failed read was trying to read, from the path alone (the file may not exist). */
function readKind(path: string): ReadKind {
  if (inferReadVideoMimeType(path)) return 'video';
  if (isPdfReadPath(path)) return 'pdf';
  if (isNotebookReadPath(path)) return 'notebook';
  return /\.(png|jpe?g|gif|webp)$/iu.test(path) ? 'image' : 'text';
}

function readTextData(
  result: ToolResult,
):
  | { kind: 'text'; content: string; startLine: number; lineCount: number; totalLines: number }
  | undefined {
  const textFile = result.details?.textFile;
  if (!textFile || typeof textFile !== 'object' || Array.isArray(textFile)) return undefined;
  if (result.content.some((block) => block.type !== 'text')) return undefined;
  const { content, startLine, numLines, totalLines } = textFile as Record<string, unknown>;
  if (
    typeof content !== 'string' ||
    !isPositiveInteger(startLine) ||
    !isNonNegativeInteger(numLines) ||
    !isNonNegativeInteger(totalLines)
  ) {
    return undefined;
  }
  let lines = content.split('\n');
  let lineCount = numLines;
  if (result.details?.desktop_output_truncation !== undefined) {
    // The Desktop cap kept a prefix of numbered lines; the last one it kept ends the data.
    const lastShown = lastNumberedLine(result.text);
    lines = lines.slice(0, lastShown === undefined ? 0 : Math.max(0, lastShown - startLine + 1));
    lineCount = lines.length;
  }
  const cutLines = new Set(
    Array.isArray(result.details?.line_truncations) ? result.details.line_truncations : [],
  );
  const shown = lines.map((line, index) =>
    cutLines.has(startLine + index)
      ? Array.from(line).slice(0, READ_MAX_LINE_CHARS).join('')
      : line,
  );
  return { kind: 'text', content: shown.join('\n'), startLine, lineCount, totalLines };
}

function lastNumberedLine(text: string): number | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index]?.match(/^\s*(\d+)→/);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function limitDesktopReadTextResult(result: ToolResult, requestedOffset?: number): ToolResult {
  if (result.content.some((block) => block.type !== 'text')) return result;
  const truncation = result.details?.truncation as { firstLineExceedsLimit?: boolean } | undefined;
  if (result.details?.media !== undefined || truncation?.firstLineExceedsLimit === true) {
    return result;
  }

  const fallbackOffset = requestedOffset !== undefined && requestedOffset > 0 ? requestedOffset : 1;
  const nextOffsetFor = (lines: readonly string[]): number => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const match = lines[index]?.match(/^\s*(\d+)→/);
      if (match?.[1]) return Number(match[1]) + 1;
    }
    return fallbackOffset;
  };
  let limited = limitDesktopPrefixLines(result.text, {
    maxBytes: DESKTOP_READ_TEXT_MAX_BYTES,
    notice: ({ originalBytes, retainedLines }) => {
      const nextOffset = nextOffsetFor(retainedLines);
      return (
        `[desktop read output truncated: original_bytes=${originalBytes}; ` +
        `if the omitted remainder is needed, continue with read using offset=${nextOffset} and the same path.]`
      );
    },
  });
  if (limited.truncation) {
    const noticeIndex = limited.text.lastIndexOf('\n\n[');
    const retainedLines = (
      noticeIndex >= 0 ? limited.text.slice(0, noticeIndex) : limited.text
    ).split('\n');
    const nextOffset = nextOffsetFor(retainedLines);
    limited = withDesktopOutputContinuation(limited, {
      next_offset: nextOffset,
      offset_unit: 'line',
      continuation_hint: {
        tool: 'read',
        preserve_args: ['path'],
        instruction:
          `If the omitted remainder is needed, call read again with offset=${nextOffset}; ` +
          'preserve the same path.',
      },
    });
  }
  return applyDesktopTextLimit(result, limited);
}

async function resolveReadPath(
  input: string,
  workspaceRoot: string,
  host: CoreToolHost,
): Promise<string> {
  const literalResolved = resolveCandidatePath(input, workspaceRoot, host);
  if (await pathExists(literalResolved, host.fs)) return literalResolved;

  const resolved = resolveReadCandidatePath(input, workspaceRoot, host);
  if (await pathExists(resolved, host.fs)) return resolved;

  const amPmVariant = resolved.replace(/ (AM|PM)\./gi, '\u202f$1.');
  if (amPmVariant !== resolved && (await pathExists(amPmVariant, host.fs))) return amPmVariant;

  const nfdVariant = resolved.normalize('NFD');
  if (nfdVariant !== resolved && (await pathExists(nfdVariant, host.fs))) return nfdVariant;

  const curlyVariant = resolved.replace(/'/g, '\u2019');
  if (curlyVariant !== resolved && (await pathExists(curlyVariant, host.fs))) return curlyVariant;

  const nfdCurlyVariant = nfdVariant.replace(/'/g, '\u2019');
  if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant, host.fs))) {
    return nfdCurlyVariant;
  }

  return resolved;
}

function resolveReadCandidatePath(
  input: string,
  workspaceRoot: string,
  host: Pick<CoreToolHost, 'homedir'>,
): string {
  return resolveCandidatePath(normalizeReadInput(input), workspaceRoot, host);
}

function normalizeReadInput(input: string): string {
  let normalized = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

async function pathExists(filePath: string, fs: Pick<CoreToolFs, 'access'>): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isFsNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}
