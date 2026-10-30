import {
  RespDataType,
  Role,
  type AgentMessage,
  type AgentMessageChunk,
  type ToolCall,
} from '@mavis/agent-core/protocol/agent-message';

import type { MessageRepository } from '../repo/contract.js';

/**
 * A completed assistant message is normally the only durable display row.
 * PTC cannot wait for that boundary: a child tool has already crossed its
 * side-effect boundary by the time the outer `run_code` result exists. Keep
 * only PTC ToolCall chunks as a compact, same-message-id snapshot so startup
 * recovery can close an interrupted outer tool round without replaying it.
 */
export function ptcToolCallDisplayMessage(raw: string | undefined): AgentMessage | undefined {
  if (!raw) return undefined;
  try {
    const response: unknown = JSON.parse(raw);
    if (!isRecord(response) || response.type !== RespDataType.AgentMessageChunk) return undefined;
    const chunk = response.agent_message_chunk;
    if (!isAgentMessageChunk(chunk) || !Array.isArray(chunk.tool_calls)) return undefined;
    const toolCalls = chunk.tool_calls.filter(isPtcToolCall);
    if (toolCalls.length === 0) return undefined;
    return {
      msg_id: String(chunk.msg_id),
      role: Role.Assistant,
      ...(chunk.timestamp === undefined ? {} : { timestamp: chunk.timestamp }),
      tool_calls: toolCalls,
    };
  } catch {
    return undefined;
  }
}

export async function mergePtcDisplayToolCalls(
  messages: Pick<MessageRepository, 'get'>,
  sessionId: string,
  incoming: AgentMessage,
): Promise<AgentMessage> {
  if (!incoming.tool_calls?.some(isPtcToolCall)) return incoming;
  const existing = await messages.get(sessionId, incoming.msg_id);
  if (!existing || !Array.isArray(existing.tool_calls)) return incoming;
  return {
    ...incoming,
    tool_calls: mergeDisplayToolCalls(existing.tool_calls, incoming.tool_calls ?? []),
  };
}

function mergeDisplayToolCalls(
  existing: readonly unknown[],
  incoming: readonly ToolCall[],
): ToolCall[] {
  const merged = new Map<string, ToolCall>();
  existing.forEach((candidate) => {
    if (!isToolCall(candidate)) return;
    const id = candidate.tool_call_id;
    if (!id) return;
    merged.set(id, candidate);
  });
  incoming.forEach((candidate) => {
    const current = merged.get(candidate.tool_call_id);
    merged.set(
      candidate.tool_call_id,
      current ? mergeDisplayToolCall(current, candidate) : candidate,
    );
  });
  return [...merged.values()];
}

function mergeDisplayToolCall(existing: ToolCall, incoming: ToolCall): ToolCall {
  return isTerminalToolCall(existing) && !isTerminalToolCall(incoming)
    ? { ...incoming, ...existing }
    : { ...existing, ...incoming };
}

function isTerminalToolCall(call: ToolCall): boolean {
  return call.tool_call_status === 2 || call.tool_call_status === 3;
}

function isPtcToolCall(call: ToolCall): boolean {
  return call.tool_name === 'run_code' || Boolean(call.parent_tool_call_id);
}

function isToolCall(value: unknown): value is ToolCall {
  return (
    isRecord(value) &&
    typeof value.tool_name === 'string' &&
    typeof value.tool_call_id === 'string' &&
    typeof value.tool_call_status === 'number'
  );
}

function isAgentMessageChunk(value: unknown): value is AgentMessageChunk {
  return isRecord(value) && (typeof value.msg_id === 'string' || typeof value.msg_id === 'number');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
