import { sql } from 'drizzle-orm';

import type { AppDb } from './client.js';

/**
 * Whether a table exists in this database. For tables whose DDL another owner
 * runs (the v1 questionnaire table, for one), which a fresh v2 database may lack.
 */
export function sqliteTableExists(db: AppDb, name: string): boolean {
  return Boolean(
    db
      .all(sql`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ${name} LIMIT 1`)
      .at(0),
  );
}
