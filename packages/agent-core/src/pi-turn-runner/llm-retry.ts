import type { StreamFn } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ProviderResponse,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  normalizeLLMError,
  toLLMMetricErrorKind,
  toLLMProtocolClassification,
  toLLMRetryDecision,
  type LLMMetricErrorKind,
  type LLMRetryReason,
  type NormalizedLLMError,
} from '@mavis/shared/llm-error-classifier';

function isByokProvider(provider: string): boolean {
  return provider === 'minimax_api' || provider.startsWith('custom_provider:');
}

export type LLMCallScope = 'agent' | 'compaction' | 'title';
export type LLMRetryStatus = 'waiting' | 'recovered' | 'exhausted' | 'cancelled';
export type LLMCallOutcome = 'success' | 'error' | 'abort';
export type LLMCallErrorKind = LLMMetricErrorKind | 'none';

/** Symbol-keyed identity shared by physical attempts of one logical call. */
export const LLM_RETRY_CALL_IDENTITY: unique symbol = Symbol('mavis.llmRetryCallIdentity');

/** Symbol-keyed observer for every physical provider request in a logical call. */
export const LLM_RETRY_REQUEST_SETTLED_OBSERVER: unique symbol = Symbol(
  'mavis.llmRetryRequestSettledObserver',
);

export interface LLMRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryElapsedMs: number;
}

export const DEFAULT_LLM_RETRY_POLICY: Readonly<LLMRetryPolicy> = {
  maxRetries: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetryElapsedMs: 120_000,
};

export interface LLMRetryError {
  reason: LLMMetricErrorKind;
  code?: number;
  message: string;
}

export interface LLMRetryEvent {
  sessionId: string;
  turnId: string;
  callId: string;
  scope: LLMCallScope;
  status: LLMRetryStatus;
  /** Number of retries already used or about to start; the initial request is zero. */
  retryAttempt: number;
  maxRetries: number;
  /** One-based physical provider request ordinal. */
  requestAttempt: number;
  delayMs?: number;
  nextRetryAtMs?: number;
  error?: LLMRetryError;
}

/** Raw provider token buckets from the final attempt of a successful call. */
export interface LLMCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface LLMRequestSettledEvent {
  /** One-based physical provider request ordinal within the logical call. */
  requestAttempt: number;
  outcome: LLMCallOutcome;
  /** Known provider buckets, with invalid or missing buckets normalised to zero. */
  usage?: LLMCallUsage;
  /** False when the provider did not report all four valid buckets. */
  usageComplete: boolean;
}

export type LLMRequestSettledObserver = (event: LLMRequestSettledEvent) => void;

export interface LLMExpectedToolIdentity {
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface LLMCallSettledEvent {
  sessionId: string;
  turnId: string;
  callId: string;
  scope: LLMCallScope;
  provider: string;
  model: string;
  final: {
    outcome: LLMCallOutcome;
    errorKind: LLMCallErrorKind;
  };
  /** True once the framework schedules the first retry, even if the user cancels its backoff. */
  retryTriggered: boolean;
  retryReason?: LLMRetryReason;
  /** Physical provider requests actually started for this logical call. */
  requestAttempts: number;
  /** Normalized tool identities from a successful final response; arguments are never exposed. */
  expectedTools?: readonly LLMExpectedToolIdentity[];
  /**
   * Raw provider token buckets for a successful call. Absent when the call did
   * not settle with a provider response, so consumers never report synthesised
   * usage for a failed or cancelled call.
   */
  usage?: LLMCallUsage;
}

export interface LLMRetryOptions {
  sessionId: string;
  turnId: string;
  scope: LLMCallScope;
  policy?: Partial<LLMRetryPolicy>;
  observer?: (event: LLMRetryEvent) => void | Promise<void>;
  /** Final logical outcome observer. It is isolated from provider-call behavior. */
  onCallSettled?: (event: LLMCallSettledEvent) => void | Promise<void>;
  generateCallId?: () => string;
  nowMs?: () => number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface RetryFailure {
  normalized: NormalizedLLMError;
  error: LLMRetryError;
  stream?: AssistantMessageEventStream;
  iterator?: AsyncIterator<AssistantMessageEvent>;
  buffered: AssistantMessageEvent[];
  thrown?: unknown;
  retryAfterMs?: number;
}

interface RetryableFailure extends RetryFailure {
  retryReason: LLMRetryReason;
}

interface RetryCallState {
  retryTriggered: boolean;
  retryReason?: LLMRetryReason;
  requestAttempts: number;
}

interface CallSettlementContext {
  input: LLMRetryOptions;
  model: Parameters<StreamFn>[0];
  callId: string;
  state: RetryCallState;
  signal: AbortSignal | undefined;
}

type PreflightResult =
  | { kind: 'committed'; stream: AssistantMessageEventStream }
  | { kind: 'terminal'; failure: RetryFailure }
  | { kind: 'failure'; failure: RetryableFailure };

const PUBLIC_ERROR_MESSAGES: Record<LLMMetricErrorKind, string> = {
  abort: 'LLM request was cancelled',
  timeout: 'LLM request timed out',
  rate_limited: 'LLM provider rate limited the request',
  tpm_rate_limited: 'LLM provider token rate limit reached',
  usage_limit: 'LLM usage limit reached',
  credits_exhausted: 'LLM credits exhausted',
  auth: 'LLM provider authentication failed',
  bad_request: 'LLM provider rejected the request',
  not_found: 'LLM provider resource not found',
  content_filter: 'LLM provider blocked the response',
  server_error: 'LLM provider request failed',
  overloaded: 'LLM provider is overloaded',
  network: 'LLM network connection failed',
  empty_response: 'LLM provider returned an empty response',
  unknown: 'LLM request failed',
  length: 'LLM response reached the length limit',
};

/** Add framework-owned transport retry to a provider StreamFn. Hosts opt in explicitly. */
export function withLLMRetry(inner: StreamFn, input: LLMRetryOptions): StreamFn {
  const policy = resolvePolicy(input.policy);
  const nowMs = input.nowMs ?? Date.now;
  const random = input.random ?? Math.random;
  const sleep = input.sleep ?? abortableSleep;

  return (async (model, context, options) => {
    const callId = input.generateCallId?.() ?? defaultCallId();
    const callIdentity = {};
    const callState: RetryCallState = { retryTriggered: false, requestAttempts: 0 };
    let retryStartedAtMs: number | undefined;
    let requestAttempt = 1;
    let lastFailure: RetryableFailure | undefined;

    while (requestAttempt <= policy.maxRetries + 1) {
      if (options?.signal?.aborted) {
        const error = abortError(options.signal);
        notifyCallSettled(
          { input, model, callId, state: callState, signal: options.signal },
          error,
        );
        throw error;
      }
      const preflight = await preflightAttempt(
        inner,
        model,
        context,
        options,
        nowMs,
        callIdentity,
        isByokProvider(model.provider),
        requestAttempt,
        requestSettledObserver(options),
      );
      callState.requestAttempts = requestAttempt;
      if (preflight.kind === 'committed') {
        if (requestAttempt > 1) {
          await notify(input.observer, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            callId,
            scope: input.scope,
            status: 'recovered',
            retryAttempt: requestAttempt - 1,
            maxRetries: policy.maxRetries,
            requestAttempt,
          });
        }
        return observeCallSettlement(preflight.stream, {
          input,
          model,
          callId,
          state: callState,
          signal: options?.signal,
        });
      }
      if (preflight.kind === 'terminal') {
        if (requestAttempt > 1 && lastFailure) {
          const cancelled = options?.signal?.aborted || isAbortFailure(preflight.failure);
          await notify(input.observer, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            callId,
            scope: input.scope,
            status: cancelled ? 'cancelled' : 'exhausted',
            retryAttempt: requestAttempt - 1,
            maxRetries: policy.maxRetries,
            requestAttempt,
            // The terminal attempt may differ from the transient failure that
            // caused the retry (for example 529 followed by quota exhaustion).
            // Expose the actual final error so downstream code/message handling
            // never reports the stale previous attempt.
            error: preflight.failure.error,
          });
        }
        return observeTerminalFailure(preflight.failure, {
          input,
          model,
          callId,
          state: callState,
          signal: options?.signal,
        });
      }

      lastFailure = preflight.failure;
      const retryAttempt = requestAttempt;
      const delayMs = retryDelayMs(lastFailure.retryAfterMs, retryAttempt, policy, random);
      const failureAtMs = nowMs();
      retryStartedAtMs ??= failureAtMs;
      const retryDeadlineExceeded =
        failureAtMs + delayMs - retryStartedAtMs > policy.maxRetryElapsedMs;
      if (requestAttempt > policy.maxRetries || retryDeadlineExceeded) {
        await notify(input.observer, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          callId,
          scope: input.scope,
          status: 'exhausted',
          retryAttempt: requestAttempt - 1,
          maxRetries: policy.maxRetries,
          requestAttempt,
          error: lastFailure.error,
        });
        return observeTerminalFailure(lastFailure, {
          input,
          model,
          callId,
          state: callState,
          signal: options?.signal,
        });
      }

      callState.retryTriggered = true;
      callState.retryReason ??= lastFailure.retryReason;
      discardAttempt(lastFailure);
      await notify(input.observer, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        callId,
        scope: input.scope,
        status: 'waiting',
        retryAttempt,
        maxRetries: policy.maxRetries,
        requestAttempt: requestAttempt + 1,
        delayMs,
        nextRetryAtMs: failureAtMs + delayMs,
        error: lastFailure.error,
      });
      try {
        await sleep(delayMs, options?.signal);
      } catch (error) {
        await notify(input.observer, {
          sessionId: input.sessionId,
          turnId: input.turnId,
          callId,
          scope: input.scope,
          status: 'cancelled',
          retryAttempt,
          maxRetries: policy.maxRetries,
          requestAttempt: requestAttempt + 1,
          error: lastFailure.error,
        });
        notifyCallSettled(
          { input, model, callId, state: callState, signal: options?.signal },
          error,
        );
        throw error;
      }
      requestAttempt += 1;
    }

    if (lastFailure) {
      return observeTerminalFailure(lastFailure, {
        input,
        model,
        callId,
        state: callState,
        signal: options?.signal,
      });
    }
    const error = new Error('LLM retry loop ended without a provider result');
    notifyCallSettled({ input, model, callId, state: callState, signal: options?.signal }, error);
    throw error;
  }) as StreamFn;
}

async function preflightAttempt(
  inner: StreamFn,
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  nowMs: () => number,
  callIdentity: object,
  retryAllErrors: boolean,
  requestAttempt: number,
  onRequestSettled: LLMRequestSettledObserver | undefined,
): Promise<PreflightResult> {
  let response: ProviderResponse | undefined;
  const callerOnResponse = options?.onResponse;
  const attemptOptions: SimpleStreamOptions = {
    ...(options ?? {}),
    maxRetries: 0,
    onResponse: async (value, responseModel) => {
      response = value;
      await callerOnResponse?.(value, responseModel);
    },
  };
  Object.defineProperty(attemptOptions, LLM_RETRY_CALL_IDENTITY, {
    value: callIdentity,
    // StreamFn composition uses object spread. Enumerable symbol keys survive
    // those wrappers while remaining invisible to JSON/provider payloads.
    enumerable: true,
  });
  let stream: AssistantMessageEventStream;
  try {
    stream = await inner(model, context, attemptOptions);
  } catch (thrown) {
    notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
    return failureResult({ thrown, response, buffered: [], nowMs, retryAllErrors });
  }

  let iterator: AsyncIterator<AssistantMessageEvent>;
  try {
    iterator = stream[Symbol.asyncIterator]();
  } catch (thrown) {
    notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
    return failureResult({ thrown, response, stream, buffered: [], nowMs, retryAllErrors });
  }

  const buffered: AssistantMessageEvent[] = [];
  for (;;) {
    let next: IteratorResult<AssistantMessageEvent>;
    try {
      next = await iterator.next();
    } catch (thrown) {
      notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
      return failureResult({ thrown, response, stream, iterator, buffered, nowMs, retryAllErrors });
    }
    if (next.done) {
      try {
        const final = await stream.result();
        if (isFailureMessage(final)) {
          notifyRequestSettled(onRequestSettled, requestAttempt, final, undefined, options?.signal);
          return failureResult({
            final,
            response,
            stream,
            iterator,
            buffered,
            nowMs,
            retryAllErrors,
          });
        }
        notifyRequestSettled(onRequestSettled, requestAttempt, final, undefined, options?.signal);
        return { kind: 'committed', stream: replayStream(stream, iterator, buffered) };
      } catch (thrown) {
        notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
        return failureResult({
          thrown,
          response,
          stream,
          iterator,
          buffered,
          nowMs,
          retryAllErrors,
        });
      }
    }

    buffered.push(next.value);
    if (next.value.type === 'error') {
      notifyRequestSettled(
        onRequestSettled,
        requestAttempt,
        next.value.error,
        undefined,
        options?.signal,
      );
      return failureResult({
        final: next.value.error,
        response,
        stream,
        iterator,
        buffered,
        nowMs,
        retryAllErrors,
      });
    }
    // A visible delta is the retry commit boundary for every provider. Once
    // callers can observe output, silently replacing the physical request
    // would either buffer the whole response or replay duplicate content.
    // BYOK keeps its broader pre-output retry classification, but a later
    // stream failure must stay on the already-committed attempt.
    if (commitsOutput(next.value) || (!retryAllErrors && next.value.type === 'done')) {
      return {
        kind: 'committed',
        stream: observeRequestSettlement(
          replayStream(stream, iterator, buffered),
          requestAttempt,
          onRequestSettled,
          options?.signal,
        ),
      };
    }
  }
}

function requestSettledObserver(
  options: Parameters<StreamFn>[2],
): LLMRequestSettledObserver | undefined {
  return (
    options as
      | (Parameters<StreamFn>[2] & {
          [LLM_RETRY_REQUEST_SETTLED_OBSERVER]?: LLMRequestSettledObserver;
        })
      | undefined
  )?.[LLM_RETRY_REQUEST_SETTLED_OBSERVER];
}

function notifyRequestSettled(
  observer: LLMRequestSettledObserver | undefined,
  requestAttempt: number,
  final: AssistantMessage | undefined,
  thrown: unknown,
  signal: AbortSignal | undefined,
): void {
  if (!observer) return;
  const providerUsage = readProviderUsage(final);
  try {
    observer({
      requestAttempt,
      outcome: classifyCallOutcome(final, thrown, signal?.aborted === true).outcome,
      ...(providerUsage.usage ? { usage: providerUsage.usage } : {}),
      usageComplete: providerUsage.complete,
    });
  } catch {
    // Physical-call observability must never change provider-call behavior.
  }
}

function observeRequestSettlement(
  source: AssistantMessageEventStream,
  requestAttempt: number,
  observer: LLMRequestSettledObserver | undefined,
  signal: AbortSignal | undefined,
): AssistantMessageEventStream {
  if (!observer) return source;
  let settled = false;
  const settle = (final: AssistantMessage | undefined, error?: unknown): void => {
    if (settled) return;
    settled = true;
    notifyRequestSettled(observer, requestAttempt, final, error, signal);
  };
  const result = Promise.resolve()
    .then(() => source.result())
    .then(
      (final) => {
        settle(final);
        return final;
      },
      (error) => {
        settle(undefined, error);
        throw error;
      },
    );
  void result.catch(() => undefined);

  return {
    [Symbol.asyncIterator]() {
      let inner: AsyncIterator<AssistantMessageEvent>;
      try {
        inner = source[Symbol.asyncIterator]();
      } catch (error) {
        settle(undefined, error);
        throw error;
      }
      const iterator: AsyncIterator<AssistantMessageEvent> = {
        async next(...args) {
          try {
            return await inner.next(...args);
          } catch (error) {
            settle(undefined, error);
            throw error;
          }
        },
      };
      if (inner.return) iterator.return = inner.return.bind(inner);
      if (inner.throw) iterator.throw = inner.throw.bind(inner);
      return iterator;
    },
    result: () => result,
  } as unknown as AssistantMessageEventStream;
}

function failureResult(input: {
  final?: AssistantMessage;
  thrown?: unknown;
  response?: ProviderResponse;
  stream?: AssistantMessageEventStream;
  iterator?: AsyncIterator<AssistantMessageEvent>;
  buffered: AssistantMessageEvent[];
  nowMs: () => number;
  retryAllErrors?: boolean;
}): PreflightResult {
  const normalized = normalizeLLMError({
    ...(input.thrown !== undefined ? { raw: input.thrown } : {}),
    ...(input.final?.stopReason ? { finishReason: input.final.stopReason } : {}),
    ...(input.final?.errorMessage ? { errorMessage: input.final.errorMessage } : {}),
    ...(input.response ? { statusCode: input.response.status } : {}),
    explicitAbort: input.final?.stopReason === 'aborted',
  });
  // BYOK retries every pre-output failure because custom gateways report errors
  // inconsistently, but a model safety refusal is deterministic: retrying the
  // same request only repeats (and may re-bill) the decline.
  const decision =
    input.retryAllErrors &&
    !normalized.facts.explicitAbort &&
    !normalized.facts.signals.has('refusal')
      ? { retryable: true, reason: 'network' as const }
      : toLLMRetryDecision(normalized);
  if (!decision.retryable) {
    return {
      kind: 'terminal',
      failure: {
        normalized,
        error: publicRetryError(normalized, decision.reason),
        stream: input.stream,
        iterator: input.iterator,
        buffered: input.buffered,
        thrown: input.thrown,
      },
    };
  }
  return {
    kind: 'failure',
    failure: {
      normalized,
      error: publicRetryError(normalized, decision.reason),
      retryReason: decision.reason,
      stream: input.stream,
      iterator: input.iterator,
      buffered: input.buffered,
      thrown: input.thrown,
      retryAfterMs: parseRetryAfterMs(input.response?.headers, input.nowMs()),
    },
  };
}

function isAbortFailure(failure: RetryFailure): boolean {
  return failure.normalized.facts.explicitAbort;
}

function discardAttempt(failure: RetryFailure): void {
  try {
    const closed = failure.iterator?.return?.();
    void Promise.resolve(closed).catch(() => undefined);
  } catch {
    // Best-effort provider cleanup must not block a framework retry.
  }
}

function terminalFailure(failure: RetryFailure): AssistantMessageEventStream {
  if (!failure.stream) throw asError(failure.thrown);
  if (failure.thrown !== undefined) {
    return throwingReplayStream(failure.buffered, failure.thrown);
  }
  if (!failure.iterator) throw new Error('LLM failure stream iterator is unavailable');
  return replayStream(failure.stream, failure.iterator, failure.buffered);
}

function observeTerminalFailure(
  failure: RetryFailure,
  context: CallSettlementContext,
): AssistantMessageEventStream {
  try {
    return observeCallSettlement(terminalFailure(failure), context);
  } catch (error) {
    notifyCallSettled(context, error);
    throw error;
  }
}

function observeCallSettlement(
  source: AssistantMessageEventStream,
  context: CallSettlementContext,
): AssistantMessageEventStream {
  if (!context.input.onCallSettled) return source;
  let settled = false;
  const settle = (final: AssistantMessage | undefined, error?: unknown): void => {
    if (settled) return;
    settled = true;
    notifyCallSettled(context, error, final);
  };
  const result = Promise.resolve()
    .then(() => source.result())
    .then(
      (final) => {
        settle(final);
        return final;
      },
      (error) => {
        settle(undefined, error);
        throw error;
      },
    );
  void result.catch(() => undefined);

  return {
    [Symbol.asyncIterator]() {
      let inner: AsyncIterator<AssistantMessageEvent>;
      try {
        inner = source[Symbol.asyncIterator]();
      } catch (error) {
        settle(undefined, error);
        throw error;
      }
      const iterator: AsyncIterator<AssistantMessageEvent> = {
        async next(...args) {
          try {
            return await inner.next(...args);
          } catch (error) {
            settle(undefined, error);
            throw error;
          }
        },
      };
      if (inner.return) iterator.return = inner.return.bind(inner);
      if (inner.throw) iterator.throw = inner.throw.bind(inner);
      return iterator;
    },
    result: () => result,
  } as unknown as AssistantMessageEventStream;
}

function notifyCallSettled(
  context: CallSettlementContext,
  thrown?: unknown,
  final?: AssistantMessage,
): void {
  const observer = context.input.onCallSettled;
  if (!observer) return;
  const finalOutcome = classifyCallOutcome(final, thrown, context.signal?.aborted === true);
  const usage = finalOutcome.outcome === 'success' ? callUsage(final) : undefined;
  const event: LLMCallSettledEvent = {
    sessionId: context.input.sessionId,
    turnId: context.input.turnId,
    callId: context.callId,
    scope: context.input.scope,
    provider: String(context.model.provider),
    model: String(context.model.id),
    final: finalOutcome,
    retryTriggered: context.state.retryTriggered,
    ...(context.state.retryReason ? { retryReason: context.state.retryReason } : {}),
    requestAttempts: context.state.requestAttempts,
    ...(finalOutcome.outcome === 'success' && final
      ? { expectedTools: expectedToolsFrom(final) }
      : {}),
    ...(usage ? { usage } : {}),
  };
  try {
    const observed = observer(event);
    void Promise.resolve(observed).catch(() => undefined);
  } catch {
    // Final-call observability must never change provider-call behavior.
  }
}

function expectedToolsFrom(final: AssistantMessage): readonly LLMExpectedToolIdentity[] {
  return final.content.flatMap((block) =>
    block.type === 'toolCall' ? [{ toolCallId: block.id, toolName: block.name }] : [],
  );
}

function classifyCallOutcome(
  final: AssistantMessage | undefined,
  thrown: unknown,
  explicitAbort: boolean,
): { outcome: LLMCallOutcome; errorKind: LLMCallErrorKind } {
  if (thrown === undefined && final?.stopReason !== 'error' && final?.stopReason !== 'aborted') {
    return { outcome: 'success', errorKind: 'none' };
  }
  const normalized = normalizeLLMError({
    ...(thrown !== undefined ? { raw: thrown } : {}),
    ...(final?.stopReason ? { finishReason: final.stopReason } : {}),
    ...(final?.errorMessage ? { errorMessage: final.errorMessage } : {}),
    explicitAbort: explicitAbort || final?.stopReason === 'aborted',
  });
  const errorKind = toLLMMetricErrorKind(normalized.facts);
  return { outcome: errorKind === 'abort' ? 'abort' : 'error', errorKind };
}

/**
 * Project the provider usage of a successful call into the four raw buckets.
 *
 * Provider payloads are untrusted input, so a missing or non-finite bucket is
 * normalised to zero rather than propagated as NaN. Absent usage yields
 * `undefined` so observers can distinguish "no usage reported" from "zero
 * tokens used".
 */
function callUsage(final: AssistantMessage | undefined): LLMCallUsage | undefined {
  const usage = final?.usage;
  if (!usage) return undefined;
  return {
    input: finiteTokens(usage.input),
    output: finiteTokens(usage.output),
    cacheRead: finiteTokens(usage.cacheRead),
    cacheWrite: finiteTokens(usage.cacheWrite),
  };
}

function readProviderUsage(final: AssistantMessage | undefined): {
  usage?: LLMCallUsage;
  complete: boolean;
} {
  try {
    const usage = final?.usage;
    if (!usage) return { complete: false };
    const input = readTokenBucket(usage.input);
    const output = readTokenBucket(usage.output);
    const cacheRead = readTokenBucket(usage.cacheRead);
    const cacheWrite = readTokenBucket(usage.cacheWrite);
    return {
      usage: {
        input: input.value,
        output: output.value,
        cacheRead: cacheRead.value,
        cacheWrite: cacheWrite.value,
      },
      complete: input.valid && output.valid && cacheRead.valid && cacheWrite.valid,
    };
  } catch {
    return { complete: false };
  }
}

function readTokenBucket(value: unknown): { value: number; valid: boolean } {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? { value, valid: true }
    : { value: 0, valid: false };
}

function finiteTokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function replayStream(
  source: AssistantMessageEventStream,
  iterator: AsyncIterator<AssistantMessageEvent>,
  buffered: readonly AssistantMessageEvent[],
): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      let index = 0;
      while (index < buffered.length) {
        const event = buffered[index];
        index += 1;
        if (event !== undefined) yield event;
      }
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    },
    result: () => source.result(),
  } as unknown as AssistantMessageEventStream;
}

function throwingReplayStream(
  buffered: readonly AssistantMessageEvent[],
  thrown: unknown,
): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      let index = 0;
      while (index < buffered.length) {
        const event = buffered[index];
        index += 1;
        if (event !== undefined) yield event;
      }
      throw thrown;
    },
    async result() {
      throw thrown;
    },
  } as unknown as AssistantMessageEventStream;
}

function commitsOutput(event: AssistantMessageEvent): boolean {
  if (
    event.type === 'text_delta' ||
    event.type === 'thinking_delta' ||
    event.type === 'toolcall_delta'
  ) {
    return event.delta.length > 0;
  }
  if (event.type === 'text_end' || event.type === 'thinking_end') return event.content.length > 0;
  if (event.type === 'toolcall_end') return true;
  return 'partial' in event && hasCommittedContent(event.partial);
}

function hasCommittedContent(message: AssistantMessage): boolean {
  return message.content.some((block) => {
    if (block.type === 'text') return block.text.length > 0;
    if (block.type === 'thinking') return block.thinking.length > 0;
    return block.type === 'toolCall';
  });
}

function isFailureMessage(message: AssistantMessage): boolean {
  return message.stopReason === 'error' || message.stopReason === 'aborted';
}

function resolvePolicy(policy: Partial<LLMRetryPolicy> | undefined): LLMRetryPolicy {
  return { ...DEFAULT_LLM_RETRY_POLICY, ...(policy ?? {}) };
}

function retryDelayMs(
  retryAfterMs: number | undefined,
  retryAttempt: number,
  policy: LLMRetryPolicy,
  random: () => number,
): number {
  if (retryAfterMs !== undefined) return Math.min(policy.maxDelayMs, Math.max(0, retryAfterMs));
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retryAttempt - 1));
  return Math.floor(exponential / 2 + (clampRandom(random()) * exponential) / 2);
}

function clampRandom(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function parseRetryAfterMs(
  headers: Record<string, string> | undefined,
  nowMs: number,
): number | undefined {
  if (!headers) return undefined;
  const entries = Object.entries(headers);
  const retryAfterMs = entries.find(([name]) => name.toLowerCase() === 'retry-after-ms')?.[1];
  const parsedMillis = retryAfterMs === undefined ? undefined : Number(retryAfterMs);
  if (parsedMillis !== undefined && Number.isFinite(parsedMillis)) return Math.max(0, parsedMillis);
  const retryAfter = entries.find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  if (!retryAfter) return undefined;
  const parsedSeconds = Number(retryAfter);
  if (Number.isFinite(parsedSeconds)) return Math.max(0, parsedSeconds * 1_000);
  const parsedDate = Date.parse(retryAfter);
  return Number.isNaN(parsedDate) ? undefined : Math.max(0, parsedDate - nowMs);
}

function publicRetryError(
  normalized: NormalizedLLMError,
  reason: LLMMetricErrorKind,
): LLMRetryError {
  const protocol = toLLMProtocolClassification(normalized);
  return {
    reason,
    ...(protocol ? { code: protocol.code } : {}),
    message: PUBLIC_ERROR_MESSAGES[reason],
  };
}

async function notify(observer: LLMRetryOptions['observer'], event: LLMRetryEvent): Promise<void> {
  try {
    await observer?.(event);
  } catch {
    // Observability must never change provider-call correctness.
  }
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal) reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('LLM retry cancelled');
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value ?? 'LLM request failed'));
}

function defaultCallId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `llm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}
