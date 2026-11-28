import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import JSZip from 'jszip';

import { PluginSystemError } from '../../errors.js';
import {
  computePluginContentDigest,
  PLUGIN_PACKAGE_V1_LIMITS,
  type PluginContractEntry,
} from '../package/package-contract.js';
import { githubArchiveUrl, type GithubPluginSource } from './github-source.js';

const DOWNLOAD_TIMEOUT_MS = 300_000;
// A repository archive is only the transport envelope. The selected Plugin
// subtree still uses the stricter 64 MiB / 1,024-file package contract below.
const MAX_GITHUB_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_GITHUB_ARCHIVE_ENTRIES = 100_000;

const execFileAsync = promisify(execFile);
const GIT_CLONE_TIMEOUT_MS = 120_000;

export interface ExtractedGithubPlugin {
  readonly rootPath: string;
  readonly packageSizeBytes: number;
  discard(): Promise<void>;
}

export async function cloneGitRepositoryPlugin(
  dataDir: string,
  source: GithubPluginSource,
  signal?: AbortSignal,
): Promise<ExtractedGithubPlugin> {
  const stagingParent = path.join(dataDir, 'v2', 'plugin-import');
  await mkdir(stagingParent, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(stagingParent, 'git-'));
  const cloneRoot = path.join(temporaryRoot, 'repo');
  const rootPath = source.subPath ? path.join(cloneRoot, ...source.subPath.split('/')) : cloneRoot;
  try {
    await execFileAsync(
      'git',
      [
        'clone',
        '--no-checkout',
        '--filter=blob:none',
        '--no-tags',
        source.repositoryUrl,
        cloneRoot,
      ],
      {
        timeout: GIT_CLONE_TIMEOUT_MS,
        signal,
        windowsHide: true,
        maxBuffer: 256 * 1024,
      },
    );
    await execFileAsync(
      'git',
      ['-C', cloneRoot, 'fetch', '--depth', '1', 'origin', source.commitSha],
      {
        timeout: GIT_CLONE_TIMEOUT_MS,
        signal,
        windowsHide: true,
        maxBuffer: 256 * 1024,
      },
    );
    await execFileAsync('git', ['-C', cloneRoot, 'checkout', '--detach', source.commitSha], {
      timeout: GIT_CLONE_TIMEOUT_MS,
      signal,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    await rm(path.join(cloneRoot, '.git'), { recursive: true, force: true });
    const { computePluginDirectoryDigest } = await import('../package/package-contract.js');
    const digest = await computePluginDirectoryDigest(rootPath, { pathPolicy: 'unrestricted' });
    return {
      rootPath,
      packageSizeBytes: digest.totalBytes,
      discard: async () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    if (signal?.aborted) throw error;
    fail('GIT_REPOSITORY_UNAVAILABLE', 'Git repository clone failed');
  }
}

export async function downloadGithubPlugin(
  dataDir: string,
  source: GithubPluginSource,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ExtractedGithubPlugin> {
  const buffer = await downloadBounded(githubArchiveUrl(source), fetchImpl, signal);
  const zip = await loadZip(buffer);
  const entries = await collectPluginEntries(zip, source.subPath);
  const modes = new Map(entries.map((entry) => [entry.path, entry.mode]));
  const digest = computePluginContentDigest(entries, { pathPolicy: 'agent-plugin' });
  const stagingParent = path.join(dataDir, 'v2', 'plugin-import');
  await mkdir(stagingParent, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(stagingParent, 'github-'));
  const rootPath = path.join(temporaryRoot, 'plugin');
  try {
    await mkdir(rootPath);
    for (const entry of digest.files) {
      const destination = path.join(rootPath, ...entry.path.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, entry.content as Buffer, {
        flag: 'wx',
        mode: modes.get(entry.path) ?? 0o644,
      });
    }
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  let active = true;
  return {
    rootPath,
    packageSizeBytes: digest.totalBytes,
    discard: async () => {
      if (!active) return;
      active = false;
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

async function downloadBounded(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Buffer> {
  const response = await fetchArchive(url, fetchImpl, signal);
  validateArchiveResponse(response);
  return readResponseBounded(response.body as ReadableStream<Uint8Array>, signal);
}

async function fetchArchive(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { 'User-Agent': 'MiniMax-Code' },
      signal: requestSignal(signal, DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    fail('GITHUB_ARCHIVE_UNAVAILABLE', 'GitHub archive download failed');
  }
  return response;
}

function validateArchiveResponse(response: Response): void {
  if (!response.ok || !response.body) {
    fail('GITHUB_ARCHIVE_UNAVAILABLE', `GitHub archive returned ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_GITHUB_ARCHIVE_BYTES) {
    fail('GITHUB_ARCHIVE_TOO_LARGE', 'GitHub repository archive exceeds 512 MiB');
  }
}

async function readResponseBounded(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  let result = await readArchiveChunk(reader, signal);
  while (!result.done) {
    total += result.value.byteLength;
    if (total > MAX_GITHUB_ARCHIVE_BYTES) {
      await reader.cancel();
      fail('GITHUB_ARCHIVE_TOO_LARGE', 'GitHub repository archive exceeds 512 MiB');
    }
    chunks.push(Buffer.from(result.value));
    result = await readArchiveChunk(reader, signal);
  }
  return Buffer.concat(chunks, total);
}

async function readArchiveChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  try {
    return await reader.read();
  } catch (error) {
    if (signal?.aborted) throw error;
    fail('GITHUB_ARCHIVE_UNAVAILABLE', 'GitHub archive download failed');
  }
}

async function loadZip(buffer: Buffer): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(buffer);
  } catch {
    fail('GITHUB_ARCHIVE_INVALID', 'GitHub archive is not a valid ZIP');
  }
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function collectPluginEntries(
  zip: JSZip,
  subPath: string | undefined,
): Promise<GithubArchiveEntry[]> {
  const all = Object.values(zip.files);
  validateArchiveEntries(all);
  const prefix = findArchivePrefix(all.map((item) => item.name));
  const selectedPrefix = `${prefix}${subPath ? `${subPath}/` : ''}`;
  const entries: GithubArchiveEntry[] = [];
  const state = { fileCount: 0, totalBytes: 0 };
  for (const item of all) {
    if (!item.name.startsWith(selectedPrefix) || isSymlink(item)) continue;
    const relativePath = item.name.slice(selectedPrefix.length).replace(/\/$/u, '');
    if (!relativePath) continue;
    entries.push(await toContractEntry(item, relativePath, state));
  }
  if (entries.length === 0) fail('GITHUB_SUB_PATH_NOT_FOUND', 'Selected GitHub directory is empty');
  return entries;
}

function validateArchiveEntries(entries: readonly JSZip.JSZipObject[]): void {
  if (entries.length > MAX_GITHUB_ARCHIVE_ENTRIES) {
    fail('GITHUB_ARCHIVE_TOO_MANY_ENTRIES', 'GitHub repository archive has too many entries');
  }
  for (const entry of entries) {
    if (entry.unsafeOriginalName !== undefined && entry.unsafeOriginalName !== entry.name) {
      fail('PATH_TRAVERSAL', 'GitHub archive contains an unsafe path');
    }
  }
}

interface ExtractionState {
  fileCount: number;
  totalBytes: number;
}

interface GithubArchiveEntry extends PluginContractEntry {
  readonly mode?: number;
}

async function toContractEntry(
  item: JSZip.JSZipObject,
  relativePath: string,
  state: ExtractionState,
): Promise<GithubArchiveEntry> {
  if (item.dir) return { path: relativePath, kind: 'directory' };
  const declaredSize = declaredUncompressedSize(item);
  accountForFile(state, relativePath, declaredSize);
  const content = await extractFile(item, relativePath);
  accountForInflatedDifference(state, content.length - declaredSize);
  return {
    path: relativePath,
    kind: 'file',
    content,
    declaredSize: content.length,
    mode: executableMode(item),
  };
}

function accountForFile(state: ExtractionState, relativePath: string, size: number): void {
  if (size > PLUGIN_PACKAGE_V1_LIMITS.maxFileBytes) {
    fail('FILE_TOO_LARGE', `${relativePath} exceeds the file limit`);
  }
  state.fileCount += 1;
  state.totalBytes += size;
  if (state.fileCount > PLUGIN_PACKAGE_V1_LIMITS.maxFiles) {
    fail('TOO_MANY_FILES', 'GitHub Plugin contains too many files');
  }
  assertTotalSize(state.totalBytes);
}

function accountForInflatedDifference(state: ExtractionState, size: number): void {
  state.totalBytes += size;
  assertTotalSize(state.totalBytes);
}

function assertTotalSize(size: number): void {
  if (size > PLUGIN_PACKAGE_V1_LIMITS.maxTotalBytes) {
    fail('TOTAL_SIZE_LIMIT', 'GitHub Plugin exceeds 64 MiB');
  }
}

async function extractFile(item: JSZip.JSZipObject, relativePath: string): Promise<Buffer> {
  try {
    return await item.async('nodebuffer');
  } catch {
    fail('GITHUB_ARCHIVE_INVALID', `${relativePath} could not be extracted`);
  }
}

function declaredUncompressedSize(entry: JSZip.JSZipObject): number {
  const value = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: unknown } })._data
    ?.uncompressedSize;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function findArchivePrefix(names: readonly string[]): string {
  const first = names.find(Boolean);
  const segment = first?.split('/')[0];
  if (!segment || names.some((name) => name && name.split('/')[0] !== segment)) {
    fail('GITHUB_ARCHIVE_INVALID', 'GitHub archive has an unexpected root');
  }
  return `${segment}/`;
}

function isSymlink(entry: JSZip.JSZipObject): boolean {
  const permissions = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0;
  return (permissions & 0o170000) === 0o120000;
}

function executableMode(entry: JSZip.JSZipObject): number {
  const permissions = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0;
  return (permissions & 0o111) === 0 ? 0o644 : 0o755;
}

function fail(code: string, message: string): never {
  throw new PluginSystemError(code, message);
}
