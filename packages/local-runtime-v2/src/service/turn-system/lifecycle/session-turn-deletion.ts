import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';

import { settleInBackground } from '../../../infra/async/settle.js';
import { logger } from '../../../infra/logging/logger.js';
import type { TurnController } from '../execution/contracts.js';
import type { TurnRepository } from '../persistence/contracts.js';
import type { QueueDispatcher } from '../queue.dispatcher.js';
import type { SessionTurnDeletionCapability } from './contracts.js';
import { type SessionOperationGate } from './session-operation-gate.js';

export interface SessionTurnDeletionServiceOptions {
  readonly repository: Pick<
    TurnRepository,
    | 'beginSessionDeletion'
    | 'readSessionDeletion'
    | 'abandonSessionDeletion'
    | 'deleteSessionData'
    | 'completeSessionDeletion'
  >;
  readonly controller: Pick<TurnController, 'abort' | 'activeTurnId'>;
  readonly dispatcher: Pick<QueueDispatcher, 'quiesceSession' | 'resumeSession'>;
  readonly operations: SessionOperationGate;
  readonly beginProcessDeletion: (
    sessionId: string,
  ) => Promise<{ readonly status: 'started' | 'already-deleting' | 'not-found' }>;
  readonly completeProcessDeletion: (sessionId: string) => void;
  readonly disposeRuntimeSession: (sessionId: string) => Promise<void>;
}

export function createSessionTurnDeletionService(
  options: SessionTurnDeletionServiceOptions,
): SessionTurnDeletionCapability {
  const lane = new KeyedOperationLane<string>();

  return {
    run: (sessionId, cleanup) =>
      lane.run(sessionId, async () => {
        const gate = await options.beginProcessDeletion(sessionId);
        if (gate.status === 'not-found') {
          await options.repository.completeSessionDeletion(sessionId);
          options.operations.release(sessionId);
          return;
        }
        await quiesceForDeletion(options, sessionId);
        await options.disposeRuntimeSession(sessionId);
        await options.repository.deleteSessionData(sessionId);
        await cleanup();
        await options.repository.completeSessionDeletion(sessionId);
        options.completeProcessDeletion(sessionId);
        options.operations.release(sessionId);
      }),
  };
}

/**
 * Fences the Session and proves Turn quiescence. Nothing has been deleted yet, so a failure here
 * reopens the Session instead of leaving every gate closed with no owner left to release them.
 */
async function quiesceForDeletion(
  options: SessionTurnDeletionServiceOptions,
  sessionId: string,
): Promise<void> {
  const operationDrain = options.operations.block(sessionId);
  const dispatchDrain = options.dispatcher.quiesceSession(sessionId);
  try {
    await options.repository.beginSessionDeletion(sessionId);
    await Promise.all([operationDrain, dispatchDrain]);
    await requireQuiescentTurn(options, sessionId);
  } catch (error) {
    try {
      await reopenAfterFailedQuiescence(options, sessionId, [operationDrain, dispatchDrain]);
    } catch (rollbackError) {
      logger.warn(
        {
          sessionId,
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        },
        'Could not reopen the Session after its deletion failed before cleanup',
      );
    }
    throw error;
  }
}

async function reopenAfterFailedQuiescence(
  options: SessionTurnDeletionServiceOptions,
  sessionId: string,
  drains: readonly Promise<void>[],
): Promise<void> {
  await Promise.allSettled(drains);
  const durable = await options.repository.abandonSessionDeletion(sessionId);
  // A quiescent fence may come from an earlier attempt whose cleanup already ran; only a
  // successful retry or startup recovery may clear it.
  if (durable.status !== 'not-started') return;
  options.completeProcessDeletion(sessionId);
  options.operations.release(sessionId);
  // resumeSession lifts the quiesce before its first await; the drain it then starts may run a
  // whole Turn, so the failed deletion reports without waiting for it.
  settleInBackground(resumeReopenedSession(options, sessionId));
}

async function resumeReopenedSession(
  options: SessionTurnDeletionServiceOptions,
  sessionId: string,
): Promise<void> {
  try {
    await options.dispatcher.resumeSession(sessionId);
  } catch (error) {
    logger.warn(
      { sessionId, error: error instanceof Error ? error.message : String(error) },
      'Could not drain the Queue of a Session reopened after its deletion failed',
    );
  }
}

async function requireQuiescentTurn(
  options: SessionTurnDeletionServiceOptions,
  sessionId: string,
): Promise<void> {
  const activeTurnId = options.controller.activeTurnId(sessionId);
  const abort = await options.controller.abort({
    sessionId,
    ...(activeTurnId ? { turnId: activeTurnId } : {}),
    reason: 'session-delete',
  });
  if (abort.status === 'abort-timeout') {
    throw new Error(
      `Active Turn did not release before Session deletion: ${sessionId}/${abort.turnId}`,
    );
  }
  const durable = await options.repository.readSessionDeletion(sessionId);
  const remainingTurnId = options.controller.activeTurnId(sessionId);
  if (durable.status === 'active' || remainingTurnId) {
    throw new Error(
      `Active Turn did not reach deletion quiescence: ${sessionId}/${
        durable.status === 'active' ? durable.turnId : remainingTurnId
      }`,
    );
  }
  if (durable.status !== 'quiescent') {
    throw new Error(`Turn deletion lock was lost: ${sessionId}`);
  }
}
