/**
 * Default maximum wall-clock lifetime for a desktop background bash task.
 */
export const DEFAULT_BACKGROUND_BASH_MAX_RUN_MS = 60 * 60 * 1000;
export const MAX_BACKGROUND_BASH_MAX_RUN_MS = 2_147_483_647;

/**
 * Keep the watchdog from undercutting a longer timeout explicitly requested by
 * the caller while still protecting forgotten tasks by default.
 */
export function resolveBackgroundBashMaxRunMs(timeoutSeconds?: number): number {
  const explicitMs = timeoutSeconds && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0;
  return Math.min(
    MAX_BACKGROUND_BASH_MAX_RUN_MS,
    Math.max(DEFAULT_BACKGROUND_BASH_MAX_RUN_MS, explicitMs),
  );
}

export function capBackgroundBashMaxRunMs(maxRunMs: number): number {
  const normalized = Number.isNaN(maxRunMs) ? DEFAULT_BACKGROUND_BASH_MAX_RUN_MS : maxRunMs;
  return Math.min(MAX_BACKGROUND_BASH_MAX_RUN_MS, Math.max(1, normalized));
}
