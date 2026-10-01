import { describe, expect, it } from 'vitest';

import type { LocalConversationRuntimeConfig } from '../contracts.js';
import {
  AgentModelSelectionError,
  type AgentModelSelectionInput,
  resolveEffectiveAgentModelSelection,
  previewAgentModelSelection,
  resolveBuiltinAgentModelGroup,
  resolveAgentModelSelection,
} from './agent-model-selection.js';

const config: LocalConversationRuntimeConfig = {
  dataDir: '/data',
  defaultModel: 'runtime/default',
  provider: {
    runtime: {
      models: {
        default: {
          limit: { context: 128_000, output: 8_192 },
          thinking: { effortOptions: ['low', 'medium', 'high'] },
        },
      },
    },
    parent: {
      models: {
        inherited: {
          limit: { context: 64_000, output: 4_096 },
          thinking: { effortOptions: ['low', 'high'] },
        },
      },
    },
    target: {
      models: {
        replacement: {
          limit: { context: 32_000, output: 2_048 },
          thinking: { effortOptions: ['minimal', 'medium'] },
        },
      },
    },
  },
};

describe('resolveAgentModelSelection', () => {
  it('keeps the editor preview available after model removal while session capture still rejects it', () => {
    const input = {
      config,
      sources: [{ source: 'agent', selection: { model: 'target/deleted' }, requireCatalog: true }],
    };
    expect(previewAgentModelSelection(input)).toBeUndefined();
    expect(() => resolveEffectiveAgentModelSelection(input)).toThrow(AgentModelSelectionError);
    expect(input.sources[0]?.selection.model).toBe('target/deleted');
  });

  it('validates new partial fields while retaining only unchanged accepted parent values', () => {
    const select = (selection: AgentModelSelectionInput) =>
      resolveAgentModelSelection({
        config: {
          ...config,
          provider: {
            minimax: {
              models: {
                'MiniMax-M3.1': {
                  limit: { context: 512_000, output: 128_000 },
                  contextWindowOptions: [512_000],
                  thinking_config: { mode: 'forced_on' },
                  thinking: { effortOptions: ['high'], defaultEffort: 'high' },
                },
              },
            },
          },
        },
        sources: [
          { source: 'agent-override', selection },
          {
            source: 'accepted-parent',
            selection: { model: 'minimax/MiniMax-M3.1', contextWindow: 1_000_000, effort: 'max' },
            parameterSnapshot: { context: 'selection', effort: 'selection' },
          },
        ],
      });
    expect(() => select({ contextWindow: 768_000 })).toThrow('Invalid model context_limit');
    expect(() => select({ effort: 'bogus' })).toThrow('Invalid model thinking.effort');
    expect(select({ contextWindow: 512_000 })).toMatchObject({
      contextWindow: 512_000,
      effort: 'max',
    });
    expect(select({ effort: 'high' })).toMatchObject({
      contextWindow: 1_000_000,
      effort: 'high',
    });
  });

  it('uses the managed catalog for task capture, including forced-on defaults and discrete context', () => {
    const managed: LocalConversationRuntimeConfig = {
      ...config,
      defaultModel: 'minimax/MiniMax-M3.1',
      defaultModelThinking: { effort: 'max' },
      defaultModelContextWindow: 1_000_000,
      provider: {
        minimax: {
          models: {
            'MiniMax-M3.1': {
              limit: { context: 512_000, output: 128_000 },
              contextWindowOptions: [512_000, 1_000_000],
              thinking_config: { mode: 'forced_on' },
              thinking: { effortOptions: ['low', 'high', 'max'], defaultEffort: 'high' },
            },
          },
        },
      },
    };
    const capture = (selection?: { model: string; effort?: string; contextWindow?: number }) =>
      resolveAgentModelSelection({
        config: managed,
        sources: selection ? [{ source: 'task', selection }] : [],
      });
    expect(capture()).toMatchObject({ effort: 'max', contextWindow: 1_000_000 });
    expect(capture({ model: 'minimax/MiniMax-M3.1' })).toMatchObject({
      effort: 'high',
      contextWindow: 512_000,
    });
    expect(
      capture({ model: 'minimax/MiniMax-M3.1', effort: 'max', contextWindow: 1_000_000 }),
    ).toMatchObject({ effort: 'max', contextWindow: 1_000_000, diagnostics: [] });
    expect(() => capture({ model: 'minimax/MiniMax-M3.1', effort: 'off' })).toThrow();
    expect(() => capture({ model: 'minimax/MiniMax-M3.1', contextWindow: 768_000 })).toThrow();
    expect(() =>
      capture({ model: 'minimax/MiniMax-M3.1', contextWindow: 2_147_483_648 }),
    ).toThrow();
  });
  it('captures an official model from a dangling legacy default without changing config', () => {
    const legacyConfig = {
      ...config,
      defaultModel: 'custom_provider:minimax-legacy/retired',
      provider: {
        ...config.provider,
        minimax: {
          models: {
            'MiniMax-M3.1-Flash-Preview': { limit: { context: 512_000, output: 128_000 } },
            'MiniMax-M3': { limit: { context: 512_000, output: 128_000 } },
          },
        },
      },
    };
    expect(
      resolveEffectiveAgentModelSelection({ config: legacyConfig, sources: [] }),
    ).toMatchObject({
      providerId: 'minimax',
      modelId: 'MiniMax-M3.1-Flash-Preview',
      contextWindow: 512_000,
    });
    expect(legacyConfig.defaultModel).toBe('custom_provider:minimax-legacy/retired');
    expect(
      resolveAgentModelSelection({
        config: { ...legacyConfig, provider: config.provider },
        sources: [{ source: 'explicit', selection: { model: 'target/replacement' } }],
      }),
    ).toMatchObject({ providerId: 'target', modelId: 'replacement' });
  });

  registerContextTierSelectionTests();
  registerCatalogSelectionValidationTests();
  registerCustomProviderPrefixFallbackTests();
  registerAgentModelInputValidationTests();
  registerExplicitParentSelectionTest();
  registerMiniMaxM3SelectionTests();
  registerBuiltinAgentGroupTests();
  registerResolverBoundaryCoverageTest();
});

function registerContextTierSelectionTests(): void {
  it.each(['minimax', 'minimax_api'])(
    'separates official M3 tier from its maximum for %s',
    (providerId) => {
      const runtimeConfig: LocalConversationRuntimeConfig = {
        ...config,
        provider: {
          minimax: {
            models: {
              'MiniMax-M3': {
                limit: { context: 512_000, output: 128_000 },
                contextWindowOptions: [512_000, 1_000_000],
              },
            },
          },
        },
      };
      const select = (contextWindow?: number, maxOutputTokens?: number) =>
        resolveAgentModelSelection({
          config: runtimeConfig,
          sources: [
            {
              source: 'agent-config',
              selection: { model: `${providerId}/MiniMax-M3`, contextWindow, maxOutputTokens },
            },
          ],
        });
      expect(select()).toMatchObject({ contextWindow: 512_000, diagnostics: [] });
      expect(select(512_000)).toMatchObject({ contextWindow: 512_000, diagnostics: [] });
      expect(select(1_000_000)).toMatchObject({ contextWindow: 1_000_000, diagnostics: [] });
      if (providerId === 'minimax') {
        expect(() => select(2_000_000, 256_000)).toThrow('Invalid model context_limit');
        return;
      }
      expect(select(2_000_000, 256_000)).toMatchObject({
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        diagnostics: [
          expect.objectContaining({ code: 'context_window_clamped', physicalLimit: 1_000_000 }),
          expect.objectContaining({ code: 'max_output_tokens_clamped', physicalLimit: 128_000 }),
        ],
      });
    },
  );

  it.each([
    ['minimax', 'MiniMax-M3.1-Flash-Preview', [2_000_000, 128_000], 2_000_000],
    ['minimax_api', 'future-model', [2_000_000, 128_000], 2_000_000],
    ['minimax_api', 'MiniMax-M3', [128_000, 256_000], 256_000],
    ['minimax_api', 'MiniMax-M3', undefined, 128_000],
    ['minimax_api', 'MiniMax-M3', [], 128_000],
    ['minimax_api', 'future-model', [0, -1, NaN, Infinity, 1.5], 128_000],
  ] as const)(
    'uses catalog Context options for %s/%s (%j)',
    (providerId, modelId, options, ceiling) => {
      const select = (contextWindow?: number) =>
        resolveAgentModelSelection({
          config: {
            ...config,
            minimaxModelSource: 'minimax_api_key',
            provider: {
              minimax: {
                models: {
                  [modelId]: {
                    limit: { context: 128_000 },
                    ...(options ? { contextWindowOptions: [...options] } : {}),
                  },
                },
              },
            },
          },
          sources: [
            {
              source: 'agent-config',
              selection: { model: `${providerId}/${modelId}`, contextWindow },
            },
          ],
        });
      expect(select()).toMatchObject({ contextWindow: 128_000, diagnostics: [] });
      expect(select(ceiling)).toMatchObject({ contextWindow: ceiling, diagnostics: [] });
      expect(select(ceiling + 1)).toMatchObject({
        contextWindow: ceiling,
        diagnostics: [
          expect.objectContaining({ code: 'context_window_clamped', physicalLimit: ceiling }),
        ],
      });
    },
  );

  it.each(['other', 'custom_provider:other'])(
    'retains the declared context ceiling for same-name M3 on %s',
    (provider) => {
      const runtimeConfig: LocalConversationRuntimeConfig = {
        ...config,
        provider: { other: { models: { 'MiniMax-M3': { limit: { context: 512_000 } } } } },
        custom_provider: { other: { models: { 'MiniMax-M3': { limit: { context: 512_000 } } } } },
      };
      expect(
        resolveAgentModelSelection({
          config: runtimeConfig,
          sources: [
            {
              source: 'agent-config',
              selection: { model: `${provider}/MiniMax-M3`, contextWindow: 1_000_000 },
            },
          ],
        }),
      ).toMatchObject({
        contextWindow: 512_000,
        diagnostics: [
          expect.objectContaining({ code: 'context_window_clamped', physicalLimit: 512_000 }),
        ],
      });
    },
  );

  it('resets inherited effort and limits when a higher-priority source changes model', () => {
    expect(
      resolveAgentModelSelection({
        config,
        sources: [
          { source: 'task-target', selection: { model: 'target/replacement' } },
          {
            source: 'task-parent',
            selection: {
              model: 'parent/inherited',
              effort: 'high',
              contextWindow: 60_000,
              maxOutputTokens: 4_000,
            },
          },
        ],
      }),
    ).toEqual({
      providerId: 'target',
      modelId: 'replacement',
      source: 'task-target',
      effort: 'medium',
      contextWindow: 32_000,
      maxOutputTokens: 2_048,
      diagnostics: [],
    });
  });

  it('lets a higher-priority source without a model narrow the inherited full group', () => {
    expect(
      resolveAgentModelSelection({
        config,
        sources: [
          {
            source: 'task-target',
            selection: { effort: 'low', contextWindow: 16_000, maxOutputTokens: 1_000 },
          },
          {
            source: 'task-parent',
            selection: {
              model: 'parent/inherited',
              effort: 'high',
              contextWindow: 32_000,
              maxOutputTokens: 2_000,
            },
          },
        ],
      }),
    ).toEqual({
      providerId: 'parent',
      modelId: 'inherited',
      source: 'task-parent',
      effort: 'low',
      contextWindow: 16_000,
      maxOutputTokens: 1_000,
      diagnostics: [],
    });
  });
}

function registerCatalogSelectionValidationTests(): void {
  it('clamps Agent limits to the physical catalog caps and returns diagnostics', () => {
    const result = resolveAgentModelSelection({
      config,
      sources: [
        {
          source: 'agent-config',
          selection: {
            model: 'target/replacement',
            contextWindow: 64_000,
            maxOutputTokens: 4_096,
          },
        },
      ],
    });

    expect(result.contextWindow).toBe(32_000);
    expect(result.maxOutputTokens).toBe(2_048);
    expect(result.diagnostics).toEqual([
      {
        code: 'context_window_clamped',
        source: 'agent-config',
        requested: 64_000,
        effective: 32_000,
        physicalLimit: 32_000,
      },
      {
        code: 'max_output_tokens_clamped',
        source: 'agent-config',
        requested: 4_096,
        effective: 2_048,
        physicalLimit: 2_048,
      },
    ]);
  });

  it('fails closed for an effort the selected model does not support', () => {
    let thrown: unknown;
    try {
      resolveAgentModelSelection({
        config,
        sources: [
          {
            source: 'agent-config',
            selection: { model: 'target/replacement', effort: 'high' },
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: 'AgentModelSelectionError',
      code: 'MODEL_EFFORT_UNSUPPORTED',
    } satisfies Partial<AgentModelSelectionError>);
  });

  it.each([
    ['missing/model', 'MODEL_SELECTION_INVALID'],
    ['target/disabled', 'MODEL_SELECTION_INVALID'],
  ] as const)('fails closed for a catalog-gated %s group', (model, code) => {
    const targetModels = config.provider.target?.models ?? {};
    const gatedConfig: LocalConversationRuntimeConfig = {
      ...config,
      provider: {
        ...config.provider,
        target: {
          models: {
            ...targetModels,
            disabled: { enabled: false },
          },
        },
      },
    };
    let thrown: unknown;
    try {
      resolveAgentModelSelection({
        config: gatedConfig,
        sources: [{ source: 'agent-config', selection: { model }, requireCatalog: true }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: 'AgentModelSelectionError', code });
  });
}

function registerExplicitParentSelectionTest(): void {
  it('keeps an explicit parent selection above the current Agent selection', () => {
    const result = resolveAgentModelSelection({
      config,
      sources: [
        {
          source: 'explicit-selection',
          selection: { model: 'parent/inherited', effort: 'high' },
        },
        {
          source: 'agent-config',
          selection: { model: 'target/replacement', effort: 'minimal' },
        },
      ],
    });

    expect(result).toMatchObject({
      providerId: 'parent',
      modelId: 'inherited',
      source: 'explicit-selection',
      effort: 'high',
    });
  });
}

function registerResolverBoundaryCoverageTest(): void {
  it('handles valid missing-default, disabled-thinking, and unbounded-limit groups', () => {
    const targetModels = config.provider.target?.models ?? {};
    const boundaryConfig: LocalConversationRuntimeConfig = {
      ...config,
      defaultModel: undefined,
      provider: {
        ...config.provider,
        target: {
          models: {
            ...targetModels,
            forcedNoLimits: { thinking_config: { mode: 'forced_on' } },
            noLimits: {},
          },
        },
      },
    };

    expect(
      resolveBuiltinAgentModelGroup({
        config: boundaryConfig,
        bundled: { model: 'target/forcedNoLimits' },
      }),
    ).toEqual({ model: 'target/forcedNoLimits' });
    expect(resolveBuiltinAgentModelGroup({ config: boundaryConfig })).toBeUndefined();
    expect(
      resolveAgentModelSelection({
        config,
        sources: [
          { source: 'agent-config', selection: { model: 'target/replacement', effort: 'off' } },
        ],
      }),
    ).toMatchObject({ effort: 'off' });
    expect(() =>
      resolveAgentModelSelection({
        config: boundaryConfig,
        sources: [
          { source: 'agent-config', selection: { model: 'target/noLimits', contextWindow: 1_024 } },
        ],
      }),
    ).toThrow('contextWindow from agent-config requires a catalog physical limit.');
  });
}

function registerBuiltinAgentGroupTests(): void {
  it('preserves a valid explicit previous Builtin model group', () => {
    expect(
      resolveBuiltinAgentModelGroup({
        config,
        previous: { model: 'target/replacement' },
      }),
    ).toMatchObject({ model: 'target/replacement', effort: 'off' });
  });

  it('inherits the conversation model without a valid explicit Builtin model group', () => {
    expect(resolveBuiltinAgentModelGroup({ config })).toBeUndefined();
    expect(
      resolveBuiltinAgentModelGroup({
        config,
        previous: {
          model: 'target/replacement',
          effort: 'high',
          contextWindow: 99_999,
          maxOutputTokens: 9_999,
        },
      }),
    ).toBeUndefined();
  });

  it('uses an explicit bundled group when the retained group is unavailable', () => {
    expect(
      resolveBuiltinAgentModelGroup({
        config,
        previous: { model: 'target/disabled' },
        bundled: { model: 'parent/inherited', contextWindow: 60_000 },
      }),
    ).toEqual({
      model: 'parent/inherited',
      effort: 'off',
      contextWindow: 60_000,
      maxOutputTokens: 4_096,
    });
  });
}

function registerCustomProviderPrefixFallbackTests(): void {
  it('recovers only Agent-profile bare keys from an exact custom-provider model', () => {
    const byokConfig: LocalConversationRuntimeConfig = {
      ...config,
      custom_provider: {
        mafia: {
          models: {
            model: { limit: { context: 48_000, output: 6_000 } },
          },
        },
      },
    };
    const selectFromAgentProfile = (model: string, candidateConfig = byokConfig) =>
      resolveAgentModelSelection({
        config: candidateConfig,
        sources: [
          {
            source: 'agent-profile',
            selection: { model },
            requireCatalog: true,
            allowCustomProviderPrefixFallback: true,
          },
        ],
      });

    expect(selectFromAgentProfile('mafia/model')).toMatchObject({
      providerId: 'custom_provider:mafia',
      modelId: 'model',
      contextWindow: 48_000,
      maxOutputTokens: 6_000,
    });
    expect(() => selectFromAgentProfile('Mafia/model')).toThrow('Model Mafia/model');
    expect(() => selectFromAgentProfile('mafia/MODEL')).toThrow('Model mafia/MODEL');
    expect(() => selectFromAgentProfile('custom_provider:mafia/MISSING')).toThrow(
      'Model custom_provider:mafia/MISSING',
    );

    expect(() =>
      selectFromAgentProfile('mafia/model', {
        ...byokConfig,
        provider: { ...byokConfig.provider, mafia: { models: {} } },
      }),
    ).toThrow('Model mafia/model');
    expect(() =>
      selectFromAgentProfile('minimax/model', {
        ...byokConfig,
        custom_provider: {
          ...byokConfig.custom_provider,
          minimax: { models: { model: {} } },
        },
      }),
    ).toThrow('Model minimax/model');

    expect(() =>
      resolveAgentModelSelection({
        config: byokConfig,
        sources: [
          {
            source: 'explicit-selection',
            selection: { model: 'mafia/model' },
            requireCatalog: true,
          },
        ],
      }),
    ).toThrow('Model mafia/model');
    expect(
      resolveAgentModelSelection({
        config: { ...byokConfig, defaultModel: 'mafia/model' },
        sources: [],
      }),
    ).toMatchObject({ providerId: 'mafia', modelId: 'model' });
  });
}

function registerAgentModelInputValidationTests(): void {
  it('fails closed when neither Agent nor Runtime supplies a model', () => {
    expect(() =>
      resolveAgentModelSelection({
        config: { ...config, defaultModel: undefined },
        sources: [{ source: 'agent-config', selection: { effort: 'low' } }],
      }),
    ).toThrow('No runtime or Agent model is configured.');
  });

  it('fails closed for a malformed Agent model key', () => {
    expect(() =>
      resolveAgentModelSelection({
        config,
        sources: [{ source: 'agent-config', selection: { model: 'malformed' } }],
      }),
    ).toThrow('Model selection from agent-config must use provider/model syntax.');
  });
}

function registerMiniMaxM3SelectionTests(): void {
  it.each([
    ['thinking', 'true', 'on'],
    ['none-thinking', 'true', 'off'],
    ['', 'true', 'off'],
    [undefined, 'false', 'off'],
    [undefined, 'true', 'on'],
  ] as const)(
    'normalizes the Runtime-default MiniMax M3 switch (%s, catalog %s) to %s',
    (defaultModelVariant, defaultValue, effort) => {
      const result = resolveAgentModelSelection({
        config: m3Config({ defaultModelVariant, defaultValue }),
        sources: [],
      });

      expect(result).toMatchObject({
        providerId: 'runtime',
        modelId: 'MiniMax-M3',
        source: 'runtime-default',
        effort,
      });
    },
  );

  it.each(['on', 'off'] as const)('accepts explicit MiniMax M3 switch %s', (effort) => {
    expect(
      resolveAgentModelSelection({
        config: m3Config(),
        sources: [
          {
            source: 'agent-config',
            selection: { model: 'runtime/MiniMax-M3', effort },
            requireCatalog: true,
          },
        ],
      }),
    ).toMatchObject({ effort });
  });

  it('keeps native M3 switch validation distinct from catalog effort options', () => {
    const configWithEffortOptions = m3Config({ effortOptions: ['low', 'medium', 'high'] });
    expect(
      resolveAgentModelSelection({
        config: configWithEffortOptions,
        sources: [{ source: 'agent-config', selection: { model: 'runtime/MiniMax-M3' } }],
      }),
    ).toMatchObject({ effort: 'on' });

    let thrown: unknown;
    expect(
      resolveAgentModelSelection({
        config: configWithEffortOptions,
        sources: [
          {
            source: 'agent-config',
            selection: { model: 'runtime/MiniMax-M3', effort: 'on' },
          },
        ],
      }),
    ).toMatchObject({ effort: 'on' });
    try {
      resolveAgentModelSelection({
        config: configWithEffortOptions,
        sources: [
          {
            source: 'agent-config',
            selection: { model: 'runtime/MiniMax-M3', effort: 'low' },
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'MODEL_EFFORT_UNSUPPORTED' });
  });

  it('uses Custom BYOK M3 effort options instead of its model name or reasoning flag', () => {
    const customM3 = (model: Record<string, unknown>): LocalConversationRuntimeConfig => ({
      ...config,
      custom_provider: { mafia: { models: { 'MiniMax-M3': model } } },
    });
    const select = (runtimeConfig: LocalConversationRuntimeConfig, effort: string) =>
      resolveAgentModelSelection({
        config: runtimeConfig,
        sources: [
          {
            source: 'agent-config',
            selection: { model: 'custom_provider:mafia/MiniMax-M3', effort },
            requireCatalog: true,
          },
        ],
      });
    const declared = customM3({
      reasoning: true,
      thinking_config: { mode: 'switchable', default_value: 'true' },
      thinking: { effortOptions: ['off', 'on'] },
    });

    expect(select(declared, 'on')).toMatchObject({ effort: 'on' });
    expect(select(declared, 'off')).toMatchObject({ effort: 'off' });
    expect(() =>
      select(
        customM3({
          reasoning: true,
          thinking_config: { mode: 'switchable', default_value: 'true' },
        }),
        'on',
      ),
    ).toThrow('Thinking effort "on"');
    expect(() =>
      select(
        customM3({
          reasoning: true,
          thinking_config: { mode: 'switchable', default_value: 'true' },
          thinking: { effortOptions: ['low', 'medium', 'high'] },
        }),
        'on',
      ),
    ).toThrow('Thinking effort "on"');
  });

  it('fails closed for a non-M3 model with no effort options', () => {
    const configWithoutEffortOptions: LocalConversationRuntimeConfig = {
      ...config,
      provider: {
        ...config.provider,
        target: { models: { plain: { limit: { context: 2_048, output: 512 } } } },
      },
    };
    expect(
      resolveAgentModelSelection({
        config: configWithoutEffortOptions,
        sources: [{ source: 'agent-config', selection: { model: 'target/plain' } }],
      }),
    ).not.toHaveProperty('effort');

    let thrown: unknown;
    try {
      resolveAgentModelSelection({
        config: configWithoutEffortOptions,
        sources: [{ source: 'agent-config', selection: { model: 'target/plain', effort: 'on' } }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'MODEL_EFFORT_UNSUPPORTED' });
  });

  it('preserves forced thinking modes ahead of an Agent default-off policy', () => {
    const forcedConfig: LocalConversationRuntimeConfig = {
      ...config,
      provider: {
        ...config.provider,
        target: {
          models: {
            forcedOn: {
              thinking_config: { mode: 'forced_on' },
              thinking: { effortOptions: ['low', 'medium', 'high'] },
            },
            forcedOff: {
              thinking_config: { mode: 'forced_off' },
              thinking: { effortOptions: ['low', 'medium', 'high'] },
            },
          },
        },
      },
    };
    const source = (model: string, effort?: string) => ({
      source: 'agent-config',
      selection: { model, ...(effort ? { effort } : {}) },
      defaultMissingEffortOff: true,
    });

    expect(
      resolveAgentModelSelection({
        config: forcedConfig,
        sources: [source('target/forcedOn')],
      }),
    ).not.toHaveProperty('effort');
    expect(
      resolveAgentModelSelection({
        config: forcedConfig,
        sources: [source('target/forcedOff')],
      }),
    ).toMatchObject({ effort: 'off' });
    expect(() =>
      resolveAgentModelSelection({
        config: forcedConfig,
        sources: [source('target/forcedOn', 'off')],
      }),
    ).toThrow('Thinking effort "off"');
  });
}

function m3Config(
  input: {
    readonly defaultModelVariant?: string;
    readonly defaultValue?: 'true' | 'false';
    readonly effortOptions?: readonly string[];
  } = {},
): LocalConversationRuntimeConfig {
  const m3 = {
    limit: { context: 512_000, output: 128_000 },
    thinking_config: { mode: 'switchable' as const, default_value: input.defaultValue ?? 'true' },
    ...(input.effortOptions ? { thinking: { effortOptions: [...input.effortOptions] } } : {}),
  };
  return {
    ...config,
    defaultModel: 'runtime/MiniMax-M3',
    ...(input.defaultModelVariant === undefined
      ? {}
      : { defaultModelVariant: input.defaultModelVariant }),
    provider: {
      ...config.provider,
      runtime: { models: { 'MiniMax-M3': m3 } },
    },
  };
}
