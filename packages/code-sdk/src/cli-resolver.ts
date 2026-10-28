import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';

import { MCodeNotFoundError } from './errors.js';
import { findProjectBin, parseCmdShim } from './project-bin.js';

export { parseCmdShim, parseShellShim } from './project-bin.js';

export const CLI_PACKAGE_NAME = '@minimax-ai/code';

/** How to start the CLI. The SDK never starts it through a shell. */
export interface ResolvedCli {
  readonly kind: 'node' | 'exec';
  /** JS entry run with `process.execPath` (`node`), or a native executable (`exec`). */
  readonly path: string;
  readonly source: 'option' | 'package' | 'project' | 'path';
}

export interface SpawnCommand {
  readonly command: string;
  readonly args: string[];
}

export interface ResolveCliOptions {
  readonly bin?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Base paths for resolving the optional `@minimax-ai/code` peer dependency. */
  readonly packageSearchFrom?: readonly string[];
  /** Directory where the upward `node_modules/.bin/mcode` search starts. */
  readonly projectSearchFrom?: string;
  readonly platform?: NodeJS.Platform;
}

/**
 * Resolution order: explicit `bin` → installed `@minimax-ai/code` package → nearest
 * `node_modules/.bin/mcode` above the working directory → `mcode` on PATH.
 */
export function resolveCli(options: ResolveCliOptions): ResolvedCli {
  const platform = options.platform ?? process.platform;
  if (options.bin !== undefined) {
    const looksLikePath = isAbsolute(options.bin) || /[\\/]/u.test(options.bin);
    const found = looksLikePath
      ? existsSync(options.bin)
        ? resolve(options.bin)
        : undefined
      : findOnPath(options.bin, options.env, platform);
    if (!found)
      throw new MCodeNotFoundError(`The configured mcode bin was not found: ${options.bin}.`);
    return fromExecutable(found, 'option', platform);
  }
  const fromPackage = resolvePackageEntry(
    options.packageSearchFrom ?? [import.meta.url, join(process.cwd(), 'package.json')],
  );
  if (fromPackage) return { kind: 'node', path: fromPackage, source: 'package' };
  const fromProject = findProjectBin(options.projectSearchFrom ?? process.cwd(), platform);
  if (fromProject) return fromProject;
  const onPath = findOnPath('mcode', options.env, platform);
  if (onPath) return fromExecutable(onPath, 'path', platform);
  throw new MCodeNotFoundError(
    `Could not find the mcode CLI (${CLI_PACKAGE_NAME} is not installed, no node_modules/.bin/mcode was found above the working directory, and mcode is not on PATH).`,
  );
}

/** Resolves `bin.mcode` of an installed `@minimax-ai/code` package to an existing JS file. */
export function resolvePackageEntry(searchFrom: readonly string[]): string | undefined {
  for (const base of searchFrom) {
    let manifestPath: string;
    try {
      manifestPath = createRequire(base).resolve(`${CLI_PACKAGE_NAME}/package.json`);
    } catch {
      continue;
    }
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        bin?: string | Record<string, string>;
      };
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.mcode;
      if (!bin) continue;
      const entry = resolve(dirname(manifestPath), bin);
      if (isFile(entry)) return entry;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const pathValue = readEnv(env, 'PATH', platform) ?? '';
  const separator = platform === 'win32' ? ';' : delimiter;
  const extensions =
    platform === 'win32'
      ? extname(name)
        ? ['']
        : (readEnv(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const directory of pathValue.split(separator)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory.replace(/^"(.*)"$/u, '$1'), name + extension);
      if (isFile(candidate) && (platform === 'win32' || isExecutable(candidate))) return candidate;
    }
  }
  return undefined;
}

function fromExecutable(
  path: string,
  source: ResolvedCli['source'],
  platform: NodeJS.Platform,
): ResolvedCli {
  const extension = extname(path).toLowerCase();
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return { kind: 'node', path, source };
  }
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    const entry = parseCmdShim(readFileSync(path, 'utf8'), path);
    if (entry) return { kind: 'node', path: entry, source };
    // Running a batch file would need cmd.exe and shell quoting; ask for the JS entry instead.
    throw new MCodeNotFoundError(
      `Cannot find the JS entry behind ${path}; pass the CLI's JS entry (or mcode.exe) as \`bin\`.`,
    );
  }
  return { kind: 'exec', path, source };
}

export function buildSpawnCommand(cli: ResolvedCli, args: readonly string[]): SpawnCommand {
  return cli.kind === 'node'
    ? { command: process.execPath, args: [cli.path, ...args] }
    : { command: cli.path, args: [...args] };
}

function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env[key];
  const match = Object.keys(env).find((name) => name.toUpperCase() === key.toUpperCase());
  return match === undefined ? undefined : env[match];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
