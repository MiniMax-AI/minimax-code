import { randomUUID } from 'node:crypto';

import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';

import {
  sessionLocks,
  turnIngress,
  turnIngressClientRequests,
  turnIngressSequences,
} from '../../../infra/db/schema/turn.js';
import {
  COMPACTION_DELETING_OWNER_KIND,
  createRecoveredTerminalFact,
  DELETION_FENCE_EXPIRES_AT_MS,
  MAINTENANCE_DELETING_OWNER_KIND,
  MAINTENANCE_OWNER_KIND,
  recoverDeadLegacyOwnerInTransaction,
  recoverExpiredInTransaction,
  recoverProcessRestartInTransaction,
  SESSION_DELETION_OWNER_KIND,
  TURN_DELETING_OWNER_KIND,
  type TurnProcessRestartRecoveryInput,
} from './turn-lease-recovery.js';
import type {
  AdmitTurnInput,
  AdmitTurnResult,
  TurnRecoveryTerminalFact,
  TurnRepository,
  TurnRepositoryOptions,
} from './contracts.js';
import { createPluginHookSessionPersistence } from './plugin-hook-session.repository.js';
import {
  persistedTurnConsumesQueuePause,
  publishQueueFacts,
} from './turn-queue-pause-persistence.js';

const DEFAULT_LEASE_MS = 30 * 60 * 1_000;
const LEGACY_TURN_LEASE_STALL_MS = 30_000;
const LEGACY_TURN_LEASE_OWNER_ID =
  /^turn-lease:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface LegacyTurnLeaseObservation {
  readonly expiresAtMs: number;
  readonly unchangedSinceMs: number;
}

interface LegacyTurnLeaseCandidate {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly ownerKind: string;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
  readonly observedAtMs: number;
}

export function createTurnRepository(options: TurnRepositoryOptions): TurnRepository {
  const nowMs = options.nowMs ?? Date.now;
  const makeLeaseId = options.makeLeaseId ?? (() => `turn-lease:${randomUUID()}`);
  const makeDeletionOwnerId =
    options.makeDeletionOwnerId ?? (() => `session-delete:${randomUUID()}`);
  const isLeaseOwnerAlive: (ownerId: string) => boolean | undefined =
    options.isLeaseOwnerAlive ?? (() => undefined);
  const isLeaseOwnerCurrent = options.isLeaseOwnerCurrent ?? (() => true);
  const leaseMs = Math.max(1, Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS));
  const pendingSettlements = new Map<string, PendingSettlement>();
  const legacyTurnLeaseObservations = new Map<string, LegacyTurnLeaseObservation>();
  const pluginHookSessionPersistence = createPluginHookSessionPersistence(options.db, nowMs);

  return {
    tryAcquireSessionMaintenance: async (sessionId) =>
      options.db.transaction(
        (tx) => {
          const now = nowMs();
          const rejection = options.sessionAdmission.rejectionInTransaction(tx, { sessionId });
          if (rejection) return undefined;
          const recovery = recoverExpiredInTransaction(tx, sessionId, now);
          if (findSessionLock(tx, sessionId)) return undefined;
          const leaseId = makeLeaseId();
          tx.insert(sessionLocks)
            .values({
              sessionId,
              ownerId: leaseId,
              ownerKind: MAINTENANCE_OWNER_KIND,
              acquiredAtMs: now,
              expiresAtMs: now + leaseMs,
            })
            .run();
          return withRecoveredTerminalFacts(
            {
              sessionId,
              leaseId,
              renewAfterMs: Math.max(1, Math.floor(leaseMs / 2)),
            },
            recovery.terminalFacts,
          );
        },
        { behavior: 'immediate' },
      ),
    renewSessionMaintenance: async (lease) => {
      const now = nowMs();
      const updated = options.db
        .update(sessionLocks)
        .set({ expiresAtMs: now + leaseMs })
        .where(
          and(
            eq(sessionLocks.sessionId, lease.sessionId),
            eq(sessionLocks.ownerId, lease.leaseId),
            inArray(sessionLocks.ownerKind, [
              MAINTENANCE_OWNER_KIND,
              MAINTENANCE_DELETING_OWNER_KIND,
            ]),
            gt(sessionLocks.expiresAtMs, now),
          ),
        )
        .run();
      return updated.changes === 1;
    },
    releaseSessionMaintenance: (lease) => releaseSessionMaintenanceLease(options, nowMs, lease),
    admit: (input) =>
      admitRepositoryTurn(options, input, {
        pendingSettlements,
        nowMs,
        makeLeaseId,
        leaseMs,
      }),
    renew: async ({ sessionId, leaseId }) => {
      const now = nowMs();
      const updated = options.db
        .update(sessionLocks)
        .set({ expiresAtMs: now + leaseMs })
        .where(
          and(
            eq(sessionLocks.sessionId, sessionId),
            eq(sessionLocks.ownerId, leaseId),
            gt(sessionLocks.expiresAtMs, now),
          ),
        )
        .run();
      return updated.changes === 1;
    },
    settle: async (input) => {
      const pending: PendingSettlement = {
        sessionId: input.sessionId,
        turnId: input.turnId,
        leaseId: input.leaseId,
      };
      try {
        const committed = options.db.transaction(
          (tx) => {
            const completedAtMs = nowMs();
            const result = settleInTransaction(tx, input, completedAtMs);
            const facts =
              result.status === 'settled'
                ? options.priorityFence.settledInTransaction(tx, {
                    sessionId: input.sessionId,
                    triggerTurnId: input.turnId,
                    ...(input.queuePauseCause ? { cause: input.queuePauseCause } : {}),
                    pausedAtMs: completedAtMs,
                  })
                : [];
            return { result, facts };
          },
          { behavior: 'immediate' },
        );
        if (samePendingSettlement(pendingSettlements.get(input.sessionId), pending)) {
          pendingSettlements.delete(input.sessionId);
        }
        publishQueueFacts(options, committed.facts);
        return committed.result;
      } catch (error) {
        pendingSettlements.set(input.sessionId, pending);
        throw error;
      }
    },
    recoverExpired: async (sessionId) =>
      options.db.transaction((tx) => recoverExpiredInTransaction(tx, sessionId, nowMs()), {
        behavior: 'immediate',
      }),
    recoverProcessRestart: ({ processStartedAtMs }) =>
      recoverRepositoryProcessRestart(
        options,
        {
          processStartedAtMs,
          completedAtMs: nowMs(),
          isLeaseOwnerAlive,
          makeDeletionOwnerId,
        },
        legacyTurnLeaseObservations,
      ),
    beginSessionDeletion: async (sessionId) => {
      const pending = pendingSettlements.get(sessionId);
      const result = options.db.transaction(
        (tx) => {
          const now = nowMs();
          if (pending) recoverPendingSettlementInTransaction(tx, pending, now);
          return beginSessionDeletionInTransaction(tx, {
            sessionId,
            now,
            makeDeletionOwnerId,
            isLeaseOwnerAlive,
            isLeaseOwnerCurrent,
          });
        },
        { behavior: 'immediate' },
      );
      if (pendingSettlements.get(sessionId) === pending) pendingSettlements.delete(sessionId);
      return result;
    },
    readSessionDeletion: async (sessionId) => readSessionDeletionState(options.db, sessionId),
    isSessionDeleting: async (sessionId) =>
      options.sessionAdmission.rejectionInTransaction(options.db, { sessionId }) ===
        'session-deleting' ||
      isDeletionOwnerKind(findSessionLock(options.db, sessionId)?.ownerKind),
    deleteSessionData: (sessionId) => deleteTurnSessionData(options, pendingSettlements, sessionId),
    completeSessionDeletion: (sessionId) =>
      completeTurnSessionDeletion(options, sessionId, isLeaseOwnerCurrent),
    findReceipt: (turnId) => findTurnReceipt(options, turnId),
    findActiveTurn: async (sessionId) => findActiveTurn(options.db, sessionId, nowMs()),
    findLatestTurnActivity: async (sessionId) => findLatestTurnActivity(options.db, sessionId),
    ...pluginHookSessionPersistence,
    findSteeringReceipt: (input) => findSteeringReceipt(options, input),
    reserveSteeringReceipt: (input) => reserveSteeringReceipt(options, input),
    releaseSteeringReceipt: (input) => releaseSteeringReceipt(options, input),
    revokeAdmission: (input) => revokeAdmission(options, input, nowMs()),
    isAcceptedInTransaction: (db, query) => Boolean(findAcceptedQueueTurn(db, query)),
    markAcknowledgedInTransaction: (db, query) => {
      const receipt = findAcceptedQueueTurn(db, query);
      if (!receipt) {
        throw new Error(`Queue claim is not accepted: ${query.sessionId}/${query.claimId}`);
      }
      db.update(turnIngress)
        .set({ queueAcknowledgedAtMs: nowMs() })
        .where(eq(turnIngress.turnId, receipt.turnId))
        .run();
    },
  };
}

async function admitRepositoryTurn(
  options: TurnRepositoryOptions,
  input: AdmitTurnInput,
  dependencies: {
    readonly pendingSettlements: Map<string, PendingSettlement>;
    readonly nowMs: () => number;
    readonly makeLeaseId: () => string;
    readonly leaseMs: number;
  },
): Promise<AdmitTurnResult> {
  const pending = dependencies.pendingSettlements.get(input.sessionId);
  const committed = options.db.transaction(
    (tx) => {
      const result = admitTurnInTransaction(tx, options, input, {
        pending,
        nowMs: dependencies.nowMs(),
        makeLeaseId: dependencies.makeLeaseId,
        leaseMs: dependencies.leaseMs,
      });
      if (result.status !== 'accepted') return { result, facts: [] };
      const effect = options.priorityFence.acceptedInTransaction(tx, {
        sessionId: input.sessionId,
        consumeQueuePause: input.consumeQueuePause === true,
      });
      return {
        result:
          input.foreground || effect.revokeToken
            ? {
                ...result,
                ...(input.foreground ? { foreground: true as const } : {}),
                ...(effect.revokeToken ? { queuePauseRevokeToken: effect.revokeToken } : {}),
              }
            : result,
        facts: effect.facts,
      };
    },
    { behavior: 'immediate' },
  );
  if (dependencies.pendingSettlements.get(input.sessionId) === pending) {
    dependencies.pendingSettlements.delete(input.sessionId);
  }
  publishQueueFacts(options, committed.facts);
  return committed.result;
}

function findLatestTurnActivity(
  db: TurnRepositoryOptions['db'],
  sessionId: string,
): Awaited<ReturnType<TurnRepository['findLatestTurnActivity']>> {
  const latest = db
    .select({
      turnId: turnIngress.turnId,
      acceptedAtMs: turnIngress.acceptedAtMs,
      completedAtMs: turnIngress.completedAtMs,
    })
    .from(turnIngress)
    .where(eq(turnIngress.sessionId, sessionId))
    .orderBy(desc(turnIngress.acceptedSequence))
    .limit(1)
    .get();
  if (!latest) return undefined;
  const completedAtMs = latest.completedAtMs ?? undefined;
  return {
    turnId: latest.turnId,
    acceptedAtMs: latest.acceptedAtMs,
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    activityAtMs: Math.max(latest.acceptedAtMs, completedAtMs ?? latest.acceptedAtMs),
  };
}

async function recoverRepositoryProcessRestart(
  options: TurnRepositoryOptions,
  input: TurnProcessRestartRecoveryInput,
  legacyTurnLeaseObservations: Map<string, LegacyTurnLeaseObservation>,
): ReturnType<TurnRepository['recoverProcessRestart']> {
  if (!Number.isFinite(input.processStartedAtMs)) {
    throw new TypeError('processStartedAtMs must be finite');
  }
  const observedLegacyTurnLeases = new Set<string>();
  const committed = options.db.transaction(
    (tx) => {
      const recovery = recoverProcessRestartInTransaction(tx, {
        ...input,
        shouldRecoverLegacyTurnLease: (candidate) =>
          shouldRecoverLegacyTurnLease(
            legacyTurnLeaseObservations,
            observedLegacyTurnLeases,
            candidate,
          ),
      });
      const queueFacts = recovery.liveSessionIds.flatMap((sessionId) =>
        persistedTurnConsumesQueuePause(tx, sessionId)
          ? options.priorityFence.acceptedInTransaction(tx, {
              sessionId,
              consumeQueuePause: true,
            }).facts
          : [],
      );
      return {
        result: {
          recovered: recovery.recovered,
          terminalFacts: recovery.terminalFacts,
          ...(recovery.liveSessionIds.length > 0
            ? { liveSessionIds: recovery.liveSessionIds }
            : {}),
          ...(recovery.pendingDeletionSessionIds.length > 0
            ? { pendingDeletionSessionIds: recovery.pendingDeletionSessionIds }
            : {}),
        },
        queueFacts,
      };
    },
    { behavior: 'immediate' },
  );
  for (const key of legacyTurnLeaseObservations.keys()) {
    if (!observedLegacyTurnLeases.has(key)) legacyTurnLeaseObservations.delete(key);
  }
  publishQueueFacts(options, committed.queueFacts);
  return committed.result;
}

function shouldRecoverLegacyTurnLease(
  observations: Map<string, LegacyTurnLeaseObservation>,
  observedLeases: Set<string>,
  candidate: LegacyTurnLeaseCandidate,
): boolean {
  if (!LEGACY_TURN_LEASE_OWNER_ID.test(candidate.ownerId)) return false;
  const key = [
    candidate.sessionId,
    candidate.ownerId,
    candidate.ownerKind,
    String(candidate.acquiredAtMs),
  ].join('\u0000');
  observedLeases.add(key);
  const previous = observations.get(key);
  if (
    !previous ||
    previous.expiresAtMs !== candidate.expiresAtMs ||
    candidate.observedAtMs < previous.unchangedSinceMs
  ) {
    observations.set(key, {
      expiresAtMs: candidate.expiresAtMs,
      unchangedSinceMs: candidate.observedAtMs,
    });
    return false;
  }
  if (candidate.observedAtMs - previous.unchangedSinceMs < LEGACY_TURN_LEASE_STALL_MS) {
    return false;
  }
  observations.delete(key);
  return true;
}

async function releaseSessionMaintenanceLease(
  options: TurnRepositoryOptions,
  nowMs: () => number,
  lease: Parameters<TurnRepository['releaseSessionMaintenance']>[0],
): Promise<void> {
  options.db.transaction(
    (tx) => {
      const lock = findSessionLock(tx, lease.sessionId);
      if (lock?.ownerId !== lease.leaseId) return;
      if (lock.ownerKind === MAINTENANCE_DELETING_OWNER_KIND) {
        tx.update(sessionLocks)
          .set({
            ownerKind: SESSION_DELETION_OWNER_KIND,
            acquiredAtMs: nowMs(),
            expiresAtMs: DELETION_FENCE_EXPIRES_AT_MS,
          })
          .where(
            and(
              eq(sessionLocks.sessionId, lease.sessionId),
              eq(sessionLocks.ownerId, lease.leaseId),
            ),
          )
          .run();
        return;
      }
      if (lock.ownerKind === MAINTENANCE_OWNER_KIND) {
        tx.delete(sessionLocks)
          .where(
            and(
              eq(sessionLocks.sessionId, lease.sessionId),
              eq(sessionLocks.ownerId, lease.leaseId),
            ),
          )
          .run();
      }
    },
    { behavior: 'immediate' },
  );
}

async function deleteTurnSessionData(
  options: TurnRepositoryOptions,
  pendingSettlements: Map<string, PendingSettlement>,
  sessionId: string,
): Promise<void> {
  options.db.transaction(
    (tx) => {
      const lock = findSessionLock(tx, sessionId);
      const turnIds = tx
        .select({ turnId: turnIngress.turnId })
        .from(turnIngress)
        .where(eq(turnIngress.sessionId, sessionId))
        .all()
        .map(({ turnId }) => turnId);
      if (!lock && turnIds.length === 0) return;
      if (lock?.ownerKind !== SESSION_DELETION_OWNER_KIND) {
        throw new Error(`Session deletion is not quiescent: ${sessionId}`);
      }
      tx.delete(turnIngressClientRequests)
        .where(eq(turnIngressClientRequests.sessionId, sessionId))
        .run();
      if (turnIds.length > 0) {
        tx.delete(turnIngressSequences).where(inArray(turnIngressSequences.turnId, turnIds)).run();
      }
      tx.delete(turnIngress).where(eq(turnIngress.sessionId, sessionId)).run();
    },
    { behavior: 'immediate' },
  );
  pendingSettlements.delete(sessionId);
}

async function completeTurnSessionDeletion(
  options: TurnRepositoryOptions,
  sessionId: string,
  isLeaseOwnerCurrent: (ownerId: string) => boolean,
): Promise<void> {
  options.db.transaction(
    (tx) => {
      const lock = findSessionLock(tx, sessionId);
      if (!lock) return;
      if (lock.ownerKind !== SESSION_DELETION_OWNER_KIND) {
        throw new Error(`Session deletion is not quiescent: ${sessionId}`);
      }
      if (!isLeaseOwnerCurrent(lock.ownerId)) {
        throw new Error(`Session deletion is owned by another Runtime: ${sessionId}`);
      }
      const remainingTurn = tx
        .select({ turnId: turnIngress.turnId })
        .from(turnIngress)
        .where(eq(turnIngress.sessionId, sessionId))
        .get();
      if (remainingTurn) {
        throw new Error(
          `Session deletion still has Turn data: ${sessionId}/${remainingTurn.turnId}`,
        );
      }
      tx.delete(sessionLocks).where(eq(sessionLocks.sessionId, sessionId)).run();
    },
    { behavior: 'immediate' },
  );
}

const receiptQueries = new WeakMap<
  TurnRepositoryOptions['db'],
  ReturnType<typeof prepareReceiptQuery>
>();

function prepareReceiptQuery(db: TurnRepositoryOptions['db']) {
  return db
    .select()
    .from(turnIngress)
    .where(eq(turnIngress.turnId, sql.placeholder('turnId')))
    .prepare();
}

async function findTurnReceipt(
  options: TurnRepositoryOptions,
  turnId: string,
): ReturnType<TurnRepository['findReceipt']> {
  let query = receiptQueries.get(options.db);
  if (!query) {
    query = prepareReceiptQuery(options.db);
    receiptQueries.set(options.db, query);
  }
  const receipt = query.get({ turnId });
  if (!receipt) return undefined;
  if (
    !storedBusyReason(receipt.busyReason) ||
    !receipt.inputDigest ||
    !Number.isSafeInteger(receipt.acceptedSequence) ||
    receipt.acceptedSequence === null ||
    receipt.acceptedSequence <= 0
  ) {
    throw new Error(`Turn receipt is malformed: ${turnId}`);
  }
  return {
    sessionId: receipt.sessionId,
    turnId: receipt.turnId,
    inputDigest: receipt.inputDigest,
    acceptedSequence: receipt.acceptedSequence,
  };
}

function findActiveTurn(db: RepositoryDb, sessionId: string, nowMs: number) {
  const lock = db
    .select({ ownerKind: sessionLocks.ownerKind })
    .from(sessionLocks)
    .where(
      and(
        eq(sessionLocks.sessionId, sessionId),
        inArray(sessionLocks.ownerKind, [
          'turn',
          'compaction',
          TURN_DELETING_OWNER_KIND,
          COMPACTION_DELETING_OWNER_KIND,
        ]),
        gt(sessionLocks.expiresAtMs, nowMs),
      ),
    )
    .get();
  if (!lock) return undefined;
  const accepted = db
    .select({ turnId: turnIngress.turnId, busyReason: turnIngress.busyReason })
    .from(turnIngress)
    .where(and(eq(turnIngress.sessionId, sessionId), eq(turnIngress.status, 'accepted')))
    .orderBy(desc(turnIngress.acceptedSequence))
    .get();
  const busyReason = accepted ? storedBusyReason(accepted.busyReason) : undefined;
  return accepted && busyReason ? { turnId: accepted.turnId, busyReason } : undefined;
}

async function findSteeringReceipt(
  options: TurnRepositoryOptions,
  input: Parameters<TurnRepository['findSteeringReceipt']>[0],
): ReturnType<TurnRepository['findSteeringReceipt']> {
  const mapping = options.db
    .select({ turnId: turnIngressClientRequests.turnId })
    .from(turnIngressClientRequests)
    .where(
      and(
        eq(turnIngressClientRequests.sessionId, input.sessionId),
        eq(turnIngressClientRequests.clientRequestId, input.clientRequestId),
      ),
    )
    .get();
  return mapping ? findTurnReceipt(options, mapping.turnId) : undefined;
}

async function reserveSteeringReceipt(
  options: TurnRepositoryOptions,
  input: Parameters<TurnRepository['reserveSteeringReceipt']>[0],
): ReturnType<TurnRepository['reserveSteeringReceipt']> {
  return options.db.transaction(
    (tx) => {
      const existing = tx
        .select({ turnId: turnIngressClientRequests.turnId })
        .from(turnIngressClientRequests)
        .where(
          and(
            eq(turnIngressClientRequests.sessionId, input.sessionId),
            eq(turnIngressClientRequests.clientRequestId, input.clientRequestId),
          ),
        )
        .get();
      if (existing) return { status: 'duplicate' as const, turnId: existing.turnId };
      const accepted = tx
        .select({ turnId: turnIngress.turnId })
        .from(turnIngress)
        .where(
          and(
            eq(turnIngress.sessionId, input.sessionId),
            eq(turnIngress.turnId, input.turnId),
            eq(turnIngress.status, 'accepted'),
          ),
        )
        .get();
      if (!accepted) return { status: 'not-accepted' as const };
      tx.insert(turnIngressClientRequests)
        .values({
          sessionId: input.sessionId,
          clientRequestId: input.clientRequestId,
          turnId: input.turnId,
          ordinal: 0,
        })
        .run();
      return { status: 'reserved' as const };
    },
    { behavior: 'immediate' },
  );
}

async function releaseSteeringReceipt(
  options: TurnRepositoryOptions,
  input: Parameters<TurnRepository['releaseSteeringReceipt']>[0],
): Promise<void> {
  options.db.transaction(
    (tx) => {
      tx.delete(turnIngressClientRequests)
        .where(
          and(
            eq(turnIngressClientRequests.sessionId, input.sessionId),
            eq(turnIngressClientRequests.clientRequestId, input.clientRequestId),
            eq(turnIngressClientRequests.turnId, input.turnId),
          ),
        )
        .run();
    },
    { behavior: 'immediate' },
  );
}

async function revokeAdmission(
  options: TurnRepositoryOptions,
  input: Parameters<TurnRepository['revokeAdmission']>[0],
  restoredAtMs: number,
): Promise<boolean> {
  const committed = options.db.transaction(
    (tx) => {
      const receipt = tx
        .select({ status: turnIngress.status })
        .from(turnIngress)
        .where(
          and(
            eq(turnIngress.sessionId, input.sessionId),
            eq(turnIngress.turnId, input.turnId),
            eq(turnIngress.status, 'accepted'),
          ),
        )
        .get();
      const lock = findSessionLock(tx, input.sessionId);
      if (!receipt || lock?.ownerId !== input.leaseId || lock.ownerKind !== 'turn') {
        return { revoked: false, facts: [] };
      }
      tx.delete(turnIngressClientRequests)
        .where(eq(turnIngressClientRequests.turnId, input.turnId))
        .run();
      tx.delete(turnIngressSequences).where(eq(turnIngressSequences.turnId, input.turnId)).run();
      tx.delete(turnIngress).where(eq(turnIngress.turnId, input.turnId)).run();
      tx.delete(sessionLocks)
        .where(
          and(
            eq(sessionLocks.sessionId, input.sessionId),
            eq(sessionLocks.ownerId, input.leaseId),
            eq(sessionLocks.ownerKind, 'turn'),
          ),
        )
        .run();
      return {
        revoked: true,
        facts: options.priorityFence.revokedInTransaction(tx, {
          sessionId: input.sessionId,
          restoredAtMs,
          ...(input.queuePauseRevokeToken ? { revokeToken: input.queuePauseRevokeToken } : {}),
        }),
      };
    },
    { behavior: 'immediate' },
  );
  publishQueueFacts(options, committed.facts);
  return committed.revoked;
}

function storedBusyReason(value: string): AdmitTurnInput['busyReason'] | undefined {
  if (value === 'turn' || value === 'send' || value === 'dispatcher') return 'turn';
  return value === 'compaction' ? 'compaction' : undefined;
}

type Transaction = Parameters<Parameters<TurnRepositoryOptions['db']['transaction']>[0]>[0];
type SettleTurnInput = Parameters<TurnRepository['settle']>[0];
type PendingSettlement = Pick<SettleTurnInput, 'sessionId' | 'turnId' | 'leaseId'>;
type QueueAcceptanceQuery = Parameters<TurnRepository['isAcceptedInTransaction']>[1];
type QueueLookupDb = Parameters<TurnRepository['isAcceptedInTransaction']>[0] | Transaction;
type RepositoryDb = TurnRepositoryOptions['db'] | Transaction;

function recoverAdmissionTerminalFacts(
  tx: Transaction,
  input: Pick<AdmitTurnInput, 'sessionId'>,
  pending: PendingSettlement | undefined,
  nowMs: number,
): readonly TurnRecoveryTerminalFact[] {
  const pendingRecovery = pending
    ? recoverPendingSettlementInTransaction(tx, pending, nowMs)
    : undefined;
  const expiredRecovery = recoverExpiredInTransaction(tx, input.sessionId, nowMs);
  const legacyRecovery = recoverDeadLegacyOwnerInTransaction(tx, input.sessionId, nowMs);
  return [
    ...(pendingRecovery ? [pendingRecovery] : []),
    ...expiredRecovery.terminalFacts,
    ...legacyRecovery.terminalFacts,
  ];
}

function admitTurnInTransaction(
  tx: Transaction,
  options: TurnRepositoryOptions,
  input: AdmitTurnInput,
  context: {
    readonly pending: PendingSettlement | undefined;
    readonly nowMs: number;
    readonly makeLeaseId: () => string;
    readonly leaseMs: number;
  },
): AdmitTurnResult {
  const sessionRejection = options.sessionAdmission.rejectionInTransaction(tx, {
    sessionId: input.sessionId,
  });
  if (blocksAdmission(sessionRejection, input.bypassSessionMutation)) {
    return { status: 'rejected', reason: sessionRejection };
  }
  const terminalFacts = recoverAdmissionTerminalFacts(tx, input, context.pending, context.nowMs);
  const lock = findSessionLock(tx, input.sessionId);
  if (lock && isDeletionOwnerKind(lock.ownerKind)) {
    return withRecoveredTerminalFacts(
      { status: 'rejected', reason: 'session-deleting' },
      terminalFacts,
    );
  }
  const duplicate = findDuplicate(tx, input);
  if (duplicate) return withRecoveredTerminalFacts(duplicate, terminalFacts);
  const lockRejection = activeLockRejection(lock);
  if (lockRejection) return withRecoveredTerminalFacts(lockRejection, terminalFacts);
  if (
    !input.bypassPriorityFence &&
    options.priorityFence.blocksInTransaction(tx, {
      sessionId: input.sessionId,
      priority: input.priority,
    })
  ) {
    return withRecoveredTerminalFacts(
      { status: 'rejected', reason: 'priority-blocked' },
      terminalFacts,
    );
  }
  const policyRejection = options.admissionPolicy?.applyInTransaction(tx, input);
  if (policyRejection) {
    return withRecoveredTerminalFacts(
      { status: 'rejected', reason: policyRejection },
      terminalFacts,
    );
  }
  return withRecoveredTerminalFacts(
    insertAdmission(tx, input, {
      leaseId: context.makeLeaseId(),
      nowMs: context.nowMs,
      leaseMs: context.leaseMs,
    }),
    terminalFacts,
  );
}

function activeLockRejection(
  lock: ReturnType<typeof findSessionLock>,
): AdmitTurnResult | undefined {
  if (!lock) return undefined;
  return {
    status: 'rejected',
    reason: lock.ownerKind === 'compaction' ? 'compaction-active' : 'active-turn',
  };
}

function blocksAdmission(
  rejection: ReturnType<TurnRepositoryOptions['sessionAdmission']['rejectionInTransaction']>,
  bypassSessionMutation: boolean | undefined,
): rejection is NonNullable<typeof rejection> {
  return Boolean(rejection && !(rejection === 'session-mutating' && bypassSessionMutation));
}
function beginSessionDeletionInTransaction(
  tx: Transaction,
  input: {
    readonly sessionId: string;
    readonly now: number;
    readonly makeDeletionOwnerId: () => string;
    readonly isLeaseOwnerAlive: (ownerId: string) => boolean | undefined;
    readonly isLeaseOwnerCurrent: (ownerId: string) => boolean;
  },
): Exclude<Awaited<ReturnType<TurnRepository['readSessionDeletion']>>, { status: 'not-started' }> {
  const { sessionId, now, makeDeletionOwnerId, isLeaseOwnerAlive, isLeaseOwnerCurrent } = input;
  recoverExpiredDeletionTurnInTransaction(tx, sessionId, now);
  const lock = findSessionLock(tx, sessionId);
  if (!lock) {
    tx.insert(sessionLocks)
      .values({
        sessionId,
        ownerId: makeDeletionOwnerId(),
        ownerKind: SESSION_DELETION_OWNER_KIND,
        acquiredAtMs: now,
        expiresAtMs: DELETION_FENCE_EXPIRES_AT_MS,
      })
      .run();
    return { status: 'quiescent' };
  }
  if (lock.ownerKind === SESSION_DELETION_OWNER_KIND) {
    if (isLeaseOwnerCurrent(lock.ownerId)) return { status: 'quiescent' };
    if (isLeaseOwnerAlive(lock.ownerId) !== false) {
      throw new Error(`Session deletion is owned by another Runtime: ${sessionId}`);
    }
    const reclaimed = tx
      .update(sessionLocks)
      .set({
        ownerId: makeDeletionOwnerId(),
        acquiredAtMs: now,
        expiresAtMs: DELETION_FENCE_EXPIRES_AT_MS,
      })
      .where(
        and(
          eq(sessionLocks.sessionId, sessionId),
          eq(sessionLocks.ownerId, lock.ownerId),
          eq(sessionLocks.ownerKind, SESSION_DELETION_OWNER_KIND),
        ),
      )
      .run();
    if (reclaimed.changes !== 1) {
      throw new Error(`Session deletion reclaim lost ownership: ${sessionId}`);
    }
    return { status: 'quiescent' };
  }
  const deletingKind = deletionPendingOwnerKind(lock.ownerKind);
  if (!deletingKind) {
    throw new Error(`Session lock cannot enter deletion: ${sessionId}/${lock.ownerKind}`);
  }
  if (lock.ownerKind !== deletingKind) {
    tx.update(sessionLocks)
      .set({ ownerKind: deletingKind })
      .where(and(eq(sessionLocks.sessionId, sessionId), eq(sessionLocks.ownerId, lock.ownerId)))
      .run();
  }
  if (deletingKind === MAINTENANCE_DELETING_OWNER_KIND) {
    return { status: 'maintenance' };
  }
  return { status: 'active', turnId: requireAcceptedTurnId(tx, sessionId) };
}

function recoverExpiredDeletionTurnInTransaction(
  tx: Transaction,
  sessionId: string,
  completedAtMs: number,
): void {
  const lock = findSessionLock(tx, sessionId);
  if (!lock || !deletionPendingOwnerKind(lock.ownerKind) || lock.expiresAtMs > completedAtMs) {
    return;
  }
  if (lock.ownerKind === MAINTENANCE_DELETING_OWNER_KIND) {
    tx.update(sessionLocks)
      .set({
        ownerKind: SESSION_DELETION_OWNER_KIND,
        acquiredAtMs: completedAtMs,
        expiresAtMs: DELETION_FENCE_EXPIRES_AT_MS,
      })
      .where(and(eq(sessionLocks.sessionId, sessionId), eq(sessionLocks.ownerId, lock.ownerId)))
      .run();
    return;
  }
  const turnId = requireAcceptedTurnId(tx, sessionId);
  const updated = tx
    .update(turnIngress)
    .set({ status: 'failed', completedAtMs })
    .where(
      and(
        eq(turnIngress.sessionId, sessionId),
        eq(turnIngress.turnId, turnId),
        eq(turnIngress.status, 'accepted'),
      ),
    )
    .run();
  const promoted = releaseOrPromoteDeletionFence(tx, {
    sessionId,
    leaseId: lock.ownerId,
    ownerKind: lock.ownerKind,
    completedAtMs,
  });
  if (updated.changes !== 1 || promoted.changes !== 1) {
    throw new Error(`Expired Session deletion Turn lost ownership: ${sessionId}/${turnId}`);
  }
}

function readSessionDeletionState(
  db: TurnRepositoryOptions['db'],
  sessionId: string,
): Awaited<ReturnType<TurnRepository['readSessionDeletion']>> {
  const lock = findSessionLock(db, sessionId);
  if (!lock || !isDeletionOwnerKind(lock.ownerKind)) return { status: 'not-started' };
  if (lock.ownerKind === SESSION_DELETION_OWNER_KIND) return { status: 'quiescent' };
  if (lock.ownerKind === MAINTENANCE_DELETING_OWNER_KIND) return { status: 'maintenance' };
  return { status: 'active', turnId: requireAcceptedTurnId(db, sessionId) };
}

function findSessionLock(db: RepositoryDb, sessionId: string) {
  return db.select().from(sessionLocks).where(eq(sessionLocks.sessionId, sessionId)).get();
}

function requireAcceptedTurnId(db: RepositoryDb, sessionId: string): string {
  const accepted = db
    .select({ turnId: turnIngress.turnId })
    .from(turnIngress)
    .where(and(eq(turnIngress.sessionId, sessionId), eq(turnIngress.status, 'accepted')))
    .orderBy(desc(turnIngress.acceptedSequence))
    .get();
  if (!accepted) throw new Error(`Session deletion active Turn is missing: ${sessionId}`);
  return accepted.turnId;
}

function deletionPendingOwnerKind(ownerKind: string): string | undefined {
  if (ownerKind === 'turn' || ownerKind === TURN_DELETING_OWNER_KIND) {
    return TURN_DELETING_OWNER_KIND;
  }
  if (ownerKind === 'compaction' || ownerKind === COMPACTION_DELETING_OWNER_KIND) {
    return COMPACTION_DELETING_OWNER_KIND;
  }
  if (ownerKind === MAINTENANCE_OWNER_KIND || ownerKind === MAINTENANCE_DELETING_OWNER_KIND) {
    return MAINTENANCE_DELETING_OWNER_KIND;
  }
  return undefined;
}

function isDeletionOwnerKind(ownerKind: string | undefined): boolean {
  return (
    ownerKind === SESSION_DELETION_OWNER_KIND ||
    ownerKind === TURN_DELETING_OWNER_KIND ||
    ownerKind === COMPACTION_DELETING_OWNER_KIND ||
    ownerKind === MAINTENANCE_DELETING_OWNER_KIND
  );
}

function findAcceptedQueueTurn(db: QueueLookupDb, query: QueueAcceptanceQuery) {
  const receipt = db
    .select()
    .from(turnIngress)
    .where(and(eq(turnIngress.sessionId, query.sessionId), eq(turnIngress.claimId, query.claimId)))
    .get();
  if (
    receipt &&
    receipt.claimSource === query.source &&
    (!query.turnId || receipt.turnId === query.turnId) &&
    sameStrings(parseStringArray(receipt.queueItemIdsJson), query.queueItemIds)
  ) {
    return receipt;
  }
  return undefined;
}

function parseStringArray(value: string | null): readonly string[] {
  try {
    const parsed = value ? (JSON.parse(value) as unknown) : [];
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePendingSettlement(
  left: PendingSettlement | undefined,
  right: PendingSettlement,
): boolean {
  return (
    left?.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.leaseId === right.leaseId
  );
}

function withRecoveredTerminalFacts<T extends object>(
  result: T,
  terminalFacts: readonly TurnRecoveryTerminalFact[],
): T & { readonly recoveredTerminalFacts?: readonly TurnRecoveryTerminalFact[] } {
  return terminalFacts.length > 0 ? { ...result, recoveredTerminalFacts: terminalFacts } : result;
}

function settleInTransaction(tx: Transaction, input: SettleTurnInput, completedAtMs: number) {
  const lock = tx
    .select({ ownerId: sessionLocks.ownerId, ownerKind: sessionLocks.ownerKind })
    .from(sessionLocks)
    .where(eq(sessionLocks.sessionId, input.sessionId))
    .get();
  const accepted = tx
    .select({ turnId: turnIngress.turnId })
    .from(turnIngress)
    .where(and(eq(turnIngress.sessionId, input.sessionId), eq(turnIngress.status, 'accepted')))
    .orderBy(desc(turnIngress.acceptedSequence))
    .get();
  if (!lock || lock.ownerId !== input.leaseId || accepted?.turnId !== input.turnId) {
    return { status: 'stale-owner' as const };
  }
  const updated = tx
    .update(turnIngress)
    .set({ status: input.outcome, completedAtMs })
    .where(
      and(
        eq(turnIngress.turnId, input.turnId),
        eq(turnIngress.sessionId, input.sessionId),
        eq(turnIngress.status, 'accepted'),
      ),
    )
    .run();
  const released = releaseOrPromoteDeletionFence(tx, {
    sessionId: input.sessionId,
    leaseId: input.leaseId,
    ownerKind: lock.ownerKind,
    completedAtMs,
  });
  if (updated.changes !== 1 || released.changes !== 1) {
    throw new Error(`Turn settlement lost ownership: ${input.sessionId}/${input.turnId}`);
  }
  return { status: 'settled' as const, completedAtMs, outcome: input.outcome };
}

function recoverPendingSettlementInTransaction(
  tx: Transaction,
  pending: PendingSettlement,
  completedAtMs: number,
): TurnRecoveryTerminalFact | undefined {
  const lock = tx
    .select({ ownerId: sessionLocks.ownerId, ownerKind: sessionLocks.ownerKind })
    .from(sessionLocks)
    .where(eq(sessionLocks.sessionId, pending.sessionId))
    .get();
  const receipt = tx
    .select({ status: turnIngress.status })
    .from(turnIngress)
    .where(
      and(eq(turnIngress.sessionId, pending.sessionId), eq(turnIngress.turnId, pending.turnId)),
    )
    .get();
  if (lock?.ownerId !== pending.leaseId || receipt?.status !== 'accepted') return undefined;
  tx.update(turnIngress)
    .set({ status: 'failed', completedAtMs })
    .where(
      and(
        eq(turnIngress.sessionId, pending.sessionId),
        eq(turnIngress.turnId, pending.turnId),
        eq(turnIngress.status, 'accepted'),
      ),
    )
    .run();
  releaseOrPromoteDeletionFence(tx, {
    sessionId: pending.sessionId,
    leaseId: pending.leaseId,
    ownerKind: lock.ownerKind,
    completedAtMs,
  });
  return createRecoveredTerminalFact(
    pending.sessionId,
    pending.turnId,
    completedAtMs,
    'settlement-retry',
  );
}

function releaseOrPromoteDeletionFence(
  tx: Transaction,
  input: {
    readonly sessionId: string;
    readonly leaseId: string;
    readonly ownerKind: string;
    readonly completedAtMs: number;
  },
) {
  const ownership = and(
    eq(sessionLocks.sessionId, input.sessionId),
    eq(sessionLocks.ownerId, input.leaseId),
  );
  if (
    input.ownerKind === TURN_DELETING_OWNER_KIND ||
    input.ownerKind === COMPACTION_DELETING_OWNER_KIND
  ) {
    return tx
      .update(sessionLocks)
      .set({
        ownerKind: SESSION_DELETION_OWNER_KIND,
        acquiredAtMs: input.completedAtMs,
        expiresAtMs: DELETION_FENCE_EXPIRES_AT_MS,
      })
      .where(ownership)
      .run();
  }
  return tx.delete(sessionLocks).where(ownership).run();
}

function findDuplicate(tx: Transaction, input: AdmitTurnInput): AdmitTurnResult | undefined {
  const byTurn = tx.select().from(turnIngress).where(eq(turnIngress.turnId, input.turnId)).get();
  if (byTurn) return classifyDuplicate(byTurn, input);
  const byClientRequest = input.clientRequestId
    ? tx
        .select()
        .from(turnIngress)
        .where(
          and(
            eq(turnIngress.sessionId, input.sessionId),
            eq(turnIngress.clientRequestId, input.clientRequestId),
          ),
        )
        .get()
    : undefined;
  if (byClientRequest) return classifyDuplicate(byClientRequest, input);
  const claimId = input.queueIngress?.claimId;
  const byClaim = claimId
    ? tx.select().from(turnIngress).where(eq(turnIngress.claimId, claimId)).get()
    : undefined;
  return byClaim ? classifyDuplicate(byClaim, input) : undefined;
}

function classifyDuplicate(
  receipt: typeof turnIngress.$inferSelect,
  input: AdmitTurnInput,
): AdmitTurnResult {
  const exact =
    receipt.sessionId === input.sessionId &&
    storedBusyReason(receipt.busyReason) === input.busyReason &&
    receipt.inputDigest === input.inputDigest &&
    receipt.claimId === (input.queueIngress?.claimId ?? null) &&
    receipt.claimSource === (input.queueIngress?.provenance.source ?? null) &&
    sameStrings(
      parseStringArray(receipt.queueItemIdsJson),
      input.queueIngress ? [input.queueIngress.itemId] : [],
    );
  return exact
    ? { status: 'duplicate', turnId: receipt.turnId }
    : { status: 'rejected', reason: 'ingress-conflict' };
}

function insertAdmission(
  tx: Transaction,
  input: AdmitTurnInput,
  lease: { readonly leaseId: string; readonly nowMs: number; readonly leaseMs: number },
): AdmitTurnResult {
  const { leaseId, nowMs, leaseMs } = lease;
  tx.insert(sessionLocks)
    .values({
      sessionId: input.sessionId,
      ownerId: leaseId,
      ownerKind: input.busyReason,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + leaseMs,
    })
    .run();
  const sequence = tx
    .insert(turnIngressSequences)
    .values({ turnId: input.turnId })
    .returning({ value: turnIngressSequences.sequence })
    .get().value;
  tx.insert(turnIngress)
    .values({
      turnId: input.turnId,
      sessionId: input.sessionId,
      busyReason: input.busyReason,
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      ...(input.queueIngress
        ? {
            claimId: input.queueIngress.claimId,
            claimSource: input.queueIngress.provenance.source,
            queueItemIdsJson: JSON.stringify([input.queueIngress.itemId]),
          }
        : {}),
      inputJson: '{}',
      status: 'accepted',
      acceptedAtMs: nowMs,
      acceptedSequence: sequence,
      inputDigest: input.inputDigest,
      inputMetadataJson: JSON.stringify({
        ...input.inputMetadata,
        ...(input.foreground ? { foreground: true } : {}),
        ...(input.consumeQueuePause ? { consumeQueuePause: true } : {}),
      }),
    })
    .run();
  if (input.clientRequestId) {
    tx.insert(turnIngressClientRequests)
      .values({
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
        turnId: input.turnId,
        ordinal: 0,
      })
      .run();
  }
  return { status: 'accepted', leaseId, acceptedSequence: sequence, acceptedAtMs: nowMs };
}
