/**
 * Pi turn runner boundary types.
 *
 * These are explicit per-turn contracts owned by `pi-turn-runner`. They
 * describe the model, event writer, user message, and tool configuration
 * supplied to `PiTurnRunner.runTurn(...)`; hosts may own event identity when
 * Pi attempts and native tools must share one logical-Turn sequence.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  Api,
  CacheRetention,
  ImageContent,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { IRuntimeEvent } from '@mavis/protocol';
import type {
  AgentKindLabel,
  ModelCallRouteLabel,
  TurnWakeLabel,
} from '@mavis/shared/local-runtime-logging/metric-registry';
import type {
  RuntimeTool,
  ToolCallProvenanceResolver,
  ToolExecutionContext,
} from '../tools/index.js';
import type { TSchema } from '@sinclair/typebox';
import type { ContentReviewOutcome, ContentReviewTurnOptions } from './content-review.js';
import type { PiBeforeLlmCallAppendMessage, PiTurnHooks } from './hooks.js';
import type { LLMCallPreemption } from './llm-preemption.js';
import type { LLMRetryOptions } from './llm-retry.js';
import type { TurnToolCallContent } from '../event-bridge/tool-call-content.js';

export type RuntimeEvent = IRuntimeEvent;

/** Canonical in-memory history message exposed at the agent-core boundary. */
export type PiAgentMessage = AgentMessage;

export interface LLMModelConfig {
  model: Model<Api>;
  /**
   * The upstream route the host resolved for this model
   * (`resolveModelCallRoute` in @mavis/config): managed Token Plan, the
   * user's MiniMax API key, a custom provider or another configured provider.
   * Only a metric label, so dashboards can tell managed from BYOK calls; a
   * host that resolves none reports `unknown`.
   */
  route?: ModelCallRouteLabel;
  apiKey?: string;
  streamFn?: StreamFn;
  /** Host-owned binding/transport lifetime spanning all attempts of a logical call. */
  callLifecycle?: import('./llm-call-lifecycle.js').LLMCallLifecycle;
  thinkingLevel?: ThinkingLevel;
  cacheRetention?: CacheRetention;
  maxTokens?: number;
  /** Host-owned serialized request cap used by before-LLM context admission. */
  maxSerializedInputBytes?: number;
  /**
   * Ceiling the host owns for this turn's output, not a default.
   *
   * `maxTokens` above is the model's own configured cap and loses to any
   * explicit per-call option; this one wins by taking the minimum of itself,
   * whatever the request already asked for, and the model's own cap, so a
   * budget the host already clamped can never be widened downstream. Leave it
   * absent when the host has no such budget — every request then behaves
   * exactly as before. Present but not a positive integer is rejected when the
   * turn assembles its stream function, before any provider request.
   */
  hostMaxOutputTokens?: number;
  /**
   * Re-read host-owned remaining output allowance before each physical provider
   * request, including retries. Zero refuses the request; undefined retains
   * the static ceiling (if present). Input/reasoning usage is not bounded here.
   */
  resolveHostMaxOutputTokens?: () => number | undefined;
  headers?: Record<string, string>;
  /**
   * Request header that carries each request's turn phase (`initial`,
   * `iteration` or `compaction`, see `TurnRequestPhase`). Set by hosts whose
   * upstream reads it; absent sends no phase header.
   */
  turnPhaseHeader?: string;
  /**
   * Per-attempt wait (ms) for the first provider stream event before the
   * request is aborted and reported as a retryable timeout. Absent: the
   * `MCODE_LLM_FIRST_EVENT_TIMEOUT_MS` environment value, else
   * `LLM_FIRST_EVENT_TIMEOUT_MS`. `0` disables the bound.
   */
  firstEventTimeoutMs?: number;
  /**
   * Per-attempt maximum gap (ms) between provider stream events after the
   * first. Absent: `MCODE_LLM_STREAM_IDLE_TIMEOUT_MS`, else
   * `LLM_STREAM_IDLE_TIMEOUT_MS`. `0` disables the bound.
   */
  streamIdleTimeoutMs?: number;
  fetch?: SimpleStreamOptions['fetch'];
  /** Provider payload transform for the main assistant response. */
  payloadTransform?: SimpleStreamOptions['onPayload'];
  /**
   * Provider payload transform for auxiliary LLM calls made by hooks, such as
   * automatic context-compaction checkpoints. Falls back to payloadTransform
   * when omitted so existing hosts retain their request-shaping behavior.
   */
  auxiliaryPayloadTransform?: SimpleStreamOptions['onPayload'];
  responseObserver?: SimpleStreamOptions['onResponse'];
}

export interface ToolConfig<TCtx extends ToolExecutionContext = ToolExecutionContext> {
  tools?: readonly RuntimeTool<TSchema, TCtx>[];
  /** Final authorized PTC child catalog. It may be broader than model-visible tools. */
  ptcTools?: readonly RuntimeTool<TSchema, TCtx>[];
  /** Host-owned migration hint for a tool hidden by this turn's catalog. */
  missingToolMessage?: (toolName: string) => string | undefined;
  /**
   * Host lookup for a tool the model called directly although `tools` omits it, such as a
   * PTC child. A returned tool with the same name runs that call like a tool in `tools`:
   * same context, validation, hooks and events. The tools sent to the model are unchanged.
   * Called once per such call, with the arguments as the model sent them.
   */
  resolveMissingTool?: (toolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: unknown;
  }) => RuntimeTool<TSchema, TCtx> | undefined;
  /**
   * Tools `resolveMissingTool` may return outside PTC (Tool Search deferred tools called by
   * name). Only their `source` is registered so permission policy sees the real provenance;
   * unlike `ptcTools` they carry no PTC semantics.
   */
  deferredTools?: readonly RuntimeTool<TSchema, TCtx>[];
  disableBuiltinToolFallback?: boolean;
  context: TCtx;
}

export interface UserMessageInput {
  timestamp?: number;
  text: string;
  attachments?: readonly ImageContent[];
  canonicalTextRange?: {
    readonly startOffset: number;
    readonly endOffset: number;
  };
  genuineUserQueryText?: string;
  /** Opaque Host-owned metadata. Provider projection always removes it. */
  hostMetadata?: Readonly<Record<string, unknown>> & { readonly immediateSendBatchId?: string };
}

/**
 * Host clock marks of one turn before its first model request, Unix ms from
 * one clock. Each mark ends the preparation stage of `pi_turn_prepare_ms` it
 * names; the runner adds `persisting` (running status written) and
 * `dispatching` (first request).
 */
export interface PiTurnTiming {
  /** The runtime durably accepted the user message. */
  readonly acceptedAtMs: number;
  /** The host started the accepted turn; ends `accepted`. */
  readonly hostStartedAtMs?: number;
  /** Session, agent and history reads, model resolution and runtime assembly done; ends `assembling`. */
  readonly assembledAtMs?: number;
  /** Plugin hooks, tools, prompt and reminders prepared; ends `preparing`. */
  readonly preparedAtMs?: number;
}

/**
 * The first assistant text of a turn the user can see, for
 * `pi_turn_first_visible_text_ms`. Only the host knows it: the text has to
 * pass its output review and display projection first. The host creates one
 * per turn (`createTurnVisibleTextMark`) and hands the same mark to every
 * attempt of the turn; the metrics recorder of the attempt that carries
 * `turnTiming` binds to it.
 */
export interface TurnVisibleTextMark {
  /** Host side: the turn's first visible text reached the user now. Only the first call counts. */
  mark(): void;
  /** Runner side: what `mark()` reports. The first binding is kept. */
  bind(onMark: () => void): void;
}

/**
 * How a fresh per-Turn Pi Agent starts its agent loop. `resume-tool-calls`
 * runs the tool calls of the last assistant message that have no result yet,
 * keeping their ids, and then continues. `settle-interrupted-tool-calls`
 * gives each of those calls an error result saying it was interrupted with an
 * unknown outcome (the run executing it stopped), without running it again,
 * and then continues so the model decides what to do next.
 */
export type RunTurnStartMode =
  | 'prompt'
  | 'continue'
  | 'resume-tool-calls'
  | 'settle-interrupted-tool-calls';

/**
 * Who initiated the turn — becomes the low-cardinality `caller` metric label
 * on turn metrics (MR1+). Values:
 * - `'chat'`            direct user message over the local HTTP API
 * - `'cron'`            scheduled cron task drain
 * - `'channel_feishu'`  IM channel inbound (single bucket for all channels
 *                       today; split per platform when more channels ship)
 * - `'team'`            team/multi-agent orchestration
 * - `'compact'`         history compaction (not yet populated — compaction
 *                       drives the LLM directly and bypasses PiTurnRunner)
 * - `'permission_llm'`  LLM-based permission evaluation
 */
export type RunTurnCaller =
  | 'chat'
  | 'cron'
  | 'channel_feishu'
  | 'team'
  | 'compact'
  | 'permission_llm';

/**
 * Optional host-supplied `agentKind` metrics label of a Turn from the metric
 * registry. Every other Turn leaves it out, and so carries no `agentKind` key
 * on any metric.
 */
export type RunTurnAgentKind = AgentKindLabel;

/**
 * The `wake` metrics label of a Turn: `user` when a person started any
 * input of its starting batch in a client, `system` otherwise. Only the
 * turn-level first-output metrics carry it; a host that does not classify
 * its Turns gets `system`.
 */
export type RunTurnWake = TurnWakeLabel;

/** Spreads `agentKind` into a turn input only when the host classified it. */
export function agentKindField(agentKind: RunTurnAgentKind | undefined): {
  readonly agentKind?: RunTurnAgentKind;
} {
  return agentKind ? { agentKind } : {};
}

/** Spreads `wake` into a turn input only when the host classified it. */
export function wakeField(wake: RunTurnWake | undefined): { readonly wake?: RunTurnWake } {
  return wake ? { wake } : {};
}

/** Bounded origin of a cancelled Pi turn. Unknown values collapse to `unknown`. */
export type AbortSource =
  | 'user_stop'
  /**
   * Leaving a conversation (TUI `/clear`, switching Sessions). Keeps the Goal and
   * Queue pause effects of `user_stop`, but is NOT a stop: it must not cascade
   * into the Session's background work, which is expected to keep running.
   */
  | 'session_leave'
  /**
   * An Agent stopped another Session's current Turn through `session interrupt`.
   * Stops only that Turn: no background cascade, no Goal or Queue pause.
   */
  | 'agent_interrupt'
  | 'immediate_send'
  | 'input_safety'
  | 'output_safety'
  | 'lifecycle'
  /**
   * The Host asked the run to stop without naming a reason of its own (cloud:
   * `AbortRun` falling back to its default reason).
   */
  | 'abort_requested'
  /**
   * The run lost its lease: another instance owns the Session now (cloud: a
   * drain hand-off, or a stale lease reclaimed by the Host).
   */
  | 'lease_stale'
  | 'unknown';

export function normalizeAbortSource(value: unknown): AbortSource {
  switch (value) {
    case 'user_stop':
    case 'session_leave':
    case 'agent_interrupt':
    case 'immediate_send':
    case 'input_safety':
    case 'output_safety':
    case 'lifecycle':
    case 'abort_requested':
    case 'lease_stale':
      return value;
    default:
      return 'unknown';
  }
}

/**
 * Whether an abort stops a run to yield it: a later run of the same Turn
 * continues it, so it is no cancellation. The host aborts such a run with an
 * Error of this name (`TurnYieldStop` in harness turn-yield-control.ts).
 */
export function isRunYieldAbort(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TurnYieldStop';
}

/**
 * Boundary classification the runner reports on every steering poll.
 * `mid-turn`: further steps already follow (tool calls or queued follow-ups),
 * so returned messages ride along before the next LLM hop. `exit`: the last
 * step produced no further work and the runner attempts
 * {@link RunTurnInput.tryBeginClose} as soon as the poll returns nothing —
 * hosts may withhold messages here so the close hands them back to the
 * session instead of extending a finished answer.
 */
export interface SteeringPollContext {
  /** All messages from this poll will be sent together after interrupting a generation. */
  readonly resendBatch?: boolean;
  readonly boundary: 'mid-turn' | 'exit';
  /**
   * The host closed this Turn's ordinary work: the poll must not wait for
   * more work to arrive, and user steering stays for the session.
   */
  readonly workClosed?: boolean;
}

export interface RunTurnInput<TCtx extends ToolExecutionContext = ToolExecutionContext> {
  sessionId: string;
  turnId: string;
  workspaceDir: string;
  systemPrompt: string;
  userMessage: UserMessageInput;
  /**
   * Omitted callers append `userMessage`; `continue` and `resume-tool-calls`
   * re-enter from supplied history without it.
   */
  startMode?: RunTurnStartMode;
  llm: LLMModelConfig;
  eventWriter: PiEventWriter;
  history?: AgentMessage[];
  /** Hidden Host messages appended immediately before the current real user. */
  beforeUserMessages?: readonly (
    | PiBeforeLlmCallAppendMessage
    | import('@earendil-works/pi-ai').UserMessage
  )[];
  signal?: AbortSignal;
  toolConfig: ToolConfig<TCtx>;
  hooks?: PiTurnHooks;
  /** Host opt-in for framework transport retry. Omitted hosts keep legacy behavior. */
  llmRetry?: Omit<LLMRetryOptions, 'sessionId' | 'turnId' | 'scope'>;
  /**
   * 服务端内容审核（网关 content_error）的本轮处理：action=4 的单次重发、打回通知。
   * 缺省时不重发、不改请求；content_error 仍会被识别、换成中性文案，
   * 并以 {@link RunTurnResult.contentReview} 结束本轮。
   */
  contentReview?: ContentReviewTurnOptions;
  /** Host opt-in for cancelling the provider call in flight. Omitted hosts never preempt. */
  llmPreemption?: LLMCallPreemption;
  /** Attribution captured from the same immutable capability snapshot as this turn's tools. */
  toolCallProvenanceResolver?: ToolCallProvenanceResolver;
  /** Forwarded to {@link EventBridgeContext.captureToolTiming}; host sets it non-prod only. */
  captureToolTiming?: boolean;
  /** Forwarded to {@link EventBridgeContext.toolCallContent}; one registry spans the turn. */
  toolCallContent?: TurnToolCallContent;
  /** TUI-only wire detail used to render output throughput. */
  includeDetailedUsage?: boolean;
  /** Turn initiator classification; see {@link RunTurnCaller}. */
  caller?: RunTurnCaller;
  /**
   * Preparation marks for the first-output and preparation metrics. Pass it
   * on a turn's first attempt only, so a regenerated attempt is not measured
   * from the acceptance again.
   */
  turnTiming?: PiTurnTiming;
  /** Owning Agent classification for metrics; see {@link RunTurnAgentKind}. */
  agentKind?: RunTurnAgentKind;
  /** What woke the Turn, for the turn-level first-output metrics; see {@link RunTurnWake}. */
  wake?: RunTurnWake;
  /**
   * The host's mark of the Turn's first visible text. Pass the same mark to
   * every attempt of the Turn; it is read only with {@link turnTiming}.
   */
  turnVisibleText?: TurnVisibleTextMark;
  /** Optional logical-Turn event identity source shared by host-owned retry attempts. */
  eventIdGenerator?: (kind: string) => string;
  /** Optional logical-Turn runtime sequence source shared by host-owned retry attempts. */
  runtimeSeqGenerator?: () => number;
  /** Messages accepted while the current step was running and injected before its next LLM hop. */
  getSteeringMessages?: (
    context?: SteeringPollContext,
  ) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
  /** Gracefully ends the run when host-side steering admission rejects continuation. */
  shouldStopAfterSteering?: () => boolean | Promise<boolean>;
  /** Gracefully ends after the current assistant/tool step and before any follow-up poll. */
  shouldStopAfterTurn?: () => boolean | Promise<boolean>;
  /** Text returned when a provider emits a tool call the host intentionally did not expose. */
  unexpectedToolCallFallback?: string;
  /**
   * True once the host allows no further ordinary work request in this Turn
   * (its request budget is spent). From then on every steering poll is an
   * exit boundary, so user input goes back to the session instead of
   * extending a Turn that can only wrap up.
   */
  isWorkClosed?: () => boolean | Promise<boolean>;
  /**
   * Atomically seals external continuation acceptance once steering is empty.
   * `false` means work won the close race and the runner must poll once more.
   */
  tryBeginClose?: (context: {
    /** Text from the most recent assistant message at this close boundary. */
    readonly lastAssistantMessage?: string;
    /** The host closed the Turn's work: every pending user input goes back to the session. */
    readonly workClosed?: boolean;
    /**
     * The host refused to send a further request, so nothing more can run in
     * this Turn: the close must not wait for steering it can no longer
     * consume. The runner makes this close once and ignores its result.
     */
    readonly final?: boolean;
  }) => boolean | Promise<boolean>;
  /**
   * True once the host stopped this run to yield it and a later run of the
   * same Turn finishes its output under the same display ids. From then on the
   * runner writes no event and no terminal status: the yielded run must leave
   * nothing on the event stream that the resuming run would contradict.
   * History deltas still reach the history hooks; the host decides which of
   * them survive the yield. A stop the host settles as a cancelled run keeps
   * this false.
   */
  isYieldStopped?: () => boolean;
  /**
   * `resume-tool-calls` only: the display `msg_id` the stopped run streamed
   * for the assistant message whose tool calls are resumed. The resumed calls
   * attach to it and its completed message is emitted once, with this id,
   * after the last of them ends. Omitted, the resumed calls carry no message.
   */
  resumeAssistantMessageId?: string;
}

/** `PiTurnRunner.runTurn` 的返回值。 */
export interface RunTurnResult {
  /**
   * 本轮因网关 content_error 结束（撤回整轮、固答、审核不可用、重发次数用完）时的结构化结果；
   * 正常结束、重发后成功或因其他原因结束时缺省。
   */
  readonly contentReview?: ContentReviewOutcome;
}

/**
 * Per-turn event writer surface. PiTurnRunner batches multiple RuntimeEvents
 * per pi `AgentEvent` and delegates actual event persistence / fan-out to the caller.
 */
export interface PiEventWriter {
  /** Push a single canonical `RuntimeEvent`. */
  pushRuntime(event: RuntimeEvent): void | Promise<void>;
  /** Push a batch atomically when the caller supports it. */
  appendEvents(events: RuntimeEvent[]): void | Promise<void>;
}

/**
 * Turn-owned event identity and delivery surface shared by Pi and native tools.
 * Hosts inject the same reporter for the full logical turn, including retries.
 */
export interface TurnEventReporter {
  nextEventId(kind: string): string;
  nextRuntimeSeq(): number;
  appendEvents(events: RuntimeEvent[]): Promise<void>;
}

export interface PiTurnRunnerLogger {
  debug?(obj: unknown, msg?: string): void;
  info?(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}
