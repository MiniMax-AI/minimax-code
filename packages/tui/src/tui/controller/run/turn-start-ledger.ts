/**
 * TUI-process memory of when each Runtime Turn started.
 *
 * Switching projections (most often between a paired BTW side conversation and
 * its main Session) reloads the target projection and re-adopts its live Turn.
 * Without this ledger the re-adoption time would masquerade as the Turn start,
 * resetting the running/loading timer and the settled Turn duration. Turn ids
 * are globally unique, so the earliest observation of a Turn wins.
 */
export class TuiTurnStartLedger {
  private readonly startedAtMs = new Map<string, number>();

  constructor(private readonly capacity = 64) {}

  /** Records an observed start and returns the earliest known start for the Turn. */
  record(turnId: string, timestampMs: number): number {
    const known = this.startedAtMs.get(turnId);
    if (!Number.isFinite(timestampMs)) return known ?? timestampMs;
    if (known !== undefined && known <= timestampMs) return known;
    // Re-insert so eviction stays least-recently-started first.
    this.startedAtMs.delete(turnId);
    this.startedAtMs.set(turnId, timestampMs);
    while (this.startedAtMs.size > this.capacity) {
      const oldest = this.startedAtMs.keys().next();
      if (oldest.done) break;
      this.startedAtMs.delete(oldest.value);
    }
    return timestampMs;
  }

  get(turnId: string): number | undefined {
    return this.startedAtMs.get(turnId);
  }
}
