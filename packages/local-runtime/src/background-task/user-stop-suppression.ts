import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import { logger } from '../common/logger.js';

/**
 * Process-local delivery suppression for the user-stop cascade.
 *
 * Deliberately in-memory only (zero schema change): a stop is a live user
 * action, and everything it suppresses is either already terminal-but-undelivered
 * (the next turn's background reminder reports it) or still running in THIS
 * process. After a crash both are gone, and delivery is only ever scheduled at
 * the moment a task turns terminal, so nothing is re-delivered on startup —
 * restart behaviour is exactly today's.
 *
 * Two independent gates, because they answer different questions:
 *  - session window: "a stop for this Session is mid-flight, we do not yet know
 *    which tasks it owns" → hold the whole batch, retryable;
 *  - target set: "this exact task was stopped by the user" → never deliver.
 */

/**
 * Upper bound on remembered targets. Sized well above any plausible number of
 * stopped tasks in one process lifetime; eviction is logged because an evicted
 * target could regain the ability to wake its Session.
 */
const MAX_SUPPRESSED_TASK_IDS = 4_096;

/**
 * Last-resort bound on how long any single window may stay open. A window that
 * never closes would hold every later completion notice of the Session as `busy`
 * for the life of the process — strictly worse than having no cascade at all.
 * Normal paths always close well before this: the abort waits at most 5s
 * (DEFAULT_ABORT_TIMEOUT_MS) and the cascade at most 15s (CASCADE_TIMEOUT_MS),
 * so 60s leaves ample margin and only ever fires for a path we did not foresee.
 */
const USER_STOP_WINDOW_WATCHDOG_MS = 60_000;

/** Why a window handle was closed; recorded in the close log. */
export type UserStopWindowCloseReason = 'completed' | 'cancelled' | 'watchdog';

export interface UserStopWindowHandle {
  registerTargets(taskIds: Iterable<string>): void;
  /** Idempotent; only releases this handle's own hold on the Session window. */
  close(reason?: UserStopWindowCloseReason): void;
}

interface HostSuppressionState {
  /**
   * Open window holds per Session. Keyed per handle rather than per Session:
   * two stops of the same Session can overlap (double click, desktop + TUI), and
   * with a single key the first `close` would drop the second stop's window —
   * or, in the opposite order, a handle nobody closes would pin it open forever.
   * The window is open exactly while at least one handle is still held.
   */
  readonly openSessions: Map<string, Set<symbol>>;
  /** Targets of a completed-or-failed cascade; never delivered in this process. */
  readonly suppressedTaskIds: Set<string>;
  /** Tail of each Session's serial cascade queue (see `runSerializedUserStop`). */
  readonly inFlight: Map<string, Promise<void>>;
}

const hostStates = new WeakMap<LocalTaskRunnerHostWithSessionLookup, HostSuppressionState>();

function getState(host: LocalTaskRunnerHostWithSessionLookup): HostSuppressionState {
  let state = hostStates.get(host);
  if (!state) {
    state = { openSessions: new Map(), suppressedTaskIds: new Set(), inFlight: new Map() };
    hostStates.set(host, state);
  }
  return state;
}

/**
 * Opens (adds a hold on) the Session suppression window. Every handle MUST be
 * closed: callers close it in a `finally`, and a watchdog closes it anyway if an
 * unforeseen path forgets to, so the worst case degrades to today's behaviour.
 */
export function openUserStopWindow(
  host: LocalTaskRunnerHostWithSessionLookup,
  sessionId: string,
  nowMs: number,
): UserStopWindowHandle {
  const state = getState(host);
  const token = Symbol(sessionId);
  let holds = state.openSessions.get(sessionId);
  if (!holds) {
    holds = new Set();
    state.openSessions.set(sessionId, holds);
  }
  holds.add(token);
  const openedAtWallMs = Date.now();
  let closed = false;

  const close = (reason: UserStopWindowCloseReason = 'completed'): void => {
    if (closed) return;
    closed = true;
    clearTimeout(watchdog);
    const current = state.openSessions.get(sessionId);
    current?.delete(token);
    const remainingHolds = current?.size ?? 0;
    if (current && remainingHolds === 0) state.openSessions.delete(sessionId);
    logWindow(reason === 'watchdog' ? 'warn' : 'info', {
      event:
        reason === 'watchdog'
          ? 'background_task_user_stop_window_watchdog_closed'
          : 'background_task_user_stop_window_closed',
      sessionId,
      reason,
      openedAtMs: nowMs,
      openForMs: Date.now() - openedAtWallMs,
      remainingHolds,
    });
  };

  // Guards against an unforeseen path that never closes this handle.
  const watchdog = setTimeout(() => close('watchdog'), USER_STOP_WINDOW_WATCHDOG_MS);
  watchdog.unref?.();

  return {
    registerTargets: (taskIds) => {
      for (const taskId of taskIds) rememberSuppressedTask(state, taskId, sessionId);
    },
    close,
  };
}

function logWindow(level: 'info' | 'warn', fields: Record<string, unknown>): void {
  try {
    logger[level](fields, 'User stop delivery window closed');
  } catch {
    // Diagnostics must never keep a window open.
  }
}

function rememberSuppressedTask(
  state: HostSuppressionState,
  taskId: string,
  sessionId: string,
): void {
  if (state.suppressedTaskIds.has(taskId)) return;
  state.suppressedTaskIds.add(taskId);
  if (state.suppressedTaskIds.size <= MAX_SUPPRESSED_TASK_IDS) return;
  const oldest = state.suppressedTaskIds.values().next().value;
  if (oldest === undefined) return;
  state.suppressedTaskIds.delete(oldest);
  try {
    logger.warn(
      {
        event: 'background_task_stop_suppression_evicted',
        taskId: oldest,
        sessionId,
        retained: state.suppressedTaskIds.size,
      },
      'Evicted the oldest stopped-task delivery suppression entry',
    );
  } catch {
    // Diagnostics must not break an in-progress stop.
  }
}

/** True while any stop for this Session still holds the window open. */
export function isUserStopWindowOpen(
  host: LocalTaskRunnerHostWithSessionLookup,
  sessionId: string,
): boolean {
  return (getState(host).openSessions.get(sessionId)?.size ?? 0) > 0;
}

/** True when the task was stopped by a user stop and must never be delivered. */
export function isTaskDeliverySuppressed(
  host: LocalTaskRunnerHostWithSessionLookup,
  taskId: string,
): boolean {
  return getState(host).suppressedTaskIds.has(taskId);
}

/**
 * Serializes cascades per Session. A second stop never joins the first one's
 * run: it may carry a later boundary (the user sent a new message, the new Turn
 * started background work, then stopped again), and joining would silently drop
 * that boundary and leave the new work running. Instead it waits for the
 * previous cascade to settle — success OR failure — and then runs its own.
 * Re-running is idempotent: tasks the earlier cascade already stopped are
 * terminal and are only re-reported, never stopped twice.
 */
export function runSerializedUserStop(
  host: LocalTaskRunnerHostWithSessionLookup,
  sessionId: string,
  run: () => Promise<void>,
): { readonly settled: Promise<void>; readonly queued: boolean } {
  const state = getState(host);
  const previous = state.inFlight.get(sessionId);
  // A failed predecessor must not cancel this stop; its caller already logged it.
  const next = (previous ?? Promise.resolve()).catch(() => undefined).then(run);
  const tail: Promise<void> = next.finally(() => {
    if (state.inFlight.get(sessionId) === tail) state.inFlight.delete(sessionId);
  });
  state.inFlight.set(sessionId, tail);
  return { settled: tail, queued: previous !== undefined };
}

/** Test seam: drop all suppression state for a host. */
export function resetUserStopSuppressionForTests(host: LocalTaskRunnerHostWithSessionLookup): void {
  hostStates.delete(host);
}
