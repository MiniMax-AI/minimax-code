const MCODE_TOOLS_MODEL_PREFIX = 'MiniMax-M2.7';

const MCODE_TOOLS_MASTER_REMINDER = [
  '<mcode-tools-master-reminder>',
  'For multimodal generation and understanding, including images/photos, video, audio, music, and documents, load the mcode-tools-master skill and use mcode-tools through Bash.',
  'Discover the relevant tools before concluding that a multimodal capability is unavailable.',
  '</mcode-tools-master-reminder>',
].join('\n');

export function withMcodeToolsMasterReminder(input: {
  reminderText: string | undefined;
  modelID: string | undefined;
  enabled: boolean;
}): string | undefined {
  if (!input.enabled || !input.modelID?.startsWith(MCODE_TOOLS_MODEL_PREFIX)) {
    return input.reminderText;
  }

  const existing = unwrapSystemReminder(input.reminderText);
  const body = existing
    ? `${existing}\n\n${MCODE_TOOLS_MASTER_REMINDER}`
    : MCODE_TOOLS_MASTER_REMINDER;
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

function unwrapSystemReminder(text: string | undefined): string {
  const trimmed = text?.trim();
  if (!trimmed) return '';
  return trimmed
    .replace(/^<system-reminder>\s*/u, '')
    .replace(/\s*<\/system-reminder>$/u, '')
    .trim();
}
