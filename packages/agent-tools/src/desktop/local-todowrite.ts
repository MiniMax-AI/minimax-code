import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';
import { updateTodoState } from '@mavis/system-reminder';

import { LocalTodoWriteToolDef, type LocalTodoWriteToolInput } from './builtin-defs.js';
import type { LocalRuntimeToolContext, LocalTodoEventSink } from './types.js';
import { withDesktopCompletenessReport } from './ptc-result-projection.js';

type TodoItem = LocalTodoWriteToolInput['todos'][number];

const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
const TODO_WRITE_SUCCESS = 'success';
const todosBySession = new Map<string, TodoItem[]>();

@bindTool(LocalTodoWriteToolDef)
export class LocalTodoWriteTool implements ToolImpl<
  typeof LocalTodoWriteToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly eventSink?: LocalTodoEventSink) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalTodoWriteToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    const todos = Array.isArray(input.todos) ? input.todos : [];
    if (todos.length === 0) {
      todosBySession.delete(ctx.sessionId);
    } else {
      todosBySession.set(ctx.sessionId, [...todos]);
    }

    try {
      updateTodoState(ctx.sessionId, todos);
    } catch {
      // Reminder state is best-effort and should not block the tool result.
    }

    let eventEmitted = false;
    if (this.eventSink) {
      try {
        eventEmitted = await this.eventSink.emitTodoUpdated(ctx, todos, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        // The structured todo state and tool result are authoritative. A
        // side-stream delivery failure must not fail the provider tool call.
      }
    }

    const active = todos.filter((t) => !TERMINAL_STATUSES.has(t.status)).length;
    const completed = todos.filter((t) => t.status === 'completed').length;
    const cancelled = todos.filter((t) => t.status === 'cancelled').length;
    const text = TODO_WRITE_SUCCESS;
    return withDesktopCompletenessReport(
      LocalTodoWriteToolDef.name,
      {
        tool_name: LocalTodoWriteToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
          todos,
          total: todos.length,
          active,
          completed,
          cancelled,
          event_emitted: eventEmitted,
        },
      },
      { data: { total: todos.length, active, completed, cancelled } },
    );
  }
}

export function getLocalSessionTodos(sessionId: string): TodoItem[] {
  const todos = todosBySession.get(sessionId);
  return todos ? [...todos] : [];
}

export function _resetLocalTodoWriteStateForTests(): void {
  todosBySession.clear();
}
