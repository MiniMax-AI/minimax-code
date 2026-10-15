import { describe, expect, it } from 'vitest';

import {
  isValidCompactionTriggerSetting,
  resolveCompactionTokenBudget,
  resolveConfiguredCompactionTrigger,
  resolveDynamicMaxTokens,
} from '../src/provider-budget.js';

describe('resolveDynamicMaxTokens', () => {
  it('shrinks a Spark output budget from the complete Provider input footprint', () => {
    expect(
      resolveDynamicMaxTokens({
        contextWindow: 128_000,
        configuredMaxTokens: 128_000,
        estimatedContextTokens: 100_000,
      }),
    ).toBe(25_952);
  });
});

describe('resolveCompactionTokenBudget', () => {
  it.each([
    [200_000, 181_568],
    [400_000, 380_000],
    [512_000, 486_400],
    [1_000_000, 950_000],
  ] as const)('caps a %i-token context at the conservative Provider limit', (contextWindow, expected) => {
    expect(
      resolveCompactionTokenBudget({
        contextWindow,
        configuredMaxOutputTokens: 16_384,
      }).providerInputLimit,
    ).toBe(expected);
  });

  it.each([
    ['1M context', 1_000_000, 128_000, 950_000, 828_400],
    ['512K context', 512_000, 128_000, 486_400, 364_800],
    ['roomy 400K context', 400_000, 128_000, 380_000, 285_000],
    ['gpt-5.4 output floor', 272_000, 128_000, 253_568, 193_800],
    ['MiniMax-M2.7 window', 200_000, 128_000, 181_568, 142_500],
    ['256K relay window', 256_000, 128_000, 237_568, 182_400],
    ['Spark dynamic fallback', 128_000, 128_000, 109_568, 91_200],
    ['1M context with a small output limit', 1_000_000, 32_000, 950_000, 919_600],
    ['64K context capped by the hard limit', 64_000, 128_000, 45_568, 45_568],
    ['caller-limited output', 65_536, 8_192, 49_152, 49_152],
  ] as const)(
    'resolves the shared input limit and automatic trigger for %s',
    (_case, contextWindow, configuredMaxOutputTokens, providerInputLimit, automaticTriggerAt) => {
      expect(
        resolveCompactionTokenBudget({ contextWindow, configuredMaxOutputTokens }),
      ).toEqual({ providerInputLimit, automaticTriggerAt });
    },
  );

  it.each([
    ['65K context', 65_536, 46_694],
    ['Spark', 128_000, 106_035],
    ['large context', 272_000, 242_835],
  ] as const)(
    'reserves a small configured output below the window-quarter cap for %s',
    (_case, contextWindow, automaticTriggerAt) => {
      expect(
        resolveCompactionTokenBudget({
          contextWindow,
          configuredMaxOutputTokens: 16_384,
        }).automaticTriggerAt,
      ).toBe(automaticTriggerAt);
    },
  );

  it('leaves the configured output room when a large window reaches the trigger', () => {
    const contextWindow = 1_000_000;
    const configuredMaxTokens = 128_000;
    const { automaticTriggerAt } = resolveCompactionTokenBudget({
      contextWindow,
      configuredMaxOutputTokens: configuredMaxTokens,
    });

    expect(
      resolveDynamicMaxTokens({
        contextWindow,
        configuredMaxTokens,
        estimatedContextTokens: automaticTriggerAt,
      }),
    ).toBe(configuredMaxTokens);
  });

  it.each([Number.NaN, 0])('ignores an invalid configured output limit: %s', (configuredMaxOutputTokens) => {
    expect(
      resolveCompactionTokenBudget({
        contextWindow: 65_536,
        configuredMaxOutputTokens,
      }).providerInputLimit,
    ).toBe(49_152);
  });

  it('clamps an invalidly small context to one token', () => {
    expect(
      resolveCompactionTokenBudget({
        contextWindow: 1,
        configuredMaxOutputTokens: 128_000,
      }),
    ).toEqual({ providerInputLimit: 1, automaticTriggerAt: 1 });
  });

  it.each([
    ['a window ratio', 0.5, 100_000],
    ['an absolute token count', 120_000, 120_000],
    ['a tiny absolute count without a floor', 5_000, 5_000],
  ] as const)('lowers the automatic trigger to %s', (_case, compactionTriggerAt, expected) => {
    const budget = resolveCompactionTokenBudget({
      contextWindow: 200_000,
      configuredMaxOutputTokens: 32_000,
      compactionTriggerAt,
    });
    expect(budget).toEqual({ providerInputLimit: 181_568, automaticTriggerAt: expected });
  });

  it.each([
    ['a ratio above the built-in line', 0.95],
    ['the whole window', 1],
    ['an absolute count above the built-in line', 190_000],
  ] as const)('keeps the built-in trigger for %s', (_case, compactionTriggerAt) => {
    expect(
      resolveCompactionTokenBudget({
        contextWindow: 200_000,
        configuredMaxOutputTokens: 32_000,
        compactionTriggerAt,
      }).automaticTriggerAt,
    ).toBe(159_600);
  });

  it.each([1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined])(
    'ignores an invalid compaction trigger: %s',
    (compactionTriggerAt) => {
      expect(
        resolveCompactionTokenBudget({
          contextWindow: 200_000,
          configuredMaxOutputTokens: 32_000,
          compactionTriggerAt,
        }).automaticTriggerAt,
      ).toBe(159_600);
    },
  );
});

describe('resolveConfiguredCompactionTrigger', () => {
  it.each([
    [0.8, 200_000, 160_000],
    [1, 200_000, 200_000],
    [0.000001, 200_000, 1],
    [300_000, 200_000, 300_000],
    [2, 200_000, 2],
  ] as const)('resolves %s against a %i-token window to %i', (value, window, expected) => {
    expect(resolveConfiguredCompactionTrigger(value, window)).toBe(expected);
  });

  it.each([
    [1.5, 200_000],
    [0, 200_000],
    [-0.5, 200_000],
    [Number.NaN, 200_000],
    [Number.POSITIVE_INFINITY, 200_000],
    [0.8, 0],
    [0.8, Number.NaN],
  ] as const)('treats %s with a %s-token window as unset', (value, window) => {
    expect(resolveConfiguredCompactionTrigger(value, window)).toBeUndefined();
  });

  it('accepts an absolute count even when the window is unknown', () => {
    expect(resolveConfiguredCompactionTrigger(50_000, Number.NaN)).toBe(50_000);
  });
});

describe('isValidCompactionTriggerSetting', () => {
  it.each([0.5, 1, 2, 300_000])('accepts %s', (value) => {
    expect(isValidCompactionTriggerSetting(value)).toBe(true);
  });

  it.each([1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])(
    'rejects %s',
    (value) => {
      expect(isValidCompactionTriggerSetting(value)).toBe(false);
    },
  );
});
