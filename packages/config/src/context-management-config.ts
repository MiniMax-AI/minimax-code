import type { ContextManagementConfig } from './config.js';

/** config.yaml `contextManagement`; invalid values fall back to `defaults` field by field. */
export function parseContextManagementConfig(
  raw: Record<string, unknown>,
  defaults: ContextManagementConfig,
): ContextManagementConfig {
  const rawCm = raw.contextManagement;
  if (rawCm == null || typeof rawCm !== 'object' || Array.isArray(rawCm)) {
    return {
      disableSystemReminderModels: [...defaults.disableSystemReminderModels],
      cuMaxScreenshotsInContext: defaults.cuMaxScreenshotsInContext,
    };
  }
  const obj = rawCm as Record<string, unknown>;
  const rawList = obj.disableSystemReminderModels;
  const disableSystemReminderModels =
    Array.isArray(rawList) && rawList.every((e) => typeof e === 'string' && e.length > 0)
      ? (rawList as string[])
      : [...defaults.disableSystemReminderModels];

  const rawCuMax = obj.cuMaxScreenshotsInContext;
  const cuMaxScreenshotsInContext =
    typeof rawCuMax === 'number' && Number.isFinite(rawCuMax) && rawCuMax >= 0
      ? Math.floor(rawCuMax)
      : defaults.cuMaxScreenshotsInContext;

  // Semantic validation (ratio vs. token count) lives with the trigger in
  // @mavis/context-manager; keep numbers so the runtime can warn on bad ones.
  const compactionTriggerAt =
    typeof obj.compactionTriggerAt === 'number' ? obj.compactionTriggerAt : undefined;

  return {
    disableSystemReminderModels,
    cuMaxScreenshotsInContext,
    ...(compactionTriggerAt === undefined ? {} : { compactionTriggerAt }),
  };
}
