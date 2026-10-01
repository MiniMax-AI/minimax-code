import { describe, expect, it, vi } from 'vitest';

import type {
  TuiActiveRunSnapshot,
  TuiQueuedMessage,
  TuiRuntimeEvent,
} from '../../../../../src/runtime/port.js';
import type { TuiObservability } from '../../../../../src/observability/index.js';
import { TuiRuntimeEventFlow } from '../../../../../src/tui/controller/runtime/runtime-event-flow.js';
import {
  createTuiState,
  TuiRunProjection,
  TuiEffectRunner,
  TuiStateStore,
} from '../../../../../src/tui/state/index.js';
import { TranscriptStore } from '../../../../../src/tui/transcript/store.js';

function lifecycle(
  type: 'session.start' | 'session.finish' | 'session.error' | 'session.abort',
  turnId: string,
): TuiRuntimeEvent {
  return {
    type,
    timestampMs: 100,
    source: 'runtime',
    sessionId: 'session-1',
    turnId,
    queueItemIds: [],
  };
}

function activeRun(
  state: TuiActiveRunSnapshot['state'],
  turnId?: string,
): TuiActiveRunSnapshot {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    state,
    ...(turnId ? { turnId } : {}),
    actions: {
      steer: false,
    },
  };
}

function queued(status: string): TuiQueuedMessage {
  return { itemId: `item-${status}`, sessionId: 'session-1', status };
}

function createObservability(): {
  observability: TuiObservability;
  recordRunLifecycle: ReturnType<typeof vi.fn>;
} {
  const recordRunLifecycle = vi.fn();
  return {
    recordRunLifecycle,
    observability: {
      recordStartup: vi.fn(),
      recordAccess: vi.fn(),
      recordEventStream: vi.fn(),
      recordTerminal: vi.fn(),
      recordProcessStop: vi.fn(),
      observeRender: vi.fn(),
      recordRunLifecycle,
      snapshot: vi.fn(),
      flush: vi.fn(async () => undefined),
    } as unknown as TuiObservability,
  };
}

function createFixture(options?: {
  currentControllerTurnId?: () => string | undefined;
  runtimeActiveRun?: () => Promise<TuiActiveRunSnapshot>;
  queuedMessages?: () => Promise<TuiQueuedMessage[]>;
  interactionContinuesTurn?: (sessionId: string, turnId: string) => boolean;
  observability?: TuiObservability;
}) {
  const stateStore = new TuiStateStore(createTuiState());
  stateStore.dispatch({ type: 'session/activate', sessionId: 'session-1' });
  const effectRunner = new TuiEffectRunner(
    async (effect) => ({
      type: 'connection/sessionReconciled',
      sessionId: effect.sessionId,
    }),
    (action) => stateStore.dispatch(action),
  );
  const refreshQueue = vi.fn(async () => []);
  const activeRunFlow = {
    refresh: vi.fn(async () => undefined),
    currentSnapshot: vi.fn(() => activeRun('idle')),
  };
  const stateCoordinator = {
    project: vi.fn(),
  };
  const sessionFlow = {
    reconcileRuntimeEvent: vi.fn(async () => undefined),
  };
  const delegationFlow = {
    handleRuntimeEvent: vi.fn(async () => undefined),
    handleSettledRuntimeEvent: vi.fn(),
    refresh: vi.fn(async () => undefined),
  };
  const interactionFlow = {
    handleRuntimeEvent: vi.fn(async () => false),
    replaceFromActiveSession: vi.fn(),
    hasPending: vi.fn(() => false),
    continuesTurn: vi.fn(options?.interactionContinuesTurn ?? (() => false)),
  };
  const runProjection = new TuiRunProjection();
  const runtime = {
    getActiveRun:
      options?.runtimeActiveRun ?? vi.fn(async () => activeRun('idle')),
    listQueuedMessages: options?.queuedMessages ?? vi.fn(async () => []),
    watchEvents: async function* watchEvents(signal: AbortSignal) {
      const event = await new Promise<TuiRuntimeEvent | undefined>(
        (resolve) => {
          signal.addEventListener('abort', () => resolve(undefined), {
            once: true,
          });
        },
      );
      if (event) yield event;
    },
    watchSessionTurn: async function* watchSessionTurn() {},
  };
  const settleRuntimeTurnProjection = vi.fn();
  const reconcileOwnerHistory = vi.fn(async () => true);
  const controller = {
    snapshot: vi.fn(() => ({
      session: { sessionId: 'session-1' },
      activeTurnId: options?.currentControllerTurnId?.(),
    })),
    refreshCurrentSessionHistory: vi.fn(async () => undefined),
    refreshSessionMetadata: vi.fn(async () => undefined),
    beginRuntimeTurn: vi.fn(),
    applyRuntimeTurnEvent: vi.fn(),
    runtimeTurnSettlement: {
      settle: vi.fn(async () => undefined),
      settleProjection: settleRuntimeTurnProjection,
      enabled: vi.fn(() => false),
      prepare: vi.fn((sessionId: string, turnId: string, status: string) => ({
        sessionId,
        turnId,
        status,
      })),
      publish: vi.fn(async () => undefined),
    },
    latestDurableMessageId: vi.fn(() => 'message-anchor'),
    reconcileOwnerHistory,
    refreshStatusMetricsNow: vi.fn(),
    refreshSessionUsageNow: vi.fn(),
  };
  const flow = new TuiRuntimeEventFlow({
    runtime: runtime as never,
    controller: controller as never,
    stateStore,
    effectRunner,
    stateCoordinator: stateCoordinator as never,
    sessionFlow: sessionFlow as never,
    delegationFlow: delegationFlow as never,
    activeRunFlow: activeRunFlow as never,
    interactionFlow: interactionFlow as never,
    runProjection,
    releaseQueueItem: vi.fn(async () => undefined),
    transcript: new TranscriptStore(),
    refreshQueue,
    projectQueueItem: vi.fn(),
    restoreFailedQueueItem: vi.fn(),
    onLlmRetryChanged: vi.fn(),
    onRetryAvailabilityChanged: vi.fn(),
    goalFlow: { project: vi.fn(), refresh: vi.fn(async () => undefined) },
    updateFollowUpPanel: vi.fn(),
    onChanged: vi.fn(),
    append: vi.fn(),
    isStopped: () => false,
    queueEnabled: true,
    ...(options?.observability ? { observability: options.observability } : {}),
    staleRunCheckIntervalMs: 0,
    notify: vi.fn(),
  });

  return {
    flow,
    runtime,
    runProjection,
    activeRunFlow,
    settleRuntimeTurnProjection,
    reconcileOwnerHistory,
  };
}

async function handle(
  flow: TuiRuntimeEventFlow,
  event: TuiRuntimeEvent,
): Promise<void> {
  await (
    flow as unknown as {
      handle(runtimeEvent: TuiRuntimeEvent): Promise<void>;
    }
  ).handle(event);
}

describe('TuiRuntimeEventFlow stale-run safety net', () => {
  it('clears an adopted Runtime Turn after two consecutive settled Runtime reads', async () => {
    const { observability, recordRunLifecycle } = createObservability();
    const fixture = createFixture({
      observability,
      runtimeActiveRun: vi.fn(async () => activeRun('terminal')),
      queuedMessages: vi.fn(async () => [queued('queued')]),
    });
    fixture.flow.adoptRuntimeTurn('session-1', 'turn-stale', 100);
    expect(fixture.runProjection.snapshot().latestRuntimeTurnId).toBe(
      'turn-stale',
    );

    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);
    expect(fixture.runProjection.snapshot().latestRuntimeTurnId).toBe(
      'turn-stale',
    );

    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(true);
    expect(
      fixture.runProjection.snapshot().latestRuntimeTurnId,
    ).toBeUndefined();
    expect(fixture.settleRuntimeTurnProjection).toHaveBeenCalledWith(
      'turn-stale',
      'succeeded',
    );
    expect(fixture.reconcileOwnerHistory).toHaveBeenCalledWith(false);
    expect(fixture.activeRunFlow.refresh).toHaveBeenCalledWith(true);
    expect(recordRunLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stale-run-reconciled',
        sessionId: 'session-1',
        projectedTurnId: 'turn-stale',
        runtimeState: 'terminal',
        queuedCount: 1,
      }),
    );
    fixture.flow.stop();
  });

  it('keeps the projected run while Runtime still reports running work or a Queue handoff', async () => {
    const reads: Array<{
      run: TuiActiveRunSnapshot;
      queue: TuiQueuedMessage[];
    }> = [
      { run: activeRun('idle'), queue: [] },
      { run: activeRun('running', 'turn-next'), queue: [] },
      { run: activeRun('idle'), queue: [] },
      { run: activeRun('idle'), queue: [queued('accepted')] },
      { run: activeRun('decision-blocked', 'turn-stale'), queue: [] },
    ];
    let read = 0;
    const fixture = createFixture({
      runtimeActiveRun: vi.fn(
        async () => reads[Math.min(read, reads.length - 1)]!.run,
      ),
      queuedMessages: vi.fn(
        async () => reads[Math.min(read++, reads.length - 1)]!.queue,
      ),
    });
    fixture.runProjection.markRecoveredTurn('turn-stale');

    for (let index = 0; index < reads.length; index += 1) {
      await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);
    }
    expect(fixture.runProjection.snapshot().latestRuntimeTurnId).toBe(
      'turn-stale',
    );
    expect(fixture.settleRuntimeTurnProjection).not.toHaveBeenCalled();
    fixture.flow.stop();
  });

  it('keeps the projected run while an accepted Queue handoff is not yet Runtime-visible', async () => {
    const fixture = createFixture({
      runtimeActiveRun: vi.fn(async () => activeRun('idle')),
      queuedMessages: vi.fn(async () => []),
    });
    fixture.runProjection.markRecoveredTurn('turn-stale');
    fixture.runProjection.markQueueHandoffPending();

    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);
    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);

    expect(fixture.runProjection.snapshot()).toEqual(
      expect.objectContaining({
        latestRuntimeTurnId: 'turn-stale',
        queueHandoffPending: true,
      }),
    );
    expect(fixture.settleRuntimeTurnProjection).not.toHaveBeenCalled();
    fixture.flow.stop();
  });

  it('rechecks Queue handoff ownership after Runtime reads finish', async () => {
    let resolveActiveRun!: (value: TuiActiveRunSnapshot) => void;
    let resolveQueuedMessages!: (value: TuiQueuedMessage[]) => void;
    const runtimeActiveRun = vi
      .fn<() => Promise<TuiActiveRunSnapshot>>()
      .mockResolvedValueOnce(activeRun('idle'))
      .mockImplementationOnce(
        () =>
          new Promise<TuiActiveRunSnapshot>((resolve) => {
            resolveActiveRun = resolve;
          }),
      );
    const queuedMessages = vi
      .fn<() => Promise<TuiQueuedMessage[]>>()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise<TuiQueuedMessage[]>((resolve) => {
            resolveQueuedMessages = resolve;
          }),
      );
    const fixture = createFixture({ runtimeActiveRun, queuedMessages });
    fixture.runProjection.markRecoveredTurn('turn-stale');
    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);

    const pendingCheck = fixture.flow.reconcileStaleRun();
    await vi.waitFor(() => {
      expect(runtimeActiveRun).toHaveBeenCalledTimes(2);
      expect(queuedMessages).toHaveBeenCalledTimes(2);
    });
    fixture.runProjection.markQueueHandoffPending();
    resolveActiveRun(activeRun('idle'));
    resolveQueuedMessages([]);

    await expect(pendingCheck).resolves.toBe(false);
    expect(fixture.runProjection.snapshot()).toEqual(
      expect.objectContaining({
        latestRuntimeTurnId: 'turn-stale',
        queueHandoffPending: true,
      }),
    );
    expect(fixture.settleRuntimeTurnProjection).not.toHaveBeenCalled();
    fixture.flow.stop();
  });

  it('restarts confirmation after a Runtime ownership read fails', async () => {
    const runtimeActiveRun = vi
      .fn<() => Promise<TuiActiveRunSnapshot>>()
      .mockResolvedValueOnce(activeRun('idle'))
      .mockRejectedValueOnce(new Error('ownership probe failed'))
      .mockResolvedValue(activeRun('idle'));
    const fixture = createFixture({ runtimeActiveRun });
    fixture.runProjection.markRecoveredTurn('turn-stale');

    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);
    await expect(fixture.flow.reconcileStaleRun()).rejects.toThrow('ownership probe failed');
    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);

    expect(fixture.runProjection.snapshot().latestRuntimeTurnId).toBe('turn-stale');
    expect(fixture.settleRuntimeTurnProjection).not.toHaveBeenCalled();
    fixture.flow.stop();
  });

  it('restarts confirmation when the Runtime event stream restarts', async () => {
    const fixture = createFixture({
      runtimeActiveRun: vi.fn(async () => activeRun('idle')),
    });
    fixture.runProjection.markRecoveredTurn('turn-stale');

    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);
    vi.spyOn(fixture.flow, 'start').mockImplementation(() => undefined);
    fixture.flow.restart();
    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);

    expect(fixture.runProjection.snapshot().latestRuntimeTurnId).toBe('turn-stale');
    expect(fixture.settleRuntimeTurnProjection).not.toHaveBeenCalled();
    fixture.flow.stop();
  });

  it('discards an in-flight ownership read when the Runtime event stream restarts', async () => {
    let resolveActiveRun!: (value: TuiActiveRunSnapshot) => void;
    let resolveQueuedMessages!: (value: TuiQueuedMessage[]) => void;
    const runtimeActiveRun = vi
      .fn<() => Promise<TuiActiveRunSnapshot>>()
      .mockImplementationOnce(
        () =>
          new Promise<TuiActiveRunSnapshot>((resolve) => {
            resolveActiveRun = resolve;
          }),
      )
      .mockResolvedValue(activeRun('idle'));
    const queuedMessages = vi
      .fn<() => Promise<TuiQueuedMessage[]>>()
      .mockImplementationOnce(
        () =>
          new Promise<TuiQueuedMessage[]>((resolve) => {
            resolveQueuedMessages = resolve;
          }),
      )
      .mockResolvedValue([]);
    const fixture = createFixture({ runtimeActiveRun, queuedMessages });
    fixture.runProjection.markRecoveredTurn('turn-stale');

    const pendingCheck = fixture.flow.reconcileStaleRun();
    await vi.waitFor(() => {
      expect(runtimeActiveRun).toHaveBeenCalledTimes(1);
      expect(queuedMessages).toHaveBeenCalledTimes(1);
    });
    vi.spyOn(fixture.flow, 'start').mockImplementation(() => undefined);
    fixture.flow.restart();
    resolveActiveRun(activeRun('idle'));
    resolveQueuedMessages([]);

    await expect(pendingCheck).resolves.toBe(false);
    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);
    expect(fixture.runProjection.snapshot().latestRuntimeTurnId).toBe('turn-stale');
    expect(fixture.settleRuntimeTurnProjection).not.toHaveBeenCalled();
    fixture.flow.stop();
  });

  it('restarts confirmation when the projected Turn changes between reads', async () => {
    const fixture = createFixture({
      runtimeActiveRun: vi.fn(async () => activeRun('idle')),
    });
    fixture.runProjection.markRecoveredTurn('turn-a');
    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);
    fixture.runProjection.markRecoveredTurn('turn-b');
    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);
    expect(fixture.runProjection.snapshot().latestRuntimeTurnId).toBe('turn-b');
    await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(true);
    expect(
      fixture.runProjection.snapshot().latestRuntimeTurnId,
    ).toBeUndefined();
    fixture.flow.stop();
  });

  it('does not clear a Turn that a pending interaction keeps open', async () => {
    const fixture = createFixture({
      runtimeActiveRun: vi.fn(async () => activeRun('terminal')),
      interactionContinuesTurn: () => true,
    });
    fixture.runProjection.markRecoveredTurn('turn-question');
    await fixture.flow.reconcileStaleRun();
    await fixture.flow.reconcileStaleRun();
    expect(fixture.runProjection.snapshot().latestRuntimeTurnId).toBe(
      'turn-question',
    );
    expect(fixture.runtime.getActiveRun).not.toHaveBeenCalled();
    fixture.flow.stop();
  });

  it('reports but never clears a foreground in-process Turn', async () => {
    const { observability, recordRunLifecycle } = createObservability();
    const fixture = createFixture({
      observability,
      currentControllerTurnId: () => 'turn-local',
      runtimeActiveRun: vi.fn(async () => activeRun('idle')),
    });
    for (let index = 0; index < 4; index += 1) {
      await expect(fixture.flow.reconcileStaleRun()).resolves.toBe(false);
    }
    expect(fixture.settleRuntimeTurnProjection).not.toHaveBeenCalled();
    expect(recordRunLifecycle).toHaveBeenCalledTimes(1);
    expect(recordRunLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stale-in-process-run',
        inProcessTurnId: 'turn-local',
        runtimeState: 'idle',
      }),
    );
    fixture.flow.stop();
  });

  it('records terminals for other Turns that the local projection does not own', async () => {
    const { observability, recordRunLifecycle } = createObservability();
    let controllerTurnId: string | undefined = 'turn-local';
    const fixture = createFixture({
      observability,
      currentControllerTurnId: () => controllerTurnId,
    });

    await handle(fixture.flow, lifecycle('session.finish', 'turn-delivery'));
    expect(recordRunLifecycle).toHaveBeenCalledWith({
      kind: 'terminal-not-owned',
      sessionId: 'session-1',
      turnId: 'turn-delivery',
      reason: 'in-process-turn',
      inProcessTurnId: 'turn-local',
    });

    controllerTurnId = undefined;
    fixture.runProjection.markRecoveredTurn('turn-held');
    await handle(fixture.flow, lifecycle('session.error', 'turn-other'));
    expect(recordRunLifecycle).toHaveBeenLastCalledWith({
      kind: 'terminal-not-owned',
      sessionId: 'session-1',
      turnId: 'turn-other',
      reason: 'projection-mismatch',
      projectedTurnId: 'turn-held',
    });
    fixture.flow.stop();
  });

  it('records adopted and queue-started Runtime Turns', async () => {
    const { observability, recordRunLifecycle } = createObservability();
    const fixture = createFixture({ observability });

    fixture.flow.adoptRuntimeTurn('session-1', 'turn-activated', 100);
    await handle(fixture.flow, {
      ...lifecycle('session.start', 'turn-queued'),
      runSource: 'queued-drain',
      queueItemIds: ['item-1'],
    } as TuiRuntimeEvent);

    expect(recordRunLifecycle).toHaveBeenCalledWith({
      kind: 'runtime-turn-adopted',
      sessionId: 'session-1',
      turnId: 'turn-activated',
    });
    expect(recordRunLifecycle).toHaveBeenCalledWith({
      kind: 'queue-turn-started',
      sessionId: 'session-1',
      turnId: 'turn-queued',
      queuedCount: 1,
    });
    fixture.flow.stop();
  });
});
