import type { LocalRuntimeToolContext, LocalTaskRunResult } from '@mavis/agent-tools/desktop';
import {
  RuntimeConversationShutdownError,
  type ConversationTurnResult,
} from '@mavis/conversation-contract';

import type { BackgroundTask } from '../background-task/domain.js';
import { admitBackgroundTask, type BackgroundTaskAdmission } from '../background-task/lifecycle.js';
import { persistLocalSubagentTaskTerminal } from '../background-task/terminal.js';
import { taskTurnId } from '../background-task/turn-id.js';
import { logger } from '../common/logger.js';
import type { LocalTaskRunnerHostWithSessionLookup } from './local-task-host.js';

/**
 * This process's claim on an activated append: the same claim `runner.ts` and
 * `bash-runner.ts` take for their tasks. Without it a Session stop cascade reads
 * the append row as another process's work, so it neither stops the append nor
 * sweeps what its child Turn spawned — while the row is already registered for
 * delivery suppression, leaving the work running with its notice hidden.
 */
export interface AppendAdmission {
  /** Hands the claim to the completion handler, which writes the terminal row first. */
  bind(settled: Promise<void>): void;
  /** Drops the claim of an activation that did not go through; a no-op once settled. */
  release(reason: string): void;
}

interface AppendAdmissionFields {
  readonly taskId: string;
  readonly childSessionId: string;
  readonly turnId: string;
}

/**
 * Taken inside the activation guard, before the row is persisted, so a cascade that
 * can read the row always finds the claim. Steered and duplicate appends never get
 * here: they create no row and start no Turn, so they have nothing to claim.
 */
export function admitAppendActivation(
  host: LocalTaskRunnerHostWithSessionLookup,
  taskId: string,
  childSessionId: string,
): AppendAdmission {
  const fields = { taskId, childSessionId, turnId: taskTurnId(taskId) };
  let admission: BackgroundTaskAdmission;
  try {
    // Shutdown aborts every claimed task through this callback and the host drain
    // then waits for it, so the abort has to reach the child Turn itself.
    admission = admitBackgroundTask(host, (reason) => abortAppendTurn(host, fields, reason));
  } catch (error) {
    // `admitBackgroundTask` only throws once the Local Runtime is shutting down.
    // As a shutting-down Runtime Conversation it maps to the append contract's
    // 503 TASK_APPEND_UNAVAILABLE, rather than escaping as an uncontracted error.
    logAppendAdmission('warn', 'closing_rejected', { ...fields, error: errorText(error) });
    throw new RuntimeConversationShutdownError(errorText(error), { cause: error });
  }
  admission.identify(taskId);
  logAppendAdmission('info', 'identified', fields);
  let settled = false;
  return {
    bind: (completion) => {
      if (settled) {
        logAppendAdmission('warn', 'bind_after_release', fields);
        return;
      }
      settled = true;
      admission.bind(completion);
      logAppendAdmission('info', 'bound', fields);
    },
    release: (reason) => {
      if (settled) return;
      settled = true;
      admission.release();
      logAppendAdmission('info', 'released', { ...fields, reason });
    },
  };
}

/**
 * The exact abort the task's `stopRuntime` issues (`api/host.ts`). It runs inside
 * the shutdown fan-out over every claimed task, so it must never throw.
 */
function abortAppendTurn(
  host: LocalTaskRunnerHostWithSessionLookup,
  fields: AppendAdmissionFields,
  reason: string,
): void {
  try {
    const conversation = host.runtimeConversation;
    if (!conversation) {
      logAppendAdmission('warn', 'abort_unavailable', { ...fields, reason });
      return;
    }
    logAppendAdmission('info', 'abort_requested', { ...fields, reason });
    void conversation.ingress
      .abort(fields.childSessionId, 'lifecycle', fields.turnId)
      .catch((error: unknown) => {
        logAppendAdmission('warn', 'abort_failed', { ...fields, error: errorText(error) });
      });
  } catch (error) {
    logAppendAdmission('warn', 'abort_failed', { ...fields, error: errorText(error) });
  }
}

function logAppendAdmission(
  level: 'info' | 'warn',
  event: string,
  fields: Record<string, unknown>,
): void {
  try {
    logger[level](
      { event: `task_append_admission_${event}`, ...fields },
      `task_append admission: ${event}`,
    );
  } catch {
    // Diagnostics must never change admission or shutdown behavior.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAppendTaskRow(args: {
  host: LocalTaskRunnerHostWithSessionLookup;
  taskId: string;
  turnId: string;
  sourceTask: BackgroundTask;
  childSessionId: string;
  toolCtx: LocalRuntimeToolContext;
}): Promise<BackgroundTask> {
  const now = args.host.nowMs();
  const sourceMetadata = args.sourceTask.metadata ?? {};
  return args.host.backgroundTaskService.create({
    taskId: args.taskId,
    kind: 'subagent',
    // The Turn is already admitted, so the row is never queued.
    status: 'running',
    ownerSessionId: args.toolCtx.sessionId,
    ...(args.sourceTask.description ? { description: args.sourceTask.description } : {}),
    ...(args.toolCtx.toolCallId ? { toolCallId: args.toolCtx.toolCallId } : {}),
    parentTaskId: args.sourceTask.taskId,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    metadata: {
      ...inheritedAgentMetadata(sourceMetadata),
      parentSessionId: args.toolCtx.sessionId,
      parentTurnId: args.toolCtx.turnId,
      childSessionId: args.childSessionId,
      subTurnId: args.turnId,
      executionMode: 'append',
    },
  });
}

const INHERITED_AGENT_METADATA_KEYS = [
  'agentName',
  'requestedAgentName',
  'resolvedAgentName',
  'exactOwnerName',
  'trustedBuiltin',
  'canonicalRole',
] as const;

function inheritedAgentMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const inherited: Record<string, unknown> = {};
  for (const key of INHERITED_AGENT_METADATA_KEYS) {
    if (metadata[key] !== undefined) inherited[key] = metadata[key];
  }
  return inherited;
}

/**
 * §7.1: exactly one background handler per activated append. Success, failure,
 * abort and completion rejection all reach the shared terminal writer, so the
 * row cannot stay `running` and the owner is notified through the existing
 * background delivery.
 */
export function registerAppendCompletion(args: {
  host: LocalTaskRunnerHostWithSessionLookup;
  taskId: string;
  turnId: string;
  childSessionId: string;
  completion: Promise<ConversationTurnResult>;
  sourceTask: BackgroundTask;
  admission?: AppendAdmission;
}): void {
  const settled = (async () => {
    let result: LocalTaskRunResult | { failure: unknown };
    try {
      result = toAppendRunResult(await args.completion, args.sourceTask, args.childSessionId);
    } catch (error) {
      result = { failure: error };
    }
    await persistLocalSubagentTaskTerminal({
      host: args.host,
      taskId: args.taskId,
      result,
      delivery: 'schedule',
    });
  })();
  // The claim ends only after the terminal row is written: a stop cascade that no
  // longer finds the claim re-reads the row and must then see it terminal.
  if (args.admission) {
    args.admission.bind(settled);
  } else {
    // Every activation passes the accept guard that takes the claim; a missing one
    // means a stop cascade would skip this row as another process's work.
    logAppendAdmission('warn', 'unclaimed_activation', {
      taskId: args.taskId,
      childSessionId: args.childSessionId,
      turnId: args.turnId,
    });
  }
  void settled.catch((error: unknown) => {
    args.host.matrixLogger?.warn(
      { sessionId: args.childSessionId, turnId: args.turnId },
      `task_append could not persist the terminal state of task ${args.taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

/**
 * A compatibility/delivery failure can occur after the activation guard has
 * durably created the candidate row but before the caller receives an ACK.
 * That row belongs only to this activation, so it gets the same terminal
 * writer and owner notification as an execution failure. Active-steer errors
 * intentionally never enter here: they operate on someone else's task row.
 */
export async function persistActivatedAppendAdmissionFailure(args: {
  host: LocalTaskRunnerHostWithSessionLookup;
  taskId: string;
  childSessionId: string;
  turnId: string;
  error: unknown;
}): Promise<void> {
  try {
    await persistLocalSubagentTaskTerminal({
      host: args.host,
      taskId: args.taskId,
      result: { failure: args.error },
      delivery: 'schedule',
    });
  } catch (terminalError) {
    args.host.matrixLogger?.warn(
      { sessionId: args.childSessionId, turnId: args.turnId },
      `task_append could not persist the post-admission failure for task ${args.taskId}: ${
        terminalError instanceof Error ? terminalError.message : String(terminalError)
      }`,
    );
  }
}

function toAppendRunResult(
  result: ConversationTurnResult,
  sourceTask: BackgroundTask,
  childSessionId: string,
): LocalTaskRunResult {
  const finalText = result.messages
    .filter((message) => message.role === 'assistant' && message.text)
    .map((message) => message.text)
    .join('\n')
    .trim();
  const metadata = sourceTask.metadata ?? {};
  const requestedAgentName =
    stringMetadata(metadata.requestedAgentName) ??
    stringMetadata(metadata.resolvedAgentName) ??
    stringMetadata(metadata.agentName) ??
    'unknown';
  const resolvedAgentName =
    stringMetadata(metadata.resolvedAgentName) ?? stringMetadata(metadata.agentName);
  return {
    status:
      result.status === 'completed'
        ? 'succeeded'
        : result.status === 'aborted'
          ? 'aborted'
          : 'failed',
    requestedAgentName,
    ...(resolvedAgentName ? { resolvedAgentName } : {}),
    subSessionId: childSessionId,
    subTurnId: result.turnId,
    ...(finalText ? { finalText } : {}),
    ...(result.status === 'completed'
      ? {}
      : { errorMessage: result.error ?? `Conversation turn ${result.status}` }),
  };
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
