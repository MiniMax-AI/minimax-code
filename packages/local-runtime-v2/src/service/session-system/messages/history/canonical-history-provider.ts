import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { SessionRepository } from '../../sessions/repo/contract.js';
import {
  canonicalActiveHistoryRevision,
  canonicalHistoryRevision,
  JsonlAppendCommitUncertainError,
  type CanonicalHistoryEnvelope,
  type CanonicalHistoryFileAdapter,
} from '../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../sessions/representation/canonical-history.js';
import { repairCanonicalHistory } from './canonical-history-recovery.js';
import { deleteSessionHistory, type SessionHistoryPaths } from './session-history-paths.js';
import {
  createSessionHistoryLocationResolver,
  type SessionHistoryLocationResolver,
} from './session-history-location.js';
import {
  ensureCanonicalHistoryMaterialized,
  type CanonicalHistoryLegacyMigration,
} from './canonical-history-materializer.js';
import {
  CanonicalHistoryIndexWriteError,
  createCanonicalHistoryIndexAdapter,
  type CanonicalHistoryIndexAdapter,
} from './mutation/canonical-history-index.js';
import {
  HistoryScannerError,
  createCanonicalHistoryScanner,
  scanCanonicalHistoryArtifacts,
} from './mutation/canonical-history-scanner.js';
import { isUserMessageId } from '../../shared/user-message-id.js';
import {
  createSessionHistoryIoLane,
  type SessionHistoryActivity,
  type SessionHistoryIoLane,
} from './mutation/session-history-coordination.js';

const MAX_CANONICAL_WRITE_ATTEMPTS = 3;
const CANONICAL_RETRY_DELAYS_MS = [25, 50] as const;

export interface SessionCanonicalHistorySnapshot {
  readonly revision: string;
  readonly messages: readonly unknown[];
  /** Canonical envelope message_id values in the same order as messages. */
  readonly identityVector: readonly string[];
}

export type EnvelopeReplacementEntry =
  | {
      readonly message: unknown;
      readonly identity: { readonly kind: 'preserve'; readonly messageId: string };
    }
  | {
      readonly message: unknown;
      readonly identity: {
        readonly kind: 'external-user';
        readonly messageId: `msg-user-v1-${string}`;
      };
    }
  | {
      readonly message: unknown;
      readonly identity: { readonly kind: 'new'; readonly seed: string };
    };

export interface CanonicalMessageIdentityHint {
  readonly index: number;
  readonly messageId: string;
  readonly source: 'display-user' | 'preserved' | 'internal-new';
}

export interface SessionCanonicalHistoryChange {
  readonly sessionId: string;
  readonly turnId: string;
  readonly reason: 'messageDelta' | 'replaceMessages';
  readonly messages: readonly unknown[];
  readonly identityHints?: readonly CanonicalMessageIdentityHint[];
  readonly replacementEntries?: readonly EnvelopeReplacementEntry[];
  readonly operation: {
    readonly id: string;
    readonly kind: string;
  };
  readonly metadata?: unknown;
}

interface SessionCanonicalHistoryCompactionChangeBase extends Omit<
  SessionCanonicalHistoryChange,
  'reason' | 'operation'
> {
  readonly reason: 'replaceMessages';
  readonly operation: {
    readonly id: string;
    readonly kind: 'compaction';
  };
  readonly compactionId: string;
  readonly summary: string;
  /** Source identity for a structurally preserved real-user tail. */
  readonly currentUserSourceIndex?: number;
}

export type SessionCanonicalHistoryCompactionChange = SessionCanonicalHistoryCompactionChangeBase &
  (
    | {
        readonly method: 'tool_archive';
        readonly replacementSourceIndexes: readonly number[];
      }
    | {
        readonly method: 'tool_trim';
        readonly replacementSourceIndexes: readonly number[];
      }
    | {
        readonly method: 'llm_checkpoint';
        readonly replacementSourceIndexes?: never;
      }
  );

export interface SessionCanonicalHistoryCommit {
  readonly revision: string;
  readonly generation: number;
  readonly messages: readonly unknown[];
  /** Canonical envelope message_id values in the same order as messages. */
  readonly identityVector: readonly string[];
}

type HistorySnapshotTransform = (snapshot: SessionCanonicalHistorySnapshot) => SessionCanonicalHistorySnapshot;

export interface SessionSystemCanonicalHistoryProvider {
  /** Internal synchronous ownership transfer; ordinary reads remain detached and mutable. */
  withSnapshotTransform?(transform: HistorySnapshotTransform): SessionSystemCanonicalHistoryProvider;
  /** Provider-safe settled history; deterministic tool-protocol tails are repaired in place. */
  read(sessionId: string): Promise<SessionCanonicalHistorySnapshot>;
  /** Strict active history; only the final legal pending tool round is accepted. */
  readActive(sessionId: string): Promise<SessionCanonicalHistorySnapshot>;
  /** Readonly strict active-history inspection that never initializes or rewrites artifacts. */
  inspectActive(sessionId: string): Promise<SessionCanonicalHistorySnapshot>;
  append(change: SessionCanonicalHistoryChange): Promise<SessionCanonicalHistorySnapshot>;
  replace(change: SessionCanonicalHistoryChange): Promise<SessionCanonicalHistorySnapshot>;
  compact(change: SessionCanonicalHistoryCompactionChange): Promise<SessionCanonicalHistoryCommit>;
  initialize(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface SessionSystemCanonicalHistoryProviderOptions {
  readonly dataDir: string;
  readonly sessions: Pick<SessionRepository, 'get'> &
    Partial<Pick<SessionRepository, 'bindHistoryRelativeDir'>>;
  readonly locations?: SessionHistoryLocationResolver;
  readonly legacyHistory?: CanonicalHistoryLegacyMigration;
  readonly nowMs?: () => number;
  readonly files?: CanonicalHistoryFileAdapter;
  /** Direct-module test seam; production uses the bounded timer delay. */
  readonly retryDelay?: (delayMs: number) => Promise<void>;
  readonly ioLane?: SessionHistoryIoLane;
  readonly activity?: SessionHistoryActivity;
}

interface TimestampedCanonicalHistoryMessage extends Readonly<Record<string, unknown>> {
  readonly role: string;
  readonly timestamp: number;
}

interface MinimalNativeCompactionSummary extends Readonly<Record<string, unknown>> {
  readonly role: 'compactionSummary';
  readonly summary: string;
  readonly timestamp?: never;
  readonly tokensBefore?: never;
}

type CanonicalHistoryMessage = TimestampedCanonicalHistoryMessage | MinimalNativeCompactionSummary;

function historySnapshot(
  records: readonly CanonicalHistoryEnvelope[],
  useActiveRevision: boolean,
  transform?: HistorySnapshotTransform,
): SessionCanonicalHistorySnapshot {
  const snapshot = {
    revision: useActiveRevision
      ? canonicalActiveHistoryRevision(records)
      : canonicalHistoryRevision(records),
    messages: records.map(({ message }) => transform ? message : detached(message)),
    identityVector: records.map(({ message_id }) => message_id),
  };
  return transform ? transform(snapshot) : snapshot;
}

function isMissingParentScannerError(error: unknown): error is HistoryScannerError {
  return error instanceof HistoryScannerError && error.code === 'parent-snapshot-missing';
}

async function scanCompactionLineageAllowingMissingParent(
  paths: SessionHistoryPaths,
  sessionId: string,
): Promise<void> {
  try {
    await scanCanonicalHistoryArtifacts({
      activePath: paths.messages,
      snapshotsPath: paths.snapshots,
      sessionId,
    });
  } catch (error) {
    if (!isMissingParentScannerError(error)) throw error;
  }
}

/**
 * Session-owned canonical Pi history provider. First access materializes the
 * selected readonly v1 source before this provider becomes the sole writer.
 */
export function createSessionSystemCanonicalHistoryProvider(
  options: SessionSystemCanonicalHistoryProviderOptions,
): SessionSystemCanonicalHistoryProvider {
  const files = options.files ?? createCanonicalHistoryFileAdapter({ reuseDecodedRecords: true });
  const inspectionFiles = options.files ?? createCanonicalHistoryFileAdapter();
  const nowMs = options.nowMs ?? Date.now;
  const retryDelay = options.retryDelay ?? ((delayMs: number) => delay(delayMs));
  const ioLane = options.ioLane ?? createSessionHistoryIoLane();
  const locations =
    options.locations ??
    createSessionHistoryLocationResolver({ dataDir: options.dataDir, sessions: options.sessions });
  const indexes = new Map<string, CanonicalHistoryIndexAdapter>();
  const scanHistory = createCanonicalHistoryScanner();
  const verifiedRecovery = new WeakMap<readonly CanonicalHistoryEnvelope[], number>();

  return view();

  function view(transform?: HistorySnapshotTransform): SessionSystemCanonicalHistoryProvider {
    return {
      // Only the private default reader proves that messages are deeply immutable.
      // Injected adapters retain the original detach-and-validate boundary.
      ...(options.files === undefined ? { withSnapshotTransform: view } : {}),
      read: (sessionId) => inLane(sessionId, () => readSnapshot(sessionId, false, transform)),
      readActive: (sessionId) => inLane(sessionId, () => readSnapshot(sessionId, true, transform)),
      inspectActive: (sessionId) => inLane(sessionId, () => inspectActiveSnapshot(sessionId)),
      initialize: (sessionId) =>
        inLane(sessionId, async () => {
          const paths = await ensureInitialized(sessionId, 'allocate');
          await syncIndex(sessionId, paths);
        }),
      delete: (sessionId) =>
        inLane(sessionId, async () => {
          const located = await locations.resolveSession(sessionId);
          if (!located) return;
          deleteSessionHistory(options.dataDir, located.session, located.paths);
          options.activity?.notify(sessionId);
        }),
      append: (change) =>
        inLane(change.sessionId, async () => {
          await persistCanonical(async () => {
            assertChange(change, 'messageDelta');
            const paths = await ensureInitialized(change.sessionId);
            const existing = await files.readActiveStrict(paths.messages);
            const appended = appendEnvelopes(change);
            assertAppendIdentityBoundary(existing, appended);
            await appendWithInterruptedToolRoundRecovery({
              files,
              path: paths.messages,
              existing,
              appended,
            });
          }, retryDelay);
          const committed = await readSnapshot(change.sessionId, true, transform);
          options.activity?.notify(change.sessionId);
          return committed;
        }),
      replace: (change) =>
        inLane(change.sessionId, async () => {
          await persistCanonical(async () => {
            assertChange(change, 'replaceMessages');
            const paths = await ensureInitialized(change.sessionId);
            const existing = await files.readStrict(paths.messages);
            const snapshotId = replacementSnapshotId(change.metadata);
            if (snapshotId) {
              const generation = activeGeneration(existing);
              await files.publishSnapshot(
                join(
                  paths.snapshots,
                  `g${String(generation).padStart(12, '0')}--${safeCompactionId(snapshotId)}.jsonl`,
                ),
                existing,
              );
            }
            await files.replace(paths.messages, replacementEnvelopes(change, existing));
          }, retryDelay);
          const committed = await readSnapshot(change.sessionId, true, transform);
          options.activity?.notify(change.sessionId);
          return committed;
        }),
      compact: (change) =>
        inLane(change.sessionId, async () => {
          const paths = await ensureInitialized(change.sessionId);
          const active = await files.readActiveStrict(paths.messages);
          await scanCompactionLineageAllowingMissingParent(paths, change.sessionId);
          const generation = activeGeneration(active);
          const compactionId = safeCompactionId(change.compactionId);
          const snapshotPath = join(
            paths.snapshots,
            `g${String(generation).padStart(12, '0')}--${compactionId}.jsonl`,
          );
          const preRevision = canonicalActiveHistoryRevision(active);
          const replacement = compactionReplacementEnvelopes(change, active);
          const marker: NonNullable<CanonicalHistoryEnvelope['history_artifact']> = {
            schemaVersion: 1,
            generation: generation + 1,
            producedBy: change.method,
            parentSnapshot: {
              generation,
              compactionId,
              revision: preRevision,
            },
          };
          const markedReplacement = markHistoryArtifact(replacement, marker);
          await files.publishSnapshot(snapshotPath, active);
          await files.replaceActive(paths.messages, markedReplacement);
          const committed = await files.readActiveStrict(paths.messages);
          const committedGeneration = activeGeneration(committed);
          if (committedGeneration !== generation + 1) {
            throw new Error(
              `Canonical compaction generation verification failed: ${change.sessionId}`,
            );
          }
          await syncIndex(change.sessionId, paths, true, committed);
          const result = {
            ...historySnapshot(committed, true, transform),
            generation: committedGeneration,
          };
          options.activity?.notify(change.sessionId);
          return result;
        }),
    };
  }

  async function readSnapshot(
    sessionId: string,
    allowPendingToolCallTail: boolean,
    transform?: HistorySnapshotTransform,
  ): Promise<SessionCanonicalHistorySnapshot> {
    const paths = await ensureInitialized(sessionId);
    const decoded = await files.readEnvelopesStrict(paths.messages);
    const recoveryMode = allowPendingToolCallTail ? 2 : 1;
    const reusable = options.files === undefined;
    const verifiedModes = reusable ? (verifiedRecovery.get(decoded) ?? 0) : 0;
    let records = decoded;
    if ((verifiedModes & recoveryMode) === 0) {
      const recovery = repairCanonicalHistory(decoded, { allowPendingToolCallTail });
      if (recovery.issues.length > 0) {
        records = recovery.records;
        if (allowPendingToolCallTail) {
          await files.replaceActive(paths.messages, records);
          records = await files.readActiveStrict(paths.messages);
        } else {
          await files.replace(paths.messages, records);
          records = await files.readStrict(paths.messages);
        }
        options.activity?.notify(sessionId);
      } else if (reusable) {
        // Only the private reader produces immutable arrays. The two recovery
        // modes remain independent, so a pending tail is never treated as settled.
        verifiedRecovery.set(decoded, verifiedModes | recoveryMode);
      } else {
        records = recovery.records;
      }
    }
    await syncIndex(sessionId, paths, true, records);
    return historySnapshot(records, allowPendingToolCallTail, transform);
  }

  async function inspectActiveSnapshot(
    sessionId: string,
  ): Promise<SessionCanonicalHistorySnapshot> {
    const located = await locations.inspectSession(sessionId);
    if (!located) throw new Error(`Session not found: ${sessionId}`);
    const records = (await inspectionFiles.readTargetStrict(located.paths.messages)) ?? [];
    return historySnapshot(records, true);
  }

  async function ensureInitialized(
    sessionId: string,
    locationMode: 'allocate' | 'resolve' = 'resolve',
  ): Promise<SessionHistoryPaths> {
    const session = await options.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const paths =
      locationMode === 'allocate'
        ? await locations.allocate(session)
        : await locations.ensure(session);
    await ensureCanonicalHistoryMaterialized({
      sessionId,
      paths,
      files,
      ...(options.legacyHistory ? { legacyHistory: options.legacyHistory } : {}),
      nowMs,
    });
    return paths;
  }

  async function syncIndex(
    sessionId: string,
    paths: SessionHistoryPaths,
    allowMissingParent = false,
    verifiedRecords?: readonly CanonicalHistoryEnvelope[],
  ): Promise<void> {
    const active = verifiedRecords ?? (await files.readActiveStrict(paths.messages));
    const adapter = indexes.get(sessionId) ?? createCanonicalHistoryIndexAdapter(paths.sessionDir);
    indexes.set(sessionId, adapter);
    try {
      await adapter.loadOrRebuild(
        {
          sessionId,
          activeGeneration: activeGeneration(active),
          activeRevision: canonicalActiveHistoryRevision(active),
        },
        // Only the default reader owns reusable immutable records. Preserve the
        // independent on-disk scanner for externally supplied adapters.
        (scannerPaths) => options.files
          ? scanCanonicalHistoryArtifacts(scannerPaths)
          : scanHistory(scannerPaths, files),
        { activePath: paths.messages, snapshotsPath: paths.snapshots, sessionId },
      );
    } catch (error) {
      if (error instanceof CanonicalHistoryIndexWriteError) return;
      if (allowMissingParent && isMissingParentScannerError(error)) return;
      throw error;
    }
  }
  async function inLane<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return ioLane.run(sessionId, operation);
  }
}

async function persistCanonical(
  operation: () => Promise<void>,
  retryDelay: (delayMs: number) => Promise<void>,
  attempt = 1,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (
      error instanceof JsonlAppendCommitUncertainError ||
      attempt >= MAX_CANONICAL_WRITE_ATTEMPTS
    ) {
      throw error;
    }
    await retryDelay(CANONICAL_RETRY_DELAYS_MS[attempt - 1] ?? 0);
    await persistCanonical(operation, retryDelay, attempt + 1);
  }
}

async function appendWithInterruptedToolRoundRecovery(input: {
  readonly files: CanonicalHistoryFileAdapter;
  readonly path: string;
  readonly existing: readonly CanonicalHistoryEnvelope[];
  readonly appended: readonly CanonicalHistoryEnvelope[];
}): Promise<void> {
  const combined = [...input.existing, ...input.appended];
  const recovery = repairCanonicalHistory(combined, { allowPendingToolCallTail: true });
  const [issue] = recovery.issues;
  const repairsCommittedTail =
    recovery.issues.length === 1 &&
    issue?.kind === 'interrupted-tool-round' &&
    issue.recordIndex < input.existing.length;
  if (repairsCommittedTail) {
    await input.files.replaceActive(input.path, recovery.records);
    return;
  }
  await input.files.append(input.path, input.appended, input.existing);
}

function appendEnvelopes(change: SessionCanonicalHistoryChange): CanonicalHistoryEnvelope[] {
  const identityHints = appendIdentityHints(change);
  return change.messages.map((message, index) =>
    envelope({
      change,
      message,
      turnId: change.turnId,
      index,
      identityHint: identityHints.get(index),
    }),
  );
}

function appendIdentityHints(
  change: SessionCanonicalHistoryChange,
): ReadonlyMap<number, CanonicalMessageIdentityHint> {
  const hints = new Map<number, CanonicalMessageIdentityHint>();
  for (const hint of change.identityHints ?? []) {
    if (
      !Number.isSafeInteger(hint.index) ||
      hint.index < 0 ||
      hint.index >= change.messages.length
    ) {
      throw new TypeError(
        `Canonical history identity hint index is invalid: ${String(hint.index)}`,
      );
    }
    if (hints.has(hint.index)) {
      throw new TypeError(
        `Canonical history identity hint index is duplicated: ${String(hint.index)}`,
      );
    }
    assertAppendIdentityHint(hint, historyMessage(change.messages[hint.index]));
    hints.set(hint.index, hint);
  }
  if (new Set([...hints.values()].map(({ messageId }) => messageId)).size !== hints.size) {
    throw new TypeError('Canonical history identity hint message id is duplicated.');
  }
  return hints;
}

function assertAppendIdentityHint(
  hint: CanonicalMessageIdentityHint,
  message: CanonicalHistoryMessage,
): void {
  if (!hint.messageId.trim() || !/^msg-.+/u.test(hint.messageId)) {
    throw new TypeError('Canonical history identity hint message id is invalid.');
  }
  if (hint.source === 'display-user') {
    if (message.role !== 'user' || !isUserMessageId(hint.messageId)) {
      throw new TypeError('Canonical display user identity hint is invalid.');
    }
    return;
  }
  if (hint.source !== 'preserved' && hint.source !== 'internal-new') {
    throw new TypeError('Canonical history identity hint source is invalid.');
  }
  if (hint.source === 'internal-new' && isUserMessageId(hint.messageId)) {
    throw new TypeError('Canonical internal identity cannot use an external user id.');
  }
}

function assertAppendIdentityBoundary(
  existing: readonly CanonicalHistoryEnvelope[],
  appended: readonly CanonicalHistoryEnvelope[],
): void {
  const identities = new Set(existing.map(({ message_id }) => message_id));
  for (const { message_id } of appended) {
    if (identities.has(message_id)) {
      throw new TypeError(`Canonical history append identity is duplicated: ${message_id}`);
    }
    identities.add(message_id);
  }
}

function replacementEnvelopes(
  change: SessionCanonicalHistoryChange,
  existing: readonly CanonicalHistoryEnvelope[],
): CanonicalHistoryEnvelope[] {
  const entries = change.replacementEntries;
  if (!entries || entries.length !== change.messages.length) {
    throw new TypeError('Canonical history replacement identity plan is required.');
  }
  const existingById = new Map<string, CanonicalHistoryEnvelope>();
  for (const record of existing) {
    if (existingById.has(record.message_id)) {
      throw new TypeError(`Canonical history contains duplicate message id: ${record.message_id}`);
    }
    existingById.set(record.message_id, record);
  }
  const used = new Set<string>();
  const replacement = entries.map((entry, index) => {
    const normalized = historyMessage(entry.message);
    const { messageId, previous } = resolveReplacementIdentity({
      entry,
      normalized,
      existingById,
      change,
      index,
    });
    if (used.has(messageId))
      throw new TypeError(`Canonical history replacement identity is duplicated: ${messageId}`);
    used.add(messageId);
    return {
      ...(previous ?? {}),
      message_id: messageId,
      turn_id:
        previous?.turn_id ??
        (normalized.role === 'user' ? `${change.turnId}:${String(index)}` : change.turnId),
      message: normalized,
    };
  });
  return preserveHistoryArtifact(existing, replacement);
}

function resolveReplacementIdentity(input: {
  readonly entry: NonNullable<SessionCanonicalHistoryChange['replacementEntries']>[number];
  readonly normalized: CanonicalHistoryMessage;
  readonly existingById: ReadonlyMap<string, CanonicalHistoryEnvelope>;
  readonly change: SessionCanonicalHistoryChange;
  readonly index: number;
}): { readonly messageId: string; readonly previous?: CanonicalHistoryEnvelope } {
  const { entry } = input;
  if (entry.identity.kind === 'preserve') {
    const previous = input.existingById.get(entry.identity.messageId);
    if (!previous) {
      throw new TypeError(`Canonical history identity is missing: ${entry.identity.messageId}`);
    }
    return { messageId: entry.identity.messageId, previous };
  }
  if (entry.identity.kind === 'external-user') {
    assertExternalUserIdentity(entry.identity.messageId, input.normalized, input.existingById);
    return { messageId: entry.identity.messageId };
  }
  if (!entry.identity.seed.trim()) {
    throw new TypeError('Canonical history new identity seed is required.');
  }
  return {
    messageId: messageIdFromSeed(
      `${input.change.operation.id}:${entry.identity.seed}:${String(input.index)}`,
    ),
  };
}

function assertExternalUserIdentity(
  messageId: string,
  message: CanonicalHistoryMessage,
  existingById: ReadonlyMap<string, CanonicalHistoryEnvelope>,
): void {
  if (message.role !== 'user' || !isUserMessageId(messageId)) {
    throw new TypeError(`External user identity requires a user message: ${messageId}`);
  }
  if (existingById.has(messageId)) {
    throw new TypeError(`External user identity already exists; use preserve: ${messageId}`);
  }
}

function envelope(input: {
  readonly change: SessionCanonicalHistoryChange;
  readonly message: unknown;
  readonly turnId: string;
  readonly index: number;
  readonly identityHint?: CanonicalMessageIdentityHint;
}): CanonicalHistoryEnvelope {
  const normalized = historyMessage(input.message);
  return {
    message_id:
      input.identityHint?.messageId ??
      (input.change.operation.kind === 'worktree-reminder'
        ? `msg-control-${createHash('sha256')
            .update(`${input.change.operation.id}:${String(input.index)}`)
            .digest('base64url')}`
        : messageIdFromSeed(
            `${input.change.operation.id}:${String(input.index)}:${JSON.stringify(normalized)}`,
          )),
    turn_id: input.turnId,
    message: normalized,
  };
}

function messageIdFromSeed(seed: string): string {
  return `msg-${createHash('sha256').update(seed).digest('base64url')}`;
}

function historyMessage(value: unknown): CanonicalHistoryMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Canonical history contains a non-object message.');
  }
  const minimal = readMinimalCompactionSummary(value);
  if (minimal) return minimal;
  const role = Reflect.get(value, 'role');
  const timestamp = Reflect.get(value, 'timestamp');
  if (
    typeof role !== 'string' ||
    !role ||
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp)
  ) {
    throw new TypeError('Canonical history contains an invalid Pi message.');
  }
  return detached(value) as CanonicalHistoryMessage;
}

function readMinimalCompactionSummary(value: object): MinimalNativeCompactionSummary | undefined {
  if (Reflect.get(value, 'role') !== 'compactionSummary') return undefined;
  const summary = Reflect.get(value, 'summary');
  if (
    typeof summary !== 'string' ||
    Object.hasOwn(value, 'timestamp') ||
    Object.hasOwn(value, 'tokensBefore') ||
    Object.keys(value).some((key) => key !== 'role' && key !== 'summary')
  ) {
    return undefined;
  }
  return { role: 'compactionSummary', summary };
}

function assertChange(
  change: SessionCanonicalHistoryChange,
  reason: SessionCanonicalHistoryChange['reason'],
): void {
  if (change.reason !== reason || !change.operation.id.trim()) {
    throw new TypeError(`Canonical history ${reason} change is invalid.`);
  }
}

function compactionReplacementEnvelopes(
  change: SessionCanonicalHistoryCompactionChange,
  active: readonly CanonicalHistoryEnvelope[],
): CanonicalHistoryEnvelope[] {
  const currentUserTail = readCurrentUserTail(change, active);
  const baseMessages = currentUserTail?.baseMessages ?? change.messages;
  if (change.method === 'llm_checkpoint') {
    const replacement = baseMessages.map((message, index) =>
      envelope({ change, message, turnId: `${change.turnId}:compaction`, index }),
    );
    if (replacement.length !== 1 || replacement[0]?.message.role !== 'compactionSummary') {
      throw new TypeError('Canonical checkpoint compaction must contain one native summary.');
    }
    return currentUserTail ? [...replacement, ...currentUserTail.envelopes] : replacement;
  }
  const sourceIndexes = validateToolReplacementSourceIndexes(change, active, baseMessages.length);
  const retainedExternalUsers = new Set<string>();
  const replacement = baseMessages.map((message, index) => {
    const sourceIndex = sourceIndexes[index];
    const source = sourceIndex === undefined ? undefined : active[sourceIndex];
    if (!source) throw new TypeError('Canonical ToolResult compaction source identity is missing.');
    const normalized = historyMessage(message);
    assertToolReplacementMessage(source, normalized);
    if (isUserMessageId(source.message_id)) retainedExternalUsers.add(source.message_id);
    return { ...withoutHistoryArtifact(source), message: normalized };
  });
  if (currentUserTail) retainedExternalUsers.add(currentUserTail.user.message_id);
  const missingExternalUser = active.find(
    ({ message_id }) => isUserMessageId(message_id) && !retainedExternalUsers.has(message_id),
  );
  if (missingExternalUser) {
    throw new TypeError(
      `Canonical ToolResult compaction dropped an external user identity: ${missingExternalUser.message_id}`,
    );
  }
  return currentUserTail ? [...replacement, ...currentUserTail.envelopes] : replacement;
}

function readCurrentUserTail(
  change: SessionCanonicalHistoryCompactionChange,
  active: readonly CanonicalHistoryEnvelope[],
):
  | {
      readonly baseMessages: readonly unknown[];
      readonly user: CanonicalHistoryEnvelope;
      readonly envelopes: readonly CanonicalHistoryEnvelope[];
    }
  | undefined {
  const sourceIndex = change.currentUserSourceIndex;
  if (sourceIndex === undefined) return undefined;
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= active.length) {
    throw new TypeError('Canonical current-user tail source lineage is invalid.');
  }
  if (change.messages.length < 2) {
    throw new TypeError('Canonical current-user tail is incomplete.');
  }
  const marker = change.messages.at(-2);
  const userMessage = change.messages.at(-1);
  const source = requireExternalCurrentUserSource(active[sourceIndex]);
  const normalizedMarker = requireHiddenTypedCustom(marker);
  const normalizedUser = requireExactCurrentUserMessage(userMessage, source);
  return {
    baseMessages: change.messages.slice(0, -2),
    user: source,
    envelopes: [
      envelope({
        change,
        message: normalizedMarker,
        turnId: `${change.turnId}:compaction`,
        index: change.messages.length - 2,
      }),
      { ...withoutHistoryArtifact(source), message: normalizedUser },
    ],
  };
}

function requireExternalCurrentUserSource(
  source: CanonicalHistoryEnvelope | undefined,
): CanonicalHistoryEnvelope {
  if (!source || !isUserMessageId(source.message_id) || source.message.role !== 'user') {
    throw new TypeError('Canonical current-user tail source is not an external user.');
  }
  return source;
}

function requireHiddenTypedCustom(value: unknown): CanonicalHistoryMessage {
  if (!isHiddenTypedCustom(value)) {
    throw new TypeError('Canonical current-user tail marker is invalid.');
  }
  return historyMessage(value);
}

function requireExactCurrentUserMessage(
  value: unknown,
  source: CanonicalHistoryEnvelope,
): CanonicalHistoryMessage {
  const normalized = historyMessage(value);
  if (normalized.role !== 'user' || !sameJson(source.message, normalized)) {
    throw new TypeError(
      `Canonical current-user tail changed external user payload: ${source.message_id}`,
    );
  }
  return normalized;
}

function isHiddenTypedCustom(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Reflect.get(value, 'role') === 'custom' &&
    Reflect.get(value, 'display') === false &&
    typeof Reflect.get(value, 'customType') === 'string' &&
    Boolean((Reflect.get(value, 'customType') as string).trim()) &&
    typeof Reflect.get(value, 'timestamp') === 'number' &&
    Number.isFinite(Reflect.get(value, 'timestamp'))
  );
}

function validateToolReplacementSourceIndexes(
  change: Extract<
    SessionCanonicalHistoryCompactionChange,
    { readonly method: 'tool_archive' | 'tool_trim' }
  >,
  active: readonly CanonicalHistoryEnvelope[],
  expectedLength: number,
): readonly number[] {
  const indexes = change.replacementSourceIndexes;
  if (!Array.isArray(indexes) || indexes.length !== expectedLength) {
    throw new TypeError('Canonical ToolResult compaction source lineage is incomplete.');
  }
  let previous = -1;
  indexes.forEach((index) => {
    if (
      !Number.isSafeInteger(index) ||
      index <= previous ||
      index >= active.length ||
      index === change.currentUserSourceIndex
    ) {
      throw new TypeError('Canonical ToolResult compaction source lineage is invalid.');
    }
    previous = index;
  });
  return indexes;
}

function assertToolReplacementMessage(
  source: CanonicalHistoryEnvelope,
  replacement: CanonicalHistoryMessage,
): void {
  if (source.message.role !== replacement.role) {
    throw new TypeError('Canonical ToolResult compaction changed a message role.');
  }
  if (isUserMessageId(source.message_id) && !sameJson(source.message, replacement)) {
    throw new TypeError(
      `Canonical ToolResult compaction changed external user payload: ${source.message_id}`,
    );
  }
  if (
    source.message.role !== 'user' &&
    source.message.role !== 'toolResult' &&
    !sameJson(source.message, replacement)
  ) {
    throw new TypeError(
      `Canonical ToolResult compaction changed a non-result message: ${source.message_id}`,
    );
  }
  if (
    source.message.role === 'toolResult' &&
    !sameJson(withoutContent(source.message), withoutContent(replacement))
  ) {
    throw new TypeError(
      `Canonical ToolResult compaction changed tool result identity: ${source.message_id}`,
    );
  }
}

function withoutContent(message: CanonicalHistoryMessage): Readonly<Record<string, unknown>> {
  const semanticMessage = { ...message };
  delete semanticMessage['content'];
  return semanticMessage;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function preserveHistoryArtifact(
  existing: readonly CanonicalHistoryEnvelope[],
  replacement: readonly CanonicalHistoryEnvelope[],
): CanonicalHistoryEnvelope[] {
  const artifact = existing[0]?.history_artifact;
  if (!artifact) return [...replacement];
  return replacement.map((record, index) => {
    const semanticEnvelope = withoutHistoryArtifact(record);
    return index === 0 ? { ...semanticEnvelope, history_artifact: artifact } : semanticEnvelope;
  });
}

function markHistoryArtifact(
  replacement: readonly CanonicalHistoryEnvelope[],
  marker: NonNullable<CanonicalHistoryEnvelope['history_artifact']>,
): CanonicalHistoryEnvelope[] {
  if (replacement.length === 0) {
    throw new TypeError('Canonical compaction replacement cannot be empty.');
  }
  return replacement.map((record, index) => {
    const semanticEnvelope = withoutHistoryArtifact(record);
    return index === 0 ? { ...semanticEnvelope, history_artifact: marker } : semanticEnvelope;
  });
}

function withoutHistoryArtifact(record: CanonicalHistoryEnvelope): CanonicalHistoryEnvelope {
  return {
    message_id: record.message_id,
    turn_id: record.turn_id,
    message: record.message,
    ...(record.turn_config ? { turn_config: record.turn_config } : {}),
  };
}

function activeGeneration(records: readonly CanonicalHistoryEnvelope[]): number {
  const artifactGeneration = records[0]?.history_artifact?.generation;
  if (artifactGeneration !== undefined) return artifactGeneration;
  const first = records[0]?.message;
  if (!first || first.role !== 'user') return 0;
  const marker = Reflect.get(first, 'archonCompaction');
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return 0;
  const generation = Reflect.get(marker, 'generation');
  return typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0
    ? generation
    : 0;
}

function safeCompactionId(value: string): string {
  const sanitized = value.trim().replaceAll(/[^A-Za-z0-9._-]/gu, '-');
  if (!sanitized) throw new TypeError('Compaction id is required.');
  const normalized = /^[A-Za-z0-9]/u.test(sanitized) ? sanitized : `c${sanitized}`;
  return normalized.slice(0, 120);
}

function replacementSnapshotId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value = Reflect.get(metadata, 'replacementId');
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function detached<T>(value: T): T {
  return structuredClone(value);
}
