import path from "node:path";

import { getRuntimeBuildEnv, getRuntimeRegion } from "@mavis/config";
import type { AgentHostTurnCapabilityLifecycle } from "../turn-system/index.js";

import type { MiniAppPluginPublicationCapability } from "../miniapp/index.js";
import { initializeHostConnectorSystem } from "../host-connector-system/index.js";
import { ConnectorCloudClient } from "./app/cloud-client.js";
import { DesktopConnectorRuntime } from "./app/runtime.js";
import { PluginSystemCloudTransport } from "./cloud-transport.js";
import type {
  InitializedPluginService,
  PluginServiceCompatibility,
} from "./contracts.js";
import { createPluginMcpAuthPort, PluginMcpCredentials } from "./mcp/oauth.js";
import { PluginMcpRuntime } from "./mcp/runtime.js";
import { GithubPluginImporter } from "./plugin/import/github-plugin-importer.js";
import { PluginDesktopFacade } from "./plugin/runtime/desktop-facade.js";
import {
  OfficialPluginAuthBarrier,
  resolveOfficialPluginAuthState,
} from "./plugin/runtime/official-operations.js";
import { OfficialPluginReconciler } from "./plugin/runtime/official-reconciler.js";
import { PluginRegistryClient } from "./plugin/runtime/registry-client.js";
import { SqlitePluginRepository } from "./plugin/runtime/repository.js";
import { PluginSystem } from "./plugin-system.js";

/** Assembles the Desktop Plugin service over narrow v1 compatibility ports. */
export function initializePluginService(
  compatibility: PluginServiceCompatibility,
  turnCapabilities: Pick<AgentHostTurnCapabilityLifecycle, "attach">,
  onPluginDeactivated?: (pluginName: string) => void,
): InitializedPluginService & MiniAppPluginPublicationCapability {
  const metricTags = {
    incr: (name: string, tags?: Record<string, string>) =>
      compatibility.metrics.counter(name, 1, tags ?? {}),
    latency: (
      name: string,
      durationMs: number,
      tags?: Record<string, string>,
    ) => compatibility.metrics.histogram(name, durationMs, tags ?? {}),
    gauge: (name: string, value: number, tags?: Record<string, string>) =>
      compatibility.metrics.gauge(name, value, tags ?? {}),
  };
  const deploymentGetter = () =>
    `${getRuntimeRegion()}-${getRuntimeBuildEnv()}`;
  const officialAuthState = () =>
    resolveOfficialPluginAuthState(compatibility.authContextGetter());
  const officialAuthBarrier = new OfficialPluginAuthBarrier({
    isReady: () =>
      officialAuthState() === "ready" && Boolean(deploymentGetter().trim()),
    isLoggedOut: () => officialAuthState() === "logged_out",
    metrics: metricTags,
    ...(onPluginDeactivated ? { onPluginDeactivated } : {}),
  });
  const mcpCredentials = compatibility.mcpOAuth
    ? new PluginMcpCredentials({
        service: compatibility.mcpOAuth,
        ...(compatibility.publishAuthRequired
          ? { publishAuthRequired: compatibility.publishAuthRequired }
          : {}),
        logger: compatibility.logger,
      })
    : undefined;
  const createPluginMcpRuntime = () =>
    new PluginMcpRuntime({
      names: compatibility.mcp.getRuntimeNameRegistry(),
      ...(mcpCredentials ? { auth: mcpCredentials } : {}),
      logger: {
        info: (message, fields) =>
          compatibility.logger.info(fields ?? {}, message),
        warn: (message, fields) =>
          compatibility.logger.warn(fields ?? {}, message),
        error: (message, fields) =>
          compatibility.logger.error(fields ?? {}, message),
      },
      metrics: metricTags,
    });
  const pluginMcpRuntime = createPluginMcpRuntime();
  const repository = new SqlitePluginRepository(compatibility.database);
  const cloudTransport = new PluginSystemCloudTransport({
    baseUrl: resolveCloudBaseUrl(),
    fetchImpl: compatibility.fetchImpl,
    authContextGetter: compatibility.authContextGetter,
    appVersion: compatibility.appVersion,
    previewSecret: process.env.PREVIEW_SECRET,
    lane: process.env.MAVIS_PLUGIN_CLOUD_LANE,
  });
  const registryClient = new PluginRegistryClient(cloudTransport);
  const githubImporter = new GithubPluginImporter({
    dataDir: compatibility.dataDir,
    fetchImpl: compatibility.fetchImpl,
  });
  const connectorClient = new ConnectorCloudClient(cloudTransport);
  const hostConnectorSystem = initializeHostConnectorSystem({
    client: connectorClient.asHostProcessClient(),
    credentialGetter: compatibility.authContextGetter,
    audit: {
      record: (event) =>
        compatibility.logger.info({ ...event }, "Host-process Connector audit"),
    },
    onAuditFailure: (error) =>
      compatibility.logger.warn(
        { errorType: error instanceof Error ? error.name : typeof error },
        "Host-process Connector audit failed",
      ),
  });
  const connectorRuntime = new DesktopConnectorRuntime({
    client: connectorClient,
    logger: {
      warn: (message, fields) =>
        compatibility.logger.warn(fields ?? {}, message),
    },
    metrics: metricTags,
    scopeKeyGetter: () => {
      const principalId = compatibility.authContextGetter()?.realUserID?.trim();
      const deployment = `${getRuntimeRegion()}-${getRuntimeBuildEnv()}`;
      return principalId
        ? JSON.stringify([principalId, deployment])
        : "custom-only";
    },
  });
  const officialCacheRoot = path.join(
    compatibility.dataDir,
    "v2",
    "plugin-cache",
    "official",
  );
  const system = new PluginSystem({
    mcpNames: compatibility.mcp.getRuntimeNameRegistry(),
    forbiddenPluginNames: compatibility.configGetter?.().plugins?.forbidden,
    ...(compatibility.configGetter?.().plugins?.onlyOfficial ? { onlyOfficialPlugins: true } : {}),
    ...(mcpCredentials ? { mcpCredentials } : {}),
    dataDir: compatibility.dataDir,
    officialCacheRoot,
    repository,
    authContextGetter: compatibility.authContextGetter,
    deploymentGetter,
    listReservations: compatibility.listReservations,
    connectorRuntime,
    mcpRuntime: pluginMcpRuntime,
    mcpRuntimeFactory: createPluginMcpRuntime,
    officialReconciler: new OfficialPluginReconciler({
      cacheRoot: officialCacheRoot,
      repository,
      client: registryClient,
    }),
    githubImporter,
    metrics: metricTags,
  });
  const unsubscribeMcpChanges = compatibility.mcp.onDidChangeServers(() =>
    system.markReservationsDirty(),
  );
  const unsubscribeSkillChanges =
    compatibility.skill.onDidChangeRuntimeSkills?.(() =>
      system.markReservationsDirty(),
    ) ?? (() => undefined);
  system.attachPublicationPort(turnCapabilities.attach(system));
  const plugin = new PluginDesktopFacade({
    system,
    registryClient,
    listStandaloneSkills: (input) => compatibility.skill.listSkills(input),
    standaloneSkillIdentities: compatibility.standaloneSkillIdentities,
    waitForOfficialAuth: () => officialAuthBarrier.waitUntilReady(),
    githubImporter,
    metrics: metricTags,
  });
  let readyPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  return {
    plugin,
    mcp: compatibility.mcp,
    mcpAuthPort: createPluginMcpAuthPort({
      get currentSnapshot() {
        return system.currentSnapshot;
      },
      waitUntilReady: () => system.waitUntilReady(),
      probeMcpServer: (serverName) => system.probeMcpServer(serverName),
      rediscoverMcpServers: (serverNames) => system.rediscoverMcpServers(serverNames),
    }),
    skill: compatibility.skill,
    hostConnectorGateway: hostConnectorSystem.gateway,
    attachMiniAppPublication: (input) =>
      system.miniAppPublication.attach(input),
    listAcceptedMiniApps: () =>
      system.miniAppPublication.listAcceptedMiniApps(),
    isAcceptedMiniAppRunning: (pluginId) =>
      system.miniAppPublication.isAcceptedMiniAppRunning(pluginId),
    listAvailableMiniApps: () =>
      system.miniAppPublication.listAvailableMiniApps(),
    activateMiniApp: (input) => system.miniAppPublication.activate(input),
    initializeWorkspaceMiniApp: (input) =>
      system.miniAppPublication.initializeWorkspace(input),
    publishWorkspaceMiniApp: (input) =>
      system.miniAppPublication.publishWorkspace(input),
    restartMiniApp: (input) => system.miniAppPublication.restart(input),
    stopMiniApp: (input) => system.miniAppPublication.stop(input),
    verifyMiniAppCandidate: (candidate) =>
      system.miniAppPublication.verifyCandidate(candidate),
    materializeMiniAppRuntimePackage: (input) =>
      system.miniAppPublication.materializeRuntimePackage(input),
    authContextChanged: () => {
      officialAuthBarrier.authContextChanged();
      hostConnectorSystem.authContextChanged();
      connectorRuntime.authContextChanged();
      system.authContextChanged();
    },
    enabledHookPluginNames: () =>
      new Set(
        (system.currentSnapshot.turnCapabilities.hooks ?? []).map(
          (handler) => handler.pluginName,
        ),
      ),
    ready: () => {
      readyPromise ??= system.initialize();
      return readyPromise;
    },
    close: () => {
      closePromise ??= (async () => {
        officialAuthBarrier.dispose();
        unsubscribeMcpChanges();
        unsubscribeSkillChanges();
        try {
          await system.dispose();
        } finally {
          await hostConnectorSystem.close();
        }
      })();
      return closePromise;
    },
  };
}

function resolveCloudBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_DOMAIN_URL?.trim();
  if (configured) return configured;
  const region = getRuntimeRegion();
  const build = getRuntimeBuildEnv();
  if (region === "cn") {
    if (build === "test" || build === "dev")
      return "https://matrix-test.example.invalid";
    if (build === "staging") return "https://matrix-pre.example.invalid";
    return "https://agent.minimax.cn";
  }
  if (build === "test" || build === "dev")
    return "https://matrix-overseas-test.example.invalid";
  if (build === "staging") return "https://matrix-overseas-pre.example.invalid";
  return "https://agent.minimax.io";
}

/** Standalone Skill and ordinary MCP names reserve the namespace before Plugin snapshots are built. */
export function createPluginNameReservations(
  skill: PluginServiceCompatibility["skill"],
  mcp: PluginServiceCompatibility["mcp"],
): PluginServiceCompatibility["listReservations"] {
  return async () => {
    const [skills, servers] = await Promise.all([
      skill.listRuntimeSkills(),
      mcp.listServers(),
    ]);
    return {
      skillNames: skills.skills.map((entry) => entry.name),
      mcpServerNames: servers.flatMap((server) =>
        server["enabled"] !== false && typeof server["name"] === "string"
          ? [server["name"]]
          : [],
      ),
      toolNames: [],
    };
  };
}
