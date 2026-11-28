/**
 * HTTP / SSE MCP transport for Mavis runtimes.
 *
 * Ported from the retired `packages/daemon/src/mcp/runtime/transport/http.ts`.
 * Built on top of `@modelcontextprotocol/sdk` rather than hand-rolling fetch
 * loops — the SDK handles request/response framing, SSE reconnect, and
 * Streamable-HTTP session continuity. We inject headers (e.g. archon
 * identity) via `requestInit` and optionally thread the host fetch through
 * the SDK transport for proxy / enterprise-CA aware environments.
 *
 * With an OAuth authorizer, or when configured headers must not follow cross-origin
 * redirects, requests go through the authorized fetch layer instead: it owns redirects and
 * injects headers / Bearer tokens only on hops to the MCP origin. The SDK `authProvider` is
 * never used.
 */
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpAuthRequiredListener, McpRequestAuthorizer } from '../auth.js';
import type { HttpTransportConfig, SseTransportConfig } from '../types.js';
import { createAuthorizedFetch } from './authorized-fetch.js';

export interface McpHttpTransportOptions {
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  authorizer?: McpRequestAuthorizer;
  /** Raised once the connection can no longer authorize; the pool closes the connection. */
  onAuthRequired?: McpAuthRequiredListener;
}

export function createHttpTransport(
  config: HttpTransportConfig | SseTransportConfig,
  options?: McpHttpTransportOptions,
): Transport {
  const url = parseTransportUrl(config.url);
  const headers = mergeHeaders(config.headers, options?.headers);
  const useAuthorizedFetch = options?.authorizer !== undefined || config.protectHeadersOnRedirect;
  const transportOptions = useAuthorizedFetch
    ? {
        fetch: createAuthorizedFetch({
          serverUrl: url,
          fetchImpl: options?.fetchImpl ?? fetch,
          ...(headers ? { originHeaders: headers } : {}),
          ...(options?.authorizer ? { authorizer: options.authorizer } : {}),
          ...(options?.onAuthRequired ? { onAuthRequired: options.onAuthRequired } : {}),
        }),
      }
    : {
        ...(headers ? { requestInit: { headers } } : {}),
        ...(options?.fetchImpl ? { fetch: options.fetchImpl } : {}),
      };
  if (config.type === 'sse') {
    return new SSEClientTransport(url, transportOptions);
  }
  return new StreamableHTTPClientTransport(url, transportOptions);
}

function mergeHeaders(
  configHeaders?: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Record<string, string> | undefined {
  const headers = { ...(configHeaders ?? {}), ...(extraHeaders ?? {}) };
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseTransportUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`Invalid MCP transport url: ${url}`);
  }
}
