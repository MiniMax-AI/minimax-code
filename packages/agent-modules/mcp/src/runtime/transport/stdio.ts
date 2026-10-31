/**
 * Stdio MCP transport for Mavis runtimes.
 *
 * Ported from the retired `packages/daemon/src/mcp/runtime/transport/stdio.ts`,
 * narrowed to the surface Mavis runtimes need:
 *
 *   * `cwd: homedir()` — never inherit launchd / Electron / systemd CWD (which
 *     can be `/`), so MCP children that write workspace-relative dirs
 *     (such as Playwright's `.playwright-mcp/`) don't
 *     ENOENT against `/`.
 *   * `stderr: 'pipe'` — the SDK creates a PassThrough but no consumer
 *     attaches by default. The connection pool's `attachStderrLogging` reads
 *     this stream and emits per-line log records; without `'pipe'` here that
 *     hook would silently no-op. We also attach an error handler to the raw
 *     child stderr pipe because Node does not forward source stream errors
 *     through `.pipe()`.
 *   * `env` constructed as `{ ...process.env, ...config.env, ...injected.env }`
 *     — injected env wins so host-provided identity or policy data can
 *     override any stale value baked into config or leaking from the parent
 *     process env.
 *   * `maxBufferSize: MCP_STDIO_MAX_MESSAGE_BYTES` — the SDK default (10 MiB)
 *     closes the connection when one JSON-RPC message is larger, which a single
 *     full-resolution image result easily exceeds. Oversized images are
 *     re-encoded later, before they reach a model request.
 */
import { homedir } from 'node:os';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { StdioTransportConfig } from '../types.js';

export const MCP_STDIO_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export interface McpStdioTransportOptions {
  env?: Record<string, string>;
}

export function createStdioTransport(
  config: StdioTransportConfig,
  options?: McpStdioTransportOptions,
): Transport {
  return new SafeStdioClientTransport({
    command: config.command,
    args: config.args,
    env: buildProcessEnv(config.env, options?.env),
    cwd: config.cwd ?? homedir(),
    stderr: 'pipe',
    maxBufferSize: MCP_STDIO_MAX_MESSAGE_BYTES,
  });
}

class SafeStdioClientTransport extends StdioClientTransport {
  override async start(): Promise<void> {
    await super.start();
    const childProcess = (
      this as unknown as {
        _process?: { stderr?: NodeJS.ReadableStream | null };
      }
    )._process;
    childProcess?.stderr?.on?.('error', (error: Error) => {
      this.onerror?.(error);
    });
  }
}

function buildProcessEnv(
  configEnv?: Record<string, string>,
  injectedEnv?: Record<string, string>,
): Record<string, string> {
  return {
    ...getProcessEnv(),
    ...(configEnv ?? {}),
    ...(injectedEnv ?? {}),
  };
}

function getProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}
