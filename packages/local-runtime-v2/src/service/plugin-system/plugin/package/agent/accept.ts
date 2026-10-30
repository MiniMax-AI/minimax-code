import { buildPluginSkillRuntimeName } from '@mavis/shared';

import type { CanonicalAgentConfig } from '../../../../agent/storage/canonical-agent-config.js';
import { readPluginTextFile, type CanonicalPluginRoot } from '../filesystem.js';
import { readerFail } from '../reader-errors.js';
import type {
  PluginAgent,
  PluginAgentSourceFormat,
  PluginReaderDiagnostic,
  PluginSkill,
} from '../types.js';

const MAX_AGENT_FILE_BYTES = 1024 * 1024;
const MAX_SCOPED_NAME_LENGTH = 64;
/** `agent:<name>` already addresses Custom Agents in Task targets. */
const RESERVED_PLUGIN_NAMESPACE = 'agent';
const NAME_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const USER_CONFIG_REFERENCE = '${user_config.';

export interface PluginAgentReadResult {
  readonly agents: readonly PluginAgent[];
  readonly diagnostics: readonly PluginReaderDiagnostic[];
}

export interface PluginAgentReadContext {
  readonly pluginName: string;
  readonly skills: readonly PluginSkill[];
}

export interface AgentCandidate {
  readonly segments: readonly string[];
  readonly sourceFormat: PluginAgentSourceFormat;
  readonly agentPath: string;
  readonly agentFilePath: string;
  readonly content: string;
  readonly config: AgentCandidateConfig;
}

export type AgentCandidateConfig = Omit<CanonicalAgentConfig, 'name' | 'diagnostics' | 'xMavis'> & {
  readonly displayName?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly extensionSkills?: readonly string[];
};

export function agentDiagnostic(code: string, name: string): PluginReaderDiagnostic {
  return { code, capability: 'AGENT', name };
}

export async function readAgentMarkdown(
  root: CanonicalPluginRoot,
  agentPath: string,
  options: { readonly portable?: boolean } = {},
): Promise<{ path: string; content: string }> {
  const file = await readPluginTextFile(root, agentPath, options);
  if (Buffer.byteLength(file.content, 'utf8') > MAX_AGENT_FILE_BYTES) {
    readerFail('AGENT_SCHEMA_INVALID', `${agentPath} exceeds the Agent file limit`);
  }
  return file;
}

/**
 * Applies the Plugin-wide identity rules shared by every source format:
 * `<plugin>:<segments>` scoped names, the reserved namespace, length and
 * character limits, and case-insensitive first-wins de-duplication by path.
 */
export function acceptPluginAgents(
  context: PluginAgentReadContext,
  candidates: readonly AgentCandidate[],
  diagnostics: PluginReaderDiagnostic[],
): PluginAgentReadResult {
  if (candidates.length === 0) return { agents: [], diagnostics };
  if (context.pluginName.trim().toLowerCase() === RESERVED_PLUGIN_NAMESPACE) {
    diagnostics.push(agentDiagnostic('AGENT_NAMESPACE_RESERVED', context.pluginName));
    return { agents: [], diagnostics };
  }
  const agents: PluginAgent[] = [];
  const seen = new Set<string>();
  const ordered = [...candidates].sort((left, right) =>
    left.agentPath.localeCompare(right.agentPath),
  );
  for (const candidate of ordered) {
    const agent = acceptPluginAgent(context, candidate, diagnostics);
    if (!agent) continue;
    const key = agent.scopedName.normalize('NFKC').toLowerCase();
    if (seen.has(key)) {
      diagnostics.push(agentDiagnostic('AGENT_DUPLICATE', agent.scopedName));
      continue;
    }
    seen.add(key);
    agents.push(agent);
  }
  return { agents, diagnostics };
}

function acceptPluginAgent(
  context: PluginAgentReadContext,
  candidate: AgentCandidate,
  diagnostics: PluginReaderDiagnostic[],
): PluginAgent | undefined {
  const segments = [context.pluginName.trim(), ...candidate.segments];
  if (segments.some((segment) => !NAME_SEGMENT.test(segment))) {
    diagnostics.push(agentDiagnostic('AGENT_NAME_INVALID', candidate.agentPath));
    return undefined;
  }
  const scopedName = segments.join(':');
  if (scopedName.length > MAX_SCOPED_NAME_LENGTH) {
    diagnostics.push(agentDiagnostic('AGENT_SCOPED_NAME_TOO_LONG', candidate.agentPath));
    return undefined;
  }
  if (candidate.config.systemPrompt.includes(USER_CONFIG_REFERENCE)) {
    diagnostics.push(agentDiagnostic('AGENT_USER_CONFIG_UNSUPPORTED', candidate.agentPath));
  }
  const { skills, extensionSkills, ...config } = candidate.config;
  return Object.freeze({
    name: candidate.segments.join(':'),
    scopedName,
    sourceFormat: candidate.sourceFormat,
    content: candidate.content,
    agentFilePath: candidate.agentFilePath,
    ...config,
    ...pluginSkillSelectors(context, skills, extensionSkills),
  });
}

/**
 * `skills` is an allowlist. A Plugin Skill is readable only when both
 * `skills` and `extensionSkills` admit its runtime name, so same-Plugin names
 * are rewritten to that runtime name in both lists.
 */
function pluginSkillSelectors(
  context: PluginAgentReadContext,
  skills: readonly string[] | undefined,
  extensionSkills: readonly string[] | undefined,
): Pick<PluginAgent, 'skills' | 'extensionSkills'> {
  if (skills === undefined) {
    return extensionSkills === undefined ? {} : { extensionSkills };
  }
  const packageSkills = new Map(
    context.skills.map((skill) => [skill.name.trim().toLowerCase(), skill.name]),
  );
  const selected: string[] = [];
  const mapped: string[] = [...(extensionSkills ?? [])];
  for (const name of skills) {
    const packageSkill = packageSkills.get(name.trim().toLowerCase());
    if (!packageSkill) {
      selected.push(name);
      continue;
    }
    const runtimeName = buildPluginSkillRuntimeName(context.pluginName, packageSkill);
    selected.push(runtimeName);
    mapped.push(runtimeName);
  }
  return {
    skills: Object.freeze([...new Set(selected)]),
    extensionSkills: Object.freeze([...new Set(mapped)]),
  };
}
