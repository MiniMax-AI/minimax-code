import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentRefreshOwner, isRefreshOwnerAlive } from '../../src/refresh-owner.js';

afterEach(() => vi.restoreAllMocks());

describe('refresh owner identity', () => {
  it('distinguishes the current process from an earlier process with the same PID', () => {
    const owner = currentRefreshOwner();
    expect(isRefreshOwnerAlive(owner)).toBe(true);
    expect(isRefreshOwnerAlive({ ...owner, startedAtMs: owner.startedAtMs - 1_000 })).toBe(false);
  });

  it.each(['ESRCH', 'EPERM', 'EACCES'])(
    'only treats a foreign PID as dead on ESRCH (probe=%s)',
    (code) => {
      const owner = { ...currentRefreshOwner(), pid: process.pid + 1 };
      vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('probe failed'), { code }); });
      expect(isRefreshOwnerAlive(owner)).toBe(code !== 'ESRCH');
    },
  );

  it('keeps a live foreign PID or an older fence with no owner recoverable', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(isRefreshOwnerAlive({ ...currentRefreshOwner(), pid: process.pid + 1 })).toBe(true);
    expect(isRefreshOwnerAlive(undefined)).toBe(true);
  });
});
