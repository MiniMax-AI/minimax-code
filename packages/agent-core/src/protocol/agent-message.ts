/**
 * Agent message protocol types.
 *
 * **Pure types only** — no implementations. Migrated from
 * `packages/daemon/src/common/agent-protocol.ts` so the same shapes can be
 * referenced by daemon (local) and cloud-runtime (remote) hosts without
 * either side importing the other.
 *
 * `AgentMessage` represents a complete assistant turn (a closed message), and
 * `AgentMessageChunk` represents a streaming delta. They were originally
 * defined as part of the SSE wire format used by daemon → UI; runtime layers
 * (cloud-runtime ExchangeSink) translate between this shape and the
 * higher-level {@link RuntimeEvent} family.
 *
 * Phase 2 plan: this file becomes a pure structural representation while the
 * canonical wire format unifies on `RuntimeEvent`. Until then,
 * `AgentMessageChunk` is what daemon SSE pushes and what archon_server
 * accepts (cloud-runtime adapts its `RuntimeEvent` stream into this shape
 * before reporting upstream).
 */

/**
 * Logical type tag for `RespData` envelope frames. Daemon SSE wraps each
 * frame in `{ type, agent_message?, agent_message_chunk? }` and the type
 * field tells the consumer which alternate is set.
 */
export const RespDataType = {
  /** Complete `AgentMessage` (closed turn). */
  AgentMessage: 2,
  /** Streaming `AgentMessageChunk` (delta). */
  AgentMessageChunk: 6,
  /** Liveness ping — no payload. */
  Heartbeat: 10,
} as const;
export type RespDataType = (typeof RespDataType)[keyof typeof RespDataType];

/**
 * Tool-call lifecycle stages emitted alongside an assistant message.
 * `Preparing` / `Prepared` are the model-side argument-streaming phases
 * (arguments still being generated / generated but not yet dispatched);
 * `Start` is the host dispatching the tool for execution.
 */
export const ToolCallStatus = {
  Start: 1,
  Finished: 2,
  Failed: 3,
  Preparing: 4,
  Prepared: 5,
} as const;
export type ToolCallStatus = (typeof ToolCallStatus)[keyof typeof ToolCallStatus];

/**
 * Tool invocation record carried by either {@link AgentMessage} or
 * {@link AgentMessageChunk}. `tool_call_args` and `tool_call_result_data`
 * are JSON-encoded strings so the wire format remains opaque to type
 * narrowing consumers.
 */
export interface ToolCall {
  tool_name: string;
  tool_call_id: string;
  /** Optional parent run_code id for a host-executed PTC child call. */
  parent_tool_call_id?: string;
  tool_call_status: ToolCallStatus;
  /** JSON string of the argument object the model produced. */
  tool_call_args?: string;
  /**
   * Raw argument-JSON fragment streamed while the call is `Preparing`.
   * Consumers accumulate fragments in chunk order; the concatenation
   * converges on `tool_call_args` once the call leaves `Preparing`.
   */
  tool_call_args_delta?: string;
  /** JSON string of the structured result returned by the tool runtime. */
  tool_call_result_data?: string;
  /** Tool execution wall-clock in ms; non-prod / debug only. */
  tool_call_duration_ms?: number;
  /** Plugin owners resolved by the turn-local runtime attribution snapshot. */
  plugin_provenances?: import('@mavis/protocol').IPluginCapabilityProvenance[];
}

/**
 * 标记来自非用户驱动流程的 display message。UI 据此渲染不进入模型上下文
 * 的生命周期状态，例如上下文压缩与父会话 Review activity。
 *
 * 压缩生命周期三态由 local-runtime-v2 的 agent projection 持久化：
 * - `compaction_start`：压缩已开始（摘要 LLM 调用进行中）。运行态帧，UI 渲染"压缩中"。
 * - `compaction`：压缩成功完成的终态帧。
 * - `compaction_failed`：压缩失败的终态帧。除实时失败外，进程崩溃遗留的
 *   孤儿 `compaction_start` 也会在重载时被降级成此态。
 *
 * 压缩帧的运行/终止状态完全由 kind 表达，不应携带 `finish_reason` ——
 * finish_reason 是助手回答消息的完成语义，压缩帧复用它会与回答消息的
 * 终态判定混淆。
 *
 * 三帧共用同一个 `msg_id`（即 compactionId），持久化按 msg_id upsert，
 * 后一帧原地覆盖前一帧 —— 会话里最终只留一条压缩消息，其 kind 就是最新状态。
 */
export type MessageKind =
  | 'compaction_start'
  | 'compaction'
  | 'compaction_failed'
  | 'review_start'
  | 'review_result'
  | 'review_failed'
  | 'review_aborted'
  | 'review_interrupted';

/** Speaker role on a message. */
export const Role = {
  User: 'user',
  Assistant: 'assistant',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** Logical type of a single complete message — see UI message rendering. */
export const MsgType = {
  AgentContent: 1,
  AgentToolCall: 2,
  SystemEvent: 3,
} as const;
export type MsgType = (typeof MsgType)[keyof typeof MsgType];

/** Token usage rolled into a turn-level message. */
export interface TokenUsage {
  total_tokens: number;
  context_window: number;
  /** Single-turn context footprint when `total_tokens` sums multiple continuation hops. */
  context_tokens?: number;
  /** Provider-reported prompt tokens for this physical request. */
  input_tokens?: number;
  /** Provider-reported generated tokens for this physical request. */
  output_tokens?: number;
  /** Full physical provider request duration, including first-token wait. */
  request_duration_ms?: number;
  /** First nonempty text/thinking/tool token to message_end, excluding tool execution. */
  decode_duration_ms?: number;
  /**
   * Cached prompt tokens reused across turns (provider-specific). Optional so
   * legacy producers/consumers stay compatible; Pi providers surface this via
   * `AssistantMessage.usage.cacheRead`.
   */
  cache_read?: number;
  /**
   * New cache writes recorded for this turn (provider-specific). Optional so
   * legacy producers/consumers stay compatible; Pi providers surface this via
   * `AssistantMessage.usage.cacheWrite`.
   */
  cache_write?: number;
}

export type ContextUsageSnapshotTrigger = 'terminal' | 'auto_compaction' | 'manual_compaction';

export type ContextUsageToolCalibrationStatus = 'PENDING' | 'REMOTE' | 'EMPTY' | 'UNAVAILABLE';

/**
 * Ephemeral observability sidecar for a newly published Context Usage
 * snapshot. UI consumes it only on the live stream and does not project it
 * into Context Usage product state.
 */
export interface ContextUsageSnapshotTelemetry {
  trigger: ContextUsageSnapshotTrigger;
  turnId: string;
  model: string;
  localTokens: number;
  providerTokens?: number;
  divergenceRate?: number;
  toolCalibrationStatus?: ContextUsageToolCalibrationStatus;
}

/** A streaming delta carrying partial text / thinking / tool-call updates. */
export interface AgentMessageChunk {
  msg_id: string;
  parent_msg_id?: string;
  msg_content?: string;
  tool_calls?: ToolCall[];
  thinking_content?: string;
  thinking_duration_ms?: number;
  chunk_index?: number;
  finish?: boolean;
  finish_reason?: string;
  /** Unix-ms timestamp produced by the source runtime. */
  timestamp?: number;
  role?: Role;
  /** Existing runtime turn identity. Historical frames may omit it. */
  turn_id?: string;
  /** Optional message classification — see {@link MessageKind}. */
  kind?: MessageKind;
}

/** A complete (settled) assistant or user message. */
export interface AgentMessage {
  msg_id: string;
  parent_msg_id?: string;
  /** Unix-ms timestamp produced by the source runtime. */
  timestamp?: number;
  msg_content?: string;
  /** Set when `msg_content` is runtime-authored rather than model output. */
  msg_content_source?: 'system_error';
  msg_type?: MsgType;
  role?: Role;
  thinking_content?: string;
  thinking_duration_ms?: number;
  finish_reason?: string;
  tool_calls?: ToolCall[];
  attachments?: Array<{
    type: 'file' | 'image';
    file_path: string;
    file_name: string;
    mime_type: string;
    desktop_path?: string;
    data_url?: string;
    asset_id?: string;
  }>;
  usage?: TokenUsage;
  /** Electron-local current-context snapshot. Never sent to cloud runtime. */
  context_usage?: {
    contextWindowTokens: number;
    usedTokens: number;
    totalCountSource: 'LOCAL_ESTIMATE' | 'PROVIDER_USAGE_ANCHORED';
    components: Array<{
      kind:
        | 'SYSTEM_PROMPT'
        | 'MEMORY'
        | 'TOOLS'
        | 'SKILLS'
        /** @deprecated Read-only compatibility for snapshots written before the six-category rollback. */
        | 'PROJECT_INSTRUCTIONS'
        | 'MESSAGES'
        | 'OTHER';
      tokens: number;
    }>;
  };
  /** Live-only Guance reporting sidecar for `context_usage`. */
  context_usage_telemetry?: ContextUsageSnapshotTelemetry;
  source?: string;
  source_message_id?: string;
  /** Existing runtime turn identity. Historical rows may omit it. */
  turn_id?: string;
  origin?: unknown;
  /** Optional message classification — see {@link MessageKind}. */
  kind?: MessageKind;
}

/**
 * Legacy aliases for {@link AgentMessageChunk} / {@link AgentMessage}.
 *
 * The harness-agent-era code imported these as `AgentMessageChunkProtocol`
 * / `AgentMessageProtocol` (distinguishing the protocol-level shape from
 * the channel-side `AgentMessage` envelope in `host/types.ts`). After
 * absorbing harness-agent into agent-core, callers can use either name —
 * the shapes are identical.
 */
export type AgentMessageChunkProtocol = AgentMessageChunk;
export type AgentMessageProtocol = AgentMessage;

/**
 * SSE envelope frame used by daemon between
 * `daemon → UI` and (Phase 1 only) `cloud-runtime → archon_server`.
 *
 * `agent_message` and `agent_message_chunk` are mutually exclusive — the
 * `type` field disambiguates.
 */
export interface RespData {
  type: RespDataType;
  agent_message?: AgentMessage;
  agent_message_chunk?: AgentMessageChunk;
}
