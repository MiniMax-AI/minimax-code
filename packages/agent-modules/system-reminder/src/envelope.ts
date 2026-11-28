/**
 * The `<system-reminder>` envelope: one block per message, inner blocks
 * separated by a blank line. Hosts that assemble their own block list (the
 * cloud harness server) reuse these so the envelope matches
 * SystemReminderService output exactly.
 */

export function wrapSystemReminderBlocks(blocks: readonly string[]): string {
  return `<system-reminder>\n${blocks.join('\n\n')}\n</system-reminder>`;
}

/** Trimmed body of a `<system-reminder>` block; '' for empty input. */
export function unwrapSystemReminder(text: string | undefined): string {
  const trimmed = text?.trim();
  if (!trimmed) return '';
  return trimmed
    .replace(/^<system-reminder>\s*/u, '')
    .replace(/\s*<\/system-reminder>$/u, '')
    .trim();
}
