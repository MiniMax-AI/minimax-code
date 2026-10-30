/**
 * Shared context type for bash permission helpers. Lives in its own
 * file to avoid runtime cyclic imports between `bash-permission.ts`,
 * `bash-write-target.ts`, and `bash-fast-allow.ts` — every consumer
 * pulls the type from here without depending on each other.
 */

import type { PermissionRule } from '../types.js';

/**
 * Optional context passed from {@link BashToolPermissionChecker} to
 * fine-tune the SOFT remote-execution pre-scan, the IO-redirect /
 * write-target gates, and the fast-allow shortcut. Without it, the
 * pre-scan still works but always trips on `<sep> bash <script>`
 * (the original conservative behaviour). With it, locally-produced
 * scripts can pass through.
 */
export type BashCheckContext = {
  /** Keep native delete commands unchanged and apply ordinary permission policy. */
  nativeDelete?: boolean;
  /** Host platform; required before platform-specific delete transforms are enabled. */
  platform?: NodeJS.Platform;
  /** Actual shell family used for the command; unknown keeps Windows delete fail-closed. */
  shellFamily?: 'posix' | 'cmd' | 'powershell' | 'unknown';
  /** Number of top-level command segments in the original shell input. */
  topLevelSegmentCount?: number;
  sessionId?: string;
  workingDirectory?: string;
  allowedWorkingPaths?: readonly string[];
  /** User home directory. Lets the write-target gate statically expand `~/` so a leading tilde is not a dynamic-shape bail and can match `writeAllowRules`. */
  homeDir?: string;
  /** Host-owned file probe for local-script relaxation. Missing probe keeps the check conservative. */
  isFile?: (filePath: string) => boolean;
  /** User-granted `write` tool allow rules. The bash gate cross-references them so shell forms (`cp` / `mv` / `tee` / `cat > <dst>`) and direct tool writes stay symmetric on user-approved destinations (e.g. `write(/Users/adao/Downloads/**)`). */
  writeAllowRules?: readonly PermissionRule[];
};
