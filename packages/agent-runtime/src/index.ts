/**
 * `@mavis/agent-runtime` —— pluggable extension SPI + assembleTurn assembler.
 *
 * See design doc: 飞书 wiki《agent-runtime：agent-core 之上的可插拔扩展层》v1.0
 * (`.harness/docs/adr/agent-runtime-extension-layer.md` when ADR lands)
 *
 * Public surface:
 *   - `createAgentRuntime(opts)` —— host 入口
 *   - `AgentRuntime` interface
 *   - `AgentExtension / ExtensionAPI / TurnAssemblyCtx / AssemblyResult` SPI types
 *   - `resolveExtensions()` —— 单元测试可直接调；host 通常无需直接使用
 *
 * 内部实现 (`Registry`) 通过 named export 暴露给 test 使用，业务代码走 `createAgentRuntime`。
 */

export { createAgentRuntime } from './api.js';
export {
  createExtension,
  createHookExtension,
  createPromptExtension,
  createReminderExtension,
  createToolExtension,
} from './factories.js';
export type {
  CreateExtensionOptions,
  CreateHookExtensionOptions,
  CreatePromptExtensionOptions,
  CreateReminderExtensionOptions,
  CreateToolExtensionOptions,
} from './factories.js';
export { Registry } from './registry.js';
export { resolveExtensions } from './resolve.js';
export type {
  PromptReadScope,
  PromptReadSnapshot,
  PromptSnapshotSource,
  PromptTemplateRead,
} from './prompt-read.js';
export { isPromptSnapshotInvalidError, PromptSnapshotInvalidError } from './prompt-read.js';
export { BoundedInternalTurnPromptReadRegistry } from './internal-turn-prompt-read.js';
export type { InternalTurnPromptReadRegistry } from './internal-turn-prompt-read.js';
export {
  defineRuntimeTool,
  TURN_STOPPING_TOOL_RESULT_DETAIL,
  TURN_TERMINATING_TOOL_RESULT_DETAIL,
} from '@mavis/agent-core/tools';
export type { ToolExecutionContext } from '@mavis/agent-core/tools';
export {
  buildToolCallCitationId,
  collapseAdjacentDuplicateFileCitations,
  collectFetchedWebSources,
  collectWebSourceCitations,
  collectUsedWebEvidenceIds,
  readMcpInvokeArguments,
  shellSourceStages,
  type ContextualWebCitation,
  compactToolCallCitationKey,
  findUniqueSingleSubstitutionCitationAlias,
  resolveKnownCitationAlias,
} from '@mavis/agent-core';
export * from './types.js';
export {
  NEXT_STEP_APP_ACTIONS,
  NEXT_STEP_ASK_MAX,
  NEXT_STEP_ASK_TARGET,
  NEXT_STEP_LABEL_MAX,
  NEXT_STEP_LABEL_MIN,
  NEXT_STEP_MAX_ACTIONS,
  NEXT_STEP_RECAP_MAX,
  breaksAppActionLimits,
  isBackgroundTaskUserMessage,
  isHostSubmittedUserInput,
  isNextStepAction,
  readNextStepCard,
  trimNextStepActions,
  type NextStepAction,
  type NextStepAppAction,
} from '@mavis/agent-core';

export { readMiniAppSuggestion, type MiniAppSuggestionBrief } from '@mavis/agent-core';
