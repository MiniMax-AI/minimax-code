import { McpToolCallNotDispatchedError } from '@mavis/mcp';
import type { McpConnectionPool } from '@mavis/mcp/runtime/connection-pool';
import type { McpConnectionTokenOverrides } from '@mavis/mcp/runtime/types';

import type { McpServerAuth } from '../auth/server-auth.js';
import type { LocalMcpCallResult, LocalMcpServerConfig, LocalMcpToolInfo } from '../contracts.js';
import { configToTransportConfig, readConfiguredTools, readRecord } from '../runtime/config.js';
import { normalizeCallResult } from './result-mapping.js';

export interface LocalMcpUnfoldedCall {
  readonly server: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly signal: AbortSignal;
}

/** The `LocalMcpService` reads one unfolded call resolves its server and tool with. */
interface LocalMcpConfigReader {
  getServerConfig(server: string): Promise<LocalMcpServerConfig | undefined>;
  readonly serverAuth: Pick<McpServerAuth, 'listToolsLive'>;
}

/** The connection pieces `LocalMcpService` lends one unfolded call. */
interface LocalMcpLiveConnection {
  readonly pool: McpConnectionPool | undefined;
  overrides(config: LocalMcpServerConfig): Promise<McpConnectionTokenOverrides | undefined>;
  signal(config: LocalMcpServerConfig): AbortSignal;
  /** Clears an earlier failure mark of the server; a failed call here never sets one. */
  recorded(config: LocalMcpServerConfig): void;
}

/** The call never left the Host, for a reason the caller can act on. */
export class LocalMcpCallRefusedError extends Error {
  override readonly name = 'LocalMcpCallRefusedError';

  constructor(
    readonly code: 'MCP_SERVER_UNAVAILABLE' | 'TOOL_REF_STALE',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * The Mini App tool port's call: the same server, tool, and mock resolution as
 * `LocalMcpService.call`, without folding failures into an error result. A refusal before
 * dispatch throws `LocalMcpCallRefusedError`; whatever the pool throws (not dispatched, server
 * timeout, a dropped connection, a cancel in flight) reaches the caller as it is and does not mark
 * the server failed. A result the tool itself marked `isError` resolves unchanged.
 */
export async function callLocalMcpToolUnfolded(
  service: LocalMcpConfigReader,
  input: LocalMcpUnfoldedCall,
  live: LocalMcpLiveConnection,
): Promise<LocalMcpCallResult> {
  const { server, toolName, args, signal } = input;
  const config = await listedServerConfig(service, input);
  const mocked = readRecord(readRecord(config.metadata?.['mockResponses'])?.[toolName]);
  if (mocked) return normalizeCallResult(mocked);
  const { pool } = live;
  if (!pool || !configToTransportConfig(config)) {
    throw new LocalMcpCallRefusedError(
      'MCP_SERVER_UNAVAILABLE',
      `MCP server "${server}" has no usable connection`,
    );
  }
  const overrides = await connectionOverrides(live, config, server);
  if (signal.aborted) throw new McpToolCallNotDispatchedError(server, toolName);
  const result = await pool.callTool(server, toolName, args, overrides, {
    ...(config.timeout && config.timeout > 0 ? { timeout: config.timeout } : {}),
    signal: live.signal(config),
  });
  live.recorded(config);
  return result;
}

/** The enabled server's config, once it is known to list the tool. */
async function listedServerConfig(
  service: LocalMcpConfigReader,
  { server, toolName }: LocalMcpUnfoldedCall,
): Promise<LocalMcpServerConfig> {
  const config = await service.getServerConfig(server);
  if (!config || config.enabled === false) {
    throw new LocalMcpCallRefusedError('MCP_SERVER_UNAVAILABLE', `MCP server "${server}" is off`);
  }
  const lists = (tools: readonly LocalMcpToolInfo[]) =>
    tools.some((tool) => tool.name === toolName);
  if (lists(readConfiguredTools(config))) return config;
  const live = await service.serverAuth.listToolsLive(server);
  if (live.authError) {
    throw new LocalMcpCallRefusedError(
      'MCP_SERVER_UNAVAILABLE',
      `MCP server "${server}" requires authorization`,
      { cause: live.authError },
    );
  }
  if (!lists(live.tools)) {
    throw new LocalMcpCallRefusedError('TOOL_REF_STALE', `MCP tool "${toolName}" is not listed`);
  }
  return config;
}

async function connectionOverrides(
  live: LocalMcpLiveConnection,
  config: LocalMcpServerConfig,
  server: string,
): Promise<McpConnectionTokenOverrides | undefined> {
  try {
    return await live.overrides(config);
  } catch (error) {
    throw new LocalMcpCallRefusedError(
      'MCP_SERVER_UNAVAILABLE',
      `MCP server "${server}" credentials are unavailable`,
      { cause: error },
    );
  }
}
