/**
 * File system tool permission implementation.
 *
 * Handles path validation, dangerous file/directory detection,
 * working directory boundary checks, and sandbox allow-list logic.
 *
 * Reference: permission_design.md §5.2
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger, backgroundCtx } from '../host-utils.js';
import type {
  DecisionReason,
  PathCheckContext,
  PermissionRule,
  PermissionRuleAction,
} from '../types.js';
import {
  isSameResolvedPath,
  namesDirectoryEntry,
  reachesRootInOtherCase,
  resolveCanonicalPath,
  resolveEntryLocation,
  resolveOperationIdentities,
  resolvePhysicalEntry,
  resolvePhysicalPath,
  unfoldedAbsolutePath,
} from './path-identity.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Files that require explicit user approval to modify (§5.2). Names are
 * lowercase and compared case-insensitively.
 */
export const DANGEROUS_FILES: ReadonlySet<string> = new Set([
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  // SSH private keys (excludes .pub public keys)
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  // Cloud service credentials
  'credentials', // ~/.aws/credentials
  // Other credential files
  '.netrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  // Sensitive database history
  '.mysql_history',
  '.psql_history',
  // Shell history (may contain passwords/tokens)
  '.bash_history',
  '.zsh_history',
  // Docker credentials
  '.dockercfg',
]);

/**
 * Directories where writes trigger a safety check (§5.2). Lowercase, compared
 * case-insensitively.
 */
export const DANGEROUS_DIRECTORIES: ReadonlyArray<string> = [
  '.git',
  '.vscode',
  '.idea',
  // Credential directories
  '.ssh',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.gnupg',
];

/**
 * Tools that only read the file system and do not modify it.
 *
 * Used by both {@link isPathAllowed} (to skip dangerous-path safety checks
 * for in-workdir reads) and {@link FsToolPermissionChecker} (to gate which
 * safety checks may be overridden by bypass mode).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['read', 'glob', 'grep', 'list']);

/**
 * Umbrella tool name that applies to every filesystem tool (read, write,
 * edit, glob, grep, list). Used by {@link isPathAllowed} so a single
 * `fs allow <glob>` rule unlocks all fs operations against the path —
 * eliminating the need to maintain parallel `edit` / `write` / `read`
 * rules for the same folder.
 *
 * NOT a real tool — no checker is registered under this name. It only
 * exists as a shorthand inside the rule store.
 */
export const FS_UMBRELLA_TOOL_NAME = 'fs';

/** Shell-expansion syntax patterns that must be rejected */
const SHELL_EXPANSION_PATTERNS: ReadonlyArray<RegExp> = [
  /\$\(/, // command substitution $(...)
  /`[^`]*`/, // backtick command substitution
  /\$\{/, // variable expansion ${...}
  /\$[A-Za-z_]/, // variable reference $VAR
];

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

/**
 * Validate a path string for security issues.
 *
 * Checks:
 * 1. Tilde expansion (only `~` and `~/...`, not `~user`)
 * 2. UNC path blocking (Windows-style `\\server\share`)
 * 2a. Mapped-drive masquerade blocking (Windows-only): a drive letter whose
 *     root resolves to a UNC share via `GetFinalPathNameByHandleW` is also
 *     refused, so `net use Z: \\srv\share` cannot smuggle network reads past
 *     the built-in fs tools.
 * 3. Shell expansion syntax blocking (`$()`, backticks, `${}`)
 * 4. Normalization: `..` components are resolved against the working
 *    directory, so `a/b/../c` is judged exactly like `a/c`; the permission
 *    check then judges the real location the path reaches (see
 *    `resolvePathIdentities`). A `..` that the platform's path semantics
 *    cannot resolve (a backslash-separated `..` on POSIX, where `\` is an
 *    ordinary filename character) is still rejected.
 *
 * @returns The resolved absolute path, or an error object.
 */
export function validatePath(
  inputPath: string,
  workingDirectory?: string,
  homeDir?: string,
): { valid: true; resolved: string } | { valid: false; error: string } {
  if (!inputPath || inputPath.trim().length === 0) {
    return { valid: false, error: 'Empty path' };
  }

  let normalized = inputPath.trim();

  if (normalized.includes('\0')) {
    return { valid: false, error: 'Null byte in path is not allowed' };
  }

  // 1. Tilde expansion
  if (normalized.startsWith('~')) {
    if (normalized === '~' || normalized.startsWith('~/')) {
      if (!homeDir) {
        return { valid: false, error: 'Home directory is required for tilde expansion' };
      }
      normalized = path.join(homeDir, normalized.slice(1));
    } else {
      // ~user syntax is blocked for security
      return {
        valid: false,
        error: 'Tilde-user expansion (~user) is not allowed for security reasons',
      };
    }
  }

  // 2. UNC path blocking
  if (containsVulnerableUncPath(normalized)) {
    return { valid: false, error: 'UNC paths are not allowed' };
  }

  // 2a. Mapped-drive masquerade blocking. On Windows, the SMB redirector
  // resolves a mapped drive root (`net use Z: \\srv\share`) back to its
  // canonical `\\srv\share` form via `GetFinalPathNameByHandleW`. Network
  // shares are outside the built-in filesystem tools' local-only boundary.
  if (process.platform === 'win32' && resolvesToNetworkDrive(normalized)) {
    return { valid: false, error: 'UNC paths are not allowed' };
  }

  // 3. Shell expansion syntax blocking
  for (const pattern of SHELL_EXPANSION_PATTERNS) {
    if (pattern.test(normalized)) {
      return { valid: false, error: `Shell expansion syntax is not allowed: ${pattern.source}` };
    }
  }

  // 4. Normalize, then judge the normalized path. Every later rule (deny
  // rules, sensitive paths, workspace boundary) sees only `resolved`, so a
  // path with `..` gets exactly the verdict of the same path written without it.
  const resolved = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(workingDirectory ?? process.cwd(), normalized);

  if (containsPathTraversal(resolved)) {
    return { valid: false, error: 'Path traversal (..) detected' };
  }

  return { valid: true, resolved };
}

/**
 * Check if a path contains vulnerable UNC patterns.
 * Blocks `\\server\share` and `//server/share` style paths.
 */
export function containsVulnerableUncPath(inputPath: string): boolean {
  // Windows UNC: \\server\share
  if (/^\\\\[^\\]/.test(inputPath)) return true;
  // Unix-style UNC-like: //server/share
  if (/^\/\/[^/]/.test(inputPath)) return true;
  return false;
}

/**
 * Windows-only: does the drive letter at the front of `inputPath` resolve to a
 * UNC share? The SMB redirector lets a user run `net use Z: \\srv\share` and
 * then access `Z:\foo.txt`, which the syntactic UNC check above can't catch.
 *
 * Resolves the drive ROOT (`Z:\`) through `fs.realpathSync.native`, which
 * calls `GetFinalPathNameByHandleW` under the hood. A UNC result (`\\srv\…`
 * or the long-path variant `\\?\UNC\srv\…`) means the drive is a mapped
 * network share — and built-in fs tools must refuse it.
 *
 * Returns `false` on:
 *   - inputs without a `[A-Za-z]:` drive letter (POSIX paths, literal UNC,
 *     relative paths)
 *   - drive letters that don't currently exist (the realpath call throws)
 *   - drives that resolve to a local path (`C:\Users\Public`, etc.)
 *
 * Off-Windows callers should not reach this function — validatePath gates the
 * call on `process.platform === 'win32'`.
 */
export function resolvesToNetworkDrive(inputPath: string): boolean {
  const match = /^([A-Za-z]):/.exec(inputPath);
  if (!match) return false;
  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync.native(`${match[1]}:\\`);
  } catch {
    return false;
  }
  return resolvedRoot.startsWith('\\\\') || resolvedRoot.startsWith('//');
}

/**
 * Check if a path contains traversal components (`..`), with either separator.
 *
 * On an already-resolved path, a remaining `..` is one the platform's path
 * semantics did not normalize and is treated as invalid.
 */
export function containsPathTraversal(inputPath: string): boolean {
  return inputPath.split(/[\\/]/).some((seg) => seg === '..');
}

/**
 * Validate a glob pattern for dangerous constructs.
 */
export function validateGlobPattern(pattern: string): { valid: boolean; error?: string } {
  if (pattern.includes('\0')) {
    return { valid: false, error: 'Null byte in glob pattern is not allowed' };
  }

  // Block shell expansion in globs
  for (const shellPattern of SHELL_EXPANSION_PATTERNS) {
    if (shellPattern.test(pattern)) {
      return { valid: false, error: `Shell expansion in glob pattern: ${shellPattern.source}` };
    }
  }

  // Block path traversal in globs
  if (containsPathTraversal(pattern)) {
    return { valid: false, error: 'Path traversal in glob pattern' };
  }

  // Block absolute glob patterns. The glob/grep tools accept workspace-relative
  // patterns; absolute globs like `/etc/**/*` are broad system scans and can
  // bypass the normal file-path boundary checks because the glob pattern itself
  // is the primary input.
  if (path.isAbsolute(pattern) || /^[A-Za-z]:[\\/]/.test(pattern)) {
    return { valid: false, error: 'Absolute glob patterns are not allowed' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Dangerous path detection
// ---------------------------------------------------------------------------

/**
 * Check whether a file path refers to a dangerous/protected file.
 */
export function isDangerousFile(filePath: string): boolean {
  return DANGEROUS_FILES.has(path.basename(filePath).toLowerCase());
}

/**
 * Check whether a path falls within a dangerous/protected directory.
 */
export function isInDangerousDirectory(filePath: string): boolean {
  return dangerousDirectoryOf(filePath) !== undefined;
}

function dangerousDirectoryOf(filePath: string): string | undefined {
  const segments = lowercaseSegments(path.resolve(filePath));
  return DANGEROUS_DIRECTORIES.find((directory) => containsSegments(segments, directory));
}

/** Case-folded because macOS and Windows reach `.git` through `.GIT`. */
function lowercaseSegments(filePath: string): readonly string[] {
  return filePath.toLowerCase().split(path.sep);
}

function containsSegments(segments: readonly string[], directory: string): boolean {
  const parts = directory.split('/');
  return segments.some((_, start) =>
    parts.every((part, offset) => segments[start + offset] === part),
  );
}

/**
 * Git metadata files that may contain credentials even when read-only.
 *
 * Covers:
 * - Top-level: `.git/config`, `.git/credentials`
 * - Submodule: `.git/modules/<name>/config`, `.git/modules/<name>/credentials`
 *   (including nested submodules: `.git/modules/<a>/modules/<b>/config`)
 *
 * Submodule git directories mirror the structure of the main `.git/` dir,
 * so `.git/modules/*` paths must be checked with the same vigilance.
 */
export function isSensitiveGitFile(filePath: string): boolean {
  const segments = lowercaseSegments(path.resolve(filePath));
  const gitIndex = segments.lastIndexOf('.git');
  if (gitIndex === -1) return false;

  const relativeParts = segments.slice(gitIndex + 1);
  if (relativeParts.length === 0) return false;

  const basename = relativeParts[relativeParts.length - 1];
  if (basename !== 'config' && basename !== 'credentials') return false;

  // Top-level: .git/<config|credentials>
  if (relativeParts.length === 1) return true;

  // Submodule git dirs live under .git/modules/, mirroring the main .git/ structure.
  // Matches .git/modules/<name>/<config|credentials> and nested submodules.
  return relativeParts[0] === 'modules';
}

// ---------------------------------------------------------------------------
// Credential file extension detection
// ---------------------------------------------------------------------------

/** File extensions that always indicate private key / keystore files */
const CREDENTIAL_EXTENSIONS: ReadonlySet<string> = new Set(['.p12', '.pfx', '.keystore', '.jks']);

/** Keywords in filename that distinguish private keys from public certs */
const PRIVATE_KEY_INDICATORS: ReadonlyArray<string> = ['private', 'priv', 'key'];

/** Keywords in `.key` filenames that distinguish real key material from labels such as translations.key. */
const KEY_EXTENSION_PRIVATE_INDICATORS: ReadonlyArray<string> = [
  'private',
  'priv',
  'secret',
  'credential',
  'creds',
  'server',
  'client',
  'identity',
  'ssh',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
];

/**
 * Check if a file is a credential/private-key file based on extension and name.
 *
 * - `.p12`, `.pfx`, `.keystore`, `.jks` → always flagged
 * - `.key` → only flagged when the filename looks like key material
 *   (`server.key`, `private.key`, `ssh.key`, etc.)
 * - `.pem` → only flagged when the filename contains `private`, `priv`, or `key`
 *   (avoids false positives on CA certificates)
 */
export function isCredentialFile(filePath: string): boolean {
  if (isPublicKeyFile(filePath)) return false;

  const basename = path.basename(filePath).toLowerCase();
  const ext = path.extname(basename);

  if (CREDENTIAL_EXTENSIONS.has(ext)) {
    return true;
  }

  // .key files: flag only when the filename indicates actual key material.
  // This avoids false positives on project files such as translations.key.
  if (ext === '.key') {
    const nameWithoutExt = basename.slice(0, -ext.length);
    return KEY_EXTENSION_PRIVATE_INDICATORS.some((kw) => nameWithoutExt.includes(kw));
  }

  // .pem files: only flag when filename indicates a private key
  if (ext === '.pem') {
    const nameWithoutExt = basename.slice(0, -ext.length);
    return PRIVATE_KEY_INDICATORS.some((kw) => nameWithoutExt.includes(kw));
  }

  return false;
}

/** Public key files are safe to read in bypass mode. */
export function isPublicKeyFile(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const segments = resolved.split(path.sep);
  const basename = path.basename(filePath).toLowerCase();
  return segments.includes('.ssh') && /^id_[a-z0-9_-]+\.pub$/i.test(basename);
}

// ---------------------------------------------------------------------------
// .env file detection
// ---------------------------------------------------------------------------

/** `.env.<suffix>` names that hold template values rather than secrets. */
export const TEMPLATE_SUFFIXES: readonly string[] = ['example', 'sample', 'template'];

/**
 * Check if a file is a `.env` variant (excluding `.env.example` templates).
 *
 * Matches: `.env`, `.env.local`, `.env.production`, `.env.development`, etc.
 * Excludes: `.env.example`, `.env.sample`, `.env.template`
 */
export function isEnvFile(filePath: string): boolean {
  const basename = path.basename(filePath);

  // Must start with .env
  if (!basename.startsWith('.env')) return false;
  // Exact `.env`
  if (basename === '.env') return true;
  // Must be `.env.<suffix>` pattern
  if (!basename.startsWith('.env.')) return false;

  // Exclude template/example files
  const suffix = basename.slice(5).toLowerCase(); // after '.env.'
  if (TEMPLATE_SUFFIXES.includes(suffix)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// System sensitive path detection
// ---------------------------------------------------------------------------

/**
 * Check if a resolved absolute path targets a system-level sensitive location.
 *
 * These paths are dangerous regardless of working directory context.
 */
export function isSystemSensitivePath(resolvedPath: string): boolean {
  const normalized = resolvedPath.toLowerCase();
  const { platform } = process;

  // macOS sensitive paths
  if (platform === 'darwin') {
    if (normalized.includes('/library/keychains/')) return true;
    if (normalized.endsWith('/library/keychains/system.keychain')) return true;
    if (normalized.startsWith('/var/db/dslocal/')) return true;
  }

  // Unix/Linux sensitive paths (also applies to macOS)
  if (platform !== 'win32') {
    const UNIX_SENSITIVE = ['/etc/shadow', '/etc/gshadow', '/etc/sudoers', '/etc/master.passwd'];
    if (UNIX_SENSITIVE.includes(normalized)) return true;
    // /etc/sudoers.d/ directory
    if (normalized.startsWith('/etc/sudoers.d/')) return true;
  }

  // Windows sensitive paths
  if (platform === 'win32') {
    // SAM, SECURITY, SYSTEM hives
    if (/windows[\\/]system32[\\/]config[\\/](sam|security|system)/i.test(resolvedPath)) {
      return true;
    }
    // NTDS.dit (Active Directory database)
    if (/windows[\\/]ntds[\\/]ntds\.dit/i.test(resolvedPath)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Dangerous removal detection
// ---------------------------------------------------------------------------

/**
 * Detect if a path is a dangerous removal target (§5.2).
 *
 * Blocks removal of:
 * - Root directory `/`
 * - User home directory `~` / `$HOME`
 * - System drive roots
 * - Direct children of root (`/usr`, `/etc`, `/var`, etc.)
 */
export function isDangerousRemovalPath(inputPath: string, homeDir?: string): boolean {
  const home = homeDir;
  let resolved: string;

  // Handle tilde
  let normalized = inputPath.trim();
  if (normalized === '~' || normalized === '~/') {
    return true;
  }
  if (normalized.startsWith('~/')) {
    if (!home) return false;
    normalized = path.join(home, normalized.slice(2));
  }

  try {
    resolved = path.resolve(normalized);
  } catch {
    return true; // Can't resolve → treat as dangerous
  }

  // Root directory
  if (resolved === '/' || resolved === path.parse(resolved).root) {
    return true;
  }

  // Home directory
  if (home && resolved === path.resolve(home)) {
    return true;
  }

  // Direct child of root (e.g., /usr, /etc, /var, /System, /Library)
  const parent = path.dirname(resolved);
  if (parent === '/' || parent === path.parse(parent).root) {
    return true;
  }

  // Windows system drives
  if (process.platform === 'win32') {
    const drivePattern = /^[A-Za-z]:[\\/]?$/;
    if (drivePattern.test(resolved)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Working directory boundary checks
// ---------------------------------------------------------------------------

/**
 * Path implementation for boundary checks. Defaults to the host's `node:path`;
 * tests pass `path.win32` / `path.posix` to check the other platform's rules.
 */
type BoundaryPathApi = Pick<
  path.PlatformPath,
  'relative' | 'isAbsolute' | 'sep' | 'resolve' | 'dirname' | 'join' | 'basename'
>;

/**
 * Check if a path is within the working directory.
 *
 * A drive root (`D:\`) or `/` workspace contains every path on that volume;
 * on Windows the match ignores letter case.
 */
export function pathInWorkingPath(
  filePath: string,
  workingDirectory: string,
  pathApi: BoundaryPathApi = path,
): boolean {
  return isPathWithin(filePath, workingDirectory, pathApi);
}

/**
 * The working directory and allowed working paths, matched in lexical form
 * first. A real form (`/tmp` on macOS) is resolved only for the working
 * directory and for a folder that one of the path's identities already reaches
 * as written, which shares its mount with the target: a path outside a folder
 * never waits on that folder's unresponsive mount.
 */
function rootMatcher(
  workingDirectory: string | undefined,
  allowed: readonly string[] | undefined,
  identities: readonly string[],
  options: { readonly writable?: boolean } = {},
) {
  const working = workingDirectory ? path.resolve(workingDirectory) : undefined;
  // A `/` or drive-root folder is the whole volume, which only widens reads:
  // for a write or a script run it authorises nothing.
  const lexical = [working, ...(allowed ?? []).map((root) => path.resolve(root))].filter(
    (root): root is string =>
      typeof root === 'string' &&
      root.length > 0 &&
      !(options.writable && isVolumeRoot(root, path)),
  );
  let real: string[] | undefined;
  const realForms = () => {
    real ??= lexical
      .filter((root) => root === working || identities.some((id) => insideAnyRootForm(id, [root])))
      .flatMap((root) => rootForms(root).filter((form) => !lexical.includes(form)));
    return real;
  };
  return {
    contains: (target: string) =>
      insideAnyRootForm(target, lexical) || insideAnyRootForm(target, realForms()),
  };
}

function workingRootMatcher(
  context: PathCheckContext,
  identities: readonly string[],
  options: { readonly writable?: boolean } = {},
) {
  return rootMatcher(context.workingDirectory, context.allowedWorkingPaths, identities, options);
}

/** A boundary root in lexical and real form (`/var` is `/private/var` on macOS). */
function rootForms(root: string): string[] {
  const lexical = path.resolve(root);
  const canonical = resolveCanonicalPath(lexical);
  return canonical && canonical !== lexical ? [lexical, canonical] : [lexical];
}

/** Whether every identity of one path lies inside some working root. */
function allInsideWorkingRoots(
  identities: readonly string[],
  context: PathCheckContext,
  options: { readonly writable?: boolean } = {},
): boolean {
  const roots = workingRootMatcher(context, identities, options);
  return identities.every((identity) => roots.contains(identity));
}

/**
 * Whether a path lies inside one of the roots, taking each root in lexical and
 * real form and in another letter case on a case-insensitive volume. Bash write
 * targets and script runs share this with the file tools, so a `/` or
 * drive-root folder does not authorise them.
 */
export function pathInAnyWorkingRoot(
  target: string,
  workingDirectory: string | undefined,
  allowedWorkingPaths?: readonly string[],
): boolean {
  return rootMatcher(workingDirectory, allowedWorkingPaths, [target], { writable: true }).contains(
    target,
  );
}

function insideAnyRootForm(target: string, forms: readonly string[]): boolean {
  return forms.some(
    (root) => pathInWorkingPath(target, root) || reachesRootInOtherCase(target, root),
  );
}

/**
 * Check if a path is within any of the allowed working paths.
 */
export function pathInAllowedWorkingPath(
  filePath: string,
  allowedPaths: readonly string[],
  pathApi: BoundaryPathApi = path,
): boolean {
  return allowedPaths.some((allowed) => isPathWithin(filePath, allowed, pathApi));
}

function isVolumeRoot(directory: string, pathApi: BoundaryPathApi): boolean {
  const resolved = pathApi.resolve(directory);
  return pathApi.dirname(resolved) === resolved;
}

/**
 * Boundary for writes and script execution: a `/` or drive-root workspace is
 * the whole volume, which only widens reads, so it authorises nothing here and
 * such a target keeps going through confirmation.
 */
export function pathInWritableWorkspace(
  filePath: string,
  workingDirectory: string,
  pathApi: BoundaryPathApi = path,
): boolean {
  return (
    !isVolumeRoot(workingDirectory, pathApi) && isPathWithin(filePath, workingDirectory, pathApi)
  );
}

/** {@link pathInWritableWorkspace} over a list of allowed paths. */
export function pathInWritableAllowedPaths(
  filePath: string,
  allowedPaths: readonly string[],
  pathApi: BoundaryPathApi = path,
): boolean {
  return allowedPaths.some((allowed) => pathInWritableWorkspace(filePath, allowed, pathApi));
}

// ---------------------------------------------------------------------------
// Well-known home subdirectories (read-only convenience allow)
// ---------------------------------------------------------------------------

/**
 * Folder names under `~/` that are universally non-sensitive consumer
 * directories — typical user content lives here, not credentials. Reads
 * are auto-allowed; writes still require user approval so we don't
 * silently produce files in the user's Downloads.
 *
 * Names match the conventional Unix-style names. Localized variants
 * (e.g. `下载/`, `Téléchargements`) are NOT covered intentionally —
 * agents querying localized paths should fall through to the standard
 * working-directory check and get a confirmation prompt.
 */
const WELL_KNOWN_HOME_READ_DIRS: ReadonlyArray<string> = ['Downloads', 'Desktop'];

const WELL_KNOWN_SYSTEM_READ_DIRS: ReadonlyArray<string> = [
  '/usr/share/doc',
  '/usr/local/share/doc',
];

/**
 * Return true if `resolvedPath` is inside one of the {@link WELL_KNOWN_HOME_READ_DIRS}
 * directly under `homeDir`. Matches `~/Downloads`, `~/Downloads/sub/a.txt`, etc.
 *
 * Sensitive-file checks (`.env` / credential / `.gitconfig` / etc.) run
 * BEFORE this helper is consulted inside {@link isPathAllowed}, so a
 * dangerous file under `~/Downloads` is still blocked.
 */
export function isWellKnownHomeReadAllowed(resolvedPath: string, homeDir: string): boolean {
  if (!homeDir) return false;
  const home = path.resolve(homeDir);
  for (const dir of WELL_KNOWN_HOME_READ_DIRS) {
    const wellKnown = path.join(home, dir);
    if (resolvedPath === wellKnown || resolvedPath.startsWith(wellKnown + path.sep)) {
      return true;
    }
  }
  return false;
}

function isWellKnownSystemReadAllowed(resolvedPath: string): boolean {
  if (process.platform === 'win32') return false;
  for (const dir of WELL_KNOWN_SYSTEM_READ_DIRS) {
    const wellKnown = path.resolve(dir);
    if (resolvedPath === wellKnown || resolvedPath.startsWith(wellKnown + path.sep)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Temp directory detection
// ---------------------------------------------------------------------------

/**
 * Platform facts the temp-directory check reads. Production uses the host's
 * values; tests inject Windows ones.
 */
type TempDirectoryEnv = {
  readonly platform: NodeJS.Platform;
  /** `os.tmpdir()`: macOS `/var/folders/.../T`, Linux `/tmp`, Windows `%TEMP%`. */
  readonly tmpdir: string;
  /** Throws when the path does not exist, like `fs.realpathSync.native`. */
  readonly realpath: (filePath: string) => string;
};

/** Temp roots of the host, computed on first use. */
let hostTempDirectoryRoots: readonly string[] | undefined;

function hostTempDirectoryEnv(): TempDirectoryEnv {
  return { platform: process.platform, tmpdir: os.tmpdir(), realpath: fs.realpathSync.native };
}

function boundaryPathApiFor(platform: NodeJS.Platform): BoundaryPathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * The temp directory as written plus its real form. On Windows `%TEMP%` is
 * often an 8.3 short path (`C:\Users\ADMINI~1\...`) while agents write the
 * long one; on macOS both `os.tmpdir()` and `/tmp` are symlinks into
 * `/private`, and a path check compares the real location of the target too.
 * POSIX keeps the hardcoded `/tmp` agents commonly use.
 */
function tempDirectoryRoots(env: TempDirectoryEnv): readonly string[] {
  const lexical = boundaryPathApiFor(env.platform).resolve(env.tmpdir);
  const roots = env.platform === 'win32' ? [lexical] : [lexical, '/tmp'];
  return [...new Set(roots.flatMap((root) => [root, ...realTempRoot(root, env)]))];
}

function realTempRoot(root: string, env: TempDirectoryEnv): string[] {
  try {
    const real = env.realpath(root);
    return real && real !== root ? [real] : [];
  } catch {
    return [];
  }
}

function insideTempRoot(
  target: string,
  roots: readonly string[],
  pathApi: BoundaryPathApi,
): boolean {
  return roots.some((root) => isPathWithin(target, root, pathApi));
}

/**
 * Check if a resolved path is within the system temp directory.
 *
 * Temp directories stay useful for low-friction reads. Writes are handled by
 * the selected workspace / allow-rule boundary in {@link isPathAllowed} and
 * the `allowTempWrite` fallback of `evaluatePathCapability`.
 * Sensitive checks (system-sensitive paths, .env files, credential files,
 * sensitive git metadata) run BEFORE temp read allowance, so dangerous files
 * in temp dirs (e.g. /tmp/.env, /tmp/id_rsa) are still caught.
 *
 * Covers, on macOS / Linux:
 *   - the per-user `os.tmpdir()` path (e.g. /var/folders/.../T/)
 *   - the canonical /tmp prefix (agents often hardcode /tmp/...)
 * Covers, on Windows:
 *   - `os.tmpdir()` (C:\Users\<user>\AppData\Local\Temp) in any letter case,
 *     written either as the 8.3 short path or the long path. There is no
 *     POSIX-style /tmp to fall back to.
 *
 * `env` is for tests; production reads the host platform and `os.tmpdir()`.
 */
export function isTempDirectory(resolvedPath: string, env?: TempDirectoryEnv): boolean {
  const roots = env
    ? tempDirectoryRoots(env)
    : (hostTempDirectoryRoots ??= tempDirectoryRoots(hostTempDirectoryEnv()));
  const { platform, realpath } = env ?? hostTempDirectoryEnv();
  const pathApi = boundaryPathApiFor(platform);
  if (insideTempRoot(resolvedPath, roots, pathApi)) return true;
  // A short-name target (`...\ADMINI~1\...`) matches only through its real
  // long form. Other paths skip the filesystem lookup.
  // The temp root is always local, so a UNC path never needs the (possibly
  // blocking) network lookup.
  if (platform !== 'win32' || !resolvedPath.includes('~') || /^[\\/]{2}/.test(resolvedPath)) {
    return false;
  }
  return insideTempRoot(resolveExistingPath(resolvedPath, realpath, pathApi), roots, pathApi);
}

// ---------------------------------------------------------------------------
// Internal whitelist paths
// ---------------------------------------------------------------------------

/** Resolve existing parents too, so a directory alias cannot hide a protected read. */
function resolveExistingPath(
  filePath: string,
  realpath: (filePath: string) => string = fs.realpathSync,
  pathApi: BoundaryPathApi = path,
): string {
  try {
    return realpath(filePath);
  } catch {
    const parent = pathApi.dirname(filePath);
    return parent === filePath
      ? filePath
      : pathApi.join(resolveExistingPath(parent, realpath, pathApi), pathApi.basename(filePath));
  }
}

/**
 * Runtime state is private; only designated agent assets get implicit read access.
 * Mini App agent workspaces live in the active agent's `agents/<agentName>/miniapps`.
 */
function isProtectedRuntimeRead(
  filePath: string,
  context: PathCheckContext,
  recursive: boolean,
  scope: RuntimeReadScope,
): boolean {
  const canonicalPath = resolveExistingPath(filePath);
  for (const { resolvedRoot, canonicalRoot } of scope.roots()) {
    if (recursive && isPathWithin(canonicalRoot, canonicalPath)) return true;
    if (!isPathWithin(filePath, resolvedRoot) && !isPathWithin(canonicalPath, canonicalRoot))
      continue;
    // Do not resolve the asset subdirectory itself: a skills/ symlink pointing
    // at credentials must not turn its destination into a trusted asset root.
    const readableAsset =
      isPathWithin(canonicalPath, path.join(canonicalRoot, 'skills')) ||
      isPathWithin(canonicalPath, path.join(canonicalRoot, '.builtin-skills')) ||
      // Saved run_code scripts are the Agent's own reusable code; without this it
      // could not list or read them, only run them.
      isPathWithin(canonicalPath, path.join(canonicalRoot, 'ptc')) ||
      (context.agentName != null &&
        (isPathWithin(
          canonicalPath,
          path.join(canonicalRoot, 'agents', context.agentName, 'workspace'),
        ) ||
          isPathWithin(
            canonicalPath,
            path.join(canonicalRoot, 'agents', context.agentName, 'skills'),
          ) ||
          isPathWithin(
            canonicalPath,
            path.join(canonicalRoot, 'agents', context.agentName, 'miniapps'),
          ))) ||
      matchesSessionOwnedReadableRoot(canonicalPath, scope) ||
      matchesTrustedExactWriteTarget(canonicalPath, scope) ||
      isInternalWhitelistedPath(canonicalPath, {
        ...context,
        dataDir: canonicalRoot,
      });
    if (!readableAsset) return true;
  }
  return false;
}

type ProtectedRuntimeRoot = { readonly resolvedRoot: string; readonly canonicalRoot: string };

/** The private runtime roots (`dataDir` and `~/.minimax`), lexical and canonical. */
function protectedRuntimeRoots(context: PathCheckContext): readonly ProtectedRuntimeRoot[] {
  const roots = [context.dataDir, path.join(context.homeDir ?? os.homedir(), '.minimax')];
  return roots.flatMap((root) => {
    if (!root) return [];
    const resolvedRoot = path.resolve(root);
    return [{ resolvedRoot, canonicalRoot: resolveExistingPath(resolvedRoot) }];
  });
}

/**
 * The private runtime roots and the host's read grants for one path check.
 * Grants are validated (one realpath each) at most once per check and only
 * when a path inside a private root needs them; paths elsewhere never pay.
 */
interface RuntimeReadScope {
  roots(): readonly ProtectedRuntimeRoot[];
  /** Canonical Session-owned roots that pass `trustedSessionOwnedRoot`. */
  ownedRoots(): readonly string[];
  /** Canonical trusted exact write targets that pass the same invariants. */
  exactTargets(): readonly string[];
}

/** Computes `compute()` on first use and returns the same value afterwards. */
function lazy<T>(compute: () => T): () => T {
  let computed = false;
  let value: T;
  return () => {
    if (!computed) {
      value = compute();
      computed = true;
    }
    return value;
  };
}

function createRuntimeReadScope(context: PathCheckContext): RuntimeReadScope {
  const roots = lazy(() => protectedRuntimeRoots(context));
  const trusted = (paths: readonly string[] | undefined) =>
    (paths ?? []).flatMap((root) => {
      const canonical = trustedSessionOwnedRoot(root, roots());
      return canonical === undefined ? [] : [canonical];
    });
  return {
    roots,
    ownedRoots: lazy(() => trusted(context.sessionOwnedReadablePaths)),
    exactTargets: lazy(() => trusted(context.trustedExactWritePaths)),
  };
}

/** Whether a path (lexically or canonically) lies inside a private runtime root. */
function isInsideRuntimeRoot(
  filePath: string,
  canonicalPath: string,
  scope: RuntimeReadScope,
): boolean {
  return scope
    .roots()
    .some(
      ({ resolvedRoot, canonicalRoot }) =>
        isPathWithin(filePath, resolvedRoot) || isPathWithin(canonicalPath, canonicalRoot),
    );
}

/**
 * The active Session's own files that the runtime hands the Agent (its
 * workspace, attachments, recoverable artifacts) live inside the private
 * runtime tree. The host injects the exact directories or files the Session
 * owns so that reading them stays possible.
 *
 * An injected root only counts when it is strictly inside a private runtime
 * root, reached without any symlink below that root. So the grant can never
 * cover the runtime root itself, anything outside it, or — through a
 * swapped-in symlink — another part of the tree such as `auth/`. The match
 * runs on canonical paths, so a symlink inside the owned directory that
 * points elsewhere does not become readable through it either.
 */
function matchesSessionOwnedReadableRoot(canonicalPath: string, scope: RuntimeReadScope): boolean {
  return scope.ownedRoots().some((root) => isPathWithin(canonicalPath, root));
}

/**
 * A turn-scoped exact write target (e.g. the Plan Mode document under the
 * Session's own artifacts) is issued by the trusted execution owner. Being
 * allowed to write that exact file implies reading it back; otherwise the
 * Agent is told to keep a file up to date that it cannot read.
 *
 * Exact file only, under the same root invariants as Session-owned roots: a
 * target reached through a symlink below the private runtime root is ignored,
 * so swapping the file for a link to `auth/` cannot unlock a read.
 */
function matchesTrustedExactWriteTarget(canonicalPath: string, scope: RuntimeReadScope): boolean {
  return scope.exactTargets().some((target) => isSameResolvedPath(canonicalPath, target));
}

/**
 * Canonical form of an injected Session-owned root, or `undefined` when the
 * root is not symlink-free and strictly inside a private runtime root. A root
 * may be a directory or an exact file (e.g. one attachment asset).
 */
function trustedSessionOwnedRoot(
  root: string,
  protectedRoots: readonly ProtectedRuntimeRoot[],
): string | undefined {
  if (!root) return undefined;
  const resolved = path.resolve(root);
  const canonical = resolveExistingPath(resolved);
  for (const { resolvedRoot, canonicalRoot } of protectedRoots) {
    for (const [lexicalBase, canonicalBase] of [
      [resolvedRoot, canonicalRoot],
      [canonicalRoot, canonicalRoot],
    ] as const) {
      const relative = path.relative(lexicalBase, resolved);
      if (relative === '' || !isPathWithin(resolved, lexicalBase)) continue;
      // Canonicalizing must not move the root: any symlink between the private
      // runtime root and the injected root would make these differ. Compare by
      // platform path identity: on Windows `path.relative` matches
      // case-insensitively but keeps the injected casing, so a plain `===`
      // silently dropped a grant whose drive or user-folder casing differed.
      if (isSameResolvedPath(canonical, path.join(canonicalBase, relative))) return canonical;
    }
  }
  return undefined;
}

/**
 * True when `target` is `root` itself or lives inside it. Separator-aware
 * (`/a/bc` is not inside `/a/b`), correct for a drive root or `/`, and on
 * Windows case-insensitive because `path.win32.relative` is.
 */
function isPathWithin(target: string, root: string, pathApi: BoundaryPathApi = path): boolean {
  const relative = pathApi.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative))
  );
}

/**
 * Check if a path is in the internal whitelist (always writable by the system).
 *
 * Whitelisted:
 * - `${dataDir}/permission.json`
 * - MEMORY.md / memory/ directory
 * - plans/ directory
 * - automem paths
 * - agent memory paths
 */
export function isInternalWhitelistedPath(filePath: string, context: PathCheckContext): boolean {
  const resolved = path.resolve(filePath);
  const { dataDir } = context;

  if (!dataDir) return false;

  const normalizedDataDir = path.resolve(dataDir);

  // permission.json in data dir
  if (resolved === path.join(normalizedDataDir, 'permission.json')) {
    return true;
  }

  // MEMORY.md at any level within data dir. Separator-aware: a sibling
  // profile such as `~/.minimax-dev/.../MEMORY.md` is not inside `~/.minimax`.
  if (path.basename(resolved) === 'MEMORY.md' && isPathWithin(resolved, normalizedDataDir)) {
    return true;
  }

  // memory/ directory within data dir
  const memoryDir = path.join(normalizedDataDir, 'memory');
  if (resolved.startsWith(memoryDir + path.sep) || resolved === memoryDir) {
    return true;
  }

  // plans/ directory within data dir
  const plansDir = path.join(normalizedDataDir, 'plans');
  if (resolved.startsWith(plansDir + path.sep) || resolved === plansDir) {
    return true;
  }

  // Agent-specific paths
  if (context.agentName) {
    const agentDir = path.join(normalizedDataDir, 'agents', context.agentName);
    const agentMemory = path.join(agentDir, 'memory');

    // agent memory directory
    if (resolved.startsWith(agentMemory + path.sep) || resolved === agentMemory) {
      return true;
    }

    // agent MEMORY.md
    if (resolved === path.join(agentDir, 'MEMORY.md')) {
      return true;
    }

    // agent permission.json
    if (resolved === path.join(agentDir, 'permission.json')) {
      return true;
    }
  }

  return false;
}

/** The internal whitelist, also under the real data directory when it is a symlink. */
function isInternalWhitelistedLocation(filePath: string, context: PathCheckContext): boolean {
  if (isInternalWhitelistedPath(filePath, context)) return true;
  if (!context.dataDir) return false;
  const realDataDir = resolveCanonicalPath(path.resolve(context.dataDir));
  return (
    realDataDir !== undefined &&
    realDataDir !== path.resolve(context.dataDir) &&
    isInternalWhitelistedPath(filePath, { ...context, dataDir: realDataDir })
  );
}

// ---------------------------------------------------------------------------
// Rule matching for file paths
// ---------------------------------------------------------------------------

/**
 * Match a file path against a rule's ruleContent pattern.
 *
 * Supports:
 * - Exact path match: `/path/to/file`
 * - Directory glob: `/path/**` (matches everything under /path)
 * - Single-level glob: `/path/*` (matches direct children of /path)
 */
export function matchPathRule(filePath: string, ruleContent: string): boolean {
  const resolved = path.resolve(filePath);

  // Directory glob: /path/**
  if (ruleContent.endsWith('/**')) {
    const dir = path.resolve(ruleContent.slice(0, -3));
    return resolved.startsWith(dir + path.sep) || resolved === dir;
  }

  // Single-level glob: /path/*
  if (ruleContent.endsWith('/*') && !ruleContent.endsWith('**')) {
    const dir = path.resolve(ruleContent.slice(0, -2));
    const parent = path.dirname(resolved);
    return parent === dir;
  }

  // Exact match
  return resolved === path.resolve(ruleContent);
}

// ---------------------------------------------------------------------------
// Main permission check
// ---------------------------------------------------------------------------

export type PathPermissionResult = {
  allowed: boolean;
  reason: DecisionReason;
};

/** The first deny rule that a bare tool deny or any target matches. */
function matchDenyRule(
  toolRules: readonly PermissionRule[],
  targets: readonly string[],
): PermissionRule | undefined {
  return toolRules.find((rule) => {
    if (rule.ruleBehavior !== 'deny') return false;
    const ruleContent = rule.ruleValue.ruleContent;
    // A bare tool deny denies all operations for this tool.
    return !ruleContent || targets.some((target) => matchPathRule(target, ruleContent));
  });
}

/**
 * Checks that are never skipped, whatever the boundary: system secrets,
 * credential / private-key files, `.env` files (excluding `.env.example`
 * etc.) and sensitive git metadata. `.git/config` can carry an HTTPS bearer
 * token (`[remote] url = https://USER:PAT@host/...`), so even a read inside
 * the working directory asks.
 */
function criticalSafetyReason(
  target: string,
): Extract<DecisionReason, { type: 'safetyCheck' }> | undefined {
  // Critical: never skipped — system sensitive paths.
  if (isSystemSensitivePath(target)) {
    return {
      type: 'safetyCheck',
      description: `System secret access requires LLM review and explicit approval if the LLM cannot allow it. Path: ${target}`,
      category: 'systemSensitivePath',
      classifierApprovable: true,
    };
  }

  // Critical: never skipped — credential / private-key files.
  if (isCredentialFile(target)) {
    return {
      type: 'safetyCheck',
      description: `Credential or private-key access requires LLM review and explicit approval if the LLM cannot allow it. Path: ${target}`,
      category: 'credentialFile',
      classifierApprovable: true,
    };
  }

  // Critical: never skipped — .env files (excluding .env.example etc.).
  if (isEnvFile(target)) {
    return {
      type: 'safetyCheck',
      description: `Environment file may contain secrets. Path: ${target}`,
      category: 'envFile',
      classifierApprovable: true,
    };
  }

  // Critical: never skipped — sensitive git metadata (.git/config,
  // .git/credentials, .git/modules/<x>/credentials etc.). The
  // skipDangerousCheck would have auto-allowed reads of `.git/config`
  // inside the workdir — but that file can contain HTTPS bearer tokens
  // (e.g. a `[remote] url = https://USER:PAT@host/...` written by
  // `git config credential.helper`).
  if (isInDangerousDirectory(target) && isSensitiveGitFile(target)) {
    return {
      type: 'safetyCheck',
      description: `Sensitive git metadata may contain credentials or remotes with tokens. Path: ${target}`,
      category:
        path.basename(target).toLowerCase() === 'credentials'
          ? 'credentialFile'
          : 'gitSensitiveFile',
      classifierApprovable: true,
    };
  }
  return undefined;
}

/**
 * Check if a file path operation is allowed.
 *
 * Step 1: Deny rule matching
 * Step 2: Internal path whitelist
 * Step 3: Safety check (DANGEROUS_FILES + DANGEROUS_DIRECTORIES, write-only)
 * Step 3.4: Host-injected Session-owned readable paths (read-only)
 * Step 3.5: Temp directory read auto-allow
 * Step 3.6: Well-known home subdirectory reads auto-allow
 * Step 4: Working directory boundary check
 * Step 5: Sandbox allow list
 * Step 6: Allow rule matching
 *
 * @param filePath - The target file path
 * @param rules - Permission rules filtered for the relevant tool (edit/write/read)
 * @param context - Path check context with working directory and allowed paths
 * @param toolName - The tool name (edit, write, read, etc.)
 */
export function isPathAllowed(
  filePath: string,
  rules: PermissionRule[],
  context: PathCheckContext,
  toolName: string = 'edit',
  action?: PermissionRuleAction,
): PathPermissionResult {
  // Validate the path first
  const validation = validatePath(filePath, context.workingDirectory, context.homeDir);
  if (!validation.valid) {
    logger.warn(
      backgroundCtx(),
      `Path validation failed, filePath=${filePath}, error=${validation.error}`,
    );
    return {
      allowed: false,
      reason: { type: 'pathValidation', error: validation.error },
    };
  }

  const { resolved } = validation;

  // Filter rules for this tool, plus the `fs` umbrella that applies to all
  // filesystem tools (read / write / edit / glob / grep / list).
  //
  // Background: tool-namespaced rules (`edit:<glob>`, `write:<glob>`, ...)
  // are intentionally separate so a user can grant read-only access without
  // also granting writes. But the common case in practice is "I trust this
  // folder for everything" — granting `write` to a folder still left `edit`
  // and subsequent reads asking. The `fs` umbrella lets the user (or the
  // ASK-card "always allow for all fs tools" choice) emit ONE rule that
  // applies to every fs tool, instead of three parallel rules.
  //
  // Order is irrelevant: deny / allow short-circuit on first match. Including
  // umbrella rules in BOTH the deny and allow scans keeps the semantics
  // symmetric — a `fs deny <glob>` blocks every fs tool, a `fs allow <glob>`
  // unlocks every fs tool.
  const toolRules = rules.filter(
    (r) =>
      (r.ruleValue.toolName === toolName || r.ruleValue.toolName === FS_UMBRELLA_TOOL_NAME) &&
      ruleSupportsPathAction(r, action),
  );

  // Step 1: Deny rule matching, on the path as written before touching the
  // disk, then on every other location the operation reaches.
  const lexicalDeny = matchDenyRule(toolRules, [resolved]);
  if (lexicalDeny) return { allowed: false, reason: { type: 'rule', rule: lexicalDeny } };

  // Every location this operation can reach: the lexical path, the hops of a
  // symlink on its final component and its real path. The file tools have no
  // OS sandbox behind them, so a boundary holds only when every identity is
  // inside it, and a deny rule or protected name on any identity applies.
  // Deleting or moving a symlink acts on the link itself, not on its target.
  const unfolded = unfoldedAbsolutePath(filePath, context.workingDirectory, context.homeDir);
  const entryOnly = action === 'delete' && namesDirectoryEntry(filePath);
  const identities = resolveOperationIdentities(filePath, resolved, unfolded, action);

  const deny = identities && matchDenyRule(toolRules, identities);
  if (deny) return { allowed: false, reason: { type: 'rule', rule: deny } };

  if (!identities) {
    return {
      allowed: false,
      reason: {
        type: 'safetyCheck',
        description: `Path could not be resolved to its real location. Path: ${resolved}`,
        category: 'unresolvablePath',
        classifierApprovable: false,
      },
    };
  }

  // Runtime state can contain credentials and session data. Check before ALL
  // implicit allowances, including workspace/temp and internal aliases. A grep
  // of the data root must be reviewed just like a direct config.yaml read.
  //
  // Paths the runtime itself hands the Agent (the Session's workspace,
  // attachments, recoverable artifacts) are not private: the host injects them
  // as `sessionOwnedReadablePaths`, see `isProtectedRuntimeRead`. The category
  // names what this is — private runtime data — so logs and telemetry do not
  // mistake a missing runtime grant for a credential-file access.
  // Every location counts: a shell walking `link/..` from a link to
  // `~/.minimax/memory` lands at `~/.minimax/config.yaml`.
  const runtimeReadScope = createRuntimeReadScope(context);
  if (
    READ_ONLY_TOOLS.has(toolName) &&
    identities.some((identity) =>
      isProtectedRuntimeRead(identity, context, toolName === 'grep', runtimeReadScope),
    )
  ) {
    return {
      allowed: false,
      reason: {
        type: 'safetyCheck',
        description: `Private runtime data access requires approval. Path: ${resolved}`,
        category: 'privateRuntimeData',
        classifierApprovable: false,
      },
    };
  }

  // Step 2: Internal path whitelist. Every location must be whitelisted: a
  // shell walking `memory/link/..` lands beside the link's target.
  if (identities.every((identity) => isInternalWhitelistedLocation(identity, context))) {
    return {
      allowed: true,
      reason: { type: 'internalWhitelist', path: resolved },
    };
  }

  // Step 3: Safety check (sensitive / dangerous files / directories).
  //
  // Ordering:
  //   - "Critical" sensitive checks (system-sensitive paths, credential
  //     files, .env files, sensitive git metadata) ALWAYS run, even for
  //     read-only tools inside the working directory. Reading a project's
  //     own `.env` or `.git/credentials` is a real exfiltration risk we
  //     refuse to silently auto-allow.
  //   - "General" dangerous file/directory checks (.bashrc, .gitconfig,
  //     non-credential .ssh files like known_hosts, .git/HEAD …) keep the
  //     in-workdir read skip — they are user-owned config that auto-allow
  //     in the project root is acceptable for.
  //   - .env.example / .env.sample / .env.template and SSH public keys
  //     remain safe positive controls (excluded by isEnvFile / handled by
  //     isPublicKeyFile callers).
  //   - A `/` or drive-root workspace widens reads to the whole volume, but
  //     never waives this check, so `~/.netrc` there still asks.
  const isReadOnlyTool = READ_ONLY_TOOLS.has(toolName);
  // A `/` or drive-root workspace only widens reads: it neither waives the
  // dangerous-file check nor authorises a write.
  const isInWorkDir = allInsideWorkingRoots(identities, context, { writable: true });
  const skipDangerousCheck = isReadOnlyTool && isInWorkDir;
  // A shell walking `link/..` lands beside the link's target, which the folded
  // `resolved` path hides.
  const physical =
    unfolded === undefined
      ? undefined
      : entryOnly
        ? resolvePhysicalEntry(unfolded)
        : resolvePhysicalPath(unfolded);
  const location = entryOnly ? resolveEntryLocation(resolved) : resolveCanonicalPath(resolved);
  const landing = physical !== undefined && physical !== location ? physical : undefined;
  // A read through a project symlink to elsewhere (`npm link`, a shared folder)
  // stays allowed as before; it still gets every safety check above and below,
  // which run on all locations it reaches. Where a shell lands must be inside too.
  const readRoots = workingRootMatcher(context, landing ? [resolved, landing] : [resolved]);
  const readsInsideAsWritten =
    isReadOnlyTool &&
    readRoots.contains(resolved) &&
    (landing === undefined || readRoots.contains(landing));

  // Critical: never skipped — system secrets, credential / private-key files,
  // .env files and sensitive git metadata (see `criticalSafetyReason`).
  for (const identity of identities) {
    const criticalReason = criticalSafetyReason(identity);
    if (criticalReason) return { allowed: false, reason: criticalReason };
  }

  const dangerousFile = skipDangerousCheck ? undefined : identities.find(isDangerousFile);
  if (dangerousFile) {
    return {
      allowed: false,
      reason: {
        type: 'safetyCheck',
        description: `Protected user or tool configuration file. Path: ${dangerousFile}`,
        category: 'protectedFile',
        classifierApprovable: true,
      },
    };
  }

  for (const identity of skipDangerousCheck ? [] : identities) {
    const protectedDirectory = dangerousDirectoryOf(identity);
    if (!protectedDirectory) continue;
    return {
      allowed: false,
      reason: {
        type: 'safetyCheck',
        description: `Protected configuration or credential directory (${protectedDirectory}). Path: ${identity}`,
        category: protectedDirectory === '.git' ? 'gitDirectory' : 'protectedDirectory',
        classifierApprovable: true,
      },
    };
  }

  if (
    (toolName === 'write' || toolName === 'edit') &&
    context.trustedExactWritePaths?.some((trustedPath) => isSameResolvedPath(trustedPath, resolved))
  ) {
    return {
      allowed: true,
      reason: { type: 'trustedExactWrite', path: resolved },
    };
  }

  // Step 3.4: Session-owned readable paths.
  //
  // The runtime externalizes oversized tool results into the active Session's
  // own artifact directory and hands the Agent that path, so the Agent must be
  // able to read the artifact back. Those artifacts live under the private
  // runtime tree, which the private-runtime check refuses to read; the runtime
  // injects the exact directory it owns, and reading inside it is allowed here.
  //
  // Read-only, and only for the Session's own directory: another Session's
  // artifacts, configuration and credentials are not in the grant (see
  // `trustedSessionOwnedRoot` for the root invariants). This step runs after
  // the critical safety checks above, so a credential-shaped path inside the
  // directory stays blocked.
  // Grants only ever live inside a private runtime root (see
  // `trustedSessionOwnedRoot`), so reads elsewhere skip this step entirely.
  const canonicalForGrant = READ_ONLY_TOOLS.has(toolName) ? resolveExistingPath(resolved) : '';
  if (
    READ_ONLY_TOOLS.has(toolName) &&
    isInsideRuntimeRoot(resolved, canonicalForGrant, runtimeReadScope)
  ) {
    const canonical = canonicalForGrant;
    if (
      matchesSessionOwnedReadableRoot(canonical, runtimeReadScope) ||
      matchesTrustedExactWriteTarget(canonical, runtimeReadScope)
    ) {
      // The checks above saw only the lexical path. A symlink inside the
      // granted root (`notes.txt -> .env`) must not read a secret the direct
      // path would have to ask for, so the real target gets the same checks.
      const canonicalReason = criticalSafetyReason(canonical);
      if (canonicalReason) return { allowed: false, reason: canonicalReason };
      return {
        allowed: true,
        reason: { type: 'sessionOwnedReadablePath', path: resolved },
      };
    }
  }

  // Step 3.5: Temp directory read auto-allow.
  //
  // Reads from temp stay low-friction. Writes fall through to the workspace /
  // sandbox / allow-rule checks below; a caller that passes `allowTempWrite`
  // to `evaluatePathCapability` (bash, apply_patch, write/edit/append) then
  // allows a non-sensitive temp write that only failed the workspace boundary.
  // Every location must be in temp: a symlink there may point anywhere.
  if (READ_ONLY_TOOLS.has(toolName) && identities.every((identity) => isTempDirectory(identity))) {
    return {
      allowed: true,
      reason: { type: 'tempDirectory', path: resolved },
    };
  }

  // Step 3.6: Well-known home subdirectory reads.
  //
  // Read-only tools accessing `~/Downloads` or `~/Desktop` auto-allow.
  // Write tools still ask — the user might want a permanent
  // `Write(~/Downloads/**)` rule via the `allowAlways` flow, but we don't
  // grant it silently. Other home subdirs (`~/Documents`, `~/Pictures`,
  // etc.) are deliberately NOT auto-read: they tend to hold personal
  // long-lived data and the noise-to-value ratio of agent reads there is
  // low enough that the user prefers an explicit confirmation.
  //
  // Sensitive files (`.env` / `id_rsa` / `.aws/credentials` / etc.) inside
  // these directories were already caught above; so were `.ssh` / `.git`
  // subdirectories via the dangerous-directory list.
  if (
    READ_ONLY_TOOLS.has(toolName) &&
    context.homeDir &&
    identities.every((identity) =>
      rootForms(context.homeDir!).some((home) => isWellKnownHomeReadAllowed(identity, home)),
    )
  ) {
    return {
      allowed: true,
      reason: { type: 'workingDirectory', path: resolved },
    };
  }

  // Step 3.7: explicitly non-sensitive system documentation reads.
  if (READ_ONLY_TOOLS.has(toolName) && identities.every(isWellKnownSystemReadAllowed)) {
    return {
      allowed: true,
      reason: { type: 'workingDirectory', path: resolved },
    };
  }

  // Step 4: Working directory boundary check. For a write every identity must
  // be inside the working directory or an allowed working path, so a symlink
  // or `..` that reaches outside does not inherit the boundary; a read needs
  // only its path as written.
  if (isInWorkDir || readsInsideAsWritten) {
    return {
      allowed: true,
      reason: { type: 'workingDirectory', path: resolved },
    };
  }

  // Step 5: Sandbox allow list. Like the working directory, a read needs its
  // path as written and where a shell lands, so a skill installed as a symlink
  // stays readable; a write needs every identity inside, and a `/` or
  // drive-root entry only widens reads.
  const sandboxRoots = context.sandboxAllowPaths
    ?.filter((root) => isReadOnlyTool || !isVolumeRoot(root, path))
    .flatMap(rootForms);
  const sandboxTargets = isReadOnlyTool ? (landing ? [resolved, landing] : [resolved]) : identities;
  if (sandboxRoots && sandboxTargets.every((target) => insideAnyRootForm(target, sandboxRoots))) {
    return {
      allowed: true,
      reason: { type: 'sandbox' },
    };
  }

  // Step 6: Allow rule matching. A shell walking `link/..` lands beside the
  // link's target; a rule must cover that place too, not only the folded path.
  for (const rule of toolRules) {
    if (rule.ruleBehavior !== 'allow') continue;

    if (!rule.ruleValue.ruleContent) {
      // Bare tool allow — allows all operations for this tool
      return {
        allowed: true,
        reason: { type: 'rule', rule },
      };
    }

    if (
      matchPathRule(resolved, rule.ruleValue.ruleContent) &&
      (landing === undefined || matchPathRule(landing, rule.ruleValue.ruleContent))
    ) {
      return {
        allowed: true,
        reason: { type: 'rule', rule },
      };
    }
  }

  // Default: path is outside working directory/scratch/allow-list with no
  // matching rule. Delegate to the mode router instead of silently allowing
  // read-only OTHER paths.
  return {
    allowed: false,
    reason: {
      type: 'workingDirectory',
      path: resolved,
    },
  };
}

export function ruleSupportsPathAction(
  rule: PermissionRule,
  action: PermissionRuleAction | undefined,
): boolean {
  const matcher = rule.ruleValue.matcher;
  if (!matcher || matcher.kind === 'tool') return true;
  if (matcher.kind !== 'path') return false;
  return (
    matcher.actions === undefined || (action !== undefined && matcher.actions.includes(action))
  );
}
