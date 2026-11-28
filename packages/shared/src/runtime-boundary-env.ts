/**
 * Child-process environment builder — prevents runtime boundary state from
 * leaking across process generations.
 *
 * Modes:
 *   - `spawn-daemon`: starting a new daemon instance; daemon identity must come
 *                     from args/files, never inherited env.
 *   - `agent-runtime`: daemon starts an agent framework child; parent hints are
 *                      injected per spawn and must not be mistaken for child
 *                      daemon identity.
 *
 * @module
 */

/**
 * Runtime-injected env vars that must NOT leak into repo/worktree daemon children.
 * These describe "who the parent runtime is", not "what the child should be".
 *
 * `MAVIS_ACCESS_TOKEN` is included as a defensive fallback: the supported entry
 * point for the user identity token is `__MAVIS_PARENT_ACCESS_TOKEN`
 * (see {@link PARENT_HINT_KEYS}). Stripping the unprefixed name here ensures
 * stale env vars from older Electron builds, manual exports, or grandchild
 * inheritance never silently take effect inside a fresh daemon.
 */
export const MANAGED_RUNTIME_KEYS = [
  'MAVIS_ACCESS_TOKEN',
  'MAVIS_REGION',
  'MAVIS_BUILD_ENV',
  '__MAVIS_DISABLE_SAFETY',
  'MAVIS_SQLITE3_MODULE_PATH',
  // Desktop App-owned mcode-tools launcher directory: valid only for the Runtime that App forked.
  'MAVIS_MCODE_TOOLS_HOST_BIN_DIR',
  'ELECTRON_RUN_AS_NODE',
] as const;

/** Legacy runtime identity vars. Daemon identity now travels via args/files. */
export const LEGACY_RUNTIME_ENV_KEYS = [
  '__MAVIS_RUNTIME_PORT',
  '__MAVIS_RUNTIME_DATA_DIR',
  '__MAVIS_RUNTIME_PROFILE',
  '__MAVIS_RUNTIME_DISABLE_GIT_AUTO_CONFIG',
  '__MAVIS_RUNTIME_SKIP_PID_PORT',
  '__MAVIS_RUNTIME_MANAGED',
  '__MAVIS_RUNTIME_AGENT_NAME',
  '__MAVIS_RUNTIME_SESSION_ID',
  '__MAVIS_RUNTIME_DAEMON_URL',
  'MAVIS_PORT',
  'MINIMAX_DATA_DIR',
  'MAVIS_DATA_DIR',
  'MAVIS_PROFILE',
  'MAVIS_SKIP_PID_PORT',
  'MAVIS_MANAGED_RUNTIME',
  'AGENTARCHON_PORT',
  'AGENTARCHON_DATA_DIR',
  'AGENTARCHON_PROFILE',
] as const;

/** @deprecated Use LEGACY_RUNTIME_ENV_KEYS. Kept for test compatibility. */
export const RUNTIME_IDENTITY_KEYS = LEGACY_RUNTIME_ENV_KEYS;

/** Parent → direct-child hints. Strip before spawning a new daemon. */
export const PARENT_HINT_KEYS = [
  '__MAVIS_PARENT_DAEMON_URL',
  '__MAVIS_PARENT_DATA_DIR',
  '__MAVIS_PARENT_SESSION_ID',
  '__MAVIS_PARENT_AGENT_NAME',
  '__MAVIS_PARENT_MANAGED',
  '__MAVIS_PARENT_ACCESS_TOKEN',
  '__MAVIS_PARENT_REAL_USER_ID',
  '__MAVIS_PARENT_USER_EMAIL',
  '__MAVIS_PARENT_USER_NAME',
  '__MAVIS_PARENT_SUB_USER_NAME',
  '__MAVIS_PARENT_AUTH_SECRET',
] as const;

/**
 * ASR proxy auth env vars must not reach agent children. JWT vars are
 * legacy and ignored. Kept for defense-in-depth even though Seed / Qwen
 * providers were retired and the daemon no longer speaks to the shared
 * asr-proxy: an upgrading user's shell profile may still export these,
 * and stripping them before they reach agent-runtime children costs
 * nothing.
 */
export const ASR_PROXY_AUTH_ENV_KEYS = [
  'ASR_PROXY_JWT_SECRET',
  'ASR_PROXY_TOKEN',
  'ASR_TENANT_ID',
] as const;

export type BuildChildEnvMode = 'spawn-daemon' | 'agent-runtime';

const RUNTIME_BOUNDARY_KEY_NAMES = new Set<string>([
  ...MANAGED_RUNTIME_KEYS,
  ...LEGACY_RUNTIME_ENV_KEYS,
  ...PARENT_HINT_KEYS,
]);
const AGENT_RUNTIME_BOUNDARY_KEY_NAMES = new Set<string>(ASR_PROXY_AUTH_ENV_KEYS);

function stripRuntimeBoundaryKeys(env: NodeJS.ProcessEnv, mode: BuildChildEnvMode): void {
  for (const key of Object.keys(env)) {
    // Windows environment names are case-insensitive. Normalize here as well so copied
    // plain objects cannot bypass the same boundary with differently-cased keys.
    const normalizedKey = key.toUpperCase();
    if (
      normalizedKey.startsWith('__MAVIS_RUNTIME_') ||
      normalizedKey.startsWith('__MAVIS_PARENT_') ||
      normalizedKey.startsWith('__MAVIS_ORIGIN_XDG_') ||
      normalizedKey.startsWith('AGENTARCHON_') ||
      normalizedKey.startsWith('AGENT_ARCHON_') ||
      normalizedKey === 'MAVIS_AGENT' ||
      normalizedKey === 'MAVIS_SESSION' ||
      RUNTIME_BOUNDARY_KEY_NAMES.has(normalizedKey) ||
      (mode === 'agent-runtime' && AGENT_RUNTIME_BOUNDARY_KEY_NAMES.has(normalizedKey))
    ) {
      delete env[key];
    }
  }
}

/**
 * Build env for a child process.
 *
 * @param mode
 *   - `'spawn-daemon'` — strip runtime and parent boundary keys before starting
 *     a new daemon. Daemon identity must be passed through args and files.
 *   - `'agent-runtime'` — strip inherited boundary keys before starting an
 *     agent framework child; callers may explicitly inject one-hop parent hints.
 *
 * @param overrides — explicit env vars to set (override inherited values).
 *   Set a key to `undefined` to remove it from the result.
 */
export function buildChildEnv(
  mode: BuildChildEnvMode,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };

  stripRuntimeBoundaryKeys(base, mode);

  return { ...base, ...overrides };
}

/**
 * Strip runtime-boundary env vars from `process.env` in-place.
 *
 * Call at daemon startup once explicit args have been consumed. This removes
 * inherited legacy runtime identity and one-hop parent hints so they cannot
 * affect the daemon's own behavior or leak to grandchildren.
 */
export function stripManagedRuntimeEnv(): void {
  stripRuntimeBoundaryKeys(process.env, 'agent-runtime');
}

/**
 * Strip runtime-boundary env vars from the given env object in place and
 * report which keys were removed.
 *
 * Same semantics as the internal boundary strip used by {@link buildChildEnv};
 * exported so other spawn boundaries (e.g. the bash tool subprocess sanitizer
 * in `bash-subprocess-env.ts`) can reuse the exact same key lists instead of
 * forking them. Only keys that were present with a defined value are reported.
 */
export function stripRuntimeBoundaryKeysFrom(
  env: NodeJS.ProcessEnv,
  mode: BuildChildEnvMode,
): string[] {
  const present = Object.keys(env).filter((key) => env[key] !== undefined);
  stripRuntimeBoundaryKeys(env, mode);
  return present.filter((key) => !(key in env));
}

export function findLegacyRuntimeEnvKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter(
    (key) =>
      key.startsWith('__MAVIS_RUNTIME_') ||
      key === 'MAVIS_PORT' ||
      key === 'MINIMAX_DATA_DIR' ||
      key === 'MAVIS_DATA_DIR' ||
      key === 'MAVIS_PROFILE' ||
      key === 'MAVIS_SKIP_PID_PORT' ||
      key === 'MAVIS_MANAGED_RUNTIME',
  );
}
