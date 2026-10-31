import { matchesMcpServerRuntimeName } from './mcp-runtime-name.js';
import {
  getContentRulesForTool,
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

export type PermissionPolicyOwner = 'engine' | 'core';

export interface PermissionCheckOptions {
  policyOwner?: PermissionPolicyOwner;
  onCheckerDecision?: (trace: PermissionCheckerDecisionTrace) => void;
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
  checkerError?: string;
}

export type PermissionAction = 'read' | 'write' | 'delete' | 'execute' | 'network';
export type ShellFamily = 'posix' | 'cmd' | 'powershell' | 'unknown';

export type PathValue = {
  /** Original path found in the command, preserving the user's input form. */
  raw: string;
  /** Path resolved in the current session's homeDir/workingDirectory context. */
  resolved?: string;
  /** Whether environment variables, globs, or other dynamic semantics may still affect the path. */
  dynamic: boolean;
  /** How to interpret the original path: expand ~ to home; keep relative paths relative. */
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
  /** Whether user interaction is available; fail closed in headless mode without an approval channel. */
  interaction: 'ask' | 'neverAsk' | 'headless-fail-closed';
  /** Whether to allow supplementary LLM/classifier decisions; does not affect host safety or explicit denies. */
  classifier: 'allowed' | 'forbidden';
  /** Whether permissions are a hard execution gate; off means the permission layer does not block execution. */
  enforcement: 'strict' | 'off';
  /** Whether the bypass evaluator may run; this does not bypass host safety. */
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

  const denyRule =
    hasWholeToolRule(context, toolName, 'deny') ?? findMcpServerRule(toolName, context, 'deny');
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

  const mcpAskRule = findMcpServerRule(toolName, context, 'ask');
  if (mcpAskRule) {
    return {
      behavior: 'ask',
      reason: { type: 'rule', rule: mcpAskRule },
      ruleContents: resolveRuleContents(toolName, input.input),
    };
  }

  if (input.checkerError) {
    return {
      behavior: 'ask',
      reason: { type: 'safetyCheck', description: `Tool checker error: ${input.checkerError}` },
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

  const allowRule =
    hasWholeToolRule(context, toolName, 'allow') ?? findMcpServerRule(toolName, context, 'allow');
  if (allowRule) {
    return {
      behavior: 'allow',
      reason: { type: 'rule', rule: allowRule },
      rewrittenInput: checkerResult?.rewrittenInput,
    };
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

function matchesContentAskRule(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolPermissionContext,
): PermissionRule | undefined {
  const inputContent = extractToolInputContent(toolName, input);
  if (!inputContent) return undefined;
  return getContentRulesForTool(context, toolName, 'ask').find((rule) => {
    const ruleContent = rule.ruleValue.ruleContent;
    return Boolean(ruleContent && inputContent.includes(ruleContent));
  });
}

function extractToolInputContent(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName === 'bash') return typeof input.command === 'string' ? input.command : undefined;
  if (['edit', 'write', 'read', 'glob'].includes(toolName)) {
    if (typeof input.filePath === 'string') return input.filePath;
    if (typeof input.path === 'string') return input.path;
    return typeof input.pattern === 'string' ? input.pattern : undefined;
  }
  if (typeof input.command === 'string') return input.command;
  return typeof input.url === 'string' ? input.url : undefined;
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
