import type { PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import { isPtcMavisChildToolName } from '@mavis/agent-tools';

import type { PtcExecutionResult } from '../../execution/ptc/contracts.js';

/**
 * Turn-level PTC state logs and remote metrics. Each log line and its metric
 * come from the same place with the same enums, so the two never disagree.
 * Everything here only observes: it never changes what the model sees, which
 * tools a Turn has, or what a tool returns, and a throwing logger or metrics
 * client is swallowed. Metrics carry counts, durations and enums only; the
 * only Turns that report are Turns of PTC-mode Sessions (admission, in
 * runner/policy/ptc-admission-observability.ts) and PTC Turns.
 */

export type PtcLogger = Pick<PiTurnRunnerLogger, 'info'>;
/**
 * The two MetricsClient methods PTC calls, spelled out so runner/ptc and
 * execution/ need no @mavis/shared import; the real MetricsClient fits as is.
 */
export interface PtcMetrics {
  counter(name: string, value: number, labels?: Record<string, string>): void;
  histogram(name: string, value: number, labels?: Record<string, string>): void;
}

/**
 * Product surface of the Turn. TUI exec reads `tui`: its entry point is known
 * only to the host process, below which nothing carries it.
 */
export type PtcSurface = 'desktop' | 'tui' | 'other';

export type PtcChildCallStatus =
  | 'ok'
  | 'error'
  | 'denied'
  | 'limit_exceeded'
  | 'cancelled'
  | 'blocked';

/**
 * Classifies one settled child from its guest-facing result; never reads payloads.
 * `aborted` means the child settled after its Turn was cancelled or its program
 * was stopped. A child cut off mid-run then reports whatever its tool threw
 * (a killed Bash gives PTC_TOOL_EXECUTION_FAILED), so without this the user's
 * own stop would show up as a failing tool. A denial and the batch deadline
 * keep their own status. `blocked` is a child a host guard refused before it
 * ran (PTC_TOOL_BLOCKED, e.g. BROWSER_PTC_STOPPED or COMPUTER_USE_PTC_STOPPED
 * after an earlier call of the program failed); counting it as `error` would
 * report a tool failure for a call that never executed.
 */
export function ptcChildCallStatus(
  result: {
    readonly isError?: boolean;
    readonly error?: { readonly code: string };
  },
  aborted = false,
): PtcChildCallStatus {
  if (result.isError !== true) return 'ok';
  switch (result.error?.code) {
    case 'PTC_PERMISSION_DENIED':
      return 'denied';
    case 'PTC_CANCELLED':
    case 'PTC_ABORTED':
      return 'cancelled';
    case 'PTC_BATCH_EXPIRED':
      return 'limit_exceeded';
    case 'PTC_TOOL_BLOCKED':
      return 'blocked';
    default:
      return aborted ? 'cancelled' : 'error';
  }
}

interface PtcProgramOutcome {
  readonly status: 'ok' | 'error';
  /** `none` for a completed program, otherwise the program's own error code. */
  readonly errorCode: string;
  readonly durationMs: number;
  readonly childCalls: number;
}

/** A finished program as the Turn observer counts it. */
export function ptcProgramOutcome(
  result: PtcExecutionResult,
  durationMs: number,
): PtcProgramOutcome {
  const completed = result.status === 'completed';
  return {
    status: completed ? 'ok' : 'error',
    errorCode: completed ? 'none' : result.error.code,
    durationMs,
    childCalls: result.details.child_calls.length,
  };
}

/** A run_code call refused before any program ran (no Worker, no children). */
export function ptcRejectedProgram(errorCode: string): PtcProgramOutcome {
  return { status: 'error', errorCode, durationMs: 0, childCalls: 0 };
}

/** Program failure codes of the QuickJS executor (`PtcFailureCode`), reported as is. */
const PROGRAM_ERROR_LABELS: ReadonlySet<string> = new Set([
  'guest_error',
  'wall_clock_exceeded',
  'compute_budget_exceeded',
  'cancelled',
  'worker_error',
  'worker_exit',
  'invalid_code',
  'invalid_tool_call',
  'invalid_tool_result',
  'bridge_limit_exceeded',
  'tool_call_limit_exceeded',
  'tool_result_delivery_failed',
  'guest_finished_with_pending_calls',
]);

/** run_code admission refusals (no program ran). */
const REJECTION_LABELS: Readonly<Record<string, string>> = {
  PTC_UNAVAILABLE: 'unavailable',
  PTC_PREVIOUS_CALL_PENDING: 'previous_call_pending',
  PTC_BATCH_EXPIRED: 'batch_expired',
};

/** Bounded `error_code` label: known codes as is, anything new as `other`. */
function programErrorLabel(code: string): string {
  if (code === 'none' || PROGRAM_ERROR_LABELS.has(code)) return code;
  return REJECTION_LABELS[code] ?? 'other';
}

/** Built-in tools whose names are reported as the metric `tool` label. */
const BUILTIN_TOOL_LABELS: ReadonlySet<string> = new Set([
  'read',
  'write',
  'edit',
  'delete',
  'bash',
  'grep',
  'glob',
  'todowrite',
  'web_fetch',
  'web_search',
  'task',
  'task_append',
  'task_query',
  'task_output',
  'task_stop',
  'mcp_invoke',
  'mavis',
  'self_reminder',
  'workspace_semantic_search',
]);

type PtcToolLabeler = (toolName: string) => string;

/**
 * Metric `tool` label for this Turn: listed built-ins by name, the Turn's MCP
 * and App tools (from their capability bindings, or the `mcp__` prefix) as
 * `mcp` / `app`, Browser (`browser`, `mcp_browser`) as `browser`, every
 * `computer_*` action as `computer_use`, the mavis_* run_code tools as `mavis`
 * (each is one mavis command, the same tool as the top-level mavis),
 * everything else as `other`. MCP and App tool names, Computer Use actions
 * and mavis commands never reach a label, which also keeps the label set small.
 */
export function createPtcToolLabeler(
  bindings: readonly {
    readonly kind: string;
    readonly tool: { readonly def: { readonly name: string } };
  }[] = [],
): PtcToolLabeler {
  const kindByName = new Map(bindings.map((binding) => [binding.tool.def.name, binding.kind]));
  return (toolName) => {
    const kind = kindByName.get(toolName);
    if (kind === 'app') return 'app';
    if (kind === 'mcp' || toolName.startsWith('mcp__')) return 'mcp';
    if (toolName === 'browser' || toolName === 'mcp_browser') return 'browser';
    if (toolName.startsWith('computer_')) return 'computer_use';
    if (isPtcMavisChildToolName(toolName)) return 'mavis';
    return BUILTIN_TOOL_LABELS.has(toolName) ? toolName : 'other';
  };
}

export interface PtcTurnObserver {
  programFinished(outcome: PtcProgramOutcome): void;
  childCallSettled(toolName: string, status: PtcChildCallStatus): void;
  directCallResolved(toolCallId: string, valid: boolean): void;
  directCallSettled(toolName: string, toolCallId: string, appended: boolean): void;
  /** Idempotent; the runner calls it once the Turn's model loop ended. */
  finishTurn(): void;
}

/**
 * Per-Turn accumulator behind `ptc turn summary`, created only on PTC Turns.
 * The per-program line answers "what did this program do"; the summary
 * answers "how did PTC go for this Turn" (programs, failures, denied
 * children, direct calls of hidden tools) without adding up lines by hand.
 * The same calls report the per-program, per-child and per-direct-call
 * metrics, so local lines and remote counts follow one definition.
 */
export function createPtcTurnObserver(options: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly logger?: PtcLogger;
  readonly metricsClient?: PtcMetrics;
  readonly surface?: PtcSurface;
  readonly labelTool?: PtcToolLabeler;
}): PtcTurnObserver {
  const metrics = options.metricsClient;
  const surface = options.surface ?? 'other';
  const labelTool = options.labelTool ?? createPtcToolLabeler();
  const summary = {
    programs: 0,
    programs_failed: 0,
    child_calls: 0,
    child_failures: 0,
    child_denied: 0,
    direct_calls: 0,
    direct_sr_appended: 0,
    wall_clock_exceeded: 0,
    program_ms_total: 0,
  };
  const directCallValid = new Map<string, boolean>();
  let finished = false;
  return {
    programFinished(outcome) {
      const durationMs = nonNegativeMs(outcome.durationMs);
      summary.programs += 1;
      if (outcome.status !== 'ok') summary.programs_failed += 1;
      if (outcome.errorCode === 'wall_clock_exceeded') summary.wall_clock_exceeded += 1;
      summary.child_calls += outcome.childCalls;
      summary.program_ms_total += durationMs;
      // Failure rate and causes, run time and children per program.
      report(() => {
        const status = outcome.status;
        const error_code = programErrorLabel(outcome.errorCode);
        metrics?.counter('ptc_run_code_total', 1, { status, error_code, surface });
        metrics?.histogram('ptc_run_code_duration_ms', durationMs, { status });
        metrics?.histogram('ptc_run_code_child_calls', outcome.childCalls, { status });
      });
    },
    childCallSettled(toolName, status) {
      if (status !== 'ok') summary.child_failures += 1;
      if (status === 'denied') summary.child_denied += 1;
      // Which tools programs use most and which fail.
      report(() =>
        metrics?.counter('ptc_child_call_total', 1, { tool: labelTool(toolName), status }),
      );
    },
    directCallResolved(toolCallId, valid) {
      summary.direct_calls += 1;
      directCallValid.set(toolCallId, valid);
    },
    directCallSettled(toolName, toolCallId, appended) {
      if (appended) summary.direct_sr_appended += 1;
      const valid = directCallValid.get(toolCallId) !== false;
      directCallValid.delete(toolCallId);
      // How often the model still calls hidden tools directly, and the reminder it gets.
      report(() =>
        metrics?.counter('ptc_direct_call_total', 1, {
          tool: labelTool(toolName),
          sr: appended ? 'appended' : 'not_appended',
          validation: valid ? 'ok' : 'failed',
        }),
      );
    },
    finishTurn() {
      if (finished) return;
      finished = true;
      writeLog(options.logger, 'ptc turn summary', {
        session_id: options.sessionId,
        turn_id: options.turnId,
        ...summary,
      });
      // Programs per PTC Turn, including Turns that never wrote one.
      report(() => metrics?.histogram('ptc_turn_programs', summary.programs, { surface }));
    },
  };
}

interface PtcProgramTiming {
  /** The guest asked for the child; it may still wait for a scheduler slot. */
  queued(requestId: string): void;
  /** Runs the child once the scheduler started it; behaves exactly like `task()`. */
  run<T>(requestId: string, task: () => Promise<T>): Promise<T>;
  fields(): {
    readonly child_ms_max: number;
    readonly child_ms_total: number;
    readonly queue_wait_ms_max: number;
    readonly max_concurrency: number;
  };
}

/**
 * Aggregate child timing for the `ptc run_code finished` line, so a slow
 * program can be split into "one slow child", "children waiting for a slot"
 * or "little parallelism" without one log line per child.
 */
export function createPtcProgramTiming(now: () => number = Date.now): PtcProgramTiming {
  const queuedAt = new Map<string, number>();
  let inFlight = 0;
  let maxConcurrency = 0;
  let childMsMax = 0;
  let childMsTotal = 0;
  let queueWaitMsMax = 0;
  return {
    queued(requestId) {
      queuedAt.set(requestId, now());
    },
    async run(requestId, task) {
      const startedAt = now();
      const enqueuedAt = queuedAt.get(requestId);
      queuedAt.delete(requestId);
      if (enqueuedAt !== undefined)
        queueWaitMsMax = Math.max(queueWaitMsMax, nonNegativeMs(startedAt - enqueuedAt));
      inFlight += 1;
      maxConcurrency = Math.max(maxConcurrency, inFlight);
      try {
        return await task();
      } finally {
        inFlight -= 1;
        const childMs = nonNegativeMs(now() - startedAt);
        childMsMax = Math.max(childMsMax, childMs);
        childMsTotal += childMs;
      }
    },
    fields() {
      return {
        child_ms_max: childMsMax,
        child_ms_total: childMsTotal,
        queue_wait_ms_max: queueWaitMsMax,
        max_concurrency: maxConcurrency,
      };
    },
  };
}

type PtcChildPermissionDecision = 'allow' | 'deny';

/**
 * Maps one final `permission.enforcement` decision to the user-facing outcome.
 * Policy and Plugin auto-approvals asked nobody and are skipped. Every
 * blocked child is `deny`: a user denial, a Mini App denial and a policy
 * block all fail only that child, and the program keeps running.
 */
function ptcChildPermissionDecision(
  fields: Readonly<Record<string, unknown>>,
): PtcChildPermissionDecision | undefined {
  if (fields.gate_result === 'proceed')
    return fields.decision_source === 'user_reply' ? 'allow' : undefined;
  if (fields.gate_result !== 'blocked') return undefined;
  return 'deny';
}

/**
 * `ptc child permission` and `ptc_child_permission_total`: which child asked
 * and what the user (or policy) decided. Only run_code children carry
 * `parentToolCallId`, so ordinary Turns never reach either write.
 */
export function observePtcChildPermission(
  sinks: { readonly logger?: PtcLogger; readonly metricsClient?: Pick<PtcMetrics, 'counter'> },
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolContext?: { readonly parentToolCallId?: string };
    readonly signal?: AbortSignal;
  },
  request: { readonly toolCallId: string; readonly toolName: string },
  fields: Readonly<Record<string, unknown>>,
): void {
  try {
    const parentToolCallId = input.toolContext?.parentToolCallId;
    if (!parentToolCallId) return;
    // A pending ask closed by a cancelled Turn or program was never answered.
    if (fields.decision_source === 'approval_or_abort' && input.signal?.aborted === true) return;
    const decision = ptcChildPermissionDecision(fields);
    if (!decision) return;
    writeLog(sinks.logger, 'ptc child permission', {
      session_id: input.sessionId,
      turn_id: input.turnId,
      tool: request.toolName,
      decision,
      decision_source: fields.decision_source,
      tool_call_id: request.toolCallId,
      parent_tool_call_id: parentToolCallId,
    });
    report(() => sinks.metricsClient?.counter('ptc_child_permission_total', 1, { decision }));
  } catch {
    // Diagnostics must not change the permission decision.
  }
}

export function writeLog(
  logger: PtcLogger | undefined,
  message: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  try {
    logger?.info?.(fields, message);
  } catch {
    // Diagnostics must not affect the Turn.
  }
}

/** Metrics must not change or mask the product-path outcome. */
export function report(write: () => void): void {
  try {
    write();
  } catch {
    // Same contract as the runner's other metrics.
  }
}

function nonNegativeMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
