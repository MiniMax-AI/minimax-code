interface SemanticReplay<T> {
  readonly identity: string;
  readonly order: bigint;
  readonly fingerprint: string;
  execution: Promise<T> | undefined;
  settled: boolean;
  retainedBytes: number;
}

export interface SemanticReplayRequest<T> {
  readonly identity: string;
  readonly fingerprint: string;
  readonly execute: () => Promise<T>;
  readonly conflict: () => Error;
  /**
   * Optional owner-specific failure envelope for semantic collisions. The
   * registry still performs no mutation; the caller can settle a lifecycle
   * attempt before the conflict is rethrown.
   */
  readonly handleConflict?: (error: Error) => Promise<T>;
}

export interface SemanticReplayRegistryOptions<T> {
  /** Maximum aggregate size of settled results retained for exact replay. */
  readonly maximumSettledBytes: number;
  /** Allocation-free estimate for an already-settled result. */
  readonly measureSettledBytes: (value: T) => number;
}

class SemanticReplayResultUnavailableError extends Error {
  override readonly name = 'SemanticReplayResultUnavailableError';

  constructor(readonly identity: string) {
    super(`Semantic replay result is no longer retained: ${identity}.`);
  }
}

/**
 * Process-local delivery replay registry. Settled identities are count
 * bounded and their resolved results can additionally be byte bounded.
 * In-flight entries are never evicted and may temporarily exceed either
 * limit. When a heavy result is released, its fingerprint tombstone remains
 * so an exact retry fails closed instead of repeating a durable mutation.
 */
export class SemanticReplayRegistry<T> {
  private readonly entries = new Map<string, SemanticReplay<T>>();
  private readonly settlements = new WeakSet<Promise<void>>();
  private readonly settledEntries = new ReplayOrderIndex<T>();
  private readonly retainedEntries = new ReplayOrderIndex<T>();
  private nextOrder = 0n;
  private retainedSettledBytes = 0;

  constructor(
    private readonly maximum: number,
    private readonly options?: SemanticReplayRegistryOptions<T>,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new RangeError('Semantic replay capacity must be a finite positive integer.');
    }
    if (
      options &&
      (!Number.isSafeInteger(options.maximumSettledBytes) || options.maximumSettledBytes <= 0)
    ) {
      throw new RangeError('Semantic replay byte capacity must be a finite positive integer.');
    }
  }

  run(request: SemanticReplayRequest<T>): Promise<T> {
    const existing = this.entries.get(request.identity);
    if (existing) {
      if (existing.fingerprint === request.fingerprint) {
        return (
          existing.execution ??
          Promise.reject(new SemanticReplayResultUnavailableError(request.identity))
        );
      }
      const conflict = request.conflict();
      return request.handleConflict ? request.handleConflict(conflict) : Promise.reject(conflict);
    }
    const execution = request.execute();
    const replay: SemanticReplay<T> = {
      identity: request.identity,
      order: this.nextOrder++,
      fingerprint: request.fingerprint,
      execution,
      settled: false,
      retainedBytes: 0,
    };
    this.entries.set(request.identity, replay);
    this.settlements.add(this.trackSettlement(request.identity, replay, execution));
    this.trim();
    return execution;
  }

  private async trackSettlement(
    identity: string,
    replay: SemanticReplay<T>,
    execution: Promise<T>,
  ): Promise<void> {
    try {
      const value = await execution;
      if (this.entries.get(identity) !== replay) return;
      replay.settled = true;
      this.settledEntries.add(replay);
      replay.retainedBytes = this.measureSettledBytes(value);
      this.retainedSettledBytes += replay.retainedBytes;
      if (replay.retainedBytes > 0 && this.entries.get(identity) === replay) {
        this.retainedEntries.add(replay);
      }
    } catch {
      // The original execution preserves and reports its rejection to the caller.
      if (this.entries.get(identity) === replay) this.delete(identity, replay);
    } finally {
      this.trim();
    }
  }

  private measureSettledBytes(value: T): number {
    if (!this.options) return 0;
    try {
      const measured = this.options.measureSettledBytes(value);
      return Number.isSafeInteger(measured) && measured >= 0
        ? measured
        : this.options.maximumSettledBytes + 1;
    } catch {
      return this.options.maximumSettledBytes + 1;
    }
  }

  private trim(): void {
    while (this.entries.size > this.maximum) {
      const settled = this.settledEntries.first;
      if (!settled) return;
      this.delete(settled.identity, settled);
    }
    const maximumSettledBytes = this.options?.maximumSettledBytes;
    if (maximumSettledBytes === undefined) return;
    while (this.retainedSettledBytes > maximumSettledBytes) {
      const replay = this.retainedEntries.first;
      if (!replay) return;
      this.retainedEntries.remove(replay);
      this.retainedSettledBytes -= replay.retainedBytes;
      replay.retainedBytes = 0;
      replay.execution = undefined;
    }
  }

  private delete(identity: string, replay: SemanticReplay<T>): void {
    if (this.entries.get(identity) !== replay) return;
    this.entries.delete(identity);
    this.settledEntries.remove(replay);
    this.retainedEntries.remove(replay);
    this.retainedSettledBytes -= replay.retainedBytes;
  }
}

/** Oldest insertion first, even when requests settle out of order. */
class ReplayOrderIndex<T> {
  private readonly heap: SemanticReplay<T>[] = [];
  private readonly positions = new WeakMap<SemanticReplay<T>, number>();

  get first(): SemanticReplay<T> | undefined { return this.heap[0]; }

  add(replay: SemanticReplay<T>): void {
    const index = this.heap.length;
    this.heap.push(replay);
    this.positions.set(replay, index);
    this.up(index);
  }

  remove(replay: SemanticReplay<T>): void {
    const index = this.positions.get(replay);
    if (index === undefined) return;
    const last = this.heap.pop()!;
    this.positions.delete(replay);
    if (index === this.heap.length) return;
    this.heap[index] = last;
    this.positions.set(last, index);
    if (index > 0 && last.order < this.heap[Math.floor((index - 1) / 2)]!.order) this.up(index);
    else this.down(index);
  }

  private swap(a: number, b: number): void {
    const left = this.heap[a]!;
    const right = this.heap[b]!;
    this.heap[a] = right;
    this.heap[b] = left;
    this.positions.set(right, a);
    this.positions.set(left, b);
  }

  private up(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.heap[parent]!.order <= this.heap[index]!.order) return;
      this.swap(parent, index);
      index = parent;
    }
  }

  private down(index: number): void {
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this.heap.length) return;
      const right = left + 1;
      const child = right < this.heap.length && this.heap[right]!.order < this.heap[left]!.order ? right : left;
      if (this.heap[index]!.order <= this.heap[child]!.order) return;
      this.swap(index, child);
      index = child;
    }
  }
}
