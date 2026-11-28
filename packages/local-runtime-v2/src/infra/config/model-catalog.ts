import { getModels, getProviders, type Api, type Model } from '@earendil-works/pi-ai';

const FALLBACK_MODEL_LIMITS = {
  contextWindow: 200_000,
  maxTokens: 128_000,
} as const;

export const DEFAULT_LOCAL_PI_API: Api = 'anthropic-messages';

export function lookupLocalModelLimits(
  provider: string,
  modelId: string,
): {
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly fromCatalog: boolean;
  readonly api?: Api;
  readonly baseUrl?: string;
} {
  const entry = lookupLocalCatalogModel(provider, modelId);
  if (!entry) return { ...FALLBACK_MODEL_LIMITS, fromCatalog: false };
  return {
    contextWindow: positive(entry.contextWindow) || FALLBACK_MODEL_LIMITS.contextWindow,
    maxTokens: positive(entry.maxTokens) || FALLBACK_MODEL_LIMITS.maxTokens,
    fromCatalog: true,
    ...(entry.api ? { api: entry.api } : {}),
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
  };
}

function lookupLocalCatalogModel(provider: string, modelId: string): Model<Api> | undefined {
  const knownProvider = getProviders().find((candidate) => candidate === provider);
  if (!knownProvider) return undefined;
  return getModels(knownProvider).find((model) => model.id === modelId);
}

function positive(value: unknown): number {
  return typeof value === 'number' && value > 0 ? value : 0;
}

export { lookupLocalCatalogModel };
export { positive };
