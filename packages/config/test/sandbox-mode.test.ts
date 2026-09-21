import { describe, expect, it } from 'vitest';

import { parseSandboxConfig, type SandboxConfig } from '../src/sandbox-config.js';
import {
  applySandboxMode,
  describeSandboxMode,
  InvalidSandboxModeError,
  isSandboxMode,
  parseSandboxMode,
  resolveSandboxMode,
  sandboxModeFilesystemLevel,
  SANDBOX_MODES,
  type SandboxMode,
} from '../src/sandbox-mode.js';

function configWith(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    enabled: true,
    filesystem: {
      policy: { mode: 'workspace_write' },
      denyRead: ['/secret'],
      denyWrite: ['/etc'],
    },
    network: { policy: { mode: 'allow_all' }, deniedDomains: [] },
    localAccess: 'restricted',
    ...overrides,
  };
}

describe('sandbox mode contract', () => {
  it('exposes exactly the three Codex CLI modes, least to most permissive', () => {
    expect(SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'danger-full-access']);
  });

  it('parses supported modes and rejects values that could widen access', () => {
    for (const mode of SANDBOX_MODES) {
      expect(parseSandboxMode(`  ${mode.toUpperCase()}  `)).toBe(mode);
    }
    for (const invalid of ['', 'true', 'false', 'on', 'off', 'full', 'read_only', 'workspace']) {
      expect(() => parseSandboxMode(invalid)).toThrow(InvalidSandboxModeError);
    }
    expect(isSandboxMode(true)).toBe(false);
  });

  it('maps every public mode to the existing filesystem policy', () => {
    expect(sandboxModeFilesystemLevel('read-only')).toBe('read_only');
    expect(sandboxModeFilesystemLevel('workspace-write')).toBe('workspace_write');
    expect(sandboxModeFilesystemLevel('danger-full-access')).toBe('full_access');
  });

  it('projects disabled, restricted, and delete-guard configurations truthfully', () => {
    expect(resolveSandboxMode(configWith({ enabled: false }))).toEqual({
      mode: 'danger-full-access',
      deleteGuard: false,
    });
    expect(resolveSandboxMode(configWith())).toEqual({
      mode: 'workspace-write',
      deleteGuard: false,
    });
    const deleteGuard = resolveSandboxMode(
      configWith({
        filesystem: {
          policy: { mode: 'delete_guard' },
          denyRead: [],
          denyWrite: [],
        },
      }),
    );
    expect(deleteGuard).toEqual({
      mode: 'danger-full-access',
      deleteGuard: true,
    });
    expect(describeSandboxMode(deleteGuard)).toContain('delete guard on');
  });

  it.each(SANDBOX_MODES)('round-trips %s through the strict config parser', (mode) => {
    const applied = applySandboxMode(configWith(), mode);
    expect(resolveSandboxMode(applied)).toEqual({ mode, deleteGuard: false });
    expect(parseSandboxConfig(applied)).toEqual(applied);
  });

  it('disables the managed sandbox only for danger-full-access', () => {
    expect(applySandboxMode(configWith(), 'danger-full-access')).toMatchObject({
      enabled: false,
      filesystem: { policy: { mode: 'full_access' } },
    });
    for (const mode of ['read-only', 'workspace-write'] satisfies SandboxMode[]) {
      expect(applySandboxMode(configWith({ enabled: false }), mode).enabled).toBe(true);
    }
  });

  it('preserves unrelated fields without mutating the source', () => {
    const source = configWith();
    const applied = applySandboxMode(source, 'read-only');
    expect(applied.filesystem.denyRead).toEqual(['/secret']);
    expect(applied.filesystem.denyWrite).toEqual(['/etc']);
    expect(applied.localAccess).toBe('restricted');
    expect(applied.network).toEqual({
      policy: { mode: 'allow_all' },
      deniedDomains: [],
    });
    expect(source.filesystem.policy.mode).toBe('workspace_write');
  });
});
