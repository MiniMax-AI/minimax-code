import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';
import type { AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';

import { LocalTaskToolDef, type LocalTaskToolInput } from './builtin-defs.js';
import { formatLocalTaskParentReport } from './task-verification.js';
import type {
  LocalRuntimeToolContext,
  LocalTaskAdapter,
  LocalTaskBackgroundStartResult,
  LocalTaskRunResult,
} from './types.js';
import { withPluginHookCompatibleToolResponse } from '../plugin-hooks/vendor-tool-response.js';

@bindTool(LocalTaskToolDef)
export class LocalTaskTool implements ToolImpl<
  typeof LocalTaskToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalTaskAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalTaskToolInput,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    if (input.run_in_background === true && ctx.canConsumeBackgroundTaskOutput !== true) {
      const text =
        '<task_error>Background task execution requires native task_output. This Turn is missing task_output, so asynchronous task execution cannot be started. Set run_in_background=false to run the task in the foreground.</task_error>';
      return {
        tool_name: LocalTaskToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
          agent_name: input.agent_name,
          status: 'background_output_unavailable',
          error_code: 'TASK_BACKGROUND_OUTPUT_UNAVAILABLE',
        },
        isError: true,
      };
    }

    const runInBackground =
      input.run_in_background === undefined
        ? ctx.canConsumeBackgroundTaskOutput === true
        : input.run_in_background;
    if (runInBackground) {
      const started = await this.adapter.startBackground(ctx, input, signal);
      if (started.status !== 'started' || !started.taskId) {
        const errorMessage = started.errorMessage ?? 'Local background task failed to start';
        const text = `<task_error${taskIdAttribute(started.taskId)}${sessionIdAttribute(started.subSessionId)}${errorCodeAttribute(started.errorCode)}>${errorMessage}</task_error>`;
        return {
          tool_name: LocalTaskToolDef.name,
          text,
          content: [{ type: 'text', text }],
          details: {
            agent_name: input.agent_name,
            ...(started.agentDisplayName ? { agent_display_name: started.agentDisplayName } : {}),
            status: started.status,
            ...(started.taskId ? { task_id: started.taskId } : {}),
            ...(started.subSessionId ? { sub_session_id: started.subSessionId } : {}),
            ...(started.subTurnId ? { sub_turn_id: started.subTurnId } : {}),
            ...(started.errorCode ? { error_code: started.errorCode } : {}),
          },
          isError: true,
        };
      }

      const text = `<task_background task_id="${escapeXmlAttribute(started.taskId)}"${sessionIdAttribute(started.subSessionId)}${concurrencyAttributes(started.concurrency)}>\nStarted background task ${started.taskId}. The owning conversation will automatically resume when it finishes; use task_query/task_output to inspect it early and task_stop to cancel it.\n</task_background>`;
      const result: ToolResult = {
        tool_name: LocalTaskToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
          agent_name: input.agent_name,
          ...(started.agentDisplayName ? { agent_display_name: started.agentDisplayName } : {}),
          status: 'started',
          task_id: started.taskId,
          ...(started.subSessionId ? { sub_session_id: started.subSessionId } : {}),
          ...(started.subTurnId ? { sub_turn_id: started.subTurnId } : {}),
          ...(started.concurrency
            ? {
                active_child_tasks: started.concurrency.active,
                child_task_limit: started.concurrency.limit,
              }
            : {}),
        },
      };
      return started.subSessionId
        ? withPluginHookCompatibleToolResponse(result, {
            status: 'async_launched',
            agentId: started.subSessionId,
            description: input.description,
            prompt: input.prompt,
          })
        : result;
    }

    const run = await this.adapter.runForeground(ctx, input, signal, (child) => {
      onUpdate?.({
        content: [{ type: 'text', text: `Started task for ${input.agent_name}.` }],
        details: {
          agent_name: input.agent_name,
          ...(child.agentDisplayName ? { agent_display_name: child.agentDisplayName } : {}),
          status: 'started',
          sub_session_id: child.subSessionId,
          sub_turn_id: child.subTurnId,
        },
      });
    });
    if (run.status !== 'succeeded') {
      const errorMessage = run.errorMessage ?? 'Agent task failed';
      const text = `<task_error${taskIdAttribute(run.taskId)}${sessionIdAttribute(run.subSessionId)}${errorCodeAttribute(run.errorCode)}>\n${formatLocalTaskParentReport(
        {
          ...run,
          errorMessage,
        },
      )}\n</task_error>`;
      return {
        tool_name: LocalTaskToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
          agent_name: input.agent_name,
          ...(run.agentDisplayName ? { agent_display_name: run.agentDisplayName } : {}),
          status: run.status,
          ...(run.taskId ? { task_id: run.taskId } : {}),
          ...(run.subSessionId ? { sub_session_id: run.subSessionId } : {}),
          ...(run.subTurnId ? { sub_turn_id: run.subTurnId } : {}),
          ...(run.eventCount !== undefined ? { event_count: run.eventCount } : {}),
          requested_agent_name: run.requestedAgentName,
          ...(run.resolvedAgentName ? { resolved_agent_name: run.resolvedAgentName } : {}),
          ...(run.finalText !== undefined ? { final_text: run.finalText } : {}),
          ...(run.verification ? { verification: run.verification } : {}),
          error_message: errorMessage,
          ...(run.errorCode ? { error_code: run.errorCode } : {}),
          ...savedPtcScriptDetails(run),
        },
        isError: true,
      };
    }

    const text = `<task_result${taskIdAttribute(run.taskId)}${sessionIdAttribute(run.subSessionId)}>\n${formatLocalTaskParentReport(run)}\n</task_result>`;
    const result: ToolResult = {
      tool_name: LocalTaskToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: {
        agent_name: input.agent_name,
        ...(run.agentDisplayName ? { agent_display_name: run.agentDisplayName } : {}),
        status: 'succeeded',
        ...(run.taskId ? { task_id: run.taskId } : {}),
        ...(run.subSessionId ? { sub_session_id: run.subSessionId } : {}),
        ...(run.subTurnId ? { sub_turn_id: run.subTurnId } : {}),
        ...(run.eventCount !== undefined ? { event_count: run.eventCount } : {}),
        requested_agent_name: run.requestedAgentName,
        ...(run.resolvedAgentName ? { resolved_agent_name: run.resolvedAgentName } : {}),
        ...(run.finalText !== undefined ? { final_text: run.finalText } : {}),
        ...(run.verification ? { verification: run.verification } : {}),
        ...savedPtcScriptDetails(run),
      },
    };
    return run.subSessionId
      ? withPluginHookCompatibleToolResponse(result, {
          status: 'completed',
          agentId: run.subSessionId,
          content: [{ type: 'text', text: run.finalText ?? '' }],
        })
      : result;
  }
}

/**
 * The scripts the child saved, for the parent Turn's save metric. A failed or
 * aborted run carries them too: the files are already on disk.
 */
function savedPtcScriptDetails(run: LocalTaskRunResult): {
  readonly saved_ptc_scripts?: readonly { readonly path: string; readonly scope: string }[];
} {
  return run.savedPtcScripts?.length
    ? {
        saved_ptc_scripts: run.savedPtcScripts.map((script) => ({
          path: script.path,
          scope: script.scope,
        })),
      }
    : {};
}

/**
 * The first receipt carries both handles: `task_id` drives task_query /
 * task_output / task_stop, `session_id` drives session send.
 */
function taskIdAttribute(taskId: string | undefined): string {
  return taskId ? ` task_id="${escapeXmlAttribute(taskId)}"` : '';
}

function sessionIdAttribute(sessionId: string | undefined): string {
  return sessionId ? ` session_id="${escapeXmlAttribute(sessionId)}"` : '';
}

function concurrencyAttributes(concurrency: LocalTaskBackgroundStartResult['concurrency']): string {
  return concurrency
    ? ` active_child_tasks="${String(concurrency.active)}" child_task_limit="${String(concurrency.limit)}"`
    : '';
}

function errorCodeAttribute(errorCode: string | undefined): string {
  return errorCode ? ` code="${escapeXmlAttribute(errorCode)}"` : '';
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
