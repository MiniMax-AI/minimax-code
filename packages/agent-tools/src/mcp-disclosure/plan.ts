import type { RuntimeTool, ToolDefinition } from '@mavis/agent-core/tools';
import { buildOrReuseIndex } from './search-index.js';
import type {
  McpAutoDeferDecision,
  McpDisclosureOptions,
  McpDisclosurePlan,
  McpDisclosureStats,
  McpModelIdentity,
  McpToolEntry,
} from './types.js';
import {
  continueToolSearchWindow,
  startToolSearchWindow,
  toolAvailabilityNotice,
  toolSearchWindowFingerprint,
  type ToolSearchWindowInput,
  type ToolSearchWindowOutcome,
} from './window.js';

export function modelInWhitelist(provider: string, id: string, list: readonly string[]): boolean {
  const key = `${provider}/${id}`;
  return list.some((pat) => {
    if (pat === '*' || pat === key) return true;
    if (!pat.includes('*')) return false;
    const re = new RegExp(
      `^${pat
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    );
    return re.test(key);
  });
}

/**
 * Configured tools above this count are deferred even when their estimated schema fits the token
 * budget: providers cap function counts (OpenAI-compatible APIs reject more than 128), and large
 * context windows would otherwise admit hundreds of inline tools next to the builtins.
 */
export const MAX_INLINE_CONFIGURED_TOOLS = 64;

/**
 * Estimated tokens of one tool definition: about 4 ASCII characters per token
 * (the basis the 27,500 default budget was calibrated on in ToolSearch-Bench
 * Round 4) plus one token per non-ASCII code point. CJK tokenizes at roughly a
 * character per token, so a flat length / 4 under-counted Chinese definitions
 * about 4x and kept large Chinese pools inline. ASCII-only definitions estimate
 * exactly as before.
 */
export function estimateToolDefinitionTokens(def: ToolDefinition): number {
  const text = JSON.stringify({ name: def.name, description: def.description, schema: def.schema });
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii += 1;
    // A surrogate pair is one code point: count its high half only.
    else if (code < 0xdc00 || code > 0xdfff) other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

export function planMcpDisclosure(input: {
  entries: readonly McpToolEntry[];
  model?: McpModelIdentity;
  options?: McpDisclosureOptions;
  /** Targets already admitted to a managed gateway remain available through that gateway. */
  retainedDeferredTools?: ReadonlySet<RuntimeTool>;
  /**
   * PTC Turn: `options.deferBudgetTokens` does not apply; the Turn keeps
   * `thresholdPct × contextWindow`. ToolSearch-Bench Round 4 (2026-11-01) found a
   * fixed budget saves cost only when tools are sent as native definitions; in
   * run_code they render as compact TypeScript signatures, so deferral saves nothing.
   */
  ptc?: boolean;
  /**
   * On-demand tools this Turn keeps inline instead of deferring, by name. Their
   * definitions keep `loading: 'on_demand'`, so every reader of the definition
   * (the Skill gate, the appended unlock block) is unchanged; only this plan
   * stops deferring them.
   */
  inlineOnDemandToolNames?: readonly string[];
  /**
   * The Session's prefix window (`ToolSearchWindow`). It applies while Tool Search
   * is enabled for the model; the plan then carries the window outcome.
   */
  window?: ToolSearchWindowInput;
  /** `tool_search` and `mcp_invoke` are declared even when nothing is deferred. */
  gatewaysExposed?: boolean;
}): McpDisclosurePlan {
  const { entries, model, options } = input;
  const names = new Set<string>();
  for (const { tool } of entries) {
    if (names.has(tool.def.name)) throw new Error(`Duplicate on-demand tool: ${tool.def.name}`);
    names.add(tool.def.name);
  }

  // A promoted tool keeps its `on_demand` declaration and stops being deferred
  // for this Turn only, so it is also no longer a Tool Search candidate: the
  // window never freezes it, and its declarations change with the Turn's rules
  // rather than being pinned for a compaction.
  const inlineOnDemand = new Set(input.inlineOnDemandToolNames ?? []);
  const explicitlyDeferred = (tool: RuntimeTool): boolean =>
    !inlineOnDemand.has(tool.def.name) &&
    (tool.def.loading === 'on_demand' ||
      (tool.def.loading !== 'default' && input.retainedDeferredTools?.has(tool) === true));
  // Tool Search candidates: everything a plan may defer.
  const isCandidate = ({ tool, source }: McpToolEntry): boolean =>
    explicitlyDeferred(tool) || (source === 'configured' && tool.def.loading !== 'default');
  const estimate = options?.estimateTokens ?? estimateToolDefinitionTokens;
  const rawBudget = input.ptc ? undefined : options?.deferBudgetTokens;
  const budgetTokens =
    rawBudget !== undefined && Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : undefined;
  const validContext =
    model !== undefined && Number.isFinite(model.contextWindow) && model.contextWindow > 0;
  const ratioTokens =
    options && validContext && model ? options.thresholdPct * model.contextWindow : 0;
  // A fixed budget keeps large windows from flipping the tool list (512k vs 1M), but
  // is capped by the window ratio so small windows still defer. An unknown window
  // (ratio 0) leaves the budget alone: a plain min would defer everything.
  const thresholdTokens =
    budgetTokens === undefined
      ? ratioTokens
      : ratioTokens > 0
        ? Math.min(budgetTokens, ratioTokens)
        : budgetTokens;
  const stats = (deferred: readonly McpToolEntry[], indexedCount: number): McpDisclosureStats => ({
    candidateCount: deferred.length,
    indexedCount,
    estTokens: deferred.reduce((sum, { tool }) => sum + estimate(tool.def), 0),
    thresholdTokens,
  });
  const maxSchemaTextLen = options?.maxSchemaTextLen ?? 4096;
  const gatewaysExposed = input.gatewaysExposed === true;

  const windowed =
    input.window !== undefined &&
    options?.enabled === true &&
    model !== undefined &&
    modelInWhitelist(model.provider, model.id, options.modelWhitelist);
  const fingerprint =
    windowed && options && model
      ? toolSearchWindowFingerprint(options, model, input.ptc === true)
      : '';
  let reset: ToolSearchWindowOutcome['reset'];
  const windowInput = windowed ? input.window : undefined;
  const current = windowInput?.current;
  if (windowInput && current && current.fingerprint !== fingerprint) {
    reset = { reason: 'options or model changed', tools: [] };
  } else if (windowInput && current) {
    const continued = continueToolSearchWindow(current, windowInput, {
      entries,
      isCandidate,
      gatewaysExposed,
      maxSchemaTextLen,
      stats: (deferred) => stats(deferred, deferred.length),
    });
    if ('plan' in continued) return continued.plan;
    reset = continued.reset;
  }

  const candidates = entries.filter(
    ({ tool, source }) =>
      source === 'configured' && tool.def.loading !== 'default' && !explicitlyDeferred(tool),
  );
  const eligible = Boolean(
    options?.enabled &&
    model &&
    modelInWhitelist(model.provider, model.id, options.modelWhitelist) &&
    candidates.length >= options.minDeferCount,
  );
  const overCount = candidates.length > MAX_INLINE_CONFIGURED_TOOLS;
  const overTokens =
    (budgetTokens !== undefined || validContext) &&
    candidates.reduce((sum, { tool }) => sum + estimate(tool.def), 0) > thresholdTokens;
  const automaticallyDefer = eligible && (overCount || overTokens);
  const autoDecision: McpAutoDeferDecision | undefined = eligible
    ? automaticallyDefer
      ? 'deferred'
      : 'inline'
    : undefined;
  const deferredEntries = entries.filter(
    ({ tool, source }) =>
      explicitlyDeferred(tool) ||
      (automaticallyDefer && source === 'configured' && tool.def.loading !== 'default'),
  );
  const plan = freshPlan(entries, deferredEntries, maxSchemaTextLen, stats);
  const decided = autoDecision ? { ...plan, autoDecision, thresholdTokens } : plan;
  if (!windowInput) {
    // Tool Search is off for this Turn: nothing deviates, earlier notices are withdrawn.
    const notice =
      input.window && toolAvailabilityNotice(input.window.told, new Map(), [], entries);
    return notice ? { ...decided, availability: notice } : decided;
  }
  const started = startToolSearchWindow(decided, {
    entries,
    isCandidate,
    gatewaysExposed,
    fingerprint,
    ...(reset ? { reset } : {}),
  });
  const notice = toolAvailabilityNotice(windowInput.told, started.deviation, [], entries);
  return { ...decided, window: started, ...(notice ? { availability: notice } : {}) };
}

function freshPlan(
  entries: readonly McpToolEntry[],
  deferredEntries: readonly McpToolEntry[],
  maxSchemaTextLen: number,
  stats: (deferred: readonly McpToolEntry[], indexedCount: number) => McpDisclosureStats,
): McpDisclosurePlan {
  if (deferredEntries.length === 0) {
    return { deferred: false, inlineTools: entries.map(({ tool }) => tool) };
  }
  const deferredRegistry = new Map<string, RuntimeTool>(
    deferredEntries.map(({ tool }) => [tool.def.name, tool]),
  );
  const index = buildOrReuseIndex(deferredEntries, { maxSchemaTextLen });
  return {
    deferred: true,
    inlineTools: entries
      .filter(({ tool }) => !deferredRegistry.has(tool.def.name))
      .map(({ tool }) => tool),
    deferredRegistry,
    index,
    deferredEntries,
    stats: stats(deferredEntries, index.size),
  };
}
