import {
  getRuntimePresetKey,
  listRouteModelIds,
  probeProviderCredential,
  resolveProviderAuthMode,
} from '@mavis/config';

import type {
  LocalCustomProviderConfig,
  ModelCacheStatusView,
  LocalModelConfig,
  LocalProviderConfig,
  LocalRuntimeConfig,
  ModelProviderKind,
  ModelProviderModelEntry,
  ModelProviderSource,
  ModelThinkingConfigView,
} from '../contracts.js';
import {
  CUSTOM_PROVIDER_ID_PREFIX,
  formatModelKey,
  parseProviderId,
} from '../resolution/model-key.js';
import { MANAGED_MINIMAX_PROVIDER_ID, MINIMAX_API_PROVIDER_ID } from '../identity.js';
import { type ModelCacheData, type ModelCacheStatusEntry } from './model-cache.js';
import { byokModelTestStatus } from './config-fingerprint.js';
import {
  MINIMAX_API_DEFAULT_BASE_URL,
  MINIMAX_API_FORMAT,
  MINIMAX_API_PROVIDER_NAME,
  minimaxApiBaseUrl,
  minimaxApiModels,
} from './minimax-api.js';
import { normalizeModelThinkingEffortOptions } from '../resolution/model-ref.js';

export {
  MINIMAX_API_DEFAULT_BASE_URL,
  MINIMAX_API_FORMAT,
  MINIMAX_API_PROVIDER_NAME,
  minimaxApiBaseUrl,
  minimaxApiModels,
};
export type {
  ModelCacheStatusView,
  ModelProviderKind,
  ModelProviderModelEntry,
  ModelThinkingConfigView,
} from '../contracts.js';

const MODEL_THINKING_MODES = new Set<ModelThinkingConfigView['mode']>([
  'switchable',
  'forced_on',
  'forced_off',
  'hidden',
]);

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
    !(providerId === MANAGED_MINIMAX_PROVIDER_ID && config.minimaxModelSource === 'minimax_api_key')
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
    (providerId === MANAGED_MINIMAX_PROVIDER_ID && config.minimaxModelSource === 'minimax_api_key');
  const configured = usesMinimaxApiCatalog ? minimaxApiModels(config) : (provider.models ?? {});
  const fallback = providerId === MANAGED_MINIMAX_PROVIDER_ID ? minimaxApiModels(config) : {};
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
    (provider === MANAGED_MINIMAX_PROVIDER_ID && config.minimaxModelSource === 'minimax_api_key')
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

export function normalizeModelThinkingConfig(value: unknown): ModelThinkingConfigView | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const mode = normalizeThinkingMode(record.mode);
  if (!mode) return undefined;
  const out: ModelThinkingConfigView = { mode };
  const defaultValue = record.default_value ?? record.defaultValue;
  if (mode === 'switchable' && (defaultValue === 'true' || defaultValue === 'false')) {
    out.default_value = defaultValue;
  }
  return out;
}

function normalizeThinkingMode(value: unknown): ModelThinkingConfigView['mode'] | undefined {
  if (typeof value !== 'string') return undefined;
  const mode = value as ModelThinkingConfigView['mode'];
  return MODEL_THINKING_MODES.has(mode) ? mode : undefined;
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

export interface BuildModelEntryInput {
  providerId: string;
  modelId: string;
  model: LocalModelConfig;
  selected: boolean;
  /** Only meaningful when selected: explicit session/selection variant. */
  selectionVariant?: string | null;
  hasSelectionVariant?: boolean;
  providerSource: ModelProviderSource;
  providerKind: ModelProviderKind;
  providerName: string;
  apiFormat?: string;
  status?: ModelCacheStatusEntry;
  implicitCustomProviderThinking?: boolean;
}

export function buildModelEntry(input: BuildModelEntryInput): ModelProviderModelEntry {
  const { model } = input;
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    modelConfigId: formatModelKey(input.providerId, input.modelId),
    displayName: modelDisplayName(model, input.modelId),
    enabled: model.enabled !== false,
    selected: input.selected,
    providerSource: input.providerSource,
    providerKind: input.providerKind,
    providerName: input.providerName,
    ...(input.apiFormat ? { apiFormat: input.apiFormat } : {}),
    ...modelLimitFields(model),
    ...modelContextWindowOptionHintFields(input),
    ...modelCapabilityFields(model, input.providerKind === 'minimax-managed'),
    ...modelThinkingFields(input),
    ...modelStatusFields(input.status),
  };
}

function modelContextWindowOptionHintFields(
  input: BuildModelEntryInput,
): Partial<ModelProviderModelEntry> {
  if (input.providerKind !== 'minimax-managed') return {};
  const contextWindowOptions = normalizeContextWindowOptions(
    input.model.contextWindowOptions,
    undefined,
  );
  const value = input.model.contextWindowOptionHints;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !contextWindowOptions)
    return {};
  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    entries.some(
      ([key, hint]) =>
        hint !== 'higher_usage' ||
        String(Number(key)) !== key ||
        !contextWindowOptions.includes(Number(key)),
    )
  ) {
    return {};
  }
  return {
    contextWindowOptionHints: Object.fromEntries(entries) as Record<string, 'higher_usage'>,
  };
}

function modelDisplayName(model: LocalModelConfig, modelId: string): string {
  return typeof model.name === 'string' ? model.name : modelId;
}

function modelLimitFields(model: LocalModelConfig): Partial<ModelProviderModelEntry> {
  const fields: Partial<ModelProviderModelEntry> = {};
  const contextLimit = model.limit?.context;
  if (typeof contextLimit === 'number' && Number.isFinite(contextLimit) && contextLimit > 0) {
    fields.contextLimit = contextLimit;
    fields.defaultContextLimit = contextLimit;
  }
  const contextWindowOptions = normalizeContextWindowOptions(
    model.contextWindowOptions,
    fields.contextLimit,
  );
  if (contextWindowOptions) fields.contextWindowOptions = contextWindowOptions;
  if (model.limit?.output) fields.maxOutputTokens = model.limit.output;
  return fields;
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

function modelCapabilityFields(
  model: LocalModelConfig,
  managed: boolean,
): Partial<ModelProviderModelEntry> {
  const fields: Partial<ModelProviderModelEntry> = {};
  const configurationSource = model.configuration_source;
  if (configurationSource === 'manual' || configurationSource === 'discovered') {
    fields.configurationSource = configurationSource;
  }
  Object.assign(fields, modelEffortFields(model, managed));
  if (model.modalities) {
    fields.modalities = {
      ...(model.modalities.input ? { input: [...model.modalities.input] } : {}),
      ...(model.modalities.output ? { output: [...model.modalities.output] } : {}),
    };
  }
  return fields;
}

function modelEffortFields(
  model: LocalModelConfig,
  managed: boolean,
): Partial<ModelProviderModelEntry> {
  const fields: Partial<ModelProviderModelEntry> = {};
  const effortOptions = normalizeModelThinkingEffortOptions(model.thinking?.effortOptions);
  if (effortOptions) {
    fields.effortOptions = effortOptions;
    const defaultEffort = model.thinking?.defaultEffort?.trim();
    if (defaultEffort && effortOptions.includes(defaultEffort)) {
      fields.defaultEffort = defaultEffort;
    }
  }
  if (
    managed &&
    !model.parameterErrors?.effortOptions &&
    !effortOptions &&
    model.thinking?.defaultEffort
  ) {
    fields.defaultEffort = model.thinking.defaultEffort;
  }
  return fields;
}

function modelThinkingFields(input: BuildModelEntryInput): Partial<ModelProviderModelEntry> {
  const { model } = input;
  const thinkingConfig =
    normalizeModelThinkingConfig(model.thinking_config) ?? implicitThinkingConfig(input);
  const supportedVariants = normalizeSupportedVariants(model.variants);
  const variant = selectedModelVariant(input, thinkingConfig);
  return {
    ...(supportedVariants ? { supportedVariants } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
    ...(variant !== undefined ? { variant } : {}),
  };
}

function implicitThinkingConfig(input: BuildModelEntryInput): ModelThinkingConfigView | undefined {
  if (input.implicitCustomProviderThinking !== true) return undefined;
  if (input.providerSource !== 'custom_provider') return undefined;
  if (normalizeModelThinkingEffortOptions(input.model.thinking?.effortOptions)) {
    // Effort is the only control surface; there is no separate binary switch.
    return { mode: 'forced_on' };
  }
  // `reasoning` is capability metadata rather than a user policy: provider
  // presets derive it from the models.dev catalog and always persist a boolean
  // (provider-presets.service.ts `reasoning: value.reasoning === true`), so it
  // cannot stand in for "the user chose this". Only `false` is a meaningful
  // opt-out — the model cannot think, so there is nothing to switch.
  if (input.model.reasoning === false) return undefined;
  // The synthesized default mirrors the level the resolver would have sent for
  // the same config, so exposing the switch adds control without changing the
  // effective thinking behaviour of any existing model.
  return { mode: 'switchable', default_value: input.model.reasoning === true ? 'true' : 'false' };
}

function selectedModelVariant(
  input: BuildModelEntryInput,
  thinkingConfig: ModelThinkingConfigView | undefined,
): string | undefined {
  if (input.selected && input.hasSelectionVariant) return input.selectionVariant ?? undefined;
  return defaultThinkingVariant(thinkingConfig, input.model.defaultVariant);
}

function modelStatusFields(
  entry: ModelCacheStatusEntry | undefined,
): Partial<ModelProviderModelEntry> {
  const status = cacheStatusView(entry);
  return status ? { status } : {};
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
          ...(typeof provider.api === 'string' ? { apiFormat: provider.api } : {}),
          status: statusFor(providerId, modelId),
          ...options,
        }),
      );
    }
  }

  return entries;
}
