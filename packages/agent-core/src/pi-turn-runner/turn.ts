import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  StreamFn,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { EventBridge } from '../event-bridge/index.js';
import type { ToolExecutionContext } from '../tools/index.js';
import type {
  PiAfterLlmCallHook,
  PiAfterToolCallHook,
  PiBeforeLlmCallHook,
  PiBeforeToolCallHook,
  PiOnLlmCallPreparedHook,
  PiOnHistoryChangedHook,
  PiOnStepEndHook,
  PiStepEndHookInput,
  PiToolExecutionStartHook,
} from './hooks.js';
import { composeStreamFn } from './llm.js';
import { withLLMRetry, type LLMCallScope, type LLMCallSettledEvent } from './llm-retry.js';
import type { TurnMetricsRecorder } from './metrics.js';
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

export interface turnHooks {
  beforeLLM: readonly PiBeforeLlmCallHook[];
  onLLMPrepared: readonly PiOnLlmCallPreparedHook[];
  afterLLM: readonly PiAfterLlmCallHook[];
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
  /** Step-local admission facts, handed off before step hooks run. Never persisted. */
  blockedToolCalls: NonNullable<PiStepEndHookInput['blockedToolCalls']>[number][];
  /** One trusted host response consumed by the next provider boundary. */
  syntheticResponse: { pending?: { readonly text: string; readonly reason: string } };
  /** Assistant responses rejected after message_end but still referenced by Pi's loop context. */
  rejectedAssistantMessages: Set<AgentMessage>;
  nextEventId(kind: string): string;
  nextRuntimeSeq(): number;
}

export function newTurn<TCtx extends ToolExecutionContext>(
  input: PiRunTurnInput<TCtx>,
  deps: turnDeps,
): turnState<TCtx> {
  const resolved = input.llm;
  const composedStreamFn = composeStreamFn(resolved);
  const retryStream = (scope: LLMCallScope): StreamFn => {
    const metricsStreamFn = deps.metrics
      ? deps.metrics.wrapStreamFn(composedStreamFn, { recordTerminalFailure: false })
      : composedStreamFn;
    const callerObserver = input.llmRetry?.observer;
    const callerOnCallSettled = input.llmRetry?.onCallSettled;
    const retryingStreamFn = withLLMRetry(metricsStreamFn, {
      ...input.llmRetry,
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
    input.llmRetry || deps.llmCapture
      ? retryStream('agent')
      : deps.metrics
        ? deps.metrics.wrapStreamFn(composedStreamFn)
        : composedStreamFn;
  const auxiliaryStreamFn = input.llmRetry ? retryStream('compaction') : undefined;
  const syntheticResponse: turnState['syntheticResponse'] = {};
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
      withLlmCallPreparedObservers(mainStreamFn, {
        input,
        llm: resolved,
        tools,
        thinkingLevel: resolved.thinkingLevel ?? 'off',
        hooks: hooks.onLLMPrepared,
        logger: deps.logger,
      }),
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
    blockedToolCalls: [],
    syntheticResponse,
    rejectedAssistantMessages: new Set(),
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
    for (const hook of options.hooks) {
      try {
        await hook({
          sessionId: options.input.sessionId,
          turnId: options.input.turnId,
          phase,
          scope: 'agent',
          messages: [...context.messages],
          model,
          ...(options.llm.maxTokens === undefined ? {} : { maxTokens: options.llm.maxTokens }),
          ...(options.llm.hostMaxOutputTokens === undefined
            ? {}
            : { hostMaxOutputTokens: options.llm.hostMaxOutputTokens }),
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
    return inner(model, context, streamOptions);
  }) as StreamFn;
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
