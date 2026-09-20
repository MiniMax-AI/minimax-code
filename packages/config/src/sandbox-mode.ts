/**
 * Public sandbox-mode contract shared by the TUI slash command and the headless
 * `exec --sandbox` flag. The three names below are the entire user-facing
 * surface; `SandboxConfig` keeps the richer internal model (including the
 * `delete_guard` refinement) and stays the single policy source.
 *
 * Deliberately no boolean `sandbox=true/false` model exists: every surface
 * speaks these three modes and projects them onto `SandboxConfig`.
 */
import type { SandboxConfig } from './sandbox-config.js';
import type { SandboxFilesystemModeName } from './sandbox-settings.js';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Declaration order is the user-facing order: least to most permissive. */
export const SANDBOX_MODES: readonly SandboxMode[] = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

export const SANDBOX_MODE_DESCRIPTIONS: Readonly<Record<SandboxMode, string>> = Object.freeze({
  'read-only': 'Commands can read the workspace but cannot write outside the session temp dir',
  'workspace-write': 'Commands can read anywhere and write inside the workspace',
  'danger-full-access': 'No managed sandbox is applied; commands run with full host access',
});

/** Effective mode projected from the stored configuration. */
export interface EffectiveSandboxMode {
  readonly mode: SandboxMode;
  /** The internal delete guard has no separate public mode, so report it explicitly. */
  readonly deleteGuard: boolean;
}

export class InvalidSandboxModeError extends Error {
  constructor(readonly value: string) {
    super(`Invalid sandbox mode "${value}". Expected one of: ${SANDBOX_MODES.join(', ')}.`);
    this.name = 'InvalidSandboxModeError';
  }
}

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOX_MODES as readonly string[]).includes(value);
}

/** Strict parser: invalid input never falls back to full host access. */
export function parseSandboxMode(value: string): SandboxMode {
  const normalized = value.trim().toLowerCase();
  if (!isSandboxMode(normalized)) throw new InvalidSandboxModeError(value);
  return normalized;
}

export function sandboxModeFilesystemLevel(mode: SandboxMode): SandboxFilesystemModeName {
  switch (mode) {
    case 'read-only':
      return 'read_only';
    case 'workspace-write':
      return 'workspace_write';
    case 'danger-full-access':
      return 'full_access';
  }
}

export function resolveSandboxMode(config: SandboxConfig): EffectiveSandboxMode {
  if (!config.enabled) return { mode: 'danger-full-access', deleteGuard: false };
  switch (config.filesystem.policy.mode) {
    case 'read_only':
      return { mode: 'read-only', deleteGuard: false };
    case 'workspace_write':
      return { mode: 'workspace-write', deleteGuard: false };
    case 'delete_guard':
      return { mode: 'danger-full-access', deleteGuard: true };
    case 'full_access':
      return { mode: 'danger-full-access', deleteGuard: false };
  }
}

/**
 * Apply a public mode while preserving unrelated sandbox configuration. Full
 * access disables the managed sandbox instead of keeping a permissive wrapper.
 */
export function applySandboxMode(config: SandboxConfig, mode: SandboxMode): SandboxConfig {
  return {
    ...config,
    enabled: mode !== 'danger-full-access',
    filesystem: {
      ...config.filesystem,
      policy: { mode: sandboxModeFilesystemLevel(mode) },
      denyRead: [...config.filesystem.denyRead],
      denyWrite: [...config.filesystem.denyWrite],
    },
    network: {
      ...config.network,
      policy: { ...config.network.policy },
      deniedDomains: [...config.network.deniedDomains],
    },
  };
}

export function describeSandboxMode(effective: EffectiveSandboxMode): string {
  const base = `${effective.mode} · ${SANDBOX_MODE_DESCRIPTIONS[effective.mode]}`;
  return effective.deleteGuard
    ? `${base} (delete guard on: deletions outside the workspace stay blocked)`
    : base;
}
