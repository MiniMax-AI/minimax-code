import {
  AGENT_BUILTIN_SKILL_IDS,
  isAgentBuiltinToolEnabled,
  type AgentBuiltinSkillId,
  type ResolvedAgentCapabilities,
} from '@mavis/config';
import { isCanonicalSubagentRole } from '@mavis/agent-tools/desktop/subagent-roles';

import { CU_DESKTOP_SKILL_NAME } from '../cu/gate.js';

export function resolveFeatureAwareBuiltinSkillNames(
  capabilities: ResolvedAgentCapabilities,
  gates: {
    cuModeActive: boolean;
    resumeCodexAvailable?: boolean;
    /**
     * Whether the `website_deploy` tool is wired for this Turn. It publishes
     * through the managed MiniMax account gateway, so `false` (no account
     * session) also drops the Skills that only make sense with that tool.
     * Left undefined, the capability config alone decides.
     */
    websiteDeployAvailable?: boolean;
    miniappAvailable?: boolean;
    canonicalRole?: string;
    builtinAgent?: boolean;
    disabledSkillNames?: readonly AgentBuiltinSkillId[];
  },
): string[] {
  const configuredSkills = capabilities.skills ?? AGENT_BUILTIN_SKILL_IDS;
  const selected = new Set<string>(
    configuredSkills.filter((skillName) => isStandaloneSkillUsable(skillName, capabilities)),
  );

  if (capabilities.features.mavis) {
    selected.add('mavis');
    selected.add('create-agent');
    selected.add('minimax-code-product');
  }
  if (
    gates.miniappAvailable === true &&
    hasTools(capabilities, ['read', 'write', 'edit', 'bash'])
  ) {
    selected.add('miniapp-creator');
  }
  const canonicalBuiltinReadonly =
    gates.builtinAgent === true &&
    gates.canonicalRole !== undefined &&
    isCanonicalSubagentRole(gates.canonicalRole) &&
    (gates.canonicalRole === 'explore' || gates.canonicalRole === 'verifier');
  if (gates.cuModeActive && !canonicalBuiltinReadonly) selected.add(CU_DESKTOP_SKILL_NAME);
  if (gates.resumeCodexAvailable === true && isAgentBuiltinToolEnabled(capabilities, 'bash')) {
    selected.add('resume-codex');
  }
  if (gates.websiteDeployAvailable === false) {
    selected.delete('deploy-website');
    selected.delete('edit-deployed-website');
  }
  for (const skillName of gates.disabledSkillNames ?? []) selected.delete(skillName);
  return [...selected];
}

function isStandaloneSkillUsable(
  skillName: AgentBuiltinSkillId,
  capabilities: ResolvedAgentCapabilities,
): boolean {
  switch (skillName) {
    case 'code-review':
      return isAgentBuiltinToolEnabled(capabilities, 'read');
    case 'deep-research':
      return (
        hasTools(capabilities, ['read', 'write', 'todowrite']) &&
        (capabilities.features.webSearch ||
          isAgentBuiltinToolEnabled(capabilities, 'web_fetch') ||
          isAgentBuiltinToolEnabled(capabilities, 'bash'))
      );
    case 'deploy-website':
      return hasTools(capabilities, ['read', 'write', 'bash', 'website_deploy']);
    case 'edit-deployed-website':
      return hasTools(capabilities, ['read', 'edit', 'bash', 'website_deploy']);
    case 'docx':
    case 'pdf':
    case 'pptx':
    case 'xlsx':
      return hasTools(capabilities, ['read', 'write', 'bash']);
    case 'init':
    case 'plugin-creator':
    case 'skill-creator':
      return hasTools(capabilities, ['read', 'write', 'bash']);
    case 'lark-tools':
    case 'llm-call':
    case 'mcode-tools-master':
    case 'mavis-doctor':
      return isAgentBuiltinToolEnabled(capabilities, 'bash');
    case 'skill-refiner':
      return hasTools(capabilities, ['read', 'edit']);
    case 'visual-page':
      return isAgentBuiltinToolEnabled(capabilities, 'write');
    case 'x-link-reader':
      return isAgentBuiltinToolEnabled(capabilities, 'web_fetch');
  }
  return false;
}

function hasTools(
  capabilities: ResolvedAgentCapabilities,
  toolNames: Parameters<typeof isAgentBuiltinToolEnabled>[1][],
): boolean {
  return toolNames.every((toolName) => isAgentBuiltinToolEnabled(capabilities, toolName));
}

/** True when the host holds a MiniMax account session that can call the managed gateway. */
export function hasManagedAccountSession(
  authContext: { accessToken?: string } | undefined,
): boolean {
  return Boolean(authContext?.accessToken?.trim());
}
