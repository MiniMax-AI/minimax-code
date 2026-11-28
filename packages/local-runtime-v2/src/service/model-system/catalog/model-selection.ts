import { readOptionalString } from '../../../infra/conversation/model-selection.js';
import { ThinkingLevel } from '@mavis/protocol';
import { modelRefForModel, type ManagedModelParameterSnapshot } from '../resolution/model-ref.js';
import type {
  ConversationModelThinkingSelection,
  ConversationModelSelection,
} from '@mavis/conversation-contract';
import {
  DEFAULT_MODEL_PRESETS,
  deliveredDefaultModelId,
  getRuntimePresetKey,
  isLegacyManagedMinimaxProvider,
  listRouteModelIds,
  resolveModelReplacement,
} from '@mavis/config';
import { LocalModelProviderError, type LocalRuntimeConfig } from '../contracts.js';
import { parseProviderId, parseSourceQualifiedModelKey } from '../resolution/model-key.js';

export const LEGACY_MINIMAX_PROVIDER_ID = 'custom_provider:minimax-legacy';

export function isLegacyMinimaxProvider(config: LocalRuntimeConfig, providerId: string): boolean {
  const key = parseProviderId(providerId)?.providerKey;
  const provider = key ? config.custom_provider?.[key] : undefined;
  return isLegacyManagedMinimaxProvider(providerId, provider?.options?.baseURL);
}

/**
 * Resolves a retired managed alias without changing unrelated custom providers.
 * The first candidate `minimax` lists wins: the same model, the configured
 * default, then the delivered default and the first-run default. Never throws:
 * with nothing listed the alias maps to the same model on `minimax` for the
 * upstream to decide.
 */
export function resolveLegacyMinimaxModel(
  config: LocalRuntimeConfig,
  selection: { readonly providerId: string; readonly modelId: string },
): { readonly providerId: string; readonly modelId: string } | undefined {
  if (!isLegacyMinimaxProvider(config, selection.providerId)) return undefined;
  const preset = getRuntimePresetKey();
  const configured = parseSourceQualifiedModelKey(config.defaultModel);
  const firstRun = parseSourceQualifiedModelKey(DEFAULT_MODEL_PRESETS[preset].defaultModel);
  const listed = listRouteModelIds(config, 'minimax', preset);
  const modelId = [
    selection.modelId,
    configured &&
    (configured.providerId === 'minimax' || isLegacyMinimaxProvider(config, configured.providerId))
      ? configured.modelId
      : undefined,
    deliveredDefaultModelId(config.provider?.minimax),
    firstRun?.modelId,
  ].find((candidate): candidate is string => candidate !== undefined && listed.includes(candidate));
  return { providerId: 'minimax', modelId: modelId ?? selection.modelId };
}

/**
 * A saved Agent-level model that its official
 * route no longer lists falls back to the same provider's delivered default,
 * never to the Runtime default of another provider. `undefined` means the
 * saved model is used as stored.
 */
export function resolveSavedAgentModelReplacement(
  config: LocalRuntimeConfig,
  selection: { readonly providerId: string; readonly modelId: string },
): { readonly providerId: string; readonly modelId: string } | undefined {
  const outcome = resolveModelReplacement({
    config,
    providerId: selection.providerId,
    modelId: selection.modelId,
    preset: getRuntimePresetKey(),
  });
  return outcome.kind === 'replaced' ? outcome.model : undefined;
}

export const SELECTED_THINKING_EFFORT_CAPABILITY = 'selected_thinking_effort';

export function readSelectedThinkingEffort(
  capabilities: Record<string, unknown> | undefined,
): string | undefined {
  return readOptionalString(capabilities?.[SELECTED_THINKING_EFFORT_CAPABILITY]);
}

interface QueueSelection {
  readonly provider_id?: string;
  readonly model_id?: string;
  readonly variant?: string;
  readonly reasoning?: boolean;
  readonly context_limit?: number;
  readonly thinking?: { readonly effort?: string };
  readonly parameterSnapshot?: ManagedModelParameterSnapshot;
}

interface SessionSelection {
  readonly sessionKind?: string;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelContextWindow?: number | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
  readonly effectiveModelMaxOutputTokens?: number | null;
}

/** Freeze only managed execution choices; credentials and catalog metadata stay in Model System. */
type FrozenQueueSelection = {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly thinking?: ConversationModelThinkingSelection;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly parameterSnapshot?: ManagedModelParameterSnapshot;
};

function savedParameter<T>(value: T | null | undefined, historical: T | undefined): T | undefined {
  return value === undefined ? historical : (value ?? undefined);
}

/** Reads accepted Session columns; an existing historical model only fills missing values. */
export function savedSessionModel(
  session: SessionSelection,
  historical?: FrozenQueueSelection,
): FrozenQueueSelection | undefined {
  const identity = parseSourceQualifiedModelKey(session.effectiveModel ?? undefined);
  if (!identity) return undefined;
  const previous =
    historical?.providerId === identity.providerId && historical.modelId === identity.modelId
      ? historical
      : undefined;
  return {
    providerId: identity.providerId,
    modelId: identity.modelId,
    variant: savedParameter(session.effectiveModelVariant, previous?.variant),
    thinking: savedParameter(session.effectiveModelThinking, previous?.thinking),
    contextWindow: savedParameter(session.effectiveModelContextWindow, previous?.contextWindow),
    maxOutputTokens: savedParameter(
      session.effectiveModelMaxOutputTokens,
      previous?.maxOutputTokens,
    ),
    // No historical row means no legacy exemption. The whole stored selection is accepted.
    parameterSnapshot: previous
      ? previous.parameterSnapshot
      : { context: 'selection', effort: 'selection' },
  };
}

/** Preserve the selected global effort when ordinary create supplies only its model identity. */
function resolveCreateThinking(
  config: LocalRuntimeConfig,
  requested: ConversationModelSelection,
  providerId: string,
  modelId: string,
): ConversationModelSelection['thinking'] {
  const fallback = parseSourceQualifiedModelKey(config.defaultModel);
  const inheritsGlobalEffort =
    providerId === 'minimax' &&
    config.minimaxModelSource !== 'minimax_api_key' &&
    providerId === fallback?.providerId &&
    modelId === fallback?.modelId &&
    requested.thinking === undefined &&
    requested.reasoning !== false &&
    requested.variant !== '' &&
    requested.variant !== 'none-thinking';
  return inheritsGlobalEffort ? config.defaultModelThinking : requested.thinking;
}

/** Resolves explicit create input before any Session record is written. */
export function resolveRequestedSessionModel(
  config: LocalRuntimeConfig,
  input: ConversationModelSelection,
): ConversationModelSelection {
  const fallback = parseSourceQualifiedModelKey(config.defaultModel);
  const requestedProviderId = input.providerId?.trim() || fallback?.providerId;
  const requestedModelId = input.modelId?.trim() || fallback?.modelId;
  if (!requestedProviderId || !requestedModelId)
    throw new LocalModelProviderError(400, 'Model selection is incomplete', 'VALIDATION_ERROR');
  // A retired official model is replaced (its parameters do not carry over);
  // anything else is created as requested and the upstream decides.
  const outcome = resolveModelReplacement({
    config,
    providerId: requestedProviderId,
    modelId: requestedModelId,
    preset: getRuntimePresetKey(),
    fallbacks: [fallback],
  });
  const replaced = outcome.kind === 'replaced';
  const providerId = replaced ? outcome.model.providerId : requestedProviderId;
  const modelId = replaced ? outcome.model.modelId : requestedModelId;
  const requested: ConversationModelSelection = replaced ? { providerId, modelId } : input;
  const thinking = resolveCreateThinking(config, requested, providerId, modelId);
  const resolved = freezeManagedQueueModel(
    config,
    {},
    {
      provider_id: providerId,
      model_id: modelId,
      variant: requested.variant,
      reasoning: requested.reasoning,
      context_limit: requested.contextLimit,
      thinking,
    },
  );
  let variant = requested.variant;
  if (resolved?.reasoning !== undefined) variant = resolved.reasoning ? 'thinking' : '';
  return {
    providerId,
    modelId,
    variant,
    contextLimit: resolved?.context_limit,
    thinking: resolved?.thinking,
  };
}

export function freezeManagedQueueModel(
  config: LocalRuntimeConfig,
  session: SessionSelection,
  requested?: QueueSelection,
  frozenModel?: FrozenQueueSelection,
): QueueSelection | undefined {
  const saved = queueSessionModel(session, frozenModel);
  const inherited = inheritedQueueSelection(config, session, saved);
  const selection = requested ?? inherited;
  const requestedProvider = selection.provider_id ?? inherited.provider_id;
  const modelId = selection.model_id ?? inherited.model_id ?? '';
  // Only a listed managed model is frozen at admission. Anything else (another
  // route, or a model the catalog no longer lists) is left to Turn preparation,
  // which applies the replacement rule and repairs the Session.
  const model = listedManagedQueueModel(config, requestedProvider, modelId);
  if (!model) return requested;
  const provider = MANAGED_QUEUE_PROVIDER_ID;
  if (!requested && saved && !saved.parameterSnapshot) {
    return freezeLegacyQueueSelection(provider, modelId, model, selection);
  }
  const resolved = modelRefForModel(provider, modelId, model, {
    managed: true,
    variant: selection.variant,
    reasoning: selection.reasoning,
    contextLimit: selection.context_limit,
    thinking: selection.thinking,
    parameterSnapshot: selection.parameterSnapshot,
  });
  return frozenQueueSelection(provider, modelId, selection, resolved);
}

function queueSessionModel(session: SessionSelection, frozenModel?: FrozenQueueSelection) {
  if (session.sessionKind === 'task' && frozenModel) return frozenModel;
  return savedSessionModel(session, frozenModel);
}

const MANAGED_QUEUE_PROVIDER_ID = 'minimax';

function listedManagedQueueModel(
  config: LocalRuntimeConfig,
  provider: string | undefined,
  modelId: string,
) {
  if (provider !== MANAGED_QUEUE_PROVIDER_ID || config.minimaxModelSource === 'minimax_api_key')
    return undefined;
  const model = config.provider?.minimax?.models?.[modelId];
  return modelId && model && model.enabled !== false ? model : undefined;
}

function freezeLegacyQueueSelection(
  provider: string,
  modelId: string,
  model: Parameters<typeof modelRefForModel>[2],
  selection: QueueSelection,
): QueueSelection {
  const resolved = modelRefForModel(provider, modelId, model, {
    variant: selection.variant,
    thinking: selection.thinking,
  });
  const effort =
    resolved.thinking_level === ThinkingLevel.OFF
      ? undefined
      : readSelectedThinkingEffort({ ...resolved.capabilities });
  const context =
    Number.isSafeInteger(selection.context_limit) && Number(selection.context_limit) > 0
      ? selection.context_limit
      : resolved.context_window;
  return {
    provider_id: provider,
    model_id: modelId,
    variant: resolved.thinking_level === ThinkingLevel.OFF ? '' : 'thinking',
    reasoning: resolved.thinking_level !== ThinkingLevel.OFF,
    ...(context === undefined ? {} : { context_limit: context }),
    ...(effort ? { thinking: { effort } } : {}),
    parameterSnapshot: { context: 'legacy', effort: 'legacy' },
  };
}

function frozenQueueSelection(
  provider: string,
  modelId: string,
  selection: QueueSelection,
  resolved: ReturnType<typeof modelRefForModel>,
): QueueSelection {
  return {
    provider_id: provider,
    model_id: modelId,
    reasoning: resolved.thinking_level !== ThinkingLevel.OFF,
    ...(resolved.context_window === undefined ? {} : { context_limit: resolved.context_window }),
    ...(resolved.thinking_effort ? { thinking: { effort: resolved.thinking_effort } } : {}),
    parameterSnapshot: selection.parameterSnapshot ?? {
      context: selection.context_limit === undefined ? 'default' : 'selection',
      effort: selection.thinking?.effort === undefined ? 'default' : 'selection',
    },
  };
}

function inheritedQueueSelection(
  config: LocalRuntimeConfig,
  session: SessionSelection,
  frozen?: FrozenQueueSelection,
): QueueSelection {
  if (frozen)
    return {
      provider_id: frozen.providerId,
      model_id: frozen.modelId,
      variant: frozen.variant,
      thinking: frozen.thinking,
      context_limit: frozen.contextWindow,
      parameterSnapshot: frozen.parameterSnapshot,
    };
  const key = session.effectiveModel ?? config.defaultModel ?? '';
  const separator = key.indexOf('/');
  const parameters = session.effectiveModel
    ? session
    : {
        effectiveModelVariant: config.defaultModelVariant,
        effectiveModelContextWindow: config.defaultModelContextWindow,
        effectiveModelThinking: config.defaultModelThinking,
      };
  return {
    provider_id: key.slice(0, separator),
    model_id: key.slice(separator + 1),
    variant: parameters.effectiveModelVariant ?? undefined,
    context_limit: parameters.effectiveModelContextWindow ?? undefined,
    thinking: parameters.effectiveModelThinking ?? undefined,
  };
}

export type { LocalModelThinkingBudgets } from '../../../infra/conversation/model-selection.js';
export type { LocalModelThinkingSelection } from '../../../infra/conversation/model-selection.js';
export type { LocalModelOverride } from '../../../infra/conversation/model-selection.js';
export { readLocalModelThinkingSelection } from '../../../infra/conversation/model-selection.js';
export { readPersistedLocalModelThinkingSelection } from '../../../infra/conversation/model-selection.js';
export { readLocalModelOverride } from '../../../infra/conversation/model-selection.js';
