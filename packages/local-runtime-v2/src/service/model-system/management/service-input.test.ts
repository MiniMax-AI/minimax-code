import { describe, expect, it } from 'vitest';

import { LocalModelProviderError, type LocalModelConfig } from '../contracts.js';
import {
  applyProviderCredentialUpdate,
  assertValidRawApiKey,
  mergeModelsFromInputs,
  modelsFromInputs,
  normalizeApiFormat,
  normalizeHeaderNames,
  normalizeHeaders,
  normalizeProviderCredentialUpdate,
  removeHeaderCaseInsensitive,
} from './service-input.js';

describe('model provider input normalization', () => {
  it('preserves declared capabilities on create and merges updates without losing limits', () => {
    const created = modelsFromInputs([
      {
        modelId: 'vision-model',
        capabilities: { support_image: true, max_image_bytes_inline: 1024 },
      },
    ]);
    expect(created['vision-model']?.capabilities).toEqual({
      support_image: true,
      max_image_bytes_inline: 1024,
    });
    const patch = [{ modelId: 'vision-model', capabilities: { support_image: false } }];
    for (const updated of [modelsFromInputs(patch, created), mergeModelsFromInputs(created, patch)]) {
      expect(updated['vision-model']?.capabilities).toEqual({
        support_image: false,
        max_image_bytes_inline: 1024,
      });
      const renamed = mergeModelsFromInputs(updated, [
        { modelId: 'vision-model', displayName: 'Renamed' },
      ]);
      expect(renamed['vision-model']?.capabilities).toEqual(updated['vision-model']?.capabilities);
    }
    expect(created['vision-model']?.capabilities?.support_image).toBe(true);
  });

  it('normalizes API keys and formats', () => {
    expect(() => assertValidRawApiKey(undefined as unknown as string)).toThrow(
      LocalModelProviderError,
    );
    expect(() => assertValidRawApiKey('sk-a****z')).toThrow(LocalModelProviderError);
    expect(assertValidRawApiKey(' sk-raw ')).toBe('sk-raw');
    expect(normalizeProviderCredentialUpdate({})).toEqual({ kind: 'keep' });
    expect(normalizeProviderCredentialUpdate({ apiKey: '   ' })).toEqual({ kind: 'clear' });
    expect(normalizeProviderCredentialUpdate({ apiKey: ' sk-next ' })).toEqual({
      kind: 'set',
      apiKey: 'sk-next',
    });

    expect(normalizeApiFormat(undefined)).toBeUndefined();
    expect(normalizeApiFormat('   ')).toBeUndefined();
    expect(normalizeApiFormat(' openai-responses ')).toBe('openai-responses');
    expect(() => normalizeApiFormat('unsupported')).toThrowError(
      expect.objectContaining({ code: 'INVALID_API_FORMAT' }),
    );
  });

  it('normalizes and validates headers case-insensitively', () => {
    expect(normalizeHeaders(undefined)).toBeUndefined();
    expect(normalizeHeaders({})).toBeUndefined();
    expect(normalizeHeaders({ ' X-Tenant ': ' tenant-a ' })).toEqual({ 'X-Tenant': 'tenant-a' });
    expect(() => normalizeHeaders({ '': 'value' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_HEADERS' }),
    );
    expect(() => normalizeHeaders({ 'X-Number': 1 as unknown as string })).toThrowError(
      expect.objectContaining({ code: 'INVALID_HEADERS' }),
    );
    expect(() => normalizeHeaders({ 'X-Test': 'one', 'x-test': 'two' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_HEADERS' }),
    );

    expect(normalizeHeaderNames(undefined)).toEqual([]);
    expect(normalizeHeaderNames([' X-A ', '', 'X-B'])).toEqual(['X-A', 'X-B']);
    expect(() => normalizeHeaderNames(['X-A', 'x-a'])).toThrowError(
      expect.objectContaining({ code: 'INVALID_HEADERS' }),
    );

    const headers = { Authorization: 'Bearer test', 'X-Tenant': 'tenant-a' };
    removeHeaderCaseInsensitive(headers, 'authorization');
    expect(headers).toEqual({ 'X-Tenant': 'tenant-a' });
  });

  it('maps a fully populated model input and preserves existing metadata', () => {
    const existing: Record<string, LocalModelConfig> = {
      'model-1': { name: 'Old name', capabilities: { experimental: true } },
    };
    const models = modelsFromInputs(
      [
        {
          modelId: ' model-1 ',
          displayName: 'Model 1',
          configurationSource: 'discovered',
          enabled: false,
          attachment: true,
          reasoning: true,
          toolCall: true,
          temperature: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 200_000, output: 32_000 },
          thinkingConfig: { mode: 'switchable', defaultValue: 'true' },
          effortOptions: ['low', 'high'],
        },
      ],
      existing,
    );

    expect(models['model-1']).toMatchObject({
      name: 'Model 1',
      configuration_source: 'discovered',
      enabled: false,
      attachment: true,
      reasoning: true,
      tool_call: true,
      temperature: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 200_000, output: 32_000 },
      thinking_config: { mode: 'switchable', default_value: 'true' },
      thinking: { effortOptions: ['low', 'high'] },
      capabilities: { experimental: true },
    });
  });

  it('persists declared Kimi K3 effort options as thinking metadata', () => {
    expect(
      modelsFromInputs([
        {
          modelId: 'kimi-k3',
          displayName: 'Kimi K3',
          reasoning: true,
          effortOptions: ['low', 'high', 'max'],
        },
      ])['kimi-k3'],
    ).toEqual({
      name: 'Kimi K3',
      reasoning: true,
      thinking: { effortOptions: ['low', 'high', 'max'] },
    });
  });

  it('applies implicit thinking only to eligible new models', () => {
    expect(modelsFromInputs([{ modelId: 'implicit' }], undefined, true).implicit).toMatchObject({
      reasoning: true,
      thinking_config: { mode: 'switchable', default_value: 'true' },
    });
    expect(
      modelsFromInputs([{ modelId: 'explicit-off', reasoning: false }], undefined, true)[
        'explicit-off'
      ],
    ).toEqual({ reasoning: false });
    expect(
      modelsFromInputs(
        [{ modelId: 'explicit-thinking', thinkingConfig: { mode: 'forced_on' } }],
        undefined,
        true,
      )['explicit-thinking'],
    ).toEqual({ thinking_config: { mode: 'forced_on' } });
    expect(
      modelsFromInputs(
        [{ modelId: 'effort-options', effortOptions: ['low', 'high'] }],
        undefined,
        true,
      )['effort-options'],
    ).toEqual({ reasoning: true, thinking: { effortOptions: ['low', 'high'] } });
    expect(
      modelsFromInputs(
        [{ modelId: 'existing' }],
        { existing: { thinking_config: { mode: 'switchable', default_value: 'false' } } },
        true,
      ).existing,
    ).toEqual({ thinking_config: { mode: 'switchable', default_value: 'false' } });
    expect(modelsFromInputs([{ modelId: 'old' }], { old: {} }, true).old).toEqual({});
  });

  it('merges nested model fields and cleans replaced thinking state', () => {
    const existing: Record<string, LocalModelConfig> = {
      'model-1': {
        limit: { context: 100_000, output: 8_000 },
        modalities: { input: ['text'], output: ['text'] },
        thinking_config: { mode: 'switchable', default_value: 'false' },
        thinking: {
          effort: 'medium',
          defaultEffort: 'medium',
          effortOptions: ['medium'],
        } as unknown as NonNullable<LocalModelConfig['thinking']>,
      },
    };
    const merged = mergeModelsFromInputs(existing, [
      {
        modelId: 'model-1',
        limit: { context: 200_000 },
        modalities: { input: ['text', 'image'] },
        thinkingConfig: { mode: 'forced_on' },
        effortOptions: ['high'],
      },
      { modelId: 'new-model', displayName: 'New model' },
    ]);

    expect(merged['model-1']).toMatchObject({
      limit: { context: 200_000, output: 8_000 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      thinking_config: { mode: 'forced_on', default_value: 'false' },
      thinking: { effortOptions: ['high'] },
    });
    expect(merged['model-1']?.thinking).not.toHaveProperty('effort');
    expect(merged['model-1']?.thinking).not.toHaveProperty('defaultEffort');
    expect(merged['new-model']).toEqual({ name: 'New model' });

    expect(
      mergeModelsFromInputs(
        {
          cleared: {
            thinking: { effort: 'low' } as unknown as NonNullable<LocalModelConfig['thinking']>,
          },
        },
        [{ modelId: 'cleared', effortOptions: [] }],
      ).cleared,
    ).not.toHaveProperty('thinking');
  });

  it('removes incompatible MiniMax M3 state and rejects invalid model fields', () => {
    const merged = mergeModelsFromInputs(
      {
        'MiniMax-M3': {
          thinking_config: { mode: 'switchable' },
          variants: { thinking: {}, 'none-thinking': {} },
        },
      },
      [{ modelId: 'MiniMax-M3', reasoning: false }],
    );
    expect(merged['MiniMax-M3']).toEqual({ reasoning: false });

    expect(() => modelsFromInputs([{ modelId: '   ' }])).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(() =>
      modelsFromInputs([{ modelId: 'model', configurationSource: 'generated' }]),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => modelsFromInputs([{ modelId: 'model', limit: { context: 0 } }])).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(() => modelsFromInputs([{ modelId: 'model', limit: { output: 1.5 } }])).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});

describe('provider credential application', () => {
  it('writes the resolved key and clears it', () => {
    const options: Record<string, unknown> = {};
    applyProviderCredentialUpdate(options, { kind: 'set', apiKey: 'sk-new' });
    expect(options).toEqual({ apiKey: 'sk-new' });
    applyProviderCredentialUpdate(options, { kind: 'clear' });
    expect(options).toEqual({});
  });

  it('leaves the stored key untouched on keep', () => {
    const options: Record<string, unknown> = { apiKey: 'sk-stored' };
    applyProviderCredentialUpdate(options, { kind: 'keep' });
    expect(options).toEqual({ apiKey: 'sk-stored' });
  });
});
