/**
 * Account-quota recovery policy for `usage_limited` Goals.
 *
 * A Goal stopped by an exhausted account quota is not a failure the user has to
 * repair: the quota itself recovers at a wall-clock time the provider tells us.
 * This module owns the single decision "may this Goal continue on its own, and
 * when" so the Host scheduler and the durable store answer it identically. A
 * manual resume is never refused on its account: resuming before the reset is
 * a real attempt that may succeed (credits, a plan upgrade).
 *
 * Two rules keep the automation honest:
 *
 *   1. Only an *explicit account quota* stop qualifies. A bare 429, an unknown
 *      BYOK error or any other provider failure has no trustworthy recovery
 *      time, so it is never auto-resumed.
 *   2. Only a *trustworthy* recovery time qualifies. A missing, past, absurdly
 *      distant or non-integral timestamp is discarded rather than guessed at.
 *
 * Everything here is pure: the same inputs must produce the same decision in
 * the settlement path, in the scheduler and after a restart.
 */

import type { ThreadGoalState } from './types.js';

/**
 * Longest recovery time this project will schedule against.
 *
 * The account windows that produce a recoverable stop are a rolling five-hour
 * window and a rolling weekly window, so a trustworthy reset is always inside a
 * week. The extra day absorbs clock skew and provider rounding without letting
 * a corrupt or malicious timestamp park a Goal indefinitely.
 */
export const THREAD_GOAL_USAGE_RECOVERY_MAX_HORIZON_MS = 8 * 24 * 60 * 60 * 1_000;

/**
 * The only status reason whose quota recovers on a schedule.
 *
 * `usage_limited(rate_limit)` deliberately does not qualify: a rate limit is a
 * short-lived throttle without an account-window reset, and the existing
 * breaker / manual resume path already covers it.
 */
export const THREAD_GOAL_AUTO_RECOVERABLE_USAGE_REASON = 'usage_limited(provider_quota)' as const;

/**
 * Accept a candidate recovery time only when it is a usable future instant.
 *
 * Returns the normalized Unix ms value, or `undefined` when the candidate
 * cannot be trusted. Callers must treat `undefined` as "no automatic recovery"
 * rather than substituting a guess.
 */
export function normalizeUsageRecoveryAtMs(
  candidate: number | null | undefined,
  nowMs: number,
): number | undefined {
  if (candidate === null || candidate === undefined) return undefined;
  if (!Number.isSafeInteger(candidate)) return undefined;
  if (!Number.isFinite(nowMs)) return undefined;
  if (candidate <= nowMs) return undefined;
  if (candidate > nowMs + THREAD_GOAL_USAGE_RECOVERY_MAX_HORIZON_MS) return undefined;
  return candidate;
}

/**
 * True when this Goal is parked on an account quota that recovers on its own.
 *
 * This is the shape check only — it says nothing about whether the recovery
 * time has arrived. Use {@link usageRecoveryDelayMs} for that.
 */
export function isAwaitingUsageRecovery(
  goal: Pick<ThreadGoalState, 'status' | 'statusReason' | 'usageRecoveryAtMs'>,
): goal is Pick<ThreadGoalState, 'status' | 'statusReason'> & { usageRecoveryAtMs: number } {
  return (
    goal.status === 'usage_limited' &&
    goal.statusReason === THREAD_GOAL_AUTO_RECOVERABLE_USAGE_REASON &&
    typeof goal.usageRecoveryAtMs === 'number'
  );
}

/**
 * How long to wait before this Goal may continue by itself.
 *
 * `0` means the recovery time has already passed, which is the normal result
 * after a restart that spanned the reset — the caller should resume immediately
 * rather than re-arming a timer that already expired. `undefined` means the
 * Goal is not auto-recoverable at all.
 */
export function usageRecoveryDelayMs(
  goal: Pick<ThreadGoalState, 'status' | 'statusReason' | 'usageRecoveryAtMs'>,
  nowMs: number,
): number | undefined {
  if (!isAwaitingUsageRecovery(goal)) return undefined;
  return Math.max(0, goal.usageRecoveryAtMs - nowMs);
}
