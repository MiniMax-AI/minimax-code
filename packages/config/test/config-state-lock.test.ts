import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withStateLockSync, type StateLockPaths } from '../src/config-state-lock.js';

let dir: string;
let paths: StateLockPaths;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-state-lock-'));
  paths = { lockPath: path.join(dir, 'state.lock'), guardPath: path.join(dir, 'state.lock.reclaim') };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const alive = () => true;
const dead = () => false;

function holdBy(holder: string, ageMs = 0): void {
  fs.writeFileSync(paths.lockPath, holder);
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(paths.lockPath, at, at);
}

describe('config state lock', () => {
  it('names its holder while held and leaves nothing behind', () => {
    let seen = '';
    expect(
      withStateLockSync(paths, (lock) => {
        seen = fs.readFileSync(paths.lockPath, 'utf8');
        expect(lock.stillHeld()).toBe(true);
      }),
    ).toBe(true);
    expect(seen).toMatch(new RegExp(`^${process.pid} \\S+$`));
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('waits out a live holder instead of taking its lock', () => {
    // Older than a crashed creation, but the holder's pid is alive.
    holdBy('4242 token', 20_000);
    let ran = false;
    expect(withStateLockSync(paths, () => (ran = true), alive)).toBe(false);
    expect(ran).toBe(false);
    expect(fs.readFileSync(paths.lockPath, 'utf8')).toBe('4242 token');
  });

  it('reclaims a lock whose holder died, at once', () => {
    holdBy('4242 token');
    let ran = false;
    expect(withStateLockSync(paths, () => (ran = true), dead)).toBe(true);
    expect(ran).toBe(true);
    expect(fs.existsSync(paths.lockPath)).toBe(false);
  });

  it('reclaims a live pid only after a holder could not still be running', () => {
    holdBy('4242 token', 10 * 60_000);
    expect(withStateLockSync(paths, () => {}, alive)).toBe(true);
  });

  it('does not remove a lock that a reclaimer handed to another holder', () => {
    expect(
      withStateLockSync(paths, (lock) => {
        // Suspended long enough to be reclaimed; the new holder takes over.
        holdBy('4343 successor');
        expect(lock.stillHeld()).toBe(false);
      }),
    ).toBe(true);
    expect(fs.readFileSync(paths.lockPath, 'utf8')).toBe('4343 successor');
  });

  function givesUpWithinTheWait(): void {
    const startedAt = Date.now();
    expect(withStateLockSync(paths, () => {}, dead)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }

  it('gives up within the wait when the lock is a directory', () => {
    fs.mkdirSync(paths.lockPath);
    givesUpWithinTheWait();
  });

  it('gives up within the wait when the lock cannot be read', () => {
    holdBy('4242 token');
    // Another user's owner-only file; chmod alone does not stop a root runner.
    const read = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (file === paths.lockPath) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return (read as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    givesUpWithinTheWait();
    expect(fs.existsSync(paths.lockPath)).toBe(true);
  });

  it('keeps one wait for the whole call when the guard is busy at release', () => {
    const startedAt = Date.now();
    expect(
      withStateLockSync(paths, () => {
        // A slow update, then another process takes the guard.
        while (Date.now() - startedAt < 150) {
          // busy
        }
        fs.writeFileSync(paths.guardPath, '');
      }),
    ).toBe(true);
    // Release gives up at the call's deadline instead of starting a new wait.
    expect(Date.now() - startedAt).toBeLessThan(300);
    fs.rmSync(paths.guardPath);
    // The lock it could not remove is backdated, so the next caller takes it at once.
    const next = Date.now();
    expect(withStateLockSync(paths, () => {}, alive)).toBe(true);
    expect(Date.now() - next).toBeLessThan(100);
  });

  it('never removes a guard that a reclaimer took over from it', () => {
    holdBy('4242 token');
    const rm = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      // While this process holds the guard to reclaim the dead holder's lock, it
      // is suspended past the guard's age limit and another process takes over.
      if (target === paths.lockPath) fs.writeFileSync(paths.guardPath, '4343 reclaimer');
      return (rm as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.rmSync);
    withStateLockSync(paths, () => {}, dead);
    vi.restoreAllMocks();
    expect(fs.readFileSync(paths.guardPath, 'utf8')).toBe('4343 reclaimer');
  });

  it('leaves a busy guard alone and gives up after the wait', () => {
    holdBy('4242 token');
    fs.writeFileSync(paths.guardPath, '');
    expect(withStateLockSync(paths, () => {}, dead)).toBe(false);
    expect(fs.readFileSync(paths.lockPath, 'utf8')).toBe('4242 token');
  });
});
