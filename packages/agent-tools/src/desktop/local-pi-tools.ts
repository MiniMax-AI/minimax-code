import {
  attachProgrammaticErrorData,
  bindTool,
  type PtcChildDeadline,
  type PtcChildTimeoutDecision,
  type ToolImpl,
  type ToolResult,
  type ToolResultContent,
  withProgrammaticResult,
} from '@mavis/agent-core/tools';
import { sanitizeBashSubprocessEnv } from '@mavis/agent-core/bash-subprocess-env';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent/tools';
import { getShellConfig } from '@earendil-works/pi-coding-agent/shell';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { access, readFile } from "node:fs/promises";
import {
  IMAGE_DIMENSION_HEADER_BYTES,
  parseImageDimensionsFromBytes,
} from "@mavis/shared/image-dimensions";
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { homedir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolveBashDescription } from './local-bash-input.js';
import {
  DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS,
  resolveLocalBashTiming,
  validateBashCommand,
  withLocalBashTiming,
  type LocalBashTiming,
} from './local-bash-timing.js';
import {
  localBashResultFromError,
  localBashResultFromPi,
  readBashExecutionOutcome,
} from './local-bash-result.js';

import {
  LocalBashToolDef,
  type LocalBashToolInput,
  LocalEditToolDef,
  type LocalEditToolInput,
  LocalReadToolDef,
  type LocalReadToolInput,
  LocalWriteToolDef,
  type LocalWriteToolInput,
} from './builtin-defs.js';
import type {
  LocalBashAdapter,
  LocalRuntimeToolContext,
  LocalSandboxBashOperationsFactory,
  LocalSandboxInvocationIdentity,
} from './types.js';
import {
  executeLocalHostTrashIfRequested,
  type LocalHostTrashRuntime,
} from './host-trash-executor.js';
import {
  copyWithPermissionExecutionPlan,
  readPermissionExecutionPlan,
  resolvePermissionBashEnvPolicy,
  type LocalBashEnvPolicySource,
} from './permission-execution.js';
import { inferReadVideoMimeType, readVideoAsToolResult } from '../shared/read-video.js';
import {
  buildReplaceAllEdit,
  ReplaceAllError,
  withReplaceAllCount,
} from '../shared/replace-all-edit.js';
import {
  checkBlockedDeviceRead,
  checkNonRegularFileRead,
  detectBinaryRead,
} from '../shared/read-guards.js';
import { isPdfReadPath, readPdfAsToolResult } from '../shared/read-pdf.js';
import { isNotebookReadPath, readNotebookAsToolResult } from '../shared/read-notebook.js';
import { piReadResultToToolResult, readErrorResult } from '../shared/read-result.js';
import { READ_MAX_LINE_CHARS } from '../shared/read-contract.js';
import { withDesktopCompletenessReport } from './ptc-result-projection.js';
import {
  executeEditWithLineNumberRetry,
  normalizeEditsForLineNumberRetry,
} from '../shared/edit-line-number-retry.js';
import { createCapturingEditOperations } from '../shared/edit-capture.js';
import {
  withCompatibleBashToolResponseFromPiDetails,
  withCompatibleEditToolResponse,
} from '../plugin-hooks/vendor-tool-response.js';
import { buildWriteToolResult, createCapturingWriteOperations } from '../shared/write-capture.js';
import {
  applyDesktopTextLimit,
  DESKTOP_BASH_MAX_BYTES,
  DESKTOP_BASH_PREVIEW_BYTES,
  DESKTOP_READ_TEXT_MAX_BYTES,
  limitDesktopHeadTailLines,
  limitDesktopPrefixLines,
  withDesktopOutputContinuation,
} from './output-limit.js';

export function getLocalBashEnvironment(): {
  readonly platform: NodeJS.Platform;
  readonly osVersion: string;
  readonly shell: string;
} {
  let shell = 'unavailable';
  try {
    // Match local Bash execution, which does not select its shell from $SHELL.
    const selected = getShellConfig();
    shell = `${selected.type} (${selected.shell})`;
  } catch {
    // Missing shell support must not prevent turns using other tools.
  }
  return {
    platform: process.platform,
    osVersion: `${process.platform} ${release()} ${process.arch}`,
    shell,
  };
}

@bindTool(LocalReadToolDef)
export class LocalReadTool implements ToolImpl<
  typeof LocalReadToolDef.schema,
  LocalRuntimeToolContext
> {
  private readonly tool: AgentTool;

  constructor(private readonly workspaceRoot: string) {
    // The host's request media extension encodes every tool result image to
    // `requestMedia.image`; a second resize here would cap it and add a note.
    this.tool = createReadTool(workspaceRoot, { autoResizeImages: false });
  }

  async execute(
    ctx: LocalRuntimeToolContext,
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
    ctx: LocalRuntimeToolContext,
    input: LocalReadToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const readAbs = await resolveLocalReadPath(input.path, this.workspaceRoot);

    // Guard order (design doc §3): the device check comes first because
    // every later step that opens the file (binary sampling, PDF/notebook
    // parsing, pi itself) would hang forever on /dev/zero-style paths.
    const deviceError = checkBlockedDeviceRead(readAbs);
    if (deviceError)
      return withReadKind(readErrorResult(LocalReadToolDef.name, deviceError), 'text');

    // Closes the FIFO/socket/block-device blind spot the path-only device
    // guard misses (one stat, follows symlinks) — a named pipe would block
    // the whole turn just like /dev/zero.
    const irregularError = await checkNonRegularFileRead(readAbs);
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
        }),
        'notebook',
      );
    }

    // Binary guard: pi would decode anything else as UTF-8 — turn silent
    // garbage into an explicit, recoverable tool error.
    const binary = await detectBinaryRead(readAbs);
    if (binary.binary) {
      return withReadKind(readErrorResult(LocalReadToolDef.name, binary.message), 'text');
    }

    // Strip `pages` before delegating: pi's read schema does not know the
    // parameter, and models occasionally send it for non-PDF files.
    const { pages: _pages, ...piInput } = input;
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
 * PTC payload of a text read: the window's original text without line
 * numbers, cut exactly where the output was cut (Desktop 24 KiB prefix,
 * 2000-character lines) so data never shows more than the model text, plus
 * the completeness statement. A read that stopped at the caller's `limit`
 * with lines left is complete but reports hasMore and the next line offset.
 */
function withReadProgrammaticResult(result: ToolResult, limit: number | undefined): ToolResult {
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

@bindTool(LocalWriteToolDef)
export class LocalWriteTool implements ToolImpl<
  typeof LocalWriteToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly workspaceRoot: string) {}

  async execute(
    _ctx: LocalRuntimeToolContext,
    input: LocalWriteToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    // Per-execute capture context. This tool instance is a process-level
    // singleton (buildLocalToolRegistry), so an instance-level pending map
    // would be shared across concurrent writes; binding capture to a single
    // execute keeps each write's byte count / diff its own. The injected
    // writeFile still runs inside pi's withFileMutationQueue slot: it captures
    // the old file (BOM/encoding/content) and writes with the preserved
    // encoding — see write-capture.ts / design doc.
    const { operations, takeCapture } = createCapturingWriteOperations();
    const tool = createWriteTool(this.workspaceRoot, { operations });
    const res = await executeWithFailurePath(input.path, () => tool.execute('', input, signal));
    const capture = takeCapture(resolveLocalCandidatePath(input.path, this.workspaceRoot));
    const result = buildWriteToolResult(
      LocalWriteToolDef.name,
      input.path,
      input.content,
      capture,
      toToolResult(LocalWriteToolDef.name, res).text,
    );
    const created = result.details?.created;
    const bytesWritten = result.details?.bytes_written;
    return withDesktopCompletenessReport(LocalWriteToolDef.name, result, {
      data: {
        path: input.path,
        ...(typeof created === 'boolean' ? { created } : {}),
        ...(typeof bytesWritten === 'number' ? { bytesWritten } : {}),
      },
    });
  }
}

@bindTool(LocalEditToolDef)
export class LocalEditTool implements ToolImpl<
  typeof LocalEditToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly workspaceRoot: string) {}

  async execute(
    _ctx: LocalRuntimeToolContext,
    input: LocalEditToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');

    // Translate the compatible style public schema (file_path + old_string +
    // new_string + optional replace_all) into pi's internal
    // { path, edits: [{ oldText, newText }] } shape so we still get
    // pi's BOM strip / line-ending restore / unified-diff /
    // withFileMutationQueue locking for free. The execution is then routed
    // through the line-number-retry wrapper so a model that pasted read's
    // `N→` prefixes into old_string still recovers (CR !4027 P1).
    const capture = createCapturingEditOperations();
    const { piInput, piResult } = await executeWithFailurePath(input.file_path, async () => {
      const prepared = await buildPiEditInput(input, this.workspaceRoot);
      const tool = createEditTool(this.workspaceRoot, { operations: capture.operations });
      return {
        piInput: prepared,
        piResult: await executeEditWithLineNumberRetry(tool, prepared, signal),
      };
    });
    const res =
      piInput.replacedCount === undefined
        ? piResult
        : withReplaceAllCount(piResult, piInput.path, piInput.replacedCount);
    const result = toToolResult(LocalEditToolDef.name, res);
    const editCapture = capture.takeCapture(
      resolveLocalCandidatePath(input.file_path, this.workspaceRoot),
    );
    // replace_all counts every occurrence it replaced; a single edit replaces one.
    const data = {
      path: input.file_path,
      replacements: piInput.replacedCount ?? 1,
      replaceAll: input.replace_all === true,
    };
    if (!editCapture) return withDesktopCompletenessReport(LocalEditToolDef.name, result, { data });
    const normalized =
      result.details?.line_number_prefixes_stripped === true
        ? normalizeEditsForLineNumberRetry([
            { oldText: input.old_string, newText: input.new_string },
          ])?.[0]
        : undefined;
    return withDesktopCompletenessReport(
      LocalEditToolDef.name,
      withCompatibleEditToolResponse(result, {
        filePath: editCapture.path,
        oldString: normalized?.oldText ?? input.old_string,
        newString: normalized?.newText ?? input.new_string,
        originalFile: editCapture.originalFile,
        replaceAll: input.replace_all === true,
        userModified: false,
      }),
      { data },
    );
  }
}

/** Runs a write or edit and, when it throws, leaves the path in PTC data. */
async function executeWithFailurePath<T>(path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    attachProgrammaticErrorData(error, { path });
    throw error;
  }
}

/**
 * Translate LocalEditTool's compatible style input into the `{ path, edits }`
 * shape pi's `createEditTool` expects. `replace_all: true` collapses
 * every occurrence of `old_string` into a single full-file replacement
 * driven through pi's own edit pipeline (see `replace-all-edit.ts` for
 * why we don't model each occurrence as its own edit).
 */
async function buildPiEditInput(
  input: LocalEditToolInput,
  workspaceRoot: string,
): Promise<{
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
  replacedCount?: number;
}> {
  if (input.replace_all === true) {
    // replace_all reads the file itself (outside pi), so it MUST resolve the
    // path exactly like pi's createEditTool does: workspace-relative paths
    // resolve against workspaceRoot, never the runtime process cwd (which is
    // wherever Electron/CLI launched, not the session workspace). Without this,
    // a relative file_path that single-edit handles fine ENOENTs here. Mirrors
    // cloud-edit's resolveWithinWorkspace-before-buildReplaceAllEdit order.
    const absolutePath = resolveLocalCandidatePath(input.file_path, workspaceRoot);
    try {
      const replacement = await buildReplaceAllEdit(
        absolutePath,
        input.old_string,
        input.new_string,
      );
      return {
        path: replacement.path,
        edits: replacement.edits,
        replacedCount: replacement.replacedCount,
      };
    } catch (err) {
      if (err instanceof ReplaceAllError) {
        throw new Error(err.message);
      }
      throw err;
    }
  }
  return {
    path: input.file_path,
    edits: [{ oldText: input.old_string, newText: input.new_string }],
  };
}

@bindTool(LocalBashToolDef)
export class LocalBashTool implements ToolImpl<
  typeof LocalBashToolDef.schema,
  LocalRuntimeToolContext
> {
  private readonly envPolicy: LocalBashEnvPolicySource;
  /** Names stripped by the sanitizer at the most recent spawn (never values). */
  private lastEnvRemoved: string[] = [];
  /** One-shot hint gate: report stripped names once per tool instance. */
  private envHintShown = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly backgroundAdapter: LocalBashAdapter | undefined,
    envPolicy: LocalBashEnvPolicySource,
    private readonly hostTrashRuntime?: LocalHostTrashRuntime,
    private readonly sandboxOperationsFactory?: LocalSandboxBashOperationsFactory,
  ) {
    this.envPolicy = envPolicy;
  }

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalBashToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    let timing: LocalBashTiming;
    let description: string;
    try {
      description = resolveBashDescription(input.description, input.command);
      validateBashCommand(input.command);
      timing = resolveLocalBashTiming(
        input.timeout,
        input.run_in_background
          ? 'explicit_background'
          : ctx.canConsumeBackgroundBashOutput === true &&
              ctx.allowBashAutoPromotion !== false &&
              this.backgroundAdapter?.runManagedForeground
            ? 'managed_foreground'
            : 'direct_foreground',
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // Every Bash return path states its completeness for PTC.
      return withDesktopCompletenessReport(LocalBashToolDef.name, {
        tool_name: LocalBashToolDef.name,
        text,
        content: [{ type: 'text', text }],
        isError: true,
        details: { status: 'invalid_input', error_code: 'BASH_INVALID_INPUT' },
      });
    }
    try {
      const result = await this.executeValidated(
        ctx,
        readPermissionExecutionPlan(input)
          ? copyWithPermissionExecutionPlan(
              { ...input, description },
              readPermissionExecutionPlan(input),
            )
          : { ...input, description },
        timing,
        signal,
      );
      return withDesktopCompletenessReport(LocalBashToolDef.name, {
        ...result,
        details: { ...result.details, description },
      });
    } catch (error) {
      if (error instanceof Error) {
        const details = (error as Error & { details?: Record<string, unknown> }).details;
        Object.assign(error, { details: { ...details, description } });
      }
      throw error;
    }
  }

  private async executeValidated(
    ctx: LocalRuntimeToolContext,
    input: LocalBashToolInput,
    timing: LocalBashTiming,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (input.run_in_background === true && ctx.canConsumeBackgroundBashOutput !== true) {
      return unavailableBackgroundBashOutputResult();
    }
    const permissionExecutionPlan = readPermissionExecutionPlan(input);
    const envPolicy = () => resolvePermissionBashEnvPolicy(this.envPolicy, permissionExecutionPlan);
    // Only a PTC child carries ptcDeadline; every other call keeps the
    // ordinary foreground timing. Computed after approval, so time spent
    // waiting on a card already counts against the program. A longer
    // foreground timeout first extends the program (ptcBashDeadline).
    const ptcTimeout = ctx.ptcDeadline
      ? resolvePtcForegroundTimeout(input, ptcBashDeadline(input, ctx.ptcDeadline), Date.now())
      : undefined;
    const hostTrashResult = await executeLocalHostTrashIfRequested({
      toolInput: input,
      workspaceRoot: this.workspaceRoot,
      runtime: this.hostTrashRuntime,
      envPolicy,
      timeoutSeconds:
        ptcTimeout?.timeoutSeconds ??
        resolveForegroundTimeout({ timeout: timing.commandTimeoutSeconds }),
      ...(signal ? { signal } : {}),
    });
    if (hostTrashResult) {
      if (ptcTimeout) ctx.ptcDeadline?.reportTimeout?.(ptcTimeout);
      return applyDesktopTextLimit(hostTrashResult, limitDesktopBashOutput(hostTrashResult.text));
    }
    if (input.run_in_background === true) {
      if (!this.backgroundAdapter) {
        const text = '<bash_error>Background bash execution is not enabled</bash_error>';
        return {
          tool_name: LocalBashToolDef.name,
          text,
          content: [{ type: 'text', text }],
          details: { status: 'background_not_enabled' },
          isError: true,
        };
      }
      const started = await this.backgroundAdapter.startBackground(ctx, input, signal);
      if (started.status !== 'started' || !started.taskId) {
        const errorMessage = started.errorMessage ?? 'Local background bash failed to start';
        const text = `<bash_error>${errorMessage}</bash_error>`;
        return {
          tool_name: LocalBashToolDef.name,
          text,
          content: [{ type: 'text', text }],
          details: { status: started.status },
          isError: true,
        };
      }
      return backgroundBashToolResult(
        started.taskId,
        'started',
        this.consumeEnvSanitizationHint({
          ...started.details,
          description: input.description,
          timing: { ...timing, ...(started.details?.timing as object) },
        }),
      );
    }

    const { run_in_background: _runInBackground, ...rest } = input;
    // A PTC child runs against its program's deadline instead of the ordinary
    // foreground limit; the program reports that decision itself.
    const foregroundTiming: LocalBashTiming = ptcTimeout
      ? { commandTimeoutSeconds: ptcTimeout.timeoutSeconds }
      : timing;
    const foregroundInput = permissionExecutionPlan
      ? copyWithPermissionExecutionPlan(
          { ...rest, timeout: foregroundTiming.commandTimeoutSeconds },
          permissionExecutionPlan,
        )
      : { ...rest, timeout: foregroundTiming.commandTimeoutSeconds };
    if (ptcTimeout) ctx.ptcDeadline?.reportTimeout?.(ptcTimeout);
    if (
      ctx.canConsumeBackgroundBashOutput === true &&
      ctx.allowBashAutoPromotion !== false &&
      this.backgroundAdapter?.runManagedForeground
    ) {
      const managed = await this.backgroundAdapter.runManagedForeground(
        ctx,
        foregroundInput,
        DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS,
        signal,
      );
      if (managed.status !== 'completed') {
        if (managed.status === 'auto_promoted' && managed.taskId) {
          return backgroundBashToolResult(
            managed.taskId,
            'auto_promoted',
            this.consumeEnvSanitizationHint({
              ...managed.details,
              description: input.description,
              timing: { ...foregroundTiming, ...(managed.details?.timing as object) },
            }),
          );
        }
        const text = `<bash_error>${managed.errorMessage ?? 'Local managed bash failed to start'}</bash_error>`;
        return {
          tool_name: LocalBashToolDef.name,
          text,
          content: [{ type: 'text', text }],
          details: { status: managed.status },
          isError: true,
        };
      }
      const managedFullOutputPath =
        typeof managed.details?.fullOutputPath === 'string'
          ? managed.details.fullOutputPath
          : undefined;

      const managedDetails = this.consumeEnvSanitizationHint(managed.details);
      const result = withLocalBashTiming(
        withCompatibleBashToolResponseFromPiDetails({
          tool_name: LocalBashToolDef.name,
          text: managed.text,
          content: [{ type: 'text', text: managed.text }],
          details: {
            ...managedDetails,
            status: readBashExecutionOutcome(managedDetails)?.status ?? 'completed',
            task_id: managed.taskId,
          },
          ...(managed.isError ? { isError: true } : {}),
        }),
        foregroundTiming,
      );
      return applyDesktopTextLimit(
        result,
        limitDesktopBashOutput(result.text, managedFullOutputPath, result.details, managed.taskId),
      );
    }
    let result: ToolResult;
    try {
      const tool = createBashTool(this.workspaceRoot, {
        output: {
          strategy: 'head_tail',
          maxBytes: DESKTOP_BASH_PREVIEW_BYTES,
          maxLines: Number.MAX_SAFE_INTEGER,
        },
        ...(this.sandboxOperationsFactory
          ? {
              operations: this.sandboxOperationsFactory.create({
                identity: directForegroundIdentity(ctx),
                workspaceRoot: this.workspaceRoot,
                ...(permissionExecutionPlan ? { permissionExecutionPlan } : {}),
              }),
            }
          : {}),
        // Bind the approved policy to this invocation, including its spawn hook.
        spawnHook: (spawnContext) => {
          const { env, removed } = sanitizeBashSubprocessEnv(spawnContext.env, envPolicy);
          this.lastEnvRemoved = removed;
          return { ...spawnContext, env };
        },
      });
      const res = await tool.execute('', foregroundInput, signal);
      const completed = localBashResultFromPi(res);
      result = withCompatibleBashToolResponseFromPiDetails({
        tool_name: LocalBashToolDef.name,
        ...completed,
        content: [{ type: 'text', text: completed.text }],
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      const failed = localBashResultFromError(error, signal);
      result = withCompatibleBashToolResponseFromPiDetails({
        tool_name: LocalBashToolDef.name,
        ...failed,
        content: [{ type: 'text', text: failed.text }],
      });
    }
    result = withLocalBashTiming(result, foregroundTiming);
    const fullOutputPath =
      typeof result.details?.fullOutputPath === 'string'
        ? result.details.fullOutputPath
        : undefined;
    const limited = limitDesktopBashOutput(result.text, fullOutputPath, result.details);
    result = applyDesktopTextLimit(result, limited);
    result.details = this.consumeEnvSanitizationHint({
      ...(result.details ?? {}),
      ...(this.lastEnvRemoved.length > 0 ? { envSanitized: this.lastEnvRemoved } : {}),
    });
    return result;
  }

  private consumeEnvSanitizationHint(
    details: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const { envSanitized, ...rest } = details ?? {};
    const removed = Array.isArray(envSanitized)
      ? envSanitized.filter((name): name is string => typeof name === 'string')
      : [];
    if (this.envHintShown || removed.length === 0) return rest;
    // Report names only (never values) so a user whose command suddenly
    // misses a credential can find the sanitizer instead of debugging blind.
    this.envHintShown = true;
    return { ...rest, envSanitized: removed };
  }
}

function directForegroundIdentity(ctx: LocalRuntimeToolContext): LocalSandboxInvocationIdentity {
  const invocationId = ctx.toolCallId ?? `runtime_${randomUUID()}`;
  return {
    operationClass: 'direct_foreground' as const,
    invocationId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
    ...(ctx.forceReadOnlyFilesystem ? { forceReadOnlyFilesystem: true } : {}),
  };
}

function limitDesktopBashOutput(
  text: string,
  fullOutputPath?: string,
  details?: Record<string, unknown>,
  taskId?: string,
) {
  const output = details?.output as { rawBytes?: number; persistenceError?: string } | undefined;
  let previewText = text;
  if (!taskId) {
    if ((details?.truncation as { truncated?: boolean } | undefined)?.truncated) {
      previewText += `\n\n[desktop bash output truncated: original_bytes=${output?.rawBytes}; original head+tail shown.${fullOutputPath ? ` Full output: ${fullOutputPath}` : ''}]`;
    }
    if (output?.persistenceError) {
      previewText += `\n\n[Output persistence failed; complete output is unavailable: ${output.persistenceError}]`;
    }
  }
  const limited = limitDesktopHeadTailLines(previewText, {
    maxBytes: DESKTOP_BASH_MAX_BYTES,
    notice: ({ originalBytes }) =>
      fullOutputPath
        ? `[desktop bash output truncated: original_bytes=${originalBytes}; head+tail shown; boundary lines may be UTF-8 byte-truncated; Full output: ${fullOutputPath}]`
        : `[desktop bash output truncated: original_bytes=${originalBytes}; head+tail shown; boundary lines may be UTF-8 byte-truncated.]`,
  });
  if (
    limited.truncation ||
    (details?.truncation as { truncated?: boolean } | undefined)?.truncated
  ) {
    limited.truncation = {
      truncated: true,
      has_more: true,
      strategy: 'head_tail_lines',
      original_bytes:
        output?.rawBytes ?? limited.truncation?.original_bytes ?? Buffer.byteLength(text, 'utf8'),
      returned_bytes: Buffer.byteLength(limited.text, 'utf8'),
      max_bytes: DESKTOP_BASH_MAX_BYTES,
    };
  }
  return withDesktopOutputContinuation(limited, {
    continuation_hint: taskId
      ? {
          tool: 'task_output',
          preserve_args: ['task_id'],
          instruction: `Read task ${taskId} with task_output; continue with its next_offset (UTF-8 log file bytes). Check output persistence status before treating the log as complete.`,
        }
      : fullOutputPath
        ? {
            tool: 'read',
            preserve_args: ['path'],
            instruction: `Read the full output at ${fullOutputPath}; continue long reads with the returned next_offset.`,
          }
        : {
            tool: 'bash',
            preserve_args: [],
            instruction:
              'Do not blindly rerun a potentially side-effecting command; narrow it or redirect output to a file, then use read.',
          },
  });
}

export function resolveForegroundTimeout(input: { timeout?: number }): number {
  return resolveLocalBashTiming(input.timeout, 'direct_foreground').commandTimeoutSeconds!;
}

/**
 * Program deadline a PTC Bash child runs against. A foreground call whose own
 * `timeout` (seconds) is longer than the program has left asks Agent Core to
 * extend the program, which owns that rule, its margin and the one-hour cap:
 * a model that gave tools.bash a long timeout but no run_code timeout_ms
 * expects the command to get that long, not to be cut at the program's 120s.
 * Background Bash is not bounded by the program, so it never extends it.
 */
function ptcBashDeadline(input: LocalBashToolInput, deadline: PtcChildDeadline): number {
  const requested = input.timeout;
  if (
    input.run_in_background === true ||
    requested === undefined ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return deadline.atMs;
  }
  return deadline.extendForTimeout?.(requested) ?? deadline.atMs;
}

/**
 * Foreground timeout of a Bash call made inside a run_code program. The
 * program already has a wall clock (`timeout_ms`, 120s by default); a fixed
 * 120s/300s Bash bound would kill a long command even after the model raised
 * `timeout_ms`, so here the program's remaining time is the default and the
 * cap instead. With the default `timeout_ms` the remaining time never exceeds
 * 120s, so nothing changes for programs that do not raise it. A longer
 * requested timeout has already extended the deadline (ptcBashDeadline), so
 * the cap only bites at the one-hour maximum or for an expired program.
 *
 * Rounded up to whole seconds and at least 1: Pi treats 0 as "no timeout",
 * and rounding down would let Bash time out just before the program's own
 * wall clock, changing the result of a default program that runs too long.
 */
export function resolvePtcForegroundTimeout(
  input: { timeout?: number },
  deadlineAtMs: number,
  nowMs: number,
): PtcChildTimeoutDecision {
  const remainingMs = Math.max(0, deadlineAtMs - nowMs);
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const requested = input.timeout;
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return { source: 'program_remaining', timeoutSeconds: remainingSeconds, remainingMs };
  }
  return requested > remainingSeconds
    ? { source: 'requested_capped', timeoutSeconds: remainingSeconds, remainingMs }
    : { source: 'requested', timeoutSeconds: requested, remainingMs };
}

function backgroundBashToolResult(
  taskId: string,
  status: 'started' | 'auto_promoted',
  details: Record<string, unknown> = {},
): ToolResult {
  const lead =
    status === 'auto_promoted'
      ? 'The command is still running and was yielded to a managed background task without restarting it.'
      : 'Background Bash task accepted; command startup may still be in progress.';
  const timing = details.timing as LocalBashTiming | undefined;
  const timingText =
    timing?.commandTimeoutSeconds !== undefined
      ? ` Command limit: ${timing.commandTimeoutSeconds}s total; yielding does not reset it.`
      : '';
  const purpose =
    typeof details.description === 'string'
      ? `Purpose: ${limitDesktopHeadTailLines(details.description, {
          maxBytes: 1024,
          notice: () => '[purpose truncated]',
        }).text}\n`
      : '';
  const text = `<bash_background task_id="${taskId}">\n${purpose}${lead}${timingText} The owning conversation will automatically resume when it finishes; use task_output to inspect incremental output, and task_stop to cancel if that tool is available.\n</bash_background>`;
  return {
    tool_name: LocalBashToolDef.name,
    text,
    content: [{ type: 'text', text }],
    details: { ...details, status, task_id: taskId },
  };
}

function unavailableBackgroundBashOutputResult(): ToolResult {
  const text =
    '<bash_error>Background Bash requires native task_output. This Turn is missing task_output, so asynchronous Bash cannot be executed. Run the command in the foreground instead.</bash_error>';
  return {
    tool_name: LocalBashToolDef.name,
    text,
    content: [{ type: 'text', text }],
    details: {
      status: 'background_output_unavailable',
      error_code: 'BASH_BACKGROUND_OUTPUT_UNAVAILABLE',
    },
    isError: true,
  };
}

function toToolResult(toolName: string, res: AgentToolResult<Record<string, unknown>>): ToolResult {
  const content = res.content as ToolResultContent[];
  return {
    tool_name: toolName,
    text: content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
    content,
    details: (res.details ?? {}) as Record<string, unknown>,
    ...(res.terminate !== undefined ? { terminate: res.terminate } : {}),
  };
}

/**
 * Best-effort absolute path used to pre-detect read dispatch extensions and
 * to look up write captures. Mirrors the common pieces of pi's
 * `normalizePath` (tilde expansion + absolute pass-through) without pulling
 * pi's private path-utils. Any failure to resolve here just means the read
 * wrappers can apply their own path probing without changing write / edit
 * capture semantics.
 */
/**
 * Keep the ledger key byte-for-byte aligned with Pi's `resolveToCwd` input.
 * This is deliberately lexical: `realpath` would collapse symlink aliases and
 * broaden a read authorization beyond the path spelling the agent inspected.
 */
export function normalizeLocalExistingPath(
  absolutePath: string,
  resolveAbsolutePath: (path: string) => string = resolvePath,
): string {
  return resolveAbsolutePath(absolutePath);
}

function resolveLocalCandidatePath(input: string, workspaceRoot: string): string {
  let path = input;
  if (path === '~') {
    return normalizeLocalExistingPath(homedir());
  }
  if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) {
    path = resolvePath(homedir(), path.slice(2));
  }
  return normalizeLocalExistingPath(isAbsolute(path) ? path : resolvePath(workspaceRoot, path));
}

async function resolveLocalReadPath(input: string, workspaceRoot: string): Promise<string> {
  const literalResolved = resolveLocalCandidatePath(input, workspaceRoot);
  if (await pathExists(literalResolved)) return literalResolved;

  const resolved = resolveLocalReadCandidatePath(input, workspaceRoot);
  if (await pathExists(resolved)) return resolved;

  const amPmVariant = resolved.replace(/ (AM|PM)\./gi, '\u202f$1.');
  if (amPmVariant !== resolved && (await pathExists(amPmVariant))) return amPmVariant;

  const nfdVariant = resolved.normalize('NFD');
  if (nfdVariant !== resolved && (await pathExists(nfdVariant))) return nfdVariant;

  const curlyVariant = resolved.replace(/'/g, '\u2019');
  if (curlyVariant !== resolved && (await pathExists(curlyVariant))) return curlyVariant;

  const nfdCurlyVariant = nfdVariant.replace(/'/g, '\u2019');
  if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
    return nfdCurlyVariant;
  }

  return resolved;
}

function resolveLocalReadCandidatePath(input: string, workspaceRoot: string): string {
  let path = normalizeLocalReadInput(input);
  if (path === '~') {
    return normalizeLocalExistingPath(homedir());
  }
  if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) {
    path = resolvePath(homedir(), path.slice(2));
  }
  return normalizeLocalExistingPath(isAbsolute(path) ? path : resolvePath(workspaceRoot, path));
}

function normalizeLocalReadInput(input: string): string {
  let normalized = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isFsNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

export {
  DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS,
  MAX_FOREGROUND_BASH_TIMEOUT_SECONDS,
  DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS,
} from './local-bash-timing.js';
