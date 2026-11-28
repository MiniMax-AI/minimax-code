import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { getRuntimeRegion } from '@mavis/config';
import JSZip from 'jszip';

/**
 * Chrome for Testing is the default Browser for the TUI provider. It is a
 * dedicated, versioned Chrome build with its own bundle identity, so the
 * provider never drives the user's everyday Chrome installation.
 */
export type ChromeForTestingPlatform = 'linux64' | 'mac-arm64' | 'mac-x64' | 'win32' | 'win64';

export interface ChromeForTestingArchive {
  /** Exact archive size in bytes. */
  readonly bytes: number;
  /** Base64 MD5 published by the Chrome for Testing bucket (`x-goog-hash`). */
  readonly md5: string;
}

export interface ChromeForTestingRelease {
  readonly version: string;
  readonly archives: Readonly<Partial<Record<ChromeForTestingPlatform, ChromeForTestingArchive>>>;
}

/** Pinned Stable build; digests are the bucket metadata of each `chrome-<platform>.zip`. */
const CHROME_FOR_TESTING_RELEASE: ChromeForTestingRelease = {
  version: '156.0.8078.80',
  archives: {
    linux64: { bytes: 201_329_937, md5: 'ahWLp+AdoBbxmIuuBkPZ5Q==' },
    'mac-arm64': { bytes: 195_027_080, md5: 'O4kTNDLhGGYKefWdMUHMCQ==' },
    'mac-x64': { bytes: 205_782_188, md5: 'nmm/hkpsN8AHPQFqBZh/MQ==' },
    win32: { bytes: 188_578_294, md5: 'aFo7ReTmGiVy/v+oERHj6w==' },
    win64: { bytes: 208_152_768, md5: '15XTLfpFBuZ/btqLi5xU2A==' },
  },
};

const GOOGLE_SOURCE = 'https://storage.googleapis.com/chrome-for-testing-public';
const NPMMIRROR_SOURCE = 'https://cdn.npmmirror.com/binaries/chrome-for-testing';
const DEFAULT_STALL_TIMEOUT_MS = 30_000;
const INSTALLED_MARKER = '.mcode-installed';
const STAGING_PREFIX = '.staging-';
// A live install touches its staging directory every STAGING_HEARTBEAT_MS;
// one untouched for STALE_STAGING_MS belongs to an install that died.
const STAGING_HEARTBEAT_MS = 5 * 60 * 1000;
const STALE_STAGING_MS = 60 * 60 * 1000;
const SYMLINK_FILE_TYPE = 0o120000;
const FILE_TYPE_MASK = 0o170000;

export interface EnsureChromeForTestingOptions {
  /** Root that holds one directory per Chrome for Testing version. */
  readonly cacheDir: string;
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly region?: 'cn' | 'en';
  readonly fetch?: typeof fetch;
  readonly release?: ChromeForTestingRelease;
  readonly stallTimeoutMs?: number;
}

/** Map the host to a Chrome for Testing build; undefined when none is published. */
export function resolveChromeForTestingPlatform(
  runtimePlatform: NodeJS.Platform = platform(),
  runtimeArch: string = arch(),
): ChromeForTestingPlatform | undefined {
  if (runtimePlatform === 'darwin') {
    if (runtimeArch === 'arm64') return 'mac-arm64';
    return runtimeArch === 'x64' ? 'mac-x64' : undefined;
  }
  if (runtimePlatform === 'linux') return runtimeArch === 'x64' ? 'linux64' : undefined;
  if (runtimePlatform === 'win32') {
    if (runtimeArch === 'ia32') return 'win32';
    // Windows on Arm runs the x64 build through emulation.
    return runtimeArch === 'x64' || runtimeArch === 'arm64' ? 'win64' : undefined;
  }
  return undefined;
}

export function resolveChromeForTestingExecutable(
  installDir: string,
  target: ChromeForTestingPlatform,
): string {
  const root = join(installDir, `chrome-${target}`);
  if (target === 'mac-arm64' || target === 'mac-x64') {
    return join(
      root,
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    );
  }
  return target === 'linux64' ? join(root, 'chrome') : join(root, 'chrome.exe');
}

/** Mirrors serve byte-identical archives; the regional mirror goes first. */
export function resolveChromeForTestingUrls(
  version: string,
  target: ChromeForTestingPlatform,
  region: 'cn' | 'en',
): readonly string[] {
  const sources =
    region === 'cn' ? [NPMMIRROR_SOURCE, GOOGLE_SOURCE] : [GOOGLE_SOURCE, NPMMIRROR_SOURCE];
  return sources.map((source) => `${source}/${version}/${target}/chrome-${target}.zip`);
}

const installs = new Map<string, Promise<string>>();

/**
 * Return the pinned Chrome for Testing executable, downloading it on first
 * use. Concurrent callers share one install; a caller's abort only stops its
 * own wait, so a cancelled tool call does not discard a nearly finished
 * download that the next call would need.
 */
export async function ensureChromeForTesting(
  options: EnsureChromeForTestingOptions,
): Promise<string> {
  if (options.signal?.aborted) throw new Error('ABORTED: Chrome startup was cancelled');
  const release = options.release ?? CHROME_FOR_TESTING_RELEASE;
  const target = resolveChromeForTestingPlatform(options.platform, options.arch);
  const archive = target ? release.archives[target] : undefined;
  if (!target || !archive) {
    throw new Error(
      `CHROME_FOR_TESTING_UNSUPPORTED: no Chrome for Testing build for ${options.platform ?? platform()}-${options.arch ?? arch()}`,
    );
  }
  const installDir = join(options.cacheDir, release.version, target);
  const executable = resolveChromeForTestingExecutable(installDir, target);
  if (await isInstalled(installDir, executable)) {
    // An interrupted earlier download leaves its staging directory behind; sweep
    // it in the background so startup does not wait on cache cleanup. Older
    // versions stay: an older MCode sharing this cache may still run them.
    void removeOutdatedEntries(options.cacheDir, release.version, false).catch(() => undefined);
    return executable;
  }

  let pending = installs.get(installDir);
  if (!pending) {
    pending = install({
      cacheDir: options.cacheDir,
      installDir,
      executable,
      version: release.version,
      archive,
      urls: resolveChromeForTestingUrls(
        release.version,
        target,
        options.region ?? getRuntimeRegion(),
      ),
      fetchImpl: options.fetch ?? fetch,
      stallTimeoutMs: options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    }).finally(() => installs.delete(installDir));
    installs.set(installDir, pending);
  }
  return waitWithSignal(pending, options.signal);
}

interface InstallPlan {
  readonly cacheDir: string;
  readonly installDir: string;
  readonly executable: string;
  readonly version: string;
  readonly archive: ChromeForTestingArchive;
  readonly urls: readonly string[];
  readonly fetchImpl: typeof fetch;
  readonly stallTimeoutMs: number;
}

async function install(plan: InstallPlan): Promise<string> {
  await mkdir(plan.cacheDir, { recursive: true });
  const staging = join(plan.cacheDir, `${STAGING_PREFIX}${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  // Writing chrome.zip or nested extracted files does not change the staging
  // directory's own mtime, so touch it while this install is alive; a sibling
  // process sweeps only staging directories whose heartbeat stopped.
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(staging, now, now).catch(() => undefined);
  }, STAGING_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const archivePath = join(staging, 'chrome.zip');
    const failures: string[] = [];
    let downloaded = false;
    for (const url of plan.urls) {
      try {
        await downloadArchive(url, archivePath, plan.archive, plan.fetchImpl, plan.stallTimeoutMs);
        downloaded = true;
        break;
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!downloaded) {
      throw new Error(`CHROME_FOR_TESTING_DOWNLOAD_FAILED: ${failures.join('; ')}`);
    }
    const extracted = join(staging, 'install');
    await extractArchive(archivePath, extracted);
    const stagedExecutable = join(extracted, plan.executable.slice(plan.installDir.length + 1));
    await chmod(stagedExecutable, 0o755).catch(() => undefined);
    if (!(await isChromeExecutableCandidate(stagedExecutable))) {
      throw new Error('CHROME_FOR_TESTING_INVALID_ARCHIVE: archive has no Chrome executable');
    }
    await writeFile(join(extracted, INSTALLED_MARKER), `${plan.version}\n`);
    await mkdir(dirname(plan.installDir), { recursive: true });
    try {
      await rename(extracted, plan.installDir);
    } catch (error) {
      // Another process finished the same version first; keep its copy.
      if (!(await isInstalled(plan.installDir, plan.executable))) throw error;
    }
    await removeOutdatedEntries(plan.cacheDir, plan.version);
    return plan.executable;
  } finally {
    clearInterval(heartbeat);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function downloadArchive(
  url: string,
  destination: string,
  archive: ChromeForTestingArchive,
  fetchImpl: typeof fetch,
  stallTimeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const armStallTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error(`no data for ${stallTimeoutMs}ms`)),
      stallTimeoutMs,
    );
    timer.unref?.();
  };
  armStallTimer();
  const file = await open(destination, 'w');
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const hash = createHash('md5');
    let bytes = 0;
    armStallTimer();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      armStallTimer();
      bytes += chunk.byteLength;
      if (bytes > archive.bytes) throw new Error(`archive exceeds ${archive.bytes} bytes`);
      hash.update(chunk);
      await file.write(chunk);
    }
    if (bytes !== archive.bytes) {
      throw new Error(`archive is ${bytes} bytes, expected ${archive.bytes}`);
    }
    const md5 = hash.digest('base64');
    if (md5 !== archive.md5) throw new Error(`archive md5 ${md5} does not match ${archive.md5}`);
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await file.close();
  }
}

/** Unpack with the archive's Unix modes and symlinks; macOS app bundles depend on both. */
async function extractArchive(archivePath: string, destination: string): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(archivePath));
  const root = resolve(destination);
  await mkdir(root, { recursive: true });
  for (const entry of Object.values(zip.files)) {
    const target = resolve(root, entry.name);
    if (!isInside(root, target)) throw new Error(`unsafe archive entry ${entry.name}`);
    if (entry.dir) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : undefined;
    if (mode !== undefined && (mode & FILE_TYPE_MASK) === SYMLINK_FILE_TYPE) {
      const linkTarget = await entry.async('string');
      if (isAbsolute(linkTarget) || !isInside(root, resolve(dirname(target), linkTarget))) {
        throw new Error(`unsafe archive symlink ${entry.name}`);
      }
      await symlink(linkTarget, target);
      continue;
    }
    const permissions = mode === undefined ? 0o644 : mode & 0o777;
    await pipeline(
      entry.nodeStream('nodebuffer'),
      createWriteStream(target, { mode: permissions }),
    );
    if (permissions & 0o111) await chmod(target, permissions);
  }
}

/**
 * Removes stale staging directories and, with `olderVersions`, versions older
 * than `currentVersion`. A newer version belongs to a newer MCode process
 * sharing this cache, so it stays; deleting it would make the two processes
 * download in turn. Older ones are removed only right after an install.
 */
async function removeOutdatedEntries(
  cacheDir: string,
  currentVersion: string,
  olderVersions = true,
): Promise<void> {
  const entries = await readdir(cacheDir).catch(() => [] as string[]);
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(cacheDir, entry);
      if (entry.startsWith(STAGING_PREFIX)) {
        // A live sibling install keeps its staging directory's mtime fresh.
        const modified = await stat(path).then(
          (stats) => stats.mtimeMs,
          () => Date.now(),
        );
        if (Date.now() - modified < STALE_STAGING_MS) return;
      } else if (!olderVersions || !isOlderVersion(entry, currentVersion)) {
        return;
      }
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }),
  );
}

/** Dotted numeric versions compared part by part; anything else is never older. */
function isOlderVersion(entry: string, current: string): boolean {
  if (!/^\d+(?:\.\d+)*$/u.test(entry)) return false;
  const a = entry.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

async function isInstalled(installDir: string, executable: string): Promise<boolean> {
  try {
    await access(join(installDir, INSTALLED_MARKER), constants.F_OK);
  } catch {
    return false;
  }
  return isChromeExecutableCandidate(executable);
}

/** Probe a Chrome executable without reading it into memory. */
export async function isChromeExecutableCandidate(
  candidate: string,
  runtimePlatform: NodeJS.Platform = platform(),
): Promise<boolean> {
  try {
    await access(candidate, runtimePlatform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function waitWithSignal<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => reject(new Error('ABORTED: Chrome startup was cancelled'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
