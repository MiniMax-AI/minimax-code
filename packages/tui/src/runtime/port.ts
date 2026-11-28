import type { TuiAttachment, TuiTransportAttachment } from '../types/invocation.js';
import type { GlobalThreadGoal } from '@mavis/shared/global-events';
import type {
  TuiCompactionResult,
  TuiMcpAuthClearResult,
  TuiMcpAuthOutcome,
  TuiMcpAuthScope,
  TuiMcpAuthStartResult,
  TuiMcpAuthStateView,
  TuiMcpAuthTarget,
  TuiMcpServer,
  TuiModel,
  TuiPendingPermission,
  TuiQuestionnaireReplyAnswer,
  TuiQuestionnaireRequest,
  TuiQueuedMessage,
  TuiQueueReceipt,
  TuiSessionUsage,
  TuiSessionUsageSummary,
  TuiSkillList,
} from '../types/runtime-models.js';
import type { TuiRuntimeEvent } from '../types/runtime-events.js';
import type { TuiPermissionMode } from '../application/permission-mode.js';
import type { TuiMessage, TuiStreamEvent } from './stream-events.js';
import type { McodeProviderRuntimePort } from '../provider/contract.js';
import type { McodePluginRuntimeAccess } from '../plugin/contract.js';
import type { TuiDailyCheckinOutcome } from '../checkin/application.js';
import type {
  AbortSessionReq,
  CliSendMessageReq,
  CliSendMessageOptions,
  ConversationSteerInput,
  ConversationSteerResult,
  GetSessionActivityResp,
} from '@mavis/local-runtime-v2/cli-service';

export type { TuiMessage, TuiMessagePart, TuiStreamEvent, TuiToolCall } from './stream-events.js';
export type { TuiRuntimeEvent } from '../types/runtime-events.js';

/** TUI presentation choice for the two rewind modes exposed by DesktopService. */
export type TuiRewindScope = 'conversation' | 'conversation_and_files';

export interface TuiSessionInputSummary {
  userMessageId: string;
  assistantMessageId?: string;
  contentHead?: string;
  timestamp: number;
  fileChangeCount: number;
}

export interface TuiRewindPreviewFile {
  readonly filePath: string;
  readonly action: string;
  readonly skipped: boolean;
}

export interface TuiRewindPreviewTurn {
  readonly turnId: string;
  readonly files: readonly TuiRewindPreviewFile[];
}

export interface TuiRewindPreview {
  readonly turns: readonly TuiRewindPreviewTurn[];
}

export interface TuiRewindTurnDiffOutcome {
  status: string;
  revertedTurnIds?: readonly string[];
  errorCode?: string;
}

export interface TuiRewindResult {
  rewound: boolean;
  displayRevision?: string;
  historyRevision?: string;
  deletedMessageIds?: readonly string[];
  turnDiffRewind?: TuiRewindTurnDiffOutcome;
}

export interface TuiRewindInput {
  sessionId: string;
  userMessageId: string;
  clientRequestId: string;
  rewindTurnDiff?: boolean;
}

export interface TuiEditMessageAttachment {
  type: 'file' | 'image';
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  filePath?: string;
  assetId?: string;
}

export interface TuiEditMessageInput extends TuiRewindInput {
  content: string;
  attachments?: readonly TuiEditMessageAttachment[];
}

export interface TuiEditMessageResult extends TuiRewindResult {
  turnId?: string;
  userMessageId?: string;
}

export interface TuiSession {
  sessionId: string;
  agentName?: string;
  title?: string;
  parentSessionId?: string;
  sessionType?: 'root' | 'branch';
  sessionKind?: string;
  visibility?: 'visible' | 'hidden';
  purpose?: string;
  archived?: boolean;
  workspaceDir?: string;
  createdAt?: number | string;
  updatedAt?: number | string;
  status?: string;
  errorMessage?: string;
  errorCode?: number;
  errorSource?: string;
  errorDetail?: string;
  errorProviderId?: string;
  interactionMode?: 'plan';
  /**
   * Session-scoped model echo. `thinking.effort` is the authoritative
   * think-effort for this Session; the model roster only reports the
   * available options, never the chosen one.
   */
  model?: TuiSessionModelSelection;
}

export interface TuiSessionModelSelection {
  providerId?: string;
  modelId?: string;
  variant?: string;
  thinking?: TuiModelThinkingSelection;
}

export interface CreateTuiSessionInput {
  workspaceDir: string;
  /**
   * Identity from {@link TuiSessionPort.newSessionId}. Creation fails instead of reusing an
   * existing Session with the same ID.
   */
  sessionId?: string;
  /** Agent that owns the new Session; defaults to this TUI's Agent. */
  agentName?: string;
  title?: string;
  mcpServers?: readonly TuiSessionMcpServer[];
  /** Parent Session of a branch child. Required to create a BTW side session. */
  parentSessionId?: string;
  /** `hidden` keeps the Session out of every user-facing Session list. */
  visibility?: 'visible' | 'hidden';
  /**
   * Session purpose marker. Runtime derives `sessionKind: 'peek'` from a
   * `peek_` / `peek:` prefix on a branch child, and every Session-list index
   * predicate already excludes `peek`, so a peek purpose is what keeps a side
   * Session out of `/sessions` and `/resume` without a schema change.
   */
  purpose?: string;
}

export type TuiSessionMcpServer =
  | {
      readonly name: string;
      readonly type: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly type: 'http' | 'sse';
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export interface ListTuiSessionsOptions {
  limit?: number;
  cursor?: string;
  includeArchived?: boolean;
  onlyArchived?: boolean;
  includeHidden?: boolean;
  includePurposePrefix?: string;
  excludePurposePrefix?: string;
}

export interface ListTuiSessionPageInput extends ListTuiSessionsOptions {
  agentName?: string;
  allAgents?: boolean;
  /**
   * Read across every Agent instead of one Agent's Sessions.
   *
   * The Runtime reads a missing Agent name as "no Agent predicate", so this is
   * how a purpose-scoped read reaches work whose owning Agent the caller does
   * not know. `getSessionTree` is Agent-scoped by contract, so a cross-Agent
   * read always uses the flat Session list.
   */
  anyAgent?: boolean;
  workspaceDir?: string;
}

export interface TuiSessionPage {
  sessions: TuiSession[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface TuiMessagePageInput {
  limit?: number;
  before?: string;
}

export interface TuiMessagePage {
  messages: TuiMessage[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface TuiSessionPort {
  /**
   * Reserves a Session identity without writing anything. Pass it as
   * {@link CreateTuiSessionInput.sessionId} when the Session is actually needed.
   */
  newSessionId(): string;
  createSession(input: CreateTuiSessionInput): Promise<TuiSession>;
  configureSessionMcpServers(
    sessionId: string,
    servers: readonly TuiSessionMcpServer[],
  ): Promise<void>;
  clearSessionMcpServers(sessionId: string): Promise<void>;
  listSessions(agentName?: string, options?: ListTuiSessionsOptions): Promise<TuiSession[]>;
  listSessionPage(input?: ListTuiSessionPageInput): Promise<TuiSessionPage>;
  /** @deprecated Use the object-shaped input overload. */
  listSessionPage(agentName?: string, options?: ListTuiSessionsOptions): Promise<TuiSessionPage>;
  getSession(sessionId: string): Promise<TuiSession>;
  getMessages(sessionId: string, limit?: number): Promise<TuiMessage[]>;
  listMessagePage(sessionId: string, input?: TuiMessagePageInput): Promise<TuiMessagePage>;
  renameSession(sessionId: string, title: string): Promise<TuiSession>;
  archiveSession(sessionId: string, archived: boolean): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  listSessionInputSummaries(
    sessionId: string,
    input?: { limit?: number; before?: string },
  ): Promise<readonly TuiSessionInputSummary[]>;
  getSessionRewindPreview(input: {
    sessionId: string;
    userMessageId: string;
  }): Promise<TuiRewindPreview>;
  rewindSession(input: TuiRewindInput): Promise<TuiRewindResult>;
  editSessionMessage(input: TuiEditMessageInput): Promise<TuiEditMessageResult>;
}

export interface TuiSessionForkOptions {
  canFork: boolean;
  unavailableReason?: string;
  suggestedTitle?: string;
  nextForkOrdinal?: number;
  sourceTitle?: string;
  worktreeVisible: boolean;
  worktreeEligible: boolean;
  worktreeUnavailableReason?: string;
}

export interface ForkTuiSessionInput {
  sessionId: string;
  assistantMessageId?: string;
  clientRequestId: string;
  title?: string;
  useSuggestedTitle: boolean;
  createIsolatedWorktree: boolean;
}

export interface TuiSessionForkResult {
  session: TuiSession;
  forkOriginMessageId?: string;
  sourceDisplayMessageId?: string;
  displayRevision?: string;
  historyRevision?: string;
}

export interface TuiSessionForkPort {
  getSessionForkOptions(
    sessionId: string,
    assistantMessageId?: string,
  ): Promise<TuiSessionForkOptions>;
  forkSession(input: ForkTuiSessionInput): Promise<TuiSessionForkResult>;
}

/**
 * Programmatic Tool Calling as new Sessions see it. A Session keeps the mode it
 * was created (or last compacted) with, so a change never rewrites a running one.
 */
export interface TuiPtcSetting {
  /** Effective switch for this process: `beta.ptc`, the build default, or `--ptc`. */
  readonly enabled: boolean;
  /**
   * What config.yaml (shared with Desktop) resolves to without `--ptc`: the
   * value a switch shows and flips. Equals `enabled` when there is no override.
   */
  readonly saved: boolean;
  /** `--ptc` keeps PTC on for this process whatever config.yaml says. */
  readonly launchOverride: boolean;
}

export interface TuiConfigurationPort extends McodeProviderRuntimePort {
  getRuntimeDiagnostics(): Promise<TuiRuntimeDiagnostics>;
  getInstructionSources(workspaceDir: string): Promise<readonly TuiInstructionSource[]>;
  getAccountStatus(
    sessionId?: string,
    options?: TuiAccountStatusOptions,
  ): Promise<TuiAccountStatus>;
  getPermissionMode(): Promise<TuiPermissionMode | undefined>;
  setPermissionMode(mode: TuiPermissionMode): Promise<TuiPermissionMode>;
  /** Effective next-message suggestion switch; undefined when the Runtime has none. */
  getPromptSuggestionEnabled?(): Promise<boolean | undefined>;
  /**
   * Persists `promptSuggestion.enabled`; resolves the effective value, or
   * undefined when the Runtime cannot persist it.
   */
  setPromptSuggestionEnabled?(enabled: boolean): Promise<boolean | undefined>;
  /** Effective PTC switch for new Sessions; undefined when the Runtime has none. */
  getPtcSetting?(): Promise<TuiPtcSetting | undefined>;
  /**
   * Persists `beta.ptc`; resolves the effective setting, or undefined when the
   * Runtime cannot persist it.
   */
  setPtcEnabled?(enabled: boolean): Promise<TuiPtcSetting | undefined>;
  listModels(sessionId?: string): Promise<TuiModel[]>;
  selectModel(model: TuiModelSelection, sessionId?: string): Promise<boolean>;
  selectSessionModel(model: TuiModelSelection, sessionId: string): Promise<boolean>;
  /** Stars or unstars a model; resolves false when favorites are unavailable. */
  setModelFavorite?(model: TuiModelSelection, favorite: boolean): Promise<boolean>;
  /**
   * The Session's advisor with `sessionId`, else the new-conversation default.
   * Absent when the Runtime has no advisor.
   */
  getAdvisor?(sessionId?: string): Promise<TuiAdvisor>;
  /** Saves the new-conversation default, then with `sessionId` the same choice for that Session. */
  selectAdvisor?(selection: TuiAdvisorSelection, sessionId?: string): Promise<TuiAdvisor>;
  /** Writes one Session's advisor without changing the new-conversation default. */
  selectSessionAdvisor?(selection: TuiAdvisorSelection, sessionId: string): Promise<TuiAdvisor>;
  /**
   * Effective global advisor switch (`advisor.enabled`, shared with the Desktop setting); while it
   * is off no Session uses or lists its advisor. Undefined when the Runtime has none.
   */
  getAdvisorEnabled?(): Promise<boolean | undefined>;
  /**
   * Persists `advisor.enabled`; resolves the effective value, or undefined when the Runtime
   * cannot persist it.
   */
  setAdvisorEnabled?(enabled: boolean): Promise<boolean | undefined>;
}

/**
 * An advisor write. Runtime keeps the stored model, effort and window for whatever the write
 * omits, so `enabled: false` alone switches the advisor off and a later enable needs no new pick;
 * enabling with no model ever stored is rejected. A `thinking` without an effort clears the
 * stored effort, leaving the model's default.
 */
export interface TuiAdvisorSelection {
  readonly enabled: boolean;
  /** Given together with `modelId`. */
  readonly providerId?: string;
  readonly modelId?: string;
  readonly thinking?: TuiModelThinkingSelection;
  readonly contextLimit?: number;
}

/** The advisor a Session, or the new-conversation default, carries. */
export interface TuiAdvisor {
  readonly enabled: boolean;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly thinking?: { readonly effort: string };
  readonly contextLimit?: number;
}

export interface TuiAccountStatusOptions {
  /** Inspect the model selected for this invocation without changing saved configuration. */
  readonly model?: TuiModelSelection;
  /** Validate the MiniMax account even when the selected model uses an API key. */
  readonly requireManagedAuth?: boolean;
  includeMembership?: boolean;
  /** Bypass completed account/membership caches while still coalescing in-flight work. */
  forceRefresh?: boolean;
}

export interface TuiInspectionPort {
  getSessionUsage(sessionId: string): Promise<TuiSessionUsage>;
  getSessionUsageSummary?(sessionId: string): Promise<TuiSessionUsageSummary>;
  watchSessionUsageCommits?(signal: AbortSignal): AsyncGenerator<string>;
  requestCompaction(
    sessionId: string,
    agentName?: string,
    customInstructions?: string,
    reason?: string,
  ): Promise<TuiCompactionResult>;
  listSkills(agentName?: string, keyword?: string, workspaceDir?: string): Promise<TuiSkillList>;
  listMcpServers(keyword?: string, sessionId?: string): Promise<TuiMcpServer[]>;
  inspectProjectMcp(sessionId: string): Promise<TuiProjectMcpPreview | undefined>;
  getContextSnapshot(sessionId: string): Promise<TuiContextSnapshotResponse>;
}

/** User-triggered MCP OAuth; the host opens the browser, Runtime owns the attempt. */
export interface TuiMcpAuthPort {
  listMcpAuthStates(scope?: TuiMcpAuthScope): Promise<TuiMcpAuthStateView[]>;
  startMcpAuth(
    target: TuiMcpAuthTarget,
    options?: { readonly force?: boolean },
  ): Promise<TuiMcpAuthStartResult>;
  cancelMcpAuth(attemptId: string): Promise<boolean>;
  /** Completes with the redirect URL pasted from a browser that cannot reach this machine. */
  completeMcpAuth(attemptId: string, callbackUrl: string): Promise<TuiMcpAuthOutcome>;
  clearMcpAuth(target: TuiMcpAuthTarget): Promise<TuiMcpAuthClearResult>;
  /** An undefined secret clears it; only user-configured servers accept one. */
  setMcpUserClientSecret(serverName: string, secret: string | undefined): Promise<boolean>;
}

export type TuiContextComponentKind =
  | 'SYSTEM_PROMPT'
  | 'MEMORY'
  | 'TOOLS'
  | 'SKILLS'
  | 'MESSAGES'
  | 'OTHER';

export interface TuiContextUsageSnapshot {
  readonly contextWindowTokens: number;
  readonly usedTokens: number;
  readonly totalCountSource: 'LOCAL_ESTIMATE' | 'PROVIDER_USAGE_ANCHORED';
  readonly components: ReadonlyArray<{
    readonly kind: TuiContextComponentKind;
    readonly tokens: number;
  }>;
}

export interface TuiContextSnapshotResponse {
  readonly status: 'loading' | 'empty' | 'live' | 'stale';
  readonly model?: {
    readonly provider: string;
    readonly id: string;
    readonly contextWindow?: number;
  };
  readonly contextUsage?: TuiContextUsageSnapshot;
  readonly compaction?: {
    readonly state: 'never' | 'running' | 'completed' | 'failed';
    readonly lastCompactedAtMs?: number;
  };
}

export interface TuiFeedbackPort {
  prepareFeedback(input: { description: string; sessionId?: string }): Promise<TuiFeedbackPreview>;
  submitFeedback(draftId: string, options?: TuiFeedbackSubmitOptions): Promise<TuiFeedbackReceipt>;
  cancelFeedback(draftId: string): Promise<boolean>;
}

export interface TuiDailyCheckin {
  runDailyCheckin(): Promise<TuiDailyCheckinOutcome>;
}

export interface TuiQueueSnapshot {
  readonly items: readonly TuiQueuedMessage[];
  readonly paused: boolean;
  readonly pendingCount: number;
}

export interface TuiQueuePort {
  getQueueSnapshot(sessionId: string): Promise<TuiQueueSnapshot>;
  continueQueue(sessionId: string): Promise<void>;
  listQueuedMessages(sessionId: string): Promise<TuiQueuedMessage[]>;
  steerQueuedMessage(
    sessionId: string,
    itemId: string,
  ): Promise<{ queueItemId: string; turnId: string }>;
  enqueueMessage(
    sessionId: string,
    content: string,
    options?: EnqueueTuiMessageOptions,
  ): Promise<TuiQueueReceipt>;
  updateQueuedMessageContent(
    sessionId: string,
    itemId: string,
    content: string,
  ): Promise<TuiQueuedMessage | undefined>;
  deleteQueuedMessage(sessionId: string, itemId: string): Promise<TuiQueuedMessage | undefined>;
}

export interface TuiInteractionPort {
  getPendingQuestionnaire(
    agentName: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<TuiQuestionnaireRequest | undefined>;
  getLatestPlanReview(
    agentName: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<TuiQuestionnaireRequest | undefined>;
  getPlanModeCapabilities(): Promise<{ readonly entryEnabled: boolean }>;
  replyQuestionnaire(
    agentName: string,
    requestId: string,
    answers: TuiQuestionnaireReplyAnswer[],
  ): Promise<boolean>;
  dismissQuestionnaire(agentName: string, requestId: string): Promise<boolean>;
  listPendingPermissions(signal?: AbortSignal): Promise<TuiPendingPermission[]>;
  replyPermission(
    agentName: string,
    requestId: string,
    decision: TuiPermissionDecision,
  ): Promise<boolean>;
}

export interface TuiRuntimeEventPort {
  watchEvents(signal: AbortSignal): AsyncGenerator<TuiRuntimeEvent>;
}

export interface TuiGoalPort {
  isGoalEnabled(): boolean;
  getGoal(sessionId: string): Promise<GlobalThreadGoal | undefined>;
  createGoal(input: {
    readonly sessionId: string;
    readonly objective: string;
    readonly tokenBudget?: number | null;
    readonly attachments?: readonly TuiAttachment[];
  }): Promise<GlobalThreadGoal>;
  patchGoal(
    sessionId: string,
    patch: {
      readonly status?: GlobalThreadGoal['status'];
      readonly objective?: string;
      readonly tokenBudget?: number | null;
    },
  ): Promise<GlobalThreadGoal>;
  clearGoal(sessionId: string): Promise<boolean>;
}

export interface TuiSessionTurnPort {
  watchSessionTurn(
    sessionId: string,
    turnId: string,
    signal: AbortSignal,
    options?: WatchTuiSessionTurnOptions,
  ): AsyncGenerator<TuiStreamEvent>;
}

/**
 * Plugin Hook Session lifecycle of the embedded Runtime around `/clear` and
 * Session switches. Flat methods so the deferred Runtime proxy can forward them.
 */
export interface TuiPluginHookSessionPort {
  markNextPluginHookSessionStart(sessionId: string, source: 'clear'): void;
  abortPluginHookSessionTurn(
    sessionId: string,
    abortSession?: (executionSessionId: string) => Promise<unknown>,
  ): Promise<void>;
  endPluginHookSession(sessionId: string, reason: 'clear' | 'resume_other'): Promise<void>;
}

export interface TuiConversationPort {
  sendMessage(
    req: CliSendMessageReq,
    signal?: AbortSignal,
    options?: CliSendMessageOptions,
  ): AsyncGenerator<TuiStreamEvent>;
  abortSession(req: AbortSessionReq): Promise<boolean>;
  steer(input: ConversationSteerInput): Promise<ConversationSteerResult>;
}

export interface WatchTuiSessionTurnOptions {
  afterMsgId?: string;
  afterCursor?: string;
}

export interface TuiWorkspaceFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  ignored?: boolean;
}

export interface TuiWorkspaceRoot {
  path: string;
  label?: string;
  primary?: boolean;
}

export interface TuiWorkspaceFileCandidate {
  workspaceDir: string;
  path: string;
}

export interface TuiWorkspaceTreeCandidate extends TuiWorkspaceFileEntry {
  workspaceDir: string;
}

/** Overall merge request status, as the Runtime last read it from the git host. */
export const TUI_REVIEW_STATUSES = [
  'unknown',
  'ready_to_merge',
  'pipeline_failed',
  'conflict',
  'changes_requested',
  'unresolved_discussions',
  'pipeline_running',
  'waiting_for_approval',
  'draft',
  'blocked',
  'merged',
  'closed',
] as const;
export type TuiReviewStatus = (typeof TUI_REVIEW_STATUSES)[number];

/**
 * A pull request / merge request the current branch belongs to.
 *
 * Comes from what the Runtime already learned: its branch query at the end of
 * a Turn, or a merge request an agent just created. The status line never asks
 * the git host itself, so `status` is as fresh as that last answer.
 */
export interface TuiReviewLink {
  vendor: 'github' | 'gitlab';
  url: string;
  number: number;
  status?: TuiReviewStatus;
}

export interface TuiWorkspaceGitMetadata {
  isGitRepo: boolean;
  branch: string;
  detached: boolean;
  isWorktree: boolean;
  reviewLink?: TuiReviewLink;
}

export interface TuiWorkspaceGitPort {
  getWorkspaceGitMetadata(workspaceDir: string): Promise<TuiWorkspaceGitMetadata>;
}

export interface TuiWorkspaceFilePort {
  listWorkspaceFileTree(
    workspaceDir: string,
    path?: string,
    signal?: AbortSignal,
  ): Promise<TuiWorkspaceFileEntry[]>;
  searchWorkspaceFiles(
    workspaceDir: string,
    query: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<string[]>;
  listWorkspaceFileTreeCandidates?(
    request: {
      roots: readonly TuiWorkspaceRoot[];
      path?: string;
    },
    signal?: AbortSignal,
  ): Promise<TuiWorkspaceTreeCandidate[]>;
  searchWorkspaceFileCandidates?(
    request: {
      roots: readonly TuiWorkspaceRoot[];
      query: string;
      limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<TuiWorkspaceFileCandidate[]>;
}

export type TuiDelegatedAgentStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'unknown';

/**
 * Which user decision a delegated Session is blocked on. A Session waiting for one
 * is idle at the Runtime - `ask_user` and a tool approval both end the Turn - so the
 * Session status alone cannot tell a blocked Session apart from a finished one.
 */
export type TuiDelegatedWaitingReason = 'questionnaire' | 'permission';

export interface TuiDelegatedAgent {
  sessionId: string;
  parentSessionId: string;
  agentName?: string;
  task?: string;
  status: TuiDelegatedAgentStatus;
  waitingReason?: TuiDelegatedWaitingReason;
  createdAtMs?: number;
  updatedAtMs?: number;
  errorMessage?: string;
}

export interface TuiDelegationSnapshot {
  schemaVersion: 1;
  rootSessionId: string;
  members: TuiDelegatedAgent[];
}

export interface TuiDelegationStopReceipt {
  schemaVersion: 1;
  rootSessionId: string;
  /** Present when only this delegated agent and its descendants were stopped. */
  targetSessionId?: string;
  rootStopped: boolean;
  stoppedSessionIds: string[];
  activeSessionIds: string[];
  failedSessionIds: string[];
}

export interface TuiDelegationStopOptions {
  /**
   * Stop only this member of the root's delegation tree and its descendants; the root
   * and the other members keep running. Omit to stop the whole tree.
   */
  targetSessionId?: string;
}

export interface TuiDelegationPort {
  getDelegationSnapshot(rootSessionId: string): Promise<TuiDelegationSnapshot>;
  stopDelegation(
    rootSessionId: string,
    options?: TuiDelegationStopOptions,
  ): Promise<TuiDelegationStopReceipt>;
}

export interface TuiSessionActivityPort {
  /** Whether the session tree can still advance without user input (evaluation contract). */
  getSessionActivity(rootSessionId: string): Promise<GetSessionActivityResp>;
}

export type TuiBackgroundTaskStatus =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'lost';

/**
 * Runtime fact for a terminal Task's root notification: `pending` until a Turn takes it,
 * `settled` once it is steered into or admitted as a Turn, read, or stopped by the user.
 */
export interface TuiBackgroundTaskNotification {
  readonly state: 'pending' | 'settled';
  readonly turnId?: string;
}

export interface TuiBackgroundTask {
  readonly taskId: string;
  readonly kind: 'bash' | 'subagent' | 'workflow' | 'custom';
  readonly status: TuiBackgroundTaskStatus;
  readonly ownerSessionId: string;
  readonly description?: string;
  /** Full Bash source, distinct from the Runtime's shortened list description. */
  readonly command?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  readonly deliveredAtMs?: number;
  readonly lastError?: string;
  /** Bash still owned by its foreground tool call (not auto-promoted to the background). */
  readonly foreground?: true;
  /** Sub-Agent Task only: the child Session that runs it. */
  readonly childSessionId?: string;
  /** Terminal Tasks only, when the Runtime reports it; absent means settled. */
  readonly notification?: TuiBackgroundTaskNotification;
}

export interface TuiBackgroundTaskListOptions {
  /**
   * `[V]` machine status only: also list sub-Agent Tasks and ask the Runtime for each terminal
   * Task's root notification. Without it the list holds bash/workflow/custom Tasks only.
   */
  readonly machineStatus?: boolean;
}

export interface TuiBackgroundTaskCapability {
  listBackgroundTasks?(
    ownerSessionId: string,
    options?: TuiBackgroundTaskListOptions,
  ): Promise<readonly TuiBackgroundTask[]>;
}

export interface TuiActiveRunSnapshot {
  schemaVersion: 1;
  sessionId: string;
  state: 'running' | 'decision-blocked' | 'terminal' | 'idle';
  turnId?: string;
  actions: {
    steer: boolean;
  };
  /**
   * Present only when another live MCode process owns the running Turn. This
   * process can read the Session but cannot steer, queue, or stop that Turn.
   */
  runningElsewhere?: true;
  retryReason?: string;
}

export interface TuiActiveRunControlPort {
  getActiveRun(sessionId: string): Promise<TuiActiveRunSnapshot>;
}

/**
 * Product-facing Runtime surface required by the interactive MCode TUI.
 *
 * Headless run lifecycle is intentionally excluded: commands and application
 * services should depend on the narrow domain ports above instead of this
 * composed product boundary.
 */
export type TuiRuntime = TuiSessionPort &
  TuiConversationPort &
  TuiConfigurationPort &
  TuiInspectionPort &
  TuiFeedbackPort &
  TuiDailyCheckin &
  TuiQueuePort &
  TuiInteractionPort &
  TuiMcpAuthPort &
  TuiRuntimeEventPort &
  TuiGoalPort &
  TuiSessionTurnPort &
  TuiDelegationPort &
  TuiBackgroundTaskCapability &
  TuiActiveRunControlPort &
  TuiWorkspaceGitPort &
  McodePluginRuntimeAccess &
  Partial<TuiSessionForkPort> &
  Partial<TuiWorkspaceFilePort> &
  Partial<TuiPluginHookSessionPort>;

export type TuiPermissionDecision = 'allowOnce' | 'allowAlways' | 'deny';
export interface TuiModelThinkingSelection {
  /** Explicit think-effort level; omitted means "let Runtime pick the default". */
  effort?: string;
}

export interface TuiModelSelection {
  contextLimit?: number;
  providerId: string;
  modelId: string;
  variant?: string;
  thinking?: TuiModelThinkingSelection;
}
export type {
  TuiCompactionResult,
  TuiMcpAuthClearResult,
  TuiMcpAuthAttemptOutcome,
  TuiMcpAuthConfirmation,
  TuiMcpAuthOutcome,
  TuiMcpAuthScope,
  TuiMcpAuthStartResult,
  TuiMcpAuthState,
  TuiMcpAuthStateView,
  TuiMcpAuthTarget,
  TuiMcpServer,
  TuiModel,
  TuiPendingPermission,
  TuiQuestionnaireReplyAnswer,
  TuiQuestionnaireRequest,
  TuiQueuedMessage,
  TuiQueueReceipt,
  TuiSessionUsage,
  TuiSessionUsageRow,
  TuiSessionUsageSummary,
  TuiSkillList,
} from '../types/runtime-models.js';

export interface TuiFeedbackDiagnosticRow {
  label: string;
  value: string;
}

export interface TuiFeedbackPreview {
  schemaVersion: 1;
  draftId: string;
  description: string;
  diagnostics: TuiFeedbackDiagnosticRow[];
  diagnosticBundleIncluded: boolean;
  included: string[];
  excluded: string[];
  expiresAtMs: number;
}

export interface TuiFeedbackReceipt {
  schemaVersion: 1;
  ticketId?: string;
  uploadId?: string;
  status: 'processing' | 'resolved' | 'unknown';
  createdAtMs?: number;
}

export type TuiFeedbackPhase =
  | 'preparing'
  | 'uploading-diagnostics'
  | 'creating-ticket'
  | 'completed';

export interface TuiFeedbackSubmitOptions {
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: TuiFeedbackPhase) => void;
}

export interface EnqueueTuiMessageOptions {
  attachments?: readonly TuiTransportAttachment[];
  clientIntent?: TuiPlanClientIntent;
  model?: TuiModelSelection;
  reviewRequest?: { readonly scope: 'local_changes' };
}

export type TuiPlanClientIntent = 'plan-entry' | 'plan-exit';
export type TuiPausedQueueSendIntent = 'paused-queue-keep' | 'paused-queue-clear';
export type TuiClientIntent = TuiPlanClientIntent | 'retry-continuation' | TuiPausedQueueSendIntent;

export interface TuiAccountStatus {
  status: 'ready' | 'needs-login' | 'warning' | 'unknown';
  defaultModel?: string;
  providerId?: string;
  modelId?: string;
  authMode?: string;
  managedTokenPresent?: boolean;
  identity?: { readonly email?: string; readonly name?: string };
  modelSource?: 'token-plan' | 'byok';
  tokenPlanQuotaState?: 'available' | 'not-subscribed' | 'unavailable';
  tokenPlanSummary?: TuiTokenPlanSummary;
  tokenPlanQuota?: TuiTokenPlanQuota;
  warnings: string[];
}

export interface TuiInstructionSource {
  readonly scope: 'global' | 'project';
  readonly path: string;
}

export interface TuiTokenPlanQuotaWindow {
  remainingPercent?: number;
  resetAtMs?: number;
  unlimited: boolean;
}

export interface TuiTokenPlanQuota {
  fiveHour: TuiTokenPlanQuotaWindow;
  weekly: TuiTokenPlanQuotaWindow;
  video?: TuiTokenPlanVideoQuota;
}

export interface TuiTokenPlanSummary {
  tier?: string;
  expiresAtMs?: number;
  creditBalance?: string;
}

export interface TuiTokenPlanVideoQuota {
  remainingCount?: number;
  totalCount?: number;
  resetAtMs?: number;
  unlimited: boolean;
}

export interface TuiRuntimeDiagnostics {
  status?: string;
  surface?: string;
  runtimeMode?: string;
  runtimeOwnerKind?: string;
  runtimeOwnerId?: string;
  dataDir?: string;
  configPath?: string;
  configPresent?: boolean;
  authCachePresent?: boolean;
  defaultModel?: string;
  providerId?: string;
  modelId?: string;
  providerBaseUrl?: string;
  authMode?: string;
  authModeSource?: string;
  managedTokenPresent?: boolean;
  apiKeyPresent?: boolean;
  customProviderCount?: number;
  warnings: string[];
}

export interface TuiProjectMcpPreview {
  path: string;
  digest: string;
  error?: string;
  servers: Array<{
    name: string;
    transport: string;
    target: string;
    status: 'configured' | 'available' | 'disabled' | 'error';
    error?: string;
  }>;
}
