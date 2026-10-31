import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConversationStopConfigRead } from '@mavis/config';
import { describe, expect, it, vi } from 'vitest';

import type { LocalTaskRunnerHostWithSessionLookup } from '../../src/api/local-task-host.js';
import { logger } from '../../src/common/logger.js';
import { startLocalBackgroundTaskDeliveryTurn } from '../../src/background-task/delivery.js';
import type { BackgroundTask, BackgroundTaskStatus } from '../../src/background-task/domain.js';
import { admitBackgroundTask } from '../../src/background-task/lifecycle.js';
import { stopSessionBackgroundWork } from '../../src/background-task/session-cascade.js';
import {
  createUserStopCascade,
  type UserStopCascadeDependencies,
} from '../../src/background-task/user-stop-cascade.js';
import type { CascadeKindPolicy } from '../../src/background-task/user-stop-policy.js';
import {
  isUserStopWindowOpen,
  openUserStopWindow,
} from '../../src/background-task/user-stop-suppression.js';
import type { LocalSessionRecord } from '../../src/sessions/controller.js';

const OWNER = 'session-owner';

/**
 * Every stop in these tests says which user-stop switches it runs with, instead
 * of reading the developer's real config.yaml (the default reader resolves
 * `getConfigPath()`). `STOP_ALL` is the behaviour the older cases were written for.
 */
const STOP_ALL = stopPolicy(true, true);
const STOP_DEFAULT = stopPolicy(false, true);
const STOP_NONE = stopPolicy(false, false);

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
  it('closes the provisional window and stops nothing for a child worker session', async () => {
    const fixture = harness([runningTask('child-task')]);
    fixture.session = childWorkerSession();
    const pauseActiveGoal = vi.fn(async () => undefined);

    const handle = userStop(fixture, { pauseActiveGoal }).begin(OWNER);

    expect(handle).toBeDefined();
    expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(true);
    await handle!.accept('controller_accepted');
    expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false);
    expect(pauseActiveGoal).not.toHaveBeenCalled();
    // Delivery for that Session is untouched, exactly like today.
    expect(fixture.stop).not.toHaveBeenCalled();
    handle!.complete({ status: 'not-running' });
  });

  it('does not pause the Goal in begin, only once the stop is accepted', async () => {
    // `begin` runs before the controller's identity check; a stop it then rejects
    // (turn-mismatch) must leave the Goal exactly as it was.
    const fixture = harness([]);
    const pauseActiveGoal = vi.fn(async () => undefined);
    const handle = await userStop(fixture, { pauseActiveGoal }).begin(
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
    const handle = await userStop(fixture, { pauseActiveGoal }).begin(
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
      const handle = await userStop(fixture, { pauseActiveGoal }).begin(
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

    const handle = await userStop(fixture, { pauseActiveGoal }).begin(
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

    const handle = await userStop(fixture).begin(OWNER);
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
      const port = userStop(fixture);

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
    const cascadePort = userStop(fixture);

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
      const port = userStop(fixture);

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

    const handle = await userStop(fixture).begin(OWNER);
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

    const handle = await userStop(fixture).begin(OWNER);
    handle!.complete({ status: 'aborted', turnId: 'turn-1' });
    await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalled());

    expect(fixture.markDelivered).not.toHaveBeenCalled();
    expect(fixture.tasks.get('bg')!.deliveredAt).toBeUndefined();
    expect(fixture.tasks.get('bg')!.status).toBe('canceled');
  });

  it('closes the window and suppresses nothing extra when collecting targets throws', async () => {
    const fixture = harness([]);
    fixture.list.mockRejectedValue(new Error('store unavailable'));

    const handle = await userStop(fixture).begin(OWNER);
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

    const handle = await userStop(fixture).begin(OWNER);
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

describe('user stop cascade: identity at arrival', () => {
  it('opens the window before begin returns while the Session lookup is pending', async () => {
    const fixture = harness([]);
    const lookup = pendingSessionLookup(fixture);

    const handle = userStop(fixture).begin(OWNER);

    expect(handle).toBeDefined();
    expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(true);
    lookup.resolve(fixture.session);
    await handle!.accept('controller_accepted');
    handle!.cancel('test_cleanup');
  });

  it('closes the window without pausing a Goal when the Session is missing', async () => {
    const fixture = harness([]);
    const lookup = pendingSessionLookup(fixture);
    const pauseActiveGoal = vi.fn(async () => undefined);
    const handle = userStop(fixture, { pauseActiveGoal }).begin(OWNER);

    lookup.resolve(undefined);
    await handle!.accept('not_running');

    expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false);
    expect(pauseActiveGoal).not.toHaveBeenCalled();
    handle!.complete({ status: 'not-running' });
  });

  it('closes the window without pausing a Goal when the Session lookup fails', async () => {
    const fixture = harness([]);
    const lookup = pendingSessionLookup(fixture);
    const pauseActiveGoal = vi.fn(async () => undefined);
    const handle = userStop(fixture, { pauseActiveGoal }).begin(OWNER);

    lookup.reject(new Error('session store unavailable'));
    await handle!.accept('not_running');

    expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false);
    expect(pauseActiveGoal).not.toHaveBeenCalled();
    handle!.complete({ status: 'not-running' });
  });

  it('keeps a boundary marked before the Session lookup resolved', async () => {
    const fixture = harness([runningTask('bg')]);
    fixture.admit('bg');
    const lookup = pendingSessionLookup(fixture);
    fixture.now = 1_000;
    const handle = userStop(fixture).begin(OWNER);

    handle!.markBoundary('released');
    handle!.complete({ status: 'aborted', turnId: 'turn-1' });
    fixture.now = 2_000;
    lookup.resolve(fixture.session);

    await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalledWith('bg', expect.anything()));
  });

  it('queues two completes before the lookup resolves with their own boundaries', async () => {
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([runningTask('bg')]);
      fixture.admit('bg');
      const lookup = pendingSessionLookup(fixture);
      const port = userStop(fixture);
      fixture.now = 1_000;
      const first = port.begin(OWNER);
      first!.markBoundary('released');
      fixture.now = 2_000;
      const second = port.begin(OWNER);
      second!.markBoundary('released');
      first!.complete({ status: 'aborted', turnId: 'turn-1' });
      second!.complete({ status: 'aborted', turnId: 'turn-2' });
      lookup.resolve(fixture.session);

      await vi.waitFor(() => {
        const boundaries = info.mock.calls
          .map(([fields]) => fields as { event?: string; boundaryMs?: number })
          .filter(({ event }) => event === 'background_task_user_stop_cascade_started')
          .map(({ boundaryMs }) => boundaryMs);
        expect(boundaries).toEqual([1_000, 2_000]);
      });
    } finally {
      info.mockRestore();
    }
  });

  it('keeps both switches off synchronously and pauses the Goal after root scope resolves', async () => {
    const fixture = harness([]);
    const lookup = pendingSessionLookup(fixture);
    const pauseActiveGoal = vi.fn(async () => undefined);
    const handle = userStop(fixture, { pauseActiveGoal, readStopPolicy: () => STOP_NONE }).begin(
      OWNER,
    );

    expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false);
    const accepted = handle!.accept('controller_accepted');
    expect(pauseActiveGoal).not.toHaveBeenCalled();
    lookup.resolve(fixture.session);
    await accepted;
    expect(pauseActiveGoal).toHaveBeenCalledOnce();
    handle!.complete({ status: 'not-running' });
  });

  it('logs the policy only after root scope resolves', async () => {
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([]);
      const lookup = pendingSessionLookup(fixture);
      const handle = userStop(fixture).begin(OWNER);

      expect(info).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'background_task_user_stop_cascade_policy' }),
        expect.any(String),
      );
      lookup.resolve(fixture.session);
      await vi.waitFor(() =>
        expect(info).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'background_task_user_stop_cascade_policy' }),
          expect.any(String),
        ),
      );
      handle!.cancel('test_cleanup');
    } finally {
      info.mockRestore();
    }
  });
});

describe('user stop cascade: boundary at release', () => {
  // Neither the abort nor the Goal pause after it holds the Session lock, so the
  // stopped Turn can release and the next Turn start while the stop is still
  // pausing the Goal. The boundary is fixed at that release (or at `not-running`),
  // so the next Turn's work is never stopped or suppressed by the older stop.

  it("excludes the next Turn's work once the stopped Turn released", async () => {
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([runningTask('old')]);
      fixture.admit('old');
      fixture.now = 1_000;
      const handle = await userStop(fixture).begin(OWNER);
      // Still winding down, the stopped Turn starts one more task: a target.
      fixture.now = 1_050;
      fixture.tasks.set('old-late', { ...runningTask('old-late'), createdAt: 1_050 });
      fixture.admit('old-late');
      // It releases the Session while the stop is still pausing the Goal.
      fixture.now = 1_100;
      handle!.markBoundary('released');
      // The next Turn is admitted meanwhile and starts its own background work.
      fixture.now = 1_150;
      fixture.tasks.set('next-running', { ...runningTask('next-running'), createdAt: 1_150 });
      fixture.admit('next-running');
      fixture.tasks.set('next-done', { ...terminalTask('next-done'), createdAt: 1_160 });
      fixture.now = 1_200;
      handle!.complete({ status: 'aborted', turnId: 'turn-1' });
      await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));

      expect(fixture.tasks.get('old')!.status).toBe('canceled');
      expect(fixture.tasks.get('old-late')!.status).toBe('canceled');
      expect(fixture.tasks.get('next-running')!.status).toBe('running');
      expect(fixture.stop).not.toHaveBeenCalledWith('next-running', expect.anything());
      // Not suppressed either: the next Turn's result is still delivered.
      await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'next-done')).resolves.toBe(
        'delivered',
      );
      expect(fixture.steer.mock.calls[0]![0].message.origin.taskIds).toEqual(['next-done']);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_user_stop_cascade_boundary_fixed',
          sessionId: OWNER,
          boundarySource: 'released',
          boundaryMs: 1_100,
        }),
        expect.any(String),
      );
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_user_stop_cascade_started',
          sessionId: OWNER,
          boundaryMs: 1_100,
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it('excludes work started after a not-running stop fixed its boundary', async () => {
    // The Turn already finished, but the background work it started still runs.
    const fixture = harness([{ ...runningTask('leftover'), createdAt: 900 }]);
    fixture.admit('leftover');
    fixture.now = 1_000;
    const handle = await userStop(fixture).begin(OWNER);
    handle!.markBoundary('not_running');
    // While the stop pauses the Goal, a new Turn starts and spawns work.
    fixture.now = 1_050;
    fixture.tasks.set('next', { ...runningTask('next'), createdAt: 1_050 });
    fixture.admit('next');
    fixture.now = 1_100;
    handle!.complete({ status: 'not-running' });
    await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));

    expect(fixture.tasks.get('leftover')!.status).toBe('canceled');
    expect(fixture.tasks.get('next')!.status).toBe('running');
    expect(fixture.stop).toHaveBeenCalledTimes(1);
  });

  it('still takes the boundary at complete on an abort timeout, and warns', async () => {
    const info = vi.spyOn(logger, 'info');
    const warn = vi.spyOn(logger, 'warn');
    try {
      const fixture = harness([]);
      fixture.now = 1_000;
      const handle = await userStop(fixture).begin(OWNER);
      // The stopped Turn has not released, so no newer Turn can exist: everything
      // up to `complete` is still its own wind-down.
      fixture.now = 1_250;
      fixture.tasks.set('winding-down', { ...runningTask('winding-down'), createdAt: 1_250 });
      fixture.admit('winding-down');
      fixture.now = 1_300;
      handle!.complete({ status: 'abort-timeout', turnId: 'turn-1' });
      await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));

      expect(fixture.tasks.get('winding-down')!.status).toBe('canceled');
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_user_stop_cascade_boundary_fixed',
          sessionId: OWNER,
          boundarySource: 'complete',
          boundaryMs: 1_300,
          abortStatus: 'abort-timeout',
        }),
        expect.any(String),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_user_stop_cascade_boundary_before_release',
          sessionId: OWNER,
          boundaryMs: 1_300,
          turnId: 'turn-1',
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it('keeps the first boundary and logs every later mark as ignored', async () => {
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([]);
      const port = userStop(fixture);
      // A release reported after an abort-timeout `complete` cannot move it.
      fixture.now = 1_300;
      const timedOut = await port.begin(OWNER);
      timedOut!.complete({ status: 'abort-timeout', turnId: 'turn-1' });
      fixture.now = 1_400;
      timedOut!.markBoundary('released');
      // A second mark cannot move the first one.
      fixture.now = 2_000;
      const marked = await port.begin(OWNER);
      marked!.markBoundary('released');
      fixture.now = 2_050;
      marked!.markBoundary('not_running');
      fixture.now = 2_100;
      marked!.complete({ status: 'aborted', turnId: 'turn-2' });
      // A cancelled stop has no cascade to bound.
      const cancelled = await port.begin(OWNER);
      cancelled!.cancel('turn_mismatch');
      cancelled!.markBoundary('released');
      await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));

      const prefix = 'background_task_user_stop_cascade_boundary_';
      const boundaryEvents = info.mock.calls
        .map(([fields]) => fields as unknown as Record<string, unknown>)
        .filter((fields) => String(fields['event']).startsWith(prefix));
      expect(boundaryEvents).toEqual([
        {
          event: `${prefix}fixed`,
          sessionId: OWNER,
          boundarySource: 'complete',
          boundaryMs: 1_300,
          abortStatus: 'abort-timeout',
        },
        {
          event: `${prefix}ignored`,
          sessionId: OWNER,
          boundarySource: 'released',
          boundaryMs: 1_300,
          fixedBy: 'complete',
        },
        { event: `${prefix}fixed`, sessionId: OWNER, boundarySource: 'released', boundaryMs: 2_000 },
        {
          event: `${prefix}ignored`,
          sessionId: OWNER,
          boundarySource: 'not_running',
          boundaryMs: 2_000,
          fixedBy: 'released',
        },
        { event: `${prefix}ignored`, sessionId: OWNER, boundarySource: 'released', reason: 'cancelled' },
      ]);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'background_task_user_stop_cascade_started',
          boundaryMs: 2_000,
        }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });
});

describe('user stop cascade: window lifecycle', () => {
  // A window that never closes holds every later completion notice of the Session
  // as `busy` for the life of the process — worse than having no cascade at all.
  // Each test below pins one path that used to be able to leave it open.

  it('releases the window when the stop is cancelled, so later work is delivered', async () => {
    const fixture = harness([terminalTask('later')]);
    const handle = await userStop(fixture).begin(OWNER);
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
    const port = userStop(fixture);

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
      const handle = await userStop(fixture).begin(OWNER);
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

describe('user stop cascade: stop policy at the root', () => {
  // The switches choose among the stopped conversation's OWN work. A subagent and
  // its child Session are one unit owned by the subagent switch, so a child sweep
  // is never filtered by the bash switch.

  it('leaves a background subagent, its row and its child session alone when stopSubAgent is off', async () => {
    const fixture = harness([runningTask('bash'), backgroundSubagent('sub', 'child', 'sub-turn')]);
    fixture.tasks.set('child-bash', childTask('child-bash', 'child', 'sub-turn'));
    for (const taskId of ['bash', 'sub', 'child-bash']) fixture.admit(taskId);
    const onTargets = vi.fn();

    const { targets } = await policyCascade(fixture, STOP_DEFAULT, onTargets);

    expect(ids(targets)).toEqual(['bash']);
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect(fixture.stop).toHaveBeenCalledWith('bash', expect.anything());
    // Never registered for suppression: its own completion still wakes the Session.
    expect(onTargets.mock.calls.flat(2)).toEqual(['bash']);
    expect(fixture.tasks.get('sub')!.status).toBe('running');
    expect(fixture.tasks.get('child-bash')!.status).toBe('running');
  });

  it('leaves an activated task_append row alone when stopSubAgent is off', async () => {
    const fixture = harness([
      {
        ...runningTask('append'),
        kind: 'subagent',
        metadata: { executionMode: 'append', childSessionId: 'child-a', subTurnId: 'append-turn' },
      },
    ]);
    fixture.tasks.set('append-bash', childTask('append-bash', 'child-a', 'append-turn'));
    fixture.admit('append');
    fixture.admit('append-bash');

    const { targets } = await policyCascade(fixture, STOP_DEFAULT);

    expect(targets).toEqual([]);
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.tasks.get('append')!.status).toBe('running');
    expect(fixture.tasks.get('append-bash')!.status).toBe('running');
  });

  it('does not list or sweep read subagents when stopSubAgent is off', async () => {
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

    await policyCascade(fixture, STOP_DEFAULT);

    expect(fixture.tasks.get('orphan')!.status).toBe('running');
    expect(fixture.stop).not.toHaveBeenCalled();
    // The read-subagent query itself is skipped, not just its result.
    expect(fixture.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ kinds: ['subagent'] }),
    );
  });

  it('keeps root bash when stopAsyncBash is off, yet stops bash inside the stopped subagent child session', async () => {
    const fixture = harness([
      runningTask('root-bash'),
      backgroundSubagent('sub', 'child', 'sub-turn'),
    ]);
    fixture.tasks.set('child-bash', childTask('child-bash', 'child', 'sub-turn'));
    for (const taskId of ['root-bash', 'sub', 'child-bash']) fixture.admit(taskId);
    const onTargets = vi.fn();

    const { targets } = await policyCascade(fixture, stopPolicy(true, false), onTargets);

    expect(ids(targets)).toEqual(['sub']);
    expect(fixture.tasks.get('root-bash')!.status).toBe('running');
    expect(fixture.tasks.get('child-bash')!.status).toBe('canceled');
    expect(onTargets.mock.calls.flat(2).sort()).toEqual(['child-bash', 'sub']);
  });

  it('stops workflow and custom tasks whenever the cascade runs', async () => {
    for (const policy of [STOP_DEFAULT, stopPolicy(true, false)]) {
      const fixture = harness([
        { ...runningTask('flow'), kind: 'workflow' },
        { ...runningTask('other'), kind: 'custom' },
      ]);
      fixture.admit('flow');
      fixture.admit('other');

      const { targets } = await policyCascade(fixture, policy);

      expect(ids(targets)).toEqual(['flow', 'other']);
    }
  });

  it('logs one cascade_skipped_by_policy summary per stop and none when both switches are on', async () => {
    const info = vi.spyOn(logger, 'info');
    const summaries = () =>
      info.mock.calls.filter(
        ([fields]) =>
          (fields as { event?: string }).event === 'background_task_cascade_skipped_by_policy',
      );
    try {
      const fixture = harness([
        runningTask('bash'),
        backgroundSubagent('sub', 'child', 'sub-turn'),
        { ...runningTask('sub-2'), kind: 'subagent', metadata: { executionMode: 'background' } },
      ]);
      fixture.tasks.set('child-bash', childTask('child-bash', 'child', 'sub-turn'));
      for (const taskId of ['bash', 'sub', 'sub-2', 'child-bash']) fixture.admit(taskId);

      await policyCascade(fixture, STOP_DEFAULT);

      expect(summaries()).toEqual([
        [
          {
            event: 'background_task_cascade_skipped_by_policy',
            sessionId: OWNER,
            stopSubAgent: false,
            stopAsyncBash: true,
            skipped: { subagent: 2, bash: 0 },
            readSubagentSweep: 'skipped',
          },
          expect.any(String),
        ],
      ]);

      info.mockClear();
      const allOn = harness([runningTask('bash-2'), backgroundSubagent('sub-3', 'child-3', 'turn-3')]);
      allOn.tasks.set('child-bash-3', childTask('child-bash-3', 'child-3', 'turn-3'));
      for (const taskId of ['bash-2', 'sub-3', 'child-bash-3']) allOn.admit(taskId);

      await policyCascade(allOn, STOP_ALL);

      // Nothing can be skipped with both switches on, and a child sweep never logs it.
      expect(allOn.tasks.get('child-bash-3')!.status).toBe('canceled');
      expect(summaries()).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });

  it('never filters a child sweep, even when a root policy is passed with a child scope', async () => {
    const fixture = harness([]);
    fixture.tasks.set('child-bash', childTask('child-bash', 'child', 'sub-turn'));
    fixture.tasks.set('child-sub', { ...childTask('child-sub', 'child', 'sub-turn'), kind: 'subagent' });
    fixture.admit('child-bash');
    fixture.admit('child-sub');

    await stopSessionBackgroundWork({
      host: fixture.host,
      sessionId: 'child',
      reason: 'owner_abort',
      boundaryMs: Number.POSITIVE_INFINITY,
      childScope: { ownerTurnId: 'sub-turn', parentTaskId: 'sub' },
      ctx: { depth: 1, visited: new Set<string>() },
      rootPolicy: STOP_NONE,
    });

    expect(fixture.tasks.get('child-bash')!.status).toBe('canceled');
    expect(fixture.tasks.get('child-sub')!.status).toBe('canceled');
  });
});

describe('user stop cascade: stop policy orchestration', () => {
  it('reads the policy once per stop, in begin, and logs it with policySource', async () => {
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([runningTask('bg')]);
      fixture.admit('bg');
      const policy: ConversationStopConfigRead = {
        ...STOP_DEFAULT,
        policySource: { stopSubAgent: 'default', stopAsyncBash: 'explicit' },
        ignoredKeys: ['stopSubAgent'],
      };
      const readStopPolicy = vi.fn(() => policy);

      const handle = await userStop(fixture, { readStopPolicy }).begin(OWNER);
      expect(readStopPolicy).toHaveBeenCalledTimes(1);
      handle!.complete({ status: 'aborted', turnId: 'turn-1' });
      await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));

      expect(readStopPolicy).toHaveBeenCalledTimes(1);
      expect(fixture.tasks.get('bg')!.status).toBe('canceled');
      expect(info).toHaveBeenCalledWith(
        {
          event: 'background_task_user_stop_cascade_policy',
          sessionId: OWNER,
          stopSubAgent: false,
          stopAsyncBash: true,
          policySource: { stopSubAgent: 'default', stopAsyncBash: 'explicit' },
          ignoredKeys: ['stopSubAgent'],
        },
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it('reads the policy but does not apply or log it for a child worker session', async () => {
    const fixture = harness([runningTask('child-task')]);
    fixture.session = childWorkerSession();
    const readStopPolicy = vi.fn(() => STOP_ALL);
    const info = vi.spyOn(logger, 'info');
    try {
      const handle = userStop(fixture, { readStopPolicy }).begin(OWNER);

      expect(handle).toBeDefined();
      expect(readStopPolicy).toHaveBeenCalledOnce();
      await handle!.accept('controller_accepted');

      expect(fixture.stop).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'background_task_user_stop_cascade_policy' }),
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it('with both switches off opens no window and stops nothing, but still pauses the Goal once accepted', async () => {
    const info = vi.spyOn(logger, 'info');
    try {
      const fixture = harness([runningTask('bg'), backgroundSubagent('sub', 'child', 'sub-turn')]);
      fixture.admit('bg');
      fixture.admit('sub');
      const pauseActiveGoal = vi.fn(async () => undefined);

      const handle = await userStop(fixture, {
        pauseActiveGoal,
        readStopPolicy: () => STOP_NONE,
      }).begin(OWNER);
      expect(handle).toBeDefined();
      expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false);
      handle!.markBoundary('released');
      await handle!.accept('controller_accepted');
      handle!.complete({ status: 'aborted', turnId: 'turn-1' });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(pauseActiveGoal).toHaveBeenCalledTimes(1);
      expect(fixture.stop).not.toHaveBeenCalled();
      expect(fixture.list).not.toHaveBeenCalled();
      // Nothing was registered for suppression: once finished, it reports back as usual.
      fixture.patch('bg', 'succeeded');
      await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'bg')).resolves.toBe(
        'delivered',
      );
      const events = info.mock.calls.map(([fields]) => (fields as { event?: string }).event);
      expect(events).toEqual(
        expect.arrayContaining([
          'background_task_user_stop_cascade_disabled_by_config',
          'background_task_user_stop_cascade_boundary_ignored',
        ]),
      );
      expect(info).toHaveBeenCalledWith(
        {
          event: 'background_task_user_stop_cascade_completed',
          sessionId: OWNER,
          targetCount: 0,
          abortStatus: 'aborted',
          disabledByConfig: true,
          turnId: 'turn-1',
        },
        expect.any(String),
      );
    } finally {
      info.mockRestore();
    }
  });

  it('with both switches off still never pauses the Goal for a cancelled stop', async () => {
    const fixture = harness([]);
    const pauseActiveGoal = vi.fn(async () => undefined);
    const handle = await userStop(fixture, {
      pauseActiveGoal,
      readStopPolicy: () => STOP_NONE,
    }).begin(OWNER);

    handle!.cancel('turn_mismatch');
    await handle!.accept('controller_accepted');

    expect(pauseActiveGoal).not.toHaveBeenCalled();
  });

  it('with the default policy stops root bash, while a subagent notice is delivered once the window closes', async () => {
    const fixture = harness([
      runningTask('bash'),
      { ...terminalTask('sub'), kind: 'subagent', metadata: { executionMode: 'background' } },
    ]);
    fixture.admit('bash');
    let releaseStop!: () => void;
    fixture.stop.mockImplementation(
      (taskId: string) =>
        new Promise((resolve) => {
          releaseStop = () => {
            fixture.patch(taskId, 'canceled');
            resolve(fixture.tasks.get(taskId));
          };
        }),
    );

    const handle = await userStop(fixture, { readStopPolicy: () => STOP_DEFAULT }).begin(OWNER);
    handle!.complete({ status: 'not-running' });
    await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalledWith('bash', expect.anything()));

    // While the stop is still running, every notice of the Session is held back...
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'sub')).resolves.toBe('busy');
    releaseStop();
    await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));

    // ...but only the stopped bash stays suppressed: the subagent was never a target.
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'bash')).resolves.toBe(
      'skipped',
    );
    await expect(startLocalBackgroundTaskDeliveryTurn(fixture.host, 'sub')).resolves.toBe(
      'delivered',
    );
  });

  it('falls back to the defaults and warns without error text when the config cannot be read', async () => {
    const warn = vi.spyOn(logger, 'warn');
    try {
      const fixture = harness([
        runningTask('bash'),
        { ...runningTask('sub'), kind: 'subagent', metadata: { executionMode: 'background' } },
      ]);
      fixture.admit('bash');
      fixture.admit('sub');
      const failed: ConversationStopConfigRead = {
        stopSubAgent: false,
        stopAsyncBash: true,
        policySource: { stopSubAgent: 'read_failed', stopAsyncBash: 'read_failed' },
        failure: { reason: 'yaml_error', line: 3 },
        configPath: '/data/config.yaml',
      };

      const handle = await userStop(fixture, { readStopPolicy: () => failed }).begin(OWNER);
      handle!.complete({ status: 'not-running' });
      await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));

      expect(fixture.tasks.get('bash')!.status).toBe('canceled');
      expect(fixture.tasks.get('sub')!.status).toBe('running');
      expect(warn).toHaveBeenCalledWith(
        {
          event: 'background_task_stop_cascade_config_read_failed',
          sessionId: OWNER,
          reason: 'yaml_error',
          line: 3,
          configPath: '/data/config.yaml',
          fallback: 'defaults',
        },
        expect.any(String),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('treats a throwing reader as read_failed defaults and still returns a handle', async () => {
    const warn = vi.spyOn(logger, 'warn');
    try {
      const fixture = harness([runningTask('bash')]);
      fixture.admit('bash');
      const readStopPolicy = (): ConversationStopConfigRead => {
        throw new Error('apiKey: sk-leak-in-message');
      };

      const handle = await userStop(fixture, { readStopPolicy }).begin(OWNER);
      expect(handle).toBeDefined();
      // The defaults still stop bash, so the window opens as for any cascading stop.
      expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(true);
      handle!.complete({ status: 'not-running' });
      await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));

      expect(fixture.tasks.get('bash')!.status).toBe('canceled');
      const failure = warn.mock.calls.find(
        ([fields]) =>
          (fields as { event?: string }).event ===
          'background_task_stop_cascade_config_read_failed',
      );
      expect(failure?.[0]).toMatchObject({ reason: 'reader_threw', fallback: 'defaults' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-leak-in-message');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the begin-time policy for the whole stop', async () => {
    const fixture = harness([runningTask('bash')]);
    fixture.admit('bash');
    let current = STOP_ALL;
    const readStopPolicy = vi.fn(() => current);

    const handle = await userStop(fixture, { readStopPolicy }).begin(OWNER);
    // The file changes while the stop is still running: this stop keeps its snapshot.
    current = stopPolicy(true, false);
    handle!.complete({ status: 'aborted', turnId: 'turn-1' });
    await vi.waitFor(() => expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false));

    expect(fixture.tasks.get('bash')!.status).toBe('canceled');
    expect(readStopPolicy).toHaveBeenCalledTimes(1);
  });

  it('reads config.yaml afresh on each stop when no reader is injected', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'user-stop-policy-'));
    // The production reader resolves getConfigPath(), which follows MINIMAX_DATA_DIR.
    vi.stubEnv('MINIMAX_DATA_DIR', dataDir);
    try {
      const fixture = harness([runningTask('bash')]);
      fixture.admit('bash');
      const port = createUserStopCascade({ host: fixture.host });

      await writeFile(
        join(dataDir, 'config.yaml'),
        'conversation:\n  stopSubAgent: false\n  stopAsyncBash: false\n',
      );
      const first = await port.begin(OWNER);
      first!.complete({ status: 'not-running' });
      // Both switches explicitly off: nothing to cascade.
      expect(isUserStopWindowOpen(fixture.host, OWNER)).toBe(false);
      expect(fixture.stop).not.toHaveBeenCalled();

      await writeFile(join(dataDir, 'config.yaml'), 'conversation:\n  stopAsyncBash: true\n');
      const second = await port.begin(OWNER);
      second!.complete({ status: 'not-running' });

      await vi.waitFor(() => expect(fixture.tasks.get('bash')!.status).toBe('canceled'));
    } finally {
      vi.unstubAllEnvs();
      await rm(dataDir, { recursive: true, force: true });
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

function stopPolicy(stopSubAgent: boolean, stopAsyncBash: boolean): ConversationStopConfigRead {
  return {
    stopSubAgent,
    stopAsyncBash,
    policySource: { stopSubAgent: 'explicit', stopAsyncBash: 'explicit' },
  };
}

/** A user-stop port for this fixture, running with every switch on unless a test says otherwise. */
function userStop(
  fixture: ReturnType<typeof harness>,
  deps: Partial<Omit<UserStopCascadeDependencies, 'host'>> = {},
): ReturnType<typeof createUserStopCascade> {
  return createUserStopCascade({ host: fixture.host, readStopPolicy: () => STOP_ALL, ...deps });
}

function pendingSessionLookup(fixture: ReturnType<typeof harness>) {
  const lookup = deferredValue<LocalSessionRecord | undefined>();
  fixture.host.getSessionById = vi.fn(() => lookup.promise);
  return lookup;
}

function deferredValue<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/** A root sweep of OWNER with the given switches, as `completeCascade` runs it. */
function policyCascade(
  fixture: ReturnType<typeof harness>,
  rootPolicy: CascadeKindPolicy,
  onTargets: (taskIds: readonly string[]) => void = () => undefined,
): ReturnType<typeof stopSessionBackgroundWork> {
  return stopSessionBackgroundWork({
    host: fixture.host,
    sessionId: OWNER,
    reason: 'owner_abort',
    boundaryMs: 10_000,
    ctx: { depth: 0, visited: new Set<string>(), onTargets },
    rootPolicy,
  });
}

/** A running background subagent of OWNER whose child Turn ran in `childSessionId`. */
function backgroundSubagent(
  taskId: string,
  childSessionId: string,
  subTurnId: string,
): BackgroundTask {
  return {
    ...runningTask(taskId),
    kind: 'subagent',
    metadata: { executionMode: 'background', childSessionId, subTurnId },
  };
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
