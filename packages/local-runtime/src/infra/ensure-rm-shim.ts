/**
 * Seed the recoverable-delete `rm` shim into `<dataDir>/shims/`.
 *
 * WHY A SHIM INSTEAD OF MORE COMMAND REWRITING
 * --------------------------------------------
 * "Every delete is recoverable" is an EXECUTION-layer promise. Rewriting
 * command text can only honour it for shapes a parser recognises, and that set
 * is never complete: `xargs rm`, `find … -exec rm {} \;`, or an `rm` inside a
 * shell script the agent just wrote all slip through, because the literal token
 * `rm` never appears where a rewriter can reach it.
 *
 * PATH resolution has no such blind spot. Whatever invokes `rm` — the agent
 * directly, `xargs`, `find`, or a nested script — the shell resolves the name
 * through PATH, so a shim at the front of PATH is reached in every case. The
 * permission layer therefore stays a pure judgement (allow / deny / ask) and the
 * sandbox stays a pure kernel-level interceptor; neither needs to know that
 * deletes are recoverable at all.
 *
 * WHY NOT `<dataDir>/bin`
 * ----------------------
 * `ensurePathIntegration` appends `<dataDir>/bin` to the USER's `~/.zshrc` /
 * `~/.bashrc`. Dropping an `rm` in there would silently replace `rm` in the
 * user's own interactive terminal, which we must never do. `<dataDir>/shims` is
 * injected only into the agent's bash environment (see `BashEnvPolicy.
 * prependPath`), never into a user-facing shell.
 *
 * Windows is intentionally skipped: it has no sandbox, and PowerShell resolves
 * `rm` as an alias for `Remove-Item` rather than through PATH, so recoverable
 * deletion stays on the existing host-side launcher there.
 *
 * Idempotent: only rewrites when the on-disk content differs.
 */
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveBashEnvPolicy, type BashEnvPolicy } from '@mavis/agent-core/bash-subprocess-env';

/**
 * Delegates to the sibling `../bin/mavis-trash` rather than an absolute path so
 * the shim keeps working if the dataDir is moved or mounted elsewhere.
 *
 * `exec` replaces the shim process, so the caller observes mavis-trash's own
 * exit status and stderr directly — an `rm` failure must stay an `rm` failure.
 * Arguments are forwarded verbatim: mavis-trash already accepts rm's surface
 * (`-f`, `-r`/`-R`, `-rf`, `--`) and mirrors `rm -f`'s empty-operand success.
 */
export const RM_SHIM_CONTENT = `#!/bin/bash
# Managed by MiniMax Code. Do not edit.
#
# Recoverable-delete shim: resolves ahead of /bin/rm on the agent's PATH so
# every delete — including those reached through xargs, find -exec, or a
# generated script — lands in the platform trash instead of being unlinked.
#
# This file is NOT on the user's interactive PATH; it applies to agent bash only.
set -u
shim_dir="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd -P)"
trash_bin="$shim_dir/../bin/mavis-trash"
if [ ! -x "$trash_bin" ]; then
  echo "rm: recoverable-delete runtime is missing at $trash_bin" >&2
  echo "rm: refusing to fall back to an unrecoverable delete" >&2
  exit 1
fi
exec "$trash_bin" "$@"
`;

/** Absolute path of the directory injected at the front of the agent's PATH. */
export function resolveRmShimDir(dataDir: string): string {
  return path.join(dataDir, 'shims');
}

/**
 * Bash env policy for agent subprocesses, with the shim directory installed
 * ahead of the inherited PATH and a spawn preflight that keeps the
 * recoverable-delete promise fail-closed WITHOUT being fragile: if the shim is
 * missing or lost its execute bit (cache cleaner, restored backup, chmod), the
 * preflight first re-seeds it in place — `ensureRmShim` is idempotent — and
 * only refuses the spawn when that repair also fails (e.g. read-only dataDir).
 * Native deletion removes this profile's inherited shim path and skips the
 * preflight entirely; the recoverable scripts on disk are left unchanged.
 * Without a dataDir there is no shim to install, and Windows never injects
 * the shim (see `ensureRmShim`).
 */
export function resolveAgentBashEnvPolicy(
  dataDir?: string,
  platform: NodeJS.Platform = process.platform,
  nativeDelete = false,
): BashEnvPolicy {
  if (!dataDir) return resolveBashEnvPolicy({});
  const shimDir = resolveRmShimDir(dataDir);
  if (nativeDelete) return resolveBashEnvPolicy({ removePath: [shimDir] });
  if (platform === 'win32') return resolveBashEnvPolicy({});
  const shimPath = path.join(shimDir, 'rm');
  return resolveBashEnvPolicy({
    prependPath: [shimDir],
    spawnPreflight: () => {
      try {
        accessSync(shimPath, constants.X_OK);
        return;
      } catch {
        // Missing or not executable — attempt the in-place repair below.
      }
      try {
        ensureRmShim(dataDir, platform);
        accessSync(shimPath, constants.X_OK);
      } catch (cause) {
        throw new Error(
          `The recoverable-delete rm shim at ${shimPath} is missing or not executable and could not be re-seeded. ` +
            'Refusing to start bash, because deletes would bypass the trash and become unrecoverable. ' +
            'Check that the MiniMax Code data directory is writable, then restart the app to re-seed the shim.',
          { cause },
        );
      }
    },
  });
}

/**
 * Seed the shim. Returns the directory to prepend to PATH, or `undefined` when
 * the platform has no PATH-resolvable `rm` to shadow.
 */
export function ensureRmShim(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32') return undefined;
  const shimDir = resolveRmShimDir(dataDir);
  mkdirSync(shimDir, { recursive: true });
  const shimPath = path.join(shimDir, 'rm');
  seedFileIfChanged(shimPath, RM_SHIM_CONTENT, 0o755);
  return shimDir;
}

function seedFileIfChanged(filePath: string, content: string, mode?: number): void {
  let existing: string | undefined;
  try {
    existing = readFileSync(filePath, 'utf8');
  } catch {
    existing = undefined;
  }
  if (existing !== content) {
    writeFileSync(filePath, content, mode === undefined ? undefined : { mode });
  }
  if (mode !== undefined) {
    // Repair the execute bit even when the content already matched: a shim that
    // is present but not executable would make bash fall through to /bin/rm.
    try {
      chmodSync(filePath, mode);
    } catch {
      // Best effort — a read-only dataDir surfaces at spawn time instead.
    }
  }
}
