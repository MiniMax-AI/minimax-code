import { describe, expect, it, vi } from 'vitest';

import type { LocalTaskRunnerHostWithSessionLookup } from '../../src/api/local-task-host.js';
import { logger } from '../../src/common/logger.js';
import { startLocalBackgroundTaskDeliveryTurn } from '../../src/background-task/delivery.js';
import type { BackgroundTask, BackgroundTaskStatus } from '../../src/background-task/domain.js';
import { admitBackgroundTask } from '../../src/background-task/lifecycle.js';
import { stopSessionBackgroundWork } from '../../src/background-task/session-cascade.js';
import { createUserStopCascade } from '../../src/background-task/user-stop-cascade.js';
import {
  isUserStopWindowOpen,
  openUserStopWindow,
} from '../../src/background-task/user-stop-suppression.js';
import type { LocalSessionRecord } from '../../src/sessions/controller.js';

const OWNER = 'session-owner';

describe('user stop cascade: delivery suppression', () => {
  it('holds a batch as retryable `busy` while the stop window is open', async () => {
    // `skipped` would be dequeued without a reschedule, permanently losing the
    // notice of a task that finished during the window but is not a target.
    const fixture = harness([terminalTask('task-a')]);
    const window = openUserStopWindow(fixture.host, OWNER, 1_000);

    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'task-a')).resolves.toBe(
      'busy',
    );
    expect(fixture.steer).not.toHaveBeenCalled();

    window.close();
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'task-a')).resolves.toBe(
      'delivered',
    );
  });

  it('delivers a non-target that finished during the window once the window closes', async () => {
    const fixture = harness([terminalTask('target'), terminalTask('newcomer')]);
    const window = openUserStopWindow(fixture.host, OWNER, 1_000);
    window.registerTargets(['target']);

    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'newcomer')).resolves.toBe(
      'busy',
    );
    window.close();

    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'newcomer')).resolves.toBe(
      'delivered',
    );
    expect(fixture.steer).toHaveBeenCalledTimes(1);
    expect(fixture.steer.mock.calls[0]![0].message.origin.taskIds).toEqual(['newcomer']);
  });

  it('never delivers a stopped target, even after the window closed', async () => {
    const fixture = harness([terminalTask('target')]);
    const window = openUserStopWindow(fixture.host, OWNER, 1_000);
    window.registerTargets(['target']);
    window.close();

    // `skipped`: the batch is empty after filtering, so a retry is pointless.
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'target')).resolves.toBe(
      'skipped',
    );
    expect(fixture.steer).not.toHaveBeenCalled();
  });

  it('keeps a suppressed target out of a mixed batch and out of origin.taskIds', async () => {
    const fixture = harness([terminalTask('target'), terminalTask('other')]);
    const window = openUserStopWindow(fixture.host, OWNER, 1_000);
    window.registerTargets(['target']);
    window.close();

    await expect(fixture.deliverBoth()).resolves.toBe('delivered');
    const origin = fixture.steer.mock.calls[0]![0].message.origin;
    expect(origin.taskIds).toEqual(['other']);
    expect(fixture.steer.mock.calls[0]![0].message.content).not.toContain('target');
  });

  it('leaves a suppressed terminal undelivered so the next reminder reports it', async () => {
    const fixture = harness([terminalTask('target')]);
    const window = openUserStopWindow(fixture.host, OWNER, 1_000);
    window.registerTargets(['target']);
    window.close();

    await startLocalBackgroundTaskDeliveryTurn(fixture.host, 'target');
    expect(fixture.tasks.get('target')!.deliveredAt).toBeUndefined();
  });
});

describe('user stop cascade: delivery recheck', () => {
  it('re-checks the stop window after its reads, right before handing the batch to ingress', async () => {
    // Gate 1 passed, then a user stop began while this batch awaited its reads.
    // Without the recheck the batch would reach ingress and wake the Session.
    const fixture = harness([terminalTask('late')]);
    const service = fixture.host.backgroundTaskService as unknown as {
      reminderSnapshot: () => Promise<unknown>;
    };
    let window: ReturnType<typeof openUserStopWindow> | undefined;
    service.reminderSnapshot = async () => {
      // Only the first read races the stop; the retry must see a closed window.
      window ??= openUserStopWindow(fixture.host, OWNER, 1_000);
      return { tasks: [], undeliveredTotal: 0, terminalTotal: 1 };
    };

    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'late')).resolves.toBe('busy');

    expect(fixture.steer).not.toHaveBeenCalled();
    expect(fixture.metrics).toHaveBeenCalledWith('background_task_delivery_suppressed_total', 1, {
      reason: 'user_stop_window_recheck',
    });
    window!.close();
    // Retryable: once the window closes the same batch is delivered.
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'late')).resolves.toBe(
      'delivered',
    );
  });
});

describe('user stop cascade: target collection', () => {
  it('targets running tasks and terminal tasks whose result was never delivered', async () => {
    const fixture = harness([
      runningTask('running'),
      terminalTask('undelivered'),
      { ...terminalTask('already-told'), deliveredAt: 5 },
    ]);
    fixture.admit('running');

    const { targets } = await cascade(fixture.host);

    expect(ids(targets)).toEqual(['running', 'undelivered']);
  });

  it('ignores work created after the stop boundary (collection rule)', async () => {
    const fixture = harness([
      { ...runningTask('before'), createdAt: 900 },
      { ...runningTask('after'), createdAt: 1_100 },
    ]);
    fixture.admit('before');
    fixture.admit('after');

    const { targets } = await cascade(fixture.host, { boundaryMs: 1_000 });

    expect(ids(targets)).toEqual(['before']);
    expect(fixture.tasks.get('after')!.status).toBe('running');
  });

  it('excludes foreground subagent rows, which the aborted Turn already settles', async () => {
    const fixture = harness([
      { ...runningTask('foreground'), kind: 'subagent', metadata: { executionMode: 'foreground' } },
      { ...runningTask('background'), kind: 'subagent', metadata: { executionMode: 'background' } },
    ]);
    fixture.admit('foreground');
    fixture.admit('background');

    const { targets } = await cascade(fixture.host);

    expect(ids(targets)).toEqual(['background']);
    expect(fixture.metrics).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      reason: 'cascade_skipped_not_owned',
    });
  });

  it('skips a non-terminal task this process does not own, leaving its row untouched', async () => {
    // Another client process sharing the data directory still runs it; writing
    // `canceled` here would lie about a task that keeps going over there.
    const fixture = harness([runningTask('foreign')]);

    const { targets } = await cascade(fixture.host);

    expect(targets).toEqual([]);
    expect(fixture.tasks.get('foreign')!.status).toBe('running');
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.metrics).toHaveBeenCalledWith('background_task_session_cascade_total', 1, {
      reason: 'cascade_skipped_not_owned',
    });
  });

  it('reports the re-read terminal state, so a task that finished normally is not "canceled"', async () => {
    const fixture = harness([runningTask('racing')]);
    fixture.admit('racing');
    // The task completes on its own while the stop is in flight.
    fixture.stop.mockImplementation(async (taskId: string) => {
      fixture.patch(taskId, 'succeeded');
      return fixture.tasks.get(taskId);
    });

    const { targets } = await cascade(fixture.host);

    expect(targets).toEqual([expect.objectContaining({ taskId: 'racing', status: 'succeeded' })]);
  });

  it('reports a stop that never settles as termination_requested without inventing a terminal', async () => {
    const fixture = harness([runningTask('stuck')]);
    fixture.admit('stuck');
    fixture.stop.mockImplementation(async () => undefined);

    const { targets } = await cascade(fixture.host);

    expect(targets).toEqual([
      expect.objectContaining({ taskId: 'stuck', status: 'termination_requested' }),
    ]);
  });

  it('stops the subagent first, then sweeps its child session with no time boundary', async () => {
    // The subagent's stop aborts its child Turn, so nothing new can appear in the
    // child Session afterwards. Work the child started while winding down — after
    // the root boundary — still belongs to the stopped tree and must be stopped.
    const fixture = harness([
      {
        ...runningTask('parent'),
        kind: 'subagent',
        metadata: { childSessionId: 'child', subTurnId: 'sub-turn-parent' },
      },
    ]);
    fixture.tasks.set('late-grandchild', {
      ...childTask('late-grandchild', 'child', 'sub-turn-parent'),
      createdAt: 20_000,
    });
    fixture.admit('parent');
    fixture.admit('late-grandchild');
    const order: string[] = [];
    fixture.stop.mockImplementation(async (taskId: string) => {
      order.push(taskId);
      fixture.patch(taskId, 'canceled');
      return fixture.tasks.get(taskId);
    });

    // Root boundary 10_000 is EARLIER than the grandchild's createdAt 20_000.
    const { targets } = await cascade(fixture.host, { boundaryMs: 10_000 });

    expect(order).toEqual(['parent', 'late-grandchild']);
    expect(fixture.tasks.get('late-grandchild')!.status).toBe('canceled');
    // Grandchild work lives in the child Session, which the model cannot read
    // from here, so it is stopped but not listed in the owner's report.
    expect(ids(targets)).toEqual(['parent']);
  });

  it('sweeps the child session of a subagent that already finished but was never read', async () => {
    // The subagent itself is terminal-undelivered, so there is nothing to stop,
    // but background work it spawned may still be running in its child Session.
    const fixture = harness([
      {
        ...terminalTask('finished-parent'),
        kind: 'subagent',
        metadata: { childSessionId: 'child', subTurnId: 'sub-turn-finished' },
      },
    ]);
    fixture.tasks.set('orphan', childTask('orphan', 'child', 'sub-turn-finished'));
    fixture.admit('orphan');

    const { targets } = await cascade(fixture.host);

    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect(fixture.stop).toHaveBeenCalledWith('orphan', expect.anything());
    expect(fixture.tasks.get('orphan')!.status).toBe('canceled');
    expect(ids(targets)).toEqual(['finished-parent']);
  });

  it('stops descending at the depth limit instead of recursing forever', async () => {
    const fixture = harness([]);
    fixture.tasks.set('deep', {
      ...runningTask('deep'),
      kind: 'subagent',
      metadata: { childSessionId: OWNER },
    });
    fixture.admit('deep');

    const { targets } = await cascade(fixture.host, { depth: 99 });

    expect(targets).toEqual([]);
    expect(fixture.stop).not.toHaveBeenCalled();
  });

  it('does not re-enter a session already on the cascade path (a metadata cycle)', async () => {
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([
        {
          ...runningTask('loop'),
          kind: 'subagent',
          metadata: { childSessionId: OWNER, subTurnId: 'sub-turn-loop' },
        },
      ]);
      fixture.admit('loop');
      fixture.stop.mockImplementation(async (taskId: string) => {
        fixture.patch(taskId, 'canceled');
        return fixture.tasks.get(taskId);
      });

      const { targets } = await cascade(fixture.host);

      expect(ids(targets)).toEqual(['loop']);
      expect(fixture.stop).toHaveBeenCalledTimes(1);
      // Caught by the recursion path, whatever child Turn scope it is reached with.
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_cascade_cycle_skipped',
          sessionId: OWNER,
          depth: 1,
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });
});

describe('user stop cascade: stale snapshot', () => {
  // Targets come from one snapshot, but a runner of ours can settle before the
  // ownership check. It drops its admission only after writing its terminal row, so
  // a target without admission is re-read: terminal means "just finished here";
  // still active, or gone, means nothing this process can stop.

  it('sweeps the child session of a subagent that settled after the snapshot', async () => {
    // Skipping it as "not owned" would leave the bash its child Turn spawned running
    // after the stop succeeded.
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([
        {
          ...runningTask('settled-sub'),
          kind: 'subagent',
          metadata: { childSessionId: 'child-x', subTurnId: 'sub-turn-x' },
        },
      ]);
      fixture.tasks.set('child-bash', childTask('child-bash', 'child-x', 'sub-turn-x'));
      // The subagent's own admission is already gone; the bash it spawned is still ours.
      fixture.admit('child-bash');
      afterSnapshot(fixture, () => fixture.patch('settled-sub', 'succeeded'));

      const { targets } = await cascade(fixture.host);

      expect(fixture.stop).toHaveBeenCalledTimes(1);
      expect(fixture.stop).toHaveBeenCalledWith('child-bash', expect.anything());
      expect(fixture.tasks.get('child-bash')!.status).toBe('canceled');
      expect(targets).toEqual([
        expect.objectContaining({ taskId: 'settled-sub', kind: 'subagent', status: 'succeeded' }),
      ]);
      expect(fixture.metrics).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        reason: 'cascade_skipped_not_owned',
      });
      expect(info).toHaveBeenCalledWith(
        {
          event: 'background_task_cascade_target_settled_before_stop',
          sessionId: OWNER,
          taskId: 'settled-sub',
          kind: 'subagent',
          snapshotStatus: 'running',
          status: 'succeeded',
        },
        expect.any(String),
      );
      expect(info).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'background_task_cascade_skipped_not_owned' }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it('still skips a target whose re-read row is active, without sweeping its child session', async () => {
    // Another client process holds it and moved it on (queued → running) meanwhile:
    // it is neither stopped nor swept, and the log carries the re-read status.
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([
        {
          ...runningTask('foreign-sub'),
          status: 'queued',
          kind: 'subagent',
          metadata: { childSessionId: 'child-f', subTurnId: 'sub-turn-f' },
        },
      ]);
      afterSnapshot(fixture, () => fixture.patch('foreign-sub', 'running'));

      const { targets } = await cascade(fixture.host);

      expect(targets).toEqual([]);
      expect(fixture.stop).not.toHaveBeenCalled();
      expect(fixture.list).not.toHaveBeenCalledWith(
        expect.objectContaining({ ownerSessionId: 'child-f' }),
      );
      expect(fixture.metrics).toHaveBeenCalledWith('background_task_session_cascade_total', 1, {
        reason: 'cascade_skipped_not_owned',
      });
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_cascade_skipped_not_owned',
          taskId: 'foreign-sub',
          status: 'running',
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it('skips a target whose row is gone by the re-read, logging it as missing', async () => {
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([runningTask('gone')]);
      afterSnapshot(fixture, () => {
        fixture.tasks.delete('gone');
      });

      const { targets } = await cascade(fixture.host);

      expect(targets).toEqual([]);
      expect(fixture.stop).not.toHaveBeenCalled();
      expect(fixture.metrics).toHaveBeenCalledWith('background_task_session_cascade_total', 1, {
        reason: 'cascade_skipped_not_owned',
      });
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_cascade_skipped_not_owned',
          taskId: 'gone',
          status: 'missing',
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it('falls back to the snapshot and still skips when the re-read fails', async () => {
    // A thrown re-read must not turn the skip into a reported stop
    // (`termination_requested`) for a task nobody asked to stop.
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([runningTask('unreadable')]);
      const service = fixture.host.backgroundTaskService as unknown as {
        get: (taskId: string) => Promise<BackgroundTask | undefined>;
      };
      service.get = async () => {
        throw new Error('store unavailable');
      };

      const { targets } = await cascade(fixture.host);

      expect(targets).toEqual([]);
      expect(fixture.stop).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_cascade_target_reread_failed',
          taskId: 'unreadable',
          error: 'store unavailable',
        }),
        expect.any(String),
      );
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_cascade_skipped_not_owned',
          taskId: 'unreadable',
          status: 'running',
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });
});

describe('user stop cascade: read subagents', () => {
  // A subagent the model already read (`deliveredAt` set) is not a target, but its
  // child Session is still swept as a fallback. The row itself is left alone.

  it('sweeps the child session of a read subagent without touching the row', async () => {
    const fixture = harness([
      {
        ...terminalTask('read-sub'),
        kind: 'subagent',
        deliveredAt: 5,
        metadata: { childSessionId: 'child-r', subTurnId: 'sub-turn-read' },
      },
    ]);
    fixture.tasks.set('orphan', childTask('orphan', 'child-r', 'sub-turn-read'));
    fixture.admit('orphan');
    const onTargets = vi.fn();

    const { targets } = await stopSessionBackgroundWork({
      host: fixture.host,
      sessionId: OWNER,
      reason: 'owner_abort',
      boundaryMs: 10_000,
      ctx: { depth: 0, visited: new Set<string>(), onTargets },
    });

    expect(fixture.tasks.get('orphan')!.status).toBe('canceled');
    // Not stopped, not suppressed, not reported: only its child Session is swept.
    expect(fixture.stop).not.toHaveBeenCalledWith('read-sub', expect.anything());
    expect(onTargets.mock.calls.flat(2)).not.toContain('read-sub');
    expect(ids(targets)).toEqual([]);
  });

  it('does not sweep a read subagent launched after the stop boundary', async () => {
    // The boundary protects work started by the user's next message.
    const fixture = harness([
      {
        ...terminalTask('new-read-sub'),
        kind: 'subagent',
        deliveredAt: 5,
        createdAt: 20_000,
        metadata: { childSessionId: 'child-n', subTurnId: 'sub-turn-new' },
      },
    ]);
    fixture.tasks.set('new-work', childTask('new-work', 'child-n', 'sub-turn-new'));
    fixture.admit('new-work');

    await cascade(fixture.host, { boundaryMs: 10_000 });

    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.tasks.get('new-work')!.status).toBe('running');
  });

  it('sweeps read subagents only after every target stop has settled', async () => {
    // Defense in depth: sweeps are keyed per owning child Turn, so a running
    // `append` target and the read row it continues no longer collide in the
    // visited set, but every target's "stop first, then sweep" still finishes
    // before any read row is traversed, keeping the order deterministic.
    const fixture = harness([
      runningTask('bg'),
      {
        ...terminalTask('read-sub'),
        kind: 'subagent',
        deliveredAt: 5,
        metadata: { childSessionId: 'child-r', subTurnId: 'sub-turn-read' },
      },
    ]);
    fixture.tasks.set('orphan', childTask('orphan', 'child-r', 'sub-turn-read'));
    fixture.admit('bg');
    fixture.admit('orphan');
    const order: string[] = [];
    fixture.stop.mockImplementation(async (taskId: string) => {
      if (taskId === 'bg') {
        await new Promise((resolve) => setTimeout(resolve, 30));
        fixture.patch(taskId, 'canceled');
        order.push('bg-settled');
        return fixture.tasks.get(taskId);
      }
      order.push(`${taskId}-stop`);
      fixture.patch(taskId, 'canceled');
      return fixture.tasks.get(taskId);
    });

    await cascade(fixture.host);

    expect(order).toEqual(['bg-settled', 'orphan-stop']);
  });
});

describe('user stop cascade: child session ownership', () => {
  // A child Session is shared by every subagent row that ran in it (an `append`
  // continues its source's), so a sweep stops only what the row's own child Turn
  // spawned: child-Session rows whose `parentTurnId` is the row's `subTurnId`.

  it('leaves work of a newer Turn that continued the same child session untouched', async () => {
    // `read-sub` ran child Turn sub-turn-0 in child-c. After the stop boundary the
    // user's next message appended to it: `append-new` runs sub-turn-2 in the SAME
    // child-c. Only sub-turn-0's work belongs to the stopped tree.
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([
        {
          ...terminalTask('read-sub'),
          kind: 'subagent',
          deliveredAt: 5,
          metadata: { childSessionId: 'child-c', subTurnId: 'sub-turn-0' },
        },
        {
          ...runningTask('append-new'),
          kind: 'subagent',
          createdAt: 20_000,
          metadata: {
            childSessionId: 'child-c',
            subTurnId: 'sub-turn-2',
            parentTurnId: 'turn-next',
            executionMode: 'append',
          },
        },
      ]);
      fixture.tasks.set('bash-old', childTask('bash-old', 'child-c', 'sub-turn-0'));
      fixture.tasks.set('bash-new', {
        ...childTask('bash-new', 'child-c', 'sub-turn-2'),
        createdAt: 20_000,
      });
      for (const id of ['append-new', 'bash-old', 'bash-new']) fixture.admit(id);
      const onTargets = vi.fn();

      await stopSessionBackgroundWork({
        host: fixture.host,
        sessionId: OWNER,
        reason: 'owner_abort',
        boundaryMs: 10_000,
        ctx: { depth: 0, visited: new Set<string>(), onTargets },
      });

      expect(fixture.tasks.get('bash-old')!.status).toBe('canceled');
      expect(fixture.tasks.get('bash-new')!.status).toBe('running');
      expect(fixture.tasks.get('append-new')!.status).toBe('running');
      expect(fixture.stop).not.toHaveBeenCalledWith('bash-new', expect.anything());
      expect(fixture.stop).not.toHaveBeenCalledWith('append-new', expect.anything());
      // Not suppressed either: the newer Turn's results must still be delivered.
      const registered = onTargets.mock.calls.flat(2);
      expect(registered).toContain('bash-old');
      expect(registered).not.toContain('bash-new');
      expect(registered).not.toContain('append-new');
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_cascade_child_sweep_scoped',
          childSessionId: 'child-c',
          ownerTurnId: 'sub-turn-0',
          parentTaskId: 'read-sub',
          matched: 1,
          skippedOtherTurn: 1,
          skippedMissingOwner: 0,
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it("stops a running subagent first, then only its own child Turn's work, however late", async () => {
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([
        {
          ...runningTask('sub'),
          kind: 'subagent',
          metadata: { childSessionId: 'child-t', subTurnId: 'sub-turn-t' },
        },
      ]);
      // Spawned by the subagent's own child Turn while it wound down, after the
      // root boundary: ownership, not time, bounds the child sweep.
      fixture.tasks.set('own-late', {
        ...childTask('own-late', 'child-t', 'sub-turn-t'),
        createdAt: 20_000,
      });
      // Same child Session, other child Turn, created well BEFORE the boundary:
      // only ownership keeps it out.
      fixture.tasks.set('other-turn', childTask('other-turn', 'child-t', 'sub-turn-other'));
      // No owner recorded: cannot be attributed to this row, so never stopped.
      fixture.tasks.set('no-owner', childTask('no-owner', 'child-t'));
      for (const id of ['sub', 'own-late', 'other-turn', 'no-owner']) fixture.admit(id);
      const order: string[] = [];
      fixture.stop.mockImplementation(async (taskId: string) => {
        order.push(taskId);
        fixture.patch(taskId, 'canceled');
        return fixture.tasks.get(taskId);
      });
      const onTargets = vi.fn();

      const { targets } = await stopSessionBackgroundWork({
        host: fixture.host,
        sessionId: OWNER,
        reason: 'owner_abort',
        boundaryMs: 10_000,
        ctx: { depth: 0, visited: new Set<string>(), onTargets },
      });

      expect(order).toEqual(['sub', 'own-late']);
      expect(fixture.tasks.get('other-turn')!.status).toBe('running');
      expect(fixture.tasks.get('no-owner')!.status).toBe('running');
      expect(onTargets.mock.calls.flat(2)).toEqual(['sub', 'own-late']);
      expect(ids(targets)).toEqual(['sub']);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_cascade_child_sweep_scoped',
          childSessionId: 'child-t',
          ownerTurnId: 'sub-turn-t',
          parentTaskId: 'sub',
          matched: 1,
          skippedOtherTurn: 1,
          skippedMissingOwner: 1,
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it('does not sweep the child session of a row without subTurnId, and logs why', async () => {
    // Without the child Turn's id this row's work cannot be told apart from a
    // continuation's, so its child Session is left exactly as it is today.
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([
        { ...runningTask('legacy'), kind: 'subagent', metadata: { childSessionId: 'child-l' } },
      ]);
      fixture.tasks.set('child-work', childTask('child-work', 'child-l', 'sub-turn-unknown'));
      fixture.admit('legacy');
      fixture.admit('child-work');

      const { targets } = await cascade(fixture.host);

      // The row itself is still a target and is stopped; only the sweep is skipped.
      expect(ids(targets)).toEqual(['legacy']);
      expect(fixture.tasks.get('legacy')!.status).toBe('canceled');
      expect(fixture.tasks.get('child-work')!.status).toBe('running');
      expect(fixture.stop).not.toHaveBeenCalledWith('child-work', expect.anything());
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_cascade_child_sweep_skipped',
          sessionId: OWNER,
          taskId: 'legacy',
          childSessionId: 'child-l',
          reason: 'missing_sub_turn_id',
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it('sweeps a shared child session once per owning child Turn', async () => {
    // `append-old` (before the boundary, still running) continues `read-sub`'s
    // child Session; each ran its own child Turn there and left work behind. A
    // per-Session visited key would skip the second sweep and leave `bash-o` alive.
    const fixture = harness([
      {
        ...runningTask('append-old'),
        kind: 'subagent',
        metadata: { childSessionId: 'child-s', subTurnId: 'sub-turn-a', executionMode: 'append' },
      },
      {
        ...terminalTask('read-sub'),
        kind: 'subagent',
        deliveredAt: 5,
        metadata: { childSessionId: 'child-s', subTurnId: 'sub-turn-o' },
      },
    ]);
    fixture.tasks.set('bash-a', childTask('bash-a', 'child-s', 'sub-turn-a'));
    fixture.tasks.set('bash-o', childTask('bash-o', 'child-s', 'sub-turn-o'));
    for (const id of ['append-old', 'bash-a', 'bash-o']) fixture.admit(id);

    const { targets } = await cascade(fixture.host);

    expect(fixture.tasks.get('bash-a')!.status).toBe('canceled');
    expect(fixture.tasks.get('bash-o')!.status).toBe('canceled');
    expect(ids(targets)).toEqual(['append-old']);
  });
});

describe('user stop cascade: orchestration', () => {
  it('does not cascade, open a window or pause the Goal for a child worker session', async () => {
    const fixture = harness([runningTask('child-task')]);
    fixture.session = childWorkerSession();
    const pauseActiveGoal = vi.fn(async () => undefined);

    const handle = await createUserStopCascade({ host: fixture.host, pauseActiveGoal }).begin(
      OWNER,
    );

    expect(handle).toBeUndefined();
    expect(pauseActiveGoal).not.toHaveBeenCalled();
    // Delivery for that Session is untouched, exactly like today.
    expect(fixture.stop).not.toHaveBeenCalled();
  });

  it('does not pause the Goal in begin, only once the stop is accepted', async () => {
    // `begin` runs before the controller's identity check; a stop it then rejects
    // (turn-mismatch) must leave the Goal exactly as it was.
    const fixture = harness([]);
    const pauseActiveGoal = vi.fn(async () => undefined);
    const handle = await createUserStopCascade({ host: fixture.host, pauseActiveGoal }).begin(
      OWNER,
    );
    expect(pauseActiveGoal).not.toHaveBeenCalled();

    await handle!.accept('controller_accepted');
    // Idempotent: the Goal is paused once however many paths accept the stop.
    await handle!.accept('controller_accepted');

    expect(pauseActiveGoal).toHaveBeenCalledTimes(1);
    expect(pauseActiveGoal).toHaveBeenCalledWith(OWNER);
    handle!.cancel('test_cleanup');
  });

  it('never pauses the Goal for a stop that was cancelled', async () => {
    const fixture = harness([]);
    const pauseActiveGoal = vi.fn(async () => undefined);
    const handle = await createUserStopCascade({ host: fixture.host, pauseActiveGoal }).begin(
      OWNER,
    );

    handle!.cancel('turn_mismatch');
    await handle!.accept('controller_accepted');

    expect(pauseActiveGoal).not.toHaveBeenCalled();
  });

  it('resolves accept and logs when pausing the Goal fails', async () => {
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([]);
      const pauseActiveGoal = vi.fn(async () => {
        throw new Error('goal store unavailable');
      });
      const handle = await createUserStopCascade({ host: fixture.host, pauseActiveGoal }).begin(
        OWNER,
      );

      await expect(handle!.accept('not_running')).resolves.toBeUndefined();

      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_user_stop_cascade_accepted',
          sessionId: OWNER,
          how: 'not_running',
        }),
        expect.any(String),
      );
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_user_stop_cascade_goal_pause_failed',
          sessionId: OWNER,
          error: 'goal store unavailable',
        }),
        expect.any(String),
      );
      handle!.cancel('test_cleanup');
    } finally {
      info.mockRestore();
    }
  });

  it('pauses the Goal on accept before the cascade stops any task', async () => {
    const fixture = harness([runningTask('bg')]);
    fixture.admit('bg');
    const order: string[] = [];
    const pauseActiveGoal = vi.fn(async () => {
      order.push('goal-paused');
    });
    fixture.stop.mockImplementation(async (taskId: string) => {
      order.push('task-stopped');
      fixture.patch(taskId, 'canceled');
      return fixture.tasks.get(taskId);
    });

    const handle = await createUserStopCascade({ host: fixture.host, pauseActiveGoal }).begin(
      OWNER,
    );
    // TurnService's order: accept (onAccepted / not-running), then complete.
    await handle!.accept('controller_accepted');
    handle!.complete({ status: 'aborted', turnId: 'turn-1' });
    await vi.waitFor(() => expect(order).toContain('task-stopped'));

    expect(order).toEqual(['goal-paused', 'task-stopped']);
  });

  it('still suppresses the targets after an abort timeout', async () => {
    const fixture = harness([runningTask('bg')]);
    fixture.admit('bg');
    fixture.stop.mockImplementation(async (taskId: string) => {
      fixture.patch(taskId, 'canceled');
      return fixture.tasks.get(taskId);
    });

    const handle = await createUserStopCascade({ host: fixture.host }).begin(OWNER);
    handle!.complete({ status: 'abort-timeout', turnId: 'turn-1' });
    await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalled());

    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'bg')).resolves.toBe('skipped');
  });

  it('warns that the boundary may precede the release on an abort timeout, not on a clean abort', async () => {
    // Known limit: on `abort-timeout` the stopped Turn has not released when the
    // boundary is taken, so its later wind-down work is neither stopped nor
    // suppressed (exactly today's behaviour). The warning makes that visible.
    const warn = vi.spyOn(logger, 'warn');
    try {
      const fixture = harness([]);
      fixture.now = 1_234;
      const port = createUserStopCascade({ host: fixture.host });

      const clean = await port.begin(OWNER);
      clean!.complete({ status: 'aborted', turnId: 'turn-1' });
      const timedOut = await port.begin(OWNER);
      timedOut!.complete({ status: 'abort-timeout', turnId: 'turn-2' });
      await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));

      const boundaryWarnings = warn.mock.calls.filter(
        ([fields]) =>
          (fields as { event?: string }).event ===
          'background_task_user_stop_cascade_boundary_before_release',
      );
      expect(boundaryWarnings).toEqual([
        [
          {
            event: 'background_task_user_stop_cascade_boundary_before_release',
            sessionId: OWNER,
            boundaryMs: 1_234,
            turnId: 'turn-2',
          },
          expect.any(String),
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('runs repeated stops of the same session one after another, idempotently', async () => {
    const fixture = harness([runningTask('bg')]);
    fixture.admit('bg');
    fixture.stop.mockImplementation(async (taskId: string) => {
      fixture.patch(taskId, 'canceled');
      return fixture.tasks.get(taskId);
    });
    const cascadePort = createUserStopCascade({ host: fixture.host });

    const first = await cascadePort.begin(OWNER);
    const second = await cascadePort.begin(OWNER);
    first!.complete({ status: 'aborted', turnId: 'turn-1' });
    second!.complete({ status: 'aborted', turnId: 'turn-1' });
    await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));

    // The second cascade still runs, but the task is already terminal by then:
    // it is re-reported, never stopped twice.
    expect(fixture.stop).toHaveBeenCalledTimes(1);
  });

  it('queues a second stop behind the first and runs it with its own boundary', async () => {
    // Stop 1 is still cascading when the user sends a new message, the new Turn
    // starts background work, and the user stops again. Joining stop 1 would drop
    // stop 2's later boundary and leave that new work running.
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([runningTask('first')]);
      fixture.admit('first');
      let releaseFirst!: () => void;
      fixture.stop.mockImplementation((taskId: string) => {
        if (taskId !== 'first') {
          fixture.patch(taskId, 'canceled');
          return Promise.resolve(fixture.tasks.get(taskId));
        }
        return new Promise((resolve) => {
          releaseFirst = () => {
            fixture.patch(taskId, 'canceled');
            resolve(fixture.tasks.get(taskId));
          };
        });
      });
      const port = createUserStopCascade({ host: fixture.host });

      fixture.now = 1_000;
      const firstStop = await port.begin(OWNER);
      firstStop!.complete({ status: 'aborted', turnId: 'turn-1' });
      await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalledWith('first', expect.anything()));

      // Created after stop 1's boundary (1000) but before stop 2's (1200).
      fixture.now = 1_050;
      fixture.tasks.set('second', { ...runningTask('second'), createdAt: 1_050 });
      fixture.admit('second');
      fixture.now = 1_200;
      const secondStop = await port.begin(OWNER);
      secondStop!.complete({ status: 'aborted', turnId: 'turn-2' });

      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_user_stop_cascade_queued',
          sessionId: OWNER,
          boundaryMs: 1_200,
        }),
        expect.any(String),
      );
      // Queued, not joined: nothing happens to it until stop 1 settles.
      expect(fixture.stop).not.toHaveBeenCalledWith('second', expect.anything());

      releaseFirst();

      await vi.waitFor(() => expect(fixture.tasks.get('second')!.status).toBe('canceled'));
      await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));
      await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'second')).resolves.toBe(
        'skipped',
      );
    } finally {
      info.mockRestore();
    }
  });

  it('targets work the dying Turn created after the stop was accepted', async () => {
    // The boundary is taken when `complete` runs, not when `begin` runs. Background
    // bash and background subagents do not observe the parent Turn's signal, so a
    // tool call still in flight can insert a row after the stop request returned.
    // Reading the boundary in `begin` would leave that row unstopped and let its
    // terminal wake the Session later.
    const fixture = harness([]);
    fixture.now = 1_000;
    fixture.stop.mockImplementation(async (taskId: string) => {
      fixture.patch(taskId, 'canceled');
      return fixture.tasks.get(taskId);
    });

    const handle = await createUserStopCascade({ host: fixture.host }).begin(OWNER);
    // The aborted Turn is still winding down and starts one more background task.
    fixture.now = 1_005;
    fixture.tasks.set('late', { ...runningTask('late'), createdAt: 1_005 });
    fixture.admit('late');

    fixture.now = 1_010;
    handle!.complete({ status: 'aborted', turnId: 'turn-1' });
    await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalled());

    expect(fixture.tasks.get('late')!.status).toBe('canceled');
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'late')).resolves.toBe(
      'skipped',
    );
  });

  it('leaves stopped targets undelivered so the next background reminder reports them', async () => {
    // This is how the model learns the tasks were stopped: the existing cadence
    // reminder lists undelivered terminals with their real status (`canceled`).
    // Latching them as delivered here would silently hide that from the model.
    const fixture = harness([runningTask('bg')]);
    fixture.admit('bg');
    fixture.stop.mockImplementation(async (taskId: string) => {
      fixture.patch(taskId, 'canceled');
      return fixture.tasks.get(taskId);
    });

    const handle = await createUserStopCascade({ host: fixture.host }).begin(OWNER);
    handle!.complete({ status: 'aborted', turnId: 'turn-1' });
    await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalled());

    expect(fixture.markDelivered).not.toHaveBeenCalled();
    expect(fixture.tasks.get('bg')!.deliveredAt).toBeUndefined();
    expect(fixture.tasks.get('bg')!.status).toBe('canceled');
  });

  it('closes the window and suppresses nothing extra when collecting targets throws', async () => {
    const fixture = harness([]);
    fixture.list.mockRejectedValue(new Error('store unavailable'));

    const handle = await createUserStopCascade({ host: fixture.host }).begin(OWNER);
    handle!.complete({ status: 'aborted', turnId: 'turn-1' });

    // The window must reopen, otherwise unrelated tasks would never be announced.
    fixture.list.mockResolvedValue({ items: [] });
    fixture.tasks.set('fresh', terminalTask('fresh'));
    await vi.waitFor(async () => {
      await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'fresh')).resolves.toBe(
        'delivered',
      );
    });
  });

  it('returns from `complete` without waiting for a stop that never resolves', async () => {
    const fixture = harness([runningTask('hung')]);
    fixture.admit('hung');
    fixture.stop.mockImplementation(() => new Promise<never>(() => undefined));

    const handle = await createUserStopCascade({ host: fixture.host }).begin(OWNER);
    const startedAt = Date.now();
    handle!.complete({ status: 'aborted', turnId: 'turn-1' });

    // `complete` is fire-and-forget: the stop request never waits for teardown.
    expect(Date.now() - startedAt).toBeLessThan(200);
    await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalled());
    // The hung task is suppressed immediately, before its stop settles.
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'hung')).resolves.toBe(
      'skipped',
    );
  });
});

describe('user stop cascade: window lifecycle', () => {
  // A window that never closes holds every later completion notice of the Session
  // as `busy` for the life of the process — worse than having no cascade at all.
  // Each test below pins one path that used to be able to leave it open.

  it('releases the window when the stop is cancelled, so later work is delivered', async () => {
    const fixture = harness([terminalTask('later')]);
    const handle = await createUserStopCascade({ host: fixture.host }).begin(OWNER);
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'later')).resolves.toBe('busy');

    handle!.cancel('abort_failed');

    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'later')).resolves.toBe(
      'delivered',
    );
    // A cancelled stop never cascades: nothing may be stopped.
    expect(fixture.stop).not.toHaveBeenCalled();
  });

  it('releases a queued handle once its own cascade ends', async () => {
    const fixture = harness([runningTask('bg')]);
    fixture.admit('bg');
    let finishStop!: () => void;
    fixture.stop.mockImplementation(
      (taskId: string) =>
        new Promise((resolve) => {
          finishStop = () => {
            fixture.patch(taskId, 'canceled');
            resolve(fixture.tasks.get(taskId));
          };
        }),
    );
    const port = createUserStopCascade({ host: fixture.host });

    const first = await port.begin(OWNER);
    first!.complete({ status: 'aborted', turnId: 'turn-1' });
    await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalled());
    // A second stop arrives while the first cascade is still running: it is
    // queued, and its window must stay held until its own cascade has run.
    const second = await port.begin(OWNER);
    second!.complete({ status: 'aborted', turnId: 'turn-1' });
    expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(true);

    finishStop();

    await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));
  });

  it('keeps the window open until every hold is released', () => {
    const fixture = harness([]);
    const first = openUserStopWindow(fixture.host, OWNER, 1_000);
    const second = openUserStopWindow(fixture.host, OWNER, 1_000);

    first.close();
    expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(true);
    // Idempotent: closing the same handle again must not drop the other hold.
    first.close();
    expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(true);

    second.close();
    expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false);
  });

  it('force-closes a window nobody released after the watchdog period, and warns', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn');
    try {
      const fixture = harness([]);
      // Held but never completed nor cancelled: the unforeseen-path case.
      const handle = await createUserStopCascade({ host: fixture.host }).begin(OWNER);
      expect(handle).toBeDefined();
      expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(true);

      vi.advanceTimersByTime(59_999);
      expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(true);
      vi.advanceTimersByTime(1);

      expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_user_stop_window_watchdog_closed',
          sessionId: OWNER,
          reason: 'watchdog',
        }),
        expect.any(String),
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function cascade(
  host: LocalTaskRunnerHostWithSessionLookup,
  options: { boundaryMs?: number; depth?: number } = {},
): ReturnType<typeof stopSessionBackgroundWork> {
  return stopSessionBackgroundWork({
    host,
    sessionId: OWNER,
    reason: 'owner_abort',
    boundaryMs: options.boundaryMs ?? 10_000,
    ctx: { depth: options.depth ?? 0, visited: new Set<string>() },
  });
}

function ids(targets: readonly { taskId: string }[]): string[] {
  return targets.map((target) => target.taskId).sort();
}

/**
 * Applies `change` once, right after the cascade took its snapshot: the window in
 * which a runner can settle, or a row vanish, before the ownership check. A
 * cascade issues all of its collection reads together, so each one still sees the
 * state from before the change.
 */
function afterSnapshot(fixture: ReturnType<typeof harness>, change: () => void): void {
  const read = fixture.list.getMockImplementation()!;
  let changed = false;
  fixture.list.mockImplementation(async (query) => {
    const snapshot = await read(query);
    if (!changed) {
      changed = true;
      change();
    }
    return snapshot;
  });
}

function harness(initial: readonly BackgroundTask[]) {
  const tasks = new Map<string, BackgroundTask>(initial.map((task) => [task.taskId, task]));
  const steer = vi.fn(async (_input: SteerInput) => ({ turnId: 'turn-owner', mode: 'steered' }));
  const markDelivered = vi.fn(async (ownerSessionId: string, taskIds: string[]) => {
    for (const taskId of taskIds) {
      const task = tasks.get(taskId);
      if (task && task.ownerSessionId === ownerSessionId) task.deliveredAt = 9_999;
    }
    return [];
  });
  const stop = vi.fn(async (taskId: string) => {
    patch(taskId, 'canceled');
    return tasks.get(taskId);
  });
  const list = vi.fn(async (query: { ownerSessionId?: string; statuses?: string[] }) => ({
    items: [...tasks.values()].filter(
      (task) =>
        task.ownerSessionId === query.ownerSessionId &&
        (!query.statuses || query.statuses.includes(task.status)),
    ),
  }));
  const metrics = vi.fn();

  function patch(taskId: string, status: BackgroundTaskStatus): void {
    const task = tasks.get(taskId);
    if (task) tasks.set(taskId, { ...task, status, endedAt: 2_000 });
  }

  const fixture = {
    tasks,
    steer,
    stop,
    list,
    markDelivered,
    metrics,
    patch,
    /** Mutable so a test can place task creation before/after the stop boundary. */
    now: 1_000,
    session: rootSession() as LocalSessionRecord,
    admit(taskId: string) {
      admitBackgroundTask(fixture.host).identify(taskId);
    },
    deliverBoth: () =>
      startLocalBackgroundTaskDeliveryTurn(fixture.host, 'other').then((result) => result),
    host: undefined as unknown as LocalTaskRunnerHostWithSessionLookup,
  };

  fixture.host = {
    runtimeConversation: { ingress: { steer } },
    backgroundTaskService: {
      get: async (taskId: string) => tasks.get(taskId),
      list,
      stop,
      markDelivered,
      reminderSnapshot: async () => ({ tasks: [], undeliveredTotal: 0, terminalTotal: 1 }),
    },
    metricsClient: { counter: metrics },
    nowMs: () => fixture.now,
    getSessionById: async () => fixture.session,
  } as unknown as LocalTaskRunnerHostWithSessionLookup;

  return fixture;
}

interface SteerInput {
  readonly message: {
    readonly content: string;
    readonly origin: { readonly taskIds: readonly string[] };
  };
}

function rootSession(): Partial<LocalSessionRecord> {
  return { sessionId: OWNER, sessionType: 'root', visibility: 'visible' };
}

function childWorkerSession(): LocalSessionRecord {
  return {
    sessionId: OWNER,
    sessionType: 'branch',
    parentSessionId: 'parent',
    visibility: 'hidden',
    sessionKind: 'task',
  } as unknown as LocalSessionRecord;
}

function runningTask(taskId: string): BackgroundTask {
  return {
    taskId,
    kind: 'bash',
    status: 'running',
    ownerSessionId: OWNER,
    description: `run ${taskId}`,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function terminalTask(taskId: string): BackgroundTask {
  return {
    taskId,
    kind: 'bash',
    status: 'succeeded',
    ownerSessionId: OWNER,
    description: `done ${taskId}`,
    createdAt: 1_000,
    updatedAt: 2_000,
    endedAt: 2_000,
  };
}

/**
 * A running task in a subagent's child Session. `parentTurnId` is the child Turn
 * that spawned it — what a real runner records from `toolCtx.turnId`.
 */
function childTask(taskId: string, childSessionId: string, parentTurnId?: string): BackgroundTask {
  return {
    ...runningTask(taskId),
    ownerSessionId: childSessionId,
    ...(parentTurnId ? { metadata: { parentTurnId } } : {}),
  };
}
