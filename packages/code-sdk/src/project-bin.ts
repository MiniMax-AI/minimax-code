import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

import type { ResolvedCli } from './cli-resolver.js';

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
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
    const entry =
      extension === '.cmd' ? parseCmdShim(head, launcher) : parseShellShim(head, launcher);
    // Shims are only used through their JS entry; the SDK never starts a shell.
    return entry ? { kind: 'node', path: entry, source: 'project' } : undefined;
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
