import { parseAutoCompactWindowInput } from '@mavis/config';

import type { TuiCompactionTrigger } from '../runtime/port.js';
import { sanitizeTerminalText } from '../tui/rendering/terminal-text.js';

/** Shared by the TUI and ACP `/autocompact` commands. */
export const AUTO_COMPACT_USAGE =
  'Usage: /autocompact [auto | <tokens>], e.g. 300000, 500k, 1.5M, or 200 for 200K';

export type AutoCompactCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'save'; readonly value: number | 'auto' }
  | { readonly kind: 'invalid' };

export function parseAutoCompactCommand(args: string): AutoCompactCommand {
  if (!args.trim()) return { kind: 'show' };
  const parsed = parseAutoCompactWindowInput(args);
  if (parsed.kind === 'invalid') return { kind: 'invalid' };
  return { kind: 'save', value: parsed.kind === 'auto' ? 'auto' : parsed.tokens };
}

const SOURCE_LABELS: Readonly<Record<TuiCompactionTrigger['source'], string>> = {
  model: 'saved for this model',
  'model-auto': 'built-in (auto saved for this model)',
  global: 'global config',
  'built-in': 'built-in',
};

export function compactionTriggerSourceLabel(source: TuiCompactionTrigger['source']): string {
  return SOURCE_LABELS[source];
}

/** `/autocompact` without arguments. */
export function formatAutoCompactStatus(trigger: TuiCompactionTrigger): string {
  return [
    `Auto-compact for ${modelLabel(trigger)} starts at ${startsAt(trigger)}`,
    compactionTriggerSourceLabel(trigger.source),
    ...aboveBuiltInNote(trigger),
  ].join(' · ');
}

/** Confirmation after `/autocompact <value>` saved the setting. */
export function formatAutoCompactSaved(trigger: TuiCompactionTrigger): string {
  const saved =
    trigger.saved === 'auto'
      ? 'auto (built-in trigger)'
      : `${formatTokens(trigger.saved ?? trigger.effectiveTriggerTokens)} tokens`;
  return [
    `Auto-compact for ${modelLabel(trigger)} set to ${saved}`,
    `starts at ${startsAt(trigger)} from the next request`,
    ...aboveBuiltInNote(trigger),
  ].join(' · ');
}

function aboveBuiltInNote(trigger: TuiCompactionTrigger): string[] {
  return typeof trigger.saved === 'number' && trigger.saved > trigger.builtInTriggerTokens
    ? ['above the built-in trigger, which still applies']
    : [];
}

function startsAt(trigger: TuiCompactionTrigger): string {
  const percent =
    trigger.contextWindow > 0
      ? ` (${Math.round((trigger.effectiveTriggerTokens / trigger.contextWindow) * 100)}% of window)`
      : '';
  return `${formatTokens(trigger.effectiveTriggerTokens)} tokens${percent}`;
}

function modelLabel(trigger: TuiCompactionTrigger): string {
  return sanitizeTerminalText(`${trigger.providerId}/${trigger.modelId}`).replace(/\s+/gu, ' ');
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}
