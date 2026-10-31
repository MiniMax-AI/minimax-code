import type {
  ConversationCommittedMessage,
  ConversationToolCall,
} from '@mavis/conversation-contract';

import type { DisplayMessageRecord } from './repo/contract.js';

/** Maps the durable display Message shape onto the neutral compatibility DTO. */
export function toConversationCommittedMessage(
  message: DisplayMessageRecord,
): ConversationCommittedMessage {
  const toolCalls = readToolCalls(message.tool_calls);
  return {
    ...(readString(message, 'msg_id') ? { msgId: readString(message, 'msg_id') } : {}),
    ...(readString(message, 'role') ? { role: readString(message, 'role') } : {}),
    ...(readString(message, 'msg_content') ? { text: readString(message, 'msg_content') } : {}),
    ...(readString(message, 'thinking_content')
      ? { thinking: readString(message, 'thinking_content') }
      : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(readString(message, 'kind') ? { kind: readString(message, 'kind') } : {}),
    raw: { ...message },
  };
}

function readToolCalls(value: unknown): readonly ConversationToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value.flatMap(readToolCall);
  return calls.length > 0 ? calls : undefined;
}

function readToolCall(entry: unknown): ConversationToolCall[] {
  if (!entry || typeof entry !== 'object') return [];
  const toolName = Reflect.get(entry, 'tool_name');
  const toolCallId = Reflect.get(entry, 'tool_call_id');
  const status = Reflect.get(entry, 'tool_call_status');
  if (typeof toolName !== 'string' || typeof toolCallId !== 'string') return [];
  if (!isToolCallStatus(status)) return [];
  return [
    {
      tool_name: toolName,
      tool_call_id: toolCallId,
      tool_call_status: status,
      ...optionalToolCallArgs(Reflect.get(entry, 'tool_call_args')),
      ...optionalToolCallResult(Reflect.get(entry, 'tool_call_result_data')),
      ...optionalDuration(Reflect.get(entry, 'tool_call_duration_ms')),
      ...optionalParentToolCallId(Reflect.get(entry, 'parent_tool_call_id')),
    },
  ];
}

function isToolCallStatus(value: unknown): value is ConversationToolCall['tool_call_status'] {
  return value === 1 || value === 2 || value === 3;
}

function optionalToolCallArgs(
  value: unknown,
): Partial<Pick<ConversationToolCall, 'tool_call_args'>> {
  return typeof value === 'string' ? { tool_call_args: value } : {};
}

function optionalToolCallResult(
  value: unknown,
): Partial<Pick<ConversationToolCall, 'tool_call_result_data'>> {
  return typeof value === 'string' ? { tool_call_result_data: value } : {};
}

function optionalDuration(
  value: unknown,
): Partial<Pick<ConversationToolCall, 'tool_call_duration_ms'>> {
  return typeof value === 'number' && Number.isFinite(value)
    ? { tool_call_duration_ms: value }
    : {};
}

function optionalParentToolCallId(
  value: unknown,
): Partial<Pick<ConversationToolCall, 'parent_tool_call_id'>> {
  return typeof value === 'string' && value.length > 0 ? { parent_tool_call_id: value } : {};
}

function readString(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}
