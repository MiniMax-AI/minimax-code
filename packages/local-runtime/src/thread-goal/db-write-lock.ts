import {
  retrySqliteWrite,
  SqliteWriteAttemptFailedError,
} from '@mavis/shared/sqlite-write-retry';

import { runInImmediateTransaction, withLocalRuntimeDb, type DatabaseLike } from '../persistence/db.js';

/** Native wait granted to one `BEGIN IMMEDIATE`; the rest of the budget is async. */
const GOAL_WRITE_STALL_MS = 50;

function readBusyTimeout(db: DatabaseLike): number {
  const row = db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined;
  return typeof row?.timeout === 'number' ? row.timeout : 0;
}

/**
 * Run one Goal store write against the shared `runtime-state.sqlite`.
 *
 * v1 and v2 open that file through separate connections, so a second `mcode`
 * process holding the WAL write lock used to surface `SQLITE_BUSY` straight
 * into the Turn (issue #282). Lock acquisition is retried with a short native
 * stall plus asynchronous backoff; once the write callback has started the
 * transaction rolls back and the error propagates without a replay.
 *
 * Reads deliberately keep the synchronous `withLocalRuntimeDb` path: WAL
 * readers are not blocked by a foreign writer, so they cannot hit this.
 */
export async function runGoalStoreWrite<T>(
  dataDir: Parameters<typeof withLocalRuntimeDb>[0],
  write: (db: DatabaseLike) => T,
): Promise<T> {
  return retrySqliteWrite(() =>
    withLocalRuntimeDb(dataDir, (db) => {
      const previous = readBusyTimeout(db);
      let entered = false;
      try {
        // Only lock acquisition gets a short native wait. The restore below
        // runs before this connection can be reused by anything else.
        db.exec(`PRAGMA busy_timeout = ${GOAL_WRITE_STALL_MS}`);
        return runInImmediateTransaction(db, () => {
          entered = true;
          return write(db);
        });
      } catch (error) {
        if (entered) throw new SqliteWriteAttemptFailedError(error);
        throw error;
      } finally {
        db.exec(`PRAGMA busy_timeout = ${previous}`);
      }
    }),
  );
}
