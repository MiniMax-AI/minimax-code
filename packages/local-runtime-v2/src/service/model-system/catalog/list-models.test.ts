import { ThinkingLevel } from '@mavis/protocol';
import { describe, expect, it } from 'vitest';

import type { LocalCustomProviderConfig, LocalRuntimeConfig } from '../contracts.js';
import { resolveThinkingLevel } from '../resolution/model-ref.js';
import {
  buildModelEntry,
  builtinProviderKind,
  cacheStatusView,
  customProviderKind,
  defaultThinkingVariant,
  enabledCustomProviders,
  hasMinimaxApiKey,
  listByokRuntimeModels,
  modelConfigForRef,
  normalizeModelThinkingConfig,
  normalizeSupportedVariants,
  routeModelEntries,
} from './list-models.js';

function config(overrides: Partial<LocalRuntimeConfig> = {}): LocalRuntimeConfig {
  return { dataDir: '/tmp/list-models-test', provider: {}, ...overrides };
}

describe('model catalog helpers', () => {
  it('classifies provider authentication modes', () => {
    expect(customProviderKind({ kind: 'oauth' })).toBe('oauth');
    expect(customProviderKind({ options: { authMode: 'oauth' } })).toBe('oauth');
    expect(customProviderKind({})).toBe('custom');

    expect(builtinProviderKind(config(), 'openai-codex', { options: { authMode: 'oauth' } })).toBe(
      'oauth',
    );
    expect(
      builtinProviderKind(config(), 'minimax', { options: { authMode: 'managed-login' } }),
    ).toBe('minimax-managed');
    expect(
      builtinProviderKind(config({ minimaxModelSource: 'minimax_api_key' }), 'minimax', {
        options: { authMode: 'managed-login' },
      }),
    ).toBe('minimax-api-key');
    expect(builtinProviderKind(config(), 'work', { options: { authMode: 'api-key' } })).toBe(
      'minimax-api-key',
    );

    expect(hasMinimaxApiKey(config())).toBe(false);
    expect(hasMinimaxApiKey(config({ minimax_api: { apiKey: '  sk-test  ' } }))).toBe(true);
  });

  it('reads configured models and enabled custom providers', () => {
    const runtimeConfig = config({
      provider: { builtin: { models: { base: { name: 'Base' } } } },
      custom_provider: {
        work: { models: { custom: { name: 'Custom' } } },
        disabled: { enabled: false, models: { hidden: {} } },
      },
    });

    expect(modelConfigForRef(runtimeConfig, 'builtin', 'base')).toEqual({ name: 'Base' });
    expect(modelConfigForRef(runtimeConfig, 'custom_provider:work', 'custom')).toEqual({
      name: 'Custom',
    });
    expect(modelConfigForRef(runtimeConfig, 'custom_provider:missing', 'custom')).toBeUndefined();
    expect(enabledCustomProviders(config())).toEqual([]);
    expect(enabledCustomProviders(runtimeConfig).map(([key]) => key)).toEqual(['work']);
  });

  it('uses the user-owned MiniMax API context instead of the managed model entry', () => {
    const runtimeConfig = config({
      minimaxModelSource: 'minimax_api_key',
      minimax_api: { modelContextLimits: { 'MiniMax-M3': 1_000_000 } },
      provider: {
        minimax: {
          models: { 'MiniMax-M3': { limit: { context: 256_000 } } },
        },
      },
    });

    expect(
      routeModelEntries(runtimeConfig, 'minimax', runtimeConfig.provider.minimax ?? {}).find(
        ([modelId]) => modelId === 'MiniMax-M3',
      )?.[1].limit?.context,
    ).toBe(1_000_000);
    expect(modelConfigForRef(runtimeConfig, 'minimax', 'MiniMax-M3')?.limit?.context).toBe(
      1_000_000,
    );
  });

  it('lists managed models in the configured catalog order', () => {
    const runtimeConfig = config({
      provider: {
        minimax: {
          options: { authMode: 'managed-login' },
          model_order: ['MiniMax-M3.1', 'MiniMax-M3'],
          models: { 'MiniMax-M3': {}, 'MiniMax-M3.1': {} },
        },
      },
    });

    expect(
      routeModelEntries(runtimeConfig, 'minimax', runtimeConfig.provider.minimax ?? {}).map(
        ([modelId]) => modelId,
      ),
    ).toEqual(['MiniMax-M3.1', 'MiniMax-M3']);
  });

  it('normalizes cached status, thinking modes, and variants', () => {
    expect(cacheStatusView(undefined)).toBeUndefined();
    expect(
      cacheStatusView({
        state: 'failed',
        last_tested_at: 1_750_000_000_000,
        last_error_code: 'unauthorized',
        last_error_message: 'Authentication failed',
      }),
    ).toEqual({
      state: 'failed',
      lastTestedAt: 1_750_000_000_000,
      lastErrorCode: 'unauthorized',
      lastErrorMessage: 'Authentication failed',
    });

    expect(normalizeModelThinkingConfig(null)).toBeUndefined();
    expect(normalizeModelThinkingConfig({ mode: 1 })).toBeUndefined();
    expect(normalizeModelThinkingConfig({ mode: 'unknown' })).toBeUndefined();
    expect(normalizeModelThinkingConfig({ mode: 'switchable', defaultValue: 'true' })).toEqual({
      mode: 'switchable',
      default_value: 'true',
    });
    expect(normalizeModelThinkingConfig({ mode: 'forced_on', default_value: 'true' })).toEqual({
      mode: 'forced_on',
    });

    expect(normalizeSupportedVariants(null)).toBeUndefined();
    expect(normalizeSupportedVariants({ disabled: { disabled: true } })).toBeUndefined();
    expect(
      normalizeSupportedVariants({
        thinking: {},
        'none-thinking': {},
        duplicate: {},
      }),
    ).toEqual(['thinking', '', 'duplicate']);
    expect(defaultThinkingVariant({ mode: 'forced_on' }, undefined)).toBe('thinking');
    expect(defaultThinkingVariant({ mode: 'forced_off' }, undefined)).toBe('');
    expect(defaultThinkingVariant({ mode: 'switchable', default_value: 'true' }, undefined)).toBe(
      'thinking',
    );
    expect(defaultThinkingVariant({ mode: 'switchable' }, 'none-thinking')).toBe('');
    expect(defaultThinkingVariant({ mode: 'hidden' }, undefined)).toBeUndefined();
  });
});

describe('model catalog entry helpers', () => {
  it.each([
    { contextWindowOptions: [512_000, 1_000_000], expectedOptions: [512_000, 1_000_000] },
    { contextWindowOptions: undefined, expectedOptions: undefined },
    { contextWindowOptions: [1_000_000], expectedOptions: undefined },
  ])(
    'keeps managed defaults with context options $contextWindowOptions',
    ({ contextWindowOptions, expectedOptions }) => {
      const entry = buildModelEntry({
        providerId: 'minimax',
        modelId: 'configured',
        model: {
          limit: { context: 512_000 },
          contextWindowOptions,
          thinking: { defaultEffort: 'max' },
        },
        selected: false,
        providerSource: 'provider',
        providerKind: 'minimax-managed',
        providerName: 'MiniMax',
      });
      expect(entry).toMatchObject({
        contextLimit: 512_000,
        defaultContextLimit: 512_000,
        defaultEffort: 'max',
      });
      expect(entry.contextWindowOptions).toEqual(expectedOptions);
      expect(entry.effortOptions).toBeUndefined();
    },
  );

  it('builds rich and implicit model entries', () => {
    const rich = buildModelEntry({
      providerId: 'custom_provider:work',
      modelId: 'model-1',
      model: {
        name: 'Model 1',
        enabled: false,
        configuration_source: 'manual',
        limit: { context: 200_000, output: 32_000 },
        contextWindowOptions: [100_000, 200_000],
        modalities: { input: ['text', 'image'], output: ['text'] },
        thinking: { effortOptions: ['low', 'high'], defaultEffort: 'high' },
        thinking_config: { mode: 'switchable', default_value: 'false' },
        variants: { thinking: {}, 'none-thinking': {} },
      },
      selected: true,
      selectionVariant: 'thinking',
      hasSelectionVariant: true,
      providerSource: 'custom_provider',
      providerKind: 'custom',
      providerName: 'Work',
      status: { state: 'available', last_tested_at: 1_750_000_000_000 },
    });
    expect(rich).toMatchObject({
      displayName: 'Model 1',
      enabled: false,
      configurationSource: 'manual',
      contextLimit: 200_000,
      contextWindowOptions: [100_000, 200_000],
      maxOutputTokens: 32_000,
      modalities: { input: ['text', 'image'], output: ['text'] },
      effortOptions: ['low', 'high'],
      defaultEffort: 'high',
      supportedVariants: ['thinking', ''],
      variant: 'thinking',
      status: { state: 'available', lastTestedAt: 1_750_000_000_000 },
    });

    expect(
      buildModelEntry({
        providerId: 'custom_provider:work',
        modelId: 'historical',
        model: {},
        selected: true,
        selectionVariant: null,
        hasSelectionVariant: true,
        providerSource: 'custom_provider',
        providerKind: 'custom',
        providerName: 'Work',
        implicitCustomProviderThinking: true,
      }),
    ).toMatchObject({
      displayName: 'historical',
      thinkingConfig: { mode: 'switchable', default_value: 'false' },
    });

    expect(
      buildModelEntry({
        providerId: 'custom_provider:work',
        modelId: 'new',
        model: {
          reasoning: true,
          thinking_config: { mode: 'switchable', default_value: 'true' },
        },
        selected: true,
        providerSource: 'custom_provider',
        providerKind: 'custom',
        providerName: 'Work',
        implicitCustomProviderThinking: true,
      }),
    ).toMatchObject({
      displayName: 'new',
      thinkingConfig: { mode: 'switchable', default_value: 'true' },
      variant: 'thinking',
    });

    const effortOnly = buildModelEntry({
      providerId: 'custom_provider:work',
      modelId: 'effort-only',
      model: { thinking: { effortOptions: ['none', 'high'] } },
      selected: false,
      providerSource: 'custom_provider',
      providerKind: 'custom',
      providerName: 'Work',
      implicitCustomProviderThinking: true,
    });
    expect(effortOnly).toMatchObject({
      displayName: 'effort-only',
      effortOptions: ['none', 'high'],
      thinkingConfig: { mode: 'forced_on' },
    });
  });

  it('exposes Kimi K3 low/high/max effort options in the model roster', () => {
    const entry = buildModelEntry({
      providerId: 'custom_provider:moonshotai',
      modelId: 'kimi-k3',
      model: {
        name: 'Kimi K3',
        reasoning: true,
        thinking: { effortOptions: ['low', 'high', 'max'] },
      },
      selected: false,
      providerSource: 'custom_provider',
      providerKind: 'custom',
      providerName: 'Moonshot AI',
    });

    expect(entry).toMatchObject({
      modelId: 'kimi-k3',
      displayName: 'Kimi K3',
      effortOptions: ['low', 'high', 'max'],
    });
    expect(entry.defaultEffort).toBeUndefined();
  });

  it('exposes context option hints only for managed models', () => {
    const model = {
      limit: { context: 512_000 },
      contextWindowOptions: [512_000, 1_000_000],
      contextWindowOptionHints: { '1000000': 'higher_usage' as const },
    };
    const managed = buildModelEntry({
      providerId: 'minimax',
      modelId: 'MiniMax-M3',
      model,
      selected: true,
      providerSource: 'provider',
      providerKind: 'minimax-managed',
      providerName: 'MiniMax',
    });
    const byok = buildModelEntry({
      providerId: 'minimax',
      modelId: 'MiniMax-M3',
      model,
      selected: true,
      providerSource: 'provider',
      providerKind: 'minimax-api-key',
      providerName: 'MiniMax API',
    });

    expect(managed).toHaveProperty('contextWindowOptionHints', {
      '1000000': 'higher_usage',
    });
    expect(byok).not.toHaveProperty('contextWindowOptionHints');
  });

  it('lists only enabled models and applies selection defaults', () => {
    const providerWithoutModels: LocalCustomProviderConfig = {};
    const work: LocalCustomProviderConfig = {
      options: { authMode: 'oauth' },
      models: {
        enabled: {},
        disabled: { enabled: false },
      },
    };
    const runtimeConfig = config({
      custom_provider: { empty: providerWithoutModels, work },
    });

    expect(listByokRuntimeModels(runtimeConfig)).toEqual([
      expect.objectContaining({
        providerId: 'custom_provider:work',
        providerName: 'work',
        providerKind: 'oauth',
        modelId: 'enabled',
        selected: false,
      }),
    ]);
    expect(
      listByokRuntimeModels(runtimeConfig, {
        providerId: 'custom_provider:work',
        modelId: 'enabled',
        variant: 'thinking',
        hasVariant: true,
      }),
    ).toEqual([
      expect.objectContaining({ modelId: 'enabled', selected: true, variant: 'thinking' }),
    ]);
  });
});

describe('implicit custom provider reasoning policies', () => {
  function implicitEntry(reasoning: boolean) {
    return buildModelEntry({
      providerId: 'custom_provider:work',
      modelId: `explicit-${reasoning}`,
      model: { reasoning },
      selected: true,
      providerSource: 'custom_provider',
      providerKind: 'custom',
      providerName: 'Work',
      implicitCustomProviderThinking: true,
    });
  }

  it('keeps a reasoning-capable model switchable and on by default', () => {
    // `reasoning: true` is catalog capability metadata, not a user opt-in, so it
    // must not suppress the switch. The default mirrors the level the resolver
    // already sent for this config, leaving effective behaviour unchanged.
    const entry = implicitEntry(true);
    expect(entry.thinkingConfig).toEqual({ mode: 'switchable', default_value: 'true' });
    expect(entry.variant).toBe('thinking');
    expect(resolveThinkingLevel({ reasoning: true }, entry.variant, true)).toBe(
      ThinkingLevel.MEDIUM,
    );
  });

  it('preserves an explicit reasoning opt-out without implicit thinking config', () => {
    const entry = implicitEntry(false);
    expect(entry).not.toHaveProperty('thinkingConfig');
    expect(entry).not.toHaveProperty('variant');
    expect(resolveThinkingLevel({ reasoning: false }, entry.variant, true)).toBe(ThinkingLevel.OFF);
  });
});

describe('TUI BYOK think toggle across persisted model shapes', () => {
  // Every shape a custom-provider model can take on disk. The TUI only renders a
  // think control when `thinkingConfig.mode === 'switchable'`, so a model that
  // reports no thinking config is stuck on whatever the resolver infers.
  function byokRoster() {
    return listByokRuntimeModels(
      config({
        custom_provider: {
          'provider-e5321b': {
            name: 'Z.AI Coding Plan',
            api: 'openai-completions',
            options: { apiKey: 'test-key', baseURL: 'https://example.invalid/v1' },
            models: {
              // Added from a known provider template: presets always persist a
              // boolean `reasoning` derived from the models.dev catalog.
              preset: { name: 'Preset', reasoning: true },
              'preset-without-reasoning': { name: 'No Reasoning', reasoning: false },
              // Added through the manual "Custom provider" path.
              manual: { name: 'Manual' },
              // Persisted before implicit thinking existed.
              historical: {},
            },
          },
        },
      }),
      undefined,
      undefined,
      { implicitCustomProviderThinking: true },
    );
  }

  function thinkingConfigFor(modelId: string) {
    const entry = byokRoster().find((candidate) => candidate.modelId === modelId);
    if (!entry) throw new Error(`model ${modelId} missing from the BYOK roster`);
    return entry.thinkingConfig;
  }

  it.each([
    { modelId: 'preset', expected: { mode: 'switchable', default_value: 'true' } },
    { modelId: 'manual', expected: { mode: 'switchable', default_value: 'false' } },
    { modelId: 'historical', expected: { mode: 'switchable', default_value: 'false' } },
  ])('offers a think toggle for the $modelId model', ({ modelId, expected }) => {
    expect(thinkingConfigFor(modelId)).toEqual(expected);
  });

  it('offers no toggle when the model cannot reason', () => {
    expect(thinkingConfigFor('preset-without-reasoning')).toBeUndefined();
  });
});
