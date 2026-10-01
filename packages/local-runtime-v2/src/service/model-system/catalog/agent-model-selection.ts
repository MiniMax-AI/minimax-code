import { getRuntimePresetKey, resolveModelAvailability } from '@mavis/config';
import { ThinkingLevel } from '@mavis/protocol';

import type { LocalConversationRuntimeConfig, LocalModelConfig } from '../contracts.js';
import { MANAGED_MINIMAX_PROVIDER_ID } from '../identity.js';
import { modelConfigForRef } from './list-models.js';
import { resolveLegacyMinimaxModel } from './model-selection.js';
import {
  CUSTOM_PROVIDER_ID_PREFIX,
  formatModelKey,
  parseSourceQualifiedModelKey,
  type ParsedModelKey,
} from '../resolution/model-key.js';
import {
  isMiniMaxM3ThinkingMode,
  isThinkingEffortDisabled,
  resolveMiniMaxM3ThinkingMode,
  normalizeModelThinkingEffort,
  normalizeModelThinkingEffortOptions,
  resolveModelThinkingMiddleEffort,
  modelRefForModel,
  type ManagedModelParameterSnapshot,
} from '../resolution/model-ref.js';

/** The model fields owned by an Agent file or a Session-derived selection. */
export interface AgentModelSelectionInput {
  readonly model?: string;
  /** Session-derived switch; Agent files continue to use effort. */
  readonly reasoning?: boolean;
  readonly variant?: string;
  readonly effort?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export interface AgentModelSelectionSource {
  /** Higher-priority sources must appear first. */
  readonly source: string;
  /** Internal frozen definition provenance; never read from an Agent or model request. */
  readonly parameterSnapshot?: ManagedModelParameterSnapshot;
  readonly selection?: AgentModelSelectionInput;
  /** Agent/Builtin capture rejects absent, disabled catalog entries before persistence. */
  readonly requireCatalog?: boolean;
  /**
   * Canonical Agent profiles may retain the pre-`custom_provider:` BYOK
   * spelling. Other model sources stay source-qualified exactly as supplied.
   */
  readonly allowCustomProviderPrefixFallback?: boolean;
  /** Agent-controlled normal thinking models use an omitted effort as an explicit off state. */
  readonly defaultMissingEffortOff?: boolean;
  /** Only the Runtime default may apply `defaultModelVariant` to an omitted M3 switch. */
  readonly usesRuntimeDefaultVariant?: boolean;
}

export interface AgentModelSelectionDiagnostic {
  readonly code: 'context_window_clamped' | 'max_output_tokens_clamped';
  readonly source: string;
  readonly requested: number;
  readonly effective: number;
  readonly physicalLimit: number;
}

/** One complete, catalog-gated model group; no legacy variant is part of it. */
export interface ResolvedAgentModelSelection {
  readonly reasoning?: boolean;
  readonly parameterSnapshot?: ManagedModelParameterSnapshot;
  readonly providerId: string;
  readonly modelId: string;
  readonly source: string;
  readonly effort?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly diagnostics: readonly AgentModelSelectionDiagnostic[];
}

/**
 * The one model-selection path shared by Session definition capture and the
 * Agent Config effective preview. It intentionally returns `undefined` when
 * the Runtime has no default yet, so a Config read stays available while
 * setup is incomplete; an invalid explicit Agent selection still fails.
 */
export function resolveEffectiveAgentModelSelection(input: {
  readonly config: LocalConversationRuntimeConfig;
  readonly sources: readonly AgentModelSelectionSource[];
}): ResolvedAgentModelSelection | undefined {
  let resolved: ResolvedAgentModelSelection;
  try {
    resolved = resolveAgentModelSelection({
      config: input.config,
      sources: input.sources,
    });
  } catch (error) {
    if (error instanceof AgentModelSelectionError && error.code === 'MODEL_SELECTION_INCOMPLETE') {
      return undefined;
    }
    throw error;
  }
  const availability = resolveModelAvailability({
    config: input.config,
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    preset: getRuntimePresetKey(),
    source: 'config_default',
  });
  if (availability.available) return resolved;
  throw new AgentModelSelectionError('MODEL_SELECTION_INVALID', availability.message);
}

/** Config editing must remain available when a previously selected model was removed. */
export function previewAgentModelSelection(
  input: Parameters<typeof resolveEffectiveAgentModelSelection>[0],
): ResolvedAgentModelSelection | undefined {
  try {
    return resolveEffectiveAgentModelSelection(input);
  } catch (error) {
    if (error instanceof AgentModelSelectionError) return undefined;
    throw error;
  }
}

/**
 * Validates the model group retained by a managed Builtin rebuild.  Builtin
 * canonical storage opens before ModelSystem; once the catalog is available,
 * its historical group must be treated exactly like an Agent selection, then
 * fall back to an explicit bundled group as one whole group rather than
 * retaining stale limits or effort.
 */
export function resolveBuiltinAgentModelGroup(input: {
  readonly config: LocalConversationRuntimeConfig;
  readonly previous?: AgentModelSelectionInput;
  readonly bundled?: AgentModelSelectionInput;
}): AgentModelSelectionInput | undefined {
  const candidates = [
    {
      source: 'builtin-previous',
      selection: input.previous,
    },
    {
      source: 'builtin-bundled',
      selection: input.bundled,
    },
  ] as const;
  for (const candidate of candidates) {
    if (!candidate.selection?.model) continue;
    try {
      const resolved = resolveAgentModelSelection({
        config: input.config,
        sources: [
          {
            source: candidate.source,
            selection: candidate.selection,
            requireCatalog: true,
            defaultMissingEffortOff: true,
          },
        ],
      });
      const availability = resolveModelAvailability({
        config: input.config,
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        preset: getRuntimePresetKey(),
        source: 'config_default',
      });
      if (!availability.available) continue;
      return {
        model: formatModelKey(resolved.providerId, resolved.modelId),
        ...(resolved.effort ? { effort: resolved.effort } : {}),
        ...(resolved.contextWindow === undefined ? {} : { contextWindow: resolved.contextWindow }),
        ...(resolved.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: resolved.maxOutputTokens }),
      };
    } catch {
      // A legacy `.builtin` model/effort/limit group is not user-authored
      // runtime state. Invalid catalog drift deliberately proceeds to the
      // next whole-group fallback below.
    }
  }
  return undefined;
}

export class AgentModelSelectionError extends Error {
  constructor(
    readonly code:
      | 'MODEL_SELECTION_INCOMPLETE'
      | 'MODEL_SELECTION_INVALID'
      | 'MODEL_EFFORT_UNSUPPORTED'
      | 'MODEL_LIMIT_INVALID'
      | 'MODEL_LIMIT_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'AgentModelSelectionError';
  }
}

/**
 * Resolves one coherent `model + effort + contextWindow + maxOutputTokens`
 * group. A source that supplies a model starts a fresh group: lower-priority
 * effort or limits cannot leak from a different model. A source without a
 * model may still narrow the inherited group.
 */
export function resolveAgentModelSelection(input: {
  readonly config: LocalConversationRuntimeConfig;
  readonly sources: readonly AgentModelSelectionSource[];
}): ResolvedAgentModelSelection {
  const context = resolveSelectionContext(input);
  const { sources, modelIndex, modelSource, model, modelConfig, contributors } = context;
  if (
    model.providerId === MANAGED_MINIMAX_PROVIDER_ID &&
    input.config.minimaxModelSource !== 'minimax_api_key'
  )
    return resolveManagedAgentSelection(input.config, context);

  const effort = resolveEffort({
    modelConfig,
    providerId: model.providerId,
    modelId: model.modelId,
    value: firstString(contributors, 'effort'),
    source: sourceFor(contributors, 'effort') ?? modelSource.source,
    modelKey: formatModelKey(model.providerId, model.modelId),
    ...(modelSource.usesRuntimeDefaultVariant
      ? { runtimeDefaultVariant: input.config.defaultModelVariant }
      : {}),
    defaultMissingEffortOff: defaultsMissingEffortOff(sources, modelIndex, modelSource),
  });
  const contextWindow = resolveContextWindow({ contributors, modelSource, modelConfig });
  const maxOutputTokens = resolveLimit({
    field: 'maxOutputTokens',
    requested: firstNumber(contributors, 'maxOutputTokens'),
    source: sourceFor(contributors, 'maxOutputTokens') ?? modelSource.source,
    physicalLimit: positiveLimit(modelConfig?.limit?.output),
  });
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    source: modelSource.source,
    ...(effort ? { effort } : {}),
    ...(contextWindow.effective === undefined ? {} : { contextWindow: contextWindow.effective }),
    ...(maxOutputTokens.effective === undefined
      ? {}
      : { maxOutputTokens: maxOutputTokens.effective }),
    diagnostics: Object.freeze([...contextWindow.diagnostics, ...maxOutputTokens.diagnostics]),
  };
}

function managedAgentThinkingInput(effort: string | undefined) {
  if (effort === 'off' || effort === 'on') return { reasoning: effort === 'on' };
  return effort === undefined ? {} : { thinking: { effort } };
}

function resolveManagedAgentSelection(
  config: LocalConversationRuntimeConfig,
  context: ReturnType<typeof resolveSelectionContext>,
): ResolvedAgentModelSelection {
  const { modelSource, model, modelConfig, contributors } = context;
  validateManagedAgentOverrides(context);
  const effort = firstString(contributors, 'effort');
  const reasoning = contributors.find(({ selection }) => selection?.reasoning !== undefined)
    ?.selection?.reasoning;
  const variant = contributors.find(({ selection }) => selection?.variant !== undefined)?.selection
    ?.variant;
  const parameterSnapshot: ManagedModelParameterSnapshot = {
    context: managedParameterOrigin(contributors, modelSource, 'contextWindow', 'context'),
    effort: managedParameterOrigin(contributors, modelSource, 'effort', 'effort'),
  };
  const ref = modelRefForModel(model.providerId, model.modelId, modelConfig, {
    managed: true,
    ...(modelSource.parameterSnapshot ? { parameterSnapshot } : {}),
    ...managedAgentThinkingInput(effort),
    ...(reasoning === undefined ? {} : { reasoning }),
    variant:
      variant ?? (modelSource.usesRuntimeDefaultVariant ? config.defaultModelVariant : undefined),
    contextLimit: firstNumber(contributors, 'contextWindow'),
  });
  const output = resolveLimit({
    field: 'maxOutputTokens',
    requested: firstNumber(contributors, 'maxOutputTokens'),
    source: sourceFor(contributors, 'maxOutputTokens') ?? modelSource.source,
    physicalLimit: positiveLimit(modelConfig?.limit?.output),
  });
  return {
    ...model,
    source: modelSource.source,
    reasoning: ref.thinking_level !== ThinkingLevel.OFF,
    parameterSnapshot,
    effort: ref.thinking_effort ?? (ref.thinking_level === ThinkingLevel.OFF ? 'off' : undefined),
    ...(ref.context_window === undefined ? {} : { contextWindow: ref.context_window }),
    ...(output.effective === undefined ? {} : { maxOutputTokens: output.effective }),
    diagnostics: output.diagnostics,
  };
}

function validateManagedAgentOverrides(context: ReturnType<typeof resolveSelectionContext>): void {
  const { modelSource, model, modelConfig, contributors } = context;
  if (!modelSource.parameterSnapshot) return;
  // A new partial override cannot borrow the inherited group's acceptance.
  // Validate only its winning fields before freezing the merged selection.
  modelRefForModel(model.providerId, model.modelId, modelConfig, {
    managed: true,
    ...managedAgentThinkingInput(unacceptedManagedField(contributors, 'effort')),
    reasoning: unacceptedManagedField(contributors, 'reasoning'),
    variant: unacceptedManagedField(contributors, 'variant'),
    contextLimit: unacceptedManagedField(contributors, 'contextWindow'),
  });
}

function unacceptedManagedField<K extends 'effort' | 'reasoning' | 'variant' | 'contextWindow'>(
  contributors: readonly AgentModelSelectionSource[],
  field: K,
): AgentModelSelectionInput[K] {
  const contributor = contributors.find(({ selection }) => selection?.[field] !== undefined);
  return contributor?.parameterSnapshot ? undefined : contributor?.selection?.[field];
}

function managedParameterOrigin(
  contributors: readonly AgentModelSelectionSource[],
  modelSource: AgentModelSelectionSource,
  field: 'contextWindow' | 'effort',
  key: keyof ManagedModelParameterSnapshot,
): 'default' | 'selection' | 'legacy' {
  const contributor = contributors.find(({ selection }) => selection?.[field] !== undefined);
  if ((!contributor || contributor === modelSource) && modelSource.parameterSnapshot) {
    return modelSource.parameterSnapshot[key];
  }
  return contributor ? 'selection' : 'default';
}

function resolveSelectionContext(input: {
  readonly config: LocalConversationRuntimeConfig;
  readonly sources: readonly AgentModelSelectionSource[];
}) {
  const sources = withRuntimeDefault(input.config, input.sources);
  const modelIndex = sources.findIndex(({ selection }) => selection?.model !== undefined);
  if (modelIndex < 0) {
    throw new AgentModelSelectionError(
      'MODEL_SELECTION_INCOMPLETE',
      'No runtime or Agent model is configured.',
    );
  }
  const modelSource = requiredSource(sources, modelIndex);
  const parsedModel = parseModel(modelSource.selection?.model, modelSource.source);
  const { model, modelConfig } = resolveModelCatalogReference(
    input.config,
    parsedModel,
    modelSource,
  );
  // Only sources at or above the model source may contribute field overrides.
  // This is the reset boundary that prevents an old model's effort/limits from
  // following a higher-priority model selection.
  const contributors = sources.slice(0, modelIndex + 1);
  assertRequiredCatalogModel(modelSource, modelConfig, model);
  return { sources, modelIndex, modelSource, model, modelConfig, contributors };
}

function resolveContextWindow(input: {
  readonly contributors: readonly AgentModelSelectionSource[];
  readonly modelSource: AgentModelSelectionSource;
  readonly modelConfig: LocalModelConfig | undefined;
}) {
  const contextDefault = positiveLimit(input.modelConfig?.limit?.context);
  const contextOptions = input.modelConfig?.contextWindowOptions?.filter(
    (value) => positiveLimit(value) !== undefined,
  );
  const physicalLimit = contextOptions?.length ? Math.max(...contextOptions) : contextDefault;
  return resolveLimit({
    field: 'contextWindow',
    requested: firstNumber(input.contributors, 'contextWindow'),
    source: sourceFor(input.contributors, 'contextWindow') ?? input.modelSource.source,
    defaultLimit: contextDefault,
    physicalLimit,
  });
}

function assertRequiredCatalogModel(
  source: AgentModelSelectionSource,
  modelConfig: LocalModelConfig | undefined,
  model: { readonly providerId: string; readonly modelId: string },
): void {
  if (!source.requireCatalog || (modelConfig && modelConfig.enabled !== false)) return;
  throw new AgentModelSelectionError(
    'MODEL_SELECTION_INVALID',
    `Model ${formatModelKey(model.providerId, model.modelId)} from ${source.source} is unavailable in the current catalog.`,
  );
}

function withRuntimeDefault(
  config: LocalConversationRuntimeConfig,
  sources: readonly AgentModelSelectionSource[],
): readonly AgentModelSelectionSource[] {
  const parsed = parseSourceQualifiedModelKey(config.defaultModel);
  // Resolve only the selected default; an unused stale default must not block
  // an explicit Agent model. Do not carry its old variant to a replacement.
  const replacement =
    parsed && !sources.some(({ selection }) => selection?.model !== undefined)
      ? resolveLegacyMinimaxModel(config, parsed)
      : undefined;
  const model = replacement
    ? formatModelKey(replacement.providerId, replacement.modelId)
    : config.defaultModel;
  return [
    ...sources,
    {
      source: 'runtime-default',
      selection: model
        ? {
            model,
            ...(!replacement
              ? {
                  effort: config.defaultModelThinking?.effort,
                  contextWindow: config.defaultModelContextWindow,
                }
              : {}),
          }
        : undefined,
      usesRuntimeDefaultVariant: !replacement,
      // Route availability owns Runtime-default drift diagnostics. Agent-owned
      // groups are catalog-gated above; a retired default still reaches the
      // same stable route failure rather than becoming an ambiguous parse error.
      requireCatalog: false,
    },
  ];
}

function requiredSource(
  sources: readonly AgentModelSelectionSource[],
  index: number,
): AgentModelSelectionSource {
  const source = sources[index];
  if (!source) throw new Error('Agent model selection source is missing.');
  return source;
}

function parseModel(value: string | undefined, source: string): ParsedModelKey {
  const parsed = parseSourceQualifiedModelKey(value);
  if (!parsed) {
    throw new AgentModelSelectionError(
      value === undefined ? 'MODEL_SELECTION_INCOMPLETE' : 'MODEL_SELECTION_INVALID',
      `Model selection from ${source} must use provider/model syntax.`,
    );
  }
  return parsed;
}

function resolveModelCatalogReference(
  config: LocalConversationRuntimeConfig,
  model: ParsedModelKey,
  source: AgentModelSelectionSource,
): {
  readonly model: { readonly providerId: string; readonly modelId: string };
  readonly modelConfig: LocalModelConfig | undefined;
} {
  const modelConfig = modelConfigForRef(config, model.providerId, model.modelId);
  if (
    !source.allowCustomProviderPrefixFallback ||
    modelConfig ||
    model.providerId === MANAGED_MINIMAX_PROVIDER_ID ||
    Object.hasOwn(config.provider, model.providerId)
  ) {
    return { model, modelConfig };
  }
  if (model.source !== 'provider') return { model, modelConfig };
  const providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${model.providerKey}`;
  const customModelConfig = modelConfigForRef(config, providerId, model.modelId);
  return customModelConfig
    ? { model: { providerId, modelId: model.modelId }, modelConfig: customModelConfig }
    : { model, modelConfig };
}

type EffortResolutionInput = {
  readonly modelConfig: LocalModelConfig | undefined;
  readonly providerId: string;
  readonly modelId: string;
  readonly value: string | undefined;
  readonly source: string;
  readonly modelKey: string;
  readonly runtimeDefaultVariant?: string;
  readonly defaultMissingEffortOff: boolean;
};

interface ForcedEffortResolution {
  readonly handled: boolean;
  readonly effort?: string;
}

function resolveEffort(input: EffortResolutionInput): string | undefined {
  const requested = normalizeModelThinkingEffort(input.value);
  const forced = resolveForcedEffort(input, requested);
  if (forced.handled) return forced.effort;
  return resolveSwitchableOrCatalogEffort(input, requested);
}

function resolveForcedEffort(
  input: EffortResolutionInput,
  requested: string | undefined,
): ForcedEffortResolution {
  const mode = input.modelConfig?.thinking_config?.mode;
  if (mode === 'forced_off') {
    if (!requested || isThinkingEffortDisabled(requested)) return { handled: true, effort: 'off' };
    return throwUnsupportedEffort(input, requested);
  }
  if (mode === 'forced_on' && !requested) return { handled: true };
  if (mode === 'forced_on' && requested && isThinkingEffortDisabled(requested)) {
    return throwUnsupportedEffort(input, requested);
  }
  return { handled: false };
}

function resolveSwitchableOrCatalogEffort(
  input: EffortResolutionInput,
  requested: string | undefined,
): string | undefined {
  const miniMaxM3Mode = resolveMiniMaxM3ThinkingMode(
    input.providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX) ? undefined : input.modelId,
    input.modelConfig,
    input.runtimeDefaultVariant,
  );
  if (miniMaxM3Mode) {
    if (!requested) return miniMaxM3Mode;
    return isMiniMaxM3ThinkingMode(requested)
      ? requested
      : throwUnsupportedEffort(input, requested);
  }
  const options = normalizeModelThinkingEffortOptions(input.modelConfig?.thinking?.effortOptions);
  if (options) return resolveListedEffort(input, options, requested);
  return resolveUnlistedEffort(input, requested);
}

function resolveListedEffort(
  input: EffortResolutionInput,
  options: readonly string[],
  requested: string | undefined,
): string | undefined {
  if (!requested) {
    return input.defaultMissingEffortOff ? 'off' : resolveModelThinkingMiddleEffort(options);
  }
  if (requested === 'off' && !isOnOffThinkingOptions(options)) return 'off';
  if (options.includes(requested)) return requested;
  return throwUnsupportedEffort(input, requested);
}

function isOnOffThinkingOptions(options: readonly string[]): boolean {
  return options.includes('on') || options.includes('off');
}

function resolveUnlistedEffort(
  input: EffortResolutionInput,
  requested: string | undefined,
): string | undefined {
  if (!requested) return undefined;
  return throwUnsupportedEffort(input, requested);
}

function throwUnsupportedEffort(input: EffortResolutionInput, requested: string): never {
  throw new AgentModelSelectionError(
    'MODEL_EFFORT_UNSUPPORTED',
    `Thinking effort "${requested}" from ${input.source} is unavailable for ${input.modelKey}.`,
  );
}

function resolveLimit(input: {
  readonly field: 'contextWindow' | 'maxOutputTokens';
  readonly requested: number | undefined;
  readonly source: string;
  readonly physicalLimit: number | undefined;
  readonly defaultLimit?: number;
}): {
  readonly effective: number | undefined;
  readonly diagnostics: readonly AgentModelSelectionDiagnostic[];
} {
  if (input.requested === undefined) {
    return { effective: input.defaultLimit ?? input.physicalLimit, diagnostics: [] };
  }
  if (!Number.isSafeInteger(input.requested) || input.requested <= 0) {
    throw new AgentModelSelectionError(
      'MODEL_LIMIT_INVALID',
      `${input.field} from ${input.source} must be a positive safe integer.`,
    );
  }
  if (input.physicalLimit === undefined) {
    throw new AgentModelSelectionError(
      'MODEL_LIMIT_UNAVAILABLE',
      `${input.field} from ${input.source} requires a catalog physical limit.`,
    );
  }
  const effective = Math.min(input.requested, input.physicalLimit);
  const code =
    input.field === 'contextWindow' ? 'context_window_clamped' : 'max_output_tokens_clamped';
  return {
    effective,
    diagnostics:
      effective === input.requested
        ? []
        : [
            {
              code,
              source: input.source,
              requested: input.requested,
              effective,
              physicalLimit: input.physicalLimit,
            },
          ],
  };
}

function firstString(
  sources: readonly AgentModelSelectionSource[],
  field: 'effort',
): string | undefined {
  for (const source of sources) {
    const value = source.selection?.[field];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function firstNumber(
  sources: readonly AgentModelSelectionSource[],
  field: 'contextWindow' | 'maxOutputTokens',
): number | undefined {
  for (const source of sources) {
    const value = source.selection?.[field];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function sourceFor(
  sources: readonly AgentModelSelectionSource[],
  field: Exclude<keyof AgentModelSelectionInput, 'model'>,
): string | undefined {
  return sources.find((source) => source.selection?.[field] !== undefined)?.source;
}

function defaultsMissingEffortOff(
  sources: readonly AgentModelSelectionSource[],
  modelIndex: number,
  modelSource: AgentModelSelectionSource,
): boolean {
  if (modelSource.defaultMissingEffortOff === true) return true;
  return (
    modelSource.source === 'runtime-default' &&
    sources.slice(0, modelIndex).some((source) => source.defaultMissingEffortOff === true)
  );
}

function positiveLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
