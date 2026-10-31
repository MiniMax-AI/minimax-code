import { resolveCanonicalSubagentRole } from '@mavis/agent-tools/desktop/subagent-roles';
import type { LocalTaskRunResult, VerificationReport } from '@mavis/agent-tools/desktop';

import type { ModuleMetricsReporter } from '../common/metrics.js';

/**
 * Telemetry for the local Task/Agent compatibility boundary.
 *
 * The bus event keeps the product event name (with dots); the metrics side
 * uses the bare, Prometheus-compatible counter name. Both sides receive the
 * same bounded fields and are deliberately best-effort: an observability
 * failure must never change a task or Agent resolution result.
 */
export const SUBAGENT_TELEMETRY_EVENT = {
  resolve: 'subagent.resolve',
  nameCompatResolve: 'agent_name_compat.resolve',
  resourceAmbiguity: 'agent_name_compat.resource_ambiguity',
  agentRoleObservation: 'agent_role.observation',
  primaryProfileOverlay: 'agent_name_compat.primary_profile_overlay',
  toolPolicy: 'subagent.tool_policy',
  finish: 'subagent.finish',
} as const;

const SUBAGENT_TELEMETRY_METRIC = {
  [SUBAGENT_TELEMETRY_EVENT.resolve]: 'subagent_resolve_total',
  [SUBAGENT_TELEMETRY_EVENT.nameCompatResolve]: 'agent_name_compat_resolve_total',
  [SUBAGENT_TELEMETRY_EVENT.resourceAmbiguity]: 'agent_name_compat_resource_ambiguity_total',
  [SUBAGENT_TELEMETRY_EVENT.agentRoleObservation]: 'agent_role_observation_total',
  [SUBAGENT_TELEMETRY_EVENT.primaryProfileOverlay]: 'agent_primary_profile_overlay_total',
  [SUBAGENT_TELEMETRY_EVENT.toolPolicy]: 'subagent_tool_policy_total',
  [SUBAGENT_TELEMETRY_EVENT.finish]: 'subagent_finish_total',
} as const;

export type SubagentRoleClass = 'explore' | 'worker' | 'verifier' | 'other';
export type AgentResourceKind = 'memory' | 'skill' | 'cron' | 'channel';

type TelemetryValue = string | boolean | number;

export interface SubagentTelemetryHost {
  metrics?: ModuleMetricsReporter;
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void;
}

export function emitSubagentTelemetry(
  host: SubagentTelemetryHost | undefined,
  event: keyof typeof SUBAGENT_TELEMETRY_METRIC | string,
  fields: Readonly<Record<string, TelemetryValue>>,
): void {
  if (!host) return;
  const payload = { ...fields };
  try {
    host.emitBusEvent?.(event, payload);
  } catch {
    // Telemetry is observational and must never affect the product path.
  }
  const metricName = SUBAGENT_TELEMETRY_METRIC[event as keyof typeof SUBAGENT_TELEMETRY_METRIC];
  if (!metricName) return;
  try {
    host.metrics?.incr(metricName, toMetricTags(event, fields));
  } catch {
    // Metrics reporters are host-provided and may fail independently.
  }
}

export function emitResourceAmbiguityTelemetry(
  host: SubagentTelemetryHost | undefined,
  resourceKind: AgentResourceKind,
  memberCount: number | undefined,
): void {
  if (memberCount === undefined || !Number.isFinite(memberCount) || memberCount < 2) return;
  const bucket = memberCountBucket(memberCount);
  emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.resourceAmbiguity, {
    resource_kind: resourceKind,
    ...(bucket ? { member_count_bucket: bucket } : {}),
  });
}

export function roleClass(value: unknown): SubagentRoleClass {
  if (value === 'explore' || value === 'worker' || value === 'verifier') return value;
  return 'other';
}

export function memberCountBucket(value: number | undefined): '1' | '2' | '3+' | undefined {
  if (!Number.isFinite(value) || value === undefined || value < 1) return undefined;
  if (value === 1) return '1';
  if (value === 2) return '2';
  return '3+';
}

export function inferNameResolutionSource(requestedName: string, canonicalName?: string): string {
  const requested = requestedName.trim();
  if (requested.toLowerCase().startsWith('agent:')) return 'explicit_agent';
  if (resolveCanonicalSubagentRole(requested)) return 'canonical_name';
  if (requested.toLowerCase() === 'mavis' || requested.toLowerCase() === 'main') {
    return 'stable_name';
  }
  if (canonicalName && canonicalName !== requested) return 'display_name_compat';
  return 'stable_name';
}

export function telemetryErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown; errorCode?: unknown }).code;
  if (typeof code === 'string' && code.trim()) {
    const normalized = code.trim();
    return NAME_RESOLUTION_ERROR_CODES.has(normalized) ? normalized : 'other';
  }
  return undefined;
}

export function emitSubagentFinishTelemetry(
  host: SubagentTelemetryHost,
  role: unknown,
  runMode: 'foreground' | 'background',
  taskStatus: 'succeeded' | 'failed' | 'aborted' | undefined,
  terminalStatus: string,
  verification?: VerificationReport,
): void {
  emitSubagentTelemetry(host, SUBAGENT_TELEMETRY_EVENT.finish, {
    role_class: roleClass(role),
    run_mode: runMode,
    status: taskStatus ?? terminalStatusToTaskStatus(terminalStatus),
    ...(verification?.modelVerdict ? { model_verdict: verification.modelVerdict } : {}),
    ...(verification?.fileChange ? { file_change_observation: verification.fileChange } : {}),
  });
}

/**
 * Creates the one completion sink shared by foreground and background injected
 * task turns. The injected runner owns the terminal boundary; callers only
 * provide the host sink, resolved role, and delivery mode.
 */
export function createSubagentFinishTelemetrySink(
  host: SubagentTelemetryHost,
  role: unknown,
  runMode: 'foreground' | 'background',
): (result: Pick<LocalTaskRunResult, 'status' | 'verification'>) => void {
  return (result) => {
    emitSubagentFinishTelemetry(
      host,
      role,
      runMode,
      result.status,
      result.status === 'succeeded'
        ? 'finished'
        : result.status === 'aborted'
          ? 'aborted'
          : 'error',
      result.verification,
    );
  };
}

function terminalStatusToTaskStatus(status: string): 'succeeded' | 'failed' | 'aborted' {
  if (status === 'aborted' || status === 'interrupted') return 'aborted';
  if (status === 'finished') return 'succeeded';
  return 'failed';
}

const NAME_RESOLUTION_ERROR_CODES = new Set([
  'UNKNOWN_AGENT_NAME',
  'AGENT_NOT_FOUND',
  'AMBIGUOUS_AGENT_NAME',
  'BUILTIN_AGENT_NAME_CONFLICT',
  'CANONICAL_AGENT_NOT_AVAILABLE',
  'VALIDATION_ERROR',
  'PRIMARY_AGENT_IMMUTABLE',
  'BUILTIN_AGENT_IMMUTABLE',
]);

function metricKeysForEvent(event: string): readonly string[] {
  switch (event) {
    case SUBAGENT_TELEMETRY_EVENT.resourceAmbiguity:
      return ['resource_kind', 'member_count_bucket'];
    case SUBAGENT_TELEMETRY_EVENT.agentRoleObservation:
      return ['status', 'source', 'role_class'];
    case SUBAGENT_TELEMETRY_EVENT.toolPolicy:
      return ['role_class'];
    case SUBAGENT_TELEMETRY_EVENT.resolve:
      return ['source', 'success', 'error_code', 'plugin_origin'];
    case SUBAGENT_TELEMETRY_EVENT.nameCompatResolve:
      return [
        'intent',
        'canonical_class',
        'source',
        'member_count_bucket',
        'success',
        'error_code',
      ];
    default:
      return ['role_class', 'run_mode', 'status', 'model_verdict', 'file_change_observation'];
  }
}

function toMetricTags(
  event: string,
  fields: Readonly<Record<string, TelemetryValue>>,
): Record<string, string> {
  // Counts are exact on the dot-name bus event but intentionally omitted from
  // metric labels. A model/tool catalog can change size freely; putting the
  // raw counts in labels would create an unbounded metric series set.
  const metricKeys =
    event === SUBAGENT_TELEMETRY_EVENT.resourceAmbiguity
      ? ['resource_kind', 'member_count_bucket']
      : event === SUBAGENT_TELEMETRY_EVENT.agentRoleObservation
        ? ['status', 'source', 'role_class']
        : event === SUBAGENT_TELEMETRY_EVENT.toolPolicy
          ? ['role_class']
          : event === SUBAGENT_TELEMETRY_EVENT.resolve
            ? ['source', 'success', 'error_code']
            : event === SUBAGENT_TELEMETRY_EVENT.nameCompatResolve
              ? [
                  'intent',
                  'canonical_class',
                  'source',
                  'member_count_bucket',
                  'success',
                  'error_code',
                ]
              : ['role_class', 'run_mode', 'status', 'model_verdict', 'file_change_observation'];
  return Object.fromEntries(
    metricKeys.filter((key) => fields[key] !== undefined).map((key) => [key, String(fields[key])]),
  );
}
