import { describe, expect, it, vi } from 'vitest';

import type { AgentHost } from '../agent-host/contracts.js';
import type { TurnFailureProjection, TurnPreparationProjection } from '../contracts.js';
import type { AcceptedAgentTurn, AcceptedCompactionTurn, TurnController } from './contracts.js';
import type { TurnRepository } from '../persistence/contracts.js';
import {
  createExecutionCoordinator,
  type ExecutionCoordinatorOptions,
} from './execution.coordinator.js';

describe('ExecutionCoordinator durable Queue pause terminal policy', () => {
  it('commits a final Foreground Turn failure and QueuePaused through one repository settlement', async () => {
    const harness = fixture();
    harness.host.run.mockResolvedValueOnce({ status: 'failed', error: new Error('model failed') });

    const started = await harness.coordinator.startTurn({
      turn: agentTurn(),
      request: {
        input: { text: 'hello' },
        genuineUserQueryText: 'hello',
        provenance: { source: 'api', routingFingerprint: 'api:failure' },
      },
    });
    await expect(started.completion).resolves.toMatchObject({ status: 'failed' });

    expect(harness.repository.settle).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
      leaseId: 'lease-1',
      outcome: 'failed',
      queuePauseCause: 'turn-final-failure',
    });
  });

  it('pauses both pre-Host and accepted-admission final failures', async () => {
    const harness = fixture();

    const preHost = await harness.coordinator.failTurn({
      turn: agentTurn(),
      error: new Error('pre-host failed'),
    });
    await preHost.completion;
    const failedAdmission = await harness.coordinator.failAdmission({
      admission: admission(),
      error: new Error('controller registration failed'),
    });
    await failedAdmission.completion;

    expect(harness.repository.settle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ queuePauseCause: 'turn-final-failure' }),
    );
    expect(harness.repository.settle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ queuePauseCause: 'turn-final-failure' }),
    );
  });

  // Leaving the conversation still stops the live Turn and must pause like Stop.
  it.each(['user_stop', 'session_leave'])(
    'pauses an aborted product Turn for a normalized %s controller signal',
    async (reason) => {
      const harness = fixture();
      harness.host.run.mockResolvedValueOnce({ status: 'aborted', reason: 'runner stopped' });

      const started = await harness.coordinator.startTurn({
        turn: agentTurn(reason),
        request: {
          input: { text: 'hello' },
          genuineUserQueryText: 'hello',
          provenance: { source: 'api', routingFingerprint: `api:${reason}` },
        },
      });
      await started.completion;

      expect(harness.repository.settle).toHaveBeenCalledWith(
        expect.objectContaining({ queuePauseCause: 'user-stop' }),
      );
    },
  );

  it('does not pause natural completion, non-user abort, or failed compaction', async () => {
    const harness = fixture();

    const completed = await harness.coordinator.startTurn({
      turn: agentTurn(),
      request: {
        input: { text: 'hello' },
        genuineUserQueryText: 'hello',
        provenance: { source: 'api', routingFingerprint: 'api:completed' },
      },
    });
    await completed.completion;

    harness.host.run.mockResolvedValueOnce({ status: 'aborted', reason: 'runner stopped' });
    const aborted = await harness.coordinator.startTurn({
      turn: agentTurn('immediate_send'),
      request: {
        input: { text: 'hello again' },
        genuineUserQueryText: 'hello again',
        provenance: { source: 'api', routingFingerprint: 'api:immediate-send' },
      },
    });
    await aborted.completion;

    harness.host.compact.mockResolvedValueOnce({ status: 'failed', error: new Error('compact') });
    await harness.coordinator.compact({ lease: compactionTurn(), reason: 'manual' });

    expect(harness.repository.settle.mock.calls.map(([input]) => input.queuePauseCause)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('releases in-process ownership without waking the Queue when terminal settlement cannot be persisted', async () => {
    const order: string[] = [];
    const logger = {
      warn: vi.fn(),
      error: vi.fn(() => {
        order.push('log');
      }),
    };
    const harness = fixture({ logger });
    const diskFull = new Error('database or disk is full');
    harness.host.run.mockResolvedValueOnce({ status: 'failed', error: new Error('model failed') });
    harness.repository.settle.mockRejectedValueOnce(diskFull).mockRejectedValueOnce(diskFull);
    harness.controller.complete.mockImplementationOnce(() => {
      order.push('controller.complete');
    });
    harness.turnSettlement.abandon.mockImplementationOnce(async () => {
      order.push('product-abandon');
    });

    const started = await harness.coordinator.startTurn({
      turn: agentTurn(),
      request: {
        input: { text: 'hello' },
        genuineUserQueryText: 'hello',
        provenance: { source: 'api', routingFingerprint: 'api:pause-failure' },
      },
    });

    await expect(started.completion).resolves.toEqual({ status: 'failed', error: diskFull });
    expect(harness.repository.settle).toHaveBeenCalledTimes(2);
    // The next admission recovers the durable lock; only the in-process owner
    // is released here, and the product Turn is abandoned instead of settled.
    expect(order).toEqual(['controller.complete', 'log', 'product-abandon']);
    expect(harness.turnSettlement.abandon).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    expect(harness.turnSettlement.settle).not.toHaveBeenCalled();
    expect(harness.released.publish).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-1',
        turn_id: 'turn-1',
        owner_released: true,
        error: 'database or disk is full',
      }),
      expect.any(String),
    );
  });

  it('keeps the outcome and still releases when the failure log throws', async () => {
    const logger = {
      warn: vi.fn(() => {
        throw new Error('log sink down');
      }),
    };
    const harness = fixture({ logger });
    const diskFull = new Error('database or disk is full');
    harness.repository.settle.mockRejectedValue(diskFull);

    const compacted = await harness.coordinator.compact({
      lease: compactionTurn(),
      reason: 'manual',
    });

    expect(compacted).toEqual({ status: 'failed', error: diskFull });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(harness.controller.complete).toHaveBeenCalledOnce();
    // Compaction owns no product Turn state.
    expect(harness.turnSettlement.abandon).not.toHaveBeenCalled();
  });

  it.each([
    ['reports unpersisted steering', () => true],
    [
      'cannot tell',
      () => {
        throw new Error('steering probe failed');
      },
    ],
  ])('keeps the in-process owner when the steering probe %s', async (_case, hasPendingForTurn) => {
    const steeringTeardown = {
      commitDiscardedBeforeRelease: vi.fn(async () => undefined),
      hasPendingForTurn: vi.fn(hasPendingForTurn),
    };
    const harness = fixture({ steeringTeardown });
    const diskFull = new Error('database or disk is full');
    harness.host.run.mockResolvedValueOnce({ status: 'aborted', reason: 'user_stop' });
    harness.repository.settle.mockRejectedValue(diskFull);

    const started = await harness.coordinator.startTurn({
      turn: agentTurn('user_stop'),
      request: {
        input: { text: 'hello' },
        genuineUserQueryText: 'hello',
        provenance: { source: 'api', routingFingerprint: 'api:steering-pending' },
      },
    });

    await expect(started.completion).resolves.toEqual({ status: 'failed', error: diskFull });
    expect(steeringTeardown.hasPendingForTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    expect(harness.controller.complete).not.toHaveBeenCalled();
    expect(harness.turnSettlement.abandon).not.toHaveBeenCalled();
    expect(harness.released.publish).not.toHaveBeenCalled();
  });

  it('releases the owner when the steering probe reports nothing pending', async () => {
    const steeringTeardown = {
      commitDiscardedBeforeRelease: vi.fn(async () => undefined),
      hasPendingForTurn: vi.fn(() => false),
    };
    const harness = fixture({ steeringTeardown });
    const diskFull = new Error('database or disk is full');
    harness.host.run.mockResolvedValueOnce({ status: 'aborted', reason: 'user_stop' });
    harness.repository.settle.mockRejectedValue(diskFull);

    const started = await harness.coordinator.startTurn({
      turn: agentTurn('user_stop'),
      request: {
        input: { text: 'hello' },
        genuineUserQueryText: 'hello',
        provenance: { source: 'api', routingFingerprint: 'api:steering-durable' },
      },
    });

    await expect(started.completion).resolves.toEqual({ status: 'failed', error: diskFull });
    expect(harness.controller.complete).toHaveBeenCalledOnce();
    expect(harness.turnSettlement.abandon).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
  });
});

function fixture(overrides: Partial<ExecutionCoordinatorOptions> = {}) {
  const host = {
    run: vi.fn<AgentHost['run']>(async () => ({ status: 'completed' })),
    compact: vi.fn<AgentHost['compact']>(async () => ({
      status: 'unchanged',
      reason: 'nothing-to-compact',
    })),
  };
  const repository = {
    settle: vi.fn<TurnRepository['settle']>(async ({ outcome }) => ({
      status: 'settled' as const,
      completedAtMs: 100,
      outcome,
    })),
  };
  const controller = {
    complete: vi.fn<TurnController['complete']>(),
  };
  const failures = {
    project: vi.fn<TurnFailureProjection['project']>(async () => undefined),
  };
  const preparation = {
    projectStarted: vi.fn<TurnPreparationProjection['projectStarted']>(async () => undefined),
  };
  const released = { publish: vi.fn(async () => undefined) };
  const turnSettlement = {
    settle: vi.fn(async () => undefined),
    abandon: vi.fn(async () => undefined),
  };
  const onBeginSettlement = vi.fn();
  const options: ExecutionCoordinatorOptions = {
    onBeginSettlement,
    host,
    repository,
    controller,
    preparation,
    failures,
    released,
    turnSettlement,
    ...overrides,
  };
  return {
    onBeginSettlement,
    host,
    repository,
    controller,
    failures,
    released,
    turnSettlement,
    coordinator: createExecutionCoordinator(options),
    preparation,
  };
}

function admission() {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    leaseId: 'lease-1',
    acceptedSequence: 1,
    acceptedAtMs: 50,
    busyReason: 'turn' as const,
    foreground: true as const,
  };
}

function agentTurn(abortReason?: string): AcceptedAgentTurn {
  const controller = new AbortController();
  if (abortReason) controller.abort(abortReason);
  return {
    ...admission(),
    signal: controller.signal,
  };
}

function compactionTurn(): AcceptedCompactionTurn {
  const turn = agentTurn();
  return {
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    leaseId: turn.leaseId,
    acceptedSequence: turn.acceptedSequence,
    acceptedAtMs: turn.acceptedAtMs,
    busyReason: 'compaction',
    signal: turn.signal,
  };
}
