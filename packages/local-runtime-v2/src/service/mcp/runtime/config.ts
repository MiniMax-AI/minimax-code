import { buildMcpToolRuntimeName } from '@mavis/mcp';

import { MCP_DEFAULTS } from '@mavis/mcp/runtime/types';
import type { TransportConfig } from '@mavis/mcp/runtime/types';
import type { LocalMcpServerConfig, LocalMcpToolInfo } from '../contracts.js';
import { isBuiltinMatrixConfig } from './builtin-matrix.js';

export function hasLocalCallAdapter(config: LocalMcpServerConfig): boolean {
  return !!readRecord(config.metadata?.['mockResponses']) || !!configToTransportConfig(config);
}

/**
 * Map an mcp.json server config onto the runtime `TransportConfig`. Returns
 * undefined if the entry has neither a command (stdio) nor a url (http/sse),
 * so the caller can fail closed.
 */
export function configToTransportConfig(config: LocalMcpServerConfig): TransportConfig | undefined {
  const type = config.type;
  if (type === 'stdio' || (!type && config.command)) {
    if (!config.command) return undefined;
    return {
      type: 'stdio',
      command: config.command,
      args: config.args ?? [],
      ...(config.env ? { env: config.env } : {}),
    };
  }
  return remoteTransport(config);
}
function remoteTransport(config: LocalMcpServerConfig): TransportConfig | undefined {
  const type = config.type;
  if (type === 'sse' && config.url)
    return { type: 'sse', url: config.url, ...(config.headers ? { headers: config.headers } : {}) };
  if (type === 'http' || type === 'streamable-http' || (!type && config.url)) {
    if (!config.url) return undefined;
    return {
      type: 'http',
      url: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
    };
  }
  return undefined;
}

/** Configuration keys are identities; normalize only their model-visible projection. */
export function normalizeServerName(name: string): string {
  return name;
}

export function normalizeServerConfig(config: Record<string, unknown>): LocalMcpServerConfig {
  return {
    ...(readString(config['command']) ? { command: readString(config['command']) } : {}),
    ...(Array.isArray(config['args'])
      ? { args: config['args'].filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(readRecord(config['env']) ? { env: readStringRecord(config['env']) } : {}),
    ...(readString(config['url']) ? { url: readString(config['url']) } : {}),
    ...(readTransport(config['type']) ? { type: readTransport(config['type']) } : {}),
    ...(readRecord(config['oauth']) ? { oauth: readRecord(config['oauth']) } : {}),
    enabled: config['enabled'] !== false,
    configured: config['configured'] !== false,
    builtin: config['builtin'] === true,
    ...normalizeServerMetadata(config),
  };
}
function normalizeServerMetadata(config: Record<string, unknown>): Partial<LocalMcpServerConfig> {
  return {
    ...(readString(config['description'])
      ? { description: readString(config['description']) }
      : {}),
    ...(typeof config['timeout'] === 'number' ? { timeout: config['timeout'] } : {}),
    ...(readRecord(config['metadata']) ? { metadata: readRecord(config['metadata']) } : {}),
    ...(readRecord(config['headers']) ? { headers: readStringRecord(config['headers']) } : {}),
    ...(Array.isArray(config['tools']) ? { tools: normalizeTools(config['tools']) } : {}),
  };
}

export function readConfiguredTools(config: LocalMcpServerConfig): LocalMcpToolInfo[] {
  const fromMetadata = Array.isArray(config.metadata?.['tools'])
    ? normalizeTools(config.metadata['tools'])
    : [];
  return normalizeTools([...(config.tools ?? []), ...fromMetadata]);
}

export function inferTransport(config: LocalMcpServerConfig): string {
  if (config.type) return config.type;
  if (config.url) return 'http';
  if (config.command) return 'stdio';
  return 'none';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function buildNativeToolName(
  server: string,
  tool: string,
  config: LocalMcpServerConfig,
): string {
  if (isBuiltinMatrixConfig(server, config)) {
    return tool.replace(/[^a-zA-Z0-9_]/gu, '_').slice(0, 80);
  }
  return buildMcpToolRuntimeName(server, tool);
}

function normalizeTools(value: unknown[]): LocalMcpToolInfo[] {
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const name = readString(record['name']);
    if (!name) return [];
    return [
      {
        name,
        ...(readString(record['description'])
          ? { description: readString(record['description']) }
          : {}),
        inputSchema: readRecord(record['inputSchema']) ?? readRecord(record['input_schema']) ?? {},
      },
    ];
  });
}

function readStringRecord(value: unknown): Record<string, string> {
  const record = readRecord(value) ?? {};
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function readTransport(value: unknown): LocalMcpServerConfig['type'] | undefined {
  return value === 'stdio' || value === 'http' || value === 'sse' || value === 'streamable-http'
    ? value
    : undefined;
}

function discoveryTimeoutFromEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim() ?? '';
  const timeout = Number(value);
  // Node timers overflow beyond signed int32 and would fire after 1 ms instead.
  return /^\d+$/.test(value) &&
    Number.isSafeInteger(timeout) &&
    timeout > 0 &&
    timeout <= 2_147_483_647
    ? timeout
    : fallback;
}

export function stdioDiscoveryTimeoutFromEnv(): number {
  return discoveryTimeoutFromEnv('MCODE_MCP_STDIO_DISCOVERY_TIMEOUT_MS', 30_000);
}

/**
 * Turn discovery budget for http/sse/streamable-http servers. A cold remote
 * handshake (connect + initialize + tools/list) routinely takes 1-3.5 s and can
 * be much slower behind proxies or OAuth, so the default matches stdio.
 */
export function remoteDiscoveryTimeoutFromEnv(): number {
  return discoveryTimeoutFromEnv('MCODE_MCP_REMOTE_DISCOVERY_TIMEOUT_MS', 30_000);
}

export function configuredTimeout(config: LocalMcpServerConfig): number {
  return config.timeout && config.timeout > 0 ? config.timeout : MCP_DEFAULTS.timeout;
}
