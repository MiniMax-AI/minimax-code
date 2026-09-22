import type { Api } from '@earendil-works/pi-ai';
import {
  resolveProviderCredential,
  MINIMAX_API_MODEL_CATALOG,
  getRuntimeRegion,
} from '@mavis/config';

import type {
  LocalByokProviderConfig,
  LocalCustomProviderConfig,
  LocalModelCompatOverrides,
  LocalModelConfig,
  LocalModelsConfig,
} from '../contracts.js';
import { mergeProviderHeaders } from '../connectivity/provider-request.js';
import {
  isModelProviderApi,
  MANAGED_MINIMAX_PROVIDER_ID,
  MINIMAX_API_PROVIDER_ID,
} from '../identity.js';

const BYOK_FALLBACK_MODEL_LIMITS = {
  contextWindow: 200_000,
  maxTokens: 16_384,
} as const;
const MESSAGES_API_COMPAT_PATH = '\x61\x6e\x74\x68\x72\x6f\x70\x69\x63';

export interface ByokResolutionPlan {
  readonly provider: string;
  readonly api: Api;
  readonly apiKey?: string;
  readonly authProvider?: string;
  readonly runtimeProvider?: string;
  readonly baseUrl: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly configHeaders?: Record<string, string>;
  readonly modelCompat?: LocalModelCompatOverrides;
}

export function planMinimaxApiResolution(input: {
  readonly byok: LocalByokProviderConfig | undefined;
  readonly providerConfig: LocalModelsConfig | undefined;
  readonly modelId: string;
  readonly catalog: {
    readonly contextWindow: number;
    readonly maxTokens: number;
    readonly fromCatalog: boolean;
  };
}): ByokResolutionPlan | undefined {
  const config = input.byok?.minimax_api;
  if (!config) return undefined;
  const apiKey = resolveProviderCredential({
    field: 'minimax_api.apiKey',
    provider: MINIMAX_API_PROVIDER_ID,
    value: config.apiKey,
  });
  if (!apiKey) {
    throw new Error('LocalModelResolver: minimax_api apiKey is not configured.');
  }
  const catalogModel = MINIMAX_API_MODEL_CATALOG[input.modelId];
  const contextOverride = config.modelContextLimits?.[input.modelId];
  const contextLimit =
    contextOverride !== undefined && catalogModel?.contextWindowOptions?.includes(contextOverride)
      ? contextOverride
      : catalogModel?.limit?.context;
  return {
    provider: MINIMAX_API_PROVIDER_ID,
    api: 'anthropic-messages',
    apiKey,
    baseUrl: config.baseURL?.trim() || defaultMinimaxApiBaseUrl(),
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
  readonly byok: LocalByokProviderConfig | undefined;
  readonly provider: string;
  readonly providerKey: string;
  readonly modelId: string;
}): ByokResolutionPlan | undefined {
  const config = input.byok?.custom_provider?.[input.providerKey];
  if (!config || config.enabled === false) return undefined;
  const modelConfig = config.models?.[input.modelId];
  if (!modelConfig) return undefined;
  const credentials = resolveCustomProviderCredentials(config, input);
  const configHeaders = mergeProviderHeaders(
    readStringRecord(config.options?.headers),
    readStringRecord(modelConfig.headers),
  );
  const modelCompat = readModelCompat(modelConfig.compat);
  return {
    provider: input.provider,
    api: resolveCustomProviderApi(config.api),
    ...credentials,
    ...customProviderLimits(modelConfig),
    ...(configHeaders ? { configHeaders } : {}),
    ...(modelCompat ? { modelCompat } : {}),
  };
}

function resolveCustomProviderCredentials(
  config: LocalCustomProviderConfig,
  input: { readonly provider: string; readonly providerKey: string },
): Pick<ByokResolutionPlan, 'apiKey' | 'authProvider' | 'runtimeProvider' | 'baseUrl'> {
  const authProvider =
    config.kind === 'oauth' || config.options?.authMode === 'oauth' ? input.providerKey : undefined;
  const apiKey = resolveProviderCredential({
    field: 'custom_provider options.apiKey',
    provider: input.provider,
    value: config.options?.apiKey,
  });
  if (!apiKey && !authProvider) {
    throw new Error(`LocalModelResolver: api_key not configured for provider "${input.provider}".`);
  }
  const baseUrl = config.options?.baseURL?.trim();
  if (!baseUrl) {
    throw new Error(
      `LocalModelResolver: base_url not configured for provider "${input.provider}".`,
    );
  }
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(authProvider ? { authProvider, runtimeProvider: authProvider } : {}),
    baseUrl,
  };
}

function customProviderLimits(
  modelConfig: LocalModelConfig,
): Pick<ByokResolutionPlan, 'contextWindow' | 'maxTokens'> {
  return {
    contextWindow: modelConfig.limit?.context ?? BYOK_FALLBACK_MODEL_LIMITS.contextWindow,
    maxTokens: byokEffectiveOutputLimit(modelConfig),
  };
}

/**
 * Output budget a real BYOK turn sends for this model, configured limit or
 * default. The connection probe sends the same value so it stays a dry run of
 * the first real turn; a budget rejection can then only be a real one.
 */
export function byokEffectiveOutputLimit(modelConfig: LocalModelConfig | undefined): number {
  return modelConfig?.limit?.output ?? BYOK_FALLBACK_MODEL_LIMITS.maxTokens;
}

function resolveCustomProviderApi(value: unknown): Api {
  if (
    typeof value === 'string' &&
    (isModelProviderApi(value) || value === 'openai-codex-responses')
  ) {
    return value;
  }
  return 'anthropic-messages';
}

export function firstBuiltinModel(
  providerConfig: LocalModelsConfig | undefined,
): { readonly provider: string; readonly modelId: string } | undefined {
  const preferredModelId = Object.keys(
    providerConfig?.[MANAGED_MINIMAX_PROVIDER_ID]?.models ?? {},
  )[0];
  if (preferredModelId) return { provider: MANAGED_MINIMAX_PROVIDER_ID, modelId: preferredModelId };
  return Object.entries(providerConfig ?? {}).flatMap(([provider, config]) => {
    const modelId = Object.keys(config.models ?? {})[0];
    return modelId ? [{ provider, modelId }] : [];
  })[0];
}

export function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Keys of `LocalModelCompatOverrides` whose declared value is a boolean. */
type BooleanCompatKey = {
  [K in keyof LocalModelCompatOverrides]-?: boolean extends LocalModelCompatOverrides[K]
    ? K
    : never;
}[keyof LocalModelCompatOverrides];

const BOOLEAN_COMPAT_KEYS = [
  'supportsStore',
  'supportsDeveloperRole',
  'supportsReasoningEffort',
  'supportsUsageInStreaming',
  'requiresToolResultName',
  'requiresAssistantAfterToolResult',
  'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages',
  'supportsStrictMode',
  'supportsLongCacheRetention',
  'supportsEagerToolInputStreaming',
  'supportsCacheControlOnTools',
  'supportsTemperature',
  'sendSessionAffinityHeaders',
  'sendSessionIdHeader',
  'zaiToolStream',
  'forceAdaptiveThinking',
  'allowEmptySignature',
] as const satisfies readonly BooleanCompatKey[];

const MAX_TOKENS_FIELDS = [
  'max_tokens',
  'max_completion_tokens',
] as const satisfies readonly NonNullable<LocalModelCompatOverrides['maxTokensField']>[];

const THINKING_FORMATS = [
  'openai',
  'openrouter',
  'together',
  'deepseek',
  'zai',
  'qwen',
  'qwen-chat-template',
  'string-thinking',
  'ant-ling',
] as const satisfies readonly NonNullable<LocalModelCompatOverrides['thinkingFormat']>[];

const CACHE_CONTROL_FORMATS = ['anthropic'] as const satisfies readonly NonNullable<
  LocalModelCompatOverrides['cacheControlFormat']
>[];

function readCompatEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' ? allowed.find((option) => option === value) : undefined;
}

/**
 * Read model-level compatibility overrides out of untrusted provider config.
 *
 * The `custom_provider` config subtree is persisted as opaque JSON, so each field is
 * accepted only at its declared type. A value of the wrong type is dropped rather than
 * forwarded, because pi treats any present field as an explicit override and a truthy
 * string such as `"false"` would otherwise invert the intended behavior.
 */
function readModelCompat(value: unknown): LocalModelCompatOverrides | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source: Record<string, unknown> = { ...value };
  const compat: LocalModelCompatOverrides = {};
  for (const key of BOOLEAN_COMPAT_KEYS) {
    const candidate = source[key];
    if (typeof candidate === 'boolean') compat[key] = candidate;
  }
  const maxTokensField = readCompatEnum(source.maxTokensField, MAX_TOKENS_FIELDS);
  if (maxTokensField) compat.maxTokensField = maxTokensField;
  const thinkingFormat = readCompatEnum(source.thinkingFormat, THINKING_FORMATS);
  if (thinkingFormat) compat.thinkingFormat = thinkingFormat;
  const cacheControlFormat = readCompatEnum(source.cacheControlFormat, CACHE_CONTROL_FORMATS);
  if (cacheControlFormat) compat.cacheControlFormat = cacheControlFormat;
  return Object.keys(compat).length > 0 ? compat : undefined;
}

function defaultMinimaxApiBaseUrl(): string {
  const origin =
    getRuntimeRegion() === 'cn' ? 'https://api.minimaxi.com' : 'https://api.minimax.io';
  return `${origin}/${MESSAGES_API_COMPAT_PATH}`;
}
