import type { McpConnectionPool } from '@mavis/mcp/runtime/connection-pool';
import type { McpConnectionTokenOverrides } from '@mavis/mcp/runtime/types';
import type {
  LocalMcpRuntimeContext,
  LocalMcpServerConfig,
  ProjectMcpPreview,
} from './contracts.js';
import { configToTransportConfig } from './runtime/config.js';
import {
  readProjectMcpConfig,
  projectMcpDigest,
  isReservedProjectMcpName,
  type ProjectMcpDocument,
} from './project-config.js';

interface ProjectSnapshot {
  document: ProjectMcpDocument;
  sessionId: string;
  /** Caller-visible workspace spelling; `document.root` is its realpath. */
  workspaceRoot: string;
  servers: Record<string, LocalMcpServerConfig>;
  keys: Map<string, string>;
  statuses: Map<string, { status: 'available' | 'error'; error?: string }>;
  active: boolean;
  abort: AbortController;
}

/** Where a project server comes from; OAuth namespaces it by the workspace realpath. */
export interface ProjectMcpAuthSource {
  serverName: string;
  sessionId: string;
  workspaceRoot: string;
  realRoot: string;
  configPath: string;
}

/** Caller serializes resolve/clear with the MCP owner's mutation queue. */
export class ProjectMcpRuntime {
  private readonly snapshots = new Map<string, ProjectSnapshot>();
  private readonly bindings = new WeakMap<
    LocalMcpServerConfig,
    { snapshot: ProjectSnapshot; name: string }
  >();

  constructor(private readonly pool?: McpConnectionPool) {}

  async resolve(context?: LocalMcpRuntimeContext): Promise<Record<string, LocalMcpServerConfig>> {
    if (!context?.workspaceRoot || !context.sessionId) return {};
    const document = await readProjectMcpConfig(context.workspaceRoot);
    const current = this.snapshots.get(context.sessionId);
    if (current?.document.root === document.root && current.document.digest === document.digest) {
      return current.servers;
    }
    await this.clearSnapshot(context.sessionId);
    const snapshot: ProjectSnapshot = {
      document,
      sessionId: context.sessionId,
      workspaceRoot: context.workspaceRoot,
      servers: Object.create(null),
      keys: new Map(),
      statuses: new Map(),
      active: true,
      abort: new AbortController(),
    };
    for (const entry of document.entries) {
      if (isReservedProjectMcpName(entry.name)) continue;
      const config = {
        ...entry.config,
        enabled: entry.config?.enabled !== false && !entry.error,
        builtin: false,
        configured: true,
      };
      snapshot.servers[entry.name] = config;
      snapshot.keys.set(
        entry.name,
        `project:${projectMcpDigest(JSON.stringify([context.sessionId, document.root, document.digest, entry.name]))}`,
      );
      this.bindings.set(config, { snapshot, name: entry.name });
    }
    this.snapshots.set(context.sessionId, snapshot);
    return snapshot.servers;
  }

  async inspect(context: LocalMcpRuntimeContext): Promise<ProjectMcpPreview> {
    await this.resolve(context);
    const snapshot = context.sessionId ? this.snapshots.get(context.sessionId) : undefined;
    if (!snapshot) throw new Error('Project MCP inspection requires a session and workspace.');
    return {
      path: snapshot.document.path,
      digest: snapshot.document.digest,
      ...(snapshot.document.error ? { error: snapshot.document.error } : {}),
      servers: snapshot.document.entries.map((entry) => {
        const config = entry.config;
        const status = projectStatus(snapshot, entry);
        return {
          name: entry.name,
          transport: config?.type ?? 'none',
          status: status.status,
          ...(status.error ? { error: status.error } : {}),
          // Values in args/env/headers/URL queries are never exposed by inspection.
          target: config?.command ?? remoteTarget(config?.url),
        };
      }),
    };
  }

  overrides(config: LocalMcpServerConfig): McpConnectionTokenOverrides | undefined {
    const binding = this.bindings.get(config);
    if (!binding) return undefined;
    const { snapshot, name } = binding;
    if (!snapshot.active || !config.enabled)
      throw new Error('Project MCP configuration is no longer active.');
    const transport = configToTransportConfig(config);
    if (!transport) throw new Error('Invalid project MCP transport.');
    return {
      connectionKey: snapshot.keys.get(name),
      serverOverride: {
        name,
        enabled: true,
        transport:
          transport.type === 'stdio'
            ? { ...transport, cwd: snapshot.document.root }
            : { ...transport, protectHeadersOnRedirect: true },
        workspaceRoot: snapshot.document.root,
        ...(config.timeout ? { timeout: config.timeout } : {}),
      },
    };
  }

  authSource(config: LocalMcpServerConfig): ProjectMcpAuthSource | undefined {
    const binding = this.bindings.get(config);
    if (!binding) return undefined;
    const { snapshot, name } = binding;
    return {
      serverName: name,
      sessionId: snapshot.sessionId,
      workspaceRoot: snapshot.workspaceRoot,
      realRoot: snapshot.document.root,
      configPath: snapshot.document.path,
    };
  }

  signal(config: LocalMcpServerConfig): AbortSignal | undefined {
    return this.bindings.get(config)?.snapshot.abort.signal;
  }

  record(config: LocalMcpServerConfig | undefined, error?: string): boolean {
    const binding = config ? this.bindings.get(config) : undefined;
    if (!binding) return false;
    if (binding.snapshot.active)
      binding.snapshot.statuses.set(
        binding.name,
        error ? { status: 'error', error } : { status: 'available' },
      );
    return true;
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.clearSnapshot(sessionId);
  }

  private async clearSnapshot(sessionId: string): Promise<void> {
    const current = this.snapshots.get(sessionId);
    if (!current) return;
    current.active = false;
    current.abort.abort();
    this.snapshots.delete(sessionId);
    const pool = this.pool;
    if (!pool) return;
    await Promise.allSettled(
      [...current.keys].map(([name, connectionKey]) => pool.disconnect(name, { connectionKey })),
    );
  }
}

function remoteTarget(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function projectStatus(
  snapshot: ProjectSnapshot,
  entry: ProjectMcpDocument['entries'][number],
): { status: ProjectMcpPreview['servers'][number]['status']; error?: string } {
  if (entry.error) return { status: 'error', error: entry.error };
  if (entry.config?.enabled === false) return { status: 'disabled' };
  return snapshot.statuses.get(entry.name) ?? { status: 'configured' };
}
