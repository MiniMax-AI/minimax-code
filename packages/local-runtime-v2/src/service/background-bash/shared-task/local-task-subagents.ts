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
import type { LocalTaskRunnerHost } from '../task-host-contracts.js';

export interface LocalTaskAgentResolverHost {
  agentResolver: AgentReferenceResolver;
  agentRoutes?: Pick<LocalTaskRunnerHost['agentRoutes'], 'getLocalAgent'>;
  metrics?: ModuleMetricsReporter;
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void;
}

/**
 * The resolved Task target exists but its canonical `agent.md` sets
 * `x-mavis.dispatchable: false`. Task-tool only: every other session-creating
 * flow (assignment_create, Goal, cron, team) never resolves a target here.
 */
export class TaskDispatchNotAllowedError extends Error {
  readonly code = 'AGENT_NOT_DISPATCHABLE';

  constructor(readonly agentName: string) {
    super(`Agent ${agentName} cannot be dispatched as a task`);
    this.name = 'TaskDispatchNotAllowedError';
  }
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
    await assertTaskTargetDispatchable(host, resolved);
    source = inferNameResolutionSource(requested, resolved.resolvedAgentName);
    emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, { source, success: true });
    return snapshotAgentDisplayName(host, resolved);
  } catch (error) {
    if (isUnknownAgentError(error) && !explicitAgent) {
      const bare = uniqueBarePluginAgent(pluginAgents, requested);
      if (bare) return resolvePluginTarget(host, requested, bare);
    }
    const errorCode = telemetryErrorCode(error);
    emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resolve, {
      source,
      success: false,
      ...(errorCode ? { error_code: errorCode } : {}),
    });
    if (isUnknownAgentError(error)) return undefined;
    throw error;
  }
}

async function snapshotAgentDisplayName(
  host: LocalTaskAgentResolverHost,
  target: LocalTaskTargetFacts,
): Promise<LocalTaskTargetFacts> {
  try {
    // The explicit prefix keeps this lookup on the resolved owner if a display
    // name happens to equal a different Agent's stable key.
    const record = await host.agentRoutes?.getLocalAgent?.(`agent:${target.exactOwnerName}`, {
      includeContent: false,
    });
    const agentDisplayName = record?.displayName?.trim();
    return agentDisplayName ? { ...target, agentDisplayName } : target;
  } catch {
    // Missing presentation metadata must never block Task execution.
    return target;
  }
}

/**
 * Rejects a Task target whose current `agent.md` disables dispatch. Read through
 * the resolver on every call, so a user edit takes effect without a restart.
 * An absent or `undefined` answer keeps the contract default (dispatchable).
 */
async function assertTaskTargetDispatchable(
  host: LocalTaskAgentResolverHost,
  target: LocalTaskTargetFacts,
): Promise<void> {
  const dispatchable = await host.agentResolver.resolveAgentDispatchable?.(target.exactOwnerName);
  if (dispatchable === false) throw new TaskDispatchNotAllowedError(target.resolvedAgentName);
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
  const agentDisplayName = agent.displayName?.trim();
  return {
    requestedName: requested,
    exactOwnerName: agent.scopedName,
    resolvedAgentName: agent.scopedName,
    ...(agentDisplayName ? { agentDisplayName } : {}),
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
