/**
 * `EventBridge` — convert pi `AgentEvent` stream to canonical `RuntimeEvent[]`.
 *
 * Callers feed pi events into the bridge as they arrive from
 * `agentLoop()` / `Agent.subscribe()`; the bridge tracks
 * per-turn state (active assistant `message_id`, chunk index, thinking
 * timing) and emits the wire-level frames via {@link BridgedEvents.events}.
 *
 * The bridge is **per-turn**: callers create a new instance for every
 * pi run, feed events to {@link processEvent} until the loop concludes,
 * then call one of the terminal helpers ({@link emitCompleted},
 * {@link emitAborted}, {@link emitFailed}) to close the turn with a
 * terminal `session.status` frame.
 *
 * ### Scope: canonical stream only
 *
 * The bridge emits only the canonical streaming surface (`stream.resp`
 * chunks + `completedAssistantMessage` + terminal status + `debug.trace`).
 * The `message.persisted` side-channel events live OUTSIDE this layer —
 * SessionController emits them right after `messageStore.append` (for
 * both user and pi messages) because the bridge is a stateless
 * `AgentEvent → RuntimeEvent[]` transformer with no access to the
 * MessageStore-assigned ids and no view of user messages at all. Do
 * NOT add `message.persisted` emission here.
 *
 * ### Message-id allocation contract
 *
 * pi assigns no `message_id` to assistant messages; the host owns that
 * identity (e.g. via {@link MessageStore}). On the first
 * `message_start` for an assistant role, the bridge returns an empty
 * `events` array with `requestAssistantMessageId = true`. The caller
 * MUST allocate a fresh id and call
 * {@link setActiveAssistantMessageId} before delivering the next event.
 * Until then, deltas are buffered conservatively — text/thinking deltas
 * arriving without an active message id are dropped (with a debug trace)
 * because they have no anchor.
 *
 * ### Thread-safety
 *
 * Bridges are NOT thread-safe — feed events serially. Per-event-loop
 * usage is fine; pi delivers events synchronously inside `Agent.subscribe`.
 *
 * ### Side-effects
 *
 * The bridge mutates only its own per-turn state (chunk index counter,
 * message id slot, thinking timer). Completed AgentMessage conversion may
 * invoke the host-provided `respDataTransform`; transform failures are
 * logged through agent-core's logger and fall back to the original RespData.
 * Terminal failure messages are encoded as `debug.trace` events for the
 * host to push.
 *
 * @see packages/cloud-runtime/README.md
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { LLM_ERROR_CODES, classifyLLMErrorToCode } from '@mavis/shared/llm-error-classifier';
import {
  InstalledPluginSource,
  PluginCapabilityType,
  type IPluginCapabilityProvenance,
} from '@mavis/protocol';
import type { RuntimeProtocolError, RuntimeToolCall } from '../protocol/runtime-event.js';
import type { TokenUsage } from '../protocol/agent-message.js';
import {
  buildAbortedTerminalStatusEvent,
  buildCompletedAssistantMessage,
  buildCompletedTerminalStatusEvent,
  buildDebugTraceEvent,
  buildFailedTerminalStatusEvent,
  buildFinishChunk,
  buildTextDeltaChunk,
  buildThinkingDeltaChunk,
  buildToolCallChunk,
  extractAssistantErrorMessage,
  extractAssistantStopReason,
  extractAssistantText,
  extractAssistantThinking,
  extractAssistantToolCalls,
  extractAssistantUsage,
  extractDeltaUpdate,
  isAssistantError,
  type ToolCallStreamUpdate,
} from './converters.js';
import type { BridgedEvents, EventBridgeContext, TurnTerminationReason } from './types.js';

const defaultNowMs = () => Date.now();

/**
 * Fallback context window when the host does not supply one via
 * {@link EventBridgeContext.contextWindow}. Kept at 200_000 to preserve
 * pre-`feat/pi-integration-gaps` behaviour for callers that have not
 * been updated yet — the bridge logs once when this fallback fires so
 * observers can spot the misconfiguration.
 */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Runtime-side mirror of the UI typed session error messages
 * (`packages/ui/src/i18n/locales/*::errors.codes`).
 *
 * Keep a local copy to avoid making `@mavis/agent-core` depend on the UI package. Keep both sets
 * synchronized: when the UI adds a daemon code that should render as a localized session error
 * during streaming, add it here so the terminal assistant `agent_message` carries `code:message`
 * instead of bare `[Error] ...` text. The UI consumes assistant + finish_reason=error as session
 * status, and local-runtime filters it out of display history.
 *
 * Codes outside this set (auth / generic upstream / unclassified) retain their original `[Error]
 * ...` content as the only user-visible signal.
 */
const TYPED_TERMINAL_ERROR_CODES = new Set<number>([
  LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED, // 42212
  LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED, // 50110
  LLM_ERROR_CODES.LLM_RATE_LIMITED, // 50111
  LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED, // 50150
  LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED, // 50151
  419, // Legacy daemon code retained for cross-version compatibility.
]);

/**
 * Snapshot of `onMessageEnd` context, captured so the bridge can defer
 * emitting the completed assistant `agent_message` (RespData.type=2) until
 * every `tool_execution_end` for that message has arrived. See the
 * {@link EventBridge.pendingCompletedMessage} field comment for the
 * full rationale.
 *
 * `usage` is typed as the full {@link TokenUsage} so the deferred
 * emit preserves the optional `cache_read` / `cache_write` fields that
 * `extractAssistantUsage` may surface — narrowing this to a 2-field
 * inline type would silently drop them on the tool-call code path.
 */
interface PendingCompletedMessageContext {
  msgId: string;
  text: string;
  thinking: string | undefined;
  thinkingDurationMs: number | undefined;
  finishReason: string | undefined;
  usage: TokenUsage;
}

/**
 * Per-turn bridge from pi `AgentEvent` to canonical `RuntimeEvent`.
 *
 * Lifecycle:
 *   1. `new EventBridge(ctx)` once per turn.
 *   2. For each pi event: `await ev.processEvent(event)`. If
 *      `requestAssistantMessageId === true`, allocate one and call
 *      {@link setActiveAssistantMessageId} before the next event.
 *   3. After the loop concludes: call exactly one of `emitCompleted`,
 *      `emitAborted`, `emitFailed`.
 */
export class EventBridge {
  private readonly ctx: EventBridgeContext;
  private readonly now: () => number;
  /** Whether to measure and stamp per-tool-call `duration_ms`. Non-prod only. */
  private readonly captureToolTiming: boolean;
  /** Resolved context-window size for this turn, captured at construction time. */
  private readonly contextWindow: number;

  /** Active assistant `message_id` for the message currently being streamed. */
  private activeAssistantMessageId: string | undefined;
  /** Per-message chunk index counter. Resets on each new assistant message. */
  private chunkIndex: number = 0;
  /** Latched flag — true while we have asked the host for an id and not received one. */
  private awaitingMessageId: boolean = false;
  /** Wall-clock ms when the first thinking_delta of the current msg arrived. */
  private thinkingStartMs: number | undefined;
  /** First nonempty text/thinking/tool token; excludes first-token wait from throughput. */
  private firstTokenMs: number | undefined;
  /** Wall-clock ms when thinking ended (first non-thinking delta or message_end). */
  private thinkingEndMs: number | undefined;
  /** Whether the current message has already produced a non-thinking delta. */
  private thinkingClosed: boolean = false;
  /** Most recent assistant message cached for diagnostics on terminal frames. */
  private lastAssistantErrorMessage: string | undefined;

  // ── Tool-call lifecycle tracking ─────────────────────────────────────
  //
  // pi emits the assistant `message_end` event the moment the LLM is done
  // generating, BEFORE the host has executed any tool calls. If we emit the
  // completed `agent_message` (RespData.type=2) at that point, its
  // `tool_calls[].status` is necessarily "started" — the executions have
  // not happened yet. The archon-server persists that RespData verbatim
  // into `session_messages.data_json` and never updates it, so
  // history-replay forever returns `tool_call_status=1` even though the
  // tools later completed. The post-`tool_execution_end` chunk
  // (RespData.type=6) carries the real `tool_call_status=2 + result_data`
  // but is not persisted by archon-server's chunk path.
  //
  // Fix: defer emitting the completed `agent_message` from `onMessageEnd`
  // until every `tool_execution_end` for that message has arrived, then
  // emit it once with the fully-resolved `tool_calls` (status + result_data).
  // Messages without any tool call still emit immediately at `onMessageEnd`.
  // Terminal helpers (`emitCompleted` / `emitAborted` / `emitFailed`) flush
  // any still-pending completed message so a host-side abort or failure
  // mid-tool-execution does not leak a never-persisted message.

  /** Number of `tool_execution_end` events still expected for the current message. */
  private pendingToolCount: number = 0;
  /** Final state of each completed tool call, keyed by tool_call_id. */
  private completedToolCalls: Map<string, RuntimeToolCall> = new Map();
  /** tool_execution_start wall-clock, keyed by tool_call_id (captureToolTiming only). */
  private toolStartMs: Map<string, number> = new Map();
  /**
   * Identity of each tool call whose arguments the model is still streaming,
   * keyed by pi's per-message `contentIndex` (only `toolcall_start` carries
   * the call id / tool name; `toolcall_delta` / `toolcall_end` reference the
   * index). Entries drop at `toolcall_end` or on message reset.
   */
  private preparingToolCalls: Map<number, { toolCallId: string; toolName: string }> = new Map();
  /** Captured `onMessageEnd` context, replayed once `pendingToolCount === 0`. */
  private pendingCompletedMessage: PendingCompletedMessageContext | undefined;

  constructor(ctx: EventBridgeContext) {
    this.ctx = ctx;
    this.now = ctx.nowMs ?? defaultNowMs;
    this.captureToolTiming = ctx.captureToolTiming === true;
    if (
      typeof ctx.contextWindow === 'number' &&
      Number.isFinite(ctx.contextWindow) &&
      ctx.contextWindow > 0
    ) {
      this.contextWindow = ctx.contextWindow;
    } else {
      this.contextWindow = DEFAULT_CONTEXT_WINDOW;
      ctx.logger?.warn?.(
        {
          session_id: ctx.sessionId,
          turn_id: ctx.turnId,
          fallback: DEFAULT_CONTEXT_WINDOW,
          received: ctx.contextWindow,
        },
        '[event-bridge] contextWindow missing or invalid, falling back to default',
      );
    }
  }

  /**
   * Inject the host-allocated assistant `message_id` after the bridge
   * requested one via {@link BridgedEvents.requestAssistantMessageId}.
   *
   * Calling this when no allocation was requested replaces the current
   * id (used for unit tests / re-entry). Calling with an empty string
   * clears the active id, which causes subsequent delta events to be
   * dropped until another `message_start` arrives.
   */
  setActiveAssistantMessageId(messageId: string): void {
    this.activeAssistantMessageId = messageId || undefined;
    this.awaitingMessageId = false;
  }

  /** Returns the current active assistant message id for per-call runtime context. */
  getActiveAssistantMessageId(): string | undefined {
    return this.activeAssistantMessageId;
  }

  /**
   * Drop the in-flight assistant response without emitting its message_end.
   * Used when a response-control hook rejects an empty response before the
   * bridge or history surfaces it to product consumers.
   */
  discardActiveAssistantMessage(): void {
    this.activeAssistantMessageId = undefined;
    this.awaitingMessageId = false;
    this.pendingCompletedMessage = undefined;
    this.completedToolCalls = new Map();
    this.toolStartMs = new Map();
    this.preparingToolCalls = new Map();
    this.pendingToolCount = 0;
  }

  /**
   * Feed a single pi `AgentEvent` and produce zero-or-more `RuntimeEvent`s.
   *
   * The bridge handles the events relevant to streaming assistant turns —
   * `message_*`, `tool_execution_*`. Pi lifecycle frames (`agent_*`,
   * `turn_*`, `tool_execution_update`) do not have a `stream.resp`
   * representation — hosts already track turn outcome at a higher level
   * (PiTurnRunner) and emit the terminal status explicitly. They are
   * surfaced as `debug.trace` events so observers (replay tools, cloud
   * tracing, daemon SSE consumers) can see Pi's full producer-side
   * lifecycle without affecting the canonical wire format. Callers can
   * still safely forward every event without coordination.
   */
  async processEvent(event: AgentEvent): Promise<BridgedEvents> {
    switch (event.type) {
      case 'message_start':
        return this.onMessageStart(event);
      case 'message_update':
        return this.onMessageUpdate(event);
      case 'message_end':
        return this.onMessageEnd(event);
      case 'tool_execution_start':
        return this.onToolStart(event);
      case 'tool_execution_end':
        return this.onToolEnd(event);
      case 'agent_start':
        return this.onPiLifecycleTrace('pi_agent_start', 'Pi agent run started');
      case 'agent_end':
        return this.onPiLifecycleTrace('pi_agent_end', 'Pi agent run ended', {
          message_count: event.messages.length,
        });
      case 'turn_start':
        return this.onPiLifecycleTrace('pi_turn_start', 'Pi turn started');
      case 'turn_end':
        return this.onPiLifecycleTrace('pi_turn_end', 'Pi turn ended', {
          tool_result_count: event.toolResults.length,
        });
      case 'tool_execution_update':
        return this.onPiLifecycleTrace(
          'pi_tool_execution_update',
          'Pi tool execution partial update',
          {
            tool_name: event.toolName,
            tool_call_id: event.toolCallId,
          },
        );
      default: {
        // Defensive — future pi variants surface here as a debug trace so
        // we can detect them without crashing.
        const e = event as { type?: string };
        return this.onPiLifecycleTrace('pi_event_unknown', 'Unrecognised pi AgentEvent', {
          event_type: e.type ?? 'unknown',
        });
      }
    }
  }

  /**
   * Emit a single `debug.trace` event carrying a Pi lifecycle marker.
   * Used for the producer-side frames (`agent_*` / `turn_*` /
   * `tool_execution_update`) that have no wire-level `stream.resp`
   * representation — surfacing them as traces keeps observers informed
   * without affecting the canonical streaming surface or message
   * lifecycle.
   */
  private onPiLifecycleTrace(
    phase: string,
    message: string,
    attrs?: Record<string, string | number | boolean>,
  ): BridgedEvents {
    return {
      events: [
        buildDebugTraceEvent({
          sessionId: this.ctx.sessionId,
          turnId: this.ctx.turnId,
          eventId: this.ctx.eventIdGenerator(phase),
          phase,
          message,
          ...(attrs ? { attrs } : {}),
        }),
      ],
    };
  }

  private onMessageStart(event: Extract<AgentEvent, { type: 'message_start' }>): BridgedEvents {
    const role = (event.message as { role?: unknown }).role;
    if (role !== 'assistant') {
      // Non-assistant messages (user / tool result) flow through without
      // chunked streaming — pi emits them as single-shot frames.
      return { events: [] };
    }
    // New assistant message — reset per-message state.
    this.activeAssistantMessageId = undefined;
    this.chunkIndex = 0;
    this.thinkingStartMs = undefined;
    this.firstTokenMs = undefined;
    this.thinkingEndMs = undefined;
    this.thinkingClosed = false;
    this.awaitingMessageId = true;
    // Tool-call lifecycle reset — a fresh assistant message starts with no
    // pending tool calls; the count + map are repopulated at onMessageEnd
    // and onToolEnd respectively.
    this.pendingToolCount = 0;
    this.completedToolCalls = new Map();
    this.toolStartMs = new Map();
    this.preparingToolCalls = new Map();
    this.pendingCompletedMessage = undefined;
    return { events: [], requestAssistantMessageId: true };
  }

  private onMessageUpdate(event: Extract<AgentEvent, { type: 'message_update' }>): BridgedEvents {
    const update = extractDeltaUpdate(event.assistantMessageEvent);
    if (!update) return { events: [] };
    if (!this.activeAssistantMessageId) {
      // No anchor message id yet — drop this delta with a debug trace
      // so observers can detect the misordering. Do NOT throw; the
      // contract is "best-effort streaming".
      return {
        events: [
          buildDebugTraceEvent({
            sessionId: this.ctx.sessionId,
            turnId: this.ctx.turnId,
            eventId: this.ctx.eventIdGenerator('coding_delta_dropped'),
            phase: 'event_bridge_delta_dropped',
            message: this.awaitingMessageId
              ? 'message_update arrived before host allocated assistant message_id'
              : 'message_update arrived without an active assistant message_id',
            level: 'warn',
            attrs: { delta_kind: update.kind },
          }),
        ],
      };
    }
    if (
      this.firstTokenMs === undefined &&
      (('delta' in update && update.delta !== '') ||
        ((update.kind === 'toolcall_start' || update.kind === 'toolcall_delta') &&
          update.toolName !== undefined))
    ) {
      this.firstTokenMs = this.now();
    }
    if (
      update.kind === 'toolcall_start' ||
      update.kind === 'toolcall_delta' ||
      update.kind === 'toolcall_end'
    ) {
      return this.onToolCallStreamUpdate(this.activeAssistantMessageId, update);
    }
    if (update.kind === 'thinking') {
      if (this.thinkingStartMs === undefined) this.thinkingStartMs = this.now();
      // Thinking is still streaming — keep the closed flag false so a
      // subsequent text_delta will close the thinking window.
      return {
        events: [
          buildThinkingDeltaChunk({
            sessionId: this.ctx.sessionId,
            turnId: this.ctx.turnId,
            eventId: this.ctx.eventIdGenerator('coding_thinking'),
            runtimeSeq: this.ctx.runtimeSeqGenerator(),
            msgId: this.activeAssistantMessageId,
            chunkIndex: this.nextChunkIndex(),
            delta: update.delta,
            nowMs: this.now(),
          }),
        ],
      };
    }
    // text delta — closes thinking window if we were tracking one.
    if (this.thinkingStartMs !== undefined && !this.thinkingClosed) {
      this.thinkingEndMs = this.now();
      this.thinkingClosed = true;
    }
    return {
      events: [
        buildTextDeltaChunk({
          sessionId: this.ctx.sessionId,
          turnId: this.ctx.turnId,
          eventId: this.ctx.eventIdGenerator('coding_text'),
          runtimeSeq: this.ctx.runtimeSeqGenerator(),
          msgId: this.activeAssistantMessageId,
          chunkIndex: this.nextChunkIndex(),
          delta: update.delta,
          nowMs: this.now(),
        }),
      ],
    };
  }

  /**
   * Model-side tool-call argument streaming (pi `toolcall_start` /
   * `toolcall_delta` / `toolcall_end` inside `message_update`). Surfaces the
   * argument-generation phase to stream consumers ahead of
   * `tool_execution_start` — for large arguments (a multi-minute novel edit)
   * the stream is otherwise silent from the last text delta until dispatch.
   * Provider streams carry the call identity on every frame via `partial`;
   * proxy streams only on the start frame — the bridge keeps a
   * contentIndex → identity mapping so identity-less frames still resolve.
   */
  private onToolCallStreamUpdate(msgId: string, update: ToolCallStreamUpdate): BridgedEvents {
    const frameIdentity =
      update.toolCallId !== undefined && update.toolName !== undefined
        ? { toolCallId: update.toolCallId, toolName: update.toolName }
        : undefined;
    const identity = frameIdentity ?? this.preparingToolCalls.get(update.contentIndex);
    if (!identity) {
      // No identity on the frame and no start frame seen — drop with a trace
      // so replay tooling can spot the misordering; streaming stays
      // best-effort.
      return {
        events: [
          buildDebugTraceEvent({
            sessionId: this.ctx.sessionId,
            turnId: this.ctx.turnId,
            eventId: this.ctx.eventIdGenerator('coding_toolcall_stream_dropped'),
            phase: 'event_bridge_toolcall_stream_dropped',
            message: 'tool-call stream frame arrived without a resolvable call identity',
            level: 'warn',
            attrs: { frame_kind: update.kind, content_index: update.contentIndex },
          }),
        ],
      };
    }
    if (update.kind === 'toolcall_end') {
      this.preparingToolCalls.delete(update.contentIndex);
      return this.buildToolCallStreamChunk(msgId, {
        tool_name: identity.toolName,
        tool_call_id: identity.toolCallId,
        status: 'prepared',
      });
    }
    this.preparingToolCalls.set(update.contentIndex, identity);
    return this.buildToolCallStreamChunk(msgId, {
      tool_name: identity.toolName,
      tool_call_id: identity.toolCallId,
      status: 'preparing',
      ...(update.kind === 'toolcall_delta' ? { args_text_delta: update.delta } : {}),
    });
  }

  private buildToolCallStreamChunk(msgId: string, toolCall: RuntimeToolCall): BridgedEvents {
    return {
      events: [
        buildToolCallChunk({
          sessionId: this.ctx.sessionId,
          turnId: this.ctx.turnId,
          eventId: this.ctx.eventIdGenerator('coding_tool'),
          runtimeSeq: this.ctx.runtimeSeqGenerator(),
          msgId,
          chunkIndex: this.nextChunkIndex(),
          toolCall,
          nowMs: this.now(),
        }),
      ],
    };
  }

  private async onMessageEnd(
    event: Extract<AgentEvent, { type: 'message_end' }>,
  ): Promise<BridgedEvents> {
    const role = (event.message as { role?: unknown }).role;
    if (role !== 'assistant') return { events: [] };
    const messageId = this.activeAssistantMessageId;
    if (!messageId) {
      // message_end without an active id — emit a debug trace; the host
      // is responsible for deciding whether to fail the turn.
      return {
        events: [
          buildDebugTraceEvent({
            sessionId: this.ctx.sessionId,
            turnId: this.ctx.turnId,
            eventId: this.ctx.eventIdGenerator('coding_message_end_dropped'),
            phase: 'event_bridge_message_end_dropped',
            message: 'message_end arrived without an active assistant message_id',
            level: 'warn',
          }),
        ],
      };
    }
    // Close the thinking window if it never closed via a text delta.
    if (this.thinkingStartMs !== undefined && !this.thinkingClosed) {
      this.thinkingEndMs = this.now();
      this.thinkingClosed = true;
    }
    // Abort short-circuit: when pi's `handleRunFailure` synthesises a
    // failureMessage for an aborted run (stopReason='aborted',
    // content=[{type:'text', text:''}], errorMessage='Request was aborted'),
    // suppress the message_end emit entirely. The outer host calls
    // `emitTerminal({kind:'aborted'})` → `emitAborted()` to deliver the
    // terminal session.status aborted frame, which is the
    // sole user-visible signal for an abort. Without this short-circuit
    // the bridge would emit a finish chunk + a completed assistant
    // message whose body is `[Error] Request was aborted` (composed at
    // L450-452 from the empty content fallback), surfacing on the wire
    // as a fake assistant turn that the UI renders as a chat bubble.
    // Drop pending state so a subsequent terminal helper's
    // `flushPendingCompletedMessage()` cannot resurrect this message.
    const stopReason = extractAssistantStopReason(event.message);
    if (stopReason === 'aborted') {
      this.activeAssistantMessageId = undefined;
      this.pendingCompletedMessage = undefined;
      this.completedToolCalls = new Map();
      this.toolStartMs = new Map();
      this.pendingToolCount = 0;
      return { events: [] };
    }
    const errorMessage = extractAssistantErrorMessage(event.message);
    if (errorMessage) this.lastAssistantErrorMessage = errorMessage;
    // When an LLM error maps to a typed daemon code supported by the UI, emit a compact
    // `code:message` terminal error. The UI consumes assistant + finish_reason=error
    // as session status; local-runtime filters out these terminal assistant bubbles.
    const classified = errorMessage ? classifyLLMErrorToCode(errorMessage) : null;
    const typedErrorText =
      classified !== null && TYPED_TERMINAL_ERROR_CODES.has(classified.status_code)
        ? `${classified.status_code}:${classified.message}`
        : undefined;
    const text =
      extractAssistantText(event.message) ||
      typedErrorText ||
      (errorMessage ? `[Error] ${errorMessage}` : '');
    const thinking = extractAssistantThinking(event.message) || undefined;
    const toolCalls = extractAssistantToolCalls(event.message);
    const finishReason = isAssistantError(event.message) ? 'error' : stopReason;
    const thinkingDurationMs =
      this.thinkingStartMs !== undefined && this.thinkingEndMs !== undefined
        ? Math.max(0, this.thinkingEndMs - this.thinkingStartMs)
        : undefined;
    const requestDurationMs =
      this.ctx.includeDetailedUsage === true
        ? this.ctx.requestDurationMs?.(event.message)
        : undefined;
    const decodeDurationMs =
      this.ctx.includeDetailedUsage === true && this.firstTokenMs !== undefined
        ? Math.max(0, this.now() - this.firstTokenMs)
        : undefined;
    const usage: TokenUsage = {
      ...(extractAssistantUsage(event.message, this.contextWindow) ?? {
        total_tokens: 0,
        context_window: this.contextWindow,
      }),
      ...(decodeDurationMs !== undefined && Number.isFinite(decodeDurationMs)
        ? { decode_duration_ms: decodeDurationMs }
        : {}),
      ...(typeof requestDurationMs === 'number' &&
      Number.isFinite(requestDurationMs) &&
      requestDurationMs > 0
        ? { request_duration_ms: requestDurationMs }
        : {}),
    };

    // Always emit the finish chunk immediately at message_end — it signals
    // "LLM is done generating" and downstream consumers (UI, archon-server
    // queue gating) rely on it to advance state regardless of tool-execution
    // status. The completed RespData (type=2) emit is decided next.
    const finishEvent = buildFinishChunk({
      sessionId: this.ctx.sessionId,
      turnId: this.ctx.turnId,
      eventId: this.ctx.eventIdGenerator('coding_finish'),
      runtimeSeq: this.ctx.runtimeSeqGenerator(),
      msgId: messageId,
      chunkIndex: this.nextChunkIndex(),
      ...(finishReason ? { finishReason } : {}),
      ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
      nowMs: this.now(),
    });

    if (toolCalls.length === 0) {
      // No tool execution to wait for — emit the completed agent_message
      // right away, same as the legacy path.
      const completedEvent = await buildCompletedAssistantMessage(
        {
          sessionId: this.ctx.sessionId,
          turnId: this.ctx.turnId,
          eventId: this.ctx.eventIdGenerator('coding_completed'),
          runtimeSeq: this.ctx.runtimeSeqGenerator(),
          msgId: messageId,
          text,
          ...(thinking !== undefined ? { thinking } : {}),
          ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
          ...(finishReason ? { finishReason } : {}),
          usage,
          nowMs: this.now(),
          logger: this.ctx.logger,
        },
        this.ctx.respDataTransform,
      );
      this.activeAssistantMessageId = undefined;
      return { events: [finishEvent, completedEvent] };
    }

    // Tool calls present — defer the completed agent_message emit until
    // every tool_execution_end arrives. Capture the message context;
    // onToolEnd will fire the deferred emit when pendingToolCount drops
    // to zero with fully-resolved tool_calls (status + result_data).
    // activeAssistantMessageId stays set so subsequent tool_execution_*
    // events attach to this message.
    this.pendingToolCount = toolCalls.length;
    this.completedToolCalls = new Map();
    this.toolStartMs = new Map();
    this.pendingCompletedMessage = {
      msgId: messageId,
      text,
      thinking,
      thinkingDurationMs,
      finishReason,
      usage,
    };
    return { events: [finishEvent] };
  }

  private onToolStart(event: Extract<AgentEvent, { type: 'tool_execution_start' }>): BridgedEvents {
    if (!this.activeAssistantMessageId) {
      return {
        events: [
          buildDebugTraceEvent({
            sessionId: this.ctx.sessionId,
            turnId: this.ctx.turnId,
            eventId: this.ctx.eventIdGenerator('coding_tool_start_dropped'),
            phase: 'event_bridge_tool_start_dropped',
            message: 'tool_execution_start arrived without an active assistant message_id',
            level: 'warn',
            attrs: { tool_name: event.toolName, tool_call_id: event.toolCallId },
          }),
        ],
      };
    }
    const args = event.args;
    const toolCall: RuntimeToolCall = {
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      status: 'started',
      ...(args !== undefined && typeof args === 'object' && args !== null
        ? { args: args as Record<string, unknown> }
        : {}),
      ...this.resolveToolCallProvenance({
        phase: 'start',
        toolName: event.toolName,
        ...(args !== undefined && typeof args === 'object' && args !== null
          ? { args: args as Record<string, unknown> }
          : {}),
      }),
    };
    // Stage this tool call's started-state snapshot (with `args`) into the
    // deferred completed-message buffer so that when `onToolEnd` later
    // overlays status + result, the `args` payload survives into the
    // flushed RespData. Prior behaviour only wrote on tool_execution_end,
    // which dropped `args` from the persisted completed message — the
    // frontend then could not render the tool call's input parameters
    // after the turn finished.
    this.completedToolCalls.set(event.toolCallId, toolCall);
    if (this.captureToolTiming) {
      this.toolStartMs.set(event.toolCallId, this.now());
    }
    return {
      events: [
        buildDebugTraceEvent({
          sessionId: this.ctx.sessionId,
          turnId: this.ctx.turnId,
          eventId: this.ctx.eventIdGenerator('coding_trace_tool_call_started'),
          phase: 'tool_call_started',
          message: 'Host tool call started',
          attrs: { tool_name: event.toolName, tool_call_id: event.toolCallId },
        }),
        buildToolCallChunk({
          sessionId: this.ctx.sessionId,
          turnId: this.ctx.turnId,
          eventId: this.ctx.eventIdGenerator('coding_tool'),
          runtimeSeq: this.ctx.runtimeSeqGenerator(),
          msgId: this.activeAssistantMessageId,
          chunkIndex: this.nextChunkIndex(),
          toolCall,
          nowMs: this.now(),
        }),
      ],
    };
  }

  private async onToolEnd(
    event: Extract<AgentEvent, { type: 'tool_execution_end' }>,
  ): Promise<BridgedEvents> {
    if (!this.activeAssistantMessageId) {
      return {
        events: [
          buildDebugTraceEvent({
            sessionId: this.ctx.sessionId,
            turnId: this.ctx.turnId,
            eventId: this.ctx.eventIdGenerator('coding_tool_end_dropped'),
            phase: 'event_bridge_tool_end_dropped',
            message: 'tool_execution_end arrived without an active assistant message_id',
            level: 'warn',
            attrs: { tool_name: event.toolName, tool_call_id: event.toolCallId },
          }),
        ],
      };
    }
    // Preserve `args` captured at tool_execution_start: the started-state
    // entry already in `completedToolCalls` carries the input parameters
    // (pi's tool_execution_end event does not re-emit them). Overlay the
    // terminal status + result on top of that snapshot so the flushed
    // RespData has the full (args + status=completed/failed + result)
    // shape — not just (status + result).
    const startedSnapshot = this.completedToolCalls.get(event.toolCallId);
    let durationMs: number | undefined;
    if (this.captureToolTiming) {
      const startMs = this.toolStartMs.get(event.toolCallId);
      if (startMs !== undefined) {
        durationMs = this.now() - startMs;
        this.toolStartMs.delete(event.toolCallId);
      }
    }
    const toolCall: RuntimeToolCall = {
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      ...(startedSnapshot?.args !== undefined ? { args: startedSnapshot.args } : {}),
      status: event.isError ? 'failed' : 'completed',
      ...(event.result !== undefined ? { result: event.result } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      ...this.resolveToolCallProvenance(
        {
          phase: 'end',
          toolName: event.toolName,
          ...(startedSnapshot?.args !== undefined ? { args: startedSnapshot.args } : {}),
          ...(event.result !== undefined ? { result: event.result } : {}),
          isError: event.isError,
        },
        startedSnapshot?.plugin_provenances,
      ),
    };
    const events: BridgedEvents['events'] = [
      buildDebugTraceEvent({
        sessionId: this.ctx.sessionId,
        turnId: this.ctx.turnId,
        eventId: this.ctx.eventIdGenerator('coding_trace_tool_call_completed'),
        phase: 'tool_call_completed',
        message: 'Host tool call completed',
        attrs: {
          tool_name: event.toolName,
          tool_call_id: event.toolCallId,
          is_error: event.isError,
          ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
        },
      }),
      buildToolCallChunk({
        sessionId: this.ctx.sessionId,
        turnId: this.ctx.turnId,
        eventId: this.ctx.eventIdGenerator('coding_tool'),
        runtimeSeq: this.ctx.runtimeSeqGenerator(),
        msgId: this.activeAssistantMessageId,
        chunkIndex: this.nextChunkIndex(),
        toolCall,
        nowMs: this.now(),
      }),
    ];

    // Record this tool's final state for the deferred completed-message emit.
    // Last-write-wins per tool_call_id so re-emitted ends (defensive) collapse
    // to a single entry.
    this.completedToolCalls.set(event.toolCallId, toolCall);
    if (this.pendingToolCount > 0) {
      this.pendingToolCount--;
    }

    // Flush the deferred completed agent_message once every expected tool
    // has reported back. Emitted with the fully-resolved tool_calls array
    // (status=completed/failed + result_data), so the archon-server persist
    // path writes the terminal-state message into session_messages.data_json
    // — history-replay therefore returns the final tool_call_status,
    // not the start-time snapshot.
    if (this.pendingToolCount === 0 && this.pendingCompletedMessage) {
      const flushed = await this.flushPendingCompletedMessage();
      if (flushed) events.push(flushed);
    }

    return { events };
  }

  private resolveToolCallProvenance(
    input: Parameters<NonNullable<EventBridgeContext['toolCallProvenanceResolver']>>[0],
    fallback?: readonly IPluginCapabilityProvenance[],
  ): Pick<RuntimeToolCall, 'plugin_provenances'> | object {
    const resolver = this.ctx.toolCallProvenanceResolver;
    if (!resolver) {
      return fallback?.length ? { plugin_provenances: fallback.map((item) => ({ ...item })) } : {};
    }
    try {
      const resolved = normalizePluginProvenances(resolver(input));
      const effective = resolved.length > 0 ? resolved : fallback;
      return effective?.length
        ? { plugin_provenances: effective.map((item) => ({ ...item })) }
        : {};
    } catch (error) {
      this.ctx.logger?.warn?.(
        {
          session_id: this.ctx.sessionId,
          turn_id: this.ctx.turnId,
          tool_name: input.toolName,
          phase: input.phase,
          error: error instanceof Error ? error.message : String(error),
        },
        '[event-bridge] Plugin provenance resolver failed open',
      );
      return fallback?.length ? { plugin_provenances: fallback.map((item) => ({ ...item })) } : {};
    }
  }

  /**
   * Emit the deferred completed `agent_message` captured at `onMessageEnd`,
   * filling `tool_calls` with the final state collected from every
   * subsequent `onToolEnd`. Returns the RespData StreamRespEvent (the
   * caller appends it to its own event list), or `undefined` when there is
   * nothing to flush. Always clears the deferred state on the way out so
   * a subsequent terminal helper does not double-emit.
   */
  private async flushPendingCompletedMessage() {
    const pending = this.pendingCompletedMessage;
    if (!pending) return undefined;
    const toolCalls = Array.from(this.completedToolCalls.values());
    const event = await buildCompletedAssistantMessage(
      {
        sessionId: this.ctx.sessionId,
        turnId: this.ctx.turnId,
        eventId: this.ctx.eventIdGenerator('coding_completed'),
        runtimeSeq: this.ctx.runtimeSeqGenerator(),
        msgId: pending.msgId,
        text: pending.text,
        ...(pending.thinking !== undefined ? { thinking: pending.thinking } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(pending.thinkingDurationMs !== undefined
          ? { thinkingDurationMs: pending.thinkingDurationMs }
          : {}),
        ...(pending.finishReason ? { finishReason: pending.finishReason } : {}),
        usage: pending.usage,
        nowMs: this.now(),
        logger: this.ctx.logger,
      },
      this.ctx.respDataTransform,
    );
    // Clear deferred state and the active assistant id — the message
    // lifecycle is fully complete (LLM done + all tools resolved + RespData
    // emitted). Subsequent tool_execution_* events without a new
    // message_start will fall into the "no active assistant id" debug-trace
    // branch, which is the correct fail-loud behavior.
    this.pendingCompletedMessage = undefined;
    this.completedToolCalls = new Map();
    this.toolStartMs = new Map();
    this.pendingToolCount = 0;
    this.activeAssistantMessageId = undefined;
    return event;
  }

  // ─── Terminal helpers ─────────────────────────────────────────────────
  //
  // All terminal helpers are async so they can flush a deferred completed
  // assistant message (captured by onMessageEnd + held by onToolEnd until
  // the last `tool_execution_end`) that was still in flight when the turn
  // terminated — e.g. the user aborted mid-tool-execution, or the host
  // hit a runtime failure before every tool reported back. Flushing here
  // means the message still reaches archon-server's persist path with
  // whatever tool_call state is known so far, instead of being silently
  // dropped. Subsequent debug/terminal events are appended after the
  // flushed completed message.

  /** Emit the terminal `session.status completed` frame. */
  async emitCompleted(): Promise<BridgedEvents> {
    const pending = await this.flushPendingCompletedMessage();
    const events: BridgedEvents['events'] = [];
    if (pending) events.push(pending);
    events.push(
      buildDebugTraceEvent({
        sessionId: this.ctx.sessionId,
        turnId: this.ctx.turnId,
        eventId: this.ctx.eventIdGenerator('coding_trace_turn_completed'),
        phase: 'turn_completed',
        message: 'Coding agent loop completed',
      }),
      buildCompletedTerminalStatusEvent({
        sessionId: this.ctx.sessionId,
        turnId: this.ctx.turnId,
        statusEventId: this.ctx.eventIdGenerator('coding_idle'),
      }),
    );
    return { events };
  }

  /** Emit the terminal `session.status aborted` frame. */
  async emitAborted(): Promise<BridgedEvents> {
    const pending = await this.flushPendingCompletedMessage();
    const events: BridgedEvents['events'] = [];
    if (pending) events.push(pending);
    events.push(
      buildDebugTraceEvent({
        sessionId: this.ctx.sessionId,
        turnId: this.ctx.turnId,
        eventId: this.ctx.eventIdGenerator('coding_trace_turn_aborted'),
        phase: 'turn_failed',
        message: 'Coding agent loop was aborted',
        attrs: { reason: 'aborted' },
      }),
      buildAbortedTerminalStatusEvent({
        sessionId: this.ctx.sessionId,
        turnId: this.ctx.turnId,
        statusEventId: this.ctx.eventIdGenerator('coding_aborted_status'),
      }),
    );
    return { events };
  }

  /**
   * Emit the terminal `session.status failed` frame with the supplied human-readable message.
   * Callers that have already captured an `errorMessage` from a pi assistant message should pass
   * that text in.
   *
   * When the host has classified the failure (e.g. LLM 401 -> LLM_AUTH_ERROR), pass `error` to
   * forward the typed runtime status code to the `session.status` wire payload. If the caller omits
   * `error`, use `{ code: INTERNAL_ERROR, message }` by default.
   */
  async emitFailed(message: string, error?: RuntimeProtocolError): Promise<BridgedEvents> {
    const text = message || this.lastAssistantErrorMessage || 'Coding agent loop failed.';
    const pending = await this.flushPendingCompletedMessage();
    const events: BridgedEvents['events'] = [];
    if (pending) events.push(pending);
    events.push(
      buildDebugTraceEvent({
        sessionId: this.ctx.sessionId,
        turnId: this.ctx.turnId,
        eventId: this.ctx.eventIdGenerator('coding_trace_turn_failed'),
        phase: 'turn_failed',
        message: 'Coding agent loop returned an error',
        attrs: { reason: 'assistant_error' },
      }),
      buildFailedTerminalStatusEvent({
        sessionId: this.ctx.sessionId,
        turnId: this.ctx.turnId,
        statusEventId: this.ctx.eventIdGenerator('coding_failed_status'),
        message: text,
        ...(error ? { error } : {}),
      }),
    );
    return { events };
  }

  /**
   * Convenience dispatcher mapping a {@link TurnTerminationReason} to the
   * right terminal helper. Useful when callers track termination state
   * elsewhere and want a single emit point.
   */
  async emitTerminal(reason: TurnTerminationReason): Promise<BridgedEvents> {
    switch (reason.kind) {
      case 'completed':
        return this.emitCompleted();
      case 'aborted':
        return this.emitAborted();
      case 'failed':
        return this.emitFailed(reason.message, reason.error);
      default: {
        const exhaustive: never = reason;
        throw new Error(`Unhandled TurnTerminationReason: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private nextChunkIndex(): number {
    const idx = this.chunkIndex;
    this.chunkIndex = idx + 1;
    return idx;
  }
}

function normalizePluginProvenances(
  input: readonly IPluginCapabilityProvenance[] | undefined,
): IPluginCapabilityProvenance[] {
  if (!input?.length) return [];
  const normalized = input.flatMap((item) => {
    const pluginName = item.plugin_name?.trim();
    const capabilityName = item.capability_name?.trim();
    const validSource =
      item.source === InstalledPluginSource.OFFICIAL || item.source === InstalledPluginSource.LOCAL;
    const validCapability =
      item.capability_type === PluginCapabilityType.APP ||
      item.capability_type === PluginCapabilityType.MCP ||
      item.capability_type === PluginCapabilityType.SKILL;
    if (!pluginName || !capabilityName || !validSource || !validCapability) return [];
    const pluginVersion = item.plugin_version?.trim();
    const iconUrl = item.icon_url?.trim();
    const darkIconUrl = item.dark_icon_url?.trim();
    return [
      {
        plugin_name: pluginName,
        ...(pluginVersion ? { plugin_version: pluginVersion } : {}),
        source: item.source,
        capability_type: item.capability_type,
        capability_name: capabilityName,
        ...(iconUrl ? { icon_url: iconUrl } : {}),
        ...(darkIconUrl ? { dark_icon_url: darkIconUrl } : {}),
      },
    ];
  });
  const unique = new Map<string, IPluginCapabilityProvenance>();
  for (const item of normalized) {
    const key = [
      item.plugin_name.normalize('NFKC').toLocaleLowerCase('en-US'),
      item.plugin_version ?? '',
      item.source,
      item.capability_type,
      item.capability_name,
    ].join('\0');
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.plugin_name.localeCompare(right.plugin_name, 'en-US') ||
      (left.plugin_version ?? '').localeCompare(right.plugin_version ?? '', 'en-US') ||
      left.capability_name.localeCompare(right.capability_name, 'en-US'),
  );
}
