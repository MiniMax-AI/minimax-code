import { LocalBackgroundTaskService } from './service.js';
import type { LocalBackgroundTaskServiceOptions } from './service.js';
import { FsLocalTaskOutputStore, SqliteLocalBackgroundTaskStore } from './store.js';
import type { BackgroundTask } from './domain.js';

export { LocalBackgroundTaskService } from './service.js';
export type { LocalBackgroundTaskServiceOptions } from './service.js';
export { FsLocalTaskOutputStore, SqliteLocalBackgroundTaskStore } from './store.js';
export { abortAllBackgroundLocalBashTasks } from './bash-runner.js';
export { createUserStopCascade } from './user-stop-cascade.js';
export type {
  UserStopCascade,
  UserStopCascadeDependencies,
  UserStopCascadeHandle,
  UserStopAbortResult,
} from './user-stop-cascade.js';
export type { StoppedTaskRecord, StoppedTaskStatus } from './session-cascade.js';

export function createLocalBackgroundTaskService(
  dataDir: string | (() => string),
  nowMs: () => number,
  stopRuntime?: (task: BackgroundTask, reason?: string) => Promise<void>,
  onTerminal?: LocalBackgroundTaskServiceOptions['onTerminal'],
): LocalBackgroundTaskService {
  return new LocalBackgroundTaskService({
    store: new SqliteLocalBackgroundTaskStore(dataDir, nowMs),
    outputStore: new FsLocalTaskOutputStore(dataDir),
    nowMs,
    ...(stopRuntime ? { stopRuntime } : {}),
    ...(onTerminal ? { onTerminal } : {}),
  });
}
