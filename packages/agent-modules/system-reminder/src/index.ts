/**
 * System-reminder module — framework-agnostic `<system-reminder>` injection.
 *
 * Architecture: chain-of-responsibility pattern.
 *
 * - SystemReminderRegistry: append `ReminderProviderFn` per framework type
 * - createDefaultRegistry: factory with all built-in providers pre-loaded
 * - SystemReminderService: orchestrates data collection + provider execution
 *
 * The host supplies an IO-heavy `DataCollector` implementation. This package
 * stays IO-free and focuses on block assembly + scheduling; all runtime
 * collaborators (logger, request context, config, date formatting) are
 * injected so it never imports a runtime host package.
 *
 * Usage (host side):
 *
 *   const collector = new SomeDataCollector(stores, ...);
 *   const registry = createDefaultRegistry(formatLocalDateTime);
 *   registry.append('boardNudgeProvider', createBoardNudgeProvider(nudgeRegistry));
 *   const service = new SystemReminderService(
 *     collector, registry, dataDir, logger, backgroundCtx, { disableModelPrefixes: [] });
 */

export { SystemReminderService } from './service.js';
export { SystemReminderRegistry, type NamedProvider } from './registry.js';
export {
  buildPluginReferenceReminder,
  detectPluginReferencesForMessages,
  type EffectivePluginCapabilityInventory,
  type EffectivePluginToolGroup,
} from './plugin-reference.js';
export {
  createDefaultRegistry,
  createBoardNudgeProvider,
  // Allowlist + policy helpers (cloud-runtime path)
  stripProviderSuffix,
  findReminderPolicy,
  effectiveInterval,
  effectiveMs,
  effectiveMsOr,
  // Individual providers (re-exported for test harnesses)
  agentContextProvider,
  peersUpdateProvider,
  activePlanReminderProvider,
  memorySkillReminderProvider,
  proactiveMemoryProvider,
  memoryTopicsProvider,
  personaMissingProvider,
  createBranchNotificationProvider,
  pendingSessionRemindersProvider,
  taskCompletionReminderProvider,
  evolutionReminderProvider,
  bootstrapProvider,
  worktreeReminderProvider,
  teamMemoryProvider,
  relevantMemoryProvider,
  userMemoryUpdateProvider,
  agentMemoryUpdateProvider,
  memorySummaryUpdateProvider,
  dailyMemoryUpdateProvider,
  identityUpdateProvider,
  configUpdateProvider,
  inboundMetaProvider,
  skillEvolutionChannelsProvider,
  skillSignalReportingProvider,
  asyncAuditProvider,
  mediaOutputReminderProvider,
  secretEnvReminderProvider,
  // Threshold constants
  COLD_START_COOLDOWN_MS,
  // Test helpers (intentionally underscored)
  _resetColdStartCooldownForTests,
  _resetMemorySkillReminderStateForTests,
  _resetAsyncAuditStateForTests,
  _resetMediaOutputStateForTests,
  _resetSecretEnvReminderStateForTests,
} from './providers.js';
export {
  configureSystemReminderHost,
  getDefaultNudgeRegistry,
  _resetSystemReminderHostForTests,
  type SystemReminderHostUtils,
} from './collaborators.js';
export {
  updateTodoState,
  getTodoState,
  clearTodoState,
  touchTodoStateTurn,
  shouldInjectTodoCompletionReminder,
  summarizeTodoStatuses,
  isTodoTerminal,
  _resetTodoStateForTests,
  type TodoStateSummary,
  type TodoStatus,
} from './todo-state.js';
export { boundMap, getEvolutionReminder, type EvolutionState } from './evolution.js';
export {
  buildMcodeToolsMasterReminderBlock,
  withMcodeToolsMasterReminder,
} from './mcode-tools-master-reminder.js';
export { unwrapSystemReminder, wrapSystemReminderBlocks } from './envelope.js';
export {
  buildAskUserGuidanceBlock,
  buildAskUserPolicyBlock,
  decideAskUserReminders,
  findLatestAskUserPolicyDeclaration,
  hasAskUserGuidance,
  type AskUserGuidanceReminderReason,
  type AskUserPolicyReminderReason,
  type AskUserReminderDecision,
  type AskUserReminderPolicy,
} from './ask-user-reminders.js';
// Block builders — exported so cloud-runtime and adjacent surfaces can render
// individual blocks outside the registry/service pipeline.
export {
  formatPeersAggregated,
  buildAgentContextBlock,
  buildSlimAgentContextBlock,
  buildPeersUpdateBlock,
  buildActivePlanReminderBlock,
  buildPersonaMissingBlock,
  buildBootstrapBlock,
  buildWorktreeReminderBlock,
  buildTeamMemoryBlock,
  buildRelevantMemoryBlock,
  buildUserMemoryUpdateBlock,
  buildAgentMemoryUpdateBlock,
  buildMemorySummaryUpdateBlock,
  buildDailyMemoryUpdateBlock,
  buildIdentityUpdateBlock,
  buildConfigUpdateBlock,
  buildInboundMetaBlock,
  buildMemorySkillReminder,
  buildProactiveMemoryBlock,
  buildMemoryTopicsBlock,
  buildEvolutionReminderBlock,
  buildSkillEvolutionChannelsBlock,
  buildAsyncAuditBlock,
  buildMediaOutputReminderBlock,
  buildTaskCompletionReminderBlock,
  buildBoardNudgeBlock,
  buildSecretEnvBlock,
  RUNTIME_MANAGED_RESULT_DELIVERY_LINE,
} from './blocks.js';
export type {
  SystemReminderInput,
  ReminderProviderFn,
  SkillEntry,
  AgentEnv,
  PeerInfo,
  AgentIdentity,
  ActivePlanSummary,
  MemoryDirSnapshot,
  MemorySkillReminderStatus,
  MemoryTopicSummary,
  ReminderPolicyEntry,
  ReminderPolicyFrequency,
  ReminderPolicyThresholds,
} from './types.js';
export { EVOLUTION_CONFIG } from './types.js';
export type {
  DataCollector,
  NudgeInfo,
  NudgeRegistry,
  Logger,
  LogContext,
  ReminderConfig,
  DateFormatter,
  ModelSelector,
  ModelSelection,
  ProviderDiagnostic,
  SystemReminderDiagnostic,
} from './dependencies.js';
// Narrow session/message contracts owned by this package — cloud-runtime and
// other consumers build minimal SessionInfo/MessageRequest shims for
// buildReminder calls from these.
export type { SessionInfo, MessageRequest } from './types.js';
export { AgentFrameworkType, AgentRole, Role, SessionType } from './types.js';
