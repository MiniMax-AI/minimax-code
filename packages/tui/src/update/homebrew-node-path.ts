import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

// Homebrew installs every Node formula into a versioned keg
// (<prefix>/Cellar/<formula>/<version>/...) that `brew upgrade` deletes, while the
// formula-managed <prefix>/opt/<formula> symlink always tracks the installed keg.
// The prefix differs per platform and user (/opt/homebrew, /usr/local,
// /home/linuxbrew/.linuxbrew, ~/.linuxbrew, custom prefixes), so it is derived
// from the Cellar segment instead of being listed.
const HOMEBREW_NODE_KEG_PATH =
  /^(?<prefix>\/.+?)\/Cellar\/(?<formula>node(?:@\d+(?:\.\d+)*)?)\/[^/]+\/(?<tail>.+)$/u;
const HOMEBREW_NODE_OPT_PATH = /^\/.+?\/opt\/node(?:@\d+(?:\.\d+)*)?\/.+$/u;

/**
 * Maps a Node toolchain path (node, npm, ...) to the stable Homebrew
 * `opt/<formula>` path when it lives in, or resolves into, a versioned Cellar
 * keg. Every path that outlives the current process (release launchers and the
 * install receipt) must go through this so that `brew upgrade` cannot strand it.
 *
 * - A live path is replaced only when the opt path resolves to the same file.
 * - A recorded keg path that `brew upgrade` already removed heals to the same
 *   formula's opt path, which is the keg's successor.
 * - Everything else (version managers, managed runtimes, Windows) is unchanged.
 */
export function stableHomebrewNodeToolchainPath(file: string): string {
  // Already the formula-managed path; keep how the caller spelled its prefix.
  if (HOMEBREW_NODE_OPT_PATH.test(file)) return file;
  const target = resolveFile(file);
  if (target === undefined) {
    const candidate = homebrewOptPath(file);
    return candidate && isExecutableFile(candidate) ? candidate : file;
  }
  // Resolve the directory first so npm keeps its command name instead of
  // turning into npm-cli.js; fully resolve only when the command name survives.
  const resolvedDirectory = resolveDirectory(file);
  const sources = [file, resolvedDirectory];
  if (path.basename(target) === path.basename(file)) sources.push(target);
  for (const source of sources) {
    const candidate = source === undefined ? undefined : homebrewOptPath(source, file);
    if (!candidate) continue;
    if (resolveFile(candidate) === target) return candidate;
  }
  return file;
}

/** The running Node, mapped to its stable Homebrew path when applicable. */
export function stableProcessNodeExecutable(): string {
  return stableHomebrewNodeToolchainPath(process.execPath);
}

function homebrewOptPath(source: string, original = source): string | undefined {
  const groups = HOMEBREW_NODE_KEG_PATH.exec(source)?.groups;
  if (!groups?.prefix || !groups.formula || !groups.tail) return undefined;
  const prefix = lexicalAncestor(original, groups.prefix) ?? groups.prefix;
  return `${prefix}/opt/${groups.formula}/${groups.tail}`;
}

// Prefer the caller's spelling of the Homebrew prefix when it reaches the
// resolved prefix through a symlinked ancestor (/var -> /private/var on macOS,
// /home -> /var/home on image-based Linux).
function lexicalAncestor(file: string, resolvedPrefix: string): string | undefined {
  for (let current = path.dirname(file); ; current = path.dirname(current)) {
    if (current === resolvedPrefix || resolveDirectoryPath(current) === resolvedPrefix) {
      return current;
    }
    if (path.dirname(current) === current) return undefined;
  }
}

function resolveDirectoryPath(directory: string): string | undefined {
  try {
    return realpathSync(directory);
  } catch {
    return undefined;
  }
}

function resolveFile(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

function resolveDirectory(file: string): string | undefined {
  try {
    return path.join(realpathSync(path.dirname(file)), path.basename(file));
  } catch {
    return undefined;
  }
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
