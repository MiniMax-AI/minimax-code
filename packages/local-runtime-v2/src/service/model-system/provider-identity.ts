import type { LocalCustomProviderConfig } from './contracts.js';

/** OAuth providers (and retired `borrowed` entries) are not API-key identities, even with stray key fields. */
export function isApiKeyProvider(
  provider: LocalCustomProviderConfig | undefined,
): provider is LocalCustomProviderConfig {
  return (
    !!provider &&
    provider.kind !== 'borrowed' &&
    provider.kind !== 'oauth' &&
    provider.options?.authMode !== 'oauth' &&
    provider.api !== 'openai-codex-responses'
  );
}

export function normalizeProviderIdentityBaseUrl(baseUrl: string): string {
  let trimmed = baseUrl.trim();
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}
