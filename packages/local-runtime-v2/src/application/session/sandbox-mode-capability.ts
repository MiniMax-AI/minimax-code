import {
  applySandboxMode,
  resolveSandboxMode,
  type EffectiveSandboxMode,
  type SandboxConfig,
  type SandboxMode,
} from '@mavis/config';

import type { LocalSandboxService } from '../../service/sandbox/index.js';

/** Thin public projection over the runtime's single sandbox policy engine. */
export type SandboxModeCapabilityService = Pick<LocalSandboxService, 'config' | 'applyConfig'>;

export interface SandboxModeCapability {
  getSandboxMode(): Promise<EffectiveSandboxMode>;
  setSandboxMode(input: { mode: SandboxMode }): Promise<EffectiveSandboxMode>;
}

export function createSandboxModeCapability(
  service: SandboxModeCapabilityService,
): SandboxModeCapability {
  const current = (): SandboxConfig => service.config();
  return {
    getSandboxMode: async () => resolveSandboxMode(current()),
    setSandboxMode: async ({ mode }) => {
      // Propagate rejected commits: a requested restriction must never silently
      // fall back to danger-full-access.
      await service.applyConfig(applySandboxMode(current(), mode));
      return resolveSandboxMode(current());
    },
  };
}
