import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { LocalMcpServerConfig } from './contracts.js';
import { normalizeServerName, readRecord } from './runtime/config.js';
import { assertOAuthHeaderExclusive, parseMcpOAuthConfig } from './auth/oauth-config.js';

export interface ProjectMcpDocument {
  root: string;
  path: string;
  digest: string;
  entries: Array<{ name: string; config?: LocalMcpServerConfig; error?: string }>;
  error?: string;
}

export function projectMcpDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Read-only: never run profile migration or rewrite a repository-owned file. */
export async function readProjectMcpConfig(workspaceRoot: string): Promise<ProjectMcpDocument> {
  let root = resolve(workspaceRoot);
  let path = resolve(root, '.mcp.json');
  try {
    root = await realpath(root);
    path = resolve(root, '.mcp.json');
    const target = await realpath(path);
    const child = relative(root, target);
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
      throw new Error('Project MCP configuration must remain inside the workspace.');
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let text: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid MCP file.');
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024) throw new Error('MCP file is too large.');
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
    return parseProjectMcpConfig(root, path, text, process.env);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { root, path, digest: 'missing', entries: [] };
    }
    return {
      root,
      path,
      digest: 'unreadable',
      entries: [],
      error: 'Cannot read .mcp.json safely. Check JSON syntax, file size and workspace-local path.',
    };
  }
}

function parseProjectMcpConfig(
  root: string,
  path: string,
  text: string,
  env: NodeJS.ProcessEnv,
): ProjectMcpDocument {
  const document = readRecord(JSON.parse(text));
  const servers = readRecord(document?.['mcpServers']);
  if (!document || !servers) throw new Error('mcpServers must be an object.');
  const names = new Set<string>();
  const entries = Object.entries(servers).map(([rawName, value]) => {
    const name = normalizeServerName(rawName);
    if (names.has(name)) throw new Error('MCP names collide after normalization.');
    names.add(name);
    try {
      if (isReservedProjectMcpName(name)) {
        throw new Error('This MCP server name is reserved.');
      }
      return { name, config: parseServer(value, env) };
    } catch (error) {
      return { name, error: error instanceof Error ? error.message : 'Invalid MCP server.' };
    }
  });
  return { root, path, entries, digest: projectMcpDigest(JSON.stringify([text, entries])) };
}

function parseServer(value: unknown, env: NodeJS.ProcessEnv): LocalMcpServerConfig {
  const raw = readRecord(value);
  if (!raw) throw new Error('MCP server must be an object.');
  const type = raw['type'] ?? (raw['command'] ? 'stdio' : 'http');
  if (!['stdio', 'http', 'streamable-http', 'sse'].includes(String(type))) {
    throw new Error('Unsupported MCP transport.');
  }
  const common = {
    enabled: raw['enabled'] !== false,
    configured: true,
    builtin: false,
    ...(raw['timeout'] === undefined ? {} : { timeout: positiveTimeout(raw['timeout']) }),
  };
  if (type === 'stdio') {
    const args = raw['args'] ?? [];
    if (!Array.isArray(args)) throw new Error('MCP args must be a string array.');
    return {
      ...common,
      type,
      command: nonemptyCommand(expand(raw['command'], env)),
      args: args.map((arg) => expand(arg, env)),
      env: expandRecord(raw['env'], env),
    };
  }
  return { ...common, ...remoteServer(raw, type as 'http' | 'streamable-http' | 'sse', env) };
}

function remoteServer(
  raw: Record<string, unknown>,
  type: 'http' | 'streamable-http' | 'sse',
  env: NodeJS.ProcessEnv,
): LocalMcpServerConfig {
  const url = expand(raw['url'], env);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('MCP URL must be HTTP or HTTPS.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('MCP URL must be HTTP or HTTPS without embedded credentials.');
  }
  const headers = expandRecord(raw['headers'], env);
  // Repository-owned config may only pin the callback port (plan §6.1, §8).
  const oauth =
    raw['oauth'] === undefined ? undefined : parseMcpOAuthConfig(raw['oauth'], 'project');
  assertOAuthHeaderExclusive(oauth, headers);
  return { type, url, headers, ...(oauth ? { oauth: { ...oauth } } : {}) };
}

function nonemptyCommand(command: string): string {
  if (!command.trim()) throw new Error('MCP command must not be empty.');
  return command;
}

function expand(value: unknown, env: NodeJS.ProcessEnv): string {
  if (typeof value !== 'string') throw new Error('MCP configuration values must be strings.');
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu,
    (_match, name: string, fallback?: string) => {
      const resolved = env[name] ?? fallback;
      if (resolved === undefined) throw new Error(`Missing environment variable: ${name}.`);
      return resolved;
    },
  );
}

function expandRecord(value: unknown, env: NodeJS.ProcessEnv): Record<string, string> {
  if (value === undefined) return {};
  const record = readRecord(value);
  if (!record) throw new Error('MCP env and headers must be string maps.');
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, expand(item, env)]));
}

function positiveTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('MCP timeout must be a positive integer.');
  }
  return value;
}

export function isReservedProjectMcpName(name: string): boolean {
  return ['matrix', 'nd', 'cu', '__proto__', 'constructor', 'prototype'].includes(name);
}
