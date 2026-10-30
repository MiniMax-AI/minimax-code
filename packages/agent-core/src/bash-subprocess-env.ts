/**
 * Bash subprocess environment sanitizer — two independent layers applied
 * before every bash tool child spawn (foreground LocalBashTool, background
 * bash executor, and the pi-turn-runner builtin fallback).
 *
 * Layer A — MCode runtime boundary strip. ALWAYS on, no escape hatch.
 *   Reuses the env-builder boundary key lists verbatim (import, never fork):
 *   runtime/parent identity, session ids, profile/dataDir/port keys, safety
 *   switches, and ASR proxy auth. Leaking these is not a "secret exfil"
 *   problem but a boundary-correctness one: a child could impersonate the
 *   parent session against the runtime API, or a nested `mavis` CLI inside
 *   bash would silently bind to the parent runtime's profile.
 *
 * Layer B — provider and integration secret scrub. GATED, mirroring the
 *   reference CLI's `subprocessEnv()` design (src/utils/subprocessEnv.ts):
 *     - `off`    (interactive default): do not strip user secrets. CC parity —
 *                interactive users rely on env credentials (gh, npm, ...).
 *     - `scrub`  (auto in CI / non-interactive): precise blocklist of
 *                credentials the *parent* process needs but subprocesses never
 *                do. GH_TOKEN / GITHUB_TOKEN / NPM_TOKEN are intentionally NOT
 *                on the list (CC parity: subprocesses have legitimate uses).
 *     - `strict` (opt-in): pattern-based strip of credential-looking names,
 *                with a protected-system-vars floor and an allowlist hatch.
 *
 * @module
 */

import { isAbsolute, resolve } from 'node:path';

import { stripRuntimeBoundaryKeysFrom } from '@mavis/shared/runtime-boundary-env';

export type BashEnvSanitizeMode = 'off' | 'scrub' | 'strict';

export interface BashEnvPolicy {
  mode: BashEnvSanitizeMode;
  /** Names exempt from the `strict` pattern strip. Never applies to Layer A. */
  allowlist?: readonly string[];
  /**
   * Absolute directories prepended to `PATH` for every bash subprocess.
   *
   * Used by the desktop runtime to install command shims (currently the
   * recoverable-delete `rm` shim) so the EXECUTION layer decides how a verb is
   * carried out, without any caller having to parse or rewrite command text.
   * agent-core stays agnostic about what the directories contain.
   */
  prependPath?: readonly string[];
  /** Absolute runtime-managed directories to remove from inherited PATH. */
  removePath?: readonly string[];
  /**
   * Host-injected gate that runs before every bash subprocess launch; throwing
   * blocks the spawn. The desktop runtime uses it to verify — and re-seed when
   * possible — the recoverable-delete `rm` shim, so a lost shim fails the
   * spawn loudly instead of silently resolving `/bin/rm` (fail-closed). It is
   * a callback rather than data because agent-core must stay free of
   * filesystem imports (host boundary): only the host knows what the shim
   * directories are supposed to contain and how to repair them.
   */
  spawnPreflight?: () => void;
}

/** Dynamic sources are read for each new subprocess, never cached by the tool. */
export type BashEnvPolicySource = BashEnvPolicy | (() => BashEnvPolicy);

export interface BashEnvSanitizeResult {
  /** New env object; the input is never mutated. */
  env: NodeJS.ProcessEnv;
  /** Names (never values) of removed vars, sorted, for tool-result hints. */
  removed: string[];
}

/**
 * Precise `scrub` blocklist. Selection rule (reference CLI GHA_SUBPROCESS_SCRUB
 * parity): the parent process needs these for API calls / lazy SDK reads, but
 * bash subprocesses never legitimately do. Each entry also strips its
 * `INPUT_<NAME>` alias (GitHub Actions duplicates `with:` inputs that way).
 *
 * Deliberately NOT listed (CC parity — legitimate subprocess uses):
 * GH_TOKEN, GITHUB_TOKEN (gh CLI), NPM_TOKEN (private registry installs).
 */
export const BASH_SUBPROCESS_SCRUB: readonly string[] = [
  // Provider / LLM auth — the runtime re-reads these per-request itself
  'MCODE_PROVIDER_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'OPENAI_API_KEY',

  // OTLP exporter headers — documented to carry Authorization bearer tokens
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',

  // Cloud provider creds — lazy SDK reads in the parent only
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',

  // GitHub Actions OIDC + artifact/cache API — repo-takeover / supply-chain pivots
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',

  // MCode-side additions — runtime-only integration tokens, no subprocess use
  'FIGMA_API_TOKEN',
  'FIGMA_TOKEN',
  'E2E_AUTH_TOKEN',
];

/**
 * Credential keyword core (regex source fragment, no anchors/flags) shared by
 * {@link SENSITIVE_ENV_NAME_RE} here and the permission layer's secret-read
 * command patterns (`echo $X`, `printenv X`). Single source so the two stay
 * aligned — a sync-guard test asserts the permission side imports this.
 */
export const SENSITIVE_ENV_KEYWORD_CORE =
  'API_?KEY|KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY';

/**
 * Credential-looking env var names for the `strict` mode and for the
 * permission layer's secret-read command rules (`echo $X`, `printenv X`).
 * Segment-bounded on `_`/start/end so MONKEY / TOKENIZER / KEYBOARD survive.
 */
export const SENSITIVE_ENV_NAME_RE = new RegExp(
  `(?:^|_)(?:${SENSITIVE_ENV_KEYWORD_CORE})S?(?:_|$)`,
  'i',
);

/** System vars the `strict` pattern must never strip (POSIX + Windows). */
const PROTECTED_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'LOGNAME',
  'USER',
  'TERM',
  'TMPDIR',
  // Windows
  'SYSTEMROOT',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
]);

function isProtectedName(name: string): boolean {
  const upper = name.toUpperCase();
  return PROTECTED_ENV_NAMES.has(upper) || upper.startsWith('LC_');
}

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

const VALID_MODES: ReadonlySet<string> = new Set(['off', 'scrub', 'strict']);

/**
 * Resolve the effective Layer B policy. Precedence: explicit override >
 * `MAVIS_BASH_ENV_SANITIZE` env switch > auto (CI markers → `scrub`,
 * otherwise `off` — interactive default, reference CLI parity).
 */
export function resolveBashEnvPolicy(
  overrides?: Partial<BashEnvPolicy>,
  envSource: NodeJS.ProcessEnv = process.env,
): BashEnvPolicy {
  let mode: BashEnvSanitizeMode | undefined = overrides?.mode;
  if (mode === undefined) {
    const explicit = envSource.MAVIS_BASH_ENV_SANITIZE?.trim().toLowerCase();
    if (explicit && VALID_MODES.has(explicit)) {
      mode = explicit as BashEnvSanitizeMode;
    } else if (isEnvTruthy(envSource.CI) || isEnvTruthy(envSource.GITHUB_ACTIONS)) {
      mode = 'scrub';
    } else {
      mode = 'off';
    }
  }
  return {
    mode,
    ...(overrides?.allowlist ? { allowlist: overrides.allowlist } : {}),
    ...(overrides?.prependPath ? { prependPath: overrides.prependPath } : {}),
    ...(overrides?.removePath ? { removePath: overrides.removePath } : {}),
    ...(overrides?.spawnPreflight ? { spawnPreflight: overrides.spawnPreflight } : {}),
  };
}

export function sanitizeBashSubprocessEnv(
  env: NodeJS.ProcessEnv,
  source: BashEnvPolicySource,
): BashEnvSanitizeResult {
  const policy = typeof source === 'function' ? source() : source;
  policy.spawnPreflight?.();
  const out: NodeJS.ProcessEnv = { ...env };
  const removed: string[] = [];

  // Layer A — MCode boundary strip. Always on; allowlist deliberately ignored.
  removed.push(...stripRuntimeBoundaryKeysFrom(out, 'agent-runtime'));

  // Layer B — provider and integration secret scrub, gated by mode.
  if (policy.mode === 'scrub') {
    for (const key of BASH_SUBPROCESS_SCRUB) {
      for (const name of [key, `INPUT_${key}`]) {
        if (out[name] !== undefined) removed.push(name);
        delete out[name];
      }
    }
  } else if (policy.mode === 'strict') {
    const allow = new Set((policy.allowlist ?? []).map((name) => name.toUpperCase()));
    for (const name of Object.keys(out)) {
      if (isProtectedName(name)) continue;
      if (allow.has(name.toUpperCase())) continue;
      if (!SENSITIVE_ENV_NAME_RE.test(name)) continue;
      if (out[name] !== undefined) removed.push(name);
      delete out[name];
    }
  }

  removed.sort();
  removePathEntries(out, policy.removePath);
  applyPathPrefix(out, policy.prependPath);
  return { env: out, removed };
}

/** Remove only the named managed directories, preserving every other PATH entry. */
function removePathEntries(env: NodeJS.ProcessEnv, removePath?: readonly string[]): void {
  if (!removePath?.length) return;
  const normalize = (entry: string) => {
    const absolute = resolve(entry);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const removed = new Set(removePath.filter(isAbsolute).map(normalize));
  const separator = process.platform === 'win32' ? ';' : ':';
  for (const name of Object.keys(env)) {
    const isPath =
      process.platform === 'win32'
        ? name.toUpperCase() === 'PATH'
        : name === 'PATH' || name === 'Path';
    if (!isPath) continue;
    const current = env[name];
    if (current === undefined) continue;
    env[name] = current
      .split(separator)
      .filter((entry) => !isAbsolute(entry) || !removed.has(normalize(entry)))
      .join(separator);
  }
}

/**
 * Prepend runtime-managed shim directories to PATH, de-duplicating so repeated
 * spawns cannot grow the variable without bound. Relative entries are ignored:
 * a relative shim directory would resolve against the command's cwd and could
 * be shadowed by repository content.
 */
function applyPathPrefix(env: NodeJS.ProcessEnv, prependPath?: readonly string[]): void {
  if (!prependPath?.length) return;
  const separator = process.platform === 'win32' ? ';' : ':';
  const existing = env.PATH ?? env.Path ?? '';
  const prefix = [...new Set(prependPath.filter(isAbsolute))];
  if (prefix.length === 0) return;
  // A shell adapter may prepend its own bin even when our shim was inherited.
  // Move managed entries to the front on every spawn, preserving the rest.
  const current = (existing ? existing.split(separator) : []).filter(
    (entry) => !prefix.includes(entry),
  );
  const nextPath = [...prefix, ...current].join(separator);
  // Windows env lookups are case-insensitive but the object keys are not:
  // overwrite whichever casing the inherited environment actually used.
  if (env.PATH === undefined && env.Path !== undefined) env.Path = nextPath;
  else env.PATH = nextPath;
}

/**
 * Minimal structural type of pi's `BashSpawnContext` — kept structural so
 * this module needs no dependency on the vendored pi packages.
 */
export interface BashSpawnContextLike {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Factory for a pi `createBashTool` spawnHook applying this sanitizer.
 * Used by the non-interactive bash spawn sites (background executor and
 * pi-turn-runner builtin fallback). The interactive LocalBashTool uses an
 * equivalent inline hook instead so it can also capture the removed variable
 * names for a one-time UX hint (`details.envSanitized`); the sanitizer applied
 * is identical — only the removed-name capture differs.
 */
export function createBashEnvSpawnHook(
  policy: BashEnvPolicySource,
  onSanitized?: (removed: string[]) => void,
): <T extends BashSpawnContextLike>(ctx: T) => T {
  return (ctx) => {
    const { env, removed } = sanitizeBashSubprocessEnv(ctx.env, policy);
    onSanitized?.(removed);
    return { ...ctx, env };
  };
}
