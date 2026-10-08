export type {
  AbortTurnInput,
  AbortTurnResult,
  ActivateTurnResult,
  AgentHostInputAttachment,
  AgentHostTurnOutcome,
  ConversationEditAdmissionInput,
  ConversationEditAdmissionResult,
  ContinueTurnInput,
  ContinueTurnResult,
  HistoryForkInput,
  HistoryForkResult,
  HistoryRewindInput,
  HistoryRewindResult,
  InitializeTurnSystemOptions,
  InspectTurnContinuationResult,
  RequestCompactionResult,
  QueueDispatchDisposition,
  QueueSteerConsumeOutcome,
  QueueSteerControl,
  QueueSteerDispatchResult,
  SteerSessionInput,
  SteerSessionResult,
  SubmitTurnResult,
  SubmitTurnSubmission,
  TurnService,
  TurnContinuationState,
  TurnAdmissionPolicy,
  TurnSubmissionPreparation,
  TurnSubmissionPreparationResult,
  TurnDiffRewindOutcome,
  TurnRewindProjectionCapability,
  TurnSystemOwner,
  TurnSystemSessionCapabilities,
} from './contracts.js';
export type { TurnOutputContract } from './agent-host/contracts.js';
export { isUserSteeringProducer } from './agent-host/contracts.js';
export { digestTurnInput } from './execution/turn-input-identity.js';
export { parseBackgroundTaskOriginMetadata } from './agent-host/contracts.js';
export { queueClaimDeliveryInput } from './queue.dispatcher.js';
export { composeTurnAdmissionPolicies } from './admission-contracts.js';
export { initializeTurnSystem } from './initialize.js';
export * from './persistence/cli-sunset-notice.js';
export * from './persistence/global-instructions.js';
export { createLocalStaticPromptReader } from './agent-host/preparation/index.js';
export { readLocalInstructionSources } from './agent-host/preparation/static-prompt-reader.js';
export {
  requireAgentRuntime,
  requireTurnSystem,
} from './lifecycle/runtime-initialization-guards.js';
export {
  composeTurnSubmissionPreparations,
  createGoalTurnSubmissionPreparation,
} from './execution/submission-preparation.js';
export {
  hasPriorityUserQueueItem,
  resolveGenuineUserQueryText,
} from './execution/message-query-authorship.js';
export { DEFAULT_RETRY_CONTINUATION_PROMPT } from './agent-host/preparation/config/prompt-templates.js';
export {
  HistoryMutationError,
  type HistoryMutationErrorCode,
} from './lifecycle/history-mutation-capability.js';
export {
  combineAgentEventObservers,
  createLocalAgentHost,
  createProductionAgentPreparation,
  createProductionRootArchiveTitleModel,
  createProductionSessionTitleModel,
  createSessionLLMRetryEventObserver,
} from './production-composition.js';
export type {
  CreateLocalAgentHostOptions,
  LocalAgentHostComposition,
  ProductionAgentPreparation,
  ProductionAgentProductCapabilities,
  ProductionSessionTitleProductCapabilities,
} from './production-composition.js';
export type { ToolResultCompactionConfig } from './compaction/contracts.js';
export type { AgentHostRuntimeLifecycle } from './agent-host/native-production-dependencies.js';
export {
  ModelRouteAvailabilityError,
  createSessionModelRepair,
  type SessionModelRecordMutator,
  type SessionModelRepairCapability,
  type SessionModelRepairLogger,
} from './agent-host/preparation/config/session-model-selection.js';
export {
  AgentHostTurnCapabilityLifecycle,
  type AgentHostTurnCapabilityPreparation,
  type AgentHostTurnCapabilityProvider,
  type AgentHostTurnCapabilityView,
  type AgentHostTurnPublicationPort,
  type AgentHostTurnRuntimeToolBinding,
  type AgentHostTurnToolMode,
} from './agent-host/assembly/turn-capability-lifecycle.js';
export {
  createLocalAgentCapabilitySelector,
  filterLocalTurnCapabilityInventory,
  type FilteredLocalTurnCapabilityInventory,
  type LocalAgentCapabilitySelector,
  type LocalTurnAgentProfileFacts,
  type LocalTurnRawToolSources,
} from './agent-host/assembly/local-turn-tool-catalog.js';
export type {
  AgentEventBestEffortObserver,
  AgentEventContext,
  AgentHostSteeringMessage,
  LocalTurnToolPolicyGuard,
} from './agent-host/index.js';
export type {
  AgentExecutionSource,
  AgentExecutionSnapshot,
  LocalAgentCapabilityCeiling,
  LocalAgentConfigurationSelection,
  LocalAgentExecutionProfile,
  LocalAgentProfileSource,
} from './agent-host/preparation/contracts.js';
export { resolveAgentPromptSurface } from './agent-host/preparation/agent-prompt-surface.js';
export type { SystemPromptOverrides } from './agent-host/preparation/index.js';
export {
  configureLocalPluginHookEnabledResolver,
  configureLocalPluginHookObservability,
  configureLocalPluginHookSessionEndFence,
  deactivateLocalPluginHooks,
  abortLocalPluginHookSessionTurn,
  disposeLocalPluginHookSessions,
  endAllLocalPluginHookSessionsForLogout,
  endLocalPluginHookSession,
  markNextLocalPluginHookSessionStart,
} from './agent-host/assembly/local-turn-plugin-hooks.js';
export { buildLocalTurnPayloadTransform } from './agent-host/index.js';

export { normalizeModelSelection, type UserModelSelection } from './agent-host/index.js';
