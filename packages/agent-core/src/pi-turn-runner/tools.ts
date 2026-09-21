import type {
  AfterToolCallContext,
  AfterToolCallResult,
  Agent,
  AgentTool,
  AgentToolResult,
  BeforeToolCallContext,
} from '@earendil-works/pi-agent-core';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent/tools';
import { createBashEnvSpawnHook, resolveBashEnvPolicy } from '../bash-subprocess-env.js';
import type { TSchema } from '@sinclair/typebox';
import type { RuntimeTool, ToolExecutionContext } from '../tools/index.js';
import type { RuntimeToolSource } from '../tools/types.js';
import type { turnState } from './turn.js';

type SourcedAgentTool = AgentTool & { source?: RuntimeToolSource };
type ToolCallContextWithSource<TContext extends { toolCall: { name: string } }> = TContext & {
  toolCall: TContext['toolCall'] & { source?: RuntimeToolSource };
};

export function newTools<TCtx extends ToolExecutionContext>(
  cwd: string,
  bound: readonly RuntimeTool<TSchema, TCtx>[],
  ctx: TCtx,
  options: {
    disableBuiltinFallback?: boolean;
    readAssistantMessageId?: () => string | undefined;
  } = {},
): AgentTool[] {
  const seen = new Set<string>();
  const out: AgentTool[] = [];
  for (const b of bound) {
    if (seen.has(b.def.name)) {
      throw new Error(`PiTurnRunner: duplicate tool name '${b.def.name}'`);
    }
    seen.add(b.def.name);
    out.push(newTool(b, ctx, options.readAssistantMessageId));
  }
  if (!options.disableBuiltinFallback) {
    if (!seen.has('read')) out.push(withFallbackExecutionMode(createReadTool(cwd), 'parallel'));
    if (!seen.has('write')) out.push(withFallbackExecutionMode(createWriteTool(cwd), 'sequential'));
    if (!seen.has('edit')) out.push(withFallbackExecutionMode(createEditTool(cwd), 'sequential'));
    if (!seen.has('bash')) {
      // Builtin fallback path must apply the same env sanitizer as
      // LocalBashTool and the background executor — no side door
      // (bash-tool-optimization.md §2.2).
      //
      // This is the ONE spawn site that keeps `resolveBashEnvPolicy()` as a
      // default instead of a caller-supplied policy: it is unreachable in
      // production (the local registry always binds LocalBashTool, and both
      // local-runtime-v2 and cloud-task set disableBuiltinFallback), and
      // agent-core cannot depend on the host's shim-aware policy without
      // breaking the src boundary (no node:fs here). If this fallback ever
      // becomes reachable with a dataDir, thread a policy in explicitly.
      out.push(
        withFallbackExecutionMode(
          createBashTool(cwd, { spawnHook: createBashEnvSpawnHook(resolveBashEnvPolicy()) }),
          'sequential',
        ),
      );
    }
  }
  return out;
}

export function setToolHooks(agent: Agent, turn: turnState): void {
  const sourceByToolName = new Map(
    turn.tools
      .map((tool) => [tool.name, readRuntimeToolSource(tool)] as const)
      .filter((entry): entry is readonly [string, RuntimeToolSource] => entry[1] !== undefined),
  );

  if (turn.hooks.beforeTool.length > 0) {
    agent.beforeToolCall = async (toolContext, signal) => {
      const sourcedContext = attachRuntimeToolSource(toolContext, sourceByToolName);
      for (const hook of turn.hooks.beforeTool) {
        const result = await hook(sourcedContext, signal ?? turn.input.signal);
        if (result?.block) {
          if (turn.hooks.onStepEnd.length > 0 && result.blockedBy) {
            turn.blockedToolCalls.push({
              toolCallId: toolContext.toolCall.id,
              blockedBy: result.blockedBy,
            });
          }
          return result;
        }
      }
      return undefined;
    };
  }

  if (turn.hooks.onToolExecutionStart.length > 0) {
    agent.onToolExecutionStart = (toolContext) => {
      const sourcedContext = attachRuntimeToolSource(toolContext, sourceByToolName);
      for (const hook of turn.hooks.onToolExecutionStart) hook(sourcedContext);
    };
  }

  agent.afterToolCall = async (toolContext, signal) => {
    let merged = toolResultErrorPatch(toolContext);
    let currentContext = attachRuntimeToolSource(
      merged ? applyToolResult(toolContext, merged) : toolContext,
      sourceByToolName,
    );
    for (const hook of turn.hooks.afterTool) {
      const patch = await hook(currentContext, signal ?? turn.input.signal);
      if (!patch) continue;
      merged = mergeToolResult(merged, patch);
      currentContext = applyToolResult(currentContext, patch);
    }
    return merged;
  };
}

function withFallbackExecutionMode(
  tool: AgentTool,
  executionMode: NonNullable<AgentTool['executionMode']>,
): AgentTool {
  return { ...tool, executionMode: tool.executionMode ?? executionMode };
}

function newTool<TCtx extends ToolExecutionContext>(
  b: RuntimeTool<TSchema, TCtx>,
  ctx: TCtx,
  readAssistantMessageId?: () => string | undefined,
): AgentTool {
  const tool: SourcedAgentTool = {
    name: b.def.name,
    label: b.def.label ?? b.def.name,
    description: b.def.description,
    parameters: b.def.schema as AgentTool['parameters'],
    ...(b.def.prepareArguments
      ? { prepareArguments: b.def.prepareArguments as AgentTool['prepareArguments'] }
      : {}),
    executionMode: b.def.executionMode ?? 'sequential',
    ...(b.source !== undefined ? { source: b.source } : {}),
    async execute(
      toolCallId,
      params,
      signal,
      onUpdate,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const input = (
        typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
      ) as never;
      const assistantMessageId = readAssistantMessageId?.();
      const callCtx = {
        ...ctx,
        toolCallId,
        ...(assistantMessageId ? { assistantMessageId } : {}),
      } as TCtx;
      const result = await b.impl.execute(callCtx, input, signal, onUpdate);
      return {
        content: result.content as AgentToolResult<Record<string, unknown>>['content'],
        details: toolResultDetails(result.details, result.isError),
        ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
      };
    },
  };
  return tool;
}

function readRuntimeToolSource(tool: AgentTool): RuntimeToolSource | undefined {
  const source = (tool as { source?: unknown }).source;
  return source === 'builtin' || source === 'builtin-matrix' || source === 'configured'
    ? source
    : undefined;
}

function attachRuntimeToolSource<TContext extends BeforeToolCallContext | AfterToolCallContext>(
  toolContext: TContext,
  sourceByToolName: ReadonlyMap<string, RuntimeToolSource>,
): TContext {
  const source = sourceByToolName.get(toolContext.toolCall.name);
  if (!source) return toolContext;
  const sourced: ToolCallContextWithSource<TContext> = {
    ...toolContext,
    toolCall: {
      ...toolContext.toolCall,
      source,
    },
  };
  return sourced;
}

function mergeToolResult(
  base: AfterToolCallResult | undefined,
  patch: AfterToolCallResult,
): AfterToolCallResult {
  return {
    ...(base ?? {}),
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.details !== undefined ? { details: patch.details } : {}),
    ...(patch.isError !== undefined ? { isError: patch.isError } : {}),
    ...(patch.terminate !== undefined ? { terminate: patch.terminate } : {}),
    ...(patch.terminateAgent !== undefined ? { terminateAgent: patch.terminateAgent } : {}),
  };
}

function applyToolResult(
  context: AfterToolCallContext,
  patch: AfterToolCallResult,
): AfterToolCallContext {
  const nextResult: AgentToolResult<unknown> = {
    ...context.result,
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.details !== undefined ? { details: patch.details } : {}),
    ...(patch.terminate !== undefined ? { terminate: patch.terminate } : {}),
  };
  return {
    ...context,
    result: nextResult,
    isError: patch.isError ?? context.isError,
  };
}

function toolResultErrorPatch(context: AfterToolCallContext): AfterToolCallResult | undefined {
  if (context.isError || !isRecord(context.result?.details)) {
    return undefined;
  }
  return context.result.details.is_error === true || context.result.details.ok === false
    ? { isError: true }
    : undefined;
}

function toolResultDetails(
  details: Record<string, unknown> | undefined,
  isError: boolean | undefined,
): Record<string, unknown> {
  if (isError === undefined) {
    return details ?? {};
  }
  return {
    ...(details ?? {}),
    is_error: isError,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
