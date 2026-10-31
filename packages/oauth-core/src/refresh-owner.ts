import { performance } from 'node:perf_hooks';

export interface RefreshOwner {
  pid: number;
  startedAtMs: number;
}

const owner: RefreshOwner = {
  pid: process.pid,
  startedAtMs: Math.trunc(performance.timeOrigin),
};

export function currentRefreshOwner(): RefreshOwner {
  return { ...owner };
}

/** Unknown/foreign reused PIDs stay live; only positive evidence may discard a grant. */
export function isRefreshOwnerAlive(candidate: RefreshOwner | undefined): boolean {
  if (!candidate) return true; // Intermediate development builds wrote fences without an owner.
  if (candidate.pid === owner.pid) return candidate.startedAtMs === owner.startedAtMs;
  try {
    process.kill(candidate.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
