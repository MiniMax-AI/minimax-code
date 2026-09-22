import {
  getRuntimePresetKey,
  listRouteModelIds,
  resolveProviderAuthMode,
  probeProviderCredential,
} from '@mavis/config';

import type {
  LocalCustomProviderConfig,
  LocalModelConfig,
  LocalProviderConfig,
  LocalRuntimeConfig,
} from '../config/types.js';
import {
  CUSTOM_PROVIDER_ID_PREFIX,
  MINIMAX_API_PROVIDER_ID,
  formatModelKey,
  parseProviderId,
} from '../config/model-key.js';
import { type ModelCacheData, type ModelCacheStatusEntry } from './model-cache.js';
import { byokModelTestStatus } from './config-fingerprint.js';
import {
  MINIMAX_API_DEFAULT_BASE_URL,
  MINIMAX_API_FORMAT,
  MINIMAX_API_PROVIDER_NAME,
  minimaxApiBaseUrl,
  minimaxApiModels,
} from './minimax-api.js';
import { normalizeModelThinkingEffortOptions } from './thinking.js';

export {
  MINIMAX_API_DEFAULT_BASE_URL,
  MINIMAX_API_FORMAT,
  MINIMAX_API_PROVIDER_NAME,
  minimaxApiBaseUrl,
  minimaxApiModels,
};

export type ModelProviderKind = 'minimax-managed' | 'minimax-api-key' | 'oauth' | 'custom';

export function customProviderKind(provider: LocalCustomProviderConfig): ModelProviderKind {
  return provider.kind === 'oauth' || provider.options?.authMode === 'oauth' ? 'oauth' : 'custom';
}

export function builtinProviderKind(
  config: LocalRuntimeConfig,
  providerId: string,
  provider: LocalProviderConfig,
): ModelProviderKind {
  const authMode = resolveProviderAuthMode({
    authMode: provider.options?.authMode,
    baseURL: provider.options?.baseURL,
  }).authMode;
  if (authMode === 'oauth') return 'oauth';
  return authMode === 'managed-login' &&
    !(providerId === 'minimax' && config.minimaxModelSource === 'minimax_api_key')
    ? 'minimax-managed'
    : 'minimax-api-key';
}

export function hasMinimaxApiKey(config: LocalRuntimeConfig): boolean {
  return probeProviderCredential({
    field: 'minimax_api.apiKey',
    provider: 'minimax_api',
    value: config.minimax_api?.apiKey,
  }).configured;
}

/** Models the builtin provider can route under the active runtime preset. */
export function routeModelEntries(
  config: LocalRuntimeConfig,
  providerId: string,
  provider: LocalProviderConfig,
): Array<[string, LocalModelConfig]> {
  const usesMinimaxApiCatalog =
    providerId === MINIMAX_API_PROVIDER_ID ||
    (providerId === 'minimax' && config.minimaxModelSource === 'minimax_api_key');
  const configured = usesMinimaxApiCatalog ? minimaxApiModels(config) : (provider.models ?? {});
  const fallback = providerId === 'minimax' ? minimaxApiModels(config) : {};
  return listRouteModelIds(config, providerId, getRuntimePresetKey()).flatMap((modelId) => {
    const model = configured[modelId] ?? fallback[modelId];
    return model ? [[modelId, model] as [string, LocalModelConfig]] : [];
  });
}

export function modelConfigForRef(
  config: LocalRuntimeConfig,
  provider: string,
  modelId: string,
): LocalModelConfig | undefined {
  const parsed = parseProviderId(provider);
  if (
    parsed?.source === 'minimax_api' ||
    (provider === 'minimax' && config.minimaxModelSource === 'minimax_api_key')
  ) {
    return minimaxApiModels(config)[modelId];
  }
  if (parsed?.source === 'custom_provider') {
    return config.custom_provider?.[parsed.providerKey]?.models?.[modelId];
  }
  return config.provider?.[provider]?.models?.[modelId];
}
export function enabledCustomProviders(
  config: LocalRuntimeConfig,
): Array<[string, LocalCustomProviderConfig]> {
  return Object.entries(config.custom_provider ?? {}).filter(
    ([, provider]) => provider.enabled !== false,
  );
}

export interface ModelCacheStatusView {
  state: string;
  lastTestedAt?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export function cacheStatusView(
  entry: ModelCacheStatusEntry | undefined,
): ModelCacheStatusView | undefined {
  if (!entry) return undefined;
  return {
    state: entry.state,
    ...(entry.last_tested_at !== undefined ? { lastTestedAt: entry.last_tested_at } : {}),
    ...(entry.last_error_code ? { lastErrorCode: entry.last_error_code } : {}),
    ...(entry.last_error_message ? { lastErrorMessage: entry.last_error_message } : {}),
  };
}

export function normalizeModelThinkingConfig(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  if (mode !== 'switchable' && mode !== 'forced_on' && mode !== 'forced_off' && mode !== 'hidden') {
    return undefined;
  }
  const out: Record<string, unknown> = { mode };
  const defaultValue = record.default_value ?? record.defaultValue;
  if (mode === 'switchable' && (defaultValue === 'true' || defaultValue === 'false')) {
    out.default_value = defaultValue;
  }
  return out;
}

export function normalizeSupportedVariants(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const variants = Object.entries(value as Record<string, { disabled?: unknown }>)
    .filter(([, config]) => config?.disabled !== true)
    .map(([variant]) => (variant === 'none-thinking' ? '' : variant));
  return variants.length > 0 ? Array.from(new Set(variants)) : undefined;
}

function normalizeThinkingVariant(value: unknown): string | undefined {
  if (value === 'thinking') return 'thinking';
  if (value === '' || value === 'none-thinking') return '';
  return undefined;
}

export function defaultThinkingVariant(
  value: unknown,
  defaultVariant: unknown,
): string | undefined {
  const config = normalizeModelThinkingConfig(value);
  if (!config) return undefined;
  switch (config.mode) {
    case 'forced_on':
      return 'thinking';
    case 'forced_off':
      return '';
    case 'switchable':
      return (
        normalizeThinkingVariant(defaultVariant) ??
        (config.default_value === 'true' ? 'thinking' : '')
      );
    default:
      return undefined;
  }
}

export interface ModelProviderModelEntry extends Record<string, unknown> {
  providerId: string;
  modelId: string;
  displayName: string;
  configurationSource?: 'manual' | 'discovered';
  enabled: boolean;
  selected: boolean;
  providerSource: 'provider' | 'minimax_api' | 'custom_provider';
  providerKind: ModelProviderKind;
  providerName: string;
  contextWindowOptions?: number[];
  contextWindowOptionHints?: Record<string, 'higher_usage'>;
  defaultEffort?: string;
  modalities?: { input?: string[]; output?: string[] };
}

export interface BuildModelEntryInput {
  providerId: string;
  modelId: string;
  model: LocalModelConfig;
  selected: boolean;
  /** Only meaningful when selected: explicit session/selection variant. */
  selectionVariant?: string | null;
  hasSelectionVariant?: boolean;
  providerSource: 'provider' | 'minimax_api' | 'custom_provider';
  providerKind: ModelProviderKind;
  providerName: string;
  status?: ModelCacheStatusEntry;
  implicitCustomProviderThinking?: boolean;
}

export function buildModelEntry(input: BuildModelEntryInput): ModelProviderModelEntry {
  const { model } = input;
  const effortOptions = normalizeModelThinkingEffortOptions(model.thinking?.effortOptions);
  const configuredDefaultEffort = model.thinking?.defaultEffort?.trim();
  const defaultEffort =
    configuredDefaultEffort && effortOptions?.includes(configuredDefaultEffort)
      ? configuredDefaultEffort
      : undefined;
  const contextLimit =
    typeof model.limit?.context === 'number' &&
    Number.isFinite(model.limit.context) &&
    model.limit.context > 0
      ? model.limit.context
      : undefined;
  const contextWindowOptions = normalizeContextWindowOptions(
    model.contextWindowOptions,
    contextLimit,
  );
  const contextWindowOptionHints =
    input.providerKind === 'minimax-managed'
      ? normalizeContextWindowOptionHints(model.contextWindowOptionHints, contextWindowOptions)
      : undefined;
  const thinkingConfig =
    normalizeModelThinkingConfig(model.thinking_config) ??
    (input.implicitCustomProviderThinking === true &&
    input.providerSource === 'custom_provider' &&
    model.reasoning !== false
      ? { mode: 'switchable', default_value: 'false' }
      : undefined);
  const supportedVariants = normalizeSupportedVariants(model.variants);
  const variant =
    input.selected && input.hasSelectionVariant
      ? (input.selectionVariant ?? undefined)
      : defaultThinkingVariant(thinkingConfig, model.defaultVariant);
  const status = cacheStatusView(input.status);
  const configurationSource =
    model.configuration_source === 'manual' || model.configuration_source === 'discovered'
      ? model.configuration_source
      : undefined;
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    modelConfigId: formatModelKey(input.providerId, input.modelId),
    displayName: typeof model.name === 'string' ? model.name : input.modelId,
    ...(configurationSource ? { configurationSource } : {}),
    enabled: model.enabled !== false,
    selected: input.selected,
    ...(contextLimit === undefined ? {} : { contextLimit }),
    ...(contextWindowOptions ? { contextWindowOptions } : {}),
    ...(contextWindowOptionHints ? { contextWindowOptionHints } : {}),
    ...(model.limit?.output ? { maxOutputTokens: model.limit.output } : {}),
    ...(effortOptions ? { effortOptions } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(model.modalities
      ? {
          modalities: {
            ...(model.modalities.input ? { input: [...model.modalities.input] } : {}),
            ...(model.modalities.output ? { output: [...model.modalities.output] } : {}),
          },
        }
      : {}),
    ...(supportedVariants ? { supportedVariants } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
    ...(variant !== undefined ? { variant } : {}),
    providerSource: input.providerSource,
    providerKind: input.providerKind,
    providerName: input.providerName,
    ...(status ? { status } : {}),
  };
}

function normalizeContextWindowOptionHints(
  value: unknown,
  options: number[] | undefined,
): Record<string, 'higher_usage'> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !options) return undefined;
  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    entries.some(
      ([key, hint]) =>
        hint !== 'higher_usage' || String(Number(key)) !== key || !options.includes(Number(key)),
    )
  ) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, 'higher_usage'>;
}

function normalizeContextWindowOptions(
  value: unknown,
  contextLimit: number | undefined,
): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (
    value.some((item) => !Number.isSafeInteger(item) || item <= 0) ||
    new Set(value).size !== value.length ||
    (contextLimit !== undefined && !value.includes(contextLimit))
  ) {
    return undefined;
  }
  return [...value];
}

export interface ByokModelSelection {
  providerId?: string;
  modelId?: string;
  variant?: string | null;
  hasVariant?: boolean;
}

/**
 * Models contributed by enabled custom providers. Entries mirror the builtin
 * model list shape plus source metadata and cached test status.
 *
 * Note: minimax_api models are no longer listed separately — minimax builtin
 * models cover the same catalog, and source routing is handled by the resolver.
 */
export function listByokRuntimeModels(
  config: LocalRuntimeConfig,
  selection?: ByokModelSelection,
  cache?: ModelCacheData,
  options: { implicitCustomProviderThinking?: boolean } = {},
): ModelProviderModelEntry[] {
  const entries: ModelProviderModelEntry[] = [];
  const isSelected = (providerId: string, modelId: string) =>
    providerId === selection?.providerId && modelId === selection?.modelId;
  const statusFor = (providerId: string, modelId: string) =>
    cache ? byokModelTestStatus(config, cache, providerId, modelId) : undefined;

  for (const [providerKey, provider] of enabledCustomProviders(config)) {
    const providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
    const providerKind = customProviderKind(provider);
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (model.enabled === false) continue;
      entries.push(
        buildModelEntry({
          providerId,
          modelId,
          model,
          selected: isSelected(providerId, modelId),
          selectionVariant: selection?.variant,
          hasSelectionVariant: selection?.hasVariant ?? false,
          providerSource: 'custom_provider',
          providerKind,
          providerName: provider.name ?? providerKey,
          status: statusFor(providerId, modelId),
          ...options,
        }),
      );
    }
  }

  return entries;
}
