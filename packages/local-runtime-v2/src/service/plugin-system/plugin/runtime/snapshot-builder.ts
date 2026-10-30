import path from 'node:path';

import type {
  AgentHostTurnCapabilityView as DesktopTurnCapabilityView,
  AgentHostTurnPluginAgent as DesktopTurnPluginAgent,
  AgentHostTurnRuntimeToolBinding as DesktopTurnRuntimeToolBinding,
} from '../../../turn-system/index.js';
import type { AgentHostTurnHostBinding as DesktopTurnHostBinding } from '../../../turn-system/agent-host/assembly/turn-capability-lifecycle.js';
import { McpNameRegistry, configuredMcpNameKey, pluginMcpNameKey } from '@mavis/mcp';
import { buildPluginSkillRuntimeName } from '@mavis/shared';

import type {
  PluginAgent,
  PluginMcpServer,
  PluginSkill,
  ReadPluginPackage,
  RuntimeEligibleScannedReadPluginPackage,
} from '../package/types.js';

interface OfficialSnapshotPackageInput {
  readonly plugin: RuntimeEligibleScannedReadPluginPackage;
  readonly contentDigest: string;
}

interface LocalSnapshotPackageInput {
  readonly plugin: RuntimeEligibleScannedReadPluginPackage;
  readonly contentDigest: string;
}

export interface PluginCapabilityReservations {
  readonly skillNames: readonly string[];
  readonly mcpServerNames: readonly string[];
  readonly toolNames: readonly string[];
}

export interface PluginSnapshotDiagnostic {
  readonly code: string;
  readonly pluginName: string;
  readonly capabilityName?: string;
}

interface PluginSnapshotPackageIdentity {
  readonly name: string;
  readonly version?: string;
  readonly rootPath: string;
  readonly contentDigest: string;
  readonly plugin?: RuntimeEligibleScannedReadPluginPackage;
}

interface PluginSnapshotLocalProjection {
  readonly name: string;
  readonly displayName?: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: string;
  readonly iconPath?: string;
  readonly darkIconPath?: string;
  readonly rootPath: string;
  readonly contentDigest: string;
  readonly source: ReadPluginPackage['source'];
  readonly enabled: boolean;
  readonly plugin: RuntimeEligibleScannedReadPluginPackage;
}

interface PluginSnapshotEnabledProjection {
  readonly name: string;
  readonly displayName?: string;
  readonly version?: string;
  readonly iconPath?: string;
  readonly darkIconPath?: string;
  readonly source: ReadPluginPackage['source'];
  readonly appProviders: readonly string[];
}

export interface PluginSnapshotMcpServer {
  readonly pluginName: string;
  readonly source: ReadPluginPackage['source'];
  readonly packageContentDigest: string;
  readonly server: PluginMcpServer;
  readonly runtimeServerName?: string;
  readonly managedIdentity?: {
    readonly kind: 'miniapp';
    readonly endpointId: string;
    readonly miniAppGeneration: string;
    readonly processGeneration: string;
  };
}

export interface PluginSnapshot {
  readonly revision: string;
  readonly officialPackages: readonly PluginSnapshotPackageIdentity[];
  readonly localPlugins: readonly PluginSnapshotLocalProjection[];
  readonly enabledPlugins: readonly PluginSnapshotEnabledProjection[];
  readonly skills: readonly PluginSkill[];
  readonly mcpServers: readonly PluginSnapshotMcpServer[];
  readonly diagnostics: readonly PluginSnapshotDiagnostic[];
  readonly turnCapabilities: DesktopTurnCapabilityView;
}

export interface BuildPluginSnapshotInput {
  readonly revision: string;
  readonly officialPackages: readonly OfficialSnapshotPackageInput[];
  readonly localPackages: readonly LocalSnapshotPackageInput[];
  readonly isLocalEnabled: (canonicalRoot: string) => boolean;
  readonly reservations: PluginCapabilityReservations;
}

interface SnapshotBuildState {
  readonly diagnostics: PluginSnapshotDiagnostic[];
  readonly officialPackages: PluginSnapshotPackageIdentity[];
  readonly localPlugins: PluginSnapshotLocalProjection[];
  readonly enabledPlugins: PluginSnapshotEnabledProjection[];
  readonly skills: PluginSkill[];
  readonly skillOwners: Map<PluginSkill, string>;
  mcpServers: PluginSnapshotMcpServer[];
  readonly hooks: NonNullable<ReadPluginPackage['hooks']>[number][];
  readonly hostBindings: DesktopTurnHostBinding[];
  readonly agents: DesktopTurnPluginAgent[];
  readonly pluginNames: Set<string>;
  readonly skillNames: Set<string>;
}

export class PluginSnapshotBuilder {
  constructor(private readonly names = new McpNameRegistry()) {}
  build(input: BuildPluginSnapshotInput): PluginSnapshot {
    const state = createSnapshotBuildState(input.reservations);
    appendOfficialPackages(input.officialPackages, state);
    appendLocalPackages(input, state);
    const allocated = this.names.assignServers([
      ...input.reservations.mcpServerNames.map((name) => ({
        key: configuredMcpNameKey(name),
        name,
      })),
      ...state.mcpServers.map((entry) => ({
        key: pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name),
        name: entry.server.name,
      })),
    ]);
    state.mcpServers = state.mcpServers.flatMap((entry) => {
      const key = pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name);
      const runtimeServerName = allocated.names.get(key);
      if (!runtimeServerName) {
        state.diagnostics.push({
          code: 'MCP_SERVER_NAME_INVALID',
          pluginName: entry.pluginName,
          capabilityName: entry.server.name,
        });
        return [];
      }
      return [freeze({ ...entry, runtimeServerName })];
    });
    const frozenSkills = freeze(state.skills.map((skill) => freeze(skill)));
    const turnCapabilities: DesktopTurnCapabilityView = freeze({
      revision: input.revision,
      plugins: freeze(
        state.enabledPlugins.map((plugin) =>
          freeze({
            name: plugin.name,
            ...(plugin.version ? { version: plugin.version } : {}),
            source: plugin.source === 'OFFICIAL' ? 'official' : 'local',
            ...(plugin.iconPath ? { iconUrl: localIconUrl(plugin.iconPath) } : {}),
            ...(plugin.darkIconPath ? { darkIconUrl: localIconUrl(plugin.darkIconPath) } : {}),
            ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
            ...(plugin.iconPath ? { iconPath: plugin.iconPath } : {}),
            appProviders: plugin.appProviders,
          }),
        ),
      ),
      skills: freeze(
        frozenSkills.map((skill) =>
          freeze({
            pluginName: state.skillOwners.get(skill) ?? '',
            name: buildPluginSkillRuntimeName(state.skillOwners.get(skill) ?? '', skill.name),
            description: skill.description,
            content: skill.content,
            location: skill.skillFilePath,
            sourceKind: 'desktop-plugin',
          }),
        ),
      ),
      // P4B owns live Plugin MCP tool construction. P1A freezes the per-turn
      // slot now so later tools use the same snapshot as prompt and skill reads.
      runtimeTools: freeze([]),
      runtimeToolBindings: freeze([]),
      hostBindings: freeze(state.hostBindings),
      hooks: freeze([...state.hooks]),
      agents: freeze(
        [...state.agents].sort((left, right) => left.scopedName.localeCompare(right.scopedName)),
      ),
    });

    return freeze({
      revision: input.revision,
      officialPackages: freeze(state.officialPackages),
      localPlugins: freeze(state.localPlugins),
      enabledPlugins: freeze(state.enabledPlugins),
      skills: frozenSkills,
      mcpServers: freeze(state.mcpServers),
      diagnostics: freeze(state.diagnostics),
      turnCapabilities,
    });
  }
}

export function withPluginMcpRuntime(
  snapshot: PluginSnapshot,
  runtimeTools: DesktopTurnCapabilityView['runtimeTools'],
  runtimeToolBindings: readonly DesktopTurnRuntimeToolBinding[],
  diagnostics: readonly PluginSnapshotDiagnostic[],
): PluginSnapshot {
  return freeze({
    ...snapshot,
    diagnostics: freeze([...snapshot.diagnostics, ...diagnostics]),
    turnCapabilities: freeze({
      ...snapshot.turnCapabilities,
      runtimeTools: freeze([...runtimeTools]),
      runtimeToolBindings: freeze([...runtimeToolBindings]),
    }),
  });
}

export function withPluginSnapshotRevision(
  snapshot: PluginSnapshot,
  revision: string,
): PluginSnapshot {
  return freeze({
    ...snapshot,
    revision,
    turnCapabilities: freeze({ ...snapshot.turnCapabilities, revision }),
  });
}

function createSnapshotBuildState(reservations: PluginCapabilityReservations): SnapshotBuildState {
  return {
    diagnostics: [],
    officialPackages: [],
    localPlugins: [],
    enabledPlugins: [],
    skills: [],
    skillOwners: new Map(),
    mcpServers: [],
    hooks: [],
    hostBindings: [],
    agents: [],
    pluginNames: new Set(),
    skillNames: new Set(reservations.skillNames.map(normalizedSkillKey)),
  };
}

function appendOfficialPackages(
  packages: readonly OfficialSnapshotPackageInput[],
  state: SnapshotBuildState,
): void {
  const sorted = [...packages].sort(
    (left, right) =>
      collisionKey(left.plugin.name).localeCompare(collisionKey(right.plugin.name)) ||
      left.contentDigest.localeCompare(right.contentDigest),
  );
  for (const entry of sorted) {
    const accepted = acceptPackageCapabilities({
      plugin: entry.plugin,
      packageContentDigest: entry.contentDigest,
      sourceKind: 'official',
      includeRuntimeCapabilities: true,
      ...capabilityCollisionState(state),
    });
    if (!accepted) continue;
    state.officialPackages.push(
      freeze({
        name: entry.plugin.name,
        ...(entry.plugin.version ? { version: entry.plugin.version } : {}),
        rootPath: entry.plugin.rootPath,
        contentDigest: entry.contentDigest,
        ...(entry.plugin.miniapp ? { plugin: entry.plugin } : {}),
      }),
    );
    state.enabledPlugins.push(enabledProjection(entry.plugin));
    state.skills.push(...accepted.skills);
    for (const skill of accepted.skills) state.skillOwners.set(skill, entry.plugin.name);
    state.mcpServers.push(...accepted.mcpServers);
    state.hooks.push(...accepted.hooks);
    state.hostBindings.push(...accepted.hostBindings);
  }
}

function appendLocalPackages(input: BuildPluginSnapshotInput, state: SnapshotBuildState): void {
  const sorted = [...input.localPackages].sort((left, right) =>
    normalizedPath(left.plugin.rootPath).localeCompare(normalizedPath(right.plugin.rootPath)),
  );
  for (const entry of sorted) appendLocalPlugin(entry, input.isLocalEnabled, state);
}

function appendLocalPlugin(
  entry: LocalSnapshotPackageInput,
  isLocalEnabled: (canonicalRoot: string) => boolean,
  state: SnapshotBuildState,
): void {
  const { plugin } = entry;
  const enabled = isLocalEnabled(plugin.rootPath);
  if (state.pluginNames.has(collisionKey(plugin.name))) {
    state.diagnostics.push(freeze({ code: 'LOCAL_PLUGIN_NAME_CONFLICT', pluginName: plugin.name }));
    return;
  }
  const accepted = acceptPackageCapabilities({
    plugin,
    packageContentDigest: entry.contentDigest,
    sourceKind: 'local',
    includeRuntimeCapabilities: enabled,
    ...capabilityCollisionState(state),
  });
  if (!accepted) return;
  if (!hasSupportedLocalCapability(plugin)) {
    state.diagnostics.push(
      freeze({ code: 'LOCAL_PLUGIN_NO_SUPPORTED_CAPABILITY', pluginName: plugin.name }),
    );
    return;
  }
  state.localPlugins.push(localProjection(plugin, entry.contentDigest, enabled));
  if (!enabled) return;
  state.enabledPlugins.push(enabledProjection(plugin));
  state.skills.push(...accepted.skills);
  for (const skill of accepted.skills) state.skillOwners.set(skill, plugin.name);
  state.mcpServers.push(...accepted.mcpServers);
  state.hooks.push(...accepted.hooks);
  state.hostBindings.push(...accepted.hostBindings);
  state.agents.push(...accepted.agents);
}

function hasSupportedLocalCapability(plugin: RuntimeEligibleScannedReadPluginPackage): boolean {
  return (
    plugin.skills.length > 0 ||
    plugin.mcpServers.length > 0 ||
    (plugin.hooks?.length ?? 0) > 0 ||
    (plugin.agents?.length ?? 0) > 0 ||
    Boolean(plugin.miniapp)
  );
}

function localProjection(
  plugin: RuntimeEligibleScannedReadPluginPackage,
  contentDigest: string,
  enabled: boolean,
): PluginSnapshotLocalProjection {
  return freeze({
    name: plugin.name,
    ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.author ? { author: plugin.author } : {}),
    ...(plugin.iconPath ? { iconPath: plugin.iconPath } : {}),
    ...(plugin.darkIconPath ? { darkIconPath: plugin.darkIconPath } : {}),
    rootPath: plugin.rootPath,
    contentDigest,
    source: plugin.source,
    enabled,
    plugin,
  });
}

function capabilityCollisionState(state: SnapshotBuildState) {
  return {
    pluginNames: state.pluginNames,
    skillNames: state.skillNames,
    diagnostics: state.diagnostics,
  };
}

interface PackageCapabilityAcceptanceInput {
  plugin: ReadPluginPackage;
  packageContentDigest: string;
  sourceKind: 'official' | 'local';
  includeRuntimeCapabilities: boolean;
  pluginNames: Set<string>;
  skillNames: Set<string>;
  diagnostics: PluginSnapshotDiagnostic[];
}

function acceptPackageCapabilities(input: PackageCapabilityAcceptanceInput):
  | {
      skills: PluginSkill[];
      mcpServers: PluginSnapshotMcpServer[];
      hooks: NonNullable<ReadPluginPackage['hooks']>[number][];
      hostBindings: DesktopTurnHostBinding[];
      agents: DesktopTurnPluginAgent[];
    }
  | undefined {
  const { plugin } = input;
  for (const diagnostic of plugin.diagnostics) {
    input.diagnostics.push(
      freeze({
        code: diagnostic.code,
        pluginName: plugin.name,
        ...(diagnostic.name ? { capabilityName: diagnostic.name } : {}),
      }),
    );
  }
  if (!acceptPluginName(input)) return undefined;
  const pluginKey = collisionKey(plugin.name);
  input.pluginNames.add(pluginKey);
  if (!input.includeRuntimeCapabilities) {
    return { skills: [], mcpServers: [], hooks: [], hostBindings: [], agents: [] };
  }
  const skills = acceptPackageSkills(input);
  return {
    skills,
    mcpServers: acceptPackageServers(input),
    hooks: [...(plugin.hooks ?? [])],
    hostBindings: acceptHostBindings(input, skills),
    agents: input.sourceKind === 'local' ? acceptPackageAgents(input) : [],
  };
}

function acceptPackageAgents(input: PackageCapabilityAcceptanceInput): DesktopTurnPluginAgent[] {
  return (input.plugin.agents ?? []).map((agent) =>
    turnPluginAgent(input.plugin, input.packageContentDigest, agent),
  );
}

function turnPluginAgent(
  plugin: ReadPluginPackage,
  packageDigest: string,
  agent: PluginAgent,
): DesktopTurnPluginAgent {
  return freeze({
    scopedName: agent.scopedName,
    pluginName: plugin.name,
    agentName: agent.name,
    sourceFormat:
      agent.sourceFormat === 'MINIMAX' ? 'minimax' : '\u0063\u006c\u0061\u0075\u0064\u0065',
    packageDigest,
    pluginRoot: plugin.rootPath,
    description: agent.description,
    ...(agent.displayName ? { displayName: agent.displayName } : {}),
    systemPrompt: agent.systemPrompt,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
    ...(agent.contextWindow === undefined ? {} : { contextWindow: agent.contextWindow }),
    ...(agent.maxOutputTokens === undefined ? {} : { maxOutputTokens: agent.maxOutputTokens }),
    ...turnPluginAgentSelectors(agent),
    declaredMcpServers: freeze(plugin.mcpServers.map((server) => server.name)),
  } satisfies DesktopTurnPluginAgent);
}

function turnPluginAgentSelectors(
  agent: PluginAgent,
): Pick<
  DesktopTurnPluginAgent,
  'tools' | 'disallowedTools' | 'mcpServers' | 'skills' | 'extensionSkills'
> {
  return {
    ...(agent.tools === undefined ? {} : { tools: agent.tools }),
    ...(agent.disallowedTools === undefined ? {} : { disallowedTools: agent.disallowedTools }),
    ...(agent.mcpServers === undefined ? {} : { mcpServers: agent.mcpServers }),
    ...(agent.skills === undefined ? {} : { skills: agent.skills }),
    ...(agent.extensionSkills === undefined ? {} : { extensionSkills: agent.extensionSkills }),
  };
}

function acceptHostBindings(
  input: PackageCapabilityAcceptanceInput,
  acceptedSkills: readonly PluginSkill[],
): DesktopTurnHostBinding[] {
  const hostBindings = input.plugin.hostBindings ?? [];
  if (hostBindings.length === 0) return [];
  const skillNames = new Set(acceptedSkills.map((skill) => skill.name));
  return hostBindings.flatMap((binding) => {
    if (binding.requiredSkills.some((name) => !skillNames.has(name))) {
      input.diagnostics.push(
        freeze({
          code: 'HOST_BINDING_SKILL_UNAVAILABLE',
          pluginName: input.plugin.name,
          capabilityName: binding.bindingId,
        }),
      );
      return [];
    }
    return [
      freeze({
        pluginName: input.plugin.name,
        packageDigest: input.packageContentDigest,
        bindingId: binding.bindingId,
        logicalToolName: binding.logicalToolName,
        hostCapability: freeze({ ...binding.hostCapability }),
        toolRef: `plugin:${input.plugin.name}:${binding.bindingId}`,
        requiredSkillRuntimeNames: freeze(
          binding.requiredSkills.map((name) =>
            buildPluginSkillRuntimeName(input.plugin.name, name),
          ),
        ),
        allowedSurfaces: freeze([...binding.allowedSurfaces]) as readonly ['interactive'],
      }),
    ];
  });
}

function acceptPluginName(input: PackageCapabilityAcceptanceInput): boolean {
  const { plugin } = input;
  if (!isDetailPathSegment(plugin.name)) {
    input.diagnostics.push(freeze({ code: 'PLUGIN_NAME_INVALID', pluginName: plugin.name }));
    return false;
  }
  if (!input.pluginNames.has(collisionKey(plugin.name))) return true;
  input.diagnostics.push(
    freeze({
      code: conflictCode(input.sourceKind, 'PLUGIN'),
      pluginName: plugin.name,
    }),
  );
  return false;
}

function acceptPackageSkills(input: PackageCapabilityAcceptanceInput): PluginSkill[] {
  const accepted: PluginSkill[] = [];
  const packageSkillKeys = new Set<string>();
  for (const skill of input.plugin.skills) {
    const key = normalizedSkillKey(buildPluginSkillRuntimeName(input.plugin.name, skill.name));
    if (input.skillNames.has(key) || packageSkillKeys.has(key)) {
      input.diagnostics.push(
        freeze({
          code: conflictCode(input.sourceKind, 'SKILL'),
          pluginName: input.plugin.name,
          capabilityName: skill.name,
        }),
      );
      continue;
    }
    packageSkillKeys.add(key);
    accepted.push(skill);
  }
  for (const key of packageSkillKeys) input.skillNames.add(key);
  return accepted;
}

function acceptPackageServers(input: PackageCapabilityAcceptanceInput): PluginSnapshotMcpServer[] {
  return input.plugin.mcpServers.map((server) =>
    freeze({
      pluginName: input.plugin.name,
      source: input.plugin.source,
      packageContentDigest: input.packageContentDigest,
      server,
    }),
  );
}

function conflictCode(sourceKind: 'official' | 'local', capability: 'PLUGIN' | 'SKILL'): string {
  return `${sourceKind === 'local' ? 'LOCAL' : 'OFFICIAL'}_${capability}_NAME_CONFLICT`;
}

function enabledProjection(plugin: ReadPluginPackage): PluginSnapshotEnabledProjection {
  return freeze({
    name: plugin.name,
    ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
    ...(plugin.iconPath ? { iconPath: plugin.iconPath } : {}),
    ...(plugin.darkIconPath ? { darkIconPath: plugin.darkIconPath } : {}),
    source: plugin.source,
    appProviders:
      plugin.source === 'OFFICIAL'
        ? freeze([...new Set(plugin.apps.map((app) => app.provider))])
        : freeze([]),
  });
}

function localIconUrl(iconPath: string): string {
  return `/mavis/api/file/preview?path=${encodeURIComponent(iconPath)}`;
}

function collisionKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US').slice(0, 128);
}

function normalizedSkillKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function normalizedPath(value: string): string {
  return path.normalize(value).normalize('NFC').toLocaleLowerCase('en-US');
}

function isDetailPathSegment(value: string): boolean {
  const name = value.trim();
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
