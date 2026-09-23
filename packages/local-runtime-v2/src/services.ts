import { createMiniAppControlExtension } from "@mavis/agent-extension";
import type {
  AgentExtension,
  InternalTurnPromptReadRegistry,
} from "@mavis/agent-runtime";
import type { RunawayGuardOverride } from "@mavis/config";
import {
  getRuntimeRegion,
  isLocalSourceProvenanceEnabled,
} from "@mavis/config";
import type { RuntimeConversation } from "@mavis/conversation-contract";
import type {
  GlobalEvent,
  GlobalEventInput,
} from "@mavis/shared/global-events";
import { isOrdinaryQuestionnaireResponseOrigin } from "@mavis/shared/questionnaire";
import { createGoalBudgetSummaryExtension } from "./application/agent/goal-budget-summary-reminder.js";
import {
  combineLocalTurnToolPolicyGuards,
  createGoalBudgetToolPolicyGuard,
} from "./application/agent/goal-budget-tool-policy.js";
import { createGoalVerificationTranscriptReader } from "./application/agent/goal-verification-transcript.js";
import { createRuntimeSourceReferenceExtension } from "./application/agent/source-reference-extension.js";
import {
  createQueryCollapseKeyResolver,
  type ConversationApplication,
  type UserMessageTurnDelivery,
} from "./application/conversation/index.js";
import { createRuntimeMessageDelivery } from "./application/conversation/runtime-message-delivery.js";
import {
  AgentApplication,
  AppError,
  closeRuntimeServiceOwnersAfterFailure,
  composeRuntimeGlobalEventWriter,
  configureRuntimePluginHooks,
  createAgentSessionPorts,
  createGoalEvaluatorVerifier,
  createGoalSubagentVerifierRuntime,
  createRuntimeAgentApplication,
  createRuntimeBrowserUseComposition,
  createRuntimePluginSessionLifecycle,
  createRuntimeServicesLifecycle,
  createRuntimeSkillApplication,
  initializeApplications,
  isCommandLineRuntimeOwner,
  ModelProviderApplication,
  ownsElectronRuntimeCapabilities,
  type ForkWorktreePort,
  type GoalSubagentVerifierRuntime,
  type RuntimeApplications,
  type RuntimeSkillApplication,
} from "./application/index.js";
import { createRuntimeQueueSelection } from "./application/session/runtime-queue-selection.js";
import { createForkState } from "./application/session/conversation-fork-state.js";
import {
  createProductionConversationMutationWorkflow,
  unavailableForkWorktree,
} from "./application/session/conversation-mutation-workflow.js";
import { createMemoryRecallAdmissionPolicy } from "./application/session/memory-recall-admission.js";
import { createHostSessionMiniAppLifecycle } from "./application/session/miniapp-host.js";
import { resolvePluginServiceLogger } from "./application/session/plugin-service-logger.js";
import type { LocalRuntimeApplication } from "./application/session/process-local-application-contract.js";
import { composeProcessLocalApplication } from "./application/session/process-local-composition.js";
import { initializeRuntimeServicePromptSupport } from "./application/session/runtime-prompt-support.js";
import {
  createRuntimeAgentReferenceProjection,
  createServiceWorkspace,
  resolveServicesCompatibility,
} from "./application/session/runtime-services-composition.js";
import {
  createProductionSessionComposition,
  type ProductionSessionComposition,
} from "./application/session/runtime-session-composition.js";
import { createRuntimeUserApplications } from "./application/session/runtime-user-applications.js";
import { bindTaskAgentBindingCapture } from "./application/session/task-agent-ready-inventory.js";
import {
  createSessionTurnLifecycleEvents,
  type SessionTurnLifecycleEventObserver,
} from "./application/session/turn-lifecycle-event-observer.js";
import {
  createApprovedTitleHandler,
  createConsumedSteeringHandler,
  createQueueWakeFailureReporter,
  createTurnSystemMessageDelivery,
  describeError,
  reportRootBestEffortFailure,
} from "./application/session/turn-message-delivery.js";
import type {
  V1ServiceCompatibility,
  V1ServiceFactory,
} from "./compat/v1/runtime.js";
import type { AppDb } from "./infra/db/client.js";
import type { EventBusClient } from "./infra/event-bus/index.js";
import type { RuntimeOwnerIdentity } from "./infra/runtime-owner/index.js";
import type { SchedulerClient } from "./infra/scheduler/index.js";
import {
  AgentFavorites,
  type LocalAgentService,
} from "./service/agent/index.js";
import type {
  BrowserUseService,
  BrowserUseServiceOptions,
} from "./service/browser-use/index.js";
import {
  initializeRuntimeCanvas,
  type CanvasService,
} from "./service/canvas/index.js";
import {
  initializeOptionalChannelSystem,
  LegacyCredentialMigrationReceipt,
  type ChannelSystemOwner,
} from "./service/channel-system/index.js";
import {
  initializeContentSafetyService,
  type ContentSafetyService,
} from "./service/content-safety/index.js";
import {
  createOptionalRuntimeCronTurnDelivery,
  createRuntimeCronSessionPorts,
  hasActiveCronSessionOwner,
  initializeCronService,
  type CronMetricsClient,
  type CronService,
  type CronSessionPorts,
  type CronTurnDeliveryPort,
  type InitializedCronService,
} from "./service/cron/index.js";
import {
  createRuntimeInspector,
  type ComposedInspector,
} from "./service/llm-context-inspector/index.js";
import {
  initializeMcpService,
  type InitializedMcpService,
  type McpSettingsService,
} from "./service/mcp/index.js";
import {
  composeMiniAppRuntimeCapability,
  createDeferredRuntimeOwnersLifecycle,
  resolveRuntimeMiniAppOptions,
  type RuntimeMiniAppServiceOptions,
  type RuntimeMiniAppServices,
} from "./service/miniapp/index.js";
import {
  createLocalModelSystemConfigPort,
  ModelFavoritesPreference,
  resolveLocalRuntimeModelKey,
  type ModelSystemOwner,
} from "./service/model-system/index.js";
import type { PinService } from "./service/pin/index.js";
import {
  bindConversationMutationPlanState,
  createPlanEntryReaders,
  createPlanEntrySubmissionPreparation,
  initializePlanService,
  type PlanService,
} from "./service/plan/index.js";
import {
  createPluginNameReservations,
  initializePluginService,
  SkillEnabledState,
  type InitializedPluginService,
  type PluginServiceLogger,
} from "./service/plugin-system/index.js";
import {
  bindRuntimeServicePromptLifecycle,
  createRuntimePromptAuthNotifier,
  withRuntimePromptSupportRollback,
  type LocalPromptFileReader,
  type RuntimePromptSupport,
} from "./service/prompt-config/index.js";
import {
  composeLocalSandboxService,
  type DeferredLocalSandboxBashOperationsFactory,
  type LocalSandboxService,
} from "./service/sandbox/index.js";
import {
  ComposerSendBehaviorPreference,
  initializeSessionApplicationSystem,
  type InitializedSessionApplicationSystem,
  type SessionLifecycleService,
  type SessionSystemOwner,
} from "./service/session-system/index.js";
import {
  AgentHostTurnCapabilityLifecycle,
  CliSunsetNotice,
  combineAgentEventObservers,
  composeTurnAdmissionPolicies,
  composeTurnSubmissionPreparations,
  createGoalTurnSubmissionPreparation,
  createLocalAgentHost,
  createSessionLLMRetryEventObserver,
  deactivateLocalPluginHooks,
  disposeLocalPluginHookSessions,
  GlobalInstructions,
  hasPriorityUserQueueItem,
  initializeTurnSystem,
  readLocalInstructionSources,
  requireAgentRuntime,
  requireTurnSystem,
  type AgentHostRuntimeLifecycle,
  type ToolResultCompactionConfig,
  type TurnSystemOwner,
} from "./service/turn-system/index.js";
import { composeV1Conversation } from "./service/v1-conversation-compat/index.js";
import type { WorkspaceSystem } from "./service/workspace/index.js";

export {
  createRuntimeAgentComposition,
  type AgentCutoverLogEvent,
  type AgentRuntimeOwner,
  type LegacyCustomAgentMaterializationEvent,
  type LegacyIdentityDetachEvent,
} from "./service/agent/index.js";
export {
  createDeferredLocalSandboxBashOperationsFactory,
  type DeferredLocalSandboxBashOperationsFactory,
} from "./service/sandbox/index.js";
export interface RuntimeServices extends RuntimeMiniAppServices {
  /** V2 Agent owner and cross-capability Agent workflows. */
  readonly agent: AgentApplication;
  readonly safety: ContentSafetyService;
  readonly canvas: CanvasService;
  /** Electron-only scheduled execution capability; absent on embedded CLI. */
  readonly cron?: CronService;
  readonly cronDelivery?: CronTurnDeliveryPort;
  readonly globalEvents: Pick<EventBusClient<GlobalEvent>, "subscribe">;
  /** V1-owned Git implementation exposed through the V2 Desktop controller. */
  readonly managedWorktrees: V1ServiceCompatibility["managedWorktrees"];
  /** One V2 Workspace owner for Git and HTML previews. */
  readonly workspace: WorkspaceSystem;
  readonly sessionSystem: SessionSystemOwner;
  readonly pinService: PinService;
  readonly globalInstructions: GlobalInstructions;
  readonly agentFavorites: AgentFavorites;
  readonly composerSendBehavior: ComposerSendBehaviorPreference;
  /** Electron-only channel feedback capability; absent on embedded CLI. */
  readonly channelSystem?: ChannelSystemOwner;
  readonly turnSystem: TurnSystemOwner;
  /** V2-owned Browser Use policy, per-Session state, tools, and UI context. */
  readonly browserUse: BrowserUseService;
  /** Application use cases consumed by generated Desktop HTTP controllers. */
  readonly conversation: ConversationApplication;
  /** Required production Session/Queue/Project use cases. */
  readonly applications: RuntimeApplications;
  /** Process-local product surface implemented by the v2 owner. */
  readonly application: LocalRuntimeApplication;
  readonly plugin: InitializedPluginService["plugin"];
  readonly mcp: McpSettingsService;
  readonly mcpRuntime: InitializedMcpService["runtime"];
  readonly modelSystem: ModelSystemOwner;
  readonly modelProviderApplication: ModelProviderApplication;
  readonly skill: RuntimeSkillApplication;
  readonly sandbox: LocalSandboxService;
  /** Development-only LLM Context Inspector; absent when the build hides it. */
  readonly llmContextInspector?: ComposedInspector["service"];
  notifyAuthContextChanged(
    authState?: "pending" | "authenticated" | "logged_out",
  ): void | Promise<void>;
  /** True after builtins are durably ensured and legacy custom materialization has settled. */
  readonly builtinAgentDefinitionsReady: Promise<boolean>;
  /** Completes service recovery after shared background infrastructure starts. */
  ready(): Promise<void>;
  close(): Promise<void>;
}
export interface RuntimeServicesTestOverrides {
  readonly cron?: {
    readonly sessionPorts?: CronSessionPorts;
    readonly turnDelivery?: CronTurnDeliveryPort;
  };
  /** @internal Read-only observation seam for native AgentHost capability integration tests. */
  readonly inspectTurnCapabilities?: (
    lifecycle: AgentHostTurnCapabilityLifecycle,
  ) => void;
  readonly sandbox?: {
    readonly descriptors?: Parameters<
      typeof composeLocalSandboxService
    >[0]["sandboxDescriptors"];
  };
}
export interface CreateRuntimeServicesOptions
  extends RuntimeMiniAppServiceOptions {
  readonly db: AppDb;
  readonly logger?: PluginServiceLogger;
  readonly scheduler?: SchedulerClient;
  readonly metrics?: CronMetricsClient & {
    gauge?(name: string, value: number, labels?: Record<string, string>): void;
  };
  readonly eventBus: EventBusClient<GlobalEvent>;
  readonly compatibility: V1ServiceCompatibility | V1ServiceFactory;
  /** Raw product Browser provider. Policy and composition remain entirely V2-owned. */
  readonly browserUse?: Pick<
    BrowserUseServiceOptions,
    "adapter" | "toolExposure"
  >;
  /** Prepared before V1 construction in production; omission is a test-only convenience. */
  readonly prepared?: PreparedRuntimeServices;
  /** AgentRuntimeOwner creates and closes this service outside the graph. */
  readonly agentService: LocalAgentService;
  /** Shared encrypted-template cache created by AgentRuntimeOwner. */
  readonly promptFileReader?: LocalPromptFileReader;
  /** Infrastructure-owned Git capability injected by the runtime composition boundary. */
  readonly forkWorktree?: ForkWorktreePort;
  readonly dataDir: string;
  readonly configSource?: "default" | "explicit";
  readonly nowMs?: () => number;
  readonly recoverPersistedState?: boolean;
  /** Composition owner mode; CLI omits Electron-only capabilities. */
  readonly runtimeOwnerKind?: string;
  /** Electron-owned fixed key for encrypted Desktop Prompt bundles. */
  readonly promptConfigKey?: Uint8Array;
  /** Client capability ceiling; omitted owners retain the shared legacy surface. */
  readonly capabilityProfile?: "cli";
  /** Electron owns greeting dispatch; embedded CLI only seeds V2 Agent/Root rows. */
  readonly greetingEnabled?: boolean;
  /** Live optional Runaway Guard override injected by the owning product. */
  readonly getRunawayGuardConfig?: () => RunawayGuardOverride | undefined;
  /** Live ToolResult compaction thresholds injected by the owning product. */
  readonly getToolResultCompactionConfig?: () =>
    | ToolResultCompactionConfig
    | undefined;
  readonly runtimeOwnerIdentity: RuntimeOwnerIdentity;
  readonly sandboxOperationsFactory?: DeferredLocalSandboxBashOperationsFactory;
  readonly sandboxConfig?: Parameters<
    typeof composeLocalSandboxService
  >[0]["sandboxConfig"];
  readonly overrides?: RuntimeServicesTestOverrides;
}
type ResolvedCreateRuntimeServicesOptions = Omit<
  CreateRuntimeServicesOptions,
  "compatibility"
> & {
  readonly compatibility: V1ServiceCompatibility;
};

export interface PreparedRuntimeServices {
  readonly skillEnabledState: SkillEnabledState;
  readonly legacyCredentialMigrationReceipt: LegacyCredentialMigrationReceipt;
  readonly cliSunsetNotice: CliSunsetNotice;
  readonly v1: {
    readonly skillEnabledState: SkillEnabledState;
    readonly runLegacyImCredentialMigration: LegacyCredentialMigrationReceipt["run"];
    readonly cliSunsetNotice: CliSunsetNotice;
  };
}

export function prepareRuntimeServices(options: {
  readonly db: AppDb;
  readonly runtimeOwnerKind?: string;
}): PreparedRuntimeServices {
  const skillEnabledState = new SkillEnabledState(options.db);
  const legacyCredentialMigrationReceipt = new LegacyCredentialMigrationReceipt(
    options.db,
  );
  const cliSunsetNotice = new CliSunsetNotice(options.db);
  return {
    skillEnabledState,
    legacyCredentialMigrationReceipt,
    cliSunsetNotice,
    v1: {
      skillEnabledState,
      runLegacyImCredentialMigration: (action) =>
        legacyCredentialMigrationReceipt.run(action),
      cliSunsetNotice,
    },
  };
}
interface RuntimeServiceState {
  closed: boolean;
  /** Bound after owner initialization; greeting events remain best-effort until then. */
  agentApplication?: AgentApplication;
}

interface InitializedRuntimeServiceOwners {
  readonly plan: PlanService;
  readonly turnSystem: TurnSystemOwner;
  /** Electron-only scheduled execution capability; absent on embedded CLI. */
  readonly cron: InitializedCronService | undefined;
  readonly plugin: ReturnType<typeof initializePluginService>;
  readonly miniAppComposition: RuntimeMiniAppComposition;
  readonly mcp: InitializedMcpService;
  readonly agentApplication: AgentApplication;
  readonly runtimeConversation: RuntimeConversation;
  readonly applications: RuntimeApplications;
  readonly sessionApplications: InitializedSessionApplicationSystem;
}

type RuntimeMiniAppComposition = Awaited<
  ReturnType<typeof composeMiniAppRuntimeCapability>
>;

/**
 * Builds SessionSystem, the Plugin service, optional Channel/Cron owner
 * capabilities, AgentHost, and TurnSystem over that graph.
 */
export async function createRuntimeServices(
  creation: CreateRuntimeServicesOptions,
): Promise<RuntimeServices> {
  const compatibility = resolveServicesCompatibility(creation.compatibility);
  const options: ResolvedCreateRuntimeServicesOptions = {
    ...creation,
    compatibility,
  };
  const browserUseComposition = createRuntimeBrowserUseComposition(options);
  const prepared = options.prepared ?? prepareRuntimeServices(options);
  const nowMs = options.nowMs ?? Date.now;
  const processStartedAtMs = nowMs();
  const ownerLifecycle = createDeferredRuntimeOwnersLifecycle();
  const state: RuntimeServiceState = { closed: false };
  const sandbox = initializeRuntimeSandbox(options);
  const { bindSessionSystem, inspector } =
    await createRuntimeInspector(options);
  const writeGlobalEvent = createServiceGlobalEventWriter(
    options,
    state,
    browserUseComposition.service,
    sandbox,
  );
  const workspace = createServiceWorkspace(writeGlobalEvent);
  const turnCapabilities = new AgentHostTurnCapabilityLifecycle();
  options.overrides?.inspectTurnCapabilities?.(turnCapabilities);
  const safety = initializeContentSafetyService({
    review: options.compatibility.safety.review,
  });
  const globalInstructions = new GlobalInstructions(options.dataDir);
  const promptSupport = await initializeRuntimeServicePromptSupport({
    ...options,
    promptConfig: options.compatibility.promptConfig,
    plugin: options.compatibility.plugin,
  });
  const { promptConfig, promptSnapshots, internalTurnPromptReads } =
    promptSupport;
  const agentSessionPorts = createAgentSessionPorts(options.agentService);
  const serviceLogger = resolvePluginServiceLogger(options.logger);
  const readAgentHostConfig =
    options.compatibility.agentHost.preparation.configBuilder.config;
  const productionSessionComposition = createProductionSessionComposition({
    ...options,
    baseProduct: options.compatibility.agentHost,
    compatibility: options.compatibility.sessionV2,
    refreshOfficialModels:
      options.compatibility.modelProvider?.refreshOfficialModels,
    safety,
    logger: serviceLogger,
    nowMs,
    publishGlobalEvent: writeGlobalEvent,
    agentSessionPorts,
    modelConfig: createLocalModelSystemConfigPort(readAgentHostConfig),
    agentReferenceProjection: createRuntimeAgentReferenceProjection(
      options.compatibility,
      options.agentService,
      serviceLogger,
    ),
    inspector,
    internalTurnPromptReads,
    miniappAvailable: resolveRuntimeMiniAppOptions(options) !== undefined,
    browserUse: browserUseComposition.service,
    promptSnapshots,
    globalInstructions,
  });
  bindSessionSystem(productionSessionComposition.sessionSystem);
  const {
    product,
    preparation,
    modelSystem,
    modelProviderApplication,
    sessionSystem,
    pinService,
    archiveTitleModel,
    facts,
  } = productionSessionComposition;
  const { planEntryEnabled, agentPlanEntryEnabled } = createPlanEntryReaders(
    product.preparation.configBuilder.config,
  );
  const canvas = initializeRuntimeCanvas(options, sessionSystem);
  const promptBoundOwners = await initializePromptBoundRuntimeServiceOwners({
    options,
    processStartedAtMs,
    product,
    preparation,
    sessionSystem,
    pinService,
    canvas,
    archiveTitleModel,
    facts,
    safety,
    turnCapabilities,
    agentSessionPorts,
    agentService: options.agentService,
    internalTurnPromptReads,
    writeGlobalEvent,
    nowMs,
    enableCron: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind),
    runtimeOwnerIdentity: options.runtimeOwnerIdentity,
    planEntryEnabled,
    agentPlanEntryEnabled,
    inspector,
    promptSupport,
    enableChannel: ownsElectronRuntimeCapabilities(options.runtimeOwnerKind),
    readyOwners: ownerLifecycle.ready,
    closeOwners: ownerLifecycle.close,
  });
  const { channelSystem, owners, queryCollapseKeys } = promptBoundOwners;
  state.agentApplication = owners.agentApplication;
  const { conversation, skill } = createRuntimeUserApplications({
    options,
    owners,
    sessionSystem,
    queryCollapseKeys,
    agentSessionPorts,
    nowMs,
    createSkillApplication: createRuntimeSkillApplication,
  });
  const application = composeProcessLocalApplication({
    eventBus: options.eventBus,
    usageCommits: sessionSystem.usage.commits,
    compatibility: options.compatibility,
    listRuntimeSkills: (request) => skill.listRuntimeSkills(request),
    plugins: owners.plugin.plugin,
    pluginControl: owners.plugin,
    miniApp: owners.miniAppComposition.services.miniApp,
    planEntryEnabled,
    sessionReports: sessionSystem.reporting,
    instructions: {
      listSources: (input) =>
        readLocalInstructionSources({ ...input, dataDir: options.dataDir }),
    },
    mcp: owners.mcp.public,
    modelProvider: {
      application: modelProviderApplication,
      providers: modelSystem.providers,
      listProviderPresets: modelSystem.listProviderPresets,
      oauth: modelSystem.oauth,
      favorites: new ModelFavoritesPreference(options.db),
    },
  });
  if (owners.cron)
    options.compatibility.cron.bindAgentCleanup(owners.cron.service);
  const cronDelivery = createOptionalCronDelivery(
    owners.cron,
    options,
    owners.turnSystem,
    product,
  );
  const lifecycle = createRuntimeServicesLifecycle({
    recoverPersistedState: options.recoverPersistedState,
    state,
    bindGlobalEventPublisher: () =>
      options.compatibility.events.bindPublisher(writeGlobalEvent),
    reportFailure: options.compatibility.agentHost.executor.reportFailure,
    bindConversation: () =>
      options.compatibility.conversation.bind(owners.runtimeConversation),
    recoverQuestionnaires: async () =>
      void (await options.compatibility.questionnaires
        .createService()
        .recoverOnStartup()),
    shutdownConversation: () => options.compatibility.conversation.shutdown(),
    disposePluginHookSessions: disposeLocalPluginHookSessions,
    sessionSystem,
    workspaceGit: workspace.git,
    workspaceHtmlPreview: workspace.htmlPreview,
    sandbox,
    closeBrowserUse: browserUseComposition.close,
    ...owners,
  });
  const notifyAuthContextChanged = configureRuntimePluginHooks({
    ...options,
    plugin: owners.plugin,
    turnSystem: owners.turnSystem,
  });
  const promptLifecycle = bindRuntimeServicePromptLifecycle({
    compatibility: options.compatibility,
    support: promptSupport,
    lifecycle,
  });
  ownerLifecycle.bind(promptLifecycle);
  return {
    agent: owners.agentApplication,
    safety,
    canvas,
    cron: owners.cron?.service,
    ...(cronDelivery ? { cronDelivery } : {}),
    globalEvents: createRuntimeGlobalEventSubscription(options.eventBus),
    managedWorktrees: options.compatibility.managedWorktrees,
    workspace,
    sessionSystem,
    pinService,
    globalInstructions,
    agentFavorites: new AgentFavorites(options.db, options.agentService),
    composerSendBehavior: new ComposerSendBehaviorPreference(options.db),
    ...(channelSystem ? { channelSystem } : {}),
    turnSystem: owners.turnSystem,
    browserUse: browserUseComposition.service,
    conversation,
    applications: owners.applications,
    application,
    plugin: owners.plugin.plugin,
    mcp: owners.mcp.service,
    mcpRuntime: owners.mcp.runtime,
    modelSystem,
    modelProviderApplication,
    skill,
    sandbox,
    ...(inspector ? { llmContextInspector: inspector.service } : {}),
    ...owners.miniAppComposition.services,
    notifyAuthContextChanged: createRuntimePromptAuthNotifier(
      notifyAuthContextChanged,
      promptConfig,
    ),
    builtinAgentDefinitionsReady: lifecycle.builtinAgentDefinitionsReady,
    ready: owners.miniAppComposition.ready,
    close: owners.miniAppComposition.close,
  };
}

function createRuntimeGlobalEventSubscription(
  eventBus: EventBusClient<GlobalEvent>,
): Pick<EventBusClient<GlobalEvent>, "subscribe"> {
  return { subscribe: (subscriber) => eventBus.subscribe(subscriber) };
}

function createServiceGlobalEventWriter(
  options: CreateRuntimeServicesOptions,
  state: RuntimeServiceState,
  browserUse: BrowserUseService,
  sandbox: LocalSandboxService,
) {
  return composeRuntimeGlobalEventWriter({
    isClosed: () => state.closed,
    nowMs: options.nowMs ?? Date.now,
    notifyContextReset: (sessionId) => browserUse.notifyContextReset(sessionId),
    notifySessionDeleted: (sessionId) => browserUse.clearSession(sessionId),
    notifyGreetingTurnTerminal: (turnId, status) =>
      state.agentApplication?.notifyGreetingTurnTerminal?.(turnId, status),
    observeTurn: (input) => sandbox.observeTurn(input),
    write: (event) => options.eventBus.write(event),
  });
}

async function initializeRuntimeServiceOwners(
  input: RuntimeServiceOwnerInitializationInput,
): Promise<InitializedRuntimeServiceOwners> {
  const pluginLogger = resolvePluginServiceLogger(input.options.logger);
  let plugin: ReturnType<typeof initializePluginService> | undefined;
  let mcp: InitializedMcpService | undefined;
  let turnSystem: TurnSystemOwner | undefined;
  let cron: InitializedCronService | undefined;
  let miniAppComposition: RuntimeMiniAppComposition | undefined;
  let resumeSessionDeletion: ((sessionId: string) => Promise<void>) | undefined;
  try {
    mcp = initializeMcpService({
      ...input.options.compatibility.mcp,
      dataDir: input.options.dataDir,
      nowMs: input.nowMs,
      metrics: input.options.metrics,
    });
    const mcpRuntime = mcp.runtime;
    plugin = initializePluginService(
      {
        ...input.options.compatibility.plugin,
        mcp: mcpRuntime,
        listReservations: createPluginNameReservations(
          input.options.compatibility.plugin.skill,
          mcpRuntime,
        ),
        database: input.options.db,
        logger: pluginLogger,
      },
      input.turnCapabilities,
      deactivateLocalPluginHooks,
    );
    bindTaskAgentBindingCapture(input, { plugin, mcp }, pluginLogger);
    miniAppComposition = await composeMiniAppRuntimeCapability({
      options: resolveRuntimeMiniAppOptions(input.options),
      db: input.options.db,
      dataDir: input.options.dataDir,
      nowMs: input.nowMs,
      plugin,
      readyOwners: input.readyOwners,
      closeOwners: input.closeOwners,
    });
    const miniAppLifecycle = createHostSessionMiniAppLifecycle({
      plugins: plugin,
      supervisor: miniAppComposition.services.miniApp,
      sessions: input.sessionSystem.sessions.repository,
      surface: input.options.compatibility.miniAppSurface,
      logger: pluginLogger,
    });
    const miniAppExtensions = miniAppLifecycle
      ? [createMiniAppControlExtension(miniAppLifecycle)]
      : [];
    const plan = initializePlanService({
      db: input.options.db,
      modes: input.sessionSystem.sessions.interactionMode,
      documents: input.sessionSystem.planDocuments,
      questionnaires: input.options.compatibility.questionnaires,
      queue: input.sessionSystem.queue.committed,
      receipts: {
        findReceipt: (turnId) =>
          requireTurnSystem(turnSystem).receipts.findReceipt(turnId),
      },
      dispatchQueue: (sessionId) =>
        requireTurnSystem(turnSystem).turns.dispatchQueue(sessionId),
      entryEnabled: input.planEntryEnabled,
      agentEntryEnabled: input.agentPlanEntryEnabled,
      reportFailure: (error) => {
        input.product.executor.reportFailure?.(
          "plan-lifecycle",
          `owner=plan;stage=lifecycle-reconcile;error=${describeError(error)}`,
        );
      },
      nowMs: input.nowMs,
    });
    bindConversationMutationPlanState({
      mutationState: input.sessionSystem.conversationMutationState,
      modes: input.sessionSystem.sessions.interactionMode,
      lifecycleFence: plan.lifecycleFence,
    });
    const subagentVerification = createGoalSubagentVerifierRuntime({
      createExecution: (registry) =>
        input.options.compatibility.sessionV2.goals.createSubagentExecution?.(
          registry,
        ),
      config: input.product.preparation.configBuilder.config,
      nowMs: input.nowMs,
    });
    turnSystem = await initializeRuntimeTurnSystem(input, {
      plan,
      planEntryEnabled: input.planEntryEnabled,
      normalExtensions: miniAppExtensions,
      resumeSessionDeletion: (sessionId) => {
        if (!resumeSessionDeletion) {
          throw new Error(
            `Session deletion recovery is not bound: ${sessionId}`,
          );
        }
        return resumeSessionDeletion(sessionId);
      },
      disposeMcpSession: (sessionId) => mcpRuntime.disposeSession(sessionId),
      goalVerifierExtension: subagentVerification.extension,
      goalVerifierOutputTokenCap: subagentVerification.outputTokenCap,
    });
    const sessionApplications = await initializeSessionApplications(
      input,
      turnSystem,
      plugin,
      (sessionId) => cron?.isSessionOwnedByDefinition(sessionId) ?? false,
    );
    cron = input.enableCron
      ? initializeRuntimeCron(
          input,
          turnSystem,
          sessionApplications.applications,
          sessionApplications.sessionApplications.session.lifecycle,
        )
      : undefined;
    input.options.compatibility.sessionV2.goals.bindAutomationOwnerConflictReader?.(
      (sessionId) =>
        cron ? hasActiveCronSessionOwner(cron.service, sessionId) : false,
    );
    resumeSessionDeletion = (sessionId) =>
      sessionApplications.applications.session.lifecycle.deleteSessionById(
        sessionId,
      );
    const evaluatorVerifier = createGoalEvaluatorVerifier({
      tuiProductPolicy: input.options.runtimeOwnerKind === "tui",
      sessions: input.sessionSystem.sessions.execution,
      agents: input.product.agents,
      preparation: input.preparation,
      config: input.product.preparation.configBuilder.config,
      nowMs: input.nowMs,
    });
    input.options.compatibility.sessionV2.goals.bindVerifier?.(
      {
        dispatch: (attempt, signal) =>
          attempt.backend === "subagent"
            ? subagentVerification.verifier.dispatch(attempt, signal)
            : evaluatorVerifier.dispatch(attempt, signal),
      },
      createGoalVerificationTranscriptReader(
        input.sessionSystem.canonicalHistory,
      ),
    );
    return {
      plan,
      turnSystem,
      cron,
      plugin,
      miniAppComposition,
      mcp,
      agentApplication: sessionApplications.agentApplication,
      runtimeConversation: sessionApplications.runtimeConversation,
      applications: sessionApplications.applications,
      sessionApplications: sessionApplications.sessionApplications,
    };
  } catch (error) {
    input.options.compatibility.conversation.fail(error);
    await closeRuntimeServiceOwnersAfterFailure({
      cron,
      turnSystem,
      plugin,
      mcp,
      sessionSystem: input.sessionSystem,
      miniApp: miniAppComposition?.services.miniApp,
    });
    throw error;
  }
}

type PromptBoundRuntimeServiceOwnerInput = Omit<
  RuntimeServiceOwnerInitializationInput,
  "channelSystem" | "messageDelivery" | "turnLifecycleEvents"
> & {
  readonly promptSupport: RuntimePromptSupport;
  readonly enableChannel: boolean;
};

async function initializePromptBoundRuntimeServiceOwners(
  input: PromptBoundRuntimeServiceOwnerInput,
): Promise<{
  readonly channelSystem: ChannelSystemOwner | undefined;
  readonly owners: InitializedRuntimeServiceOwners;
  readonly queryCollapseKeys: ReturnType<typeof createQueryCollapseKeyResolver>;
}> {
  return withRuntimePromptSupportRollback(input.promptSupport, async () => {
    const channelSystem = initializeOptionalChannelSystem(input.enableChannel, {
      messages: input.sessionSystem.messages.repository,
      sessions: input.sessionSystem.sessions.repository,
      product: input.options.compatibility.channel,
    });
    const queryCollapseKeys = createQueryCollapseKeyResolver({
      state: input.sessionSystem.queryCollapse.state,
      messages: input.sessionSystem.messages.repository,
      getGoalBySession:
        input.options.compatibility.sessionV2.goals.getBySession,
    });
    const messageDelivery = createRuntimeMessageDelivery(
      input.sessionSystem,
      channelSystem,
      queryCollapseKeys,
    );
    const turnLifecycleEvents = createSessionTurnLifecycleEvents(
      input.sessionSystem.sessions.repository,
      input.writeGlobalEvent,
      input.product.terminalMemory,
    );
    const owners = await initializeRuntimeServiceOwners({
      ...input,
      channelSystem,
      messageDelivery,
      turnLifecycleEvents,
    });
    return { channelSystem, owners, queryCollapseKeys };
  });
}

interface RuntimeServiceOwnerInitializationInput
  extends Pick<RuntimeServices, "canvas"> {
  readonly options: ResolvedCreateRuntimeServicesOptions;
  readonly processStartedAtMs: number;
  readonly product: ProductionSessionComposition["product"];
  readonly preparation: ProductionSessionComposition["preparation"];
  readonly sessionSystem: SessionSystemOwner;
  readonly pinService: PinService;
  readonly archiveTitleModel: ProductionSessionComposition["archiveTitleModel"];
  readonly facts: ProductionSessionComposition["facts"];
  readonly safety: ContentSafetyService;
  /** Electron-only channel feedback capability; absent on embedded CLI. */
  readonly channelSystem: ChannelSystemOwner | undefined;
  readonly messageDelivery: UserMessageTurnDelivery;
  readonly turnLifecycleEvents: SessionTurnLifecycleEventObserver;
  readonly turnCapabilities: AgentHostTurnCapabilityLifecycle;
  readonly agentSessionPorts: ReturnType<typeof createAgentSessionPorts>;
  readonly agentService: LocalAgentService;
  readonly internalTurnPromptReads: InternalTurnPromptReadRegistry;
  readonly writeGlobalEvent: (event: GlobalEventInput) => void;
  readonly nowMs: () => number;
  readonly enableCron: boolean;
  readonly runtimeOwnerIdentity: RuntimeOwnerIdentity;
  readonly planEntryEnabled: () => boolean;
  readonly agentPlanEntryEnabled: () => boolean;
  readonly inspector: ComposedInspector | undefined;
  readonly readyOwners: () => Promise<void>;
  readonly closeOwners: () => Promise<void>;
}

interface RuntimeTurnSystemInitializationDeps {
  readonly plan: PlanService;
  readonly planEntryEnabled: () => boolean;
  readonly normalExtensions: readonly AgentExtension[];
  readonly resumeSessionDeletion: (sessionId: string) => Promise<void>;
  readonly disposeMcpSession: (sessionId: string) => Promise<void>;
  readonly goalVerifierExtension: GoalSubagentVerifierRuntime["extension"];
  /** Host-clamped attempt cap the verifier child's provider requests must obey. */
  readonly goalVerifierOutputTokenCap: GoalSubagentVerifierRuntime["outputTokenCap"];
}

async function initializeRuntimeTurnSystem(
  input: RuntimeServiceOwnerInitializationInput,
  dependencies: RuntimeTurnSystemInitializationDeps,
): Promise<TurnSystemOwner> {
  const {
    plan,
    planEntryEnabled,
    normalExtensions,
    resumeSessionDeletion,
    goalVerifierExtension,
    goalVerifierOutputTokenCap,
  } = dependencies;
  const llmRetryObserver = createSessionLLMRetryEventObserver(
    input.writeGlobalEvent,
  );
  let agentRuntime: AgentHostRuntimeLifecycle | undefined;
  input.options.compatibility.backgroundTasks.bindRuntimeOwner({
    ownerId: input.runtimeOwnerIdentity.createOwnerId("background-task"),
    isOwnerAlive: input.runtimeOwnerIdentity.isOwnerAlive,
  });
  return initializeTurnSystem({
    db: input.options.db,
    ...(input.options.logger ? { logger: input.options.logger } : {}),
    sessions: input.sessionSystem,
    processStartedAtMs: input.processStartedAtMs,
    makeLeaseId: () => input.runtimeOwnerIdentity.createOwnerId("turn-lease"),
    makeDeletionOwnerId: () =>
      input.runtimeOwnerIdentity.createOwnerId("session-delete"),
    isLeaseOwnerAlive: input.runtimeOwnerIdentity.isOwnerAlive,
    isLeaseOwnerCurrent: input.runtimeOwnerIdentity.ownsOwnerId,
    runtimeRecoveryRetryMs: input.runtimeOwnerIdentity.recoveryRetryMs,
    ...(input.options.recoverPersistedState !== false
      ? {
          onRuntimeRecovery:
            input.options.compatibility.backgroundTasks.recover,
          pollRuntimeRecovery:
            input.options.compatibility.backgroundTasks.pollRecovery,
        }
      : {}),
    resumeSessionDeletion,
    // Decision v5: teardown fall-to-session uses the delivery service's
    // consumeSteering directly — the wrapped handler above would publish a
    // `session.start` no ended Turn should emit.
    commitSteeringTeardownProjection: (steer) =>
      input.messageDelivery.consumeSteering(steer),
    createHost: async ({
      turnControl,
      turnFacts,
      pluginHookSessionOwnership,
    }) => {
      const production = await createLocalAgentHost({
        product: input.product,
        db: input.options.db,
        preparation: input.preparation,
        sessions: input.sessionSystem,
        safety: input.safety,
        turnControl,
        turnFacts,
        pluginHookSessionOwnership,
        turnCapabilities: input.turnCapabilities,
        // `sessionTitle.enabled: false` disables title generation: wire a
        // no-op so no title model request is issued. Read from the injected
        // config source (same as beta/custom_provider above), default on.
        onInputReviewResolved:
          (input.product.preparation.configBuilder.config().sessionTitle
            ?.enabled ?? true)
            ? createApprovedTitleHandler(
                input.sessionSystem,
                input.product.executor.reportFailure,
              )
            : () => {},
        onSteeringConsumed: createConsumedSteeringHandler(
          input.messageDelivery,
          input.sessionSystem,
          input.writeGlobalEvent,
          input.product.executor.reportFailure,
        ),
        toolPolicyGuard: combineLocalTurnToolPolicyGuards(
          plan.toolGuard,
          createGoalBudgetToolPolicyGuard(),
        ),
        outputTokenCap: goalVerifierOutputTokenCap,
        resolveLlmRetry: () => ({ observer: llmRetryObserver }),
        normalExtensions: [
          ...(!isLocalSourceProvenanceEnabled(input.options.runtimeOwnerKind)
            ? []
            : [
                createRuntimeSourceReferenceExtension(
                  input.options.compatibility.attachmentRegistration,
                ),
              ]),
          plan.extension,
          goalVerifierExtension,
          createGoalBudgetSummaryExtension(),
          ...normalExtensions,
        ],
        eventObserver: combineAgentEventObservers(
          ...(input.channelSystem ? [input.channelSystem.terminalReplies] : []),
          input.turnLifecycleEvents,
        ),
        nowMs: input.nowMs,
        ...(isCommandLineRuntimeOwner(input.options.runtimeOwnerKind)
          ? { cliProductPolicy: true }
          : {}),
        ...(input.options.runtimeOwnerKind === "tui"
          ? {
              tuiProductPolicy: true,
              contentReviewEnabled: getRuntimeRegion() === "cn",
            }
          : {}),
        ...(input.options.getRunawayGuardConfig
          ? { getRunawayGuardConfig: input.options.getRunawayGuardConfig }
          : {}),
        ...(input.options.getToolResultCompactionConfig
          ? {
              getToolResultCompactionConfig:
                input.options.getToolResultCompactionConfig,
            }
          : {}),
      });
      agentRuntime = production.lifecycle;
      return production.host;
    },
    disposeRuntimeSession: async (sessionId) => {
      try {
        await requireAgentRuntime(agentRuntime).disposeSession(sessionId);
      } finally {
        await dependencies.disposeMcpSession(sessionId);
      }
    },
    admissionPolicy: composeTurnAdmissionPolicies(
      plan.admission,
      createMemoryRecallAdmissionPolicy(),
    ),
    submissionPreparation: composeTurnSubmissionPreparations(
      createPlanEntrySubmissionPreparation(plan),
      createGoalTurnSubmissionPreparation({
        prepare:
          input.options.compatibility.sessionV2.goals.prepareTurnAdmission,
        hasPendingPlan: (sessionId) =>
          plan.lifecycleFence.blocks({ sessionId }),
        hasPriorityMailboxWork: async (sessionId) =>
          hasPriorityUserQueueItem(
            await input.sessionSystem.queue.committed.list(sessionId),
          ),
      }),
    ),
    forkProjections: {
      forkPrefix: async (request) => {
        const sourcePlan =
          await input.sessionSystem.planDocuments.resolveAndEnsure(
            request.sourceSessionId,
          );
        await input.options.compatibility.sessionV2.diff.capability.forkPrefix({
          ...request,
          excludedFilePaths: [sourcePlan.canonicalPath],
        });
      },
    },
    rewindProjections: {
      preflight: (request) =>
        input.options.compatibility.sessionV2.diff.rewind.preflight(request),
      apply: (request) =>
        input.options.compatibility.sessionV2.diff.rewind.apply(request),
      deleteTurns: async (request) => {
        await input.options.compatibility.sessionV2.diff.rewind.deleteTurns(
          request,
        );
        await input.inspector?.service.deleteTurns(
          request.sessionId,
          request.turnIds,
        );
      },
    },
    onTurnDiffRewindSkipped: (event) =>
      input.options.logger?.warn(
        { ...event },
        "Turn diff rewind phase skipped",
      ),
    ...createRuntimeQueueSelection({
      questionnaires: input.options.compatibility.peripherals.questionnaires,
      goals: input.options.compatibility.sessionV2.goals,
      queue: input.sessionSystem.queue.committed,
      lifecycleFence: plan.lifecycleFence,
      entryEnabled: planEntryEnabled,
    }),
    createMessageDelivery: createTurnSystemMessageDelivery(
      input.messageDelivery,
    ),
    ...(input.product.turnSettlement
      ? { turnSettlement: input.product.turnSettlement }
      : {}),
    onQueueWakeFailure: createQueueWakeFailureReporter(
      input.product.executor.reportFailure,
      "turn_submit_queue_wake_failed",
    ),
    onRuntimeRecoveryFailure: createQueueWakeFailureReporter(
      input.product.executor.reportFailure,
      "runtime_recovery_failed",
    ),
    nowMs: input.nowMs,
  });
}

function initializeRuntimeCron(
  input: RuntimeServiceOwnerInitializationInput,
  turnSystem: TurnSystemOwner,
  applications: RuntimeApplications,
  lifecycle: Pick<SessionLifecycleService, "mutateSession">,
): InitializedCronService {
  if (!input.options.scheduler) {
    throw new Error("Runtime Cron services require an owned Scheduler client.");
  }
  const sessionPorts =
    input.options.overrides?.cron?.sessionPorts ??
    createRuntimeCronSessionPorts({
      agentSessionPorts: input.agentSessionPorts,
      sessions: input.sessionSystem,
      turns: turnSystem.turns,
      reportFailure: input.product.executor.reportFailure,
      lifecycle,
      deletion: applications.session.lifecycle,
      resolveDefaultWorkspaceDir:
        input.options.compatibility.sessionV2.workspace.defaultDirectory,
    });
  return initializeCronService({
    db: input.options.db,
    scheduler: input.options.scheduler,
    ...(input.options.metrics ? { metrics: input.options.metrics } : {}),
    sessionPorts,
    modelSelection: {
      resolve: (model) =>
        resolveLocalRuntimeModelKey(
          input.product.preparation.configBuilder.config(),
          model,
        ),
    },
    nowMs: input.nowMs,
    recoverPendingRuns: input.options.recoverPersistedState !== false,
  });
}
async function initializeSessionApplications(
  input: RuntimeServiceOwnerInitializationInput,
  turnSystem: TurnSystemOwner,
  plugin: InitializedPluginService,
  isSessionOwnedByScheduledTask: (sessionId: string) => boolean,
): Promise<{
  readonly sessionApplications: InitializedSessionApplicationSystem;
  readonly applications: RuntimeApplications;
  readonly agentApplication: AgentApplication;
  readonly runtimeConversation: RuntimeConversation;
}> {
  const sessionApplications = initializeSessionApplicationSystem({
    owner: input.sessionSystem,
    pin: input.pinService,
    canvas: input.canvas,
    compatibility: input.options.compatibility.sessionV2,
    archiveTitleModel: input.archiveTitleModel,
    maintenance: turnSystem.maintenance,
    facts: input.facts,
    processStartedAtMs: input.processStartedAtMs,
    ...(input.product.promptSnapshots
      ? { promptSnapshots: input.product.promptSnapshots }
      : {}),
  });
  const applications = initializeApplications({
    sessionSystem: sessionApplications,
    compatibility: input.options.compatibility.sessionV2,
    attachmentRegistration: input.options.compatibility.attachmentRegistration,
    resolveAgentWriteTarget: input.agentSessionPorts.resolveWriteTarget,
    requireExactAgentKey: input.agentSessionPorts.requireExactAgentKey,
    ...createRuntimePluginSessionLifecycle(turnSystem, plugin),
    turn: turnSystem.turns,
    assertSessionDeletionAllowed: async (sessionId) => {
      if (isSessionOwnedByScheduledTask(sessionId)) {
        throw new AppError(
          409,
          "CRON_OWNED_SESSION",
          "This session is owned by a scheduled task. Delete the scheduled task instead.",
        );
      }
    },
    conversationMutationPort: input.sessionSystem.conversationMutationState,
    conversationMutationWorkflow: createProductionConversationMutationWorkflow({
      sessionFork: input.sessionSystem.fork,
      forkState: createForkState({
        ...input.options.compatibility.sessionV2,
        plan: {
          documents: input.sessionSystem.planDocuments,
          modes: input.sessionSystem.sessions.interactionMode,
        },
      }),
      sessionRewind: input.sessionSystem.messages.rewind,
      rewindPreview: input.options.compatibility.sessionV2.diff.rewind,
      operations: input.sessionSystem.sessions.operationIntents,
      mutationPlanState: input.sessionSystem.conversationMutationState,
      stream: input.sessionSystem.stream,
      turn: turnSystem.turns,
      trustedEditSubmission: turnSystem.trustedEditSubmission,
      questionnaires:
        input.options.compatibility.questionnaires.createService(),
      worktree: input.options.forkWorktree ?? unavailableForkWorktree,
      attachmentRegistration:
        input.options.compatibility.attachmentRegistration,
      publishGlobalEvent: input.writeGlobalEvent,
    }),
    publishGlobalEvent: input.writeGlobalEvent,
    ...(input.options.nowMs ? { nowMs: input.options.nowMs } : {}),
    ...(input.options.metrics ? { metrics: input.options.metrics } : {}),
    onRootBestEffortFailure: (failure) =>
      reportRootBestEffortFailure(
        input.product.executor.reportFailure,
        failure,
      ),
  });
  const agentApplication = createRuntimeAgentApplication(input, applications);
  const runtimeConversation = composeV1Conversation({
    attachmentRegistration: input.options.compatibility.attachmentRegistration,
    rootAgents: input.agentSessionPorts.roots,
    resolveAgentWriteTarget: input.agentSessionPorts.resolveWriteTarget,
    sessions: input.sessionSystem,
    turns: turnSystem.turns,
    lifecycle: sessionApplications.session.lifecycle,
    deletion: applications.session.lifecycle,
    root: applications.session.root,
    onQueueWakeFailure: createQueueWakeFailureReporter(
      input.product.executor.reportFailure,
      "conversation_queue_wake_failed",
    ),
  });
  return {
    sessionApplications,
    applications,
    agentApplication,
    runtimeConversation,
  };
}
function createOptionalCronDelivery(
  cron: InitializedCronService | undefined,
  options: CreateRuntimeServicesOptions,
  turnSystem: TurnSystemOwner,
  product: ProductionSessionComposition["product"],
): CronTurnDeliveryPort | undefined {
  return createOptionalRuntimeCronTurnDelivery(
    Boolean(cron),
    options.overrides?.cron?.turnDelivery,
    turnSystem.turns,
    product.executor.reportFailure,
  );
}
function initializeRuntimeSandbox(
  options: ResolvedCreateRuntimeServicesOptions,
) {
  return composeLocalSandboxService({
    ...options,
    configWriter: options.compatibility.sandbox.writeConfig,
    evalReporter: options.compatibility.sandbox.eval,
    sandboxDescriptors: options.overrides?.sandbox?.descriptors,
  });
}
