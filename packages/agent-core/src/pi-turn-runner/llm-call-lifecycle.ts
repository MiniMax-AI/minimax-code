import type { StreamFn } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ProviderResponse,
} from '@earendil-works/pi-ai';
import type { LLMMetricErrorKind } from '@mavis/shared/llm-error-classifier';
import type { LLMCallScope } from './llm-retry.js';

export interface LLMCallFailure {
  readonly thrown?: unknown;
  readonly final?: AssistantMessage;
  readonly response?: ProviderResponse;
}

export interface LLMCallRetryDecision {
  readonly kind: 'terminal' | 'retry' | 'recover';
  readonly errorKind: LLMMetricErrorKind;
  /** The first retried failure's own classification; not only the strict retry allowlist. */
  readonly retryReason?: LLMMetricErrorKind;
  readonly retryAfterMs?: number;
}

export type MaybePromise<T> = T | Promise<T>;

/** Required host resource ownership, deliberately separate from best-effort metrics. */
export interface LLMCallLifecycle {
  open(input: {
    readonly identity: object;
    readonly callId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly scope: LLMCallScope;
    readonly signal: AbortSignal;
    readonly deadlineAt?: number;
  }): Promise<LLMCallLease>;
}

export interface LLMCallLease {
  readonly signal: AbortSignal;
  /** Called once per physical request; the host must settle its attempt before returning failure. */
  wrapAttempt(inner: StreamFn): StreamFn;
  /** `undefined` has no opinion: the framework's own classification and retry decide. */
  readonly classifyFailure?: (
    failure: LLMCallFailure,
  ) => MaybePromise<LLMCallRetryDecision | undefined>;
  readonly recover?: (input: {
    readonly signal: AbortSignal;
    readonly deadlineAt: number;
  }) => Promise<void>;
  /** Idempotent and awaited. A rejection is a call failure, not an observer warning. */
  close(): Promise<void>;
}

export async function runWithLLMCallLifecycle(
  lifecycle: LLMCallLifecycle,
  input: Parameters<LLMCallLifecycle['open']>[0],
  run: (lease: LLMCallLease) => Promise<AssistantMessageEventStream>,
): Promise<AssistantMessageEventStream> {
  if (input.signal.aborted) throw callAborted(input.signal);
  const lease = await lifecycle.open(input);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await Promise.resolve();
      await lease.close();
    })();
    return closing;
  };
  try {
    if (input.signal.aborted) throw callAborted(input.signal);
    if (lease.signal.aborted) throw callAborted(lease.signal);
    const stream = await awaitCallStream(lease, run, close);
    return withLLMStreamCleanup(stream, { signal: lease.signal, close });
  } catch (error) {
    await close();
    throw error;
  }
}

/** Preflight may still be waiting for the first event; cancellation already owns cleanup. */
async function awaitCallStream(
  lease: LLMCallLease,
  run: (lease: LLMCallLease) => Promise<AssistantMessageEventStream>,
  close: () => Promise<void>,
): Promise<AssistantMessageEventStream> {
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(callAborted(lease.signal));
      observe(close());
    };
  });
  lease.signal.addEventListener('abort', abort, { once: true });
  const pending = (async () => {
    if (lease.signal.aborted) throw callAborted(lease.signal);
    const stream = await run(lease);
    // A late stream must not escape the cancelled logical call. Observe its settlement;
    // native work stays owned by the host lease until close actually settles.
    if (lease.signal.aborted) withLLMStreamCleanup(stream, { signal: lease.signal, close });
    return stream;
  })();
  if (lease.signal.aborted) abort();
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    lease.signal.removeEventListener('abort', abort);
  }
}

/**
 * Resource settlement for a stream, including result-only consumers and early iterator return.
 * Closing starts immediately on abort, even if the provider iterator does not cooperate.
 * The owner retains non-cooperative native work; this helper never pretends to terminate it.
 */
export function withLLMStreamCleanup(
  source: AssistantMessageEventStream,
  owner: { readonly signal: AbortSignal; close(): Promise<void> },
): AssistantMessageEventStream {
  let closing: Promise<void> | undefined;
  let cancelled = false;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const finish = (): Promise<void> => {
    owner.signal.removeEventListener('abort', abort);
    closing ??= (async () => {
      await Promise.resolve();
      await owner.close();
    })();
    return closing;
  };
  const abort = (): void => {
    cancelled = true;
    rejectAbort(callAborted(owner.signal));
    observe(finish());
  };
  owner.signal.addEventListener('abort', abort, { once: true });
  if (owner.signal.aborted) abort();
  const result = (async () => {
    const sourceResult = (async () => {
      await Promise.resolve();
      return source.result();
    })();
    try {
      return await Promise.race([sourceResult, aborted]);
    } finally {
      await finish();
    }
  })();
  observe(result);

  return {
    result: () => result,
    [Symbol.asyncIterator]() {
      let inner: AsyncIterator<AssistantMessageEvent>;
      try {
        inner = source[Symbol.asyncIterator]();
      } catch (error) {
        observe(finish());
        throw error;
      }
      return {
        async next(...args: [] | [unknown]) {
          try {
            if (cancelled) throw callAborted(owner.signal);
            const next = await Promise.race([inner.next(...args), aborted]);
            if (cancelled) throw callAborted(owner.signal);
            if (next.done || next.value.type === 'done' || next.value.type === 'error')
              await finish();
            return next;
          } catch (error) {
            await finish();
            throw error;
          }
        },
        async return() {
          // Signal result-only observers too; a dropped stream is not a successful call.
          cancelled = true;
          rejectAbort(callAborted(owner.signal));
          const cleanup = finish();
          try {
            return (await inner.return?.()) ?? { done: true, value: undefined };
          } finally {
            await cleanup;
          }
        },
        async throw(error?: unknown) {
          cancelled = true;
          rejectAbort(callAborted(owner.signal));
          const cleanup = finish();
          try {
            if (inner.throw) return await inner.throw(error);
            throw error;
          } finally {
            await cleanup;
          }
        },
      };
    },
  } as unknown as AssistantMessageEventStream;
}

async function observe(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    /* The stream result/iterator and explicit owner close retain the failure. */
  }
}

/** Reasons a host ended its call with: the call's own failure, not a cancellation. */
const CALL_FAILURES = new WeakSet<object>();

/**
 * Ends a call because its own work failed (a credential that cannot be prepared, say). Waiters
 * that race the call's signal then report `error` itself instead of "cancelled".
 */
export function abortLLMCallWithFailure(controller: AbortController, error: unknown): void {
  if (error instanceof Error) CALL_FAILURES.add(error);
  controller.abort(error);
}

function callAborted(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && CALL_FAILURES.has(reason)) return reason;
  const timeout = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
  const error = new Error(timeout ? 'LLM request timed out' : 'LLM request was cancelled');
  error.name = timeout ? 'TimeoutError' : 'AbortError';
  return error;
}
