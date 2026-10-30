import type { PluginReaderDiagnostic } from '../types.js';
import { agentDiagnostic } from './accept.js';

/** Compatible Plugin Agent fields that Desktop deliberately does not honour. */
const IGNORED_FIELDS = new Set([
  'hooks',
  'mcpServers',
  'permissionMode',
  'maxTurns',
  'memory',
  'background',
  'isolation',
  'color',
  'initialPrompt',
]);
const KNOWN_FIELDS = new Set([
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'effort',
  'skills',
  ...IGNORED_FIELDS,
]);
const NATIVE_TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['read', 'read'],
  ['write', 'write'],
  ['edit', 'edit'],
  ['multiedit', 'edit'],
  ['bash', 'bash'],
  ['grep', 'grep'],
  ['glob', 'glob'],
  ['webfetch', 'web_fetch'],
  ['web_fetch', 'web_fetch'],
  ['websearch', 'web_search'],
  ['web_search', 'web_search'],
  ['todowrite', 'todowrite'],
  ['skill', 'skill'],
]);
/** Plugin Agents cannot delegate further. */
const DELEGATION_TOOLS = new Set(['agent', 'task']);

export interface CompatibleAgentFields {
  readonly name?: string;
  readonly description: string;
  readonly effort?: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly skills?: readonly string[];
}

export class CompatibleAgentFieldError extends Error {
  constructor(readonly field: string) {
    super(`Compatible Plugin Agent field ${field} is invalid`);
    this.name = 'CompatibleAgentFieldError';
  }
}

/**
 * Normalizes compatible Plugin Agent frontmatter into the Custom Agent selector
 * encoding. `model` always inherits; Desktop never resolves foreign aliases.
 */
export function normalizeCompatibleAgentFrontmatter(
  frontmatter: Readonly<Record<string, unknown>>,
  agentPath: string,
): { readonly fields: CompatibleAgentFields; readonly diagnostics: PluginReaderDiagnostic[] } {
  const diagnostics: PluginReaderDiagnostic[] = [];
  const description = optionalText(frontmatter, 'description');
  if (!description) throw new CompatibleAgentFieldError('description');
  const name = optionalText(frontmatter, 'name');
  const effort = optionalText(frontmatter, 'effort');
  const tools = mapTools(frontmatter, 'tools', agentPath, diagnostics);
  const disallowedTools = mapTools(frontmatter, 'disallowedTools', agentPath, diagnostics);
  const skills = toolList(frontmatter, 'skills');
  if (skills !== undefined) diagnostics.push(agentDiagnostic('AGENT_SKILLS_ALLOWLIST', agentPath));
  diagnostics.push(...fieldDiagnostics(frontmatter, agentPath));
  return {
    fields: {
      ...(name ? { name: name.trim() } : {}),
      description,
      ...(effort ? { effort: effort.trim() } : {}),
      ...(tools === undefined ? {} : { tools }),
      ...(disallowedTools === undefined ? {} : { disallowedTools }),
      ...(skills === undefined ? {} : { skills }),
    },
    diagnostics,
  };
}

function fieldDiagnostics(
  frontmatter: Readonly<Record<string, unknown>>,
  agentPath: string,
): PluginReaderDiagnostic[] {
  const diagnostics: PluginReaderDiagnostic[] = [];
  if (frontmatter.model !== undefined && frontmatter.model !== 'inherit') {
    diagnostics.push(agentDiagnostic('AGENT_FIELD_IGNORED', `${agentPath}#model`));
  }
  for (const field of Object.keys(frontmatter)) {
    if (IGNORED_FIELDS.has(field)) {
      diagnostics.push(agentDiagnostic('AGENT_FIELD_IGNORED', `${agentPath}#${field}`));
    } else if (!KNOWN_FIELDS.has(field)) {
      diagnostics.push(agentDiagnostic('unsupported_agent_field', `${agentPath}#${field}`));
    }
  }
  return diagnostics;
}

function mapTools(
  frontmatter: Readonly<Record<string, unknown>>,
  field: 'tools' | 'disallowedTools',
  agentPath: string,
  diagnostics: PluginReaderDiagnostic[],
): readonly string[] | undefined {
  const declared = toolList(frontmatter, field);
  if (declared === undefined) return undefined;
  const mapped: string[] = [];
  let recognized = 0;
  for (const entry of declared) {
    // `Bash(git push *)` narrows a tool by argument; Desktop selectors are whole-tool.
    const toolName = entry.replace(/\(.*\)$/su, '').trim();
    const key = toolName.toLowerCase();
    const native = NATIVE_TOOL_ALIASES.get(key);
    if (native) {
      recognized += 1;
      mapped.push(native);
    } else if (key.startsWith('mcp__')) {
      recognized += 1;
      mapped.push(toolName);
    } else {
      if (DELEGATION_TOOLS.has(key)) recognized += 1;
      diagnostics.push(agentDiagnostic('AGENT_TOOL_IGNORED', `${agentPath}#${field}:${toolName}`));
    }
  }
  if (field === 'tools' && declared.length > 0 && recognized === 0) {
    throw new CompatibleAgentFieldError(field);
  }
  return Object.freeze([...new Set(mapped)]);
}

/** Accepts a comma-separated string or a YAML list; a blank string inherits. */
function toolList(
  frontmatter: Readonly<Record<string, unknown>>,
  field: string,
): readonly string[] | undefined {
  const value = frontmatter[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const items = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length === 0 ? undefined : items;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.map((item: string) => item.trim()).filter(Boolean);
  }
  throw new CompatibleAgentFieldError(field);
}

function optionalText(
  frontmatter: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = frontmatter[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
