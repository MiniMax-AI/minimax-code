import type { Static, TSchema } from '@sinclair/typebox';

import type {
  RuntimeTool,
  RuntimeToolSource,
  ToolDefinition,
  ToolExecutionContext,
  ToolImpl,
  ToolResult,
} from './types.js';

export type RuntimeToolDeclaration<
  S extends TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> = ToolDefinition<S> & {
  source?: RuntimeToolSource;
  execute: ToolImpl<S, TCtx>['execute'];
};

/**
 * Declare a platform-owned runtime tool as one object while preserving the
 * protocol-level split between LLM-facing `def` and side-effecting `impl`.
 */
export function defineRuntimeTool<
  S extends TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
>(tool: RuntimeToolDeclaration<S, TCtx>): RuntimeTool<S, TCtx> {
  const {
    name,
    label,
    description,
    schema,
    loading,
    namespace,
    promptGuidelines,
    prepareArguments,
    executionMode,
    operationClassifier,
    interruptOnSteer,
    source,
    execute,
  } = tool;

  const def: ToolDefinition<S> = {
    name,
    ...(label !== undefined ? { label } : {}),
    description,
    schema,
    ...(loading !== undefined ? { loading } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
    ...(promptGuidelines !== undefined ? { promptGuidelines } : {}),
    ...(prepareArguments !== undefined
      ? { prepareArguments: prepareArguments as (args: unknown) => Static<S> }
      : {}),
    ...(executionMode !== undefined ? { executionMode } : {}),
    ...(operationClassifier !== undefined ? { operationClassifier } : {}),
    ...(interruptOnSteer !== undefined ? { interruptOnSteer } : {}),
  };

  return {
    def,
    impl: { execute },
    ...(source !== undefined ? { source } : {}),
  };
}
