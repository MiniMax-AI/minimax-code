import { withEffectivePromptSuggestion, type PromptSuggestionRemotePolicy } from '@mavis/config';

import type { LocalRuntimeConfig } from './types.js';
import type { updateLocalConfigFile } from './update.js';

/**
 * Fills the effective prompt-suggestion opt-in into a host's config read
 * boundary: its getter and its updater's answer. The runtime switch and the
 * GET/PUT `/config` answers all read these two, so every reader sees one value.
 */
export function withEffectivePromptSuggestionConfig(boundary: {
  readonly configGetter: () => LocalRuntimeConfig;
  readonly configUpdater: (
    body: Record<string, unknown>,
  ) => ReturnType<typeof updateLocalConfigFile>;
  readonly getPromptSuggestionPolicy?: () => PromptSuggestionRemotePolicy | undefined;
}) {
  const effective = (config: LocalRuntimeConfig): LocalRuntimeConfig =>
    withEffectivePromptSuggestion(config, boundary.getPromptSuggestionPolicy?.());
  return {
    configGetter: () => effective(boundary.configGetter()),
    configUpdater: async (body: Record<string, unknown>) => {
      const result = await boundary.configUpdater(body);
      return { ...result, config: effective(result.config) };
    },
  };
}
