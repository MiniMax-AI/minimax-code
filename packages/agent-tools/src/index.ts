export {
  getSuppressedToolNamesForModelCapabilities,
  MatrixWebSearchToolDef,
} from "./shared/model-tool-capabilities.js";

export {
  buildOrReuseIndex,
  planMcpDisclosure,
  modelInWhitelist,
  createToolSearchTool,
  authorizeMcpInvokeReference,
  createMcpInvokeTool,
  revokeMcpInvokeReferenceAuthorization,
  resolveMcpInvokeTarget,
  type McpInvokeReferenceTarget,
  type McpInvokeTargetResolution,
  renderMcpToolSearchHintBlock,
  type McpToolEntry,
  type McpModelIdentity,
  type McpDisclosureOptions,
  type McpDisclosurePlan,
} from "./mcp-disclosure/mcp-disclosure.js";
export {
  PluginHookTranscript,
  readPluginHookCompatibleToolResponse,
  compatibleBashToolResponseFromPiDetails,
  compatibleReadToolResponseFromPiDetails,
} from "./plugin-hooks/index.js";
export {
  normaliseMultimodalMimeType,
  isSupportedNativeVideoMime,
  selectMultimodalAttachments,
  encodeAttachmentImage,
  nativeMultimodalKindForMime,
  multimodalDemotionTextNotes,
  type AttachmentImageEncoding,
  type MultimodalAttachmentCapabilities,
  type MultimodalAttachmentKind,
} from "./shared/multimodal-attachments.js";
export { inferReadVideoMimeType } from "./shared/read-video.js";
export { withPermissionExecutionPlan } from "./desktop/permission-execution.js";
export {
  filterCanonicalNativeToolCeiling,
  isCanonicalBuiltinTurn,
} from "./desktop/canonical-tool-policy.js";

export { getLocalBashEnvironment } from "./desktop/local-pi-tools.js";
export {
  createDesktopPtcResultProjection,
  classifyDesktopPtcTruncation,
  projectDesktopPtcEvidenceInput,
  projectDesktopPtcToolResult,
  sanitizePtcChildExecutionDetailsForSafety,
  sanitizePtcExecutionDetailsForSafety,
  type DesktopPtcTruncationVerdict,
} from "./desktop/ptc-result-projection.js";
export {
  isPtcMavisChildToolName,
  isPtcMavisDirectCommand,
  isPtcMavisProgrammaticCommand,
  PTC_MAVIS_CHILD_TOOLS,
  ptcMavisChildToolName,
  ptcMavisRunCodeCall,
  ptcMavisRunCodeTool,
  type PtcMavisChildToolName,
} from "./desktop/local-mavis-commands.js";
export {
  createPtcMavisTools,
  PTC_MAVIS_RUN_CODE_NOTE,
  readPtcMavisChildTarget,
} from "./desktop/local-mavis-ptc.js";
export { getMcpInvokeRegistries } from "./mcp-disclosure/mcp-invoke.js";
export { withLocalBrowserObserve } from "./desktop/local-browser.js";
export { pluginHookTranscriptPath, pluginHookCodexTranscriptPath } from "./plugin-hooks/index.js";
