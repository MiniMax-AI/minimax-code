import {
  compareAndSetLocalModelContext,
  getConfig,
  removeLocalProviderConfig,
  updateLocalAdvisorSelection,
  updateLocalByokConfig,
  updateLocalModelSelection,
} from '@mavis/config';

import { LocalModelCache } from './catalog/model-cache.js';
import type { RankModelsByRecencyInput } from './catalog/provider-presets/model-recency.js';
import { ProviderPresetCatalog } from './catalog/provider-presets/provider-presets.service.js';
import { CodexOAuthManager } from './codex-oauth.js';
import { ModelDiscoveryClient } from './connectivity/discover-models.js';
import { ModelConnectionTester } from './connectivity/test-connection.js';
import type {
  LocalModelResolverOptions,
  LocalRuntimeConfig,
  ModelSystemConfigPort,
  ByokProviderPresetView,
} from './contracts.js';
import { LocalModelProviderService } from './management/service.js';
import { LocalModelResolver } from './resolution/local-model-resolver.js';

export interface InitializeModelSystemOptions {
  readonly config: ModelSystemConfigPort;
  readonly resolverOptions?: Omit<
    LocalModelResolverOptions,
    'providerConfig' | 'providerConfigGetter' | 'byokConfigGetter'
  >;
  readonly fetchImpl?: typeof fetch;
  readonly implicitCustomProviderThinking?: boolean;
}

/** Newest-first model ids by models.dev update time; unknown ids keep source order last. */
export type RankModelsByRecency = (
  input: RankModelsByRecencyInput & { readonly signal?: AbortSignal },
) => Promise<string[]>;

export interface ModelSystemOwner {
  readonly resolver: LocalModelResolver;
  readonly providers: LocalModelProviderService;
  readonly oauth: CodexOAuthManager;
  readonly listProviderPresets: () => Promise<ByokProviderPresetView[]>;
  readonly rankModelsByRecency: RankModelsByRecency;
}

/** Binds every Model System config operation to the active Runtime profile. */
export function createLocalModelSystemConfigPort(read: () => LocalRuntimeConfig = getConfig) {
  return {
    read,
    updateByok: updateLocalByokConfig,
    compareAndSetModelContext: async (input, beforeCommit) =>
      (await compareAndSetLocalModelContext(input, beforeCommit)).updated,
    setDefaultModel: async (modelKey, variant, selection) => {
      await updateLocalModelSelection({
        modelKey,
        ...selection,
        ...(variant !== undefined ? { variant } : {}),
      });
    },
    setDefaultAdvisor: async (selection) => {
      await updateLocalAdvisorSelection(selection);
    },
    removeProvider: removeLocalProviderConfig,
  } satisfies ModelSystemConfigPort;
}

/** Composes the single Runtime V2 owner for model resolution and Provider management. */
export function initializeModelSystem(options: InitializeModelSystemOptions): ModelSystemOwner {
  const providerPresets = new ProviderPresetCatalog({
    dataDir: options.config.read().dataDir,
    previewSecret: process.env.PREVIEW_SECRET,
    lane: process.env.MAVIS_PLUGIN_CLOUD_LANE,
  });
  const resolver = new LocalModelResolver({
    ...options.resolverOptions,
    providerConfigGetter: () => options.config.read().provider,
    byokConfigGetter: () => {
      const config = options.config.read();
      return {
        ...(config.minimax_api ? { minimax_api: config.minimax_api } : {}),
        ...(config.custom_provider ? { custom_provider: config.custom_provider } : {}),
        ...(config.minimaxModelSource ? { minimaxModelSource: config.minimaxModelSource } : {}),
      };
    },
  });
  const oauth = new CodexOAuthManager({
    configGetter: options.config.read,
    fetchImpl: options.fetchImpl,
    updateByokConfig: options.config.updateByok,
    removeLegacyProvider: options.config.removeProvider,
  });
  const providers = new LocalModelProviderService({
    rankModelsByRecency: (input) => providerPresets.rankModelsByRecency(input),
    configGetter: options.config.read,
    updateByokConfig: options.config.updateByok,
    cache: new LocalModelCache(() => options.config.read().dataDir),
    tester: new ModelConnectionTester({ fetchImpl: options.fetchImpl }),
    discoverer: new ModelDiscoveryClient(options.fetchImpl),
    compareAndSetModelContext: options.config.compareAndSetModelContext,
    removeProviderCredentials: (providerKey) => oauth.removeCredentials(providerKey),
    selectModel: (modelKey) => options.config.setDefaultModel(modelKey),
    ...(options.implicitCustomProviderThinking ? { implicitCustomProviderThinking: true } : {}),
  });
  return {
    resolver,
    providers,
    oauth,
    listProviderPresets: () => providerPresets.listProviderPresets(),
    rankModelsByRecency: (input) => providerPresets.rankModelsByRecency(input),
  };
}
