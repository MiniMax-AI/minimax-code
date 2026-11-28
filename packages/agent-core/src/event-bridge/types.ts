/**
 * Shared types for the event-bridge subsystem.
 *
 * Hosts (daemon, cloud-runtime) wire concrete services in `host-utils.ts`;
 * everything in this file is pure type vocabulary.
 */

import type { RuntimeEvent, RuntimeProtocolError } from '../protocol/runtime-event.js';
import type { ToolCallProvenanceResolver } from '../tools/types.js';
import type { RespDataTransform } from './resp-data.js';
import type { TurnToolCallContent } from './tool-call-content.js';
import type { PiTurnRunnerLogger } from '../pi-turn-runner/types.js';

/**
 * Stable identity hooks that callers must thread through every conversion
 * call. Pulled into a single bag so the bridge stays decoupled from how
 * hosts mint event ids and runtime sequence numbers (daemon uses an
 * in-process counter, cloud-runtime delegates to archon_server).
 *
 * `eventIdGenerator` receives a short kind hint (`coding_text`,
 * `coding_finish`, …) so loggers can identify the event source. The
 * returned id MUST be globally unique within the session.
 *
 * `runtimeSeqGenerator` returns monotonically increasing positive
 * integers within a single (session, turn) pair. Phase 1 archon_server
 * uses these to order events; missing or reused values break replay.
 *
 * `nowMs` is optional — when omitted, the bridge falls back to `Date.now()`.
 * Tests inject a deterministic source.
 *
 * `contextWindow` is optional and threaded in from the resolved Pi
 * `Model<Api>` — it is used to populate the wire-level `TokenUsage`
 * `context_window` field on every assistant message. When omitted the
 * bridge falls back to `DEFAULT_CONTEXT_WINDOW` (200_000) and logs a
 * one-shot warn so observability can spot misconfigured hosts.
 */
export interface EventBridgeContext {
  sessionId: string;
  turnId: string;
  eventIdGenerator: (kind: string) => string;
  runtimeSeqGenerator: () => number;
  nowMs?: () => number;
  /** Physical provider request duration associated with a completed assistant message. */
  requestDurationMs?: (message: unknown) => number | undefined;
  /** Include per-request input/output/duration fields in wire usage. */
  includeDetailedUsage?: boolean;
  /** Optional hook applied to completed AgentMessage RespData before serialization. */
  respDataTransform?: RespDataTransform;
  logger?: PiTurnRunnerLogger;
  /** Optional context-window size for the active model. */
  contextWindow?: number;
  /** Measure per-tool-call `duration_ms` (start → end). Host sets it non-prod only. */
  captureToolTiming?: boolean;
  /** Turn-local, fail-open resolver for Plugin capability attribution. */
  toolCallProvenanceResolver?: ToolCallProvenanceResolver;
  /** Host-owned turn registry; receives each call's raw arguments and final result. */
  toolCallContent?: TurnToolCallContent;
}

/**
 * Outcome of converting a single pi `AgentEvent`.
 *
 * `events` carries the canonical `RuntimeEvent[]` to forward to the host's
 * `EventSink.pushRuntime`. The optional `requestAssistantMessageId` flag
 * signals that the bridge needs the host to allocate a fresh assistant
 * `message_id` before any further events for this turn can be emitted —
 * see {@link EventBridge.processEvent} for the contract.
 */
export interface BridgedEvents {
  /** RuntimeEvents ready to push to EventSink. */
  events: RuntimeEvent[];
  /**
   * When set, the caller must allocate an assistant message id (via host
   * port) and call {@link EventBridge.setActiveAssistantMessageId} BEFORE
   * the next event is fed in. The bridge cannot emit `stream.resp` events
   * without an assistant message id, so it returns no events on
   * `message_start` until the host has resolved one.
   */
  requestAssistantMessageId?: boolean;
}

/**
 * Reasons used to build a non-success terminal frame.
 *
 * The bridge produces a terminal `session.status` frame so downstream
 * consumers see consistent `stop_reason` / `error` payloads.
 *
 * `failed.error` is optional — when the host has already classified the
 * underlying failure (e.g. LLM 401 / 429), pass it through so
 * `session.status.payload.error.code` carries the stable status code.
 * Caller omits it → bridge falls back to `{ code: INTERNAL_ERROR, message }`.
 */
export type TurnTerminationReason =
  | { kind: 'completed' }
  | { kind: 'aborted' }
  | { kind: 'failed'; message: string; error?: RuntimeProtocolError };

export type {
  ToolCallProvenanceResolutionInput,
  ToolCallProvenanceResolver,
} from '../tools/types.js';
