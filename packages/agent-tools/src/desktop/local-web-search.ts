import {
  bindTool,
  type ToolImpl,
  type ToolResult,
  withProgrammaticResult,
} from '@mavis/agent-core/tools';

import { WebSearchToolDef, type WebSearchInput } from '../shared/web-search.js';
import type { LocalRuntimeToolContext, LocalWebSearchAdapter } from './types.js';
import { withDesktopCompletenessReport } from './ptc-result-projection.js';

const LEGACY_MATRIX_SERVER_NAME = 'matrix';

@bindTool(WebSearchToolDef)
export class LocalWebSearchTool implements ToolImpl<
  typeof WebSearchToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalWebSearchAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: WebSearchInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    try {
      if (signal?.aborted) throw new Error('Operation aborted');
      return wrapLegacyMatrixMcpResult(await this.adapter.search(ctx, input, signal));
    } catch (error) {
      return wrapLegacyMatrixMcpError(error);
    }
  }
}

function wrapLegacyMatrixMcpResult(result: ToolResult): ToolResult {
  // Electron no longer starts the Matrix MCP process, but model-visible content and
  // Tool events must remain byte/shape compatible with the old MCP runtime adapter.
  // One deliberate difference: a rejected or failed request (details.ok false from
  // callMatrixTool), or a payload that reports an error, is an error, so its text
  // is not taken for search results.
  const mcpResult = {
    content: result.content,
    isError:
      result.isError === true ||
      result.details?.ok === false ||
      isSearchPayloadError(result.programmatic?.data),
    _meta: {
      matrix: { server: LEGACY_MATRIX_SERVER_NAME, tool: WebSearchToolDef.name },
      ...(result.details ? { details: result.details } : {}),
      ...(result.output ? { output: result.output } : {}),
    },
  };
  const wrapped = wrapLegacyMatrixMcpCallResult(result.text, mcpResult);
  // The client's structured response survives the MCP-compatible wrapper,
  // which rebuilds the result; a failure carries none.
  const data = mcpResult.isError ? undefined : result.programmatic?.data;
  return data ? withProgrammaticResult(wrapped, { data }) : wrapped;
}

/**
 * The search service answers some rejected requests (an empty query, for one)
 * with base_resp 0 and the error in the payload itself: a numeric `code` of
 * 400 or above and an empty `results`. A successful search carries `code` 0
 * and its `results`, so only an explicit error code with nothing found counts;
 * a payload without a numeric `code` stays a normal result.
 */
function isSearchPayloadError(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const { code, results } = payload as { code?: unknown; results?: unknown };
  if (typeof code !== 'number' || code < 400) return false;
  return !Array.isArray(results) || results.length === 0;
}

function wrapLegacyMatrixMcpError(error: unknown): ToolResult {
  const text = `Matrix MCP tool failed: ${error instanceof Error ? error.message : String(error)}`;
  return wrapLegacyMatrixMcpCallResult(text, {
    content: [{ type: 'text' as const, text }],
    isError: true,
    _meta: {
      matrix: { server: LEGACY_MATRIX_SERVER_NAME, tool: WebSearchToolDef.name },
    },
  });
}

function wrapLegacyMatrixMcpCallResult(
  text: string,
  mcpResult: {
    content: ToolResult['content'];
    isError: boolean;
    _meta: Record<string, unknown>;
  },
): ToolResult {
  const result: ToolResult = {
    tool_name: WebSearchToolDef.name,
    text,
    content: mcpResult.content,
    isError: mcpResult.isError,
    details: {
      mcp: mcpResult,
      server: LEGACY_MATRIX_SERVER_NAME,
      tool: WebSearchToolDef.name,
    },
    output: { mcp: mcpResult },
  };
  // Search results are never cut by the host; state it for PTC (side channel only).
  return mcpResult.isError ? result : withDesktopCompletenessReport(WebSearchToolDef.name, result);
}
