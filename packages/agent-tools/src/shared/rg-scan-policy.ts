/**
 * Default project-scan noise policy for desktop/local rg tools.
 *
 * These are not security boundaries: callers can explicitly target a noise
 * directory as the search root. Sensitive paths remain owned by
 * `rg-sensitive.ts` and are always appended after these patterns.
 */

import { realpath } from './physical-fs.js';
import { isAbsolute, relative, resolve } from 'node:path';

import { braceExpand, makeRe, Minimatch } from 'minimatch';

export const DEFAULT_SCAN_DIRECTORY_NAMES = [
  '.worktrees',
  'node_modules',
  '.pnpm-store',
  '.venv',
  'venv',
  'build_env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.gradle',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
] as const;

export const DEFAULT_SCAN_DIRECTORY_EXCLUDES = DEFAULT_SCAN_DIRECTORY_NAMES.map(
  (name) => `!**/${name}/**`,
);

const DEFAULT_SCAN_DIRECTORY_NAME_BY_LOWER = new Map<string, string>(
  DEFAULT_SCAN_DIRECTORY_NAMES.map((name) => [name.toLowerCase(), name]),
);

export function isDefaultScanNoisePath(value: string): boolean {
  return value
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .some((segment) => DEFAULT_SCAN_DIRECTORY_NAME_BY_LOWER.has(segment.toLowerCase()));
}

/**
 * Broad project inventories omit non-text artifacts. An explicit PNG (or
 * other extension) glob does not apply this list, so media remains
 * discoverable when the task actually targets it.
 */
export const DEFAULT_BROAD_FILE_EXCLUDES = [
  '!*.{png,jpg,jpeg,gif,webp,bmp,ico,tif,tiff,heic,avif,svgz}',
  '!*.{mp3,wav,flac,aac,ogg,m4a,mp4,mov,avi,mkv,webm}',
  '!*.{zip,tar,gz,tgz,bz2,xz,7z,rar}',
  '!*.{exe,dll,so,dylib,a,o,class,jar,wasm,pyc,pyo,ttf,otf,woff,woff2,eot}',
  '!*.{sqlite,sqlite3,db,safetensors,ckpt,onnx,pt,pth,bin,pdf}',
] as const;

/** Compiled once; inventories check every path against these. */
const DEFAULT_BROAD_FILE_EXCLUDE_MATCHERS = DEFAULT_BROAD_FILE_EXCLUDES.map(
  (exclude) => new Minimatch(exclude.slice(1), { dot: true, nocase: true }),
);

export function isDefaultBroadFileExcluded(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  const leaf = normalized.slice(normalized.lastIndexOf('/') + 1);
  return DEFAULT_BROAD_FILE_EXCLUDE_MATCHERS.some((matcher) => matcher.match(leaf));
}

function assertValidGlobPattern(pattern: string): void {
  const normalized = pattern.replaceAll('\\', '/');
  let braceDepth = 0;
  let characterClass: string | undefined;
  for (const char of normalized) {
    if (characterClass !== undefined) {
      if (char !== ']') {
        characterClass += char;
        continue;
      }
      if (characterClass.length === 0 || characterClass === '!' || characterClass === '^') {
        throw new Error(`invalid glob pattern: ${pattern}`);
      }
      const jsCharacterClass = characterClass.startsWith('!')
        ? `^${characterClass.slice(1)}`
        : characterClass;
      try {
        RegExp(`[${jsCharacterClass}]`);
      } catch {
        throw new Error(`invalid glob pattern: ${pattern}`);
      }
      characterClass = undefined;
      continue;
    }
    if (char === '[') {
      characterClass = '';
    } else if (char === '{') {
      braceDepth += 1;
    } else if (char === '}') {
      if (braceDepth === 0) throw new Error(`invalid glob pattern: ${pattern}`);
      braceDepth -= 1;
    }
  }
  if (characterClass !== undefined || braceDepth !== 0) {
    throw new Error(`invalid glob pattern: ${pattern}`);
  }
}

export function isBroadFileScan(pattern: string): boolean {
  assertValidGlobPattern(pattern);
  const normalized = pattern.replaceAll('\\', '/');
  if (normalized.startsWith('!')) return true;
  return braceExpand(normalized).some((expandedPattern) => {
    const leaf = expandedPattern.slice(expandedPattern.lastIndexOf('/') + 1);
    if (!leaf.includes('*') && !leaf.includes('?') && !leaf.includes('[')) return false;
    const lastDot = leaf.lastIndexOf('.');
    if (lastDot < 0) return true;
    const extensionSelector = leaf.slice(lastDot + 1);
    return extensionSelector.length === 0 || /^[*?]+$/.test(extensionSelector);
  });
}

type CanonicalizePath = (path: string) => Promise<string>;

export async function isNarrowSearchRoot(
  searchRoot: string,
  defaultRoot: string,
  canonicalize: CanonicalizePath = realpath,
): Promise<boolean> {
  const canonicalOrResolved = async (path: string) => {
    const resolved = resolve(path);
    try {
      return await canonicalize(resolved);
    } catch {
      return resolved;
    }
  };
  const [searchCanonical, defaultCanonical] = await Promise.all([
    canonicalOrResolved(searchRoot),
    canonicalOrResolved(defaultRoot),
  ]);
  return resolve(searchCanonical) !== resolve(defaultCanonical);
}

/**
 * Returns the default-noise directory segments explicitly traversed by a
 * derived search root. A `dist` prefix may opt into `dist` while keeping a
 * nested `node_modules` exclusion active.
 */
export function defaultScanNoiseDirectoriesInSearchRoot(
  searchRoot: string,
  defaultRoot: string,
): string[] {
  const rel = relative(resolve(defaultRoot), resolve(searchRoot));
  if (rel === '' || isAbsolute(rel)) return [];
  const segments = rel.split(/[\\/]+/);
  if (segments[0] === '..') return [];
  const matched = new Set<string>();
  for (const segment of segments) {
    const directoryName = DEFAULT_SCAN_DIRECTORY_NAME_BY_LOWER.get(segment.toLowerCase());
    if (directoryName) matched.add(directoryName);
  }
  return [...matched];
}

export function findGlobMagicIndex(pattern: string): number {
  const normalized = pattern.replaceAll('\\', '/');
  if (normalized.startsWith('!')) return 0;
  const standardMagic = normalized.search(/[*?[{]/);
  const extglobMagic = normalized.search(/[!+@]\(/);
  if (standardMagic < 0) return extglobMagic;
  if (extglobMagic < 0) return standardMagic;
  return Math.min(standardMagic, extglobMagic);
}

export function resolveGlobStaticSearchRoot(pattern: string, searchRoot: string): string {
  const normalized = pattern.replaceAll('\\', '/');
  const magicIndex = findGlobMagicIndex(normalized);
  const staticPart = magicIndex < 0 ? normalized : normalized.slice(0, magicIndex);
  const slash = staticPart.lastIndexOf('/');
  if (slash < 0) return resolve(searchRoot);
  const prefix = staticPart.slice(0, slash);
  if (prefix.length === 0) return resolve(searchRoot);
  const candidate = resolve(searchRoot, prefix);
  const rel = relative(resolve(searchRoot), candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) return resolve(searchRoot);
  return candidate;
}

export function defaultScanExcludeArgs(
  options: {
    broadFileScan?: boolean;
    includeDirectoryNoise?: boolean;
    allowedDirectoryNoise?: readonly string[];
  } = {},
): string[] {
  const allowedDirectoryNoise = new Set(
    (options.allowedDirectoryNoise ?? []).map((name) => name.toLowerCase()),
  );
  const args = options.includeDirectoryNoise
    ? []
    : DEFAULT_SCAN_DIRECTORY_NAMES.filter(
        (name) => !allowedDirectoryNoise.has(name.toLowerCase()),
      ).map((name) => `--iglob=!**/${name}/**`);
  if (options.broadFileScan) {
    args.push(...DEFAULT_BROAD_FILE_EXCLUDES.map((pattern) => `--iglob=${pattern}`));
  }
  return args;
}

export function filterGlobPaths(paths: readonly string[], pattern: string): string[] {
  const regex = globToPathRegex(pattern);
  return paths.filter((path) => regex.test(path.replaceAll('\\', '/')));
}

export function globToPathRegex(pattern: string): RegExp {
  assertValidGlobPattern(pattern);
  const normalized = pattern.replaceAll('\\', '/');
  const matchPattern = normalized.includes('/') ? normalized : `**/${normalized}`;
  const regex = makeRe(matchPattern, { dot: true });
  if (!regex) throw new Error(`invalid glob pattern: ${pattern}`);
  return regex;
}
