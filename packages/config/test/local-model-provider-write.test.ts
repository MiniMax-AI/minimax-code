import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';

import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  compareAndSetLocalModelContext,
  getConfigPath,
  getConfig,
  removeLocalProviderConfig,
  replaceLocalManagedMinimaxProvider,
  resetConfig,
  resetGitDetect,
  updateLocalByokConfig,
  updateLocalModelSelection,
} from '../src/index.js';

let dataDir: string;

function writeConfig(raw: Record<string, unknown>): void {
  fs.writeFileSync(getConfigPath(), yaml.dump(raw), 'utf-8');
  resetConfig();
}

function readConfig(): Record<string, unknown> {
  return yaml.load(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>;
}

describe('local model-provider config writes', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'model-provider-config-write-'));
    vi.spyOn(os, 'homedir').mockReturnValue(dataDir);
    vi.stubEnv('MINIMAX_DATA_DIR', '');
    vi.stubEnv('MAVIS_DATA_DIR', dataDir);
    vi.stubEnv('__MAVIS_RUNTIME_DISABLE_GIT_AUTO_CONFIG', '1');
    resetGitDetect();
    resetConfig();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetGitDetect();
    resetConfig();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('updates a numeric provider key without corrupting the persisted configuration', async () => {
    fs.writeFileSync(
      getConfigPath(),
      `# provider settings
custom_provider:
  123: # numeric provider
    options:
      baseURL: https://fixture.example/v1
      apiKey: old-placeholder
`,
      'utf-8',
    );
    resetConfig();

    await updateLocalByokConfig((draft) => {
      const providers = draft.custom_provider as Record<
        string,
        { options: Record<string, unknown> }
      >;
      providers['123'].options = {
        ...providers['123'].options,
        apiKey: 'new-placeholder',
      };
    });

    expect(readConfig()).toEqual({
      custom_provider: {
        '123': {
          options: {
            baseURL: 'https://fixture.example/v1',
            apiKey: 'new-placeholder',
          },
        },
      },
    });
    expect(fs.readFileSync(getConfigPath(), 'utf-8')).toContain('# numeric provider');
    resetConfig();
    expect(getConfig().custom_provider?.['123'].options?.apiKey).toBe('new-placeholder');
  });

  it('preserves YAML 1.1 aliased headers when changing only the default model', async () => {
    fs.writeFileSync(
      getConfigPath(),
      `%YAML 1.1
---
defaultModel: custom_provider:primary/old
custom_provider:
  primary:
    options: &options
      baseURL: https://fixture.example/v1
      apiKey: placeholder
      headers:
        X-Feature: on # retain the header value
        X-Binary: "0b10"
  secondary:
    options: *options
`,
      'utf-8',
    );
    resetConfig();
    const expected = {
      ...readConfig(),
      defaultModel: 'custom_provider:primary/new',
    };

    await updateLocalModelSelection({
      modelKey: 'custom_provider:primary/new',
    });

    expect(readConfig()).toEqual(expected);
    expect(fs.readFileSync(getConfigPath(), 'utf-8')).toContain('# retain the header value');
    resetConfig();
    expect(getConfig().custom_provider?.secondary.options?.headers?.['X-Feature']).toBe('on');
  });

  it.each(['primary', 'secondary'])(
    'persists an isolated %s provider update with YAML aliases',
    async (key) => {
      fs.writeFileSync(
        getConfigPath(),
        `# local providers
custom_provider:
  primary:
    options: &options
      baseURL: https://original.example/v1
      apiKey: shared-placeholder
  secondary:
    options: *options
`,
        'utf-8',
      );
      resetConfig();
      const previous = readConfig();
      const expected = structuredClone(previous);
      const providers = expected.custom_provider as Record<
        string,
        { options: Record<string, unknown> }
      >;
      providers[key].options = { ...providers[key].options, apiKey: 'updated-placeholder' };

      await updateLocalByokConfig((draft) => {
        const tree = draft.custom_provider as Record<string, { options: Record<string, unknown> }>;
        tree[key].options = { ...tree[key].options, apiKey: 'updated-placeholder' };
      });

      expect(readConfig()).toEqual(expected);
      expect(fs.readFileSync(getConfigPath(), 'utf-8')).toContain('# local providers');
    },
  );

  it('persists clearing a credential inherited through a YAML merge', async () => {
    fs.writeFileSync(
      getConfigPath(),
      `defaults: &defaults
  apiKey: inherited-placeholder
  baseURL: https://original.example/v1
custom_provider:
  work:
    options:
      <<: *defaults
      authMode: api-key
`,
      'utf-8',
    );
    resetConfig();

    await updateLocalByokConfig((draft) => {
      const tree = draft.custom_provider as Record<string, { options: Record<string, unknown> }>;
      tree.work.options = { ...tree.work.options };
      delete tree.work.options.apiKey;
    });

    expect(readConfig()).toMatchObject({
      defaults: { apiKey: 'inherited-placeholder' },
      custom_provider: {
        work: { options: { baseURL: 'https://original.example/v1', authMode: 'api-key' } },
      },
    });
    expect(getConfig().custom_provider?.work.options?.apiKey).toBeUndefined();
    expect(
      (readConfig().custom_provider as Record<string, { options: Record<string, unknown> }>).work
        .options,
    ).not.toHaveProperty('apiKey');
  });

  it('persists the default model and variant without rewriting provider secrets', async () => {
    writeConfig({
      provider: { work: { options: { apiKey: 'sk-secret' } } },
      defaultModel: 'work/old',
      defaultModelVariant: 'high',
    });

    await updateLocalModelSelection({ modelKey: 'work/new', variant: 'low' });

    expect(readConfig()).toEqual({
      provider: { work: { options: { apiKey: 'sk-secret' } } },
      defaultModel: 'work/new',
      defaultModelVariant: 'low',
    });
  });

  it('restores complete default selection after restart and clears omitted overrides', async () => {
    writeConfig({ provider: { minimax: { models: { 'MiniMax-M3.1': {} } } } });
    await updateLocalModelSelection({
      modelKey: 'minimax/MiniMax-M3.1',
      contextLimit: 1_000_000,
      thinking: { effort: 'max' },
      variant: 'thinking',
    });
    resetConfig();
    expect(getConfig()).toMatchObject({
      defaultModel: 'minimax/MiniMax-M3.1',
      defaultModelContextWindow: 1_000_000,
      defaultModelThinking: { effort: 'max' },
      defaultModelVariant: 'thinking',
    });
    expect(readConfig()).toMatchObject({
      defaultModelContextWindow: 1_000_000,
      defaultModelThinking: { effort: 'max' },
    });
    await updateLocalModelSelection({ modelKey: 'minimax/MiniMax-M3.1' });
    resetConfig();
    expect(getConfig().defaultModelThinking).toBeUndefined();
    expect(getConfig().defaultModelContextWindow).toBeUndefined();
    expect(readConfig()).not.toHaveProperty('defaultModelThinking');
  });

  it('keeps model defaults isolated between runtime profiles', async () => {
    await updateLocalModelSelection({
      modelKey: 'minimax/MiniMax-M3.1',
      contextLimit: 1_000_000,
      thinking: { effort: 'max' },
    });
    const otherProfile = await mkdtemp(join(tmpdir(), 'model-provider-other-profile-'));
    try {
      vi.stubEnv('MAVIS_DATA_DIR', otherProfile);
      resetConfig();
      expect(getConfig().defaultModelThinking).toBeUndefined();
      expect(getConfig().defaultModelContextWindow).toBeUndefined();
      await updateLocalModelSelection({
        modelKey: 'minimax/MiniMax-M3.1',
        contextLimit: 512_000,
        thinking: { effort: 'low' },
      });
      vi.stubEnv('MAVIS_DATA_DIR', dataDir);
      resetConfig();
      expect(getConfig()).toMatchObject({
        defaultModelContextWindow: 1_000_000,
        defaultModelThinking: { effort: 'max' },
      });
    } finally {
      vi.stubEnv('MAVIS_DATA_DIR', dataDir);
      resetConfig();
      await rm(otherProfile, { recursive: true, force: true });
    }
  });

  it('updates the default model and clears its stale variant in the BYOK transaction', async () => {
    writeConfig({
      defaultModel: 'custom_provider:work/gpt-custom',
      defaultModelVariant: 'max',
      defaultModelThinking: { effort: 'max' },
      defaultModelContextWindow: 1_000_000,
    });

    await updateLocalByokConfig((draft) => {
      draft.defaultModel = 'minimax/MiniMax-M3';
      draft.defaultModelVariant = undefined;
    });

    expect(readConfig()).toEqual({ defaultModel: 'minimax/MiniMax-M3' });
  });

  it('removes the migrated OAuth provider while preserving unrelated provider entries', async () => {
    writeConfig({
      provider: {
        'openai-codex': { options: { apiKey: 'legacy' } },
        minimax: { options: { apiKey: 'managed' } },
      },
      custom_provider: {
        'openai-codex': { kind: 'oauth', models: { 'gpt-5': { name: 'gpt-5' } } },
      },
    });

    await removeLocalProviderConfig('openai-codex');

    expect(readConfig()).toEqual({
      provider: { minimax: { options: { apiKey: 'managed' } } },
      custom_provider: {
        'openai-codex': { kind: 'oauth', models: { 'gpt-5': { name: 'gpt-5' } } },
      },
    });
  });

  it('keeps the managed context selection across official snapshot refreshes', async () => {
    writeConfig({
      provider: {
        minimax: {
          models: {
            'MiniMax-M4': {
              name: 'MiniMax-M4',
              limit: { context: 256_000, output: 64_000 },
              contextWindowOptions: [256_000, 768_000],
            },
          },
        },
      },
    });

    const result = await compareAndSetLocalModelContext(
      {
        providerId: 'minimax',
        modelId: 'MiniMax-M4',
        expectedContextLimit: 256_000,
        contextLimit: 768_000,
      },
      async () => true,
    );

    expect(result.updated).toBe(true);
    expect(readConfig()).toMatchObject({
      provider: {
        minimax: { models: { 'MiniMax-M4': { limit: { context: 256_000 } } } },
      },
      minimaxModelContextLimits: { 'MiniMax-M4': 768_000 },
    });
    expect(result.config.provider.minimax?.models?.['MiniMax-M4']?.limit?.context).toBe(768_000);

    const refreshed = await replaceLocalManagedMinimaxProvider({
      model_order: ['MiniMax-M4'],
      models: {
        'MiniMax-M4': {
          name: 'MiniMax-M4',
          limit: { context: 256_000, output: 64_000 },
          contextWindowOptions: [256_000, 768_000],
        },
      },
    });

    expect(readConfig()).toMatchObject({
      provider: {
        minimax: {
          model_order: ['MiniMax-M4'],
          models: { 'MiniMax-M4': { limit: { context: 256_000 } } },
        },
      },
      minimaxModelContextLimits: { 'MiniMax-M4': 768_000 },
    });
    expect(refreshed.config.provider.minimax?.models?.['MiniMax-M4']?.limit?.context).toBe(768_000);

    const restricted = await replaceLocalManagedMinimaxProvider({
      models: {
        'MiniMax-M4': {
          name: 'MiniMax-M4',
          limit: { context: 256_000, output: 64_000 },
          contextWindowOptions: [256_000],
        },
      },
    });

    expect(restricted.config.provider.minimax?.models?.['MiniMax-M4']?.limit?.context).toBe(
      256_000,
    );
  });

  it('persists a BYOK context override without changing the managed snapshot', async () => {
    writeConfig({
      provider: {
        minimax: {
          models: {
            'MiniMax-M3': {
              limit: { context: 512_000 },
              contextWindowOptions: [512_000, 1_000_000],
            },
          },
        },
      },
      minimax_api: { apiKey: 'sk-user-key' },
    });

    const result = await compareAndSetLocalModelContext(
      {
        providerId: 'minimax_api',
        modelId: 'MiniMax-M3',
        expectedContextLimit: 512_000,
        contextLimit: 1_000_000,
      },
      async () => true,
    );

    expect(result.updated).toBe(true);
    expect(readConfig()).toMatchObject({
      provider: {
        minimax: { models: { 'MiniMax-M3': { limit: { context: 512_000 } } } },
      },
      minimax_api: {
        apiKey: 'sk-user-key',
        modelContextLimits: { 'MiniMax-M3': 1_000_000 },
      },
    });

    await replaceLocalManagedMinimaxProvider({
      models: { 'Remote-Only-M4': { limit: { context: 256_000 } } },
    });

    expect(readConfig()).toMatchObject({
      provider: { minimax: { models: { 'Remote-Only-M4': { limit: { context: 256_000 } } } } },
      minimax_api: {
        apiKey: 'sk-user-key',
        modelContextLimits: { 'MiniMax-M3': 1_000_000 },
      },
    });
  });

  it('does not write a BYOK context override after a stale comparison', async () => {
    writeConfig({ minimax_api: { apiKey: 'sk-user-key' } });

    const result = await compareAndSetLocalModelContext(
      {
        providerId: 'minimax_api',
        modelId: 'MiniMax-M3',
        expectedContextLimit: 1_000_000,
        contextLimit: 512_000,
      },
      async () => true,
    );

    expect(result.updated).toBe(false);
    expect(readConfig()).toEqual({ minimax_api: { apiKey: 'sk-user-key' } });
  });
});
