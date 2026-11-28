/**
 * Stateless helpers behind `withLLMRetry`: the settled call event, provider
 * usage projection, empty reply detection, stream replay, backoff and
 * Retry-After parsing, the per-call deadline, and the offline / resume-aware
 * sleep. Kept apart so the retry loop stays readable.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import {
  isLLMTransportRetryReason,
  normalizeLLMError,
  toLLMFailureErrorKind,
  toLLMMetricErrorKind,
  toLLMProtocolClassification,
  type LLMMetricErrorKind,
  type NormalizedLLMError,
} from '@mavis/shared/llm-error-classifier';
import { isLocalResourceErrorKind } from '@mavis/shared/local-resource-errors';
import { parseByokErrorAttribution } from '@mavis/shared/byok-error-attribution';

import type {
  CallSettlementContext,
  LLMCallErrorKind,
  LLMCallOutcome,
  LLMCallSettledEvent,
  LLMCallUsage,
  LLMExpectedToolIdentity,
  LLMNetworkRecovery,
  LLMRequestSettledEvent,
  LLMRetryError,
  LLMRetryOptions,
  LLMRetryPolicy,
} from './llm-retry.js';
import { readLLMStreamFailureKind } from './llm-stream-failure.js';

export const PUBLIC_ERROR_MESSAGES: Record<LLMMetricErrorKind, string> = {
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
  // Same words as `unknown`: the reason only splits the metrics, not what users read.
  reply_loop: 'LLM request failed',
  unknown: 'LLM request failed',
  length: 'LLM response reached the length limit',
};

/**
 * The custom provider a BYOK-attributed failure names. The host's BYOK error
 * attribution writes it into the failure text whatever `model.provider` an
 * OAuth route resolved to, and the shared parser reads it the same way the
 * final error does, so the retry event names the same provider.
 */
function byokCustomProviderId(message: string | undefined): string | undefined {
  const providerId = parseByokErrorAttribution(message)?.errorProviderId;
  return providerId?.startsWith('custom_provider:') ? providerId : undefined;
}

/**
 * The fixed public error for a failed attempt: no request content or provider
 * text, only the user's own custom provider id when the failure names one.
 */
export function publicRetryError(
  normalized: NormalizedLLMError,
  reason: LLMMetricErrorKind,
): LLMRetryError {
  const protocol = toLLMProtocolClassification(normalized);
  const providerId = byokCustomProviderId(normalized.sanitizedMessage);
  return {
    reason,
    ...(protocol ? { code: protocol.code } : {}),
    message: PUBLIC_ERROR_MESSAGES[reason],
    ...(providerId ? { providerId } : {}),
  };
}

/** Ask the inner stream to stop without waiting on one that may never settle. */
export function releaseIterator(iterator: AsyncIterator<AssistantMessageEvent>): void {
  void Promise.resolve()
    .then(() => iterator.return?.())
    .catch(() => undefined);
}

function expectedToolsFrom(final: AssistantMessage): readonly LLMExpectedToolIdentity[] {
  return final.content.flatMap((block) =>
    block.type === 'toolCall' ? [{ toolCallId: block.id, toolName: block.name }] : [],
  );
}

export function classifyCallOutcome(
  final: AssistantMessage | undefined,
  thrown: unknown,
  explicitAbort: boolean,
  providerError?: unknown,
): {
  outcome: LLMCallOutcome;
  errorKind: LLMCallErrorKind;
  /** The kind without local resources, as the call metrics shipped before them. */
  metricKind: LLMMetricErrorKind | 'none';
} {
  if (thrown === undefined && final?.stopReason !== 'error' && final?.stopReason !== 'aborted') {
    return { outcome: 'success', errorKind: 'none', metricKind: 'none' };
  }
  const normalized = normalizeLLMError({
    ...(thrown !== undefined ? { raw: thrown } : {}),
    ...(providerError !== undefined ? { providerError } : {}),
    ...(final?.stopReason ? { finishReason: final.stopReason } : {}),
    ...(final?.errorMessage ? { errorMessage: final.errorMessage } : {}),
    explicitAbort: explicitAbort || final?.stopReason === 'aborted',
  });
  const errorKind = toLLMFailureErrorKind(normalized.facts);
  // A loop this layer cut has no provider error, and its words quote the reply;
  // the marker on the message names it. An abort stays an abort.
  if (errorKind !== 'abort' && readLLMStreamFailureKind({ final, thrown }) === 'llm_reply_loop') {
    return { outcome: 'error', errorKind: 'reply_loop', metricKind: 'reply_loop' };
  }
  return {
    outcome: errorKind === 'abort' ? 'abort' : 'error',
    errorKind,
    metricKind: toLLMMetricErrorKind(normalized.facts),
  };
}

/**
 * The event a settled logical call reports. A host verdict replaces the
 * classified failure, except when the call ran out of a local resource: that is
 * the cause and the verdict only names its symptom, so the verdict goes to
 * `legacyFinal` for hosts without registry metrics.
 */
export function callSettledEvent(
  context: CallSettlementContext,
  thrown: unknown,
  final: AssistantMessage | undefined,
): LLMCallSettledEvent {
  const aborted = context.signal?.aborted === true;
  const classified = classifyCallOutcome(final, thrown, aborted, context.state.providerError);
  let finalOutcome: LLMCallSettledEvent['final'] = {
    outcome: classified.outcome,
    errorKind: classified.errorKind,
  };
  let legacyFinal: NonNullable<LLMCallSettledEvent['legacyFinal']> = {
    outcome: classified.outcome,
    errorKind: classified.metricKind,
  };
  const verdict = context.state.terminalErrorKind;
  if (classified.outcome !== 'success' && !aborted && verdict) {
    legacyFinal = { outcome: verdict === 'abort' ? 'abort' : 'error', errorKind: verdict };
    if (!isLocalResourceErrorKind(finalOutcome.errorKind)) finalOutcome = legacyFinal;
  }
  const usage = finalOutcome.outcome === 'success' ? callUsage(final) : undefined;
  return {
    sessionId: context.input.sessionId,
    turnId: context.input.turnId,
    callId: context.callId,
    scope: context.input.scope,
    provider: String(context.model.provider),
    model: String(context.model.id),
    final: finalOutcome,
    ...(isLocalResourceErrorKind(finalOutcome.errorKind) ? { legacyFinal } : {}),
    retryTriggered: context.state.retryTriggered,
    ...(context.state.retryReason ? { retryReason: context.state.retryReason } : {}),
    requestAttempts: context.state.requestAttempts,
    ...(finalOutcome.outcome === 'success' && final
      ? { expectedTools: expectedToolsFrom(final) }
      : {}),
    ...(usage ? { usage } : {}),
  };
}

/** Keep the provider error of the current attempt while passing it to the caller's observer. */
export function captureProviderError(
  options: Parameters<StreamFn>[2],
  state: { providerError?: unknown },
): Parameters<StreamFn>[2] {
  const callerOnProviderError = options?.onProviderError;
  return {
    ...(options ?? {}),
    onProviderError(error, errorModel) {
      state.providerError = error;
      callerOnProviderError?.(error, errorModel);
    },
  };
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

export function readProviderUsage(final: AssistantMessage | undefined): {
  usage?: LLMCallUsage;
  reportedUsage?: LLMRequestSettledEvent['reportedUsage'];
  complete: boolean;
} {
  try {
    const usage = final?.usage;
    if (!usage) return { complete: false };
    const input = readTokenBucket(usage.input);
    const output = readTokenBucket(usage.output);
    const cacheRead = readTokenBucket(usage.cacheRead);
    const cacheWrite = readTokenBucket(usage.cacheWrite);
    const totalTokens = readTokenBucket(usage.totalTokens);
    return {
      reportedUsage: {
        ...(input.valid ? { input: input.value } : {}),
        ...(output.valid ? { output: output.value } : {}),
        ...(cacheRead.valid ? { cacheRead: cacheRead.value } : {}),
        ...(cacheWrite.valid ? { cacheWrite: cacheWrite.value } : {}),
        ...(totalTokens.valid ? { totalTokens: totalTokens.value } : {}),
      },
      usage: {
        input: input.value,
        output: output.value,
        cacheRead: cacheRead.value,
        cacheWrite: cacheWrite.value,
      },
      // A stream that ended in an error or abort reports only what arrived
      // before it stopped (e.g. the input counted at message start), so its
      // usage is partial even when every bucket is a valid number.
      complete:
        final?.stopReason !== 'error' &&
        final?.stopReason !== 'aborted' &&
        input.valid &&
        output.valid &&
        cacheRead.valid &&
        cacheWrite.valid,
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

export function finiteTokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** APIs whose every whole reply counts its tokens. */
const REPLIES_COUNTED = new Set([
  'anthropic-messages',
  'openai-responses',
  'openai-codex-responses',
]);

/**
 * A reply that ended `stop` with no text and no tool call: reasoning alone
 * says nothing the agent can act on. A Messages API empty
 * `end_turn` that counted its prompt is the model's answer, and stays one. Chat Completions, which most subscription transports
 * (Gemini's among them) are translated to, fails on any empty stop.
 */
export function isEmptyReply(final: AssistantMessage | undefined): boolean {
  // A custom stream may end with a malformed message: never read that as an empty reply.
  if (!final || typeof final !== 'object' || !Array.isArray(final.content)) return false;
  if (final.stopReason !== 'stop') return false;
  const content = final.content;
  if (
    content.some(
      (block) =>
        block.type === 'toolCall' || (block.type === 'text' && block.text.trim().length > 0),
    )
  )
    return false;
  // Messages and Responses count every whole reply; one that counted its tokens and said
  // nothing is the model's answer (a turn ending after a tool result), not a lost reply.
  if (REPLIES_COUNTED.has(String(final.api)) && countedUsage(final)) return false;
  return true;
}

function countedUsage(final: AssistantMessage): boolean {
  const usage = final.usage;
  if (!usage) return false;
  return (
    finiteTokens(usage.input) +
      finiteTokens(usage.output) +
      finiteTokens(usage.cacheRead) +
      finiteTokens(usage.cacheWrite) >
    0
  );
}

export function replayStream(
  source: AssistantMessageEventStream,
  iterator: AsyncIterator<AssistantMessageEvent>,
  buffered: readonly AssistantMessageEvent[],
  extra: {
    /** A read already started when the stream was committed. */
    readonly pending?: Promise<IteratorResult<AssistantMessageEvent>>;
    /** Reads each event that comes after `buffered`; a message it returns cuts the stream there. */
    readonly guard?: (event: AssistantMessageEvent) => AssistantMessage | undefined;
    readonly stop?: () => void;
  } = {},
): AssistantMessageEventStream {
  if (!extra.guard && !extra.pending) {
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
  return guardedReplay(source, iterator, buffered, extra);
}

/**
 * Replay through one reader that both the iterator and `result()` drive, so a
 * loop cut decides the result even for a consumer (or a settlement observer)
 * that asks for the result before, or instead of, reading the events. Events
 * are queued until read; an early `return()` stops the reader and releases the
 * provider stream.
 */
function guardedReplay(
  source: AssistantMessageEventStream,
  iterator: AsyncIterator<AssistantMessageEvent>,
  buffered: readonly AssistantMessageEvent[],
  extra: {
    readonly pending?: Promise<IteratorResult<AssistantMessageEvent>>;
    readonly guard?: (event: AssistantMessageEvent) => AssistantMessage | undefined;
    readonly stop?: () => void;
  },
): AssistantMessageEventStream {
  const queue: AssistantMessageEvent[] = [...buffered];
  let finished = false;
  let cancelled = false;
  let failure: { readonly error: unknown } | undefined;
  let cut: AssistantMessage | undefined;
  let wake: (() => void) | undefined;
  let pumping: Promise<void> | undefined;
  const wakeReader = (): void => {
    const waiter = wake;
    wake = undefined;
    waiter?.();
  };
  const pump = (): Promise<void> => {
    pumping ??= (async () => {
      try {
        let pending = extra.pending;
        for (;;) {
          if (cancelled) return;
          const next = pending ? await pending : await iterator.next();
          pending = undefined;
          if (cancelled || next.done) return;
          const final = extra.guard?.(next.value);
          if (final) {
            cut = final;
            extra.stop?.();
            queue.push({ type: 'error', reason: 'error', error: final });
            return;
          }
          queue.push(next.value);
          wakeReader();
        }
      } catch (error) {
        failure = { error };
      } finally {
        finished = true;
        wakeReader();
      }
    })();
    return pumping;
  };
  return {
    async *[Symbol.asyncIterator]() {
      void pump();
      try {
        for (;;) {
          const event = queue.shift();
          if (event !== undefined) {
            yield event;
            continue;
          }
          if (finished) {
            if (failure) throw failure.error;
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        if (!finished) {
          cancelled = true;
          releaseIterator(iterator);
        }
      }
    },
    async result() {
      await pump();
      return cut ?? source.result();
    },
  } as unknown as AssistantMessageEventStream;
}

export function throwingReplayStream(
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

export function commitsOutput(event: AssistantMessageEvent, holdReasoning = false): boolean {
  if (event.type === 'text_delta' || event.type === 'toolcall_delta') return event.delta.length > 0;
  if (event.type === 'thinking_delta') return !holdReasoning && event.delta.length > 0;
  if (event.type === 'text_end') return event.content.length > 0;
  if (event.type === 'thinking_end') return !holdReasoning && event.content.length > 0;
  if (event.type === 'toolcall_end') return true;
  return 'partial' in event && hasCommittedContent(event.partial, holdReasoning);
}

function hasCommittedContent(message: AssistantMessage, holdReasoning: boolean): boolean {
  return message.content.some((block) => {
    if (block.type === 'text') return block.text.length > 0;
    if (block.type === 'thinking') return !holdReasoning && block.thinking.length > 0;
    return block.type === 'toolCall';
  });
}

export function isFailureMessage(message: AssistantMessage): boolean {
  return message.stopReason === 'error' || message.stopReason === 'aborted';
}

export function retryDelayMs(
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

export function parseRetryAfterMs(
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

/**
 * The wait a failed attempt names: the provider response's `Retry-After`, or,
 * when the response never reached us, the one on the thrown HTTP error.
 *
 * Why the error too: SDKs throw on an error status before the provider can
 * report the response (`onResponse`), so a 429/529 with `Retry-After` only
 * carries the header on the error the provider hands to `onProviderError`.
 */
export function failureRetryAfterMs(
  responseHeaders: Record<string, string> | undefined,
  errors: readonly unknown[],
  nowMs: number,
): number | undefined {
  const fromResponse = parseRetryAfterMs(responseHeaders, nowMs);
  if (fromResponse !== undefined) return fromResponse;
  for (const error of errors) {
    const fromError = parseRetryAfterMs(errorHeaders(error), nowMs);
    if (fromError !== undefined) return fromError;
  }
  return undefined;
}

/** An HTTP error's response headers, as a Fetch `Headers` or a plain record. */
function errorHeaders(error: unknown): Record<string, string> | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const headers: unknown = (error as { headers?: unknown }).headers;
  if (typeof headers !== 'object' || headers === null) return undefined;
  const record: Record<string, string> = {};
  if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    (headers as { forEach(cb: (value: unknown, name: unknown) => void): void }).forEach(
      (value, name) => {
        if (typeof name === 'string' && typeof value === 'string') record[name] = value;
      },
    );
  } else {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string') record[name] = value;
    }
  }
  return record;
}

/**
 * Polls of an offline wait start from at most 1 s: they only probe whether the
 * network is back (an online hint wakes them early anyway), so the longer
 * retry base would only delay the first request after the network returns. A
 * caller's shorter base still applies.
 */
const OFFLINE_POLL_BASE_DELAY_MS = 1_000;

export function offlinePollPolicy(policy: LLMRetryPolicy): LLMRetryPolicy {
  return { ...policy, baseDelayMs: Math.min(policy.baseDelayMs, OFFLINE_POLL_BASE_DELAY_MS) };
}

export interface RetryBudget {
  readonly signal: AbortSignal;
  expired(): boolean;
  /** Moves the deadline (undefined: none); an expired budget stays expired. */
  arm(deadlineAt: number | undefined): void;
  stop(): void;
}

export function retryTimeout(): Error {
  const error = new Error('LLM request timed out');
  error.name = 'TimeoutError';
  return error;
}

export function createRetryBudget(callerSignal: AbortSignal, deadlineAt: number): RetryBudget {
  const controller = new AbortController();
  let expired = false;
  const expire = () => {
    expired = true;
    controller.abort(retryTimeout());
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (at: number | undefined): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (expired || at === undefined) return;
    const delay = Math.max(0, at - Date.now());
    if (delay === 0) return expire();
    timer = setTimeout(expire, delay);
    timer.unref?.();
  };
  arm(deadlineAt);
  return {
    // Clearing the deadline must never detach subsequent user cancellation.
    signal: AbortSignal.any([callerSignal, controller.signal]),
    expired: () => expired,
    arm,
    stop: () => arm(undefined),
  };
}

/**
 * Only transport failures can mean the device is offline, and the host probe
 * decides. A failing probe counts as online, so the charged budget still ends
 * the call.
 */
export async function isDeviceOffline(
  recovery: LLMNetworkRecovery,
  baseUrl: string,
  retryReason: LLMMetricErrorKind,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!isLLMTransportRetryReason(retryReason)) return false;
  if (signal?.aborted) return false;
  try {
    return await recovery.isOffline(baseUrl, signal);
  } catch {
    return false;
  }
}

/**
 * Sleep like `sleep` through an offline wait. The host's next resume hint ends
 * it early and resolves true: the device slept, so the wait opens a fresh
 * offline window. Its next online hint ends it early and resolves false: the
 * network is back, so the caller retries now within the same window.
 */
export async function sleepUntilResume(
  sleep: NonNullable<LLMRetryOptions['sleep']>,
  delayMs: number,
  signal: AbortSignal | undefined,
  recovery: LLMNetworkRecovery | undefined,
): Promise<boolean> {
  if (!recovery) {
    await sleep(delayMs, signal);
    return false;
  }
  const resume = new AbortController();
  const online = new AbortController();
  const unsubscribeResume = recovery.onResume(() => resume.abort());
  const unsubscribeOnline = recovery.onOnline(() => online.abort());
  const hints = [resume.signal, online.signal];
  const linked = AbortSignal.any(signal ? [signal, ...hints] : hints);
  try {
    await sleep(delayMs, linked);
    return false;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (resume.signal.aborted) return true;
    if (online.signal.aborted) return false;
    throw error;
  } finally {
    unsubscribeResume();
    unsubscribeOnline();
  }
}

/**
 * Notes a system wake inside a charged retry window, so the window restarts
 * after it: time asleep is not time spent retrying. Resume hints are heard only
 * once armed; `mark` records a wake noticed some other way, such as a backoff
 * that overran its delay.
 */
export interface SystemWakeLatch {
  arm(): void;
  mark(): void;
  /** Whether a wake was noticed since the last call; clears it. */
  take(): boolean;
  dispose(): void;
}

export function createSystemWakeLatch(recovery: LLMNetworkRecovery | undefined): SystemWakeLatch {
  let woke = false;
  let unsubscribe: (() => void) | undefined;
  return {
    arm() {
      if (unsubscribe || !recovery) return;
      try {
        unsubscribe = recovery.onResume(() => {
          woke = true;
        });
      } catch {
        // A host without resume hints still has the overrun check.
      }
    },
    mark() {
      woke = true;
    },
    take() {
      const noticed = woke;
      woke = false;
      return noticed;
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

export function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
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

/** Read the live abort state; a narrowed inline read would go stale across awaits. */
export function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('LLM retry cancelled');
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value ?? 'LLM request failed'));
}

export function defaultCallId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `llm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}

/**
 * After a refusal a provider may hold the caller off for a while and answer
 * every request with a 429 that names the wait, e.g.
 * `429 caller user is cooling down after refusal, retry after 16s`. A retry
 * sent before then is refused the same way, so automatic retries wait it out.
 */
const REFUSAL_COOLDOWN_RE =
  /cooling\s+down\s+after\s+refusal\b[\s\S]{0,80}?retry\s+after\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b/iu;

/** The wait a refusal cool-down names in milliseconds; undefined when `texts` name none. */
export function refusalCooldownMs(...texts: readonly (string | undefined)[]): number | undefined {
  for (const text of texts) {
    const seconds = text ? Number(REFUSAL_COOLDOWN_RE.exec(text)?.[1]) : Number.NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  }
  return undefined;
}

/**
 * The refusal cool-down a failure names in its own words or the provider's, as the
 * retry failure's `cooldownMs`: retries wait it out.
 */
export function refusalWaitFields(...sources: readonly unknown[]): { cooldownMs?: number } {
  const texts = sources.map((source) =>
    source instanceof Error ? source.message : typeof source === 'string' ? source : undefined,
  );
  const cooldownMs = refusalCooldownMs(...texts);
  return cooldownMs === undefined ? {} : { cooldownMs };
}
