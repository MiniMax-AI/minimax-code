import { withOpenCodeGoHeaders, withOpenRouterAttributionHeaders } from '@mavis/shared';

import type { ModelProviderApi } from '../identity.js';

export type { ModelProviderApi } from '../identity.js';

const MESSAGES_VERSION_HEADER = 'anthropic-messages'.replace('-messages', '-version');

export function buildProviderHeaders(input: {
  api: ModelProviderApi;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}): Headers {
  const defaults: Record<string, string> =
    input.api === 'anthropic-messages'
      ? {
          'content-type': 'application/json',
          'x-api-key': input.apiKey,
          [MESSAGES_VERSION_HEADER]: '2023-06-01',
        }
      : {
          'content-type': 'application/json',
          Authorization: `Bearer ${input.apiKey}`,
        };
  const headers = new Headers(defaults);
  const attributedHeaders = withOpenCodeGoHeaders(
    input.baseUrl,
    withOpenRouterAttributionHeaders(input.baseUrl, input.headers),
  );
  for (const [name, value] of Object.entries(attributedHeaders ?? {})) {
    headers.set(name, value);
  }
  // Explicit Authorization replaces the default API key, but explicit dual auth is preserved.
  const supplied = new Headers(input.headers);
  if (supplied.has('authorization') && !supplied.has('x-api-key')) {
    headers.delete('x-api-key');
  }
  return headers;
}

export function buildModelDiscoveryHeaders(input: {
  api: ModelProviderApi;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}): Headers {
  const headers = buildProviderHeaders(input);
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${input.apiKey}`);
  if (!headers.has('x-api-key')) headers.set('x-api-key', input.apiKey);
  return headers;
}

export function providerCompletionUrl(api: ModelProviderApi, baseUrl: string): string {
  const base = normalizeProviderBaseUrl(api, baseUrl);
  if (api === 'anthropic-messages') return `${base}/v1/messages`;
  if (api === 'openai-responses') return `${base}/responses`;
  return `${base}/chat/completions`;
}

/**
 * Model-list candidate URLs in attempt order, with the protocol's native endpoint first. Anthropic
 * Messages-compatible gateways often implement only `/v1/messages`: DeepSeek serves Messages
 * compatibility under a subpath of `https://api.deepseek.com`, while its model list is at root
 * `/models`. If the native endpoint is missing, also provide same-base and prefix-stripped
 * OpenAI-style candidates.
 */
export function providerModelsUrls(api: ModelProviderApi, baseUrl: string): [string, ...string[]] {
  const base = normalizeProviderBaseUrl(api, baseUrl);
  if (api !== 'anthropic-messages') return [`${base}/models`];
  const primary = `${base}/v1/models`;
  const fallbacks = [`${base}/models`, originModelsUrl(base)].filter((url): url is string =>
    Boolean(url),
  );
  return [primary, ...new Set(fallbacks)];
}

function originModelsUrl(base: string): string | undefined {
  try {
    return `${new URL(base).origin}/models`;
  } catch {
    return undefined;
  }
}

export function normalizeProviderBaseUrl(api: ModelProviderApi, baseUrl: string): string {
  let base = baseUrl.replace(/\/+$/u, '');
  if (api === 'anthropic-messages') {
    if (base.endsWith('/v1/messages')) base = base.slice(0, -'/v1/messages'.length);
    else if (base.endsWith('/messages')) base = base.slice(0, -'/messages'.length);
    if (base.endsWith('/v1')) base = base.slice(0, -'/v1'.length);
    return base;
  }
  if (base.endsWith('/chat/completions')) base = base.slice(0, -'/chat/completions'.length);
  else if (base.endsWith('/responses')) base = base.slice(0, -'/responses'.length);
  return base;
}

export function mergeProviderHeaders(
  ...records: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const merged = new Map<string, { name: string; value: string }>();
  for (const record of records) {
    for (const [name, value] of Object.entries(record ?? {})) {
      merged.set(name.toLowerCase(), { name, value });
    }
  }
  return merged.size > 0
    ? Object.fromEntries([...merged.values()].map(({ name, value }) => [name, value]))
    : undefined;
}
