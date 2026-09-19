import { describe, expect, it, vi } from 'vitest';
import { streamSimple } from '@earendil-works/pi-ai';
import { parseMinimaxApiConfig } from '../../../../../config/src/byok-config.js';
import { planMinimaxApiResolution as legacyPlan } from '../../../../../local-runtime/src/runtime/model-resolver-byok.js';
import { planMinimaxApiResolution } from './model-resolver-byok.js';
import { LocalModelResolver } from './local-model-resolver.js';
import {
  buildProviderHeaders,
  buildModelDiscoveryHeaders,
} from '../connectivity/provider-request.js';

const apiKey = 'fixture-default-key';
const authorization = 'Bearer fixture-relay-key';

describe('MiniMax API custom authentication headers', () => {
  it('parses only string header values without exposing mutable input records', () => {
    const raw = {
      apiKey,
      headers: {
        Authorization: authorization,
        count: 1,
        nested: {},
        '': 'bad',
      },
    };
    const parsed = parseMinimaxApiConfig(raw);
    expect(parsed).toEqual({
      apiKey,
      headers: { Authorization: authorization },
    });
    expect(parsed?.headers).not.toBe(raw.headers);
    for (const headers of [null, [], 'bad', { count: 1 }]) {
      expect(parseMinimaxApiConfig({ apiKey, headers })).toEqual({ apiKey });
    }
  });

  it.each([planMinimaxApiResolution, legacyPlan])(
    'propagates headers through each BYOK planner',
    (plan) => {
      expect(
        plan({
          byok: {
            minimax_api: { apiKey, headers: { Authorization: authorization } },
          },
          providerConfig: undefined,
          modelId: 'MiniMax-M3',
          catalog: {
            contextWindow: 200_000,
            maxTokens: 16_384,
            fromCatalog: false,
          },
        }),
      ).toMatchObject({ configHeaders: { Authorization: authorization } });
    },
  );

  const cases: Array<[Record<string, string> | undefined, string | null, string | null]> = [
    [undefined, null, apiKey],
    [{ Authorization: authorization }, authorization, null],
    [{ AUTHORIZATION: authorization }, authorization, null],
    [{ 'x-api-key': 'fixture-override' }, null, 'fixture-override'],
    [{ authorization, 'X-Api-Key': 'fixture-explicit' }, authorization, 'fixture-explicit'],
  ];
  it.each(cases)(
    'uses the same auth headers for probes and real SDK requests: %j',
    async (headers, expectedAuth, expectedKey) => {
      const parsed = parseMinimaxApiConfig({
        apiKey,
        baseURL: 'https://relay.example/anthropic',
        headers,
      });
      const resolver = new LocalModelResolver({
        byokConfigGetter: () => ({ minimax_api: parsed }),
      });
      const resolved = await resolver.resolveModel({
        sessionId: 'fixture-session',
        turnId: 'fixture-turn',
        agentConfig: {
          system_prompt: 'Be brief.',
          agent_id: 'fixture-agent',
          tools: [],
          skills: [],
          model: {
            provider: 'minimax_api',
            model_id: 'MiniMax-M3',
            context_window: 200_000,
          },
        },
      });
      const probe = buildProviderHeaders({
        api: 'anthropic-messages',
        apiKey,
        headers,
      });
      expect(probe.get('authorization')).toBe(expectedAuth);
      expect(probe.get('x-api-key')).toBe(expectedKey);
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        const actual = new Headers(init?.headers);
        expect(actual.get('authorization')).toBe(expectedAuth);
        expect(actual.get('x-api-key')).toBe(expectedKey);
        return new Response(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","content":[],"model":"MiniMax-M3","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      });
      const result = await streamSimple(
        resolved.model,
        {
          messages: [{ role: 'user', content: 'Hi', timestamp: 0 }],
        },
        {
          apiKey: resolved.apiKey,
          headers: resolved.headers,
          fetch: fetchImpl,
        },
      ).result();
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(result.stopReason).not.toBe('error');
    },
  );

  it('preserves discovery probes that intentionally send both authentication schemes', () => {
    const headers = buildModelDiscoveryHeaders({
      api: 'anthropic-messages',
      apiKey,
      headers: { Authorization: authorization },
    });
    expect(headers.get('authorization')).toBe(authorization);
    expect(headers.get('x-api-key')).toBe(apiKey);
  });
});
