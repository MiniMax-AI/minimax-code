/**
 * Minimal MCP runtime types for the shared MCP substrate.
 *
 * Adapted from the retired `packages/daemon/src/mcp/types.ts`. We trim the
 * legacy daemon surface (OAuth2 flow, manifest entries, lock-file write
 * mediator) down to what Mavis runtimes need to spawn MCP transports, run
 * `tools/list` / `tools/call`, and recover stderr.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpAuthRequiredError, McpRequestAuthorizer } from './auth.js';

export interface StdioTransportConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Optional process working directory. Existing MCP sources retain the home-directory default. */
  cwd?: string;
}

export interface HttpTransportConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  /** Prevent package-configured headers from following a cross-origin redirect. */
  protectHeadersOnRedirect?: boolean;
}

export interface SseTransportConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  /** Prevent package-configured headers from following a cross-origin redirect. */
  protectHeadersOnRedirect?: boolean;
}

export type TransportConfig = StdioTransportConfig | HttpTransportConfig | SseTransportConfig;

/** Hardcoded defaults — server-level fields fall back to these when not set. */
export const MCP_DEFAULTS = {
  /** Per-call timeout in ms; tuned for matrix biz-gateway worst-case multimodal RPCs. */
  timeout: 120_000,
  /** Per-server semaphore size. */
  maxConcurrency: 5,
} as const;

/**
 * Resolved server descriptor handed to the connection pool. The caller
 * is responsible for inferring `transport` from its config source and gating
 * `enabled`.
 */
export interface ResolvedMcpServer {
  /** Explicit roots/list identity for project-scoped connections. */
  workspaceRoot?: string;
  name: string;
  transport: TransportConfig;
  enabled: boolean;
  /** Per-server tool-call timeout override (ms). */
  timeout?: number;
}

/** Cached tool descriptor for a single MCP server. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Lossless tool-call result from the MCP SDK.
 *
 * Keep this as the protocol-owned type rather than maintaining a local flat
 * approximation: standard results may contain audio, resource links, embedded
 * text/blob resources, and structuredContent in addition to text/images.
 */
export type McpToolCallResult = CallToolResult;

export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type McpConnectionKey = string;

/** Internal pool record — not exported as a stable product API. */
export interface McpConnection {
  key: McpConnectionKey;
  name: string;
  state: McpConnectionState;
  client: Client | null;
  transport: Transport | null;
  tools: McpToolInfo[] | null;
  lastUsed: number;
  error?: string;
  /** Set by the authorized fetch layer when this connection can no longer authorize. */
  lastAuthFailure?: McpAuthRequiredError;
}

/**
 * Per-call overrides layered on top of the transport config at spawn time.
 * `env` is merged into the stdio child's process env; `headers` is merged
 * into the http/sse transport `requestInit`.
 */
export interface McpConnectionTokenOverrides {
  /**
   * Connection scope for transports whose child process/session captures host context
   * at spawn time. Omission selects the server's default scope. The pool encodes
   * this scope together with the logical server name as an internal cache key.
   */
  connectionKey?: McpConnectionKey;
  /**
   * Turn/session-scoped server descriptor supplied by a trusted in-process host.
   * This keeps ephemeral ACP MCP configuration out of the persisted server lookup.
   */
  serverOverride?: ResolvedMcpServer;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /**
   * OAuth request authorizer for http/sse transports. Never serialized into config or
   * snapshots; when present the transport uses the authorized fetch layer and the pool
   * classifies authorization failures as `McpAuthRequiredError`.
   */
  authorizer?: McpRequestAuthorizer;
}

export interface McpCallOptions {
  /** Per-call timeout in ms. Falls back to per-server config, then MCP_DEFAULTS.timeout. */
  timeout?: number;
  /**
   * Per-call abort signal, forwarded to the underlying MCP `client.callTool`.
   * The SDK reacts to abort by rejecting the pending JSON-RPC promise with an
   * `McpError` and sending a `notifications/cancelled` frame to the server, so
   * the caller returns immediately instead of waiting for the pool timeout.
   * Wire this from a turn-level AbortSignal so an abort during a long-running
   * remote MCP tool call (e.g. generation endpoints) unblocks the pi turn
   * without waiting for the tool to complete.
   */
  signal?: AbortSignal;
  /**
   * Request `_meta` sent with this `tools/call`. Hosts use it for call context the
   * tool schema does not carry, such as an opaque conversation id.
   */
  meta?: Record<string, unknown>;
}

/**
 * Pluggable logger. The MCP substrate emits no console output of its own;
 * hosts inject a logger that matches their logging conventions. The default
 * no-op logger is fine for unit tests; production callers should wire a real
 * one so MCP child crashes are diagnosable.
 */
export interface McpRuntimeLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

export const NOOP_MCP_RUNTIME_LOGGER: McpRuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Optional host-injected metrics port for the connection pool, mirroring the
 * `incr`/`latency` module-reporter shape used by the other agent-modules
 * (cron, hooks) so hosts can pass their existing reporter verbatim.
 *
 * Contract:
 *   * Metric names are BARE snake_case (`mcp_connect_total`); the metrics
 *     server prepends the service prefix on ingest.
 *   * Label values must be bounded enums. Server names are user-defined and
 *     unbounded — they are NEVER emitted as labels; per-server detail
 *     belongs in the injected `McpRuntimeLogger` fields instead.
 *   * Absent port = noop: the pool must behave identically without it.
 */
export interface McpPoolMetrics {
  incr(name: string, tags?: Record<string, string>): void;
  latency(name: string, durationMs: number, tags?: Record<string, string>): void;
}

/**
 * Stderr-line observer registration. The connection pool buffers each stdio
 * child's stderr into newline-terminated lines, calls each registered
 * observer with the trimmed line, and also forwards to the logger.
 *
 * Observers must not throw — the pool catches and logs.warn on rejection so a
 * bad observer can never wedge the stderr drain loop.
 */
export type StderrLineObserver = (serverName: string, line: string) => void;
