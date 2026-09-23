import {
  localBashResultFromError,
  readBashExecutionOutcome,
  resolveLocalBashTiming,
  validateBashCommand,
  resolveBashDescription,
  type LocalBashTiming,
  type LocalBashAdapter,
  type LocalBashBackgroundStartResult,
  type LocalBashManagedForegroundResult,
  type LocalBashToolInput,
  type LocalRuntimeToolContext,
} from '@mavis/agent-tools/desktop';

import type { LocalSessionRecord } from '../sessions/controller.js';
import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import { createBackgroundTaskId, type BackgroundTask } from './domain.js';
import { scheduleLocalBackgroundTaskDelivery } from './delivery.js';
import { admitBackgroundTask, shutdownBackgroundTasks } from './lifecycle.js';
import {
  logRunnerFailure,
  managedBashAbortError,
  raceCompletionWithSoftYield,
  recordBashMetrics,
  recordSoftYieldMetric,
  type LocalBackgroundBashCompletion,
} from './bash-runner-lifecycle.js';
import { BackgroundBashOutputWriter } from './bash-output-writer.js';
import {
  settleBackgroundBashTask,
  settleFailedBackgroundBash,
  withTaskOutputReceipt,
} from './bash-task-settlement.js';
import { capBackgroundBashMaxRunMs, resolveBackgroundBashMaxRunMs } from './bash-runner-limits.js';
import {
  DEFAULT_LOCAL_BACKGROUND_BASH_EXECUTOR,
  type LocalBackgroundBashExecutor,
} from './bash-executor.js';

export {
  DEFAULT_BACKGROUND_BASH_MAX_RUN_MS,
  MAX_BACKGROUND_BASH_MAX_RUN_MS,
  resolveBackgroundBashMaxRunMs,
} from './bash-runner-limits.js';

export {
  DEFAULT_LOCAL_BACKGROUND_BASH_EXECUTOR,
  type LocalBackgroundBashExecutor,
  type LocalBackgroundBashExecutorResult,
} from './bash-executor.js';

interface ActiveBackgroundBash {
  controller: AbortController;
  settled: Promise<LocalBackgroundBashCompletion>;
}
type ManagedBashRun = NonNullable<LocalBashAdapter['runManagedForeground']>;

const activeBackgroundBash = new Map<string, ActiveBackgroundBash>();

interface StartedLocalBackgroundBash {
  taskId: string;
  settled: Promise<LocalBackgroundBashCompletion>;
  getStartedDetails(): Record<string, unknown> | undefined;
}

export function buildLocalBashAdapter(
  host: LocalTaskRunnerHostWithSessionLookup,
  parentSession: LocalSessionRecord,
  executor: LocalBackgroundBashExecutor = DEFAULT_LOCAL_BACKGROUND_BASH_EXECUTOR,
): LocalBashAdapter {
  const runManaged: ManagedBashRun = (toolCtx, bashInput, softYieldMs, signal) =>
    runManagedForegroundLocalBash({
      host,
      parentSession,
      toolCtx,
      bashInput,
      softYieldMs,
      signal,
      executor,
    });
  return {
    startBackground: (toolCtx, bashInput, signal) =>
      startBackgroundLocalBash({ host, parentSession, toolCtx, bashInput, signal, executor }),
    runManagedForeground: runManaged,
  };
}

export async function startBackgroundLocalBash(input: {
  host: LocalTaskRunnerHostWithSessionLookup;
  parentSession: LocalSessionRecord;
  toolCtx: LocalRuntimeToolContext;
  bashInput: LocalBashToolInput;
  signal?: AbortSignal;
  executor?: LocalBackgroundBashExecutor;
  maxRunMs?: number;
}): Promise<LocalBashBackgroundStartResult> {
  if (input.signal?.aborted) throw new Error('Operation aborted');
  const controller = new AbortController();
  const admission = admitBackgroundTask(input.host, (reason) => controller.abort(reason));
  try {
    const started = await startAdmittedBackgroundLocalBash(
      input,
      controller,
      admission,
      'explicit_background',
    );
    void started.settled.then(
      (completion) => {
        recordBashMetrics(
          input.host,
          input.parentSession.sessionId,
          completion,
          'explicit_background',
        );
        scheduleLocalBackgroundTaskDelivery(input.host, started.taskId);
      },
      (error) => logRunnerFailure(input.host, input.parentSession.sessionId, started.taskId, error),
    );
    return {
      status: 'started',
      taskId: started.taskId,
      ...(started.getStartedDetails() ? { details: started.getStartedDetails() } : {}),
    };
  } catch (error) {
    admission.release();
    throw error;
  }
}

export async function runManagedForegroundLocalBash(input: {
  host: LocalTaskRunnerHostWithSessionLookup;
  parentSession: LocalSessionRecord;
  toolCtx: LocalRuntimeToolContext;
  bashInput: LocalBashToolInput;
  softYieldMs: number;
  signal?: AbortSignal;
  executor?: LocalBackgroundBashExecutor;
}): Promise<LocalBashManagedForegroundResult> {
  if (input.signal?.aborted) throw managedBashAbortError(input.signal, 'Operation aborted');
  const controller = new AbortController();
  const abortManaged = () => controller.abort(input.signal?.reason ?? 'Operation aborted');
  input.signal?.addEventListener('abort', abortManaged, { once: true });
  const admission = admitBackgroundTask(input.host, (reason) => controller.abort(reason));
  try {
    const started = await startAdmittedBackgroundLocalBash(
      input,
      controller,
      admission,
      'managed_foreground',
    );
    const completion = await raceCompletionWithSoftYield(started.settled, input.softYieldMs);
    if (completion) {
      try {
        await input.host.backgroundTaskService.markDelivered(input.parentSession.sessionId, [
          started.taskId,
        ]);
        await input.host.backgroundTaskService.patch(started.taskId, {
          metadata: { executionMode: 'managed_foreground', completionOrigin: 'foreground' },
        });
      } catch (error) {
        input.host.matrixLogger?.warn(
          { sessionId: input.parentSession.sessionId, turnId: started.taskId },
          `Failed to persist managed bash foreground delivery latch: ${formatError(error)}`,
        );
      }
      recordBashMetrics(
        input.host,
        input.parentSession.sessionId,
        completion,
        'managed_foreground',
      );
      recordSoftYieldMetric(input.host, started.taskId, completion.durationMs, 'completed');
      if (completion.status === 'canceled') {
        throw Object.assign(managedBashAbortError(input.signal, completion.text), {
          details: completion.details,
        });
      }
      return {
        status: 'completed',
        taskId: started.taskId,
        text: completion.text,
        ...(completion.details ? { details: completion.details } : {}),
        ...(completion.isError ? { isError: true } : {}),
      };
    }

    try {
      await input.host.backgroundTaskService.patch(started.taskId, {
        metadata: {
          executionMode: 'auto_promoted',
          foregroundSoftYieldMs: input.softYieldMs,
        },
      });
    } catch (error) {
      input.host.matrixLogger?.warn(
        { sessionId: input.parentSession.sessionId, turnId: started.taskId },
        `Failed to persist managed bash promotion metadata: ${formatError(error)}`,
      );
    }
    recordSoftYieldMetric(input.host, started.taskId, input.softYieldMs, 'promoted');
    input.signal?.removeEventListener('abort', abortManaged);
    void started.settled.then(
      (result) => {
        recordBashMetrics(input.host, input.parentSession.sessionId, result, 'auto_promoted');
        scheduleLocalBackgroundTaskDelivery(input.host, started.taskId);
      },
      (error) => logRunnerFailure(input.host, input.parentSession.sessionId, started.taskId, error),
    );
    return {
      status: 'auto_promoted',
      taskId: started.taskId,
      ...(started.getStartedDetails() ? { details: started.getStartedDetails() } : {}),
    };
  } catch (error) {
    admission.release();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { status: 'failed', errorMessage: formatError(error) };
  } finally {
    input.signal?.removeEventListener('abort', abortManaged);
  }
}

async function startAdmittedBackgroundLocalBash(
  input: Parameters<typeof startBackgroundLocalBash>[0] & { softYieldMs?: number },
  controller: AbortController,
  admission: ReturnType<typeof admitBackgroundTask>,
  executionMode: 'explicit_background' | 'managed_foreground',
): Promise<StartedLocalBackgroundBash> {
  validateBashCommand(input.bashInput.command);
  const timing = resolveLocalBashTiming(input.bashInput.timeout, executionMode);
  const taskId = createBackgroundTaskId();
  const now = input.host.nowMs();
  const description = resolveBashDescription(input.bashInput.description, input.bashInput.command);
  const maxRunMs = capBackgroundBashMaxRunMs(
    input.maxRunMs ?? resolveBackgroundBashMaxRunMs(timing.commandTimeoutSeconds),
  );
  await input.host.backgroundTaskService.create({
    taskId,
    kind: 'bash',
    status: 'queued',
    ownerSessionId: input.parentSession.sessionId,
    description,
    toolCallId: input.toolCtx.toolCallId,
    createdAt: now,
    updatedAt: now,
    metadata: {
      parentSessionId: input.parentSession.sessionId,
      parentTurnId: input.toolCtx.turnId,
      command: input.bashInput.command,
      ...(input.bashInput.timeout ? { timeoutSeconds: input.bashInput.timeout } : {}),
      maxRunMs,
      timing,
      executionMode,
    },
  });

  let startedDetails: Record<string, unknown> | undefined = { description };
  const settled = runBackgroundLocalBashCommand({
    host: input.host,
    parentSession: input.parentSession,
    taskId,
    command: input.bashInput.command,
    description,
    timeout: timing.commandTimeoutSeconds,
    timing,
    maxRunMs,
    executionMode,
    toolCtx: input.toolCtx,
    executor: input.executor ?? DEFAULT_LOCAL_BACKGROUND_BASH_EXECUTOR,
    controller,
    onStartedDetails: (details) => {
      startedDetails = { ...(startedDetails ?? {}), ...details };
    },
  });
  admission.bind(settled.then(() => undefined));
  activeBackgroundBash.set(taskId, { controller, settled });
  return { taskId, settled, getStartedDetails: () => startedDetails };
}

export async function stopBackgroundLocalBashTask(
  task: BackgroundTask,
  reason?: string,
): Promise<void> {
  if (task.kind !== 'bash') return;
  const active = activeBackgroundBash.get(task.taskId);
  if (!active) return;
  active.controller.abort(reason ?? 'Background bash stopped');
  await active.settled;
}

/**
 * Abort every in-flight background bash task in this process. The single-task
 * stop path already proves that aborting a controller kills its child process;
 * this fans that out across the whole registry so a log/headless single-shot
 * exit can reclaim leftover background bash before the process tears down —
 * otherwise a long `run_in_background` command (e.g. a 10-min loop) keeps the
 * event loop alive and the CLI hangs. Interactive mode must NOT call this:
 * there, background tasks are meant to survive across turns. Each abort runs
 * the same runner `finally` that removes the entry, so the registry drains and
 * a repeat call is a no-op. Returns the number of tasks signalled.
 */
export function abortAllBackgroundLocalBashTasks(reason?: string): number {
  const activeTasks = [...activeBackgroundBash.values()];
  for (const active of activeTasks) {
    active.controller.abort(reason ?? 'Background bash reclaimed on exit');
  }
  return activeTasks.length;
}

export async function abortBackgroundLocalBashTasksForHost(
  host: LocalTaskRunnerHostWithSessionLookup,
  reason = 'runtime-shutdown',
): Promise<number> {
  return shutdownBackgroundTasks(host, reason);
}

async function runBackgroundLocalBashCommand(input: {
  host: LocalTaskRunnerHostWithSessionLookup;
  parentSession: LocalSessionRecord;
  taskId: string;
  command: string;
  description: string;
  timeout?: number;
  timing: LocalBashTiming;
  maxRunMs?: number;
  executionMode: 'explicit_background' | 'managed_foreground';
  toolCtx: LocalRuntimeToolContext;
  executor: LocalBackgroundBashExecutor;
  controller: AbortController;
  onStartedDetails(details: Record<string, unknown>): void;
}): Promise<LocalBackgroundBashCompletion> {
  const { controller } = input;
  const startedAt = input.host.nowMs();
  const output = new BackgroundBashOutputWriter(
    input.host,
    input.parentSession.sessionId,
    input.taskId,
  );
  // Watchdog: cap a runaway/forgotten background task at maxRunMs. Firing
  // aborts the same controller the stop path uses; `timedOut` disambiguates
  // the resulting abort from a user-requested stop so we land failed+TIMEOUT
  // rather than canceled (bash-tool-optimization.md §5).
  const maxRunMs = capBackgroundBashMaxRunMs(
    input.maxRunMs ?? resolveBackgroundBashMaxRunMs(input.timeout),
  );
  const timing = { ...input.timing };
  input.onStartedDetails({ timing });
  let timedOut = false;
  const watchdog = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort('TIMEOUT');
  }, maxRunMs);
  try {
    const executed = await input.executor.execute({
      identity: {
        operationClass: input.executionMode,
        invocationId: input.taskId,
        sessionId: input.parentSession.sessionId,
        turnId: input.toolCtx.turnId,
        ...(input.toolCtx.toolCallId ? { toolCallId: input.toolCtx.toolCallId } : {}),
        taskId: input.taskId,
        ...(input.toolCtx.forceReadOnlyFilesystem ? { forceReadOnlyFilesystem: true } : {}),
      },
      workspaceRoot: input.parentSession.workspaceDir || input.host.resolveDefaultWorkspaceDir(),
      command: input.command,
      timeout: input.timeout,
      signal: controller.signal,
      onPreflightComplete: async () => {
        await input.host.backgroundTaskService.patch(input.taskId, {
          status: 'running',
          startedAt: input.host.nowMs(),
        });
      },
      onOutput: output.push,
      onDetails: (details) => {
        Object.assign(timing, details.timing);
        input.onStartedDetails({ ...details, timing: { ...timing } });
      },
    });
    const result = {
      ...executed,
      details: {
        ...executed.details,
        description: input.description,
        timing: { ...timing, ...(executed.details?.timing as object) },
      },
    };
    const execution = readBashExecutionOutcome(result.details);
    if (result.isError || (execution && execution.status !== 'succeeded')) {
      return await settleFailedBackgroundBash(input, output, result, startedAt, timedOut, maxRunMs);
    }
    const outputRef = await output.settleSuccess(result);
    const completed = withTaskOutputReceipt(result, output, outputRef, input.taskId);
    const terminal = await settleBackgroundBashTask({
      host: input.host,
      output,
      taskId: input.taskId,
      startedAt,
      status: 'succeeded',
      outputRef,
      lastError: undefined,
      metadata: {
        bashDetails: completed.details,
        outputBytes: output.outputBytes,
      },
    });
    try {
      await input.host.backgroundTaskService.finalizeOutput(input.taskId, completed.text);
    } catch (error) {
      output.warn('finalize', error);
    }
    return {
      taskId: input.taskId,
      status: 'succeeded',
      text: completed.text,
      details: completed.details,
      endedAt: terminal.endedAt,
      durationMs: terminal.durationMs,
      outputBytes: output.outputBytes,
    };
  } catch (error) {
    const failed = localBashResultFromError(error, controller.signal);
    failed.details = {
      ...failed.details,
      description: input.description,
      timing: { ...timing, ...(failed.details?.timing as object) },
    };
    if (
      output.streamedOutput &&
      !readBashExecutionOutcome(
        error && typeof error === 'object' && 'details' in error ? error.details : undefined,
      )
    ) {
      failed.text = `${output.streamedTextForError}\n${failed.text}`;
    }
    return await settleFailedBackgroundBash(input, output, failed, startedAt, timedOut, maxRunMs);
  } finally {
    clearTimeout(watchdog);
    activeBackgroundBash.delete(input.taskId);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
