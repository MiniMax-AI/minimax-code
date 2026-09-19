import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelDiscoveryClient } from './discover-models.js';
import { ModelConnectionTester } from './test-connection.js';
import {
  normalizeProviderBaseUrl,
  providerCompletionUrl,
  providerModelsUrls,
} from './provider-request.js';

const query = '?tenant=a&tenant=b&encoded=%2F%23%3F&space=a%20b&plus=a+b&empty=';
const fragment = '#local/messages?not-a-query=1/';
const cases = [
  ['openai-completions', '/v1', '/v1', '/v1/chat/completions', '/v1/models'],
  ['openai-completions', '/v1///', '/v1', '/v1/chat/completions', '/v1/models'],
  ['openai-completions', '/v1/chat/completions/', '/v1', '/v1/chat/completions', '/v1/models'],
  ['openai-completions', '/v1/responses', '/v1', '/v1/chat/completions', '/v1/models'],
  ['openai-responses', '/v1/responses/', '/v1', '/v1/responses', '/v1/models'],
  ['openai-responses', '/v1/chat/completions', '/v1', '/v1/responses', '/v1/models'],
  ['anthropic-messages', '/compat/', '/compat', '/compat/v1/messages', '/compat/v1/models'],
  ['anthropic-messages', '/compat/v1/', '/compat', '/compat/v1/messages', '/compat/v1/models'],
  [
    'anthropic-messages',
    '/compat/v1/messages/',
    '/compat',
    '/compat/v1/messages',
    '/compat/v1/models',
  ],
  [
    'anthropic-messages',
    '/compat/messages',
    '/compat',
    '/compat/v1/messages',
    '/compat/v1/models',
  ],
  ['anthropic-messages', '/v1/messages', '', '/v1/messages', '/v1/models'],
  ['openai-completions', '', '', '/chat/completions', '/models'],
] as const;

describe('provider URL components', () => {
  it.each(cases)(
    'normalizes only the path for %s %s',
    (api, path, base, completion, models) => {
      for (const suffix of [
        '',
        query,
        fragment,
        `${query}${fragment}`,
        '?tenant=/responses/',
        '?',
      ]) {
        const input = `https://gateway.example${path}${suffix}`;
        const normalized = `https://gateway.example${base}${suffix}`;
        expect(normalizeProviderBaseUrl(api, input)).toBe(normalized);
        expect(normalizeProviderBaseUrl(api, normalized)).toBe(normalized);
        expect(providerCompletionUrl(api, input)).toBe(
          `https://gateway.example${completion}${suffix}`,
        );
        expect(providerModelsUrls(api, input)[0]).toBe(
          `https://gateway.example${models}${suffix}`,
        );
      }
    },
  );

  it('keeps query parameters on each Messages candidate in native-first order', () => {
    expect(
      providerModelsUrls(
        'anthropic-messages',
        `https://gateway.example/compat/v1/messages${query}${fragment}`,
      ),
    ).toEqual([
      `https://gateway.example/compat/v1/models${query}${fragment}`,
      `https://gateway.example/compat/models${query}${fragment}`,
      `https://gateway.example/models${query}${fragment}`,
    ]);
    expect(
      providerModelsUrls('anthropic-messages', `https://gateway.example/v1${query}${fragment}`),
    ).toEqual([
      `https://gateway.example/v1/models${query}${fragment}`,
      `https://gateway.example/models${query}${fragment}`,
    ]);
  });
});

describe('provider connectivity over loopback HTTP', () => {
  let origin: string;
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
  }> = [];
  let missingCandidates = 0;
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    if (missingCandidates > 0) {
      res.statusCode = missingCandidates-- === 2 ? 404 : 405;
      res.end('{}');
      return;
    }
    res.end(
      JSON.stringify({
        id: 'response_test',
        object: 'response',
        output: [],
        content: [],
        choices: [{ message: { role: 'assistant', content: 'pong' } }],
        data: [{ id: 'synthetic-model' }],
      }),
    );
  });

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  it.each(cases)(
    'sends endpoint paths and unmodified queries for %s %s',
    async (api, path, _base, completion, models) => {
      for (const suffix of ['', query, fragment, `${query}${fragment}`]) {
        requests.length = 0;
        const target = {
          api,
          baseUrl: `${origin}${path}${suffix}`,
          apiKey: 'test-key',
          modelId: 'synthetic-model',
        };
        expect(await new ModelConnectionTester().test('loopback', target)).toEqual({
          ok: true,
        });
        expect(await new ModelDiscoveryClient().discover(target)).toEqual({
          ok: true,
          models: [{ modelId: 'synthetic-model' }],
        });
        const sentQuery = suffix.startsWith('?') ? query : '';
        expect(requests).toEqual([
          { method: 'POST', url: `${completion}${sentQuery}` },
          { method: 'GET', url: `${models}${sentQuery}` },
        ]);
      }
    },
  );

  it('preserves the query through 404/405 fallback to the origin model list', async () => {
    requests.length = 0;
    missingCandidates = 2;
    expect(
      await new ModelDiscoveryClient().discover({
        api: 'anthropic-messages',
        baseUrl: `${origin}/compat/v1/messages/${query}${fragment}`,
        apiKey: 'test-key',
      }),
    ).toEqual({ ok: true, models: [{ modelId: 'synthetic-model' }] });
    expect(requests).toEqual([
      { method: 'GET', url: `/compat/v1/models${query}` },
      { method: 'GET', url: `/compat/models${query}` },
      { method: 'GET', url: `/models${query}` },
    ]);
  });
});
