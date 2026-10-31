/**
 * `@mavis/agent-core/tools` —— tool protocol types, `defineRuntimeTool`, and
 * decorated-class `bindTool` / `toRuntimeTool` helpers.
 *
 * Usage:
 *
 * ```ts
 * import { defineRuntimeTool } from '@mavis/agent-core/tools';
 * import { Type } from '@sinclair/typebox';
 *
 * const CloudBashTool = defineRuntimeTool({
 *   name: 'bash',
 *   description: 'Execute a command in the cloud sandbox executor.',
 *   schema: Type.Object({ command: Type.String() }),
 *   async execute(ctx, input, signal) { ... },
 * });
 * ```
 */

export type {
  ProgrammaticToolCompleteness,
  ProgrammaticToolResult,
  ToolDefinition,
  ToolImpl,
  ToolResult,
  ToolResultContent,
  ToolExecutionContext,
  ToolExecutionMode,
  ToolOperationClassifier,
  RuntimeTool,
  RuntimeToolSource,
  ToolCallProvenanceResolutionInput,
  ToolCallProvenanceResolver,
} from './types.js';
export {
  attachProgrammaticErrorData,
  attachProgrammaticErrorRaw,
  type ProgrammaticImageEncoding,
  readImageEncodedContent,
  readProgrammaticErrorData,
  readProgrammaticErrorRaw,
  recordImageEncodedContent,
  withProgrammaticResult,
} from './programmatic.js';
export {
  createPtcToolFactCollector,
  PTC_DEFAULT_WALL_CLOCK_MS,
  PTC_MAX_WALL_CLOCK_MS,
  readPtcChildExecutionDetails,
  readPtcExecutionDetails,
  readPtcToolCallRecords,
  resolvePtcWallClock,
  type PtcChildCallStatus,
  type PtcChildDeadline,
  type PtcChildTimeoutDecision,
  type PtcChildExecutionDetails,
  type PtcExecutionDetails,
  type PtcRetainedFact,
  type PtcToolCallRecord,
  type PtcToolExecutionBatch,
  type PtcToolExecutionError,
  type PtcToolExecutionOutcome,
  type PtcToolExecutionRequest,
  type PtcToolExecutor,
  type PtcToolFactCollector,
  type PtcToolResultProjection,
  type PtcToolResultProjectionInput,
  type PtcToolSource,
  type PtcWallClock,
  type PtcWallClockSource,
} from './ptc.js';
export {
  TURN_TERMINATING_TOOL_RESULT_DETAIL,
  isTurnTerminatingToolResultDetails,
} from './turn-termination.js';
export { defineRuntimeTool, type RuntimeToolDeclaration } from './define.js';
export { bindTool, toRuntimeTool } from './bind.js';
export { prepareEditArguments, type PreparedEditArguments } from './edit-prepare-arguments.js';
export {
  coerceRuntimeToolInput,
  isRuntimeToolInputValid,
} from './input-validation.js';
export {
  ReadToolDef,
  WriteToolDef,
  EditToolDef,
  BashToolDef,
  GrepToolDef,
  GlobToolDef,
  TodoWriteToolDef,
  TaskToolDef,
  type ReadToolInput,
  type WriteToolInput,
  type EditToolInput,
  type BashToolInput,
  type GrepToolInput,
  type GlobToolInput,
  type TodoWriteToolInput,
  type TaskToolInput,
} from './builtin-defs.js';
