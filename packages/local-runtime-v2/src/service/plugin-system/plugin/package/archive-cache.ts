import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parsePluginArchive, PluginArchiveError } from './archive-format.js';
import {
  computePluginDirectoryDigest,
  PLUGIN_PACKAGE_V1_LIMITS,
  materializeContentAddressedDirectory,
  pluginDigestCacheKey,
  type PluginPackageDigestOptions,
} from './package-contract.js';

export interface MaterializeOfficialPluginArchiveInput {
  readonly archivePath: string;
  readonly cacheRoot: string;
  readonly expectedArchiveSha256: string;
  readonly expectedContentDigest: string;
  readonly signal?: AbortSignal;
}

export interface MaterializedOfficialPluginArchive {
  readonly cacheKey: string;
  readonly packageRoot: string;
  readonly reused: boolean;
}

export async function materializeOfficialPluginArchive(
  input: MaterializeOfficialPluginArchiveInput,
): Promise<MaterializedOfficialPluginArchive> {
  assertSha256(input.expectedArchiveSha256);
  const cacheKey = pluginDigestCacheKey(input.expectedContentDigest);
  await mkdir(input.cacheRoot, { recursive: true });
  assertNotAborted(input.signal);
  const archive = await readRegularArchive(input.archivePath, input.signal);
  assertNotAborted(input.signal);
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  if (archiveSha256 !== input.expectedArchiveSha256) {
    throw new PluginArchiveError(
      'ARCHIVE_DIGEST_MISMATCH',
      'archive SHA-256 does not match the package reference',
    );
  }
  // Spec 1.7: the official path applies the same appearance budget the local reader does.
  const parsed = parsePluginArchive(archive);
  if (parsed.digest.contentDigest !== input.expectedContentDigest) {
    throw new PluginArchiveError(
      'CONTENT_DIGEST_MISMATCH',
      'archive content tree does not match the package reference',
    );
  }
  // The extracted tree is digested again, staged and in an existing cache directory, and has to
  // pass under the limits the archive itself passed under.
  const digestOptions: PluginPackageDigestOptions = {};

  const materialized = await materializeContentAddressedDirectory({
    parent: input.cacheRoot,
    stagingPrefix: `.${cacheKey}.tmp-`,
    expectedDigest: input.expectedContentDigest,
    digestOptions,
    populate: (stagingRoot) => writePackageEntries(stagingRoot, parsed.entries, input.signal),
    mismatchError: () =>
      new PluginArchiveError(
        'CONTENT_DIGEST_MISMATCH',
        'staged package content changed during extraction',
      ),
    beforePublish: () => assertNotAborted(input.signal),
    holds: (packageRoot, contentDigest) =>
      isExistingValidCache(packageRoot, contentDigest, digestOptions),
  });
  return { cacheKey, packageRoot: materialized.root, reused: materialized.reused };
}

export interface PackageEntryToWrite {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly content?: Buffer;
  /** File mode; official archives carry none and stay private (0600). */
  readonly mode?: number;
}

/** Writes verified package entries below an empty staging root without overwriting anything. */
export async function writePackageEntries(
  root: string,
  entries: readonly PackageEntryToWrite[],
  signal?: AbortSignal,
): Promise<void> {
  for (const entry of entries) {
    assertNotAborted(signal);
    const target = join(root, ...entry.path.split('/'));
    if (entry.kind === 'directory') {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(dirname(target), { recursive: true });
      const mode = entry.mode ?? 0o600;
      await writeFile(target, entry.content ?? Buffer.alloc(0), { flag: 'wx', mode });
      // `writeFile` applies the process umask; restore the exact package mode.
      if (entry.mode !== undefined) await chmod(target, mode);
    }
  }
}

async function readRegularArchive(
  archivePath: string,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const initial = await inspectArchivePath(archivePath);
  const handle = await openArchive(archivePath);
  try {
    const before = await handle.stat();
    assertArchiveSnapshot(initial, before);
    const archive = await readArchiveBytes(handle, before.size, signal);
    assertArchiveUnchanged(before, await handle.stat());
    return archive;
  } finally {
    await handle.close();
  }
}

async function inspectArchivePath(archivePath: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    const initial = await lstat(archivePath);
    if (initial.isSymbolicLink() || !initial.isFile()) throw new Error('not a regular file');
    return initial;
  } catch {
    throw new PluginArchiveError('ARCHIVE_NOT_REGULAR_FILE', 'archive must be a regular file');
  }
}

async function openArchive(archivePath: string): Promise<Awaited<ReturnType<typeof open>>> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  try {
    return await open(archivePath, flags);
  } catch {
    throw new PluginArchiveError('ARCHIVE_NOT_REGULAR_FILE', 'archive must be a regular file');
  }
}

function assertArchiveSnapshot(
  initial: Awaited<ReturnType<typeof lstat>>,
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): void {
  if (
    !before.isFile() ||
    before.dev !== initial.dev ||
    before.ino !== initial.ino ||
    !Number.isSafeInteger(before.size) ||
    before.size < 0
  ) {
    throw new PluginArchiveError('ARCHIVE_CHANGED_DURING_READ', 'archive changed before read');
  }
  // The manifest is inside the archive, so the read is bounded by the larger budget; the parser
  // then applies the limits this package gets.
  if (before.size > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveBytes) {
    throw new PluginArchiveError('ARCHIVE_TOO_LARGE', 'archive exceeds the archive byte limit');
  }
}

async function readArchiveBytes(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const archive = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < archive.length) {
    assertNotAborted(signal);
    const { bytesRead } = await handle.read(
      archive,
      offset,
      Math.min(64 * 1024, archive.length - offset),
      offset,
    );
    if (bytesRead === 0) {
      throw new PluginArchiveError('ARCHIVE_CHANGED_DURING_READ', 'archive was truncated');
    }
    offset += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) {
    throw new PluginArchiveError('ARCHIVE_CHANGED_DURING_READ', 'archive grew during read');
  }
  return archive;
}

function assertArchiveUnchanged(
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  after: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new PluginArchiveError('ARCHIVE_CHANGED_DURING_READ', 'archive changed during read');
  }
}

async function isExistingValidCache(
  packageRoot: string,
  expectedContentDigest: string,
  digestOptions: PluginPackageDigestOptions,
): Promise<boolean> {
  try {
    const stat = await lstat(packageRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new PluginArchiveError('CACHE_CORRUPT', 'digest cache path is not a directory');
    }
    const digest = await computePluginDirectoryDigest(packageRoot, digestOptions);
    if (digest.contentDigest !== expectedContentDigest) {
      throw new PluginArchiveError('CACHE_CORRUPT', 'existing digest cache content is invalid');
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    if (error instanceof PluginArchiveError) throw error;
    throw new PluginArchiveError('CACHE_CORRUPT', 'existing digest cache cannot be validated');
  }
}

function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new PluginArchiveError('INVALID_ARCHIVE_DIGEST', 'archive SHA-256 format is invalid');
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new PluginArchiveError('ARCHIVE_ABORTED', 'archive materialization was aborted');
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
