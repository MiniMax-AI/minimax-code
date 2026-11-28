import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { isPidAlive } from '@mavis/shared';

import { PRIVATE_CONFIG_FILE_MODE } from './private-config-file.js';

/**
 * A short synchronous cross-process lock. getConfig() is synchronous, so neither
 * the async proper-lockfile used for config.yaml writes nor the async migration
 * lock in @mavis/shared can be used; this follows the migration lock's
 * conventions instead (local-runtime-migration-lock.ts; both use the shared
 * isPidAlive): the lock names its holder (pid and a random token), a holder
 * counts as alive while its pid is, a reclaim happens under a guard file
 * after re-checking that the lock is unchanged, and a holder removes only its
 * own lock. A holder keeps the lock for one small read and write, so it needs
 * no heartbeat; a holder suspended past LIVE_HOLDER_STALE_MS can tell from
 * `stillHeld()` that it lost the lock. Every wait, the guard's on reclaim and on
 * release included, ends at one deadline WAIT_MS after the call began: a lock
 * that cannot be read or reclaimed only costs one skipped write, never a hung
 * getConfig().
 */

/** Four processes writing at the same moment take ~60ms at worst (measured). */
const WAIT_MS = 200;
const POLL_MS = 5;
/** A lock without a readable holder was cut short between creation and its first write. */
const UNNAMED_STALE_MS = 10_000;
/**
 * A live pid may belong to an unrelated process: Windows reuses pids quickly.
 * A real holder needs microseconds, and one suspended this long re-checks
 * `stillHeld()` before it writes.
 */
const LIVE_HOLDER_STALE_MS = 30_000;
/** Reclaimers hold the guard for microseconds; an older guard belongs to a crashed one. */
const GUARD_STALE_MS = 30_000;

export interface StateLockPaths {
  lockPath: string;
  /** Held while a lock is reclaimed or released, so no two of them interleave. */
  guardPath: string;
}

export interface HeldStateLock {
  /** Whether the lock still names this holder; check right before writing. */
  stillHeld(): boolean;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

type LockSighting =
  | { kind: 'gone' }
  /** Present but unreadable (another user's file, a directory): treated as held. */
  | { kind: 'unreadable' }
  | { kind: 'held'; holder: string; mtimeMs: number };

function inspectLock(lockPath: string): LockSighting {
  try {
    const { mtimeMs } = fs.statSync(lockPath);
    return { kind: 'held', holder: fs.readFileSync(lockPath, 'utf8'), mtimeMs };
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
      ? { kind: 'gone' }
      : { kind: 'unreadable' };
  }
}

function holderOf(lockPath: string): string | undefined {
  const sighting = inspectLock(lockPath);
  return sighting.kind === 'held' ? sighting.holder : undefined;
}

function isAbandoned(
  sighting: Extract<LockSighting, { kind: 'held' }>,
  alive: (pid: number) => boolean,
): boolean {
  const age = Date.now() - sighting.mtimeMs;
  const pid = /^(\d+) \S+$/.exec(sighting.holder)?.[1];
  if (pid === undefined) return age > UNNAMED_STALE_MS;
  return !alive(Number(pid)) || age > LIVE_HOLDER_STALE_MS;
}

/** The guard names its holder like the lock does, so only that holder removes it. */
function acquireGuard(guardPath: string, deadline: number): number | undefined {
  for (;;) {
    try {
      return fs.openSync(guardPath, 'wx', PRIVATE_CONFIG_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') return undefined;
      const guard = inspectLock(guardPath);
      if (guard.kind === 'held' && Date.now() - guard.mtimeMs > GUARD_STALE_MS) {
        fs.rmSync(guardPath, { force: true });
      }
      if (Date.now() >= deadline) return undefined;
      sleep(POLL_MS);
    }
  }
}

function underGuard(guardPath: string, deadline: number, action: () => void): boolean {
  const guard = acquireGuard(guardPath, deadline);
  if (guard === undefined) return false;
  const token = `${process.pid} ${randomUUID()}`;
  try {
    fs.writeSync(guard, token);
    action();
  } finally {
    fs.closeSync(guard);
    // A guard reclaimed as stale (this holder was suspended) now belongs to
    // its reclaimer; leave it to them.
    if (holderOf(guardPath) === token) fs.rmSync(guardPath, { force: true });
  }
  return true;
}

/** Removes the lock only if it is still exactly the abandoned one that was seen. */
function reclaimIfAbandoned(
  paths: StateLockPaths,
  deadline: number,
  alive: (pid: number) => boolean,
): boolean {
  const seen = inspectLock(paths.lockPath);
  // Released meanwhile: try to create it again.
  if (seen.kind === 'gone') return true;
  if (seen.kind === 'unreadable' || !isAbandoned(seen, alive)) return false;
  let removed = false;
  underGuard(paths.guardPath, deadline, () => {
    const now = inspectLock(paths.lockPath);
    if (now.kind === 'held' && now.holder === seen.holder && now.mtimeMs === seen.mtimeMs) {
      fs.rmSync(paths.lockPath, { force: true });
      removed = true;
    }
  });
  return removed;
}

/** Backdates this holder's file through its own descriptor so a waiter reclaims it at once. */
function markAbandoned(fd: number): void {
  try {
    fs.futimesSync(fd, 0, 0);
  } catch {
    // It then expires like any abandoned lock.
  }
}

/** Shares the call's deadline; a release that cannot get the guard in time backdates its lock. */
function release(paths: StateLockPaths, fd: number, token: string, deadline: number): void {
  try {
    const released = underGuard(paths.guardPath, deadline, () => {
      if (holderOf(paths.lockPath) === token) {
        fs.rmSync(paths.lockPath, { force: true });
      }
    });
    if (!released) markAbandoned(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Runs `update` while holding the lock. Returns false without running it when
 * the lock stays busy for WAIT_MS or cannot be created.
 */
export function withStateLockSync(
  paths: StateLockPaths,
  update: (lock: HeldStateLock) => void,
  alive: (pid: number) => boolean = isPidAlive,
): boolean {
  const token = `${process.pid} ${randomUUID()}`;
  const deadline = Date.now() + WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(paths.lockPath, 'wx', PRIVATE_CONFIG_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') return false;
      // Checked before every retry, so no path through here can spin.
      if (Date.now() >= deadline) return false;
      if (reclaimIfAbandoned(paths, deadline, alive)) continue;
      sleep(POLL_MS);
    }
  }
  try {
    fs.writeSync(fd, token);
  } catch {
    markAbandoned(fd);
    fs.closeSync(fd);
    return false;
  }
  try {
    update({ stillHeld: () => holderOf(paths.lockPath) === token });
    return true;
  } finally {
    release(paths, fd, token, deadline);
  }
}
