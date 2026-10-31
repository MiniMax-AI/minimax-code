/**
 * Regression tests for `McpConnectionPool.callTool` abort propagation.
 *
 * The `image_synthesize` production hang was caused by the pool never
 * forwarding the caller's AbortSignal into the SDK's `client.callTool`, so
 * an in-flight remote HTTP request sat until the per-server timeout (up to
 * 10 min for generation tools) instead of being cancelled the moment the pi
 * turn aborted.
 *
 * We inject a fake `Client` via a stubbed `ResolvedMcpServer` lookup so we
 * can observe the exact `RequestOptions` the pool hands to
 * `client.callTool(...)` without spinning up any transport.
 */
import { describe, expect, it } from 'vitest';

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { describeMcpCallError } from '../src/runtime/call-error.js';
import {
  McpConnectionPool,
  McpToolCallNotDispatchedError,
  McpToolCallTimeoutError,
} from '../src/runtime/connection-pool.js';
import type {
  McpConnection,
  McpToolCallResult,
  McpToolInfo,
  ResolvedMcpServer,
} from '../src/runtime/types.js';

interface RecordedCall {
  readonly toolName: string;
  readonly options?: { timeout?: number; signal?: AbortSignal };
}

interface RecordedList {
  readonly options?: { timeout?: number; signal?: AbortSignal };
}

function seedFakeListConnection(
  pool: McpConnectionPool,
  serverName: string,
  behaviour: (options?: { timeout?: number; signal?: AbortSignal }) => Promise<{ tools: McpToolInfo[] }>,
  recorded: RecordedList[],
): void {
  const fakeClient = {
    async listTools(
      _params: undefined,
      options?: { timeout?: number; signal?: AbortSignal },
    ): Promise<{ tools: McpToolInfo[] }> {
      recorded.push({ options });
      return behaviour(options);
    },
    async close(): Promise<void> {},
  };
  const connection: McpConnection = {
    key: JSON.stringify([serverName, null]),
    name: serverName,
    state: 'connected',
    client: fakeClient as unknown as McpConnection['client'],
    transport: null,
    tools: null,
    lastUsed: Date.now(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).connections.set(connection.key, connection);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).connectionServerNames.set(connection.key, serverName);
}

/**
 * Wire a stub connection into the pool that captures each `callTool`'s
 * options. The pool normally spawns a real Client via `doConnect`; we
 * bypass that by pre-populating `pool.connections` and short-circuiting
 * `ensureConnection`, avoiding any transport dependency.
 */
function seedFakeConnection(
  pool: McpConnectionPool,
  serverName: string,
  behaviour: (options?: { timeout?: number; signal?: AbortSignal }) => Promise<McpToolCallResult>,
  recorded: RecordedCall[],
): void {
  const fakeClient = {
    async callTool(
      params: { name: string; arguments: Record<string, unknown> },
      _resultSchema: unknown,
      options?: { timeout?: number; signal?: AbortSignal },
    ): Promise<McpToolCallResult> {
      recorded.push({ toolName: params.name, options });
      return behaviour(options);
    },
    async close(): Promise<void> {},
  };
  const connection: McpConnection = {
    key: JSON.stringify([serverName, null]),
    name: serverName,
    state: 'connected',
    client: fakeClient as unknown as McpConnection['client'],
    transport: null,
    tools: [] as McpToolInfo[],
    lastUsed: Date.now(),
  };
  // The pool exposes its private state through `disconnect(serverName)`
  // bookkeeping and `getStats`; we set the connection directly here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).connections.set(connection.key, connection);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).connectionServerNames.set(connection.key, serverName);
}

function stubLookup(server: ResolvedMcpServer): { getResolvedServer: () => ResolvedMcpServer } {
  return { getResolvedServer: () => server };
}

describe('McpConnectionPool.listTools — abort propagation', () => {
  it('forwards the caller signal and releases the permit when tools/list aborts', async () => {
    const server: ResolvedMcpServer = {
      name: 'broken',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
      timeout: 60_000,
    };
    const pool = new McpConnectionPool(stubLookup(server), { maxConcurrency: 1 });
    const recorded: RecordedList[] = [];
    seedFakeListConnection(
      pool,
      'broken',
      (options) =>
        new Promise<{ tools: McpToolInfo[] }>((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(new Error('Request aborted'));
            return;
          }
          signal?.addEventListener('abort', () => reject(new Error('Request aborted')), {
            once: true,
          });
        }),
      recorded,
    );

    const controller = new AbortController();
    const discovery = pool.listTools('broken', undefined, {
      signal: controller.signal,
      timeout: 60_000,
    });
    await Promise.resolve();
    expect(pool.getStats('broken').active).toBe(1);
    controller.abort();

    await expect(discovery).rejects.toThrow(/Request aborted/);
    expect(recorded[0]?.options?.signal).toBe(controller.signal);
    expect(recorded[0]?.options?.timeout).toBe(60_000);
    expect(pool.getStats('broken')).toMatchObject({ active: 0, pending: 0 });

    await pool.shutdown();
  });

  it('removes an aborted discovery waiter from the semaphore queue', async () => {
    const server: ResolvedMcpServer = {
      name: 'broken',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
      timeout: 60_000,
    };
    const pool = new McpConnectionPool(stubLookup(server), { maxConcurrency: 1 });
    const recorded: RecordedList[] = [];
    let releaseHead: (() => void) | undefined;
    seedFakeListConnection(
      pool,
      'broken',
      () =>
        new Promise<{ tools: McpToolInfo[] }>((resolve) => {
          releaseHead = () => resolve({ tools: [] });
        }),
      recorded,
    );

    const head = pool.listTools('broken', undefined, { timeout: 60_000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(pool.getStats('broken').active).toBe(1);

    const controller = new AbortController();
    const queued = pool.listTools('broken', undefined, {
      signal: controller.signal,
      timeout: 60_000,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(pool.getStats('broken').pending).toBe(1);

    controller.abort();
    await expect(queued).rejects.toThrow(/aborted before dispatch/);
    expect(pool.getStats('broken')).toMatchObject({ active: 1, pending: 0 });
    expect(recorded).toHaveLength(1);

    releaseHead?.();
    await head;
    expect(pool.getStats('broken')).toMatchObject({ active: 0, pending: 0 });

    await pool.shutdown();
  });

  it('aborts an in-flight connect during disconnect and rejects its waiter promptly', async () => {
    const server: ResolvedMcpServer = {
      name: 'broken',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
    };
    const pool = new McpConnectionPool(stubLookup(server));
    let connectSignal: AbortSignal | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).doConnect = async (
      _serverName: string,
      _connectionKey: string,
      _overrides: unknown,
      _timeoutMs: number,
      signal: AbortSignal,
    ) => {
      connectSignal = signal;
      return new Promise<McpConnection>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('connect aborted')), { once: true });
      });
    };

    const discovery = pool.listTools('broken');
    await Promise.resolve();
    await Promise.resolve();
    expect(connectSignal?.aborted).toBe(false);

    await pool.disconnect('broken');
    expect(connectSignal?.aborted).toBe(true);
    await expect(discovery).rejects.toThrow(/connect aborted/);
    expect(pool.getStats('broken')).toMatchObject({ active: 0, pending: 0 });
  });

  it('does not let a stale connect cleanup remove a newer pending connect', async () => {
    const server: ResolvedMcpServer = {
      name: 'broken',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
    };
    const pool = new McpConnectionPool(stubLookup(server), { maxConcurrency: 2 });
    const attempts: Array<{
      resolve: (connection: McpConnection) => void;
      reject: (error: Error) => void;
    }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).doConnect = async () =>
      new Promise<McpConnection>((resolve, reject) => {
        attempts.push({ resolve, reject });
      });

    const first = pool.listTools('broken');
    await Promise.resolve();
    await Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstPending = (pool as any).connectingPromises.get(JSON.stringify(['broken', null]));
    expect(firstPending).toBeDefined();

    await pool.disconnect('broken');
    const secondController = new AbortController();
    const second = pool.listTools('broken', undefined, { signal: secondController.signal });
    await Promise.resolve();
    await Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondPending = (pool as any).connectingPromises.get(JSON.stringify(['broken', null]));
    expect(secondPending).toBeDefined();
    expect(secondPending).not.toBe(firstPending);

    attempts[0]?.reject(new Error('stale connect failed'));
    await expect(first).rejects.toThrow(/stale connect failed/);
    await Promise.resolve();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((pool as any).connectingPromises.get(JSON.stringify(['broken', null]))).toBe(secondPending);

    secondController.abort();
    await expect(second).rejects.toThrow(/connection wait aborted/);
  });
});

describe('McpConnectionPool.callTool — abort propagation', () => {
  it('forwards options.signal to client.callTool', async () => {
    const server: ResolvedMcpServer = {
      name: 'matrix',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
    };
    const pool = new McpConnectionPool(stubLookup(server));
    const recorded: RecordedCall[] = [];
    seedFakeConnection(
      pool,
      'matrix',
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      recorded,
    );

    const controller = new AbortController();
    await pool.callTool('matrix', 'image_synthesize', { prompt: 'x' }, undefined, {
      signal: controller.signal,
      timeout: 5_000,
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.options?.signal).toBe(controller.signal);
    expect(recorded[0]?.options?.timeout).toBe(5_000);

    await pool.shutdown();
  });

  it('aborts an in-flight call synchronously instead of waiting for timeout', async () => {
    const server: ResolvedMcpServer = {
      name: 'matrix',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
      // Very generous timeout — we should NOT wait for it when the signal fires.
      timeout: 60_000,
    };
    const pool = new McpConnectionPool(stubLookup(server));
    const recorded: RecordedCall[] = [];
    // Fake client mirrors the SDK behaviour: reject when the signal aborts.
    seedFakeConnection(
      pool,
      'matrix',
      (options) =>
        new Promise<McpToolCallResult>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) {
            setTimeout(
              () => reject(new Error('never got signal (pool should have forwarded it)')),
              10_000,
            );
            return;
          }
          if (signal.aborted) {
            reject(new Error('Request aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('Request aborted')), {
            once: true,
          });
        }),
      recorded,
    );

    const controller = new AbortController();
    const start = Date.now();
    const call = pool.callTool('matrix', 'image_synthesize', { prompt: 'a cat' }, undefined, {
      signal: controller.signal,
      timeout: 60_000,
    });
    queueMicrotask(() => controller.abort());
    await expect(call).rejects.toThrow(/MCP tool call failed: Request aborted/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1_000);

    await pool.shutdown();
  });

  it('short-circuits when the signal is already aborted', async () => {
    const server: ResolvedMcpServer = {
      name: 'matrix',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
    };
    const pool = new McpConnectionPool(stubLookup(server));
    const recorded: RecordedCall[] = [];
    seedFakeConnection(
      pool,
      'matrix',
      async () => ({ content: [{ type: 'text', text: 'should-not-run' }] }),
      recorded,
    );

    const controller = new AbortController();
    controller.abort();

    await expect(
      pool.callTool('matrix', 'image_synthesize', { prompt: 'x' }, undefined, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted before dispatch/);
    // Never dispatched — nothing recorded.
    expect(recorded).toEqual([]);

    await pool.shutdown();
  });

  it('aborts a caller queued behind an in-flight call without waiting for the head to release', async () => {
    // Reviewer P1 regression: the two `signal.aborted` checks around
    // `sem.acquire()` (before/after) do not cover a caller that aborts
    // WHILE queued on the semaphore. Before this fix, `Semaphore.acquire`
    // was a bare `new Promise((resolve) => queue.push(resolve))` with no
    // abort hook — the queued caller had to wait for the in-flight
    // long-running call to release the permit, at which point the
    // post-acquire check would fire. For a `image_synthesize` head call
    // that meant the aborted follow-up sat for the full generation window.
    // We now hand the signal to `Semaphore.acquire`, which splices the
    // waiter out of the queue on abort and rejects immediately.
    const server: ResolvedMcpServer = {
      name: 'matrix',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
      timeout: 60_000,
    };
    const pool = new McpConnectionPool(stubLookup(server), { maxConcurrency: 1 });
    const recorded: RecordedCall[] = [];
    // Head call never resolves on its own — we release it manually at the
    // end of the test. This proves the queued caller returns BEFORE the
    // head does.
    let releaseHead: (() => void) | undefined;
    const headStarted = new Promise<void>((resolveStarted) => {
      seedFakeConnection(
        pool,
        'matrix',
        () => {
          resolveStarted();
          return new Promise<McpToolCallResult>((resolveHead) => {
            releaseHead = () => resolveHead({ content: [{ type: 'text', text: 'head-done' }] });
          });
        },
        recorded,
      );
    });

    // Fire the head call so it takes the sole permit and blocks the queue.
    const headController = new AbortController();
    const headPromise = pool.callTool('matrix', 'image_synthesize', { prompt: 'head' }, undefined, {
      signal: headController.signal,
      timeout: 60_000,
    });
    await headStarted;
    expect(pool.getStats('matrix').active).toBe(1);

    // Queue a second caller. Its acquire() sits in the queue behind the head.
    const followController = new AbortController();
    const followStarted = Date.now();
    const followPromise = pool.callTool(
      'matrix',
      'image_synthesize',
      { prompt: 'follow' },
      undefined,
      { signal: followController.signal, timeout: 60_000 },
    );
    // Yield twice so the follow-up definitely reaches the semaphore's queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(pool.getStats('matrix').pending).toBe(1);

    // Abort the queued follow-up. It must reject sub-second — long before
    // we release the head call — and without ever dispatching to the
    // fake client.
    followController.abort();
    await expect(followPromise).rejects.toThrow(/aborted before dispatch/);
    const followElapsed = Date.now() - followStarted;
    expect(followElapsed).toBeLessThan(1_000);

    // Only the head reached the client; the queued caller was spliced out
    // of the semaphore queue before ever dispatching.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.toolName).toBe('image_synthesize');

    // The abort must not have leaked a `running` permit. After the aborted
    // waiter is spliced out, `pending` returns to 0 and `active` stays at
    // 1 (the head still holds its permit).
    expect(pool.getStats('matrix').pending).toBe(0);
    expect(pool.getStats('matrix').active).toBe(1);

    // Release the head and drain its promise so shutdown() is clean.
    releaseHead?.();
    await headPromise;
    expect(pool.getStats('matrix').active).toBe(0);

    await pool.shutdown();
  });

  it('does not leak a semaphore permit when a queued waiter aborts', async () => {
    // Follow-up guard for the fix above: after an aborted waiter is
    // spliced out of the queue, subsequent non-aborted callers must still
    // be able to acquire the permit exactly `maxConcurrency` at a time.
    // A naïve `Promise.race([acquire, abortEvent])` implementation would
    // leave the aborted waiter in the queue; `release()` would then hand
    // it a permit and bump `running` for no live consumer — silently
    // starving future callers by one slot per abort.
    const server: ResolvedMcpServer = {
      name: 'matrix',
      enabled: true,
      transport: { type: 'http', url: 'https://example.com/mcp' },
    };
    const pool = new McpConnectionPool(stubLookup(server), { maxConcurrency: 1 });
    const recorded: RecordedCall[] = [];
    let releaseHead: (() => void) | undefined;
    const headStarted = new Promise<void>((resolveStarted) => {
      seedFakeConnection(
        pool,
        'matrix',
        () => {
          resolveStarted();
          return new Promise<McpToolCallResult>((resolveHead) => {
            releaseHead = () => resolveHead({ content: [{ type: 'text', text: 'ok' }] });
          });
        },
        recorded,
      );
    });

    const headPromise = pool.callTool('matrix', 't', {}, undefined, { timeout: 60_000 });
    await headStarted;

    // Queue an aborted follow-up.
    const abortController = new AbortController();
    const abortedPromise = pool.callTool('matrix', 't', {}, undefined, {
      signal: abortController.signal,
      timeout: 60_000,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(pool.getStats('matrix').pending).toBe(1);
    abortController.abort();
    await expect(abortedPromise).rejects.toThrow(/aborted before dispatch/);
    expect(pool.getStats('matrix').pending).toBe(0);

    // Release the head. A leak would have `release()` hand the permit to
    // the ghost waiter and bump `running` to 2; the semaphore would then
    // starve. The healthy behaviour is `active` drops back to 0.
    releaseHead?.();
    await headPromise;
    expect(pool.getStats('matrix').active).toBe(0);

    // A brand-new caller must be admitted without waiting on a phantom
    // permit. If the previous abort had leaked, this call would sit in
    // the queue instead of running immediately.
    let secondReleased: (() => void) | undefined;
    seedFakeConnection(
      pool,
      'matrix',
      () =>
        new Promise<McpToolCallResult>((resolveSecond) => {
          secondReleased = () => resolveSecond({ content: [{ type: 'text', text: 'second' }] });
        }),
      recorded,
    );
    const secondPromise = pool.callTool('matrix', 't', {}, undefined, { timeout: 60_000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(pool.getStats('matrix').active).toBe(1);
    expect(pool.getStats('matrix').pending).toBe(0);
    secondReleased?.();
    await secondPromise;

    await pool.shutdown();
  });
});

describe('McpConnectionPool.callTool — server timeout', () => {
  const server: ResolvedMcpServer = {
    name: 'slow',
    enabled: true,
    transport: { type: 'http', url: 'https://example.com/mcp' },
    timeout: 20,
  };

  it('reports the pool bound firing as a typed timeout of a dispatched call', async () => {
    const pool = new McpConnectionPool(stubLookup(server), { maxConcurrency: 1 });
    seedFakeConnection(pool, 'slow', () => new Promise<never>(() => undefined), []);

    const failure = await pool.callTool('slow', 'search', {}).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpToolCallTimeoutError);
    expect(failure).toMatchObject({ timeoutMs: 20, message: expect.stringContaining('timed out') });
  });

  it('reports the SDK request timeout the same way', async () => {
    const pool = new McpConnectionPool(stubLookup(server), { maxConcurrency: 1 });
    seedFakeConnection(
      pool,
      'slow',
      async () => {
        throw new McpError(ErrorCode.RequestTimeout, 'Request timed out');
      },
      [],
    );

    await expect(pool.callTool('slow', 'search', {})).rejects.toBeInstanceOf(
      McpToolCallTimeoutError,
    );
  });

  it('keeps other failures and caller aborts untyped', async () => {
    const pool = new McpConnectionPool(stubLookup(server), { maxConcurrency: 1 });
    seedFakeConnection(
      pool,
      'slow',
      async () => {
        throw new Error('socket hang up');
      },
      [],
    );

    const failure = await pool.callTool('slow', 'search', {}).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(McpToolCallTimeoutError);
    expect(failure).toMatchObject({ message: 'MCP tool call failed: socket hang up' });
  });

  it('keeps the SDK or pool timeout as the cause that raw-error callers describe', async () => {
    const sdkTimeout = new McpError(ErrorCode.RequestTimeout, 'Request timed out');
    const pool = new McpConnectionPool(stubLookup(server), { maxConcurrency: 1 });
    seedFakeConnection(
      pool,
      'slow',
      async () => {
        throw sdkTimeout;
      },
      [],
    );

    const sdkFailure = await pool.callTool('slow', 'search', {}).catch((error: unknown) => error);

    expect(sdkFailure).toBeInstanceOf(McpToolCallTimeoutError);
    expect((sdkFailure as Error).cause).toBe(sdkTimeout);
    expect(describeMcpCallError(sdkFailure)).toEqual({
      code: ErrorCode.RequestTimeout,
      message: 'Request timed out',
    });

    const boundPool = new McpConnectionPool(stubLookup(server), { maxConcurrency: 1 });
    seedFakeConnection(boundPool, 'slow', () => new Promise<never>(() => undefined), []);

    const boundFailure = await boundPool
      .callTool('slow', 'search', {})
      .catch((error: unknown) => error);

    expect(boundFailure).toBeInstanceOf(McpToolCallTimeoutError);
    expect(describeMcpCallError(boundFailure)).toEqual({
      name: 'Error',
      message: 'MCP tool call "search" on "slow" timed out after 20ms',
    });
  });
});
