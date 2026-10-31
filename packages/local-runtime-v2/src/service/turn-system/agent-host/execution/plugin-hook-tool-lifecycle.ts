import type {
  PiAfterToolCallHook,
  PiBeforeToolCallHook,
  PiToolExecutionStartHook,
  PiTurnHooks,
} from '@mavis/agent-core/pi-turn-runner';
import {
  isRuntimeToolInputValid,
  type PtcRetainedFact,
  type PtcToolFactCollector,
  type RuntimeTool,
} from '@mavis/agent-core/tools';
import type { PluginHookRunResult } from '@mavis/plugin-hooks';

import { getBrowserHostBinding } from '../assembly/host-capability/browser.js';
import type { HostCapabilityReferenceTarget } from '../assembly/host-capability/contracts.js';
import {
  composePluginHookToolResultContent,
  emitLocalPluginHookWarnings,
  localPluginHookCoordinator as pluginHookCoordinator,
  mergePluginHookContext,
} from '../assembly/local-turn-plugin-hooks.js';
import {
  authorizeDelegatedToolReference,
  resolveDelegatedToolTarget,
  revokeDelegatedToolReferenceAuthorization,
  type DelegatedToolTargetResolution,
} from '../assembly/local-turn-plugin-capabilities.js';
import type { AgentExecutionSnapshot } from '../preparation/contracts.js';
import type { LocalTurnExecutionInput, LocalTurnToolPolicyGuard } from '../runner/contracts.js';
import type { LocalToolResultHistoryFinalizer, LocalTurnToolSafetyGuard } from './contracts.js';
import { buildCompatiblePostToolResponse, buildCodexPostToolResponse } from '../tools/index.js';
import {
  successfulTaskOutputReadTaskId,
  successfulTerminalTaskOutputReadTaskId,
} from './task-output-read.js';
import { evaluatePtcChildToolPolicy } from '../runner/policy/local-turn-tool-ptc-policy.js';
import { readAuthorizedTurnTools, readPtcChildTools } from './ptc/catalog.js';

type AfterToolCallContext = Parameters<PiAfterToolCallHook>[0];
type AfterToolCallDecision = Awaited<ReturnType<PiAfterToolCallHook>>;
type BeforeToolCallContext = Parameters<PiBeforeToolCallHook>[0];
type BeforeToolCallDecision = Awaited<ReturnType<PiBeforeToolCallHook>>;

interface ControlledToolHookOptions<TAgent extends AgentExecutionSnapshot> {
  readonly input: LocalTurnExecutionInput<TAgent>;
  readonly permissionGuard: PiBeforeToolCallHook;
  readonly pendingToolResultTailClaims: Set<string>;
  readonly readTaskOutputTaskIds: Set<string>;
  readonly terminalTaskOutputReadIds?: Set<string>;
  readonly toolsDisabled: boolean;
  readonly toolSafetyGuard?: LocalTurnToolSafetyGuard;
  readonly toolPolicyGuard?: LocalTurnToolPolicyGuard;
  readonly finalizeToolResultForHistory?: LocalToolResultHistoryFinalizer;
  /** Optional PTC-only sink; normal direct tools never write this buffer. */
  readonly ptcFactCollector?: PtcToolFactCollector;
}

type ResolvedDelegatedToolTarget = Extract<
  DelegatedToolTargetResolution,
  { readonly kind: 'resolved' }
> & {
  readonly selectorKind: 'tool_ref';
  readonly pluginName: string;
};

interface DelegatedToolCall {
  readonly gateway: RuntimeTool;
  readonly gatewayInput: Readonly<Record<string, unknown>>;
  readonly target: ResolvedDelegatedToolTarget;
}

export function createControlledToolHooks<TAgent extends AgentExecutionSnapshot>(
  options: ControlledToolHookOptions<TAgent>,
): Pick<PiTurnHooks, 'beforeToolCallHook' | 'onToolExecutionStartHook' | 'afterToolCallHook'> {
  const {
    input,
    permissionGuard,
    toolsDisabled,
    toolSafetyGuard,
    toolPolicyGuard,
    ptcFactCollector,
  } = options;
  const pluginToolContexts = new Map<string, string>();
  const pluginToolStartedAtMs = new Map<string, number>();
  const delegatedToolCalls = new Map<string, DelegatedToolCall>();
  const seenToolCallIds = new Set<string>();
  const ptcChildTools = readPtcChildTools(input.assembly.tools);
  const authorizedTools = readAuthorizedTurnTools(input.assembly.tools);
  return {
    beforeToolCallHook: [
      async (context, signal) => {
        const toolCallId = context.toolCall.id;
        if (seenToolCallIds.has(toolCallId)) {
          return {
            block: true,
            reason: `Duplicate tool call id is not allowed within one turn: ${toolCallId}`,
          };
        }
        seenToolCallIds.add(toolCallId);
        const prepared = prepareDelegatedToolCall(
          input,
          authorizedTools,
          delegatedToolCalls,
          context,
        );
        if (prepared.decision) return prepared.decision;
        const effective = prepared.context;
        const delegated = delegatedToolCalls.get(context.toolCall.id);
        const ptcDecision = evaluatePtcChildToolPolicy({
          originalContext: context,
          context: effective,
          tools: authorizedTools,
          ...(ptcChildTools ? { ptcChildTools } : {}),
          ...(delegated ? { delegatedTarget: delegated.target.target } : {}),
        });
        if (ptcDecision) return ptcDecision;
        const safetyDecision = await toolSafetyGuard?.beforeToolCall(effective, signal);
        return (
          safetyDecision ??
          runPluginPreToolHook({
            input,
            pluginToolContexts,
            context: effective,
            signal,
            delegated: delegatedToolCalls.get(context.toolCall.id),
            tools: authorizedTools,
            ...(ptcFactCollector ? { ptcFactCollector } : {}),
          })
        );
      },
      (context, signal) => {
        const effective = effectiveBeforeToolContext(delegatedToolCalls, context);
        return toolPolicyGuard?.beforeToolCall({
          ...(input.assemblyContext.plan ? { plan: input.assemblyContext.plan } : {}),
          genuineUserQueryText: input.request.genuineUserQueryText,
          toolContext: effective,
          ...(signal ? { signal } : {}),
        });
      },
      (context) => {
        const effective = effectiveBeforeToolContext(delegatedToolCalls, context);
        return toolsDisabled
          ? {
              block: true,
              reason: `Local runtime tool execution is disabled: ${effective.toolCall.name}`,
            }
          : undefined;
      },
      ...(input.assembly.hooks.beforeToolCallHook ?? []).map(
        (hook): PiBeforeToolCallHook =>
          (context, signal) =>
            hook(effectiveBeforeToolContext(delegatedToolCalls, context), signal),
      ),
      (context) => {
        const effective = effectiveBeforeToolContext(delegatedToolCalls, context);
        const delegated = delegatedToolCalls.get(context.toolCall.id);
        return evaluatePtcChildToolPolicy({
          originalContext: context,
          context: effective,
          tools: authorizedTools,
          ...(ptcChildTools ? { ptcChildTools } : {}),
          ...(delegated ? { delegatedTarget: delegated.target.target } : {}),
        });
      },
      async (context, signal) => {
        const effective = effectiveBeforeToolContext(delegatedToolCalls, context);
        try {
          const decision = await permissionGuard(effective, signal);
          if (decision) return decision;
          const delegated = delegatedToolCalls.get(context.toolCall.id);
          const ptcDecision = evaluatePtcChildToolPolicy({
            originalContext: context,
            context: effective,
            tools: authorizedTools,
            ...(ptcChildTools ? { ptcChildTools } : {}),
            ...(delegated ? { delegatedTarget: delegated.target.target } : {}),
          });
          if (ptcDecision) return ptcDecision;
          const authorization = authorizeDelegatedToolCall(
            delegatedToolCalls.get(context.toolCall.id),
          );
          if (authorization) return authorization;
          if (input.control.openToolResultTail()) return undefined;
          revokeDelegatedToolCallAuthorization(delegatedToolCalls.get(context.toolCall.id));
          return { block: true, reason: 'Tool-result delivery seam is closed.' };
        } finally {
          input.pluginApprovalRequests?.delete(context.toolCall.id);
        }
      },
    ],
    onToolExecutionStartHook: [
      ...(input.pluginHooks?.length
        ? [
            ((context) => {
              pluginToolStartedAtMs.set(context.toolCall.id, Date.now());
            }) satisfies PiToolExecutionStartHook,
          ]
        : []),
      ...(input.assembly.hooks.onToolExecutionStartHook ?? []).map(
        (hook): PiToolExecutionStartHook =>
          (context) =>
            hook(effectiveToolExecutionStartContext(delegatedToolCalls, context)),
      ),
    ],
    afterToolCallHook: [
      createAfterToolHook(
        options,
        { pluginToolContexts, pluginToolStartedAtMs, delegatedToolCalls },
        authorizedTools,
      ),
    ],
  };
}

function createAfterToolHook<TAgent extends AgentExecutionSnapshot>(
  options: ControlledToolHookOptions<TAgent>,
  state: {
    readonly pluginToolContexts: Map<string, string>;
    readonly pluginToolStartedAtMs: Map<string, number>;
    readonly delegatedToolCalls: Map<string, DelegatedToolCall>;
  },
  authorizedTools: readonly RuntimeTool[],
): PiAfterToolCallHook {
  const {
    input,
    toolSafetyGuard,
    finalizeToolResultForHistory,
    ptcFactCollector,
    readTaskOutputTaskIds,
    pendingToolResultTailClaims,
  } = options;
  const { pluginToolContexts, pluginToolStartedAtMs, delegatedToolCalls } = state;
  return async (context, signal) => {
    const authoritativeToolCallId = context.toolCall.id;
    const delegated = delegatedToolCalls.get(authoritativeToolCallId);
    const effectiveContext = effectiveAfterToolContext(delegated, context);
    const startedAtMs = pluginToolStartedAtMs.get(authoritativeToolCallId);
    pluginToolStartedAtMs.delete(authoritativeToolCallId);
    const toolDurationMs =
      startedAtMs === undefined ? undefined : Math.max(0, Date.now() - startedAtMs);
    let deliveryClosed = false;
    try {
      await observeRawToolResultSafety(toolSafetyGuard, authorizedTools, effectiveContext, signal);
      const applied = await runAfterToolHooks(
        input.assembly.hooks.afterToolCallHook ?? [],
        effectiveContext,
        signal ?? input.lease.signal,
      );
      const pluginDecision = await runPluginPostToolHook({
        input,
        signal,
        context: applied.context,
        priorContext: pluginToolContexts.get(authoritativeToolCallId),
        durationMs: toolDurationMs,
        delegated,
        tools: authorizedTools,
        ...(ptcFactCollector ? { ptcFactCollector } : {}),
      });
      pluginToolContexts.delete(authoritativeToolCallId);
      const effectiveDecision = pluginDecision
        ? mergeAfterToolDecision(applied.decision, pluginDecision)
        : applied.decision;
      const finalized = await finalizeAfterToolCallForHistory({
        input,
        context: applied.context,
        decision: effectiveDecision,
        finalizer: finalizeToolResultForHistory,
        signal: signal ?? input.lease.signal,
      });
      recordSuccessfulTaskOutputRead(
        readTaskOutputTaskIds,
        finalized.context,
        finalized.decision,
        options.terminalTaskOutputReadIds,
      );
      deliveryClosed = true;
      return appendToolResultTail(
        input,
        authoritativeToolCallId,
        finalized,
        pendingToolResultTailClaims,
      );
    } finally {
      delegatedToolCalls.delete(authoritativeToolCallId);
      input.pluginHostApprovalTargets?.delete(authoritativeToolCallId);
      if (!deliveryClosed) input.control.closeAndClaimToolResultTail(authoritativeToolCallId);
    }
  };
}

function appendToolResultTail(
  input: LocalTurnExecutionInput,
  toolCallId: string,
  finalized: Awaited<ReturnType<typeof finalizeAfterToolCallForHistory>>,
  pendingClaims: Set<string>,
): AfterToolCallDecision {
  const tail = toToolResultTail(input.control.closeAndClaimToolResultTail(toolCallId));
  if (tail.length === 0) return finalized.decision;
  pendingClaims.add(toolCallId);
  return mergeAfterToolDecision(finalized.decision, {
    content: [...(finalized.decision?.content ?? finalized.context.result.content), ...tail],
  });
}

function prepareDelegatedToolCall<TAgent extends AgentExecutionSnapshot>(
  input: LocalTurnExecutionInput<TAgent>,
  tools: readonly RuntimeTool[],
  calls: Map<string, DelegatedToolCall>,
  context: BeforeToolCallContext,
): { readonly context: BeforeToolCallContext; readonly decision?: BeforeToolCallDecision } {
  if (context.toolCall.name !== 'mcp_invoke' || !hasHostToolReference(context.args)) {
    const binding = directBrowserHostBinding(input.assembly.tools, context.toolCall.name);
    if (binding) input.pluginHostApprovalTargets?.set(context.toolCall.id, binding);
    return { context };
  }
  const gateway = tools.find((tool) => tool.def.name === 'mcp_invoke');
  if (!gateway) {
    return {
      context,
      decision: { block: true, reason: 'Host-bound gateway is unavailable for this turn.' },
    };
  }
  const resolution = resolveDelegatedToolTarget(gateway, context.args);
  if (!resolution || resolution.kind === 'error') {
    return {
      context,
      decision: {
        block: true,
        reason:
          resolution?.message ?? 'Host-bound gateway could not resolve the requested tool_ref.',
      },
    };
  }
  if (resolution.selectorKind !== 'tool_ref') return { context };
  if (!resolution.pluginName) {
    return {
      context,
      decision: { block: true, reason: 'Host-bound tool_ref has no trusted Plugin owner.' },
    };
  }
  const delegated: DelegatedToolCall = {
    gateway,
    gatewayInput: recordValue(context.args),
    target: resolution as ResolvedDelegatedToolTarget,
  };
  calls.set(context.toolCall.id, delegated);
  input.pluginHostApprovalTargets?.set(context.toolCall.id, {
    tool: resolution.target,
    inputSchema: resolution.inputSchema,
    pluginName: resolution.pluginName,
  });
  return { context: effectiveBeforeToolContext(calls, context) };
}

function hasHostToolReference(value: unknown): boolean {
  return isRecord(value) && typeof value.tool_ref === 'string' && value.tool_ref.length > 0;
}

function effectiveBeforeToolContext(
  calls: ReadonlyMap<string, DelegatedToolCall>,
  context: BeforeToolCallContext,
): BeforeToolCallContext {
  const delegated = calls.get(context.toolCall.id);
  if (!delegated) return context;
  return {
    ...context,
    toolCall: {
      ...context.toolCall,
      name: delegated.target.target.def.name,
      arguments: delegated.target.arguments,
      ...(delegated.target.target.source ? { source: delegated.target.target.source } : {}),
    },
    args: delegated.target.arguments,
  };
}

function effectiveAfterToolContext(
  delegated: DelegatedToolCall | undefined,
  context: AfterToolCallContext,
): AfterToolCallContext {
  if (!delegated) return context;
  return {
    ...context,
    toolCall: {
      ...context.toolCall,
      name: delegated.target.target.def.name,
      arguments: delegated.target.arguments,
      ...(delegated.target.target.source ? { source: delegated.target.target.source } : {}),
    },
    args: delegated.target.arguments,
  };
}

function effectiveToolExecutionStartContext(
  calls: ReadonlyMap<string, DelegatedToolCall>,
  context: Parameters<PiToolExecutionStartHook>[0],
): Parameters<PiToolExecutionStartHook>[0] {
  const delegated = calls.get(context.toolCall.id);
  if (!delegated) return context;
  return {
    ...context,
    toolCall: {
      ...context.toolCall,
      name: delegated.target.target.def.name,
      arguments: delegated.target.arguments,
      ...(delegated.target.target.source ? { source: delegated.target.target.source } : {}),
    },
    args: delegated.target.arguments,
  };
}

function authorizeDelegatedToolCall(
  delegated: DelegatedToolCall | undefined,
): BeforeToolCallDecision {
  if (!delegated) return undefined;
  const authorization = authorizeDelegatedToolReference(delegated.gateway, delegated.gatewayInput);
  return authorization.kind === 'error'
    ? { block: true, reason: authorization.message }
    : undefined;
}

function revokeDelegatedToolCallAuthorization(delegated: DelegatedToolCall | undefined): void {
  if (!delegated) return;
  revokeDelegatedToolReferenceAuthorization(delegated.gateway, delegated.gatewayInput);
}

function delegatedValidationTool(delegated: DelegatedToolCall): RuntimeTool {
  return {
    ...delegated.target.target,
    def: { ...delegated.target.target.def, schema: delegated.target.inputSchema },
  };
}

function directBrowserHostBinding(
  tools: readonly RuntimeTool[],
  toolName: string,
): HostCapabilityReferenceTarget | undefined {
  const tool = tools.find((candidate) => candidate.def.name === toolName);
  return tool ? getBrowserHostBinding(tool) : undefined;
}

async function observeRawToolResultSafety(
  guard: LocalTurnToolSafetyGuard | undefined,
  tools: readonly RuntimeTool[],
  context: AfterToolCallContext,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!guard) return;
  const binding = directBrowserHostBinding(tools, context.toolCall.name);
  // Safety follows the admitted Host target; Plugin hooks and history retain the public alias.
  const trustedContext = binding
    ? {
        ...context,
        toolCall: {
          ...context.toolCall,
          name: binding.tool.def.name,
          source: binding.tool.source,
        },
      }
    : context;
  await guard.afterToolCall(trustedContext, signal);
}

async function finalizeAfterToolCallForHistory<TAgent extends AgentExecutionSnapshot>(options: {
  readonly input: LocalTurnExecutionInput<TAgent>;
  readonly context: AfterToolCallContext;
  readonly decision: AfterToolCallDecision;
  readonly finalizer: LocalToolResultHistoryFinalizer | undefined;
  readonly signal: AbortSignal;
}): Promise<{ readonly context: AfterToolCallContext; readonly decision: AfterToolCallDecision }> {
  const { input, context, decision, finalizer, signal } = options;
  const effectiveContext = decision ? applyAfterToolDecision(context, decision) : context;
  const historyDecision = await finalizer?.(
    {
      sessionId: input.lease.sessionId,
      turnId: input.lease.turnId,
      agentName: input.session.agentName,
      workspaceDir: input.session.workspaceDir,
      toolContext: effectiveContext,
    },
    signal,
  );
  return {
    context: effectiveContext,
    decision: historyDecision ? mergeAfterToolDecision(decision, historyDecision) : decision,
  };
}

interface PluginPreToolHookInvocation<TAgent extends AgentExecutionSnapshot> {
  readonly input: LocalTurnExecutionInput<TAgent>;
  readonly pluginToolContexts: Map<string, string>;
  readonly context: BeforeToolCallContext;
  readonly signal?: AbortSignal;
  readonly delegated?: DelegatedToolCall;
  readonly tools: readonly RuntimeTool[];
  readonly ptcFactCollector?: PtcToolFactCollector;
}

async function runPluginPreToolHook<TAgent extends AgentExecutionSnapshot>(
  invocation: PluginPreToolHookInvocation<TAgent>,
): Promise<BeforeToolCallDecision> {
  const { input, context, signal, delegated } = invocation;
  if (!input.pluginHooks?.length) return undefined;
  const result = await pluginHookCoordinator.runEvent(
    input.pluginHooks,
    {
      event: 'PreToolUse',
      sessionId: input.lease.sessionId,
      turnId: input.lease.turnId,
      cwd: input.session.workspaceDir,
      ...input.pluginHookRuntimeContext,
      ...pluginToolProvenance(input, invocation.tools, context.toolCall.name, delegated),
      matcherValue: context.toolCall.name,
      payload: {
        tool_name: context.toolCall.name,
        tool_input: recordValue(context.args),
        tool_use_id: context.toolCall.id,
      },
    },
    signal ?? input.lease.signal,
  );
  await emitLocalPluginHookWarnings({
    reporter: input.pluginHookEventReporter,
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    event: 'PreToolUse',
    result,
  });
  return applyPluginPreToolDecision(invocation, result);
}

function applyPluginPreToolDecision<TAgent extends AgentExecutionSnapshot>(
  invocation: PluginPreToolHookInvocation<TAgent>,
  result: PluginHookRunResult,
): BeforeToolCallDecision {
  const {
    input,
    pluginToolContexts,
    context,
    delegated,
    ptcFactCollector,
    tools: authorizedTools,
  } = invocation;
  const direct = directBrowserHostBinding(authorizedTools, context.toolCall.name);
  const tools = direct
    ? [
        {
          ...direct.tool,
          def: {
            ...direct.tool.def,
            name: context.toolCall.name,
            schema: direct.inputSchema,
          },
        },
      ]
    : authorizedTools;
  const invalidRewrite = applyPluginToolRewrite(
    delegated ? [delegatedValidationTool(delegated)] : tools,
    context,
    result.decision.updatedInput,
  );
  if (invalidRewrite) {
    input.pluginApprovalRequests?.delete(context.toolCall.id);
    pluginToolContexts.delete(context.toolCall.id);
    return { block: true, reason: invalidRewrite };
  }
  recordPluginApprovalRequest(input, context, result);
  const hookContext = result.decision.additionalContext?.trim();
  if (hookContext) {
    pluginToolContexts.set(context.toolCall.id, hookContext);
    recordPtcPluginFacts(ptcFactCollector, context, [
      {
        kind: 'plugin_feedback',
        child_tool_call_id: context.toolCall.id,
        phase: 'additional_context',
        text: hookContext,
      },
    ]);
  }
  const blockDecision = pluginPreToolBlockDecision(result, hookContext);
  if (blockDecision) pluginToolContexts.delete(context.toolCall.id);
  return blockDecision;
}

function pluginPreToolBlockDecision(
  result: PluginHookRunResult,
  hookContext: string | undefined,
): BeforeToolCallDecision {
  if (result.decision.continue === false) {
    return {
      block: true,
      reason: result.decision.stopReason ?? 'Agent stopped by Plugin Hook.',
      terminateAgent: true,
    };
  }
  if (isDeferredPluginToolDecision(result)) {
    return {
      block: true,
      reason:
        mergePluginHookContext(
          'PreToolUse Plugin Hook requested deferred execution, which Desktop does not support.',
          hookContext,
        ) ?? 'PreToolUse Plugin Hook requested deferred execution.',
    };
  }
  if (result.decision.decision === 'deny') {
    return {
      block: true,
      reason:
        mergePluginHookContext(
          result.decision.reason ?? 'Tool blocked by Plugin Hook.',
          hookContext,
        ) ?? 'Tool blocked by Plugin Hook.',
    };
  }
  return undefined;
}

function recordPluginApprovalRequest<TAgent extends AgentExecutionSnapshot>(
  input: LocalTurnExecutionInput<TAgent>,
  context: BeforeToolCallContext,
  result: PluginHookRunResult,
): void {
  const behavior = result.decision.toolPermissionDecision;
  if (behavior !== 'allow' && behavior !== 'ask') return;
  input.pluginApprovalRequests?.set(context.toolCall.id, {
    behavior,
    ...(result.decision.reason ? { reason: result.decision.reason } : {}),
  });
}

function isDeferredPluginToolDecision(result: PluginHookRunResult): boolean {
  return (
    result.decision.defer === true ||
    result.decision.decision === 'defer' ||
    result.decision.toolPermissionDecision === 'defer'
  );
}

interface PluginPostToolHookInvocation<TAgent extends AgentExecutionSnapshot> {
  readonly input: LocalTurnExecutionInput<TAgent>;
  readonly context: AfterToolCallContext;
  readonly signal?: AbortSignal;
  readonly priorContext?: string;
  readonly durationMs?: number;
  readonly delegated?: DelegatedToolCall;
  /** Visible tools plus the private, already authorized PTC child catalog. */
  readonly tools: readonly RuntimeTool[];
  readonly ptcFactCollector?: PtcToolFactCollector;
}

async function runPluginPostToolHook<TAgent extends AgentExecutionSnapshot>(
  invocation: PluginPostToolHookInvocation<TAgent>,
): Promise<AfterToolCallDecision> {
  const { input, context, signal, priorContext, ptcFactCollector } = invocation;
  if (!input.pluginHooks?.length) return undefined;
  const failed = isFailedToolResult(context);
  const postToolHandlers = selectPostToolHandlers(input.pluginHooks);
  if (postToolHandlers.length === 0) {
    return priorPluginToolContextDecision(context, priorContext);
  }
  const pluginResult = await pluginHookCoordinator.runEvent(
    postToolHandlers,
    buildPluginPostToolEvent(invocation, failed),
    signal ?? input.lease.signal,
  );
  await emitLocalPluginHookWarnings({
    reporter: input.pluginHookEventReporter,
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    event: 'PostToolUse',
    result: pluginResult,
  });
  recordPtcPluginFacts(
    ptcFactCollector,
    context,
    pluginPostToolFacts(context.toolCall.id, pluginResult),
  );
  return buildPluginPostToolDecision(context, priorContext, pluginResult);
}

function selectPostToolHandlers(handlers: NonNullable<LocalTurnExecutionInput['pluginHooks']>) {
  return handlers.filter((handler) => handler.event === 'PostToolUse');
}

function priorPluginToolContextDecision(
  context: AfterToolCallContext,
  priorContext: string | undefined,
): AfterToolCallDecision {
  return priorContext
    ? {
        content: composePluginHookToolResultContent(
          context.result.content,
          undefined,
          priorContext,
        ),
      }
    : undefined;
}

function buildPluginPostToolEvent<TAgent extends AgentExecutionSnapshot>(
  invocation: PluginPostToolHookInvocation<TAgent>,
  failed: boolean,
) {
  const { input, context, durationMs } = invocation;
  const toolProvenance = pluginToolProvenance(
    input,
    invocation.tools,
    context.toolCall.name,
    invocation.delegated,
  );
  const toolResponseInput = {
    toolName: context.toolCall.name,
    args: recordValue(context.args),
    result: context.result,
    cwd: input.session.workspaceDir,
    ...toolProvenance,
  };
  const compatibleToolResponse = buildCompatiblePostToolResponse(toolResponseInput);
  const codexToolResponse = buildCodexPostToolResponse(toolResponseInput);
  return {
    event: 'PostToolUse' as const,
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    cwd: input.session.workspaceDir,
    ...input.pluginHookRuntimeContext,
    ...toolProvenance,
    matcherValue: context.toolCall.name,
    payload: {
      tool_name: context.toolCall.name,
      tool_input: recordValue(context.args),
      tool_use_id: context.toolCall.id,
      tool_result: context.result,
      ...(compatibleToolResponse ? { compatible_tool_response: compatibleToolResponse } : {}),
      ...(codexToolResponse !== undefined ? { codex_tool_response: codexToolResponse } : {}),
      is_error: failed,
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    },
  };
}

function buildPluginPostToolDecision(
  context: AfterToolCallContext,
  priorContext: string | undefined,
  pluginResult: PluginHookRunResult,
): AfterToolCallDecision {
  const hookContext = mergePluginHookContext(priorContext, pluginResult.decision.additionalContext);
  const content = composePluginHookToolResultContent(
    context.result.content,
    pluginResult.decision.updatedResult,
    hookContext,
    {
      sourceFormat: pluginResult.decision.updatedResultFormat,
      toolName: context.toolCall.name,
    },
  );
  const postToolFeedback = pluginResult.decision.postToolFeedback?.trim();
  const contentWithFeedback = postToolFeedback
    ? [
        {
          type: 'text' as const,
          text: `<plugin-hook-feedback>\n${postToolFeedback}\n</plugin-hook-feedback>`,
        },
      ]
    : content;
  return {
    ...(contentWithFeedback ? { content: contentWithFeedback } : {}),
    ...(postToolFeedback ? { isError: true } : {}),
    ...(pluginResult.decision.continue === false && !postToolFeedback
      ? { terminateAgent: true }
      : {}),
  };
}

function pluginPostToolFacts(
  childToolCallId: string,
  result: PluginHookRunResult,
): readonly PtcRetainedFact[] {
  const additionalContext = result.decision.additionalContext?.trim();
  const updatedResult =
    typeof result.decision.updatedResult === 'string' ? result.decision.updatedResult : undefined;
  const postToolFeedback = result.decision.postToolFeedback?.trim();
  return [
    ...(additionalContext
      ? [
          {
            kind: 'plugin_feedback' as const,
            child_tool_call_id: childToolCallId,
            phase: 'additional_context' as const,
            text: additionalContext,
          },
        ]
      : []),
    ...(updatedResult
      ? [
          {
            kind: 'plugin_feedback' as const,
            child_tool_call_id: childToolCallId,
            phase: 'updated_result' as const,
            text: updatedResult,
          },
        ]
      : []),
    ...(postToolFeedback
      ? [
          {
            kind: 'plugin_feedback' as const,
            child_tool_call_id: childToolCallId,
            phase: 'post_tool_feedback' as const,
            text: postToolFeedback,
          },
        ]
      : []),
  ];
}

function recordPtcPluginFacts(
  collector: PtcToolFactCollector | undefined,
  context: BeforeToolCallContext | AfterToolCallContext,
  facts: readonly PtcRetainedFact[],
): void {
  if (!collector || !context.parentToolCallId || facts.length === 0) return;
  collector.record(context.toolCall.id, facts);
}

function pluginToolProvenance(
  input: Pick<LocalTurnExecutionInput, 'pluginMcpToolOwners'>,
  tools: readonly RuntimeTool[],
  toolName: string,
  delegated?: DelegatedToolCall,
): Pick<import('@mavis/plugin-hooks').PluginHookEventInput, 'toolProvenance'> | object {
  const hostOwner =
    delegated?.target.pluginName ??
    directBrowserHostBinding(tools, toolName)?.pluginName;
  if (hostOwner) {
    return {
      toolProvenance: {
        kind: 'plugin_host' as const,
        pluginName: hostOwner,
      },
    };
  }
  const pluginName = input.pluginMcpToolOwners?.get(toolName);
  return pluginName ? { toolProvenance: { kind: 'plugin_mcp' as const, pluginName } } : {};
}

function isFailedToolResult(context: AfterToolCallContext): boolean {
  const details = recordValue(context.result.details);
  return context.isError || details.is_error === true || details.ok === false;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function replaceRecord(target: unknown, value: Readonly<Record<string, unknown>>): void {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  const mutable = target as Record<string, unknown>;
  for (const key of Object.keys(mutable)) delete mutable[key];
  Object.assign(mutable, value);
}

function applyPluginToolRewrite(
  tools: readonly RuntimeTool[],
  context: Parameters<PiBeforeToolCallHook>[0],
  updatedInput: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (!updatedInput) return undefined;
  if (!isRuntimeToolInputValid(tools, context.toolCall.name, updatedInput)) {
    return `PreToolUse Plugin Hook returned invalid input for ${context.toolCall.name}.`;
  }
  replaceRecord(context.args, updatedInput);
  return undefined;
}

async function runAfterToolHooks(
  hooks: readonly PiAfterToolCallHook[],
  initial: AfterToolCallContext,
  signal: AbortSignal,
): Promise<{ readonly context: AfterToolCallContext; readonly decision: AfterToolCallDecision }> {
  return hooks.reduce<
    Promise<{ readonly context: AfterToolCallContext; readonly decision: AfterToolCallDecision }>
  >(
    async (pending, hook) => {
      const current = await pending;
      const returnedPatch = await hook(current.context, signal);
      if (!returnedPatch) return current;
      return {
        context: applyAfterToolDecision(current.context, returnedPatch),
        decision: mergeAfterToolDecision(current.decision, returnedPatch),
      };
    },
    Promise.resolve({ context: initial, decision: undefined }),
  );
}

function mergeAfterToolDecision(
  base: AfterToolCallDecision,
  patch: NonNullable<AfterToolCallDecision>,
): NonNullable<AfterToolCallDecision> {
  return {
    ...(base ?? {}),
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.details !== undefined ? { details: patch.details } : {}),
    ...(patch.isError !== undefined ? { isError: patch.isError } : {}),
    ...(patch.terminate !== undefined ? { terminate: patch.terminate } : {}),
    ...(patch.terminateAgent !== undefined ? { terminateAgent: patch.terminateAgent } : {}),
  };
}

function applyAfterToolDecision(
  context: AfterToolCallContext,
  patch: NonNullable<AfterToolCallDecision>,
): AfterToolCallContext {
  return {
    ...context,
    result: {
      ...context.result,
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.details !== undefined ? { details: patch.details } : {}),
      ...(patch.terminate !== undefined ? { terminate: patch.terminate } : {}),
    },
    isError: patch.isError ?? context.isError,
  };
}

function toToolResultTail(
  messages: ReturnType<LocalTurnExecutionInput['control']['closeAndClaimToolResultTail']>,
): Array<{ readonly type: 'text'; readonly text: string }> {
  return messages.map(({ message }) => ({
    type: 'text',
    text: requireSteerContent(message.text),
  }));
}

function requireSteerContent(content: string): string {
  if (!content) {
    throw new TypeError('AgentHost steer message content must be a non-empty string.');
  }
  return content;
}

function recordSuccessfulTaskOutputRead(
  taskIds: Set<string>,
  context: AfterToolCallContext,
  decision: AfterToolCallDecision,
  terminalTaskIds?: Set<string>,
): void {
  const read = {
    toolName: context.toolCall.name,
    isError: decision?.isError ?? context.isError,
    args: context.args,
    details: decision?.details ?? context.result.details,
  };
  const taskId = successfulTaskOutputReadTaskId(read);
  if (taskId) taskIds.add(taskId);
  const terminalTaskId = successfulTerminalTaskOutputReadTaskId(read);
  if (terminalTaskId) terminalTaskIds?.add(terminalTaskId);
}
