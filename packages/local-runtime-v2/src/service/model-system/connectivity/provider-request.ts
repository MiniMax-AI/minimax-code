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
  const [base, suffix] = splitProviderUrlSuffix(normalizeProviderBaseUrl(api, baseUrl));
  if (api === 'anthropic-messages') return `${base}/v1/messages${suffix}`;
  if (api === 'openai-responses') return `${base}/responses${suffix}`;
  return `${base}/chat/completions${suffix}`;
}

/**
 * Model-list candidate URLs in attempt order, with the protocol's native endpoint first. Anthropic
 * Messages-compatible gateways often implement only `/v1/messages`: DeepSeek serves Messages
 * compatibility under a subpath of `https://api.deepseek.com`, while its model list is at root
 * `/models`. If the native endpoint is missing, also provide same-base and prefix-stripped
 * OpenAI-style candidates.
 */
export function providerModelsUrls(api: ModelProviderApi, baseUrl: string): [string, ...string[]] {
  const normalized = normalizeProviderBaseUrl(api, baseUrl);
  const [base, suffix] = splitProviderUrlSuffix(normalized);
  if (api !== 'anthropic-messages') return [`${base}/models${suffix}`];
  const primary = `${base}/v1/models${suffix}`;
  const fallbacks = [`${base}/models${suffix}`, originModelsUrl(normalized)].filter(
    (url): url is string => Boolean(url),
  );
  return [primary, ...new Set(fallbacks)];
}

function originModelsUrl(base: string): string | undefined {
  try {
    const [path, suffix] = splitProviderUrlSuffix(base);
    return `${new URL(path).origin}/models${suffix}`;
  } catch {
    return undefined;
  }
}

export function normalizeProviderBaseUrl(api: ModelProviderApi, baseUrl: string): string {
  const [path, suffix] = splitProviderUrlSuffix(baseUrl);
  return `${normalizeProviderBasePath(api, path)}${suffix}`;
}

// Keep the raw query (including repeated keys and encoding) and fragment outside
// path edits. Preserve fragments for config consumers; HTTP fetch omits them.
// Splitting instead of reserializing also preserves existing base URL spelling
// and leaves validation/error handling to the existing callers.
function splitProviderUrlSuffix(baseUrl: string): [string, string] {
  const index = baseUrl.search(/[?#]/u);
  return index < 0 ? [baseUrl, ''] : [baseUrl.slice(0, index), baseUrl.slice(index)];
}

function normalizeProviderBasePath(api: ModelProviderApi, path: string): string {
  let base = path.replace(/\/+$/u, '');
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
