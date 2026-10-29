import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';

import { MCodeNotFoundError } from './errors.js';
import { findProjectBin, resolveCmdLauncher, resolveVersionedLauncher } from './project-bin.js';

export { parseCmdShim, parseShellShim, resolveVersionedLauncher } from './project-bin.js';

export const CLI_PACKAGE_NAME = '@minimax-ai/code';

/** How to start the CLI. The SDK never starts it through a shell. */
export interface ResolvedCli {
  readonly kind: 'node' | 'exec';
  /** JS entry run with `process.execPath` (`node`), or a native executable (`exec`). */
  readonly path: string;
  /**
   * Versioned Windows root launcher behind `path`. Its current release is resolved again for
   * every spawn, so a CLI self-update between Turns is picked up.
   */
  readonly launcher?: string;
  readonly source: 'option' | 'package' | 'project' | 'path';
}

export interface SpawnCommand {
  readonly command: string;
  readonly args: string[];
}

export interface ResolveCliOptions {
  readonly bin?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Also search `cwd` (default `process.cwd()`) for `@minimax-ai/code` and for
   * `node_modules/.bin/mcode` above that directory. Off unless set: a working directory can
   * belong to an untrusted checkout.
   */
  readonly resolveFromCwd?: boolean;
  /** Directory used by {@link ResolveCliOptions.resolveFromCwd}. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Base paths for resolving the optional `@minimax-ai/code` peer dependency. */
  readonly packageSearchFrom?: readonly string[];
  /**
   * Directory where the upward `node_modules/.bin/mcode` search starts. Set this to search even
   * when `resolveFromCwd` is off (tests and callers that already chose a directory).
   */
  readonly projectSearchFrom?: string;
  readonly platform?: NodeJS.Platform;
}

/**
 * Resolution order: explicit `bin` → `@minimax-ai/code` installed next to the SDK →
 * (only when `resolveFromCwd` is set) the same package from `cwd` and the nearest
 * `node_modules/.bin/mcode` above `cwd` → `mcode` on PATH.
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
  const fromPackage = resolvePackageEntry(packageSearchBases(options));
  if (fromPackage) return { kind: 'node', path: fromPackage, source: 'package' };
  const projectStart = projectSearchStart(options);
  if (projectStart !== undefined) {
    const fromProject = findProjectBin(projectStart, platform);
    if (fromProject) return fromProject;
  }
  const onPath = findOnPath('mcode', options.env, platform);
  if (onPath) return fromExecutable(onPath, 'path', platform);
  const searchedCwd = options.resolveFromCwd === true || options.projectSearchFrom !== undefined;
  throw new MCodeNotFoundError(
    searchedCwd
      ? `Could not find the mcode CLI (${CLI_PACKAGE_NAME} is not installed, no node_modules/.bin/mcode was found above the working directory, and mcode is not on PATH).`
      : `Could not find the mcode CLI (${CLI_PACKAGE_NAME} is not installed next to the SDK, and mcode is not on PATH). Set \`resolveFromCwd\` to also search the working directory, or pass \`bin\`.`,
  );
}

function packageSearchBases(options: ResolveCliOptions): readonly string[] {
  if (options.packageSearchFrom) return options.packageSearchFrom;
  const bases = [import.meta.url];
  if (options.resolveFromCwd) bases.push(join(options.cwd ?? process.cwd(), 'package.json'));
  return bases;
}

function projectSearchStart(options: ResolveCliOptions): string | undefined {
  if (options.projectSearchFrom !== undefined) return options.projectSearchFrom;
  if (options.resolveFromCwd) return options.cwd ?? process.cwd();
  return undefined;
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
    const resolved = resolveCmdLauncher(readFileSync(path, 'utf8'), path, source);
    if (resolved) return resolved;
    // Running a batch file would need cmd.exe and shell quoting; ask for the JS entry instead.
    throw new MCodeNotFoundError(
      `Found ${path}, but could not determine the JS entry it runs. Pass the CLI's JS entry as \`bin\`.`,
      { installHint: false },
    );
  }
  return { kind: 'exec', path, source };
}

export function buildSpawnCommand(cli: ResolvedCli, args: readonly string[]): SpawnCommand {
  if (cli.kind === 'exec') return { command: cli.path, args: [...args] };
  return { command: process.execPath, args: [currentEntry(cli), ...args] };
}

/** The JS entry to run now; versioned launchers are followed again on every call. */
function currentEntry(cli: ResolvedCli): string {
  if (!cli.launcher) return cli.path;
  let entry: string | undefined;
  try {
    entry = resolveVersionedLauncher(readFileSync(cli.launcher, 'utf8'), cli.launcher);
  } catch {
    entry = undefined;
  }
  if (!entry) {
    throw new MCodeNotFoundError(
      `${cli.launcher} no longer points to a usable release. Pass the CLI's JS entry as \`bin\`.`,
      { installHint: false },
    );
  }
  return entry;
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
