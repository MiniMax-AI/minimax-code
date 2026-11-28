import { publishBestEffort } from '../events.js';
import { ThinkingLevel } from '@mavis/protocol';
import { getRuntimePresetKey, resolveModelAvailability } from '@mavis/config';
import {
  LocalModelProviderError,
  MANAGED_MINIMAX_PROVIDER_ID,
  formatModelKey,
  freezeManagedQueueModel,
  savedSessionModel,
  isLegacyMinimaxProvider,
  listLocalRuntimeModels,
  modelConfigForRef,
  modelRefForModel,
  type ManagedModelParameterSnapshot,
  parseSourceQualifiedModelKey,
  resolveLegacyMinimaxModel,
  validateAdvisorModel,
  isAdvisorReleased,
  type AdvisorModelSelectionInput,
  type ModelProviderModelEntry,
} from '../../service/model-system/index.js';

import {
  advisorWriteNeedsValidation,
  nextAdvisorSelection,
  readStoredAdvisor,
  toAdvisorSelectionError,
  toAdvisorSelectionView,
  toDefaultAdvisorConfig,
  toDefaultAdvisorSelectionView,
} from './model-provider-advisor.js';
import type {
  AdvisorSelectionView,
  ModelProviderApplicationDeps,
  ModelProviderSessionView,
  SelectAdvisorInput,
  SelectRuntimeModelInput,
} from './model-provider-contracts.js';

/** Cross-capability model catalog and selection workflow owned by Runtime V2. */
export class ModelProviderApplication {
  constructor(private readonly deps: ModelProviderApplicationDeps) {}

  async list(input: { readonly sessionId?: string } = {}): Promise<ModelProviderModelEntry[]> {
    return (await this.readCatalog(input)).models;
  }

  async listWithAdvisor(input: { readonly sessionId?: string } = {}): Promise<{
    readonly models: ModelProviderModelEntry[];
    readonly advisor: AdvisorSelectionView;
  }> {
    const { models, session, config } = await this.readCatalog(input);
    const advisor = input.sessionId
      ? toAdvisorSelectionView(config, session?.advisor)
      : toDefaultAdvisorSelectionView(config, config.defaultAdvisor);
    return { models, advisor };
  }

  async readAdvisor(input: { readonly sessionId?: string } = {}): Promise<AdvisorSelectionView> {
    const config = this.deps.config();
    if (!input.sessionId) return toDefaultAdvisorSelectionView(config, config.defaultAdvisor);
    const session = await this.deps.sessions.get(input.sessionId);
    return toAdvisorSelectionView(config, session?.advisor);
  }

  private async readCatalog(input: { readonly sessionId?: string }) {
    await this.refresh();
    const session = input.sessionId ? await this.deps.sessions.get(input.sessionId) : undefined;
    const config = this.deps.config();
    const selected = this.resolveLegacySelection(config, modelSelectionFromSession(session));
    const models = listLocalRuntimeModels(config, selected, {
      cache: this.deps.providers.loadCacheData(),
      ...(this.deps.implicitCustomProviderThinking ? { implicitCustomProviderThinking: true } : {}),
    });
    const catalog = models.filter((model) => !isLegacyMinimaxProvider(config, model.providerId));
    const stored = input.sessionId
      ? session
      : {
          effectiveModelContextWindow: config.defaultModelContextWindow,
          effectiveModelThinking: config.defaultModelThinking,
        };
    const projected =
      input.sessionId &&
      selected &&
      session?.effectiveModel !== `${selected.providerId}/${selected.modelId}`
        ? catalog
        : projectStoredParameters(catalog, stored);
    return { models: projected, session, config };
  }

  async selectAdvisor(input: SelectAdvisorInput): Promise<AdvisorSelectionView> {
    const session = input.sessionId
      ? await this.deps.sessions.get(input.sessionId)
      : undefined;
    if (input.sessionId && !session) {
      throw new LocalModelProviderError(404, 'Session not found', 'SESSION_NOT_FOUND');
    }
    if (session?.sessionKind === 'channel') {
      throw new LocalModelProviderError(
        409,
        'The advisor is not available for IM channel Sessions.',
        'ADVISOR_SESSION_UNSUPPORTED',
      );
    }
    const config = this.deps.config();
    const selection = this.resolveAdvisorWrite(
      session ? session.advisor : config.defaultAdvisor,
      input,
    );
    if (input.sessionId) {
      await this.deps.sessions.updateAdvisor(input.sessionId, selection);
      return toAdvisorSelectionView(this.deps.config(), selection);
    }
    try {
      await this.deps.setDefaultAdvisor(toDefaultAdvisorConfig(selection));
    } catch (error) {
      throw new LocalModelProviderError(
        400,
        error instanceof Error ? error.message : String(error),
        'CONFIG_WRITE_FAILED',
      );
    }
    this.publishDefaultModelChanged();
    return toDefaultAdvisorSelectionView(this.deps.config(), selection);
  }

  resolveAdvisorWrite(
    stored: AdvisorModelSelectionInput | null | undefined,
    input: Omit<SelectAdvisorInput, 'sessionId'>,
  ): AdvisorModelSelectionInput {
    const config = this.deps.config();
    if (!isAdvisorReleased(config)) {
      throw new LocalModelProviderError(
        403,
        'The advisor is turned off (beta.advisor: false in config.yaml).',
        'ADVISOR_DISABLED',
      );
    }
    const selection = nextAdvisorSelection(readStoredAdvisor(config, stored), input);
    if (advisorWriteNeedsValidation(selection)) {
      this.assertAdvisorUsable(selection, input.contextLimit);
    }
    return selection;
  }

  private assertAdvisorUsable(
    selection: AdvisorModelSelectionInput & { readonly model: string },
    contextLimit: number | undefined,
  ): void {
    const parsed = parseSourceQualifiedModelKey(selection.model);
    if (!parsed) {
      throw new LocalModelProviderError(
        400,
        `Unknown advisor model ${selection.model}`,
        'MODEL_NOT_AVAILABLE_FOR_ROUTE',
      );
    }
    const { providerId, modelId } = parsed;
    this.assertModelAvailable(providerId, modelId);
    this.deps.providers.assertModelSelectable(providerId, modelId);
    const config = this.deps.config();
    if (contextLimit !== undefined) {
      const catalogEntry = listLocalRuntimeModels(config, undefined, {
        cache: this.deps.providers.loadCacheData(),
      }).find((entry) => entry.providerId === providerId && entry.modelId === modelId);
      validateContextLimit(
        { contextLimit },
        catalogEntry,
        modelConfigForRef(config, providerId, modelId),
      );
    }
    try {
      validateAdvisorModel(config, selection);
    } catch (error) {
      throw toAdvisorSelectionError(error);
    }
  }

  private resolveLegacySelection(
    config: ReturnType<ModelProviderApplicationDeps['config']>,
    selected: ReturnType<typeof modelSelectionFromSession>,
  ): ReturnType<typeof modelSelectionFromSession> {
    const current = selected ?? parseSourceQualifiedModelKey(config.defaultModel);
    if (!current?.providerId || !current.modelId) return selected;
    try {
      const replacement = resolveLegacyMinimaxModel(config, {
        providerId: current.providerId,
        modelId: current.modelId,
      });
      return replacement ? { ...replacement, variant: null } : selected;
    } catch (error) {
      // Keep the picker available when no official model can serve this route.
      if (
        error instanceof LocalModelProviderError &&
        error.code === 'MODEL_NOT_AVAILABLE_FOR_ROUTE'
      ) {
        return selected;
      }
      throw error;
    }
  }

  async refresh(): Promise<void> {
    try {
      await this.deps.refreshOfficialModels?.();
    } catch {
      // Official refresh is fail-open; the catalog keeps its last-known-good config.
    }
  }

  async select(input: SelectRuntimeModelInput): Promise<boolean> {
    const replacement = resolveLegacyMinimaxModel(this.deps.config(), input);
    let selection: SelectRuntimeModelInput = replacement
      ? { ...replacement, sessionId: input.sessionId, thinking: null }
      : input;
    const providerId = selection.providerId.trim();
    const modelId = selection.modelId.trim();
    if (!providerId || !modelId) {
      throw new LocalModelProviderError(
        400,
        'provider_id and model_id are required',
        'VALIDATION_ERROR',
      );
    }
    this.assertModelAvailable(providerId, modelId);
    this.deps.providers.assertModelSelectable(providerId, modelId);
    const catalogEntry = listLocalRuntimeModels(this.deps.config(), undefined, {
      cache: this.deps.providers.loadCacheData(),
    }).find((entry) => entry.providerId === providerId && entry.modelId === modelId);
    selection = normalizeRequestedParameters(
      this.deps.config(),
      { ...selection, providerId, modelId },
      catalogEntry,
    );
    const modelKey = formatModelKey(providerId, modelId);
    if (selection.sessionId) {
      await this.selectForSession({
        sessionId: selection.sessionId,
        modelKey,
        input: selection,
        catalogEntry,
        ...(replacement ? { staleModel: formatModelKey(input.providerId, input.modelId) } : {}),
      });
      return true;
    }
    await this.selectDefaultModel(modelKey, selection);
    this.publishDefaultModelChanged();
    return true;
  }

  private publishDefaultModelChanged(): void {
    const saved = this.deps.config();
    const savedModel = parseSourceQualifiedModelKey(saved.defaultModel);
    if (this.deps.publish && savedModel) {
      publishBestEffort(this.deps.publish, {
        type: 'session.model_updated',
        payload: {
          providerId: savedModel.providerId,
          modelId: savedModel.modelId,
          variant: saved.defaultModelVariant ?? null,
          thinking: saved.defaultModelThinking ?? null,
          contextLimit: saved.defaultModelContextWindow ?? null,
        },
      });
    }
  }

  private async selectDefaultModel(
    modelKey: string,
    selection: SelectRuntimeModelInput,
  ): Promise<void> {
    try {
      await this.deps.setDefaultModel(
        modelKey,
        selection.variant,
        ...(selection.replaceSelection ||
        selection.contextLimit !== undefined ||
        selection.thinking !== undefined
          ? [
              {
                ...(selection.contextLimit !== undefined
                  ? { contextLimit: selection.contextLimit }
                  : {}),
                ...(selection.thinking ? { thinking: selection.thinking } : {}),
              },
            ]
          : []),
      );
    } catch (error) {
      throw new LocalModelProviderError(
        400,
        error instanceof Error ? error.message : String(error),
        'CONFIG_WRITE_FAILED',
      );
    }
  }

  private async selectForSession(scope: {
    readonly sessionId: string;
    readonly modelKey: string;
    readonly input: SelectRuntimeModelInput;
    readonly catalogEntry: ModelProviderModelEntry | undefined;
    readonly staleModel?: string;
  }): Promise<void> {
    const { sessionId, modelKey, input, catalogEntry, staleModel } = scope;
    const session = await this.deps.sessions.get(sessionId);
    if (!session) {
      throw new LocalModelProviderError(404, 'Session not found', 'SESSION_NOT_FOUND');
    }
    if (staleModel && session.effectiveModel && session.effectiveModel !== staleModel) return;
    await this.deps.sessions.update(sessionId, {
      effectiveModel: modelKey,
      effectiveModelVariant: input.variant ?? null,
      ...thinkingSelectionUpdate(session, modelKey, input),
      ...sessionLimitUpdate(this.deps.config(), session, {
        modelKey,
        input,
        catalog: catalogEntry,
      }),
      ...managedReplacementParameters(this.deps.config(), input, session),
    });
  }

  private assertModelAvailable(providerId: string, modelId: string): void {
    const availability = resolveModelAvailability({
      config: this.deps.config(),
      providerId,
      modelId,
      preset: getRuntimePresetKey(),
      source: 'explicit_request',
    });
    if (availability.available) return;
    throw new LocalModelProviderError(400, availability.message, availability.code);
  }
}

function isManagedSelection(
  config: ReturnType<ModelProviderApplicationDeps['config']>,
  providerId: string,
): boolean {
  return (
    providerId === MANAGED_MINIMAX_PROVIDER_ID && config.minimaxModelSource !== 'minimax_api_key'
  );
}

function normalizeRequestedParameters(
  config: ReturnType<ModelProviderApplicationDeps['config']>,
  selection: SelectRuntimeModelInput,
  catalogEntry: ModelProviderModelEntry | undefined,
): SelectRuntimeModelInput {
  const modelConfig = modelConfigForRef(config, selection.providerId, selection.modelId);
  let normalized = selection;
  if (isManagedSelection(config, selection.providerId))
    normalized = normalizeManagedSelection(selection, modelConfig);
  else validateContextLimit(selection, catalogEntry, modelConfig);
  if (normalized.reasoning === undefined) return normalized;
  if (typeof normalized.reasoning !== 'boolean')
    throw new LocalModelProviderError(400, 'Invalid model reasoning', 'VALIDATION_ERROR');
  return { ...normalized, variant: normalized.reasoning ? 'thinking' : '' };
}

function normalizeManagedSelection(
  selection: SelectRuntimeModelInput,
  config: ReturnType<typeof modelConfigForRef>,
): SelectRuntimeModelInput {
  const resolved = modelRefForModel(selection.providerId, selection.modelId, config, {
    managed: true,
    variant: selection.variant,
    reasoning: selection.reasoning,
    contextLimit: selection.contextLimit,
    thinking: selection.thinking ?? undefined,
  });
  if (
    selection.reasoning === false ||
    selection.variant === '' ||
    selection.variant === 'none-thinking'
  )
    return { ...selection, thinking: null };
  if (selection.thinking == null) return selection;
  const thinking =
    selection.thinking.effort != null && resolved.thinking_effort
      ? { effort: resolved.thinking_effort }
      : null;
  return { ...selection, thinking };
}

function managedReplacementParameters(
  config: ReturnType<ModelProviderApplicationDeps['config']>,
  input: SelectRuntimeModelInput,
  session: ModelProviderSessionView,
) {
  const saved = savedSessionModel(session, session.frozenModel);
  if (
    !isManagedSelection(config, input.providerId) ||
    (!input.replaceSelection &&
      session.effectiveModel === formatModelKey(input.providerId, input.modelId) &&
      saved !== undefined &&
      !saved.parameterSnapshot &&
      input.contextLimit === undefined &&
      input.thinking == null)
  )
    return {};
  const inherited = inheritedManagedParameters(config, input, session);
  const { overrides, modelParameterSnapshot } = managedSessionOverrides(input, inherited);
  const resolved = modelRefForModel(
    input.providerId,
    input.modelId,
    modelConfigForRef(config, input.providerId, input.modelId),
    overrides,
  );
  return managedSessionParameterUpdate(
    resolved,
    input,
    modelParameterSnapshot,
    !!inherited && !!saved?.parameterSnapshot,
  );
}

function managedSessionParameterUpdate(
  resolved: ReturnType<typeof modelRefForModel>,
  input: SelectRuntimeModelInput,
  modelParameterSnapshot: ManagedModelParameterSnapshot,
  preserveUnchanged: boolean,
) {
  const variant = resolved.thinking_level === ThinkingLevel.OFF ? '' : 'thinking';
  const thinking = resolved.thinking_effort ? { effort: resolved.thinking_effort } : null;
  const context = resolved.context_window ?? null;
  if (preserveUnchanged)
    return {
      effectiveModelVariant: variant,
      ...(input.thinking === undefined ? {} : { effectiveModelThinking: thinking }),
      ...(input.contextLimit === undefined ? {} : { effectiveModelContextWindow: context }),
    };
  return {
    effectiveModelVariant: variant,
    effectiveModelThinking: thinking,
    effectiveModelContextWindow: context,
    modelParameterSnapshot,
  };
}

function managedSessionOverrides(
  input: SelectRuntimeModelInput,
  inherited: ReturnType<typeof inheritedManagedParameters>,
) {
  const modelParameterSnapshot = managedSessionParameterOrigins(
    input,
    inherited?.parameterSnapshot,
  );
  return {
    modelParameterSnapshot,
    overrides: {
      managed: true,
      ...(inherited ? { parameterSnapshot: modelParameterSnapshot } : {}),
      variant: input.variant ?? inherited?.variant,
      reasoning: input.reasoning,
      contextLimit: input.contextLimit ?? inherited?.context_limit,
      thinking: input.thinking === undefined ? inherited?.thinking : (input.thinking ?? undefined),
    },
  };
}

function managedSessionParameterOrigins(
  input: SelectRuntimeModelInput,
  inherited?: ManagedModelParameterSnapshot,
): ManagedModelParameterSnapshot {
  const effort = input.thinking?.effort === undefined ? 'default' : 'selection';
  return {
    context: input.contextLimit === undefined ? (inherited?.context ?? 'default') : 'selection',
    effort: input.thinking === undefined ? (inherited?.effort ?? 'default') : effort,
  };
}

function inheritedManagedParameters(
  config: ReturnType<ModelProviderApplicationDeps['config']>,
  input: SelectRuntimeModelInput,
  session: ModelProviderSessionView,
) {
  if (
    input.replaceSelection ||
    session.effectiveModel !== formatModelKey(input.providerId, input.modelId)
  )
    return undefined;
  return freezeManagedQueueModel(config, session, undefined, session.frozenModel);
}

function sessionLimitUpdate(
  config: ReturnType<ModelProviderApplicationDeps['config']>,
  session: ModelProviderSessionView,
  scope: {
    readonly modelKey: string;
    readonly input: SelectRuntimeModelInput;
    readonly catalog: ModelProviderModelEntry | undefined;
  },
) {
  const { modelKey, input, catalog } = scope;
  const reset = session.effectiveModel !== modelKey || input.replaceSelection;
  const defaults = reset
    ? {
        effectiveModelContextWindow:
          input.replaceSelection && isManagedSelection(config, input.providerId)
            ? null
            : (catalog?.contextLimit ?? null),
        effectiveModelMaxOutputTokens: catalog?.maxOutputTokens ?? null,
      }
    : {};
  return {
    ...defaults,
    ...(input.contextLimit === undefined
      ? {}
      : { effectiveModelContextWindow: input.contextLimit }),
  };
}

function projectStoredParameters(
  catalog: ModelProviderModelEntry[],
  stored:
    | Pick<ModelProviderSessionView, 'effectiveModelContextWindow' | 'effectiveModelThinking'>
    | undefined,
): ModelProviderModelEntry[] {
  const contextLimit = stored?.effectiveModelContextWindow;
  const thinking = stored?.effectiveModelThinking;
  const context =
    contextLimit && Number.isSafeInteger(contextLimit) && contextLimit > 0 ? { contextLimit } : {};
  return catalog.map((entry) =>
    entry.selected ? { ...entry, ...context, ...(thinking ? { thinking } : {}) } : entry,
  );
}

function thinkingSelectionUpdate(
  session: ModelProviderSessionView,
  modelKey: string,
  input: SelectRuntimeModelInput,
): { readonly effectiveModelThinking?: SelectRuntimeModelInput['thinking'] } {
  if (input.thinking !== undefined) return { effectiveModelThinking: input.thinking };
  if (session.effectiveModel === modelKey && !input.replaceSelection) return {};
  return { effectiveModelThinking: null };
}

function modelSelectionFromSession(session: ModelProviderSessionView | undefined):
  | {
      readonly providerId?: string;
      readonly modelId?: string;
      readonly variant?: string | null;
    }
  | undefined {
  const parsed = parseSourceQualifiedModelKey(session?.effectiveModel);
  if (!parsed) return undefined;
  return {
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    ...(session?.effectiveModelVariant !== undefined
      ? { variant: session.effectiveModelVariant }
      : {}),
  };
}

function validateContextLimit(
  input: Pick<SelectRuntimeModelInput, 'contextLimit'>,
  catalogEntry: ModelProviderModelEntry | undefined,
  modelConfig?: ReturnType<typeof modelConfigForRef>,
): void {
  if (input.contextLimit === undefined) return;
  const limit = input.contextLimit;
  if (
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    limit <= 2_147_483_647 &&
    (catalogEntry?.contextWindowOptions?.includes(limit) ||
      modelConfig?.contextWindowOptions?.includes(limit) ||
      (catalogEntry?.contextLimit !== undefined && limit <= catalogEntry.contextLimit))
  )
    return;
  throw new LocalModelProviderError(
    400,
    'context_limit must be supported by the selected model',
    'VALIDATION_ERROR',
  );
}
