import { readConversationStopConfig, type ConversationStopConfigRead } from '@mavis/config';

import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import { logger } from '../common/logger.js';
import { stopSessionBackgroundWork, type StoppedTaskRecord } from './session-cascade.js';
import {
  isUserStopWindowOpen,
  openUserStopWindow,
  runSerializedUserStop,
  type UserStopWindowHandle,
} from './user-stop-suppression.js';
import {
  isCascadeDisabledByPolicy,
  logUserStopPolicy,
  readUserStopPolicy,
  type CascadeKindPolicy,
} from './user-stop-policy.js';
import { resolveUserStopScope, type UserStopScope } from './user-stop-scope.js';

/**
 * User-stop cascade orchestration.
 *
 * `begin` runs synchronously inside the stop request, before the Turn abort:
 * it decides whether this stop cascades at all and opens the delivery suppression
 * window. `accept` pauses the Thread Goal once the stop is accepted (never for a
 * stop the controller rejects). `markBoundary` fixes the target boundary at the
 * stopped Turn's release (see `complete`). `complete` runs detached AFTER the
 * abort answered, so the stop request never waits for background teardown.
 *
 * What a stop may tear down is set by the user-stop switches in config.yaml
 * (`conversation.stopSubAgent`, default off; `conversation.stopAsyncBash`,
 * default on), read once per stop in `begin`; see `user-stop-policy.ts`.
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
  /**
   * Reads the user-stop switches from config.yaml. Called once per stop, in
   * `begin`. Defaults to `readConversationStopConfig`: the file at
   * `getConfigPath()`, read afresh and never cached. Tests inject their own so a
   * stop never depends on the developer's real config.
   */
  readonly readStopPolicy?: () => ConversationStopConfigRead;
}

/**
 * How a stop came to be accepted. Only these two count: the controller's own
 * identity check passed (it runs `onAccepted`), or nothing was running at all.
 */
export type UserStopAcceptance = 'controller_accepted' | 'not_running';

/**
 * Where the target boundary was fixed: the stopped Turn released the Session, or
 * the controller reported that nothing was running.
 */
export type UserStopBoundarySource = 'released' | 'not_running';

/** `complete` means no earlier mark arrived: an `abort-timeout`, or a missed release. */
type BoundarySource = UserStopBoundarySource | 'complete';

export interface UserStopCascadeHandle {
  /**
   * The side effects a stop may only have once it is ACCEPTED: pausing the Goal.
   * A stop the controller rejects (`turn-mismatch`) must leave the Goal exactly as
   * it was, so this is not done in `begin`. Idempotent; never throws; resolves
   * after the pause attempt so the caller can order it before the cascade.
   */
  accept(how: UserStopAcceptance): Promise<void>;
  /**
   * Fixes the target boundary now: at the stopped Turn's release, or at the
   * controller's `not-running` report — the last moment before the next Turn can
   * be admitted. Synchronous (it runs inside the Turn release); the first
   * boundary wins and any later one is logged and ignored; never throws.
   */
  markBoundary(source: UserStopBoundarySource): void;
  /** Detached; never throws and never blocks the caller. */
  complete(result: UserStopAbortResult): void;
  /**
   * The stop itself failed, so there is no abort result to cascade from. Releases
   * this handle's window without stopping anything — exactly today's behaviour.
   */
  cancel(reason: string): void;
}

export interface UserStopCascade {
  begin(sessionId: string): UserStopCascadeHandle | undefined;
}

export function createUserStopCascade(deps: UserStopCascadeDependencies): UserStopCascade {
  const { host } = deps;
  return {
    begin: (sessionId) => {
      let window: UserStopWindowHandle | undefined;
      try {
        // Synchronous on purpose: TurnExecution hands the stop to the controller
        // immediately after this returns, so the controller sees the Turn that was
        // running at arrival. The window therefore opens before the Session lookup.
        const policy = readUserStopPolicy(
          deps.readStopPolicy ?? readConversationStopConfig,
          sessionId,
        );
        if (!isCascadeDisabledByPolicy(policy)) {
          window = openUserStopWindow(host, sessionId, host.nowMs());
        }
        const scope = settleScope(resolveUserStopScope(host, sessionId), {
          sessionId,
          policy,
          window,
        });
        return createCascadeHandle(deps, sessionId, window, policy, scope);
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

function settleScope(
  scope: Promise<UserStopScope>,
  input: {
    readonly sessionId: string;
    readonly policy: ConversationStopConfigRead;
    readonly window: UserStopWindowHandle | undefined;
  },
): Promise<UserStopScope> {
  return scope.then((resolved) => {
    if (resolved === 'root') {
      logUserStopPolicy(input.sessionId, input.policy);
      if (isCascadeDisabledByPolicy(input.policy)) {
        log('user_stop_cascade_disabled_by_config', { sessionId: input.sessionId });
      }
    } else {
      input.window?.close('cancelled');
      log('user_stop_cascade_scope_skipped', { sessionId: input.sessionId, scope: resolved });
    }
    return resolved;
  });
}

/**
 * Exactly one of `complete` / `cancel` takes effect per handle, and every path
 * releases this handle's own window hold: that is what guarantees a failed or
 * duplicated stop can never pin the Session's deliveries as `busy`.
 *
 * A handle without a window belongs to a stop whose switches are both off: it
 * cascades nothing, and its only side effect is the Goal pause in `accept`. One
 * handle type for both keeps `accept` / `cancel` (idempotent, never after a
 * rejected stop) identical for every stop.
 */
function createCascadeHandle(
  deps: UserStopCascadeDependencies,
  sessionId: string,
  window: UserStopWindowHandle | undefined,
  policy: CascadeKindPolicy,
  scope: Promise<UserStopScope>,
): UserStopCascadeHandle {
  const { host } = deps;
  let settled = false;
  let cancelled = false;
  let acceptance: Promise<void> | undefined;
  // Fixed once, by whichever comes first: `markBoundary`, else `complete`. Logged
  // as `boundarySource`: the logger reserves `source` for the caller location.
  let boundary: { readonly ms: number; readonly source: BoundarySource } | undefined;
  const fixBoundary = (source: BoundarySource, abortStatus?: UserStopAbortResult['status']) => {
    const fixed = { ms: host.nowMs(), source };
    boundary = fixed;
    log('user_stop_cascade_boundary_fixed', {
      sessionId,
      boundarySource: source,
      boundaryMs: fixed.ms,
      ...(abortStatus ? { abortStatus } : {}),
    });
    return fixed;
  };
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
      acceptance = scope.then((resolved) =>
        resolved === 'root' ? pauseGoal(deps, sessionId) : undefined,
      );
      return acceptance;
    },
    markBoundary: (source) => {
      if (!window) {
        // Both switches off: nothing will be collected, so there is no boundary.
        log('user_stop_cascade_boundary_ignored', {
          sessionId,
          boundarySource: source,
          reason: 'disabled_by_config',
        });
        return;
      }
      if (cancelled || boundary) {
        // The first boundary stands: a release reported after an `abort-timeout`
        // `complete` already fixed it, a second mark, or a stop that was cancelled.
        log('user_stop_cascade_boundary_ignored', {
          sessionId,
          boundarySource: source,
          ...(boundary
            ? { boundaryMs: boundary.ms, fixedBy: boundary.source }
            : { reason: 'cancelled' }),
        });
        return;
      }
      try {
        fixBoundary(source);
      } catch (error) {
        // The boundary stays open, so `complete` takes it: the pre-mark behaviour.
        log('user_stop_cascade_mark_boundary_failed', {
          sessionId,
          boundarySource: source,
          error: errorMessage(error),
        });
      }
    },
    complete: (result) => {
      if (settled) {
        log('user_stop_cascade_duplicate_settle', { sessionId, call: 'complete' });
        return;
      }
      settled = true;
      if (!window) {
        // Both switches off (see `begin`): the Goal pause in `accept` was this
        // stop's only side effect. Logged anyway, so every stop still ends in a
        // completion line that says why nothing was stopped.
        void scope.then((resolved) =>
          log('user_stop_cascade_completed', {
            sessionId,
            targetCount: 0,
            abortStatus: result.status,
            disabledByConfig: true,
            ...(resolved === 'root' ? {} : { scope: resolved }),
            ...(result.turnId ? { turnId: result.turnId } : {}),
          }),
        );
        return;
      }
      // The boundary is the stopped Turn's release (or the controller's
      // `not-running` report), fixed by `markBoundary` at that very moment. It is
      // NOT read here: `complete` only runs once the abort returned, and the abort
      // still awaits the Goal pause (a storage write) after the release. Neither
      // holds the Session lock, so the next Turn can be admitted in between and
      // spawn background work, which a boundary read here would stop and suppress
      // as if this stop owned it. The release moment still covers everything the
      // stopped Turn created while winding down — background bash and background
      // subagents do not observe the parent signal, so a tool call in flight can
      // still insert a row after the stop was accepted, and those rows must be
      // targets.
      //
      // Only an `abort-timeout` reaches this point unmarked by design: the stopped
      // Turn has not released, so no newer Turn can start yet and the boundary is
      // taken now. A release reported later cannot move it: the first one wins.
      const boundaryMs = (boundary ?? fixBoundary('complete', result.status)).ms;
      // Known limit, accepted 2026-09-25 (ADR "User stop cascade"): on
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
        completeScopedCascade({ deps, sessionId, boundaryMs, window, result, policy, scope }),
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
      window?.close('cancelled');
    },
  };
}

async function completeScopedCascade(input: {
  readonly deps: UserStopCascadeDependencies;
  readonly sessionId: string;
  readonly boundaryMs: number;
  readonly window: UserStopWindowHandle;
  readonly result: UserStopAbortResult;
  readonly policy: CascadeKindPolicy;
  readonly scope: Promise<UserStopScope>;
}): Promise<void> {
  const scope = await input.scope;
  if (scope !== 'root') {
    log('user_stop_cascade_completed', {
      sessionId: input.sessionId,
      targetCount: 0,
      abortStatus: input.result.status,
      scope,
      ...(input.result.turnId ? { turnId: input.result.turnId } : {}),
    });
    return;
  }
  await completeCascade(input);
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

async function completeCascade(input: {
  readonly deps: UserStopCascadeDependencies;
  readonly sessionId: string;
  readonly boundaryMs: number;
  readonly window: UserStopWindowHandle;
  readonly result: UserStopAbortResult;
  /** The switches `begin` read for this stop; applied to the root sweep only. */
  readonly policy: CascadeKindPolicy;
}): Promise<void> {
  const { deps, sessionId, boundaryMs, window, result, policy } = input;
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
        rootPolicy: policy,
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
