import type { McpAuthRequiredError } from '@mavis/mcp';
import type {
  McpAuthStartResult,
  McpAuthStateView,
  McpAuthTarget,
  McpOAuthBinding,
} from '../oauth/index.js';

export type PluginMcpAuthTarget = Extract<McpAuthTarget, { kind: 'plugin' }>;

/** Implemented by the plugin system; bound late because plugins initialize after MCP. */
export interface PluginMcpAuthPort {
  /** Remote servers of installed and enabled plugins in the current principal scope. */
  listRemoteServers(): Promise<Array<{ binding: McpOAuthBinding }>>;
  resolveBinding(target: PluginMcpAuthTarget): Promise<McpOAuthBinding | undefined>;
  /** One listTools with the authorizer attached; never opens a browser. */
  probe(target: PluginMcpAuthTarget): Promise<'connected' | McpAuthRequiredError | Error>;
  /** Drops that server's inventory and runs an immediate discovery. */
  rediscover(target: PluginMcpAuthTarget): Promise<void>;
}

export interface McpAuthStateListInput {
  readonly sessionId?: string;
  readonly workspaceRoot?: string;
}

export interface McpAuthTestResult {
  readonly state: McpAuthStateView;
  readonly errorCode?: string;
}

/** User actions on MCP authorization, shared by DesktopService and the process-local TUI. */
export interface McpAuthFacade {
  listStates(input: McpAuthStateListInput): Promise<McpAuthStateView[]>;
  test(target: McpAuthTarget): Promise<McpAuthTestResult>;
  start(target: McpAuthTarget, options?: { force?: boolean }): Promise<McpAuthStartResult>;
  cancel(attemptId: string): Promise<boolean>;
  complete(
    attemptId: string,
    callbackUrl: string,
  ): Promise<{ state: McpAuthStateView; errorCode?: string }>;
  clear(target: McpAuthTarget): Promise<{ state: McpAuthStateView; revoked: boolean }>;
  /**
   * Stores (or, for an empty value, clears) the confidential client secret of a
   * user server. Resolves to whether a secret is configured after the call — not
   * whether something changed: `false` after clearing, `true` after storing.
   */
  setUserClientSecret(serverName: string, secret: string | undefined): Promise<boolean>;
}

/** The target cannot be resolved to a remote MCP server in its source. */
export class McpAuthTargetError extends Error {
  override readonly name = 'McpAuthTargetError';
  readonly code = 'MCP_OAUTH_TARGET_NOT_FOUND';
  readonly status = 404;

  constructor() {
    super('MCP authorization target was not found.');
  }
}
