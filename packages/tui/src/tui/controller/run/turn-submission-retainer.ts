import type { TuiSubmissionSnapshot } from '../../features/composer/submission.js';

interface RetainedTurnSubmission {
  readonly snapshot: TuiSubmissionSnapshot;
  readonly createdAtMs: number;
}

const RETAINED_TURNS_LIMIT = 8;

/**
 * Retains the most recent submission snapshots keyed by turn id so an early
 * abort can replay the ORIGINAL submission (complete attachment set,
 * transport content, client intent, editor state) instead of reconstructing
 * a lossy copy from the transcript display cell. Entries are dropped once
 * restored; the map is bounded and cleared on session switch.
 */
export class TuiTurnSubmissionRetainer {
  private readonly entries = new Map<string, RetainedTurnSubmission>();

  remember(turnId: string, snapshot: TuiSubmissionSnapshot, now = Date.now()): void {
    // Delete-then-set keeps iteration order aligned with recency so the
    // oldest entry is always the first to evict.
    this.entries.delete(turnId);
    this.entries.set(turnId, { snapshot, createdAtMs: now });
    while (this.entries.size > RETAINED_TURNS_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(turnId: string): TuiSubmissionSnapshot | undefined {
    return this.entries.get(turnId)?.snapshot;
  }

  drop(turnId: string): void {
    this.entries.delete(turnId);
  }

  clear(): void {
    this.entries.clear();
  }
}
