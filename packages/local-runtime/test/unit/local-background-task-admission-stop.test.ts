import { describe, expect, it, vi } from 'vitest';

import type { LocalTaskRunnerHostWithSessionLookup } from '../../src/api/local-task-host.js';
import {
  abortAdmittedBackgroundTask,
  admitBackgroundTask,
  drainBackgroundTasks,
  isBackgroundTaskAdmittedHere,
} from '../../src/background-task/lifecycle.js';

describe('stopping one admitted background task', () => {
  it('aborts only the identified task, retains its drain and permits new admission', async () => {
    const host = {} as LocalTaskRunnerHostWithSessionLookup;
    const targetAbort = vi.fn();
    const peerAbort = vi.fn();
    const nextAbort = vi.fn();
    const target = admitBackgroundTask(host, targetAbort);
    const peer = admitBackgroundTask(host, peerAbort);
    const admissions = [target, peer];
    target.identify('target');
    peer.identify('peer');
    let releaseRunner!: () => void;
    target.bind(new Promise<void>((resolve) => { releaseRunner = resolve; }));
    try {
      abortAdmittedBackgroundTask(host, 'target', 'owner-stop');
      expect(targetAbort.mock.calls).toEqual([['owner-stop']]);
      expect(peerAbort).not.toHaveBeenCalled();
      expect(isBackgroundTaskAdmittedHere(host, 'target')).toBe(true);
      expect(isBackgroundTaskAdmittedHere(host, 'peer')).toBe(true);

      const next = admitBackgroundTask(host, nextAbort);
      admissions.push(next);
      next.identify('next');
      expect(nextAbort).not.toHaveBeenCalled();
      expect(isBackgroundTaskAdmittedHere(host, 'next')).toBe(true);

      let drained = false;
      const draining = drainBackgroundTasks(host).then(() => { drained = true; });
      for (const admission of admissions) admission.release();
      await Promise.resolve();
      expect(drained).toBe(false);
      releaseRunner();
      await draining;
      expect(isBackgroundTaskAdmittedHere(host, 'target')).toBe(false);
    } finally {
      releaseRunner();
      for (const admission of admissions) admission.release();
      await drainBackgroundTasks(host);
    }
  });

  it('leaves missing, released and unidentified admissions alone', async () => {
    const host = {} as LocalTaskRunnerHostWithSessionLookup;
    const abort = vi.fn();
    const released = admitBackgroundTask(host, abort);
    released.identify('released');
    released.release();
    await Promise.resolve();
    const unidentified = admitBackgroundTask(host, abort);
    try {
      abortAdmittedBackgroundTask(host, 'missing', 'stop');
      abortAdmittedBackgroundTask(host, 'released', 'stop');
      abortAdmittedBackgroundTask({} as LocalTaskRunnerHostWithSessionLookup, 'missing', 'stop');
      expect(abort).not.toHaveBeenCalled();
      expect(isBackgroundTaskAdmittedHere(host, 'released')).toBe(false);
    } finally {
      unidentified.release();
      await drainBackgroundTasks(host);
    }
  });

  it('does not abort the same task id admitted by another host', async () => {
    const firstHost = {} as LocalTaskRunnerHostWithSessionLookup;
    const otherHost = {} as LocalTaskRunnerHostWithSessionLookup;
    const firstAbort = vi.fn();
    const otherAbort = vi.fn();
    const first = admitBackgroundTask(firstHost, firstAbort);
    const other = admitBackgroundTask(otherHost, otherAbort);
    first.identify('shared-task-id');
    other.identify('shared-task-id');
    try {
      abortAdmittedBackgroundTask(firstHost, 'shared-task-id', 'stop');
      expect(firstAbort.mock.calls).toEqual([['stop']]);
      expect(otherAbort).not.toHaveBeenCalled();
      expect(isBackgroundTaskAdmittedHere(otherHost, 'shared-task-id')).toBe(true);
    } finally {
      first.release();
      other.release();
      await Promise.all([drainBackgroundTasks(firstHost), drainBackgroundTasks(otherHost)]);
    }
  });
});
