/**
 * Permission subsystem — public surface.
 *
 * The public surface is:
 *
 *   - `PermissionEngine` + deterministic checkers in `tools/*` — checker
 *     dispatch and the explicit legacy rollback path used by
 *     `LocalPermissionFacade`.
 *   - `permission-core.ts` — the default production policy reducer plus the
 *     structured CommandIntent / ExecutionPlan contract.
 *   - HARD/SOFT dangerous-pattern registries in `classifier/dangerous-patterns.ts`
 *     consumed internally by the tool checkers.
 *   - `cloud-classify-client.ts` — utility for hosts to know whether to call
 *     the cloud gateway (`shouldUseCloudClassify`) and to resolve the API URL.
 *   - `reason-format.ts` — localized DecisionReason formatter shared by
 *     decision callers (facade, future cloud-runtime).
 *   - `cloud-gateway.ts` / `http-cloud-gateway-client.ts` /
 *     `conversation-renderer.ts` / `ask-policy.ts` — the cloud-gateway decision
 *     path the facade routes `auto` mode through.
 *
 * Hosts must call `configurePermissionHost(...)` once at startup to wire the
 * concrete ports declared in `host-ports.ts`. Cross-cutting helpers (logger,
 * region/build-env, datetime) flow through `configurePermissionHost`.
 */

// ── Core types ──
export type {
  PermissionBehavior,
  PermissionMode,
  PermissionRule,
  PermissionRuleValue,
  PermissionRuleAction,
  PermissionRuleMatcher,
  PermissionRuleSource,
  ShellPermissionRule,
  DecisionReason,
  SubcommandResult,
  PermissionDecision,
  ToolCheckResult,
  CandidateScope,
  CandidateScopeGroup,
  PathCheckContext,
  PermissionUpdate,
  PermissionFileConfig,
  ToolPermissionContext,
} from './types.js';

// ── Deterministic safety registries (verbatim regex source of truth) ──
export {
  unwrapCommandWrappers,
  unwrapBashCommandWrappers,
  readBashInlineScript,
} from './tools/bash-wrapper-unwrap.js';
export { isRmCommand, parseRmTargets, splitCommand } from './tools/bash-permission.js';
export { stripDataHeredocBodies } from './tools/bash-safety-scan.js';
export { splitShellSourceSegments } from './tools/bash-split.js';
export {
  parseScriptPlainCommands,
  parseShellLcPlainCommands,
  parseShellLcSingleCommandPrefix,
} from './tools/bash-ast.js';
export {
  parseWindowsNativeDelete,
  type WindowsNativeDeleteCommand,
} from './tools/windows-native-delete.js';
export {
  readWindowsTrashExecution,
  withWindowsTrashExecution,
  type WindowsTrashExecution,
} from './windows-trash-execution.js';
export { snapshotPermissionEffectiveInput, snapshotPermissionInput } from './effective-input.js';
export {
  createPermissionExecutionPlan,
  validatePermissionExecutionPlan,
} from './execution-plan.js';
export type { CreatePermissionExecutionPlanInput } from './execution-plan.js';
export { isKnownSafeCommand } from './tools/safe-command.js';
export { isKnownSafePowerShellCommand } from './tools/safe-command.js';
export { findGitSubcommand } from './tools/safe-command.js';
export { shellTokenize } from './tools/shell-tokenize.js';
export { isSameResolvedPath, reachesRootInOtherCase } from './tools/path-identity.js';
export { READ_ONLY_TOOLS, TEMPLATE_SUFFIXES } from './tools/fs-permission.js';
export { WRITE_TOOLS } from './tools/fs-input.js';
export { resolveWriteTargetLocation, type WriteTargetLocation } from './tools/fs-input.js';
export type { ToolPermissionChecker } from './engine.js';
export { createToolPermissionContext } from './context.js';
export { resolvePermissionPath } from './path-resolver.js';
export { extractBashPathIntents } from './tools/path-capability.js';
export { readBashCommand, gitBashCommandName } from './tools/bash-command.js';
export { findHeredocBodies } from './tools/bash-split.js';
export {
  isShellCommentStart,
  findShellCommentLineEnd,
  readBashExpansion,
} from './tools/bash-expansion.js';
export {
  commandHasExecutedHeredocBody,
  commandHasShellScriptHeredocBody,
} from './tools/bash-safety-scan.js';
export type { PermissionPathResolutionContext } from './path-resolver.js';

// ── Permission Core contract / reducer ──
export {
  reducePermissionClassifierDecision,
  reducePermissionDecision,
  reducePermissionEvaluation,
  permissionModeToProfile,
} from './permission-core.js';
export type {
  PermissionPolicyOwner,
  PermissionCheckOptions,
  PermissionCheckerDecisionTrace,
  PermissionCoreDecisionInput,
  PermissionAction,
  ShellFamily,
  PathValue,
  CommandIntent,
  PermissionEvidence,
  ExecutionTransform,
  ExecutionPlan,
  PermissionModeProfile,
  PermissionEvaluationInput,
  PermissionApprovalRequest,
  PermissionEvaluation,
} from './permission-core.js';

// ── MCP rule identity `(plugin, server, tool)` ──
export {
  MCP_ALLOW_NOT_INHERITED,
  MCP_PLUGIN_RULE_PREFIX,
  mcpPluginRuleKey,
} from './mcp-rule-subject.js';
export type { McpToolRuleSubject } from './mcp-rule-subject.js';

export {
  adaptLegacyPermissionResult,
  evaluateLegacyPermission,
} from './legacy-permission-adapter.js';
export type {
  LegacyAdapterInput,
  LegacyEvaluationInput,
  LegacyParserAdapterResult,
} from './legacy-permission-adapter.js';

// ── Cloud gateway gating ──
export { shouldUseCloudClassify } from './classifier/cloud-classify-client.js';

// ── Default cloud-gateway classifier budget. `HttpCloudGatewayClient` uses
//    this as its per-call timeout default.
export const AUTO_CLASSIFIER_TIMEOUT_MS_DEFAULT = 60_000;

// ── Host-port surface (consumed by hosts to wire concrete deps) ──
export {
  configurePermissionHost,
  resetPermissionHostForTesting,
  getPermissionManagedAuthToken,
  getPermissionPrompt,
  type PermissionHostUtils,
} from './host-utils.js';
export type {
  PermissionPromptProvider,
  ManagedAuthTokenGetter,
  PermissionStorePort,
  SessionResolverPort,
  AgentResolverPort,
  MessageStorePort,
  ConfigWriterPort,
  PermissionRequestStore,
  PermissionRequestRecord,
} from './host-ports.js';

// ── Localized reason formatter (shared wire output) ──
export {
  formatDecisionReason,
  formatAutoClassifierReason,
  formatBlockedToolReason,
  localeOrDefault,
  type Lang,
  type ToolDenialSource,
  type BlockedToolReasonInput,
} from './reason-format.js';

// ── User-locale detection (used by hosts to pick zh/en templates) ──
export { detectTextLocale, detectMessagesLocale, type UserLocaleHint } from './locale-detect.js';

// ── Ask-policy + cloud gateway ──
export { modeToAskPolicy } from './ask-policy.js';
export type { AskForApproval, ProposedRule, ProposedRuleScope } from './ask-policy.js';
export { renderConversationContext } from './conversation-renderer.js';
export type { RenderConversationContextInput } from './conversation-renderer.js';
export type {
  CloudGatewayClient,
  CloudClassifyFailureReason,
  CloudClassifyRequest,
  CloudClassifyVerdict,
} from './cloud-gateway.js';
export { HttpCloudGatewayClient } from './http-cloud-gateway-client.js';
export type { HttpCloudGatewayClientOptions } from './http-cloud-gateway-client.js';
export { InMemoryCloudGatewayClient } from './in-memory-cloud-gateway-client.js';
export type { InMemoryCloudGatewayClientOptions } from './in-memory-cloud-gateway-client.js';

export { createDeferredPluginHookPermissionCapability } from './plugin-hook-permission-port.js';
export type {
  PluginHookPermissionUpdateDestination,
  PluginHookPermissionUpdateMode,
  PluginHookPermissionRuleValue,
  PluginHookPermissionUpdate,
  LocalPluginHookEffectivePermissions,
  LocalPluginHookPermissionMutationInput,
  LocalPluginHookPermissionCapability,
} from './plugin-hook-permission-port.js';


export { PermissionEngine } from './engine.js';
export { registerDefaultCheckers } from './tools/index.js';
export { matchHardBlockedBash } from './classifier/dangerous-patterns.js';
