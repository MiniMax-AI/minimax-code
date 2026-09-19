import type { LocalModelConfig, LocalRuntimeConfig } from '../config/types.js';
import { MINIMAX_API_PROVIDER_ID, parseProviderId } from '../config/model-key.js';
import { minimaxApiBaseUrl, minimaxApiModels } from './minimax-api.js';
import {
  modelCacheStatusFor,
  modelConfigFingerprint,
  type ModelCacheData,
  type ModelCacheStatusEntry,
} from './model-cache.js';
import {
  mergeProviderHeaders,
  normalizeProviderBaseUrl,
  type ModelProviderApi,
} from './provider-request.js';

export function byokModelTestStatus(
  config: LocalRuntimeConfig,
  cache: ModelCacheData,
  providerId: string,
  modelId: string,
): ModelCacheStatusEntry | undefined {
  const parsed = parseProviderId(providerId);
  if (parsed?.source === 'minimax_api') {
    const apiKey = config.minimax_api?.apiKey?.trim();
    const model = minimaxApiModels(config)[modelId];
    if (!apiKey || !model) return undefined;
    const fingerprint = modelConnectionTestFingerprint(
      {
        api: 'anthropic-messages',
        baseUrl: normalizeProviderBaseUrl('anthropic-messages', minimaxApiBaseUrl(config)),
        apiKey,
        modelId,
        ...(config.minimax_api?.headers ? { headers: config.minimax_api.headers } : {}),
      },
      model,
    );
    return modelCacheStatusFor(cache, MINIMAX_API_PROVIDER_ID, modelId, fingerprint);
  }
  if (parsed?.source !== 'custom_provider') return undefined;
  const provider = config.custom_provider?.[parsed.providerKey];
  const apiKey = provider?.options?.apiKey?.trim();
  const baseUrl = provider?.options?.baseURL?.trim();
  const model = provider?.models?.[modelId];
  if (!provider || provider.enabled === false || !apiKey || !baseUrl || !model) return undefined;
  const api = (provider.api?.trim() || 'anthropic-messages') as ModelProviderApi;
  const headers = mergeProviderHeaders(provider.options?.headers, model.headers);
  const fingerprint = modelConnectionTestFingerprint(
    {
      api,
      baseUrl: normalizeProviderBaseUrl(api, baseUrl),
      apiKey,
      modelId,
      ...(headers ? { headers } : {}),
    },
    model,
  );
  return modelCacheStatusFor(cache, providerId, modelId, fingerprint);
}

/**
 * Fingerprint only fields exercised by the text connectivity probe.
 * Attachment declarations are persisted capabilities and are intentionally
 * excluded because the probe never uploads an attachment.
 */
export function modelConnectionTestFingerprint(
  target: unknown,
  model: LocalModelConfig | undefined,
): string {
  if (!model) return modelConfigFingerprint({ target, model });
  const testedModel = { ...model };
  delete testedModel.attachment;
  delete testedModel.configuration_source;
  delete testedModel.modalities;
  return modelConfigFingerprint({ target, model: testedModel });
}
