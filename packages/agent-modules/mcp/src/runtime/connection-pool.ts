/**
 * Host-agnostic MCP connection pool.
 *
 * Adapted from the retired `packages/daemon/src/mcp/runtime/connection-pool.ts`.
 * Behaviour parity with the daemon version on the hot paths:
 *
 *   * One persistent connection per server, lazily spawned on first call,
 *     cleaned up after `idleTimeoutMs` of inactivity.
 *   * Per-server semaphore bounds concurrent `tools/call` to `maxConcurrency`
 *     so a flood from the LLM can't fork-bomb the stdio child.
 *   * `attachStderrLogging` drains every stdio child's stderr into the
 *     injected logger as `[mcp:<server>:stderr] <line>` records. Registered
 *     stderr-line observers (e.g. the ND audit sink) get fed the same lines
 *     in parallel. 64 KiB unflushed-buffer safety valve flushes verbatim so a
 *     runaway child cannot grow pool memory unboundedly.
 *
 * Trimmed compared to the daemon original:
 *
 *   * No prom-client metrics — hosts inject an optional `McpPoolMetrics`
 *     port (`options.metrics`) for connect / tool-call counters and latency;
 *     absent port = noop. Per-server detail goes through the injected logger
 *     and stderr observers, never metric labels.
 *   * No prometheus / spawn telemetry import path.
 *   * Logger is injected, not a module-global pino instance.
 */
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, ListRootsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createTransport } from './transport/factory.js';
import {
  MCP_DEFAULTS,
  NOOP_MCP_RUNTIME_LOGGER,
  type McpCallOptions,
  type McpConnection,
  type McpConnectionKey,
  type McpConnectionTokenOverrides,
  type McpPoolMetrics,
  type McpRuntimeLogger,
  type McpToolCallResult,
  type McpToolInfo,
  type ResolvedMcpServer,
  type StderrLineObserver,
} from './types.js';

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
const IDLE_CHECK_INTERVAL_MS = 60_000;
const STDERR_BUFFER_SAFETY_VALVE = 64 * 1024;

/**
 * Read a server's resolved (transport + enabled + timeout) descriptor.
 * Passed in by the host so the pool stays config-source agnostic.
 */
export interface McpServerLookup {
  getResolvedServer(serverName: string): ResolvedMcpServer | null;
}

export interface McpConnectionPoolOptions {
  idleTimeoutMs?: number;
  maxConcurrency?: number;
  logger?: McpRuntimeLogger;
  fetchImpl?: typeof fetch;
  /**
   * Optional host-injected metrics port. Absent = noop (zero behavior
   * change). Emits BARE metric names with bounded label sets only — never
   * the user-defined server name (see `McpPoolMetrics`).
   */
  metrics?: McpPoolMetrics;
}

/**
 * The call provably never reached the server (aborted before or while waiting for a permit).
 * Callers decide "safe to retry" with `instanceof`, never by matching the message.
 */
export class McpToolCallNotDispatchedError extends Error {
  constructor(serverName: string, toolName: string) {
    super(`MCP tool call aborted before dispatch: ${serverName}/${toolName}`);
    this.name = 'McpToolCallNotDispatchedError';
  }
}

/**
 * The call was dispatched and the server did not answer within its timeout (the pool's own bound
 * or the SDK request timeout), while the caller's signal was not aborted. The tool may have run.
 */
export class McpToolCallTimeoutError extends Error {
  constructor(
    serverName: string,
    toolName: string,
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(
      `MCP tool call failed: MCP tool call "${toolName}" on "${serverName}" timed out after ${timeoutMs}ms`,
      options,
    );
    this.name = 'McpToolCallTimeoutError';
  }
}

class Semaphore {
  // Each waiter holds its own resolve/reject pair so `acquire(signal)` can
  // reject and remove itself from the queue on abort without waking up an
  // unrelated queued caller. The FIFO fairness for non-aborted waiters is
  // preserved because `release()` still shifts the head. When a waiter is
  // aborted mid-queue we splice it out — the semaphore never grants a permit
  // to an aborted caller and never leaks a `running` slot.
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private running = 0;
  constructor(private readonly max: number) {}
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('Semaphore acquire aborted before dispatch');
    }
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: { resolve: () => void; reject: (err: Error) => void } = {
        resolve,
        reject,
      };
      const detach = (): void => {
        if (!signal) return;
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        // Splice the exact waiter out of the queue so `release()` never
        // hands a permit to a caller that has already given up. `indexOf`
        // is O(queue) but the pool max is single-digit; the abort path is
        // strictly rarer than the normal grant path.
        const idx = this.queue.indexOf(waiter);
        if (idx >= 0) this.queue.splice(idx, 1);
        waiter.reject(new Error('Semaphore acquire aborted while queued'));
      };
      // Wrap the original resolve so a normal grant tears down the abort
      // listener; otherwise a later abort on the same signal would fire
      // against an already-resolved waiter and be a no-op leak.
      waiter.resolve = (): void => {
        detach();
        resolve();
      };
      waiter.reject = (err: Error): void => {
        detach();
        reject(err);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }
  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next.resolve();
    }
  }
  get pending(): number {
    return this.queue.length;
  }
  get active(): number {
    return this.running;
  }
}

interface PendingMcpConnection {
  promise: Promise<McpConnection>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

export class McpConnectionPool {
  private connections = new Map<McpConnectionKey, McpConnection>();
  private connectingPromises = new Map<McpConnectionKey, PendingMcpConnection>();
  private connectionServerNames = new Map<McpConnectionKey, string>();
  /**
   * Generation counter per connection key. Bumped by `disconnectConnection` so an
   * already-running `doConnect` can detect "I was started under generation N,
   * but disconnect has since moved us to N+1, so my freshly-spawned child is
   * stale — close it instead of caching it". Without this, the `.then()`
   * callback inside `ensureConnection` would unconditionally write the new
   * connection into `this.connections`, which avoids reusing a stdio child
   * that captured stale host-provided env at spawn.
   */
  private connectGenerations = new Map<McpConnectionKey, number>();
  private semaphores = new Map<McpConnectionKey, Semaphore>();
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private stderrObservers = new Set<StderrLineObserver>();

  private readonly idleTimeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly logger: McpRuntimeLogger;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly metrics: McpPoolMetrics | undefined;

  constructor(
    private readonly lookup: McpServerLookup,
    options: McpConnectionPoolOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxConcurrency = options.maxConcurrency ?? MCP_DEFAULTS.maxConcurrency;
    this.logger = options.logger ?? NOOP_MCP_RUNTIME_LOGGER;
    this.fetchImpl = options.fetchImpl;
    this.metrics = options.metrics;
  }

  /**
   * Register an observer that receives every stderr line from every stdio
   * child. Returns an unsubscribe function. Observers must not throw —
   * exceptions are caught and logger.warn'd so a single bad observer cannot
   * stop the stderr drain loop or break the audit sink for other consumers.
   */
  addStderrObserver(observer: StderrLineObserver): () => void {
    this.stderrObservers.add(observer);
    return () => {
      this.stderrObservers.delete(observer);
    };
  }

  async listTools(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
    options?: McpCallOptions,
  ): Promise<McpToolInfo[]> {
    const connectionKey = this.resolveConnectionKey(serverName, tokenOverrides);
    const sem = this.getSemaphore(connectionKey);
    if (options?.signal?.aborted) {
      throw new Error(`MCP list tools aborted before dispatch: ${serverName}`);
    }
    try {
      await sem.acquire(options?.signal);
    } catch {
      throw new Error(`MCP list tools aborted before dispatch: ${serverName}`);
    }
    try {
      if (options?.signal?.aborted) {
        throw new Error(`MCP list tools aborted before dispatch: ${serverName}`);
      }
      const conn = await this.ensureConnection(serverName, connectionKey, tokenOverrides, options);
      if (conn.tools) {
        conn.lastUsed = Date.now();
        return conn.tools;
      }
      const timeoutMs = this.resolveTimeout(serverName, options?.timeout, tokenOverrides);
      return await this.fetchAndCacheTools(conn, { ...options, timeout: timeoutMs });
    } finally {
      sem.release();
    }
  }

  async refreshTools(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
  ): Promise<McpToolInfo[]> {
    const connectionKey = this.resolveConnectionKey(serverName, tokenOverrides);
    const sem = this.getSemaphore(connectionKey);
    await sem.acquire();
    try {
      const conn = await this.ensureConnection(serverName, connectionKey, tokenOverrides);
      conn.tools = null;
      return await this.fetchAndCacheTools(conn);
    } finally {
      sem.release();
    }
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    tokenOverrides?: McpConnectionTokenOverrides,
    options?: McpCallOptions,
  ): Promise<McpToolCallResult> {
    const connectionKey = this.resolveConnectionKey(serverName, tokenOverrides);
    const sem = this.getSemaphore(connectionKey);
    // Early-abort: skip semaphore acquisition entirely when the caller has
    // already aborted. Semaphore.acquire has no abort hook, so a queued waiter
    // would otherwise sit until an in-flight callTool releases it — turning an
    // "immediate cancel" into "wait for the head of the queue to finish".
    if (options?.signal?.aborted) {
      throw new Error(`MCP tool call aborted before dispatch: ${serverName}/${toolName}`);
    }
    // Abortable acquire: while queued behind an in-flight long-running call
    // (e.g. `image_synthesize`), an abort on `options.signal` splices this
    // waiter out of the semaphore queue and rejects immediately instead of
    // waiting for the head of the queue to release. Without this, the two
    // aborted-state checks around `acquire()` would only fire before we get
    // in line and after we already own the permit — a caller aborted while
    // *queued* would still block for the remainder of the head call.
    try {
      await sem.acquire(options?.signal);
    } catch {
      // Normalise to the same wire-shape as the other pre-dispatch aborts so
      // callers see a consistent "aborted before dispatch" surface regardless
      // of whether the abort landed on the pre-check or on the queue splice.
      throw new Error(`MCP tool call aborted before dispatch: ${serverName}/${toolName}`);
    }
    // Metrics cover DISPATCHED calls only (permit acquired): the pre-acquire
    // abort short-circuits above never reached a connection and are pure
    // caller-side cancellation noise. Duration is observed only for calls
    // that completed a round-trip (status ok | tool_error) so the unlabeled
    // histogram stays a clean "MCP tool latency" series instead of mixing in
    // instant aborts and connect failures.
    const startMs = Date.now();
    try {
      if (options?.signal?.aborted) {
        throw new Error(`MCP tool call aborted before dispatch: ${serverName}/${toolName}`);
      }
      const conn = await this.ensureConnection(serverName, connectionKey, tokenOverrides);
      conn.lastUsed = Date.now();
      if (!conn.client) {
        throw new Error(`MCP client not available for "${serverName}"`);
      }
      const timeoutMs = this.resolveTimeout(serverName, options?.timeout, tokenOverrides);
      try {
        // Forward the caller's AbortSignal to the SDK. Protocol.request wires
        // it into a `notifications/cancelled` frame + immediate promise reject
        // (see @modelcontextprotocol/sdk shared/protocol.ts), so an aborted
        // turn stops waiting on the remote MCP server instantly instead of
        // ticking down the pool timeout. `timeout` is still honoured as a
        // belt-and-suspenders bound.
        const result = await withTimeout(
          conn.client.callTool({ name: toolName, arguments: args }, undefined, {
            timeout: timeoutMs,
            ...(options?.signal ? { signal: options.signal } : {}),
          }),
          timeoutMs,
          `MCP tool call "${toolName}" on "${serverName}" timed out after ${timeoutMs}ms`,
        );
        const shaped: McpToolCallResult = {
          content: (result.content ?? []) as McpToolCallResult['content'],
          isError: result.isError === true,
          ...(isRecord(result.structuredContent)
            ? { structuredContent: result.structuredContent }
            : {}),
          ...(isRecord(result._meta) ? { _meta: result._meta } : {}),
        };
        this.metrics?.incr('mcp_tool_call_total', {
          status: shaped.isError ? 'tool_error' : 'ok',
        });
        this.metrics?.latency('mcp_tool_call_duration_ms', Date.now() - startMs);
        return shaped;
      } catch (err) {
        // Keep the SDK error as `cause`: its JSON-RPC `code`/`data` (McpError)
        // or connection `code` is the only machine-readable reason, and
        // programmatic callers hand it to scripts as a raw error.
        if (!options?.signal?.aborted && isToolCallTimeout(err)) {
          throw new McpToolCallTimeoutError(serverName, toolName, timeoutMs, { cause: err });
        }
        throw new Error(
          `MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    } catch (err) {
      this.metrics?.incr('mcp_tool_call_total', {
        status: options?.signal?.aborted ? 'aborted' : 'error',
      });
      throw err;
    } finally {
      sem.release();
    }
  }

  startIdleCheck(): void {
    if (this.idleCheckTimer) return;
    this.idleCheckTimer = setInterval(() => this.cleanupIdleConnections(), IDLE_CHECK_INTERVAL_MS);
    this.idleCheckTimer.unref();
  }

  async shutdown(): Promise<void> {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
    // Include in-flight connecting keys too so `disconnectConnection` bumps
    // the generation for each — a connect that resolves after shutdown will
    // see the mismatch and close its own child instead of caching it.
    const keys = new Set<McpConnectionKey>([
      ...this.connections.keys(),
      ...this.connectingPromises.keys(),
    ]);
    await Promise.allSettled([...keys].map((key) => this.disconnectConnection(key)));
    this.semaphores.clear();
    this.connectionServerNames.clear();
    this.logger.info(`All MCP connections closed`, { count: keys.size });
  }

  async reconnect(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
  ): Promise<McpConnection> {
    const connectionKey = this.resolveConnectionKey(serverName, tokenOverrides);
    await this.disconnectConnection(connectionKey);
    return this.ensureConnection(serverName, connectionKey, tokenOverrides);
  }

  async disconnect(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
  ): Promise<void> {
    if (tokenOverrides?.connectionKey) {
      await this.disconnectConnection(this.resolveConnectionKey(serverName, tokenOverrides));
      return;
    }
    const keys = this.findConnectionKeysForServer(serverName);
    if (keys.length === 0) {
      await this.disconnectConnection(this.resolveConnectionKey(serverName));
      return;
    }
    await Promise.allSettled(keys.map((key) => this.disconnectConnection(key)));
  }

  getStats(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
  ): { active: number; pending: number; maxConcurrency: number } {
    const connectionKey = this.resolveConnectionKey(serverName, tokenOverrides);
    const sem = this.semaphores.get(connectionKey);
    return {
      active: sem?.active ?? 0,
      pending: sem?.pending ?? 0,
      maxConcurrency: this.maxConcurrency,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private getSemaphore(connectionKey: McpConnectionKey): Semaphore {
    let sem = this.semaphores.get(connectionKey);
    if (!sem) {
      sem = new Semaphore(this.maxConcurrency);
      this.semaphores.set(connectionKey, sem);
    }
    return sem;
  }

  private resolveConnectionKey(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
  ): McpConnectionKey {
    const requestedKey = tokenOverrides?.connectionKey;
    // Keep the server identity separate from its scope: a raw server name can
    // itself contain the text of another server's scoped connection key.
    const scope = !requestedKey
      ? null
      : requestedKey.startsWith(`${serverName}:`)
        ? requestedKey.slice(serverName.length + 1)
        : requestedKey;
    return JSON.stringify([serverName, scope]);
  }

  private findConnectionKeysForServer(serverName: string): McpConnectionKey[] {
    const keys = new Set<McpConnectionKey>();
    for (const [key, conn] of this.connections.entries()) {
      if (conn.name === serverName) keys.add(key);
    }
    for (const [key, mappedServerName] of this.connectionServerNames.entries()) {
      if (mappedServerName === serverName) keys.add(key);
    }
    const baseKey = this.resolveConnectionKey(serverName);
    if (this.connections.has(baseKey) || this.connectingPromises.has(baseKey)) {
      keys.add(baseKey);
    }
    return [...keys];
  }

  private resolveTimeout(
    serverName: string,
    perCallTimeout?: number,
    tokenOverrides?: McpConnectionTokenOverrides,
  ): number {
    if (perCallTimeout && perCallTimeout > 0) return perCallTimeout;
    const server = tokenOverrides?.serverOverride ?? this.lookup.getResolvedServer(serverName);
    if (server?.timeout && server.timeout > 0) return server.timeout;
    return MCP_DEFAULTS.timeout;
  }

  private async ensureConnection(
    serverName: string,
    connectionKey: McpConnectionKey,
    tokenOverrides?: McpConnectionTokenOverrides,
    options?: McpCallOptions,
  ): Promise<McpConnection> {
    this.connectionServerNames.set(connectionKey, serverName);
    const existing = this.connections.get(connectionKey);
    if (existing?.state === 'connected' && existing.client) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (existing) {
      this.connections.delete(connectionKey);
    }
    const connecting = this.connectingPromises.get(connectionKey);
    if (connecting) {
      return this.waitForPendingConnection(serverName, connecting, options?.signal);
    }
    this.startIdleCheck();
    // Snapshot the generation BEFORE the spawn. If `disconnectConnection` runs
    // while we're connecting it bumps the counter, and the `.then()` below
    // sees the mismatch and closes the just-spawned (stale-identity) child
    // instead of caching it. Without this, an auth-context rotation that
    // happens during the very first `nd` spawn would silently leak the old
    // identity back into `this.connections`.
    const generation = (this.connectGenerations.get(connectionKey) ?? 0) + 1;
    this.connectGenerations.set(connectionKey, generation);
    const connectTimeoutMs = this.resolveTimeout(serverName, options?.timeout, tokenOverrides);
    const controller = new AbortController();
    const pending = {
      controller,
      waiters: 0,
      settled: false,
    } as Omit<PendingMcpConnection, 'promise'> & { promise?: Promise<McpConnection> };
    const connectPromise = this.doConnect(
      serverName,
      connectionKey,
      tokenOverrides,
      connectTimeoutMs,
      controller.signal,
    )
      .then(async (connection) => {
        if (this.connectGenerations.get(connectionKey) !== generation) {
          // A disconnect arrived after we started spawning. The connection
          // we just got belongs to the prior identity / config — close it
          // and surface that to the caller of THIS `ensureConnection` as a
          // disconnected error rather than handing back a stale child.
          await closeConnectionSafely(connection, this.logger, serverName);
          throw new Error(`MCP server "${serverName}" was disconnected while connecting`);
        }
        this.connections.set(connectionKey, connection);
        return connection;
      })
      .finally(() => {
        pending.settled = true;
        if (this.connectingPromises.get(connectionKey) === pending) {
          this.connectingPromises.delete(connectionKey);
        }
      });
    pending.promise = connectPromise;
    this.connectingPromises.set(connectionKey, pending as PendingMcpConnection);
    return this.waitForPendingConnection(
      serverName,
      pending as PendingMcpConnection,
      options?.signal,
    );
  }

  private waitForPendingConnection(
    serverName: string,
    pending: PendingMcpConnection,
    signal?: AbortSignal,
  ): Promise<McpConnection> {
    pending.waiters++;
    let released = false;
    const releaseWaiter = (): void => {
      if (released) return;
      released = true;
      pending.waiters--;
      if (pending.waiters === 0 && !pending.settled) {
        pending.controller.abort();
      }
    };
    if (signal?.aborted) {
      releaseWaiter();
      return Promise.reject(new Error(`MCP connection wait aborted: ${serverName}`));
    }
    return new Promise<McpConnection>((resolve, reject) => {
      const onAbort = (): void => {
        releaseWaiter();
        reject(new Error(`MCP connection wait aborted: ${serverName}`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.promise.then(
        (connection) => {
          signal?.removeEventListener('abort', onAbort);
          releaseWaiter();
          resolve(connection);
        },
        (error) => {
          signal?.removeEventListener('abort', onAbort);
          releaseWaiter();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async doConnect(
    serverName: string,
    connectionKey: McpConnectionKey,
    tokenOverrides: McpConnectionTokenOverrides | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<McpConnection> {
    const server = tokenOverrides?.serverOverride ?? this.lookup.getResolvedServer(serverName);
    if (!server) {
      throw new Error(`MCP server "${serverName}" not found`);
    }
    if (!server.enabled) {
      throw new Error(`MCP server "${serverName}" is disabled`);
    }

    const transportOverrides = { ...(tokenOverrides ?? {}) };
    delete transportOverrides.serverOverride;
    const transport = createTransport(server.transport, {
      ...transportOverrides,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    const client = new Client(
      { name: 'mavis-local-runtime-mcp', version: '1.0.0' },
      { capabilities: { roots: { listChanged: false } } },
    );

    // Respond to roots/list so MCP servers (e.g. Playwright) know the
    // workspace root and don't fall back to their own process.cwd().
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [
        {
          uri: pathToFileURL(server.workspaceRoot ?? homedir()).href,
          name: server.workspaceRoot ? 'project' : 'home',
        },
      ],
    }));

    let connection: McpConnection | null = null;
    const connectStartedAtMs = Date.now();
    this.logger.info(`Connecting MCP server`, {
      serverName,
      connectionKey,
      transportType: server.transport.type,
      timeoutMs,
    });
    try {
      this.attachStderrLogging(serverName, transport);
      this.attachTransportLifecycleLogging(serverName, connectionKey, transport, () => connection);
      await client.connect(transport, { timeout: timeoutMs, signal });
      // Connect outcome is labeled by transport kind only — the server name
      // is user-defined (unbounded cardinality) and stays in logger fields.
      this.metrics?.incr('mcp_connect_total', {
        transport: server.transport.type,
        status: 'ok',
      });
      connection = {
        key: connectionKey,
        name: serverName,
        state: 'connected',
        client,
        transport,
        tools: null,
        lastUsed: Date.now(),
      };
      this.logger.info(`Connected MCP server`, {
        serverName,
        connectionKey,
        transportType: server.transport.type,
        durationMs: Math.max(0, Date.now() - connectStartedAtMs),
      });
      return connection;
    } catch (error) {
      this.logger.error(`Failed to connect MCP server`, {
        serverName,
        connectionKey,
        transportType: server.transport.type,
        durationMs: Math.max(0, Date.now() - connectStartedAtMs),
        error: toErrorMessage(error),
      });
      this.metrics?.incr('mcp_connect_total', {
        transport: server.transport.type,
        status: 'error',
      });
      try {
        await client.close();
      } catch (closeError) {
        this.logger.warn(`Failed to close MCP client after connect error`, {
          serverName,
          error: toErrorMessage(closeError),
        });
      }
      throw new Error(`Failed to connect to MCP server "${serverName}": ${toErrorMessage(error)}`);
    }
  }

  /**
   * Pipe a stdio child's stderr into the injected logger and any registered
   * observers. Duck-typed on `stderr` so HTTP/SSE transports (which lack it)
   * silently skip the wiring. Lines are buffered until newline; the 64 KiB
   * safety valve flushes a runaway non-newline buffer verbatim.
   */
  private attachStderrLogging(serverName: string, transport: Transport): void {
    const { stderr } = transport as { stderr?: NodeJS.ReadableStream | null };
    if (!stderr || typeof stderr.on !== 'function') return;

    let buffer = '';
    const flushLine = (line: string): void => {
      const trimmed = line.replace(/\r$/, '');
      if (trimmed.length === 0) return;
      this.logger.info(`[mcp:${serverName}:stderr] ${trimmed}`);
      for (const observer of this.stderrObservers) {
        try {
          observer(serverName, trimmed);
        } catch (err) {
          this.logger.warn(`MCP stderr observer threw — line dropped from that observer`, {
            serverName,
            error: toErrorMessage(err),
          });
        }
      }
    };

    stderr.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        flushLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > STDERR_BUFFER_SAFETY_VALVE) {
        flushLine(buffer);
        buffer = '';
      }
    });

    stderr.on('error', (err: Error) => {
      this.logger.warn(`MCP server stderr stream error`, {
        serverName,
        error: toErrorMessage(err),
      });
    });
  }

  private attachTransportLifecycleLogging(
    serverName: string,
    connectionKey: McpConnectionKey,
    transport: Transport,
    getConnection: () => McpConnection | null,
  ): void {
    const previousOnClose = transport.onclose;
    transport.onclose = () => {
      previousOnClose?.();
      const connection = getConnection();
      if (connection) {
        connection.state = 'disconnected';
        connection.client = null;
        connection.transport = null;
        if (this.connections.get(connectionKey) === connection) {
          this.connections.delete(connectionKey);
        }
        this.cleanupDisconnectedBookkeeping(connectionKey, {
          keepGeneration: this.connectingPromises.has(connectionKey),
        });
      }
      this.logger.warn(`MCP server transport closed`, { serverName, connectionKey });
    };

    const previousOnError = transport.onerror;
    transport.onerror = (err) => {
      previousOnError?.(err);
      this.logger.warn(`MCP server transport error`, {
        serverName,
        error: toErrorMessage(err),
      });
    };
  }

  private async fetchAndCacheTools(
    conn: McpConnection,
    options?: McpCallOptions,
  ): Promise<McpToolInfo[]> {
    conn.lastUsed = Date.now();
    if (!conn.client) {
      throw new Error(`MCP client not available for "${conn.name}"`);
    }
    try {
      const result = await conn.client.listTools(undefined, options);
      const tools: McpToolInfo[] = (result.tools ?? []).map((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : {},
      }));
      conn.tools = tools;
      conn.lastUsed = Date.now();
      return tools;
    } catch (error) {
      throw new Error(`MCP list tools failed: ${toErrorMessage(error)}`);
    }
  }

  private async disconnectConnection(connectionKey: McpConnectionKey): Promise<void> {
    // Bump the generation FIRST so any in-flight `ensureConnection.then()`
    // observes the mismatch and closes its freshly-spawned child instead of
    // caching it. Reading the prior value with `?? 0` keeps the math safe on
    // servers that have never been connected.
    const serverName = this.connectionServerNames.get(connectionKey) ?? connectionKey;
    const prevGen = this.connectGenerations.get(connectionKey) ?? 0;
    this.connectGenerations.set(connectionKey, prevGen + 1);
    const pending = this.connectingPromises.get(connectionKey);
    const hadConnecting = pending !== undefined;
    if (pending) {
      this.connectingPromises.delete(connectionKey);
      pending.controller.abort();
    }
    const conn = this.connections.get(connectionKey);
    if (!conn) {
      this.cleanupDisconnectedBookkeeping(connectionKey, { keepGeneration: hadConnecting });
      return;
    }
    this.connections.delete(connectionKey);
    conn.state = 'disconnected';
    conn.tools = null;
    const { client } = conn;
    conn.client = null;
    conn.transport = null;
    if (!client) {
      this.cleanupDisconnectedBookkeeping(connectionKey, {
        keepGeneration: this.connectingPromises.has(connectionKey),
      });
      return;
    }
    try {
      await client.close();
      this.logger.info(`Closed MCP connection`, { serverName, connectionKey });
    } catch (error) {
      this.logger.warn(`Failed to close MCP connection`, {
        serverName,
        connectionKey,
        error: toErrorMessage(error),
      });
    } finally {
      this.cleanupDisconnectedBookkeeping(connectionKey, {
        keepGeneration: this.connectingPromises.has(connectionKey),
      });
    }
  }

  private cleanupDisconnectedBookkeeping(
    connectionKey: McpConnectionKey,
    options: { keepGeneration?: boolean } = {},
  ): void {
    this.connectionServerNames.delete(connectionKey);
    this.semaphores.delete(connectionKey);
    if (!options.keepGeneration) {
      this.connectGenerations.delete(connectionKey);
    }
    this.stopIdleCheckIfUnused();
  }

  private cleanupIdleConnections(): void {
    const now = Date.now();
    const idleKeys = [...this.connections.entries()]
      .filter(
        ([key, conn]) =>
          !this.connectingPromises.has(key) && now - conn.lastUsed >= this.idleTimeoutMs,
      )
      .map(([key]) => key);
    if (idleKeys.length === 0) {
      this.stopIdleCheckIfUnused();
      return;
    }
    void Promise.allSettled(idleKeys.map((key) => this.disconnectConnection(key))).then(
      (results) => {
        const failedCount = results.filter((result) => result.status === 'rejected').length;
        if (failedCount > 0) {
          this.logger.warn(`Failed to clean up some idle MCP connections`, {
            failedCount,
            total: idleKeys.length,
          });
        }
      },
    );
  }

  private stopIdleCheckIfUnused(): void {
    if (this.connections.size > 0 || this.connectingPromises.size > 0 || !this.idleCheckTimer) {
      return;
    }
    clearInterval(this.idleCheckTimer);
    this.idleCheckTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Close a connection that arrived AFTER a `disconnectConnection` invalidated its
 * generation. Used only on the in-flight-connect race path inside
 * `ensureConnection.then()`. We swallow close errors at warn level — the
 * connection was already stale; the worst case is a leaked child for one
 * idle-cleanup cycle.
 */
async function closeConnectionSafely(
  connection: McpConnection,
  logger: McpRuntimeLogger,
  serverName: string,
): Promise<void> {
  connection.state = 'disconnected';
  connection.tools = null;
  const { client } = connection;
  connection.client = null;
  connection.transport = null;
  if (!client) return;
  try {
    await client.close();
    logger.info(`Closed stale MCP connection from disconnected-mid-spawn race`, {
      serverName,
    });
  } catch (error) {
    logger.warn(`Failed to close stale MCP connection from disconnected-mid-spawn race`, {
      serverName,
      error: toErrorMessage(error),
    });
  }
}

/** Raised by `withTimeout` when the pool's own bound fires. */
class PoolTimeoutError extends Error {}

/** True for a dispatched call that timed out, whether the pool bound or the SDK request bound fired. */
function isToolCallTimeout(error: unknown): boolean {
  return (
    error instanceof PoolTimeoutError ||
    (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  if (ms <= 0 || !Number.isFinite(ms)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PoolTimeoutError(message));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
