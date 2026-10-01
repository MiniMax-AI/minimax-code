/**
 * `@mavis/goal` —— codex-style Thread Goal primitives.
 *
 * This subpath is **IO-free** by design:
 *   - 4-state status model + objective validation (`types.ts`)
 *   - Pluggable persistence port (`store-port.ts`)
 *   - 3 LLM-facing tool defs + impls (`tool-defs.ts` / `tool-impls.ts`)
 *   - Continuation prompt renderer (`continuation.ts`)
 *
 * The model-facing `update_goal` surface separates host-settled complete /
 * blocked proposals from host-authorized token-budget edits. Neither path can
 * overwrite a concurrent user mutation because durable writes remain guarded
 * by the Host.
 *
 * Host packages wire a concrete `ThreadGoalStore` implementation
 * (`local-runtime/SqliteThreadGoalStore`, etc.) into the tool impls
 * and the HTTP API.
 *
 * Tool name convention is kept verbatim from codex (`create_goal` /
 * `update_goal` / `get_goal`) so models trained against codex tooling
 * recognize them without retraining.
 */

export type {
  GoalTurnSignal,
  GoalTurnBinding,
  ThreadGoalAttachment,
  ThreadGoalKickoffState,
  LastVerificationV1,
  LastWorkerProposalV1,
  ThreadGoalFailureClass,
  ThreadGoalExecutionWait,
  ThreadGoalState,
  ThreadGoalSignalCollectionResult,
  ThreadGoalStatus,
  ThreadGoalStatusReason,
  ThreadGoalWaitReason,
  ThreadGoalVerification,
} from './types.js';
export {
  CONTINUATION_STATUSES,
  THREAD_GOAL_STATUSES,
  THREAD_GOAL_STATUS_REASONS,
  THREAD_GOAL_WAIT_REASONS,
  THREAD_GOAL_VERIFICATIONS,
  TERMINAL_STATUSES,
  isContinuationStatus,
  isTerminalStatus,
  validateThreadGoalObjective,
} from './types.js';

export type {
  ThreadGoalBoundStoreOperations,
  ThreadGoalBoundUsageDelta,
  ThreadGoalBoundUsageResult,
  ThreadGoalBoundUsageStaleReason,
  ThreadGoalBudgetCheckResult,
  ThreadGoalBudgetDimension,
  ThreadGoalBudgetLimits,
  ThreadGoalBreakerInput,
  ThreadGoalBreakerCause,
  ThreadGoalBreakerResult,
  ThreadGoalBreakerStaleReason,
  ThreadGoalToolActivity,
  ThreadGoalCreateInput,
  ThreadGoalDecisionResult,
  ThreadGoalDecisionStaleReason,
  ThreadGoalPatchInput,
  ThreadGoalRecordVerificationInput,
  ThreadGoalSettleBoundTurnInput,
  ThreadGoalStore,
  ThreadGoalWorkerProposalInput,
} from './store-port.js';
export {
  ThreadGoalAlreadyExistsError,
  ThreadGoalBudgetLimitedError,
  ThreadGoalEpochConflictError,
  ThreadGoalObjectiveConflictError,
  ThreadGoalStatusConflictError,
  ThreadGoalTokenBudgetExhaustedError,
} from './store-port.js';

export {
  DEFAULT_GOAL_CONTINUATION_TEMPLATE,
  DEFAULT_GOAL_RECOVERY_TEMPLATE,
  DEFAULT_GOAL_RECOVERY_TERMINAL_AUDIT_TEMPLATE,
  DEFAULT_GOAL_TERMINAL_AUDIT_TEMPLATE,
  renderKickoffPrompt,
  renderContinuationPrompt,
  renderNudgePrompt,
  renderRecoveryPrompt,
  renderRecoveryTerminalAuditPrompt,
  renderTerminalAuditPrompt,
} from './continuation.js';
export {
  DEFAULT_OBJECTIVE_UPDATED_TEMPLATE,
  renderObjectiveUpdatedPrompt,
} from './objective-updated.js';
export { DEFAULT_BUDGET_LIMIT_TEMPLATE, renderBudgetLimitPrompt } from './budget-limit.js';
export { fingerprintThreadGoalReply } from './reply-fingerprint.js';
export { digestThreadGoalObjective } from './objective-digest.js';
export {
  boundVerificationTranscript,
  type TranscriptWindowResult,
} from './verification/transcript-window.js';
export type {
  TranscriptWindow,
  TranscriptWindowReader,
  VerificationEvidence,
  VerificationEvidenceMode,
  VerificationAttempt,
  VerificationBackend,
  VerificationHostContext,
  VerificationDispatchFailureCode,
  VerificationResult,
  VerificationTraceRef,
  VerificationUsage,
  VerificationVerdict,
  VerifierPort,
} from './verification/verifier-port.js';
export {
  assembleVerificationEvidence,
  MAX_EVALUATOR_TAIL_CHARS,
  MAX_EVALUATOR_TAIL_MESSAGES,
  MAX_SUBAGENT_VERIFICATION_PROMPT_CHARS,
  MAX_TRANSCRIPT_FALLBACK_CHARS,
  MAX_TRANSCRIPT_FALLBACK_MESSAGES,
  MAX_VERIFICATION_BRIEF_CHARS,
} from './verification/evidence-brief.js';
export { VerificationDispatchError } from './verification/verifier-port.js';
export {
  createEvaluatorVerifierAdapter,
  evaluatorVerdictJsonSchema,
  EvaluatorModelCallError,
  parseVerificationVerdictJson,
} from './verification/evaluator-adapter.js';
export { createSubagentVerifierAdapter } from './verification/subagent.js';
export { verificationModeForRoute } from './verification/verification-policy.js';
export type {
  SubagentModelVerdict,
  SubagentVerificationExecutionPort,
  SubagentVerificationRunInput,
  SubagentVerificationRunResult,
  SubagentVerifierAdapterOptions,
} from './verification/subagent.js';
export type {
  EvaluatorAdapterOptions,
  EvaluatorModelCallFailureCode,
  EvaluatorModelCallInput,
  EvaluatorModelCallResult,
  EvaluatorModelPort,
  EvaluatorRouteIdentity,
  EvaluatorRouteKind,
} from './verification/evaluator-adapter.js';

export {
  INTERNAL_CONTEXT_OPEN_PREFIX,
  INTERNAL_CONTEXT_CLOSE_TAG,
  wrapInternalContext,
  isInternalContextMessage,
} from './internal-context-fragment.js';

export {
  CreateGoalToolDef,
  UpdateGoalToolDef,
  GetGoalToolDef,
  hasUpdateGoalTokenBudgetIntent,
  resolveUpdateGoalMode,
  type UpdateGoalResolvedMode,
  type CreateGoalToolInput,
  type UpdateGoalToolInput,
  type GetGoalToolInput,
} from './tool-defs.js';
export { CreateGoalTool, UpdateGoalTool, GetGoalTool } from './tool-impls.js';
export type {
  ThreadGoalSignalCollector,
  ThreadGoalToolMutationListener,
  ThreadGoalTokenBudgetMutationInput,
  ThreadGoalTokenBudgetMutationPort,
  ThreadGoalTokenBudgetMutationResult,
} from './tool-impls.js';
export {
  GOAL_COMPLETION_TOOL_REFUSAL,
  GOAL_FINAL_REPLY_INSTRUCTION,
  GOAL_FINAL_REPLY_RETRY_PROMPT,
  GOAL_FINAL_REPLY_RETRY_REASON,
  createGoalFinalReplyGate,
  isAcceptedGoalCompletionResult,
} from './final-reply.js';
export type {
  GoalFinalReplyGate,
  GoalFinalReplyResponse,
  GoalFinalReplyResponseDecision,
  GoalFinalReplyTurn,
} from './final-reply.js';
