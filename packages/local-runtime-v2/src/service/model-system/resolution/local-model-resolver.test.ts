import {
  ThinkingLevel,
  ThinkingMode,
  type IAgentConfig,
  type IModelCapabilities,
  type IModelRef,
} from '@mavis/protocol';
import { describe, expect, it, vi } from 'vitest';

import { streamSimple } from '@earendil-works/pi-ai';
import { hasThinkingPrefixBinding } from '@mavis/agent-core/pi-turn-runner';

import { LocalModelResolver } from './local-model-resolver.js';
import { lookupLocalModelLimits } from '../../../infra/config/model-catalog.js';
import { OPENPLATFORM_THINKING_VARIANTS_CAPABILITY } from './openplatform-thinking.js';
import { capabilitiesFromModelConfig, modelRefForModel } from './model-ref.js';
import type {
  LocalByokProviderConfig,
  LocalCustomProviderConfig,
  LocalModelConfig,
  LocalModelsConfig,
} from '../contracts.js';
import type { LocalRuntimeAuthContext } from '../../../infra/config/auth-context.js';
import { apiKeyId } from '../byok-keys/key-list.js';
import { ByokKeyPool } from '../byok-keys/key-pool.js';

const AGENT_CONFIG: IAgentConfig = {
  system_prompt: 'system',
  agent_id: 'agent-native',
  model: {
    provider: 'provider-native',
    model_id: 'model-native',
    context_window: 120_000,
    max_tokens: 12_000,
  },
  tools: [],
  skills: [],
};

describe('LocalModelResolver', () => {
  it('uses the frozen M3 1M context in the resolved executor model', async () => {
    const resolver = new LocalModelResolver({
      providerConfig: {
        minimax: { models: { 'MiniMax-M3': { limit: { context: 512_000, output: 128_000 } } } },
      },
      byokConfigGetter: () => ({
        minimax_api: { apiKey: 'test-key', baseURL: 'https://example.invalid' },
      }),
    });
    const resolved = await resolver.resolveModel({
      sessionId: 'm3-session',
      turnId: 'm3-turn',
      agentConfig: {
        ...AGENT_CONFIG,
        model: { provider: 'minimax_api', model_id: 'MiniMax-M3', context_window: 1_000_000 },
      },
    });
    expect(resolved.model.contextWindow).toBe(1_000_000);
  });

  it.each([
    [{ ...AGENT_CONFIG, model: undefined }, 'agentConfig.model is required'],
    [
      {
        ...AGENT_CONFIG,
        model: { provider: '   ', model_id: 'model-native' },
      },
      'ModelRef.provider is required',
    ],
    [
      {
        ...AGENT_CONFIG,
        model: { provider: 'provider-native', model_id: '   ' },
      },
      'ModelRef.model_id is required',
    ],
  ])(
    'rejects incomplete model identity before resolving credentials',
    async (agentConfig, message) => {
      const resolver = new LocalModelResolver();

      await expect(
        resolver.resolveModel({
          sessionId: 'session-invalid',
          turnId: 'turn-invalid',
          agentConfig: agentConfig as IAgentConfig,
        }),
      ).rejects.toThrow(message);
    },
  );

  it('resolves API-key providers with normalized limits and runtime identity headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const resolver = new LocalModelResolver({
      defaultApi: 'openai-completions',
      fetchImpl,
      providerConfig: {
        'provider-native': {
          options: {
            apiKey: 'secret-native',
            baseURL: 'https://provider.example/v1/',
            headers: {
              Existing: 'kept',
              'X-Mavis-Session-Id': 'stale',
            },
          },
          models: {
            'model-native': {
              limit: { context: 120_000, output: 12_000 },
            },
          },
        },
      },
    });

    const resolved = await resolver.resolveModel({
      sessionId: 'session-native',
      turnId: 'turn-native',
      agentConfig: AGENT_CONFIG,
    });

    expect(resolved).toMatchObject({
      managedProvider: false,
      apiKey: 'secret-native',
      maxTokens: 12_000,
      model: {
        provider: 'provider-native',
        id: 'model-native',
        api: 'openai-completions',
        baseUrl: 'https://provider.example/v1',
        contextWindow: 120_000,
        maxTokens: 12_000,
      },
      headers: {
        Existing: 'kept',
        'X-Mavis-Session-Id': 'session-native',
        'X-Mavis-Agent-Id': 'agent-native',
      },
    });
    expect(resolved.fetch).toBe(fetchImpl);
  });
});

describe('LocalModelResolver dynamic output strategy', () => {
  it.each([
    'anthropic-messages',
    'openai-completions',
    'openai-responses',
    'openai-codex-responses',
  ] as const)('installs the dynamic output strategy for %s', async (api) => {
    const calls: Array<{ maxTokens?: number }> = [];
    const streamFn = ((_model: unknown, _context: unknown, options?: { maxTokens?: number }) => {
      calls.push({ maxTokens: options?.maxTokens });
      return {} as never;
    }) as never;
    const resolver = new LocalModelResolver({
      defaultApi: api,
      streamFn,
      providerConfig: {
        'provider-native': {
          options: {
            apiKey: 'secret-native',
            baseURL: 'https://provider.example/v1',
          },
        },
      },
    });
    const resolved = await resolver.resolveModel({
      sessionId: 'session-dynamic-output',
      turnId: 'turn-dynamic-output',
      agentConfig: {
        ...AGENT_CONFIG,
        model: {
          ...AGENT_CONFIG.model,
          context_window: 65_536,
          max_tokens: 32_768,
        },
      },
    });

    resolved.streamFn?.(
      resolved.model,
      { systemPrompt: 'a'.repeat(40_000), messages: [] },
      { maxTokens: 32_768 },
    );

    expect(calls).toEqual([{ maxTokens: 23_488 }]);
  });
});

describe('LocalModelResolver', () => {
  it('defaults a managed model without a ModelRef window to its configured limit', async () => {
    const resolver = new LocalModelResolver({
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-managed' }),
      providerConfig: {
        minimax: {
          options: {
            authMode: 'managed-login',
            apiKey: 'sk-xxx',
            baseURL: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
          },
          models: { 'MiniMax-M3-Pro': { limit: { context: 400_000, output: 64_000 } } },
        },
      },
    });
    const resolve = (model: IModelRef) =>
      resolver.resolveModel({
        sessionId: 'session-memory',
        turnId: 'turn-memory',
        agentConfig: { ...AGENT_CONFIG, model },
      });

    // Memory V2 passes only the model identity, so the configured default window applies.
    const bare = await resolve({ provider: 'minimax', model_id: 'MiniMax-M3-Pro' });
    expect(bare.managedProvider).toBe(true);
    expect(bare.model.contextWindow).toBe(400_000);
    expect(bare.maxTokens).toBe(64_000);

    // A window selected for the turn still wins over the configured default.
    const selected = await resolve({
      provider: 'minimax',
      model_id: 'MiniMax-M3-Pro',
      context_window: 1_000_000,
      max_tokens: 32_000,
    });
    expect(selected.model.contextWindow).toBe(1_000_000);
    expect(selected.maxTokens).toBe(32_000);
  });

  it.each([
    { limit: undefined, context: 200_000 },
    { limit: { context: 0, output: -1 }, context: 200_000 },
    { limit: { context: 400_000 }, context: 400_000 },
  ])(
    'falls back independently for missing or invalid configured limits: $limit',
    async ({ limit, context }) => {
      const resolver = new LocalModelResolver({
        authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-managed' }),
        providerConfig: {
          minimax: {
            options: {
              authMode: 'managed-login',
              apiKey: 'sk-xxx',
              baseURL: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
            },
            models: { 'MiniMax-M3-Pro': { limit } },
          },
        },
      });
      const resolved = await resolver.resolveModel({
        sessionId: 'session-memory',
        turnId: 'turn-memory',
        agentConfig: { ...AGENT_CONFIG, model: { provider: 'minimax', model_id: 'MiniMax-M3-Pro' } },
      });
      expect(resolved.model.contextWindow).toBe(context);
      expect(resolved.maxTokens).toBe(128_000);
    },
  );

  it('uses current managed auth facts for a recognized managed endpoint', async () => {
    const authContextGetter = vi.fn(() => ({
      accessToken: 'managed-token',
      realUserID: 'user-managed',
    }));
    const resolver = new LocalModelResolver({
      authContextGetter,
      providerConfig: {
        minimax: {
          options: {
            authMode: 'managed-login',
            apiKey: 'sk-xxx',
            baseURL: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
          },
        },
      },
    });

    const resolved = await resolver.resolveModel({
      sessionId: 'session-managed',
      turnId: 'turn-managed',
      agentConfig: {
        ...AGENT_CONFIG,
        model: {
          provider: 'minimax',
          model_id: 'MiniMax-M2.7',
        },
      },
    });

    expect(authContextGetter).toHaveBeenCalledOnce();
    expect(resolved.apiKey).toBe('sk-xxx');
    expect(resolved.managedProvider).toBe(true);
    expect(resolved.model.baseUrl).toBe('https://agent.minimax.io/mavis/api/v1/llm');
    expect(resolved.model.compat?.supportsLongCacheRetention).toBe(false);
    expect(resolved.headers).toMatchObject({
      Authorization: 'Bearer managed-token',
      'User-Agent': 'MiniMaxAgent',
      'X-Mavis-Session-Id': 'session-managed',
    });
    expect(resolved.fileApiGatewayAuth).toMatchObject({
      gatewayHeaders: { Authorization: 'Bearer managed-token' },
      callerIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(resolved.fileApiGatewayAuth)).not.toContain('user-managed');
  });

  it('keeps one resolved model usable across repeated managed token expirations', async () => {
    let authContext = {
      accessToken: 'managed-token-v1',
      loginEpoch: 'login-A',
      realUserID: 'user-managed',
    };
    let acceptedVersion = 1;
    const seenAuthorization: Array<string | null> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const authorization = new Headers(init?.headers).get('Authorization');
      seenAuthorization.push(authorization);
      return new Response(null, {
        status: authorization === `Bearer managed-token-v${acceptedVersion}` ? 200 : 401,
      });
    });
    const authContextInvalidator = vi.fn(async () => {
      authContext = {
        accessToken: `managed-token-v${acceptedVersion}`,
        loginEpoch: 'login-A',
        realUserID: 'user-managed',
      };
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const resolver = new LocalModelResolver({
        authContextGetter: () => authContext,
        authContextInvalidator,
        providerConfig: {
          minimax: {
            options: {
              authMode: 'managed-login',
              apiKey: 'sk-xxx',
              baseURL: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
            },
          },
        },
      });
      const resolved = await resolver.resolveModel({
        sessionId: 'session-managed-refresh',
        turnId: 'turn-managed-refresh',
        agentConfig: {
          ...AGENT_CONFIG,
          model: { provider: 'minimax', model_id: 'MiniMax-M2.7' },
        },
      });

      const expectedAuthorization: string[] = [];
      for (acceptedVersion = 2; acceptedVersion <= 7; acceptedVersion += 1) {
        // Each expiry is followed by another LLM step using the same resolved headers.
        for (let step = 0; step < 2; step += 1) {
          const response = await resolved.fetch?.('https://agent.minimax.io/mavis/api/v1/llm', {
            method: 'POST',
            headers: resolved.headers,
            body: '{}',
          });
          expect(response?.status).toBe(200);
        }
        expectedAuthorization.push(
          `Bearer managed-token-v${acceptedVersion - 1}`,
          `Bearer managed-token-v${acceptedVersion}`,
          `Bearer managed-token-v${acceptedVersion}`,
        );
        expect(authContextInvalidator).toHaveBeenNthCalledWith(
          acceptedVersion - 1,
          `managed-token-v${acceptedVersion - 1}`,
          'login-A',
        );
      }
      expect(authContextInvalidator).toHaveBeenCalledTimes(6);
      expect(seenAuthorization).toEqual(expectedAuthorization);
      expect(resolved.headers?.Authorization).toBe('Bearer managed-token-v1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('LocalModelResolver managed request headers', () => {
  it('sends the turn id on managed requests without any review opt-in header', async () => {
    const resolver = new LocalModelResolver({
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-managed' }),
      providerConfig: {
        minimax: {
          options: {
            authMode: 'managed-login',
            apiKey: 'sk-xxx',
            baseURL: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
          },
        },
      },
    });

    const resolved = await resolver.resolveModel({
      sessionId: 'session-managed',
      turnId: 'turn-managed',
      agentConfig: {
        ...AGENT_CONFIG,
        model: { provider: 'minimax', model_id: 'MiniMax-M2.7' },
      },
    });

    expect(resolved.managedProvider).toBe(true);
    // 网关对所有托管请求一律审核：Mavis 头只有身份、时区和 turn id。
    expect(
      Object.keys(resolved.headers ?? {})
        .filter((key) => key.startsWith('X-Mavis-'))
        .sort(),
    ).toEqual([
      'X-Mavis-Agent-Id',
      'X-Mavis-Session-Id',
      'X-Mavis-Timezone-Offset',
      'X-Mavis-Turn-Id',
    ]);
    expect(resolved.headers?.['X-Mavis-Turn-Id']).toBe('turn-managed');
  });
});

describe('LocalModelResolver managed auth continuity', () => {
  it.each(['same-login', 'new-login'] as const)(
    'binds managed auth before asynchronous resolution and reads the latest token: %s',
    async (transition) => {
      const authContext: LocalRuntimeAuthContext = {
        accessToken: 'managed-token-v1',
        loginEpoch: 'login-A',
      };
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
      const resolver = new LocalModelResolver({
        fetchImpl,
        authContextGetter: () => authContext,
        providerConfig: {
          minimax: {
            options: {
              authMode: 'managed-login',
              apiKey: 'sk-xxx',
              baseURL: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
            },
          },
        },
      });
      const resolving = resolver.resolveModel({
        sessionId: 'session-managed-rotation',
        turnId: 'turn-managed-rotation',
        agentConfig: {
          ...AGENT_CONFIG,
          model: { provider: 'minimax', model_id: 'MiniMax-M2.7' },
        },
      });
      Object.assign(authContext, {
        accessToken: 'managed-token-v2',
        loginEpoch: transition === 'same-login' ? 'login-A' : 'login-B',
      });
      const resolved = await resolving;
      const response = await resolved.fetch?.('https://agent.minimax.io/mavis/api/v1/llm', {
        headers: resolved.headers,
      });

      expect(resolved.headers?.Authorization).toBe('Bearer managed-token-v1');
      if (transition === 'same-login') {
        expect(response?.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
          'Bearer managed-token-v2',
        );
      } else {
        expect(response?.status).toBe(401);
        expect(fetchImpl).not.toHaveBeenCalled();
      }
    },
  );
});

describe('LocalModelResolver model routing', () => {
  it('keeps catalog-miss fallback limits explicit', () => {
    expect(lookupLocalModelLimits('provider-native', 'unknown-model')).toEqual({
      contextWindow: 200_000,
      maxTokens: 128_000,
      fromCatalog: false,
    });
  });

  it('resolves source-qualified MiniMax API models from BYOK facts', async () => {
    const resolver = new LocalModelResolver({
      providerConfig: {
        minimax: {
          models: {
            'MiniMax-M3': {
              limit: { context: 400_000, output: 128_000 },
            },
          },
        },
      },
      byokConfigGetter: () => ({
        minimax_api: {
          apiKey: 'minimax-user-key',
          baseURL: 'https://byok.example/messages-api',
        },
      }),
    });

    const resolved = await resolver.resolveModel({
      sessionId: 'session-byok',
      turnId: 'turn-byok',
      agentConfig: {
        ...AGENT_CONFIG,
        model: {
          provider: 'minimax_api',
          model_id: 'MiniMax-M3',
        },
      },
    });

    expect(resolved).toMatchObject({
      managedProvider: false,
      apiKey: 'minimax-user-key',
      maxTokens: 128_000,
      model: {
        provider: 'minimax_api',
        id: 'MiniMax-M3',
        api: 'anthropic-messages',
        baseUrl: 'https://byok.example/messages-api',
        contextWindow: 400_000,
      },
    });
    expect(resolved.streamFn).toBeTypeOf('function');
    expect(resolved.model.compat?.supportsLongCacheRetention).toBe(false);
    expect(resolved.headers?.Token).toBeUndefined();
    expect(resolved.fileApiGatewayAuth).toBeUndefined();
  });
});

describe('LocalModelResolver request-body byte authority', () => {
  it('preserves positive safe integers and defaults missing or invalid legacy limits', async () => {
    const resolver = new LocalModelResolver({
      providerConfig: {
        'provider-native': {
          options: {
            apiKey: 'secret-native',
            baseURL: 'https://provider.example/v1',
          },
        },
      },
    });
    const values = [
      128,
      ' 256 ',
      undefined,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      String(Number.MAX_SAFE_INTEGER + 1),
      'not-a-number',
    ];
    const resolved = await Promise.all(
      values.map((maxRequestBodyBytes, index) =>
        resolver.resolveModel({
          sessionId: `session-byte-limit-${index}`,
          turnId: `turn-byte-limit-${index}`,
          agentConfig: {
            ...AGENT_CONFIG,
            model: {
              ...AGENT_CONFIG.model,
              ...(maxRequestBodyBytes === undefined
                ? {}
                : { capabilities: { max_request_body_bytes: maxRequestBodyBytes } }),
            },
          },
        }),
      ),
    );

    expect(resolved.map((model) => model.maxRequestBodyBytes)).toEqual([
      128, 256, 67_108_864, 67_108_864, 67_108_864, 67_108_864, 67_108_864, 67_108_864, 67_108_864,
    ]);
  });
});

describe('LocalModelResolver BYOK routing and fallback', () => {
  it('honors the MiniMax BYOK source switch and the injected stream implementation', async () => {
    const streamFn = vi.fn();
    const resolver = new LocalModelResolver({
      streamFn: streamFn as never,
      providerConfig: {
        minimax: {
          models: {
            'MiniMax-M3': {
              limit: { context: 400_000, output: 128_000 },
            },
          },
        },
      },
      byokConfigGetter: () => ({
        minimaxModelSource: 'minimax_api_key',
        minimax_api: {
          apiKey: 'minimax-user-key',
          baseURL: 'https://byok.example/messages-api',
        },
      }),
    });

    const resolved = await resolver.resolveModel({
      sessionId: 'session-byok-switch',
      turnId: 'turn-byok-switch',
      agentConfig: {
        ...AGENT_CONFIG,
        model: {
          provider: 'minimax',
          model_id: 'MiniMax-M3',
        },
      },
    });

    expect(resolved).toMatchObject({
      apiKey: 'minimax-user-key',
      model: {
        provider: 'minimax_api',
        id: 'MiniMax-M3',
        api: 'anthropic-messages',
      },
    });
    expect(resolved.streamFn).toBeTypeOf('function');
  });

  it('hands a provider with several enabled keys a key lifecycle and its first free key', async () => {
    const pool = new ByokKeyPool(() => 1_000);
    pool.restKey('work', apiKeyId('sk-first-aaaaaaaa'), 'rate');
    const resolver = new LocalModelResolver({
      byokKeyPool: pool,
      byokConfigGetter: () => ({
        custom_provider: {
          work: {
            api: 'openai-completions',
            options: {
              apiKey: 'sk-first-aaaaaaaa',
              apiKeys: [
                { key: 'sk-first-aaaaaaaa', enabled: true },
                { key: 'sk-off-cccccccc', enabled: false },
                { key: 'sk-second-bbbbbbbb', enabled: true },
              ],
              baseURL: 'https://custom.example/v1',
            },
            models: { m: {} },
          },
        },
      }),
    });
    const input = {
      sessionId: 's',
      turnId: 't',
      agentConfig: { ...AGENT_CONFIG, model: { provider: 'custom_provider:work', model_id: 'm' } },
    };

    const resolved = await resolver.resolveModel(input);

    expect(resolved.apiKey).toBe('sk-second-bbbbbbbb');
    expect(resolved.callLifecycle).toBeDefined();
  });

  it('keeps a single-key provider without a key lifecycle', async () => {
    const resolver = new LocalModelResolver({
      byokConfigGetter: () => ({
        custom_provider: {
          work: {
            api: 'openai-completions',
            options: {
              apiKeys: [
                { key: 'sk-only-aaaaaaaa', enabled: true },
                { key: 'sk-off-cccccccc', enabled: false },
              ],
              apiKey: 'sk-only-aaaaaaaa',
              baseURL: 'https://custom.example/v1',
            },
            models: { m: {} },
          },
        },
      }),
    });

    const resolved = await resolver.resolveModel({
      sessionId: 's',
      turnId: 't',
      agentConfig: { ...AGENT_CONFIG, model: { provider: 'custom_provider:work', model_id: 'm' } },
    });

    expect(resolved.apiKey).toBe('sk-only-aaaaaaaa');
    expect(resolved.callLifecycle).toBeUndefined();
  });

  it('resolves configured custom providers without truncating slashed model ids', async () => {
    const resolver = new LocalModelResolver({
      byokConfigGetter: () => ({
        custom_provider: {
          work: {
            api: 'openai-completions',
            options: {
              apiKey: 'custom-user-key',
              baseURL: 'https://custom.example/v1/',
              headers: { ProviderHeader: 'provider' },
            },
            models: {
              'org/model-v1': {
                limit: { context: 96_000, output: 12_000 },
                headers: { ModelHeader: 'model' },
              },
            },
          },
        },
      }),
    });

    const resolved = await resolver.resolveModel({
      sessionId: 'session-custom',
      turnId: 'turn-custom',
      agentConfig: {
        ...AGENT_CONFIG,
        model: {
          provider: 'custom_provider:work',
          model_id: 'org/model-v1',
        },
      },
    });

    expect(resolved).toMatchObject({
      apiKey: 'custom-user-key',
      maxTokens: 12_000,
      model: {
        provider: 'custom_provider:work',
        id: 'org/model-v1',
        api: 'openai-completions',
        baseUrl: 'https://custom.example/v1',
        contextWindow: 96_000,
      },
      headers: {
        ProviderHeader: 'provider',
        ModelHeader: 'model',
        'X-Mavis-Session-Id': 'session-custom',
      },
    });
  });

  it('attributes OpenRouter inference requests to MiniMax Code', async () => {
    const resolver = new LocalModelResolver({
      byokConfigGetter: () => ({
        custom_provider: {
          openrouter: {
            api: 'openai-completions',
            options: {
              apiKey: 'sk-or-test',
              baseURL: 'https://openrouter.ai/api/v1',
              headers: {
                'http-referer': 'https://spoofed.example',
                'x-openrouter-title': 'Spoofed App',
              },
            },
            models: { 'openai/gpt-5.2': {} },
          },
        },
      }),
    });

    const resolved = await resolver.resolveModel({
      sessionId: 'session-openrouter',
      turnId: 'turn-openrouter',
      agentConfig: {
        ...AGENT_CONFIG,
        model: { provider: 'custom_provider:openrouter', model_id: 'openai/gpt-5.2' },
      },
    });

    expect(resolved.headers).toMatchObject({
      'HTTP-Referer': 'https://agent.minimax.io/',
      'X-OpenRouter-Title': 'MiniMax Code',
      'X-OpenRouter-Categories': 'cli-agent',
      'X-Mavis-Session-Id': 'session-openrouter',
    });
    expect(resolved.headers).not.toHaveProperty('http-referer');
    expect(resolved.headers).not.toHaveProperty('x-openrouter-title');
  });
});

describe('LocalModelResolver custom-provider endpoint normalization', () => {
  it.each([
    {
      api: 'anthropic-messages',
      baseUrl: 'https://custom.example/v1/messages',
      expectedBaseUrl: 'https://custom.example',
    },
    {
      api: 'openai-completions',
      baseUrl: 'https://custom.example/v1/chat/completions',
      expectedBaseUrl: 'https://custom.example/v1',
    },
    {
      api: 'openai-responses',
      baseUrl: 'https://custom.example/v1/responses',
      expectedBaseUrl: 'https://custom.example/v1',
    },
  ] as const)(
    'normalizes an endpoint-form $api URL with the shared connectivity rule',
    async ({ api, baseUrl, expectedBaseUrl }) => {
      const resolver = new LocalModelResolver({
        byokConfigGetter: () => ({
          custom_provider: {
            work: {
              api,
              options: { apiKey: 'custom-user-key', baseURL: baseUrl },
              models: { model: {} },
            },
          },
        }),
      });

      const resolved = await resolver.resolveModel({
        sessionId: 'session-endpoint-base-url',
        turnId: 'turn-endpoint-base-url',
        agentConfig: {
          ...AGENT_CONFIG,
          model: { provider: 'custom_provider:work', model_id: 'model' },
        },
      });

      expect(resolved.model.baseUrl).toBe(expectedBaseUrl);
    },
  );
});

describe('LocalModelResolver BYOK references fail closed', () => {
  // byok-v2 §8: a deleted provider, a disabled or removed model, or a missing
  // connection returns a configuration error; another provider is never used.
  const managedProvider = {
    minimax: {
      options: {
        apiKey: 'builtin-key',
        baseURL: 'https://builtin.example/messages-api',
      },
      models: {
        'MiniMax-M3': { limit: { context: 400_000, output: 128_000 } },
      },
    },
  };
  const workConnection = {
    options: { apiKey: 'work-key', baseURL: 'https://work.example/v1' },
  };

  function resolveWith(byok: LocalByokProviderConfig, model: IModelRef, warn = vi.fn()) {
    return new LocalModelResolver({
      providerConfig: managedProvider,
      byokConfigGetter: () => byok,
      logger: { info: vi.fn(), warn },
    }).resolveModel({
      sessionId: 'session-byok-closed',
      turnId: 'turn-byok-closed',
      agentConfig: { ...AGENT_CONFIG, model },
    });
  }

  it('still resolves an ordinary managed reference with the same provider config', async () => {
    const resolved = await resolveWith({}, { provider: 'minimax', model_id: 'MiniMax-M3' });

    expect(resolved).toMatchObject({ apiKey: 'builtin-key', model: { provider: 'minimax' } });
  });

  it.each([
    ['a deleted provider', {}],
    ['a disabled provider', { work: { ...workConnection, enabled: false, models: { model: {} } } }],
    ['a removed model', { work: { ...workConnection, enabled: true, models: {} } }],
  ])(
    'rejects a custom-provider reference to %s without logging a fallback',
    async (_label, custom) => {
      const warn = vi.fn();

      await expect(
        resolveWith(
          { custom_provider: custom },
          { provider: 'custom_provider:work', model_id: 'model' },
          warn,
        ),
      ).rejects.toThrow(
        'LocalModelResolver: BYOK model configuration "custom_provider:work/model" is unavailable or disabled.',
      );
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a direct MiniMax API reference', {}, 'minimax_api'],
    ['the MiniMax API-key source', { minimaxModelSource: 'minimax_api_key' as const }, 'minimax'],
  ])(
    'rejects %s without MiniMax API credentials instead of managed login',
    async (_label, byok, provider) => {
      await expect(resolveWith(byok, { provider, model_id: 'MiniMax-M3' })).rejects.toThrow(
        'LocalModelResolver: BYOK model configuration "minimax_api/MiniMax-M3" is unavailable or disabled.',
      );
    },
  );

  it('fails closed when no builtin provider is configured either', async () => {
    const resolver = new LocalModelResolver({ byokConfigGetter: () => ({ custom_provider: {} }) });

    await expect(
      resolver.resolveModel({
        sessionId: 'session-no-fallback',
        turnId: 'turn-no-fallback',
        agentConfig: {
          ...AGENT_CONFIG,
          model: { provider: 'custom_provider:missing', model_id: 'missing' },
        },
      }),
    ).rejects.toThrow('BYOK model configuration "custom_provider:missing/missing"');
  });
});

describe('LocalModelResolver custom-provider session thinking', () => {
  it.each([
    {
      selectedEffort: 'high' as const,
      expectedReasoning: true,
      expectedLevel: 'high' as const,
    },
    {
      selectedEffort: 'none' as const,
      expectedReasoning: false,
      expectedLevel: undefined,
    },
    {
      selectedEffort: 'off' as const,
      expectedReasoning: false,
      expectedLevel: undefined,
    },
  ])(
    'honors session effort $selectedEffort',
    async ({ selectedEffort, expectedReasoning, expectedLevel }) => {
      const modelConfig: LocalModelConfig = {
        reasoning: true,
        thinking: { effortOptions: ['none', 'off', 'high'] },
      };
      const resolver = new LocalModelResolver({
        byokConfigGetter: () => ({
          custom_provider: {
            work: {
              api: 'openai-completions',
              options: {
                apiKey: 'custom-user-key',
                baseURL: 'https://custom.example/v1',
              },
              models: {
                model: modelConfig,
              },
            },
          },
        }),
      });

      const resolved = await resolver.resolveModel({
        sessionId: 'session-custom-thinking',
        turnId: 'turn-custom-thinking',
        agentConfig: {
          ...AGENT_CONFIG,
          model: modelRefForModel('custom_provider:work', 'model', modelConfig, {
            thinking: { effort: selectedEffort },
          }),
        },
      });

      expect(resolved.model.reasoning).toBe(expectedReasoning);
      expect(resolved.thinkingLevel).toBe(expectedLevel);
      expect(resolved.thinkingRequestPatch).toEqual({
        reasoning_effort: selectedEffort === 'high' ? 'high' : 'none',
      });
    },
  );
});

describe('LocalModelResolver custom-provider top thinking efforts', () => {
  it('passes standard thinking for a Messages provider without adaptive variants', async () => {
    const resolver = new LocalModelResolver({
      implicitCustomProviderThinking: true,
      byokConfigGetter: () => ({
        custom_provider: {
          work: {
            api: 'anthropic-messages',
            options: { apiKey: 'custom-user-key', baseURL: 'https://custom.example/v1' },
            models: { model: {} },
          },
        },
      }),
    });

    const resolved = await resolver.resolveModel({
      sessionId: 'session-custom-thinking',
      turnId: 'turn-custom-thinking',
      agentConfig: {
        ...AGENT_CONFIG,
        model: {
          provider: 'custom_provider:work',
          model_id: 'model',
          thinking_level: ThinkingLevel.MEDIUM,
        },
      },
    });

    expect(resolved.model.reasoning).toBe(true);
    expect(Reflect.get(resolved.model.compat ?? {}, 'forceAdaptiveThinking')).toBeUndefined();
    expect(resolved.thinkingLevel).toBe('medium');
  });

  it.each(['xhigh', 'max'] as const)(
    'publishes an identity thinking level map for Messages effort %s',
    async (selectedEffort) => {
      const modelConfig: LocalModelConfig = {
        reasoning: true,
        thinking: { effortOptions: ['xhigh', 'max'] },
      };
      const resolver = new LocalModelResolver({
        implicitCustomProviderThinking: true,
        byokConfigGetter: () => ({
          custom_provider: {
            work: {
              api: 'anthropic-messages',
              options: {
                apiKey: 'custom-user-key',
                baseURL: 'https://custom.example/v1',
              },
              models: {
                model: modelConfig,
              },
            },
          },
        }),
      });
      const capabilities: IModelCapabilities = {};
      Reflect.set(capabilities, OPENPLATFORM_THINKING_VARIANTS_CAPABILITY, {
        thinking: { type: 'adaptive' },
      });
      const model = modelRefForModel('custom_provider:work', 'model', modelConfig, {
        thinking: { effort: selectedEffort },
      });
      Object.assign(model.capabilities ?? {}, capabilities);

      const resolved = await resolver.resolveModel({
        sessionId: 'session-custom-top-thinking',
        turnId: 'turn-custom-top-thinking',
        agentConfig: {
          ...AGENT_CONFIG,
          model,
        },
      });

      expect(resolved.model.thinkingLevelMap).toEqual({
        [selectedEffort]: selectedEffort,
      });
      expect(resolved.thinkingLevel).toBe(selectedEffort);
    },
  );
});

describe('LocalModelResolver BYOK thinking', () => {
  it.each([
    ['anthropic-messages', { forceAdaptiveThinking: true }],
    ['openai-completions', { thinkingFormat: 'openai', supportsReasoningEffort: true }],
    ['openai-responses', undefined],
  ] as const)(
    'keeps the selected Think Effort when resolving a %s custom provider',
    async (api, expectedCompat) => {
      const resolver = new LocalModelResolver({
        byokConfigGetter: () => ({
          custom_provider: {
            work: {
              api,
              options: { apiKey: 'custom-user-key', baseURL: 'https://custom.example/v1' },
              models: {
                model: {
                  reasoning: true,
                  thinking: { effortOptions: ['low', 'light', 'max'] },
                },
              },
            },
          },
        }),
      });

      const resolved = await resolver.resolveModel({
        sessionId: 'session-effort',
        turnId: 'turn-effort',
        agentConfig: {
          ...AGENT_CONFIG,
          model: modelRefForModel(
            'custom_provider:work',
            'model',
            { reasoning: true, thinking: { effortOptions: ['low', 'light', 'max'] } },
            { thinking: { effort: 'light' } },
          ),
        },
      });

      expect(resolved.model).toMatchObject({
        api,
        reasoning: true,
        thinkingLevelMap: { high: 'light' },
      });
      expect(resolved.thinkingLevel).toBe('high');
      if (expectedCompat) expect(resolved.model.compat).toMatchObject(expectedCompat);
      else expect(resolved.model.compat).toBeUndefined();
    },
  );
});

describe('LocalModelResolver credentials and thinking', () => {
  it('uses OAuth credentials only for the openai-codex provider', async () => {
    const logicalCaps: Array<number | undefined> = [];
    const providerAuthGetter = vi.fn(async (provider: string) =>
      provider === 'openai-codex' ? 'codex-token' : undefined,
    );
    const logger = { info: vi.fn(), warn: vi.fn() };
    const resolver = new LocalModelResolver({
      providerAuthGetter,
      providerConfig: {
        'openai-codex': { options: { authMode: 'oauth' } },
      },
      streamFn: ((_model: unknown, _context: unknown, options?: { maxTokens?: number }) => {
        logicalCaps.push(options?.maxTokens);
        return {} as never;
      }) as never,
      logger,
    });

    const resolved = await resolver.resolveModel({
      sessionId: 'session-codex',
      turnId: 'turn-codex',
      agentConfig: {
        ...AGENT_CONFIG,
        model: {
          provider: 'openai-codex',
          model_id: 'gpt-5.5',
          context_window: 65_536,
          max_tokens: 32_768,
        },
      },
    });

    resolved.streamFn?.(
      resolved.model,
      { systemPrompt: 'a'.repeat(40_000), messages: [] },
      { maxTokens: 32_768 },
    );

    expect(providerAuthGetter).toHaveBeenCalledWith('openai-codex');
    expect(resolved).toMatchObject({
      apiKey: 'codex-token',
      model: {
        provider: 'openai-codex',
        id: 'gpt-5.5',
        api: 'openai-codex-responses',
        baseUrl: 'https://chatgpt.com/backend-api',
      },
    });
    expect(logger.info).toHaveBeenCalledWith(
      {
        provider: 'openai-codex',
        modelId: 'gpt-5.5',
        route: 'oauth',
      },
      'Resolved local conversation model route',
    );
    expect(logicalCaps).toEqual([23_488]);
  });

  it('fails closed when managed login has no synced access token', async () => {
    const resolver = new LocalModelResolver({
      providerConfig: {
        minimax: {
          options: {
            apiKey: 'sk-xxx',
            baseURL: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
          },
        },
      },
    });

    await expect(
      resolver.resolveModel({
        sessionId: 'session-managed',
        turnId: 'turn-managed',
        agentConfig: {
          ...AGENT_CONFIG,
          model: {
            provider: 'minimax',
            model_id: 'MiniMax-M2.7',
          },
        },
      }),
    ).rejects.toThrow('managed OAuth bearer is not synced');
  });

  it.each([
    [
      {
        options: {
          baseURL: 'https://provider.example/v1',
        },
      },
      'api_key not configured',
    ],
    [
      {
        options: {
          apiKey: 'provider-key',
        },
      },
      'base_url not configured',
    ],
    [
      {
        options: {
          authMode: 'managed-login' as const,
          apiKey: 'provider-key',
          baseURL: 'https://unknown-managed.example/v1',
        },
      },
      'managed-login requires a known managed base_url',
    ],
  ])('rejects unusable provider credentials %o', async (providerEntry, message) => {
    const resolver = new LocalModelResolver({
      providerConfig: {
        'provider-native': providerEntry,
      },
    });

    await expect(
      resolver.resolveModel({
        sessionId: 'session-credentials',
        turnId: 'turn-credentials',
        agentConfig: AGENT_CONFIG,
      }),
    ).rejects.toThrow(message);
  });

  it('passes adaptive thinking only when the model advertises variants', async () => {
    const capabilities: IModelCapabilities = {
      thinking_mode: ThinkingMode.SWITCHABLE,
    };
    Reflect.set(capabilities, OPENPLATFORM_THINKING_VARIANTS_CAPABILITY, {
      thinking: { type: 'adaptive' },
      'none-thinking': { type: 'disabled' },
    });
    const resolver = new LocalModelResolver({
      providerConfig: {
        minimax: {
          options: {
            apiKey: 'provider-key',
            baseURL: 'https://api.minimaxi.com/messages-api',
          },
        },
      },
    });

    const resolved = await resolver.resolveModel({
      sessionId: 'session-thinking',
      turnId: 'turn-thinking',
      agentConfig: {
        ...AGENT_CONFIG,
        model: {
          provider: 'minimax',
          model_id: 'MiniMax-M2.7',
          thinking_level: ThinkingLevel.MEDIUM,
          capabilities,
        },
      },
    });

    expect(resolved.model.reasoning).toBe(true);
    expect(Reflect.get(resolved.model.compat ?? {}, 'forceAdaptiveThinking')).toBe(true);
    expect(resolved.thinkingLevel).toBe('medium');
  });

  it.each([
    ['on', 'medium', true],
    ['off', undefined, false],
  ] as const)(
    'normalizes managed MiniMax M3 switch %s to a legal Pi thinking level',
    async (effort, expectedThinkingLevel, expectedReasoning) => {
      const modelConfig: LocalModelConfig = {
        reasoning: true,
        limit: { context: 512_000, output: 128_000 },
        thinking_config: { mode: 'switchable', default_value: 'true' },
        variants: {
          thinking: { thinking: { type: 'adaptive' } },
          'none-thinking': { thinking: { type: 'disabled' } },
        },
      };
      const resolver = new LocalModelResolver({
        providerConfig: {
          minimax: {
            options: {
              apiKey: 'provider-key',
              baseURL: 'https://api.minimaxi.com/messages-api',
            },
            models: { 'MiniMax-M3': modelConfig },
          },
        },
      });

      const resolved = await resolver.resolveModel({
        sessionId: 'session-m3-switch',
        turnId: 'turn-m3-switch',
        agentConfig: {
          ...AGENT_CONFIG,
          model: modelRefForModel('minimax', 'MiniMax-M3', modelConfig, {
            thinking: { effort },
          }),
        },
      });

      expect(resolved.thinkingLevel).toBe(expectedThinkingLevel);
      expect(resolved.model.reasoning).toBe(expectedReasoning);
      expect(resolved.thinkingRequestPatch).toBeUndefined();
    },
  );
});

describe('Codex OAuth discovered models', () => {
  it.each(['high', 'xhigh', 'max', 'ultra'])(
    'resolves an unregistered model with user limits and effort %s',
    async (effort) => {
      const providerAuthGetter = vi.fn(async () => 'codex-token');
      const modelConfig: LocalModelConfig = {
        name: 'GPT-6 Astra',
        limit: { context: 800_000, output: 60_000 },
        reasoning: true,
        thinking: { effortOptions: ['low', 'high', 'xhigh', 'max', 'ultra'] },
        modalities: { input: ['text', 'image'], output: ['text'] },
      };
      const resolver = new LocalModelResolver({
        providerAuthGetter,
        byokConfigGetter: () => ({
          custom_provider: {
            'openai-codex': {
              api: 'openai-codex-responses',
              kind: 'oauth',
              options: { authMode: 'oauth', baseURL: 'https://chatgpt.com/backend-api' },
              models: { 'gpt-6-astra': modelConfig },
            },
          },
        }),
      });
      const resolved = await resolver.resolveModel({
        sessionId: 'discovery-session',
        turnId: 'discovery-turn',
        agentConfig: {
          ...AGENT_CONFIG,
          model: modelRefForModel('custom_provider:openai-codex', 'gpt-6-astra', modelConfig, {
            thinking: { effort },
          }),
        },
      });
      expect(providerAuthGetter).toHaveBeenCalledWith('openai-codex');
      expect(resolved).toMatchObject({
        apiKey: 'codex-token',
        thinkingRequestPatch: { reasoning: { effort } },
        model: {
          id: 'gpt-6-astra',
          api: 'openai-codex-responses',
          contextWindow: 800_000,
          maxTokens: 60_000,
        },
      });
    },
  );
});

describe('OpenCode Go conversation identity', () => {
  it.each([
    ['openai-completions', 'https://opencode.ai/zen/go/v1'],
    ['openai-responses', 'https://opencode.ai/zen/go/v1'],
    ['anthropic-messages', 'https://opencode.ai/zen/go/v1'],
    ['openai-completions', 'https://opencode.ai/inference/go/openai/v1'],
    ['anthropic-messages', 'https://opencode.ai/inference/go/openai/v1'],
  ] as const)(
    'keeps session identity across turns for renamed %s providers at %s',
    async (api, baseURL) => {
      const resolver = new LocalModelResolver({
        byokConfigGetter: () => ({
          custom_provider: {
            renamed: {
              api,
              options: {
                apiKey: 'offline-test-key',
                baseURL,
                headers: { 'USER-AGENT': 'generic-sdk' },
              },
              models: { 'test-model': { headers: { 'X-OpenCode-Session': 'static-id' } } },
            },
          },
        }),
      });
      for (const [sessionId, turnId] of [
        ['session-a', 'turn-1'],
        ['session-a', 'turn-2'],
        ['session-b', 'turn-1'],
      ] as const) {
        const resolved = await resolver.resolveModel({
          sessionId,
          turnId,
          agentConfig: {
            system_prompt: 'system',
            tools: [],
            skills: [],
            model: { provider: 'custom_provider:renamed', model_id: 'test-model' },
          },
        });
        const headers = new Headers(resolved.headers);
        expect(headers.get('x-opencode-session')).toBe(sessionId);
        expect(headers.get('user-agent')).toBe('MiniMaxCode');
        expect(resolved.model.provider).toBe('custom_provider:renamed');
      }
    },
  );
});

describe('LocalModelResolver custom provider compat overrides', () => {
  const resolveWithCompat = async (
    compat: LocalModelConfig['compat'],
    modelConfig: LocalModelConfig = {},
  ) => {
    const resolver = new LocalModelResolver({
      byokConfigGetter: () => ({
        custom_provider: {
          gateway: {
            api: 'openai-completions',
            options: { apiKey: 'gateway-key', baseURL: 'https://gateway.example/v1' },
            models: { 'kimi-k2-thinking': { ...modelConfig, compat } },
          },
        },
      }),
    });
    return resolver.resolveModel({
      sessionId: 'session-compat',
      turnId: 'turn-compat',
      agentConfig: {
        ...AGENT_CONFIG,
        model: { provider: 'custom_provider:gateway', model_id: 'kimi-k2-thinking' },
      },
    });
  };

  it('forwards the declared upstream protocol surface to the executor model', async () => {
    const resolved = await resolveWithCompat({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'deepseek',
    });

    expect(resolved.model.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'deepseek',
    });
  });

  it('lets a declared override win over the thinking-derived compat', async () => {
    const modelConfig: LocalModelConfig = {
      reasoning: true,
      thinking: { effortOptions: ['low', 'light', 'max'] },
    };
    const resolver = new LocalModelResolver({
      byokConfigGetter: () => ({
        custom_provider: {
          gateway: {
            api: 'openai-completions',
            options: { apiKey: 'gateway-key', baseURL: 'https://gateway.example/v1' },
            models: {
              'kimi-k2-thinking': {
                ...modelConfig,
                compat: { supportsReasoningEffort: false, thinkingFormat: 'deepseek' },
              },
            },
          },
        },
      }),
    });

    const resolved = await resolver.resolveModel({
      sessionId: 'session-compat-thinking',
      turnId: 'turn-compat-thinking',
      agentConfig: {
        ...AGENT_CONFIG,
        model: modelRefForModel('custom_provider:gateway', 'kimi-k2-thinking', modelConfig, {
          thinking: { effort: 'light' },
        }),
      },
    });

    expect(resolved.model.reasoning).toBe(true);
    expect(resolved.model.compat).toMatchObject({
      supportsReasoningEffort: false,
      thinkingFormat: 'deepseek',
    });
  });

  it('leaves compat untouched when the provider declares none', async () => {
    const resolved = await resolveWithCompat(undefined);

    expect(resolved.model.compat).toBeUndefined();
  });
});

describe('LocalModelResolver instruction roles', () => {
  // The incident was a wire-level symptom: pi chooses the system prompt role from the
  // resolved compat, so these cases pin the request pi would actually send.
  const reasoningModelConfig: LocalModelConfig = {
    reasoning: true,
    thinking: { effortOptions: ['low', 'light', 'max'] },
  };

  const systemPromptRoleFor = async (
    compat: LocalModelConfig['compat'],
    baseURL = 'https://gateway.example/v1',
  ) => {
    const resolver = new LocalModelResolver({
      byokConfigGetter: () => ({
        custom_provider: {
          gateway: {
            api: 'openai-completions',
            options: { apiKey: 'gateway-key', baseURL },
            models: { 'kimi-k2-thinking': { ...reasoningModelConfig, compat } },
          },
        },
      }),
    });
    const resolved = await resolver.resolveModel({
      sessionId: 'session-compat-wire',
      turnId: 'turn-compat-wire',
      agentConfig: {
        ...AGENT_CONFIG,
        model: modelRefForModel(
          'custom_provider:gateway',
          'kimi-k2-thinking',
          reasoningModelConfig,
          { thinking: { effort: 'light' } },
        ),
      },
    });
    expect(resolved.model.reasoning).toBe(true);

    let payload: unknown;
    await streamSimple(
      resolved.model,
      {
        systemPrompt: 'Follow instructions.',
        messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
      },
      {
        apiKey: 'gateway-key',
        onPayload: (params: unknown) => {
          payload = params;
        },
        // The payload is captured before transport, so the request never leaves the test.
        fetch: (() => Promise.reject(new Error('offline'))) as typeof globalThis.fetch,
      },
    ).result();
    return (payload as { messages?: Array<{ role?: string }> }).messages?.[0]?.role;
  };

  it('sends the system prompt as `system` once the upstream refuses the developer role', async () => {
    expect(await systemPromptRoleFor({ supportsDeveloperRole: false })).toBe('system');
  });

  it('still sends `developer` when the gateway declares nothing, reproducing the incident', async () => {
    expect(await systemPromptRoleFor(undefined)).toBe('developer');
  });

  it('keeps the system role for a thinking model on the Mistral API', async () => {
    expect(await systemPromptRoleFor(undefined, 'https://api.mistral.ai/v1')).toBe('system');
  });

  it.each([
    'https://api.siliconflow.cn/v1',
    'https://api.siliconflow.com/v1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
    'https://coding.dashscope.aliyuncs.com/v1',
    'https://coding-intl.dashscope.aliyuncs.com/v1',
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    'https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'https://example-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'https://example-workspace.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1',
    'https://example-workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    'https://example-workspace.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1',
    'https://example-workspace.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
    'https://example-workspace.us-east-1.maas.aliyuncs.com/compatible-mode/v1',
    'https://api.kimi.com/coding/v1',
    'https://api.kimi.ai/coding/v1',
  ])('keeps the system role for a thinking model at %s', async (baseURL) => {
    expect(await systemPromptRoleFor(undefined, baseURL)).toBe('system');
  });

  it.each([
    ['https://api.openai.com/v1', 'developer'],
    ['https://api.deepseek.com/v1', 'system'],
    ['https://api.mistral.ai.example/v1', 'developer'],
    ['https://gateway.example/api.mistral.ai/v1', 'developer'],
    ['https://api.siliconflow.cn.example/v1', 'developer'],
    ['https://gateway.example/api.siliconflow.cn/v1', 'developer'],
    ['https://api.siliconflow.com.example/v1', 'developer'],
    ['https://gateway.example/api.siliconflow.com/v1', 'developer'],
    ['https://api.moonshot.cn/v1', 'system'],
    ['https://api.moonshot.ai/v1', 'system'],
    ['https://dashscope.aliyuncs.com.example/v1', 'developer'],
    ['https://gateway.example/dashscope.aliyuncs.com/v1', 'developer'],
    ['https://coding.dashscope.aliyuncs.com.example/v1', 'developer'],
    ['https://token-plan.cn-beijing.maas.aliyuncs.com.example/v1', 'developer'],
    ['https://gateway.example/token-plan.cn-beijing.maas.aliyuncs.com/v1', 'developer'],
    ['https://example-workspace.unknown-region.maas.aliyuncs.com/v1', 'developer'],
    ['https://example-workspace.cn-beijing.aliyuncs.com/v1', 'developer'],
    ['https://api.kimi.com.example/v1', 'developer'],
    ['https://gateway.example/api.kimi.com/coding/v1', 'developer'],
  ])('preserves the system prompt role for %s', async (baseURL, role) => {
    expect(await systemPromptRoleFor(undefined, baseURL)).toBe(role);
  });

  it('honors an explicit developer-role override on the Mistral API', async () => {
    expect(
      await systemPromptRoleFor({ supportsDeveloperRole: true }, 'https://api.mistral.ai/v1'),
    ).toBe('developer');
  });

  it.each([
    'https://api.siliconflow.cn/v1',
    'https://api.siliconflow.com/v1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://coding.dashscope.aliyuncs.com/v1',
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'https://example-workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  ])('honors an explicit developer-role override on %s', async (baseURL) => {
    expect(await systemPromptRoleFor({ supportsDeveloperRole: true }, baseURL)).toBe('developer');
  });

  it('honors an explicit developer-role override on a Kimi Coding endpoint', async () => {
    expect(
      await systemPromptRoleFor({ supportsDeveloperRole: true }, 'https://api.kimi.com/coding/v1'),
    ).toBe('developer');
  });
});

// A relay keyed on session identity only sees it when the provider entry opts in, so these
// cases pin the wire-level request for a protocol-compatible custom provider.
describe('LocalModelResolver custom provider session affinity', () => {
  const readHeaders = (source: unknown): Record<string, string> => {
    if (!source) return {};
    const entries: Array<[string, unknown]> = [];
    if (typeof Headers !== 'undefined' && source instanceof Headers) {
      source.forEach((value, key) => entries.push([key, value]));
    } else {
      entries.push(...Object.entries(source as Record<string, unknown>));
    }
    return Object.fromEntries(
      entries.flatMap(([key, value]) =>
        typeof value === 'string' ? [[key.toLowerCase(), value]] : [],
      ),
    );
  };

  const requestFor = async (compat: LocalModelConfig['compat'], cacheRetention?: 'none') => {
    const modelConfig: LocalModelConfig = compat ? { compat } : {};
    const resolver = new LocalModelResolver({
      byokConfigGetter: () => ({
        custom_provider: {
          relay: {
            api: 'anthropic-messages',
            options: { apiKey: 'relay-key', baseURL: 'https://relay.example' },
            models: { 'MiniMax-M2': modelConfig },
          },
        },
      }),
    });
    const resolved = await resolver.resolveModel({
      sessionId: 'session-affinity-wire',
      turnId: 'turn-affinity-wire',
      agentConfig: {
        ...AGENT_CONFIG,
        model: modelRefForModel('custom_provider:relay', 'MiniMax-M2', modelConfig),
      },
    });

    let headers: Record<string, string> = {};
    let payload: unknown;
    await streamSimple(
      resolved.model,
      {
        systemPrompt: 'Follow instructions.',
        messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
      },
      {
        apiKey: 'relay-key',
        sessionId: 'session-affinity-wire',
        ...(cacheRetention ? { cacheRetention } : {}),
        onPayload: (params: unknown) => {
          payload = params;
        },
        // Headers are captured before transport, so the request never leaves the test.
        fetch: ((_url: unknown, init?: { headers?: unknown }) => {
          headers = readHeaders(init?.headers);
          return Promise.reject(new Error('offline'));
        }) as unknown as typeof globalThis.fetch,
      },
    ).result();
    return { headers, payload: payload as { metadata?: { user_id?: string } } };
  };

  it('omits session identity when the provider entry declares no compat', async () => {
    const { headers, payload } = await requestFor(undefined);

    expect(headers['x-session-affinity']).toBeUndefined();
    expect(payload.metadata).toBeUndefined();
  });

  it('sends x-session-affinity once the provider entry opts in', async () => {
    const { headers, payload } = await requestFor({ sendSessionAffinityHeaders: true });

    expect(headers['x-session-affinity']).toBe('session-affinity-wire');
    // The session id stays out of `metadata.user_id`, which is an attribution field.
    expect(payload.metadata).toBeUndefined();
  });

  it('withholds the header when the turn runs without prompt caching', async () => {
    const { headers } = await requestFor({ sendSessionAffinityHeaders: true }, 'none');

    expect(headers['x-session-affinity']).toBeUndefined();
  });
});

describe('LocalModelResolver request image ceiling (#425)', () => {
  const resolveModelWith = async (
    modelConfig: LocalModelConfig,
    baseURL = 'https://gateway.example/v1',
    { api = 'openai-completions', modelId = 'vision' } = {},
  ) => {
    const resolver = new LocalModelResolver({
      byokConfigGetter: () => ({
        custom_provider: {
          gateway: {
            api,
            options: { apiKey: 'gateway-key', baseURL },
            models: { [modelId]: modelConfig },
          },
        },
      }),
    });
    return resolver.resolveModel({
      sessionId: 'session-image-ceiling',
      turnId: 'turn-image-ceiling',
      agentConfig: {
        ...AGENT_CONFIG,
        model: modelRefForModel('custom_provider:gateway', modelId, modelConfig),
      },
    });
  };
  const resolveWith = async (
    modelConfig: LocalModelConfig,
    baseURL?: string,
    options?: { readonly modelId?: string },
  ) =>
    (
      (await resolveModelWith(modelConfig, baseURL, options)).model as {
        maxImagesPerRequest?: number;
      }
    ).maxImagesPerRequest;

  it('carries separate image and video support from capabilities onto the executor model', async () => {
    const media = async (capabilities: LocalModelConfig['capabilities']) => {
      const { model } = await resolveModelWith({ capabilities });
      return {
        input: model.input,
        supportsImageInput: 'supportsImageInput' in model ? model.supportsImageInput : undefined,
        supportsVideoInput: 'supportsVideoInput' in model ? model.supportsVideoInput : undefined,
      };
    };

    expect(await media({ support_image: true })).toEqual({
      input: ['text', 'image'],
      supportsImageInput: true,
      supportsVideoInput: false,
    });
    // Video still travels as pi-ai image blocks, so a video-only model keeps
    // the `image` modality and relies on the flags to drop still images.
    expect(await media({ support_video: true })).toEqual({
      input: ['text', 'image'],
      supportsImageInput: false,
      supportsVideoInput: true,
    });
    expect(await media({ support_image: true, support_video: true })).toEqual({
      input: ['text', 'image'],
      supportsImageInput: true,
      supportsVideoInput: true,
    });
    expect(await media({})).toEqual({
      input: ['text'],
      supportsImageInput: false,
      supportsVideoInput: false,
    });
  });

  it('lets a configured thinking_prefix_binding override the model-id inference', async () => {
    const family = '\x63\x6c\x61\x75\x64\x65';
    const bound = async (modelId: string, capabilities: LocalModelConfig['capabilities']) =>
      hasThinkingPrefixBinding(
        (await resolveModelWith({ capabilities }, undefined, { modelId })).model,
      );

    expect(await bound('gateway-model', {})).toBe(false);
    expect(await bound('gateway-model', { thinking_prefix_binding: true })).toBe(true);
    expect(await bound(`${family}-5-5`, {})).toBe(true);
    expect(await bound(`${family}-4`, { thinking_prefix_binding: false })).toBe(false);
  });

  it('carries a configured max_images_per_request onto the executor model', async () => {
    expect(
      await resolveWith({ capabilities: { support_image: true, max_images_per_request: 6 } }),
    ).toBe(6);
    expect(
      await resolveWith({ capabilities: { support_image: true, max_images_per_request: '12' } }),
    ).toBe(12);
  });

  it('allows 100 images when nothing valid is declared, and 20 for MiniMax M3 models', async () => {
    expect(await resolveWith({ capabilities: { support_image: true } })).toBe(100);
    expect(
      await resolveWith({ capabilities: { support_image: true, max_images_per_request: 0 } }),
    ).toBe(100);
    expect(
      await resolveWith({ capabilities: { support_image: true } }, undefined, {
        modelId: 'MiniMax-M3',
      }),
    ).toBe(20);
    expect(
      await resolveWith({ capabilities: { support_image: true } }, undefined, {
        modelId: 'MiniMax-M3.1-Flash',
      }),
    ).toBe(20);
    expect(
      await resolveWith({ capabilities: { support_image: true } }, undefined, {
        modelId: 'MiniMax-M30',
      }),
    ).toBe(100);
  });

  it('budgets the request body of known first-party hosts unless the model declares one', async () => {
    const bodyBytes = async (
      baseURL: string,
      api: string,
      capabilities: LocalModelConfig['capabilities'] = { support_image: true },
    ) => (await resolveModelWith({ capabilities }, baseURL, { api })).maxRequestBodyBytes;
    const mib = 1_024 * 1_024;

    expect(await bodyBytes('https://gateway.example/v1', 'anthropic-messages')).toBe(64 * mib);
    expect(await bodyBytes('https://api.anthropic.com', 'anthropic-messages')).toBe(28 * mib);
    expect(
      await bodyBytes('https://us-east5-aiplatform.googleapis.com/v1', 'anthropic-messages'),
    ).toBe(26 * mib);
    expect(await bodyBytes('https://api.openai.com/v1', 'openai-responses')).toBe(64 * mib);
    expect(
      await bodyBytes('https://api.anthropic.com', 'anthropic-messages', {
        support_image: true,
        max_request_body_bytes: 10 * mib,
      }),
    ).toBe(10 * mib);
  });

  it('applies the documented Mistral API limit by exact host unless the model overrides it', async () => {
    expect(
      await resolveWith({ capabilities: { support_image: true } }, 'https://api.mistral.ai/v1'),
    ).toBe(8);
    expect(
      await resolveWith(
        { capabilities: { support_image: true, max_images_per_request: 4 } },
        'https://api.mistral.ai/v1',
      ),
    ).toBe(4);
    expect(
      await resolveWith(
        { capabilities: { support_image: true } },
        'https://gateway.example/api.mistral.ai/v1',
      ),
    ).toBe(100);
  });
});

describe('LocalModelResolver call route', () => {
  const managedMiniMax: LocalModelsConfig = {
    minimax: {
      options: {
        authMode: 'managed-login',
        apiKey: 'sk-xxx',
        baseURL: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
      },
      models: { 'MiniMax-M3': { limit: { context: 512_000, output: 128_000 } } },
    },
    'provider-native': {
      options: { apiKey: 'secret-native', baseURL: 'https://provider.example/v1' },
    },
  };
  const userMiniMaxKey = { apiKey: 'user-key', baseURL: 'https://api.minimaxi.com/messages-api' };

  function resolveWith(
    model: { readonly provider: string; readonly model_id: string },
    byok?: LocalByokProviderConfig,
  ) {
    return new LocalModelResolver({
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-managed' }),
      providerConfig: managedMiniMax,
      ...(byok ? { byokConfigGetter: () => byok } : {}),
    }).resolveModel({
      sessionId: 'session-route',
      turnId: 'turn-route',
      agentConfig: { ...AGENT_CONFIG, model },
    });
  }

  it('reports the managed Token Plan for the builtin MiniMax entry under managed login', async () => {
    await expect(
      resolveWith({ provider: 'minimax', model_id: 'MiniMax-M3' }),
    ).resolves.toMatchObject({ managedProvider: true, route: 'managed_token_plan' });
  });

  it('reports the user key when the builtin MiniMax entry is switched to minimax_api_key', async () => {
    await expect(
      resolveWith(
        { provider: 'minimax', model_id: 'MiniMax-M3' },
        { minimaxModelSource: 'minimax_api_key', minimax_api: userMiniMaxKey },
      ),
    ).resolves.toMatchObject({
      managedProvider: false,
      apiKey: 'user-key',
      route: 'minimax_api_key',
    });
  });

  it.each([
    [
      'the MiniMax API key provider',
      { provider: 'minimax_api', model_id: 'MiniMax-M3' },
      { minimax_api: userMiniMaxKey },
      'minimax_api_key',
    ],
    [
      'a custom provider',
      { provider: 'custom_provider:work', model_id: 'org/model-v1' },
      {
        custom_provider: {
          work: {
            api: 'openai-completions',
            options: { apiKey: 'custom-key', baseURL: 'https://custom.example/v1' },
            models: { 'org/model-v1': {} },
          },
        },
      },
      'custom_provider',
    ],
    [
      'another configured provider',
      { provider: 'provider-native', model_id: 'model-native' },
      undefined,
      'configured_provider',
    ],
  ] as const)('reports %s', async (_name, model, byok, route) => {
    const resolved = await resolveWith(model, byok as LocalByokProviderConfig | undefined);
    expect(resolved.managedProvider).toBe(false);
    expect(resolved.route).toBe(route);
  });

  it('names the turn phase header for managed Token Plan requests only', async () => {
    await expect(
      resolveWith({ provider: 'minimax', model_id: 'MiniMax-M3' }),
    ).resolves.toMatchObject({ turnPhaseHeader: 'X-Mavis-Turn-Phase' });
    const unmanaged = await Promise.all([
      resolveWith(
        { provider: 'minimax', model_id: 'MiniMax-M3' },
        { minimaxModelSource: 'minimax_api_key', minimax_api: userMiniMaxKey },
      ),
      resolveWith(
        { provider: 'minimax_api', model_id: 'MiniMax-M3' },
        { minimax_api: userMiniMaxKey },
      ),
      resolveWith({ provider: 'provider-native', model_id: 'model-native' }),
    ]);
    for (const resolved of unmanaged) {
      expect(resolved).not.toHaveProperty('turnPhaseHeader');
      expect(Object.keys(resolved.headers ?? {})).not.toContain('X-Mavis-Turn-Phase');
    }
  });
});
