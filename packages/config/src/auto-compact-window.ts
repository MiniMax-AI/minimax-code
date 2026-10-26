/**
 * Per-model automatic compaction trigger, stored like Claude Code's
 * `modelSettings.<model>.autoCompactWindow`:
 *
 * ```yaml
 * modelSettings:
 *   "minimax/MiniMax-M3":
 *     autoCompactWindow: 400000   # token count, or "auto" for the built-in trigger
 * ```
 *
 * The key is the source-qualified `provider/model` id. Model ids may contain
 * dots, so the key is never addressed through a dotted config path.
 */

export type AutoCompactWindowSetting = number | 'auto';

export interface ModelSettingsEntry {
  /** Positive integer token count above 1, or `auto`; other numbers are ignored at runtime. */
  readonly autoCompactWindow?: AutoCompactWindowSetting;
}

export type ModelSettingsConfig = Readonly<Record<string, ModelSettingsEntry>>;

export type AutoCompactWindowInput =
  | { readonly kind: 'auto' }
  | { readonly kind: 'tokens'; readonly tokens: number }
  | { readonly kind: 'invalid' };

/** Which setting decides a model's automatic compaction trigger. */
export type CompactionTriggerSetting =
  | { readonly source: 'model'; readonly value: number }
  | { readonly source: 'model-auto' }
  | { readonly source: 'global'; readonly value: number }
  | { readonly source: 'built-in' };

interface CompactionTriggerConfig {
  readonly modelSettings?: ModelSettingsConfig;
  readonly contextManagement?: { readonly compactionTriggerAt?: number };
}

const INPUT_PATTERN = /^(\d+)(?:\.(\d+))?([km])?$/u;
const SUFFIX_EXPONENT = { k: 3, m: 6 } as const;
const THOUSANDS_SHORTHAND = { min: 100, max: 1_000 } as const;

/**
 * A token count above 1. `contextManagement.compactionTriggerAt` reads 1 as the
 * whole window, so a per-model value of 1 would be ambiguous and is rejected.
 */
export function isValidAutoCompactWindowTokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1;
}

/**
 * Parses `/autocompact` input with Claude Code's grammar: a token count, a
 * `k`/`M` suffix (decimals allowed when the result is whole), a bare 100–1000
 * meaning thousands, or `auto`. Unlike Claude Code there is no lower bound or
 * 1M clamp; the built-in trigger still caps the effective value.
 */
export function parseAutoCompactWindowInput(text: string): AutoCompactWindowInput {
  const normalized = text.trim().toLowerCase();
  if (normalized === 'auto') return { kind: 'auto' };
  const match = INPUT_PATTERN.exec(normalized);
  if (!match) return { kind: 'invalid' };
  const [, whole = '', fraction, suffix] = match;
  let tokens: number | undefined;
  if (suffix === 'k' || suffix === 'm') {
    tokens = scaleDecimal(whole, fraction ?? '', SUFFIX_EXPONENT[suffix]);
  } else if (fraction === undefined) {
    const value = Number(whole);
    tokens =
      value >= THOUSANDS_SHORTHAND.min && value <= THOUSANDS_SHORTHAND.max ? value * 1_000 : value;
  }
  return isValidAutoCompactWindowTokens(tokens) ? { kind: 'tokens', tokens } : { kind: 'invalid' };
}

/** Exact decimal scaling; undefined when the result is not a whole number. */
function scaleDecimal(whole: string, fraction: string, exponent: number): number | undefined {
  // A loop instead of /0+$/, which backtracks quadratically on long zero runs.
  let end = fraction.length;
  while (end > 0 && fraction.endsWith('0', end)) end -= 1;
  const significant = fraction.slice(0, end);
  if (significant.length > exponent) return undefined;
  return Number(`${whole}${significant.padEnd(exponent, '0')}`);
}

/**
 * Keeps numbers for runtime validation and only the exact string `auto`;
 * entries without a recognized field are dropped.
 */
export function parseModelSettings(raw: unknown): ModelSettingsConfig | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const entries = Object.entries(raw).flatMap(([key, entry]) => {
    if (!isPlainRecord(entry)) return [];
    const value = entry.autoCompactWindow;
    return typeof value === 'number' || value === 'auto'
      ? [[key, { autoCompactWindow: value }] as const]
      : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Picks the trigger setting for one `provider/model` key: a valid per-model
 * value (`auto` included) wins over `contextManagement.compactionTriggerAt`,
 * which wins over the built-in trigger. The global value is passed through
 * as-is; the compaction budget validates it.
 */
export function selectCompactionTriggerSetting(
  config: CompactionTriggerConfig,
  modelKey: string,
): CompactionTriggerSetting {
  const value = readModelSetting(config.modelSettings, modelKey)?.autoCompactWindow;
  if (value === 'auto') return { source: 'model-auto' };
  if (isValidAutoCompactWindowTokens(value)) return { source: 'model', value };
  const global = config.contextManagement?.compactionTriggerAt;
  return typeof global === 'number' ? { source: 'global', value: global } : { source: 'built-in' };
}

/** The `compactionTriggerAt` budget input a setting stands for; undefined keeps the built-in. */
export function compactionTriggerAtForSetting(
  setting: CompactionTriggerSetting,
): number | undefined {
  return setting.source === 'model' || setting.source === 'global' ? setting.value : undefined;
}

/** Per-model numbers the runtime ignores, for a one-time configuration warning. */
export function findInvalidAutoCompactWindows(
  modelSettings: ModelSettingsConfig | undefined,
): readonly { readonly modelKey: string; readonly value: unknown }[] {
  return Object.entries(modelSettings ?? {}).flatMap(([modelKey, entry]) => {
    const value = entry.autoCompactWindow;
    return value === undefined || value === 'auto' || isValidAutoCompactWindowTokens(value)
      ? []
      : [{ modelKey, value }];
  });
}

function readModelSetting(
  modelSettings: ModelSettingsConfig | undefined,
  modelKey: string,
): ModelSettingsEntry | undefined {
  return modelSettings && Object.hasOwn(modelSettings, modelKey)
    ? modelSettings[modelKey]
    : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
