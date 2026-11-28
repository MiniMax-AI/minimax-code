import { MINIMAX_API_PROVIDER_ID, parseProviderId } from '../resolution/model-key.js';
import { MANAGED_MINIMAX_PROVIDER_ID } from '../identity.js';
import type { DiscoveredModel } from '../connectivity/discover-models.js';
import { customProviderKind } from '../catalog/list-models.js';
import { ModelProviderServiceContext } from './service-context.js';
import {
  LocalModelProviderError,
  type ModelProviderTestOutcome,
} from '../contracts.js';
import { enqueueProviderMutation, requireCacheStatusView } from './service-helpers.js';
import { savedProviderKeyLabel } from '../byok-keys/operations.js';

export async function testProvider(
  context: ModelProviderServiceContext,
  providerId: string,
  opts?: { apiKeyOverride?: string },
): Promise<ModelProviderTestOutcome> {
  if (parseProviderId(providerId)?.source === 'minimax_api') {
    return enqueueProviderMutation(context.minimaxMutationKey(), () =>
      testProviderNow(context, providerId, opts),
    );
  }
  return testProviderNow(context, providerId, opts);
}

async function testProviderNow(
  context: ModelProviderServiceContext,
  providerId: string,
  opts?: { apiKeyOverride?: string },
): Promise<ModelProviderTestOutcome> {
  const target = context.resolveTestTarget(providerId, undefined, {
    ...(opts?.apiKeyOverride ? { apiKeyOverride: opts.apiKeyOverride } : {}),
  });
  const result = await context.testResolvedTarget(target);
  const entry = context.toCacheEntry(result, target.fingerprint);
  await context.deps.cache.setProviderStatus(target.cacheKey, entry);
  const keyLabel = opts?.apiKeyOverride ? undefined : savedProviderKeyLabel(context, providerId);
  return {
    ok: result.ok,
    status: requireCacheStatusView(entry),
    ...(keyLabel ? { keyLabel } : {}),
  };
}

export async function testModel(
  context: ModelProviderServiceContext,
  providerId: string,
  modelId: string,
): Promise<ModelProviderTestOutcome> {
  if (parseProviderId(providerId)?.source === 'minimax_api') {
    return enqueueProviderMutation(context.minimaxMutationKey(), () =>
      testModelNow(context, providerId, modelId),
    );
  }
  return testModelNow(context, providerId, modelId);
}

async function testModelNow(
  context: ModelProviderServiceContext,
  providerId: string,
  modelId: string,
): Promise<ModelProviderTestOutcome> {
  const target = context.resolveTestTarget(providerId, modelId);
  const result = await context.testResolvedTarget(target);
  const entry = context.toCacheEntry(result, target.fingerprint);
  await context.deps.cache.setModelStatus(target.cacheKey, entry);
  const keyLabel = savedProviderKeyLabel(context, providerId);
  return {
    ok: result.ok,
    status: requireCacheStatusView(entry),
    ...(keyLabel ? { keyLabel } : {}),
  };
}

export async function discoverModels(
  context: ModelProviderServiceContext,
  providerId: string,
): Promise<DiscoveredModel[]> {
  const discoverer = context.deps.discoverer;
  if (!discoverer) {
    throw new LocalModelProviderError(
      503,
      'Model discovery is not configured',
      'MODEL_DISCOVERY_UNAVAILABLE',
    );
  }
  const target = context.resolveDiscoveryTarget(providerId);
  const result = await discoverer.discover(target);
  if (!result.ok) {
    throw new LocalModelProviderError(502, result.errorMessage, result.errorCode);
  }
  return result.models;
}

export function assertModelSelectable(
  context: ModelProviderServiceContext,
  providerId: string,
  modelId: string,
): void {
  const config = context.deps.configGetter();
  if (
    providerId === MANAGED_MINIMAX_PROVIDER_ID &&
    config.minimaxModelSource === 'minimax_api_key'
  ) {
    context.resolveTestTarget(MINIMAX_API_PROVIDER_ID, modelId);
    return;
  }
  const parsed = parseProviderId(providerId);
  if (parsed?.source === 'custom_provider') {
    const provider = config.custom_provider?.[parsed.providerKey];
    if (provider && customProviderKind(provider) === 'oauth') return;
  }
  if (parsed?.source !== 'custom_provider' && parsed?.source !== 'minimax_api') return;
  context.resolveTestTarget(providerId, modelId);
}
