import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';

interface ActiveBackgroundTask {
  readonly settled: Promise<void>;
  readonly abort?: (reason: string) => void;
  /**
   * Durable row identity, published by the runner once the row exists. Admission
   * happens before `createBackgroundTaskId()`, so this stays undefined during the
   * short setup window and the task is simply not claimed yet.
   */
  taskId?: string;
}

interface HostBackgroundTaskState {
  closing: boolean;
  readonly active: Set<ActiveBackgroundTask>;
}

export interface BackgroundTaskAdmission {
  bind(settled: Promise<void>): void;
  release(): void;
  /**
   * Claim the durable task row for this process. Only claimed tasks may be
   * stopped by a Session cascade: `performStop` writes `canceled` whether or not
   * `stopRuntime` actually reached a live runner, so stopping a row owned by
   * another client process (shared data directory) would mark it canceled while
   * it keeps running there. Unclaimed rows are skipped instead.
   */
  identify(taskId: string): void;
}

const hostStates = new WeakMap<LocalTaskRunnerHostWithSessionLookup, HostBackgroundTaskState>();

export function admitBackgroundTask(
  host: LocalTaskRunnerHostWithSessionLookup,
  abort?: (reason: string) => void,
): BackgroundTaskAdmission {
  const state = getHostState(host);
  if (state.closing) throw new Error('Local Runtime is shutting down');

  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const settled = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const active: ActiveBackgroundTask = { settled, ...(abort ? { abort } : {}) };
  state.active.add(active);
  void settled.then(
    () => state.active.delete(active),
    () => state.active.delete(active),
  );

  let bound = false;
  return {
    bind: (task) => {
      if (bound) throw new Error('Background task admission already settled');
      bound = true;
      void task.then(resolve, reject);
    },
    release: () => {
      if (bound) return;
      bound = true;
      resolve();
    },
    identify: (taskId) => {
      active.taskId = taskId;
    },
  };
}

/**
 * Whether this process admitted (and therefore can actually stop) the task.
 *
 * The entry is removed as soon as the task settles, so a terminal task always
 * answers `false`; callers only need this for non-terminal rows, which are the
 * ones a cascade would otherwise mis-cancel.
 */
export function isBackgroundTaskAdmittedHere(
  host: LocalTaskRunnerHostWithSessionLookup,
  taskId: string,
): boolean {
  const state = hostStates.get(host);
  if (!state) return false;
  for (const task of state.active) {
    if (task.taskId === taskId) return true;
  }
  return false;
}

export function beginBackgroundTaskShutdown(
  host: LocalTaskRunnerHostWithSessionLookup,
  reason = 'runtime-shutdown',
): number {
  const state = getHostState(host);
  state.closing = true;
  let aborted = 0;
  for (const task of state.active) {
    if (!task.abort) continue;
    task.abort(reason);
    aborted += 1;
  }
  return aborted;
}

export async function drainBackgroundTasks(
  host: LocalTaskRunnerHostWithSessionLookup,
): Promise<void> {
  const results = await Promise.allSettled(
    [...getHostState(host).active].map(({ settled }) => settled),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}

async function shutdownBackgroundTasks(
  host: LocalTaskRunnerHostWithSessionLookup,
  reason: string,
): Promise<number> {
  const aborted = beginBackgroundTaskShutdown(host, reason);
  await drainBackgroundTasks(host);
  return aborted;
}

export { shutdownBackgroundTasks };

function getHostState(host: LocalTaskRunnerHostWithSessionLookup): HostBackgroundTaskState {
  let state = hostStates.get(host);
  if (!state) {
    state = { closing: false, active: new Set() };
    hostStates.set(host, state);
  }
  return state;
}
