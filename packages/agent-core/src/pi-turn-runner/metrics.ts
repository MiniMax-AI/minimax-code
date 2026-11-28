/**
 * pi-turn-runner metrics (MR1) — emit the `pi_*` metric family for the
 * agent-core inner loop through the optionally injected `MetricsClient`.
 *
 * Design constraints:
 * - Noop-safe: no client → the internal client is a noop and assembly
 *   fingerprinting stays disabled.
 * - Zero behavior change: every observation point is wrapped so that a
 *   throwing client or a bug in the recorder can never break the turn.
 * - Bare metric names (no `local_runtime_` prefix — the reporting layer
 *   rejects prefixed names since MR0); labels are low-cardinality only.
 */

import type { Agent, AgentEvent, AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ProviderResponse,
} from '@earendil-works/pi-ai';
import type { MetricLabels, MetricsClient } from '@mavis/shared/metrics-proxy';
import {
  createBusyTimeAccumulator,
  incrementMetric,
  observeMetric,
  type BusyTimeAccumulator,
  type ModelCallRouteLabel,
  type RegisteredCounterName,
  type RegisteredHistogramName,
  type RegisteredMetricLabels,
  type TurnConversationLabel,
} from '@mavis/shared/local-runtime-logging/metric-registry';
import {
  normalizeLLMError,
  toLLMFailureErrorKind,
  toLLMMetricErrorKind,
  type LLMFailureErrorKind,
  type LLMMetricErrorKind,
  type NormalizedLLMError,
} from '@mavis/shared/llm-error-classifier';
import { classifyLocalResourceError } from '@mavis/shared/local-resource-errors';
import type { TurnTerminationReason } from '../event-bridge/types.js';
import type { RuntimeTool, ToolOperationClassifier } from '../tools/index.js';
import { parseContentReviewError } from './content-review.js';
import { isLLMCallPreempted } from './llm-preemption.js';
import { readLLMStreamFailureKind } from './llm-stream-failure.js';
import {
  LLMRequestStoppedError,
  type LLMCallSettledEvent,
  type LLMRetryEvent,
} from './llm-retry.js';
import {
  normalizeAbortSource,
  type LLMModelConfig,
  type PiTurnTiming,
  type RunTurnAgentKind,
  type RunTurnCaller,
  type RunTurnWake,
  type PiTurnRunnerLogger,
  type TurnVisibleTextMark,
} from './types.js';
import {
  isEffectiveOutputEvent,
  managedTransportMs,
  parseGatewayServerTiming,
  readTurnRequestPhase,
  responseHeader,
  turnPrepareStages,
  type TurnRequestPhase,
} from './turn-timing.js';
import {
  createToolContextHistogramBucketsByName,
  measureToolArguments,
  measureToolContext,
  measureToolResult,
  type MeasuredToolValue,
  type ToolContextSizeEstimator,
} from './tool-context-size.js';
import { fingerprintAssembly, type AssemblyFingerprint } from './assembly-fingerprint.js';

const LARGE_TOOL_IO_TOKEN_THRESHOLD = 8_000;
const MAX_ASSEMBLY_FINGERPRINT_BASELINES = 2_048;
const MAX_LLM_REQUEST_GAP_BASELINES = 2_048;
const MAX_TOOL_OPERATION_VALUES = 128;
const MAX_TOOL_OPERATION_VALUE_LENGTH = 64;

export type PiLLMCacheOutcome = 'read' | 'no_read' | 'telemetry_unknown';

export interface PiLLMRequestStartedInfo {
  readonly sessionId: string;
  readonly turnId: string;
  readonly startedAtMs: number;
  readonly provider: string;
  readonly model: string;
  readonly caller: string;
}

export interface PiLLMRequestSettledInfo {
  readonly endedAtMs: number;
  readonly cacheOutcome: PiLLMCacheOutcome;
}

/** Fail-open host observer for one physical provider request lifecycle. */
export type PiLLMRequestSettlementObserver = (info: PiLLMRequestSettledInfo) => void;
/**
 * Called when a physical provider request starts. The optional returned closure
 * is called exactly once when that request settles and may capture host state
 * without asking agent-core to own product-specific correlation.
 */
export type PiLLMRequestObserver = (
  info: PiLLMRequestStartedInfo,
) => PiLLMRequestSettlementObserver | undefined | void;

interface TurnMetricsDiagnostics {
  sessionId: string;
  turnId: string;
  estimator?: ToolContextSizeEstimator;
  logger: PiTurnRunnerLogger;
}

interface RegisteredToolOperationClassifier {
  readonly allowedValues: ReadonlySet<string>;
  /**
   * How many declared values were dropped by the cardinality/length caps.
   * Non-zero means some real operations will report as `unknown`.
   */
  readonly rejectedValueCount: number;
  classify(args: unknown): string | undefined;
}

export type TurnErrorSource =
  | 'llm'
  | 'before_llm_hook'
  | 'tool'
  | 'history'
  | 'event_bridge'
  | 'message_identity'
  | 'event_writer'
  | 'turn_end_hook'
  | 'runner'
  | 'unknown';
export type NonLLMTurnErrorKind =
  | 'hook_error'
  | 'persistence'
  /** History write refused: another writer moved the object past the expected revision. */
  | 'revision_conflict'
  /** History append reused an identity the history holds with different content. */
  | 'duplicate_append'
  /** History write of a Turn whose ownership was taken away by force. */
  | 'late_write'
  | 'translation'
  | 'identity'
  | 'delivery'
  | 'runtime_error'
  | 'unknown';
export interface LLMFailureObservation {
  normalized: NormalizedLLMError;
  metricKind: LLMMetricErrorKind;
  /** `errorKind` of the turn failure: `metricKind`, or the local resource it ran out of. */
  failureKind: LLMFailureErrorKind;
}

/**
 * 一次 provider 物理请求失败后，传给宿主注入的
 * {@link PiLLMRequestFailureHook} 的数据。
 *
 * agent-core 不依赖具体宿主，只负责分类失败并转交原始错误材料。宿主
 *（local-runtime）负责生成可上报的错误日志，格式化、加密和传输均在那里完成，
 * 因此 agent-core 不会引入上报链路。
 */
export interface PiLLMRequestFailureInfo {
  /** 发起该物理请求的 Session,供宿主把失败关联回自己的业务状态。 */
  sessionId: string;
  /** 发起该物理请求的 Turn,同上。 */
  turnId: string;
  /**
   * 物理请求直接抛出的值，例如自定义 streamFn、传输错误或超时。若失败由已结束的
   * assistant message 携带，则为 `undefined`。
   */
  error?: unknown;
  /** Provider 在格式化最终错误文本之前捕获到的原始异常对象。 */
  providerError?: unknown;
  /**
   * 已结束 assistant message（`stopReason === 'error'`）携带的最终错误文本；
   * 当 {@link error} 为 `undefined` 时存在。
   */
  errorMessage?: string;
  /**
   * 框架对失败给出的固定基数分类。用户取消（`'abort'`）会在调用 hook 前过滤，
   * 因此 hook 实现不会收到 abort。
   */
  metricKind: LLMMetricErrorKind;
  /** 本次物理请求实际使用的模型和调用来源。 */
  request: {
    api: string;
    baseUrl: string;
    caller: string;
    model: string;
    provider: string;
  };
  /** 观测到失败时的 Unix 毫秒时间戳。 */
  occurredAtMs: number;
}

/**
 * 可选的宿主回调，每次确认 provider 物理请求失败时调用一次，也就是由
 * {@link TurnMetricsRecorder.wrapStreamFn} 调用，而不是逻辑请求包装层。每个重试 attempt
 * 的物理失败都会触发，但用户取消不会触发。
 *
 * 该 hook 只能产生旁路副作用，从调用方视角不得抛错。agent-core 始终通过 `swallow`
 * 保护调用，保证 hook 抛错也不会改变 LLM 请求、重试或 turn 结果。
 */
export type PiLLMRequestFailureHook = (info: PiLLMRequestFailureInfo) => void;
export interface TurnFailureProvenance {
  errorSource: TurnErrorSource;
  errorKind: LLMFailureErrorKind | NonLLMTurnErrorKind;
}

/** `caller` label of turn metrics: the turn's caller, or `unknown` when none was given. */
export type TurnMetricCaller = RunTurnCaller | 'unknown';

/** Labels of the physical request metrics; the shipped metrics next to them omit `route`. */
type LLMRequestMetricLabels = RegisteredMetricLabels<'pi_llm_request_total'>;

function shippedRequestLabels(labels: LLMRequestMetricLabels): MetricLabels {
  return { provider: labels.provider, model: labels.model, caller: labels.caller };
}

/** Registered metrics a host without registry metrics reports without `route`. */
type ShippedShapeCounter = Extract<
  RegisteredCounterName,
  'pi_llm_request_total' | 'pi_llm_logical_call_total'
>;
type ShippedShapeHistogram = Extract<RegisteredHistogramName, 'pi_llm_response_ms'>;

/**
 * A host without registry metrics (the cloud runtime) reports these metrics
 * with the label set they shipped with before the registry, which has no
 * `route`; the registry's typed labels would add it.
 */
function countShippedShape(
  client: Pick<MetricsClient, 'counter'>,
  name: ShippedShapeCounter,
  labels: MetricLabels,
): void {
  swallow(() => client.counter(name, 1, labels));
}

function observeShippedShape(
  client: Pick<MetricsClient, 'histogram'>,
  name: ShippedShapeHistogram,
  value: number,
  labels: MetricLabels,
): void {
  swallow(() => client.histogram(name, value, labels));
}

/** The phases whose requests the first-output metrics measure; compaction is not one. */
function measuredPhase(phase: TurnRequestPhase | undefined): phase is 'initial' | 'iteration' {
  return phase === 'initial' || phase === 'iteration';
}

/** What a turn's host knows about it besides caller and model. */
export interface TurnMetricsContext {
  readonly route?: ModelCallRouteLabel;
  readonly timing?: PiTurnTiming;
  readonly agentKind?: RunTurnAgentKind;
  /** `system` when the host does not say. */
  readonly wake?: RunTurnWake;
  /** Whether the turn continues a conversation (see turn-conversation.ts); `existing` when unsaid. */
  readonly conversation?: TurnConversationLabel;
  /** Bound when the turn is timed from its acceptance (`timing`) on a registry host. */
  readonly visibleText?: TurnVisibleTextMark;
  /** Whether the host stopped the run to yield it, at any boundary; a later run continues the turn. */
  readonly isYielded?: () => boolean;
}

const FIRST_TOKEN_EVENT_TYPES: ReadonlySet<AssistantMessageEvent['type']> = new Set([
  'text_start',
  'text_delta',
  'thinking_start',
  'thinking_delta',
  'toolcall_start',
  'toolcall_delta',
]);

const noopMetricsClient = {
  counter() {},
  gauge() {},
  histogram() {},
} as unknown as MetricsClient;

export function newPiTurnMetrics(
  client: MetricsClient | undefined,
  nowMs: () => number,
  onLLMRequestFailure?: PiLLMRequestFailureHook,
  observeLLMRequest?: PiLLMRequestObserver,
  registryMetrics = false,
): PiTurnMetrics {
  return new PiTurnMetrics(
    client ?? noopMetricsClient,
    nowMs,
    client !== undefined,
    onLLMRequestFailure,
    observeLLMRequest,
    registryMetrics,
  );
}

export function createPiTurnHistogramBucketsByName(): Record<string, number[]> {
  return createToolContextHistogramBucketsByName();
}

/**
 * Record the final outcome of one logical LLM call without conflating it with
 * its physical retry attempts. All labels are fixed-cardinality framework
 * classifications.
 */
export function recordPiLLMCallMetrics(
  client: Pick<MetricsClient, 'counter'> | undefined,
  caller: TurnMetricCaller,
  event: LLMCallSettledEvent,
  route: ModelCallRouteLabel = 'unknown',
  agentKind?: RunTurnAgentKind,
): void {
  if (!client) return;
  const baseLabels = {
    provider: event.provider,
    model: event.model,
    caller,
    ...agentKindLabels(agentKind),
    scope: event.scope,
  };
  incrementMetric(client, 'pi_llm_logical_call_total', 1, {
    ...baseLabels,
    route,
    outcome: event.final.outcome,
    errorKind: event.final.errorKind,
    retryTriggered: event.retryTriggered ? 'true' : 'false',
  });
  recordRetryEpisode(client, baseLabels, event, event.final.outcome);
}

/**
 * {@link recordPiLLMCallMetrics} for a host without registry metrics: the
 * label set and error kinds the call metrics shipped with, no `route` and no
 * local resource kinds.
 */
function recordShippedLLMCallMetrics(
  client: Pick<MetricsClient, 'counter'>,
  caller: TurnMetricCaller,
  event: LLMCallSettledEvent,
  agentKind: RunTurnAgentKind | undefined,
): void {
  const final = event.legacyFinal ?? event.final;
  const baseLabels = {
    provider: event.provider,
    model: event.model,
    caller,
    ...agentKindLabels(agentKind),
    scope: event.scope,
  };
  countShippedShape(client, 'pi_llm_logical_call_total', {
    ...baseLabels,
    outcome: final.outcome,
    errorKind: final.errorKind,
    retryTriggered: event.retryTriggered ? 'true' : 'false',
  });
  recordRetryEpisode(client, baseLabels, event, final.outcome);
}

function recordRetryEpisode(
  client: Pick<MetricsClient, 'counter'>,
  baseLabels: MetricLabels,
  event: LLMCallSettledEvent,
  finalOutcome: LLMCallSettledEvent['final']['outcome'],
): void {
  const reason = event.retryReason;
  if (!event.retryTriggered || !reason) return;
  const outcome =
    finalOutcome === 'success' ? 'recovered' : finalOutcome === 'abort' ? 'cancelled' : 'failed';
  swallow(() =>
    client.counter('pi_llm_retry_episode_total', 1, {
      ...baseLabels,
      reason,
      outcome,
    }),
  );
}

/**
 * Per-`PiTurnRunner` metrics host. Owns the running-turn state and hands out
 * one {@link TurnMetricsRecorder} per `runTurn` call.
 */
export class PiTurnMetrics {
  readonly client: MetricsClient;
  readonly nowMs: () => number;
  /**
   * The host reports with the Desktop metric registry: busy time instead of
   * the active-turn gauge, `route` on the request metrics, the first-output,
   * preparation, response-header and transport metrics, and local resource
   * error kinds. Otherwise (the cloud runtime) the runner reports the Pi
   * metrics it shipped before the registry.
   */
  readonly registryMetrics: boolean;
  private readonly enabled: boolean;
  /**
   * 宿主为 LLM 物理请求失败注入的接收端，用于错误日志上报。它不依赖
   * {@link enabled} 或 `client`：错误日志上报与 metrics 是两条独立链路，
   * 即使不存在 MetricsClient 也保持接入。
   */
  readonly onLLMRequestFailure?: PiLLMRequestFailureHook;
  readonly observeLLMRequest?: PiLLMRequestObserver;
  // Running turns of this runner. Runners that share one MetricsClient each
  // add their own busy time, so the counter still sums to the process total.
  // Without registry metrics they feed the per-runner pi_active_turns gauge.
  private readonly activeTurns = new Map<TurnMetricCaller, number>();
  /** `pi_turn_busy_ms_total`; only a host with registry metrics reports it. */
  private readonly busyTime: BusyTimeAccumulator<'pi_turn_busy_ms_total'> | undefined;
  private readonly assemblyFingerprints = new Map<
    string,
    AssemblyFingerprint & { turnId: string }
  >();
  private readonly lastLLMRequestSettledAtBySession = new Map<string, number>();

  constructor(
    client: MetricsClient,
    nowMs: () => number,
    enabled = true,
    onLLMRequestFailure?: PiLLMRequestFailureHook,
    observeLLMRequest?: PiLLMRequestObserver,
    registryMetrics = false,
  ) {
    this.client = client;
    this.nowMs = nowMs;
    this.enabled = enabled;
    this.registryMetrics = registryMetrics;
    this.onLLMRequestFailure = onLLMRequestFailure;
    this.observeLLMRequest = observeLLMRequest;
    // Accrues once per report and at every turn begin and end.
    this.busyTime = registryMetrics
      ? createBusyTimeAccumulator('pi_turn_busy_ms_total', {
          sink: enabled ? client : undefined,
          nowMs,
        })
      : undefined;
  }

  beginTurn(
    caller: RunTurnCaller | undefined,
    model: LLMModelConfig['model'],
    diagnostics: TurnMetricsDiagnostics,
    turn: TurnMetricsContext = {},
  ): TurnMetricsRecorder {
    return new TurnMetricsRecorder(this, caller ?? 'unknown', model, diagnostics, turn);
  }

  bumpActiveTurns(caller: TurnMetricCaller, delta: number): void {
    const next = Math.max(0, (this.activeTurns.get(caller) ?? 0) + delta);
    if (next === 0) {
      this.activeTurns.delete(caller);
    } else {
      this.activeTurns.set(caller, next);
    }
    if (this.busyTime) this.busyTime.set({ caller }, next);
    else this.client.gauge('pi_active_turns', next, { caller });
  }

  observeLLMRequestStarted(sessionId: string, startedAt: number): number | undefined {
    const previous = this.lastLLMRequestSettledAtBySession.get(sessionId);
    if (previous === undefined) return undefined;
    return Math.max(0, startedAt - previous);
  }

  observeLLMRequestSettled(sessionId: string, settledAt: number): void {
    this.lastLLMRequestSettledAtBySession.delete(sessionId);
    this.lastLLMRequestSettledAtBySession.set(sessionId, settledAt);
    if (this.lastLLMRequestSettledAtBySession.size <= MAX_LLM_REQUEST_GAP_BASELINES) return;
    const oldest = this.lastLLMRequestSettledAtBySession.keys().next().value;
    if (oldest !== undefined) this.lastLLMRequestSettledAtBySession.delete(oldest);
  }

  observeAssembly(
    caller: string,
    model: LLMModelConfig['model'],
    diagnostics: TurnMetricsDiagnostics,
    context: Context,
  ): void {
    if (!this.enabled) return;

    const current = fingerprintAssembly(context);
    const key = JSON.stringify([diagnostics.sessionId, String(model.provider), String(model.id)]);
    const previous = this.assemblyFingerprints.get(key);

    // Refresh insertion order so this map is a bounded process-local LRU.
    this.assemblyFingerprints.delete(key);
    this.assemblyFingerprints.set(key, { ...current, turnId: diagnostics.turnId });
    if (this.assemblyFingerprints.size > MAX_ASSEMBLY_FINGERPRINT_BASELINES) {
      const oldest = this.assemblyFingerprints.keys().next().value;
      if (oldest !== undefined) this.assemblyFingerprints.delete(oldest);
    }

    if (!previous) return;
    const scope = previous.turnId === diagnostics.turnId ? 'within_turn' : 'across_turn';
    const labels = {
      provider: String(model.provider),
      model: String(model.id),
      caller,
      scope,
    };
    this.observeAssemblyPart(
      diagnostics,
      labels,
      'system_prompt',
      previous.systemPrompt,
      current.systemPrompt,
    );
    this.observeAssemblyPart(diagnostics, labels, 'tools', previous.tools, current.tools);
  }

  private observeAssemblyPart(
    diagnostics: TurnMetricsDiagnostics,
    labels: MetricLabels,
    part: 'system_prompt' | 'tools',
    previousFingerprint: string,
    currentFingerprint: string,
  ): void {
    const result = previousFingerprint === currentFingerprint ? 'stable' : 'changed';
    this.client.counter('pi_llm_assembly_stability_total', 1, { ...labels, part, result });
    if (result !== 'changed') return;
    swallow(() =>
      diagnostics.logger.info?.(
        {
          session_id: diagnostics.sessionId,
          turn_id: diagnostics.turnId,
          part,
          scope: labels.scope,
          provider: labels.provider,
          model: labels.model,
          caller: labels.caller,
          previous_fingerprint: previousFingerprint,
          current_fingerprint: currentFingerprint,
        },
        'pi_llm_assembly_fingerprint_changed',
      ),
    );
  }
}

/**
 * Per-turn recorder. `PiTurnRunner.runTurn` creates one before any work and
 * always calls {@link finish} in a `finally`, so turn totals and busy time
 * stay balanced on every exit path (completed / failed / aborted / thrown).
 */
export class TurnMetricsRecorder {
  private readonly owner: PiTurnMetrics;
  private readonly caller: TurnMetricCaller;
  private readonly route: ModelCallRouteLabel;
  /** `{ agentKind }` when the host classified the Turn; empty keeps the legacy label set. */
  private readonly agentLabels: AgentKindLabels;
  private readonly agentKind: RunTurnAgentKind | undefined;
  private readonly wake: RunTurnWake;
  private readonly conversation: TurnConversationLabel;
  private readonly isYielded: () => boolean;
  private readonly modelId: string;
  private readonly turnLabels: MetricLabels;
  private readonly turnStartedAt: number;
  private readonly diagnostics: TurnMetricsDiagnostics;
  private loopSteps = 0;
  private batchStartedAt: number | undefined;
  private readonly toolStartedAt = new Map<string, number>();
  private readonly toolIOStarted = new Map<
    string,
    { toolName: string; operation?: string; arguments: MeasuredToolValue }
  >();
  private readonly registeredToolNames = new Set<string>();
  private readonly toolOperationClassifiers = new Map<string, RegisteredToolOperationClassifier>();
  private finished = false;
  private llmFailure?: LLMFailureObservation;
  private terminalFailure?: TurnFailureProvenance;
  // Caller abort can record llm/abort before the Turn settles as cancelled.
  // Retain a real cleanup failure without changing first-wins semantics.
  private firstNonLlmTerminalFailure?: TurnFailureProvenance;
  private readonly pendingSettlements: Promise<unknown>[] = [];
  private readonly degradationErrors = new WeakSet<object>();
  // The provider result object is also carried by pi's message_end event. Keep the
  // physical request duration beside that identity until EventBridge materialises usage.
  private readonly requestDurationsMs = new WeakMap<object, number>();
  // First-output marks of this turn; they go away with the recorder.
  private readonly timing?: PiTurnTiming;
  private runningAtMs: number | undefined;
  private firstRequestStarted = false;
  private compactedBeforeFirstRequest = false;
  private turnFirstOutputRecorded = false;

  constructor(
    owner: PiTurnMetrics,
    caller: TurnMetricCaller,
    model: LLMModelConfig['model'],
    diagnostics: TurnMetricsDiagnostics,
    turn: TurnMetricsContext = {},
  ) {
    this.owner = owner;
    this.caller = caller;
    this.route = turn.route ?? 'unknown';
    this.timing = turn.timing;
    this.agentKind = turn.agentKind;
    this.agentLabels = agentKindLabels(turn.agentKind);
    this.wake = turn.wake ?? 'system';
    this.conversation = turn.conversation ?? 'existing';
    this.isYielded = turn.isYielded ?? (() => false);
    this.modelId = String(model.id);
    this.turnLabels = {
      provider: String(model.provider),
      model: this.modelId,
      caller,
      ...this.agentLabels,
    };
    this.turnStartedAt = owner.nowMs();
    this.diagnostics = diagnostics;
    swallow(() => owner.bumpActiveTurns(caller, +1));
    // The first visible text may come in a later attempt of the turn, after
    // this recorder finished: the binding outlives it with the turn's mark.
    if (this.timing && owner.registryMetrics) {
      turn.visibleText?.bind(() => swallow(() => this.observeFirstVisibleText()));
    }
  }

  /** The turn's running status is written: ends the `persisting` stage. */
  markRunning(): void {
    this.runningAtMs ??= this.owner.nowMs();
  }

  /**
   * Wrap the fully composed streamFn so one LLM request maps to exactly one
   * `pi_llm_request_total` observation. Request start = wrapper invocation.
   */
  wrapStreamFn(inner: StreamFn, settings: { recordTerminalFailure?: boolean } = {}): StreamFn {
    const recordTerminalFailure = settings.recordTerminalFailure ?? true;
    return (async (model, context, streamOptions) => {
      const requestLabels: LLMRequestMetricLabels = {
        provider: String(model.provider),
        model: String(model.id),
        caller: this.caller,
        route: this.route,
        ...this.agentLabels,
      };
      const requestStartedAt = this.owner.nowMs();
      const { registryMetrics } = this.owner;
      const phase = readTurnRequestPhase(streamOptions);
      if (registryMetrics) swallow(() => this.observeRequestStarted(phase, requestStartedAt));
      const interRequestGapMs = this.owner.observeLLMRequestStarted(
        this.diagnostics.sessionId,
        requestStartedAt,
      );
      const settlementObserver = swallowValue(() =>
        this.owner.observeLLMRequest?.({
          sessionId: this.diagnostics.sessionId,
          turnId: this.diagnostics.turnId,
          startedAtMs: requestStartedAt,
          provider: String(model.provider),
          model: String(model.id),
          caller: this.caller,
        }),
      );
      let providerError: unknown;
      let hasProviderError = false;
      const callerOnProviderError = streamOptions?.onProviderError;
      const callerOnResponse = streamOptions?.onResponse;
      let responseObserved = false;
      // Providers call onResponse once the response headers arrive, before any
      // event; the Google providers only with the first stream chunk.
      const observeResponse = async (response: ProviderResponse, observedModel: typeof model) => {
        if (!responseObserved) {
          responseObserved = true;
          swallow(() =>
            this.observeResponseHeaders(phase, requestLabels, requestStartedAt, response),
          );
        }
        await callerOnResponse?.(response, observedModel);
      };
      const observedStreamOptions = {
        ...streamOptions,
        onProviderError(error: unknown, observedModel: typeof model): void {
          providerError = error;
          hasProviderError = true;
          swallow(() => callerOnProviderError?.(error, observedModel));
        },
        ...(registryMetrics ? { onResponse: observeResponse } : {}),
      };
      swallow(() => this.owner.observeAssembly(this.caller, model, this.diagnostics, context));
      swallow(() => this.recordToolContextResidency(model, context.messages as AgentMessage[]));
      if (registryMetrics) {
        incrementMetric(this.owner.client, 'pi_llm_request_total', 1, requestLabels);
      } else {
        countShippedShape(
          this.owner.client,
          'pi_llm_request_total',
          this.shippedLabels(requestLabels),
        );
      }

      let stream: AssistantMessageEventStream;
      try {
        stream = await inner(model, context, observedStreamOptions);
      } catch (err) {
        // StreamFn contract says failures should be encoded in the stream,
        // but custom streamFns may still throw — count it, then rethrow.
        swallow(() =>
          this.recordLLMSettled(
            requestLabels,
            requestStartedAt,
            model,
            undefined,
            err,
            hasProviderError ? providerError : undefined,
            recordTerminalFailure,
            interRequestGapMs,
            settlementObserver,
          ),
        );
        throw err;
      }

      // A custom stream may throw from iteration without ever resolving its
      // result promise. Fold that failure into settlement so observability
      // cannot keep runTurn's finally block pending forever.
      const iteratorFailure = newIteratorFailure();
      const observedResult = Promise.race([
        Promise.resolve().then(() => stream.result()),
        iteratorFailure.promise,
      ]).then(
        (final) => {
          swallow(() =>
            this.recordLLMSettled(
              requestLabels,
              requestStartedAt,
              model,
              final,
              undefined,
              hasProviderError ? providerError : undefined,
              recordTerminalFailure,
              interRequestGapMs,
              settlementObserver,
            ),
          );
          return final;
        },
        (err) => {
          swallow(() =>
            this.recordLLMSettled(
              requestLabels,
              requestStartedAt,
              model,
              undefined,
              err,
              hasProviderError ? providerError : undefined,
              recordTerminalFailure,
              interRequestGapMs,
              settlementObserver,
            ),
          );
          throw err;
        },
      );

      this.pendingSettlements.push(observedResult.catch(() => undefined));
      return observeFirstToken(
        stream,
        observedResult,
        {
          onFirstToken: () => {
            observeMetric(
              this.owner.client,
              'pi_llm_first_token_ms',
              this.owner.nowMs() - requestStartedAt,
              {
                provider: requestLabels.provider,
                model: requestLabels.model,
                caller: this.caller,
                ...this.agentLabels,
              },
            );
          },
          ...(registryMetrics
            ? {
                onFirstOutput: () =>
                  swallow(() => this.observeFirstOutput(phase, requestLabels, requestStartedAt)),
              }
            : {}),
        },
        iteratorFailure.reject,
      );
    }) as StreamFn;
  }

  requestDurationMsFor(message: unknown): number | undefined {
    return message !== null && typeof message === 'object'
      ? this.requestDurationsMs.get(message)
      : undefined;
  }

  /** Observe only the final logical call outcome, without recounting provider requests. */
  wrapLogicalStreamFn(
    inner: StreamFn,
    settings: { recordTerminalFailure?: boolean } = {},
  ): StreamFn {
    const recordFailureByDefault = settings.recordTerminalFailure ?? true;
    return (async (model, context, options) => {
      // A preempted call settles as aborted while its Turn goes on; it is not a failure.
      const recordsFailure = (): boolean =>
        recordFailureByDefault && !isLLMCallPreempted(options?.signal);
      // The latest provider error of this logical call, for its system error code only.
      let providerError: unknown;
      const callerOnProviderError = options?.onProviderError;
      const observedOptions = {
        ...options,
        onProviderError(error: unknown, observedModel: typeof model): void {
          providerError = error;
          swallow(() => callerOnProviderError?.(error, observedModel));
        },
      };
      let stream: AssistantMessageEventStream;
      try {
        stream = await inner(model, context, observedOptions);
      } catch (error) {
        if (recordsFailure()) {
          swallow(() => this.recordLogicalLLMFailure(undefined, error));
        }
        throw error;
      }

      const iteratorFailure = newIteratorFailure();
      const observedResult = Promise.race([
        Promise.resolve().then(() => stream.result()),
        iteratorFailure.promise,
      ]).then(
        (final) => {
          if (recordsFailure()) {
            swallow(() => this.recordLogicalLLMFailure(final, undefined, providerError));
          }
          return final;
        },
        (error) => {
          if (recordsFailure()) {
            swallow(() => this.recordLogicalLLMFailure(undefined, error));
          }
          throw error;
        },
      );
      this.pendingSettlements.push(observedResult.catch(() => undefined));
      return observeFirstToken(stream, observedResult, {}, iteratorFailure.reject);
    }) as StreamFn;
  }

  /**
   * The first request of a phase other than compaction ends preparation; a
   * compaction request before it marks the turn as compacted.
   */
  private observeRequestStarted(phase: TurnRequestPhase | undefined, startedAtMs: number): void {
    if (this.firstRequestStarted) return;
    if (phase === 'compaction') {
      this.compactedBeforeFirstRequest = true;
      return;
    }
    if (phase !== 'initial') return;
    this.firstRequestStarted = true;
    if (!this.timing) return;
    const stages = turnPrepareStages(this.timing, {
      runningAtMs: this.runningAtMs,
      firstRequestAtMs: startedAtMs,
      compacted: this.compactedBeforeFirstRequest,
    });
    for (const { stage, ms } of stages) {
      observeMetric(this.owner.client, 'pi_turn_prepare_ms', ms, {
        stage,
        caller: this.caller,
        wake: this.wake,
        ...this.agentLabels,
      });
    }
  }

  private observeResponseHeaders(
    phase: TurnRequestPhase | undefined,
    labels: LLMRequestMetricLabels,
    startedAtMs: number,
    response: ProviderResponse,
  ): void {
    if (!measuredPhase(phase)) return;
    const { client } = this.owner;
    const waitMs = this.owner.nowMs() - startedAtMs;
    const { route, model, caller } = labels;
    observeMetric(client, 'pi_llm_response_header_ms', waitMs, { route, model, caller });
    if (route !== 'managed_token_plan') return;
    const timing = parseGatewayServerTiming(responseHeader(response.headers, 'server-timing'));
    const transportMs = managedTransportMs(waitMs, timing);
    if (transportMs !== undefined) {
      observeMetric(client, 'pi_llm_transport_ms', transportMs, { model, caller });
    }
  }

  private observeFirstOutput(
    phase: TurnRequestPhase | undefined,
    labels: LLMRequestMetricLabels,
    startedAtMs: number,
  ): void {
    if (!measuredPhase(phase)) return;
    const { client } = this.owner;
    const now = this.owner.nowMs();
    const { route, model, caller } = labels;
    observeMetric(client, 'pi_llm_first_output_ms', now - startedAtMs, {
      route,
      model,
      caller,
      phase,
      ...this.agentLabels,
    });
    if (phase !== 'initial' || this.turnFirstOutputRecorded || !this.timing) return;
    this.turnFirstOutputRecorded = true;
    const sinceAcceptedMs = now - this.timing.acceptedAtMs;
    if (!Number.isFinite(sinceAcceptedMs) || sinceAcceptedMs < 0) return;
    observeMetric(client, 'pi_turn_first_output_ms', sinceAcceptedMs, {
      route,
      model,
      caller,
      compacted: this.compactedBeforeFirstRequest ? 'true' : 'false',
      wake: this.wake,
      conversation: this.conversation,
      ...this.agentLabels,
    });
  }

  /** The host marked the turn's first visible text; labelled like `pi_turn_first_output_ms`. */
  private observeFirstVisibleText(): void {
    if (!this.timing) return;
    const sinceAcceptedMs = this.owner.nowMs() - this.timing.acceptedAtMs;
    if (!Number.isFinite(sinceAcceptedMs) || sinceAcceptedMs < 0) return;
    observeMetric(this.owner.client, 'pi_turn_first_visible_text_ms', sinceAcceptedMs, {
      route: this.route,
      model: this.modelId,
      caller: this.caller,
      compacted: this.compactedBeforeFirstRequest ? 'true' : 'false',
      wake: this.wake,
      conversation: this.conversation,
      ...this.agentLabels,
    });
  }

  observeRetry(event: LLMRetryEvent): void {
    const reason = event.error?.reason;
    if (!reason) return;
    const labels = { ...this.turnLabels, reason, scope: event.scope };
    if (event.status === 'waiting' && event.waitingFor === 'network') {
      // An offline device is not a provider failure: keep it out of the retry
      // rate and backoff distribution, which alert on the service.
      swallow(() =>
        this.owner.client.counter('pi_llm_offline_wait_total', 1, {
          ...this.turnLabels,
          scope: event.scope,
        }),
      );
    } else if (event.status === 'waiting') {
      swallow(() => this.owner.client.counter('pi_llm_retry_total', 1, labels));
      const { delayMs } = event;
      if (delayMs !== undefined) {
        swallow(() => this.owner.client.histogram('pi_llm_retry_delay_ms', delayMs, labels));
      }
    } else if (event.status === 'exhausted') {
      swallow(() => this.owner.client.counter('pi_llm_retry_exhausted_total', 1, labels));
    }
  }

  observeLLMCall(event: LLMCallSettledEvent): void {
    if (this.owner.registryMetrics) {
      recordPiLLMCallMetrics(this.owner.client, this.caller, event, this.route, this.agentKind);
    } else {
      recordShippedLLMCallMetrics(this.owner.client, this.caller, event, this.agentKind);
    }
  }

  /** Second lightweight subscription — tool/loop/batch observations. */
  observeAgent(agent: Agent, runtimeTools?: readonly RuntimeTool[]): void {
    agent.state.tools.forEach((tool) => this.registeredToolNames.add(tool.name));
    for (const tool of runtimeTools ?? []) {
      swallow(() => {
        const classifier = tool.def.operationClassifier;
        if (!classifier || !this.registeredToolNames.has(tool.def.name)) return;
        const registered = registerToolOperationClassifier(classifier);
        if (registered.rejectedValueCount > 0) {
          // Rejected entries silently collapse into the `unknown` bucket at
          // query time, which looks like a product problem rather than a
          // vocabulary problem. Name it once at registration instead.
          this.diagnostics.logger.warn?.(
            {
              session_id: this.diagnostics.sessionId,
              turn_id: this.diagnostics.turnId,
              tool_name: tool.def.name,
              accepted_operations: registered.allowedValues.size,
              rejected_operations: registered.rejectedValueCount,
              max_operations: MAX_TOOL_OPERATION_VALUES,
              max_operation_length: MAX_TOOL_OPERATION_VALUE_LENGTH,
            },
            'pi_tool_operation_vocabulary_truncated',
          );
        }
        this.toolOperationClassifiers.set(tool.def.name, registered);
      });
    }
    agent.subscribe((event) => {
      swallow(() => this.onAgentEvent(event));
    });
  }

  getLLMFailureObservation(): LLMFailureObservation | undefined {
    return this.llmFailure;
  }

  /**
   * A recovered provider error must not become the turn's failure provenance,
   * whether it is still an observation or already the terminal failure.
   * Request and error counters already emitted stay.
   */
  forgetLLMFailureObservation(): void {
    this.llmFailure = undefined;
    if (this.terminalFailure?.errorSource === 'llm') {
      this.terminalFailure = this.firstNonLlmTerminalFailure;
    }
  }

  /**
   * Record the first terminal failure of the turn. `cause` is the error behind
   * it: a local resource it ran out of replaces the kind, never the source.
   */
  tryRecordTerminalFailure(provenance: TurnFailureProvenance, cause?: unknown): boolean {
    const localResource = this.owner.registryMetrics
      ? classifyLocalResourceError(cause)
      : undefined;
    const recorded = localResource ? { ...provenance, errorKind: localResource } : provenance;
    if (recorded.errorSource !== 'llm') {
      this.firstNonLlmTerminalFailure ??= recorded;
    }
    if (this.terminalFailure) return false;
    this.terminalFailure = recorded;
    return true;
  }

  recordDegradation(
    errorSource: TurnErrorSource,
    errorKind: NonLLMTurnErrorKind,
    err?: unknown,
  ): void {
    if (err && typeof err === 'object') {
      if (this.degradationErrors.has(err)) return;
      this.degradationErrors.add(err);
    }
    swallow(() =>
      this.owner.client.counter('pi_turn_degradation_total', 1, {
        caller: this.caller,
        errorSource,
        errorKind,
      }),
    );
  }

  /**
   * A tool call cut short by its run ending instead of failing: cancelled by
   * the yield of this run, or settled for an earlier run that stopped.
   */
  recordInterruptedToolCall(cause: 'yield' | 'run_restart'): void {
    swallow(() =>
      incrementMetric(this.owner.client, 'pi_tool_call_interrupted_total', 1, {
        caller: this.caller,
        cause,
        ...this.agentLabels,
      }),
    );
  }

  async settle(): Promise<void> {
    await Promise.all(this.pendingSettlements);
  }

  /** `thrown` is what `runTurn` threw when it ended without a terminal frame. */
  finish(
    termination: TurnTerminationReason | undefined,
    abortReason?: unknown,
    thrown?: unknown,
  ): void {
    swallow(() => {
      if (this.finished) return;
      this.finished = true;
      this.toolIOStarted.clear();
      const { client } = this.owner;
      const caller = this.caller;
      const labels = this.turnLabels;
      this.owner.bumpActiveTurns(caller, -1);
      // pi_turn_total keeps its caller-only labels; the model dimensions live
      // on pi_turn_model_total, which shipped with them. Adding a bounded label
      // in place would also work: gateway-app accepts one metric's series with
      // different label keys (v0.2.51), and sums over the old labels stay the
      // same. `agentKind` rides only on the newer families (turnLabels,
      // pi_turn_failure_total and the pi_tool_call_total / _error_total
      // counters), never on pi_turn_total / pi_turn_error_total.
      client.counter('pi_turn_total', 1, { caller });
      client.counter('pi_turn_model_total', 1, labels);
      const isCancellation = termination?.kind === 'aborted';
      let failure = this.terminalFailure;
      if (isCancellation && failure?.errorSource === 'llm') {
        failure = this.firstNonLlmTerminalFailure;
      }
      if (!failure && termination?.kind === 'failed' && this.llmFailure) {
        failure = { errorSource: 'llm', errorKind: this.failureKind(this.llmFailure) };
      } else if (!failure && termination === undefined) {
        const localResource = this.owner.registryMetrics
          ? classifyLocalResourceError(thrown)
          : undefined;
        failure = { errorSource: 'runner', errorKind: localResource ?? 'runtime_error' };
      } else if (!failure && termination?.kind === 'failed') {
        failure = { errorSource: 'unknown', errorKind: 'unknown' };
      }
      if (failure) {
        // `pi_turn_error_total` shipped as {caller,errorKind}; errorSource
        // belongs to a distinct family so older app versions remain accepted.
        client.counter('pi_turn_error_total', 1, {
          caller,
          errorKind: failure.errorKind,
        });
        incrementMetric(client, 'pi_turn_failure_total', 1, {
          caller,
          ...this.agentLabels,
          ...failure,
        });
      }
      if (isCancellation && this.isYielded()) {
        // A later run of the same turn continues a yielded one: no cancellation.
        incrementMetric(client, 'pi_turn_yield_total', 1, { caller, ...this.agentLabels });
      } else if (isCancellation) {
        // Preserve the legacy error family while keeping cancellations out of
        // the failure family. A real terminal failure still takes precedence.
        if (!failure) {
          client.counter('pi_turn_error_total', 1, { caller, errorKind: 'abort' });
        }
        client.counter('pi_turn_abort_total', 1, {
          ...labels,
          abortSource: normalizeAbortSource(abortReason),
        });
      }
      client.histogram('pi_turn_duration_ms', this.owner.nowMs() - this.turnStartedAt, { caller });
      client.histogram('pi_loop_steps', this.loopSteps, { caller });
    });
  }

  private onAgentEvent(event: AgentEvent): void {
    const { client } = this.owner;
    const caller = this.caller;
    switch (event.type) {
      case 'turn_start':
        // One pi turn == one inner loop step (assistant response + tool batch).
        this.loopSteps += 1;
        client.counter('pi_loop_step_total', 1, this.turnLabels);
        this.batchStartedAt = undefined;
        break;
      case 'tool_execution_start': {
        const now = this.owner.nowMs();
        const toolName = this.metricToolName(event.toolName);
        this.toolStartedAt.set(event.toolCallId, now);
        this.batchStartedAt ??= now;
        // Counters carry agentKind when present; duration/batch histograms keep their legacy keys.
        client.counter('pi_tool_call_total', 1, { toolName, caller, ...this.agentLabels });
        const operation = this.metricToolOperation(toolName, event.args);
        this.toolIOStarted.set(event.toolCallId, {
          toolName,
          ...(operation !== undefined ? { operation } : {}),
          arguments: measureToolArguments(event.args, this.diagnostics.estimator),
        });
        break;
      }
      case 'tool_execution_end': {
        const now = this.owner.nowMs();
        const toolName = this.metricToolName(event.toolName);
        const startedAt = this.toolStartedAt.get(event.toolCallId);
        this.toolStartedAt.delete(event.toolCallId);
        if (startedAt !== undefined) {
          client.histogram('pi_tool_call_duration_ms', now - startedAt, {
            toolName,
            caller,
          });
        }
        if (event.isError && this.isYielded()) {
          this.recordInterruptedToolCall('yield');
        } else if (event.isError) {
          client.counter('pi_tool_call_error_total', 1, {
            toolName,
            caller,
            ...this.agentLabels,
            errorKind: toolErrorKind(event.result),
          });
        }
        const toolIO = this.toolIOStarted.get(event.toolCallId);
        this.toolIOStarted.delete(event.toolCallId);
        if (toolIO) {
          this.recordToolIO(
            event.toolCallId,
            toolIO.toolName,
            toolIO.operation,
            'arguments',
            toolIO.arguments,
          );
          this.recordToolIO(
            event.toolCallId,
            toolIO.toolName,
            toolIO.operation,
            'result',
            measureToolResult(event.result, this.diagnostics.estimator),
          );
        }
        break;
      }
      case 'turn_end':
        if (this.batchStartedAt !== undefined) {
          client.histogram('pi_tool_batch_duration_ms', this.owner.nowMs() - this.batchStartedAt, {
            caller,
          });
          this.batchStartedAt = undefined;
        }
        this.toolIOStarted.clear();
        break;
      default:
        break;
    }
  }

  private metricToolName(toolName: string): string {
    return this.registeredToolNames.has(toolName) ? toolName : 'unknown';
  }

  private metricToolOperation(toolName: string, args: unknown): string | undefined {
    const classifier = this.toolOperationClassifiers.get(toolName);
    if (!classifier) return undefined;
    try {
      const operation = classifier.classify(args);
      return operation !== undefined && classifier.allowedValues.has(operation)
        ? operation
        : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private recordToolIO(
    toolCallId: string,
    toolName: string,
    operation: string | undefined,
    direction: 'arguments' | 'result',
    measured: MeasuredToolValue,
  ): void {
    const labels = { direction, toolName, caller: this.caller };
    const client = this.owner.client;
    client.histogram('pi_tool_io_bytes', measured.bytes, labels);
    const tokens = measured.tokens;
    if (tokens !== undefined) {
      if (tokens >= LARGE_TOOL_IO_TOKEN_THRESHOLD) {
        this.diagnostics.logger.info?.(
          {
            session_id: this.diagnostics.sessionId,
            turn_id: this.diagnostics.turnId,
            tool_call_id: toolCallId,
            tool_name: toolName,
            direction,
            bytes: measured.bytes,
            estimated_tokens: tokens,
            caller: this.caller,
            ...(operation !== undefined ? { tool_operation: operation } : {}),
          },
          'pi_tool_context_large_io_observed',
        );
      }
    }
    if (operation === undefined || direction !== 'result') return;
    const operationLabels = { toolName, operation, caller: this.caller };
    swallow(() =>
      client.histogram('pi_tool_operation_result_bytes', measured.bytes, operationLabels),
    );
    if (tokens !== undefined) {
      swallow(() => client.histogram('pi_tool_operation_result_tokens', tokens, operationLabels));
    }
  }

  private recordToolContextResidency(
    model: LLMModelConfig['model'],
    messages: readonly AgentMessage[],
  ): void {
    // 驻留量只记 bytes：不传估算器，避免每次 provider 请求都对整段历史重新估算 token。
    const breakdown = measureToolContext(messages, undefined, (toolName) =>
      this.metricToolName(toolName),
    );
    const labels = {
      provider: String(model.provider),
      model: String(model.id),
      caller: this.caller,
    };
    this.owner.client.histogram('pi_tool_context_resident_bytes', breakdown.argumentBytes, {
      kind: 'arguments',
      ...labels,
    });
    this.owner.client.histogram('pi_tool_context_resident_bytes', breakdown.resultBytes, {
      kind: 'result',
      ...labels,
    });

    for (const [toolName, contribution] of breakdown.byTool) {
      this.recordResidentBytes(toolName, 'arguments', contribution.argumentBytes);
      this.recordResidentBytes(toolName, 'result', contribution.resultBytes);
    }
  }

  private recordResidentBytes(toolName: string, kind: 'arguments' | 'result', bytes: number): void {
    if (bytes <= 0) return;
    this.owner.client.counter('pi_tool_context_resident_bytes_total', bytes, {
      kind,
      toolName,
      caller: this.caller,
    });
  }

  private recordLLMSettled(
    requestLabels: LLMRequestMetricLabels,
    requestStartedAt: number,
    model: LLMModelConfig['model'],
    final: AssistantMessage | undefined,
    thrown?: unknown,
    providerError?: unknown,
    recordTerminalFailure = true,
    interRequestGapMs?: number,
    settlementObserver?: PiLLMRequestSettlementObserver | void,
  ): void {
    const { client } = this.owner;
    const labels = this.shippedLabels(requestLabels);
    const responseCompletedAt = this.owner.nowMs();
    swallow(() =>
      this.owner.observeLLMRequestSettled(this.diagnostics.sessionId, responseCompletedAt),
    );
    const requestDurationMs = responseCompletedAt - requestStartedAt;
    const cacheOutcome: PiLLMCacheOutcome =
      typeof final?.usage?.cacheRead === 'number'
        ? final.usage.cacheRead > 0
          ? 'read'
          : 'no_read'
        : 'telemetry_unknown';
    if (settlementObserver) {
      swallow(() => settlementObserver({ endedAtMs: responseCompletedAt, cacheOutcome }));
    }
    if (this.owner.registryMetrics) {
      observeMetric(client, 'pi_llm_response_ms', requestDurationMs, requestLabels);
    } else {
      observeShippedShape(client, 'pi_llm_response_ms', requestDurationMs, labels);
    }
    if (final && Number.isFinite(requestDurationMs) && requestDurationMs > 0) {
      this.requestDurationsMs.set(final, requestDurationMs);
    }
    const observation = observeLLMFailure(final, thrown, providerError);
    const gapClass = classifyLLMGap(interRequestGapMs);
    swallow(() =>
      client.counter('pi_llm_cache_outcome_total', 1, {
        ...labels,
        gapClass,
        outcome: cacheOutcome,
      }),
    );

    if (final?.usage) {
      emitTokens(client, labels, 'input', final.usage.input);
      emitTokens(
        client,
        labels,
        'cache',
        (final.usage.cacheRead ?? 0) + (final.usage.cacheWrite ?? 0),
      );
      emitCacheTokens(client, labels, 'read', final.usage.cacheRead);
      emitCacheTokens(client, labels, 'write', final.usage.cacheWrite);
      emitTokens(client, labels, 'output', final.usage.output);
    }
    if (observation) {
      if (recordTerminalFailure) {
        this.llmFailure ??= observation;
        this.tryRecordTerminalFailure({
          errorSource: 'llm',
          errorKind: this.failureKind(observation),
        });
      }
      client.counter('pi_llm_request_error_total', 1, {
        ...labels,
        errorKind: observation.metricKind,
      });
      // 宿主注入的错误日志上报 hook，首期用于 LLM provider 失败。
      // 每次物理请求失败都会触发，包括每个重试 attempt。这里刻意放在物理请求结束点，
      // 而不是逻辑请求包装层，避免把多次重试合并成一条日志。`'abort'` 不是真实的
      // provider 失败，且方案要求“用户取消默认不上报”，因此排除用户取消。
      // 通过 `swallow` 保护调用，保证 hook 抛错也不会破坏请求、重试或 turn。
      // 网关打回内容（content_error）是业务结果，不是 provider 故障，不交给失败上报。
      const contentReviewed =
        parseContentReviewError(final) !== undefined ||
        parseContentReviewError(thrown) !== undefined;
      if (
        observation.metricKind !== 'abort' &&
        !contentReviewed &&
        this.owner.onLLMRequestFailure
      ) {
        const hook = this.owner.onLLMRequestFailure;
        swallow(() =>
          hook({
            sessionId: this.diagnostics.sessionId,
            turnId: this.diagnostics.turnId,
            ...(thrown !== undefined ? { error: thrown } : {}),
            ...(providerError !== undefined ? { providerError } : {}),
            ...(final?.errorMessage ? { errorMessage: final.errorMessage } : {}),
            metricKind: observation.metricKind,
            request: {
              api: String(model.api),
              baseUrl: String(model.baseUrl),
              caller: this.caller,
              model: String(model.id),
              provider: String(model.provider),
            },
            occurredAtMs: responseCompletedAt,
          }),
        );
      }
    }
  }

  private recordLogicalLLMFailure(
    final: AssistantMessage | undefined,
    thrown?: unknown,
    providerError?: unknown,
  ): void {
    // A request the host refused to send never reached a provider and ends
    // the Turn normally; it is neither an LLM failure nor a Turn failure.
    if (thrown instanceof LLMRequestStoppedError) return;
    const observation = observeLLMFailure(final, thrown, providerError);
    if (!observation) return;
    this.llmFailure ??= observation;
    this.tryRecordTerminalFailure({ errorSource: 'llm', errorKind: this.failureKind(observation) });
  }

  /** A turn failure's kind: local resource kinds only for hosts with registry metrics. */
  private failureKind(observation: LLMFailureObservation): LLMFailureErrorKind {
    return this.owner.registryMetrics ? observation.failureKind : observation.metricKind;
  }

  /** Request labels without `route`, as the metrics next to the request ones report them. */
  private shippedLabels(requestLabels: LLMRequestMetricLabels): MetricLabels {
    return { ...shippedRequestLabels(requestLabels), ...this.agentLabels };
  }
}

function classifyLLMGap(gapMs: number | undefined): 'first_request' | 'lt_5m' | 'gte_5m' {
  if (gapMs === undefined) return 'first_request';
  return gapMs < 300_000 ? 'lt_5m' : 'gte_5m';
}

function observeLLMFailure(
  final: AssistantMessage | undefined,
  thrown?: unknown,
  providerError?: unknown,
): LLMFailureObservation | undefined {
  if (thrown === undefined && final?.stopReason !== 'error' && final?.stopReason !== 'aborted') {
    return undefined;
  }
  const normalized = normalizeLLMError({
    ...(thrown !== undefined ? { raw: thrown } : {}),
    ...(providerError !== undefined ? { providerError } : {}),
    finishReason: final?.stopReason,
    errorMessage: final?.errorMessage,
    explicitAbort: final?.stopReason === 'aborted',
  });
  const metricKind = toLLMMetricErrorKind(normalized.facts);
  // Only the kinds: `normalized` still carries the failure the Turn reports.
  if (metricKind !== 'abort' && readLLMStreamFailureKind({ final, thrown }) === 'llm_reply_loop') {
    return { normalized, metricKind: 'reply_loop', failureKind: 'reply_loop' };
  }
  return { normalized, metricKind, failureKind: toLLMFailureErrorKind(normalized.facts) };
}

function emitTokens(
  client: MetricsClient,
  labels: MetricLabels,
  kind: 'input' | 'cache' | 'output',
  count: number | undefined,
): void {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return;
  client.counter('pi_llm_tokens_total', count, { ...labels, kind });
}

function emitCacheTokens(
  client: MetricsClient,
  labels: MetricLabels,
  operation: 'read' | 'write',
  count: number | undefined,
): void {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return;
  client.counter('pi_llm_cache_tokens_total', count, { ...labels, operation });
}

function registerToolOperationClassifier(
  classifier: ToolOperationClassifier,
): RegisteredToolOperationClassifier {
  const allowedValues = new Set<string>();
  let rejectedValueCount = 0;
  for (const value of classifier.allowedValues) {
    if (
      allowedValues.size >= MAX_TOOL_OPERATION_VALUES ||
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_TOOL_OPERATION_VALUE_LENGTH
    ) {
      rejectedValueCount += 1;
      continue;
    }
    allowedValues.add(value);
  }
  return {
    allowedValues,
    rejectedValueCount,
    classify: (args) => classifier.classify(args),
  };
}

/**
 * errorKind for tool failures. Tool errors at this layer are already
 * collapsed into a text result, so keep the bucket set tiny and bounded.
 */
function toolErrorKind(result: unknown): 'abort' | 'timeout' | 'error' {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = Array.isArray(content)
    ? (content.find((block) => block?.type === 'text')?.text ?? '')
    : '';
  if (/\babort/i.test(text)) return 'abort';
  if (/\btimed?\s*out\b/i.test(text)) return 'timeout';
  return 'error';
}

interface FirstEventObservers {
  /** First text, thinking or tool-call event, block starts included. */
  readonly onFirstToken?: () => void;
  /** First effective output; see `isEffectiveOutputEvent`. */
  readonly onFirstOutput?: () => void;
}

/**
 * Duck-type stream wrapper: forwards iteration/result untouched and fires each
 * observer once, when the turn reads its first matching event. The agent loop
 * only consumes `[Symbol.asyncIterator]()` and `result()`.
 */
function observeFirstToken(
  stream: AssistantMessageEventStream,
  result: Promise<AssistantMessage>,
  observers: FirstEventObservers,
  onIteratorError: (error: unknown) => void,
): AssistantMessageEventStream {
  let seenToken = false;
  let seenOutput = false;
  const wrapped = {
    [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
      const inner = createObservedIterator(stream, onIteratorError);
      const iterator: AsyncIterator<AssistantMessageEvent> = {
        next: async (...args) => {
          try {
            const step = await inner.next(...args);
            const event = step.done ? undefined : step.value;
            if (event && !seenToken && FIRST_TOKEN_EVENT_TYPES.has(event.type)) {
              seenToken = true;
              observers.onFirstToken?.();
            }
            if (event && !seenOutput && isEffectiveOutputEvent(event)) {
              seenOutput = true;
              observers.onFirstOutput?.();
            }
            return step;
          } catch (error) {
            onIteratorError(error);
            throw error;
          }
        },
      };
      if (inner.return) iterator.return = inner.return.bind(inner);
      if (inner.throw) iterator.throw = inner.throw.bind(inner);
      return iterator;
    },
    result: () => result,
  };
  return wrapped as unknown as AssistantMessageEventStream;
}

function createObservedIterator(
  stream: AssistantMessageEventStream,
  onIteratorError: (error: unknown) => void,
): AsyncIterator<AssistantMessageEvent> {
  try {
    return stream[Symbol.asyncIterator]();
  } catch (error) {
    onIteratorError(error);
    throw error;
  }
}

function newIteratorFailure(): { promise: Promise<never>; reject: (error: unknown) => void } {
  let rejectPromise: (error: unknown) => void = () => {};
  const promise = new Promise<never>((_, reject) => {
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise };
}

/** The `agentKind` label of a classified Turn's metrics; nothing, not an empty value, otherwise. */
type AgentKindLabels = { readonly agentKind?: RunTurnAgentKind };

function agentKindLabels(agentKind: RunTurnAgentKind | undefined): AgentKindLabels {
  return agentKind ? { agentKind } : {};
}

/** Metrics must never break the product path — not even on client bugs. */
function swallow(fn: () => void): void {
  try {
    fn();
  } catch {
    // intentionally silent
  }
}

function swallowValue<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
