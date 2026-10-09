import type { RuntimeTool } from '@mavis/agent-core/tools';

import { MatrixWebSearchToolDef } from '../cloud/matrix-tools/tool-defs.js';
import { isCanonicalSubagentRole } from './subagent-roles.js';

/**
 * Starting a task and continuing one are the same delegation entry point, so
 * `task_append` is gated with `task` rather than with the read-only handles.
 */
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set(['task', 'task_append']);
const READ_ONLY_CANONICAL_BLOCKED_TOOL_NAMES = new Set([
  'write',
  'edit',
  'website_deploy',
  'todowrite',
  'task',
  'task_append',
  'memory',
  'ask_user',
  'request_feature_enable',
]);

/**
 * Whether the canonical read-only ceiling (Explore/Verifier) removes this tool.
 * Exposed so a runtime guard can treat a call that still arrives as a violation
 * without keeping its own copy of the list.
 */
export function isReadOnlyCanonicalBlockedToolName(name: string): boolean {
  return READ_ONLY_CANONICAL_BLOCKED_TOOL_NAMES.has(name) || isComputerUseRuntimeToolName(name);
}

/** Computer-use tools share the desktop_* namespace across native and MCP paths. */
export function isComputerUseRuntimeToolName(name: string): boolean {
  return name.startsWith('desktop_');
}

/**
 * Apply the canonical built-in role ceiling to an already capability-filtered
 * native tool list. This helper is intentionally pure so V1 and V2 catalog
 * owners cannot drift on Explore/Verifier/Worker semantics.
 */
export function filterCanonicalNativeToolCeiling<T extends RuntimeTool>(
  tools: readonly T[],
  canonicalRole?: string,
  builtinAgent = false,
): T[] {
  if (!builtinAgent || !canonicalRole || !isCanonicalSubagentRole(canonicalRole)) {
    return [...tools];
  }
  if (canonicalRole === 'worker') {
    return tools.filter((tool) => !DELEGATION_TOOL_NAMES.has(tool.def.name));
  }
  return tools.filter(
    (tool) =>
      !READ_ONLY_CANONICAL_BLOCKED_TOOL_NAMES.has(tool.def.name) &&
      !isComputerUseRuntimeToolName(tool.def.name) &&
      (canonicalRole !== 'explore' ||
        !['task_query', 'task_output', 'task_stop'].includes(tool.def.name)),
  );
}

/**
 * Apply the canonical builtin role MCP ceiling to source-tagged entries.
 * Explore and Verifier retain only Matrix web search; Worker and custom or
 * untrusted agents retain the configured entry set.
 */
export function filterCanonicalBuiltinMcpEntries<
  T extends { readonly source: string; readonly tool: RuntimeTool },
>(entries: readonly T[], canonicalRole?: string, builtinAgent?: boolean): T[] {
  if (
    builtinAgent !== true ||
    canonicalRole === undefined ||
    !isCanonicalSubagentRole(canonicalRole) ||
    (canonicalRole !== 'explore' && canonicalRole !== 'verifier')
  ) {
    return [...entries];
  }
  return entries.filter(
    (entry) =>
      entry.source === 'builtin-matrix' && entry.tool.def.name === MatrixWebSearchToolDef.name,
  );
}

export function isCanonicalBuiltinTurn(canonicalRole?: string, builtinAgent?: boolean): boolean {
  return (
    builtinAgent === true && canonicalRole !== undefined && isCanonicalSubagentRole(canonicalRole)
  );
}
