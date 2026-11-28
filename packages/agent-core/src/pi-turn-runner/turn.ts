import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  StreamFn,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { EventBridge } from '../event-bridge/index.js';
import type { TurnTerminationReason } from '../event-bridge/types.js';
import type { ToolExecutionContext } from '../tools/index.js';
import {
  newContentReviewTurnState,
  withContentReviewRequests,
  type ContentReviewTurnState,
} from './content-review.js';
import type {
  PiAfterLlmCallHook,
  PiAfterToolCallHook,
  PiBeforeLlmCallHook,
  PiBeforeToolCallHook,
  PiLlmCallRecovery,
  PiOnLlmCallPreparedHook,
  PiOnHistoryChangedHook,
  PiOnStepEndHook,
  PiStepEndHookInput,
  PiToolExecutionStartHook,
  PiTurnFailureHook,
} from './hooks.js';
import { composeStreamFn, resolveHostOutputTokenCap } from './llm.js';
import { withLLMCallPreemption, type LLMCallPreemptionState } from './llm-preemption.js';
import { withLLMRetry, type LLMCallScope, type LLMCallSettledEvent } from './llm-retry.js';
import { LLM_RESUME_STALL_MS } from './llm-stream-timeout.js';
import type { TurnMetricsRecorder } from './metrics.js';
import { withRejectedMediaRetry } from './rejected-media-retry.js';
import { withTurnRequestPhase, type TurnRequestPhase } from './turn-timing.js';
import { newTools } from './tools.js';
import type {
  LLMModelConfig,
  PiEventWriter,
  PiTurnRunnerLogger,
  RunTurnInput as PiRunTurnInput,
} from './types.js';

export interface messageIDAllocator {
  allocateAssistantMessageId(sessionId: string, turnId: string): Promise<string>;
}

export interface turnDeps {
  allocator: messageIDAllocator;
  nowMs: () => number;
  logger: Required<PiTurnRunnerLogger>;
  /** Per-turn metrics/provenance/degradation recorder; absent only disables emission. */
  metrics?: TurnMetricsRecorder;
  /**
   * Per-turn LLM context capture recorder; absent disables capture entirely.
   *
   * Hosts that do not observe provider context — including cloud-runtime — never
   * construct one, so the composed stream stays identical to the pre-capture
   * composition and no capture code sits on the request path.
   */
  llmCapture?: LlmCaptureRecorder;
}

/**
 * Observer that records the provider-bound context of main-agent LLM calls.
 *
 * The recorder owns every capture concern behind two methods: which scopes are
 * captured, how the effective fetch is substituted, how physical attempts are
 * reconciled into one logical call, and where the result is stored. None of
 * that vocabulary belongs to the turn runner.
 *
 * Every method is best effort. An implementation must never change provider
 * behaviour, retry semantics, or the outcome of the owning Turn.
 */
export interface LlmCaptureRecorder {
  /**
   * Wrap the composed stream function for one logical call scope.
   *
   * Implementations return `inner` unchanged when the scope is not captured or
   * capture is disabled, so an inactive recorder costs nothing per request.
   */
  wrapLogicalStreamFn(inner: StreamFn, settings: { scope: LLMCallScope }): StreamFn;

  /** Terminal observation for one logical call; idempotent per `callId`. */
  observeCallSettled(event: LLMCallSettledEvent): void;

  /** Receive only the raw event subscription capability owned by PiTurnRunner. */
  observeAgentEvents(source: LlmCaptureAgentEventSource): void;

  /** Wait for best-effort persistence before the owning Turn releases its lifecycle gate. */
  drain?(): Promise<void>;
}

export interface LlmCaptureAgentEventSource {
  subscribe(listener: (event: AgentEvent) => void): () => void;
}

/** A failure a turn-failure recovery replaced: its termination and the error text it carried. */
export interface ReplacedTurnFailure {
  readonly termination: TurnTerminationReason;
  readonly errorMessage: string;
}

export interface turnHooks {
  beforeLLM: readonly PiBeforeLlmCallHook[];
  onLLMPrepared: readonly PiOnLlmCallPreparedHook[];
  afterLLM: readonly PiAfterLlmCallHook[];
  turnFailure: readonly PiTurnFailureHook[];
  beforeTool: readonly PiBeforeToolCallHook[];
  onToolExecutionStart: readonly PiToolExecutionStartHook[];
  afterTool: readonly PiAfterToolCallHook[];
  onHistory: readonly PiOnHistoryChangedHook[];
  /**
   * Consolidated step-end handlers. Populated by `newTurn` from both
   * `input.hooks.onStepEndHook` (preferred) and the deprecated per-step
   * `input.hooks.onTurnEndHook` compatibility slot.
   */
  onStepEnd: readonly PiOnStepEndHook[];
}

export interface turnState<TCtx extends ToolExecutionContext = ToolExecutionContext> {
  input: PiRunTurnInput<TCtx>;
  llm: LLMModelConfig;
  writer: PiEventWriter;
  allocator: messageIDAllocator;
  logger: Required<PiTurnRunnerLogger>;
  metrics: TurnMetricsRecorder;
  bridge: EventBridge;
  hooks: turnHooks;
  tools: AgentTool[];
  streamFn: StreamFn;
  auxiliaryStreamFn?: StreamFn;
  thinkingLevel: ThinkingLevel;
  initialMessages: AgentMessage[];
  /** The display msg_id each assistant message ended with, for history deltas. */
  assistantMessageIds: WeakMap<AgentMessage, string>;
  /** Step-local admission facts, handed off before step hooks run. Never persisted. */
  blockedToolCalls: NonNullable<PiStepEndHookInput['blockedToolCalls']>[number][];
  /** One trusted host response consumed by the next provider boundary. */
  syntheticResponse: { pending?: { readonly text: string; readonly reason: string } };
  /** Assistant responses rejected after message_end but still referenced by Pi's loop context. */
  rejectedAssistantMessages: Set<AgentMessage>;
  /** The provider call the host may preempt, and the resend it owes after doing so. */
  preemption: LLMCallPreemptionState;
  /** A request was refused before sending because the host closed the Turn's requests. */
  requestStoppedBeforeSend: boolean;
  /**
   * At most one recovered provider error per LLM call: `used` clears on the
   * next response that is not an error. `pending` waits for the runner to
   * repeat the request; `active` is handed to the next beforeLlmCall.
   * `lastRequest` is the request view of the latest provider call;
   * `lastRequestPrepared` is false while a call fails before its request is
   * prepared. A turn-failure hook's recoveries are counted in
   * `turnFailureRecoveries`; `replacedFailure` is the failure the latest of
   * them replaced, and `restoredFailure` the one a hook restored.
   */
  recovery: {
    used: boolean;
    pending?: PiLlmCallRecovery;
    active?: PiLlmCallRecovery;
    lastRequest?: readonly AgentMessage[];
    lastRequestPrepared?: boolean;
    turnFailureRecoveries: number;
    replacedFailure?: ReplacedTurnFailure;
    restoredFailure?: ReplacedTurnFailure;
  };
  /**
   * 网关 content_error 的单轮状态：本次调用已重发次数、等待重发 / 交给下一次请求的重发参数、
   * 以及本轮的结束结果。
   */
  contentReview: ContentReviewTurnState;
  nextEventId(kind: string): string;
  nextRuntimeSeq(): number;
}

export function newTurn<TCtx extends ToolExecutionContext>(
  input: PiRunTurnInput<TCtx>,
  deps: turnDeps,
): turnState<TCtx> {
  const resolved = input.llm;
  // 先校验审核配置：给错直接让本轮在发出任何请求之前失败。
  const contentReview = newContentReviewTurnState(input.contentReview);
  const networkRecovery = input.llmRetry?.networkRecovery;
  const composedStreamFn = composeStreamFn(
    resolved,
    networkRecovery
      ? { onResume: (listener) => networkRecovery.onResume(listener), stallMs: LLM_RESUME_STALL_MS }
      : undefined,
  );
  const retryStream = (scope: LLMCallScope): StreamFn => {
    const metricsStreamFn = deps.metrics
      ? deps.metrics.wrapStreamFn(composedStreamFn, { recordTerminalFailure: false })
      : composedStreamFn;
    const callerObserver = input.llmRetry?.observer;
    const callerOnCallSettled = input.llmRetry?.onCallSettled;
    const retryingStreamFn = withLLMRetry(metricsStreamFn, {
      ...input.llmRetry,
      // A required lifecycle must also run when retries are disabled by the host.
      ...(!input.llmRetry && resolved.callLifecycle ? { policy: { maxRetries: 0 } } : {}),
      lifecycle: resolved.callLifecycle ?? input.llmRetry?.lifecycle,
      sessionId: input.sessionId,
      turnId: input.turnId,
      scope,
      observer: async (event) => {
        deps.metrics?.observeRetry(event);
        await callerObserver?.(event);
      },
      onCallSettled: (event) => {
        deps.metrics?.observeLLMCall(event);
        deps.llmCapture?.observeCallSettled(event);
        return callerOnCallSettled?.(event);
      },
    });
    // One recorder spans the whole logical call. Physical retries overwrite its
    // in-memory candidate; only the final successful settlement can persist.
    const capturedStreamFn = deps.llmCapture
      ? deps.llmCapture.wrapLogicalStreamFn(retryingStreamFn, { scope })
      : retryingStreamFn;
    return deps.metrics
      ? deps.metrics.wrapLogicalStreamFn(capturedStreamFn, {
          // Auto-compaction is an auxiliary degradation: local context lifecycle
          // catches its failure and may continue with the main request. Keep its
          // physical request/retry metrics, but never let it claim the turn's
          // terminal LLM attribution or overwrite the main failure classification.
          recordTerminalFailure: scope === 'agent',
        })
      : capturedStreamFn;
  };
  const mainStreamFn =
    input.llmRetry || deps.llmCapture || resolved.callLifecycle
      ? retryStream('agent')
      : deps.metrics
        ? deps.metrics.wrapStreamFn(composedStreamFn)
        : composedStreamFn;
  const auxiliaryStreamFn =
    input.llmRetry || resolved.callLifecycle
      ? withTurnRequestPhase(
          retryStream('compaction'),
          () => 'compaction',
          resolved.turnPhaseHeader,
        )
      : undefined;
  const syntheticResponse: turnState['syntheticResponse'] = {};
  const preemption: LLMCallPreemptionState = {};
  let logicalCalls = 0;
  // A call resent because the host preempted the one in flight replaces it and
  // keeps its phase: a preempted first request is resent as initial.
  const mainPhase = (): TurnRequestPhase => {
    const resent = preemption.resendPhase;
    delete preemption.resendPhase;
    return resent ?? (logicalCalls++ === 0 ? 'initial' : 'iteration');
  };
  // Each resend without rejected media is a logical call of its own. The metrics
  // have recorded the rejected attempt by the time it is resent, so it comes off
  // the turn's failure provenance first: an accepted resend leaves no failure
  // behind, and one that fails is attributed to its own cause. Auxiliary calls
  // stay unwrapped.
  const mediaCheckedStreamFn = withRejectedMediaRetry(mainStreamFn, {
    logger: deps.logger,
    sessionId: input.sessionId,
    turnId: input.turnId,
    beforeResend: () => deps.metrics?.forgetLLMFailureObservation(),
  });
  // Outside retry, so a preempted call is never retried. Outside the media
  // check too: a preempted call ends in an abort the check passes through, and
  // the response that stands in for it never reaches the check, so the media it
  // carried is not taken as accepted. Auxiliary calls stay unwrapped.
  const preemptibleStreamFn = input.llmPreemption
    ? withLLMCallPreemption(
        mediaCheckedStreamFn,
        preemption,
        deps.nowMs,
        input.llmPreemption.wakeReasons,
      )
    : mediaCheckedStreamFn;
  let eventSeq = 0;
  let runtimeSeq = 0;
  const nextEventId =
    input.eventIdGenerator ?? ((kind: string) => `evt_${input.turnId}_${kind}_${++eventSeq}`);
  const nextRuntimeSeq = input.runtimeSeqGenerator ?? (() => ++runtimeSeq);
  const modelContextWindow = resolved.model.contextWindow;
  const provenanceResolvers = new Map(
    (input.toolConfig.tools ?? []).flatMap((tool) =>
      tool.toolCallProvenanceResolver
        ? ([[tool.def.name, tool.toolCallProvenanceResolver]] as const)
        : [],
    ),
  );
  const toolCallProvenanceResolver =
    input.toolCallProvenanceResolver ??
    (provenanceResolvers.size > 0
      ? (resolution) => provenanceResolvers.get(resolution.toolName)?.(resolution)
      : undefined);

  const bridge = new EventBridge({
    sessionId: input.sessionId,
    turnId: input.turnId,
    eventIdGenerator: nextEventId,
    runtimeSeqGenerator: nextRuntimeSeq,
    nowMs: deps.nowMs,
    ...(deps.metrics && input.includeDetailedUsage === true
      ? { requestDurationMs: deps.metrics.requestDurationMsFor.bind(deps.metrics) }
      : {}),
    ...(input.includeDetailedUsage === true ? { includeDetailedUsage: true } : {}),
    logger: deps.logger,
    ...(input.captureToolTiming ? { captureToolTiming: true } : {}),
    ...(toolCallProvenanceResolver ? { toolCallProvenanceResolver } : {}),
    ...(input.toolCallContent ? { toolCallContent: input.toolCallContent } : {}),
    ...(typeof modelContextWindow === 'number' &&
    Number.isFinite(modelContextWindow) &&
    modelContextWindow > 0
      ? { contextWindow: modelContextWindow }
      : {}),
  });
  const tools = newTools(
    input.workspaceDir,
    input.toolConfig.tools ?? [],
    input.toolConfig.context,
    {
      disableBuiltinFallback: input.toolConfig.disableBuiltinToolFallback === true,
      readAssistantMessageId: () => bridge.getActiveAssistantMessageId(),
    },
  );
  const hooks: turnHooks = {
    beforeLLM: input.hooks?.beforeLlmCallHook ?? [],
    onLLMPrepared: input.hooks?.onLlmCallPreparedHook ?? [],
    afterLLM: input.hooks?.afterLlmCallHook ?? [],
    turnFailure: input.hooks?.turnFailureHook ?? [],
    beforeTool: input.hooks?.beforeToolCallHook ?? [],
    onToolExecutionStart: input.hooks?.onToolExecutionStartHook ?? [],
    afterTool: input.hooks?.afterToolCallHook ?? [],
    onHistory: input.hooks?.onHistoryChangedHook ?? [],
    // Preserve legacy per-step handlers after preferred-name handlers.
    onStepEnd: [...(input.hooks?.onStepEndHook ?? []), ...(input.hooks?.onTurnEndHook ?? [])],
  };

  return {
    input,
    llm: resolved,
    writer: input.eventWriter,
    allocator: deps.allocator,
    logger: deps.logger,
    metrics: deps.metrics!,
    bridge,
    hooks,
    tools,
    streamFn: withSyntheticResponse(
      // 请求改写在 llm-retry 外层：同一次调用的物理重试复用同一份改写。
      withLlmCallPreparedObservers(
        withContentReviewRequests(
          withTurnRequestPhase(preemptibleStreamFn, mainPhase, resolved.turnPhaseHeader),
          contentReview,
        ),
        {
          input,
          llm: resolved,
          tools,
          thinkingLevel: resolved.thinkingLevel ?? 'off',
          hooks: hooks.onLLMPrepared,
          logger: deps.logger,
        },
      ),
      syntheticResponse,
      deps.nowMs,
    ),
    ...(auxiliaryStreamFn
      ? {
          auxiliaryStreamFn,
        }
      : {}),
    thinkingLevel: resolved.thinkingLevel ?? 'off',
    initialMessages: [...(input.history ?? [])],
    assistantMessageIds: new WeakMap(),
    blockedToolCalls: [],
    syntheticResponse,
    rejectedAssistantMessages: new Set(),
    preemption,
    requestStoppedBeforeSend: false,
    recovery: { used: false, turnFailureRecoveries: 0 },
    contentReview,
    nextEventId,
    nextRuntimeSeq,
  };
}

function withLlmCallPreparedObservers(
  inner: StreamFn,
  options: {
    readonly input: PiRunTurnInput;
    readonly llm: LLMModelConfig;
    readonly tools: readonly AgentTool[];
    readonly thinkingLevel: ThinkingLevel;
    readonly hooks: readonly PiOnLlmCallPreparedHook[];
    readonly logger: Required<PiTurnRunnerLogger>;
  },
): StreamFn {
  if (options.hooks.length === 0) return inner;
  let logicalCallCount = 0;
  return (async (model, context, streamOptions) => {
    const phase = logicalCallCount === 0 ? 'initial' : 'iteration';
    logicalCallCount += 1;
    const payloadObservers: ((payload: unknown) => void)[] = [];
    for (const hook of options.hooks) {
      try {
        const hostMaxOutputTokens = resolveHostOutputTokenCap(options.llm);
        const observation = await hook({
          sessionId: options.input.sessionId,
          turnId: options.input.turnId,
          phase,
          scope: 'agent',
          messages: [...context.messages],
          model,
          ...(options.llm.maxTokens === undefined ? {} : { maxTokens: options.llm.maxTokens }),
          ...(hostMaxOutputTokens === undefined ? {} : { hostMaxOutputTokens }),
          ...(options.llm.maxSerializedInputBytes === undefined
            ? {}
            : { maxSerializedInputBytes: options.llm.maxSerializedInputBytes }),
          ...(options.llm.cacheRetention === undefined
            ? {}
            : { cacheRetention: options.llm.cacheRetention }),
          systemPrompt: options.input.systemPrompt,
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
          thinkingLevel: options.thinkingLevel,
          ...(streamOptions?.signal ? { signal: streamOptions.signal } : {}),
        });
        if (observation?.onPayload) payloadObservers.push(observation.onPayload);
      } catch (error) {
        try {
          options.logger.warn(
            {
              session_id: options.input.sessionId,
              turn_id: options.input.turnId,
              phase,
              error: error instanceof Error ? error.message : String(error),
            },
            '[pi-turn-runner] onLlmCallPrepared hook failed; continuing provider call',
          );
        } catch {
          // Observers and their diagnostics must never replace the provider call.
        }
      }
    }
    return inner(model, context, withPayloadObservers(streamOptions, payloadObservers));
  }) as StreamFn;
}

/** The request's own payload transform runs first; the observers see what it returned. */
function withPayloadObservers(
  streamOptions: Parameters<StreamFn>[2],
  observers: readonly ((payload: unknown) => void)[],
): Parameters<StreamFn>[2] {
  if (observers.length === 0) return streamOptions;
  const transform = streamOptions?.onPayload;
  return {
    ...streamOptions,
    onPayload: async (payload, model) => {
      const transformed = await transform?.(payload, model);
      for (const observe of observers) {
        try {
          observe(transformed ?? payload);
        } catch {
          // Observers never change the request.
        }
      }
      return transformed;
    },
  };
}

function withSyntheticResponse(
  inner: StreamFn,
  state: turnState['syntheticResponse'],
  nowMs: () => number,
): StreamFn {
  return ((model, context, options) => {
    const pending = state.pending;
    if (!pending) return inner(model, context, options);
    delete state.pending;
    const empty = trustedAssistantMessage(model, '', nowMs());
    const final = trustedAssistantMessage(model, pending.text, nowMs());
    const events = [
      { type: 'start', partial: empty },
      { type: 'text_start', contentIndex: 0, partial: empty },
      { type: 'text_delta', contentIndex: 0, delta: pending.text, partial: final },
      { type: 'text_end', contentIndex: 0, content: pending.text, partial: final },
      { type: 'done', reason: 'stop', message: final },
    ] as const;
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            const value = events[index];
            index += 1;
            return value ? { value, done: false } : { value: undefined, done: true };
          },
        };
      },
      result: async () => final,
    } as AssistantMessageEventStream;
  }) as StreamFn;
}

function trustedAssistantMessage(
  model: Parameters<StreamFn>[0],
  text: string,
  timestamp: number,
): AssistantMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  };
}
