import type { PiBeforeToolCallHook, PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import type { PluginHookPermissionUpdate } from '@mavis/plugin-hooks';
import { withPermissionExecutionPlan } from '@mavis/agent-tools';

import type { AgentHostChannelContext } from '../../preparation/contracts.js';
import { assertAgentHostCapabilityAvailable } from '../../empty-dependencies.js';
import { observePtcChildPermission, type PtcMetrics } from '../ptc/ptc-observability.js';
import {
  SIDE_SESSION_APPROVAL_REASON,
  sideSessionRequiresApproval,
} from './side-session-approval.js';

type BeforeToolCallContext = Parameters<PiBeforeToolCallHook>[0];

interface LocalTurnPermissionExecutionPlan {
  readonly originalInput: Readonly<Record<string, unknown>>;
  readonly effectiveInput: Readonly<Record<string, unknown>>;
  readonly intents: readonly unknown[];
  readonly transforms: readonly unknown[];
  readonly nativeDelete?: boolean;
}

type LocalTurnPermissionRuleMatcher =
  | { readonly kind: 'tool' }
  | { readonly kind: 'command'; readonly pattern: string }
  | {
      readonly kind: 'path';
      readonly pattern: string;
      readonly actions: readonly LocalTurnPermissionRuleAction[];
    };

type LocalTurnPermissionRuleAction = 'read' | 'write' | 'delete' | 'execute' | 'network';

export type LocalTurnPermissionDecision =
  | {
      readonly behavior: 'allow';
      readonly reason: string;
      readonly executionPlan?: Readonly<LocalTurnPermissionExecutionPlan>;
    }
  | {
      readonly behavior: 'deny';
      readonly reason: string;
    }
  | {
      readonly behavior: 'ask';
      readonly reason: string;
      readonly ruleContents?: readonly string[];
      readonly ruleMatchers?: readonly LocalTurnPermissionRuleMatcher[];
      readonly executionPlan?: Readonly<LocalTurnPermissionExecutionPlan>;
      /** Only ordinary fallback prompts may be answered by a compatible Hook. */
      readonly hookAutoApprovalEligible?: boolean;
    };

export interface LocalTurnPermissionDecisionSource {
  check(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly agentName: string;
    readonly model: string;
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
    readonly channelContext?: AgentHostChannelContext;
    readonly trustedExactWritePaths: readonly string[];
    /**
     * Host-issued directories the active Session owns and may READ, e.g. the
     * Session's own recoverable tool-output artifacts.
     */
    readonly sessionOwnedReadablePaths?: readonly string[];
    /** First validated plan's setting; recheck input/rules while keeping this call's policy. */
    readonly nativeDeleteSnapshot?: boolean;
  }): Promise<LocalTurnPermissionDecision>;
}

export interface LocalTurnPermissionApprovalOwner {
  request(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly agentName: string;
    readonly model: string;
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
    readonly reason: string;
    readonly ruleContents: readonly string[];
    readonly ruleMatchers?: readonly LocalTurnPermissionRuleMatcher[];
    readonly signal?: AbortSignal;
    readonly channelContext?: AgentHostChannelContext;
    /** Present only for a trusted PTC child call. */
    readonly parentToolCallId?: string;
    readonly parentToolDescription?: string;
    readonly stopPtcOnDeny?: boolean;
  }): Promise<'allowOnce' | 'allowAlways' | 'deny'>;
}

export interface LocalTurnPermissionMutationOwner {
  applyAtomic(input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly updates: readonly PluginHookPermissionUpdate[];
    readonly signal?: AbortSignal;
  }): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
}

export interface LocalTurnPermissionGateOptions {
  readonly decisions: LocalTurnPermissionDecisionSource;
  readonly approval?: LocalTurnPermissionApprovalOwner;
  readonly executionPlans?: {
    snapshotInput(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
    validate(
      plan: unknown,
      originalInput: Readonly<Record<string, unknown>>,
    ): Readonly<LocalTurnPermissionExecutionPlan>;
  };
  readonly logger?: PiTurnRunnerLogger;
  /** Counts run_code children's permission outcomes only (`ptc_child_permission_total`). */
  readonly metricsClient?: Pick<PtcMetrics, 'counter'>;
  readonly mutations?: LocalTurnPermissionMutationOwner;
  /**
   * Resolves the directories the active Session owns and may READ, e.g. the
   * Session's own recoverable tool-output artifacts.
   *
   * The runtime hands the Agent a path when it externalizes an oversized tool
   * result, so the Agent must be able to read that artifact back. Those
   * artifacts live under the private runtime tree, which the permission engine
   * otherwise refuses to read. The runtime — not the engine — owns that path,
   * so it is injected here instead of being derived from a Session id.
   */
  readonly resolveSessionOwnedReadablePaths?: (
    sessionId: string,
  ) => Promise<readonly string[]>;
  /** Optional isolated-host override; product hosts keep Desktop's built-in tool policy. */
  readonly enforceBuiltinTools?: boolean;
  /**
   * Resolves whether a Session is a temporary side Session (`/btw` / Peek).
   * A mutation-capable tool there always requires one explicit user approval,
   * regardless of the current permission mode, because the parent Turn may
   * still be writing to the same workspace.
   */
  readonly sideSessions?: {
    isSideSession(sessionId: string): Promise<boolean>;
  };
}

type PermissionExecutionPlanPort = NonNullable<LocalTurnPermissionGateOptions['executionPlans']>;

interface PermissionToolRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  /** Catalog-owned provenance; never inferred from a user-configured tool name. */
  readonly toolSource: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
}

interface BeforeToolCallInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly model: string;
  readonly cwd?: string;
  readonly toolContext: BeforeToolCallContext;
  readonly signal?: AbortSignal;
  readonly channelContext?: AgentHostChannelContext;
  readonly trustedExactWritePaths?: readonly string[];
  /**
   * Host-issued directories the active Session owns and may READ, e.g. the
   * Session's own recoverable tool-output artifacts.
   */
  readonly sessionOwnedReadablePaths?: readonly string[];

  /** Compatible-compatible PreToolUse permission request. Policy deny always wins. */
  readonly preToolPermission?: {
    readonly behavior: 'allow' | 'ask';
    readonly reason?: string;
  };
  readonly beforeApproval?: (input: {
    readonly toolUseId: string;
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>>;
    readonly reason: string;
    readonly ruleContents: readonly string[];
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly behavior: 'allow' | 'deny' | 'abstain';
    readonly autoApproval?: 'ordinary_only' | 'any_prompt';
    readonly terminateAgent?: boolean;
    readonly reason?: string;
    readonly updatedInput?: Readonly<Record<string, unknown>>;
    readonly updatedPermissions?: readonly PluginHookPermissionUpdate[];
  }>;
}

/**
 * V2-owned permission hook orchestration. The injected decision source owns
 * policy/rules and the approval port owns pending lifecycle, dedupe, UI and
 * persisted replies; this gate owns hook ordering, plan consumption and fail-closed mapping.
 */
export class LocalTurnPermissionGate {
  constructor(private readonly options: LocalTurnPermissionGateOptions) {
    assertAgentHostCapabilityAvailable(
      'permission-decision-source',
      typeof options.decisions?.check === 'function',
    );
  }

  async beforeToolCall(callInput: BeforeToolCallInput): Promise<
    | {
        readonly block: true;
        readonly reason: string;
        readonly terminateAgent?: boolean;
        readonly blockedBy: 'permission';
      }
    | undefined
  > {
    const request = readPermissionToolRequest(
      callInput.toolContext,
      this.options.executionPlans?.snapshotInput,
    );
    // The side-Session lookup runs before the built-in bypass so that a
    // mutation-capable built-in (write/edit/bash) cannot skip the mandatory
    // side-Session confirmation.
    const sideSession = await this.resolveSideSessionApprovalRequirement(callInput, request);
    if (sideSession?.block) return { ...sideSession.block, blockedBy: 'permission' };
    const sideApprovalRequired = sideSession?.approvalRequired === true;
    if (shouldSkipPermissionCheck(this.options, callInput)) {
      // Desktop's built-in tool policy owns these tools elsewhere; the
      // side-Session confirmation is the only gate-level requirement here.
      if (!sideApprovalRequired) return undefined;
      const blocked = await this.resolveSideSessionApproval(callInput, request);
      return blocked ? { ...blocked, blockedBy: 'permission' } : undefined;
    }
    // Resolve the Session's read grant once and carry it through every policy
    // check of this call, including the recheck after a Hook rewrites input.
    const input: BeforeToolCallInput = {
      ...callInput,
      ...(await this.resolveSessionOwnedReadablePaths(callInput.sessionId)),
    };
    let decision = await checkPermissionDecision(this.options.decisions, input, request);
    if (sideApprovalRequired && decision.behavior === 'allow') {
      // A policy or mode auto-approval is not enough inside a side Session:
      // downgrade it to an ordinary ask so exactly one user approval happens.
      // Hook auto-approval eligibility is deliberately not granted.
      decision = {
        behavior: 'ask',
        reason: SIDE_SESSION_APPROVAL_REASON,
        ...(decision.executionPlan ? { executionPlan: decision.executionPlan } : {}),
      };
    }
    const executionPlan = readDecisionExecutionPlan(
      decision,
      request.toolInput,
      this.options.executionPlans?.validate,
    );
    const blocked = await this.resolveCheckedPermission(input, request, decision, executionPlan);
    // This trusted marker describes admission, not an error produced by tool execution.
    return blocked ? { ...blocked, blockedBy: 'permission' } : undefined;
  }

  /**
   * The runtime owns the Session's artifact layout, so the read grant for the
   * Session's own recoverable artifacts is resolved here — never derived from
   * the Session id inside the permission engine. A resolver failure must not
   * widen access: the Session keeps the ordinary protected behavior, and the
   * failure is logged so a missing grant is diagnosable.
   */
  private async resolveSessionOwnedReadablePaths(
    sessionId: string,
  ): Promise<{ readonly sessionOwnedReadablePaths?: readonly string[] }> {
    const resolve = this.options.resolveSessionOwnedReadablePaths;
    if (!resolve) return {};
    try {
      const paths = await resolve(sessionId);
      return paths.length > 0 ? { sessionOwnedReadablePaths: paths } : {};
    } catch (error) {
      this.options.logger?.warn?.(
        { session_id: sessionId, error: boundedPermissionError(error) },
        'permission.session_owned_readable_paths_unavailable',
      );
      return {};
    }
  }

  private async resolveSideSessionApprovalRequirement(
    input: BeforeToolCallInput,
    request: PermissionToolRequest,
  ): Promise<
    | {
        readonly approvalRequired?: boolean;
        readonly block?: { readonly block: true; readonly reason: string };
      }
    | undefined
  > {
    const sideSessions = this.options.sideSessions;
    if (!sideSessions) return undefined;
    if (
      !sideSessionRequiresApproval({ toolName: request.toolName, toolSource: request.toolSource })
    )
      return undefined;
    // The lookup runs only for a tool that would need confirmation, so an
    // ordinary read in a side Session and every tool elsewhere pay nothing.
    try {
      return (await sideSessions.isSideSession(input.sessionId))
        ? { approvalRequired: true }
        : undefined;
    } catch {
      // Fail closed. A transient metadata lookup cannot prove this Session is
      // ordinary, and the unsafe alternative is an unconfirmed workspace
      // mutation racing the parent Turn.
      this.logEnforcement(input, request, {
        policy_behavior: 'deny',
        gate_result: 'blocked',
        decision_source: 'policy',
        rewrite_applied: false,
        side_session: true,
      });
      return {
        block: permissionBlock(
          request.toolName,
          `Could not verify whether this Session is a temporary side Session; ${request.toolName} was blocked before execution. Retry from the main Session.`,
          'policy',
        ),
      };
    }
  }

  /** One explicit user approval for a bypass-eligible built-in tool in a side Session. */
  private async resolveSideSessionApproval(
    input: BeforeToolCallInput,
    request: PermissionToolRequest,
  ): Promise<{ readonly block: true; readonly reason: string } | undefined> {
    const approval = await this.requestApproval(input, request, {
      behavior: 'ask',
      reason: SIDE_SESSION_APPROVAL_REASON,
    });
    if (approval === 'deny') {
      this.logEnforcement(input, request, {
        policy_behavior: 'ask',
        gate_result: 'blocked',
        decision_source: 'approval_or_abort',
        approval_decision: approval,
        rewrite_applied: false,
        side_session: true,
      });
      return input.toolContext.parentToolCallId
        ? userDeniedBlock(request.toolName, SIDE_SESSION_APPROVAL_REASON)
        : permissionBlock(request.toolName, SIDE_SESSION_APPROVAL_REASON, 'user');
    }
    this.logEnforcement(input, request, {
      policy_behavior: 'ask',
      gate_result: 'proceed',
      decision_source: 'user_reply',
      approval_decision: approval,
      rewrite_applied: false,
      side_session: true,
    });
    return undefined;
  }

  private async resolveCheckedPermission(
    input: BeforeToolCallInput,
    request: PermissionToolRequest,
    decision: LocalTurnPermissionDecision,
    executionPlan: Readonly<LocalTurnPermissionExecutionPlan> | undefined,
  ): Promise<
    { readonly block: true; readonly reason: string; readonly terminateAgent?: boolean } | undefined
  > {
    if (decision.behavior === 'deny') {
      this.logEnforcement(input, request, {
        policy_behavior: 'deny',
        gate_result: 'blocked',
        decision_source: 'policy',
        rewrite_applied: false,
      });
      return permissionBlock(request.toolName, decision.reason, 'policy');
    }
    const approvalDecision = toApprovalDecision(decision, input.preToolPermission);
    if (!approvalDecision) {
      applyExecutionPlan(input.toolContext, executionPlan);
      this.logEnforcement(input, request, {
        policy_behavior: 'allow',
        gate_result: 'proceed',
        decision_source: 'policy',
        rewrite_applied: Boolean(executionPlan?.transforms.length),
        execution_plan_present: Boolean(executionPlan),
        transform_count: executionPlan?.transforms.length ?? 0,
      });
      return undefined;
    }
    if (preToolHookAllowsWithoutApproval(input, approvalDecision)) {
      applyExecutionPlan(input.toolContext, executionPlan);
      this.logEnforcement(input, request, {
        policy_behavior: 'ask',
        gate_result: 'proceed',
        decision_source: 'plugin_hook',
        approval_decision: 'allow',
        rewrite_applied: Boolean(executionPlan?.transforms.length),
        execution_plan_present: Boolean(executionPlan),
        transform_count: executionPlan?.transforms.length ?? 0,
      });
      return undefined;
    }
    return this.resolvePermissionPrompt(input, request, approvalDecision, executionPlan);
  }

  private async resolvePermissionPrompt(
    input: BeforeToolCallInput,
    request: PermissionToolRequest,
    approvalDecision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>,
    executionPlan: Readonly<LocalTurnPermissionExecutionPlan> | undefined,
  ): Promise<
    { readonly block: true; readonly reason: string; readonly terminateAgent?: boolean } | undefined
  > {
    const pluginDecision = await requestPluginPermissionDecision(
      input,
      request,
      approvalDecision.reason,
      approvalRuleContents(approvalDecision, request),
    );
    const pluginBlock = toPluginBlock(request, pluginDecision);
    if (pluginBlock) {
      this.logEnforcement(input, request, {
        policy_behavior: 'ask',
        gate_result: 'blocked',
        decision_source: 'plugin_hook',
        rewrite_applied: false,
      });
      return pluginBlock;
    }
    if (pluginDecision.updatedPermissions?.length) {
      const mutationBlock = await this.applyPluginPermissionUpdates(input, request, pluginDecision);
      if (mutationBlock) {
        this.logEnforcement(input, request, {
          policy_behavior: 'ask',
          gate_result: 'blocked',
          decision_source: 'plugin_hook',
          rewrite_applied: false,
        });
        return mutationBlock;
      }
    }
    if (pluginDecision.updatedInput || pluginDecision.updatedPermissions?.length) {
      return this.resolveRewrittenPermission(input, pluginDecision, executionPlan);
    }
    return this.resolveApproval({
      input,
      request,
      decision: approvalDecision,
      pluginDecision,
      executionPlan,
    });
  }

  private async applyPluginPermissionUpdates(
    input: BeforeToolCallInput,
    request: PermissionToolRequest,
    pluginDecision: PluginPermissionDecision,
  ): Promise<{ readonly block: true; readonly reason: string } | undefined> {
    const updates = pluginDecision.updatedPermissions;
    if (!updates?.length) return undefined;
    if (!input.cwd?.trim()) {
      return permissionBlock(
        request.toolName,
        'Plugin Hook permission update has no trusted workspace identity.',
        'policy',
      );
    }
    const owner = this.options.mutations;
    if (!owner?.applyAtomic) {
      return permissionBlock(
        request.toolName,
        'Plugin Hook requested permission updates, but this runtime cannot apply them.',
        'policy',
      );
    }
    try {
      await owner.applyAtomic({
        sessionId: input.sessionId,
        cwd: input.cwd,
        updates,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return undefined;
    } catch (error) {
      return permissionBlock(
        request.toolName,
        `Plugin Hook permission update was rejected: ${boundedPermissionError(error)}`,
        'policy',
      );
    }
  }

  private async resolveRewrittenPermission(
    input: BeforeToolCallInput,
    pluginDecision: PluginPermissionDecision,
    previousPlan: Readonly<LocalTurnPermissionExecutionPlan> | undefined,
  ): Promise<{ readonly block: true; readonly reason: string } | undefined> {
    applyHookUpdatedInput(input.toolContext, pluginDecision.updatedInput);
    const request = readPermissionToolRequest(
      input.toolContext,
      this.options.executionPlans?.snapshotInput,
    );
    const policyDecision = await checkPermissionDecision(
      this.options.decisions,
      input,
      request,
      previousPlan?.nativeDelete,
    );
    const executionPlan = readDecisionExecutionPlan(
      policyDecision,
      request.toolInput,
      this.options.executionPlans?.validate,
    );
    if (policyDecision.behavior === 'deny') {
      this.logEnforcement(input, request, {
        policy_behavior: 'deny',
        gate_result: 'blocked',
        decision_source: 'policy_recheck',
        rewrite_applied: false,
      });
      return permissionBlock(request.toolName, policyDecision.reason, 'policy');
    }
    const approvalDecision = toApprovalDecision(policyDecision, input.preToolPermission);
    if (!approvalDecision) {
      applyExecutionPlan(input.toolContext, executionPlan);
      this.logEnforcement(input, request, {
        policy_behavior: 'allow',
        gate_result: 'proceed',
        decision_source: 'policy_recheck',
        rewrite_applied: Boolean(executionPlan?.transforms.length),
        execution_plan_present: Boolean(executionPlan),
        transform_count: executionPlan?.transforms.length ?? 0,
      });
      return undefined;
    }
    return this.resolveApproval({
      input,
      request,
      decision: approvalDecision,
      pluginDecision,
      executionPlan,
    });
  }

  private async resolveApproval(
    resolution: ApprovalResolutionInput,
  ): Promise<{ readonly block: true; readonly reason: string } | undefined> {
    const { input, request, decision, pluginDecision, executionPlan } = resolution;
    if (canPluginAutoApprove(pluginDecision, decision)) {
      applyExecutionPlan(input.toolContext, executionPlan);
      this.logEnforcement(input, request, {
        policy_behavior: 'ask',
        gate_result: 'proceed',
        decision_source: 'plugin_hook',
        approval_decision: 'allow',
        rewrite_applied: Boolean(executionPlan?.transforms.length),
        execution_plan_present: Boolean(executionPlan),
        transform_count: executionPlan?.transforms.length ?? 0,
      });
      return undefined;
    }
    const approval = await this.requestApproval(input, request, decision);
    if (approval === 'deny') {
      this.logEnforcement(input, request, {
        policy_behavior: 'ask',
        gate_result: 'blocked',
        decision_source: 'approval_or_abort',
        approval_decision: approval,
        rewrite_applied: false,
      });
      return input.toolContext.parentToolCallId
        ? userDeniedBlock(request.toolName, decision.reason)
        : permissionBlock(request.toolName, decision.reason, 'user');
    }
    applyExecutionPlan(input.toolContext, executionPlan);
    this.logEnforcement(input, request, {
      policy_behavior: 'ask',
      gate_result: 'proceed',
      decision_source: 'user_reply',
      approval_decision: approval,
      rewrite_applied: Boolean(executionPlan?.transforms.length),
      execution_plan_present: Boolean(executionPlan),
      transform_count: executionPlan?.transforms.length ?? 0,
    });
    return undefined;
  }

  private logEnforcement(
    input: Parameters<typeof observePtcChildPermission>[1],
    request: PermissionToolRequest,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    this.options.logger?.info?.(
      {
        session_id: input.sessionId,
        turn_id: input.turnId,
        tool_call_id: request.toolCallId,
        tool_name: request.toolName,
        ...fields,
      },
      'permission.enforcement',
    );
    // Every final decision passes here; a run_code child also gets its PTC line.
    observePtcChildPermission(this.options, input, request, fields);
  }

  private requestApproval(
    input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly agentName: string;
      readonly model: string;
      readonly toolContext: BeforeToolCallContext;
      readonly signal?: AbortSignal;
      readonly channelContext?: AgentHostChannelContext;
    },
    request: PermissionToolRequest,
    decision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>,
  ): Promise<'allowOnce' | 'allowAlways' | 'deny'> {
    const approval = this.options.approval;
    if (!approval || typeof approval.request !== 'function') {
      assertAgentHostCapabilityAvailable('permission-approval-owner', false);
      throw new Error('Unreachable permission approval owner validation.');
    }
    const ruleContents = approvalRuleContents(decision, request);
    return requestApproval(approval, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentName: input.agentName,
      model: input.model,
      toolName: request.toolName,
      toolInput: request.toolInput,
      reason: decision.reason,
      ruleContents,
      ...(decision.ruleMatchers ? { ruleMatchers: decision.ruleMatchers } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.channelContext ? { channelContext: input.channelContext } : {}),
      ...ptcApprovalContext(input.toolContext),
    });
  }
}

function ptcApprovalContext(
  context: BeforeToolCallContext,
): Pick<
  Parameters<LocalTurnPermissionApprovalOwner['request']>[0],
  'parentToolCallId' | 'parentToolDescription' | 'stopPtcOnDeny'
> {
  if (!context.parentToolCallId) return {};
  return {
    parentToolCallId: context.parentToolCallId,
    ...(context.parentDescription ? { parentToolDescription: context.parentDescription } : {}),
    stopPtcOnDeny: true,
  };
}

function preToolHookAllowsWithoutApproval(
  input: BeforeToolCallInput,
  decision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>,
): boolean {
  return (
    input.preToolPermission?.behavior === 'allow' && decision.hookAutoApprovalEligible === true
  );
}

function shouldSkipPermissionCheck(
  options: LocalTurnPermissionGateOptions,
  input: BeforeToolCallInput,
): boolean {
  return (
    options.enforceBuiltinTools !== true &&
    isBuiltinTool(input.toolContext.toolCall) &&
    input.preToolPermission?.behavior !== 'ask'
  );
}

async function checkPermissionDecision(
  source: LocalTurnPermissionDecisionSource,
  input: BeforeToolCallInput,
  request: PermissionToolRequest,
  nativeDeleteSnapshot?: boolean,
): Promise<LocalTurnPermissionDecision> {
  return validatePermissionDecision(
    await source.check({
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentName: input.agentName,
      model: input.model,
      toolName: request.toolName,
      toolInput: request.toolInput,
      trustedExactWritePaths: [...(input.trustedExactWritePaths ?? [])],
      ...(input.sessionOwnedReadablePaths
        ? { sessionOwnedReadablePaths: [...input.sessionOwnedReadablePaths] }
        : {}),
      ...(nativeDeleteSnapshot !== undefined ? { nativeDeleteSnapshot } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.channelContext ? { channelContext: input.channelContext } : {}),
    }),
  );
}

function toApprovalDecision(
  decision: Exclude<LocalTurnPermissionDecision, { readonly behavior: 'deny' }>,
  preToolPermission: BeforeToolCallInput['preToolPermission'],
): Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }> | undefined {
  if (decision.behavior === 'ask') {
    return {
      ...decision,
      ...(preToolPermission?.behavior === 'ask' && preToolPermission.reason
        ? { reason: preToolPermission.reason }
        : {}),
    };
  }
  if (preToolPermission?.behavior !== 'ask') return undefined;
  return {
    behavior: 'ask',
    reason: preToolPermission.reason ?? 'Plugin Hook requested approval.',
    ...(decision.executionPlan ? { executionPlan: decision.executionPlan } : {}),
  };
}

async function requestPluginPermissionDecision(
  input: BeforeToolCallInput,
  request: PermissionToolRequest,
  reason: string,
  ruleContents: readonly string[],
): Promise<PluginPermissionDecision> {
  return (
    (await input.beforeApproval?.({
      toolUseId: request.toolCallId,
      toolName: request.toolName,
      toolInput: request.toolInput,
      reason,
      ruleContents,
      ...(input.signal ? { signal: input.signal } : {}),
    })) ?? { behavior: 'abstain' }
  );
}

function approvalRuleContents(
  decision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>,
  request: PermissionToolRequest,
): readonly string[] {
  return decision.ruleContents?.length && decision.ruleContents.every(Boolean)
    ? [...decision.ruleContents]
    : deriveRuleContents(request.toolName, request.toolInput);
}

interface PluginPermissionDecision {
  readonly behavior: 'allow' | 'deny' | 'abstain';
  readonly autoApproval?: 'ordinary_only' | 'any_prompt';
  readonly terminateAgent?: boolean;
  readonly reason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly updatedPermissions?: readonly PluginHookPermissionUpdate[];
}

interface ApprovalResolutionInput {
  readonly input: BeforeToolCallInput;
  readonly request: PermissionToolRequest;
  readonly decision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>;
  readonly pluginDecision: PluginPermissionDecision;
  readonly executionPlan: Readonly<LocalTurnPermissionExecutionPlan> | undefined;
}

function canPluginAutoApprove(
  pluginDecision: PluginPermissionDecision,
  productDecision: Extract<LocalTurnPermissionDecision, { readonly behavior: 'ask' }>,
): boolean {
  if (pluginDecision.behavior !== 'allow') return false;
  if (pluginDecision.autoApproval === 'any_prompt') return true;
  return (
    pluginDecision.autoApproval === 'ordinary_only' &&
    productDecision.hookAutoApprovalEligible === true
  );
}

function toPluginBlock(
  request: PermissionToolRequest,
  decision: PluginPermissionDecision,
):
  | { readonly block: true; readonly reason: string; readonly terminateAgent?: boolean }
  | undefined {
  if (decision.terminateAgent === true) {
    return {
      block: true,
      reason: decision.reason ?? `Agent stopped by Plugin Hook for ${request.toolName}`,
      terminateAgent: true,
    };
  }
  return decision.behavior === 'deny'
    ? {
        block: true,
        reason: decision.reason ?? `Permission denied by Plugin Hook for ${request.toolName}`,
      }
    : undefined;
}

function permissionBlock(
  toolName: string,
  reason: string,
  source: 'policy' | 'user',
): { readonly block: true; readonly reason: string } {
  return {
    block: true,
    reason:
      source === 'user'
        ? `Permission denied by user for ${toolName}: ${reason}`
        : `Permission denied for ${toolName}: ${reason}`,
  };
}

function userDeniedBlock(
  toolName: string,
  reason: string,
): { readonly block: true; readonly reason: string; readonly approvalStatus: 'denied' } {
  return { ...permissionBlock(toolName, reason, 'user'), approvalStatus: 'denied' };
}

async function requestApproval(
  owner: LocalTurnPermissionApprovalOwner,
  input: Parameters<LocalTurnPermissionApprovalOwner['request']>[0],
): Promise<'allowOnce' | 'allowAlways' | 'deny'> {
  return validateApprovalDecision(await owner.request(input));
}

function validatePermissionDecision(decision: unknown): LocalTurnPermissionDecision {
  if (!isPermissionDecisionObject(decision)) {
    throw new TypeError('Permission decision source returned an invalid decision.');
  }
  return decision as LocalTurnPermissionDecision;
}

function isPermissionDecisionObject(decision: unknown): decision is Record<PropertyKey, unknown> {
  if (!decision || typeof decision !== 'object') return false;
  const behavior = Reflect.get(decision, 'behavior');
  const reason = Reflect.get(decision, 'reason');
  const executionPlan = Reflect.get(decision, 'executionPlan');
  const legacyRewrite = Reflect.get(decision, 'rewrittenInput');
  const ruleContents = Reflect.get(decision, 'ruleContents');
  const ruleMatchers = Reflect.get(decision, 'ruleMatchers');
  const hookAutoApprovalEligible = Reflect.get(decision, 'hookAutoApprovalEligible');
  return (
    isPermissionBehavior(behavior) &&
    typeof reason === 'string' &&
    isOptionalRecord(executionPlan) &&
    legacyRewrite === undefined &&
    isOptionalRuleContents(ruleContents) &&
    isOptionalRuleMatchers(ruleMatchers, ruleContents) &&
    isOptionalBoolean(hookAutoApprovalEligible)
  );
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isPermissionBehavior(value: unknown): value is LocalTurnPermissionDecision['behavior'] {
  return value === 'allow' || value === 'deny' || value === 'ask';
}

function isOptionalRecord(value: unknown): boolean {
  return (
    value === undefined || (Boolean(value) && typeof value === 'object' && !Array.isArray(value))
  );
}

function isOptionalRuleContents(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((rule) => typeof rule === 'string' && Boolean(rule.trim())))
  );
}

function isOptionalRuleMatchers(value: unknown, ruleContents: unknown): boolean {
  if (value === undefined) return true;
  if (
    !Array.isArray(value) ||
    !Array.isArray(ruleContents) ||
    value.length !== ruleContents.length
  ) {
    return false;
  }
  return value.every(isRuleMatcher);
}

function isRuleMatcher(value: unknown): value is LocalTurnPermissionRuleMatcher {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = Reflect.get(value, 'kind');
  if (kind === 'tool') return true;
  const pattern = Reflect.get(value, 'pattern');
  if (kind === 'command') return isNonBlankString(pattern);
  if (kind !== 'path' || !isNonBlankString(pattern)) return false;
  const actions = Reflect.get(value, 'actions');
  return isPermissionRuleActions(actions);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isPermissionRuleActions(
  value: unknown,
): value is readonly LocalTurnPermissionRuleAction[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const validActions = new Set(['read', 'write', 'delete', 'execute', 'network']);
  return value.every((action) => typeof action === 'string' && validActions.has(action));
}

function validateApprovalDecision(decision: unknown): 'allowOnce' | 'allowAlways' | 'deny' {
  if (decision !== 'allowOnce' && decision !== 'allowAlways' && decision !== 'deny') {
    throw new TypeError('Permission approval owner returned an invalid decision.');
  }
  return decision;
}

function readDecisionExecutionPlan(
  decision: LocalTurnPermissionDecision,
  originalInput: Readonly<Record<string, unknown>>,
  validate: PermissionExecutionPlanPort['validate'] | undefined,
): Readonly<LocalTurnPermissionExecutionPlan> | undefined {
  if (decision.behavior === 'deny' || !decision.executionPlan) return undefined;
  if (!validate) {
    assertAgentHostCapabilityAvailable('permission-execution-plan-validator', false);
    throw new Error('Unreachable permission execution-plan validator validation.');
  }
  return validate(decision.executionPlan, originalInput);
}

function applyExecutionPlan(
  context: BeforeToolCallContext,
  plan: Readonly<LocalTurnPermissionExecutionPlan> | undefined,
): void {
  if (!plan) return;
  const target = readMutableRecord(context.args);
  for (const key of Reflect.ownKeys(target)) {
    if (!Reflect.deleteProperty(target, key)) {
      throw new TypeError('Permission gate could not replace the execution input.');
    }
  }
  Object.assign(target, plan.effectiveInput);
  withPermissionExecutionPlan(target, plan);
  if (context.args !== target) Object.assign(context, { args: target });
}

function applyHookUpdatedInput(
  context: BeforeToolCallContext,
  updatedInput: Readonly<Record<string, unknown>> | undefined,
): void {
  if (!updatedInput) return;
  const target = readMutableRecord(context.args);
  for (const key of Reflect.ownKeys(target)) {
    if (!Reflect.deleteProperty(target, key)) {
      throw new TypeError('Permission gate could not replace the Hook-updated input.');
    }
  }
  Object.assign(target, updatedInput);
  if (context.args !== target) Object.assign(context, { args: target });
}

function readPermissionToolRequest(
  context: BeforeToolCallContext,
  snapshotInput: PermissionExecutionPlanPort['snapshotInput'] | undefined,
): PermissionToolRequest {
  const toolInput = readRecord(context.args);
  const request = {
    toolCallId: readToolCallField(context.toolCall, 'id'),
    toolName: readToolCallField(context.toolCall, 'name'),
    toolSource: readToolCallField(context.toolCall, 'source'),
    toolInput: snapshotInput ? snapshotInput(toolInput) : Object.freeze({ ...toolInput }),
  };
  if (
    typeof request.toolCallId !== 'string' ||
    !request.toolCallId ||
    typeof request.toolName !== 'string' ||
    !request.toolName
  ) {
    throw new TypeError('Permission tool-call identity must contain a non-empty id and name.');
  }
  return request;
}

function readToolCallField(toolCall: unknown, field: 'id' | 'name' | 'source'): string {
  if (!toolCall || typeof toolCall !== 'object') return '';
  const value = Reflect.get(toolCall, field);
  return typeof value === 'string' ? value : '';
}

function isBuiltinTool(toolCall: unknown): boolean {
  const source =
    toolCall && typeof toolCall === 'object' ? Reflect.get(toolCall, 'source') : undefined;
  return source === 'builtin' || source === 'builtin-matrix';
}

function deriveRuleContents(toolName: string, input: Readonly<Record<string, unknown>>): string[] {
  const direct =
    input.command ?? input.path ?? input.filePath ?? input.file_path ?? input.url ?? input.pattern;
  return typeof direct === 'string' && direct.trim() ? [direct.trim()] : [toolName];
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function readMutableRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedPermissionError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
}
