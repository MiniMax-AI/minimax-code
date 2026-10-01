import { createBackgroundTaskId } from './domain.js';
import { createLocalSubagentTaskRow } from './subagent-task-row.js';
import { persistLocalSubagentTaskTerminal } from './terminal.js';
import { taskTurnId } from './turn-id.js';
import type {
  LocalRuntimeToolContext,
  LocalTaskBackgroundStartResult,
  LocalTaskToolInput,
  LocalTaskRunResult,
} from '@mavis/agent-tools/desktop';

import type { LocalTaskTargetFacts } from '../agent/port.js';
import { createSubagentFinishTelemetrySink } from '../agent/subagent-telemetry.js';
import { logger } from '../common/logger.js';
import { resolveV2SessionArtifactPathsSync } from '../persistence/layout/v2-session-artifacts.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import { runInjectedConversationTaskTurn } from '../api/injected-conversation-task-turn.js';
import {
  type LocalTaskRunnerHostWithSessionLookup,
  requireTaskConversation,
} from '../api/local-task-host.js';
import { normalizeLocalTaskInput, taskModelSelectionFor } from '../api/local-task-input.js';
import { resolveLocalTaskAgentTarget } from '../api/local-task-subagents.js';
import { admitBackgroundTask, drainBackgroundTasks } from './lifecycle.js';

export async function startBackgroundLocalTask(input: {
  host: LocalTaskRunnerHostWithSessionLookup;
  parentSession: LocalSessionRecord;
  toolCtx: LocalRuntimeToolContext;
  taskInput: LocalTaskToolInput;
  signal?: AbortSignal;
}): Promise<LocalTaskBackgroundStartResult> {
  if (input.signal?.aborted) throw new Error('Operation aborted');
  const controller = new AbortController();
  const admission = admitBackgroundTask(input.host, (reason) => controller.abort(reason));
  const starting = startAdmittedBackgroundLocalTask(input, admission, controller.signal);
  void starting.then(admission.release, admission.release);
  return starting;
}

async function startAdmittedBackgroundLocalTask(
  input: Parameters<typeof startBackgroundLocalTask>[0],
  admission: ReturnType<typeof admitBackgroundTask>,
  shutdownSignal: AbortSignal,
): Promise<LocalTaskBackgroundStartResult> {
  const taskInput = normalizeLocalTaskInput(input.taskInput);
  requireTaskConversation(input.host);
  const target = await resolveLocalTaskAgentTarget(input.host, taskInput.agent_name);
  throwIfShuttingDown(shutdownSignal);
  if (!target) {
    return {
      status: 'failed',
      errorMessage: `Unknown agent: ${taskInput.agent_name}`,
    };
  }
  const agentName = target.resolvedAgentName;
  const taskModelSelection = taskModelSelectionFor(taskInput);

  const taskId = createBackgroundTaskId();
  // Claim the row for this process before it exists durably, so a Session stop
  // cascade can tell "our task" from a row owned by another client process.
  admission.identify(taskId);
  const turnId = taskTurnId(taskId);
  await createLocalSubagentTaskRow({
    host: input.host,
    taskId,
    turnId,
    executionMode: 'background',
    ownerSessionId: input.parentSession.sessionId,
    toolCtx: input.toolCtx,
    taskInput,
    target,
  });
  if (shutdownSignal.aborted) {
    return cancelAdmittedTaskSetup({ input, target, taskId, turnId, shutdownSignal });
  }

  let childSession: LocalSessionRecord | undefined;
  try {
    childSession = await input.host.agentRoutes.createSession({
      agentName,
      workspaceDir: input.parentSession.workspaceDir || input.host.resolveDefaultWorkspaceDir(),
      sessionType: 'branch',
      sessionKind: 'task',
      parentSessionId: input.parentSession.sessionId,
      title: taskInput.description,
      visibility: 'hidden',
      purpose: `local-background-task:${taskId}`,
      runLocation: input.parentSession.runLocation,
      appMode: input.parentSession.appMode,
      isDefaultWorkspace: input.parentSession.isDefaultWorkspace,
      ...(taskModelSelection ? { taskModelSelection } : {}),
    });
    if (shutdownSignal.aborted) {
      return cancelAdmittedTaskSetup({
        input,
        target,
        taskId,
        turnId,
        childSession,
        shutdownSignal,
      });
    }
    await input.host.backgroundTaskService.patch(taskId, {
      status: 'running',
      startedAt: input.host.nowMs(),
      metadata: { childSessionId: childSession.sessionId, subTurnId: turnId, agentName },
    });
    if (shutdownSignal.aborted) {
      return cancelAdmittedTaskSetup({
        input,
        target,
        taskId,
        turnId,
        childSession,
        shutdownSignal,
      });
    }
  } catch (error) {
    if (shutdownSignal.aborted) {
      return cancelAdmittedTaskSetup({
        input,
        target,
        taskId,
        turnId,
        childSession,
        shutdownSignal,
      });
    }
    // The row exists but the task never reached its start ACK, so the owner is
    // told synchronously through <task_error task_id> and the row is closed
    // here instead of waiting for a background delivery that will never run.
    await persistLocalSubagentTaskTerminal({
      host: input.host,
      taskId,
      result: { failure: error },
      delivery: 'already-delivered',
    });
    return {
      status: 'failed',
      taskId,
      ...(childSession ? { subSessionId: childSession.sessionId } : {}),
      subTurnId: turnId,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const startedChildSession = childSession;
  const settled = runBackgroundLocalTaskTurn({
    host: input.host,
    taskId,
    childSession: startedChildSession,
    turnId,
    prompt: taskInput.prompt,
    target,
    requestedAgentName: target.requestedName,
    toolCtx: input.toolCtx,
    signal: shutdownSignal,
  });
  admission.bind(settled);
  void settled.catch((error) => {
    input.host.matrixLogger?.warn(
      { sessionId: startedChildSession.sessionId, turnId },
      `Local background task runner failed after error handling: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return {
    status: 'started',
    taskId,
    subSessionId: startedChildSession.sessionId,
    subTurnId: turnId,
  };
}

async function cancelAdmittedTaskSetup(input: {
  readonly input: Parameters<typeof startBackgroundLocalTask>[0];
  readonly target: LocalTaskTargetFacts;
  readonly taskId: string;
  readonly turnId: string;
  readonly childSession?: LocalSessionRecord;
  readonly shutdownSignal: AbortSignal;
}): Promise<LocalTaskBackgroundStartResult> {
  const errorMessage = abortReason(input.shutdownSignal);
  const result: LocalTaskRunResult = {
    status: 'aborted',
    requestedAgentName: input.target.requestedName,
    resolvedAgentName: input.target.resolvedAgentName,
    taskId: input.taskId,
    subTurnId: input.turnId,
    ...(input.childSession ? { subSessionId: input.childSession.sessionId } : {}),
    errorMessage,
  };
  await persistLocalSubagentTaskTerminal({
    host: input.input.host,
    taskId: input.taskId,
    result,
    delivery: 'already-delivered',
  });
  return {
    status: 'failed',
    taskId: input.taskId,
    subTurnId: input.turnId,
    ...(input.childSession ? { subSessionId: input.childSession.sessionId } : {}),
    errorMessage,
  };
}

function throwIfShuttingDown(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(abortReason(signal));
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
}

export async function drainBackgroundLocalTasksForHost(
  host: LocalTaskRunnerHostWithSessionLookup,
): Promise<void> {
  await drainBackgroundTasks(host);
}

async function runBackgroundLocalTaskTurn(input: {
  host: LocalTaskRunnerHostWithSessionLookup;
  taskId: string;
  childSession: LocalSessionRecord;
  turnId: string;
  prompt: string;
  target: LocalTaskTargetFacts;
  requestedAgentName: string;
  toolCtx: LocalRuntimeToolContext;
  signal: AbortSignal;
}): Promise<void> {
  let result:
    | Awaited<ReturnType<typeof runInjectedConversationTaskTurn>>
    | { readonly failure: unknown };
  try {
    const conversation = requireTaskConversation(input.host);
    const pluginStartContext = await input.toolCtx.pluginSubagentLifecycle?.start(
      {
        childSessionId: input.childSession.sessionId,
        childTurnId: input.turnId,
        agentId: input.childSession.sessionId,
        agentType: input.target.resolvedAgentName,
        agentTranscriptPath: resolveV2SessionArtifactPathsSync(
          input.host.configGetter().dataDir,
          input.childSession.sessionId,
          { createdAtMs: input.childSession.createdAtMs },
        ).display,
      },
      input.signal,
    );
    throwIfShuttingDown(input.signal);
    result = await runInjectedConversationTaskTurn({
      conversation,
      childSession: input.childSession,
      turnId: input.turnId,
      prompt: appendPluginHookContext(input.prompt, pluginStartContext),
      source: 'background-task',
      signal: input.signal,
      requestedAgentName: input.requestedAgentName,
      resolvedAgentName: input.target.resolvedAgentName,
      ...(input.target.canonicalRole === 'verifier' && input.target.trustedBuiltin
        ? { agentRole: 'verifier' as const }
        : {}),
      onFinish: createSubagentFinishTelemetrySink(
        input.host,
        input.target.canonicalRole ?? input.target.resolvedAgentName,
        'background',
      ),
    });
  } catch (error) {
    if (input.signal.aborted) {
      try {
        logger.warn(
          {
            taskId: input.taskId,
            sessionId: input.childSession.sessionId,
            turnId: input.turnId,
            error,
          },
          'Local background task caught an error during shutdown',
        );
      } catch {
        // Diagnostics must not prevent canceled task persistence or shutdown drain.
      }
    }
    result = input.signal.aborted
      ? {
          status: 'aborted',
          requestedAgentName: input.requestedAgentName,
          resolvedAgentName: input.target.resolvedAgentName,
          subSessionId: input.childSession.sessionId,
          subTurnId: input.turnId,
          errorMessage: abortReason(input.signal),
        }
      : { failure: error };
  }
  if ('failure' in result || result.status !== 'succeeded') {
    input.toolCtx.pluginSubagentLifecycle?.cancel(input.childSession.sessionId);
  }
  // Core terminal persistence is one attempt per execution. In particular, a
  // failed terminal write must not be reclassified as an execution failure and
  // overwrite (or race) the original outcome with a second terminal write.
  await persistLocalSubagentTaskTerminal({
    host: input.host,
    taskId: input.taskId,
    result,
    delivery: 'schedule',
  });
}

function appendPluginHookContext(prompt: string, context: string | undefined): string {
  return context?.trim()
    ? `${prompt}\n\n<plugin-hook-context>\n${context.trim()}\n</plugin-hook-context>`
    : prompt;
}
