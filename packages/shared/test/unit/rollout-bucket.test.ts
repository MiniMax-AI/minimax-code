import { describe, expect, it } from 'vitest';

import { getBucketDigit, stableRolloutHash } from '../../src/rollout-bucket.js';

/**
 * Every expected number below was computed by the implementation as it stood
 * before the hash was extracted, so a change to the DJB2 loop — or to the
 * `% 10` that cuts a bucket out of it — fails here instead of silently moving
 * real users into a different rollout group.
 */
const PINNED: readonly (readonly [string, number, number])[] = [
  ['', 5381, 1],
  ['a', 177670, 0],
  ['1', 177622, 2],
  ['100', 193431990, 0],
  ['200', 193433079, 9],
  ['abc', 193485963, 3],
  ['user-42', 1170314839, 9],
  ['1000000', 857512310, 0],
  ['1000001', 857512311, 1],
  ['123456789012345678', 1700702742, 2],
  ['99999999999', 3130738232, 2],
  ['中文用户', 2834999864, 4],
];

describe('stableRolloutHash', () => {
  it.each(PINNED)('hashes %j to the value every rollout already bucketed on', (value, hash) => {
    expect(stableRolloutHash(value)).toBe(hash);
  });

  it('stays an unsigned 32-bit integer, so a bucket cut from it never goes negative', () => {
    for (const [value] of PINNED) {
      const hash = stableRolloutHash(value);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('reads a non-ASCII ID by code unit, the same way the desktop rollouts always did', () => {
    expect(stableRolloutHash('中文用户')).toBe(2834999864);
    expect(stableRolloutHash('中文用户')).not.toBe(stableRolloutHash('中'));
  });
});

describe('getBucketDigit', () => {
  it.each(PINNED)('keeps %j in bucket %j', (value, _hash, bucket) => {
    expect(getBucketDigit(value)).toBe(bucket);
  });

  it('is the shared hash cut into ten buckets', () => {
    for (const [value] of PINNED) {
      expect(getBucketDigit(value)).toBe(stableRolloutHash(value) % 10);
    }
  });

  it('always answers with a digit a rollout config can list', () => {
    for (let index = 0; index < 500; index++) {
      const bucket = getBucketDigit(`user-${index}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThanOrEqual(9);
    }
  });

  /**
   * The PTC remote default cuts 100 buckets out of this same hash after prefixing
   * the ID, and pins its own bucket in `packages/config/test/ptc-default-config.test.ts`.
   * Pinning the hash here keeps that bucket traceable to this implementation.
   */
  it('is the hash the PTC remote default cuts its own percentage from', () => {
    expect(stableRolloutHash('ptc_default:100')).toBe(2400652827);
    expect(stableRolloutHash('ptc_default:100') % 100).toBe(27);
  });
});
