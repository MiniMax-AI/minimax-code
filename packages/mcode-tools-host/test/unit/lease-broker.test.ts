import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createNodeAuthLeaseClient } from '@mavis/oauth-lease-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startMcodeToolsAuthLeaseBroker } from '../../src/lease-broker.js';
import type {
  McodeToolsAccessTokenLease,
  McodeToolsAuthStatusSnapshot,
} from '../../src/contracts.js';

const cleanups: Array<() => Promise<void>> = [];

function lease(
  generation: number,
  expiresAtMs = Date.now() + 3_600_000,
): McodeToolsAccessTokenLease {
  return {
    accessToken: `synthetic-access-${generation}`,
    expiresAtMs,
    generation,
    audience: 'agent-backend',
    scopes: ['agent.default'],
  };
}

async function fixture(waitTimeoutMs?: number, now?: () => number) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mcode-broker-boundary-'));
  let status: McodeToolsAuthStatusSnapshot = { status: 'authenticated', generation: 1 };
  let listener: ((s: McodeToolsAuthStatusSnapshot) => void) | undefined;
  const messages: string[] = [];
  const session = {
    getStatus: vi.fn(async () => status),
    getAccessToken: vi.fn(async () => lease(status.generation)),
    handleUnauthorized: async () => 'retry' as const,
    watch: (fn: typeof listener) => {
      listener = fn;
      return () => {};
    },
  };
  const broker = await startMcodeToolsAuthLeaseBroker({
    dataDir,
    session,
    leaseWaitTimeoutMs: waitTimeoutMs,
    now,
    logger: { info: (m) => messages.push(m), warn: (m) => messages.push(m) },
  });
  const client = createNodeAuthLeaseClient({
    endpoint: broker.endpoint,
    capabilityFile: broker.capabilityFile,
  });
  cleanups.push(async () => {
    client.close();
    await broker.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    client,
    session,
    messages,
    setStatus: (s: McodeToolsAuthStatusSnapshot, notify = true) => {
      status = s;
      if (notify) listener?.(s);
    },
  };
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('mcode-tools auth lease broker', () => {
  it.each(['authenticated', 'refreshing', 'anonymous'] as const)(
    'rechecks a late refresh reservation against the shared %s state',
    async (status) => {
      const f = await fixture();
      f.setStatus({ status: 'authenticated', generation: 1 });
      f.setStatus({ status: 'refreshing', generation: 2 });
      // The late watcher snapshot is only a reservation; the shared state is authoritative.
      f.setStatus({ status, generation: status === 'authenticated' ? 1 : 2 }, false);
      f.session.getAccessToken.mockResolvedValue(lease(1));
      if (status === 'authenticated') {
        await expect(f.client.getLease(0)).resolves.toMatchObject({ generation: 1 });
      } else {
        await expect(f.client.getLease(0)).rejects.toMatchObject({ code: status === 'refreshing' ? 'BROKER_UNAVAILABLE' : 'AUTH_REQUIRED' });
      }
      expect(f.session.getStatus).toHaveBeenCalledOnce();
    },
  );

  it('rejects an old cached request when logout and login happen during its status read', async () => {
    const f = await fixture();
    await expect(f.client.getLease(0)).resolves.toMatchObject({ generation: 1 });
    let release!: () => void;
    const checking = new Promise<void>((resolve) => {
      f.session.getStatus.mockImplementationOnce(() => {
        resolve();
        return new Promise((r) => { release = () => r({ status: 'authenticated', generation: 3 }); });
      });
    });
    const oldRequest = f.client.getLease(0);
    await checking;
    f.setStatus({ status: 'anonymous', generation: 2 });
    f.setStatus({ status: 'authenticated', generation: 3 });
    f.session.getAccessToken.mockResolvedValue(lease(3));
    release();
    await expect(oldRequest).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(f.session.getAccessToken).toHaveBeenCalledOnce();
    await expect(f.client.getLease(0)).resolves.toMatchObject({ generation: 3 });
  });

  it.each(['anonymous', 'authenticated'] as const)(
    'rejects a shared lease invalidated by %s after validation but before its waiter resumes',
    async (status) => {
      const f = await fixture();
      f.session.getAccessToken.mockImplementation(async () => {
        // Deliver the watch after the Core/loadLease/validation promise steps,
        // before waitForLease releases the request waiting on that validated grant.
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
          f.setStatus({ status, generation: 2 });
        })));
        return lease(1);
      });
      await expect(f.client.getLease(0)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(f.session.getAccessToken).toHaveBeenCalledOnce();
    },
  );

  it('returns AUTH_REQUIRED when a confirmed invalid grant also failed local cleanup', async () => {
    const f = await fixture();
    f.setStatus({ status: 'anonymous', generation: 2 }, false);
    f.session.getAccessToken.mockRejectedValue(Object.assign(new Error('Authentication required'), {
      code: 'AUTH_REQUIRED',
      cause: Object.assign(new Error('Credential save failed'), {
        code: 'AUTH_CREDENTIAL_SAVE_FAILED', cause: { code: 'EPERM' },
      }),
    }));
    await expect(f.client.getLease(0)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(f.session.getAccessToken).toHaveBeenCalledOnce();
    expect(f.messages.join('\n')).toContain('"code":"EPERM"');
  });

  it.each(['refreshing', 'expired', 'error'] as const)(
    'preserves an I/O error during %s as a recoverable failure with original diagnostics',
    async (status) => {
      const f = await fixture();
      f.setStatus({ status, generation: 2 });
      const id = '11111111-1111-4111-8111-111111111111';
      const cause = Object.assign(new Error('do-not-log-refresh-secret /Users/private/auth.json'), {
        code: 'EPERM',
        errno: -4048,
        syscall: 'rename',
      });
      const error = Object.assign(new Error('credential save failed'), {
        code: 'AUTH_CREDENTIAL_SAVE_FAILED',
        cause,
        authDiagnostic: {
          correlationId: id,
          phase: 'commit_credentials',
          file: 'auth.json',
          generation: 2,
          retryCount: 3,
          refreshResponseSucceeded: true,
        },
      });
      f.session.getAccessToken.mockRejectedValue(error);
      await expect(f.client.getLease(0)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      const log = f.messages.find((m) => m.includes('request_failed'));
      expect(log).toContain(id);
      expect(log).toContain('"code":"EPERM"');
      expect(log).toContain('"authCode":"AUTH_CREDENTIAL_SAVE_FAILED"');
      expect(log).toContain('"errno":-4048');
      expect(log).toContain('"syscall":"rename"');
      expect(log).toContain('"retryCount":3');
      expect(log).toContain('"requestId":');
      expect(log).toContain(`"pid":${process.pid}`);
      expect(log).not.toMatch(/do-not-log|refresh-secret|\/Users\/|synthetic-access/u);
    },
  );

  it('does not turn a failed status read into AUTH_REQUIRED', async () => {
    const f = await fixture();
    f.session.getAccessToken.mockRejectedValue(
      Object.assign(new Error('I/O unavailable'), { code: 'EPERM' }),
    );
    f.session.getStatus.mockRejectedValue(new Error('status unavailable'));
    await expect(f.client.getLease(0)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('times out a waiter without cancelling the one in-flight credential request', async () => {
    const f = await fixture(50);
    let release!: (value: McodeToolsAccessTokenLease) => void;
    f.session.getAccessToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await expect(f.client.getLease(0)).rejects.toMatchObject({ code: 'BROKER_UNAVAILABLE' });
    expect(f.session.getAccessToken).toHaveBeenCalledTimes(1);
    const second = f.client.getLease(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.session.getAccessToken).toHaveBeenCalledTimes(1);
    f.setStatus({ status: 'authenticated', generation: 2 });
    release(lease(2));
    await expect(second).resolves.toMatchObject({ generation: 2 });
    expect(f.session.getAccessToken).toHaveBeenCalledTimes(1);
    expect(f.messages.join('\n')).toContain('AUTH_LEASE_WAIT_TIMEOUT');
  });

  it('does not reuse an old memory lease when another process refreshes before the watch fires', async () => {
    const f = await fixture();
    await expect(f.client.getLease(0)).resolves.toMatchObject({ generation: 1 });
    f.setStatus({ status: 'refreshing', generation: 2 }, false);
    await expect(f.client.getLease(0)).resolves.toMatchObject({ generation: 2 });
    expect(f.session.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('waits for the same in-flight commit even when a request could use an older shorter lease', async () => {
    const f = await fixture();
    f.session.getAccessToken.mockResolvedValueOnce(lease(1, Date.now() + 5_000));
    await f.client.getLease(0);
    let release!: (value: McodeToolsAccessTokenLease) => void;
    const entered = new Promise<void>((resolve) => {
      f.session.getAccessToken.mockImplementation(() => {
        resolve();
        return new Promise((r) => {
          release = r;
        });
      });
    });
    const first = f.client.getLease(30_000);
    await entered;
    let settled = false;
    const second = f.client.getLease(0).then((v) => {
      settled = true;
      return v;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    f.setStatus({ status: 'authenticated', generation: 2 });
    release(lease(2));
    const leases = await Promise.all([first, second]);
    expect(leases.map((v) => v.generation)).toEqual([2, 2]);
    expect(f.session.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('joins a refresh started while an older cached status snapshot is pending', async () => {
    const f = await fixture();
    f.session.getAccessToken.mockResolvedValueOnce(lease(1, Date.now() + 5_000));
    await f.client.getLease(0);
    let releaseStatus!: () => void;
    const checkingStatus = new Promise<void>((resolve) => {
      f.session.getStatus.mockImplementationOnce(() => {
        resolve();
        return new Promise((r) => { releaseStatus = () => r({ status: 'authenticated', generation: 1 }); });
      });
    });
    let lowSettled = false;
    const low = f.client.getLease(0).then((value) => { lowSettled = true; return value; });
    await checkingStatus;
    let releaseLease!: () => void;
    const refreshing = new Promise<void>((resolve) => {
      f.session.getAccessToken.mockImplementationOnce(() => {
        resolve();
        return new Promise((r) => { releaseLease = () => r(lease(2)); });
      });
    });
    const high = f.client.getLease(30_000);
    await refreshing;
    releaseStatus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lowSettled).toBe(false);
    releaseLease();
    const result = await Promise.all([low, high]);
    expect(result.map((value) => value.generation)).toEqual([2, 2]);
    expect(f.session.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    'gives a stricter waiter one bounded acquisition after sharing an existing shorter token (sufficient=%s)',
    async (sufficient) => {
      const f = await fixture();
      let release!: (value: McodeToolsAccessTokenLease) => void;
      const entered = new Promise<void>((resolve) => {
        f.session.getAccessToken.mockImplementationOnce(() => {
          resolve();
          return new Promise((r) => { release = r; });
        });
      });
      const first = f.client.getLease(0);
      await entered;
      const stricter = f.client.getLease(30_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.session.getAccessToken).toHaveBeenCalledTimes(1);
      f.session.getAccessToken.mockResolvedValue(lease(2, Date.now() + (sufficient ? 3_600_000 : 1_000)));
      release(lease(1, Date.now() + 20_000));
      if (sufficient) await expect(stricter).resolves.toMatchObject({ generation: 2 });
      else await expect(stricter).rejects.toMatchObject({ code: 'BROKER_UNAVAILABLE' });
      await expect(first).resolves.toMatchObject({ generation: 1 });
      expect(f.session.getAccessToken).toHaveBeenCalledTimes(2);
      expect(f.session.getAccessToken).toHaveBeenNthCalledWith(1, 0);
      expect(f.session.getAccessToken).toHaveBeenNthCalledWith(2, 30_000);
    },
  );

  it('rechecks cached validity after the asynchronous shared-state read', async () => {
    let now = Date.now();
    const f = await fixture(undefined, () => now);
    f.session.getAccessToken.mockResolvedValueOnce(lease(1, now + 31_000));
    await f.client.getLease(0);
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      f.session.getStatus.mockImplementationOnce(() => {
        resolve();
        return new Promise((r) => {
          release = () => r({ status: 'authenticated', generation: 1 });
        });
      });
    });
    f.session.getAccessToken.mockResolvedValue(lease(2, now + 3_600_000));
    const request = f.client.getLease(30_000);
    await entered;
    now += 2_000;
    release();
    await expect(request).resolves.toMatchObject({ generation: 2 });
    expect(f.session.getAccessToken).toHaveBeenCalledTimes(2);
    expect(f.session.getAccessToken).toHaveBeenLastCalledWith(30_000);
  });

  it('allows the prior committed generation after a transient refresh rolls back its reservation', async () => {
    const f = await fixture();
    f.setStatus({ status: 'refreshing', generation: 2 });
    f.session.getAccessToken.mockRejectedValueOnce(new TypeError('offline'));
    await expect(f.client.getLease(0)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    f.setStatus({ status: 'authenticated', generation: 1 });
    await expect(f.client.getLease(0)).resolves.toMatchObject({ generation: 1 });
  });

  it('does not spin or request another refresh when a new lease cannot satisfy minimum validity', async () => {
    const f = await fixture();
    f.session.getAccessToken.mockResolvedValue(lease(2, Date.now() + 1_000));
    await expect(f.client.getLease(30_000)).rejects.toMatchObject({ code: 'BROKER_UNAVAILABLE' });
    expect(f.session.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('serves fixed leases and removes the private capability on dispose', async () => {
    const dataDir = await mkdtemp(path.join('/tmp', 'mcode-tools-host-broker-'));
    const stopWatching = vi.fn();
    const broker = await startMcodeToolsAuthLeaseBroker({
      dataDir,
      session: {
        getStatus: async () => ({ status: 'authenticated', generation: 3 }),
        getAccessToken: async () => ({
          accessToken: 'at-3',
          expiresAtMs: Date.now() + 120_000,
          generation: 3,
          audience: 'agent-backend',
          scopes: ['agent.default'],
        }),
        handleUnauthorized: async () => 'retry',
        watch: () => stopWatching,
      },
    });
    cleanups.push(() => broker.dispose());
    const client = createNodeAuthLeaseClient({
      endpoint: broker.endpoint,
      capabilityFile: broker.capabilityFile,
    });
    cleanups.push(async () => client.close());

    await expect(client.getLease(30_000)).resolves.toMatchObject({
      accessToken: 'at-3',
      generation: 3,
      audience: 'agent-backend',
      scopes: ['agent.default'],
    });
    expect((await readFile(broker.capabilityFile, 'utf8')).trim()).toHaveLength(43);
    if (process.platform !== 'win32') {
      expect((await stat(broker.capabilityFile)).mode & 0o777).toBe(0o600);
    }

    await broker.dispose();
    await expect(stat(broker.capabilityFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stopWatching).toHaveBeenCalledOnce();
  });

  it('rejects a lease outside the fixed audience contract', async () => {
    const dataDir = await mkdtemp(path.join('/tmp', 'mcode-tools-host-broker-'));
    const broker = await startMcodeToolsAuthLeaseBroker({
      dataDir,
      session: {
        getStatus: async () => ({ status: 'authenticated', generation: 1 }),
        getAccessToken: async () => ({
          accessToken: 'wrong-at',
          expiresAtMs: Date.now() + 120_000,
          generation: 1,
          audience: 'wrong-audience' as 'agent-backend',
          scopes: ['agent.default'],
        }),
        handleUnauthorized: async () => 'logout',
        watch: () => () => undefined,
      },
    });
    cleanups.push(() => broker.dispose());
    const client = createNodeAuthLeaseClient({
      endpoint: broker.endpoint,
      capabilityFile: broker.capabilityFile,
    });
    cleanups.push(async () => client.close());

    await expect(client.getLease(30_000)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
