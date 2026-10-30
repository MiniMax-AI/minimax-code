import type { PiTurnRunnerLogger } from './types.js';
import type { PiMessageIdAllocator } from './pi-turn-runner.js';

export const noopLogger: Required<PiTurnRunnerLogger> = {
  debug: (..._args: unknown[]) => {},
  error: (..._args: unknown[]) => {},
  info: (..._args: unknown[]) => {},
  warn: (..._args: unknown[]) => {},
};

export const defaultNowMs = () => Date.now();

/**
 * Default per-call LLM HTTP timeout (ms) injected into every provider
 * stream invocation via `wrapStreamFnWithTimeout`. 20 minutes is long
 * enough for thinking turns without letting a wedged provider hang the
 * agent loop indefinitely.
 *
 * Per-call upstream wrappers that explicitly set `options.timeoutMs` win.
 */
export const LLM_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Default per-attempt wait for the first provider stream event. Built-in
 * providers emit their first event once response headers arrive, so this is
 * a first-byte bound: a request the provider accepted but never answers is
 * failed as a retryable timeout instead of waiting for
 * {@link LLM_REQUEST_TIMEOUT_MS}. The default matches undici's 300 s headers
 * timeout, the effective previous wait, so no request that used to succeed
 * now times out; the bound also applies to custom fetch implementations.
 * Override with {@link LLM_FIRST_EVENT_TIMEOUT_ENV} or
 * `LLMModelConfig.firstEventTimeoutMs`; `0` disables it.
 */
export const LLM_FIRST_EVENT_TIMEOUT_MS = 300 * 1000;

/**
 * Default per-attempt maximum gap between provider stream events after the
 * first one. Only parsed model events reset it; SSE comment heartbeats do not.
 * A gateway that buffers the upstream response and sends only heartbeats
 * until generation finishes therefore makes the whole generation look idle,
 * and long-thinking models with large output budgets can generate for over
 * 30 minutes that way. The default stays above that.
 * On the default undici transport a connection that goes fully silent is
 * still cut by its body timeout (300 s since the last byte), so this bound
 * mainly catches streams whose transport stays alive without model events
 * and custom fetch implementations without their own body timeout. Override
 * with {@link LLM_STREAM_IDLE_TIMEOUT_ENV} or
 * `LLMModelConfig.streamIdleTimeoutMs`; `0` disables it.
 */
export const LLM_STREAM_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** Environment override (milliseconds) for {@link LLM_FIRST_EVENT_TIMEOUT_MS}. */
export const LLM_FIRST_EVENT_TIMEOUT_ENV = 'MCODE_LLM_FIRST_EVENT_TIMEOUT_MS';

/** Environment override (milliseconds) for {@link LLM_STREAM_IDLE_TIMEOUT_MS}. */
export const LLM_STREAM_IDLE_TIMEOUT_ENV = 'MCODE_LLM_STREAM_IDLE_TIMEOUT_MS';

export const defaultMessageIdAllocator: PiMessageIdAllocator = {
  async allocateAssistantMessageId() {
    // crypto.randomUUID is available in Node >=18 and modern runtimes.
    return (
      globalThis.crypto?.randomUUID?.() ??
      `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    );
  },
};
