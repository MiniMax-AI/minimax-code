/**
 * Built-in adapters from domain-owned agent modules to `@mavis/agent-runtime`.
 *
 * This package owns only SPI glue. It does not construct module instances,
 * choose a host profile, or provide a default extension list.
 */

export { sessionReportExtension, type SessionReportExtensionOptions } from './session-report.js';

export {
  contextManagerExtension,
  type ContextManagerExtensionObserver,
  type ContextManagerExtensionOptions,
} from './context-manager.js';
export {
  permissionExtension,
  type PermissionDecider,
  type PermissionExtensionOptions,
  type PermissionToolCallSummary,
} from './permission.js';
export { skillsExtension, type SkillMatcher, type SkillsExtensionOptions } from './skills.js';
export {
  systemReminderExtension,
  type SystemReminderContextResolver,
  type SystemReminderExtensionOptions,
  type SystemReminderResolvedContext,
} from './system-reminder.js';
export {
  toolOutputBudgetExtension,
  type ToolOutputArtifact,
  type ToolOutputArtifactInput,
  type ToolOutputBudgetExtensionOptions,
} from './tool-output-budget.js';
export { requestMediaExtension, type RequestMediaExtensionOptions } from './request-media.js';
export {
  runawayGuardExtension,
  runawayGuardShadowExtension,
  replayRunawayGuardTrajectory,
  type RunawayGuardExtensionOptions,
  type RunawayGuardShadowExtensionOptions,
  type RunawayGuardSignalKind,
  type RunawayGuardObservation,
  type RunawayGuardReminderObservation,
  type RunawayGuardTurnSummary,
  type RunawayGuardToolPolicy,
  type RunawayGuardVerifiedToolProgress,
  type RunawayGuardReplayInput,
  type RunawayGuardReplayResult,
} from './runaway-guard.js';
export {
  terminalResponseRecoveryExtension,
  type TerminalRecoveryObservation,
  type TerminalResponseRecoveryExtensionOptions,
} from './terminal-response-recovery.js';
export {
  outputLimitRecoveryExtension,
  type OutputLimitRecoveryExtensionOptions,
  type OutputLimitRecoveryObservation,
} from './output-limit-recovery.js';
export {
  appSourceAdapter,
  fileSourceAdapter,
  mcpSourceAdapter,
  SOURCE_REFERENCE_DETAILS_KEY,
  SOURCE_REFERENCE_MARKER_TAG,
  sourceReferenceExtension,
  type FileSourcePathResolution,
  type FileSourcePathResolver,
  type SourceReferenceExtensionOptions,
  type ToolSourceAdapter,
  type ToolSourceAdapterInput,
  type ToolSourceReference,
} from './source-reference.js';
export {
  PLAN_MODE_GUIDANCE,
  planModeExtension,
  renderPlanModeReminder,
  type PlanModeActionInput,
  type PlanModeExtensionOptions,
} from './plan-mode.js';
export {
  MiniAppLifecycleError,
  createMiniAppControlExtension,
  type MiniAppActionContext,
  type MiniAppTargetResult,
  type MiniAppBusyReason,
  type MiniAppInitResult,
  type MiniAppFailureDiagnostic,
  type MiniAppFailureReasonCode,
  type MiniAppFailureRecovery,
  type MiniAppFailureStage,
  type MiniAppLifecycle,
  type MiniAppLifecycleErrorCode,
  type MiniAppListResult,
  type MiniAppOpenResult,
  type MiniAppPublishActionContext,
  type MiniAppRunningSummary,
  type MiniAppRuntimeErrorDetail,
  type MiniAppSummary,
  type MiniAppTargetActionContext,
} from './miniapp.js';
