/**
 * Thread Goal — codex-style atomic, per-session objective that survives
 * across multiple turns. The producer/verifier double-agent shape from
 * the previous GoalEngine v2 is intentionally NOT replicated here.
 *
 * Status semantics are host-owned — the asymmetry between
 * surfaces is the point:
 *
 *   - The MODEL (via `update_goal`) may propose `complete` or `blocked`, or on
 *     an explicit user turn request a guarded token-budget edit. The host owns
 *     durable settlement and mutation policy. A concurrent user change remains
 *     authoritative because budget writes compare the Goal decision epoch.
 *   - The USER (via the `/goal/*` REST surface) owns every transition
 *     except re-entry into `active` from a state whose budget or work is
 *     already spent: pause an `active` goal, stop it at any status,
 *     resume a `paused` / `blocked` / `usage_limited` one. Restoring
 *     `complete` or `budget_limited` to `active` is refused with 409
 *     (`GOAL_STATUS_CONFLICT` / `GOAL_BUDGET_LIMITED`) — see
 *     `TERMINAL_STATUSES` below for why. codex's external
 *     `set_thread_goal` has no transition guard; this surface does.
 *   - The SYSTEM (via bound accounting) may auto-transition `active` →
 *     `budget_limited` when `tokensUsed + delta >= tokenBudget`. Mirrors
 *     codex `accounting.rs` UPDATE that flips status atomically with the
 *     token bump.
 *
 * `complete` / `blocked` / `budget_limited` / `usage_limited` all stop the
 * auto-continuation loop. `/goal resume` only rescues `blocked` and
 * `usage_limited`. A separate explicit-user `update_goal` budget mutation may
 * atomically rearm `budget_limited(token)` when it raises the cap above
 * accounted usage or clears the cap; main-turn and active-time exhaustion are
 * not recoverable through a token edit. `complete` remains final.
 *
 * Persistence layout mirrors codex `thread_goals.thread_id PRIMARY KEY`:
 * at most one goal per session. `create_goal` replaces the previous
 * goal only when it is `complete` (codex `insert_thread_goal`'s
 * `ON CONFLICT … WHERE status = 'complete'`); anything else counts as
 * unfinished and the model gets an explicit rejection.
 */

export const THREAD_GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'complete',
  'budget_limited',
  'usage_limited',
] as const;

export type ThreadGoalStatus = (typeof THREAD_GOAL_STATUSES)[number];

export const THREAD_GOAL_VERIFICATIONS = ['none', 'evaluator', 'subagent'] as const;

export type ThreadGoalVerification = (typeof THREAD_GOAL_VERIFICATIONS)[number];

export type ThreadGoalFailureClass =
  | 'infra_retryable'
  | 'provider_quota'
  | 'rate_limit'
  | 'safety'
  | 'unknown';

/**
 * Immutable Goal identity captured immediately before a Turn is durably
 * admitted. The binding is process-local: persistence remains owned by the
 * Goal row and settlement revalidates this epoch before writing.
 */
export interface GoalTurnBinding {
  readonly goalId: string;
  readonly admittedGoalUpdatedAt: number;
  readonly objectiveDigest: string;
  readonly turnId: string;
}

/** Turn-local model proposal; only the host may convert it into durable state. */
export interface GoalTurnSignal {
  readonly type: 'completion_proposed' | 'block_proposed';
  readonly goalId: string;
  readonly objectiveDigest: string;
  /** Optional model-authored claim handed to the independent verifier as untrusted data. */
  readonly summary?: string;
}

export type ThreadGoalSignalCollectionResult =
  | 'accepted'
  | 'not_a_goal_turn'
  | 'stale'
  | 'no_goal'
  | 'paused';

export const THREAD_GOAL_STATUS_REASONS = [
  'complete(worker_proposal)',
  'complete(verifier_met)',
  'complete(user_requested)',
  'paused(user_requested)',
  'paused(retracted)',
  'paused(infra_retryable)',
  'paused(accounting_unavailable)',
  'paused(verifier_unavailable)',
  'paused(route_unavailable)',
  // Verifier pauses are split by owner layer, not by adapter error: see
  // `verification-failure-reason.ts` for the code -> owner table.
  'paused(verifier_timeout)',
  'paused(verifier_protocol)',
  'paused(verifier_runtime)',
  'paused(verifier_budget)',
  'paused(verifier_capability)',
  'paused(verifier_aborted)',
  'paused(no_progress)',
  'paused(no_progress_after_completion_claim)',
  'blocked(worker_reported)',
  'blocked(safety_policy)',
  'blocked(verifier_impossible)',
  'budget_limited(token)',
  'budget_limited(main_turn)',
  'budget_limited(active_time)',
  'usage_limited(provider_quota)',
  'usage_limited(rate_limit)',
] as const;

export type ThreadGoalStatusReason = (typeof THREAD_GOAL_STATUS_REASONS)[number];

export interface LastVerificationV1 {
  readonly v: 1;
  readonly backend: 'evaluator' | 'subagent';
  readonly verdict: 'met' | 'not_met' | 'impossible' | 'inconclusive';
  readonly reason: string;
  readonly missing: readonly string[];
  readonly missingFingerprint?: string;
  readonly notMetStreak: number;
  readonly turnId: string;
  readonly objectiveDigest: string;
  readonly at: number;
}

/** Latest model-authored terminal proposal accepted by the host decision CAS. */
export interface LastWorkerProposalV1 {
  readonly v: 1;
  readonly source: 'worker';
  readonly type: 'complete' | 'blocked';
  readonly turnId: string;
  /** Bounded model-authored evidence or blocker description; local-only. */
  readonly summary?: string;
  readonly at: number;
}

export type ThreadGoalKickoffState = 'pending' | 'enqueued' | 'consumed';

/**
 * Immutable attachment snapshot retained for the Goal lifetime. The Queue
 * receives a copy for execution, while `kickoffState=consumed` prevents any
 * later retry from materializing that snapshot again.
 */
export interface ThreadGoalAttachment {
  readonly type: 'file' | 'image';
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly dataUrl?: string;
  readonly assetId?: string;
  readonly error?: string;
}

/**
 * Validate that an objective is non-empty and, when explicitly configured,
 * remains within the contract bound. Callers should trim before validating;
 * values are rejected, never truncated.
 */
export function validateThreadGoalObjective(value: string, maxChars?: number): string | null {
  if (value.length === 0) {
    return 'goal objective must not be empty';
  }
  if (maxChars !== undefined && value.length > maxChars) {
    return `goal objective must not exceed ${maxChars} characters`;
  }
  return null;
}

/**
 * The set of statuses that should trigger auto-continuation after a
 * turn ends. Only `active` continues; everything else freezes the loop.
 */
export const CONTINUATION_STATUSES: ReadonlyArray<ThreadGoalStatus> = ['active'];

export function isContinuationStatus(status: ThreadGoalStatus): boolean {
  return CONTINUATION_STATUSES.includes(status);
}

/**
 * Why an `active` Goal cannot start its next Turn right now.
 *
 * This is deliberately NOT part of `ThreadGoalStatusReason`: `status` /
 * `statusReason` describe the Goal lifecycle (whether the system still owns
 * it), while a wait is an execution detail *inside* `active`. Folding the two
 * together would make every `status === 'active'` check carry a hidden
 * condition.
 *
 * Ordered by how directly the user can act on the blocker — admission reports
 * the first match, so a questionnaire the user can answer wins over a
 * background task they can only wait for.
 *
 * `verification` is the one reason admission never reports: it is written by
 * Turn settlement while it awaits the verifier, so it takes no part in the
 * blocker ordering above. It exists because a verifier dispatch can legitimately
 * run for minutes, during which the Goal is neither running a Turn nor idle,
 * and without it both clients render a Goal that looks stuck.
 */
export const THREAD_GOAL_WAIT_REASONS = [
  'questionnaire',
  'permission',
  'plan',
  'required_background',
  'automation_owner_conflict',
  'dependency_unavailable',
  'verification',
  'unknown',
] as const;

export type ThreadGoalWaitReason = (typeof THREAD_GOAL_WAIT_REASONS)[number];

export interface ThreadGoalExecutionWait {
  readonly reason: ThreadGoalWaitReason;
  /** Unix ms the Goal entered this wait; stable while the reason is unchanged. */
  readonly sinceMs: number;
}

/**
 * The set of statuses that stop the auto-continue loop once seen. Being in
 * this set says nothing about recoverability: the REST status surface resumes
 * a `blocked` or `usage_limited` goal back to `active`, but refuses that
 * transition for `complete` and `budget_limited`. The host's guarded token-
 * budget mutation is the sole exception for `budget_limited(token)`.
 */
export const TERMINAL_STATUSES: ReadonlyArray<ThreadGoalStatus> = [
  'complete',
  'blocked',
  'budget_limited',
  'usage_limited',
];

export function isTerminalStatus(status: ThreadGoalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Canonical thread-goal record. Timestamps are Unix milliseconds —
 * project rule (storage/API never carries ISO strings; the UI converts
 * for display via a local-time helper).
 *
 * `tokensUsed` / `timeUsedSeconds` are codex `accounting.rs`-style
 * running totals — the orchestrator bumps them at every turn-end so the
 * banner can render `(12.5K · 2m)` from a single read. Both are
 * monotonic non-negative integers; 0 means "no work yet" (banner hides
 * the usage chip when no budget is set).
 *
 * `tokenBudget` is the optional codex per-goal cap. `null` means "no
 * cap" (banner shows usage chip with elapsed duration instead of a
 * denominator). When set, bound accounting auto-transitions an `active`
 * goal to `budget_limited` the moment `tokensUsed >= tokenBudget`.
 * Mirrors codex `thread_goals.token_budget` (nullable INTEGER).
 */
export interface ThreadGoalState {
  /** Stable opaque id (e.g. `tg_<ulid>`); not the session id. */
  readonly goalId: string;
  /** Session this goal belongs to — at most one active goal per session. */
  readonly sessionId: string;
  /** The user-provided objective text, verbatim. */
  readonly objective: string;
  /** Durable resources belonging to this objective, reusable after kickoff and restart. */
  readonly objectiveResources?: readonly ThreadGoalAttachment[];
  /** Current lifecycle state. */
  readonly status: ThreadGoalStatus;
  /** Unix ms when the goal was first created. */
  readonly createdAt: number;
  /** Unix ms of the last status / objective mutation. */
  readonly updatedAt: number;
  /**
   * Total input + output tokens spent by the model since this goal was
   * created. Bumped at every turn-end by the runtime. 0 until the first
   * turn finishes.
   */
  readonly tokensUsed: number;
  /** Number of terminal main-worker turns attributed to this Goal. */
  readonly turnsUsed: number;
  /**
   * Total turn-active seconds (sum of per-turn elapsed wall time —
   * NOT calendar time). Idle time while the user is typing is excluded.
   * 0 until the first turn finishes.
   */
  readonly timeUsedSeconds: number;
  /**
   * Optional token cap. `null` means "no cap" — the goal runs forever
   * until the user clears it or the model marks it complete. When > 0,
   * Bound accounting flips `status` to `budget_limited` the moment
   * `tokensUsed >= tokenBudget`.
   */
  readonly tokenBudget: number | null;
  /** Breaker fingerprint of the last normalized main-worker reply. */
  readonly replyFingerprint: string | null;
  /** Number of consecutive same-reply observations after the first reply. */
  readonly noProgressStreak: number;
  /**
   * Number of consecutive Goal-bound main execution turns that ended normally
   * without a single committed tool call. Counted independently from
   * `noProgressStreak`: the two breaker conditions share one configured limit
   * but never add up. A turn whose tool signal is missing or untrustworthy
   * resets this to 0 rather than counting as a trustworthy zero.
   */
  readonly noToolStreak: number;
  /** Latest accepted verifier result; absent for unknown JSON versions. */
  readonly lastVerification: LastVerificationV1 | undefined;
  /** Latest worker terminal proposal durably accepted for this Goal, if any. */
  readonly lastWorkerProposal?: LastWorkerProposalV1;
  /** Closed reason catalog for the current status transition. */
  readonly statusReason: ThreadGoalStatusReason | null;
  /** Immutable input attached to the one-shot kickoff Turn. */
  readonly kickoffAttachments: readonly ThreadGoalAttachment[];
  /**
   * Durable materialization state for the one-shot kickoff Turn.
   *
   * `pending` means the Goal exists but its Queue snapshot may not; `enqueued`
   * means the snapshot was committed; `consumed` means no retry is needed.
   */
  readonly kickoffState: ThreadGoalKickoffState;
  /**
   * Why an `active` Goal is not running right now; `null` when nothing blocks
   * it. Only meaningful while `status === 'active'` — the read path forces it
   * to `null` for every other status so a stale row can never make a paused or
   * finished Goal look like it is waiting.
   *
   * Writing this never advances `updatedAt`: that field doubles as the Turn
   * admission decision epoch, so bumping it to publish a wait would make a
   * legitimate kickoff look stale.
   */
  readonly executionWait: ThreadGoalExecutionWait | null;
}
