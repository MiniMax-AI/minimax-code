import type {
  AgentHostTurnCapabilityView as DesktopTurnCapabilityView,
  AgentHostTurnRuntimeToolBinding as DesktopTurnRuntimeToolBinding,
} from '../../turn-system/index.js';
import { attachProgrammaticErrorRaw } from '@mavis/agent-core/tools';
import {
  describeMcpCallError,
  findMcpAuthRequiredError,
  McpNameRegistry,
  pluginMcpNameKey,
  McpConnectionPool,
  type McpAuthRequiredError,
  type McpConnectionPoolOptions,
  type McpConnectionTokenOverrides,
  type McpPoolMetrics,
  type McpRequestAuthorizer,
  type McpRuntimeLogger,
  type McpToolCallResult,
  type McpToolInfo,
} from '@mavis/mcp';

import type {
  PluginSnapshotDiagnostic,
  PluginSnapshotMcpServer,
} from '../plugin/runtime/snapshot-builder.js';

type DesktopRuntimeTool = DesktopTurnCapabilityView['runtimeTools'][number];

const LIST_TOOLS_CONCURRENCY = 4;

export interface PluginMcpPool {
  listTools(
    serverName: string,
    tokenOverrides?: McpConnectionTokenOverrides,
  ): Promise<McpToolInfo[]>;
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    tokenOverrides?: McpConnectionTokenOverrides,
    options?: { signal?: AbortSignal },
  ): Promise<McpToolCallResult>;
  disconnect(serverName: string): Promise<void>;
  shutdown(): Promise<void>;
}

/** Resolves OAuth credentials of remote Plugin servers; implemented by `mcp/oauth.ts`. */
export interface PluginMcpRuntimeAuth {
  /** Undefined for stdio, Mini App managed, static-Authorization, or unscoped servers. */
  resolve(entry: PluginSnapshotMcpServer): PluginMcpServerCredential | undefined;
}

export interface PluginMcpServerCredential {
  readonly authorizer: McpRequestAuthorizer;
  /** Local credential-state check only: true while the server is known to need authorization. */
  shouldSkipBackground(): Promise<boolean>;
  markObserved(outcome: 'connected' | McpAuthRequiredError): Promise<void>;
  /** Background discovery or a tool call found that the user must authorize the server. */
  authRequired(error: McpAuthRequiredError): void;
}

export interface PluginMcpRuntimePort {
  reconcile(
    entries: readonly PluginSnapshotMcpServer[],
    options?: PluginMcpReconcileOptions,
  ): Promise<PluginMcpReconcileResult>;
  disconnectServers(serverNames: readonly string[]): Promise<void>;
  close(): Promise<void>;
  /** Export only successful immutable tools/list inventories for a new generation. */
  exportInventory?(): readonly PluginMcpInventorySeed[];
  /** Seed a fresh generation before reconciling its server declarations. */
  importInventory?(seed: readonly PluginMcpInventorySeed[]): void;
  /**
   * A retired runtime keeps serving turns admitted before it was replaced; a managed Mini App
   * server it already resolved must follow that Mini App's restart instead of staying pinned to
   * the process (and loopback token) publication just replaced.
   */
  adoptManagedServers?(entries: readonly PluginSnapshotMcpServer[]): Promise<void>;
  /** Drops these servers' inventories so the next generation lists them again. */
  forgetInventories?(serverNames: readonly string[]): void;
  /** One tools/list with credentials attached, bypassing cached state; never authorizes. */
  probe?(serverName: string): Promise<'connected' | McpAuthRequiredError | Error>;
}

export interface PluginMcpInventorySeed {
  readonly serverName: string;
  readonly lifecycleKey: string;
  readonly tools: readonly McpToolInfo[];
}

export interface PluginMcpReconcileOptions {
  /** Reuse the last inventory for unchanged servers during a targeted local mutation. */
  readonly reuseExistingInventory?: boolean;
  /**
   * Choose which inventories may perform MCP network I/O. Managed discovery is used by
   * publication participants that must verify rewritten Host-owned endpoints without
   * synchronously probing unrelated ordinary Plugin MCP servers.
   */
  readonly inventoryMode?: 'cached-only' | 'discover-managed' | 'discover';
}

/** One call of a Mini App's managed MCP tool, with the session and turn that made it. */
export interface ManagedMiniAppToolCall {
  readonly pluginName: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface PluginMcpRuntimeOptions {
  readonly names?: McpNameRegistry;
  readonly pool?: PluginMcpPool;
  readonly auth?: PluginMcpRuntimeAuth;
  readonly logger?: McpRuntimeLogger;
  readonly metrics?: McpPoolMetrics;
  readonly poolOptions?: Pick<McpConnectionPoolOptions, 'idleTimeoutMs' | 'maxConcurrency'>;
  readonly listToolsTimeoutMs?: number;
  readonly disconnectTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  /**
   * A call reached a Mini App's managed MCP tool. The observer decides whether it holds the
   * plugin for the calling turn; it must not throw or block (failures are swallowed).
   */
  readonly onManagedMiniAppToolCall?: (call: ManagedMiniAppToolCall) => void;
}

export interface PluginMcpReconcileResult {
  readonly runtimeTools: readonly DesktopRuntimeTool[];
  readonly runtimeToolBindings?: readonly DesktopTurnRuntimeToolBinding[];
  readonly diagnostics: readonly PluginSnapshotDiagnostic[];
  readonly failedServerCount: number;
}

interface CachedMcpInventory {
  readonly lifecycleKey: string;
  readonly tools: readonly McpToolInfo[];
  readonly state: 'ready' | 'failed' | 'auth_required';
}

/**
 * Desktop Plugin MCP owner. Its pool and lookup are deliberately separate
 * from v1 LocalMcpService, whose connections belong to the user's mcp.json.
 */
export class PluginMcpRuntime implements PluginMcpRuntimePort {
  private readonly servers = new Map<string, PluginSnapshotMcpServer>();
  private readonly lifecycleKeys = new Map<string, string>();
  private readonly inventories = new Map<string, CachedMcpInventory>();
  /** Resolved per lookup generation; `null` caches "no credential" for that server. */
  private readonly credentials = new Map<string, PluginMcpServerCredential | null>();
  private readonly pool: PluginMcpPool;
  private readonly auth: PluginMcpRuntimeAuth | undefined;
  private readonly logger: McpRuntimeLogger;
  private readonly metrics: McpPoolMetrics | undefined;
  private readonly listToolsTimeoutMs: number;
  private readonly disconnectTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly onManagedMiniAppToolCall: ((call: ManagedMiniAppToolCall) => void) | undefined;
  private closed = false;
  private readonly names: McpNameRegistry;

  constructor(options: PluginMcpRuntimeOptions = {}) {
    this.names = options.names ?? new McpNameRegistry();
    this.auth = options.auth;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.metrics = options.metrics;
    this.listToolsTimeoutMs = options.listToolsTimeoutMs ?? 15_000;
    this.disconnectTimeoutMs = options.disconnectTimeoutMs ?? 5_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.onManagedMiniAppToolCall = options.onManagedMiniAppToolCall;
    this.pool =
      options.pool ??
      new McpConnectionPool(
        {
          getResolvedServer: (serverName) =>
            this.servers.get(serverName)?.server.resolvedServer ?? null,
        },
        {
          ...options.poolOptions,
          logger: this.logger,
          ...(options.metrics ? { metrics: options.metrics } : {}),
        },
      );
  }

  async reconcile(
    entries: readonly PluginSnapshotMcpServer[],
    options: PluginMcpReconcileOptions = {},
  ): Promise<PluginMcpReconcileResult> {
    if (this.closed) throw new Error('Plugin MCP runtime is closed');
    this.names.assignServers(
      entries.map((entry) => ({
        key: pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name),
        name: entry.server.name,
      })),
    );
    const inventoryMode = options.inventoryMode ?? 'discover';
    if (inventoryMode !== 'discover') this.retainExactInventories(entries);
    else await this.disconnectStaleServers(entries);
    this.replaceLookup(entries);

    const runtimeTools: DesktopRuntimeTool[] = [];
    const runtimeToolBindings: DesktopTurnRuntimeToolBinding[] = [];
    const diagnostics: PluginSnapshotDiagnostic[] = [];
    const toolNames = new Set<string>();
    let failedServerCount = 0;
    const inventories = await mapBounded(entries, LIST_TOOLS_CONCURRENCY, async (entry) =>
      shouldDiscoverInventory(entry, inventoryMode)
        ? this.resolveInventory(entry, options.reuseExistingInventory === true)
        : this.resolveCachedInventory(entry),
    );

    for (const [index, entry] of entries.entries()) {
      const inventory = inventories[index];
      if (!inventory || inventory.state !== 'ready') {
        const diagnostic = unavailableServerDiagnostic(entry, inventory, inventoryMode);
        // Waiting on the user is not a failure: retrying cannot succeed before authorization.
        if (diagnostic.code !== 'MCP_SERVER_AUTH_REQUIRED') failedServerCount += 1;
        diagnostics.push(diagnostic);
        continue;
      }
      for (const { tool, nativeName } of this.assignToolNames(
        entry,
        inventory.tools,
        diagnostics,
      )) {
        const key = collisionKey(nativeName);
        if (toolNames.has(key)) {
          diagnostics.push(
            freeze({
              code: 'MCP_TOOL_NAME_CONFLICT',
              pluginName: entry.pluginName,
              capabilityName: tool.name,
            }),
          );
          continue;
        }
        toolNames.add(key);
        const runtimeTool = this.runtimeTool(entry, tool, nativeName);
        runtimeTools.push(runtimeTool);
        runtimeToolBindings.push(
          freeze({
            kind: 'mcp',
            source: entry.server.name,
            pluginName: entry.pluginName,
            mcpToolName: tool.name,
            tool: runtimeTool,
          }),
        );
      }
    }

    return freeze({
      runtimeTools: freeze(runtimeTools),
      runtimeToolBindings: freeze(runtimeToolBindings),
      diagnostics: freeze(diagnostics),
      failedServerCount,
    });
  }

  private assignToolNames(
    entry: PluginSnapshotMcpServer,
    tools: readonly McpToolInfo[],
    diagnostics: PluginSnapshotDiagnostic[],
  ): { readonly tool: McpToolInfo; readonly nativeName: string }[] {
    const allocated = this.names.assignTools(
      pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name),
      tools.map((tool) => tool.name),
    );
    return tools.flatMap((tool) => {
      const nativeName = allocated.names.get(tool.name);
      if (nativeName) return [{ tool, nativeName }];
      diagnostics.push({
        code: 'MCP_TOOL_NAME_INVALID',
        pluginName: entry.pluginName,
        capabilityName: tool.name,
      });
      return [];
    });
  }

  exportInventory(): readonly PluginMcpInventorySeed[] {
    if (this.closed) return [];
    return freeze(
      [...this.inventories.entries()].flatMap(([serverName, inventory]) =>
        inventory.state !== 'ready'
          ? []
          : [
              freeze({
                serverName,
                lifecycleKey: inventory.lifecycleKey,
                tools: freeze([...inventory.tools]),
              }),
            ],
      ),
    );
  }

  importInventory(seed: readonly PluginMcpInventorySeed[]): void {
    if (this.closed || this.servers.size > 0 || this.inventories.size > 0) return;
    for (const item of seed) {
      this.lifecycleKeys.set(item.serverName, item.lifecycleKey);
      this.inventories.set(
        item.serverName,
        freeze({
          lifecycleKey: item.lifecycleKey,
          tools: freeze([...item.tools]),
          state: 'ready',
        }),
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.servers.clear();
    this.lifecycleKeys.clear();
    this.inventories.clear();
    this.credentials.clear();
    await ignoreFailure(
      withTimeout(
        this.pool.shutdown(),
        this.shutdownTimeoutMs,
        'Plugin MCP runtime shutdown timed out',
      ),
    );
  }

  async disconnectServers(serverNames: readonly string[]): Promise<void> {
    await Promise.allSettled(
      [...new Set(serverNames)].map((serverName) => this.disconnectBounded(serverName)),
    );
  }

  forgetInventories(serverNames: readonly string[]): void {
    for (const serverName of serverNames) this.inventories.delete(serverName);
  }

  async probe(serverName: string): Promise<'connected' | McpAuthRequiredError | Error> {
    const entry = this.servers.get(serverName);
    if (this.closed || !entry) return new Error('Plugin MCP server is not loaded');
    try {
      await withTimeout(
        this.pool.listTools(serverName, this.connectionOverrides(entry)),
        this.listToolsTimeoutMs,
        `Plugin MCP tools/list timed out for ${entry.server.name}`,
      );
      return 'connected';
    } catch (error) {
      await this.disconnectBounded(serverName);
      const authError = findMcpAuthRequiredError(error);
      if (authError) return authError;
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  async adoptManagedServers(entries: readonly PluginSnapshotMcpServer[]): Promise<void> {
    if (this.closed) return;
    const changed: string[] = [];
    for (const entry of entries) {
      if (entry.managedIdentity?.kind !== 'miniapp') continue;
      const name = poolName(entry);
      if (this.servers.get(name)?.managedIdentity?.kind !== 'miniapp') continue;
      const key = lifecycleKey(entry);
      if (this.lifecycleKeys.get(name) === key) continue;
      this.servers.set(name, entry);
      this.lifecycleKeys.set(name, key);
      changed.push(name);
    }
    await this.disconnectServers(changed);
  }

  private async disconnectBounded(serverName: string): Promise<void> {
    await ignoreFailure(
      withTimeout(
        this.pool.disconnect(serverName),
        this.disconnectTimeoutMs,
        `Plugin MCP disconnect timed out for ${serverName}`,
      ),
    );
  }

  private async disconnectStaleServers(entries: readonly PluginSnapshotMcpServer[]): Promise<void> {
    const nextKeys = new Map(entries.map((entry) => [poolName(entry), lifecycleKey(entry)]));
    const stale = [...this.lifecycleKeys].flatMap(([serverName, priorKey]) =>
      nextKeys.get(serverName) === priorKey ? [] : [serverName],
    );
    await this.disconnectServers(stale);
    for (const serverName of stale) this.inventories.delete(serverName);
  }

  private retainExactInventories(entries: readonly PluginSnapshotMcpServer[]): void {
    const nextKeys = new Map(entries.map((entry) => [poolName(entry), lifecycleKey(entry)]));
    for (const [serverName, inventory] of this.inventories) {
      if (nextKeys.get(serverName) !== inventory.lifecycleKey || inventory.state !== 'ready') {
        this.inventories.delete(serverName);
      }
    }
  }

  /** Never connects; a stored needs-authorization state is a local file read. */
  private async resolveCachedInventory(
    entry: PluginSnapshotMcpServer,
  ): Promise<CachedMcpInventory> {
    const key = lifecycleKey(entry);
    const existing = this.inventories.get(poolName(entry));
    if (existing?.lifecycleKey === key && existing.state === 'ready') return existing;
    if (await skipsBackground(this.credentialFor(entry))) return this.authRequired(entry);
    return freeze({ lifecycleKey: key, tools: freeze([] as McpToolInfo[]), state: 'failed' });
  }

  private async resolveInventory(
    entry: PluginSnapshotMcpServer,
    reuseExisting: boolean,
  ): Promise<CachedMcpInventory> {
    const key = lifecycleKey(entry);
    const existing = this.inventories.get(poolName(entry));
    if (reuseExisting && existing?.lifecycleKey === key && existing.state !== 'auth_required') {
      return existing;
    }
    const credential = this.credentialFor(entry);
    if (await skipsBackground(credential)) return this.authRequired(entry);

    try {
      const tools = await withTimeout(
        this.pool.listTools(poolName(entry), this.connectionOverrides(entry)),
        this.listToolsTimeoutMs,
        `Plugin MCP tools/list timed out for ${entry.server.name}`,
      );
      this.metrics?.incr('plugin_mcp_list_total', { status: 'ok' });
      if (credential) await ignoreFailure(credential.markObserved('connected'));
      const inventory: CachedMcpInventory = freeze({
        lifecycleKey: key,
        tools: freeze([...tools]),
        state: 'ready',
      });
      this.inventories.set(poolName(entry), inventory);
      return inventory;
    } catch (error) {
      await this.disconnectBounded(poolName(entry));
      const authRequired = await this.observeAuthFailure(entry, error);
      this.metrics?.incr('plugin_mcp_list_total', {
        status: authRequired ? 'auth_required' : 'error',
      });
      if (authRequired) return this.authRequired(entry);
      this.logger.warn('Plugin MCP tools/list failed', {
        pluginName: entry.pluginName,
        source: entry.source,
        serverName: entry.server.name,
        errorType: errorType(error),
      });
      const inventory: CachedMcpInventory = freeze({
        lifecycleKey: key,
        tools: freeze([] as McpToolInfo[]),
        state: 'failed',
      });
      this.inventories.set(poolName(entry), inventory);
      return inventory;
    }
  }

  private authRequired(entry: PluginSnapshotMcpServer): CachedMcpInventory {
    const inventory: CachedMcpInventory = freeze({
      lifecycleKey: lifecycleKey(entry),
      tools: freeze([] as McpToolInfo[]),
      state: 'auth_required',
    });
    this.inventories.set(poolName(entry), inventory);
    return inventory;
  }

  private credentialFor(entry: PluginSnapshotMcpServer): PluginMcpServerCredential | undefined {
    const name = poolName(entry);
    const cached = this.credentials.get(name);
    if (cached !== undefined) return cached ?? undefined;
    const credential = this.auth?.resolve(entry);
    this.credentials.set(name, credential ?? null);
    return credential;
  }

  private connectionOverrides(
    entry: PluginSnapshotMcpServer,
  ): McpConnectionTokenOverrides | undefined {
    const credential = this.credentialFor(entry);
    return credential ? { authorizer: credential.authorizer } : undefined;
  }

  private replaceLookup(entries: readonly PluginSnapshotMcpServer[]): void {
    this.servers.clear();
    this.lifecycleKeys.clear();
    this.credentials.clear();
    for (const entry of entries) {
      this.servers.set(poolName(entry), entry);
      this.lifecycleKeys.set(poolName(entry), lifecycleKey(entry));
    }
  }

  /** True when `error` means the user must authorize a server that has credentials. */
  private async observeAuthFailure(
    entry: PluginSnapshotMcpServer,
    error: unknown,
  ): Promise<boolean> {
    const credential = this.credentialFor(entry);
    const authError = credential ? findMcpAuthRequiredError(error) : undefined;
    if (!credential || !authError) return false;
    await ignoreFailure(credential.markObserved(authError));
    credential.authRequired(authError);
    return true;
  }

  private runtimeTool(
    entry: PluginSnapshotMcpServer,
    tool: McpToolInfo,
    nativeName: string,
  ): DesktopRuntimeTool {
    const def: DesktopRuntimeTool['def'] = freeze({
      name: nativeName,
      description:
        tool.description ??
        `Call MCP tool ${tool.name} from Plugin ${entry.pluginName} server ${entry.server.name}.`,
      schema: freeze({ ...tool.inputSchema }) as DesktopRuntimeTool['def']['schema'],
    });
    return freeze({
      def,
      impl: freeze({
        execute: async (context, input, signal) => {
          if (entry.managedIdentity?.kind === 'miniapp') {
            try {
              this.onManagedMiniAppToolCall?.({
                pluginName: entry.pluginName,
                sessionId: context.sessionId,
                turnId: context.turnId,
              });
            } catch {
              // The observer is advisory; the tool call proceeds regardless.
            }
          }
          let result: McpToolCallResult;
          try {
            result = await this.pool.callTool(
              poolName(entry),
              tool.name,
              toRecord(input),
              this.connectionOverrides(entry),
              signal ? { signal } : undefined,
            );
          } catch (error) {
            // The thrown error still fails the call exactly as before; PTC
            // scripts additionally get the JSON-RPC or connection error as
            // `error.raw`. Only the error class and code are logged.
            const raw = describeMcpCallError(error);
            const attached = raw !== undefined && attachProgrammaticErrorRaw(error, raw);
            this.logger.warn('Plugin MCP tool call failed', {
              pluginName: entry.pluginName,
              serverName: entry.server.name,
              toolName: tool.name,
              errorCode: raw?.code ?? null,
              rawAttached: attached,
            });
            await this.observeAuthFailure(entry, error);
            throw error;
          }
          const text = mcpContentToText(result);
          const content = toToolResultContent(result, text);
          return {
            tool_name: nativeName,
            text,
            content,
            ...(result.isError === true ? { isError: true } : {}),
            details: {
              mcp: result,
              server: entry.server.name,
              tool: tool.name,
              plugin: entry.pluginName,
            },
            output: { mcp: result },
            // PTC-only: structuredContent becomes `data` on success and on isError.
            ...(isPlainRecord(result.structuredContent)
              ? { programmatic: { data: result.structuredContent } }
              : {}),
          };
        },
      }),
      source: 'configured',
    });
  }
}

function unavailableServerDiagnostic(
  entry: PluginSnapshotMcpServer,
  inventory: CachedMcpInventory | undefined,
  inventoryMode: NonNullable<PluginMcpReconcileOptions['inventoryMode']>,
): PluginSnapshotDiagnostic {
  let code = 'MCP_SERVER_AUTH_REQUIRED';
  if (inventory?.state !== 'auth_required') {
    code = shouldDiscoverInventory(entry, inventoryMode)
      ? 'MCP_SERVER_LIST_FAILED'
      : 'MCP_SERVER_WARMING';
  }
  return freeze({ code, pluginName: entry.pluginName, capabilityName: entry.server.name });
}

function shouldDiscoverInventory(
  entry: PluginSnapshotMcpServer,
  inventoryMode: NonNullable<PluginMcpReconcileOptions['inventoryMode']>,
): boolean {
  return (
    inventoryMode === 'discover' ||
    (inventoryMode === 'discover-managed' && entry.managedIdentity !== undefined)
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * An unreadable credential store must not fail the whole reconcile: the server
 * is then attempted normally and fails on its own listing path.
 */
async function skipsBackground(
  credential: PluginMcpServerCredential | undefined,
): Promise<boolean> {
  try {
    return (await credential?.shouldSkipBackground()) === true;
  } catch {
    return false;
  }
}

async function ignoreFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Shutdown and stale-generation cleanup are bounded best-effort operations.
  }
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

/** `server` carries the `oauth` descriptor; the PluginId separates same-name credentials. */
function lifecycleKey(entry: PluginSnapshotMcpServer): string {
  return JSON.stringify({
    pluginName: entry.pluginName,
    pluginId: entry.pluginId,
    source: entry.source,
    server: entry.server.resolvedServer,
    ...(entry.managedIdentity ? { managedIdentity: entry.managedIdentity } : {}),
    ...(entry.server.resolvedServer.transport.type === 'stdio'
      ? { packageContentDigest: entry.packageContentDigest }
      : {}),
  });
}

function collisionKey(value: string): string {
  return value.startsWith('mcp__')
    ? value
    : value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toToolResultContent(
  result: McpToolCallResult,
  fallbackText: string,
): Awaited<ReturnType<DesktopRuntimeTool['impl']['execute']>>['content'] {
  const content = result.content.map((item) => {
    if (item.type === 'text') return { type: 'text' as const, text: item.text ?? '' };
    if (item.type === 'image' && item.data && item.mimeType) {
      return { type: 'image' as const, data: item.data, mimeType: item.mimeType };
    }
    return { type: 'text' as const, text: `[${item.type}]` };
  });
  return content.length > 0 ? content : [{ type: 'text', text: fallbackText }];
}

function mcpContentToText(result: McpToolCallResult): string {
  const text = result.content
    .map((item) => (item.type === 'text' ? (item.text ?? '') : `[${item.type}]`))
    .filter(Boolean)
    .join('\n');
  return text || (result.isError ? 'MCP tool returned an error.' : 'MCP tool returned no content.');
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

const NOOP_LOGGER: McpRuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function poolName(entry: PluginSnapshotMcpServer): string {
  return pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name);
}
