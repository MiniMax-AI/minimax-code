import { ProjectMcpRuntime } from '../project-mcp.service.js';
import { SessionMcpServers } from './session-servers.js';
import { projectNativeTools, reserveConfiguredServerNames } from './native-tool-projection.js';
import { McpNameRegistry } from '@mavis/mcp';
import type { RuntimeTool, ToolResult } from '@mavis/agent-core/tools';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LocalMavisMcpServiceAdapter } from '../tools/local-mavis-adapter.js';
import { mapMcpContent, normalizeCallResult } from '../tools/result-mapping.js';
import { listMcpRuntimeToolEntriesForTurn } from '../tools/runtime-tools.js';
import { readConfiguredMcpServerNames } from './config-file.js';
import { readLocalMcpFile, writeLocalMcpFile } from './configuration.repository.js';
import {
  configuredConnectionFailure,
  configuredDetail,
  configuredInputFromStored,
  ConfiguredMcpConnectionTimeoutError,
  configuredSummary,
  isUserConfiguredServer,
  publicTransport,
  requireConfiguredInput,
  requireUserConfiguredServer,
  storedConfigFromInput,
  toTypeSchema,
  toManagedServerSummary,
  validateConfiguredServerName,
  withConfiguredConnectionTimeout,
} from './settings-config.js';

import type { McpServerLookup } from '@mavis/mcp/runtime/connection-pool';
import type { McpConnectionTokenOverrides, ResolvedMcpServer } from '@mavis/mcp/runtime/types';
import { MCP_DEFAULTS } from '@mavis/mcp/runtime/types';
import {
  buildBuiltinMatrixServerConfig,
  buildBuiltinMatrixTokenOverrides,
  BUILTIN_MATRIX_SERVER_NAME,
  isBuiltinMatrixConfig,
  isRetiredLegacyMatrixMcpServerConfig,
  listBuiltinMatrixMcpToolDescriptors,
} from './builtin-matrix.js';
import {
  configToTransportConfig,
  hasLocalCallAdapter,
  inferAuthStatus,
  inferTransport,
  normalizeServerConfig,
  normalizeServerName,
  readConfiguredTools,
  readRecord,
  readStringArray,
} from './config.js';
import { isRetiredLegacyCuMcpServerConfig } from './retired-cu.js';

import type {
  ConfiguredMcpConnectionTestResult,
  ConfiguredMcpServerDetail,
  ConfiguredMcpServerInput,
  ConfiguredMcpServerSummary,
  LocalMcpCallResult,
  LocalMcpManagedServerSummary,
  LocalMcpNativeToolInfo,
  LocalMcpPublicServerCapability,
  LocalMcpPublicServerStatus,
  LocalMcpRuntimeContext,
  LocalMcpServerConfig,
  LocalMcpServiceOptions,
  LocalMcpSessionServer,
  LocalMcpToolInfo,
} from '../contracts.js';
import { LocalMcpSettingsError } from '../errors.js';

interface LocalMcpFile extends Record<string, unknown> {
  mcpServers: Record<string, LocalMcpServerConfig>;
}

interface LocalMcpRawDocument {
  document: Record<string, unknown>;
  servers: Record<string, unknown>;
}

export class LocalMcpService {
  private closed = false;
  private runtimeNames: McpNameRegistry | undefined;

  getRuntimeNameRegistry(): McpNameRegistry {
    this.runtimeNames ??= new McpNameRegistry(join(this.dataDir(), 'mcp-runtime-names.json'));
    return this.runtimeNames;
  }
  private readonly pendingReads = new Set<Promise<unknown>>();
  private closePromise: Promise<void> | undefined;
  private readonly shutdownSignal = new AbortController();

  private syncState: 'IDLE' | 'SYNCING' | 'SYNC_DONE' | 'SYNC_ERROR' = 'IDLE';
  private lastSyncError: string | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly publicRuntimeErrors = new Map<string, string>();
  private readonly publiclyAvailableServers = new Set<string>();
  /**
   * Last successfully parsed mcp.json contents. Populated by `readFile()` and
   * read by `getServerLookup().getResolvedServer()` which the connection pool
   * calls synchronously inside `doConnect`. Falls back to an empty record
   * before the first read.
   */
  private lastReadFile: LocalMcpFile | undefined;
  private readonly serverChangeListeners = new Set<() => void>();
  private readonly sessionServers: SessionMcpServers;
  private readonly projectMcp: ProjectMcpRuntime;

  constructor(
    private readonly dataDir: () => string,
    private options: LocalMcpServiceOptions = {},
  ) {
    this.sessionServers = new SessionMcpServers(options.connectionPool);
    this.projectMcp = new ProjectMcpRuntime(options.connectionPool);
  }

  getSessionMcpServers(sessionId: string) {
    return this.sessionServers.get(sessionId);
  }

  async disposeSession(sessionId: string): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.projectMcp.clearSession(sessionId);
      await this.sessionServers.remove(sessionId);
    });
  }

  async inspectProjectMcp(context: LocalMcpRuntimeContext) {
    this.assertOpen();
    const project = this.projectMcp;
    return this.enqueueMutation(() => project.inspect(context));
  }

  readConfiguredServerNames(): Promise<Set<string>> {
    this.assertOpen();
    return readConfiguredMcpServerNames(this.dataDir());
  }

  createMavisAdapter(
    emit: (type: string, payload: Record<string, unknown>) => void,
  ): LocalMavisMcpServiceAdapter {
    this.assertOpen();
    return new LocalMavisMcpServiceAdapter(this, emit);
  }

  listToolEntriesForTurn(
    input: Omit<Parameters<typeof listMcpRuntimeToolEntriesForTurn>[0], 'mcpService'>,
  ) {
    this.assertOpen();
    return listMcpRuntimeToolEntriesForTurn({ ...input, mcpService: this });
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.shutdownSignal.abort();
      this.closePromise = (async () => {
        await this.mutationQueue;
        await Promise.allSettled([...this.pendingReads]);
        await this.options.connectionPool?.shutdown();
        this.serverChangeListeners.clear();
        this.sessionServers.clear();
        this.publicRuntimeErrors.clear();
        this.publiclyAvailableServers.clear();
      })();
    }
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('MCP runtime has been closed');
  }

  onDidChangeServers(listener: () => void): () => void {
    this.assertOpen();
    this.serverChangeListeners.add(listener);
    return () => this.serverChangeListeners.delete(listener);
  }

  async configureSessionServers(
    sessionId: string,
    servers: readonly LocalMcpSessionServer[],
  ): Promise<void> {
    this.assertOpen();
    return this.enqueueMutation(() => this.sessionServers.configure(sessionId, servers));
  }

  async clearSessionServers(sessionId: string): Promise<void> {
    this.assertOpen();
    return this.enqueueMutation(() => this.sessionServers.remove(sessionId));
  }

  async listUserConfiguredServers(): Promise<LocalMcpManagedServerSummary[]> {
    this.assertOpen();
    const raw = await this.readRawDocument();
    this.lastReadFile = this.normalizeRawServers(raw.servers);
    return Object.entries(raw.servers)
      .flatMap(([rawName, rawConfig]) => {
        const rawConfigObject = readRecord(rawConfig);
        if (!rawConfigObject) return [];
        const name = normalizeServerName(rawName);
        const config = normalizeServerConfig(rawConfigObject);
        if (
          config.builtin === true ||
          isRetiredLegacyMatrixMcpServerConfig(name, config) ||
          isRetiredLegacyCuMcpServerConfig(name, config)
        ) {
          return [];
        }
        return [toManagedServerSummary(name, rawConfigObject, config)];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async setUserConfiguredServerEnabled(
    name: string,
    enabled: boolean,
  ): Promise<LocalMcpManagedServerSummary | undefined> {
    this.assertOpen();
    return this.enqueueMutation(async () => {
      const serverName = normalizeServerName(name);
      const raw = await this.readRawDocument();
      const entry = Object.entries(raw.servers).find(
        ([candidate]) => normalizeServerName(candidate) === serverName,
      );
      if (!entry) return undefined;
      const [rawName, rawCurrent] = entry;
      const current = readRecord(rawCurrent);
      if (!current) return undefined;
      const normalized = normalizeServerConfig(current);
      if (
        normalized.builtin === true ||
        isRetiredLegacyMatrixMcpServerConfig(serverName, normalized) ||
        isRetiredLegacyCuMcpServerConfig(serverName, normalized)
      ) {
        return undefined;
      }
      const next = { ...current, enabled };
      raw.servers[rawName] = next;
      raw.document['mcpServers'] = raw.servers;
      await this.writeRawDocument(raw.document);
      this.lastReadFile = this.normalizeRawServers(raw.servers);
      await this.options.connectionPool?.disconnect(serverName);
      this.resetPublicRuntimeStatus(serverName);
      this.notifyServerChangeListeners();
      return toManagedServerSummary(serverName, next, normalizeServerConfig(next));
    });
  }

  isBuiltinMatrixAvailable(): boolean {
    this.assertOpen();
    return this.isBuiltinMatrixEnabled();
  }

  async listPublicServerStatuses(): Promise<LocalMcpPublicServerStatus[]> {
    this.assertOpen();
    const file = await this.readFile();
    const statuses: LocalMcpPublicServerStatus[] = [];
    for (const [name, config] of Object.entries(file.mcpServers)) {
      if (config.builtin === true || config.configured === false) continue;
      const base = {
        name,
        enabled: config.enabled !== false,
        transport: publicTransport(config),
        ...(config.description ? { description: config.description } : {}),
      };
      if (config.enabled === false) {
        statuses.push({ ...base, status: 'disabled', available: false });
        continue;
      }
      const runtimeError = this.publicRuntimeErrors.get(name);
      if (runtimeError) {
        statuses.push({ ...base, status: 'error', available: false, error: runtimeError });
        continue;
      }
      const unavailable = this.unavailableReason(config);
      if (unavailable) {
        statuses.push({ ...base, status: 'unavailable', available: false, error: unavailable });
        continue;
      }
      statuses.push(
        this.publiclyAvailableServers.has(name)
          ? { ...base, status: 'available', available: true }
          : { ...base, status: 'configured', available: false },
      );
    }
    return statuses;
  }

  async listBuiltinPublicServerCapabilities(): Promise<LocalMcpPublicServerCapability[]> {
    this.assertOpen();
    if (this.options.builtinMatrix?.enabled !== true) return [];
    const available = this.isBuiltinMatrixEnabled();
    return [
      {
        name: BUILTIN_MATRIX_SERVER_NAME,
        sourceKind: 'builtin',
        managed: true,
        enabled: available,
        transport: 'stdio',
        description: 'Built-in Matrix capabilities for web and media workflows.',
        status: available ? 'available' : 'unavailable',
        available,
        ...(!available ? { error: 'Built-in MCP server is not active in this Runtime.' } : {}),
        tools: listBuiltinMatrixMcpToolDescriptors().map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
        })),
      },
    ];
  }

  async listServers(context?: LocalMcpRuntimeContext) {
    this.assertOpen();
    const file = this.withBuiltinServers(await this.readFile(), context);
    return Object.entries(file.mcpServers).map(([name, config]) => {
      const tools = readConfiguredTools(config);
      return {
        name,
        transport: inferTransport(config),
        authStatus: inferAuthStatus(config),
        skillStatus: tools.length > 0 ? 'active' : 'not_generated',
        enabled: config.enabled !== false,
        configured: config.configured !== false,
        builtin: config.builtin === true,
        description: config.description,
        tools: {
          count: tools.length,
          items: tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
          })),
          syncedAt: this.nowMs(),
        },
      };
    });
  }

  async listConfiguredServers(keyword?: string): Promise<ConfiguredMcpServerSummary[]> {
    this.assertOpen();
    const file = await this.readFile(true);
    const normalizedKeyword = keyword?.trim().toLocaleLowerCase();
    return Object.entries(file.mcpServers).flatMap(([name, config]) => {
      if (!isUserConfiguredServer(config)) return [];
      if (normalizedKeyword && !name.toLocaleLowerCase().includes(normalizedKeyword)) return [];
      const input = configuredInputFromStored(config);
      if (!input) return [];
      return [configuredSummary(name, config, input)];
    });
  }

  /** Existing configuration keys must be addressed exactly, without creation-time normalization. */
  async getConfiguredServer(name: string): Promise<ConfiguredMcpServerDetail | undefined> {
    this.assertOpen();
    const serverName = name;
    const config = (await this.readFile(true)).mcpServers[serverName];
    if (!config || !isUserConfiguredServer(config)) return undefined;
    const input = configuredInputFromStored(config);
    if (!input) return undefined;
    return configuredDetail(serverName, config, input);
  }

  async createConfiguredServer(
    name: string,
    input: ConfiguredMcpServerInput,
    enabled = true,
  ): Promise<ConfiguredMcpServerDetail> {
    this.assertOpen();
    const serverName = validateConfiguredServerName(name);
    if (this.isBuiltinMatrixServerName(serverName)) {
      throw new LocalMcpSettingsError(
        409,
        `MCP server "${serverName}" already exists.`,
        'MCP_SERVER_EXISTS',
      );
    }
    const stored = storedConfigFromInput(input, enabled);
    return this.enqueueMutation(async () => {
      const file = await this.readFileWithinMutation(true);
      if (file.mcpServers[serverName]) {
        throw new LocalMcpSettingsError(
          409,
          `MCP server "${serverName}" already exists.`,
          'MCP_SERVER_EXISTS',
        );
      }
      file.mcpServers[serverName] = stored;
      await this.writeFile(file);
      this.notifyServerChangeListeners();
      return configuredDetail(serverName, stored, requireConfiguredInput(stored));
    });
  }

  async updateConfiguredServer(
    name: string,
    input: ConfiguredMcpServerInput,
    enabled?: boolean,
  ): Promise<ConfiguredMcpServerDetail> {
    this.assertOpen();
    const serverName = name;
    return this.enqueueMutation(async () => {
      const file = await this.readFileWithinMutation(true);
      const current = requireUserConfiguredServer(file, serverName);
      const stored = storedConfigFromInput(input, enabled ?? current.enabled !== false);
      await this.writeConfiguredMutation(serverName, {
        ...file,
        mcpServers: { ...file.mcpServers, [serverName]: stored },
      });
      return configuredDetail(serverName, stored, requireConfiguredInput(stored));
    });
  }

  async deleteConfiguredServer(name: string): Promise<boolean> {
    this.assertOpen();
    const serverName = name;
    return this.enqueueMutation(async () => {
      const file = await this.readFileWithinMutation(true);
      requireUserConfiguredServer(file, serverName);
      const remainingServers = { ...file.mcpServers };
      delete remainingServers[serverName];
      await this.writeConfiguredMutation(serverName, {
        ...file,
        mcpServers: remainingServers,
      });
      return true;
    });
  }

  async setConfiguredServerEnabled(
    name: string,
    enabled: boolean,
  ): Promise<ConfiguredMcpServerSummary> {
    this.assertOpen();
    const serverName = name;
    return this.enqueueMutation(async () => {
      const file = await this.readFileWithinMutation(true);
      const current = requireUserConfiguredServer(file, serverName);
      const next: LocalMcpServerConfig = { ...current, enabled };
      await this.writeConfiguredMutation(serverName, {
        ...file,
        mcpServers: { ...file.mcpServers, [serverName]: next },
      });
      const input = configuredInputFromStored(next);
      if (!input) {
        throw new LocalMcpSettingsError(
          400,
          'MCP server configuration is invalid.',
          'MCP_CONFIG_INVALID',
        );
      }
      return configuredSummary(serverName, next, input);
    });
  }

  async testConfiguredServer(name: string): Promise<ConfiguredMcpConnectionTestResult> {
    this.assertOpen();
    const serverName = name;
    const file = await this.readFile(true);
    const config = requireUserConfiguredServer(file, serverName);
    if (config.enabled === false) {
      return {
        success: false,
        errorCode: 'MCP_SERVER_DISABLED',
        errorMessage: 'Enable the MCP server before testing the connection.',
      };
    }
    const pool = this.options.connectionPool;
    if (!pool) {
      return {
        success: false,
        errorCode: 'MCP_CONNECTION_UNAVAILABLE',
        errorMessage: 'MCP connections are unavailable in this runtime.',
      };
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.shutdownSignal.signal]);
    try {
      const timeoutMs =
        config.timeout && config.timeout > 0 ? config.timeout : MCP_DEFAULTS.timeout;
      const tools = await withConfiguredConnectionTimeout(
        (async () => {
          const overrides = await this.resolveConnectionOverrides(serverName, config);
          this.assertOpen();
          signal.throwIfAborted();
          return pool.listTools(serverName, overrides, { signal });
        })(),
        timeoutMs,
        () => controller.abort(),
      );
      return { success: true, toolCount: tools.length };
    } catch (error) {
      return configuredConnectionFailure(error, config);
    }
  }

  async addServer(name: string, config: Record<string, unknown>) {
    this.assertOpen();
    return this.enqueueMutation(async () => {
      const serverName = normalizeServerName(name);
      const file = await this.readFileWithinMutation(true);
      const next = normalizeServerConfig(config);
      const serverConfig: LocalMcpServerConfig = {
        ...file.mcpServers[serverName],
        ...next,
        enabled: next.enabled ?? true,
        configured: next.configured ?? true,
      };
      file.mcpServers[serverName] = serverConfig;
      await this.writeConfiguredMutation(serverName, file);
      const tools = readConfiguredTools(serverConfig);
      return {
        name: serverName,
        transport: inferTransport(serverConfig),
        authStatus: inferAuthStatus(serverConfig),
        skillStatus: tools.length > 0 ? 'active' : 'not_generated',
        enabled: serverConfig.enabled !== false,
        configured: serverConfig.configured !== false,
        builtin: serverConfig.builtin === true,
        description: serverConfig.description,
        tools: {
          count: tools.length,
          items: tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })),
          syncedAt: this.nowMs(),
        },
      };
    });
  }

  async disableServer(name: string): Promise<boolean> {
    this.assertOpen();
    return this.enqueueMutation(async () => {
      const serverName = normalizeServerName(name);
      if (this.isBuiltinMatrixServerName(serverName)) return false;
      const file = await this.readFileWithinMutation(true);
      const current = file.mcpServers[serverName];
      if (!current) return false;
      file.mcpServers[serverName] = {
        ...current,
        enabled: false,
        metadata: {
          ...(current.metadata ?? {}),
          disabledBy: 'user',
        },
      };
      await this.writeConfiguredMutation(serverName, file);
      return true;
    });
  }

  async getServerConfig(
    name: string,
    context?: LocalMcpRuntimeContext,
  ): Promise<LocalMcpServerConfig | undefined> {
    this.assertOpen();
    const file = await this.readEffectiveFile(context);
    return file.mcpServers[normalizeServerName(name)];
  }

  async getAuthStatus() {
    this.assertOpen();
    const file = this.withBuiltinServers(await this.readFile());
    return Object.entries(file.mcpServers).map(([name, config]) => ({
      name,
      status: inferAuthStatus(config),
      authenticated: inferAuthStatus(config) === 'authenticated',
      scopes: readStringArray(config.auth?.['scopes']),
    }));
  }

  async startAuth(server: string) {
    this.assertOpen();
    const config = await this.getServerConfig(server);
    if (!config) {
      return { ok: false, status: 'not_found', error: `MCP server "${server}" not found` };
    }
    return {
      ok: true,
      status: inferAuthStatus(config),
      authUrl: undefined,
      localRuntime: true,
    };
  }

  async sync() {
    this.assertOpen();
    this.syncState = 'SYNCING';
    this.lastSyncError = undefined;
    try {
      const servers = await this.listServers();
      const total = servers.length;
      this.syncState = 'SYNC_DONE';
      return {
        state: this.syncState,
        progress: { total, done: total, failed: 0 },
      };
    } catch (err) {
      this.syncState = 'SYNC_ERROR';
      this.lastSyncError = err instanceof Error ? err.message : String(err);
      return {
        state: this.syncState,
        progress: { total: 0, done: 0, failed: 1 },
        error: this.lastSyncError,
      };
    }
  }

  getSyncStatus() {
    this.assertOpen();
    return {
      state: this.syncState,
      ...(this.lastSyncError ? { error: this.lastSyncError } : {}),
    };
  }

  async listTools(server: string, context?: LocalMcpRuntimeContext): Promise<LocalMcpToolInfo[]> {
    this.assertOpen();
    const config = await this.getServerConfig(server, context);
    return config ? readConfiguredTools(config) : [];
  }

  /**
   * Query the MCP server for its live tool list via the connection pool.
   * Returns the projected `mcp.json` view when no pool is configured or the
   * server has no usable transport.
   */
  async listToolsLive(
    server: string,
    context?: LocalMcpRuntimeContext,
  ): Promise<LocalMcpToolInfo[]> {
    this.assertOpen();
    const config = await this.getServerConfig(server, context);
    if (!config || config.enabled === false) return [];
    const pool = this.options.connectionPool;
    if (!pool) return readConfiguredTools(config);
    if (!configToTransportConfig(config)) return readConfiguredTools(config);
    try {
      const overrides = await this.resolveConnectionOverrides(server, config, context);
      this.assertOpen();
      const tools = await pool.listTools(server, overrides, {
        signal: this.connectionSignal(config),
      });
      this.recordPublicRuntimeSuccess(server, context, config);
      return tools;
    } catch {
      this.recordPublicRuntimeFailure(
        server,
        context,
        'MCP server connection failed. Retry or check its configuration.',
        config,
      );
      return readConfiguredTools(config);
    }
  }

  async listNativeTools(context?: LocalMcpRuntimeContext): Promise<LocalMcpNativeToolInfo[]> {
    this.assertOpen();
    const file = await this.readEffectiveFile(context);
    const invalidNames = this.reserveRuntimeServerNames(file, context);
    const out: LocalMcpNativeToolInfo[] = [];
    for (const [server, config] of Object.entries(file.mcpServers)) {
      if (config.enabled === false || invalidNames.has(server)) continue;
      if (!hasLocalCallAdapter(config)) continue;
      const isBuiltinMatrix = isBuiltinMatrixConfig(server, config);
      const rawTools =
        isBuiltinMatrix && !context
          ? readConfiguredTools(config)
          : await this.listToolsLive(server, context);
      out.push(...this.toNativeToolInfos(server, config, rawTools, context));
    }
    return out;
  }

  async listNativeToolsForTurn(
    context?: LocalMcpRuntimeContext,
  ): Promise<LocalMcpNativeToolInfo[]> {
    this.assertOpen();
    const file = await this.readEffectiveFile(context);
    const invalidNames = this.reserveRuntimeServerNames(file, context);
    const discovered = await Promise.all(
      Object.entries(file.mcpServers).map(async ([server, config]) => {
        if (config.enabled === false || invalidNames.has(server) || !hasLocalCallAdapter(config))
          return [];
        const isBuiltinMatrix = isBuiltinMatrixConfig(server, config);
        const rawTools =
          isBuiltinMatrix && !context
            ? readConfiguredTools(config)
            : await this.listToolsForTurn(server, config, context);
        return this.toNativeToolInfos(server, config, rawTools, context);
      }),
    );
    return discovered.flat();
  }

  runtimeToolsFromNative(
    nativeTools: LocalMcpNativeToolInfo[],
    context?: LocalMcpRuntimeContext,
  ): RuntimeTool[] {
    this.assertOpen();
    return nativeTools.map((tool) => {
      const def = {
        name: tool.nativeName,
        description:
          tool.description ?? `Call MCP tool ${tool.toolName} on local MCP server ${tool.server}.`,
        schema: toTypeSchema(tool.inputSchema),
      };
      return {
        def,
        impl: {
          execute: async (_ctx, input, signal): Promise<ToolResult> => {
            if (signal?.aborted) {
              throw new Error(`MCP tool aborted: ${tool.server}/${tool.toolName}`);
            }
            // Forward the pi turn signal into the pool so abort during a
            // long-running remote MCP call (e.g. built-in matrix generation
            // tools) unblocks the tool immediately instead of waiting for the
            // per-server timeout to fire.
            const result = await this.call(tool.server, tool.toolName, readRecord(input) ?? {}, {
              context,
              signal,
            });
            const mapped = mapMcpContent(result);
            return {
              tool_name: def.name,
              text: mapped.text,
              content: mapped.content,
              ...(result.isError !== undefined ? { isError: result.isError } : {}),
              details: { mcp: result, server: tool.server, tool: tool.toolName },
              output: { mcp: result },
            };
          },
        },
        source: tool.source,
      };
    });
  }

  async listRuntimeTools(context?: LocalMcpRuntimeContext): Promise<RuntimeTool[]> {
    this.assertOpen();
    return this.runtimeToolsFromNative(await this.listNativeTools(context), context);
  }

  private async listToolsForTurn(
    server: string,
    config: LocalMcpServerConfig,
    context?: LocalMcpRuntimeContext,
  ): Promise<LocalMcpToolInfo[]> {
    const pool = this.options.connectionPool;
    const transport = configToTransportConfig(config);
    if (!pool || !transport) return [];
    const turnDiscoveryTimeoutMs = this.options.turnDiscoveryTimeoutMs ?? 2_000;
    const discoveryTimeoutMs =
      transport.type === 'stdio'
        ? (this.options.turnStdioDiscoveryTimeoutMs ??
          this.options.turnDiscoveryTimeoutMs ??
          30_000)
        : turnDiscoveryTimeoutMs;
    const timeoutMs = Math.min(configuredTimeout(config), discoveryTimeoutMs);
    const controller = new AbortController();
    try {
      const tools = await withConfiguredConnectionTimeout(
        (async () => {
          const overrides = await this.resolveConnectionOverrides(server, config, context);
          this.assertOpen();
          return pool.listTools(server, overrides, {
            signal: this.connectionSignal(config, controller.signal),
            timeout: timeoutMs,
          });
        })(),
        timeoutMs,
        () => controller.abort(),
      );
      this.recordPublicRuntimeSuccess(server, context, config);
      return tools;
    } catch (error) {
      this.recordPublicRuntimeFailure(
        server,
        context,
        error instanceof ConfiguredMcpConnectionTimeoutError
          ? 'MCP server connection timed out. Retry or check its configuration.'
          : 'MCP server connection failed. Retry or check its configuration.',
        config,
      );
      return [];
    }
  }

  private toNativeToolInfos(
    server: string,
    config: LocalMcpServerConfig,
    rawTools: LocalMcpToolInfo[],
    context?: LocalMcpRuntimeContext,
  ): LocalMcpNativeToolInfo[] {
    return projectNativeTools({
      server,
      config,
      rawTools,
      registry: this.getRuntimeNameRegistry(),
      matrixWebSearchOnly: this.isBuiltinMatrixWebSearchOnly(),
      onError: (error) => this.recordPublicRuntimeFailure(server, context, error, config),
    });
  }

  private reserveRuntimeServerNames(
    file: LocalMcpFile,
    context?: LocalMcpRuntimeContext,
  ): ReadonlySet<string> {
    return reserveConfiguredServerNames(
      this.getRuntimeNameRegistry(),
      file.mcpServers,
      (server, error) =>
        this.recordPublicRuntimeFailure(server, context, error, file.mcpServers[server]),
    );
  }

  async call(
    server: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { context?: LocalMcpRuntimeContext; signal?: AbortSignal } = {},
  ): Promise<LocalMcpCallResult> {
    const { context, signal } = options;
    this.assertOpen();
    const config = await this.getServerConfig(server, context);
    if (!config || config.enabled === false) {
      return {
        isError: true,
        content: [{ type: 'text', text: `MCP server "${server}" is not enabled.` }],
      };
    }
    const configuredTool = readConfiguredTools(config).find((item) => item.name === toolName);
    const tool =
      configuredTool ??
      (await this.listToolsLive(server, context)).find((item) => item.name === toolName);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `MCP tool "${toolName}" not found on "${server}".` }],
      };
    }
    const mockResponses = readRecord(config.metadata?.['mockResponses']);
    const key = toolName;
    const mocked = readRecord(mockResponses?.[key]);
    if (mocked) return normalizeCallResult(mocked);

    return this.callLive(server, config, { toolName, args, context, signal });
  }

  private async callLive(
    server: string,
    config: LocalMcpServerConfig,
    input: {
      toolName: string;
      args: Record<string, unknown>;
      context?: LocalMcpRuntimeContext;
      signal?: AbortSignal;
    },
  ): Promise<LocalMcpCallResult> {
    const { toolName, args, context, signal } = input;
    // Live path: route through the injected connection pool when configured.
    const pool = this.options.connectionPool;
    if (pool) {
      const transport = configToTransportConfig(config);
      if (!transport) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `MCP server "${server}" has no usable transport (need command for stdio or url for ` +
                'http/sse).',
            },
          ],
        };
      }
      try {
        const overrides = await this.resolveConnectionOverrides(server, config, context);
        this.assertOpen();
        const result = await pool.callTool(server, toolName, args, overrides, {
          ...(config.timeout && config.timeout > 0 ? { timeout: config.timeout } : {}),
          signal: this.connectionSignal(config, signal),
        });
        this.recordPublicRuntimeSuccess(server, context, config);
        return result;
      } catch (err) {
        this.recordPublicRuntimeFailure(
          server,
          context,
          'MCP server connection failed. Retry or check its configuration.',
          config,
        );
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    }

    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `Local MCP server "${server}" is registered natively, but no local connection ` +
            'adapter is configured for this minimal clean-runtime MCP call path.',
        },
      ],
    };
  }

  /**
   * `McpServerLookup` view onto this service for the connection pool.
   * Returns null for unknown / unparseable / disabled servers so the pool
   * fails closed.
   */
  getServerLookup(): McpServerLookup {
    this.assertOpen();
    return {
      getResolvedServer: (serverName: string): ResolvedMcpServer | null => {
        const file = this.withBuiltinServers(this.readFileSyncSafe());
        const normalizedServerName = normalizeServerName(serverName);
        const config = file.mcpServers[normalizedServerName];
        if (!config || config.enabled === false) return null;
        const transport = configToTransportConfig(config);
        if (!transport) return null;
        return {
          name: normalizedServerName,
          transport,
          enabled: true,
          ...(config.timeout && config.timeout > 0 ? { timeout: config.timeout } : {}),
        };
      },
    };
  }

  private readFileSyncSafe(): LocalMcpFile {
    // The pool's `getResolvedServer` is invoked synchronously from connect
    // path; we cache nothing here yet, so do a cheap re-read using the same
    // async helper but capture in a holder. To avoid blocking, we accept that
    // the pool will call us at connect-time (already an async path), so this
    // is fine to be sync-style by returning the cached parse from the most
    // recent async readFile call.
    return this.lastReadFile ?? { mcpServers: {} };
  }

  private withBuiltinServers(file: LocalMcpFile, context?: LocalMcpRuntimeContext): LocalMcpFile {
    if (!this.isBuiltinMatrixEnabled()) return file;
    const matrix = buildBuiltinMatrixServerConfig(
      { ...(context ?? {}), dataDir: this.dataDir() },
      { webSearchOnly: this.isBuiltinMatrixWebSearchOnly() },
    );
    return {
      ...file,
      mcpServers: {
        ...file.mcpServers,
        [BUILTIN_MATRIX_SERVER_NAME]: matrix,
      },
    };
  }

  private isBuiltinMatrixEnabled(): boolean {
    return this.options.builtinMatrix?.enabled === true && !!this.options.connectionPool;
  }

  private isBuiltinMatrixWebSearchOnly(): boolean {
    return this.isBuiltinMatrixEnabled() && this.options.builtinMatrix?.webSearchOnly === true;
  }

  private isBuiltinMatrixServerName(serverName: string): boolean {
    return (
      this.isBuiltinMatrixEnabled() &&
      normalizeServerName(serverName) === BUILTIN_MATRIX_SERVER_NAME
    );
  }

  private async resolveConnectionOverrides(
    server: string,
    config: LocalMcpServerConfig,
    context?: LocalMcpRuntimeContext,
  ): Promise<McpConnectionTokenOverrides | undefined> {
    if (context?.sessionId && this.isSessionServer(server, context)) {
      return this.sessionServers.overrides(context.sessionId, server, config);
    }
    const project = this.projectMcp.overrides(config);
    if (project) return project;
    const base =
      context === undefined
        ? await this.options.resolveTokenOverrides?.(server, config)
        : await this.options.resolveTokenOverrides?.(server, config, context);
    if (!isBuiltinMatrixConfig(server, config)) return base ?? undefined;
    return matrixTokenOverrides(this.dataDir(), base, context);
  }

  private connectionSignal(config: LocalMcpServerConfig, signal?: AbortSignal): AbortSignal {
    const project = this.projectMcp.signal(config);
    return AbortSignal.any([
      this.shutdownSignal.signal,
      ...(signal ? [signal] : []),
      ...(project ? [project] : []),
    ]);
  }

  private unavailableReason(config: LocalMcpServerConfig): string | undefined {
    const hasMockAdapter = Boolean(readRecord(config.metadata?.['mockResponses']));
    if (!configToTransportConfig(config) && !hasMockAdapter) {
      return 'MCP server transport is incomplete. Configure a command or URL and retry.';
    }
    if (!this.options.connectionPool && !hasMockAdapter) {
      return 'MCP connection support is unavailable in this Runtime.';
    }

    return undefined;
  }
  private nowMs(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  private async readEffectiveFile(context?: LocalMcpRuntimeContext): Promise<LocalMcpFile> {
    const base = this.withBuiltinServers(await this.readFile(), context);
    const project = await this.enqueueMutation(() => this.projectMcp.resolve(context));
    const session = context?.sessionId ? this.sessionServers.get(context.sessionId) : undefined;
    return { mcpServers: { ...base.mcpServers, ...project, ...session } };
  }

  private filePath(): string {
    return join(this.dataDir(), 'mcp.json');
  }

  private async readRawDocument(): Promise<LocalMcpRawDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath(), 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { document: {}, servers: {} };
      }
      const document = parsed as Record<string, unknown>;
      const rawServers = readRecord(document['mcpServers']) ?? {};
      return { document, servers: rawServers };
    } catch {
      return { document: {}, servers: {} };
    }
  }

  private normalizeRawServers(servers: Readonly<Record<string, unknown>>): LocalMcpFile {
    const normalized: Record<string, LocalMcpServerConfig> = {};
    for (const [name, rawConfig] of Object.entries(servers)) {
      const rawConfigObject = readRecord(rawConfig);
      if (!rawConfigObject) continue;
      const serverName = normalizeServerName(name);
      const config = normalizeServerConfig(rawConfigObject);
      if (
        !isRetiredLegacyMatrixMcpServerConfig(serverName, config) &&
        !(isBuiltinMatrixConfig(serverName, config) && !this.isBuiltinMatrixEnabled()) &&
        !isRetiredLegacyCuMcpServerConfig(serverName, config) &&
        !(serverName === 'nd' && config.builtin === true)
      ) {
        normalized[serverName] = config;
      }
    }
    return { mcpServers: normalized };
  }

  private readFile(failClosed = false): Promise<LocalMcpFile> {
    // Reads can persist retired-server cleanup, so read the latest document inside
    // the same queue as explicit writes. Mutations use the inner method to avoid re-entry.
    return this.enqueueMutation(() => this.readFileWithinMutation(failClosed));
  }

  private async readFileWithinMutation(failClosed = false): Promise<LocalMcpFile> {
    const pending = readLocalMcpFile(this.filePath(), failClosed);
    this.pendingReads.add(pending);
    try {
      const file = await pending;
      this.lastReadFile = this.isBuiltinMatrixEnabled()
        ? file
        : {
            ...file,
            mcpServers: Object.fromEntries(
              Object.entries(file.mcpServers).filter(
                ([name, config]) => !isBuiltinMatrixConfig(name, config),
              ),
            ),
          };
      return this.lastReadFile;
    } catch (error) {
      this.lastReadFile = { mcpServers: {} };
      throw error;
    } finally {
      this.pendingReads.delete(pending);
    }
  }
  private async writeFile(file: LocalMcpFile): Promise<void> {
    await writeLocalMcpFile(this.filePath(), file);
    this.lastReadFile = file;
  }

  private async writeRawDocument(document: Record<string, unknown>): Promise<void> {
    const filePath = this.filePath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  }

  private async writeConfiguredMutation(serverName: string, file: LocalMcpFile): Promise<void> {
    await this.options.connectionPool?.disconnect(serverName);
    await this.writeFile(file);
    await this.options.connectionPool?.disconnect(serverName);
    this.resetPublicRuntimeStatus(serverName);
    this.notifyServerChangeListeners();
  }

  private recordPublicRuntimeSuccess(
    serverName: string,
    context?: LocalMcpRuntimeContext,
    config?: LocalMcpServerConfig,
  ): void {
    if (this.isSessionServer(serverName, context)) return;
    if (this.projectMcp.record(config)) return;
    const normalized = normalizeServerName(serverName);
    this.publicRuntimeErrors.delete(normalized);
    this.publiclyAvailableServers.add(normalized);
  }

  private recordPublicRuntimeFailure(
    serverName: string,
    context: LocalMcpRuntimeContext | undefined,
    error: string,
    config?: LocalMcpServerConfig,
  ): void {
    if (this.isSessionServer(serverName, context)) return;
    if (this.projectMcp.record(config, error)) return;
    const normalized = normalizeServerName(serverName);
    this.publiclyAvailableServers.delete(normalized);
    this.publicRuntimeErrors.set(normalized, error);
  }

  private isSessionServer(serverName: string, context?: LocalMcpRuntimeContext): boolean {
    return Boolean(
      context?.sessionId &&
      this.sessionServers.get(context.sessionId)?.[normalizeServerName(serverName)],
    );
  }

  private resetPublicRuntimeStatus(serverName: string): void {
    const normalized = normalizeServerName(serverName);
    this.publicRuntimeErrors.delete(normalized);
    this.publiclyAvailableServers.delete(normalized);
  }

  private notifyServerChangeListeners(): void {
    for (const listener of this.serverChangeListeners) listener();
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    const result = (async () => {
      await previous;
      return operation();
    })();
    this.mutationQueue = (async () => {
      try {
        await result;
      } catch {
        /* Keep admission queue usable after failure. */
      }
    })();
    return result;
  }
}

function configuredTimeout(config: LocalMcpServerConfig): number {
  return config.timeout && config.timeout > 0 ? config.timeout : MCP_DEFAULTS.timeout;
}
function matrixTokenOverrides(
  dataDir: string,
  base: McpConnectionTokenOverrides | undefined,
  context?: LocalMcpRuntimeContext,
): McpConnectionTokenOverrides {
  const matrixOverrides = buildBuiltinMatrixTokenOverrides({
    ...(context ?? {}),
    dataDir,
  });
  return {
    ...(base ?? {}),
    connectionKey: matrixOverrides.connectionKey,
    env: {
      ...(base?.env ?? {}),
      ...matrixOverrides.env,
    },
    ...(base?.headers ? { headers: base.headers } : {}),
  };
}
