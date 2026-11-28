import { STORAGE_RETENTION_POLICY_NAMES, STORAGE_RETENTION_OUTCOMES } from '../storage-cleanup.js';
import { LLM_ERROR_REASONS } from '../llm-error-classifier.js';
import { LOCAL_RESOURCE_ERROR_KINDS } from '../local-resource-errors.js';
import { METRICS_DROP_REASONS, type MetricLabels, type MetricsClient } from '../metrics-proxy.js';
import { LEGACY_METRIC_NAMES } from './legacy-metric-names.js';

/**
 * Metric registry for the local runtime and the Desktop app (registry as code).
 *
 * Every metric added or changed since the registry was introduced is defined
 * here exactly once: type, unit, help text, consumer, the label keys with the
 * closed set of values each label may take, and the standard bucket set of a
 * histogram. Report through {@link incrementMetric} and {@link observeMetric}:
 * an unregistered name, an unknown or missing label key, or an enumerated
 * label value that is not listed fails to compile. A label in `optionalLabels`
 * may be left out: the series without it carry no such key, never an empty
 * value. The untyped metric calls (`.counter()`, `.histogram()`, `.gauge()`,
 * `.incr()`, `.latency()`) may name only the metrics that predate the registry,
 * listed in `legacy-metric-names.ts`; they migrate here as their call sites
 * change. Lint (`scripts/lint/metric-registry-lint.cjs`) and the registry test
 * check every such call: its name is a listed literal, a const initialized with
 * one, or a parameter typed {@link AllowedMetricName}.
 *
 * Rules every entry follows (unit tests enforce them):
 * - Names are bare `<module>_<metric>_<unit>`; gateway-app prepends
 *   `local_runtime_` on ingest. Counters end in `_total`, after the unit when
 *   they accumulate one (`_ms_total`).
 * - A histogram uses one of {@link STANDARD_BUCKETS} unchanged, so it never has
 *   more than ten boundaries. Changing a definition or its buckets means a new
 *   name; keep the old one until the app versions that emit it retire. A
 *   metric that shipped before the registry keeps its shipped buckets through
 *   {@link legacyBuckets}; only the names frozen in the registry test may.
 * - Adding a label with bounded values keeps the name: sums over the labels
 *   the metric had stay the same, and gateway-app accepts one metric's series
 *   with different label keys (v0.2.51, !222). Changing what it measures or
 *   its buckets needs a new name.
 * - Label values are bounded enums, optional labels included. `model` and
 *   `provider` are the exceptions: clients report the raw value and
 *   gateway-app bounds it on ingest
 *   (`internal/metrics/label_values.go`: vendor groups for `model`; minimax,
 *   minimax_api, openai-codex and custom_provider for `provider`), so they are
 *   marked {@link INGEST_NORMALIZED} instead of enumerated.
 * - Histograms never declare `appVersion`; gateway-app drops it from them.
 *
 * The module is platform neutral (no Node.js APIs) so the renderer can share
 * the definitions.
 */

/** Standard histogram boundaries. Milliseconds unless noted. */
export const STANDARD_BUCKETS = {
  /** Gateway internals, preparation stages, safety first chunk, transport, UI render. */
  FAST: [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 10_000],
  /** First output and response-header waits. */
  TTFT: [500, 1_000, 1_500, 2_000, 3_000, 5_000, 8_000, 10_000, 30_000, 120_000],
  /** First visible output and first paint in the UI. */
  VISIBLE: [2_000, 3_000, 5_000, 8_000, 10_000, 15_000, 20_000, 30_000, 60_000, 120_000],
  /** Whole requests. */
  TOTAL: [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000],
  /**
   * A namespaced builtin tool call or a ui.request round trip: a local read
   * answers in milliseconds, an archive or a UI deadline runs into minutes.
   */
  TOOL_CALL: [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 120_000, 300_000],
  /** Item counts such as queue depth (items, not milliseconds). */
  COUNT: [0, 1, 2, 5, 10, 25, 50, 100, 250, 1_000],
  /** Age of the oldest queued item: one minute to seven days. */
  AGE: [
    60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
    259_200_000, 604_800_000,
  ],
} as const;

export type StandardBucketSet = keyof typeof STANDARD_BUCKETS;

/** Marks a label bounded by gateway-app on ingest instead of by this registry. */
export const INGEST_NORMALIZED = Object.freeze({ normalizedOnIngest: true } as const);

/** Boundaries a histogram shipped with before the registry; see {@link legacyBuckets}. */
export interface LegacyBuckets {
  readonly legacy: readonly number[];
}

/**
 * Keep the boundaries a histogram shipped with before the registry: changing
 * them would need a new name. Only the names frozen in the registry test may
 * use this; every new histogram picks a {@link StandardBucketSet}.
 */
export function legacyBuckets(bounds: readonly number[]): LegacyBuckets {
  return Object.freeze({ legacy: Object.freeze([...bounds]) });
}

type LabelValues = readonly string[] | typeof INGEST_NORMALIZED;

interface MetricDefinitionBase {
  readonly help: string;
  /** Who reads the metric; a metric nobody queries for 90 days gets removed. */
  readonly consumer: string;
  /** Labels every series of the metric carries. */
  readonly labels: Readonly<Record<string, LabelValues>>;
  /**
   * Labels only some series carry; the others have no such key (no empty
   * value). Never one of `labels`.
   */
  readonly optionalLabels?: Readonly<Record<string, LabelValues>>;
  /**
   * Set while a metric is being replaced: names the replacement. It keeps
   * reporting until its consumers move, then the entry is removed.
   */
  readonly deprecated?: string;
}

export interface CounterDefinition extends MetricDefinitionBase {
  readonly type: 'counter';
  /** `count` counts events; `ms` accumulates milliseconds. */
  readonly unit: 'count' | 'ms';
}

export interface HistogramDefinition extends MetricDefinitionBase {
  readonly type: 'histogram';
  /** `items` uses the COUNT buckets; `ms` uses a time bucket set. */
  readonly unit: 'ms' | 'items';
  readonly buckets: StandardBucketSet | LegacyBuckets;
}

export type MetricDefinition = CounterDefinition | HistogramDefinition;

function enumValues<T extends string>(...lists: ReadonlyArray<readonly T[]>): readonly T[] {
  return [...new Set(lists.flat())];
}

const SUPERVISOR_OS = ['darwin', 'win32', 'linux'] as const;
/** `RunTurnCaller` plus the `unknown` fallback of turn metrics. */
const PI_CALLERS = [
  'chat',
  'cron',
  'channel_feishu',
  'team',
  'compact',
  'permission_llm',
  'unknown',
] as const;
/**
 * `SafetyStage` in packages/harness/src/agent-host/safety/contracts.ts, in the
 * snake_case the registry requires: the harness stage vocabulary uses hyphens
 * and maps them onto these values at the emit site.
 */
const SAFETY_METRIC_STAGES = ['input', 'output', 'thinking', 'tool_args', 'tool_result'] as const;
/** `ToolReviewStage`: the two stages the harness reviews around a tool call. */
const TOOL_REVIEW_METRIC_STAGES = ['tool_args', 'tool_result'] as const;
/** `SafetyVerdict['kind']` in packages/harness/src/agent-host/safety/contracts.ts. */
const SAFETY_METRIC_VERDICTS = ['pass', 'block', 'regenerate', 'unavailable'] as const;
/** The two Hosts that run harness content safety; `unknown` when a Host names none. */
const SAFETY_METRIC_HOSTS = ['cloud', 'desktop', 'unknown'] as const;
/** `PtcChildFullOutputOutcome` in packages/agent-tools/src/core-tools/bash-tool.ts. */
const PTC_CHILD_FULL_OUTPUT_OUTCOMES = ['restored', 'over_limit', 'unavailable'] as const;
/**
 * `ModelCallRoute` in packages/config/src/model-availability.ts, plus
 * `unknown` for calls whose host does not resolve one (title generation and
 * other helper calls). The cloud runtime reports none of the route labels: it
 * keeps the Pi metrics it shipped before the registry.
 */
export const MODEL_CALL_ROUTE_LABELS = [
  'managed_token_plan',
  'minimax_api_key',
  'custom_provider',
  'configured_provider',
  'unknown',
] as const;
export type ModelCallRouteLabel = (typeof MODEL_CALL_ROUTE_LABELS)[number];
/** Copies `UtilityRuntimeRecoveryReasonCode` in apps/electron utility-runtime-observer.ts. */
const RUNTIME_RECOVERY_REASONS = [
  'process_exit',
  'init_failed',
  'bootstrap_timeout',
  'handshake_failed',
  'env_prepare_failed',
  'memory_pressure',
  'runtime_unresponsive',
  'oom',
  'network_service_lost',
  'crash_loop',
  'runtime_owner_conflict',
  'unknown',
] as const;
/** Copies `TurnErrorSource` in agent-core pi-turn-runner/metrics.ts. */
const TURN_ERROR_SOURCES = [
  'llm',
  'before_llm_hook',
  'tool',
  'history',
  'event_bridge',
  'message_identity',
  'event_writer',
  'turn_end_hook',
  'runner',
  'unknown',
] as const;
/** Copies `NonLLMTurnErrorKind` in agent-core pi-turn-runner/metrics.ts. */
const NON_LLM_TURN_ERROR_KINDS = [
  'hook_error',
  'persistence',
  'revision_conflict',
  'duplicate_append',
  'late_write',
  'translation',
  'identity',
  'delivery',
  'runtime_error',
  'unknown',
] as const;
const TURN_FAILURE_ERROR_KINDS = enumValues(
  LLM_ERROR_REASONS,
  NON_LLM_TURN_ERROR_KINDS,
  LOCAL_RESOURCE_ERROR_KINDS,
);
/** Copies `WorkspaceIndexingStage` in local-runtime-v2 workspace/indexing/scan/metrics.ts. */
const WORKSPACE_INDEXING_STAGES = [
  'scan',
  'archive',
  'prepare',
  'upload',
  'register',
  'remote_wait',
  'download',
  'install',
  'ready',
  'search',
] as const;
const WORKSPACE_INDEXING_OS = ['darwin', 'linux', 'win32', 'other'] as const;
const BOOLEAN_VALUES = ['true', 'false'] as const;
/** Copies `LLMCallScope` in agent-core pi-turn-runner/llm-retry.ts (shipped values). */
const LLM_CALL_SCOPES = [
  'agent',
  'compaction',
  'title',
  'archive-title',
  'memory',
  'goal-evaluator',
  'miniapp-ideas',
  'handoff-recommendation',
  'handoff-summary',
  'ppt',
  'probe',
  'advisor',
  'extension',
] as const;
/** `LLMCallErrorKind` in agent-core pi-turn-runner/llm-retry.ts. */
const LLM_CALL_ERROR_KINDS = enumValues(LLM_ERROR_REASONS, LOCAL_RESOURCE_ERROR_KINDS, [
  'none',
] as const);
/**
 * Long-tail latency boundaries the Pi request histograms and local-runtime-v2
 * host-metrics.ts shipped with before the registry: up to 5 minutes, so
 * multi-minute turns and compactions stay resolvable. New histograms use a
 * {@link StandardBucketSet}.
 */
export const LONG_TAIL_HISTOGRAM_BOUNDS = Object.freeze([
  100, 250, 500, 1_000, 2_500, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
] as const);
const LONG_TAIL_BUCKETS = legacyBuckets(LONG_TAIL_HISTOGRAM_BOUNDS);
export const AGENT_KIND_LABELS: readonly string[] = [] as const;
const CONTEXT_COMPACTION_PHASES = ['initial', 'iteration', 'manual'] as const;
export type AgentKindLabel = (typeof AGENT_KIND_LABELS)[number];
const AGENT_KIND_LABEL = { agentKind: AGENT_KIND_LABELS } as const;
/**
 * `wake` of the turn-level first-output metrics: `user` when a person
 * started any input of the turn's starting batch in a client (a message from
 * the composer, the TUI, an ACP client or IM, a questionnaire answer, an
 * edited and resent message, a Mini App action, /review), otherwise
 * `system` (task reports, cron runs, finished background tasks, messages
 * from other sessions, Goal continuations, unknown producers).
 */
export const TURN_WAKE_LABELS = ['user', 'system'] as const;
export type TurnWakeLabel = (typeof TURN_WAKE_LABELS)[number];
/**
 * `conversation` of the turn-level first-output metrics: `new` when the
 * session history before the turn's own input holds no user, assistant or
 * compaction summary message, otherwise `existing`. A continuation appends
 * no input, so its whole history counts. Hosts that do not say get `existing`.
 */
export const TURN_CONVERSATION_LABELS = ['new', 'existing'] as const;
export type TurnConversationLabel = (typeof TURN_CONVERSATION_LABELS)[number];
/** Copies the components of `PluginSystemMetrics.snapshot` in local-runtime-v2. */
const PLUGIN_SNAPSHOT_COMPONENTS = [
  'official_plugin',
  'local_plugin',
  'enabled_plugin',
  'app_provider',
  'skill',
  'mcp_server',
  'mcp_tool',
  'diagnostic',
] as const;
/**
 * `PtcSurface` in local-runtime-v2
 * service/turn-system/agent-host/runner/ptc/ptc-observability.ts: the product
 * surface a PTC Turn runs on. `other` is the fallback of a host that names none.
 */
const PTC_SURFACES = ['desktop', 'tui', 'other'] as const;
/** Who reads the PTC session-store metrics. */
const PTC_STORE_CONSUMER = 'PTC owners, for run_code store adoption watch and store investigations';
/** Who reads the yield and interruption metrics of cloud-harness-server runs. */
const CHS_CONSUMER =
  'Grafana dashboard CHS / Harness v2 (uid chs-harness-core), for yields and interrupted tool calls across releases';

/** Copies `SidebarSectionsImportStatus` in local-runtime-v2 service/sidebar-sections/contracts.ts. */
const SIDEBAR_SECTIONS_IMPORT_STATUSES = ['imported', 'merged', 'already_done', 'failed'] as const;
/**
 * The `namespace` label every namespaced-tool metric carries:
 * `BuiltinToolNamespace` in agent-tools src/shared/builtin-tool-namespaces.ts
 * with the dot of a dotted wire name written as an underscore, because registry
 * label values are snake_case. `other` covers every namespace that is not one
 * of them. Reporters map a wire name onto these through `namespaceMetricLabel`
 * in agent-tools, so one map serves every metric.
 */
export const NAMESPACE_METRIC_LABELS = [
  'sidebar_section',
  'sidebar_project',
  'sidebar_view',
  'session_manage',
  'session_dispatch',
  'panel',
  'app',
  'agent',
  'mcp',
  'cron',
  'memory',
  'other',
] as const;
export type NamespaceMetricLabel = (typeof NAMESPACE_METRIC_LABELS)[number];
/** Copies `NamespaceSearchObservation['match']` in agent-tools src/mcp-disclosure/bounded-tool-search.ts. */
const TOOL_SEARCH_NAMESPACE_MATCHES = ['exact', 'prefix', 'none'] as const;
/** Copies `mavisToolMovedGroup` in agent-tools src/desktop/local-mavis-namespaced-tools.ts. */
const MAVIS_TOOL_MOVED_GROUPS = ['agent', 'session', 'mcp', 'other'] as const;
/**
 * The `tool` label of the managed-tool metrics: every name in
 * `BUILTIN_NAMESPACED_TOOL_NAMES` (agent-tools
 * src/shared/builtin-tool-namespaces.ts), plus the `other` an unregistered
 * namespaced tool reports under.
 */
export const MANAGED_TOOL_LABELS = [
  'section_create',
  'section_delete',
  'section_list',
  'section_move_project',
  'section_move_session',
  'section_rename',
  'section_reorder',
  'project_archive_sessions',
  'project_create',
  'project_list',
  'project_remove',
  'project_rename',
  'sidebar_read',
  'sidebar_pin',
  'pinned_reorder',
  'session_mark_read',
  'sidebar_preferences_update',
  'session_list',
  'session_get',
  'session_update',
  'session_messages',
  'session_open',
  'session_fork',
  'session_create',
  'session_send',
  'session_interrupt',
  'session_wait',
  'panel_open_file',
  'panel_open_review',
  'usage_get',
  'app_update_check',
  'plugin_list',
  'plugin_set_enabled',
  'plugin_uninstall',
  'agent_list',
  'agent_get',
  'agent_create',
  'agent_update',
  'agent_delete',
  'mcp_server_list',
  'mcp_server_get',
  'mcp_server_create',
  'mcp_server_update',
  'mcp_server_delete',
  'cron_create',
  'cron_read',
  'cron_update',
  'cron_delete',
  'self_reminder',
  'other',
] as const;
export type ManagedToolLabel = (typeof MANAGED_TOOL_LABELS)[number];

/**
 * The `tool` label of a namespaced builtin tool. An unregistered name is
 * `other`, which is what keeps the label a bounded enum; the raw name travels
 * beside it as `tool_name` in the log line.
 */
export function managedToolLabel(name: string): ManagedToolLabel {
  return (MANAGED_TOOL_LABELS as readonly string[]).includes(name)
    ? (name as ManagedToolLabel)
    : 'other';
}

/**
 * Copies `DESKTOP_TOOL_ERROR_CODES` in agent-tools
 * src/desktop/desktop-tool-result.ts, lower snake_case because registry label
 * values are snake_case; the log line keeps the desktop code verbatim.
 */
const MANAGED_TOOL_ERROR_CODES = [
  'skill_required',
  'ui_unavailable',
  'ui_request_failed',
  'session_not_active',
  'content_blocked',
  'content_review_unavailable',
  'not_found',
  'invalid_argument',
  'conflict',
  'internal',
  'session_create_no_caller',
  'session_create_invalid_content',
  'session_create_invalid_location',
  'session_create_invalid_argument',
  'session_create_invalid_workspace',
  'session_create_unknown_project',
  'session_create_unknown_agent',
  'session_create_model_unresolved',
  'session_create_admission_failed',
  'session_create_unexpected_error',
] as const;
export type ManagedToolErrorCodeLabel = (typeof MANAGED_TOOL_ERROR_CODES)[number];

/**
 * The `error_code` label of a desktop tool failure. The wire code is upper
 * snake_case, which registry label values are not, so the label is its lower
 * snake_case form; the log line keeps the wire code verbatim.
 */
export function managedToolErrorCodeLabel(code: string): ManagedToolErrorCodeLabel {
  const lowered = code.toLowerCase();
  return (MANAGED_TOOL_ERROR_CODES as readonly string[]).includes(lowered)
    ? (lowered as ManagedToolErrorCodeLabel)
    : 'internal';
}

const MANAGED_SKILL_GATE_OUTCOMES = ['blocked', 'receipt', 'shared_read'] as const;
const MANAGED_SKILL_APPEND_OUTCOMES = ['already_loaded', 'no_tools', 'appended'] as const;
const MANAGED_TOOL_CALL_STATUSES = ['skill_required', 'ok', 'failed'] as const;
const MANAGED_TOOL_CALL_MODES = ['ptc', 'non_ptc'] as const;
/**
 * Copies `GlobalUiRequestOperation` in shared src/global-events.ts with the dot
 * of a dotted operation written as an underscore, because registry label values
 * are snake_case.
 */
const UI_REQUEST_OPERATIONS = [
  'session_open',
  'session_mark_read',
  'sidebar_preferences_update',
  'usage_get',
  'app_update_check',
  'panel_open_file',
  'panel_open_review',
] as const;
const UI_REQUEST_STATUSES = ['ok', 'timeout', 'failed'] as const;

/**
 * `PermissionMode` of @mavis/permission in snake_case. The legacy
 * `permission_ask_shown_total` reported the camelCase value before it moved to
 * these labels too.
 */
export const PERMISSION_MODE_LABELS = [
  'default',
  'accept_edits',
  'bypass_permissions',
  'auto',
  'dont_ask',
  'off',
] as const;
export type PermissionModeLabel = (typeof PERMISSION_MODE_LABELS)[number];
/** Copies `PermissionDecisionSource` in local-runtime-v2 permission-metrics.ts. */
const PERMISSION_DECISION_SOURCES = [
  'boundary_deny',
  'mode_off',
  'store_unhealthy',
  'rule_allow',
  'rule_ask',
  'rule_deny',
  'local_policy',
  'engine_allow',
  'engine_ask',
  'engine_deny',
  'mode_dont_ask',
  'classifier_allow',
  'classifier_confirm',
  'classifier_block',
  'classifier_error',
  'ask_gate_bypass',
  'unknown',
] as const;
/**
 * The layer that raised a permission card: the asking facade sources, or the
 * Turn gate reasons that ask without a facade ask (side Session, plugin
 * PreToolUse, assignment project). Also the asking layer behind an
 * `ask_gate_bypass` allow. local-runtime-v2 permission-metrics.ts maps any
 * other value to `unknown`.
 */
export const PERMISSION_ASK_SOURCES = [
  'rule_ask',
  'local_policy',
  'engine_ask',
  'classifier_confirm',
  'classifier_block',
  'classifier_error',
  'store_unhealthy',
  'side_session',
  'plugin_hook',
  'assignment_project',
  'unknown',
] as const;
export type PermissionAskSource = (typeof PERMISSION_ASK_SOURCES)[number];
/**
 * `kind` of `permission_fast_allow_total`: the allow-path safetyCheck
 * categories of @mavis/permission in snake_case, the reason codes of
 * local-runtime-v2 decision-attribution.ts, `mixed` for bash subcommands that
 * disagree and `other` for anything else.
 */
export const PERMISSION_FAST_ALLOW_KINDS = [
  'authorized_local_script',
  'authorized_write_redirect',
  'authorized_powershell_copy_move',
  'bypass_allow',
  'help_flag_fast_allow',
  'known_safe_command',
  'known_safe_powershell_command',
  'pure_read_fast_allow',
  'source_local_allow',
  'write_authorized_target',
  'persisted_rule',
  'safety_check',
  'working_directory_boundary',
  'internal_whitelist',
  'session_owned_readable_path',
  'trusted_exact_write',
  'temp_directory',
  'sandbox',
  'permission_mode',
  'path_validation',
  'dangerous_removal',
  'subcommand_results',
  'recoverable_delete_rewrite',
  'mixed',
  'other',
] as const;
export type PermissionFastAllowKind = (typeof PERMISSION_FAST_ALLOW_KINDS)[number];
const PERMISSION_TOOL_KINDS = ['bash', 'fs_read', 'fs_write', 'web', 'mcp', 'other'] as const;
const PERMISSION_PLATFORMS = ['win32', 'darwin', 'linux', 'other'] as const;
const PERMISSION_SESSION_KINDS = [
  'conversation',
  'task',
  'peek',
  'channel',
  'cron',
  'unknown',
] as const;
/** Who reads the permission metrics. */
const PERMISSION_CONSUMER = 'Permission owners, for ask-rate and fast-allow coverage panels';

/** Labels of the physical LLM request metrics. */
const MERGE_REQUEST_CONSUMER =
  'Merge request panel: review of the refresh interval, the hourly request budget per host, and how long the panel waits';
const MERGE_REQUEST_PLATFORMS = ['gitlab', 'github'] as const;
const MERGE_REQUEST_CLI_OUTCOMES = [
  'ok',
  'cli_missing',
  'not_authenticated',
  'rate_limited',
  'timeout',
  'not_found',
  'forbidden',
  'upstream',
  // Writes: the head moved before a merge, the platform refused to merge, a check
  // cannot rerun, the branch already has a merge request, or the platform refused
  // the request as it stands.
  'head_changed',
  'not_mergeable',
  'cannot_retry',
  'already_exists',
  'invalid',
] as const;

const LLM_REQUEST_LABELS = {
  provider: INGEST_NORMALIZED,
  model: INGEST_NORMALIZED,
  caller: PI_CALLERS,
  route: MODEL_CALL_ROUTE_LABELS,
} as const;

/** Who reads the skill catalog metrics. */
const SKILL_CATALOG_CONSUMER =
  'MiniMax Code skill catalog owners: window freeze rollout and catalog budget tuning';
/** Values of `SKILL_CATALOG_WINDOW_REASON_LABELS` in agent-tools skill-catalog-window. */
const SKILL_CATALOG_WINDOW_REASONS = [
  'first',
  'compaction',
  'context_window',
  'upstream_changed',
  'no_state',
  'error',
] as const;
/** Copies the result of `skillCatalogListing` in agent-tools skill-catalog-window. */
const SKILL_CATALOG_LISTINGS = ['described', 'name_only', 'notice', 'unlisted'] as const;

export const METRIC_DEFINITIONS = {
  storage_retention_runs_total: {
    type: 'counter',
    unit: 'count',
    help: 'Storage retention policy passes grouped by completion outcome and host platform.',
    consumer: 'runtime observability',
    labels: {
      policy: STORAGE_RETENTION_POLICY_NAMES,
      platform: ['darwin', 'win32', 'linux', 'other'],
      outcome: STORAGE_RETENTION_OUTCOMES,
    },
  },
  storage_retention_freed_total: {
    type: 'counter',
    unit: 'count',
    help: 'Storage retention policy passes grouped by the amount of data removed, not a byte accumulator.',
    consumer: 'runtime observability',
    labels: {
      policy: STORAGE_RETENTION_POLICY_NAMES,
      platform: ['darwin', 'win32', 'linux', 'other'],
      freed_bucket: ['0', 'lt_10mib', '10mib_100mib', '100mib_1gib', 'gte_1gib'],
    },
  },
  storage_retention_duration_total: {
    type: 'counter',
    unit: 'count',
    help: 'Storage retention policy passes grouped by elapsed-time bucket and host platform.',
    consumer: 'runtime observability',
    labels: {
      policy: STORAGE_RETENTION_POLICY_NAMES,
      platform: ['darwin', 'win32', 'linux', 'other'],
      duration_bucket: ['lt_1s', '1s_10s', 'gte_10s'],
    },
  },
  storage_space_reclaim_total: {
    type: 'counter',
    unit: 'count',
    help: 'Database free-page reclaim passes grouped by outcome and the observed reclaimed-size bucket.',
    consumer: 'runtime observability',
    labels: {
      platform: ['darwin', 'win32', 'linux', 'other'],
      outcome: ['reclaimed', 'nothing_to_reclaim', 'not_incremental', 'partial', 'failed'],
      freed_bucket: ['0', 'lt_10mib', '10mib_100mib', '100mib_1gib', 'gte_1gib'],
    },
  },

  browser_run_script_total: {
    type: 'counter',
    unit: 'count',
    help: 'Browser provider run_script calls, classified by observed keyboard or mouse use.',
    consumer: 'runtime observability',
    labels: { input: ['none', 'keyboard_mouse', 'unknown'] },
  },
  browser_write_action_total: {
    type: 'counter',
    unit: 'count',
    help: 'Browser page input actions by their provider outcome.',
    consumer: 'runtime observability',
    labels: { outcome: ['ok', 'error'] },
  },
  browser_post_action_screenshot_duration_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'FAST',
    help: 'From a Browser action result to its automatic screenshot settling, including queueing and compression.',
    consumer: 'runtime observability',
    labels: { outcome: ['attached', 'deduplicated', 'empty', 'failed', 'timeout'] },
  },
  browser_post_action_screenshot_stage_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'FAST',
    help: 'Components of the automatic screenshot wait for attached or deduplicated Browser screenshots.',
    consumer: 'runtime observability',
    labels: { phase: ['queue', 'capture', 'encode', 'transfer', 'compress', 'provider'] },
  },
  browser_turn_opened_tabs_items: {
    type: 'histogram',
    unit: 'items',
    buckets: 'COUNT',
    help: 'Tabs opened by the Agent during a completed Turn with at least one Browser action.',
    consumer: 'runtime observability',
    labels: {},
  },
  // Electron main process: local runtime supervision.
  supervisor_runtime_start_total: {
    type: 'counter',
    unit: 'count',
    help: 'Local runtime launch attempts of the Electron main process, by outcome: ready, or a startup failure. Each attempt counts once; nothing is counted while the app quits.',
    consumer: 'runtime observability',
    labels: { result: ['ready', 'startup_failed'], os: SUPERVISOR_OS },
  },
  supervisor_runtime_exit_total: {
    type: 'counter',
    unit: 'count',
    help: 'Launch attempts that ended without the app asking: a startup failure (its reason code), a ready runtime that exited (process_exit) or one the supervisor recycled (memory_pressure, runtime_unresponsive, oom, network_service_lost). Each attempt counts once; nothing is counted while the app quits.',
    consumer: 'runtime observability',
    labels: { reason: RUNTIME_RECOVERY_REASONS, os: SUPERVISOR_OS },
  },
  supervisor_runtime_restart_total: {
    type: 'counter',
    unit: 'count',
    help: 'Automatic recoveries the supervisor started on a ready runtime (runtime-recovery-started: memory_pressure, runtime_unresponsive, oom, network_service_lost). Crash restarts show as supervisor_runtime_exit_total{reason="process_exit"}.',
    consumer: 'runtime observability',
    labels: { reason: RUNTIME_RECOVERY_REASONS },
  },

  // Local runtime turns.
  pi_turn_failure_total: {
    type: 'counter',
    unit: 'count',
    help: 'Failed turns by error source and kind; local_* kinds come from the system error code.',
    consumer: 'runtime observability',
    labels: {
      caller: PI_CALLERS,
      errorSource: TURN_ERROR_SOURCES,
      errorKind: TURN_FAILURE_ERROR_KINDS,
    },
    optionalLabels: AGENT_KIND_LABEL,
  },
  pi_turn_yield_total: {
    type: 'counter',
    unit: 'count',
    help: 'Runs the host stopped to yield (drain, memory pressure, or an approval or user-input hold); a later run of the same turn continues each. Also in pi_turn_total; not in pi_turn_abort_total nor pi_turn_error_total{errorKind="abort"}.',
    consumer: CHS_CONSUMER,
    labels: { caller: PI_CALLERS },
    optionalLabels: AGENT_KIND_LABEL,
  },
  pi_tool_call_interrupted_total: {
    type: 'counter',
    unit: 'count',
    help: 'Tool calls cut short by their run ending instead of failing; not in pi_tool_call_error_total. cause: yield ended in error after the run yielded (usually the hold it cancelled, which the next run runs again); run_restart was given an interrupted result with an unknown outcome because the run executing it stopped.',
    consumer: CHS_CONSUMER,
    labels: { caller: PI_CALLERS, cause: ['yield', 'run_restart'] },
    optionalLabels: AGENT_KIND_LABEL,
  },
  pi_turn_busy_ms_total: {
    type: 'counter',
    unit: 'ms',
    help: 'Running turns times elapsed ms, added every report cycle and at turn end; rate()/1000 is the average concurrent turns. Replaces pi_active_turns.',
    consumer: 'runtime observability',
    labels: { caller: PI_CALLERS },
  },
  metrics_client_dropped_points_total: {
    type: 'counter',
    unit: 'count',
    help: 'Points the Desktop metrics client dropped: non_retryable_status for a batch the endpoint answered with a status other than 429, 502, 503 or 504; series_limit for new series a failed batch could not put back (maxCarryOverSeries or maxSeries). Sent in a request of its own; like every counter of this client, a request that timed out after the server processed it is sent again and counted twice.',
    consumer: 'runtime observability',
    labels: { reason: METRICS_DROP_REASONS },
  },

  // LLM requests (shipped before the registry; route added).
  pi_llm_request_total: {
    type: 'counter',
    unit: 'count',
    help: 'Physical provider requests started by a turn; every retry attempt counts. route tells the managed Token Plan from BYOK calls.',
    consumer: 'runtime observability',
    labels: LLM_REQUEST_LABELS,
    optionalLabels: AGENT_KIND_LABEL,
  },
  pi_llm_response_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: LONG_TAIL_BUCKETS,
    help: 'Physical provider request from start to settlement (done, error or abort), by route.',
    consumer: 'runtime observability',
    labels: LLM_REQUEST_LABELS,
    optionalLabels: AGENT_KIND_LABEL,
  },
  pi_llm_first_token_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: LONG_TAIL_BUCKETS,
    help: 'Deprecated, replaced by pi_llm_first_output_ms. Physical provider request from start to its first text, thinking or tool-call event, block starts included.',
    consumer: 'runtime observability',
    labels: { provider: INGEST_NORMALIZED, model: INGEST_NORMALIZED, caller: PI_CALLERS },
    optionalLabels: AGENT_KIND_LABEL,
    deprecated: 'pi_llm_first_output_ms',
  },
  pi_llm_logical_call_total: {
    type: 'counter',
    unit: 'count',
    help: 'Final outcome of each logical LLM call, after its automatic retries, by route.',
    consumer: 'runtime observability',
    labels: {
      ...LLM_REQUEST_LABELS,
      scope: LLM_CALL_SCOPES,
      outcome: ['success', 'error', 'abort'],
      errorKind: LLM_CALL_ERROR_KINDS,
      retryTriggered: BOOLEAN_VALUES,
    },
    optionalLabels: AGENT_KIND_LABEL,
  },

  // First output. A first output is the first non-empty text, thinking or
  // tool-call argument fragment; block-start events do not count (the check of
  // biz-gateway open_platform_direct_support.go). A request starts when the
  // turn's metrics wrapper is invoked for it, right before the provider builds
  // and sends it.
  pi_turn_first_output_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'TTFT',
    help: "From the runtime accepting the user message (durable admission, acceptedAtMs) to the first output of the turn's first model request, any of its retries. compacted: an automatic compaction request was sent before it. wake: user when a person started any input of the turn's starting batch in a client (composer, TUI, ACP, IM, questionnaire answer, edit and resend, Mini App, /review), otherwise system. conversation: new when the session history before the turn's own input holds no user, assistant or compaction summary message (a continuation counts its whole history), otherwise existing.",
    consumer: 'runtime observability',
    labels: {
      route: MODEL_CALL_ROUTE_LABELS,
      model: INGEST_NORMALIZED,
      caller: PI_CALLERS,
      compacted: BOOLEAN_VALUES,
      wake: TURN_WAKE_LABELS,
      conversation: TURN_CONVERSATION_LABELS,
    },
    optionalLabels: AGENT_KIND_LABEL,
  },
  pi_turn_first_visible_text_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'TOTAL',
    help: 'From the runtime accepting the user message (acceptedAtMs, as pi_turn_first_output_ms) to the first assistant text of the turn the user can see: streamed or settled body text, or delivered send_to_user content, as it leaves output review and the display projection. Text that output review held counts from its release. At most once per turn; a turn that shows no text records nothing. compacted, wake and conversation as pi_turn_first_output_ms.',
    consumer: 'runtime observability',
    labels: {
      route: MODEL_CALL_ROUTE_LABELS,
      model: INGEST_NORMALIZED,
      caller: PI_CALLERS,
      compacted: BOOLEAN_VALUES,
      wake: TURN_WAKE_LABELS,
      conversation: TURN_CONVERSATION_LABELS,
    },
    optionalLabels: AGENT_KIND_LABEL,
  },
  pi_turn_prepare_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'FAST',
    help: 'Contiguous runtime stages from the runtime accepting the user message to the first model request: accepted (until the agent host starts the turn), assembling (session, agent and history reads, model and credential resolution, runtime assembly), preparing (plugin hooks, tools, prompt and reminders), persisting (until the running status is written), dispatching (until the first request; dropped when automatic compaction ran first). UI send to runtime acceptance is not timed yet: the UI also marks a send accepted when it keeps a composer steer that never reached the runtime while a Goal runs. wake as pi_turn_first_output_ms.',
    consumer: 'runtime observability',
    labels: {
      stage: ['accepted', 'assembling', 'preparing', 'persisting', 'dispatching'],
      caller: PI_CALLERS,
      wake: TURN_WAKE_LABELS,
    },
    optionalLabels: AGENT_KIND_LABEL,
  },
  pi_llm_first_output_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'TTFT',
    help: 'Per model request of a turn, every retry included, from its start to its first output. Replaces pi_llm_first_token_ms. Automatic compaction requests are not recorded.',
    consumer: 'runtime observability',
    labels: {
      route: MODEL_CALL_ROUTE_LABELS,
      model: INGEST_NORMALIZED,
      caller: PI_CALLERS,
      phase: ['initial', 'iteration'],
    },
    optionalLabels: AGENT_KIND_LABEL,
  },
  pi_llm_response_header_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'TTFT',
    help: 'Per model request of a turn, from its start to the provider handing over the response headers (onResponse). The Google providers only get the response with the first stream chunk, so theirs ends at that chunk. Automatic compaction requests are not recorded.',
    consumer: 'runtime observability',
    labels: { route: MODEL_CALL_ROUTE_LABELS, model: INGEST_NORMALIZED, caller: PI_CALLERS },
  },
  pi_llm_transport_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'FAST',
    help: 'Managed Token Plan requests only: pi_llm_response_header_ms of the request minus the Server-Timing gw and up of its response. Not recorded when the header is missing or malformed or the result is negative.',
    consumer: 'runtime observability',
    labels: { model: INGEST_NORMALIZED, caller: PI_CALLERS },
  },
  output_safety_first_chunk_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'FAST',
    help: "The first body-text window of a turn's first attempt under output review: buffer_wait from its first text entering the window to its review starting (80 characters, a boundary or the final message), check for that review.",
    consumer: 'runtime observability',
    labels: { stage: ['buffer_wait', 'check'], caller: PI_CALLERS },
  },
  session_title_review_total: {
    type: 'counter',
    unit: 'count',
    help: '回复落库后的会话标题处理结果。mode=review 是自动标题的一次复核；mode=fallback 是对仍显示截断兜底标题的会话按首轮内容补命名，每个会话最多 3 轮。',
    consumer: 'runtime observability',
    labels: {
      outcome: ['kept', 'updated', 'invalid_output', 'failed', 'skipped_race'],
      mode: ['review', 'fallback'],
    },
  },
  ui_first_visible_response_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'VISIBLE',
    help: 'From pressing send to the first business chunk in the UI; resumed streams are excluded.',
    consumer: 'runtime observability',
    labels: {
      content_type: ['text', 'thinking', 'tool'],
      route: MODEL_CALL_ROUTE_LABELS,
      model: INGEST_NORMALIZED,
    },
  },
  ui_first_render_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'FAST',
    help: 'From the first business chunk to the next painted frame (two animation frames; approximate). Not recorded when the window is hidden at the chunk or before those frames: a hidden window does not paint.',
    consumer: 'runtime observability',
    labels: {},
  },
  ui_first_paint_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'VISIBLE',
    help: 'Migrated client_first_paint_ms: from send to the first text delta reaching the client.',
    consumer: 'runtime observability',
    labels: { visibility: ['visible', 'hidden'] },
  },
  ui_axios_401_total: {
    type: 'counter',
    unit: 'count',
    help: 'Migrated axios_401: UI API calls rejected with 401. The raw URL is not a label.',
    consumer: 'runtime observability',
    labels: {},
  },
  ui_login_modal_total: {
    type: 'counter',
    unit: 'count',
    help: 'Migrated electron_login_modal: the Desktop login modal was opened.',
    consumer: 'runtime observability',
    labels: {},
  },

  // Plugin snapshot gauge replaced (R4).
  plugin_snapshot_component_items: {
    type: 'histogram',
    unit: 'items',
    buckets: 'COUNT',
    help: 'Components in each published plugin snapshot, one observation per component and publication. Replaces plugin_snapshot_component_count.',
    consumer: 'runtime observability',
    labels: { component: PLUGIN_SNAPSHOT_COMPONENTS },
  },

  // Workspace indexing gauges replaced (R4).
  workspace_indexing_busy_ms_total: {
    type: 'counter',
    unit: 'ms',
    help: 'In-flight indexing operations times elapsed ms per stage, added every report cycle. Replaces workspace_indexing_inflight.',
    consumer: 'runtime observability',
    labels: { stage: WORKSPACE_INDEXING_STAGES, os: WORKSPACE_INDEXING_OS },
  },
  workspace_indexing_backlog_items: {
    type: 'histogram',
    unit: 'items',
    buckets: 'COUNT',
    help: 'Durable remote indexing queue depth, observed once per report cycle. Replaces workspace_indexing_backlog.',
    consumer: 'runtime observability',
    labels: { os: WORKSPACE_INDEXING_OS },
  },
  workspace_indexing_backlog_head_age_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'AGE',
    help: 'Age of the oldest due revision in the durable queue, observed once per report cycle. Replaces workspace_indexing_backlog_oldest_age_ms.',
    consumer: 'runtime observability',
    labels: { os: WORKSPACE_INDEXING_OS },
  },

  // Skill catalog: system prompt prefix stability, the per-window catalog freeze and skill loads.
  prompt_section_change_total: {
    type: 'counter',
    unit: 'count',
    help: "Local Turns whose final system prompt changed a section's bytes from the Session's previous prepared request: across_turn against the previous Turn, within_turn when the same Turn prepared again. Committed compactions reset the baseline. A change breaks the provider prompt cache from that section on.",
    consumer: SKILL_CATALOG_CONSUMER,
    labels: {
      section: ['skills', 'memory', 'other'],
      scope: ['across_turn', 'within_turn'],
    },
  },
  skill_catalog_window_total: {
    type: 'counter',
    unit: 'count',
    help: 'Skill catalog windows a local Turn started (first window of the Session, after a compaction) or resynced (context window or the system prompt before the catalog changed). shadow: skills.freezeCatalog is off, so every Turn renders the live catalog and the window is only measured.',
    consumer: SKILL_CATALOG_CONSUMER,
    labels: {
      event: ['started', 'resynced'],
      reason: SKILL_CATALOG_WINDOW_REASONS,
      shadow: BOOLEAN_VALUES,
    },
  },
  skill_catalog_window_deviation_total: {
    type: 'counter',
    unit: 'count',
    help: "Skills added, removed or with a changed description since the Session's previous committed local Turn while a window continues, added to by the number of skills of each kind. Without the freeze each such Turn would have changed the catalog and broken the prompt cache; shadow=true measures that before the freeze is on. Turns that start or resync a window count nothing: their prefix changes anyway.",
    consumer: SKILL_CATALOG_CONSUMER,
    labels: { kind: ['added', 'removed', 'changed'], shadow: BOOLEAN_VALUES },
  },
  skill_catalog_skill_items: {
    type: 'histogram',
    unit: 'items',
    buckets: 'COUNT',
    help: 'Skills listed in the catalog of each window a local Turn started or resynced. Names are never dropped, so this is every enabled Skill.',
    consumer: SKILL_CATALOG_CONSUMER,
    labels: { shadow: BOOLEAN_VALUES },
  },
  skill_catalog_tokens_total: {
    type: 'counter',
    unit: 'count',
    help: 'Estimated tokens of the catalog of each window a local Turn started or resynced. Divided by skill_catalog_window_total: the average catalog size.',
    consumer: SKILL_CATALOG_CONSUMER,
    labels: { shadow: BOOLEAN_VALUES },
  },
  skill_catalog_descriptions_dropped_total: {
    type: 'counter',
    unit: 'count',
    help: 'Skills listed by name only because their description did not fit the catalog budget, added to per window a local Turn started or resynced. Replaces skill_catalog_overflow_observed_total.',
    consumer: SKILL_CATALOG_CONSUMER,
    labels: { shadow: BOOLEAN_VALUES },
  },
  skill_catalog_description_cap_total: {
    type: 'counter',
    unit: 'count',
    help: 'Windows a local Turn started or resynced whose catalog cut some description at 1,024 code points. Replaces skill_catalog_description_cap_observed_total.',
    consumer: SKILL_CATALOG_CONSUMER,
    labels: { shadow: BOOLEAN_VALUES },
  },
  skill_load_total: {
    type: 'counter',
    unit: 'count',
    help: "Calls of the local `skill` tool, by result (unavailable: the Skill was in this window's catalog or announced but is gone now) and by how the window listed the requested name. No skill name label: names are unbounded.",
    consumer: SKILL_CATALOG_CONSUMER,
    labels: {
      status: ['ok', 'not_found', 'unavailable', 'error'],
      listing: SKILL_CATALOG_LISTINGS,
    },
  },
  // Permission decisions. The other permission_* metrics predate the registry
  // and stay in legacy-metric-names.ts until their call sites change.
  permission_check_total: {
    type: 'counter',
    unit: 'count',
    help: 'Final permission decisions at the facade and Mini App exits, by mode, result, the layer that decided (source), tool kind and platform. Asks the Turn gate raises without a facade decision are not counted; see permission_ask_shown_total.',
    consumer: PERMISSION_CONSUMER,
    labels: {
      mode: PERMISSION_MODE_LABELS,
      result: ['allow', 'ask', 'deny'],
      source: PERMISSION_DECISION_SOURCES,
      tool_kind: PERMISSION_TOOL_KINDS,
      platform: PERMISSION_PLATFORMS,
    },
  },
  permission_fast_allow_total: {
    type: 'counter',
    unit: 'count',
    help: 'Deterministic engine allows (source engine_allow), by the fast path that allowed them (kind) and platform.',
    consumer: PERMISSION_CONSUMER,
    labels: { kind: PERMISSION_FAST_ALLOW_KINDS, platform: PERMISSION_PLATFORMS },
  },
  permission_mode_change_total: {
    type: 'counter',
    unit: 'count',
    help: 'Effective profile permission-mode changes, from one mode to another; writes that keep the mode are not counted.',
    consumer: PERMISSION_CONSUMER,
    labels: { from: PERMISSION_MODE_LABELS, to: PERMISSION_MODE_LABELS },
  },
  permission_ask_wait_range_total: {
    type: 'counter',
    unit: 'count',
    help: 'Settled permission asks by how long the card waited (range, up to gt_4h), outcome (replied or abandoned), session kind, the layer that raised the card (source) and platform. Carries the long tail of permission_ask_wait_ms per release, which histograms cannot.',
    consumer: PERMISSION_CONSUMER,
    labels: {
      outcome: ['replied', 'abandoned'],
      range: ['lt_1m', '1m_5m', '5m_15m', '15m_1h', '1h_4h', 'gt_4h'],
      sessionKind: PERMISSION_SESSION_KINDS,
      source: PERMISSION_ASK_SOURCES,
      platform: PERMISSION_PLATFORMS,
    },
  },
  permission_ask_bypass_total: {
    type: 'counter',
    unit: 'count',
    help: 'Asks that bypass_permissions or off allowed without a card (source ask_gate_bypass of permission_check_total), by mode, the layer that asked (source) and tool kind.',
    consumer: PERMISSION_CONSUMER,
    labels: {
      mode: PERMISSION_MODE_LABELS,
      source: PERMISSION_ASK_SOURCES,
      tool_kind: PERMISSION_TOOL_KINDS,
    },
  },

  // Context compaction over a history whose tool calls did not pair.
  compact_history_repaired_total: {
    type: 'counter',
    unit: 'count',
    help: 'Compactions that ran on a history whose tool calls and results did not pair (legacy v1 histories, interrupted turns) and summarized only the paired part instead of failing, one per compaction. phase: initial or iteration for automatic compaction before a model request of the turn, manual for /compact.',
    consumer: 'runtime observability',
    labels: { phase: CONTEXT_COMPACTION_PHASES },
  },

  // PTC (run_code) session store. The other ptc_* metrics predate the registry
  // and stay in legacy-metric-names.ts until their call sites change.
  ptc_store_write_total: {
    type: 'counter',
    unit: 'count',
    help: 'Values a finished run_code program persisted to its Session store, one per key it wrote; a program that stored nothing records nothing. Writes the host refused are not counted here. surface: the product surface of the Turn.',
    consumer: PTC_STORE_CONSUMER,
    labels: { surface: PTC_SURFACES },
  },
  ptc_store_load_total: {
    type: 'counter',
    unit: 'count',
    help: 'load() calls of a finished run_code program that reached the host, whether or not the key existed; a program that loaded nothing records nothing. surface: the product surface of the Turn.',
    consumer: PTC_STORE_CONSUMER,
    labels: { surface: PTC_SURFACES },
  },

  // Merge request panel (beta.reviewStatus): the glab / gh requests behind it.
  merge_request_cli_request_total: {
    type: 'counter',
    unit: 'count',
    help: 'glab / gh requests of the merge request panel, one per CLI run that reached the platform, by platform, purpose (refresh: polling and Turn-end records; user: a user action; probe: CLI and host checks) and outcome. CLI and login checks are counted in merge_request_cli_probe_total, budget skips in merge_request_budget_skip_total.',
    consumer: MERGE_REQUEST_CONSUMER,
    labels: {
      platform: MERGE_REQUEST_PLATFORMS,
      purpose: ['refresh', 'user', 'probe'],
      outcome: MERGE_REQUEST_CLI_OUTCOMES,
    },
  },
  merge_request_cli_request_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'TTFT',
    help: 'Duration of each glab / gh request of the merge request panel, from starting the CLI to its exit, by platform and outcome.',
    consumer: MERGE_REQUEST_CONSUMER,
    labels: { platform: MERGE_REQUEST_PLATFORMS, outcome: MERGE_REQUEST_CLI_OUTCOMES },
  },
  merge_request_budget_skip_total: {
    type: 'counter',
    unit: 'count',
    help: 'Background merge request reads skipped because their host used up its hourly request budget; user actions are never skipped.',
    consumer: MERGE_REQUEST_CONSUMER,
    labels: {},
  },
  merge_request_cli_probe_total: {
    type: 'counter',
    unit: 'count',
    help: 'glab / gh checks of the merge request panel, by platform and the state found: ready, not_installed, not_authenticated or unavailable.',
    consumer: MERGE_REQUEST_CONSUMER,
    labels: {
      platform: MERGE_REQUEST_PLATFORMS,
      state: ['ready', 'not_installed', 'not_authenticated', 'unavailable'],
    },
  },
  merge_request_list_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'FAST',
    help: "Time the runtime takes to answer the merge request panel's list read, by how it was served: fresh (data read within the panel's cache window), stale (older data answered at once while a background read refreshes it; merge_request_refresh_ms and merge_request_served_age_ms describe that wait) or fetched (nothing to show yet, or a manual refresh, so the answer waited for GitLab or GitHub).",
    consumer: MERGE_REQUEST_CONSUMER,
    labels: { served: ['fresh', 'stale', 'fetched'] },
  },
  merge_request_refresh_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'TTFT',
    help: 'Background refreshes started by a stale merge request list read, from the stale answer to the new data being ready, by outcome (failed when any host of the round failed).',
    consumer: MERGE_REQUEST_CONSUMER,
    labels: { outcome: ['ok', 'failed'] },
  },
  merge_request_served_age_ms: {
    type: 'histogram',
    unit: 'ms',
    buckets: 'AGE',
    help: 'Age of the oldest platform data in a merge request list answer served stale: how old the shown state is until the background refresh lands.',
    consumer: MERGE_REQUEST_CONSUMER,
    labels: {},
  },

  // Sidebar sections: the one-time import of the renderer's localStorage copy.
  sidebar_sections_import_total: {
    type: 'counter',
    unit: 'count',
    help: 'Attempts to import the sidebar sections the renderer kept in localStorage, by status: imported (the Runtime had none), merged (it had some), already_done (the import marker was already set) or failed (it threw, so the next launch retries).',
    consumer: 'runtime observability',
    labels: { status: SIDEBAR_SECTIONS_IMPORT_STATUSES },
  },

  // tool_search namespace discovery.
  tool_search_namespace_total: {
    type: 'counter',
    unit: 'count',
    help: 'tool_search calls that carried a namespace argument, one per call. namespace: the builtin namespace it resolved to, or other. match: exact names an indexed namespace, prefix only reaches the groups below it, none reaches neither. with_query: the same call also ranked by keyword; without both, a rising count cannot tell discovery from guessing.',
    consumer: 'runtime observability',
    labels: {
      namespace: NAMESPACE_METRIC_LABELS,
      match: TOOL_SEARCH_NAMESPACE_MATCHES,
      with_query: BOOLEAN_VALUES,
    },
  },

  // Namespaced builtin tools: the Skill gate, the calls it lets through and the
  // Skill-result append.
  managed_skill_gate_total: {
    type: 'counter',
    unit: 'count',
    help: 'Gate decisions for an on-demand namespaced builtin tool, one per call attempt. namespace: the tool builtin namespace, or other. outcome: blocked (no Skill receipt unlocked it), receipt (its own Skill was loaded) or shared_read (another namespace Skill listing it in sharedReads was).',
    consumer: 'runtime observability',
    labels: { namespace: NAMESPACE_METRIC_LABELS, outcome: MANAGED_SKILL_GATE_OUTCOMES },
  },
  managed_skill_append_total: {
    type: 'counter',
    unit: 'count',
    help: 'Skill reads whose result carried the unlocked-tools block, one per read of a Skill that owns a namespace. namespace: the namespace that Skill owns. outcome: appended (the block listed tools), already_loaded (the namespace only has default-loaded tools) or no_tools (this turn has no tool of that namespace).',
    consumer: 'runtime observability',
    labels: { namespace: NAMESPACE_METRIC_LABELS, outcome: MANAGED_SKILL_APPEND_OUTCOMES },
  },
  managed_tool_call_total: {
    type: 'counter',
    unit: 'count',
    help: 'Calls of a namespaced builtin tool, one per attempt, the ones the Skill gate refused included. namespace: the tool builtin namespace, or other. tool: the tool, or other when its name is not registered. status: skill_required (the gate refused it), ok or failed. mode: ptc when the Turn ran run_code.',
    consumer: 'runtime observability',
    labels: {
      namespace: NAMESPACE_METRIC_LABELS,
      tool: MANAGED_TOOL_LABELS,
      status: MANAGED_TOOL_CALL_STATUSES,
      mode: MANAGED_TOOL_CALL_MODES,
    },
  },
  managed_tool_error_total: {
    type: 'counter',
    unit: 'count',
    help: 'Failed calls of a namespaced builtin tool, one per failure, counted beside managed_tool_call_total{status="failed"}. namespace and tool match that metric. error_code: the stable desktop tool code in lower snake_case.',
    consumer: 'runtime observability',
    labels: {
      namespace: NAMESPACE_METRIC_LABELS,
      tool: MANAGED_TOOL_LABELS,
      error_code: MANAGED_TOOL_ERROR_CODES,
    },
  },
  managed_tool_call_duration_ms: {
    type: 'histogram',
    unit: 'ms',
    help: 'Wall time of a namespaced builtin tool call the Skill gate let through, from the gate decision to the result. namespace and status match managed_tool_call_total.',
    consumer: 'runtime observability',
    labels: { namespace: NAMESPACE_METRIC_LABELS, status: ['ok', 'failed'] },
    buckets: 'TOOL_CALL',
  },

  // mavis commands that moved to a namespaced builtin tool.
  mavis_tool_moved_total: {
    type: 'counter',
    unit: 'count',
    help: 'Legacy mavis({ command }) calls answered with the moved-command refusal, one per call. group: which group the model still reached for through mavis.',
    consumer: 'runtime observability',
    labels: { group: MAVIS_TOOL_MOVED_GROUPS },
  },

  // The Runtime asking the desktop UI to run something it owns.
  ui_request_total: {
    type: 'counter',
    unit: 'count',
    help: 'ui.request round trips the Runtime settled, one per request. operation: what it asked the UI to do, with the dot of a dotted operation written as an underscore. status: ok, timeout (nothing answered before the deadline) or failed.',
    consumer: 'runtime observability',
    labels: { operation: UI_REQUEST_OPERATIONS, status: UI_REQUEST_STATUSES },
  },
  ui_request_duration_ms: {
    type: 'histogram',
    unit: 'ms',
    help: 'Wall time of one ui.request round trip, from publishing the event to the first reply that settled it. operation matches ui_request_total.',
    consumer: 'runtime observability',
    labels: { operation: UI_REQUEST_OPERATIONS },
    buckets: 'TOOL_CALL',
  },

  // Harness content safety, and the PTC child calls it does not review. The
  // harness reports these through its own counter sink and cannot import this
  // registry, so its emit site maps the hyphenated stage vocabulary onto the
  // snake_case label values below.
  safety_check_total: {
    type: 'counter',
    unit: 'count',
    help: 'Settled content-safety checks of the harness, retries included, so a stage that retried an unavailable review counts each attempt. stage: the stage that ran. verdict: pass, block, regenerate, or unavailable when the review service gave none. host: the Host that ran it, unknown when it names none.',
    consumer: 'runtime observability',
    labels: {
      stage: SAFETY_METRIC_STAGES,
      verdict: SAFETY_METRIC_VERDICTS,
      host: SAFETY_METRIC_HOSTS,
    },
  },
  safety_unavailable_total: {
    type: 'counter',
    unit: 'count',
    help: 'Stages that failed closed because the review service stayed unavailable through every retry, by stage and Host; the subset of safety_check_total{verdict="unavailable"} whose retries ran out.',
    consumer: 'runtime observability',
    labels: { stage: SAFETY_METRIC_STAGES, host: SAFETY_METRIC_HOSTS },
  },
  ptc_child_review_skipped_total: {
    type: 'counter',
    unit: 'count',
    help: 'run_code child calls whose tool stage the harness deliberately did not send for review, by the stage (tool_args or tool_result) and the Host. Only a stage the safety policy enables is counted, so this is the review a PTC child call does not get.',
    consumer: 'runtime observability',
    labels: { stage: TOOL_REVIEW_METRIC_STAGES, host: SAFETY_METRIC_HOSTS },
  },
  ptc_child_bash_full_output_total: {
    type: 'counter',
    unit: 'count',
    help: 'Bash calls of a run_code child by what happened to their full output: restored (the child got all of it), over_limit (past PTC_CHILD_FULL_OUTPUT_MAX_BYTES, so it keeps the capped preview), or unavailable (nothing could be read back).',
    consumer: 'runtime observability',
    labels: { outcome: PTC_CHILD_FULL_OUTPUT_OUTCOMES },
  },
} as const satisfies Readonly<Record<string, MetricDefinition>>;

type Definitions = typeof METRIC_DEFINITIONS;

export type RegisteredMetricName = keyof Definitions;

export { LEGACY_METRIC_NAMES } from './legacy-metric-names.js';

/** A metric that predates the registry, reported through the untyped calls. */
export type LegacyMetricName = (typeof LEGACY_METRIC_NAMES)[number];

/**
 * A name an untyped metric call may take: registered or legacy. Code that
 * forwards a metric name to such a call types its parameter with it.
 */
export type AllowedMetricName = RegisteredMetricName | LegacyMetricName;

type RegisteredNameOfType<T extends MetricDefinition['type']> = {
  [N in RegisteredMetricName]: Definitions[N]['type'] extends T ? N : never;
}[RegisteredMetricName];

export type RegisteredCounterName = RegisteredNameOfType<'counter'>;
export type RegisteredHistogramName = RegisteredNameOfType<'histogram'>;

type LabelSpecs<N extends RegisteredMetricName> = Definitions[N]['labels'];
type OptionalLabelSpecs<N extends RegisteredMetricName> = Definitions[N] extends {
  readonly optionalLabels: infer O;
}
  ? O
  : Record<never, never>;
type LabelValue<S> = S extends readonly string[] ? S[number] : string;

/**
 * Exact label set of a registered metric, values typed: every key of `labels`
 * required, every key of `optionalLabels` optional.
 */
export type RegisteredMetricLabels<N extends RegisteredMetricName> = [
  keyof LabelSpecs<N> | keyof OptionalLabelSpecs<N>,
] extends [never]
  ? Readonly<Record<string, never>>
  : { readonly [K in keyof LabelSpecs<N>]: LabelValue<LabelSpecs<N>[K]> } & {
      readonly [K in keyof OptionalLabelSpecs<N>]?: LabelValue<OptionalLabelSpecs<N>[K]>;
    };

/**
 * Add `delta` to a registered counter. A missing sink is a no-op and a
 * throwing sink is contained: metrics never break the caller.
 */
export function incrementMetric<N extends RegisteredCounterName>(
  sink: Pick<MetricsClient, 'counter'> | undefined,
  name: N,
  delta: number,
  labels: RegisteredMetricLabels<N>,
): void {
  if (!sink) return;
  try {
    sink.counter(name, delta, labels as MetricLabels);
  } catch {
    // Metrics are a weak dependency.
  }
}

/** Record one observation of a registered histogram; fail-open like {@link incrementMetric}. */
export function observeMetric<N extends RegisteredHistogramName>(
  sink: Pick<MetricsClient, 'histogram'> | undefined,
  name: N,
  value: number,
  labels: RegisteredMetricLabels<N>,
): void {
  if (!sink) return;
  try {
    sink.histogram(name, value, labels as MetricLabels);
  } catch {
    // Metrics are a weak dependency.
  }
}

/** Registered counters that accumulate milliseconds, such as busy time. */
export type RegisteredMsCounterName = {
  [N in RegisteredCounterName]: Definitions[N]['unit'] extends 'ms' ? N : never;
}[RegisteredCounterName];

/** Busy time of concurrent operations, per label set; see {@link createBusyTimeAccumulator}. */
export interface BusyTimeAccumulator<N extends RegisteredMsCounterName> {
  /** `running` operations run under `labels` from now on; the time before accrues first. */
  set(labels: RegisteredMetricLabels<N>, running: number): void;
}

/**
 * Busy time of concurrent operations as a registered `ms` counter, so its
 * `rate()` / 1000 is the average number running: on every change and every
 * report cycle (`onCollect`), add running operations × ms since the previous
 * accrual, per label set. A crash loses at most one report cycle; a gauge of
 * the running count would keep only the last client's value on the server.
 * Without a sink nothing is reported; a sink without `onCollect` accrues on
 * changes only. The accrual stays registered with `onCollect` only while
 * operations run, so a sink that outlives its owner, such as a process-wide
 * metrics client, does not keep an idle accumulator alive. Never throws.
 */
export function createBusyTimeAccumulator<N extends RegisteredMsCounterName>(
  name: N,
  options: {
    readonly sink:
      | (Pick<MetricsClient, 'counter'> & Partial<Pick<MetricsClient, 'onCollect'>>)
      | undefined;
    readonly nowMs: () => number;
  },
): BusyTimeAccumulator<N> {
  const { sink, nowMs } = options;
  const running = new Map<string, { labels: RegisteredMetricLabels<N>; count: number }>();
  let accruedAtMs = nowMs();
  const accrue = (): void => {
    try {
      const now = nowMs();
      const elapsedMs = now - accruedAtMs;
      accruedAtMs = now;
      if (!(elapsedMs > 0)) return;
      for (const { labels, count } of running.values())
        incrementMetric(sink, name, count * elapsedMs, labels);
    } catch {
      // Metrics are a weak dependency.
    }
  };
  let stopCollecting: (() => void) | undefined;
  const collectWhileRunning = (): void => {
    try {
      if (running.size > 0) {
        if (stopCollecting === undefined && typeof sink?.onCollect === 'function') {
          const stop: unknown = sink.onCollect(accrue);
          stopCollecting = typeof stop === 'function' ? () => stop() : () => undefined;
        }
      } else if (stopCollecting !== undefined) {
        const stop = stopCollecting;
        stopCollecting = undefined;
        stop();
      }
    } catch {
      // Metrics are a weak dependency.
    }
  };
  return {
    set(labels, count) {
      accrue();
      const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
      if (count > 0) running.set(key, { labels, count });
      else running.delete(key);
      collectWhileRunning();
    },
  };
}

/** The boundaries of a histogram definition. */
export function histogramBounds(definition: HistogramDefinition): readonly number[] {
  return typeof definition.buckets === 'string'
    ? STANDARD_BUCKETS[definition.buckets]
    : definition.buckets.legacy;
}

/** Per-name bucket overrides for the registered histograms, for MetricsClient. */
export function registeredHistogramBucketsByName(): Record<string, number[]> {
  const buckets: Record<string, number[]> = {};
  for (const [name, definition] of Object.entries(METRIC_DEFINITIONS) as Array<
    [string, MetricDefinition]
  >) {
    if (definition.type !== 'histogram') continue;
    buckets[name] = [...histogramBounds(definition)];
  }
  return buckets;
}
