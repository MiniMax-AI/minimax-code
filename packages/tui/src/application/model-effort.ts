import type { TuiModel } from '../runtime/port.js';

/**
 * Think-effort levels are Runtime-owned catalog data. Both the interactive
 * effort picker and the headless `--effort` gate read them through here so a
 * single normalization rule decides what a model actually accepts.
 */
export function normalizeTuiEffortOptions(options: readonly string[] | undefined): string[] {
  if (!options?.length) return [];
  return Array.from(
    new Set(options.map((option) => option.trim()).filter((option) => option.length > 0)),
  );
}

export function supportsTuiEffort(model: TuiModel | undefined): boolean {
  return normalizeTuiEffortOptions(model?.effortOptions).length > 0;
}

/**
 * The legacy variant that means "thinking is on". Runtime resolves every other
 * defined variant either to no reasoning at all or to a distinct model identity.
 */
const THINKING_ON_VARIANT = 'thinking';

/**
 * A valid Session or saved global choice wins. Thinking Off suppresses effort, and
 * so does a genuine model variant, which is part of the model identity rather
 * than a reasoning switch. The legacy `thinking` variant is the opposite case:
 * it means thinking is on, so the configured default still applies. Leaving it
 * unresolved made the selection persist without an effort, and Runtime then
 * omitted the level and let the provider fall back to its own default.
 *
 * The catalog default wins over the midpoint, and can be fixed without editable
 * options. Without either default, even-length lists use the higher midpoint, as
 * Runtime does.
 *
 * This lives in the application layer because Session creation resolves the
 * same level the status line shows; a second rule would let the two drift.
 */
export function resolveTuiEffortChoice(
  model: TuiModel | undefined,
  selected?: string,
): string | undefined {
  const variant = model?.variant;
  if (model?.thinkingConfig?.mode === 'forced_off' || variant === '' || variant === 'none-thinking')
    return undefined;
  const options = normalizeTuiEffortOptions(model?.effortOptions);
  const defaultEffort = model?.defaultEffort?.trim();
  const allowed = options.length > 0 ? options : defaultEffort ? [defaultEffort] : [];
  const trimmed = (selected ?? (model?.selected ? model.thinking?.effort : undefined))?.trim();
  if (trimmed && allowed.includes(trimmed)) return trimmed;
  if (variant !== undefined && variant !== THINKING_ON_VARIANT) return undefined;
  return resolveTuiDefaultEffort(model);
}

/**
 * The level a model runs at while thinking is on and nothing valid is chosen, as Runtime resolves
 * it: the catalog default when the model accepts it, else the middle level (the higher one of an
 * even count).
 */
export function resolveTuiDefaultEffort(model: TuiModel | undefined): string | undefined {
  const options = normalizeTuiEffortOptions(model?.effortOptions);
  const defaultEffort = model?.defaultEffort?.trim();
  const allowed = options.length > 0 ? options : defaultEffort ? [defaultEffort] : [];
  return defaultEffort && allowed.includes(defaultEffort)
    ? defaultEffort
    : options[Math.floor(options.length / 2)];
}
