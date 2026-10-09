import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  isContextOverflow,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Message,
} from '@earendil-works/pi-ai';
import { isLLMRequestOversized, normalizeLLMError } from '@mavis/shared/llm-error-classifier';

/**
 * Per-turn slot connecting the provider stream (built before the Agent exists)
 * with the Agent-owned context lifecycle that can shrink the context.
 */
export interface ContextOverflowRecoveryState {
  /**
   * Shrinks the context of the request that just failed and returns the
   * provider-bound messages to resend, or `undefined` when nothing changed.
   * Installed by `setLLMHook` only when recovery hooks exist.
   */
  recover?: (signal: AbortSignal | undefined) => Promise<Message[] | undefined>;
  /** Recovery runs at most once per turn, so a second rejection is terminal. */
  attempted: boolean;
}

export function newContextOverflowRecoveryState(): ContextOverflowRecoveryState {
  return { attempted: false };
}

/**
 * True when a failed provider response means the request was too large to be
 * accepted as sent: HTTP 413 / `request_too_large`, the local request-body
 * check, or a context-window overflow recognized by pi-ai.
 */
export function isRecoverableContextOverflow(
  message: AssistantMessage,
  contextWindow: number | undefined,
): boolean {
  if (message.stopReason !== 'error') return false;
  if (isContextOverflow(message, contextWindow)) return true;
  return isLLMRequestOversized(
    normalizeLLMError({
      finishReason: message.stopReason,
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    }),
  );
}

/**
 * When the provider rejects a main-agent request as too large before producing
 * any output, compact once and resend once. Successful streams only pay for
 * buffering their first non-`start` event. A second rejection, a recovery that
 * changes nothing, or any other failure is surfaced exactly as received.
 */
export function withContextOverflowRecovery(
  inner: StreamFn,
  state: ContextOverflowRecoveryState,
): StreamFn {
  return (async (model, context, options) => {
    const stream = await inner(model, context, options);
    if (!state.recover || state.attempted) return stream;
    const iterator = stream[Symbol.asyncIterator]();
    const buffered: AssistantMessageEvent[] = [];
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return replay(stream, buffered, undefined);
        buffered.push(next.value);
        if (next.value.type !== 'start') break;
      }
    } catch (error) {
      return replay(stream, buffered, undefined, { error });
    }
    const first = buffered.at(-1);
    if (
      first?.type !== 'error' ||
      options?.signal?.aborted ||
      !isRecoverableContextOverflow(first.error, model.contextWindow)
    ) {
      return replay(stream, buffered, iterator);
    }
    state.attempted = true;
    const messages = await state.recover(options?.signal);
    if (!messages || options?.signal?.aborted) return replay(stream, buffered, iterator);
    try {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    } catch {
      // Best-effort cleanup of the rejected attempt.
    }
    return inner(model, { ...context, messages }, options);
  }) as StreamFn;
}

function replay(
  stream: AssistantMessageEventStream,
  buffered: readonly AssistantMessageEvent[],
  iterator: AsyncIterator<AssistantMessageEvent> | undefined,
  pending?: { readonly error: unknown },
): AssistantMessageEventStream {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      let thrown = false;
      return {
        async next(): Promise<IteratorResult<AssistantMessageEvent>> {
          if (index < buffered.length) return { value: buffered[index++]!, done: false };
          if (pending && !thrown) {
            thrown = true;
            throw pending.error;
          }
          if (!iterator) return { value: undefined, done: true };
          return iterator.next();
        },
        async return(value?: unknown): Promise<IteratorResult<AssistantMessageEvent>> {
          await iterator?.return?.(value);
          return { value: undefined, done: true };
        },
      };
    },
    result: () => stream.result(),
  } as unknown as AssistantMessageEventStream;
}
