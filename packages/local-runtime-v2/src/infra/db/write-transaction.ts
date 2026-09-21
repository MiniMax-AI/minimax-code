import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import type { AppDb } from './client.js';

const WRITE_LOCK_BUDGET_MS = 10_000;
const WRITE_LOCK_ATTEMPT_MS = 50;

/** Cancellation before the mutation callback starts; no write needs to be replayed. */
export class WriteLockWaitAbortedError extends Error {
  override readonly name = 'WriteLockWaitAbortedError';

  constructor(readonly signal: AbortSignal) {
    super('SQLite write lock wait was cancelled', { cause: signal.reason });
  }
}

/** Retry only transaction admission: a callback that has started is never replayed. */
export async function runWithWriteLock<T>(
  db: AppDb,
  mutation: (tx: AppDb) => T,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<T> {
  const budget = options.timeoutMs ?? WRITE_LOCK_BUDGET_MS;
  if (!Number.isFinite(budget) || budget <= 0)
    throw new RangeError('Invalid write lock budget');
  const deadline = performance.now() + budget;
  let attempt = 0;
  let lastBusy: unknown = new Error('SQLite write lock wait exceeded its deadline');
  for (;;) {
    throwIfWaitAborted(options.signal);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw lastBusy;
    const previous = db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`).timeout;
    let entered = false;
    try {
      db.run(
        sql.raw(
          `PRAGMA busy_timeout = ${Math.ceil(Math.min(WRITE_LOCK_ATTEMPT_MS, remaining))}`,
        ),
      );
      return db.transaction(
        (tx) => {
          entered = true;
          // Only lock acquisition gets a short timeout. Restore the connection's
          // policy before callbacks (including nested transactions) can use it.
          db.run(sql.raw(`PRAGMA busy_timeout = ${previous}`));
          throwIfWaitAborted(options.signal);
          return mutation(tx);
        },
        { behavior: 'immediate' },
      );
    } catch (error) {
      if (entered || !isBusy(error)) throw error;
      lastBusy = error;
    } finally {
      // No await occurs while the shared connection has a temporary timeout.
      db.run(sql.raw(`PRAGMA busy_timeout = ${previous}`));
    }
    const wait = Math.min(
      deadline - performance.now(),
      25 * 2 ** Math.min(attempt++, 3) + Math.random() * 25,
    );
    if (wait <= 0) throw lastBusy;
    try {
      await delay(wait, undefined, { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted && error instanceof Error && error.name === 'AbortError') {
        throw new WriteLockWaitAbortedError(options.signal);
      }
      throw error;
    }
  }
}

function throwIfWaitAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WriteLockWaitAbortedError(signal);
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'SQLITE_BUSY';
}
