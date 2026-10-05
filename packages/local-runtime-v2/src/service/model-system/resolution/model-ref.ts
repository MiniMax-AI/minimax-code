import { isDefaultThinkingModelId, type Api, type ThinkingLevelMap } from '@earendil-works/pi-ai';
import type { ThinkingLevel as PiThinkingLevel } from '@earendil-works/pi-agent-core';
import { normalizeMaxImagesPerRequest } from '@mavis/agent-core/pi-turn-runner';
import {
  ThinkingLevel,
  ThinkingMode,
  type IModelCapabilities,
  type IModelRef,
} from '@mavis/protocol';
import type { ConversationModelThinkingSelection } from '@mavis/conversation-contract';

import {
  LocalModelProviderError,
  type LocalModelConfig,
  type MiniMaxM3ThinkingMode,
} from '../contracts.js';
import { CUSTOM_PROVIDER_ID_PREFIX } from '../identity.js';
import {
  OPENPLATFORM_THINKING_VARIANTS_CAPABILITY,
  type OpenPlatformThinkingVariants,
} from './openplatform-thinking.js';
import {
  normalizeLocalFileApiCapabilities,
  normalizeLocalMultimodalLimitCapabilities,
} from './file-api-capabilities.js';

export type { MiniMaxM3ThinkingMode } from '../contracts.js';

const THINKING_VARIANT = 'thinking';
const NONE_THINKING_VARIANT = '';
const APOLLO_NONE_THINKING_VARIANT = 'none-thinking';
const PI_THINKING_LEVELS = new Set<string>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const MINIMAX_M3_MODEL_ID = 'MiniMax-M3';

const SELECTED_THINKING_EFFORT_CAPABILITY = 'selected_thinking_effort';
const SUPPORT_JSON_OBJECT_OUTPUT_CAPABILITY = 'support_json_object_output';

/** Process-local extensions carried alongside generated protocol model capabilities. */
interface LocalModelRefCapabilities extends IModelCapabilities {
  readonly [SUPPORT_JSON_OBJECT_OUTPUT_CAPABILITY]?: boolean;
}

export interface ByokThinkingProtocol {
  readonly effort: string;
  readonly enabled?: boolean;
  readonly piLevel: PiThinkingLevel;
  readonly thinkingLevelMap: ThinkingLevelMap;
  readonly requestPatch: Record<string, unknown>;
  readonly forceAdaptiveThinking?: true;
  readonly completionsThinkingFormat?: 'openai';
}

export interface ModelThinkingProtocolConfig extends ByokThinkingProtocol {
  readonly requestPatch: Record<string, unknown>;
}

export interface ManagedModelParameterSnapshot {
  readonly context: 'default' | 'selection' | 'legacy';
  readonly effort: 'default' | 'selection' | 'legacy';
}

export interface ModelRefOverride {
  /** Produced by managed queue admission; never read from a public selection. */
  readonly parameterSnapshot?: ManagedModelParameterSnapshot;
  readonly managed?: boolean;
  readonly reasoning?: boolean;
  readonly contextLimit?: number;
  readonly variant?: string;
  readonly thinking?: ConversationModelThinkingSelection;
  readonly implicitCustomProviderThinking?: boolean;
}

export function modelRefForModel(
  provider: string,
  modelId: string,
  modelConfig: LocalModelConfig | undefined,
  variantOrOptions?: string | ModelRefOverride,
): IModelRef {
  const options: ModelRefOverride =
    typeof variantOrOptions === 'string' ? { variant: variantOrOptions } : (variantOrOptions ?? {});
  if (options.managed) {
    return {
      provider,
      model_id: modelId,
      capabilities: capabilitiesFromModelConfig(modelConfig),
      ...modelLimitsFromConfig(modelConfig),
      ...resolveManagedParameters(modelConfig, options),
    };
  }
  const selectedEffort = resolveEffectiveThinkingEffort(provider, modelId, modelConfig, options);
  const capabilities = capabilitiesFromModelConfig(modelConfig) ?? {};
  if (selectedEffort) {
    Reflect.set(capabilities, SELECTED_THINKING_EFFORT_CAPABILITY, selectedEffort);
  }
  const thinkingLevel = selectedEffort
    ? thinkingLevelForEffort(selectedEffort)
    : resolveThinkingLevel(
        modelConfig,
        options.variant,
        options.implicitCustomProviderThinking === true,
      );
  return {
    provider,
    model_id: modelId,
    thinking_level: thinkingLevel,
    capabilities,
    ...modelLimitsFromConfig(modelConfig),
  };
}

function invalidManagedParameter(field: string): never {
  throw new LocalModelProviderError(400, `Invalid model ${field}`, 'VALIDATION_ERROR');
}

function resolveManagedParameters(
  config: LocalModelConfig = {},
  selection: ModelRefOverride,
): Pick<IModelRef, 'thinking_level' | 'thinking_effort' | 'context_window'> {
  const requested = readManagedThinkingSwitch(config, selection);
  assertManagedThinkingMode(config, selection, requested.enabled);
  const enabled =
    requested.enabled ?? resolveThinkingLevel(config, undefined) !== ThinkingLevel.OFF;
  const effort = resolveManagedEffort(
    config,
    selection.parameterSnapshot,
    requested.effort,
    enabled,
  );
  validateManagedContext(config, selection);
  return {
    thinking_level: enabled ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF,
    ...(effort ? { thinking_effort: effort } : {}),
    ...(selection.contextLimit !== undefined ? { context_window: selection.contextLimit } : {}),
  };
}

function requestedManagedReasoning(selection: ModelRefOverride): boolean | undefined {
  const variant = normalizeThinkingVariant(selection.variant);
  if (selection.reasoning !== undefined && typeof selection.reasoning !== 'boolean')
    invalidManagedParameter('reasoning');
  if (selection.variant !== undefined && variant === undefined) invalidManagedParameter('variant');
  const variantReasoning = variant === undefined ? undefined : variant === THINKING_VARIANT;
  if (
    selection.reasoning !== undefined &&
    variantReasoning !== undefined &&
    selection.reasoning !== variantReasoning
  )
    invalidManagedParameter('reasoning/variant conflict');
  return selection.reasoning ?? variantReasoning;
}

function readManagedThinkingSwitch(config: LocalModelConfig, selection: ModelRefOverride) {
  const enabled = requestedManagedReasoning(selection);
  const effort = selection.thinking?.effort;
  const legacy = !config.thinking?.effortOptions && config.variants;
  if (!legacy || (effort !== 'on' && effort !== 'off')) return { enabled, effort };
  if (enabled !== undefined && enabled !== (effort === 'on'))
    invalidManagedParameter('reasoning/effort conflict');
  return { enabled: effort === 'on', effort: undefined };
}

function assertManagedThinkingMode(
  config: LocalModelConfig,
  selection: ModelRefOverride,
  enabled: boolean | undefined,
): void {
  if (enabled === undefined) return;
  switch (config.thinking_config?.mode) {
    case 'forced_on':
      if (!enabled) invalidManagedParameter('reasoning');
      return;
    case 'forced_off':
      if (enabled) invalidManagedParameter('reasoning');
      return;
    case 'switchable':
      return;
    default:
      if (!selection.parameterSnapshot) assertManagedLegacyVariant(config, enabled);
  }
}

function assertManagedLegacyVariant(config: LocalModelConfig, enabled: boolean): void {
  const variant = config.variants?.[enabled ? THINKING_VARIANT : APOLLO_NONE_THINKING_VARIANT];
  if (!variant || variant.disabled) invalidManagedParameter('reasoning');
}

function resolveManagedEffort(
  config: LocalModelConfig,
  snapshot: ManagedModelParameterSnapshot | undefined,
  effort: string | undefined,
  enabled: boolean,
): string | undefined {
  if (effort !== undefined) {
    validateManagedEffort(config, snapshot, effort);
    return enabled ? effort : undefined;
  }
  if (!enabled || snapshot || config.parameterErrors?.effortOptions) return undefined;
  return config.thinking?.defaultEffort;
}

function validateManagedEffort(
  config: LocalModelConfig,
  snapshot: ManagedModelParameterSnapshot | undefined,
  effort: string,
): void {
  if (typeof effort !== 'string' || !effort.trim() || effort !== effort.trim())
    invalidManagedParameter('thinking.effort');
  if (snapshot?.effort === 'legacy') return;
  if (config.parameterErrors?.effortOptions) invalidManagedParameter('thinking.effort');
  if (snapshot) return;
  const allowed =
    config.thinking?.effortOptions ?? fixedParameterOption(config.thinking?.defaultEffort);
  if (!allowed.includes(effort)) invalidManagedParameter('thinking.effort');
}

function validateManagedContext(config: LocalModelConfig, selection: ModelRefOverride): void {
  const context = selection.contextLimit;
  if (context === undefined) return;
  if (!Number.isSafeInteger(context) || context <= 0 || context > 2_147_483_647)
    invalidManagedParameter('context_limit');
  if (selection.parameterSnapshot?.context === 'legacy') return;
  if (config.parameterErrors?.contextOptions) invalidManagedParameter('context_limit');
  if (selection.parameterSnapshot) return;
  const allowed = config.contextWindowOptions ?? fixedParameterOption(config.limit?.context);
  if (!allowed.includes(context)) invalidManagedParameter('context_limit');
}

function fixedParameterOption<T>(value: T | undefined): T[] {
  return value === undefined ? [] : [value];
}

function thinkingLevelForEffort(effort: string): ThinkingLevel {
  return isThinkingEffortDisabled(effort) ? ThinkingLevel.OFF : ThinkingLevel.MEDIUM;
}

/**
 * Explicit effort wins over a legacy variant. A variant without effort remains
 * authoritative for that selection; only an unqualified selection receives the
 * catalog's upper-middle default effort.
 */
function resolveEffectiveThinkingEffort(
  provider: string,
  modelId: string,
  modelConfig: LocalModelConfig | undefined,
  selection: ModelRefOverride,
): string | undefined {
  const selected = normalizeModelThinkingEffort(selection.thinking?.effort);
  const thinkingMode = modelConfig?.thinking_config?.mode;
  if (thinkingMode === 'forced_off') return 'off';
  if (thinkingMode === 'forced_on') return resolveForcedOnThinkingEffort(modelConfig, selected);
  if (normalizeThinkingVariant(selection.variant) === NONE_THINKING_VARIANT) return undefined;
  if (!normalizeModelThinkingEffortOptions(modelConfig?.thinking?.effortOptions)) {
    const miniMaxM3Mode = resolveMiniMaxM3ThinkingMode(
      provider.startsWith(CUSTOM_PROVIDER_ID_PREFIX) ? undefined : modelId,
      modelConfig,
    );
    if (miniMaxM3Mode) return resolveMiniMaxM3SelectedEffort(miniMaxM3Mode, selected, selection);
  }
  if (
    thinkingMode === 'switchable' &&
    resolveThinkingLevel(modelConfig, selection.variant) === ThinkingLevel.OFF
  ) {
    return undefined;
  }
  return resolveConfiguredThinkingEffort(modelConfig, selected, selection.variant);
}

function resolveForcedOnThinkingEffort(
  modelConfig: LocalModelConfig | undefined,
  selected: string | undefined,
): string | undefined {
  const options = normalizeModelThinkingEffortOptions(modelConfig?.thinking?.effortOptions);
  if (selected && !isThinkingEffortDisabled(selected) && options?.includes(selected))
    return selected;
  const defaultEffort = normalizeModelThinkingEffort(modelConfig?.thinking?.defaultEffort);
  return defaultEffort && options?.includes(defaultEffort) ? defaultEffort : undefined;
}

function resolveMiniMaxM3SelectedEffort(
  mode: MiniMaxM3ThinkingMode,
  selected: string | undefined,
  selection: ModelRefOverride,
): string | undefined {
  if (isMiniMaxM3ThinkingMode(selected)) return selected;
  return selection.variant === undefined ? mode : undefined;
}

function resolveConfiguredThinkingEffort(
  modelConfig: LocalModelConfig | undefined,
  selected: string | undefined,
  variant: string | undefined,
): string | undefined {
  if (normalizeThinkingVariant(variant) === NONE_THINKING_VARIANT) return undefined;
  if (isThinkingEffortDisabled(selected)) return selected;
  const options = normalizeModelThinkingEffortOptions(modelConfig?.thinking?.effortOptions);
  if (selected && options?.includes(selected)) return selected;
  if (variant !== undefined) return undefined;
  const defaultEffort = normalizeModelThinkingEffort(modelConfig?.thinking?.defaultEffort);
  if (defaultEffort && options?.includes(defaultEffort)) return defaultEffort;
  return options?.[Math.floor(options.length / 2)];
}

export function readSelectedThinkingEffort(
  capabilities: IModelRef['capabilities'],
): string | undefined {
  return normalizeModelThinkingEffort(
    Reflect.get(capabilities ?? {}, SELECTED_THINKING_EFFORT_CAPABILITY),
  );
}

/**
 * Converts the user-authored provider effort string into Pi's internal
 * reasoning level while preserving the original value in `thinkingLevelMap`.
 */
export function resolveByokThinkingProtocol(
  api: Api,
  value: unknown,
  modelId?: unknown,
): ByokThinkingProtocol | undefined {
  const protocol = resolveModelThinkingProtocol(api, value, modelId);
  if (!protocol) return undefined;
  return {
    effort: protocol.effort,
    piLevel: protocol.piLevel,
    thinkingLevelMap: protocol.thinkingLevelMap,
    requestPatch: protocol.requestPatch,
    ...(protocol.enabled !== undefined ? { enabled: protocol.enabled } : {}),
    ...(protocol.forceAdaptiveThinking ? { forceAdaptiveThinking: true } : {}),
    ...(protocol.completionsThinkingFormat
      ? { completionsThinkingFormat: protocol.completionsThinkingFormat }
      : {}),
  };
}

export function isMiniMaxM3ModelId(value: unknown): boolean {
  return (
    typeof value === 'string' && value.trim().toLowerCase() === MINIMAX_M3_MODEL_ID.toLowerCase()
  );
}

export function isMiniMaxM3ThinkingMode(value: unknown): value is MiniMaxM3ThinkingMode {
  return value === 'on' || value === 'off';
}

/** MiniMax M3 has a binary native Thinking control, distinct from effort levels. */
function isMiniMaxM3ThinkingSwitchable(
  modelId: unknown,
  modelConfig: LocalModelConfig | undefined,
): boolean {
  return isMiniMaxM3ModelId(modelId) && modelConfig?.thinking_config?.mode === 'switchable';
}

/**
 * Normalizes the catalog's switchable M3 default into the existing
 * `effectiveModelThinking.effort` wire shape. A Runtime default variant, when
 * supplied, is more specific than the catalog's own variant/default value.
 */
export function resolveMiniMaxM3ThinkingMode(
  modelId: unknown,
  modelConfig: LocalModelConfig | undefined,
  runtimeDefaultVariant?: string,
): MiniMaxM3ThinkingMode | undefined {
  if (!modelConfig || !isMiniMaxM3ThinkingSwitchable(modelId, modelConfig)) return undefined;
  const selected =
    normalizeThinkingVariant(runtimeDefaultVariant) ??
    (readSwitchableDefaultValue(modelConfig) === 'true' ? THINKING_VARIANT : NONE_THINKING_VARIANT);
  return selected === THINKING_VARIANT ? 'on' : 'off';
}

/** MiniMax M3 exposes an on/off control; Responses effort values do not change thinking depth. */
export function resolveMiniMaxM3ThinkingProtocol(
  api: Api,
  mode: MiniMaxM3ThinkingMode,
): Record<string, unknown> {
  if (api === 'openai-responses') {
    return { reasoning: { effort: mode === 'on' ? 'minimal' : 'none' } };
  }
  return {
    // Remove the internal on/off value serialized by Pi as a generic effort.
    ...(api === 'openai-completions' ? { reasoning_effort: undefined } : {}),
    ...(api === 'anthropic-messages' ? { output_config: { effort: undefined } } : {}),
    thinking: { type: mode === 'on' ? 'adaptive' : 'disabled' },
  };
}

export function resolveModelThinkingMiddleEffort(
  effortOptions: readonly string[] | undefined,
): string | undefined {
  if (!effortOptions?.length) return undefined;
  return effortOptions[Math.floor(effortOptions.length / 2)];
}

function resolveMiniMaxM3ModelThinkingProtocol(
  api: Api,
  effort: string,
  modelId: unknown,
): ModelThinkingProtocolConfig | undefined {
  if (!isMiniMaxM3ModelId(modelId) || !isMiniMaxM3ThinkingMode(effort)) return undefined;
  const piLevel: PiThinkingLevel = 'high';
  const base = {
    effort,
    enabled: effort === 'on',
    piLevel,
    thinkingLevelMap: { [piLevel]: effort },
    requestPatch: resolveMiniMaxM3ThinkingProtocol(api, effort),
  } satisfies Omit<
    ModelThinkingProtocolConfig,
    'forceAdaptiveThinking' | 'completionsThinkingFormat'
  >;
  if (api === 'anthropic-messages') return { ...base, forceAdaptiveThinking: true };
  if (api === 'openai-completions') {
    return { ...base, completionsThinkingFormat: 'openai' };
  }
  return base;
}

function resolveDisabledThinkingProtocol(
  api: Api,
  effort: string,
): ModelThinkingProtocolConfig | undefined {
  if (!isThinkingEffortDisabled(effort)) return undefined;
  const piLevel: PiThinkingLevel = 'high';
  const base = {
    effort,
    enabled: false,
    piLevel,
    thinkingLevelMap: { [piLevel]: effort },
  } satisfies Omit<
    ModelThinkingProtocolConfig,
    'requestPatch' | 'forceAdaptiveThinking' | 'completionsThinkingFormat'
  >;
  if (api === 'anthropic-messages') {
    return {
      ...base,
      requestPatch: { thinking: { type: 'disabled' }, output_config: undefined },
    };
  }
  if (api === 'openai-completions') {
    return {
      ...base,
      requestPatch: { reasoning_effort: 'none' },
      completionsThinkingFormat: 'openai',
    };
  }
  return { ...base, requestPatch: { reasoning: { effort: 'none' } } };
}

export function resolveModelThinkingProtocol(
  api: Api,
  value: unknown,
  modelId?: unknown,
): ModelThinkingProtocolConfig | undefined {
  const effort = normalizeModelThinkingEffort(value);
  if (!effort) return undefined;

  const miniMaxM3Protocol = resolveMiniMaxM3ModelThinkingProtocol(api, effort, modelId);
  if (miniMaxM3Protocol) return miniMaxM3Protocol;

  const disabledProtocol = resolveDisabledThinkingProtocol(api, effort);
  if (disabledProtocol) return disabledProtocol;

  const piLevel = PI_THINKING_LEVELS.has(effort) ? (effort as PiThinkingLevel) : 'high';
  const base = {
    effort,
    piLevel,
    thinkingLevelMap: { [piLevel]: effort },
  } satisfies Omit<ModelThinkingProtocolConfig, 'requestPatch'>;

  if (api === 'anthropic-messages') {
    const usesDefaultThinking = isDefaultThinkingModelId(modelId);
    return {
      ...base,
      forceAdaptiveThinking: true,
      requestPatch: {
        ...(usesDefaultThinking ? { thinking: undefined } : { thinking: { type: 'adaptive' } }),
        output_config: { effort },
      },
    };
  }
  if (api === 'openai-completions') {
    return {
      ...base,
      requestPatch: { reasoning_effort: effort },
      completionsThinkingFormat: 'openai',
    };
  }
  return {
    ...base,
    requestPatch: { reasoning: { effort } },
  };
}

export function capabilitiesFromModelConfig(
  modelConfig: LocalModelConfig | undefined,
): LocalModelRefCapabilities {
  const modalities = modelConfig?.modalities?.input ?? [];
  const capabilities: LocalModelRefCapabilities = {
    support_image:
      modalities.includes('image') || modelConfig?.capabilities?.support_image === true,
    support_video:
      modalities.includes('video') || modelConfig?.capabilities?.support_video === true,
    ...normalizeLocalFileApiCapabilities(modelConfig?.capabilities),
    ...normalizeLocalMultimodalLimitCapabilities(modelConfig?.capabilities),
    ...maxImagesPerRequestCapability(modelConfig?.capabilities?.max_images_per_request),
    ...(modelConfig?.capabilities?.support_json_object_output === true
      ? { [SUPPORT_JSON_OBJECT_OUTPUT_CAPABILITY]: true }
      : {}),
  };
  const mode = modelConfig?.thinking_config?.mode;
  if (mode === 'forced_on') capabilities.thinking_mode = ThinkingMode.FORCED_ON;
  if (mode === 'switchable') capabilities.thinking_mode = ThinkingMode.SWITCHABLE;
  const variants = openPlatformThinkingVariants(modelConfig);
  if (variants) {
    Reflect.set(capabilities, OPENPLATFORM_THINKING_VARIANTS_CAPABILITY, variants);
  }
  return capabilities;
}

/** Per-request image ceiling (#425); absent unless the model config declares a positive integer. */
function maxImagesPerRequestCapability(
  value: unknown,
): Pick<LocalModelRefCapabilities, 'max_images_per_request'> {
  const maxImages = normalizeMaxImagesPerRequest(value);
  return maxImages === undefined ? {} : { max_images_per_request: maxImages };
}

export function supportsJsonObjectOutput(modelRef: IModelRef): boolean {
  const capabilities: LocalModelRefCapabilities | undefined = modelRef.capabilities;
  return capabilities?.[SUPPORT_JSON_OBJECT_OUTPUT_CAPABILITY] === true;
}

export function modelLimitsFromConfig(
  modelConfig: LocalModelConfig | undefined,
): Pick<IModelRef, 'context_window' | 'max_tokens'> {
  return {
    ...(typeof modelConfig?.limit?.context === 'number'
      ? { context_window: modelConfig.limit.context }
      : {}),
    ...(typeof modelConfig?.limit?.output === 'number'
      ? { max_tokens: modelConfig.limit.output }
      : {}),
  };
}

export function resolveThinkingLevel(
  modelConfig: LocalModelConfig | undefined,
  variant: string | undefined,
  implicitCustomProviderThinking = false,
): ThinkingLevel {
  const mode = modelConfig?.thinking_config?.mode;
  if (!mode) {
    if (implicitCustomProviderThinking) {
      const explicitVariant = normalizeThinkingVariant(variant);
      if (explicitVariant !== undefined) {
        return explicitVariant === THINKING_VARIANT ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
      }
    }
    return modelConfig?.reasoning ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
  }
  if (mode === 'forced_on') return ThinkingLevel.MEDIUM;
  if (mode === 'forced_off') return ThinkingLevel.OFF;
  if (mode === 'switchable') return resolveSwitchableThinkingLevel(modelConfig, variant);
  return modelConfig.reasoning ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
}

function resolveSwitchableThinkingLevel(
  modelConfig: LocalModelConfig,
  variant: string | undefined,
): ThinkingLevel {
  const configured = normalizeThinkingVariant(variant);
  const catalogDefault = normalizeThinkingVariant(modelConfig.defaultVariant);
  const rawDefault = readSwitchableDefaultValue(modelConfig);
  const normalized =
    configured ??
    catalogDefault ??
    (rawDefault === 'true' ? THINKING_VARIANT : NONE_THINKING_VARIANT);
  return normalized === THINKING_VARIANT ? ThinkingLevel.MEDIUM : ThinkingLevel.OFF;
}

function openPlatformThinkingVariants(
  modelConfig: LocalModelConfig | undefined,
): OpenPlatformThinkingVariants | undefined {
  const thinking = readThinkingPayload(modelConfig?.variants?.[THINKING_VARIANT]);
  const noneThinking = readThinkingPayload(modelConfig?.variants?.[APOLLO_NONE_THINKING_VARIANT]);
  if (!thinking && !noneThinking) return undefined;
  return {
    ...(thinking ? { thinking } : {}),
    ...(noneThinking ? { 'none-thinking': noneThinking } : {}),
  };
}

function readThinkingPayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (Reflect.get(value, 'disabled') === true) return undefined;
  const thinking = Reflect.get(value, 'thinking');
  return thinking && typeof thinking === 'object' && !Array.isArray(thinking)
    ? { ...(thinking as Record<string, unknown>) }
    : undefined;
}

function normalizeThinkingVariant(value: string | undefined): string | undefined {
  if (value === THINKING_VARIANT) return THINKING_VARIANT;
  return value === NONE_THINKING_VARIANT || value === APOLLO_NONE_THINKING_VARIANT
    ? NONE_THINKING_VARIANT
    : undefined;
}

function readSwitchableDefaultValue(modelConfig: LocalModelConfig): string | undefined {
  const config = modelConfig.thinking_config as
    | { readonly default_value?: unknown; readonly defaultValue?: unknown }
    | undefined;
  const raw = config?.default_value ?? config?.defaultValue;
  return raw === 'true' || raw === 'false' ? raw : undefined;
}

export function normalizeModelThinkingEffort(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function isThinkingEffortDisabled(value: unknown): boolean {
  const effort = normalizeModelThinkingEffort(value)?.toLowerCase();
  return effort === 'none' || effort === 'off';
}

export function normalizeModelThinkingEffortOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const option = normalizeModelThinkingEffort(candidate);
    if (!option || seen.has(option)) continue;
    seen.add(option);
    options.push(option);
  }
  return options.length > 0 ? options : undefined;
}
