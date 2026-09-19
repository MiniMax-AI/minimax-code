import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildMinimaxProviderView } from '../catalog/provider-views.js';
import { LocalModelCache } from '../catalog/model-cache.js';
import type {
  LocalByokConfigDraft,
  LocalRuntimeConfig,
  ModelConnectionTestResult,
  ModelConnectionTestTarget,
} from '../contracts.js';
import type { ModelProviderServiceContext } from './service-context.js';
import { LocalModelProviderService } from './service.js';

const MINIMAX_KEY = 'sk-user-minimax-key-12345678';
const CUSTOM_KEY = 'sk-custom-key-abcdefgh';

let dataDir: string;

interface Harness {
  readonly config: LocalRuntimeConfig;
  readonly cache: LocalModelCache;
  readonly service: LocalModelProviderService;
  readonly selectModel: ReturnType<typeof vi.fn>;
  readonly testCalls: Array<{ key: string; target: ModelConnectionTestTarget }>;
  setTestResult(result: ModelConnectionTestResult): void;
}

function createHarness(
  initial: Partial<LocalRuntimeConfig> = {},
  options: Pick<ModelProviderServiceContext['deps'], 'implicitCustomProviderThinking'> = {},
): Harness {
  const config: LocalRuntimeConfig = {
    dataDir,
    provider: {
      minimax: {
        models: {
          'MiniMax-M3': {
            name: 'MiniMax M3',
            limit: { context: 200_000, output: 32_000 },
          },
        },
      },
    },
    defaultModel: 'minimax/MiniMax-M3',
    ...initial,
  };
  const cache = new LocalModelCache(() => dataDir);
  const testCalls: Array<{ key: string; target: ModelConnectionTestTarget }> = [];
  const selectModel = vi.fn(async (modelKey: string) => {
    config.defaultModel = modelKey;
  });
  let testResult: ModelConnectionTestResult = { ok: true };

  const service = new LocalModelProviderService({
    configGetter: () => config,
    updateByokConfig: async (mutate) => {
      const draft: LocalByokConfigDraft = {
        minimax_api: config.minimax_api
          ? (structuredClone(config.minimax_api) as Record<string, unknown>)
          : undefined,
        custom_provider: config.custom_provider
          ? structuredClone(config.custom_provider)
          : undefined,
        minimaxModelSource: config.minimaxModelSource,
        defaultModel: config.defaultModel,
      };
      await mutate(draft, config);
      config.minimax_api = draft.minimax_api as LocalRuntimeConfig['minimax_api'];
      config.custom_provider = draft.custom_provider as LocalRuntimeConfig['custom_provider'];
      config.minimaxModelSource = draft.minimaxModelSource;
      config.defaultModel = draft.defaultModel;
      return { config };
    },
    cache,
    tester: {
      test: async (key, target) => {
        testCalls.push({ key, target });
        return testResult;
      },
    },
    selectModel,
    now: () => 1_750_000_000_000,
    randomHex: () => 'a1b2c3',
    ...options,
  });

  return {
    config,
    cache,
    service,
    selectModel,
    testCalls,
    setTestResult: (result) => {
      testResult = result;
    },
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'model-system-management-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('LocalModelProviderService context', () => {
  it('stores MiniMax credentials while exposing only their masked view', async () => {
    const harness = createHarness();

    await harness.service.upsertMinimaxApiKey({ apiKey: MINIMAX_KEY, saveAndUse: true });

    expect(harness.config.minimax_api?.apiKey).toBe(MINIMAX_KEY);
    expect(harness.config.minimaxModelSource).toBe('minimax_api_key');
    expect(harness.service.getMinimaxApiKeyStatus()).toEqual({
      hasApiKey: true,
      maskedApiKey: `${MINIMAX_KEY.slice(0, 4)}****${MINIMAX_KEY.slice(-4)}`,
    });
    expect(JSON.stringify(harness.service.listEffectiveProviders())).not.toContain(MINIMAX_KEY);
    expect(harness.selectModel).not.toHaveBeenCalled();
  });

  it('tests MiniMax headers, hides values, and expires cached verdicts after header changes', async () => {
    const headers = {
      Authorization: 'Bearer fixture-relay-secret',
      'X-Tenant': 'fixture-tenant',
    };
    const harness = createHarness({
      minimax_api: {
        apiKey: MINIMAX_KEY,
        baseURL: 'https://relay.example/anthropic',
        headers,
      },
      minimaxModelSource: 'minimax_api_key',
    });
    const providerView = () => buildMinimaxProviderView(harness.config, harness.cache.load());
    const modelId = providerView()!.models[0]!.modelId;
    await harness.service.testProvider('minimax_api');
    await harness.service.testModel('minimax_api', modelId);
    expect(harness.testCalls.length).toBeGreaterThan(0);
    for (const call of harness.testCalls) expect(call.target.headers).toEqual(headers);
    expect(harness.service.getMinimaxApiKeyStatus().cachedStatus?.state).toBe('available');
    expect(providerView()?.status?.state).toBe('available');
    expect(providerView()?.headerNames).toEqual(['Authorization', 'X-Tenant']);
    expect(JSON.stringify(providerView())).not.toContain('fixture-relay-secret');
    expect(JSON.stringify(providerView())).not.toContain('fixture-tenant');
    expect(JSON.stringify(providerView())).not.toContain(MINIMAX_KEY);
    expect(providerView()?.models[0]?.status?.state).toBe('available');

    headers.Authorization = 'Bearer fixture-rotated-secret';
    expect(harness.service.getMinimaxApiKeyStatus().cachedStatus).toBeUndefined();
    expect(providerView()?.status).toBeUndefined();
    expect(providerView()?.models[0]?.status).toBeUndefined();
    expect(JSON.stringify(harness.cache.load())).not.toContain('fixture-relay-secret');
  });

  it('creates and updates a custom Provider through the same Model System owner', async () => {
    const harness = createHarness({}, { implicitCustomProviderThinking: true });

    const created = await harness.service.createUserProvider({
      name: 'OpenAI Work',
      baseUrl: 'https://api.example.com/v1',
      apiKey: CUSTOM_KEY,
      apiFormat: 'openai-responses',
      headers: { 'X-Tenant': 'one', 'X-Trace': 'keep' },
      models: [
        {
          modelId: 'gpt-5',
          displayName: 'GPT 5',
          limit: { context: 128_000, output: 16_000 },
        },
      ],
    });
    const updated = await harness.service.updateUserProvider({
      providerId: created.providerId,
      headers: { 'x-tenant': 'two' },
      removeHeaders: ['x-trace'],
    });

    expect(created.providerId).toBe('custom_provider:openai-work');
    expect(updated.headerNames).toEqual(['x-tenant']);
    expect(JSON.stringify(updated)).not.toContain(CUSTOM_KEY);
    expect(JSON.stringify(updated)).not.toContain('two');
    expect(harness.config.custom_provider?.['openai-work']).toMatchObject({
      api: 'openai-responses',
      options: {
        apiKey: CUSTOM_KEY,
        baseURL: 'https://api.example.com/v1',
        headers: { 'x-tenant': 'two' },
      },
      models: {
        'gpt-5': {
          reasoning: true,
          thinking_config: { mode: 'switchable', default_value: 'true' },
          limit: { context: 128_000, output: 16_000 },
        },
      },
    });
  });

  it('uses shared request rules for tests and records the result in the model cache', async () => {
    const harness = createHarness();
    const provider = await harness.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com/v1/responses',
      apiKey: CUSTOM_KEY,
      apiFormat: 'openai-responses',
      headers: { Authorization: 'Api-Key custom', 'X-Tenant': 'tenant-a' },
      models: [{ modelId: 'gpt-5' }],
    });

    await expect(harness.service.testModel(provider.providerId, 'gpt-5')).resolves.toMatchObject({
      ok: true,
      status: { state: 'available', lastTestedAt: 1_750_000_000_000 },
    });
    expect(harness.testCalls).toHaveLength(1);
    expect(harness.testCalls[0]?.target).toMatchObject({
      api: 'openai-responses',
      baseUrl: 'https://api.example.com/v1',
      apiKey: CUSTOM_KEY,
      modelId: 'gpt-5',
      headers: { Authorization: 'Api-Key custom', 'X-Tenant': 'tenant-a' },
    });
    expect(harness.cache.load().model_status['custom_provider:work/gpt-5']).toMatchObject({
      state: 'available',
      last_tested_at: 1_750_000_000_000,
    });
  });

  it('keeps a failed connectivity result as diagnostic state rather than a selection gate', async () => {
    const harness = createHarness();
    const provider = await harness.service.createUserProvider({
      name: 'Work',
      baseUrl: 'https://api.example.com/v1',
      apiKey: CUSTOM_KEY,
      models: [{ modelId: 'model-a' }],
    });
    harness.setTestResult({
      ok: false,
      errorCode: 'unauthorized',
      errorMessage: 'Authentication failed',
    });

    await expect(harness.service.testModel(provider.providerId, 'model-a')).resolves.toMatchObject({
      ok: false,
      status: { state: 'failed', lastErrorCode: 'unauthorized' },
    });
    expect(() =>
      harness.service.assertModelSelectable(provider.providerId, 'model-a'),
    ).not.toThrow();
  });
});
