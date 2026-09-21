import { describe, expect, it, vi } from 'vitest';

import {
  applySandboxMode,
  getSandboxConfigDefaults,
  type SandboxConfig,
  type SandboxMode,
} from '@mavis/config';

import { createSandboxModeCapability } from './sandbox-mode-capability.js';

function service(initial: SandboxConfig) {
  let current = initial;
  const applyConfig = vi.fn(async (candidate: unknown) => {
    current = candidate as SandboxConfig;
    return {
      effectiveGeneration: 1,
      activation: 'initialized' as const,
      changedFields: [],
    };
  });
  return { config: () => current, applyConfig, peek: () => current };
}

describe('sandbox mode capability', () => {
  it('projects the current runtime configuration', async () => {
    const capability = createSandboxModeCapability(
      service({
        ...getSandboxConfigDefaults('darwin'),
        enabled: true,
        filesystem: {
          policy: { mode: 'read_only' },
          denyRead: [],
          denyWrite: [],
        },
      }),
    );
    await expect(capability.getSandboxMode()).resolves.toEqual({
      mode: 'read-only',
      deleteGuard: false,
    });
  });

  it.each(['read-only', 'workspace-write', 'danger-full-access'] satisfies SandboxMode[])(
    'commits %s through the existing sandbox engine',
    async (mode) => {
      const backing = service(getSandboxConfigDefaults('darwin'));
      const capability = createSandboxModeCapability(backing);
      await expect(capability.setSandboxMode({ mode })).resolves.toEqual({
        mode,
        deleteGuard: false,
      });
      expect(backing.applyConfig).toHaveBeenCalledOnce();
      expect(backing.peek()).toEqual(applySandboxMode(getSandboxConfigDefaults('darwin'), mode));
    },
  );

  it('propagates commit failure without changing the reported mode', async () => {
    const backing = service(getSandboxConfigDefaults('darwin'));
    backing.applyConfig.mockRejectedValueOnce(new Error('SANDBOX_UNAVAILABLE'));
    const capability = createSandboxModeCapability(backing);
    await expect(capability.setSandboxMode({ mode: 'read-only' })).rejects.toThrow(
      'SANDBOX_UNAVAILABLE',
    );
    await expect(capability.getSandboxMode()).resolves.toEqual({
      mode: 'danger-full-access',
      deleteGuard: false,
    });
  });
});
