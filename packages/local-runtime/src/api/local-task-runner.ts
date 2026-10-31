import type {
  LocalRuntimeToolContext,
  LocalTaskAdapter,
  LocalTaskRunResult,
  LocalTaskToolInput,
} from '@mavis/agent-tools/desktop';

import { createSubagentFinishTelemetrySink } from '../agent/subagent-telemetry.js';
import { createBackgroundTaskId } from '../background-task/domain.js';
import { startBackgroundLocalTask } from '../background-task/runner.js';
import { createLocalSubagentTaskRow } from '../background-task/subagent-task-row.js';
import { persistLocalSubagentTaskTerminal } from '../background-task/terminal.js';
import { taskTurnId } from '../background-task/turn-id.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import { runInjectedConversationTaskTurn } from './injected-conversation-task-turn.js';
import type { LocalTaskRunnerHostWithSessionLookup } from './local-task-host.js';
import { requireTaskConversation } from './local-task-host.js';
import { normalizeLocalTaskInput, taskModelSelectionFor } from './local-task-input.js';
import { resolveLocalTaskAgentTarget, taskSessionOwner } from './local-task-subagents.js';
import { resolveV2SessionArtifactPathsSync } from '../persistence/layout/v2-session-artifacts.js';

export type {
  LocalTaskRunnerHost,
  LocalTaskRunnerHostWithSessionLookup,
} from './local-task-host.js';

export function buildLocalTaskAdapter(
  host: LocalTaskRunnerHostWithSessionLookup,
  parentSession: LocalSessionRecord,
): LocalTaskAdapter {
  return {
    runForeground: (toolCtx, taskInput, signal) =>
      runForegroundLocalTask({ host, parentSession, toolCtx, taskInput, signal }),
    startBackground: (toolCtx, taskInput, signal) =>
      startBackgroundLocalTask({ host, parentSession, toolCtx, taskInput, signal }),
  };
}

export async function runForegroundLocalTask(input: {
  host: LocalTaskRunnerHostWithSessionLookup;
  parentSession: LocalSessionRecord;
  toolCtx: LocalRuntimeToolContext;
  taskInput: LocalTaskToolInput;
  /** Submitter-owned provenance forwarded verbatim into the child Turn's origin. */
  origin?: unknown;
  /** Best-effort observation after the child Session becomes queryable. */
  onChildStarted?: (input: { readonly subSessionId: string; readonly subTurnId: string }) => void;
  signal?: AbortSignal;
}): Promise<LocalTaskRunResult> {
  if (input.signal?.aborted) throw new Error('Operation aborted');
  const taskInput = normalizeLocalTaskInput(input.taskInput);
  const conversation = requireTaskConversation(input.host);
  const target = await resolveLocalTaskAgentTarget(
    input.host,
    taskInput.agent_name,
    input.toolCtx.pluginAgents,
  );
  if (!target) {
    // No runnable target, so there is nothing to track: the failure carries no
    // task handle because no task row was ever created.
    return {
      status: 'failed',
      requestedAgentName: taskInput.agent_name,
      errorMessage: `Unknown agent: ${taskInput.agent_name}`,
    };
  }
  const agentName = target.resolvedAgentName;
  const taskModelSelection = taskModelSelectionFor(taskInput);

  // A foreground run uses the same task state machine as a background one, so
  // an exception anywhere below still leaves a terminal row with an output the
  // owner can re-read through task_output.
  const taskId = createBackgroundTaskId();
  const turnId = taskTurnId(taskId);
  await createLocalSubagentTaskRow({
    host: input.host,
    taskId,
    turnId,
    executionMode: 'foreground',
    ownerSessionId: input.parentSession.sessionId,
    toolCtx: input.toolCtx,
    taskInput,
    target,
  });

  let childSession: LocalSessionRecord | undefined;
  try {
    childSession = await input.host.agentRoutes.createSession({
      ...taskSessionOwner(target),
      workspaceDir: input.parentSession.workspaceDir || input.host.resolveDefaultWorkspaceDir(),
      sessionType: 'branch',
      sessionKind: 'task',
      parentSessionId: input.parentSession.sessionId,
      title: taskInput.description,
      visibility: 'hidden',
      purpose: `local-task:${input.toolCtx.turnId}:${input.toolCtx.toolCallId ?? 'tool'}`,
      runLocation: input.parentSession.runLocation,
      appMode: input.parentSession.appMode,
      isDefaultWorkspace: input.parentSession.isDefaultWorkspace,
      ...(taskModelSelection ? { taskModelSelection } : {}),
    });
    await input.host.backgroundTaskService.patch(taskId, {
      status: 'running',
      startedAt: input.host.nowMs(),
      metadata: { childSessionId: childSession.sessionId, subTurnId: turnId, agentName },
    });
    try {
      input.onChildStarted?.({ subSessionId: childSession.sessionId, subTurnId: turnId });
    } catch {
      // Diagnostic observation must never change task execution.
    }
    const pluginStartContext = await input.toolCtx.pluginSubagentLifecycle?.start(
      {
        childSessionId: childSession.sessionId,
        childTurnId: turnId,
        agentId: childSession.sessionId,
        agentType: agentName,
        agentTranscriptPath: resolveV2SessionArtifactPathsSync(
          input.host.configGetter().dataDir,
          childSession.sessionId,
          { createdAtMs: childSession.createdAtMs },
        ).display,
      },
      input.signal,
    );
    const result = await runInjectedConversationTaskTurn({
      conversation,
      childSession,
      turnId,
      prompt: appendPluginHookContext(taskInput.prompt, pluginStartContext),
      source: 'task',
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      requestedAgentName: target.requestedName,
      resolvedAgentName: agentName,
      ...(target.canonicalRole === 'verifier' && target.trustedBuiltin
        ? { agentRole: 'verifier' as const }
        : {}),
      onFinish: createSubagentFinishTelemetrySink(
        input.host,
        target.canonicalRole ?? target.resolvedAgentName,
        'foreground',
      ),
      signal: input.signal,
    });
    await finalizeForegroundTask(input.host, taskId, result, turnId);
    if (result.status !== 'succeeded') {
      input.toolCtx.pluginSubagentLifecycle?.cancel(childSession.sessionId);
    }
    return { ...result, taskId };
  } catch (error) {
    if (childSession) input.toolCtx.pluginSubagentLifecycle?.cancel(childSession.sessionId);
    const failure: LocalTaskRunResult = {
      status: 'failed',
      requestedAgentName: target.requestedName,
      resolvedAgentName: agentName,
      ...(childSession ? { subSessionId: childSession.sessionId } : {}),
      subTurnId: turnId,
      errorMessage: error instanceof Error ? error.message : String(error),
      taskId,
    };
    await finalizeForegroundTask(input.host, taskId, failure, turnId);
    return failure;
  }
}

function appendPluginHookContext(prompt: string, context: string | undefined): string {
  return context?.trim()
    ? `${prompt}\n\n<plugin-hook-context>\n${context.trim()}\n</plugin-hook-context>`
    : prompt;
}

/**
 * The foreground tool result is already the owner-visible delivery, so the row
 * is latched as delivered and must never produce a second
 * background-task-finished wake-up.
 */
async function finalizeForegroundTask(
  host: LocalTaskRunnerHostWithSessionLookup,
  taskId: string,
  result: LocalTaskRunResult,
  turnId: string,
): Promise<void> {
  try {
    await persistLocalSubagentTaskTerminal({
      host,
      taskId,
      result,
      delivery: 'already-delivered',
    });
  } catch (error) {
    // Persistence is the only failure that cannot be reported through the task
    // row itself; the run result still reaches the owner synchronously.
    host.matrixLogger?.warn(
      { sessionId: result.subSessionId ?? '', turnId },
      `Local foreground task ${taskId} could not persist its terminal state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
