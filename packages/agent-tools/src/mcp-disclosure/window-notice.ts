/**
 * Notice rules shared by the Tool Search window and the skill-catalog window:
 * when an availability update is due, which update a request sends as the
 * newest, and which response answers a request.
 */
import type {
  PiAfterLlmCallHookInput,
  PiBeforeLlmCallHookInput,
} from '@mavis/agent-core/pi-turn-runner';

type RequestMessage = PiBeforeLlmCallHookInput['messages'][number];

interface DeviationEntry {
  readonly status: string;
  readonly signature?: string;
}

export function sameDeviations<T extends DeviationEntry>(
  a: ReadonlyMap<string, T>,
  b: ReadonlyMap<string, T>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, entry] of a) {
    const other = b.get(key);
    if (other?.status !== entry.status || other.signature !== entry.signature) return false;
  }
  return true;
}

/**
 * An update is due when the deviation differs from the last told one, or when
 * what was told is unknown and there is a deviation to state or an earlier
 * update to supersede.
 */
export function noticeDue<T extends DeviationEntry>(
  told: { readonly snapshot?: ReadonlyMap<string, T>; readonly everTold: boolean },
  deviation: ReadonlyMap<string, T>,
): boolean {
  return told.snapshot
    ? !sameDeviations(told.snapshot, deviation)
    : deviation.size > 0 || told.everTold;
}

/** The text of a user message; undefined for other roles. */
export function requestUserText(message: RequestMessage | undefined): string | undefined {
  if (message?.role !== 'user') return undefined;
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

/**
 * `notice` is the newest `tag` notice among the user messages, of those after
 * the last assistant message (what the request sends anew) when `sentAnew`: an
 * older notice there, or an identical copy deeper in the history, does not
 * count. Summaries quoting it are no user messages.
 */
export function isNewestNotice(
  messages: readonly RequestMessage[],
  notice: string,
  tag: string,
  sentAnew: boolean,
): boolean {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (sentAnew && message?.role === 'assistant') return false;
    const text = requestUserText(message) ?? '';
    const newest = text.lastIndexOf(tag);
    if (newest === -1) continue;
    const sent = text.lastIndexOf(notice);
    return sent !== -1 && sent + notice.indexOf(tag) === newest;
  }
  return false;
}

/**
 * The provider answered, or was stopped after streaming part of an answer; a
 * request it rejected, or one stopped before the first token, wrote no prompt cache.
 */
export function isAnsweredResponse(message: PiAfterLlmCallHookInput['message']): boolean {
  return (
    message.stopReason !== 'error' &&
    (message.stopReason !== 'aborted' || message.content.length > 0)
  );
}
