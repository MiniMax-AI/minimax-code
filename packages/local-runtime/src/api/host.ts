import {
  CloudSessionReader,
  managedBackendRoutingHeaders,
  resolveLocalBashShell,
} from "@mavis/agent-tools/desktop";
import type { AgentMessage as PiAgentMessage } from "@earendil-works/pi-agent-core";
import type {
  InternalTurnPromptReadRegistry,
  PromptSnapshotSource,
} from "@mavis/agent-core";
import type {
  PiLLMRequestFailureHook,
  PiLLMRequestObserver,
} from "@mavis/agent-core/pi-turn-runner";
import type { AgentMessage } from "@mavis/agent-core/protocol/agent-message";
import { getConfig } from "@mavis/config";
import type { RuntimeConversation } from "@mavis/conversation-contract";
import type { CronStorePort } from "@mavis/cron";
import type { GlobalEventInput } from "@mavis/shared/global-events";
import { join } from "node:path";
import type { AgentReferenceResolver } from "../agent/port.js";
import {
  createFailClosedAgentRuntimePort,
  createLocalMavisAgentAdapter,
  type LocalAgentRuntimePort,
} from "../agent/runtime-port.js";
import { stopBackgroundLocalBashTask } from "../background-task/bash-runner.js";
import { closeLocalBackgroundTaskDelivery } from "../background-task/delivery.js";
import { createLocalBackgroundTaskService } from "../background-task/index.js";
import {
  abortAdmittedBackgroundTask,
  beginBackgroundTaskShutdown,
  drainBackgroundTasks,
} from "../background-task/lifecycle.js";
import { LocalBrowserBroker } from "../browser/api.js";
import { bindAgentDefaultChannelBinding } from "../channels/default-channel-binding.js";
import { LocalFeishuOnboardService } from "../channels/feishu-onboard.js";
import type { LocalFeishuChannelApi } from "../channels/feishu.js";
import { LocalChannelBridgeInfra } from "../channels/infra.js";
import { LocalChannelOwnerStore } from "../channels/owner-store.js";
import { LocalChannelPermissionBridge } from "../channels/permission-bridge.js";
import { LocalChannelRunner } from "../channels/runner.js";
import type { LocalTelegramChannelApi } from "../channels/telegram.js";
import type { LocalWeChatChannelApi } from "../channels/wechat.js";
import { logger } from "../common/logger.js";
import type { ModuleMetricsReporter } from "../common/metrics.js";
import type { LocalRuntimeConfig } from "../config/types.js";
import {
  updateLocalConfigFile,
  type LocalConfigUpdateResult,
} from "../config/update.js";
import {
  createContentSafetyChecker,
  type ContentSafetyChecker,
} from "../content-safety/api.js";
import type { LocalCronRuntime } from "../cron/index.js";
import { SqliteLocalCronStore } from "../cron/index.js";
import { createCuScreenshotPrunerHook } from "../cu/cu-screenshot-pruner.js";
import {
  createLLMFailureReportHook,
  type DesktopErrorReporter,
} from "../error-reporting/index.js";
import {
  createGlobalEventSource,
  type GlobalEventSubscriber,
} from "../events/global-events.js";
import { createLocalFileApiGitChangesCoordinator } from "../files/api.js";
import { LocalHookService } from "../hooks/api.js";
import { ensureBinInProcessPath } from "../infra/ensure-bin-in-path.js";
import { ensurePathIntegration } from "../infra/ensure-path-integration.js";
import { ensureRmShim } from "../infra/ensure-rm-shim.js";
import {
  ensureTrashScript,
  inspectTrashRuntime,
} from "../infra/ensure-trash-script.js";
import { LegacyOpencodeMigrator } from "../legacy-opencode/legacy-opencode-migrator.js";
import { LegacyHistoryReader } from "../legacy-opencode/legacy-history-reader.js";
import { LegacyOpencodeStore } from "../legacy-opencode/legacy-opencode-store.js";
import type { LocalDataCollector } from "../memory/local-data-collector.js";
import type { LocalMemoryFacade } from "../memory/local-memory-facade.js";
import { handleMemoryBusEvent } from "../memory/local-memory-orchestration.js";
import type {
  LocalMessageChannelContext,
  LocalMessageInput,
} from "../messages/input.js";
import type { LocalHostDiagnosticsProvider } from "../observability/diagnostics-provider.js";
import { LocalPermissionRuleStore } from "../permissions/rules.js";
import type { LocalPermissionHostHandle as PermHostHandle } from "../permissions/service.js";
import { resolveLocalPermissionService } from "../permissions/service.js";
import { SqliteLegacyMigrationStore } from "../persistence/migration/legacy-migration-store.js";
import {
  ensureCurrentLocalRuntimeDataMigratedToV2OrThrow,
  hasCompletedV2LayoutMigrationReceipt,
} from "../persistence/migration/v2-migration.js";
import type {
  LocalCommunicationMessageStore,
  LocalRuntimeMessageStore,
  LocalTokenUsageStore,
  LocalTurnDiffStore,
} from "../persistence/ports.js";
import {
  SqliteLocalCommunicationMessageStore,
  SqliteLocalTokenUsageStore,
  SqliteLocalTurnDiffStore,
} from "../persistence/sqlite-persistence.js";
import { QuestionnaireAutoReplyScheduler } from "../questionnaire/auto-reply-scheduler.js";
import {
  copyPendingQuestionnaireForFork as copyPendingQuestionnaire,
  type CopyPendingQuestionnaireForForkInput,
} from "../questionnaire/fork.js";
import { startQuestionnaireRecovery } from "../questionnaire/recovery.js";
import {
  LocalQuestionnaireService,
  type LocalQuestionnaireServiceDeps,
} from "../questionnaire/service.js";
import { SqliteQuestionnaireRequestStore } from "../questionnaire/sqlite-questionnaire-request-store.js";
import type {
  QuestionnaireRequestRecord,
  QuestionnaireRequestStore,
} from "../questionnaire/store.js";
import { resolveBuiltinReviewPromptDir } from "../review/preparation.js";
import {
  LocalBashCompletionCorrelation,
  type LocalBashCompletion,
} from "../runtime/bash-completion-correlation.js";
import { LocalDynamicMaxTokensState } from "../runtime/dynamic-max-tokens.js";
import { resolveLocalRuntimeLocale } from "../runtime/locale.js";
import { buildMavisSessionAdapter } from "../runtime/mavis-tool-adapters.js";
import type { LocalMcpRuntimeCapability } from "../runtime/mcp-capability.js";
import {
  buildLocalRuntimeCapabilities,
  buildLocalRuntimeSurfaceCapabilities,
  legacyRuntimeEnabledForMode,
  resolveLocalRuntimeMode,
  type LocalRuntimeCapabilities,
  type LocalRuntimeInteractionCapability,
  type LocalRuntimeMode,
  type LocalRuntimeSurfaceCapabilities,
} from "../runtime/mode.js";
import type {
  LocalModelResolverLike,
  LocalRuntimeAuthContext,
} from "../runtime/model-resolver.js";
import type { LocalRuntimeRoutingContext } from "../runtime/routing-headers.js";
import { isLocalRuntimeStartupExecutionEnabled } from "../runtime/startup-execution-policy.js";
import { initSessionFilesService } from "../session-assets/session-files-service.js";
import { initSessionInputSummaryService } from "../session-navigation/service.js";
import {
  InMemoryLocalSessionStore,
  LocalSessionController,
  type LocalSessionListOptions,
  type LocalSessionRecord,
} from "../sessions/controller.js";
import {
  FileSessionLedgerStore,
  type LocalSessionLedgerStore,
} from "../sessions/ledger/index.js";
import type { LocalSessionLockOwner } from "../sessions/lock-store.js";
import {
  SqliteLocalSessionProjectionStore,
  type LocalSessionProjectionStore,
} from "../sessions/projection/index.js";
import type { LocalRuntimeTelemetrySink } from "../sessions/router.js";
import {
  FileSessionSnapshotStore,
  type LocalSessionSnapshotStore,
} from "../sessions/snapshot/index.js";
import {
  LedgerBackedLocalSessionStore,
  LiveSessionWriter,
} from "../sessions/writer/index.js";
import {
  getBuiltinSkillsDirCandidates,
  isLocalBuiltinSkillEnabled,
} from "../skills/builtin.js";
import { LocalSkillHubStore } from "../skills/hub-api.js";
import { resolveBuiltinSkillsDir } from "../skills/roots.js";
import { seedBuiltinSkills } from "../skills/seed-builtin.js";
import {
  initSkillService,
  type LocalSkillService,
} from "../skills/skill-service.js";
import {
  hasActiveLocalTeamOwner,
  type LocalTeamTaskCancelInput,
  type LocalTeamTaskCancelResult,
  type LocalTeamTaskDispatchInput,
  type LocalTeamTaskDispatchResult,
} from "../team/api.js";
import { createThreadGoalEvalEventSink } from "../thread-goal/eval-observability.js";
import {
  LocalThreadGoalIntegration,
  type InternalGoalPromptTurn,
} from "../thread-goal/host-integration.js";
import { LocalThreadGoalKickoffQueue } from "../thread-goal/kickoff-host.js";
import {
  threadGoalContinuationClientRequestId,
  type ThreadGoalQueueItemIdentity,
} from "../thread-goal/kickoff.js";
import {
  createLocalGoalVerifierExecution,
  type GoalVerifierRunRegistry,
} from "../thread-goal/verifier-execution.js";
import { LocalTurnFileChangeCaptureService } from "../turns/file-changes.js";
import { toAgentMessages } from "./conversation-message-adapter.js";
import { observeSteerCompletion } from "./conversation-steer.js";
import {
  wireHostChannelSubsystem,
  type HostChannelCompositionHandle,
} from "./host-channel-composition.js";
import {
  shutdownChannelSubsystem as shutdownChannelSubsystemHelper,
  type ChannelShutdownHostHandle,
} from "./host-channel-shutdown.js";
import {
  buildHostCronRuntime,
  type HostCronRuntimeDeps,
} from "./host-cron-runtime.js";
import { LocalGreetingSystemReminderSender } from "./host-greeting-sender.js";
import {
  makeId,
  readLocalPermissionMode,
  type LocalRuntimeApiHostOptions,
} from "./host-helpers.js";
import {
  isReadOnlyLegacySession,
  markMigratedLegacySessionDeleted,
} from "./host-legacy-helpers.js";
import {
  createLocalMemorySubsystem,
  type LocalSystemReminderService,
} from "./host-memory.js";
import {
  deliverQuestionnaireAskToChannel as deliverQuestionnaireAskToChannelHelper,
  type QuestionnaireDeliveryHostHandle,
} from "./host-questionnaire-delivery.js";
import {
  buildPermissionRouteContext,
  buildQuestionnaireServiceDeps,
  createQuestionnaireOwnedActionBinder,
  createQuestionnaireRequestAdmissionBinder,
  type RouteContextHostHandle,
} from "./host-route-contexts.js";
import {
  hostNormalizeCleanLocalSession,
  hostSerializeSession,
  hostSerializeSessions,
  hostSerializeSessionTree,
  type SessionStateHostHandle,
} from "./host-session-state.js";
import {
  buildRuntimeDoctorSnapshot,
  dispatchLocalTeamTask,
  formatUnknownError,
  makeRuntimeOwnerId,
  resolveDefaultLocalWorkspaceDir,
  resolveLocalTeamTaskAgentName,
} from "./host-support.js";
import {
  createLocalGreetingSystemReminderSender,
  createLocalModelResolver,
} from "./host-turn-service-factories.js";
import {
  buildLocalTurnToolSourcesForHost,
  type BuildOwnerTurnToolSourcesInput,
  type OwnerTurnToolSources,
} from "./host-turn-tools.js";
import {
  type HostedAgentCapabilities,
  type HostedTurnBudgetCheckInput,
  type HostedTurnLifecycleInput,
  type HostedTurnSettlementInput,
} from "./hosted-agent-capabilities.js";
import {
  createHostedCapabilities,
  isCliRestrictedRuntime,
} from "./hosted-agent-capability-factory.js";
import {
  createHostedChannelCapabilities,
  type HostedChannelCapabilities,
} from "./hosted-channel-capabilities.js";
import { LocalPermissionApprovalService } from "./local-permission-approval-service.js";
import { LocalPiHistoryStore } from "./pi-history-store.js";
import { LocalApiAgentRoutes } from "./routes/agents.js";
import { requestConversationCompaction } from "./routes/compaction.js";
import {
  abortLocalPermissionRequests,
  type LocalPermissionRouteContext,
} from "./routes/permissions.js";

const DEFAULT_LOCAL_AGENT_NAME = "mavis";
const DEFAULT_LOCAL_AGENT_DISPLAY_NAME = "Mavis";
export type { LocalRuntimeApiHostOptions };
export class LocalRuntimeApiHost {
  public readonly controller: LocalSessionController;
  public readonly runtimeConversation: RuntimeConversation | undefined;
  public readonly reviewPromptDir: string;
  /**
   * Decision v3 ask_user suppression probe, late-bound by the V2 runtime once
   * its Turn system exists (V1-only hosts leave it unset — never suppress).
   * Read through `buildQuestionnaireServiceDeps` at each tool assembly.
   */
  public hasPendingUserSteeringProbe?: (
    sessionId: string,
  ) => Promise<boolean> | boolean;
  /** Read-only projection from the V2 Pin owner for legacy Session responses. */
  public readSessionPinned?: (sessionId: string) => Promise<boolean>;
  private legacyRuntime: LegacyHistoryReader | undefined;
  private readonly legacyOpencodeEnabled: boolean | undefined;
  private readonly runtimeMode: LocalRuntimeMode;
  private readonly capabilityProfile: LocalRuntimeApiHostOptions["capabilityProfile"];
  private readonly capabilities: LocalRuntimeCapabilities;
  private readonly surfaces: LocalRuntimeSurfaceCapabilities;
  private readonly telemetry: LocalRuntimeTelemetrySink | undefined;
  public readonly matrixLogger: LocalRuntimeApiHostOptions["matrixLogger"];
  public readonly metricsClient: LocalRuntimeApiHostOptions["metricsClient"];
  public readonly configGetter: () => LocalRuntimeConfig;
  public readonly shellFamily: LocalRuntimeApiHostOptions["shellFamily"];
  /** TUI-only opt-out, frozen at startup rather than read from tool/session input. */
  public readonly skipWindowsHardSafetyChecks: boolean;
  public readonly authContextGetter:
    | (() => LocalRuntimeAuthContext | undefined)
    | undefined;
  public readonly authContextInvalidator:
    | ((
        rejectedAccessToken?: string,
        loginEpoch?: string,
      ) => void | Promise<void>)
    | undefined;
  public readonly routingContextGetter:
    | (() => LocalRuntimeRoutingContext | undefined)
    | undefined;
  public readonly isContextWindowUsageEnabled: () => boolean;
  public readonly fetchImpl: typeof fetch | undefined;
  public readonly llmRequestFailureHook: PiLLMRequestFailureHook | undefined;
  public readonly recordSessionBashCompletion: (
    sessionId: string,
    completion: LocalBashCompletion,
  ) => void;
  public readonly observeLLMRequest: PiLLMRequestObserver;
  private readonly errorReporter: DesktopErrorReporter | undefined;
  private readonly configUpdater: (
    body: Record<string, unknown>,
  ) => Promise<LocalConfigUpdateResult>;
  public readonly modelResolver: LocalModelResolverLike;
  private readonly greetingSystemReminderSender: LocalGreetingSystemReminderSender;
  public readonly agentName: string;
  public readonly agentDisplayName: string;
  private readonly defaultWorkspaceDir: string | undefined;
  public readonly nowMs: () => number;
  private readonly staleCompactionCutoffMs: number;
  public readonly messageStore: LocalRuntimeMessageStore | undefined;
  private readonly ledgerStore: LocalSessionLedgerStore | undefined;
  private readonly sessionWriter: LiveSessionWriter;
  private readonly projectionStore: LocalSessionProjectionStore | undefined;
  private readonly snapshotStore: LocalSessionSnapshotStore | undefined;
  private readonly piHistory = new Map<string, PiAgentMessage[]>();
  private readonly piHistoryStore: LocalPiHistoryStore;
  private readonly communicationMessageStore: LocalCommunicationMessageStore;
  private readonly tokenUsageStore: LocalTokenUsageStore;
  private readonly turnDiffStore: LocalTurnDiffStore;
  public readonly turnFileChanges: LocalTurnFileChangeCaptureService;
  public readonly backgroundTaskService: ReturnType<
    typeof createLocalBackgroundTaskService
  >;
  public readonly cronStore: CronStorePort;
  public readonly threadGoal: LocalThreadGoalIntegration;
  private readonly threadGoalKickoffQueue: LocalThreadGoalKickoffQueue;
  private threadGoalCronOwnerConflictReader?: (
    sessionId: string,
  ) => Promise<boolean> | boolean;
  public readonly cronRuntime: LocalCronRuntime;
  public readonly contentSafetyChecker: ContentSafetyChecker;
  public readonly agentRuntimePort: LocalAgentRuntimePort;
  private officialModelConfigRefresh: () => Promise<void> = () =>
    Promise.resolve();

  public bindOfficialModelConfigRefresh(refresh: () => Promise<void>): void {
    this.officialModelConfigRefresh = refresh;
  }

  public refreshOfficialModels(): Promise<void> {
    return this.officialModelConfigRefresh();
  }
  /** Neutral reference port supplied by the owning runtime (V2 in production). */
  public readonly agentResolver: AgentReferenceResolver;
  public readonly memoryFacade: LocalMemoryFacade;
  public readonly skillService: LocalSkillService;
  public readonly localDataCollector: LocalDataCollector;
  public readonly systemReminderService: LocalSystemReminderService;
  public readonly dynamicMaxTokensState: LocalDynamicMaxTokensState;
  private readonly cuScreenshotPruner: ReturnType<
    typeof createCuScreenshotPrunerHook
  >;
  private readonly questionnaireStore: QuestionnaireRequestStore;
  private readonly questionnaireAutoReplyScheduler: QuestionnaireAutoReplyScheduler;
  private readonly mcpRuntime: LocalMcpRuntimeCapability | undefined;
  get mcpService(): LocalMcpRuntimeCapability {
    if (!this.mcpRuntime)
      throw new Error("MCP runtime is not available on this host");
    return this.mcpRuntime;
  }
  public readonly hookService: LocalHookService;
  public readonly metrics?: ModuleMetricsReporter;
  private readonly browserBroker: LocalBrowserBroker;
  public readonly skillHubStore: LocalSkillHubStore;
  private readonly channelOwnerStore: LocalChannelOwnerStore;
  private readonly channelBridgeInfra: LocalChannelBridgeInfra;
  private readonly channelRunner: LocalChannelRunner;
  private readonly channelPermissionBridge: LocalChannelPermissionBridge;
  /** Idempotent channel-subsystem startup; see {@link startChannelSubsystem}. */
  private readonly channelSubsystemStartup: () => Promise<void>;
  private readonly channelTurnOrigins = new Map<
    string,
    LocalMessageChannelContext
  >();
  private readonly feishuChannelApi: LocalFeishuChannelApi;
  private readonly feishuOnboardService: LocalFeishuOnboardService;
  private readonly telegramChannelApi: LocalTelegramChannelApi;
  private readonly wechatChannelApi: LocalWeChatChannelApi;
  private readonly hostDiagnosticsProvider:
    | LocalHostDiagnosticsProvider
    | undefined;
  private readonly permissionRules: LocalPermissionRuleStore;
  private readonly permissionApprovalService: LocalPermissionApprovalService;
  private readonly legacyMigrator: LegacyOpencodeMigrator | undefined;
  public readonly agentRoutes: LocalApiAgentRoutes;
  private readonly lockOwner: LocalSessionLockOwner;
  private readonly runtimeStartupToken: string | undefined;
  private promptSnapshots: PromptSnapshotSource | undefined;
  private internalTurnPromptReads: InternalTurnPromptReadRegistry | undefined;
  private readonly startupExecutionEnabled: boolean;
  private readonly channelCapabilityEnabled: boolean;
  private readonly globalEvents = createGlobalEventSource();
  private readonly globalEventPublisher: (event: GlobalEventInput) => void;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly metricsReporter: LocalRuntimeApiHostOptions["metricsReporter"];
  private readonly mavisCronAdapterProvider: LocalRuntimeApiHostOptions["mavisCronAdapterProvider"];
  private readonly deleteAgentCronTasksOverride: LocalRuntimeApiHostOptions["deleteAgentCronTasks"];
  private readonly fileGitChangesCoordinator =
    createLocalFileApiGitChangesCoordinator();
  constructor(options: LocalRuntimeApiHostOptions = {}) {
    const bashCompletionCorrelation =
      options.bashCompletionCorrelation ??
      new LocalBashCompletionCorrelation(options.metricsClient);
    this.recordSessionBashCompletion = bashCompletionCorrelation.record;
    this.observeLLMRequest = bashCompletionCorrelation.observeLLMRequest;
    this.runtimeConversation = options.runtimeConversation;
    this.reviewPromptDir =
      options.reviewPromptDir ?? resolveBuiltinReviewPromptDir();
    this.globalEventPublisher =
      options.globalEventPublisher ??
      ((event) => this.globalEvents.publish(event));
    this.startupExecutionEnabled = isLocalRuntimeStartupExecutionEnabled(
      options.startupExecutionPolicy,
    );
    this.capabilityProfile = options.capabilityProfile;
    this.channelCapabilityEnabled = this.capabilityProfile !== "cli";
    const questionnaireRecoveryDeferred =
      options.deferQuestionnaireRecovery === true;
    this.mavisCronAdapterProvider = options.mavisCronAdapterProvider;
    this.deleteAgentCronTasksOverride = options.deleteAgentCronTasks;
    this.runtimeMode = options.runtimeMode ?? resolveLocalRuntimeMode();
    this.capabilities = buildLocalRuntimeCapabilities(
      this.runtimeMode,
      options.capabilities,
    );
    this.surfaces = buildLocalRuntimeSurfaceCapabilities(this.runtimeMode);
    this.configGetter = options.configGetter ?? (() => getConfig());
    // Use the executor's shell selection when the product entrypoint supplies no override.
    // Keep POSIX provenance on Windows (Git Bash / sh) as well as native shells.
    this.shellFamily =
      options.shellFamily ??
      (() => {
        const shell = resolveLocalBashShell();
        if (shell === 'powershell' || shell === 'pwsh') return 'powershell';
        if (shell === 'bash' || shell === 'sh') return 'posix';
        return undefined;
      })();
    this.skipWindowsHardSafetyChecks =
      options.runtimeOwnerKind === 'tui' &&
      this.configGetter().skipWindowsHardSafetyChecks === true;
    this.authContextGetter = options.authContextGetter;
    this.authContextInvalidator = options.authContextInvalidator;
    this.routingContextGetter = options.routingContextGetter;
    this.isContextWindowUsageEnabled =
      options.isContextWindowUsageEnabled ?? (() => false);
    this.fetchImpl = options.fetchImpl;
    this.errorReporter = options.errorReporter;
    this.llmRequestFailureHook =
      options.llmRequestFailureHook ??
      (this.errorReporter
        ? createLLMFailureReportHook(this.errorReporter)
        : undefined);
    this.configUpdater = options.configUpdater ?? updateLocalConfigFile;
    this.legacyRuntime = options.legacyOpencodeRuntime;
    this.legacyOpencodeEnabled = options.legacyOpencodeEnabled;
    this.telemetry = options.telemetry;
    this.matrixLogger = options.matrixLogger;
    this.metricsClient = options.metricsClient;
    this.agentRuntimePort =
      options.agentRuntimePort ?? createFailClosedAgentRuntimePort();
    this.promptSnapshots = options.promptSnapshots;
    this.agentResolver = options.agentResolver ?? this.agentRuntimePort;
    this.cuScreenshotPruner = createCuScreenshotPrunerHook(
      2,
      this.metricsClient,
    );
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.metricsReporter = options.metricsReporter;
    this.staleCompactionCutoffMs = this.nowMs();
    if (
      !hasCompletedV2LayoutMigrationReceipt(
        options,
        () => this.configGetter().dataDir,
      )
    ) {
      ensureCurrentLocalRuntimeDataMigratedToV2OrThrow(
        () => this.configGetter().dataDir,
        this.nowMs,
        this.metricsReporter,
      );
    }
    const runtimeConfig = this.configGetter();
    const runtimeDataDir = runtimeConfig.dataDir;
    const nativeDelete = runtimeConfig.permission?.nativeDelete === true;
    try {
      // Keep explicit mavis-trash available in either mode.
      ensureTrashScript(runtimeDataDir);
      if (!nativeDelete) ensureRmShim(runtimeDataDir);
    } catch (error) {
      const nodeError =
        error instanceof Error ? (error as NodeJS.ErrnoException) : undefined;
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error ? { error_name: error.name } : {}),
          ...(typeof nodeError?.code === "string"
            ? { error_code: nodeError.code }
            : {}),
          ...(typeof nodeError?.syscall === "string"
            ? { syscall: nodeError.syscall }
            : {}),
        },
        "local_runtime.trash_seed_failed",
      );
    }
    for (const ensure of [ensureBinInProcessPath, ensurePathIntegration]) {
      try {
        ensure(runtimeDataDir);
      } catch {
        // PATH integration remains best-effort; deletion safety is gated separately above.
      }
    }
    if (!nativeDelete) {
      const trashRuntime = inspectTrashRuntime(runtimeDataDir);
      if (!trashRuntime.available) {
        logger.error(
          { reason: trashRuntime.reason, ...trashRuntime.diagnostics },
          "local_runtime.trash_unavailable",
        );
      }
    }
    this.messageStore = options.messageStore;
    const sessionStoreOptions = {
      nowMs: this.nowMs,
      metricsClient: options.metricsClient,
    };
    const ledgerStore =
      options.ledgerStore === false
        ? undefined
        : (options.ledgerStore ??
          new FileSessionLedgerStore(
            this.configGetter().dataDir,
            sessionStoreOptions,
          ));
    this.ledgerStore = ledgerStore;
    this.projectionStore =
      options.projectionStore ??
      (ledgerStore && this.messageStore
        ? new SqliteLocalSessionProjectionStore(this.configGetter().dataDir)
        : undefined);
    this.snapshotStore =
      options.snapshotStore ??
      (ledgerStore && this.messageStore
        ? new FileSessionSnapshotStore(
            this.configGetter().dataDir,
            sessionStoreOptions,
          )
        : undefined);
    this.sessionWriter =
      options.sessionWriter ??
      new LiveSessionWriter({
        ledgerStore,
        messageStore: this.messageStore,
        projectionStore: this.projectionStore,
        snapshotStore: this.snapshotStore,
      });
    this.controller =
      options.controller ??
      new LocalSessionController({
        store: new LedgerBackedLocalSessionStore({
          delegate: new InMemoryLocalSessionStore(),
          writer: this.sessionWriter,
        }),
        legacyOpencodeEnabled: () => this.isLegacyRuntimeEnabled(),
        telemetry: options.telemetry,
        nowMs: this.nowMs,
        authContextGetter: this.authContextGetter,
        routingContextGetter: this.routingContextGetter,
        fetchImpl: this.fetchImpl,
        ...(this.errorReporter ? { errorReporter: this.errorReporter } : {}),
        ...(this.llmRequestFailureHook
          ? { llmRequestFailureHook: this.llmRequestFailureHook }
          : {}),
        observeLLMRequest: this.observeLLMRequest,
        assertTurnStartAllowed: () =>
          this.rejectRetiredConversation("turn-start"),
        assertSessionMutationAllowed: (operation) =>
          this.rejectRetiredConversation(`session-controller-${operation}`),
      });
    const hostAgentName = options.agentName ?? DEFAULT_LOCAL_AGENT_NAME;
    this.dynamicMaxTokensState = new LocalDynamicMaxTokensState();
    this.modelResolver =
      options.modelResolver ??
      createLocalModelResolver({
        configGetter: this.configGetter,
        authContextGetter: this.authContextGetter,
        routingContextGetter: this.routingContextGetter,
        dynamicMaxTokensState: this.dynamicMaxTokensState,
        fetchImpl: this.fetchImpl,
      });
    this.greetingSystemReminderSender = createLocalGreetingSystemReminderSender(
      this,
      this.runtimeConversation,
    );
    const contentSafetyChecker = createContentSafetyChecker({
      apiVersion: "v2",
      authContextGetter: this.authContextGetter,
      authContextInvalidator: this.authContextInvalidator,
      routingContextGetter: this.routingContextGetter,
      fetchImpl: this.fetchImpl,
      testBaseURLGetter: () => this.configGetter().contentReview?.testBaseURL,
    });
    this.contentSafetyChecker = contentSafetyChecker;
    this.agentName = hostAgentName;
    this.agentDisplayName =
      options.agentDisplayName ?? DEFAULT_LOCAL_AGENT_DISPLAY_NAME;
    const memory = createLocalMemorySubsystem({
      configGetter: this.configGetter,
      nowMs: this.nowMs,
      emitBusEvent: (type, payload) => this.emitBusEvent(type, payload),
      // Lazy: `lockOwner` is assigned later in this constructor, and the
      // adapter provider only resolves once the v2 Cron bridge is bound.
      cronEnabled: () => this.isCronCapabilityAvailable(),
      // TUI has no user-scoped Memory surface; keep CLI and other hosts unchanged.
      userMemoryEnabled: () => this.isUserMemoryCapabilityAvailable(),
      cliSunsetNotice: options.cliSunsetNotice,
      agentFacts: () => this.agentRuntimePort,
      userConfiguredName: () => this.authContextGetter?.()?.subUserName,
    });
    this.memoryFacade = memory.memoryFacade;
    this.localDataCollector = memory.localDataCollector;
    this.systemReminderService = memory.systemReminderService;
    this.defaultWorkspaceDir = options.defaultWorkspaceDir;
    this.communicationMessageStore =
      options.communicationMessageStore ??
      new SqliteLocalCommunicationMessageStore(this.configGetter().dataDir);
    this.tokenUsageStore =
      options.tokenUsageStore ??
      new SqliteLocalTokenUsageStore(this.configGetter().dataDir);
    this.turnDiffStore =
      options.turnDiffStore ??
      new SqliteLocalTurnDiffStore(this.configGetter().dataDir);
    this.turnFileChanges = new LocalTurnFileChangeCaptureService(
      this.turnDiffStore,
      {
        nowMs: this.nowMs,
        makeId,
        reportFailure: (sessionId, message) =>
          this.reportPiTurnFailure(sessionId, message),
      },
    );
    this.backgroundTaskService = createLocalBackgroundTaskService(
      () => this.configGetter().dataDir,
      this.nowMs,
      async (task, reason) => {
        abortAdmittedBackgroundTask(
          this,
          task.taskId,
          reason ?? (task.kind === 'bash' ? 'Background bash stopped' : 'Background task stopped'),
        );
        await stopBackgroundLocalBashTask(task, reason);
        const childSessionId = task.metadata?.childSessionId;
        const subTurnId = task.metadata?.subTurnId;
        if (
          typeof childSessionId !== "string" ||
          !childSessionId ||
          typeof subTurnId !== "string" ||
          !subTurnId
        ) {
          return;
        }
        await this.requireRuntimeConversation(
          "background task abort",
        ).ingress.abort(childSessionId, "lifecycle", subTurnId);
      },
      ({ ownerSessionId }) =>
        this.wakeSessionQueueAfterDependencyRelease(ownerSessionId),
    );
    this.cronStore =
      options.cronStore ??
      new SqliteLocalCronStore(this.configGetter().dataDir, this.nowMs);
    this.questionnaireStore =
      options.questionnaireStore ??
      new SqliteQuestionnaireRequestStore(() => this.configGetter().dataDir);
    this.questionnaireAutoReplyScheduler = new QuestionnaireAutoReplyScheduler({
      nowMs: this.nowMs,
      run: async (requestId) => {
        const service = new LocalQuestionnaireService(
          this.questionnaireServiceDeps(),
        );
        return service.autoReply(requestId);
      },
      retryDelayMs: 1_000,
    });
    this.lockOwner = {
      ownerId:
        options.runtimeOwnerId ??
        makeRuntimeOwnerId(options.runtimeOwnerKind ?? "runtime"),
      ownerKind: options.runtimeOwnerKind ?? "runtime",
    };
    this.threadGoalKickoffQueue = new LocalThreadGoalKickoffQueue({
      ...(this.runtimeConversation
        ? { conversation: this.runtimeConversation }
        : {}),
      getIntegration: () => this.threadGoal,
      reportFailure: (sessionId, message) =>
        this.reportPiTurnFailure(sessionId, message),
      reportRecoveryFailure: (error) =>
        this.emitBusEvent("thread_goal.kickoff_recovery_failed", { error }),
    });
    this.threadGoal = new LocalThreadGoalIntegration({
      configGetter: this.configGetter,
      dataDir: () => this.configGetter().dataDir,
      nowMs: this.nowMs,
      turnTimingReader: this.controller.activeTurnTimingReader,
      publishGlobalEvent: (event) => this.publishGlobalEvent(event),
      promptSnapshots: () => this.promptSnapshots,
      hasPendingQuestionnaire: (sessionId, expectedGoalId) =>
        expectedGoalId
          ? new LocalQuestionnaireService(
              this.questionnaireServiceDeps(),
            ).blocksGoalContinuation(sessionId, expectedGoalId)
          : this.questionnaireStore.hasUnresolvedBySession(sessionId),
      retireGoalQuestionnaire: (sessionId, goalId) =>
        new LocalQuestionnaireService(
          this.questionnaireServiceDeps(),
        ).retireGoalQuestionnaire(sessionId, goalId),
      hasPendingPermission: (sessionId) =>
        this.permissionApprovalService
          .listPending()
          .some((request) => request.sessionId === sessionId),
      hasAutomationOwnerConflict: async (sessionId) =>
        (await hasActiveLocalTeamOwner(
          this.configGetter().dataDir,
          sessionId,
        )) ||
        (await this.threadGoalCronOwnerConflictReader?.(sessionId)) === true,
      hasRequiredBackgroundWork: async (sessionId) =>
        (
          await this.backgroundTaskService.list({
            ownerSessionId: sessionId,
            statuses: ["queued", "running", "stopping"],
            limit: 1,
          })
        ).items.length > 0,
      startContinuationTurn: async (
        sessionId,
        message,
        displayContent,
        internalPromptRead,
      ) => {
        const conversation = this.requireRuntimeConversation(
          "thread-goal continuation",
        );
        try {
          const accepted = await conversation.ingress.submit({
            sessionId,
            source: "thread-goal",
            allowQueue: true,
            ...(internalPromptRead
              ? { requestedTurnId: internalPromptRead.requestedTurnId }
              : {}),
            message: {
              ...message,
              hideUserMessage: true,
              ...(displayContent ? { displayContent } : {}),
            },
          });
          if (
            internalPromptRead &&
            accepted.turnId !== internalPromptRead.requestedTurnId
          ) {
            this.threadGoal.rebindInternalPromptRead(
              internalPromptRead,
              accepted.turnId,
            );
          }
          return "started";
        } catch (error) {
          if (internalPromptRead)
            this.threadGoal.discardInternalPromptRead(internalPromptRead);
          throw error;
        }
      },
      steerContinuationTurn: async ({
        sessionId,
        message,
        idempotencyKey,
        internalPromptRead,
        onAccepted,
      }) => {
        const conversation = this.requireRuntimeConversation(
          "thread-goal objective steering",
        );
        try {
          const result = await conversation.ingress.steer({
            sessionId,
            source: "thread-goal",
            producerId: "thread-goal-objective",
            idempotencyKey,
            ...(internalPromptRead
              ? { requestedTurnId: internalPromptRead.requestedTurnId }
              : {}),
            message: {
              content: message.content,
              attachments: message.attachments.map((attachment) => ({
                ...attachment,
              })),
              origin: message.origin,
              hideUserMessage: true,
            },
            preDelivery: {
              accept: async (accepted) => {
                if (internalPromptRead) {
                  if (accepted.mode === "activated") {
                    this.threadGoal.rebindInternalPromptRead(
                      internalPromptRead,
                      accepted.turnId,
                    );
                  } else {
                    this.threadGoal.discardInternalPromptRead(
                      internalPromptRead,
                    );
                  }
                }
                await onAccepted(accepted);
              },
            },
          });
          observeSteerCompletion(result, {
            sessionId,
            producer: "Thread Goal objective steering",
            matrixLogger: this.matrixLogger,
          });
          return result;
        } catch (error) {
          if (internalPromptRead)
            this.threadGoal.discardInternalPromptRead(internalPromptRead);
          throw error;
        }
      },
      enqueuePostTurnContinuation: (input) =>
        this.enqueueInjectedThreadGoalContinuation(input),
      abortThreadGoalTurn: (sessionId, turnId) =>
        this.requireRuntimeConversation("thread-goal pause").ingress.abort(
          sessionId,
          "thread-goal-paused",
          turnId,
        ),
      internalTurnPromptReads: () => this.internalTurnPromptReads,
      ...this.threadGoalKickoffQueue.integrationDeps(),
      reportFailure: (sessionId, message) =>
        this.reportPiTurnFailure(sessionId, message),
      formatError: formatUnknownError,
      ...(options.threadGoalRuntimeEventSink
        ? { emitRuntimeEvent: options.threadGoalRuntimeEventSink }
        : options.evalReporterFactory
          ? {
              emitRuntimeEvent: createThreadGoalEvalEventSink(
                options.evalReporterFactory,
              ),
            }
          : {}),
    });
    this.mcpRuntime = options.mcpService;
    this.hookService =
      options.hookService ??
      new LocalHookService({
        dataDir: () => this.configGetter().dataDir,
        nowMs: this.nowMs,
        resolveWorkspaceDir: () => this.resolveDefaultWorkspaceDir(),
        // Session-exact resolver for built-ins that key derived state by the
        // directory the session's tools run in. The default resolver above
        // ignores the sessionId, which mis-keys per-branch recordings (the
        // review-link status line item) whenever a session runs outside the
        // host default workspace — a worktree session, a workspace picked in
        // the TUI, or a runtime shared by several launch directories.
        resolveSessionWorkspaceDir: async (sessionId) => {
          try {
            const session = await this.getSessionById(sessionId);
            if (!session) return undefined;
            return session.runLocation?.resolvedDir ?? session.workspaceDir;
          } catch {
            // An unresolvable session must skip the recording, not adopt the
            // host default: a wrong key misattributes the review.
            return undefined;
          }
        },
        ...(options.metricsReporter
          ? { metricsReporter: options.metricsReporter }
          : {}),
      });
    for (const registration of this.turnFileChanges.getToolCaptureHookRegistrations()) {
      this.hookService.registry.registerBuiltin(registration);
    }
    this.metrics = options.metricsReporter;
    this.browserBroker =
      options.browserBroker ??
      new LocalBrowserBroker({
        dataDir: () => this.configGetter().dataDir,
        nowMs: this.nowMs,
      });
    this.skillHubStore =
      options.skillHubStore ??
      new LocalSkillHubStore({
        dataDir: () => this.configGetter().dataDir,
        nowMs: this.nowMs,
        fetch: this.fetchImpl,
        authContextGetter: this.authContextGetter,
        routingContextGetter: this.routingContextGetter,
      });
    seedBuiltinSkills({
      builtinSkillsDir: resolveBuiltinSkillsDir(this.configGetter()),
      sourceDirs: getBuiltinSkillsDirCandidates(),
      isSkillEnabled: isLocalBuiltinSkillEnabled,
    });
    initSessionFilesService({
      dataDir: () => this.configGetter().dataDir,
      hasMessageStore: Boolean(this.messageStore),
      ensureLegacyMessagesMigrated: (sessionId) =>
        this.legacyMigrator?.ensureMessagesMigrated(sessionId) ??
        Promise.resolve(),
      getDisplayMessages: (sessionId) => this.getDisplayMessages(sessionId),
    });
    initSessionInputSummaryService({
      dataDir: () => this.configGetter().dataDir,
      ensureLegacyMessagesMigrated: (sessionId) =>
        this.legacyMigrator?.ensureMessagesMigrated(sessionId) ??
        Promise.resolve(),
      metricsClient: this.metricsClient,
    });
    this.skillService = initSkillService({
      configGetter: this.configGetter,
      skillRegistryRoots: options.skillRegistryRoots,
      registryDiagnostics: options.skillRegistryDiagnostics,
      readMcpServerNames: () => this.mcpService.readConfiguredServerNames(),
      enabledState: options.skillEnabledState,
      skillHubStore: this.skillHubStore,
      // Gate user-authored skill name / description / content through the same
      // content-safety scene as agent config writes (scene ConfigField).
      reviewContent: contentSafetyChecker,
      metricsClient: this.metricsClient,
      resourceAmbiguityTelemetry: {
        emitBusEvent: (type, payload) => this.emitBusEvent(type, payload),
        metrics: options.metricsReporter,
      },
      resolveAgentReadScope: (requestedName) =>
        this.agentResolver.resolveAgentReadScope(requestedName),
      resolveAgentWriteTarget: (requestedName) =>
        this.agentResolver.resolveAgentWriteTarget(requestedName),
    });
    const subsys = wireHostChannelSubsystem(
      this as unknown as HostChannelCompositionHandle,
      options,
    );
    this.channelOwnerStore = subsys.channelOwnerStore;
    this.channelBridgeInfra = subsys.channelBridgeInfra;
    this.channelRunner = subsys.channelRunner;
    this.channelPermissionBridge = subsys.channelPermissionBridge;
    this.channelSubsystemStartup = subsys.startChannelSubsystem;
    this.feishuChannelApi = subsys.feishuChannelApi;
    this.feishuOnboardService = new LocalFeishuOnboardService({
      feishu: this.feishuChannelApi,
      // Onboarding is a transport consumer of the V2-owned Agent port. Keep
      // the resolver explicit so a legacy host never invents a local owner.
      resolveAgentWriteTarget: (requestedName) =>
        this.agentRuntimePort.resolveAgentWriteTarget(requestedName),
      bindingStore: this.channelBridgeInfra.bindingStore,
      ...(this.channelBridgeInfra.imConnectionStore
        ? { imConnectionStore: this.channelBridgeInfra.imConnectionStore }
        : {}),
      accessControlStore: subsys.channelAccessControlStore,
      ...(this.channelBridgeInfra.rootlessEnabled
        ? {
            bindRootlessDefaultSession: async (agentName: string) => {
              await bindAgentDefaultChannelBinding(
                this.channelBridgeInfra,
                "feishu",
                agentName,
                agentName,
              );
            },
          }
        : {
            ensureRootSession: async (agentName: string) =>
              (
                await this.listAllSessions(agentName, { includeHidden: true })
              ).find(
                (session) =>
                  session.runtime === "pi-agent" &&
                  session.sessionType === "root",
              ) ??
              this.agentRoutes.createSession({
                agentName,
                workspaceDir: this.resolveDefaultWorkspaceDir(),
                isDefaultWorkspace: true,
                sessionType: "root",
                title: "Main",
                parentSessionId: null,
              }),
          }),
      nowMs: this.nowMs,
      makeId,
      fetchImpl: options.feishuOnboardFetch ?? this.fetchImpl,
      ...(options.metricsReporter ? { metrics: options.metricsReporter } : {}),
    });
    this.telegramChannelApi = subsys.telegramChannelApi;
    this.wechatChannelApi = subsys.wechatChannelApi;
    this.hostDiagnosticsProvider = options.hostDiagnosticsProvider;
    this.permissionRules = new LocalPermissionRuleStore(
      () => this.configGetter().dataDir,
      this.metricsClient,
      () => this.configGetter().permission?.storageWriteVersion ?? 2,
    );
    this.permissionApprovalService = new LocalPermissionApprovalService({
      agentName: this.agentName,
      nowMs: this.nowMs,
      permissionRules: this.permissionRules,
      publishGlobalEvent: (event) => this.publishGlobalEvent(event),
      channelPermissionOutbound: this.channelPermissionBridge,
      metricsClient: this.metricsClient,
      permissionMode: readLocalPermissionMode(
        this.configGetter().permissionMode,
      ),
    });
    this.runtimeStartupToken = options.runtimeStartupToken;
    this.legacyMigrator =
      this.runtimeMode === "clean" && !this.runtimeConversation
        ? new LegacyOpencodeMigrator({
            legacyStore: new LegacyOpencodeStore({
              dataDir: this.configGetter().dataDir,
              nowMs: this.nowMs,
            }),
            migrationStore: new SqliteLegacyMigrationStore(
              this.configGetter().dataDir,
            ),
            controller: this.controller,
            messageStore: this.messageStore,
            sessionWriter: this.sessionWriter,
            primaryAgentName: this.agentName,
            defaultWorkspaceDir: () => this.resolveDefaultWorkspaceDir(),
            dataDir: () => this.configGetter().dataDir,
            nowMs: this.nowMs,
            metrics: options.metricsReporter,
          })
        : undefined;
    this.piHistoryStore = new LocalPiHistoryStore({
      ledgerStore: this.ledgerStore,
      snapshotStore: this.snapshotStore,
      messageStore: this.messageStore,
      sessionWriter: this.sessionWriter,
      tokenUsageStore: this.tokenUsageStore,
      legacyMigrator: this.legacyMigrator,
      nowMs: this.nowMs,
      piHistory: this.piHistory,
    });
    this.agentRoutes = new LocalApiAgentRoutes({
      controller: this.controller,
      ...(this.runtimeConversation
        ? { conversation: this.runtimeConversation }
        : {}),
      agentRuntimePort: this.agentRuntimePort,
      legacyMigrator: this.legacyMigrator,
      runtimeMode: this.runtimeMode,
      agentName: this.agentName,
      agentDisplayName: this.agentDisplayName,
      configGetter: this.configGetter,
      nowMs: this.nowMs,
      resolveDefaultWorkspaceDir: () => this.resolveDefaultWorkspaceDir(),
      getLegacyRuntime: () => this.getLegacyRuntime(),
      getSessionById: (id) => this.getSessionById(id),
      listAllSessions: (a, o) => this.listAllSessions(a, o),
      serializeSessions: (s) => this.serializeSessions(s),
      serializeSessionTree: (s, u, a, g) =>
        this.serializeSessionTree(s, u, a, g),
      serializeSession: (s) => this.serializeSession(s),
      isReadOnlyLegacySession: (s) =>
        isReadOnlyLegacySession(this.legacyMigrator, s),
      markMigratedLegacySessionDeleted: (id) =>
        markMigratedLegacySessionDeleted(this.legacyMigrator, id),
      requestCompaction: (s, b) =>
        requestConversationCompaction(
          this.requireRuntimeConversation("Session compaction"),
          s,
          b,
        ),
      abortLocalSessionTurn: (id) => this.abortLocalSessionTurn(id),
      normalizeCleanLocalSession: (s) => this.normalizeCleanLocalSession(s),
      publishGlobalEvent: (event) => this.publishGlobalEvent(event),
      ...(this.channelCapabilityEnabled
        ? {
            routeAgentIm: (a: string, m: string) =>
              this.channelBridgeInfra.routeAgentIm(a, m),
            getAgentChannelConfig: (a: string) =>
              this.channelBridgeInfra.buildAgentChannelConfig(a),
          }
        : {}),
      resolveLocale: () => resolveLocalRuntimeLocale(),
      metricsReporter: options.metricsReporter,
    });
    this.cronRuntime = buildHostCronRuntime(
      this as unknown as HostCronRuntimeDeps,
      async () =>
        new Response(
          JSON.stringify({ error: "Runtime Conversation is unavailable" }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        ),
      options.metricsReporter,
      this.runtimeConversation ? options.cronConsumerEnabled : false,
      options.startupExecutionPolicy,
    );
    if (this.startupExecutionEnabled && this.cronRuntime.cronConsumerEnabled) {
      void this.cronRuntime.ensureStarted("host_init").catch((err: unknown) => {
        this.emitBusEvent("cron.startup_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (this.startupExecutionEnabled) {
      if (!questionnaireRecoveryDeferred)
        startQuestionnaireRecovery(this, subsys.channelRestoreReady);
      if (!this.runtimeConversation) void this.threadGoalKickoffQueue.recover();
    }
  }
  public supportsInteraction(
    capability: LocalRuntimeInteractionCapability,
  ): boolean {
    return this.capabilities[capability];
  }
  bindPromptSnapshots(source: PromptSnapshotSource | undefined): void {
    this.promptSnapshots = source;
  }
  bindInternalTurnPromptReads(
    registry: InternalTurnPromptReadRegistry | undefined,
  ): void {
    this.internalTurnPromptReads = registry;
  }
  getPromptSnapshots(): PromptSnapshotSource | undefined {
    return this.promptSnapshots;
  }
  getInternalTurnPromptReads(): InternalTurnPromptReadRegistry | undefined {
    return this.internalTurnPromptReads;
  }
  buildOwnerTurnToolSources(
    input: BuildOwnerTurnToolSourcesInput,
  ): Promise<OwnerTurnToolSources> {
    return buildLocalTurnToolSourcesForHost({
      ...input,
      host: this,
      mavisAgentAdapter: createLocalMavisAgentAdapter(this.agentRuntimePort),
      mavisCronAdapter: this.buildOwnerMavisCronAdapter(),
      mavisSessionAdapter: this.buildOwnerMavisSessionAdapter(),
    });
  }
  createHostedAgentCapabilities(): HostedAgentCapabilities {
    return createHostedCapabilities(
      this,
      this.lockOwner.ownerKind,
      this.capabilities.cliEmbedded,
      this.capabilityProfile,
    );
  }
  public beginHostedTurn(input: HostedTurnLifecycleInput): void {
    this.controller.beginTurnTiming(
      input.sessionId,
      input.turnId,
      input.source,
    );
  }
  public checkHostedTurnBudget(input: HostedTurnBudgetCheckInput) {
    return this.threadGoal.checkTurnBudget(input);
  }
  public async settleHostedTurn(
    input: HostedTurnSettlementInput,
  ): Promise<void> {
    this.controller.markTurnTimingSettling(input.sessionId, input.turnId);
    await this.threadGoal.settleInjectedTurn(input);
    this.controller.finishTurnTiming(input.sessionId, input.turnId);
  }
  /**
   * Release the Turn timing frozen for settlement once TurnSystem has spent
   * every settle retry. Without it the session stays `settling` forever, so
   * automatic Goal continuation reads it as busy until a new user Turn or a
   * process restart. Settlement itself must not do this in a `finally`: the
   * first failed attempt is still followed by a retry that needs the timing.
   */
  public abandonHostedTurn(input: HostedTurnLifecycleInput): void {
    this.controller.finishTurnTiming(input.sessionId, input.turnId);
  }
  createHostedChannelCapabilities(): HostedChannelCapabilities {
    return createHostedChannelCapabilities({
      deliverReplyFromMessages: (...args) =>
        this.channelRunner.deliverReplyFromMessages(...args),
      notifyTurnStart: (context) => this.channelRunner.notifyTurnStart(context),
      notifyTurnEnd: (context) => this.channelRunner.notifyTurnEnd(context),
    });
  }
  /**
   * Re-drive a session's queue after one of its blocking dependencies became
   * non-blocking.
   *
   * The queue dispatcher releases a deferred claim with `drainAgain: false`, so
   * a Goal parked behind a gate has nothing that would ever look at it again —
   * which is exactly why a Goal could sit `active` forever while the user
   * watched it "spin". Dispatching is level-triggered on purpose: it re-runs
   * every gate rather than assuming this particular release unblocked anything,
   * so a session with two outstanding tasks simply defers again until the last
   * one lands.
   *
   * Safe to call for any session: with nothing queued the dispatch is a no-op,
   * the dispatcher already coalesces concurrent wakes, and queue claims plus
   * Turn receipts prevent a duplicate Turn.
   */
  private wakeSessionQueueAfterDependencyRelease(sessionId: string): void {
    const conversation = this.runtimeConversation;
    // Unbound during startup reconcile; the Goal kickoff recovery pass that
    // runs after binding re-evaluates those sessions anyway.
    if (!conversation) return;
    void conversation.ingress
      .dispatchQueue(sessionId)
      .catch((error: unknown) => {
        this.reportPiTurnFailure(
          sessionId,
          `thread_goal_dependency_wake_failed:${formatUnknownError(error)}`,
        );
      });
  }

  private async enqueueInjectedThreadGoalContinuation(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly message: LocalMessageInput;
    readonly clientRequestId?: string;
    readonly internalPromptRead?: InternalGoalPromptTurn;
  }): Promise<void> {
    const conversation = this.runtimeConversation;
    if (!conversation) throw new Error("Runtime conversation is not bound");
    try {
      const accepted = await conversation.ingress.submit({
        sessionId: input.sessionId,
        source: "thread-goal",
        allowQueue: true,
        ...(input.internalPromptRead
          ? { requestedTurnId: input.internalPromptRead.requestedTurnId }
          : {}),
        message: {
          ...input.message,
          hideUserMessage: true,
        },
        clientRequestId:
          input.clientRequestId ??
          threadGoalContinuationClientRequestId(input.turnId),
      });
      if (
        input.internalPromptRead &&
        accepted.turnId !== input.internalPromptRead.requestedTurnId
      ) {
        this.threadGoal.rebindInternalPromptRead(
          input.internalPromptRead,
          accepted.turnId,
        );
      }
      if (!accepted.queue) {
        throw new Error(
          `Thread Goal continuation submit did not queue: ${input.sessionId}`,
        );
      }
    } catch (error) {
      if (input.internalPromptRead) {
        this.threadGoal.discardInternalPromptRead(input.internalPromptRead);
      }
      throw error;
    }
  }
  public async listChannelSessionIds(): Promise<string[]> {
    return [
      ...new Set(
        (await this.channelBridgeInfra.bindingStore.list()).map(
          (binding) => binding.sessionId,
        ),
      ),
    ];
  }
  public deleteChannelBindingsForSession(sessionId: string): Promise<number> {
    return this.channelBridgeInfra.bindingStore.deleteBySession(sessionId);
  }
  public deleteQuestionnairesForSession(sessionId: string): Promise<number> {
    return this.questionnaireStore.deleteBySession(sessionId);
  }
  public copyPendingQuestionnaireForFork(
    input: CopyPendingQuestionnaireForForkInput,
  ): Promise<void> {
    return copyPendingQuestionnaire(this.questionnaireStore, input);
  }
  public async deletePermissionStateForSession(
    sessionId: string,
  ): Promise<void> {
    this.abortLocalSessionPermissions(sessionId);
    this.channelPermissionBridge.forgetSession(sessionId);
    await this.permissionRules.deleteSession(sessionId);
  }
  public copyPermissionStateForFork(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
  }): Promise<void> {
    return this.permissionRules.copySession(
      input.sourceSessionId,
      input.targetSessionId,
    );
  }
  public async deleteThreadGoalForSession(sessionId: string): Promise<boolean> {
    const goal = await this.threadGoal.store.getBySession(sessionId);
    if (!goal) return false;
    await this.threadGoal.store.delete(goal.goalId);
    this.threadGoal.handleChanged({
      type: "deleted",
      goalId: goal.goalId,
      sessionId,
    });
    return true;
  }
  public classifyThreadGoalQueuedItem(
    item: ThreadGoalQueueItemIdentity,
    hasPendingPlan?: (sessionId: string) => Promise<boolean>,
  ) {
    return this.threadGoal.classifyQueuedItem(item, hasPendingPlan);
  }
  public prepareThreadGoalTurnAdmission(
    input: Parameters<LocalThreadGoalIntegration["prepareTurnAdmission"]>[0],
  ) {
    return this.threadGoal.prepareTurnAdmission(input);
  }
  public bindThreadGoalAutomationOwnerConflictReader(
    reader: (sessionId: string) => Promise<boolean> | boolean,
  ): void {
    this.threadGoalCronOwnerConflictReader = reader;
  }
  public bindThreadGoalVerifier(
    verifier: Parameters<LocalThreadGoalIntegration["bindVerifier"]>[0],
    transcriptWindowReader: Parameters<
      LocalThreadGoalIntegration["bindVerifier"]
    >[1],
  ): void {
    this.threadGoal.bindVerifier(verifier, transcriptWindowReader);
  }
  /**
   * Runs the Goal verifier child on this host's ordinary foreground delegation
   * path. The caller owns the per-run counter the child's Turn hooks feed, so
   * the two halves stay in the runtime that hosts each of them.
   */
  public createThreadGoalVerifierExecution(registry: GoalVerifierRunRegistry) {
    return createLocalGoalVerifierExecution(this, registry, {
      onChildStarted: (input) =>
        this.threadGoal.recordVerifierChildStarted(input),
    });
  }
  public recoverThreadGoalKickoffs(
    conversation?: RuntimeConversation,
  ): Promise<void> {
    if (!this.startupExecutionEnabled) return Promise.resolve();
    return this.threadGoalKickoffQueue.recover(conversation);
  }
  private buildOwnerMavisCronAdapter() {
    return this.mavisCronAdapterProvider?.();
  }
  /**
   * Mirrors the two conditions `buildLocalTurnToolSourcesForHost` uses to admit
   * `mavisCronAdapter` into a Turn. Kept in sync so reminder guidance never
   * advertises Cron on a host where the tool would answer
   * `CRON_UNSUPPORTED_HOST`.
   */
  private isCronCapabilityAvailable(): boolean {
    if (
      isCliRestrictedRuntime(
        this.lockOwner.ownerKind,
        this.capabilities.cliEmbedded,
      )
    ) {
      return false;
    }
    return this.buildOwnerMavisCronAdapter() !== undefined;
  }
  private isUserMemoryCapabilityAvailable(): boolean {
    return this.lockOwner.ownerKind !== "tui";
  }
  private buildOwnerMavisSessionAdapter() {
    const conversation = this.requireRuntimeConversation(
      "Mavis Session adapter",
    );
    return buildMavisSessionAdapter({
      cloudReader: new CloudSessionReader({
        authContextGetter: this.authContextGetter ?? (() => undefined),
        authContextInvalidator: this.authContextInvalidator,
        routingHeadersGetter: () =>
          managedBackendRoutingHeaders(this.routingContextGetter?.()),
        fetchImpl: this.fetchImpl,
      }),
      conversation,
      listAllSessions: (agentName, options) =>
        this.listAllSessions(agentName, options),
      getSessionById: (sessionId) => this.getSessionById(sessionId),
      serializeSessions: (sessions) => this.serializeSessions(sessions),
      serializeSession: (record) => this.serializeSession(record),
      updateSession: (sessionId, fields) =>
        conversation.lifecycle.updateSession(sessionId, fields),
      deleteSession: (sessionId) =>
        conversation.lifecycle.deleteSession(sessionId),
      deleteMessageState: () => Promise.resolve(),
      deleteQueuedMessages: () => Promise.resolve(),
      markMigratedLegacySessionDeleted: () => Promise.resolve(false),
      clearRootSessionIf: (sessionId) =>
        this.agentRoutes.clearRootSessionIf(sessionId),
      listDisplayMessages: (sessionId, opts) =>
        this.listDisplayMessages(sessionId, opts),
    });
  }
  public async deleteSession(sessionId: string): Promise<void> {
    if (this.runtimeConversation) {
      // Delegate authoritative deletion to the V2 Session lifecycle.
      await this.runtimeConversation.lifecycle.deleteSession(sessionId);
      return;
    }
    await this.controller.deleteSession(sessionId);
  }
  close(): Promise<void> {
    if (!this.closePromise) {
      this.beginShutdown();
      this.closePromise = this.closeResources();
    }
    return this.closePromise;
  }

  beginShutdown(): void {
    if (this.closed) return;
    this.closed = true;
    closeLocalBackgroundTaskDelivery(this);
    beginBackgroundTaskShutdown(this, "runtime-shutdown");
  }

  private async closeResources(): Promise<void> {
    let firstError: unknown;
    const cleanups: Array<() => void | Promise<void>> = [
      () => this.questionnaireAutoReplyScheduler.close(),
      () => this.globalEvents.close(),
      () => drainBackgroundTasks(this),
      () => this.errorReporter?.close(),
    ];
    for (const close of cleanups) {
      try {
        await close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
  public ensureBuiltinAgents(): Promise<void> {
    return this.agentRuntimePort.ensureBuiltinAgents();
  }

  /** Narrow greeting transport reused by V2 AgentApplication; V1 remains only the sender. */
  public sendGreetingSystemReminder(
    input: Parameters<
      LocalGreetingSystemReminderSender["sendSystemReminder"]
    >[0],
  ): ReturnType<LocalGreetingSystemReminderSender["sendSystemReminder"]> {
    return this.greetingSystemReminderSender.sendSystemReminder(input);
  }
  public deleteAgentCronTasks(agentName: string): Promise<void> {
    return this.deleteAgentCronTasksOverride
      ? this.deleteAgentCronTasksOverride(agentName)
      : this.cronRuntime.deleteAgentTasks(agentName);
  }

  /** Whitelisted config write access for the DesktopService wiring. */
  public updateConfig(body: Record<string, unknown>): Promise<unknown> {
    return this.configUpdater(body);
  }

  /** Applies the process-local permission mode and preserves acceptEdits rule seeding. */
  public async setProcessLocalPermissionMode(
    mode: NonNullable<LocalRuntimeConfig["permissionMode"]>,
  ): Promise<LocalRuntimeConfig["permissionMode"]> {
    const { config } = await this.configUpdater({
      field: "permissionMode",
      set: mode,
    });
    if (mode === "acceptEdits") {
      await resolveLocalPermissionService(
        this as unknown as PermHostHandle,
      ).syncAcceptEditsSeed();
    }
    return config.permissionMode;
  }

  /** Redacted process-local diagnostics owned by this concrete Runtime host. */
  public getProcessLocalRuntimeDiagnostics(): Record<string, unknown> {
    return buildRuntimeDoctorSnapshot({
      config: this.configGetter(),
      authContext: this.authContextGetter?.(),
      runtimeMode: this.runtimeMode,
      runtimeOwnerKind: this.lockOwner.ownerKind,
      runtimeOwnerId: this.lockOwner.ownerId,
      runtimeStartupToken: this.runtimeStartupToken,
      capabilities: this.capabilities as unknown as Record<string, unknown>,
      surfaces: this.surfaces as unknown as Record<string, unknown>,
      hostDiagnosticsAvailable: Boolean(this.hostDiagnosticsProvider),
    });
  }

  /** Redacted account/model status for process-local product surfaces. */
  public async getProcessLocalAccountStatus(
    sessionId?: string,
    model?: string,
  ): Promise<Record<string, unknown>> {
    const baseConfig = this.configGetter();
    const session = sessionId
      ? await this.getSessionById(sessionId)
      : undefined;
    const effectiveModel = model ?? session?.effectiveModel;
    const config = effectiveModel
      ? { ...baseConfig, defaultModel: effectiveModel }
      : baseConfig;
    const authContext = this.authContextGetter?.();
    const doctor = buildRuntimeDoctorSnapshot({
      config,
      authContext,
      runtimeMode: this.runtimeMode,
      runtimeOwnerKind: this.lockOwner.ownerKind,
      runtimeOwnerId: this.lockOwner.ownerId,
      runtimeStartupToken: this.runtimeStartupToken,
      capabilities: this.capabilities as unknown as Record<string, unknown>,
      surfaces: this.surfaces as unknown as Record<string, unknown>,
      hostDiagnosticsAvailable: Boolean(this.hostDiagnosticsProvider),
    });
    return {
      ...doctor,
    };
  }

  public retryBuiltinGreetings(): Promise<void> {
    return this.agentRuntimePort.retryBuiltinGreetings();
  }
  public permissionRouteContext(): LocalPermissionRouteContext {
    return buildPermissionRouteContext(
      this as unknown as RouteContextHostHandle,
    );
  }
  public questionnaireServiceDeps(): LocalQuestionnaireServiceDeps {
    return buildQuestionnaireServiceDeps(
      this as unknown as RouteContextHostHandle,
    );
  }
  public readonly bindQuestionnaireOwnedActionHandler =
    createQuestionnaireOwnedActionBinder(this);
  public readonly bindQuestionnaireRequestAdmission =
    createQuestionnaireRequestAdmissionBinder(this);
  private readonly deliverQuestionnaireAskToChannel = (
    record: QuestionnaireRequestRecord,
  ) =>
    deliverQuestionnaireAskToChannelHelper(
      this as unknown as QuestionnaireDeliveryHostHandle,
      record,
    );

  /**
   * Run the channel subsystem startup once: legacy IM credential import →
   * ordered pre-restore steps → exactly one `restoreInboundLoops()`.
   *
   * Idempotent — concurrent and repeat callers await the first execution, so a
   * host never imports twice or restores twice. With
   * `deferChannelStartup: false` (default) the constructor already triggered
   * it and this returns that same promise; Local Runtime V2 defers and calls it
   * explicitly once Session, Agent and Conversation services are ready.
   * A rejection is a startup failure and must fail the owner's startup rather
   * than degrade into two live transports.
   */
  startChannelSubsystem(): Promise<void> {
    return this.channelSubsystemStartup();
  }
  async shutdownChannelSubsystem(): Promise<void> {
    await shutdownChannelSubsystemHelper(
      this as unknown as ChannelShutdownHostHandle,
    );
  }

  private rejectRetiredConversation(operation: string): never {
    throw new Error(
      `Local Runtime V1 Conversation is unavailable: ${operation}`,
    );
  }

  private requireRuntimeConversation(operation: string): RuntimeConversation {
    if (!this.runtimeConversation) {
      return this.rejectRetiredConversation(operation);
    }
    return this.runtimeConversation;
  }

  private isLegacyRuntimeEnabled(): boolean {
    return legacyRuntimeEnabledForMode(
      this.runtimeMode,
      this.legacyOpencodeEnabled,
    );
  }

  public getRuntimeOwnerKind(): string {
    return this.lockOwner.ownerKind;
  }
  public subscribeGlobalEvents(subscriber: GlobalEventSubscriber): () => void {
    return this.globalEvents.subscribe(subscriber);
  }
  public publishGlobalEvent(event: GlobalEventInput): void {
    if (this.closed) return;
    this.globalEventPublisher(event);
  }
  public emitBusEvent(type: string, payload: Record<string, unknown>): void {
    void handleMemoryBusEvent({
      type,
      payload,
      memoryFacade: this.memoryFacade,
      emitBusEvent: (eventType, eventPayload) =>
        this.emitBusEvent(eventType, eventPayload),
    });
  }

  public async getSessionById(
    sessionId: string,
  ): Promise<LocalSessionRecord | undefined> {
    return this.requireRuntimeConversation("Session lookup").query.getSession(
      sessionId,
    );
  }
  public async isReadOnlyLegacySession(sessionId: string): Promise<boolean> {
    const session = await this.getSessionById(sessionId);
    return isReadOnlyLegacySession(this.legacyMigrator, session ?? sessionId);
  }
  private async dispatchLocalTeamTask(
    input: LocalTeamTaskDispatchInput,
  ): Promise<LocalTeamTaskDispatchResult> {
    const conversation = this.requireRuntimeConversation("Team task dispatch");
    return dispatchLocalTeamTask({
      task: input,
      teamDefaultModelConfigId:
        this.configGetter().agents?.default.modelConfigId,
      resolveAgentName: (requestedAgent, fallbackAgentName) =>
        this.resolveLocalTeamTaskAgentName(requestedAgent, fallbackAgentName),
      createSession: (sessionInput) =>
        this.agentRoutes.createSession(sessionInput),
      resolveDefaultWorkspaceDir: () => this.resolveDefaultWorkspaceDir(),
      enqueue: async (session, body) => {
        const accepted = await conversation.ingress.submit({
          sessionId: session.sessionId,
          source: "team",
          allowQueue: true,
          message: { ...body, attachments: [] },
        });
        return accepted.queue ? { itemId: accepted.queue.itemId } : undefined;
      },
    });
  }
  private async resolveLocalTeamTaskAgentName(
    requestedAgent: string | undefined,
    fallbackAgentName: string,
  ): Promise<string> {
    return resolveLocalTeamTaskAgentName({
      requestedAgent,
      fallbackAgentName,
      primaryAgentName: this.agentName,
      primaryAgentDisplayName: this.agentDisplayName,
      listLocalAgents: () => this.agentRoutes.listLocalAgents(),
    });
  }
  private async cancelLocalTeamTask(
    input: LocalTeamTaskCancelInput,
  ): Promise<LocalTeamTaskCancelResult> {
    const conversation = this.requireRuntimeConversation(
      "Team task cancellation",
    );
    const queueCancelled = input.queueItemId
      ? Boolean(
          await conversation.ingress.cancelQueued(
            input.sessionId,
            input.queueItemId,
          ),
        )
      : false;
    const turnAborted = await conversation.ingress.abort(
      input.sessionId,
      "lifecycle",
    );
    return { sessionId: input.sessionId, queueCancelled, turnAborted };
  }
  public async listAllSessions(
    agentName?: string,
    options?: LocalSessionListOptions,
  ): Promise<LocalSessionRecord[]> {
    return this.requireRuntimeConversation(
      "Session listing",
    ).query.listSessions({
      ...(options ?? {}),
      ...(agentName ? { agentName } : {}),
    });
  }
  private async normalizeCleanLocalSession(
    session: LocalSessionRecord,
  ): Promise<LocalSessionRecord | undefined> {
    return hostNormalizeCleanLocalSession(
      this as unknown as SessionStateHostHandle,
      session,
    );
  }
  private getLegacyRuntime(): LegacyHistoryReader {
    if (!this.isLegacyRuntimeEnabled()) {
      throw new Error(
        "Legacy opencode runtime is disabled in clean local-runtime mode",
      );
    }
    if (!this.legacyRuntime) {
      this.legacyRuntime = new LegacyHistoryReader({
        dataDir: this.configGetter().dataDir,
      });
    }
    return this.legacyRuntime;
  }
  public resolveDefaultWorkspaceDir(): string {
    return resolveDefaultLocalWorkspaceDir(
      this.defaultWorkspaceDir,
      this.configGetter(),
    );
  }
  public resolveSessionDefaultWorkspaceDir(sessionId: string): string {
    return join(
      this.configGetter().dataDir,
      "sessions",
      sessionId,
      "workspace",
    );
  }
  private async serializeSessions(
    sessions: LocalSessionRecord[],
  ): Promise<Array<Record<string, unknown>>> {
    return hostSerializeSessions(
      this as unknown as SessionStateHostHandle,
      sessions,
    );
  }
  private async serializeSessionTree(
    sessions: LocalSessionRecord[],
    url: URL,
    agentName: string,
    getSessionById: (
      sessionId: string,
    ) => Promise<LocalSessionRecord | undefined> = (sessionId) =>
      this.getSessionById(sessionId),
  ): Promise<Array<Record<string, unknown>>> {
    return hostSerializeSessionTree(
      this as unknown as SessionStateHostHandle,
      sessions,
      url,
      agentName,
      getSessionById,
    );
  }
  private async serializeSession(
    session: LocalSessionRecord,
  ): Promise<Record<string, unknown>> {
    return hostSerializeSession(
      this as unknown as SessionStateHostHandle,
      session,
    );
  }
  private abortLocalSessionPermissions(sessionId: string): void {
    abortLocalPermissionRequests(this.permissionRouteContext(), sessionId);
  }
  private abortLocalSessionTurn(sessionId: string): void {
    void this.requireRuntimeConversation("Session abort")
      .ingress.abort(sessionId, "lifecycle")
      .catch(() => undefined);
    this.abortLocalSessionPermissions(sessionId);
  }
  private async getDisplayMessages(sessionId: string): Promise<AgentMessage[]> {
    const page = await this.requireRuntimeConversation(
      "Session messages",
    ).query.listMessages(sessionId, {
      limit: 10_000,
    });
    return toAgentMessages(page.messages);
  }
  private async listDisplayMessages(
    sessionId: string,
    opts?: { limit?: number; before?: string },
  ) {
    const page = await this.requireRuntimeConversation(
      "Session messages",
    ).query.listMessages(sessionId, opts);
    return {
      messages: toAgentMessages(page.messages),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
  public getPiHistory(sessionId: string): Promise<PiAgentMessage[]> {
    return this.piHistoryStore.getPiHistory(sessionId);
  }
  public async ensureLegacyPiHistoryMigrated(sessionId: string): Promise<void> {
    await this.legacyMigrator?.ensurePiHistoryMigrated(sessionId);
  }
  public reportPiTurnFailure(sessionId: string, message: string): void {
    this.telemetry?.({
      runtime: "pi-agent",
      sessionId,
      phase: "failure",
      message,
    });
  }
}

function isChannelCapabilityRoute(parts: readonly string[]): boolean {
  if (
    parts[0] === "channel-bridge" ||
    parts[0] === "im-bridge" ||
    parts[0] === "channel-route" ||
    (parts[0] === "channel" && parts[1] === "connections")
  ) {
    return true;
  }
  if (parts[0] === "lark" && parts[1] === "onboard") return true;
  return parts[0] === "agent" && parts[2] === "im";
}
