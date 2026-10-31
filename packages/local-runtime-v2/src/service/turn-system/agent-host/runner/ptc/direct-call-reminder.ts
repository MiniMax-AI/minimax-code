import type { PiAfterToolCallHook } from '@mavis/agent-core/pi-turn-runner';

/**
 * Reminder for a run_code child the model called directly on a PTC Turn.
 *
 * The call runs as the native tool; the model then reads, at the end of the
 * result of the last such call in its reply, a reminder naming every child it
 * called directly there and to use run_code next. A call whose arguments
 * stayed invalid already ends with a run_code line and gets no reminder.
 * @internal Exported for focused tests.
 */
export function renderDirectCallReminder(toolNames: readonly string[]): string {
  const names = [...new Set(toolNames)].sort();
  const [first] = names;
  if (!first) throw new Error('renderDirectCallReminder needs at least one tool name');
  const example =
    first === 'bash' && names.length === 1
      ? 'await tools.bash({ command: ... })'
      : `await tools[${JSON.stringify(first)}]({ ... })`;
  const pronoun = names.length === 1 ? 'it' : 'them';
  return [
    '<system-reminder>',
    `Do not call ${joinNames(names)} directly in this turn. Call ${pronoun} inside run_code: ${example}. Put your next tool calls in one run_code program.`,
    '</system-reminder>',
  ].join('\n');
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export interface DirectCallReminderLog {
  (fields: {
    readonly tool: string;
    readonly tool_call_id: string;
    readonly appended: boolean;
  }): void;
}

export interface DirectCallReminder {
  /** Records a direct call the host resolved; `valid` is false when its arguments stayed invalid. */
  noteResolved(toolCall: { readonly id: string; readonly name: string }, valid: boolean): void;
  /** Appends the reminder to the last direct call of each reply. Install it after other hooks. */
  readonly afterToolCall: PiAfterToolCallHook;
}

/**
 * Pi asks the host about every uncataloged call of a reply before running any
 * of them, so by the time a result is finalized this knows all direct calls of
 * that reply. A call whose arguments stayed invalid never reaches the
 * after-tool hook; it is logged when it is resolved.
 */
export function createDirectCallReminder(log: DirectCallReminderLog): DirectCallReminder {
  const resolved = new Map<string, string>();
  return {
    noteResolved(toolCall, valid) {
      resolved.set(toolCall.id, toolCall.name);
      if (!valid) log({ tool: toolCall.name, tool_call_id: toolCall.id, appended: false });
    },
    afterToolCall: (context) => {
      const id = context.toolCall.id;
      if (context.parentToolCallId !== undefined || !resolved.has(id)) return undefined;
      const direct = context.assistantMessage.content.filter(
        (block): block is Extract<typeof block, { readonly type: 'toolCall' }> =>
          block.type === 'toolCall' && resolved.has(block.id),
      );
      const appended = direct.at(-1)?.id === id;
      log({ tool: context.toolCall.name, tool_call_id: id, appended });
      if (!appended) return undefined;
      const reminder = renderDirectCallReminder(direct.map((call) => call.name));
      return { content: [...context.result.content, { type: 'text', text: reminder }] };
    },
  };
}
