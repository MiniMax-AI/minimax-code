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
  options: { implicitCustomProviderThinking?: boolean } = {},
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
    updateByokConfig: (mutate) => {
      const update = configUpdateTail.then(async () => {
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
        config.minimax_api = draft.minimax_api as LocalRuntimeConfig['minimax_api'];
        config.custom_provider = draft.custom_provider as LocalRuntimeConfig['custom_provider'];
        config.minimaxModelSource = draft.minimaxModelSource;
        config.defaultModel = draft.defaultModel;
        config.defaultModelVariant = draft.defaultModelVariant;
        return { config };
      });
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

  it('keeps the BYOK catalog independent when the managed snapshot only has other models', async () => {
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

    expect(provider.models.map((model) => model.modelId)).toContain('MiniMax-M3');
    expect(provider.models.map((model) => model.modelId)).not.toContain('Remote-B');
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
    expect(minimaxApiModels(h.config)['MiniMax-M3']?.limit?.context).toBe(1_000_000);
    expect(() => h.service.assertModelSelectable('minimax', 'MiniMax-M3')).not.toThrow();
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

    expect(minimaxApiModels(h.config)['MiniMax-M3']?.limit?.context).toBe(512_000);
    await expect(
      h.service.updateMinimaxModelContext({
        modelId: 'MiniMax-M3',
        contextLimit: 768_000,
        expectedContextLimit: 512_000,
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
    });
    expect(h.testCalls[0]?.key).toMatch(/^custom_provider:responses\/gpt-5\.2@sha256:/u);
    expect(
      h.cache.load().model_status['custom_provider:responses/gpt-5.2']?.config_fingerprint,
    ).toMatch(/^sha256:/u);
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

describe('custom providers', () => {
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
    expect(h.testCalls.map((call) => call.target.effort)).toEqual(['on', 'off']);
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
    expect(h.testCalls.map((call) => call.target.effort)).toEqual(['low', 'high', 'max', 'xhigh']);
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

  it('saves every preset model without testing or switching the active model', async () => {
    const h = makeHarness();

    const outcome = await h.service.saveUserModelProviderCandidate({
      candidate: {
        name: 'Preset Provider',
        baseUrl: 'https://api.example.com/v1',
        apiKey: CUSTOM_KEY,
        apiFormat: 'openai-completions',
        models: [
          { modelId: 'preset-model-a', displayName: 'Preset Model A' },
          { modelId: 'preset-model-b', displayName: 'Preset Model B' },
        ],
      },
      saveAndUse: false,
      skipConnectionTest: true,
    });

    expect(outcome).toMatchObject({ ok: true, skippedTest: true });
    expect(outcome.provider?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: 'preset-model-a' }),
        expect.objectContaining({ modelId: 'preset-model-b' }),
      ]),
    );
    expect(h.testCalls).toEqual([]);
    expect(h.selectModel).not.toHaveBeenCalled();
    expect(h.config.defaultModel).toBe('minimax/MiniMax-M3');
  });

  it('saves an untested candidate without selecting it when skipConnectionTest is true', async () => {
    const h = makeHarness();

    const outcome = await h.service.saveUserModelProviderCandidate({
      candidate: {
        name: 'Untested Provider',
        baseUrl: 'https://api.example.com/v1',
        apiKey: CUSTOM_KEY,
        apiFormat: 'openai-responses',
        models: [
          {
            modelId: 'untested-model',
            configurationSource: 'discovered',
            effortOptions: ['low', 'high'],
          },
        ],
      },
      modelId: 'untested-model',
      saveAndUse: true,
      skipConnectionTest: true,
    });

    expect(outcome).toMatchObject({ ok: true, skippedTest: true });
    expect(outcome.status).toBeUndefined();
    expect(h.testCalls).toEqual([]);
    expect(h.config.defaultModel).toBe('minimax/MiniMax-M3');
    const savedProviderKey = outcome.provider?.providerId.replace('custom_provider:', '');
    expect(savedProviderKey).toBeTruthy();
    expect(
      savedProviderKey
        ? h.config.custom_provider?.[savedProviderKey]?.models?.['untested-model']
        : undefined,
    ).toMatchObject({ configuration_source: 'discovered' });
    expect(outcome.provider?.models[0]).toMatchObject({
      modelId: 'untested-model',
      configurationSource: 'discovered',
    });
    expect(h.cache.load().model_status).toEqual({});
  });

  it('saves an edited provider with no models when the connection test is skipped', async () => {
    const h = makeHarness({
      defaultModel: 'custom_provider:work/removed-model',
      defaultModelVariant: 'max',
      custom_provider: {
        work: {
          name: 'Work',
          api: 'openai-responses',
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com/v1' },
          models: { 'removed-model': {} },
        },
      },
    });
    const revision = h.service.listUserProviders()[0]?.configRevision;
    if (!revision) throw new Error('missing provider revision');

    const outcome = await h.service.saveUserModelProviderCandidate({
      candidate: {
        providerId: 'custom_provider:work',
        expectedRevision: revision,
        name: 'Work',
        baseUrl: 'https://api.example.com/v1',
        apiFormat: 'openai-responses',
        models: [],
      },
      skipConnectionTest: true,
    });

    expect(outcome).toMatchObject({ ok: true, skippedTest: true });
    expect(outcome.provider?.models).toEqual([]);
    expect(h.config.custom_provider?.work?.models).toEqual({});
    expect(h.testCalls).toEqual([]);
    expect(h.config.defaultModel).toBe('minimax/MiniMax-M3');
    expect(h.config.defaultModelVariant).toBeUndefined();
  });

  it('atomically saves a tested edit candidate and preserves retained model fields', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          name: 'Work',
          kind: 'custom',
          api: 'openai-responses',
          npm: '@sdk/custom',
          enabled: true,
          options: {
            apiKey: CUSTOM_KEY,
            baseURL: 'https://saved.example/v1',
            headers: { 'X-Saved': 'one', 'X-Remove': 'old' },
            requestTimeout: 1234,
          },
          models: {
            'm-1': {
              name: 'Primary',
              attachment: true,
              headers: { 'X-Model': 'primary' },
              capabilities: { support_files_api: true },
              variants: { thinking: { thinking: { type: 'adaptive' } } },
              limit: { context: 100_000, output: 8_000 },
              thinking: { effortOptions: ['low', 'medium', 'high'] },
            },
            'm-2': { name: 'Removed' },
          },
        },
      },
    });
    const revision = h.service.listUserProviders()[0]?.configRevision;
    if (!revision) throw new Error('missing provider revision');

    const outcome = await h.service.saveUserModelProviderCandidate({
      candidate: {
        providerId: 'custom_provider:work',
        expectedRevision: revision,
        name: 'Renamed',
        baseUrl: 'https://candidate.example/v1',
        apiFormat: 'openai-responses',
        headers: { 'X-New': 'two' },
        removeHeaders: ['x-remove'],
        models: [
          {
            modelId: 'm-1',
            displayName: 'Primary v2',
            enabled: true,
            limit: { context: 120_000, output: 16_000 },
            effortOptions: ['low', 'medium', 'high'],
          },
          { modelId: 'm-3', displayName: 'Added', enabled: false },
        ],
      },
      modelId: 'm-1',
      saveAndUse: true,
    });

    expect(outcome).toMatchObject({ ok: true, status: { state: 'available' } });
    expect(h.testCalls[0]?.target).toMatchObject({
      api: 'openai-responses',
      modelId: 'm-1',
    });
    expect(outcome.provider?.configRevision).toMatch(/^sha256:/u);
    expect(outcome.provider?.configRevision).not.toBe(revision);
    expect(h.config.defaultModel).toBe('custom_provider:work/m-1');
    expect(h.selectModel).not.toHaveBeenCalled();
    expect(h.config.custom_provider?.work).toMatchObject({
      name: 'Renamed',
      options: {
        apiKey: CUSTOM_KEY,
        baseURL: 'https://candidate.example/v1',
        headers: { 'X-Saved': 'one', 'X-New': 'two' },
        requestTimeout: 1234,
      },
    });
    expect(h.config.custom_provider?.work).not.toHaveProperty('npm');
    expect(h.config.custom_provider?.work?.models?.['m-1']).toMatchObject({
      name: 'Primary v2',
      enabled: true,
      attachment: true,
      headers: { 'X-Model': 'primary' },
      capabilities: { support_files_api: true },
      variants: { thinking: { thinking: { type: 'adaptive' } } },
      limit: { context: 120_000, output: 16_000 },
      thinking: { effortOptions: ['low', 'medium', 'high'] },
    });
    expect(h.config.custom_provider?.work?.models?.['m-2']).toBeUndefined();
    expect(h.config.custom_provider?.work?.models?.['m-3']).toEqual({
      name: 'Added',
      enabled: false,
    });
    expect(Object.keys(h.config.custom_provider?.work?.models ?? {})).toEqual(['m-1', 'm-3']);
    expect(() => h.service.assertModelSelectable('custom_provider:work', 'm-1')).not.toThrow();
  });
});

describe('custom provider legacy candidates', () => {
  it('saves an edit candidate when raw YAML has a normalized legacy Think Effort', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          name: 'Work',
          api: 'openai-responses',
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://saved.example' },
          models: {
            'm-1': {
              name: 'Saved model',
              thinking: { effortOptions: ['high'] },
            },
          },
        },
      },
    });
    const revision = h.service.listUserProviders()[0]?.configRevision;
    if (!revision) throw new Error('missing provider revision');

    // The config reader upgrades legacy `thinking.effort` to `effortOptions`.
    // A candidate revision must be compared with that normalized config, or a
    // normal save is incorrectly rejected as CONFIG_CHANGED.
    h.setNextRawCustomProviders({
      work: {
        name: 'Work',
        api: 'openai-responses',
        options: { apiKey: CUSTOM_KEY, baseURL: 'https://saved.example' },
        models: { 'm-1': { name: 'Saved model', thinking: { effort: 'high' } } },
      },
    });

    await expect(
      h.service.saveUserModelProviderCandidate({
        candidate: {
          providerId: 'custom_provider:work',
          expectedRevision: revision,
          name: 'Work',
          baseUrl: 'https://saved.example',
          apiFormat: 'openai-responses',
          models: [
            {
              modelId: 'm-1',
              displayName: 'Saved model',
              effortOptions: ['high'],
            },
          ],
        },
        modelId: 'm-1',
        saveAndUse: true,
      }),
    ).resolves.toMatchObject({ ok: true, status: { state: 'available' } });
    expect(h.config.custom_provider?.work?.models?.['m-1']?.thinking).toEqual({
      effortOptions: ['high'],
    });
  });

  it('leaves provider, default model, and cache unchanged when candidate persistence fails', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          name: 'Work',
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://saved.example' },
          models: { 'm-1': {} },
        },
      },
    });
    const revision = h.service.listUserProviders()[0]?.configRevision;
    if (!revision) throw new Error('missing provider revision');
    const before = JSON.stringify(h.config);
    h.failNextConfigWrite(new Error('config disk full'));

    await expect(
      h.service.saveUserModelProviderCandidate({
        candidate: {
          providerId: 'custom_provider:work',
          expectedRevision: revision,
          name: 'Candidate',
          baseUrl: 'https://candidate.example',
          models: [{ modelId: 'm-1' }],
        },
        modelId: 'm-1',
        saveAndUse: true,
      }),
    ).rejects.toThrow('config disk full');

    expect(JSON.stringify(h.config)).toBe(before);
    expect(h.cache.load().model_status).toEqual({});
  });

  it('rejects an edit candidate when its opaque revision is stale', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://saved.example' },
          models: { 'm-1': {} },
        },
      },
    });

    await expect(
      h.service.testUserModelCandidate(
        {
          providerId: 'custom_provider:work',
          expectedRevision: 'sha256:stale',
          baseUrl: 'https://candidate.example',
          models: [{ modelId: 'm-1' }],
        },
        'm-1',
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_CHANGED', status: 409 });
    expect(h.testCalls).toHaveLength(0);
  });

  it('tests a parameter patch before saving it and preserves the full model config', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          name: 'Work',
          kind: 'custom',
          api: 'openai-responses',
          npm: '@ai-sdk/anthropic',
          enabled: true,
          options: {
            apiKey: CUSTOM_KEY,
            baseURL: 'https://api.example.com/v1',
            headers: { 'X-Tenant': 'one' },
          },
          models: {
            'm-1': {
              name: 'Primary',
              attachment: true,
              reasoning: true,
              tool_call: true,
              temperature: false,
              modalities: { input: ['text', 'image'], output: ['text'] },
              headers: { 'X-Model': 'primary' },
              limit: { context: 100_000, output: 8_000 },
              thinking: { effortOptions: ['low', 'medium', 'high'] },
            },
            'm-2': { name: 'Secondary', limit: { context: 64_000, output: 4_000 } },
          },
        },
      },
    });

    const outcome = await h.service.updateUserModelParameters({
      providerId: 'custom_provider:work',
      modelId: 'm-1',
      contextLimit: 120_000,
      maxOutputTokens: 16_000,
      expectedContextLimit: 100_000,
      expectedMaxOutputTokens: 8_000,
    });

    expect(outcome.ok).toBe(true);
    expect(h.testCalls).toHaveLength(1);
    expect(h.testCalls[0]?.target).toMatchObject({
      api: 'openai-responses',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'm-1',
      headers: { 'X-Tenant': 'one', 'X-Model': 'primary' },
    });
    expect(h.config.custom_provider?.work?.models?.['m-1']).toEqual({
      name: 'Primary',
      attachment: true,
      reasoning: true,
      tool_call: true,
      temperature: false,
      modalities: { input: ['text', 'image'], output: ['text'] },
      headers: { 'X-Model': 'primary' },
      limit: { context: 120_000, output: 16_000 },
      thinking: { effortOptions: ['low', 'medium', 'high'] },
    });
    expect(h.config.custom_provider?.work?.models?.['m-2']).toEqual({
      name: 'Secondary',
      limit: { context: 64_000, output: 4_000 },
    });
    expect(h.config.custom_provider?.work).not.toHaveProperty('npm');
    expect(h.cache.load().model_status['custom_provider:work/m-1']).toMatchObject({
      state: 'available',
      config_fingerprint: expect.stringMatching(/^sha256:/u),
    });
    expect(() => h.service.assertModelSelectable('custom_provider:work', 'm-1')).not.toThrow();
    expect(h.service.listUserProviders()[0]?.models[0]?.status).toMatchObject({
      state: 'available',
    });
    const activeModel = h.config.custom_provider?.work?.models?.['m-1'];
    if (!activeModel?.headers) throw new Error('invalid custom model test fixture');
    activeModel.headers['X-Model'] = 'changed';
    expect(h.service.listUserProviders()[0]?.models[0]?.status).toBeUndefined();
  });
});

describe('custom provider model parameters', () => {
  it('updates model limits without changing configured effort options', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com' },
          models: {
            'm-1': {
              limit: { context: 100_000, output: 8_000 },
              thinking: { effortOptions: ['low', 'high'] },
            },
          },
        },
      },
    });

    await expect(
      h.service.updateUserModelParameters({
        providerId: 'custom_provider:work',
        modelId: 'm-1',
        contextLimit: 120_000,
        maxOutputTokens: 16_000,
        expectedContextLimit: 100_000,
        expectedMaxOutputTokens: 8_000,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(h.config.custom_provider?.work?.models?.['m-1']?.thinking).toEqual({
      effortOptions: ['low', 'high'],
    });
  });

  it('keeps the active model config unchanged when the candidate test fails', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com' },
          models: {
            'm-1': {
              name: 'Primary',
              limit: { context: 100_000, output: 8_000 },
              thinking: { effortOptions: ['high'] },
            },
          },
        },
      },
    });
    h.setTestResult({
      ok: false,
      errorCode: 'model_not_found',
      errorMessage: 'Model rejected',
    });

    const outcome = await h.service.updateUserModelParameters({
      providerId: 'custom_provider:work',
      modelId: 'm-1',
      contextLimit: 120_000,
      maxOutputTokens: 16_000,
      expectedContextLimit: 100_000,
      expectedMaxOutputTokens: 8_000,
    });

    expect(outcome).toMatchObject({
      ok: false,
      status: { state: 'failed', lastErrorCode: 'model_not_found' },
    });
    expect(h.config.custom_provider?.work?.models?.['m-1']).toEqual({
      name: 'Primary',
      limit: { context: 100_000, output: 8_000 },
      thinking: { effortOptions: ['high'] },
    });
    expect(h.cache.load().model_status['custom_provider:work/m-1']).toBeUndefined();
  });

  it('rejects stale model parameters before testing the candidate', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com' },
          models: {
            'm-1': {
              limit: { context: 100_000, output: 8_000 },
              thinking: { effortOptions: ['high'] },
            },
          },
        },
      },
    });

    await expect(
      h.service.updateUserModelParameters({
        providerId: 'custom_provider:work',
        modelId: 'm-1',
        contextLimit: 120_000,
        maxOutputTokens: 16_000,
        expectedContextLimit: 90_000,
        expectedMaxOutputTokens: 8_000,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_CHANGED', status: 409 });
    expect(h.testCalls).toHaveLength(0);
    expect(h.config.custom_provider?.work?.models?.['m-1']).toMatchObject({
      limit: { context: 100_000, output: 8_000 },
      thinking: { effortOptions: ['high'] },
    });
  });

  it('allows the first parameter update when a historical model has no limits or effort', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com' },
          models: { 'm-1': { name: 'Historical' } },
        },
      },
    });

    await expect(
      h.service.updateUserModelParameters({
        providerId: 'custom_provider:work',
        modelId: 'm-1',
        contextLimit: 120_000,
        maxOutputTokens: 16_000,
        expectedContextLimit: 0,
        expectedMaxOutputTokens: 0,
      }),
    ).resolves.toMatchObject({ ok: true, status: { state: 'available' } });
    expect(h.config.custom_provider?.work?.models?.['m-1']).toMatchObject({
      name: 'Historical',
      limit: { context: 120_000, output: 16_000 },
    });
  });

  it('commits only one of two concurrent patches based on the same model snapshot', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com' },
          models: {
            'm-1': {
              limit: { context: 100_000, output: 8_000 },
              thinking: { effortOptions: ['high'] },
            },
          },
        },
      },
    });
    const expected = {
      providerId: 'custom_provider:work',
      modelId: 'm-1',
      expectedContextLimit: 100_000,
      expectedMaxOutputTokens: 8_000,
    } as const;

    const [first, second] = await Promise.allSettled([
      h.service.updateUserModelParameters({
        ...expected,
        contextLimit: 120_000,
        maxOutputTokens: 16_000,
      }),
      h.service.updateUserModelParameters({
        ...expected,
        contextLimit: 140_000,
        maxOutputTokens: 20_000,
      }),
    ]);

    expect(first).toMatchObject({ status: 'fulfilled', value: { ok: true } });
    expect(second).toMatchObject({
      status: 'rejected',
      reason: { code: 'CONFIG_CHANGED', status: 409 },
    });
    expect(h.config.custom_provider?.work?.models?.['m-1']).toMatchObject({
      limit: { context: 120_000, output: 16_000 },
      thinking: { effortOptions: ['high'] },
    });
  });
});

describe('custom provider candidate rollback', () => {
  it('keeps the active model config unchanged when cache persistence fails', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com' },
          models: {
            'm-1': {
              limit: { context: 100_000, output: 8_000 },
              thinking: { effortOptions: ['high'] },
            },
          },
        },
      },
    });
    vi.spyOn(h.cache, 'replaceModelStatus').mockRejectedValueOnce(new Error('cache disk full'));

    await expect(
      h.service.updateUserModelParameters({
        providerId: 'custom_provider:work',
        modelId: 'm-1',
        contextLimit: 120_000,
        maxOutputTokens: 16_000,
        expectedContextLimit: 100_000,
        expectedMaxOutputTokens: 8_000,
      }),
    ).rejects.toMatchObject({ code: 'CACHE_WRITE_FAILED', status: 500 });
    expect(h.testCalls).toHaveLength(1);
    expect(h.config.custom_provider?.work?.models?.['m-1']).toMatchObject({
      limit: { context: 100_000, output: 8_000 },
      thinking: { effortOptions: ['high'] },
    });
    expect(h.cache.load().model_status['custom_provider:work/m-1']).toBeUndefined();
  });

  it('restores the previous model status when the config write fails', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com' },
          models: {
            'm-1': {
              limit: { context: 100_000, output: 8_000 },
              thinking: { effortOptions: ['high'] },
            },
          },
        },
      },
    });
    await h.service.testModel('custom_provider:work', 'm-1');
    const previousStatus = h.cache.load().model_status['custom_provider:work/m-1'];
    h.failNextConfigWrite(new Error('config disk full'));

    await expect(
      h.service.updateUserModelParameters({
        providerId: 'custom_provider:work',
        modelId: 'm-1',
        contextLimit: 120_000,
        maxOutputTokens: 16_000,
        expectedContextLimit: 100_000,
        expectedMaxOutputTokens: 8_000,
      }),
    ).rejects.toThrow('config disk full');
    expect(h.config.custom_provider?.work?.models?.['m-1']).toMatchObject({
      limit: { context: 100_000, output: 8_000 },
      thinking: { effortOptions: ['high'] },
    });
    expect(h.cache.load().model_status['custom_provider:work/m-1']).toEqual(previousStatus);
    expect(() => h.service.assertModelSelectable('custom_provider:work', 'm-1')).not.toThrow();
  });

  it('removes the candidate model status after a first config write fails', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com' },
          models: { 'm-1': {} },
        },
      },
    });
    h.failNextConfigWrite(new Error('config disk full'));

    await expect(
      h.service.updateUserModelParameters({
        providerId: 'custom_provider:work',
        modelId: 'm-1',
        contextLimit: 120_000,
        maxOutputTokens: 16_000,
        expectedContextLimit: 0,
        expectedMaxOutputTokens: 0,
      }),
    ).rejects.toThrow('config disk full');
    expect(h.config.custom_provider?.work?.models?.['m-1']).toEqual({});
    expect(h.cache.load().model_status['custom_provider:work/m-1']).toBeUndefined();
  });

  it('rejects a tested patch when the provider changes during the request', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          enabled: true,
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com' },
          models: { 'm-1': { limit: { context: 100_000, output: 8_000 } } },
        },
      },
    });
    h.setTestHandler(async () => {
      const provider = h.config.custom_provider?.work;
      if (!provider?.options) throw new Error('invalid custom provider test fixture');
      provider.options.baseURL = 'https://changed.example.com';
      return { ok: true };
    });

    await expect(
      h.service.updateUserModelParameters({
        providerId: 'custom_provider:work',
        modelId: 'm-1',
        contextLimit: 120_000,
        maxOutputTokens: 16_000,
        expectedContextLimit: 100_000,
        expectedMaxOutputTokens: 8_000,
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_CHANGED', status: 409 });
    expect(h.config.custom_provider?.work?.options?.baseURL).toBe('https://changed.example.com');
    expect(h.config.custom_provider?.work?.models?.['m-1']?.limit).toEqual({
      context: 100_000,
      output: 8_000,
    });
    expect(h.cache.load().model_status['custom_provider:work/m-1']).toBeUndefined();
  });

  it('validates model parameter patches before running connectivity tests', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com' },
          models: { 'm-1': {} },
        },
      },
    });

    await expect(
      h.service.updateUserModelParameters({
        providerId: 'custom_provider:work',
        modelId: 'm-1',
        contextLimit: 0,
        maxOutputTokens: 16_000,
        expectedContextLimit: 0,
        expectedMaxOutputTokens: 0,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(h.testCalls).toHaveLength(0);
  });
});

describe('custom provider creation and duplication', () => {
  it('create generates a provider key from the display name', async () => {
    const h = makeHarness(undefined, { implicitCustomProviderThinking: true });
    const provider = await h.service.createUserProvider({
      name: 'OpenAI Work',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: CUSTOM_KEY,
      apiFormat: 'openai-completions',
      models: [
        { modelId: 'gpt-4.1', displayName: 'GPT-4.1', limit: { context: 128_000, output: 16_000 } },
      ],
    });
    expect(provider.providerId).toBe('custom_provider:openai-work');
    expect(provider.kind).toBe('custom');
    expect(provider.enabled).toBe(true);
    expect(provider.apiFormat).toBe('openai-completions');
    expect(provider.hasApiKey).toBe(true);
    expect(provider.maskedApiKey).toContain('****');
    expect(provider.maskedApiKey).not.toBe(CUSTOM_KEY);
    expect(provider).not.toHaveProperty('rawApiKey');
    expect(JSON.stringify(provider)).not.toContain(CUSTOM_KEY);
    expect(h.config.custom_provider?.['openai-work']?.options?.apiKey).toBe(CUSTOM_KEY);
    expect(h.config.custom_provider?.['openai-work']?.models?.['gpt-4.1']?.limit).toEqual({
      context: 128_000,
      output: 16_000,
    });
    expect(h.config.custom_provider?.['openai-work']?.models?.['gpt-4.1']).toMatchObject({
      reasoning: true,
      thinking_config: { mode: 'switchable', default_value: 'true' },
    });
    expect(h.config.custom_provider?.['openai-work']?.models?.['gpt-4.1']).not.toHaveProperty(
      'thinking',
    );
  });

  it('duplicates the complete provider config under a new identity without copying runtime state', async () => {
    const h = makeHarness();
    const source = await h.service.createUserProvider({
      name: 'OpenAI Work',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: CUSTOM_KEY,
      apiFormat: 'openai-responses',
      headers: { 'X-Tenant': 'tenant-a', Authorization: 'Bearer custom' },
      models: [
        {
          modelId: 'gpt-5.6',
          displayName: 'GPT-5.6',
          limit: { context: 256_000, output: 128_000 },
          effortOptions: ['low', 'xhigh', 'max'],
        },
      ],
    });
    const sourceConfig = h.config.custom_provider?.['openai-work'];
    if (!sourceConfig) throw new Error('missing source provider fixture');
    sourceConfig.npm = '@ai-sdk/openai';
    h.config.defaultModel = `${source.providerId}/gpt-5.6`;
    await h.cache.setModelStatus(`${source.providerId}/gpt-5.6`, {
      state: 'available',
      config_fingerprint: 'source-fingerprint',
    });

    const duplicate = await h.service.duplicateUserProvider({
      providerId: source.providerId,
      name: 'OpenAI Work Copy',
    });

    expect(duplicate).toMatchObject({
      providerId: 'custom_provider:openai-work-copy',
      name: 'OpenAI Work Copy',
      apiFormat: 'openai-responses',
      hasApiKey: true,
      headerNames: ['Authorization', 'X-Tenant'],
      models: [
        {
          modelId: 'gpt-5.6',
          contextLimit: 256_000,
          maxOutputTokens: 128_000,
          effortOptions: ['low', 'xhigh', 'max'],
        },
      ],
    });
    expect(duplicate.models[0]?.status).toBeUndefined();
    expect(h.config.defaultModel).toBe('custom_provider:openai-work/gpt-5.6');

    const originalConfig = h.config.custom_provider?.['openai-work'];
    const duplicateConfig = h.config.custom_provider?.['openai-work-copy'];
    if (!originalConfig) throw new Error('missing original provider fixture');
    const expectedDuplicateConfig = { ...originalConfig, name: 'OpenAI Work Copy' };
    delete expectedDuplicateConfig.npm;
    expect(duplicateConfig).toEqual(expectedDuplicateConfig);
    expect(duplicateConfig).not.toHaveProperty('npm');
    expect(duplicateConfig).not.toBe(originalConfig);
    expect(duplicateConfig?.options).not.toBe(originalConfig?.options);
    expect(duplicateConfig?.models).not.toBe(originalConfig?.models);
    expect(duplicateConfig?.options?.apiKey).toBe(CUSTOM_KEY);
    expect(h.cache.load().model_status['custom_provider:openai-work-copy/gpt-5.6']).toBeUndefined();

    const secondDuplicate = await h.service.duplicateUserProvider({
      providerId: source.providerId,
      name: 'OpenAI Work Copy',
    });
    expect(secondDuplicate).toMatchObject({
      providerId: 'custom_provider:openai-work-copy-2',
      name: 'OpenAI Work Copy 2',
    });
  });

  it('duplicates a provider when a retired sibling survives as a null config entry', async () => {
    const h = makeHarness();
    const source = await h.service.createUserProvider({
      name: 'appintheloop',
      baseUrl: 'https://api.example.com/v1',
      apiKey: CUSTOM_KEY,
      apiFormat: 'openai-completions',
      models: [{ modelId: 'demo-model-1', displayName: 'demo-model-1' }],
    });

    // A retired provider can survive in a real config as `oaii-oauth: null`.
    // Walking the tree must not dereference it.
    (h.config.custom_provider as Record<string, unknown>)['oaii-oauth'] = null;

    const duplicate = await h.service.duplicateUserProvider({
      providerId: source.providerId,
      name: 'appintheloop 副本',
    });
    expect(duplicate.name).toBe('appintheloop 副本');
    expect(duplicate.providerId).not.toBe(source.providerId);
  });

  it('rejects duplicating an unknown provider', async () => {
    const h = makeHarness();
    await expect(
      h.service.duplicateUserProvider({
        providerId: 'custom_provider:missing',
        name: 'Missing Copy',
      }),
    ).rejects.toMatchObject({ status: 404, code: 'PROVIDER_NOT_FOUND' });
  });

  it('create rejects invalid api keys and empty base url', async () => {
    const h = makeHarness();
    await expect(
      h.service.createUserProvider({ name: 'X', baseUrl: 'https://x', apiKey: 'a****b' }),
    ).rejects.toBeInstanceOf(LocalModelProviderError);
    await expect(
      h.service.createUserProvider({ name: 'X', baseUrl: '  ', apiKey: CUSTOM_KEY }),
    ).rejects.toBeInstanceOf(LocalModelProviderError);
  });

  it('rejects an unsupported model configuration source', async () => {
    const h = makeHarness();

    await expect(
      h.service.createUserProvider({
        name: 'X',
        baseUrl: 'https://x.example.com',
        apiKey: CUSTOM_KEY,
        models: [{ modelId: 'm-1', configurationSource: 'catalog' }],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });
});

describe('custom provider thinking configuration', () => {
  it('stores user-defined effort choices without enum validation', async () => {
    const h = makeHarness();
    await h.service.createUserProvider({
      name: 'X',
      baseUrl: 'https://x.example.com',
      apiKey: CUSTOM_KEY,
      models: [
        {
          modelId: 'm-1',
          effortOptions: [' low ', 'light', 'low', 'turbo'],
        },
      ],
    });

    expect(h.config.custom_provider?.x?.models?.['m-1']?.thinking).toEqual({
      effortOptions: ['low', 'light', 'turbo'],
    });
    expect(h.service.listUserProviders()[0]?.models[0]).toMatchObject({
      effortOptions: ['low', 'light', 'turbo'],
    });
  });

  it('stores and returns only the configured Think Effort choices', async () => {
    const h = makeHarness();
    const provider = await h.service.createUserProvider({
      name: 'Configured effort',
      baseUrl: 'https://configured-effort.example.com',
      apiKey: CUSTOM_KEY,
      models: [
        {
          modelId: 'm-1',
          effortOptions: ['low', 'xhigh', 'max'],
        },
      ],
    });

    const providerKey = provider.providerId.replace('custom_provider:', '');
    expect(h.config.custom_provider?.[providerKey]?.models?.['m-1']?.thinking).toEqual({
      effortOptions: ['low', 'xhigh', 'max'],
    });
    expect(h.service.listUserProviders()[0]?.models[0]).toMatchObject({
      effortOptions: ['low', 'xhigh', 'max'],
    });
  });

  it('clears a historical configuration default when the effort list is saved', async () => {
    const h = makeHarness();
    await h.service.createUserProvider({
      name: 'Historical default',
      baseUrl: 'https://historical-default.example.com',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'm-1', effortOptions: ['low', 'high'] }],
    });
    const thinking = h.config.custom_provider?.['historical-default']?.models?.['m-1']?.thinking;
    if (!thinking) throw new Error('Expected a saved thinking configuration');
    (thinking as Record<string, unknown>).defaultEffort = 'high';

    await h.service.updateUserProvider({
      providerId: 'custom_provider:historical-default',
      models: [{ modelId: 'm-1', effortOptions: ['low', 'high', 'max'] }],
    });

    expect(h.config.custom_provider?.['historical-default']?.models?.['m-1']?.thinking).toEqual({
      effortOptions: ['low', 'high', 'max'],
    });
  });

  it('stores MiniMax-M3 Think Effort choices like every other custom model', async () => {
    const h = makeHarness();
    await h.service.createUserProvider({
      name: 'MiniMax Work',
      baseUrl: 'https://api.minimax.example.com/messages',
      apiKey: CUSTOM_KEY,
      apiFormat: 'anthropic-messages',
      models: [
        {
          modelId: 'MiniMax-M3',
          effortOptions: ['off', 'on'],
        },
      ],
    });

    expect(h.config.custom_provider?.['minimax-work']?.models?.['MiniMax-M3']).toMatchObject({
      reasoning: true,
      thinking: { effortOptions: ['off', 'on'] },
    });
    expect(h.config.custom_provider?.['minimax-work']?.models?.['MiniMax-M3']).not.toHaveProperty(
      'thinking_config',
    );
    expect(h.config.custom_provider?.['minimax-work']?.models?.['MiniMax-M3']).not.toHaveProperty(
      'variants',
    );
    expect(h.service.listUserProviders()[0]?.models[0]).toMatchObject({
      modelId: 'MiniMax-M3',
      effortOptions: ['off', 'on'],
    });
  });

  it('rejects non-positive model limits before writing the provider', async () => {
    const h = makeHarness();
    await expect(
      h.service.createUserProvider({
        name: 'X',
        baseUrl: 'https://x.example.com',
        apiKey: CUSTOM_KEY,
        models: [{ modelId: 'm-1', limit: { context: 0, output: -1 } }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.config.custom_provider).toBeUndefined();
  });

  it('create with chinese name generates provider-<hex> key', async () => {
    const h = makeHarness();
    const provider = await h.service.createUserProvider({
      name: '我的服务',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
    });
    expect(provider.providerId).toBe('custom_provider:provider-a1b2c3');
    expect(provider.name).toBe('我的服务');
  });

  it('activates the first configured model after its current fingerprint passes', async () => {
    const h = makeHarness();
    const provider = await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'm-1' }, { modelId: 'm-2' }],
    });
    await h.service.testModel(provider.providerId, 'm-1');
    await h.service.updateUserProvider({
      providerId: provider.providerId,
      saveAndUse: true,
    });
    expect(h.selectModel).toHaveBeenCalledWith('custom_provider:work/m-1');
  });

  it('update keeps the provider key immutable when name changes', async () => {
    const h = makeHarness();
    await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
    });
    const updated = await h.service.updateUserProvider({
      providerId: 'custom_provider:work',
      name: 'Renamed Provider',
    });
    expect(updated.providerId).toBe('custom_provider:work');
    expect(updated.name).toBe('Renamed Provider');
    expect(h.config.custom_provider?.work).toBeDefined();
    expect(h.config.custom_provider?.['renamed-provider']).toBeUndefined();
  });

  it('update preserves capabilities for retained models and defaults newly added models', async () => {
    const h = makeHarness(undefined, { implicitCustomProviderThinking: true });
    await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'kept' }, { modelId: 'removed' }],
    });
    const kept = h.config.custom_provider?.work?.models?.kept;
    if (!kept) throw new Error('expected retained model fixture');
    kept.thinking_config = { mode: 'switchable', default_value: 'false' };
    kept.limit = { context: 96_000, output: 12_000 };
    kept.variants = {
      thinking: { thinking: { type: 'adaptive' } },
      'none-thinking': { thinking: { type: 'disabled' } },
    };

    await h.service.updateUserProvider({
      providerId: 'custom_provider:work',
      models: [{ modelId: 'kept' }, { modelId: 'added' }],
    });

    expect(h.config.custom_provider?.work?.models?.kept).toMatchObject({
      reasoning: true,
      thinking_config: { mode: 'switchable', default_value: 'false' },
      limit: { context: 96_000, output: 12_000 },
      variants: {
        thinking: { thinking: { type: 'adaptive' } },
        'none-thinking': { thinking: { type: 'disabled' } },
      },
    });
    expect(h.config.custom_provider?.work?.models?.added).toMatchObject({
      reasoning: true,
      thinking_config: { mode: 'switchable', default_value: 'true' },
    });
    expect(h.config.custom_provider?.work?.models?.removed).toBeUndefined();
  });

  it('update honors an explicit reasoning opt-out for an existing model', async () => {
    const h = makeHarness(undefined, { implicitCustomProviderThinking: true });
    await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'plain' }],
    });

    await h.service.updateUserProvider({
      providerId: 'custom_provider:work',
      models: [{ modelId: 'plain', reasoning: false }],
    });

    expect(h.config.custom_provider?.work?.models?.plain).toMatchObject({ reasoning: false });
    expect(h.config.custom_provider?.work?.models?.plain).not.toHaveProperty('thinking_config');
  });
});

describe('custom provider default model recovery', () => {
  it('resets the global default when an update removes its model', async () => {
    const h = makeHarness({
      defaultModel: 'custom_provider:work/removed',
      defaultModelVariant: 'max',
      custom_provider: {
        work: {
          name: 'Work',
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com/v1' },
          models: { kept: {}, removed: {} },
        },
      },
    });

    await h.service.updateUserProvider({
      providerId: 'custom_provider:work',
      models: [{ modelId: 'kept' }],
    });

    expect(h.config.defaultModel).toBe('minimax/MiniMax-M3');
    expect(h.config.defaultModelVariant).toBeUndefined();
  });
});

describe('custom provider updates', () => {
  it('keeps legacy provider persistence unchanged without the TUI policy', async () => {
    const h = makeHarness();
    await h.service.createUserProvider({
      name: 'Legacy',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'plain' }],
    });

    expect(h.config.custom_provider?.legacy?.models?.plain).toEqual({});
  });

  it('persists model reorder requests and preserves retained model fields', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          name: 'Work',
          api: 'openai-responses',
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com/v1' },
          models: {
            'm-a': {
              name: 'Model A',
              enabled: false,
              attachment: true,
              limit: { context: 128_000, output: 16_000 },
              thinking: { effortOptions: ['low', 'high'] },
            },
            'm-b': { name: 'Model B' },
            'm-c': { name: 'Model C', enabled: true },
          },
        },
      },
    });

    const updated = await h.service.updateUserProvider({
      providerId: 'custom_provider:work',
      models: [{ modelId: 'm-c' }, { modelId: 'm-a' }, { modelId: 'm-b' }],
    });

    expect(Object.keys(h.config.custom_provider?.work?.models ?? {})).toEqual([
      'm-c',
      'm-a',
      'm-b',
    ]);
    expect(updated.models.map((model) => model.modelId)).toEqual(['m-c', 'm-a', 'm-b']);
    expect(h.config.custom_provider?.work?.models?.['m-a']).toEqual({
      name: 'Model A',
      enabled: false,
      attachment: true,
      limit: { context: 128_000, output: 16_000 },
      thinking: { effortOptions: ['low', 'high'] },
    });
  });

  it('removes legacy npm metadata when a custom provider is edited', async () => {
    const h = makeHarness({
      custom_provider: {
        work: {
          name: 'Work',
          npm: '@ai-sdk/anthropic',
          api: 'anthropic-messages',
          options: { apiKey: CUSTOM_KEY, baseURL: 'https://api.example.com/v1' },
          models: { 'm-1': { limit: { context: 128_000, output: 16_000 } } },
        },
      },
    });

    await h.service.updateUserProvider({ providerId: 'custom_provider:work', name: 'Renamed' });

    expect(h.config.custom_provider?.work).toMatchObject({ name: 'Renamed' });
    expect(h.config.custom_provider?.work).not.toHaveProperty('npm');
  });

  it('update api_key tri-state: absent keeps, empty clears, masked rejects', async () => {
    const h = makeHarness();
    await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
    });

    await h.service.updateUserProvider({ providerId: 'work', name: 'Still Work' });
    expect(h.config.custom_provider?.work?.options?.apiKey).toBe(CUSTOM_KEY);

    await expect(
      h.service.updateUserProvider({ providerId: 'work', apiKey: 'sk-c****efgh' }),
    ).rejects.toBeInstanceOf(LocalModelProviderError);
    expect(h.config.custom_provider?.work?.options?.apiKey).toBe(CUSTOM_KEY);

    const cleared = await h.service.updateUserProvider({ providerId: 'work', apiKey: '' });
    expect(h.config.custom_provider?.work?.options?.apiKey).toBeUndefined();
    expect(cleared.hasApiKey).toBe(false);

    await h.service.updateUserProvider({ providerId: 'work', apiKey: 'sk-new-key-987654321' });
    expect(h.config.custom_provider?.work?.options?.apiKey).toBe('sk-new-key-987654321');
  });

  it('patches and removes write-only headers case-insensitively', async () => {
    const h = makeHarness();
    await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
      headers: { 'X-Tenant': 'one', 'X-Trace': 'keep' },
      models: [{ modelId: 'm-1' }],
    });

    const provider = await h.service.updateUserProvider({
      providerId: 'work',
      headers: { 'x-tenant': 'two', 'X-New': 'new' },
      removeHeaders: ['x-trace'],
    });

    expect(h.config.custom_provider?.work?.options?.headers).toEqual({
      'x-tenant': 'two',
      'X-New': 'new',
    });
    expect(provider.headerNames).toEqual(['X-New', 'x-tenant']);
    expect(JSON.stringify(provider)).not.toContain('two');
  });

  it('allows activation after a tested model configuration changes', async () => {
    const h = makeHarness();
    const provider = await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'm-1', limit: { context: 128_000 } }],
    });
    await h.service.testModel(provider.providerId, 'm-1');
    await h.service.updateUserProvider({
      providerId: provider.providerId,
      models: [{ modelId: 'm-1', limit: { context: 256_000 } }],
    });

    await expect(
      h.service.updateUserProvider({ providerId: provider.providerId, saveAndUse: true }),
    ).resolves.toMatchObject({ providerId: provider.providerId });
    expect(h.selectModel).toHaveBeenCalledWith('custom_provider:work/m-1');
  });
});

describe('custom provider deletion', () => {
  it('update unknown provider yields 404', async () => {
    const h = makeHarness();
    await expect(
      h.service.updateUserProvider({ providerId: 'custom_provider:nope', name: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('delete removes the provider and prunes cache even when default model points at it', async () => {
    const h = makeHarness();
    await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'm-1' }],
    });
    h.config.defaultModel = 'custom_provider:work/m-1';
    h.config.defaultModelVariant = 'max';
    expect(h.config.defaultModel).toBe('custom_provider:work/m-1');
    await h.cache.setProviderStatus('custom_provider:work', { state: 'available' });

    await h.service.deleteUserProvider({ providerId: 'custom_provider:work' });
    expect(h.config.custom_provider?.work).toBeUndefined();
    expect(h.cache.load().provider_status['custom_provider:work']).toBeUndefined();
    expect(h.config.defaultModel).toBe('minimax/MiniMax-M3');
    expect(h.config.defaultModelVariant).toBeUndefined();
  });

  it('delete unknown provider yields 404', async () => {
    const h = makeHarness();
    await expect(
      h.service.deleteUserProvider({ providerId: 'custom_provider:nope' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('provider listings', () => {
  it('uses the active API catalog and context overrides in both model lists', () => {
    const h = makeHarness({
      minimaxModelSource: 'minimax_api_key',
      minimax_api: { apiKey: RAW_KEY, modelContextLimits: { 'MiniMax-M3': 1_000_000 } },
      provider: {
        minimax: {
          options: { authMode: 'managed-login' },
          models: {
            'remote-only': { name: 'Remote Only' },
            'MiniMax-M3': { limit: { context: 512_000, output: 128_000 } },
          },
        },
      },
    });
    const provider = h.service
      .listEffectiveProviders()
      .find((item) => item.providerId === 'minimax');
    const listed = listLocalRuntimeModels(h.config).filter((item) => item.providerId === 'minimax');

    expect(provider?.models.map((model) => model.modelId)).toEqual(
      listed.map((model) => model.modelId),
    );
    expect(provider?.models.some((model) => model.modelId === 'remote-only')).toBe(false);
    expect(provider?.models.find((model) => model.modelId === 'MiniMax-M3')).toMatchObject({
      contextLimit: 1_000_000,
      contextWindowOptions: [512_000, 1_000_000],
    });
  });

  it('lists builtin and custom providers, excludes disabled custom providers', async () => {
    const h = makeHarness();
    await h.service.upsertMinimaxApiKey({ apiKey: RAW_KEY });
    await h.service.createUserProvider({
      name: 'On',
      baseUrl: 'https://on.example.com',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'm-on' }],
    });
    await h.service.createUserProvider({
      name: 'Off',
      baseUrl: 'https://off.example.com',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'm-off' }],
    });
    await h.service.updateUserProvider({ providerId: 'off', enabled: false });

    const effective = h.service.listEffectiveProviders();
    const ids = effective.map((p) => p.providerId);
    expect(ids).toContain('minimax');
    expect(ids).toContain('custom_provider:on');
    expect(ids).not.toContain('custom_provider:off');
    // minimax_api is no longer listed as a separate provider — source routing
    // is handled by the resolver at inference time.
    expect(ids).not.toContain('minimax_api');

    const minimax = effective.find((p) => p.providerId === 'minimax');
    expect(minimax?.source).toBe('provider');
    expect(minimax?.kind).toBe('minimax-managed');

    // user list still shows disabled providers with their config retained
    const user = h.service.listUserProviders();
    expect(user.map((p) => p.providerId).sort()).toEqual([
      'custom_provider:off',
      'custom_provider:on',
    ]);
    expect(user.find((p) => p.providerId === 'custom_provider:off')?.enabled).toBe(false);
  });

  it('hides minimax_api when no key is saved', () => {
    const h = makeHarness();
    const ids = h.service.listEffectiveProviders().map((p) => p.providerId);
    expect(ids).not.toContain('minimax_api');
  });

  it('returns only masked keys in listings', async () => {
    const h = makeHarness();
    await h.service.upsertMinimaxApiKey({ apiKey: RAW_KEY });
    await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
    });
    const effective = h.service.listEffectiveProviders();
    const user = h.service.listUserProviders();
    const status = h.service.getMinimaxApiKeyStatus();

    for (const provider of [...effective, ...user]) {
      if (provider.hasApiKey) {
        expect(provider.maskedApiKey).toContain('****');
        expect(provider).not.toHaveProperty('rawApiKey');
      }
    }
    const customProvider = user.find((p) => p.providerId === 'custom_provider:work');
    expect(customProvider?.maskedApiKey).not.toBe(CUSTOM_KEY);
    expect(customProvider).not.toHaveProperty('rawApiKey');
    expect(status).not.toHaveProperty('rawApiKey');
    expect(status.maskedApiKey).not.toBe(RAW_KEY);
  });

  it('surfaces cache status on listed providers', async () => {
    const h = makeHarness();
    await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'm-1' }],
    });
    h.setTestResult({
      ok: false,
      errorCode: 'unauthorized',
      errorMessage: 'Authentication failed (HTTP 401)',
    });
    await h.service.testProvider('custom_provider:work');

    const provider = h.service
      .listUserProviders()
      .find((p) => p.providerId === 'custom_provider:work');
    expect(provider?.status).toMatchObject({ state: 'failed', lastErrorCode: 'unauthorized' });
  });

  it('drops a listed provider status after the tested configuration changes', async () => {
    const h = makeHarness();
    await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'm-1' }],
    });
    await h.service.testProvider('custom_provider:work');
    expect(
      h.service.listUserProviders().find((p) => p.providerId === 'custom_provider:work')?.status,
    ).toMatchObject({ state: 'available' });

    await h.service.updateUserProvider({
      providerId: 'custom_provider:work',
      baseUrl: 'https://rotated.example.com',
    });

    // The cached verdict belongs to the previous base_url; keeping it would
    // report the new endpoint as verified without ever contacting it.
    expect(
      h.service.listUserProviders().find((p) => p.providerId === 'custom_provider:work')?.status,
    ).toBeUndefined();
  });
});

describe('connection tests', () => {
  it('tests a custom provider with its first model and records success in cache', async () => {
    const h = makeHarness();
    await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com/v1',
      apiKey: CUSTOM_KEY,
      apiFormat: 'openai-completions',
      models: [{ modelId: 'm-1', effortOptions: ['low'] }, { modelId: 'm-2' }],
    });

    const result = await h.service.testProvider('custom_provider:work');
    expect(result.ok).toBe(true);
    expect(h.testCalls[0]?.key).toMatch(/^custom_provider:work@sha256:/u);
    expect(h.testCalls[0]?.target).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://api.example.com/v1',
      apiKey: CUSTOM_KEY,
      modelId: 'm-1',
    });
    expect(h.cache.load().provider_status['custom_provider:work']).toMatchObject({
      state: 'available',
      last_tested_at: 1_750_000_000_000,
    });
  });

  it('records failures with normalized error codes in the model cache', async () => {
    const h = makeHarness();
    await h.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'm-1' }],
    });
    h.setTestResult({
      ok: false,
      errorCode: 'unauthorized',
      errorMessage: 'Authentication failed (HTTP 401)',
    });

    const result = await h.service.testModel('custom_provider:work', 'm-1');
    expect(result.ok).toBe(false);
    expect(result.status).toMatchObject({ state: 'failed', lastErrorCode: 'unauthorized' });
    expect(h.cache.load().model_status['custom_provider:work/m-1']).toMatchObject({
      state: 'failed',
      last_error_code: 'unauthorized',
    });
  });

  it('tests the minimax_api provider against the derived base url and models', async () => {
    const h = makeHarness();
    await h.service.upsertMinimaxApiKey({ apiKey: RAW_KEY });
    await h.service.testProvider('minimax_api');
    expect(h.testCalls[0]?.target).toMatchObject({
      api: 'anthropic-messages',
      baseUrl: MINIMAX_API_DEFAULT_BASE_URL,
      apiKey: RAW_KEY,
      modelId: 'MiniMax-M3',
    });
    expect(h.testCalls.map((call) => call.target.minimaxM3ThinkingMode)).toEqual(['on', 'off']);
  });

  it('rejects testing providers without a key or unknown providers', async () => {
    const h = makeHarness();
    await expect(h.service.testProvider('minimax_api')).rejects.toMatchObject({ status: 400 });
    await expect(h.service.testProvider('custom_provider:nope')).rejects.toMatchObject({
      status: 404,
    });
  });
});
