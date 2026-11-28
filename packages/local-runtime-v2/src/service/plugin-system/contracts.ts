import type { McpNameRegistry } from "@mavis/mcp";
import type { LocalMcpService, McpOAuthService, PluginMcpAuthPort } from "../mcp/index.js";
import type {
  CreatedLocalRuntimeHost,
  LocalSkillService,
} from "@mavis/local-runtime";
import type {
  GetMarketplacePluginInput,
  GetMarketplacePluginResult,
  ListEnabledPluginsInput,
  ListEnabledPluginsResult,
  ListInstalledPluginsInput,
  ListInstalledPluginsResult,
  ListMarketplacePluginsInput,
  ListMarketplacePluginsResult,
  ImportGithubPluginInput,
  ImportGithubPluginResult,
  MutatePluginInput,
  MutatePluginResult,
  PreviewGithubPluginInput,
  PreviewGithubPluginResult,
} from "@mavis/protocol/local";
import type { AppDb } from "../../infra/db/client.js";
import type { HostProcessConnectorGateway } from "../host-connector-system/index.js";
import type { ConnectorRuntimePort } from "./app/runtime.js";
import type { PluginMcpRuntimePort } from "./mcp/runtime.js";
import type { PluginMcpAuthRequiredEvent, PluginMcpCredentialCleanup } from "./mcp/oauth.js";
import type { GithubPluginImporter } from "./plugin/import/github-plugin-importer.js";
import type {
  ReadPluginPackage,
  RuntimeEligibleScannedReadPluginPackage,
} from "./plugin/package/types.js";
import type {
  OfficialPluginMutationState,
  PreparedOfficialPluginReconciliation,
} from "./plugin/runtime/official-reconciler.js";
import type {
  OfficialPluginInstallationRecord,
  OfficialPluginRepositoryState,
  PluginRepositoryScope,
  SqlitePluginRepository,
} from "./plugin/runtime/repository.js";
import type { LocalPluginDirectoryWatcherPort } from "./plugin/runtime/local-directory-watcher.js";
import type { AcceptedMiniApp } from "./plugin/runtime/miniapp/candidate.js";

interface PluginCapabilityReservations {
  readonly skillNames: readonly string[];
  readonly mcpServerNames: readonly string[];
  readonly toolNames: readonly string[];
}

interface StandaloneSkillIdentities {
  readonly names: ReadonlySet<string>;
  readonly sourceUrls: ReadonlySet<string>;
}

export interface PluginServiceLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface PluginServiceMetrics {
  incr(name: string, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  latency(
    name: string,
    durationMs: number,
    tags?: Record<string, string>,
  ): void;
}

interface PluginSystemAuthContext {
  readonly accessToken?: string;
  readonly realUserID?: string;
  readonly authState?: "pending" | "authenticated" | "logged_out";
}

export interface PluginSystemOptions {
  readonly forbiddenPluginNames?: readonly string[];
  readonly onlyOfficialPlugins?: boolean;
  readonly mcpCredentials?: PluginMcpCredentialCleanup;
  readonly mcpNames?: McpNameRegistry;
  readonly dataDir: string;
  readonly officialCacheRoot: string;
  readonly repository: SqlitePluginRepository;
  readonly authContextGetter: () => PluginSystemAuthContext | undefined;
  readonly deploymentGetter: () => string;
  readonly listReservations: () => Promise<PluginCapabilityReservations>;
  readonly connectorRuntime?: ConnectorRuntimePort;
  readonly mcpRuntime?: PluginMcpRuntimePort;
  readonly mcpRuntimeFactory?: () => PluginMcpRuntimePort;
  readonly metrics?: PluginServiceMetrics;
  readonly officialReconciler?: {
    prepareReconcile?(
      scope: PluginRepositoryScope,
      shouldCommit?: () => boolean,
      signal?: AbortSignal,
    ): Promise<PreparedOfficialPluginReconciliation>;
    prepareMutation?(
      scope: PluginRepositoryScope,
      mutation: OfficialPluginMutationState,
      shouldCommit?: () => boolean,
      signal?: AbortSignal,
    ): Promise<PreparedOfficialPluginReconciliation>;
    reconcile(
      scope: PluginRepositoryScope,
      shouldCommit?: () => boolean,
    ): Promise<boolean>;
    reconcileMutation?(
      scope: PluginRepositoryScope,
      mutation: OfficialPluginMutationState,
      shouldCommit?: () => boolean,
    ): Promise<boolean>;
  };
  readonly githubImporter?: GithubPluginImporter;
  /** Test seam; production uses the native recursive filesystem watcher. */
  readonly localDirectoryWatcherFactory?: (
    onChange: () => Promise<void>,
  ) => LocalPluginDirectoryWatcherPort;
  /** Test seam; production admission waits at most 20 seconds for cached restore. */
  readonly cacheRestoreAdmissionTimeoutMs?: number;
  /** Test seam; production retries incomplete official sync after bounded backoff. */
  readonly officialRecoveryDelaysMs?: readonly number[];
  /** Test seam; production retries incomplete MCP discovery after bounded backoff. */
  readonly mcpDiscoveryDelaysMs?: readonly number[];
  /** Test seam; production waits at most five seconds for MCP discovery shutdown. */
  readonly mcpDiscoveryDrainTimeoutMs?: number;
  /** Composition callback used to invalidate per-session activation after disable/uninstall. */
  readonly onPluginDeactivated?: (pluginName: string) => void;
}

export interface LocalPluginMutationResult {
  readonly installExists: boolean;
  readonly enabled: boolean;
}

export interface OfficialPluginLocalState {
  readonly installation: OfficialPluginInstallationRecord;
  readonly plugin?: ReadPluginPackage;
}

export interface PluginSnapshotBuildOptions {
  readonly officialState?: OfficialPluginRepositoryState;
  readonly excludedLocalRoots?: ReadonlySet<string>;
  readonly localEnabledOverrides?: ReadonlyMap<string, boolean>;
}

export interface PluginSnapshotBuildInputs {
  readonly officialPackages: readonly {
    readonly plugin: RuntimeEligibleScannedReadPluginPackage;
    readonly contentDigest: string;
  }[];
  readonly localPackages: readonly {
    readonly plugin: RuntimeEligibleScannedReadPluginPackage;
    readonly contentDigest: string;
  }[];
  readonly reservations: PluginCapabilityReservations;
}

interface PluginServiceFacade {
  refresh(): Promise<void>;
  listMarketplacePlugins(
    req: ListMarketplacePluginsInput,
  ): Promise<ListMarketplacePluginsResult>;
  getMarketplacePlugin(
    req: GetMarketplacePluginInput,
  ): Promise<GetMarketplacePluginResult>;
  listInstalledPlugins(
    req: ListInstalledPluginsInput,
  ): Promise<ListInstalledPluginsResult>;
  listEnabledPlugins(
    req: ListEnabledPluginsInput,
  ): Promise<ListEnabledPluginsResult>;
  listEnabledPluginSkillSummaries(): Promise<
    readonly EnabledPluginSkillSummary[]
  >;
  installPlugin(req: MutatePluginInput): Promise<MutatePluginResult>;
  uninstallPlugin(req: MutatePluginInput): Promise<MutatePluginResult>;
  enablePlugin(req: MutatePluginInput): Promise<MutatePluginResult>;
  disablePlugin(req: MutatePluginInput): Promise<MutatePluginResult>;
  previewGithubPlugin(
    req: PreviewGithubPluginInput,
    signal?: AbortSignal,
  ): Promise<PreviewGithubPluginResult>;
  importGithubPlugin(
    req: ImportGithubPluginInput,
  ): Promise<ImportGithubPluginResult>;
}

export interface EnabledPluginSkillSummary {
  readonly runtimeName: string;
  readonly pluginName: string;
  readonly skillName: string;
  readonly pluginDisplayName?: string;
  readonly skillDisplayName?: string;
  readonly description?: string;
  readonly pluginIconUrl?: string;
  readonly pluginDarkIconUrl?: string;
}

/** Enabled, validated package definition; it does not imply an accepted runtime generation. */
export interface AvailableMiniAppDefinition {
  readonly pluginId: string;
  readonly source: "official" | "local";
  readonly displayName?: string;
  readonly description?: string;
  readonly iconPath?: string;
}

export interface WorkspaceMiniAppInitializationResult {
  readonly pluginId: string;
  readonly mode: "create" | "update";
  readonly packagePath: `miniapps/${string}` | `liveboards/${string}`;
}

/** Plugin-owned controls consumed by later MiniApp application workflows. */
export interface MiniAppPluginControl {
  listAcceptedMiniApps(): readonly AcceptedMiniApp[];
  /** True only when the accepted candidate still owns the authoritative active generation. */
  isAcceptedMiniAppRunning(pluginId: string): boolean;
  listAvailableMiniApps(): Promise<readonly AvailableMiniAppDefinition[]>;
  activateMiniApp(input: {
    readonly pluginId: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  restartMiniApp(input: {
    readonly pluginId: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  initializeWorkspaceMiniApp(input: {
    readonly workspaceRoot: string;
    readonly pluginId: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceMiniAppInitializationResult>;
  publishWorkspaceMiniApp(input: {
    readonly workspaceRoot: string;
    readonly pluginId: string;
    readonly sourcePath?: string;
    readonly signal?: AbortSignal;
  }): Promise<AcceptedMiniApp>;
  stopMiniApp(input: {
    readonly pluginId: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
}

interface MiniAppRuntimePackageMaterializer {
  materializeMiniAppRuntimePackage(input: {
    readonly sourceRoot: string;
    readonly targetRoot: string;
  }): Promise<void>;
}

/** Narrow v1 capabilities borrowed while Plugin System is migrated into v2 ownership. */
export interface PluginServiceCompatibility {
  readonly dataDir: string;
  readonly configGetter?: () => {
    readonly plugins?: { readonly forbidden: readonly string[]; readonly onlyOfficial?: boolean };
  };
  readonly mcpOAuth?: McpOAuthService;
  readonly publishAuthRequired?: (event: PluginMcpAuthRequiredEvent) => void;
  readonly database: AppDb;
  readonly logger: PluginServiceLogger;
  readonly authContextGetter: () => PluginSystemAuthContext | undefined;
  readonly fetchImpl: typeof fetch;
  readonly appVersion?: string;
  readonly metrics: CreatedLocalRuntimeHost["metricsClient"];
  readonly mcp: LocalMcpService;
  readonly skill: LocalSkillService;
  readonly listReservations: () => Promise<PluginCapabilityReservations>;
  readonly standaloneSkillIdentities: () => Promise<StandaloneSkillIdentities>;
}

export interface InitializedPluginService
  extends MiniAppPluginControl,
    MiniAppRuntimePackageMaterializer {
  readonly plugin: PluginServiceFacade;
  readonly mcp: LocalMcpService;
  readonly mcpAuthPort?: PluginMcpAuthPort;
  readonly skill: LocalSkillService;
  /** Host-process capability boundary for consumers composed by later feature slices. */
  readonly hostConnectorGateway: HostProcessConnectorGateway;
  /** Starts fail-open cache/full-state restoration after Desktop identity rotates. */
  authContextChanged(): void;
  /** Current enabled Plugin owners that contain at least one executable Hook. */
  enabledHookPluginNames(): ReadonlySet<string>;
  ready(): Promise<void>;
  close(): Promise<void>;
}
