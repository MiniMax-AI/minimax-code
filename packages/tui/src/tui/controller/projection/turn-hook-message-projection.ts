import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import type { TranscriptCell } from '../../transcript/model.js';

/** Shared live/history projection. These product messages never become model turns. */
export function projectHookSystemMessage(input: {
  eventType: string;
  data: Readonly<Record<string, unknown>>;
  messageId?: string;
  turnId: string;
  timestamp: number;
}): TranscriptCell | undefined {
  const { data, messageId } = input;
  if (
    input.eventType !== 'runtime.warning' ||
    data.source !== 'plugin-hook' ||
    data.category !== 'system-message' ||
    typeof data.message !== 'string' ||
    !messageId?.trim()
  ) {
    return undefined;
  }
  const content = sanitizeTerminalText(data.message);
  if (!content.trim()) return undefined;
  const hookEvent =
    typeof data.hookEvent === 'string' ? sanitizeTerminalText(data.hookEvent).trim() : '';
  return {
    id: `hook-message:${messageId}`,
    kind: 'warning',
    status: 'succeeded',
    title: hookEvent ? `Hook · ${hookEvent}` : 'Hook',
    content,
    sourceMessageId: messageId,
    turnId: input.turnId,
    createdAtMs: input.timestamp,
    updatedAtMs: input.timestamp,
  };
}
