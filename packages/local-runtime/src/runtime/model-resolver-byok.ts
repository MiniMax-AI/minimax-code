// BYOK source resolution planning for the model resolver: turns a
// source-qualified provider reference (`minimax_api`, `custom_provider:<key>`)
// into concrete credentials + limits, without touching the legacy provider
// tree path. Custom providers never consult the Pi catalog by name; missing
// limits use the dedicated BYOK fallbacks (not the legacy 2048 default).
import type { Api } from '@earendil-works/pi-ai';
import { MINIMAX_API_MODEL_CATALOG, resolveProviderCredential } from '@mavis/config';

import type {
  LocalCustomProvidersConfig,
  LocalMinimaxApiConfig,
  LocalModelsConfig,
} from '../config/types.js';
import { MINIMAX_API_DEFAULT_BASE_URL } from '../model-provider/list-models.js';
import {
  mergeProviderHeaders,
  normalizeProviderBaseUrl,
  type ModelProviderApi,
} from '../model-provider/provider-request.js';

export interface LocalByokProviderConfig {
  minimax_api?: LocalMinimaxApiConfig;
  custom_provider?: LocalCustomProvidersConfig;
  minimaxModelSource?: 'token_plan' | 'minimax_api_key';
}

export const BYOK_FALLBACK_MODEL_LIMITS = {
  contextWindow: 200_000,
  maxTokens: 16_384,
} as const;

export interface ByokResolutionPlan {
  provider: string;
  api: Api;
  apiKey?: string;
  authProvider?: string;
  runtimeProvider?: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  configHeaders?: Record<string, string>;
}

type ResolvedByokResolutionPlan = Omit<ByokResolutionPlan, 'apiKey' | 'authProvider'> & {
  apiKey: string;
};

export async function resolveByokResolutionPlan(
  plan: ByokResolutionPlan,
  providerAuthGetter:
    | ((provider: string) => Promise<string | undefined> | string | undefined)
    | undefined,
): Promise<ResolvedByokResolutionPlan> {
  const { authProvider, apiKey: configuredApiKey, ...resolved } = plan;
  const apiKey = (
    authProvider ? await providerAuthGetter?.(authProvider) : configuredApiKey
  )?.trim();
  if (!apiKey) {
    throw new Error(
      authProvider
        ? `LocalModelResolver: ${authProvider} login required; no OAuth credentials found.`
        : `LocalModelResolver: api_key not configured for provider "${plan.provider}".`,
    );
  }
  return { ...resolved, apiKey };
}

export function planMinimaxApiResolution(input: {
  byok: LocalByokProviderConfig | undefined;
  providerConfig: LocalModelsConfig | undefined;
  modelId: string;
  catalog: { contextWindow: number; maxTokens: number; fromCatalog: boolean };
}): ByokResolutionPlan | undefined {
  const cfg = input.byok?.minimax_api;
  if (!cfg) return undefined;
  const apiKey = resolveProviderCredential({
    field: 'minimax_api.apiKey',
    provider: 'minimax_api',
    value: cfg.apiKey,
  });
  if (!apiKey) {
    throw new Error('LocalModelResolver: minimax_api apiKey is not configured.');
  }
  const catalogModel = MINIMAX_API_MODEL_CATALOG[input.modelId];
  const contextOverride = cfg.modelContextLimits?.[input.modelId];
  const contextLimit =
    contextOverride !== undefined && catalogModel?.contextWindowOptions?.includes(contextOverride)
      ? contextOverride
      : catalogModel?.limit?.context;
  return {
    provider: 'minimax_api',
    api: 'anthropic-messages',
    apiKey,
    baseUrl: normalizeProviderBaseUrl(
      'anthropic-messages',
      cfg.baseURL?.trim() || MINIMAX_API_DEFAULT_BASE_URL,
    ),
    contextWindow:
      contextLimit ??
      (input.catalog.fromCatalog
        ? input.catalog.contextWindow
        : BYOK_FALLBACK_MODEL_LIMITS.contextWindow),
    maxTokens:
      catalogModel?.limit?.output ??
      (input.catalog.fromCatalog ? input.catalog.maxTokens : BYOK_FALLBACK_MODEL_LIMITS.maxTokens),
  };
}

export function planCustomProviderResolution(input: {
  byok: LocalByokProviderConfig | undefined;
  provider: string;
  providerKey: string;
  modelId: string;
}): ByokResolutionPlan | undefined {
  const cfg = input.byok?.custom_provider?.[input.providerKey];
  if (!cfg) return undefined;
  // Disabled providers keep their config but must never be called.
  if (cfg.enabled === false) return undefined;
  // Custom models must come from the user's config: an unconfigured model id
  // (deleted, typo, dangling session reference) is rejected by the caller.
  const modelConfig = cfg.models?.[input.modelId];
  if (!modelConfig) return undefined;
  const authProvider =
    cfg.kind === 'oauth' || cfg.options?.authMode === 'oauth' ? input.providerKey : undefined;
  const apiKey = resolveProviderCredential({
    field: 'custom_provider options.apiKey',
    provider: input.provider,
    value: cfg.options?.apiKey,
  });
  if (!apiKey && !authProvider) {
    throw new Error(`LocalModelResolver: api_key not configured for provider "${input.provider}".`);
  }
  const baseUrl = cfg.options?.baseURL?.trim();
  if (!baseUrl) {
    throw new Error(
      `LocalModelResolver: base_url not configured for provider "${input.provider}".`,
    );
  }
  const configHeaders = mergeProviderHeaders(
    readStringRecord(cfg.options?.headers),
    readStringRecord(modelConfig.headers),
  );
  const api = resolveCustomProviderApi(cfg.api);
  return {
    provider: input.provider,
    api,
    ...(apiKey ? { apiKey } : {}),
    ...(authProvider ? { authProvider, runtimeProvider: authProvider } : {}),
    baseUrl:
      api === 'openai-codex-responses'
        ? baseUrl.replace(/\/+$/u, '')
        : normalizeProviderBaseUrl(api as ModelProviderApi, baseUrl),
    contextWindow: modelConfig.limit?.context ?? BYOK_FALLBACK_MODEL_LIMITS.contextWindow,
    maxTokens: modelConfig.limit?.output ?? BYOK_FALLBACK_MODEL_LIMITS.maxTokens,
    ...(configHeaders ? { configHeaders } : {}),
  };
}

function resolveCustomProviderApi(value: unknown): Api {
  if (
    value === 'openai-completions' ||
    value === 'openai-responses' ||
    value === 'openai-codex-responses'
  ) {
    return value;
  }
  return 'anthropic-messages';
}

export function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
