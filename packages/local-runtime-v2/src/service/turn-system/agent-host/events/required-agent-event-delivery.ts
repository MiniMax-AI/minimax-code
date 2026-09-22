import {
  RUNTIME_EVENT_SCHEMA,
  RuntimeEventStatus,
  RuntimeEventType,
  type RuntimeEvent,
} from '@mavis/agent-core/protocol';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';

import type { AgentHostHistoryFailure, CommittedHistoryChange } from '../history/contracts.js';
import type { AgentHostTurnOutcome } from '../runner/contracts.js';
import {
  AgentHostDependencyUnavailableError,
  assertAgentHostCapabilityAvailable,
} from '../empty-dependencies.js';
import { AgentEventAssociationError } from '../local-agent-host.js';
import { captureSemanticSnapshot } from '../history/semantic-identity.js';
import { SemanticReplayRegistry } from './semantic-replay-registry.js';
import type { AgentEventContext, AgentEventDelivery, AgentEventResult } from './contracts.js';

const DEFAULT_MAX_TRACKED_IDENTITIES = 4_096;
type ObservationStage = 'runtime-event' | 'history-committed' | 'history-failure';

interface RuntimeProjectionInput {
  readonly context: AgentEventContext;
  readonly event: RuntimeEvent;
  /** Process-local control; excluded from semantic snapshots and replay identities. */
  readonly signal?: AbortSignal;
}

interface HistoryProjectionInput {
  readonly context: AgentEventContext;
  readonly change: CommittedHistoryChange;
}

export interface RequiredAgentRuntimeProjector {
  projectRuntimeEvent(input: RuntimeProjectionInput): Promise<AgentEventResult | void>;
}

export interface RequiredAgentHistoryProjector {
  projectHistoryCommitted(input: HistoryProjectionInput): Promise<void>;
}

export interface RequiredAgentEventProjector
  extends RequiredAgentRuntimeProjector, RequiredAgentHistoryProjector {}

export interface RequiredAgentEventProjectors {
  readonly session: RequiredAgentRuntimeProjector;
  readonly messages: RequiredAgentEventProjector;
  readonly stream: RequiredAgentRuntimeProjector;
  readonly turnFacts: RequiredAgentEventProjector;
}

export interface AgentHistoryFailureProjector {
  projectHistoryFailure(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly metadata?: unknown;
  }): Promise<void>;
}

export interface AgentEventBestEffortObserver {
  observeRuntimeEvent?(input: RuntimeProjectionInput): Promise<void> | void;
  observeHistoryCommitted?(input: HistoryProjectionInput): Promise<void> | void;
  observeHistoryFailure?(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly metadata?: unknown;
  }): Promise<void> | void;
}

export interface RequiredAgentEventDeliveryOptions {
  readonly projectors: RequiredAgentEventProjectors;
  readonly historyFailures?: AgentHistoryFailureProjector;
  readonly observer?: AgentEventBestEffortObserver;
  readonly onObservationFailure?: (input: {
    readonly stage: ObservationStage;
    readonly sessionId: string;
    readonly turnId: string;
    readonly error: unknown;
  }) => void;
  readonly maxTrackedIdentities?: number;
}

export class AgentEventIdentityConflictError extends Error {
  override readonly name = 'AgentEventIdentityConflictError';

  constructor(
    readonly kind: 'runtime-event' | 'history-committed',
    readonly identity: string,
  ) {
    super(`Agent ${kind} identity collision: ${identity}.`);
  }
}

export class AgentEventSequenceError extends Error {
  override readonly name = 'AgentEventSequenceError';

  constructor(
    readonly kind: 'turn-sequence' | 'runtime-sequence',
    readonly expectedGreaterThan: number,
    readonly actual: number,
  ) {
    super(`Agent ${kind} must be greater than ${expectedGreaterThan}; received ${actual}.`);
  }
}

export class AgentEventValidationError extends Error {
  override readonly name = 'AgentEventValidationError';

  constructor(readonly field: string) {
    super(`Agent event ${field} is invalid.`);
  }
}

export class AgentEventAcknowledgementError extends Error {
  override readonly name = 'AgentEventAcknowledgementError';

  constructor(
    readonly expected: AgentHostTurnOutcome['status'] | 'non-terminal',
    readonly actual: AgentHostTurnOutcome['status'] | 'non-terminal' | 'missing' | 'invalid',
  ) {
    super(`Agent event acknowledgement mismatch: expected ${expected}, received ${actual}.`);
  }
}

export class AgentHistoryFailureValidationError extends Error {
  override readonly name = 'AgentHistoryFailureValidationError';

  constructor(readonly field: 'sessionId' | 'turnId') {
    super(`Agent history failure ${field} is invalid.`);
  }
}

interface SessionTurnFence {
  readonly turnSequence: number;
  readonly turnId: string;
}

/**
 * Turn-owned durable event pipeline. Every required projector is awaited in a
 * per-Session lane; UI/observability callbacks are explicitly best-effort.
 */
export class RequiredAgentEventDelivery implements AgentEventDelivery, AgentHostHistoryFailure {
  private readonly lane = new KeyedOperationLane<string>();
  private readonly runtimeReplays: SemanticReplayRegistry<AgentEventResult>;
  private readonly historyReplays: SemanticReplayRegistry<void>;
  private readonly sessionFences = new Map<string, SessionTurnFence>();
  private readonly runtimeSequences = new Map<string, number>();
  private readonly observations = new WeakSet<Promise<void>>();

  constructor(private readonly options: RequiredAgentEventDeliveryOptions) {
    validateProjectors(options.projectors);
    const maximum = options.maxTrackedIdentities ?? DEFAULT_MAX_TRACKED_IDENTITIES;
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new AgentEventValidationError('maxTrackedIdentities');
    }
    this.runtimeReplays = new SemanticReplayRegistry(maximum);
    this.historyReplays = new SemanticReplayRegistry(maximum);
  }

  handleRuntimeEvent(
    context: AgentEventContext,
    event: RuntimeEvent,
    signal?: AbortSignal,
  ): Promise<AgentEventResult> {
    try {
      const snapshot = captureSemanticSnapshot({ context, event });
      validateRuntimeInput(snapshot.value.context, snapshot.value.event);
      const identity = runtimeIdentity(snapshot.value.context, snapshot.value.event.event_id);
      return this.runtimeReplays.run({
        identity,
        fingerprint: snapshot.fingerprint,
        conflict: () => new AgentEventIdentityConflictError('runtime-event', identity),
        execute: () =>
          this.lane.run(snapshot.value.context.sessionId, () =>
            this.projectRuntime(snapshot.value.context, snapshot.value.event, signal),
          ),
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  handleHistoryCommitted(
    context: AgentEventContext,
    change: CommittedHistoryChange,
  ): Promise<void> {
    try {
      const snapshot = captureSemanticSnapshot({ context, change });
      validateHistoryInput(snapshot.value.context, snapshot.value.change);
      const identity = historyIdentity(snapshot.value.context, snapshot.value.change);
      return this.historyReplays.run({
        identity,
        fingerprint: snapshot.replayFingerprint,
        conflict: () => new AgentEventIdentityConflictError('history-committed', identity),
        execute: () =>
          this.lane.run(snapshot.value.context.sessionId, () =>
            this.projectHistory(snapshot.value.context, snapshot.value.change),
          ),
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  fail(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly metadata?: unknown;
  }): Promise<void> {
    try {
      const snapshot = captureSemanticSnapshot(input).value;
      validateHistoryFailure(snapshot);
      const projector = this.options.historyFailures;
      if (typeof projector?.projectHistoryFailure !== 'function') {
        throw new AgentHostDependencyUnavailableError('history-failure-projector');
      }
      return this.lane.run(snapshot.sessionId, async () => {
        await projector.projectHistoryFailure(snapshot);
        this.observe('history-failure', snapshot, () =>
          this.options.observer?.observeHistoryFailure?.(snapshot),
        );
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async projectRuntime(
    context: AgentEventContext,
    event: RuntimeEvent,
    signal?: AbortSignal,
  ): Promise<AgentEventResult> {
    const runtimeSequence = this.validateSequence(context, event);
    const authoritative = await this.options.projectors.session.projectRuntimeEvent({
      context,
      event,
    });
    if (!authoritative) {
      throw new AgentEventAcknowledgementError(terminalOutcome(event) ?? 'non-terminal', 'missing');
    }
    validateAcknowledgement(event, authoritative);
    await this.options.projectors.messages.projectRuntimeEvent({
      context,
      event,
      ...(signal ? { signal } : {}),
    });
    await this.options.projectors.stream.projectRuntimeEvent({ context, event });
    await this.options.projectors.turnFacts.projectRuntimeEvent({ context, event });
    this.commitSequence(context, runtimeSequence);
    this.observe('runtime-event', context, () =>
      this.options.observer?.observeRuntimeEvent?.({ context, event }),
    );
    return authoritative;
  }

  private async projectHistory(
    context: AgentEventContext,
    change: CommittedHistoryChange,
  ): Promise<void> {
    this.validateTurnFence(context);
    await this.options.projectors.messages.projectHistoryCommitted({ context, change });
    await this.options.projectors.turnFacts.projectHistoryCommitted({ context, change });
    this.commitTurnFence(context);
    this.observe('history-committed', context, () =>
      this.options.observer?.observeHistoryCommitted?.({ context, change }),
    );
  }

  private validateSequence(context: AgentEventContext, event: RuntimeEvent): number | undefined {
    this.validateTurnFence(context);
    const runtimeSequence = parseRuntimeSequence(event.runtime_seq);
    if (runtimeSequence === undefined) return undefined;
    const key = turnIdentity(context);
    const previous = this.runtimeSequences.get(key);
    if (previous !== undefined && runtimeSequence <= previous) {
      throw new AgentEventSequenceError('runtime-sequence', previous, runtimeSequence);
    }
    return runtimeSequence;
  }

  private validateTurnFence(context: AgentEventContext): void {
    const previous = this.sessionFences.get(context.sessionId);
    if (previous && context.turnSequence < previous.turnSequence) {
      throw new AgentEventSequenceError(
        'turn-sequence',
        previous.turnSequence,
        context.turnSequence,
      );
    }
    if (
      previous &&
      context.turnSequence === previous.turnSequence &&
      context.turnId !== previous.turnId
    ) {
      throw new AgentEventSequenceError(
        'turn-sequence',
        previous.turnSequence,
        context.turnSequence,
      );
    }
  }

  private commitSequence(context: AgentEventContext, runtimeSequence: number | undefined): void {
    this.commitTurnFence(context);
    if (runtimeSequence !== undefined) {
      this.runtimeSequences.set(turnIdentity(context), runtimeSequence);
    }
  }

  private commitTurnFence(context: AgentEventContext): void {
    const previous = this.sessionFences.get(context.sessionId);
    if (!previous || context.turnSequence > previous.turnSequence) {
      this.sessionFences.set(context.sessionId, {
        turnSequence: context.turnSequence,
        turnId: context.turnId,
      });
    }
  }

  private observe(
    stage: ObservationStage,
    identity: { readonly sessionId: string; readonly turnId: string },
    operation: () => Promise<void> | void | undefined,
  ): void {
    // Intentionally detached: graceful shutdown does not drain product
    // observers such as an in-flight Channel final reply. We accept the rare
    // lost external reply instead of coupling durable Turn settlement to an
    // outbox or a second shutdown-drain protocol.
    const observation = this.runObservation(stage, identity, operation);
    this.observations.add(observation);
  }

  private async runObservation(
    stage: ObservationStage,
    identity: { readonly sessionId: string; readonly turnId: string },
    operation: () => Promise<void> | void | undefined,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      try {
        this.options.onObservationFailure?.({
          stage,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          error,
        });
      } catch {
        // A best-effort diagnostics reporter cannot escape into the required path.
      }
    }
  }
}

function validateProjectors(projectors: RequiredAgentEventProjectors): void {
  const runtimeEntries = [
    ['session-event-projector', projectors?.session],
    ['message-event-projector', projectors?.messages],
    ['stream-event-projector', projectors?.stream],
    ['turn-fact-event-projector', projectors?.turnFacts],
  ] as const;
  runtimeEntries.forEach(([capability, projector]) => {
    assertAgentHostCapabilityAvailable(
      capability,
      typeof projector?.projectRuntimeEvent === 'function',
    );
  });
  assertAgentHostCapabilityAvailable(
    'message-history-projector',
    typeof projectors?.messages?.projectHistoryCommitted === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'turn-fact-event-projector',
    typeof projectors?.turnFacts?.projectHistoryCommitted === 'function',
  );
}

function validateRuntimeInput(context: AgentEventContext, event: RuntimeEvent): void {
  validateContext(context);
  if (event.schema !== RUNTIME_EVENT_SCHEMA) throw new AgentEventValidationError('schema');
  requireNonEmpty(event.event_id, 'event_id');
  assertAssociation('sessionId', context.sessionId, event.session_id);
  if (event.turn_id !== undefined) {
    assertAssociation('turnId', context.turnId, event.turn_id);
  }
  parseRuntimeSequence(event.runtime_seq);
}

function validateHistoryInput(context: AgentEventContext, change: CommittedHistoryChange): void {
  validateContext(context);
  assertAssociation('sessionId', context.sessionId, change.sessionId);
  assertAssociation('turnId', context.turnId, change.turnId);
  requireNonEmpty(change.committedRevision, 'committedRevision');
  requireNonEmpty(change.operation.id, 'operation.id');
  if (!Array.isArray(change.messages) || !Array.isArray(change.committedMessages)) {
    throw new AgentEventValidationError('history.messages');
  }
}

function validateContext(context: AgentEventContext): void {
  requireNonEmpty(context.sessionId, 'context.sessionId');
  requireNonEmpty(context.turnId, 'context.turnId');
  if (!Number.isSafeInteger(context.turnSequence) || context.turnSequence <= 0) {
    throw new AgentEventValidationError('context.turnSequence');
  }
}

function validateHistoryFailure(input: {
  readonly sessionId: string;
  readonly turnId: string;
}): void {
  if (!input.sessionId.trim()) throw new AgentHistoryFailureValidationError('sessionId');
  if (!input.turnId.trim()) throw new AgentHistoryFailureValidationError('turnId');
}

function validateAcknowledgement(event: RuntimeEvent, result: AgentEventResult): void {
  const expected = terminalOutcome(event);
  const actual = acknowledgementOutcome(result);
  if (expected === undefined && result.terminal === false) return;
  if (expected !== undefined && result.terminal === true && expected === result.outcome) return;
  throw new AgentEventAcknowledgementError(expected ?? 'non-terminal', actual);
}

function acknowledgementOutcome(
  result: AgentEventResult,
): AgentEventAcknowledgementError['actual'] {
  if (result.terminal === true) return result.outcome;
  if (result.terminal === false) return 'non-terminal';
  return 'invalid';
}

function terminalOutcome(event: RuntimeEvent): AgentHostTurnOutcome['status'] | undefined {
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

function runtimeIdentity(context: AgentEventContext, eventId: string): string {
  return `${turnIdentity(context)}\u0000runtime:${eventId}`;
}

function historyIdentity(context: AgentEventContext, change: CommittedHistoryChange): string {
  return `${turnIdentity(context)}\u0000history:${requireNonEmpty(
    change.operation.id,
    'operation.id',
  )}`;
}

function turnIdentity(context: AgentEventContext): string {
  return `${context.sessionId}\u0000${context.turnSequence}\u0000${context.turnId}`;
}

function assertAssociation(
  field: AgentEventAssociationError['field'],
  expected: string,
  actual: string,
): void {
  if (expected !== actual) throw new AgentEventAssociationError(field, expected, actual);
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AgentEventValidationError(field);
  return value;
}

function parseRuntimeSequence(value: RuntimeEvent['runtime_seq']): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AgentEventValidationError('runtime_seq');
  }
  return parsed;
}
