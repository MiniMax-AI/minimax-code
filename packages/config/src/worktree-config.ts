export const DEFAULT_WORKTREE_KEEP_COUNT = 15;

/** Worktree creation and background cleanup settings. */
export interface WorktreeConfig {
  /** Fetch the selected upstream before creating a new worktree. */
  worktreeRefreshBeforeCreate: boolean;
  /** Automatically remove the oldest unprotected local worktrees in the background. */
  worktreeAutoCleanupEnabled: boolean;
  /** Number of recently used unprotected worktrees kept in total when auto cleanup runs (min 1). */
  worktreeKeepCount: number;
}

/** A keep count is a positive safe integer; the same rule validates writes and reads. */
export function isWorktreeKeepCount(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1;
}

/** Invalid or non-positive values fall back to the default keep count. */
export function parseWorktreeKeepCount(raw: unknown): number {
  return isWorktreeKeepCount(raw) ? raw : DEFAULT_WORKTREE_KEEP_COUNT;
}

/** Missing keys resolve to the defaults: refresh on, cleanup off, keep 15. */
export function parseWorktreeConfig(raw: Record<string, unknown>): WorktreeConfig {
  return {
    worktreeRefreshBeforeCreate: raw.worktreeRefreshBeforeCreate !== false,
    worktreeAutoCleanupEnabled: raw.worktreeAutoCleanupEnabled === true,
    worktreeKeepCount: parseWorktreeKeepCount(raw.worktreeKeepCount),
  };
}
