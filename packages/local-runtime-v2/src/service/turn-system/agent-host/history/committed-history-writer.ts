import type { AgentHostCompactionDependencies } from '../contracts.js';
import type { AgentEventContext, AgentEventDelivery } from '../events/contracts.js';
import type {
  AgentHostHistoryFailure,
  AgentHostUsageProjection,
  CanonicalHistoryChange,
  CanonicalHistoryCompactionChange,
  CanonicalHistorySnapshot,
  CanonicalHistoryStore,
  CommittedHistoryChange,
  HistoryCommitOperation,
  TurnHistoryMutation,
  TurnHistoryMutationCommit,
} from './contracts.js';
import {
  observeCompactionBestEffort,
  readCompactionAttemptId,
  readCompactionLifecycleMetadata,
} from '../compaction/context-compaction.js';
import { AgentHostDependencyUnavailableError } from '../empty-dependencies.js';
import { SemanticReplayRegistry } from '../events/semantic-replay-registry.js';
import { resetPtcPrefixBaseline } from '../runner/policy/ptc-prefix-fingerprint.js';
import { captureSemanticSnapshot, estimateSemanticValueSize } from './semantic-identity.js';

const DEFAULT_COMMITTED_HISTORY_REPLAYS = 2_048;
const DEFAULT_COMMITTED_HISTORY_REPLAY_BYTES = 64 * 1_024 * 1_024;

class AgentCommittedHistoryIdentityError extends Error {
  override readonly name = 'AgentCommittedHistoryIdentityError';

  constructor(
    readonly reason: 'association' | 'identity' | 'revision' | 'messages' | 'conflict',
    readonly operationId: string,
  ) {
    super(`Committed history ${reason}: "${operationId}".`);
  }
}

export interface AgentHostCommittedHistoryWriterDependencies {
  readonly history: CanonicalHistoryStore;
  readonly events: AgentEventDelivery;
  readonly historyFailure?: AgentHostHistoryFailure;
  readonly compaction?: Pick<
    AgentHostCompactionDependencies,
    'lifecycle' | 'observer' | 'usageAnchor'
  >;
  readonly usage?: AgentHostUsageProjection;
  /** Test/embedding override for retained settled replay results. */
  readonly maxRetainedReplayBytes?: number;
}

type CompactionEffects = Pick<AgentHostCompactionDependencies, 'lifecycle' | 'observer'>;
type IdentifiedHistoryChange = CanonicalHistoryChange & {
  readonly operation: HistoryCommitOperation;
};

interface CommitFailurePlan {
  readonly context: AgentEventContext;
  readonly change: CanonicalHistoryChange;
  readonly error: unknown;
  readonly metadata: ReturnType<typeof readCompactionLifecycleMetadata>;
  readonly compaction: CompactionEffects | undefined;
}

interface CommitSnapshotPlan {
  readonly context: AgentEventContext;
  readonly change: IdentifiedHistoryChange;
  readonly metadata: ReturnType<typeof readCompactionLifecycleMetadata>;
  readonly compaction: CompactionEffects | undefined;
  readonly onDurableCommitted?: (change: CommittedHistoryChange) => void;
}

interface TurnMutationSnapshotPlan {
  readonly context: AgentEventContext;
  readonly mutation: TurnHistoryMutation;
  readonly change: IdentifiedHistoryChange;
  readonly onDurableCommitted?: (change: CommittedHistoryChange) => void;
}

interface PreparedChangePlan {
  readonly context: AgentEventContext;
  readonly change: IdentifiedHistoryChange;
  readonly explicitAttemptId: string | undefined;
  readonly metadataAttemptId: string | undefined;
  readonly metadata: ReturnType<typeof readCompactionLifecycleMetadata>;
}

export interface AgentHostCommittedHistoryWriteOptions {
  readonly onDurableCommitted?: (change: CommittedHistoryChange) => void;
  /**
   * Trusted Host-owned attempt identity. Supplying it lets the writer settle a
   * compaction whose change cannot be snapshotted or validated.
   */
  readonly compactionAttemptId?: string;
}

/**
 * Single Host-internal canonical commit path for normal, automatic-compaction,
 * manual-compaction and reconcile changes.
 *
 * The CanonicalHistoryStore returns the durable mutation's full reread from
 * the same per-Session lane. Required HistoryCommitted projection and
 * compaction lifecycle completion gate the returned acknowledgement; live
 * observation never does.
 */
export class AgentHostCommittedHistoryWriter {
  private readonly replay: SemanticReplayRegistry<CommittedHistoryChange>;
  private readonly usageObservations = new WeakSet<Promise<void>>();

  constructor(private readonly dependencies: AgentHostCommittedHistoryWriterDependencies) {
    this.replay = new SemanticReplayRegistry<CommittedHistoryChange>(
      DEFAULT_COMMITTED_HISTORY_REPLAYS,
      {
        maximumSettledBytes:
          dependencies.maxRetainedReplayBytes ?? DEFAULT_COMMITTED_HISTORY_REPLAY_BYTES,
        measureSettledBytes: estimateSemanticValueSize,
      },
    );
  }

  commit(
    context: AgentEventContext,
    change: IdentifiedHistoryChange,
    options: AgentHostCommittedHistoryWriteOptions = {},
  ): Promise<CommittedHistoryChange> {
    const explicitAttemptId = normalizeAttemptId(options.compactionAttemptId);
    const trustedContext = captureSemanticSnapshot(context).value;
    let snapshot: ReturnType<
      typeof captureSemanticSnapshot<{ context: AgentEventContext; change: typeof change }>
    >;
    try {
      snapshot = captureSemanticSnapshot({
        context: trustedContext,
        change: withoutTerminalAssistantError(change),
      });
    } catch (error) {
      return this.failCompactionAttempt(trustedContext, explicitAttemptId, error);
    }
    const metadata = readCompactionLifecycleMetadata(snapshot.value.change.metadata);
    const metadataAttemptId = readCompactionAttemptId(snapshot.value.change.metadata);
    const attemptId = explicitAttemptId ?? metadataAttemptId;
    try {
      validatePreparedChange({
        context: snapshot.value.context,
        change: snapshot.value.change,
        explicitAttemptId,
        metadataAttemptId,
        metadata,
      });
    } catch (error) {
      return this.failCompactionAttempt(snapshot.value.context, attemptId, error, metadata);
    }
    const operationId = snapshot.value.change.operation.id;
    let compaction: CompactionEffects | undefined;
    try {
      compaction = metadata ? this.requireCompactionLifecycle() : undefined;
    } catch (error) {
      return Promise.reject(error);
    }
    return this.replay.run({
      identity: JSON.stringify([snapshot.value.context.sessionId, operationId]),
      fingerprint: snapshot.fingerprint,
      execute: () =>
        this.commitSnapshot({
          context: snapshot.value.context,
          change: snapshot.value.change,
          metadata,
          compaction,
          ...(options.onDurableCommitted ? { onDurableCommitted: options.onDurableCommitted } : {}),
        }),
      conflict: () => new AgentCommittedHistoryIdentityError('conflict', operationId),
      handleConflict: (error) =>
        this.failCommit({
          context: snapshot.value.context,
          change: snapshot.value.change,
          error,
          metadata,
          compaction,
        }),
    });
  }

  commitTurnMutation(
    context: AgentEventContext,
    mutation: TurnHistoryMutation,
    options: AgentHostCommittedHistoryWriteOptions = {},
  ): Promise<CommittedHistoryChange> {
    let snapshot: ReturnType<
      typeof captureSemanticSnapshot<{
        context: AgentEventContext;
        mutation: TurnHistoryMutation;
        change: IdentifiedHistoryChange;
      }>
    >;
    try {
      const trustedContext = captureSemanticSnapshot(context).value;
      const change = turnMutationChange(mutation);
      snapshot = captureSemanticSnapshot({ context: trustedContext, mutation, change });
      validateTurnMutation(snapshot.value.context, snapshot.value.mutation);
      validateChange(snapshot.value.context, snapshot.value.change);
    } catch (error) {
      return Promise.reject(error);
    }
    const operationId = snapshot.value.mutation.operation.id;
    return this.replay.run({
      identity: JSON.stringify([snapshot.value.context.sessionId, operationId]),
      fingerprint: snapshot.fingerprint,
      execute: () =>
        this.commitTurnMutationSnapshot({
          ...snapshot.value,
          ...(options.onDurableCommitted ? { onDurableCommitted: options.onDurableCommitted } : {}),
        }),
      conflict: () => new AgentCommittedHistoryIdentityError('conflict', operationId),
    });
  }

  async readSettled(sessionId: string): Promise<CanonicalHistorySnapshot> {
    const snapshot = captureSemanticSnapshot(await this.dependencies.history.read(sessionId)).value;
    validateCommittedSnapshot(snapshot, 'settled-read');
    return snapshot;
  }

  private async commitSnapshot(plan: CommitSnapshotPlan): Promise<CommittedHistoryChange> {
    const { context, change, metadata, compaction, onDurableCommitted } = plan;
    try {
      const committed = captureSemanticSnapshot(await this.commitCanonical(change)).value;
      validateCommittedSnapshot(committed, change.operation.id);
      const delivered = captureSemanticSnapshot<CommittedHistoryChange>({
        ...change,
        committedRevision: committed.revision.trim(),
        committedMessages: committed.messages,
        ...(committed.identityVector ? { committedIdentityVector: committed.identityVector } : {}),
      }).value;
      this.updateUsageAnchor(context, delivered);
      onDurableCommitted?.(delivered);
      await this.dependencies.events.handleHistoryCommitted(context, delivered);
      this.observeUsage(context, delivered);
      await this.completeCompaction(context, delivered, metadata, compaction);
      return delivered;
    } catch (error) {
      return this.failCommit({ context, change, error, metadata, compaction });
    }
  }

  private async commitTurnMutationSnapshot(
    plan: TurnMutationSnapshotPlan,
  ): Promise<CommittedHistoryChange> {
    const { context, mutation, change, onDurableCommitted } = plan;
    // AgentHost classifies semantic mutation failures: abort/network may
    // recover after a strict settled read, while Safety remains fail-closed.
    // Do not eagerly project a generic permanent Session history failure here.
    const committed = captureSemanticSnapshot(
      await this.commitCanonicalTurnMutation(mutation),
    ).value;
    validateCommittedSnapshot(committed, change.operation.id);
    const delivered = captureSemanticSnapshot<CommittedHistoryChange>({
      ...change,
      messages: committed.messages,
      committedRevision: committed.revision.trim(),
      committedMessages: committed.messages,
      ...(committed.identityVector ? { committedIdentityVector: committed.identityVector } : {}),
    }).value;
    this.updateUsageAnchor(context, delivered);
    onDurableCommitted?.(delivered);
    await this.dependencies.events.handleHistoryCommitted(context, delivered);
    return delivered;
  }

  private updateUsageAnchor(context: AgentEventContext, change: CommittedHistoryChange): void {
    try {
      const anchor = this.dependencies.compaction?.usageAnchor;
      if (!anchor) return;
      if (change.reason === 'messageDelta') {
        anchor.recordBound(context.sessionId, change.messages);
      } else {
        anchor.advanceHistory(context.sessionId);
      }
    } catch {
      // Process-local trigger hints cannot affect durable History acknowledgement.
    }
  }

  private commitCanonical(change: IdentifiedHistoryChange): Promise<CanonicalHistorySnapshot> {
    if (change.reason === 'messageDelta') return this.dependencies.history.append(change);
    if (change.operation.kind === 'compaction') {
      if (!this.dependencies.history.compact) {
        throw new Error('Typed canonical compaction is unavailable.');
      }
      return this.dependencies.history.compact(asCompactionChange(change));
    }
    return this.dependencies.history.replace(change);
  }

  private commitCanonicalTurnMutation(
    mutation: TurnHistoryMutation,
  ): Promise<TurnHistoryMutationCommit> {
    if (mutation.kind === 'settle-turn-tail') {
      if (!this.dependencies.history.settleTurnTail) {
        throw new AgentHostDependencyUnavailableError('history-settle-turn-tail');
      }
      return this.dependencies.history.settleTurnTail(mutation);
    }
    if (!this.dependencies.history.retractTurn) {
      throw new AgentHostDependencyUnavailableError('history-retract-turn');
    }
    return this.dependencies.history.retractTurn(mutation);
  }

  private observeUsage(context: AgentEventContext, change: CommittedHistoryChange): void {
    const usage = this.dependencies.usage;
    if (change.reason !== 'messageDelta' || !usage) return;
    const observation = this.runUsageProjection(usage, context, change);
    this.usageObservations.add(observation);
  }

  private async runUsageProjection(
    usage: AgentHostUsageProjection,
    context: AgentEventContext,
    change: CommittedHistoryChange,
  ): Promise<void> {
    try {
      await usage.projector.record({
        sessionId: context.sessionId,
        turnId: context.turnId,
        model: context.executionModel,
        messages: [...change.messages],
      });
    } catch (error) {
      try {
        usage.onFailure?.({
          sessionId: context.sessionId,
          turnId: context.turnId,
          error,
        });
      } catch {
        // Best-effort analytics diagnostics cannot escape into History acknowledgement.
      }
    }
  }

  private async completeCompaction(
    context: AgentEventContext,
    delivered: CommittedHistoryChange,
    metadata: ReturnType<typeof readCompactionLifecycleMetadata>,
    compaction: CompactionEffects | undefined,
  ): Promise<void> {
    if (!metadata || !compaction) return;
    // The replacement history is durable: the next Turn may assemble a new prefix.
    resetPtcPrefixBaseline(context.sessionId);
    await compaction.lifecycle.completeCommittedHistory({
      context,
      attemptId: metadata.attemptId,
      operationId: delivered.operation.id,
      committedRevision: delivered.committedRevision,
      metadata,
    });
    observeCompactionBestEffort(compaction.observer, {
      context,
      attemptId: metadata.attemptId,
      status: 'completed',
      compactionId: metadata.compactionId,
      messagesBefore: metadata.messagesBefore,
      messagesAfter: metadata.messagesAfter,
      tokensBefore: metadata.tokensBefore,
      tokensAfter: metadata.tokensAfter,
      ...(metadata.contextUsage === undefined ? {} : { contextUsage: metadata.contextUsage }),
      ...(metadata.tokenUsage === undefined ? {} : { tokenUsage: metadata.tokenUsage }),
    });
  }

  private async failCommit(plan: CommitFailurePlan): Promise<never> {
    const { context, change, error, metadata, compaction } = plan;
    const failures = [...flattenFailure(error)];
    await appendCapturedFailure(failures, () =>
      this.dependencies.historyFailure?.fail({
        sessionId: context.sessionId,
        turnId: context.turnId,
        ...(change.metadata === undefined ? {} : { metadata: change.metadata }),
      }),
    );
    if (metadata && compaction) {
      await appendCapturedFailure(failures, () =>
        compaction.lifecycle.failCommittedHistory({
          context,
          attemptId: metadata.attemptId,
          error,
          metadata,
        }),
      );
      observeCompactionBestEffort(compaction.observer, {
        context,
        attemptId: metadata.attemptId,
        status: 'failed',
        compactionId: metadata.compactionId,
        ...(metadata.tokenUsage === undefined ? {} : { tokenUsage: metadata.tokenUsage }),
      });
    }
    throwFailures(failures, 'Committed history mutation failed.');
  }

  async failCompactionAttempt(
    context: AgentEventContext,
    attemptId: string | undefined,
    error: unknown,
    metadata?: ReturnType<typeof readCompactionLifecycleMetadata>,
  ): Promise<never> {
    if (!attemptId) throw error;
    const compaction = this.requireCompactionLifecycle();
    const failures = [...flattenFailure(error)];
    await appendCapturedFailure(failures, () =>
      this.dependencies.historyFailure?.fail({
        sessionId: context.sessionId,
        turnId: context.turnId,
        metadata: Object.freeze({ compactionAttemptId: attemptId }),
      }),
    );
    await appendCapturedFailure(failures, () =>
      compaction.lifecycle.failCommittedHistory({
        context,
        attemptId,
        error,
        ...(metadata ? { metadata } : {}),
      }),
    );
    observeCompactionBestEffort(compaction.observer, {
      context,
      attemptId,
      status: 'failed',
      ...(metadata ? { compactionId: metadata.compactionId } : {}),
      ...(metadata?.tokenUsage === undefined ? {} : { tokenUsage: metadata.tokenUsage }),
    });
    throwFailures(failures, 'Committed history validation failed.');
  }

  private requireCompactionLifecycle(): CompactionEffects {
    const compaction = this.dependencies.compaction;
    if (!compaction) throw new AgentHostDependencyUnavailableError('compaction-lifecycle');
    return compaction;
  }
}

function turnMutationChange(mutation: TurnHistoryMutation): IdentifiedHistoryChange {
  return {
    sessionId: mutation.sessionId,
    turnId: mutation.turnId,
    reason: 'replaceMessages',
    messages: [],
    operation: mutation.operation,
  };
}

function validateTurnMutation(context: AgentEventContext, mutation: TurnHistoryMutation): void {
  if (
    mutation.sessionId !== context.sessionId ||
    mutation.turnId !== context.turnId ||
    !mutation.operation.id.trim()
  ) {
    throw new AgentCommittedHistoryIdentityError('association', mutation.operation.id);
  }
}

function withoutTerminalAssistantError(change: IdentifiedHistoryChange): IdentifiedHistoryChange {
  if (change.reason !== 'messageDelta') return change;
  const messages = change.messages.filter((message) => !isTerminalAssistantError(message));
  return messages.length === change.messages.length ? change : { ...change, messages };
}

function isTerminalAssistantError(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    Reflect.get(message, 'role') === 'assistant' &&
    Reflect.get(message, 'stopReason') === 'error'
  );
}

function normalizeAttemptId(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validatePreparedChange(plan: PreparedChangePlan): void {
  const { context, change, explicitAttemptId, metadataAttemptId, metadata } = plan;
  validateChange(context, change);
  if (explicitAttemptId && metadataAttemptId && explicitAttemptId !== metadataAttemptId) {
    throw new AgentCommittedHistoryIdentityError('identity', change.operation.id);
  }
  if (change.operation.kind === 'compaction' && !metadata) {
    throw new AgentCommittedHistoryIdentityError('identity', change.operation.id);
  }
}

function validateChange(context: AgentEventContext, change: IdentifiedHistoryChange): void {
  if (change.sessionId !== context.sessionId || change.turnId !== context.turnId) {
    throw new AgentCommittedHistoryIdentityError('association', change.operation.id);
  }
  if (!change.operation.id.trim()) {
    throw new AgentCommittedHistoryIdentityError('identity', change.operation.id);
  }
  const append = change.reason === 'messageDelta';
  if (append !== (change.operation.kind === 'append')) {
    throw new AgentCommittedHistoryIdentityError('identity', change.operation.id);
  }
}

function asCompactionChange(change: IdentifiedHistoryChange): CanonicalHistoryCompactionChange {
  if (change.reason !== 'replaceMessages' || change.operation.kind !== 'compaction') {
    throw new AgentCommittedHistoryIdentityError('identity', change.operation.id);
  }
  return {
    ...change,
    reason: 'replaceMessages',
    operation: { ...change.operation, kind: 'compaction' },
  };
}

function validateCommittedSnapshot(snapshot: CanonicalHistorySnapshot, operationId: string): void {
  if (typeof snapshot.revision !== 'string' || !snapshot.revision.trim()) {
    throw new AgentCommittedHistoryIdentityError('revision', operationId);
  }
  if (!Array.isArray(snapshot.messages)) {
    throw new AgentCommittedHistoryIdentityError('messages', operationId);
  }
}

type CapturedFailure =
  | { readonly failed: false }
  | { readonly failed: true; readonly error: unknown };

async function captureFailure(
  operation: () => Promise<void> | undefined,
): Promise<CapturedFailure> {
  try {
    await operation();
    return { failed: false };
  } catch (error) {
    return { failed: true, error };
  }
}

async function appendCapturedFailure(
  failures: unknown[],
  operation: () => Promise<void> | undefined,
): Promise<void> {
  const captured = await captureFailure(operation);
  if (captured.failed) failures.push(...flattenFailure(captured.error));
}

function flattenFailure(error: unknown): readonly unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  return error.errors.flatMap((nested) => flattenFailure(nested));
}

function throwFailures(failures: readonly unknown[], message: string): never {
  const unique = [...new Set(failures)];
  const first = unique.at(0);
  if (unique.length < 2) throw first;
  throw new AggregateError(unique, message);
}
