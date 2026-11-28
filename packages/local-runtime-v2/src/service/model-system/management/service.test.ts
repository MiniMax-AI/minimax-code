import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  LocalByokConfigDraft,
  LocalRuntimeConfig,
  ModelConnectionTestResult,
  ModelConnectionTestTarget,
  ModelDiscoveryResult,
  ModelDiscoveryTarget,
} from '../contracts.js';
import { planCustomProviderResolution } from '../resolution/model-resolver-byok.js';
import { LocalModelCache } from '../catalog/model-cache.js';
import { MINIMAX_API_DEFAULT_BASE_URL, minimaxApiModels } from '../catalog/minimax-api.js';
import { listLocalRuntimeModels } from '../catalog/catalog.js';
import { LocalModelProviderError, LocalModelProviderService } from './service.js';

const RAW_KEY = 'sk-user-minimax-key-12345678';
const CUSTOM_KEY = 'sk-custom-key-abcdefgh';

let dataDir: string;

interface Harness {
  service: LocalModelProviderService;
  config: LocalRuntimeConfig;
  cache: LocalModelCache;
  selectModel: ReturnType<typeof vi.fn>;
  testCalls: Array<{ key: string; target: ModelConnectionTestTarget }>;
  discoverCalls: ModelDiscoveryTarget[];
  setTestResult(result: ModelConnectionTestResult): void;
  setTestHandler(
    handler: (key: string, target: ModelConnectionTestTarget) => Promise<ModelConnectionTestResult>,
  ): void;
  setDiscoverResult(result: ModelDiscoveryResult): void;
  failNextConfigWrite(error: Error): void;
  setNextRawCustomProviders(raw: Record<string, unknown> | undefined): void;
}

function makeHarness(
  initial?: Partial<LocalRuntimeConfig>,
  options: {
    implicitCustomProviderThinking?: boolean;
  } = {},
): Harness {
  const config: LocalRuntimeConfig = {
    dataDir,
    provider: {
      minimax: {
        options: { authMode: 'managed-login', baseURL: 'https://managed.example/v1' },
        models: {
          'MiniMax-M3': {
            name: 'MiniMax M3',
            limit: { context: 200_000, output: 32_000 },
            contextWindowOptions: [512_000, 1_000_000],
          },
          'MiniMax-M2.5': { name: 'MiniMax M2.5' },
        },
      },
    },
    defaultModel: 'minimax/MiniMax-M3',
    ...initial,
  };
  let testResult: ModelConnectionTestResult = { ok: true };
  let testHandler:
    | ((key: string, target: ModelConnectionTestTarget) => Promise<ModelConnectionTestResult>)
    | undefined;
  let configWriteError: Error | undefined;
  let discoverResult: ModelDiscoveryResult = { ok: true, models: [] };
  let nextRawCustomProviders: Record<string, unknown> | undefined;
  const testCalls: Array<{ key: string; target: ModelConnectionTestTarget }> = [];
  const discoverCalls: ModelDiscoveryTarget[] = [];
  let configUpdateTail = Promise.resolve();
  const selectModel = vi.fn(async (modelKey: string) => {
    config.defaultModel = modelKey;
  });
  const cache = new LocalModelCache(() => dataDir);
  const service = new LocalModelProviderService({
    configGetter: () => config,
    updateByokConfig: (mutate, beforeCommit) => {
      const update = (async () => {
        await configUpdateTail;
        const draft: LocalByokConfigDraft = {
          minimax_api: config.minimax_api ? { ...config.minimax_api } : undefined,
          custom_provider: nextRawCustomProviders
            ? (JSON.parse(JSON.stringify(nextRawCustomProviders)) as Record<string, unknown>)
            : config.custom_provider
              ? (JSON.parse(JSON.stringify(config.custom_provider)) as Record<string, unknown>)
              : undefined,
          minimaxModelSource: config.minimaxModelSource,
          defaultModel: config.defaultModel,
          defaultModelVariant: config.defaultModelVariant,
        };
        await mutate(draft, config);
        nextRawCustomProviders = undefined;
        if (configWriteError) {
          const error = configWriteError;
          configWriteError = undefined;
          throw error;
        }
        beforeCommit?.();
        config.minimax_api = draft.minimax_api as LocalRuntimeConfig['minimax_api'];
        config.custom_provider = draft.custom_provider as LocalRuntimeConfig['custom_provider'];
        config.minimaxModelSource = draft.minimaxModelSource;
        config.defaultModel = draft.defaultModel;
        config.defaultModelVariant = draft.defaultModelVariant;
        return { config };
      })();
      configUpdateTail = update.then(
        () => undefined,
        () => undefined,
      );
      return update;
    },
    cache,
    tester: {
      test: async (key, target) => {
        testCalls.push({ key, target });
        if (testHandler) return testHandler(key, target);
        return testResult;
      },
    },
    discoverer: {
      discover: async (target) => {
        discoverCalls.push(target);
        return discoverResult;
      },
    },
    compareAndSetModelContext: (input, beforeCommit) => {
      const update = configUpdateTail.then(async () => {
        const model =
          input.providerId === 'minimax_api'
            ? minimaxApiModels(config)[input.modelId]
            : config.provider?.[input.providerId]?.models?.[input.modelId];
        if (model?.limit?.context !== input.expectedContextLimit) return false;
        if (!(await beforeCommit(config))) return false;
        if (configWriteError) {
          const error = configWriteError;
          configWriteError = undefined;
          throw error;
        }
        if (input.providerId === 'minimax_api') {
          config.minimax_api = {
            ...(config.minimax_api ?? {}),
            modelContextLimits: {
              ...(config.minimax_api?.modelContextLimits ?? {}),
              [input.modelId]: input.contextLimit,
            },
          };
        } else {
          model.limit = { ...model.limit, context: input.contextLimit };
        }
        return true;
      });
      configUpdateTail = update.then(
        () => undefined,
        () => undefined,
      );
      return update;
    },
    selectModel,
    ...options,
    now: () => 1_750_000_000_000,
    randomHex: () => 'a1b2c3',
  });
  return {
    service,
    config,
    cache,
    selectModel,
    testCalls,
    discoverCalls,
    setTestResult: (result) => {
      testResult = result;
    },
    setTestHandler: (handler) => {
      testHandler = handler;
    },
    setDiscoverResult: (result) => {
      discoverResult = result;
    },
    failNextConfigWrite: (error) => {
      configWriteError = error;
    },
    setNextRawCustomProviders: (raw) => {
      nextRawCustomProviders = raw;
    },
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'model-provider-service-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('MiniMax api key', () => {
  it('reports no key before upsert and a masked key after', async () => {
    const h = makeHarness();
    expect(h.service.getMinimaxApiKeyStatus()).toEqual({ hasApiKey: false });

    await h.service.upsertMinimaxApiKey({ apiKey: RAW_KEY });
    const status = h.service.getMinimaxApiKeyStatus();
    expect(status.hasApiKey).toBe(true);
    expect(status.maskedApiKey).toBe(`${RAW_KEY.slice(0, 4)}****${RAW_KEY.slice(-4)}`);
    expect(status.maskedApiKey).not.toBe(RAW_KEY);
    expect(h.config.minimax_api?.apiKey).toBe(RAW_KEY);
  });

  it('uses remote-only models from the shared official catalog for MiniMax API', async () => {
    const h = makeHarness({
      provider: {
        minimax: {
          models: {
            'Remote-B': { name: 'Remote B' },
            'Remote-C': { name: 'Remote C' },
          },
        },
      },
    });

    const provider = await h.service.upsertMinimaxApiKey({ apiKey: RAW_KEY });

    expect(provider.models.map((model) => model.modelId)).toEqual(['Remote-B', 'Remote-C']);
  });

  it('rejects empty, whitespace-only, and masked placeholder keys', async () => {
    const h = makeHarness();
    for (const bad of ['', '   ', 'sk-u****5678', '****']) {
      await expect(h.service.upsertMinimaxApiKey({ apiKey: bad })).rejects.toBeInstanceOf(
        LocalModelProviderError,
      );
    }
    expect(h.config.minimax_api).toBeUndefined();
  });

  it('upsert preserves an existing baseURL override and never writes one', async () => {
    const h = makeHarness({ minimax_api: { apiKey: 'sk-old', baseURL: 'https://custom.example' } });
    await h.service.upsertMinimaxApiKey({ apiKey: RAW_KEY });
    expect(h.config.minimax_api).toEqual({ apiKey: RAW_KEY, baseURL: 'https://custom.example' });

    const h2 = makeHarness();
    await h2.service.upsertMinimaxApiKey({ apiKey: RAW_KEY });
    expect(h2.config.minimax_api).toEqual({ apiKey: RAW_KEY });
  });

  it('save_and_use sets minimaxModelSource without calling selectModel', async () => {
    const h = makeHarness();
    await h.service.upsertMinimaxApiKey({ apiKey: RAW_KEY, saveAndUse: true });
    expect(h.selectModel).not.toHaveBeenCalled();
    expect(h.testCalls).toEqual([]);
    expect(h.config.minimax_api?.apiKey).toBe(RAW_KEY);
    expect(h.config.minimaxModelSource).toBe('minimax_api_key');
  });

  it('save_and_use sets minimaxModelSource when default model is unknown', async () => {
    const h = makeHarness({ defaultModel: 'other/unknown-model' });
    await h.service.upsertMinimaxApiKey({ apiKey: RAW_KEY, saveAndUse: true });
    expect(h.selectModel).not.toHaveBeenCalled();
    expect(h.config.minimaxModelSource).toBe('minimax_api_key');
  });

  it('switches to the MiniMax API source without a prior connection test', async () => {
    const h = makeHarness();
    await h.service.upsertMinimaxApiKey({ apiKey: RAW_KEY });

    await expect(h.service.setMinimaxModelSource('minimax_api_key')).resolves.toBe(
      'minimax_api_key',
    );
    expect(h.testCalls).toEqual([]);
    expect(h.config.minimaxModelSource).toBe('minimax_api_key');
    expect(() => h.service.assertModelSelectable('minimax', 'MiniMax-M3')).not.toThrow();

    const m3 = h.config.provider?.minimax?.models?.['MiniMax-M3'];
    if (!m3?.limit) throw new Error('invalid MiniMax-M3 test fixture');
    m3.limit.context = 1_000_000;
    expect(() => h.service.assertModelSelectable('minimax', 'MiniMax-M3')).not.toThrow();
  });

  it('switches to the MiniMax API source after a failed connection test', async () => {
    const h = makeHarness();
    h.setTestResult({
      ok: false,
      errorCode: 'UPSTREAM_REJECTED',
      errorMessage: 'provider rejected the test request',
    });
    await h.service.upsertMinimaxApiKey({ apiKey: RAW_KEY });
    await h.service.testProvider('minimax_api');

    await expect(h.service.setMinimaxModelSource('minimax_api_key')).resolves.toBe(
      'minimax_api_key',
    );
    expect(h.config.minimaxModelSource).toBe('minimax_api_key');
  });

  it('still requires a saved key before switching to the MiniMax API source', async () => {
    const h = makeHarness();

    await expect(h.service.setMinimaxModelSource('minimax_api_key')).rejects.toMatchObject({
      code: 'NO_API_KEY',
    });
    expect(h.config.minimaxModelSource).toBeUndefined();
  });

  it('allows selecting a configured custom model without a prior connectivity test', () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          api: 'openai-completions',
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://saved.example/v1' },
          models: {
            'm-1': { limit: { context: 128_000, output: 16_000 } },
          },
        },
      },
    });

    expect(h.cache.load().model_status).toEqual({});
    expect(h.testCalls).toEqual([]);
    expect(() => h.service.assertModelSelectable('custom_provider:work', 'm-1')).not.toThrow();
  });

  it('allows selecting a login-backed custom model without an API key', () => {
    const h = makeHarness({
      custom_provider: {
        login: {
          kind: 'oauth',
          enabled: true,
          models: {
            'm-1': { limit: { context: 128_000, output: 16_000 } },
          },
        },
      },
    });

    expect(() => h.service.assertModelSelectable('custom_provider:login', 'm-1')).not.toThrow();
    expect(h.testCalls).toEqual([]);
  });

  it('allows selecting a configured custom model with a failed cached connectivity status', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          api: 'openai-completions',
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://saved.example/v1' },
          models: {
            'm-1': { limit: { context: 128_000, output: 16_000 } },
          },
        },
      },
    });
    h.setTestResult({
      ok: false,
      errorCode: 'UPSTREAM_REJECTED',
      errorMessage: 'provider rejected the test request',
    });

    await expect(h.service.testModel('custom_provider:work', 'm-1')).resolves.toMatchObject({
      ok: false,
      status: { state: 'failed' },
    });

    expect(h.cache.load().model_status['custom_provider:work/m-1']).toMatchObject({
      state: 'failed',
    });
    expect(() => h.service.assertModelSelectable('custom_provider:work', 'm-1')).not.toThrow();
  });

  it('still rejects selecting a custom model with incomplete or unavailable configuration', () => {
    const missingKey = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          api: 'openai-completions',
          options: { baseURL: 'https://saved.example/v1' },
          models: {
            'm-1': { limit: { context: 128_000, output: 16_000 } },
          },
        },
      },
    });

    expect(() =>
      missingKey.service.assertModelSelectable('custom_provider:work', 'm-1'),
    ).toThrowError(expect.objectContaining({ code: 'NO_API_KEY' }));

    const missingBaseUrl = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          api: 'openai-completions',
          options: { apiKey: CUSTOM_KEY },
          models: {
            'm-1': { limit: { context: 128_000, output: 16_000 } },
          },
        },
      },
    });

    expect(() =>
      missingBaseUrl.service.assertModelSelectable('custom_provider:work', 'm-1'),
    ).toThrowError(expect.objectContaining({ code: 'NO_BASE_URL' }));

    const missingModel = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          api: 'openai-completions',
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://saved.example/v1' },
          models: {
            'other-model': { limit: { context: 128_000, output: 16_000 } },
          },
        },
      },
    });

    expect(() =>
      missingModel.service.assertModelSelectable('custom_provider:work', 'm-1'),
    ).toThrowError(expect.objectContaining({ code: 'MODEL_NOT_FOUND' }));
  });
});

describe('MiniMax model context', () => {
  it('updates a managed model using its current dynamic context options', async () => {
    const h = makeHarness({
      minimaxModelSource: 'token_plan',
      provider: {
        minimax: {
          models: {
            'MiniMax-M4': {
              name: 'MiniMax M4',
              limit: { context: 256_000, output: 64_000 },
              contextWindowOptions: [256_000, 768_000],
            },
          },
        },
      },
    });

    await expect(
      h.service.updateMinimaxModelContext({
        modelId: 'MiniMax-M4',
        contextLimit: 768_000,
        expectedContextLimit: 256_000,
      }),
    ).resolves.toEqual({ ok: true });
    expect(h.config.provider.minimax?.models?.['MiniMax-M4']?.limit?.context).toBe(768_000);
  });

  it('tests a Paygo M3 context candidate before committing config and cache together', async () => {
    const h = makeHarness({
      minimax_api: { apiKey: RAW_KEY },
      minimaxModelSource: 'minimax_api_key',
    });
    const m3 = h.config.provider.minimax?.models?.['MiniMax-M3'];
    if (!m3) throw new Error('missing MiniMax-M3 fixture');
    m3.limit = { ...m3.limit, context: 512_000 };

    const outcome = await h.service.updateMinimaxModelContext({
      modelId: 'MiniMax-M3',
      contextLimit: 1_000_000,
      expectedContextLimit: 512_000,
    });

    expect(outcome).toMatchObject({ ok: true, status: { state: 'available' } });
    expect(h.testCalls).toHaveLength(1);
    expect(h.testCalls[0]?.target).toMatchObject({
      api: 'anthropic-messages',
      apiKey: RAW_KEY,
      modelId: 'MiniMax-M3',
    });
    expect(m3.limit?.context).toBe(512_000);
    expect(h.config.minimax_api?.modelContextLimits).toEqual({ 'MiniMax-M3': 1_000_000 });
    expect(minimaxApiModels(h.config)['MiniMax-M3']?.limit?.context).toBe(1_000_000);
    h.config.provider.minimax = {
      models: { 'Remote-Only-M4': { limit: { context: 256_000 } } },
    };
    expect(minimaxApiModels(h.config)['MiniMax-M3']).toBeUndefined();
    expect(() => h.service.assertModelSelectable('minimax', 'MiniMax-M3')).toThrowError(
      expect.objectContaining({ code: 'MODEL_NOT_FOUND' }),
    );
  });

  it('keeps the current Paygo M3 context and cache when its candidate test fails', async () => {
    const h = makeHarness({
      minimax_api: { apiKey: RAW_KEY },
      minimaxModelSource: 'minimax_api_key',
    });
    const m3 = h.config.provider.minimax?.models?.['MiniMax-M3'];
    if (!m3) throw new Error('missing MiniMax-M3 fixture');
    m3.limit = { ...m3.limit, context: 512_000 };
    h.setTestResult({ ok: false, errorCode: 'rejected', errorMessage: 'Rejected' });

    await expect(
      h.service.updateMinimaxModelContext({
        modelId: 'MiniMax-M3',
        contextLimit: 1_000_000,
        expectedContextLimit: 512_000,
      }),
    ).resolves.toMatchObject({ ok: false, status: { state: 'failed' } });
    expect(m3.limit?.context).toBe(512_000);
    expect(h.cache.load().model_status['minimax_api/MiniMax-M3']).toBeUndefined();
  });

  it('ignores an unsupported stored BYOK context and rejects selecting it', async () => {
    const h = makeHarness({
      minimax_api: {
        apiKey: RAW_KEY,
        modelContextLimits: { 'MiniMax-M3': 768_000 },
      },
      minimaxModelSource: 'minimax_api_key',
    });

    expect(minimaxApiModels(h.config)['MiniMax-M3']?.limit?.context).toBe(200_000);
    await expect(
      h.service.updateMinimaxModelContext({
        modelId: 'MiniMax-M3',
        contextLimit: 768_000,
        expectedContextLimit: 200_000,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT_LIMIT', status: 400 });
    expect(h.testCalls).toHaveLength(0);
  });
});

describe('MiniMax model context transactions', () => {
  it.each([
    [
      'source',
      (h: Harness) => {
        h.config.minimaxModelSource = 'token_plan';
      },
    ],
    [
      'api key',
      (h: Harness) => {
        h.config.minimax_api = { apiKey: 'sk-changed-key' };
      },
    ],
  ])('rejects the M3 commit when the MiniMax %s changes during testing', async (_name, change) => {
    const h = makeHarness({
      minimax_api: { apiKey: RAW_KEY },
      minimaxModelSource: 'minimax_api_key',
    });
    const m3 = h.config.provider.minimax?.models?.['MiniMax-M3'];
    if (!m3) throw new Error('missing MiniMax-M3 fixture');
    m3.limit = { ...m3.limit, context: 512_000 };
    h.setTestHandler(async () => {
      change(h);
      return { ok: true };
    });

    await expect(
      h.service.updateMinimaxModelContext({
        modelId: 'MiniMax-M3',
        contextLimit: 1_000_000,
        expectedContextLimit: 512_000,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_CHANGED', status: 409 });
    expect(m3.limit?.context).toBe(512_000);
    expect(h.cache.load().model_status['minimax_api/MiniMax-M3']).toBeUndefined();
  });

  it('serializes an older MiniMax test ahead of an M3 context transaction', async () => {
    const h = makeHarness({
      minimax_api: { apiKey: RAW_KEY },
      minimaxModelSource: 'minimax_api_key',
    });
    const m3 = h.config.provider.minimax?.models?.['MiniMax-M3'];
    if (!m3) throw new Error('missing MiniMax-M3 fixture');
    m3.limit = { ...m3.limit, context: 512_000 };
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let calls = 0;
    h.setTestHandler(async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted?.();
        await firstBlocked;
      }
      return { ok: true };
    });

    const olderTest = h.service.testModel('minimax_api', 'MiniMax-M3');
    await started;
    const contextUpdate = h.service.updateMinimaxModelContext({
      modelId: 'MiniMax-M3',
      contextLimit: 1_000_000,
      expectedContextLimit: 512_000,
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst?.();
    await expect(Promise.all([olderTest, contextUpdate])).resolves.toMatchObject([
      { ok: true },
      { ok: true },
    ]);

    expect(calls).toBe(3);
    expect(m3.limit?.context).toBe(512_000);
    expect(h.config.minimax_api?.modelContextLimits).toEqual({ 'MiniMax-M3': 1_000_000 });
    expect(minimaxApiModels(h.config)['MiniMax-M3']?.limit?.context).toBe(1_000_000);
    expect(() => h.service.assertModelSelectable('minimax', 'MiniMax-M3')).not.toThrow();
  });

  it('updates token-plan M3 context directly without a connection test', async () => {
    const h = makeHarness({ minimaxModelSource: 'token_plan' });
    const m3 = h.config.provider.minimax?.models?.['MiniMax-M3'];
    if (!m3) throw new Error('missing MiniMax-M3 fixture');
    m3.limit = { ...m3.limit, context: 512_000 };

    await expect(
      h.service.updateMinimaxModelContext({
        modelId: 'MiniMax-M3',
        contextLimit: 1_000_000,
        expectedContextLimit: 512_000,
      }),
    ).resolves.toEqual({ ok: true });
    expect(h.testCalls).toHaveLength(0);
    expect(m3.limit?.context).toBe(1_000_000);
  });

  it('restores the cache state observed inside the M3 config transaction', async () => {
    const h = makeHarness({
      minimax_api: { apiKey: RAW_KEY },
      minimaxModelSource: 'minimax_api_key',
    });
    const m3 = h.config.provider.minimax?.models?.['MiniMax-M3'];
    if (!m3) throw new Error('missing MiniMax-M3 fixture');
    m3.limit = { ...m3.limit, context: 512_000 };
    await h.cache.setModelStatus('minimax_api/MiniMax-M3', {
      state: 'available',
      config_fingerprint: 'sha256:old',
    });
    h.setTestHandler(async () => {
      await h.cache.setModelStatus('minimax_api/MiniMax-M3', {
        state: 'failed',
        last_error_code: 'intervening',
        config_fingerprint: 'sha256:intervening',
      });
      return { ok: true };
    });
    h.failNextConfigWrite(new Error('config disk full'));

    await expect(
      h.service.updateMinimaxModelContext({
        modelId: 'MiniMax-M3',
        contextLimit: 1_000_000,
        expectedContextLimit: 512_000,
      }),
    ).rejects.toThrow('config disk full');
    expect(m3.limit?.context).toBe(512_000);
    expect(h.cache.load().model_status['minimax_api/MiniMax-M3']).toMatchObject({
      state: 'failed',
      last_error_code: 'intervening',
      config_fingerprint: 'sha256:intervening',
    });
  });
});

describe('MiniMax api key response', () => {
  it('upsert response contains only the masked key', async () => {
    const h = makeHarness();
    const provider = await h.service.upsertMinimaxApiKey({ apiKey: RAW_KEY });
    expect(provider.hasApiKey).toBe(true);
    expect(provider.maskedApiKey).toContain('****');
    expect(provider.maskedApiKey).not.toBe(RAW_KEY);
    expect(provider).not.toHaveProperty('rawApiKey');
    expect(JSON.stringify(provider)).not.toContain(RAW_KEY);
    expect(provider.providerId).toBe('minimax_api');
    expect(provider.kind).toBe('minimax-api-key');
    expect(provider.source).toBe('minimax_api');
  });

  it('accepts OpenAI Responses and passes custom headers to the connection test', async () => {
    const h = makeHarness();
    const provider = await h.service.createUserProvider({
      name: 'Responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: CUSTOM_KEY,
      apiFormat: 'openai-responses',
      headers: { 'OpenAI-Organization': 'org-test' },
      models: [{ modelId: 'gpt-5.2', effortOptions: ['max'] }],
    });

    await h.service.testModel(provider.providerId, 'gpt-5.2');

    expect(h.testCalls[0]?.target).toEqual({
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: CUSTOM_KEY,
      modelId: 'gpt-5.2',
      headers: { 'OpenAI-Organization': 'org-test' },
      effort: 'max',
      outputLimit: 16_384,
      sessionId: expect.any(String),
    });
    expect(h.testCalls[0]?.key).toMatch(/^custom_provider:responses\/gpt-5\.2@sha256:/u);
    expect(
      h.cache.load().model_status['custom_provider:responses/gpt-5.2']?.config_fingerprint,
    ).toMatch(/^sha256:/u);
  });

  it('passes Gemini model IDs and efforts verbatim to connectivity tests without local restrictions', async () => {
    const h = makeHarness();
    const gemini = {
      name: 'Gemini Gateway',
      baseUrl: 'https://gateway.example.com/v1beta',
      apiKey: CUSTOM_KEY,
      apiFormat: 'google-generative-ai',
      models: [{ modelId: 'google/gemini-4-carbon', effortOptions: ['minimal', 'xhigh'] }],
    };

    const outcome = await h.service.testUserModelCandidate(gemini, 'google/gemini-4-carbon');
    expect(outcome.ok).toBe(true);
    expect(
      h.testCalls.map(({ target }) => ({ modelId: target.modelId, effort: target.effort })),
    ).toEqual([
      { modelId: 'google/gemini-4-carbon', effort: 'minimal' },
      { modelId: 'google/gemini-4-carbon', effort: 'xhigh' },
    ]);
  });
});

describe('custom provider API key reveal', () => {
  function makeRevealHarness() {
    return makeHarness({
      custom_provider: {
        work: {
          api: 'openai-responses',
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://example.invalid/v1' },
          models: {},
        },
      },
    });
  }
  it('reveals only the current custom key without persisting or changing list redaction', () => {
    const harness = makeRevealHarness();
    const provider = harness.service.listUserProviders()[0]!;
    const before = structuredClone(harness.config);
    expect(harness.service.revealModelProviderApiKey({ providerId: provider.providerId })).toBe(
      CUSTOM_KEY,
    );
    expect(harness.config).toEqual(before);
    expect(JSON.stringify(harness.service.listUserProviders())).not.toContain(CUSTOM_KEY);
  });

  it('reads the latest saved key without a revision and rejects missing providers', () => {
    const { service, config } = makeRevealHarness();
    config.custom_provider!.work!.options!.apiKey = 'replacement-fictional-key';
    expect(service.revealModelProviderApiKey({ providerId: 'custom_provider:work' })).toBe(
      'replacement-fictional-key',
    );
    expect(() =>
      service.revealModelProviderApiKey({ providerId: 'custom_provider:missing' }),
    ).toThrow('Model provider not found');
    expect(() => service.revealModelProviderApiKey({ providerId: 'builtin:minimax' })).toThrow(
      'Model provider not found',
    );
  });

  it('reads only the user MiniMax API key and never falls back to the managed provider key', () => {
    const { service, config } = makeHarness();
    expect(() => service.revealModelProviderApiKey({ providerId: 'minimax_api' })).toThrow(
      'MiniMax API key is not configured',
    );
    config.minimax_api = { apiKey: CUSTOM_KEY };
    expect(service.revealModelProviderApiKey({ providerId: 'minimax_api' })).toBe(CUSTOM_KEY);
    expect(JSON.stringify(service.getMinimaxApiKeyStatus())).not.toContain(CUSTOM_KEY);
  });

  it.each([
    { kind: 'oauth' },
    { api: 'openai-codex-responses' },
    { options: { authMode: 'oauth', apiKey: 'fictional-oauth-secret' } },
  ])('rejects OAuth credentials: %j', (overrides) => {
    const { config, service } = makeRevealHarness();
    Object.assign(config.custom_provider!.work!, overrides);
    const provider = service.listUserProviders()[0]!;
    expect(() => service.revealModelProviderApiKey({ providerId: provider.providerId })).toThrow(
      'OAuth credentials cannot be revealed',
    );
  });

  it('rejects a provider without an API key', () => {
    const { config, service } = makeRevealHarness();
    delete config.custom_provider!.work!.options!.apiKey;
    const provider = service.listUserProviders()[0]!;
    expect(() => service.revealModelProviderApiKey({ providerId: provider.providerId })).toThrow(
      'Provider API key is not configured',
    );
  });
});

function registerCustomProviderDiscoveryTests(): void {
  it('discovers a new provider with its draft key before any model or configuration is saved', async () => {
    const h = makeHarness({});
    const before = JSON.stringify(h.config);
    h.setDiscoverResult({ ok: true, models: [{ modelId: 'new-model' }] });
    await expect(
      h.service.discoverUserModelsCandidate({
        name: 'Draft gateway',
        baseUrl: 'https://draft.example/v1',
        apiKey: 'synthetic-draft-key',
        apiFormat: 'openai-completions',
      }),
    ).resolves.toEqual([{ modelId: 'new-model' }]);
    expect(h.discoverCalls).toEqual([
      expect.objectContaining({
        baseUrl: 'https://draft.example/v1',
        apiKey: 'synthetic-draft-key',
        api: 'openai-completions',
      }),
    ]);
    expect(JSON.stringify(h.config)).toBe(before);
    expect(h.testCalls).toEqual([]);
  });

  it('tests and discovers an edit candidate without mutating config or cache', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          name: 'Work',
          api: 'openai-completions',
          options: {
            apiKey: CUSTOM_KEY,
            baseURL: 'https://saved.example/v1',
            headers: { 'X-Saved': 'one' },
          },
          models: { 'm-1': { name: 'Saved model' } },
        },
      },
    });
    h.setDiscoverResult({
      ok: true,
      models: [{ modelId: 'm-discovered', displayName: 'Discovered' }],
    });
    const revision = h.service.listUserProviders()[0]?.configRevision;
    if (!revision) throw new Error('missing provider revision');
    const savedConfig = JSON.stringify(h.config.custom_provider);
    const candidate = {
      providerId: 'custom_provider:work',
      expectedRevision: revision,
      name: 'Candidate',
      baseUrl: 'https://candidate.example/v1',
      apiKey: 'sk-candidate-key-12345678',
      apiFormat: 'openai-responses',
      headers: { 'X-Candidate': 'two' },
      removeHeaders: ['x-saved'],
      models: [{ modelId: 'm-1', displayName: 'Candidate model', effortOptions: ['xhigh'] }],
    };

    await expect(h.service.testUserModelCandidate(candidate, 'm-1')).resolves.toMatchObject({
      ok: true,
      status: { state: 'available' },
    });
    await expect(h.service.discoverUserModelsCandidate(candidate)).resolves.toEqual([
      { modelId: 'm-discovered', displayName: 'Discovered' },
    ]);

    expect(h.testCalls[0]?.target).toEqual({
      api: 'openai-responses',
      baseUrl: 'https://candidate.example/v1',
      apiKey: 'sk-candidate-key-12345678',
      modelId: 'm-1',
      headers: { 'X-Candidate': 'two' },
      effort: 'xhigh',
      outputLimit: 16_384,
      sessionId: expect.any(String),
    });
    expect(h.discoverCalls).toEqual([
      {
        api: 'openai-responses',
        baseUrl: 'https://candidate.example/v1',
        apiKey: 'sk-candidate-key-12345678',
        headers: { 'X-Candidate': 'two' },
      },
    ]);
    expect(JSON.stringify(h.config.custom_provider)).toBe(savedConfig);
    expect(h.cache.load().model_status).toEqual({});
    expect(h.cache.load().provider_status).toEqual({});
  });
}

function registerCustomProviderThinkEffortTests(): void {
  it('tests every configured Think Effort option for a draft model', async () => {
    const h = makeHarness();

    await expect(
      h.service.testUserModelCandidate(
        {
          name: 'Thinking Provider',
          baseUrl: 'https://api.example.com/v1',
          apiKey: CUSTOM_KEY,
          apiFormat: 'openai-responses',
          models: [
            {
              modelId: 'thinking-model',
              effortOptions: ['low', 'high', 'max'],
            },
          ],
        },
        'thinking-model',
      ),
    ).resolves.toMatchObject({ ok: true, status: { state: 'available' } });

    expect(h.testCalls.map((call) => call.target.effort)).toEqual(['low', 'high', 'max']);
    expect(new Set(h.testCalls.map((call) => call.key)).size).toBe(3);
  });

  it('tests every configured MiniMax-M3 Think Effort and reports the failing level', async () => {
    const h = makeHarness();
    h.setTestHandler(async (_key, target) =>
      target.effort === 'off'
        ? { ok: false, errorCode: 'http_400', errorMessage: 'disabled rejected' }
        : { ok: true },
    );

    const outcome = await h.service.testUserModelCandidate(
      {
        name: 'MiniMax Work',
        baseUrl: 'https://api.minimax.io/v1',
        apiKey: CUSTOM_KEY,
        apiFormat: 'openai-completions',
        models: [{ modelId: 'MiniMax-M3', effortOptions: ['on', 'off'] }],
      },
      'MiniMax-M3',
    );

    expect(outcome).toMatchObject({
      ok: false,
      status: {
        state: 'failed',
        lastErrorCode: 'http_400',
        lastErrorMessage: 'Think Effort "off": disabled rejected',
      },
    });
    expect(h.testCalls.map((call) => call.target.effort)).toEqual(['off', 'on']);
  });

  it('probes a custom MiniMax-M3 with the default output limit when none is configured', async () => {
    const h = makeHarness();

    await h.service.testUserModelCandidate(
      {
        name: 'MiniMax Work',
        baseUrl: 'https://api.minimax.io/v1',
        apiKey: CUSTOM_KEY,
        apiFormat: 'openai-completions',
        models: [{ modelId: 'MiniMax-M3', effortOptions: ['on', 'off'] }],
      },
      'MiniMax-M3',
    );

    // A real turn sends 16_384 here. A smaller probe budget fails the thinking
    // output floor upstream and reports a working model as unavailable.
    expect(h.testCalls.map((call) => call.target.outputLimit)).toEqual([16_384, 16_384]);
  });

  it('tests every Think Effort option and reports the failing level before saving', async () => {
    const h = makeHarness();
    h.setTestHandler(async (_key, target) =>
      target.effort === 'high'
        ? { ok: false, errorCode: 'http_400', errorMessage: 'HTTP 400' }
        : { ok: true },
    );

    const outcome = await h.service.saveUserModelProviderCandidate({
      candidate: {
        name: 'Thinking Provider',
        baseUrl: 'https://api.example.com/v1',
        apiKey: CUSTOM_KEY,
        apiFormat: 'openai-completions',
        models: [
          {
            modelId: 'thinking-model',
            effortOptions: ['low', 'high', 'max', 'xhigh'],
          },
        ],
      },
      modelId: 'thinking-model',
      saveAndUse: true,
    });

    expect(outcome).toMatchObject({
      ok: false,
      status: {
        state: 'failed',
        lastErrorCode: 'http_400',
        lastErrorMessage: 'Think Effort "high": HTTP 400',
      },
    });
    expect(h.testCalls.map((call) => call.target.effort)).toEqual(['low', 'high', 'xhigh', 'max']);
    expect(h.config.custom_provider).toBeUndefined();
    expect(h.cache.load().model_status).toEqual({});
  });

  it('tests every saved Think Effort option from the model refresh action', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          api: 'anthropic-messages',
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com' },
          models: {
            'thinking-model': {
              thinking: { effortOptions: ['low', 'high', 'max'] },
            },
          },
        },
      },
    });

    await expect(
      h.service.testModel('custom_provider:work', 'thinking-model'),
    ).resolves.toMatchObject({ ok: true, status: { state: 'available' } });

    expect(h.testCalls.map((call) => call.target.effort)).toEqual(['low', 'high', 'max']);
    expect(h.cache.load().model_status['custom_provider:work/thinking-model']).toMatchObject({
      state: 'available',
    });
  });
}

describe('custom providers', () => {
  registerCustomProviderDiscoveryTests();
  registerCustomProviderThinkEffortTests();
});

describe('custom provider candidate persistence implicit thinking default', () => {
  it('defaults only newly added models through the public candidate save path', async () => {
    const h = makeHarness(
      {
        custom_provider: {
          work: {
            name: 'Work',
            api: 'openai-responses',
            options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com/v1' },
            models: { old: {} },
          },
        },
      },
      { implicitCustomProviderThinking: true },
    );
    const revision = h.service.listUserProviders()[0]?.configRevision;
    if (!revision) throw new Error('missing provider revision');

    await h.service.saveUserModelProviderCandidate({
      candidate: {
        providerId: 'custom_provider:work',
        expectedRevision: revision,
        name: 'Work',
        baseUrl: 'https://api.example.com/v1',
        apiKey: CUSTOM_KEY,
        apiFormat: 'openai-responses',
        models: [{ modelId: 'old' }, { modelId: 'added' }],
      },
      saveAndUse: false,
      skipConnectionTest: true,
    });

    expect(h.config.custom_provider?.work?.models?.old).toEqual({});
    expect(h.config.custom_provider?.work?.models?.added).toEqual({
      reasoning: true,
      thinking_config: { mode: 'switchable', default_value: 'true' },
    });
  });
});

describe('custom provider candidate persistence', () => {
  it.each(['https://api.z.ai', 'https://open.bigmodel.cn'])(
    'persists and resolves only the explicitly retried Coding Plan endpoint on %s',
    async (origin) => {
      const h = makeHarness();
      const generalUrl = `${origin}/api/paas/v4`;
      const codingUrl = `${origin}/api/coding/paas/v4`;
      const candidate = {
        name: 'GLM plan',
        apiKey: CUSTOM_KEY,
        baseUrl: generalUrl,
        apiFormat: 'openai-completions',
        models: [{ modelId: 'glm-5.3', toolCall: true }],
      };
      h.setTestResult({
        ok: false,
        errorCode: 'http_429',
        errorMessage: 'Insufficient balance',
      });
      const failed = await h.service.saveUserModelProviderCandidate({
        candidate,
        modelId: 'glm-5.3',
        saveAndUse: true,
      });
      expect(failed.ok).toBe(false);
      expect(h.config.custom_provider).toBeUndefined();
      expect(h.config.defaultModel).toBe('minimax/MiniMax-M3');
      expect(h.testCalls.map(({ target }) => target.baseUrl)).toEqual([generalUrl]);

      h.setTestResult({ ok: true });
      const saved = await h.service.saveUserModelProviderCandidate({
        candidate: { ...candidate, baseUrl: codingUrl },
        modelId: 'glm-5.3',
        saveAndUse: true,
      });
      expect(saved.ok).toBe(true);
      const provider = saved.provider!.providerId;
      const providerKey = provider.replace('custom_provider:', '');
      expect(h.config.custom_provider?.[providerKey]?.options?.baseURL).toBe(codingUrl);
      expect(h.config.defaultModel).toBe(`${provider}/glm-5.3`);
      expect(h.testCalls.map(({ target }) => target.baseUrl)).toEqual([generalUrl, codingUrl]);
      // Custom provider resolution must use the persisted URL, not a similarly
      // named provider in the bundled inference registry.
      expect(
        planCustomProviderResolution({
          byok: h.config,
          provider,
          providerKey,
          modelId: 'glm-5.3',
        }),
      ).toMatchObject({
        baseUrl: codingUrl,
        api: 'openai-completions',
        apiKey: CUSTOM_KEY,
      });
    },
  );
});

describe('custom provider import admission', () => {
  it('rechecks process-local admission inside the config save transaction', async () => {
    const h = makeHarness();
    let admitted = true;
    const beforeCommit = vi.fn(() => {
      if (!admitted) throw new Error('Import cancelled');
    });
    const saving = h.service.saveUserModelProviderCandidate({
      candidate: {
        name: 'Import',
        baseUrl: 'https://fixture.example/v1',
        apiKey: CUSTOM_KEY,
        apiFormat: 'openai-completions',
        models: [{ modelId: 'fixture-model' }],
      },
      skipConnectionTest: true,
      beforeCommit,
    });
    admitted = false;
    await expect(saving).rejects.toThrow('Import cancelled');
    expect(beforeCommit).toHaveBeenCalled();
    expect(h.config.custom_provider).toBeUndefined();
    expect(h.testCalls).toEqual([]);
  });
});
