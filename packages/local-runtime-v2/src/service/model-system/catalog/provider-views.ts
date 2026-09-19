// Sanitized provider views for the three model sources. Everything returned
// from here is API-response-safe: keys appear as `maskedApiKey` for display
// API keys remain write-only across this boundary.
import { maskSecret } from '../secret.js';
import {
  CUSTOM_PROVIDER_ID_PREFIX,
  MINIMAX_API_PROVIDER_ID,
  formatModelKey,
  parseSourceQualifiedModelKey,
} from '../resolution/model-key.js';
import type {
  LocalCustomProviderConfig,
  LocalModelConfig,
  LocalProviderConfig,
  LocalRuntimeConfig,
  ModelProviderSource,
  ModelProviderView,
} from '../contracts.js';
import { byokModelTestStatus, modelConnectionTestFingerprint } from './config-fingerprint.js';
import {
  MINIMAX_API_FORMAT,
  MINIMAX_API_PROVIDER_NAME,
  builtinProviderKind,
  buildModelEntry,
  cacheStatusView,
  customProviderKind,
  minimaxApiBaseUrl,
  minimaxApiModels,
  type ModelCacheStatusView,
  type ModelProviderKind,
  type ModelProviderModelEntry,
} from './list-models.js';
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
} from '../connectivity/provider-request.js';

export type { ModelProviderView } from '../contracts.js';

export function buildBuiltinProviderView(
  config: LocalRuntimeConfig,
  cache: ModelCacheData,
  providerId: string,
  provider: LocalProviderConfig,
): ModelProviderView {
  const apiKey = provider.options?.apiKey?.trim();
  const providerName = provider.name ?? providerId;
  const providerKind = builtinProviderKind(config, providerId, provider);
  const models =
    providerId === 'minimax' && config.minimaxModelSource === 'minimax_api_key'
      ? minimaxApiModels(config)
      : (provider.models ?? {});
  return {
    providerId,
    name: providerName,
    source: 'provider',
    kind: providerKind,
    enabled: true,
    ...(provider.options?.baseURL ? { baseUrl: provider.options.baseURL } : {}),
    hasApiKey: Boolean(apiKey),
    ...(apiKey ? { maskedApiKey: maskSecret(apiKey) } : {}),
    models: providerModelEntries(config, cache, {
      providerId,
      models,
      providerSource: 'provider',
      providerKind,
      providerName,
      statusForModel: (modelId, model) =>
        customModelStatus({ cache, providerId, provider, modelId, model }),
    }),
    ...(fingerprintedProviderStatus(cache, providerId, provider) ?? {}),
  };
}

export function buildMinimaxProviderView(
  config: LocalRuntimeConfig,
  cache: ModelCacheData,
): ModelProviderView {
  const apiKey = config.minimax_api?.apiKey?.trim();
  return {
    providerId: MINIMAX_API_PROVIDER_ID,
    name: MINIMAX_API_PROVIDER_NAME,
    source: 'minimax_api',
    kind: 'minimax-api-key',
    enabled: true,
    baseUrl: minimaxApiBaseUrl(config),
    apiFormat: MINIMAX_API_FORMAT,
    ...(config.minimax_api?.headers
      ? { headerNames: Object.keys(config.minimax_api.headers).sort() }
      : {}),
    hasApiKey: Boolean(apiKey),
    ...(apiKey ? { maskedApiKey: maskSecret(apiKey) } : {}),
    models: providerModelEntries(config, cache, {
      providerId: MINIMAX_API_PROVIDER_ID,
      models: minimaxApiModels(config),
      providerSource: 'minimax_api',
      providerKind: 'minimax-api-key',
      providerName: MINIMAX_API_PROVIDER_NAME,
      statusForModel: (modelId) =>
        byokModelTestStatus(config, cache, MINIMAX_API_PROVIDER_ID, modelId),
    }),
    ...(minimaxProviderStatus(config, cache) ?? {}),
  };
}

export function buildCustomProviderView(
  config: LocalRuntimeConfig,
  cache: ModelCacheData,
  providerKey: string,
  provider: LocalCustomProviderConfig,
): ModelProviderView {
  const providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
  const apiKey = provider.options?.apiKey?.trim();
  const providerName = provider.name ?? providerKey;
  const providerKind = customProviderKind(provider);
  return {
    providerId,
    name: providerName,
    source: 'custom_provider',
    kind: providerKind,
    enabled: provider.enabled !== false,
    ...(provider.options?.baseURL ? { baseUrl: provider.options.baseURL } : {}),
    ...(provider.api ? { apiFormat: provider.api } : {}),
    hasApiKey: Boolean(apiKey),
    ...(apiKey ? { maskedApiKey: maskSecret(apiKey) } : {}),
    ...(provider.options?.headers
      ? { headerNames: Object.keys(provider.options.headers).sort() }
      : {}),
    configRevision: modelConfigFingerprint(provider),
    models: providerModelEntries(config, cache, {
      providerId,
      models: provider.models ?? {},
      providerSource: 'custom_provider',
      providerKind,
      providerName,
      statusForModel: (modelId, model) =>
        customModelStatus({ cache, providerId, provider, modelId, model }),
    }),
    ...(fingerprintedProviderStatus(cache, providerId, provider) ?? {}),
  };
}

function providerModelEntries(
  config: LocalRuntimeConfig,
  cache: ModelCacheData,
  input: {
    providerId: string;
    models: Record<string, LocalModelConfig>;
    providerSource: ModelProviderSource;
    providerKind: ModelProviderKind;
    providerName: string;
    statusForModel?: (
      modelId: string,
      model: LocalModelConfig,
    ) => ModelCacheStatusEntry | undefined;
  },
): ModelProviderModelEntry[] {
  const selected = parseSourceQualifiedModelKey(config.defaultModel);
  return Object.entries(input.models).map(([modelId, model]) =>
    buildModelEntry({
      providerId: input.providerId,
      modelId,
      model,
      selected: selected?.providerId === input.providerId && selected?.modelId === modelId,
      providerSource: input.providerSource,
      providerKind: input.providerKind,
      providerName: input.providerName,
      status: input.statusForModel
        ? input.statusForModel(modelId, model)
        : cache.model_status[formatModelKey(input.providerId, modelId)],
    }),
  );
}

function customModelStatus(input: {
  cache: ModelCacheData;
  providerId: string;
  provider: LocalCustomProviderConfig;
  modelId: string;
  model: LocalModelConfig;
}): ModelCacheStatusEntry | undefined {
  const fingerprint = customModelFingerprint(input.provider, input.modelId, input.model);
  return fingerprint
    ? modelCacheStatusFor(input.cache, input.providerId, input.modelId, fingerprint)
    : undefined;
}

// A provider-level test runs against the provider's first model, so the cached
// provider status is only meaningful while that model's effective request
// configuration is unchanged. Editing base_url, api_key, headers or the api
// format must retire the cached verdict instead of leaving a stale green badge
// behind — the same rule the per-model entries already follow.
function fingerprintedProviderStatus(
  cache: ModelCacheData,
  providerId: string,
  provider: LocalCustomProviderConfig,
): { status: ModelCacheStatusView } | undefined {
  const firstModel = Object.entries(provider.models ?? {})[0];
  if (!firstModel) return undefined;
  const fingerprint = customModelFingerprint(provider, firstModel[0], firstModel[1]);
  const entry = cache.provider_status[providerId];
  if (!fingerprint || entry?.config_fingerprint !== fingerprint) return undefined;
  const view = cacheStatusView(entry);
  return view ? { status: view } : undefined;
}

function customModelFingerprint(
  provider: LocalCustomProviderConfig,
  modelId: string,
  model: LocalModelConfig,
): string | undefined {
  const apiKey = provider.options?.apiKey?.trim();
  const baseUrl = provider.options?.baseURL?.trim();
  if (!apiKey || !baseUrl) return undefined;
  const api = (provider.api?.trim() || 'anthropic-messages') as ModelProviderApi;
  const headers = mergeProviderHeaders(provider.options?.headers, model.headers);
  return modelConnectionTestFingerprint(
    {
      api,
      baseUrl: normalizeProviderBaseUrl(api, baseUrl),
      apiKey,
      modelId,
      ...(headers ? { headers } : {}),
    },
    model,
  );
}

// Provider tests use the first catalog model. Ignore per-model cache entries here.
function minimaxProviderStatus(
  config: LocalRuntimeConfig,
  cache: ModelCacheData,
): { status: ModelCacheStatusView } | undefined {
  const modelId = Object.keys(minimaxApiModels(config))[0];
  if (!modelId) return undefined;
  const view = cacheStatusView(
    byokModelTestStatus(
      config,
      { ...cache, model_status: {} },
      MINIMAX_API_PROVIDER_ID,
      modelId,
    ),
  );
  return view ? { status: view } : undefined;
}
