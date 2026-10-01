import { RespDataType, ToolCallStatus } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventStatus, RuntimeEventType, type IRuntimeEvent } from '@mavis/protocol';

import type { LocalRuntimeTurnRuntimeOutcome } from '../execution/executor.js';

const BYOK_ERROR_PREFIX = 'BYOK upstream error';
const BYOK_UPSTREAM_ERROR_SOURCE = 'byok_upstream';

export function deriveLocalTurnRuntimeOutcome(
  events: readonly IRuntimeEvent[],
): LocalRuntimeTurnRuntimeOutcome {
  const tracker = createLocalTurnOutcomeTracker();
  events.forEach((event) => tracker.observe(event));
  return tracker.read();
}

/** Fold approved events without retaining their streaming payloads. */
export function createLocalTurnOutcomeTracker() {
  const state: MutableOutcome = { status: 'unknown', waitingForUser: false };
  let eventCount = 0;
  return {
    get eventCount() { return eventCount; },
    observe(event: IRuntimeEvent): void {
      updateOutcome(state, event);
      eventCount += 1;
    },
    read: (): LocalRuntimeTurnRuntimeOutcome => snapshotOutcome(state),
  };
}

function snapshotOutcome(state: MutableOutcome): LocalRuntimeTurnRuntimeOutcome {
  return {
    status: state.status,
    ...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
    ...(typeof state.errorCode === 'number' ? { errorCode: state.errorCode } : {}),
    ...(state.errorSource ? { errorSource: state.errorSource } : {}),
    ...(state.errorDetail ? { errorDetail: state.errorDetail } : {}),
    ...(state.errorProviderId ? { errorProviderId: state.errorProviderId } : {}),
    ...(state.messageId ? { messageId: state.messageId } : {}),
    ...(state.waitingForUser ? { waitingForUser: true } : {}),
  };
}

interface MutableOutcome {
  status: LocalRuntimeTurnRuntimeOutcome['status'];
  errorMessage?: string;
  errorCode?: number;
  errorSource?: string;
  errorDetail?: string;
  errorProviderId?: string;
  messageId?: string;
  waitingForUser: boolean;
}

function updateOutcome(state: MutableOutcome, event: IRuntimeEvent): void {
  if (event.type === RuntimeEventType.STREAM_RESP) {
    state.messageId = readAssistantMessageId(event) ?? state.messageId;
    state.waitingForUser = hasWaitingForUserToolResult(event) || state.waitingForUser;
    return;
  }
  if (event.type !== RuntimeEventType.SESSION_STATUS) return;
  const terminalStatus = event.payload?.status;
  if (terminalStatus === RuntimeEventStatus.COMPLETED) {
    applyCompletedOutcome(state);
    return;
  }
  if (!isAbnormalTerminalStatus(terminalStatus)) return;
  applyAbnormalOutcome(state, event, terminalStatus);
}

function applyCompletedOutcome(state: MutableOutcome): void {
  state.status = 'completed';
  state.errorMessage = undefined;
  state.errorCode = undefined;
  state.errorSource = undefined;
  state.errorDetail = undefined;
  state.errorProviderId = undefined;
}

function applyAbnormalOutcome(
  state: MutableOutcome,
  event: IRuntimeEvent,
  terminalStatus: RuntimeEventStatus.ABORTED | RuntimeEventStatus.FAILED,
): void {
  state.status = terminalStatus === RuntimeEventStatus.ABORTED ? 'aborted' : 'failed';
  const rawMessage =
    event.payload?.error?.message ??
    event.payload?.stop_reason?.message ??
    (state.status === 'failed' ? 'Local runtime turn failed' : undefined);
  const normalized = normalizeError(rawMessage, readRuntimeErrorCode(event));
  state.errorMessage = normalized.errorMessage;
  state.errorCode = normalized.errorCode;
  state.errorSource = normalized.errorSource;
  state.errorDetail = normalized.errorDetail;
  state.errorProviderId = normalized.errorProviderId;
}

function isAbnormalTerminalStatus(
  status: unknown,
): status is RuntimeEventStatus.ABORTED | RuntimeEventStatus.FAILED {
  return status === RuntimeEventStatus.ABORTED || status === RuntimeEventStatus.FAILED;
}

function normalizeError(
  rawMessage: string | undefined,
  rawErrorCode: number | undefined,
): Omit<LocalRuntimeTurnRuntimeOutcome, 'status' | 'messageId' | 'waitingForUser'> {
  const attributed = parseByokErrorStatus(rawMessage, rawErrorCode);
  if (attributed) {
    return {
      errorMessage: attributed.message,
      errorCode: attributed.errorCode,
      errorSource: BYOK_UPSTREAM_ERROR_SOURCE,
      errorDetail: attributed.errorDetail,
      errorProviderId: attributed.errorProviderId,
    };
  }
  return {
    ...(rawMessage ? { errorMessage: rawMessage } : {}),
    ...(typeof rawErrorCode === 'number' ? { errorCode: rawErrorCode } : {}),
  };
}

function parseByokErrorStatus(
  rawMessage: string | undefined,
  fallbackErrorCode: number | undefined,
):
  | {
      readonly message: string;
      readonly errorCode: number;
      readonly errorDetail: string;
      readonly errorProviderId: string;
    }
  | undefined {
  if (!rawMessage) return undefined;
  const structured = parseStructuredByokMessage(rawMessage, fallbackErrorCode);
  if (structured) return structured;
  const legacy = parseLegacyByokMessage(rawMessage);
  if (!legacy) return undefined;
  return {
    message: rawMessage,
    errorCode: fallbackErrorCode ?? 50_000,
    errorProviderId: legacy.providerId,
    errorDetail: legacy.detail,
  };
}

function parseStructuredByokMessage(
  rawMessage: string,
  fallbackErrorCode: number | undefined,
): ReturnType<typeof parseByokErrorStatus> {
  if (!rawMessage.startsWith(BYOK_ERROR_PREFIX)) return undefined;
  const start = rawMessage.indexOf('{');
  if (start < 0) return undefined;
  try {
    return normalizeStructuredByokPayload(
      JSON.parse(rawMessage.slice(start)) as Record<string, unknown>,
      rawMessage,
      fallbackErrorCode,
    );
  } catch {
    return undefined;
  }
}

function normalizeStructuredByokPayload(
  payload: Readonly<Record<string, unknown>>,
  rawMessage: string,
  fallbackErrorCode: number | undefined,
): ReturnType<typeof parseByokErrorStatus> {
  const message = readString(payload, 'message') ?? rawMessage;
  const legacy = parseLegacyByokMessage(message);
  const errorProviderId = readString(payload, 'errorProviderId') ?? legacy?.providerId;
  const errorDetail = readString(payload, 'errorDetail') ?? legacy?.detail;
  if (!errorProviderId || !errorDetail) return undefined;
  return {
    message,
    errorCode:
      typeof payload.errorCode === 'number' ? payload.errorCode : (fallbackErrorCode ?? 50_000),
    errorProviderId,
    errorDetail,
  };
}

function parseLegacyByokMessage(
  message: string,
): { readonly providerId: string; readonly detail: string } | undefined {
  const match = /^BYOK provider (?<providerId>.+?) upstream error: (?<detail>[\s\S]*)$/u.exec(
    message,
  );
  const providerId = match?.groups?.providerId?.trim();
  const detail = match?.groups?.detail?.trim();
  return providerId && detail ? { providerId, detail } : undefined;
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readRuntimeErrorCode(event: IRuntimeEvent): number | undefined {
  const code = event.payload?.error?.code;
  return typeof code === 'number' ? code : undefined;
}

function readAssistantMessageId(event: IRuntimeEvent): string | undefined {
  const parsed = parseStreamResponse(event);
  if (parsed?.type === RespDataType.AgentMessage) {
    return typeof parsed.agent_message?.msg_id === 'string'
      ? parsed.agent_message.msg_id
      : undefined;
  }
  if (parsed?.type === RespDataType.AgentMessageChunk) {
    return typeof parsed.agent_message_chunk?.msg_id === 'string'
      ? parsed.agent_message_chunk.msg_id
      : undefined;
  }
  return undefined;
}

function hasWaitingForUserToolResult(event: IRuntimeEvent): boolean {
  const calls = readToolCalls(parseStreamResponse(event));
  if (!Array.isArray(calls)) return false;
  return calls.some(isWaitingForUserCall);
}

function readToolCalls(parsed: ReturnType<typeof parseStreamResponse>): unknown {
  if (parsed?.type === RespDataType.AgentMessage) return parsed.agent_message?.tool_calls;
  if (parsed?.type === RespDataType.AgentMessageChunk) {
    return parsed.agent_message_chunk?.tool_calls;
  }
  return undefined;
}

function isWaitingForUserCall(call: unknown): boolean {
  if (!call || typeof call !== 'object') return false;
  const record = call as {
    readonly tool_name?: unknown;
    readonly tool_call_status?: unknown;
    readonly tool_call_result_data?: unknown;
  };
  if (record.tool_call_status !== ToolCallStatus.Finished) return false;
  const result = parseToolCallResult(record.tool_call_result_data);
  if (result?.details?.waiting_for_user === true) return true;
  // Decision v3: a suppressed ask_user resolves inline and keeps the turn
  // running; only an explicit false opts out of the legacy fallback below.
  if (result?.details?.waiting_for_user === false) return false;
  if (record.tool_name === 'ask_user' && result?.terminate === true) return true;
  return record.tool_name === 'ask_user';
}

function parseToolCallResult(value: unknown):
  | {
      readonly terminate?: unknown;
      readonly details?: { readonly waiting_for_user?: unknown };
    }
  | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as ReturnType<typeof parseToolCallResult>;
  } catch {
    return undefined;
  }
}

function parseStreamResponse(event: IRuntimeEvent):
  | {
      readonly type?: unknown;
      readonly agent_message?: {
        readonly msg_id?: unknown;
        readonly tool_calls?: unknown;
      };
      readonly agent_message_chunk?: {
        readonly msg_id?: unknown;
        readonly tool_calls?: unknown;
      };
    }
  | undefined {
  const raw = event.payload?.stream_resp;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as ReturnType<typeof parseStreamResponse>;
  } catch {
    return undefined;
  }
}
