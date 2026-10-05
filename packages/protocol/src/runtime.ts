/** In-process Agent configuration and event data. Retain event enum values for existing session replay; excludes cloud control, session exchange, and authentication transport. */

export const RUNTIME_EVENT_SCHEMA = "archon.runtime.event.v1" as const;

export const CRON_REQUEST_SOURCE_HEADER =
  "X-Mavis-Cron-Request-Source" as const;

export enum InstalledPluginSource {
  OFFICIAL = 1,
  LOCAL = 2,
}

export enum PluginCapabilityType {
  APP = 1,
  MCP = 2,
  SKILL = 3,
}

export enum ProtocolErrorCode {
  INVALID_REQUEST = 1,
  NOT_FOUND = 2,
  PERMISSION_DENIED = 3,
  CONFLICT = 4,
  TIMEOUT = 5,
  ABORTED = 6,
  RUNTIME_UNAVAILABLE = 7,
  INTERNAL = 8,
  USAGE_LIMIT_EXCEEDED = 42212,
  INTERNAL_ERROR = 50001,
  LLM_CREDITS_EXHAUSTED = 50110,
  LLM_RATE_LIMITED = 50111,
  LLM_AUTH_ERROR = 50112,
  LLM_UPSTREAM_ERROR = 50113,
  LLM_MIGRATION_ERROR = 50114,
  SAFETY_UNAVAILABLE = 50200,
  SAFETY_SENSITIVE = 50201,
  CORRUPTED_THINKING = 60001,
}

export enum PermissionPolicyType {
  ALWAYS_ALLOW = 1,
  ALWAYS_ASK = 2,
  DENY = 3,
}

export enum ThinkingLevel {
  OFF = 1,
  MINIMAL = 2,
  LOW = 3,
  MEDIUM = 4,
  HIGH = 5,
  XHIGH = 6,
}

export enum ThinkingMode {
  SWITCHABLE = 1,
  FORCED_ON = 2,
}

export enum HookEvent {
  SESSION_START = 1,
  SESSION_END = 2,
  USER_PROMPT_SUBMIT = 3,
  PRE_TOOL_USE = 4,
  POST_TOOL_USE = 5,
  MESSAGE_COMPLETE = 6,
  STREAM_CHUNK = 7,
  STREAM_CHUNK_THRESHOLD = 8,
}

export enum HookType {
  SCRIPT = 1,
  PROMPT = 2,
}

export enum MemoryScope {
  USER = 1,
  AGENT = 2,
  SESSION_LEGACY = 3,
}

export enum HostToolCapability {
  SHELL = 1,
  MAVIS_BASE = 2,
  FILE = 3,
  MEMORY = 4,
  WEB = 5,
  OTHER = 6,
  BASE = 7,
  CONNECTOR = 8,
}

export enum AttachmentKind {
  FILE = 0,
  IMAGE = 1,
  VIDEO = 2,
  AUDIO = 3,
}

export enum RuntimeActionType {
  PERMISSION = 1,
  USER_QUESTION = 2,
}

export enum RuntimeStopReasonType {
  END_TURN = 1,
  REQUIRES_ACTION = 2,
  ERROR = 3,
  ABORT = 4,
}

export enum RuntimeEventStatus {
  RUNNING = 1,
  WAITING_ACTION = 2,
  IDLE = 3,
  FAILED = 4,
  ABORTED = 5,
  COMPLETED = 6,
}

export enum RuntimeEventType {
  STREAM_RESP = 1,
  ACTION_REQUIRED = 2,
  SESSION_STATUS = 3,
  TURN_TERMINAL = 4,
  DEBUG_TRACE = 5,
  MESSAGE_PERSISTED = 6,
}

export enum RuntimeDebugTraceLevel {
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
}

export enum AgentToolMode {
  OMIT = 1,
  INLINE = 2,
  TOOL_SEARCH = 3,
}

export enum SystemReminderFrequencyType {
  FIRST_TURN_ONLY = 1,
  EVERY_TURN = 2,
  TURN_BACKOFF = 3,
  COOLDOWN = 4,
  ONE_SHOT = 5,
}

export interface IPluginRef {
  name: string;
  version: string;
  data_oss_key: string;
  archive_sha256: string;
  content_digest: string;
  icon_url?: string;
  dark_icon_url?: string;
}

export interface IPluginCapabilityProvenance {
  plugin_name: string;
  plugin_version?: string;
  source: InstalledPluginSource;
  capability_type: PluginCapabilityType;
  capability_name: string;
  icon_url?: string;
  dark_icon_url?: string;
}

export interface IProtocolError {
  code: ProtocolErrorCode;
  message: string;
  details?: string;
}

export interface IPermissionPolicy {
  type: PermissionPolicyType;
}

export interface IModelCapabilities {
  support_image?: boolean;
  support_video?: boolean;
  max_image_bytes_inline?: number | string;
  max_video_bytes_inline?: number | string;
  max_request_body_bytes?: number | string;
  max_attachments_count?: number;
  /** Most images one provider request may carry; older history images become placeholders. */
  max_images_per_request?: number | string;
  support_files_api?: boolean;
  max_video_bytes_files_api?: number | string;
  files_api_upload_endpoint?: string;
  files_api_ref_scheme?: string;
  files_api_file_id_ttl_sec?: number;
  thinking_mode?: ThinkingMode;
}

export interface IThinkingBudgets {
  minimal?: number | string;
  low?: number | string;
  medium?: number | string;
  high?: number | string;
}

export interface IModelRef {
  provider: string;
  model_id: string;
  thinking_level?: ThinkingLevel;
  base_url?: string;
  api_key?: string;
  capabilities?: IModelCapabilities;
  context_window?: number;
  max_tokens?: number;
  api?: string;
  npm?: string;
  thinking_off_behavior?: string;
  thinking_effort?: string;
  thinking_budgets?: IThinkingBudgets;
}

export interface IConnectorToolConfig {
  provider: string;
  provider_tool_name: string;
  runtime_tool_name: string;
  description: string;
  input_schema_json: string;
  output_schema_json?: string;
  agent_tool_mode?: AgentToolMode;
}

export interface IToolConfig {
  capability: HostToolCapability;
  enabled?: boolean;
  permission_policy?: IPermissionPolicy;
  connector_tools?: Array<IConnectorToolConfig>;
}

export interface ISkillRef {
  name: string;
  description?: string;
  agent_id?: number | string;
  data_oss_key?: string;
  mutable?: boolean;
  global?: boolean;
}

export interface IHookRef {
  name: string;
  event: HookEvent;
  hook_type: HookType;
  description?: string;
  priority?: number;
  matcher?: string;
  timeout_ms?: number;
  body: string;
  enabled?: boolean;
  hook_id?: number | string;
}

export interface IMemoryPolicy {
  enabled: boolean;
  inject_brief?: boolean;
  inject_relevant?: boolean;
  enable_topics?: boolean;
  scope: MemoryScope;
  content?: string;
  summary?: string;
  daily_digest?: string;
  topic_files?: Array<IMemoryTopicFile>;
}

export interface IMemoryTopicFile {
  name: string;
  description: string;
  size_bytes: number;
}

export interface ITeamConfig {
  enable: boolean;
}

export interface ISubagentTypeConfig {
  type: string;
  description?: string;
  system_prompt?: string;
  model?: IModelRef;
  tools?: Array<string>;
  hidden?: boolean;
}

export interface ISystemReminderFrequency {
  type: SystemReminderFrequencyType;
  intervals?: Array<number>;
  reset_on_compaction?: boolean;
  milliseconds?: number;
}

export interface ISystemReminderThresholds {
  rotate_threshold_factor?: number;
  rotate_threshold_cap?: number;
  todo_reminder_interval_turns?: number;
  cooldown_ms?: number;
}

export interface ISystemReminderEntry {
  name: string;
  critical: boolean;
  frequency?: ISystemReminderFrequency;
  thresholds?: ISystemReminderThresholds;
}

export interface IEvalCaptureConfig {
  enabled: boolean;
  sample_rate?: number;
}

export interface IAgentConfig {
  system_prompt: string;
  model: IModelRef;
  tools: Array<IToolConfig>;
  skills: Array<ISkillRef>;
  hooks?: Array<IHookRef>;
  permission_policy?: IPermissionPolicy;
  team?: ITeamConfig;
  title?: string;
  description?: string;
  memories?: Array<IMemoryPolicy>;
  persona?: string;
  display_name?: string;
  timezone?: string;
  locale?: string;
  agent_id?: number | string;
  system_reminders?: Array<ISystemReminderEntry>;
  subagent_types?: Array<ISubagentTypeConfig>;
  creation_source?: number;
  eval_capture?: IEvalCaptureConfig;
  background_task_enabled?: boolean;
  plugins?: Array<IPluginRef>;
  tool_list_authoritative?: boolean;
  agent_role?: number;
}

export interface IRuntimeUsage {
  input_tokens?: number | string;
  output_tokens?: number | string;
  total_tokens?: number | string;
  context_window?: number | string;
  cache_read?: number | string;
  cache_write?: number | string;
  thinking_duration_ms?: number;
  cost?: number;
}

export interface IRuntimeAction {
  action_id: string;
  action_type: RuntimeActionType;
  tool_call_id?: string;
  presentation_json?: string;
}

export interface IRuntimeStopReason {
  type: RuntimeStopReasonType;
  action_ids?: Array<string>;
  message?: string;
}

export interface IRuntimeDebugTrace {
  phase: string;
  level: RuntimeDebugTraceLevel;
  message: string;
  span_id?: string;
  parent_span_id?: string;
  duration_ms?: number;
  attrs_json?: string;
  details_json?: string;
}

export interface IRuntimeEventPayload {
  stream_resp?: string;
  action_ids?: Array<string>;
  actions?: Array<IRuntimeAction>;
  status?: RuntimeEventStatus;
  stop_reason?: IRuntimeStopReason;
  usage?: IRuntimeUsage;
  error?: IProtocolError;
  trace?: IRuntimeDebugTrace;
  message_id?: string;
  body_json?: string;
  runtime_kind?: string;
}

export interface IAttachment {
  file_oss_key?: string;
  file_url?: string;
  kind?: AttachmentKind;
  mime_type?: string;
  file_name?: string;
}

export interface IRuntimeEvent {
  schema: string;
  event_id: string;
  session_id: string;
  turn_id?: string;
  runtime_seq?: number | string;
  type: RuntimeEventType;
  payload: IRuntimeEventPayload;
}
