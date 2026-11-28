import { withEffectiveAdvisor } from '@mavis/config';

import type { LocalRuntimeConfig } from './types.js';
import type { updateLocalConfigFile } from './update.js';

/**
 * Fills the effective global advisor switch (`advisor.enabled`) into a host's config read
 * boundary: its getter and its updater's answer. Advisor reads and the GET/PUT `/config` answers
 * all read these two, so the settings page, `/advisor` and every Turn see one value. The value is
 * recomputed from the config on every read; nothing is cached.
 */
export function withEffectiveAdvisorConfig(boundary: {
  readonly configGetter: () => LocalRuntimeConfig;
  readonly configUpdater: (
    body: Record<string, unknown>,
  ) => ReturnType<typeof updateLocalConfigFile>;
}) {
  return {
    configGetter: () => withEffectiveAdvisor(boundary.configGetter()),
    configUpdater: async (body: Record<string, unknown>) => {
      const result = await boundary.configUpdater(body);
      return { ...result, config: withEffectiveAdvisor(result.config) };
    },
  };
}
