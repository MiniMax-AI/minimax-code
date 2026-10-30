import type { LocalPluginAgentRoster } from '@mavis/agent-tools/desktop';
import {
  resolveTaskTarget,
  type AgentReferenceResolver,
  type LocalTaskTargetFacts,
} from '../../agent/index.js';
import {
  SUBAGENT_TELEMETRY_EVENT,
  emitSubagentTelemetry,
  inferNameResolutionSource,
  telemetryErrorCode,
} from '../../agent/index.js';
import type { ModuleMetricsReporter } from '../../../infra/logging/metrics.js';

export interface LocalTaskAgentResolverHost {
  agentResolver: AgentReferenceResolver;
  metrics?: ModuleMetricsReporter;
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void;
}

/**
 * Built-in owner that stores Plugin Agent Task Sessions; the frozen definition is authoritative.
 * @internal Exported only for focused tests.
 */
export const PLUGIN_AGENT_STORAGE_OWNER = 'worker';

export async function resolveLocalTaskAgentTarget(
  host: LocalTaskAgentResolverHost,
  agentName: string | undefined,
  pluginAgents?: LocalPluginAgentRoster,
): Promise<LocalTaskTargetFacts | undefined> {
  if (!agentName) return undefined;
  const requested = agentName.trim();
  if (!requested) return undefined;
  const explicitAgent = requested.toLowerCase().startsWith('agent:');
  // Custom Agent display names may contain `:`; only a roster hit claims the name.
  const scoped = resolveScopedPluginAgent(requested, pluginAgents);
  if (scoped) return resolvePluginTarget(host, requested, scoped);

  let source = inferNameResolutionSource(requested);
  try {
    const resolved = await resolveTaskTarget(host.agentResolver, requested);
    source = inferNameResolutionSource(requested, resolved.resolvedAgentName);
    emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, { source, success: true });
    return resolved;
  } catch (error) {
    if (isUnknownAgentError(error) && !explicitAgent) {
      const bare = uniqueBarePluginAgent(pluginAgents, requested);
      if (bare) return resolvePluginTarget(host, requested, bare);
    }
    emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, {
      source,
      success: false,
      ...(telemetryErrorCode(error) ? { error_code: telemetryErrorCode(error)! } : {}),
    });
    if (isUnknownAgentError(error)) return undefined;
    throw error;
  }
}

/** Session creation fields for a resolved Task target. */
export function taskSessionOwner(target: LocalTaskTargetFacts): {
  readonly agentName: string;
  readonly pluginAgentDefinition?: NonNullable<LocalTaskTargetFacts['pluginAgent']>;
} {
  if (!target.pluginAgent) return { agentName: target.resolvedAgentName };
  return { agentName: PLUGIN_AGENT_STORAGE_OWNER, pluginAgentDefinition: target.pluginAgent };
}

function resolvePluginTarget(
  host: LocalTaskAgentResolverHost,
  requested: string,
  agent: ReturnType<LocalPluginAgentRoster['resolve']>,
): LocalTaskTargetFacts | undefined {
  emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, {
    source: 'plugin',
    success: agent !== undefined,
    ...(agent?.origin ? { plugin_origin: agent.origin } : {}),
    ...(agent ? {} : { error_code: 'UNKNOWN_AGENT_NAME' }),
  });
  if (!agent) return undefined;
  return {
    requestedName: requested,
    exactOwnerName: agent.scopedName,
    resolvedAgentName: agent.scopedName,
    canonicalViewName: agent.scopedName,
    trustedBuiltin: false,
    source: 'plugin',
    pluginAgent: agent,
  };
}

function resolveScopedPluginAgent(
  requested: string,
  pluginAgents: LocalPluginAgentRoster | undefined,
): ReturnType<LocalPluginAgentRoster['resolve']> {
  if (requested.toLowerCase().startsWith('agent:') || !requested.includes(':')) return undefined;
  return pluginAgents?.resolve(requested);
}

function uniqueBarePluginAgent(
  pluginAgents: LocalPluginAgentRoster | undefined,
  requested: string,
): ReturnType<LocalPluginAgentRoster['resolve']> {
  if (!pluginAgents) return undefined;
  const key = requested.normalize('NFKC').toLowerCase();
  const matches = pluginAgents
    .list()
    .filter((agent) => agent.agentName.normalize('NFKC').toLowerCase() === key);
  return matches.length === 1 ? matches[0] : undefined;
}

function isUnknownAgentError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'UNKNOWN_AGENT_NAME' || code === 'AGENT_NOT_FOUND';
}
