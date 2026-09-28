import { describe, expect, it, vi } from 'vitest';

import type { AgentHostTurnOutcome } from '../agent-host/contracts.js';
import type { TurnSubmissionPreparation } from '../contracts.js';
import { createSessionOperationGate } from '../lifecycle/session-operation-gate.js';
import { digestTurnInput } from './turn-input-identity.js';
import type { TurnRepository } from '../persistence/contracts.js';
import type { ExecutionCoordinator, TurnController } from './contracts.js';
import {
  createTurnExecutionService,
  type TurnExecutionServiceOptions,
} from './turn-execution.service.js';

describe('user stop cascade trigger', () => {
  it('cascades an explicit user stop and hands the abort result to the follow-up', async () => {
    const fixture = harness();
    fixture.controller.abort.mockResolvedValue({ status: 'aborted', turnId: 'turn-1' });

    await fixture.service.abort({ sessionId: 'session-1', reason: 'user_stop' });

    expect(fixture.cascadeBegin).toHaveBeenCalledWith('session-1');
    expect(fixture.cascadeComplete).toHaveBeenCalledWith({
      status: 'aborted',
      turnId: 'turn-1',
    });
  });

  it('opens the cascade before aborting, so a task driven terminal cannot slip a delivery through', async () => {
    const fixture = harness();
    const order: string[] = [];
    fixture.cascadeBegin.mockImplementation(async () => {
      order.push('cascade-begin');
      return {
        accept: vi.fn(async () => undefined),
        complete: vi.fn(() => {
          order.push('cascade-complete');
        }),
        cancel: vi.fn(),
      };
    });
    fixture.controller.abort.mockImplementation(async () => {
      order.push('abort');
      return { status: 'aborted', turnId: 'turn-1' };
    });

    await fixture.service.abort({ sessionId: 'session-1', reason: 'user_stop' });

    expect(order).toEqual(['cascade-begin', 'abort', 'cascade-complete']);
  });

  it.each(['session_leave', 'immediate_send', 'lifecycle', 'unknown', 'user'])(
    'does not cascade a %s abort',
    async (reason) => {
      const fixture = harness();
      fixture.controller.abort.mockResolvedValue({ status: 'aborted', turnId: 'turn-1' });

      await fixture.service.abort({ sessionId: 'session-1', reason });

      expect(fixture.cascadeBegin).not.toHaveBeenCalled();
    },
  );

  it('still cascades when the Turn is already gone (not-running)', async () => {
    // The Turn finished but background work can still be running.
    const fixture = harness();
    fixture.controller.abort.mockResolvedValue({ status: 'not-running' });

    await fixture.service.abort({ sessionId: 'session-1', reason: 'user_stop' });

    expect(fixture.cascadeComplete).toHaveBeenCalledWith({ status: 'not-running' });
  });

  it('does not open a window or cascade for a stop naming an older Turn', async () => {
    // A phone still showing the previous Turn stops it while a newer Turn runs.
    // The controller rejects that as turn-mismatch (409) before any side effect;
    // cascading would kill the background work of the Turn the user now sees.
    const fixture = harness();
    fixture.controller.activeTurnId.mockReturnValue('turn-new');
    fixture.controller.abort.mockResolvedValue({ status: 'turn-mismatch' });

    await expect(
      fixture.service.abort({ sessionId: 'session-1', turnId: 'turn-old', reason: 'user_stop' }),
    ).resolves.toEqual({ status: 'turn-mismatch' });

    expect(fixture.cascadeBegin).not.toHaveBeenCalled();
    expect(fixture.cascadeAccept).not.toHaveBeenCalled();
    expect(fixture.cascadeComplete).not.toHaveBeenCalled();
    expect(fixture.controller.abort).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'turn-old', reason: 'user_stop' }),
    );
    expect(fixture.loggerInfo).toHaveBeenCalledWith(
      {
        event: 'user_stop_cascade_skipped',
        session_id: 'session-1',
        requested_turn_id: 'turn-old',
        active_turn_id: 'turn-new',
        reason: 'stale_turn_id',
      },
      expect.any(String),
    );
  });

  it.each([
    ['no turn id', undefined, 'turn-live'],
    ['the running turn id', 'turn-live', 'turn-live'],
    ['a turn id while nothing runs', 'turn-old', undefined],
  ] as const)('opens the cascade for a stop naming %s', async (_label, turnId, activeTurnId) => {
    const fixture = harness();
    fixture.controller.activeTurnId.mockReturnValue(activeTurnId);
    fixture.controller.abort.mockResolvedValue({ status: 'not-running' });

    await fixture.service.abort({
      sessionId: 'session-1',
      ...(turnId ? { turnId } : {}),
      reason: 'user_stop',
    });

    expect(fixture.cascadeBegin).toHaveBeenCalledWith('session-1');
    expect(fixture.loggerInfo).not.toHaveBeenCalled();
  });

  it('accepts once, after the caller onAccepted, when the controller accepts the stop', async () => {
    const fixture = harness();
    const order: string[] = [];
    const callerOnAccepted = vi.fn(async () => {
      order.push('caller-onAccepted');
    });
    fixture.cascadeAccept.mockImplementation(async () => {
      order.push('cascade-accept');
    });
    fixture.controller.abort.mockImplementation(async (input) => {
      // The controller runs `onAccepted` only after its identity check passed.
      await input.onAccepted?.();
      return { status: 'aborted', turnId: 'turn-1' };
    });

    await fixture.service.abort({
      sessionId: 'session-1',
      reason: 'user_stop',
      onAccepted: callerOnAccepted,
    });

    expect(callerOnAccepted).toHaveBeenCalledTimes(1);
    expect(fixture.cascadeAccept).toHaveBeenCalledTimes(1);
    expect(fixture.cascadeAccept).toHaveBeenCalledWith('controller_accepted');
    expect(order).toEqual(['caller-onAccepted', 'cascade-accept']);
    expect(fixture.cascadeComplete).toHaveBeenCalled();
  });

  it('accepts before cascading when nothing was running', async () => {
    // The controller never runs `onAccepted` for not-running, yet the Goal must be
    // paused before the cascade stops tasks, or it restarts on their wake-ups.
    const fixture = harness();
    const order: string[] = [];
    fixture.cascadeAccept.mockImplementation(async () => {
      order.push('accept');
    });
    fixture.cascadeComplete.mockImplementation(() => {
      order.push('complete');
    });
    fixture.controller.abort.mockResolvedValue({ status: 'not-running' });

    await fixture.service.abort({ sessionId: 'session-1', reason: 'user_stop' });

    expect(fixture.cascadeAccept).toHaveBeenCalledWith('not_running');
    expect(order).toEqual(['accept', 'complete']);
  });

  it('releases the window without cascading when a newer Turn wins the race', async () => {
    // Nothing was running at the identity check, so `begin` ran; a new Turn then
    // registered before the abort landed and the controller rejected the stop.
    const fixture = harness();
    fixture.controller.activeTurnId.mockReturnValue(undefined);
    fixture.controller.abort.mockResolvedValue({ status: 'turn-mismatch' });

    await expect(
      fixture.service.abort({ sessionId: 'session-1', turnId: 'turn-old', reason: 'user_stop' }),
    ).resolves.toEqual({ status: 'turn-mismatch' });

    expect(fixture.cascadeBegin).toHaveBeenCalled();
    // A rejected stop must not touch the Goal: nothing may run `accept`.
    expect(fixture.cascadeAccept).not.toHaveBeenCalled();
    expect(fixture.cascadeCancel).toHaveBeenCalledWith('turn_mismatch');
    expect(fixture.cascadeComplete).not.toHaveBeenCalled();
  });

  it('releases the cascade window and rethrows unchanged when the abort itself fails', async () => {
    // `begin` opened the delivery window before the abort. If the abort rejects,
    // `complete` never runs, so without an explicit release the window would pin
    // every later completion notice of this Session as `busy` forever.
    const fixture = harness();
    const failure = new Error('onAccepted blew up');
    fixture.controller.abort.mockRejectedValue(failure);

    await expect(
      fixture.service.abort({ sessionId: 'session-1', reason: 'user_stop' }),
    ).rejects.toBe(failure);

    expect(fixture.cascadeCancel).toHaveBeenCalledWith('abort_failed');
    expect(fixture.cascadeComplete).not.toHaveBeenCalled();
  });

  it('still rethrows the original abort error when releasing the cascade throws', async () => {
    const fixture = harness();
    const failure = new Error('abort failed');
    fixture.controller.abort.mockRejectedValue(failure);
    fixture.cascadeCancel.mockImplementation(() => {
      throw new Error('cancel contract violated');
    });

    await expect(
      fixture.service.abort({ sessionId: 'session-1', reason: 'user_stop' }),
    ).rejects.toBe(failure);
  });

  it('still aborts when the cascade hook itself fails', async () => {
    const fixture = harness();
    fixture.cascadeBegin.mockRejectedValue(new Error('cascade unavailable'));
    fixture.controller.abort.mockResolvedValue({ status: 'aborted', turnId: 'turn-1' });

    await expect(
      fixture.service.abort({ sessionId: 'session-1', reason: 'user_stop' }),
    ).resolves.toEqual({ status: 'aborted', turnId: 'turn-1' });
    expect(fixture.controller.abort).toHaveBeenCalled();
  });
});

function harness() {
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const compensate = vi.fn(async () => undefined);
  const preparation = {
    commit,
    rollback,
    compensate,
    prepare: vi.fn<TurnSubmissionPreparation['prepare']>(async () => ({
      status: 'ready',
      commit,
      rollback,
      compensate,
    })),
  };
  const repository = {
    tryAcquireSessionMaintenance: vi.fn<TurnRepository['tryAcquireSessionMaintenance']>(
      async () => undefined,
    ),
    renewSessionMaintenance: vi.fn<TurnRepository['renewSessionMaintenance']>(async () => true),
    releaseSessionMaintenance: vi.fn<TurnRepository['releaseSessionMaintenance']>(
      async () => undefined,
    ),
    admit: vi.fn<TurnRepository['admit']>(async () => ({
      status: 'accepted',
      leaseId: 'lease-1',
      acceptedSequence: 1,
      acceptedAtMs: 100,
    })),
    renew: vi.fn<TurnRepository['renew']>(async () => true),
    settle: vi.fn<TurnRepository['settle']>(async ({ outcome }) => ({
      status: 'settled',
      completedAtMs: 100,
      outcome,
    })),
    recoverExpired: vi.fn<TurnRepository['recoverExpired']>(async () => ({
      released: false,
      terminalFacts: [],
    })),
    recoverProcessRestart: vi.fn<TurnRepository['recoverProcessRestart']>(async () => ({
      recovered: [],
      terminalFacts: [],
    })),
    findActiveTurn: vi.fn<TurnRepository['findActiveTurn']>(async () => undefined),
    findLatestTurnActivity: vi.fn<TurnRepository['findLatestTurnActivity']>(async () => undefined),
    preparePluginHookSessionOwnership: vi.fn<TurnRepository['preparePluginHookSessionOwnership']>(
      async () => undefined,
    ),
    activatePluginHookSessionOwnership: vi.fn<TurnRepository['activatePluginHookSessionOwnership']>(
      async () => undefined,
    ),
    findLatestPluginHookSessionOwnership: vi.fn<
      TurnRepository['findLatestPluginHookSessionOwnership']
    >(async () => undefined),
    tryClaimPluginHookSessionEnd: vi.fn<TurnRepository['tryClaimPluginHookSessionEnd']>(
      async () => ({ status: 'claimed' }),
    ),
    completePluginHookSessionEnd: vi.fn<TurnRepository['completePluginHookSessionEnd']>(
      async () => true,
    ),
    findReceipt: vi.fn<TurnRepository['findReceipt']>(async () => undefined),
    findSteeringReceipt: vi.fn<TurnRepository['findSteeringReceipt']>(async () => undefined),
    reserveSteeringReceipt: vi.fn<TurnRepository['reserveSteeringReceipt']>(async () => ({
      status: 'not-accepted',
    })),
    releaseSteeringReceipt: vi.fn<TurnRepository['releaseSteeringReceipt']>(async () => undefined),
    revokeAdmission: vi.fn<TurnRepository['revokeAdmission']>(async () => true),
    beginSessionDeletion: vi.fn<TurnRepository['beginSessionDeletion']>(async () => ({
      status: 'quiescent',
    })),
    readSessionDeletion: vi.fn<TurnRepository['readSessionDeletion']>(async () => ({
      status: 'not-started',
    })),
    isSessionDeleting: vi.fn<TurnRepository['isSessionDeleting']>(async () => false),
    deleteSessionData: vi.fn<TurnRepository['deleteSessionData']>(async () => undefined),
    completeSessionDeletion: vi.fn<TurnRepository['completeSessionDeletion']>(
      async () => undefined,
    ),
    isAcceptedInTransaction: vi.fn<TurnRepository['isAcceptedInTransaction']>(() => true),
    markAcknowledgedInTransaction: vi.fn<TurnRepository['markAcknowledgedInTransaction']>(),
  };
  const lease = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    leaseId: 'lease-1',
    acceptedSequence: 1,
    acceptedAtMs: 100,
    busyReason: 'turn' as const,
    signal: new AbortController().signal,
  };
  const controller = {
    register: vi.fn(() => lease),
    abort: vi.fn<TurnController['abort']>(async () => ({ status: 'not-running' })),
    steerActiveTurn: vi.fn<TurnController['steerActiveTurn']>(async () => ({
      status: 'not-running',
    })),
    steerToolResultTail: vi.fn<TurnController['steerToolResultTail']>(async () => ({
      status: 'not-running',
    })),
    beginClose: vi.fn<TurnController['beginClose']>(() => ({ closed: true })),
    complete: vi.fn<TurnController['complete']>(),
    activeTurnId: vi.fn<TurnController['activeTurnId']>(() => undefined),
    close: vi.fn<TurnController['close']>(async () => undefined),
  };
  const completion: Promise<AgentHostTurnOutcome> = Promise.resolve({ status: 'completed' });
  const coordinator = {
    startTurn: vi.fn<ExecutionCoordinator['startTurn']>(async () => ({ completion })),
    failTurn: vi.fn<ExecutionCoordinator['failTurn']>(async ({ error }) => ({
      completion: Promise.resolve({ status: 'failed', error }),
    })),
    failAdmission: vi.fn<ExecutionCoordinator['failAdmission']>(async ({ error }) => ({
      completion: Promise.resolve({ status: 'failed', error }),
    })),
    compact: vi.fn<ExecutionCoordinator['compact']>(async () => ({
      status: 'unchanged',
      reason: 'nothing-to-compact',
    })),
  };
  const sessionPreparation = { projectStarted: vi.fn(async () => undefined) };
  const failures = { project: vi.fn(async () => undefined) };
  const operations = createSessionOperationGate();
  const onInterruptSendReleased = vi.fn(async () => undefined);
  const cascadeComplete = vi.fn();
  const cascadeCancel = vi.fn();
  const cascadeAccept = vi.fn(async () => undefined);
  const loggerInfo = vi.fn();
  const cascadeBegin = vi.fn(async () => ({
    accept: cascadeAccept,
    complete: cascadeComplete,
    cancel: cascadeCancel,
  }));
  const options = {
    repository,
    controller: controller as unknown as TurnController,
    coordinator,
    operations,
    onInterruptSendReleased,
    sessions: { has: vi.fn(async () => true) },
    submissionPreparation: preparation,
    preparation: sessionPreparation,
    failures,
    nowMs: () => 1,
    makeTurnId: () => 'turn-1',
    userStop: { begin: cascadeBegin },
    logger: { info: loggerInfo },
  } satisfies TurnExecutionServiceOptions;
  return {
    repository,
    controller,
    coordinator,
    operations,
    preparation,
    sessionPreparation,
    failures,
    onInterruptSendReleased,
    cascadeBegin,
    cascadeComplete,
    cascadeCancel,
    cascadeAccept,
    loggerInfo,
    service: createTurnExecutionService(options),
  };
}

function deferred() {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

function deferredValue<T>(value: T) {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.(value) };
}
