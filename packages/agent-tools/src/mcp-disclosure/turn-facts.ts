import type { RuntimeTool } from '@mavis/agent-core/tools';
import type { DeferredToolCallForm, DeferredToolCatalogOptions } from './catalog.js';
import type { McpToolEntry } from './types.js';

/**
 * Turn-level Tool Search facts the executor and runner need after assembly:
 * which optional behaviours are on and which deferred tools the catalog lists.
 * They ride on the Turn's `tool_search` object (like the PTC reminder on
 * `run_code`) so they reach `assembly.tools` without widening every seam.
 */
export interface ToolSearchTurnFacts {
  /** Deferred tools of this Turn with provenance; empty when nothing is deferred. */
  readonly deferredEntries: readonly McpToolEntry[];
  /**
   * What the catalog lists: the prefix window's frozen entries
   * (`ToolSearchWindow`), so the catalog text stays the same until the next
   * compaction. Absent: `deferredEntries`.
   */
  readonly catalogEntries?: readonly McpToolEntry[];
  /**
   * The tool-availability notice this Turn's user message must carry
   * (`renderToolAvailabilityNotice`): the complete current deviation from the
   * frozen tool list and catalog. Hosts append it to the user prompt.
   */
  readonly windowUpdate?: string;
  /**
   * The notice stating the Turn's current state: `windowUpdate`, or the notice
   * already told when nothing changed this Turn and the deviation is not empty.
   * What the request hook puts back after a compaction took it from the request.
   */
  readonly availabilityNotice?: string;
  /** Present when the deferred-tool catalog replaces the generic hint. */
  readonly catalog?: DeferredToolCatalogOptions;
  /** How this Turn calls a deferred tool once its definition is loaded. */
  readonly callForm: DeferredToolCallForm;
  readonly directCall: boolean;
  /** Re-supply definitions of tools discovered before a compaction. */
  readonly carryAcrossCompaction: boolean;
}

const TOOL_SEARCH_TURN_FACTS = Symbol('mavis.tool-search.turn-facts');

interface FactsCarrier {
  readonly [TOOL_SEARCH_TURN_FACTS]?: ToolSearchTurnFacts;
}

/** Returns the same tool with the facts attached; decorators that spread the tool keep them. */
export function attachToolSearchTurnFacts<T extends RuntimeTool>(
  tool: T,
  facts: ToolSearchTurnFacts,
): T {
  Object.defineProperty(tool, TOOL_SEARCH_TURN_FACTS, { value: facts, enumerable: true });
  return tool;
}

export function readToolSearchTurnFacts(
  tools: readonly RuntimeTool[] | undefined,
): ToolSearchTurnFacts | undefined {
  const search = tools?.find((tool) => tool.def.name === 'tool_search');
  return search ? (search as FactsCarrier)[TOOL_SEARCH_TURN_FACTS] : undefined;
}
