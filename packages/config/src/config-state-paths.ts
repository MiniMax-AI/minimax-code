import { isPrivateTemporaryNameFor } from './private-config-file.js';

/**
 * Files next to config.yaml that record its lifecycle. They hold no config
 * content and must not make a data directory look like it holds user data.
 */
export const CONFIG_STATE_FILE = '.config-state.json';
/** Held while one process reads and rewrites CONFIG_STATE_FILE. */
export const CONFIG_STATE_LOCK_FILE = '.config-state.json.lock';
/** Held for an instant while a stale lock is reclaimed or a lock is released. */
export const CONFIG_STATE_LOCK_GUARD_FILE = '.config-state.json.lock.reclaim';
export const CONFIG_RESET_PENDING_FILE = '.config-reset-pending';

/** Markers that describe the data dir's config.yaml and must survive a data-dir migration. */
export const CARRIED_CONFIG_STATE_FILES = [CONFIG_STATE_FILE, CONFIG_RESET_PENDING_FILE] as const;

export function isConfigStateEntry(name: string): boolean {
  return (
    name === CONFIG_STATE_FILE ||
    name === CONFIG_STATE_LOCK_FILE ||
    name === CONFIG_STATE_LOCK_GUARD_FILE ||
    name === CONFIG_RESET_PENDING_FILE ||
    isPrivateTemporaryNameFor(name, CONFIG_STATE_FILE)
  );
}
