import { setTimeout as delay } from 'node:timers/promises';

/**
 * Shared retry policy for SQLite writers that share one WAL database across
 * processes (issue #282).
 *
 * Every `mcode` process opens the same `runtime-state.sqlite`, and WAL allows
 * a single writer at a time. A foreign writer that holds the write lock longer
 * than the connection `busy_timeout` otherwise surfaces `SQLITE_BUSY` to the
 * caller, which for turn-critical writes aborts a live Turn.
 *
 * better-sqlite3 blocks the Node event loop for the whole native wait, so each
 * attempt is expected to grant only a short native stall and spend the rest of
 * its budget in asynchronous backoff. That keeps the TUI responsive while
 * still outliving foreign transactions.
 */

const WRITE_RETRY_BUDGET_MS = 10_000;
const FIRST_BACKOFF_MS = 25;
const MAX_BACKOFF_EXPONENT = 3;

/** True for `SQLITE_BUSY` and the `SQLITE_BUSY_SNAPSHOT` family. */
export function isSqliteBusyError(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'SQLITE_BUSY';
}

/**
 * The attempt failed after its write callback started. The transaction rolls
 * itself back, so the retry loop must surface the cause instead of replaying
 * the callback. Adapters throw this to mark "not safe to retry".
 */
export class SqliteWriteAttemptFailedError extends Error {
  constructor(readonly cause: unknown) {
    super('SQLite write attempt failed', { cause });
  }
}

/**
 * The wait was cancelled while the loop was retrying lock acquisition. This is
 * deliberately distinct from a callback error that merely happens to be the
 * signal's abort reason: only a real abandoned wait may be reclassified by the
 * caller.
 */
export class SqliteWriteRetryAbortedError extends Error {
  constructor(readonly signal: AbortSignal) {
    super('SQLite write lock wait was cancelled', { cause: signal.reason });
  }
}

export interface SqliteWriteRetryOptions {
  /** Wall-clock budget for the whole retry loop, not per attempt. */
  readonly timeoutMs?: number;
  /**
   * Checked before attempts that follow a contended one and around every wait,
   * so an abort never sleeps. The first attempt always runs: an uncontended
   * write must stay durable even when the caller already cancelled.
   */
  readonly signal?: AbortSignal;
}

export interface SqliteWriteAttemptContext {
  /** Zero-based count of attempts already made. */
  readonly attemptIndex: number;
  /** Milliseconds left in the budget; cap the native stall to this. */
  readonly remainingMs: number;
}

/**
 * Re-run `attempt` while it fails with `SQLITE_BUSY` and the budget lasts.
 *
 * Only lock acquisition may be replayed. An adapter signals that its callback
 * already started by throwing {@link SqliteWriteAttemptFailedError}, which is
 * unwrapped and propagated without a retry.
 */
export async function retrySqliteWrite<T>(
  attempt: (context: SqliteWriteAttemptContext) => T,
  options: SqliteWriteRetryOptions = {},
): Promise<T> {
  const budget = options.timeoutMs ?? WRITE_RETRY_BUDGET_MS;
  if (!Number.isFinite(budget) || budget <= 0) throw new RangeError('Invalid write lock budget');
  const deadline = performance.now() + budget;
  let attemptIndex = 0;
  let contended = false;
  let lastBusy: unknown = new Error('SQLite write lock wait exceeded its deadline');
  for (;;) {
    if (contended && options.signal?.aborted) throw new SqliteWriteRetryAbortedError(options.signal);
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw lastBusy;
    try {
      return attempt({ attemptIndex, remainingMs });
    } catch (error) {
      if (error instanceof SqliteWriteAttemptFailedError) throw error.cause;
      if (!isSqliteBusyError(error)) throw error;
      lastBusy = error;
    }
    contended = true;
    attemptIndex += 1;
    if (options.signal?.aborted) throw new SqliteWriteRetryAbortedError(options.signal);
    const wait = Math.min(
      deadline - performance.now(),
      FIRST_BACKOFF_MS * 2 ** Math.min(attemptIndex - 1, MAX_BACKOFF_EXPONENT) + Math.random() * 25,
    );
    if (wait <= 0) throw lastBusy;
    try {
      await delay(wait, undefined, options.signal ? { signal: options.signal } : undefined);
    } catch (error) {
      if (options.signal?.aborted && error instanceof Error && error.name === 'AbortError') {
        throw new SqliteWriteRetryAbortedError(options.signal);
      }
      throw error;
    }
  }
}
