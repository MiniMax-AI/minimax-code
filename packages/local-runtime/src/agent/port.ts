import {
  resolveCanonicalSubagentRole,
  type CanonicalSubagentRole,
} from '@mavis/agent-tools/desktop/subagent-roles';
import type { LocalPluginAgentDefinition } from '@mavis/agent-tools/desktop';
import type { AgentReferenceReadScope, AgentReferenceResolver } from '@mavis/shared';

export type { AgentReferenceReadScope, AgentReferenceResolver } from '@mavis/shared';

/** Private execution facts composed from the four neutral Agent intents. */
export interface LocalTaskTargetFacts {
  readonly requestedName: string;
  readonly exactOwnerName: string;
  readonly resolvedAgentName: string;
  readonly canonicalViewName: string;
  readonly canonicalRole?: CanonicalSubagentRole;
  readonly trustedBuiltin: boolean;
  readonly source: AgentReferenceReadScope['source'] | 'plugin';
  /** Present only when the target came from the parent Turn's Plugin Agent lease. */
  readonly pluginAgent?: LocalPluginAgentDefinition;
}

/**
 * Resolve one Task target using one read scope + write target + execution
 * target decision. No role is inferred from a manual/reserved name: the role
 * is emitted only when the scope itself is trusted bundled data.
 */
export async function resolveTaskTarget(
  resolver: AgentReferenceResolver,
  requestedName: string,
): Promise<LocalTaskTargetFacts> {
  const requested = requestedName.trim();
  const [scope, writeTarget] = await Promise.all([
    resolver.resolveAgentReadScope(requested),
    resolver.resolveAgentWriteTarget(requested),
  ]);
  const exactOwnerName = await resolver.requireExactAgentKey(
    scope.exactOwnerName?.trim() || writeTarget,
  );
  const resolvedAgentName = await resolver.resolveAgentExecutionTarget(exactOwnerName);
  const trustedBuiltin = scope.trustedBuiltin === true;
  const canonicalRole = trustedBuiltin
    ? resolveCanonicalSubagentRole(scope.canonicalName)
    : undefined;
  return {
    requestedName: requested,
    exactOwnerName,
    resolvedAgentName,
    canonicalViewName: scope.canonicalName,
    ...(canonicalRole ? { canonicalRole } : {}),
    trustedBuiltin,
    source: scope.source,
  };
}
