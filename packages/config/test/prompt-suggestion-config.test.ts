import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfigFromRaw } from '../src/config.js';
import {
  parsePromptSuggestionRemotePolicy,
  resolvePromptSuggestionEnabled,
  withEffectivePromptSuggestion,
} from '../src/prompt-suggestion-config.js';
afterEach(() => {
  vi.unstubAllEnvs();
});
describe('prompt suggestion opt-in', () => {
  it.each([undefined, null, [], 'true', { enabled: 'true' }, { enabled: 1 }])('keeps %j as unset', (value) => {
    expect(resolveConfigFromRaw({ promptSuggestion: value }, '/tmp/suggestion-config').promptSuggestion.enabled).toBeUndefined();
  });
  it.each([true, false])('keeps the explicit choice %s', (enabled) => {
    expect(resolveConfigFromRaw({ promptSuggestion: { enabled } }, '/tmp/suggestion-config').promptSuggestion.enabled).toBe(enabled);
  });
  it('does not resolve the build default while parsing', () => {
    // The effective default needs the remote policy, which parsing cannot see.
    vi.stubEnv('__MAVIS_BUILD_INTERNAL', 'true');
    expect(resolveConfigFromRaw({}, '/tmp/suggestion-config').promptSuggestion.enabled).toBeUndefined();
  });
  it('keeps rollout policy out of the local config', () => {
    expect(
      resolveConfigFromRaw({ promptSuggestion: { enabled: true, killSwitch: true, sampleRate: 0 } }, '/tmp/suggestion-config').promptSuggestion,
    ).toEqual({ enabled: true });
  });
});

describe('prompt suggestion effective opt-in', () => {
  it.each([
    // explicit, remote default, expected
    [true, false, true],
    [false, true, false],
    [false, undefined, false],
    [undefined, undefined, true],
    [undefined, true, true],
    [undefined, false, false],
  ] as const)('explicit %s, remote default %s → %s', (explicit, defaultEnabled, expected) => {
    const remote = defaultEnabled === undefined ? {} : { defaultEnabled };
    expect(resolvePromptSuggestionEnabled(explicit, remote)).toBe(expected);
  });
  it('treats every build the same', () => {
    // No build, account or model is special-cased: only the remote switch differs.
    vi.stubEnv('__MAVIS_BUILD_INTERNAL', 'true');
    expect(resolvePromptSuggestionEnabled(undefined, { defaultEnabled: false })).toBe(false);
    vi.stubEnv('__MAVIS_BUILD_INTERNAL', '');
    expect(resolvePromptSuggestionEnabled(undefined, undefined)).toBe(true);
  });
  it('fills the effective value into the config every reader sees', () => {
    const config = { dataDir: '/tmp/x', promptSuggestion: {} };
    expect(withEffectivePromptSuggestion(config, { defaultEnabled: false })).toEqual({
      dataDir: '/tmp/x',
      promptSuggestion: { enabled: false },
    });
    expect(withEffectivePromptSuggestion({ dataDir: '/tmp/x' }, undefined)).toEqual({
      dataDir: '/tmp/x',
      promptSuggestion: { enabled: true },
    });
  });
});

describe('prompt suggestion remote policy', () => {
  it('reads the Apollo snake_case fields', () => {
    expect(parsePromptSuggestionRemotePolicy({ kill_switch: true, sample_rate: 0.25, default_enabled: true })).toEqual({
      killSwitch: true,
      sampleRate: 0.25,
      defaultEnabled: true,
    });
  });
  it.each([
    undefined,
    null,
    [],
    'x',
    { kill_switch: 'true' },
    { sample_rate: -1 },
    { sample_rate: 2 },
    { sample_rate: '1' },
    { sample_rate: Number.NaN },
    { default_enabled: 'true' },
    { default_enabled: 1 },
  ])('treats %j as no override instead of throwing', (raw) => {
    expect(parsePromptSuggestionRemotePolicy(raw)).toEqual({});
  });
  it('keeps the valid field when the other one is malformed', () => {
    expect(parsePromptSuggestionRemotePolicy({ kill_switch: false, sample_rate: 'all' })).toEqual({ killSwitch: false });
  });
});
