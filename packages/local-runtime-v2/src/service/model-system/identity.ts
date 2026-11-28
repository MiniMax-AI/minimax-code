import {
  CUSTOM_PROVIDER_ID_PREFIX,
  MANAGED_MINIMAX_PROVIDER_ID,
  MINIMAX_API_PROVIDER_ID,
} from '@mavis/config';

export { CUSTOM_PROVIDER_ID_PREFIX, MANAGED_MINIMAX_PROVIDER_ID, MINIMAX_API_PROVIDER_ID };

export const OPENAI_CODEX_PROVIDER_ID = 'openai-codex';

export const MODEL_PROVIDER_SOURCES = ['provider', 'minimax_api', 'custom_provider'] as const;
export type ModelProviderSource = (typeof MODEL_PROVIDER_SOURCES)[number];

/**
 * The generic BYOK wire protocols: a user-supplied base URL plus a bearer or
 * `x-api-key` credential that this runtime drives itself. Membership decides
 * base-URL normalization, connection-test and discovery URL shapes, and whether
 * a Thinking request patch is synthesized for the provider.
 *
 * `openai-codex-responses` is deliberately excluded even though
 * `LocalCustomProviderConfig.api` accepts it. The Codex OAuth provider is not a
 * generic endpoint: its credentials, base URL and reasoning controls are owned
 * by Pi's dedicated Codex transport, so this runtime must not rewrite its base
 * URL or inject a BYOK Thinking patch. Its Thinking level is still resolved and
 * exposed through the ordinary non-`anthropic-messages` path.
 */
export const MODEL_PROVIDER_APIS = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'google-generative-ai',
] as const;
export type ModelProviderApi = (typeof MODEL_PROVIDER_APIS)[number];

const MODEL_PROVIDER_API_SET = new Set<string>(MODEL_PROVIDER_APIS);

export function isModelProviderApi(value: string): value is ModelProviderApi {
  return MODEL_PROVIDER_API_SET.has(value);
}
