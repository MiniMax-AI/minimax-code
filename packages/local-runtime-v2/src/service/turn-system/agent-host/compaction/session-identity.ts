export const SESSION_IDENTITY_REMINDER_CUSTOM_TYPE = 'session_identity_reminder';

/**
 * Whether a user message or session identity reminder after the latest
 * compaction summary (or anywhere when never compacted) shows `sessionId`.
 */
export function messagesCarrySessionId(messages: readonly unknown[], sessionId: string): boolean {
  if (!sessionId) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) continue;
    // Native summaries and legacy (archon) compaction markers both start a
    // fresh model-visible context; anything before them was summarized away.
    if (message.role === 'compactionSummary' || Object.hasOwn(message, 'archonCompaction')) {
      return false;
    }
    const carriesId =
      message.role === 'user' ||
      (message.role === 'custom' && message.customType === SESSION_IDENTITY_REMINDER_CUSTOM_TYPE);
    if (carriesId && messageText(message.content).includes(sessionId)) return true;
  }
  return false;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '',
    )
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
