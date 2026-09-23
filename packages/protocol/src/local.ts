/**
 * Data model shared by local CLI/TUI. This module defines no routes, clients, accounts, or RPC
 * envelopes. Applications validate inputs; timestamps use Unix milliseconds. Numeric enums preserve
 * compatibility when reading saved sessions.
 */

export const SessionResultSyncState = {
  Unknown: 0,
  Ready: 1,
  Approved: 2,
  Completed: 3,
  Failed: 4,
} as const;

export type SessionResultSyncState =
  (typeof SessionResultSyncState)[keyof typeof SessionResultSyncState];

export const TurnContinuationState = {
  Unavailable: 0,
  Available: 1,
  Running: 2,
  WaitingForUser: 3,
} as const;

export type TurnContinuationState =
  (typeof TurnContinuationState)[keyof typeof TurnContinuationState];

export const SessionTypeView = {
  Branch: 0,
  Root: 1,
} as const;

export type SessionTypeView =
  (typeof SessionTypeView)[keyof typeof SessionTypeView];

export const SessionStatusView = {
  Idle: 0,
  Started: 1,
  Error: 2,
  Abort: 3,
} as const;

export type SessionStatusView =
  (typeof SessionStatusView)[keyof typeof SessionStatusView];

export const SessionInteractionModeView = {
  Default: 0,
  Plan: 1,
  Goal: 2,
} as const;

export type SessionInteractionModeView =
  (typeof SessionInteractionModeView)[keyof typeof SessionInteractionModeView];

export const SessionKind = {
  Unknown: 0,
  Conversation: 1,
  Task: 2,
  Peek: 3,
  Channel: 4,
  Cron: 5,
} as const;

export type SessionKind = (typeof SessionKind)[keyof typeof SessionKind];

export const SessionCollaborationKind = {
  LocalCloudHandoff: 1,
} as const;

export type SessionCollaborationKind =
  (typeof SessionCollaborationKind)[keyof typeof SessionCollaborationKind];

export const DriveNodeType = {
  Folder: 1,
  File: 2,
} as const;

export type DriveNodeType = (typeof DriveNodeType)[keyof typeof DriveNodeType];

export const DriveNodeSource = {
  UserUpload: 1,
  AgentDeliverable: 2,
  SystemGenerated: 3,
} as const;

export type DriveNodeSource =
  (typeof DriveNodeSource)[keyof typeof DriveNodeSource];

export const PluginInstallationPolicy = {
  USER_MANAGED: 1,
  DEFAULT_INSTALLED_UNREMOVABLE: 2,
} as const;

export type PluginInstallationPolicy =
  (typeof PluginInstallationPolicy)[keyof typeof PluginInstallationPolicy];

export const InstalledPluginSource = {
  OFFICIAL: 1,
  LOCAL: 2,
} as const;

export type InstalledPluginSource =
  (typeof InstalledPluginSource)[keyof typeof InstalledPluginSource];

export const PluginCapabilityType = {
  APP: 1,
  MCP: 2,
  SKILL: 3,
} as const;

export type PluginCapabilityType =
  (typeof PluginCapabilityType)[keyof typeof PluginCapabilityType];

export const SkillScope = {
  AGENT: 1,
  GLOBAL: 2,
} as const;

export type SkillScope = (typeof SkillScope)[keyof typeof SkillScope];

export const SkillSourceType = {
  MINIMAX_OFFICIAL: 1,
  USER_CONTRIBUTION: 2,
} as const;

export type SkillSourceType =
  (typeof SkillSourceType)[keyof typeof SkillSourceType];

export const SkillSortType = {
  USE_COUNT: 1,
  CREATE_TIME_ASC: 2,
  CREATE_TIME_DESC: 3,
} as const;

export type SkillSortType = (typeof SkillSortType)[keyof typeof SkillSortType];

export const MarketplaceCategory = {
  OTHER: 0,
  OFFICE: 1,
  STUDIO: 2,
  DESIGN_AND_SITES: 3,
  CODE: 4,
  BUSINESS: 5,
  SALES: 6,
  PRODUCTIVITY: 7,
  TOOLS: 8,
  SCIENCE_AND_HEALTHCARE: 9,
  EDUCATION: 10,
} as const;

export type MarketplaceCategory =
  (typeof MarketplaceCategory)[keyof typeof MarketplaceCategory];

export const AgentCreationSource = {
  UnknownCreationSource: 0,
  Manual: 1,
  Auto: 2,
  Builtin: 3,
} as const;

export type AgentCreationSource =
  (typeof AgentCreationSource)[keyof typeof AgentCreationSource];

export const ScheduleKind = {
  Recurring: 0,
  Once: 1,
} as const;

export type ScheduleKind = (typeof ScheduleKind)[keyof typeof ScheduleKind];

export const PermissionReply = {
  AllowOnce: 0,
  AllowAlways: 1,
  Deny: 2,
} as const;

export type PermissionReply =
  (typeof PermissionReply)[keyof typeof PermissionReply];

export const QuestionnaireSelectionMode = {
  Single: 0,
  Multiple: 1,
} as const;

export type QuestionnaireSelectionMode =
  (typeof QuestionnaireSelectionMode)[keyof typeof QuestionnaireSelectionMode];

export const QuestionnairePurpose = {
  General: 0,
  Goal: 1,
} as const;

export type QuestionnairePurpose =
  (typeof QuestionnairePurpose)[keyof typeof QuestionnairePurpose];

export const QuestionnaireStatus = {
  Pending: 0,
  Answered: 1,
  Expired: 2,
  Superseded: 3,
  Dismissed: 4,
} as const;

export type QuestionnaireStatus =
  (typeof QuestionnaireStatus)[keyof typeof QuestionnaireStatus];

export interface AttachmentMeta {
  attachmentType?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface LocalAttachmentRef {
  assetId?: string;
  filePath?: string;
  dataUrl?: string;
  desktopPath?: string;
}

export interface RemoteAttachmentRef {
  url?: string;
  dataUrl?: string;
}

export interface AttachmentInput {
  meta?: AttachmentMeta;
  local?: LocalAttachmentRef;
  cloud?: RemoteAttachmentRef;
}

export interface ModelThinkingBudgetsInput {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export interface ModelThinkingInput {
  effort?: string;
  offBehavior?: string;
  budgets?: ModelThinkingBudgetsInput;
}

export interface ModelSelectionInput {
  providerId?: string;
  modelId?: string;
  variant?: string;
  reasoning?: boolean;
  thinking?: ModelThinkingInput;
  contextLimit?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface AttachmentView {
  meta?: AttachmentMeta;
  local?: LocalAttachmentRef;
  cloud?: RemoteAttachmentRef;
  previewUrl?: string;
  status?: string;
}

export interface SessionToolCallView {
  toolName: string;
  toolCallId: string;
  toolCallStatus?: number;
  toolCallArgs?: string;
  toolCallResultData?: string;
  pluginProvenances?: PluginCapabilityProvenance[];
}

export interface SessionMessageUsageView {
  totalTokens?: number;
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface SessionMessageActionCapabilities {
  fork?: boolean;
  rewind?: boolean;
}

export interface SessionMessageActionDeltaView {
  messageId: string;
  actions: SessionMessageActionCapabilities;
}

export interface SessionResultChangeView {
  relativePath: string;
  kind: string;
  previousPath?: string;
  baseSha256?: string;
  cloudSha256?: string;
  sizeBytes?: number;
  sensitive: boolean;
  preview?: FileDiffInfoView;
}

export interface SessionResultSyncView {
  state: SessionResultSyncState;
  syncRequestId?: string;
  selectedPaths?: string[];
  failedPaths?: string[];
  failureMessage?: string;
  updatedAt: number;
}

export interface SessionTurnResultView {
  resultId: string;
  turnId: string;
  baseRevisionId: string;
  cloudRevisionId: string;
  fileChanges?: SessionResultChangeView[];
  artifacts?: AttachmentView[];
  sync: SessionResultSyncView;
  expiresAt: number;
}

export interface SessionConversationCapabilities {
  fork: boolean;
  rewind: boolean;
}

export interface SessionForkOriginView {
  sourceSessionId: string;
  sourceMessageId: string;
  sourceTitle: string;
}

export interface MemoryReferenceView {
  kind: string;
  displayName: string;
  path: string;
}

export interface SessionMessageView {
  msgId: string;
  /** Canonical user text for editing when display text omits plugin identities. */
  editContent?: string;
  parentMsgId?: string;
  timestamp?: number;
  msgContent?: string;
  msgType?: number;
  role?: string;
  thinkingContent?: string;
  thinkingDurationMs?: number;
  finishReason?: string;
  toolCalls?: SessionToolCallView[];
  attachments?: AttachmentView[];
  usage?: SessionMessageUsageView;
  source?: string;
  kind?: string;
  originJson?: string;
  communicationInfosJson?: string;
  rawJson?: string;
  sourceMessageId?: string;
  turnId?: string;
  queryKey?: string;
  actions?: SessionMessageActionCapabilities;
  forkOrigin?: SessionForkOriginView;
  memoryReferences?: MemoryReferenceView[];
}

export interface QueryCollapseView {
  queryKey: string;
  currentTurnId: string;
  forceExpanded: boolean;
  processingStartedAtMs: number;
  processingFinishedAtMs?: number;
}

export interface SessionStreamFrameView {
  cursor?: string;
  eventJson?: string;
  dataJson?: string;
  messageActionDeltas?: SessionMessageActionDeltaView[];
}

export interface SessionStreamErrorBody {
  sseErrorCode: number;
  code: number;
  key: string;
  message: string;
  detail?: string;
}

export interface GetMessagesInput {
  id: string;
  limit?: number;
  before?: string;
  includeAttachmentReadUrls?: boolean;
}

export interface GetMessagesResult {
  messages?: SessionMessageView[];
  nextCursor?: string;
  lastMsgId?: string;
  hasMore?: boolean;
  todosJson?: string;
  queryCollapseViews?: QueryCollapseView[];
  turnResults?: SessionTurnResultView[];
}

export interface GetSessionForkOptionsInput {
  id: string;
  assistantMessageId?: string;
}

export interface GetSessionForkOptionsResult {
  canFork: boolean;
  unavailableReason?: string;
  suggestedTitle?: string;
  nextForkOrdinal?: number;
  sourceTitle?: string;
  worktreeVisible: boolean;
  worktreeEligible: boolean;
  worktreeUnavailableReason?: string;
}

export interface ForkSessionInput {
  id: string;
  assistantMessageId?: string;
  clientRequestId: string;
  title?: string;
  useSuggestedTitle: boolean;
  createIsolatedWorktree: boolean;
}

export interface ForkSessionResult {
  session?: SessionInfoView;
  forkOriginMessageId?: string;
  sourceDisplayMessageId?: string;
  displayRevision?: string;
  historyRevision?: string;
}

export interface GetSessionRewindPreviewInput {
  id: string;
  userMessageId: string;
}

export interface TurnDiffRewindPreviewFile {
  filePath: string;
  action: string;
  skipped: boolean;
}

export interface TurnDiffRewindPreviewTurn {
  turnId: string;
  files: TurnDiffRewindPreviewFile[];
}

export interface GetSessionRewindPreviewResult {
  turns: TurnDiffRewindPreviewTurn[];
}

export interface RewindSessionInput {
  id: string;
  userMessageId: string;
  clientRequestId: string;
  rewindTurnDiff?: boolean;
}

export interface TurnDiffRewindOutcome {
  status: string;
  revertedTurnIds?: string[];
  errorCode?: string;
}

export interface RewindSessionResult {
  rewound: boolean;
  displayRevision?: string;
  historyRevision?: string;
  deletedMessageIds?: string[];
  turnDiffRewind?: TurnDiffRewindOutcome;
}

export interface EditSessionMessageInput {
  id: string;
  userMessageId: string;
  clientRequestId: string;
  content: string;
  attachments?: AttachmentInput[];
  rewindTurnDiff?: boolean;
}

export interface EditSessionMessageResult {
  rewound: boolean;
  turnId?: string;
  userMessageId?: string;
  displayRevision?: string;
  historyRevision?: string;
  deletedMessageIds?: string[];
}

export interface SessionMessageHeadView {
  msgId: string;
  contentHead?: string;
  timestamp: number;
}

export interface SessionInputSummaryView {
  userInput: SessionMessageHeadView;
  assistantResponse?: SessionMessageHeadView;
  artifacts?: DriveNode[];
  fileChangeCount: number;
}

export interface ListSessionInputSummariesInput {
  id: string;
  limit?: number;
  before?: string;
}

export interface ListSessionInputSummariesResult {
  summaries?: SessionInputSummaryView[];
  total?: number;
  nextCursor?: string;
  hasMore?: boolean;
}

export interface SessionSourceRecordView {
  sourceId: string;
  resourceType: string;
  resourceDataJson: string;
  resourceDataVersion: number;
  msgId: string;
  toolCallId: string;
  resourceOrdinal: number;
  createdAt: number;
}

export interface SessionSourceTurnView {
  turnId: string;
  sourceStartedAt: number;
  sources: SessionSourceRecordView[];
}

export interface ListSessionSourceHistoryInput {
  id: string;
  limit?: number;
  before?: string;
}

export interface ListSessionSourceHistoryResult {
  sourcedTurnCount: number;
  sourceCount: number;
  recentSources: SessionSourceRecordView[];
  turns: SessionSourceTurnView[];
  nextCursor?: string;
  hasMore?: boolean;
}

export interface GetSessionSourceDetailInput {
  id: string;
  msgId: string;
  toolCallId: string;
}

export interface SessionSourceDetailView {
  msgId: string;
  toolCall: SessionToolCallView;
}

export interface GetSessionSourceDetailResult {
  detail?: SessionSourceDetailView;
}

export interface SendMessageInput {
  id: string;
  content?: string;
  model?: ModelSelectionInput;
  attachments?: AttachmentInput[];
  turnId?: string;
  clientIntent?: string;
  enableTeam?: boolean;
  reviewRequest?: ReviewRequest;
}

export interface ResumeSessionInput {
  id: string;
  afterMsgId?: string;
  afterCursor?: string;
  drainQueued?: boolean;
  continuePausedQueue?: boolean;
  includeAttachmentReadUrls?: boolean;
}

export interface InspectTurnContinuationInput {
  id: string;
}

export interface InspectTurnContinuationResult {
  state: TurnContinuationState;
}

export interface ContinueTurnInput {
  id: string;
}

export interface AbortSessionInput {
  id: string;
  turnId?: string;
  reason?: string;
}

export interface AbortSessionResult {
  success?: boolean;
}

export interface SteerSessionInput {
  id: string;
  queueItemId?: string;
}

export interface SteerSessionResult {
  success: boolean;
  queueItemId?: string;
  turnId?: string;
}

export interface SessionTokenUsageSummaryView {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  turns?: number;
}

export interface SessionTokenUsageRowView {
  id?: number;
  sessionId?: string;
  agentName?: string;
  frameworkType?: string;
  turnId?: string;
  model?: string;
  ts?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  rawJson?: string;
}

export interface ModelThinkingConfigView {
  mode?: string;
  defaultValue?: string;
}

export interface ModelInfoView {
  providerId?: string;
  modelId?: string;
  variant?: string;
  displayName?: string;
  contextLimit?: number;
  supportedVariants?: string[];
  thinkingConfig?: ModelThinkingConfigView;
  reasoning?: boolean;
  thinking?: ModelThinkingInput;
}

export interface SessionStatusInfoView {
  statusType?: SessionStatusView;
  message?: string;
  errorCode?: number;
  errorSource?: string;
  errorDetail?: string;
  errorProviderId?: string;
}

export interface RunLocationView {
  mode?: string;
  resolvedDir?: string;
  resolvedBranch?: string;
  parentRepoDir?: string;
  createdAt?: number;
}

export interface RunLocationInput {
  mode?: string;
  worktreeDir?: string;
  branch?: string;
  newWorktreeBranch?: string;
  newWorktreeBase?: string;
}

export interface SessionMemoryPolicyInput {
  recallEnabled?: boolean;
  writeEnabled?: boolean;
}

export interface SessionMemoryPolicyView {
  recallEnabled: boolean;
  writeEnabled: boolean;
  recallLocked: boolean;
  recallLockedAtMs?: number;
}

export interface SessionCollaborationView {
  kind: SessionCollaborationKind;
  dispatchId: string;
  canDownloadResult?: boolean;
  canOverwriteWorkspace?: boolean;
  canBrowseCloudWorkspace?: boolean;
}

export interface SessionInfoView {
  sessionId?: string;
  agentName?: string;
  sessionType?: SessionTypeView;
  title?: string;
  parentSessionId?: string;
  archived?: boolean;
  status?: SessionStatusInfoView;
  createdAt?: number;
  updatedAt?: number;
  model?: ModelInfoView;
  teamMode?: boolean;
  workspaceDir?: string;
  frameworkType?: string;
  isDefaultWorkspace?: boolean;
  visibility?: string;
  purpose?: string;
  effectiveModel?: string;
  effectiveModelVariant?: string;
  lastActiveAt?: number;
  runLocation?: RunLocationView;
  sessionKind?: SessionKind;
  interactionMode?: SessionInteractionModeView;
  conversationCapabilities?: SessionConversationCapabilities;
  memoryPolicy?: SessionMemoryPolicyView;
  collaboration?: SessionCollaborationView;
}

export interface SessionTreeChildView {
  sessionId?: string;
  agentName?: string;
  frameworkType?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  archived?: boolean;
  compressed?: boolean;
  status?: SessionStatusInfoView;
  sessionKind?: SessionKind;
}

export interface QueuedMessageItemView {
  itemId: string;
  sessionId: string;
  status: string;
  source?: string;
  content?: string;
  attachments?: AttachmentView[];
  modelInfo?: ModelInfoView;
  createdAt?: number;
  expiresAt?: number;
  startedAt?: number;
  finishedAt?: number;
  failedReason?: string;
  reviewRequest?: ReviewRequest;
}

export interface FileDiffHunkView {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines?: string[];
}

export interface FileDiffInfoPatchView {
  oldFileName: string;
  newFileName: string;
  hunks?: FileDiffHunkView[];
}

export interface FileDiffInfoView {
  file: string;
  additions: number;
  deletions: number;
  status?: string;
  diff?: string;
  patch?: FileDiffInfoPatchView;
  previewState?: string;
  external?: boolean;
}

export interface TurnDiffView {
  fileChanges?: FileDiffInfoView[];
  sourceMessageId?: string;
  changeSetId?: string;
  status?: string;
  revertedAt?: number;
  undoable?: boolean;
  canUndo?: boolean;
  canReapply?: boolean;
}

export interface GetRootSessionInput {
  name: string;
}

export interface GetRootSessionResult {
  session?: SessionInfoView;
}

export interface ReplaceRootSessionInput {
  name: string;
  sessionId: string;
}

export interface ReplaceRootSessionResult {
  ok?: boolean;
}

export interface CreateSessionInput {
  name: string;
  workspaceDir?: string;
  parentSessionId?: string;
  title?: string;
  visibility?: string;
  purpose?: string;
  teamModeOff?: boolean;
  model?: ModelSelectionInput;
  runLocation?: RunLocationInput;
  appMode?: string;
  projectId?: number;
  sessionKind?: SessionKind;
  expectedAgentInstanceId?: string;
}

export interface CreateSessionResult {
  agentName?: string;
  sessionId?: string;
  session?: SessionInfoView;
}

export interface UpdateSessionInput {
  id: string;
  title?: string;
  memoryPolicy?: SessionMemoryPolicyInput;
  projectId?: number;
}

export interface UpdateSessionResult {
  session?: SessionInfoView;
}

export interface GetSessionUsageInput {
  id: string;
  fromMs?: number;
  toMs?: number;
}

export interface GetSessionUsageResult {
  summary?: SessionTokenUsageSummaryView;
  rows?: SessionTokenUsageRowView[];
}

export interface GetPeekContextInput {
  id: string;
}

export interface GetPeekContextResult {
  context?: string;
}

export interface GetSessionDiffInput {
  id: string;
  messageId?: string;
}

export interface GetSessionDiffResult {
  diffs?: FileDiffInfoView[];
  changeSetId?: string;
}

export interface DeleteSessionInput {
  id: string;
}

export interface DeleteSessionResult {
  success?: boolean;
}

export interface ArchiveSessionInput {
  id: string;
  archived?: boolean;
}

export interface ArchiveSessionResult {
  success?: boolean;
}

export interface CompressSessionInput {
  id: string;
  archived?: boolean;
}

export interface CompressSessionResult {
  success?: boolean;
}

export interface ListQueueMessagesInput {
  id: string;
}

export interface ListQueueMessagesResult {
  items?: QueuedMessageItemView[];
  paused?: boolean;
  pendingCount?: number;
}

export interface GetQueueItemInput {
  id: string;
  itemId: string;
}

export interface GetQueueItemResult {
  item?: QueuedMessageItemView;
}

export interface EnqueueMessageInput {
  id: string;
  content?: string;
  model?: ModelSelectionInput;
  attachments?: AttachmentInput[];
  clientRequestId?: string;
  expiresAt?: number;
  reviewRequest?: ReviewRequest;
  clientIntent?: string;
}

export interface EnqueueMessageResult {
  itemId?: string;
  status?: string;
  position?: number;
}

export interface UpdateQueueItemInput {
  id: string;
  itemId: string;
  content?: string;
  model?: ModelSelectionInput;
  attachments?: AttachmentInput[];
  expiresAt?: number;
}

export interface UpdateQueueItemResult {
  item?: QueuedMessageItemView;
}

export interface ReorderQueueInput {
  id: string;
  itemIds: string[];
}

export interface ReorderQueueResult {
  items?: QueuedMessageItemView[];
}

export interface DeleteQueueItemInput {
  id: string;
  itemId: string;
}

export interface DeleteQueueItemResult {
  item?: QueuedMessageItemView;
}

export interface GetTurnDiffInput {
  id: string;
  assistantMessageId?: string;
}

export interface GetTurnDiffResult {
  fileChanges?: FileDiffInfoView[];
  sourceMessageId?: string;
  changeSetId?: string;
  status?: string;
  revertedAt?: number;
  undoable?: boolean;
  canUndo?: boolean;
  canReapply?: boolean;
}

export interface RequestCompactionInput {
  name: string;
  id: string;
  reason?: string;
  customInstructions?: string;
}

export interface RequestCompactionResult {
  success: boolean;
  sessionId?: string;
  compactionId?: string;
  messagesBefore?: number;
  messagesAfter?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  error?: string;
  code?: string;
}

export interface RevertTurnDiffInput {
  id: string;
  changeSetId?: string;
  assistantMessageId?: string;
}

export interface RevertTurnDiffResult {
  success?: boolean;
  error?: string;
  turnDiff?: TurnDiffView;
}

export interface ReapplyTurnDiffInput {
  id: string;
  changeSetId?: string;
  assistantMessageId?: string;
  turnId?: string;
}

export interface ReapplyTurnDiffResult {
  success: boolean;
  error?: string;
  fileChanges?: FileDiffInfoView[];
  sourceMessageId?: string;
  changeSetId?: string;
  status?: string;
  revertedAt?: number;
  undoable?: boolean;
  canUndo?: boolean;
  canReapply?: boolean;
}

export interface ListSessionFilesInput {
  id: string;
  limit?: number;
  cursor?: string;
}

export interface ListSessionFilesResult {
  nodes?: DriveNode[];
  nextCursor?: string;
  hasMore?: boolean;
}

export interface DriveNode {
  nodeId?: string;
  nodeType?: DriveNodeType;
  parentId?: string;
  name?: string;
  fileExt?: string;
  category?: string;
  mimeType?: string;
  sizeBytes?: number;
  cdnUrl?: string;
  source?: DriveNodeSource;
  sessionId?: string;
  childCount?: number;
  createdAt?: number;
  updatedAt?: number;
  isFavorited?: boolean;
  frontPageScreenshot?: string;
  path?: string;
}

export interface ConnectorActionState {
  canConnect?: boolean;
  canDisconnect?: boolean;
  connectButtonText?: string;
  disabledReason?: string;
}

export interface ConnectorConnectionView {
  status?: string;
  connectedAtMs?: number;
  expiresAtMs?: number;
  lastUsedAtMs?: number;
  statusReason?: string;
}

export interface ReviewRequest {
  scope: string;
}

export interface PluginPackageVersion {
  name: string;
  version: string;
  archiveSha256: string;
  contentDigest: string;
}

export interface PluginCapabilitySummary {
  appCount: number;
  mcpServerCount: number;
  skillCount: number;
  hookCount?: number;
}

export interface PluginAppInfo {
  provider: string;
  displayName?: string;
  logoUrl?: string;
  status?: string;
  connection?: ConnectorConnectionView;
  actions?: ConnectorActionState;
  darkLogoUrl?: string;
}

export interface PluginMcpServerInfo {
  name: string;
  transport: string;
  description?: string;
  configJson: string;
}

export interface PluginSkillInfo {
  name: string;
  displayName?: string;
  description?: string;
  content: string;
}

export interface PluginMarketplaceSummary {
  name: string;
  version?: string;
  displayName?: string;
  description?: string;
  author?: string;
  iconUrl?: string;
  capabilities: PluginCapabilitySummary;
  installExists: boolean;
  enabled: boolean;
  category?: MarketplaceCategory;
  darkIconUrl?: string;
  installationPolicy?: PluginInstallationPolicy;
}

export interface PluginMarketplaceDetail {
  summary: PluginMarketplaceSummary;
  apps: PluginAppInfo[];
  mcpServers: PluginMcpServerInfo[];
  skills: PluginSkillInfo[];
  exampleQueries?: string[];
}

export interface GithubPluginSource {
  repositoryUrl: string;
  commitSha: string;
  subPath?: string;
}

export interface PluginImportDiagnostic {
  code: string;
  capability?: string;
  name?: string;
}

export interface PreviewGithubPluginInput {
  url: string;
}

export interface GithubPluginPreview {
  summary: PluginMarketplaceSummary;
  skillCount: number;
  mcpServerCount: number;
  hasStdioMcp: boolean;
}

export interface PreviewGithubPluginResult {
  source: GithubPluginSource;
  plugin: GithubPluginPreview;
  diagnostics: PluginImportDiagnostic[];
  packageSizeBytes: number;
  canImport: boolean;
}

export interface ImportGithubPluginInput {
  source: GithubPluginSource;
}

export interface ImportGithubPluginResult {
  plugin: PluginMarketplaceSummary;
}

export interface PluginCapabilityProvenance {
  pluginName: string;
  pluginVersion?: string;
  source: InstalledPluginSource;
  capabilityType: PluginCapabilityType;
  capabilityName: string;
  iconUrl?: string;
  darkIconUrl?: string;
}

export interface InstalledPluginSummary {
  name: string;
  version?: string;
  displayName?: string;
  description?: string;
  author?: string;
  iconUrl?: string;
  capabilities: PluginCapabilitySummary;
  source: InstalledPluginSource;
  enabled: boolean;
  category?: MarketplaceCategory;
  darkIconUrl?: string;
  installationPolicy?: PluginInstallationPolicy;
}

export interface ListMarketplacePluginsInput {
  cursor?: string;
  limit?: number;
  keyword?: string;
  category?: MarketplaceCategory;
  skillCursor?: string;
  skillLimit?: number;
  source?: InstalledPluginSource;
  skillSourceType?: SkillSourceType;
  skillSortType?: SkillSortType;
}

export interface ListMarketplacePluginsResult {
  plugins: PluginMarketplaceSummary[];
  nextCursor?: string;
  hasMore?: boolean;
  marketplaceSkills?: SkillHubItem[];
  skillNextCursor?: string;
  skillHasMore?: boolean;
  pluginTotal?: number;
  cursorResetRequired?: boolean;
}

export interface GetMarketplacePluginInput {
  pluginName: string;
  source?: InstalledPluginSource;
}

export interface GetMarketplacePluginResult {
  plugin?: PluginMarketplaceDetail;
}

export interface ListInstalledPluginsInput {
  cursor?: string;
  limit?: number;
  keyword?: string;
}

export interface ListInstalledPluginsResult {
  plugins: InstalledPluginSummary[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface EnabledPluginSummary {
  name: string;
  displayName?: string;
  iconUrl?: string;
  darkIconUrl?: string;
}

export interface ListEnabledPluginsInput {}

export interface ListEnabledPluginsResult {
  plugins: EnabledPluginSummary[];
}

export interface MutatePluginInput {
  pluginName: string;
  source?: InstalledPluginSource;
}

export interface MutatePluginResult {
  source: InstalledPluginSource;
  installExists: boolean;
  enabled: boolean;
  package?: PluginPackageVersion;
  installationPolicy?: PluginInstallationPolicy;
}

export interface CreatorInfo {
  userId?: string;
  userName?: string;
  avatarUrl?: string;
}

export interface SkillInfo {
  name: string;
  displayName?: string;
  description?: string;
  displayDescription?: string;
  scope?: SkillScope;
  sourceType?: SkillSourceType;
  agentName?: string;
  url?: string;
  id?: number;
  createdAt?: number;
  updatedAt?: number;
  creatorInfo?: CreatorInfo;
  locationUri?: string;
  displayNames?: Record<string, string>;
  descriptions?: Record<string, string>;
  sourceKind?: string;
  enabled?: boolean;
  publisherSourceType?: SkillSourceType;
}

export interface SkillHubItem {
  id: number;
  name: string;
  displayName?: string;
  description?: string;
  displayDescription?: string;
  content?: string;
  sourceUrl?: string;
  sourceType?: SkillSourceType;
  creatorInfo?: CreatorInfo;
  useCount?: number;
  added?: boolean;
  createdAt?: number;
  updatedAt?: number;
  category?: MarketplaceCategory;
}

export interface SkillFileInfo {
  name: string;
  path: string;
  isDir?: boolean;
}

export interface ListRuntimeSkillsInput {
  agentName?: string;
  sessionId?: string;
  workspaceDir?: string;
  includePluginSkills?: boolean;
}

export interface ListRuntimeSkillsResult {
  skills?: SkillInfo[];
  refreshedAt?: number;
}

export interface AgentDetail {
  name?: string;
  displayName?: string;
  agentRole?: string;
  rootSessionId?: string;
  agentConfigDir?: string;
  createdAt?: number;
  updatedAt?: number;
  defaultWorkspaceDir?: string;
  userDefaultWorkspaceDir?: string;
  creationSource?: AgentCreationSource;
  avatar?: string;
  description?: string;
  persona?: string;
  systemPrompt?: string;
}

export interface ListAgentsInput {
  limit?: number;
  offset?: number;
  search?: string;
  include?: string;
  excludePrimary?: boolean;
}

export interface ListAgentsResult {
  agents?: AgentDetail[];
}

export interface CreateAgentInput {
  name?: string;
  displayName?: string;
  persona?: string;
  systemPrompt?: string;
  description?: string;
  avatar?: string;
  defaultWorkspaceDir?: string;
  avatarObjectKey?: string;
  definitionOnly?: boolean;
  initialDefinition?: AgentConfiguredDefinition;
}

export interface CreateAgentResult {
  name?: string;
  rootSessionId?: string;
}

export interface GetAgentInput {
  name: string;
  include?: string;
}

export interface GetAgentResult {
  agent?: AgentDetail;
}

export interface UpdateAgentInput {
  name: string;
  displayName?: string;
  persona?: string;
  systemPrompt?: string;
  description?: string;
  avatar?: string;
  avatarObjectKey?: string;
}

export interface UpdateAgentResult {
  success?: boolean;
  agent?: AgentDetail;
}

export interface DeleteAgentInput {
  name: string;
}

export interface DeleteAgentResult {
  success?: boolean;
}

export interface AgentConfiguredMavisFields {
  displayName?: string;
  avatar?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  defaultWorkspaceDir?: string;
  extensionSkills?: string[];
}

export interface AgentConfiguredDefinition {
  name: string;
  description: string;
  model?: string;
  effort?: string;
  tools?: string[];
  disallowedTools?: string[];
  mcpServers?: string[];
  skills?: string[];
  mavis?: AgentConfiguredMavisFields;
  systemPrompt: string;
}

export interface CronSessionConfig {
  mode?: string;
  sessionId?: string;
  keepSessions?: number;
}

export interface ActiveHours {
  start?: string;
  end?: string;
}

export interface CronTask {
  cronId?: string;
  cronName?: string;
  agentName?: string;
  schedule?: string;
  timezone?: string;
  enabled?: boolean;
  prompt?: string;
  session?: CronSessionConfig;
  activeHours?: ActiveHours;
  status?: string;
  lastRun?: number;
  lastResult?: string;
  lastError?: string;
  nextRun?: number;
  projectId?: number;
  model?: ModelSelectionInput;
  scheduleKind?: ScheduleKind;
  runAt?: number;
  runCount?: number;
}

export interface CreateCronInput {
  name: string;
  cronName: string;
  schedule?: string;
  prompt?: string;
  timezone?: string;
  activeHours?: ActiveHours;
  session?: CronSessionConfig;
  enabled?: boolean;
  projectId?: number;
  model?: ModelSelectionInput;
  scheduleKind?: ScheduleKind;
  runAt?: number;
  runCount?: number;
}

export interface UpdateCronInput {
  cronId: string;
  enabled?: boolean;
  schedule?: string;
  timezone?: string;
  activeHours?: ActiveHours;
  prompt?: string;
  session?: CronSessionConfig;
  projectId?: number;
  model?: ModelSelectionInput;
  scheduleKind?: ScheduleKind;
  runAt?: number;
  runCount?: number;
}

export interface CronDeliveryRequest {
  cronId: string;
  runId: string;
  sessionId: string;
  text: string;
}

export interface CronDeliveryResult {
  delivered: boolean;
  errorCode?: string;
  error?: string;
}

export interface GoalVerificationSummary {
  backend?: string;
  verdict?: string;
  reason?: string;
  missing?: string[];
  notMetStreak?: number;
  at?: number;
}

export interface GoalExecutionState {
  waitReason?: string;
  waitSince?: number;
}

export interface GoalState {
  goalId?: string;
  sessionId?: string;
  objective?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  tokenBudget?: number;
  hasKickoffAttachments?: boolean;
  turnsUsed?: number;
  statusReason?: string;
  lastVerification?: GoalVerificationSummary;
  execution?: GoalExecutionState;
  objectiveResources?: AttachmentInput[];
}

export interface CreateGoalInput {
  sessionId: string;
  objective?: string;
  tokenBudget?: number;
  attachments?: AttachmentInput[];
  objectiveResources?: AttachmentInput[];
}

export interface PatchGoalInput {
  sessionId: string;
  status?: string;
  objective?: string;
  tokenBudget?: number;
  objectiveResources?: AttachmentInput[];
  expectedGoalId?: string;
  expectedUpdatedAt?: number;
}

export interface PendingPermissionItem {
  requestId?: string;
  toolName?: string;
  ruleContents?: string[];
  toolInput?: string;
  toolDescription?: string;
  reason?: string;
  sessionId?: string;
  agentName?: string;
  allowAlwaysSupported?: boolean;
  createdAt?: number;
}

export interface ReplyPermissionInput {
  name: string;
  requestId: string;
  reply: PermissionReply;
  message?: string;
}

export interface ReplyPermissionResult {
  success?: boolean;
}

export interface ListPendingPermissionsInput {}

export interface ListPendingPermissionsResult {
  requests?: PendingPermissionItem[];
}

export interface QuestionnaireImage {
  src: string;
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
}

export interface QuestionnaireOption {
  id: string;
  label: string;
  description?: string;
  image?: QuestionnaireImage;
  recommended?: boolean;
}

export interface QuestionnaireStep {
  id: string;
  header?: string;
  question: string;
  description?: string;
  image?: QuestionnaireImage;
  selectionMode: QuestionnaireSelectionMode;
  options?: QuestionnaireOption[];
  allowOther: boolean;
  otherPlaceholder: string;
  required: boolean;
}

export interface QuestionnaireToolCall {
  messageId: string;
  callId: string;
}

export interface QuestionnaireRequester {
  sessionId: string;
  runId?: string;
  toolCallId?: string;
  agentName?: string;
}

export interface QuestionnairePresentation {
  replaceComposer: boolean;
  showProgress: boolean;
  allowBackNavigation: boolean;
}

export interface QuestionnairePlanReviewView {
  markdown: string;
  path: string;
}

export interface QuestionnaireModePayload {
  featureKey?: string;
  planReview?: QuestionnairePlanReviewView;
}

export interface QuestionnaireRequestView {
  schemaVersion: number;
  id: string;
  title?: string;
  tool?: QuestionnaireToolCall;
  requester?: QuestionnaireRequester;
  presentation: QuestionnairePresentation;
  steps: QuestionnaireStep[];
  expiresAt?: number;
  status?: QuestionnaireStatus;
  createdAt?: number;
  mode?: string;
  modePayload?: QuestionnaireModePayload;
  purpose?: QuestionnairePurpose;
}

export interface QuestionnaireReplyAnswer {
  stepId: string;
  selectedOptionIds?: string[];
  selectedOther?: boolean;
  otherText?: string;
  skipped?: boolean;
}

export interface ReplyQuestionnaireInput {
  name: string;
  requestId: string;
  schemaVersion: number;
  answers: QuestionnaireReplyAnswer[];
  submittedAt?: number;
}

export interface ReplyQuestionnaireResult {
  ok: boolean;
  requestId: string;
  sessionId: string;
  agentName?: string;
  answeredAt: number;
}

export interface DismissQuestionnaireInput {
  name: string;
  requestId: string;
}

export interface DismissQuestionnaireResult {
  ok: boolean;
  requestId: string;
  sessionId: string;
  agentName?: string;
  dismissedAt: number;
}

export interface GetPendingQuestionnaireInput {
  name: string;
  sessionId: string;
}

export interface GetPendingQuestionnaireResult {
  request?: QuestionnaireRequestView;
}

export interface GetLatestPlanReviewInput {
  name: string;
  sessionId: string;
}

export interface GetQuestionnaireResult {
  request?: QuestionnaireRequestView;
  status?: QuestionnaireStatus;
  sessionId?: string;
  agentName?: string;
  createdAt?: number;
  answeredAt?: number;
  dismissedAt?: number;
}

export interface LocalMcpServerSummary {
  name: string;
  enabled: boolean;
  transport?: string;
  description?: string;
  configJson: string;
  endpoint?: string;
}

export interface ListLocalMcpServersInput {
  keyword?: string;
}

export interface ListLocalMcpServersResult {
  servers: LocalMcpServerSummary[];
}
