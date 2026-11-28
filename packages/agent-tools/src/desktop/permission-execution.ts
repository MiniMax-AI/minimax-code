import type { BashEnvPolicy } from '@mavis/agent-core/bash-subprocess-env';

/**
 * In-process permission execution metadata. The carrier is deliberately a
 * non-enumerable symbol so it never enters the model-visible Bash schema or
 * serialized tool arguments.
 */
const LOCAL_PERMISSION_EXECUTION_PLAN = Symbol.for('@mavis/permission/execution-plan');

/** Same non-enumerable contract as the execution plan. */
const LOCAL_PERMISSION_WRITE_TARGET = Symbol.for('@mavis/permission/write-target');

type PermissionExecutionPlanCarrier = {
  [LOCAL_PERMISSION_EXECUTION_PLAN]?: unknown;
};

type PermissionWriteTargetCarrier = {
  [LOCAL_PERMISSION_WRITE_TARGET]?: PermissionWriteTarget;
};

/** The real location a permission decision judged for one write or edit. */
export type PermissionWriteTarget = Readonly<{
  canonicalPath: string;
  resolveCurrent: () => string | undefined;
}>;

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

export function withPermissionWriteTarget<T extends Record<string, unknown>>(
  input: T,
  target: PermissionWriteTarget,
): T {
  Object.defineProperty(input, LOCAL_PERMISSION_WRITE_TARGET, {
    value: target,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return input;
}

/**
 * Refuses a write when a symlink swap moved its target after the permission
 * decision. Inputs that never passed a decision carry no target and are not
 * checked here.
 */
export function assertPermissionWriteTargetUnchanged(input: unknown): void {
  if (!input || typeof input !== 'object') return;
  const target = (input as PermissionWriteTargetCarrier)[LOCAL_PERMISSION_WRITE_TARGET];
  if (!target || target.resolveCurrent() === target.canonicalPath) return;
  throw new Error(
    'The real location of this path changed after the permission check, so nothing was written. ' +
      'Retry the call to have the new location checked.',
  );
}
