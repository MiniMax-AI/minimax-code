import { describe, expect, it } from 'vitest';
import {
  getKnownThinkingEffortRank,
  normalizeThinkingEffortList,
  sortThinkingEffortOptions,
} from '../../src/thinking-effort.js';

describe('thinking-effort keyword ordering', () => {
  it('orders standard effort ladders from weak to strong', () => {
    expect(normalizeThinkingEffortList(['high', 'medium', 'low'])).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(
      normalizeThinkingEffortList(['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']),
    ).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(normalizeThinkingEffortList(['on', 'off'])).toEqual(['off', 'on']);
  });

  it('matches case-insensitively while preserving authored casing', () => {
    expect(normalizeThinkingEffortList(['MAX', 'High', 'Low'])).toEqual(['Low', 'High', 'MAX']);
    expect(getKnownThinkingEffortRank(' XHigh ')).toBe(getKnownThinkingEffortRank('x-high'));
  });

  it('keeps equal-rank synonyms stable in input order', () => {
    expect(normalizeThinkingEffortList([' low ', 'light', 'low', '', 'max'])).toEqual([
      'low',
      'light',
      'max',
    ]);
    expect(normalizeThinkingEffortList(['none', 'off', 'high'])).toEqual(['none', 'off', 'high']);
  });

  it('preserves unrecognized vendor tiers and default sentinel in their original slots', () => {
    expect(sortThinkingEffortOptions(['custom-tier', 'turbo'])).toEqual(['custom-tier', 'turbo']);
    expect(sortThinkingEffortOptions(['default', 'high', 'medium', 'low'])).toEqual([
      'default',
      'low',
      'medium',
      'high',
    ]);
    expect(sortThinkingEffortOptions(['low', 'default', 'high'])).toEqual([
      'low',
      'default',
      'high',
    ]);
    expect(sortThinkingEffortOptions(['nano-tier', 'high', 'low', 'megathink'])).toEqual([
      'nano-tier',
      'low',
      'high',
      'megathink',
    ]);
  });
});
