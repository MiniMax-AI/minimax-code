import { describe, expect, it } from 'vitest';

import {
  parseAdvisorConfigFields,
  resolveAdvisorDefaultEnabled,
  resolveAdvisorEnabled,
  type AdvisorSwitchConfigView,
} from '../src/advisor-config.js';

const PRESET = 'cn-prod';
const OFFICIAL = {
  options: { authMode: 'managed-login', baseURL: 'https://agent.minimax.cn' },
  models: { 'MiniMax-M3': {}, 'MiniMax-M3.1': {} },
};
const OWN = { options: { baseURL: 'https://provider.example.com/v1' }, models: { critic: {} } };

describe('resolveAdvisorDefaultEnabled', () => {
  it.each<[string, AdvisorSwitchConfigView, boolean]>([
    ['only the signed-in official catalog', { provider: { minimax: OFFICIAL } }, false],
    [
      'a MiniMax API key alone',
      { provider: { minimax: OFFICIAL }, minimaxModelSource: 'minimax_api_key', minimax_api: { apiKey: 'k' } },
      false,
    ],
    [
      'an official model the catalog recommends',
      { provider: { minimax: { ...OFFICIAL, models: { 'MiniMax-M3': { advisorRecommended: true } } } } },
      true,
    ],
    [
      'a recommended official model the user disabled',
      {
        provider: {
          minimax: { ...OFFICIAL, models: { 'MiniMax-M3': { advisorRecommended: true, enabled: false } } },
        },
      },
      false,
    ],
    ['a custom provider with an enabled model', { custom_provider: { work: OWN } }, true],
    ['a disabled custom provider', { custom_provider: { work: { ...OWN, enabled: false } } }, false],
    ['a custom provider whose models are all off', { custom_provider: { work: { models: { critic: { enabled: false } } } } }, false],
    ['a withdrawn subscription', { custom_provider: { codex: { ...OWN, withdrawn: true } } }, false],
    [
      'a generated legacy MiniMax alias',
      { custom_provider: { 'minimax-legacy': { options: { baseURL: 'https://agent.minimax.cn' }, models: { 'MiniMax-M3': {} } } } },
      false,
    ],
    ['a hand-configured provider', { provider: { minimax: OFFICIAL, acme: OWN } }, true],
    [
      'a hand-configured MiniMax provider with an API key',
      { provider: { minimax: { ...OFFICIAL, options: { authMode: 'api-key', apiKey: 'k' } } } },
      false,
    ],
  ])('with %s', (_label, config, expected) => {
    expect(resolveAdvisorDefaultEnabled(config, PRESET)).toBe(expected);
  });
});

describe('resolveAdvisorEnabled', () => {
  it('keeps the user choice over the default both ways', () => {
    expect(resolveAdvisorEnabled({ custom_provider: { work: OWN }, advisor: { enabled: false } }, PRESET)).toBe(false);
    expect(resolveAdvisorEnabled({ provider: { minimax: OFFICIAL }, advisor: { enabled: true } }, PRESET)).toBe(true);
    expect(resolveAdvisorEnabled({ provider: { minimax: OFFICIAL }, advisor: {} }, PRESET)).toBe(false);
  });
});

describe('parseAdvisorConfigFields', () => {
  it('keeps only an explicit boolean switch, so an unset one stays unset', () => {
    expect(parseAdvisorConfigFields({ advisor: { enabled: false } }).advisor).toEqual({ enabled: false });
    expect(parseAdvisorConfigFields({ advisor: { enabled: 'yes' } }).advisor).toEqual({});
    expect(parseAdvisorConfigFields({}).advisor).toEqual({});
  });
});
