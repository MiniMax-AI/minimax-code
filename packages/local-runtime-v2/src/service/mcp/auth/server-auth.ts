import {
  findMcpAuthRequiredError,
  type McpAuthRequiredError,
  type McpRequestAuthorizer,
  type McpRuntimeLogger,
} from '@mavis/mcp';
import type { McpConnectionPool } from '@mavis/mcp/runtime/connection-pool';
import type { McpConnectionTokenOverrides } from '@mavis/mcp/runtime/types';
import type { GlobalEventInput } from '@mavis/shared/global-events';
import type {
  ConfiguredMcpConnectionTestResult,
  ConfiguredMcpServerDetail,
  LocalMcpCallResult,
  LocalMcpRuntimeContext,
  LocalMcpServerConfig,
  LocalMcpToolInfo,
} from '../contracts.js';
import type {
  McpAuthState,
  McpAuthTarget,
  McpOAuthBinding,
  McpOAuthService,
} from '../oauth/index.js';
import type { ProjectMcpAuthSource } from '../project-mcp.service.js';
import { isBuiltinMatrixConfig } from '../runtime/builtin-matrix.js';
import { legacyAuthStatus, projectAuthBinding, userAuthBinding } from './bindings.js';
import { McpConnectionAuthGate, publicAuthRequiredError } from './connection-gate.js';
import { hasAuthorizationHeader, McpOAuthConfigError } from './oauth-config.js';
import {
  configToTransportConfig,
  configuredTimeout,
  readConfiguredTools,
} from '../runtime/config.js';
import {
  isUserConfiguredServer as isUserServer,
  withConfiguredConnectionTimeout,
} from '../runtime/settings-config.js';

type LocalAuthTarget = Exclude<McpAuthTarget, { kind: 'plugin' }>;
export const CONNECTION_FAILED_ERROR =
  'MCP server connection failed. Retry or check its configuration.';

export interface AuthorizedConnectionOptions {
  /** Background paths never connect while the server awaits authorization. */
  readonly background: boolean;
  /** Turn discovery tells the user once per Session and target. */
  readonly announce?: boolean;
  readonly timeoutMs?: number;
  readonly onTimeout?: () => void;
}

export interface AuthorizedConnectionTarget {
  readonly server: string;
  readonly config: LocalMcpServerConfig;
  readonly context?: LocalMcpRuntimeContext | undefined;
}

export interface McpServerAuthOptions {
  readonly runtime: {
    readonly oauth?: McpOAuthService;
    readonly publishGlobalEvent?: (event: GlobalEventInput<'mcp.auth_required'>) => void;
    readonly logger?: McpRuntimeLogger;
    readonly connectionPool?: McpConnectionPool;
  };
  readonly dataDir: () => string;
  readonly projectSource: (config: LocalMcpServerConfig) => ProjectMcpAuthSource | undefined;
  readonly isSessionServer: (server: string, context?: LocalMcpRuntimeContext) => boolean;
  /** Connection overrides of the target with the attempt's authorizer attached. */
  readonly resolveOverrides: (
    target: AuthorizedConnectionTarget,
    authorizer: McpRequestAuthorizer | undefined,
  ) => Promise<McpConnectionTokenOverrides | undefined>;
  /** Owner ports borrowed for user actions; the MCP owner keeps state and lifecycle. */
  readonly owner: {
    assertOpen(): void;
    readUserServers(): Promise<Readonly<Record<string, LocalMcpServerConfig>>>;
    resolveProject(context: {
      sessionId: string;
      workspaceRoot: string;
    }): Promise<Readonly<Record<string, LocalMcpServerConfig>>>;
    getServerConfig(
      name: string,
      context?: LocalMcpRuntimeContext,
    ): Promise<LocalMcpServerConfig | undefined>;
    connectionSignal(config: LocalMcpServerConfig, signal?: AbortSignal): AbortSignal;
    record(target: AuthorizedConnectionTarget, error?: string): void;
    /** The target reconnects on next use; user servers drop their public status. */
    reset(target: LocalAuthTarget): Promise<void>;
  };
}

/** A failed listing falls back to configured tools; `authError` tells why the rest are absent. */
export interface LiveToolsOutcome {
  readonly tools: LocalMcpToolInfo[];
  readonly authError?: McpAuthRequiredError;
}

/** Public status text of an authorization failure, or undefined for other errors. */
export function authFailureMessage(error: unknown): string | undefined {
  // OAuth configuration messages name fields only, never values.
  if (error instanceof McpOAuthConfigError) return error.message;
  const authError = findMcpAuthRequiredError(error);
  return authError ? publicAuthRequiredError(authError) : undefined;
}

/**
 * OAuth policy for user `mcp.json` and project `.mcp.json` servers: binding
 * resolution, authorized connections, legacy status projection and credential
 * cleanup. Session (ACP), stdio and built-in servers never take part.
 */
export class McpServerAuth {
  readonly gate: McpConnectionAuthGate;

  constructor(private readonly options: McpServerAuthOptions) {
    const { oauth, publishGlobalEvent: publish, logger } = options.runtime;
    this.gate = new McpConnectionAuthGate({
      ...(oauth ? { oauth } : {}),
      ...(publish ? { publish } : {}),
      ...(logger ? { logger } : {}),
    });
  }

  private legacyAuthLogged = false;

  /** Logged once per runtime; the field never carries meaning (plan §6.1). */
  readonly ignoreLegacyAuth = (): void => {
    if (this.legacyAuthLogged) return;
    this.legacyAuthLogged = true;
    this.options.runtime.logger?.warn('mcp.config.legacy_auth_ignored');
  };

  /** Throws `McpOAuthConfigError` when the server's `oauth` block is invalid. */
  binding(
    server: string,
    config: LocalMcpServerConfig,
    context?: LocalMcpRuntimeContext,
  ): McpOAuthBinding | undefined {
    if (!this.options.runtime.oauth) return undefined;
    if (this.options.isSessionServer(server, context) || isBuiltinMatrixConfig(server, config)) {
      return undefined;
    }
    const project = this.options.projectSource(config);
    if (project) return projectAuthBinding(project, config);
    return isUserServer(config)
      ? userAuthBinding(server, config, this.options.dataDir())
      : undefined;
  }

  /** Invalid `oauth` blocks surface as a connection error of that server, not here. */
  userBinding(name: string, config: LocalMcpServerConfig): McpOAuthBinding | undefined {
    if (!this.options.runtime.oauth || !isUserServer(config)) return undefined;
    try {
      return userAuthBinding(name, config, this.options.dataDir());
    } catch {
      return undefined;
    }
  }

  userBindings(servers: Readonly<Record<string, LocalMcpServerConfig>>): McpOAuthBinding[] {
    return Object.entries(servers).flatMap(([name, config]) => {
      const binding = this.userBinding(name, config);
      return binding ? [binding] : [];
    });
  }

  projectBindings(servers: Readonly<Record<string, LocalMcpServerConfig>>): McpOAuthBinding[] {
    return Object.values(servers).flatMap((config) => {
      const source = this.options.projectSource(config);
      const binding = source && projectAuthBinding(source, config);
      return binding ? [binding] : [];
    });
  }

  /** An unreadable credential record reads as unknown so listings and readiness never fail. */
  async userState(name: string, config: LocalMcpServerConfig): Promise<McpAuthState | undefined> {
    const binding = this.userBinding(name, config);
    if (!binding) return undefined;
    try {
      return (await this.options.runtime.oauth?.getState(binding))?.authState;
    } catch {
      this.options.runtime.logger?.warn('mcp.oauth.state_unreadable', { kind: 'user' });
      return undefined;
    }
  }

  async legacyStatus(name: string, config: LocalMcpServerConfig): Promise<string> {
    const state = await this.userState(name, config);
    if (state) return legacyAuthStatus(state);
    return hasAuthorizationHeader(config.headers) ? 'configured' : 'none';
  }

  /** Old single-server entry: starts OAuth for a user `mcp.json` server only. */
  async startLegacy(name: string, config: LocalMcpServerConfig) {
    const oauth = this.options.runtime.oauth;
    const binding = this.userBinding(name, config);
    if (!oauth || !binding) {
      const status = await this.legacyStatus(name, config);
      return { ok: false, status, error: 'MCP_OAUTH_TRANSPORT_UNSUPPORTED', localRuntime: true };
    }
    const result = await oauth.start(binding);
    if (result.status === 'pending') {
      return { ok: true, status: 'pending_auth', authUrl: result.authUrl, localRuntime: true };
    }
    if (result.status === 'already_authorized') {
      return { ok: true, status: 'authenticated', localRuntime: true };
    }
    const status = legacyAuthStatus((await oauth.getState(binding)).authState);
    return { ok: false, status, error: result.errorCode, localRuntime: true };
  }

  /** Plan §6.3: user credentials go with the last server that resolves to their key. */
  async deleteUnusedUserCredentials(
    name: string,
    removed: LocalMcpServerConfig,
    remaining: Readonly<Record<string, LocalMcpServerConfig>>,
  ): Promise<void> {
    const oauth = this.options.runtime.oauth;
    const binding = this.userBinding(name, removed);
    if (!oauth || !binding) return;
    try {
      const key = oauth.credentialKey(binding);
      const stillUsed = this.userBindings(remaining).some(
        (candidate) => oauth.credentialKey(candidate) === key,
      );
      if (!stillUsed) await oauth.deleteCredentials(binding);
      await oauth.setUserClientSecret(name, undefined);
    } catch {
      // The configuration is already gone; stale credentials age out with orphan cleanup.
      this.options.runtime.logger?.warn('mcp.oauth.delete_credentials_failed', { kind: 'user' });
    }
  }

  /**
   * Runs one pool operation with the server's authorizer. Background paths skip
   * servers awaiting authorization without connecting; every outcome is reported
   * to the OAuth state, and an authorization failure is rethrown as
   * `McpAuthRequiredError` even when the timeout won the race after a 401.
   */
  async connect<T>(
    target: AuthorizedConnectionTarget,
    options: AuthorizedConnectionOptions,
    operation: (overrides: McpConnectionTokenOverrides | undefined) => Promise<T>,
  ): Promise<T> {
    const binding = this.binding(target.server, target.config, target.context);
    await this.skipIfAwaitingAuthorization(binding, target.context, options);
    const attempt = this.gate.begin(binding);
    const connect = (async () => {
      const overrides = await this.options.resolveOverrides(target, attempt.authorizer);
      this.options.owner.assertOpen();
      return operation(overrides);
    })();
    try {
      const result =
        options.timeoutMs === undefined
          ? await connect
          : await withConfiguredConnectionTimeout(connect, options.timeoutMs, options.onTimeout);
      await this.gate.observe(binding, 'connected');
      return result;
    } catch (error) {
      const authError = attempt.classify(error);
      if (!binding || !authError) throw error;
      await this.gate.observe(binding, authError);
      this.announce(binding, authError, target.context, options);
      throw authError;
    }
  }

  async listUserAuthBindings(): Promise<McpOAuthBinding[]> {
    this.options.owner.assertOpen();
    return this.userBindings(await this.options.owner.readUserServers());
  }

  async resolveUserAuthBinding(serverName: string): Promise<McpOAuthBinding | undefined> {
    this.options.owner.assertOpen();
    const config = (await this.options.owner.readUserServers())[serverName];
    return config && this.userBinding(serverName, config);
  }

  /** Remote project servers of the workspace as seen by that Session. */
  async listProjectAuthBindings(context: {
    sessionId: string;
    workspaceRoot: string;
  }): Promise<McpOAuthBinding[]> {
    this.options.owner.assertOpen();
    return this.projectBindings(await this.options.owner.resolveProject(context));
  }

  /**
   * Committed authorization: the next use reconnects with the new credentials,
   * and a later failure is announced again.
   */
  async reconnectAuthTarget(target: LocalAuthTarget): Promise<void> {
    this.options.owner.assertOpen();
    this.gate.forgetTarget(target);
    await this.options.owner.reset(target);
  }

  /**
   * Interactive probe for one user or project target: connects with the
   * authorizer even while authorization is needed and never opens a browser.
   */
  async probeAuthTarget(
    target: LocalAuthTarget,
  ): Promise<'connected' | McpAuthRequiredError | Error> {
    this.options.owner.assertOpen();
    const context =
      target.kind === 'project'
        ? { sessionId: target.sessionId, workspaceRoot: target.workspaceRoot }
        : undefined;
    const config = await this.options.owner.getServerConfig(target.serverName, context);
    if (!config || config.enabled === false || !this.options.runtime.connectionPool) {
      return new Error('MCP server is not available for a connection test.');
    }
    const connection = { server: target.serverName, config, context };
    try {
      await this.listToolsInteractive(connection, this.options.runtime.connectionPool);
      this.options.owner.record(connection);
      return 'connected';
    } catch (error) {
      this.options.owner.record(connection, authFailureMessage(error) ?? CONNECTION_FAILED_ERROR);
      return (
        findMcpAuthRequiredError(error) ??
        (error instanceof Error ? error : new Error(CONNECTION_FAILED_ERROR))
      );
    }
  }

  /**
   * Background live tool list. It never connects while authorization is needed,
   * and reports that case so callers can tell it from a tool the server lacks.
   */
  async listToolsLive(server: string, context?: LocalMcpRuntimeContext): Promise<LiveToolsOutcome> {
    const { owner } = this.options;
    const pool = this.options.runtime.connectionPool;
    owner.assertOpen();
    const config = await owner.getServerConfig(server, context);
    if (!config || config.enabled === false) return { tools: [] };
    if (!pool || !configToTransportConfig(config)) return { tools: readConfiguredTools(config) };
    const target = { server, config, context };
    try {
      const tools = await this.connect(target, { background: true, announce: true }, (overrides) =>
        pool.listTools(server, overrides, { signal: owner.connectionSignal(config) }),
      );
      owner.record(target);
      return { tools };
    } catch (error) {
      owner.record(target, authFailureMessage(error) ?? CONNECTION_FAILED_ERROR);
      const authError = findMcpAuthRequiredError(error);
      return { tools: readConfiguredTools(config), ...(authError ? { authError } : {}) };
    }
  }

  /** User actions connect even while authorization is needed; never a browser. */
  listToolsInteractive(
    target: AuthorizedConnectionTarget,
    pool: McpConnectionPool,
  ): Promise<LocalMcpToolInfo[]> {
    const controller = new AbortController();
    const signal = this.options.owner.connectionSignal(target.config, controller.signal);
    return this.connect(
      target,
      {
        background: false,
        timeoutMs: configuredTimeout(target.config),
        onTimeout: () => controller.abort(),
      },
      (overrides) => {
        signal.throwIfAborted();
        return pool.listTools(target.server, overrides, { signal });
      },
    );
  }

  /** Mini App calls carry the authorizer but keep their own failure semantics. */
  authorizedOverrides(
    server: string,
    config: LocalMcpServerConfig,
  ): Promise<McpConnectionTokenOverrides | undefined> {
    const authorizer = this.gate.begin(this.binding(server, config)).authorizer;
    return this.options.resolveOverrides({ server, config }, authorizer);
  }

  async withClientSecretState(
    detail: ConfiguredMcpServerDetail,
  ): Promise<ConfiguredMcpServerDetail> {
    const oauth = this.options.runtime.oauth;
    if (!oauth || detail.config.transport === 'stdio') return detail;
    try {
      return {
        ...detail,
        oauthClientSecretConfigured: await oauth.hasUserClientSecret(detail.name),
      };
    } catch {
      // The configuration is already committed; an unreadable secret store must not fail it.
      this.options.runtime.logger?.warn('mcp.oauth.client_secret_unreadable', { kind: 'user' });
      return detail;
    }
  }

  async withAuthStates<Summary extends { name: string }>(
    entries: ReadonlyArray<{ summary: Summary; config: LocalMcpServerConfig }>,
  ): Promise<Array<Summary & { authState?: McpAuthState }>> {
    return Promise.all(
      entries.map(async ({ summary, config }) => {
        const authState = await this.userState(summary.name, config);
        return authState ? { ...summary, authState } : summary;
      }),
    );
  }

  legacyStatuses(servers: Readonly<Record<string, LocalMcpServerConfig>>) {
    return Promise.all(
      Object.entries(servers).map(async ([name, config]) => {
        const status = await this.legacyStatus(name, config);
        return { name, status, authenticated: status === 'authenticated' };
      }),
    );
  }

  /** Connection test result for an authorization failure, otherwise undefined. */
  connectionTestFailure(error: unknown): ConfiguredMcpConnectionTestResult | undefined {
    const authError = findMcpAuthRequiredError(error);
    return authError
      ? {
          success: false,
          errorCode: 'MCP_AUTH_REQUIRED',
          errorMessage: publicAuthRequiredError(authError),
        }
      : undefined;
  }

  /** Tool call result for an authorization failure, otherwise undefined. */
  callFailure(error: unknown): LocalMcpCallResult | undefined {
    const message = authFailureMessage(error);
    return message ? { isError: true, content: [{ type: 'text', text: message }] } : undefined;
  }

  private async skipIfAwaitingAuthorization(
    binding: McpOAuthBinding | undefined,
    context: LocalMcpRuntimeContext | undefined,
    options: AuthorizedConnectionOptions,
  ): Promise<void> {
    if (!binding || !options.background) return;
    const skipped = await this.gate.skipBackground(binding);
    if (!skipped) return;
    this.announce(binding, skipped, context, options);
    throw skipped;
  }

  private announce(
    binding: McpOAuthBinding,
    error: McpAuthRequiredError,
    context: LocalMcpRuntimeContext | undefined,
    options: AuthorizedConnectionOptions,
  ): void {
    if (options.announce) this.gate.announce(binding, error, context ?? {});
  }
}
