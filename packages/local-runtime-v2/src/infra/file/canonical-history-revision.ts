import { createHash, type Hash } from 'node:crypto';

import { canonicalJson } from './canonical-history-json-value.js';

/** SHA-256 state after the first `count` records of a revision, before the closing bracket. */
export interface RevisionHashState {
  readonly count: number;
  readonly hash: Hash;
}

/** Stable semantic revision: SHA-256 over the JSON array of recursively key-sorted records. */
export function computeRevision(records: readonly unknown[]): string {
  return revisionDigest(extendRevisionHash(undefined, records, records.length).hash);
}

/**
 * Hashes records [state.count, to) on a copy of `state`, so a history that only grew hashes
 * just its new records. The result matches hashing every record from scratch byte for byte.
 */
export function extendRevisionHash(
  state: RevisionHashState | undefined,
  records: readonly unknown[],
  to: number,
): RevisionHashState {
  const hash = state ? state.hash.copy() : createHash('sha256').update('[');
  for (let index = state?.count ?? 0; index < to; index += 1) {
    if (index > 0) hash.update(',');
    hash.update(canonicalJson(records[index]), 'utf8');
  }
  return { count: to, hash };
}

/** Hashes records one at a time; the digest equals computeRevision over the same records. */
export function createRevisionHasher(): {
  add(record: unknown): void;
  digest(): string;
} {
  const hash = createHash('sha256').update('[');
  let count = 0;
  return {
    add(record) {
      if (count > 0) hash.update(',');
      hash.update(canonicalJson(record), 'utf8');
      count += 1;
    },
    digest: () => revisionDigest(hash),
  };
}

export function revisionDigest(hash: Hash): string {
  return `sha256:${hash.copy().update(']').digest('hex')}`;
}
