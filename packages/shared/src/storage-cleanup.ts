export const STORAGE_RETENTION_POLICY_NAMES = [
  'logs',
  'turn_diffs',
  'background_tasks',
  'history_mutation_receipts',
  'legacy_history',
  'sqlite_backups',
  'llm_inspector',
  'workspace_snapshots',
  'browser_cache',
  'installer_cache',
] as const;
export type StorageRetentionPolicyName = (typeof STORAGE_RETENTION_POLICY_NAMES)[number];
export const STORAGE_RETENTION_OUTCOMES = ['ok', 'partial', 'invalid_config', 'failed'] as const;

export interface StorageRetentionPolicyReport {
  readonly policy: StorageRetentionPolicyName;
  readonly outcome: (typeof STORAGE_RETENTION_OUTCOMES)[number];
  readonly deletedEntries: number;
  readonly deletedBytes: number;
  readonly durationMs: number;
}

/** Electron owns browser sessions and installed downloads; Runtime owns retention. */
export interface StorageCleanupHost {
  begin(mode: 'automatic' | 'manual'): Promise<string>;
  complete(id: string, cancelled?: boolean): Promise<readonly StorageRetentionPolicyReport[]>;
}

/** Preview of Runtime-owned migration backups, shared with the Storage page. */
export type SqliteBackupSkipReason = 'too_recent' | 'changed' | 'in_use';
export interface SqliteBackupFamily {
  readonly id: string;
  readonly bytes: number;
  readonly fileCount: number;
  readonly hasDatabaseFile: boolean;
  readonly lastWrittenAtMs: number;
}
export interface SqliteBackupCleanupPlan {
  readonly retentionMs: number;
  readonly generatedAtMs: number;
  readonly removable: readonly SqliteBackupFamily[];
  readonly kept: readonly (SqliteBackupFamily & { readonly reason: SqliteBackupSkipReason })[];
  readonly removableBytes: number;
}
