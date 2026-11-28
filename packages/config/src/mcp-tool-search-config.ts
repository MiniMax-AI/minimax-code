/**
 * MCP progressive-disclosure ("tool search") tunables.
 *
 * All fields optional; unset fields fall back to the disclosure defaults
 * applied by the shared resolver (`MAVIS_MCP_TOOL_SEARCH_*` env vars win
 * over this block). `catalog` defaults on and non-PTC Turns default to a 27,500
 * token `deferBudgetTokens`; `exactSelect`, `directCall` and `carryAcrossCompaction`
 * default off. See
 * `packages/agent-tools/src/mcp-disclosure/options.ts`.
 */
export interface McpToolSearchConfig {
  enabled?: boolean;
  modelWhitelist?: string[];
  /**
   * Window ratio for automatic deferral on PTC Turns; when set, also on non-PTC Turns without
   * `deferBudgetTokens`. It also caps the non-PTC budget, so raising that budget past it needs a
   * larger ratio, which changes PTC Turns too.
   */
  thresholdPct?: number;
  minDeferCount?: number;
  topKDefault?: number;
  topKMax?: number;
  systemHint?: boolean;
  maxSchemaTextLen?: number;
  /**
   * Announce a budgeted catalog of deferred tools instead of the generic per-turn hint. Only
   * this switch removes the catalog: `systemHint: false` only drops the generic hint, and
   * `enabled: false` or `modelWhitelist: []` only stop automatic MCP deferral, so explicitly
   * on-demand tools (cron, session) stay deferred and are still listed.
   */
  catalog?: boolean;
  /** Catalog size in estimated tokens (default 2,000); 0 keeps server names and counts only. */
  catalogBudgetTokens?: number;
  /** `tool_search` accepts `select:` exact names, with zero-hit guidance. */
  exactSelect?: boolean;
  /** Deferred tools may be called directly by their real name on non-PTC Turns. */
  directCall?: boolean;
  /**
   * Fixed token budget for automatic deferral on non-PTC Turns, capped at `thresholdPct` × the
   * model's context window when that window is known. Defaults to 27,500 when neither this nor
   * `thresholdPct` is set; a non-positive value turns it off.
   */
  deferBudgetTokens?: number;
  /** Re-supply definitions of tools discovered before a compaction. */
  carryAcrossCompaction?: boolean;
}

const BOOLEAN_KEYS = [
  'enabled',
  'systemHint',
  'catalog',
  'exactSelect',
  'directCall',
  'carryAcrossCompaction',
] as const;

const NUMBER_KEYS = [
  'thresholdPct',
  'minDeferCount',
  'topKDefault',
  'topKMax',
  'maxSchemaTextLen',
  'deferBudgetTokens',
  'catalogBudgetTokens',
] as const;

export function parseMcpToolSearchConfig(
  raw: Record<string, unknown>,
): McpToolSearchConfig | undefined {
  const obj = raw.mcpToolSearch;
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;

  const result: McpToolSearchConfig = {};

  // Values may arrive as YAML strings ("true", "24000") when written through
  // `config.mcpToolSearch.*` overrides, so accept both native and string forms.
  for (const key of BOOLEAN_KEYS) {
    const value: unknown = Reflect.get(obj, key);
    if (typeof value === 'boolean') result[key] = value;
    else if (value === 'true' || value === 'false') result[key] = value === 'true';
  }
  for (const key of NUMBER_KEYS) {
    const value: unknown = Reflect.get(obj, key);
    const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (typeof parsed === 'number' && Number.isFinite(parsed)) result[key] = parsed;
  }

  const modelWhitelist = Reflect.get(obj, 'modelWhitelist');
  if (Array.isArray(modelWhitelist)) {
    result.modelWhitelist = modelWhitelist.filter((v): v is string => typeof v === 'string');
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
