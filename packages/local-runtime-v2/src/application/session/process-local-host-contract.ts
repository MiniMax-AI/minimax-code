import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { InternalTurnPromptReadRegistry, PromptSnapshotSource } from '@mavis/agent-core';
import type {
  PiLLMRequestFailureHook,
  PiLLMRequestObserver,
} from '@mavis/agent-core/pi-turn-runner';
import type { MatrixToolLogger } from '@mavis/agent-tools/cloud';
import type {
  BackgroundTaskHost,
  BackgroundTaskRuntime,
  LocalBackgroundTaskService,
  LocalMavisCronAdapter,
  LocalSandboxBashExecutionPort,
  LocalTaskRunResult,
  ManagedBackendRoutingContext,
} from '@mavis/agent-tools/desktop';
import type {
  ConversationPluginAgentDefinition,
  ConversationSessionKind,
  ConversationTaskModelSelection,
  RuntimeConversation,
} from '@mavis/conversation-contract';
import type { CronStorePort } from '@mavis/cron';
import type { McpRuntimeLogger } from '@mavis/mcp/runtime/types';
import type { LocalPluginHookPermissionCapability, ShellFamily } from '@mavis/permission';
import type { GlobalEventInput } from '@mavis/shared/global-events';
import type { ObservabilityLogger } from '@mavis/shared/local-runtime-diagnostics/types';
import type {
  MetricsBatchReporter,
  MetricsClient,
  ModuleMetricsReporter,
} from '@mavis/shared/local-runtime-logging/metrics';
import type { RuntimeContentSafetyCapability } from '@mavis/shared/local-runtime-safety';
import type {
  LocalSkillEnabledStatePort,
  LocalSkillRegistryDiagnosticSink,
  RuntimeSkillCapability,
} from '@mavis/shared/local-runtime-skills';
import type { AgentReferenceResolver, LocalAgentRuntimePort } from '../../service/agent/index.js';
import type { LocalTaskRunnerHost } from '../../service/background-bash/index.js';
import type {
  HostChannelSubsystemPort,
  HostChannelWireInput,
  HostedChannelCapabilities,
  WeChatRuntimeSdk,
} from '../../service/channel-system/index.js';
import type { ContentSafetyChecker } from '../../service/content-safety/index.js';
import type { RuntimeGoalHost } from '../../service/goal/index.js';
import type { LocalHookService } from '../../service/hook/index.js';
import type { LocalMcpRuntimeCapability } from '../../service/mcp/index.js';
import type {
  LocalDataCollector,
  LocalMemoryFacade,
  LocalSystemReminderService,
} from '../../service/memory-system/index.js';
import type {
  LocalModelResolverLike,
  LocalRuntimeAuthContext,
} from '../../service/model-system/index.js';
import type { LocalPermissionRouteContext } from '../../service/permission/index.js';
import type {
  CopyPendingQuestionnaireForForkInput,
  LocalQuestionnaireServiceDeps,
  QuestionnaireWorkOwner,
  ReopenQuestionnaireAfterSafetyRecallInput,
} from '../../service/questionnaire/index.js';
import type { LocalCronRuntime } from '../../service/cron/index.js';
import type { LocalEvalReporterFactory } from '../../service/session-clio/index.js';
import type { HostedAgentCapabilities } from '../../service/session-handoff/index.js';
import type {
  LocalPiHistoryStore,
  LocalSessionController,
  SessionSendWaitGraph,
} from '../../service/session-system/index.js';
import type { runForegroundLocalTask } from '../../service/team/index.js';
import type {
  BuildOwnerTurnToolSourcesInput,
  CliSunsetNoticeEvaluator,
  LocalTurnFileChangeCaptureService,
  OwnerTurnToolSources,
} from '../../service/turn-system/index.js';
import type {
  CollectionPolicyGetter,
  WorkspaceIndexingObservationSinkFactory,
  WorkspaceIndexingRemoteClient,
  WorkspaceIndexingRemoteWorker,
  WorkspaceIndexingScanService,
  WorkspaceIndexingStore,
  WorkspaceSemanticIndexStore,
  WorkspaceSemanticSearchService,
} from '../../service/workspace/index.js';

export type { LocalRuntimeAuthContext } from '../../service/model-system/index.js';
/** 复用 Task 执行宿主的完整配置输入，不使用 ModelSystem 的局部配置视图。 */
export type LocalRuntimeConfig = ReturnType<LocalTaskRunnerHost['configGetter']>;

/** 完整复用消费者的 Eval 契约，保留可选能力和 transport 配置。 */
type LocalEvalReporterFactoryLike = NonNullable<
  NonNullable<ConstructorParameters<typeof LocalSessionController>[0]>['evalReporterFactory']
>;
type LocalEvalReporterFactoryOptions = ConstructorParameters<typeof LocalEvalReporterFactory>[0];
type LocalSessionRecord = NonNullable<Awaited<ReturnType<LocalSessionController['getSession']>>>;
type LocalSessionListOptions = NonNullable<Parameters<LocalSessionController['listSessions']>[0]>;
/** Goal owner 绑定的子 Session 轮次归属端口。 */
type SubSessionRoundAttribution = Parameters<RuntimeGoalHost['bindSubSessionRoundAttribution']>[0];

interface LocalRuntimeCapabilities {
  session: boolean;
  message: boolean;
  file: boolean;
  permission: boolean;
  queue: boolean;
  eventBus: boolean;
  goal: boolean;
  team: boolean;
  asr: boolean;
  skill: boolean;
  legacyImport: boolean;
  legacyRuntime: boolean;
  electronHost: boolean;
  cliEmbedded: boolean;
  diagnosticSidecar: boolean;
  questionnaireReply: boolean;
  permissionPrompt: boolean;
  elicitation: boolean;
}

/** 宿主输入的中性契约；不依赖 HTTP 构造器或基础设施实现。 */
export interface ProcessLocalProductHostOptions {
  readonly reviewPromptDir?: string;
  dataDir: string;
  runtimeOwnerKind: 'electron' | 'cli' | 'tui' | string;
  capabilityProfile?: 'cli';
  /** 只限制磁盘恢复状态的冷启动执行，不限制交互请求。 */
  startupExecutionPolicy?: 'enabled' | 'quarantined';
  runtimeMode?: 'clean' | 'rollback';
  appVersion?: string;
  capabilities?: Partial<LocalRuntimeCapabilities>;
  shellFamily?: ShellFamily;
  mavisCronAdapterProvider?: () => LocalMavisCronAdapter | undefined;
  deleteAgentCronTasks?: (agentName: string) => Promise<void>;
  cronConsumerEnabled?: boolean;
  globalEventPublisher?: (event: GlobalEventInput) => void;
  agentResolver?: AgentReferenceResolver;
  agentRuntimePort?: LocalAgentRuntimePort;
  sandboxOperationsFactory?: LocalSandboxBashExecutionPort;
  promptSnapshots?: PromptSnapshotSource;
  disableLegacyConversation?: boolean;
  deferQuestionnaireRecovery?: boolean;
  workspaceIndexingEnabled?: () => Promise<boolean>;
  composerSendBehavior?: () => Promise<'queue' | 'steer'>;
  /** V2 后台任务 owner 的运行时工厂。 */
  createBackgroundTaskRuntime?: (host: BackgroundTaskHost) => BackgroundTaskRuntime;
  runLegacyImCredentialMigration?: (action: () => Promise<void>) => Promise<void>;
  telemetry?: (event: {
    runtime: LocalSessionRecord['runtime'];
    sessionId: string;
    turnId?: string;
    phase: 'start' | 'success' | 'failure' | 'disabled';
    message?: string;
  }) => void;
  configGetter?: () => LocalRuntimeConfig;
  modelResolver?: LocalModelResolverLike;
  authContextGetter?: () => LocalRuntimeAuthContext | undefined;
  /** Desktop-owned memory credentials must be synchronized before admitting new Turns. */
  executionAuthMode?: 'desktop';
  authContextInvalidator?: (
    rejectedAccessToken?: string,
    loginEpoch?: string,
  ) => void | Promise<void>;
  routingContextGetter?: () => ManagedBackendRoutingContext | undefined;
  isContextWindowUsageEnabled?: () => boolean;
  getCollectionPolicy?: CollectionPolicyGetter;
  createWorkspaceIndexingObservationSink?: WorkspaceIndexingObservationSinkFactory;
  fetchImpl?: typeof fetch;
  evalCapture?: LocalEvalReporterFactoryOptions;
  configUpdater?: (body: Record<string, unknown>) => Promise<{ config: LocalRuntimeConfig }>;
  hostDiagnosticsProvider?: {
    uploadDiagnosticBundle?(
      body: Record<string, unknown>,
    ): Promise<Record<string, unknown>> | Record<string, unknown>;
  };
  skillRegistryDiagnostics?: LocalSkillRegistryDiagnosticSink;
  skillEnabledState?: LocalSkillEnabledStatePort;
  cliSunsetNotice?: CliSunsetNoticeEvaluator;
  defaultWorkspaceDir?: string;
  runtimeStartupToken?: string;
  legacyOpencodeEnabled?: boolean;
  nowMs?: () => number;
  enableLiveMcp?: boolean;
  mcpLogger?: McpRuntimeLogger;
  observability?: ObservabilityLogger;
  wechatRuntimeSdk?: WeChatRuntimeSdk;
  metricsClient?: MetricsClient;
  metricsReporter?: MetricsBatchReporter;
}

/** 装配阶段注入的完整 capability 集合；独立于产品输入。 */
export interface ProcessLocalCompatibilityHostOptions {
  readonly mcpRuntime?: LocalMcpRuntimeCapability;
  readonly skillRuntime?: RuntimeSkillCapability;
  readonly pluginHookPermissionStore?: LocalPluginHookPermissionCapability;
  readonly contentSafety?: RuntimeContentSafetyCapability;
  readonly runtimeConversation?: RuntimeConversation;
  readonly deferChannelStartup?: boolean;
  readonly channelComposition?: 'internal' | 'external';
}

interface ProcessLocalAgentRecord {
  name: string;
  displayName: string;
  description?: string;
  avatar?: string;
  persona?: string;
  systemPrompt?: string;
  defaultWorkspaceDir?: string;
  creationSource: 'manual' | 'auto';
  rootSessionId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** 保留现有 Agent 入口的所有公开操作，具体路由实现仍归 HTTP。 */
interface ProcessLocalAgentRoutes {
  routeAgentApi(request: Request, parts: string[], url: URL): Promise<Response>;
  routeAgentSessionLookup(sessionId: string): Promise<Response>;
  ensureRootSession(): Promise<LocalSessionRecord>;
  replaceRootSession(agentName: string, sessionId: string): Promise<LocalSessionRecord | undefined>;
  createSession(input: {
    agentName?: string;
    workspaceDir?: string;
    sessionType?: 'root' | 'branch';
    sessionKind?: ConversationSessionKind;
    title?: string | null;
    parentSessionId?: string | null;
    visibility?: 'visible' | 'hidden';
    purpose?: string;
    originCronId?: string;
    runLocation?: LocalSessionRecord['runLocation'];
    appMode?: LocalSessionRecord['appMode'];
    effectiveModel?: string | null;
    effectiveModelVariant?: string | null;
    effectiveModelThinking?: LocalSessionRecord['effectiveModelThinking'];
    taskModelSelection?: ConversationTaskModelSelection;
    pluginAgentDefinition?: ConversationPluginAgentDefinition;
    isDefaultWorkspace?: boolean;
    origin?: LocalSessionRecord['origin'];
  }): Promise<LocalSessionRecord>;
  getLocalAgent(name: string): Promise<ProcessLocalAgentRecord | undefined>;
  listLocalAgents(): Promise<ProcessLocalAgentRecord[]>;
  createLocalAgent(body: Record<string, unknown>): Promise<Response>;
  listAgentInfos(options?: { includeLegacy?: boolean }): Promise<Array<Record<string, unknown>>>;
  listSessionsForTree(): Promise<LocalSessionRecord[]>;
  buildAgentInfoForSession(session: LocalSessionRecord): Promise<Record<string, unknown>>;
}

/**
 * 现有 apiHost 的完整公开结构。只描述能力，不引用 HTTP 类及其 private 状态；
 * runtime 装配返回的具体实例由 TypeScript 按此契约检查。
 */
interface ProcessLocalApiHost {
  readonly controller: LocalSessionController;
  readonly runtimeConversation: RuntimeConversation | undefined;
  readonly useImmediateTaskAdmission: boolean;
  readonly reviewPromptDir: string;
  hasPendingUserSteeringProbe?: (sessionId: string) => Promise<boolean> | boolean;
  isQuestionnaireGoalActive?: (sessionId: string) => Promise<boolean>;
  isQuestionnaireOriginTurnRunning?: (sessionId: string, turnId: string) => boolean;
  hasQueuedUserInputSinceProbe?: (sessionId: string, sinceMs: number) => Promise<boolean>;
  readSessionPinned?: (sessionId: string) => Promise<boolean>;
  readonly matrixLogger: MatrixToolLogger | undefined;
  readonly metricsClient: MetricsClient | undefined;
  readonly configGetter: () => LocalRuntimeConfig;
  readonly shellFamily: ProcessLocalProductHostOptions['shellFamily'];
  readonly authContextGetter: ProcessLocalProductHostOptions['authContextGetter'];
  readonly authContextInvalidator: ProcessLocalProductHostOptions['authContextInvalidator'];
  readonly routingContextGetter: ProcessLocalProductHostOptions['routingContextGetter'];
  readonly isContextWindowUsageEnabled: () => boolean;
  readonly fetchImpl: typeof fetch | undefined;
  readonly sessionSendWaitGraph: SessionSendWaitGraph;
  readonly composerSendBehavior: ProcessLocalProductHostOptions['composerSendBehavior'];
  readonly llmRequestFailureHook: PiLLMRequestFailureHook | undefined;
  readonly recordSessionBashCompletion: (
    sessionId: string,
    completion: { readonly endedAt: number; readonly durationMs: number },
  ) => void;
  readonly observeLLMRequest: PiLLMRequestObserver;
  readonly modelResolver: LocalModelResolverLike;
  readonly agentName: string;
  readonly agentDisplayName: string;
  readonly nowMs: () => number;
  readonly messageStore: ConstructorParameters<typeof LocalPiHistoryStore>[0]['messageStore'];
  readonly workspaceIndexingStore: WorkspaceIndexingStore;
  readonly workspaceIndexingService: WorkspaceIndexingScanService;
  readonly workspaceIndexingRemoteClient: WorkspaceIndexingRemoteClient;
  readonly workspaceIndexingRemoteWorker: WorkspaceIndexingRemoteWorker;
  readonly workspaceSemanticIndexStore: WorkspaceSemanticIndexStore;
  readonly workspaceSemanticSearchService: WorkspaceSemanticSearchService;
  readonly createWorkspaceIndexingObservationSink:
    | WorkspaceIndexingObservationSinkFactory
    | undefined;
  readonly turnFileChanges: LocalTurnFileChangeCaptureService;
  readonly backgroundTasks: BackgroundTaskRuntime;
  readonly backgroundTaskService: LocalBackgroundTaskService;
  readonly cronStore: CronStorePort;
  readonly questionnaireWorkOwner: QuestionnaireWorkOwner | undefined;
  readonly subSessionRoundAttribution: SubSessionRoundAttribution | undefined;
  readonly cronRuntime: LocalCronRuntime;
  readonly contentSafetyChecker: ContentSafetyChecker;
  readonly agentRuntimePort: LocalAgentRuntimePort;
  readonly agentResolver: AgentReferenceResolver;
  readonly memoryFacade: LocalMemoryFacade;
  readonly skillRuntime: RuntimeSkillCapability;
  readonly pluginHookPermissionStore: LocalPluginHookPermissionCapability;
  readonly localDataCollector: LocalDataCollector;
  readonly systemReminderService: LocalSystemReminderService;
  readonly mcpService: LocalMcpRuntimeCapability;
  readonly hookService: LocalHookService;
  readonly metrics?: ModuleMetricsReporter;
  readonly agentRoutes: ProcessLocalAgentRoutes;
  bindOfficialModelConfigRefresh(refresh: () => Promise<void>): void;
  refreshOfficialModels(): Promise<void>;
  supportsInteraction(
    capability: 'questionnaireReply' | 'permissionPrompt' | 'elicitation',
  ): boolean;
  bindPromptSnapshots(source: PromptSnapshotSource | undefined): void;
  bindInternalTurnPromptReads(registry: InternalTurnPromptReadRegistry | undefined): void;
  getPromptSnapshots(): PromptSnapshotSource | undefined;
  getInternalTurnPromptReads(): InternalTurnPromptReadRegistry | undefined;
  buildOwnerTurnToolSources(input: BuildOwnerTurnToolSourcesInput): Promise<OwnerTurnToolSources>;
  createHostedAgentCapabilities(): HostedAgentCapabilities;
  createHostedChannelCapabilities(): HostedChannelCapabilities;
  wakeSessionQueueAfterDependencyRelease(sessionId: string): void;
  listChannelSessionIds(): Promise<string[]>;
  deleteChannelBindingsForSession(sessionId: string): Promise<number>;
  deleteQuestionnairesForSession(sessionId: string): Promise<number>;
  copyPendingQuestionnaireForFork(input: CopyPendingQuestionnaireForForkInput): Promise<void>;
  reopenQuestionnaireAfterSafetyRecall(
    input: ReopenQuestionnaireAfterSafetyRecallInput,
  ): Promise<string | undefined>;
  deletePermissionStateForSession(sessionId: string): Promise<void>;
  copyPermissionStateForFork(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
  }): Promise<void>;
  inheritSessionPermissionRestrictions(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
  }): Promise<void>;
  bindQuestionnaireWorkOwner(owner: QuestionnaireWorkOwner): void;
  bindSubSessionRoundAttribution(port: SubSessionRoundAttribution): void;
  hasPendingPermissionForSession(sessionId: string): boolean;
  hasActiveTeamOwner(sessionId: string): Promise<boolean>;
  runForegroundDelegation(
    input: Omit<Parameters<typeof runForegroundLocalTask>[0], 'host' | 'parentSession'> & {
      readonly parentSessionId: string;
    },
  ): Promise<LocalTaskRunResult>;
  deleteSession(sessionId: string): Promise<void>;
  runWorkspaceIndexingSessionDeletion(
    sessionId: string,
    completeSessionDeletion: () => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
  beginShutdown(): void;
  ensureBuiltinAgents(): Promise<void>;
  sendGreetingSystemReminder(input: {
    agentName: string;
    sessionId: string;
    content: string;
    requestedTurnId: string;
  }): Promise<'finished' | { readonly status: 'accepted'; readonly turnId: string }>;
  deleteAgentCronTasks(agentName: string): Promise<void>;
  updateConfig(body: Record<string, unknown>): Promise<unknown>;
  bindPermissionShellResolver(
    resolve: (sessionId: string) => Promise<'posix' | 'powershell' | undefined>,
  ): void;
  setProcessLocalPermissionMode(
    mode: NonNullable<LocalRuntimeConfig['permissionMode']>,
  ): Promise<LocalRuntimeConfig['permissionMode']>;
  getProcessLocalRuntimeDiagnostics(): Record<string, unknown>;
  getProcessLocalAccountStatus(sessionId?: string): Promise<Record<string, unknown>>;
  retryBuiltinGreetings(): Promise<void>;
  /**
   * Connection-owned request facts are consumed by the front door (structural counterpart of
   * the HTTP layer's `RuntimeTrustedRequestContext`); the fallthrough host ignores them.
   */
  handleRequest(
    request: Request,
    trustedRequestContext?: { readonly trustedLocalTransport?: 'desktop-renderer' },
  ): Promise<Response>;
  routeLocalApiRequest(request: Request): Promise<Response>;
  permissionRouteContext(): LocalPermissionRouteContext;
  questionnaireServiceDeps(): LocalQuestionnaireServiceDeps;
  readonly bindQuestionnaireOwnedActionHandler: (
    ownedActionHandler: NonNullable<LocalQuestionnaireServiceDeps['ownedActionHandler']>,
    onFailure?: NonNullable<LocalQuestionnaireServiceDeps['onOwnedActionFailure']>,
  ) => void;
  readonly bindQuestionnaireRequestAdmission: (
    requestAdmission: NonNullable<LocalQuestionnaireServiceDeps['requestAdmission']>,
  ) => void;
  bindExternalChannelSubsystem(port: HostChannelSubsystemPort): void;
  buildChannelWireInput(): HostChannelWireInput;
  requireChannelPort(capability: string): HostChannelSubsystemPort;
  startChannelSubsystem(): Promise<void>;
  shutdownChannelSubsystem(): Promise<void>;
  prepareWorkspaceIndexingForSessionStart(sessionId: string): Promise<unknown>;
  prewarmWorkspaceIndexing(workspaceDir: string): void;
  closeWorkspaceIndexingPrewarm(): void;
  captureWorkspaceRevisionAfterTurn(sessionId: string): Promise<void>;
  logWorkspaceSemanticSearchUnavailable(sessionId: string, error: unknown): void;
  getRuntimeOwnerKind(): string;
  subscribeGlobalEvents(subscriber: {
    next(event: GlobalEventInput): void;
    complete?(): void;
  }): () => void;
  publishGlobalEvent(event: GlobalEventInput): void;
  emitBusEvent(type: string, payload: Record<string, unknown>): void;
  getSessionById(sessionId: string): Promise<LocalSessionRecord | undefined>;
  isReadOnlyLegacySession(sessionId: string): Promise<boolean>;
  listAllSessions(
    agentName?: string,
    options?: LocalSessionListOptions,
  ): Promise<LocalSessionRecord[]>;
  resolveDefaultWorkspaceDir(): string;
  resolveSessionDefaultWorkspaceDir(sessionId: string): string;
  getPiHistory(sessionId: string): Promise<AgentMessage[]>;
  ensureLegacyPiHistoryMigrated(sessionId: string): Promise<void>;
  reportPiTurnFailure(sessionId: string, message: string): void;
}

export interface ProcessLocalCreatedHost {
  apiHost: ProcessLocalApiHost;
  controller: LocalSessionController;
  dataDir: string;
  ready: Promise<void>;
  metricsClient: MetricsClient;
  observability: ObservabilityLogger;
  evalReporterFactory?: LocalEvalReporterFactoryLike;
  notifyAuthContextChanged?: (
    authState?: 'pending' | 'authenticated' | 'logged_out',
  ) => void | Promise<void>;
}
