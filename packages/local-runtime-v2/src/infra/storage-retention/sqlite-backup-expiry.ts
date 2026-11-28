/**
 * Settings > Storage smart cleanup for pre-migration SQLite backups.
 *
 * Only backups the Runtime itself writes are in scope:
 * `<dataDir>/v2/sqlite/backups/runtime-state-before-v2-migration-<ms>-<uuid>.sqlite`
 * and the sidecars written next to it (`-wal`, `-shm`, `-journal`, `.meta.json`).
 * A backup "family" is that file plus its sidecars, or sidecars whose backup
 * file is already gone. Hand-made copies (other names, sub-directories), the
 * live `runtime-state.sqlite` one directory up and anything reached through a
 * symlink are never listed, so they can never be deleted from here.
 *
 * A family is removable once every file in it is older than 3 days by mtime
 * (and the creation time in its name is too). mtime is the last time any
 * process wrote the file, so a backup that is still being copied, was reused,
 * or was just restored by hand always counts as recent and is kept automatically.
 * Manual cleanup bypasses the age rule only for backups proven complete by their sidecar.
 */
import type {
  SqliteBackupSkipReason,
  SqliteBackupFamily,
  SqliteBackupCleanupPlan,
} from '@mavis/shared/storage-cleanup';
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import {
  readBackupFile,
  readVerifiedSidecarIdentity,
  resolvePlainBackupDirectory,
  removePlainFile,
  backupCreatedAtMs,
  BACKUP_FILE_PATTERN,
  BACKUP_SIDECAR_SUFFIXES,
} from '../db/backup.js';

import { DAY_MS, type AgeRetentionPolicy, type StorageRetentionRunControls } from './contracts.js';
import type { StorageRetentionPolicyReport } from './runner.js';

/**
 * SQLite backups are kept for 3 days, then removed by smart cleanup.
 * @internal Exported only for focused tests.
 */
export const SQLITE_BACKUP_RETENTION_MS = 3 * DAY_MS;

type SqliteBackupRemovalStatus = 'removed' | 'skipped' | 'not_found' | 'failed';

interface SqliteBackupRemovalResult {
  readonly id: string;
  readonly status: SqliteBackupRemovalStatus;
  readonly freedBytes: number;
  readonly reason?: SqliteBackupSkipReason;
}

interface SqliteBackupCleanupLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

interface CleanupOptions {
  readonly dataDir: string;
  /** This boot reused it but could not persist its last-used time; preserve the recovery point. */
  readonly backupToKeep?: string | undefined;
  readonly nowMs?: () => number;
  readonly retentionMs?: number;
  /** Manual cleanup requires proof a backup finished writing before bypassing its age. */
  readonly requireVerified?: boolean;
  readonly logger?: SqliteBackupCleanupLogger;
}

interface FamilyMember {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly identity: string;
}

interface CollectedFamily {
  readonly id: string;
  readonly createdAtMs: number;
  readonly members: FamilyMember[];
}

/**
 * Maps a directory entry name to its family id, or undefined when it is not a backup file.
 * @internal Exported only for focused tests.
 */
export function sqliteBackupFamilyId(name: string): string | undefined {
  const suffix = BACKUP_SIDECAR_SUFFIXES.find((candidate) => name.endsWith(candidate));
  const id = suffix ? name.slice(0, -suffix.length) : name;
  return BACKUP_FILE_PATTERN.test(id) ? id : undefined;
}

/** Regular files and identity rules are shared with migration backup creation. */
async function statMember(directory: string, name: string): Promise<FamilyMember | undefined> {
  const path = join(directory, name);
  const info = await readBackupFile(path);
  return info ? { name, path, ...info } : undefined;
}

async function collectFamilies(
  directory: string,
  controls?: StorageRetentionRunControls,
): Promise<{ families: Map<string, CollectedFamily>; truncated: boolean }> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { families: new Map(), truncated: false };
  }
  const families = new Map<string, CollectedFamily>();
  let truncated = false;
  for (const entry of entries) {
    const id = sqliteBackupFamilyId(entry.name);
    if (!id || !entry.isFile() || entry.isSymbolicLink()) continue;
    if (!canInspectFamily(families, id, controls)) {
      truncated = true;
      break;
    }
    const member = await statMember(directory, entry.name);
    if (!member) continue;
    const family = families.get(id) ?? {
      id,
      createdAtMs: backupCreatedAtMs(id) ?? Number.POSITIVE_INFINITY,
      members: [],
    };
    family.members.push(member);
    families.set(id, family);
  }
  return { families, truncated };
}

function canInspectFamily(
  families: ReadonlyMap<string, CollectedFamily>,
  id: string,
  controls?: StorageRetentionRunControls,
): boolean {
  return families.has(id) || !controls || (!controls.shouldStop() && controls.consumeEntry());
}

/** A known family has a fixed set of names; deleting N backups must not rescan N directories. */
async function readFamily(directory: string, id: string): Promise<CollectedFamily | undefined> {
  const members = await Promise.all(
    [id, ...BACKUP_SIDECAR_SUFFIXES.map((suffix) => `${id}${suffix}`)].map((name) =>
      statMember(directory, name),
    ),
  );
  const present = members.filter((member): member is FamilyMember => member !== undefined);
  return present.length > 0
    ? { id, createdAtMs: backupCreatedAtMs(id) ?? Number.POSITIVE_INFINITY, members: present }
    : undefined;
}

function describeFamily(family: CollectedFamily): SqliteBackupFamily {
  const newestMtime = Math.max(...family.members.map((member) => member.mtimeMs));
  return {
    id: family.id,
    bytes: family.members.reduce((sum, member) => sum + member.size, 0),
    fileCount: family.members.length,
    hasDatabaseFile: family.members.some((member) => member.name === family.id),
    lastWrittenAtMs: Math.max(newestMtime, family.createdAtMs),
  };
}

function isExpired(family: SqliteBackupFamily, nowMs: number, retentionMs: number): boolean {
  return Number.isFinite(family.lastWrittenAtMs) && nowMs - family.lastWrittenAtMs > retentionMs;
}

function readNow(options: CleanupOptions): number {
  return (options.nowMs ?? Date.now)();
}

/**
 * Lists what smart cleanup would remove right now; never changes anything.
 * @internal Exported only for focused tests; callers use the service below.
 */
export async function planSqliteBackupCleanup(
  options: CleanupOptions,
): Promise<SqliteBackupCleanupPlan> {
  const nowMs = readNow(options);
  const retentionMs = options.retentionMs ?? SQLITE_BACKUP_RETENTION_MS;
  const directory = await resolvePlainBackupDirectory(options.dataDir);
  const families = directory ? [...(await collectFamilies(directory)).families.values()] : [];
  const removable: SqliteBackupFamily[] = [];
  const kept: (SqliteBackupFamily & { reason: SqliteBackupSkipReason })[] = [];
  for (const family of families.map(describeFamily)) {
    if (family.id !== options.backupToKeep && isExpired(family, nowMs, retentionMs))
      removable.push(family);
    else kept.push({ ...family, reason: 'too_recent' });
  }
  removable.sort((a, b) => b.bytes - a.bytes);
  return {
    retentionMs,
    generatedAtMs: nowMs,
    removable,
    kept,
    removableBytes: removable.reduce((sum, family) => sum + family.bytes, 0),
  };
}

type RemovalOptions = CleanupOptions & { readonly id: string };

/** The family to delete, or the result to return instead when it must be left alone. */
async function readRemovableFamily(
  options: RemovalOptions,
): Promise<
  | { readonly directory: string; readonly family: CollectedFamily; readonly nowMs: number }
  | SqliteBackupRemovalResult
> {
  const { id } = options;
  const notFound: SqliteBackupRemovalResult = { id, status: 'not_found', freedBytes: 0 };
  if (sqliteBackupFamilyId(id) !== id) return notFound;
  const directory = await resolvePlainBackupDirectory(options.dataDir);
  const family = directory ? await readFamily(directory, id) : undefined;
  if (!directory || !family || family.members.length === 0) return notFound;
  const nowMs = readNow(options);
  const reason = await familyProtectionReason(options, family, directory, nowMs);
  if (reason) return { id, status: 'skipped', freedBytes: 0, reason };
  return { directory, family, nowMs };
}

async function familyProtectionReason(
  options: CleanupOptions,
  family: CollectedFamily,
  directory: string,
  nowMs: number,
): Promise<SqliteBackupSkipReason | undefined> {
  if (
    family.id === options.backupToKeep ||
    !isExpired(describeFamily(family), nowMs, options.retentionMs ?? SQLITE_BACKUP_RETENTION_MS)
  )
    return 'too_recent';
  if (
    options.requireVerified &&
    !isExpired(describeFamily(family), nowMs, SQLITE_BACKUP_RETENTION_MS) &&
    !(await isVerifiedFamily(directory, family))
  )
    return 'in_use';
  return undefined;
}

/** A migration writes this sidecar only after its database backup passed integrity checks. */
async function isVerifiedFamily(directory: string, family: CollectedFamily): Promise<boolean> {
  const database = family.members.find((member) => member.name === family.id);
  if (!database) return false;
  try {
    return (
      (await readVerifiedSidecarIdentity(join(directory, `${family.id}.meta.json`))) ===
      database.identity
    );
  } catch {
    return false;
  }
}

/** True when every file is still exactly what was just checked (nothing is writing to it). */
async function familyUnchanged(directory: string, family: CollectedFamily): Promise<boolean> {
  for (const member of family.members) {
    const current = await statMember(directory, member.name);
    if (!current || current.identity !== member.identity) return false;
  }
  return true;
}

async function deleteFamilyFiles(
  family: CollectedFamily,
  logger: SqliteBackupCleanupLogger | undefined,
): Promise<SqliteBackupRemovalResult> {
  let freedBytes = 0;
  try {
    for (const member of family.members) {
      if (!(await removePlainFile(member.path))) throw new Error('backup_member_not_removed');
      freedBytes += member.size;
    }
  } catch (error) {
    logger?.warn(
      { backup: family.id, error: error instanceof Error ? error.message : String(error) },
      'Expired SQLite backup could not be deleted',
    );
    return { id: family.id, status: 'failed', freedBytes };
  }
  return { id: family.id, status: 'removed', freedBytes };
}

/**
 * Re-reads one family and deletes it only if it is still expired and no file
 * in it changed while it was being checked. Each deletion is logged first.
 * @internal Exported only for focused tests; callers use the service below.
 */
export async function removeSqliteBackupFamily(
  options: RemovalOptions,
): Promise<SqliteBackupRemovalResult> {
  const target = await readRemovableFamily(options);
  if ('status' in target) return target;
  const { directory, family, nowMs } = target;
  if (!(await familyUnchanged(directory, family))) {
    return { id: family.id, status: 'skipped', freedBytes: 0, reason: 'changed' };
  }
  const described = describeFamily(family);
  options.logger?.info(
    {
      backup: family.id,
      bytes: described.bytes,
      files: described.fileCount,
      ageDays: Math.floor((nowMs - described.lastWrittenAtMs) / DAY_MS),
    },
    'Deleting expired SQLite backup',
  );
  return deleteFamilyFiles(family, options.logger);
}

/** One bounded policy, shared by startup retention and the manual cleanup pass. */
export function createSqliteBackupRetentionPolicy(options: CleanupOptions): AgeRetentionPolicy {
  return {
    name: 'sqlite_backups',
    retention: { kind: 'age', defaultValue: 3, unitMs: DAY_MS },
    async run(controls) {
      const cleanup = {
        ...options,
        nowMs: () => controls.nowMs,
        retentionMs: controls.manual ? 0 : controls.nowMs - controls.cutoffMs,
        requireVerified: controls.manual === true,
      };
      const directory = await resolvePlainBackupDirectory(options.dataDir);
      if (!directory) return { deletedEntries: 0, deletedBytes: 0 };
      let deletedEntries = 0;
      let deletedBytes = 0;
      const { families, truncated } = await collectFamilies(directory, controls);
      // Automatic cleanup keeps the latest real recovery point; manual cleanup is explicit.
      const latestId = [...families.values()]
        .filter((family) => family.members.some((member) => member.name === family.id))
        .sort((a, b) => b.createdAtMs - a.createdAtMs)[0]?.id;
      for (const id of families.keys()) {
        if (!controls.manual && id === latestId) continue;
        if (controls.shouldStop()) return { deletedEntries, deletedBytes, truncated: true };
        const result = await removeSqliteBackupFamily({ ...cleanup, id });
        if (result.status === 'removed') deletedEntries += 1;
        deletedBytes += result.freedBytes;
      }
      return { deletedEntries, deletedBytes, ...(truncated ? { truncated: true } : {}) };
    },
  };
}

/** Manual "Clean up now" surface used by the Desktop Storage page. */
export interface StorageSmartCleanupService {
  preview(): Promise<SqliteBackupCleanupPlan>;
  /** Available on the owner Runtime after all service policies have been registered. */
  run?(
    signal?: AbortSignal,
    protectedSessionIds?: readonly string[],
  ): Promise<readonly StorageRetentionPolicyReport[]>;
}

export function createStorageSmartCleanupService(
  options: CleanupOptions,
): StorageSmartCleanupService {
  return {
    preview: () => planSqliteBackupCleanup(options),
  };
}
