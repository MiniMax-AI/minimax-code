import { buildPluginId } from '@mavis/shared/plugin-mention';
import type {
  CliService,
  InstalledPluginSummary,
  InstalledPluginSource,
  PluginMarketplaceSummary,
} from '@mavis/local-runtime-v2/cli-service';

import type {
  McodePluginMarketplace,
  McodePluginRuntimeAccess,
  McodePluginView,
} from '../../plugin/contract.js';

const PAGE_SIZE = 200;
const MAX_PAGES = 100;
const OFFICIAL_PLUGIN_SOURCE: InstalledPluginSource = 1;
const LOCAL_PLUGIN_SOURCE: InstalledPluginSource = 2;

export class TuiPluginAccess implements McodePluginRuntimeAccess {
  constructor(private readonly cliService: CliService) {}

  async listInstalledPlugins(
    input: {
      readonly marketplace?: McodePluginMarketplace;
    } = {},
  ): Promise<readonly McodePluginView[]> {
    const plugins = await collectPages((cursor) =>
      this.cliService.listInstalledPlugins({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }),
    );
    return plugins
      .map(toInstalledPlugin)
      .filter(
        (plugin): plugin is McodePluginView =>
          plugin !== undefined &&
          (input.marketplace === undefined || plugin.marketplace === input.marketplace),
      );
  }

  async listMarketplacePlugins(input: {
    readonly marketplace: McodePluginMarketplace;
  }): Promise<readonly McodePluginView[]> {
    const source = toGeneratedSource(input.marketplace);
    const plugins = await collectPages((cursor) =>
      this.cliService.listMarketplacePlugins({
        source,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }),
    );
    return plugins.flatMap((plugin) => {
      const view = toMarketplacePlugin(plugin, input.marketplace);
      return view ? [view] : [];
    });
  }

  async mutatePlugin(
    input: Parameters<McodePluginRuntimeAccess['mutatePlugin']>[0],
  ): Promise<{ readonly installed: boolean; readonly enabled: boolean }> {
    const request = {
      pluginName: input.plugin.name,
      source: toGeneratedSource(input.plugin.marketplace),
    };
    const response = await this.cliService[mutationMethod(input.action)](request);
    return { installed: response.installExists, enabled: response.enabled };
  }

  async refreshPlugins(): Promise<void> {
    await this.cliService.refreshPlugins();
  }
}

function mutationMethod(action: Parameters<McodePluginRuntimeAccess['mutatePlugin']>[0]['action']) {
  return {
    install: 'installPlugin',
    remove: 'uninstallPlugin',
    enable: 'enablePlugin',
    disable: 'disablePlugin',
  }[action] as 'installPlugin' | 'uninstallPlugin' | 'enablePlugin' | 'disablePlugin';
}

async function collectPages<T>(
  load: (cursor?: string) => Promise<{
    readonly plugins: readonly T[];
    readonly hasMore?: boolean;
    readonly nextCursor?: string;
  }>,
): Promise<T[]> {
  const result: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await load(cursor);
    result.push(...response.plugins);
    const next = response.nextCursor?.trim();
    if (!response.hasMore || !next || seenCursors.has(next)) return result;
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error(`Plugin catalog exceeded ${MAX_PAGES} pages.`);
}

function toInstalledPlugin(plugin: InstalledPluginSummary): McodePluginView | undefined {
  const marketplace = fromGeneratedSource(plugin.source);
  if (!marketplace) return undefined;
  return toPluginView(plugin, marketplace, true, plugin.enabled);
}

function toMarketplacePlugin(
  plugin: PluginMarketplaceSummary,
  marketplace: McodePluginMarketplace,
): McodePluginView | undefined {
  return toPluginView(plugin, marketplace, plugin.installExists, plugin.enabled);
}

function toPluginView(
  plugin: InstalledPluginSummary | PluginMarketplaceSummary,
  marketplace: McodePluginMarketplace,
  installed: boolean,
  enabled: boolean,
): McodePluginView | undefined {
  const name = plugin.name.trim();
  if (!name) return undefined;
  return {
    pluginId: buildPluginId(name, marketplace),
    name,
    displayName: plugin.displayName?.trim() || name,
    marketplace,
    ...(plugin.version?.trim() ? { version: plugin.version.trim() } : {}),
    ...(plugin.description?.trim() ? { description: plugin.description.trim() } : {}),
    ...(plugin.author?.trim() ? { author: plugin.author.trim() } : {}),
    installed,
    enabled,
    capabilities: {
      appCount: plugin.capabilities.appCount,
      mcpServerCount: plugin.capabilities.mcpServerCount,
      skillCount: plugin.capabilities.skillCount,
    },
  };
}

function toGeneratedSource(marketplace: McodePluginMarketplace) {
  return marketplace === 'official' ? OFFICIAL_PLUGIN_SOURCE : LOCAL_PLUGIN_SOURCE;
}

function fromGeneratedSource(source: number): McodePluginMarketplace | undefined {
  if (source === OFFICIAL_PLUGIN_SOURCE) return 'official';
  if (source === LOCAL_PLUGIN_SOURCE) return 'local';
  return undefined;
}
