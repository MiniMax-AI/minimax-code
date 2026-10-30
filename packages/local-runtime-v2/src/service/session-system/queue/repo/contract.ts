import type { AppDb } from '../../../../infra/db/client.js';
import type { InputSafetyDecision } from '../../../content-safety/index.js';

export type QueueMessageSource =
  /** Interactive Desktop/API composer input. */
  | 'api'
  | 'cron'
  | 'task'
  | 'background-task'
  | 'team'
  | 'thread-goal'
  | 'questionnaire'
  | 'communication'
  | 'code_review'
  | 'greeting'
  | 'channel:wechat'
  | 'channel:feishu'
  | 'channel:telegram';

export type QueueItemStatus = 'queued' | 'claimed';

export interface QueueChannelContext {
  readonly platform: string;
  readonly chatType: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly clientName: string;
  readonly threadId?: string;
  readonly channel?: string;
  readonly channel_id?: string;
  readonly [key: string]: unknown;
}

export interface QueueMessageAttachment {
  readonly type: 'file' | 'image';
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly dataUrl?: string;
  readonly assetId?: string;
  readonly error?: string;
}

export interface QueueMessageInput {
  readonly content: string;
  readonly attachments: readonly QueueMessageAttachment[];
  readonly inputSafetyDecision?: InputSafetyDecision;
  readonly displayAttachments?: readonly Readonly<Record<string, unknown>>[];
  readonly hideUserMessage?: boolean;
  readonly displayContent?: string;
  readonly clientIntent?: string;
  readonly queueItemId?: string;
  readonly source?: string;
  readonly origin?: unknown;
  readonly quotedMessage?: { readonly text: string; readonly senderName?: string };
  readonly channelContext?: QueueChannelContext;
}

export interface QueueModelOverride {
  /** Trusted managed admission provenance, omitted from public wire projections. */
  readonly parameterSnapshot?: {
    readonly context: 'default' | 'selection' | 'legacy';
    readonly effort: 'default' | 'selection' | 'legacy';
  };
  readonly reasoning?: boolean;
  readonly context_limit?: number;
  readonly provider_id?: string;
  readonly model_id?: string;
  readonly variant?: string;
  readonly thinking?: {
    readonly effort?: string;
  };
}

/** One durable execution input whose original user messages keep their identities. */
export interface QueueImmediateSendBatch {
  readonly id: string;
  readonly members: readonly {
    readonly message: QueueMessageInput;
    readonly userMessageId: import('../../shared/user-message-id.js').UserMessageId;
    readonly sourceMessageId?: string;
    readonly messageKey: string;
    readonly unconsumedFromTurnIds?: readonly string[];
    readonly unstartedFromTurnIds?: readonly string[];
    readonly queueClaim?: { readonly itemId: string; readonly claimId: string };
    readonly createdAt: number;
    readonly provenance: QueueRoutingProvenance;
    readonly model?: QueueModelOverride;
  }[];
}

export interface QueueItem {
  /** Trusted startup attempts whose Host fence was never released while this item survived. */
  readonly deliveryAttempts?: readonly { readonly claimId: string; readonly turnId: string }[];
  readonly immediateSendBatch?: QueueImmediateSendBatch;
  readonly itemId: string;
  /** Stable identity shared by Queue, Display and canonical history. */
  readonly userMessageId?: import('../../shared/user-message-id.js').UserMessageId;
  /** Stable Turn identity reserved by TurnSystem before Queue admission. */
  readonly requestedTurnId?: string;
  readonly sessionId: string;
  readonly agentName: string;
  readonly source: QueueMessageSource;
  readonly status: QueueItemStatus;
  readonly message: QueueMessageInput;
  readonly channelContext?: QueueChannelContext;
  readonly model?: QueueModelOverride;
  readonly createdAt: number;
  readonly clientRequestId?: string;
  readonly dedupeKey?: string;
  readonly expiresAt?: number;
  readonly claimId?: string;
  readonly claimedAt?: number;
  readonly claimOwnerId?: string;
  readonly claimLeaseExpiresAt?: number;
}

export interface QueueRoutingProvenance {
  readonly source: QueueMessageSource;
  readonly routingFingerprint: string;
  readonly sourceContext?: Readonly<Record<string, unknown>>;
}

export interface QueueSessionRef {
  readonly sessionId: string;
  readonly agentName: string;
}
export interface QueueEnqueueInput {
  readonly immediateSendBatch?: QueueImmediateSendBatch;
  readonly createdAt?: number;
  readonly session: QueueSessionRef;
  /**
   * Trusted control-plane requeue may restore the identity of an item it
   * consumed (e.g. steering returned to the Queue at an exit boundary) so
   * client-side reconcile keys survive the round trip. Ignored when the id
   * is still occupied; ordinary enqueues leave it unset.
   */
  readonly itemId?: string;
  readonly userMessageId?: import('../../shared/user-message-id.js').UserMessageId;
  readonly requestedTurnId?: string;
  readonly message: QueueMessageInput;
  readonly source?: QueueMessageSource;
  /** Trusted control-plane owners may atomically place durable work before queued items. */
  readonly queuePlacement?: 'front';
  readonly model?: QueueModelOverride;
  readonly clientRequestId?: string;
  readonly dedupeKey?: string;
  readonly expiresAt?: number;
}
export type QueuePauseCause = 'user-stop' | 'turn-final-failure';
export interface QueuePause {
  readonly cause: QueuePauseCause;
  readonly triggerTurnId: string;
  readonly pausedAtMs: number;
}
export interface QueueExecutionSnapshot {
  readonly pendingCount: number;
  readonly pause?: QueuePause;
}
export interface QueuePauseInput {
  readonly sessionId: string;
  readonly cause: QueuePauseCause;
  readonly triggerTurnId: string;
}
export type QueueEnqueueAdmissionRejection = 'session-not-found' | 'maintenance-active';
export interface QueueEnqueueAdmission {
  rejectionInTransaction(
    db: AppDb,
    input: { readonly sessionId: string; readonly nowMs: number },
  ): QueueEnqueueAdmissionRejection | undefined;
}
export interface QueueEnqueueResult {
  readonly item: QueueItem;
  readonly position: number;
}
export type QueueRemovalReason =
  | 'cancelled'
  | 'expired'
  | 'accepted'
  | 'injected'
  | 'composer-transferred'
  | 'admission-rejected';
/** Terminal outcome for a claim consumed by a durable steer admission. */
export type QueueClaimConsumeReason = Extract<QueueRemovalReason, 'accepted' | 'injected'>;
export interface QueueRemovalFact {
  readonly kind: 'removed';
  readonly sessionId: string;
  readonly itemId: string;
  readonly reason: QueueRemovalReason;
  readonly admissionReason?: QueueAdmissionRejectionReason;
  readonly removedAtMs: number;
}
export interface QueueEnqueueFact {
  readonly kind: 'enqueued';
  readonly sessionId: string;
  readonly itemId: string;
  readonly source: QueueMessageSource;
  readonly clientRequestId?: string;
  readonly enqueuedAtMs: number;
}
export interface QueueRequeueFact {
  readonly kind: 'requeued';
  readonly sessionId: string;
  readonly itemId: string;
  readonly source: QueueMessageSource;
  readonly clientRequestId?: string;
  readonly requeuedAtMs: number;
  readonly admissionReason?: QueueAdmissionRejectionReason;
}
export interface QueueExecutionStateFact {
  readonly kind: 'execution-state-changed';
  readonly sessionId: string;
  readonly paused: boolean;
}
export type QueueCommittedFact =
  | QueueEnqueueFact
  | QueueRequeueFact
  | QueueRemovalFact
  | QueueExecutionStateFact;
export interface CommittedQueueResult<T> {
  readonly value: T;
  readonly facts: readonly QueueCommittedFact[];
}
export interface QueueUpdateInput {
  readonly sessionId: string;
  readonly itemId: string;
  readonly message?: QueueMessageInput;
  readonly model?: QueueModelOverride | null;
  readonly expiresAt?: number;
}
export interface QueueReorderInput {
  readonly sessionId: string;
  readonly itemIds: readonly string[];
}
export interface QueueClaimInput {
  readonly sessionId: string;
  readonly itemId?: string;
  /** Explicit global Continue: claim the FIFO head while retaining QueuePaused until admission. */
  readonly continuePaused?: true;
  /**
   * FIFO selection skips these items and takes the first remaining queued one.
   * Owned by one drain pass: an item a blocker just parked keeps its queue
   * position and its identity, and only loses the head for that pass.
   */
  readonly excludeItemIds?: readonly string[];
  readonly allowedSources?: readonly QueueMessageSource[];
  readonly nowMs?: number;
}
export interface QueueDispatchItem {
  readonly claimId: string;
  readonly sessionId: string;
  readonly source: QueueMessageSource;
  readonly claimOwnerId: string;
  readonly claimLeaseExpiresAt: number;
  readonly selection: 'fifo' | 'exact' | 'continued-fifo';
  readonly item: QueueItem;
  readonly message: QueueMessageInput;
  readonly clientRequestId?: string;
  readonly provenance: QueueRoutingProvenance;
}
export type QueueAdmissionRejectionReason =
  | `policy:${string}`
  | 'invalid-session'
  | 'unsupported-runtime'
  | 'ingress-conflict'
  | 'duplicate-ingress';
export interface QueueClaimAcceptanceQuery {
  readonly sessionId: string;
  readonly claimId: string;
  readonly source: QueueMessageSource;
  readonly queueItemIds: readonly string[];
  readonly turnId?: string;
}
export interface QueueClaimAcceptanceLookup {
  isAcceptedInTransaction(db: AppDb, query: QueueClaimAcceptanceQuery): boolean;
  markAcknowledgedInTransaction(db: AppDb, query: QueueClaimAcceptanceQuery): void;
}
export interface QueueClaimRecoveryResult {
  readonly acknowledged: readonly QueueItem[];
  readonly released: readonly QueueItem[];
}
export interface QueueClaimRecoveryScope {
  /**
   * Startup ownership boundary. Claims created no later than this timestamp
   * belong to an older runtime graph and must be reconciled even when their
   * process-scoped owner still appears alive.
   */
  readonly claimedAtOrBeforeMs?: number;
}
export interface QueueRepository {
  listPendingSessionIds(): Promise<readonly string[]>;
  snapshot(sessionId: string): Promise<CommittedQueueResult<QueueExecutionSnapshot>>;
  pauseIfPending(input: QueuePauseInput): Promise<CommittedQueueResult<QueueExecutionSnapshot>>;
  continueQueue(
    sessionId: string,
    expectedPause?: QueuePause,
  ): Promise<CommittedQueueResult<QueueExecutionSnapshot>>;
  /** Lists composer-visible queued items only; in-flight claimed items stay hidden. */
  list(sessionId: string): Promise<CommittedQueueResult<QueueItem[]>>;
  /** Exact idempotency lookup includes queued and claimed rows. */
  findByClientRequestId(
    sessionId: string,
    clientRequestId: string,
  ): Promise<CommittedQueueResult<QueueItem | undefined>>;
  /**
   * Reads one exact durable item regardless of whether it is queued or claimed.
   * Callers use claimed visibility to distinguish in-flight from missing items;
   * mutations still reject claimed items as `not_editable`.
   */
  get(sessionId: string, itemId: string): Promise<CommittedQueueResult<QueueItem | undefined>>;
  enqueue(input: QueueEnqueueInput): Promise<CommittedQueueResult<QueueEnqueueResult | undefined>>;
  /** Only queued Desktop/API composer items support update; product-source items reject it. */
  updateQueued(
    input: QueueUpdateInput,
  ): Promise<CommittedQueueResult<QueueItem | 'invalid' | 'not_editable' | undefined>>;
  cancel(
    sessionId: string,
    itemId: string,
  ): Promise<CommittedQueueResult<QueueItem | 'not_editable' | undefined>>;
  /** Deletes only queued API rows; claimed and product-owned work remain untouched. */
  clearUserManageable(sessionId: string): Promise<CommittedQueueResult<QueueItem[]>>;
  promoteQueuedSource(
    sessionId: string,
    itemId: string,
    source: QueueMessageSource,
  ): Promise<CommittedQueueResult<QueueItem | 'not_editable' | undefined>>;
  reorder(input: QueueReorderInput): Promise<CommittedQueueResult<QueueItem[] | 'invalid'>>;
  claimNext(input: QueueClaimInput): Promise<CommittedQueueResult<QueueDispatchItem | undefined>>;
  prepareDelivery(input: {
    readonly sessionId: string;
    readonly claimId: string;
    readonly turnId: string;
  }): Promise<void>;
  acknowledgeClaim(
    sessionId: string,
    claimId: string,
    turnId?: string,
    acceptanceLookup?: QueueClaimAcceptanceLookup,
  ): Promise<CommittedQueueResult<QueueItem[]>>;
  releaseClaim(
    sessionId: string,
    claimId: string,
    reason?: QueueAdmissionRejectionReason,
  ): Promise<CommittedQueueResult<QueueItem[]>>;
  /** Atomically removes a claimed item consumed by an accepted steer admission. */
  consumeClaim(
    sessionId: string,
    claimId: string,
    reason: QueueClaimConsumeReason,
  ): Promise<CommittedQueueResult<QueueItem[]>>;
  rejectClaim(
    sessionId: string,
    claimId: string,
    reason: QueueAdmissionRejectionReason,
  ): Promise<CommittedQueueResult<QueueItem[]>>;
  /** Atomically removes a claimed item as product-cancelled work. */
  cancelClaim(sessionId: string, claimId: string): Promise<CommittedQueueResult<QueueItem[]>>;
  recoverClaims(
    sessionId: string,
    acceptanceLookup: QueueClaimAcceptanceLookup,
    scope?: QueueClaimRecoveryScope,
  ): Promise<CommittedQueueResult<QueueClaimRecoveryResult>>;
  drainComposerInjectable(sessionId: string): Promise<CommittedQueueResult<QueueItem[]>>;
  replaceSession(
    sessionId: string,
    items: readonly QueueItem[],
  ): Promise<CommittedQueueResult<void>>;
  deleteSession(sessionId: string): Promise<CommittedQueueResult<void>>;
}
export interface QueueRepositoryOptions {
  readonly db: AppDb;
  readonly nowMs?: () => number;
  readonly makeId?: (prefix: string) => string;
  readonly claimOwnerId?: string;
  readonly claimLeaseMs?: number;
  readonly isClaimOwnerAlive?: (ownerId: string) => boolean;
  readonly enqueueAdmission?: QueueEnqueueAdmission;
}

export class QueueDataCorruptionError extends Error {
  override readonly name = 'QueueDataCorruptionError';
  constructor(
    readonly sessionId: string,
    readonly itemId: string,
  ) {
    super(`Queue row is corrupt: ${sessionId}/${itemId}`);
  }
}
export class QueueClaimNotFoundError extends Error {
  override readonly name = 'QueueClaimNotFoundError';
  constructor(
    readonly sessionId: string,
    readonly claimId: string,
  ) {
    super(`Queue claim not found: ${sessionId}/${claimId || '<empty>'}`);
  }
}
export class QueueClaimNotAcceptedError extends Error {
  override readonly name = 'QueueClaimNotAcceptedError';
  constructor(
    readonly sessionId: string,
    readonly claimId: string,
    readonly turnId?: string,
  ) {
    super(`Queue claim is not durably accepted: ${sessionId}/${claimId}`);
  }
}
export class QueueEnqueueAdmissionError extends Error {
  override readonly name = 'QueueEnqueueAdmissionError';
  constructor(
    readonly sessionId: string,
    readonly reason: QueueEnqueueAdmissionRejection,
  ) {
    super(`Queue enqueue admission rejected: ${sessionId}/${reason}`);
  }
}
