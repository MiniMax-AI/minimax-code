import { describe, expect, it, vi } from 'vitest';

import type {
  QueueEnqueueInput,
  QueueEnqueueResult,
  QueueItem,
} from '../../../session-system/index.js';
import {
  createSteeringRequeue,
  type DiscardedSteeringBatch,
  type SteeringRequeueOptions,
} from './steering-requeue.js';
import { createSteeringTeardownCommit } from './steering-teardown-commit.js';

describe('createSteeringRequeue teardown fallback (Decision v5)', () => {
  it('returns the batch to the queue after bounded teardown retries fail (TS-70)', async () => {
    const logger = { warn: vi.fn() };
    const enqueue = enqueueOk();
    const publish = vi.fn(async (_sessionId: string) => undefined);
    const teardown = {
      commit: vi.fn(async () => {
        throw new Error('history write failed');
      }),
    };
    const requeue = createSteeringRequeue({
      queue: queuePorts({ enqueue }),
      released: { publish },
      teardown,
      logger,
    });

    requeue.discard({
      ...batch([steering('composer-steer', 'req-1', 'stopped instruction')]),
      cause: 'abort',
      abortReason: 'user_stop',
    });

    // Losing an admitted user message outweighs the fall-to-session shape:
    // after bounded retries the batch goes back to the queue and warns.
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(teardown.commit).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', turnId: 'turn-1' }),
      expect.any(String),
    );
    await requeue.drain();
  });

  it('parks the fallback-requeued abort batch as queued without publishing a wake (TS-70)', async () => {
    const enqueue = enqueueOk();
    const publish = vi.fn(async (_sessionId: string) => undefined);
    const teardown = {
      commit: vi.fn(async () => {
        throw new Error('history write failed');
      }),
    };
    const requeue = createSteeringRequeue({
      queue: queuePorts({ enqueue }),
      released: { publish },
      teardown,
      logger: { warn: vi.fn() },
    });

    requeue.discard({
      ...batch([steering('composer-steer', 'req-1', 'stopped instruction')]),
      cause: 'abort',
      abortReason: 'user_stop',
    });

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    await requeue.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A wake here would auto-dispatch the instruction the user just stopped.
    // The item stays queued and visible for a manual send instead.
    expect(publish).not.toHaveBeenCalled();
  });

  // Leaving the conversation (TUI `/clear`, switching Sessions) still stops the
  // live Turn and pauses at settlement exactly like Stop, so its fallback must too.
  it.each(['user_stop', 'session_leave'])(
    'restores the durable user-stop pause after a %s fallback requeue commits (TS-70)',
    async (abortReason) => {
      const enqueue = enqueueOk();
      const pauseIfPending = vi.fn(async () => ({ pendingCount: 1 }));
      const publish = vi.fn(async (_sessionId: string) => undefined);
      const teardown = {
        commit: vi.fn(async () => {
          throw new Error('history write failed');
        }),
      };
      const requeue = createSteeringRequeue({
        queue: queuePorts({ enqueue, pauseIfPending }),
        released: { publish },
        teardown,
        logger: { warn: vi.fn() },
      });

      requeue.discard({
        ...batch([steering('composer-steer', 'req-1', 'stopped instruction')]),
        cause: 'abort',
        abortReason,
      });

      // The fallback lane re-parks the queue exactly like Stop over pending
      // items: settlement may have judged the pause with an empty queue before
      // this detached requeue landed. It still never wakes dispatch.
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(pauseIfPending).toHaveBeenCalledTimes(1));
      expect(pauseIfPending).toHaveBeenCalledWith({
        sessionId: 'session-1',
        cause: 'user-stop',
        triggerTurnId: 'turn-1',
      });
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it('requeues a lifecycle abort fallback without pausing the queue (TS-70)', async () => {
    const enqueue = enqueueOk();
    const pauseIfPending = vi.fn(async () => ({ pendingCount: 1 }));
    const requeue = createSteeringRequeue({
      queue: queuePorts({ enqueue, pauseIfPending }),
      released: { publish: vi.fn(async () => undefined) },
      teardown: {
        commit: vi.fn(async () => {
          throw new Error('history write failed');
        }),
      },
      logger: { warn: vi.fn() },
    });

    requeue.discard({
      ...batch([steering('composer-steer', 'req-1', 'interrupted instruction')]),
      cause: 'abort',
      abortReason: 'lifecycle',
    });

    // A runtime-driven abort is not the user walking away: settlement does not
    // pause for it, so neither may its steering fallback.
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    await requeue.drain();
    expect(pauseIfPending).not.toHaveBeenCalled();
  });
});

describe('createSteeringRequeue teardown fallback retries (Decision v5)', () => {
  it('keeps the fallback batch in the retry loop until the pause restore lands (TS-70)', async () => {
    const logger = { warn: vi.fn() };
    // Mirrors the repo's identity absorption (clientRequestId replay /
    // itemId restore): a retried enqueue of the same batch identity replaces
    // the row instead of adding a second queue entry.
    const queued = new Map<string, QueueEnqueueInput>();
    const enqueue = vi.fn(async (input: QueueEnqueueInput) => {
      queued.set(`${String(input.itemId)}:${String(input.clientRequestId)}`, input);
      return enqueueResult(input);
    });
    const pauseIfPending = vi
      .fn(async () => ({ pendingCount: 1 }))
      .mockRejectedValueOnce(new Error('pause lane unavailable'));
    const teardown = {
      commit: vi.fn(async () => {
        throw new Error('history write failed');
      }),
    };
    const requeue = createSteeringRequeue({
      queue: queuePorts({ enqueue, pauseIfPending }),
      released: { publish: vi.fn(async () => undefined) },
      teardown,
      logger,
    });

    requeue.discard({
      ...batch([steering('composer-steer', 'req-1', 'stopped instruction')]),
      cause: 'abort',
      abortReason: 'user_stop',
    });

    // The enqueue landed but the user-stop pause did not: the batch must
    // stay un-settled so the existing pending/drain retry lanes restore the
    // pause — otherwise a later wake auto-dispatches the instruction the
    // user just stopped, with no retry left to prevent it.
    await vi.waitFor(() => expect(pauseIfPending).toHaveBeenCalledTimes(1));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', turnId: 'turn-1' }),
      expect.any(String),
    );
    await requeue.drain();
    expect(pauseIfPending).toHaveBeenCalledTimes(2);
    // The retry replays the identical batch identity; the queue absorbs it
    // into the same entry, so the panel still shows one parked item.
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]).toEqual(enqueue.mock.calls[1]);
    expect(queued.size).toBe(1);
    // The pause landed: the batch settles and later drains find nothing.
    await requeue.drain();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(pauseIfPending).toHaveBeenCalledTimes(2);
  });

  it('never settles or throws while the pause restore keeps failing (TS-70)', async () => {
    const enqueue = enqueueOk();
    const publish = vi.fn(async (_sessionId: string) => undefined);
    const pauseIfPending = vi.fn(async () => {
      throw new Error('pause lane unavailable');
    });
    const teardown = {
      commit: vi.fn(async () => {
        throw new Error('history write failed');
      }),
    };
    const requeue = createSteeringRequeue({
      queue: queuePorts({ enqueue, pauseIfPending }),
      released: { publish },
      teardown,
      logger: { warn: vi.fn() },
    });

    requeue.discard({
      ...batch([steering('composer-steer', 'req-1', 'stopped instruction')]),
      cause: 'abort',
      abortReason: 'user_stop',
    });

    // Status quo: each drain retries the identical hand-off once and leaves
    // the batch pending — never a throw, never a premature settle, never a
    // wake. A shutdown drain that ends here leaves the durable queued row
    // without its pause; the in-memory retry dies with the process.
    await vi.waitFor(() => expect(pauseIfPending).toHaveBeenCalledTimes(1));
    await requeue.drain();
    await requeue.drain();
    expect(pauseIfPending).toHaveBeenCalledTimes(3);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue.mock.calls[0]).toEqual(enqueue.mock.calls[1]);
    expect(enqueue.mock.calls[0]).toEqual(enqueue.mock.calls[2]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('degrades to the queue lane with a warn when no teardown sink is wired', async () => {
    const logger = { warn: vi.fn() };
    const enqueue = enqueueOk();
    const requeue = createSteeringRequeue({
      queue: queuePorts({ enqueue }),
      released: { publish: vi.fn(async () => undefined) },
      logger,
    });

    requeue.discard({
      ...batch([steering('composer-steer', 'req-1', 'stopped instruction')]),
      cause: 'abort',
      abortReason: 'user_stop',
    });

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', turnId: 'turn-1' }),
      expect.any(String),
    );
  });

  it('leaves the wake lane intact for an exit-boundary close discard (TS-64)', async () => {
    const publish = vi.fn(async (_sessionId: string) => undefined);
    const pauseIfPending = vi.fn(async () => ({ pendingCount: 0 }));
    const requeue = createSteeringRequeue({
      queue: queuePorts({ pauseIfPending }),
      released: { publish },
    });

    requeue.discard(batch([steering('composer-steer', 'req-1', 'follow-up query')]));

    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    // Exit-close keeps the v2 lane: requeue + wake, never a stop pause.
    expect(pauseIfPending).not.toHaveBeenCalled();
  });
});

type AgentHostSteeringMessage = DiscardedSteeringBatch['messages'][number];

type TeardownCommitInput = Parameters<NonNullable<SteeringRequeueOptions['teardown']>['commit']>[0];

function queuePorts(
  overrides: Partial<SteeringRequeueOptions['queue']> = {},
): SteeringRequeueOptions['queue'] {
  return {
    requireMutableSession: vi.fn(async () => ({
      sessionId: 'session-1',
      agentName: 'general',
      runtime: 'pi-agent',
    })),
    enqueue: enqueueOk(),
    pauseIfPending: vi.fn(async () => ({ pendingCount: 1 })),
    ...overrides,
  } as SteeringRequeueOptions['queue'];
}

function enqueueOk() {
  return vi.fn(async (input: QueueEnqueueInput) => enqueueResult(input));
}

function enqueueResult(input: QueueEnqueueInput): QueueEnqueueResult {
  return {
    item: {
      itemId: input.itemId ?? 'queue-generated',
      sessionId: input.session.sessionId,
      agentName: input.session.agentName,
      source: input.source ?? 'api',
      status: 'queued',
      message: input.message,
      createdAt: 10,
    } as QueueItem,
    position: 0,
  };
}

function batch(messages: readonly AgentHostSteeringMessage[]): DiscardedSteeringBatch {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages,
    turnReleased: Promise.resolve(),
  };
}

function steering(
  producerId: string,
  idempotencyKey: string,
  text: string,
): AgentHostSteeringMessage {
  return {
    producerId,
    idempotencyKey,
    userMessageId: `user-${idempotencyKey}` as AgentHostSteeringMessage['userMessageId'],
    message: { text },
    genuineUserQueryText: text,
    provenance: { source: 'api', routingFingerprint: `api:${idempotencyKey}` },
  };
}

function deferredVoid(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}
