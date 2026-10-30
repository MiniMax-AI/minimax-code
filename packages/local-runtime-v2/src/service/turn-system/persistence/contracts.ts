import type { AppDb } from '../../../infra/db/client.js';
import type {
  QueueClaimAcceptanceLookup,
  SessionMaintenanceGuard,
  SessionMaintenanceLease,
  TurnAdmissionPriority,
  TurnAdmissionPriorityFence,
} from '../../session-system/index.js';
import type {
  QueueIngressIdentity,
  TurnAdmissionCandidate,
  TurnAdmissionPolicy,
  TurnAdmissionRejectionReason,
  TurnClientRequestBinding,
  TurnIngressReceipt,
  TurnSessionAdmissionCapability,
} from '../admission-contracts.js';

export type TurnBusyReason = 'turn' | 'compaction';

/** Internal recovery receipt retained for Turn persistence diagnostics. */
export interface TurnRecoveryTerminalFact {
  readonly sessionId: string;
  readonly turnId: string;
  readonly completedAtMs: number;
  readonly outcome: 'failed';
  readonly reason: 'process-restart' | 'expired-lease' | 'settlement-retry';
}

export type TurnTerminalOutcome = 'completed' | 'failed' | 'aborted';

export type PluginHookSessionEndReason =
  | 'archive'
  | 'clear'
  | 'logout'
  | 'resume_other'
  | 'idle_timeout';

export type ProcessRestartOwnerKind =
  | TurnBusyReason
  | 'send'
  | 'dispatcher'
  | 'maintenance'
  | 'turn-deleting'
  | 'compaction-deleting'
  | 'maintenance-deleting'
  | 'session-deletion';

export interface ProcessRestartRecoveryEntry {
  readonly sessionId: string;
  readonly ownerKind: ProcessRestartOwnerKind;
  readonly turnId?: string;
  readonly disposition: 'released';
}

interface TurnInputMetadata {
  readonly attachmentCount: number;
  readonly hasContent: boolean;
}

export interface AdmitTurnInput extends TurnAdmissionCandidate {
  readonly turnId: string;
  readonly busyReason: TurnBusyReason;
  readonly inputDigest: string;
  readonly inputMetadata: TurnInputMetadata;
  readonly priority: TurnAdmissionPriority;
  /** A user-visible main-conversation Turn; QueuePaused consumption remains explicit below. */
  readonly foreground?: true;
  /** Admission consumes durable QueuePaused without changing Turn foreground semantics. */
  readonly consumeQueuePause?: true;
  readonly clientRequestId?: string;
  /** Per-item receipt ids bound to this Turn with `clientRequestId`; existing ids are kept. */
  readonly receiptAliases?: readonly string[];
  readonly queueIngress?: QueueIngressIdentity;
  /** Internal Edit admission only; never accepted from a public Turn request. */
  readonly bypassPriorityFence?: true;
  /** Internal Edit admission under the operation-owned mutation lease. */
  readonly bypassSessionMutation?: true;
}

export type AdmitTurnResult =
  | {
      readonly status: 'accepted';
      readonly leaseId: string;
      readonly acceptedSequence: number;
      readonly acceptedAtMs: number;
      readonly foreground?: true;
      readonly queuePauseRevokeToken?: import('../../session-system/index.js').QueuePause;
      /** Recovery facts committed in the same admission transaction. */
      readonly recoveredTerminalFacts?: readonly TurnRecoveryTerminalFact[];
    }
  | {
      readonly status: 'duplicate';
      readonly turnId: string;
      /** Recovery facts committed in the same admission transaction. */
      readonly recoveredTerminalFacts?: readonly TurnRecoveryTerminalFact[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: TurnAdmissionRejectionReason;
      /** Recovery facts committed in the same admission transaction. */
      readonly recoveredTerminalFacts?: readonly TurnRecoveryTerminalFact[];
    };

/** A maintenance lease can carry recovery facts committed before its acquisition. */
interface RecoveredSessionMaintenanceLease extends SessionMaintenanceLease {
  readonly recoveredTerminalFacts?: readonly TurnRecoveryTerminalFact[];
}

type ReserveSteeringReceiptResult =
  | { readonly status: 'reserved' }
  | { readonly status: 'duplicate'; readonly turnId: string }
  | { readonly status: 'not-accepted' };

type SessionDeletionState =
  | { readonly status: 'not-started' | 'quiescent' | 'maintenance' }
  | { readonly status: 'active'; readonly turnId: string };

export interface TurnRepository extends QueueClaimAcceptanceLookup, SessionMaintenanceGuard {
  tryAcquireSessionMaintenance(
    sessionId: string,
  ): Promise<RecoveredSessionMaintenanceLease | undefined>;
  admit(input: AdmitTurnInput): Promise<AdmitTurnResult>;
  renew(input: { readonly sessionId: string; readonly leaseId: string }): Promise<boolean>;
  settle(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly leaseId: string;
    readonly outcome: TurnTerminalOutcome;
    readonly queuePauseCause?: import('../../session-system/index.js').QueuePauseCause;
  }): Promise<
    | {
        readonly status: 'settled';
        readonly completedAtMs: number;
        readonly outcome: TurnTerminalOutcome;
      }
    | { readonly status: 'stale-owner' }
  >;
  recoverExpired(sessionId: string): Promise<{
    readonly released: boolean;
    readonly terminalFacts: readonly TurnRecoveryTerminalFact[];
  }>;
  /**
   * Fails applicable accepted work and removes every lock owned by an older
   * process. Session deletion is process-local and is never resumed here.
   */
  recoverProcessRestart(input: { readonly processStartedAtMs: number }): Promise<{
    readonly recovered: readonly ProcessRestartRecoveryEntry[];
    readonly liveSessionIds?: readonly string[];
    readonly pendingDeletionSessionIds?: readonly string[];
    readonly terminalFacts: readonly TurnRecoveryTerminalFact[];
  }>;
  findReceipt(turnId: string): Promise<TurnIngressReceipt | undefined>;
  findActiveTurn(
    sessionId: string,
  ): Promise<{ readonly turnId: string; readonly busyReason: TurnBusyReason } | undefined>;
  /** Latest durable Turn clock used to reject stale process-local idle decisions. */
  findLatestTurnActivity(sessionId: string): Promise<
    | {
        readonly turnId: string;
        readonly acceptedAtMs: number;
        readonly completedAtMs?: number;
        readonly activityAtMs: number;
      }
    | undefined
  >;
  /** Prepares ownership without superseding the last activated Hook coordinator. */
  preparePluginHookSessionOwnership(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly ownershipClaimId: string;
  }): Promise<void>;
  /** Activates a prepared owner after the process-local coordinator is bound. */
  activatePluginHookSessionOwnership(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly ownershipClaimId: string;
  }): Promise<void>;
  findLatestPluginHookSessionOwnership(sessionId: string): Promise<
    | {
        readonly ownershipClaimId: string;
        readonly turnId: string;
        readonly claimedAtMs: number;
      }
    | undefined
  >;
  /** Atomically fences external SessionEnd execution for the latest durable Hook owner. */
  tryClaimPluginHookSessionEnd(input: {
    readonly sessionId: string;
    readonly ownershipClaimId: string;
    readonly sessionEndClaimId: string;
    readonly reason: PluginHookSessionEndReason;
  }): Promise<{ readonly status: 'claimed' | 'superseded' | 'already-claimed' }>;
  completePluginHookSessionEnd(input: {
    readonly sessionId: string;
    readonly ownershipClaimId: string;
    readonly sessionEndClaimId: string;
  }): Promise<boolean>;
  /** Durable producer receipt for opt-in active-turn steering. */
  findSteeringReceipt(input: {
    readonly sessionId: string;
    readonly clientRequestId: string;
  }): Promise<TurnIngressReceipt | undefined>;
  /** Binds an opt-in producer receipt to the exact still-accepted active Turn. */
  reserveSteeringReceipt(input: {
    readonly sessionId: string;
    readonly clientRequestId: string;
    readonly turnId: string;
    /** Per-item receipt ids bound in the same write; existing ids are kept. */
    readonly receiptAliases?: readonly string[];
  }): Promise<ReserveSteeringReceiptResult>;
  /** Only used after a synchronous controller result proves no push happened. */
  releaseSteeringReceipt(input: {
    readonly sessionId: string;
    readonly clientRequestId: string;
    readonly turnId: string;
    readonly receiptAliases?: readonly string[];
  }): Promise<void>;
  findClientRequestBindings(input: {
    readonly sessionId: string;
    readonly clientRequestIds: readonly string[];
  }): Promise<readonly TurnClientRequestBinding[]>;
  /** Revokes a pre-controller activation whose admission hook rejected synchronously. */
  revokeAdmission(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly leaseId: string;
    readonly queuePauseRevokeToken?: import('../../session-system/index.js').QueuePause;
  }): Promise<boolean>;
  beginSessionDeletion(
    sessionId: string,
  ): Promise<Exclude<SessionDeletionState, { status: 'not-started' }>>;
  readSessionDeletion(sessionId: string): Promise<SessionDeletionState>;
  isSessionDeleting(sessionId: string): Promise<boolean>;
  deleteSessionData(sessionId: string): Promise<void>;
  completeSessionDeletion(sessionId: string): Promise<void>;
}

export interface TurnRepositoryOptions {
  readonly db: AppDb;
  readonly priorityFence: TurnAdmissionPriorityFence;
  readonly sessionAdmission: TurnSessionAdmissionCapability;
  readonly admissionPolicy?: TurnAdmissionPolicy;
  readonly nowMs?: () => number;
  readonly makeLeaseId?: () => string;
  readonly makeDeletionOwnerId?: () => string;
  readonly isLeaseOwnerAlive?: (ownerId: string) => boolean | undefined;
  readonly isLeaseOwnerCurrent?: (ownerId: string) => boolean;
  readonly leaseMs?: number;
}
