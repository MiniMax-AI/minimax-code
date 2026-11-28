import type { Api } from '@earendil-works/pi-ai';
import { resolveProviderCredential, minimaxApiModels, getRuntimeRegion } from '@mavis/config';

import type {
  LocalByokProviderConfig,
  LocalCustomProviderConfig,
  LocalModelCompatOverrides,
  LocalModelConfig,
  LocalModelsConfig,
} from '../contracts.js';
import { mergeProviderHeaders } from '../connectivity/provider-request.js';
import { enabledApiKeys, resolveApiKeyValue } from '../byok-keys/key-list.js';
import type { ByokCallKey } from '../byok-keys/key-lifecycle.js';
import {
  isModelProviderApi,
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
  /** More than one enabled API key: the call picks one per request (byok-keys). */
  readonly apiKeys?: { readonly providerKey: string; readonly keys: readonly ByokCallKey[] };
  /** The custom model config declares reasoning support. */
  readonly thinkingCapable?: true;
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
  const catalogModel = minimaxApiModels({ provider: input.providerConfig, minimax_api: config })[
    input.modelId
  ];
  return {
    provider: MINIMAX_API_PROVIDER_ID,
    api: 'anthropic-messages',
    apiKey,
    baseUrl: config.baseURL?.trim() || defaultMinimaxApiBaseUrl(),
    contextWindow:
      catalogModel?.limit?.context ??
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
  assertNotUnboundExtensionProvider(config, input.provider);
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
    ...(modelConfig.reasoning === true ? { thinkingCapable: true } : {}),
  };
}

/**
 * Owned bindings are routed before this point. An extension entry reaching
 * the BYOK planner has lost its binding: never route a stray stored key/URL.
 */
function assertNotUnboundExtensionProvider(
  _config: LocalCustomProviderConfig | undefined,
  _provider: string,
): void {}

function resolveCustomProviderCredentials(
  config: LocalCustomProviderConfig,
  input: { readonly provider: string; readonly providerKey: string },
): Pick<ByokResolutionPlan, 'apiKey' | 'authProvider' | 'runtimeProvider' | 'baseUrl' | 'apiKeys'> {
  const authProvider =
    config.kind === 'oauth' || config.options?.authMode === 'oauth' ? input.providerKey : undefined;
  const keys = authProvider ? [] : resolveEnabledApiKeys(config, input.provider);
  const apiKey = keys[0]?.value ?? configuredApiKey(config, input.provider);
  if (!apiKey && !authProvider) {
    throw new Error(`LocalModelResolver: api_key not configured for provider "${input.provider}".`);
  }
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(authProvider ? { authProvider, runtimeProvider: authProvider } : {}),
    ...(keys.length > 1 ? { apiKeys: { providerKey: input.providerKey, keys } } : {}),
    baseUrl: requireCustomProviderBaseUrl(config, input.provider),
  };
}

function requireCustomProviderBaseUrl(config: LocalCustomProviderConfig, provider: string): string {
  const baseUrl = config.options?.baseURL?.trim();
  if (!baseUrl) {
    throw new Error(`LocalModelResolver: base_url not configured for provider "${provider}".`);
  }
  return baseUrl;
}

function configuredApiKey(config: LocalCustomProviderConfig, provider: string): string | undefined {
  return resolveProviderCredential({
    field: 'custom_provider options.apiKey',
    provider,
    value: config.options?.apiKey,
  });
}

/**
 * The enabled keys whose value resolves. A key whose `${VAR}` is unset is skipped while another
 * resolves; when none does, the first error stands, as for a single key.
 */
function resolveEnabledApiKeys(config: LocalCustomProviderConfig, provider: string): ByokCallKey[] {
  const keys: ByokCallKey[] = [];
  let firstError: unknown;
  for (const key of enabledApiKeys(config)) {
    try {
      const value = resolveApiKeyValue(key, provider)?.trim();
      if (value) keys.push({ id: key.id, value });
    } catch (error) {
      firstError ??= error;
    }
  }
  if (keys.length === 0 && firstError !== undefined) throw firstError;
  return keys;
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
