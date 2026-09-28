import {
  MsgType,
  RespDataType,
  type AgentMessage,
  type RespData,
} from '../protocol/agent-message.js';
import type { StreamRespEvent } from '../protocol/runtime-event.js';
import { buildStreamRespEvent } from './converters.js';

export const RUNTIME_WARNING_EVENT_TYPE = 'runtime.warning';

export interface RuntimeWarningEventInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventId: string;
  readonly runtimeSeq: number;
  readonly message: string;
  readonly source: string;
  /** Producer-owned category; consumers must not infer it from message text. */
  readonly category?: string;
  readonly code?: string;
  readonly pluginName?: string;
  readonly hookEvent?: string;
  /** Allowlisted terminal bytes; only a live TUI surface may execute them. */
  readonly terminalSequence?: string;
  readonly nowMs?: number;
}

/**
 * Build a durable, user-visible runtime warning without adding it to model
 * history. Hosts persist and fan out this ordinary `MsgType.SystemEvent`; UI
 * clients project it into a warning surface while Pi history ignores it.
 */
export function buildRuntimeWarningEvent(input: RuntimeWarningEventInput): StreamRespEvent {
  const message: AgentMessage = {
    msg_id: input.eventId,
    turn_id: input.turnId,
    timestamp: input.nowMs ?? Date.now(),
    msg_type: MsgType.SystemEvent,
    msg_content: JSON.stringify({
      eventType: RUNTIME_WARNING_EVENT_TYPE,
      message: input.message,
      source: input.source,
      ...(input.category ? { category: input.category } : {}),
      ...(input.code ? { code: input.code } : {}),
      ...(input.pluginName ? { pluginName: input.pluginName } : {}),
      ...(input.hookEvent ? { hookEvent: input.hookEvent } : {}),
      ...(input.terminalSequence ? { terminalSequence: input.terminalSequence } : {}),
    }),
  };
  const respData: RespData = {
    type: RespDataType.AgentMessage,
    agent_message: message,
  };
  return buildStreamRespEvent({
    sessionId: input.sessionId,
    turnId: input.turnId,
    eventId: input.eventId,
    runtimeSeq: input.runtimeSeq,
    respData,
  });
}
