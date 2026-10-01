import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  ConversationEditAdmissionInput,
  ConversationEditAdmissionResult,
  InitializeTurnSystemOptions,
  TurnService,
  TurnSystemOwner,
} from './contracts.js';
import { createExecutionCoordinator } from './execution/execution.coordinator.js';
import { createSteerSessionService } from './execution/steering/steer-session.service.js';
import { createTurnController } from './execution/turn-controller/turn.controller.js';
import { createTurnExecutionService } from './execution/turn-execution.service.js';
import { createSessionOperationGate } from './lifecycle/session-operation-gate.js';
import { createSessionTurnDeletionService } from './lifecycle/session-turn-deletion.js';
import {
  createTurnReleasedSignal,
  type TurnReleasedSignal,
} from './lifecycle/turn-released-signal.js';
import { createTurnFactProjector } from './persistence/turn-fact-projector.js';
import { createTurnRepository } from './persistence/turn.repository.js';
import { createQueueDispatcher, type QueueDispatcher } from './queue.dispatcher.js';
import { createQueuedTurnCompletionRegistry } from './queued-turn-completion.js';
import {
  createSteeringRequeue,
  type DiscardedSteeringBatch,
  type SteeringRequeue,
} from './execution/steering/steering-requeue.js';
import { createSteeringTeardownCommit } from './execution/steering/steering-teardown-commit.js';
import { createTurnSubmissionService } from './turn-submission.service.js';
import { createHistoryMutationCapability } from './lifecycle/history-mutation-capability.js';
import type { SessionMaintenanceGuard, SessionMaintenanceLease } from '../session-system/index.js';
import { createUserMessageId, SessionMaintenanceService } from '../session-system/index.js';
import type { TurnRepository } from './persistence/contracts.js';
import type { SessionOperationGate } from './lifecycle/session-operation-gate.js';
import { createTurnContinuationService } from './execution/turn-continuation.service.js';

/** Initializes one production Turn graph over the SessionSystem persistence owner. */
export async function initializeTurnSystem(
  options: InitializeTurnSystemOptions,
): Promise<TurnSystemOwner> {
  const repository = createRuntimeTurnRepository(options);
  const released = createTurnReleasedSignal();
  const steeringRequeue = createRuntimeSteeringRequeue(options, released);
  const { controller, completions } = createQueuedTurnControl(options, repository, steeringRequeue);
  const operations = createSessionOperationGate();
  // A Session lifecycle fence owns the in-process admission gate, but its archive commit still
  // needs the persistent maintenance lease. Async context makes that re-entry owner-scoped while
  // unrelated Turns and mutations remain blocked.
  const exclusiveSession = new AsyncLocalStorage<string>();
  const maintenance = createOperationGatedMaintenance(
    repository,
    operations,
    released,
    (sessionId) => exclusiveSession.getStore() === sessionId,
  );
  const sessionEndMaintenance = new SessionMaintenanceService(maintenance);
  const host = await options.createHost({
    turnControl: controller,
    turnFacts: createTurnFactProjector(repository),
    pluginHookSessionOwnership: {
      prepare: (input) => repository.preparePluginHookSessionOwnership(input),
      activate: (input) => repository.activatePluginHookSessionOwnership(input),
    },
  });
  const queue = options.sessions.queue.createDispatch(repository);
  const coordinator = createExecutionCoordinator({
    host,
    repository,
    controller,
    failures: options.sessions.agentProjection.failures,
    onBeginSettlement: completions.beginSettlement,
    released,
    // Decision v5: fallen steering commits before the Turn releases Session
    // ownership, so a stop-then-send Turn reads the rows (TS-75).
    steeringTeardown: steeringRequeue,
    ...(options.turnSettlement ? { turnSettlement: options.turnSettlement } : {}),
  });
  const execution = createTurnExecutionService({
    repository,
    controller,
    coordinator,
    operations,
    onInterruptSendReleased: (sessionId) => released.publish(sessionId),
    sessions: {
      has: (sessionId) => options.sessions.sessions.repository.has(sessionId),
    },
    ...turnExecutionOverrides(options),
  });
  const continuation = createRuntimeTurnContinuation(options, execution);
  const messageDelivery = options.createMessageDelivery({
    execution: { execute: (input) => execution.submit(input) },
  });
  const trustedMessageDelivery = options.createMessageDelivery({
    execution: { execute: (input) => execution.submitTrusted(input) },
  });
  const recovery = createRuntimeRecoveryCoordinator(options, repository);
  const dispatcher: QueueDispatcher = createQueueDispatcher({
    queue,
    executor: messageDelivery.queue,
    onPreparing: completions.prepareExecution,
    onExecution: (claim, result) => completions.observe(claim, result),
    isCancellationRequested: (item) =>
      item.requestedTurnId !== undefined &&
      completions.cancellationReason(item.sessionId, item.requestedTurnId) !== undefined,
    ...queueSelectionOverrides(options),
    recoverState: recovery.recoverState,
  });
  recovery.bind(dispatcher);
  const unsubscribeQueueFacts = options.sessions.queue.facts.subscribe(completions.handleFacts);
  const unsubscribeReleased = released.subscribe((sessionId) => dispatcher.dispatch(sessionId));
  const deletion = createSessionTurnDeletionService({
    repository,
    controller,
    dispatcher,
    operations,
    beginProcessDeletion: (sessionId) => options.sessions.sessions.deletion.begin(sessionId),
    completeProcessDeletion: (sessionId) => options.sessions.sessions.deletion.complete(sessionId),
    disposeRuntimeSession: options.disposeRuntimeSession,
  });
  const steer = createSteerSessionService({
    turns: execution,
    activation: messageDelivery.activation,
    receipts: repository,
  });
  const submission = createTurnSubmissionService({
    activation: messageDelivery.activation,
    queue: options.sessions.queue.submission,
    dispatcher,
    completions,
    activeTurnId: (sessionId) => execution.activeTurnId(sessionId),
    ...(options.makeTurnId ? { makeTurnId: options.makeTurnId } : {}),
    ...(options.onQueueWakeFailure ? { onQueueWakeFailure: options.onQueueWakeFailure } : {}),
  });
  const trustedSubmission = createTurnSubmissionService({
    activation: trustedMessageDelivery.activation,
    queue: options.sessions.queue.submission,
    dispatcher,
    completions,
    activeTurnId: (sessionId) => execution.activeTurnId(sessionId),
    ...(options.makeTurnId ? { makeTurnId: options.makeTurnId } : {}),
    ...(options.onQueueWakeFailure ? { onQueueWakeFailure: options.onQueueWakeFailure } : {}),
  });
  const historyMutation = createHistoryMutationCapability({
    sessions: options.sessions.sessions.historyMutation,
    forkProjections: options.forkProjections,
    rewindProjections: options.rewindProjections,
    activeTurnId: (sessionId) => execution.activeTurnId(sessionId),
    ...(options.onTurnDiffRewindSkipped
      ? { onTurnDiffRewindSkipped: options.onTurnDiffRewindSkipped }
      : {}),
  });
  const turns = createTurnFacade({
    execution,
    completions,
    historyMutation,
    submission,
    dispatcher,
    steer,
    continuation,
    deletion,
    onQueueWakeFailure: options.onQueueWakeFailure,
  });
  const trustedEditSubmission = createTrustedEditSubmission(trustedSubmission);
  let readyPromise: Promise<void> | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  return {
    turns,
    sessionLifecycle: {
      runExclusive: async <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
        const lease = operations.tryAcquireExclusive(sessionId);
        if (!lease) throw new Error(`Session lifecycle operation is already active: ${sessionId}`);
        try {
          return await exclusiveSession.run(sessionId, operation);
        } finally {
          lease.release();
        }
      },
      tryRunExclusive: (sessionId, operation) =>
        sessionEndMaintenance.tryRunExclusive(sessionId, operation),
    },
    pluginHookSessionOwnership: pluginHookSessionOwnership(repository),
    queueSteer: {
      prepareDelivery: (claim, turnId) => {
        completions.prepareExecution(claim, turnId);
        return queue.prepareDelivery({
          sessionId: claim.sessionId,
          claimId: claim.claimId,
          turnId,
        });
      },
      observe: (claim, result) => completions.observe(claim, result),
      claim: ({ sessionId, itemId }) => queue.claimNext({ sessionId, itemId }),
      consume: async (claim, outcome) => {
        await queue.consume({
          sessionId: claim.sessionId,
          claimId: claim.claimId,
          reason: outcome.mode === 'activated' ? 'accepted' : 'injected',
        });
      },
      release: (claim) => queue.release({ sessionId: claim.sessionId, claimId: claim.claimId }),
    },
    inspection: {
      activeTurnId: (sessionId) => execution.activeTurnId(sessionId),
      hasPendingUserSteering: (sessionId) => controller.hasPendingUserSteering(sessionId),
      activeTurn: async (sessionId) => {
        const active = await repository.findActiveTurn(sessionId);
        return active
          ? {
              ...active,
              locallyOwned: execution.activeTurnId(sessionId) === active.turnId,
            }
          : undefined;
      },
      latestTurnActivity: (sessionId) => repository.findLatestTurnActivity(sessionId),
    },
    maintenance,
    receipts: { findReceipt: (turnId) => repository.findReceipt(turnId) },
    trustedEditSubmission,
    ready: () => {
      readyPromise ??= closed ? Promise.resolve() : recovery.recoverPending();
      return readyPromise;
    },
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      unsubscribeReleased();
      unsubscribeQueueFacts();
      completions.close();
      // drain() must persist the aborted Turns' steering requeues before DB close.
      closePromise = settleShutdown([
        recovery.close(),
        dispatcher.close(),
        controller.close(),
        steeringRequeue.drain(),
        ...(readyPromise ? [readyPromise] : []),
      ]);
      return closePromise;
    },
  };
}

/** Optional Queue-selection policies the product owner may leave unbound. */
function queueSelectionOverrides(options: InitializeTurnSystemOptions) {
  return {
    ...(options.classifyQueuedItem ? { classifyQueuedItem: options.classifyQueuedItem } : {}),
    ...(options.shouldYieldFifoPosition
      ? { shouldYieldFifoPosition: options.shouldYieldFifoPosition }
      : {}),
  };
}

function pluginHookSessionOwnership(
  repository: TurnRepository,
): TurnSystemOwner['pluginHookSessionOwnership'] {
  return {
    latest: (sessionId) => repository.findLatestPluginHookSessionOwnership(sessionId),
    tryClaimSessionEnd: (input) => repository.tryClaimPluginHookSessionEnd(input),
    completeSessionEnd: (input) => repository.completePluginHookSessionEnd(input),
  };
}

function turnExecutionOverrides(options: InitializeTurnSystemOptions) {
  return {
    ...(options.submissionPreparation
      ? { submissionPreparation: options.submissionPreparation }
      : {}),
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.makeTurnId ? { makeTurnId: options.makeTurnId } : {}),
    ...(options.userStop ? { userStop: options.userStop } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  };
}

function createRuntimeSteeringRequeue(
  options: InitializeTurnSystemOptions,
  released: TurnReleasedSignal,
): SteeringRequeue {
  const projectDisplay = options.commitSteeringTeardownProjection;
  return createSteeringRequeue({
    queue: options.sessions.queue.submission,
    released,
    ...(projectDisplay
      ? {
          teardown: createSteeringTeardownCommit({
            projectDisplay,
            canonicalHistory: options.sessions.canonicalHistory,
            ...(options.nowMs ? { nowMs: options.nowMs } : {}),
            ...(options.logger ? { logger: options.logger } : {}),
          }),
        }
      : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

function createRuntimeTurnContinuation(
  options: InitializeTurnSystemOptions,
  execution: Parameters<typeof createTurnContinuationService>[0]['execution'],
): ReturnType<typeof createTurnContinuationService> {
  return createTurnContinuationService({
    history: options.sessions.canonicalHistory,
    execution,
  });
}

function createRuntimeTurnRepository(options: InitializeTurnSystemOptions): TurnRepository {
  return createTurnRepository({
    db: options.db,
    priorityFence: options.sessions.queue.priorityFence,
    sessionAdmission: options.sessions.sessions.deletion.turnAdmission,
    ...(options.admissionPolicy ? { admissionPolicy: options.admissionPolicy } : {}),
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.makeLeaseId ? { makeLeaseId: options.makeLeaseId } : {}),
    ...(options.makeDeletionOwnerId ? { makeDeletionOwnerId: options.makeDeletionOwnerId } : {}),
    ...(options.isLeaseOwnerAlive ? { isLeaseOwnerAlive: options.isLeaseOwnerAlive } : {}),
    ...(options.isLeaseOwnerCurrent ? { isLeaseOwnerCurrent: options.isLeaseOwnerCurrent } : {}),
  });
}

interface RuntimeRecoveryCoordinator {
  readonly recoverState: () => Promise<void>;
  recoverPending(): Promise<void>;
  bind(dispatcher: Pick<QueueDispatcher, 'recoverPending'>): void;
  close(): Promise<void>;
}

function createRuntimeRecoveryCoordinator(
  options: InitializeTurnSystemOptions,
  repository: Pick<TurnRepository, 'recoverProcessRestart'>,
): RuntimeRecoveryCoordinator {
  const pendingDeletionSessionIds = new Set<string>();
  let recoverDispatcher: (() => Promise<void>) | undefined;
  let inFlightRecovery: Promise<void> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let liveSessionsRemain = false;
  let pendingTaskOwners = false;
  let lastTaskRecoveryState: string | undefined;
  const pendingRecoveredTurnIds = new Set<string>();
  let closed = false;

  const schedule = () => {
    if (closed || recoveryTimer) return;
    const delayMs = Math.max(1, Math.floor(options.runtimeRecoveryRetryMs ?? 10_000));
    recoveryTimer = setTimeout(() => void runScheduledRecovery(), delayMs);
    recoveryTimer.unref?.();
  };

  const resumePendingDeletions = async (): Promise<void> => {
    for (const sessionId of [...pendingDeletionSessionIds]) {
      if (closed) return;
      if (!options.resumeSessionDeletion) continue;
      try {
        await options.resumeSessionDeletion(sessionId);
        pendingDeletionSessionIds.delete(sessionId);
      } catch (error) {
        options.onRuntimeRecoveryFailure?.({ sessionId, error });
      }
    }
  };

  const recoverState = async (): Promise<void> => {
    const restarted = await repository.recoverProcessRestart({
      processStartedAtMs: options.processStartedAtMs,
    });
    for (const fact of restarted.terminalFacts) pendingRecoveredTurnIds.add(fact.turnId);
    for (const sessionId of restarted.pendingDeletionSessionIds ?? []) {
      pendingDeletionSessionIds.add(sessionId);
    }
    const protectedSessionIds = [...(restarted.liveSessionIds ?? []), ...pendingDeletionSessionIds];
    await options.sessions.sessions.recovery.recoverPreviousProcess({
      processStartedAtMs: options.processStartedAtMs,
      ...(protectedSessionIds.length > 0 ? { protectedSessionIds } : {}),
    });
    const taskRecoveryState = JSON.stringify([...protectedSessionIds].sort());
    if (taskRecoveryState !== lastTaskRecoveryState || pendingRecoveredTurnIds.size > 0) {
      pendingTaskOwners =
        (await options.onRuntimeRecovery?.([...pendingRecoveredTurnIds])) === true;
      pendingRecoveredTurnIds.clear();
      lastTaskRecoveryState = taskRecoveryState;
    } else if (pendingTaskOwners) {
      pendingTaskOwners = (await options.pollRuntimeRecovery?.()) === true;
    }
    liveSessionsRemain = (restarted.liveSessionIds?.length ?? 0) > 0;
  };

  const runRecovery = async (): Promise<void> => {
    if (!recoverDispatcher) throw new Error('Runtime recovery dispatcher is not bound');
    await recoverDispatcher();
    if (closed) return;
    await resumePendingDeletions();
    if (liveSessionsRemain || pendingTaskOwners || pendingDeletionSessionIds.size > 0) schedule();
  };

  const recoverPending = async (): Promise<void> => {
    const recovery = runRecovery();
    inFlightRecovery = recovery;
    try {
      await recovery;
    } finally {
      inFlightRecovery = undefined;
    }
  };

  const runScheduledRecovery = async (): Promise<void> => {
    recoveryTimer = undefined;
    if (closed) return;
    try {
      await recoverPending();
    } catch (error) {
      options.onRuntimeRecoveryFailure?.({ sessionId: '<runtime>', error });
      schedule();
    }
  };

  return {
    recoverState,
    recoverPending,
    bind: (dispatcher) => {
      recoverDispatcher = () =>
        dispatcher.recoverPending({ processStartedAtMs: options.processStartedAtMs });
    },
    close: async () => {
      closed = true;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
      if (inFlightRecovery) await inFlightRecovery;
    },
  };
}

function createTrustedEditSubmission(
  trustedSubmission: ReturnType<typeof createTurnSubmissionService>,
): TurnSystemOwner['trustedEditSubmission'] {
  return {
    submit: async (
      request: ConversationEditAdmissionInput,
    ): Promise<ConversationEditAdmissionResult> => {
      const messageKey = `edit:${request.operationId}`;
      const userMessageId = createUserMessageId({ sessionId: request.sessionId, messageKey });
      const result = await trustedSubmission.submit({
        sessionId: request.sessionId,
        input: { text: request.content, attachments: request.attachments },
        allowQueue: false,
        provenance: {
          source: 'conversation-mutation',
          routingFingerprint: `conversation-edit:${request.operationId}`,
          sourceContext: { clientRequestId: request.operationId },
        },
        clientRequestId: request.operationId,
        userMessageId,
        delivery: {
          messageKey,
          userMessageId,
          ...(request.displayAttachments ? { displayAttachments: request.displayAttachments } : {}),
        },
      });
      return { ...result, userMessageId };
    },
  };
}

/** Keep pending Queue cancellation and future in-process ownership in one graph. */
function createQueuedTurnControl(
  options: Pick<InitializeTurnSystemOptions, 'logger'>,
  repository: ReturnType<typeof createRuntimeTurnRepository>,
  steeringRequeue: ReturnType<typeof createRuntimeSteeringRequeue>,
) {
  const completions = createQueuedTurnCompletionRegistry();
  const controller = createTurnController({
    renew: repository.renew,
    onRegister: completions.beginExecution,
    onSteeringDiscarded: (batch: DiscardedSteeringBatch) => steeringRequeue.discard(batch),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return { controller, completions };
}

function createTurnFacade(input: {
  readonly completions: ReturnType<typeof createQueuedTurnCompletionRegistry>;
  readonly execution: ReturnType<typeof createTurnExecutionService>;
  readonly submission: ReturnType<typeof createTurnSubmissionService>;
  readonly dispatcher: ReturnType<typeof createQueueDispatcher>;
  readonly steer: ReturnType<typeof createSteerSessionService>;
  readonly continuation: ReturnType<typeof createTurnContinuationService>;
  readonly deletion: ReturnType<typeof createSessionTurnDeletionService>;
  readonly historyMutation: ReturnType<typeof createHistoryMutationCapability>;
  readonly onQueueWakeFailure: InitializeTurnSystemOptions['onQueueWakeFailure'];
}): TurnService {
  return {
    fork: (request) => input.historyMutation.fork(request),
    rewind: (request) => input.historyMutation.rewind(request),
    submit: (request) => input.submission.submit(request),
    resumeUserInput: (request) => input.submission.resumeUserInput(request),
    inspectContinuation: (sessionId) => input.continuation.inspect(sessionId),
    continueTurn: (request) => input.continuation.continueTurn(request),
    requestCompaction: (request) => input.execution.requestCompaction(request),
    abort: async (request) => {
      const pending = request.turnId
        ? input.completions.requestCancellation(request.sessionId, request.turnId, request.reason)
        : false;
      if (pending)
        queueMicrotask(() => void wakeCancelledQueue(input.dispatcher, input, request.sessionId));
      const result = await abortQueuedExecution(input, request);
      if (
        pending &&
        request.turnId &&
        input.completions.isPending(request.sessionId, request.turnId) &&
        (result.status === 'not-running' || result.status === 'turn-mismatch')
      ) {
        await request.onAccepted?.();
        return { status: 'aborted', turnId: request.turnId };
      }
      return result;
    },
    steer: (request) => input.steer.steer(request),
    dispatchSessionQueue: (sessionId) => input.dispatcher.continuePaused(sessionId),
    dispatchQueue: (sessionId) => input.dispatcher.dispatch(sessionId),
    sessionDeletion: (sessionId, cleanup) => input.deletion.run(sessionId, cleanup),
  };
}

/** Retried Queue work keeps the original caller identity while its controller owns a new Turn. */
async function abortQueuedExecution(
  input: Pick<Parameters<typeof createTurnFacade>[0], 'execution' | 'completions'>,
  request: Parameters<TurnService['abort']>[0],
) {
  const turnId = request.turnId
    ? input.completions.executionTurnId(request.sessionId, request.turnId)
    : undefined;
  const result = await input.execution.abort(turnId ? { ...request, turnId } : request);
  return turnId && request.turnId && 'turnId' in result
    ? { ...result, turnId: request.turnId }
    : result;
}

async function wakeCancelledQueue(
  dispatcher: Pick<QueueDispatcher, 'dispatch'>,
  options: { readonly onQueueWakeFailure: InitializeTurnSystemOptions['onQueueWakeFailure'] },
  sessionId: string,
): Promise<void> {
  // A cancellation can race the final await of claim release. Request another
  // drain now; the dispatcher's wake counter serializes it after that release.
  try {
    await dispatcher.dispatch(sessionId);
  } catch (error) {
    try {
      options.onQueueWakeFailure?.({ sessionId, error });
    } catch {
      // Diagnostics cannot turn a handled wake failure into an unhandled rejection.
    }
  }
}

function createOperationGatedMaintenance(
  repository: Pick<
    TurnRepository,
    'tryAcquireSessionMaintenance' | 'renewSessionMaintenance' | 'releaseSessionMaintenance'
  >,
  operations: Pick<SessionOperationGate, 'tryEnter'>,
  released: Pick<TurnReleasedSignal, 'publish'>,
  isExclusiveSessionOwner: (sessionId: string) => boolean,
): SessionMaintenanceGuard {
  const permits = new Map<string, { readonly release: () => void }>();
  const ownedFencePermit = { release: () => undefined };
  return {
    tryAcquireSessionMaintenance: async (sessionId) => {
      const ownsExclusiveSession = isExclusiveSessionOwner(sessionId);
      const permit = ownsExclusiveSession ? ownedFencePermit : operations.tryEnter(sessionId);
      if (!permit) return undefined;
      try {
        const lease = await repository.tryAcquireSessionMaintenance(sessionId);
        if (!lease) {
          permit.release();
          return undefined;
        }
        permits.set(maintenanceLeaseKey(lease), permit);
        return lease;
      } catch (error) {
        permit.release();
        throw error;
      }
    },
    renewSessionMaintenance: (lease) => repository.renewSessionMaintenance(lease),
    releaseSessionMaintenance: async (lease) => {
      const key = maintenanceLeaseKey(lease);
      const permit = permits.get(key);
      try {
        await repository.releaseSessionMaintenance(lease);
      } finally {
        permits.delete(key);
        permit?.release();
      }
      await released.publish(lease.sessionId);
    },
  };
}

function maintenanceLeaseKey(lease: SessionMaintenanceLease): string {
  return `${lease.sessionId}\0${lease.leaseId}`;
}

async function settleShutdown(operations: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}
