import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpAuthRequiredListener, McpRequestAuthorizer } from '../auth.js';
import type { TransportConfig } from '../types.js';
import { createHttpTransport } from './http.js';
import { createStdioTransport } from './stdio.js';

export interface McpTransportFactoryOptions {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** http/sse only; ignored for stdio (stdio servers take credentials from env). */
  authorizer?: McpRequestAuthorizer;
  onAuthRequired?: McpAuthRequiredListener;
}

export function createTransport(
  config: TransportConfig,
  options?: McpTransportFactoryOptions,
): Transport {
  switch (config.type) {
    case 'stdio':
      return createStdioTransport(config, { env: options?.env });
    case 'http':
    case 'sse':
      return createHttpTransport(config, {
        headers: options?.headers,
        fetchImpl: options?.fetchImpl,
        authorizer: options?.authorizer,
        onAuthRequired: options?.onAuthRequired,
      });
  }
}
