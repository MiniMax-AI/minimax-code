import {
  bindTool,
  type ToolImpl,
  type ToolResult,
  type ToolResultContent,
} from '@mavis/agent-core/tools';
import {
  sanitizeBashSubprocessEnv,
  type BashEnvPolicy,
} from '@mavis/agent-core/bash-subprocess-env';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  getShellConfig,
} from '@earendil-works/pi-coding-agent';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { access } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { homedir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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
import { inferReadVideoMimeType, readVideoAsToolResult } from '../shared/read-video.js';
import { buildReplaceAllEdit, ReplaceAllError } from '../shared/replace-all-edit.js';
import {
  checkBlockedDeviceRead,
  checkNonRegularFileRead,
  detectBinaryRead,
} from '../shared/read-guards.js';
import { isPdfReadPath, readPdfAsToolResult } from '../shared/read-pdf.js';
import { isNotebookReadPath, readNotebookAsToolResult } from '../shared/read-notebook.js';
import { piReadResultToToolResult, readErrorResult } from '../shared/read-result.js';
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
    this.tool = createReadTool(workspaceRoot);
  }

  async execute(
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
    if (deviceError) return readErrorResult(LocalReadToolDef.name, deviceError);

    // Closes the FIFO/socket/block-device blind spot the path-only device
    // guard misses (one stat, follows symlinks) — a named pipe would block
    // the whole turn just like /dev/zero.
    const irregularError = await checkNonRegularFileRead(readAbs);
    if (irregularError) return readErrorResult(LocalReadToolDef.name, irregularError);

    // pi natively inlines images (jpg/png/gif/webp). Video is not part of
    // pi's built-in mime detection, so we mirror cloud-runtime here: when
    // the path looks like an inline-capable video, run the shared helper
    // first and fall through to pi only when (a) the extension is not a
    // recognised video, or (b) the candidate path does not exist (let pi's
    // NFD / curly-quote / AM-PM fallbacks have a chance to find the file).
    const videoMime = inferReadVideoMimeType(readAbs);
    if (videoMime) {
      try {
        return await readVideoAsToolResult({
          toolName: LocalReadToolDef.name,
          absolutePath: readAbs,
          mimeType: videoMime,
          capabilities: ctx.parentAgentConfig?.model?.capabilities,
          signal,
        });
      } catch (err) {
        if (!isFsNotFoundError(err)) throw err;
        // ENOENT — let pi retry with its macOS-aware path variants.
      }
    }

    // PDF / notebook dispatch: these never reach pi (which would read them
    // as UTF-8 garbage / raw JSON).
    if (isPdfReadPath(readAbs)) {
      return readPdfAsToolResult({
        toolName: LocalReadToolDef.name,
        absolutePath: readAbs,
        pages: input.pages,
        signal,
      });
    }
    if (isNotebookReadPath(readAbs)) {
      return readNotebookAsToolResult({
        toolName: LocalReadToolDef.name,
        absolutePath: readAbs,
        signal,
      });
    }

    // Binary guard: pi would decode anything else as UTF-8 — turn silent
    // garbage into an explicit, recoverable tool error.
    const binary = await detectBinaryRead(readAbs);
    if (binary.binary) return readErrorResult(LocalReadToolDef.name, binary.message);

    // Strip `pages` before delegating: pi's read schema does not know the
    // parameter, and models occasionally send it for non-PDF files.
    const { pages: _pages, ...piInput } = input;
    const res = await this.tool.execute('', piInput, signal);
    const result = piReadResultToToolResult(LocalReadToolDef.name, res, {
      offset: input.offset,
    });
    return limitDesktopReadTextResult(result, input.offset);
  }
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
    const res = await tool.execute('', input, signal);
    const capture = takeCapture(resolveLocalCandidatePath(input.path, this.workspaceRoot));
    return buildWriteToolResult(
      LocalWriteToolDef.name,
      input.path,
      input.content,
      capture,
      toToolResult(LocalWriteToolDef.name, res).text,
    );
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
    const piInput = await buildPiEditInput(input, this.workspaceRoot);
    const capture = createCapturingEditOperations();
    const tool = createEditTool(this.workspaceRoot, { operations: capture.operations });
    const res = await executeEditWithLineNumberRetry(tool, piInput, signal);
    const result = toToolResult(LocalEditToolDef.name, res);
    const editCapture = capture.takeCapture(
      resolveLocalCandidatePath(input.file_path, this.workspaceRoot),
    );
    if (!editCapture) return result;
    const normalized =
      result.details?.line_number_prefixes_stripped === true
        ? normalizeEditsForLineNumberRetry([
            { oldText: input.old_string, newText: input.new_string },
          ])?.[0]
        : undefined;
    return withCompatibleEditToolResponse(result, {
      filePath: editCapture.path,
      oldString: normalized?.oldText ?? input.old_string,
      newString: normalized?.newText ?? input.new_string,
      originalFile: editCapture.originalFile,
      replaceAll: input.replace_all === true,
      userModified: false,
    });
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
      return { path: replacement.path, edits: replacement.edits };
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
  private readonly tool: AgentTool;
  private readonly envPolicy: BashEnvPolicy;
  /** Names stripped by the sanitizer at the most recent spawn (never values). */
  private lastEnvRemoved: string[] = [];
  /** One-shot hint gate: report stripped names once per tool instance. */
  private envHintShown = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly backgroundAdapter: LocalBashAdapter | undefined,
    envPolicy: BashEnvPolicy,
    private readonly hostTrashRuntime?: LocalHostTrashRuntime,
    private readonly sandboxOperationsFactory?: LocalSandboxBashOperationsFactory,
  ) {
    this.envPolicy = envPolicy;
    // Env sanitizer (design: bash-tool-optimization.md §2.2). Layer A boundary
    // strip is always on; Layer B secret scrub follows the resolved policy.
    // The background executor and the pi-turn-runner fallback apply the same
    // hook — keep the three spawn sites in sync.
    this.tool = createBashTool(workspaceRoot, {
      spawnHook: (ctx) => {
        const { env, removed } = sanitizeBashSubprocessEnv(ctx.env, this.envPolicy);
        this.lastEnvRemoved = removed;
        return { ...ctx, env };
      },
    });
  }

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalBashToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    if (input.run_in_background === true && ctx.canConsumeBackgroundBashOutput !== true) {
      return unavailableBackgroundBashOutputResult();
    }
    const hostTrashResult = await executeLocalHostTrashIfRequested({
      toolInput: input,
      workspaceRoot: this.workspaceRoot,
      runtime: this.hostTrashRuntime,
      envPolicy: this.envPolicy,
      timeoutSeconds: resolveForegroundTimeout(input),
      ...(signal ? { signal } : {}),
    });
    if (hostTrashResult) {
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
        this.consumeEnvSanitizationHint(started.details),
      );
    }

    const { run_in_background: _runInBackground, ...rest } = input;
    const foregroundInput = { ...rest, timeout: resolveForegroundTimeout(rest) };
    if (ctx.allowBashAutoPromotion !== false && this.backgroundAdapter?.runManagedForeground) {
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
            this.consumeEnvSanitizationHint(managed.details),
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
      const limited = limitDesktopBashOutput(managed.text, managedFullOutputPath);
      const managedDetails = this.consumeEnvSanitizationHint(managed.details);
      return applyDesktopTextLimit(
        {
          tool_name: LocalBashToolDef.name,
          text: managed.text,
          content: [{ type: 'text', text: managed.text }],
          details: {
            ...managedDetails,
            status: 'completed',
            task_id: managed.taskId,
          },
          ...(managed.isError ? { isError: true } : {}),
        },
        limited,
      );
    }
    let result: ToolResult;
    try {
      const tool = this.sandboxOperationsFactory
        ? createBashTool(this.workspaceRoot, {
            operations: this.sandboxOperationsFactory.create({
              identity: directForegroundIdentity(ctx),
              workspaceRoot: this.workspaceRoot,
            }),
            spawnHook: (spawnContext) => {
              const { env, removed } = sanitizeBashSubprocessEnv(spawnContext.env, this.envPolicy);
              this.lastEnvRemoved = removed;
              return { ...spawnContext, env };
            },
          })
        : this.tool;
      const res = await tool.execute('', foregroundInput, signal);
      result = withCompatibleBashToolResponseFromPiDetails(
        toToolResult(LocalBashToolDef.name, res),
      );
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      const text = error instanceof Error ? error.message : String(error);
      const fullOutputPath = extractBashFullOutputPath(text);
      result = {
        tool_name: LocalBashToolDef.name,
        text,
        content: [{ type: 'text', text }],
        ...(fullOutputPath ? { details: { fullOutputPath } } : {}),
        isError: true,
      };
    }
    const fullOutputPath =
      typeof result.details?.fullOutputPath === 'string'
        ? result.details.fullOutputPath
        : undefined;
    const limited = limitDesktopBashOutput(result.text, fullOutputPath);
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

function limitDesktopBashOutput(text: string, fullOutputPath?: string) {
  const limited = limitDesktopHeadTailLines(text, {
    maxBytes: DESKTOP_BASH_MAX_BYTES,
    notice: ({ originalBytes }) =>
      fullOutputPath
        ? `[desktop bash output truncated: original_bytes=${originalBytes}; head+tail shown; boundary lines may be UTF-8 byte-truncated; Full output: ${fullOutputPath}]`
        : `[desktop bash output truncated: original_bytes=${originalBytes}; head+tail shown; boundary lines may be UTF-8 byte-truncated; rerun with a narrower command or redirect output to a file and use read.]`,
  });
  return withDesktopOutputContinuation(limited, {
    continuation_hint: fullOutputPath
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

function extractBashFullOutputPath(text: string): string | undefined {
  const matches = [...text.matchAll(/Full output:\s*(.+?)\](?:\n|$)/gi)];
  const path = matches.at(-1)?.[1]?.trim();
  return path || undefined;
}

/**
 * Default foreground timeout (seconds) applied when the model omits `timeout`.
 * Restores main's historical 120s bound so interactive/blocking foreground
 * commands (e.g. `lark-cli auth login`) cannot hang forever. Background tasks
 * (`run_in_background: true`) are intentionally NOT bounded by this.
 */
export const DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS = 120;
export const MAX_FOREGROUND_BASH_TIMEOUT_SECONDS = 300;
export const DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS = 15_000;

/**
 * Keep interactive foreground commands bounded. Missing, non-finite and
 * non-positive values use the 120s default; larger values are capped at 5m.
 * Longer commands should opt into background execution explicitly.
 */
export function resolveForegroundTimeout(input: { timeout?: number }): number {
  const requested = input.timeout;
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS;
  }
  return Math.min(requested, MAX_FOREGROUND_BASH_TIMEOUT_SECONDS);
}

function backgroundBashToolResult(
  taskId: string,
  status: 'started' | 'auto_promoted',
  details: Record<string, unknown> = {},
): ToolResult {
  const lead =
    status === 'auto_promoted'
      ? 'The command is still running and was yielded to a managed background task without restarting it.'
      : 'Started local background bash task.';
  const text = `<bash_background task_id="${taskId}">\n${lead} The owning conversation will automatically resume when it finishes; use task_query/task_output to inspect incremental output and task_stop to cancel it.\n</bash_background>`;
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
