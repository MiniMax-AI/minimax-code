import type { RuntimeTool, RuntimeToolSource, ToolDefinition } from '@mavis/agent-core/tools';

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
}

export interface McpSearchHit {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
  readonly score: number;
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
   * PTC Turn: tool_search names the run_code call form (TOOL_SEARCH_PTC_CALL_SENTENCE).
   * Which tools are deferred and how mcp_invoke resolves them stays the same.
   */
  readonly ptc?: boolean;
}

export interface ToolLoadingCatalog<T extends RuntimeTool = RuntimeTool> {
  readonly tools: T[];
  readonly plan: McpDisclosurePlan;
}

export interface McpToolIndex {
  search(input: { query?: string; regex?: string; topK: number }): McpSearchHit[];
  readonly size: number;
  readonly signature: string;
}

export interface McpDisclosureStats {
  readonly candidateCount: number;
  readonly indexedCount: number;
  readonly estTokens: number;
  readonly thresholdTokens: number;
}

export type McpDisclosurePlan =
  | { readonly deferred: false; readonly inlineTools: readonly RuntimeTool[] }
  | {
      readonly deferred: true;
      readonly inlineTools: readonly RuntimeTool[];
      readonly deferredRegistry: ReadonlyMap<string, RuntimeTool>;
      readonly index: McpToolIndex;
      readonly systemHintBlock?: string;
      readonly stats: McpDisclosureStats;
    };
