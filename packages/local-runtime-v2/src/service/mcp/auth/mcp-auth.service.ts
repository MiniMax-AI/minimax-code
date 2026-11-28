import { findMcpAuthRequiredError } from '@mavis/mcp';
import type { GlobalEventInput } from '@mavis/shared/global-events';
import type { McpRuntimeLogger } from '@mavis/mcp/runtime/types';
import type {
  McpAuthStartResult,
  McpAuthStateView,
  McpAuthTarget,
  McpOAuthBinding,
  McpOAuthService,
} from '../oauth/index.js';
import type { McpServerAuth } from './server-auth.js';
import { publicAuthTarget } from './bindings.js';
import {
  McpAuthTargetError,
  type McpAuthFacade,
  type McpAuthStateListInput,
  type McpAuthTestResult,
  type PluginMcpAuthPort,
  type PluginMcpAuthTarget,
} from './ports.js';

type McpAuthRuntime = Pick<
  McpServerAuth,
  | 'listUserAuthBindings'
  | 'resolveUserAuthBinding'
  | 'listProjectAuthBindings'
  | 'probeAuthTarget'
  | 'reconnectAuthTarget'
>;

export interface McpAuthServiceOptions {
  readonly oauth: McpOAuthService;
  readonly runtime: McpAuthRuntime;
  readonly publish?: (event: GlobalEventInput<'mcp.auth_updated'>) => void;
  readonly logger?: McpRuntimeLogger;
}

/**
 * Resolves user, project and plugin targets to OAuth bindings for user actions,
 * and turns committed state changes into reconnects and `mcp.auth_updated`.
 */
export class McpAuthService implements McpAuthFacade {
  private plugins: PluginMcpAuthPort | undefined;
  /** In-flight plugin rediscoveries started after a committed state change. */
  private readonly rediscoveries = new Map<symbol, Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(private readonly options: McpAuthServiceOptions) {
    this.unsubscribe = options.oauth.onStateChanged((view, binding) =>
      this.handleStateChanged(view, binding),
    );
  }

  /** Plugins initialize after MCP; their port is bound once available. */
  bindPluginPort(port: PluginMcpAuthPort): () => void {
    this.plugins = port;
    return () => {
      if (this.plugins === port) this.plugins = undefined;
    };
  }

  async listStates(input: McpAuthStateListInput): Promise<McpAuthStateView[]> {
    const project =
      input.sessionId && input.workspaceRoot
        ? this.options.runtime.listProjectAuthBindings({
            sessionId: input.sessionId,
            workspaceRoot: input.workspaceRoot,
          })
        : Promise.resolve([]);
    const plugin = this.listPluginBindings();
    const bindings = (
      await Promise.all([this.options.runtime.listUserAuthBindings(), project, plugin])
    ).flat();
    return Promise.all(bindings.map((binding) => this.readState(binding)));
  }

  /** One unreadable credential record shows as unknown instead of failing the whole list. */
  private async readState(binding: McpOAuthBinding): Promise<McpAuthStateView> {
    try {
      return await this.options.oauth.getState(binding);
    } catch {
      this.options.logger?.warn('mcp.oauth.state_unreadable', { kind: binding.target.kind });
      return { target: binding.target, authState: 'unknown' };
    }
  }

  async test(target: McpAuthTarget): Promise<McpAuthTestResult> {
    const binding = await this.requireBinding(target);
    const outcome = await this.probe(binding);
    const state = await this.options.oauth.getState(binding);
    if (outcome === 'connected') return { state };
    return {
      state,
      errorCode: findMcpAuthRequiredError(outcome) ? 'MCP_AUTH_REQUIRED' : 'MCP_CONNECTION_FAILED',
    };
  }

  async start(target: McpAuthTarget, options?: { force?: boolean }): Promise<McpAuthStartResult> {
    return this.options.oauth.start(await this.requireBinding(target), options);
  }

  cancel(attemptId: string): Promise<boolean> {
    return this.options.oauth.cancel(attemptId);
  }

  complete(
    attemptId: string,
    callbackUrl: string,
  ): Promise<{ state: McpAuthStateView; errorCode?: string }> {
    return this.options.oauth.complete(attemptId, callbackUrl);
  }

  async clear(target: McpAuthTarget): Promise<{ state: McpAuthStateView; revoked: boolean }> {
    return this.options.oauth.clear(await this.requireBinding(target));
  }

  async setUserClientSecret(serverName: string, secret: string | undefined): Promise<boolean> {
    const binding = await this.options.runtime.resolveUserAuthBinding(serverName);
    if (!binding) throw new McpAuthTargetError();
    return this.options.oauth.setUserClientSecret(serverName, secret?.trim() ? secret : undefined);
  }

  /** Waits for background plugin rediscoveries so none outlives the MCP owner. */
  async close(): Promise<void> {
    this.unsubscribe();
    await Promise.allSettled(this.rediscoveries.values());
    this.plugins = undefined;
  }

  /** A failing plugin source must not hide user and project states. */
  private async listPluginBindings(): Promise<McpOAuthBinding[]> {
    if (!this.plugins) return [];
    try {
      return (await this.plugins.listRemoteServers()).map(({ binding }) => binding);
    } catch {
      this.options.logger?.warn('mcp.oauth.plugin_list_failed');
      return [];
    }
  }

  private async probe(binding: McpOAuthBinding) {
    const target = binding.target;
    if (target.kind !== 'plugin') return this.options.runtime.probeAuthTarget(target);
    const plugins = this.plugins;
    if (!plugins) throw new McpAuthTargetError();
    // The plugin probe never reports outcomes; user and project probes already did.
    const outcome = await plugins.probe(target);
    const authError = outcome === 'connected' ? undefined : findMcpAuthRequiredError(outcome);
    if (outcome === 'connected') await this.options.oauth.markObserved(binding, 'connected');
    else if (authError) await this.options.oauth.markObserved(binding, authError);
    return outcome;
  }

  private async requireBinding(target: McpAuthTarget): Promise<McpOAuthBinding> {
    const binding = await this.resolveBinding(target);
    if (!binding) throw new McpAuthTargetError();
    return binding;
  }

  private async resolveBinding(target: McpAuthTarget): Promise<McpOAuthBinding | undefined> {
    if (target.kind === 'user') {
      return this.options.runtime.resolveUserAuthBinding(target.serverName);
    }
    if (target.kind === 'project') {
      const bindings = await this.options.runtime.listProjectAuthBindings({
        sessionId: target.sessionId,
        workspaceRoot: target.workspaceRoot,
      });
      return bindings.find((binding) => binding.target.serverName === target.serverName);
    }
    return this.plugins?.resolveBinding(target);
  }

  /**
   * User and project servers reconnect before the event so the host refreshes
   * against the new credentials. Plugin rediscovery runs a full discovery, so
   * the completion event goes first and rediscovery continues in the background.
   */
  private async handleStateChanged(view: McpAuthStateView, binding: McpOAuthBinding) {
    const target = binding.target;
    if (target.kind === 'plugin') {
      this.publishUpdated(view, target);
      const key = Symbol('mcp-plugin-rediscovery');
      this.rediscoveries.set(key, this.rediscoverInBackground(key, target));
      return;
    }
    try {
      await this.options.runtime.reconnectAuthTarget(target);
    } catch {
      this.options.logger?.warn('mcp.oauth.reconnect_failed', { kind: target.kind });
    }
    this.publishUpdated(view, target);
  }

  /** Never rejects; failures are logged and the next discovery retries. */
  private async rediscoverInBackground(key: symbol, target: PluginMcpAuthTarget): Promise<void> {
    try {
      await this.plugins?.rediscover(target);
    } catch {
      this.options.logger?.warn('mcp.oauth.reconnect_failed', { kind: target.kind });
    } finally {
      this.rediscoveries.delete(key);
    }
  }

  private publishUpdated(view: McpAuthStateView, target: McpAuthTarget): void {
    try {
      this.options.publish?.({
        type: 'mcp.auth_updated',
        payload: {
          target: publicAuthTarget(target),
          authState: view.authState,
          ...(view.reason ? { reason: view.reason } : {}),
          ...(view.lastAttemptId ? { attemptId: view.lastAttemptId } : {}),
          ...(view.lastAttemptOutcome ? { attemptOutcome: view.lastAttemptOutcome } : {}),
          ...(view.lastAttemptErrorCode ? { errorCode: view.lastAttemptErrorCode } : {}),
        },
      });
    } catch {
      this.options.logger?.warn('mcp.oauth.publish_failed', { kind: target.kind });
    }
  }
}
