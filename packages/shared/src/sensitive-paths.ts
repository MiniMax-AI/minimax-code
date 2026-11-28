import { Minimatch } from 'minimatch';

/**
 * Sensitive-file deny-list shared by the desktop and cloud rg-based tools
 * (grep / glob) and by Desktop Main, which never writes these files from an SSH host to
 * local disk. Single source of truth — desktop consumes the raw argv form
 * (spawn, no quoting), cloud wraps each pattern with shell quoting when
 * building the sandbox command string.
 *
 * The primary safety boundary is the workspace guard / permission gate; these
 * patterns are defense-in-depth for secrets. Tool-result artifacts are
 * intentionally searchable because truncation notices point the model back to
 * workspace/NAS files for grep/read/bash follow-up.
 */

const VCS_GLOB_EXCLUDES = [
  // Directory deny-list. Use `**/<dir>/**` (not `<dir>/*`): a glob containing a
  // slash is anchored to the search root by gitignore/ripgrep rules, so
  // `.ssh/*` would only exclude a ROOT-level `.ssh/` and leak nested copies
  // (e.g. `pkg/.ssh/config`). The `**/` prefix matches zero-or-more leading
  // segments, so root and any-depth are both covered.
  '!**/.git/**',
  // Non-git VCS metadata (noise, mirrors reference CLI's VCS exclude list)
  '!**/.svn/**',
  '!**/.hg/**',
  '!**/.bzr/**',
  '!**/.jj/**',
  '!**/.sl/**',
] as const;

const SECRET_GLOB_EXCLUDES = [
  // Filename patterns below carry no slash, so gitignore already matches them
  // at any depth — no `**/` prefix needed.
  '!.env',
  '!.env.*',
  '!*.key',
  '!*.pem',
  '!*.p12',
  '!*.pfx',
  '!**/.ssh/**',
  '!**/.aws/**',
  '!**/.kube/**',
  '!.npmrc',
  '!id_rsa',
  '!id_dsa',
  '!id_ecdsa',
  '!id_ed25519',
] as const;

/** Desktop security policy: VCS metadata plus secret-bearing paths. */
export const LOCAL_SENSITIVE_GLOB_EXCLUDES = [
  ...VCS_GLOB_EXCLUDES,
  ...SECRET_GLOB_EXCLUDES,
] as const;

/**
 * Existing cloud-compatible list. `node_modules` remains here only to preserve
 * cloud argv/behaviour; desktop owns dependency noise in rg-scan-policy.ts.
 */
export const SENSITIVE_GLOB_EXCLUDES = [
  ...VCS_GLOB_EXCLUDES,
  '!**/node_modules/**',
  ...SECRET_GLOB_EXCLUDES,
] as const;

/**
 * Compiled once: Workspace indexing checks every inventory path, and compiling
 * the globs per call made a 10k-file scan block the runtime for seconds.
 */
const SENSITIVE_PATH_MATCHERS = LOCAL_SENSITIVE_GLOB_EXCLUDES.map((exclude) => {
  const pattern = exclude.slice(1);
  return {
    perSegment: !pattern.includes('/'),
    matcher: new Minimatch(pattern, { dot: true, nocase: true }),
  };
});

/** Whether `path` (absolute or relative, either separator) is VCS metadata or a secret. */
export function isSensitivePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '');
  const segments = normalized.split('/').filter(Boolean);
  return SENSITIVE_PATH_MATCHERS.some(({ perSegment, matcher }) =>
    perSegment
      ? segments.some((segment) => matcher.match(segment))
      : matcher.match(normalized) || matcher.match(`${normalized}/__mavis_sensitive_root_probe__`),
  );
}
