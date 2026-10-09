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
  type MultimodalAttachmentCapabilities,
  type MultimodalAttachmentKind,
} from "./shared/multimodal-attachments.js";
export { inferReadVideoMimeType } from "./shared/read-video.js";
export {
  filterCanonicalBuiltinMcpEntries,
  filterCanonicalNativeToolCeiling,
  isCanonicalBuiltinTurn,
  isReadOnlyCanonicalBlockedToolName,
} from "./desktop/canonical-tool-policy.js";

export { getLocalBashEnvironment } from "./desktop/local-pi-tools.js";
export { pluginHookTranscriptPath, pluginHookCodexTranscriptPath } from "./plugin-hooks/index.js";
