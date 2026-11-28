import type { ToolPermissionContext } from './context.js';
import type { PermissionBehavior, PermissionDecision, PermissionRule } from './types.js';

/**
 * Source metadata of one MCP tool call. Agent calls only carry the assigned runtime name
 * (`mcp__<server>__<tool>`); a host that knows where the server came from passes this subject so
 * rules also match by identity `(plugin, declared server, tool)`.
 */
export interface McpToolRuleSubject {
  /** Plugin that owns the server; omitted for a user-configured server (identity = config name). */
  readonly plugin?: string;
  /** Declared server name (`*.mcp.json` key) or the user config name. */
  readonly server: string;
  /** Raw MCP tool name. */
  readonly tool: string;
  /**
   * `false` for a preview-tier target: it shares the installed server's names, so an allow it may
   * use is only one granted in its own session; any other allow becomes ask.
   */
  readonly inheritAllow?: boolean;
}

export const MCP_PLUGIN_RULE_PREFIX = 'mcp-plugin:';

/** Category on the ask produced when a preview target meets an allow it may not inherit. */
export const MCP_ALLOW_NOT_INHERITED = 'mcpAllowNotInherited';

/**
 * Rule key matching by identity: `mcp-plugin:<plugin>/<server>` (server level) or
 * `mcp-plugin:<plugin>/<server>/<tool>`. Segments are URI-encoded so `/` stays unambiguous.
 */
export function mcpPluginRuleKey(plugin: string, server: string, tool?: string): string {
  const head = `${MCP_PLUGIN_RULE_PREFIX}${encodeURIComponent(plugin)}/${encodeURIComponent(server)}`;
  return tool === undefined ? head : `${head}/${encodeURIComponent(tool)}`;
}

/**
 * Rule matched through the subject's identity keys (never through the call's runtime name, which
 * the caller checks first with the existing whole-tool / server-level helpers).
 */
export function findMcpSubjectRule(
  subject: McpToolRuleSubject | undefined,
  context: ToolPermissionContext,
  behavior: PermissionBehavior,
): PermissionRule | undefined {
  if (!subject?.plugin) return undefined;
  const identityKeys = new Set([
    mcpPluginRuleKey(subject.plugin, subject.server),
    mcpPluginRuleKey(subject.plugin, subject.server, subject.tool),
  ]);
  return context.rules.find(
    (rule) =>
      rule.ruleBehavior === behavior &&
      !rule.ruleValue.ruleContent &&
      identityKeys.has(rule.ruleValue.toolName),
  );
}

/**
 * Allow step: rules keyed by the runtime name (`findNameRule`), then by identity. A target that
 * must not inherit allow (preview tier) only uses an allow granted in its own session; when only
 * another allow matches, the call degrades to ask.
 */
export function decideMcpAllow(
  subject: McpToolRuleSubject | undefined,
  context: ToolPermissionContext,
  findNameRule: (context: ToolPermissionContext) => PermissionRule | undefined,
): PermissionDecision | undefined {
  const find = (scope: ToolPermissionContext) =>
    findNameRule(scope) ?? findMcpSubjectRule(subject, scope, 'allow');
  if (subject?.inheritAllow !== false) {
    const rule = find(context);
    return rule ? { behavior: 'allow', reason: { type: 'rule', rule } } : undefined;
  }
  const own = find({
    ...context,
    rules: context.rules.filter(
      (rule) => rule.ruleBehavior !== 'allow' || rule.source === 'session',
    ),
  });
  if (own) return { behavior: 'allow', reason: { type: 'rule', rule: own } };
  const inherited = find(context);
  if (!inherited) return undefined;
  return {
    behavior: 'ask',
    reason: {
      type: 'safetyCheck',
      description: `Allow rule "${inherited.ruleValue.toolName}" is not inherited by a preview MCP server`,
      category: MCP_ALLOW_NOT_INHERITED,
    },
    skipAutoClassifier: true,
  };
}
