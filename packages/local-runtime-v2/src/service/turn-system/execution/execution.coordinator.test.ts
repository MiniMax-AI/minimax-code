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

  it('fails closed without releasing Turn ownership when atomic terminal settlement fails', async () => {
    const harness = fixture();
    const pauseError = new Error('queue pause unavailable');
    harness.host.run.mockResolvedValueOnce({ status: 'failed', error: new Error('model failed') });
    harness.repository.settle.mockRejectedValueOnce(pauseError).mockRejectedValueOnce(pauseError);

    const started = await harness.coordinator.startTurn({
      turn: agentTurn(),
      request: {
        input: { text: 'hello' },
        genuineUserQueryText: 'hello',
        provenance: { source: 'api', routingFingerprint: 'api:pause-failure' },
      },
    });

    await expect(started.completion).resolves.toEqual({ status: 'failed', error: pauseError });
    expect(harness.repository.settle).toHaveBeenCalledTimes(2);
    expect(harness.controller.complete).not.toHaveBeenCalled();
    expect(harness.released.publish).not.toHaveBeenCalled();
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
