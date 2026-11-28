import fs from 'node:fs';
import path from 'node:path';

/** Resolve and compare one filesystem identity with the host platform's case rules. */
export function isSameResolvedPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const resolvedLeft = pathApi.resolve(left);
  const resolvedRight = pathApi.resolve(right);
  return platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

/** Final-component symlink hops followed before giving up on a chain. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Entries resolved through their parent. A folder the process cannot enter
 * hides nothing it could reach either, so its path is judged as written.
 */
const MISSING_ENTRY_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

/**
 * The real location of an absolute path: the real path of its nearest existing
 * ancestor joined with the rest. `fs.realpathSync.native` also returns the
 * on-disk letter case, which `fs.realpathSync` keeps from the input on macOS.
 *
 * Returns `undefined` when an existing entry cannot be resolved (a symlink
 * loop): the caller must not treat such a path as inside any boundary.
 */
export function resolveCanonicalPath(filePath: string): string | undefined {
  const absolute = path.resolve(filePath);
  try {
    return fs.realpathSync.native(absolute);
  } catch (error) {
    if (!MISSING_ENTRY_CODES.has(errorCode(error))) return realPathWithoutNative(absolute);
  }
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  const canonicalParent = resolveCanonicalPath(parent);
  return canonicalParent === undefined
    ? undefined
    : path.join(canonicalParent, path.basename(absolute));
}

/**
 * Some Windows volumes (RAM disks, virtual drives) fail the native call on
 * healthy paths. The JS walk still reports a symlink loop or missing permission.
 */
function realPathWithoutNative(absolute: string): string | undefined {
  try {
    return fs.realpathSync(absolute);
  } catch {
    return undefined;
  }
}

/**
 * Whether an absolute path reaches `root` under another letter case on a
 * case-insensitive volume (the macOS default): `FOLDER-B/x` for `folder-b`.
 * The prefix counts as the root only when the filesystem resolves both to the
 * same directory, so a case-sensitive volume keeps them apart. Windows callers
 * already compare case-insensitively.
 */
export function reachesRootInOtherCase(target: string, root: string): boolean {
  if (process.platform === 'win32' || target.length < root.length) return false;
  if (target.length > root.length && target[root.length] !== path.sep) return false;
  const prefix = target.slice(0, root.length);
  if (prefix === root || prefix.toLowerCase() !== root.toLowerCase()) return false;
  const realPrefix = resolveCanonicalPath(prefix);
  return realPrefix !== undefined && realPrefix === resolveCanonicalPath(root);
}

const SEGMENT_SEPARATOR = process.platform === 'win32' ? /[\\/]/u : /\//u;

/**
 * The absolute spelling of a path with its `..` segments kept, or `undefined`
 * when it has none. A shell walks `link/..` physically to the parent of the
 * link's target, which `path.resolve` folds away.
 */
export function unfoldedAbsolutePath(
  inputPath: string,
  workingDirectory: string | undefined,
  homeDir: string | undefined,
): string | undefined {
  const raw = inputPath.trim();
  if (!raw.split(SEGMENT_SEPARATOR).includes('..')) return undefined;
  if (raw.startsWith('~/')) return homeDir ? `${homeDir}${raw.slice(1)}` : undefined;
  return path.isAbsolute(raw) ? raw : `${workingDirectory ?? process.cwd()}${path.sep}${raw}`;
}

/** Where a shell ends up following a path segment by segment. */
export function resolvePhysicalPath(unfolded: string): string | undefined {
  const { root } = path.parse(unfolded);
  let current = root;
  for (const segment of unfolded.slice(root.length).split(SEGMENT_SEPARATOR)) {
    if (!segment || segment === '.') continue;
    if (segment !== '..') {
      current = path.join(current, segment);
      continue;
    }
    const real = resolveCanonicalPath(current);
    if (real === undefined) return undefined;
    current = path.dirname(real);
  }
  return resolveCanonicalPath(current);
}

/**
 * Every location one file operation can reach: the lexical path, each hop of a
 * symlink chain on its final component, its real path and, for an `unfolded`
 * path, where a shell would land. A path counts as inside a boundary only when
 * all of them are, and a protected name anywhere in the set protects the
 * operation.
 *
 * Returns `undefined` when the real path cannot be resolved.
 */
export function resolvePathIdentities(
  resolvedPath: string,
  unfolded?: string,
): readonly string[] | undefined {
  const identities = new Set<string>([resolvedPath]);
  let current = resolvedPath;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    let target: string;
    try {
      target = fs.readlinkSync(current);
    } catch {
      break;
    }
    current = path.resolve(path.dirname(current), target);
    if (identities.has(current)) break;
    identities.add(current);
    // A hop through a linked directory lands at that directory's real place,
    // even when the final target does not exist yet.
    const hopReal = resolveCanonicalPath(current);
    if (hopReal !== undefined) identities.add(hopReal);
  }
  const canonical = resolveCanonicalPath(resolvedPath);
  if (canonical === undefined) return undefined;
  identities.add(canonical);
  if (unfolded !== undefined) {
    const physical = resolvePhysicalPath(unfolded);
    if (physical === undefined) return undefined;
    identities.add(physical);
  }
  return [...identities];
}

/**
 * Whether a delete of `inputPath` acts on the directory entry itself, as `rm`
 * and `mv` do on a symlink, rather than on what it points to. A trailing
 * separator makes a shell follow the link; Windows deletes keep following.
 */
export function namesDirectoryEntry(inputPath: string): boolean {
  if (process.platform === 'win32') return false;
  const raw = inputPath.trim();
  if (raw.endsWith('/')) return false;
  const last = raw.split('/').pop();
  return last !== undefined && last !== '' && last !== '.' && last !== '..' && last !== '~';
}

/** Where a directory entry itself is: its parent's real location and its name. */
export function resolveEntryLocation(resolvedPath: string): string | undefined {
  const parent = resolveCanonicalPath(path.dirname(resolvedPath));
  return parent === undefined ? undefined : path.join(parent, path.basename(resolvedPath));
}

/** Where a shell finds a directory entry itself, without following it. */
export function resolvePhysicalEntry(unfolded: string): string | undefined {
  const parent = resolvePhysicalPath(path.dirname(unfolded));
  return parent === undefined ? undefined : path.join(parent, path.basename(unfolded));
}

/**
 * The locations one operation reaches: a delete of a directory entry reaches
 * the entry, not what a symlink there points to (see `namesDirectoryEntry`).
 */
export function resolveOperationIdentities(
  inputPath: string,
  resolvedPath: string,
  unfolded: string | undefined,
  action: string | undefined,
): readonly string[] | undefined {
  if (action !== 'delete' || !namesDirectoryEntry(inputPath)) {
    return resolvePathIdentities(resolvedPath, unfolded);
  }
  const entry = resolveEntryLocation(resolvedPath);
  if (entry === undefined) return undefined;
  const identities = new Set([resolvedPath, entry]);
  if (unfolded !== undefined) {
    const physical = resolvePhysicalEntry(unfolded);
    if (physical === undefined) return undefined;
    identities.add(physical);
  }
  return [...identities];
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}
