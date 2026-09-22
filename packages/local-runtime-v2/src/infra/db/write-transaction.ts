import { sql } from 'drizzle-orm';
import {
  retrySqliteWrite,
  SqliteWriteAttemptFailedError,
  SqliteWriteRetryAbortedError,
} from '@mavis/shared/sqlite-write-retry';

import type { AppDb } from './client.js';

const WRITE_LOCK_ATTEMPT_MS = 50;

/** Cancellation before the mutation callback starts; no write needs to be replayed. */
export class WriteLockWaitAbortedError extends Error {
  override readonly name = 'WriteLockWaitAbortedError';

  constructor(readonly signal: AbortSignal) {
    super('SQLite write lock wait was cancelled', { cause: signal.reason });
  }
}

/**
 * The transaction handle drizzle hands to a `transaction()` callback. Callers
 * thread this through their `*InTransaction` helpers, so the retrying call has
 * to expose the same type the raw drizzle call used to.
 */
type DrizzleWriteTransaction = Parameters<Parameters<AppDb['transaction']>[0]>[0];

/**
 * Run a `BEGIN IMMEDIATE` mutation under the shared bounded-stall retry policy
 * (see `@mavis/shared/sqlite-write-retry`). Only lock acquisition is retried:
 * once the callback has started, any error — busy or not — rolls the
 * transaction back and propagates without a replay.
 *
 * The optional signal cancels contention waits only. An immediately available
 * write still commits, which keeps post-cancellation tool completion and
 * cleanup messages durable.
 */
export async function runWithWriteLock<T>(
  db: AppDb,
  mutation: (tx: DrizzleWriteTransaction) => T,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<T> {
  try {
    return await retrySqliteWrite(
      ({ remainingMs }) => {
        const previous = db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`).timeout;
        let entered = false;
        try {
          // Only lock acquisition gets a short native wait; the callback below
          // restores the connection policy before any statement runs.
          db.run(
            sql.raw(
              `PRAGMA busy_timeout = ${Math.min(WRITE_LOCK_ATTEMPT_MS, Math.ceil(remainingMs))}`,
            ),
          );
          return db.transaction(
            (tx) => {
              entered = true;
              db.run(sql.raw(`PRAGMA busy_timeout = ${previous}`));
              return mutation(tx);
            },
            { behavior: 'immediate' },
          );
        } catch (error) {
          // A callback that already started owns its own rollback; only a
          // failure to acquire the write lock is safe to replay.
          if (entered) throw new SqliteWriteAttemptFailedError(error);
          throw error;
        } finally {
          // No await occurs while the shared connection has a temporary timeout.
          db.run(sql.raw(`PRAGMA busy_timeout = ${previous}`));
        }
      },
      { timeoutMs: options.timeoutMs, signal: options.signal },
    );
  } catch (error) {
    // Only an abandoned wait becomes a Turn-facing cancellation; an error the
    // callback raised after it started keeps its own identity.
    if (error instanceof SqliteWriteRetryAbortedError) {
      throw new WriteLockWaitAbortedError(options.signal as AbortSignal);
    }
    throw error;
  }
}
