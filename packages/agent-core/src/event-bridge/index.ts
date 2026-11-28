/**
 * `@mavis/agent-core/event-bridge` — convert pi `AgentEvent` streams into
 * canonical `RuntimeEvent` frames consumed by `EventSink.pushRuntime`.
 *
 * This module is **stateless across turns**: callers create one
 * {@link EventBridge} per pi `runAgentLoop` invocation, feed events to
 * {@link EventBridge.processEvent}, then close the turn with one of the
 * `emit*` terminal helpers.
 *
 * The conversion logic itself is split into pure functions in
 * `./converters.ts` so consumers (local-runtime, cloud-runtime,
 * unit tests) can reuse the building blocks without booting a full
 * bridge instance.
 *
 * @see packages/cloud-runtime/README.md
 */

export { EventBridge } from './bridge.js';
export type {
  BridgedEvents,
  EventBridgeContext,
  ToolCallProvenanceResolutionInput,
  ToolCallProvenanceResolver,
  TurnTerminationReason,
} from './types.js';
export {
  attachPluginCapabilityAttribution,
  createPluginCapabilityAttributionResolver,
  normalizedPluginSkillAttributionKey,
  selectPreferredAppPluginOwners,
  type PluginCapabilityAttributionIndex,
} from './plugin-capability-attribution.js';
export type { RespDataTransform, RespDataTransformContext } from './resp-data.js';
export {
  TurnToolCallContent,
  type ToolCallContentAccessor,
  type ToolCallModelOutput,
} from './tool-call-content.js';
export {
  buildRuntimeWarningEvent,
  RUNTIME_WARNING_EVENT_TYPE,
  type RuntimeWarningEventInput,
} from './runtime-warning.js';
export { classifyLLMErrorToCode } from '@mavis/shared/llm-error-classifier';
export {
  buildAbortedTerminalStatusEvent,
  buildCompletedAssistantMessage,
  buildCompletedTerminalStatusEvent,
  buildDebugTraceEvent,
  buildFailedTerminalStatusEvent,
  buildFinishChunk,
  buildRunningSessionStatusEvent,
  buildStreamRespEvent,
  buildTextDeltaChunk,
  buildThinkingDeltaChunk,
  buildToolCallChunk,
  extractAssistantErrorMessage,
  extractAssistantStopReason,
  extractAssistantText,
  extractAssistantThinking,
  extractAssistantToolCalls,
  extractDeltaUpdate,
  extractFinalAssistantText,
  extractFinalAssistantUsageFromBuffer,
  isAssistantError,
  toolCallFromRuntime,
} from './converters.js';

export {
  INLINE_BINARY_INLINE_THRESHOLD,
  isInlineBinaryContentBlock,
  isLikelyBase64,
  sanitizeToolCallForDisplay,
  sanitizeToolResultForDisplay,
  sanitizeWireToolCallResultData,
  stripInlineBinaryFromContent,
} from './display-sanitize.js';
