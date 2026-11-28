import type { AllowedMetricName, MetricsClient } from '@mavis/shared/local-runtime-logging/metrics';
import type { ObservabilityLogger } from '@mavis/shared/local-runtime-diagnostics';
import { createMcpRuntimeLogger } from './logging.js';
import { McpConnectionPool } from '@mavis/mcp/runtime/connection-pool';
import type { McpRuntimeLogger } from '@mavis/mcp/runtime/types';
import type {
  McpRuntimeCapability,
  McpSettingsService,
  McpServerConfig,
  ConfiguredMcpServerInput,
  LocalMcpServiceOptions,
} from './contracts.js';
import { LocalMcpService } from './runtime/local-mcp.service.js';
import { resolveMatrixMcpStdioEntrypoint } from './runtime/builtin-matrix.js';
import { LocalMcpPublicFacade } from './tools/public-facade.js';
import type { GlobalEventInput } from '@mavis/shared/global-events';
import type { McpAuthRequiredReason } from '@mavis/mcp';
import type { McpAuthTarget, McpOAuthService } from './oauth/index.js';
import { McpAuthService } from './auth/mcp-auth.service.js';
import { publicAuthTarget } from './auth/bindings.js';
import type { McpAuthFacade, PluginMcpAuthPort } from './auth/ports.js';

export interface InitializedMcpService {
  readonly service: McpSettingsService;
  readonly runtime: LocalMcpService;
  readonly public: LocalMcpPublicFacade;
  readonly capability: McpRuntimeCapability;
  /** Present when OAuth is wired; shared by DesktopService and the process-local TUI. */
  readonly auth?: McpAuthFacade;
  readonly oauth?: McpOAuthService;
  /** Plugin discovery has no Session; it announces without Session or Turn. */
  announcePluginAuthRequired(input: { target: McpAuthTarget; reason: McpAuthRequiredReason }): void;
  /** Plugins initialize after MCP; returns the unbind function. */
  bindPluginAuthPort(port: PluginMcpAuthPort): () => void;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface InitializeMcpServiceOptions {
  readonly dataDir: string;
  readonly nowMs?: () => number;
  readonly enableLiveMcp: boolean;
  readonly builtinMatrix: boolean;
  readonly matrixWebSearchOnly: boolean;
  readonly logger?: McpRuntimeLogger;
  readonly diagnostics?: ObservabilityLogger;
  readonly metrics?: Pick<MetricsClient, 'counter' | 'histogram'>;
  readonly fetchImpl?: typeof fetch;
  /** OAuth for remote user, project and plugin servers; the MCP owner closes it last. */
  readonly oauth?: McpOAuthService;
  readonly publishGlobalEvent?: (
    event: GlobalEventInput<'mcp.auth_updated' | 'mcp.auth_required'>,
  ) => void;
  /** Internal old-consumer binding; not a public host factory override. */
  readonly bindRuntime?: (capability: McpRuntimeCapability) => () => void;
}

export function initializeMcpService(options: InitializeMcpServiceOptions): InitializedMcpService {
  let runtime: LocalMcpService;
  const metrics = options.metrics;
  const logger = createMcpRuntimeLogger(options.diagnostics, options.logger);
  const pool = options.enableLiveMcp
    ? new McpConnectionPool(
        {
          getResolvedServer: (name) => runtime.getServerLookup().getResolvedServer(name),
        },
        {
          ...(logger ? { logger } : {}),
          ...(metrics
            ? {
                metrics: {
                  incr: (name: AllowedMetricName, tags) => metrics.counter(name, 1, tags),
                  latency: (name: AllowedMetricName, value, tags) =>
                    metrics.histogram(name, value, tags),
                },
              }
            : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        },
      )
    : undefined;
  runtime = new LocalMcpService(() => options.dataDir, {
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(pool ? { connectionPool: pool } : {}),
    ...authOptions(options, logger),
    builtinMatrix: {
      enabled: options.builtinMatrix && Boolean(resolveMatrixMcpStdioEntrypoint()),
      webSearchOnly: options.matrixWebSearchOnly,
    },
  });
  const service: McpSettingsService = {
    list: (keyword) => runtime.listConfiguredServers(keyword),
    // Details report whether a confidential client secret is stored, never the secret.
    get: async (name) => {
      const detail = await runtime.getConfiguredServer(name);
      return detail && runtime.serverAuth.withClientSecretState(detail);
    },
    create: async (name, config, enabled) =>
      runtime.serverAuth.withClientSecretState(
        await runtime.createConfiguredServer(name, mutableConfig(config), enabled),
      ),
    update: async (name, config) =>
      runtime.serverAuth.withClientSecretState(
        await runtime.updateConfiguredServer(name, mutableConfig(config)),
      ),
    delete: (name) => runtime.deleteConfiguredServer(name),
    setEnabled: (name, enabled) => runtime.setConfiguredServerEnabled(name, enabled),
    test: (name) => runtime.testConfiguredServer(name),
  };
  const { oauth, publishGlobalEvent: publish } = options;
  const auth = createAuthService(options, runtime, logger);
  const capability: McpRuntimeCapability = runtime;
  const unbind = options.bindRuntime?.(capability);
  let closePromise: Promise<void> | undefined;
  return {
    service,
    runtime,
    public: new LocalMcpPublicFacade(runtime),
    capability,
    ...(auth && oauth ? { auth, oauth } : {}),
    announcePluginAuthRequired: ({ target, reason }) =>
      publish?.({
        type: 'mcp.auth_required',
        payload: { target: publicAuthTarget(target), reason },
      }),
    bindPluginAuthPort: (port) => auth?.bindPluginPort(port) ?? (() => undefined),
    // Reservations are built from the local configuration. Remote discovery remains lazy and bounded.
    ready: async () => {
      await runtime.listServers();
    },
    close: () => {
      closePromise ??= (async () => {
        unbind?.();
        await auth?.close();
        await runtime.close();
        await oauth?.close();
      })();
      return closePromise;
    },
  };
}

function mutableConfig(config: McpServerConfig): ConfiguredMcpServerInput {
  const common = {
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.description === undefined ? {} : { description: config.description }),
  };
  return config.transport === 'stdio'
    ? {
        transport: config.transport,
        command: config.command,
        ...(config.args === undefined ? {} : { args: [...config.args] }),
        ...(config.env === undefined ? {} : { env: { ...config.env } }),
        ...common,
      }
    : {
        transport: config.transport,
        url: config.url,
        ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
        ...(config.oauth === undefined
          ? {}
          : {
              oauth: {
                ...config.oauth,
                ...(config.oauth.scopes ? { scopes: [...config.oauth.scopes] } : {}),
              },
            }),
        ...common,
      };
}

function authOptions(
  options: InitializeMcpServiceOptions,
  logger: McpRuntimeLogger | undefined,
): Pick<LocalMcpServiceOptions, 'oauth' | 'publishGlobalEvent' | 'logger'> {
  return {
    ...(options.oauth ? { oauth: options.oauth } : {}),
    ...(options.publishGlobalEvent ? { publishGlobalEvent: options.publishGlobalEvent } : {}),
    ...(logger ? { logger } : {}),
  };
}

function createAuthService(
  options: InitializeMcpServiceOptions,
  runtime: LocalMcpService,
  logger: McpRuntimeLogger | undefined,
): McpAuthService | undefined {
  const { oauth, publishGlobalEvent: publish } = options;
  if (!oauth) return undefined;
  return new McpAuthService({
    oauth,
    runtime: runtime.serverAuth,
    ...(publish ? { publish } : {}),
    ...(logger ? { logger } : {}),
  });
}
