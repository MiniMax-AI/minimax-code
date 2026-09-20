import { DEFAULT_THINKING_MODEL_IDS } from '@earendil-works/pi-ai';
import { ThinkingLevel, ThinkingMode } from '@mavis/protocol';
import { describe, expect, it } from 'vitest';

import {
  capabilitiesFromModelConfig,
  modelLimitsFromConfig,
  modelRefForModel,
  readSelectedThinkingEffort,
  resolveByokThinkingProtocol,
  resolveThinkingLevel,
} from './model-ref.js';
import { OPENPLATFORM_THINKING_VARIANTS_CAPABILITY } from './openplatform-thinking.js';
import type { LocalModelConfig } from '../contracts.js';

describe('modelRefForModel', () => {
  it('resolves managed selection from configured options and rejects explicit conflicts', () => {
    const config: LocalModelConfig = {
      limit: { context: 512_000, output: 128_000 },
      contextWindowOptions: [512_000, 1_000_000],
      thinking_config: { mode: 'forced_on' },
      thinking: { effortOptions: ['low', 'high', 'max'], defaultEffort: 'high' },
    };
    const selected = modelRefForModel('minimax', 'MiniMax-M3.1', config, {
      managed: true,
      contextLimit: 1_000_000,
      thinking: { effort: 'max' },
    });
    expect(selected).toMatchObject({
      context_window: 1_000_000,
      thinking_effort: 'max',
      thinking_level: ThinkingLevel.MEDIUM,
    });
    expect(selected.capabilities).not.toHaveProperty('selected_thinking_effort');
    for (const override of [
      { reasoning: false },
      { contextLimit: 768_000 },
      { contextLimit: 2_147_483_648 },
      { thinking: { effort: 'ultra' } },
    ]) {
      expect(() =>
        modelRefForModel('minimax', 'MiniMax-M3.1', config, { managed: true, ...override }),
      ).toThrow();
    }
    const switchable = {
      ...config,
      thinking_config: { mode: 'switchable', default_value: 'true' },
    } as LocalModelConfig;
    expect(
      modelRefForModel('minimax', 'MiniMax-M3.1', switchable, { managed: true, reasoning: false }),
    ).toMatchObject({ thinking_level: ThinkingLevel.OFF });
    expect(
      modelRefForModel('minimax', 'MiniMax-M3.1', switchable, { managed: true, reasoning: false })
        .thinking_effort,
    ).toBeUndefined();
    expect(
      modelRefForModel('minimax', 'MiniMax-M3.1', switchable, {
        managed: true,
        reasoning: false,
        thinking: { effort: 'max' },
      }),
    ).not.toHaveProperty('thinking_effort');
    expect(() =>
      modelRefForModel('minimax', 'MiniMax-M3.1', switchable, {
        managed: true,
        reasoning: false,
        thinking: { effort: 'invalid' },
      }),
    ).toThrow();
    expect(modelRefForModel('minimax', 'plain', {}, { managed: true })).not.toHaveProperty(
      'thinking_effort',
    );
    expect(
      modelRefForModel(
        'minimax',
        'plain',
        { reasoning: true, thinking: { effortOptions: ['low', 'max'] } },
        { managed: true },
      ),
    ).not.toHaveProperty('thinking_effort');
  });

  it('distinguishes absent options from disabled policies and keeps fixed defaults', () => {
    const config: LocalModelConfig = {
      limit: { context: 512_000 },
      thinking_config: { mode: 'forced_on' },
      thinking: { defaultEffort: 'max' },
    };
    expect(
      modelRefForModel('minimax', 'fixed', config, {
        managed: true,
        contextLimit: 512_000,
        thinking: { effort: 'max' },
      }),
    ).toMatchObject({ thinking_effort: 'max', context_window: 512_000 });
    const invalid: LocalModelConfig = {
      ...config,
      parameterErrors: { contextOptions: true, effortOptions: true },
    };
    expect(modelRefForModel('minimax', 'fixed', invalid, { managed: true })).not.toHaveProperty(
      'thinking_effort',
    );
    expect(() =>
      modelRefForModel('minimax', 'fixed', invalid, { managed: true, contextLimit: 512_000 }),
    ).toThrow();
    expect(() =>
      modelRefForModel('minimax', 'fixed', invalid, { managed: true, thinking: { effort: 'max' } }),
    ).toThrow();
    expect(
      modelRefForModel(
        'minimax',
        'fixed',
        { ...config, contextWindowOptions: [1_000_000] },
        { managed: true },
      ),
    ).toMatchObject({ context_window: 512_000 });
  });

  it('builds a conservative ref when no catalog config exists', () => {
    expect(modelRefForModel('provider', 'model', undefined)).toEqual({
      provider: 'provider',
      model_id: 'model',
      thinking_level: ThinkingLevel.OFF,
      capabilities: {
        support_image: false,
        support_video: false,
        support_files_api: false,
      },
    });
  });

  it('projects modalities, explicit capabilities, limits, and thinking payloads', () => {
    const config: LocalModelConfig = {
      reasoning: true,
      modalities: { input: ['image'], output: ['text'] },
      capabilities: { support_video: true },
      limit: { context: 96_000, output: 12_000 },
      thinking_config: { mode: 'switchable', default_value: 'false' },
      variants: {
        thinking: { thinking: { type: 'adaptive', budget_tokens: 1024 } },
        'none-thinking': { thinking: { type: 'disabled' } },
      },
    };

    const ref = modelRefForModel('provider', 'model', config, { variant: 'thinking' });

    expect(ref).toMatchObject({
      context_window: 96_000,
      max_tokens: 12_000,
      thinking_level: ThinkingLevel.MEDIUM,
      capabilities: {
        support_image: true,
        support_video: true,
        thinking_mode: ThinkingMode.SWITCHABLE,
      },
    });
    expect(Reflect.get(ref.capabilities ?? {}, OPENPLATFORM_THINKING_VARIANTS_CAPABILITY)).toEqual({
      thinking: { type: 'adaptive', budget_tokens: 1024 },
      'none-thinking': { type: 'disabled' },
    });
  });

  it('keeps a session choice or resolves the configured upper middle effort', () => {
    const config: LocalModelConfig = {
      reasoning: true,
      thinking: { effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'] },
    };

    expect(
      readSelectedThinkingEffort(modelRefForModel('provider', 'model', config).capabilities),
    ).toBe('high');
    expect(
      readSelectedThinkingEffort(
        modelRefForModel('provider', 'model', config, { thinking: { effort: 'max' } }).capabilities,
      ),
    ).toBe('max');
    expect(
      readSelectedThinkingEffort(
        modelRefForModel('provider', 'model', config, { thinking: { effort: 'off' } }).capabilities,
      ),
    ).toBe('off');
  });

  it('uses the official default effort before the historical midpoint fallback', () => {
    const config: LocalModelConfig = {
      reasoning: true,
      thinking_config: { mode: 'switchable', default_value: 'true' },
      thinking: {
        effortOptions: ['low', 'medium', 'high', 'max'],
        defaultEffort: 'low',
      },
    };

    const ref = modelRefForModel('minimax', 'Official-M4', config);

    expect(readSelectedThinkingEffort(ref.capabilities)).toBe('low');
    expect(ref.thinking_level).toBe(ThinkingLevel.MEDIUM);
  });

  it('does not let a default effort enable a switchable model whose effective default is off', () => {
    const ref = modelRefForModel('minimax', 'Official-M4', {
      reasoning: true,
      thinking_config: { mode: 'switchable', default_value: 'false' },
      thinking: {
        effortOptions: ['low', 'high'],
        defaultEffort: 'high',
      },
    });

    expect(readSelectedThinkingEffort(ref.capabilities)).toBeUndefined();
    expect(ref.thinking_level).toBe(ThinkingLevel.OFF);
  });

  it('uses the official default effort when thinking is forced on', () => {
    const ref = modelRefForModel('minimax', 'Official-M4', {
      reasoning: true,
      thinking_config: { mode: 'forced_on' },
      thinking: {
        effortOptions: ['low', 'high'],
        defaultEffort: 'high',
      },
    });

    expect(readSelectedThinkingEffort(ref.capabilities)).toBe('high');
    expect(ref.thinking_level).toBe(ThinkingLevel.MEDIUM);
  });
});

describe('modelRefForModel thinking compatibility', () => {
  it.each([
    ['on', ThinkingLevel.MEDIUM],
    ['off', ThinkingLevel.OFF],
  ] as const)('preserves the MiniMax M3 switch %s in the model ref', (effort, thinkingLevel) => {
    const ref = modelRefForModel(
      'minimax',
      'MiniMax-M3',
      {
        thinking_config: { mode: 'switchable', default_value: 'true' },
        variants: {
          thinking: { thinking: { type: 'adaptive' } },
          'none-thinking': { thinking: { type: 'disabled' } },
        },
      },
      { thinking: { effort } },
    );

    expect(readSelectedThinkingEffort(ref.capabilities)).toBe(effort);
    expect(ref.thinking_level).toBe(thinkingLevel);
  });

  it('does not let stale MiniMax M3 effort re-enable an explicitly disabled variant', () => {
    const ref = modelRefForModel(
      'minimax',
      'MiniMax-M3',
      {
        thinking_config: { mode: 'switchable', default_value: 'true' },
        variants: {
          thinking: { thinking: { type: 'adaptive' } },
          'none-thinking': { thinking: { type: 'disabled' } },
        },
      },
      { variant: '', thinking: { effort: 'on' } },
    );

    expect(readSelectedThinkingEffort(ref.capabilities)).toBeUndefined();
    expect(ref.thinking_level).toBe(ThinkingLevel.OFF);
  });

  it('uses configured MiniMax M3 effort defaults and explicit selections', () => {
    const modelConfig: LocalModelConfig = {
      thinking_config: { mode: 'switchable', default_value: 'true' },
      thinking: { effortOptions: ['low', 'high'], defaultEffort: 'high' },
    };

    const defaulted = modelRefForModel('minimax', 'MiniMax-M3', modelConfig);
    const selected = modelRefForModel('minimax', 'MiniMax-M3', modelConfig, {
      thinking: { effort: 'low' },
    });

    expect(readSelectedThinkingEffort(defaulted.capabilities)).toBe('high');
    expect(readSelectedThinkingEffort(selected.capabilities)).toBe('low');
  });

  it('does not emit a MiniMax M3 effort when configured thinking is off', () => {
    const ref = modelRefForModel('minimax', 'MiniMax-M3', {
      thinking_config: { mode: 'switchable', default_value: 'false' },
      thinking: { effortOptions: ['low', 'high'], defaultEffort: 'high' },
    });

    expect(readSelectedThinkingEffort(ref.capabilities)).toBeUndefined();
    expect(ref.thinking_level).toBe(ThinkingLevel.OFF);
  });

  it('does not infer Custom BYOK M3 effort from reasoning alone', () => {
    const ref = modelRefForModel('custom_provider:mafia', 'MiniMax-M3', {
      reasoning: true,
      thinking_config: { mode: 'switchable', default_value: 'true' },
    });

    expect(readSelectedThinkingEffort(ref.capabilities)).toBeUndefined();
  });

  it('does not let an effort selection re-enable an explicitly disabled thinking variant', () => {
    const config: LocalModelConfig = {
      reasoning: true,
      thinking: { effortOptions: ['none', 'high'] },
      thinking_config: { mode: 'switchable', default_value: 'true' },
    };

    expect(
      modelRefForModel('provider', 'model', config, {
        variant: 'thinking',
        thinking: { effort: 'none' },
      }).thinking_level,
    ).toBe(ThinkingLevel.OFF);
    const disabled = modelRefForModel('provider', 'model', config, {
      variant: '',
      thinking: { effort: 'high' },
    });
    expect(disabled.thinking_level).toBe(ThinkingLevel.OFF);
    expect(readSelectedThinkingEffort(disabled.capabilities)).toBeUndefined();
  });

  it('keeps forced catalog thinking modes ahead of an explicit off effort', () => {
    expect(
      modelRefForModel(
        'provider',
        'model',
        { thinking_config: { mode: 'forced_on' }, thinking: { effortOptions: ['low', 'medium'] } },
        { thinking: { effort: 'off' } },
      ).thinking_level,
    ).toBe(ThinkingLevel.MEDIUM);
    expect(
      readSelectedThinkingEffort(
        modelRefForModel('provider', 'model', { thinking_config: { mode: 'forced_off' } })
          .capabilities,
      ),
    ).toBe('off');
  });

  it('keeps an explicit variant ahead of the catalog default effort', () => {
    const config: LocalModelConfig = {
      reasoning: true,
      thinking: { effortOptions: ['low', 'high', 'max'] },
      thinking_config: { mode: 'switchable', default_value: 'true' },
    };

    const ref = modelRefForModel('provider', 'model', config, { variant: '' });

    expect(ref.thinking_level).toBe(ThinkingLevel.OFF);
    expect(readSelectedThinkingEffort(ref.capabilities)).toBeUndefined();
  });
});

describe('BYOK Think Effort selection', () => {
  it('keeps a valid session choice and otherwise uses the upper middle option', () => {
    const config = {
      thinking: { effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'] },
    };

    expect(
      readSelectedThinkingEffort(
        modelRefForModel('provider', 'model', config, { thinking: { effort: 'max' } }).capabilities,
      ),
    ).toBe('max');
    expect(
      readSelectedThinkingEffort(
        modelRefForModel('provider', 'model', config, { thinking: { effort: 'removed' } })
          .capabilities,
      ),
    ).toBe('high');
    expect(
      readSelectedThinkingEffort(
        modelRefForModel('provider', 'model', {
          thinking: { effortOptions: ['off', 'on'] },
        }).capabilities,
      ),
    ).toBe('on');
  });

  it.each([
    [
      'anthropic-messages',
      {
        forceAdaptiveThinking: true,
        requestPatch: { thinking: { type: 'adaptive' }, output_config: { effort: 'light' } },
      },
    ],
    [
      'openai-completions',
      {
        completionsThinkingFormat: 'openai',
        requestPatch: { reasoning_effort: 'light' },
      },
    ],
    ['openai-responses', { requestPatch: { reasoning: { effort: 'light' } } }],
  ] as const)('maps %s effort through the provider-specific transport', (api, expected) => {
    expect(resolveByokThinkingProtocol(api, 'light', 'custom-model')).toMatchObject({
      effort: 'light',
      piLevel: 'high',
      thinkingLevelMap: { high: 'light' },
      ...expected,
    });
  });

  it.each(['low', 'high', 'max'] as const)(
    'carries the Kimi K3 effort %s from catalog metadata to the OpenAI-compatible request patch',
    (effort) => {
      // What the models.dev preset chain persists for moonshotai/kimi-k3:
      // reasoning_options { type: 'effort', values: ['low', 'high', 'max'] }
      // becomes thinking.effortOptions on the stored model config.
      const config: LocalModelConfig = {
        name: 'Kimi K3',
        reasoning: true,
        thinking: { effortOptions: ['low', 'high', 'max'] },
      };
      const ref = modelRefForModel('custom_provider:moonshotai', 'kimi-k3', config, {
        thinking: { effort },
      });

      const selectedEffort = readSelectedThinkingEffort(ref.capabilities);
      expect(selectedEffort).toBe(effort);
      expect(
        resolveByokThinkingProtocol('openai-completions', selectedEffort, ref.model_id),
      ).toMatchObject({
        effort,
        requestPatch: { reasoning_effort: effort },
      });
    },
  );

  it.each([`${DEFAULT_THINKING_MODEL_IDS[0]}[1m]`, ...DEFAULT_THINKING_MODEL_IDS.slice(1)])(
    'omits thinking for default-thinking model %s while preserving effort',
    (modelId) => {
      const protocol = resolveByokThinkingProtocol('anthropic-messages', 'medium', modelId);

      expect(protocol).toMatchObject({
        forceAdaptiveThinking: true,
        requestPatch: { output_config: { effort: 'medium' } },
      });
      expect(protocol?.requestPatch).toHaveProperty('thinking', undefined);
    },
  );

  it('does not treat arbitrary bracket suffixes as default-thinking aliases', () => {
    expect(
      resolveByokThinkingProtocol(
        'anthropic-messages',
        'medium',
        `${DEFAULT_THINKING_MODEL_IDS[0]}[foo]`,
      )?.requestPatch,
    ).toMatchObject({ thinking: { type: 'adaptive' } });
  });

  it.each([
    ['anthropic-messages', { thinking: { type: 'disabled' }, output_config: undefined }],
    ['openai-completions', { reasoning_effort: 'none' }],
    ['openai-responses', { reasoning: { effort: 'none' } }],
  ] as const)('maps none/off to an explicit %s request patch', (api, requestPatch) => {
    for (const effort of ['none', 'off'] as const) {
      expect(resolveByokThinkingProtocol(api, effort, 'custom-model')).toMatchObject({
        effort,
        enabled: false,
        requestPatch,
      });
    }
  });

  it.each([
    ['anthropic-messages', { thinking: { type: 'adaptive' } }, { thinking: { type: 'disabled' } }],
    ['openai-completions', { thinking: { type: 'adaptive' } }, { thinking: { type: 'disabled' } }],
    ['openai-responses', { reasoning: { effort: 'minimal' } }, { reasoning: { effort: 'none' } }],
  ] as const)('maps MiniMax M3 on/off through the %s protocol', (api, on, off) => {
    expect(resolveByokThinkingProtocol(api, 'on', 'MiniMax-M3')).toMatchObject({
      effort: 'on',
      enabled: true,
      requestPatch: on,
    });
    expect(resolveByokThinkingProtocol(api, 'off', 'MiniMax-M3')).toMatchObject({
      effort: 'off',
      enabled: false,
      requestPatch: off,
    });
  });
});

describe('modelRefForModel think-effort vs variant', () => {
  it('separates an explicit effort from a variant that merely spells one', () => {
    const config: LocalModelConfig = {
      reasoning: true,
      thinking: { effortOptions: ['low', 'medium', 'high', 'xhigh'] },
    };

    // An explicit selection is honoured, which is what `--effort xhigh` sends.
    const selected = modelRefForModel('custom_provider:work', 'deep-reasoner-1', config, {
      thinking: { effort: 'xhigh' },
    });
    expect(readSelectedThinkingEffort(selected.capabilities)).toBe('xhigh');

    // An effort level spelled as a variant is a model identity, so it suppresses
    // the catalog default and leaves no selected effort. That request still runs,
    // which is why `--effort` exists as the explicit way to pick a strength.
    const spelledAsVariant = modelRefForModel('custom_provider:work', 'deep-reasoner-1', config, {
      variant: 'xhigh',
    });
    expect(readSelectedThinkingEffort(spelledAsVariant.capabilities)).toBeUndefined();
    expect(spelledAsVariant.thinking_level).toBe(ThinkingLevel.MEDIUM);
  });

  it('keeps an explicit effort that arrives beside the thinking-on variant', () => {
    const config: LocalModelConfig = {
      reasoning: true,
      thinking_config: { mode: 'switchable', default_value: 'true' },
      thinking: { effortOptions: ['xhigh'], defaultEffort: 'xhigh' },
    };

    // This is what the interactive picker persists: variant `thinking` plus the
    // configured level. The effort must survive, because a defined variant alone
    // would otherwise suppress the catalog default and the provider would apply
    // its own.
    const withEffort = modelRefForModel('minimax', 'deep-reasoner-1', config, {
      variant: 'thinking',
      thinking: { effort: 'xhigh' },
    });
    expect(readSelectedThinkingEffort(withEffort.capabilities)).toBe('xhigh');

    // Without the explicit level the same selection resolves to no effort, which
    // is the failure the picker fix prevents.
    const withoutEffort = modelRefForModel('minimax', 'deep-reasoner-1', config, {
      variant: 'thinking',
    });
    expect(readSelectedThinkingEffort(withoutEffort.capabilities)).toBeUndefined();
  });

  it('keeps an explicit effort for a forced-on model selected with the thinking variant', () => {
    const config: LocalModelConfig = {
      reasoning: true,
      thinking_config: { mode: 'forced_on' },
      thinking: { effortOptions: ['xhigh'], defaultEffort: 'xhigh' },
    };

    const ref = modelRefForModel('minimax', 'deep-reasoner-1', config, {
      variant: 'thinking',
      thinking: { effort: 'xhigh' },
    });

    expect(readSelectedThinkingEffort(ref.capabilities)).toBe('xhigh');
  });

  it('still drops an effort sent with an explicit Thinking Off variant', () => {
    const config: LocalModelConfig = {
      reasoning: true,
      thinking_config: { mode: 'switchable', default_value: 'true' },
      thinking: { effortOptions: ['xhigh'], defaultEffort: 'xhigh' },
    };

    for (const variant of ['', 'none-thinking']) {
      const ref = modelRefForModel('minimax', 'deep-reasoner-1', config, {
        variant,
        thinking: { effort: 'xhigh' },
      });
      expect(readSelectedThinkingEffort(ref.capabilities)).toBeUndefined();
    }
  });
});

describe('resolveThinkingLevel', () => {
  it.each([
    [{ reasoning: true }, undefined, ThinkingLevel.MEDIUM],
    [{ reasoning: false }, undefined, ThinkingLevel.OFF],
    [{}, 'thinking', ThinkingLevel.OFF],
    [{ reasoning: true }, '', ThinkingLevel.MEDIUM],
    [{ thinking_config: { mode: 'forced_on' } }, undefined, ThinkingLevel.MEDIUM],
    [{ thinking_config: { mode: 'forced_off' } }, 'thinking', ThinkingLevel.OFF],
    [
      { thinking_config: { mode: 'switchable', default_value: 'true' } },
      undefined,
      ThinkingLevel.MEDIUM,
    ],
    [modelConfigWithThinking({ defaultValue: 'false' }), undefined, ThinkingLevel.OFF],
    [
      {
        thinking_config: { mode: 'switchable', default_value: 'invalid' },
        defaultVariant: 'thinking',
      },
      undefined,
      ThinkingLevel.MEDIUM,
    ],
    [{ thinking_config: { mode: 'switchable' } }, 'none-thinking', ThinkingLevel.OFF],
    [{ thinking_config: { mode: 'switchable' } }, '', ThinkingLevel.OFF],
    [
      modelConfigWithThinking({ mode: 'unexpected' }, { reasoning: true }),
      undefined,
      ThinkingLevel.MEDIUM,
    ],
  ] satisfies readonly [LocalModelConfig, string | undefined, ThinkingLevel][])(
    'resolves catalog config %#',
    (config, variant, expected) => {
      expect(resolveThinkingLevel(config, variant)).toBe(expected);
    },
  );

  it('honors metadata-free variants only for the TUI policy', () => {
    expect(resolveThinkingLevel({}, undefined, true)).toBe(ThinkingLevel.OFF);
    expect(
      resolveThinkingLevel(
        { thinking_config: { mode: 'switchable', default_value: 'true' } },
        undefined,
        true,
      ),
    ).toBe(ThinkingLevel.MEDIUM);
    expect(resolveThinkingLevel({}, 'thinking', true)).toBe(ThinkingLevel.MEDIUM);
    expect(resolveThinkingLevel({ reasoning: true }, '', true)).toBe(ThinkingLevel.OFF);
    expect(
      modelRefForModel(
        'custom_provider:test',
        'model',
        {},
        {
          variant: 'thinking',
          implicitCustomProviderThinking: true,
        },
      ).thinking_level,
    ).toBe(ThinkingLevel.MEDIUM);
  });
});

describe('model capability helpers', () => {
  it('requires explicit image input metadata instead of generic attachment support', () => {
    expect(capabilitiesFromModelConfig({ attachment: true }).support_image).toBe(false);
    expect(
      capabilitiesFromModelConfig({ modalities: { input: ['text'], output: ['image'] } }).support_image,
    ).toBe(false);
    expect(
      capabilitiesFromModelConfig({ modalities: { input: ['text', 'image'] } }).support_image,
    ).toBe(true);
    expect(
      capabilitiesFromModelConfig({ capabilities: { support_image: false } }).support_image,
    ).toBe(false);
  });

  it('uses explicit capability flags and forced thinking modes', () => {
    expect(
      capabilitiesFromModelConfig({
        capabilities: { support_image: true, support_video: true },
        thinking_config: { mode: 'forced_on' },
      }),
    ).toEqual({
      support_image: true,
      support_video: true,
      support_files_api: false,
      thinking_mode: ThinkingMode.FORCED_ON,
    });
  });

  it('projects the explicit json_object capability into the selected model ref', () => {
    const capabilities = capabilitiesFromModelConfig({
      capabilities: { support_json_object_output: true },
    });

    expect(capabilities).toMatchObject({ support_json_object_output: true });
  });

  it('ignores disabled, malformed, and array thinking variants', () => {
    const capabilities = capabilitiesFromModelConfig({
      variants: {
        thinking: { disabled: true, thinking: { type: 'adaptive' } },
        'none-thinking': { thinking: [] },
      },
    });

    expect(Reflect.has(capabilities ?? {}, OPENPLATFORM_THINKING_VARIANTS_CAPABILITY)).toBe(false);
  });

  it('accepts a single valid none-thinking payload and omits invalid limits', () => {
    const config: LocalModelConfig = {
      variants: {
        thinking: {},
        'none-thinking': { thinking: { type: 'disabled' } },
      },
    };
    Reflect.set(config.variants ?? {}, 'thinking', null);
    const capabilities = capabilitiesFromModelConfig(config);
    expect(Reflect.get(capabilities ?? {}, OPENPLATFORM_THINKING_VARIANTS_CAPABILITY)).toEqual({
      'none-thinking': { type: 'disabled' },
    });
    expect(modelLimitsFromConfig({ limit: { context: undefined, output: 0 } })).toEqual({
      max_tokens: 0,
    });
    expect(modelLimitsFromConfig(undefined)).toEqual({});
  });

  it('normalizes canonical File API capabilities and inline media limits like v1', () => {
    expect(
      capabilitiesFromModelConfig({
        capabilities: {
          support_image: true,
          support_video: true,
          support_files_api: true,
          use_file_api: false,
          files_api_upload_endpoint: ' /v1/files/upload ',
          files_api_ref_scheme: ' mm_file:// ',
          files_api_file_id_ttl_sec: 3_600,
          max_image_bytes_inline: '1048576',
          max_video_bytes_inline: 52_428_800,
          max_request_body_bytes: '67108864',
          max_attachments_count: '4',
        },
      }),
    ).toMatchObject({
      support_image: true,
      support_video: true,
      support_files_api: true,
      files_api_upload_endpoint: '/v1/files/upload',
      files_api_ref_scheme: 'mm_file://',
      files_api_file_id_ttl_sec: 3_600,
      max_image_bytes_inline: '1048576',
      max_video_bytes_inline: 52_428_800,
      max_request_body_bytes: '67108864',
      max_attachments_count: 4,
    });
  });

  it('uses the legacy File API alias only when the canonical flag is absent', () => {
    expect(
      capabilitiesFromModelConfig({
        capabilities: {
          use_file_api: true,
          files_api_upload_endpoint: '/v1/files/upload',
        },
      }),
    ).toMatchObject({
      support_files_api: true,
      files_api_upload_endpoint: '/v1/files/upload',
    });
    expect(
      capabilitiesFromModelConfig({
        capabilities: {
          support_files_api: false,
          use_file_api: true,
          files_api_upload_endpoint: '/v1/files/upload',
        },
      }),
    ).not.toHaveProperty('files_api_upload_endpoint');
  });

  it('drops malformed File API and inline media limits', () => {
    const capabilities = capabilitiesFromModelConfig({
      capabilities: {
        support_files_api: true,
        files_api_upload_endpoint: '   ',
        files_api_ref_scheme: '',
        files_api_file_id_ttl_sec: -1,
        max_image_bytes_inline: 'not-a-number',
        max_video_bytes_inline: 0,
        max_request_body_bytes: -1,
        max_attachments_count: 1.5,
      },
    });

    expect(capabilities).toMatchObject({ support_files_api: true });
    expect(capabilities).not.toHaveProperty('files_api_upload_endpoint');
    expect(capabilities).not.toHaveProperty('files_api_ref_scheme');
    expect(capabilities).not.toHaveProperty('files_api_file_id_ttl_sec');
    expect(capabilities).not.toHaveProperty('max_image_bytes_inline');
    expect(capabilities).not.toHaveProperty('max_video_bytes_inline');
    expect(capabilities).not.toHaveProperty('max_request_body_bytes');
    expect(capabilities).not.toHaveProperty('max_attachments_count');
  });
});

function modelConfigWithThinking(
  patch: Readonly<Record<string, unknown>>,
  rest: Omit<LocalModelConfig, 'thinking_config'> = {},
): LocalModelConfig {
  const thinkingConfig: NonNullable<LocalModelConfig['thinking_config']> = {
    mode: 'switchable',
  };
  Object.assign(thinkingConfig, patch);
  return { ...rest, thinking_config: thinkingConfig };
}
