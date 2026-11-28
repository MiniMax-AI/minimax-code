/**
 * Host-neutral `bash` tool: the desktop LocalBashTool with every desktop-only
 * capability (host trash, sandboxed operations, subprocess env sanitizing,
 * background / managed execution) injected through options. The desktop
 * subclass supplies all of them, so the behavior there is unchanged; a host
 * that omits one simply runs without that capability.
 */

import {
  type PtcChildDeadline,
  type PtcChildTimeoutDecision,
  type ToolExecutionContext,
  type ToolImpl,
  type ToolResult,
  withProgrammaticResult,
} from '@mavis/agent-core/tools';
import { sanitizeBashSubprocessEnv } from '@mavis/agent-core/bash-subprocess-env';
import type { BashOperations } from '@earendil-works/pi-coding-agent';

import { resolveBashDescription } from '../desktop/local-bash-input.js';
import {
  DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS,
  MAX_BASH_TIMEOUT_SECONDS,
  resolveLocalBashTiming,
  validateBashCommand,
  withLocalBashTiming,
  type LocalBashTiming,
} from '../desktop/local-bash-timing.js';
import { readBashExecutionOutcome } from '../desktop/local-bash-result.js';
import type {
  LocalBashBackgroundStartResult,
  LocalBashManagedForegroundResult,
} from '../desktop/types.js';
import {
  copyWithPermissionExecutionPlan,
  readPermissionExecutionPlan,
  resolvePermissionBashEnvPolicy,
  type LocalBashEnvPolicySource,
  type LocalPermissionExecutionPlan,
} from '../desktop/permission-execution.js';
import { withDesktopCompletenessReport } from '../desktop/ptc-result-projection.js';
import { withCompatibleBashToolResponseFromPiDetails } from '../plugin-hooks/vendor-tool-response.js';
import {
  applyDesktopTextLimit,
  DESKTOP_BASH_MAX_BYTES,
  isPtcChildCall,
  limitDesktopHeadTailLines,
  PTC_CHILD_FULL_OUTPUT_MAX_BYTES,
  withDesktopOutputContinuation,
} from '../desktop/output-limit.js';
import { readFile, stat } from '../shared/physical-fs.js';
import { LocalBashToolDef, type LocalBashToolInput } from './defs.js';
import { runPiBash } from './pi-bash.js';

/** Context fields the bash tool consumes; both are frozen by the host from the Turn catalog. */
export interface CoreBashContext extends ToolExecutionContext {
  readonly canConsumeBackgroundBashOutput?: boolean;
  readonly allowBashAutoPromotion?: boolean;
}

/** Background-task owner of the host (desktop LocalBashAdapter has this shape). */
export interface CoreBashAdapter<Ctx> {
  startBackground(
    ctx: Ctx,
    input: LocalBashToolInput,
    signal?: AbortSignal,
  ): Promise<LocalBashBackgroundStartResult>;
  runManagedForeground?(
    ctx: Ctx,
    input: LocalBashToolInput,
    softYieldMs: number,
    signal?: AbortSignal,
  ): Promise<CoreBashManagedForegroundResult>;
}

/**
 * Result of a managed foreground run. `unavailable`: the host could not start
 * the command as a managed one and nothing ran, so it runs as an ordinary
 * foreground command instead.
 */
export type CoreBashManagedForegroundResult =
  | LocalBashManagedForegroundResult
  | { readonly status: 'unavailable' };

export interface CoreBashHostTrashRequest {
  readonly toolInput: LocalBashToolInput;
  readonly permissionExecutionPlan: LocalPermissionExecutionPlan | undefined;
  readonly timeoutSeconds: number;
  readonly signal?: AbortSignal;
}

export interface CoreBashToolOptions<Ctx> {
  /** Runs explicit background and managed foreground commands; absent rejects background. */
  readonly backgroundAdapter?: CoreBashAdapter<Ctx> | undefined;
  /** Approved subprocess env policy; absent spawns without the env sanitizer. */
  readonly envPolicy?: LocalBashEnvPolicySource;
  /** Host-side recoverable delete; returns a result when it handled the command. */
  readonly executeHostTrash?: (
    request: CoreBashHostTrashRequest,
  ) => Promise<ToolResult | undefined>;
  /** Operations of a direct foreground run; absent uses Pi's local shell. */
  readonly createOperations?: (
    ctx: Ctx,
    permissionExecutionPlan: LocalPermissionExecutionPlan | undefined,
  ) => BashOperations;
  /** `false` keeps the output in memory: the host cannot read Pi's local output file. */
  readonly persistOutput?: false;
  /**
   * The whole output of the run this result stands for, in memory, for a
   * run_code child. A host whose commands run on a remote compute has no local
   * output file for the file-based path to read (it passes `persistOutput:
   * false`), but its operations already hold the whole output; it hands it back
   * here. Called only for a PTC child, before the Desktop preview cap;
   * undefined falls back to the output file, then to the capped preview.
   */
  readonly readFullOutput?: (ctx: Ctx, result: ToolResult) => Promise<string | undefined>;
  /** How a PTC child's full-output attempt ended, for host metrics; counts and enums only. */
  readonly onChildFullOutput?: (outcome: PtcChildFullOutputOutcome) => void;
  /**
   * How the model learns that a background command finished, as stated in its
   * start result. Absent: the owning conversation resumes on its own (desktop).
   * `next_turn_reminder`: the next turn starts with a reminder that lists it.
   * `task_output`: nothing is sent; the model checks with task_output.
   */
  readonly backgroundCompletion?: CoreBashBackgroundCompletion;
  /**
   * Most seconds this host runs one foreground command. A direct foreground
   * command takes the lower of this and the ordinary 300s; a run_code child,
   * which can ask for more than 300s, is lowered to this. The result states the
   * effective value. Absent keeps 300s and the program-deadline rule alone.
   */
  readonly maxForegroundTimeoutSeconds?: number;
  /**
   * Default and most seconds of a managed foreground command, foreground and
   * background time together. Absent keeps the desktop 3600s.
   */
  readonly maxManagedTimeoutSeconds?: number;
}

export type CoreBashBackgroundCompletion = 'next_turn_reminder' | 'task_output';

/**
 * `restored`: the child got the whole output. `over_limit`: the output was over
 * PTC_CHILD_FULL_OUTPUT_MAX_BYTES, so the child keeps the capped preview.
 * `unavailable`: nothing could be read back (no host copy, no usable output
 * file, or the preview could not be located in the text).
 */
export type PtcChildFullOutputOutcome = 'restored' | 'over_limit' | 'unavailable';

/** A run_code child's foreground timeout; `hostLimitSeconds` when the host maximum lowered it. */
type PtcForegroundTimeout = PtcChildTimeoutDecision & { readonly hostLimitSeconds?: number };

export class CoreBashTool<Ctx extends CoreBashContext = CoreBashContext> implements ToolImpl<
  typeof LocalBashToolDef.schema,
  Ctx
> {
  private readonly envPolicy: LocalBashEnvPolicySource | undefined;
  private readonly backgroundAdapter: CoreBashAdapter<Ctx> | undefined;
  /** Names stripped by the sanitizer at the most recent spawn (never values). */
  private lastEnvRemoved: string[] = [];
  /** One-shot hint gate: report stripped names once per tool instance. */
  private envHintShown = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly options: CoreBashToolOptions<Ctx> = {},
  ) {
    this.envPolicy = options.envPolicy;
    this.backgroundAdapter = options.backgroundAdapter;
  }

  async execute(ctx: Ctx, input: LocalBashToolInput, signal?: AbortSignal): Promise<ToolResult> {
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
        this.options.maxManagedTimeoutSeconds,
        this.options.maxForegroundTimeoutSeconds,
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
    ctx: Ctx,
    input: LocalBashToolInput,
    timing: LocalBashTiming,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (input.run_in_background === true && ctx.canConsumeBackgroundBashOutput !== true) {
      return unavailableBackgroundBashOutputResult();
    }
    const permissionExecutionPlan = readPermissionExecutionPlan(input);
    const envPolicySource = this.envPolicy;
    const envPolicy =
      envPolicySource === undefined
        ? undefined
        : () => resolvePermissionBashEnvPolicy(envPolicySource, permissionExecutionPlan);
    // Only a PTC child carries ptcDeadline; every other call keeps the
    // ordinary foreground timing. Computed after approval; the program clock
    // stood still while the card was open, so the wait is not taken from the
    // time left. A longer foreground timeout first extends the program
    // (ptcBashDeadline).
    const ptcTimeout = ctx.ptcDeadline
      ? this.ptcForegroundTimeout(input, ctx.ptcDeadline)
      : undefined;
    const hostTrashResult = await this.options.executeHostTrash?.({
      toolInput: input,
      permissionExecutionPlan,
      timeoutSeconds:
        ptcTimeout?.timeoutSeconds ??
        resolveForegroundTimeout({ timeout: timing.commandTimeoutSeconds }),
      ...(signal ? { signal } : {}),
    });
    if (hostTrashResult) {
      if (ptcTimeout) ctx.ptcDeadline?.reportTimeout?.(ptcTimeout);
      const childOutput = isPtcChildCall(ctx)
        ? await this.childFullOutput(ctx, hostTrashResult)
        : undefined;
      return (
        childOutput ??
        applyDesktopTextLimit(hostTrashResult, limitDesktopBashOutput(hostTrashResult.text))
      );
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
        this.options.backgroundCompletion,
      );
    }

    const { run_in_background: _runInBackground, ...rest } = input;
    const withTimeout = (timeout: number | undefined): LocalBashToolInput =>
      permissionExecutionPlan
        ? copyWithPermissionExecutionPlan({ ...rest, timeout }, permissionExecutionPlan)
        : { ...rest, timeout };
    // A PTC child runs against its program's deadline instead of the ordinary
    // foreground limit; the program reports that decision itself.
    let foregroundTiming: LocalBashTiming = ptcTimeout
      ? { commandTimeoutSeconds: ptcTimeout.timeoutSeconds }
      : timing;
    let foregroundInput = withTimeout(foregroundTiming.commandTimeoutSeconds);
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
      if (managed.status !== 'unavailable') {
        return this.managedForegroundResult(ctx, input, managed, foregroundTiming);
      }
      foregroundTiming = directForegroundTiming(
        input.timeout,
        this.options.maxForegroundTimeoutSeconds,
      );
      foregroundInput = withTimeout(foregroundTiming.commandTimeoutSeconds);
    }
    const { createOperations } = this.options;
    const completed = await runPiBash(
      this.workspaceRoot,
      foregroundInput,
      {
        ...(createOperations
          ? { createOperations: () => createOperations(ctx, permissionExecutionPlan) }
          : {}),
        ...(this.options.persistOutput === false ? { persistOutput: false } : {}),
        // Bind the approved policy to this invocation, including its spawn hook.
        ...(envPolicy
          ? {
              spawnHook: (spawnContext) => {
                const { env, removed } = sanitizeBashSubprocessEnv(spawnContext.env, envPolicy);
                this.lastEnvRemoved = removed;
                return { ...spawnContext, env };
              },
            }
          : {}),
      },
      signal,
    );
    let result: ToolResult = withCompatibleBashToolResponseFromPiDetails({
      tool_name: LocalBashToolDef.name,
      ...completed,
      content: [{ type: 'text', text: completed.text }],
    });
    result = withLocalBashTiming(result, foregroundTiming);
    if (ptcTimeout?.hostLimitSeconds !== undefined) {
      result = withHostTimeoutLimit(result, ptcTimeout.hostLimitSeconds, input.timeout);
    }
    // A PTC child never reaches the managed path above: Agent Core gives it
    // allowBashAutoPromotion: false, so only this path and host trash read
    // the whole output back for it.
    const childOutput = isPtcChildCall(ctx) ? await this.childFullOutput(ctx, result) : undefined;
    if (childOutput) {
      result = childOutput;
    } else {
      const fullOutputPath =
        typeof result.details?.fullOutputPath === 'string'
          ? result.details.fullOutputPath
          : undefined;
      const limited = limitDesktopBashOutput(result.text, fullOutputPath, result.details);
      result = applyDesktopTextLimit(result, limited);
    }
    result.details = this.consumeEnvSanitizationHint({
      ...(result.details ?? {}),
      ...(this.lastEnvRemoved.length > 0 ? { envSanitized: this.lastEnvRemoved } : {}),
    });
    return result;
  }

  private async managedForegroundResult(
    ctx: Ctx,
    input: LocalBashToolInput,
    managed: LocalBashManagedForegroundResult,
    foregroundTiming: LocalBashTiming,
  ): Promise<ToolResult> {
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
          this.options.backgroundCompletion,
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
    const childOutput = isPtcChildCall(ctx) ? await this.childFullOutput(ctx, result) : undefined;
    if (childOutput) return childOutput;
    return applyDesktopTextLimit(
      result,
      limitDesktopBashOutput(result.text, managedFullOutputPath, result.details, managed.taskId),
    );
  }

  /**
   * The whole output for a PTC child: the host's in-memory copy when it has
   * one, otherwise Pi's own output file. Both rebuild the same way and both
   * give up over PTC_CHILD_FULL_OUTPUT_MAX_BYTES.
   */
  private async childFullOutput(ctx: Ctx, result: ToolResult): Promise<ToolResult | undefined> {
    const inMemory = await this.options.readFullOutput?.(ctx, result);
    if (inMemory === undefined) {
      const fromFile = await fullPtcBashOutput(result);
      this.options.onChildFullOutput?.(fromFile ? 'restored' : 'unavailable');
      return fromFile;
    }
    const overLimit = Buffer.byteLength(inMemory, 'utf8') > PTC_CHILD_FULL_OUTPUT_MAX_BYTES;
    const rebuilt = overLimit ? undefined : rebuiltPtcBashOutput(result, inMemory);
    this.options.onChildFullOutput?.(
      rebuilt ? 'restored' : overLimit ? 'over_limit' : 'unavailable',
    );
    return rebuilt;
  }

  /** A run_code child's foreground timeout, lowered to the host maximum when one is set. */
  private ptcForegroundTimeout(
    input: LocalBashToolInput,
    deadline: PtcChildDeadline,
  ): PtcForegroundTimeout {
    const max = this.options.maxForegroundTimeoutSeconds;
    const decision = resolvePtcForegroundTimeout(
      input,
      ptcBashDeadline(input, deadline, max),
      Date.now(),
    );
    if (max === undefined || decision.timeoutSeconds <= max) return decision;
    return {
      ...decision,
      source: decision.source === 'program_remaining' ? 'program_remaining' : 'requested_capped',
      timeoutSeconds: max,
      hostLimitSeconds: max,
    };
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

/**
 * The whole output of a PTC child Bash call, or undefined to keep the
 * Desktop preview. Pi keeps only a head+tail preview in memory and writes the
 * complete output to `fullOutputPath` (Pi core/tools/output-accumulator.ts);
 * a cut output is read back from that file, and the status lines appended
 * after the preview (exit code, timeout receipt) are kept. An incomplete or
 * failed save, or a file over PTC_CHILD_FULL_OUTPUT_MAX_BYTES, falls back to
 * the preview. The file is Pi's own output file in this process, so it is
 * read from the physical fs even when the commands run elsewhere (a host
 * that passes `persistOutput: false` has no such file and keeps the preview).
 */
async function fullPtcBashOutput(result: ToolResult): Promise<ToolResult | undefined> {
  const details = result.details ?? {};
  const cut = details.truncation as { truncated?: unknown; content?: unknown } | undefined;
  if (cut?.truncated !== true) {
    // Pi did not cut it: the text is already the whole output.
    const bytes = Buffer.byteLength(result.text, 'utf8');
    if (bytes > PTC_CHILD_FULL_OUTPUT_MAX_BYTES) return undefined;
    return bytes > DESKTOP_BASH_MAX_BYTES
      ? withProgrammaticResult(result, { uncappedOutput: true })
      : result;
  }
  const path = details.fullOutputPath;
  const persistence = (details.output as { persistence?: unknown } | undefined)?.persistence;
  const preview = cut.content;
  if (
    typeof path !== 'string' ||
    persistence !== 'complete' ||
    typeof preview !== 'string' ||
    !result.text.startsWith(preview)
  ) {
    return undefined;
  }
  let full: string;
  try {
    if ((await stat(path)).size > PTC_CHILD_FULL_OUTPUT_MAX_BYTES) return undefined;
    full = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const text = `${full}${result.text.slice(preview.length)}`;
  const rest = Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'truncation'));
  return withProgrammaticResult(
    { ...result, text, content: [{ type: 'text', text }], details: rest },
    { uncappedOutput: true },
  );
}

/**
 * The same rebuild {@link fullPtcBashOutput} does, from output the host already
 * holds in memory instead of Pi's file: the preview Pi kept is replaced by the
 * whole output, the status lines appended after the preview are kept, and the
 * truncation details that described the preview are dropped. Gives up over
 * PTC_CHILD_FULL_OUTPUT_MAX_BYTES, and when Pi's preview cannot be located in
 * the text, so the capped result stands rather than losing those lines.
 */
function rebuiltPtcBashOutput(result: ToolResult, full: string): ToolResult | undefined {
  const details = result.details ?? {};
  const cut = details.truncation as { truncated?: unknown; content?: unknown } | undefined;
  if (cut?.truncated !== true) {
    // Pi did not cut it: the text is already the whole output.
    const bytes = Buffer.byteLength(result.text, 'utf8');
    if (bytes > PTC_CHILD_FULL_OUTPUT_MAX_BYTES) return undefined;
    return bytes > DESKTOP_BASH_MAX_BYTES
      ? withProgrammaticResult(result, { uncappedOutput: true })
      : result;
  }
  const preview = cut.content;
  if (typeof preview !== 'string' || !result.text.startsWith(preview)) return undefined;
  if (Buffer.byteLength(full, 'utf8') > PTC_CHILD_FULL_OUTPUT_MAX_BYTES) return undefined;
  const text = `${full}${result.text.slice(preview.length)}`;
  const rest = Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'truncation'));
  return withProgrammaticResult(
    { ...result, text, content: [{ type: 'text', text }], details: rest },
    { uncappedOutput: true },
  );
}

function limitDesktopBashOutput(
  text: string,
  fullOutputPath?: string,
  details?: Record<string, unknown>,
  taskId?: string,
) {
  const output = details?.output as
    | { rawBytes?: number; persistenceError?: string; partialOutputPath?: string }
    | undefined;
  const readableOutputPath = fullOutputPath ?? output?.partialOutputPath;
  const outputLabel = fullOutputPath ? 'Full output' : 'Saved partial output';
  let previewText = text;
  if (!taskId) {
    if ((details?.truncation as { truncated?: boolean } | undefined)?.truncated) {
      previewText += `\n\n[desktop bash output truncated: original_bytes=${output?.rawBytes}; ${output?.partialOutputPath ? 'saved output' : 'original'} head+tail shown.${readableOutputPath ? ` ${outputLabel}: ${readableOutputPath}` : ''}]`;
    }
    if (output?.persistenceError) {
      previewText += `\n\n[Output persistence failed; complete output is unavailable: ${output.persistenceError}]`;
    }
  }
  const limited = limitDesktopHeadTailLines(previewText, {
    maxBytes: DESKTOP_BASH_MAX_BYTES,
    notice: ({ originalBytes }) =>
      readableOutputPath
        ? `[desktop bash output truncated: original_bytes=${originalBytes}; head+tail shown; boundary lines may be UTF-8 byte-truncated; ${outputLabel}: ${readableOutputPath}]`
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
      : readableOutputPath
        ? {
            tool: 'read',
            preserve_args: ['path'],
            instruction: `Read the ${fullOutputPath ? 'full' : 'saved partial'} output at ${readableOutputPath}; continue long reads with the returned next_offset.`,
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
 * Ordinary foreground timing of a command whose timeout was accepted for the
 * managed path, which ignores an invalid value and has no upper bound.
 */
function directForegroundTiming(
  timeout: number | undefined,
  maxSeconds: number | undefined,
): LocalBashTiming {
  const valid = timeout !== undefined && Number.isFinite(timeout) && timeout > 0;
  return resolveLocalBashTiming(
    valid ? Math.min(timeout, MAX_BASH_TIMEOUT_SECONDS) : undefined,
    'direct_foreground',
    undefined,
    maxSeconds,
  );
}

/**
 * Program deadline a PTC Bash child runs against. A foreground call whose own
 * `timeout` (seconds) is longer than the program has left asks Agent Core to
 * extend the program, which owns that rule, its margin and the one-hour cap:
 * a model that gave tools.bash a long timeout but no run_code timeout_ms
 * expects the command to get that long, not to be cut at the program's 120s.
 * Background Bash is not bounded by the program, so it never extends it. A
 * host maximum (`maxSeconds`) bounds the extension, since the command cannot
 * run longer than that anyway.
 */
function ptcBashDeadline(
  input: LocalBashToolInput,
  deadline: PtcChildDeadline,
  maxSeconds?: number,
): number {
  const requested = input.timeout;
  if (
    input.run_in_background === true ||
    requested === undefined ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return deadline.atMs;
  }
  const extendTo = maxSeconds === undefined ? requested : Math.min(requested, maxSeconds);
  return deadline.extendForTimeout?.(extendTo) ?? deadline.atMs;
}

/** States a host maximum that lowered a run_code child's foreground timeout. */
function withHostTimeoutLimit(
  result: ToolResult,
  limitSeconds: number,
  requestedSeconds: number | undefined,
): ToolResult {
  const asked =
    requestedSeconds === undefined
      ? "the program's remaining time"
      : `requested ${requestedSeconds}s`;
  const text = `${result.text}\n\n[bash timeout: ${asked}; effective ${limitSeconds}s command limit, the most this host allows for one foreground command.]`;
  return { ...result, text, content: [{ type: 'text', text }] };
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
  details: Record<string, unknown>,
  completion: CoreBashBackgroundCompletion | undefined,
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
      ? `Purpose: ${
          limitDesktopHeadTailLines(details.description, {
            maxBytes: 1024,
            notice: () => '[purpose truncated]',
          }).text
        }\n`
      : '';
  const text = `<bash_background task_id="${taskId}">\n${purpose}${lead}${timingText} ${backgroundCompletionText(completion)}\n</bash_background>`;
  return {
    tool_name: LocalBashToolDef.name,
    text,
    content: [{ type: 'text', text }],
    details: { ...details, status, task_id: taskId },
  };
}

function backgroundCompletionText(completion: CoreBashBackgroundCompletion | undefined): string {
  switch (completion) {
    case 'next_turn_reminder':
      return 'When it finishes, the next turn starts with a reminder that lists it; use task_output to inspect its output, and task_stop to stop it.';
    case 'task_output':
      return 'No reminder is sent when it finishes; use task_output to check its status and output, and task_stop to stop it.';
    default:
      return 'The owning conversation will automatically resume when it finishes; use task_output to inspect incremental output, and task_stop to cancel if that tool is available.';
  }
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
