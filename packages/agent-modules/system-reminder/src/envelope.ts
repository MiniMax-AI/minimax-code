/**
 * The `<system-reminder>` envelope: one block per message, inner blocks
 * separated by a blank line. Hosts that assemble their own block list reuse
 * these so the envelope matches SystemReminderService output exactly.
 */

const OPEN_TAG = '<system-reminder>';
const CLOSE_TAG = '</system-reminder>';

export function wrapSystemReminderBlocks(blocks: readonly string[]): string {
  return `${OPEN_TAG}\n${blocks.join('\n\n')}\n${CLOSE_TAG}`;
}

/** Trimmed body of a `<system-reminder>` block; '' for empty input. */
export function unwrapSystemReminder(text: string | undefined): string {
  let value = text?.trim() ?? '';
  if (!value) return '';
  if (value.startsWith(OPEN_TAG)) value = value.slice(OPEN_TAG.length);
  if (value.endsWith(CLOSE_TAG)) value = value.slice(0, -CLOSE_TAG.length);
  return value.trim();
}
