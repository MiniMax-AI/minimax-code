import type { BashEnvPolicy } from '@mavis/agent-core/bash-subprocess-env';

/**
 * In-process permission execution metadata. The carrier is deliberately a
 * non-enumerable symbol so it never enters the model-visible Bash schema or
 * serialized tool arguments.
 */
const LOCAL_PERMISSION_EXECUTION_PLAN = Symbol.for('@mavis/permission/execution-plan');

type PermissionExecutionPlanCarrier = {
  [LOCAL_PERMISSION_EXECUTION_PLAN]?: unknown;
};

export type LocalPermissionExecutionPlan = Readonly<{
  nativeDelete?: boolean;
}>;

/** Local hosts resolve deletion policy from the approved invocation when present. */
export type LocalBashEnvPolicySource =
  | BashEnvPolicy
  | ((plan?: LocalPermissionExecutionPlan) => BashEnvPolicy);

export function resolvePermissionBashEnvPolicy(
  source: LocalBashEnvPolicySource,
  plan?: LocalPermissionExecutionPlan,
): BashEnvPolicy {
  return typeof source === 'function' ? source(plan) : source;
}

export function withPermissionExecutionPlan<T extends Record<string, unknown>>(
  input: T,
  plan: unknown,
): T {
  Object.defineProperty(input, LOCAL_PERMISSION_EXECUTION_PLAN, {
    value: plan,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return input;
}

export function copyWithPermissionExecutionPlan<T extends Record<string, unknown>>(
  input: T,
  plan: unknown,
): T {
  return withPermissionExecutionPlan({ ...input } as T, plan);
}

export function readPermissionExecutionPlan(
  input: unknown,
): LocalPermissionExecutionPlan | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as PermissionExecutionPlanCarrier)[LOCAL_PERMISSION_EXECUTION_PLAN];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as LocalPermissionExecutionPlan;
}
