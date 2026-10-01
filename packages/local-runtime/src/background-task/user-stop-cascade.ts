import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import { logger } from '../common/logger.js';
import { isLocalChildWorkerSession } from '../sessions/session-policy.js';
import { stopSessionBackgroundWork, type StoppedTaskRecord } from './session-cascade.js';
import {
  isUserStopWindowOpen,
  openUserStopWindow,
  runSerializedUserStop,
  type UserStopWindowHandle,
} from './user-stop-suppression.js';

/**
 * User-stop cascade orchestration.
 *
 * `begin` runs synchronously inside the stop request, before the Turn abort:
 * it decides whether this stop cascades at all and opens the delivery suppression
 * window. `accept` pauses the Thread Goal once the stop is accepted (never for a
 * stop the controller rejects). `complete` runs detached AFTER the abort
 * answered, so the stop request never waits for background teardown, and it is
 * also where the target boundary is taken (see `complete`).
 *
 * Everything here is best effort. The hard rule is that any failure degrades to
 * "no cascade happened", never to something worse than today: the window always
 * closes in a `finally`, no Session lifecycle lock is taken, and no failure path
 * ever re-delivers a suppressed task.
 *
 * How the model learns a task was stopped: stopped tasks stay *undelivered*, so
 * the next turn's existing `background_cadence_reminder` lists them with their
 * real terminal status (`canceled`). Writing a dedicated history note instead
 * is deliberately NOT part of this change — `committedHistory`
 * requires a live Turn's `AgentEventContext` (`turnSequence` is mandatory) and
 * always fires the Turn's live projection, so appending after a Turn released
 * needs a new non-projecting conditional-append channel. Tracked separately.
 */

/** Whole-cascade budget. Past this the window closes and targets stay suppressed. */
const CASCADE_TIMEOUT_MS = 15_000;

export interface UserStopAbortResult {
  readonly status: 'aborted' | 'released' | 'abort-timeout' | 'not-running' | 'turn-mismatch';
  readonly turnId?: string;
}

export interface UserStopCascadeDependencies {
  readonly host: LocalTaskRunnerHostWithSessionLookup;
  /**
   * Pause the Session's active Thread Goal. Runs from `accept`, i.e. only once the
   * stop is known to be accepted, and always BEFORE tasks are stopped: a task
   * reaching terminal wakes the Session queue, and an unpaused Goal would sail
   * through its "background work" gate and start a fresh Turn immediately.
   */
  readonly pauseActiveGoal?: (sessionId: string) => Promise<void>;
}

/**
 * How a stop came to be accepted. Only these two count: the controller's own
 * identity check passed (it runs `onAccepted`), or nothing was running at all.
 */
export type UserStopAcceptance = 'controller_accepted' | 'not_running';

export interface UserStopCascadeHandle {
  /**
   * The side effects a stop may only have once it is ACCEPTED: pausing the Goal.
   * A stop the controller rejects (`turn-mismatch`) must leave the Goal exactly as
   * it was, so this is not done in `begin`. Idempotent; never throws; resolves
   * after the pause attempt so the caller can order it before the cascade.
   */
  accept(how: UserStopAcceptance): Promise<void>;
  /** Detached; never throws and never blocks the caller. */
  complete(result: UserStopAbortResult): void;
  /**
   * The stop itself failed, so there is no abort result to cascade from. Releases
   * this handle's window without stopping anything — exactly today's behaviour.
   */
  cancel(reason: string): void;
}

export interface UserStopCascade {
  begin(sessionId: string): Promise<UserStopCascadeHandle | undefined>;
}

export function createUserStopCascade(deps: UserStopCascadeDependencies): UserStopCascade {
  const { host } = deps;
  return {
    begin: async (sessionId) => {
      let window: UserStopWindowHandle | undefined;
      try {
        const session = await host.getSessionById(sessionId);
        if (!session) {
          log('user_stop_cascade_session_missing', { sessionId });
          return undefined;
        }
        // Only a main conversation cascades. A child worker Session is never woken
        // by delivery in the first place (delivery skips it), so stopping one alone
        // keeps today's behaviour: its own terminal still notifies its parent once.
        if (isLocalChildWorkerSession(session)) {
          log('cascade_skipped_child_session', { sessionId });
          return undefined;
        }
        // Only the window here. The Goal is paused in `accept`, once the stop is
        // known to be accepted: `begin` runs before the controller's identity
        // check, and a stop it then rejects must not have paused anything.
        window = openUserStopWindow(host, sessionId, host.nowMs());
        return createCascadeHandle(deps, sessionId, window);
      } catch (error) {
        // A stop must never fail because its cascade could not start. A window we
        // already opened has no owner once we return undefined, so release it here
        // rather than leaving it to the watchdog.
        window?.close('cancelled');
        log('user_stop_cascade_begin_failed', { sessionId, error: errorMessage(error) });
        return undefined;
      }
    },
  };
}

/**
 * Exactly one of `complete` / `cancel` takes effect per handle, and every path
 * releases this handle's own window hold: that is what guarantees a failed or
 * duplicated stop can never pin the Session's deliveries as `busy`.
 */
function createCascadeHandle(
  deps: UserStopCascadeDependencies,
  sessionId: string,
  window: UserStopWindowHandle,
): UserStopCascadeHandle {
  const { host } = deps;
  let settled = false;
  let cancelled = false;
  let acceptance: Promise<void> | undefined;
  return {
    accept: (how) => {
      if (cancelled) {
        // The stop was rejected or failed; it must not change the Goal.
        log('user_stop_cascade_accept_after_cancel', { sessionId, how });
        return Promise.resolve();
      }
      if (acceptance) {
        log('user_stop_cascade_duplicate_accept', { sessionId, how });
        return acceptance;
      }
      log('user_stop_cascade_accepted', { sessionId, how });
      // `pauseGoal` swallows and logs its own failure, so this never rejects.
      acceptance = pauseGoal(deps, sessionId);
      return acceptance;
    },
    complete: (result) => {
      if (settled) {
        log('user_stop_cascade_duplicate_settle', { sessionId, call: 'complete' });
        return;
      }
      settled = true;
      // The boundary is read HERE, synchronously, before the first await:
      // `complete` runs after `controller.abort` returned, so the stopped
      // Turn has already released the Session (except on `abort-timeout`,
      // see below). Reading it in `begin`
      // instead would miss a task the dying Turn created while it was
      // still winding down — background bash and background subagents do
      // not observe the parent signal, so a tool call in flight can still
      // insert a row after the stop request was accepted. Those rows must
      // be targets. Nothing newer can exist yet: the Session lock keeps
      // the next Turn from starting until this point.
      const boundaryMs = host.nowMs();
      // Known limit (documented in docs/tui-capabilities.md): on
      // `abort-timeout` the stopped Turn has NOT released yet, so the boundary
      // above can precede the end of its wind-down. Anything it creates after
      // this point is neither stopped nor suppressed — it runs and is delivered
      // exactly as it would be without a cascade. Warn, so such a stop can be
      // told apart from a clean one when a late task wakes the Session.
      if (result.status === 'abort-timeout') {
        log(
          'user_stop_cascade_boundary_before_release',
          { sessionId, boundaryMs, ...(result.turnId ? { turnId: result.turnId } : {}) },
          'warn',
        );
      }
      // Queued behind any cascade already running for this Session, then runs
      // with its OWN boundary. The window is released after this stop's own run
      // (and again, idempotently, inside `completeCascade`), whatever happened.
      const { settled: cascadeSettled, queued } = runSerializedUserStop(host, sessionId, () =>
        completeCascade(deps, sessionId, boundaryMs, window, result),
      );
      if (queued) log('user_stop_cascade_queued', { sessionId, boundaryMs });
      void cascadeSettled
        .catch((error: unknown) => {
          log('user_stop_cascade_flight_failed', { sessionId, error: errorMessage(error) });
        })
        .finally(() => window.close());
    },
    cancel: (reason) => {
      if (settled) {
        log('user_stop_cascade_duplicate_settle', { sessionId, call: 'cancel', reason });
        return;
      }
      settled = true;
      cancelled = true;
      log('user_stop_cascade_cancelled', { sessionId, reason });
      window.close('cancelled');
    },
  };
}

async function pauseGoal(deps: UserStopCascadeDependencies, sessionId: string): Promise<void> {
  if (!deps.pauseActiveGoal) return;
  try {
    await deps.pauseActiveGoal(sessionId);
    log('user_stop_cascade_goal_paused', { sessionId });
  } catch (error) {
    // The Turn abort is authoritative; Goal pause stays a best-effort side effect.
    log('user_stop_cascade_goal_pause_failed', { sessionId, error: errorMessage(error) });
  }
}

async function completeCascade(
  deps: UserStopCascadeDependencies,
  sessionId: string,
  boundaryMs: number,
  window: UserStopWindowHandle,
  result: UserStopAbortResult,
): Promise<void> {
  let targets: StoppedTaskRecord[] = [];
  log('user_stop_cascade_started', {
    sessionId,
    boundaryMs,
    abortStatus: result.status,
    ...(result.turnId ? { turnId: result.turnId } : {}),
  });
  try {
    targets = await withTimeout(
      stopSessionBackgroundWork({
        host: deps.host,
        sessionId,
        reason: 'owner_abort',
        boundaryMs,
        ctx: {
          depth: 0,
          visited: new Set<string>(),
          // Suppress as soon as targets are known, before any stop lands.
          onTargets: (taskIds) => window.registerTargets(taskIds),
        },
      }).then(({ targets: stopped }) => stopped),
      CASCADE_TIMEOUT_MS,
      [] as StoppedTaskRecord[],
      () => log('user_stop_cascade_timeout', { sessionId, timeoutMs: CASCADE_TIMEOUT_MS }),
    );
  } catch (error) {
    log('user_stop_cascade_failed', { sessionId, error: errorMessage(error) });
  } finally {
    // Always reopen ordinary delivery. Targets remain individually suppressed.
    window.close();
  }

  // Targets stay undelivered on purpose: that is exactly what makes the next
  // turn's background reminder report them as `canceled` to the model.
  log('user_stop_cascade_completed', {
    sessionId,
    targetCount: targets.length,
    abortStatus: result.status,
    stoppedTaskIds: targets.map((target) => target.taskId),
    ...(result.turnId ? { turnId: result.turnId } : {}),
  });
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('user-stop-cascade-timeout');
  try {
    const outcome = await Promise.race([
      work,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (outcome !== timedOut) return outcome;
    onTimeout();
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function log(
  event: string,
  fields: Record<string, unknown>,
  level: 'info' | 'warn' = 'info',
): void {
  try {
    logger[level]({ event: `background_task_${event}`, ...fields }, `User stop cascade: ${event}`);
  } catch {
    // Diagnostics must not interfere with an in-progress stop.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { isUserStopWindowOpen };
