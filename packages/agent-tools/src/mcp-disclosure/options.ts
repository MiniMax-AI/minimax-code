import type { McpDisclosureOptions } from './types.js';

/**
 * Tool Search tunables a host may configure (local: `mcpToolSearch` in the
 * config file; cloud: none yet). Every field is optional; see
 * `resolveMcpDisclosureOptions` for the defaults.
 */
export interface McpToolSearchSettings {
  readonly enabled?: boolean;
  readonly modelWhitelist?: readonly string[];
  readonly thresholdPct?: number;
  readonly minDeferCount?: number;
  readonly topKDefault?: number;
  readonly topKMax?: number;
  readonly systemHint?: boolean;
  readonly maxSchemaTextLen?: number;
  readonly catalog?: boolean;
  readonly catalogBudgetTokens?: number;
  readonly exactSelect?: boolean;
  readonly directCall?: boolean;
  readonly deferBudgetTokens?: number;
  readonly carryAcrossCompaction?: boolean;
}

/**
 * Default fixed deferral budget for non-PTC Turns (estimated definition tokens).
 * ToolSearch-Bench Round 4 (2026-11-01, MiniMax-M3.1-Flash, PTC off): deferring pools
 * of 30k-44k was pass-rate non-inferior and cut estimated cost by about 19% against
 * the previous 0.15 × 512k window; pools of 25k stayed inline. PTC Turns ignore it.
 * It applies only when neither `deferBudgetTokens` nor `thresholdPct` is configured,
 * so an explicit ratio keeps working; a non-positive budget turns the budget off.
 * Any budget (default or explicit) is capped by `thresholdPct` × a known context
 * window, so small windows still defer.
 */
export const DEFAULT_DEFER_BUDGET_TOKENS = 27_500;

/**
 * Disclosure options of one Turn, shared by the local and the cloud runtime:
 * `MAVIS_MCP_TOOL_SEARCH_*` env vars win over `raw`, which wins over the defaults.
 * The Host passes its environment; without one there are no env overrides.
 */
export function resolveMcpDisclosureOptions(
  raw: McpToolSearchSettings | undefined,
  env: Readonly<Record<string, string | undefined>> = {},
): McpDisclosureOptions {
  const configuredRatio = parseNumber(env.MAVIS_MCP_TOOL_SEARCH_THRESHOLD_PCT) ?? raw?.thresholdPct;
  const deferBudgetTokens =
    parseNumber(env.MAVIS_MCP_TOOL_SEARCH_DEFER_BUDGET_TOKENS) ??
    raw?.deferBudgetTokens ??
    (configuredRatio === undefined ? DEFAULT_DEFER_BUDGET_TOKENS : undefined);
  const catalogBudgetTokens =
    parseNumber(env.MAVIS_MCP_TOOL_SEARCH_CATALOG_BUDGET_TOKENS) ?? raw?.catalogBudgetTokens;
  return {
    enabled: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_ENABLED, raw?.enabled, true, parseBoolean),
    modelWhitelist: resolveModelWhitelist(env.MAVIS_MCP_TOOL_SEARCH_WHITELIST, raw),
    thresholdPct: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_THRESHOLD_PCT,
      raw?.thresholdPct,
      0.15,
      parseNumber,
    ),
    minDeferCount: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_MIN_DEFER_COUNT,
      raw?.minDeferCount,
      1,
      parseNumber,
    ),
    topKDefault: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_TOP_K_DEFAULT,
      raw?.topKDefault,
      5,
      parseNumber,
    ),
    topKMax: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_TOP_K_MAX, raw?.topKMax, 20, parseNumber),
    systemHint: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_SYSTEM_HINT,
      raw?.systemHint,
      true,
      parseBoolean,
    ),
    maxSchemaTextLen: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_MAX_SCHEMA_TEXT_LEN,
      raw?.maxSchemaTextLen,
      4_096,
      parseNumber,
    ),
    // Default on: ToolSearch-Bench Round 1 (2026-10-28) showed catalog alone halving discovery
    // failures and call errors; the other optional behaviours stay opt-in.
    catalog: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_CATALOG, raw?.catalog, true, parseBoolean),
    exactSelect: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_EXACT_SELECT,
      raw?.exactSelect,
      false,
      parseBoolean,
    ),
    directCall: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_DIRECT_CALL,
      raw?.directCall,
      false,
      parseBoolean,
    ),
    carryAcrossCompaction: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_CARRY_ACROSS_COMPACTION,
      raw?.carryAcrossCompaction,
      false,
      parseBoolean,
    ),
    ...(deferBudgetTokens !== undefined && deferBudgetTokens > 0 ? { deferBudgetTokens } : {}),
    ...(catalogBudgetTokens !== undefined && catalogBudgetTokens >= 0
      ? { catalogBudgetTokens }
      : {}),
  };
}

function resolveOption<T>(
  envValue: string | undefined,
  configured: T | undefined,
  fallback: T,
  parse: (value: string | undefined) => T | undefined,
): T {
  return parse(envValue) ?? configured ?? fallback;
}

function resolveModelWhitelist(
  envValue: string | undefined,
  raw: McpToolSearchSettings | undefined,
): string[] {
  const parsed = parseStringList(envValue);
  if (parsed) return parsed;
  return raw?.modelWhitelist ? [...raw.modelWhitelist] : ['*'];
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStringList(value: string | undefined): string[] | undefined {
  const entries = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries && entries.length > 0 ? entries : undefined;
}
