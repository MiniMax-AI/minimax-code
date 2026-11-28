import { Buffer } from 'node:buffer';
import { Type } from '@sinclair/typebox';
import {
  defineRuntimeTool,
  type RuntimeTool,
  type ToolExecutionContext,
} from '@mavis/agent-core/tools';
import { mcpServerOfToolName } from './search-index.js';
import type { McpSearchHit, McpToolIndex, McpToolSearchObservation } from './types.js';
import {
  renderToolSearchDescription,
  resolveToolSearchTopK,
  toolSearchNoFilterError,
  TOOL_SEARCH_NAMESPACE_DESCRIPTION,
} from './tool-search.js';

/** Upper bound on names accepted by one `select:` query. */
const MAX_SELECT_NAMES = 64;
/** Server names listed when an `mcp__` name matches no indexed tool. */
const MAX_LISTED_SERVERS = 32;

/**
 * Default tool_search response budget; also the size above which one tool
 * definition is reported `oversized` instead of returned.
 */
export const TOOL_SEARCH_MAX_RESULT_BYTES = 32 * 1024;

/** What one `namespace` query resolved to, for the caller's metric labels. */
export interface NamespaceSearchObservation {
  /** The trimmed value the model passed. */
  readonly namespace: string;
  /** `exact` names an indexed namespace; `prefix` only reaches groups below it. */
  readonly match: 'exact' | 'prefix' | 'none';
  /** Whether the same call also carried a keyword `query`. */
  readonly withQuery: boolean;
}

/** How a `namespace` query relates to the namespaces this index actually holds. */
function namespaceMatch(
  namespaces: McpToolIndex['namespaces'],
  query: string,
): NamespaceSearchObservation['match'] {
  const names = namespaces.map((entry) => entry.namespace);
  if (names.includes(query)) return 'exact';
  return names.some((name) => name.startsWith(`${query}.`)) ? 'prefix' : 'none';
}

export interface BoundedToolSearchOptions {
  topKDefault: number;
  topKMax: number;
  maxResultBytes?: number;
  /** PTC Turn: say how to call a hit inside run_code (see TOOL_SEARCH_PTC_CALL_SENTENCE). */
  ptc?: boolean;
  /** `select:` exact loading and zero-hit guidance (`mcp__<server>` listing is always on). */
  exactSelect?: boolean;
  /** Deferred tools are callable directly by name; the description says so. */
  directCall?: boolean;
  /** Tools already in the model's tool list, reported instead of "not found". */
  directToolNames?: ReadonlySet<string>;
  /** Observes every successful search (diagnostics and discovered-tool tracking). */
  onResult?: (ctx: ToolExecutionContext, observation: McpToolSearchObservation) => void;
  /** Counts one namespace query; the caller owns the metric name. */
  onNamespaceSearch?: (input: NamespaceSearchObservation) => void;
}

export function createBoundedToolSearchTool(
  index: McpToolIndex,
  opts: BoundedToolSearchOptions,
): RuntimeTool {
  const maxResults = Number.isFinite(opts.topKMax)
    ? Math.max(1, Math.min(20, Math.trunc(opts.topKMax)))
    : 20;
  const defaultResults = Number.isFinite(opts.topKDefault)
    ? Math.max(1, Math.min(maxResults, Math.trunc(opts.topKDefault)))
    : 5;
  const schema = Type.Object({
    query: Type.Optional(
      Type.String({
        maxLength: 512,
        description: opts.exactSelect
          ? 'Use "select:<name>[,<name>...]" for exact tool names, "mcp__<server>" to list one server\'s tools, or English keywords (BM25, also supports Chinese) over tool name/description/params.'
          : 'Keyword search (BM25, supports Chinese) over tool name/description/params, or "mcp__<server>" to list one server\'s tools.',
      }),
    ),
    regex: Type.Optional(
      Type.String({
        maxLength: 256,
        description: 'Regex filter over tool name/description/schema text (case-insensitive).',
      }),
    ),
    namespace: Type.Optional(
      Type.String({ maxLength: 128, description: TOOL_SEARCH_NAMESPACE_DESCRIPTION }),
    ),
    top_k: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: maxResults,
        description: `Max results per page (default ${defaultResults}, max ${maxResults}; a namespace query or an "mcp__<server>" listing defaults to ${maxResults}).`,
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          'Skip this many results. Pass `next_offset` from the previous response to read the next page.',
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
      'Discover on-demand tools, including scheduled-task management and configured integrations, that are absent from your default tool list.',
      {
        ...(opts.ptc ? { ptc: true } : {}),
        ...(opts.exactSelect ? { exactSelect: true } : {}),
        ...(opts.directCall ? { directCall: true } : {}),
        paged: true,
        namespaces: index.namespaces,
      },
    ),
    schema,
    execute: async (
      ctx,
      input: {
        query?: string;
        regex?: string;
        namespace?: string;
        top_k?: number;
        offset?: number;
      },
    ) => {
      if (!input.query?.trim() && !input.regex?.trim() && !input.namespace?.trim())
        return err(toolSearchNoFilterError(index.namespaces));
      if (
        (input.query?.length ?? 0) > 512 ||
        (input.regex?.length ?? 0) > 256 ||
        (input.namespace?.length ?? 0) > 128
      )
        return err(
          'query is limited to 512 characters; regex is limited to 256 characters; namespace is limited to 128 characters.',
        );
      if (
        input.top_k !== undefined &&
        (!Number.isInteger(input.top_k) || input.top_k < 1 || input.top_k > maxResults)
      )
        return err(`top_k must be an integer between 1 and ${maxResults}.`);
      if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0))
        return err('offset must be a non-negative integer.');
      if (input.regex) {
        try {
          const _validate = new RegExp(input.regex, 'i');
          void _validate;
        } catch (e) {
          return err(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // `namespace` alone lists a whole group, so it ignores the default page
      // size and goes up to the maximum; `top_k` still wins when the model sets it.
      const topK = resolveToolSearchTopK(input, { default: defaultResults, max: maxResults });
      const namespace = input.namespace?.trim();
      if (namespace) {
        try {
          opts.onNamespaceSearch?.({
            namespace,
            match: namespaceMatch(index.namespaces, namespace),
            withQuery: Boolean(input.query?.trim()),
          });
        } catch {
          // Counting never changes the search result.
        }
      }
      // A `namespace` filter is a hard group filter, so `select:`/`mcp__<server>`
      // name resolution does not apply to it; the keyword path carries it through.
      const resolved = namespace
        ? {
            mode: 'keyword' as const,
            matches: keywordMatches(index, input, namespace),
          }
        : opts.exactSelect
          ? resolveExact(index, input, opts.directToolNames)
          : (resolveByName(index, input) ??
            resolveMcpName(index, input, opts.directToolNames) ?? {
              mode: 'keyword' as const,
              matches: keywordMatches(index, input, undefined),
            });
      const { matches } = resolved;
      const pageSize =
        resolved.mode === 'select'
          ? matches.length
          : resolved.mode === 'prefix'
            ? (input.top_k ?? maxResults)
            : topK;
      const offset = input.offset ?? 0;
      const pageEnd = Math.min(matches.length, offset + pageSize);
      const hits: McpSearchHit[] = [];
      const oversized: string[] = [];
      const budget = opts.maxResultBytes ?? TOOL_SEARCH_MAX_RESULT_BYTES;
      const guidance = resolved.unknownName
        ? unknownNameNotice(index, resolved.unknownName)
        : opts.exactSelect && matches.length === 0 && !resolved.alreadyAvailable?.length
          ? zeroHitGuidance(index)
          : undefined;
      const ignored = resolved.ignoredCount
        ? `${resolved.ignoredCount} names beyond the first ${MAX_SELECT_NAMES} were ignored; select them in another call.`
        : undefined;
      const serialize = (consumed: number) => {
        const more = consumed < matches.length;
        // `omitted` answers "how many of this result set did I not get", which
        // `next_offset` only implies; a namespace query lists a whole group, so
        // the count is what tells the model the group is bigger than the page.
        const omitted = matches.length - consumed;
        return JSON.stringify({
          hits,
          total: matches.length,
          returned: hits.length,
          ...(more ? { next_offset: consumed } : {}),
          ...(omitted > 0 ? { omitted } : {}),
          ...(oversized.length > 0 ? { oversized } : {}),
          ...(resolved.notFound?.length ? { not_found: resolved.notFound } : {}),
          ...(resolved.alreadyAvailable?.length
            ? {
                already_available: resolved.alreadyAvailable,
                already_available_note: opts.ptc
                  ? 'These tools are already declared this Turn; call them without searching. Call a tool in your tool list directly; call any other tool inside run_code: await tools.<name>(args), or await tools["<name>"](args) when the name contains characters such as "-".'
                  : 'These tools are already in your tool list; call them directly without searching.',
              }
            : {}),
          ...noticeOf(
            more
              ? `More results remain: repeat this search with offset ${consumed}, or narrow it.`
              : undefined,
            oversized.length > 0
              ? '`oversized` definitions exceed the response budget and need a smaller tool contract.'
              : undefined,
            guidance,
            ignored,
          ),
        });
      };
      // A page stops at the first definition that does not fit, so `next_offset` never
      // skips one. A page's first definition is always returned unless it alone, without
      // notes, exceeds the budget; only then is it named `oversized` (later ones are left
      // for the next page). Such a page may exceed the budget by its notes and the
      // `not_found`/`already_available` lists, which the 512-character query bounds.
      const aloneBytes = (match: McpSearchHit) =>
        Buffer.byteLength(
          JSON.stringify({ hits: [match], total: matches.length, returned: 1 }),
          'utf8',
        );
      let consumed = Math.min(offset, matches.length);
      while (consumed < pageEnd) {
        const match = matches[consumed]!;
        hits.push(match);
        if (Buffer.byteLength(serialize(consumed + 1), 'utf8') > budget) {
          hits.pop();
          if (hits.length > 0 || oversized.length > 0) break;
          if (aloneBytes(match) > budget) oversized.push(match.name);
          else hits.push(match);
        }
        consumed += 1;
      }
      const text = serialize(consumed);
      try {
        opts.onResult?.(ctx, {
          mode: resolved.mode,
          returnedNames: hits.map((h) => h.name),
          total: matches.length,
          notFoundCount: resolved.notFound?.length ?? (resolved.unknownName ? 1 : 0),
        });
      } catch {
        // Observation must never change the tool result.
      }
      return { tool_name: 'tool_search', text, content: [{ type: 'text', text }] };
    },
  });
}

/**
 * The keyword path: only the declared inputs reach the index, so extra keys from
 * the model (`topK`) cannot. `namespace` is a hard filter the index applies
 * before BM25 ranks; paging bounds the result, so `topK` stays unset.
 */
function keywordMatches(
  index: McpToolIndex,
  input: { query?: string; regex?: string },
  namespace: string | undefined,
): McpSearchHit[] {
  return index.search({
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.regex !== undefined ? { regex: input.regex } : {}),
    ...(namespace === undefined ? {} : { namespace }),
    nameBoost: true,
  });
}

interface ExactResolution {
  readonly mode: McpToolSearchObservation['mode'];
  readonly matches: McpSearchHit[];
  readonly notFound?: string[];
  readonly alreadyAvailable?: string[];
  /** `select:` names past MAX_SELECT_NAMES, not looked up. */
  readonly ignoredCount?: number;
  /** An `mcp__` name that matches no indexed server or tool. */
  readonly unknownName?: string;
}

function noticeOf(...notices: (string | undefined)[]): { notice?: string } {
  const notice = notices.filter(Boolean).join(' ');
  return notice ? { notice } : {};
}

/**
 * The catalog prints names in JSON quotes; a query copied with its quotes
 * (`"mcp__s__x"`, `` `mcp__s` ``) still names that tool or server. One
 * surrounding pair of quotes or backticks is dropped.
 */
function unquotedQuery(query: string | undefined): string {
  const trimmed = query?.trim() ?? '';
  const quoted = /^["'`](.*)["'`]$/su.exec(trimmed);
  return quoted ? quoted[1]!.trim() : trimmed;
}

/**
 * A plain query that is a full tool name (case-insensitive) loads just that
 * tool. A bare word ("search", "browser") stays a keyword search: the name
 * boost still ranks an exact bare name first, and other matches are not hidden.
 */
function resolveByName(
  index: McpToolIndex,
  input: { query?: string; regex?: string },
): ExactResolution | undefined {
  const query = unquotedQuery(input.query);
  const exact = query && !input.regex ? index.lookup(query) : undefined;
  return exact && exact.name.toLowerCase() === query.toLowerCase()
    ? { mode: 'exact', matches: [exact] }
    : undefined;
}

/**
 * `mcp__<server>` lists that server's tools; undefined for queries that are not
 * an `mcp__` name. A name that matches no indexed server or tool (a server that
 * went away, a misspelling) returns nothing: a keyword search would match every
 * MCP tool on the `mcp` token and pass other servers' tools off as the answer.
 */
function resolveMcpName(
  index: McpToolIndex,
  input: { query?: string; regex?: string },
  directToolNames: ReadonlySet<string> | undefined,
): ExactResolution | undefined {
  const query = unquotedQuery(input.query);
  if (input.regex || !/^mcp__[^\s,]+$/iu.test(query)) return undefined;
  const prefix = query.endsWith('__') ? query : `${query}__`;
  const listed = index.withPrefix(prefix);
  if (listed.length > 0) return { mode: 'prefix', matches: listed };
  const lowerName = query.toLowerCase();
  // Tools whose names differ only in case: the exact lookup refused to pick one,
  // so let the keyword search list them rather than call the name unknown.
  if (index.names().some((name) => name.toLowerCase() === lowerName)) return undefined;
  const lowerPrefix = prefix.toLowerCase();
  const direct = [...(directToolNames ?? [])].filter((name) => {
    const lower = name.toLowerCase();
    return lower === lowerName || lower.startsWith(lowerPrefix);
  });
  return direct.length > 0
    ? { mode: 'prefix', matches: [], alreadyAvailable: direct.sort() }
    : { mode: 'prefix', matches: [], unknownName: query };
}

function resolveExact(
  index: McpToolIndex,
  input: { query?: string; regex?: string },
  directToolNames: ReadonlySet<string> | undefined,
): ExactResolution {
  const query = input.query?.trim() ?? '';
  const select = /^select:(.*)$/isu.exec(unquotedQuery(query));
  if (select) {
    const named = [
      ...new Set(
        select[1]!
          .split(',')
          .map((name) =>
            name
              .trim()
              .replace(/^["'`]+|["'`]+$/gu, '')
              .trim(),
          )
          .filter(Boolean),
      ),
    ];
    const requested = named.slice(0, MAX_SELECT_NAMES);
    const matches: McpSearchHit[] = [];
    const notFound: string[] = [];
    const alreadyAvailable: string[] = [];
    const seen = new Set<string>();
    for (const name of requested) {
      const found = index.lookup(name);
      if (found) {
        if (!seen.has(found.name)) matches.push(found);
        seen.add(found.name);
      } else if (directToolNames?.has(name)) {
        alreadyAvailable.push(name);
      } else {
        notFound.push(name);
      }
    }
    return {
      mode: 'select',
      matches,
      notFound,
      alreadyAvailable,
      ignoredCount: named.length - requested.length,
    };
  }
  const byName = resolveByName(index, input);
  if (byName) return byName;
  const mcpName = resolveMcpName(index, input, directToolNames);
  if (mcpName) return mcpName;
  const named = unquotedQuery(query);
  const matches = keywordMatches(index, input, undefined);
  const direct = matches.length === 0 && named && !input.regex && directToolNames?.has(named);
  return { mode: 'keyword', matches, ...(direct ? { alreadyAvailable: [named] } : {}) };
}

function unknownNameNotice(index: McpToolIndex, name: string): string {
  const servers = [
    ...new Set(index.names().flatMap((tool) => mcpServerOfToolName(tool) ?? [])),
  ].sort();
  const shown = servers.slice(0, MAX_LISTED_SERVERS).join(', ');
  const more =
    servers.length > MAX_LISTED_SERVERS ? ` and ${servers.length - MAX_LISTED_SERVERS} more` : '';
  return [
    `No tools are available under "${name}" now.`,
    servers.length > 0
      ? `Servers with deferred tools: ${shown}${more}; list one with "mcp__<server>".`
      : 'No MCP server has deferred tools now.',
  ].join(' ');
}

function zeroHitGuidance(index: McpToolIndex): string {
  const servers = [
    ...new Set(index.names().flatMap((name) => mcpServerOfToolName(name) ?? [])),
  ].sort();
  const builtins = index.names().filter((name) => !mcpServerOfToolName(name));
  return [
    'No deferred tool matched.',
    'Retry with English keywords taken from tool names or descriptions, "select:<name>" for an exact name, or "mcp__<server>" to list one server\'s tools.',
    servers.length > 0 ? `Servers with deferred tools: ${servers.join(', ')}.` : '',
    builtins.length > 0 ? `Built-in on-demand tools: ${builtins.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
