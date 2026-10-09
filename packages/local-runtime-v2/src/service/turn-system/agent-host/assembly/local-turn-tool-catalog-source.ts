import type { RuntimeTool } from '@mavis/agent-core/tools';
import type { ModelContextAssemblyCtx } from '@mavis/agent-runtime';
import type { IModelCapabilities } from '@mavis/protocol';
import {
  GOAL_VERIFIER_OFFLINE_TOOL_NAMES,
  GOAL_VERIFIER_READONLY_PROFILE,
  type ResolvedAgentCapabilities,
} from '@mavis/config';
import type { LocalTurnAgentProfileFacts } from './local-turn-tool-catalog.js';
import type { AgentHostTurnCapabilityView } from './turn-capability-lifecycle.js';

export interface LocalTurnToolCatalogSource {
  build(input: LocalTurnToolCatalogBuildInput): Promise<{
    readonly tools: readonly RuntimeTool[];
    readonly userPromptPrefix: string;
  }>;
}

export interface LocalTurnToolCatalogBuildInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly resourceAgentName: string;
  readonly builtinCapabilities?: ResolvedAgentCapabilities;
  readonly cuModeActive: boolean;
  readonly workspaceDir: string;
  readonly llmModel: {
    readonly provider: string;
    readonly id: string;
    readonly contextWindow: number;
  };
  readonly modelCapabilities?: IModelCapabilities;
  readonly effectivePluginSkills: readonly {
    readonly pluginName: string;
    readonly name: string;
  }[];
  readonly userText?: string;
  readonly agentProfile?: LocalTurnAgentProfileFacts;
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  /** Tool names this Turn must not receive from any source. */
  readonly withheldToolNames?: readonly string[];
}

export function createLocalTurnToolCatalogInput(
  context: ModelContextAssemblyCtx,
  desktopCapabilities?: AgentHostTurnCapabilityView,
): LocalTurnToolCatalogBuildInput {
  const modelCapabilities = readModelCapabilities(context.model);
  const builtinCapabilities = readBuiltinCapabilities(context.agentConfig);
  const agentProfile = readAgentProfile(context.agentConfig);
  const withheldToolNames = readWithheldToolNames(context.turnIntent);
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    agentName: context.agentName,
    resourceAgentName: readString(context.agentConfig, 'resourceAgentName') ?? context.agentName,
    ...(builtinCapabilities ? { builtinCapabilities } : {}),
    cuModeActive: context.agentConfig.cuModeActive === true,
    workspaceDir: context.workspaceDir,
    llmModel: readResolvedModel(context.model),
    effectivePluginSkills: readEffectivePluginSkills(context.agentConfig),
    ...(context.userInput ? { userText: context.userInput.text } : {}),
    ...(modelCapabilities ? { modelCapabilities } : {}),
    ...(agentProfile ? { agentProfile } : {}),
    ...(desktopCapabilities ? { desktopCapabilities } : {}),
    ...(withheldToolNames ? { withheldToolNames } : {}),
  };
}

/**
 * The Goal verifier child is an ordinary `verifier` delegation, and that role
 * holds `web_fetch` and `web_search`. Goal verification runs offline, so the
 * child's Turn is assembled without them rather than offered tools that its
 * runtime guard would then refuse.
 */
function readWithheldToolNames(
  intent: ModelContextAssemblyCtx['turnIntent'],
): readonly string[] | undefined {
  return intent?.kind === 'goal-verifier' &&
    intent.attributes?.profile === GOAL_VERIFIER_READONLY_PROFILE
    ? GOAL_VERIFIER_OFFLINE_TOOL_NAMES
    : undefined;
}

function readEffectivePluginSkills(
  agentConfig: Readonly<Record<string, unknown>>,
): readonly { readonly pluginName: string; readonly name: string }[] {
  const value = agentConfig.desktopPluginSkills;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const pluginName = Reflect.get(entry, 'pluginName');
    const name = Reflect.get(entry, 'name');
    return typeof pluginName === 'string' && typeof name === 'string' ? [{ pluginName, name }] : [];
  });
}

function readBuiltinCapabilities(
  agentConfig: Readonly<Record<string, unknown>>,
): ResolvedAgentCapabilities | undefined {
  const value = agentConfig.builtinCapabilities;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ResolvedAgentCapabilities)
    : undefined;
}

function readAgentProfile(
  config: Readonly<Record<string, unknown>>,
): LocalTurnAgentProfileFacts | undefined {
  const ceiling = readRecord(config.capability_ceiling);
  const features = readRecord(ceiling.features);
  if (!hasValidCapabilityCeiling(ceiling, features)) return undefined;
  const profile = readRecord(config.agent_profile);
  const { trustedBuiltin, canonicalViewName } = readTrustedBuiltinAgentProfileIdentity(profile);
  const configSelection = readConfigSelection(profile);
  return {
    capabilityCeiling: toCapabilityCeiling(ceiling, features),
    ...agentProfileResourceFacts(profile),
    ...agentProfileIdentityFacts(profile, canonicalViewName, trustedBuiltin),
    trustedBuiltin,
    ...agentProfileMemoryFacts(profile),
    ...(configSelection ? { configSelection } : {}),
  };
}

function agentProfileResourceFacts(
  profile: Readonly<Record<string, unknown>>,
): Pick<
  LocalTurnAgentProfileFacts,
  'excludeAgentResources' | 'skipAgentResolution' | 'expectedAgentInstanceId'
> {
  const expectedAgentInstanceId = readString(profile, 'expected_agent_instance_id');
  return {
    ...(profile.exclude_agent_resources === true ? { excludeAgentResources: true } : {}),
    ...(profile.skip_agent_resolution === true ? { skipAgentResolution: true } : {}),
    ...(expectedAgentInstanceId ? { expectedAgentInstanceId } : {}),
  };
}

function agentProfileIdentityFacts(
  profile: Readonly<Record<string, unknown>>,
  canonicalViewName: string | undefined,
  trustedBuiltin: boolean,
): Pick<LocalTurnAgentProfileFacts, 'canonicalRole' | 'surface'> {
  let surface: LocalTurnAgentProfileFacts['surface'] = 'interactive';
  if (profile.surface === 'task-child') surface = 'task-child';
  else if (profile.surface === 'cli') surface = 'cli';
  return {
    ...(canonicalViewName && trustedBuiltin ? { canonicalRole: canonicalViewName } : {}),
    surface,
  };
}

function agentProfileMemoryFacts(
  profile: Readonly<Record<string, unknown>>,
): Pick<LocalTurnAgentProfileFacts, 'agentMemoryEnabled' | 'agentMemoryReadNames'> {
  const agentMemoryReadNames = readStringArray(profile, 'memory_read_agent_names');
  return {
    ...(typeof profile.memory_agent_scope_enabled === 'boolean'
      ? { agentMemoryEnabled: profile.memory_agent_scope_enabled }
      : {}),
    ...(agentMemoryReadNames ? { agentMemoryReadNames } : {}),
  };
}

function readConfigSelection(
  profile: Readonly<Record<string, unknown>>,
): NonNullable<LocalTurnAgentProfileFacts['configSelection']> | undefined {
  const source = readRecord(profile.config_selection);
  const selection = {
    ...optionalStringArray(source, 'tools'),
    ...optionalStringArray(source, 'disallowedTools'),
    ...optionalStringArray(source, 'mcpServers'),
    ...optionalStringArray(source, 'skills'),
    ...optionalStringArray(source, 'extensionSkills'),
  };
  return Object.keys(selection).length > 0 ? selection : undefined;
}

function optionalStringArray(
  record: Readonly<Record<string, unknown>>,
  key: 'tools' | 'disallowedTools' | 'mcpServers' | 'skills' | 'extensionSkills',
): Partial<NonNullable<LocalTurnAgentProfileFacts['configSelection']>> {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return {};
  return { [key]: value.map((entry) => entry.trim()).filter(Boolean) };
}

function readStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value.map((entry) => entry.trim()).filter(Boolean)
    : undefined;
}

function hasValidCapabilityCeiling(
  ceiling: Readonly<Record<string, unknown>>,
  features: Readonly<Record<string, unknown>>,
): boolean {
  return (
    typeof ceiling.personaEnabled === 'boolean' &&
    typeof features.mavis === 'boolean' &&
    typeof features.delegation === 'boolean' &&
    typeof features.webSearch === 'boolean'
  );
}

export function readTrustedBuiltinAgentProfileIdentity(value: unknown): {
  readonly trustedBuiltin: boolean;
  readonly canonicalViewName?: string;
} {
  const profile = readRecord(value);
  const canonicalViewName = readString(profile, 'canonical_view_name');
  return {
    trustedBuiltin:
      typeof profile.trusted_builtin === 'boolean'
        ? profile.trusted_builtin
        : profile.creation_source === 'builtin' &&
          (profile.provenance_source === 'builtin' ||
            profile.provenance_source === 'legacy-read-through'),
    ...(canonicalViewName ? { canonicalViewName } : {}),
  };
}

function toCapabilityCeiling(
  ceiling: Readonly<Record<string, unknown>>,
  features: Readonly<Record<string, unknown>>,
): LocalTurnAgentProfileFacts['capabilityCeiling'] {
  return {
    personaEnabled: ceiling.personaEnabled as boolean,
    ...(Array.isArray(ceiling.tools) ? { tools: ceiling.tools as never } : {}),
    ...(Array.isArray(ceiling.builtinTools) ? { builtinTools: ceiling.builtinTools as never } : {}),
    ...(Array.isArray(ceiling.skills) ? { skills: ceiling.skills as never } : {}),
    features: {
      mavis: features.mavis as boolean,
      delegation: features.delegation as boolean,
      webSearch: features.webSearch as boolean,
    },
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function readResolvedModel(model: Readonly<Record<string, unknown>>): {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
} {
  const provider = readString(model, 'provider');
  const id = readString(model, 'model_id', 'modelId', 'id');
  const contextWindow = readPositiveNumber(model, 'context_window', 'contextWindow');
  if (!provider || !id || !contextWindow) {
    throw new Error(
      'Local tool assembly requires a resolved provider, model id, and context window.',
    );
  }
  return { provider, id, contextWindow };
}

function readModelCapabilities(
  model: Readonly<Record<string, unknown>>,
): IModelCapabilities | undefined {
  const value = model.capabilities;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as IModelCapabilities)
    : undefined;
}

function readString(
  record: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): string | undefined {
  return keys
    .map((key) => record[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}

function readPositiveNumber(
  record: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): number | undefined {
  return keys
    .map((key) => record[key])
    .find((value): value is number => typeof value === 'number' && value > 0);
}
