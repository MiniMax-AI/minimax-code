export {
  MEMORY_SOFT_LIMIT_BYTES,
  MEMORY_HARD_LIMIT_BYTES,
  MEMORY_INJECTION_CAP_CHARS,
  MEMORY_SUMMARY_INJECTION_CAP_CHARS,
  MEMORY_TAIL_INJECTION_CAP_CHARS,
  DAILY_RECENT_CAP_CHARS,
  MEMORY_CLEANUP_TRIGGER_BYTES,
  MEMORY_CLEANUP_MIN_BYTES,
  MAX_TOPIC_FILES,
  MAX_TOPIC_FILE_BYTES,
  DAILY_DIGEST_TTL_DAYS,
  CLEANUP_DEDUP_WINDOW_MS,
} from './memory-limits.js';
export { loadBetterSqlite3 } from './sqlite-driver.js';
export {
  normalizeProductBuildEnvironment,
  resolveProductBuildIdentity,
} from './product-build-identity.js';
export type {
  ProductBuildEnvironment,
  ProductBuildIdentity,
  ProductBuildVariant,
  ResolveProductBuildIdentityOptions,
} from './product-build-identity.js';
export { buildPluginSkillRuntimeName } from './plugin-skill-name.js';
export { toNavigationPlainText } from './navigation-text.js';
export { collectFetchedWebSources } from './fetched-web-sources.js';
export { collectUsedWebEvidenceIds } from './web-source-evidence.js';
export {
  collectWebSourceCitations,
  type ContextualWebCitation,
} from './markdown-source-citation.js';
export {
  buildToolCallCitationId,
  compactToolCallCitationKey,
  findUniqueSingleSubstitutionCitationAlias,
  resolveKnownCitationAlias,
} from './source-citation-id.js';
export { KeyedOperationLane } from './keyed-operation-lane.js';
export { isSensitiveHandoffPath } from './session-handoff-sensitive-path.js';
export {
  OPENROUTER_ATTRIBUTION_HEADERS,
  isOpenRouterApiUrl,
  withOpenRouterAttributionHeaders,
} from './openrouter-attribution.js';
export {
  isRetryableWindowsFileError,
  retryWindowsFileSystemOperation,
  type WindowsFileSystemRetryOptions,
} from './windows-file-system.js';
export { isPidAlive } from './process-alive.js';

export { SESSION_LLM_RETRY_EVENT_TYPE } from './llm-retry-event.js';
export type {
  SessionLLMRetryEventPayload,
  SessionLLMRetryReason,
  SessionLLMRetryScope,
  SessionLLMRetryStatus,
} from './llm-retry-event.js';

export {
  MAVIS_BROWSER_EXTENSION_ID,
  getHostName,
  generateManifest,
  serializeManifest,
  getNativeHostDirs,
  getManifestFileName,
  getManifestPath,
  generateHostWrapper,
  getWindowsRegistryEntries,
} from './browser-manifest.js';
export type {
  NativeMessagingManifest,
  ManifestOptions,
  BrowserName,
  BrowserHostDir,
  WindowsRegistryEntry,
} from './browser-manifest.js';

// Owner `<mavis-thinking>` and `<mavis-progress>` block helpers — single
// source of truth for daemon, IM forwarders, and UI. Keep both packages on
// the same regex/strip semantics; do not redefine the regex elsewhere.
export {
  MAVIS_THINKING_BLOCK_RE,
  MAVIS_PROGRESS_BLOCK_RE,
  MAVIS_INNERMOST_PAIRED_BLOCK_RE,
  stripMavisThinkingTags,
  stripMavisProgressTags,
  stripMavisTagsForIm,
  extractVisibleContent,
  isThinkingOrProgressOnly,
  isThinkingOnlyContent,
  containsMavisProgressBlock,
  containsMavisThinkingBlock,
  containsMavisPairedBlock,
} from './mavis-tags.js';

export {
  parseWatchInterval,
  parseSelfReminderTtl,
  appendTtlPromptSuffix,
  generateWatchCronName,
  DEFAULT_SELF_REMINDER_TTL_SECONDS,
  MAX_SELF_REMINDER_TTL_SECONDS,
  TTL_NEVER,
} from './watch-interval.js';
export type { ParsedInterval, ParsedTtl } from './watch-interval.js';

// Mid-turn queued-user-message injection wrapper — shared by local-runtime
// compatibility imports (Path A) and cloud-runtime (Path B) so the wire
// format stays identical.
export {
  QUEUED_USER_MESSAGE_TAG,
  escapeQueuedUserMessageTags,
  wrapQueuedMessageText,
  wrapQueuedMessageBatch,
} from './queued-message-wrapper.js';
export type { QueuedMessageMetadata } from './queued-message-wrapper.js';

// Shared aggregator for drained queued user-message batches — local-runtime
// and cloud-runtime both apply the same IM-priority rule: any IM wins,
// multiple IMs → last IM in FIFO order.
export { isChannelSource, aggregateQueuedSource } from './queued-message-source.js';
export type { QueuedItemSourceLike, AggregatedQueuedSource } from './queued-message-source.js';

export {
  CRON_SESSION_PURPOSE_PREFIX,
  MEMORY_CLEANUP_CRON_NAME,
  createCronSessionPurpose,
  formatCronRunTitle,
  isLegacyMemoryCleanupTitle,
  parseCronSessionPurpose,
} from './cron-purpose.js';

export {
  DESKTOP_METRICS_BATCH_PATH,
  MetricsClient,
  MetricsReporter,
  MetricsReportError,
  buildMetricKey,
  createDesktopReporter,
  createMetricsClient,
} from './metrics-proxy.js';

export {
  createStructuredLogger,
  wrapTraceContextLogger,
  createDiskLogTransport,
  formatHourKey,
  type StructuredLoggerOptions,
  type TraceContextLike,
  type DiskLogTransport,
  type DiskLogTransportOptions,
} from './logging/index.js';
export type {
  CreateDesktopReporterOptions,
  CreateMetricsClientOptions,
  MetricsBatchReporter,
  MetricLabels,
  MetricPoint,
  MetricType,
  MetricsClientOptions,
  MetricsClientRetryOptions,
  MetricsReporterOptions,
  ReportMetricsBatchRequest,
  ReportMetricsBatchResponse,
} from './metrics-proxy.js';

export type {
  ChannelPlatform,
  SessionStrategy,
  NormalizedSessionStrategy,
  ChannelRoutingMode,
  ChannelRouteMatch,
  ChannelRouteTarget,
  ChannelRouteRule,
  ChannelRouteDefaultTarget,
  ChannelRouteDefaults,
  ChannelRouteConfig,
  ChannelMessageContext,
  ResolvedRoute,
  AgentChannelSessionConfig,
  AgentChannelMessageFilter,
  AgentChannelPlatformConfig,
  AgentChannelConfig,
  ChannelSessionBinding,
} from './channel-route.js';

export { channelRoutingModeForStrategy, normalizeSessionStrategy } from './channel-route.js';

export type {
  TraceContext,
  ChannelContext,
  ChatType,
  ChannelContextParams,
  InboundContext,
} from './channel-context.js';

export {
  AGENT_REQUEST_REF_DESCRIPTION,
  CANONICAL_SUBAGENT_ROLES,
  LOCAL_MAVIS_AGENT_NAME_DESCRIPTION,
  RESERVED_SUBAGENT_NAMES,
  SUBAGENT_ROLES,
  agentNameDescription,
  isCanonicalSubagentRole,
  isTrustedBuiltinCreationSource,
  resolveCanonicalSubagentRole,
  roleDirectoryText,
  toAgentRequestRef,
} from './subagent-roles.js';
export type { CanonicalSubagentRole, LocalSubagentRoleDefinition } from './subagent-roles.js';

export type {
  AgentReferenceReadScope,
  AgentReferenceResolutionSource,
  AgentReferenceResolver,
} from './agent-reference.js';

export {
  createTraceContext,
  childSpan,
  createChannelContext,
  toRequestContext,
  traceToRequestContext,
} from './channel-context.js';

export type { ResponseFormatHint } from './channel-format-hints.js';
export { getResponseFormatHint } from './channel-format-hints.js';

// ---------------------------------------------------------------------------
// Canonical media-asset metadata inferers (mime / kind) + the strict,
// structured outbound-media tag parser. PORTED from the feat/im-genui-full
// branch to give the IM outbound side a UI-free canonical implementation.
// `inferAssetMimeType` infers a MIME type from type/extension (the agent never
// emits one); `deriveMediaKind` maps onto the four IM send primitives
// (image/file/audio/video); `parseMediaTags` extracts `<media>` / wrapper tags
// from a reply. The UI's result-card-utils.ts still has a parallel copy;
// deduping it to re-export from here is a tracked follow-up.
// ---------------------------------------------------------------------------
export {
  MIME_BY_EXTENSION,
  WORKSPACE_IMAGE_PREVIEW_MIME_TYPES,
  inferAssetMimeType,
  getWorkspaceImagePreviewMimeType,
  isImageAsset,
  isWebAsset,
  isWebsiteAsset,
  supportsCanvasImageAnnotation,
  supportsWorkspaceImagePreview,
  deriveMediaKind,
} from './media-asset-meta.js';
export type {
  MediaAssetMetaInput,
  OutboundMediaKind,
  WorkspaceImagePreviewMimeType,
} from './media-asset-meta.js';
export { parseMediaTags } from './outbound-media.js';
export type { OutboundMediaNameSource, OutboundMediaRef } from './outbound-media.js';
// IM-outbound text sanitizer: rewrites agent-emitted `<media>` /
// `<deliver-assets>` XML to short placeholders so unrecognized media-ish tags
// never leak as literal XML. Belt-and-suspenders fallback after `parseMediaTags`
// (the structured extractor) on the local-runtime outbound path.
export { placeholderMediaTags } from './im-text-sanitize.js';

// ---------------------------------------------------------------------------
// mavis-widget DSL types — shared contract between daemon (persistence) and
// UI (parsing + rendering).
// ---------------------------------------------------------------------------
export type {
  MavisWidgetKind,
  MavisWidgetStreamingMode,
  MavisWidgetThemeMode,
  MavisWidgetCapability,
  MavisWidgetPolicy,
  MavisWidgetData,
  MavisWidgetEnvelope,
  WidgetContentSegment,
} from './mavis-widget-types.js';

// ---------------------------------------------------------------------------
// V2 Multi-step questionnaire schema
// ---------------------------------------------------------------------------

export type {
  AskQuestionOption,
  AskQuestionImage,
  AskQuestionStep,
  AskQuestionnaireStatus,
  AskQuestionnaireToolCall,
  AskQuestionnaireRequester,
  AskQuestionnairePresentation,
  AskQuestionnairePurpose,
  AskQuestionnaireRequest,
  AskQuestionnaireDraftAnswer,
  AskQuestionnaireReplyAnswer,
  AskQuestionnaireReplyPayload,
  AskUserToolOptionInput,
  AskUserToolImageInput,
  AskUserToolStepInput,
  AskUserToolMode,
  AskUserToolModePayload,
  AskUserToolInput,
} from './questionnaire.js';

export { ASK_OTHER_PLACEHOLDER, ASK_USER_TOOL_NAME } from './questionnaire.js';

export type {
  ChannelParsedEvent,
  ChannelAttachment,
  ChannelOutboundContext,
  ChannelSendResult,
  ChannelMediaPayload,
  ChannelToolStep,
  ChannelPermissionRequest,
  ChannelPermissionDecision,
  ChannelProbeResult,
  ChannelAccountConfig,
  ChannelCapabilities,
  ChannelMeta,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelGatewayContext,
  ChannelInboundAdapter,
  ChannelInboundContext,
  ChannelOutboundAdapter,
  ChannelRichReplyAdapter,
  ChannelSessionErrorInfo,
  ChannelQueueInfo,
  ChannelAuthAdapter,
  ChannelActionsAdapter,
  ChannelApprovalAdapter,
  ChannelQuestionnaireAdapter,
  ChannelQuestionnaireSubmit,
  ChannelThreadingAdapter,
  ChannelDirectoryAdapter,
  ChannelDirectoryEntry,
  ChannelPlugin,
} from './channel-plugin.js';

// ===========================================================================
// @deprecated aliases — backward compatibility with IM* naming convention
// Will be removed in a future major version.
// ===========================================================================

// --- from channel-route.ts ---
/** @deprecated Use ChannelPlatform */
export type IMPlatform = import('./channel-route.js').ChannelPlatform;
/** @deprecated Use ChannelRouteMatch */
export type IMRouteMatch = import('./channel-route.js').ChannelRouteMatch;
/** @deprecated Use ChannelRouteTarget */
export type IMRouteTarget = import('./channel-route.js').ChannelRouteTarget;
/** @deprecated Use ChannelRouteRule */
export type IMRouteRule = import('./channel-route.js').ChannelRouteRule;
/** @deprecated Use ChannelRouteDefaultTarget */
export type IMRouteDefaultTarget = import('./channel-route.js').ChannelRouteDefaultTarget;
/** @deprecated Use ChannelRouteDefaults */
export type IMRouteDefaults = import('./channel-route.js').ChannelRouteDefaults;
/** @deprecated Use ChannelRouteConfig */
export type IMRouteConfig = import('./channel-route.js').ChannelRouteConfig;
/** @deprecated Use ChannelMessageContext */
export type IMMessageContext = import('./channel-route.js').ChannelMessageContext;
/** @deprecated Use AgentChannelSessionConfig */
export type AgentIMSessionConfig = import('./channel-route.js').AgentChannelSessionConfig;
/** @deprecated Use AgentChannelMessageFilter */
export type AgentIMMessageFilter = import('./channel-route.js').AgentChannelMessageFilter;
/** @deprecated Use AgentChannelPlatformConfig */
export type AgentIMPlatformConfig = import('./channel-route.js').AgentChannelPlatformConfig;
/** @deprecated Use AgentChannelConfig */
export type AgentIMConfig = import('./channel-route.js').AgentChannelConfig;
/** @deprecated Use ChannelSessionBinding */
export type IMSessionBinding = import('./channel-route.js').ChannelSessionBinding;

// --- from channel-plugin.ts ---
/** @deprecated Use ChannelParsedEvent */
export type IMParsedEvent = import('./channel-plugin.js').ChannelParsedEvent;
/** @deprecated Use ChannelAttachment */
export type IMAttachment = import('./channel-plugin.js').ChannelAttachment;
/** @deprecated Use ChannelOutboundContext */
export type IMOutboundContext = import('./channel-plugin.js').ChannelOutboundContext;
/** @deprecated Use ChannelSendResult */
export type IMSendResult = import('./channel-plugin.js').ChannelSendResult;
/** @deprecated Use ChannelMediaPayload */
export type IMMediaPayload = import('./channel-plugin.js').ChannelMediaPayload;
/** @deprecated Use ChannelToolStep */
export type IMToolStep = import('./channel-plugin.js').ChannelToolStep;
/** @deprecated Use ChannelPermissionRequest */
export type IMPermissionRequest = import('./channel-plugin.js').ChannelPermissionRequest;
/** @deprecated Use ChannelPermissionDecision */
export type IMPermissionDecision = import('./channel-plugin.js').ChannelPermissionDecision;
/** @deprecated Use ChannelProbeResult */
export type IMProbeResult = import('./channel-plugin.js').ChannelProbeResult;
/** @deprecated Use ChannelAccountConfig */
export type IMAccountConfig = import('./channel-plugin.js').ChannelAccountConfig;
/** @deprecated Use ChannelCapabilities */
export type IMChannelCapabilities = import('./channel-plugin.js').ChannelCapabilities;
/** @deprecated Use ChannelMeta */
export type IMChannelMeta = import('./channel-plugin.js').ChannelMeta;
/** @deprecated Use ChannelConfigAdapter */
export type IMConfigAdapter = import('./channel-plugin.js').ChannelConfigAdapter;
/** @deprecated Use ChannelGatewayAdapter */
export type IMGatewayAdapter = import('./channel-plugin.js').ChannelGatewayAdapter;
/** @deprecated Use ChannelGatewayContext */
export type IMGatewayContext = import('./channel-plugin.js').ChannelGatewayContext;
/** @deprecated Use ChannelInboundAdapter */
export type IMInboundAdapter = import('./channel-plugin.js').ChannelInboundAdapter;
/** @deprecated Use ChannelInboundContext */
export type IMInboundContext = import('./channel-plugin.js').ChannelInboundContext;
/** @deprecated Use ChannelOutboundAdapter */
export type IMOutboundAdapter = import('./channel-plugin.js').ChannelOutboundAdapter;
/** @deprecated Use ChannelRichReplyAdapter */
export type IMRichReplyAdapter = import('./channel-plugin.js').ChannelRichReplyAdapter;
/** @deprecated Use ChannelAuthAdapter */
export type IMAuthAdapter = import('./channel-plugin.js').ChannelAuthAdapter;
/** @deprecated Use ChannelActionsAdapter */
export type IMActionsAdapter = import('./channel-plugin.js').ChannelActionsAdapter;
/** @deprecated Use ChannelApprovalAdapter */
export type IMApprovalAdapter = import('./channel-plugin.js').ChannelApprovalAdapter;
/** @deprecated Use ChannelThreadingAdapter */
export type IMThreadingAdapter = import('./channel-plugin.js').ChannelThreadingAdapter;
/** @deprecated Use ChannelDirectoryAdapter */
export type IMDirectoryAdapter = import('./channel-plugin.js').ChannelDirectoryAdapter;
/** @deprecated Use ChannelDirectoryEntry */
export type IMDirectoryEntry = import('./channel-plugin.js').ChannelDirectoryEntry;
/** @deprecated Use ChannelPlugin */
export type IMChannelPlugin = import('./channel-plugin.js').ChannelPlugin;

export { withOpenCodeGoHeaders } from './opencode-go-headers.js';

export {
  formatPluginId,
  isBuiltInPluginMarketplace,
  isValidPluginMarketplaceName,
  LOCAL_PLUGIN_MARKETPLACE,
  OFFICIAL_PLUGIN_MARKETPLACE,
  parsePluginSelector,
  pluginIdKey,
  samePluginId,
  type PluginId,
  type PluginSelector,
} from './plugin-id.js';
export { MINIMAX_CODE_USER_AGENT, withMiniMaxCodeUserAgent } from './minimax-code-user-agent.js';
