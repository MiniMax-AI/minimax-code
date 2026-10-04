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
export { composeStreamFn } from './llm.js';
export {
  LLM_FIRST_EVENT_TIMEOUT_ENV,
  LLM_FIRST_EVENT_TIMEOUT_MS,
  LLM_STREAM_IDLE_TIMEOUT_ENV,
  LLM_STREAM_IDLE_TIMEOUT_MS,
} from './defaults.js';
export {
  LLM_STREAM_TIMEOUT_MESSAGE_PREFIX,
  resolveLLMStreamTimeouts,
  withLLMStreamTimeouts,
  type LLMStreamTimeoutConfig,
  type LLMStreamTimeouts,
} from './llm-stream-timeout.js';
export { normalizeAbortSource } from './types.js';
export {
  DEFAULT_LLM_RETRY_POLICY,
  LLM_RETRY_CALL_IDENTITY,
  LLM_RETRY_REQUEST_SETTLED_OBSERVER,
  withLLMRetry,
  type LLMCallErrorKind,
  type LLMCallOutcome,
  type LLMCallScope,
  type LLMCallSettledEvent,
  type LLMCallUsage,
  type LLMExpectedToolIdentity,
  type LLMRequestSettledEvent,
  type LLMRequestSettledObserver,
  type LLMRetryError,
  type LLMRetryEvent,
  type LLMRetryOptions,
  type LLMRetryPolicy,
  type LLMRetryStatus,
} from './llm-retry.js';
export type { LlmCaptureAgentEventSource, LlmCaptureRecorder } from './turn.js';
export { createPiTurnHistogramBucketsByName, recordPiLLMCallMetrics } from './metrics.js';
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
  projectAgentMessagesForModel,
  removeOrphanToolResults,
} from './outbound-message-normalizer.js';
export { toPiUserMessage } from './agent.js';
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
  RunTurnCaller,
  RunTurnInput,
  RunTurnStartMode,
  RuntimeEvent,
  SteeringPollContext,
  TurnEventReporter,
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
  PiHistoryChangeReason,
  PiLlmCallPreparedHookInput,
  PiOnLlmCallPreparedHook,
  PiOnHistoryChangedHook,
  PiOnStepEndHook,
  PiOnTurnEndHook,
  PiStepEndHookInput,
  PiToolExecutionStartHook,
  PiTurnHooks,
  PiTurnEndHookInput,
} from './hooks.js';
