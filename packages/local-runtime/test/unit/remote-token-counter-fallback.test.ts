import type { Context, Model } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';

import { ContextUsageCalibrationCoordinator } from '../../src/context/context-usage-calibration.js';
import {
  HttpRemoteTokenCounter,
  type RemoteTokenCountContext,
} from '../../src/context/remote-token-counter.js';

const model: Model<'openai-completions'> = {
  id: 'test-model', name: 'Test', api: 'openai-completions',
  provider: 'custom_provider:test', baseUrl: 'https://gateway.example.invalid/v1',
  reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000, maxTokens: 1_000,
};
const tool = {
  name: 'read', description: 'Read a file',
  parameters: { type: 'object' as const, properties: { path: { type: 'string' } } },
};

function countInput(): RemoteTokenCountContext {
  return {
    model, apiKey: 'test-key', systemPrompt: 'Test system', tools: [tool],
    messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
  };
}

function ok(tokens = 100): Response {
  return Response.json({ input_tokens: tokens });
}

const REQUEST_SPECIFIC_REJECTIONS = new Set([400, 422]);

describe('remote counting failure fallback', () => {
  it.each([400, 401, 402, 403, 404, 405, 410, 422, 501])(
    'stops rejected calibration probes after HTTP %i across turns and tool changes',
    async (status) => {
      let now = 0;
      const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('rejected', { status }));
      const counter = new HttpRemoteTokenCounter({ fetchFn, nowMs: () => now });
      const coordinator = new ContextUsageCalibrationCoordinator(counter, { nowMs: () => now });
      for (let turn = 0; turn < 60; turn += 1) {
        const context: Context = {
          systemPrompt: 'Test system',
          messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
          tools: [{ ...tool, description: `Tool schema revision ${turn}` }],
        };
        const result = await coordinator.calibrateTools({
          context, model,
          streamOptions: { apiKey: 'test-key', headers: { 'X-Mavis-Session-Id': `session-${turn}` } },
        });
        expect(result.status).toBe('UNAVAILABLE');
        now += 60_001;
      }
      // Validation errors need one repeat; endpoint and credential errors stop at once.
      const expectedProbes = REQUEST_SPECIFIC_REJECTIONS.has(status) ? 2 : 1;
      expect(fetchFn).toHaveBeenCalledTimes(expectedProbes);
      for (const [, init] of fetchFn.mock.calls) {
        expect(JSON.parse(String(init?.body)).tools).toBeUndefined();
      }
      const local = await counter.countContextTokens(countInput());
      expect(local.source).toBe('estimate');
      expect(local.tokens).toBeGreaterThan(0);
      expect(fetchFn).toHaveBeenCalledTimes(expectedProbes);
    },
  );

  it('keeps a working counter after one request-specific validation error', async () => {
    let now = 0;
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('bad tools', { status: 400 }))
      .mockImplementation(async () => ok());
    const counter = new HttpRemoteTokenCounter({ fetchFn, nowMs: () => now });
    expect((await counter.countContextTokens(countInput())).fallbackReason).toBe('http_400');
    now += 60_000;
    expect((await counter.countContextTokens(countInput())).source).toBe('remote');
    expect((await counter.countContextTokens(countInput())).source).toBe('remote');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it.each(['model', 'provider', 'baseUrl', 'apiKey', 'headers'] as const)(
    'allows a new probe after changing %s without reopening the rejected configuration',
    async (field) => {
      let now = 0;
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(new Response('Account invalid', { status: 400 }))
        .mockResolvedValueOnce(new Response('Account invalid', { status: 400 }))
        .mockImplementation(async () => ok());
      const counter = new HttpRemoteTokenCounter({ fetchFn, nowMs: () => now });
      const input = countInput();
      await counter.countContextTokens(input);
      now += 60_000;
      await counter.countContextTokens(input);
      const changed: RemoteTokenCountContext = { ...input };
      if (field === 'apiKey') changed.apiKey = 'replacement-key';
      else if (field === 'headers') changed.headers = { 'X-Gateway-Key': 'replacement-key' };
      else changed.model = { ...input.model, [field === 'model' ? 'id' : field]: 'replacement' };
      expect((await counter.countContextTokens(changed)).source).toBe('remote');
      expect((await counter.countContextTokens(input)).fallbackReason).toBe('counter_rejected');
      expect(fetchFn).toHaveBeenCalledTimes(3);
    },
  );

  it('continues to calibrate a supported BYOK model and reuses the successful result', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return ok(body.tools?.length ? 300 : 100);
    });
    const coordinator = new ContextUsageCalibrationCoordinator(new HttpRemoteTokenCounter({ fetchFn }));
    const input = { context: countInput() as Context, model, streamOptions: { apiKey: 'test-key' } };
    expect(await coordinator.calibrateTools(input)).toMatchObject({ status: 'REMOTE', tokens: 200 });
    expect(await coordinator.calibrateTools(input)).toMatchObject({ status: 'REMOTE', tokens: 200 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('keeps failure state within the owning Runtime counter', async () => {
    const rejectedFetch = vi.fn(async () => new Response('rejected', { status: 400 }));
    const acceptedFetch = vi.fn(async () => ok());
    const localRuntime = new HttpRemoteTokenCounter({ fetchFn: rejectedFetch });
    const remoteRuntime = new HttpRemoteTokenCounter({ fetchFn: acceptedFetch });
    await localRuntime.countContextTokens(countInput());
    expect((await remoteRuntime.countContextTokens(countInput())).source).toBe('remote');
    expect((await localRuntime.countContextTokens(countInput())).source).toBe('estimate');
    expect(rejectedFetch).toHaveBeenCalledOnce();
    expect(acceptedFetch).toHaveBeenCalledOnce();
  });

  it('shares rejection state across equivalent Responses endpoint addresses', async () => {
    const fetchFn = vi.fn(async () => new Response('rejected', { status: 401 }));
    const counter = new HttpRemoteTokenCounter({ fetchFn });
    await counter.countContextTokens(countInput());
    const equivalent = {
      ...countInput(), model: { ...model, baseUrl: `${model.baseUrl}/chat/completions/` },
    };
    expect((await counter.countContextTokens(equivalent)).fallbackReason).toBe('counter_rejected');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each(['server', 'network', 'malformed', 'invalid-json'])(
    'backs off %s failures up to 30 minutes and recovers without a restart',
    async (failure) => {
      let now = 0;
      let healthy = false;
      const fetchFn = vi.fn(async () => {
        if (healthy) return ok();
        if (failure === 'network') throw new Error('network unavailable');
        if (failure === 'invalid-json') return new Response('not JSON');
        if (failure === 'malformed') return Response.json({ error: 'counter unavailable' });
        return new Response('unavailable', { status: 502 });
      });
      const counter = new HttpRemoteTokenCounter({ fetchFn, nowMs: () => now });
      const delays = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000];
      for (const delay of delays) {
        expect((await counter.countContextTokens(countInput())).source).toBe('estimate');
        now += delay - 1;
        expect((await counter.countContextTokens(countInput())).fallbackReason).toBe(
          'counter_cooldown',
        );
        now += 1;
      }
      expect(fetchFn).toHaveBeenCalledTimes(delays.length);
      healthy = true;
      expect((await counter.countContextTokens(countInput())).source).toBe('remote');
      expect(fetchFn).toHaveBeenCalledTimes(delays.length + 1);
    },
  );

  it.each(['300', 'Thu, 01 Jan 1970 00:05:00 GMT'])(
    'honors Retry-After %s and recovers from rate limiting',
    async (retryAfter) => {
      let now = 0;
      const fetchFn = vi.fn()
        .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': retryAfter } }))
        .mockImplementation(async () => ok());
      const counter = new HttpRemoteTokenCounter({ fetchFn, nowMs: () => now });
      await counter.countContextTokens(countInput());
      now = 60_000;
      expect((await counter.countContextTokens(countInput())).fallbackReason).toBe('counter_cooldown');
      now = 300_000;
      expect((await counter.countContextTokens(countInput())).source).toBe('remote');
      expect((await counter.countContextTokens(countInput())).source).toBe('remote');
      expect(fetchFn).toHaveBeenCalledTimes(3);
    },
  );

  it('clears transient failure history after a successful count', async () => {
    let now = 0;
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 500 }))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(new Response('unavailable', { status: 500 }))
      .mockImplementation(async () => ok());
    const counter = new HttpRemoteTokenCounter({ fetchFn, nowMs: () => now });
    await counter.countContextTokens(countInput());
    now = 60_000;
    await counter.countContextTokens(countInput());
    await counter.countContextTokens(countInput());
    now += 60_000;
    expect((await counter.countContextTokens(countInput())).source).toBe('remote');
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('bounds remote timeouts while keeping estimates available', async () => {
    let now = 0;
    const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
      }));
    const counter = new HttpRemoteTokenCounter({ fetchFn, timeoutMs: 1, nowMs: () => now });
    for (const retryAt of [0, 60_000, 180_000]) {
      now = retryAt;
      const result = await counter.countContextTokens(countInput());
      expect(result.source).toBe('estimate');
      expect(result.tokens).toBeGreaterThan(0);
    }
    now = 3_600_000;
    // Timeouts are transient: the counter keeps retrying at a bounded rate.
    expect((await counter.countContextTokens(countInput())).fallbackReason).toBe('request_failed');
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('does not treat in-flight caller cancellation as a counter failure', async () => {
    const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('caller aborted')), { once: true });
      }));
    const counter = new HttpRemoteTokenCounter({ fetchFn });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const controller = new AbortController();
      const pending = counter.countContextTokens({ ...countInput(), signal: controller.signal });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(attempt + 1));
      controller.abort();
      await pending;
    }
    fetchFn.mockResolvedValue(ok());
    expect((await counter.countContextTokens(countInput())).source).toBe('remote');
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });
});
