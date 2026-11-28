import { CUSTOM_PROVIDER_ID_PREFIX } from '../resolution/model-key.js';
import { isApiKeyProvider } from '../provider-identity.js';
import {
  LocalModelProviderError,
  type ApiKeyView,
  type LocalCustomProviderConfig,
  type UserModelProviderCandidateView,
} from '../contracts.js';
import type { ModelProviderServiceContext } from '../management/service-context.js';
import {
  apiKeyLabel,
  enabledApiKeys,
  maskApiKey,
  readApiKeys,
  resolveApiKeyValue,
  type StoredApiKey,
} from './key-list.js';
import { sharedByokKeyPool, type ApiKeyProbeView, type ByokKeyPool } from './key-pool.js';

const PROBE_ERROR_LIMIT = 300;

export function byokKeyPoolOf(context: ModelProviderServiceContext): ByokKeyPool {
  return context.deps.byokKeyPool ?? sharedByokKeyPool();
}

function statusOf(errorCode: string | undefined, message: string | undefined): number | undefined {
  const http = /^http_(\d{3})$/u.exec(errorCode ?? '');
  if (http) return Number(http[1]);
  const said = /\bHTTP (\d{3})\b/u.exec(message ?? '');
  return said ? Number(said[1]) : undefined;
}

/**
 * Tests one key of a provider draft with the smallest request the connection test sends. Only the
 * key's latest test is remembered: the key does not rest and the order is unchanged.
 */
export async function testUserModelApiKey(
  context: ModelProviderServiceContext,
  input: {
    readonly candidate: UserModelProviderCandidateView;
    readonly keyIndex: number;
    readonly modelId?: string;
  },
): Promise<ApiKeyProbeView> {
  const resolved = context.resolveUserProviderCandidate(input.candidate);
  const { key, value } = requireDraftKey(resolved, input.keyIndex);
  const modelId = input.modelId?.trim() || firstEnabledModel(resolved.provider);
  const target = context.resolveTestTarget(resolved.providerId, modelId, {
    customProviderOverride: resolved.provider,
    apiKeyOverride: value,
  });
  const pool = byokKeyPoolOf(context);
  const startedAt = pool.now();
  const result = await context.deps.tester.test(
    `${target.cacheKey}@${target.fingerprint}#${key.id}`,
    target.target,
  );
  const probe = probeView(result, {
    ms: Math.max(0, pool.now() - startedAt),
    modelId: target.target.modelId,
    at: pool.now(),
  });
  // A draft key that is not saved yet has no runtime state to keep.
  if (input.candidate.providerId && savedKey(context, resolved.providerKey, key.id))
    pool.recordProbe(resolved.providerKey, key.id, probe);
  return probe;
}

function requireDraftKey(
  resolved: ReturnType<ModelProviderServiceContext['resolveUserProviderCandidate']>,
  keyIndex: number,
): { readonly key: StoredApiKey; readonly value: string } {
  const key = Number.isInteger(keyIndex) ? readApiKeys(resolved.provider)[keyIndex] : undefined;
  if (!key) throw new LocalModelProviderError(404, 'API key not found', 'API_KEY_NOT_FOUND');
  const value = resolveApiKeyValue(key, resolved.providerId);
  if (!value) throw new LocalModelProviderError(400, 'API key is not configured', 'NO_API_KEY');
  return { key, value };
}

function probeView(
  result: { readonly ok: boolean; readonly errorCode?: string; readonly errorMessage?: string },
  facts: { readonly ms: number; readonly modelId: string; readonly at: number },
): ApiKeyProbeView {
  if (result.ok) return { ok: true, ...facts };
  const status = statusOf(result.errorCode, result.errorMessage);
  return {
    ok: false,
    ...(status ? { status } : {}),
    ...(result.errorMessage ? { error: result.errorMessage.slice(0, PROBE_ERROR_LIMIT) } : {}),
    ...facts,
  };
}

function firstEnabledModel(provider: LocalCustomProviderConfig): string | undefined {
  const entries = Object.entries(provider.models ?? {});
  return (entries.find(([, model]) => model.enabled !== false) ?? entries[0])?.[0];
}

function savedKey(
  context: ModelProviderServiceContext,
  providerKey: string,
  keyId: string,
): StoredApiKey | undefined {
  const provider = context.deps.configGetter().custom_provider?.[providerKey];
  return isApiKeyProvider(provider)
    ? readApiKeys(provider).find((key) => key.id === keyId)
    : undefined;
}

/** "Retry now": the key's rest and its latest test are cleared. */
export function unrestUserModelApiKey(
  context: ModelProviderServiceContext,
  input: { readonly providerId: string; readonly keyId: string },
): ApiKeyView {
  const providerKey = context.requireExistingProviderKey(input.providerId);
  const key = savedKey(context, providerKey, input.keyId);
  if (!key) throw new LocalModelProviderError(404, 'API key not found', 'API_KEY_NOT_FOUND');
  byokKeyPoolOf(context).clearKey(providerKey, key.id);
  return {
    id: key.id,
    ...(key.name ? { name: key.name } : {}),
    masked: maskApiKey(key),
    enabled: key.enabled,
  };
}

/** Drops runtime state of keys a save removed or whose value changed. */
export function forgetDroppedApiKeys(
  context: ModelProviderServiceContext,
  providerKey: string,
  before: readonly StoredApiKey[],
): void {
  const after = new Set(
    readApiKeys(context.deps.configGetter().custom_provider?.[providerKey]).map((key) => key.id),
  );
  const pool = byokKeyPoolOf(context);
  for (const key of before) if (!after.has(key.id)) pool.clearKey(providerKey, key.id);
}

/** The label of the key a connection test uses: always the first enabled key. */
export function byokTestKeyLabel(
  provider: LocalCustomProviderConfig | undefined,
): string | undefined {
  if (!isApiKeyProvider(provider)) return undefined;
  const first = enabledApiKeys(provider)[0];
  return first ? apiKeyLabel(first) : undefined;
}

export function savedProviderKeyLabel(
  context: ModelProviderServiceContext,
  providerId: string,
): string | undefined {
  if (!providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX)) return undefined;
  const providerKey = providerId.slice(CUSTOM_PROVIDER_ID_PREFIX.length);
  return byokTestKeyLabel(context.deps.configGetter().custom_provider?.[providerKey]);
}
