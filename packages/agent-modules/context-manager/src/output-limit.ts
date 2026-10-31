import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';

/** Retry reason for a response cut off by the output limit before any visible reply. */
export const OUTPUT_LIMIT_RETRY_REASON = 'output_limit_without_reply';
/**
 * Failure reason once the retries are spent. It reaches product surfaces as the
 * turn failure message, where it is recognized as a stable marker.
 */
export const OUTPUT_LIMIT_EXHAUSTED_REASON = 'output_limit_exhausted';
export const DEFAULT_OUTPUT_LIMIT_MAX_RETRIES = 3;

const REASONING_HINT =
  'Your previous response hit the output token limit while you were still reasoning, before it ' +
  'produced any text or tool call. That reasoning was discarded and is not part of this ' +
  'conversation, so there is nothing to resume. Continue from the conversation above: reason ' +
  'much more briefly and produce your answer or next tool call well within the output limit.';

const TOOL_CALL_HINT =
  'Your previous response hit the output token limit while it was still writing a tool call, so ' +
  'the response was discarded and that tool call was not run. Continue from the conversation ' +
  'above: reason much more briefly and produce your answer or next tool call well within the ' +
  'output limit. If the tool call itself is large, such as writing a long file, split it into ' +
  'smaller calls.';

const REASONING_PROMPT = wrapSystemReminder(REASONING_HINT);
const TOOL_CALL_PROMPT = wrapSystemReminder(TOOL_CALL_HINT);
const RECOVERY_PROMPTS: ReadonlySet<string> = new Set([REASONING_PROMPT, TOOL_CALL_PROMPT]);

export type OutputLimitRecoveryDecision =
  /** Not a cut-off response, and no recovery was in progress. */
  | { readonly kind: 'none' }
  /** A response arrived normally right after `attempts` recovery requests. */
  | { readonly kind: 'recovered'; readonly attempts: number }
  /** Drop the response and repeat the request with `prompt` appended. */
  | {
      readonly kind: 'retry';
      /** Recovery requests for this step, including this one. */
      readonly attempts: number;
      readonly truncatedToolCall: boolean;
      readonly prompt: string;
    }
  /** Still cut off after `attempts` recovery requests; fail the turn. */
  | { readonly kind: 'exhausted'; readonly attempts: number; readonly truncatedToolCall: boolean };

/**
 * Decides how to handle a response that may have hit the output limit before
 * producing any visible text, typically because reasoning used up the whole
 * output budget.
 *
 * Such a response is dropped (its reasoning cannot be resumed and any tool
 * call in it is incomplete) and the request is repeated with a hint asking for
 * briefer reasoning. Retries are counted from the transcript itself: the hints
 * sitting directly before `response`. A step that completes normally, or any
 * other message in between, starts the count again, so no state is kept.
 *
 * @param messages Transcript including `response`. When `response` is missing
 *   from it, counting starts from its end.
 */
export function decideOutputLimitRecovery(
  response: AssistantMessage,
  messages: readonly AgentMessage[],
  maxRetries = DEFAULT_OUTPUT_LIMIT_MAX_RETRIES,
): OutputLimitRecoveryDecision {
  const attempts = countPrecedingRecoveryPrompts(messages, response);
  const hasVisibleText = response.content.some(
    (block) => block.type === 'text' && block.text.trim().length > 0,
  );

  if (response.stopReason !== 'length' || hasVisibleText) {
    const settled = response.stopReason !== 'error' && response.stopReason !== 'aborted';
    return attempts > 0 && settled ? { kind: 'recovered', attempts } : { kind: 'none' };
  }

  const truncatedToolCall = response.content.some((block) => block.type === 'toolCall');
  if (attempts >= maxRetries) return { kind: 'exhausted', attempts, truncatedToolCall };
  return {
    kind: 'retry',
    attempts: attempts + 1,
    truncatedToolCall,
    prompt: truncatedToolCall ? TOOL_CALL_PROMPT : REASONING_PROMPT,
  };
}

function wrapSystemReminder(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

function countPrecedingRecoveryPrompts(
  messages: readonly AgentMessage[],
  current: AssistantMessage,
): number {
  const currentIndex = messages.lastIndexOf(current);
  let index = (currentIndex >= 0 ? currentIndex : messages.length) - 1;
  let count = 0;
  while (index >= 0 && isRecoveryPrompt(messages[index])) {
    count += 1;
    index -= 1;
  }
  return count;
}

function isRecoveryPrompt(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== 'user') return false;
  if (typeof content === 'string') return RECOVERY_PROMPTS.has(content);
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block = content[0] as { type?: unknown; text?: unknown } | undefined;
  return (
    block?.type === 'text' && typeof block.text === 'string' && RECOVERY_PROMPTS.has(block.text)
  );
}
