import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { TransportConfig } from '@mavis/mcp';

import {
  isRecord,
  readPluginJsonObject,
  type CanonicalPluginRoot,
} from '../plugin/package/filesystem.js';
import { PluginReaderError, readerFail } from '../plugin/package/reader-errors.js';
import type {
  PluginDeclaredTool,
  PluginMcpOAuthDescriptor,
  PluginMcpServer,
  PluginReaderDiagnostic,
  PluginResolvedMcpServer,
} from '../plugin/package/types.js';
import type { ParsedMcpServers } from './contracts.js';

export type { ParsedMcpServers } from './contracts.js';

const OFFICIAL_SERVER_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const TOOL_NAME = /^[A-Za-z0-9_.-]+$/u;
const OFFICIAL_STDIO_FIELDS = new Set([
  'type',
  'command',
  'args',
  'env',
  'description',
  'timeout',
  'tools',
]);
const OFFICIAL_REMOTE_FIELDS = new Set([
  'type',
  'url',
  'headers',
  'description',
  'timeout',
  'tools',
]);
const COMPATIBLE_FIELDS = new Set([...OFFICIAL_STDIO_FIELDS, ...OFFICIAL_REMOTE_FIELDS, 'oauth']);
const CODEX_FIELDS = new Set([...COMPATIBLE_FIELDS, 'scopes']);
/** Declaration fields that describe a server without changing what is started. */
const NON_LAUNCH_FIELDS = new Set(['description', 'timeout', 'tools']);
/** Credential-bearing or non-standard auth fields a server entry may never declare. */
const LEGACY_AUTH_FIELDS = new Set([
  'auth',
  'oauth2',
  'accessToken',
  'refreshToken',
  'clientId',
  'clientSecret',
]);
const LOCALHOST_CALLBACK_OAUTH_FIELDS = new Set([
  'clientId',
  'scopes',
  'callbackPort',
  'authServerMetadataUrl',
]);
const CODEX_OAUTH_FIELDS = new Set(['clientId', 'callbackPort', 'callbackUrl']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const COMPATIBLE_PLUGIN_ROOT_TOKEN = [
  '$',
  '{\u0043\u004c\u0041\u0055\u0044\u0045_PLUGIN_ROOT}',
].join('');

/** `official` covers official and MiniMax local packages; the others are compatible formats. */
type McpConfigMode = 'official' | 'localhost-callback' | 'codex';
export type CompatibleMcpFormat = Exclude<McpConfigMode, 'official'>;
type McpTransportType = 'stdio' | 'http' | 'streamable-http' | 'sse';

export async function readOfficialMcpFile(
  root: CanonicalPluginRoot,
  relativePath: string,
): Promise<ParsedMcpServers> {
  const { value } = await readPluginJsonObject(root, relativePath, { portable: true });
  assertExactFields(value, new Set(['$schema', 'schemaVersion', 'mcpServers']), 'MCP file');
  if (
    (value.$schema !== undefined && typeof value.$schema !== 'string') ||
    value.schemaVersion !== 1 ||
    !isRecord(value.mcpServers)
  ) {
    readerFail('MCP_SCHEMA_INVALID', `${relativePath} has an invalid V1 wrapper`);
  }
  if (Object.keys(value.mcpServers).length === 0) {
    readerFail('MCP_SCHEMA_INVALID', `${relativePath} contains no MCP server`);
  }
  const servers: PluginMcpServer[] = [];
  for (const [name, raw] of Object.entries(value.mcpServers)) {
    if (!OFFICIAL_SERVER_NAME.test(name) || name.length > 80 || !isRecord(raw)) {
      readerFail('MCP_SCHEMA_INVALID', `${relativePath} contains an invalid server entry`);
    }
    servers.push(await normalizeServer(root, name, raw, 'official'));
  }
  return { servers, diagnostics: [] };
}

/**
 * What a declared server starts: its validated declaration without the descriptive fields.
 * Root-relative values stay as declared, so the same package in another directory compares equal.
 */
export function mcpServerLaunchConfig(server: PluginMcpServer): Record<string, unknown> {
  const declared = JSON.parse(server.configJson) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(declared).filter(([field]) => !NON_LAUNCH_FIELDS.has(field)),
  );
}

export async function parseCompatibleMcpObject(
  root: CanonicalPluginRoot,
  value: Record<string, unknown>,
  format: CompatibleMcpFormat,
): Promise<ParsedMcpServers> {
  const map = isRecord(value.mcpServers) ? value.mcpServers : value;
  const servers: PluginMcpServer[] = [];
  const diagnostics: PluginReaderDiagnostic[] = [];
  for (const [name, raw] of Object.entries(map)) {
    if (!name.trim() || name.length > 80 || !isRecord(raw)) {
      diagnostics.push({ code: 'MCP_SCHEMA_INVALID', capability: 'MCP', name });
      continue;
    }
    try {
      servers.push(await normalizeServer(root, name, raw, format));
    } catch (error) {
      if (!(error instanceof PluginReaderError)) throw error;
      diagnostics.push({ code: error.code, capability: 'MCP', name });
    }
  }
  return { servers, diagnostics };
}

async function normalizeServer(
  root: CanonicalPluginRoot,
  name: string,
  raw: Record<string, unknown>,
  mode: McpConfigMode,
): Promise<PluginMcpServer> {
  assertSupportedAuthFields(raw, name, mode);
  const transportType = resolveTransportType(raw, name, mode);
  const allowedFields = fieldsForTransport(transportType, mode);
  const unknown = Object.keys(raw).find((key) => !allowedFields.has(key));
  if (unknown !== undefined) {
    if (mode === 'official') {
      readerFail('MCP_SCHEMA_INVALID', `${name} contains an unknown field`);
    }
    readerFail('MCP_CONFIG_UNSUPPORTED', `${name} contains an unsupported field`);
  }

  const timeout = optionalPositiveInteger(raw.timeout, name);
  const description = optionalString(raw.description, name);
  const declaredTools = readDeclaredTools(raw.tools, name);
  const transport = await normalizeTransport({ root, raw, type: transportType, mode, name });
  const oauth = readRemoteOAuth(raw, name, mode, transport);
  const resolvedServer: PluginResolvedMcpServer = {
    name,
    transport,
    enabled: true,
    ...(timeout !== undefined ? { timeout } : {}),
    ...(oauth ? { oauth } : {}),
  };
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    resolvedServer,
    declaredTools,
    configJson: JSON.stringify(raw),
  };
}

function assertSupportedAuthFields(
  raw: Record<string, unknown>,
  name: string,
  mode: McpConfigMode,
): void {
  if (mode === 'codex' && raw.oauth_resource !== undefined) {
    readerFail('MCP_OAUTH_UNSUPPORTED', `${name} declares an OAuth resource override`);
  }
  const keys = Object.keys(raw);
  if (mode === 'official') {
    // The MiniMax format declares no OAuth; remote servers still authorize through 401 discovery.
    if (keys.some((key) => key === 'oauth' || LEGACY_AUTH_FIELDS.has(key))) {
      readerFail('MCP_SCHEMA_INVALID', `${name} declares MCP OAuth`);
    }
    return;
  }
  if (keys.some((key) => LEGACY_AUTH_FIELDS.has(key))) {
    readerFail('MCP_OAUTH_UNSUPPORTED', `${name} declares MCP credentials`);
  }
}

/** OAuth applies to remote transports only and never together with a static Authorization. */
function readRemoteOAuth(
  raw: Record<string, unknown>,
  name: string,
  mode: McpConfigMode,
  transport: TransportConfig,
): PluginMcpOAuthDescriptor | undefined {
  if (mode === 'official') return undefined;
  const oauth =
    mode === 'codex'
      ? readCodexOAuth(raw.oauth, raw.scopes, name)
      : readLocalhostCallbackOAuth(raw.oauth, name);
  if (!oauth || transport.type === 'stdio') return undefined;
  if (hasAuthorizationHeader(transport.headers)) {
    readerFail('MCP_SCHEMA_INVALID', `${name} declares both OAuth and an Authorization header`);
  }
  return oauth;
}

function readLocalhostCallbackOAuth(
  value: unknown,
  name: string,
): PluginMcpOAuthDescriptor | undefined {
  if (value === undefined) return undefined;
  const label = `${name}.oauth`;
  const oauth = compatibleOAuthObject(value, LOCALHOST_CALLBACK_OAUTH_FIELDS, label);
  return oauthDescriptor({
    redirectFormat: 'localhost-callback',
    clientId: optionalString(oauth.clientId, `${label}.clientId`),
    scopes: oauth.scopes === undefined ? undefined : spaceSeparatedScopes(oauth.scopes, label),
    callbackPort: optionalCallbackPort(oauth.callbackPort, label),
    authServerMetadataUrl: optionalHttpsUrl(oauth.authServerMetadataUrl, label),
  });
}

function readCodexOAuth(
  value: unknown,
  scopes: unknown,
  name: string,
): PluginMcpOAuthDescriptor | undefined {
  if (value === undefined && scopes === undefined) return undefined;
  const label = `${name}.oauth`;
  const oauth = value === undefined ? {} : compatibleOAuthObject(value, CODEX_OAUTH_FIELDS, label);
  const clientId = optionalString(oauth.clientId, `${label}.clientId`);
  const codexCallbackUrl = optionalLoopbackCallbackUrl(oauth.callbackUrl, label);
  if (clientId !== undefined && codexCallbackUrl === undefined) {
    // Codex derives an unpublished per-server callback path without callbackUrl.
    readerFail('MCP_OAUTH_UNSUPPORTED', `${label} pre-registers a client without callbackUrl`);
  }
  return oauthDescriptor({
    redirectFormat: 'codex',
    clientId,
    scopes: scopes === undefined ? undefined : scopeArray(scopes, `${name}.scopes`),
    callbackPort: optionalCallbackPort(oauth.callbackPort, label),
    codexCallbackUrl,
  });
}

function compatibleOAuthObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) readerFail('MCP_SCHEMA_INVALID', `${label} is not an object`);
  if (value.clientSecret !== undefined) {
    readerFail('MCP_OAUTH_SECRET_UNSUPPORTED', `${label} declares a client secret`);
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    readerFail('MCP_CONFIG_UNSUPPORTED', `${label} contains an unsupported field`);
  }
  return value;
}

/** Drops absent fields so snapshots and lifecycle keys stay canonical. */
function oauthDescriptor(input: PluginMcpOAuthDescriptor): PluginMcpOAuthDescriptor {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as PluginMcpOAuthDescriptor;
}

function scopeArray(value: unknown, label: string): string[] {
  const scopes = stringArray(value, label);
  if (scopes.some((scope) => !scope || /\s/u.test(scope))) {
    readerFail('MCP_SCHEMA_INVALID', `${label} contains an invalid scope`);
  }
  return scopes;
}

function spaceSeparatedScopes(value: unknown, label: string): string[] {
  if (typeof value !== 'string')
    readerFail('MCP_SCHEMA_INVALID', `${label}.scopes is not a string`);
  return value.split(/\s+/u).filter(Boolean);
}

function optionalCallbackPort(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1024 || (value as number) > 65535) {
    readerFail('MCP_SCHEMA_INVALID', `${label}.callbackPort must be within 1024-65535`);
  }
  return value as number;
}

function optionalHttpsUrl(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const url = parseUrl(value);
  if (url?.protocol !== 'https:') {
    readerFail('MCP_SCHEMA_INVALID', `${label}.authServerMetadataUrl must be an https URL`);
  }
  return url.href;
}

function optionalLoopbackCallbackUrl(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const url = parseUrl(value);
  if (!url) readerFail('MCP_SCHEMA_INVALID', `${label}.callbackUrl is not a URL`);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    readerFail('MCP_OAUTH_UNSUPPORTED', `${label}.callbackUrl is not a loopback http URL`);
  }
  return (value as string).trim();
}

function parseUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return new URL(value.trim());
  } catch {
    return undefined;
  }
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === 'authorization');
}

function resolveTransportType(
  raw: Record<string, unknown>,
  name: string,
  mode: McpConfigMode,
): McpTransportType {
  const declaredType = readDeclaredTransportType(raw.type, mode);
  if (mode === 'official' && declaredType === undefined) {
    readerFail('MCP_SCHEMA_INVALID', `${name} has no transport type`);
  }
  const inferredType = declaredType ?? inferCompatibleTransport(raw);
  if (!isMcpTransportType(inferredType) || (mode === 'official' && inferredType === 'http')) {
    if (mode === 'official') readerFail('MCP_SCHEMA_INVALID', `${name} has an invalid transport`);
    readerFail('MCP_TRANSPORT_UNSUPPORTED', `${name} has an unsupported transport`);
  }
  return inferredType;
}

function readDeclaredTransportType(value: unknown, mode: McpConfigMode): string | undefined {
  if (mode === 'official') return typeof value === 'string' ? value : undefined;
  return stringValue(value);
}

function inferCompatibleTransport(raw: Record<string, unknown>): string | undefined {
  if (stringValue(raw.command)) return 'stdio';
  if (stringValue(raw.url)) return 'http';
  return undefined;
}

function isMcpTransportType(value: string | undefined): value is McpTransportType {
  return value === 'stdio' || value === 'http' || value === 'streamable-http' || value === 'sse';
}

function fieldsForTransport(type: McpTransportType, mode: McpConfigMode): ReadonlySet<string> {
  if (mode === 'codex') return CODEX_FIELDS;
  if (mode === 'localhost-callback') return COMPATIBLE_FIELDS;
  return type === 'stdio' ? OFFICIAL_STDIO_FIELDS : OFFICIAL_REMOTE_FIELDS;
}

async function normalizeTransport(input: {
  root: CanonicalPluginRoot;
  raw: Record<string, unknown>;
  type: McpTransportType;
  mode: McpConfigMode;
  name: string;
}): Promise<TransportConfig> {
  if (input.type === 'stdio') {
    return normalizeStdioTransport(input.root, input.raw, input.mode, input.name);
  }
  return normalizeRemoteTransport({ ...input, type: input.type });
}

async function normalizeStdioTransport(
  root: CanonicalPluginRoot,
  raw: Record<string, unknown>,
  mode: McpConfigMode,
  name: string,
): Promise<TransportConfig> {
  const command = stringValue(raw.command);
  if (!command) readerFail('MCP_SCHEMA_INVALID', `${name} has no stdio command`);
  if (mode === 'official' && /[/\\]/u.test(command)) {
    readerFail(
      'MCP_SCHEMA_INVALID',
      `${name} must launch package files through a PATH interpreter`,
    );
  }
  const args = raw.args === undefined ? [] : stringArray(raw.args, `${name}.args`);
  if (mode === 'official' && args.some(isCrossPlatformAbsolutePath)) {
    readerFail('MCP_SCHEMA_INVALID', `${name} contains an absolute stdio argument`);
  }
  const env = raw.env === undefined ? undefined : stringRecord(raw.env, `${name}.env`);
  return {
    type: 'stdio',
    command: await resolveRuntimeString(root, command, mode, true),
    args: await Promise.all(args.map((arg) => resolveRuntimeString(root, arg, mode))),
    ...(env
      ? {
          env: Object.fromEntries(
            Object.entries(env).map(([key, value]) => [
              key,
              expandCompatibleRoot(value, root.path, mode),
            ]),
          ),
        }
      : {}),
  };
}

function normalizeRemoteTransport(input: {
  root: CanonicalPluginRoot;
  raw: Record<string, unknown>;
  type: Exclude<McpTransportType, 'stdio'>;
  mode: McpConfigMode;
  name: string;
}): TransportConfig {
  const { root, raw, type, mode, name } = input;
  const url = stringValue(raw.url);
  if (!url || !isHttpUrl(url)) readerFail('MCP_SCHEMA_INVALID', `${name} has an invalid URL`);
  const headers =
    raw.headers === undefined ? undefined : stringRecord(raw.headers, `${name}.headers`);
  return {
    type: type === 'sse' ? 'sse' : 'http',
    url,
    ...(headers
      ? {
          headers: Object.fromEntries(
            Object.entries(headers).map(([key, value]) => [
              key,
              expandCompatibleRoot(value, root.path, mode),
            ]),
          ),
        }
      : {}),
  };
}

async function resolveRuntimeString(
  root: CanonicalPluginRoot,
  value: string,
  mode: McpConfigMode,
  mustExist = false,
): Promise<string> {
  const containsRoot = mode !== 'official' && value.includes(COMPATIBLE_PLUGIN_ROOT_TOKEN);
  const expanded = expandCompatibleRoot(value, root.path, mode);
  const isExplicitRelative = /^\.{1,2}[/\\]/u.test(value);
  if (!containsRoot && !isExplicitRelative) return expanded;
  const candidate = containsRoot
    ? path.resolve(expanded)
    : path.resolve(root.path, ...expanded.split(/[\\/]/u));
  if (!isInside(root.path, candidate))
    readerFail('PATH_OUTSIDE_ROOT', 'MCP path escapes Plugin root');
  try {
    const canonical = await realpath(candidate);
    if (!isInside(root.path, canonical)) {
      readerFail('PATH_OUTSIDE_ROOT', 'MCP path resolves outside Plugin root');
    }
    return canonical;
  } catch (error) {
    if (error instanceof PluginReaderError) throw error;
    if (mustExist) {
      readerFail('MCP_SCHEMA_INVALID', 'MCP command path does not exist');
    }
    return candidate;
  }
}

function isCrossPlatformAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function expandCompatibleRoot(value: string, root: string, mode: McpConfigMode): string {
  return mode === 'official' ? value : value.replaceAll(COMPATIBLE_PLUGIN_ROOT_TOKEN, root);
}

function readDeclaredTools(value: unknown, serverName: string): PluginDeclaredTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    readerFail('MCP_SCHEMA_INVALID', `${serverName}.tools is not an array`);
  const names = new Set<string>();
  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      readerFail('MCP_SCHEMA_INVALID', `${serverName}.tools[${index}] is not an object`);
    }
    assertExactFields(raw, new Set(['name', 'description', 'inputSchema']), 'MCP tool');
    const name = stringValue(raw.name);
    if (!name || name.length > 80 || !TOOL_NAME.test(name)) {
      readerFail('MCP_SCHEMA_INVALID', `${serverName} has an invalid declared tool`);
    }
    if (names.has(name)) {
      readerFail('MCP_SCHEMA_INVALID', `${serverName} contains duplicate declared tool names`);
    }
    names.add(name);
    const description = optionalString(raw.description, `${serverName}.${name}`);
    if (raw.inputSchema !== undefined && !isRecord(raw.inputSchema)) {
      readerFail('MCP_SCHEMA_INVALID', `${serverName}.${name} inputSchema is not an object`);
    }
    return {
      name,
      ...(description !== undefined ? { description } : {}),
      inputSchema: (raw.inputSchema as Record<string, unknown> | undefined) ?? {},
    };
  });
}

function assertExactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    readerFail('MCP_SCHEMA_INVALID', `${label} has an unknown field`);
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    readerFail('MCP_SCHEMA_INVALID', `${label} must contain only strings`);
  }
  return value as string[];
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    readerFail('MCP_SCHEMA_INVALID', `${label} must map strings to strings`);
  }
  return value as Record<string, string>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = stringValue(value);
  if (!parsed) readerFail('MCP_SCHEMA_INVALID', `${label} must be a non-empty string`);
  return parsed;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) {
    readerFail('MCP_SCHEMA_INVALID', `${label} timeout must be a positive integer`);
  }
  return value as number;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
