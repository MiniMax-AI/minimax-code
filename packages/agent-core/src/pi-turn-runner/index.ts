/**
 * `@mavis/agent-core/pi-turn-runner` — assemble pi-coding-agent for a
 * Mavis session and bridge its event stream into canonical
 * `RuntimeEvent`s.
 *
 * This module is the "injection + assembly" layer. It does not implement
 * `runAgentLoop()` itself (that ships in `@earendil-works/pi-agent-core`);
 * it wires the pi runtime to explicit per-turn model / event writer /
 * tool contracts supplied by runtime adapters.
 *
 * Runtime adapters such as local-runtime and cloud-runtime construct a
 * {@link PiTurnRunner} with process-level wiring and call
 * {@link PiTurnRunner.runTurn} for each LLM turn, supplying the resolved
 * model, event writer and runtime tools as part of {@link RunTurnInput}.
 *
 * @see packages/agent-core/ARCHITECTURE.md
 */

export {
  LLM_REQUEST_TIMEOUT_MS,
  PiTurnRunner,
  _computeFailureTerminationReasonForTest,
  wrapStreamFnWithTimeout,
  type PiMessageIdAllocator,
  type PiTurnRunnerOptions,
} from './pi-turn-runner.js';
export { composeStreamFn, withSessionIdentity } from './llm.js';
export { abortLLMCallWithFailure, withLLMStreamCleanup } from './llm-call-lifecycle.js';
export type {
  LLMCallFailure,
  LLMCallLifecycle,
  LLMCallLease,
  LLMCallRetryDecision,
  MaybePromise,
} from './llm-call-lifecycle.js';
export {
  CONTENT_REVIEW_REGENERATE_ATTEMPT_HEADER,
  CONTENT_REVIEW_REGENERATE_OF_HEADER,
  DEFAULT_CONTENT_REVIEW_MAX_REGENERATIONS,
  parseContentReviewError,
  type ContentReviewError,
  type ContentReviewKind,
  type ContentReviewOutcome,
  type ContentReviewRejection,
  type ContentReviewTurnOptions,
} from './content-review.js';
export {
  LLM_FIRST_EVENT_TIMEOUT_ENV,
  LLM_FIRST_EVENT_TIMEOUT_MS,
  LLM_STREAM_IDLE_TIMEOUT_ENV,
  LLM_STREAM_IDLE_TIMEOUT_MS,
} from './defaults.js';
export {
  LLM_RESUME_STALL_MESSAGE_PREFIX,
  LLM_RESUME_STALL_MS,
  LLM_STREAM_TIMEOUT_MESSAGE_PREFIX,
  LLMStreamTimeoutError,
  resolveLLMStreamTimeouts,
  withLLMStreamTimeouts,
  type LLMStreamResumeGuard,
  type LLMStreamTimeoutConfig,
  type LLMStreamTimeouts,
} from './llm-stream-timeout.js';
export { isRunYieldAbort, normalizeAbortSource } from './types.js';
export {
  LLM_STREAM_FAILURE_DIAGNOSTIC_TYPE,
  LLM_STREAM_FAILURE_KINDS,
  readLLMStreamFailureKind,
  type LLMStreamFailureKind,
} from './llm-stream-failure.js';
export {
  LLM_PARTIAL_STREAM_RESET,
  isLLMPartialStreamResetEvent,
} from '../protocol/stream-reset.js';
export {
  DEFAULT_LLM_REPLY_GUARD_POLICY,
  DEFAULT_LLM_RETRY_POLICY,
  LLM_RETRY_CALL_IDENTITY,
  LLM_RETRY_BEFORE_REQUEST,
  overranSystemSleep,
  SYSTEM_SLEEP_GAP_MS,
  LLM_RETRY_REQUEST_SETTLED_OBSERVER,
  LLMRequestStoppedError,
  withLLMRetry,
  type LLMCallErrorKind,
  type LLMCallOutcome,
  type LLMCallScope,
  type LLMCallSettledEvent,
  type LLMCallUsage,
  type LLMExpectedToolIdentity,
  type LLMReplyGuardPolicy,
  type LLMNetworkRecovery,
  type LLMRequestAdmission,
  type LLMRequestLifecycle,
  type LLMUsageRecorder,
  type LLMRequestLifecycleSettlement,
  type LLMRequestRoute,
  type LLMRequestSettledEvent,
  type LLMRequestSettledObserver,
  type LLMRetryError,
  type LLMRetryEvent,
  type LLMRetryOptions,
  type LLMRetryPolicy,
  type LLMRetryStatus,
} from './llm-retry.js';
export { refusalCooldownMs } from './llm-retry-support.js';
export {
  createLLMCallPreemption,
  LLM_CALL_PREEMPTED_CUSTOM_TYPE,
  LLM_CALL_PREEMPTED_NOTICE,
  type LLMCallPreemption,
  type LLMCallPreemptionResult,
} from './llm-preemption.js';
export type { LlmCaptureAgentEventSource, LlmCaptureRecorder } from './turn.js';
export { createPiTurnHistogramBucketsByName, recordPiLLMCallMetrics } from './metrics.js';
export {
  TURN_REQUEST_PHASE,
  createTurnVisibleTextMark,
  parseGatewayServerTiming,
  readTurnRequestPhase,
  withTurnRequestPhase,
  type GatewayServerTiming,
  type TurnRequestPhase,
} from './turn-timing.js';
export type {
  PiLLMCacheOutcome,
  PiLLMRequestObserver,
  PiLLMRequestFailureHook,
  PiLLMRequestFailureInfo,
  PiLLMRequestSettledInfo,
  PiLLMRequestSettlementObserver,
  PiLLMRequestStartedInfo,
} from './metrics.js';
export {
  findDegenerateImageReason,
  normalizeOutboundMessagesForModel,
  projectAgentMessagesForModel,
  removeOrphanToolResults,
  thinkingToPortableText,
} from './outbound-message-normalizer.js';
export {
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  limitRequestImages,
  listRequestImages,
  knownMaxImagesPerRequestForBaseUrl,
  normalizeMaxImagesPerRequest,
  replaceRequestImages,
  resolveMaxImagesPerRequest,
} from './request-image-limit.js';
export type {
  ModelRequestImageLimit,
  RequestImage,
  RequestImageLimitResult,
} from './request-image-limit.js';
export type { ModelAudioInput } from './video-audio-strip.js';
export { describeVideoContainerProblem, findVideoContainerProblem } from './video-container.js';
export type { VideoContainerProblem } from './video-container.js';
export {
  findProviderVideoProblem,
  omitUnsampleableVideosForModel,
} from './video-sampling-guard.js';
export type { ProviderVideoProblem } from './video-sampling-guard.js';
export type { ModelRequestMediaSupport } from './request-media-support.js';
export { hasThinkingPrefixBinding } from './thinking-prefix-binding.js';
export type { ModelThinkingPrefixBinding } from './thinking-prefix-binding.js';
export {
  isLLMContextOverflowMessage,
  isLLMImageLimitMessage,
  isLLMMediaContentRejectionMessage,
  isLLMRequestTooLargeMessage,
  parseLLMMediaCountLimitMessage,
} from '@mavis/shared/llm-error-classifier';
export { toPiUserMessage } from './agent.js';
export { agentKindField, wakeField } from './types.js';
export { PTC_BATCH_WALL_CLOCK_MS } from './ptc-tool-executor.js';
export {
  createToolContextHistogramBucketsByName,
  measureToolArguments,
  measureToolContext,
  measureToolResult,
  type MeasuredToolValue,
  type ToolContextBreakdown,
  type ToolContextContribution,
  type ToolContextSizeEstimator,
} from './tool-context-size.js';
export type {
  AbortSource,
  LLMModelConfig,
  PiAgentMessage,
  PiEventWriter,
  PiTurnRunnerLogger,
  PiTurnTiming,
  RunTurnAgentKind,
  RunTurnCaller,
  RunTurnInput,
  RunTurnResult,
  RunTurnStartMode,
  RunTurnWake,
  RuntimeEvent,
  SteeringPollContext,
  TurnEventReporter,
  TurnVisibleTextMark,
  ToolConfig,
  UserMessageInput,
} from './types.js';
export type {
  PiAfterLlmCallHook,
  PiAfterLlmCallHookDecision,
  PiAfterLlmCallHookInput,
  PiAfterToolCallHook,
  PiBeforeLlmCallHook,
  PiBeforeLlmCallAppendMessage,
  PiBeforeLlmCallHookDecision,
  PiBeforeLlmCallHookInput,
  PiBeforeLlmCallPhase,
  PiBeforeLlmCallReplaceMetadata,
  PiBeforeToolCallHook,
  PiHistoryChangedHookInput,
  PiAssistantMessageId,
  PiHistoryChangeReason,
  PiLlmCallPreparedHookInput,
  PiLlmCallPreparedObservation,
  PiLlmCallRecovery,
  PiOnLlmCallPreparedHook,
  PiOnHistoryChangedHook,
  PiOnStepEndHook,
  PiOnTurnEndHook,
  PiStepEndHookInput,
  PiToolExecutionStartHook,
  PiTurnFailure,
  PiTurnFailureHook,
  PiTurnFailureHookDecision,
  PiTurnFailureHookInput,
  PiTurnHooks,
  PiTurnEndHookInput,
} from './hooks.js';

export { hasThinkingPrefixBinding as keepsRequestImages } from './thinking-prefix-binding.js';
