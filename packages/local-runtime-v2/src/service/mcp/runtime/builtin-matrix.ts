import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildMatrixMcpToolDescriptors,
  createMatrixMcpRuntime,
  getDesktopMatrixEndpoint,
} from '@mavis/agent-tools/desktop';
import { getRuntimeRegion } from '@mavis/config';

import type { McpConnectionTokenOverrides } from '@mavis/mcp/runtime/types';
import type {
  LocalMcpRuntimeContext,
  LocalMcpServerConfig,
  LocalMcpToolInfo,
} from '../contracts.js';
import { resolveV2DirectoryContract } from '@mavis/shared/local-runtime-paths';
import { getRawRuntimeBuildEnv } from './routing-context.js';

export const BUILTIN_MATRIX_SERVER_NAME = 'matrix';
const BUILTIN_MATRIX_MCP_VERSION = 2;
const LEGACY_MATRIX_MCP_VERSION = 1;
// web_search is the only Matrix tool that mcode-tools does NOT provide, so when
// mcode-tools owns the media/generation Matrix tools the built-in Matrix MCP is
// narrowed to expose exactly this one tool (see `webSearchOnly`).
export const BUILTIN_MATRIX_WEB_SEARCH_TOOL_NAME = 'web_search';

const BUILTIN_MATRIX_TIMEOUT_MS = 1_500_000;
// Same stdio child, two layouts: packaged mcode resolves next to package/cli.js,
// workspace/dev resolves from local-runtime-v2/dist/service/mcp/runtime/builtin-matrix.js.
const MATRIX_MCP_STDIO_BUNDLED_RELATIVE_PATH = 'matrix-mcp-stdio.js';
const MATRIX_MCP_STDIO_WORKSPACE_RELATIVE_PATH =
  '../../../../../agent-tools/dist/desktop/matrix-mcp-stdio.js';
let builtinMatrixToolsCache: LocalMcpToolInfo[] | undefined;

export function buildBuiltinMatrixServerConfig(
  context?: LocalMcpRuntimeContext,
  options?: { webSearchOnly?: boolean },
): LocalMcpServerConfig {
  const workspaceRoot = resolveMatrixWorkspaceRoot(context);
  const runtimeEnv = buildBuiltinMatrixRuntimeEnv();
  const entrypoint = resolveMatrixMcpStdioEntrypoint();
  if (!entrypoint) {
    throw new Error('Built-in Matrix MCP stdio entrypoint is unavailable.');
  }
  return {
    type: 'stdio',
    command: process.execPath,
    args: [entrypoint],
    env: {
      ...runtimeEnv,
      MAVIS_MATRIX_WORKSPACE_ROOT: workspaceRoot,
      ...(context?.routingContext?.bedrockLane
        ? { MAVIS_MATRIX_BEDROCK_LANE: context.routingContext.bedrockLane }
        : {}),
      ...resolveMatrixExtraInputRootsEnv(context),
    },
    builtin: true,
    configured: true,
    enabled: true,
    timeout: BUILTIN_MATRIX_TIMEOUT_MS,
    description:
      'Built-in Matrix MCP server for local desktop runtime. Exposes Matrix tools through MCP ' +
      'with canonical tool names.',
    metadata: {
      mavisBuiltinMcpServer: BUILTIN_MATRIX_SERVER_NAME,
      mavisBuiltinMcpVersion: BUILTIN_MATRIX_MCP_VERSION,
      managedBy: 'local-runtime',
    },
    tools: getBuiltinMatrixTools(workspaceRoot, runtimeEnv, options?.webSearchOnly === true),
  };
}

export function listBuiltinMatrixMcpToolDescriptors(
  context?: LocalMcpRuntimeContext,
): LocalMcpToolInfo[] {
  const workspaceRoot = resolveMatrixWorkspaceRoot(context);
  return getBuiltinMatrixTools(workspaceRoot, buildBuiltinMatrixRuntimeEnv());
}

export function isBuiltinMatrixConfig(server: string, config: LocalMcpServerConfig): boolean {
  return (
    server === BUILTIN_MATRIX_SERVER_NAME &&
    config.builtin === true &&
    config.metadata?.['mavisBuiltinMcpServer'] === BUILTIN_MATRIX_SERVER_NAME &&
    config.metadata?.['mavisBuiltinMcpVersion'] === BUILTIN_MATRIX_MCP_VERSION
  );
}

export function isRetiredLegacyMatrixMcpServerConfig(
  server: string,
  config: LocalMcpServerConfig,
): boolean {
  if (server !== BUILTIN_MATRIX_SERVER_NAME) return false;
  return (
    config.metadata?.['mavisBuiltinMcpServer'] === BUILTIN_MATRIX_SERVER_NAME &&
    config.metadata?.['mavisBuiltinMcpVersion'] === LEGACY_MATRIX_MCP_VERSION
  );
}

/** @public exercised directly by the colocated unit suite. */
export function buildBuiltinMatrixTokenOverrides(
  context?: LocalMcpRuntimeContext,
): McpConnectionTokenOverrides {
  const workspaceRoot = resolveMatrixWorkspaceRoot(context);
  const auth = context?.authContext;
  const accessToken = auth?.accessToken?.trim() ?? '';
  const authIdentity = accessToken || auth?.realUserID || auth?.userEmail || auth?.userName || '';
  // The lane is part of the stdio child's routing environment. Include it in
  // the pool key so a hot lane change cannot reuse a child seeded for the
  // previous lane (an empty lane is intentionally a distinct identity too).
  const routingLane = context?.routingContext?.bedrockLane?.trim() ?? '';
  return {
    connectionKey:
      `matrix:workspace-${shortStableHash(workspaceRoot)}:` +
      `auth-${shortStableHash(authIdentity)}:` +
      `lane-${shortStableHash(routingLane)}`,
    env: {
      ...buildBuiltinMatrixRuntimeEnv(),
      MAVIS_MATRIX_WORKSPACE_ROOT: workspaceRoot,
      ...(context?.routingContext?.bedrockLane
        ? { MAVIS_MATRIX_BEDROCK_LANE: context.routingContext.bedrockLane }
        : {}),
      ...resolveMatrixExtraInputRootsEnv(context),
      MAVIS_MATRIX_ACCESS_TOKEN: accessToken,
      MATRIX_ACCESS_TOKEN: accessToken,
    },
  };
}

export function resolveMatrixMcpStdioEntrypoint(baseUrl = import.meta.url): string | undefined {
  const override = process.env.MAVIS_MATRIX_MCP_STDIO_ENTRYPOINT?.trim();
  if (override) return safeExistsSync(override) ? override : undefined;

  for (const candidate of [
    new URL(MATRIX_MCP_STDIO_BUNDLED_RELATIVE_PATH, baseUrl),
    new URL(MATRIX_MCP_STDIO_WORKSPACE_RELATIVE_PATH, baseUrl),
  ]) {
    try {
      const entrypoint = fileURLToPath(candidate);
      if (safeExistsSync(entrypoint)) return entrypoint;
    } catch {
      continue;
    }
  }

  return undefined;
}

function safeExistsSync(file: string): boolean {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

// Security invariant: expose exactly the dataDir assets subtree as an extra
// *input* root — never the dataDir root (auth token lives there). No dataDir
// means no extra root (fail-closed, fence stays workspace-only).
function resolveMatrixExtraInputRootsEnv(context?: LocalMcpRuntimeContext): Record<string, string> {
  const dataDir = context?.dataDir?.trim();
  if (!dataDir) return {};
  return { MAVIS_MATRIX_EXTRA_INPUT_ROOTS: resolveV2DirectoryContract(dataDir).assets };
}

function resolveMatrixWorkspaceRoot(context?: LocalMcpRuntimeContext): string {
  return (
    context?.workspaceRoot?.trim() ||
    process.env.MAVIS_MATRIX_WORKSPACE_ROOT?.trim() ||
    process.env.WORKSPACE_ROOT?.trim() ||
    process.cwd()
  );
}

function shortStableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function buildBuiltinMatrixRuntimeEnv(): Record<string, string> {
  const buildEnv = getRawRuntimeBuildEnv();
  return {
    ELECTRON_RUN_AS_NODE: '1',
    MAVIS_REGION: getRuntimeRegion(),
    ...(buildEnv ? { MAVIS_BUILD_ENV: buildEnv } : {}),
  };
}

function getBuiltinMatrixTools(
  workspaceRoot: string,
  runtimeEnv: Record<string, string>,
  webSearchOnly = false,
): LocalMcpToolInfo[] {
  if (!builtinMatrixToolsCache) {
    const endpoint = getDesktopMatrixEndpoint({ ...readProcessStringEnv(), ...runtimeEnv });
    builtinMatrixToolsCache = buildMatrixMcpToolDescriptors(
      createMatrixMcpRuntime({
        workspaceRoot,
        baseUrl: endpoint.baseUrl,
        ...(endpoint.explicitToken ? { accessToken: endpoint.explicitToken } : {}),
      }),
    ).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }
  // mcode-tools provides every Matrix media/generation tool except web_search,
  // so in web-search-only mode the built-in Matrix MCP is narrowed to that one
  // tool while the stdio child (web_search backend) stays alive.
  if (webSearchOnly) {
    return builtinMatrixToolsCache.filter(
      (tool) => tool.name === BUILTIN_MATRIX_WEB_SEARCH_TOOL_NAME,
    );
  }
  return builtinMatrixToolsCache;
}

function readProcessStringEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/** Matrix stdio identity layered over host-provided overrides. */
export function matrixTokenOverrides(
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
