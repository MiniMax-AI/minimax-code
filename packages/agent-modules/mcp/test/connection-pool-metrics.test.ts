/**
 * Unit tests for `McpConnectionPool` metrics emission (desktop metrics MR2).
 *
 * Metrics under test (BARE names — the metrics server prepends the service
 * prefix on ingest):
 *
 *   * `mcp_connect_total{transport,status}`   — per connect attempt outcome
 *   * `mcp_tool_call_total{status}`           — per dispatched tools/call
 *   * `mcp_tool_call_duration_ms`             — latency of COMPLETED calls only
 *
 * Hard constraints pinned here:
 *   * NO server-name label anywhere (user-defined names are unbounded).
 *   * Absent metrics port = noop, zero behavior change (the rest of the pool
 *     suite runs without a port and stays green).
 *
 * The happy path uses the SDK's `InMemoryTransport` + a real low-level
 * `Server` so `client.connect` performs a genuine MCP handshake; only
 * `createTransport` is mocked (it normally spawns stdio children).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { McpConnectionPool } from '../src/runtime/connection-pool.js';
import type {
  McpConnection,
  McpPoolMetrics,
  McpToolCallResult,
  ResolvedMcpServer,
} from '../src/runtime/types.js';

const { createTransportMock } = vi.hoisted(() => ({
  createTransportMock: vi.fn<(config: unknown, overrides?: unknown) => Transport>(),
}));

vi.mock('../src/runtime/transport/factory.js', () => ({
  createTransport: createTransportMock,
}));

interface MetricEvent {
  kind: 'incr' | 'latency';
  name: string;
  tags?: Record<string, string> | undefined;
  value?: number;
}

function makeRecorder(): { events: MetricEvent[]; metrics: McpPoolMetrics } {
  const events: MetricEvent[] = [];
  return {
    events,
    metrics: {
      incr: (name, tags) => events.push({ kind: 'incr', name, tags }),
      latency: (name, value, tags) => events.push({ kind: 'latency', name, value, tags }),
    },
  };
}

function stubLookup(server: ResolvedMcpServer): { getResolvedServer: () => ResolvedMcpServer } {
  return { getResolvedServer: () => server };
}

/** Real MCP server over an in-memory linked transport pair. */
async function startFakeServer(): Promise<Transport> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: 'fake-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'ping', inputSchema: { type: 'object' } },
      { name: 'boom', inputSchema: { type: 'object' } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'boom') {
      return { content: [{ type: 'text', text: 'tool failed' }], isError: true };
    }
    return { content: [{ type: 'text', text: 'pong' }] };
  });
  await server.connect(serverTransport);
  return clientTransport;
}

/**
 * Pre-seed a connected fake client (same trick as connection-pool-abort
 * tests) so a test can exercise `callTool` classification without any
 * connect happening — keeps connect metrics out of the picture.
 */
function seedFakeConnection(
  pool: McpConnectionPool,
  serverName: string,
  behaviour: (options?: { timeout?: number; signal?: AbortSignal }) => Promise<McpToolCallResult>,
): void {
  const fakeClient = {
    async callTool(
      _params: { name: string; arguments: Record<string, unknown> },
      _resultSchema: unknown,
      options?: { timeout?: number; signal?: AbortSignal },
    ): Promise<McpToolCallResult> {
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
    tools: [],
    lastUsed: Date.now(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).connections.set(connection.key, connection);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).connectionServerNames.set(connection.key, serverName);
}

const stdioServer: ResolvedMcpServer = {
  name: 'demo',
  enabled: true,
  transport: { type: 'stdio', command: 'unused-mocked', args: [] },
};

beforeEach(() => {
  createTransportMock.mockReset();
});

describe('McpConnectionPool — metrics emission', () => {
  let pool: McpConnectionPool | undefined;

  afterEach(async () => {
    await pool?.shutdown();
    pool = undefined;
  });

  it('emits connect ok + tool call ok + duration through a real MCP handshake', async () => {
    const clientTransport = await startFakeServer();
    createTransportMock.mockImplementation(() => clientTransport);

    const { events, metrics } = makeRecorder();
    const info = vi.fn();
    pool = new McpConnectionPool(stubLookup(stdioServer), {
      metrics,
      logger: { info, warn: vi.fn(), error: vi.fn() },
    });

    const result = await pool.callTool('demo', 'ping', {});
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);

    // Exact tag objects — pins both the bounded label sets AND the absence
    // of any server-name label.
    expect(events).toEqual([
      {
        kind: 'incr',
        name: 'mcp_connect_total',
        tags: { transport: 'stdio', status: 'ok' },
      },
      { kind: 'incr', name: 'mcp_tool_call_total', tags: { status: 'ok' } },
      {
        kind: 'latency',
        name: 'mcp_tool_call_duration_ms',
        value: expect.any(Number),
        tags: undefined,
      },
    ]);
    const duration = events[2]?.value;
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(info).toHaveBeenNthCalledWith(
      1,
      'Connecting MCP server',
      {
        serverName: 'demo',
        connectionKey: JSON.stringify(['demo', null]),
        transportType: 'stdio',
        timeoutMs: expect.any(Number),
      },
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      'Connected MCP server',
      {
        serverName: 'demo',
        connectionKey: JSON.stringify(['demo', null]),
        transportType: 'stdio',
        durationMs: expect.any(Number),
      },
    );
  });

  it('classifies MCP protocol-level tool errors (isError) as tool_error with duration', async () => {
    const clientTransport = await startFakeServer();
    createTransportMock.mockImplementation(() => clientTransport);

    const { events, metrics } = makeRecorder();
    pool = new McpConnectionPool(stubLookup(stdioServer), { metrics });

    const result = await pool.callTool('demo', 'boom', {});
    expect(result.isError).toBe(true);

    const toolEvents = events.filter((event) => event.name.startsWith('mcp_tool_call'));
    expect(toolEvents).toEqual([
      { kind: 'incr', name: 'mcp_tool_call_total', tags: { status: 'tool_error' } },
      {
        kind: 'latency',
        name: 'mcp_tool_call_duration_ms',
        value: expect.any(Number),
        tags: undefined,
      },
    ]);
  });

  it('emits connect error + tool call error (no duration) when the transport fails to start', async () => {
    createTransportMock.mockImplementation(
      () =>
        ({
          start: () => Promise.reject(new Error('spawn failed')),
          send: async () => {},
          close: async () => {},
        }) as unknown as Transport,
    );

    const { events, metrics } = makeRecorder();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    pool = new McpConnectionPool(stubLookup(stdioServer), { metrics, logger });

    await expect(pool.callTool('demo', 'ping', {})).rejects.toThrow(/Failed to connect/);

    expect(events).toEqual([
      {
        kind: 'incr',
        name: 'mcp_connect_total',
        tags: { transport: 'stdio', status: 'error' },
      },
      { kind: 'incr', name: 'mcp_tool_call_total', tags: { status: 'error' } },
    ]);
    expect(logger.info).toHaveBeenCalledWith('Connecting MCP server', {
      serverName: 'demo',
      connectionKey: JSON.stringify(['demo', null]),
      transportType: 'stdio',
      timeoutMs: expect.any(Number),
    });
    expect(logger.error).toHaveBeenCalledWith('Failed to connect MCP server', {
      serverName: 'demo',
      connectionKey: JSON.stringify(['demo', null]),
      transportType: 'stdio',
      durationMs: expect.any(Number),
      error: 'spawn failed',
    });
  });

  it('classifies an in-flight abort as aborted, not error, and skips duration', async () => {
    const { events, metrics } = makeRecorder();
    pool = new McpConnectionPool(stubLookup(stdioServer), { metrics });
    seedFakeConnection(
      pool,
      'demo',
      (options) =>
        new Promise<McpToolCallResult>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) {
            reject(new Error('pool did not forward the abort signal'));
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
    );

    const controller = new AbortController();
    const call = pool.callTool('demo', 'ping', {}, undefined, { signal: controller.signal });
    queueMicrotask(() => controller.abort());
    await expect(call).rejects.toThrow(/MCP tool call failed/);

    expect(events).toEqual([
      { kind: 'incr', name: 'mcp_tool_call_total', tags: { status: 'aborted' } },
    ]);
  });

  it('keeps the original protocol error as the cause of the wrapped call failure', async () => {
    pool = new McpConnectionPool(stubLookup(stdioServer));
    const protocolError = Object.assign(new Error('MCP error -32602: Invalid params'), {
      name: 'McpError',
      code: -32602,
      data: { field: 'query' },
    });
    seedFakeConnection(pool, 'demo', async () => {
      throw protocolError;
    });

    const failure = await pool.callTool('demo', 'ping', {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('MCP tool call failed: MCP error -32602: Invalid params');
    expect((failure as Error).cause).toBe(protocolError);
  });

  it('does not count pre-dispatch aborts (never acquired a permit)', async () => {
    const { events, metrics } = makeRecorder();
    pool = new McpConnectionPool(stubLookup(stdioServer), { metrics });
    seedFakeConnection(pool, 'demo', async () => ({ content: [] }));

    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.callTool('demo', 'ping', {}, undefined, { signal: controller.signal }),
    ).rejects.toThrow(/aborted before dispatch/);

    expect(events).toEqual([]);
  });

  it('stays a noop without a metrics port (absent-injection path)', async () => {
    pool = new McpConnectionPool(stubLookup(stdioServer));
    seedFakeConnection(pool, 'demo', async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));

    await expect(pool.callTool('demo', 'ping', {})).resolves.toMatchObject({ isError: false });
  });

  it('preserves every standard MCP content block and structuredContent', async () => {
    const upstreamResult = {
      content: [
        { type: 'text', text: 'complete' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
        {
          type: 'resource_link',
          name: 'report.pdf',
          uri: 'https://example.test/report.pdf',
          mimeType: 'application/pdf',
        },
        {
          type: 'resource',
          resource: {
            uri: 'file:///tmp/notes.md',
            mimeType: 'text/markdown',
            text: '# Notes',
          },
        },
      ],
      structuredContent: { status: 'ok', count: 5 },
      _meta: { traceId: 'trace-1' },
    } as McpToolCallResult;
    pool = new McpConnectionPool(stubLookup(stdioServer));
    seedFakeConnection(pool, 'demo', async () => upstreamResult);

    await expect(pool.callTool('demo', 'inspect', {})).resolves.toEqual({
      ...upstreamResult,
      isError: false,
    });
  });
});
