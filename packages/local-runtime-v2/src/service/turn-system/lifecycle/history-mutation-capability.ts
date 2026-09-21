import { createHash } from 'node:crypto';

import type {
  HistoryForkInput,
  HistoryForkResult,
  HistoryRewindInput,
  HistoryRewindResult,
  TurnDiffRewindOutcome,
  TurnDiffRewindSkipEvent,
  TurnForkProjectionCapability,
  TurnRewindProjectionCapability,
} from '../contracts.js';
import {
  canonicalActiveHistoryRevision,
  inspectCanonicalHistorySequence,
  type CanonicalHistoryEnvelope,
  type SessionHistoryMutationCapability,
  type SessionHistorySnapshot,
  type StagedSessionHistoryRewind,
} from '../../session-system/index.js';
import { readBackgroundTaskOriginMetadata } from '../agent-host/history/background/host-metadata.js';
import { BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE } from '../agent-host/history/background/reminder-protocol.js';
import { isBackgroundTaskReadSettlement } from '../agent-host/history/background/task-read-settlement.js';
import { appendCompactionState, readCompactionCompatibility } from '../compaction/compat.js';

export interface HistoryMutationCapabilityOptions {
  readonly sessions: SessionHistoryMutationCapability;
  readonly forkProjections: TurnForkProjectionCapability;
  readonly rewindProjections: TurnRewindProjectionCapability;
  readonly activeTurnId?: (sessionId: string) => string | undefined;
  readonly boundaryWaitTimeoutMs?: number;
  readonly onTurnDiffRewindSkipped?: (event: TurnDiffRewindSkipEvent) => void;
}

const DEFAULT_BOUNDARY_WAIT_TIMEOUT_MS = 5_000;

export type HistoryMutationErrorCode =
  | 'boundary-not-found'
  | 'boundary-invalid'
  | 'identity-conflict'
  | 'chain-corrupt';

export class HistoryMutationError extends Error {
  constructor(
    readonly code: HistoryMutationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HistoryMutationError';
  }
}

interface RewindOperationData {
  readonly schemaVersion: 1;
  readonly fromUserMessageIdInclusive: string;
  readonly rewindTurnDiff: boolean;
  readonly displayOnlyBoundary?: HistoryRewindInput['displayOnlyBoundary'];
  readonly deletedMessageIds: readonly string[];
  readonly affectedTurnIds: readonly string[];
  readonly fullyDeletedTurnIds: readonly string[];
  readonly partiallyRetainedTurnIds: readonly string[];
}

interface RewindPlan extends RewindOperationData {
  readonly sourceGeneration: number;
  readonly generation: number;
  readonly active: readonly CanonicalHistoryEnvelope[];
  readonly snapshots: readonly SessionHistorySnapshot[];
  readonly sourceRevision: string;
}

export function createHistoryMutationCapability(options: HistoryMutationCapabilityOptions): {
  fork(input: HistoryForkInput): Promise<HistoryForkResult>;
  rewind(input: HistoryRewindInput): Promise<HistoryRewindResult>;
} {
  return {
    fork: (input) => fork(options, input),
    rewind: (input) => rewind(options, input),
  };
}

async function fork(
  options: HistoryMutationCapabilityOptions,
  input: HistoryForkInput,
): Promise<HistoryForkResult> {
  const inclusiveBoundary = input.throughMessageId ?? input.throughAssistantMessageId;
  const boundary = inclusiveBoundary ?? input.beforeUserMessageId;
  const source = await readBoundarySource(
    options,
    input.sourceSessionId,
    boundary,
    input.beforeUserMessageId,
  );
  const sourceArtifact = findForkArtifact(source, boundary, Boolean(input.throughMessageId));
  if (!sourceArtifact) boundaryNotFound(boundary);
  const index = boundary
    ? sourceArtifact.records.findIndex((envelope) => envelope.message_id === boundary)
    : sourceArtifact.records.length;
  if (index < 0) boundaryNotFound(boundary);
  const prefixEnd = inclusiveBoundary ? index + 1 : index;
  const prefix = withoutSourceBackgroundReminders(sourceArtifact.records.slice(0, prefixEnd));
  if (boundary && !isSettledPrefix(prefix)) {
    throw new HistoryMutationError('boundary-invalid', 'History fork target prefix is not settled');
  }
  const active = createForkActiveHistory(prefix, input);
  const snapshots = source.snapshots
    .filter((snapshot) => snapshot.generation < sourceArtifact.generation)
    // Ancestor snapshots are immutable, revision-linked archives, not live context.
    // Filter only the selected active prefix above, including forks into an archive.
    .map(copySnapshot);
  const staged = await options.sessions.stageFork({
    ...input,
    generation: sourceArtifact.generation,
    active,
    snapshots,
  });
  await staged.publish();
  await options.forkProjections.forkPrefix({
    operationId: input.operationId,
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
    targetWorkspaceDir: input.targetWorkspaceDir,
    ...(input.rewindTargetWorkspace ? { rewindTargetWorkspace: true } : {}),
    retainedTurnIds: unique(
      [...snapshots.flatMap((snapshot) => snapshot.records), ...prefix].map(
        (envelope) => envelope.turn_id,
      ),
    ),
  });
  return {
    generation: sourceArtifact.generation,
    historyRevision: canonicalActiveHistoryRevision(active),
  };
}

function createForkActiveHistory(
  prefix: readonly CanonicalHistoryEnvelope[],
  input: HistoryForkInput,
): CanonicalHistoryEnvelope[] {
  return [
    ...prefix,
    ...(input.continuation
      ? [createContinuationEnvelope(input.operationId, input.continuation)]
      : []),
    ...(input.hiddenContextBoundary
      ? [createHiddenContextBoundaryEnvelope(input.operationId, input.hiddenContextBoundary)]
      : []),
  ];
}

async function rewind(
  options: HistoryMutationCapabilityOptions,
  input: HistoryRewindInput,
): Promise<HistoryRewindResult> {
  const resumed = await options.sessions.resumeRewind?.({
    sessionId: input.sessionId,
    operationId: input.operationId,
  });
  if (resumed) return resumeRewind(options, input, resumed);

  const plan = await planRewind(options, input);
  const turnDiffRewind = await rewindTurnDiffBestEffort(options, input, plan);
  const staged = await options.sessions.stageRewind({
    sessionId: input.sessionId,
    operationId: input.operationId,
    expectedRevision: plan.sourceRevision,
    sourceGeneration: plan.sourceGeneration,
    generation: plan.generation,
    active: plan.active,
    snapshots: plan.snapshots,
    operationData: operationData(plan),
  });
  await staged.publish();
  return finishRewind(options, input, plan, turnDiffRewind);
}

async function resumeRewind(
  options: HistoryMutationCapabilityOptions,
  input: HistoryRewindInput,
  staged: StagedSessionHistoryRewind,
): Promise<HistoryRewindResult> {
  const data = decodeOperationData(staged.operationData);
  assertMatchingRewindRequest(input, data);
  const turnDiffRewind = await rewindTurnDiffBestEffort(options, input, data);
  await staged.publish({ allowRevisionChange: true });
  return finishRewind(
    options,
    input,
    {
      ...data,
      sourceGeneration: staged.sourceGeneration ?? staged.generation,
      generation: staged.generation,
      active: staged.active,
      snapshots: staged.snapshots,
      sourceRevision: staged.sourceRevision,
    },
    turnDiffRewind,
  );
}

async function finishRewind(
  options: HistoryMutationCapabilityOptions,
  input: HistoryRewindInput,
  plan: RewindPlan,
  turnDiffRewind: TurnDiffRewindOutcome,
): Promise<HistoryRewindResult> {
  try {
    await options.rewindProjections.deleteTurns({
      sessionId: input.sessionId,
      turnIds: plan.affectedTurnIds,
    });
  } catch {
    // Canonical history is already published. Derived cleanup is best-effort so
    // a stale projection cannot keep the Session operation running forever.
  }
  return {
    generation: plan.generation,
    historyRevision: canonicalActiveHistoryRevision(plan.active),
    deletedMessageIds: plan.deletedMessageIds,
    affectedTurnIds: plan.affectedTurnIds,
    partiallyRetainedTurnIds: plan.partiallyRetainedTurnIds,
    turnDiffRewind,
  };
}

async function rewindTurnDiffBestEffort(
  options: HistoryMutationCapabilityOptions,
  input: HistoryRewindInput,
  plan: RewindOperationData,
): Promise<TurnDiffRewindOutcome> {
  if (!plan.rewindTurnDiff) return { status: 'not-requested' };
  const prepared = await preflightTurnDiffBestEffort(options, input, plan);
  return prepared ? applyTurnDiffBestEffort(options, input) : successfulSkippedTurnDiff();
}

async function applyTurnDiffBestEffort(
  options: HistoryMutationCapabilityOptions,
  input: HistoryRewindInput,
): Promise<Exclude<TurnDiffRewindOutcome, { readonly status: 'not-requested' }>> {
  try {
    const outcome = await options.rewindProjections.apply({
      operationId: input.operationId,
      sessionId: input.sessionId,
    });
    if (outcome.status !== 'failed-after-rewind') return outcome;
    reportTurnDiffSkip(options, {
      sessionId: input.sessionId,
      operationId: input.operationId,
      phase: 'apply',
      reason: outcome.errorCode,
    });
    return { status: 'rewound', revertedTurnIds: outcome.revertedTurnIds };
  } catch (error) {
    reportTurnDiffSkip(options, {
      sessionId: input.sessionId,
      operationId: input.operationId,
      phase: 'apply',
      reason: 'projection-error',
      error,
    });
    return successfulSkippedTurnDiff();
  }
}

async function preflightTurnDiffBestEffort(
  options: HistoryMutationCapabilityOptions,
  input: HistoryRewindInput,
  plan: RewindOperationData,
): Promise<boolean> {
  try {
    await options.rewindProjections.preflight({
      operationId: input.operationId,
      sessionId: input.sessionId,
      fullyDeletedTurnIds: plan.fullyDeletedTurnIds,
      partiallyRetainedTurnIds: plan.partiallyRetainedTurnIds,
    });
    return true;
  } catch (error) {
    reportTurnDiffSkip(options, {
      sessionId: input.sessionId,
      operationId: input.operationId,
      phase: 'preflight',
      reason: 'projection-error',
      error,
    });
    return false;
  }
}

function successfulSkippedTurnDiff(): Extract<
  TurnDiffRewindOutcome,
  { readonly status: 'rewound' }
> {
  return { status: 'rewound', revertedTurnIds: [] };
}

function reportTurnDiffSkip(
  options: HistoryMutationCapabilityOptions,
  event: TurnDiffRewindSkipEvent,
): void {
  try {
    options.onTurnDiffRewindSkipped?.(event);
  } catch {
    // Diagnostics are best-effort and cannot affect Canonical Rewind.
  }
}

async function planRewind(
  options: HistoryMutationCapabilityOptions,
  input: HistoryRewindInput,
): Promise<RewindPlan> {
  const source = await readBoundarySource(
    options,
    input.sessionId,
    input.fromUserMessageIdInclusive,
    input.fromUserMessageIdInclusive,
  );
  const exact = findRewindSlice(source, input.fromUserMessageIdInclusive);
  const slice = exact ?? findDisplayOnlyRewindSlice(source, input);
  const projection = exact
    ? deriveRewindProjection(source, slice.active, slice.snapshots)
    : includeDisplayAffectedTurns(
        deriveRewindProjection(source, slice.active, slice.snapshots),
        slice.active,
        slice.snapshots,
        input.displayOnlyBoundary?.affectedTurnIds ?? [],
      );
  return {
    schemaVersion: 1,
    fromUserMessageIdInclusive: input.fromUserMessageIdInclusive,
    rewindTurnDiff: input.rewindTurnDiff === true,
    ...(input.displayOnlyBoundary
      ? { displayOnlyBoundary: copyDisplayOnlyBoundary(input.displayOnlyBoundary) }
      : {}),
    generation: slice.generation,
    sourceGeneration: source.activeGeneration,
    active: slice.active,
    snapshots: slice.snapshots,
    sourceRevision: source.revision,
    ...projection,
  };
}

interface RewindSlice {
  readonly generation: number;
  readonly active: readonly CanonicalHistoryEnvelope[];
  readonly snapshots: readonly SessionHistorySnapshot[];
}

function findRewindSlice(
  source: Awaited<ReturnType<typeof readBoundarySource>>,
  boundary: string,
): RewindSlice | undefined {
  const artifact = findForkArtifact(source, boundary);
  if (!artifact) return undefined;
  const index = artifact.records.findIndex((envelope) => envelope.message_id === boundary);
  if (index < 0) return undefined;
  const target = artifact.records[index];
  if (!target || target.message.role !== 'user' || !target.message_id.startsWith('msg-user-v1-')) {
    throw new HistoryMutationError(
      'boundary-invalid',
      'History rewind target is not an external user envelope',
    );
  }
  const active = artifact.records.slice(0, index);
  assertSettledRewindPrefix(active);
  return {
    generation: artifact.generation,
    active,
    snapshots: source.snapshots
      .filter((snapshot) => snapshot.generation < artifact.generation)
      .map(copySnapshot),
  };
}

function findDisplayOnlyRewindSlice(
  source: Awaited<ReturnType<typeof readBoundarySource>>,
  input: HistoryRewindInput,
): RewindSlice {
  const boundary = input.displayOnlyBoundary;
  if (!boundary) boundaryNotFound(input.fromUserMessageIdInclusive);
  const canonical = [...source.snapshots.flatMap((snapshot) => snapshot.records), ...source.active];
  if (canonical.some((envelope) => envelope.turn_id === boundary.turnId)) {
    throw new HistoryMutationError(
      'boundary-invalid',
      'Display-only rewind target Turn is partially present in Canonical History',
    );
  }
  const laterBoundary = boundary.subsequentUserMessageIds.find(
    (messageId) => findForkArtifact(source, messageId) !== undefined,
  );
  if (laterBoundary) {
    const later = findRewindSlice(source, laterBoundary);
    if (later) return later;
  }
  assertSettledRewindPrefix(source.active);
  return {
    generation: source.activeGeneration,
    active: source.active,
    snapshots: source.snapshots.map(copySnapshot),
  };
}

function assertSettledRewindPrefix(records: readonly CanonicalHistoryEnvelope[]): void {
  if (isSettledPrefix(records)) return;
  throw new HistoryMutationError('boundary-invalid', 'History rewind target prefix is not settled');
}

function deriveRewindProjection(
  source: Awaited<ReturnType<SessionHistoryMutationCapability['read']>>,
  active: readonly CanonicalHistoryEnvelope[],
  snapshots: readonly SessionHistorySnapshot[],
): Pick<
  RewindOperationData,
  'deletedMessageIds' | 'affectedTurnIds' | 'fullyDeletedTurnIds' | 'partiallyRetainedTurnIds'
> {
  const before = [...source.snapshots.flatMap((snapshot) => snapshot.records), ...source.active];
  const after = [...snapshots.flatMap((snapshot) => snapshot.records), ...active];
  const retainedMessageIds = new Set(after.map((envelope) => envelope.message_id));
  const deleted = uniqueBy(
    before.filter((entry) => !retainedMessageIds.has(entry.message_id)),
    (entry) => entry.message_id,
  );
  const retainedTurnIds = new Set(after.map((envelope) => envelope.turn_id));
  const affectedTurnIds = unique(deleted.map((envelope) => envelope.turn_id));
  const partiallyRetainedTurnIds = affectedTurnIds.filter((turnId) => retainedTurnIds.has(turnId));
  const partial = new Set(partiallyRetainedTurnIds);
  return {
    deletedMessageIds: deleted.map((envelope) => envelope.message_id),
    affectedTurnIds,
    fullyDeletedTurnIds: affectedTurnIds.filter((turnId) => !partial.has(turnId)),
    partiallyRetainedTurnIds,
  };
}

function includeDisplayAffectedTurns(
  projection: ReturnType<typeof deriveRewindProjection>,
  active: readonly CanonicalHistoryEnvelope[],
  snapshots: readonly SessionHistorySnapshot[],
  displayAffectedTurnIds: readonly string[],
): ReturnType<typeof deriveRewindProjection> {
  const retainedTurnIds = new Set(
    [...snapshots.flatMap((snapshot) => snapshot.records), ...active].map(
      (envelope) => envelope.turn_id,
    ),
  );
  const affectedTurnIds = unique([...projection.affectedTurnIds, ...displayAffectedTurnIds]);
  const partiallyRetainedTurnIds = affectedTurnIds.filter((turnId) => retainedTurnIds.has(turnId));
  const partial = new Set(partiallyRetainedTurnIds);
  return {
    ...projection,
    affectedTurnIds,
    fullyDeletedTurnIds: affectedTurnIds.filter((turnId) => !partial.has(turnId)),
    partiallyRetainedTurnIds,
  };
}

function operationData(plan: RewindPlan): RewindOperationData {
  return {
    schemaVersion: 1,
    fromUserMessageIdInclusive: plan.fromUserMessageIdInclusive,
    rewindTurnDiff: plan.rewindTurnDiff,
    ...(plan.displayOnlyBoundary
      ? { displayOnlyBoundary: copyDisplayOnlyBoundary(plan.displayOnlyBoundary) }
      : {}),
    deletedMessageIds: plan.deletedMessageIds,
    affectedTurnIds: plan.affectedTurnIds,
    fullyDeletedTurnIds: plan.fullyDeletedTurnIds,
    partiallyRetainedTurnIds: plan.partiallyRetainedTurnIds,
  };
}

function decodeOperationData(value: unknown): RewindOperationData {
  if (!isRewindOperationData(value)) invalidOperationData();
  return value;
}

function isRewindOperationData(value: unknown): value is RewindOperationData {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.fromUserMessageIdInclusive === 'string' &&
    typeof value.rewindTurnDiff === 'boolean' &&
    (value.displayOnlyBoundary === undefined || isDisplayOnlyBoundary(value.displayOnlyBoundary)) &&
    isStringArray(value.deletedMessageIds) &&
    isStringArray(value.affectedTurnIds) &&
    isStringArray(value.fullyDeletedTurnIds) &&
    isStringArray(value.partiallyRetainedTurnIds)
  );
}

function invalidOperationData(): never {
  throw new HistoryMutationError('chain-corrupt', 'Persisted Rewind operation data is invalid');
}

function assertMatchingRewindRequest(input: HistoryRewindInput, data: RewindOperationData): void {
  if (
    data.fromUserMessageIdInclusive !== input.fromUserMessageIdInclusive ||
    data.rewindTurnDiff !== (input.rewindTurnDiff === true) ||
    !sameDisplayOnlyBoundary(data.displayOnlyBoundary, input.displayOnlyBoundary)
  ) {
    throw new HistoryMutationError(
      'identity-conflict',
      'Operation ID was already used for a different Rewind request',
    );
  }
}

function copyDisplayOnlyBoundary(
  boundary: NonNullable<HistoryRewindInput['displayOnlyBoundary']>,
): NonNullable<HistoryRewindInput['displayOnlyBoundary']> {
  return {
    turnId: boundary.turnId,
    subsequentUserMessageIds: [...boundary.subsequentUserMessageIds],
    affectedTurnIds: [...boundary.affectedTurnIds],
  };
}

function isDisplayOnlyBoundary(
  value: unknown,
): value is NonNullable<HistoryRewindInput['displayOnlyBoundary']> {
  return (
    isRecord(value) &&
    typeof value.turnId === 'string' &&
    value.turnId.length > 0 &&
    isStringArray(value.subsequentUserMessageIds) &&
    value.subsequentUserMessageIds.every((id) => id.startsWith('msg-user-v1-')) &&
    isStringArray(value.affectedTurnIds)
  );
}

function sameDisplayOnlyBoundary(
  left: HistoryRewindInput['displayOnlyBoundary'],
  right: HistoryRewindInput['displayOnlyBoundary'],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.turnId === right.turnId &&
    sameStringArray(left.subsequentUserMessageIds, right.subsequentUserMessageIds) &&
    sameStringArray(left.affectedTurnIds, right.affectedTurnIds)
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function findForkArtifact(
  source: Awaited<ReturnType<typeof readBoundarySource>>,
  boundary: string | undefined,
  preferLatest = false,
):
  | { readonly generation: number; readonly records: readonly CanonicalHistoryEnvelope[] }
  | undefined {
  if (!boundary) return { generation: source.activeGeneration, records: source.active };
  const artifacts = [
    ...[...source.snapshots]
      .sort((left, right) => left.generation - right.generation)
      .map(({ generation, records }) => ({ generation, records })),
    { generation: source.activeGeneration, records: source.active },
  ];
  if (preferLatest) artifacts.reverse();
  return artifacts.find((artifact) =>
    artifact.records.some((envelope) => envelope.message_id === boundary),
  );
}

function createContinuationEnvelope(
  operationId: string,
  continuation: NonNullable<HistoryForkInput['continuation']>,
): CanonicalHistoryEnvelope {
  const identity = createHash('sha256').update(operationId).digest('hex').slice(0, 24);
  return {
    message_id: `msg-fork-reminder-${identity}`,
    turn_id: `control:${operationId}`,
    message: {
      role: 'user',
      timestamp: 0,
      content: `<system-reminder>\nThis conversation was forked into an isolated Git worktree.\nAll committed, staged, unstaged, and untracked changes from the source worktree were carried over.\nPrevious workspace: ${continuation.previousWorkspaceDir}\nCurrent workspace: ${continuation.currentWorkspaceDir}\nCurrent branch: ${continuation.currentBranch}\nUse the current workspace for all subsequent file and tool operations.\n</system-reminder>`,
    },
  };
}

function createHiddenContextBoundaryEnvelope(
  operationId: string,
  boundary: NonNullable<HistoryForkInput['hiddenContextBoundary']>,
): CanonicalHistoryEnvelope {
  const identity = createHash('sha256')
    .update(`${operationId}:${boundary.kind}:${boundary.content}`)
    .digest('hex')
    .slice(0, 24);
  return {
    message_id: `msg-hidden-context-boundary-${identity}`,
    turn_id: `control:${operationId}`,
    message: {
      role: 'custom',
      timestamp: 0,
      customType: boundary.kind,
      display: false,
      content: boundary.content,
    },
  };
}

function copySnapshot(snapshot: SessionHistorySnapshot): SessionHistorySnapshot {
  return { ...snapshot, records: snapshot.records };
}

function withoutSourceBackgroundReminders(
  records: readonly CanonicalHistoryEnvelope[],
): readonly CanonicalHistoryEnvelope[] {
  const retained: CanonicalHistoryEnvelope[] = [];
  const suppressedTurnIds = new Set<string>();
  for (const envelope of records) {
    if (suppressedTurnIds.has(envelope.turn_id)) continue;
    if (
      isTypedBackgroundReminder(envelope.message) ||
      isBackgroundTaskReadSettlement(envelope.message)
    ) {
      continue;
    }
    if (!isAutomaticBackgroundReminder(envelope.message)) {
      retained.push(withoutSourceBackgroundCheckpoint(envelope));
      continue;
    }
    while (retained.at(-1)?.turn_id === envelope.turn_id && !isSettledPrefix(retained)) {
      retained.pop();
    }
    suppressedTurnIds.add(envelope.turn_id);
  }
  return retained;
}

function isTypedBackgroundReminder(message: object): boolean {
  return (
    Reflect.get(message, 'role') === 'custom' &&
    Reflect.get(message, 'customType') === BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE &&
    Reflect.get(message, 'display') === false
  );
}

function withoutSourceBackgroundCheckpoint(
  envelope: CanonicalHistoryEnvelope,
): CanonicalHistoryEnvelope {
  if (Reflect.get(envelope.message, 'role') !== 'compactionSummary') return envelope;
  const compatibility = readCompactionCompatibility(envelope.message as never);
  if (!compatibility?.backgroundCadence) return envelope;
  const retainedCompatibility = { ...compatibility };
  Reflect.deleteProperty(retainedCompatibility, 'backgroundCadence');
  const { summary, ...retained } = retainedCompatibility;
  return {
    ...envelope,
    message: {
      ...envelope.message,
      summary: appendCompactionState(summary, retained),
    },
  };
}

function isAutomaticBackgroundReminder(message: object): boolean {
  return (
    Reflect.get(message, 'role') === 'user' &&
    readBackgroundTaskOriginMetadata(message) !== undefined
  );
}

function isSettledPrefix(records: readonly CanonicalHistoryEnvelope[]): boolean {
  return inspectCanonicalHistorySequence(records).status === 'settled';
}

async function readBoundarySource(
  options: HistoryMutationCapabilityOptions,
  sessionId: string,
  boundary: string | undefined,
  waitForUserMessageId?: string,
) {
  const initial = await readSessionHistory(options, sessionId);
  if (
    !boundary ||
    containsBoundary(initial, boundary) ||
    !waitForUserMessageId ||
    !options.activeTurnId?.(sessionId) ||
    !options.sessions.readForUserMessage
  ) {
    return initial;
  }
  try {
    return await options.sessions.readForUserMessage({
      sessionId,
      userMessageId: waitForUserMessageId,
      timeoutMs: options.boundaryWaitTimeoutMs ?? DEFAULT_BOUNDARY_WAIT_TIMEOUT_MS,
    });
  } catch (error) {
    throw classifySessionHistoryError(error);
  }
}

async function readSessionHistory(options: HistoryMutationCapabilityOptions, sessionId: string) {
  try {
    return await options.sessions.read(sessionId);
  } catch (error) {
    throw classifySessionHistoryError(error);
  }
}

function classifySessionHistoryError(error: unknown): unknown {
  if (error instanceof HistoryMutationError) return error;
  const code = readErrorCode(error);
  if (code === 'duplicate-external-user-id' || code === 'external-user-lineage-conflict') {
    return new HistoryMutationError(
      'identity-conflict',
      'Canonical history contains a duplicate external user identity',
      { cause: error },
    );
  }
  if (
    [
      'artifact-revision-mismatch',
      'parent-mismatch',
      'parent-snapshot-missing',
      'invalid-generation-marker',
      'malformed-jsonl',
      'sequence-corruption',
      'unsafe-artifact',
    ].includes(String(code))
  ) {
    return new HistoryMutationError('chain-corrupt', 'Canonical history chain is corrupt', {
      cause: error,
    });
  }
  return error;
}

function boundaryNotFound(boundary: string | undefined): never {
  throw new HistoryMutationError(
    'boundary-not-found',
    `History mutation target not found: ${boundary}`,
  );
}

function readErrorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}

function containsBoundary(
  source: Awaited<ReturnType<SessionHistoryMutationCapability['read']>>,
  boundary: string,
): boolean {
  return (
    source.active.some((envelope) => envelope.message_id === boundary) ||
    source.snapshots.some((snapshot) =>
      snapshot.records.some((envelope) => envelope.message_id === boundary),
    )
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
