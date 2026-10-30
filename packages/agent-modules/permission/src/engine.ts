/**
 * Permission Engine — checker registry/dispatcher plus the legacy rollback reducer.
 *
 * With `policyOwner: 'core'`, the engine invokes the registered checker and
 * delegates the final verdict to Permission Core. The explicit `engine`
 * rollback path retains the three-step flow from permission_design.md §4.1:
 *
 *   Step 1: Reject check (hard block, unaffected by bypass mode)
 *   Step 2: Allow check  (fast path)
 *   Step 3: Fallback     (passthrough → ask)
 *
 * Both paths delegate tool-specific permission logic to registered
 * {@link ToolPermissionChecker} implementations (e.g. bash, file-system).
 *
 * Reference: permission_design.md §4
 */

import { logger, backgroundCtx } from './host-utils.js';
import { matchesMcpServerRuntimeName } from './mcp-runtime-name.js';
import type {
  PermissionBehavior,
  PermissionDecision,
  PermissionRule,
  ToolCheckResult,
} from './types.js';
import type { ToolPermissionContext } from './context.js';
import {
  getContentRulesForTool,
  hasWholeToolRule,
  isBypassMode,
  isInteractiveTool,
} from './context.js';
import { decideUnknownToolPathCapabilities } from './tools/path-capability.js';
import { reducePermissionDecision, type PermissionCheckOptions } from './permission-core.js';

export type { ToolCheckResult } from './types.js';

// ---------------------------------------------------------------------------
// Tool permission checker interface
// ---------------------------------------------------------------------------

/**
 * Interface that tool-specific permission checkers must implement.
 *
 * Registered via {@link PermissionEngine.registerToolPermissionChecker}.
 */
export interface ToolPermissionChecker {
  /**
   * Check whether the tool invocation is permitted.
   *
   * @param toolName - The registered name of the tool (e.g. "bash", "edit")
   * @param input    - The parsed input arguments for the tool invocation
   * @param context  - The current permission context
   * @returns        - The check result, or `undefined` to indicate passthrough
   */
  checkPermissions(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool input shapes vary per tool
    input: Record<string, any>,
    context: ToolPermissionContext,
  ): ToolCheckResult | undefined;
}

// ---------------------------------------------------------------------------
// Rule matching helpers (content-specific rules)
// ---------------------------------------------------------------------------

/**
 * Parse a rule string `toolName(ruleContent)` into its components.
 * Used only for MCP server-level matching.
 */
function matchesMcpServerRule(toolName: string, rule: PermissionRule): boolean {
  const ruleToolName = rule.ruleValue.toolName;
  return !rule.ruleValue.ruleContent && matchesMcpServerRuntimeName(toolName, ruleToolName);
}

/**
 * Check if any content-specific ask rule matches the given input.
 *
 * Content-specific ask rules are bypass-immune (§4.2 point 3).
 */
function matchesContentAskRule(
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- input shape varies per tool
  input: Record<string, any>,
  ctx: ToolPermissionContext,
): PermissionRule | undefined {
  const contentAskRules = getContentRulesForTool(ctx, toolName, 'ask');

  for (const rule of contentAskRules) {
    // Content rules have ruleContent defined (guaranteed by getContentRulesForTool)
    // The engine performs a simple substring/equality check here.
    // Tool-specific matching (wildcard, prefix) is handled by tool checkers.
    const { ruleContent } = rule.ruleValue;
    if (!ruleContent) continue;

    // Extract the relevant input field for matching
    const inputContent = extractToolInputContent(toolName, input);
    if (inputContent && inputContent.includes(ruleContent)) {
      return rule;
    }
  }

  return undefined;
}

/**
 * Extract the primary content string from a tool input for rule matching.
 */
function extractToolInputContent(
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool input shapes vary
  input: Record<string, any>,
): string | undefined {
  switch (toolName) {
    case 'bash':
      return typeof input.command === 'string' ? input.command : undefined;
    case 'edit':
    case 'write':
    case 'read':
    case 'glob':
      return typeof input.filePath === 'string'
        ? input.filePath
        : typeof input.path === 'string'
          ? input.path
          : typeof input.pattern === 'string'
            ? input.pattern
            : undefined;
    default:
      // For other tools, try common field names
      return typeof input.command === 'string'
        ? input.command
        : typeof input.url === 'string'
          ? input.url
          : undefined;
  }
}

// ---------------------------------------------------------------------------
// PermissionEngine
// ---------------------------------------------------------------------------

/**
 * Tool-checker registry with selectable Core and legacy Engine policy paths.
 *
 * Usage:
 * ```ts
 * const engine = new PermissionEngine()
 * engine.registerToolPermissionChecker('bash', bashChecker)
 * engine.registerToolPermissionChecker('edit', fsChecker)
 *
 * const decision = engine.checkPermission('bash', { command: 'git status' }, ctx)
 * // => { behavior: 'allow', reason: { type: 'rule', rule: ... } }
 * ```
 */
export class PermissionEngine {
  private readonly checkers = new Map<string, ToolPermissionChecker>();

  /**
   * Register a tool-specific permission checker.
   *
   * @param toolName - Tool name (e.g. "bash", "edit", "write")
   * @param checker  - The checker implementation
   */
  registerToolPermissionChecker(toolName: string, checker: ToolPermissionChecker): void {
    const ctx = backgroundCtx();
    this.checkers.set(toolName, checker);
    logger.debug(ctx, `Registered tool permission checker: toolName=${toolName}`);
  }

  /**
   * Unregister a tool-specific permission checker.
   */
  unregisterToolPermissionChecker(toolName: string): void {
    const ctx = backgroundCtx();
    this.checkers.delete(toolName);
    logger.debug(ctx, `Unregistered tool permission checker: toolName=${toolName}`);
  }

  /**
   * Check permission for a tool invocation.
   *
   * The `engine` rollback path implements the three-step decision flow from §4.1.
   * The `core` path dispatches the checker once and calls the Core reducer.
   *
   * **Step 1 — Reject check** (hard block, bypass-immune):
   *   1a. Whole tool in deny rules → DENY
   *   1b. Whole tool in ask rules → ASK (sandbox exception)
   *   1c. Call tool.checkPermissions (tool-specific check)
   *   1d. Tool returns deny → DENY
   *   1e. requiresUserInteraction → ASK
   *   1f. Content-specific ask rule → ASK (bypass-immune)
   *   1g. Safety check → ASK (unless bypass mode applies)
   *
   * **Step 2 — Allow check** (fast path):
   *   2a. bypassPermissions mode → ALLOW
   *   2b. Whole tool in allow rules → ALLOW
   *
   * **Step 3 — Fallback**:
   *   passthrough → ask
   */
  checkPermission(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool input shapes vary per tool
    input: Record<string, any>,
    context: ToolPermissionContext,
    options: PermissionCheckOptions = {},
  ): PermissionDecision {
    const policyOwner = options.policyOwner ?? 'engine';
    if (policyOwner !== 'engine' && policyOwner !== 'core') {
      throw new Error(`Unknown permission policy owner: ${String(policyOwner)}`);
    }
    if (policyOwner === 'core')
      return this.checkPermissionWithCore(toolName, input, context, options);
    return this.checkPermissionWithEngine(toolName, input, context, options);
  }

  private checkPermissionWithCore(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool input shapes vary per tool
    input: Record<string, any>,
    context: ToolPermissionContext,
    options: PermissionCheckOptions,
  ): PermissionDecision {
    const ctx = backgroundCtx();
    const checker = this.checkers.get(toolName);
    let checkerResult: ToolCheckResult | undefined;
    let checkerError: string | undefined;
    try {
      checkerResult = checker
        ? checker.checkPermissions(toolName, input, context)
        : decideUnknownToolPathCapabilities(toolName, input, context);
    } catch (err) {
      checkerError = (err as Error).message;
      logger.error(
        ctx,
        `Tool permission checker threw an error: toolName=${toolName} error=${checkerError}`,
      );
    }
    this.notifyCheckerDecision(options, Boolean(checker), checkerResult, Boolean(checkerError));

    return reducePermissionDecision({
      toolName,
      input,
      context,
      checkerRegistered: Boolean(checker),
      ...(checkerResult ? { checkerResult } : {}),
      ...(checkerError ? { checkerError } : {}),
    });
  }

  private checkPermissionWithEngine(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool input shapes vary per tool
    input: Record<string, any>,
    context: ToolPermissionContext,
    options: PermissionCheckOptions,
  ): PermissionDecision {
    const ctx = backgroundCtx();
    logger.debug(ctx, `Checking permission: toolName=${toolName} mode=${context.mode}`);

    // -----------------------------------------------------------------------
    // Step 1: Reject check (hard block, bypass-immune)
    // -----------------------------------------------------------------------

    // 1a. Whole tool in deny rules?
    const denyRule = hasWholeToolRule(context, toolName, 'deny');
    if (denyRule) {
      logger.debug(ctx, `Step 1a: Tool denied by whole-tool deny rule: toolName=${toolName}`);
      return { behavior: 'deny', reason: { type: 'rule', rule: denyRule } };
    }

    // Also check MCP server-level deny rules
    const mcpDenyRule = this.findMcpServerRule(toolName, context, 'deny');
    if (mcpDenyRule) {
      logger.debug(ctx, `Step 1a: Tool denied by MCP server deny rule: toolName=${toolName}`);
      return { behavior: 'deny', reason: { type: 'rule', rule: mcpDenyRule } };
    }

    // Resolve the local checker before broad ask rules. A command/content
    // deny is narrower than a whole-tool or MCP ask and therefore must win.
    // Checker failures remain ASK; an existing explicit ask rule still owns
    // the user-facing reason in that case, matching the previous behavior.
    const checker = this.checkers.get(toolName);
    let toolCheckResult: ToolCheckResult | undefined;
    let checkerError: string | undefined;
    try {
      toolCheckResult = checker
        ? checker.checkPermissions(toolName, input, context)
        : decideUnknownToolPathCapabilities(toolName, input, context);
    } catch (err) {
      checkerError = (err as Error).message;
      logger.error(
        ctx,
        `Tool permission checker threw an error: toolName=${toolName} error=${checkerError}`,
      );
    }
    this.notifyCheckerDecision(options, Boolean(checker), toolCheckResult, Boolean(checkerError));

    if (toolCheckResult?.behavior === 'deny') {
      logger.debug(ctx, `Step 1d: Tool checker returned deny: toolName=${toolName}`);
      return { behavior: 'deny', reason: toolCheckResult.reason };
    }

    // 1b. Whole tool in ask rules? → ASK (sandbox exception)
    const askRule = hasWholeToolRule(context, toolName, 'ask');
    if (askRule) {
      // Sandbox exception: bash tool + sandbox enabled + autoAllowBashIfSandboxed
      if (toolName === 'bash' && context.sandboxEnabled && context.autoAllowBashIfSandboxed) {
        logger.debug(ctx, `Step 1b: Bash ask rule bypassed by sandbox: toolName=${toolName}`);
        // Don't return ASK — let it fall through to further checks
      } else {
        logger.debug(
          ctx,
          `Step 1b: Tool requires ask by whole-tool ask rule: toolName=${toolName}`,
        );
        return {
          behavior: 'ask',
          reason: { type: 'rule', rule: askRule },
          ruleContents: this.resolveRuleContents(toolName, input, toolCheckResult),
          ruleMatchers: this.resolveRuleMatchers(toolCheckResult),
          candidateScopes: this.resolveCandidateScopes(toolCheckResult),
          rewrittenInput: toolCheckResult?.rewrittenInput,
        };
      }
    }

    // Also check MCP server-level ask rules
    const mcpAskRule = this.findMcpServerRule(toolName, context, 'ask');
    if (mcpAskRule) {
      logger.debug(ctx, `Step 1b: Tool requires ask by MCP server ask rule: toolName=${toolName}`);
      return {
        behavior: 'ask',
        reason: { type: 'rule', rule: mcpAskRule },
        ruleContents: this.resolveRuleContents(toolName, input),
        candidateScopes: this.resolveCandidateScopes(undefined),
      };
    }

    if (checkerError) {
      return {
        behavior: 'ask',
        reason: {
          type: 'safetyCheck',
          description: `Tool checker error: ${checkerError}`,
        },
        ruleContents: this.resolveRuleContents(toolName, input),
      };
    }

    // 1e. requiresUserInteraction? → ASK
    if (isInteractiveTool(context, toolName)) {
      logger.debug(ctx, `Step 1e: Tool requires user interaction: toolName=${toolName}`);
      return {
        behavior: 'ask',
        reason: {
          type: 'safetyCheck',
          description: `Tool "${toolName}" requires user interaction`,
        },
        ruleContents: this.resolveRuleContents(toolName, input, toolCheckResult),
        ruleMatchers: this.resolveRuleMatchers(toolCheckResult),
        candidateScopes: this.resolveCandidateScopes(toolCheckResult),
      };
    }

    // 1f. Content-specific ask rule? → ASK (bypass-immune)
    if (toolCheckResult && toolCheckResult.behavior === 'ask' && toolCheckResult.bypassImmune) {
      logger.debug(ctx, `Step 1f: Tool checker returned bypass-immune ask: toolName=${toolName}`);
      return {
        behavior: 'ask',
        reason: toolCheckResult.reason,
        ruleContents: this.resolveRuleContents(toolName, input, toolCheckResult),
        ruleMatchers: this.resolveRuleMatchers(toolCheckResult),
        candidateScopes: this.resolveCandidateScopes(toolCheckResult),
        bypassImmune: true,
        rewrittenInput: toolCheckResult.rewrittenInput,
        skipAutoClassifier: toolCheckResult.skipAutoClassifier,
      };
    }

    const contentAskMatch = matchesContentAskRule(toolName, input, context);
    if (contentAskMatch) {
      logger.debug(
        ctx,
        `Step 1f: Content-specific ask rule matched: toolName=${toolName} ruleContent=${contentAskMatch.ruleValue.ruleContent}`,
      );
      return {
        behavior: 'ask',
        reason: { type: 'rule', rule: contentAskMatch },
        ruleContents: this.resolveRuleContents(toolName, input, toolCheckResult),
        ruleMatchers: this.resolveRuleMatchers(toolCheckResult),
        candidateScopes: this.resolveCandidateScopes(toolCheckResult),
        rewrittenInput: toolCheckResult?.rewrittenInput,
      };
    }

    // 1g. Safety check? → ASK in normal modes.
    // Bypass mode may override approvable safety checks unless the checker
    // explicitly marked them as bypass-immune above.
    if (
      toolCheckResult &&
      toolCheckResult.behavior === 'ask' &&
      toolCheckResult.reason.type === 'safetyCheck' &&
      !isBypassMode(context)
    ) {
      logger.debug(ctx, `Step 1g: Safety check triggered: toolName=${toolName}`);
      return {
        behavior: 'ask',
        reason: toolCheckResult.reason,
        ruleContents: this.resolveRuleContents(toolName, input, toolCheckResult),
        ruleMatchers: this.resolveRuleMatchers(toolCheckResult),
        candidateScopes: this.resolveCandidateScopes(toolCheckResult),
        rewrittenInput: toolCheckResult?.rewrittenInput,
        skipAutoClassifier: toolCheckResult.skipAutoClassifier,
      };
    }

    // 1h. Tool checker requested ASK for a non-safety reason. Preserve the
    // tool-specific reason and flags in normal modes; bypassPermissions may
    // still override these non-immune asks below.
    if (toolCheckResult && toolCheckResult.behavior === 'ask' && !isBypassMode(context)) {
      logger.debug(ctx, `Step 1h: Tool checker returned ask: toolName=${toolName}`);
      return {
        behavior: 'ask',
        reason: toolCheckResult.reason,
        ruleContents: this.resolveRuleContents(toolName, input, toolCheckResult),
        ruleMatchers: this.resolveRuleMatchers(toolCheckResult),
        candidateScopes: this.resolveCandidateScopes(toolCheckResult),
        rewrittenInput: toolCheckResult?.rewrittenInput,
        skipAutoClassifier: toolCheckResult.skipAutoClassifier,
      };
    }

    // -----------------------------------------------------------------------
    // Step 2: Allow check (fast path)
    // -----------------------------------------------------------------------

    // 2a. bypassPermissions mode? → ALLOW
    if (isBypassMode(context)) {
      logger.debug(ctx, `Step 2a: Bypass mode active, allowing: toolName=${toolName}`);
      return {
        behavior: 'allow',
        reason: { type: 'mode', mode: 'bypassPermissions' },
        rewrittenInput: toolCheckResult?.rewrittenInput,
      };
    }

    // 2b. Whole tool in allow rules? → ALLOW
    const allowRule = hasWholeToolRule(context, toolName, 'allow');
    if (allowRule) {
      logger.debug(ctx, `Step 2b: Tool allowed by whole-tool allow rule: toolName=${toolName}`);
      return {
        behavior: 'allow',
        reason: { type: 'rule', rule: allowRule },
        rewrittenInput: toolCheckResult?.rewrittenInput,
      };
    }

    // Also check MCP server-level allow rules
    const mcpAllowRule = this.findMcpServerRule(toolName, context, 'allow');
    if (mcpAllowRule) {
      logger.debug(ctx, `Step 2b: Tool allowed by MCP server allow rule: toolName=${toolName}`);
      return {
        behavior: 'allow',
        reason: { type: 'rule', rule: mcpAllowRule },
        rewrittenInput: toolCheckResult?.rewrittenInput,
      };
    }

    // If the tool checker returned allow, use it
    if (toolCheckResult && toolCheckResult.behavior === 'allow') {
      logger.debug(ctx, `Step 2: Tool checker returned allow: toolName=${toolName}`);
      return {
        behavior: 'allow',
        reason: toolCheckResult.reason,
        rewrittenInput: toolCheckResult.rewrittenInput,
      };
    }

    // -----------------------------------------------------------------------
    // Step 3: Fallback
    // -----------------------------------------------------------------------

    // If no checker is registered for this tool and no generic path-bearing
    // fallback matched, default to allow.
    if (!checker) {
      logger.debug(ctx, `Step 3: No checker registered, allowing by default: toolName=${toolName}`);
      return {
        behavior: 'allow',
        reason: {
          type: 'safetyCheck',
          description: `No permission checker registered for tool "${toolName}", allowing by default`,
        },
      };
    }

    // A checker exists but returned passthrough/undefined — fall back to ask.
    logger.debug(
      ctx,
      `Step 3: Checker returned passthrough, falling back to ask: toolName=${toolName}`,
    );
    return {
      behavior: 'ask',
      reason: {
        type: 'safetyCheck',
        description: `No permission rule matched for tool "${toolName}"`,
        category: 'noMatchingPermissionRule',
      },
      ruleContents: this.resolveRuleContents(toolName, input, toolCheckResult),
      ruleMatchers: this.resolveRuleMatchers(toolCheckResult),
      candidateScopes: this.resolveCandidateScopes(toolCheckResult),
      rewrittenInput: toolCheckResult?.rewrittenInput,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private notifyCheckerDecision(
    options: PermissionCheckOptions,
    checkerRegistered: boolean,
    result: ToolCheckResult | undefined,
    checkerFailed: boolean,
  ): void {
    try {
      options.onCheckerDecision?.({
        checkerRegistered,
        checkerBehavior: checkerFailed ? 'error' : (result?.behavior ?? 'none'),
        ...(result ? { reasonType: result.reason.type } : {}),
        ...(result ? { reason: result.reason } : {}),
        rewriteApplied: Boolean(result?.rewrittenInput),
        ruleCount: result?.ruleContents?.length ?? 0,
        skipAutoClassifier: result?.skipAutoClassifier === true,
      });
    } catch {
      // Observability must never alter the permission verdict.
    }
  }

  /**
   * Find an MCP server-level rule that matches a tool name.
   *
   * For example, rule with toolName "mcp__myserver" will match
   * tool "mcp__myserver__sometool".
   */
  private findMcpServerRule(
    toolName: string,
    ctx: ToolPermissionContext,
    behavior: PermissionBehavior,
  ): PermissionRule | undefined {
    const bgCtx = backgroundCtx();
    if (!toolName.startsWith('mcp__')) return undefined;

    return ctx.rules.find(
      (r) =>
        r.ruleBehavior === behavior &&
        !r.ruleValue.ruleContent &&
        matchesMcpServerRule(toolName, r),
    );
  }

  /**
   * Resolve ruleContents for an 'ask' decision.
   * Priority: checker result > extractToolInputContent fallback.
   */
  private resolveRuleContents(
    toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: Record<string, any>,
    checkerResult?: ToolCheckResult,
  ): string[] | undefined {
    const ctx = backgroundCtx();
    if (checkerResult?.ruleContents?.length) {
      return checkerResult.ruleContents;
    }
    const content = extractToolInputContent(toolName, input);
    return content ? [content] : undefined;
  }

  /**
   * Companion to `resolveRuleContents` for the structured multi-scope
   * shape. Only forwards `candidateScopes` from the tool checker when
   * the checker also supplied a matching `ruleContents` — i.e. the
   * checker owns both fields and their `candidates[0].ruleContent`
   * strings are known to align with the flat `ruleContents[i]` entries
   * by construction. Falls back to `undefined` in the synthesized
   * `extractToolInputContent` branch because that path does not have
   * structured scope alternatives to offer (a single wrapping rule is
   * emitted with no widening choices).
   *
   * See {@link PermissionDecision.candidateScopes} for the contract
   * the two fields must jointly satisfy on the wire.
   */
  private resolveCandidateScopes(
    checkerResult?: ToolCheckResult,
  ): PermissionDecision['candidateScopes'] {
    if (!checkerResult?.ruleContents?.length) return undefined;
    if (!checkerResult.candidateScopes || checkerResult.candidateScopes.length === 0) {
      return undefined;
    }
    return checkerResult.candidateScopes;
  }

  private resolveRuleMatchers(checkerResult?: ToolCheckResult): PermissionDecision['ruleMatchers'] {
    if (!checkerResult?.ruleContents?.length) return undefined;
    return checkerResult.ruleMatchers?.length === checkerResult.ruleContents.length
      ? checkerResult.ruleMatchers
      : undefined;
  }
}
