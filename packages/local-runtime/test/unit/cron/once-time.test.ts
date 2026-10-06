import { describe, expect, it } from 'vitest';

import { parseOnceRunAtMs } from '../../../src/cron/once-time.js';

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function delayFor(after: string): number {
  return parseOnceRunAtMs({ after }, NOW) - NOW;
}

describe('local runtime cron once relative `after` durations', () => {
  it('accepts a single week unit', () => {
    expect(delayFor('1w')).toBe(WEEK);
    expect(delayFor('2W')).toBe(2 * WEEK);
    expect(delayFor(' 1.5w ')).toBe(1.5 * WEEK);
  });

  it('accepts week units inside compound durations', () => {
    expect(delayFor('1w2d')).toBe(WEEK + 2 * DAY);
    expect(delayFor('1w2d3h4m5s6ms')).toBe(WEEK + 2 * DAY + 3 * HOUR + 4 * MINUTE + 5 * SECOND + 6);
    expect(delayFor('2d1w')).toBe(2 * DAY + WEEK);
  });

  it('keeps the existing units unchanged', () => {
    expect(delayFor('250ms')).toBe(250);
    expect(delayFor('30s')).toBe(30 * SECOND);
    expect(delayFor('10m')).toBe(10 * MINUTE);
    expect(delayFor('2h')).toBe(2 * HOUR);
    expect(delayFor('3d')).toBe(3 * DAY);
    expect(delayFor('1h30m')).toBe(HOUR + 30 * MINUTE);
    // `ms` must still win over `m` followed by a stray `s`.
    expect(delayFor('1m500ms')).toBe(MINUTE + 500);
  });

  it.each(['w', '1x', '1week', '1 w', 'w1', '1w-', '0w', '1y'])(
    'rejects invalid duration %j',
    (after) => {
      expect(() => parseOnceRunAtMs({ after }, NOW)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }),
      );
    },
  );

  it('names the rejected duration in the error message', () => {
    expect(() => parseOnceRunAtMs({ after: '1week' }, NOW)).toThrow(
      'Invalid cron once after duration: "1week"',
    );
  });

  it('rejects long unit-less digit runs in linear time', () => {
    // An unanchored global token pattern retried from every offset took seconds here.
    const after = '1'.repeat(50_000) + 'x';
    const started = performance.now();
    expect(() => parseOnceRunAtMs({ after }, NOW)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 }),
    );
    expect(performance.now() - started).toBeLessThan(500);
  });
});
