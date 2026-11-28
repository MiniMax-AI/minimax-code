import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { LocalTaskAppendToolDef, type LocalTaskAppendToolInput } from './builtin-defs.js';
import type { LocalRuntimeToolContext, LocalTaskAppendAdapter } from './types.js';

interface TaskAppendFailure {
  readonly code: string;
  readonly status: number;
  readonly message: string;
}

@bindTool(LocalTaskAppendToolDef)
export class LocalTaskAppendTool implements ToolImpl<
  typeof LocalTaskAppendToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalTaskAppendAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalTaskAppendToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const taskId = input.task_id?.trim() ?? '';
    const content = input.content?.trim() ?? '';
    if (!taskId) {
      return failure(taskId, {
        code: 'INVALID_ARGUMENT',
        status: 400,
        message: 'task_append requires a task_id.',
      });
    }
    if (!content) {
      return failure(taskId, {
        code: 'INVALID_ARGUMENT',
        status: 400,
        message: 'task_append content must not be empty after trimming.',
      });
    }
    // An abort before admission must not deliver anything; after admission the
    // child keeps running and is only stopped through task_stop.
    if (signal?.aborted) {
      return failure(taskId, {
        code: 'TASK_APPEND_ABORTED',
        status: 409,
        message: 'task_append was aborted before Turn admission.',
      });
    }

    let result;
    try {
      result = await this.adapter.append(ctx, { taskId, content }, signal);
    } catch (error) {
      const mapped = toTaskAppendFailure(error);
      if (!mapped) throw error;
      return failure(taskId, mapped);
    }

    const text = `<task_append task_id="${escapeXmlAttribute(result.taskId)}" mode="${result.mode}" accepted="true" />`;
    return {
      tool_name: LocalTaskAppendToolDef.name,
      text,
      content: [{ type: 'text', text }],
      // Runtime evidence lets the UI join the durable lifecycle for this exact
      // round. The model still uses the task handle to read or stop the work.
      details: {
        task_id: result.taskId,
        mode: result.mode,
        accepted: true,
        ...(result.subSessionId ? { sub_session_id: result.subSessionId } : {}),
        ...(result.subTurnId ? { sub_turn_id: result.subTurnId } : {}),
      },
    };
  }
}

function toTaskAppendFailure(error: unknown): TaskAppendFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const candidate = error as Error & { code?: unknown; status?: unknown };
  return typeof candidate.code === 'string' && typeof candidate.status === 'number'
    ? { code: candidate.code, status: candidate.status, message: error.message }
    : undefined;
}

function failure(taskId: string, error: TaskAppendFailure): ToolResult {
  const text = `<task_append_error task_id="${escapeXmlAttribute(taskId)}" code="${error.code}">${error.message}</task_append_error>`;
  return {
    tool_name: LocalTaskAppendToolDef.name,
    text,
    content: [{ type: 'text', text }],
    details: {
      task_id: taskId,
      code: error.code,
      status: error.status,
      accepted: false,
      error_message: error.message,
    },
    isError: true,
  };
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
