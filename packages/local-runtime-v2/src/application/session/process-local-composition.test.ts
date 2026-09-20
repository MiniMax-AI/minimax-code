import { describe, expect, it, vi } from 'vitest';
import { getSandboxConfigDefaults } from '@mavis/config';

import { composeProcessLocalApplication } from './process-local-composition.js';

describe('composeProcessLocalApplication sandbox capability', () => {
  it('exposes the runtime-owned sandbox mode through configuration', async () => {
    const application = composeProcessLocalApplication({
      eventBus: { subscribe: vi.fn(() => () => undefined) },
      usageCommits: undefined,
      compatibility: { skills: {}, peripherals: { workspace: {} } } as never,
      listRuntimeSkills: vi.fn(),
      plugins: {} as never,
      pluginControl: {} as never,
      miniApp: undefined,
      planEntryEnabled: () => true,
      modelProvider: {} as never,
      mcp: {} as never,
      sandbox: {
        config: () => getSandboxConfigDefaults('darwin'),
        applyConfig: vi.fn(async () => ({
          effectiveGeneration: 1,
          activation: 'initialized' as const,
          changedFields: [],
        })),
      },
    });

    await expect(application.configuration?.getSandboxMode?.()).resolves.toEqual({
      mode: 'danger-full-access',
      deleteGuard: false,
    });
  });
});
