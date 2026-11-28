import type { McpAuthRequiredError } from '@mavis/mcp';
import { LOCAL_PLUGIN_MARKETPLACE } from '@mavis/shared';
import path from 'node:path';

import type {
  AgentHostTurnCapabilityPreparation,
  AgentHostTurnCapabilityProvider,
  AgentHostTurnCapabilityView,
  AgentHostTurnPublicationPort,
} from '../turn-system/index.js';
import { EMPTY_CONNECTOR_RUNTIME, type ConnectorRuntimePort } from './app/runtime.js';
import type {
  LocalPluginMutationResult,
  OfficialPluginLocalState,
  PluginSnapshotBuildInputs as SnapshotBuildInputs,
  PluginSnapshotBuildOptions as SnapshotBuildOptions,
  PluginSystemOptions,
} from './contracts.js';
import { PluginSystemError } from './errors.js';
import { PluginSystemMetrics } from './metrics.js';
import { PluginCapabilityGenerationRegistry } from './mcp/generation-registry.js';
import { PluginMcpRuntime, type PluginMcpRuntimePort } from './mcp/runtime.js';
import { PluginMiniAppPublicationController } from './plugin/runtime/miniapp/controller.js';
import {
  deferred,
  assertPluginSystemPublicationAttached,
  capturePluginSystemTurnCapabilities,
  findLocalPlugin,
  ignoreFailure,
  normalizedPluginName,
  preparePluginSystemTurnCapabilities,
  runAfter,
  scopeKey,
  settleInBackground,
  waitForScopedOperation,
  type Deferred,
} from './plugin-system-helpers.js';
import type { GithubPluginSource } from './plugin/import/github-source.js';
import type { ReadPluginPackage } from './plugin/package/types.js';
import type {
  OfficialPluginInstallationRecord,
  PluginRepositoryScope,
} from './plugin/runtime/repository.js';
import {
  LocalPluginDirectoryWatcher,
  type LocalPluginDirectoryWatcherPort,
} from './plugin/runtime/local-directory-watcher.js';
import {
  MarketplacePreviewCache,
  PluginMarketplacePreview,
} from './plugin/runtime/marketplace-preview.js';
import {
  decidePreparedOfficialSync,
  handleIncompleteOfficialSync,
  OfficialPluginRecovery,
  prepareOfficialFullState,
  prepareOfficialMutation,
  waitForOfficialPublication,
  type OfficialSyncTrigger,
} from './plugin/runtime/official-operations.js';
import {
  buildCustomOnlySnapshot,
  localSnapshotInventory,
  readPluginSnapshotInputs,
  removedPluginHookNames,
} from './plugin/runtime/snapshot-inputs.js';
import {
  PluginPackageStorage,
  type StagedLocalPluginRoot,
} from './plugin/runtime/package-storage.js';
import {
  materializeOfficialPluginArchive,
  type MaterializeOfficialPluginArchiveInput,
  type MaterializedOfficialPluginArchive,
} from './plugin/package/archive-cache.js';
import type {
  OfficialPluginMutationState,
  PreparedOfficialPluginReconciliation,
} from './plugin/runtime/official-reconciler.js';
import {
  PluginSnapshotBuilder,
  withPluginMcpRuntime,
  withPluginSnapshotRevision,
  type PluginCapabilityReservations,
  type PluginSnapshot,
} from './plugin/runtime/snapshot-builder.js';
import {
  assertPluginPublicationFence,
  completePluginPublication,
  commitPreparedPluginPublication,
  isPublicationSuperseded,
  officialPublicationOptions,
  preparePluginPublication,
  recoverDestructivePluginPublication,
  throwRecoveredDestructivePublicationFailure,
  preparedPluginPublicationFinalizer,
  PluginMcpDiscoveryScheduler,
  rollbackPreparedPluginPublication,
  sameLocalPluginProjection,
  type PendingPluginPublication as PendingPublication,
  type PluginPublicationOptions as PublicationOptions,
  type PreparedPluginPublication as PreparedPublication,
} from './publication.js';

export type {
  LocalPluginMutationResult,
  OfficialPluginLocalState,
  PluginSystemOptions,
} from './contracts.js';
export class PluginSystem implements AgentHostTurnCapabilityProvider {
  private readonly builder = new PluginSnapshotBuilder();
  private readonly initialization = deferred<void>();
  private initializeStarted = false;
  private initializationTask: Promise<void> | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private publicationPort: AgentHostTurnPublicationPort | undefined;
  private pendingPublication: PendingPublication | undefined;
  private publishing: Promise<void> | undefined;
  private publicationCompletion: Promise<void> | undefined;
  private fullSyncTask: Promise<void> | undefined;
  private fullSyncScopeKey = '';
  private fullSyncForcesPublication = false;
  private readonly officialRecovery: OfficialPluginRecovery;
  private readonly mcpDiscovery: PluginMcpDiscoveryScheduler;
  private readonly marketplacePreview: PluginMarketplacePreview;
  private readonly snapshotReservations = new WeakMap<
    PluginSnapshot,
    PluginCapabilityReservations
  >();
  readonly miniAppPublication: PluginMiniAppPublicationController;
  private lastCachedRestoreScopeKey = '';
  private cachedRestore:
    | { readonly scopeKey: string; readonly operation: Promise<void> }
    | undefined;
  private desiredScopeKey = '';
  private pendingMiniAppScopeRetirement: PluginSnapshot | undefined;
  private reservations: PluginCapabilityReservations = {
    skillNames: [],
    mcpServerNames: [],
    toolNames: [],
  };
  private revision = 0;
  private snapshotPreparationRevision = 0;
  private officialStateRevision = 0;
  private localStateRevision = 0;
  private disposed = false;
  private readonly disposalController = new AbortController();
  private snapshot: PluginSnapshot = this.builder.build({
    revision: 'plugin-snapshot-0',
    officialPackages: [],
    localPackages: [],
    isLocalEnabled: () => true,
    reservations: { skillNames: [], mcpServerNames: [], toolNames: [] },
  });
  private desiredSnapshot = this.snapshot;
  private mcpRuntime: PluginMcpRuntimePort;
  private readonly capabilityGenerations: PluginCapabilityGenerationRegistry;
  private readonly metrics: PluginSystemMetrics;
  private readonly connectorRuntime: ConnectorRuntimePort;
  private readonly packageStorage: PluginPackageStorage;
  private readonly localDirectoryWatcher: LocalPluginDirectoryWatcherPort;
  readonly forbiddenPluginNames: ReadonlySet<string>;

  constructor(private readonly options: PluginSystemOptions) {
    this.forbiddenPluginNames = new Set(
      (options.forbiddenPluginNames ?? []).map((name) =>
        name.trim().normalize('NFKC').toLocaleLowerCase('en-US'),
      ),
    );
    this.builder = new PluginSnapshotBuilder(options.mcpNames, {
      forbiddenPluginNames: this.forbiddenPluginNames,
      ...(options.onlyOfficialPlugins ? { onlyOfficialPlugins: true } : {}),
    });
    this.metrics = new PluginSystemMetrics(options.metrics);
    this.packageStorage = new PluginPackageStorage({
      dataDir: options.dataDir,
      officialCacheRoot: options.officialCacheRoot,
      repository: options.repository,
      metrics: this.metrics,
    });
    this.marketplacePreview = new PluginMarketplacePreview({
      cache: new MarketplacePreviewCache(),
      initialize: () => this.initialization.promise,
      assertUsable: () => this.assertUsable(),
      readScope: () => this.readScope(),
      desiredScopeKey: () => this.desiredScopeKey,
      activateScopeBoundary: (scope) => this.activateScopeBoundary(scope),
      scheduleCachedRestore: () => this.scheduleCachedRestore(true),
      currentSnapshot: () => this.currentSnapshot,
      desiredSnapshot: () => this.desiredSnapshot,
      readSnapshotBuildInputs: (scope, desiredSnapshot) =>
        this.readSnapshotBuildInputs(scope, false, {}, desiredSnapshot),
      builder: this.builder,
      isLocalEnabled: (root) => this.options.repository.isLocalPluginEnabled(root),
      recordBuildContext: (snapshot, context) =>
        this.miniAppPublication.recordBuildContext(snapshot, context),
    });
    this.miniAppPublication = new PluginMiniAppPublicationController({
      host: this,
      packageStorage: this.packageStorage,
      builder: this.builder,
      isLocalEnabled: (root) => this.options.repository.isLocalPluginEnabled(root),
      recordReservations: (snapshot, reservations) =>
        this.snapshotReservations.set(snapshot, reservations),
      initializeStarted: () => this.initializeStarted,
      isDisposed: () => this.disposed,
      getDesiredSnapshot: () => this.desiredSnapshot,
      setDesiredSnapshot: (snapshot) => {
        this.desiredSnapshot = snapshot;
      },
      preparePublication: (snapshot, publicationOptions) =>
        this.preparePublication(snapshot, publicationOptions),
      queuePublication: (publication) => this.queuePublication(publication),
      readAvailableSnapshot: () => this.marketplacePreview.read({ reuseCached: true }),
      readOfficialInstallations: () => this.listOfficialPluginInstallations(),
      readSnapshotBuildInputs: () => this.readSnapshotBuildInputs(this.readScope(), false, {}),
      recordLocalMutation: () => {
        this.localStateRevision += 1;
        this.marketplacePreview.invalidate();
      },
    });
    const onLocalDirectoryChange = () => this.publishExternalLocalPluginChanges();
    this.localDirectoryWatcher = options.localDirectoryWatcherFactory
      ? options.localDirectoryWatcherFactory(onLocalDirectoryChange)
      : new LocalPluginDirectoryWatcher(
          path.join(options.dataDir, 'plugins'),
          onLocalDirectoryChange,
        );
    this.mcpRuntime = options.mcpRuntime ?? new PluginMcpRuntime();
    this.capabilityGenerations = new PluginCapabilityGenerationRegistry(
      this.snapshot.revision,
      this.mcpRuntime,
    );
    this.connectorRuntime = options.connectorRuntime ?? EMPTY_CONNECTOR_RUNTIME;
    this.officialRecovery = new OfficialPluginRecovery({
      delaysMs: options.officialRecoveryDelaysMs,
      isCurrentScope: (requested) => !this.disposed && requested === this.desiredScopeKey,
      synchronize: async (requested) => {
        if (requested !== this.desiredScopeKey) return;
        await this.synchronizeOfficialState(true, 'recovery');
      },
    });
    this.mcpDiscovery = new PluginMcpDiscoveryScheduler({
      delaysMs: options.mcpDiscoveryDelaysMs,
      drainTimeoutMs: options.mcpDiscoveryDrainTimeoutMs,
      prepare: (snapshot) => this.preparePublication(snapshot, {}, 'discover'),
      isCurrent: (expectedRevision, requestedScopeKey) =>
        !this.disposed &&
        requestedScopeKey === this.desiredScopeKey &&
        expectedRevision === this.snapshot.revision,
      queue: (publication) => this.queuePublication(publication),
    });
  }

  get currentSnapshot(): PluginSnapshot {
    return this.snapshot;
  }
  attachPublicationPort(port: AgentHostTurnPublicationPort): void {
    if (this.publicationPort)
      throw new PluginSystemError('ALREADY_ATTACHED', 'publication port is already attached');
    this.publicationPort = port;
  }

  initialize(): Promise<void> {
    if (this.initializeStarted) return this.initialization.promise;
    this.initializeStarted = true;
    this.initializationTask = this.initializeOnce();
    return this.initialization.promise;
  }

  async waitUntilReady(_options?: { readonly allowPendingPublication: boolean }): Promise<void> {
    await this.initialization.promise;
    this.assertUsable();
    this.captureOfficialScope();
    await Promise.all([
      waitForScopedOperation(
        this.cachedRestore,
        this.desiredScopeKey,
        this.options.cacheRestoreAdmissionTimeoutMs,
      ),
      this.localDirectoryWatcher.whenIdle(),
    ]);
    this.assertUsable();
  }

  async prepareTurnCapabilities(signal?: AbortSignal): Promise<AgentHostTurnCapabilityPreparation> {
    this.assertUsable();
    return preparePluginSystemTurnCapabilities(this.connectorRuntime, signal);
  }

  captureTurnCapabilities(
    preparation?: AgentHostTurnCapabilityPreparation,
  ): AgentHostTurnCapabilityView {
    return capturePluginSystemTurnCapabilities(this.snapshot.turnCapabilities, preparation);
  }

  retainTurnCapabilities(capabilities: AgentHostTurnCapabilityView): void {
    this.capabilityGenerations.retain(capabilities.revision);
  }

  releaseTurnCapabilities(capabilities: AgentHostTurnCapabilityView): void {
    this.capabilityGenerations.release(capabilities.revision);
  }

  onHostIdle(): void {
    this.attemptPublication();
  }

  authContextChanged(): void {
    if (this.disposed || !this.initializeStarted) return;
    this.captureOfficialScope();
  }

  markReservationsDirty(): void {
    this.marketplacePreview.invalidate();
    if (this.initializeStarted) this.scheduleCachedRebuild();
  }

  async probeMcpServer(serverName: string): Promise<'connected' | McpAuthRequiredError | Error> {
    this.assertUsable();
    return (
      (await this.mcpRuntime.probe?.(serverName)) ?? new Error('Plugin MCP probe is unavailable')
    );
  }

  async rediscoverMcpServers(serverNames: readonly string[]): Promise<void> {
    await this.initialization.promise;
    this.assertUsable();
    await this.runExclusive(async () => {
      this.mcpRuntime.forgetInventories?.(serverNames);
      await this.rebuildForCurrentScope(false);
    });
  }

  async refresh(): Promise<void> {
    await this.initialization.promise;
    this.assertUsable();
    this.marketplacePreview.invalidate();
    const scope = this.readScope();
    if (scopeKey(scope) !== this.desiredScopeKey) {
      this.activateScopeBoundary(scope);
      this.scheduleCachedRestore(false);
    }
    const requestedScopeKey = scopeKey(this.readScope());
    this.officialRecovery.cancelDelay();
    try {
      await this.synchronizeOfficialState(true, 'manual');
    } catch (error) {
      this.officialRecovery.schedule(requestedScopeKey);
      throw error;
    }
  }

  async refreshLocalPluginsForMarketplace(
    options: { reuseCached?: boolean } = {},
  ): Promise<PluginSnapshot> {
    const next = await this.marketplacePreview.read(options);
    if (!sameLocalPluginProjection(next, this.desiredSnapshot)) {
      this.scheduleCachedRebuild(true);
    }
    return next;
  }

  captureOfficialScope(): PluginRepositoryScope | undefined {
    const scope = this.readScope();
    if (scopeKey(scope) !== this.desiredScopeKey) {
      this.activateScopeBoundary(scope);
      this.scheduleCachedRestore(true);
    }
    return scope ? { ...scope } : undefined;
  }

  requestOfficialRecovery(expectedScope: PluginRepositoryScope): void {
    if (
      this.disposed ||
      scopeKey(expectedScope) !== this.desiredScopeKey ||
      scopeKey(expectedScope) !== scopeKey(this.readScope())
    ) {
      return;
    }
    this.officialRecovery.request(scopeKey(expectedScope));
  }

  async applyOfficialMutation(
    mutation: OfficialPluginMutationState,
    expectedScope: PluginRepositoryScope,
  ): Promise<void> {
    await this.initialization.promise;
    this.assertUsable();
    if (!this.options.officialReconciler?.reconcileMutation) {
      throw new PluginSystemError('AUTH_REQUIRED', 'official Plugin mutation requires identity');
    }
    if (scopeKey(expectedScope) !== scopeKey(this.readScope())) {
      throw new PluginSystemError('SCOPE_CHANGED', 'official Plugin identity changed');
    }
    await this.runExclusive(async () => {
      const isCurrentScope = () =>
        scopeKey(expectedScope) === this.desiredScopeKey &&
        scopeKey(expectedScope) === scopeKey(this.readScope());
      if (!isCurrentScope()) {
        throw new PluginSystemError('SCOPE_CHANGED', 'official Plugin identity changed');
      }
      const completion = deferred<void>();
      const prepared = await prepareOfficialMutation({
        reconciler: this.options.officialReconciler,
        scope: expectedScope,
        mutation,
        shouldCommit: isCurrentScope,
        signal: this.disposalController.signal,
      });
      try {
        if (!isCurrentScope()) {
          throw new PluginSystemError('SCOPE_CHANGED', 'official Plugin identity changed');
        }
        const next = await this.buildSnapshot(expectedScope, true, {
          ...(prepared ? { officialState: prepared.state } : {}),
        });
        if (!isCurrentScope()) {
          throw new PluginSystemError('SCOPE_CHANGED', 'official Plugin identity changed');
        }
        await this.miniAppPublication.prepareSnapshotPublication(
          next,
          officialPublicationOptions(
            prepared,
            completion,
            () => new PluginSystemError('SCOPE_CHANGED', 'official Plugin identity changed'),
          ),
        );
        this.officialStateRevision += 1;
        this.marketplacePreview.invalidate();
        if (!mutation.installExists || !mutation.enabled) {
          this.options.onPluginDeactivated?.(mutation.pluginName);
        }
      } catch (error) {
        await prepared?.abort();
        throw error;
      }
    });
  }

  async listOfficialPluginInstallations(): Promise<readonly OfficialPluginInstallationRecord[]> {
    await this.initialization.promise;
    const scope = this.captureOfficialScope();
    if (!scope) return [];
    try {
      return this.options.repository.loadOfficialState(scope)?.installations ?? [];
    } catch {
      return [];
    }
  }

  async listOfficialPluginStates(): Promise<readonly OfficialPluginLocalState[]> {
    const installations = await this.listOfficialPluginInstallations();
    return Promise.all(
      installations
        .filter((item) => item.installed)
        .map(async (installation) => ({
          installation,
          plugin: await this.packageStorage.readCurrentOfficialPlugin(installation),
        })),
    );
  }

  materializeOfficialArchive(
    input: Omit<MaterializeOfficialPluginArchiveInput, 'cacheRoot'>,
  ): Promise<MaterializedOfficialPluginArchive> {
    this.assertUsable();
    return materializeOfficialPluginArchive({
      ...input,
      cacheRoot: this.options.officialCacheRoot,
    });
  }

  async setLocalPluginEnabled(
    pluginName: string,
    enabled: boolean,
  ): Promise<LocalPluginMutationResult> {
    await this.initialization.promise;
    this.assertUsable();
    return this.runExclusive(async () => {
      const inputs = await this.readSnapshotBuildInputs(this.readScope(), false, {});
      const discovered = this.marketplacePreview.buildFromInputs(inputs);
      const target = findLocalPlugin(discovered, pluginName);
      if (!target) {
        throw new PluginSystemError('PLUGIN_NOT_FOUND', 'local Plugin is not installed');
      }
      const priorEnabled = this.options.repository.isLocalPluginEnabled(target.rootPath);
      const completion = deferred<void>();
      const next = this.miniAppPublication.buildPublicationSnapshot(inputs, {
        localEnabledOverrides: new Map([[target.rootPath, enabled]]),
      });
      await this.miniAppPublication.prepareSnapshotPublication(next, {
        completion,
        commit: async () => this.options.repository.setLocalPluginEnabled(target.rootPath, enabled),
        rollback: async () =>
          this.options.repository.setLocalPluginEnabled(target.rootPath, priorEnabled),
      });
      this.localStateRevision += 1;
      if (!enabled) this.options.onPluginDeactivated?.(target.name);
      this.marketplacePreview.invalidate();
      return { installExists: true, enabled };
    });
  }

  async uninstallLocalPlugin(pluginName: string): Promise<LocalPluginMutationResult> {
    await this.initialization.promise;
    this.assertUsable();
    return this.runExclusive(async () => {
      const inputs = await this.readSnapshotBuildInputs(this.readScope(), false, {});
      const discovered = this.marketplacePreview.buildFromInputs(inputs);
      const target = findLocalPlugin(discovered, pluginName);
      if (!target) return { installExists: false, enabled: false };
      const rootPath = target.rootPath;
      const priorEnabled = this.options.repository.isLocalPluginEnabled(rootPath);
      const completion = deferred<void>();
      const next = this.miniAppPublication.buildPublicationSnapshot(inputs, {
        excludedLocalRoots: new Set([rootPath]),
      });
      let staged: StagedLocalPluginRoot | undefined;
      await this.miniAppPublication.prepareSnapshotPublication(next, {
        completion,
        commit: async () => {
          staged = await this.packageStorage.stageAcceptedLocalRoot(rootPath);
          this.options.repository.setLocalPluginEnabled(rootPath, true);
        },
        rollback: async () => {
          try {
            this.options.repository.setLocalPluginEnabled(rootPath, priorEnabled);
          } finally {
            await staged?.restore();
          }
        },
        finalize: async () => {
          await staged?.discard();
          await this.options.mcpCredentials?.deleteLocalPlugin({
            name: target.name,
            marketplace: LOCAL_PLUGIN_MARKETPLACE,
          });
        },
      });
      this.localStateRevision += 1;
      this.options.onPluginDeactivated?.(target.name);
      this.marketplacePreview.invalidate();
      return { installExists: false, enabled: false };
    });
  }

  async importGithubPlugin(source: GithubPluginSource): Promise<ReadPluginPackage> {
    await this.initialization.promise;
    this.assertUsable();
    if (!this.options.githubImporter) {
      throw new PluginSystemError(
        'PLUGIN_IMPORT_UNAVAILABLE',
        'GitHub Plugin import is unavailable',
      );
    }
    const prepared = await this.options.githubImporter.prepare(source);
    try {
      if (!prepared.canImport) {
        throw new PluginSystemError(
          'PLUGIN_NO_SUPPORTED_CAPABILITY',
          'Plugin contains no valid Skill, MCP, or Hook capability',
        );
      }
      return await this.runExclusive(async () => {
        const officialInstallations = await this.listOfficialPluginInstallations();
        const currentInputs = await this.readSnapshotBuildInputs(this.readScope(), false, {});
        const current = this.marketplacePreview.buildFromInputs(currentInputs);
        const key = normalizedPluginName(prepared.plugin.name);
        if (
          officialInstallations.some(
            (item) => item.installed && normalizedPluginName(item.name) === key,
          ) ||
          current.localPlugins.some((item) => normalizedPluginName(item.name) === key)
        ) {
          throw new PluginSystemError('PLUGIN_ALREADY_EXISTS', 'Plugin name is already installed');
        }
        const accepted = await this.packageStorage.acceptImportedLocalRoot(
          prepared.stagingRoot,
          prepared.plugin.name,
        );
        try {
          const nextInputs = await this.readSnapshotBuildInputs(this.readScope(), false, {});
          const imported = nextInputs.localPackages.find(
            (item) => normalizedPluginName(item.plugin.name) === key,
          )?.plugin;
          if (!imported) {
            throw new PluginSystemError(
              'PLUGIN_IMPORT_INVALID',
              'Imported Plugin was not readable',
            );
          }
          const completion = deferred<void>();
          const next = this.miniAppPublication.buildPublicationSnapshot(nextInputs, {});
          await this.miniAppPublication.prepareSnapshotPublication(next, {
            completion,
            commit: async () =>
              this.options.repository.setLocalPluginEnabled(accepted.rootPath, true),
            rollback: accepted.restore,
          });
          this.localStateRevision += 1;
          this.marketplacePreview.invalidate();
          return imported;
        } catch (error) {
          await ignoreFailure(accepted.restore());
          throw error;
        }
      });
    } finally {
      await prepared.discard();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.localDirectoryWatcher.close();
    this.disposalController.abort();
    this.snapshotPreparationRevision += 1;
    const error = new PluginSystemError('DISPOSED', 'PluginSystem is disposed');
    this.pendingPublication?.completion?.reject(error);
    if (this.pendingPublication) this.metrics.publication(this.pendingPublication, 'superseded');
    await ignoreFailure(this.pendingPublication?.cancel?.());
    this.pendingPublication = undefined;
    await ignoreFailure(this.publishing);
    await ignoreFailure(this.publicationCompletion);
    await ignoreFailure(this.initializationTask);
    await this.operationTail;
    await this.localDirectoryWatcher.whenIdle();
    await ignoreFailure(this.fullSyncTask);
    await this.officialRecovery.dispose();
    await this.mcpDiscovery.dispose();
    await this.capabilityGenerations.dispose();
    await this.miniAppPublication.close();
  }

  private async initializeOnce(): Promise<void> {
    try {
      assertPluginSystemPublicationAttached(Boolean(this.publicationPort));
      this.desiredScopeKey = scopeKey(this.readScope());
      await this.localDirectoryWatcher.start();
      this.scheduleCachedRestore(true);
      this.initialization.resolve();
    } catch (error) {
      this.initialization.reject(error);
    }
  }

  private async rebuildForCurrentScope(
    pruneMissingLocalPlugins = false,
    scope = this.readScope(),
    buildOptions: SnapshotBuildOptions = {},
    publicationOptions: PublicationOptions = {},
  ): Promise<boolean> {
    const next = await this.buildSnapshot(scope, pruneMissingLocalPlugins, buildOptions);
    if (scopeKey(scope) !== this.desiredScopeKey) return false;
    await this.miniAppPublication.prepareSnapshotPublication(next, publicationOptions);
    return true;
  }

  private async preparePublication(
    next: PluginSnapshot,
    options: PublicationOptions,
    inventoryMode: 'cached-only' | 'discover' = 'cached-only',
    currentSnapshot = this.snapshot,
  ): Promise<PendingPublication> {
    const intendedScopeKey = this.desiredScopeKey;
    const preparationRevision = this.options.mcpRuntimeFactory
      ? ++this.snapshotPreparationRevision
      : this.snapshotPreparationRevision;
    const prepared = await preparePluginPublication({
      snapshot: this.miniAppPublication.projectOrdinaryPublication(next),
      currentSnapshot,
      publicationScopeKey: intendedScopeKey,
      options,
      ...(this.miniAppPublication.participant
        ? { participant: this.miniAppPublication.participant }
        : {}),
      ...(this.options.mcpRuntimeFactory ? { factory: this.options.mcpRuntimeFactory } : {}),
      currentRuntime: this.mcpRuntime,
      inventoryMode,
      signal: this.disposalController.signal,
      buildSnapshot: (inputs, buildOptions) =>
        this.miniAppPublication.buildPublicationSnapshot(inputs, buildOptions),
      isDisposed: () => this.disposed,
      isSuperseded: () => preparationRevision !== this.snapshotPreparationRevision,
    });
    this.miniAppPublication.materializeBuildContext(prepared.snapshot);
    const reservations =
      this.snapshotReservations.get(prepared.snapshot) ?? this.snapshotReservations.get(next);
    if (reservations) this.snapshotReservations.set(prepared.snapshot, reservations);
    return prepared.publication;
  }

  private scheduleCachedRestore(startFullSync = false): void {
    const scope = this.readScope();
    const cachedRestore = this.restoreCachedScope(scope);
    const requestedScopeKey = scopeKey(scope);
    this.cachedRestore = { scopeKey: requestedScopeKey, operation: cachedRestore };
    settleInBackground(cachedRestore);
    if (startFullSync && scope && this.options.officialReconciler) {
      settleInBackground(
        (async () => {
          await cachedRestore;
          if (requestedScopeKey === this.desiredScopeKey) {
            await ignoreFailure(this.synchronizeOfficialState());
          }
        })(),
      );
    }
  }

  private scheduleCachedRebuild(pruneMissingLocalPlugins = false): void {
    const scope = this.readScope();
    settleInBackground(this.rebuildCachedScope(scope, pruneMissingLocalPlugins));
  }

  private async publishExternalLocalPluginChanges(): Promise<void> {
    if (this.disposed || !this.initializeStarted) return;
    this.marketplacePreview.invalidate();
    const scope = this.readScope();
    try {
      await this.runExclusive(async () => {
        if (this.disposed || scopeKey(scope) !== this.desiredScopeKey) return;
        const next = await this.buildSnapshot(scope, true);
        if (
          this.disposed ||
          scopeKey(scope) !== this.desiredScopeKey ||
          sameLocalPluginProjection(next, this.desiredSnapshot)
        ) {
          return;
        }
        this.localStateRevision += 1;
        const completion = deferred<void>();
        const removedHookPlugins = removedPluginHookNames(this.snapshot, next);
        await this.miniAppPublication.prepareSnapshotPublication(next, { completion });
        for (const pluginName of removedHookPlugins) {
          this.options.onPluginDeactivated?.(pluginName);
        }
      });
    } catch {
      this.marketplacePreview.invalidate();
    }
  }

  private synchronizeOfficialState(
    forcePublication = false,
    trigger: OfficialSyncTrigger = forcePublication ? 'manual' : 'startup',
  ): Promise<void> {
    const scope = this.readScope();
    const requestedScopeKey = scopeKey(scope);
    if (this.fullSyncTask) {
      if (
        trigger !== 'recovery' &&
        this.fullSyncScopeKey === requestedScopeKey &&
        (!forcePublication || this.fullSyncForcesPublication)
      ) {
        return this.fullSyncTask;
      }
      return this.retryFullSyncAfter(this.fullSyncTask, forcePublication, trigger);
    }
    const operation = this.performOfficialSynchronization(
      scope,
      requestedScopeKey,
      forcePublication,
      trigger,
    );
    const completion = this.completeFullSync(operation);
    this.fullSyncScopeKey = requestedScopeKey;
    this.fullSyncForcesPublication = forcePublication;
    this.fullSyncTask = completion;
    return completion;
  }

  private async restoreCachedScope(scope: PluginRepositoryScope | undefined): Promise<void> {
    const startedAt = Date.now();
    let status = 'success';
    try {
      await this.runExclusive(async () => {
        if (scopeKey(scope) !== this.desiredScopeKey) return;
        const completion = deferred<void>();
        const queued = await this.rebuildForCurrentScope(true, scope, {}, { completion });
        if (!queued) return;
        if (scopeKey(scope) === this.desiredScopeKey) {
          this.lastCachedRestoreScopeKey = scopeKey(scope);
        }
      });
    } catch {
      status = 'error';
    } finally {
      this.metrics.operation('cache_restore', status, startedAt);
    }
  }

  private async rebuildCachedScope(
    scope: PluginRepositoryScope | undefined,
    pruneMissingLocalPlugins: boolean,
  ): Promise<void> {
    try {
      await this.runExclusive(async () => {
        if (scopeKey(scope) !== this.desiredScopeKey) return;
        await this.rebuildForCurrentScope(pruneMissingLocalPlugins, scope);
      });
    } catch {
      this.marketplacePreview.invalidate();
    }
  }

  private async retryFullSyncAfter(
    current: Promise<void>,
    forcePublication: boolean,
    trigger: OfficialSyncTrigger,
  ): Promise<void> {
    await ignoreFailure(current);
    await this.synchronizeOfficialState(forcePublication, trigger);
  }

  private async completeFullSync(operation: Promise<void>): Promise<void> {
    try {
      await operation;
    } finally {
      this.fullSyncTask = undefined;
      this.fullSyncScopeKey = '';
      this.fullSyncForcesPublication = false;
    }
  }

  private async performOfficialSynchronization(
    scope: PluginRepositoryScope | undefined,
    requestedScopeKey: string,
    forcePublication: boolean,
    trigger: OfficialSyncTrigger,
  ): Promise<void> {
    while (!this.disposed && requestedScopeKey === this.desiredScopeKey) {
      const outcome = await this.performOfficialSynchronizationAttempt(
        scope,
        requestedScopeKey,
        forcePublication,
        trigger,
      );
      if (outcome === 'complete') return;
    }
  }

  private async performOfficialSynchronizationAttempt(
    scope: PluginRepositoryScope | undefined,
    requestedScopeKey: string,
    forcePublication: boolean,
    trigger: OfficialSyncTrigger,
  ): Promise<'complete' | 'retry'> {
    const expectedOfficialRevision = this.officialStateRevision;
    const expectedLocalRevision = this.localStateRevision;
    const isCurrentScope = () =>
      requestedScopeKey === this.desiredScopeKey &&
      requestedScopeKey === scopeKey(this.readScope());
    const prepared = await prepareOfficialFullState({
      reconciler: this.options.officialReconciler,
      scope,
      isCurrentScope,
      signal: this.disposalController.signal,
      trigger,
      record: (status, startedAt) => this.metrics.officialSync(trigger, status, startedAt),
      scheduleRecovery: () => this.officialRecovery.schedule(requestedScopeKey),
    });
    const decision = await decidePreparedOfficialSync({
      unavailable: this.disposed || requestedScopeKey !== this.desiredScopeKey,
      forcePublication,
      revisionChanged: expectedOfficialRevision !== this.officialStateRevision,
      cachedRestoreCurrent: this.lastCachedRestoreScopeKey === requestedScopeKey,
      prepared,
    });
    if (decision !== 'proceed') {
      if (decision === 'complete' && prepared?.incomplete) {
        handleIncompleteOfficialSync({
          trigger,
          failedPackageCount: prepared.failedPackageCount,
          scheduleRecovery: () => this.officialRecovery.schedule(requestedScopeKey),
        });
      }
      return decision;
    }
    const publication = await this.prepareOfficialPublication(scope, prepared);
    if (!publication) return 'retry';
    const queued = await this.enqueuePreparedOfficialPublication({
      requestedScopeKey,
      expectedOfficialRevision,
      expectedLocalRevision,
      next: publication.next,
      publication: publication.pending,
    });
    if (!queued) {
      await ignoreFailure(publication.pending.cancel?.());
      return 'retry';
    }
    const outcome = await waitForOfficialPublication({
      completion: publication.completion.promise,
      requestedScopeKey,
      currentScopeKey: () => this.desiredScopeKey,
    });
    if (outcome !== 'complete') return outcome;
    this.marketplacePreview.invalidate();
    if (prepared?.incomplete) {
      handleIncompleteOfficialSync({
        trigger,
        failedPackageCount: prepared.failedPackageCount,
        scheduleRecovery: () => this.officialRecovery.schedule(requestedScopeKey),
      });
      return 'complete';
    }
    this.officialRecovery.succeeded(requestedScopeKey);
    return 'complete';
  }

  private async prepareOfficialPublication(
    scope: PluginRepositoryScope | undefined,
    prepared: PreparedOfficialPluginReconciliation | undefined,
  ): Promise<
    | {
        readonly next: PluginSnapshot;
        readonly pending: PendingPublication;
        readonly completion: Deferred<void>;
      }
    | undefined
  > {
    let next: PluginSnapshot;
    try {
      next = await this.buildSnapshot(
        scope,
        true,
        prepared ? { officialState: prepared.state } : {},
      );
    } catch (error) {
      await prepared?.abort();
      throw error;
    }
    const completion = deferred<void>();
    try {
      const pending = await this.preparePublication(
        next,
        officialPublicationOptions(
          prepared,
          completion,
          () => new PluginSystemError('SCOPE_CHANGED', 'official Plugin identity changed'),
        ),
      );
      return { next, pending, completion };
    } catch (error) {
      if (isPublicationSuperseded(error) && !this.disposed) return undefined;
      throw error;
    }
  }

  private enqueuePreparedOfficialPublication(input: {
    readonly requestedScopeKey: string;
    readonly expectedOfficialRevision: number;
    readonly expectedLocalRevision: number;
    readonly next: PluginSnapshot;
    readonly publication: PendingPublication;
  }): Promise<boolean> {
    return this.runExclusive(async () => {
      if (
        this.disposed ||
        input.requestedScopeKey !== this.desiredScopeKey ||
        input.expectedOfficialRevision !== this.officialStateRevision ||
        input.expectedLocalRevision !== this.localStateRevision
      ) {
        return false;
      }
      this.desiredSnapshot = input.next;
      this.queuePublication(input.publication);
      return true;
    });
  }

  private activateScopeBoundary(scope: PluginRepositoryScope | undefined): void {
    if (this.snapshot.officialPackages.some(({ plugin }) => plugin?.miniapp)) {
      this.pendingMiniAppScopeRetirement ??= this.snapshot;
    }
    this.officialRecovery.scopeChanged();
    this.mcpDiscovery.scopeChanged();
    this.desiredScopeKey = scopeKey(scope);
    this.lastCachedRestoreScopeKey = '';
    this.snapshotPreparationRevision += 1;
    this.marketplacePreview.invalidate();
    const pending = this.pendingPublication;
    if (pending) {
      pending.completion?.reject(
        new PluginSystemError('SCOPE_CHANGED', 'Plugin publication identity changed'),
      );
      this.metrics.publication(pending, 'superseded');
      settleInBackground(ignoreFailure(pending.cancel?.()));
      this.pendingPublication = undefined;
    }
    this.revision += 1;
    const customOnly = buildCustomOnlySnapshot({
      builder: this.builder,
      revision: `plugin-snapshot-${this.revision}`,
      source: this.snapshot,
      isLocalEnabled: (root) => this.options.repository.isLocalPluginEnabled(root),
      reservations: this.reservations,
    });
    this.miniAppPublication.recordBuildContext(customOnly.snapshot, {
      input: customOnly.inputs,
      options: {},
    });
    const next = this.miniAppPublication.projectAcceptedSnapshot(
      customOnly.snapshot,
      this.snapshot,
    );
    const inventory = localSnapshotInventory(next, this.mcpRuntime.exportInventory?.());
    const nextRuntime = this.options.mcpRuntimeFactory?.() ?? new PluginMcpRuntime();
    if (inventory) nextRuntime.importInventory?.(inventory);
    this.mcpRuntime = nextRuntime;
    this.snapshot = next;
    this.desiredSnapshot = next;
    this.capabilityGenerations.replace(next.revision, nextRuntime);
    this.metrics.snapshot(next);
  }

  private async buildSnapshot(
    scope: PluginRepositoryScope | undefined,
    pruneMissingLocalPlugins = true,
    options: SnapshotBuildOptions = {},
  ): Promise<PluginSnapshot> {
    const input = await this.readSnapshotBuildInputs(scope, pruneMissingLocalPlugins, options);
    return this.miniAppPublication.buildPublicationSnapshot(input, options);
  }

  private async readSnapshotBuildInputs(
    scope: PluginRepositoryScope | undefined,
    pruneMissingLocalPlugins: boolean,
    options: SnapshotBuildOptions,
    desiredSnapshot: PluginSnapshot = this.desiredSnapshot,
  ): Promise<SnapshotBuildInputs> {
    return readPluginSnapshotInputs({
      packageStorage: this.packageStorage,
      repository: this.options.repository,
      listReservations: this.options.listReservations,
      desiredSnapshot,
      scope,
      pruneMissingLocalPlugins,
      buildOptions: options,
    });
  }

  private queuePublication(publication: PendingPublication): void {
    if (this.disposed) {
      publication.completion?.reject(new PluginSystemError('DISPOSED', 'PluginSystem is disposed'));
      settleInBackground(ignoreFailure(publication.cancel?.()));
      return;
    }
    this.pendingPublication?.completion?.reject(
      new PluginSystemError('PUBLICATION_SUPERSEDED', 'Plugin publication was superseded'),
    );
    if (this.pendingPublication) this.metrics.publication(this.pendingPublication, 'superseded');
    settleInBackground(ignoreFailure(this.pendingPublication?.cancel?.()));
    this.pendingPublication = publication;
    this.metrics.publicationQueued(publication);
    this.miniAppPublication.bindRestartCancellation(publication, () => {
      if (this.pendingPublication === publication) this.pendingPublication = undefined;
    });
    this.attemptPublication();
  }

  private attemptPublication(): void {
    if (this.disposed || this.publishing || !this.pendingPublication || !this.publicationPort)
      return;
    const pending = this.pendingPublication;
    const started = this.publicationPort.tryPublish(() => this.publishPending(pending));
    if (!started) return;
    this.publishing = started;
    this.publicationCompletion = completePluginPublication(started, pending, () => {
      if (this.publishing === started) this.publishing = undefined;
      if (this.pendingPublication) {
        this.attemptPublication();
        if (!this.publishing) setImmediate(() => this.attemptPublication());
      }
    });
  }

  private async publishPending(pending: PendingPublication): Promise<void> {
    if (this.pendingPublication === pending) this.pendingPublication = undefined;
    let prepared: PreparedPublication | undefined;
    let adoptedPreparedRuntime = false;
    try {
      prepared = await pending.prepare();
      assertPluginPublicationFence(pending.scopeKey, this.desiredScopeKey);
      if (prepared.preparedRuntime) {
        await this.publishPreparedRuntime(pending, prepared, prepared.preparedRuntime);
        adoptedPreparedRuntime = true;
      } else {
        await this.publishWithCurrentRuntime(pending, prepared);
      }
      this.metrics.publication(pending, 'success');
      if (pending.mcpDiscovery) {
        this.mcpDiscovery.published(pending.mcpDiscovery, this.snapshot, this.desiredScopeKey);
      }
    } catch (error) {
      if (prepared?.preparedRuntime && !adoptedPreparedRuntime) {
        await ignoreFailure(prepared.preparedRuntime.close());
      }
      if (prepared) await ignoreFailure(rollbackPreparedPluginPublication(prepared));
      const recovered = await recoverDestructivePluginPublication({
        pending,
        currentSnapshot: this.snapshot,
        currentRuntime: this.mcpRuntime,
        factory: this.options.mcpRuntimeFactory,
        adoptPrepared: (recovery) =>
          this.publishPreparedRuntime(
            {
              scopeKey: this.desiredScopeKey,
              prepare: async () => recovery,
            },
            recovery,
            recovery.preparedRuntime,
          ),
        adoptOwnerFailure: (snapshot) => {
          const adopted = this.adoptPublishedSnapshot(snapshot, this.snapshot);
          this.snapshot = adopted;
          this.desiredSnapshot = adopted;
          this.capabilityGenerations.replaceRevision(adopted.revision);
        },
      });
      if (!recovered && !prepared?.preparedRuntime) {
        await ignoreFailure(this.mcpRuntime.reconcile(this.snapshot.mcpServers));
      }
      this.metrics.publication(pending, 'error');
      throwRecoveredDestructivePublicationFailure(error, recovered);
      throw this.miniAppPublication.normalizePreparationError(error, prepared);
    }
  }

  private async publishPreparedRuntime(
    pending: PendingPublication,
    prepared: PreparedPublication,
    preparedRuntime: PluginMcpRuntimePort,
  ): Promise<void> {
    this.miniAppPublication.materializeBuildContext(prepared.snapshot, prepared.snapshotSource);
    await commitPreparedPluginPublication(prepared);
    assertPluginPublicationFence(pending.scopeKey, this.desiredScopeKey);
    this.mcpRuntime = preparedRuntime;
    const published = this.adoptPublishedSnapshot(prepared.snapshot);
    this.snapshot = published;
    this.desiredSnapshot = published;
    this.capabilityGenerations.replace(
      published.revision,
      preparedRuntime,
      preparedPluginPublicationFinalizer(prepared),
    );
    pending.completion?.resolve();
  }

  private async publishWithCurrentRuntime(
    pending: PendingPublication,
    prepared: PreparedPublication,
  ): Promise<void> {
    this.miniAppPublication.materializeBuildContext(prepared.snapshot, prepared.snapshotSource);
    if (this.capabilityGenerations.currentLeaseCount > 0) {
      throw new PluginSystemError(
        'MCP_RUNTIME_FACTORY_MISSING',
        'cannot publish a Plugin snapshot during execution without an MCP runtime factory',
      );
    }
    const mcp = await this.mcpRuntime.reconcile(prepared.snapshot.mcpServers);
    assertPluginPublicationFence(pending.scopeKey, this.desiredScopeKey);
    await commitPreparedPluginPublication(prepared);
    assertPluginPublicationFence(pending.scopeKey, this.desiredScopeKey);
    const published = withPluginMcpRuntime(
      prepared.snapshot,
      mcp.runtimeTools,
      mcp.runtimeToolBindings ?? [],
      mcp.diagnostics,
    );
    const reservations = this.snapshotReservations.get(prepared.snapshot);
    if (reservations) this.snapshotReservations.set(published, reservations);
    const adopted = this.adoptPublishedSnapshot(published, prepared.snapshot);
    this.snapshot = adopted;
    this.desiredSnapshot = adopted;
    this.capabilityGenerations.replaceRevision(adopted.revision);
    pending.completion?.resolve();
    const finalize = preparedPluginPublicationFinalizer(prepared);
    if (finalize) settleInBackground(ignoreFailure(finalize()));
  }

  private adoptPublishedSnapshot(
    snapshot: PluginSnapshot,
    buildContextSource: PluginSnapshot = snapshot,
  ): PluginSnapshot {
    const reservations = this.snapshotReservations.get(snapshot);
    if (reservations) this.reservations = reservations;
    this.revision += 1;
    const published = withPluginSnapshotRevision(snapshot, `plugin-snapshot-${this.revision}`);
    this.miniAppPublication.inheritBuildContext(buildContextSource, published);
    this.metrics.snapshot(published);
    return published;
  }

  private readScope(): PluginRepositoryScope | undefined {
    const principalId = this.options.authContextGetter()?.realUserID?.trim();
    const deployment = this.options.deploymentGetter().trim();
    if (!principalId || !deployment) return undefined;
    return { principalId, deployment };
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = runAfter(this.operationTail, async () => {
      this.captureOfficialScope();
      const previousScope = this.pendingMiniAppScopeRetirement;
      if (previousScope) {
        // Retire account-owned generations before the same cached package can be reused.
        // The synchronous scope boundary has already removed them from the visible snapshot.
        const completion = deferred<void>();
        this.queuePublication(
          await this.preparePublication(
            this.snapshot,
            { completion },
            'cached-only',
            previousScope,
          ),
        );
        await completion.promise;
        this.pendingMiniAppScopeRetirement = undefined;
      }
      return operation();
    });
    this.operationTail = ignoreFailure(result);
    return result;
  }

  assertUsable(): void {
    if (this.disposed) throw new PluginSystemError('DISPOSED', 'PluginSystem is disposed');
  }
}
