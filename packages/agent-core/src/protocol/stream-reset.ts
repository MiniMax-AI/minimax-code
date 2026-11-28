import type { AssistantMessage } from '@earendil-works/pi-ai';

/**
 * Neutral home of the abandoned-attempt marker.
 *
 * The producer is the transport layer (`pi-turn-runner/llm-retry.ts`) and the
 * consumer is the wire bridge (`event-bridge/bridge.ts`). The bridge sits below
 * the retry layer inside this package, so it must not import it: that edge would
 * invert the layering and make the bridge depend on transport policy. Both sides
 * depend on this module instead.
 *
 * The marker never reaches the wire. It rides on an internal pi event frame so
 * the bridge can close the abandoned assistant message with the content the
 * consumer already rendered, and then start the resent attempt as a new message.
 */

/**
 * Symbol-keyed marker on the pi assistant-message event that reports an
 * abandoned streaming attempt.
 *
 * pi's agent loop forwards `assistantMessageEvent` to `message_update` by
 * reference but only reacts to the event types it knows, so the reset rides on a
 * `text_start` frame: the loop replaces the partial it holds with the empty one
 * the frame carries, which keeps the abandoned attempt out of the model context.
 */
export const LLM_PARTIAL_STREAM_RESET: unique symbol = Symbol('mavis.llmPartialStreamReset');

/** What the transport reports when it abandons a streaming attempt. */
export interface AbandonedStreamAttempt {
  /**
   * The assistant message as the abandoned attempt left it: the text, thinking
   * and half-written tool calls the consumer already rendered. It travels beside
   * the frame rather than inside `partial`, because pi replaces `partial` with
   * the empty message the frame carries.
   */
  readonly abandoned: AssistantMessage;
}

/** The abandoned attempt's message, or undefined when the frame carries no marker. */
export function readAbandonedStreamAttempt(event: unknown): AssistantMessage | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const marker = (event as Record<symbol, unknown>)[LLM_PARTIAL_STREAM_RESET];
  if (typeof marker !== 'object' || marker === null) return undefined;
  const abandoned = (marker as { abandoned?: unknown }).abandoned;
  return typeof abandoned === 'object' && abandoned !== null
    ? (abandoned as AssistantMessage)
    : undefined;
}

/** Whether a pi assistant-message event reports an abandoned streaming attempt. */
export function isLLMPartialStreamResetEvent(event: unknown): boolean {
  return readAbandonedStreamAttempt(event) !== undefined;
}

/**
 * Symbol-keyed marker on the runtime events the bridge synthesises while it
 * closes an abandoned attempt: the `Failed` cards for tool calls the model
 * never ran, the finish chunk, and the materialised half answer.
 *
 * Those frames exist so the user sees a finished message instead of a card
 * stuck on "preparing". They are display only — no tool ran, and the half
 * answer is not a model output — so an observer that decides from tool status
 * or assistant messages must be able to tell them apart from real results.
 *
 * The marker is deliberately in-process: it never reaches the wire, so no
 * consumer outside this machine sees a new field, and a serialised copy of the
 * event simply loses it. Observers that only see serialised frames fall back to
 * the execution lifecycle itself (a terminal tool status the runtime never
 * started is not a result).
 */
export const ABANDONED_STREAM_CLOSING: unique symbol = Symbol('mavis.abandonedStreamClosing');

/** Tag a synthesised closing frame so in-process observers can recognise it. */
export function markAbandonedStreamClosing<T extends object>(event: T): T {
  Object.defineProperty(event, ABANDONED_STREAM_CLOSING, {
    value: true,
    // Survives the object spreads these events pass through, stays invisible to
    // JSON. Same convention as LLM_PARTIAL_STREAM_RESET.
    enumerable: true,
  });
  return event;
}

/** Whether a runtime event is a synthesised closing frame for an abandoned attempt. */
export function isAbandonedStreamClosingEvent(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    (event as Record<symbol, unknown>)[ABANDONED_STREAM_CLOSING] === true
  );
}

/**
 * Whether a materialised assistant message is the half answer of an abandoned
 * attempt rather than a model output.
 *
 * The bridge closes an abandoned attempt with `finish_reason: 'length'` and no
 * usage. Every real reply carries provider usage, even one that stopped on the
 * length limit or failed, so the pair survives serialisation and storage and
 * needs no wire field. Consumers that build a single reply out of a turn (IM
 * delivery, cron fan-out, eval capture) skip it so the user does not receive
 * the half answer followed by the resent full answer.
 */
export function isAbandonedStreamClosingMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  if (record.role === 'user') return false;
  const finishReason = record.finish_reason ?? record.finishReason;
  return (
    typeof finishReason === 'string' &&
    finishReason.toLowerCase() === 'length' &&
    record.usage === undefined
  );
}
