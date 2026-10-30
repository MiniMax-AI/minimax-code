import type { ConversationPluginAgentDefinition } from '@mavis/conversation-contract';
import { resolvePluginDataDirectory } from '@mavis/plugin-hooks';
import type { AgentExecutionProfile, LocalAgentService } from '../../service/agent/index.js';

type ProfileRequest = Parameters<LocalAgentService['renderFrozenProfile']>[0];
type FrozenAgentDefinition = Parameters<LocalAgentService['renderFrozenProfile']>[1];

const PLUGIN_ROOT_PLACEHOLDERS = new Set([
  'MINIMAX_PLUGIN_ROOT',
  '\u0043LAUDE_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'PLUGIN_ROOT',
]);
const PLUGIN_DATA_PLACEHOLDERS = new Set(['\u0043LAUDE_PLUGIN_DATA', 'PLUGIN_DATA']);

/** Durable Plugin identity kept beside the frozen Task definition. */
export interface CapturedPluginAgentSource {
  readonly kind: 'plugin';
  readonly pluginName: string;
  readonly format: ConversationPluginAgentDefinition['sourceFormat'];
  readonly agentName: string;
  readonly scopedName: string;
  readonly packageDigest: string;
  readonly origin?: NonNullable<ConversationPluginAgentDefinition['origin']>;
}

/**
 * Renders a Plugin Agent as a worker-role Task child. The Markdown body plays
 * the Custom Agent prompt role; shared Runtime layers stay owned by the host.
 */
export async function renderPluginAgentProfile(input: {
  readonly agentService: LocalAgentService;
  readonly agent: ConversationPluginAgentDefinition;
  readonly request: Omit<ProfileRequest, 'exactOwnerName' | 'requestRef' | 'surface'>;
}): Promise<AgentExecutionProfile> {
  const { agent } = input;
  const definition: FrozenAgentDefinition = {
    systemPrompt: expandPluginAgentPlaceholders(agent),
    capabilities: pluginAgentSelectors(agent),
  };
  const profile = await input.agentService.renderFrozenProfile(
    {
      ...input.request,
      exactOwnerName: agent.scopedName,
      requestRef: agent.scopedName,
      surface: 'task-child',
    },
    definition,
  );
  return {
    ...profile,
    configSelection: { ...profile.configSelection, ...pluginAgentModelSelection(agent) },
  };
}

export function pluginAgentSource(
  agent: ConversationPluginAgentDefinition,
): CapturedPluginAgentSource {
  return {
    kind: 'plugin',
    pluginName: agent.pluginName,
    format: agent.sourceFormat,
    agentName: agent.agentName,
    scopedName: agent.scopedName,
    packageDigest: agent.packageDigest,
    ...(agent.origin ? { origin: agent.origin } : {}),
  };
}

/** @internal Exported only for focused placeholder tests. */
export function expandPluginAgentPlaceholders(agent: ConversationPluginAgentDefinition): string {
  const pluginData = resolvePluginDataDirectory(agent.pluginRoot, agent.pluginName);
  return agent.systemPrompt.replace(/\$\{([A-Z][A-Z0-9_]*)\}/gu, (placeholder, name: string) => {
    if (PLUGIN_ROOT_PLACEHOLDERS.has(name)) return agent.pluginRoot;
    if (PLUGIN_DATA_PLACEHOLDERS.has(name)) return pluginData;
    return placeholder;
  });
}

function pluginAgentSelectors(
  agent: ConversationPluginAgentDefinition,
): FrozenAgentDefinition['capabilities'] {
  return {
    ...(agent.tools ? { tools: [...agent.tools] } : {}),
    ...(agent.disallowedTools ? { disallowedTools: [...agent.disallowedTools] } : {}),
    ...(agent.mcpServers ? { mcpServers: [...agent.mcpServers] } : {}),
    ...(agent.skills ? { skills: [...agent.skills] } : {}),
    ...(agent.extensionSkills ? { extensionSkills: [...agent.extensionSkills] } : {}),
  };
}

/** Structural view of a published Plugin runtime tool binding. */
export interface PluginAgentToolBinding {
  readonly kind: string;
  readonly source: string;
  readonly pluginName?: string;
  readonly mcpToolName?: string;
  readonly tool: { readonly def: { readonly name: string } };
}

const COMPATIBLE_FORMAT = '\u0063\u006c\u0061\u0075\u0064\u0065';
const MCP_PREFIX = 'mcp__';

/**
 * Compatible Agents address their own Plugin MCP tools as
 * `mcp__<server>__<tool>`, but runtime aliases are allocated per Turn and can
 * differ on a name collision. Selectors naming a server this Plugin declares
 * resolve only to this Plugin's aliases for the Turn, and match nothing when
 * that server published no tools; other entries stay as-is.
 *
 * Server names may contain `__`, so selectors are compared with each binding's
 * whole raw name instead of being split. Runtime selectors are
 * case-insensitive while MCP aliases are not, so an alias that differs from
 * another owner's tool only by case is left out of the allowlist.
 */
export function bindPluginAgentMcpSelectors(
  profile: AgentExecutionProfile,
  agent: ConversationPluginAgentDefinition | undefined,
  bindings: readonly PluginAgentToolBinding[],
  inventoryToolNames: readonly string[],
): AgentExecutionProfile {
  const selection = profile.configSelection;
  if (agent?.sourceFormat !== COMPATIBLE_FORMAT || !selection) return profile;
  const pluginKey = selectorKey(agent.pluginName);
  const own = bindings.filter(
    (binding) =>
      binding.kind === 'mcp' &&
      binding.pluginName !== undefined &&
      selectorKey(binding.pluginName) === pluginKey,
  );
  const ownServers = [
    ...new Set(
      [...(agent.declaredMcpServers ?? []), ...own.map((binding) => binding.source)].map(
        selectorKey,
      ),
    ),
  ];
  if (ownServers.length === 0) return profile;
  const ownAliases = new Set(own.map((binding) => binding.tool.def.name));
  const foreignKeys = new Set(
    inventoryToolNames.filter((name) => !ownAliases.has(name)).map(selectorKey),
  );
  const rebind = (names: readonly string[] | undefined, allowlist: boolean) =>
    names === undefined
      ? undefined
      : [
          ...new Set(
            names.flatMap((name) => {
              const aliases = rebindMcpSelector(name, ownServers, own);
              if (!aliases) return [name];
              return allowlist
                ? aliases.filter((alias) => !foreignKeys.has(selectorKey(alias)))
                : aliases;
            }),
          ),
        ];
  const tools = rebind(selection.tools, true);
  const disallowedTools = rebind(selection.disallowedTools, false);
  return {
    ...profile,
    configSelection: {
      ...selection,
      ...(tools ? { tools } : {}),
      ...(disallowedTools ? { disallowedTools } : {}),
    },
  };
}

/** Returns this Plugin's aliases for `name`, or `undefined` when another owner may own it. */
function rebindMcpSelector(
  name: string,
  ownServers: readonly string[],
  own: readonly PluginAgentToolBinding[],
): string[] | undefined {
  const key = selectorKey(name);
  if (!key.startsWith(MCP_PREFIX)) return undefined;
  const aliases = own
    .filter(
      (binding) =>
        binding.mcpToolName !== undefined &&
        selectorKey(`${MCP_PREFIX}${binding.source}__${binding.mcpToolName}`) === key,
    )
    .map((binding) => binding.tool.def.name);
  if (aliases.length > 0) return aliases;
  const claimed = ownServers.some((server) => {
    const prefix = `${MCP_PREFIX}${server}__`;
    return key.startsWith(prefix) && key.length > prefix.length;
  });
  return claimed ? [] : undefined;
}

function selectorKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function pluginAgentModelSelection(
  agent: ConversationPluginAgentDefinition,
): NonNullable<AgentExecutionProfile['configSelection']> {
  return {
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
    ...(agent.contextWindow === undefined ? {} : { contextWindow: agent.contextWindow }),
    ...(agent.maxOutputTokens === undefined ? {} : { maxOutputTokens: agent.maxOutputTokens }),
  };
}
