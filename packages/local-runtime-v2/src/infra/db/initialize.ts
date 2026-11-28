import type { DatabaseClient } from './client.js';
import {
  createDatabaseBackupIfPending,
  pruneSupersededDatabaseBackups,
  type DatabaseBackupResult,
  type DatabaseBackupRetentionResult,
} from './backup.js';
import {
  repairTurnIngressAllocatorHighWater,
  type TurnIngressAllocatorRepair,
} from './turn-ingress-allocator-recovery.js';
import { runMigrations } from './migrate.js';
import { ALL_MIGRATIONS } from './migrations.js';
import { migration as queryCollapseMigration } from './migrations/session/migration-0016-create-query-collapse-view-states.js';
import { assertDatabaseSchemaConsistent } from './schema-consistency.js';
import { disableLegacyCronsWithoutFutureRun } from './legacy-cron-recovery.js';
import { recoverLegacySessionRecordsBeforeBackfill } from './legacy-session-recovery.js';
import {
  recoverProjectPreferencesBeforeBackfill,
  recoverSessionProjectMetadataBeforeRepair,
} from './project-migration-recovery.js';

const PRE_SESSION_BACKFILL_MIGRATIONS = ALL_MIGRATIONS.filter((migration) => migration.version < 7);
const PRE_SESSION_PROJECT_REPAIR_MIGRATIONS = ALL_MIGRATIONS.filter(
  (migration) => migration.version < 15,
);

/**
 * Wall-clock cost of each blocking stage of database initialization.
 *
 * Startup previously reported only that the runtime became ready, so a slow
 * update-install restart could not be attributed to a stage without bisecting
 * unrelated log lines. `backupMs` dominates on large databases because the
 * pre-migration backup copies and verifies the whole file.
 */
interface DatabaseInitializationTimings {
  readonly totalMs: number;
  readonly backupMs: number;
  readonly migrationsMs: number;
  readonly schemaCheckMs: number;
}

/** DB-owned observation; the host contract remains independent of infrastructure. */
type DatabaseMigrationObservation = {
  readonly startedAtEpochMs: number;
  readonly pendingMigrationCount: number;
} & (
  | { readonly phase: 'started' }
  | { readonly phase: 'completed' | 'failed'; readonly durationMs: number }
);

export interface DatabaseInitializationResult {
  readonly pendingVersions: readonly number[];
  readonly backup: DatabaseBackupResult;
  readonly timings: DatabaseInitializationTimings;
  readonly pruneBackups?: () => Promise<DatabaseBackupRetentionResult>;
  readonly disabledLegacyScheduleCount: number;
  readonly recoveredLegacySessionCount: number;
  readonly degradedLegacySessionCount: number;
  readonly recoveredProjectPreferenceCount: number;
  readonly skippedSessionProjectRepairCount: number;
  readonly repairedTurnIngressAllocator?: TurnIngressAllocatorRepair;
  readonly turnIngressAllocatorRepairError?: string;
}

export async function initializeDatabase(options: {
  readonly database: DatabaseClient;
  readonly dataDir: string;
  readonly onMigration?: (event: DatabaseMigrationObservation) => undefined;
}): Promise<DatabaseInitializationResult> {
  const startedAtMs = Date.now();
  const applied = readAppliedVersions(options.database);
  const pendingVersions = ALL_MIGRATIONS.filter((migration) => !applied.has(migration.version)).map(
    (migration) => migration.version,
  );
  // Opening the connection / reading version metadata precedes this interval.
  // Measure backup, recovery, all pending migrations and final schema validation.
  const startedAtEpochMs = options.onMigration ? migrationEpochNow() : undefined;
  reportDatabaseMigration(options.onMigration, 'started', startedAtEpochMs, pendingVersions.length);
  try {
    const backupStartedAtMs = Date.now();
    const appliedMaxVersion = applied.size > 0 ? Math.max(...applied) : 0;
    const backup = await createDatabaseBackupIfPending({
      database: options.database,
      dataDir: options.dataDir,
      ...(pendingVersions.length > 0
        ? { campaign: { appliedMaxVersion, pendingVersions } }
        : {}),
    });
    const backupMs = Math.max(0, Date.now() - backupStartedAtMs);
    const migrationsStartedAtMs = Date.now();
    const disabledLegacyScheduleCount = disableLegacyCronsWithoutFutureRun({
      database: options.database,
      version2Pending: pendingVersions.includes(2),
    });
    runMigrations(options.database.rawDb, PRE_SESSION_BACKFILL_MIGRATIONS);
    const recoveredProjectPreferenceCount = recoverProjectPreferencesBeforeBackfill({
      database: options.database,
      version7Pending: pendingVersions.includes(7),
    });
    const sessionRecovery = recoverLegacySessionRecordsBeforeBackfill({
      database: options.database,
      version7Pending: pendingVersions.includes(7),
    });
    runMigrations(options.database.rawDb, PRE_SESSION_PROJECT_REPAIR_MIGRATIONS);
    const skippedSessionProjectRepairCount = recoverSessionProjectMetadataBeforeRepair({
      database: options.database,
      version15Pending: pendingVersions.includes(15),
    });
    recoverPublishedCronQueryCollapseCollision({
      database: options.database,
      migration16Applied: applied.has(16),
      migration32Pending: pendingVersions.includes(32),
    });
    runMigrations(options.database.rawDb, ALL_MIGRATIONS);
    const turnIngressAllocator = repairTurnIngressAllocatorWithoutBlockingStartup(options.database);
    const migrationsMs = Math.max(0, Date.now() - migrationsStartedAtMs);
    const schemaCheckStartedAtMs = Date.now();
    assertDatabaseSchemaConsistent(options.database.rawDb);
    const schemaCheckMs = Math.max(0, Date.now() - schemaCheckStartedAtMs);
    reportDatabaseMigration(
      options.onMigration,
      'completed',
      startedAtEpochMs,
      pendingVersions.length,
    );
    return {
      pendingVersions,
      backup,
      timings: {
        totalMs: Math.max(0, Date.now() - startedAtMs),
        backupMs,
        migrationsMs,
        schemaCheckMs,
      },
      ...(backup.created
        ? {
            pruneBackups: () =>
              pruneSupersededDatabaseBackups({ dataDir: options.dataDir, retainedBackup: backup }),
          }
        : {}),
      disabledLegacyScheduleCount,
      recoveredLegacySessionCount: sessionRecovery.recoveredCount,
      degradedLegacySessionCount: sessionRecovery.degradedCount,
      recoveredProjectPreferenceCount,
      skippedSessionProjectRepairCount,
      ...turnIngressAllocator,
    };
  } catch (error) {
    reportDatabaseMigration(
      options.onMigration,
      'failed',
      startedAtEpochMs,
      pendingVersions.length,
    );
    throw error;
  }
}

/**
 * A published Cron branch occupied version 16 without creating the Session
 * query-collapse table. Restore that immutable prerequisite before canonical
 * m32 reads it, without changing the historic marker.
 */
function recoverPublishedCronQueryCollapseCollision(options: {
  readonly database: DatabaseClient;
  readonly migration16Applied: boolean;
  readonly migration32Pending: boolean;
}): void {
  if (
    !options.migration16Applied ||
    !options.migration32Pending ||
    tableExists(options.database, 'local_runtime_query_view_states') ||
    !tableHasColumns(options.database, 'local_runtime_v2_cron_definitions', ['project', 'model'])
  ) {
    return;
  }
  options.database.rawDb.transaction(() => {
    if (typeof queryCollapseMigration.up === 'string') {
      options.database.rawDb.exec(queryCollapseMigration.up);
    } else {
      queryCollapseMigration.up(options.database.rawDb);
    }
  })();
}

function tableExists(database: DatabaseClient, tableName: string): boolean {
  return Boolean(
    database.rawDb
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

function tableHasColumns(
  database: DatabaseClient,
  tableName: string,
  columnNames: readonly string[],
): boolean {
  const columns = new Set(
    database.rawDb
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .flatMap((row) =>
        typeof row === 'object' && row !== null && 'name' in row && typeof row.name === 'string'
          ? [row.name]
          : [],
      ),
  );
  return columnNames.every((columnName) => columns.has(columnName));
}

function readAppliedVersions(database: DatabaseClient): Set<number> {
  const table = database.rawDb
    .prepare(
      `SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name = 'local_runtime_v2_schema_migrations'`,
    )
    .get();
  if (!table) return new Set();
  const rows = database.rawDb
    .prepare('SELECT version FROM local_runtime_v2_schema_migrations')
    .all();
  return new Set(
    rows.map((row) => {
      const value =
        typeof row === 'object' && row !== null && 'version' in row
          ? (row as { version: unknown }).version
          : undefined;
      if (!Number.isSafeInteger(value)) throw new Error('Invalid v2 migration history');
      return value as number;
    }),
  );
}

function migrationEpochNow(): number | undefined {
  try {
    const value = performance.timeOrigin + performance.now();
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function reportDatabaseMigration(
  observer: ((event: DatabaseMigrationObservation) => undefined) | undefined,
  phase: DatabaseMigrationObservation['phase'],
  startedAtEpochMs: number | undefined,
  pendingMigrationCount: number,
): void {
  try {
    if (!observer || startedAtEpochMs === undefined) return;
    const now = migrationEpochNow();
    if (now === undefined || now < startedAtEpochMs) return;
    const common = { startedAtEpochMs, pendingMigrationCount };
    observer(
      phase === 'started'
        ? { ...common, phase }
        : {
            ...common,
            phase,
            durationMs: Math.round((now - startedAtEpochMs) * 1000) / 1000,
          },
    );
  } catch {
    // Synchronous notification only: never wait for delivery or replace a DB error.
  }
}

function repairTurnIngressAllocatorWithoutBlockingStartup(
  database: DatabaseClient,
): Pick<
  DatabaseInitializationResult,
  'repairedTurnIngressAllocator' | 'turnIngressAllocatorRepairError'
> {
  try {
    const repaired = repairTurnIngressAllocatorHighWater(database);
    return repaired ? { repairedTurnIngressAllocator: repaired } : {};
  } catch (error) {
    return {
      turnIngressAllocatorRepairError: error instanceof Error ? error.message : String(error),
    };
  }
}
