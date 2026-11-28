import type { RuntimeTool } from '@mavis/agent-core/tools';
import { renderToolAvailabilityNotice } from './catalog.js';
import { createMcpInvokeTool, getMcpInvokeRegistries } from './mcp-invoke.js';
import { buildOrReuseIndex } from './search-index.js';
import { createBoundedToolSearchTool } from './bounded-tool-search.js';
import { planMcpDisclosure } from './plan.js';
import { attachToolSearchTurnFacts } from './turn-facts.js';
import type { ToolLoadingCatalog, ToolLoadingCatalogOptions } from './types.js';

/** Plans the final inventory after the host's capability and permission filters. */
export function buildToolLoadingCatalog<T extends RuntimeTool>(
  input: ToolLoadingCatalogOptions & { readonly tools: readonly T[] },
): ToolLoadingCatalog<T> {
  const { tools } = input;
  const gateways = tools.filter((tool) => tool.def.name === 'mcp_invoke');
  if (gateways.length > 1) throw new Error('Duplicate on-demand tool: mcp_invoke');
  const existingInvoke = gateways[0];
  const existing = existingInvoke ? getMcpInvokeRegistries(existingInvoke) : undefined;
  if (existingInvoke && !existing) {
    throw new Error('Cannot merge on-demand tools into an unmanaged mcp_invoke tool.');
  }
  const searches = tools.filter((tool) => tool.def.name === 'tool_search');
  if (searches.length > 1 || (searches.length > 0 && !existing)) {
    throw new Error('Duplicate or unmanaged on-demand tool: tool_search');
  }
  const inventory = [
    ...tools.filter((tool) => tool.def.name !== 'tool_search' && tool.def.name !== 'mcp_invoke'),
    ...(existing?.registry.values() ?? []),
  ];
  for (const tool of inventory) {
    if (tool.def.name === 'tool_search' || tool.def.name === 'mcp_invoke') {
      throw new Error(`Reserved on-demand tool name: ${tool.def.name}`);
    }
  }
  const provenance = new Map(input.entries?.map((entry) => [entry.tool, entry]));
  const plan = planMcpDisclosure({
    entries: inventory.map(
      (tool) => provenance.get(tool) ?? { tool, source: tool.source ?? 'builtin' },
    ),
    model: input.model,
    options: input.options,
    retainedDeferredTools: new Set(existing?.registry.values()),
    ...(input.ptc ? { ptc: true } : {}),
    ...(input.inlineOnDemandToolNames
      ? { inlineOnDemandToolNames: input.inlineOnDemandToolNames }
      : {}),
    ...(input.window ? { window: input.window } : {}),
    gatewaysExposed: Boolean(input.alwaysExpose || existing),
  });
  // A window that declared the gateways keeps them until it ends.
  if (!plan.deferred && !input.alwaysExpose && !existing && !plan.window?.window.gateways) {
    return { tools: [...plan.inlineTools] as T[], plan };
  }
  const registry = plan.deferred ? plan.deferredRegistry : new Map<string, RuntimeTool>();
  const index = plan.deferred
    ? plan.index
    : buildOrReuseIndex([], { maxSchemaTextLen: input.options?.maxSchemaTextLen ?? 4096 });
  const invoke = createMcpInvokeTool(registry, existing?.referenceRegistry);
  const options = input.options;
  const directCall = Boolean(options?.directCall) && !input.ptc;
  const callForm = input.ptc ? 'ptc' : directCall ? 'direct' : 'mcp_invoke';
  const catalogOptions = {
    callForm,
    exactSelect: Boolean(options?.exactSelect),
    ...(options?.catalogBudgetTokens !== undefined
      ? { budgetTokens: options.catalogBudgetTokens }
      : {}),
  } as const;
  const windowUpdate = plan.availability
    ? renderToolAvailabilityNotice(plan.availability, catalogOptions)
    : undefined;
  // Nothing due: a notice already told states this deviation, in the very same words.
  const availabilityNotice =
    windowUpdate ?? (plan.window?.deviation.size ? input.window?.told.text : undefined);
  const toolSearch = attachToolSearchTurnFacts(
    createBoundedToolSearchTool(index, {
      topKDefault: options?.topKDefault ?? 5,
      topKMax: options?.topKMax ?? 20,
      ...(input.ptc ? { ptc: true } : {}),
      ...(options?.exactSelect ? { exactSelect: true } : {}),
      ...(directCall ? { directCall: true } : {}),
      // A removed tool's stand-in is declared but not callable: not "already available".
      directToolNames: new Set(
        plan.inlineTools
          .map((tool) => tool.def.name)
          .filter((name) => plan.window?.deviation.get(name)?.status !== 'removed'),
      ),
      ...(input.onToolSearch ? { onResult: input.onToolSearch } : {}),
      ...(input.onNamespaceSearch ? { onNamespaceSearch: input.onNamespaceSearch } : {}),
    }),
    {
      deferredEntries: plan.deferred ? plan.deferredEntries : [],
      ...(plan.window ? { catalogEntries: [...plan.window.window.deferred.values()] } : {}),
      ...(windowUpdate ? { windowUpdate } : {}),
      ...(availabilityNotice ? { availabilityNotice } : {}),
      ...(options?.catalog ? { catalog: catalogOptions } : {}),
      callForm,
      directCall,
      carryAcrossCompaction: Boolean(options?.carryAcrossCompaction),
    },
  );
  return {
    tools: [
      ...plan.inlineTools,
      toolSearch,
      {
        ...invoke,
        ...(existingInvoke?.toolCallProvenanceResolver
          ? { toolCallProvenanceResolver: existingInvoke.toolCallProvenanceResolver }
          : {}),
      },
    ] as T[],
    plan,
  };
}

/** Preserves the legacy pure-MCP search contract for callers without a new loading policy. */
export function applyToolLoading<T extends RuntimeTool>(
  tools: readonly T[],
  options?: ToolLoadingCatalogOptions,
): T[] {
  if (!options && !tools.some((tool) => tool.def.loading === 'on_demand')) return [...tools];
  return buildToolLoadingCatalog({ ...options, tools }).tools;
}
