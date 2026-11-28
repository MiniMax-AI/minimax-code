import { mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export type AppDb = BetterSQLite3Database;

interface BetterSqlite3Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): BetterSqlite3RunResult;
}

interface BetterSqlite3RunResult {
  readonly changes: number;
}

interface BetterSqlite3BackupProgress {
  readonly totalPages: number;
  readonly remainingPages: number;
}

interface BetterSqlite3OpenOptions {
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  readonly timeout?: number;
}

export interface BetterSqlite3Instance {
  exec(sql: string): void;
  prepare(sql: string): BetterSqlite3Statement;
  backup(filename: string): Promise<BetterSqlite3BackupProgress>;
  transaction<T>(fn: () => T): BetterSqlite3Transaction<T>;
  close(): void;
}

interface BetterSqlite3Transaction<T> {
  (): T;
  immediate(): T;
}

export type BetterSqlite3Constructor = new (
  filename: string,
  options?: BetterSqlite3OpenOptions,
) => BetterSqlite3Instance;

const DB_FILE = 'runtime-state.sqlite';
const DB_RELATIVE_PATH = join('v2', 'sqlite', DB_FILE);
const INCREMENTAL_AUTO_VACUUM = 2;
const RECLAIM_STEP_BYTES = 16 * 1024 * 1024;

/**
 * Only a file without tables can switch to incremental auto-vacuum, so the pragma runs for new
 * files only. On a database that is already incremental the same pragma still takes the write
 * lock, so running it on every open would fail whenever another connection is writing.
 */
const NEW_DATABASE_PRAGMAS = 'PRAGMA auto_vacuum = INCREMENTAL;';

/**
 * Connection PRAGMAs shared by the v2 client and the v1 compatibility connection.
 * journal_size_limit truncates the WAL after a checkpoint so one large transaction does not keep
 * its WAL size on disk.
 */
const WRITABLE_CONNECTION_PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
  PRAGMA journal_size_limit = 67108864;
`;

export interface DatabaseSpaceReclaimResult {
  readonly outcome: 'reclaimed' | 'nothing_to_reclaim' | 'not_incremental' | 'partial';
  readonly freedBytes: number;
}

export interface DatabaseClientOptions {
  readonly dataDir: string;
  /** Relative database path under dataDir; defaults to `v2/sqlite/runtime-state.sqlite`. */
  readonly relativePath?: string;
  /** Open an existing database read-only without creating files or setting write PRAGMAs. */
  readonly readonly?: boolean;
  /** Override the better-sqlite3 module load path. */
  readonly sqlite3ModulePath?: string;
}

export class DatabaseClient {
  private rawDb_: BetterSqlite3Instance | null = null;
  private drizzleDb: AppDb | null = null;
  private readonly dbPath: string;
  private readonly options: DatabaseClientOptions;

  constructor(options: DatabaseClientOptions) {
    this.options = options;
    this.dbPath = join(options.dataDir, options.relativePath ?? DB_RELATIVE_PATH);
  }

  get db(): AppDb {
    if (!this.drizzleDb) this.open();
    if (!this.drizzleDb) throw new Error('Database connection was not initialized');
    return this.drizzleDb;
  }

  /** 数据库主文件路径（备份 campaign identity 与磁盘预检需要读取源文件元数据）。 */
  get databasePath(): string {
    return this.dbPath;
  }

  /** 获取底层 better-sqlite3 句柄（用于 raw SQL / migration） */
  get rawDb(): BetterSqlite3Instance {
    if (!this.rawDb_) this.open();
    const rawDb = this.rawDb_;
    if (!rawDb) throw new Error('Database connection was not initialized');
    return rawDb;
  }

  /** 使用 SQLite 在线备份 API 将当前连接保存到指定文件。 */
  async backup(destinationPath: string): Promise<void> {
    await this.rawDb.backup(destinationPath);
  }

  /** 使用独立只读连接检查备份；只有单行 `ok` 视为通过。 */
  hasValidIntegrity(databasePath: string): boolean {
    const Database = loadSqlite3Constructor(this.options.sqlite3ModulePath);
    const verificationDb = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      // Connection-scoped 32 MiB page cache (negative = KiB): the full check
      // over a multi-GiB backup thrashed the default cache. Not persisted and
      // released with the connection; the check itself stays complete.
      verificationDb.exec('PRAGMA cache_size = -32768');
      const rows = verificationDb.prepare('PRAGMA integrity_check').all();
      return rows.length === 1 && isIntegrityOkRow(rows[0]);
    } finally {
      verificationDb.close();
    }
  }

  /**
   * Returns free pages to the file system in 16 MiB steps until none are left or `shouldStop`
   * turns true. Each step holds the write lock, so the caller's pause runs between steps. Only
   * databases created with incremental auto-vacuum can do this; older files report
   * `not_incremental` and keep their size.
   */
  async reclaimFreePages(limits: {
    /** True once the caller's deadline passed or the Runtime is stopping. */
    readonly shouldStop: () => boolean;
    /** Runs between two steps so writers in other processes get the lock. */
    readonly yieldToOtherWriters: () => Promise<void>;
    readonly stepBytes?: number;
  }): Promise<DatabaseSpaceReclaimResult> {
    if (this.options.readonly) return { outcome: 'not_incremental', freedBytes: 0 };
    const db = this.rawDb;
    if (readPragmaNumber(db, 'auto_vacuum') !== INCREMENTAL_AUTO_VACUUM) {
      return { outcome: 'not_incremental', freedBytes: 0 };
    }
    const pageSize = readPragmaNumber(db, 'page_size');
    const stepPages = Math.max(1, Math.floor((limits.stepBytes ?? RECLAIM_STEP_BYTES) / pageSize));
    let freedPages = 0;
    for (let free = freePages(db); free > 0; free = freePages(db)) {
      if (limits.shouldStop()) return { outcome: 'partial', freedBytes: freedPages * pageSize };
      // exec steps the pragma to completion; a prepared statement's run() frees a single page.
      db.exec(`PRAGMA incremental_vacuum(${Math.min(stepPages, free)})`);
      const left = freePages(db);
      if (left >= free) return { outcome: 'partial', freedBytes: freedPages * pageSize };
      freedPages += free - left;
      if (left > 0) await limits.yieldToOtherWriters();
    }
    return {
      outcome: freedPages > 0 ? 'reclaimed' : 'nothing_to_reclaim',
      freedBytes: freedPages * pageSize,
    };
  }

  /** Close the connection and release resources. */
  close(): void {
    if (this.rawDb_) {
      this.rawDb_.close();
      this.rawDb_ = null;
      this.drizzleDb = null;
    }
  }

  private open(): BetterSqlite3Instance {
    if (!this.options.readonly) mkdirSync(dirname(this.dbPath), { recursive: true });
    const isNewDatabaseFile = !this.options.readonly && isMissingOrEmptyFile(this.dbPath);
    const Database = loadSqlite3Constructor(this.options.sqlite3ModulePath);
    const sqlite = new Database(
      this.dbPath,
      this.options.readonly ? { readonly: true, fileMustExist: true } : undefined,
    );
    try {
      // v1 and v2 access the same database file through separate connections; keep PRAGMAs aligned.
      if (!this.options.readonly) {
        if (isNewDatabaseFile) sqlite.exec(NEW_DATABASE_PRAGMAS);
        sqlite.exec(WRITABLE_CONNECTION_PRAGMAS);
      }
      const drizzleDb = drizzle({ client: sqlite as never });
      this.rawDb_ = sqlite;
      this.drizzleDb = drizzleDb;
      return sqlite;
    } catch (error) {
      try {
        sqlite.close();
      } catch {
        // Preserve the connection initialization error.
      }
      throw error;
    }
  }
}

/** Resolve the native SQLite constructor for target and read-only source connections. */
export function loadSqlite3Constructor(overrideModulePath?: string): BetterSqlite3Constructor {
  const overridePath = overrideModulePath?.trim() || process.env.MAVIS_SQLITE3_MODULE_PATH?.trim();
  const require = createRequire(import.meta.url);
  if (overridePath) {
    const loaded: unknown = createRequire(join(overridePath, 'package.json'))('better-sqlite3');
    return resolveSqliteConstructor(loaded);
  }
  const loaded: unknown = require('better-sqlite3');
  return resolveSqliteConstructor(loaded);
}

function resolveSqliteConstructor(loaded: unknown): BetterSqlite3Constructor {
  if (typeof loaded === 'function') return loaded as BetterSqlite3Constructor;
  if (isObject(loaded) && typeof loaded.default === 'function') {
    return loaded.default as BetterSqlite3Constructor;
  }
  throw new TypeError('better-sqlite3 module does not export a database constructor');
}

function isMissingOrEmptyFile(path: string): boolean {
  try {
    return statSync(path).size === 0;
  } catch {
    return true;
  }
}

function freePages(db: BetterSqlite3Instance): number {
  return readPragmaNumber(db, 'freelist_count');
}

function readPragmaNumber(db: BetterSqlite3Instance, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get();
  const value = isObject(row) ? row[name] : undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`SQLite PRAGMA ${name} returned no integer`);
  }
  return value;
}

function isIntegrityOkRow(row: unknown): boolean {
  return isObject(row) && row.integrity_check === 'ok';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
