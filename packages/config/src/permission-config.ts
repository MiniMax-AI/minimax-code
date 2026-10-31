/**
 * Permission classifier runtime knobs. Extracted from `config.ts` to keep
 * the main schema file under the 2_000-line guard.
 *
 * `classifierTimeoutMs` is the single base for three coupled timeouts
 * preserving the invariant `plugin fetch > daemon outer race ≥ daemon LLM
 * SDK`:
 *   - daemon Stage 2 LLM SDK + outer race    = base
 *   - legacy local-runtime plugin permission-check fetch  = base + 5_000ms
 *
 * Plugin fetches via `GET /api/config` (mirrors `skill-evolve-trigger`).
 */

export type PermissionPolicyOwner = 'engine' | 'core';
export type PermissionStorageWriteVersion = 1 | 2;

export interface PermissionConfig {
  /**
   * Final deterministic policy owner. Core is the default; Engine remains an
   * explicit rollback path.
   */
  policyOwner: PermissionPolicyOwner;

  /**
   * Disk format used for new or explicitly modified permission.json files.
   * Readers always accept both versions; v2 is the product default and an
   * explicit v1 value is the storage rollback switch.
   */
  storageWriteVersion: PermissionStorageWriteVersion;

  /**
   * Base timeout (ms) for the auto-mode permission classifier. Default
   * 60_000 calibrated for thinking-class LLMs. Hard floor 5_000ms — lower
   * values silently fall back to the default. No ceiling.
   */
  classifierTimeoutMs: number;

  /**
   * Whether permission checks may create user-confirmation requests.
   * Standard builds default to true. Headless builds may default this to
   * false so an ASK decision fails closed instead of waiting forever.
   */
  userConfirmationEnabled: boolean;

  /** Use the selected shell's native deletion instead of enforcing recoverable deletion. */
  nativeDelete: boolean;
}

export const PERMISSION_CONFIG_DEFAULTS: PermissionConfig = {
  policyOwner: 'core',
  storageWriteVersion: 2,
  classifierTimeoutMs: 60_000,
  userConfirmationEnabled: true,
  nativeDelete: false,
};

/**
 * Parse the `permission:` block from raw config. Values below the
 * 5_000ms hard floor silently fall back to the default rather than
 * crippling the gate.
 */
export function parsePermissionConfig(
  raw: Record<string, unknown>,
  defaults: PermissionConfig = PERMISSION_CONFIG_DEFAULTS,
): PermissionConfig {
  const perm = raw.permission;
  if (perm == null || typeof perm !== 'object' || Array.isArray(perm)) {
    return { ...defaults };
  }
  const obj = perm as Record<string, unknown>;
  const policyOwner =
    obj.policyOwner === undefined
      ? defaults.policyOwner
      : obj.policyOwner === 'engine' || obj.policyOwner === 'core'
        ? obj.policyOwner
        : 'engine';
  const storageWriteVersion =
    obj.storageWriteVersion === 1 || obj.storageWriteVersion === 2
      ? obj.storageWriteVersion
      : defaults.storageWriteVersion;
  const t = obj.classifierTimeoutMs;
  const classifierTimeoutMs =
    typeof t === 'number' && Number.isFinite(t) && t >= 5_000
      ? Math.floor(t)
      : defaults.classifierTimeoutMs;
  const userConfirmationEnabled =
    typeof obj.userConfirmationEnabled === 'boolean'
      ? obj.userConfirmationEnabled
      : defaults.userConfirmationEnabled;
  const nativeDelete = obj.nativeDelete === true;
  return {
    policyOwner,
    storageWriteVersion,
    classifierTimeoutMs,
    userConfirmationEnabled,
    nativeDelete,
  };
}
