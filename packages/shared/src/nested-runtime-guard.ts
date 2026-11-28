/**
 * Nested MiniMax Code guard — a trusted one-hop parent marker that makes MCode
 * refuse to start an embedded Runtime from a `delete_guard` managed Bash.
 *
 * `delete_guard` permits writes outside the workspace but denies unlink,
 * rmdir, and rename-source there. A nested Runtime can therefore create lock
 * and ownership files in whichever data directory it resolves, but may be
 * unable to remove them. The danger is not limited to reusing the parent
 * Runtime's data directory: a custom-profile parent can spawn a child that
 * falls back to the default data directory and poison that directory instead.
 * For that reason the guard rejects every nested Runtime start under the
 * effective `delete_guard` mode. Direct terminal starts remain unchanged
 * because they do not receive the marker.
 *
 * Trust model: the marker uses the `__MAVIS_PARENT_` prefix, which
 * `runtime-boundary-env.ts` strips at every Runtime-owned spawn boundary.
 * Only the managed Bash spawn seam re-injects it after that strip, so an
 * inherited or hand-exported value cannot forge the trusted parent state.
 *
 * @module
 */

import { translateRuntimeText } from './runtime-i18n/index.js';

/** Present only in a managed Bash child whose effective mode is `delete_guard`. */
export const NESTED_RUNTIME_DELETE_GUARD_ENV = '__MAVIS_PARENT_DELETE_GUARD';

/** Stable machine-readable reason for product and CLI presentation layers. */
export const NESTED_RUNTIME_DELETE_GUARD_ERROR_CODE = 'NESTED_RUNTIME_DELETE_GUARD';

/** Thrown before any embedded Runtime state or ownership artifact is created. */
export class NestedRuntimeUnsupportedError extends Error {
  readonly code = NESTED_RUNTIME_DELETE_GUARD_ERROR_CODE;

  constructor(locale?: string | null) {
    super(translateRuntimeText(locale, 'nestedRuntime.deleteGuard'));
    this.name = 'NestedRuntimeUnsupportedError';
  }
}

/** Parent side: build the trusted marker injected after boundary sanitization. */
export function nestedRuntimeGuardEnv(): Record<string, string> {
  return { [NESTED_RUNTIME_DELETE_GUARD_ENV]: '1' };
}

/**
 * Child side: fail before Runtime Host, storage lock, owner lease, generation
 * fence, or config lock construction. No marker means a direct terminal start
 * or a parent invocation whose effective filesystem mode is not delete_guard.
 */
export function assertNestedRuntimeAllowed(
  env: NodeJS.ProcessEnv = process.env,
  locale: string | null | undefined = resolveNestedRuntimeLocale(env),
): void {
  if (env[NESTED_RUNTIME_DELETE_GUARD_ENV]?.trim() !== '1') return;
  throw new NestedRuntimeUnsupportedError(locale);
}

function resolveNestedRuntimeLocale(env: NodeJS.ProcessEnv): string | undefined {
  return (
    env.LC_ALL?.trim() ||
    env.LC_MESSAGES?.trim() ||
    env.LANG?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().locale
  );
}
