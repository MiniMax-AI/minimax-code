import { isAdvisorReleasedInConfig, resolveAdvisorSwitch } from '@mavis/config';
import type { ConversationModelThinkingSelection } from '@mavis/conversation-contract';
import { lookupLocalModelLimits } from '../../../infra/config/model-catalog.js';
import type { LocalConversationRuntimeConfig } from '../contracts.js';
import {
  AgentModelSelectionError,
  resolveEffectiveAgentModelSelection,
  type ResolvedAgentModelSelection,
} from './agent-model-selection.js';

/** A stored advisor selection, e.g. a Session's; structurally the same shape. */
export interface AdvisorModelSelectionInput {
  readonly enabled: boolean;
  /** `providerId/modelId`. */
  readonly model?: string;
  readonly thinking?: ConversationModelThinkingSelection;
  /** The advisor's own window choice; absent uses the catalog default. */
  readonly contextWindow?: number;
}

/** The advisor model group a selection resolves to for one Turn; recomputed every Turn. */
export interface ResolvedAdvisorModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

/** A stored parameter an execution read set aside because the model no longer accepts it. */
type AdvisorDroppedParameter = 'effort' | 'contextWindow';

/** How an execution read resolved a stored selection; see {@link readAdvisorSelection}. */
interface AdvisorSelectionRead {
  /** The stored selection without the parameters its model no longer accepts. */
  readonly selection: AdvisorModelSelectionInput;
  /** The Turn's advisor: absent when disabled, without a model, or the model is unusable. */
  readonly advisor?: ResolvedAdvisorModel;
  readonly dropped: readonly AdvisorDroppedParameter[];
  /** Why the stored model itself cannot be used. */
  readonly failure?: { readonly code: string; readonly message: string };
}

const DROPPABLE_PARAMETER: Readonly<Record<string, AdvisorDroppedParameter>> = {
  MODEL_EFFORT_UNSUPPORTED: 'effort',
  MODEL_LIMIT_INVALID: 'contextWindow',
  MODEL_LIMIT_UNAVAILABLE: 'contextWindow',
};

/**
 * Whether this build ships the advisor (`beta.advisor`: on in every channel by default; an
 * explicit `beta.advisor: false` turns it off).
 * A product config carries the value it resolved for its package; one without it (a bare
 * runtime config) resolves for this process, the same way `getConfig()` would.
 */
export function isAdvisorReleased(config: Pick<LocalConversationRuntimeConfig, 'beta'>): boolean {
  return isAdvisorReleasedInConfig(config);
}

/**
 * Single source of truth for whether a stored advisor is usable and with which limits, read
 * the way the main model's selection is (reads fall back, saves validate strictly). It resolves
 * with the same catalog and route rules as an Agent model, without reading credentials. An
 * effort or window the model no longer accepts falls back to the model default instead of
 * disabling the advisor; only an unusable model leaves no advisor. Writes keep the strict
 * {@link validateAdvisorModel}. Never throws. A build without the advisor, or with the global
 * switch (`advisor.enabled`) off, reads every stored one as none, so no Turn offers the tool and
 * every listing shows it off; what is stored stays, so turning the switch on brings it back.
 */
export function readAdvisorSelection(
  config: LocalConversationRuntimeConfig,
  stored: AdvisorModelSelectionInput,
): AdvisorSelectionRead {
  if (!resolveAdvisorSwitch(config)) return { selection: { enabled: false }, dropped: [] };
  return readStoredAdvisorSelection(config, stored);
}

/**
 * {@link readAdvisorSelection} without the switch: the stored selection with the parameters its
 * model no longer accepts set aside. Writes merge onto this, so one made while the switch is off
 * keeps the stored model.
 */
export function readStoredAdvisorSelection(
  config: LocalConversationRuntimeConfig,
  stored: AdvisorModelSelectionInput,
): AdvisorSelectionRead {
  let selection = stored;
  const dropped: AdvisorDroppedParameter[] = [];
  const model = stored.model;
  if (!model) return { selection, dropped };
  for (;;) {
    try {
      const advisor = validateAdvisorModel(config, { ...selection, model });
      return { selection, dropped, ...(selection.enabled ? { advisor } : {}) };
    } catch (error) {
      const parameter =
        error instanceof AgentModelSelectionError ? DROPPABLE_PARAMETER[error.code] : undefined;
      if (!parameter || !hasParameter(selection, parameter)) {
        return { selection, dropped, failure: selectionFailure(error) };
      }
      selection = withoutParameter(selection, parameter);
      dropped.push(parameter);
    }
  }
}

function hasParameter(
  selection: AdvisorModelSelectionInput,
  parameter: AdvisorDroppedParameter,
): boolean {
  return parameter === 'effort'
    ? selection.thinking?.effort !== undefined
    : selection.contextWindow !== undefined;
}

function withoutParameter(
  selection: AdvisorModelSelectionInput,
  parameter: AdvisorDroppedParameter,
): AdvisorModelSelectionInput {
  const { thinking, contextWindow, ...rest } = selection;
  return {
    ...rest,
    ...(parameter === 'effort' || thinking === undefined ? {} : { thinking }),
    ...(parameter === 'contextWindow' || contextWindow === undefined ? {} : { contextWindow }),
  };
}

function selectionFailure(error: unknown): { readonly code: string; readonly message: string } {
  return error instanceof AgentModelSelectionError
    ? { code: error.code, message: error.message }
    : { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
}

/**
 * The strict form of {@link readAdvisorSelection} for selection writes: the same resolution, but
 * an unusable model, effort or window throws the catalog's `AgentModelSelectionError`.
 */
export function validateAdvisorModel(
  config: LocalConversationRuntimeConfig,
  selection: Omit<AdvisorModelSelectionInput, 'enabled'> & { readonly model: string },
): ResolvedAdvisorModel {
  const effort = selection.thinking?.effort;
  const resolved: ResolvedAgentModelSelection | undefined = resolveEffectiveAgentModelSelection({
    config,
    sources: [
      {
        source: 'session-advisor',
        selection: {
          model: selection.model,
          ...(effort === undefined ? {} : { effort }),
          ...(selection.contextWindow === undefined
            ? {}
            : { contextWindow: selection.contextWindow }),
        },
        requireCatalog: true,
      },
    ],
  });
  if (!resolved) {
    throw new AgentModelSelectionError('MODEL_SELECTION_INCOMPLETE', 'No advisor model selected.');
  }
  return withLimitFallback(resolved);
}

/** Catalog limits first; otherwise the same global fallback the local model resolver uses. */
function withLimitFallback(resolved: ResolvedAgentModelSelection): ResolvedAdvisorModel {
  const fallback = lookupLocalModelLimits(resolved.providerId, resolved.modelId);
  return {
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
    contextWindow: resolved.contextWindow ?? fallback.contextWindow,
    maxOutputTokens: resolved.maxOutputTokens ?? fallback.maxTokens,
  };
}
