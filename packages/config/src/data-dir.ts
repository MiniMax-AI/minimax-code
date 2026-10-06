import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NEW_DATA_DIR_BASENAME = '.minimax';
export const LEGACY_DATA_DIR_BASENAME = '.mavis';

export type DataDirMigrationLogger = Pick<Console, 'error' | 'info' | 'warn'>;

export interface ResolveDataDirOptions {
  homeDir?: string;
  profile?: string | null;
  logger?: DataDirMigrationLogger;
  nowMs?: () => number;
}

type PathStateKind = 'missing' | 'inaccessible' | 'link' | 'directory' | 'other';

interface PathState {
  kind: PathStateKind;
  error?: unknown;
}

type ContentState = 'empty' | 'hasData' | 'unknown';

const noopLogger: DataDirMigrationLogger = {
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

function resolveHomeDir(homeDir?: string): string {
  return homeDir ?? os.homedir();
}

function basenameForProfile(base: string, profile?: string | null): string {
  return profile ? `${base}-${profile}` : base;
}

/** Default for new Linux installations; existing installations keep their location. */
export function getPrimaryDataDirPath(homeDir?: string, profile?: string | null): string {
  const resolvedHomeDir = resolveHomeDir(homeDir);
  const previousPrimary = path.join(
    resolvedHomeDir,
    basenameForProfile(NEW_DATA_DIR_BASENAME, profile),
  );
  if (process.platform !== 'linux') return previousPrimary;

  const xdgDataHome = process.env.XDG_DATA_HOME;
  const dataHome = xdgDataHome && path.isAbsolute(xdgDataHome)
    ? xdgDataHome
    : path.join(resolvedHomeDir, '.local', 'share');
  const primary = path.join(dataHome, basenameForProfile('minimax', profile));
  // Do not relocate a live database, hide existing data, or mistake an inaccessible
  // directory / dangling symlink for a fresh install. Older .mavis installations
  // retain the existing migration to .minimax. A compat link from an earlier XDG
  // startup must not cause the next startup to switch back to .minimax.
  if (pathState(previousPrimary).kind !== 'missing') return previousPrimary;
  const legacy = getLegacyDataDirPath(resolvedHomeDir, profile);
  if (pathState(legacy).kind !== 'missing' && !isLinkTo(legacy, primary)) return previousPrimary;
  return primary;
}

export function getLegacyDataDirPath(homeDir?: string, profile?: string | null): string {
  return path.join(resolveHomeDir(homeDir), basenameForProfile(LEGACY_DATA_DIR_BASENAME, profile));
}

function pathState(targetPath: string): PathState {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) return { kind: 'link' };
    if (stat.isDirectory()) return { kind: 'directory' };
    return { kind: 'other' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'inaccessible', error };
  }
}

function normalizeResolvedPathForCompare(targetPath: string): string {
  let normalized = path.resolve(targetPath);
  if (process.platform === 'win32') {
    normalized = normalized.replace(/^\\\\\?\\/, '');
    return normalized.toLowerCase();
  }
  return normalized;
}

function isLinkTo(linkPath: string, target: string): boolean {
  try {
    const resolved = fs.readlinkSync(linkPath);
    const targetPath = normalizeResolvedPathForCompare(target);
    return (
      normalizeResolvedPathForCompare(path.resolve(path.dirname(linkPath), resolved)) ===
        targetPath || normalizeResolvedPathForCompare(resolved) === targetPath
    );
  } catch {
    return false;
  }
}

function createCompatLink(legacyDir: string, newDir: string, logger: DataDirMigrationLogger): void {
  if (isLinkTo(legacyDir, newDir)) return;
  try {
    fs.symlinkSync(newDir, legacyDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    logger.warn(`Failed to create compat link ${legacyDir} -> ${newDir}: ${String(error)}`);
  }
}

function removePathForLink(
  pathToRemove: string,
  state: PathState,
  logger: DataDirMigrationLogger,
): boolean {
  if (state.kind === 'missing') return true;
  if (state.kind === 'link' || state.kind === 'other') {
    try {
      fs.unlinkSync(pathToRemove);
      return true;
    } catch (error) {
      logger.warn(`Failed to remove ${pathToRemove} before creating compat link: ${String(error)}`);
      return false;
    }
  }
  return false;
}

function contentState(dirPath: string): ContentState {
  try {
    const entries = fs.readdirSync(dirPath);
    if (entries.length === 0) return 'empty';
    if (entries.length === 1 && entries[0] === 'workspace') {
      try {
        return fs.readdirSync(path.join(dirPath, 'workspace')).length > 0 ? 'hasData' : 'empty';
      } catch {
        return 'unknown';
      }
    }
    return 'hasData';
  } catch {
    return 'unknown';
  }
}

function linkTargetDirectoryContentState(linkPath: string): ContentState | undefined {
  try {
    if (!fs.statSync(linkPath).isDirectory()) return undefined;
    return contentState(linkPath);
  } catch {
    return 'unknown';
  }
}

function backupPathFor(legacyDir: string, nowMs: () => number): string {
  return `${legacyDir}.backup-${nowMs()}`;
}

function backupRealLegacyDir(
  legacyDir: string,
  logger: DataDirMigrationLogger,
  nowMs: () => number,
): boolean {
  const backupDir = backupPathFor(legacyDir, nowMs);
  try {
    fs.renameSync(legacyDir, backupDir);
    logger.warn(`Backed up legacy data dir ${legacyDir} -> ${backupDir}`);
    return true;
  } catch (error) {
    logger.warn(`Failed to back up legacy data dir ${legacyDir}: ${String(error)}`);
    return false;
  }
}

function prepareLegacyPathForLink(
  legacyDir: string,
  newDir: string,
  logger: DataDirMigrationLogger,
  nowMs: () => number,
): boolean {
  if (isLinkTo(legacyDir, newDir)) return true;
  const legacyState = pathState(legacyDir);
  if (legacyState.kind === 'missing') return true;
  if (legacyState.kind === 'link') {
    const legacyContent = linkTargetDirectoryContentState(legacyDir);
    if (legacyContent === 'hasData' || legacyContent === 'unknown') {
      logger.warn(
        `Cannot replace legacy data dir symlink ${legacyDir}; it may point to real data outside ${newDir}`,
      );
      return false;
    }
    return removePathForLink(legacyDir, legacyState, logger);
  }
  if (legacyState.kind === 'other') {
    return removePathForLink(legacyDir, legacyState, logger);
  }
  if (legacyState.kind === 'directory') {
    return backupRealLegacyDir(legacyDir, logger, nowMs);
  }
  logger.warn(`Cannot replace inaccessible legacy data dir ${legacyDir}; leaving it untouched`);
  return false;
}

function ensureCompatLink(
  legacyDir: string,
  newDir: string,
  logger: DataDirMigrationLogger,
  nowMs: () => number,
): void {
  if (!prepareLegacyPathForLink(legacyDir, newDir, logger, nowMs)) return;
  createCompatLink(legacyDir, newDir, logger);
}

function removeEmptyPrimaryForMigration(newDir: string, logger: DataDirMigrationLogger): boolean {
  try {
    fs.rmSync(newDir, { recursive: true, force: false });
    return true;
  } catch (error) {
    logger.warn(`Failed to remove empty primary data dir ${newDir}: ${String(error)}`);
    return false;
  }
}

function migrateLegacyIntoPrimary(
  legacyDir: string,
  newDir: string,
  logger: DataDirMigrationLogger,
): boolean {
  try {
    fs.renameSync(legacyDir, newDir);
    logger.info(`Migrated legacy data dir ${legacyDir} -> ${newDir}`);
    return true;
  } catch (error) {
    logger.warn(`Failed to migrate legacy data dir ${legacyDir} -> ${newDir}: ${String(error)}`);
    return false;
  }
}

function copyLegacyLinkTargetIntoPrimary(
  targetDir: string,
  legacyDir: string,
  newDir: string,
  logger: DataDirMigrationLogger,
): boolean {
  try {
    fs.cpSync(targetDir, newDir, { recursive: true, errorOnExist: true, force: false });
    fs.unlinkSync(legacyDir);
    try {
      fs.rmSync(targetDir, { recursive: true, force: false });
    } catch (cleanupError) {
      logger.warn(
        `Copied legacy symlink data dir ${targetDir} -> ${newDir}, but failed to remove old target: ${String(cleanupError)}`,
      );
    }
    logger.info(`Copied legacy data dir symlink target ${targetDir} -> ${newDir}`);
    return true;
  } catch (error) {
    try {
      if (fs.existsSync(newDir)) fs.rmSync(newDir, { recursive: true, force: true });
    } catch (cleanupError) {
      logger.warn(`Failed to clean up partial primary data dir ${newDir}: ${String(cleanupError)}`);
    }
    logger.warn(
      `Failed to copy legacy symlink data dir ${legacyDir} -> ${newDir}: ${String(error)}`,
    );
    return false;
  }
}

function migrateLegacyLinkTargetIntoPrimary(
  legacyDir: string,
  newDir: string,
  logger: DataDirMigrationLogger,
): boolean {
  try {
    const targetDir = fs.realpathSync(legacyDir);
    try {
      fs.renameSync(targetDir, newDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        return copyLegacyLinkTargetIntoPrimary(targetDir, legacyDir, newDir, logger);
      }
      throw error;
    }
    fs.unlinkSync(legacyDir);
    logger.info(`Migrated legacy data dir symlink target ${targetDir} -> ${newDir}`);
    return true;
  } catch (error) {
    logger.warn(
      `Failed to migrate legacy symlink data dir ${legacyDir} -> ${newDir}: ${String(error)}`,
    );
    return false;
  }
}

function ensurePrimaryDir(newDir: string, logger: DataDirMigrationLogger): boolean {
  try {
    fs.mkdirSync(newDir, { recursive: true });
    return true;
  } catch (error) {
    logger.warn(`Failed to create primary data dir ${newDir}: ${String(error)}`);
    return false;
  }
}

function resolveDataDirPair(
  newDir: string,
  legacyDir: string,
  logger: DataDirMigrationLogger,
  nowMs: () => number,
): string {
  const newState = pathState(newDir);
  const legacyState = pathState(legacyDir);

  if (newState.kind === 'inaccessible') {
    logger.warn(`Primary data dir ${newDir} is inaccessible; not treating it as missing`);
    return newDir;
  }

  if (newState.kind === 'link' || newState.kind === 'other') {
    logger.warn(
      `Primary data dir path ${newDir} exists but is not a directory; using it without migration`,
    );
    return newDir;
  }

  if (newState.kind === 'directory') {
    const newContent = contentState(newDir);
    const legacyContent =
      legacyState.kind === 'directory'
        ? contentState(legacyDir)
        : legacyState.kind === 'link'
          ? (linkTargetDirectoryContentState(legacyDir) ?? 'empty')
          : 'empty';

    if (newContent === 'empty') {
      if (legacyState.kind === 'inaccessible' || legacyContent === 'unknown') {
        logger.warn(
          `Legacy data dir ${legacyDir} may contain data but is inaccessible; not using empty primary ${newDir}`,
        );
        return legacyDir;
      }

      if (
        (legacyState.kind === 'directory' || legacyState.kind === 'link') &&
        legacyContent === 'hasData'
      ) {
        if (!removeEmptyPrimaryForMigration(newDir, logger)) return legacyDir;
        if (legacyState.kind === 'link') {
          if (!migrateLegacyLinkTargetIntoPrimary(legacyDir, newDir, logger)) return legacyDir;
        } else if (!migrateLegacyIntoPrimary(legacyDir, newDir, logger)) {
          return legacyDir;
        }
        createCompatLink(legacyDir, newDir, logger);
        return newDir;
      }
    }

    ensureCompatLink(legacyDir, newDir, logger, nowMs);
    return newDir;
  }

  if (isLinkTo(legacyDir, newDir)) {
    ensurePrimaryDir(newDir, logger);
    return newDir;
  }

  if (legacyState.kind === 'directory') {
    if (migrateLegacyIntoPrimary(legacyDir, newDir, logger)) {
      createCompatLink(legacyDir, newDir, logger);
      return newDir;
    }
    return legacyDir;
  }

  if (legacyState.kind === 'link') {
    const legacyContent = linkTargetDirectoryContentState(legacyDir);
    if (legacyContent === 'hasData') {
      if (migrateLegacyLinkTargetIntoPrimary(legacyDir, newDir, logger)) {
        createCompatLink(legacyDir, newDir, logger);
        return newDir;
      }
      return legacyDir;
    }
    if (legacyContent === 'unknown') {
      logger.warn(
        `Legacy data dir symlink ${legacyDir} target is inaccessible; not treating it as missing`,
      );
      return legacyDir;
    }
  }

  if (legacyState.kind === 'inaccessible') {
    logger.warn(`Legacy data dir ${legacyDir} is inaccessible; not treating it as missing`);
    return legacyDir;
  }

  ensurePrimaryDir(newDir, logger);
  ensureCompatLink(legacyDir, newDir, logger, nowMs);
  return newDir;
}

export function resolveDataDir(options: ResolveDataDirOptions = {}): string {
  const homeDir = resolveHomeDir(options.homeDir);
  const profile = options.profile ?? null;
  return resolveDataDirPair(
    getPrimaryDataDirPath(homeDir, profile),
    getLegacyDataDirPath(homeDir, profile),
    options.logger ?? noopLogger,
    options.nowMs ?? Date.now,
  );
}

export function migrateDefaultDataDir(homeDir?: string, logger?: DataDirMigrationLogger): string {
  return resolveDataDir({ homeDir, logger });
}

export function migrateProfileDataDir(
  profile: string,
  homeDir?: string,
  logger?: DataDirMigrationLogger,
): string {
  return resolveDataDir({ homeDir, profile, logger });
}
