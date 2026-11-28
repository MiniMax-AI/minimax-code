import { sql } from 'drizzle-orm';

import type { AppDb } from './client.js';

export const LEGACY_HISTORY_NOTICE_REPAIR_CUTOFF_TABLE =
  'local_runtime_v2_agent_legacy_history_notice_repair';

const LEGACY_HISTORY_NOTICE_MIGRATION_VERSION = 29;

/**
 * Normal profiles retain the original m0029 boundary. Collision repair
 * profiles persist the actual later freeze time in their optional metadata.
 *
 * A repair table without a usable row only comes from the safe-mode snapshot
 * backfill, which creates the table but never writes its row. The repair
 * migration always inserts the row in the same transaction that creates the
 * table, so those profiles never ran the repair and keep the original
 * boundary instead of degrading every legacy history read to `pending`.
 */
export function readLegacyHistoryNoticeCutoff(db: AppDb): number | undefined {
  const repairCutoff = repairCutoffTableExists(db) ? readRepairCutoff(db) : undefined;
  return repairCutoff ?? readOriginalMigrationCutoff(db);
}

function repairCutoffTableExists(db: AppDb): boolean {
  return Boolean(
    db
      .all(
        sql`
        SELECT 1 AS present
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'local_runtime_v2_agent_legacy_history_notice_repair'
        LIMIT 1
      `,
      )
      .at(0),
  );
}

function readRepairCutoff(db: AppDb): number | undefined {
  const row = db
    .all(
      sql`
      SELECT cutoff_at_ms AS cutoffAtMs
      FROM local_runtime_v2_agent_legacy_history_notice_repair
      WHERE singleton = 1
      LIMIT 1
    `,
    )
    .at(0);
  return numericField(row, 'cutoffAtMs');
}

function readOriginalMigrationCutoff(db: AppDb): number | undefined {
  const row = db
    .all(
      sql`
      SELECT applied_at_ms AS appliedAtMs
      FROM local_runtime_v2_schema_migrations
      WHERE version = ${LEGACY_HISTORY_NOTICE_MIGRATION_VERSION}
      LIMIT 1
    `,
    )
    .at(0);
  return numericField(row, 'appliedAtMs');
}

function numericField(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) ? candidate : undefined;
}
