const KEY_FALLBACK_COOLDOWN_MS = 60_000;
const KEY_LONGEST_RETRY_MS = 10 * 60_000;
const KEY_LONGEST_RATE_REST_MS = 30 * 60_000;
const KEY_RATE_FORGET_MS = 30 * 60_000;

export type ApiKeyRestReason = 'auth' | 'rate' | 'quota';

export interface ApiKeyRestView {
  readonly reason: ApiKeyRestReason;
  readonly status?: number;
  /** Unix ms. */
  readonly until: number;
}

export interface ApiKeyProbeView {
  readonly ok: boolean;
  readonly status?: number;
  /** Already redacted. */
  readonly error?: string;
  readonly ms?: number;
  readonly modelId?: string;
  /** Unix ms. */
  readonly at: number;
}

interface RestEntry extends ApiKeyRestView {
  /** Rests of this reason in a row (for doubling), and when the last one ended. */
  readonly n: number;
}

/** Enough to keep every provider's keys; old entries go first. */
const POOL_LIMIT = 4096;

/**
 * In-memory state of BYOK keys, keyed `providerKey#keyId`: which key rests and why, and each key's
 * latest test. Nothing is persisted; a restart starts every key fresh.
 */
export class ByokKeyPool {
  private readonly rests = new Map<string, RestEntry>();
  /** The last rest per key, kept after it ends so a repeat soon after doubles it. */
  private readonly history = new Map<string, RestEntry>();
  private readonly probes = new Map<string, ApiKeyProbeView>();

  constructor(readonly now: () => number = Date.now) {}

  private static slot(providerKey: string, keyId: string): string {
    return `${providerKey}#${keyId}`;
  }

  /** The key's live rest, if any (an ended rest is dropped here). */
  rest(providerKey: string, keyId: string): ApiKeyRestView | undefined {
    const slot = ByokKeyPool.slot(providerKey, keyId);
    const entry = this.rests.get(slot);
    if (!entry) return undefined;
    if (entry.until <= this.now()) {
      this.rests.delete(slot);
      return undefined;
    }
    return {
      reason: entry.reason,
      until: entry.until,
      ...(entry.status ? { status: entry.status } : {}),
    };
  }

  resting(providerKey: string, keyId: string): boolean {
    return this.rest(providerKey, keyId) !== undefined;
  }

  /**
   * Rests a key. Without a vendor time: a minute, doubled for each repeat of the same reason
   * within 30 minutes of the last one ending, at most 10 minutes for a refused key and 30 for a
   * limit. A vendor time (Retry-After, a reset time) is honored when it is at least as long. A key resting longer already keeps that rest (and its reason): a
   * probe of a used-up key that meets a brief 429 must not cut its hours to a minute. Returns the
   * end of the rest.
   */
  restKey(
    providerKey: string,
    keyId: string,
    reason: ApiKeyRestReason,
    input: { readonly status?: number; readonly until?: number } = {},
  ): number {
    const now = this.now();
    const slot = ByokKeyPool.slot(providerKey, keyId);
    const n = this.repeats(slot, reason, now);
    const longest = reason === 'auth' ? KEY_LONGEST_RETRY_MS : KEY_LONGEST_RATE_REST_MS;
    const doubled = Math.min(longest, KEY_FALLBACK_COOLDOWN_MS * 2 ** (n - 1));
    const until = Math.max(now + doubled, input.until ?? 0);
    const live = this.rests.get(slot);
    if (live && live.until > until) return live.until;
    const entry: RestEntry = {
      reason,
      until,
      n,
      ...(input.status ? { status: input.status } : {}),
    };
    this.bound(this.rests);
    this.bound(this.history);
    this.rests.set(slot, entry);
    this.history.set(slot, entry);
    return until;
  }

  /**
   * How many rests of this reason in a row, this one included: one more when the last ended
   * less than 30 minutes ago, the same while it still runs (the key was tried anyway).
   */
  private repeats(slot: string, reason: ApiKeyRestReason, now: number): number {
    const previous = this.rests.get(slot) ?? this.history.get(slot);
    if (!previous || previous.reason !== reason) return 1;
    if (previous.until + KEY_RATE_FORGET_MS <= now) return 1;
    return previous.n + (previous.until > now ? 0 : 1);
  }

  /** "Retry now", or the key's value changed: its rest, history and last test are gone. */
  clearKey(providerKey: string, keyId: string): void {
    const slot = ByokKeyPool.slot(providerKey, keyId);
    this.rests.delete(slot);
    this.history.delete(slot);
    this.probes.delete(slot);
  }

  clearProvider(providerKey: string): void {
    const prefix = `${providerKey}#`;
    for (const map of [this.rests, this.history, this.probes] as const) {
      for (const slot of [...map.keys()]) if (slot.startsWith(prefix)) map.delete(slot);
    }
  }

  /** A key answered: whatever rest it had is over, and a later failure starts the doubling anew. */
  served(providerKey: string, keyId: string): void {
    const slot = ByokKeyPool.slot(providerKey, keyId);
    this.rests.delete(slot);
    this.history.delete(slot);
  }

  recordProbe(providerKey: string, keyId: string, probe: ApiKeyProbeView): void {
    this.bound(this.probes);
    this.probes.set(ByokKeyPool.slot(providerKey, keyId), probe);
  }

  lastProbe(providerKey: string, keyId: string): ApiKeyProbeView | undefined {
    return this.probes.get(ByokKeyPool.slot(providerKey, keyId));
  }

  /** The first key, in order, that is not resting. */
  pick<T extends { readonly id: string }>(providerKey: string, keys: readonly T[]): T | undefined {
    return keys.find((key) => !this.resting(providerKey, key.id));
  }

  /**
   * With every key resting, the one back soonest from a limit (not a refused key) is asked once:
   * its answer tells whether it is back. Undefined when a key is free or none qualifies.
   */
  probe<T extends { readonly id: string }>(providerKey: string, keys: readonly T[]): T | undefined {
    let best: { key: T; until: number } | undefined;
    for (const key of keys) {
      const rest = this.rest(providerKey, key.id);
      if (!rest) return undefined;
      if (rest.reason === 'auth') continue;
      if (!best || rest.until < best.until) best = { key, until: rest.until };
    }
    return best?.key;
  }

  /** The soonest any of these keys is back, Unix ms. */
  earliestBack(providerKey: string, keys: readonly { readonly id: string }[]): number | undefined {
    let earliest: number | undefined;
    for (const key of keys) {
      const rest = this.rest(providerKey, key.id);
      if (rest && (earliest === undefined || rest.until < earliest)) earliest = rest.until;
    }
    return earliest;
  }

  private bound(map: Map<string, unknown>): void {
    while (map.size >= POOL_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }
}

/**
 * One pool per process: the resolver that routes requests and the management service that shows
 * and tests keys must see the same rests.
 */
let sharedPool: ByokKeyPool | undefined;

export function sharedByokKeyPool(): ByokKeyPool {
  sharedPool ??= new ByokKeyPool();
  return sharedPool;
}
