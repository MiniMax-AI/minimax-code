import {
  compactionTriggerAtForSetting,
  findInvalidAutoCompactWindows,
  selectCompactionTriggerSetting,
  type CompactionTriggerSetting,
} from '@mavis/config';
import { isValidCompactionTriggerSetting } from '@mavis/context-manager';

import type { LocalConversationRuntimeConfig } from './contracts.js';
import { formatModelKey } from './resolution/model-key.js';

type CompactionTriggerConfig = Pick<
  LocalConversationRuntimeConfig,
  'contextManagement' | 'modelSettings'
>;

interface CompactionTriggerModel {
  readonly providerId: string;
  readonly modelId: string;
}

/**
 * The setting that decides a model's automatic compaction trigger, keyed by its
 * `provider/model` selection. An invalid global value counts as unset.
 */
export function readCompactionTriggerSetting(
  config: CompactionTriggerConfig,
  model: CompactionTriggerModel,
): CompactionTriggerSetting {
  const setting = selectCompactionTriggerSetting(
    config,
    formatModelKey(model.providerId, model.modelId),
  );
  return setting.source === 'global' && !isValidCompactionTriggerSetting(setting.value)
    ? { source: 'built-in' }
    : setting;
}

/** Trigger settings for the automatic compactor; every call reads the current config. */
export function readCompactionTriggerSettings(readConfig: () => CompactionTriggerConfig) {
  return {
    compactionTriggerAt: (model: CompactionTriggerModel) =>
      compactionTriggerAtForSetting(readCompactionTriggerSetting(readConfig(), model)),
    ignored: () => findIgnoredCompactionTriggerSettings(readConfig()),
  };
}

function findIgnoredCompactionTriggerSettings(config: CompactionTriggerConfig) {
  const global = config.contextManagement?.compactionTriggerAt;
  return [
    ...(global !== undefined && !isValidCompactionTriggerSetting(global)
      ? [{ setting: 'contextManagement.compactionTriggerAt', value: global }]
      : []),
    ...findInvalidAutoCompactWindows(config.modelSettings).map(({ modelKey, value }) => ({
      setting: 'modelSettings.autoCompactWindow',
      model: modelKey,
      value,
    })),
  ];
}
