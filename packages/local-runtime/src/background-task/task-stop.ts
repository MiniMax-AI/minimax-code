import {
  isTerminalTaskStatus,
  normalizeTaskError,
  type BackgroundTask,
  type BackgroundTaskPatch,
  type BackgroundTaskStatus,
  type TaskStore,
} from './domain.js';

interface TaskStopContext {
  store: Pick<TaskStore, 'get' | 'patch'>;
  nowMs(): number;
  stopRuntime?: (task: BackgroundTask, reason?: string) => Promise<void>;
  patchStatusIfNotTerminal(
    task: BackgroundTask,
    status: BackgroundTaskStatus,
    patch: Omit<BackgroundTaskPatch, 'status'>,
  ): Promise<{ task: BackgroundTask; patched: boolean }>;
  emit(
    task: BackgroundTask,
    type: 'stop_requested' | 'completed',
    payload: Record<string, unknown>,
  ): Promise<void>;
}

export async function performTaskStop(
  context: TaskStopContext,
  task: BackgroundTask,
  reason?: string,
): Promise<BackgroundTask> {
  const taskId = task.taskId;
  const stoppingResult = await context.patchStatusIfNotTerminal(task, 'stopping', {
    updatedAt: context.nowMs(),
    ...(reason ? { lastError: { message: reason, code: 'TASK_STOP_REQUESTED' } } : {}),
  });
  if (!stoppingResult.patched) return stoppingResult.task;
  const stopping = stoppingResult.task;
  await context.emit(stopping, 'stop_requested', { reason });
  try {
    await context.stopRuntime?.(stopping, reason);
    const settled = await context.store.get(taskId);
    if (settled && isTerminalTaskStatus(settled.status)) return settled;
    const canceledResult = await context.patchStatusIfNotTerminal(stopping, 'canceled', {
      endedAt: context.nowMs(),
      ...(reason ? { lastError: { message: reason, code: 'TASK_CANCELED' } } : {}),
    });
    if (!canceledResult.patched) return canceledResult.task;
    const canceled = canceledResult.task;
    await context.emit(canceled, 'completed', { status: 'canceled' });
    return canceled;
  } catch (error) {
    const stopError = normalizeTaskError(error, 'TASK_STOP_FAILED');
    const settled = await context.store.patch(taskId, {
      metadata: { stopError },
    });
    if (isTerminalTaskStatus(settled.status)) return settled;
    const canceledResult = await context.patchStatusIfNotTerminal(stopping, 'canceled', {
      endedAt: context.nowMs(),
      lastError: stopError,
    });
    if (!canceledResult.patched) return canceledResult.task;
    const canceled = canceledResult.task;
    await context.emit(canceled, 'completed', { status: 'canceled', stopFailed: true });
    return canceled;
  }
}
