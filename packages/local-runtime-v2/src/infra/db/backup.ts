import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { join } from 'node:path';

import type { DatabaseClient } from './client.js';

/** Directory of pre-migration database backups, relative to dataDir. */
const BACKUP_DIRECTORY = join('v2', 'sqlite', 'backups');
const BACKUP_FILE_PREFIX = 'runtime-state-before-v2-migration';
/** `runtime-state-before-v2-migration-<createdAtMs>-<uuid>.sqlite`; group 1 is createdAtMs. */
export const BACKUP_FILE_PATTERN = new RegExp(
  `^${BACKUP_FILE_PREFIX}-(\\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.sqlite$`,
  'iu',
);
const BACKUP_META_SUFFIX = '.meta.json';
/** Files written next to a backup: SQLite journals of the copy and the reuse sidecar. */
export const BACKUP_SIDECAR_SUFFIXES: readonly string[] = [
  '-wal',
  '-shm',
  '-journal',
  BACKUP_META_SUFFIX,
];
/** Headroom over the current database size so WAL growth during the copy cannot ENOSPC mid-write. */
const BACKUP_DISK_SPACE_HEADROOM = 1.2;

const DATABASE_BACKUP_INITIALIZATION_ERROR_CODE = 'LOCAL_RUNTIME_V2_DATABASE_BACKUP_FAILED';
const DATABASE_BACKUP_DISK_SPACE_ERROR_CODE = 'LOCAL_RUNTIME_V2_DATABASE_BACKUP_DISK_SPACE';

class DatabaseBackupInitializationError extends Error {
  readonly code = DATABASE_BACKUP_INITIALIZATION_ERROR_CODE;

  constructor(cause?: unknown) {
    super('Local runtime database backup failed');
    this.name = 'DatabaseBackupInitializationError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Fail-stop error raised before any backup bytes are written when the backup
 * volume cannot hold a full copy of the database. Migrating without a backup
 * or leaving a truncated copy behind are both unacceptable, so this aborts
 * initialization with its own stable code instead of the generic backup error.
 */
class DatabaseBackupDiskSpaceError extends Error {
  readonly code = DATABASE_BACKUP_DISK_SPACE_ERROR_CODE;
  readonly requiredBytes: number;
  readonly availableBytes: number;

  constructor(requiredBytes: number, availableBytes: number) {
    super('Local runtime database backup needs more free disk space');
    this.name = 'DatabaseBackupDiskSpaceError';
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

/**
 * One backup per migration campaign: the campaign key binds the source
 * database file identity to the exact applied/pending version state, so a
 * crash-retry loop reuses the first verified backup instead of stacking
 * whole-database copies.
 */
interface DatabaseBackupCampaign {
  readonly appliedMaxVersion: number;
  readonly pendingVersions: readonly number[];
}

type SourceDbIdentity =
  | { readonly dev: number; readonly ino: number; readonly birthtimeMs: number }
  | 'missing';

interface DatabaseBackupSidecar {
  readonly schemaVersion: 1;
  readonly campaignKey: string;
  readonly sourceDbIdentity: SourceDbIdentity;
  readonly verifiedFileIdentity: string;
  readonly appliedMaxVersion: number;
  readonly pendingVersions: readonly number[];
  readonly createdAtMs: number;
}

export type DatabaseBackupResult =
  | { readonly created: false; readonly reused?: false }
  | ReusedDatabaseBackup
  | CreatedDatabaseBackup;

interface ReusedDatabaseBackup {
  readonly created: false;
  readonly reused: true;
  /** Non-fatal: this boot must keep the backup even if its age could not be refreshed. */
  readonly retentionRefreshError?: string;
  readonly fileName: string;
  readonly campaignKey: string;
  /** Creation time recorded by the sidecar of the reused backup. */
  readonly createdAtMs: number;
}

export interface CreatedDatabaseBackup {
  readonly created: true;
  readonly reused?: false;
  readonly backupId: string;
  readonly fileName: string;
  readonly campaignKey: string;
  readonly createdAtMs: number;
  /** File metadata captured before the successful integrity check, valid only in this run. */
  readonly verifiedFileIdentity: string;
  /** Wall-clock cost of the online backup copy, for startup timing diagnostics. */
  readonly backupMs: number;
  /** Wall-clock cost of the post-copy integrity verification. */
  readonly integrityMs: number;
  /** Size of the produced backup file, or undefined when it could not be read. */
  readonly sizeBytes?: number;
}

interface DatabaseBackupPort {
  readonly databasePath: string;
  backup(destinationPath: string): Promise<void>;
  hasValidIntegrity(databasePath: string): boolean;
}

export interface CreateDatabaseBackupOptions {
  readonly database: Pick<DatabaseClient, keyof DatabaseBackupPort>;
  readonly dataDir: string;
  /** Determined by migration preflight; undefined means no pending migrations and no backup. */
  readonly campaign?: DatabaseBackupCampaign;
}

export interface DatabaseBackupRetentionResult {
  readonly deleted: number;
  readonly retainedFileName?: string;
}

/** Creates or reuses a verified online SQLite backup for the current migration campaign. */
export async function createDatabaseBackupIfPending(
  options: CreateDatabaseBackupOptions,
): Promise<DatabaseBackupResult> {
  const campaign = options.campaign;
  if (!campaign) return { created: false };

  const createdAtMs = Date.now();
  const backupId = randomUUID();
  const fileName = `${BACKUP_FILE_PREFIX}-${createdAtMs}-${backupId}.sqlite`;
  let resolvedDataDir: string | undefined;
  let destinationPath: string | undefined;

  try {
    resolvedDataDir = await resolveVerifiedBackupRoot(options.dataDir);
    const directoryPath = join(resolvedDataDir, BACKUP_DIRECTORY);
    const sourceDbIdentity = await readSourceDbIdentity(options.database.databasePath);
    const campaignKey = computeCampaignKey(campaign, sourceDbIdentity);
    const reusable = await findReusableCampaignBackup(directoryPath, campaignKey);
    if (reusable) {
      try {
        await refreshReusedBackupSidecar(
          join(directoryPath, `${reusable.fileName}${BACKUP_META_SUFFIX}`),
        );
        return reusable;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return {
          ...reusable,
          retentionRefreshError: typeof code === 'string' ? code : 'refresh_failed',
        };
      }
    }
    await assertBackupDiskSpace(options.database.databasePath, directoryPath);
    destinationPath = join(directoryPath, fileName);
    return await writeVerifiedCampaignBackup({
      database: options.database,
      resolvedDataDir,
      destinationPath,
      campaign,
      campaignKey,
      sourceDbIdentity,
      backupId,
      fileName,
      createdAtMs,
    });
  } catch (error) {
    await removeFailedBackupFamily(resolvedDataDir, destinationPath);
    if (error instanceof DatabaseBackupDiskSpaceError) throw error;
    throw new DatabaseBackupInitializationError(error);
  }
}

/** Resolves the dataDir and validates/creates the backup directory chain. */
async function resolveVerifiedBackupRoot(dataDir: string): Promise<string> {
  const resolved = await resolveBackupDataDir(dataDir);
  if (!resolved || !(await ensurePlainBackupDirectoryChain(resolved))) {
    throw new Error('unsafe backup directory');
  }
  return resolved;
}

/** Copies the database, verifies integrity, and records the campaign sidecar. */
async function writeVerifiedCampaignBackup(input: {
  readonly database: CreateDatabaseBackupOptions['database'];
  readonly resolvedDataDir: string;
  readonly destinationPath: string;
  readonly campaign: DatabaseBackupCampaign;
  readonly campaignKey: string;
  readonly sourceDbIdentity: SourceDbIdentity;
  readonly backupId: string;
  readonly fileName: string;
  readonly createdAtMs: number;
}): Promise<CreatedDatabaseBackup> {
  const backupStartedAtMs = Date.now();
  await input.database.backup(input.destinationPath);
  const backupMs = Math.max(0, Date.now() - backupStartedAtMs);
  if (!(await hasPlainBackupDirectoryChain(input.resolvedDataDir))) {
    throw new Error('unsafe backup directory after write');
  }
  const integrityStartedAtMs = Date.now();
  const verifiedFileIdentity = await verifyCreatedBackup(input.database, input.destinationPath);
  const integrityMs = Math.max(0, Date.now() - integrityStartedAtMs);
  const sizeBytes = readIdentitySizeBytes(verifiedFileIdentity);
  await writeCampaignSidecar(input.destinationPath, {
    schemaVersion: 1,
    campaignKey: input.campaignKey,
    sourceDbIdentity: input.sourceDbIdentity,
    verifiedFileIdentity,
    appliedMaxVersion: input.campaign.appliedMaxVersion,
    pendingVersions: sortedVersions(input.campaign.pendingVersions),
    createdAtMs: input.createdAtMs,
  });
  return {
    created: true,
    backupId: input.backupId,
    fileName: input.fileName,
    campaignKey: input.campaignKey,
    createdAtMs: input.createdAtMs,
    verifiedFileIdentity,
    backupMs,
    integrityMs,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  };
}

/** Best-effort removal of a half-written backup family after a failure. */
async function removeFailedBackupFamily(
  resolvedDataDir: string | undefined,
  destinationPath: string | undefined,
): Promise<void> {
  if (!resolvedDataDir || !destinationPath) return;
  if (!(await hasPlainBackupDirectoryChain(resolvedDataDir))) return;
  await removeBackupFamily(destinationPath);
}

function computeCampaignKey(
  campaign: DatabaseBackupCampaign,
  sourceDbIdentity: SourceDbIdentity,
): string {
  // Stable JSON: fixed property order, sorted pending versions, floored
  // birthtime. Every field is deterministic for an unchanged campaign.
  const material = JSON.stringify({
    appliedMaxVersion: campaign.appliedMaxVersion,
    pendingVersions: sortedVersions(campaign.pendingVersions),
    source:
      sourceDbIdentity === 'missing'
        ? 'missing'
        : {
            dev: sourceDbIdentity.dev,
            ino: sourceDbIdentity.ino,
            birthtimeMs: sourceDbIdentity.birthtimeMs,
          },
  });
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

function sortedVersions(versions: readonly number[]): number[] {
  return [...versions].sort((left, right) => left - right);
}

async function readSourceDbIdentity(databasePath: string): Promise<SourceDbIdentity> {
  try {
    const info = await stat(databasePath);
    if (!info.isFile()) return 'missing';
    return { dev: info.dev, ino: info.ino, birthtimeMs: Math.floor(info.birthtimeMs) };
  } catch {
    return 'missing';
  }
}

/** Prechecks disk headroom (1.2x DB + WAL) before copying; skips if statfs is unavailable. */
async function assertBackupDiskSpace(databasePath: string, directoryPath: string): Promise<void> {
  let availableBytes: number;
  try {
    const stats = await statfs(directoryPath);
    availableBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return;
  }
  if (!Number.isFinite(availableBytes) || availableBytes < 0) return;
  const requiredBytes = Math.ceil(
    ((await readFileSizeBytes(databasePath)) + (await readFileSizeBytes(`${databasePath}-wal`))) *
      BACKUP_DISK_SPACE_HEADROOM,
  );
  if (availableBytes < requiredBytes) {
    throw new DatabaseBackupDiskSpaceError(requiredBytes, availableBytes);
  }
}

async function readFileSizeBytes(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

/** Scans backup .meta.json sidecars for the earliest verified backup of the same campaign. */
async function findReusableCampaignBackup(
  directoryPath: string,
  campaignKey: string,
): Promise<ReusedDatabaseBackup | undefined> {
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let earliest: ReusedDatabaseBackup | undefined;
  for (const entry of entries) {
    const candidate = await readReusableCampaignBackup(directoryPath, entry, campaignKey);
    if (!candidate) continue;
    if (!earliest || candidate.createdAtMs < earliest.createdAtMs) earliest = candidate;
  }
  return earliest;
}

/** Evaluates one directory entry as a reusable same-campaign backup sidecar. */
async function readReusableCampaignBackup(
  directoryPath: string,
  entry: Dirent,
  campaignKey: string,
): Promise<ReusedDatabaseBackup | undefined> {
  if (!entry.isFile() || entry.isSymbolicLink()) return undefined;
  if (!entry.name.endsWith(BACKUP_META_SUFFIX)) return undefined;
  const backupFileName = entry.name.slice(0, -BACKUP_META_SUFFIX.length);
  if (!BACKUP_FILE_PATTERN.test(backupFileName)) return undefined;
  const sidecar = await readCampaignSidecar(join(directoryPath, entry.name));
  if (!sidecar || sidecar.campaignKey !== campaignKey) return undefined;
  const backupIdentity = await readBackupFileIdentity(join(directoryPath, backupFileName));
  if (!backupIdentity || backupIdentity !== sidecar.verifiedFileIdentity) return undefined;
  return {
    created: false,
    reused: true,
    fileName: backupFileName,
    campaignKey,
    createdAtMs: sidecar.createdAtMs,
  };
}

/** Refresh retention without changing the verified database file or its identity. */
async function refreshReusedBackupSidecar(path: string): Promise<void> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('unsafe backup sidecar');
  const file = await open(path, 'r+');
  try {
    const current = await file.stat();
    if (!current.isFile() || backupFileIdentity(current) !== backupFileIdentity(before)) {
      throw new Error('backup sidecar changed before reuse');
    }
    const reusedAt = new Date(Date.now());
    await file.utimes(reusedAt, reusedAt);
  } finally {
    await file.close();
  }
}

async function readCampaignSidecar(path: string): Promise<DatabaseBackupSidecar | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) return undefined;
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isDatabaseBackupSidecar(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isDatabaseBackupSidecar(value: unknown): value is DatabaseBackupSidecar {
  if (!value || typeof value !== 'object') return false;
  const sidecar = value as Partial<DatabaseBackupSidecar>;
  return (
    sidecar.schemaVersion === 1 &&
    typeof sidecar.campaignKey === 'string' &&
    sidecar.campaignKey.length > 0 &&
    typeof sidecar.verifiedFileIdentity === 'string' &&
    sidecar.verifiedFileIdentity.length > 0 &&
    typeof sidecar.createdAtMs === 'number' &&
    Number.isSafeInteger(sidecar.createdAtMs)
  );
}

/** Writes the campaign sidecar best-effort after integrity verification succeeds. */
async function writeCampaignSidecar(
  destinationPath: string,
  sidecar: DatabaseBackupSidecar,
): Promise<void> {
  try {
    await writeFile(`${destinationPath}${BACKUP_META_SUFFIX}`, `${JSON.stringify(sidecar)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch {
    // Reuse metadata is best-effort; the verified backup itself stays valid.
  }
}

/**
 * 在完整 migration 与最终 schema 校验成功后，仅以本次创建的精确备份
 * 为删除授权。普通启动不得调用；未知、同时间或更新的文件一律保留。
 */
export async function pruneSupersededDatabaseBackups(options: {
  readonly dataDir: string;
  readonly retainedBackup: CreatedDatabaseBackup;
}): Promise<DatabaseBackupRetentionResult> {
  if (!validCreatedBackupIdentity(options.retainedBackup)) return { deleted: 0 };
  const resolvedDataDir = await resolveBackupDataDir(options.dataDir);
  if (!resolvedDataDir || !(await hasPlainBackupDirectoryChain(resolvedDataDir))) {
    return { deleted: 0 };
  }
  const directoryPath = join(resolvedDataDir, BACKUP_DIRECTORY);
  const retainedPath = join(directoryPath, options.retainedBackup.fileName);
  const verifiedIdentity = options.retainedBackup.verifiedFileIdentity;
  if (!verifiedIdentity || (await readBackupFileIdentity(retainedPath)) !== verifiedIdentity) {
    return { deleted: 0 };
  }
  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    return { deleted: 0 };
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .flatMap((entry) => {
      const createdAtMs = backupCreatedAtMs(entry.name);
      return createdAtMs !== undefined ? [{ fileName: entry.name, createdAtMs }] : [];
    })
    .filter(
      (candidate) =>
        candidate.fileName !== options.retainedBackup.fileName &&
        candidate.createdAtMs < options.retainedBackup.createdAtMs,
    );
  const deleted = await candidates.reduce<Promise<number>>(async (countPromise, candidate) => {
    const count = await countPromise;
    if (!(await hasPlainBackupDirectoryChain(resolvedDataDir))) return count;
    if ((await readBackupFileIdentity(retainedPath)) !== verifiedIdentity) return count;
    const path = join(directoryPath, candidate.fileName);
    if (!(await removePlainFile(path))) return count;
    await removeBackupSidecars(path);
    return count + 1;
  }, Promise.resolve(0));
  return { deleted, retainedFileName: options.retainedBackup.fileName };
}

function validCreatedBackupIdentity(backup: CreatedDatabaseBackup): boolean {
  if (!Number.isSafeInteger(backup.createdAtMs) || backup.createdAtMs < 0) return false;
  const expectedFileName = `${BACKUP_FILE_PREFIX}-${String(backup.createdAtMs)}-${backup.backupId}.sqlite`;
  return backup.fileName === expectedFileName && BACKUP_FILE_PATTERN.test(backup.fileName);
}

async function resolveBackupDataDir(dataDir: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(dataDir);
    return (await isPlainDirectory(resolved)) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

async function ensurePlainBackupDirectoryChain(dataDir: string): Promise<boolean> {
  const paths = backupDirectoryChain(dataDir);
  for (const [index, path] of paths.entries()) {
    if (!(await ensurePlainDirectory(path, index > 0))) return false;
  }
  return true;
}

async function ensurePlainDirectory(path: string, createIfMissing: boolean): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (!createIfMissing || !hasCode(error, 'ENOENT')) return false;
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) return false;
  }
  return isPlainDirectory(path);
}

async function removeBackupFamily(databasePath: string): Promise<void> {
  await removePlainFile(databasePath);
  await removeBackupSidecars(databasePath);
}

async function removeBackupSidecars(databasePath: string): Promise<void> {
  // A copy killed mid-write leaves its rollback journal next to it; drop it
  // with the copy so no orphan outlives the backup it belonged to.
  await Promise.all(
    BACKUP_SIDECAR_SUFFIXES.map((suffix) => removePlainFile(`${databasePath}${suffix}`)),
  );
}

export async function removePlainFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    await rm(path);
    return true;
  } catch {
    return false;
  }
}

async function hasPlainBackupDirectoryChain(dataDir: string): Promise<boolean> {
  for (const path of backupDirectoryChain(dataDir)) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function verifyCreatedBackup(database: DatabaseBackupPort, path: string): Promise<string> {
  const identity = await readBackupFileIdentity(path);
  if (!identity || !database.hasValidIntegrity(path)) throw new Error('integrity check failed');
  return identity;
}

/** Shared file-change check for migration reuse and expiration cleanup. */
function backupFileIdentity(
  info: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>,
): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
}

/** A plain backup member and the identity shared by reuse and retention. */
export async function readBackupFile(
  path: string,
): Promise<{ size: number; mtimeMs: number; identity: string } | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    return { size: info.size, mtimeMs: info.mtimeMs, identity: backupFileIdentity(info) };
  } catch {
    return undefined;
  }
}

async function readBackupFileIdentity(path: string): Promise<string | undefined> {
  return (await readBackupFile(path))?.identity;
}

/** Validate the full sidecar schema before accepting proof that a backup finished. */
export async function readVerifiedSidecarIdentity(path: string): Promise<string | undefined> {
  return (await readCampaignSidecar(path))?.verifiedFileIdentity;
}

export function backupCreatedAtMs(name: string): number | undefined {
  const match = BACKUP_FILE_PATTERN.exec(name);
  const value = match?.[1] ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Resolve the same plain directory chain used when creating and rotating backups. */
export async function resolvePlainBackupDirectory(dataDir: string): Promise<string | undefined> {
  const root = await resolveBackupDataDir(dataDir);
  return root && (await hasPlainBackupDirectoryChain(root))
    ? join(root, BACKUP_DIRECTORY)
    : undefined;
}

/**
 * Recovers the size component from an already-captured identity string so the
 * timing diagnostics never issue an extra stat against the backup file.
 */
function readIdentitySizeBytes(identity: string): number | undefined {
  const size = Number(identity.split(':')[2]);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function backupDirectoryChain(dataDir: string): readonly string[] {
  return [
    dataDir,
    join(dataDir, 'v2'),
    join(dataDir, 'v2', 'sqlite'),
    join(dataDir, BACKUP_DIRECTORY),
  ];
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === code);
}
