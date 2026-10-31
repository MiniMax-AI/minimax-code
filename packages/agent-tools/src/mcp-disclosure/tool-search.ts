import { Type } from '@sinclair/typebox';
import { defineRuntimeTool, type RuntimeTool } from '@mavis/agent-core/tools';
import type { McpToolIndex } from './types.js';

/**
 * Last sentence of both tool_search descriptions on a PTC Turn. There the
 * hidden tools are run_code children: mcp_invoke does not route them, so the
 * mcp_invoke sentence would send the model into a rejected call. A name such
 * as `mcp__context7__resolve-library-id` is not a JS identifier, hence the
 * bracket form.
 */
export const TOOL_SEARCH_PTC_CALL_SENTENCE =
  'Then call the chosen tool inside run_code like any other tool: await tools.<name>(args), or await tools["<name>"](args) when the name contains characters such as "-".';

export interface ToolSearchToolOptions {
  readonly topKDefault: number;
  readonly topKMax: number;
  /** PTC Turn: say how to call a hit inside run_code. Omitted keeps the mcp_invoke wording. */
  readonly ptc?: boolean;
}

export function createToolSearchTool(
  index: McpToolIndex,
  opts: ToolSearchToolOptions,
): RuntimeTool {
  const schema = Type.Object({
    query: Type.Optional(
      Type.String({
        description: 'Keyword search (BM25, supports Chinese) over tool name/description/params.',
      }),
    ),
    regex: Type.Optional(
      Type.String({
        description: 'Regex filter over tool name/description/schema text (case-insensitive).',
      }),
    ),
    top_k: Type.Optional(
      Type.Number({
        description: `Max results (default ${opts.topKDefault}, max ${opts.topKMax}).`,
      }),
    ),
  });
  const err = (text: string) => ({
    tool_name: 'tool_search',
    text,
    content: [{ type: 'text' as const, text }],
    isError: true,
  });

  return defineRuntimeTool({
    name: 'tool_search',
    description: [
      'Discover additional integration tools provided by configured MCP servers that are NOT listed in your tools.',
      'Search by keyword `query` and/or `regex`; returns the full definitions (name, description, input_schema) of the top matches.',
      opts.ptc
        ? TOOL_SEARCH_PTC_CALL_SENTENCE
        : 'Then call `mcp_invoke` with the chosen tool_name and arguments to use one.',
    ].join(' '),
    schema,
    execute: async (_ctx, input: { query?: string; regex?: string; top_k?: number }) => {
      if (!input.query?.trim() && !input.regex?.trim())
        return err('Provide at least one of `query` or `regex`.');
      if (input.regex) {
        try {
          const _validate = new RegExp(input.regex, 'i');
          void _validate;
        } catch (e) {
          return err(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const topK = Math.max(1, Math.min(opts.topKMax, Math.trunc(input.top_k ?? opts.topKDefault)));
      const hits = index.search({ query: input.query, regex: input.regex, topK });
      const text = JSON.stringify({ hits, total: hits.length });
      return { tool_name: 'tool_search', text, content: [{ type: 'text', text }] };
    },
  });
}
