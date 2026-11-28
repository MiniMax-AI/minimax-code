/** Final rendered rows only; Markdown parser/component state is never retained here. */
export interface TranscriptRenderedUnit {
  signature: string;
  width: number;
  lines: readonly string[];
}

/** Bounded reuse of rows evicted from the live window, without changing projection/history. */
export class TranscriptReplayCache {
  private readonly entries = new Map<string, { unit: TranscriptRenderedUnit; cost: number }>();
  private cost = 0;

  constructor(
    private readonly maxCost = 8 * 1024 * 1024,
    private readonly maxEntries = 4096,
  ) {}

  take(key: string): TranscriptRenderedUnit | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.cost -= entry.cost;
    return entry.unit;
  }

  set(key: string, unit: TranscriptRenderedUnit): void {
    this.take(key);
    // UTF-16 upper bound for strings plus an allowance for each row/map entry.
    // This is a retention budget, not a claim about V8's exact heap overhead.
    const cost =
      128 +
      2 * (key.length + unit.signature.length) +
      unit.lines.reduce((sum, line) => sum + 32 + 2 * line.length, 0);
    if (cost > this.maxCost || this.maxEntries <= 0) return;
    while (this.cost + cost > this.maxCost || this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.take(oldest);
    }
    this.entries.set(key, { unit, cost });
    this.cost += cost;
  }

  clear(): void {
    this.entries.clear();
    this.cost = 0;
  }
}
