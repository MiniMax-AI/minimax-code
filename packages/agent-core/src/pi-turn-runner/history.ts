import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { PiBeforeLlmCallReplaceMetadata, PiHistoryChangedHookInput } from './hooks.js';
import type { NonLLMTurnErrorKind } from './metrics.js';
import type { turnState } from './turn.js';

export interface turnHistory {
  replace(
    messages: AgentMessage[],
    previousMessages: AgentMessage[],
    metadata: PiBeforeLlmCallReplaceMetadata,
  ): Promise<void>;
  flushTail(): Promise<void>;
  /** A history change failed to persist; nothing is written for the rest of the Turn. */
  deliveryFailed(): boolean;
}

export function newHistory(turn: turnState, agent: Agent): turnHistory {
  // Cursor into agent.state.messages. Initial history belongs to the caller
  // and must not be re-sent through onHistoryChangedHook.
  let lastSnapshotLength = turn.initialMessages.length;
  let deliveryFailure: Error | undefined;

  const notify = async (change: PiHistoryChangedHookInput): Promise<void> => {
    if (turn.hooks.onHistory.length === 0) return;
    for (const hook of turn.hooks.onHistory) {
      await hook(change);
    }
  };

  const deliver = async (change: PiHistoryChangedHookInput): Promise<boolean> => {
    if (deliveryFailure) throw deliveryFailure;
    try {
      await notify(change);
      return true;
    } catch (err) {
      deliveryFailure = err instanceof Error ? err : new Error(String(err));
      turn.metrics.tryRecordTerminalFailure(
        { errorSource: 'history', errorKind: historyFailureKind(err) },
        err,
      );
      try {
        const errors = flattenHistoryErrors(err);
        const loggedErrors = errors.slice(0, MAX_LOGGED_HISTORY_ERRORS);
        const loggedMessages = selectHistoryMessages(change.messages);
        const toolCalls = summarizeToolCalls(loggedMessages);
        turn.logger.error(
          {
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            reason: change.reason,
            message_count: change.messages.length,
            message_roles: loggedMessages.map(({ message }) => readMessageRole(message)),
            tool_names: loggedMessages.flatMap(({ message }) => readToolName(message)),
            history_cursor: lastSnapshotLength,
            agent_message_count: agent.state.messages.length,
            history_messages: loggedMessages.map(({ message, index }) =>
              summarizeHistoryMessage(message, index),
            ),
            sampled_tool_call_count: toolCalls.count,
            tool_calls: toolCalls.entries,
            ...(toolCalls.count > toolCalls.entries.length
              ? { truncated_tool_call_count: toolCalls.count - toolCalls.entries.length }
              : {}),
            tool_results: loggedMessages.flatMap(({ message }) => readToolResult(message)),
            ...(change.messages.length > loggedMessages.length
              ? { truncated_message_count: change.messages.length - loggedMessages.length }
              : {}),
            error_count: errors.length,
            errors: loggedErrors.map(summarizeHistoryError),
            ...(errors.length > loggedErrors.length
              ? { truncated_error_count: errors.length - loggedErrors.length }
              : {}),
            error: truncateHistoryText(describeHistoryError(err), MAX_HISTORY_ERROR_MESSAGE_LENGTH),
          },
          '[pi-turn-runner] history delivery failed',
        );
      } catch {
        // History persistence remains the root failure when diagnostics are unavailable.
      }
      throw err;
    }
  };

  return {
    async replace(messages, previousMessages, metadata): Promise<void> {
      const delivered = await deliver({
        sessionId: turn.input.sessionId,
        turnId: turn.input.turnId,
        reason: 'replaceMessages',
        messages: [...messages],
        previousMessages,
        metadata,
      });
      if (delivered) lastSnapshotLength = messages.length;
    },
    async flushTail(): Promise<void> {
      if (deliveryFailure) return;
      const total = agent.state.messages.length;
      if (total <= lastSnapshotLength) return;
      const delta = agent.state.messages.slice(lastSnapshotLength, total);
      const assistantMessageIds = delta.flatMap((message, index) => {
        const messageId = turn.assistantMessageIds.get(message);
        return messageId ? [{ index, messageId }] : [];
      });
      const delivered = await deliver({
        sessionId: turn.input.sessionId,
        turnId: turn.input.turnId,
        reason: 'messageDelta',
        messages: [...delta],
        ...(assistantMessageIds.length > 0 ? { assistantMessageIds } : {}),
      });
      if (delivered) lastSnapshotLength = total;
    },
    deliveryFailed: () => deliveryFailure !== undefined,
  };
}

function readMessageRole(message: AgentMessage): string {
  return typeof message.role === 'string' && message.role.length > 0
    ? truncateHistoryText(message.role, MAX_HISTORY_ROLE_LENGTH)
    : 'unknown';
}

function readToolName(message: AgentMessage): string[] {
  return message.role === 'toolResult' && message.toolName.length > 0
    ? [truncateHistoryText(message.toolName, MAX_HISTORY_IDENTIFIER_LENGTH)]
    : [];
}

function summarizeHistoryMessage(
  message: AgentMessage,
  index: number,
): Readonly<Record<string, unknown>> {
  const content = Reflect.get(message, 'content');
  return {
    index,
    role: readMessageRole(message),
    content_types: readContentTypes(content),
    ...(Array.isArray(content) ? { content_part_count: content.length } : {}),
  };
}

const MAX_LOGGED_HISTORY_MESSAGES = 24;
const LOGGED_HISTORY_HEAD_MESSAGES = 4;
const MAX_LOGGED_HISTORY_TOOL_CALLS = 24;
const MAX_SCANNED_HISTORY_CONTENT_PARTS = 64;
const MAX_LOGGED_HISTORY_CONTENT_TYPES = 8;
const MAX_HISTORY_ROLE_LENGTH = 64;
const MAX_HISTORY_IDENTIFIER_LENGTH = 256;

function selectHistoryMessages(
  messages: readonly AgentMessage[],
): readonly { readonly message: AgentMessage; readonly index: number }[] {
  if (messages.length <= MAX_LOGGED_HISTORY_MESSAGES) {
    return messages.map((message, index) => ({ message, index }));
  }
  const head = messages
    .slice(0, LOGGED_HISTORY_HEAD_MESSAGES)
    .map((message, index) => ({ message, index }));
  const tailStart = messages.length - (MAX_LOGGED_HISTORY_MESSAGES - LOGGED_HISTORY_HEAD_MESSAGES);
  const tail = messages.slice(tailStart).map((message, offset) => ({
    message,
    index: tailStart + offset,
  }));
  return [...head, ...tail];
}

function readContentTypes(content: unknown): readonly string[] {
  if (typeof content === 'string') return ['text'];
  if (!Array.isArray(content)) return [];
  return [
    ...new Set(
      content.slice(0, MAX_SCANNED_HISTORY_CONTENT_PARTS).map((part) => {
        if (typeof part === 'string') return 'text';
        if (part && typeof part === 'object') {
          const type = Reflect.get(part, 'type');
          if (typeof type === 'string' && type.length > 0) {
            return truncateHistoryText(type, MAX_HISTORY_ROLE_LENGTH);
          }
        }
        return typeof part;
      }),
    ),
  ].slice(0, MAX_LOGGED_HISTORY_CONTENT_TYPES);
}

function summarizeToolCalls(messages: readonly { readonly message: AgentMessage }[]): {
  readonly count: number;
  readonly entries: readonly Readonly<Record<string, unknown>>[];
} {
  const summary: {
    count: number;
    entries: Readonly<Record<string, unknown>>[];
  } = { count: 0, entries: [] };
  messages.forEach(({ message }) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
    message.content.forEach((part) => {
      if (part.type !== 'toolCall') return;
      summary.count += 1;
      if (summary.entries.length >= MAX_LOGGED_HISTORY_TOOL_CALLS) return;
      summary.entries.push({
        tool_name: truncateHistoryText(part.name, MAX_HISTORY_IDENTIFIER_LENGTH),
        tool_call_id: truncateHistoryText(part.id, MAX_HISTORY_IDENTIFIER_LENGTH),
      });
    });
  });
  return summary;
}

function readToolResult(message: AgentMessage): readonly Readonly<Record<string, unknown>>[] {
  if (message.role !== 'toolResult') return [];
  return [
    {
      tool_name: truncateHistoryText(message.toolName, MAX_HISTORY_IDENTIFIER_LENGTH),
      tool_call_id: truncateHistoryText(message.toolCallId, MAX_HISTORY_IDENTIFIER_LENGTH),
      is_error: message.isError === true,
    },
  ];
}

const MAX_LOGGED_HISTORY_ERRORS = 4;
const MAX_HISTORY_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_HISTORY_ERROR_STACK_LENGTH = 4_096;

function flattenHistoryErrors(error: unknown): readonly unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  return error.errors.flatMap(flattenHistoryErrors);
}

const DUPLICATE_APPEND_MESSAGE = 'Canonical history append identity is duplicated';

/**
 * @internal Exported only for focused tests.
 *
 * Which kind of history write failure this is.
 *
 * The three concurrency and ordering conflicts are counted apart from a real
 * storage failure: they all used to land in `persistence`, which left the
 * dashboards and alerts unable to tell "the object store is unhealthy" from
 * "two writers raced" or "an append reused an existing identity".
 *
 * - `revision_conflict`: the revision checked before writing no longer matches,
 *   so another writer moved the object and this write was refused;
 * - `duplicate_append`: an append reuses an identity the history already holds
 *   with different content (an unchanged replay is dropped by `planAppend`
 *   before it gets here);
 * - `late_write`: a Turn whose ownership was taken away by force wrote anyway.
 *
 * Anything else stays `persistence`.
 */
export function historyFailureKind(error: unknown): NonLLMTurnErrorKind {
  for (const candidate of flattenHistoryErrors(error)) {
    const kind = classifyHistoryError(candidate);
    if (kind !== undefined) return kind;
  }
  return 'persistence';
}

function classifyHistoryError(error: unknown): NonLLMTurnErrorKind | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (name === 'HistoryMutationError' && code === 'revision-conflict') return 'revision_conflict';
  if (name === 'ForceReleasedTurnWriteError') return 'late_write';
  // Only the append identity conflict is split out. A duplicate identity in a
  // replacement or a user message is a planning error and stays `persistence`.
  if (error instanceof TypeError && error.message.startsWith(DUPLICATE_APPEND_MESSAGE)) {
    return 'duplicate_append';
  }
  return undefined;
}

function summarizeHistoryError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: truncateHistoryText(
        error.message || 'Unknown error',
        MAX_HISTORY_ERROR_MESSAGE_LENGTH,
      ),
      ...(error.stack
        ? { stack: truncateHistoryText(error.stack, MAX_HISTORY_ERROR_STACK_LENGTH) }
        : {}),
    };
  }
  return {
    name: typeof error,
    message: truncateHistoryText(describeHistoryError(error), MAX_HISTORY_ERROR_MESSAGE_LENGTH),
  };
}

function truncateHistoryText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function describeHistoryError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'unknown history delivery error';
  }
}
