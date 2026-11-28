import { mcpAuthNeedsAttention, sameMcpAuthTarget } from '../../../application/mcp-auth.js';
import type { TuiMcpAuthStateView, TuiMcpServer } from '../../../runtime/port.js';
import { tuiErrorDiagnostic } from '../../../user-facing-failure.js';
import { readTuiMcpPublicStatus } from '../inspection/product-inspection.js';

export type McpCatalogStatus = 'available' | 'configured' | 'disabled' | 'unavailable' | 'error';

export interface McpCatalogEntry {
  readonly status: McpCatalogStatus;
  readonly transport: string;
  readonly builtin: boolean;
  readonly managed: boolean;
  readonly tools: ReadonlyArray<{ name: string; description?: string }>;
  readonly description?: string;
  readonly error?: string;
}

export type McpServerSection = 'user' | 'project' | 'plugin' | 'builtin' | 'session';

export const MCP_SERVER_SECTIONS: ReadonlyArray<{
  readonly section: McpServerSection;
  readonly title: string;
}> = [
  { section: 'user', title: 'User-configured' },
  { section: 'project', title: 'Project · .mcp.json' },
  // Only local (custom) Plugins use OAuth; the Runtime lists no official Plugin servers here.
  { section: 'plugin', title: 'Local Plugins' },
  { section: 'builtin', title: 'Built-in' },
  { section: 'session', title: 'Client session' },
];

/** One `/mcp` row: a catalog server, its OAuth state, or both when they describe the same server. */
export interface McpServerRow {
  readonly section: McpServerSection;
  readonly name: string;
  readonly catalog?: McpCatalogEntry;
  readonly auth?: TuiMcpAuthStateView;
}

export function buildMcpServerRows(
  servers: readonly TuiMcpServer[],
  authStates: readonly TuiMcpAuthStateView[],
  filter: string,
): McpServerRow[] {
  const unmatched = [...authStates];
  const takeAuth = (kind: 'user' | 'project', name: string) => {
    const index = unmatched.findIndex((state) =>
      sameMcpAuthTarget(state.target, { kind, serverName: name }),
    );
    return index < 0 ? undefined : unmatched.splice(index, 1)[0];
  };
  const rows: McpServerRow[] = servers.map((server) => {
    const section = catalogSection(server);
    const auth =
      section === 'user' || section === 'project' ? takeAuth(section, server.name) : undefined;
    return {
      section,
      name: server.name,
      catalog: inspectMcpServer(server),
      ...(auth ? { auth } : {}),
    };
  });
  // The catalog is filtered by the Runtime; OAuth states are filtered here the same way.
  const keyword = filter.trim().toLocaleLowerCase();
  for (const auth of unmatched) {
    const target = auth.target;
    const haystack =
      target.kind === 'plugin'
        ? `${target.serverName} ${target.pluginName} ${target.pluginMarketplace}`
        : target.serverName;
    if (keyword && !haystack.toLocaleLowerCase().includes(keyword)) continue;
    rows.push({ section: target.kind, name: target.serverName, auth });
  }
  return rows.sort(compareRows);
}

function catalogSection(server: TuiMcpServer): McpServerSection {
  if (server.sourceKind === 'builtin') return 'builtin';
  if (server.sourceScope === 'project') return 'project';
  return server.sourceScope === 'session' ? 'session' : 'user';
}

function inspectMcpServer(server: TuiMcpServer): McpCatalogEntry {
  const publicStatus = readTuiMcpPublicStatus(server.configJson);
  const error = server.error ?? publicStatus.error;
  return {
    status: server.status ?? publicStatus.status ?? (!server.enabled ? 'disabled' : 'configured'),
    transport: server.transport ?? 'unknown transport',
    builtin: server.sourceKind === 'builtin',
    managed: server.managed === true,
    tools: server.tools ?? [],
    ...(server.description ? { description: server.description } : {}),
    ...(error ? { error: tuiErrorDiagnostic(error) } : {}),
  };
}

function compareRows(left: McpServerRow, right: McpServerRow): number {
  return (
    rowPriority(left) - rowPriority(right) ||
    left.name.localeCompare(right.name) ||
    pluginLabel(left).localeCompare(pluginLabel(right))
  );
}

/** Servers that need the user's action first, then by catalog health. */
function rowPriority(row: McpServerRow): number {
  if (row.auth && (mcpAuthNeedsAttention(row.auth.authState) || row.auth.authState === 'failed')) {
    return 0;
  }
  const status = row.catalog?.status;
  if (status === 'error') return 1;
  if (status === 'unavailable') return 2;
  if (status === 'configured' || !status) return 3;
  if (status === 'available') return 4;
  return 5;
}

export function pluginLabel(row: McpServerRow): string {
  const target = row.auth?.target;
  return target?.kind === 'plugin' ? `${target.pluginName}@${target.pluginMarketplace}` : '';
}
