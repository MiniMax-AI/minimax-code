import type { RuntimeTool, ToolExecutionContext, ToolResult } from '@mavis/agent-core/tools';
import type { PiEventWriter, TurnEventReporter } from '@mavis/agent-core/pi-turn-runner';
import type {
  BackgroundTask,
  BackgroundTaskStatus,
  TaskOutputReadOptions,
  TaskOutputReadResult,
  TaskQuery,
} from '@mavis/background-task';
import type { IAgentConfig } from '@mavis/protocol';
import type { AskUserToolInput } from '@mavis/shared/questionnaire';
import type { BashOperations } from '@earendil-works/pi-coding-agent';
import type { TSchema } from '@sinclair/typebox';

import type {
  LocalBashToolInput,
  LocalTaskToolInput,
  LocalTodoWriteToolInput,
  LocalWebFetchToolInput,
  LocalMemoryToolInput,
  LocalMavisToolInput,
  LocalCodeReviewToolInput,
} from './builtin-defs.js';
import type { WebSearchInput } from '../shared/web-search.js';

export interface LocalRuntimeToolContext extends ToolExecutionContext {
  /** Frozen from the final Turn catalog; false keeps ordinary Bash synchronous. */
  readonly allowBashAutoPromotion?: boolean;
  /**
   * Frozen from the final Turn catalog when the host assembles it. Explicit
   * background Bash needs a trusted native `task_output` to make its task
   * result consumable. Only `true` permits an explicit background command;
   * embedded callers must set it after admitting that native capability.
   */
  readonly canConsumeBackgroundBashOutput?: boolean;
  /**
   * Set only by the trusted built-in Explore Turn profile. When the local
   * sandbox is enabled, Bash uses its existing read-only filesystem policy.
   */
  readonly forceReadOnlyFilesystem?: boolean;
  /** Turn-scoped writer supplied by hosted runtimes after tool catalog assembly. */
  readonly eventWriter?: PiEventWriter;
  /**
   * Turn-owned event identity and delivery surface. Hosted runtimes inject one
   * reporter shared with Pi so native side-stream events cannot fork the
   * canonical runtime sequence.
   */
  readonly reporter?: TurnEventReporter;
  readonly agentName?: string;
  readonly channelContext?: {
    readonly platform: string;
    readonly chatType: string;
    readonly chatId: string;
    readonly senderId: string;
    readonly clientName: string;
  };
  /**
   * Active agent config for this turn. Optional so older test fixtures and
   * tools that do not need model capabilities keep compiling, but local
   * tools (notably `LocalReadTool`) read `parentAgentConfig.model.capabilities`
   * to gate multimodal inline payloads exactly like the cloud-runtime tools.
   */
  readonly parentAgentConfig?: IAgentConfig;
  /** Native files explicitly attached by the user in this turn. */
  readonly browserAssets?: readonly LocalBrowserAsset[];
  /**
   * Skills successfully read during this turn. The host supplies one mutable
   * set shared by the skill and Browser tools; legacy/test hosts may omit it.
   */
  readonly loadedSkills?: Set<string>;
  /** Parent-turn Plugin Hook generation inherited by a user-visible child Agent. */
  readonly pluginSubagentLifecycle?: {
    start(
      input: {
        childSessionId: string;
        childTurnId: string;
        agentId?: string;
        agentType: string;
        agentTranscriptPath?: string;
        agentCodexTranscriptPath?: string;
      },
      signal?: AbortSignal,
    ): Promise<string | undefined>;
    cancel(childSessionId: string): void;
  };
}

export interface LocalBrowserAsset {
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
}

export type LocalRuntimeTool = RuntimeTool<TSchema, LocalRuntimeToolContext>;

export interface LocalSkillContent {
  readonly content: string;
  readonly location?: string;
  readonly sourceKind?: string;
}

export interface LocalSkillReader {
  readSkill(
    name: string,
    agentName: string | undefined,
    signal?: AbortSignal,
  ): Promise<LocalSkillContent | undefined>;
}

/**
 * Browser-specific session receipt. Other Skills continue to use the existing
 * current-turn `loadedSkills` behavior. When supplied to Browser tools, this
 * store is authoritative so a cleared receipt cannot be bypassed by stale
 * current-turn state after context replacement.
 */
export interface LocalBrowserSkillSessionStore {
  /** Exact Skill identity required by the Browser tools assembled for this Turn. */
  readonly requiredSkillName?: string;
  hasLoaded(sessionId: string, expectedContent?: string): boolean;
  markLoaded(sessionId: string, content?: string): void;
  clearSession(sessionId: string): void;
}

export interface LocalTodoEventSink {
  emitTodoUpdated(
    ctx: LocalRuntimeToolContext,
    todos: LocalTodoWriteToolInput['todos'],
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export type LocalAskUserBeginResult =
  | { requestId: string; schemaVersion: number; stepCount: number }
  | {
      /** Decision v3: the question was superseded by in-flight user steering. */
      suppressed: true;
      reason: 'user-steering-pending';
    };

export interface LocalAskUserAdapter {
  begin(
    ctx: LocalRuntimeToolContext,
    input: AskUserToolInput,
    signal?: AbortSignal,
  ): Promise<LocalAskUserBeginResult>;
}

export interface LocalWebFetchAdapter {
  fetch(
    input: LocalWebFetchToolInput,
    signal?: AbortSignal,
  ): Promise<{
    content?: string;
    status?: number;
    statusText?: string;
    finalUrl?: string;
    contentType?: string;
    /** Raw Retry-After response header value (delta-seconds or HTTP-date). */
    retryAfter?: string;
    bytes?: number;
    truncated?: boolean;
    retrievalOutcome?: LocalWebFetchRetrievalOutcome;
    base_resp?: { status_code?: number; status_msg?: string };
  }>;
}

export interface LocalWebSearchAdapter {
  search(
    ctx: LocalRuntimeToolContext,
    input: WebSearchInput,
    signal?: AbortSignal,
  ): Promise<ToolResult>;
}

export type LocalWebFetchRetrievalOutcome =
  | 'usable_content'
  | 'dynamic_page'
  | 'auth_required'
  | 'access_challenge'
  | 'not_found'
  | 'non_text'
  | 'invalid_request'
  | 'http_error'
  | 'network_error';

export type LocalBrowserToolAction =
  | 'inspect'
  | 'query'
  | 'navigate'
  | 'open_tab'
  | 'return_to_previous_tab'
  | 'back'
  | 'forward'
  | 'reload'
  | 'click'
  | 'click_and_wait_for_navigation'
  | 'double_click'
  | 'drag'
  | 'fill'
  | 'type'
  | 'press_key'
  | 'check'
  | 'uncheck'
  | 'select_option'
  | 'scroll'
  | 'hover'
  | 'wait'
  | 'wait_for'
  | 'get_dom'
  | 'screenshot'
  | 'upload_files'
  | 'paste'
  | 'verify_text'
  | 'inspect_editable_targets';

export interface LocalBrowserAdapter {
  getCapabilities?(): BrowserProviderCapabilities;
  /** Release provider-owned resources after the logical chat session is deleted. */
  disposeSession?(sessionId: string): Promise<void>;
  execute(
    ctx: LocalRuntimeToolContext,
    action: LocalBrowserToolAction,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface BrowserProviderCapabilities {
  readonly provider: string;
  readonly version: number;
  readonly actions: readonly LocalBrowserToolAction[];
  /** Whether a user can safely take over the provider's current visible Browser surface. */
  readonly interactiveTakeover?: boolean;
}

export type ModelVerdict = 'pass' | 'fail' | 'partial';

export type FileChangeObservation =
  | 'no_observed_change'
  | 'change_observed'
  | 'uncertain'
  | 'recording_failed';

export interface VerificationReport {
  modelVerdict?: ModelVerdict;
  fileChange: FileChangeObservation;
  changedFiles?: string[];
  observationNotes: string[];
}

export interface LocalTaskRunResult {
  status: 'succeeded' | 'failed' | 'aborted';
  requestedAgentName: string;
  resolvedAgentName?: string;
  /**
   * Task handle for task_query/task_output/task_stop. Present once the runner
   * created a task row, including for a failed or aborted run.
   */
  taskId?: string;
  subSessionId?: string;
  subTurnId?: string;
  finalText?: string;
  errorMessage?: string;
  eventCount?: number;
  verification?: VerificationReport;
}

export interface LocalTaskBackgroundStartResult {
  status: 'started' | 'failed';
  taskId?: string;
  subSessionId?: string;
  subTurnId?: string;
  errorMessage?: string;
}

export interface LocalBashBackgroundStartResult {
  status: 'started' | 'failed';
  taskId?: string;
  details?: Record<string, unknown>;
  errorMessage?: string;
}

export type LocalBashManagedForegroundResult =
  | {
      status: 'completed';
      taskId: string;
      text: string;
      details?: Record<string, unknown>;
      isError?: boolean;
    }
  | {
      status: 'auto_promoted' | 'failed';
      taskId?: string;
      details?: Record<string, unknown>;
      errorMessage?: string;
    };

export interface LocalSandboxInvocationIdentity {
  operationClass: 'direct_foreground' | 'managed_foreground' | 'explicit_background';
  invocationId: string;
  sessionId: string;
  turnId: string;
  toolCallId?: string;
  taskId?: string;
  /** Carries the frozen trusted Explore restriction across Bash execution modes. */
  forceReadOnlyFilesystem?: boolean;
}

export interface LocalSandboxBashOperationsFactory {
  create(input: {
    identity: LocalSandboxInvocationIdentity;
    workspaceRoot: string;
    /**
     * Runs once the invocation is admitted and wrapped, immediately before the
     * native spawn. Background callers persist `running`/`startedAt` here, so
     * it must never fire for a command Sandbox admission or wrapping rejected.
     */
    onPreflightComplete?: () => void | Promise<void>;
  }): BashOperations;
}

export interface LocalBackgroundBashExecutorResult {
  text: string;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface LocalBackgroundBashExecutor {
  execute(input: {
    identity: LocalSandboxInvocationIdentity;
    workspaceRoot: string;
    command: string;
    timeout?: number;
    signal: AbortSignal;
    onPreflightComplete?: () => void | Promise<void>;
    onOutput?: (content: string, byteLength?: number) => void;
    onDetails?: (details: Record<string, unknown>) => void;
  }): Promise<LocalBackgroundBashExecutorResult>;
}

export interface LocalSandboxBashExecutionPort
  extends LocalSandboxBashOperationsFactory, LocalBackgroundBashExecutor {}

export interface LocalBashAdapter {
  startBackground(
    ctx: LocalRuntimeToolContext,
    input: LocalBashToolInput,
    signal?: AbortSignal,
  ): Promise<LocalBashBackgroundStartResult>;
  /**
   * Start the command under the background-task owner immediately, but keep
   * the tool call in the foreground for a short soft-yield window. This
   * preserves one process when the command outlives the interactive budget.
   */
  runManagedForeground?(
    ctx: LocalRuntimeToolContext,
    input: LocalBashToolInput,
    softYieldMs: number,
    signal?: AbortSignal,
  ): Promise<LocalBashManagedForegroundResult>;
}

export interface LocalTaskAdapter {
  runForeground(
    ctx: LocalRuntimeToolContext,
    input: LocalTaskToolInput,
    signal?: AbortSignal,
  ): Promise<LocalTaskRunResult>;
  startBackground(
    ctx: LocalRuntimeToolContext,
    input: LocalTaskToolInput,
    signal?: AbortSignal,
  ): Promise<LocalTaskBackgroundStartResult>;
}

/**
 * How the appended content entered a Turn. `activated` started a new Turn and
 * therefore a new task, `steered` merged into the Turn already running for the
 * returned task, and `duplicate` replayed a tool call that was already
 * admitted.
 */
export type LocalTaskAppendMode = 'activated' | 'steered' | 'duplicate';

export interface LocalTaskAppendResult {
  /** The task whose output will carry the work, never the child Session id. */
  readonly taskId: string;
  readonly mode: LocalTaskAppendMode;
}

export interface LocalTaskAppendInput {
  readonly taskId: string;
  readonly content: string;
}

/**
 * Deliberately narrow: appending needs a Conversation, so it stays out of the
 * pure task store adapter. The caller identity comes from the runtime tool
 * context, never from model-authored input.
 */
export interface LocalTaskAppendAdapter {
  append(
    ctx: LocalRuntimeToolContext,
    input: LocalTaskAppendInput,
    signal?: AbortSignal,
  ): Promise<LocalTaskAppendResult>;
}

export interface LocalCodeReviewRunResult {
  status: 'prepared' | 'succeeded' | 'failed';
  mode: 'inline' | 'subagent';
  instruction?: string;
  errorMessage?: string;
}

export interface LocalCodeReviewAdapter {
  run(
    ctx: LocalRuntimeToolContext,
    input: LocalCodeReviewToolInput,
    signal?: AbortSignal,
  ): Promise<LocalCodeReviewRunResult>;
}

export interface LocalTaskListResult {
  items: BackgroundTask[];
  nextCursor?: string;
}

export interface LocalTaskOutputReadOptions extends TaskOutputReadOptions {
  /** Optional bounded long-poll. Zero/undefined keeps the existing immediate read. */
  waitMs?: number;
  /** Cancels only the pending read; it never stops the task itself. */
  signal?: AbortSignal;
}

export interface LocalTaskOutputReadResult extends TaskOutputReadResult {
  /** Status read from the same post-wait snapshot as the returned output. */
  status?: BackgroundTaskStatus;
  /** Task facts from the same post-wait snapshot as status. */
  task?: BackgroundTask;
  timedOut?: boolean;
}

export interface LocalTaskControlAdapter {
  get(ctx: LocalRuntimeToolContext, taskId: string): Promise<BackgroundTask | undefined>;
  list(ctx: LocalRuntimeToolContext, query: TaskQuery): Promise<LocalTaskListResult>;
  readOutput(
    ctx: LocalRuntimeToolContext,
    taskId: string,
    options?: LocalTaskOutputReadOptions,
  ): Promise<LocalTaskOutputReadResult>;
  stop(
    ctx: LocalRuntimeToolContext,
    taskId: string,
    reason?: string,
  ): Promise<BackgroundTask | undefined>;
}

export type LocalBackgroundTaskStatus = BackgroundTaskStatus;

/** Stable deploy phases surfaced by the local website deploy adapter. */
export type LocalWebsiteDeployStage =
  | 'adapter'
  | 'validate_site'
  | 'upload_site'
  | 'validate_source'
  | 'upload_source'
  | 'get_upload_url'
  | 'get_upload_url_source'
  | 'upload_archive'
  | 'upload_source_archive'
  | 'publish_archive'
  | 'update_archive';

/** Stable, user-safe classification for adapter throws. */
export type LocalWebsiteDeployFailureReason =
  | 'aborted'
  | 'validation_failed'
  | 'packaging_failed'
  | 'upload_url_rejected'
  | 'transport_failed'
  | 'service_request_failed'
  | 'publish_contract_failed'
  | 'adapter_failed';

/**
 * Adapter failures are deliberately structural: Desktop can classify a local-runtime
 * throw without depending on the runtime implementation class.
 */
export interface LocalWebsiteDeployAdapterFailure extends Error {
  reason: LocalWebsiteDeployFailureReason;
  stage: LocalWebsiteDeployStage;
  retryable: boolean;
}

/**
 * Local upload/publication delegate for `website_deploy`. Desktop tools validate local fs
 * (directory + index.html), then delegate packaging + upload + publication to the implementation
 * injected by local-runtime, using backend presigned upload + unpacking/publication without local
 * OSS credentials.
 *
 * Inputs: an absolute `dir` already checked against the workspace boundary, optional `sourceDir`,
 * `projectName`, and `sessionId`. Returns `cdn_url` (public URL), optional `node_id` / local cover
 * `cover_path`, and `base_resp` on failure.
 */
export interface LocalWebsiteDeployAdapter {
  deploy(
    input: {
      dir: string;
      sourceDir?: string;
      nodeId?: string;
      projectName: string;
      sessionId: string;
      turnId?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    cdn_url?: string;
    node_id?: string;
    cover_path?: string;
    error_code?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  }>;
}

export interface LocalMemoryAdapter {
  execute(
    ctx: LocalRuntimeToolContext,
    input: LocalMemoryToolInput,
    signal?: AbortSignal,
  ): Promise<{ text: string; details?: Record<string, unknown> }>;
}

export interface LocalMavisAgentDetail {
  name?: string;
  displayName?: string;
  agentRole?: string;
  rootSessionId?: string;
  agentConfigDir?: string;
  createdAt?: number | string;
  updatedAt?: number | string;
  defaultWorkspaceDir?: string;
  userDefaultWorkspaceDir?: string;
  creationSource?: number;
  avatar?: string;
  description?: string;
  persona?: string;
  systemPrompt?: string;
}

export interface LocalMavisAgentReadScope {
  canonicalName: string;
}

export interface LocalMavisAgentAdapter {
  listAgents(
    req: {
      limit?: number;
      offset?: number;
      search?: string;
      include?: string;
      excludePrimary?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<{ agents?: LocalMavisAgentDetail[]; baseResp?: Record<string, unknown> }>;
  createAgent(
    req: {
      name?: string;
      displayName?: string;
      persona?: string;
      systemPrompt?: string;
      description?: string;
      avatar?: string;
      defaultWorkspaceDir?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ name?: string; rootSessionId?: string; baseResp?: Record<string, unknown> }>;
  getAgent(
    req: { name: string; include?: string },
    signal?: AbortSignal,
  ): Promise<{ agent?: LocalMavisAgentDetail; baseResp?: Record<string, unknown> }>;
  updateAgent(
    req: {
      name: string;
      displayName?: string;
      persona?: string;
      systemPrompt?: string;
      description?: string;
      avatar?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    success?: boolean;
    agent?: LocalMavisAgentDetail;
    baseResp?: Record<string, unknown>;
  }>;
  deleteAgent(
    req: { name: string },
    signal?: AbortSignal,
  ): Promise<{ success?: boolean; baseResp?: Record<string, unknown> }>;
  resolveAgentReadScope(
    requestedName: string,
    signal?: AbortSignal,
  ): Promise<LocalMavisAgentReadScope>;
  resolveAgentWriteTarget(requestedName: string, signal?: AbortSignal): Promise<string>;
  requireExactAgentKey(requestedName: string, signal?: AbortSignal): Promise<string>;
}

export type LocalMavisMcpTransport = 'stdio' | 'http' | 'streamable-http' | 'sse';

export interface LocalMavisMcpCreateRequest {
  name: string;
  transport: LocalMavisMcpTransport;
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  description?: string;
  enabled?: boolean;
}

export interface LocalMavisMcpUpdateRequest {
  name: string;
  transport?: LocalMavisMcpTransport;
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number | null;
  description?: string | null;
  enabled?: boolean;
}

/**
 * MCP settings seam for the model-visible `mavis` tool. Implementations own
 * persistence and redaction; model-visible return values must never contain
 * environment-variable or header values.
 */
export interface LocalMavisMcpAdapter {
  listServers(req: { search?: string }, signal?: AbortSignal): Promise<{ servers: unknown[] }>;
  getServer(req: { name: string }, signal?: AbortSignal): Promise<{ server?: unknown }>;
  createServer(req: LocalMavisMcpCreateRequest, signal?: AbortSignal): Promise<{ server: unknown }>;
  updateServer(req: LocalMavisMcpUpdateRequest, signal?: AbortSignal): Promise<{ server: unknown }>;
  deleteServer(req: { name: string }, signal?: AbortSignal): Promise<{ success: boolean }>;
}

export type LocalMavisCommandInput = LocalMavisToolInput;

export type LocalMavisCronSessionTarget =
  | { readonly mode: 'new' }
  | { readonly mode: 'sessionId'; readonly sessionId: string };

export type LocalMavisCronCreationSessionTarget =
  | { readonly mode: 'new' }
  | { readonly mode: 'sessionId'; readonly sessionId?: string };

export interface LocalMavisCronTask {
  cronId?: string;
  cronName?: string;
  agentName?: string;
  schedule?: string;
  scheduleType?: 'cron' | 'once';
  runAtMs?: number;
  timezone?: string;
  enabled?: boolean;
  prompt?: string;
  session?: LocalMavisCronSessionTarget;
  activeHours?: { start?: string; end?: string };
  status?: string;
  lastRun?: number | string;
  lastResult?: string;
  lastError?: string;
  nextRun?: number | string;
  project?: string;
  model?: string;
}

/**
 * One execution record for a Cron Definition. `cron sessions` retains the existing tool name for
 * compatibility but actually reads Cron v2 `ListCronRuns`.
 */
export interface LocalMavisCronRun {
  runId: string;
  sessionId?: string;
  createdAt: number;
  deliveredAt?: number;
  failedAt?: number;
  status: 'pending' | 'delivered' | 'failed';
  triggerSource: 'manual' | 'scheduled';
  errorCode?: string;
  error?: string;
}

/**
 * Session history entry from the legacy Cron API.
 *
 * It has no stable Run identity; omit `runId` and `triggerSource` rather than presenting a legacy
 * Session as a Cron v2 Run.
 */
export interface LocalMavisCronLegacySession {
  runId?: never;
  triggerSource?: never;
  sessionId?: string;
  createdAt?: number | string;
  title?: string;
  status?: string;
}

export type LocalMavisCronHistoryItem = LocalMavisCronRun | LocalMavisCronLegacySession;

export type LocalMavisModelResolution =
  | { readonly kind: 'resolved'; readonly model: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
  | { readonly kind: 'not_found' };

export interface LocalMavisCronAdapter {
  resolveModel?(
    req: { model: string; sessionId?: string },
    signal?: AbortSignal,
  ): Promise<LocalMavisModelResolution>;
  listCrons(
    req: { agentName?: string; cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<{
    tasks: LocalMavisCronTask[];
    count?: number;
    hasMore?: boolean;
    nextCursor?: string;
  }>;
  getCron(req: { cronId: string }, signal?: AbortSignal): Promise<{ task?: LocalMavisCronTask }>;
  createCron(
    req: {
      agentName: string;
      cronName: string;
      schedule: string;
      prompt: string;
      timezone?: string;
      activeHours?: { start?: string; end?: string };
      session: LocalMavisCronCreationSessionTarget;
      enabled?: boolean;
      project?: string;
      model?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ task?: LocalMavisCronTask }>;
  createSelfReminder(
    req: {
      agentName: string;
      sessionId: string;
      every: string;
      prompt: string;
      cronName?: string;
      timezone?: string;
      quietOnSkip?: boolean;
      project?: string;
      model?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    agentName?: string;
    cronName?: string;
    schedule?: string;
    sessionId?: string;
    task?: LocalMavisCronTask;
  }>;

  createOnceCron(
    req: {
      agentName: string;
      cronName?: string;
      after?: string;
      at?: string | number;
      prompt: string;
      timezone?: string;
      session: LocalMavisCronCreationSessionTarget;
      project?: string;
      model?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    agentName?: string;
    cronName?: string;
    runAtMs?: number;
    sessionId?: string;
    task?: LocalMavisCronTask;
  }>;
  updateCron(
    req: {
      cronId: string;
      schedule?: string;
      prompt?: string;
      timezone?: string;
      activeHours?: { start?: string; end?: string };
      session?: LocalMavisCronSessionTarget;
      enabled?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<{ task?: LocalMavisCronTask }>;
  deleteCron(req: { cronId: string }, signal?: AbortSignal): Promise<{ success?: boolean }>;
  triggerCron(
    req: { cronId: string },
    signal?: AbortSignal,
  ): Promise<{
    success?: boolean;
    runId?: string;
    sessionId?: string;
    triggeredAt?: string;
    createdAt?: number;
    status?: LocalMavisCronRun['status'];
    triggerSource?: LocalMavisCronRun['triggerSource'];
    errorCode?: string;
    reason?: string;
  }>;
  listCronSessions(
    req: { cronId: string; cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<{
    sessions: LocalMavisCronHistoryItem[];
    total?: number;
    hasMore?: boolean;
    nextCursor?: string;
  }>;
}

export interface LocalMavisSessionInfo {
  sessionId?: string;
  agentName?: string;
  sessionType?: number | string;
  title?: string | null;
  parentSessionId?: string | null;
  archived?: boolean;
  pinned?: boolean;
  status?: unknown;
  createdAt?: number | string;
  updatedAt?: number | string;
  workspaceDir?: string;
  isDefaultWorkspace?: boolean;
  visibility?: string;
  purpose?: string;
  lastActiveAt?: number | string;
}

export interface LocalMavisSessionAdapter {
  listSessions(
    req: {
      agentName?: string;
      parentSessionId?: string;
      archiveFilter?: 'Unarchived' | 'Archived';
      cursor?: string;
      limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<{ sessions?: LocalMavisSessionInfo[]; hasMore?: boolean; nextCursor?: string }>;
  getSession(
    req: { sessionId: string; source?: 'local' | 'cloud' },
    signal?: AbortSignal,
  ): Promise<{ session?: LocalMavisSessionInfo }>;
  updateSession(
    req: { sessionId: string; title?: string; archived?: boolean },
    signal?: AbortSignal,
  ): Promise<{ session?: LocalMavisSessionInfo; success?: boolean }>;
  deleteSession(req: { sessionId: string }, signal?: AbortSignal): Promise<{ success?: boolean }>;
  listMessages(
    req: { sessionId: string; limit?: number; before?: string; source?: 'local' | 'cloud' },
    signal?: AbortSignal,
  ): Promise<{ messages?: unknown[]; hasMore?: boolean; nextCursor?: string }>;
  sendSession(
    req: { callerSessionId: string; sessionId: string; content: string },
    signal?: AbortSignal,
  ): Promise<{
    sessionId: string;
    turnId: string;
    status: 'completed';
    content: string;
  }>;
}
