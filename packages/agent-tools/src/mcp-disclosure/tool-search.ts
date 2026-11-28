import { Type } from '@sinclair/typebox';
import { defineRuntimeTool, type RuntimeTool } from '@mavis/agent-core/tools';
import type { McpToolIndex, McpToolIndexNamespace } from './types.js';

/**
 * Last sentence of both tool_search descriptions on a PTC Turn. There the
 * hidden tools are run_code children: mcp_invoke does not route them, so the
 * mcp_invoke sentence would send the model into a rejected call. A name such
 * as `mcp__context7__resolve-library-id` is not a JS identifier, hence the
 * bracket form.
 */
export const TOOL_SEARCH_PTC_CALL_SENTENCE =
  'Then call the chosen tool inside run_code like any other tool: await tools.<name>(args), or await tools["<name>"](args) when the name contains characters such as "-".';

const ORDINARY_CALL_SENTENCE =
  'Then call `mcp_invoke` with the chosen tool_name and arguments to use one.';

/** Non-PTC turns where a deferred tool is callable by its own name (`directCall`). */
const DIRECT_CALL_SENTENCE =
  'Then call the chosen tool directly by its exact name with arguments matching its input_schema (`mcp_invoke` also works).';

/** Kept byte-identical for turns without namespaced tools. */
const SEARCH_SENTENCE =
  'Search by keyword `query` and/or `regex`; returns the full definitions (name, description, input_schema) of the top matches.';

const SEARCH_SENTENCE_WITH_NAMESPACES =
  'Search by keyword `query`, `regex`, and/or `namespace`; returns the full definitions (name, description, input_schema) of the top matches.';

/** The bounded search pages its results and can list one MCP server. */
const PAGED_SEARCH_SENTENCE =
  'Search by keyword `query` and/or `regex`, or query "mcp__<server>" to list one server\'s tools; returns the full definitions (name, description, input_schema) of the matches, one page at a time.';

const PAGED_SEARCH_SENTENCE_WITH_NAMESPACES =
  'Search by keyword `query`, `regex` and/or `namespace`, or query "mcp__<server>" to list one server\'s tools; returns the full definitions (name, description, input_schema) of the matches, one page at a time.';

/** `exactSelect` turns can name the tools they want instead of searching for them. */
const SELECT_SEARCH_SENTENCE =
  'Query with "select:<name>[,<name>...]" to load exact tools (for example names from the deferred tool catalog), "mcp__<server>" to list one server\'s tools, or keywords/`regex`; returns the full definitions (name, description, input_schema).';

const SELECT_SEARCH_SENTENCE_WITH_NAMESPACES =
  'Query with "select:<name>[,<name>...]" to load exact tools (for example names from the deferred tool catalog), "mcp__<server>" to list one server\'s tools, or keywords/`regex`/`namespace`; returns the full definitions (name, description, input_schema).';

/** How the middle sentence changes with the search mode and the namespace filter. */
function searchSentence(options: ToolSearchDescriptionOptions, withNamespaces: boolean): string {
  if (options.exactSelect) {
    return withNamespaces ? SELECT_SEARCH_SENTENCE_WITH_NAMESPACES : SELECT_SEARCH_SENTENCE;
  }
  if (options.paged) {
    return withNamespaces ? PAGED_SEARCH_SENTENCE_WITH_NAMESPACES : PAGED_SEARCH_SENTENCE;
  }
  return withNamespaces ? SEARCH_SENTENCE_WITH_NAMESPACES : SEARCH_SENTENCE;
}

/** Shown once a turn has namespaced builtin tools to search. */
const SKILL_SENTENCE =
  'A hit that carries a `skill` needs that Skill loaded with the `skill` tool before you call it.';

/** The schema field both tool_search implementations expose. */
export const TOOL_SEARCH_NAMESPACE_DESCRIPTION =
  'Namespace of builtin tools: a value with a dot matches that group exactly (`sidebar.project`), a value without one matches every group below it (`sidebar`). Pass it alone to list a whole group.';

/** The wording a turn without namespaced tools keeps, byte for byte. */
export const TOOL_SEARCH_NO_FILTER_ERROR = 'Provide at least one of `query` or `regex`.';

/** A turn that does expose namespaces may also filter by one. */
export const TOOL_SEARCH_NO_FILTER_ERROR_WITH_NAMESPACES =
  'Provide at least one of `query`, `regex` or `namespace`.';

/**
 * The no-filter error for this turn's index. A turn with no namespaced tool has
 * no `namespace` parameter to offer, so naming it would send the model after a
 * filter that does not exist.
 */
export function toolSearchNoFilterError(namespaces: readonly McpToolIndexNamespace[]): string {
  return namespaces.length === 0
    ? TOOL_SEARCH_NO_FILTER_ERROR
    : TOOL_SEARCH_NO_FILTER_ERROR_WITH_NAMESPACES;
}

/**
 * Both tool_search descriptions, so the two implementations cannot drift.
 *
 * A turn without namespaced tools keeps the original single-paragraph wording;
 * a turn with them gains the namespace list, one per line, and the rule that a
 * hit carrying a `skill` has to have that Skill loaded first.
 */
export interface ToolSearchDescriptionOptions {
  readonly ptc?: boolean;
  readonly namespaces?: readonly McpToolIndexNamespace[];
  /** `createBoundedToolSearchTool`: results page and `mcp__<server>` lists one server. */
  readonly paged?: boolean;
  /** `select:<name>` exact loading replaces the keyword sentence. */
  readonly exactSelect?: boolean;
  /** Deferred tools are callable directly by name; the call sentence says so. */
  readonly directCall?: boolean;
}

export function renderToolSearchDescription(
  lead: string,
  options: ToolSearchDescriptionOptions,
): string {
  const call = options.ptc
    ? TOOL_SEARCH_PTC_CALL_SENTENCE
    : options.directCall
      ? DIRECT_CALL_SENTENCE
      : ORDINARY_CALL_SENTENCE;
  const namespaces = options.namespaces ?? [];
  if (namespaces.length === 0) return [lead, searchSentence(options, false), call].join(' ');
  return [
    [lead, searchSentence(options, true)].join(' '),
    'Namespaces available this turn:',
    ...namespaces.map((entry) =>
      entry.summary === undefined
        ? `- ${entry.namespace}`
        : `- ${entry.namespace}: ${entry.summary}`,
    ),
    SKILL_SENTENCE,
    call,
  ].join('\n');
}

/**
 * `namespace` alone lists a whole group, so it ignores the default result
 * count and goes up to the maximum; `top_k` still wins when the model sets it.
 */
export function resolveToolSearchTopK(
  input: {
    readonly query?: string;
    readonly regex?: string;
    readonly namespace?: string;
    readonly top_k?: number;
  },
  limits: { readonly default: number; readonly max: number },
): number {
  const namespaceOnly =
    input.namespace !== undefined && !input.query?.trim() && !input.regex?.trim();
  const requested = input.top_k ?? (namespaceOnly ? limits.max : limits.default);
  return Math.max(1, Math.min(limits.max, Math.trunc(requested)));
}

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
    namespace: Type.Optional(Type.String({ description: TOOL_SEARCH_NAMESPACE_DESCRIPTION })),
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
    description: renderToolSearchDescription(
      'Discover additional integration tools provided by configured MCP servers that are NOT listed in your tools.',
      { ...(opts.ptc ? { ptc: true } : {}), namespaces: index.namespaces },
    ),
    schema,
    execute: async (
      _ctx,
      input: { query?: string; regex?: string; namespace?: string; top_k?: number },
    ) => {
      if (!input.query?.trim() && !input.regex?.trim() && !input.namespace?.trim())
        return err(toolSearchNoFilterError(index.namespaces));
      if (input.regex) {
        try {
          const _validate = new RegExp(input.regex, 'i');
          void _validate;
        } catch (e) {
          return err(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const topK = resolveToolSearchTopK(input, { default: opts.topKDefault, max: opts.topKMax });
      const hits = index.search({
        query: input.query,
        regex: input.regex,
        namespace: input.namespace,
        topK,
      });
      const text = JSON.stringify({ hits, total: hits.length });
      return { tool_name: 'tool_search', text, content: [{ type: 'text', text }] };
    },
  });
}
