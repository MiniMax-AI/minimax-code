import type { McpToolEntry } from '@mavis/agent-tools';
import type {
  LocalMavisMcpAdapter,
  ManagedBackendRoutingContext as LocalRuntimeRoutingContext,
} from '@mavis/agent-tools/desktop';
import type { McpConnectionPool } from '@mavis/mcp/runtime/connection-pool';
import type {
  McpConnectionTokenOverrides,
  McpRuntimeLogger,
  McpToolCallResult,
} from '@mavis/mcp/runtime/types';
import type { GlobalEventInput } from '@mavis/shared/global-events';
import type { McpAuthState, McpOAuthService } from './oauth/index.js';

/** Public OAuth client settings of a remote server (plan §6.1); never holds a secret. */
export interface LocalMcpOAuthConfig {
  clientId?: string;
  scopes?: string[];
  callbackPort?: number;
  callbackHost?: 'localhost' | '127.0.0.1';
  authServerMetadataUrl?: string;
}

type McpTransport = 'stdio' | 'http' | 'streamable-http' | 'sse';

export type McpServerConfig =
  | {
      readonly transport: 'stdio';
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
      readonly description?: string;
    }
  | {
      readonly transport: Exclude<McpTransport, 'stdio'>;
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly oauth?: Readonly<LocalMcpOAuthConfig>;
      readonly timeoutMs?: number;
      readonly description?: string;
    };

export interface McpServerSummary {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: McpTransport;
  readonly description?: string;
  readonly endpoint?: string;
  readonly configJson: '{}';
  /** Remote servers only; stdio servers never take part in OAuth. */
  readonly authState?: McpAuthState;
}

export interface McpServerDetail {
  readonly name: string;
  readonly enabled: boolean;
  readonly config: McpServerConfig;
  /** Whether a confidential client secret is stored for this user server. */
  readonly oauthClientSecretConfigured?: boolean;
}

interface McpConnectionTestResult {
  readonly success: boolean;
  readonly toolCount?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface McpSettingsService {
  list(keyword?: string): Promise<readonly McpServerSummary[]>;
  get(name: string): Promise<McpServerDetail | undefined>;
  create(name: string, config: McpServerConfig, enabled?: boolean): Promise<McpServerDetail>;
  update(name: string, config: McpServerConfig): Promise<McpServerDetail>;
  delete(name: string): Promise<boolean>;
  setEnabled(name: string, enabled: boolean): Promise<McpServerSummary>;
  test(name: string): Promise<McpConnectionTestResult>;
}

export interface LocalMcpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface LocalMcpNativeToolInfo extends LocalMcpToolInfo {
  server: string;
  toolName: string;
  nativeName: string;
  transport: string;
  builtin: boolean;
  configured: boolean;
  source: 'builtin-matrix' | 'builtin' | 'configured';
}

export interface LocalMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: 'stdio' | 'http' | 'sse' | 'streamable-http';
  /** Raw `oauth` block as stored; validated by its source before use. */
  oauth?: Record<string, unknown>;
  enabled?: boolean;
  configured?: boolean;
  builtin?: boolean;
  description?: string;
  timeout?: number;
  metadata?: Record<string, unknown>;
  headers?: Record<string, string>;
  tools?: LocalMcpToolInfo[];
}

export interface LocalMcpManagedServerSummary {
  name: string;
  enabled: boolean;
  transport?: string;
  description?: string;
  configJson: string;
}

type ConfiguredMcpTransport = 'stdio' | 'http' | 'streamable-http' | 'sse';

export type ConfiguredMcpServerInput =
  | {
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      timeoutMs?: number;
      description?: string;
    }
  | {
      transport: Exclude<ConfiguredMcpTransport, 'stdio'>;
      url: string;
      headers?: Record<string, string>;
      oauth?: LocalMcpOAuthConfig;
      timeoutMs?: number;
      description?: string;
    };

export interface ConfiguredMcpServerSummary {
  name: string;
  enabled: boolean;
  transport: ConfiguredMcpTransport;
  description?: string;
  endpoint?: string;
  /** Retained for wire compatibility; list responses never expose configuration secrets. */
  configJson: '{}';
  authState?: McpAuthState;
}

export interface ConfiguredMcpServerDetail {
  name: string;
  enabled: boolean;
  config: ConfiguredMcpServerInput;
  oauthClientSecretConfigured?: boolean;
}

export interface ConfiguredMcpConnectionTestResult {
  success: boolean;
  toolCount?: number;
  errorCode?:
    | 'MCP_SERVER_DISABLED'
    | 'MCP_CONNECTION_UNAVAILABLE'
    | 'MCP_CONNECTION_TIMEOUT'
    | 'MCP_COMMAND_NOT_FOUND'
    | 'MCP_HANDSHAKE_FAILED'
    | 'MCP_CONNECTION_FAILED'
    | 'MCP_AUTH_REQUIRED';
  errorMessage?: string;
}

type LocalMcpPublicStatus = 'available' | 'configured' | 'disabled' | 'error' | 'unavailable';

export interface LocalMcpPublicServerStatus {
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http' | 'sse' | 'none';
  description?: string;
  status: LocalMcpPublicStatus;
  available: boolean;
  error?: string;
}

export interface LocalMcpPublicServerCapability extends LocalMcpPublicServerStatus {
  sourceKind: 'builtin' | 'configured';
  sourceScope?: 'project' | 'session';
  managed: boolean;
  tools: Array<{ name: string; description?: string }>;
}

/** Public alias retained for local-runtime callers; MCP owns the wire shape. */
export type LocalMcpCallResult = McpToolCallResult;

export interface LocalMcpAuthContext {
  accessToken?: string;
  realUserID?: string;
  userEmail?: string;
  userName?: string;
  subUserName?: string;
}

export interface LocalMcpCallOptions {
  context?: LocalMcpRuntimeContext;
  signal?: AbortSignal;
}

export interface LocalMcpRuntimeContext {
  /** Runtime Session whose ephemeral MCP overlay should be used for this turn. */
  sessionId?: string;
  workspaceRoot?: string;
  /** Turn whose discovery triggered the connection; carried on `mcp.auth_required`. */
  turnId?: string;
  /** local-runtime dataDir; builtin matrix derives its assets input root from it. */
  dataDir?: string;
  authContext?: LocalMcpAuthContext;
  routingContext?: LocalRuntimeRoutingContext;
}

interface LocalMcpBuiltinMatrixOptions {
  enabled?: boolean;
  /**
   * When true, the built-in Matrix MCP server exposes only `web_search`. Used
   * when mcode-tools owns the Matrix media/generation tools but does NOT
   * provide web search, so the Matrix stdio child must stay alive to keep
   * `web_search` available while the redundant media tools are hidden.
   */
  webSearchOnly?: boolean;
}

export interface LocalMcpServiceOptions {
  nowMs?: () => number;
  /**
   * Live MCP connection pool. When provided, `LocalMcpService.call()` and
   * `.listTools()` will spawn the configured stdio/http transport and route
   * through it. When omitted, the service falls back to `metadata.mockResponses`
   * (the legacy clean-runtime path used by host-side tests).
   *
   * `resolveTokenOverrides` is invoked per-call so the caller can inject
   * identity headers / env at spawn time (e.g. archon parent user id).
   */
  connectionPool?: McpConnectionPool;
  /**
   * Turn discovery budget override for remote MCP servers, and for stdio servers when
   * `turnStdioDiscoveryTimeoutMs` is unset. Takes precedence over the environment defaults.
   */
  turnDiscoveryTimeoutMs?: number;
  /** Turn discovery budget override for stdio servers, which may cold-start through npx/uvx. */
  turnStdioDiscoveryTimeoutMs?: number;
  builtinMatrix?: LocalMcpBuiltinMatrixOptions;
  /** OAuth for user `mcp.json` and project `.mcp.json` remote servers. */
  oauth?: McpOAuthService;
  publishGlobalEvent?: (event: GlobalEventInput<'mcp.auth_required'>) => void;
  logger?: McpRuntimeLogger;
  resolveTokenOverrides?: (
    serverName: string,
    config?: LocalMcpServerConfig,
    context?: LocalMcpRuntimeContext,
  ) => McpConnectionTokenOverrides | undefined | Promise<McpConnectionTokenOverrides | undefined>;
}

export interface LocalMcpSessionServer {
  readonly name: string;
  readonly config: LocalMcpServerConfig;
}

type Emit = (type: string, payload: Record<string, unknown>) => void;

/** Capabilities consumed by turn assembly and the not-yet-migrated standalone Skill registry. */
export interface McpRuntimeCapability {
  isBuiltinMatrixAvailable(): boolean;
  readConfiguredServerNames(): Promise<Set<string>>;
  createMavisAdapter(emit: Emit): LocalMavisMcpAdapter;
  listToolEntriesForTurn(input: {
    sessionId: string;
    workspaceRoot: string;
    turnId?: string;
    authContext?: LocalMcpRuntimeContext['authContext'];
    routingContextGetter?: () => LocalMcpRuntimeContext['routingContext'];
    emitBusEvent: Emit;
  }): Promise<McpToolEntry[]>;
}

/** Process-local project configuration inspection; never includes credentials. */
export interface ProjectMcpPreview {
  path: string;
  digest: string;
  error?: string;
  servers: Array<{
    name: string;
    transport: string;
    target: string;
    status: 'configured' | 'available' | 'disabled' | 'error';
    error?: string;
  }>;
}
