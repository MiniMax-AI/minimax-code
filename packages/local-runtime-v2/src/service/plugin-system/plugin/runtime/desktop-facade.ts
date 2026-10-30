import {
  InstalledPluginSource,
  MarketplaceCategory,
  PluginInstallationPolicy,
  type GetMarketplacePluginInput,
  type GetMarketplacePluginResult,
  type ImportGithubPluginInput,
  type ImportGithubPluginResult,
  type InstalledPluginSummary,
  type ListEnabledPluginsInput,
  type ListEnabledPluginsResult,
  type ListInstalledPluginsInput,
  type ListInstalledPluginsResult,
  type ListMarketplacePluginsInput,
  type ListMarketplacePluginsResult,
  type MutatePluginInput,
  type MutatePluginResult,
  type PluginMarketplaceDetail,
  type PluginMarketplaceSummary,
  type PreviewGithubPluginInput,
  type PreviewGithubPluginResult,
  type SkillInfo,
  type SkillHubItem,
} from '@mavis/protocol/local';

import type {
  LocalPluginMutationResult,
  OfficialPluginLocalState,
  PluginSystem,
} from '../../plugin-system.js';
import type { EnabledPluginSkillSummary, PluginServiceMetrics } from '../../contracts.js';
import type { OfficialPluginInstallationRecord } from './repository.js';
import type { PluginSnapshot } from './snapshot-builder.js';
import type { MarketplaceCategoryName, ReadPluginPackage } from '../package/types.js';
import type { GithubPluginImporter } from '../import/github-plugin-importer.js';
import type { OfficialPluginAuthBarrierOutcome } from './official-operations.js';
import { PluginRegistryClient, type PluginMutationAction } from './registry-client.js';
import { effectiveInstallationPolicy } from './repository.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const BUILTIN_AGENT_PLUGIN_ICON_URL = 'minimax-builtin://plugin-icons/github';

interface StandaloneSkillIdentities {
  readonly names: ReadonlySet<string>;
  readonly sourceUrls: ReadonlySet<string>;
}

interface StandaloneSkillListInput {
  readonly keyword?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

interface StandaloneSkillListResult {
  readonly skills: readonly SkillInfo[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface PluginDesktopFacadeOptions {
  readonly system: PluginSystem;
  readonly registryClient: PluginRegistryClient;
  readonly listStandaloneSkills: (
    input: StandaloneSkillListInput,
  ) => Promise<StandaloneSkillListResult>;
  readonly standaloneSkillIdentities: () => Promise<StandaloneSkillIdentities>;
  /** Waits only for the Utility process to receive a usable Desktop identity. */
  readonly waitForOfficialAuth: () => Promise<OfficialPluginAuthBarrierOutcome>;
  readonly metrics?: PluginServiceMetrics;
  readonly githubImporter?: GithubPluginImporter;
}

export class PluginDesktopFacadeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PluginDesktopFacadeError';
  }
}

/** Desktop projection over the Cloud registry plus the accepted local snapshot. */
export class PluginDesktopFacade {
  constructor(private readonly options: PluginDesktopFacadeOptions) {}

  refresh(): Promise<void> {
    return this.options.system.refresh();
  }

  setLocalPluginEnabled(name: string, enabled: boolean): Promise<LocalPluginMutationResult> {
    return this.options.system.setLocalPluginEnabled(name, enabled);
  }

  uninstallLocalPlugin(name: string): Promise<LocalPluginMutationResult> {
    return this.options.system.uninstallLocalPlugin(name);
  }

  async listMarketplacePlugins(
    req: ListMarketplacePluginsInput,
  ): Promise<ListMarketplacePluginsResult> {
    const source = readSource(req.source);
    if (source === InstalledPluginSource.OFFICIAL) {
      return this.projectStandaloneSkillAdded(
        await this.overlayOfficialMarketplaceState(
          await this.options.registryClient.listMarketplace(req),
        ),
      );
    }
    const skillLimit = pageLimit(req.skillLimit ?? req.limit);
    const [standaloneSkills, localSnapshot] = await Promise.all([
      this.options.listStandaloneSkills({
        keyword: req.keyword,
        limit: skillLimit,
        cursor: req.skillCursor,
      }),
      this.options.system.refreshLocalPluginsForMarketplace({
        // The watcher invalidates this projection for real filesystem changes.
        // Search/filter/pagination must not repeatedly hash every local package.
        reuseCached: true,
      }),
    ]);
    const local = localMarketplacePage(localSnapshot, req);
    return {
      plugins: local.plugins,
      nextCursor: local.nextCursor,
      hasMore: local.hasMore,
      pluginTotal: local.pluginTotal,
      marketplaceSkills: standaloneSkills.skills.map(localStandaloneSkillSummary),
      skillNextCursor: standaloneSkills.nextCursor,
      skillHasMore: standaloneSkills.hasMore,
    };
  }

  async getMarketplacePlugin(req: GetMarketplacePluginInput): Promise<GetMarketplacePluginResult> {
    const source = readSource(req.source);
    if (source === InstalledPluginSource.OFFICIAL) {
      const response = await this.options.registryClient.getMarketplace(req);
      if (!response.plugin) return response;
      const installations = await this.options.system.listOfficialPluginInstallations();
      return {
        ...response,
        plugin: {
          ...response.plugin,
          summary: overlayOfficialSummary(response.plugin.summary, installations),
        },
      };
    }
    const localSnapshot = await this.options.system.refreshLocalPluginsForMarketplace({
      reuseCached: true,
    });
    const plugin = localPluginDetail(localSnapshot, req.pluginName);
    if (!plugin) throw new PluginDesktopFacadeError('PLUGIN_NOT_FOUND');
    return { plugin };
  }

  async listInstalledPlugins(req: ListInstalledPluginsInput): Promise<ListInstalledPluginsResult> {
    const filter = normalizedKeyword(req.keyword);
    const limit = pageLimit(req.limit);
    const cursor = decodeInstalledCursor(req.cursor, filter);
    const [officialStates, localSnapshot] = await Promise.all([
      this.options.system.listOfficialPluginStates(),
      this.options.system.refreshLocalPluginsForMarketplace({
        // Management polling reads the watcher-maintained projection. A full
        // hash scan is reserved for a cache miss or explicit refresh.
        reuseCached: true,
      }),
    ]);
    const official = await officialInstalledItems(officialStates, filter);
    const local = localInstalledItems(localSnapshot, filter, official);
    return installedSnapshotPage(
      [...official, ...local],
      filter,
      limit,
      cursor?.stage === 'snapshot' ? cursor.offset : 0,
    );
  }

  async listEnabledPlugins(_req: ListEnabledPluginsInput): Promise<ListEnabledPluginsResult> {
    const names = new Set<string>();
    const plugins = this.options.system.currentSnapshot.enabledPlugins.flatMap((plugin) => {
      const key = normalizedName(plugin.name);
      if (names.has(key)) return [];
      names.add(key);
      return [
        {
          name: plugin.name,
          ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
          ...optionalPluginIcon(plugin),
        },
      ];
    });
    return { plugins };
  }

  async listEnabledPluginSkillSummaries(): Promise<readonly EnabledPluginSkillSummary[]> {
    const enabledPlugins = new Map(
      this.options.system.currentSnapshot.enabledPlugins.map((plugin) => [
        normalizedName(plugin.name),
        plugin,
      ]),
    );
    const skills = this.options.system.currentSnapshot.turnCapabilities.skills.flatMap((skill) => {
      const plugin = enabledPlugins.get(normalizedName(skill.pluginName));
      if (!plugin) return [];
      const runtimeName = skill.name.trim();
      const pluginName = skill.pluginName.trim();
      const skillName = runtimeName.startsWith(`${pluginName}:`)
        ? runtimeName.slice(pluginName.length + 1)
        : runtimeName;
      if (!runtimeName || !pluginName || !skillName) return [];
      return [
        {
          runtimeName,
          pluginName,
          skillName,
          ...(plugin.displayName ? { pluginDisplayName: plugin.displayName } : {}),
          ...optionalPluginSkillIcon(plugin),
          description: skill.description,
        },
      ];
    });
    return skills;
  }

  installPlugin(req: MutatePluginInput): Promise<MutatePluginResult> {
    return this.mutate(req, 'install');
  }

  uninstallPlugin(req: MutatePluginInput): Promise<MutatePluginResult> {
    return this.mutate(req, 'uninstall');
  }

  enablePlugin(req: MutatePluginInput): Promise<MutatePluginResult> {
    return this.mutate(req, 'enable');
  }

  disablePlugin(req: MutatePluginInput): Promise<MutatePluginResult> {
    return this.mutate(req, 'disable');
  }

  async previewGithubPlugin(
    req: PreviewGithubPluginInput,
    signal?: AbortSignal,
  ): Promise<PreviewGithubPluginResult> {
    if (!this.options.githubImporter) {
      throw new PluginDesktopFacadeError('PLUGIN_IMPORT_UNAVAILABLE');
    }
    const startedAt = Date.now();
    let status = 'success';
    try {
      const preview = await this.options.githubImporter.preview(req.url, signal);
      return {
        source: preview.source,
        plugin: {
          summary: pluginPackageSummary(preview.plugin, false, false),
          skillCount: preview.plugin.skills.length,
          mcpServerCount: preview.plugin.mcpServers.length,
          hasStdioMcp: preview.plugin.mcpServers.some(
            (server) => declaredTransport(server.configJson) === 'stdio',
          ),
        },
        diagnostics: [...preview.plugin.diagnostics],
        packageSizeBytes: preview.packageSizeBytes,
        canImport: preview.canImport,
      };
    } catch (error) {
      status = signal?.aborted ? 'cancelled' : 'error';
      throw error;
    } finally {
      const tags = { status };
      this.options.metrics?.incr('plugin_github_preview_total', tags);
      this.options.metrics?.latency(
        'plugin_github_preview_duration_ms',
        Date.now() - startedAt,
        tags,
      );
    }
  }

  async importGithubPlugin(req: ImportGithubPluginInput): Promise<ImportGithubPluginResult> {
    const startedAt = Date.now();
    let status = 'success';
    try {
      const plugin = await this.options.system.importGithubPlugin(req.source);
      return { plugin: pluginPackageSummary(plugin, true, true) };
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      const tags = { status };
      this.options.metrics?.incr('plugin_github_import_total', tags);
      this.options.metrics?.latency(
        'plugin_github_import_duration_ms',
        Date.now() - startedAt,
        tags,
      );
    }
  }

  private async mutate(
    req: MutatePluginInput,
    action: PluginMutationAction,
  ): Promise<MutatePluginResult> {
    const source = readSource(req.source);
    const sourceLabel = source === InstalledPluginSource.OFFICIAL ? 'official' : 'local';
    const startedAt = Date.now();
    let status = 'success';
    try {
      if (source === InstalledPluginSource.OFFICIAL) {
        return await this.mutateOfficial(req, action);
      }
      return await this.mutateLocal(req, action);
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      const tags = { source: sourceLabel, action, status };
      this.options.metrics?.incr('plugin_mutation_total', tags);
      this.options.metrics?.latency('plugin_mutation_duration_ms', Date.now() - startedAt, tags);
    }
  }

  private async mutateOfficial(
    req: MutatePluginInput,
    action: PluginMutationAction,
  ): Promise<MutatePluginResult> {
    const authOutcome = await this.options.waitForOfficialAuth();
    if (authOutcome === 'logged_out') {
      throw new PluginDesktopFacadeError('PLUGIN_AUTH_REQUIRED');
    }
    if (authOutcome !== 'ready') {
      throw new PluginDesktopFacadeError('PLUGIN_AUTH_SYNC_TIMEOUT');
    }
    const scope = this.options.system.captureOfficialScope();
    if (!scope) throw new PluginDesktopFacadeError('PLUGIN_AUTH_REQUIRED');
    const requestedName = req.pluginName.trim();
    try {
      const response = await this.options.registryClient.mutate(requestedName, action);
      assertOfficialMutationResponse(response, requestedName);
      await this.options.system.applyOfficialMutation(
        {
          pluginName: requestedName,
          installExists: response.installExists,
          enabled: response.enabled,
          installationPolicy: response.installationPolicy ?? PluginInstallationPolicy.USER_MANAGED,
          ...(response.package ? { package: response.package } : {}),
        },
        scope,
      );
      return response;
    } catch (error) {
      // Once the request is in flight, the registry may already have committed
      // even when validation, transport, download, or local publication fails.
      // Recover from the authoritative full state without delaying this error.
      this.options.system.requestOfficialRecovery(scope);
      throw error;
    }
  }

  private async mutateLocal(
    req: MutatePluginInput,
    action: PluginMutationAction,
  ): Promise<MutatePluginResult> {
    if (action === 'install') {
      throw new PluginDesktopFacadeError('LOCAL_PLUGIN_INSTALL_UNSUPPORTED');
    }
    const result =
      action === 'uninstall'
        ? await this.options.system.uninstallLocalPlugin(req.pluginName)
        : await this.options.system.setLocalPluginEnabled(req.pluginName, action === 'enable');
    return {
      source: InstalledPluginSource.LOCAL,
      installExists: result.installExists,
      enabled: result.enabled,
    };
  }

  private async overlayOfficialMarketplaceState(
    response: ListMarketplacePluginsResult,
  ): Promise<ListMarketplacePluginsResult> {
    const installations = await this.options.system.listOfficialPluginInstallations();
    return {
      ...response,
      plugins: response.plugins.map((plugin) => overlayOfficialSummary(plugin, installations)),
    };
  }

  private async projectStandaloneSkillAdded(
    response: ListMarketplacePluginsResult,
  ): Promise<ListMarketplacePluginsResult> {
    if (!response.marketplaceSkills) return response;
    const installed = await this.options.standaloneSkillIdentities();
    return {
      ...response,
      marketplaceSkills: response.marketplaceSkills.map((item) => ({
        ...item,
        added: isStandaloneSkillAdded(item, installed),
      })),
    };
  }
}

function assertOfficialMutationResponse(response: MutatePluginResult, requestedName: string): void {
  if (response.source !== InstalledPluginSource.OFFICIAL) {
    throw new PluginDesktopFacadeError('PLUGIN_MUTATION_SOURCE_INVALID');
  }
  if (response.package && normalizedName(response.package.name) !== normalizedName(requestedName)) {
    throw new PluginDesktopFacadeError('PLUGIN_MUTATION_PACKAGE_INVALID');
  }
}

function localStandaloneSkillSummary(skill: SkillInfo): SkillHubItem {
  return {
    id: stableLocalSkillId(skill),
    name: skill.name,
    ...(skill.displayName ? { displayName: skill.displayName } : {}),
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.displayDescription ? { displayDescription: skill.displayDescription } : {}),
    ...(skill.sourceType !== undefined ? { sourceType: skill.sourceType } : {}),
    ...(skill.creatorInfo ? { creatorInfo: skill.creatorInfo } : {}),
    ...(skill.createdAt !== undefined ? { createdAt: skill.createdAt } : {}),
    ...(skill.updatedAt !== undefined ? { updatedAt: skill.updatedAt } : {}),
    added: true,
  };
}

/** Stable page identity for local Skills that do not own a Marketplace database id. */
function stableLocalSkillId(skill: SkillInfo): number {
  const identity = [skill.locationUri, skill.sourceKind, skill.agentName, skill.name]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\u0000');
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let index = 0; index < identity.length; index += 1) {
    const code = identity.charCodeAt(index);
    high = Math.imul(high ^ code, 2_654_435_761);
    low = Math.imul(low ^ code, 1_597_334_677);
  }
  high =
    Math.imul(high ^ (high >>> 16), 2_246_822_507) ^ Math.imul(low ^ (low >>> 13), 3_266_489_909);
  low =
    Math.imul(low ^ (low >>> 16), 2_246_822_507) ^ Math.imul(high ^ (high >>> 13), 3_266_489_909);
  const value = 4_294_967_296 * (low & 0x1fffff) + (high >>> 0);
  return -(value || 1);
}

function localMarketplacePage(
  snapshot: PluginSnapshot,
  req: ListMarketplacePluginsInput,
): {
  plugins: PluginMarketplaceSummary[];
  nextCursor?: string;
  hasMore: boolean;
  pluginTotal: number;
} {
  const filter = normalizedKeyword(req.keyword);
  const category = req.category;
  const categoryKey = category ?? -1;
  const cursor = decodeLocalCursor(req.cursor, filter, categoryKey);
  const limit = pageLimit(req.limit);
  const items = snapshot.localPlugins
    .filter((plugin) => pluginMatchesKeyword(plugin.name, plugin.displayName, filter))
    .filter((plugin) => category === undefined || category === categoryId(plugin.plugin.category))
    .map(localMarketplaceSummary);
  const offset = cursor?.offset ?? 0;
  const plugins = items.slice(offset, offset + limit);
  const nextOffset = offset + plugins.length;
  const hasMore = nextOffset < items.length;
  return {
    plugins,
    hasMore,
    pluginTotal: items.length,
    ...(hasMore
      ? {
          nextCursor: encodeCursor({
            version: 1,
            kind: 'marketplace-local',
            filter,
            category: categoryKey,
            offset: nextOffset,
          }),
        }
      : {}),
  };
}

function installedSnapshotPage(
  items: readonly InstalledPluginSummary[],
  filter: string,
  limit: number,
  offset: number,
): ListInstalledPluginsResult {
  const plugins = items.slice(offset, offset + limit);
  const nextOffset = offset + plugins.length;
  const hasMore = nextOffset < items.length;
  return {
    plugins,
    hasMore,
    ...(hasMore
      ? {
          nextCursor: encodeCursor({
            version: 1,
            kind: 'installed',
            filter,
            stage: 'snapshot',
            offset: nextOffset,
          }),
        }
      : {}),
  };
}

async function officialInstalledItems(
  states: readonly OfficialPluginLocalState[],
  filter: string,
): Promise<InstalledPluginSummary[]> {
  return states.flatMap((state) => officialInstalledItem(state, filter));
}

function officialInstalledItem(
  { installation, plugin }: OfficialPluginLocalState,
  filter: string,
): InstalledPluginSummary[] {
  if (!pluginMatchesKeyword(installation.name, plugin?.displayName, filter)) return [];
  return [toOfficialInstalledSummary(installation, plugin)];
}

function toOfficialInstalledSummary(
  installation: OfficialPluginInstallationRecord,
  plugin: OfficialPluginLocalState['plugin'],
): InstalledPluginSummary {
  return {
    name: installation.name,
    ...officialInstalledMetadata(installation, plugin),
    capabilities: officialInstalledCapabilities(plugin),
    source: InstalledPluginSource.OFFICIAL,
    enabled: installation.enabled,
    installationPolicy: effectiveInstallationPolicy(installation),
    category: plugin ? categoryId(plugin.category) : MarketplaceCategory.OTHER,
  };
}

function officialInstalledMetadata(
  installation: OfficialPluginInstallationRecord,
  plugin: OfficialPluginLocalState['plugin'],
) {
  const current = installation.package;
  return {
    ...(current?.version ? { version: current.version } : {}),
    ...(plugin?.displayName ? { displayName: plugin.displayName } : {}),
    ...(plugin?.description ? { description: plugin.description } : {}),
    ...(plugin?.author ? { author: plugin.author } : {}),
    ...(plugin ? optionalPluginIcon(plugin) : {}),
  };
}

function officialInstalledCapabilities(plugin: OfficialPluginLocalState['plugin']) {
  return {
    appCount: plugin?.apps.length ?? 0,
    mcpServerCount: plugin?.mcpServers.length ?? 0,
    skillCount: plugin?.skills.length ?? 0,
    hookCount: plugin?.hooks?.length ?? 0,
    agentCount: plugin?.agents?.length ?? 0,
  };
}

function overlayOfficialSummary(
  summary: PluginMarketplaceSummary,
  installations: readonly OfficialPluginInstallationRecord[],
): PluginMarketplaceSummary {
  const installation = installations.find(
    (item) => normalizedName(item.name) === normalizedName(summary.name),
  );
  return {
    ...summary,
    installExists: installation?.installed ?? false,
    enabled: installation?.enabled ?? false,
    installationPolicy: installation
      ? effectiveInstallationPolicy(installation)
      : (summary.installationPolicy ?? PluginInstallationPolicy.USER_MANAGED),
  };
}

function localInstalledItems(
  snapshot: PluginSnapshot,
  filter: string,
  official: readonly InstalledPluginSummary[],
): InstalledPluginSummary[] {
  const reserved = new Set(official.map((item) => normalizedName(item.name)));
  return snapshot.localPlugins.flatMap((plugin) => {
    const key = normalizedName(plugin.name);
    if (!pluginMatchesKeyword(plugin.name, plugin.displayName, filter) || reserved.has(key)) {
      return [];
    }
    reserved.add(key);
    const summary = localMarketplaceSummary(plugin);
    return [
      {
        name: summary.name,
        ...(summary.version ? { version: summary.version } : {}),
        ...(summary.displayName ? { displayName: summary.displayName } : {}),
        ...(summary.description ? { description: summary.description } : {}),
        ...(summary.author ? { author: summary.author } : {}),
        ...(summary.iconUrl ? { iconUrl: summary.iconUrl } : {}),
        ...(summary.darkIconUrl ? { darkIconUrl: summary.darkIconUrl } : {}),
        capabilities: summary.capabilities,
        source: InstalledPluginSource.LOCAL,
        enabled: summary.enabled,
        installationPolicy: PluginInstallationPolicy.USER_MANAGED,
        category: summary.category,
      },
    ];
  });
}

function localMarketplaceSummary(
  plugin: PluginSnapshot['localPlugins'][number],
): PluginMarketplaceSummary {
  return {
    name: plugin.name,
    ...(plugin.version ? { version: plugin.version } : {}),
    ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.author ? { author: plugin.author } : {}),
    ...optionalPluginIcon(plugin),
    capabilities: {
      appCount: 0,
      mcpServerCount: plugin.plugin.mcpServers.length,
      skillCount: plugin.plugin.skills.length,
      hookCount: plugin.plugin.hooks?.length ?? 0,
      agentCount: plugin.plugin.agents?.length ?? 0,
    },
    installExists: true,
    enabled: plugin.enabled,
    installationPolicy: PluginInstallationPolicy.USER_MANAGED,
    category: categoryId(plugin.plugin.category),
  };
}

function localPluginDetail(
  snapshot: PluginSnapshot,
  pluginName: string,
): PluginMarketplaceDetail | undefined {
  const key = normalizedName(pluginName);
  const local = snapshot.localPlugins.find((plugin) => normalizedName(plugin.name) === key);
  if (!local) return undefined;
  return pluginPackageDetail(local.plugin, true, local.enabled);
}

function pluginPackageDetail(
  plugin: ReadPluginPackage,
  installExists: boolean,
  enabled: boolean,
): PluginMarketplaceDetail {
  return {
    summary: pluginPackageSummary(plugin, installExists, enabled),
    apps: [],
    mcpServers: plugin.mcpServers.map((server) => ({
      name: server.name,
      transport: declaredTransport(server.configJson),
      ...(server.description ? { description: server.description } : {}),
      configJson: server.configJson,
    })),
    skills: plugin.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: skill.content,
    })),
    exampleQueries: [...plugin.exampleQueries],
    ...(plugin.agents?.length
      ? {
          agents: plugin.agents.map((agent) => ({
            name: agent.scopedName,
            description: agent.description,
            content: agent.content,
          })),
        }
      : {}),
  };
}

function pluginPackageSummary(
  plugin: ReadPluginPackage,
  installExists: boolean,
  enabled: boolean,
): PluginMarketplaceSummary {
  return {
    name: plugin.name,
    ...(plugin.version ? { version: plugin.version } : {}),
    ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.author ? { author: plugin.author } : {}),
    ...optionalPluginIcon(plugin),
    capabilities: {
      appCount: 0,
      mcpServerCount: plugin.mcpServers.length,
      skillCount: plugin.skills.length,
      hookCount: plugin.hooks?.length ?? 0,
      agentCount: plugin.agents?.length ?? 0,
    },
    installExists,
    enabled,
    installationPolicy: PluginInstallationPolicy.USER_MANAGED,
    category: categoryId(plugin.category),
  };
}

function declaredTransport(configJson: string): string {
  try {
    const parsed = JSON.parse(configJson) as { type?: unknown; command?: unknown; url?: unknown };
    if (typeof parsed.type === 'string') return parsed.type;
    if (typeof parsed.command === 'string') return 'stdio';
    if (typeof parsed.url === 'string') return 'http';
  } catch {
    // The package reader already validated this object; retain a safe label if
    // an in-memory test double supplies an invalid value.
  }
  return 'unknown';
}

function localIconUrl(iconPath: string): string {
  return `/mavis/api/file/preview?path=${encodeURIComponent(iconPath)}`;
}

function optionalPluginIcon(
  plugin: Pick<ReadPluginPackage, 'source' | 'iconPath' | 'darkIconPath'>,
): {
  iconUrl?: string;
  darkIconUrl?: string;
} {
  if (plugin.iconPath) {
    return {
      iconUrl: localIconUrl(plugin.iconPath),
      ...(plugin.darkIconPath ? { darkIconUrl: localIconUrl(plugin.darkIconPath) } : {}),
    };
  }
  if (plugin.source === 'LOCAL_AGENT_PLUGIN') {
    return { iconUrl: BUILTIN_AGENT_PLUGIN_ICON_URL };
  }
  return {};
}

function optionalPluginSkillIcon(plugin: PluginSnapshot['enabledPlugins'][number]): {
  pluginIconUrl?: string;
  pluginDarkIconUrl?: string;
} {
  const icon = optionalPluginIcon(plugin);
  return {
    ...(icon.iconUrl ? { pluginIconUrl: icon.iconUrl } : {}),
    ...(icon.darkIconUrl ? { pluginDarkIconUrl: icon.darkIconUrl } : {}),
  };
}

function isStandaloneSkillAdded(item: SkillHubItem, installed: StandaloneSkillIdentities): boolean {
  const sourceUrl = item.sourceUrl?.trim();
  if (sourceUrl && installed.sourceUrls.has(sourceUrl)) return true;
  return installed.names.has(normalizedName(item.name));
}

function categoryId(value: MarketplaceCategoryName): MarketplaceCategory {
  const mapping: Record<MarketplaceCategoryName, MarketplaceCategory> = {
    Other: MarketplaceCategory.OTHER,
    Office: MarketplaceCategory.OFFICE,
    Studio: MarketplaceCategory.STUDIO,
    'Design & Sites': MarketplaceCategory.DESIGN_AND_SITES,
    Code: MarketplaceCategory.CODE,
    Business: MarketplaceCategory.BUSINESS,
    Sales: MarketplaceCategory.SALES,
    Productivity: MarketplaceCategory.PRODUCTIVITY,
    'Science & Healthcare': MarketplaceCategory.SCIENCE_AND_HEALTHCARE,
    Education: MarketplaceCategory.EDUCATION,
  };
  return mapping[value];
}

function readSource(value: unknown): InstalledPluginSource {
  if (value === undefined || value === InstalledPluginSource.OFFICIAL || value === '1') {
    return InstalledPluginSource.OFFICIAL;
  }
  if (value === InstalledPluginSource.LOCAL || value === '2') return InstalledPluginSource.LOCAL;
  throw new PluginDesktopFacadeError('INVALID_PLUGIN_SOURCE');
}

type InstalledCursor = {
  version: 1;
  kind: 'installed';
  filter: string;
  stage: 'snapshot';
  offset: number;
};

interface LocalCursor {
  readonly version: 1;
  readonly kind: 'marketplace-local';
  readonly filter: string;
  readonly category: number;
  readonly offset: number;
}

function decodeInstalledCursor(
  value: string | undefined,
  filter: string,
): InstalledCursor | undefined {
  if (!value) return undefined;
  const parsed = decodeCursor(value);
  if (parsed.version !== 1 || parsed.kind !== 'installed' || parsed.filter !== filter) {
    throw new PluginDesktopFacadeError('PLUGIN_CURSOR_INVALID');
  }
  return readInstalledStage(parsed, filter);
}

function readInstalledStage(parsed: Record<string, unknown>, filter: string): InstalledCursor {
  if (parsed.stage === 'snapshot' && isOffset(parsed.offset)) {
    return { version: 1, kind: 'installed', filter, stage: 'snapshot', offset: parsed.offset };
  }
  throw new PluginDesktopFacadeError('PLUGIN_CURSOR_INVALID');
}

function decodeLocalCursor(
  value: string | undefined,
  filter: string,
  category: number,
): LocalCursor | undefined {
  if (!value) return undefined;
  const parsed = decodeCursor(value);
  if (
    parsed.version !== 1 ||
    parsed.kind !== 'marketplace-local' ||
    parsed.filter !== filter ||
    parsed.category !== category ||
    !isOffset(parsed.offset)
  ) {
    throw new PluginDesktopFacadeError('PLUGIN_CURSOR_INVALID');
  }
  return { version: 1, kind: 'marketplace-local', filter, category, offset: parsed.offset };
}

function encodeCursor(value: InstalledCursor | LocalCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Mapped to the stable cursor error below.
  }
  throw new PluginDesktopFacadeError('PLUGIN_CURSOR_INVALID');
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value <= 0) {
    throw new PluginDesktopFacadeError('PLUGIN_LIMIT_INVALID');
  }
  return Math.min(value, MAX_LIMIT);
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizedKeyword(value: string | undefined): string {
  return normalizedName(value ?? '');
}

function pluginMatchesKeyword(
  name: string,
  displayName: string | undefined,
  keyword: string,
): boolean {
  return (
    normalizedName(name).includes(keyword) ||
    (displayName !== undefined && normalizedName(displayName).includes(keyword))
  );
}

function normalizedName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
