import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

import type { ResolvedCli } from './cli-resolver.js';

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
/** Lines of the Windows root launcher written by the official installer and CLI self-update. */
const VERSIONED_POINTER_LINE = 'SET /P MCODE_RELEASE=<"%~dp0current"';
const VERSIONED_CALL_LINE = 'CALL "%~dp0releases\\%MCODE_RELEASE%\\.mcode-launcher.cmd"';
/** Same release-key rule the root launcher enforces before following the pointer. */
const RELEASE_KEY = /^[0-9A-Za-z][0-9A-Za-z._-]*$/u;
const SHIM_HEAD_BYTES = 4096;

/**
 * Finds a project-local `mcode` launcher by walking up from `startDir` and checking each
 * `node_modules/.bin`. Any CLI package that provides the `mcode` bin is accepted, so projects
 * can pin whichever MCode distribution they install.
 */
export function findProjectBin(
  startDir: string,
  platform: NodeJS.Platform = process.platform,
): ResolvedCli | undefined {
  const names = platform === 'win32' ? ['mcode.cmd', 'mcode.ps1'] : ['mcode'];
  let directory = resolve(startDir);
  for (;;) {
    for (const name of names) {
      const candidate = join(directory, 'node_modules', '.bin', name);
      if (!isFile(candidate)) continue;
      const resolved = resolveLauncher(candidate, platform);
      if (resolved) return resolved;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Prefers the JS entry behind a launcher so it runs with `process.execPath`. */
function resolveLauncher(launcher: string, platform: NodeJS.Platform): ResolvedCli | undefined {
  const extension = extname(launcher).toLowerCase();
  if (platform === 'win32') {
    const head = readHead(launcher);
    if (extension !== '.cmd') {
      const entry = parseShellShim(head, launcher);
      return entry ? { kind: 'node', path: entry, source: 'project' } : undefined;
    }
    // Shims are only used through their JS entry; the SDK never starts a shell.
    return resolveCmdLauncher(head, launcher, 'project');
  }
  // npm links `.bin/mcode` to the package's JS entry; pnpm writes a shell shim.
  const real = realpathSync(launcher);
  if (JS_EXTENSIONS.has(extname(real).toLowerCase())) {
    return { kind: 'node', path: real, source: 'project' };
  }
  const head = readHead(real);
  if (/^#!.*\bnode\b/u.test(head.split('\n', 1)[0] ?? '')) {
    return { kind: 'node', path: real, source: 'project' };
  }
  const entry = parseShellShim(head, launcher);
  return { kind: entry ? 'node' : 'exec', path: entry ?? launcher, source: 'project' };
}

/**
 * Resolves a Windows `.cmd` launcher to the JS entry it runs: an npm / pnpm shim, or the
 * versioned root launcher of the official installer. A versioned result keeps the root
 * launcher so the current release is looked up again before every spawn.
 */
export function resolveCmdLauncher(
  content: string,
  launcherPath: string,
  source: ResolvedCli['source'],
): ResolvedCli | undefined {
  const shimEntry = parseCmdShim(content, launcherPath);
  if (shimEntry) return { kind: 'node', path: shimEntry, source };
  const versionedEntry = resolveVersionedLauncher(content, launcherPath);
  return versionedEntry
    ? { kind: 'node', path: versionedEntry, source, launcher: launcherPath }
    : undefined;
}

/**
 * Follows the installer's versioned layout: `<prefix>\mcode.cmd` reads the release key from
 * `<prefix>\current` and calls `<prefix>\releases\<release>\.mcode-launcher.cmd`, which runs the
 * CLI's JS entry. Returns that JS entry, or `undefined` when the layout does not match.
 */
export function resolveVersionedLauncher(
  content: string,
  launcherPath: string,
): string | undefined {
  if (!content.includes(VERSIONED_POINTER_LINE) || !content.includes(VERSIONED_CALL_LINE)) {
    return undefined;
  }
  const prefix = dirname(launcherPath);
  try {
    const release = readFileSync(join(prefix, 'current'), 'utf8').trim();
    if (!RELEASE_KEY.test(release)) return undefined;
    const releaseLauncher = join(prefix, 'releases', release, '.mcode-launcher.cmd');
    return parseCmdShim(readFileSync(releaseLauncher, 'utf8'), releaseLauncher);
  } catch {
    return undefined;
  }
}

/**
 * Extracts the JS entry from an npm / pnpm generated `.cmd` shim, so the CLI runs with
 * `process.execPath` instead of through cmd.exe.
 */
export function parseCmdShim(content: string, shimPath: string): string | undefined {
  const match = /"%~?dp0%?\\?([^"%]+\.(?:c|m)?js)"/iu.exec(content);
  if (!match?.[1]) return undefined;
  const entry = join(dirname(shimPath), ...match[1].split(/[\\/]/u).filter(Boolean));
  return isFile(entry) ? entry : undefined;
}

/**
 * Extracts the JS entry from a pnpm / npm generated POSIX shell or PowerShell shim, which
 * reference it as `"$basedir/<relative path>.js"`.
 */
export function parseShellShim(content: string, shimPath: string): string | undefined {
  const match = /"\$basedir[\\/]([^"$]+\.(?:c|m)?js)"/u.exec(content);
  if (!match?.[1]) return undefined;
  const entry = join(dirname(shimPath), ...match[1].split(/[\\/]/u).filter(Boolean));
  return isFile(entry) ? entry : undefined;
}

function readHead(path: string): string {
  const buffer = Buffer.alloc(SHIM_HEAD_BYTES);
  const fd = openSync(path, 'r');
  try {
    const bytes = readSync(fd, buffer, 0, SHIM_HEAD_BYTES, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
