import { afterEach, describe, expect, it, vi } from 'vitest';

const watcher = vi.hoisted(() => ({ onChange: undefined as (() => void) | undefined }));
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  watchFile: (_path: string, _options: unknown, listener: () => void) => { watcher.onChange = listener; },
  unwatchFile: () => { watcher.onChange = undefined; },
}));

import type { AuthStatusSnapshot } from '../../src/auth-core.js';
import { createLocalAuthFixture } from '../helpers/local-auth.js';

function deferredStatus() {
  let resolve!: (value: AuthStatusSnapshot) => void;
  const promise = new Promise<AuthStatusSnapshot>((r) => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe('shared auth status watch', () => {
  it('does not publish a late refresh snapshot after a newer rollback observation', async () => {
    const f = await createLocalAuthFixture();
    const core = f.createCore();
    const refresh = deferredStatus();
    const rollback = deferredStatus();
    vi.spyOn(core, 'getStatus').mockReturnValueOnce(refresh.promise).mockReturnValueOnce(rollback.promise);
    const observed = vi.fn();
    const stop = core.watch(observed);
    try {
      watcher.onChange?.();
      watcher.onChange?.();
      rollback.resolve({ status: 'authenticated', generation: 1, scopes: ['agent.default'] });
      await Promise.resolve();
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ status: 'authenticated', generation: 1 }));
      refresh.resolve({ status: 'refreshing', generation: 2, scopes: ['agent.default'] });
      await Promise.resolve();
      expect(observed).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      await f.cleanup();
    }
  });

  it('does not notify a subscriber after it stops watching an outstanding observation', async () => {
    const f = await createLocalAuthFixture();
    const core = f.createCore();
    const pending = deferredStatus();
    vi.spyOn(core, 'getStatus').mockReturnValueOnce(pending.promise);
    const observed = vi.fn();
    const stop = core.watch(observed);
    try {
      watcher.onChange?.();
      stop();
      pending.resolve({ status: 'anonymous', generation: 2, scopes: [] });
      await Promise.resolve();
      expect(observed).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
});
