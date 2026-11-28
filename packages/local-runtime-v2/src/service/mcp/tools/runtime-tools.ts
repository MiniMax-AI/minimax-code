import type { RuntimeTool } from '@mavis/agent-core/tools';
import type { McpToolEntry } from '@mavis/agent-tools';
import type {
  LocalMcpNativeToolInfo,
  LocalMcpRuntimeContext,
  LocalMcpAuthContext as LocalRuntimeAuthContext,
} from '../contracts.js';

import type { ManagedBackendRoutingContext as LocalRuntimeRoutingContext } from '@mavis/agent-tools/desktop';

/**
 * Lists turn-scoped MCP runtime tools paired with each server's provenance
 * (`builtin-matrix` / `builtin` / `configured`). The MCP progressive-disclosure
 * planner uses `source` to decide which tools are eligible to defer (only
 * `configured` tools are deferred).
 *
 * Runtime tools are zipped to their source by matching
 * `tool.def.name === nativeName` (both produced by `LocalMcpService` for the
 * same context); unknown names default to `'configured'` (conservative — they
 * become defer candidates but remain reachable via `mcp_invoke`). Emits a
 * `mcp.tools_injected` diagnostic event for observability.
 */
export async function listMcpRuntimeToolEntriesForTurn(input: {
  sessionId: string;
  workspaceRoot: string;
  turnId?: string;
  authContext?: LocalRuntimeAuthContext;
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
  mcpService: {
    listNativeToolsForTurn(context: LocalMcpRuntimeContext): Promise<LocalMcpNativeToolInfo[]>;
    runtimeToolsFromNative(
      native: LocalMcpNativeToolInfo[],
      context?: LocalMcpRuntimeContext,
    ): RuntimeTool[];
  };
  emitBusEvent(type: string, payload: Record<string, unknown>): void;
}): Promise<McpToolEntry[]> {
  try {
    const ctx: LocalMcpRuntimeContext = {
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.authContext ? { authContext: input.authContext } : {}),
      ...(input.routingContextGetter ? { routingContext: input.routingContextGetter() } : {}),
    };
    const native = await input.mcpService.listNativeToolsForTurn(ctx);
    const tools = input.mcpService.runtimeToolsFromNative(native, ctx);
    const nativeByName = new Map(native.map((entry) => [entry.nativeName, entry]));
    const entries: McpToolEntry[] = tools.map((tool) => ({
      tool: {
        ...tool,
        source: tool.source ?? nativeByName.get(tool.def.name)?.source ?? 'configured',
      },
      source: tool.source ?? nativeByName.get(tool.def.name)?.source ?? 'configured',
      ...(nativeByName.get(tool.def.name)?.server
        ? { serverName: nativeByName.get(tool.def.name)!.server }
        : {}),
    }));
    input.emitBusEvent('mcp.tools_injected', {
      sessionId: input.sessionId,
      count: entries.length,
      toolNames: entries.map((e) => e.tool.def.name),
    });
    return entries;
  } catch (err) {
    input.emitBusEvent('mcp.tools_injection_failed', {
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
