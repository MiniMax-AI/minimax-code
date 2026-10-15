import { describe, expect, it, vi } from 'vitest';

import { ModelConnectionTester } from './test-connection.js';

const API_KEY = 'test-key';
const MESSAGES_API = 'anthropic-messages';
const MESSAGES_PATH = MESSAGES_API.split('-')[0];
const MESSAGES_VERSION_HEADER = MESSAGES_API.replace('-messages', '-version');
const GLOBAL_MINIMAX_MESSAGES_URL = `https://api.minimax.io/${MESSAGES_PATH}`;
const CN_MINIMAX_MESSAGES_URL = `https://api.minimaxi.com/${MESSAGES_PATH}`;

function messagesOkResponse(): Response {
  return new Response(
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'p' }],
    }),
    { status: 200 },
  );
}

function openAiOkResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl_test',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'p' },
          finish_reason: 'length',
        },
      ],
    }),
    { status: 200 },
  );
}

function openAiResponsesOkResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'resp_test',
      object: 'response',
      status: 'completed',
      output: [],
    }),
    { status: 200 },
  );
}

describe('ModelConnectionTester requests', () => {
  it('sends a Messages-compatible completion with the default output limit', async () => {
    const fetchImpl = vi.fn(async () => messagesOkResponse());
    const tester = new ModelConnectionTester({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await tester.test('p1', {
      api: 'anthropic-messages',
      baseUrl: `${GLOBAL_MINIMAX_MESSAGES_URL}/`,
      apiKey: API_KEY,
      modelId: 'MiniMax-M3',
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GLOBAL_MINIMAX_MESSAGES_URL}/v1/messages`);
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('x-api-key')).toBe(API_KEY);
    expect(headers.get(MESSAGES_VERSION_HEADER)).toBe('2023-06-01');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(16_384);
    expect(body.model).toBe('MiniMax-M3');
    expect(body.stream).toBe(false);
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('reuses a Messages-compatible base that already ends in /v1', async () => {
    const fetchImpl = vi.fn(async () => messagesOkResponse());
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await tester.test('p-v1', {
      api: 'anthropic-messages',
      baseUrl: 'https://api.example.com/v1',
      apiKey: API_KEY,
      modelId: 'm',
    });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.example.com/v1/messages');
  });

  it('sends openai-completions to <base>/chat/completions with bearer auth', async () => {
    const fetchImpl = vi.fn(async () => openAiOkResponse());
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await tester.test('p2', {
      api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: API_KEY,
      modelId: 'gpt-4.1',
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(16_384);
    expect(body.stream).toBe(false);
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
  });

  it('attributes OpenRouter completion tests to MiniMax Code', async () => {
    const fetchImpl = vi.fn(async () => openAiOkResponse());
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await tester.test('openrouter-attribution', {
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: API_KEY,
      modelId: 'openai/gpt-5.2',
      headers: {
        'http-referer': 'https://spoofed.example',
        'x-openrouter-title': 'Spoofed App',
      },
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('http-referer')).toBe('https://agent.minimax.io/');
    expect(headers.get('x-openrouter-title')).toBe('MiniMax Code');
    expect(headers.get('x-openrouter-categories')).toBe('cli-agent');
  });

  it('sends openai-responses to <base>/responses and validates a Responses payload', async () => {
    const fetchImpl = vi.fn(async () => openAiResponsesOkResponse());
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await tester.test('responses', {
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: API_KEY,
      modelId: 'gpt-5.2',
    });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.input).toBe('ping');
    expect(body.max_output_tokens).toBe(16_384);
    expect(body.stream).toBe(false);
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
  });

  it.each([
    [
      'anthropic-messages',
      messagesOkResponse,
      {
        model: 'm',
        max_tokens: 16_384,
        stream: false,
        messages: [{ role: 'user', content: 'ping' }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'light' },
      },
    ],
    [
      'openai-completions',
      openAiOkResponse,
      {
        model: 'm',
        max_tokens: 16_384,
        stream: false,
        messages: [{ role: 'user', content: 'ping' }],
        reasoning_effort: 'light',
      },
    ],
    [
      'openai-responses',
      openAiResponsesOkResponse,
      {
        model: 'm',
        input: 'ping',
        max_output_tokens: 16_384,
        stream: false,
        reasoning: { effort: 'light' },
      },
    ],
  ] as const)('keeps a custom effort in the exact %s payload', async (api, response, expected) => {
    const fetchImpl = vi.fn(async () => response());
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      tester.test(`light-${api}`, {
        api,
        baseUrl: 'https://api.example.com/v1',
        apiKey: API_KEY,
        modelId: 'm',
        effort: 'light',
      }),
    ).resolves.toEqual({ ok: true });

    const init = (fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual(expected);
  });

  it.each([
    ['anthropic-messages', 'on', messagesOkResponse, { thinking: { type: 'adaptive' } }],
    ['anthropic-messages', 'off', messagesOkResponse, { thinking: { type: 'disabled' } }],
    ['openai-completions', 'on', openAiOkResponse, { thinking: { type: 'adaptive' } }],
    ['openai-completions', 'off', openAiOkResponse, { thinking: { type: 'disabled' } }],
    ['openai-responses', 'on', openAiResponsesOkResponse, { reasoning: { effort: 'minimal' } }],
    ['openai-responses', 'off', openAiResponsesOkResponse, { reasoning: { effort: 'none' } }],
  ] as const)(
    'sends MiniMax M3 %s Think Effort %s with the protocol-specific field',
    async (api, effort, response, expectedPatch) => {
      const fetchImpl = vi.fn(async () => response());
      const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

      await expect(
        tester.test(`minimax-m3-${api}-${effort}`, {
          api,
          baseUrl: 'https://api.example.com/v1',
          apiKey: API_KEY,
          modelId: 'MiniMax-M3',
          effort,
        }),
      ).resolves.toEqual({ ok: true });

      const init = (fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1];
      expect(JSON.parse(String(init.body))).toMatchObject(expectedPatch);
    },
  );
});

describe('ModelConnectionTester output budget', () => {
  it.each([
    ['anthropic-messages', messagesOkResponse],
    ['openai-completions', openAiOkResponse],
    ['openai-responses', openAiResponsesOkResponse],
  ] as const)('sends the configured output limit to %s', async (api, response) => {
    const fetchImpl = vi.fn(async () => response());
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      tester.test(`configured-output-limit-${api}`, {
        api,
        baseUrl: 'https://api.example.com/v1',
        apiKey: API_KEY,
        modelId: 'm',
        outputLimit: 12_000,
      }),
    ).resolves.toEqual({ ok: true });

    const init = (fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.max_tokens ?? body.max_output_tokens).toBe(12_000);
  });

  it.each([
    ['on', { thinking: { type: 'adaptive' } }],
    ['off', { thinking: { type: 'disabled' } }],
  ] as const)(
    'sends the configured output limit for the MiniMax M3 provider-level Thinking %s probe',
    async (mode, expectedPatch) => {
      const fetchImpl = vi.fn(async () => messagesOkResponse());
      const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

      await expect(
        tester.test(`minimax-m3-provider-${mode}`, {
          api: 'anthropic-messages',
          baseUrl: CN_MINIMAX_MESSAGES_URL,
          apiKey: API_KEY,
          modelId: 'MiniMax-M3',
          outputLimit: 1_024,
          minimaxM3ThinkingMode: mode,
        }),
      ).resolves.toEqual({ ok: true });

      const init = (fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1];
      expect(JSON.parse(String(init.body))).toMatchObject({
        max_tokens: 1_024,
        stream: false,
        ...expectedPatch,
      });
    },
  );

  it('clears the MiniMax M3 thinking output floor from the configured output limit', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
      if ((body.max_tokens ?? 0) < 1_024) {
        return new Response(
          JSON.stringify({ base_resp: { status_code: 0, status_msg: 'success' } }),
          { status: 200 },
        );
      }
      return messagesOkResponse();
    });
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      tester.test('minimax-m3-provider-thinking-on-output-floor', {
        api: 'anthropic-messages',
        baseUrl: GLOBAL_MINIMAX_MESSAGES_URL,
        apiKey: API_KEY,
        modelId: 'MiniMax-M3',
        outputLimit: 1_024,
        minimaxM3ThinkingMode: 'on',
      }),
    ).resolves.toEqual({ ok: true });

    const init = (fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toMatchObject({
      max_tokens: 1_024,
      stream: false,
      thinking: { type: 'adaptive' },
    });
  });
});

describe('ModelConnectionTester response errors', () => {
  it('applies custom headers case-insensitively after protocol defaults', async () => {
    const fetchImpl = vi.fn(async () => openAiOkResponse());
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await tester.test('custom-headers', {
      api: 'openai-completions',
      baseUrl: 'https://api.example.com/v1',
      apiKey: API_KEY,
      modelId: 'm',
      headers: {
        authorization: 'Api-Key custom-auth',
        'X-Tenant-Id': 'tenant-a',
      },
    });

    const init = (fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Api-Key custom-auth');
    expect(headers.get('x-tenant-id')).toBe('tenant-a');
    expect(Array.from(headers.keys()).filter((name) => name === 'authorization')).toHaveLength(1);
  });
});

describe('ModelConnectionTester HTTP response errors', () => {
  it('maps 401/403 to unauthorized without leaking the key', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () => new Response(`bad key ${API_KEY}`, { status }));
      const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });
      const result = await tester.test(`p-${status}`, {
        api: 'openai-completions',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: API_KEY,
        modelId: 'gpt-4.1',
      });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('unauthorized');
      expect(JSON.stringify(result)).not.toContain(API_KEY);
    }
  });

  it('maps other http failures to http_<status> with a sanitized upstream reason', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: `upstream broke with ${API_KEY}` } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await tester.test('p3', {
      api: 'anthropic-messages',
      baseUrl: 'https://api.example.com',
      apiKey: API_KEY,
      modelId: 'm',
    });
    expect(result.errorCode).toBe('http_503');
    expect(result.errorMessage).toBe('HTTP 503: upstream broke with ***');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('shows the structured HTTP 400 reason without exposing custom Header values', async () => {
    const tenantSecret = 'tenant-secret-value';
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: `Invalid reasoning effort for tenant ${tenantSecret}`,
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await tester.test('http-400-reason', {
      api: 'openai-responses',
      baseUrl: 'https://api.example.com/v1',
      apiKey: API_KEY,
      modelId: 'reasoning-model',
      headers: { 'X-Tenant-Secret': tenantSecret },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'http_400',
      errorMessage: 'HTTP 400: Invalid reasoning effort for tenant ***',
    });
  });
});

describe('ModelConnectionTester Responses validation order', () => {
  it('lets the upstream validate an invalid Responses effort before the output budget', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        max_output_tokens?: number;
        reasoning?: { effort?: string };
      };
      if ((body.max_output_tokens ?? 0) < 16) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16.",
            },
          }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({
          error: { message: `Invalid 'reasoning.effort': ${body.reasoning?.effort}` },
        }),
        { status: 400 },
      );
    });
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await tester.test('responses-invalid-effort', {
      api: 'openai-responses',
      baseUrl: 'https://api.example.com/v1',
      apiKey: API_KEY,
      modelId: 'reasoning-model',
      effort: 'hahah',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'http_400',
      errorMessage: "HTTP 400: Invalid 'reasoning.effort': hahah",
    });
  });
});

describe('ModelConnectionTester provider error envelopes', () => {
  it('shows a sanitized provider error returned inside a 2xx response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'insufficient_balance',
              message: `insufficient balance for ${API_KEY}`,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await tester.test('2xx-provider-error', {
      api: 'anthropic-messages',
      baseUrl: 'https://api.example.com',
      apiKey: API_KEY,
      modelId: 'MiniMax-M3',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'provider_error',
      errorMessage: 'insufficient balance for ***',
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('shows a non-zero MiniMax base_resp reason returned inside a 2xx response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            content: [],
            base_resp: {
              status_code: 1008,
              status_msg: 'insufficient balance',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await tester.test('2xx-base-resp-error', {
      api: 'anthropic-messages',
      baseUrl: 'https://api.example.com',
      apiKey: API_KEY,
      modelId: 'MiniMax-M3',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'provider_error',
      errorMessage: 'insufficient balance (1008)',
    });
  });

  it.each([
    ['empty body', '', 'HTTP 500'],
    ['HTML body', '<html>upstream failure</html>', 'HTTP 500'],
    ['plain-text body', 'upstream unavailable', 'HTTP 500: upstream unavailable'],
    ['empty object', '{}', 'HTTP 500'],
    ['JSON string', JSON.stringify(' upstream unavailable '), 'HTTP 500: upstream unavailable'],
    [
      'string provider error',
      JSON.stringify({ error: 'quota exhausted' }),
      'HTTP 500: quota exhausted',
    ],
    [
      'provider status without a message',
      JSON.stringify({ base_resp: { status_code: 1008 } }),
      'HTTP 500: Provider error (1008)',
    ],
    [
      'provider status already included in its message',
      JSON.stringify({ base_resp: { status_code: '1008', status_msg: 'error 1008' } }),
      'HTTP 500: error 1008',
    ],
    [
      'invalid provider status type',
      JSON.stringify({ base_resp: { status_code: true, status_msg: 'ignored' } }),
      'HTTP 500',
    ],
    [
      'empty provider status',
      JSON.stringify({ base_resp: { status_code: '  ', status_msg: 'ignored' } }),
      'HTTP 500',
    ],
    ['top-level detail', JSON.stringify({ detail: 'bad request' }), 'HTTP 500: bad request'],
    [
      'top-level error description',
      JSON.stringify({ error_description: 'invalid account' }),
      'HTTP 500: invalid account',
    ],
  ] as const)('normalizes an upstream %s', async (_label, body, errorMessage) => {
    const fetchImpl = vi.fn(async () => new Response(body, { status: 500 }));
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      tester.test(`upstream-${_label}`, {
        api: 'openai-completions',
        baseUrl: 'https://api.example.com/v1',
        apiKey: API_KEY,
        modelId: 'm',
      }),
    ).resolves.toEqual({ ok: false, errorCode: 'http_500', errorMessage });
  });
});

describe('ModelConnectionTester invalid responses and concurrency', () => {
  it('does not treat a successful base_resp without protocol content as a provider error', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ base_resp: { status_code: 0, status_msg: 'success' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await tester.test('2xx-success-base-resp-without-content', {
      api: 'anthropic-messages',
      baseUrl: 'https://api.example.com',
      apiKey: API_KEY,
      modelId: 'MiniMax-M3',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_response',
      errorMessage: 'Invalid response from model provider',
    });
  });

  it('rejects openai-completions 2xx HTML fallback responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>not the api</html>', { status: 200 }));
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await tester.test('openrouter-root', {
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai',
      apiKey: API_KEY,
      modelId: 'minimax/minimax-m3',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_response',
      errorMessage: 'Invalid response from model provider',
    });
    expect(JSON.stringify(result)).not.toContain('not the api');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('rejects openai-completions 2xx JSON without chat choices', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const tester = new ModelConnectionTester({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await tester.test('bad-openai-json', {
      api: 'openai-completions',
      baseUrl: 'https://api.example.com/v1',
      apiKey: API_KEY,
      modelId: 'm',
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('invalid_response');
  });

  it('maps abort to timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const tester = new ModelConnectionTester({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
    });
    const result = await tester.test('p4', {
      api: 'anthropic-messages',
      baseUrl: 'https://api.example.com',
      apiKey: API_KEY,
      modelId: 'm',
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('timeout');
  });

  it('maps abort while reading a 2xx response body to timeout', async () => {
    const response = {
      ok: true,
      status: 200,
      json: vi.fn(async () => {
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }),
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => response);
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await tester.test('body-abort', {
      api: 'openai-completions',
      baseUrl: 'https://api.example.com',
      apiKey: API_KEY,
      modelId: 'm',
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('timeout');
  });

  it('maps an AbortError-like rejection to timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      throw { name: 'AbortError' };
    });
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(
      tester.test('abort-like-object', {
        api: 'openai-completions',
        baseUrl: 'https://api.example.com/v1',
        apiKey: API_KEY,
        modelId: 'm',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'timeout' });
  });

  it('maps fetch rejection to network with sanitized message', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed for key ${API_KEY}`);
    });
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await tester.test('p5', {
      api: 'openai-completions',
      baseUrl: 'https://api.example.com',
      apiKey: API_KEY,
      modelId: 'm',
    });
    expect(result.errorCode).toBe('network');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('deduplicates concurrent tests for the same key', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const target = {
      api: 'openai-completions' as const,
      baseUrl: 'https://api.example.com',
      apiKey: API_KEY,
      modelId: 'm',
    };

    const first = tester.test('same-key', target);
    const second = tester.test('same-key', target);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolveFetch?.(openAiOkResponse());
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });

    // After settling, a new test fires a fresh request.
    const third = tester.test('same-key', target);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    resolveFetch?.(openAiOkResponse());
    await third;
  });

  it('does not deduplicate across different keys', async () => {
    const fetchImpl = vi.fn(async () => openAiOkResponse());
    const tester = new ModelConnectionTester({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const target = {
      api: 'openai-completions' as const,
      baseUrl: 'https://api.example.com',
      apiKey: API_KEY,
      modelId: 'm',
    };
    await Promise.all([tester.test('key-a', target), tester.test('key-b', target)]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('OpenCode Go connection identity', () => {
  it.each([
    ['openai-completions', openAiOkResponse],
    ['openai-responses', openAiResponsesOkResponse],
    ['anthropic-messages', messagesOkResponse],
  ] as const)('adds independent probe identities for %s', async (api, response) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    const tester = new ModelConnectionTester({ fetchImpl });
    const target = {
      api,
      apiKey: API_KEY,
      baseUrl: 'https://opencode.ai/zen/go/v1',
      modelId: 'test-model',
      headers: { 'X-OpenCode-Session': 'stale-static-id', 'USER-AGENT': 'generic-sdk' },
    };
    expect(await tester.test('probe-1', target)).toEqual({ ok: true });
    expect(await tester.test('probe-2', target)).toEqual({ ok: true });
    const headers = fetchImpl.mock.calls.map((call) => new Headers(call[1]?.headers));
    for (const header of headers) {
      expect(header.get('x-opencode-session')).toMatch(/^[0-9a-f-]{36}$/u);
      expect(header.get('user-agent')).toBe('MiniMaxCode');
    }
    expect(headers[0]?.get('x-opencode-session')).not.toBe(headers[1]?.get('x-opencode-session'));
  });
});

describe('Google connection tests through Pi', () => {
  const target = {
    api: 'google-generative-ai' as const,
    apiKey: API_KEY,
    baseUrl: 'https://opencode.ai/inference/go/v1',
    modelId: 'gemini-4-argon-contributor',
    outputLimit: 1024,
  };

  it.each([undefined, 'off', 'high'])('uses Pi with effort %s and the configured output limit', async (effort) => {
    let request: Request | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        request = new Request(input, init);
        return new Response(
          `data: ${JSON.stringify({
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'pong' }] },
                finishReason: 'STOP',
              },
            ],
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }),
    );
    try {
      expect(await new ModelConnectionTester().test('google', { ...target, effort })).toEqual({
        ok: true,
      });
      expect(request?.url).toBe(
        `${target.baseUrl}/models/${target.modelId}:streamGenerateContent?alt=sse`,
      );
      expect(request?.headers.get('x-goog-api-key')).toBe(API_KEY);
      expect(request?.headers.get('x-opencode-session')).toMatch(/^[0-9a-f-]{36}$/u);
      expect(request?.headers.get('user-agent')).toContain('MiniMaxCode');
      const body = await request?.json();
      expect(body).toMatchObject({
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1024 },
      });
      if (effort === 'high') {
        expect(body.generationConfig.thinkingConfig).toMatchObject({ includeThoughts: true });
      } else {
        expect(body.generationConfig).not.toHaveProperty('thinkingConfig');
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('redacts provider errors returned by Pi', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 401,
                message: `Invalid key ${API_KEY}`,
                status: 'UNAUTHENTICATED',
              },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    try {
      const result = await new ModelConnectionTester().test('google-error', target);
      expect(result).toMatchObject({ ok: false, errorCode: 'provider_error' });
      expect(result.errorMessage).toContain('Invalid key');
      expect(result.errorMessage).not.toContain(API_KEY);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('honors the caller timeout while Pi is waiting for Google', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        (input, init) =>
          new Promise((_resolve, reject) => {
            const signal = new Request(input, init).signal;
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    );
    try {
      expect(
        await new ModelConnectionTester({ timeoutMs: 50 }).test('google-timeout', target),
      ).toMatchObject({ ok: false, errorCode: 'timeout' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
