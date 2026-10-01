import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import { logger } from '../common/logger.js';
import {
  isTerminalTaskStatus,
  type BackgroundTask,
  type BackgroundTaskKind,
  type BackgroundTaskStatus,
} from './domain.js';
import { isBackgroundTaskAdmittedHere } from './lifecycle.js';
import {
  collectCascadeTargets,
  collectReadSubagents,
  readChildSessionId,
  readSubTurnId,
  scopeToOwnerTurn,
  type CascadeChildScope,
} from './session-cascade-targets.js';

/**
 * Session-level cascade: stop every piece of background work a Session owns.
 *
 * Invariants. The cascade is a best-effort action that
 * runs AFTER the stop response was already sent, so every failure mode must
 * degrade to "as if there were no cascade at all":
 *  - only tasks this process admitted are stopped, never another client process's;
 *  - grandchildren are stopped before their parent, so a parent's teardown cannot
 *    re-parent live work;
 *  - a task that cannot be stopped is reported as `termination_requested` rather
 *    than being written terminal behind the runner's back.
 */

export type CascadeReason = 'owner_abort' | 'owner_close';

/** Reported per target; `termination_requested` means "stop asked, not settled". */
export type StoppedTaskStatus = BackgroundTaskStatus | 'termination_requested';

export interface StoppedTaskRecord {
  readonly taskId: string;
  readonly kind: BackgroundTaskKind;
  readonly status: StoppedTaskStatus;
  readonly description?: string;
}

export interface SessionCascadeContext {
  /** Recursion guard: subagent → child Session → its own subagents. */
  readonly depth: number;
  /**
   * Sweeps already done in this cascade, keyed by Session for the root and by
   * (child Session, owning child Turn) below it. Several subagent rows can share
   * one child Session — an `append` continues its source's — and each owns a
   * disjoint slice of it, so a per-Session key would wrongly skip the second one.
   */
  readonly visited: Set<string>;
  /**
   * Sessions on the current recursion path (root first). Reaching a Session that
   * is already on the path is a genuine cycle in parent/child metadata, whatever
   * Turn scope it is reached with.
   */
  readonly path?: readonly string[];
  /** Targets collected so far, used to register delivery suppression. */
  readonly onTargets?: (taskIds: readonly string[]) => void;
}

/** Deeper nesting than this is pathological; stop descending and say so. */
const MAX_CASCADE_DEPTH = 5;
/** Per-task stop budget; a hung runner must not consume the whole cascade. */
const TASK_STOP_TIMEOUT_MS = 5_000;

export interface StopSessionBackgroundWorkInput {
  readonly host: LocalTaskRunnerHostWithSessionLookup;
  readonly sessionId: string;
  readonly reason: CascadeReason;
  /**
   * Only tasks created at or before the stop boundary are targets. Work created
   * after it can only come from the user's next message and must not be touched.
   */
  readonly boundaryMs: number;
  readonly ctx: SessionCascadeContext;
  /**
   * Set only when sweeping a subagent's child Session. A child Session is shared by
   * every row that ran in it (an `append` continues its source's), so ownership is
   * by execution, not by time: only tasks spawned by this row's own child Turn
   * (`metadata.parentTurnId === ownerTurnId`) belong to the sweep. Anything else —
   * notably work of a newer Turn that continued the same child after the stop —
   * is left untouched.
   */
  readonly childScope?: CascadeChildScope;
}

export async function stopSessionBackgroundWork(
  input: StopSessionBackgroundWorkInput,
): Promise<{ targets: StoppedTaskRecord[] }> {
  const { host, sessionId, reason, boundaryMs, ctx, childScope } = input;
  if (ctx.depth > MAX_CASCADE_DEPTH) {
    logCascade('cascade_depth_exceeded', { sessionId, depth: ctx.depth });
    return { targets: [] };
  }
  if ((ctx.path ?? []).includes(sessionId)) {
    logCascade('cascade_cycle_skipped', { sessionId, depth: ctx.depth });
    return { targets: [] };
  }
  const visitKey = childScope ? `${sessionId}\0${childScope.ownerTurnId}` : sessionId;
  if (ctx.visited.has(visitKey)) {
    logCascade('cascade_session_already_swept', {
      sessionId,
      depth: ctx.depth,
      ...(childScope ? { ownerTurnId: childScope.ownerTurnId } : {}),
    });
    return { targets: [] };
  }
  ctx.visited.add(visitKey);

  const [collectedTargets, collectedReadSubagents] = await Promise.all([
    collectCascadeTargets(host, sessionId, boundaryMs),
    collectReadSubagents(host, sessionId, boundaryMs),
  ]);
  const scopedTargets = scopeToOwnerTurn(collectedTargets, childScope);
  const scopedReadSubagents = scopeToOwnerTurn(collectedReadSubagents, childScope);
  if (childScope) {
    // One summary per child sweep; per-task lines would drown the stop in noise.
    logCascade('cascade_child_sweep_scoped', {
      childSessionId: sessionId,
      ownerTurnId: childScope.ownerTurnId,
      parentTaskId: childScope.parentTaskId,
      matched: scopedTargets.owned.length + scopedReadSubagents.owned.length,
      skippedOtherTurn: scopedTargets.skippedOtherTurn + scopedReadSubagents.skippedOtherTurn,
      skippedMissingOwner:
        scopedTargets.skippedMissingOwner + scopedReadSubagents.skippedMissingOwner,
    });
  }
  const candidates = scopedTargets.owned;
  const readSubagents = scopedReadSubagents.owned;
  // Register targets for delivery suppression BEFORE stopping anything: stopping
  // a task drives it terminal, which schedules a delivery immediately.
  ctx.onTargets?.(candidates.map((task) => task.taskId));
  if (candidates.length === 0) logCascade('cascade_no_targets', { sessionId, depth: ctx.depth });

  const records: StoppedTaskRecord[] = [];
  const settled = await Promise.allSettled(
    candidates.map((task) => stopOneTarget({ host, task, reason, ctx })),
  );
  settled.forEach((result, index) => {
    const task = candidates[index];
    if (!task) return;
    if (result.status === 'fulfilled') {
      if (result.value) records.push(result.value);
      return;
    }
    // A thrown stop is still a requested stop: the task stays suppressed and is
    // reported as unsettled rather than being silently dropped from the note.
    logCascade('cascade_stop_failed', {
      sessionId,
      taskId: task.taskId,
      kind: task.kind,
      error: errorMessage(result.reason),
    });
    records.push(describe(task, 'termination_requested'));
  });
  // Kept strictly AFTER every target has settled, as defense in depth. An `append`
  // target and the read row it continues share one child Session; with sweeps now
  // keyed and scoped per owning child Turn they no longer collide, but finishing
  // every target's stop-then-sweep first keeps this cascade's order deterministic
  // and independent of that keying.
  await traverseReadSubagents({ host, sessionId, readSubagents, reason, ctx });
  return { targets: records };
}

async function traverseReadSubagents(input: {
  readonly host: LocalTaskRunnerHostWithSessionLookup;
  readonly sessionId: string;
  readonly readSubagents: readonly BackgroundTask[];
  readonly reason: CascadeReason;
  readonly ctx: SessionCascadeContext;
}): Promise<void> {
  const { host, sessionId, readSubagents, reason, ctx } = input;
  if (readSubagents.length === 0) return;
  logCascade('cascade_traverse_read_subagents', { sessionId, count: readSubagents.length });
  // `sweepChildSession` logs and swallows its own failure, so one bad child
  // Session cannot stop the others from being swept.
  await Promise.allSettled(
    readSubagents.map((task) =>
      sweepChildSession({
        host,
        parent: task,
        childSessionId: readChildSessionId(task),
        reason,
        ctx,
      }),
    ),
  );
}

async function stopOneTarget(input: {
  readonly host: LocalTaskRunnerHostWithSessionLookup;
  readonly task: BackgroundTask;
  readonly reason: CascadeReason;
  readonly ctx: SessionCascadeContext;
}): Promise<StoppedTaskRecord | undefined> {
  const { host, task, reason, ctx } = input;
  const childSessionId = readChildSessionId(task);

  // Already terminal: nothing to stop. It is a target purely so its undelivered
  // result cannot wake the Session later.
  if (isTerminalTaskStatus(task.status)) {
    return handleTerminalTarget({
      host,
      task,
      childSessionId,
      reason,
      ctx,
      event: 'cascade_target_already_terminal',
    });
  }

  // Only this process can actually stop its own runners. `performStop` would write
  // `canceled` regardless, so stopping a row owned by another client process (shared
  // data directory) would lie about a task that keeps running there.
  if (!isBackgroundTaskAdmittedHere(host, task.taskId)) {
    // The snapshot may be stale: a runner of ours can finish after collection, and
    // its admission is dropped as soon as it settles. Both runners settle only after
    // writing the terminal row (subagent: `persistLocalSubagentTaskTerminal`; bash:
    // `settleBackgroundBashTask`), so re-reading the row separates "just finished"
    // (terminal) from "held by another process" (still active). A finished task needs
    // no stop wherever it ran, so it is handled like any terminal target; skipping it
    // would leave whatever it spawned in its child Session running after the stop.
    // Its delivery is already suppressed: `onTargets` ran before any stop.
    const current = await rereadUnadmittedTarget(host, task);
    if (current && isTerminalTaskStatus(current.status)) {
      return handleTerminalTarget({
        host,
        task: current,
        childSessionId: readChildSessionId(current) ?? childSessionId,
        reason,
        ctx,
        event: 'cascade_target_settled_before_stop',
        snapshotStatus: task.status,
      });
    }
    // Still active, or the row is gone: nothing this process can stop. A row held by
    // another process stays active on re-read, so it is skipped exactly as before.
    logCascade('cascade_skipped_not_owned', {
      sessionId: task.ownerSessionId,
      taskId: task.taskId,
      kind: task.kind,
      status: current?.status ?? 'missing',
    });
    recordCascadeMetric(host, 'cascade_skipped_not_owned');
    return undefined;
  }

  // The task itself FIRST, then its child Session. For a subagent, `performStop`
  // awaits `stopRuntime`, which aborts the child Turn; once that returns the child
  // can spawn nothing more, so the sweep that follows sees its complete output.
  // Sweeping first would race a still-running child that keeps spawning work.
  const settledStatus = await stopWithTimeout(host, task, reason);
  recordCascadeMetric(host, 'cascade_stopped');
  await sweepChildSession({ host, parent: task, childSessionId, reason, ctx });
  return describe(task, settledStatus);
}

/**
 * A target with nothing left to stop, reported with its real terminal status. A
 * finished subagent may still have left live background work in its child Session,
 * so that is swept all the same. Shared by both terminal paths so a target that
 * settled just before the ownership check is treated exactly like one the snapshot
 * already saw terminal.
 */
async function handleTerminalTarget(input: {
  readonly host: LocalTaskRunnerHostWithSessionLookup;
  /** The latest read of the row; its status is terminal. */
  readonly task: BackgroundTask;
  readonly childSessionId: string | undefined;
  readonly reason: CascadeReason;
  readonly ctx: SessionCascadeContext;
  readonly event: 'cascade_target_already_terminal' | 'cascade_target_settled_before_stop';
  /** Set when the snapshot still showed the task active, to make the race visible. */
  readonly snapshotStatus?: BackgroundTaskStatus;
}): Promise<StoppedTaskRecord> {
  const { host, task, childSessionId, reason, ctx } = input;
  logCascade(input.event, {
    sessionId: task.ownerSessionId,
    taskId: task.taskId,
    kind: task.kind,
    ...(input.snapshotStatus ? { snapshotStatus: input.snapshotStatus } : {}),
    status: task.status,
  });
  await sweepChildSession({ host, parent: task, childSessionId, reason, ctx });
  return describe(task, task.status);
}

/**
 * Fresh read of a target this process did not admit. A failed read falls back to
 * the snapshot, so the target is skipped as not owned exactly as it was before the
 * re-read existed: letting the error escape would report a task nobody asked to
 * stop as `termination_requested`.
 */
async function rereadUnadmittedTarget(
  host: LocalTaskRunnerHostWithSessionLookup,
  task: BackgroundTask,
): Promise<BackgroundTask | undefined> {
  try {
    return await host.backgroundTaskService.get(task.taskId);
  } catch (error) {
    logCascade('cascade_target_reread_failed', {
      sessionId: task.ownerSessionId,
      taskId: task.taskId,
      kind: task.kind,
      error: errorMessage(error),
    });
    return task;
  }
}

/**
 * Stops everything in a subagent's child Session. Child-Session work belongs to the
 * owner's task tree but `task_output` cannot reach it from the owner, so it is
 * stopped here yet never listed in the owner's report.
 */
async function sweepChildSession(input: {
  readonly host: LocalTaskRunnerHostWithSessionLookup;
  readonly parent: BackgroundTask;
  readonly childSessionId: string | undefined;
  readonly reason: CascadeReason;
  readonly ctx: SessionCascadeContext;
}): Promise<void> {
  const { host, parent, childSessionId, reason, ctx } = input;
  if (!childSessionId) return;
  const ownerTurnId = readSubTurnId(parent);
  if (!ownerTurnId) {
    // Without the child Turn's id this row's work cannot be told apart from the
    // work of another row sharing the child Session (an `append` continuing it),
    // so nothing is swept for it — exactly today's behaviour for this row.
    logCascade('cascade_child_sweep_skipped', {
      sessionId: parent.ownerSessionId,
      taskId: parent.taskId,
      childSessionId,
      reason: 'missing_sub_turn_id',
    });
    return;
  }
  try {
    await stopSessionBackgroundWork({
      host,
      sessionId: childSessionId,
      // Recursion stops tasks directly; it never re-enters the user-stop hook,
      // which only fires from TurnService.abort. So a child Session cannot
      // start a second Session-level cascade of its own.
      reason,
      // Ownership, not time, bounds this sweep: only what this row's own child
      // Turn spawned. That still covers work the subagent started while winding
      // down after the root boundary (it carries the same child Turn id), and it
      // never touches a newer Turn that continued the same child Session.
      boundaryMs: Number.POSITIVE_INFINITY,
      childScope: { ownerTurnId, parentTaskId: parent.taskId },
      ctx: { ...ctx, depth: ctx.depth + 1, path: [...(ctx.path ?? []), parent.ownerSessionId] },
    });
  } catch (error) {
    logCascade('cascade_child_session_failed', {
      sessionId: parent.ownerSessionId,
      taskId: parent.taskId,
      childSessionId,
      error: errorMessage(error),
    });
  }
}

async function stopWithTimeout(
  host: LocalTaskRunnerHostWithSessionLookup,
  task: BackgroundTask,
  reason: CascadeReason,
): Promise<StoppedTaskStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('cascade-stop-timeout');
  try {
    const outcome = await Promise.race([
      host.backgroundTaskService.stop(task.taskId, `session-${reason}`),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), TASK_STOP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (outcome === timedOut) {
      logCascade('cascade_stop_timeout', {
        sessionId: task.ownerSessionId,
        taskId: task.taskId,
        kind: task.kind,
        timeoutMs: TASK_STOP_TIMEOUT_MS,
      });
      return 'termination_requested';
    }
    // Re-read the row: a task that completed normally while we were stopping it is
    // `succeeded`, and reporting it as canceled would be wrong.
    const settled = (await host.backgroundTaskService.get(task.taskId)) ?? outcome;
    const status = settled?.status;
    if (status && isTerminalTaskStatus(status)) {
      logCascade('cascade_stopped', {
        sessionId: task.ownerSessionId,
        taskId: task.taskId,
        kind: task.kind,
        status,
      });
      return status;
    }
    logCascade('cascade_stop_unsettled', {
      sessionId: task.ownerSessionId,
      taskId: task.taskId,
      kind: task.kind,
      status: status ?? 'unknown',
    });
    return 'termination_requested';
  } finally {
    clearTimeout(timer);
  }
}

function describe(task: BackgroundTask, status: StoppedTaskStatus): StoppedTaskRecord {
  return {
    taskId: task.taskId,
    kind: task.kind,
    status,
    ...(task.description ? { description: task.description } : {}),
  };
}

function logCascade(event: string, fields: Record<string, unknown>): void {
  try {
    logger.info({ event: `background_task_${event}`, ...fields }, `Session stop cascade: ${event}`);
  } catch {
    // Diagnostics must never abort a cascade that is already tearing work down.
  }
}

function recordCascadeMetric(
  host: LocalTaskRunnerHostWithSessionLookup,
  reason: 'cascade_stopped' | 'cascade_skipped_not_owned',
): void {
  try {
    host.metricsClient?.counter('background_task_session_cascade_total', 1, { reason });
  } catch {
    // Telemetry cannot be allowed to fail a stop.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
