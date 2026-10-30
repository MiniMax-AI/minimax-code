/**
 * Pure converters from pi `AgentEvent` payloads to RuntimeEvent frames.
 * Most helpers are synchronous; completed AgentMessage conversion is async
 * because it can run the host-provided `respDataTransform` before
 * serializing `stream.resp`.
 *
 * The Phase 1 wire shape uses `stream.resp` events whose `payload.stream_resp`
 * is a JSON-serialised `RespData` envelope (see `protocol/agent-message.ts`).
 * Status frames (`session.status`) are emitted natively because they have no
 * equivalent in the legacy AgentMessageChunk format.
 *
 * @see packages/agent-core/ARCHITECTURE.md
 */

import {
  RUNTIME_EVENT_SCHEMA,
  RuntimeDebugTraceLevel,
  RuntimeEventStatus,
  RuntimeEventType,
  RuntimeStopReasonType,
  type RuntimeEvent,
  type RuntimeProtocolError,
  type RuntimeStopReason,
  type RuntimeToolCall,
  type RuntimeToolCallStatus,
  type RuntimeUsage,
  type SessionStatusEvent,
  type StreamRespEvent,
} from '../protocol/runtime-event.js';
import { ProtocolErrorCode } from '@mavis/protocol';
import { applyRespDataTransform, type RespDataTransform } from './resp-data.js';
import { sanitizeToolCallForDisplay } from './display-sanitize.js';
import type { PiTurnRunnerLogger } from '../pi-turn-runner/types.js';
import {
  MsgType,
  Role,
  type AgentMessage,
  type AgentMessageChunk,
  type RespData,
  RespDataType,
  type ToolCall,
  ToolCallStatus,
  type TokenUsage,
} from '../protocol/agent-message.js';

// ─── Stream event scaffolding ───────────────────────────────────────────

interface StreamEventInput {
  sessionId: string;
  turnId: string;
  eventId: string;
  runtimeSeq: number;
  respData: RespData;
}

/** Wrap a `RespData` envelope in a `stream.resp` runtime event. */
export function buildStreamRespEvent(input: StreamEventInput): StreamRespEvent {
  return {
    schema: RUNTIME_EVENT_SCHEMA,
    event_id: input.eventId,
    session_id: input.sessionId,
    turn_id: input.turnId,
    runtime_seq: input.runtimeSeq,
    type: RuntimeEventType.STREAM_RESP,
    payload: { stream_resp: JSON.stringify(input.respData) },
  };
}

// ─── AgentMessageChunk builders ─────────────────────────────────────────

interface ChunkInput {
  msgId: string;
  turnId: string;
  chunkIndex: number;
  text?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  finish?: boolean;
  finishReason?: string;
  thinkingDurationMs?: number;
  nowMs: number;
}

function buildChunkRespData(input: ChunkInput): RespData {
  const chunk: AgentMessageChunk = {
    msg_id: input.msgId,
    turn_id: input.turnId,
    chunk_index: input.chunkIndex,
    timestamp: input.nowMs,
    role: Role.Assistant,
    ...(input.text !== undefined ? { msg_content: input.text } : {}),
    ...(input.thinking !== undefined ? { thinking_content: input.thinking } : {}),
    ...(input.toolCalls?.length ? { tool_calls: input.toolCalls } : {}),
    ...(input.finish ? { finish: true } : {}),
    ...(input.finishReason ? { finish_reason: input.finishReason } : {}),
    ...(input.thinkingDurationMs !== undefined
      ? { thinking_duration_ms: input.thinkingDurationMs }
      : {}),
  };
  return { type: RespDataType.AgentMessageChunk, agent_message_chunk: chunk };
}

interface CompletedInput {
  msgId: string;
  turnId: string;
  text?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  thinkingDurationMs?: number;
  usage?: AgentMessage['usage'];
  nowMs: number;
  logger?: PiTurnRunnerLogger;
}

function buildCompletedRespData(input: CompletedInput): RespData {
  const msg: AgentMessage = {
    msg_id: input.msgId,
    turn_id: input.turnId,
    timestamp: input.nowMs,
    role: Role.Assistant,
    // msg_type discriminates between content-only and tool-call messages.
    // The IDL `MsgType` enum is consumed by the frontend (e.g.
    // `ChatPanel.tsx` `MsgType.SystemEvent` branch) and persisted to
    // `session_messages.data_json`. AgentToolCall (=2) must be emitted
    // whenever the assistant produced any tool calls in this turn so
    // downstream consumers don't have to peek into `tool_calls` length
    // to discriminate.
    msg_type:
      input.toolCalls && input.toolCalls.length > 0 ? MsgType.AgentToolCall : MsgType.AgentContent,
    ...(input.text !== undefined ? { msg_content: input.text } : {}),
    ...(input.thinking !== undefined ? { thinking_content: input.thinking } : {}),
    ...(input.toolCalls?.length ? { tool_calls: input.toolCalls } : {}),
    ...(input.finishReason ? { finish_reason: input.finishReason } : {}),
    ...(input.thinkingDurationMs !== undefined
      ? { thinking_duration_ms: input.thinkingDurationMs }
      : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  };
  return { type: RespDataType.AgentMessage, agent_message: msg };
}

// ─── Tool-call status mapping ───────────────────────────────────────────

/**
 * Map pi tool-execution lifecycle to the legacy `ToolCallStatus`
 * tri-state. `started` → 1, `completed` → 2, `failed` → 3.
 */
function toLegacyToolCallStatus(status: RuntimeToolCallStatus): ToolCallStatus {
  if (status === 'preparing') return ToolCallStatus.Preparing;
  if (status === 'prepared') return ToolCallStatus.Prepared;
  if (status === 'completed') return ToolCallStatus.Finished;
  if (status === 'failed') return ToolCallStatus.Failed;
  return ToolCallStatus.Start;
}

/**
 * Convert a `RuntimeToolCall` to the wire-level `ToolCall` shape used
 * inside `AgentMessageChunk` and `AgentMessage`. JSON-encodes args /
 * result because the legacy envelope keeps tool payloads opaque.
 *
 * The `tc.result` object is deep-cloned and stripped of inline-binary
 * content blocks (image / video / audio base64 payloads) before being
 * serialised into `tool_call_result_data`. The original `tc.result`
 * reference — which pi retains inside the assistant turn's `messages`
 * array — is left untouched, so the next LLM request still receives the
 * full base64 payload. See `display-sanitize.ts` for the rationale.
 */
export function toolCallFromRuntime(tc: RuntimeToolCall): ToolCall {
  const displayTc = sanitizeToolCallForDisplay(tc);
  const result =
    displayTc.result !== undefined
      ? displayTc.result
      : displayTc.error
        ? { error: displayTc.error }
        : undefined;
  return {
    tool_name: displayTc.tool_name,
    tool_call_id: displayTc.tool_call_id,
    ...(displayTc.parent_tool_call_id
      ? { parent_tool_call_id: displayTc.parent_tool_call_id }
      : {}),
    tool_call_status: toLegacyToolCallStatus(displayTc.status),
    ...(displayTc.args !== undefined ? { tool_call_args: JSON.stringify(displayTc.args) } : {}),
    ...(displayTc.args_text_delta !== undefined
      ? { tool_call_args_delta: displayTc.args_text_delta }
      : {}),
    ...(result !== undefined ? { tool_call_result_data: JSON.stringify(result) } : {}),
    ...(tc.duration_ms !== undefined ? { tool_call_duration_ms: tc.duration_ms } : {}),
    ...(tc.plugin_provenances?.length
      ? { plugin_provenances: tc.plugin_provenances.map((item) => ({ ...item })) }
      : {}),
  };
}

// ─── pi assistantMessageEvent extraction ────────────────────────────────

/**
 * The `assistantMessageEvent` on a pi `message_update` carries a
 * discriminated union from `@earendil-works/pi-ai`. We only need a
 * tagged subset (text/thinking deltas plus the tool-call streaming
 * frames) — duck-type without depending on the upstream package so
 * agent-core stays runtime-agnostic.
 */
type DeltaUpdate =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'toolcall_start'; contentIndex: number }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'toolcall_end'; contentIndex: number }
  | { type: string; [key: string]: unknown };

/**
 * Tagged tool-call streaming frame extracted from a pi `message_update`.
 * Identity is best-effort per frame: provider streams carry it on every
 * frame's `partial` snapshot, proxy streams only on the start frame — the
 * bridge falls back to its contentIndex mapping when a frame has none.
 */
export type ToolCallStreamUpdate =
  | { kind: 'toolcall_start'; contentIndex: number; toolCallId?: string; toolName?: string }
  | {
      kind: 'toolcall_delta';
      contentIndex: number;
      delta: string;
      toolCallId?: string;
      toolName?: string;
    }
  | { kind: 'toolcall_end'; contentIndex: number; toolCallId?: string; toolName?: string };

/**
 * Best-effort identity of the streaming tool call a frame refers to.
 *
 * Checked in priority order across the shapes pi actually emits:
 * - `toolCall` on the frame itself (provider `toolcall_end`),
 * - top-level `id` / `toolName` (proxy-transport `toolcall_start`),
 * - the `partial` assistant-message snapshot's block at `contentIndex`
 *   (provider streams carry `partial` on every frame; the block is a
 *   `{ type: 'toolCall', id, name }` entry).
 */
function extractToolCallIdentity(
  update: Record<string, unknown>,
  contentIndex: number,
): { toolCallId: string; toolName: string } | undefined {
  const own = update.toolCall;
  if (own && typeof own === 'object') {
    const call = own as Record<string, unknown>;
    if (typeof call.id === 'string' && typeof call.name === 'string') {
      return { toolCallId: call.id, toolName: call.name };
    }
  }
  if (typeof update.id === 'string' && typeof update.toolName === 'string') {
    return { toolCallId: update.id, toolName: update.toolName };
  }
  const partial = update.partial;
  if (partial && typeof partial === 'object') {
    const content = (partial as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const block = content[contentIndex] as Record<string, unknown> | undefined;
      if (
        block &&
        typeof block === 'object' &&
        block.type === 'toolCall' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        return { toolCallId: block.id, toolName: block.name };
      }
    }
  }
  return undefined;
}

/**
 * Narrow an `unknown` `assistantMessageEvent` into a tagged delta payload.
 *
 * Returns one of the recognized variants (`text_delta` / `thinking_delta` /
 * `toolcall_start` / `toolcall_delta` / `toolcall_end`) or `undefined` when
 * the payload is irrelevant — the caller should treat irrelevant updates as
 * no-ops. Tool-call frames identify their call by pi's `contentIndex`, with
 * the per-frame identity attached whenever the frame shape carries one.
 */
export function extractDeltaUpdate(
  raw: unknown,
):
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | ToolCallStreamUpdate
  | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const update = raw as DeltaUpdate;
  if (update.type === 'text_delta' && typeof update.delta === 'string') {
    return { kind: 'text', delta: update.delta };
  }
  if (update.type === 'thinking_delta' && typeof update.delta === 'string') {
    return { kind: 'thinking', delta: update.delta };
  }
  if (update.type === 'toolcall_start' && typeof update.contentIndex === 'number') {
    return {
      kind: 'toolcall_start',
      contentIndex: update.contentIndex,
      ...(extractToolCallIdentity(update as Record<string, unknown>, update.contentIndex) ?? {}),
    };
  }
  if (
    update.type === 'toolcall_delta' &&
    typeof update.contentIndex === 'number' &&
    typeof update.delta === 'string'
  ) {
    return {
      kind: 'toolcall_delta',
      contentIndex: update.contentIndex,
      delta: update.delta,
      ...(extractToolCallIdentity(update as Record<string, unknown>, update.contentIndex) ?? {}),
    };
  }
  if (update.type === 'toolcall_end' && typeof update.contentIndex === 'number') {
    return {
      kind: 'toolcall_end',
      contentIndex: update.contentIndex,
      ...(extractToolCallIdentity(update as Record<string, unknown>, update.contentIndex) ?? {}),
    };
  }
  return undefined;
}

// ─── pi AgentMessage extraction ─────────────────────────────────────────

/**
 * Pull the visible text concatenation out of a pi assistant `AgentMessage`.
 * pi stores content as an array of `{ type: 'text' | 'thinking' | 'toolCall' }`
 * blocks; only `text` blocks contribute to the visible body.
 */
export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as Record<string, unknown>;
      if (b.type !== 'text') return '';
      return typeof b.text === 'string' ? b.text : '';
    })
    .join('');
}

/** Pull the visible thinking concatenation out of a pi assistant message. */
export function extractAssistantThinking(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as Record<string, unknown>;
      if (b.type !== 'thinking') return '';
      return typeof b.thinking === 'string' ? b.thinking : '';
    })
    .join('');
}

/** Extract `RuntimeToolCall[]` from a pi assistant message's content blocks. */
export function extractAssistantToolCalls(message: unknown): RuntimeToolCall[] {
  if (!message || typeof message !== 'object') return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): RuntimeToolCall[] => {
    if (!block || typeof block !== 'object') return [];
    const b = block as Record<string, unknown>;
    if (b.type !== 'toolCall') return [];
    const id = b.id;
    const name = b.name;
    if (typeof id !== 'string' || typeof name !== 'string') return [];
    const args = b.arguments;
    return [
      {
        tool_name: name,
        tool_call_id: id,
        status: 'started',
        ...(args !== undefined && typeof args === 'object' && args !== null
          ? { args: args as Record<string, unknown> }
          : {}),
      },
    ];
  });
}

/** True when a pi assistant message reports `stopReason === 'error'`. */
export function isAssistantError(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  return m.role === 'assistant' && m.stopReason === 'error';
}

/** Extract `errorMessage` from a pi assistant message, if any. */
export function extractAssistantErrorMessage(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const errorMessage = (message as Record<string, unknown>).errorMessage;
  return typeof errorMessage === 'string' && errorMessage ? errorMessage : undefined;
}

/** Pull `stopReason` (normalised `string | undefined`) off a pi message. */
export function extractAssistantStopReason(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const stopReason = (message as Record<string, unknown>).stopReason;
  return typeof stopReason === 'string' && stopReason ? stopReason : undefined;
}

/**
 * Extract token usage from a pi assistant message and convert to the
 * IDL `TokenUsage` shape ({@link TokenUsage}). pi assistant messages
 * carry usage on successful turns as
 * `{ input, output, cacheRead, cacheWrite, totalTokens }`
 * (see `@earendil-works/pi-ai` `Usage`); aborted / errored turns omit it.
 *
 * Returns `undefined` when no usage can be derived so the caller can
 * fall back to a zero / window-only default rather than emit a spurious
 * `total_tokens: 0` that masks a missing-usage producer bug.
 *
 * `contextWindow` is per-model metadata threaded in from the resolver
 * (not present on the per-message usage block).
 *
 * `cache_read` / `cache_write` are populated when the provider reports
 * non-zero values so downstream observability (cloud-runtime trace,
 * daemon SSE) can distinguish a true zero from "field absent" — useful
 * for diagnosing cache-retention configuration issues.
 */
export function extractAssistantUsage(
  message: unknown,
  contextWindow: number,
): TokenUsage | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const m = message as Record<string, unknown>;
  if (m.role !== 'assistant') return undefined;
  // pi suppresses usage on aborted / error turns — propagate undefined so
  // downstream callers don't materialise 0 token counts that confuse
  // billing / observability downstream.
  const stop = m.stopReason;
  if (stop === 'aborted' || stop === 'error') return undefined;
  const usage = m.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const finite = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const input = finite(u.input);
  const output = finite(u.output);
  const cacheRead = finite(u.cacheRead) ?? 0;
  const cacheWrite = finite(u.cacheWrite) ?? 0;
  const total =
    (finite(u.totalTokens) ?? 0) || (input ?? 0) + (output ?? 0) + cacheRead + cacheWrite;
  return {
    total_tokens: total,
    context_window: contextWindow,
    // input_tokens / output_tokens populate the main IRuntimeUsage columns. When the
    // RecordTokenUsage RPC reports to token_usage, InputTokens/OutputTokens are required IDL fields;
    // omitting them makes the archon-server billing pipeline write zeros for the whole batch, corrupting reports.
    // Forward any finite provider value unchanged, including explicit 0: a full cache hit
    // has 0 input tokens. Omitting it makes downstream consumers treat "known zero" as "unknown"
    // and mark usageIncomplete. Still omit missing or non-finite values to preserve "unknown" semantics.
    ...(input === undefined ? {} : { input_tokens: input }),
    ...(output === undefined ? {} : { output_tokens: output }),
    ...(cacheRead > 0 ? { cache_read: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cache_write: cacheWrite } : {}),
  };
}

// ─── Stream event helpers (re-exported for the bridge) ──────────────────

interface DeltaChunkInput {
  sessionId: string;
  turnId: string;
  eventId: string;
  runtimeSeq: number;
  msgId: string;
  chunkIndex: number;
  delta: string;
  nowMs: number;
}

/** Build the `text_delta` chunk frame. */
export function buildTextDeltaChunk(ctx: DeltaChunkInput): StreamRespEvent {
  return buildStreamRespEvent({
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    eventId: ctx.eventId,
    runtimeSeq: ctx.runtimeSeq,
    respData: buildChunkRespData({
      msgId: ctx.msgId,
      turnId: ctx.turnId,
      chunkIndex: ctx.chunkIndex,
      text: ctx.delta,
      nowMs: ctx.nowMs,
    }),
  });
}

/** Build the `thinking_delta` chunk frame. */
export function buildThinkingDeltaChunk(ctx: DeltaChunkInput): StreamRespEvent {
  return buildStreamRespEvent({
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    eventId: ctx.eventId,
    runtimeSeq: ctx.runtimeSeq,
    respData: buildChunkRespData({
      msgId: ctx.msgId,
      turnId: ctx.turnId,
      chunkIndex: ctx.chunkIndex,
      thinking: ctx.delta,
      nowMs: ctx.nowMs,
    }),
  });
}

interface ToolChunkInput {
  sessionId: string;
  turnId: string;
  eventId: string;
  runtimeSeq: number;
  msgId: string;
  chunkIndex: number;
  toolCall: RuntimeToolCall;
  nowMs: number;
}

/** Build a tool-call lifecycle chunk frame (start / completed / failed). */
export function buildToolCallChunk(input: ToolChunkInput): StreamRespEvent {
  return buildStreamRespEvent({
    sessionId: input.sessionId,
    turnId: input.turnId,
    eventId: input.eventId,
    runtimeSeq: input.runtimeSeq,
    respData: buildChunkRespData({
      msgId: input.msgId,
      turnId: input.turnId,
      chunkIndex: input.chunkIndex,
      toolCalls: [toolCallFromRuntime(input.toolCall)],
      nowMs: input.nowMs,
    }),
  });
}

interface FinishChunkInput {
  sessionId: string;
  turnId: string;
  eventId: string;
  runtimeSeq: number;
  msgId: string;
  chunkIndex: number;
  finishReason?: string;
  thinkingDurationMs?: number;
  nowMs: number;
}

/**
 * Build the `finish` chunk that marks the end of an assistant message's
 * stream of partial chunks. Emitted before the `completed` materialised
 * `AgentMessage` so consumers can flush deltas first.
 */
export function buildFinishChunk(input: FinishChunkInput): StreamRespEvent {
  return buildStreamRespEvent({
    sessionId: input.sessionId,
    turnId: input.turnId,
    eventId: input.eventId,
    runtimeSeq: input.runtimeSeq,
    respData: buildChunkRespData({
      msgId: input.msgId,
      turnId: input.turnId,
      chunkIndex: input.chunkIndex,
      finish: true,
      ...(input.finishReason ? { finishReason: input.finishReason } : {}),
      ...(input.thinkingDurationMs !== undefined
        ? { thinkingDurationMs: input.thinkingDurationMs }
        : {}),
      nowMs: input.nowMs,
    }),
  });
}

interface CompletedAssistantInput {
  sessionId: string;
  turnId: string;
  eventId: string;
  runtimeSeq: number;
  msgId: string;
  text: string;
  thinking?: string;
  toolCalls?: RuntimeToolCall[];
  thinkingDurationMs?: number;
  finishReason?: string;
  usage?: AgentMessage['usage'];
  nowMs: number;
  logger?: PiTurnRunnerLogger;
}

/**
 * Build the materialised `AgentMessage` event emitted right after the
 * matching `finish` chunk. Carries the full text + thinking + tool_calls
 * + usage so consumers that missed deltas can still render the turn.
 */
export async function buildCompletedAssistantMessage(
  input: CompletedAssistantInput,
  respDataTransform?: RespDataTransform,
): Promise<StreamRespEvent> {
  const respData = await applyRespDataTransform(
    respDataTransform,
    buildCompletedRespData({
      msgId: input.msgId,
      turnId: input.turnId,
      text: input.text,
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      ...(input.toolCalls?.length ? { toolCalls: input.toolCalls.map(toolCallFromRuntime) } : {}),
      ...(input.thinkingDurationMs !== undefined
        ? { thinkingDurationMs: input.thinkingDurationMs }
        : {}),
      ...(input.finishReason ? { finishReason: input.finishReason } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      nowMs: input.nowMs,
    }),
    { sessionId: input.sessionId, turnId: input.turnId },
    input.logger,
  );
  return buildStreamRespEvent({
    sessionId: input.sessionId,
    turnId: input.turnId,
    eventId: input.eventId,
    runtimeSeq: input.runtimeSeq,
    respData,
  });
}

// ─── Terminal pair builders ─────────────────────────────────────────────

interface TerminalStatusInput {
  sessionId: string;
  turnId: string;
  statusEventId: string;
  terminalUsage?: RuntimeUsage;
}

interface SessionStatusInput {
  sessionId: string;
  turnId: string;
  eventId: string;
}

/** Build the initial `session.status running` frame for a turn. */
export function buildRunningSessionStatusEvent(input: SessionStatusInput): SessionStatusEvent {
  return {
    schema: RUNTIME_EVENT_SCHEMA,
    event_id: input.eventId,
    session_id: input.sessionId,
    turn_id: input.turnId,
    type: RuntimeEventType.SESSION_STATUS,
    payload: { status: RuntimeEventStatus.RUNNING },
  };
}

/** Build the terminal `session.status completed` frame. */
export function buildCompletedTerminalStatusEvent(input: TerminalStatusInput): SessionStatusEvent {
  return {
    schema: RUNTIME_EVENT_SCHEMA,
    event_id: input.statusEventId,
    session_id: input.sessionId,
    turn_id: input.turnId,
    type: RuntimeEventType.SESSION_STATUS,
    payload: {
      status: RuntimeEventStatus.COMPLETED,
      stop_reason: { type: RuntimeStopReasonType.END_TURN },
      ...(input.terminalUsage ? { usage: input.terminalUsage } : {}),
    },
  };
}

/** Build the terminal `session.status aborted` frame. */
export function buildAbortedTerminalStatusEvent(input: TerminalStatusInput): SessionStatusEvent {
  return {
    schema: RUNTIME_EVENT_SCHEMA,
    event_id: input.statusEventId,
    session_id: input.sessionId,
    turn_id: input.turnId,
    type: RuntimeEventType.SESSION_STATUS,
    payload: {
      status: RuntimeEventStatus.ABORTED,
      stop_reason: { type: RuntimeStopReasonType.ABORT, message: 'aborted' },
      ...(input.terminalUsage ? { usage: input.terminalUsage } : {}),
    },
  };
}

interface FailedTerminalInput extends TerminalStatusInput {
  message: string;
  error?: RuntimeProtocolError;
}

/** Build the terminal `session.status failed` frame. */
export function buildFailedTerminalStatusEvent(input: FailedTerminalInput): SessionStatusEvent {
  const stopReason: RuntimeStopReason = {
    type: RuntimeStopReasonType.ERROR,
    message: input.message,
  };
  const protocolError: RuntimeProtocolError = input.error ?? {
    code: ProtocolErrorCode.INTERNAL_ERROR,
    message: input.message,
  };
  return {
    schema: RUNTIME_EVENT_SCHEMA,
    event_id: input.statusEventId,
    session_id: input.sessionId,
    turn_id: input.turnId,
    type: RuntimeEventType.SESSION_STATUS,
    payload: { status: RuntimeEventStatus.FAILED, stop_reason: stopReason, error: protocolError },
  };
}

interface DebugTraceInput {
  sessionId: string;
  turnId: string;
  eventId: string;
  phase: string;
  message: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  attrs?: Record<string, string | number | boolean>;
  durationMs?: number;
}

/** Map the legacy debug-trace level string to the protocol numeric enum. */
function debugTraceLevelToEnum(level: 'debug' | 'info' | 'warn' | 'error'): RuntimeDebugTraceLevel {
  switch (level) {
    case 'info':
      return RuntimeDebugTraceLevel.INFO;
    case 'warn':
      return RuntimeDebugTraceLevel.WARN;
    case 'error':
      return RuntimeDebugTraceLevel.ERROR;
    default:
      return RuntimeDebugTraceLevel.DEBUG;
  }
}

/**
 * Build a `debug.trace` event.
 *
 * Wire-format note: the new thrift IDL carries the `attrs` map as a
 * `attrs_json` string (the generator does not emit `map<string,
 * variant>`), so caller-supplied `attrs` are JSON-stringified into the
 * payload. Consumers that want to read attrs must JSON.parse
 * `payload.trace.attrs_json` back into a record.
 */
export function buildDebugTraceEvent(input: DebugTraceInput): RuntimeEvent {
  return {
    schema: RUNTIME_EVENT_SCHEMA,
    event_id: input.eventId,
    session_id: input.sessionId,
    turn_id: input.turnId,
    type: RuntimeEventType.DEBUG_TRACE,
    payload: {
      trace: {
        phase: input.phase,
        level: debugTraceLevelToEnum(input.level ?? 'debug'),
        message: input.message,
        ...(input.durationMs === undefined ? {} : { duration_ms: input.durationMs }),
        ...(input.attrs ? { attrs_json: JSON.stringify(input.attrs) } : {}),
      },
    },
  };
}

// ─── Buffered-event extraction (sub-agent helpers) ──────────────────────

/**
 * Walk a buffered `RuntimeEvent[]` and return the visible `msg_content` of
 * the LAST closed assistant `AgentMessage` frame. Filters by
 * `RespData.type === RespDataType.AgentMessage` — explicitly NOT
 * `AgentMessageChunk`. Returns `''` when no terminal `AgentMessage` exists.
 */
export function extractFinalAssistantText(buffered: readonly RuntimeEvent[]): string {
  for (let i = buffered.length - 1; i >= 0; i--) {
    const ev = buffered[i];
    if (!ev || ev.type !== RuntimeEventType.STREAM_RESP) continue;
    const raw = ev.payload?.stream_resp;
    if (typeof raw !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const respData = parsed as { type?: unknown; agent_message?: unknown };
    if (respData.type !== RespDataType.AgentMessage) continue;
    const msg = respData.agent_message;
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as { msg_content?: unknown }).msg_content;
    return typeof content === 'string' ? content : '';
  }
  return '';
}

/**
 * Same buffer-walk strategy as {@link extractFinalAssistantText} but returns
 * the `usage` field on the last `AgentMessage` (matches the IDL `TokenUsage`
 * shape: `{ total_tokens, context_window, cache_read?, cache_write? }`).
 * Returns `undefined` when no `AgentMessage` exists or when it has no
 * `usage` block. Cache fields are pulled through symmetrically with
 * {@link extractAssistantUsage} — sub-agent paths (e.g. `cloud-task` buffer
 * extraction) must not silently drop cache metrics.
 */
export function extractFinalAssistantUsageFromBuffer(
  buffered: readonly RuntimeEvent[],
): TokenUsage | undefined {
  for (let i = buffered.length - 1; i >= 0; i--) {
    const ev = buffered[i];
    if (!ev || ev.type !== RuntimeEventType.STREAM_RESP) continue;
    const raw = ev.payload?.stream_resp;
    if (typeof raw !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const respData = parsed as { type?: unknown; agent_message?: unknown };
    if (respData.type !== RespDataType.AgentMessage) continue;
    const msg = respData.agent_message;
    if (!msg || typeof msg !== 'object') continue;
    const usage = (msg as { usage?: unknown }).usage;
    if (!usage || typeof usage !== 'object') return undefined;
    const u = usage as {
      total_tokens?: unknown;
      context_window?: unknown;
      cache_read?: unknown;
      cache_write?: unknown;
    };
    const total = typeof u.total_tokens === 'number' ? u.total_tokens : 0;
    const cw = typeof u.context_window === 'number' ? u.context_window : 0;
    const cacheRead = typeof u.cache_read === 'number' ? u.cache_read : 0;
    const cacheWrite = typeof u.cache_write === 'number' ? u.cache_write : 0;
    return {
      total_tokens: total,
      context_window: cw,
      ...(cacheRead > 0 ? { cache_read: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cache_write: cacheWrite } : {}),
    };
  }
  return undefined;
}
