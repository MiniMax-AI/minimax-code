/**
 * MCP OAuth contracts shared by the OAuth service, user/project MCP wiring and the plugin system.
 * Pure types and stable error codes — no I/O, no mutable state.
 */
import type { McpAuthRequiredError, McpRequestAuthorizer, McpRuntimeLogger } from '@mavis/mcp';

export type McpAuthState =
  | 'unknown'
  | 'not_required'
  | 'static'
  | 'needs_auth'
  | 'authorizing'
  | 'authorized'
  | 'needs_reauth'
  | 'failed';

interface McpOAuthClientConfig {
  clientId?: string;
  scopes?: readonly string[];
  callbackPort?: number;
  callbackHost?: 'localhost' | '127.0.0.1';
  authServerMetadataUrl?: string;
}

export type McpAuthTarget =
  | { kind: 'user'; serverName: string }
  | { kind: 'project'; serverName: string; sessionId: string; workspaceRoot: string }
  | {
      kind: 'plugin';
      serverName: string;
      pluginName: string;
      pluginMarketplace: string;
      pluginSource: string;
    };

export interface McpOAuthBinding {
  target: McpAuthTarget;
  /** 'user' | `project:${realpath}` | `plugin-local:${name}@${marketplace}`. */
  namespace: string;
  /** Remote MCP url as configured. */
  serverUrl: string;
  oauth?: McpOAuthClientConfig;
  /** Pre-registered redirect_uri format (plan §5.5.1). */
  redirectFormat: 'default' | 'localhost-callback' | 'codex';
  /** Codex-compatible loopback `callbackUrl`. */
  codexCallbackUrl?: string;
  /** Headers contain `authorization` (case-insensitive): state 'static', no authorizer. */
  staticAuthorization: boolean;
  /** 'confirm' for project config and plugins (only local plugins use OAuth). */
  trust: 'trusted' | 'confirm';
  /** 'allow' only for user config. */
  privateNetwork: 'allow' | 'deny';
  /** e.g. '~/.minimax/mcp.json', '<root>/.mcp.json', plugin display name. */
  sourceLabel: string;
  /** User server name when kind === 'user'. */
  userClientSecretKey?: string;
  /**
   * Digest of the effective connection config (`mcpConnectionFingerprint`). An auth observation
   * made under a different fingerprint is stale: fixing a header / URL re-enables background
   * connections without waiting for a credential change.
   */
  connectionFingerprint?: string;
}

export interface McpAuthStateView {
  target: McpAuthTarget;
  authState: McpAuthState;
  reason?: string;
  missingScopes?: string[];
  expiresAt?: number;
  serverOrigin?: string;
  issuer?: string;
  attemptId?: string;
  /** Most recent finished attempt for this credential (process memory only). */
  lastAttemptId?: string;
  lastAttemptOutcome?: McpAuthAttemptOutcome;
  lastAttemptErrorCode?: string;
}

/** How an attempt ended; a denied consent is 'failed' with `MCP_OAUTH_ACCESS_DENIED`. */
export type McpAuthAttemptOutcome = 'authorized' | 'failed' | 'cancelled' | 'expired';

export type McpAuthStartResult =
  | {
      status: 'pending';
      attemptId: string;
      authUrl: string;
      requiresConfirmation: boolean;
      confirmation?: {
        sourceLabel: string;
        serverOrigin: string;
        issuer: string;
        clientId: string;
        authorizationHost?: string;
      };
    }
  | { status: 'already_authorized' }
  | { status: 'unsupported'; errorCode: string }
  | { status: 'failed'; errorCode: string };

export type McpAuthStateListener = (
  view: McpAuthStateView,
  binding: McpOAuthBinding,
) => void | Promise<void>;

export interface McpOAuthService {
  credentialKey(binding: McpOAuthBinding): string;
  /** Undefined when `staticAuthorization` (stdio servers never get a binding). */
  authorizerFor(binding: McpOAuthBinding): McpRequestAuthorizer | undefined;
  getState(binding: McpOAuthBinding): Promise<McpAuthStateView>;
  /** Background short-circuit: true when stored state is needs_auth/needs_reauth and generation unchanged. */
  shouldSkipBackground(binding: McpOAuthBinding): Promise<boolean>;
  markObserved(
    binding: McpOAuthBinding,
    outcome: 'connected' | McpAuthRequiredError,
  ): Promise<void>;
  start(binding: McpOAuthBinding, options?: { force?: boolean }): Promise<McpAuthStartResult>;
  cancel(attemptId: string): Promise<boolean>;
  complete(
    attemptId: string,
    callbackUrl: string,
  ): Promise<{ state: McpAuthStateView; errorCode?: string }>;
  clear(binding: McpOAuthBinding): Promise<{ state: McpAuthStateView; revoked: boolean }>;
  /** Lifecycle cleanup, no revoke. */
  deleteCredentials(binding: McpOAuthBinding): Promise<void>;
  setUserClientSecret(serverName: string, secret: string | undefined): Promise<boolean>;
  hasUserClientSecret(serverName: string): Promise<boolean>;
  /**
   * Called after commit/clear and when the 15s cross-process revision poll sees another process
   * commit; integration wires reconnect/rediscover + global events.
   */
  onStateChanged(listener: McpAuthStateListener): () => void;
  /** Lifecycle cleanup of every stored record whose namespace equals `namespace` (plugin uninstall). */
  deleteNamespace(namespace: string): Promise<void>;
  close(): Promise<void>;
}

export interface McpOAuthServiceDeps {
  dataDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: McpRuntimeLogger;
  /** CIMD client_id URL; defaults to `MCP_OAUTH_CIMD_CLIENT_ID`. */
  cimdUrl?: string;
  /** Cross-process credential revision poll interval; defaults to 15s (plan §5.4). */
  pollIntervalMs?: number;
}

export const MCP_OAUTH_CIMD_CLIENT_ID =
  'https://agent.minimax.io/minimax-code/oauth/mcp-client.json';

export type McpOAuthErrorCode =
  | 'MCP_AUTH_REQUIRED'
  | 'MCP_OAUTH_DISCOVERY_FAILED'
  | 'MCP_OAUTH_METADATA_INVALID'
  | 'MCP_OAUTH_PKCE_UNSUPPORTED'
  | 'MCP_OAUTH_REGISTRATION_FAILED'
  | 'MCP_OAUTH_CALLBACK_PORT_IN_USE'
  | 'MCP_OAUTH_ISSUER_MISMATCH'
  | 'MCP_OAUTH_ACCESS_DENIED'
  | 'MCP_OAUTH_TOKEN_EXCHANGE_FAILED'
  | 'MCP_OAUTH_CLIENT_REJECTED'
  | 'MCP_OAUTH_ATTEMPT_NOT_FOUND'
  | 'MCP_OAUTH_STATIC_AUTHORIZATION'
  | 'MCP_OAUTH_TRANSPORT_UNSUPPORTED'
  | 'MCP_OAUTH_PRIVATE_NETWORK_BLOCKED'
  | 'MCP_OAUTH_TARGET_NOT_FOUND'
  | 'MCP_OAUTH_UNSUPPORTED';

/** Stable OAuth failure. Messages never contain tokens, secrets, URLs with query strings or response bodies. */
export class McpOAuthError extends Error {
  override readonly name = 'McpOAuthError';

  constructor(
    readonly code: McpOAuthErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}
