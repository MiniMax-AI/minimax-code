import { matchesMcpServerRuntimeName } from './mcp-runtime-name.js';
import {
  hasWholeToolRule,
  isBypassMode,
  isInteractiveTool,
  type ToolPermissionContext,
} from './context.js';
import type {
  DecisionReason,
  PermissionBehavior,
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  ToolCheckResult,
} from './types.js';
import { extractToolInputContent, matchesContentAskRule } from './content-ask-rule.js';
import { decideMcpAllow, findMcpSubjectRule, type McpToolRuleSubject } from './mcp-rule-subject.js';

export type PermissionPolicyOwner = 'engine' | 'core';

export interface PermissionCheckOptions {
  policyOwner?: PermissionPolicyOwner;
  onCheckerDecision?: (trace: PermissionCheckerDecisionTrace) => void;
  /** Host-supplied MCP source metadata; rules then also match by `(plugin, server, tool)`. */
  mcpRuleSubject?: McpToolRuleSubject;
}

/** Checker output exposed only for host-side observability; hosts own log filtering. */
export interface PermissionCheckerDecisionTrace {
  checkerRegistered: boolean;
  checkerBehavior: ToolCheckResult['behavior'] | 'none' | 'error';
  reasonType?: ToolCheckResult['reason']['type'];
  /** Complete checker reason; the host decides which fields enter diagnostics. */
  reason?: DecisionReason;
  rewriteApplied: boolean;
  ruleCount: number;
  skipAutoClassifier: boolean;
}

export interface PermissionCoreDecisionInput {
  toolName: string;
  input: Record<string, unknown>;
  context: ToolPermissionContext;
  checkerRegistered: boolean;
  checkerResult?: ToolCheckResult;
  /** Presence means checker failure, including an empty error message. */
  checkerError?: string;
  mcpRuleSubject?: McpToolRuleSubject;
}

export type PermissionAction = 'read' | 'write' | 'delete' | 'execute' | 'network';
export type ShellFamily = 'posix' | 'cmd' | 'powershell' | 'unknown';

export type PathValue = {
  /** 命令里出现的原始路径；保留用户输入形态。 */
  raw: string;
  /** 在当前 session 的 homeDir/workingDirectory 上下文中解析后的路径。 */
  resolved?: string;
  /** 是否仍可能受环境变量、glob 或其他动态语义影响。 */
  dynamic: boolean;
  /** 原始路径的解释方式；~ 展开为 home，相对路径仍保留 relative。 */
  resolution?: 'absolute' | 'relative' | 'home' | 'environment' | 'glob' | 'unknown';
};

export type CommandIntent =
  | {
      kind: 'filesystem';
      action: Extract<PermissionAction, 'read' | 'write' | 'delete'>;
      paths: PathValue[];
      recursive?: boolean;
      force?: boolean;
      shell: ShellFamily;
    }
  | {
      kind: 'execute';
      program?: string;
      argv: string[];
      shell: ShellFamily;
      dynamic: boolean;
    }
  | {
      kind: 'network';
      targets: string[];
      method?: string;
      shell: ShellFamily;
      dynamic: boolean;
    }
  | {
      kind: 'script';
      interpreter?: string;
      path?: PathValue;
      shell: ShellFamily;
      dynamic: boolean;
    }
  | { kind: 'opaque'; shell: ShellFamily; raw: string; reason: string };

export type PermissionEvidence =
  | { kind: 'host-deny'; reason: string }
  | { kind: 'user-rule'; behavior: PermissionBehavior; ruleContent?: string }
  | { kind: 'path-capability'; action: PermissionAction; path: string; allowed: boolean }
  | { kind: 'built-in-allow'; reason: string }
  | { kind: 'classifier-eligible'; reason: string }
  | { kind: 'classifier-ineligible'; reason: string }
  | { kind: 'classifier-result'; behavior: PermissionBehavior; reason: string }
  | { kind: 'legacy-reason'; value: unknown }
  | { kind: 'legacy-deny'; reason: string };

export type ExecutionTransform =
  | { type: 'recoverable-delete'; targets: string[] }
  | { type: 'recoverable-shell-delete'; launcher: string };

export type ExecutionPlan = {
  originalInput: Record<string, unknown>;
  effectiveInput: Record<string, unknown>;
  intents: CommandIntent[];
  transforms: ExecutionTransform[];
  /** Permission.nativeDelete captured when the decision was made. */
  nativeDelete?: boolean;
};

export type PermissionModeProfile = {
  /** 是否可以和用户交互；headless 无审批通道时采用 fail-closed。 */
  interaction: 'ask' | 'neverAsk' | 'headless-fail-closed';
  /** 是否允许交给 LLM/classifier 做补充判断；不影响 host safety 和显式 deny。 */
  classifier: 'allowed' | 'forbidden';
  /** 权限结果是否作为执行硬门禁；off 表示权限层不阻断执行。 */
  enforcement: 'strict' | 'off';
  /** 是否允许走 bypass evaluator；不等于跳过 host safety。 */
  bypass: 'allowed' | 'forbidden';
};

export type PermissionEvaluationInput = {
  toolName: string;
  input: Record<string, unknown>;
  evidence: PermissionEvidence[];
  executionPlan?: ExecutionPlan;
  mode: PermissionModeProfile;
  context: {
    workingDirectory: string;
    homeDir: string;
    dataDir: string;
    sessionId?: string;
    agentName?: string;
  };
};

export type PermissionApprovalRequest = {
  requestId: string;
  sessionId: string;
  agentName?: string;
  toolName: string;
  toolInput?: string;
  reason: string;
  ruleContents: string[];
  allowAlwaysSupported: boolean;
};

export type PermissionEvaluation =
  | { outcome: 'allow'; reason: string; executionPlan?: ExecutionPlan }
  | { outcome: 'ask'; request: PermissionApprovalRequest; executionPlan?: ExecutionPlan }
  | { outcome: 'deny'; reason: string };

/**
 * Production policy reducer used when Core owns the final decision. Existing
 * tool checkers keep their local ToolCheckResult interface; this reducer owns
 * cross-rule, mode, interactive-tool, and checker-result precedence.
 */
export function reducePermissionDecision(input: PermissionCoreDecisionInput): PermissionDecision {
  const { toolName, context, checkerResult } = input;

  const subject = input.mcpRuleSubject;
  const denyRule =
    hasWholeToolRule(context, toolName, 'deny') ??
    findMcpServerRule(toolName, context, 'deny') ??
    findMcpSubjectRule(subject, context, 'deny');
  if (denyRule) return { behavior: 'deny', reason: { type: 'rule', rule: denyRule } };

  // A tool/content checker deny is an explicit deny for this invocation. It
  // must win over broader whole-tool or MCP ask rules; otherwise adding a
  // blanket ask can weaken a command-specific hard block.
  if (checkerResult?.behavior === 'deny') {
    return { behavior: 'deny', reason: checkerResult.reason };
  }

  const askRule = hasWholeToolRule(context, toolName, 'ask');
  const sandboxBypassesAsk =
    toolName === 'bash' && context.sandboxEnabled && context.autoAllowBashIfSandboxed;
  if (askRule && !sandboxBypassesAsk) {
    return {
      behavior: 'ask',
      reason: { type: 'rule', rule: askRule },
      ruleContents: resolveRuleContents(toolName, input.input, checkerResult),
      ruleMatchers: resolveRuleMatchers(checkerResult),
      candidateScopes: resolveCandidateScopes(checkerResult),
      rewrittenInput: checkerResult?.rewrittenInput,
    };
  }

  const mcpAskRule =
    findMcpServerRule(toolName, context, 'ask') ?? findMcpSubjectRule(subject, context, 'ask');
  if (mcpAskRule) {
    return {
      behavior: 'ask',
      reason: { type: 'rule', rule: mcpAskRule },
      ruleContents: resolveRuleContents(toolName, input.input),
    };
  }

  if (input.checkerError !== undefined) {
    return {
      behavior: 'ask',
      reason: {
        type: 'safetyCheck',
        description: `Tool checker error: ${input.checkerError || 'Unknown tool permission checker failure'}`,
      },
      ruleContents: resolveRuleContents(toolName, input.input),
    };
  }

  if (isInteractiveTool(context, toolName)) {
    return {
      behavior: 'ask',
      reason: {
        type: 'safetyCheck',
        description: `Tool "${toolName}" requires user interaction`,
      },
      ruleContents: resolveRuleContents(toolName, input.input, checkerResult),
      ruleMatchers: resolveRuleMatchers(checkerResult),
      candidateScopes: resolveCandidateScopes(checkerResult),
    };
  }

  if (checkerResult?.behavior === 'ask' && checkerResult.bypassImmune) {
    return {
      behavior: 'ask',
      reason: checkerResult.reason,
      ruleContents: resolveRuleContents(toolName, input.input, checkerResult),
      ruleMatchers: resolveRuleMatchers(checkerResult),
      candidateScopes: resolveCandidateScopes(checkerResult),
      bypassImmune: true,
      rewrittenInput: checkerResult.rewrittenInput,
      skipAutoClassifier: checkerResult.skipAutoClassifier,
    };
  }

  const contentAskRule = matchesContentAskRule(toolName, input.input, context);
  if (contentAskRule) {
    return {
      behavior: 'ask',
      reason: { type: 'rule', rule: contentAskRule },
      ruleContents: resolveRuleContents(toolName, input.input, checkerResult),
      ruleMatchers: resolveRuleMatchers(checkerResult),
      candidateScopes: resolveCandidateScopes(checkerResult),
      rewrittenInput: checkerResult?.rewrittenInput,
    };
  }

  if (checkerResult?.behavior === 'ask' && !isBypassMode(context)) {
    return {
      behavior: 'ask',
      reason: checkerResult.reason,
      ruleContents: resolveRuleContents(toolName, input.input, checkerResult),
      ruleMatchers: resolveRuleMatchers(checkerResult),
      candidateScopes: resolveCandidateScopes(checkerResult),
      rewrittenInput: checkerResult.rewrittenInput,
      skipAutoClassifier: checkerResult.skipAutoClassifier,
    };
  }

  if (isBypassMode(context)) {
    return {
      behavior: 'allow',
      reason: { type: 'mode', mode: 'bypassPermissions' },
      rewrittenInput: checkerResult?.rewrittenInput,
    };
  }

  const subjectAllow = decideMcpAllow(
    subject,
    context,
    (scope) =>
      hasWholeToolRule(scope, toolName, 'allow') ?? findMcpServerRule(toolName, scope, 'allow'),
  );
  if (subjectAllow) {
    return subjectAllow.behavior === 'allow'
      ? { ...subjectAllow, rewrittenInput: checkerResult?.rewrittenInput }
      : { ...subjectAllow, ruleContents: resolveRuleContents(toolName, input.input) };
  }

  if (checkerResult?.behavior === 'allow') {
    return {
      behavior: 'allow',
      reason: checkerResult.reason,
      rewrittenInput: checkerResult.rewrittenInput,
    };
  }

  if (!input.checkerRegistered) {
    return {
      behavior: 'allow',
      reason: {
        type: 'safetyCheck',
        description: `No permission checker registered for tool "${toolName}", allowing by default`,
      },
    };
  }

  return {
    behavior: 'ask',
    reason: {
      type: 'safetyCheck',
      description: `No permission rule matched for tool "${toolName}"`,
    },
    ruleContents: resolveRuleContents(toolName, input.input, checkerResult),
    ruleMatchers: resolveRuleMatchers(checkerResult),
    candidateScopes: resolveCandidateScopes(checkerResult),
    rewrittenInput: checkerResult?.rewrittenInput,
  };
}

/**
 * Fold an external classifier recommendation back through Core policy.
 * Classifiers only refine an ASK; they never override a decision that Core
 * already finalized as ALLOW or DENY.
 */
export function reducePermissionClassifierDecision(
  decision: PermissionDecision,
  recommendation: Pick<PermissionDecision, 'behavior' | 'reason'>,
): PermissionDecision {
  if (decision.behavior !== 'ask') return decision;
  if (recommendation.behavior === 'deny') {
    return { behavior: 'deny', reason: recommendation.reason };
  }
  if (recommendation.behavior === 'allow') {
    return {
      behavior: 'allow',
      reason: recommendation.reason,
      rewrittenInput: decision.rewrittenInput,
    };
  }
  return { ...decision, reason: recommendation.reason };
}

function findMcpServerRule(
  toolName: string,
  context: ToolPermissionContext,
  behavior: PermissionBehavior,
): PermissionRule | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  return context.rules.find(
    (rule) =>
      rule.ruleBehavior === behavior &&
      !rule.ruleValue.ruleContent &&
      matchesMcpServerRuntimeName(toolName, rule.ruleValue.toolName),
  );
}

function resolveRuleContents(
  toolName: string,
  input: Record<string, unknown>,
  checkerResult?: ToolCheckResult,
): string[] | undefined {
  if (checkerResult?.ruleContents?.length) return checkerResult.ruleContents;
  const content = extractToolInputContent(toolName, input);
  return content ? [content] : undefined;
}

function resolveCandidateScopes(
  checkerResult?: ToolCheckResult,
): PermissionDecision['candidateScopes'] {
  if (!checkerResult?.ruleContents?.length) return undefined;
  return checkerResult.candidateScopes?.length ? checkerResult.candidateScopes : undefined;
}

function resolveRuleMatchers(checkerResult?: ToolCheckResult): PermissionDecision['ruleMatchers'] {
  if (!checkerResult?.ruleContents?.length) return undefined;
  return checkerResult.ruleMatchers?.length === checkerResult.ruleContents.length
    ? checkerResult.ruleMatchers
    : undefined;
}

export function reducePermissionEvaluation(input: PermissionEvaluationInput): PermissionEvaluation {
  const evidence = input.evidence;
  const hostDeny = evidence.find((item) => item.kind === 'host-deny');
  if (hostDeny?.kind === 'host-deny') return { outcome: 'deny', reason: hostDeny.reason };

  const explicitDeny = evidence.find(
    (item) => item.kind === 'user-rule' && item.behavior === 'deny',
  );
  if (explicitDeny?.kind === 'user-rule') {
    return { outcome: 'deny', reason: explicitDeny.ruleContent ?? 'explicit user deny' };
  }

  const legacyDeny = evidence.find((item) => item.kind === 'legacy-deny');
  if (legacyDeny?.kind === 'legacy-deny') return { outcome: 'deny', reason: legacyDeny.reason };

  const classifierDeny = evidence.find(
    (item) => item.kind === 'classifier-result' && item.behavior === 'deny',
  );
  if (classifierDeny?.kind === 'classifier-result') {
    return { outcome: 'deny', reason: classifierDeny.reason };
  }

  const classifierIneligible = evidence.find((item) => item.kind === 'classifier-ineligible');
  const immuneAsk = evidence.find((item) => item.kind === 'user-rule' && item.behavior === 'ask');
  const classifierAsk = evidence.find(
    (item) => item.kind === 'classifier-result' && item.behavior === 'ask',
  );
  const explicitAsk = immuneAsk ?? classifierAsk;
  const classifierAllow = evidence.some(
    (item) => item.kind === 'classifier-result' && item.behavior === 'allow',
  );

  if (
    input.mode.interaction === 'headless-fail-closed' &&
    (explicitAsk || classifierIneligible || (!classifierAllow && !hasAllow(evidence)))
  ) {
    return {
      outcome: 'deny',
      reason: 'permission requires user confirmation but no approval channel is available',
    };
  }

  if (
    explicitAsk ||
    classifierIneligible ||
    (input.mode.interaction !== 'neverAsk' && !classifierAllow && !hasAllow(evidence))
  ) {
    return {
      outcome: 'ask',
      request: buildApprovalRequest(
        input,
        explicitAsk?.kind === 'user-rule' ? explicitAsk.ruleContent : undefined,
      ),
      ...(input.executionPlan ? { executionPlan: input.executionPlan } : {}),
    };
  }

  const allow = evidence.find(
    (item) =>
      (item.kind === 'user-rule' && item.behavior === 'allow') ||
      item.kind === 'built-in-allow' ||
      (item.kind === 'classifier-result' && item.behavior === 'allow'),
  );
  if (allow) {
    return {
      outcome: 'allow',
      reason:
        allow.kind === 'user-rule' ||
        allow.kind === 'built-in-allow' ||
        allow.kind === 'classifier-result'
          ? allow.kind === 'user-rule'
            ? (allow.ruleContent ?? 'explicit user allow')
            : allow.reason
          : 'permission allowed',
      ...(input.executionPlan ? { executionPlan: input.executionPlan } : {}),
    };
  }

  if (input.mode.interaction === 'neverAsk' && input.mode.enforcement === 'strict') {
    return { outcome: 'deny', reason: 'permission interaction is disabled' };
  }

  return {
    outcome: 'ask',
    request: buildApprovalRequest(input),
    ...(input.executionPlan ? { executionPlan: input.executionPlan } : {}),
  };
}

function hasAllow(evidence: PermissionEvidence[]): boolean {
  return evidence.some(
    (item) =>
      (item.kind === 'user-rule' && item.behavior === 'allow') ||
      item.kind === 'built-in-allow' ||
      (item.kind === 'classifier-result' && item.behavior === 'allow'),
  );
}

function buildApprovalRequest(
  input: PermissionEvaluationInput,
  preferredRuleContent?: string,
): PermissionApprovalRequest {
  const ruleContents = input.evidence
    .filter(
      (item): item is Extract<PermissionEvidence, { kind: 'user-rule' }> =>
        item.kind === 'user-rule',
    )
    .map((item) => item.ruleContent)
    .filter((content): content is string => Boolean(content));
  if (preferredRuleContent && !ruleContents.includes(preferredRuleContent))
    ruleContents.unshift(preferredRuleContent);

  return {
    requestId: `${input.context.sessionId ?? 'session'}:${input.toolName}`,
    sessionId: input.context.sessionId ?? 'unknown',
    ...(input.context.agentName ? { agentName: input.context.agentName } : {}),
    toolName: input.toolName,
    toolInput: formatToolInput(input.input),
    reason: 'permission requires approval',
    ruleContents,
    allowAlwaysSupported: true,
  };
}

function formatToolInput(input: Record<string, unknown>): string | undefined {
  if (typeof input.command === 'string') return input.command;
  if (typeof input.filePath === 'string') return input.filePath;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  return undefined;
}

/** Compatibility hook for callers that still hold a legacy mode value. */
export function permissionModeToProfile(mode: PermissionMode): PermissionModeProfile {
  if (mode === 'bypassPermissions') {
    return {
      interaction: 'neverAsk',
      classifier: 'forbidden',
      enforcement: 'strict',
      bypass: 'allowed',
    };
  }
  if (mode === 'off') {
    return {
      interaction: 'neverAsk',
      classifier: 'forbidden',
      enforcement: 'off',
      bypass: 'allowed',
    };
  }
  if (mode === 'auto') {
    return { interaction: 'ask', classifier: 'allowed', enforcement: 'strict', bypass: 'allowed' };
  }
  return {
    interaction: 'ask',
    classifier: 'forbidden',
    enforcement: 'strict',
    bypass: 'forbidden',
  };
}
