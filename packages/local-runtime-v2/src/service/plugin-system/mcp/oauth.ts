import {
  pluginMcpNameKey,
  type McpAuthRequiredError,
  type McpAuthRequiredReason,
} from '@mavis/mcp';
import type { PluginId } from '@mavis/shared';

import {
  mcpConnectionFingerprint,
  type McpAuthTarget,
  type McpOAuthBinding,
  type McpOAuthService,
  type PluginMcpAuthPort,
  type PluginMcpAuthTarget,
} from '../../mcp/index.js';
import { settleInBackground } from '../../../infra/async/settle.js';
import type { PluginMcpOAuthDescriptor } from '../plugin/package/types.js';
import type { PluginSnapshotMcpServer } from '../plugin/runtime/snapshot-builder.js';
import type { PluginMcpRuntimeAuth, PluginMcpServerCredential } from './runtime.js';

/** Local Plugins install per device, so their credentials are device-wide per PluginId. */
function localPluginMcpNamespace(id: PluginId): string {
  return `plugin-local:${id.name}@${id.marketplace}`;
}

/**
 * Credential identity of a remote local Plugin server. Undefined for stdio and Mini App managed
 * (Host loopback) servers and for every OFFICIAL server: official Plugin MCP does not use OAuth,
 * so its 401 stays an ordinary listing failure.
 *
 * @public exercised directly by the colocated unit suite.
 */
export function pluginMcpOAuthBinding(entry: PluginSnapshotMcpServer): McpOAuthBinding | undefined {
  const { transport } = entry.server.resolvedServer;
  if (transport.type === 'stdio' || entry.managedIdentity || entry.source === 'OFFICIAL') {
    return undefined;
  }
  return {
    target: {
      kind: 'plugin',
      serverName: entry.server.name,
      pluginName: entry.pluginId.name,
      pluginMarketplace: entry.pluginId.marketplace,
      pluginSource: entry.source,
    },
    namespace: localPluginMcpNamespace(entry.pluginId),
    serverUrl: transport.url,
    // An upgrade that changes the URL or the resolved headers invalidates a needs-auth observation.
    connectionFingerprint: mcpConnectionFingerprint({
      url: transport.url,
      ...(transport.headers ? { headers: transport.headers } : {}),
    }),
    ...clientRegistration(entry),
    staticAuthorization: Object.keys(transport.headers ?? {}).some(
      (header) => header.toLowerCase() === 'authorization',
    ),
    trust: 'confirm',
    privateNetwork: 'deny',
    sourceLabel: entry.pluginDisplayName ?? entry.pluginName,
  };
}

/** Declared client configuration; servers without `oauth` use the package format's redirect. */
function clientRegistration(
  entry: PluginSnapshotMcpServer,
): Pick<McpOAuthBinding, 'oauth' | 'redirectFormat' | 'codexCallbackUrl'> {
  const declared: Partial<PluginMcpOAuthDescriptor> = entry.server.resolvedServer.oauth ?? {};
  const {
    redirectFormat = redirectFormatFor(entry.source),
    codexCallbackUrl,
    ...client
  } = declared;
  return {
    ...(Object.keys(client).length > 0 ? { oauth: client } : {}),
    redirectFormat,
    ...(codexCallbackUrl ? { codexCallbackUrl } : {}),
  };
}

function redirectFormatFor(
  source: PluginSnapshotMcpServer['source'],
): McpOAuthBinding['redirectFormat'] {
  if (source === 'LOCAL_\u0043\u004c\u0041\u0055\u0044\u0045') return 'localhost-callback';
  if (source === 'LOCAL_CODEX') return 'codex';
  return 'default';
}

export interface PluginMcpAuthRequiredEvent {
  readonly target: McpAuthTarget;
  readonly reason: McpAuthRequiredReason;
}

/** Lifecycle cleanup of local Plugin MCP credentials; never revokes at the authorization server. */
export interface PluginMcpCredentialCleanup {
  deleteLocalPlugin(id: PluginId): void;
}

/** Connects Plugin MCP runtimes to the shared MCP OAuth service. */
export class PluginMcpCredentials implements PluginMcpRuntimeAuth, PluginMcpCredentialCleanup {
  /** Announced credential key → its namespace, so a removal re-arms the announcement. */
  private readonly announced = new Map<string, string>();

  constructor(
    private readonly options: {
      readonly service: McpOAuthService;
      readonly publishAuthRequired?: (event: PluginMcpAuthRequiredEvent) => void;
      readonly logger: { warn(fields: Record<string, unknown>, message: string): void };
    },
  ) {}

  resolve(entry: PluginSnapshotMcpServer): PluginMcpServerCredential | undefined {
    const { service } = this.options;
    const binding = pluginMcpOAuthBinding(entry);
    if (!binding || binding.staticAuthorization) return undefined;
    const authorizer = service.authorizerFor(binding);
    if (!authorizer) return undefined;
    const credentialKey = service.credentialKey(binding);
    return {
      authorizer,
      shouldSkipBackground: () => service.shouldSkipBackground(binding),
      markObserved: async (outcome) => {
        if (outcome === 'connected') this.announced.delete(credentialKey);
        await service.markObserved(binding, outcome);
      },
      authRequired: (error: McpAuthRequiredError) => {
        if (this.announced.has(credentialKey)) return;
        this.announced.set(credentialKey, binding.namespace);
        this.options.publishAuthRequired?.({ target: binding.target, reason: error.reason });
      },
    };
  }

  /** Runs after the removal committed; a failure leaves records for orphan collection. */
  deleteLocalPlugin(id: PluginId): void {
    const namespace = localPluginMcpNamespace(id);
    for (const [credentialKey, announcedNamespace] of this.announced) {
      if (announcedNamespace === namespace) this.announced.delete(credentialKey);
    }
    settleInBackground(
      (async () => {
        try {
          await this.options.service.deleteNamespace(namespace);
        } catch (error) {
          this.options.logger.warn(
            { errorType: error instanceof Error ? error.name : typeof error },
            'Plugin MCP credential cleanup failed',
          );
        }
      })(),
    );
  }
}

/** PluginSystem capabilities the authorization port reads. */
export interface PluginMcpAuthHost {
  readonly currentSnapshot: { readonly mcpServers: readonly PluginSnapshotMcpServer[] };
  /** Resolves once the startup snapshot (cached restore) is published. */
  waitUntilReady(): Promise<void>;
  probeMcpServer(serverName: string): Promise<'connected' | McpAuthRequiredError | Error>;
  rediscoverMcpServers(serverNames: readonly string[]): Promise<void>;
}

/**
 * Local Plugin side of MCP authorization; targets address a PluginId and a manifest server.
 * Every action waits for the startup snapshot, so a fresh process (`mcode mcp login --plugin`,
 * the first ListLocalMcpAuthStates) never mistakes an empty snapshot for "no such server".
 */
export function createPluginMcpAuthPort(host: PluginMcpAuthHost): PluginMcpAuthPort {
  const readyEntries = async () => {
    await host.waitUntilReady();
    return host.currentSnapshot.mcpServers;
  };
  const findEntry = async (target: PluginMcpAuthTarget) =>
    (await readyEntries()).find(
      (entry) =>
        entry.pluginId.name === target.pluginName &&
        entry.pluginId.marketplace === target.pluginMarketplace &&
        entry.server.name === target.serverName &&
        pluginMcpOAuthBinding(entry) !== undefined,
    );
  const runtimeName = (entry: PluginSnapshotMcpServer) =>
    pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name);
  return {
    listRemoteServers: async () =>
      (await readyEntries()).flatMap((entry) => {
        const binding = pluginMcpOAuthBinding(entry);
        return binding ? [{ binding }] : [];
      }),
    resolveBinding: async (target) => {
      const entry = await findEntry(target);
      return entry ? pluginMcpOAuthBinding(entry) : undefined;
    },
    probe: async (target) => {
      const entry = await findEntry(target);
      if (!entry) return new Error('Plugin MCP server is not loaded');
      return host.probeMcpServer(runtimeName(entry));
    },
    rediscover: async (target) => {
      const entry = await findEntry(target);
      if (entry) await host.rediscoverMcpServers([runtimeName(entry)]);
    },
  };
}
