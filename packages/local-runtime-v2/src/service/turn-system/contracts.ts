import type { AppDb } from '../../infra/db/client.js';
import type { InputSafetyDecision } from '../content-safety/index.js';
import type {
  CommittedQueueCapability,
  QueueClaimAcceptanceLookup,
  QueueCommittedFact,
  QueueDispatchCapability,
  QueueDispatchClaim,
  QueueItem,
  SessionHistoryMutationCapability,
  SessionSystemCanonicalHistoryProvider,
  SessionMaintenanceGuard,
  TurnAdmissionPriority,
  TurnAdmissionPriorityFence,
} from '../session-system/index.js';
import type {
  AgentHost,
  AgentHostExecutionRequest,
  AgentHostCompactionControl,
  AgentHostSteeringMessage,
  AgentHostTurnControl,
  AgentHostTurnOutcome,
  AgentHostTurnProvenance,
  AgentHostInputAttachment,
  AgentHostUserInput,
  CompactionOutcome,
  TurnOutputContract,
} from './agent-host/contracts.js';
import type { RequiredAgentEventProjector } from './agent-host/events/required-agent-event-delivery.js';
import type {
  QueueIngressIdentity,
  TurnAdmissionPolicy,
  TurnAdmissionRejectionReason,
  TurnAdmissionUserInputResume,
  TurnIngressReceipt,
  TurnSessionAdmissionCapability,
} from './admission-contracts.js';
import type { UserMessageId } from '../session-system/shared/user-message-id.js';

export type {
  AgentHostInputAttachment,
  AgentHostTurnOutcome,
  AgentHostUserInput,
} from './agent-host/contracts.js';
export type { TurnAdmissionPolicy, TurnAdmissionRejectionReason } from './admission-contracts.js';

export type QueueDispatchDisposition = 'ready' | 'defer' | 'cancel';
type TurnSubmissionQueueDisposition = Exclude<QueueDispatchDisposition, 'ready'>;

export type QueueSteerDispatchResult =
  | {
      readonly status: 'started';
      readonly mode: 'accepted' | 'duplicate';
      readonly queueItemId: string;
      readonly turnId: string;
    }
  | { readonly status: 'not-claimed' }
  | { readonly status: 'deferred' | 'cancelled'; readonly queueItemId: string }
  | {
      readonly status: 'rejected';
      readonly queueItemId: string;
      readonly reason: TurnAdmissionRejectionReason;
    };

export type QueueSteerConsumeOutcome =
  | { readonly mode: 'steered' | 'duplicate'; readonly turnId: string }
  | {
      readonly mode: 'activated';
      readonly turnId: string;
      readonly completion: Promise<AgentHostTurnOutcome>;
    };

/** Application-only control seam for claim-then-steer send-now. */
export interface QueueSteerControl {
  prepareDelivery(claim: QueueDispatchClaim, turnId: string): Promise<void>;
  observe(
    claim: QueueDispatchClaim,
    result: Extract<ActivateTurnResult, { readonly accepted: true }>,
  ): void;
  claim(input: {
    readonly sessionId: string;
    readonly itemId: string;
  }): Promise<QueueDispatchClaim | undefined>;
  /** Settles the claimed item after the steer admission durably succeeded. */
  consume(claim: QueueDispatchClaim, outcome: QueueSteerConsumeOutcome): Promise<void>;
  release(claim: QueueDispatchClaim): Promise<void>;
}

export type AbortTurnResult =
  | { readonly status: 'aborted' | 'released'; readonly turnId: string }
  | { readonly status: 'abort-timeout'; readonly turnId: string }
  | { readonly status: 'not-running' | 'turn-mismatch' };

export interface AbortTurnInput {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly reason: string;
  /** Runs after exact ownership accepts the abort, before waiting for release. */
  readonly onAccepted?: () => void | Promise<void>;
}

export interface TurnFailureProjection {
  project(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly turnSequence: number;
    readonly eventId: string;
    readonly error: unknown;
    /** Pre-Host cancellation shares terminal projection without reporting an execution failure. */
    readonly status?: 'aborted';
  }): Promise<void>;
}

/** Opaque producer hook; TurnSystem does not know Task or task-store semantics. */
interface TurnSteerPreDelivery {
  accept(input: {
    readonly mode: 'activated' | 'steered';
    readonly turnId: string;
  }): void | Promise<void>;
}

interface TurnMessageDeliveryOptions {
  readonly propagateDeliveryFailure?: true;
  readonly unstartedFromTurnIds?: readonly string[];
  readonly beforeSubmit?: (turnId: string) => Promise<void>;
  readonly createdAt?: number;
  /** Internal stable display identity used when one producer may steer or activate. */
  readonly messageKey?: string;
  readonly userMessageId?: UserMessageId;
  readonly hideUserMessage?: boolean;
  readonly displayContent?: string;
  readonly displayAttachments?: readonly Readonly<Record<string, unknown>>[];
  readonly onAccepted?: (
    result: Extract<ActivateTurnResult, { readonly accepted: true }>,
  ) => void | Promise<void>;
  readonly beforeStart?: () => void | Promise<void>;
  readonly preDelivery?: TurnSteerPreDelivery;
}

export interface TurnMessageSubmission {
  readonly immediateSendBatch?: import('../session-system/index.js').QueueImmediateSendBatch;
  readonly sessionId: string;
  readonly input: AgentHostUserInput;
  readonly inputSafetyDecision?: InputSafetyDecision;
  readonly provenance: AgentHostTurnProvenance;
  readonly requestedTurnId?: string;
  readonly clientRequestId?: string;
  readonly clientIntent?: string;
  /** Explicit foreground recovery, independent of a one-shot Plan mode change. */
  readonly resumePausedQueue?: boolean;
  readonly userMessageId?: UserMessageId;
  readonly delivery?: TurnMessageDeliveryOptions;
}

type DirectTurnAdmissionPriority = Extract<
  TurnAdmissionPriority,
  {
    readonly kind:
      | 'retry-continuation'
      | 'user-input-resume'
      | 'selected-queue-item'
      | 'paused-queue-send';
  }
>;

type TurnContinuationAdmissionPriority = Extract<
  TurnAdmissionPriority,
  { readonly kind: 'turn-continuation' }
>;

/** Internal message-delivery activation shape with an explicit priority class. */
export interface TurnActivationSubmission extends TurnMessageSubmission {
  readonly outputContract?: TurnOutputContract;
  readonly executionDeadlineAtMs?: AgentHostExecutionRequest['executionDeadlineAtMs'];
  readonly admissionPriority?: DirectTurnAdmissionPriority;
  /** Queue item identity carried onto the persisted user message. */
  readonly sourceMessageId?: string;
  readonly resume?: TurnAdmissionUserInputResume;
}

export interface ResumeUserInputSubmission extends Omit<
  TurnMessageSubmission,
  'clientRequestId' | 'provenance'
> {
  readonly provenance: Omit<AgentHostTurnProvenance, 'source'> & {
    readonly source: 'questionnaire';
  };
  readonly resume: TurnAdmissionUserInputResume;
}

export interface SubmitTurnSubmission extends TurnMessageSubmission {
  readonly outputContract?: TurnOutputContract;
  /** Immediate process-local execution only; never persisted in Queue. */
  readonly executionDeadlineAtMs?: AgentHostExecutionRequest['executionDeadlineAtMs'];
  /**
   * false means immediate admission or rejection. true durably queues one
   * message and immediately wakes dispatch.
   */
  readonly allowQueue: boolean;
  readonly queuePlacement?: 'front';
  readonly dedupeKey?: string;
  readonly expiresAt?: number;
}

/** Internal message-delivery-to-execution seam, never exposed by TurnService. */
export interface DirectTurnSubmission extends Omit<
  TurnActivationSubmission,
  'admissionPriority' | 'delivery' | 'requestedTurnId'
> {
  readonly genuineUserQueryText: string;
  readonly requestedTurnId?: string;
  /** True only when Message delivery committed a visible user-query bubble. */
  readonly requiresInputReview?: boolean;
  readonly candidateCreatedAtMs?: number;
  readonly executionStart?: Promise<void>;
  readonly preDelivery?: TurnSteerPreDelivery;
  readonly admissionPriority?: DirectTurnAdmissionPriority | TurnContinuationAdmissionPriority;
  readonly executionMode?: 'continuation';
}

/** Internal Queue-to-Turn execution seam, never exposed by TurnService. */
export interface QueueTurnSubmission {
  readonly immediateSendBatch?: import('../session-system/index.js').QueueImmediateSendBatch;
  readonly sessionId: string;
  readonly input: AgentHostUserInput;
  readonly genuineUserQueryText: string;
  readonly inputSafetyDecision?: InputSafetyDecision;
  /** True only when Message delivery committed a visible user-query bubble. */
  readonly requiresInputReview?: boolean;
  readonly ingress: QueueIngressIdentity;
  readonly queueSelection?: 'fifo' | 'exact' | 'continued-fifo';
  /**
   * GOAL-05: queue rows that gave up their FIFO position for this claim, so the
   * admitting transaction fences against the same set that selection skipped.
   */
  readonly yieldedQueueItemIds?: readonly string[];
  readonly userMessageId?: UserMessageId;
  readonly requestedTurnId?: string;
  readonly candidateCreatedAtMs: number;
  readonly executionStart?: Promise<void>;
  readonly clientIntent?: string;
}

/** Queue delivery metadata consumed by the TurnSystem-owned message workflow. */
export interface QueueTurnDeliveryInput extends Omit<
  QueueTurnSubmission,
  'executionStart' | 'genuineUserQueryText'
> {
  readonly hideUserMessage?: boolean;
  readonly displayContent?: string;
  readonly displayAttachments?: readonly Readonly<Record<string, unknown>>[];
  readonly unstartedFromTurnIds?: readonly string[];
  readonly beforeSubmit?: (turnId: string) => Promise<void>;
  readonly beforeStart?: (turnId: string) => Promise<void>;
  readonly onAccepted?: (result: Extract<ActivateTurnResult, { readonly accepted: true }>) => void;
}

export type TurnSubmissionPreparationResult =
  | {
      readonly status: 'rejected';
      readonly reason: TurnAdmissionRejectionReason;
      readonly queueDisposition?: TurnSubmissionQueueDisposition;
    }
  | {
      readonly status: 'ready';
      commit(): Promise<void>;
      rollback(): Promise<void>;
      compensate(): Promise<void>;
    };

/** Optional product preparation wrapped around durable Turn admission. */
export interface TurnSubmissionPreparation {
  prepare(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly provenance: AgentHostTurnProvenance;
    readonly queueItemId?: string;
    readonly clientIntent?: string;
    /**
     * The display-owned query of this submission, present only when the user authored one.
     * Admission runs before the user message is committed, so participants that need the
     * current request cannot read it back from Session history.
     */
    readonly genuineUserQueryText?: string;
    readonly userInputResume?: TurnAdmissionUserInputResume;
  }): Promise<TurnSubmissionPreparationResult | undefined>;
}

export type ActivateTurnResult =
  | {
      readonly accepted: true;
      readonly turnId: string;
      readonly acceptedAtMs: number;
      readonly completion: Promise<AgentHostTurnOutcome>;
    }
  | {
      readonly accepted: false;
      readonly reason: TurnAdmissionRejectionReason;
      readonly queueDisposition?: TurnSubmissionQueueDisposition;
    }
  | { readonly accepted: false; readonly reason: 'duplicate'; readonly turnId: string };

export type SubmitTurnResult =
  | {
      readonly accepted: true;
      readonly mode: 'started';
      readonly turnId: string;
      readonly completion: Promise<AgentHostTurnOutcome>;
    }
  | {
      readonly accepted: true;
      readonly mode: 'queued';
      readonly turnId: string;
      readonly completion: Promise<AgentHostTurnOutcome>;
      readonly queue: {
        readonly itemId: string;
        readonly position: number;
        /** Pending queued items plus an active Turn ahead of this submission. */
        readonly ahead: number;
      };
    }
  | Exclude<ActivateTurnResult, { readonly accepted: true }>;

export type TurnContinuationState = 'unavailable' | 'available' | 'running' | 'waiting-for-user';

export interface InspectTurnContinuationResult {
  readonly state: TurnContinuationState;
}

export interface ContinueTurnInput {
  readonly sessionId: string;
  readonly onAccepted?: (input: { readonly turnId: string }) => void | Promise<void>;
}

export type ContinueTurnResult =
  | ActivateTurnResult
  | { readonly accepted: false; readonly reason: 'unavailable' | 'waiting-for-user' };

export interface ConversationEditAdmissionInput {
  readonly sessionId: string;
  readonly operationId: string;
  readonly content: string;
  readonly attachments: readonly AgentHostInputAttachment[];
  readonly displayAttachments?: readonly Readonly<Record<string, unknown>>[];
}

export type ConversationEditAdmissionResult = SubmitTurnResult & {
  readonly userMessageId: UserMessageId;
};

export interface RequestCompactionInput {
  readonly sessionId: string;
  readonly requestedTurnId?: string;
  readonly candidateCreatedAtMs?: number;
  readonly reason?: string;
  readonly customInstructions?: string;
  readonly onStarted?: () => Promise<void>;
}

export type RequestCompactionResult =
  | {
      readonly accepted: true;
      readonly turnId: string;
      readonly outcome: CompactionOutcome;
    }
  | {
      readonly accepted: false;
      readonly reason: TurnAdmissionRejectionReason;
    }
  | { readonly accepted: false; readonly reason: 'duplicate'; readonly turnId: string };

export interface SteerSessionInput extends TurnMessageSubmission {
  readonly createdAt?: number;
  readonly producerId: string;
  readonly idempotencyKey: string;
  readonly outputContract?: TurnOutputContract;
  /** Composer model selection applies only if delivery activates a fresh Turn. */
  readonly modelSelectionScope?: 'activation-only';
  /**
   * Model stripped by activation-only scope before a steered join. Only the
   * exit-boundary requeue reads it, so the follow-up query keeps the user's
   * explicit choice; active consumption never applies it mid-turn.
   */
  readonly requeueModel?: AgentHostUserInput['model'];
  /** Admission priority applied only if delivery activates a fresh Turn. */
  readonly admissionPriority?: DirectTurnAdmissionPriority;
  /** Queue item identity carried onto the persisted user message. */
  readonly sourceMessageId?: string;
  readonly preDelivery?: TurnSteerPreDelivery;
}

export type SteerSessionResult =
  | {
      readonly delivered: true;
      readonly mode: 'steered' | 'duplicate';
      readonly turnId: string;
    }
  | {
      readonly delivered: true;
      readonly mode: 'activated';
      readonly turnId: string;
      readonly completion: Promise<AgentHostTurnOutcome>;
    }
  | {
      readonly delivered: false;
      readonly reason:
        | TurnAdmissionRejectionReason
        | 'active-model-override-unsupported'
        | 'delivery-closed';
    };

export interface HistoryForkInput {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly targetWorkspaceDir: string;
  /** Frozen inclusive complete-prefix boundary used by side conversations. */
  readonly throughMessageId?: string;
  /** Preferred inclusive canonical Assistant boundary. */
  readonly throughAssistantMessageId?: string;
  /** Compatibility boundary for legacy Display rows without an Assistant identity. */
  readonly beforeUserMessageId?: UserMessageId;
  /** Best-effort rewind of dropped Turn diffs in an isolated target workspace. */
  readonly rewindTargetWorkspace?: boolean;
  readonly operationId: string;
  readonly continuation?: {
    readonly previousWorkspaceDir: string;
    readonly currentWorkspaceDir: string;
    readonly currentBranch: string;
  };
  /** A durable, hidden message that separates inherited context from a side conversation. */
  readonly hiddenContextBoundary?: {
    readonly kind: string;
    readonly content: string;
  };
}

export interface HistoryRewindInput {
  readonly sessionId: string;
  readonly fromUserMessageIdInclusive: UserMessageId;
  readonly operationId: string;
  readonly rewindTurnDiff?: boolean;
  /**
   * Display can commit a user row before its Turn reaches Canonical History.
   * This fallback is accepted only when that whole Turn is absent canonically.
   */
  readonly displayOnlyBoundary?: {
    readonly turnId: string;
    readonly subsequentUserMessageIds: readonly UserMessageId[];
    readonly affectedTurnIds: readonly string[];
  };
}

export interface HistoryForkResult {
  readonly generation: number;
  readonly historyRevision: string;
}

export type TurnDiffRewindOutcome =
  | { readonly status: 'not-requested' }
  | { readonly status: 'no-diff' }
  | { readonly status: 'rewound'; readonly revertedTurnIds: readonly string[] }
  | {
      readonly status: 'failed-after-rewind';
      readonly revertedTurnIds: readonly string[];
      readonly errorCode: 'conflict' | 'io-failed';
    };

export interface TurnDiffRewindSkipEvent {
  readonly sessionId: string;
  readonly operationId: string;
  readonly phase: 'preflight' | 'apply';
  readonly reason: 'conflict' | 'io-failed' | 'projection-error';
  readonly error?: unknown;
}

export interface HistoryRewindResult {
  readonly generation: number;
  readonly historyRevision: string;
  readonly deletedMessageIds: readonly string[];
  readonly affectedTurnIds: readonly string[];
  readonly partiallyRetainedTurnIds: readonly string[];
  readonly turnDiffRewind: TurnDiffRewindOutcome;
}

export interface TurnForkProjectionCapability {
  forkPrefix(input: {
    readonly operationId: string;
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly targetWorkspaceDir: string;
    readonly retainedTurnIds: readonly string[];
    readonly rewindTargetWorkspace?: boolean;
  }): Promise<void>;
}

export interface TurnRewindProjectionCapability {
  preflight(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly fullyDeletedTurnIds: readonly string[];
    readonly partiallyRetainedTurnIds: readonly string[];
  }): Promise<void>;
  apply(input: {
    readonly operationId: string;
    readonly sessionId: string;
  }): Promise<Exclude<TurnDiffRewindOutcome, { readonly status: 'not-requested' }>>;
  deleteTurns(input: {
    readonly sessionId: string;
    readonly turnIds: readonly string[];
  }): Promise<void>;
}
/** Stable consumer-facing TurnSystem capability. */
export interface TurnService {
  fork(input: HistoryForkInput): Promise<HistoryForkResult>;
  rewind(input: HistoryRewindInput): Promise<HistoryRewindResult>;
  submit(input: SubmitTurnSubmission): Promise<SubmitTurnResult>;
  resumeUserInput(input: ResumeUserInputSubmission): Promise<ActivateTurnResult>;
  inspectContinuation(sessionId: string): Promise<InspectTurnContinuationResult>;
  continueTurn(input: ContinueTurnInput): Promise<ContinueTurnResult>;
  steer(input: SteerSessionInput): Promise<SteerSessionResult>;
  abort(input: AbortTurnInput): Promise<AbortTurnResult>;
  requestCompaction(input: RequestCompactionInput): Promise<RequestCompactionResult>;
  /** Explicit user command: wake FIFO Queue draining without resuming a persisted Turn. */
  dispatchSessionQueue(sessionId: string): Promise<QueueSteerDispatchResult>;
  /** Internal Queue mutation/release wake used by compatibility composition. */
  dispatchQueue(sessionId: string): Promise<void>;
  sessionDeletion(sessionId: string, cleanup: () => Promise<void>): Promise<void>;
}

/** Queue execution seam implemented by the TurnSystem-owned message-delivery workflow. */
export interface QueueTurnExecutor {
  execute(input: QueueTurnDeliveryInput): Promise<ActivateTurnResult>;
}

/** Narrow controls injected into AgentHost after TurnSystem creates its owners. */
export interface TurnSystemHostCapabilities {
  readonly turnControl: AgentHostTurnControl & AgentHostCompactionControl;
  readonly turnFacts: RequiredAgentEventProjector;
  readonly pluginHookSessionOwnership: {
    prepare(input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly ownershipClaimId: string;
    }): Promise<void>;
    activate(input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly ownershipClaimId: string;
    }): Promise<void>;
  };
}

export interface TurnSystemSessionCapabilities {
  readonly canonicalHistory: Pick<
    SessionSystemCanonicalHistoryProvider,
    'inspectActive' | 'append'
  >;
  readonly sessions: {
    readonly repository: {
      has(sessionId: string): Promise<boolean>;
    };
    readonly historyMutation: SessionHistoryMutationCapability;
    readonly recovery: {
      recoverPreviousProcess(input: {
        readonly processStartedAtMs: number;
        readonly protectedSessionIds?: readonly string[];
      }): Promise<{ readonly interruptedSessionIds: readonly string[] }>;
    };
    readonly deletion: {
      begin(
        sessionId: string,
      ): Promise<{ readonly status: 'started' | 'already-deleting' | 'not-found' }>;
      complete(sessionId: string): void;
      readonly turnAdmission: TurnSessionAdmissionCapability;
    };
  };
  readonly queue: {
    readonly priorityFence: TurnAdmissionPriorityFence;
    readonly createDispatch: (acceptance: QueueClaimAcceptanceLookup) => QueueDispatchCapability;
    readonly submission: Pick<
      CommittedQueueCapability,
      'requireMutableSession' | 'enqueue' | 'list' | 'get' | 'pauseIfPending'
    >;
    readonly facts: {
      subscribe(subscriber: (facts: readonly QueueCommittedFact[]) => void): () => void;
    };
  };
  readonly agentProjection: {
    readonly failures: TurnFailureProjection;
  };
}

export interface InitializeTurnSystemOptions {
  readonly db: AppDb;
  readonly logger?: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
  readonly sessions: TurnSystemSessionCapabilities;
  readonly processStartedAtMs: number;
  readonly createHost: (capabilities: TurnSystemHostCapabilities) => AgentHost | Promise<AgentHost>;
  readonly createMessageDelivery: (input: {
    readonly execution: {
      execute(input: DirectTurnSubmission | QueueTurnSubmission): Promise<ActivateTurnResult>;
    };
  }) => {
    readonly activation: {
      execute(input: TurnActivationSubmission): Promise<ActivateTurnResult>;
    };
    readonly queue: QueueTurnExecutor;
  };
  /**
   * Decision v5 fall-to-session display projection: commits one
   * admitted-but-unconsumed user steer as its visible `steered_user` row
   * (delivery-service `consumeSteering` semantics without `session.start`).
   * When missing, teardown batches degrade to the requeue lane.
   */
  readonly commitSteeringTeardownProjection?: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly message: AgentHostSteeringMessage;
  }) => Promise<void>;
  readonly turnSettlement?: {
    settle(input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly status: 'completed' | 'failed' | 'aborted';
    }): Promise<void>;
    /** Called once TurnSystem has exhausted its settle retries for this Turn. */
    abandon?(input: { readonly sessionId: string; readonly turnId: string }): Promise<void>;
  };
  readonly nowMs?: () => number;
  readonly makeTurnId?: () => string;
  readonly makeLeaseId?: () => string;
  readonly makeDeletionOwnerId?: () => string;
  readonly isLeaseOwnerAlive?: (ownerId: string) => boolean | undefined;
  readonly isLeaseOwnerCurrent?: (ownerId: string) => boolean;
  readonly runtimeRecoveryRetryMs?: number;
  readonly resumeSessionDeletion?: (sessionId: string) => Promise<void>;
  /** Reconciles producer-owned tasks only after durable Turn recovery has committed. */
  /** Scan Tasks at startup or after Turn recovery progresses; true means external owners still need observation. */
  readonly onRuntimeRecovery?: (recoveredTurnIds: readonly string[]) => Promise<boolean | void>;
  /** When unchanged, check only observed owners/tasks; return false once all have settled. */
  readonly pollRuntimeRecovery?: () => Promise<boolean>;
  readonly onRuntimeRecoveryFailure?: (input: {
    readonly sessionId: string;
    readonly error: unknown;
  }) => void;
  readonly disposeRuntimeSession: (sessionId: string) => Promise<void>;
  readonly admissionPolicy?: TurnAdmissionPolicy;
  readonly submissionPreparation?: TurnSubmissionPreparation;
  readonly forkProjections: TurnForkProjectionCapability;
  readonly rewindProjections: TurnRewindProjectionCapability;
  readonly onTurnDiffRewindSkipped?: (event: TurnDiffRewindSkipEvent) => void;
  readonly classifyQueuedItem?: (
    item: QueueItem,
  ) => QueueDispatchDisposition | Promise<QueueDispatchDisposition>;
  /**
   * GOAL-05: a deferred autonomous item yields the FIFO head for the rest of
   * one drain pass when queued user work is waiting behind it. The item keeps
   * its queue position and identity and is re-examined on the next pass.
   */
  readonly shouldYieldFifoPosition?: (item: QueueItem) => boolean | Promise<boolean>;
  readonly onQueueWakeFailure?: (input: {
    readonly sessionId: string;
    readonly error: unknown;
  }) => void;
}

export interface TurnSystemOwner {
  readonly turns: TurnService;
  /** Prevents new Turn admission while one Session lifecycle mutation is committed. */
  readonly sessionLifecycle: {
    runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
    tryRunExclusive?<T>(
      sessionId: string,
      operation: (signal?: AbortSignal) => Promise<T>,
    ): Promise<{ readonly acquired: true; readonly value: T } | { readonly acquired: false }>;
  };
  readonly pluginHookSessionOwnership: {
    latest(sessionId: string): Promise<
      | {
          readonly ownershipClaimId: string;
          readonly turnId: string;
          readonly claimedAtMs: number;
        }
      | undefined
    >;
    tryClaimSessionEnd(input: {
      readonly sessionId: string;
      readonly ownershipClaimId: string;
      readonly sessionEndClaimId: string;
      readonly reason: 'archive' | 'clear' | 'logout' | 'resume_other' | 'idle_timeout';
    }): Promise<{ readonly status: 'claimed' | 'superseded' | 'already-claimed' }>;
    completeSessionEnd(input: {
      readonly sessionId: string;
      readonly ownershipClaimId: string;
      readonly sessionEndClaimId: string;
    }): Promise<boolean>;
  };
  readonly queueSteer: QueueSteerControl;
  readonly inspection?: {
    activeTurnId(sessionId: string): string | undefined;
    /**
     * Decision v3 ask_user suppression probe: true while the session's active
     * Turn holds admitted-but-unconsumed user-producer steering.
     */
    hasPendingUserSteering?(sessionId: string): boolean;
    activeTurn(sessionId: string): Promise<
      | {
          readonly turnId: string;
          readonly busyReason: 'turn' | 'compaction';
          readonly locallyOwned: boolean;
        }
      | undefined
    >;
    latestTurnActivity?(sessionId: string): Promise<
      | {
          readonly turnId: string;
          readonly acceptedAtMs: number;
          readonly completedAtMs?: number;
          readonly activityAtMs: number;
        }
      | undefined
    >;
  };
  readonly maintenance: SessionMaintenanceGuard;
  readonly receipts: {
    findReceipt(turnId: string): Promise<TurnIngressReceipt | undefined>;
  };
  readonly trustedEditSubmission: {
    submit(input: ConversationEditAdmissionInput): Promise<ConversationEditAdmissionResult>;
  };
  ready(): Promise<void>;
  close(): Promise<void>;
}
