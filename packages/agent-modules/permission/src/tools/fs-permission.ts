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
import { isSameResolvedPath } from './path-identity.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files that require explicit user approval to modify (§5.2) */
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

/** Directories where writes trigger a safety check (§5.2) */
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
 * 4. Path traversal detection (`..` components)
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

  // 4. Path traversal check
  if (containsPathTraversal(normalized)) {
    return { valid: false, error: 'Path traversal (..) detected' };
  }

  // Resolve to absolute path
  const resolved = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(workingDirectory ?? process.cwd(), normalized);

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
 * Check if a path contains traversal components (`..`).
 *
 * Only flags `..` that would escape a safe boundary.
 * Resolved paths that still contain `..` components are suspicious.
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
  const basename = path.basename(filePath);
  return DANGEROUS_FILES.has(basename);
}

/**
 * Check whether a path falls within a dangerous/protected directory.
 */
export function isInDangerousDirectory(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const segments = resolved.split(path.sep);

  for (const dir of DANGEROUS_DIRECTORIES) {
    if (segments.includes(dir)) return true;
  }
  return false;
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
  const resolved = path.resolve(filePath);
  const segments = resolved.split(path.sep);
  const gitIndex = segments.lastIndexOf('.git');
  if (gitIndex === -1) return false;

  const relativeParts = segments.slice(gitIndex + 1).map((part) => part.toLowerCase());
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
  const TEMPLATE_SUFFIXES = ['example', 'sample', 'template'];
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
 * Check if a path is within the working directory.
 */
export function pathInWorkingPath(filePath: string, workingDirectory: string): boolean {
  const resolved = path.resolve(filePath);
  const normalizedWork = path.resolve(workingDirectory);

  return resolved === normalizedWork || resolved.startsWith(normalizedWork + path.sep);
}

/**
 * Check if a path is within any of the allowed working paths.
 */
export function pathInAllowedWorkingPath(
  filePath: string,
  allowedPaths: readonly string[],
): boolean {
  const resolved = path.resolve(filePath);

  for (const allowed of allowedPaths) {
    const normalizedAllowed = path.resolve(allowed);
    if (resolved === normalizedAllowed || resolved.startsWith(normalizedAllowed + path.sep)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Well-known home subdirectories (read-only convenience allow)
// ---------------------------------------------------------------------------

/**
 * Folder names under `~/` that are universally non-sensitive consumer directories — typical user
 * content lives here, not credentials. Reads are auto-allowed; writes still require user approval
 * so we don't silently produce files in the user's Downloads.
 *
 * Names match the conventional Unix-style names. Localized variants (e.g. the Chinese name for
 * Downloads, or `Téléchargements`) are NOT covered intentionally — agents querying localized paths
 * should fall through to the standard working-directory check and get a confirmation prompt.
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
 * Cached resolved temp directory path (computed once at module load).
 * Uses os.tmpdir() which is cross-platform:
 *   macOS:   /var/folders/xx/.../T/   (per-user temp folder)
 *   Linux:   /tmp
 *   Windows: C:\Users\<user>\AppData\Local\Temp
 */
const RESOLVED_TMPDIR = path.resolve(os.tmpdir());

/**
 * Check if a resolved path is within the system temp directory.
 *
 * Temp directories stay useful for low-friction reads. Writes are handled by
 * the selected workspace / allow-rule boundary in {@link isPathAllowed}.
 * Sensitive checks (system-sensitive paths, .env files, credential files,
 * sensitive git metadata) run BEFORE temp read allowance, so dangerous files
 * in temp dirs (e.g. /tmp/.env, /tmp/id_rsa) are still caught.
 *
 * Covers, on macOS / Linux:
 *   - the per-user `os.tmpdir()` path (e.g. /var/folders/.../T/)
 *   - the canonical /tmp prefix (agents often hardcode /tmp/...)
 * Covers, on Windows:
 *   - `os.tmpdir()` only (C:\Users\<user>\AppData\Local\Temp). There is no
 *     POSIX-style /tmp to fall back to.
 */
export function isTempDirectory(resolvedPath: string): boolean {
  if (resolvedPath === RESOLVED_TMPDIR || resolvedPath.startsWith(RESOLVED_TMPDIR + path.sep)) {
    return true;
  }
  if (process.platform !== 'win32') {
    if (resolvedPath === '/tmp' || resolvedPath.startsWith('/tmp/')) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal whitelist paths
// ---------------------------------------------------------------------------

/** Resolve existing parents too, so a directory alias cannot hide a protected read. */
function resolveExistingPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    const parent = path.dirname(filePath);
    return parent === filePath
      ? filePath
      : path.join(resolveExistingPath(parent), path.basename(filePath));
  }
}

/** Runtime state is private; only designated agent assets get implicit read access. */
function isProtectedRuntimeRead(
  filePath: string,
  context: PathCheckContext,
  recursive: boolean,
): boolean {
  const within = (target: string, root: string) => {
    const relative = path.relative(root, target);
    return (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    );
  };
  const roots = [context.dataDir, path.join(context.homeDir ?? os.homedir(), '.minimax')];
  const canonicalPath = resolveExistingPath(filePath);
  for (const root of roots) {
    if (!root) continue;
    const resolvedRoot = path.resolve(root);
    const canonicalRoot = resolveExistingPath(resolvedRoot);
    if (recursive && within(canonicalRoot, canonicalPath)) return true;
    if (!within(filePath, resolvedRoot) && !within(canonicalPath, canonicalRoot)) continue;
    // Do not resolve the asset subdirectory itself: a skills/ symlink pointing
    // at credentials must not turn its destination into a trusted asset root.
    const readableAsset =
      within(canonicalPath, path.join(canonicalRoot, 'skills')) ||
      (context.agentName != null &&
        within(canonicalPath, path.join(canonicalRoot, 'agents', context.agentName, 'workspace'))) ||
      isInternalWhitelistedPath(canonicalPath, {
        ...context,
        dataDir: canonicalRoot,
      });
    if (!readableAsset) return true;
  }
  return false;
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

  // MEMORY.md at any level within data dir
  if (resolved.endsWith('MEMORY.md') && resolved.startsWith(normalizedDataDir)) {
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

/**
 * Check if a file path operation is allowed.
 *
 * Step 1: Deny rule matching
 * Step 2: Internal path whitelist
 * Step 3: Safety check (DANGEROUS_FILES + DANGEROUS_DIRECTORIES, write-only)
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

  // Step 1: Deny rule matching
  for (const rule of toolRules) {
    if (rule.ruleBehavior !== 'deny') continue;

    if (!rule.ruleValue.ruleContent) {
      // Bare tool deny — denies all operations for this tool
      return {
        allowed: false,
        reason: { type: 'rule', rule },
      };
    }

    if (matchPathRule(resolved, rule.ruleValue.ruleContent)) {
      return {
        allowed: false,
        reason: { type: 'rule', rule },
      };
    }
  }

  // Runtime state can contain credentials and session data. Check before ALL
  // implicit allowances, including workspace/temp and internal aliases. A grep
  // of the data root must be reviewed just like a direct config.yaml read.
  if (
    READ_ONLY_TOOLS.has(toolName) &&
    isProtectedRuntimeRead(resolved, context, toolName === 'grep')
  ) {
    return {
      allowed: false,
      reason: {
        type: 'safetyCheck',
        description: `Private runtime data access requires approval. Path: ${resolved}`,
        category: 'credentialFile',
        classifierApprovable: false,
      },
    };
  }

  // Step 2: Internal path whitelist
  if (isInternalWhitelistedPath(resolved, context)) {
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
  const isReadOnlyTool = READ_ONLY_TOOLS.has(toolName);
  const isInWorkDir =
    pathInWorkingPath(resolved, context.workingDirectory) ||
    (context.allowedWorkingPaths != null &&
      pathInAllowedWorkingPath(resolved, context.allowedWorkingPaths));
  const skipDangerousCheck = isReadOnlyTool && isInWorkDir;

  // Critical: never skipped — system sensitive paths.
  if (isSystemSensitivePath(resolved)) {
    return {
      allowed: false,
      reason: {
        type: 'safetyCheck',
        description: `System secret access requires LLM review and explicit approval if the LLM cannot allow it. Path: ${resolved}`,
        category: 'systemSensitivePath',
        classifierApprovable: true,
      },
    };
  }

  // Critical: never skipped — credential / private-key files.
  if (isCredentialFile(resolved)) {
    return {
      allowed: false,
      reason: {
        type: 'safetyCheck',
        description: `Credential or private-key access requires LLM review and explicit approval if the LLM cannot allow it. Path: ${resolved}`,
        category: 'credentialFile',
        classifierApprovable: true,
      },
    };
  }

  // Critical: never skipped — .env files (excluding .env.example etc.).
  if (isEnvFile(resolved)) {
    return {
      allowed: false,
      reason: {
        type: 'safetyCheck',
        description: `Environment file may contain secrets. Path: ${resolved}`,
        category: 'envFile',
        classifierApprovable: true,
      },
    };
  }

  // Critical: never skipped — sensitive git metadata (.git/config,
  // .git/credentials, .git/modules/<x>/credentials etc.). The
  // skipDangerousCheck would have auto-allowed reads of `.git/config`
  // inside the workdir — but that file can contain HTTPS bearer tokens
  // (e.g. a `[remote] url = https://USER:PAT@host/...` written by
  // `git config credential.helper`).
  if (isInDangerousDirectory(resolved) && isSensitiveGitFile(resolved)) {
    return {
      allowed: false,
      reason: {
        type: 'safetyCheck',
        description: `Sensitive git metadata may contain credentials or remotes with tokens. Path: ${resolved}`,
        category:
          path.basename(resolved).toLowerCase() === 'credentials'
            ? 'credentialFile'
            : 'gitSensitiveFile',
        classifierApprovable: true,
      },
    };
  }

  if (!skipDangerousCheck && isDangerousFile(resolved)) {
    return {
      allowed: false,
      reason: {
        type: 'safetyCheck',
        description: `Protected user or tool configuration file. Path: ${resolved}`,
        category: 'protectedFile',
        classifierApprovable: true,
      },
    };
  }

  if (!skipDangerousCheck && isInDangerousDirectory(resolved)) {
    const protectedDirectory = DANGEROUS_DIRECTORIES.find((d) =>
      resolved.split(path.sep).includes(d),
    );
    const category = protectedDirectory === '.git' ? 'gitDirectory' : 'protectedDirectory';
    return {
      allowed: false,
      reason: {
        type: 'safetyCheck',
        description: `Protected configuration or credential directory (${protectedDirectory ?? 'unknown'}). Path: ${resolved}`,
        category,
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

  // Step 3.5: Temp directory read auto-allow.
  //
  // Reads from temp stay low-friction. Writes to temp are still writes outside
  // the selected workspace unless the temp path is also covered by workspace /
  // sandbox / user allow rules below.
  if (READ_ONLY_TOOLS.has(toolName) && isTempDirectory(resolved)) {
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
    isWellKnownHomeReadAllowed(resolved, context.homeDir)
  ) {
    return {
      allowed: true,
      reason: { type: 'workingDirectory', path: resolved },
    };
  }

  // Step 3.7: explicitly non-sensitive system documentation reads.
  if (READ_ONLY_TOOLS.has(toolName) && isWellKnownSystemReadAllowed(resolved)) {
    return {
      allowed: true,
      reason: { type: 'workingDirectory', path: resolved },
    };
  }

  // Step 4: Working directory boundary check
  if (pathInWorkingPath(resolved, context.workingDirectory)) {
    return {
      allowed: true,
      reason: { type: 'workingDirectory', path: resolved },
    };
  }

  if (
    context.allowedWorkingPaths &&
    pathInAllowedWorkingPath(resolved, context.allowedWorkingPaths)
  ) {
    return {
      allowed: true,
      reason: { type: 'workingDirectory', path: resolved },
    };
  }

  // Step 5: Sandbox allow list
  if (context.sandboxAllowPaths && pathInAllowedWorkingPath(resolved, context.sandboxAllowPaths)) {
    return {
      allowed: true,
      reason: { type: 'sandbox' },
    };
  }

  // Step 6: Allow rule matching
  for (const rule of toolRules) {
    if (rule.ruleBehavior !== 'allow') continue;

    if (!rule.ruleValue.ruleContent) {
      // Bare tool allow — allows all operations for this tool
      return {
        allowed: true,
        reason: { type: 'rule', rule },
      };
    }

    if (matchPathRule(resolved, rule.ruleValue.ruleContent)) {
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

function ruleSupportsPathAction(
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
