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
import type { BashOperations } from '@earendil-works/pi-coding-agent';
import type { TSchema } from '@sinclair/typebox';

import type { AskUserAdapter } from '../ask-user/types.js';
import type { LocalPermissionExecutionPlan } from './permission-execution.js';
import type { SavedPtcScript } from './saved-ptc-scripts.js';

import type {
  LocalBashToolInput,
  LocalTaskToolInput,
  LocalTodoWriteToolInput,
  LocalWebFetchToolInput,
  LocalMemoryToolInput,
  LocalMavisToolInput,
  LocalCodeReviewToolInput,
} from './builtin-defs.js';
import type { DesktopToolErrorCode } from './desktop-tool-result.js';
import type { WebSearchInput } from '../shared/web-search.js';

/**
 * Plugin subagent definition (official or LOCAL package) from the Turn
 * capability lease. Selectors use the Custom Agent encoding: `undefined`
 * inherits, `[]` explicitly disables.
 */
export interface LocalPluginAgentDefinition {
  /** Task target `<plugin>:<agent>`. */
  readonly scopedName: string;
  readonly pluginName: string;
  readonly agentName: string;
  readonly sourceFormat: 'minimax' | '\u0063\u006c\u0061\u0075\u0064\u0065';
  /** Package origin; absent only for producers that predate official Plugin subagents. */
  readonly origin?: 'official' | 'local';
  readonly packageDigest: string;
  readonly pluginRoot: string;
  readonly description: string;
  readonly displayName?: string;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
  readonly extensionSkills?: readonly string[];
  /** MCP server names this Plugin package declares, whether or not they published tools. */
  readonly declaredMcpServers?: readonly string[];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export interface LocalPluginAgentRoster {
  list(): readonly LocalPluginAgentDefinition[];
  /** Case-insensitive `<plugin>:<agent>` lookup. */
  resolve(scopedName: string): LocalPluginAgentDefinition | undefined;
}

/**
 * A Computer Use grant for one task, built by the assignment tools from the Turn's trusted
 * `computerUseGrantSource`. The runtime verifies it again (an IM sender must be the Bot's verified
 * creator), then saves a Computer Use selection for that task Session only, so its Turns get the
 * computer_* tools.
 */
export type AssignmentComputerUseGrant =
  | { readonly source: 'desktop' }
  | { readonly source: 'channel'; readonly channel: AssignmentOriginChannelAddress };

export interface LocalRuntimeToolContext extends ToolExecutionContext {
  /** Project folders besides the workspace root, supplied by the Runtime for this Turn. */
  readonly workspaceRoots?: readonly string[];
  /** Frozen from the final Turn catalog; false keeps ordinary Bash synchronous. */
  readonly allowBashAutoPromotion?: boolean;
  /**
   * Frozen from the final Turn catalog when the host assembles it. Background
   * task results need a trusted native `task_output`; only `true` permits a
   * default or explicit background task launch.
   */
  readonly canConsumeBackgroundTaskOutput?: boolean;
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
  /**
   * Frozen from the trusted built-in Agent profile (`x-mavis.coordination`).
   * Absent for every ordinary or untrusted Agent; tools read coordinator
   * behavior from here, never from `agentName`.
   */

  /** Turn-scoped writer supplied by hosted runtimes after tool catalog assembly. */
  readonly eventWriter?: PiEventWriter;
  /**
   * Turn-owned event identity and delivery surface. Hosted runtimes inject one
   * reporter shared with Pi so native side-stream events cannot fork the
   * canonical runtime sequence.
   */
  readonly reporter?: TurnEventReporter;
  readonly agentName?: string;
  /**
   * Frozen at Turn assembly from the session interaction mode, the same fact
   * the `<ask-user-policy>` reminder uses. ask_user reads it to pick the Plan
   * policy; entering or leaving Plan always ends the Turn.
   */
  readonly askUserPlanActive?: boolean;
  /**
   * Frozen at Turn assembly: the Session carries `miniAppOrigin`. A Mini App
   * reads a questionnaire from its run result, which exists only once the Turn
   * ends, so ask_user keeps the legacy protocol there instead of waiting.
   */
  readonly askUserMiniAppSession?: boolean;
  /**
   * Frozen at Turn assembly by the trusted preflight (harness `computer-use-grant-policy.ts`):
   * the grant path this Turn's own user message opens. `desktop`: typed in an MCode client with
   * an explicit @Computer Use selection. `channel`: an IM direct message saying `@computer-use`;
   * the runtime still verifies its sender as the Bot's creator from `channelContext`. Absent for
   * Cron, task reports, background deliveries and every other producer.
   */
  readonly computerUseGrantSource?: 'desktop' | 'channel';
  /**
   * Frozen at Turn assembly for a trusted coordinator only (harness `computerUseGrantRoute`):
   * where this Turn's user could grant Computer Use under the grant policy. `channel_unsupported`
   * is an IM chat the policy leaves out; `remote_control` has no Plugin menu. Both can grant
   * only from the MCode desktop app. Absent on older hosts.
   */
  readonly computerUseGrantRoute?: 'desktop' | 'channel' | 'channel_unsupported' | 'remote_control';
  readonly channelContext?: {
    readonly platform: string;
    readonly chatType: string;
    readonly chatId: string;
    readonly senderId: string;
    readonly clientName: string;
    /** Thread/topic the inbound message lived in; IM permission cards render there. */
    readonly threadId?: string;
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
   * Set by the Runtime for a sub-Agent session: its Browser is private, never
   * shown or persisted, and closed when that Agent ends.
   */
  readonly browserEphemeral?: boolean;
  /**
   * Skills successfully read during this turn. The host supplies one mutable
   * set shared by the skill and Browser tools; legacy/test hosts may omit it.
   */
  readonly loadedSkills?: Set<string>;
  /**
   * Plugin subagents (official or LOCAL) frozen with this Turn's capability lease. Absent
   * means no Plugin Agent target is admissible for `task`.
   */
  readonly pluginAgents?: LocalPluginAgentRoster;
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

export type {
  LocalAskUserBeginResult,
  LocalAskUserSyncOutcome,
  LocalAskUserV2BeginResult,
} from '../ask-user/types.js';

export type LocalAskUserAdapter = AskUserAdapter<LocalRuntimeToolContext>;

/** Per-call identity the Runtime supplies to every web_fetch adapter. */
export interface LocalWebFetchCallContext {
  readonly sessionId: string;
  readonly turnId: string;
}

/** Where the returned content came from. */
export type LocalWebFetchVia = 'local' | 'server';

/**
 * Why the Runtime router picked this path. `no_user_session` is deliberately
 * absent from the adapter result: with no platform user the router is a pure
 * pass-through, so the tool result stays byte-identical to the pre-router one.
 */
export type LocalWebFetchRouteReason =
  | 'head_method'
  | 'server_disabled'
  | 'server_backoff'
  | 'server_circuit_open'
  | 'intranet_literal'
  | 'intranet_learned'
  | 'intranet_dns'
  | 'intranet_dns_notfound'
  | 'intranet_dns_error'
  | 'non_html_hint'
  | 'server_ok'
  | 'server_non_html'
  | 'server_fallback_local'
  | 'server_quota_fallback'
  | 'server_busy';

/** Server-reader facts exposed to the model-visible result mapping. */
export interface LocalWebFetchServerProvenance {
  readonly provider?: string;
  readonly cacheHit?: boolean;
  readonly fetchedAtMs?: number;
}

export interface LocalWebFetchAdapterResult {
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
  /** Absent when no routing decision was made; see `LocalWebFetchRouteReason`. */
  via?: LocalWebFetchVia;
  routeReason?: LocalWebFetchRouteReason;
  /** Server-extracted page title; local fetches never carry one. */
  title?: string;
  server?: LocalWebFetchServerProvenance;
}

export interface LocalWebFetchAdapter {
  fetch(
    ctx: LocalWebFetchCallContext,
    input: LocalWebFetchToolInput,
    signal?: AbortSignal,
  ): Promise<LocalWebFetchAdapterResult>;
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
  | 'list_tabs'
  | 'select_tab'
  | 'close_tab'
  | 'mark_tab'
  | 'show_tab'
  | 'release_tab'
  | 'back'
  | 'forward'
  | 'reload'
  | 'click'
  | 'click_and_wait_for_navigation'
  | 'double_click'
  | 'triple_click'
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
  | 'inspect_editable_targets'
  | 'run_script'
  | 'get_js_dialog'
  | 'handle_js_dialog';

/**
 * The adapter's internal action of Browser programs (run_script in program
 * mode): one page operation per call, its input the op of Browser Core's
 * program protocol. Never a model action, never in `capabilities.actions`.
 */
export type LocalBrowserProgramOpAction = 'program_op';

export type LocalBrowserAdapterAction = LocalBrowserToolAction | LocalBrowserProgramOpAction;

export interface LocalBrowserAdapter {
  getCapabilities?(): BrowserProviderCapabilities;
  /** Release provider-owned resources after the logical chat session is deleted. */
  disposeSession?(sessionId: string): Promise<void>;
  /**
   * Turn lifecycle the provider needs for Agent control: release the tab
   * lease and tidy Agent pages at turn end, pause control while ask_user
   * waits for the user. Fire-and-forget; providers without control ignore it.
   */
  notifyLifecycle?(event: LocalBrowserLifecycleEvent): void;
  execute(
    ctx: LocalRuntimeToolContext,
    action: LocalBrowserAdapterAction,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface LocalBrowserLifecycleEvent {
  /**
   * `program_start`/`program_end` bracket one run_script Browser program, so a
   * provider can show Agent activity for the whole program instead of per op.
   */
  readonly type: 'turn_end' | 'program_start' | 'program_end';
  readonly sessionId: string;
  readonly turnId: string;
  /** A sub-Agent session: turn end closes all of its pages. */
  readonly ephemeral?: boolean;
}

export interface BrowserProviderCapabilities {
  readonly provider: string;
  readonly version: number;
  readonly actions: readonly LocalBrowserToolAction[];
  /** Whether a user can safely take over the provider's current visible Browser surface. */
  readonly interactiveTakeover?: boolean;
  /**
   * The provider runs `program_op`, so run_script is a page program on a PTC
   * Turn (`local-browser-program.ts`), also for a provider whose `actions`
   * have no run_script page script.
   */
  readonly programOps?: boolean;
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
  /** Optional display label captured at target resolution; never an Agent key. */
  agentDisplayName?: string;
  /**
   * Task handle for task_query/task_output/task_stop. Present once the runner
   * created a task row, including for a failed or aborted run.
   */
  taskId?: string;
  subSessionId?: string;
  subTurnId?: string;
  finalText?: string;
  errorMessage?: string;
  /** Stable model-visible failure code when the runtime has one. */
  errorCode?: string;
  eventCount?: number;
  verification?: VerificationReport;
  /**
   * PTC scripts the child saved during this run. Recorded by the runtime from
   * the save tool results, not written by the child itself. Present on failed
   * and aborted runs too, because the files are already on disk.
   */
  savedPtcScripts?: readonly SavedPtcScript[];
}

export interface LocalTaskBackgroundStartResult {
  status: 'started' | 'failed';
  agentDisplayName?: string;
  taskId?: string;
  subSessionId?: string;
  subTurnId?: string;
  errorMessage?: string;
  /** Stable model-visible failure code when the runtime has one. */
  errorCode?: string;
  /** Present only where the Runtime enforces a per-Session child-Agent limit. */
  concurrency?: { readonly active: number; readonly limit: number };
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
    /** Additional Project folders the sandbox exposes like the workspace root. */
    workspaceRoots?: readonly string[];
    /** Permission decision snapshot carried across the execution boundary. */
    permissionExecutionPlan?: LocalPermissionExecutionPlan;
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
    /** Additional Project folders the sandbox exposes like the workspace root. */
    workspaceRoots?: readonly string[];
    command: string;
    permissionExecutionPlan?: LocalPermissionExecutionPlan;
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
    onChildStarted?: (input: {
      subSessionId: string;
      subTurnId: string;
      agentDisplayName?: string;
    }) => void,
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
  /** Exact Session and Turn returned by Conversation admission; absent on older adapters. */
  readonly subSessionId?: string;
  readonly subTurnId?: string;
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

export interface LocalCodeReviewExecution {
  agent_name: string;
  agent_display_name?: string;
  sub_session_id: string;
  sub_turn_id: string;
  description?: string;
  status: 'started' | 'succeeded' | 'failed' | 'aborted';
}

export interface LocalCodeReviewRunResult {
  subagentExecutions?: LocalCodeReviewExecution[];
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
    onStarted?: (execution: LocalCodeReviewExecution) => void,
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
 * `website_deploy` 的 local 上传/发布委托。desktop 工具只做本机 fs 校验
 * (目录 + index.html),把"打包 + 上传 + 发布"交给实现方(local-runtime 注入,
 * 走后端 presigned 直传 + 解包发布,本地不持有 OSS 凭据)。
 *
 * 入参是已通过 workspace 围栏的绝对 `dir`、可选 `sourceDir`、`projectName`、`sessionId`;
 * 返回 `cdn_url`(发布后的公网 URL)+ 可选 `node_id` / 本地封面 `cover_path`,失败时填 `base_resp`。
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
    /**
     * 后端限额拒绝（code=19 ENTITLEMENT_LIMIT_EXCEEDED）时透传的 EntitlementDenial
     * 记录（方案 §四-C3）。保持 raw record：字段校验由工具层的容错解析负责。
     */
    entitlement_denial?: Record<string, unknown>;
    base_resp?: { status_code?: number; status_msg?: string };
  }>;
}

export interface LocalMemoryAdapter {
  execute(
    ctx: LocalRuntimeToolContext,
    input: LocalMemoryToolInput,
    signal?: AbortSignal,
  ): Promise<{
    text: string;
    details?: Record<string, unknown>;
    /** Structured copy of the same result for PTC; never shown to the model. */
    data?: Record<string, unknown>;
  }>;
}

export interface LocalWorkspaceSemanticSearchMatch {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

/**
 * The adapter is constructed for one Session by local-runtime. Deliberately
 * no workspace/session/revision selector is accepted from model-authored
 * input.
 */

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

/** The sidebar section (分区) an item sits in, when it sits in one. */
export interface LocalSidebarSectionRef {
  section_id: string;
  name: string;
}

/** One project as the `sidebar.project` tools see it. */
export interface LocalSidebarProjectView {
  project_id: string;
  name: string;
  /** Absolute project folder; the default (no folder) project has none. */
  workspace_dir?: string;
  /**
   * True for the bucket of chats that are in no project. It is not a project
   * the user created: it has no folder, and it is neither renamed nor removed.
   */
  is_default?: boolean;
  session_count: number;
  pinned: boolean;
  hidden: boolean;
  /** Absent while the project is in no section. */
  section?: LocalSidebarSectionRef;
}

export type LocalSidebarProjectPage = {
  projects: LocalSidebarProjectView[];
  has_more: boolean;
  next_cursor?: string;
};

/** One chat as `sidebar_read` reports it. */
export interface LocalSidebarSessionView {
  session_id: string;
  title: string;
  agent_name: string;
  workspace_dir?: string;
  updated_at_ms: number;
  /** Absent while the chat is in no section. */
  section?: LocalSidebarSectionRef;
}

/** One chat inside a section, as `section_list` reports it. */
export interface LocalSidebarSectionSessionView {
  session_id: string;
  title: string;
  workspace_dir?: string;
}

/** One project inside a section, or one of the unsectioned projects. */
export interface LocalSidebarSectionProjectView {
  workspace_dir: string;
  name: string;
  /** Absent for an SSH project, whose chats this Runtime does not hold. */
  session_count?: number;
  pinned?: boolean;
}

export interface LocalSidebarSectionView {
  section_id: string;
  name: string;
  collapsed: boolean;
  /** In the order the sidebar shows them: the section's manual order first. */
  sessions: LocalSidebarSectionSessionView[];
  projects: LocalSidebarSectionProjectView[];
}

export type LocalSidebarSectionsListView = {
  sections: LocalSidebarSectionView[];
  unsectioned_projects: LocalSidebarSectionProjectView[];
  /** Assignments whose chat or project no longer shows in the sidebar. */
  stale_entries: number;
};

export type LocalSidebarSectionCreateResult = {
  section: LocalSidebarSectionRef;
  /** false when a section with that name already existed and was reused. */
  created: boolean;
};

export type LocalSidebarSectionUpdateResult = LocalSidebarSectionRef & { collapsed: boolean };

export type LocalSidebarSectionDeleteResult = {
  section: LocalSidebarSectionRef;
  released_sessions: number;
  released_projects: number;
};

export type LocalSidebarSectionMoveResult = {
  item_type: 'session' | 'project';
  moved: string[];
  /** Ids that matched no visible chat or project. */
  not_found: string[];
  /**
   * Ids whose own move threw. Each move is its own committed write, so the
   * ones in `moved` did land and the sidebar was refreshed for them.
   */
  failed: string[];
  section: LocalSidebarSectionRef | null;
  /** Items that had to be unpinned first, because 置顶 wins over 分区. */
  unpinned: string[];
};

export type LocalSidebarSectionReorderResult = { order: string[] };

export type LocalSidebarViewPage = {
  sessions: LocalSidebarSessionView[];
  /** Pinned items in the order the pinned area shows them. */
  pinned: { item_type: 'agent' | 'session' | 'project'; id: string }[];
  has_more: boolean;
  next_cursor?: string;
};

export type LocalSidebarPinResult = {
  item_type: 'agent' | 'session' | 'project';
  id: string;
  pinned: boolean;
};

export type LocalSidebarArchiveResult = {
  project: { project_id: string; name: string };
  archived_session_ids: string[];
  /** Chats left alone because a Turn is running in them. */
  skipped_running_session_ids: string[];
  failed_session_ids: string[];
};

/**
 * Desktop sidebar seam for the namespaced `sidebar.*` tools. The Runtime owns
 * the data; the tools only drive capabilities the sidebar UI already has. A
 * failure throws an Error carrying a stable `code` from
 * `DESKTOP_TOOL_ERROR_CODES`.
 */
export interface LocalSidebarToolsAdapter {
  listProjects(
    req: { cursor?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<LocalSidebarProjectPage>;
  readSidebar(
    req: { cursor?: string; limit: number },
    signal?: AbortSignal,
  ): Promise<LocalSidebarViewPage>;
  /** Target state, so repeating the same call is a no-op. */
  setPinned(
    req: { item_type: 'agent' | 'session' | 'project'; id: string; pinned: boolean },
    signal?: AbortSignal,
  ): Promise<LocalSidebarPinResult>;
  /** Archives every root chat of the project except the ones running a Turn. */
  archiveProjectSessions(
    req: { project: string },
    signal?: AbortSignal,
  ): Promise<LocalSidebarArchiveResult>;

  // ── sidebar.section ──
  // The Runtime owns the section data, so these are single-item writes: the
  // sidebar UI writes the same rows through its own endpoints and neither side
  // can overwrite the other.

  listSections(signal?: AbortSignal): Promise<LocalSidebarSectionsListView>;
  /** A section with the same name is reused instead of duplicated. */
  createSection(
    req: { name: string },
    signal?: AbortSignal,
  ): Promise<LocalSidebarSectionCreateResult>;
  renameSection(
    req: { section: string; name: string },
    signal?: AbortSignal,
  ): Promise<LocalSidebarSectionUpdateResult>;
  deleteSection(
    req: { section: string },
    signal?: AbortSignal,
  ): Promise<LocalSidebarSectionDeleteResult>;
  /** `section: null` moves the chats out of every section. */
  moveSectionSessions(
    req: { session_ids: string[]; section: string | null; position?: number },
    signal?: AbortSignal,
  ): Promise<LocalSidebarSectionMoveResult>;
  /** `section: null` moves the projects back to the project list. */
  moveSectionProjects(
    req: { workspace_dirs: string[]; section: string | null },
    signal?: AbortSignal,
  ): Promise<LocalSidebarSectionMoveResult>;
  /** `order` is top first; "pinned" is the 置顶 area. */
  reorderSectionBlocks(
    req: { order: string[] },
    signal?: AbortSignal,
  ): Promise<LocalSidebarSectionReorderResult>;
}

/** One UI-channel request: which conversation asked, plus the closed target. */

/**
 * What the desktop UI answered; a failure keeps the code the UI reported as
 * long as it is one of `DESKTOP_TOOL_ERROR_CODES`, so the tool can tell a bad
 * argument (retrying will not help) from the window failing to run the request.
 */
export type LocalUiRequestResult =
  | { readonly ok: true; readonly data: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly code: DesktopToolErrorCode;
      readonly message: string;
    };

/**
 * The "ask the desktop UI to do it" seam. A few capabilities live only in the
 * renderer or the Electron main process; the Runtime raises a request, the UI
 * performs it and replies. Absent on hosts without a desktop window.
 */

/** Whether a chat can be forked, and from which assistant reply. */
export type LocalSessionForkOptions = {
  readonly can_fork: boolean;
  /** Why not, when `can_fork` is false; safe to show the model. */
  readonly unavailable_reason?: string;
  /** The reply the fork would start from when none was named. */
  readonly resolved_assistant_message_id?: string;
  readonly suggested_title?: string;
};

export type LocalSessionForkResult = {
  readonly session_id: string;
  readonly title?: string;
  readonly fork_origin_message_id?: string;
};

/** One event `session_wait` can observe for a watched chat. */
export type LocalSessionWaitEventKind =
  | 'session.finish'
  | 'session.error'
  | 'session.abort'
  | 'permission.ask'
  | 'questionnaire.ask';

export type LocalSessionWaitOutcome = {
  readonly session_id: string;
  readonly event: LocalSessionWaitEventKind;
  readonly turn_id?: string;
  readonly detail?: string;
};

export type LocalSessionWaitResult = {
  /** What ended the wait: an observed event, or the deadline. */
  readonly timed_out: boolean;
  readonly outcomes: readonly LocalSessionWaitOutcome[];
  /** Chats still running when the wait ended. */
  readonly pending_session_ids: readonly string[];
};

/**
 * Session capabilities behind the `session.manage` / `session.dispatch` tools
 * that the Runtime itself owns. A failure throws an Error carrying a stable
 * `code` from `DESKTOP_TOOL_ERROR_CODES`.
 */
export interface LocalSessionManageAdapter {
  /** Whether the chat can be forked, optionally from a named assistant reply. */
  getForkOptions(
    req: { sessionId: string; assistantMessageId?: string },
    signal?: AbortSignal,
  ): Promise<LocalSessionForkOptions>;
  /** `assistantMessageId` absent forks from the most recently completed turn. */
  forkSession(
    req: { sessionId: string; assistantMessageId?: string; title?: string },
    signal?: AbortSignal,
  ): Promise<LocalSessionForkResult>;
  /** Waits until one watched chat reports an event or the deadline passes. */
  waitForSessions(
    req: { sessionIds: readonly string[]; timeoutMs: number },
    signal?: AbortSignal,
  ): Promise<LocalSessionWaitResult>;
}

export type LocalPluginSummary = {
  readonly name: string;
  readonly display_name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly source?: string;
};

export type LocalPluginMutationResult = {
  readonly name: string;
  readonly enabled?: boolean;
  readonly uninstalled?: boolean;
};

/**
 * Plugin capabilities behind the `app` tools. The Runtime owns plugin state,
 * so these need no UI round trip. A failure throws an Error carrying a stable
 * `code` from `DESKTOP_TOOL_ERROR_CODES`.
 */
export interface LocalAppManageAdapter {
  listPlugins(signal?: AbortSignal): Promise<{ plugins: LocalPluginSummary[] }>;
  /** Target state, so repeating the same call is a no-op. */
  setPluginEnabled(
    req: { name: string; enabled: boolean },
    signal?: AbortSignal,
  ): Promise<LocalPluginMutationResult>;
  uninstallPlugin(req: { name: string }, signal?: AbortSignal): Promise<LocalPluginMutationResult>;
}

/**
 * Sidebar write capabilities that are not part of the first `sidebar.*` slice:
 * project create / remove and the pinned-area order. A failure throws an Error
 * carrying a stable `code` from `DESKTOP_TOOL_ERROR_CODES`.
 */
export interface LocalSidebarManageAdapter {
  createProject(
    req: { name: string; workspace_dir?: string },
    signal?: AbortSignal,
  ): Promise<{ project_id: string; name: string; workspace_dir?: string }>;
  /** Renames the project; the new name is content-reviewed before it is written. */
  renameProject(
    req: { project: string; name: string },
    signal?: AbortSignal,
  ): Promise<{ project_id: string; name: string }>;
  /** Hides the project in the sidebar; its chats are kept. */
  removeProject(
    req: { project: string },
    signal?: AbortSignal,
  ): Promise<{ project_id: string; name: string; hidden: boolean }>;
  reorderPinned(
    req: { items: readonly { item_type: 'agent' | 'session' | 'project'; id: string }[] },
    signal?: AbortSignal,
  ): Promise<{ items: { item_type: string; id: string }[] }>;
}
export type LocalMavisCommandInput = LocalMavisToolInput;

export type LocalMavisCronSessionTarget =
  | { readonly mode: 'new' }
  | { readonly mode: 'sessionId'; readonly sessionId: string };

export interface LocalMavisCronExecutionConfig {
  project?: string;
  model?: string;
}

/**
 * 创建入口的目标：`sessionId` 模式可以暂不带 ID。桌面运行时会在首次执行时
 * 建立专用会话并原子绑定，`fixed` 哨兵在工具边界就翻译成这个 pending 形态。
 */
export type LocalMavisCronCreationSessionTarget =
  | { readonly mode: 'new' }
  | { readonly mode: 'sessionId'; readonly sessionId?: string };

export interface LocalMavisCronTask extends LocalMavisCronExecutionConfig {
  cronId?: string;
  cronName?: string;
  agentName?: string;
  schedule?: string;
  scheduleType?: 'cron' | 'once';
  runAtMs?: number;
  timezone?: string;
  enabled?: boolean;
  prompt?: string;
  /** 读取路径必须忠实反映定义：尚未绑定的专用会话缺少 `sessionId`。 */
  session?: LocalMavisCronCreationSessionTarget;
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
 * Cron Definition 的一次执行记录。`cron sessions` 为兼容既有工具名保留，
 * 实际读取的是 Cron v2 的 `ListCronRuns`。
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
 * 旧 Cron 接口的 Session 历史项。
 *
 * 它没有稳定的 Run 身份；`runId` 与 `triggerSource` 保持缺席，避免旧 Session
 * 被伪装成 Cron v2 Run。
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

export interface LocalSelfReminderRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly agentName: string;
  readonly model?: string;
  readonly project?: string;
  readonly prompt: string;
  readonly delaySeconds: number;
}

export interface LocalMavisCronAdapter {
  setSelfReminder?(
    request: LocalSelfReminderRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  cancelSelfReminder?(
    request: { sessionId: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  resolveModel?(
    req: { model: string; sessionId?: string },
    signal?: AbortSignal,
  ): Promise<LocalMavisModelResolution>;
  /**
   * Whether this Agent's schedules wake its main conversation, from the runtime's trusted
   * built-in coordinator capability. Absent on hosts without such Agents.
   */
  targetsMainConversation?(agentName: string): boolean;
  /**
   * Remembers the IM chat a main-conversation Agent created this schedule from, so its runs
   * reply there too. The runtime rechecks the owner and policy; false means nothing stored.
   */
  recordScheduleOrigin?(request: {
    readonly cronId: string;
    readonly agentName: string;
    readonly originChannel: AssignmentOriginChannelAddress;
  }): boolean | Promise<boolean>;
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
    req: LocalMavisCronExecutionConfig & {
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
    req: LocalMavisCronExecutionConfig & {
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
    req: LocalMavisCronExecutionConfig & {
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
    req: LocalMavisCronExecutionConfig & {
      cronId: string;
      cronName?: string;
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

/**
 * Where a `session` read is served from: this Runtime (`local`), an SSH project
 * Runtime (`ssh`), a Remote Control device this desktop controls (`rc`), or the
 * cloud (`cloud`). Remote content is always read live and never cached.
 */
export type LocalMavisSessionSource = 'local' | 'ssh' | 'rc' | 'cloud';

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
  /** Set on ssh / rc / cloud results; local results omit it. */
  source?: Exclude<LocalMavisSessionSource, 'local'>;
  /** ssh / rc: opaque device locator, passed back only to tell same-id sessions apart. */
  deviceId?: string;
  /** ssh: project name; rc: name of the session's project folder. */
  projectName?: string;
  /** ssh: SSH host alias. */
  host?: string;
  /** rc: name of the controlled device. */
  deviceName?: string;
}

/** One remote device that a cross-device `session list` asked, with its own paging state. */
export interface LocalMavisSessionDevice {
  deviceId: string;
  /** ssh: project name; rc: device name. */
  name?: string;
  host?: string;
  status: 'ok' | 'unavailable';
  reason?: string;
  hasMore?: boolean;
  nextCursor?: string;
}

/**
 * The read-only DesktopService calls a desktop host forwards to a connected SSH
 * project. The host builds each request itself; anything else is refused.
 */
export type LocalSshSessionRead =
  | {
      method: 'ListProjectSessions';
      workspaceDir: string;
      agentName?: string;
      limit?: number;
      cursor?: string;
    }
  | { method: 'GetSession'; sessionId: string }
  | { method: 'GetMessages'; sessionId: string; limit?: number; before?: string };

/** Sender identity a remote session receives with a message; reported by the sender. */
export interface LocalRemoteMessageSender {
  sessionId: string;
  deviceName?: string;
  agentName?: string;
  title?: string;
}

/** One DesktopService SendRemoteMessage call; the desktop host builds the request itself. */
export interface LocalRemoteMessageSend {
  sessionId: string;
  content: string;
  sender: LocalRemoteMessageSender;
  delivery?: 'auto' | 'steer';
  idempotencyKey?: string;
}

export interface LocalSshSessionProject {
  /** `ssh-project:<uuid>`. */
  runtimeId: string;
  name: string;
  host: string;
  workspaceDir: string;
  connected: boolean;
  /** Connection state when not connected, e.g. connecting / failed / disconnected. */
  state?: string;
}

/**
 * Desktop-host access to sessions on other machines. The desktop host owns SSH
 * connections and the Remote Control device identity; the Runtime reaches them
 * only through this port.
 */
export interface LocalRemoteSessionHost {
  listSshProjects(signal?: AbortSignal): Promise<LocalSshSessionProject[]>;
  /** Forwards one read to a connected SSH project; the body is the DesktopService response. */
  readSsh(
    runtimeId: string,
    read: LocalSshSessionRead,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
  /** This desktop's Remote Control device id; undefined when the identity is unavailable. */
  getRemoteControlDeviceId(signal?: AbortSignal): Promise<string | undefined>;
  /** Forwards one SendRemoteMessage to a connected SSH project; the body is the DesktopService response. */
  sendSsh(
    runtimeId: string,
    send: LocalRemoteMessageSend,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
}

/** Where a Session created by session_create runs; `current` uses the workspace as is. */
export type LocalMavisSessionLocation =
  | { mode: 'current' }
  | { mode: 'new-worktree'; branch?: string; base?: string }
  | { mode: 'existing-worktree'; worktreeDir: string };

export interface LocalMavisSessionAdapter {
  deleteSession(input: { sessionId: string }, signal?: AbortSignal): Promise<{ success: boolean }>;

  /** The space's context.md: `<goal>` mirrors the space goal, `<summary>` is coordinator. */
  readSpaceContext?(req: { callerSessionId: string; spaceId: string }): Promise<unknown>;
  /**
   * Rewrites the whole `<summary>`, or only the named sections of it; a stale
   * revision is a conflict, never an overwrite. Exactly one of the two is given.
   */
  writeSpaceContext?(req: {
    callerSessionId: string;
    spaceId: string;
    summary?: string;
    sections?: readonly { heading: string; content: string }[];
    revision: string;
  }): Promise<unknown>;
  /** The saved task model and the models the settings offer. */
  listTaskModels?(req: { callerSessionId: string }): Promise<unknown>;
  /** Saves the model the user named, only on an exact catalog match, and reads it back. */
  setTaskModel?(req: { callerSessionId: string; model: string }): Promise<unknown>;
  summarizeAssignments?(req: {
    callerSessionId: string;
    items: readonly {
      sessionId: string;
      summary: string;
      /** The user asked for this task's stopped review to be re-checked and concluded. */
      userAskedRecheck?: boolean;
    }[];
  }): Promise<{
    items: {
      sessionId: string;
      title: string;
      summary: string;
      revision: string;
    }[];
  }>;
  /**
   * Takes a stored review verdict into this turn: only the assigner or its current root may,
   * and only a task the gate is holding with a verdict already stored has one to read.
   */
  claimAssignmentVerdict?(req: { callerSessionId: string; sessionId: string }): Promise<unknown>;
  cancelAssignment?(req: {
    callerSessionId: string;
    sessionId: string;
    reason?: string;
  }): Promise<unknown>;
  /** Stops the running round of one of coordinator tasks; the task stays open. */
  stopAssignment?(req: { callerSessionId: string; sessionId: string }): Promise<unknown>;
  resolveAssignmentProject?(
    callerSessionId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<string | undefined>;
  createAssignment?(
    req: {
      callerSessionId: string;
      project?: string;
      space?: string;
      worktree?: boolean;
      title: string;
      content: string;
      /**
       * Local file paths to hand the task with its first message. Each becomes an asset of the
       * task's own Session; no asset identity crosses over. Omitted, the runtime hands on every
       * file the user attached in the dispatching Turn; an empty list hands on none.
       */
      attachments?: readonly string[];
      /**
       * The user's own words that led to this task, quoted as given. The task record keeps
       * them, and the task instruction and execution reminder show them.
       */
      userWords: string;
      doneWhen?: readonly string[];
      agent?: string;
      reportBack?: boolean;
      requestId?: string;
      /** One of coordinator open tasks this one takes over; it is stopped and closed first. */
      takesOver?: string;
      /**
       * What this task was asked to check. The runtime reads that task's recorded goal,
       * criteria, final reply and delivered files into this task's first message.
       */
      reviewOf?: { readonly sessionId: string; readonly reportKey?: string };
      /** The assigner's Turn that dispatched the task; recorded in task history only. */
      callerTurnId?: string;
      /**
       * The IM chat this dispatch came from, address fields only. Report-back
       * replies for the task go back there; absent on desktop turns.
       */
      originChannel?: AssignmentOriginChannelAddress;
      /** `assignment_create` / `assignment_send` only; see {@link AssignmentComputerUseGrant}. */
      computerUse?: AssignmentComputerUseGrant;
    },
    signal?: AbortSignal,
  ): Promise<{
    sessionId: string;
    title: string;
    projectDir: string;
    projectName: string;
    agentName: string;
    status: 'accepted';
    queued?: boolean;
    reused: boolean;
    reportBack: boolean;
  }>;
  prepareAssignment?(
    req: {
      callerSessionId: string;
      sessionId: string;
      /** Why the assigner sent another round; recorded in task history only. */
      reason?: 'rework' | 'supplement' | 'decision';
      /** The assigner's Turn that sent this round; recorded in task history only. */
      callerTurnId?: string;
      /**
       * The IM chat this dispatch came from, address fields only. Report-back
       * replies for the task go back there; absent on desktop turns.
       */
      originChannel?: AssignmentOriginChannelAddress;
      /** `assignment_create` / `assignment_send` only; see {@link AssignmentComputerUseGrant}. */
      computerUse?: AssignmentComputerUseGrant;
    },
    signal?: AbortSignal,
  ): Promise<{ origin: unknown; reportBack: boolean; title: string; projectName: string }>;

  listSessions(
    req: {
      agentName?: string;
      parentSessionId?: string;
      archiveFilter?: 'Unarchived' | 'Archived';
      cursor?: string;
      limit?: number;
      source?: LocalMavisSessionSource;
      deviceId?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    sessions?: LocalMavisSessionInfo[];
    hasMore?: boolean;
    nextCursor?: string;
    devices?: LocalMavisSessionDevice[];
    /** Model-facing explanation of an empty remote result, e.g. no bound devices. */
    note?: string;
  }>;
  getSession(
    req: { sessionId: string; source?: LocalMavisSessionSource; deviceId?: string },
    signal?: AbortSignal,
  ): Promise<{ session?: LocalMavisSessionInfo }>;
  updateSession(
    req: {
      /** The calling Session, from the runtime context; absent on direct callers. */
      callerSessionId?: string;
      sessionId: string;
      title?: string;
      archived?: boolean;
      /** <provider>/<model>. Takes effect on the next Turn. */
      model?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ session?: LocalMavisSessionInfo; success?: boolean }>;
  /**
   * Stops the target Session's current Turn and keeps the Session. Queued
   * messages still run afterwards; background work and the Goal are untouched.
   */
  interruptSession?(
    req: { callerSessionId: string; sessionId: string; turnId?: string },
    signal?: AbortSignal,
  ): Promise<{ outcome: 'aborted' | 'not_running'; turnId?: string }>;
  /**
   * Why the caller may not create Sessions, such as a coordinator's task
   * Session; undefined when it may. `createSession` refuses the same callers.
   */
  sessionCreateRefusal?(
    callerSessionId: string,
  ): Promise<{ readonly code: string; readonly message: string } | undefined>;
  /**
   * The registered project a session_create `project` names, matched the way
   * assignment_create matches it: `directory` is where the Session runs,
   * `projectDir` the project it belongs to. Rejects with `code` and
   * `candidates` when nothing matches. Absent: the host has no projects.
   */
  resolveSessionProject?(
    project: string,
  ): Promise<{ readonly projectDir: string; readonly directory: string }>;
  /**
   * Creates a parallel visible Session and delivers its first message. The
   * caller identity comes from the runtime context, never from the model.
   */
  createSession?(
    req: {
      callerSessionId: string;
      callerTurnId?: string;
      agentName: string;
      content: string;
      title?: string;
      workspaceDir?: string;
      location?: LocalMavisSessionLocation;
      model?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    sessionId: string;
    agentName: string;
    turnId: string;
    mode: 'started' | 'queued' | 'activated' | 'steered' | 'duplicate';
    location: {
      mode: LocalMavisSessionLocation['mode'];
      workspaceDir: string;
      branch?: string;
    };
  }>;
  listMessages(
    req: {
      sessionId: string;
      limit?: number;
      before?: string;
      source?: LocalMavisSessionSource;
      deviceId?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    messages?: unknown[];
    hasMore?: boolean;
    nextCursor?: string;
    source?: Exclude<LocalMavisSessionSource, 'local'>;
    deviceId?: string;
  }>;
  /**
   * Delivers one message into a reachable, unarchived Session.
   *
   * A local target always takes the message as a steer and the call returns
   * the admission ACK; the target sends any answer back as a session send of
   * its own. `sync` (default false) applies only to ssh / rc / cloud targets,
   * which cannot send back: true waits for the admitted Turn and returns its
   * assistant text.
   */
  sendSession(
    req: {
      callerSessionId: string;
      /** The caller's running Turn, from the runtime context; absent on direct callers. */
      callerTurnId?: string;
      sessionId: string;
      content: string;
      /**
       * Local file paths the sender chose to hand the target with this message. Each becomes
       * an asset of the target's own Session; no asset identity crosses over. Local targets
       * only — a remote target is refused rather than silently dropping them.
       */
      attachments?: readonly string[];
      sync?: boolean;
      /** Local only: queue behind the running Turn instead of steering into it. */
      forceQueue?: boolean;
      reportBack?: boolean;
      /** Why an assigner sent another round; only `assignment_send` sets it. */
      reason?: 'rework' | 'supplement' | 'decision';
      /** `assignment_send` from an IM turn: the chat later report-backs answer in. */
      originChannel?: AssignmentOriginChannelAddress;
      /** `assignment_create` / `assignment_send` only; see {@link AssignmentComputerUseGrant}. */
      computerUse?: AssignmentComputerUseGrant;
      /** Where the target lives; ssh / rc / cloud go through SendRemoteMessage. */
      source?: LocalMavisSessionSource;
      /** ssh / rc: picks one device when the session ID exists on several. */
      deviceId?: string;
    },
    signal?: AbortSignal,
  ): Promise<
    | {
        sessionId: string;
        /** Absent only when a cloud target did not report its Turn. */
        turnId?: string;
        status: 'completed';
        content: string;
        source?: Exclude<LocalMavisSessionSource, 'local'>;
        deviceId?: string;
        note?: string;
      }
    | {
        sessionId: string;
        /** Absent only when a cloud target did not report its Turn. */
        turnId?: string;
        status: 'accepted';
        mode: 'started' | 'queued' | 'activated' | 'steered' | 'duplicate';
        /** Confirmed direct child identity; queue/steer admissions do not start a new round. */
        subagent_executions?: Array<{
          agent_name: string;
          sub_session_id: string;
          sub_turn_id: string;
          parent_session_id: string;
          status: 'started' | 'queued' | 'steered' | 'duplicate';
        }>;
        queue?: { itemId: string; position: number; ahead: number };
        /** Model-facing explanation of what the target Session did with the message. */
        note: string;
        source?: Exclude<LocalMavisSessionSource, 'local'>;
        deviceId?: string;
      }
  >;
}

/**
 * Address of the IM chat an assignment was dispatched from. Routing fields
 * only: channel credentials such as the WeChat context token are never part
 * of it and never stored with the task.
 */
export interface AssignmentOriginChannelAddress {
  readonly platform: string;
  readonly clientName: string;
  readonly chatId: string;
  readonly chatType: string;
  readonly senderId?: string;
  readonly threadId?: string;
}
