import {
  AgentModelSelectionError,
  LocalModelProviderError,
  formatModelKey,
  isAdvisorReleased,
  parseSourceQualifiedModelKey,
  readAdvisorSelection,
  readStoredAdvisorSelection,
  type AdvisorModelSelectionInput,
  type LocalDefaultAdvisorConfig,
  type LocalRuntimeConfig,
} from '../../service/model-system/index.js';
import { isAdvisorContextWindow } from '@mavis/config';
import type { SessionAdvisorView } from '@mavis/protocol/local';

import type { AdvisorSelectionView, SelectAdvisorInput } from './model-provider-contracts.js';

/**
 * The selection an advisor write stores. Like the main model, picking another model starts a
 * fresh group (only the given thinking/window carry), the same model keeps its stored ones, and
 * `enabled: false` keeps everything so re-enabling needs no new pick. Enabling, an effort and a
 * window all apply to a model, so without one they are refused here: nothing could validate them.
 */
export function nextAdvisorSelection(
  current: AdvisorModelSelectionInput | null | undefined,
  given: SelectAdvisorInput,
): AdvisorModelSelectionInput {
  const input = normalizedAdvisorInput(given);
  const model = requestedAdvisorModel(input) ?? current?.model;
  if (!model && needsAdvisorModel(input)) {
    throw new LocalModelProviderError(
      400,
      'provider_id and model_id are required to enable the advisor or set its thinking or context_limit',
      'VALIDATION_ERROR',
    );
  }
  const kept = model !== undefined && model === current?.model ? current : undefined;
  return {
    enabled: input.enabled,
    ...(model === undefined ? {} : { model }),
    ...advisorParameters(kept, input),
  };
}

/**
 * The write's own format, checked whether or not the advisor is on: a window the config default
 * would take (a positive i32, so a Session, a side chat and the default agree), and a blank effort
 * means no effort, the same as an empty one.
 */
function normalizedAdvisorInput(input: SelectAdvisorInput): SelectAdvisorInput {
  if (input.contextLimit !== undefined && !isAdvisorContextWindow(input.contextLimit)) {
    throw new LocalModelProviderError(
      400,
      'context_limit must be a positive integer no larger than 2147483647',
      'VALIDATION_ERROR',
    );
  }
  const effort = input.thinking?.effort.trim();
  if (!input.thinking || effort === input.thinking.effort) return input;
  return { ...input, thinking: effort ? { effort } : null };
}

/** The thinking and window a write keeps: the request's, else the same model's stored ones. */
function advisorParameters(
  kept: AdvisorModelSelectionInput | undefined,
  input: SelectAdvisorInput,
): Pick<AdvisorModelSelectionInput, 'thinking' | 'contextWindow'> {
  const thinking = input.thinking === undefined ? kept?.thinking : (input.thinking ?? undefined);
  const contextWindow = input.contextLimit ?? kept?.contextWindow;
  return {
    ...(thinking?.effort ? { thinking: { effort: thinking.effort } } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

/**
 * Only an advisor that is on gets checked: an off one is never used, and turning it on checks it
 * then. So switching off always succeeds, even when the stored model has since become unusable,
 * whether it arrives as a SelectAdvisorModel write or as a new side chat's whole draft.
 */
export function advisorWriteNeedsValidation(
  selection: AdvisorModelSelectionInput,
): selection is AdvisorModelSelectionInput & { readonly model: string } {
  return Boolean(selection.model) && selection.enabled;
}

/** Config stores only the effort of the thinking selection, like the main default. */
export function toDefaultAdvisorConfig(
  selection: AdvisorModelSelectionInput,
): LocalDefaultAdvisorConfig {
  const effort = selection.thinking?.effort;
  return {
    enabled: selection.enabled,
    ...(selection.model === undefined ? {} : { model: selection.model }),
    ...(effort ? { thinking: { effort } } : {}),
    ...(selection.contextWindow === undefined ? {} : { contextWindow: selection.contextWindow }),
  };
}

/**
 * The stored selection a write merges onto: an effort or window its model no longer accepts is
 * left out, so such a leftover never blocks the next write. The global switch is not applied, so
 * a write while it is off keeps the stored model.
 */
export function readStoredAdvisor(
  config: LocalRuntimeConfig,
  stored: AdvisorModelSelectionInput | null | undefined,
): AdvisorModelSelectionInput | undefined {
  return stored ? readStoredAdvisorSelection(config, stored).selection : undefined;
}

/**
 * The listed Session advisor. Like the main model's listing, it reports what a Turn would run
 * without writing it; with the global switch off that is none.
 */
export function toAdvisorSelectionView(
  config: LocalRuntimeConfig,
  stored: AdvisorModelSelectionInput | null | undefined,
): AdvisorSelectionView {
  return advisorSelectionToView(
    stored ? readAdvisorSelection(config, stored).selection : undefined,
  );
}

/**
 * The listed new-conversation default. No Turn runs it: clients copy it into each conversation
 * they start, so a client copying this view writes a valid selection. It is listed as stored even
 * while the global switch is off, so a conversation started then runs it once the switch is on.
 * A build without the advisor lists none.
 */
export function toDefaultAdvisorSelectionView(
  config: LocalRuntimeConfig,
  stored: AdvisorModelSelectionInput | null | undefined,
): AdvisorSelectionView {
  return advisorSelectionToView(
    isAdvisorReleased(config) ? readStoredAdvisor(config, stored) : undefined,
  );
}

/**
 * A selection as the wire shows it. SessionInfo passes the stored selection, ListModels the one
 * a Turn reads (`toAdvisorSelectionView`); that is their only difference.
 */
export function advisorSelectionToView(
  selection: AdvisorModelSelectionInput | null | undefined,
): AdvisorSelectionView {
  if (!selection) return { enabled: false };
  const model = parseSourceQualifiedModelKey(selection.model);
  // An effort or window without a model applies to nothing, and a write would refuse it.
  if (!model) return { enabled: selection.enabled };
  const effort = selection.thinking?.effort;
  return {
    enabled: selection.enabled,
    providerId: model.providerId,
    modelId: model.modelId,
    ...(effort ? { thinking: { effort } } : {}),
    ...(selection.contextWindow === undefined ? {} : { contextLimit: selection.contextWindow }),
  };
}

/**
 * A SessionAdvisorView-shaped request (SelectAdvisorModel, a side chat's draft) as a write. A
 * thinking without an effort clears it; a draft has nothing stored, so that equals leaving it out.
 */
export function advisorViewToInput(
  view: SessionAdvisorView,
): Omit<SelectAdvisorInput, 'sessionId'> {
  return {
    enabled: view.enabled,
    ...(view.providerId !== undefined ? { providerId: view.providerId } : {}),
    ...(view.modelId !== undefined ? { modelId: view.modelId } : {}),
    ...(view.thinking !== undefined
      ? { thinking: view.thinking?.effort ? { effort: view.thinking.effort } : null }
      : {}),
    ...(view.contextLimit != null ? { contextLimit: Number(view.contextLimit) } : {}),
  };
}

/**
 * An unresolvable model reports the code SelectModel uses for an unavailable model; an
 * unsupported effort or window is a plain validation error.
 */
export function toAdvisorSelectionError(error: unknown): unknown {
  if (!(error instanceof AgentModelSelectionError)) return error;
  const code =
    error.code === 'MODEL_SELECTION_INVALID' || error.code === 'MODEL_SELECTION_INCOMPLETE'
      ? 'MODEL_NOT_AVAILABLE_FOR_ROUTE'
      : 'VALIDATION_ERROR';
  return new LocalModelProviderError(400, error.message, code);
}

function needsAdvisorModel(input: SelectAdvisorInput): boolean {
  return input.enabled || input.thinking != null || input.contextLimit !== undefined;
}

function requestedAdvisorModel(input: SelectAdvisorInput): string | undefined {
  const providerId = input.providerId?.trim();
  const modelId = input.modelId?.trim();
  if (!providerId && !modelId) return undefined;
  if (!providerId || !modelId) {
    throw new LocalModelProviderError(
      400,
      'provider_id and model_id must be given together',
      'VALIDATION_ERROR',
    );
  }
  return formatModelKey(providerId, modelId);
}
