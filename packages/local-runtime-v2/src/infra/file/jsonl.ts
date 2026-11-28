import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, type Stats } from 'node:fs';
import { chmod, copyFile, link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { HardLinkUnsupportedError } from '@mavis/shared/hard-link-support';

import { logger } from '../logging/logger.js';

// Windows reports a handle held by another process (scanner, indexer, backup) as one of these
// codes; the holder usually lets go within a second, so wait about 1.5s in total before failing.
const FILE_LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const TRANSIENT_FILE_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
// `link` codes that mean the filesystem cannot create hard links: Windows reports FAT32 and exFAT
// as EISDIR, macOS and FUSE mounts as ENOTSUP, EOPNOTSUPP or ENOSYS, and Linux vfat as EPERM; a
// link inside one directory fails with EXDEV only where the mount refuses links. Windows also
// reports a held file as EPERM, so that code counts only once the lock retries are exhausted.
const HARD_LINK_UNSUPPORTED_CODES = new Set([
  'EISDIR',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EXDEV',
  'EPERM',
]);
/** Read and write unit for streamed JSONL; a record longer than this spans several chunks. */
const STREAM_CHUNK_BYTES = 256 * 1024;

interface AppendAttempt {
  preAppendSize?: number;
  payload?: Buffer;
  failed: boolean;
  error?: unknown;
}

export interface JsonlMalformedLine {
  readonly path: string;
  readonly lineNo: number;
  readonly reason: string;
}

export class JsonlAppendCommitUncertainError extends Error {
  readonly filePath: string;
  override readonly cause: unknown;

  constructor(filePath: string, cause: unknown) {
    super(`JSONL append commit is uncertain for ${filePath}`);
    this.name = 'JsonlAppendCommitUncertainError';
    this.filePath = filePath;
    this.cause = cause;
  }
}

/**
 * Decoded complete lines of one file plus the identity and samples of the bytes they cover.
 * A trailing line without a newline is decoded on every read and never cached.
 */
export interface JsonlReadCache<T> {
  records: readonly T[];
  /** File bytes covered by `records`; always ends right after a newline. */
  size: number;
  identity?: JsonlCachedIdentity;
}

interface JsonlCachedIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  /** First and last bytes of the covered prefix, compared before it is reused. */
  readonly head: Buffer;
  readonly tail: Buffer;
}

export interface JsonlIncrementalRead<T> {
  /** Immutable; the same array as the previous read when the file has not changed. */
  readonly records: readonly T[];
  /** Leading records reused from the previous cached read. */
  readonly reusedCount: number;
  /** Leading records now covered by the cache (excludes an unterminated last line). */
  readonly cachedCount: number;
}

const JSONL_PREFIX_SAMPLE_BYTES = 4 * 1024;

export function createJsonlReadCache<T>(): JsonlReadCache<T> {
  return { records: [], size: 0 };
}

export async function readJsonl<T>(
  filePath: string,
  decode: (value: unknown) => T,
  onMalformedLine?: (line: JsonlMalformedLine) => void,
): Promise<T[]> {
  const contents = await readFile(filePath, 'utf-8');
  const records: T[] = [];
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const [index, line] of lines.entries()) {
    try {
      if (line.trim().length === 0) throw new Error('blank line');
      records.push(decode(parseJsonLine(line)));
    } catch (error) {
      const malformed = { path: filePath, lineNo: index + 1, reason: errorReason(error) };
      if (!onMalformedLine) throw malformedLineError(malformed);
      onMalformedLine(malformed);
    }
  }
  return records;
}

/**
 * Strict read that visits records in file order while holding one chunk and one line at a time.
 * Lines follow readJsonl: a trailing newline ends the file and a blank line is malformed. Returns
 * the number of records visited.
 */
export async function forEachJsonlRecord<T>(
  filePath: string,
  decode: (value: unknown) => T,
  visit: (record: T, index: number) => void | Promise<void>,
): Promise<number> {
  let count = 0;
  const visitLine = async (line: string): Promise<void> => {
    const record = decodeCachedLine(line, decode, { path: filePath, lineNo: count + 1 });
    count += 1;
    await visit(record, count - 1);
  };
  let pending = '';
  const stream = createReadStream(filePath, {
    encoding: 'utf8',
    highWaterMark: STREAM_CHUNK_BYTES,
  });
  for await (const chunk of stream) {
    pending += String(chunk);
    let start = 0;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      await visitLine(pending.slice(start, newline));
      start = newline + 1;
      newline = pending.indexOf('\n', start);
    }
    pending = pending.slice(start);
  }
  if (pending.length > 0) await visitLine(pending);
  return count;
}

/**
 * Strict read that decodes only bytes appended since the cached read. The cached prefix is
 * reused when the file identity matches, the file did not shrink, an unchanged size keeps its
 * mtime, and the first and last bytes of the prefix still match; otherwise the whole file is
 * decoded again. The caller must serialize reads and writes of one file.
 */
export async function readJsonlIncrementally<T>(
  filePath: string,
  decode: (value: unknown) => T,
  cache: JsonlReadCache<T>,
): Promise<JsonlIncrementalRead<T>> {
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    const reused = await canReuseCachedPrefix(handle, info, cache);
    const start = reused ? cache.size : 0;
    const bytes = await readFileRange(handle, start, Math.max(0, info.size - start));
    return decodeIncrement({ filePath, decode, cache, info }, { reused, start, bytes });
  } finally {
    await handle.close();
  }
}

async function canReuseCachedPrefix<T>(
  handle: Awaited<ReturnType<typeof open>>,
  info: Stats,
  cache: JsonlReadCache<T>,
): Promise<boolean> {
  const identity = cache.identity;
  if (!identity || cache.size === 0) return false;
  if (info.dev !== identity.dev || info.ino !== identity.ino || info.size < cache.size)
    return false;
  if (info.size === cache.size && info.mtimeMs !== identity.mtimeMs) return false;
  const head = await readFileRange(handle, 0, identity.head.length);
  if (!head.equals(identity.head)) return false;
  const tail = await readFileRange(handle, cache.size - identity.tail.length, identity.tail.length);
  return tail.equals(identity.tail);
}

interface IncrementTarget<T> {
  readonly filePath: string;
  readonly decode: (value: unknown) => T;
  readonly cache: JsonlReadCache<T>;
  readonly info: Stats;
}

function decodeIncrement<T>(
  target: IncrementTarget<T>,
  read: { readonly reused: boolean; readonly start: number; readonly bytes: Buffer },
): JsonlIncrementalRead<T> {
  const { cache } = target;
  const previous = read.reused ? cache.records : [];
  const completeEnd = read.bytes.lastIndexOf(10) + 1;
  const decoded = decodeLines(target, read.bytes.subarray(0, completeEnd), previous.length);
  const cached = decoded.length === 0 ? previous : Object.freeze([...previous, ...decoded]);
  if (completeEnd > 0 || !read.reused) {
    rememberCachedPrefix(target, {
      records: cached,
      previousIdentity: read.reused ? cache.identity : undefined,
      covered: read.bytes.subarray(0, completeEnd),
      size: read.start + completeEnd,
    });
  }
  if (completeEnd === read.bytes.length) {
    return { records: cached, reusedCount: previous.length, cachedCount: cached.length };
  }
  const trailing = decodeCachedLine(read.bytes.toString('utf8', completeEnd), target.decode, {
    path: target.filePath,
    lineNo: cached.length + 1,
  });
  return {
    records: Object.freeze([...cached, trailing]),
    reusedCount: previous.length,
    cachedCount: cached.length,
  };
}

function decodeLines<T>(target: IncrementTarget<T>, bytes: Buffer, lineOffset: number): T[] {
  const records: T[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset);
    // Decode each line separately so values cannot retain whole-file strings. On real histories
    // the decoded records then take about 1.1x the file bytes; decoding the whole file as one
    // string and splitting it measured about 3x.
    records.push(
      decodeCachedLine(bytes.toString('utf8', offset, end), target.decode, {
        path: target.filePath,
        lineNo: lineOffset + records.length + 1,
      }),
    );
    offset = end + 1;
  }
  return records;
}

function rememberCachedPrefix<T>(
  target: IncrementTarget<T>,
  prefix: {
    readonly records: readonly T[];
    readonly previousIdentity: JsonlCachedIdentity | undefined;
    readonly covered: Buffer;
    readonly size: number;
  },
): void {
  const previousHead = prefix.previousIdentity?.head ?? Buffer.alloc(0);
  const previousTail = prefix.previousIdentity?.tail ?? Buffer.alloc(0);
  target.cache.records = prefix.records;
  target.cache.size = prefix.size;
  target.cache.identity = {
    dev: target.info.dev,
    ino: target.info.ino,
    mtimeMs: target.info.mtimeMs,
    // Copy the samples so the cache never retains the read buffer.
    // Concatenate at most one sample of new bytes so a full read is never copied whole.
    head: Buffer.concat([
      previousHead,
      prefix.covered.subarray(0, JSONL_PREFIX_SAMPLE_BYTES - previousHead.length),
    ]),
    tail: Buffer.concat([
      previousTail,
      prefix.covered.subarray(-JSONL_PREFIX_SAMPLE_BYTES),
    ]).subarray(-JSONL_PREFIX_SAMPLE_BYTES),
  };
}

async function readFileRange(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const contents = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(contents, offset, length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === length ? contents : contents.subarray(0, offset);
}

function decodeCachedLine<T>(
  line: string,
  decode: (value: unknown) => T,
  location: { path: string; lineNo: number },
): T {
  try {
    if (line.trim().length === 0) throw new Error('blank line');
    return decode(parseJsonLine(line));
  } catch (error) {
    throw malformedLineError({ ...location, reason: errorReason(error) });
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    // V8 may include the source payload in SyntaxError.message. Never surface it in diagnostics.
    throw new Error('invalid JSON');
  }
}

/**
 * Appends must be serialized per file by the caller's exclusive/per-session lane.
 * This primitive does not provide cross-process writer locking.
 */
export async function appendJsonl(filePath: string, records: readonly unknown[]): Promise<void> {
  const serialized = serializeRecords(records);
  if (serialized.length === 0) return;

  const parentPath = dirname(filePath);
  await mkdir(parentPath, { recursive: true });
  let handle = await openExistingAppendTarget(filePath);
  while (!handle) {
    if (await publishInitialJsonl(filePath, serialized)) {
      await syncDirectoryBestEffort(parentPath);
      return;
    }
    handle = await openExistingAppendTarget(filePath);
  }

  const attempt: AppendAttempt = { failed: false };
  try {
    const initialStat = await handle.stat();
    attempt.preAppendSize = initialStat.size;
    attempt.payload = (await needsLineBoundary(handle, attempt.preAppendSize))
      ? Buffer.concat([Buffer.from('\n'), serialized])
      : serialized;
    const { bytesWritten } = await handle.write(attempt.payload);
    if (bytesWritten !== attempt.payload.length) {
      throw new Error(
        `Short JSONL append: wrote ${bytesWritten} of ${attempt.payload.length} bytes`,
      );
    }
    await handle.sync();
  } catch (error) {
    attempt.failed = true;
    attempt.error = error;
  }
  await closeAndRecoverAppend(filePath, handle, attempt);
  await syncDirectoryBestEffort(parentPath);
}

async function closeAndRecoverAppend(
  filePath: string,
  handle: Awaited<ReturnType<typeof open>>,
  attempt: AppendAttempt,
): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    if (!attempt.failed) {
      attempt.failed = true;
      attempt.error = error;
    }
    await closeBestEffort(handle);
  }
  if (!attempt.failed) return;
  await recoverAppendFailure(filePath, attempt);
}

async function recoverAppendFailure(filePath: string, attempt: AppendAttempt): Promise<void> {
  if (attempt.preAppendSize === undefined || attempt.payload === undefined) {
    throw attempt.error;
  }
  const committed = await recoverFailedAppend(filePath, attempt.preAppendSize, attempt.payload);
  if (committed) return;
  throw attempt.error;
}

export async function writeJsonlAtomically(
  filePath: string,
  records: readonly unknown[],
  validateTemporary?: (temporaryPath: string) => void | Promise<void>,
): Promise<void> {
  await replaceFileAtomically(filePath, serializeRecords(records), validateTemporary);
}

/**
 * Replaces a private file only after a complete same-directory staging file is
 * durable. The target is never truncated in place: until rename succeeds it
 * remains authoritative, and a crash after rename leaves a complete payload.
 */
export async function replaceFileAtomically(
  filePath: string,
  contents: string | Buffer,
  validateTemporary?: (temporaryPath: string) => void | Promise<void>,
): Promise<void> {
  const payload = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
  const parentPath = dirname(filePath);
  const temporaryPath = join(
    parentPath,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(parentPath, { recursive: true });

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  let renamed = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (validateTemporary) {
      await validateTemporary(temporaryPath);
      await syncFile(temporaryPath);
    }
    await renameWithRetries(temporaryPath, filePath);
    renamed = true;
  } catch (error) {
    if (handle) await closeBestEffort(handle);
    if (temporaryCreated && !renamed) await removeBestEffort(temporaryPath);
    throw error;
  }
  await syncDirectoryBestEffort(parentPath);
}

export type FilePublicationOutcome = 'published' | 'already-exists';

/**
 * Publishes a complete file only when the target is absent.
 *
 * The staging file is private, durable, and in the target directory. Publication uses an
 * atomic hard link so a racing target is authoritative and is never overwritten.
 */
export async function publishFileIfAbsent(
  filePath: string,
  contents: string | Buffer,
  validateTemporary?: (temporaryPath: string) => void | Promise<void>,
): Promise<FilePublicationOutcome> {
  return publishFileIfAbsentWithLabel(
    filePath,
    typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents,
    validateTemporary,
    'file',
  );
}

/** Publishes a complete JSONL file only when the target is absent. */
export async function publishJsonlIfAbsent(
  filePath: string,
  records: readonly unknown[],
  validateTemporary?: (temporaryPath: string) => void | Promise<void>,
): Promise<FilePublicationOutcome> {
  return publishFileIfAbsentWithLabel(
    filePath,
    serializeRecords(records),
    validateTemporary,
    'JSONL',
  );
}

/**
 * Publishes a byte copy of an existing file only when the target is absent. The copy shares
 * storage where the filesystem supports copy-on-write; elsewhere Node copies the bytes.
 */
export async function publishFileCopyIfAbsent(
  sourcePath: string,
  filePath: string,
  validateTemporary?: (temporaryPath: string) => void | Promise<void>,
): Promise<FilePublicationOutcome> {
  return publishStagedFileIfAbsent(
    filePath,
    async (stagingPath) => {
      await copyFile(
        sourcePath,
        stagingPath,
        fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE,
      );
      // A copy inherits the source mode; publication keeps the private mode every writer uses.
      await chmod(stagingPath, 0o600);
      await syncFile(stagingPath);
    },
    validateTemporary,
    'copied file',
  );
}

async function publishFileIfAbsentWithLabel(
  filePath: string,
  payload: Buffer,
  validateTemporary: ((temporaryPath: string) => void | Promise<void>) | undefined,
  label: string,
): Promise<FilePublicationOutcome> {
  return publishStagedFileIfAbsent(
    filePath,
    async (stagingPath) => {
      const handle = await open(stagingPath, 'wx', 0o600);
      try {
        await writeInOneCall(handle, payload, label);
        await handle.sync();
      } catch (error) {
        await closeBestEffort(handle);
        throw error;
      }
      await handle.close();
    },
    validateTemporary,
    label,
  );
}

/**
 * Fails fast when the filesystem of a directory cannot create hard links, which the first
 * publication of every file in this module needs. A probe that cannot create its own file, or
 * whose link fails for a reason other than missing hard-link support, is inconclusive and returns,
 * so the real write reports that failure instead.
 */
export async function assertHardLinkPublicationSupported(directoryPath: string): Promise<void> {
  const probe = await probeHardLinkPublication(directoryPath);
  if (probe.kind === 'unsupported') throw new HardLinkUnsupportedError(directoryPath, probe.error);
}

type HardLinkProbe =
  | { readonly kind: 'supported' }
  | { readonly kind: 'inconclusive' }
  | { readonly kind: 'unsupported'; readonly error: unknown };

/**
 * Windows reports a filesystem without hard links and a file another process briefly holds with
 * overlapping errno codes such as EPERM, so a failed publication link is blamed on the filesystem
 * only when a fresh probe in the same directory fails as well.
 */
async function explainLinkFailure(directoryPath: string, linkError: unknown): Promise<unknown> {
  const probe = await probeHardLinkPublication(directoryPath);
  return probe.kind === 'unsupported'
    ? new HardLinkUnsupportedError(directoryPath, linkError)
    : linkError;
}

/** Creates a private file, links it, and removes both; the link waits out a transient lock. */
async function probeHardLinkPublication(directoryPath: string): Promise<HardLinkProbe> {
  const sourcePath = join(directoryPath, `.hard-link-probe.${process.pid}.${randomUUID()}`);
  const linkPath = `${sourcePath}.link`;
  try {
    try {
      await mkdir(directoryPath, { recursive: true });
      const handle = await open(sourcePath, 'wx', 0o600);
      await handle.close();
    } catch {
      return { kind: 'inconclusive' };
    }
    try {
      await withFileLockRetries('link-probe', linkPath, () => link(sourcePath, linkPath));
      return { kind: 'supported' };
    } catch (error) {
      // EIO, ENOENT, a full disk, or EBUSY/EACCES past the lock retries says nothing about links.
      return linkErrorMeansNoHardLinks(error)
        ? { kind: 'unsupported', error }
        : { kind: 'inconclusive' };
    }
  } finally {
    await removeBestEffort(linkPath);
    await removeBestEffort(sourcePath);
  }
}

/**
 * The staging file is private, durable, and in the target directory. Publication uses an
 * atomic hard link so a racing target is authoritative and is never overwritten.
 */
async function publishStagedFileIfAbsent(
  filePath: string,
  createStaging: (stagingPath: string) => Promise<void>,
  validateTemporary: ((temporaryPath: string) => void | Promise<void>) | undefined,
  label: string,
): Promise<FilePublicationOutcome> {
  const parentPath = dirname(filePath);
  const stagingPath = join(
    parentPath,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.publish`,
  );
  await mkdir(parentPath, { recursive: true });

  let outcome: 'published' | 'already-exists' | undefined;
  let failure: unknown;
  try {
    await createStaging(stagingPath);
    if (validateTemporary) {
      await validateTemporary(stagingPath);
      await syncFile(stagingPath);
    }
    try {
      await link(stagingPath, filePath);
      outcome = 'published';
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw await explainLinkFailure(parentPath, error);
      outcome = 'already-exists';
    }
  } catch (error) {
    failure = error;
  } finally {
    // The staging name is unique to this call, so removing it never touches another writer.
    await removeBestEffort(stagingPath);
  }
  await syncDirectoryBestEffort(parentPath);
  if (failure !== undefined) throw failure;
  if (outcome === undefined) throw new Error(`${label} publication produced no outcome`);
  return outcome;
}

/** Writes the payload in one call; a short write fails the publication and is not resumed. */
async function writeInOneCall(
  handle: Awaited<ReturnType<typeof open>>,
  payload: Buffer,
  label: string,
): Promise<void> {
  const { bytesWritten } = await handle.write(payload);
  if (bytesWritten !== payload.length) {
    throw new Error(`Short ${label} publication: wrote ${bytesWritten} of ${payload.length} bytes`);
  }
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function malformedLineError(line: JsonlMalformedLine): Error {
  return new Error(`Malformed JSONL in ${line.path} at line ${line.lineNo}: ${line.reason}`);
}

function serializeRecords(records: readonly unknown[]): Buffer {
  const lines: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    assertJsonSerializable(record, `record ${String(index + 1)}`);
    const line = JSON.stringify(record);
    if (line === undefined) throw jsonSerializationError(`record ${String(index + 1)}`);
    lines.push(line);
  }
  return Buffer.from(lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf-8');
}

function assertJsonSerializable(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (isJsonPrimitive(value)) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw jsonSerializationError(`${path} is not finite`);
    return;
  }
  if (typeof value !== 'object') throw jsonSerializationError(`${path} is not a JSON value`);
  assertJsonContainer(value, path, ancestors);
}

function isJsonPrimitive(value: unknown): value is null | string | boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean';
}

function assertJsonContainer(value: object, path: string, ancestors: Set<object>): void {
  if (ancestors.has(value)) throw jsonSerializationError(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertJsonArray(value, path, ancestors);
      return;
    }
    assertPlainJsonObject(value, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function assertPlainJsonObject(value: object, path: string, ancestors: Set<object>): void {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw jsonSerializationError(`${path} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw jsonSerializationError(`${path} contains a symbol key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw jsonSerializationError(`${path}.${key} is not an enumerable data property`);
    }
    assertJsonSerializable(descriptor.value, `${path}.${key}`, ancestors);
  }
}

function assertJsonArray(value: readonly unknown[], path: string, ancestors: Set<object>): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw jsonSerializationError(`${path}[${String(index)}] is a sparse array hole`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw jsonSerializationError(`${path}[${String(index)}] is not an enumerable data property`);
    }
    assertJsonSerializable(descriptor.value, `${path}[${String(index)}]`, ancestors);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)) {
      throw jsonSerializationError(`${path} contains a non-JSON array property`);
    }
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function jsonSerializationError(reason: string): TypeError {
  return new TypeError(`JSONL records must be JSON-serializable values: ${reason}`);
}

async function openExistingAppendTarget(
  filePath: string,
): Promise<Awaited<ReturnType<typeof open>> | undefined> {
  try {
    // String append flags include O_CREAT; numeric flags let an absent target take the staged path.
    // Nothing has been written yet, so waiting out a held target cannot duplicate records.
    return await withFileLockRetries('append-open', filePath, () =>
      open(filePath, fsConstants.O_RDWR | fsConstants.O_APPEND),
    );
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/**
 * Publishes a fully durable initial payload without ever exposing an empty target.
 * Hard-link creation is atomic and fails with EEXIST instead of replacing a racing target.
 * Node has no cross-platform unlink-by-handle or rename-no-replace API, so macOS/Windows
 * filesystems that reject hard links fail conservatively before the authoritative path exists,
 * with an error that names the directory once a probe confirms the limitation.
 */
async function publishInitialJsonl(filePath: string, payload: Buffer): Promise<boolean> {
  const parentPath = dirname(filePath);
  const stagingPath = join(
    parentPath,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.append`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let stagingCreated = false;
  try {
    handle = await open(stagingPath, 'wx+', 0o600);
    stagingCreated = true;
    const stagingStat = await handle.stat();
    if (stagingStat.size !== 0) throw new Error('Exclusive JSONL staging file is not empty');
    const { bytesWritten } = await handle.write(payload);
    if (bytesWritten !== payload.length) {
      throw new Error(`Short JSONL append: wrote ${bytesWritten} of ${payload.length} bytes`);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(stagingPath, filePath);
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) return false;
      throw await explainLinkFailure(parentPath, error);
    }
    return true;
  } finally {
    if (handle) await closeBestEffort(handle);
    if (stagingCreated) await removeBestEffort(stagingPath);
  }
}

async function needsLineBoundary(
  handle: Awaited<ReturnType<typeof open>>,
  fileSize: number,
): Promise<boolean> {
  if (fileSize === 0) return false;
  const lastByte = Buffer.alloc(1);
  const { bytesRead } = await handle.read(lastByte, 0, 1, fileSize - 1);
  if (bytesRead !== 1) throw new Error('Could not read the JSONL file boundary');
  return lastByte[0] !== 0x0a;
}

async function recoverFailedAppend(
  filePath: string,
  preAppendSize: number,
  payload: Buffer,
): Promise<boolean> {
  try {
    const postAppendSize = await fileSizeAfterFailure(filePath, preAppendSize);
    const writtenLength = postAppendSize - preAppendSize;
    if (writtenLength === 0) return false;
    if (writtenLength < 0 || writtenLength > payload.length) {
      throw new Error('JSONL append size is outside the expected payload range');
    }
    const written = await readRange(filePath, preAppendSize, writtenLength);
    if (!written.equals(payload.subarray(0, writtenLength))) {
      throw new Error('JSONL append bytes do not match the expected payload');
    }
    if (writtenLength === payload.length) {
      await truncateAndSync(filePath);
      return true;
    }
    await truncateAndSync(filePath, preAppendSize);
    return false;
  } catch (error) {
    throw new JsonlAppendCommitUncertainError(filePath, error);
  }
}

async function fileSizeAfterFailure(filePath: string, preAppendSize: number): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (preAppendSize === 0 && hasErrorCode(error, 'ENOENT')) return 0;
    throw error;
  }
}

async function readRange(filePath: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const contents = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(contents, offset, length - offset, start + offset);
      if (bytesRead === 0) throw new Error('Could not read the appended JSONL bytes');
      offset += bytesRead;
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function truncateAndSync(filePath: string, size?: number): Promise<void> {
  const handle = await open(filePath, 'r+');
  try {
    if (size !== undefined) await handle.truncate(size);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}

async function renameWithRetries(temporaryPath: string, filePath: string): Promise<void> {
  await withFileLockRetries('rename', filePath, () => rename(temporaryPath, filePath));
}

async function withFileLockRetries<T>(
  operation: FileLockRetry['operation'],
  filePath: string,
  run: () => Promise<T>,
): Promise<T> {
  let waitedMs = 0;
  let lockCode: string | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const retry = (outcome: FileLockRetry['outcome'], code: string | undefined) => ({
      operation,
      filePath,
      code,
      attempts: attempt,
      waitedMs,
      outcome,
    });
    try {
      const result = await run();
      logFileLockRetry(retry('recovered', lockCode));
      return result;
    } catch (error) {
      const code = transientFileLockCode(error);
      const delayMs = code === undefined ? undefined : FILE_LOCK_RETRY_DELAYS_MS[attempt - 1];
      if (delayMs === undefined) {
        logFileLockRetry(retry(code ? 'exhausted' : 'failed', code ?? lockCode));
        throw error;
      }
      lockCode = code;
      await sleep(delayMs);
      waitedMs += delayMs;
    }
  }
}

interface FileLockRetry {
  readonly operation: 'append-open' | 'link-probe' | 'rename';
  readonly filePath: string;
  /** Last lock code seen; a `failed` wait ended on a different, non-transient error. */
  readonly code: string | undefined;
  readonly attempts: number;
  readonly waitedMs: number;
  readonly outcome: 'recovered' | 'exhausted' | 'failed';
}

function linkErrorMeansNoHardLinks(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && HARD_LINK_UNSUPPORTED_CODES.has(code);
}

function transientFileLockCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && TRANSIENT_FILE_LOCK_CODES.has(code) ? code : undefined;
}

/** Logs one line per wait; an operation that never met a lock logs nothing. */
function logFileLockRetry(retry: FileLockRetry): void {
  if (retry.code === undefined) return;
  logger.warn(
    {
      operation: retry.operation,
      code: retry.code,
      attempts: retry.attempts,
      waited_ms: retry.waitedMs,
      outcome: retry.outcome,
      file: basename(retry.filePath),
    },
    '[jsonl] file held by another process',
  );
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function closeBestEffort(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Cleanup must preserve the primary write, validation, or rename error.
  }
}

async function removeBestEffort(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch {
    // Cleanup must preserve the primary write, validation, or rename error.
  }
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directoryPath, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unsupported on some platforms and filesystems.
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The primary file operation is already durable enough to report success.
      }
    }
  }
}
