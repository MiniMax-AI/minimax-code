import { describe, expect, it } from 'vitest';

import { resolveRemoteTokenCounterAdapter } from '../../src/context/token-counter-adapters/registry.js';
import { buildResponsesInputTokensUrl } from '../../src/context/token-counter-adapters/responses.js';
import type { RemoteTokenCountContext } from '../../src/context/token-counter-adapters/types.js';

function makeContext(baseUrl: string, api = 'openai-completions'): RemoteTokenCountContext {
  return {
    model: { id: 'glm-5.3', api, provider: 'custom_provider', baseUrl, input: ['text'] },
    apiKey: 'sk-test',
    systemPrompt: 'hi',
    messages: [],
    tools: [],
  } as unknown as RemoteTokenCountContext;
}

describe('remote token counter adapter routing (issue #258)', () => {
  it('routes Zhipu general API-plan base URLs to the zhipu tokenizer', () => {
    for (const baseUrl of [
      'https://api.z.ai/api/paas/v4',
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    ]) {
      const ctx = makeContext(baseUrl);
      const adapter = resolveRemoteTokenCounterAdapter(ctx);
      expect(adapter?.id).toBe('zhipu-tokenizer');
      expect(adapter?.buildRequest(ctx)?.url).toMatch(/\/api\/paas\/v4\/tokenizer$/u);
    }
  });

  it('routes Zhipu coding-plan base URLs to the zhipu tokenizer on the coding-plan root', () => {
    for (const host of ['api.z.ai', 'open.bigmodel.cn']) {
      for (const path of ['/api/coding/paas/v4', '/api/coding/paas/v4/chat/completions']) {
        const ctx = makeContext(`https://${host}${path}`);
        const adapter = resolveRemoteTokenCounterAdapter(ctx);
        expect(adapter?.id).toBe('zhipu-tokenizer');
        expect(adapter?.buildRequest(ctx)?.url).toBe(
          `https://${host}/api/coding/paas/v4/tokenizer`,
        );
      }
    }
  });

  it('routes Kimi base URLs to the kimi estimator', () => {
    const adapter = resolveRemoteTokenCounterAdapter(makeContext('https://api.moonshot.cn/v1'));
    expect(adapter?.id).toBe('kimi-estimate-token-count');
  });

  it('keeps unrelated OpenAI-compatible providers on generic-responses', () => {
    const adapter = resolveRemoteTokenCounterAdapter(
      makeContext('https://gateway.example.com/v1'),
    );
    expect(adapter?.id).toBe('generic-responses');
  });
});

describe('buildResponsesInputTokensUrl version handling (issue #258)', () => {
  it('keeps /v1 base URLs unchanged', () => {
    expect(buildResponsesInputTokensUrl('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/responses/input_tokens',
    );
  });

  it('appends /v1 when the base URL has no version segment', () => {
    expect(buildResponsesInputTokensUrl('https://api.example.com')).toBe(
      'https://api.example.com/v1/responses/input_tokens',
    );
    expect(buildResponsesInputTokensUrl('https://api.example.com/openai')).toBe(
      'https://api.example.com/openai/v1/responses/input_tokens',
    );
  });

  it('does not double the version for base URLs already ending in a version segment', () => {
    expect(buildResponsesInputTokensUrl('https://api.z.ai/api/coding/paas/v4')).toBe(
      'https://api.z.ai/api/coding/paas/v4/responses/input_tokens',
    );
    expect(buildResponsesInputTokensUrl('https://gateway.example.com/v2')).toBe(
      'https://gateway.example.com/v2/responses/input_tokens',
    );
  });

  it('strips chat/completions and responses suffixes before resolving the root', () => {
    expect(buildResponsesInputTokensUrl('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/responses/input_tokens',
    );
    expect(
      buildResponsesInputTokensUrl('https://open.bigmodel.cn/api/paas/v4/chat/completions'),
    ).toBe('https://open.bigmodel.cn/api/paas/v4/responses/input_tokens');
    expect(buildResponsesInputTokensUrl('https://api.example.com/v1/responses')).toBe(
      'https://api.example.com/v1/responses/input_tokens',
    );
  });

  it('keeps the MiniMax anthropic-compat stripping behavior stable', () => {
    expect(
      buildResponsesInputTokensUrl('https://api.minimaxi.com/anthropic', {
        stripMessagesCompatibilityPrefix: true,
      }),
    ).toBe('https://api.minimaxi.com/v1/responses/input_tokens');
  });

  it('falls back to string handling for non-URL base values', () => {
    expect(buildResponsesInputTokensUrl('not a url/api/paas/v4')).toBe(
      'not a url/api/paas/v4/responses/input_tokens',
    );
  });
});
