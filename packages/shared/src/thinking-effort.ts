/**
 * Canonical weak-to-strong rank for well-known reasoning effort keywords.
 *
 * Matched case-insensitively while preserving the caller's authored casing for
 * upstream provider payloads. Provider-default sentinels such as `default` are
 * intentionally omitted so they retain their declared position; synonyms at the
 * same tier share a rank so stable sorting preserves their relative order.
 */
const KNOWN_THINKING_EFFORT_RANKS: Readonly<Record<string, number>> = {
  off: 1,
  none: 1,
  on: 2,
  minimal: 3,
  min: 3,
  low: 4,
  light: 4,
  medium: 5,
  med: 5,
  normal: 5,
  standard: 5,
  high: 6,
  xhigh: 7,
  'x-high': 7,
  max: 8,
  maximum: 8,
  ultra: 9,
};

export function getKnownThinkingEffortRank(effort: string): number | undefined {
  return KNOWN_THINKING_EFFORT_RANKS[effort.trim().toLowerCase()];
}

/**
 * Sorts recognized effort keywords from lowest to highest while keeping
 * unrecognized vendor-specific or sentinel names in their original slot indices.
 */
export function sortThinkingEffortOptions(options: readonly string[]): string[] {
  const knownSlots: number[] = [];
  const knownItems: { readonly option: string; readonly rank: number; readonly order: number }[] =
    [];
  for (const [index, option] of options.entries()) {
    const rank = getKnownThinkingEffortRank(option);
    if (rank === undefined) continue;
    knownSlots.push(index);
    knownItems.push({ option, rank, order: index });
  }
  if (knownItems.length < 2) return [...options];
  knownItems.sort((left, right) => left.rank - right.rank || left.order - right.order);
  const sorted = [...options];
  for (const [i, slot] of knownSlots.entries()) {
    const item = knownItems[i];
    if (item) sorted[slot] = item.option;
  }
  return sorted;
}

/**
 * Trims, drops blank/non-string entries, deduplicates preserving first-seen
 * casing, and orders recognized effort keywords from lowest to highest.
 */
export function normalizeThinkingEffortList(values: readonly unknown[]): string[] {
  const options: string[] = [];
  const seen = new Set<string>();
  for (const candidate of values) {
    if (typeof candidate !== 'string') continue;
    const option = candidate.trim();
    if (!option || seen.has(option)) continue;
    seen.add(option);
    options.push(option);
  }
  return sortThinkingEffortOptions(options);
}
