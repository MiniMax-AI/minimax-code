import type {
  AbortSessionReq,
  CliSendMessageReq,
  CliSendMessageOptions,
  CliService,
  ConversationSteerInput,
  ConversationSteerResult,
} from "@mavis/local-runtime-v2/cli-service";
import { MINIMAX_CODE_DEFAULT_AGENT_NAME } from "../product-context.js";
import { TuiEventAccess } from "./adapters/event-access.js";
import { TuiRuntimeAccessContext } from "./adapters/access-context.js";
import { TuiWorkspaceAccess } from "./adapters/workspace-access.js";
import { TuiSessionAccess } from "./adapters/session-access.js";
import { TuiProductAccess } from "./adapters/product-access.js";
import { TuiInteractionAccess } from "./adapters/interaction-access.js";
import { TuiDelegationAccess } from "./adapters/delegation-access.js";
import { TuiConversationAccess } from "./adapters/conversation-access.js";
import { TuiPluginAccess } from "./adapters/plugin-access.js";
import { TuiGoalAccess } from "./adapters/goal-access.js";
import type { TuiMessage, TuiStreamEvent } from "./stream-events.js";
import type {
  CreateTuiSessionInput,
  EnqueueTuiMessageOptions,
  ForkTuiSessionInput,
  ListTuiSessionPageInput,
  ListTuiSessionsOptions,
  TuiAccountStatus,
  TuiAccountStatusOptions,
  TuiActiveRunSnapshot,
  TuiBackgroundTask,
  TuiCompactionResult,
  TuiDelegationSnapshot,
  TuiDelegationStopReceipt,
  TuiFeedbackPreview,
  TuiFeedbackSubmitOptions,
  TuiFeedbackReceipt,
  TuiEditMessageInput,
  TuiEditMessageResult,
  TuiInstructionSource,
  TuiMcpServer,
  TuiProjectMcpPreview,
  TuiMessagePage,
  TuiMessagePageInput,
  TuiModel,
  TuiModelSelection,
  TuiPendingPermission,
  TuiPermissionDecision,
  TuiQuestionnaireReplyAnswer,
  TuiQuestionnaireRequest,
  TuiQueueReceipt,
  TuiQueuedMessage,
  TuiQueueSnapshot,
  TuiRewindInput,
  TuiRewindPreview,
  TuiRewindResult,
  TuiRuntimeDiagnostics,
  TuiRuntimeEvent,
  TuiSession,
  TuiSessionForkOptions,
  TuiSessionForkResult,
  TuiSessionInputSummary,
  TuiSessionMcpServer,
  TuiSessionPage,
  TuiSessionUsage,
  TuiSkillList,
  TuiRuntime,
  TuiWorkspaceFileCandidate,
  TuiWorkspaceFileEntry,
  TuiWorkspaceGitMetadata,
  TuiWorkspaceRoot,
  TuiWorkspaceTreeCandidate,
  WatchTuiSessionTurnOptions,
} from "./port.js";
import type { TuiPermissionMode } from "../application/permission-mode.js";
import { resolveTuiEffortChoice } from "../application/model-effort.js";
import type { TuiObservability } from "../observability/index.js";
import type { TuiTokenPlanAccountStatus } from "../account/matrix-account-client.js";
import type { TuiDailyCheckinOutcome } from "../checkin/application.js";

export * from "./port.js";

export interface TuiRuntimeAdapterOptions {
  createQueueRequestId?: () => string;
  defaultAgentName?: string;
  onSessionDeleted?: (sessionId: string) => void | Promise<void>;
  workspaceDir?: string;
  synchronizeAuth?: () => Promise<void>;
  accountIdentityGetter?: () => TuiAccountStatus["identity"];
  observability?: TuiObservability;
  tokenPlanAccountStatusGetter?: (options?: {
    readonly forceRefresh?: boolean;
  }) => Promise<TuiTokenPlanAccountStatus>;
  feedback?: {
    prepare(input: {
      readonly description: string;
      readonly sessionId?: string;
    }): TuiFeedbackPreview | Promise<TuiFeedbackPreview>;
    submit(
      draftId: string,
      options?: TuiFeedbackSubmitOptions,
    ): Promise<TuiFeedbackReceipt>;
    cancel(draftId: string): boolean | Promise<boolean>;
  };
  dailyCheckin?: {
    run(): Promise<TuiDailyCheckinOutcome>;
  };
}

export class TuiRuntimeAdapter implements TuiRuntime {
  private readonly cliService: CliService;
  private readonly context: TuiRuntimeAccessContext;
  private readonly workspaceAccess: TuiWorkspaceAccess;
  private readonly sessionAccess: TuiSessionAccess;
  private readonly productAccess: TuiProductAccess;
  private readonly interactionAccess: TuiInteractionAccess;
  private readonly eventAccess: TuiEventAccess;
  private readonly delegationAccess: TuiDelegationAccess;
  private readonly conversationAccess: TuiConversationAccess;
  private readonly pluginAccess: TuiPluginAccess;
  private readonly goalAccess: TuiGoalAccess;
  private readonly tokenPlanAccountStatusGetter:
    | ((options?: {
        readonly forceRefresh?: boolean;
      }) => Promise<TuiTokenPlanAccountStatus>)
    | undefined;
  private readonly synchronizeAuth: TuiRuntimeAdapterOptions["synchronizeAuth"];
  private readonly accountIdentityGetter: TuiRuntimeAdapterOptions["accountIdentityGetter"];
  private readonly feedback: TuiRuntimeAdapterOptions["feedback"];
  private readonly dailyCheckin: TuiRuntimeAdapterOptions["dailyCheckin"];

  constructor(cliService: CliService, options: TuiRuntimeAdapterOptions = {}) {
    this.cliService = cliService;
    const defaultAgentName =
      options.defaultAgentName ?? MINIMAX_CODE_DEFAULT_AGENT_NAME;
    this.tokenPlanAccountStatusGetter = options.tokenPlanAccountStatusGetter;
    this.synchronizeAuth = options.synchronizeAuth;
    this.accountIdentityGetter = options.accountIdentityGetter;
    this.feedback = options.feedback;
    this.dailyCheckin = options.dailyCheckin;
    this.conversationAccess = new TuiConversationAccess(cliService);
    this.pluginAccess = new TuiPluginAccess(cliService);
    this.context = new TuiRuntimeAccessContext({
      cliService,
      ...(options.observability
        ? { observability: options.observability }
        : {}),
    });
    this.goalAccess = new TuiGoalAccess(this.context);
    this.workspaceAccess = new TuiWorkspaceAccess(this.context);
    this.sessionAccess = new TuiSessionAccess(
      cliService,
      defaultAgentName,
      options.onSessionDeleted,
    );
    this.productAccess = new TuiProductAccess(
      this.context,
      defaultAgentName,
      options.workspaceDir,
    );
    this.interactionAccess = new TuiInteractionAccess(
      options.createQueueRequestId ?? createTuiQueueRequestId,
      cliService,
    );
    this.eventAccess = new TuiEventAccess(cliService, options.observability);
    this.delegationAccess = new TuiDelegationAccess({
      listSessionPage: (input) => this.sessionAccess.listSessionPage(input),
      abortSession: (req) => this.abortSession(req),
    });
  }

  sendMessage(
    req: CliSendMessageReq,
    signal?: AbortSignal,
    options?: CliSendMessageOptions,
  ): AsyncGenerator<TuiStreamEvent> {
    return this.conversationAccess.sendMessage(req, signal, options);
  }

  abortSession(req: AbortSessionReq): Promise<boolean> {
    return this.conversationAccess.abortSession(req);
  }

  steer(input: ConversationSteerInput): Promise<ConversationSteerResult> {
    return this.conversationAccess.steer(input);
  }

  async createSession(input: CreateTuiSessionInput): Promise<TuiSession> {
    const defaultModel = await this.productAccess
      .listModels()
      .then((models) => models.find((model) => model.selected === true))
      .catch(() => undefined);
    if (!defaultModel) return this.sessionAccess.createSession(input);
    // Inherit Runtime's saved global selection before catalog defaults, using
    // the same rule as the status line and without changing existing Sessions.
    const effort = resolveTuiEffortChoice(defaultModel)?.trim();
    return this.sessionAccess.createSession(input, {
      providerId: defaultModel.providerId,
      modelId: defaultModel.modelId,
      ...(defaultModel.variant !== undefined
        ? { variant: defaultModel.variant }
        : {}),
      ...(defaultModel.contextLimit !== undefined
        ? { contextLimit: defaultModel.contextLimit }
        : {}),
      ...(effort ? { thinking: { effort } } : {}),
    });
  }
  configureSessionMcpServers(
    sessionId: string,
    servers: readonly TuiSessionMcpServer[],
  ): Promise<void> {
    return this.sessionAccess.configureSessionMcpServers(sessionId, servers);
  }
  clearSessionMcpServers(sessionId: string): Promise<void> {
    return this.sessionAccess.clearSessionMcpServers(sessionId);
  }
  listSessions(
    agentName?: string,
    options?: ListTuiSessionsOptions,
  ): Promise<TuiSession[]> {
    return this.sessionAccess.listSessions(agentName, options);
  }
  listSessionPage(
    input?: ListTuiSessionPageInput | string,
    options?: ListTuiSessionsOptions,
  ): Promise<TuiSessionPage> {
    return this.sessionAccess.listSessionPage(input, options);
  }
  getSession(sessionId: string): Promise<TuiSession> {
    return this.sessionAccess.getSession(sessionId);
  }
  getMessages(sessionId: string, limit?: number): Promise<TuiMessage[]> {
    return this.sessionAccess.getMessages(sessionId, limit);
  }
  listMessagePage(
    sessionId: string,
    input?: TuiMessagePageInput,
  ): Promise<TuiMessagePage> {
    return this.sessionAccess.listMessagePage(sessionId, input);
  }
  getSessionForkOptions(
    sessionId: string,
    assistantMessageId?: string,
  ): Promise<TuiSessionForkOptions> {
    return this.sessionAccess.getSessionForkOptions(
      sessionId,
      assistantMessageId,
    );
  }
  forkSession(input: ForkTuiSessionInput): Promise<TuiSessionForkResult> {
    return this.sessionAccess.forkSession(input);
  }
  renameSession(sessionId: string, title: string): Promise<TuiSession> {
    return this.sessionAccess.renameSession(sessionId, title);
  }
  archiveSession(sessionId: string, archived: boolean): Promise<void> {
    return this.sessionAccess.archiveSession(sessionId, archived);
  }
  deleteSession(sessionId: string): Promise<void> {
    return this.sessionAccess.deleteSession(sessionId);
  }
  listSessionInputSummaries(
    sessionId: string,
    input?: { limit?: number; before?: string },
  ): Promise<readonly TuiSessionInputSummary[]> {
    return this.sessionAccess.listSessionInputSummaries(sessionId, input);
  }
  getSessionRewindPreview(input: {
    sessionId: string;
    userMessageId: string;
  }): Promise<TuiRewindPreview> {
    return this.sessionAccess.getSessionRewindPreview(input);
  }
  rewindSession(input: TuiRewindInput): Promise<TuiRewindResult> {
    return this.sessionAccess.rewindSession(input);
  }
  editSessionMessage(
    input: TuiEditMessageInput,
  ): Promise<TuiEditMessageResult> {
    return this.sessionAccess.editSessionMessage(input);
  }
  isGoalEnabled(): boolean {
    return this.goalAccess.isEnabled();
  }
  getGoal(sessionId: string) {
    return this.goalAccess.get(sessionId);
  }
  createGoal(input: Parameters<TuiGoalAccess["create"]>[0]) {
    return this.goalAccess.create(input);
  }
  patchGoal(sessionId: string, patch: Parameters<TuiGoalAccess["patch"]>[1]) {
    return this.goalAccess.patch(sessionId, patch);
  }
  clearGoal(sessionId: string): Promise<boolean> {
    return this.goalAccess.clear(sessionId);
  }
  getWorkspaceGitMetadata(
    workspaceDir: string,
  ): Promise<TuiWorkspaceGitMetadata> {
    return this.workspaceAccess.getWorkspaceGitMetadata(workspaceDir);
  }
  listWorkspaceFileTree(
    workspaceDir: string,
    path?: string,
    signal?: AbortSignal,
  ): Promise<TuiWorkspaceFileEntry[]> {
    return this.workspaceAccess.listWorkspaceFileTree(
      workspaceDir,
      path,
      signal,
    );
  }
  searchWorkspaceFiles(
    workspaceDir: string,
    query: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return this.workspaceAccess.searchWorkspaceFiles(
      workspaceDir,
      query,
      limit,
      signal,
    );
  }
  listWorkspaceFileTreeCandidates(
    request: { roots: readonly TuiWorkspaceRoot[]; path?: string },
    signal?: AbortSignal,
  ): Promise<TuiWorkspaceTreeCandidate[]> {
    return this.workspaceAccess.listWorkspaceFileTreeCandidates(
      request,
      signal,
    );
  }
  searchWorkspaceFileCandidates(
    request: {
      roots: readonly TuiWorkspaceRoot[];
      query: string;
      limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<TuiWorkspaceFileCandidate[]> {
    return this.workspaceAccess.searchWorkspaceFileCandidates(request, signal);
  }
  async getAccountStatus(
    sessionId?: string,
    options?: TuiAccountStatusOptions,
  ): Promise<TuiAccountStatus> {
    let account = await this.productAccess.getAccountStatus(sessionId, options);
    const usesManagedAuth = account.modelSource
      ? account.modelSource === "token-plan"
      : account.authMode === "managed-login";
    if (
      this.synchronizeAuth &&
      (usesManagedAuth || options?.requireManagedAuth)
    ) {
      await this.synchronizeAuth();
      account = await this.productAccess.getAccountStatus(sessionId, options);
    }
    const identity = account.managedTokenPresent
      ? this.accountIdentityGetter?.()
      : undefined;
    if (identity)
      account = {
        ...account,
        identity: { email: identity.email, name: identity.name },
      };
    const membershipRequested = options?.includeMembership !== false;
    const explicitUsageInspection = options?.includeMembership === true;
    if (
      !membershipRequested ||
      (!explicitUsageInspection &&
        (account.modelSource !== "token-plan" ||
          account.managedTokenPresent !== true)) ||
      !this.tokenPlanAccountStatusGetter
    ) {
      return account;
    }
    const tokenPlan = await (
      options?.forceRefresh
        ? this.tokenPlanAccountStatusGetter({ forceRefresh: true })
        : this.tokenPlanAccountStatusGetter()
    ).catch(() => undefined);
    if (!tokenPlan) return account;
    return {
      ...account,
      ...(tokenPlan.quotaState
        ? { tokenPlanQuotaState: tokenPlan.quotaState }
        : {}),
      ...(tokenPlan.quota ? { tokenPlanQuota: tokenPlan.quota } : {}),
      ...(explicitUsageInspection && tokenPlan.summary
        ? { tokenPlanSummary: tokenPlan.summary }
        : {}),
    };
  }
  getRuntimeDiagnostics(): Promise<TuiRuntimeDiagnostics> {
    return this.productAccess.getRuntimeDiagnostics();
  }

  getInstructionSources(
    workspaceDir: string,
  ): Promise<readonly TuiInstructionSource[]> {
    return this.productAccess.getInstructionSources(workspaceDir);
  }
  async prepareFeedback(input: {
    description: string;
    sessionId?: string;
  }): Promise<TuiFeedbackPreview> {
    if (!this.feedback)
      throw new Error("MiniMax Code feedback is unavailable.");
    return this.feedback.prepare(input);
  }
  submitFeedback(
    draftId: string,
    options?: TuiFeedbackSubmitOptions,
  ): Promise<TuiFeedbackReceipt> {
    if (!this.feedback)
      return Promise.reject(new Error("MiniMax Code feedback is unavailable."));
    return this.feedback.submit(draftId, options);
  }
  cancelFeedback(draftId: string): Promise<boolean> {
    if (!this.feedback) return Promise.resolve(false);
    return Promise.resolve(this.feedback.cancel(draftId));
  }
  runDailyCheckin(): Promise<TuiDailyCheckinOutcome> {
    if (!this.dailyCheckin) {
      return Promise.reject(new Error("Daily check-in is unavailable."));
    }
    return this.dailyCheckin.run();
  }
  getPermissionMode(): Promise<TuiPermissionMode | undefined> {
    return this.productAccess.getPermissionMode();
  }
  setPermissionMode(mode: TuiPermissionMode): Promise<TuiPermissionMode> {
    return this.productAccess.setPermissionMode(mode);
  }
  listModels(sessionId?: string): Promise<TuiModel[]> {
    return this.productAccess.listModels(sessionId);
  }
  selectModel(model: TuiModelSelection, sessionId?: string): Promise<boolean> {
    return this.productAccess.selectModel(model, sessionId);
  }
  selectSessionModel(
    model: TuiModelSelection,
    sessionId: string,
  ): Promise<boolean> {
    return this.productAccess.selectSessionModel(model, sessionId);
  }
  setModelFavorite(model: TuiModelSelection, favorite: boolean): Promise<boolean> {
    return this.productAccess.setModelFavorite(model, favorite);
  }
  listUserModelProviders() {
    return this.productAccess.listUserModelProviders();
  }
  listProviderPresets() {
    return this.productAccess.listProviderPresets();
  }
  getCodexOAuthStatus() {
    return this.productAccess.getCodexOAuthStatus();
  }
  startCodexOAuthLogin(
    options?: Parameters<TuiProductAccess["startCodexOAuthLogin"]>[0],
  ) {
    return this.productAccess.startCodexOAuthLogin(options);
  }
  cancelCodexOAuthLogin(loginId: string) {
    return this.productAccess.cancelCodexOAuthLogin(loginId);
  }
  getMiniMaxApiKeyStatus() {
    return this.productAccess.getMiniMaxApiKeyStatus();
  }
  getMiniMaxModelSource() {
    return this.productAccess.getMiniMaxModelSource();
  }
  setMiniMaxModelSource(
    source: import("../provider/contract.js").McodeMiniMaxModelSource,
  ) {
    return this.productAccess.setMiniMaxModelSource(source);
  }
  upsertMiniMaxApiKey(input: { apiKey: string; saveAndUse?: boolean }) {
    return this.productAccess.upsertMiniMaxApiKey(input);
  }
  createUserModelProvider(
    input: import("../provider/contract.js").McodeCreateProviderInput,
  ) {
    return this.productAccess.createUserModelProvider(input);
  }
  discoverUserModelsCandidate(
    input: import("../provider/contract.js").McodeDiscoverProviderModelsInput,
  ) {
    return this.productAccess.discoverUserModelsCandidate(input);
  }
  saveUserModelProviderCandidate(
    input: import("../provider/contract.js").McodeSaveProviderCandidateInput,
  ) {
    return this.productAccess.saveUserModelProviderCandidate(input);
  }
  updateUserModelProvider(
    input: import("../provider/contract.js").McodeUpdateProviderInput,
  ) {
    return this.productAccess.updateUserModelProvider(input);
  }
  deleteUserModelProvider(providerId: string) {
    return this.productAccess.deleteUserModelProvider(providerId);
  }
  testUserModelProvider(providerId: string) {
    return this.productAccess.testUserModelProvider(providerId);
  }
  testUserModel(providerId: string, modelId: string) {
    return this.productAccess.testUserModel(providerId, modelId);
  }
  getSessionUsage(sessionId: string): Promise<TuiSessionUsage> {
    return this.productAccess.getSessionUsage(sessionId);
  }
  getSessionUsageSummary(sessionId: string) {
    return this.productAccess.getSessionUsageSummary(sessionId);
  }
  watchSessionUsageCommits(signal: AbortSignal): AsyncGenerator<string> {
    return this.eventAccess.watchSessionUsageCommits(signal);
  }
  requestCompaction(
    sessionId: string,
    agentName?: string,
    customInstructions?: string,
  ): Promise<TuiCompactionResult> {
    return this.productAccess.requestCompaction(
      sessionId,
      agentName,
      customInstructions,
    );
  }
  getContextSnapshot(sessionId: string) {
    return this.productAccess.getContextSnapshot(sessionId);
  }
  getActiveRun(sessionId: string): Promise<TuiActiveRunSnapshot> {
    return this.productAccess.getActiveRun(sessionId);
  }
  listSkills(
    agentName?: string,
    keyword?: string,
    workspaceDir?: string,
  ): Promise<TuiSkillList> {
    return this.productAccess.listSkills(agentName, keyword, workspaceDir);
  }
  inspectProjectMcp(
    sessionId: string,
  ): Promise<TuiProjectMcpPreview | undefined> {
    return this.productAccess.inspectProjectMcp(sessionId);
  }
  listMcpServers(
    keyword?: string,
    sessionId?: string,
  ): Promise<TuiMcpServer[]> {
    return this.productAccess.listMcpServers(keyword, sessionId);
  }
  listInstalledPlugins(
    input?: Parameters<TuiPluginAccess["listInstalledPlugins"]>[0],
  ) {
    return this.pluginAccess.listInstalledPlugins(input);
  }
  listMarketplacePlugins(
    input: Parameters<TuiPluginAccess["listMarketplacePlugins"]>[0],
  ) {
    return this.pluginAccess.listMarketplacePlugins(input);
  }
  mutatePlugin(input: Parameters<TuiPluginAccess["mutatePlugin"]>[0]) {
    return this.pluginAccess.mutatePlugin(input);
  }
  refreshPlugins(): Promise<void> {
    return this.pluginAccess.refreshPlugins();
  }

  listQueuedMessages(sessionId: string): Promise<TuiQueuedMessage[]> {
    return this.interactionAccess.listQueuedMessages(sessionId);
  }
  getQueueSnapshot(sessionId: string): Promise<TuiQueueSnapshot> {
    return this.interactionAccess.getQueueSnapshot(sessionId);
  }
  continueQueue(sessionId: string): Promise<void> {
    return this.interactionAccess.continueQueue(sessionId);
  }
  steerQueuedMessage(
    sessionId: string,
    itemId: string,
  ): Promise<{ queueItemId: string; turnId: string }> {
    return this.interactionAccess.steerQueuedMessage(sessionId, itemId);
  }
  enqueueMessage(
    sessionId: string,
    content: string,
    options?: EnqueueTuiMessageOptions,
  ): Promise<TuiQueueReceipt> {
    return this.interactionAccess.enqueueMessage(sessionId, content, options);
  }
  updateQueuedMessageContent(
    sessionId: string,
    itemId: string,
    content: string,
  ): Promise<TuiQueuedMessage | undefined> {
    return this.interactionAccess.updateQueuedMessageContent(
      sessionId,
      itemId,
      content,
    );
  }
  deleteQueuedMessage(
    sessionId: string,
    itemId: string,
  ): Promise<TuiQueuedMessage | undefined> {
    return this.interactionAccess.deleteQueuedMessage(sessionId, itemId);
  }
  getPendingQuestionnaire(
    agentName: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<TuiQuestionnaireRequest | undefined> {
    return this.interactionAccess.getPendingQuestionnaire(
      agentName,
      sessionId,
      signal,
    );
  }

  getLatestPlanReview(
    agentName: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<TuiQuestionnaireRequest | undefined> {
    return this.interactionAccess.getLatestPlanReview(
      agentName,
      sessionId,
      signal,
    );
  }

  getPlanModeCapabilities(): Promise<{ readonly entryEnabled: boolean }> {
    return this.interactionAccess.getPlanModeCapabilities();
  }
  replyQuestionnaire(
    agentName: string,
    requestId: string,
    answers: TuiQuestionnaireReplyAnswer[],
  ): Promise<boolean> {
    return this.interactionAccess.replyQuestionnaire(
      agentName,
      requestId,
      answers,
    );
  }
  dismissQuestionnaire(agentName: string, requestId: string): Promise<boolean> {
    return this.interactionAccess.dismissQuestionnaire(agentName, requestId);
  }
  listPendingPermissions(
    signal?: AbortSignal,
  ): Promise<TuiPendingPermission[]> {
    return this.interactionAccess.listPendingPermissions(signal);
  }
  replyPermission(
    agentName: string,
    requestId: string,
    decision: TuiPermissionDecision,
  ): Promise<boolean> {
    return this.interactionAccess.replyPermission(
      agentName,
      requestId,
      decision,
    );
  }

  watchEvents(signal: AbortSignal): AsyncGenerator<TuiRuntimeEvent> {
    return this.eventAccess.watch(signal);
  }
  watchSessionTurn(
    sessionId: string,
    turnId: string,
    signal: AbortSignal,
    options?: WatchTuiSessionTurnOptions,
  ): AsyncGenerator<TuiStreamEvent> {
    return this.conversationAccess.resumeSession(
      {
        id: sessionId,
        ...(options?.afterMsgId ? { afterMsgId: options.afterMsgId } : {}),
        ...(options?.afterCursor ? { afterCursor: options.afterCursor } : {}),
      },
      turnId,
      signal,
    );
  }
  getDelegationSnapshot(rootSessionId: string): Promise<TuiDelegationSnapshot> {
    return this.delegationAccess.getSnapshot(rootSessionId);
  }

  async listBackgroundTasks(
    ownerSessionId: string,
  ): Promise<readonly TuiBackgroundTask[]> {
    const activeStatuses = ["queued", "running", "stopping"] as const;
    const terminalStatuses = [
      "succeeded",
      "failed",
      "canceled",
      "lost",
    ] as const;
    const [active, terminal] = await Promise.all([
      this.cliService.listBackgroundTasks({
        ownerSessionId,
        statuses: activeStatuses,
        kinds: ["bash", "workflow", "custom"],
        limit: 100,
      }),
      this.cliService.listBackgroundTasks({
        ownerSessionId,
        statuses: terminalStatuses,
        kinds: ["bash", "workflow", "custom"],
        limit: 100,
      }),
    ]);
    const tasks = new Map(
      [...active, ...terminal].map((task) => [task.taskId, task]),
    );
    return [...tasks.values()]
      .filter(
        (
          task,
        ): task is typeof task & { readonly kind: TuiBackgroundTask["kind"] } =>
          task.kind !== "subagent",
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((task) => ({
        taskId: task.taskId,
        kind: task.kind,
        status: task.status,
        ownerSessionId: task.ownerSessionId,
        ...(task.description ? { description: task.description } : {}),
        ...(task.kind === "bash" && typeof task.metadata?.command === "string"
          ? { command: task.metadata.command }
          : {}),
        createdAtMs: task.createdAt,
        updatedAtMs: task.updatedAt,
        ...(task.startedAt !== undefined
          ? { startedAtMs: task.startedAt }
          : {}),
        ...(task.endedAt !== undefined ? { endedAtMs: task.endedAt } : {}),
        ...(task.deliveredAt !== undefined
          ? { deliveredAtMs: task.deliveredAt }
          : {}),
        ...(task.lastError?.message
          ? { lastError: task.lastError.message }
          : {}),
      }));
  }

  stopDelegation(rootSessionId: string): Promise<TuiDelegationStopReceipt> {
    return this.delegationAccess.stop(rootSessionId);
  }
}

export function createTuiQueueRequestId(): string {
  return `minimax-code_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
