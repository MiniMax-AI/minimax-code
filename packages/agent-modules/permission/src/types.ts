/**
 * Core permission system types.
 *
 * Based on permission_design.md sections 2 and 5.
 */

// ---------------------------------------------------------------------------
// Permission Behavior & Mode
// ---------------------------------------------------------------------------

export type PermissionBehavior = 'allow' | 'deny' | 'ask';

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'auto'
  | 'dontAsk'
  | 'off';

// ---------------------------------------------------------------------------
// Permission Rule
// ---------------------------------------------------------------------------

export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
  matcher?: PermissionRuleMatcher;
};

export type PermissionRuleAction = 'read' | 'write' | 'delete' | 'execute' | 'network';

export type PermissionRuleMatcher =
  | { kind: 'tool' }
  | { kind: 'command'; pattern: string }
  | { kind: 'path'; pattern: string; actions?: readonly PermissionRuleAction[] };

export type PermissionRuleSource = 'global' | 'agent' | 'session';

export type PermissionRule = {
  source: PermissionRuleSource;
  ruleBehavior: PermissionBehavior;
  ruleValue: PermissionRuleValue;
};

// ---------------------------------------------------------------------------
// Shell Permission Rule (parsed from ruleContent)
// ---------------------------------------------------------------------------

export type ShellPermissionRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string }
  | { type: 'argvPrefix'; argv: string[] };

// ---------------------------------------------------------------------------
// Decision Reason
// ---------------------------------------------------------------------------

export type DecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'safetyCheck'; description: string; classifierApprovable?: boolean; category?: string }
  | { type: 'workingDirectory'; path: string }
  | { type: 'internalWhitelist'; path: string }
  | { type: 'sessionOwnedReadablePath'; path: string }
  | { type: 'trustedExactWrite'; path: string }
  | { type: 'tempDirectory'; path: string }
  | { type: 'sandbox' }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'pathValidation'; error: string }
  | { type: 'dangerousRemoval'; path: string }
  | { type: 'subcommandResults'; reasons: Map<string, SubcommandResult> }
  | { type: 'rmRewrite'; rewrittenCommand: string }
  | { type: 'recoverableDeleteRewrite'; targets: string[] };

export type SubcommandResult = {
  behavior: PermissionBehavior;
  reason: DecisionReason;
};

// ---------------------------------------------------------------------------
// Permission Decision (returned by check functions)
// ---------------------------------------------------------------------------

export type PermissionDecision = {
  behavior: PermissionBehavior;
  reason: DecisionReason;
  /** When behavior is 'ask', the content items derived from tool input for user display and rule creation. */
  ruleContents?: string[];
  /** Structured matcher candidates aligned 1:1 with `ruleContents`. */
  ruleMatchers?: readonly PermissionRuleMatcher[];
  /**
   * When behavior is 'ask', a discovery-time list of "how wide should
   * the persisted rule be?" options that map 1:1 to the suggested subject
   * of `ruleContents`. See {@link CandidateScope}.
   *
   * Backward-compat contract: `candidateScopes[0]` (index 0) MUST always
   * be equivalent to the current `ruleContents` (the narrow default) so
   * a client that ignores this field keeps seeing today's Codex-aligned
   * argv-exact behaviour. Broader scopes (first-word wildcard,
   * domain-scoped, tool-wide) appear at index >= 1 for clients that opt
   * in via a `selectedScopeIndex` in their reply payload.
   *
   * A subject with only a narrow candidate is still emitted with a
   * one-entry array so downstream reply handlers can look up index 0
   * uniformly.
   */
  candidateScopes?: readonly CandidateScopeGroup[];
  /** When set, the original tool input should be replaced with this rewritten input. */
  rewrittenInput?: Record<string, unknown>;
  /**
   * When true and behavior === 'ask', bypassPermissions mode does NOT
   * silently auto-allow this request. Use for soft sensitive requests that
   * still need confirmation outside auto mode.
   */
  bypassImmune?: boolean;
  /**
   * When true and behavior === 'ask', auto mode skips the Stage 2 LLM
   * classifier and surfaces the ask directly. Keep for final safety
   * boundaries only; soft risks should flow into the classifier.
   */
  skipAutoClassifier?: boolean;
};

/**
 * Local recommendation returned by one tool-specific permission checker.
 * `passthrough` means that the checker has no local opinion; Core/Engine still
 * owns the final verdict for every value.
 */
export type ToolCheckResult = {
  behavior: PermissionBehavior | 'passthrough';
  reason: PermissionDecision['reason'];
  /** When true, this result cannot be overridden by bypass mode (§4.2). */
  bypassImmune?: boolean;
  /** When true, auto mode must surface ASK directly instead of consulting the LLM gate. */
  skipAutoClassifier?: boolean;
  /** Rule content items extracted from tool input (e.g. subcommands, file paths). */
  ruleContents?: string[];
  /** Structured matcher candidates aligned 1:1 with `ruleContents`. */
  ruleMatchers?: readonly PermissionRuleMatcher[];
  /**
   * Structured multi-scope candidates aligned 1:1 with `ruleContents`. When
   * set, MUST satisfy `candidateScopes[i].candidates[0].ruleContent ===
   * ruleContents[i]` for every i so a client that ignores this field falls
   * back to today's narrow behavior. See {@link PermissionDecision.candidateScopes}.
   */
  candidateScopes?: PermissionDecision['candidateScopes'];
  /** Effective input after a safety transform such as recoverable delete. */
  rewrittenInput?: Record<string, unknown>;
};

/**
 * A structured candidate for the persisted allow rule when the user
 * clicks "Allow Always" on a permission popup.
 *
 * Scoping strategy: `narrow` is the current Codex-aligned default (argv-
 * exact-prefix like `bash(["curl","-sSL","<url>"])`); broader kinds
 * (`byFirstWord`, `byArgvPrefix2`, `byDomain`, `wholeTool`) are optional
 * widening choices the UI can surface so a user who trusts a whole tool
 * or a domain can opt in without needing separate follow-up popups.
 *
 * `label` is an i18n key (resolved by the client) that describes the
 * scope to the user; `ruleContent` is the concrete string the persistence
 * layer will write into `permission.json` when the user picks this
 * candidate (identical wire shape as today's `ruleContents[]` element).
 *
 * `kind` is machine-readable so UI can filter or reorder candidates.
 * `narrow` MUST always be present at index 0 of the containing
 * {@link CandidateScopeGroup} for backward compatibility.
 */
export type CandidateScope = {
  kind: 'narrow' | 'byFirstWord' | 'byArgvPrefix2' | 'byDomain' | 'wholeTool';
  ruleContent: string;
  /** i18n key for the scope label shown next to the radio option. */
  labelKey: string;
  /** Optional i18n params for the label (e.g. `{ command: 'curl' }`). */
  labelParams?: Readonly<Record<string, string>>;
};

/**
 * One "subject" that the user is being asked to approve. For a plain
 * single-command bash ask there is one group with one or more
 * {@link CandidateScope}s; for a compound bash command whose subcommand
 * results include multiple asking subcommands there is one group per
 * asking subcommand, mirroring today's `ruleContents[]` array indexing
 * (`ruleContents[i]` equals `candidateScopes[i].candidates[0].ruleContent`).
 *
 * Wire shape stays flat-array-friendly: a client that doesn't understand
 * scope selection reads `candidates[0].ruleContent` per group and gets
 * the same narrow default the wire has always carried in `ruleContents`.
 */
export type CandidateScopeGroup = {
  /** Human-readable subject (an argv rendering or the subcommand text). */
  subjectDisplay: string;
  candidates: readonly CandidateScope[];
};

// ---------------------------------------------------------------------------
// Path Check Context
// ---------------------------------------------------------------------------

export type PathCheckContext = {
  workingDirectory: string;
  allowedWorkingPaths?: string[];
  sandboxAllowPaths?: string[];
  dataDir?: string;
  homeDir?: string;
  agentName?: string;
  trustedExactWritePaths?: readonly string[];
  /**
   * Absolute directories or exact files the active Session owns and may READ:
   * paths the runtime itself hands the Agent, e.g. the Session's workspace
   * when the runtime allocated it inside its data directory, the user's
   * attachments, recoverable tool-output artifacts and compaction snapshots.
   *
   * The host injects them; this engine never derives a path from a Session
   * id, so the runtime layout stays owned by the runtime. A root only counts
   * when it is strictly inside the private runtime tree (`dataDir` /
   * `~/.minimax`) and reached without any symlink below that root; anything
   * else is ignored. Everything else under the tree stays protected: another
   * Session's artifacts, configuration and credentials are never included.
   *
   * Read-only. Writes inside these roots follow the ordinary write rules.
   */
  sessionOwnedReadablePaths?: readonly string[];
};

// ---------------------------------------------------------------------------
// Permission Update
// ---------------------------------------------------------------------------

export type PermissionUpdate =
  | {
      type: 'addRules';
      source: PermissionRuleSource;
      destination: string;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: 'replaceRules';
      source: PermissionRuleSource;
      destination: string;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: 'removeRules';
      source: PermissionRuleSource;
      destination: string;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    };

// ---------------------------------------------------------------------------
// Permission File Config (§3.2 on-disk schema)
// ---------------------------------------------------------------------------

/**
 * Shape of a permission.json file on disk.
 *
 * ```json
 * {
 *   "allow": ["bash(git:*)", "edit", "read"],
 *   "deny":  ["bash(rm -rf:*)"],
 *   "ask":   ["bash(npm publish:*)"],
 *   "defaultMode": "default"
 * }
 * ```
 *
 * `defaultMode` is only meaningful at the global level.
 */
export interface PermissionFileConfig {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  defaultMode?: PermissionMode;
}

// ---------------------------------------------------------------------------
// In-memory Permission Context (§3 read-only snapshot)
// ---------------------------------------------------------------------------

/**
 * In-memory permission context built from the three config layers.
 * Consumers receive a read-only snapshot; mutations go through
 * `PermissionStore.applyUpdate()`.
 */
export interface ToolPermissionContext {
  /** Current permission mode (from global config). */
  mode: PermissionMode;
  /** Merged rule set across all layers, preserving source info. */
  rules: ReadonlyArray<Readonly<PermissionRule>>;
}
