export interface ManagedBackendRoutingContext {
  bedrockLane?: string;
}

const LANE_PATTERN = /^[A-Za-z0-9._-]+$/u;

/** Managed routing only applies to the internal build environments. */
const MANAGED_ROUTING_BUILD_ENVS = new Set(['dev', 'test', 'staging']);

/** Environment variable that supplies the managed backend lane when no explicit lane is given. */
export const MANAGED_BACKEND_LANE_ENV_VAR = 'MAVIS_MANAGED_BACKEND_LANE';

export function normalizeManagedBackendRoutingContext(
  value: unknown,
  buildEnv?: string,
): ManagedBackendRoutingContext | undefined {
  if (!isManagedRoutingBuildEnv(buildEnv)) return undefined;
  const lane = typeof value === 'string' ? value.trim() : '';
  return lane && LANE_PATTERN.test(lane) ? { bedrockLane: lane } : undefined;
}

export function managedBackendRoutingHeaders(
  context: ManagedBackendRoutingContext | undefined,
  buildEnv?: string,
): Record<string, string> {
  if (!isManagedRoutingBuildEnv(buildEnv)) return {};
  const lane = context?.bedrockLane?.trim();
  return lane && LANE_PATTERN.test(lane) ? { 'bedrock-lane': lane, bedrock_lane: lane } : {};
}

/**
 * Resolve the managed backend lane from the environment variable.
 *
 * The variable is an alternative source for the lane, so it fails closed: an unsupported build
 * environment or an unusable value yields no lane instead of raising an error.
 */
export function resolveManagedBackendLaneFromEnv(
  env: Record<string, string | undefined>,
  buildEnv?: string,
): string | undefined {
  return normalizeManagedBackendRoutingContext(env[MANAGED_BACKEND_LANE_ENV_VAR], buildEnv)
    ?.bedrockLane;
}

export function isManagedRoutingBuildEnv(buildEnv: string | undefined): boolean {
  return buildEnv !== undefined && MANAGED_ROUTING_BUILD_ENVS.has(buildEnv);
}
