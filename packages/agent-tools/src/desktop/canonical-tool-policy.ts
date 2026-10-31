import type { RuntimeTool } from '@mavis/agent-core/tools';

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

export function isCanonicalBuiltinTurn(canonicalRole?: string, builtinAgent?: boolean): boolean {
  return (
    builtinAgent === true && canonicalRole !== undefined && isCanonicalSubagentRole(canonicalRole)
  );
}
