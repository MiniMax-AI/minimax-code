import { Type, type TSchema } from '@sinclair/typebox';
import fs from 'node:fs';

import { inferTransport, readRecord } from './config.js';
import {
  assertOAuthHeaderExclusive,
  McpOAuthConfigError,
  parseMcpOAuthConfig,
} from '../auth/oauth-config.js';

import type {
  ConfiguredMcpConnectionTestResult,
  ConfiguredMcpServerDetail,
  ConfiguredMcpServerInput,
  ConfiguredMcpServerSummary,
  LocalMcpOAuthConfig,
  LocalMcpPublicServerStatus,
  LocalMcpManagedServerSummary,
  LocalMcpServerConfig,
} from '../contracts.js';
import { LocalMcpSettingsError } from '../errors.js';

const DEFAULT_INPUT_SCHEMA = Type.Object({}, { additionalProperties: true });
interface LocalMcpFile {
  mcpServers: Record<string, LocalMcpServerConfig>;
}
export function validateConfiguredServerName(name: string): string {
  const serverName = name.trim();
  if (serverName.length === 0 || serverName.length > 80 || !/^[a-zA-Z0-9_.-]+$/u.test(serverName)) {
    throw new LocalMcpSettingsError(
      400,
      'MCP server name must use 1-80 letters, numbers, dots, underscores, or hyphens.',
      'MCP_CONFIG_INVALID',
    );
  }
  return serverName;
}

export function isUserConfiguredServer(config: LocalMcpServerConfig): boolean {
  return config.configured !== false && config.builtin !== true;
}

export function requireUserConfiguredServer(
  file: LocalMcpFile,
  serverName: string,
): LocalMcpServerConfig {
  const config = file.mcpServers[serverName];
  if (!config || !isUserConfiguredServer(config)) {
    throw new LocalMcpSettingsError(
      404,
      `MCP server "${serverName}" was not found.`,
      'MCP_SERVER_NOT_FOUND',
    );
  }
  return config;
}

export function configuredInputFromStored(
  config: LocalMcpServerConfig,
): ConfiguredMcpServerInput | undefined {
  const transport = inferTransport(config);
  const common = configuredCommon(config);
  if (transport === 'stdio' && config.command) {
    return {
      transport,
      command: config.command,
      ...(config.args ? { args: [...config.args] } : {}),
      ...(config.env ? { env: { ...config.env } } : {}),
      ...common,
    };
  }
  if (
    (transport === 'http' || transport === 'streamable-http' || transport === 'sse') &&
    config.url
  ) {
    return remoteInputFromStored(transport, config.url, config, common);
  }
  return undefined;
}

/** A stored `oauth` block that is no longer valid makes the entry unprojectable. */
function remoteInputFromStored(
  transport: 'http' | 'streamable-http' | 'sse',
  url: string,
  config: LocalMcpServerConfig,
  common: ReturnType<typeof configuredCommon>,
): ConfiguredMcpServerInput | undefined {
  let oauth: LocalMcpOAuthConfig | undefined;
  try {
    oauth = config.oauth === undefined ? undefined : parseMcpOAuthConfig(config.oauth, 'user');
    assertOAuthHeaderExclusive(oauth, config.headers);
  } catch {
    return undefined;
  }
  return {
    transport,
    url,
    ...(config.headers ? { headers: { ...config.headers } } : {}),
    ...(oauth ? { oauth } : {}),
    ...common,
  };
}

function configuredCommon(config: LocalMcpServerConfig) {
  return {
    ...(config.timeout && config.timeout > 0 ? { timeoutMs: config.timeout } : {}),
    ...(config.description ? { description: config.description } : {}),
  };
}

export function requireConfiguredInput(config: LocalMcpServerConfig): ConfiguredMcpServerInput {
  const input = configuredInputFromStored(config);
  if (!input) {
    throw new Error('Normalized MCP server configuration could not be projected.');
  }
  return input;
}

export function storedConfigFromInput(
  input: ConfiguredMcpServerInput,
  enabled: boolean,
): LocalMcpServerConfig {
  const description = input.description?.trim();
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
  ) {
    throw new LocalMcpSettingsError(
      400,
      'MCP server timeout must be a positive integer in milliseconds.',
      'MCP_CONFIG_INVALID',
    );
  }
  const common: LocalMcpServerConfig = {
    type: input.transport,
    enabled,
    configured: true,
    builtin: false,
    ...(input.timeoutMs ? { timeout: input.timeoutMs } : {}),
    ...(description ? { description } : {}),
  };
  return storedTransportFields(input, common);
}
function storedTransportFields(
  input: ConfiguredMcpServerInput,
  common: LocalMcpServerConfig,
): LocalMcpServerConfig {
  if (input.transport === 'stdio') {
    const command = input.command.trim();
    if (!command) {
      throw new LocalMcpSettingsError(
        400,
        'A command is required for stdio MCP servers.',
        'MCP_CONFIG_INVALID',
      );
    }
    return {
      ...common,
      command,
      ...(input.args ? { args: input.args.map((arg) => String(arg)) } : {}),
      ...(input.env ? { env: normalizeConfiguredKeyValues(input.env, 'environment') } : {}),
    };
  }
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new LocalMcpSettingsError(
      400,
      'A valid HTTP or HTTPS URL is required for remote MCP servers.',
      'MCP_CONFIG_INVALID',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LocalMcpSettingsError(
      400,
      'A valid HTTP or HTTPS URL is required for remote MCP servers.',
      'MCP_CONFIG_INVALID',
    );
  }
  return { ...common, url: url.toString(), ...storedCredentialFields(input) };
}

function storedCredentialFields(
  input: Extract<ConfiguredMcpServerInput, { url: string }>,
): Pick<LocalMcpServerConfig, 'headers' | 'oauth'> {
  const headers = input.headers ? normalizeConfiguredKeyValues(input.headers, 'header') : undefined;
  const oauth = input.oauth === undefined ? undefined : settingsOAuthConfig(input.oauth, headers);
  return { ...(headers ? { headers } : {}), ...(oauth ? { oauth: { ...oauth } } : {}) };
}

/**
 * Old runtime upsert applies the settings OAuth rules, so it can never store a
 * client secret or an entry that later fails its server's projection.
 */
export function withValidatedOAuth(config: LocalMcpServerConfig): LocalMcpServerConfig {
  if (config.oauth === undefined) return config;
  const { oauth: raw, ...rest } = config;
  const oauth = settingsOAuthConfig(raw, config.headers);
  return oauth ? { ...rest, oauth: { ...oauth } } : rest;
}

/** An empty block adds nothing over zero-config OAuth discovery, so it is not stored. */
function settingsOAuthConfig(
  value: unknown,
  headers: Record<string, string> | undefined,
): LocalMcpOAuthConfig | undefined {
  try {
    const oauth = parseMcpOAuthConfig(value, 'user');
    if (Object.keys(oauth).length === 0) return undefined;
    assertOAuthHeaderExclusive(oauth, headers);
    return oauth;
  } catch (error) {
    if (!(error instanceof McpOAuthConfigError)) throw error;
    throw new LocalMcpSettingsError(400, error.message, 'MCP_CONFIG_INVALID');
  }
}

export class ConfiguredMcpConnectionTimeoutError extends Error {
  constructor() {
    super('Configured MCP connection test timed out.');
    this.name = 'ConfiguredMcpConnectionTimeoutError';
  }
}

export async function withConfiguredConnectionTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          onTimeout?.();
          reject(new ConfiguredMcpConnectionTimeoutError());
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function configuredConnectionFailure(
  error: unknown,
  config: LocalMcpServerConfig,
): ConfiguredMcpConnectionTestResult {
  if (error instanceof ConfiguredMcpConnectionTimeoutError) {
    return {
      success: false,
      errorCode: 'MCP_CONNECTION_TIMEOUT',
      errorMessage: 'Connection timed out. Check the server configuration and try again.',
    };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : '';
  if (
    config.type === 'stdio' &&
    (code === 'ENOENT' || /(?:\bENOENT\b|command not found|not recognized)/iu.test(message))
  ) {
    return {
      success: false,
      errorCode: 'MCP_COMMAND_NOT_FOUND',
      errorMessage: 'The configured command could not be found.',
    };
  }
  if (/^(?:Failed to connect to MCP server|MCP list tools failed):?/u.test(message)) {
    return {
      success: false,
      errorCode: 'MCP_HANDSHAKE_FAILED',
      errorMessage: 'The MCP handshake failed. Check the server configuration and try again.',
    };
  }
  return {
    success: false,
    errorCode: 'MCP_CONNECTION_FAILED',
    errorMessage: 'Connection failed. Check the server configuration and try again.',
  };
}

function normalizeConfiguredKeyValues(
  values: Record<string, string>,
  label: 'environment' | 'header',
): Record<string, string> {
  const entries = Object.entries(values);
  if (entries.some(([key]) => !key.trim())) {
    throw new LocalMcpSettingsError(
      400,
      `MCP ${label} keys cannot be empty.`,
      'MCP_CONFIG_INVALID',
    );
  }
  const normalized = entries.map(([key, value]) => [key.trim(), String(value)] as const);
  if (
    label === 'header' &&
    new Set(normalized.map(([key]) => key.toLowerCase())).size !== normalized.length
  ) {
    throw new LocalMcpSettingsError(
      400,
      'MCP header keys must be unique (case-insensitive).',
      'MCP_CONFIG_INVALID',
    );
  }
  return Object.fromEntries(normalized);
}

export async function replacementFileMode(filePath: string): Promise<number> {
  if (process.platform === 'win32') return 0o600;
  try {
    const existingMode = (await fs.promises.stat(filePath)).mode & 0o777;
    return existingMode & 0o600;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0o600;
    throw error;
  }
}

export function assertStoredMcpServerConfig(config: Record<string, unknown>): void {
  assertOptionalString(config, 'command');
  assertOptionalString(config, 'url');
  assertOptionalString(config, 'description');
  assertOptionalStringArray(config, 'args');
  assertOptionalStringRecord(config, 'env', false);
  assertOptionalStringRecord(config, 'headers', true);
  assertOptionalRecord(config, 'auth');
  assertOptionalRecord(config, 'metadata');
  assertOptionalBoolean(config, 'enabled');
  assertOptionalBoolean(config, 'configured');
  assertOptionalBoolean(config, 'builtin');
  assertOptionalPositiveInteger(config, 'timeout');
  assertOptionalStoredTransport(config['type']);
  assertOptionalStoredTools(config['tools']);
  // `oauth` is never checked here: an invalid block breaks only that server's projection.
}

function assertOptionalString(config: Record<string, unknown>, key: string): void {
  if (config[key] !== undefined && typeof config[key] !== 'string') throwInvalidStoredConfig();
}

function assertOptionalStringArray(config: Record<string, unknown>, key: string): void {
  const value = config[key];
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
  ) {
    throwInvalidStoredConfig();
  }
}

function assertOptionalStringRecord(
  config: Record<string, unknown>,
  key: string,
  caseInsensitive: boolean,
): void {
  const value = config[key];
  if (value === undefined) return;
  const record = readRecord(value);
  if (!record) throwInvalidStoredConfig();
  const keys = Object.keys(record).map((entry) => entry.trim());
  if (
    keys.some((entry) => !entry) ||
    Object.values(record).some((entry) => typeof entry !== 'string')
  ) {
    throwInvalidStoredConfig();
  }
  if (caseInsensitive && new Set(keys.map((entry) => entry.toLowerCase())).size !== keys.length) {
    throwInvalidStoredConfig();
  }
}

function assertOptionalRecord(config: Record<string, unknown>, key: string): void {
  if (config[key] !== undefined && !readRecord(config[key])) throwInvalidStoredConfig();
}

function assertOptionalBoolean(config: Record<string, unknown>, key: string): void {
  if (config[key] !== undefined && typeof config[key] !== 'boolean') throwInvalidStoredConfig();
}

function assertOptionalPositiveInteger(config: Record<string, unknown>, key: string): void {
  const value = config[key];
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) <= 0)) {
    throwInvalidStoredConfig();
  }
}

function assertOptionalStoredTransport(value: unknown): void {
  if (
    value !== undefined &&
    value !== 'stdio' &&
    value !== 'http' &&
    value !== 'streamable-http' &&
    value !== 'sse'
  ) {
    throwInvalidStoredConfig();
  }
}

function assertOptionalStoredTools(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throwInvalidStoredConfig();
  for (const item of value) {
    const tool = readRecord(item);
    if (!tool || typeof tool['name'] !== 'string') throwInvalidStoredConfig();
    assertOptionalString(tool, 'description');
    assertOptionalRecord(tool, 'inputSchema');
    assertOptionalRecord(tool, 'input_schema');
  }
}

function throwInvalidStoredConfig(): never {
  throw new SyntaxError('MCP server entry does not match the configured schema.');
}

export function configuredSummary(
  name: string,
  stored: LocalMcpServerConfig,
  input: ConfiguredMcpServerInput,
): ConfiguredMcpServerSummary {
  return {
    name,
    enabled: stored.enabled !== false,
    transport: input.transport,
    ...(input.description ? { description: input.description } : {}),
    endpoint: safeConfiguredEndpoint(input),
    configJson: '{}',
  };
}

function safeConfiguredEndpoint(input: ConfiguredMcpServerInput): string {
  if (input.transport === 'stdio') {
    return input.command.split(/[\\/]/u).at(-1) ?? input.command;
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return '';
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, input.url.endsWith('/') ? '/' : '');
}

export function configuredDetail(
  name: string,
  stored: LocalMcpServerConfig,
  input: ConfiguredMcpServerInput,
): ConfiguredMcpServerDetail {
  return { name, enabled: stored.enabled !== false, config: input };
}

export function requireSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) throw new Error('Session MCP servers require a non-empty session id.');
  return normalized;
}

export function sessionMcpConnectionKey(sessionId: string, server: string): string {
  return `acp-session:${sessionId}:${server}`;
}

export function toTypeSchema(schema: Record<string, unknown>): TSchema {
  return Object.keys(schema).length > 0 ? ({ ...schema } as TSchema) : DEFAULT_INPUT_SCHEMA;
}

export function publicTransport(
  config: LocalMcpServerConfig,
): LocalMcpPublicServerStatus['transport'] {
  const transport = inferTransport(config);
  if (transport === 'streamable-http') return 'http';
  if (transport === 'stdio' || transport === 'http' || transport === 'sse') return transport;
  return 'none';
}

export function toManagedServerSummary(
  name: string,
  rawConfig: Record<string, unknown>,
  config: LocalMcpServerConfig,
): LocalMcpManagedServerSummary {
  return {
    name,
    enabled: config.enabled !== false,
    transport: inferTransport(config),
    ...(config.description ? { description: config.description } : {}),
    // The ignored legacy `auth` block may hold tokens and is never projected.
    configJson: JSON.stringify({ ...rawConfig, auth: undefined }),
  };
}
