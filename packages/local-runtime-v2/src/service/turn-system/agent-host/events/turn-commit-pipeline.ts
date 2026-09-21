import {
  RuntimeEventStatus,
  RuntimeEventType,
  type RuntimeEvent,
} from '@mavis/agent-core/protocol';

import {
  readCompactionAttemptId,
  readCompactionLifecycleMetadata,
} from '../compaction/context-compaction.js';
import type { AgentEventContext, AgentEventDelivery, AgentEventResult } from './contracts.js';
import type {
  CanonicalHistoryChange,
  CanonicalHistoryCommit,
  CanonicalHistorySnapshot,
  HistoryCommitOperation,
  HistoryReconcileIntent,
  TurnHistoryMutation,
} from '../history/contracts.js';
import type {
  AcceptedTurnLease,
  AgentHostScopedTurnControl,
  AgentHostTurnOutcome,
} from '../runner/contracts.js';
import { buildHostFailedEvent } from './host-failed-event.js';
import type { AgentHostCommittedHistoryWriter } from '../history/committed-history-writer.js';
import {
  AgentHistoryOperationIdentityError,
  AgentHistoryOperationReplayCoordinator,
  type HistoryOperationReplay,
} from '../history/history-operation-replay.js';
import { captureSemanticSnapshot } from '../history/semantic-identity.js';
import { TurnCommittedHistoryState } from '../history/turn-committed-history-state.js';
import { CanonicalUserMessageIdentityLane } from '../history/canonical-user-message-identities.js';
import { AgentEventAssociationError } from '../preparation/turn-preflight.js';
import type { UserMessageId } from '../../../session-system/index.js';
import { WriteLockWaitAbortedError } from '../../../../infra/db/write-transaction.js';

export class AgentTerminalConfirmationError extends Error {
  override readonly name = 'AgentTerminalConfirmationError';

  constructor(
    readonly reason: 'missing' | 'event-mismatch' | 'outcome-mismatch' | 'conflict',
    readonly expected?: AgentHostTurnOutcome['status'],
    readonly actual?: AgentHostTurnOutcome['status'],
  ) {
    super(terminalConfirmationMessage(reason, expected, actual));
  }
}

export class LocalRuntimeTerminalIdentityError extends Error {
  override readonly name = 'LocalRuntimeTerminalIdentityError';

  constructor(readonly reason: 'missing' | 'unsupported') {
    super(`Local runtime terminal event is ${reason}.`);
  }
}

export class LocalRuntimeTerminalError extends Error {
  override readonly name = 'LocalRuntimeTerminalError';
  readonly category = 'runtime';
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    readonly eventId: string,
    readonly event: RuntimeEvent,
    isRetryable: (errorCode: number | undefined) => boolean,
  ) {
    super(terminalMessage(event) ?? 'Local runtime turn failed.');
    const errorCode = event.payload.error?.code;
    this.code = typeof errorCode === 'number' ? String(errorCode) : 'RUNTIME_ERROR';
    this.retryable = isRetryable(errorCode);
  }
}

interface TurnCommitPipelineDependencies {
  readonly context: AgentEventContext;
  readonly lease: AcceptedTurnLease;
  readonly initialHistory: CanonicalHistorySnapshot;
  readonly events: AgentEventDelivery;
  readonly committedHistory: AgentHostCommittedHistoryWriter;
  readonly primaryUserMessageId?: UserMessageId;
  readonly primaryUserMessageBatch?: {
    readonly id: string;
    readonly messageIds: readonly UserMessageId[];
  };
  readonly isRuntimeErrorRetryable: (errorCode: number | undefined) => boolean;
}

/**
 * Owns ordered event/History processing and authoritative terminal staging for
 * one accepted Turn. LocalAgentHost remains the lifecycle owner and decides
 * when to drain, reconcile, run turn-end handlers, and commit the terminal.
 */
export class TurnCommitPipeline {
  private readonly lane = new OrderedAgentEventLane();
  private readonly terminal: TerminalEventBuffer;
  private readonly committedHistoryState: TurnCommittedHistoryState;
  private readonly historyOperations = new Map<string, HistoryOperationReplay>();
  private readonly historyReplay: AgentHistoryOperationReplayCoordinator;
  private readonly userMessageIdentities: CanonicalUserMessageIdentityLane;
  private fallbackHistoryOperationSequence = 0;

  constructor(private readonly dependencies: TurnCommitPipelineDependencies) {
    this.terminal = new TerminalEventBuffer(dependencies.isRuntimeErrorRetryable);
    this.committedHistoryState = new TurnCommittedHistoryState(dependencies.initialHistory);
    this.userMessageIdentities = new CanonicalUserMessageIdentityLane(
      dependencies.primaryUserMessageId,
      dependencies.primaryUserMessageBatch,
    );
    this.historyReplay = new AgentHistoryOperationReplayCoordinator({
      context: dependencies.context,
      lane: this.lane,
      writer: dependencies.committedHistory,
      commit: (change) => this.commitAndHandleHistory(change),
    });
  }

  readonly onRuntimeEvent = async (event: RuntimeEvent): Promise<void> => {
    const outcome = terminalEventOutcome(event);
    if (!outcome && event.type === RuntimeEventType.TURN_TERMINAL) {
      await this.lane.enqueue(() =>
        Promise.reject(new LocalRuntimeTerminalIdentityError('unsupported')),
      );
      return;
    }
    if (outcome) {
      const claim = captureSync(() => this.terminal.claim(outcome));
      if (!claim.ok) {
        await this.lane.enqueue(() => Promise.reject(claim.error), true);
        return;
      }
      const snapshot = captureSync(() => captureSemanticSnapshot(event));
      if (!snapshot.ok) {
        await this.lane.enqueue(
          () => Promise.reject(snapshot.error),
          isNonNormalTerminalRuntimeEvent(event),
        );
        return;
      }
      await this.lane.enqueue(() => {
        validateRuntimeAssociation(this.dependencies.context, snapshot.value.value);
        this.terminal.stage(snapshot.value.value);
        return Promise.resolve();
      }, isNonNormalTerminalRuntimeEvent(snapshot.value.value));
      return;
    }
    await this.lane.enqueue(async () => {
      validateRuntimeAssociation(this.dependencies.context, event);
      const signal = this.dependencies.lease.signal;
      try {
        const result = await this.dependencies.events.handleRuntimeEvent(
          this.dependencies.context,
          event,
          signal,
        );
        new TerminalConfirmation().observe(event, result);
      } catch (error) {
        if (
          error instanceof WriteLockWaitAbortedError &&
          error.signal === signal &&
          signal.aborted
        ) {
          // This lease cancelled a projection before its write began. Keep the
          // lane available for the runner's abort reconciliation and terminal.
          return;
        }
        throw error;
      }
    });
  };

  readonly onHistoryChanged = (change: CanonicalHistoryChange): Promise<void> =>
    this.enqueueHistory(change, false);

  readonly registerCanonicalUserMessageIds = (
    messageIds: readonly UserMessageId[],
    batchId?: string,
  ): void => {
    this.userMessageIdentities.register(messageIds, batchId);
  };

  readonly rearmPrimaryUserMessageIdAfterOutputRecall = (): void => {
    this.userMessageIdentities.rearmPrimaryAfterOutputRecall();
  };

  drain(): Promise<void> {
    return this.lane.settle();
  }

  requireTerminal(outcome: AgentHostTurnOutcome): RuntimeEvent {
    return this.terminal.require(outcome);
  }

  resolveOutcome(reconcile?: HistoryReconcileIntent): AgentHostTurnOutcome {
    return this.terminal.outcome(reconcile);
  }

  failedEvent(error: unknown): RuntimeEvent {
    return this.terminal.failedEvent(this.dependencies.context, error);
  }

  async reconcileHistory(intent: HistoryReconcileIntent): Promise<void> {
    await this.commitTurnMutation(reconcileMutation(this.dependencies.lease, intent), {
      retracted: intent.kind === 'output-recall',
    });
  }

  async recallOutputAttemptHistory(attempt: number): Promise<void> {
    await this.commitTurnMutation(
      retractMutation(
        this.dependencies.lease,
        {
          id: `agent-host:${this.dependencies.lease.turnId}:history:output-attempt-recall:${String(attempt)}`,
          kind: 'turn-retraction',
          variant: 'content',
        },
        attempt,
      ),
      { retracted: true },
    );
  }

  async commitOutcomeTerminal(
    control: AgentHostScopedTurnControl,
    event: RuntimeEvent,
    outcome: AgentHostTurnOutcome,
  ): Promise<void> {
    if (outcome.status === 'failed') {
      await this.commitFailedTerminal(control, event);
      return;
    }
    if (outcome.status === 'aborted') {
      await control.sealAbnormalTerminal();
    }
    await this.deliverTerminal(event, outcome);
  }

  async commitFailedTerminal(
    control: AgentHostScopedTurnControl,
    event: RuntimeEvent,
  ): Promise<void> {
    await commitHostFailedTerminal({
      context: this.dependencies.context,
      control,
      event,
      events: this.dependencies.events,
    });
  }

  private enqueueHistory(
    change: CanonicalHistoryChange,
    allowHostReservedOperation: boolean,
  ): Promise<void> {
    const prepared = captureSync(() => {
      const normalizedChange = normalizeHistoryMessagePayloads(change);
      const operation =
        normalizedChange.operation ??
        fallbackHistoryOperation(
          this.dependencies.lease.turnId,
          ++this.fallbackHistoryOperationSequence,
          normalizedChange,
        );
      const identifiedChange = { ...normalizedChange, operation };
      validateHistoryAssociation(this.dependencies.context, identifiedChange);
      validateHistoryOperation(
        identifiedChange,
        this.dependencies.lease.turnId,
        allowHostReservedOperation,
      );
      const snapshot = captureSemanticSnapshot(
        this.userMessageIdentities.decorate(identifiedChange, {
          messages: this.committedHistoryState.currentMessages,
          identityVector: this.committedHistoryState.currentIdentityVectorValue,
        }),
      );
      return {
        change: snapshot.value,
        fingerprint: snapshot.fingerprint,
        operationId: snapshot.value.operation.id,
      };
    });
    if (!prepared.ok) {
      return this.historyReplay.rejectPreparation(change, prepared.error);
    }
    const replay = this.historyOperations.get(prepared.value.operationId);
    if (replay) return this.historyReplay.resolve(replay, prepared.value);
    const execution = this.historyReplay.enqueuePrepared(prepared.value, () =>
      this.commitAndHandleHistory(prepared.value.change, (commit) => {
        this.committedHistoryState.record(commit);
      }),
    );
    this.historyOperations.set(prepared.value.operationId, {
      fingerprint: prepared.value.fingerprint,
      execution,
    });
    return execution;
  }

  private async commitAndHandleHistory(
    change: CanonicalHistoryChange & {
      readonly operation: HistoryCommitOperation;
    },
    onCommitted?: (commit: CanonicalHistoryCommit) => void,
  ): Promise<void> {
    const compactionAttemptId = readCompactionAttemptId(change.metadata);
    await this.dependencies.committedHistory.commit(this.dependencies.context, change, {
      ...(compactionAttemptId ? { compactionAttemptId } : {}),
      onDurableCommitted: (committed) => {
        onCommitted?.({
          revision: committed.committedRevision,
          messages: committed.committedMessages,
          identityVector: committed.committedIdentityVector,
        });
      },
    });
  }

  private async commitTurnMutation(
    mutation: TurnHistoryMutation,
    options: { readonly retracted: boolean },
  ): Promise<void> {
    await this.dependencies.committedHistory.commitTurnMutation(
      this.dependencies.context,
      captureSemanticSnapshot(mutation).value,
      {
        onDurableCommitted: (committed) => {
          this.committedHistoryState.record(
            {
              revision: committed.committedRevision,
              messages: committed.committedMessages,
              identityVector: committed.committedIdentityVector,
            },
            options.retracted,
          );
        },
      },
    );
  }

  private async deliverTerminal(event: RuntimeEvent, outcome: AgentHostTurnOutcome): Promise<void> {
    const result = await this.dependencies.events.handleRuntimeEvent(
      this.dependencies.context,
      event,
    );
    const confirmation = new TerminalConfirmation();
    confirmation.observe(event, result);
    confirmation.confirm(outcome);
  }
}

export async function commitHostFailedTerminal(input: {
  readonly context: AgentEventContext;
  readonly control: AgentHostScopedTurnControl;
  readonly event: RuntimeEvent;
  readonly events: AgentEventDelivery;
}): Promise<void> {
  const sealResult = await capture(() => input.control.sealAbnormalTerminal());
  const deliveryResult = await capture(async () => {
    const result = await input.events.handleRuntimeEvent(input.context, input.event);
    const confirmation = new TerminalConfirmation();
    confirmation.observe(input.event, result);
    confirmation.confirm({ status: 'failed', error: undefined });
  });
  const failures = compactFailures([sealResult, deliveryResult]);
  if (failures.length > 0) throwFailures(failures, 'Agent terminal finalization failed.');
}

interface LaneOperation {
  readonly operation: () => Promise<void>;
  readonly continueAfterFailure: boolean;
  readonly onBlockedByFailure?: (error: unknown) => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

class OrderedAgentEventLane {
  private readonly queue: LaneOperation[] = [];
  private running: Promise<void> | undefined;
  private firstFailure: { readonly error: unknown } | undefined;

  enqueue(
    operation: () => Promise<void>,
    continueAfterFailure = false,
    onBlockedByFailure?: (error: unknown) => Promise<void>,
  ): Promise<void> {
    const execution = new Promise<void>((resolve, reject) => {
      this.queue.push({
        operation,
        continueAfterFailure,
        ...(onBlockedByFailure ? { onBlockedByFailure } : {}),
        resolve,
        reject,
      });
    });
    this.start();
    return execution;
  }

  async settle(): Promise<void> {
    await this.enqueue(() => Promise.resolve(), true);
    if (this.firstFailure) throw this.firstFailure.error;
  }

  private start(): void {
    if (this.running) return;
    this.running = this.drain();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) await this.execute(next);
    }
    this.running = undefined;
  }

  private async execute(item: LaneOperation): Promise<void> {
    try {
      if (this.firstFailure && !item.continueAfterFailure) {
        await item.onBlockedByFailure?.(this.firstFailure.error);
        throw this.firstFailure.error;
      }
      await item.operation();
      item.resolve();
    } catch (error) {
      if (!this.firstFailure) this.firstFailure = { error };
      item.reject(error);
    }
  }
}

class TerminalEventBuffer {
  private claimedOutcome: AgentHostTurnOutcome['status'] | undefined;
  private staged:
    | {
        readonly event: RuntimeEvent;
        readonly outcome: AgentHostTurnOutcome['status'];
      }
    | undefined;

  constructor(
    private readonly isRuntimeErrorRetryable: (errorCode: number | undefined) => boolean,
  ) {}

  claim(outcome: AgentHostTurnOutcome['status']): void {
    if (this.claimedOutcome) {
      throw new AgentTerminalConfirmationError('conflict', this.claimedOutcome, outcome);
    }
    this.claimedOutcome = outcome;
  }

  stage(event: RuntimeEvent): void {
    const outcome = terminalEventOutcome(event);
    if (!outcome) return;
    if (this.staged) {
      throw new AgentTerminalConfirmationError('conflict', this.staged.outcome, outcome);
    }
    this.staged = { event, outcome };
  }

  require(outcome: AgentHostTurnOutcome): RuntimeEvent {
    if (!this.staged) {
      throw new AgentTerminalConfirmationError('missing', outcome.status);
    }
    if (this.staged.outcome !== outcome.status) {
      throw new AgentTerminalConfirmationError(
        'outcome-mismatch',
        outcome.status,
        this.staged.outcome,
      );
    }
    return this.staged.event;
  }

  outcome(reconcile?: HistoryReconcileIntent): AgentHostTurnOutcome {
    if (!this.staged) throw new LocalRuntimeTerminalIdentityError('missing');
    switch (this.staged.outcome) {
      case 'completed':
        return { status: 'completed', ...(reconcile ? { historyReconcile: reconcile } : {}) };
      case 'aborted': {
        const reason = terminalMessage(this.staged.event);
        return {
          status: 'aborted',
          ...(reason ? { reason } : {}),
          ...(reconcile ? { historyReconcile: reconcile } : {}),
        };
      }
      case 'failed':
        return {
          status: 'failed',
          error: new LocalRuntimeTerminalError(
            this.staged.event.event_id,
            this.staged.event,
            this.isRuntimeErrorRetryable,
          ),
        };
    }
  }

  failedEvent(context: AgentEventContext, error: unknown): RuntimeEvent {
    return this.staged?.outcome === 'failed'
      ? this.staged.event
      : buildHostFailedEvent(context, error);
  }
}

class TerminalConfirmation {
  private outcome: AgentHostTurnOutcome['status'] | undefined;

  observe(event: RuntimeEvent, result: AgentEventResult): void {
    if (!result.terminal) return;
    const eventOutcome = terminalEventOutcome(event);
    if (!eventOutcome || eventOutcome !== result.outcome) {
      throw new AgentTerminalConfirmationError('event-mismatch', eventOutcome, result.outcome);
    }
    if (this.outcome && this.outcome !== result.outcome) {
      throw new AgentTerminalConfirmationError('conflict', this.outcome, result.outcome);
    }
    this.outcome = result.outcome;
  }

  confirm(outcome: AgentHostTurnOutcome): void {
    if (!this.outcome) {
      throw new AgentTerminalConfirmationError('missing', outcome.status);
    }
    if (this.outcome !== outcome.status) {
      throw new AgentTerminalConfirmationError('outcome-mismatch', outcome.status, this.outcome);
    }
  }
}

type Captured<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: unknown;
    };

async function capture<T>(operation: () => Promise<T>): Promise<Captured<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

function captureSync<T>(operation: () => T): Captured<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

function normalizeHistoryMessagePayloads(change: CanonicalHistoryChange): CanonicalHistoryChange {
  const messages = jsonRoundTrip(change.messages);
  if (change.previousMessages === undefined) return { ...change, messages };
  return {
    ...change,
    messages,
    previousMessages: jsonRoundTrip(change.previousMessages),
  };
}

function jsonRoundTrip<T>(value: T): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('History messages must be JSON-serializable.');
    }
    return JSON.parse(serialized) as T;
  } catch {
    throw new TypeError('History messages must be JSON-serializable.');
  }
}

function compactFailures(results: readonly Captured<unknown>[]): readonly unknown[] {
  return results.flatMap((result) => (result.ok ? [] : flattenFailure(result.error)));
}

function flattenFailure(error: unknown): readonly unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(flattenFailure) : [error];
}

function throwFailures(failures: readonly unknown[], message: string): never {
  const unique = [...new Set(failures)];
  if (unique.length === 1) throw unique[0];
  throw new AggregateError(unique, message);
}

function validateRuntimeAssociation(context: AgentEventContext, event: RuntimeEvent): void {
  assertAssociation('sessionId', context.sessionId, event.session_id);
  if (event.turn_id !== undefined) {
    assertAssociation('turnId', context.turnId, event.turn_id);
  }
}

function validateHistoryAssociation(
  context: AgentEventContext,
  change: CanonicalHistoryChange,
): void {
  assertAssociation('sessionId', context.sessionId, change.sessionId);
  assertAssociation('turnId', context.turnId, change.turnId);
}

function assertAssociation(
  field: AgentEventAssociationError['field'],
  expected: string,
  actual: string,
): void {
  if (expected !== actual) {
    throw new AgentEventAssociationError(field, expected, actual);
  }
}

function validateHistoryOperation(
  change: CanonicalHistoryChange & {
    readonly operation: HistoryCommitOperation;
  },
  turnId: string,
  allowHostReservedOperation: boolean,
): void {
  const operationId = change.operation.id;
  if (!operationId.trim()) {
    throw new AgentHistoryOperationIdentityError('missing-id', operationId);
  }
  if (!allowHostReservedOperation && operationId.startsWith(`agent-host:${turnId}:history:`)) {
    throw new AgentHistoryOperationIdentityError('reserved-id', operationId);
  }
  const expectedAppend = change.reason === 'messageDelta';
  const actualAppend = change.operation.kind === 'append';
  if (expectedAppend !== actualAppend) {
    throw new AgentHistoryOperationIdentityError('kind-mismatch', operationId);
  }
}

function fallbackHistoryOperation(
  turnId: string,
  sequence: number,
  change: CanonicalHistoryChange,
): HistoryCommitOperation {
  const compaction = readCompactionLifecycleMetadata(change.metadata);
  if (change.reason === 'replaceMessages' && compaction) {
    return {
      id: `${turnId}:history:compaction:${encodeURIComponent(compaction.compactionId)}`,
      kind: 'compaction',
    };
  }
  return {
    id: `${turnId}:history:${sequence}`,
    kind: change.reason === 'messageDelta' ? 'append' : 'replace',
  };
}

function reconcileMutation(
  lease: AcceptedTurnLease,
  intent: HistoryReconcileIntent,
): TurnHistoryMutation {
  if (intent.kind === 'output-recall') {
    const reason =
      intent.source === 'input-review'
        ? ({ kind: 'input-safety-recall' } as const)
        : ({ kind: 'output-final-recall' } as const);
    return {
      kind: 'retract-turn',
      sessionId: lease.sessionId,
      turnId: lease.turnId,
      reason,
      operation: {
        id: `agent-host:${lease.turnId}:history:${reason.kind}`,
        kind: 'output-recall',
        variant: intent.variant,
      },
    };
  }
  const mode = intent.kind === 'abort-reconcile' ? 'abort' : 'network';
  return {
    kind: 'settle-turn-tail',
    sessionId: lease.sessionId,
    turnId: lease.turnId,
    mode,
    approvedContent: intent.approvedContent,
    operation: {
      id: `agent-host:${lease.turnId}:history:${intent.kind}`,
      kind: intent.kind,
      ...(mode === 'network' ? { variant: 'network' } : {}),
    },
  };
}

function retractMutation(
  lease: AcceptedTurnLease,
  operation: HistoryCommitOperation,
  attempt: number,
): TurnHistoryMutation {
  return {
    kind: 'retract-turn',
    sessionId: lease.sessionId,
    turnId: lease.turnId,
    reason: { kind: 'output-attempt-recall', attempt },
    operation,
  };
}

function isNonNormalTerminalRuntimeEvent(event: RuntimeEvent): boolean {
  const outcome = terminalEventOutcome(event);
  return outcome === 'failed' || outcome === 'aborted';
}

function terminalEventOutcome(event: RuntimeEvent): AgentHostTurnOutcome['status'] | undefined {
  if (
    event.type !== RuntimeEventType.SESSION_STATUS &&
    event.type !== RuntimeEventType.TURN_TERMINAL
  ) {
    return undefined;
  }
  switch (event.payload.status) {
    case RuntimeEventStatus.COMPLETED:
      return 'completed';
    case RuntimeEventStatus.FAILED:
      return 'failed';
    case RuntimeEventStatus.ABORTED:
      return 'aborted';
    default:
      return undefined;
  }
}

function terminalMessage(event: RuntimeEvent): string | undefined {
  const stopReason = event.payload.stop_reason;
  if (stopReason?.message?.trim()) return stopReason.message.trim();
  const error = event.payload.error;
  return error?.message?.trim() ? error.message.trim() : undefined;
}

function terminalConfirmationMessage(
  reason: AgentTerminalConfirmationError['reason'],
  expected: string | undefined,
  actual: string | undefined,
): string {
  if (reason === 'missing') {
    return `Agent runner settled as ${expected ?? 'unknown'} without a handled terminal event.`;
  }
  return `Agent terminal confirmation ${reason}: expected ${expected ?? 'none'}, received ${actual ?? 'none'}.`;
}
