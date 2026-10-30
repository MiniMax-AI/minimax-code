import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfigFromRaw } from '../src/config.js';
import { parsePromptSuggestionRemotePolicy } from '../src/prompt-suggestion-config.js';
afterEach(() => {
  vi.unstubAllEnvs();
});
describe('prompt suggestion opt-in', () => {
  it.each([undefined, null, [], 'true', { enabled: 'true' }, { enabled: 1 }, { enabled: false }])('defaults off for %j', (value) => {
    vi.stubEnv('__MAVIS_BUILD_INTERNAL', '');
    expect(resolveConfigFromRaw({ promptSuggestion: value }, '/tmp/suggestion-config').promptSuggestion.enabled).toBe(false);
  });
  it('accepts only explicit boolean opt-in', () => {
    expect(resolveConfigFromRaw({ promptSuggestion: { enabled: true } }, '/tmp/suggestion-config').promptSuggestion.enabled).toBe(true);
  });
  it.each([undefined, null, [], { enabled: 'true' }])('defaults on in an internal build for %j', (value) => {
    vi.stubEnv('__MAVIS_BUILD_INTERNAL', 'true');
    expect(resolveConfigFromRaw({ promptSuggestion: value }, '/tmp/suggestion-config').promptSuggestion.enabled).toBe(true);
  });
  it('keeps an explicit opt-out in an internal build', () => {
    vi.stubEnv('__MAVIS_BUILD_INTERNAL', 'true');
    expect(resolveConfigFromRaw({ promptSuggestion: { enabled: false } }, '/tmp/suggestion-config').promptSuggestion.enabled).toBe(false);
  });
  it('keeps rollout policy out of the local config', () => {
    expect(
      resolveConfigFromRaw({ promptSuggestion: { enabled: true, killSwitch: true, sampleRate: 0 } }, '/tmp/suggestion-config').promptSuggestion,
    ).toEqual({ enabled: true, enabledSource: 'explicit' });
  });
  it.each([
    [undefined, 'default'],
    [{ enabled: 'true' }, 'default'],
    [{ enabled: false }, 'explicit'],
    [{ enabled: true }, 'explicit'],
  ] as const)('records whether %j was an explicit choice', (value, source) => {
    expect(resolveConfigFromRaw({ promptSuggestion: value }, '/tmp/suggestion-config').promptSuggestion.enabledSource).toBe(source);
  });
});

describe('prompt suggestion remote policy', () => {
  it('reads the Apollo snake_case fields', () => {
    expect(parsePromptSuggestionRemotePolicy({ kill_switch: true, sample_rate: 0.25 })).toEqual({ killSwitch: true, sampleRate: 0.25 });
  });
  it.each([undefined, null, [], 'x', { kill_switch: 'true' }, { sample_rate: -1 }, { sample_rate: 2 }, { sample_rate: '1' }, { sample_rate: Number.NaN }])(
    'treats %j as no override instead of throwing',
    (raw) => {
      expect(parsePromptSuggestionRemotePolicy(raw)).toEqual({});
    },
  );
  it('keeps the valid field when the other one is malformed', () => {
    expect(parsePromptSuggestionRemotePolicy({ kill_switch: false, sample_rate: 'all' })).toEqual({ killSwitch: false });
  });
});
