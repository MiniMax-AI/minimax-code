import type { PiBeforeToolCallHook } from '@mavis/agent-core/pi-turn-runner';
import { isRuntimeToolInputValid } from '@mavis/agent-core/tools';

import type { AgentExecutionSnapshot } from '../preparation/contracts.js';
import type { AgentHostSteeringMessage, LocalTurnExecutionInput } from '../runner/contracts.js';
import type {
  LocalRuntimeTurnToolContext,
  LocalTurnExecutionPreparationSource,
} from '../execution/executor.js';
import { LocalTurnPermissionGate } from '../runner/policy/local-turn-permission-gate.js';
import { LocalTurnInputPreparer } from './local-turn-input-preparation.js';
import { readTrustedBuiltinAgentProfileIdentity } from './local-turn-tool-catalog-source.js';
import {
  emitLocalPluginHookWarnings,
  localPluginHookCoordinator,
} from './local-turn-plugin-hooks.js';

/**
 * Native v2 execution-preparation adapter. It is deliberately constructed
 * inside AgentHost composition so production callers inject raw fact owners,
 * never arbitrary message/caller/tool-context builders.
 */
export class NativeLocalTurnExecutionPreparationSource<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> implements LocalTurnExecutionPreparationSource<TAgent, LocalRuntimeTurnToolContext> {
  constructor(
    private readonly inputPreparer: LocalTurnInputPreparer,
    private readonly permission: LocalTurnPermissionGate,
  ) {}

  async prepare(
    input: Parameters<
      LocalTurnExecutionPreparationSource<TAgent, LocalRuntimeTurnToolContext>['prepare']
    >[0],
  ) {
    const prepared = await this.inputPreparer.prepare({
      lease: input.execution.lease,
      session: input.execution.session,
      agent: input.execution.agent,
      preparation: input.execution.preparation,
      canonicalUserInput: input.execution.canonicalUserInput,
      genuineUserQueryText: input.execution.request.genuineUserQueryText,
      immediateSendBatch: input.execution.request.immediateSendBatch,
      provenance: input.execution.request.provenance,
      ...(input.execution.desktopCapabilities
        ? { desktopCapabilities: input.execution.desktopCapabilities }
        : {}),
      history: (input.execution.runnerHistory ?? input.execution.history)?.messages ?? [],
    });
    const browserAssets = [...(prepared.browserAssets ?? [])];
    const context = createToolContext(
      input.execution,
      input.eventWriter,
      browserAssets,
      prepared.channelContext,
    );
    let nextSteeringMessageIndex =
      input.execution.request.immediateSendBatch?.members.length ??
      input.execution.canonicalUserInput.messages.length;
    return {
      promptText: prepared.promptText,
      genuineUserQueryText: prepared.genuineUserQueryText,
      initialBatchMessages: prepared.initialBatchMessages,
      initialBatchGenuineUserQueryTexts: prepared.initialBatchGenuineUserQueryTexts,
      userMessage: prepared.userMessage,
      caller: prepared.caller,
      reminderBlocks: prepared.reminderBlocks,
      loadBackgroundReminder: prepared.loadBackgroundReminder,
      ...(prepared.systemReminderDiagnostic !== undefined
        ? { systemReminderDiagnostic: prepared.systemReminderDiagnostic }
        : {}),
      prepareSteering: async (steering: AgentHostSteeringMessage) => {
        const messageIndexOffset = nextSteeringMessageIndex;
        nextSteeringMessageIndex += 1 + (steering.message.queuedMessages?.length ?? 0);
        const preparedSteering = await this.inputPreparer.prepareSteering({
          lease: input.execution.lease,
          preparation: input.execution.preparation,
          message: steering.message,
          genuineUserQueryText: steering.genuineUserQueryText,
          provenance: steering.provenance,
          messageIndexOffset,
        });
        browserAssets.push(...(preparedSteering.browserAssets ?? []));
        return {
          userMessage: preparedSteering.userMessage,
          genuineUserQueryText: preparedSteering.genuineUserQueryText,
        };
      },
      toolResolution: {
        context,
        disableBuiltinToolFallback: true,
        permissionGuard: (
          toolContext: Parameters<PiBeforeToolCallHook>[0],
          signal: Parameters<PiBeforeToolCallHook>[1],
        ) =>
          this.permission.beforeToolCall({
            sessionId: input.execution.lease.sessionId,
            turnId: input.execution.lease.turnId,
            agentName: input.execution.agent.agentName,
            model: `${input.execution.preparation.llm.model.provider}/${input.execution.preparation.llm.model.id}`,
            cwd: input.execution.session.workspaceDir,
            toolContext,
            trustedExactWritePaths: context.trustedExactWritePaths,
            signal: signal ?? input.execution.lease.signal,
            preToolPermission: input.execution.pluginApprovalRequests?.get(toolContext.toolCall.id),
            ...(prepared.channelContext ? { channelContext: prepared.channelContext } : {}),
            ...(input.execution.pluginHooks?.length
              ? {
                  beforeApproval: createPluginPermissionRequestHook(input.execution),
                }
              : {}),
          }),
      },
    };
  }
}

type PluginPermissionRequestHook = NonNullable<
  Parameters<LocalTurnPermissionGate['beforeToolCall']>[0]['beforeApproval']
>;

function createPluginPermissionRequestHook(
  execution: LocalTurnExecutionInput,
): PluginPermissionRequestHook {
  return async (approval) => {
    const result = await localPluginHookCoordinator.runEvent(
      execution.pluginHooks ?? [],
      {
        event: 'PermissionRequest',
        sessionId: execution.lease.sessionId,
        turnId: execution.lease.turnId,
        cwd: execution.session.workspaceDir,
        ...execution.pluginHookRuntimeContext,
        ...pluginToolProvenance(
          execution.pluginMcpToolOwners,
          execution.pluginHostApprovalTargets,
          approval.toolUseId,
          approval.toolName,
        ),
        matcherValue: approval.toolName,
        payload: {
          tool_name: approval.toolName,
          tool_input: approval.toolInput,
          tool_use_id: approval.toolUseId,
          reason: approval.reason,
          permission_rule_contents: approval.ruleContents,
        },
      },
      approval.signal,
    );
    await emitLocalPluginHookWarnings({
      reporter: execution.pluginHookEventReporter,
      sessionId: execution.lease.sessionId,
      turnId: execution.lease.turnId,
      event: 'PermissionRequest',
      result,
    });
    const updatedInput = result.decision.updatedInput;
    if (
      !isValidPluginPermissionRewrite(
        execution,
        approval.toolUseId,
        approval.toolName,
        updatedInput,
      )
    ) {
      return {
        behavior: 'deny',
        reason:
          result.decision.stopReason ??
          result.decision.reason ??
          `PermissionRequest Plugin Hook returned invalid input for ${approval.toolName}.`,
        ...(result.decision.continue === false || result.decision.interrupt === true
          ? { terminateAgent: true }
          : {}),
      };
    }
    return toPluginPermissionDecision(result.decision, updatedInput);
  };
}

function isValidPluginPermissionRewrite(
  execution: LocalTurnExecutionInput,
  toolUseId: string,
  toolName: string,
  updatedInput: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const hostTarget = execution.pluginHostApprovalTargets?.get(toolUseId);
  return (
    updatedInput === undefined ||
    (hostTarget
      ? isRuntimeToolInputValid(
          [
            {
              ...hostTarget.tool,
              def: { ...hostTarget.tool.def, name: toolName, schema: hostTarget.inputSchema },
            },
          ],
          toolName,
          updatedInput,
        )
      : isRuntimeToolInputValid(execution.assembly.tools, toolName, updatedInput))
  );
}

function toPluginPermissionDecision(
  decision: Awaited<ReturnType<typeof localPluginHookCoordinator.runEvent>>['decision'],
  updatedInput: Readonly<Record<string, unknown>> | undefined,
): Awaited<ReturnType<PluginPermissionRequestHook>> {
  const stopped = decision.continue === false || decision.interrupt === true;
  return {
    behavior: decision.permissionDecision ?? 'abstain',
    ...(decision.permissionAutoApproval ? { autoApproval: decision.permissionAutoApproval } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(stopped
      ? {
          terminateAgent: true,
          reason: decision.stopReason ?? decision.reason ?? 'Agent stopped by Plugin Hook.',
        }
      : {}),
    ...(updatedInput ? { updatedInput } : {}),
    ...(decision.updatedPermissions?.length
      ? { updatedPermissions: decision.updatedPermissions }
      : {}),
  };
}

function pluginToolProvenance(
  owners: ReadonlyMap<string, string> | undefined,
  hostTargets: LocalTurnExecutionInput['pluginHostApprovalTargets'],
  toolUseId: string,
  toolName: string,
): Pick<import('@mavis/plugin-hooks').PluginHookEventInput, 'toolProvenance'> | object {
  const hostTarget = hostTargets?.get(toolUseId);
  if (hostTarget) {
    return {
      toolProvenance: { kind: 'plugin_host' as const, pluginName: hostTarget.pluginName },
    };
  }
  const pluginName = owners?.get(toolName);
  return pluginName ? { toolProvenance: { kind: 'plugin_mcp' as const, pluginName } } : {};
}

function createToolContext(
  execution: LocalTurnExecutionInput,
  eventWriter: Parameters<
    LocalTurnExecutionPreparationSource<
      AgentExecutionSnapshot,
      LocalRuntimeTurnToolContext
    >['prepare']
  >[0]['eventWriter'],
  browserAssets: LocalRuntimeTurnToolContext['browserAssets'],
  channelContext?: LocalRuntimeTurnToolContext['channelContext'],
): LocalRuntimeTurnToolContext {
  const identity = readTrustedBuiltinAgentProfileIdentity(
    execution.preparation.agentConfig.agent_profile,
  );
  const forceReadOnlyFilesystem =
    identity.trustedBuiltin && identity.canonicalViewName === 'explore';
  return {
    sessionId: execution.lease.sessionId,
    turnId: execution.lease.turnId,
    agentName: execution.agent.agentName,
    parentAgentConfig: execution.preparation.agentConfig,
    eventWriter,
    browserAssets,
    ...(forceReadOnlyFilesystem ? { forceReadOnlyFilesystem: true } : {}),
    ...(execution.pluginHookEventReporter ? { reporter: execution.pluginHookEventReporter } : {}),
    trustedExactWritePaths: execution.assemblyContext.plan
      ? [execution.assemblyContext.plan.canonicalPath]
      : [],
    ...(channelContext ? { channelContext } : {}),
  };
}
