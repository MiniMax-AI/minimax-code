import type { BetterSqlite3Instance, DatabaseClient } from './client.js';

const ALLOCATOR_TABLE = 'local_runtime_turn_ingress_sequences';
/** The value AUTOINCREMENT resumes from for one `sqlite_sequence` row (NULL resumes from 0). */
const ALLOCATOR_RESUME_FROM_SQL = 'COALESCE(CAST(seq AS INTEGER), 0)';

export interface TurnIngressAllocatorRepair {
  /**
   * Allocator state before the repair: `missing` when `sqlite_sequence` had no
   * allocator row, `behind` when every lagging row held a number (or numeric
   * text) below the issued high-water, `malformed` when a lagging row held a
   * value SQLite cannot read as a number, which AUTOINCREMENT resumes from as 0.
   */
  readonly previousState: 'missing' | 'behind' | 'malformed';
  /** Lowest value a numeric lagging row resumed from; absent when no lagging row was numeric. */
  readonly previousHighWater?: number;
  /** Allocator value after the repair: the highest sequence already handed out. */
  readonly repairedHighWater: number;
}

/**
 * Turn admission allocates `accepted_sequence` from the AUTOINCREMENT table
 * `local_runtime_turn_ingress_sequences` and writes it into the receipt under a
 * unique index. When the allocator high-water falls below a sequence that a
 * receipt already holds (for example after the database files were restored
 * from different snapshots), every admission collides with that receipt, the
 * transaction rolls the allocation back, and the next attempt collides again.
 *
 * Version 8 enforces the invariant once; this idempotent startup repair keeps
 * it on every boot before any Turn is admitted. "Issued" covers every durable
 * holder of the sequence: receipts, mappings, and the per-Session agent state,
 * which outlives Turn deletion and drops writes from lower sequences as stale.
 * Healthy databases are only read: the write lock is taken only when the
 * allocator lags, and the lag is re-checked under that lock because another
 * runtime may share the dataDir. It only raises the `sqlite_sequence`
 * high-water and never touches receipts, mappings, or agent state.
 */
export function repairTurnIngressAllocatorHighWater(
  database: DatabaseClient,
): TurnIngressAllocatorRepair | undefined {
  const rawDb = database.rawDb;
  const presentTables = rawDb
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('local_runtime_turn_ingress', 'local_runtime_turn_ingress_sequences')`,
    )
    .get() as { readonly count: number };
  if (presentTables.count < 2) return undefined;
  // Agent state only adds a third source; a drifted or missing table must not
  // block the repair that receipts and mappings alone already make correct.
  const agentStateHasSequence =
    rawDb
      .prepare(
        `SELECT 1 FROM pragma_table_info('local_runtime_session_agent_state')
         WHERE name = 'turn_sequence'`,
      )
      .get() !== undefined;
  if (inspectAllocatorLag(rawDb, agentStateHasSequence) === undefined) return undefined;

  return rawDb
    .transaction((): TurnIngressAllocatorRepair | undefined => {
      const lag = inspectAllocatorLag(rawDb, agentStateHasSequence);
      if (lag === undefined) return undefined;
      if (lag.previousState === 'missing') {
        rawDb
          .prepare('INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)')
          .run(ALLOCATOR_TABLE, lag.repairedHighWater);
      } else {
        rawDb
          .prepare(
            `UPDATE sqlite_sequence
             SET seq = ?
             WHERE name = ?
               AND ${ALLOCATOR_RESUME_FROM_SQL} < ?`,
          )
          .run(lag.repairedHighWater, ALLOCATOR_TABLE, lag.repairedHighWater);
      }
      return lag;
    })
    .immediate();
}

/** The repair the allocator needs, or `undefined` when it is already at or above the issued high-water. */
function inspectAllocatorLag(
  rawDb: BetterSqlite3Instance,
  agentStateHasSequence: boolean,
): TurnIngressAllocatorRepair | undefined {
  // Only INTEGER values can collide with what AUTOINCREMENT hands out, and
  // SQLite orders TEXT/BLOB above numbers, so an unfiltered MAX() would let one
  // stray non-integer hide the real high-water. Integers above
  // Number.MAX_SAFE_INTEGER are excluded the same way: JS cannot hold them
  // exactly, AUTOINCREMENT will not count up to them, and a mapping rowid that
  // high already makes SQLite resume past it by itself, so a stray one must not
  // mask the real high-water below it. The receipt filter keeps the
  // `IS NOT NULL` term so the lookup stays on the partial unique index.
  const agentStateHighWaterSql = agentStateHasSequence
    ? `(SELECT MAX(turn_sequence)
        FROM local_runtime_session_agent_state
        WHERE typeof(turn_sequence) = 'integer'
          AND turn_sequence <= @maxSafe)`
    : 'NULL';
  const issued = rawDb
    .prepare(
      `SELECT
         (SELECT MAX(accepted_sequence)
          FROM local_runtime_turn_ingress
          WHERE accepted_sequence IS NOT NULL
            AND typeof(accepted_sequence) = 'integer'
            AND accepted_sequence <= @maxSafe) AS receipt_high_water,
         (SELECT MAX(sequence)
          FROM local_runtime_turn_ingress_sequences
          WHERE sequence <= @maxSafe) AS mapping_high_water,
         ${agentStateHighWaterSql} AS agent_state_high_water`,
    )
    .get({ maxSafe: Number.MAX_SAFE_INTEGER }) as {
    readonly receipt_high_water: unknown;
    readonly mapping_high_water: unknown;
    readonly agent_state_high_water: unknown;
  };
  const issuedHighWater = Math.max(
    issuedSequenceOrZero(issued.receipt_high_water),
    issuedSequenceOrZero(issued.mapping_high_water),
    issuedSequenceOrZero(issued.agent_state_high_water),
  );
  if (issuedHighWater === 0) return undefined;

  // `seq` has no type affinity. AUTOINCREMENT resumes from the row's integer
  // conversion (CAST semantics: '100' and '100abc' resume from 100, 5.7 from
  // 5, 'abc' and NULL from 0), so lag is judged on that value: a numeric text
  // at or above the high-water is healthy and must never be rewritten lower.
  // The UPDATE guard uses the same expression, so every row judged lagging is
  // the row that gets raised.
  const allocatorRows = rawDb
    .prepare(
      `SELECT seq, ${ALLOCATOR_RESUME_FROM_SQL} AS resume_from FROM sqlite_sequence WHERE name = ?`,
    )
    .all(ALLOCATOR_TABLE) as Array<{ readonly seq: unknown; readonly resume_from: number }>;
  if (allocatorRows.length === 0) {
    return { previousState: 'missing', repairedHighWater: issuedHighWater };
  }
  const laggingRows = allocatorRows.filter((row) => row.resume_from < issuedHighWater);
  if (laggingRows.length === 0) return undefined;
  // Mirrors SQLite's integer prefix parse: optional whitespace and sign, then a digit.
  const numericLagging = laggingRows.filter(
    ({ seq }) => typeof seq === 'number' || (typeof seq === 'string' && /^\s*[+-]?\d/u.test(seq)),
  );
  return {
    previousState: numericLagging.length === laggingRows.length ? 'behind' : 'malformed',
    ...(numericLagging.length > 0
      ? { previousHighWater: Math.min(...numericLagging.map((row) => row.resume_from)) }
      : {}),
    repairedHighWater: issuedHighWater,
  };
}

/**
 * Non-integer or non-positive issued sequences count as "nothing issued yet".
 * Deliberately lenient, unlike migration 0008's fail-closed `positiveSafeInteger`:
 * this repair runs on every boot and must never turn odd data into a startup failure.
 */
function issuedSequenceOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
