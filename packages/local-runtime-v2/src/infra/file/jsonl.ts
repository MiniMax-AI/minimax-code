import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const RENAME_RETRY_DELAYS_MS = [50, 100, 150] as const;
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

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

export interface JsonlReadCache<T> {
  bytes: Buffer;
  records: readonly T[];
}

export async function readJsonl<T>(
  filePath: string,
  decode: (value: unknown) => T,
  onMalformedLine?: (line: JsonlMalformedLine) => void,
  /** Strict private reads return immutable arrays when a cache is supplied. */
  readCache?: JsonlReadCache<T>,
  onReadBytes?: (bytes: Buffer) => void,
): Promise<T[]> {
  // Tolerant readers must still report every malformed line on every read.
  if (readCache && !onMalformedLine) return readCachedJsonl(filePath, decode, readCache, onReadBytes);
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

async function readCachedJsonl<T>(
  filePath: string,
  decode: (value: unknown) => T,
  cache: JsonlReadCache<T>,
  onReadBytes?: (bytes: Buffer) => void,
): Promise<T[]> {
  // Always read fresh bytes: timestamps and file size cannot prove an unchanged
  // prefix. Compare before decoding to avoid allocating a whole-history string.
  const bytes = await readFile(filePath);
  onReadBytes?.(bytes);
  if (bytes.equals(cache.bytes)) return cache.records as T[];
  const reuse = cache.bytes.at(-1) === 10 &&
    bytes.length >= cache.bytes.length &&
    bytes.subarray(0, cache.bytes.length).equals(cache.bytes);
  const records: T[] = reuse ? [...cache.records] : [];
  let offset = reuse ? cache.bytes.length : 0;
  const limit = 4 * 1024 * 1024;
  let retainedEnd = offset;
  let retainedRecords = records.length;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset);
    const end = newline === -1 ? bytes.length : newline;
    try {
      // Decode each line separately so parsed values cannot retain a string
      // slice of an older whole file.
      const line = bytes.toString('utf8', offset, end);
      if (line.trim().length === 0) throw new Error('blank line');
      records.push(decode(parseJsonLine(line)));
    } catch (error) {
      throw malformedLineError({
        path: filePath, lineNo: records.length + 1, reason: errorReason(error),
      });
    }
    offset = newline === -1 ? bytes.length : newline + 1;
    if (newline !== -1 && offset <= limit) {
      retainedEnd = offset;
      retainedRecords = records.length;
    }
  }
  if (bytes.length <= limit) {
    cache.bytes = bytes;
    cache.records = Object.freeze(records);
  } else {
    // Copy the bounded prefix so it cannot retain the entire file's buffer.
    cache.bytes = Buffer.from(bytes.subarray(0, retainedEnd));
    cache.records = Object.freeze(records.slice(0, retainedRecords));
  }
  return Object.freeze(records) as T[];
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

async function publishFileIfAbsentWithLabel(
  filePath: string,
  payload: Buffer,
  validateTemporary: ((temporaryPath: string) => void | Promise<void>) | undefined,
  label: string,
): Promise<FilePublicationOutcome> {
  const parentPath = dirname(filePath);
  const stagingPath = join(
    parentPath,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.publish`,
  );
  await mkdir(parentPath, { recursive: true });

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let stagingCreated = false;
  let outcome: 'published' | 'already-exists' | undefined;
  let failure: unknown;
  try {
    handle = await open(stagingPath, 'wx', 0o600);
    stagingCreated = true;
    const { bytesWritten } = await handle.write(payload);
    if (bytesWritten !== payload.length) {
      throw new Error(
        `Short ${label} publication: wrote ${bytesWritten} of ${payload.length} bytes`,
      );
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (validateTemporary) {
      await validateTemporary(stagingPath);
      await syncFile(stagingPath);
    }
    try {
      await link(stagingPath, filePath);
      outcome = 'published';
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
      outcome = 'already-exists';
    }
  } catch (error) {
    failure = error;
  } finally {
    if (handle) await closeBestEffort(handle);
    if (stagingCreated) await removeBestEffort(stagingPath);
  }
  await syncDirectoryBestEffort(parentPath);
  if (failure !== undefined) throw failure;
  if (outcome === undefined) throw new Error(`${label} publication produced no outcome`);
  return outcome;
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
    return await open(filePath, fsConstants.O_RDWR | fsConstants.O_APPEND);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/**
 * Publishes a fully durable initial payload without ever exposing an empty target.
 * Hard-link creation is atomic and fails with EEXIST instead of replacing a racing target.
 * Node has no cross-platform unlink-by-handle or rename-no-replace API, so macOS/Windows
 * filesystems that reject hard links fail conservatively before the authoritative path exists.
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
      throw error;
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
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporaryPath, filePath);
      return;
    } catch (error) {
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      if (!isTransientRenameError(error) || delayMs === undefined) throw error;
      await sleep(delayMs);
    }
  }
}

function isTransientRenameError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '')
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
