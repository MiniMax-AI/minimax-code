export type McodePluginMarketplace = 'official' | 'local';

export interface McodePluginCapabilities {
  readonly appCount: number;
  readonly mcpServerCount: number;
  readonly skillCount: number;
  /** Local Plugin subagents; absent when the Runtime reports none. */
  readonly agentCount?: number;
}

export interface McodePluginView {
  readonly pluginId: string;
  readonly name: string;
  readonly displayName: string;
  readonly marketplace: McodePluginMarketplace;
  readonly version?: string;
  readonly description?: string;
  readonly author?: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly capabilities: McodePluginCapabilities;
}

export interface McodePluginCatalog {
  readonly installed: readonly McodePluginView[];
  readonly available: readonly McodePluginView[];
}

export interface McodePluginRuntimeAccess {
  listInstalledPlugins(input?: {
    readonly marketplace?: McodePluginMarketplace;
  }): Promise<readonly McodePluginView[]>;
  listMarketplacePlugins(input: {
    readonly marketplace: McodePluginMarketplace;
  }): Promise<readonly McodePluginView[]>;
  mutatePlugin(input: {
    readonly action: 'install' | 'remove' | 'enable' | 'disable';
    readonly plugin: { readonly name: string; readonly marketplace: McodePluginMarketplace };
  }): Promise<{ readonly installed: boolean; readonly enabled: boolean }>;
  refreshPlugins(): Promise<void>;
}

export type McodePluginCliRequest =
  | {
      readonly action: 'list';
      readonly marketplace?: McodePluginMarketplace;
      readonly available?: boolean;
      readonly json?: boolean;
    }
  | {
      readonly action: 'add' | 'remove' | 'enable' | 'disable';
      readonly selector: string;
      readonly marketplace?: McodePluginMarketplace;
      readonly json?: boolean;
    }
  | { readonly action: 'marketplace-list'; readonly json?: boolean }
  | {
      readonly action: 'marketplace-upgrade';
      readonly json?: boolean;
    };
