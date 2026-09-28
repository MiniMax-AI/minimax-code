import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import { requireTaskConversation } from '../api/local-task-host.js';
import { logger } from '../common/logger.js';
import { isLocalChildWorkerSession } from '../sessions/session-policy.js';
import { isTerminalTaskStatus, type BackgroundTask } from './domain.js';
import { startConversationBackgroundTaskDeliveryTurn } from './conversation-delivery.js';
import { createDeliveryTaskPreview, selectDeliveryBatch } from './delivery-batch.js';
import { isTaskDeliverySuppressed, isUserStopWindowOpen } from './user-stop-suppression.js';

const DELIVERY_RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const;
const DELIVERY_BURST_WINDOW_MS = 60_000;
const DELIVERY_RECOVERY_INITIAL_MS = 60_000;
const DELIVERY_RECOVERY_MAX_MS = 300_000;
const MAX_DELIVERY_TURNS_PER_WINDOW = 3;
const MAX_DELIVERY_BURST_SESSIONS = 2_048;
const MAX_ACKNOWLEDGED_TASKS = 2_048;
const deliverySchedulers = new WeakMap<
  LocalTaskRunnerHostWithSessionLookup,
  LocalBackgroundTaskDeliveryScheduler
>();
const deliveryBursts = new WeakMap<
  LocalTaskRunnerHostWithSessionLookup,
  Map<string, { windowStartedAt: number; delivered: number }>
>();

export type LocalBackgroundTaskDeliveryResult =
  | 'delivered'
  | 'busy'
  | 'failed'
  | 'skipped'
  | 'deferred';

const closedHosts = new WeakSet<LocalTaskRunnerHostWithSessionLookup>();

export function closeLocalBackgroundTaskDelivery(host: LocalTaskRunnerHostWithSessionLookup): void {
  closedHosts.add(host);
  deliverySchedulers.get(host)?.close();
}

export function scheduleLocalBackgroundTaskDelivery(
  host: LocalTaskRunnerHostWithSessionLookup,
  taskId: string,
): void {
  if (closedHosts.has(host)) return;
  let scheduler = deliverySchedulers.get(host);
  if (!scheduler) {
    scheduler = new LocalBackgroundTaskDeliveryScheduler(host);
    deliverySchedulers.set(host, scheduler);
  }
  scheduler.schedule(taskId);
}

/** Deliver a completed task through the V2 Conversation ingress only. */
export async function startLocalBackgroundTaskDeliveryTurn(
  host: LocalTaskRunnerHostWithSessionLookup,
  taskId: string,
): Promise<LocalBackgroundTaskDeliveryResult> {
  const task = await host.backgroundTaskService.get(taskId);
  if (!shouldDeliverTask(task)) return 'skipped';
  return deliverBatch(host, task.ownerSessionId, [createDeliveryTaskPreview(task)], [taskId]);
}

async function deliverBatch(
  host: LocalTaskRunnerHostWithSessionLookup,
  ownerSessionId: string,
  previews: readonly BackgroundTask[],
  taskIds: readonly string[],
): Promise<LocalBackgroundTaskDeliveryResult> {
  const session = await host.getSessionById(ownerSessionId);
  if (closedHosts.has(host) || !session || isLocalChildWorkerSession(session)) return 'skipped';
  // Gate 1 (Session): a user stop for this Session is still collecting its target
  // tasks, so we cannot yet tell targets from unrelated new work. Hold the whole
  // batch as `busy` — which the scheduler retries (1s/2s/5s, then cooldown) — and
  // NOT `skipped`, which is dequeued without a reschedule and would permanently
  // lose the completion notice of a new task that happened to finish in the window.
  if (isUserStopWindowOpen(host, ownerSessionId)) {
    recordDeliverySuppressed(host, 'user_stop_window');
    logDeliverySuppressed(host, ownerSessionId, taskIds, 'user_stop_window');
    return 'busy';
  }
  const reservation = reserveDeliveryTurn(host, ownerSessionId);
  if (!reservation) {
    try {
      host.metricsClient?.counter('background_task_delivery_suppressed_total', 1, {
        reason: 'session_burst_limit',
      });
    } catch {
      // Telemetry must not turn a deliberate suppression into a retry storm.
    }
    return 'deferred';
  }
  let delivered = false;
  try {
    const snapshot = await host.backgroundTaskService.reminderSnapshot(ownerSessionId);
    // Re-read after snapshot lookup: a committed task_output may have consumed a result meanwhile.
    const candidates = await Promise.all(
      taskIds.map((taskId) => host.backgroundTaskService.get(taskId)),
    );
    // Gate 2 (task): a task the user stopped never wakes this Session again, for
    // the life of the process. This is the primary "no wake-up" guarantee and does
    // not depend on the cascade finishing: it also covers a stop that timed out and
    // finished much later, and retries/cooldown batches scheduled before the stop.
    // Suppressed terminals stay undelivered, so the next turn's background reminder
    // still reports them — no information is lost.
    const suppressedIds = taskIds.filter((taskId) => isTaskDeliverySuppressed(host, taskId));
    if (suppressedIds.length > 0) {
      recordDeliverySuppressed(host, 'user_stop_target', suppressedIds.length);
      logDeliverySuppressed(host, ownerSessionId, suppressedIds, 'user_stop_target');
    }
    const unreadIds = new Set(
      candidates
        .filter(
          (task): task is BackgroundTask =>
            shouldDeliverTask(task) &&
            task.ownerSessionId === ownerSessionId &&
            !isTaskDeliverySuppressed(host, task.taskId),
        )
        .map((task) => task.taskId),
    );
    const tasks = previews.filter((task) => unreadIds.has(task.taskId));
    // Every candidate was suppressed or already consumed: nothing to say, and a
    // retry would say the same thing, so `skipped` (no reschedule) is correct.
    if (closedHosts.has(host) || tasks.length === 0) return 'skipped';
    // Gate 1 again, after every await above. A stop that begins while this batch
    // was reading the snapshot or re-reading its tasks opened the window after the
    // first check, and its targets may not be registered yet — e.g. the Turn had
    // ended and only background work remained, which is exactly what a user stop
    // is for. Known bound: the few synchronous steps between this check and the
    // ingress accepting the steer are not covered; that gap is sub-millisecond.
    if (isUserStopWindowOpen(host, ownerSessionId)) {
      recordDeliverySuppressed(host, 'user_stop_window_recheck');
      logDeliverySuppressed(host, ownerSessionId, taskIds, 'user_stop_window_recheck');
      return 'busy';
    }
    const result = await startConversationBackgroundTaskDeliveryTurn({
      host,
      conversation: requireTaskConversation(host),
      ownerSessionId,
      tasks,
      // `batchTaskIds` only forms the retry-stable idempotency key; the message's
      // `origin.taskIds` is built from `tasks`, so suppressed siblings are never
      // named to the model even though they still key this batch.
      batchTaskIds: taskIds,
      observedTerminalCount: snapshot.terminalTotal,
    });
    delivered = result === 'delivered';
    return result;
  } finally {
    // Release the reserved window itself, even if the lookup crossed into a newer window.
    if (!delivered) reservation.delivered = Math.max(0, reservation.delivered - 1);
  }
}

/** Why a batch was held back after a user stop; also the metric/log `reason` label. */
type DeliverySuppressionReason =
  | 'user_stop_window'
  | 'user_stop_window_recheck'
  | 'user_stop_target';

function recordDeliverySuppressed(
  host: LocalTaskRunnerHostWithSessionLookup,
  reason: DeliverySuppressionReason,
  count = 1,
): void {
  try {
    host.metricsClient?.counter('background_task_delivery_suppressed_total', count, { reason });
  } catch {
    // Telemetry must not turn a deliberate suppression into a retry storm.
  }
}

function logDeliverySuppressed(
  host: LocalTaskRunnerHostWithSessionLookup,
  ownerSessionId: string,
  taskIds: readonly string[],
  reason: DeliverySuppressionReason,
): void {
  try {
    logger.info(
      {
        event: 'background_task_delivery_suppressed',
        sessionId: ownerSessionId,
        taskIds: [...taskIds],
        reason,
      },
      'Suppressed local background task delivery after a user stop',
    );
  } catch {
    // Diagnostics must not change the delivery result or abandon retries.
  }
}

interface DeliveryBatch {
  readonly taskIds: readonly string[];
  readonly previews: readonly BackgroundTask[];
  attempts: number;
  recoveryDelayMs?: number;
  retryAtMs?: number;
}

interface SessionDelivery {
  readonly pending: Map<string, BackgroundTask>;
  readonly queued: Set<string>;
  readonly cooling: DeliveryBatch[];
  batch?: DeliveryBatch;
  timer?: ReturnType<typeof setTimeout>;
  timerAtMs?: number;
  inFlight: boolean;
}

class LocalBackgroundTaskDeliveryScheduler {
  private readonly sessions = new Map<string, SessionDelivery>();
  private readonly lookups = new Set<string>();
  private readonly acknowledged = new Set<string>();
  private readonly lookupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly host: LocalTaskRunnerHostWithSessionLookup) {}

  close(): void {
    for (const state of this.sessions.values()) if (state.timer) clearTimeout(state.timer);
    for (const timer of this.lookupTimers.values()) clearTimeout(timer);
    this.sessions.clear();
    this.lookupTimers.clear();
    this.acknowledged.clear();
  }

  schedule(taskId: string): void {
    if (
      closedHosts.has(this.host) ||
      this.acknowledged.has(taskId) ||
      this.lookups.has(taskId) ||
      this.lookupTimers.has(taskId)
    )
      return;
    void this.enqueue(taskId, 0);
  }

  private async enqueue(taskId: string, attempts: number, recoveryDelayMs?: number): Promise<void> {
    this.lookups.add(taskId);
    try {
      const task = await this.host.backgroundTaskService.get(taskId);
      if (closedHosts.has(this.host) || this.acknowledged.has(taskId) || !shouldDeliverTask(task))
        return;
      const preview = createDeliveryTaskPreview(task);
      let state = this.sessions.get(task.ownerSessionId);
      if (!state) {
        state = { pending: new Map(), queued: new Set(), cooling: [], inFlight: false };
        this.sessions.set(task.ownerSessionId, state);
      }
      if (state.queued.has(taskId)) return;
      state.queued.add(taskId);
      state.pending.set(taskId, preview);
      // Lookup retries never consume the independent transport budget of this or another task.
      if (!state.inFlight && !state.batch) this.scheduleNext(task.ownerSessionId, state);
    } catch (error) {
      this.warn(taskId, error);
      const fastDelayMs = DELIVERY_RETRY_DELAYS_MS[attempts];
      const delayMs = fastDelayMs ?? nextRecoveryDelayMs(recoveryDelayMs);
      if (!closedHosts.has(this.host)) {
        const timer = setTimeout(() => {
          this.lookupTimers.delete(taskId);
          void this.enqueue(
            taskId,
            Math.min(attempts + 1, DELIVERY_RETRY_DELAYS_MS.length),
            fastDelayMs === undefined ? delayMs : undefined,
          );
        }, delayMs);
        timer.unref?.();
        this.lookupTimers.set(taskId, timer);
      }
    } finally {
      this.lookups.delete(taskId);
    }
  }

  private async run(ownerSessionId: string, state: SessionDelivery): Promise<void> {
    if (closedHosts.has(this.host) || state.inFlight) return;
    const batch = state.batch ?? this.takeNextBatch(state);
    if (!batch) {
      this.scheduleNext(ownerSessionId, state);
      return;
    }
    state.inFlight = true;
    state.batch = batch;
    try {
      let result: LocalBackgroundTaskDeliveryResult;
      try {
        result = await deliverBatch(this.host, ownerSessionId, batch.previews, batch.taskIds);
      } catch (error) {
        this.warn(ownerSessionId, error);
        result = 'failed';
      }
      if (result === 'deferred') {
        // Only an unattempted batch can safely grow: a previous transport failure may hide an ACK.
        if (batch.attempts === 0) {
          const pending = [...state.pending];
          state.pending.clear();
          for (const preview of batch.previews) state.pending.set(preview.taskId, preview);
          for (const [taskId, preview] of pending) state.pending.set(taskId, preview);
          state.batch = undefined;
        }
        this.defer(ownerSessionId, state, remainingDeliveryWindowMs(this.host, ownerSessionId));
        return;
      }
      if (result === 'failed' || result === 'busy') {
        const delayMs = DELIVERY_RETRY_DELAYS_MS[batch.attempts];
        if (delayMs !== undefined) {
          batch.attempts += 1;
          this.defer(ownerSessionId, state, delayMs);
          return;
        }
        // Keep the exact attempted batch/key, but give fresh work a chance before recovery.
        batch.recoveryDelayMs = nextRecoveryDelayMs(batch.recoveryDelayMs);
        batch.retryAtMs = Date.now() + batch.recoveryDelayMs;
        state.cooling.push(batch);
        state.batch = undefined;
        this.scheduleNext(ownerSessionId, state);
        return;
      }
      for (const taskId of batch.taskIds) state.queued.delete(taskId);
      if (result === 'delivered' && !closedHosts.has(this.host)) {
        for (const taskId of batch.taskIds) {
          this.acknowledged.add(taskId);
          if (this.acknowledged.size > MAX_ACKNOWLEDGED_TASKS) {
            const oldest = this.acknowledged.values().next().value;
            if (oldest !== undefined) this.acknowledged.delete(oldest);
          }
        }
      }
      state.batch = undefined;
      this.scheduleNext(ownerSessionId, state);
    } finally {
      state.inFlight = false;
    }
  }

  private takeNextBatch(state: SessionDelivery): DeliveryBatch | undefined {
    const due = state.cooling.findIndex((batch) => (batch.retryAtMs ?? 0) <= Date.now());
    if (due >= 0) return state.cooling.splice(due, 1)[0];
    if (state.pending.size === 0) return undefined;
    const previews = selectDeliveryBatch(state.pending);
    const taskIds = previews.map((task) => task.taskId);
    for (const taskId of taskIds) state.pending.delete(taskId);
    return { taskIds, previews, attempts: 0 };
  }

  private scheduleNext(ownerSessionId: string, state: SessionDelivery): void {
    if (state.pending.size > 0) {
      this.defer(ownerSessionId, state, 0);
    } else if (state.cooling.length > 0) {
      const next = state.cooling.reduce(
        (earliest, batch) => Math.min(earliest, batch.retryAtMs ?? Date.now()),
        Number.POSITIVE_INFINITY,
      );
      this.defer(ownerSessionId, state, Math.max(0, next - Date.now()));
    } else {
      this.sessions.delete(ownerSessionId);
    }
  }

  private defer(ownerSessionId: string, state: SessionDelivery, delayMs: number): void {
    if (closedHosts.has(this.host)) return;
    const timerAtMs = Date.now() + delayMs;
    if (state.timer && state.timerAtMs !== undefined && state.timerAtMs <= timerAtMs) return;
    if (state.timer) clearTimeout(state.timer);
    state.timerAtMs = timerAtMs;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.timerAtMs = undefined;
      void this.run(ownerSessionId, state);
    }, delayMs);
    state.timer.unref?.();
  }

  private warn(identity: string, error: unknown): void {
    const noticeIdentity = identity.length <= 160 ? identity : `${identity.slice(0, 160)}…`;
    try {
      this.host.matrixLogger?.warn(
        { sessionId: 'local-background-task-delivery', turnId: noticeIdentity },
        `Local background task delivery failed for ${noticeIdentity}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } catch {
      // Diagnostic sinks cannot abandon an accepted notification or its bounded retries.
    }
  }
}

function nextRecoveryDelayMs(previousMs: number | undefined): number {
  return Math.min(
    previousMs === undefined ? DELIVERY_RECOVERY_INITIAL_MS : previousMs * 2,
    DELIVERY_RECOVERY_MAX_MS,
  );
}

function remainingDeliveryWindowMs(
  host: LocalTaskRunnerHostWithSessionLookup,
  ownerSessionId: string,
): number {
  const burst = deliveryBursts.get(host)?.get(ownerSessionId);
  const remainingMs =
    burst && burst.delivered >= MAX_DELIVERY_TURNS_PER_WINDOW
      ? Math.max(0, burst.windowStartedAt + DELIVERY_BURST_WINDOW_MS - host.nowMs())
      : 0;
  return remainingMs + 1 + Math.floor(Math.random() * 100);
}

function shouldDeliverTask(task: BackgroundTask | undefined): task is BackgroundTask {
  return !!task && isTerminalTaskStatus(task.status) && task.deliveredAt === undefined;
}

function reserveDeliveryTurn(
  host: LocalTaskRunnerHostWithSessionLookup,
  ownerSessionId: string,
): { windowStartedAt: number; delivered: number } | undefined {
  const burst = getDeliveryBurst(host, ownerSessionId);
  if (burst.delivered >= MAX_DELIVERY_TURNS_PER_WINDOW) return undefined;
  burst.delivered += 1;
  return burst;
}

function getDeliveryBurst(
  host: LocalTaskRunnerHostWithSessionLookup,
  ownerSessionId: string,
): { windowStartedAt: number; delivered: number } {
  let bySession = deliveryBursts.get(host);
  if (!bySession) {
    bySession = new Map();
    deliveryBursts.set(host, bySession);
  }
  const now = host.nowMs();
  const existing = bySession.get(ownerSessionId);
  if (existing && now - existing.windowStartedAt < DELIVERY_BURST_WINDOW_MS) {
    bySession.delete(ownerSessionId);
    bySession.set(ownerSessionId, existing);
    return existing;
  }
  const fresh = { windowStartedAt: now, delivered: 0 };
  bySession.set(ownerSessionId, fresh);
  if (bySession.size > MAX_DELIVERY_BURST_SESSIONS) {
    const oldest = bySession.keys().next().value;
    if (oldest !== undefined) bySession.delete(oldest);
  }
  return fresh;
}
