import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { providerCompletionUrl, providerModelsUrls } from '../../connectivity/provider-request.js';
import { ProviderPresetCatalog } from './provider-presets.service.js';
import { readProviderPresetSnapshotCandidates } from './provider-presets.repository.js';
import { modelsFromInputs } from '../../management/service-input.js';
import { buildModelEntry } from '../list-models.js';

vi.mock('./provider-presets.repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider-presets.repository.js')>();
  return {
    ...actual,
    readProviderPresetSnapshotCandidates: vi.fn(actual.readProviderPresetSnapshotCandidates),
  };
});

const temporaryDirectories: string[] = [];
const TEST_RELEASE_SHA = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function rawCatalog(modelId: string) {
  return {
    compatible: {
      name: 'Compatible API',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://api.example.test/v1',
      models: { [modelId]: { name: modelId, tool_call: true } },
    },
  };
}

function snapshot(updatedAt: number, modelId: string, etag?: string, iconBaseUrl?: string) {
  return {
    version: 1,
    source: 'https://models.dev/api.json',
    updatedAt,
    ...(etag ? { etag } : {}),
    ...(iconBaseUrl ? { iconBaseUrl } : {}),
    catalog: rawCatalog(modelId),
  };
}

async function catalogPaths() {
  const root = await mkdtemp(join(tmpdir(), 'mavis-provider-presets-'));
  temporaryDirectories.push(root);
  const dataDir = join(root, 'data');
  const bundledCatalogPath = join(root, 'bundled.json.gz');
  await mkdir(join(dataDir, 'cache'), { recursive: true });
  return {
    dataDir,
    bundledCatalogPath,
    localCatalogPath: join(dataDir, 'cache', 'models-dev-catalog.json'),
  };
}

function unavailableCommonConfig() {
  return vi.fn(async () => {
    throw new Error('offline');
  }) as typeof fetch;
}

function redirectResponse() {
  return new Response(null, { status: 302, headers: { location: 'https://evil.example' } });
}

function gatewayRedirectFetch() {
  return vi.fn(async () => redirectResponse()) as typeof fetch;
}

function mirroredCatalogRedirectFetch() {
  let requests = 0;
  return vi.fn(async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(
        JSON.stringify({
          catalog_url: `https://filecdn.minimax.chat/public/models-dev/catalog/${TEST_RELEASE_SHA}/api.json`,
          icon_base_url: `https://filecdn.minimax.chat/public/models-dev/catalog/${TEST_RELEASE_SHA}/logos/`,
        }),
      );
    }
    return redirectResponse();
  }) as typeof fetch;
}

function providerCatalog(providerIds: readonly string[]) {
  return Object.fromEntries(
    providerIds.map((providerId) => [
      providerId,
      {
        name: providerId,
        npm: '@ai-sdk/openai-compatible',
        api: `https://${providerId}.example/v1`,
        models: { model: { name: 'Model', tool_call: true } },
      },
    ]),
  );
}

async function orderingCatalog(
  providerIds: readonly string[],
  options: {
    region: 'cn' | 'en';
    commonConfigFetch: typeof fetch;
    commonConfigTimeoutMs?: number;
    previewSecret?: string;
    lane?: string;
  },
) {
  const paths = await catalogPaths();
  await writeFile(
    paths.bundledCatalogPath,
    gzipSync(
      JSON.stringify({
        version: 1,
        source: 'https://models.dev/api.json',
        updatedAt: 1,
        catalog: providerCatalog(providerIds),
      }),
    ),
  );
  return new ProviderPresetCatalog({
    ...paths,
    modelsDevFetch: vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
    commonConfigFetch: options.commonConfigFetch,
    commonConfigOriginGetter: () => 'https://gateway.example',
    commonConfigTimeoutMs: options.commonConfigTimeoutMs,
    previewSecret: options.previewSecret,
    lane: options.lane,
    regionGetter: () => options.region,
  });
}

function commonConfigResponse(value: unknown) {
  return new Response(JSON.stringify({ data: { agent_byok_pinned_provider_ids: value } }), {
    status: 200,
  });
}

async function waitForRepositoryRead(index: number): Promise<void> {
  const readCandidates = vi.mocked(readProviderPresetSnapshotCandidates);
  await vi.waitFor(() => expect(readCandidates).toHaveBeenCalledTimes(index + 1));
  const result = readCandidates.mock.results[index];
  if (!result) throw new Error(`Expected repository read ${index}`);
  await result.value;
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function parsePresetsForTest(catalog: Record<string, unknown>, iconBaseUrl?: string) {
  const paths = await catalogPaths();
  await writeFile(
    paths.bundledCatalogPath,
    gzipSync(
      JSON.stringify({
        version: 1,
        source: 'https://models.dev/api.json',
        updatedAt: 1,
        ...(iconBaseUrl ? { iconBaseUrl } : {}),
        catalog,
      }),
    ),
  );
  return new ProviderPresetCatalog({
    ...paths,
    modelsDevFetch: vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
    commonConfigFetch: vi.fn(async () => commonConfigResponse([])) as typeof fetch,
    regionGetter: () => 'cn',
  }).listProviderPresets();
}

describe('models.dev Provider Presets', () => {
  it('builds each Provider icon URL from the catalog snapshot prefix', async () => {
    const [preset] = await parsePresetsForTest(
      providerCatalog(['vendor.with.dots']),
      'https://cdn.example/catalog/release/logos/',
    );

    expect(preset?.iconUrl).toBe('https://cdn.example/catalog/release/logos/vendor.with.dots.svg');
  });

  it('excludes MiniMax providers from the preset catalog', async () => {
    const presets = await parsePresetsForTest(
      providerCatalog([
        'minimax',
        'minimax-cn',
        'minimax-coding-plan',
        'minimax-cn-coding-plan',
        'compatible',
      ]),
    );

    expect(presets.map((preset) => preset.providerId)).toEqual(['compatible']);
  });

  it('maps the three supported transports and normalizes their request bases', async () => {
    const messagesProviderId = 'anthropic';
    const presets = await parsePresetsForTest({
      openai: {
        name: 'OpenAI',
        npm: '@ai-sdk/openai',
        models: { gpt: { name: 'GPT', tool_call: true } },
      },
      compatible: {
        name: 'Compatible',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://compatible.example/v1/chat/completions',
        models: { chat: { name: 'Chat', tool_call: true } },
      },
      [messagesProviderId]: {
        name: 'Messages API',
        npm: '@ai-sdk/anthropic',
        models: { chat: { name: 'Chat', tool_call: true } },
      },
    });

    expect(
      presets.map(({ providerId, baseUrl, apiFormat }) => ({
        providerId,
        baseUrl,
        apiFormat,
      })),
    ).toEqual([
      {
        providerId: 'compatible',
        baseUrl: 'https://compatible.example/v1',
        apiFormat: 'openai-completions',
      },
      {
        providerId: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiFormat: 'anthropic-messages',
      },
      {
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiFormat: 'openai-responses',
      },
    ]);
    const messagesApiHost = 'https://api.anthropic.com';
    expect(
      presets.map((preset) => ({
        completion: providerCompletionUrl(preset.apiFormat, preset.baseUrl),
        models: providerModelsUrls(preset.apiFormat, preset.baseUrl),
      })),
    ).toEqual([
      {
        completion: 'https://compatible.example/v1/chat/completions',
        models: ['https://compatible.example/v1/models'],
      },
      {
        completion: `${messagesApiHost}/v1/messages`,
        models: [`${messagesApiHost}/v1/models`, `${messagesApiHost}/models`],
      },
      {
        completion: 'https://api.openai.com/v1/responses',
        models: ['https://api.openai.com/v1/models'],
      },
    ]);
  });

  it('keeps non-native transports only when they declare an API base', async () => {
    const presets = await parsePresetsForTest({
      meta: {
        name: 'Meta',
        npm: '@ai-sdk/openai',
        api: 'https://openai.meta.example/v1/responses',
        models: { llama: { name: 'Llama', tool_call: true } },
      },
      'openai-missing-api': {
        name: 'OpenAI-compatible without API',
        npm: '@ai-sdk/openai',
        models: { model: { tool_call: true } },
      },
      'messages-proxy': {
        name: 'Messages proxy',
        npm: '@ai-sdk/anthropic',
        api: 'https://messages.example/v1/messages',
        models: { chat: { name: 'Chat', tool_call: true } },
      },
      'messages-missing-api': {
        name: 'Messages-compatible without API',
        npm: '@ai-sdk/anthropic',
        models: { model: { tool_call: true } },
      },
    });

    expect(
      presets.map(({ providerId, baseUrl, apiFormat }) => ({
        providerId,
        baseUrl,
        apiFormat,
      })),
    ).toEqual([
      {
        providerId: 'messages-proxy',
        baseUrl: 'https://messages.example',
        apiFormat: 'anthropic-messages',
      },
      {
        providerId: 'meta',
        baseUrl: 'https://openai.meta.example/v1',
        apiFormat: 'openai-responses',
      },
    ]);
  });

  it('keeps opaque Provider IDs and only complete tool-capable presets', async () => {
    const presets = await parsePresetsForTest({
      'vendor.with.dots': {
        name: 'Vendor',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://vendor.example/v1',
        models: {
          unsupported: { name: 'Unsupported', tool_call: false },
          supported: {
            name: 'Supported',
            tool_call: true,
            attachment: true,
            reasoning: true,
            temperature: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 128_000, output: 8_192 },
          },
        },
      },
      unsupportedNpm: {
        name: 'Unsupported npm',
        npm: '@ai-sdk/google',
        api: 'https://google.example',
        models: { model: { tool_call: true } },
      },
      unsafe: {
        name: 'Unsafe URL',
        npm: '@ai-sdk/openai-compatible',
        api: 'file:///tmp/provider',
        models: { model: { tool_call: true } },
      },
      empty: {
        name: 'No models',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://empty.example',
        models: {},
      },
    });

    expect(presets).toEqual([
      {
        providerId: 'vendor.with.dots',
        name: 'Vendor',
        baseUrl: 'https://vendor.example/v1',
        apiFormat: 'openai-completions',
        models: [
          {
            modelId: 'supported',
            displayName: 'Supported',
            attachment: true,
            reasoning: true,
            toolCall: true,
            temperature: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 128_000, output: 8_192 },
          },
        ],
      },
    ]);
  });

  it('parses declared reasoning effort options for Kimi K3 on both Moonshot providers', async () => {
    const k3 = {
      name: 'Kimi K3',
      tool_call: true,
      attachment: true,
      reasoning: true,
      reasoning_options: [
        { type: 'toggle' },
        { type: 'effort', values: ['low', 'high', 'max'] },
      ],
      temperature: false,
      modalities: { input: ['text', 'image', 'video'], output: ['text'] },
      limit: { context: 1_048_576, output: 131_072 },
    };
    const presets = await parsePresetsForTest({
      moonshotai: {
        name: 'Moonshot AI',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://api.moonshot.ai/v1',
        models: {
          'kimi-k3': k3,
          'kimi-k2.6': {
            name: 'Kimi K2.6',
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: 'toggle' }],
          },
          'kimi-k2.7-code': {
            name: 'Kimi K2.7 Code',
            tool_call: true,
            reasoning: true,
            reasoning_options: [],
          },
        },
      },
      'moonshotai-cn': {
        name: 'Moonshot AI China',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://api.moonshot.cn/v1',
        models: { 'kimi-k3': k3 },
      },
    });

    for (const providerId of ['moonshotai', 'moonshotai-cn'] as const) {
      const preset = presets.find((candidate) => candidate.providerId === providerId);
      expect(preset?.models.find((model) => model.modelId === 'kimi-k3')).toMatchObject({
        reasoning: true,
        effortOptions: ['low', 'high', 'max'],
      });
      if (!preset) throw new Error(`Missing preset ${providerId}`);
      const savedModel = modelsFromInputs(preset.models)['kimi-k3'];
      expect(savedModel?.thinking).toEqual({ effortOptions: ['low', 'high', 'max'] });
      expect(buildModelEntry({
        providerId: `custom_provider:${providerId}`,
        modelId: 'kimi-k3',
        model: savedModel,
        selected: false,
        providerSource: 'custom_provider',
        providerKind: 'custom',
        providerName: preset.name,
      }).effortOptions).toEqual(['low', 'high', 'max']);
    }
    const moonshot = presets.find((candidate) => candidate.providerId === 'moonshotai');
    // A toggle-only or bare reasoning model can think, but declares no
    // selectable effort levels, so it must not gain effortOptions.
    for (const modelId of ['kimi-k2.6', 'kimi-k2.7-code'] as const) {
      const model = moonshot?.models.find((candidate) => candidate.modelId === modelId);
      expect(model).toMatchObject({ reasoning: true });
      expect(model).not.toHaveProperty('effortOptions');
    }
  });

  it('normalizes effort metadata without inventing or dropping declared levels', async () => {
    const [preset] = await parsePresetsForTest({
      compatible: {
        name: 'Compatible API',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://api.example.test/v1',
        models: {
          custom: {
            name: 'Custom',
            tool_call: true,
            reasoning: true,
            reasoning_options: [null, {}, { type: 'effort', values: 'high' },
              { type: 'effort', values: [' light ', 'light', '', ' ', 7, null, 'max'] }],
          },
          'empty-effort': {
            name: 'Empty effort',
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: [] }],
          },
          'budget-only': {
            name: 'Budget only',
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: 'budget_tokens', min: 128, max: 32_768 }],
          },
        },
      },
    });

    const model = (modelId: string) =>
      preset?.models.find((candidate) => candidate.modelId === modelId);
    // Unknown levels are preserved verbatim; blanks, duplicates and
    // non-strings never reach the roster.
    expect(model('custom')).toMatchObject({ effortOptions: ['light', 'max'] });
    expect(model('empty-effort')).not.toHaveProperty('effortOptions');
    expect(model('budget-only')).not.toHaveProperty('effortOptions');
  });
});

describe('models.dev Provider Preset snapshots', () => {
  it('lists the newest valid local snapshot without waiting for network', async () => {
    const paths = await catalogPaths();
    await writeFile(
      paths.bundledCatalogPath,
      gzipSync(JSON.stringify(snapshot(20, 'bundled-new'))),
    );
    await writeFile(paths.localCatalogPath, JSON.stringify(snapshot(10, 'local-old')));
    const neverFetches = vi.fn(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;
    const catalog = new ProviderPresetCatalog({
      ...paths,
      modelsDevFetch: neverFetches,
      commonConfigFetch: unavailableCommonConfig(),
      regionGetter: () => 'cn',
    });

    await expect(catalog.listProviderPresets()).resolves.toMatchObject([
      { models: [{ modelId: 'bundled-new' }] },
    ]);

    await writeFile(paths.localCatalogPath, JSON.stringify(snapshot(30, 'local-new')));
    await expect(catalog.listProviderPresets()).resolves.toMatchObject([
      { models: [{ modelId: 'local-new' }] },
    ]);

    await writeFile(paths.localCatalogPath, '{not json');
    await expect(catalog.listProviderPresets()).resolves.toMatchObject([
      { models: [{ modelId: 'bundled-new' }] },
    ]);
    expect(neverFetches).toHaveBeenCalledOnce();
  });

  it.each([
    ['gateway 503', () => vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch],
    ['gateway redirect', gatewayRedirectFetch],
    [
      'gateway timeout',
      () =>
        vi.fn(
          (_url: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            }),
        ) as typeof fetch,
    ],
    [
      'mirrored catalog failure',
      () => {
        let requests = 0;
        return vi.fn(async () => {
          requests += 1;
          if (requests === 1) {
            return new Response(
              JSON.stringify({
                catalog_url: `https://filecdn.minimax.chat/public/models-dev/catalog/${TEST_RELEASE_SHA}/api.json`,
                icon_base_url: `https://filecdn.minimax.chat/public/models-dev/catalog/${TEST_RELEASE_SHA}/logos/`,
              }),
            );
          }
          return new Response(null, { status: 503 });
        }) as typeof fetch;
      },
    ],
    ['mirrored catalog redirect', mirroredCatalogRedirectFetch],
    [
      'invalid gateway descriptor',
      () =>
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                catalog_url: 'https://evil.example/api.json',
                icon_base_url: 'https://evil.example/logos/',
              }),
            ),
        ) as typeof fetch,
    ],
  ])(
    'keeps the local snapshot immediately available after a CN %s',
    async (_label, fetchFactory) => {
      const paths = await catalogPaths();
      await writeFile(paths.bundledCatalogPath, gzipSync(JSON.stringify(snapshot(10, 'bundled'))));
      await writeFile(paths.localCatalogPath, JSON.stringify(snapshot(20, 'local')));
      const modelsDevFetch = fetchFactory();
      const catalog = new ProviderPresetCatalog({
        ...paths,
        modelsDevFetch,
        modelsDevTimeoutMs: 5,
        commonConfigFetch: unavailableCommonConfig(),
        commonConfigOriginGetter: () => 'https://gateway.example',
        regionGetter: () => 'cn',
      });

      await expect(catalog.listProviderPresets()).resolves.toMatchObject([
        { models: [{ modelId: 'local' }] },
      ]);
      await vi.waitFor(() => expect(modelsDevFetch).toHaveBeenCalled());
    },
  );

  it('forces one full refresh for a legacy snapshot without an icon base URL', async () => {
    const paths = await catalogPaths();
    await writeFile(
      paths.bundledCatalogPath,
      gzipSync(JSON.stringify(snapshot(20, 'bundled', 'old-etag'))),
    );
    let finishFetch: (response: Response) => void = () => undefined;
    let modelsDevRequestInit: RequestInit | undefined;
    const modelsDevFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      modelsDevRequestInit = init;
      return new Promise<Response>((resolve) => {
        finishFetch = resolve;
      });
    }) as unknown as typeof fetch;
    const catalog = new ProviderPresetCatalog({
      ...paths,
      modelsDevFetch,
      commonConfigFetch: unavailableCommonConfig(),
      regionGetter: () => 'en',
      now: () => 30,
    });

    await expect(catalog.listProviderPresets()).resolves.toMatchObject([
      { models: [{ modelId: 'bundled' }] },
    ]);
    await vi.waitFor(() => expect(modelsDevRequestInit).toBeDefined());
    expect(new Headers(modelsDevRequestInit?.headers).get('if-none-match')).toBeNull();

    finishFetch(
      new Response(JSON.stringify(rawCatalog('network-new')), {
        status: 200,
        headers: { etag: 'new-etag' },
      }),
    );
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(paths.localCatalogPath, 'utf8'))).toEqual(
        snapshot(30, 'network-new', 'new-etag', 'https://models.dev/logos/'),
      );
    });
    await expect(catalog.listProviderPresets()).resolves.toMatchObject([
      { models: [{ modelId: 'network-new' }] },
    ]);
  });

  it.each([
    ['304', () => new Response(null, { status: 304 })],
    ['HTTP error', () => new Response(null, { status: 503 })],
    ['invalid JSON', () => new Response('{invalid', { status: 200 })],
    ['empty supported set', () => new Response(JSON.stringify({ unsupported: true }))],
  ])('keeps the valid snapshot after a %s refresh', async (_label, responseFactory) => {
    const paths = await catalogPaths();
    await writeFile(paths.bundledCatalogPath, gzipSync(JSON.stringify(snapshot(20, 'stable'))));
    const catalog = new ProviderPresetCatalog({
      ...paths,
      modelsDevFetch: vi.fn(async () => responseFactory()) as typeof fetch,
      commonConfigFetch: unavailableCommonConfig(),
      regionGetter: () => 'en',
    });

    await vi.waitFor(() =>
      expect(catalog.listProviderPresets()).resolves.toMatchObject([
        { models: [{ modelId: 'stable' }] },
      ]),
    );
    await expect(readFile(paths.localCatalogPath, 'utf8')).rejects.toThrow();
  });

  it('isolates a timed out models.dev refresh and keeps the local snapshot available', async () => {
    const paths = await catalogPaths();
    await writeFile(paths.bundledCatalogPath, gzipSync(JSON.stringify(snapshot(20, 'stable'))));
    let requestSignal: AbortSignal | undefined;
    const modelsDevFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason));
        }),
    ) as typeof fetch;
    const catalog = new ProviderPresetCatalog({
      ...paths,
      modelsDevFetch,
      modelsDevTimeoutMs: 5,
      commonConfigFetch: unavailableCommonConfig(),
      regionGetter: () => 'cn',
    });

    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    await expect(catalog.listProviderPresets()).resolves.toMatchObject([
      { models: [{ modelId: 'stable' }] },
    ]);
    await expect(readFile(paths.localCatalogPath, 'utf8')).rejects.toThrow();
  });
});

describe('Provider Preset ordering', () => {
  it('uses the region-local CN and Global pin order when Apollo is unavailable', async () => {
    const cnIds = [
      'minimax-cn',
      'zhipuai',
      'deepseek',
      'moonshotai-cn',
      'openai',
      'anthropic',
      'aaa',
      'tencent-coding-plan',
      'zzz',
    ];
    const cn = await orderingCatalog(cnIds, {
      region: 'cn',
      commonConfigFetch: unavailableCommonConfig(),
    });
    await expect(
      cn.listProviderPresets().then((items) => items.map((item) => item.providerId)),
    ).resolves.toEqual(cnIds.slice(1));

    const globalIds = [
      'minimax',
      'zai',
      'deepseek',
      'moonshotai',
      'openai',
      'anthropic',
      'aaa',
      'tencent-coding-plan',
    ];
    const global = await orderingCatalog(globalIds, {
      region: 'en',
      commonConfigFetch: unavailableCommonConfig(),
    });
    await expect(
      global.listProviderPresets().then((items) => items.map((item) => item.providerId)),
    ).resolves.toEqual(globalIds.slice(1));
  });

  it.each([
    ['JSON array', ['anthropic', 'unknown', 'anthropic', 'openai']],
    ['JSON string', JSON.stringify(['anthropic', 'unknown', 'anthropic', 'openai'])],
  ])('lets a valid Apollo %s fully replace the region defaults', async (_label, value) => {
    const readCandidates = vi.mocked(readProviderPresetSnapshotCandidates);
    readCandidates.mockClear();
    let commonConfigRequest: string | URL | Request | undefined;
    let finishFetch: (response: Response) => void = () => undefined;
    const commonConfigFetch = vi.fn((input: string | URL | Request) => {
      commonConfigRequest = input;
      return new Promise<Response>((resolve) => {
        finishFetch = resolve;
      });
    }) as unknown as typeof fetch;
    const catalog = await orderingCatalog(['zhipuai', 'openai', 'deepseek', 'anthropic'], {
      region: 'cn',
      commonConfigFetch,
    });
    await waitForRepositoryRead(0);

    let settled = false;
    const firstList = catalog
      .listProviderPresets()
      .then((items) => items.map((item) => item.providerId))
      .finally(() => {
        settled = true;
      });
    await waitForRepositoryRead(1);
    expect(settled).toBe(false);
    finishFetch(commonConfigResponse(value));
    await expect(firstList).resolves.toEqual(['anthropic', 'openai', 'deepseek', 'zhipuai']);
    expect(commonConfigFetch).toHaveBeenCalledOnce();
    const requestUrl = new URL(String(commonConfigRequest));
    expect(requestUrl.origin).toBe('https://gateway.example');
    expect(requestUrl.pathname).toBe('/v1/api/config/web/common_config');
    expect(requestUrl.searchParams.get('filter')).toBe('agent_byok_pinned_provider_ids');
  });

  it.each([
    ['JSON array', []],
    ['JSON string', '[]'],
  ])('treats an Apollo empty %s as no pins', async (_label, value) => {
    const readCandidates = vi.mocked(readProviderPresetSnapshotCandidates);
    readCandidates.mockClear();
    let finishFetch: (response: Response) => void = () => undefined;
    const commonConfigFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishFetch = resolve;
        }),
    ) as typeof fetch;
    const catalog = await orderingCatalog(['zhipuai', 'openai', 'deepseek', 'anthropic'], {
      region: 'cn',
      commonConfigFetch,
    });
    await waitForRepositoryRead(0);

    let settled = false;
    const firstList = catalog
      .listProviderPresets()
      .then((items) => items.map((item) => item.providerId))
      .finally(() => {
        settled = true;
      });
    await waitForRepositoryRead(1);
    expect(settled).toBe(false);
    finishFetch(commonConfigResponse(value));
    await expect(firstList).resolves.toEqual(['anthropic', 'deepseek', 'openai', 'zhipuai']);
  });

  it.each([
    ['missing', undefined],
    ['not JSON', 'not-json'],
    ['not an array', '{}'],
    ['mixed types', '["openai",1]'],
    ['mixed native types', ['openai', 1]],
    ['empty string', '[""]'],
    ['blank string', '[" "]'],
  ])('falls back to the CN defaults for %s Apollo data', async (_label, value) => {
    const catalog = await orderingCatalog(['zhipuai', 'openai', 'deepseek', 'anthropic'], {
      region: 'cn',
      commonConfigFetch: vi.fn(async () => commonConfigResponse(value)) as typeof fetch,
    });

    await expect(
      catalog.listProviderPresets().then((items) => items.map((item) => item.providerId)),
    ).resolves.toEqual(['zhipuai', 'deepseek', 'openai', 'anthropic']);
  });

  it.each([
    ['statusInfo', { statusInfo: { code: 500 }, data: { agent_byok_pinned_provider_ids: '[]' } }],
    [
      'base_resp',
      { base_resp: { status_code: 500 }, data: { agent_byok_pinned_provider_ids: '[]' } },
    ],
  ])('falls back to region defaults for a %s business error', async (_label, body) => {
    const catalog = await orderingCatalog(['zhipuai', 'openai', 'deepseek', 'anthropic'], {
      region: 'cn',
      commonConfigFetch: vi.fn(
        async () => new Response(JSON.stringify(body), { status: 200 }),
      ) as typeof fetch,
    });

    await expect(
      catalog.listProviderPresets().then((items) => items.map((item) => item.providerId)),
    ).resolves.toEqual(['zhipuai', 'deepseek', 'openai', 'anthropic']);
  });

  it('aborts a timed out Apollo request and keeps the region defaults', async () => {
    let requestSignal: AbortSignal | undefined;
    const commonConfigFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason));
        }),
    ) as typeof fetch;
    const catalog = await orderingCatalog(['zhipuai', 'openai', 'deepseek', 'anthropic'], {
      region: 'cn',
      commonConfigFetch,
      commonConfigTimeoutMs: 5,
    });

    await expect(
      catalog.listProviderPresets().then((items) => items.map((item) => item.providerId)),
    ).resolves.toEqual(['zhipuai', 'deepseek', 'openai', 'anthropic']);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('retries Apollo ordering on the next list after a transient failure', async () => {
    let requestCount = 0;
    const commonConfigFetch = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) throw new Error('offline');
      return commonConfigResponse(['tencent-tokenhub', 'openai']);
    }) as typeof fetch;
    const catalog = await orderingCatalog(
      ['zhipuai', 'openai', 'deepseek', 'anthropic', 'tencent-tokenhub'],
      { region: 'cn', commonConfigFetch },
    );

    await expect(
      catalog.listProviderPresets().then((items) => items.map((item) => item.providerId)),
    ).resolves.toEqual(['zhipuai', 'deepseek', 'openai', 'anthropic', 'tencent-tokenhub']);
    await expect(
      catalog.listProviderPresets().then((items) => items.map((item) => item.providerId)),
    ).resolves.toEqual(['tencent-tokenhub', 'openai', 'anthropic', 'deepseek', 'zhipuai']);
    expect(commonConfigFetch).toHaveBeenCalledTimes(2);
  });
});
