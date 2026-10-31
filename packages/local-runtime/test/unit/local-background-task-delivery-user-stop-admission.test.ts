import {
  ConversationTurnRejectedError,
  type RuntimeConversation,
  type ConversationSteerInput,
} from '@mavis/conversation-contract';
import { describe, expect, it, vi } from 'vitest';

import type { LocalTaskRunnerHostWithSessionLookup } from '../../src/api/local-task-host.js';
import { logger } from '../../src/common/logger.js';
import {
  closeLocalBackgroundTaskDelivery,
  scheduleLocalBackgroundTaskDelivery,
  startLocalBackgroundTaskDeliveryTurn,
} from '../../src/background-task/delivery.js';
import { buildBackgroundTaskDeliveryInput } from '../../src/background-task/conversation-delivery.js';
import type { BackgroundTask } from '../../src/background-task/domain.js';
import { openUserStopWindow } from '../../src/background-task/user-stop-suppression.js';

const OWNER = 'session-owner';

describe('local background task delivery: user stop final admission', () => {
  it('holds a window opened after the delivery recheck as busy', async () => {
    const fixture = harness([terminalTask('late')]);
    let window: ReturnType<typeof openUserStopWindow> | undefined;
    fixture.steer.mockImplementation(async (input) => {
      window = openUserStopWindow(fixture.host, OWNER, 1_000);
      await input.preDelivery?.accept({ mode: 'steered', turnId: 'turn-delivery' });
      return { delivered: true, mode: 'steered', turnId: 'turn-delivery' };
    });

    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'late')).resolves.toBe('busy');

    expect(fixture.metrics).toHaveBeenCalledWith('background_task_delivery_suppressed_total', 1, {
      reason: 'user_stop_window_admission',
    });
    if (!window) throw new Error('Expected the final-admission window');
    window.close();
  });

  it('skips a batch whose named tasks are all suppressed at final admission', async () => {
    const info = vi.spyOn(logger, 'info');
    const fixture = harness([terminalTask('target')]);
    let window: ReturnType<typeof openUserStopWindow> | undefined;
    fixture.steer.mockImplementation(async (input) => {
      window = openUserStopWindow(fixture.host, OWNER, 1_000);
      window.registerTargets(['target']);
      window.close();
      await input.preDelivery?.accept({ mode: 'activated', turnId: 'turn-delivery' });
      return { delivered: true, mode: 'activated', turnId: 'turn-delivery', completion: Promise.resolve({ status: 'completed' }) };
    });
    try {
      await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'target')).resolves.toBe(
        'skipped',
      );
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_delivery_suppressed',
          reason: 'user_stop_target_admission',
          mode: 'activated',
          turnId: 'turn-delivery',
          result: 'skipped',
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it.each(['aggregate', 'rejected', 'fail-closed'] as const)(
    'keeps the admission hold when ingress reports %s',
    async (outcome) => {
      const fixture = harness([terminalTask('target')]);
      let window: ReturnType<typeof openUserStopWindow> | undefined;
      fixture.steer.mockImplementation(async (input) => {
        window = openUserStopWindow(fixture.host, OWNER, 1_000);
        try {
          await input.preDelivery?.accept({ mode: 'activated', turnId: 'turn-delivery' });
        } catch (error) {
          window.close();
          if (outcome === 'aggregate') throw new AggregateError([error], 'delivery rejected');
          if (outcome === 'rejected') {
            throw new ConversationTurnRejectedError(OWNER, 'active-turn');
          }
          return {
            delivered: true,
            mode: 'activated',
            turnId: 'turn-delivery',
            completion: Promise.resolve({ status: 'failed', error: new Error('lost ownership') }),
          };
        }
        throw new Error('Expected final-admission hold');
      });

      await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'target')).resolves.toBe(
        'busy',
      );
      window?.close();
    },
  );

  it('observes a rejecting fail-closed activated completion before returning the hold', async () => {
    const fixture = harness([terminalTask('target')]);
    const failure = new Error('lost activated delivery ownership');
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<never>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    // The fallback keeps the counterproof focused on observer registration rather
    // than turning its intentional missing observer into a global rejection.
    void completion.catch(() => undefined);
    fixture.steer.mockImplementation(async (input) => {
      const window = openUserStopWindow(fixture.host, OWNER, 1_000);
      try {
        await input.preDelivery?.accept({ mode: 'activated', turnId: 'turn-delivery' });
      } catch {
        window.close();
        return { delivered: true, mode: 'activated', turnId: 'turn-delivery', completion };
      }
      throw new Error('Expected final-admission hold');
    });

    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'target')).resolves.toBe(
      'busy',
    );
    rejectCompletion(failure);
    await vi.waitFor(() =>
      expect(fixture.host.matrixLogger?.warn).toHaveBeenCalledWith(
        { sessionId: OWNER, turnId: 'turn-delivery' },
        expect.stringContaining(failure.message),
      ),
    );
  });

  it('retries a partially suppressed batch with only remaining tasks and the same key', async () => {
    vi.useFakeTimers();
    const fixture = harness([terminalTask('target'), terminalTask('remaining')]);
    const getsReady = deferred();
    fixture.get.mockImplementation(async (taskId) => {
      await getsReady.promise;
      return fixture.tasks.get(taskId);
    });
    let attempts = 0;
    fixture.steer.mockImplementation(async (input) => {
      attempts += 1;
      if (attempts === 1) {
        const window = openUserStopWindow(fixture.host, OWNER, 1_000);
        window.registerTargets(['target']);
        window.close();
        await input.preDelivery?.accept({ mode: 'steered', turnId: 'turn-first' });
      }
      return { delivered: true, mode: 'steered', turnId: `turn-${attempts}` };
    });
    try {
      scheduleLocalBackgroundTaskDelivery(fixture.host, 'target');
      scheduleLocalBackgroundTaskDelivery(fixture.host, 'remaining');
      getsReady.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(fixture.steer).toHaveBeenCalledTimes(2);
      const [first, second] = fixture.steer.mock.calls.flatMap(([input]) => (input ? [input] : []));
      if (!first || !second) throw new Error('Expected both delivery attempts');
      expect(second.idempotencyKey).toBe(first.idempotencyKey);
      expect(noticeTaskIds(second)).toEqual(['remaining']);
    } finally {
      closeLocalBackgroundTaskDelivery(fixture.host);
      vi.useRealTimers();
    }
  });

  it('keeps preDelivery out of the pure builder and attaches it only at delivery', async () => {
    const input = buildBackgroundTaskDeliveryInput({
      ownerSessionId: OWNER,
      tasks: [terminalTask('task')],
      batchTaskIds: ['task'],
      observedTerminalCount: 1,
      requestedTurnId: 'turn-delivery',
    });

    expect(input).not.toHaveProperty('preDelivery');
    expect(input.idempotencyKey).toBe('task');

    const fixture = harness([terminalTask('task')]);
    fixture.steer.mockImplementation(async (delivery) => {
      expect(delivery.preDelivery).toEqual({ accept: expect.any(Function) });
      return { delivered: true, mode: 'steered', turnId: 'turn-delivery' };
    });
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'task')).resolves.toBe(
      'delivered',
    );
  });
});

function harness(initial: readonly BackgroundTask[]) {
  const tasks = new Map(initial.map((task) => [task.taskId, task]));
  const get = vi.fn(async (taskId: string) => tasks.get(taskId));
  const steer = vi.fn<RuntimeConversation['ingress']['steer']>();
  const metrics = vi.fn();
  const host = {
    runtimeConversation: { ingress: { steer } },
    backgroundTaskService: {
      get,
      reminderSnapshot: vi.fn(async () => ({ tasks: [], undeliveredTotal: 0, terminalTotal: tasks.size })),
    },
    metricsClient: { counter: metrics },
    matrixLogger: { warn: vi.fn() },
    nowMs: () => 1_000,
    getSessionById: async () => ({ sessionId: OWNER, sessionType: 'root', visibility: 'visible' }),
  } as unknown as LocalTaskRunnerHostWithSessionLookup;
  return { host, tasks, get, steer, metrics };
}

function terminalTask(taskId: string): BackgroundTask {
  return {
    taskId,
    kind: 'bash',
    status: 'succeeded',
    ownerSessionId: OWNER,
    createdAt: 1_000,
    updatedAt: 2_000,
    endedAt: 2_000,
  };
}

function noticeTaskIds(input: ConversationSteerInput): string[] {
  const origin = input.message.origin;
  if (!origin || typeof origin !== 'object' || !('taskIds' in origin)) return [];
  const taskIds = origin.taskIds;
  return Array.isArray(taskIds) ? taskIds.filter((taskId): taskId is string => typeof taskId === 'string') : [];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
