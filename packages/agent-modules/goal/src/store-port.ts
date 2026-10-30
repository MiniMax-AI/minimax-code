/**
 * `ThreadGoalStore` —— pluggable persistence interface. agent-core is
 * IO-free; concrete implementations live in host packages
 * (`local-runtime/SqliteThreadGoalStore`, future `cloud-runtime/…`).
 *
 * The store is the single source of truth for goal state. Tool impls,
 * the HTTP API, the orchestrator, and the UI projection all funnel
 * through this contract so SSE events can be derived from store writes
 * deterministically.
 */

import type {
  GoalTurnBinding,
  LastVerificationV1,
  LastWorkerProposalV1,
  ThreadGoalAttachment,
  ThreadGoalState,
  ThreadGoalStatus,
  ThreadGoalStatusReason,
} from './types.js';

/**
 * Input for `create()`. The store assigns `goalId` / timestamps; callers
 * never pass them in. `tokenBudget` is the codex per-goal token cap —
 * `undefined` or `null` means "no cap" (the goal runs until the user
 * clears it or the model marks it complete).
 */
export interface ThreadGoalCreateInput {
  readonly sessionId: string;
  readonly objective: string;
  readonly tokenBudget?: number | null;
  /** Immutable attachment snapshot for the first Goal Turn. */
  readonly kickoffAttachments?: readonly ThreadGoalAttachment[];
  readonly objectiveResources?: readonly ThreadGoalAttachment[];
}

/**
 * Input for `patch()`. `status`, `objective`, or `tokenBudget` may be
 * supplied in any combination. Implementations must update `updatedAt`
 * on every write. An explicit `tokenBudget: null` clears the cap — pass
 * `undefined` to leave it alone (`undefined` means "don't touch", `null`
 * means "remove").
 *
 * `rejectIfCurrentStatus` is an internal optimistic-concurrency guard for
 * model-authored status writes. Implementations must include it in the same
 * atomic write that applies the patch; a read-then-write check is insufficient
 * because the user may pause the goal between those operations.
 *
 * `rejectIfObjectiveChangedFrom` is the equivalent compare-and-set guard for
 * user-authored objective edits. A model status write must not complete the
 * replacement objective when it was generated against the previous text.
 *
 * `rejectIfUpdatedAtChangedFrom` guards model-authored budget edits with the
 * exact decision epoch returned by get_goal. It must participate in the same
 * write as the budget change and any token-limit recovery transition.
 */
export interface ThreadGoalPatchInput {
  readonly status?: ThreadGoalStatus;
  readonly objective?: string;
  /** Omitted preserves resources; [] clears them with the replacement objective. */
  readonly objectiveResources?: readonly ThreadGoalAttachment[];
  readonly expectedGoalId?: string;
  readonly tokenBudget?: number | null;
  readonly statusReason?: ThreadGoalStatusReason | null;
  readonly rejectIfCurrentStatus?: ThreadGoalStatus;
  readonly rejectIfObjectiveChangedFrom?: string;
  readonly rejectIfUpdatedAtChangedFrom?: number;
}

export type ThreadGoalBudgetDimension = 'token' | 'main_turn' | 'active_time';

export interface ThreadGoalBoundUsageDelta {
  readonly tokens: number;
  readonly activeSeconds: number;
  readonly mainTurns: 0 | 1;
}

export interface ThreadGoalBudgetLimits {
  readonly tokens: number | null;
  readonly mainTurns: number | null;
  readonly activeSeconds: number | null;
}

export type ThreadGoalBudgetCheckResult =
  | { readonly decision: 'allow' }
  | { readonly decision: 'steer'; readonly message: string }
  | { readonly decision: 'stop'; readonly message: string };

export type ThreadGoalBoundUsageStaleReason = 'missing_goal' | 'goal_epoch' | 'objective_digest';

/** Usage is still attributed when the bound Goal exists, even if stale. */
export interface ThreadGoalBoundUsageResult {
  readonly goal?: ThreadGoalState;
  readonly decisionEpoch?: number;
  readonly transitioned?: ThreadGoalBudgetDimension | null;
  readonly staleReason?: ThreadGoalBoundUsageStaleReason;
}

export interface ThreadGoalSettleBoundTurnInput {
  readonly goalId: string;
  readonly expectedEpoch: number;
  readonly objectiveDigest: string;
  readonly next: {
    readonly status: Exclude<ThreadGoalStatus, 'active'>;
    readonly statusReason: ThreadGoalStatusReason;
  };
  /** Worker claim committed atomically with the host-owned decision. */
  readonly workerProposal?: ThreadGoalWorkerProposalInput;
}

export type ThreadGoalWorkerProposalInput = Pick<
  LastWorkerProposalV1,
  'type' | 'turnId' | 'summary'
>;

export type ThreadGoalDecisionStaleReason = ThreadGoalBoundUsageStaleReason | 'goal_status';

export type ThreadGoalDecisionResult =
  | {
      readonly status: 'settled';
      readonly goal: ThreadGoalState;
      readonly decisionEpoch: number;
    }
  | {
      readonly status: 'stale';
      readonly staleReason: ThreadGoalDecisionStaleReason;
      readonly goal?: ThreadGoalState;
    };

export interface ThreadGoalRecordVerificationInput {
  readonly goalId: string;
  readonly expectedEpoch: number;
  readonly objectiveDigest: string;
  readonly result: LastVerificationV1;
  /** Runtime policy captured for this dispatch; config reloads apply on the next dispatch. */
  readonly repeatedNotMetLimit: number;
  /** Completion claim committed atomically with the verifier result. */
  readonly workerProposal?: ThreadGoalWorkerProposalInput;
  readonly decision?: {
    readonly status: Exclude<ThreadGoalStatus, 'active'>;
    readonly statusReason: ThreadGoalStatusReason;
  };
}

export interface ThreadGoalBoundStoreOperations {
  bumpBoundUsage(
    binding: GoalTurnBinding,
    delta: ThreadGoalBoundUsageDelta,
    limits: ThreadGoalBudgetLimits,
  ): Promise<ThreadGoalBoundUsageResult>;
  settleBoundTurn(input: ThreadGoalSettleBoundTurnInput): Promise<ThreadGoalDecisionResult>;
  recordVerification(input: ThreadGoalRecordVerificationInput): Promise<ThreadGoalDecisionResult>;
}

/**
 * What the settling Turn is known to have done with tools.
 *
 * `unknown` is NOT "zero tool calls": it means the host could not observe the
 * committed history for this Turn, so the no-tool streak must reset instead of
 * letting an observation gap be stitched into a consecutive run.
 *
 * `repeated` means the Turn did call tools, but every call is known read-only
 * and repeated one from the Goal's recent Turns with the same arguments and the
 * same result, such as polling an unchanged file listing. It counts toward the
 * no-tool condition like `absent`: it made no new tool progress.
 *
 * `rerun` means every call repeated a recent one, but at least one may have
 * side effects (`printf x >> out.txt` changes the file each time with the same
 * empty output). It counts toward neither condition except a reply repeated
 * word for word.
 */
export type ThreadGoalToolActivity = 'used' | 'repeated' | 'rerun' | 'absent' | 'unknown';

export interface ThreadGoalBreakerInput {
  /** Goal epoch captured after this Turn's accounting write. */
  readonly expectedEpoch: number;
  /**
   * `fingerprintThreadGoalReply` of the final main-worker reply, or `null` when
   * this Turn produced no usable reply text. `null` leaves the persisted fingerprint and
   * repeated-reply streak untouched — an empty reply may not silence the
   * independent no-tool condition.
   */
  readonly fingerprint: string | null;
  /**
   * Tool activity observed for this Turn; drives the no-tool condition. A reply
   * that repeats only once its numbers are ignored extends the repeated-reply
   * run only on a `repeated` or `absent` Turn; a reply repeated word for word
   * extends it regardless.
   */
  readonly toolActivity: ThreadGoalToolActivity;
  /**
   * Shared limit: consecutive identical replies OR consecutive turns without new
   * tool progress that pause the Goal.
   */
  readonly limit: number;
  /** Durable reason selected when a no-progress pause overrides a completion claim. */
  readonly pauseReason?: Extract<
    ThreadGoalStatusReason,
    'paused(no_progress)' | 'paused(no_progress_after_completion_claim)'
  >;
}

/**
 * Which independent breaker condition produced the decided action.
 * `repeated_tool` is the no-tool condition reached by a Turn whose tool calls
 * all repeated earlier ones.
 */
export type ThreadGoalBreakerCause = 'repeated_reply' | 'no_tool' | 'repeated_tool';

export type ThreadGoalBreakerStaleReason = 'missing_goal' | 'goal_epoch' | 'goal_status';

export type ThreadGoalBreakerResult =
  | {
      readonly action: 'none' | 'nudge' | 'pause';
      readonly goal: ThreadGoalState;
      readonly epoch: number;
      /** Absent when `action` is `none`. */
      readonly cause?: ThreadGoalBreakerCause;
    }
  | {
      readonly action: 'stale';
      readonly staleReason: ThreadGoalBreakerStaleReason;
      readonly goal?: ThreadGoalState;
    };

export interface ThreadGoalStore {
  /**
   * Return the current goal for `sessionId`, or `undefined` if none exists.
   * Implementations must return a fresh value on each call — callers must
   * not mutate the returned record.
   */
  getBySession(sessionId: string): Promise<ThreadGoalState | undefined>;

  /**
   * Return a goal by its opaque `goalId`, or `undefined` if not found.
   * Used by the REST API path `GET /goal/:goalId`.
   */
  getById(goalId: string): Promise<ThreadGoalState | undefined>;

  /**
   * Create a new goal for `sessionId` with `status: 'active'`.
   *
   * Mirrors codex `insert_thread_goal` (`ON CONFLICT … WHERE
   * status = 'complete'`): an existing goal is silently replaced ONLY
   * when it is `complete`. Any other status — `active`, `paused`,
   * `blocked`, `budget_limited` — counts as unfinished and
   * implementations MUST throw `ThreadGoalAlreadyExistsError`; the
   * caller (tool impl or HTTP route) decides how to surface the
   * rejection.
   *
   * Returns the freshly created record (with assigned `goalId`,
   * `createdAt`, `updatedAt`, `status: 'active'`, and the optional
   * `tokenBudget` from `input`).
   */
  create(input: ThreadGoalCreateInput): Promise<ThreadGoalState>;

  /**
   * Apply a partial update to the goal identified by `goalId`. Throws if
   * the goal does not exist. Returns the updated record.
   */
  patch(goalId: string, input: ThreadGoalPatchInput): Promise<ThreadGoalState>;

  /**
   * Compare-and-set the durable repeated-reply breaker for an active Goal.
   * Implementations must update fingerprint, streak, epoch, and an optional
   * no-progress transition in one short transaction.
   */
  updateBreaker(goalId: string, input: ThreadGoalBreakerInput): Promise<ThreadGoalBreakerResult>;

  /**
   * Persist the latest verifier result and any verifier-owned terminal decision
   * through the same active-Goal compare-and-set.
   */
  recordVerification(input: ThreadGoalRecordVerificationInput): Promise<ThreadGoalDecisionResult>;

  /**
   * Delete the goal by `goalId`. No-op if it does not exist.
   */
  delete(goalId: string): Promise<void>;
}

/**
 * Sentinel error thrown by `create()` when an unfinished goal (any
 * status other than `complete`) already exists for the session. Hosts
 * can pattern-match on `instanceof` to map it to HTTP 409 or the
 * codex-verbatim tool rejection text.
 */
export class ThreadGoalAlreadyExistsError extends Error {
  readonly existingGoalId: string;
  constructor(existingGoalId: string) {
    super(`Unfinished thread goal already exists (goalId=${existingGoalId}).`);
    this.name = 'ThreadGoalAlreadyExistsError';
    this.existingGoalId = existingGoalId;
  }
}

/**
 * Raised when a patch observes a status it may not move away from. The
 * model-facing tool sets an explicit guard status and maps this to a normal
 * tool rejection; a user-authored PATCH hits it only on a transition the
 * surface refuses outright, `complete` back to `active` among them.
 */
export class ThreadGoalStatusConflictError extends Error {
  constructor(
    readonly goalId: string,
    readonly currentStatus: ThreadGoalStatus,
  ) {
    super(`Thread goal status conflict (goalId=${goalId}, currentStatus=${currentStatus}).`);
    this.name = 'ThreadGoalStatusConflictError';
  }
}

/** Raised when a guarded model status write observes a newer objective. */
export class ThreadGoalObjectiveConflictError extends Error {
  constructor(
    readonly goalId: string,
    readonly expectedObjective: string,
    readonly currentObjective: string,
  ) {
    super(`Thread goal objective conflict (goalId=${goalId}).`);
    this.name = 'ThreadGoalObjectiveConflictError';
  }
}

/** Raised when a budget-exhausted Goal is explicitly rearmed. */
export class ThreadGoalBudgetLimitedError extends Error {
  readonly code = 'GOAL_BUDGET_LIMITED';

  constructor(readonly goalId: string) {
    super(`Budget-limited thread goal cannot be resumed (goalId=${goalId}).`);
    this.name = 'ThreadGoalBudgetLimitedError';
  }
}

/** Raised when a token cap would already be exhausted by accounted usage. */
export class ThreadGoalTokenBudgetExhaustedError extends Error {
  readonly code = 'GOAL_TOKEN_BUDGET_EXHAUSTED';

  constructor(
    readonly goalId: string,
    readonly tokensUsed: number,
    readonly tokenBudget: number,
  ) {
    super(
      `Token budget must exceed accounted usage (goalId=${goalId}, tokensUsed=${tokensUsed}, tokenBudget=${tokenBudget}).`,
    );
    this.name = 'ThreadGoalTokenBudgetExhaustedError';
  }
}

/** Raised when a guarded write no longer matches the Goal decision epoch. */
export class ThreadGoalEpochConflictError extends Error {
  readonly code = 'GOAL_EPOCH_CONFLICT';

  constructor(
    readonly goalId: string,
    readonly expectedUpdatedAt: number,
    readonly currentUpdatedAt: number,
  ) {
    super(`Thread goal decision epoch changed (goalId=${goalId}).`);
    this.name = 'ThreadGoalEpochConflictError';
  }
}
