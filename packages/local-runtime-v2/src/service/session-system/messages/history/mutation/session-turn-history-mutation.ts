import {
  canonicalActiveHistoryRevision,
  inspectCanonicalHistorySequence,
  type CanonicalHistoryEnvelope,
} from '../../../sessions/representation/canonical-history-contract.js';
import { sanitizePtcSafetyHistoryMessage } from '../../ptc/safety-reconcile.js';

export interface SessionHistorySnapshot {
  readonly generation: number;
  readonly fileName: string;
  readonly revision: string;
  readonly records: readonly CanonicalHistoryEnvelope[];
}

export interface SettleTurnTailInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly operationId: string;
  readonly mode: 'abort' | 'network' | 'safety';
  readonly approvedContent: string;
}

export type RetractTurnReason =
  | { readonly kind: 'input-safety-recall' }
  | { readonly kind: 'output-attempt-recall'; readonly attempt: number }
  | { readonly kind: 'output-final-recall' }
  | { readonly kind: 'fatal' };

export interface RetractTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly operationId: string;
  readonly reason: RetractTurnReason;
}

export interface SessionTurnHistoryMutationCommit {
  readonly status: 'committed' | 'unchanged' | 'already-retracted';
  readonly revision: string;
  readonly generation: number;
  readonly messages: readonly unknown[];
  readonly identityVector: readonly string[];
  readonly deletedMessageIds: readonly string[];
}

interface SettleTurnTailPlan {
  readonly status: 'committed' | 'unchanged';
  readonly active: readonly CanonicalHistoryEnvelope[];
  readonly deletedMessageIds: readonly string[];
}

interface RetractTurnPlan {
  readonly status: 'committed' | 'already-retracted';
  readonly generation: number;
  readonly active: readonly CanonicalHistoryEnvelope[];
  readonly snapshots: readonly SessionHistorySnapshot[];
  readonly deletedMessageIds: readonly string[];
}

interface RetractTurnHistory {
  readonly activeGeneration: number;
  readonly active: readonly CanonicalHistoryEnvelope[];
  readonly snapshots: readonly SessionHistorySnapshot[];
}

/** Plans the existing abort/network tail fold against the latest envelopes. */
export function planSettleTurnTail(
  active: readonly CanonicalHistoryEnvelope[],
  input: SettleTurnTailInput,
): SettleTurnTailPlan {
  assertMutationIdentity(input);
  if (input.mode === 'safety') return planSafetyTurnTail(active, input);
  const last = active.at(-1);
  if (!last || last.turn_id !== input.turnId || last.message.role !== 'assistant') {
    return unchangedSettle(active);
  }
  if (input.mode === 'abort' && containsToolCall(last.message.content)) {
    return unchangedSettle(active);
  }
  const next = [...active];
  const approvedContent = input.approvedContent;
  const deletedMessageIds: string[] = [];
  if (!approvedContent.trim()) {
    next.pop();
    deletedMessageIds.push(last.message_id);
  } else {
    next[next.length - 1] = {
      ...last,
      message: {
        ...last.message,
        content: [{ type: 'text', text: approvedContent }],
      },
    };
  }
  if (sameJson(active, next)) return unchangedSettle(active);
  assertSettled(next, 'Turn tail settlement');
  return { status: 'committed', active: next, deletedMessageIds };
}

function planSafetyTurnTail(
  active: readonly CanonicalHistoryEnvelope[],
  input: SettleTurnTailInput,
): SettleTurnTailPlan {
  if (active.at(-1)?.turn_id !== input.turnId) return unchangedSettle(active);
  const deletedMessageIds: string[] = [];
  const next = active.flatMap((record) => {
    if (record.turn_id !== input.turnId) return [record];
    const message = sanitizePtcSafetyHistoryMessage(record.message);
    if (message) return [{ ...record, message }];
    deletedMessageIds.push(record.message_id);
    return [];
  });
  if (sameJson(active, next)) return unchangedSettle(active);
  assertSettled(next, 'Safety Turn tail settlement');
  return { status: 'committed', active: next, deletedMessageIds };
}

/** Plans a target-Turn suffix removal across the reachable compaction lineage. */
export function planRetractTurn(
  history: RetractTurnHistory,
  input: RetractTurnInput,
): RetractTurnPlan {
  validateRetractTurnInput(input);
  const artifacts = [
    ...history.snapshots.map((snapshot) => ({
      generation: snapshot.generation,
      records: snapshot.records,
      snapshot,
    })),
    { generation: history.activeGeneration, records: history.active },
  ];
  const artifactIndex = artifacts.findIndex(({ records }) =>
    records.some(({ turn_id }) => turn_id === input.turnId),
  );
  if (artifactIndex < 0) {
    if (containsCompactionMarker(artifacts, input.turnId)) {
      throw new Error('Retracted Turn source boundary is missing from canonical history');
    }
    return {
      status: 'already-retracted',
      generation: history.activeGeneration,
      active: history.active,
      snapshots: history.snapshots,
      deletedMessageIds: [],
    };
  }
  assertTargetIsCurrentTail(history.active, input.turnId);
  const target = artifacts[artifactIndex];
  if (!target) throw new Error('Retracted Turn source boundary is missing from canonical history');
  const firstTargetIndex = target.records.findIndex(({ turn_id }) => turn_id === input.turnId);
  const targetSuffix = target.records.slice(firstTargetIndex);
  if (targetSuffix.some(({ turn_id }) => turn_id !== input.turnId)) {
    throw new Error('Retracted Turn is not the canonical history tail');
  }
  const active = target.records.slice(0, firstTargetIndex);
  assertSettled(active, 'Turn retraction prefix');
  if (target.generation > 0 && active.length === 0) {
    throw new Error('Turn retraction cannot preserve a non-zero generation without its marker');
  }
  return {
    status: 'committed',
    generation: target.generation,
    active,
    snapshots: history.snapshots.slice(0, Math.min(artifactIndex, history.snapshots.length)),
    deletedMessageIds: deletedTurnMessageIds(
      artifacts.slice(artifactIndex).flatMap(({ records }) => records),
      input.turnId,
    ),
  };
}

export function validateRetractTurnInput(input: RetractTurnInput): void {
  assertMutationIdentity(input);
  assertRetractReason(input.reason);
}

export function toTurnHistoryMutationCommit(input: {
  readonly status: SessionTurnHistoryMutationCommit['status'];
  readonly generation: number;
  readonly active: readonly CanonicalHistoryEnvelope[];
  readonly deletedMessageIds: readonly string[];
}): SessionTurnHistoryMutationCommit {
  return {
    status: input.status,
    revision: canonicalActiveHistoryRevision(input.active),
    generation: input.generation,
    messages: input.active.map(({ message }) => structuredClone(message)),
    identityVector: input.active.map(({ message_id }) => message_id),
    deletedMessageIds: [...input.deletedMessageIds],
  };
}

function assertMutationIdentity(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly operationId: string;
}): void {
  if (!input.sessionId.trim() || !input.turnId.trim() || !input.operationId.trim()) {
    throw new TypeError('Turn history mutation identity is required');
  }
}

function assertRetractReason(reason: RetractTurnReason): void {
  if (
    reason.kind === 'output-attempt-recall' &&
    (!Number.isSafeInteger(reason.attempt) || reason.attempt < 1)
  ) {
    throw new TypeError('Output recall attempt must be a positive safe integer');
  }
}

function unchangedSettle(active: readonly CanonicalHistoryEnvelope[]): SettleTurnTailPlan {
  return { status: 'unchanged', active, deletedMessageIds: [] };
}

function containsToolCall(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        !Array.isArray(block) &&
        Reflect.get(block, 'type') === 'toolCall',
    )
  );
}

function containsCompactionMarker(
  artifacts: readonly { readonly records: readonly CanonicalHistoryEnvelope[] }[],
  turnId: string,
): boolean {
  const markerTurnId = `${turnId}:compaction`;
  return artifacts.some(({ records }) => records.some(({ turn_id }) => turn_id === markerTurnId));
}

function assertTargetIsCurrentTail(
  active: readonly CanonicalHistoryEnvelope[],
  turnId: string,
): void {
  const markerTurnId = `${turnId}:compaction`;
  const boundary = active.findIndex(
    ({ turn_id }) => turn_id === turnId || turn_id === markerTurnId,
  );
  if (
    boundary < 0 ||
    active.slice(boundary).some(({ turn_id }) => turn_id !== turnId && turn_id !== markerTurnId)
  ) {
    throw new Error('Retracted Turn is not the canonical history tail');
  }
}

function deletedTurnMessageIds(
  records: readonly CanonicalHistoryEnvelope[],
  turnId: string,
): readonly string[] {
  const markerTurnId = `${turnId}:compaction`;
  return [
    ...new Set(
      records
        .filter(({ turn_id }) => turn_id === turnId || turn_id === markerTurnId)
        .map(({ message_id }) => message_id),
    ),
  ];
}

function assertSettled(records: readonly CanonicalHistoryEnvelope[], operation: string): void {
  if (inspectCanonicalHistorySequence(records).status !== 'settled') {
    throw new Error(`${operation} must produce settled canonical history`);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
