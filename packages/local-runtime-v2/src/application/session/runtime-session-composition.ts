import { isLocalSourceProvenanceEnabled } from '@mavis/config';
import type { InternalTurnPromptReadRegistry } from '@mavis/agent-runtime';
import type { GlobalEventInput } from '@mavis/shared/global-events';

import type { V1SessionCompatibility } from '../../compat/v1/session.js';
import { AgentServiceError, type LocalAgentService } from '../../service/agent/index.js';
import type { BrowserUseService } from '../../service/browser-use/index.js';
import type { ContentSafetyService } from '../../service/content-safety/index.js';
import type { CronMetricsClient } from '../../service/cron/index.js';
import type { ComposedInspector } from '../../service/llm-context-inspector/index.js';
import {
  initializeModelSystem,
  freezeManagedQueueModel,
  resolveRequestedSessionModel,
  LocalModelProviderError,
  resolveBuiltinAgentModelGroup,
  previewAgentModelSelection,
  resolveEffectiveAgentModelSelection,
  AgentModelSelectionError,
  type ModelSystemConfigPort,
  type ModelSystemOwner,
} from '../../service/model-system/index.js';
import {
  createImportedSessionPinCallback,
  initializePinService,
  type PinService,
} from '../../service/pin/index.js';
import type { PluginServiceLogger } from '../../service/plugin-system/index.js';
import {
  createCanonicalRecoveryLoggerAdapter,
  initializeSessionSystem,
  QueueServiceError,
  type SessionAgentDefinitionBackfillSkip,
  type SessionBackfillDiagnostics,
  type SessionSystemFactPorts,
  type SessionSystemOwner,
} from '../../service/session-system/index.js';
import {
  createProductionAgentPreparation,
  createProductionRootArchiveTitleModel,
  createProductionSessionTitleModel,
  createSessionModelRepair,
  type GlobalInstructions,
  type ProductionAgentPreparation,
  type ProductionAgentProductCapabilities,
} from '../../service/turn-system/index.js';
import type { AgentSessionPorts } from '../agent/agent-application.js';
import { createRuntimeAgentProduct } from '../agent/runtime-agent-product.js';
import {
  createApplicationFactPorts,
  createCommittedModelProviderSessionPort,
} from './fact-ports.js';
import { ModelProviderApplication } from './model-provider-application.js';
import { createRuntimeCompactionFactSink } from './runtime-compaction-facts.js';
import { describeError } from './turn-message-delivery.js';
import { queryCollapseSteeringProjection } from '../conversation/index.js';
import { createSessionTitlePolicy } from './session-title-policy.js';

export interface ProductionSessionComposition {
  readonly product: ProductionAgentProductCapabilities;
  readonly preparation: ProductionAgentPreparation;
  readonly modelSystem: ModelSystemOwner;
  readonly modelProviderApplication: ModelProviderApplication;
  readonly sessionSystem: SessionSystemOwner;
  readonly pinService: PinService;
  readonly globalInstructions: GlobalInstructions;
  readonly archiveTitleModel: ReturnType<typeof createProductionRootArchiveTitleModel>;
  readonly facts: SessionSystemFactPorts;
}

export interface RuntimeSessionCompositionInput {
  readonly db: Parameters<typeof initializeSessionSystem>[0]['db'];
  readonly dataDir: string;
  readonly baseProduct: Omit<ProductionAgentProductCapabilities, 'agents'>;
  readonly compatibility: V1SessionCompatibility;
  readonly agentSessionPorts: AgentSessionPorts;
  readonly agentService: LocalAgentService;
  readonly agentReferenceProjection: NonNullable<
    ProductionAgentProductCapabilities['inputPreparation']['agentReferenceProjection']
  >;
  readonly modelConfig: ModelSystemConfigPort;
  readonly refreshOfficialModels?: () => Promise<void>;
  readonly safety: ContentSafetyService;
  readonly logger: PluginServiceLogger;
  readonly metrics?: CronMetricsClient;
  readonly runtimeOwnerKind?: string;
  readonly capabilityProfile?: 'cli';
  readonly runtimeOwnerIdentity: Parameters<
    typeof initializeSessionSystem
  >[0]['runtimeOwnerIdentity'];
  readonly inspector: ComposedInspector | undefined;
  readonly promptSnapshots?: ProductionAgentProductCapabilities['promptSnapshots'];
  readonly internalTurnPromptReads: InternalTurnPromptReadRegistry;
  readonly miniappAvailable: boolean;
  readonly browserUse: BrowserUseService;
  readonly globalInstructions: GlobalInstructions;
  readonly publishGlobalEvent: (event: GlobalEventInput) => void;
  readonly nowMs: () => number;
}

export function createProductionSessionComposition(
  input: RuntimeSessionCompositionInput,
): ProductionSessionComposition {
  const tuiProductPolicy = input.runtimeOwnerKind === 'tui';
  let executionSessionSystem: SessionSystemOwner | undefined;
  const product = createRuntimeAgentProduct({
    baseProduct: input.baseProduct,
    agentService: input.agentService,
    ensureSessionAgentDefinition: async (sessionId) => {
      const sessionSystem = executionSessionSystem;
      if (!sessionSystem)
        throw new Error(
          'Session Agent definition reader is unavailable during runtime composition.',
        );
      return await sessionSystem.sessions.records.ensureSessionAgentDefinition(sessionId);
    },
    modelConfig: input.modelConfig,
    logger: input.logger,
    nowMs: input.nowMs,
    runtimeOwnerKind: input.runtimeOwnerKind,
    capabilityProfile: input.capabilityProfile,
    miniappAvailable: input.miniappAvailable,
    browserUse: input.browserUse,
    implicitCustomProviderThinking: tuiProductPolicy,
    agentReferenceProjection: input.agentReferenceProjection,
    ...(input.inspector ? { inspector: input.inspector } : {}),
    internalTurnPromptReads: input.internalTurnPromptReads,
    globalInstructions: input.globalInstructions,
    ...(input.promptSnapshots ? { promptSnapshots: input.promptSnapshots } : {}),
  });
  const modelSystem = initializeModelSystem({
    config: input.modelConfig,
    resolverOptions: product.preparation.modelResolver,
    ...(product.fileApi?.fetchImpl ? { fetchImpl: product.fileApi.fetchImpl } : {}),
    ...(tuiProductPolicy ? { implicitCustomProviderThinking: true } : {}),
  });
  input.agentService.bindBuiltinModelGroupResolver(async ({ previous, bundled }) =>
    resolveBuiltinAgentModelGroup({
      config: input.modelConfig.read(),
      previous,
      bundled,
    }),
  );
  bindAgentConfigModelPorts({
    agentService: input.agentService,
    modelConfig: input.modelConfig,
    logger: input.logger,
  });
  const preparation = createProductionAgentPreparation({
    configBuilder: product.preparation.configBuilder,
    modelResolver: modelSystem.resolver,
  });
  const facts = createApplicationFactPorts({ publish: input.publishGlobalEvent });
  const archiveTitleModel = createProductionRootArchiveTitleModel(
    { agents: product.agents, preparation, safety: input.safety },
    input.nowMs,
  );
  const importedSessionPin = createImportedSessionPinCallback();
  const sessionSystem = initializeSessionSystem({
    db: input.db,
    sourceProjectionEnabled: isLocalSourceProvenanceEnabled(input.runtimeOwnerKind),
    dataDir: input.dataDir,
    agents: input.agentSessionPorts.directory,
    rootAgents: input.agentSessionPorts.roots,
    defaultWorkspaceDir: input.compatibility.workspace.defaultDirectory,
    titlePolicy: createSessionTitlePolicy({
      runtimeOwnerKind: input.runtimeOwnerKind,
      config: input.modelConfig.read,
      safety: input.safety,
      readDefinition: (sessionId) =>
        sessionSystem.repositories.sessions.getSessionAgentDefinition(sessionId),
    }),
    resolveRequestedModel: (model) => resolveRequestedSessionModel(input.modelConfig.read(), model),
    backfillDiagnostics: createSessionBackfillDiagnostics({
      logger: input.logger,
      reportFailure: product.executor.reportFailure,
    }),
    ...createProjectHistoryRepairOptions(input),
    legacyMigration: {
      ...input.compatibility.legacyMigration,
      onCanonicalRecovery: createCanonicalRecoveryLoggerAdapter(input.logger),
    },
    inputNavigationDiffs: input.compatibility.diff.inputNavigation,
    storageRetention: {
      pruneTurnDiffs: input.compatibility.diff.pruneExpired,
      logger: input.logger,
    },
    steeringProjection: (queryKey) => ({ ...queryCollapseSteeringProjection(queryKey) }),
    onPinnedSessionImported: importedSessionPin.onImported,
    facts: facts.session,
    conversationFacts: facts.conversation,
    queueFacts: facts.queue,
    resolveQueueModel: async (session, model) => {
      const config = input.modelConfig.read();
      if (!executionSessionSystem)
        throw new Error('Session model reader unavailable before composition completes');
      const binding = model
        ? undefined
        : await executionSessionSystem.repositories.sessions.getSessionAgentDefinition(
            session.sessionId,
          );
      const frozenModel =
        binding?.definition.definitionVersion === 2 ? binding.definition.model : undefined;
      try {
        return freezeManagedQueueModel(config, session, model, frozenModel);
      } catch (error) {
        if (error instanceof LocalModelProviderError)
          throw new QueueServiceError('model-invalid', error.message);
        throw error;
      }
    },
    compactionFacts: createRuntimeCompactionFactSink(input.inspector, input.publishGlobalEvent),
    ...(input.metrics ? { compactionMetrics: input.metrics } : {}),
    title: {
      model: createProductionSessionTitleModel(
        { agents: product.agents, preparation },
        input.nowMs,
      ),
      ...(input.metrics
        ? {
            onOutcome: (outcome) =>
              input.metrics?.counter('session_title_generation_total', 1, { outcome }),
          }
        : {}),
      // Title failures stay Session-scoped diagnostics, never runtime turn failures.
      onFailure: ({ stage, sessionId, error }) =>
        input.logger.warn(
          { sessionId, stage, reason: `session_title_${stage}_failed:${describeError(error)}` },
          'session title generation failed',
        ),
    },
    nowMs: input.nowMs,
    runtimeOwnerIdentity: input.runtimeOwnerIdentity,
  });
  executionSessionSystem = sessionSystem;
  const pinService = createRuntimePinService(input, sessionSystem);
  importedSessionPin.bind(pinService);
  input.compatibility.bindSessionPinReader((sessionId) => pinService.isSessionPinned(sessionId));
  preparation.bindSessionModelRepair(
    createSessionModelRepair(sessionSystem.sessions.records, input.logger),
  );
  preparation.bindTaskSessionBindings(sessionSystem.sessions.records);
  const modelProviderApplication = new ModelProviderApplication({
    publish: input.publishGlobalEvent,
    tuiProductPolicy,
    config: input.modelConfig.read,
    providers: modelSystem.providers,
    sessions: createCommittedModelProviderSessionPort({
      get: async (sessionId) => {
        const session = await sessionSystem.repositories.sessions.get(sessionId);
        if (!session) return undefined;
        const binding =
          await sessionSystem.repositories.sessions.getSessionAgentDefinition(sessionId);
        const frozenModel =
          binding?.definition.definitionVersion === 2 ? binding.definition.model : undefined;
        return { ...session, frozenModel };
      },
      update: (sessionId, fields) =>
        sessionSystem.sessions.records.mutateSession(sessionId, fields),
      onCommittedUpdate: (session) => facts.session.handle({ kind: 'model-updated', session }),
    }),
    setDefaultModel: input.modelConfig.setDefaultModel,
    refreshOfficialModels: input.refreshOfficialModels,
    ...(tuiProductPolicy ? { implicitCustomProviderThinking: true } : {}),
  });
  return {
    product,
    preparation,
    modelSystem,
    modelProviderApplication,
    sessionSystem,
    pinService,
    globalInstructions: input.globalInstructions,
    archiveTitleModel,
    facts,
  };
}

function createSessionBackfillDiagnostics(input: {
  readonly logger: PluginServiceLogger;
  readonly reportFailure: ((scope: string, message: string) => void) | undefined;
}): SessionBackfillDiagnostics {
  return {
    reportAgentDefinitionSkip: (entry: SessionAgentDefinitionBackfillSkip) => {
      input.logger.warn(
        {
          code: entry.code,
          reason: entry.reason,
          sessionId: entry.sessionId,
          agentName: entry.agentName,
          status: entry.status,
          sessionKind: entry.sessionKind,
        },
        'startup_backfill_agent_definition_skipped',
      );
      input.reportFailure?.(
        'startup-backfill',
        `owner=session-system;stage=startup-backfill;reason=${entry.reason};code=${entry.code};sessionId=${entry.sessionId};agentName=${entry.agentName}`,
      );
    },
  };
}

function createProjectHistoryRepairOptions(
  input: Pick<RuntimeSessionCompositionInput, 'agentService' | 'logger'>,
) {
  return {
    rootProjectHistoryRepairDiagnostics: createRootProjectHistoryRepairDiagnostics({
      logger: input.logger,
    }),
    legacyDefaultProjectHistoryRepairDiagnostics:
      createLegacyDefaultProjectHistoryRepairDiagnostics({ logger: input.logger }),
    getAgentOwnerIdentity: createAgentOwnerIdentityReader(input.agentService),
  };
}

function createAgentOwnerIdentityReader(
  agentService: LocalAgentService,
): NonNullable<Parameters<typeof initializeSessionSystem>[0]['getAgentOwnerIdentity']> {
  return async (agentName) => {
    try {
      const document = await agentService.getConfigDocument(`agent:${agentName}`);
      return {
        exactOwnerName: document.exactOwnerName,
        ownerKind: document.ownerKind,
        ...(document.ownerInstanceId ? { ownerInstanceId: document.ownerInstanceId } : {}),
      };
    } catch {
      // Historical repair is evidence-bound: an unreadable current owner is not proof.
      return undefined;
    }
  };
}

function createRootProjectHistoryRepairDiagnostics(input: {
  readonly logger: PluginServiceLogger;
}): NonNullable<
  Parameters<typeof initializeSessionSystem>[0]['rootProjectHistoryRepairDiagnostics']
> {
  return {
    reportSummary: (summary) =>
      input.logger.info(
        {
          scanned: summary.scanned,
          repaired: summary.repaired,
          repairedSessionIds: summary.repairedSessionIds,
          failed: summary.failed,
          skipped: summary.skipped,
        },
        'startup_root_project_history_repair_summary',
      ),
    reportFailure: (entry) =>
      input.logger.warn(
        {
          stage: entry.stage,
          error: entry.error,
          ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
          ...(entry.agentName ? { agentName: entry.agentName } : {}),
        },
        'startup_root_project_history_repair_failed',
      ),
  };
}

function createLegacyDefaultProjectHistoryRepairDiagnostics(input: {
  readonly logger: PluginServiceLogger;
}): NonNullable<
  Parameters<typeof initializeSessionSystem>[0]['legacyDefaultProjectHistoryRepairDiagnostics']
> {
  return {
    reportSummary: (summary) =>
      input.logger.info(
        {
          scanned: summary.scanned,
          repaired: summary.repaired,
          repairedSessionIds: summary.repairedSessionIds,
          failed: summary.failed,
          skipped: summary.skipped,
        },
        'startup_legacy_default_project_history_repair_summary',
      ),
    reportFailure: (entry) =>
      input.logger.warn(
        {
          stage: entry.stage,
          reason: entry.reason,
          ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
          ...(entry.agentName ? { agentName: entry.agentName } : {}),
        },
        'startup_legacy_default_project_history_repair_failed',
      ),
  };
}

function createRuntimePinService(
  input: RuntimeSessionCompositionInput,
  sessionSystem: SessionSystemOwner,
): PinService {
  return initializePinService({
    db: input.db,
    agents: {
      get: async (agentName) => {
        let exactOwnerName: string;
        try {
          exactOwnerName = await input.agentService.requireExactAgentKey(agentName);
        } catch (error) {
          if (error instanceof AgentServiceError && error.code === 'AGENT_NOT_FOUND')
            return undefined;
          throw error;
        }
        const agent = await input.agentService.getPersistedOwner(exactOwnerName);
        if (!agent) return undefined;
        return {
          agentName: agentName.toLowerCase().startsWith('agent:')
            ? `agent:${exactOwnerName}`
            : agent.requestRef,
          ...(agent.rootSessionId ? { rootSessionId: agent.rootSessionId } : {}),
          ...(agent.displayName ? { displayName: agent.displayName } : {}),
          ...(agent.defaultWorkspaceDir ? { defaultWorkspaceDir: agent.defaultWorkspaceDir } : {}),
        };
      },
    },
    sessions: sessionSystem.repositories.sessions,
    projects: sessionSystem.projects.service,
    projectRepository: sessionSystem.repositories.projects,
    ...(input.compatibility.legacyMigration?.readPinnedItemsOrder
      ? { legacyOrder: input.compatibility.legacyMigration.readPinnedItemsOrder }
      : {}),
    legacyPinnedAgents: () => input.agentService.listLegacyPinnedAgentRefs(),
    nowMs: input.nowMs,
  });
}

/**
 * Binds the three Agent-model ports the Agent service needs from ModelSystem.
 *
 * Extracted from `createProductionSessionComposition` to keep that function
 * within its size budget; the binding order carries no meaning, but all three
 * must be bound before the HTTP surface accepts Agent reads or writes.
 *
 * - preview diagnostics: observability for reads that degraded silently
 * - effective resolver: best-effort preview, degrades to `undefined`
 * - candidate validator: strict save gate, rejects instead of degrading
 */
function bindAgentConfigModelPorts(ports: {
  readonly agentService: RuntimeSessionCompositionInput['agentService'];
  readonly modelConfig: RuntimeSessionCompositionInput['modelConfig'];
  readonly logger: RuntimeSessionCompositionInput['logger'];
}): void {
  // Unexpected preview failures are invisible to the user by design (the
  // Config GET still succeeds with no effective model), so this sink is the
  // only way a degraded Agent detail page can be diagnosed after the fact.
  ports.agentService.bindConfigPreviewDiagnostics((event) => {
    ports.logger.warn(
      {
        event: 'agent_config_effective_model_preview_failed',
        agent_name: event.exactOwnerName,
        stage: event.stage,
        error_name: event.errorName,
        error_message: event.errorMessage,
        ...(event.errorStack === undefined ? {} : { error_stack: event.errorStack }),
      },
      'Agent Config effective-model preview failed; returning the configuration without it',
    );
  });
  ports.agentService.bindEffectiveConfigResolver(async ({ profile, configuredModelSelection }) => {
    const selection = profile.configSelection?.model
      ? profile.configSelection
      : configuredModelSelection;
    const resolved = previewAgentModelSelection({
      config: ports.modelConfig.read(),
      sources: selection.model
        ? [
            {
              source: 'agent-config-preview',
              selection,
              requireCatalog: true,
              allowCustomProviderPrefixFallback: true,
              defaultMissingEffortOff: true,
            },
          ]
        : [],
    });
    return resolved
      ? {
          providerId: resolved.providerId,
          modelId: resolved.modelId,
          ...(resolved.effort ? { effort: resolved.effort } : {}),
          ...(resolved.contextWindow === undefined
            ? {}
            : { contextWindow: resolved.contextWindow }),
          ...(resolved.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: resolved.maxOutputTokens }),
        }
      : undefined;
  });
  // Strict counterpart of the preview resolver above. Same catalog rules and
  // the same `sources: []` fallback, but it reports *why* the selection is
  // unusable instead of degrading to `undefined`, so a save can be rejected
  // with an actionable message.
  ports.agentService.bindCandidateModelValidator(
    async ({ exactOwnerName, configuredModelSelection }) => {
      // An absent `model` is NOT an error: the Agent inherits the runtime
      // default, which is how `definitionOnly` Agents and most Custom Agents
      // are created. Passing no source lets the resolver apply that default,
      // and only a runtime with no default at all yields `undefined`.
      const sources = configuredModelSelection.model
        ? [
            {
              source: 'agent-config-save',
              selection: configuredModelSelection,
              requireCatalog: true,
              allowCustomProviderPrefixFallback: true,
              defaultMissingEffortOff: true,
            },
          ]
        : [];
      // `resolveEffectiveAgentModelSelection` returns `undefined` only for
      // MODEL_SELECTION_INCOMPLETE (nothing configured anywhere) and throws
      // `AgentModelSelectionError` when a selection is present but unusable
      // — removed model, disabled catalog entry, missing provider. Both are
      // user-fixable and become a 422; anything else is a genuine defect and
      // is deliberately left to propagate.
      try {
        const resolved = resolveEffectiveAgentModelSelection({
          config: ports.modelConfig.read(),
          sources,
        });
        if (resolved) return { ok: true };
        ports.logger.warn(
          {
            event: 'agent_config_model_rejected',
            agent_name: exactOwnerName,
            reason: 'not_configured',
            has_explicit_model: Boolean(configuredModelSelection.model),
          },
          'Rejecting Agent write: no Agent model and no runtime default are configured',
        );
        return { ok: false, reason: 'not_configured' };
      } catch (error) {
        if (!(error instanceof AgentModelSelectionError)) throw error;
        ports.logger.warn(
          {
            event: 'agent_config_model_rejected',
            agent_name: exactOwnerName,
            reason: 'unavailable',
            model: configuredModelSelection.model,
            selection_error_code: error.code,
          },
          'Rejecting Agent write: selected model cannot be resolved against the current catalog',
        );
        return { ok: false, reason: 'unavailable', detail: error.message };
      }
    },
  );
}
