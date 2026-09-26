import { describe, expect, it } from 'vitest';

import {
  resolveCompactionTokenBudget,
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
});
