/**
 * Ask-policy + proposed-rule types for the permission decision flow.
 *
 *   PermissionMode (UI / config wire)  ──modeToAskPolicy──▶  AskForApproval
 *
 * `AskForApproval` is the internal policy the facade branches on; `ProposedRule`
 * is the optional rule suggestion a decision can carry (engine-derived, or
 * reserved on a cloud-gateway `allow` verdict).
 */

import type { PermissionMode, PermissionRule, PermissionRuleSource } from './types.js';

// ===========================================================================
// AskForApproval — when do we interrupt the human
// ===========================================================================

/**
 * The three user-facing permission policies, expressed as wire strings.
 *
 * Mapping to the UI mode selector:
 * - 'on-request'     → Ask (PermissionMode 'default')
 * - 'on-request-llm' → Smart approval (PermissionMode 'auto', cloud LLM in the loop)
 * - 'never'          → Always allow (PermissionMode 'bypassPermissions' / 'off')
 * - 'deny'           → Do not ask; deny unless preauthorized (PermissionMode 'dontAsk')
 */
export type AskForApproval = 'on-request' | 'on-request-llm' | 'never' | 'deny';

/**
 * Adapter: `PermissionMode` (UI / config wire) → `AskForApproval` (internal
 * decision policy). The facade translates once near the top of its check so the
 * rest of the flow never branches on PermissionMode directly.
 */
export function modeToAskPolicy(mode: PermissionMode): AskForApproval {
  switch (mode) {
    case 'bypassPermissions':
    case 'off':
      return 'never';
    case 'auto':
      return 'on-request-llm';
    case 'dontAsk':
      return 'deny';
    case 'default':
    case 'acceptEdits':
      // acceptEdits is an alias for default + pre-seeded edit/write allow rules;
      // the alias seeding runs at startup, the runtime treats the mode as default.
      return 'on-request';
    default: {
      // exhaustiveness guard
      const _exhaustive: never = mode;
      void _exhaustive;
      return 'on-request';
    }
  }
}

// ===========================================================================
// ProposedRule — the optional rule suggestion attached to a decision
// ===========================================================================

/**
 * A rule suggestion attached to a decision, surfaced to the UI as the
 * "always allow" pre-filled value, or reserved on a cloud-gateway `allow`
 * verdict (`CloudClassifyVerdict.suggestedRule`).
 *
 * A plain (toolName, ruleContent, scope) triple compatible with the rule store
 * schema.
 */
export interface ProposedRule {
  toolName: string;
  /** Rule body, interpreted by the per-tool checker (bash prefix, fs glob). */
  ruleContent: string;
  /** Suggested persistence scope; UI may override before commit. */
  defaultScope: 'session' | 'global';
  /**
   * Provenance — distinguishes engine-derived suggestions (from the tool call)
   * from cloud-gateway suggestions (an LLM `allow` verdict carrying a rule
   * recommendation).
   */
  source: 'engine' | 'cloud-gateway';
}

/**
 * The narrow scope subset (`'session' | 'global'`) a ProposedRule can target,
 * versus the full `PermissionRuleSource` (`'global' | 'agent' | 'session'`).
 */
export type ProposedRuleScope = ProposedRule['defaultScope'];
export type { PermissionRule, PermissionRuleSource };
