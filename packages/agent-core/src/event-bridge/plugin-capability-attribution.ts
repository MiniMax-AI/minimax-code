import { InstalledPluginSource, type IPluginCapabilityProvenance } from '@mavis/protocol';
import { parseAppCliToolName } from './app-cli-command.js';
import type {
  RuntimeTool,
  ToolCallProvenanceResolutionInput,
  ToolCallProvenanceResolver,
} from '../tools/types.js';

export interface PluginCapabilityAttributionIndex {
  /** Direct runtime tool name -> Plugin owners. */
  readonly directTools: ReadonlyMap<string, readonly IPluginCapabilityProvenance[]>;
  /** Deferred target runtime tool name -> Plugin owners used through mcp_invoke. */
  readonly deferredTools: ReadonlyMap<string, readonly IPluginCapabilityProvenance[]>;
  /** Canonical Plugin Skill name -> Plugin owner. */
  readonly skills: ReadonlyMap<string, readonly IPluginCapabilityProvenance[]>;
  /** App owners from the captured Plugin manifest; independent of remote discovery. */
  readonly appProviders?: ReadonlyMap<string, readonly IPluginCapabilityProvenance[]>;
}

/**
 * Build the host-independent resolver over a turn-local immutable attribution
 * index. Hosts own the index; this resolves direct tools and supported access tools.
 */
export function createPluginCapabilityAttributionResolver(
  index: PluginCapabilityAttributionIndex,
): ToolCallProvenanceResolver {
  return (input) => resolvePluginCapabilityAttribution(index, input);
}

/** Attach one immutable attribution index to only the tools it can resolve. */
export function attachPluginCapabilityAttribution<TTool extends RuntimeTool>(
  tools: readonly TTool[],
  index: PluginCapabilityAttributionIndex,
): TTool[] {
  const resolver = createPluginCapabilityAttributionResolver(index);
  return tools.map((tool) => {
    const name = tool.def.name;
    const relevant =
      index.directTools.has(name) ||
      (name === 'mcp_invoke' && index.deferredTools.size > 0) ||
      (name === 'skill' && index.skills.size > 0) ||
      (name === 'bash' && (index.appProviders?.size ?? 0) > 0);
    return relevant ? ({ ...tool, toolCallProvenanceResolver: resolver } as TTool) : tool;
  });
}

function resolvePluginCapabilityAttribution(
  index: PluginCapabilityAttributionIndex,
  input: ToolCallProvenanceResolutionInput,
): readonly IPluginCapabilityProvenance[] | undefined {
  if (input.toolName === 'tool_search') return undefined;
  if (input.toolName === 'bash') {
    const toolName = parseAppCliToolName(input.args?.command);
    if (!toolName) return undefined;
    // The provider must belong to this turn's Plugin snapshot. No remote discovery.
    const matches = [...(index.appProviders ?? [])].filter(([provider]) => {
      const prefix = `connector__${provider}__`;
      const suffix = toolName.slice(prefix.length);
      return toolName.startsWith(prefix) && /^[A-Za-z0-9_.-]{1,96}$/.test(suffix);
    });
    // A local provider that prefixes or extends an official one must not erase the official
    // attribution by making the match ambiguous.
    const resolved =
      matches.length > 1
        ? matches.filter(([, owners]) =>
            owners.some((owner) => owner.source === InstalledPluginSource.OFFICIAL),
          )
        : matches;
    if (resolved.length !== 1) return undefined;
    return resolved[0]?.[1].map((owner) => ({
      ...owner,
      capability_name: toolName,
    }));
  }
  if (input.toolName === 'mcp_invoke') {
    const target = optionalString(input.args?.tool_name);
    return target ? copy(index.deferredTools.get(target)) : undefined;
  }
  if (input.toolName === 'skill') {
    if (input.phase !== 'end' || input.isError === true || !isSuccessfulPluginSkill(input.result)) {
      return undefined;
    }
    const skillName = optionalString(input.args?.name);
    return skillName ? copy(index.skills.get(normalizedSkillName(skillName))) : undefined;
  }
  return copy(index.directTools.get(input.toolName));
}

export function normalizedPluginSkillAttributionKey(name: string): string {
  return normalizedSkillName(name);
}

/**
 * Prefer the Plugin whose canonical name matches the App provider. A matching
 * Plugin is the App's primary brand owner; when no such owner exists, retain
 * every effective Plugin that declares the App.
 */
export function selectPreferredAppPluginOwners<TPlugin extends { readonly name: string }>(
  provider: string,
  owners: readonly TPlugin[],
): readonly TPlugin[] {
  const normalizedProvider = normalizedName(provider);
  const preferred = owners.filter((plugin) => normalizedName(plugin.name) === normalizedProvider);
  return preferred.length > 0 ? preferred : owners;
}

function isSuccessfulPluginSkill(result: unknown): boolean {
  if (!isRecord(result) || !isRecord(result.details)) return false;
  return (
    (result.details.source === 'plugin' || result.details.source === 'desktop-plugin') &&
    result.details.found === true &&
    result.details.readable === true
  );
}

function normalizedSkillName(name: string): string {
  return normalizedName(name);
}

function normalizedName(name: string): string {
  return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function copy(
  value: readonly IPluginCapabilityProvenance[] | undefined,
): IPluginCapabilityProvenance[] | undefined {
  return value?.length ? value.map((item) => ({ ...item })) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
