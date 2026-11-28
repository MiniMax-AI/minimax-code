import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { PLUGIN_PACKAGE_V1_LIMITS, validatePluginPortablePath } from './package-contract.js';
import { PluginReaderError, readerFail } from './reader-errors.js';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export interface CanonicalPluginRoot {
  readonly path: string;
}

export async function canonicalizePluginRoot(
  root: string,
  options: { rejectSymlink?: boolean } = {},
): Promise<CanonicalPluginRoot> {
  try {
    const rootStat = await lstat(root);
    if (options.rejectSymlink && rootStat.isSymbolicLink()) {
      readerFail('PLUGIN_ROOT_SYMLINK', 'Plugin root must be a physical directory');
    }
    if (!rootStat.isDirectory())
      readerFail('PLUGIN_ROOT_INVALID', 'Plugin root is not a directory');
    return { path: await realpath(root) };
  } catch (error) {
    rethrowReaderError(error, 'PLUGIN_ROOT_INVALID', 'Plugin root cannot be resolved');
  }
}

export async function resolvePluginFile(
  root: CanonicalPluginRoot,
  relativePath: string,
  options: { portable?: boolean } = {},
): Promise<string> {
  const resolved = await resolvePluginPath(root, relativePath, options);
  try {
    if (!(await stat(resolved)).isFile()) {
      readerFail('PLUGIN_FILE_INVALID', `${relativePath} is not a regular file`);
    }
    return resolved;
  } catch (error) {
    rethrowReaderError(error, 'PLUGIN_FILE_NOT_FOUND', `${relativePath} is not readable`);
  }
}

export async function resolvePluginDirectory(
  root: CanonicalPluginRoot,
  relativePath: string,
): Promise<string> {
  const resolved = await resolvePluginPath(root, relativePath);
  try {
    if (!(await stat(resolved)).isDirectory()) {
      readerFail('PLUGIN_DIRECTORY_INVALID', `${relativePath} is not a directory`);
    }
    return resolved;
  } catch (error) {
    rethrowReaderError(error, 'PLUGIN_DIRECTORY_NOT_FOUND', `${relativePath} is not readable`);
  }
}

export async function readPluginTextFile(
  root: CanonicalPluginRoot,
  relativePath: string,
  options: { portable?: boolean; rejectBom?: boolean; maxBytes?: number } = {},
): Promise<{ path: string; content: string }> {
  const maxBytes = options.maxBytes ?? PLUGIN_PACKAGE_V1_LIMITS.maxFileBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  const filePath = await resolvePluginFile(root, relativePath, options);
  const bytes = await readStablePluginFile(
    filePath,
    relativePath,
    Math.min(maxBytes, PLUGIN_PACKAGE_V1_LIMITS.maxFileBytes),
  );
  let content: string;
  try {
    content = UTF8_DECODER.decode(bytes);
  } catch {
    readerFail('PLUGIN_TEXT_INVALID_UTF8', `${relativePath} is not valid UTF-8`);
  }
  if (options.rejectBom && content.charCodeAt(0) === 0xfeff) {
    readerFail('PLUGIN_TEXT_BOM_NOT_ALLOWED', `${relativePath} starts with a BOM`);
  }
  return { path: filePath, content };
}

async function readStablePluginFile(
  filePath: string,
  relativePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, flags);
  } catch (error) {
    rethrowReaderError(error, 'PLUGIN_FILE_NOT_FOUND', `${relativePath} is not readable`);
  }
  try {
    const before = await handle.stat();
    assertReadableFileSnapshot(before, relativePath, maxBytes);
    const bytes = await readExactFile(handle, before.size, relativePath);
    const after = await handle.stat();
    if (!sameFileSnapshot(before, after)) {
      readerFail('PLUGIN_FILE_CHANGED', `${relativePath} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertReadableFileSnapshot(
  snapshot: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  relativePath: string,
  maxBytes: number,
): void {
  if (!snapshot.isFile()) {
    readerFail('PLUGIN_FILE_INVALID', `${relativePath} is not a regular file`);
  }
  if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0) {
    readerFail('PLUGIN_FILE_INVALID', `${relativePath} has an invalid size`);
  }
  if (snapshot.size > maxBytes) {
    readerFail('PLUGIN_FILE_TOO_LARGE', `${relativePath} exceeds the file limit`);
  }
}

async function readExactFile(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  relativePath: string,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) {
      readerFail('PLUGIN_FILE_CHANGED', `${relativePath} changed while it was read`);
    }
    offset += bytesRead;
  }
  const extra = Buffer.allocUnsafe(1);
  if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) {
    readerFail('PLUGIN_FILE_CHANGED', `${relativePath} changed while it was read`);
  }
  return bytes;
}

export async function readPluginJsonObject(
  root: CanonicalPluginRoot,
  relativePath: string,
  options: { portable?: boolean } = {},
): Promise<{ path: string; value: Record<string, unknown> }> {
  const text = await readPluginTextFile(root, relativePath, {
    ...options,
    rejectBom: true,
  });
  let value: unknown;
  try {
    value = JSON.parse(text.content);
  } catch {
    readerFail('PLUGIN_JSON_INVALID', `${relativePath} is not valid JSON`);
  }
  if (!isRecord(value)) readerFail('PLUGIN_JSON_INVALID', `${relativePath} must be a JSON object`);
  return { path: text.path, value };
}

export async function listDirectChildDirectories(
  root: CanonicalPluginRoot,
  relativePath: string,
): Promise<Array<{ name: string; relativePath: string }>> {
  const directory = await resolvePluginDirectory(root, relativePath);
  const children = await readdir(directory, { withFileTypes: true });
  const result: Array<{ name: string; relativePath: string }> = [];
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = joinRelative(relativePath, child.name);
    try {
      await resolvePluginDirectory(root, childRelative);
      result.push({ name: child.name, relativePath: childRelative });
    } catch (error) {
      if (error instanceof PluginReaderError && error.code === 'PLUGIN_DIRECTORY_NOT_FOUND')
        continue;
      if (error instanceof PluginReaderError && error.code === 'PLUGIN_DIRECTORY_INVALID') continue;
      throw error;
    }
  }
  return result;
}

export async function pluginPathExists(
  root: CanonicalPluginRoot,
  relativePath: string,
  kind: 'file' | 'directory',
): Promise<boolean> {
  try {
    if (kind === 'file') await resolvePluginFile(root, relativePath);
    else await resolvePluginDirectory(root, relativePath);
    return true;
  } catch (error) {
    if (
      error instanceof PluginReaderError &&
      (error.code === 'PLUGIN_FILE_NOT_FOUND' ||
        error.code === 'PLUGIN_DIRECTORY_NOT_FOUND' ||
        error.code === 'PLUGIN_PATH_NOT_FOUND' ||
        error.code === 'PLUGIN_FILE_INVALID' ||
        error.code === 'PLUGIN_DIRECTORY_INVALID')
    ) {
      return false;
    }
    throw error;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function resolvePluginPath(
  root: CanonicalPluginRoot,
  relativePath: string,
  options: { portable?: boolean } = {},
): Promise<string> {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.includes('\0')
  ) {
    readerFail('PATH_OUTSIDE_ROOT', 'Plugin path must be relative');
  }
  const normalizedForContract = relativePath.replace(/^\.[/\\]/u, '').replaceAll('\\', '/');
  if (options.portable) validatePluginPortablePath(normalizedForContract);
  const candidate = path.resolve(root.path, ...relativePath.split(/[\\/]/u));
  if (!isInside(root.path, candidate)) readerFail('PATH_OUTSIDE_ROOT', 'path escapes Plugin root');
  try {
    const canonical = await realpath(candidate);
    if (!isInside(root.path, canonical)) {
      readerFail('PATH_OUTSIDE_ROOT', 'path resolves outside Plugin root');
    }
    return canonical;
  } catch (error) {
    rethrowReaderError(error, 'PLUGIN_PATH_NOT_FOUND', `${relativePath} does not exist`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function joinRelative(parent: string, child: string): string {
  return parent === '.' || parent === './' ? child : `${parent.replace(/\/$/u, '')}/${child}`;
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

function rethrowReaderError(error: unknown, code: string, detail: string): never {
  if (error instanceof PluginReaderError) throw error;
  throw new PluginReaderError(code, detail);
}
