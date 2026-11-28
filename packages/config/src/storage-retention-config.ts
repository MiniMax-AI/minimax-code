/**
 * Retention periods for data the local runtime cleans up after it starts. Absent keys use the
 * built-in values. A present value that is not a number is kept as NaN, and the runtime skips that
 * cleanup instead of falling back to a default.
 */
export interface StorageRetentionConfig {
  logsDays?: number;
  turnDiffsDays?: number;
  backgroundTasksDays?: number;
  historyMutationReceiptsHours?: number;
  legacyHistoryDays?: number;
}

const STORAGE_RETENTION_KEYS = [
  'logsDays',
  'turnDiffsDays',
  'backgroundTasksDays',
  'historyMutationReceiptsHours',
  'legacyHistoryDays',
] as const satisfies readonly (keyof StorageRetentionConfig)[];

export function parseStorageRetentionConfig(
  raw: Record<string, unknown>,
): StorageRetentionConfig | undefined {
  const section = raw.storageRetention;
  if (section === undefined || section === null) return undefined;
  // A section that is not a mapping cannot say what to keep, so every cleanup is skipped.
  const malformed = typeof section !== 'object' || Array.isArray(section);
  const parsed: StorageRetentionConfig = {};
  for (const key of STORAGE_RETENTION_KEYS) {
    const value: unknown = malformed ? Number.NaN : Reflect.get(section, key);
    if (value === undefined) continue;
    parsed[key] = typeof value === 'number' ? value : Number.NaN;
  }
  return parsed;
}
