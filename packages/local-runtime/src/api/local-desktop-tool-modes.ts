import type { RuntimeTool } from '@mavis/agent-core/tools';
import {
  buildOrReuseIndex,
  createMcpInvokeTool,
  createToolSearchTool,
  type McpDisclosureOptions,
  type McpDisclosurePlan,
  type McpModelIdentity,
} from '@mavis/agent-tools';

import type { DesktopTurnCapabilityView } from '../runtime/desktop-turn-capabilities.js';

export function mergeDesktopTurnTools(input: {
  tools: RuntimeTool[];
  plan: McpDisclosurePlan;
  capabilities?: DesktopTurnCapabilityView;
  model: McpModelIdentity;
  options: McpDisclosureOptions;
}): { tools: RuntimeTool[]; plan: McpDisclosurePlan } {
  const capabilities = input.capabilities;
  if (!capabilities) return { tools: input.tools, plan: input.plan };

  // Keep toolMode on the binding and associate it with the tool object, avoiding name-only state assignment to same-named tools from other sources.
  const bindingByTool = new Map(
    capabilities.runtimeToolBindings.map((binding) => [binding.tool, binding]),
  );
  // Native tools and MCP tools already in the search index take priority; same-named Desktop tools cannot overwrite them.
  const usedNames = new Set(input.tools.map((tool) => normalizedToolName(tool.def.name)));
  if (input.plan.deferred) {
    for (const name of input.plan.deferredRegistry.keys()) usedNames.add(normalizedToolName(name));
  }

  const inlineTools: RuntimeTool[] = [];
  const searchableTools: RuntimeTool[] = [];
  for (const tool of capabilities.runtimeTools) {
    const binding = bindingByTool.get(tool);
    // Desktop tools without Connector state, such as Plugin MCP tools, retain inline behavior.
    const mode = binding?.kind === 'app' ? normalizeDesktopToolMode(binding.toolMode) : 'inline';
    // Drop omit entries at the final tool-list boundary so neither inline lists nor search indexes see them later.
    if (mode === 'omit') continue;

    const name = normalizedToolName(tool.def.name);
    if (!name || usedNames.has(name)) continue;
    usedNames.add(name);
    if (mode === 'tool_search') searchableTools.push(tool);
    else inlineTools.push(tool);
  }

  // Do not create extra tool_search / mcp_invoke entries if no Connector tools are forced into search.
  if (searchableTools.length === 0) {
    return { tools: [...input.tools, ...inlineTools], plan: input.plan };
  }

  const deferredRegistry = new Map<string, RuntimeTool>(
    input.plan.deferred ? input.plan.deferredRegistry : [],
  );
  // If MCP already uses on-demand search, merge Connector tools into the same index to avoid duplicate entry points.
  for (const tool of searchableTools) deferredRegistry.set(tool.def.name, tool);
  const deferredEntries = [...deferredRegistry.values()].map((tool) => ({
    tool,
    source: 'configured' as const,
  }));
  const index = buildOrReuseIndex(deferredEntries, {
    maxSchemaTextLen: input.options.maxSchemaTextLen,
  });
  const estimate = input.options.estimateTokens ?? estimateToolTokens;
  const forcedEstimate = searchableTools.reduce((total, tool) => total + estimate(tool.def), 0);
  const plan: McpDisclosurePlan = {
    deferred: true,
    inlineTools: input.plan.inlineTools,
    deferredRegistry,
    deferredEntries,
    index,
    stats: {
      candidateCount:
        (input.plan.deferred ? input.plan.stats.candidateCount : 0) + searchableTools.length,
      indexedCount: index.size,
      estTokens: (input.plan.deferred ? input.plan.stats.estTokens : 0) + forcedEstimate,
      thresholdTokens: input.plan.deferred
        ? input.plan.stats.thresholdTokens
        : input.options.thresholdPct * input.model.contextWindow,
    },
  };
  // The generic search entry points reference the pre-split index; remove them and rebuild against the merged index.
  const baseTools = input.plan.deferred
    ? input.tools.filter(
        (tool) => tool.def.name !== 'tool_search' && tool.def.name !== 'mcp_invoke',
      )
    : input.tools;
  return {
    tools: [
      ...baseTools,
      createToolSearchTool(index, {
        topKDefault: input.options.topKDefault,
        topKMax: input.options.topKMax,
      }),
      createMcpInvokeTool(deferredRegistry),
      ...inlineTools,
    ],
    plan,
  };
}

function normalizeDesktopToolMode(value: unknown): 'omit' | 'inline' | 'tool_search' {
  // Absent or unrecognized values must not change existing inline behavior.
  if (value === 'omit' || value === 'tool_search') return value;
  return 'inline';
}

function estimateToolTokens(def: RuntimeTool['def']): number {
  return Math.ceil(
    JSON.stringify({
      name: def.name,
      description: def.description,
      schema: def.schema,
    }).length / 4,
  );
}

function normalizedToolName(name: string): string {
  return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
