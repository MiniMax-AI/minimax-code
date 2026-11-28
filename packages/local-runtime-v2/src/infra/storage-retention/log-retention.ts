import { lstat, open, readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { constants, type Dirent, type Stats } from 'node:fs';

import { DAY_MS, type AgeRetentionPolicy } from './contracts.js';

const DEFAULT_LOG_RETENTION_DAYS = 7;

interface TransientStorageRetentionResult {
  readonly logFilesDeleted: number;
  readonly logBytesDeleted: number;
  readonly retiredContextDebugDeleted: boolean;
  /** Set when the inspection budget ran out before every log entry was checked. */
  readonly truncated: boolean;
}

const NOTHING_DELETED: TransientStorageRetentionResult = {
  logFilesDeleted: 0,
  logBytesDeleted: 0,
  retiredContextDebugDeleted: false,
  truncated: false,
};

/** The `logs` policy: the fixed diagnostic log roots and the retired context debug directory. */
export function createLogRetentionPolicy(dataDir: string): AgeRetentionPolicy {
  return {
    name: 'logs',
    retention: {
      kind: 'age',
      setting: 'logsDays',
      defaultValue: DEFAULT_LOG_RETENTION_DAYS,
      unitMs: DAY_MS,
    },
    run: async ({ cutoffMs, consumeEntry, manual }) => {
      const result = await pruneTransientStorage({
        dataDir,
        cutoffMs,
        consumeEntry,
        truncateFiles: manual === true,
      });
      return {
        deletedEntries: result.logFilesDeleted + (result.retiredContextDebugDeleted ? 1 : 0),
        deletedBytes: result.logBytesDeleted,
        ...(result.truncated ? { truncated: true } : {}),
      };
    },
  };
}

/**
 * Post-ready retention for fixed diagnostic log roots and retired context debug.
 * Business temporary directories and workspaces are never discovered or traversed.
 */
export async function pruneTransientStorage(options: {
  readonly dataDir: string;
  readonly cutoffMs?: number;
  readonly nowMs?: () => number;
  readonly maxEntries?: number;
  readonly consumeEntry?: () => boolean;
  /** Truncate diagnostics in place so an active append-only writer keeps its file handle. */
  readonly truncateFiles?: boolean;
}): Promise<TransientStorageRetentionResult> {
  if (!(await isPlainDirectory(options.dataDir))) return NOTHING_DELETED;
  let remaining = options.maxEntries ?? 2_000;
  const cutoffMs = options.cutoffMs ?? ((options.nowMs ?? Date.now)() - DEFAULT_LOG_RETENTION_DAYS * DAY_MS);
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) return NOTHING_DELETED;
  const consumeEntry = options.consumeEntry ?? (() => {
    if (remaining <= 0) return false;
    remaining -= 1;
    return true;
  });
  const budget = createEntryBudget(consumeEntry);
  const retiredContextDebugDeleted = await removeRetiredContextDebug(options.dataDir);
  const context: PruneContext = {
    cutoffMs,
    budget,
    files: 0,
    bytes: 0,
    truncateFiles: options.truncateFiles === true,
  };
  for (const root of await resolveManagedLogRoots(options.dataDir)) {
    await pruneLogDirectory(root, context);
  }
  return {
    logFilesDeleted: context.files,
    logBytesDeleted: context.bytes,
    retiredContextDebugDeleted,
    truncated: budget.exhausted,
  };
}

async function removeRetiredContextDebug(dataDir: string): Promise<boolean> {
  const target = join(dataDir, 'debug');
  if (!(await isPlainDirectory(target))) return false;
  try {
    await rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function resolveManagedLogRoots(dataDir: string): Promise<string[]> {
  const chains = [
    [dataDir, join(dataDir, 'logs')],
    [
      dataDir,
      join(dataDir, 'v2'),
      join(dataDir, 'v2', 'observability'),
      join(dataDir, 'v2', 'observability', 'logs'),
    ],
  ];
  const valid = await Promise.all(
    chains.map(async (chain) => (await Promise.all(chain.map(isPlainDirectory))).every(Boolean)),
  );
  return chains.flatMap((chain, index) => {
    const root = chain.at(-1);
    return valid[index] && root ? [root] : [];
  });
}

interface PruneContext {
  readonly truncateFiles: boolean;
  readonly cutoffMs: number;
  readonly budget: EntryBudget;
  files: number;
  bytes: number;
}

async function pruneLogDirectory(root: string, context: PruneContext): Promise<void> {
  if (!(await isPlainDirectory(root))) return;
  await pruneLogChildren(root, context);
}

async function pruneLogChildren(directory: string, context: PruneContext): Promise<void> {
  if (!(await isPlainDirectory(directory))) return;
  const entries = await safeDirectoryEntries(directory);
  if (entries === undefined) return;
  for (const entry of entries) {
    if (!context.budget.consume()) break;
    await pruneLogEntry(directory, entry, context);
  }
}

async function pruneLogEntry(
  directory: string,
  entry: Dirent,
  context: PruneContext,
): Promise<void> {
  if (entry.isSymbolicLink()) return;
  const path = join(directory, entry.name);
  if (entry.isDirectory()) {
    await pruneLogSubdirectory(path, context);
    return;
  }
  if (!entry.isFile()) return;
  await pruneLogFile(path, context);
}

async function pruneLogSubdirectory(path: string, context: PruneContext): Promise<void> {
  await pruneLogChildren(path, context);
  try {
    await rmdir(path);
  } catch {
    // Non-empty/current directories stay in place.
  }
}

async function pruneLogFile(path: string, context: PruneContext): Promise<void> {
  try {
    const info = await lstat(path);
    if (context.truncateFiles) {
      if (!(await truncateLogFile(path, info))) return;
    } else {
      if (info.mtimeMs >= context.cutoffMs) return;
      await rm(path, { force: true });
    }
    context.files += 1;
    context.bytes += info.size;
  } catch {
    // Unreadable or busy files stay for the next pass.
  }
}

async function truncateLogFile(path: string, info: Stats): Promise<boolean> {
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) return false;
  const handle = await open(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev) return false;
    await handle.truncate(0);
    return true;
  } finally {
    await handle.close();
  }
}

async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function safeDirectoryEntries(path: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

interface EntryBudget {
  exhausted: boolean;
  consume(): boolean;
}

function createEntryBudget(consumeEntry: () => boolean): EntryBudget {
  const budget: EntryBudget = {
    exhausted: false,
    consume: () => {
      if (consumeEntry()) return true;
      budget.exhausted = true;
      return false;
    },
  };
  return budget;
}
