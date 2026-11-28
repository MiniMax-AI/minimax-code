export interface TuiAttachmentView {
  meta?: {
    attachmentType?: string;
    fileName?: string;
    mimeType?: string;
    sizeBytes?: number;
  };
  local?: { assetId?: string; filePath?: string; dataUrl?: string };
  cloud?: {
    uploadId?: string;
    driveNodeId?: string;
    url?: string;
    dataUrl?: string;
  };
  previewUrl?: string;
  status?: string;
}

export interface TuiQueuedMessage {
  itemId: string;
  sessionId: string;
  status: string;
  source?: string;
  reviewRequest?: { scope: 'local_changes' };
  content?: string;
  attachments?: TuiAttachmentView[];
  modelInfo?: {
    providerId?: string;
    modelId?: string;
    variant?: string;
    displayName?: string;
  };
  createdAt?: number;
  expiresAt?: number;
  startedAt?: number;
  finishedAt?: number;
  failedReason?: string;
}

export interface TuiQuestionnaireImage {
  src: string;
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
}

export interface TuiQuestionnaireOption {
  id: string;
  label: string;
  description?: string;
  image?: TuiQuestionnaireImage;
  recommended?: true;
}

export interface TuiQuestionnaireStep {
  id: string;
  header?: string;
  question: string;
  description?: string;
  image?: TuiQuestionnaireImage;
  selectionMode: 0 | 1 | 'single' | 'multiple';
  options?: TuiQuestionnaireOption[];
  allowOther: boolean;
  otherPlaceholder: string;
  required: boolean;
}

export interface TuiQuestionnaireRequest {
  schemaVersion: number;
  id: string;
  title?: string;
  tool?: { messageId: string; callId: string };
  requester?: {
    sessionId: string;
    runId?: string;
    toolCallId?: string;
    agentName?: string;
  };
  presentation: {
    replaceComposer: boolean;
    showProgress: boolean;
    allowBackNavigation: boolean;
  };
  steps: TuiQuestionnaireStep[];
  expiresAt?: number;
  status?: number | string;
  createdAt?: number;
  purpose?: 'general' | 'goal';
  mode?: string;
  modePayload?: {
    featureKey?: string;
    planReview?: {
      markdown: string;
      path: string;
    };
  };
}

export interface TuiQuestionnaireReplyAnswer {
  stepId: string;
  selectedOptionIds?: string[];
  selectedOther?: boolean;
  otherText?: string;
  skipped?: boolean;
}

export type TuiStructuredPreviewState = 'proposed' | 'applied' | 'not-applied';

export interface TuiDiffPreviewBlock {
  kind: 'diff';
  path?: string;
  diff: string;
  addedLines: number;
  removedLines: number;
  truncated: boolean;
  omittedLines?: number;
}

export interface TuiFilePreviewBlock {
  kind: 'file';
  path?: string;
  content: string;
  lineCount: number;
  truncated: boolean;
  omittedLines?: number;
}

export interface TuiPreviewSummaryBlock {
  kind: 'summary';
  path?: string;
  message: string;
  reason: 'binary' | 'too-large' | 'unavailable';
  byteCount?: number;
}

export type TuiStructuredPreviewBlock =
  | TuiDiffPreviewBlock
  | TuiFilePreviewBlock
  | TuiPreviewSummaryBlock;

export interface TuiStructuredPreview {
  schemaVersion: 1;
  state: TuiStructuredPreviewState;
  blocks: TuiStructuredPreviewBlock[];
}

export interface TuiPendingPermission {
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
  structuredPreview?: TuiStructuredPreview;
}

export interface TuiModel {
  providerId: string;
  modelId: string;
  displayName?: string;
  selected?: boolean;
  variant?: string;
  supportedVariants?: string[];
  contextLimit?: number;
  contextWindowOptions?: number[];
  contextWindowOptionHints?: Record<string, 'higher_usage'>;
  maxOutputTokens?: number;
  thinkingConfig?: {
    mode?: string;
    defaultValue?: string;
  };
  /** Ordered think-effort levels the model accepts; empty when unsupported. */
  effortOptions?: string[];
  /** Catalog default, including a fixed effort without editable options. */
  defaultEffort?: string;
  /** Runtime projects the saved global or Session selection onto the selected row. */
  thinking?: { effort?: string };
  /** Present on starred models; `favoriteOrder` ascends in the order they were added. */
  favorite?: boolean;
  favoriteOrder?: number;
  providerName?: string;
  providerSource?: string;
  providerKind?: string;
  apiFormat?: string;
  status?: {
    state?: string;
    lastTestedAt?: number;
    lastErrorCode?: string;
    lastErrorMessage?: string;
  };
}

export interface TuiSessionUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  turns?: number;
}

export interface TuiSessionUsageRow {
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

export interface TuiSessionUsage {
  summary?: TuiSessionUsageSummary;
  rows?: TuiSessionUsageRow[];
}

export interface TuiCompactionResult {
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

export interface TuiSkill {
  name: string;
  displayName?: string;
  description?: string;
  displayDescription?: string;
  scope?: number;
  sourceType?: number;
  agentName?: string;
  url?: string;
  id?: number;
  createdAt?: number;
  updatedAt?: number;
  locationUri?: string;
  displayNames?: Record<string, string>;
  descriptions?: Record<string, string>;
  sourceKind?: string;
  enabled?: boolean;
}

export interface TuiSkillList {
  skills?: TuiSkill[];
  hasMore?: boolean;
}

export interface TuiMcpServer {
  name: string;
  enabled: boolean;
  transport?: string;
  description?: string;
  sourceKind?: 'builtin' | 'configured';
  sourceScope?: 'project' | 'session';
  managed?: boolean;
  status?: 'available' | 'configured' | 'disabled' | 'error' | 'unavailable';
  available?: boolean;
  error?: string;
  tools?: Array<{ name: string; description?: string }>;
  configJson?: string;
}

/** Runtime-owned MCP OAuth state; independent from the server's connection status. */
export type TuiMcpAuthState =
  | 'unknown'
  | 'not_required'
  | 'static'
  | 'needs_auth'
  | 'authorizing'
  | 'authorized'
  | 'needs_reauth'
  | 'failed';

/** Identifies one remote MCP server by its credential source. */
export type TuiMcpAuthTarget =
  | { kind: 'user'; serverName: string }
  | { kind: 'project'; serverName: string; sessionId: string; workspaceRoot: string }
  | {
      kind: 'plugin';
      serverName: string;
      pluginName: string;
      pluginMarketplace: string;
      pluginSource: string;
    };

/** How one authorization attempt ended. */
export type TuiMcpAuthAttemptOutcome = 'authorized' | 'failed' | 'cancelled' | 'expired';

export interface TuiMcpAuthStateView {
  target: TuiMcpAuthTarget;
  authState: TuiMcpAuthState;
  reason?: string;
  missingScopes?: string[];
  /** Unix ms. */
  expiresAt?: number;
  serverOrigin?: string;
  issuer?: string;
  /** The attempt in progress. */
  attemptId?: string;
  /**
   * The most recent finished attempt. A failed reauthorization keeps the previous token, so
   * `authState` alone cannot tell whether a given attempt succeeded.
   */
  lastAttemptId?: string;
  lastAttemptOutcome?: TuiMcpAuthAttemptOutcome;
  lastAttemptErrorCode?: string;
}

/** Shown before the browser opens for project and non-official Plugin sources. */
export interface TuiMcpAuthConfirmation {
  sourceLabel: string;
  serverOrigin: string;
  issuer: string;
  clientId: string;
  authorizationHost?: string;
}

export type TuiMcpAuthStartResult =
  | {
      status: 'pending';
      attemptId: string;
      authUrl: string;
      requiresConfirmation: boolean;
      confirmation?: TuiMcpAuthConfirmation;
    }
  | { status: 'already_authorized' }
  | { status: 'unsupported'; errorCode: string }
  | { status: 'failed'; errorCode: string };

export interface TuiMcpAuthOutcome {
  state: TuiMcpAuthStateView;
  errorCode?: string;
}

export interface TuiMcpAuthClearResult {
  state: TuiMcpAuthStateView;
  revoked: boolean;
}

/**
 * Project servers are listed only with a scope. A Session id alone resolves its workspace;
 * `mcode mcp --project` passes a synthetic Session id with the directory's realpath.
 */
export interface TuiMcpAuthScope {
  sessionId?: string;
  workspaceRoot?: string;
}

export interface TuiQueueReceipt {
  itemId?: string;
  status?: string;
  position?: number;
}
