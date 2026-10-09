import type { ResolvedAgentCapabilities } from '@mavis/config';

import {
  hasManagedAccountSession,
  resolveFeatureAwareBuiltinSkillNames,
} from '../agent/feature-owned-skills.js';
import type { LocalRuntimeSkillScope, LocalSkillCatalogScope } from '../skills/skill-service.js';
import { applyHostedCapabilityRestrictions } from './hosted-agent-capability-restrictions.js';
import { resolveHostedCuModeActive } from './hosted-agent-turn-runtime-facts.js';
import type {
  HostedAgentCapabilitiesHost,
  HostedAgentCapabilityRestrictions,
} from './hosted-agent-capabilities.js';

export interface HostedAgentSkillPolicy {
  readonly canonicalRole: string;
  readonly builtinAgent: boolean;
  readonly capabilities: ResolvedAgentCapabilities;
}

export interface HostedAgentSkillScope {
  readonly excludeAgentResources?: boolean;
  readonly expectedAgentInstanceId?: string;
  readonly skipAgentResolution?: boolean;
  readonly allowedSkillNames?: readonly string[];
  readonly allowedExtensionSkillNames?: readonly string[];
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly agentPolicy?: HostedAgentSkillPolicy;
  readonly miniappAvailable?: boolean;
}

export interface HostedAgentSkillCatalogScope extends HostedAgentSkillScope {
  readonly firstTurnSessionId?: string;
  readonly contextWindowTokens?: LocalSkillCatalogScope['contextWindowTokens'];
  readonly additionalSkills?: LocalSkillCatalogScope['additionalSkills'];
}

export function createHostedSkillCapabilities(
  host: HostedAgentCapabilitiesHost,
  restrictions: HostedAgentCapabilityRestrictions,
) {
  const resolvedScopes = new WeakMap<HostedAgentSkillScope, LocalSkillCatalogScope>();
  const resolveScope = (scope: HostedAgentSkillCatalogScope): LocalSkillCatalogScope => {
    const existing = resolvedScopes.get(scope);
    if (existing) return existing;
    const resolved = resolveHostedSkillCatalogScope(host, scope, restrictions);
    resolvedScopes.set(scope, resolved);
    return resolved;
  };
  return {
    listRuntimeSkills: async (scope: HostedAgentSkillScope) =>
      host.skillService.listRuntimeSkills(resolveScope(scope)),
    renderCatalog: async (scope: HostedAgentSkillCatalogScope) =>
      host.skillService.renderCatalog(resolveScope(scope)),
  } as const;
}

function resolveHostedSkillScope(
  host: HostedAgentCapabilitiesHost,
  scope: HostedAgentSkillScope,
  restrictions: HostedAgentCapabilityRestrictions,
): LocalRuntimeSkillScope {
  const base = {
    agentName: scope.agentName,
    workspaceDir: scope.workspaceDir,
    ...(scope.excludeAgentResources ? { excludeAgentResources: true } : {}),
    ...(scope.expectedAgentInstanceId
      ? { expectedAgentInstanceId: scope.expectedAgentInstanceId }
      : {}),
    ...(scope.skipAgentResolution ? { skipAgentResolution: true } : {}),
    ...(scope.allowedSkillNames === undefined
      ? {}
      : { allowedSkillNames: scope.allowedSkillNames }),
    ...(scope.allowedExtensionSkillNames === undefined
      ? {}
      : { allowedExtensionSkillNames: scope.allowedExtensionSkillNames }),
  };
  if (!scope.agentPolicy) return base;

  const config = host.configGetter();
  const capabilities = applyHostedCapabilityRestrictions(
    scope.agentPolicy.capabilities,
    restrictions,
  );
  const cuModeActive = resolveHostedCuModeActive(config, restrictions.disableComputerUse === true);
  return {
    ...base,
    builtinSkillNames: resolveFeatureAwareBuiltinSkillNames(capabilities, {
      cuModeActive,
      ...(scope.miniappAvailable === true ? { miniappAvailable: true } : {}),
      canonicalRole: scope.agentPolicy.canonicalRole,
      builtinAgent: scope.agentPolicy.builtinAgent,
      disabledSkillNames: restrictions.disabledBuiltinSkillNames,
      resumeCodexAvailable: restrictions.resumeCodexAvailable === true,
      websiteDeployAvailable: hasManagedAccountSession(host.authContextGetter?.()),
    }),
    cuModeActive,
  };
}

function resolveHostedSkillCatalogScope(
  host: HostedAgentCapabilitiesHost,
  scope: HostedAgentSkillCatalogScope,
  restrictions: HostedAgentCapabilityRestrictions,
): LocalSkillCatalogScope {
  const skillScope = resolveHostedSkillScope(host, scope, restrictions);
  return {
    ...skillScope,
    ...(scope.firstTurnSessionId !== undefined
      ? { firstTurnSessionId: scope.firstTurnSessionId }
      : {}),
    ...(scope.contextWindowTokens !== undefined
      ? { contextWindowTokens: scope.contextWindowTokens }
      : {}),
    ...(scope.additionalSkills !== undefined ? { additionalSkills: scope.additionalSkills } : {}),
  };
}
