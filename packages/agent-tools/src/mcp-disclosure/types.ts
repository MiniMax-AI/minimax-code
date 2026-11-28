import type {
  RuntimeTool,
  RuntimeToolSource,
  ToolDefinition,
  ToolExecutionContext,
} from '@mavis/agent-core/tools';
import type { NamespaceSearchObservation } from './bounded-tool-search.js';
import type {
  ToolAvailabilityNotice,
  ToolSearchWindowInput,
  ToolSearchWindowOutcome,
} from './window.js';

export type McpToolSource = RuntimeToolSource;

export interface McpToolEntry {
  readonly tool: RuntimeTool;
  readonly source: McpToolSource;
  /**
   * Concrete ready-inventory server identity when the source can provide it.
   * It remains optional for older callers, but a Session Agent `mcpServers`
   * selector deliberately fails closed for entries without this provenance.
   */
  readonly serverName?: string;
}

export interface McpModelIdentity {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
}

export interface McpDisclosureOptions {
  readonly enabled: boolean;
  readonly modelWhitelist: readonly string[];
  readonly thresholdPct: number;
  readonly minDeferCount: number;
  readonly topKDefault: number;
  readonly topKMax: number;
  readonly systemHint: boolean;
  readonly maxSchemaTextLen: number;
  readonly estimateTokens?: (def: ToolDefinition) => number;
  /** Inject a budgeted deferred-tool catalog instead of the generic per-turn hint. */
  readonly catalog?: boolean;
  /** Catalog size in estimated tokens (default 2,000); 0 keeps server names and counts only. */
  readonly catalogBudgetTokens?: number;
  /** `select:` exact loading and zero-hit guidance. */
  readonly exactSelect?: boolean;
  /** Deferred tools are callable directly by their real name (non-PTC Turns). */
  readonly directCall?: boolean;
  /**
   * Fixed token budget for automatic deferral on non-PTC Turns, replacing
   * `thresholdPct × contextWindow` there; PTC Turns keep the window ratio.
   */
  readonly deferBudgetTokens?: number;
  /** After compaction, re-supply the definitions of tools discovered before it. */
  readonly carryAcrossCompaction?: boolean;
}

export interface McpSearchHit {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
  readonly score: number;
  /** Set on builtin tools that belong to a namespace; absent for MCP tools. */
  readonly namespace?: string;
  /** The Skill to load before calling this tool; absent without a namespace. */
  readonly skill?: string;
  /** True when `skill` must be loaded through the `skill` tool first. */
  readonly skill_required?: boolean;
}

/** One namespace present in an index, for the tool_search description. */
export interface McpToolIndexNamespace {
  readonly namespace: string;
  readonly summary?: string;
}

export interface ToolLoadingCatalogOptions {
  /** Provenance for tools already present in the inventory or an existing named registry. */
  readonly entries?: readonly McpToolEntry[];
  readonly model?: McpModelIdentity;
  /** Controls automatic disclosure; explicit loading declarations always apply. */
  readonly options?: McpDisclosureOptions;
  /** Keeps both gateway definitions present even when the directory is empty. */
  readonly alwaysExpose?: boolean;
  /**
   * PTC Turn: tool_search names the run_code call form (TOOL_SEARCH_PTC_CALL_SENTENCE),
   * and `options.deferBudgetTokens` does not apply (the window ratio decides).
   * How mcp_invoke resolves deferred tools stays the same.
   */
  readonly ptc?: boolean;
  /**
   * On-demand tools this Turn keeps inline instead of deferring, by name.
   *
   * A PTC Turn uses it for the namespaced tools it promotes to top-level direct
   * calls (`PTC_TOP_LEVEL_NAMESPACED_TOOL_NAMES`): the definitions still say
   * `loading: 'on_demand'`, so the Skill gate and the namespace catalog keep
   * treating them as managed tools, while the Turn's tool list, the deferred
   * catalog and the Tool Search index all stop carrying them.
   */
  readonly inlineOnDemandToolNames?: readonly string[];
  /**
   * The Session's prefix window (`ToolSearchWindow`). Absent: every build plans
   * afresh, as for a caller without a Session.
   */
  readonly window?: ToolSearchWindowInput;
  /** Observes each `tool_search` result (diagnostics, discovered-tool tracking). */
  readonly onToolSearch?: (
    ctx: ToolExecutionContext,
    observation: McpToolSearchObservation,
  ) => void;
  /** Counts one `tool_search` namespace query; the caller owns the metric name. */
  readonly onNamespaceSearch?: (input: NamespaceSearchObservation) => void;
}

/** What one `tool_search` call returned; counts and names only, never arguments. */
export interface McpToolSearchObservation {
  readonly mode: 'keyword' | 'select' | 'exact' | 'prefix';
  /** Tool definitions actually returned to the model (after the byte budget). */
  readonly returnedNames: readonly string[];
  readonly total: number;
  readonly notFoundCount: number;
}

export interface ToolLoadingCatalog<T extends RuntimeTool = RuntimeTool> {
  readonly tools: T[];
  readonly plan: McpDisclosurePlan;
}

export interface McpIndexSearchInput {
  readonly query?: string;
  readonly regex?: string;
  /**
   * Hard filter applied before `query` ranks: a value with a dot matches that
   * namespace exactly, a value without one matches it and every namespace
   * below it (`sidebar` also matches `sidebar.project`).
   */
  readonly namespace?: string;
  /** Omitted: every match, best first. */
  readonly topK?: number;
  /** Rank name matches above description matches. */
  readonly nameBoost?: boolean;
}

export interface McpToolIndex {
  search(input: McpIndexSearchInput): McpSearchHit[];
  /**
   * Exact name lookup, case-sensitive first and case-insensitive only when that is
   * unambiguous; a bare tool name without its `mcp__<server>__` prefix resolves when unique.
   */
  lookup(name: string): McpSearchHit | undefined;
  /** Every indexed tool whose name starts with `prefix` (case-insensitive), sorted by name. */
  withPrefix(prefix: string): McpSearchHit[];
  names(): readonly string[];
  readonly size: number;
  readonly signature: string;
  /** Namespaces this index contains, so tool_search can name them. */
  readonly namespaces: readonly McpToolIndexNamespace[];
}

export interface McpDisclosureStats {
  readonly candidateCount: number;
  readonly indexedCount: number;
  readonly estTokens: number;
  readonly thresholdTokens: number;
}

/** The automatic (threshold-driven) deferral outcome, independent of explicit `loading`. */
export type McpAutoDeferDecision = 'deferred' | 'inline';

export type McpDisclosurePlan =
  | {
      readonly deferred: false;
      readonly inlineTools: readonly RuntimeTool[];
      readonly autoDecision?: McpAutoDeferDecision;
      /** The estimated-token threshold this plan made `autoDecision` against; absent when a window held it. */
      readonly thresholdTokens?: number;
      /** Present while Tool Search is active for a Session (`ToolLoadingCatalogOptions.window`). */
      readonly window?: ToolSearchWindowOutcome;
      /**
       * The tool-availability notice this Turn's user message carries; may be
       * present without a window (Tool Search turned off) to withdraw earlier ones.
       */
      readonly availability?: ToolAvailabilityNotice;
    }
  | {
      readonly deferred: true;
      readonly inlineTools: readonly RuntimeTool[];
      readonly deferredRegistry: ReadonlyMap<string, RuntimeTool>;
      readonly index: McpToolIndex;
      readonly systemHintBlock?: string;
      readonly stats: McpDisclosureStats;
      readonly autoDecision?: McpAutoDeferDecision;
      readonly thresholdTokens?: number;
      /** Provenance of each deferred tool, for catalog grouping. */
      readonly deferredEntries: readonly McpToolEntry[];
      readonly window?: ToolSearchWindowOutcome;
      readonly availability?: ToolAvailabilityNotice;
    };
