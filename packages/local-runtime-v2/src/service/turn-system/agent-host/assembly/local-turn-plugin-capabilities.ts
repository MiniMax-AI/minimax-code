import { buildPluginId, parsePluginMentions } from '@mavis/shared/plugin-mention';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import {
  attachPluginCapabilityAttribution,
  normalizedPluginSkillAttributionKey,
  selectPreferredAppPluginOwners,
  type PluginCapabilityAttributionIndex,
} from '@mavis/agent-core/event-bridge';
import {
  authorizeMcpInvokeReference,
  buildOrReuseIndex,
  createMcpInvokeTool,
  createToolSearchTool,
  revokeMcpInvokeReferenceAuthorization,
  resolveMcpInvokeTarget,
  type McpDisclosureOptions,
  type McpDisclosurePlan,
  type McpModelIdentity,
  type McpInvokeReferenceTarget,
  type McpInvokeTargetResolution,
} from '@mavis/agent-tools';
import {
  buildPluginReferenceReminder,
  detectPluginReferencesForMessages,
  type EffectivePluginCapabilityInventory,
} from '@mavis/system-reminder';
import {
  InstalledPluginSource,
  PluginCapabilityType,
  type IPluginCapabilityProvenance,
} from '@mavis/protocol';

import type { AgentHostTurnCapabilityView } from './turn-capability-lifecycle.js';
import type {
  HostCapabilityReferenceTarget,
  HostCapabilityResolver,
  HostCapabilitySurface,
} from './host-capability/contracts.js';
import { withHostSkillContracts } from './host-capability/skill-disclosure.js';

export type DelegatedToolTargetResolution = McpInvokeTargetResolution;

/** Concrete mcp gateway adapter kept at the AgentHost assembly boundary. */
export function resolveDelegatedToolTarget(
  tool: RuntimeTool,
  input: unknown,
): DelegatedToolTargetResolution | undefined {
  return resolveMcpInvokeTarget(tool, input);
}

/** One-shot Host admission for a delegated Host Binding call. */
export function authorizeDelegatedToolReference(
  tool: RuntimeTool,
  input: unknown,
): DelegatedToolTargetResolution {
  return authorizeMcpInvokeReference(tool, input);
}

/** Removes a Host admission that cannot cross the final delivery seam. */
export function revokeDelegatedToolReferenceAuthorization(tool: RuntimeTool, input: unknown): void {
  revokeMcpInvokeReferenceAuthorization(tool, input);
}

export interface MergeAgentHostTurnCapabilitiesInput {
  readonly tools: readonly RuntimeTool[];
  readonly plan: McpDisclosurePlan;
  readonly capabilities?: AgentHostTurnCapabilityView;
  readonly model: McpModelIdentity;
  readonly options: McpDisclosureOptions;
  readonly effectivePluginSkills: readonly {
    readonly pluginName: string;
    readonly name: string;
  }[];
  readonly hostCapabilityRegistry?: HostCapabilityResolver;
  readonly surface?: HostCapabilitySurface;
  readonly userText?: string;
}

export interface MergedAgentHostTurnCapabilities {
  readonly tools: readonly RuntimeTool[];
  readonly plan: McpDisclosurePlan;
  readonly reminder?: string;
}

/** Applies the v1 final-catalog precedence and explicit @Plugin reminder semantics in v2. */
export function mergeAgentHostTurnCapabilities(
  input: MergeAgentHostTurnCapabilitiesInput,
): MergedAgentHostTurnCapabilities {
  const merged = mergeTools(input);
  const capabilities = input.capabilities;
  if (!capabilities) {
    const reminder = buildPluginReferenceReminder(
      [],
      parsePluginMentions(input.userText ?? '').map((mention) => mention.pluginId),
    );
    return { ...merged, ...(reminder ? { reminder } : {}) };
  }
  const attributed = {
    ...merged,
    tools: attachPluginCapabilityAttribution(
      merged.tools,
      buildAttributionIndex({
        capabilities,
        effectivePluginSkills: input.effectivePluginSkills,
        finalTools: merged.tools,
        plan: merged.plan,
      }),
    ),
  };
  if (input.userText === undefined) return attributed;
  const inventory = buildCapabilityInventory({
    capabilities,
    effectivePluginSkills: input.effectivePluginSkills,
    // Inventory filtering uses the pre-attribution tool identities.
    finalTools: merged.tools,
    deferredToolNames: new Set(
      attributed.plan.deferred ? attributed.plan.deferredRegistry.keys() : [],
    ),
  });
  const unavailable = [
    ...new Set(parsePluginMentions(input.userText).map((mention) => mention.pluginId)),
  ].filter(
    (id) =>
      !inventory.some(
        (plugin) =>
          plugin.pluginId === id &&
          (plugin.skills.length > 0 || plugin.appTools.length > 0 || plugin.mcpTools.length > 0),
      ),
  );
  const reminder = buildPluginReferenceReminder(
    detectPluginReferencesForMessages([{ content: input.userText }], input.userText, inventory),
    unavailable,
  );
  return { ...attributed, ...(reminder ? { reminder } : {}) };
}

function buildAttributionIndex(input: {
  readonly capabilities: AgentHostTurnCapabilityView;
  readonly effectivePluginSkills: readonly {
    readonly pluginName: string;
    readonly name: string;
  }[];
  readonly finalTools: readonly RuntimeTool[];
  readonly plan: McpDisclosurePlan;
}): PluginCapabilityAttributionIndex {
  const plugins = new Map(
    input.capabilities.plugins.map((plugin) => [normalizedName(plugin.name), plugin]),
  );
  const finalTools = new Set(input.finalTools);
  const directTools = new Map<string, IPluginCapabilityProvenance[]>();
  const deferredTools = new Map<string, IPluginCapabilityProvenance[]>();
  for (const binding of input.capabilities.runtimeToolBindings) {
    const toolName = binding.tool.def.name;
    const owners = bindingOwners(binding, plugins, input.capabilities.plugins);
    if (owners.length === 0) continue;
    const capabilityType =
      binding.kind === 'mcp' ? PluginCapabilityType.MCP : PluginCapabilityType.APP;
    const values = owners.map((plugin) => provenance(plugin, capabilityType, toolName));
    if (finalTools.has(binding.tool)) appendProvenances(directTools, toolName, values);
    if (input.plan.deferred && input.plan.deferredRegistry.get(toolName) === binding.tool) {
      appendProvenances(deferredTools, toolName, values);
    }
  }
  const skills = new Map<string, IPluginCapabilityProvenance[]>();
  for (const skill of input.effectivePluginSkills) {
    const plugin = plugins.get(normalizedName(skill.pluginName));
    if (!plugin) continue;
    appendProvenances(skills, normalizedPluginSkillAttributionKey(skill.name), [
      provenance(plugin, PluginCapabilityType.SKILL, skill.name),
    ]);
  }
  return { directTools, deferredTools, skills };
}

function bindingOwners(
  binding: AgentHostTurnCapabilityView['runtimeToolBindings'][number],
  plugins: ReadonlyMap<string, AgentHostTurnCapabilityView['plugins'][number]>,
  allPlugins: AgentHostTurnCapabilityView['plugins'],
): readonly AgentHostTurnCapabilityView['plugins'][number][] {
  if (binding.kind === 'mcp') {
    if (!binding.pluginName) return [];
    const plugin = plugins.get(normalizedName(binding.pluginName));
    return plugin ? [plugin] : [];
  }
  return selectPreferredAppPluginOwners(
    binding.source,
    allPlugins.filter((plugin) => plugin.appProviders.includes(binding.source)),
  );
}

function provenance(
  plugin: AgentHostTurnCapabilityView['plugins'][number],
  capabilityType: PluginCapabilityType,
  capabilityName: string,
): IPluginCapabilityProvenance {
  return {
    plugin_name: plugin.name,
    ...(plugin.version ? { plugin_version: plugin.version } : {}),
    source:
      plugin.source === 'official' ? InstalledPluginSource.OFFICIAL : InstalledPluginSource.LOCAL,
    capability_type: capabilityType,
    capability_name: capabilityName,
    ...(plugin.iconUrl ? { icon_url: plugin.iconUrl } : {}),
    ...(plugin.darkIconUrl ? { dark_icon_url: plugin.darkIconUrl } : {}),
  };
}

function appendProvenances(
  target: Map<string, IPluginCapabilityProvenance[]>,
  key: string,
  values: readonly IPluginCapabilityProvenance[],
): void {
  target.set(key, [...(target.get(key) ?? []), ...values]);
}

function mergeTools(
  input: MergeAgentHostTurnCapabilitiesInput,
): Pick<MergedAgentHostTurnCapabilities, 'tools' | 'plan'> {
  const capabilities = input.capabilities;
  const preparedHost = input.hostCapabilityRegistry?.prepare({
    tools: input.tools,
    bindings: capabilities?.hostBindings ?? [],
    surface: input.surface ?? 'interactive',
    availableSkillRuntimeNames: new Set(input.effectivePluginSkills.map((skill) => skill.name)),
  });
  const hostReferences =
    preparedHost?.referenceRegistry ?? new Map<string, HostCapabilityReferenceTarget>();
  const hostTools = preparedHost?.publicTools ?? input.tools;
  const tools = withHostSkillContracts(
    replaceMcpInvoke(hostTools, input.plan, hostReferences),
    hostReferences,
  );
  if (!capabilities) return { tools, plan: input.plan };
  const bindingByTool = new Map(
    capabilities.runtimeToolBindings.map((binding) => [binding.tool, binding]),
  );
  const usedNames = new Set(tools.map((tool) => toolNameKey(tool.def.name)));
  if (input.plan.deferred) {
    for (const name of input.plan.deferredRegistry.keys()) usedNames.add(toolNameKey(name));
  }
  const selected = capabilities.runtimeTools.reduce<{
    readonly inline: RuntimeTool[];
    readonly searchable: RuntimeTool[];
  }>(
    (result, tool) => {
      const binding = bindingByTool.get(tool);
      const mode = binding?.kind === 'app' ? normalizeToolMode(binding.toolMode) : 'inline';
      const name = toolNameKey(tool.def.name);
      if (mode === 'omit' || !name || usedNames.has(name)) return result;
      usedNames.add(name);
      (mode === 'tool_search' ? result.searchable : result.inline).push(tool);
      return result;
    },
    { inline: [], searchable: [] },
  );
  if (selected.searchable.length === 0) {
    return { tools: [...tools, ...selected.inline], plan: input.plan };
  }
  return mergeSearchableTools({ ...input, tools }, selected, hostReferences);
}

function replaceMcpInvoke(
  tools: readonly RuntimeTool[],
  plan: McpDisclosurePlan,
  hostReferences: ReadonlyMap<string, McpInvokeReferenceTarget>,
): readonly RuntimeTool[] {
  const invoke = createMcpInvokeTool(
    plan.deferred ? plan.deferredRegistry : new Map(),
    hostReferences,
  );
  const hasInvoke = tools.some((tool) => tool.def.name === 'mcp_invoke');
  if (!hasInvoke && hostReferences.size === 0) return tools;
  let replaced = false;
  const result = tools.map((tool) => {
    if (tool.def.name !== 'mcp_invoke') return tool;
    replaced = true;
    return invoke;
  });
  return replaced ? result : [...result, invoke];
}

function mergeSearchableTools(
  input: MergeAgentHostTurnCapabilitiesInput,
  selected: {
    readonly inline: readonly RuntimeTool[];
    readonly searchable: readonly RuntimeTool[];
  },
  hostReferences: ReadonlyMap<string, McpInvokeReferenceTarget>,
): Pick<MergedAgentHostTurnCapabilities, 'tools' | 'plan'> {
  const deferredRegistry = new Map<string, RuntimeTool>(
    input.plan.deferred ? input.plan.deferredRegistry : [],
  );
  for (const tool of selected.searchable) deferredRegistry.set(tool.def.name, tool);
  const index = buildOrReuseIndex(
    [...deferredRegistry.values()].map((tool) => ({
      tool,
      source: 'configured' as const,
    })),
    { maxSchemaTextLen: input.options.maxSchemaTextLen },
  );
  const estimate = input.options.estimateTokens ?? estimateToolTokens;
  const forcedEstimate = selected.searchable.reduce((total, tool) => total + estimate(tool.def), 0);
  const plan: McpDisclosurePlan = {
    deferred: true,
    inlineTools: input.plan.inlineTools,
    deferredRegistry,
    index,
    stats: {
      candidateCount:
        (input.plan.deferred ? input.plan.stats.candidateCount : 0) + selected.searchable.length,
      indexedCount: index.size,
      estTokens: (input.plan.deferred ? input.plan.stats.estTokens : 0) + forcedEstimate,
      thresholdTokens: input.plan.deferred
        ? input.plan.stats.thresholdTokens
        : input.options.thresholdPct * input.model.contextWindow,
    },
  };
  const baseTools = input.tools.filter(
    (tool) => tool.def.name !== 'tool_search' && tool.def.name !== 'mcp_invoke',
  );
  return {
    tools: [
      ...baseTools,
      createToolSearchTool(index, {
        topKDefault: input.options.topKDefault,
        topKMax: input.options.topKMax,
      }),
      createMcpInvokeTool(deferredRegistry, hostReferences),
      ...selected.inline,
    ],
    plan,
  };
}

function buildCapabilityInventory(input: {
  readonly capabilities: AgentHostTurnCapabilityView;
  readonly effectivePluginSkills: readonly {
    readonly pluginName: string;
    readonly name: string;
  }[];
  readonly finalTools: readonly RuntimeTool[];
  readonly deferredToolNames: ReadonlySet<string>;
}): EffectivePluginCapabilityInventory[] {
  const finalTools = new Set(input.finalTools);
  const searchableToolsAvailable =
    input.finalTools.some((tool) => tool.def.name === 'tool_search') &&
    input.finalTools.some((tool) => tool.def.name === 'mcp_invoke');
  return input.capabilities.plugins.map((plugin) => ({
    name: plugin.name,
    pluginId: buildPluginId(plugin.name, plugin.source),
    appTools: plugin.appProviders.flatMap((provider) => {
      const bindings = input.capabilities.runtimeToolBindings.filter(
        (binding) => binding.kind === 'app' && binding.source === provider,
      );
      const direct = bindings.flatMap((binding) =>
        binding.toolMode !== 'tool_search' &&
        binding.toolMode !== 'omit' &&
        finalTools.has(binding.tool)
          ? [binding.tool.def.name]
          : [],
      );
      const searchable = searchableToolsAvailable
        ? bindings.flatMap((binding) =>
            binding.toolMode === 'tool_search' && input.deferredToolNames.has(binding.tool.def.name)
              ? [binding.tool.def.name]
              : [],
          )
        : [];
      return [
        ...(direct.length > 0 ? [{ source: provider, tools: direct }] : []),
        ...(searchable.length > 0
          ? [
              {
                source: provider,
                tools: searchable,
                access: 'tool_search' as const,
              },
            ]
          : []),
      ];
    }),
    mcpTools: [
      ...groupMcpTools(
        input.capabilities.runtimeToolBindings.filter(
          (binding) =>
            binding.kind === 'mcp' &&
            binding.pluginName === plugin.name &&
            finalTools.has(binding.tool),
        ),
      ),
      ...(searchableToolsAvailable
        ? groupMcpTools(
            input.capabilities.runtimeToolBindings.filter(
              (binding) =>
                binding.kind === 'mcp' &&
                binding.pluginName === plugin.name &&
                !finalTools.has(binding.tool) &&
                input.deferredToolNames.has(binding.tool.def.name),
            ),
          ).map((group) => ({ ...group, access: 'tool_search' as const }))
        : []),
    ],
    skills: input.effectivePluginSkills.flatMap((skill) =>
      skill.pluginName === plugin.name ? [skill.name] : [],
    ),
  }));
}

function groupMcpTools(
  bindings: readonly AgentHostTurnCapabilityView['runtimeToolBindings'][number][],
): EffectivePluginCapabilityInventory['mcpTools'] {
  const grouped = bindings.reduce<Map<string, string[]>>((result, binding) => {
    const tools = result.get(binding.source) ?? [];
    tools.push(binding.tool.def.name);
    result.set(binding.source, tools);
    return result;
  }, new Map());
  return [...grouped].map(([source, tools]) => ({ source, tools }));
}

function normalizeToolMode(value: unknown): 'omit' | 'inline' | 'tool_search' {
  return value === 'omit' || value === 'tool_search' ? value : 'inline';
}

function estimateToolTokens(definition: RuntimeTool['def']): number {
  return Math.ceil(
    JSON.stringify({
      name: definition.name,
      description: definition.description,
      schema: definition.schema,
    }).length / 4,
  );
}

/** MCP names are case-sensitive; retain existing precedence for other tools. */
function toolNameKey(name: string): string {
  return name.startsWith('mcp__') ? name : normalizedName(name);
}

function normalizedName(name: string): string {
  return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
