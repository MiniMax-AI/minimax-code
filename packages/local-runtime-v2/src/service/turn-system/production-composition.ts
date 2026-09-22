import { createProductionRunawayGuardExtension } from './runaway-guard/extension.js';
import { streamSimple, type Api, type Context, type Model, type Tool } from '@earendil-works/pi-ai';
import type {
  AgentExtension,
  InternalTurnPromptReadRegistry,
  PromptSnapshotSource,
} from '@mavis/agent-runtime';
import {
  sessionReportExtension,
  toolOutputBudgetExtension,
  type ToolOutputArtifactInput,
} from '@mavis/agent-extension';
import type { LLMRetryOptions } from '@mavis/agent-core/pi-turn-runner';
import { describeLocalBrowserToolInput } from '@mavis/agent-tools/desktop';
import type { IAgentConfig } from '@mavis/protocol';
import type { GlobalEventInput } from '@mavis/shared/global-events';
import {
  TOOL_RESULT_COMPACTION_DEFAULTS,
  parseToolResultCompactionConfig,
  type ResolvedAgentCapabilities,
  type RunawayGuardOverride,
} from '@mavis/config';
import type { AppDb } from '../../infra/db/client.js';

import type { ContentSafetyService } from '../content-safety/index.js';
import {
  ArchiveTitleModelAdapter,
  SessionTitleModelAdapter,
  type RootArchiveTitleModel,
  type SessionRecord,
  type SessionTitleModel,
  type SessionSystemOwner,
  resolveSessionHistoryPaths,
} from '../session-system/index.js';
import { isPeekSession } from '../session-system/sessions/repo/normalization.js';
import {
  createNativeAgentHostProductionDependencies,
  createNativeLocalAgentPreparation,
  LocalAgentHost,
  type AgentEventBestEffortObserver,
  type AgentExecutionSource,
  type AgentHostRuntimeLifecycle,
  type AgentHostAssemblyObserver,
  type AgentHostTurnCapabilityLifecycle,
  type AgentHostTurnCapabilityView,
  type CanonicalHistoryChange,
  type LocalAgentTurnRunnerOptions,
  type LocalRuntimeTurnExecutorOptions,
  type LocalRuntimeTurnToolContext,
  type LocalTurnOutputTokenCapResolver,
  type LocalTurnToolPolicyGuard,
  type LocalTurnRawToolSources,
  type LocalTurnInputPreparerOptions,
  type LocalTurnPermissionGateOptions,
  type LocalAgentPreparationService,
  type NativeAgentPreparationOptions,
  type NativeLocalAgentPreparationOptions,
} from './agent-host/index.js';
import type { AgentExecutionSnapshot, AgentHost } from './agent-host/contracts.js';
import type { CanonicalHistoryCompactionChange } from './agent-host/history/contracts.js';
import type { DurableCanonicalHistoryProvider } from './agent-host/history/durable-canonical-history-store.js';
import { captureSemanticSnapshot } from './agent-host/history/semantic-identity.js';
import { validateCanonicalHistoryMessages } from './agent-host/history/canonical-history-validation.js';
import type { TurnSystemHostCapabilities } from './contracts.js';
import type {
  RequiredAgentEventProjector,
  RequiredAgentRuntimeProjector,
} from './agent-host/events/required-agent-event-delivery.js';
import { readCompactionCommitMetadata } from './agent-host/compaction/context-compaction.js';
import { LocalContextCompactor } from './compaction/local-context-compactor.js';
import {
  AutomaticContextCompactor,
  createAutomaticContextRequestFilterHook,
} from './compaction/automatic-context-compactor.js';
import type {
  ToolResultCompactionConfig,
  SubagentCheckpointStateSource,
} from './compaction/contracts.js';
import { ContextUsageAnchorState } from './compaction/execution/usage-anchor.js';
import { ToolResultArchiver } from './compaction/algorithm/tool-result-archiver.js';
import { createFileApiUploadStoreSource } from './persistence/file-api-upload.repository.js';
import { ToolOutputArtifactRepository } from './persistence/tool-output-artifact.repository.js';
import type { MessagesFileApiPatcherLogger } from './agent-host/assembly/messages-file-api-patcher.js';
import { isProductionRuntimeErrorRetryable } from './runtime-error-retry-policy.js';
import { createTodoCadenceReminderHook } from './execution/reminder/todo-cadence-reminder.js';
import { createBackgroundCadenceReminder } from './execution/reminder/background-cadence-reminder.js';
import { fitsReminderInFinalRequest } from './execution/reminder/reminder-admission.js';
import { readSessionAgentExecutionSnapshot } from './agent-host/preparation/session-agent-execution-snapshot.js';
import { McpToolResultHistoryExternalizer } from './agent-host/execution/mcp-tool-result-history-externalizer.js';
import { createBrowserHostCapabilityAdapter } from './agent-host/assembly/host-capability/browser.js';
import { HostCapabilityRegistry } from './agent-host/assembly/host-capability/registry.js';

export interface ProductionAgentProductCapabilities<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  readonly agents: AgentExecutionSource<TAgent>;
  /** Optional encrypted template reader shared with AgentHost's per-turn assembly. */
  readonly promptSnapshots?: PromptSnapshotSource;
  readonly internalTurnPromptReads?: Pick<InternalTurnPromptReadRegistry, 'take'>;
  readonly capabilities?: {
    resolve(agentName: string): Promise<ResolvedAgentCapabilities>;
  };
  readonly preparation: NativeAgentPreparationOptions;
  readonly turnRuntimeFacts: {
    snapshot(): {
      readonly cuModeActive: boolean;
    };
  };
  readonly checkpointState: SubagentCheckpointStateSource;
  readonly toolSources: {
    resolve(input: {
      readonly session: SessionRecord;
      readonly turnId: string;
      readonly resourceAgentName: string;
      readonly builtinCapabilities?: ResolvedAgentCapabilities;
      readonly toolsDisabled: boolean;
      readonly cuModeActive: boolean;
      readonly excludeAgentResources?: boolean;
      readonly skipAgentResolution?: boolean;
      readonly expectedAgentInstanceId?: string;
      readonly agentMemoryEnabled?: boolean;
      readonly agentMemoryReadNames?: readonly string[];
      readonly allowedSkillNames?: readonly string[];
      readonly allowedExtensionSkillNames?: readonly string[];
      readonly miniappAvailable?: boolean;
      readonly desktopCapabilities?: AgentHostTurnCapabilityView;
    }): Promise<LocalTurnRawToolSources>;
  };
  readonly inputPreparation: LocalTurnInputPreparerOptions;
  readonly terminalMemory: {
    record(input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly agentName: string;
      readonly status: 'finished' | 'error' | 'aborted' | 'interrupted';
      readonly errorMessage?: string;
    }): Promise<unknown>;
  };
  readonly permission: LocalTurnPermissionGateOptions;
  readonly runner: Omit<LocalAgentTurnRunnerOptions, 'reviewContent'>;
  readonly executor: Omit<
    LocalRuntimeTurnExecutorOptions<TAgent, LocalRuntimeTurnToolContext>,
    | 'runtime'
    | 'executionPreparation'
    | 'attemptRecall'
    | 'onSteeringConsumed'
    | 'fileApi'
    | 'cliProductPolicy'
    | 'tuiProductPolicy'
    | 'contentReviewEnabled'
    | 'backgroundCadenceReminder'
    | 'canAppendExecutionBudgetReminder'
    | 'afterCompactionBeforeLlmCallHooks'
  >;
  readonly fileApi?: {
    readonly fetchImpl?: typeof fetch;
    readonly logger?: MessagesFileApiPatcherLogger;
  };
  /** Optional product-domain observer fed only immutable v2 Turn facts. */
  readonly eventObserver?: AgentEventBestEffortObserver;
  /** Required post-settlement product participant; failures remain visible to TurnSystem. */
  readonly turnSettlement?: RequiredAgentTurnSettlement;
  readonly normalExtensions?: readonly AgentExtension[];
}

interface RequiredAgentTurnSettlement {
  settle(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly status: 'completed' | 'failed' | 'aborted';
  }): Promise<void>;
  /** Called once TurnSystem has exhausted its settle retries for this Turn. */
  abandon?(input: { readonly sessionId: string; readonly turnId: string }): Promise<void>;
}

export type ProductionAgentPreparation = Pick<
  LocalAgentPreparationService,
  | 'prepare'
  | 'prepareCompaction'
  | 'buildAgentConfig'
  | 'resolveModel'
  | 'bindSessionModelRepair'
  | 'bindTaskSessionBindings'
>;

export interface ProductionSessionTitleProductCapabilities<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  readonly agents: AgentExecutionSource<TAgent>;
  readonly preparation: ProductionAgentPreparation;
}

export interface CreateLocalAgentHostOptions<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  readonly product: ProductionAgentProductCapabilities<TAgent>;
  readonly db: AppDb;
  readonly preparation: ProductionAgentPreparation;
  readonly sessions: SessionSystemOwner;
  readonly safety: Pick<ContentSafetyService, 'review'>;
  readonly turnControl: TurnSystemHostCapabilities['turnControl'];
  readonly turnFacts: RequiredAgentEventProjector;
  readonly pluginHookSessionOwnership: TurnSystemHostCapabilities['pluginHookSessionOwnership'];
  readonly toolPolicyGuard?: LocalTurnToolPolicyGuard;
  /** Binds the Goal verifier child's opt-in attempt cap to its provider requests. */
  readonly outputTokenCap?: LocalTurnOutputTokenCapResolver;
  readonly normalExtensions?: readonly AgentExtension[];
  readonly eventObserver?: AgentEventBestEffortObserver;
  readonly contextUsageProjection?: RequiredAgentRuntimeProjector;
  readonly assemblyObserver?: AgentHostAssemblyObserver;
  readonly onSteeringConsumed: NonNullable<
    LocalRuntimeTurnExecutorOptions<TAgent, LocalRuntimeTurnToolContext>['onSteeringConsumed']
  >;
  readonly onInputReviewResolved: NonNullable<
    LocalRuntimeTurnExecutorOptions<TAgent, LocalRuntimeTurnToolContext>['onInputReviewResolved']
  >;
  readonly resolveLlmRetry?: LocalRuntimeTurnExecutorOptions<
    TAgent,
    LocalRuntimeTurnToolContext
  >['resolveLlmRetry'];
  readonly nowMs?: () => number;
  readonly turnCapabilities?: AgentHostTurnCapabilityLifecycle;
  readonly cliProductPolicy?: boolean;
  readonly tuiProductPolicy?: boolean;
  readonly contentReviewEnabled?: boolean;
  readonly getRunawayGuardConfig?: () => RunawayGuardOverride | undefined;
  readonly getToolResultCompactionConfig?: () => ToolResultCompactionConfig | undefined;
}

export interface LocalAgentHostComposition {
  readonly host: AgentHost;
  readonly lifecycle: AgentHostRuntimeLifecycle;
}

/** Creates the one process-local AgentConfig/model preparation shared by title and AgentHost. */
export function createProductionAgentPreparation(
  options: NativeLocalAgentPreparationOptions,
): ProductionAgentPreparation {
  return createNativeLocalAgentPreparation(options);
}

/** Uses the same product Agent/config/model resolution as normal native AgentHost turns. */
export function createProductionSessionTitleModel<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
>(
  product: ProductionSessionTitleProductCapabilities<TAgent>,
  nowMs?: () => number,
): SessionTitleModel {
  const { preparation } = product;
  return new SessionTitleModelAdapter<IAgentConfig, Model<Api>>({
    buildAgentConfig: async (session) => {
      const agent = await readSessionAgentExecutionSnapshot(product.agents, session);
      if (!agent) throw new Error(`Session title Agent not found: ${session.agentName}`);
      return preparation.buildAgentConfig({
        session,
        agent,
        isSessionFirstTurn: true,
      });
    },
    resolveModel: async (input) => {
      const resolved = await preparation.resolveModel(input);
      const resolvedStream = resolved.streamFn;
      return {
        model: resolved.model,
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(resolved.headers ? { headers: resolved.headers } : {}),
        ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
        ...(resolvedStream
          ? {
              stream: (model, context, options) =>
                resolvedStream(model, mutableTitleContext(context), options),
            }
          : {}),
      };
    },
    stream: (model, context, options) => streamSimple(model, mutableTitleContext(context), options),
    ...(nowMs ? { nowMs } : {}),
  });
}

/** Reuses the native Agent/model preparation and product safety checker for archived Root titles. */
export function createProductionRootArchiveTitleModel<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
>(
  product: ProductionSessionTitleProductCapabilities<TAgent> & {
    readonly safety: Pick<ContentSafetyService, 'review'>;
  },
  nowMs?: () => number,
): RootArchiveTitleModel {
  const { preparation } = product;
  return new ArchiveTitleModelAdapter<IAgentConfig, Model<Api>>({
    buildAgentConfig: async (session) => {
      const agent = await readSessionAgentExecutionSnapshot(product.agents, session);
      if (!agent) throw new Error(`Archive title Agent not found: ${session.agentName}`);
      return preparation.buildAgentConfig({
        session,
        agent,
        isSessionFirstTurn: false,
      });
    },
    resolveModel: async (input) => {
      const resolved = await preparation.resolveModel(input);
      const resolvedStream = resolved.streamFn;
      return {
        model: resolved.model,
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(resolved.headers ? { headers: resolved.headers } : {}),
        ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
        ...(resolvedStream
          ? {
              stream: (model, context, options) =>
                resolvedStream(model, mutableTitleContext(context), options),
            }
          : {}),
      };
    },
    review: product.safety.review,
    stream: (model, context, options) => streamSimple(model, mutableTitleContext(context), options),
    ...(nowMs ? { nowMs } : {}),
  });
}

/** Desktop Peek adds mutation approval; BTW shares the ordinary runtime permission policy. */
function createHostPermissionPolicy<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
) {
  return {
    ...options.product.permission,
    sideSessions: {
      isSideSession: async (sessionId: string) => {
        const session = await options.sessions.sessions.execution.getExecutionSnapshot(sessionId);
        return session ? session.purpose !== 'peek_btw_session' && isPeekSession(session) : false;
      },
    },
  };
}

/** Connects the native v2 AgentHost only to injected product, owner and observer ports. */
export async function createLocalAgentHost<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
>(options: CreateLocalAgentHostOptions<TAgent>): Promise<LocalAgentHostComposition> {
  const eventObserver = combineAgentEventObservers(
    options.product.eventObserver,
    options.eventObserver,
  );
  const contextUsageAnchor = new ContextUsageAnchorState();
  const toolOutputArtifacts = createToolOutputArtifactRepository(options);
  const getToolResultCompactionConfig = createToolResultCompactionConfigGetter(options);
  const toolResultArchiver = new ToolResultArchiver({
    writeArtifact: (input) => toolOutputArtifacts.write(input),
    logger: options.product.runner.logger,
    getConfig: getToolResultCompactionConfig,
  });
  const mcpToolResultHistoryExternalizer = createMcpToolResultHistoryExternalizer(
    options,
    toolOutputArtifacts,
    getToolResultCompactionConfig,
  );
  const normalExtensions = createHostNormalExtensions(
    options,
    toolOutputArtifacts,
    getToolResultCompactionConfig,
  );
  const dependencies = await createNativeAgentHostProductionDependencies({
    sessions: {
      get: (sessionId) => options.sessions.sessions.execution.getExecutionSnapshot(sessionId),
    },
    planDocuments: options.sessions.planDocuments,
    agents: options.product.agents,
    ...optionalPromptReadDependencies(options.product),
    turnRuntimeFacts: options.product.turnRuntimeFacts,
    preparation: options.preparation,
    toolCatalog: {
      ...optionalDesktopHostCapabilities(options.cliProductPolicy),
      resolveSources: async (input) => {
        const session = await requireExecutionSession(options.sessions, input);
        return options.product.toolSources.resolve({
          session,
          turnId: input.turnId,
          resourceAgentName: input.resourceAgentName,
          ...(input.excludeAgentResources ? { excludeAgentResources: true } : {}),
          ...(input.skipAgentResolution ? { skipAgentResolution: true } : {}),
          ...(input.expectedAgentInstanceId
            ? { expectedAgentInstanceId: input.expectedAgentInstanceId }
            : {}),
          ...(input.builtinCapabilities ? { builtinCapabilities: input.builtinCapabilities } : {}),
          toolsDisabled: process.env.MAVIS_LOCAL_RUNTIME_DISABLE_TOOLS === '1',
          cuModeActive: input.cuModeActive,
          ...(input.agentMemoryEnabled === undefined
            ? {}
            : { agentMemoryEnabled: input.agentMemoryEnabled }),
          ...(input.agentMemoryReadNames === undefined
            ? {}
            : { agentMemoryReadNames: input.agentMemoryReadNames }),
          ...(input.allowedSkillNames === undefined
            ? {}
            : { allowedSkillNames: input.allowedSkillNames }),
          ...(input.allowedExtensionSkillNames === undefined
            ? {}
            : { allowedExtensionSkillNames: input.allowedExtensionSkillNames }),
          ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
        });
      },
      config: options.product.preparation.configBuilder.config().mcpToolSearch,
      env: process.env,
    },
    inputPreparation: options.product.inputPreparation,
    permission: createHostPermissionPolicy(options),
    runner: {
      ...options.product.runner,
      reviewContent: options.safety.review,
    },
    ...optionalToolPolicyGuard(options.toolPolicyGuard),
    executor: {
      ...options.product.executor,
      logger: options.product.runner.logger,
      backgroundCadenceReminder: createBackgroundCadenceReminder(contextUsageAnchor),
      canAppendExecutionBudgetReminder: (input, marker) =>
        fitsReminderInFinalRequest(input, marker, contextUsageAnchor),
      fileApi: {
        uploadStores: createFileApiUploadStoreSource({
          db: options.db,
          ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        }),
        ...(options.product.fileApi?.fetchImpl
          ? { fetchImpl: options.product.fileApi.fetchImpl }
          : {}),
        ...(options.product.fileApi?.logger ? { logger: options.product.fileApi.logger } : {}),
      },
      attemptRecall: options.sessions.agentProjection.attemptRecall,
      ...(options.nowMs ? { nowMs: options.nowMs } : {}),
      cliProductPolicy: options.cliProductPolicy,
      tuiProductPolicy: options.tuiProductPolicy,
      contentReviewEnabled: options.contentReviewEnabled,
      finalizeToolResultForHistory: mcpToolResultHistoryExternalizer.finalize,
      resolvePluginHookRuntimeContext: (session) => {
        const config = options.product.preparation.configBuilder.config();
        return {
          transcriptPath: resolveSessionHistoryPaths(config.dataDir, session).messages,
          permissionMode: config.permissionMode,
        };
      },
      preparePluginHookSessionOwnership: options.pluginHookSessionOwnership.prepare,
      activatePluginHookSessionOwnership: options.pluginHookSessionOwnership.activate,
      afterCompactionBeforeLlmCallHooks: [
        createAutomaticContextRequestFilterHook(),
        createTodoCadenceReminderHook(contextUsageAnchor),
      ],
      onSteeringConsumed: options.onSteeringConsumed,
      onInputReviewResolved: options.onInputReviewResolved,
      resolveLlmRetry: options.resolveLlmRetry,
      ...(options.outputTokenCap ? { outputTokenCap: options.outputTokenCap } : {}),
    },
    ...optionalNormalExtensions(normalExtensions),
    turnControl: options.turnControl,
    ...(options.turnCapabilities ? { turnCapabilities: options.turnCapabilities } : {}),
    ...(options.assemblyObserver ? { assemblyObserver: options.assemblyObserver } : {}),
    canonicalHistory: adaptCanonicalHistory(
      options.sessions.canonicalHistory,
      options.sessions.sessions.historyMutation,
    ),
    compaction: {
      ...createContextCompactors({
        contextUsageAnchor,
        checkpointState: options.product.checkpointState,
        logger: options.product.runner.logger,
        toolResultArchiver,
        promptSnapshots: options.product.promptSnapshots,
      }),
      control: options.turnControl,
      lifecycle: options.sessions.agentProjection.compactionLifecycle,
      observer: options.sessions.agentProjection.compactionObserver,
      ...(options.product.runner.metricsClient
        ? { metricsClient: options.product.runner.metricsClient }
        : {}),
      usageAnchor: contextUsageAnchor,
    },
    usage: {
      projector: options.sessions.usage.projector,
      onFailure: ({ sessionId, error }) => {
        options.product.executor.reportFailure?.(
          sessionId,
          `agent_usage_projection_failed:${describeError(error)}`,
        );
      },
    },
    events: {
      projectors: {
        session: options.sessions.agentProjection.session,
        messages: withContextUsageProjection(
          options.sessions.agentProjection.messages,
          options.contextUsageProjection,
        ),
        stream: options.sessions.agentProjection.stream,
        turnFacts: options.turnFacts,
      },
      historyFailures: options.sessions.agentProjection.historyFailures,
      ...(eventObserver ? { observer: eventObserver } : {}),
      onObservationFailure: ({ sessionId, error }) => {
        options.product.executor.reportFailure?.(
          sessionId,
          `agent_event_observation_failed:${describeError(error)}`,
        );
      },
    },
    isRuntimeErrorRetryable: isProductionRuntimeErrorRetryable,
  });
  return { host: new LocalAgentHost(dependencies), lifecycle: dependencies.lifecycle };
}

function createHostNormalExtensions<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
  toolOutputArtifacts: ToolOutputArtifactRepository,
  getToolResultCompactionConfig: () => ToolResultCompactionConfig,
): readonly AgentExtension[] | undefined {
  return mergeNormalExtensions(
    [
      sessionReportExtension({
        reports: options.sessions.llmCalls,
        reportFailure: options.product.executor.reportFailure,
      }),
      createHostRunawayGuardExtension(options),
      toolOutputBudgetExtension({
        maxInlineBytes: TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB * 1_024,
        getMaxInlineBytes: () => getToolResultCompactionConfig().maxInlineBytes,
        fallbackPreviewBytes: 2 * 1_024,
        writeArtifact: async (input) => {
          const maxInlineBytes =
            getToolResultCompactionConfig().maxInlineBytes ??
            TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB * 1_024;
          const artifact = await toolOutputArtifacts.write(input);
          logToolOutputBudgetDecisionBestEffort(options.product.runner.logger, {
            input,
            maxInlineBytes,
            outcome: 'externalized',
            artifactReadFormat: artifact.metadata?.read_format,
          });
          return artifact;
        },
        onArtifactError: (error, input) =>
          logToolOutputBudgetDecisionBestEffort(options.product.runner.logger, {
            input,
            maxInlineBytes:
              getToolResultCompactionConfig().maxInlineBytes ??
              TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB * 1_024,
            outcome: 'fallback',
            reason: safeErrorReason(error),
          }),
      }),
    ],
    options.product.normalExtensions,
    options.normalExtensions,
  );
}

function createHostRunawayGuardExtension<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
): AgentExtension {
  return createProductionRunawayGuardExtension({
    readLocalConfig: () => options.product.preparation.configBuilder.config().runawayGuard,
    readRemoteConfig: options.getRunawayGuardConfig,
    readVerifiedProgress: (input) =>
      options.product.executor.fileChanges.takeToolProgress?.(input) ?? [],
    logger: options.product.runner.logger,
    reportEvent: (sessionId, event) =>
      options.product.runner.evalReporterFactory?.reportRuntimeEvent?.(sessionId, event),
  });
}

function createMcpToolResultHistoryExternalizer<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
  artifacts: ToolOutputArtifactRepository,
  getConfig: () => ToolResultCompactionConfig,
): McpToolResultHistoryExternalizer {
  return new McpToolResultHistoryExternalizer({
    maxInlineBytes: TOOL_RESULT_COMPACTION_DEFAULTS.mcpDetailsMaxInlineKiB * 1_024,
    getMaxInlineBytes: () => getConfig().mcpDetailsMaxInlineBytes,
    writeArtifact: (input) => artifacts.write(input),
    logger: options.product.runner.logger,
  });
}

function createToolOutputArtifactRepository<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
): ToolOutputArtifactRepository {
  return new ToolOutputArtifactRepository({
    resolveSessionReportsDirectory: (sessionId) =>
      options.sessions.artifacts.ensureReportsDirectory(sessionId),
  });
}

function createContextCompactors(input: {
  readonly contextUsageAnchor: ContextUsageAnchorState;
  readonly checkpointState: ConstructorParameters<typeof AutomaticContextCompactor>[1];
  readonly logger: ConstructorParameters<typeof AutomaticContextCompactor>[2];
  readonly toolResultArchiver: ToolResultArchiver;
  readonly promptSnapshots: ConstructorParameters<typeof LocalContextCompactor>[2];
}) {
  return {
    automatic: new AutomaticContextCompactor(
      input.contextUsageAnchor,
      input.checkpointState,
      input.logger,
      {
        toolResultArchiver: input.toolResultArchiver,
        promptSnapshots: input.promptSnapshots,
      },
    ),
    manual: new LocalContextCompactor(input.checkpointState, input.logger, input.promptSnapshots),
  };
}

function createToolResultCompactionConfigGetter<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
): () => ToolResultCompactionConfig {
  const fileConfig = parseToolResultCompactionConfig(readToolResultCompactionFileConfig(options));
  const base: Required<ToolResultCompactionConfig> = {
    enabled: fileConfig.enabled,
    maxInlineBytes: fileConfig.maxInlineKiB * 1_024,
    mcpDetailsMaxInlineBytes: fileConfig.mcpDetailsMaxInlineKiB * 1_024,
    watermarkBytes: fileConfig.watermarkKiB * 1_024,
    minSavingsBytes: fileConfig.minSavingsKiB * 1_024,
    minCandidateBytes: fileConfig.minCandidateKiB * 1_024,
    keepRecentRounds: fileConfig.keepRecentRounds,
  };
  return () => {
    const override = readToolResultCompactionOverride(options.getToolResultCompactionConfig);
    return {
      enabled: typeof override?.enabled === 'boolean' ? override.enabled : base.enabled,
      maxInlineBytes: positiveSafeInteger(override?.maxInlineBytes) ?? base.maxInlineBytes,
      mcpDetailsMaxInlineBytes:
        positiveSafeInteger(override?.mcpDetailsMaxInlineBytes) ?? base.mcpDetailsMaxInlineBytes,
      watermarkBytes: positiveSafeInteger(override?.watermarkBytes) ?? base.watermarkBytes,
      minSavingsBytes: positiveSafeInteger(override?.minSavingsBytes) ?? base.minSavingsBytes,
      minCandidateBytes: positiveSafeInteger(override?.minCandidateBytes) ?? base.minCandidateBytes,
      keepRecentRounds: positiveSafeInteger(override?.keepRecentRounds) ?? base.keepRecentRounds,
    };
  };
}

interface ToolOutputBudgetLogDecision {
  readonly input: ToolOutputArtifactInput;
  readonly maxInlineBytes: number;
  readonly outcome: 'externalized' | 'fallback';
  readonly artifactReadFormat?: unknown;
  readonly reason?: string;
}

function logToolOutputBudgetDecisionBestEffort(
  logger: LocalAgentTurnRunnerOptions['logger'],
  decision: ToolOutputBudgetLogDecision,
): void {
  try {
    const { input, maxInlineBytes, outcome, artifactReadFormat, reason } = decision;
    const fields = {
      event: 'tool_output_budget_decision',
      session_id: input.sessionId,
      turn_id: input.turnId,
      tool_name: input.toolName,
      outcome,
      original_bytes: input.originalBytes,
      max_inline_bytes: maxInlineBytes,
      ...(typeof artifactReadFormat === 'string' && artifactReadFormat.trim()
        ? { artifact_read_format: artifactReadFormat.trim() }
        : {}),
      ...(reason ? { reason } : {}),
    };
    logger?.[outcome === 'fallback' ? 'error' : 'info']?.(
      fields,
      '[local-runtime-v2] Tool output budget',
    );
  } catch {
    // Diagnostics must not change the ToolResult returned to History.
  }
}

function safeErrorReason(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string' && error.code.trim()) {
    return error.code.trim();
  }
  return error instanceof Error && error.name.trim() ? error.name.trim() : 'unknown_error';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readToolResultCompactionFileConfig<TAgent extends AgentExecutionSnapshot>(
  options: CreateLocalAgentHostOptions<TAgent>,
): unknown {
  try {
    return options.product.preparation.configBuilder.config().toolResultCompaction;
  } catch {
    return undefined;
  }
}

function readToolResultCompactionOverride(
  getter: (() => ToolResultCompactionConfig | undefined) | undefined,
): ToolResultCompactionConfig | undefined {
  try {
    return getter?.();
  } catch {
    return undefined;
  }
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalPromptReadDependencies<TAgent extends AgentExecutionSnapshot>(
  product: ProductionAgentProductCapabilities<TAgent>,
) {
  return {
    ...(product.promptSnapshots ? { promptSnapshots: product.promptSnapshots } : {}),
    ...(product.internalTurnPromptReads
      ? { internalTurnPromptReads: product.internalTurnPromptReads }
      : {}),
  };
}

function withContextUsageProjection(
  messages: RequiredAgentEventProjector,
  contextUsage: RequiredAgentRuntimeProjector | undefined,
): RequiredAgentEventProjector {
  if (!contextUsage) return messages;
  return {
    async projectRuntimeEvent(input) {
      const result = await messages.projectRuntimeEvent(input);
      await contextUsage.projectRuntimeEvent(input);
      return result;
    },
    projectHistoryCommitted: (input) => messages.projectHistoryCommitted(input),
  };
}

function mergeNormalExtensions(
  builtins: readonly AgentExtension[],
  product: readonly AgentExtension[] | undefined,
  additional: readonly AgentExtension[] | undefined,
): readonly AgentExtension[] | undefined {
  const configured = [...(product ?? []), ...(additional ?? [])];
  const builtinIds = new Set(builtins.map((extension) => extension.id));
  const merged = [
    ...configured.filter((extension) => !builtinIds.has(extension.id)),
    // Host-owned builtins establish terminal postconditions. They must observe every configured
    // after_tool_call rewrite and cannot be replaced by a configured extension with the same id.
    ...builtins,
  ];
  return merged.length > 0 ? merged : undefined;
}

function optionalToolPolicyGuard(toolPolicyGuard: LocalTurnToolPolicyGuard | undefined) {
  return toolPolicyGuard ? { toolPolicyGuard } : {};
}

function optionalDesktopHostCapabilities(cliProductPolicy: boolean | undefined) {
  return cliProductPolicy
    ? {}
    : {
        hostCapabilityRegistry: new HostCapabilityRegistry([
          createBrowserHostCapabilityAdapter(describeLocalBrowserToolInput),
        ]),
      };
}

function optionalNormalExtensions(normalExtensions: readonly AgentExtension[] | undefined) {
  return normalExtensions ? { normalExtensions } : {};
}

export function combineAgentEventObservers(
  ...observers: readonly (AgentEventBestEffortObserver | undefined)[]
): AgentEventBestEffortObserver | undefined {
  const active = observers.filter(
    (observer): observer is AgentEventBestEffortObserver => observer !== undefined,
  );
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return {
    observeRuntimeEvent: (input) =>
      observeAll(active, (observer) => observer.observeRuntimeEvent?.(input)),
    observeHistoryCommitted: (input) =>
      observeAll(active, (observer) => observer.observeHistoryCommitted?.(input)),
    observeHistoryFailure: (input) =>
      observeAll(active, (observer) => observer.observeHistoryFailure?.(input)),
  };
}

type SessionLLMRetryEventPublisher = (event: GlobalEventInput<'session.llm_retry'>) => void;

/** Projects transient provider retry state from Turn execution onto the product event stream. */
export function createSessionLLMRetryEventObserver(
  publish: SessionLLMRetryEventPublisher,
): NonNullable<LLMRetryOptions['observer']> {
  return (event) => {
    if (event.scope === 'title') return;
    publish({
      type: 'session.llm_retry',
      payload: { schemaVersion: 1, ...event },
    });
  };
}

async function observeAll(
  observers: readonly AgentEventBestEffortObserver[],
  observe: (observer: AgentEventBestEffortObserver) => void | Promise<void> | undefined,
): Promise<void> {
  const results = await Promise.allSettled(observers.map((observer) => observe(observer)));
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Agent event observers failed');
}

async function requireExecutionSession(
  sessions: SessionSystemOwner,
  input: {
    readonly sessionId: string;
    readonly agentName: string;
    readonly workspaceDir: string;
  },
): Promise<SessionRecord> {
  const session = await sessions.sessions.repository.get(input.sessionId);
  if (
    !session ||
    session.agentName !== input.agentName ||
    session.workspaceDir !== input.workspaceDir
  ) {
    throw new Error(`AgentHost tool source Session mismatch: ${input.sessionId}`);
  }
  return session;
}

function adaptCanonicalHistory(
  provider: SessionSystemOwner['canonicalHistory'],
  mutation: SessionSystemOwner['sessions']['historyMutation'],
): DurableCanonicalHistoryProvider {
  // The default Session provider owns deeply immutable decoded rows. Transfer
  // each message once; legacy and injected providers keep their original path.
  if (provider.withSnapshotTransform) {
    const messages = new WeakMap<object, unknown>();
    provider = provider.withSnapshotTransform((snapshot) => {
      const owned = snapshot.messages.map((message) => {
        if (typeof message !== 'object' || message === null) return message;
        const previous = messages.get(message);
        if (previous !== undefined) return previous;
        const value = captureSemanticSnapshot(message).value;
        messages.set(message, value);
        return value;
      });
      return captureSemanticSnapshot({
        revision: snapshot.revision,
        messages: captureSemanticSnapshot(owned).value,
        identityVector: captureSemanticSnapshot(snapshot.identityVector).value,
      }).value;
    });
  }
  return {
    read: async (sessionId) => {
      const snapshot = await provider.read(sessionId);
      validateCanonicalHistoryMessages(snapshot.messages);
      return {
        revision: snapshot.revision,
        messages: snapshot.messages,
        identityVector: snapshot.identityVector,
      };
    },
    readActive: async (sessionId) => {
      const snapshot = await provider.readActive(sessionId);
      validateCanonicalHistoryMessages(snapshot.messages);
      return {
        revision: snapshot.revision,
        messages: snapshot.messages,
        identityVector: snapshot.identityVector,
      };
    },
    append: async (change) => {
      const committed = await provider.append(requireHistoryOperation(change));
      validateCanonicalHistoryMessages(committed.messages);
      return { ...committed, messages: committed.messages };
    },
    replace: async (change) => {
      const committed = await provider.replace(requireHistoryOperation(change));
      validateCanonicalHistoryMessages(committed.messages);
      return { ...committed, messages: committed.messages };
    },
    compact: async (change: CanonicalHistoryCompactionChange) => {
      const operation = requireHistoryOperation(change);
      if (operation.reason !== 'replaceMessages' || operation.operation.kind !== 'compaction') {
        throw new TypeError('Typed canonical compaction requires a compaction operation.');
      }
      const metadata = readCompactionCommitMetadata(operation.metadata);
      if (!metadata) throw new TypeError('Canonical compaction metadata is invalid.');
      const baseChange = {
        ...operation,
        reason: 'replaceMessages',
        operation: { id: operation.operation.id, kind: 'compaction' },
        compactionId: metadata.compactionId,
        summary: metadata.summary,
        ...(metadata.currentUserSourceIndex === undefined
          ? {}
          : { currentUserSourceIndex: metadata.currentUserSourceIndex }),
      } as const;
      if (metadata.method !== 'llm_checkpoint') {
        const committed = await provider.compact({
          ...baseChange,
          method: metadata.method,
          replacementSourceIndexes: metadata.replacementSourceIndexes,
        });
        validateCanonicalHistoryMessages(committed.messages);
        return { ...committed, messages: committed.messages };
      }
      const committed = await provider.compact({
        ...baseChange,
        method: metadata.method,
      });
      validateCanonicalHistoryMessages(committed.messages);
      return { ...committed, messages: committed.messages };
    },
    settleTurnTail: async (input) => {
      if (!mutation.settleTurnTail) {
        throw new TypeError('SessionSystem settleTurnTail capability is unavailable.');
      }
      const committed = await mutation.settleTurnTail({
        sessionId: input.sessionId,
        turnId: input.turnId,
        operationId: input.operation.id,
        mode: input.mode,
        approvedContent: input.approvedContent,
      });
      validateCanonicalHistoryMessages(committed.messages);
      return {
        revision: committed.revision,
        messages: committed.messages,
        identityVector: committed.identityVector,
        status: committed.status,
        deletedMessageIds: committed.deletedMessageIds,
      };
    },
    retractTurn: async (input) => {
      if (!mutation.retractTurn) {
        throw new TypeError('SessionSystem retractTurn capability is unavailable.');
      }
      const committed = await mutation.retractTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        operationId: input.operation.id,
        reason: input.reason,
      });
      validateCanonicalHistoryMessages(committed.messages);
      return {
        revision: committed.revision,
        messages: committed.messages,
        identityVector: committed.identityVector,
        status: committed.status,
        deletedMessageIds: committed.deletedMessageIds,
      };
    },
  };
}

function requireHistoryOperation(change: CanonicalHistoryChange): CanonicalHistoryChange & {
  readonly operation: NonNullable<CanonicalHistoryChange['operation']>;
} {
  if (!change.operation) throw new TypeError('Canonical history operation is required.');
  return { ...change, operation: change.operation };
}

function mutableTitleContext(context: {
  readonly systemPrompt: string;
  readonly messages: ReadonlyArray<{
    readonly role: 'user';
    readonly content: string;
    readonly timestamp: number;
  }>;
  readonly tools?: readonly Tool[];
}): Context {
  return {
    systemPrompt: context.systemPrompt,
    messages: context.messages.map((message) => ({ ...message })),
    ...(context.tools ? { tools: [...context.tools] } : {}),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
