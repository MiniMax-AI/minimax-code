import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type Api,
} from '@earendil-works/pi-ai';
import {
  LLM_FIRST_EVENT_TIMEOUT_MS,
  LLM_FIRST_EVENT_TIMEOUT_ENV,
  LLM_STREAM_IDLE_TIMEOUT_ENV,
  LLM_STREAM_IDLE_TIMEOUT_MS,
} from './defaults.js';

/**
 * Per-attempt watchdog for provider streams.
 *
 * `firstEventTimeoutMs` bounds the wait for the first stream event. The
 * built-in providers emit `start` only after the HTTP response headers
 * arrive, so this is effectively a first-byte timeout: a request the provider
 * accepted but never answers fails here and is retried instead of waiting for
 * the 20 min outer request bound (or a custom fetch's own transport default).
 *
 * `idleTimeoutMs` bounds the gap between consecutive events after the first
 * one, so a stream that stalls mid-response is also failed.
 *
 * `0` disables the corresponding timer.
 */
export interface LLMStreamTimeouts {
  readonly firstEventTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

export interface LLMStreamTimeoutConfig {
  readonly firstEventTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
}

/** Marker included in every synthesized timeout message; matches the shared timeout classifier. */
export const LLM_STREAM_TIMEOUT_MESSAGE_PREFIX = 'LLM request timed out';

/**
 * Resolve effective timeouts. Precedence: explicit host config, then the
 * environment override, then the built-in default. Invalid values (negative,
 * non-integer, non-numeric) fall through to the next source.
 */
export function resolveLLMStreamTimeouts(
  config: LLMStreamTimeoutConfig = {},
  env: Readonly<Record<string, string | undefined>> = readProcessEnv(),
): LLMStreamTimeouts {
  return {
    firstEventTimeoutMs:
      validTimeout(config.firstEventTimeoutMs) ??
      parseTimeout(env[LLM_FIRST_EVENT_TIMEOUT_ENV]) ??
      LLM_FIRST_EVENT_TIMEOUT_MS,
    idleTimeoutMs:
      validTimeout(config.streamIdleTimeoutMs) ??
      parseTimeout(env[LLM_STREAM_IDLE_TIMEOUT_ENV]) ??
      LLM_STREAM_IDLE_TIMEOUT_MS,
  };
}

/**
 * Wrap a StreamFn so each invocation (each physical request, including every
 * retry attempt made by `withLLMRetry`) is guarded by the watchdog.
 *
 * On timeout the inner request is aborted through a linked signal and the
 * returned stream ends with a terminal `error` event whose stop reason is
 * `error` (not `aborted`), so the retry layer treats it as a retryable
 * transport timeout rather than a user cancellation. A caller abort is passed
 * through unchanged and never reported as a timeout.
 */
export function withLLMStreamTimeouts(
  inner: StreamFn | undefined,
  timeouts: LLMStreamTimeouts,
): StreamFn {
  const base = inner ?? streamSimple;
  if (timeouts.firstEventTimeoutMs <= 0 && timeouts.idleTimeoutMs <= 0) return base;
  return ((model, context, options) => {
    const callerSignal = options?.signal;
    const controller = new AbortController();
    const out = createAssistantMessageEventStream();
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastPartial: AssistantMessage | undefined;
    // Resolves when the wrapper is finished for any reason, so the read loop
    // below stops even if the inner stream ignores the abort and never yields
    // or settles again.
    let signalStopped!: () => void;
    const stopped = new Promise<typeof STOPPED>((resolve) => {
      signalStopped = () => resolve(STOPPED);
    });

    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const onCallerAbort = () => {
      clearTimer();
      controller.abort(callerSignal?.reason);
    };
    const finish = () => {
      finished = true;
      clearTimer();
      callerSignal?.removeEventListener('abort', onCallerAbort);
      signalStopped();
    };
    const arm = (ms: number, phase: 'first' | 'idle') => {
      clearTimer();
      if (ms <= 0 || finished) return;
      timer = setTimeout(() => {
        if (finished || callerSignal?.aborted) return;
        finish();
        const message = timeoutMessage(phase, ms);
        controller.abort(new LLMStreamTimeoutError(message));
        const error: AssistantMessage = {
          ...snapshot(lastPartial, model),
          stopReason: 'error',
          errorMessage: message,
        };
        out.push({ type: 'error', reason: 'error', error });
        out.end();
      }, ms);
      // Never keep the process alive only for the watchdog.
      (timer as { unref?: () => void }).unref?.();
    };

    if (callerSignal?.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
      arm(timeouts.firstEventTimeoutMs, 'first');
    }

    void (async () => {
      try {
        const opened = await Promise.race([
          Promise.resolve(base(model, context, { ...(options ?? {}), signal: controller.signal })),
          stopped,
        ]);
        if (opened === STOPPED) return;
        const stream: AssistantMessageEventStream = opened;
        const iterator = stream[Symbol.asyncIterator]();
        for (;;) {
          const next = await Promise.race([iterator.next(), stopped]);
          if (next === STOPPED || finished) {
            releaseIterator(iterator);
            return;
          }
          if (next.done) break;
          const event = next.value;
          const partial = partialOf(event);
          if (partial) lastPartial = partial;
          if (event.type === 'done' || event.type === 'error') {
            finish();
            out.push(event);
            out.end();
            return;
          }
          arm(timeouts.idleTimeoutMs, 'idle');
          out.push(event);
        }
        if (!finished) {
          // Inner stream ended without a terminal event; mirror its result.
          finish();
          const final = await stream.result();
          out.push(
            final.stopReason === 'error' || final.stopReason === 'aborted'
              ? { type: 'error', reason: final.stopReason, error: final }
              : { type: 'done', reason: final.stopReason, message: final },
          );
          out.end();
        }
      } catch (error) {
        if (finished) return;
        finish();
        const aborted = callerSignal?.aborted === true;
        out.push({
          type: 'error',
          reason: aborted ? 'aborted' : 'error',
          error: {
            ...snapshot(lastPartial, model),
            stopReason: aborted ? 'aborted' : 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
        out.end();
      }
    })();

    return out;
  }) as StreamFn;
}

const STOPPED: unique symbol = Symbol('llm-stream-timeout-stopped');

/** Ask the inner stream to stop without waiting on one that may never settle. */
function releaseIterator(iterator: AsyncIterator<AssistantMessageEvent>): void {
  void Promise.resolve()
    .then(() => iterator.return?.())
    .catch(() => undefined);
}

export class LLMStreamTimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

function timeoutMessage(phase: 'first' | 'idle', ms: number): string {
  return phase === 'first'
    ? `${LLM_STREAM_TIMEOUT_MESSAGE_PREFIX}: no response from the provider within ${ms}ms. ` +
        `Raise it with ${LLM_FIRST_EVENT_TIMEOUT_ENV} (milliseconds, 0 disables) or the host's per-model firstEventTimeoutMs.`
    : `${LLM_STREAM_TIMEOUT_MESSAGE_PREFIX}: the provider stream was idle for ${ms}ms. ` +
        `Raise it with ${LLM_STREAM_IDLE_TIMEOUT_ENV} (milliseconds, 0 disables) or the host's per-model streamIdleTimeoutMs.`;
}

function partialOf(event: AssistantMessageEvent): AssistantMessage | undefined {
  if (event.type === 'done') return event.message;
  if (event.type === 'error') return event.error;
  return event.partial;
}

/** Detach from the provider's mutable partial so a late abort cannot rewrite the reported message. */
function snapshot(partial: AssistantMessage | undefined, model: Model<Api>): AssistantMessage {
  return partial ? { ...partial, content: [...partial.content] } : blankAssistant(model);
}

function blankAssistant(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
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
    stopReason: 'error',
    timestamp: Date.now(),
  };
}

function validTimeout(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '' || !/^\d+$/u.test(raw.trim())) return undefined;
  return validTimeout(Number(raw.trim()));
}

function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}
