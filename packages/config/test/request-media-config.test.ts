import { describe, expect, it } from 'vitest';

import { parseRequestMediaConfig, REQUEST_MEDIA_DEFAULTS } from '../src/index.js';

const DEFAULT_IMAGE = { max_width: 2_000, max_height: 2_000, max_base64_bytes: 4.5 * 1024 * 1024 };

describe('parseRequestMediaConfig', () => {
  it('reads a recovery divisor above 1 and falls back to 2 otherwise', () => {
    expect(REQUEST_MEDIA_DEFAULTS.recoveryDivisor).toBe(2);
    expect(parseRequestMediaConfig({ recoveryDivisor: 3 }).recoveryDivisor).toBe(3);
    expect(parseRequestMediaConfig({ recoveryDivisor: 1.5 }).recoveryDivisor).toBe(1.5);
    for (const raw of [undefined, null, [], {}, { recoveryDivisor: 1 }, { recoveryDivisor: '3' }]) {
      expect(parseRequestMediaConfig(raw)).toEqual({ recoveryDivisor: 2, image: DEFAULT_IMAGE });
    }
  });

  it('reads the per-image limits and falls back per field', () => {
    expect(REQUEST_MEDIA_DEFAULTS.image).toEqual(DEFAULT_IMAGE);
    expect(
      parseRequestMediaConfig({
        image: { max_width: 1_600, max_height: 1_600, max_base64_bytes: 153_600 },
      }).image,
    ).toEqual({ max_width: 1_600, max_height: 1_600, max_base64_bytes: 153_600 });
    expect(
      parseRequestMediaConfig({ image: { max_width: 0, max_height: 1.5, max_base64_bytes: '1' } })
        .image,
    ).toEqual(DEFAULT_IMAGE);
    expect(parseRequestMediaConfig({ image: { max_height: 900 } }).image).toEqual({
      ...DEFAULT_IMAGE,
      max_height: 900,
    });
  });

  it('caps the per-image bytes at the strictest provider limit', () => {
    expect(
      parseRequestMediaConfig({ image: { max_base64_bytes: 64 * 1024 * 1024 } }).image
        .max_base64_bytes,
    ).toBe(5 * 1024 * 1024);
  });
});
