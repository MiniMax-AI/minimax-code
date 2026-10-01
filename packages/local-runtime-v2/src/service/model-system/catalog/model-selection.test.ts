import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readLocalModelOverride,
  readLocalModelThinkingSelection,
  readPersistedLocalModelThinkingSelection,
  readSelectedThinkingEffort,
  resolveLegacyMinimaxModel,
  resolveRequestedSessionModel,
  savedSessionModel,
} from './model-selection.js';
import type { LocalRuntimeConfig } from '../contracts.js';

it('uses historical model values only for missing columns and preserves explicit clears', () => {
  const historical = {
    providerId: 'minimax',
    modelId: 'MiniMax-M3.1',
    variant: 'thinking',
    thinking: { effort: 'high' },
    contextWindow: 450_000,
    maxOutputTokens: 8192,
  };
  const session = { effectiveModel: 'minimax/MiniMax-M3.1' };
  expect(savedSessionModel({}, historical)).toBeUndefined();
  expect(savedSessionModel({ effectiveModel: 'minimax/MiniMax-M3' }, historical)).toMatchObject({
    modelId: 'MiniMax-M3',
    thinking: undefined,
    contextWindow: undefined,
    parameterSnapshot: { context: 'selection', effort: 'selection' },
  });
  expect(savedSessionModel(session, historical)).toMatchObject(historical);
  expect(
    savedSessionModel(
      {
        ...session,
        effectiveModelVariant: null,
        effectiveModelThinking: null,
        effectiveModelContextWindow: null,
        effectiveModelMaxOutputTokens: null,
      },
      historical,
    ),
  ).toMatchObject({
    variant: undefined,
    thinking: undefined,
    contextWindow: undefined,
    maxOutputTokens: undefined,
  });
});

it.each(['minimax', 'custom_provider:work'])(
  'preserves explicit BYOK parameters through ordinary create for %s',
  (providerId) => {
    const configuredModel = {
      limit: { context: 512_000 },
      contextWindowOptions: [512_000],
      thinking: { effortOptions: ['high'], defaultEffort: 'high' },
    };
    const config: LocalRuntimeConfig = {
      dataDir: '/isolated-byok-selection',
      ...(providerId === 'minimax' ? { minimaxModelSource: 'minimax_api_key' as const } : {}),
      provider: { minimax: { models: { 'MiniMax-M3': configuredModel } } },
      custom_provider: { work: { models: { 'MiniMax-M3': configuredModel } } },
    };
    const requested = {
      providerId,
      modelId: 'MiniMax-M3',
      variant: 'thinking',
      contextLimit: 450_000,
      thinking: { effort: 'provider-effort' },
    };
    expect(resolveRequestedSessionModel(config, requested)).toEqual(requested);
  },
);

describe('legacy MiniMax compatibility', () => {
  beforeEach(() => {
    vi.stubEnv('MAVIS_REGION', 'cn');
    vi.stubEnv('MAVIS_BUILD_ENV', 'prod');
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['minimax-legacy', 'minimax-legacy-2'])(
    'recovers %s from an old official endpoint while preserving its configuration',
    (key) => {
      const config: LocalRuntimeConfig = {
        dataDir: '/tmp/legacy-model-selection',
        defaultModel: `custom_provider:${key}/retired`,
        provider: { minimax: { models: { 'MiniMax-M3': {} } } },
        custom_provider: {
          [key]: {
            options: {
              baseURL: 'https://agent.minimaxi.com/mavis/api/v1/llm/v1',
              apiKey: 'sk-xxx',
            },
            models: { retired: {} },
          },
        },
      };
      const before = structuredClone(config);
      expect(
        resolveLegacyMinimaxModel(config, {
          providerId: `custom_provider:${key}`,
          modelId: 'retired',
        }),
      ).toEqual({
        providerId: 'minimax',
        modelId: 'MiniMax-M3',
      });
      expect(config).toEqual(before);
      config.custom_provider![key]!.options!.baseURL = 'https://proxy.example/v1';
      expect(
        resolveLegacyMinimaxModel(config, {
          providerId: `custom_provider:${key}`,
          modelId: 'retired',
        }),
      ).toBeUndefined();
    },
  );
});

describe('model selection input', () => {
  it('rejects non-record selections and normalizes supported fields', () => {
    expect(readLocalModelThinkingSelection(null)).toBeUndefined();
    expect(readLocalModelThinkingSelection([])).toBeUndefined();
    expect(
      readLocalModelThinkingSelection({
        effort: ' high ',
        offBehavior: ' disable ',
        budgets: { minimal: 0, low: '1024', medium: false, high: 4096 },
      }),
    ).toEqual({
      effort: 'high',
      off_behavior: 'disable',
      budgets: { minimal: 0, low: '1024', high: 4096 },
    });
    expect(readLocalModelThinkingSelection({ budgets: { medium: false } })).toEqual({});
  });

  it('preserves explicit thinking clears and normalizes model overrides', () => {
    expect(readPersistedLocalModelThinkingSelection({})).toBeNull();
    expect(readPersistedLocalModelThinkingSelection({ effort: 'low' })).toEqual({ effort: 'low' });
    expect(readLocalModelOverride('model')).toBeUndefined();
    expect(readLocalModelOverride({})).toBeUndefined();
    expect(
      readLocalModelOverride({
        providerId: ' custom_provider:work ',
        modelId: ' model-1 ',
        variant: '',
        reasoning: false,
        thinking: {},
      }),
    ).toEqual({
      provider_id: 'custom_provider:work',
      model_id: 'model-1',
      variant: '',
      reasoning: false,
      thinking: {},
    });
  });

  it('reads selected effort from optional capabilities', () => {
    expect(readSelectedThinkingEffort(undefined)).toBeUndefined();
    expect(readSelectedThinkingEffort({ selected_thinking_effort: ' max ' })).toBe('max');
  });
});

it('creates an API-only session before a shared MiniMax catalog exists', () => {
  const config: LocalRuntimeConfig = {
    dataDir: '/tmp/api-only-session-create',
    defaultModel: 'minimax_api/MiniMax-M3',
    provider: {},
    minimax_api: { apiKey: 'api-only-placeholder' },
  };
  expect(
    resolveRequestedSessionModel(config, {
      providerId: 'minimax_api',
      modelId: 'MiniMax-M3',
    }),
  ).toMatchObject({ providerId: 'minimax_api', modelId: 'MiniMax-M3' });
});

describe('ordinary session inherits the selected global effort', () => {
  const model = {
    limit: { context: 512_000, output: 16_000 },
    contextWindowOptions: [512_000, 1_000_000],
    thinking_config: { mode: 'forced_on' as const },
    thinking: { effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  };
  const config: LocalRuntimeConfig = {
    dataDir: '/tmp/global-effort-create',
    defaultModel: 'minimax/MiniMax-M3.1',
    defaultModelThinking: { effort: 'xhigh' },
    provider: { minimax: { models: { 'MiniMax-M3.1': model, 'MiniMax-M3': model } } },
  };

  it('freezes the global effort when creation supplies only the selected model', () => {
    expect(
      resolveRequestedSessionModel(config, {
        providerId: 'minimax',
        modelId: 'MiniMax-M3.1',
        reasoning: true,
      }).thinking,
    ).toEqual({ effort: 'xhigh' });
  });

  it('preserves an explicit per-session effort', () => {
    expect(
      resolveRequestedSessionModel(config, {
        providerId: 'minimax',
        modelId: 'MiniMax-M3.1',
        thinking: { effort: 'low' },
      }).thinking,
    ).toEqual({ effort: 'low' });
  });

  it('does not inherit effort from a different global model', () => {
    const otherDefault = { ...config, defaultModel: 'minimax/MiniMax-M3' };
    expect(
      resolveRequestedSessionModel(otherDefault, {
        providerId: 'minimax',
        modelId: 'MiniMax-M3.1',
      }).thinking,
    ).toEqual({ effort: 'high' });
  });
});
