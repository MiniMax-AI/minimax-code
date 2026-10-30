/**
 * ToolPermissionContext management — immutable permission state.
 *
 * The context holds the in-memory representation of all permission rules,
 * the current mode, and environment settings. It is the single source of
 * truth for the {@link PermissionEngine} at query time.
 *
 * All mutations go through {@link applyPermissionUpdate}, which returns a
 * new frozen object (the original is never mutated).
 *
 * Reference: permission_design.md §3 (Persistence Layer) and §4.2 (Design Decisions).
 */

import { logger } from './host-utils.js';
import type {
  PermissionBehavior,
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
  PermissionUpdate,
} from './types.js';

// ---------------------------------------------------------------------------
// DeepReadonly utility type
// ---------------------------------------------------------------------------

/** Recursively marks every property as readonly. */

export type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends Map<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends Set<infer U>
      ? ReadonlySet<DeepReadonly<U>>
      : T extends object
        ? { readonly [P in keyof T]: DeepReadonly<T[P]> }
        : T;

// ---------------------------------------------------------------------------
// ToolPermissionContext
// ---------------------------------------------------------------------------

/**
 * Complete runtime permission context.
 *
 * Held in memory by the daemon; rebuilt from disk on startup and updated
 * immutably whenever the user grants / revokes permissions.
 */
export interface ToolPermissionContext {
  /** Current permission mode. */
  readonly mode: PermissionMode;

  /** Opt out of permission-layer recoverable deletion; ordinary permission rules still apply. */
  readonly nativeDelete?: boolean;

  /** Merged rules from all sources (global + agent + session). */
  readonly rules: readonly PermissionRule[];

  /** Whether the sandbox environment is available. */
  readonly sandboxEnabled: boolean;

  /** If true AND sandbox is enabled, bash commands skip tool-level ask rules. */
  readonly autoAllowBashIfSandboxed: boolean;

  /** Host platform used for platform-specific parser and launcher semantics. */
  readonly platform: NodeJS.Platform;

  /** Actual shell family used for platform-specific command semantics. */
  readonly shellFamily: 'posix' | 'cmd' | 'powershell' | 'unknown';

  /** Primary working directory (CWD of the agent session). */
  readonly workingDirectory: string;

  /** Additional allowed working paths beyond `workingDirectory`. */
  readonly allowedWorkingPaths: readonly string[];

  /** Paths the sandbox is allowed to write to. */
  readonly sandboxAllowPaths: readonly string[];

  /** Turn-scoped exact write targets issued by the trusted execution owner. */
  readonly trustedExactWritePaths: readonly string[];

  /**
   * Absolute directories the active Session owns and may READ, e.g. the
   * Session's own recoverable tool-output artifacts. Issued by the host
   * runtime; the engine never derives them.
   */
  readonly sessionOwnedReadablePaths: readonly string[];

  /** Root data directory resolved from daemon runtime config. */
  readonly dataDir: string;

  /** User home directory. */
  readonly homeDir: string;

  /** Host-owned file probe used by conservative local-script permission checks. */
  readonly isFile?: (filePath: string) => boolean;

  /** Agent name (for agent-scoped rules). */
  readonly agentName?: string;

  /** Session ID (for session-scoped rules). */
  readonly sessionId?: string;

  /** Whether managed permission rules are the only ones shown to the user. */
  readonly allowManagedPermissionRulesOnly: boolean;

  /**
   * Tools that require user interaction and should always be ASK.
   * (e.g. "question" tool).
   */
  readonly interactiveTools: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Configuration input (the shape callers provide)
// ---------------------------------------------------------------------------

/** Input configuration used to construct a ToolPermissionContext. */
export interface ToolPermissionContextConfig {
  mode?: PermissionMode;
  nativeDelete?: boolean;
  rules?: PermissionRule[];
  sandboxEnabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  platform?: NodeJS.Platform;
  shellFamily?: 'posix' | 'cmd' | 'powershell' | 'unknown';
  workingDirectory: string;
  allowedWorkingPaths?: string[];
  sandboxAllowPaths?: string[];
  trustedExactWritePaths?: readonly string[];
  sessionOwnedReadablePaths?: readonly string[];
  dataDir: string;
  homeDir: string;
  isFile?: (filePath: string) => boolean;
  agentName?: string;
  sessionId?: string;
  allowManagedPermissionRulesOnly?: boolean;
  interactiveTools?: Set<string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new {@link ToolPermissionContext} from a configuration object.
 *
 * The returned object is deeply frozen. Any future mutations must go through
 * {@link applyPermissionUpdate}.
 */
export function createToolPermissionContext(
  config: ToolPermissionContextConfig,
): ToolPermissionContext {
  const ctx: ToolPermissionContext = Object.freeze({
    mode: config.mode ?? 'default',
    nativeDelete: config.nativeDelete ?? false,
    rules: Object.freeze([...(config.rules ?? [])]),
    sandboxEnabled: config.sandboxEnabled ?? false,
    autoAllowBashIfSandboxed: config.autoAllowBashIfSandboxed ?? false,
    platform: config.platform ?? process.platform,
    shellFamily: config.shellFamily ?? 'unknown',
    workingDirectory: config.workingDirectory,
    allowedWorkingPaths: Object.freeze([...(config.allowedWorkingPaths ?? [])]),
    sandboxAllowPaths: Object.freeze([...(config.sandboxAllowPaths ?? [])]),
    trustedExactWritePaths: Object.freeze([...(config.trustedExactWritePaths ?? [])]),
    sessionOwnedReadablePaths: Object.freeze([...(config.sessionOwnedReadablePaths ?? [])]),
    dataDir: config.dataDir,
    homeDir: config.homeDir,
    isFile: config.isFile,
    agentName: config.agentName,
    sessionId: config.sessionId,
    allowManagedPermissionRulesOnly: config.allowManagedPermissionRulesOnly ?? false,
    interactiveTools: Object.freeze(new Set(config.interactiveTools ?? ['question'])),
  });

  logger.info(
    {
      mode: ctx.mode,
      ruleCount: ctx.rules.length,
      sandboxEnabled: ctx.sandboxEnabled,
      workingDirectory: ctx.workingDirectory,
    },
    'Created ToolPermissionContext',
  );

  return ctx;
}

// ---------------------------------------------------------------------------
// Immutable update
// ---------------------------------------------------------------------------

/**
 * Apply a {@link PermissionUpdate} to a context, returning a **new** frozen
 * context. The original `ctx` is never mutated.
 *
 * Supported update types:
 * - `addRules` — append new rules (deduplicated)
 * - `replaceRules` — replace all rules of a given behavior+source
 * - `removeRules` — remove matching rules
 */
export function applyPermissionUpdate(
  ctx: ToolPermissionContext,
  update: PermissionUpdate,
): ToolPermissionContext {
  switch (update.type) {
    case 'addRules':
      return addRules(ctx, update.source, update.rules, update.behavior);

    case 'replaceRules':
      return replaceRules(ctx, update.source, update.rules, update.behavior);

    case 'removeRules':
      return removeRules(ctx, update.source, update.rules, update.behavior);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function cloneContextWith(
  ctx: ToolPermissionContext,
  patch: Partial<Pick<ToolPermissionContext, 'mode' | 'rules'>>,
): ToolPermissionContext {
  return Object.freeze({
    mode: patch.mode ?? ctx.mode,
    nativeDelete: ctx.nativeDelete,
    rules: Object.freeze([...(patch.rules ?? ctx.rules)]),
    sandboxEnabled: ctx.sandboxEnabled,
    autoAllowBashIfSandboxed: ctx.autoAllowBashIfSandboxed,
    platform: ctx.platform,
    shellFamily: ctx.shellFamily,
    workingDirectory: ctx.workingDirectory,
    allowedWorkingPaths: ctx.allowedWorkingPaths,
    sandboxAllowPaths: ctx.sandboxAllowPaths,
    trustedExactWritePaths: ctx.trustedExactWritePaths,
    sessionOwnedReadablePaths: ctx.sessionOwnedReadablePaths,
    dataDir: ctx.dataDir,
    homeDir: ctx.homeDir,
    isFile: ctx.isFile,
    agentName: ctx.agentName,
    sessionId: ctx.sessionId,
    allowManagedPermissionRulesOnly: ctx.allowManagedPermissionRulesOnly,
    interactiveTools: ctx.interactiveTools,
  });
}

/** Check if two rule values are semantically equal. */
function ruleValueEquals(a: PermissionRuleValue, b: PermissionRuleValue): boolean {
  if (a.toolName !== b.toolName || (a.ruleContent ?? '') !== (b.ruleContent ?? '')) return false;
  if (!a.matcher || !b.matcher) return a.matcher === b.matcher;
  if (a.matcher.kind !== b.matcher.kind) return false;
  if (a.matcher.kind === 'tool' || b.matcher.kind === 'tool') return true;
  if (a.matcher.pattern !== b.matcher.pattern) return false;
  if (a.matcher.kind === 'command' || b.matcher.kind === 'command') return true;
  const aActions = a.matcher.actions;
  const bActions = b.matcher.actions;
  if (!aActions || !bActions) return aActions === bActions;
  return (
    aActions.length === bActions.length && aActions.every((action) => bActions.includes(action))
  );
}

function addRules(
  ctx: ToolPermissionContext,
  source: PermissionRuleSource,
  values: readonly PermissionRuleValue[],
  behavior: PermissionBehavior,
): ToolPermissionContext {
  const existing = [...ctx.rules];

  for (const value of values) {
    // Deduplicate: skip if an identical rule already exists
    const duplicate = existing.some(
      (r) =>
        r.source === source && r.ruleBehavior === behavior && ruleValueEquals(r.ruleValue, value),
    );
    if (!duplicate) {
      existing.push({ source, ruleBehavior: behavior, ruleValue: value });
    }
  }

  logger.info(
    { source, behavior, added: values.length, totalAfter: existing.length },
    'Added permission rules',
  );

  return cloneContextWith(ctx, { rules: existing });
}

function replaceRules(
  ctx: ToolPermissionContext,
  source: PermissionRuleSource,
  values: readonly PermissionRuleValue[],
  behavior: PermissionBehavior,
): ToolPermissionContext {
  // Remove existing rules that match the given source + behavior
  const kept = ctx.rules.filter((r) => !(r.source === source && r.ruleBehavior === behavior));

  // Append the new rules
  const newRules = values.map((value) => ({
    source,
    ruleBehavior: behavior,
    ruleValue: value,
  }));

  logger.info(
    { source, behavior, removed: ctx.rules.length - kept.length, added: newRules.length },
    'Replaced permission rules',
  );

  return cloneContextWith(ctx, { rules: [...kept, ...newRules] });
}

function removeRules(
  ctx: ToolPermissionContext,
  source: PermissionRuleSource,
  values: readonly PermissionRuleValue[],
  behavior: PermissionBehavior,
): ToolPermissionContext {
  const remaining = ctx.rules.filter((r) => {
    if (r.source !== source || r.ruleBehavior !== behavior) return true;
    return !values.some((v) => ruleValueEquals(r.ruleValue, v));
  });

  logger.info(
    { source, behavior, removed: ctx.rules.length - remaining.length },
    'Removed permission rules',
  );

  return cloneContextWith(ctx, { rules: remaining });
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a tool has a whole-tool rule (no ruleContent) for a given behavior.
 *
 * Used in the engine's three-step flow to quickly determine if the entire tool
 * is in deny / ask / allow lists.
 */
export function hasWholeToolRule(
  ctx: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): PermissionRule | undefined {
  return ctx.rules.find(
    (r) =>
      r.ruleValue.toolName === toolName && r.ruleBehavior === behavior && !r.ruleValue.ruleContent,
  );
}

/**
 * Get all content-specific rules for a tool + behavior.
 * These are rules WITH ruleContent (not whole-tool rules).
 */
export function getContentRulesForTool(
  ctx: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): readonly PermissionRule[] {
  return ctx.rules.filter(
    (r) =>
      r.ruleValue.toolName === toolName &&
      r.ruleBehavior === behavior &&
      r.ruleValue.ruleContent !== undefined,
  );
}

/**
 * Check if the context is in bypass mode.
 */
export function isBypassMode(ctx: ToolPermissionContext): boolean {
  return ctx.mode === 'bypassPermissions';
}

/**
 * Check if a tool is registered as requiring user interaction.
 */
export function isInteractiveTool(ctx: ToolPermissionContext, toolName: string): boolean {
  return ctx.interactiveTools.has(toolName);
}
