import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isRetryableWindowsFileError } from '@mavis/shared';

import { logger } from '../../../../infra/logging/logger.js';
import { KeyedOperationQueue } from '../../../../infra/util/keyed-operation-queue.js';
import { PluginSystemError } from '../../errors.js';
import { isMiniAppRuntimePayloadExcludedPath, isPathCoveredByRoots } from './miniapp/path.js';

export const PLUGIN_PACKAGE_V1_LIMITS = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxArchiveEntries: 2_048,
  maxFiles: 1_024,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxPathBytes: 512,
  maxSegmentBytes: 128,
  maxPathSegments: 16,
} as const;

const CONTENT_MAGIC = Buffer.from('MINIMAX-PLUGIN-CONTENT-DIGEST\0', 'ascii');
const CONTENT_DIGEST_PATTERN = /^sha256-tree-v1:([0-9a-f]{64})$/u;
const PORTABLE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_value, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_value, index) => `lpt${index + 1}`),
]);

type PluginContractEntryKind =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'hardlink'
  | 'socket'
  | 'fifo'
  | 'device'
  | 'special';

export type PluginPackagePathPolicy = 'minimax-portable' | 'agent-plugin' | 'unrestricted';

/** File and package byte limits; defaults to `PLUGIN_PACKAGE_V1_LIMITS`. */
export interface PluginPackageSizeLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

const DEFAULT_SIZE_LIMITS: PluginPackageSizeLimits = {
  maxFileBytes: PLUGIN_PACKAGE_V1_LIMITS.maxFileBytes,
  maxTotalBytes: PLUGIN_PACKAGE_V1_LIMITS.maxTotalBytes,
};

export interface PluginPackageDigestOptions {
  readonly pathPolicy?: PluginPackagePathPolicy;
  readonly sizeLimits?: PluginPackageSizeLimits;
  readonly rejectHardlinks?: boolean;
  /**
   * Apply the Windows segment rules (`<>:"|?*`, trailing `.`/space, reserved
   * device names) to `agent-plugin` paths on every host, not only on win32.
   * Work Share packages must install on every recipient platform.
   */
  readonly enforceWindowsNames?: boolean;
  /** Skips a root-relative POSIX path (and everything below it) before it is inspected. */
  readonly exclude?: (relativePath: string) => boolean;
}

export interface MiniAppArtifactRoots {
  readonly client: readonly string[];
  readonly node: readonly string[];
}

export interface MiniAppPackageDigests {
  readonly contentDigest: string;
  readonly clientDigest: string;
  readonly nodeDigest: string;
  readonly ordinaryContentDigest?: string;
}

export interface MiniAppPackageDigestOptions {
  readonly includeOrdinaryContentDigest?: boolean;
  readonly sizeLimits?: PluginPackageSizeLimits;
  readonly rejectHardlinks?: boolean;
}

export interface PluginContractEntry {
  readonly path: string;
  readonly kind: PluginContractEntryKind;
  readonly content?: Buffer;
  readonly declaredSize?: number;
  readonly compression?: string;
}

export interface PluginContentDigestResult {
  readonly contentDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly PluginContractEntry[];
}

export class PluginPackageContractError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PluginPackageContractError';
  }
}

export function validatePluginPortablePath(relativePath: string): void {
  assertPortablePathShape(relativePath);
  const segments = relativePath.split('/');
  if (segments.length > PLUGIN_PACKAGE_V1_LIMITS.maxPathSegments) {
    fail('PATH_TOO_DEEP', `${JSON.stringify(relativePath)} has too many segments`);
  }
  for (const segment of segments) assertPortablePathSegment(segment, relativePath);
}

/**
 * Agent Plugins only require package paths to remain inside the Plugin root.
 * Keep the MiniMax marketplace's stricter cross-platform naming contract separate
 * so standards-compliant GitHub Plugins may contain ordinary names such as
 * `docs/(redirects)/guide.md` or non-ASCII assets. Windows segment rules apply
 * on win32 hosts, or on every host with `enforceWindowsNames` (Work Share,
 * mirrored by archon_server `digest.PathPolicyAgentPlugin`).
 */
function validateAgentPluginPath(relativePath: string, enforceWindowsNames: boolean): void {
  assertContainedPathShape(relativePath);
  const segments = relativePath.split('/');
  if (segments.length > PLUGIN_PACKAGE_V1_LIMITS.maxPathSegments) {
    fail('PATH_TOO_DEEP', `${JSON.stringify(relativePath)} has too many segments`);
  }
  for (const segment of segments) {
    assertContainedPathSegment(segment, relativePath, enforceWindowsNames);
  }
}

function assertPortablePathShape(relativePath: string): void {
  if (!relativePath) fail('INVALID_PATH', 'path is empty');
  if (!/^[\x00-\x7f]*$/u.test(relativePath)) {
    fail('NON_PORTABLE_PATH', `${JSON.stringify(relativePath)} is not ASCII`);
  }
  if (
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/u.test(relativePath)
  ) {
    fail('ABSOLUTE_PATH', `${JSON.stringify(relativePath)} is absolute`);
  }
  if (relativePath.includes('\\')) {
    fail('BACKSLASH_PATH', `${JSON.stringify(relativePath)} contains a backslash`);
  }
  if (relativePath.endsWith('/')) {
    fail('INVALID_PATH', `${JSON.stringify(relativePath)} has a trailing slash`);
  }
  if (/[\x00-\x1f\x7f]/u.test(relativePath)) {
    fail('CONTROL_CHARACTER', `${JSON.stringify(relativePath)} contains a control character`);
  }
  if (Buffer.byteLength(relativePath, 'ascii') > PLUGIN_PACKAGE_V1_LIMITS.maxPathBytes) {
    fail('PATH_TOO_LONG', `${JSON.stringify(relativePath)} exceeds the path limit`);
  }
}

function assertPortablePathSegment(segment: string, relativePath: string): void {
  if (!segment || segment === '.' || segment === '..') {
    fail('PATH_TRAVERSAL', `${JSON.stringify(relativePath)} has an empty/dot segment`);
  }
  if (Buffer.byteLength(segment, 'ascii') > PLUGIN_PACKAGE_V1_LIMITS.maxSegmentBytes) {
    fail('SEGMENT_TOO_LONG', `${JSON.stringify(segment)} exceeds the segment limit`);
  }
  if (!PORTABLE_SEGMENT_PATTERN.test(segment) || segment.endsWith('.')) {
    fail('NON_PORTABLE_PATH', `${JSON.stringify(segment)} is not portable`);
  }
  const [basename = ''] = segment.split('.', 1);
  if (WINDOWS_RESERVED.has(basename.toLowerCase())) {
    fail('WINDOWS_RESERVED_PATH', `${JSON.stringify(segment)} is reserved on Windows`);
  }
}

function assertContainedPathShape(relativePath: string): void {
  if (!relativePath) fail('INVALID_PATH', 'path is empty');
  if (
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/u.test(relativePath)
  ) {
    fail('ABSOLUTE_PATH', `${JSON.stringify(relativePath)} is absolute`);
  }
  if (relativePath.includes('\\')) {
    fail('BACKSLASH_PATH', `${JSON.stringify(relativePath)} contains a backslash`);
  }
  if (relativePath.endsWith('/')) {
    fail('INVALID_PATH', `${JSON.stringify(relativePath)} has a trailing slash`);
  }
  if (/[\x00-\x1f\x7f]/u.test(relativePath)) {
    fail('CONTROL_CHARACTER', `${JSON.stringify(relativePath)} contains a control character`);
  }
  if (Buffer.byteLength(relativePath, 'utf8') > PLUGIN_PACKAGE_V1_LIMITS.maxPathBytes) {
    fail('PATH_TOO_LONG', `${JSON.stringify(relativePath)} exceeds the path limit`);
  }
}

function assertContainedPathSegment(
  segment: string,
  relativePath: string,
  enforceWindowsNames: boolean,
): void {
  if (!segment || segment === '.' || segment === '..') {
    fail('PATH_TRAVERSAL', `${JSON.stringify(relativePath)} has an empty/dot segment`);
  }
  if (Buffer.byteLength(segment, 'utf8') > PLUGIN_PACKAGE_V1_LIMITS.maxSegmentBytes) {
    fail('SEGMENT_TOO_LONG', `${JSON.stringify(segment)} exceeds the segment limit`);
  }
  if (!enforceWindowsNames && process.platform !== 'win32') return;
  if (/[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment)) {
    fail('HOST_PATH_UNSUPPORTED', `${JSON.stringify(segment)} is not supported on Windows`);
  }
  const [basename = ''] = segment.split('.', 1);
  if (WINDOWS_RESERVED.has(basename.toLowerCase())) {
    fail('WINDOWS_RESERVED_PATH', `${JSON.stringify(segment)} is reserved on Windows`);
  }
}

export function computePluginContentDigest(
  entries: readonly PluginContractEntry[],
  options: PluginPackageDigestOptions = {},
): PluginContentDigestResult {
  const pathRules = resolvePathRules(options);
  const files = validateEntries(
    entries,
    true,
    pathRules,
    options.sizeLimits ?? DEFAULT_SIZE_LIMITS,
  );
  for (const file of files) {
    if ((file.compression ?? 'store') !== 'store') {
      fail('UNSUPPORTED_COMPRESSION', `${JSON.stringify(file.path)} is not STORE`);
    }
  }
  const hash = createContentHash(files.length);
  let totalBytes = 0;
  for (const file of files) {
    const content = file.content;
    if (content === undefined) {
      fail('VECTOR_CONTENT_MISSING', `${file.path} has no content`);
    }
    updateFileHeader(hash, file.path, content.length);
    hash.update(content);
    totalBytes += content.length;
  }
  return {
    contentDigest: `sha256-tree-v1:${hash.digest('hex')}`,
    fileCount: files.length,
    totalBytes,
    files,
  };
}

export async function computePluginDirectoryDigest(
  root: string,
  options: PluginPackageDigestOptions = {},
): Promise<Omit<PluginContentDigestResult, 'files'>> {
  const pathRules = resolvePathRules(options);
  const sizeLimits = options.sizeLimits ?? DEFAULT_SIZE_LIMITS;
  const entries: PluginContractEntry[] = [];
  await collectDirectoryEntries(root, '', entries, {
    entryCount: 0,
    fileCount: 0,
    totalBytes: 0,
    pathRules,
    sizeLimits,
    rejectHardlinks: options.rejectHardlinks === true,
    ...(options.exclude ? { skip: options.exclude } : {}),
  });
  const files = validateEntries(entries, false, pathRules, sizeLimits);
  const hash = createContentHash(files.length);
  let totalBytes = 0;
  for (const file of files) {
    const size = entrySize(file);
    updateFileHeader(hash, file.path, size);
    await hashStableRegularFile(root, file.path, size, {
      hashes: [hash],
      rejectHardlinks: options.rejectHardlinks === true,
    });
    totalBytes += size;
  }
  return {
    contentDigest: `sha256-tree-v1:${hash.digest('hex')}`,
    fileCount: files.length,
    totalBytes,
  };
}

/**
 * Collects the validated, digest-ordered regular files of a package directory.
 * `skip` runs before any lstat, so skipped trees (e.g. `node_modules`) may hold
 * symlinks or special files without failing the collection.
 */
export async function collectPluginPackageFiles(
  root: string,
  options: {
    readonly pathPolicy: PluginPackagePathPolicy;
    readonly enforceWindowsNames?: boolean;
    readonly skip?: (relativePath: string) => boolean;
  },
): Promise<readonly PluginContractEntry[]> {
  const pathRules = resolvePathRules(options);
  const entries: PluginContractEntry[] = [];
  await collectDirectoryEntries(root, '', entries, {
    entryCount: 0,
    fileCount: 0,
    totalBytes: 0,
    pathRules,
    sizeLimits: DEFAULT_SIZE_LIMITS,
    rejectHardlinks: true,
    ...(options.skip ? { skip: options.skip } : {}),
  });
  return validateEntries(entries, false, pathRules, DEFAULT_SIZE_LIMITS);
}

export async function computeMiniAppPackageDigests(
  root: string,
  artifacts: MiniAppArtifactRoots,
  options: MiniAppPackageDigestOptions = {},
): Promise<MiniAppPackageDigests> {
  const includeOrdinaryContentDigest = options.includeOrdinaryContentDigest === true;
  const files = await collectMiniAppFiles(root, artifacts, options);
  const miniAppFiles = includeOrdinaryContentDigest
    ? files.filter((file) => !isMiniAppRuntimePayloadExcludedPath(file.path))
    : files;
  const clientFiles = miniAppFiles.filter((file) =>
    isPathCoveredByRoots(file.path, artifacts.client),
  );
  const nodeFiles = miniAppFiles.filter((file) => isPathCoveredByRoots(file.path, artifacts.node));
  const ordinaryHash = includeOrdinaryContentDigest ? createContentHash(files.length) : undefined;
  const contentHash = createContentHash(miniAppFiles.length);
  const clientHash = createContentHash(clientFiles.length);
  const nodeHash = createContentHash(nodeFiles.length);
  for (const file of files) {
    const size = entrySize(file);
    const hashes: ReturnType<typeof createHash>[] = [];
    if (ordinaryHash) {
      updateFileHeader(ordinaryHash, file.path, size);
      hashes.push(ordinaryHash);
    }
    if (!isMiniAppRuntimePayloadExcludedPath(file.path)) {
      updateFileHeader(contentHash, file.path, size);
      hashes.push(contentHash);
      if (isPathCoveredByRoots(file.path, artifacts.client)) {
        updateFileHeader(clientHash, file.path, size);
        hashes.push(clientHash);
      }
      if (isPathCoveredByRoots(file.path, artifacts.node)) {
        updateFileHeader(nodeHash, file.path, size);
        hashes.push(nodeHash);
      }
    }
    await hashStableRegularFile(root, file.path, size, {
      hashes,
      rejectHardlinks: options.rejectHardlinks === true,
    });
  }
  return {
    contentDigest: `sha256-tree-v1:${contentHash.digest('hex')}`,
    clientDigest: `sha256-tree-v1:${clientHash.digest('hex')}`,
    nodeDigest: `sha256-tree-v1:${nodeHash.digest('hex')}`,
    ...(ordinaryHash
      ? { ordinaryContentDigest: `sha256-tree-v1:${ordinaryHash.digest('hex')}` }
      : {}),
  };
}

async function collectMiniAppFiles(
  root: string,
  artifacts: MiniAppArtifactRoots,
  options: MiniAppPackageDigestOptions = {},
): Promise<PluginContractEntry[]> {
  const entries: PluginContractEntry[] = [];
  const pathRules = resolvePathRules({ pathPolicy: 'minimax-portable' });
  const artifactRoots = [...artifacts.client, ...artifacts.node];
  const sizeLimits = options.sizeLimits ?? DEFAULT_SIZE_LIMITS;
  await collectDirectoryEntries(root, '', entries, {
    entryCount: 0,
    fileCount: 0,
    totalBytes: 0,
    pathRules,
    sizeLimits,
    rejectHardlinks: options.rejectHardlinks === true,
    skip: (relativePath) => {
      if (!isMiniAppRuntimePayloadExcludedPath(relativePath)) return false;
      if (isPathCoveredByRoots(relativePath, artifactRoots)) {
        fail(
          'MINIAPP_ARTIFACTS_EXCLUDED',
          `${relativePath} is excluded inside a declared runtime artifact`,
        );
      }
      return options.includeOrdinaryContentDigest !== true;
    },
  });
  return validateEntries(entries, false, pathRules, sizeLimits);
}

export function pluginDigestCacheKey(contentDigest: string): string {
  const match = CONTENT_DIGEST_PATTERN.exec(contentDigest);
  if (!match) fail('INVALID_CONTENT_DIGEST', 'content digest has an unsupported format');
  return `sha256-tree-v1-${match[1]}`;
}

export interface MaterializeContentAddressedDirectoryInput {
  /** Holds the `<cacheKey>` directories and the staging directories. */
  readonly parent: string;
  /** `mkdtemp` prefix of the staging directory inside `parent`. */
  readonly stagingPrefix: string;
  /** Known up front: an equal existing directory is reused before `populate` runs. */
  readonly expectedDigest?: string;
  readonly digestOptions?: PluginPackageDigestOptions;
  /** Fills the (empty, existing) staging directory. */
  populate(stagingRoot: string): Promise<void>;
  /** The staged tree does not match `expectedDigest`. */
  mismatchError?(): Error;
  /** Runs after the staged tree is verified, right before it is published. */
  beforePublish?(): void;
  /**
   * Whether an existing `<cacheKey>` directory holds the digest; `false` replaces it. Defaults to
   * a real directory whose digest (with `digestOptions`) is equal; any error counts as `false`.
   */
  holds?(root: string, contentDigest: string): Promise<boolean>;
}

export interface MaterializedContentAddressedDirectory {
  readonly cacheKey: string;
  readonly root: string;
  readonly contentDigest: string;
  readonly reused: boolean;
}

// Same-process publishers serialize by root; cross-process safety relies only on
// atomic rename and verification after a collision, not on this promise chain.
const publications = new KeyedOperationQueue();
const WINDOWS_CACHE_RETRIES = 4;
const WINDOWS_CACHE_RETRY_DELAY_MS = 50;

/**
 * Publishes `<parent>/<cacheKey>` content-addressed: staging → verify digest → rename. An
 * existing directory with the same digest is reused, also when a concurrent writer published it
 * first. A persistent Windows file lock may prevent staging cleanup.
 */
export async function materializeContentAddressedDirectory(
  input: MaterializeContentAddressedDirectoryInput,
): Promise<MaterializedContentAddressedDirectory> {
  const holds =
    input.holds ??
    ((root: string, contentDigest: string) =>
      holdsDirectoryDigest(root, contentDigest, input.digestOptions));
  await mkdir(input.parent, { recursive: true });
  const materialize = () => materializeStagedDirectory(input, holds);
  if (input.expectedDigest === undefined) return materialize();
  const root = path.resolve(input.parent, pluginDigestCacheKey(input.expectedDigest));
  return publications.run(root, materialize);
}

async function materializeStagedDirectory(
  input: MaterializeContentAddressedDirectoryInput,
  holds: (root: string, contentDigest: string) => Promise<boolean>,
): Promise<MaterializedContentAddressedDirectory> {
  if (input.expectedDigest !== undefined) {
    const cacheKey = pluginDigestCacheKey(input.expectedDigest);
    const root = path.join(input.parent, cacheKey);
    if (await holds(root, input.expectedDigest)) {
      return { cacheKey, root, contentDigest: input.expectedDigest, reused: true };
    }
  }
  const staging = await mkdtemp(path.join(input.parent, input.stagingPrefix));
  try {
    await input.populate(staging);
    const { contentDigest } = await computePluginDirectoryDigest(staging, input.digestOptions);
    if (input.expectedDigest !== undefined && contentDigest !== input.expectedDigest) {
      throw input.mismatchError?.() ?? new Error('staged content does not match its digest');
    }
    const cacheKey = pluginDigestCacheKey(contentDigest);
    const root = path.join(input.parent, cacheKey);
    const publish = async () => {
      input.beforePublish?.();
      // Known up front, the existing directory was checked before populating.
      const reused =
        (input.expectedDigest === undefined && (await holds(root, contentDigest))) ||
        (await publishStaged(
          staging,
          root,
          (candidateRoot) => holds(candidateRoot, contentDigest),
          input.beforePublish,
        ));
      return { cacheKey, root, contentDigest, reused };
    };
    return await (input.expectedDigest === undefined
      ? publications.run(path.resolve(root), publish)
      : publish());
  } finally {
    await removeStagingDirectory(staging);
  }
}

/** Renames staging into place; `true` when a concurrent writer of the same content won. */
async function publishStaged(
  staging: string,
  root: string,
  holds: (candidateRoot: string) => Promise<boolean>,
  beforeRetry?: () => void,
): Promise<boolean> {
  const move = () => renameStagedDirectory(staging, root, beforeRetry);
  try {
    await move();
    return false;
  } catch (error) {
    if (!isPublicationCollision(error) && !isRetryableWindowsFileError(error)) throw error;
    if (await holds(root)) return true;
    if (!isPublicationCollision(error)) throw error;
  }
  const aside = `${root}.corrupt-${randomUUID()}`;
  try {
    await rename(root, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return renameOrReuse(move, root, holds);
  }
  if (await holdsQuarantinedDirectory(aside, holds)) {
    // A cross-process winner may have replaced the damaged root before quarantine.
    // Putting it back leaves a transient ENOENT for readers, as the pre-refactor rm
    // path did; profile-level dataDir isolation makes same-root cross-process writes rare.
    await restoreQuarantinedDirectory(aside, root, holds);
    await rm(aside, { recursive: true, force: true });
    return true;
  }
  try {
    return await renameOrReuse(move, root, holds);
  } finally {
    await rm(aside, { recursive: true, force: true });
  }
}

async function renameStagedDirectory(
  staging: string,
  root: string,
  beforeRetry?: () => void,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(staging, root);
    } catch (error) {
      if (!isRetryableWindowsFileError(error)) throw error;
      // An existing destination must go through digest verification and collision recovery.
      if (await canStatDestination(root)) throw error;
      const exhausted = attempt >= WINDOWS_CACHE_RETRIES;
      logger.warn(
        {
          cacheKey: path.basename(root),
          code: (error as NodeJS.ErrnoException).code,
          attempt: attempt + 1,
          outcome: exhausted ? 'exhausted' : 'retrying',
        },
        '[plugin-cache] Windows denied staged directory publication',
      );
      if (exhausted) {
        throw new PluginSystemError('PLUGIN_CACHE_BUSY', 'Plugin cache is in use', {
          cause: error,
        });
      }
      await delay(WINDOWS_CACHE_RETRY_DELAY_MS * (attempt + 1));
      beforeRetry?.();
    }
  }
}

async function canStatDestination(root: string): Promise<boolean> {
  try {
    await lstat(root);
    return true;
  } catch (error) {
    // A locked lookup uses the same retry budget as the rename.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || isRetryableWindowsFileError(error))
      return false;
    throw error;
  }
}

async function removeStagingDirectory(staging: string): Promise<void> {
  const onWindows = process.platform === 'win32';
  try {
    await rm(staging, {
      recursive: true,
      force: true,
      maxRetries: onWindows ? WINDOWS_CACHE_RETRIES : 0,
      retryDelay: WINDOWS_CACHE_RETRY_DELAY_MS,
    });
  } catch (error) {
    // Preserve the publication outcome if a Windows handle still blocks staging cleanup.
    const { code } = error as NodeJS.ErrnoException;
    if (!isRetryableWindowsFileError(error) && !(onWindows && code === 'ENOTEMPTY')) throw error;
    logger.warn(
      { staging: path.basename(staging), code },
      '[plugin-cache] Windows retained a locked staging directory after cleanup retries',
    );
  }
}

async function renameOrReuse(
  move: () => Promise<void>,
  root: string,
  holds: (candidateRoot: string) => Promise<boolean>,
): Promise<boolean> {
  try {
    await move();
    return false;
  } catch (error) {
    if (!isPublicationCollision(error) && !isRetryableWindowsFileError(error)) throw error;
    if (await holds(root)) return true;
    throw error;
  }
}

async function holdsQuarantinedDirectory(
  root: string,
  holds: (candidateRoot: string) => Promise<boolean>,
): Promise<boolean> {
  try {
    return await holds(root);
  } catch {
    // Once quarantined, an unverifiable entry is damaged and must be cleaned up.
    return false;
  }
}

async function restoreQuarantinedDirectory(
  aside: string,
  root: string,
  holds: (candidateRoot: string) => Promise<boolean>,
): Promise<void> {
  const displaced = `${root}.corrupt-${randomUUID()}`;
  let removeDisplaced = true;
  let restorationFailure: Error | undefined;
  try {
    try {
      await renameOrReuse(() => rename(aside, root), root, holds);
      return;
    } catch (error) {
      if (!isPublicationCollision(error)) throw error;
    }
    // One bounded retry: move the invalid interloper out before restoring the winner.
    try {
      await rename(root, displaced);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // The interloper could itself have been replaced by another valid winner.
    removeDisplaced = !(await holdsQuarantinedDirectory(displaced, holds));
    await renameOrReuse(() => rename(aside, root), root, holds);
    removeDisplaced = true;
  } catch (error) {
    const retained = removeDisplaced ? aside : `${aside}, ${displaced}`;
    restorationFailure = new Error(
      `could not restore valid quarantined directory; retained at ${retained}`,
      { cause: error },
    );
  } finally {
    if (removeDisplaced) await cleanupDisplacedDirectory(displaced, aside, restorationFailure);
  }
  if (restorationFailure) throw restorationFailure;
}

async function cleanupDisplacedDirectory(
  displaced: string,
  aside: string,
  restorationFailure: Error | undefined,
): Promise<void> {
  try {
    await rm(displaced, { recursive: true, force: true });
  } catch (cleanupFailure) {
    const retained = [displaced];
    try {
      await lstat(aside);
      retained.unshift(aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') retained.unshift(aside);
    }
    throw new Error(
      `${restorationFailure?.message ?? 'quarantine restoration completed'}; cleanup failed; retained at ${retained.join(', ')}`,
      {
        cause: restorationFailure
          ? new AggregateError([restorationFailure, cleanupFailure])
          : cleanupFailure,
      },
    );
  }
}

function isPublicationCollision(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'EEXIST' ||
    code === 'ENOTEMPTY' ||
    code === 'ENOTDIR' ||
    (code === 'EPERM' && process.platform === 'win32')
  );
}

async function holdsDirectoryDigest(
  root: string,
  contentDigest: string,
  options: PluginPackageDigestOptions | undefined,
): Promise<boolean> {
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    return (await computePluginDirectoryDigest(root, options)).contentDigest === contentDigest;
  } catch {
    return false;
  }
}

function validateEntries(
  entries: readonly PluginContractEntry[],
  requireContent: boolean,
  pathRules: PathRules,
  sizeLimits: PluginPackageSizeLimits,
): PluginContractEntry[] {
  if (entries.length > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveEntries) {
    fail('TOO_MANY_ENTRIES', `${entries.length} entries exceed the limit`);
  }
  const state = createEntryValidationState();
  for (const entry of entries) validateEntry(entry, state, pathRules, sizeLimits);

  if (state.files.length > PLUGIN_PACKAGE_V1_LIMITS.maxFiles) {
    fail('TOO_MANY_FILES', `${state.files.length} files exceed the limit`);
  }
  if (state.totalBytes > sizeLimits.maxTotalBytes) {
    fail('TOTAL_SIZE_LIMIT', `${state.totalBytes} bytes exceed the package limit`);
  }
  assertNoPathTypeConflicts(state.kindsByPath);
  if (requireContent) assertRequiredContent(state.files);
  return state.files.sort((left, right) =>
    Buffer.from(left.path.normalize('NFC'), 'utf8').compare(
      Buffer.from(right.path.normalize('NFC'), 'utf8'),
    ),
  );
}

interface EntryValidationState {
  readonly exactPaths: Set<string>;
  readonly portablePrefixes: Map<string, string>;
  readonly kindsByPath: Map<string, PluginContractEntryKind>;
  readonly files: PluginContractEntry[];
  totalBytes: number;
}

function createEntryValidationState(): EntryValidationState {
  return {
    exactPaths: new Set(),
    portablePrefixes: new Map(),
    kindsByPath: new Map(),
    files: [],
    totalBytes: 0,
  };
}

function validateEntry(
  entry: PluginContractEntry,
  state: EntryValidationState,
  pathRules: PathRules,
  sizeLimits: PluginPackageSizeLimits,
): void {
  validatePackagePath(entry.path, pathRules);
  if (state.exactPaths.has(entry.path)) fail('DUPLICATE_PATH', `duplicate ${entry.path}`);
  state.exactPaths.add(entry.path);
  registerPortablePrefixes(entry.path, state.portablePrefixes);
  state.kindsByPath.set(entry.path, entry.kind);
  assertSupportedEntryKind(entry);
  if (entry.kind === 'directory') return;
  const size = entrySize(entry);
  assertEntrySize(entry.path, size, sizeLimits.maxFileBytes);
  state.files.push(entry);
  state.totalBytes += size;
}

function registerPortablePrefixes(relativePath: string, prefixes: Map<string, string>): void {
  const segments = relativePath.split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    const prefix = segments.slice(0, index).join('/');
    const key = simpleLowerCase(prefix.normalize('NFC'));
    const prior = prefixes.get(key);
    if (prior !== undefined && prior !== prefix) {
      fail('CASE_COLLISION', `${prior} and ${prefix} collide`);
    }
    prefixes.set(key, prefix);
  }
}

/**
 * Per-code-point simple lowercase mapping (UnicodeData), identical to Go's
 * `strings.ToLower` used by archon_server. `toLowerCase` on a whole string is
 * context sensitive (final sigma) and may expand (`İ` → `i̇`); per code point,
 * the only unconditional expansion is `İ`, whose first code point is its
 * simple mapping.
 */
function simpleLowerCase(value: string): string {
  if (/^[\x00-\x7f]*$/u.test(value)) return value.toLowerCase();
  let lowered = '';
  for (const character of value) {
    lowered += String.fromCodePoint(character.toLowerCase().codePointAt(0) ?? 0);
  }
  return lowered;
}

function assertSupportedEntryKind(entry: PluginContractEntry): void {
  if (entry.kind === 'symlink') fail('SYMLINK_NOT_ALLOWED', `${entry.path} is a symlink`);
  if (entry.kind === 'hardlink') fail('HARDLINK_NOT_ALLOWED', `${entry.path} is a hardlink`);
  if (entry.kind !== 'file' && entry.kind !== 'directory') {
    fail('SPECIAL_ENTRY_NOT_ALLOWED', `${entry.path} has kind ${entry.kind}`);
  }
}

function assertEntrySize(relativePath: string, size: number, maxFileBytes: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    fail('INVALID_SIZE', `${relativePath} has an invalid size`);
  }
  if (size > maxFileBytes) {
    fail('FILE_TOO_LARGE', `${relativePath} exceeds the file limit`);
  }
}

function assertNoPathTypeConflicts(kindsByPath: ReadonlyMap<string, PluginContractEntryKind>) {
  for (const [relativePath] of kindsByPath) {
    const segments = relativePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join('/');
      if (kindsByPath.get(parent) === 'file') {
        fail('PATH_TYPE_CONFLICT', `${parent} is a file parent of ${relativePath}`);
      }
    }
  }
}

function assertRequiredContent(files: readonly PluginContractEntry[]): void {
  for (const file of files) {
    if (file.content === undefined) {
      fail('VECTOR_CONTENT_MISSING', `${file.path} has no content`);
    }
    if (file.declaredSize !== undefined && file.declaredSize !== file.content.length) {
      fail('SIZE_MISMATCH', `${file.path} declared and actual sizes differ`);
    }
  }
}

function createContentHash(fileCount: number) {
  const hash = createHash('sha256');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(fileCount, 4);
  hash.update(CONTENT_MAGIC);
  hash.update(header);
  return hash;
}

function updateFileHeader(
  hash: ReturnType<typeof createHash>,
  relativePath: string,
  size: number,
): void {
  const pathBytes = Buffer.from(relativePath.normalize('NFC'), 'utf8');
  const header = Buffer.alloc(13);
  header.writeUInt8(0x46, 0);
  header.writeUInt32BE(pathBytes.length, 1);
  header.writeBigUInt64BE(BigInt(size), 5);
  hash.update(header.subarray(0, 5));
  hash.update(pathBytes);
  hash.update(header.subarray(5));
}

async function collectDirectoryEntries(
  root: string,
  relativeDirectory: string,
  output: PluginContractEntry[],
  limits: DirectoryTraversalState,
): Promise<void> {
  const directory = relativeDirectory ? path.join(root, ...relativeDirectory.split('/')) : root;
  const handle = await opendir(directory);
  for await (const child of handle) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
    if (limits.skip?.(relativePath)) continue;
    const entry = await inspectDirectoryEntry(root, relativePath, child, limits);
    output.push(entry);
    if (entry.kind === 'directory') {
      await collectDirectoryEntries(root, relativePath, output, limits);
    }
  }
}

async function inspectDirectoryEntry(
  root: string,
  relativePath: string,
  child: Dirent,
  limits: DirectoryTraversalState,
): Promise<PluginContractEntry> {
  validatePackagePath(relativePath, limits.pathRules);
  limits.entryCount += 1;
  if (limits.entryCount > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveEntries) {
    fail('TOO_MANY_ENTRIES', `${limits.entryCount} entries exceed the limit`);
  }
  if (child.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', `${relativePath} is a symlink`);
  if (child.isDirectory()) return { path: relativePath, kind: 'directory' };
  if (!child.isFile()) {
    fail('SPECIAL_ENTRY_NOT_ALLOWED', `${relativePath} has an unsupported kind`);
  }
  return inspectDirectoryFile(root, relativePath, limits);
}

interface PathRules {
  readonly policy: PluginPackagePathPolicy;
  readonly enforceWindowsNames: boolean;
}

function resolvePathRules(options: {
  readonly pathPolicy?: PluginPackagePathPolicy;
  readonly enforceWindowsNames?: boolean;
}): PathRules {
  return {
    policy: options.pathPolicy ?? 'minimax-portable',
    enforceWindowsNames: options.enforceWindowsNames === true,
  };
}

function validatePackagePath(relativePath: string, rules: PathRules): void {
  if (rules.policy === 'unrestricted') {
    assertContainedPathShape(relativePath);
    return;
  }
  if (rules.policy === 'agent-plugin') {
    validateAgentPluginPath(relativePath, rules.enforceWindowsNames);
  } else validatePluginPortablePath(relativePath);
}

async function inspectDirectoryFile(
  root: string,
  relativePath: string,
  limits: DirectoryTraversalState,
): Promise<PluginContractEntry> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const fileHandle = await open(path.join(root, ...relativePath.split('/')), flags);
  try {
    const stat = await fileHandle.stat();
    if (!stat.isFile()) fail('SPECIAL_ENTRY_NOT_ALLOWED', `${relativePath} is not a file`);
    if (stat.nlink > 1) fail('HARDLINK_NOT_ALLOWED', `${relativePath} is a hardlink`);
    assertEntrySize(relativePath, stat.size, limits.sizeLimits.maxFileBytes);
    limits.fileCount += 1;
    if (limits.fileCount > PLUGIN_PACKAGE_V1_LIMITS.maxFiles) {
      fail('TOO_MANY_FILES', `${limits.fileCount} files exceed the limit`);
    }
    limits.totalBytes += stat.size;
    if (limits.totalBytes > limits.sizeLimits.maxTotalBytes) {
      fail('TOTAL_SIZE_LIMIT', `${limits.totalBytes} bytes exceed the package limit`);
    }
    return { path: relativePath, kind: 'file', declaredSize: stat.size };
  } finally {
    await fileHandle.close();
  }
}

interface DirectoryTraversalState {
  entryCount: number;
  fileCount: number;
  totalBytes: number;
  readonly pathRules: PathRules;
  readonly sizeLimits: PluginPackageSizeLimits;
  readonly rejectHardlinks?: boolean;
  readonly skip?: (relativePath: string) => boolean;
}

async function hashStableRegularFile(
  root: string,
  relativePath: string,
  expectedSize: number,
  options: {
    readonly hashes: readonly ReturnType<typeof createHash>[];
    readonly rejectHardlinks?: boolean;
  },
): Promise<void> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path.join(root, ...relativePath.split('/')), flags);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== expectedSize ||
      (options.rejectHardlinks && before.nlink !== 1)
    ) {
      fail('FILE_CHANGED_DURING_READ', `${relativePath} changed during digest`);
    }
    await hashFileBytes(handle, relativePath, expectedSize, options.hashes);
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, expectedSize)).bytesRead !== 0) {
      fail('FILE_CHANGED_DURING_READ', `${relativePath} grew during digest`);
    }
    const after = await handle.stat();
    if (options.rejectHardlinks && after.nlink !== 1) {
      fail('HARDLINK_NOT_ALLOWED', `${relativePath} is a hardlink`);
    }
    if (!sameFileSnapshot(before, after)) {
      fail('FILE_CHANGED_DURING_READ', `${relativePath} changed during digest`);
    }
  } finally {
    await handle.close();
  }
}

async function hashFileBytes(
  handle: Awaited<ReturnType<typeof open>>,
  relativePath: string,
  expectedSize: number,
  hashes: readonly ReturnType<typeof createHash>[],
): Promise<void> {
  let offset = 0;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  while (offset < expectedSize) {
    const { bytesRead } = await handle.read(
      chunk,
      0,
      Math.min(chunk.length, expectedSize - offset),
      offset,
    );
    if (bytesRead === 0) fail('FILE_CHANGED_DURING_READ', `${relativePath} was truncated`);
    for (const hash of hashes) hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
}

function sameFileSnapshot(
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  after: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function entrySize(entry: PluginContractEntry): number {
  return entry.declaredSize ?? entry.content?.length ?? 0;
}

function fail(code: string, detail: string): never {
  throw new PluginPackageContractError(code, detail);
}
