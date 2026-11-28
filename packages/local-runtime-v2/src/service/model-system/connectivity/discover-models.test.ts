import { describe, expect, it, vi } from 'vitest';

import { ModelDiscoveryClient } from './discover-models.js';

describe('ModelDiscoveryClient', () => {
  it('discovers models with the same normalized base and custom headers', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'gpt-5.2', name: 'GPT 5.2' }, { id: 'gpt-5.3' }] }),
          { status: 200 },
        ),
    );
    const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    const result = await client.discover({
      api: 'openai-responses',
      baseUrl: 'https://api.example.com/v1/responses',
      apiKey: 'sk-secret',
      headers: {
        authorization: 'Api-Key custom',
        'X-API-Key': 'provider-specific-key',
        'X-Tenant': 'tenant-a',
      },
    });

    expect(result).toEqual({
      ok: true,
      models: [{ modelId: 'gpt-5.2', displayName: 'GPT 5.2' }, { modelId: 'gpt-5.3' }],
    });
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe('https://api.example.com/v1/models');
    const headers = new Headers(calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Api-Key custom');
    expect(headers.get('x-api-key')).toBe('provider-specific-key');
    expect(headers.get('x-tenant')).toBe('tenant-a');
  });

  it.each(['anthropic-messages', 'openai-completions', 'openai-responses'] as const)(
    'sends both common API key headers when discovering %s models',
    async (api) => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
      const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

      await client.discover({ api, baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret' });

      const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
      const headers = new Headers(calls[0]?.[1]?.headers);
      expect(headers.get('authorization')).toBe('Bearer sk-secret');
      expect(headers.get('x-api-key')).toBe('sk-secret');
    },
  );

  it('attributes OpenRouter model discovery to MiniMax Code', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    await client.discover({
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-secret',
    });

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const headers = new Headers(calls[0]?.[1]?.headers);
    expect(headers.get('http-referer')).toBe('https://agent.minimax.io/');
    expect(headers.get('x-openrouter-title')).toBe('MiniMax Code');
    expect(headers.get('x-openrouter-categories')).toBe('cli-agent');
  });

  it.each([401, 403])('sanitizes an HTTP %i authentication failure', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('secret upstream body', { status }));
    const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);
    const result = await client.discover({
      api: 'openai-completions',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-secret',
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'unauthorized' });
    expect(JSON.stringify(result)).not.toContain('secret upstream body');
    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });

  it('reports non-authentication HTTP failures', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream body', { status: 503 }));
    const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.discover({
        api: 'anthropic-messages',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-secret',
      }),
    ).resolves.toEqual({ ok: false, errorCode: 'http_503', errorMessage: 'HTTP 503' });
  });

  it.each(['null', '[]', '{}', '{"data":"models"}', 'not-json'])(
    'rejects an invalid discovery payload %s',
    async (body) => {
      const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
      const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

      await expect(
        client.discover({
          api: 'openai-completions',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-secret',
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'invalid_response' });
    },
  );

  it('filters malformed models and prefers display_name', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [null, [], {}, { id: '  ' }, { id: 'model-1', display_name: 'Model One' }],
          }),
          { status: 200 },
        ),
    );
    const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.discover({
        api: 'openai-completions',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-secret',
      }),
    ).resolves.toEqual({
      ok: true,
      models: [{ modelId: 'model-1', displayName: 'Model One' }],
    });
  });

  it('distinguishes aborts from network failures', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const abortingJson = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => Promise.reject(abortError),
        }) as unknown as Response,
    );
    const timedOut = new ModelDiscoveryClient(abortingJson as unknown as typeof fetch, 25);
    await expect(
      timedOut.discover({
        api: 'openai-completions',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-secret',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'timeout',
      errorMessage: 'Request timed out after 25ms',
    });

    const failingFetch = vi.fn(async () => Promise.reject(new Error('socket closed')));
    const failed = new ModelDiscoveryClient(failingFetch as unknown as typeof fetch);
    await expect(
      failed.discover({
        api: 'openai-completions',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-secret',
      }),
    ).resolves.toEqual({ ok: false, errorCode: 'network', errorMessage: 'Network error' });
  });
});

describe('ModelDiscoveryClient Gemini models.list', () => {
  it('lists every Gemini generateContent model across pages with only the Gemini key header', async () => {
    const pages = [
      {
        models: [
          {
            name: 'models/gemini-3.5-flash',
            displayName: 'Gemini 3.5 Flash',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
        ],
        nextPageToken: 'page-2',
      },
      {
        models: [
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
        ],
      },
    ];
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(pages.shift()), { status: 200 }),
    );
    const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    const result = await client.discover({
      api: 'google-generative-ai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
      apiKey: 'gemini-key',
    });

    expect(result).toEqual({
      ok: true,
      models: [
        { modelId: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' },
        { modelId: 'gemini-2.5-pro' },
      ],
    });
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=page-2',
    ]);
    const headers = new Headers(calls[0]?.[1]?.headers);
    expect(headers.get('x-goog-api-key')).toBe('gemini-key');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-api-key')).toBe(false);
  });

  it('reports a Gemini page failure instead of a partial model list', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ models: [{ name: 'models/gemini-3.5-flash' }], nextPageToken: 'next' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('busy', { status: 429 }));
    const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.discover({
        api: 'google-generative-ai',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gemini-key',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'http_429' });
  });

  it('accepts an OpenAI-shaped { data: [...] } list from a Gemini-compatible gateway', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }],
          }),
          { status: 200 },
        ),
    );
    const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.discover({
        api: 'google-generative-ai',
        baseUrl: 'https://gateway.example.com/v1',
        apiKey: 'gemini-key',
      }),
    ).resolves.toEqual({
      ok: true,
      models: [{ modelId: 'gemini-4-carbon', displayName: 'Gemini 4 Carbon' }],
    });
  });
});

describe('ModelDiscoveryClient Messages endpoint fallback', () => {
  it('falls back to the OpenAI-style models endpoint when Messages discovery is missing', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === 'https://api.example.com/models'
        ? new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }), { status: 200 })
        : new Response('not found', { status: 404 }),
    );
    const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    const result = await client.discover({
      api: 'anthropic-messages',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-secret',
    });

    expect(result).toEqual({ ok: true, models: [{ modelId: 'deepseek-v4-pro' }] });
    expect(discoveredUrls(fetchImpl)).toEqual([
      'https://api.example.com/v1/models',
      'https://api.example.com/models',
    ]);
  });

  it('falls back to the origin models endpoint when Messages is mounted under a subpath', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === 'https://api.example.com/models'
        ? new Response(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' }],
            }),
            { status: 200 },
          )
        : new Response('not found', { status: 404 }),
    );
    const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    const result = await client.discover({
      api: 'anthropic-messages',
      baseUrl: 'https://api.example.com/compat',
      apiKey: 'sk-secret',
    });

    expect(result).toEqual({ ok: true, models: [{ modelId: 'deepseek-v4-pro' }] });
    expect(discoveredUrls(fetchImpl)).toEqual([
      'https://api.example.com/compat/v1/models',
      'https://api.example.com/compat/models',
      'https://api.example.com/models',
    ]);
  });

  it.each([404, 405])(
    'reports a missing model list endpoint when every candidate answers HTTP %i',
    async (status) => {
      const fetchImpl = vi.fn(async () => new Response('not found', { status }));
      const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

      await expect(
        client.discover({
          api: 'anthropic-messages',
          baseUrl: 'https://api.example.com/compat',
          apiKey: 'sk-secret',
        }),
      ).resolves.toEqual({
        ok: false,
        errorCode: 'models_endpoint_missing',
        errorMessage: 'Model list endpoint not found',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    },
  );

  it('does not fall back when the Messages credentials are rejected', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 401 }));
    const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.discover({
        api: 'anthropic-messages',
        baseUrl: 'https://api.example.com/compat',
        apiKey: 'sk-secret',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'unauthorized' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('skips the origin fallback when the base URL cannot be parsed', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    const client = new ModelDiscoveryClient(fetchImpl as unknown as typeof fetch);

    await expect(
      client.discover({
        api: 'anthropic-messages',
        baseUrl: 'api.example.com/compat',
        apiKey: 'sk-secret',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'models_endpoint_missing',
      errorMessage: 'Model list endpoint not found',
    });
    expect(discoveredUrls(fetchImpl)).toEqual([
      'api.example.com/compat/v1/models',
      'api.example.com/compat/models',
    ]);
  });
});

function discoveredUrls(fetchImpl: unknown): string[] {
  const calls = (fetchImpl as { mock: { calls: unknown } }).mock.calls;
  return (calls as Array<[string, RequestInit]>).map(([url]) => url);
}
