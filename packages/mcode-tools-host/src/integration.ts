import {
  installMcodeToolsLauncher,
  removeMcodeToolsLaunchers,
  validateMcodeToolsResource,
  type McodeToolsBuildEnv,
  type McodeToolsRegion,
} from './resource.js';
import { startMcodeToolsAuthLeaseBroker, type McodeToolsAuthLeaseBroker } from './lease-broker.js';
import type { McodeToolsHostAuthSession, McodeToolsHostLogger } from './contracts.js';

export interface StartMcodeToolsHostIntegrationOptions {
  dataDir: string;
  resourceDir: string;
  expectedBuildEnv: McodeToolsBuildEnv;
  executable: string;
  platform: NodeJS.Platform;
  region: McodeToolsRegion;
  bedrockLane?: string;
  /** App-owned launcher directory; see `resolveMcodeToolsHostBinDir`. */
  hostBinDir?: string;
  /**
   * Allocate a private broker directory instead of the fixed `<dataDir>/run` socket. Required
   * whenever another host may share the dataDir, otherwise the later broker replaces the socket
   * and capability the earlier App's launcher points at.
   */
  isolateBrokerInstance?: boolean;
  session: McodeToolsHostAuthSession;
  logger?: McodeToolsHostLogger;
}

export interface ActiveMcodeToolsHostIntegration {
  readonly launcherPath: string;
  readonly brokerEndpoint: string;
  readonly packageName: string;
  readonly version: string;
  dispose(): Promise<void>;
}

export interface McodeToolsHostIntegrationDependencies {
  validateResource: typeof validateMcodeToolsResource;
  startBroker: typeof startMcodeToolsAuthLeaseBroker;
  installLauncher: typeof installMcodeToolsLauncher;
  removeLaunchers: typeof removeMcodeToolsLaunchers;
}

const DEFAULT_DEPENDENCIES: McodeToolsHostIntegrationDependencies = {
  validateResource: validateMcodeToolsResource,
  startBroker: startMcodeToolsAuthLeaseBroker,
  installLauncher: installMcodeToolsLauncher,
  removeLaunchers: removeMcodeToolsLaunchers,
};

export async function startMcodeToolsHostIntegration(
  options: StartMcodeToolsHostIntegrationOptions,
  dependencies: McodeToolsHostIntegrationDependencies = DEFAULT_DEPENDENCIES,
): Promise<ActiveMcodeToolsHostIntegration> {
  const resource = dependencies.validateResource({
    resourceDir: options.resourceDir,
    expectedBuildEnv: options.expectedBuildEnv,
  });
  const broker = await dependencies.startBroker({
    dataDir: options.dataDir,
    ...(options.isolateBrokerInstance ? { isolateInstance: true } : {}),
    session: options.session,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  try {
    const installed = await dependencies.installLauncher({
      resourceDir: options.resourceDir,
      expectedBuildEnv: options.expectedBuildEnv,
      dataDir: options.dataDir,
      executable: options.executable,
      platform: options.platform,
      region: options.region,
      ...(options.bedrockLane ? { bedrockLane: options.bedrockLane } : {}),
      ...(options.hostBinDir ? { hostBinDir: options.hostBinDir } : {}),
      brokerEndpoint: broker.endpoint,
      brokerCapabilityFile: broker.capabilityFile,
    });
    return activeIntegration(options, dependencies, broker, installed.launcherPath, resource);
  } catch (error) {
    let cleanupError: unknown;
    try {
      dependencies.removeLaunchers(launcherOwnership(options));
    } catch (cause) {
      cleanupError = cause;
    }
    try {
      await broker.dispose();
    } catch (cause) {
      cleanupError = cleanupError
        ? new AggregateError([cleanupError, cause], 'mcode-tools startup cleanup failed')
        : cause;
    }
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], 'mcode-tools host integration failed');
    }
    throw error;
  }
}

function launcherOwnership(
  options: StartMcodeToolsHostIntegrationOptions,
): Parameters<typeof removeMcodeToolsLaunchers>[0] {
  return {
    dataDir: options.dataDir,
    executable: options.executable,
    region: options.region,
    platform: options.platform,
    ...(options.hostBinDir ? { hostBinDir: options.hostBinDir } : {}),
  };
}

function activeIntegration(
  options: StartMcodeToolsHostIntegrationOptions,
  dependencies: McodeToolsHostIntegrationDependencies,
  broker: McodeToolsAuthLeaseBroker,
  launcherPath: string,
  resource: ReturnType<typeof validateMcodeToolsResource>,
): ActiveMcodeToolsHostIntegration {
  let disposed = false;
  return {
    launcherPath,
    brokerEndpoint: broker.endpoint,
    packageName: resource.manifest.packageName,
    version: resource.manifest.version,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      let launcherError: unknown;
      try {
        dependencies.removeLaunchers(launcherOwnership(options));
      } catch (error) {
        launcherError = error;
      }
      try {
        await broker.dispose();
      } catch (error) {
        if (launcherError) {
          throw new AggregateError([launcherError, error], 'mcode-tools cleanup failed');
        }
        throw error;
      }
      if (launcherError) throw launcherError;
    },
  };
}
