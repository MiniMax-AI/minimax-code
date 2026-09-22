import type {
  CreateLocalRuntimeHostOptions,
  LocalRuntimeAuthContext,
  LocalRuntimeConfig,
} from '@mavis/local-runtime-v2/process-local';
import { getDefaultLocalRuntimeConfig } from '@mavis/local-runtime-v2';
import {
  getRuntimeBuildEnv,
  getRuntimeRegion,
  readExplicitBetaFeatureFromFile,
} from '@mavis/config';
import {
  AuthSessionChangedError,
  MCODE_OAUTH_SCOPES,
  requiresInteractiveLogin,
  resolveMCodeOAuthEndpointConfig,
  type AccessTokenLease,
  type AuthStatusSnapshot,
  type MCodeOAuthCore,
} from '@mavis/oauth-core';
import type { McodeToolsHostAuthSession } from '@mavis/mcode-tools-host';
import {
  createEmbeddedRuntimeHost,
  type EmbeddedRuntimeHost,
  type EmbeddedRuntimeHostFactory,
} from './embedded-host.js';
import { createTuiRuntimeLogging, type TuiRuntimeLogging } from './logging.js';
import { TuiRuntimeAdapter } from './adapter.js';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import {
  createTuiObservability,
  noopTuiObservability,
  type TuiObservability,
  type TuiObservabilitySurface,
} from '../observability/index.js';
import {
  TuiAuthenticationError,
  TuiMatrixAccountClient,
} from '../account/matrix-account-client.js';
import {
  invalidateCliAuthContext,
  importSharedCliAuthContext,
  readCliAuthContext,
  syncCliRuntimeAuthProjection,
  writeCliAuthContext,
  type CliAuthScope,
} from '../auth/storage.js';
import {
  readVerifiedCliAccountIdentity,
  writeRejectedCliAccountIdentity,
  writeVerifiedCliAccountIdentity,
} from '../auth/identity-storage.js';
import { resolveMcodeDataEnvironment } from '../auth/environment.js';
import { uploadTuiFeedbackDiagnostics } from './feedback/diagnostic-upload.js';
import { TuiFeedbackService } from './feedback/service.js';
import {
  createTuiBrowserProvider,
  disposeTuiBrowserSessionStorage,
  type TuiBrowserProvider,
} from './browser-provider.js';
import { TuiDailyCheckinApplication } from '../checkin/application.js';
import { TuiDailyCheckinHttpGateway } from '../checkin/http-gateway.js';
import { createMcodeSharedAuthSession } from './auth-session.js';
import { resolveTuiManagedBackendLane } from '../cli/environment.js';
import {
  prepareTuiMcodeToolsIntegration,
  type McodeToolsReadiness,
} from './mcode-tools-integration.js';

// Runtime components own dependency-ordered bounded drains of up to 20 seconds.
// This outer process ceiling must cover the whole close graph, not race one component budget.
const DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS = 60_000;

export interface CreateTuiRuntimeOptions {
  dataDir: string;
  workspaceDir: string;
  version: string;
  configPath?: string;
  promptMode?: CreateLocalRuntimeHostOptions['promptMode'];
  surface?: TuiObservabilitySurface;
  observability?: TuiObservability;
  permissionMode?: NonNullable<LocalRuntimeConfig['permissionMode']>;
  lane?: string;
}

export interface CreateTuiRuntimeDependencies {
  factory?: EmbeddedRuntimeHostFactory;
  getConfig?: () => LocalRuntimeConfig;
  configSource?: 'default' | 'explicit';
  readAuthContext?: (dataDir: string, scope: CliAuthScope) => LocalRuntimeAuthContext | undefined;
  importSharedAuthContext?: typeof importSharedCliAuthContext;
  createLogging?: (dataDir: string) => TuiRuntimeLogging;
  createBrowserProvider?: typeof createTuiBrowserProvider;
  readExplicitBetaFeature?: typeof readExplicitBetaFeatureFromFile;
  createObservability?: typeof createTuiObservability;
  renewAccessToken?: (client: TuiMatrixAccountClient) => Promise<string | undefined>;
  completeAuthContext?: (
    auth: LocalRuntimeAuthContext,
    scope: CliAuthScope,
  ) => Promise<LocalRuntimeAuthContext>;
  writeAuthContext?: typeof writeCliAuthContext;
  invalidateAuthContext?: typeof invalidateCliAuthContext;
  readVerifiedIdentity?: typeof readVerifiedCliAccountIdentity;
  writeVerifiedIdentity?: typeof writeVerifiedCliAccountIdentity;
  writeRejectedIdentity?: typeof writeRejectedCliAccountIdentity;
  resolveRealUserID?: (
    client: TuiMatrixAccountClient,
    auth: LocalRuntimeAuthContext,
  ) => Promise<string | undefined>;
  resolveAuthContext?: (
    client: TuiMatrixAccountClient,
    auth: LocalRuntimeAuthContext,
    signal?: AbortSignal,
  ) => Promise<LocalRuntimeAuthContext | undefined>;
  syncRuntimeAuthProjection?: typeof syncCliRuntimeAuthProjection;
  getDataEnvironment?: typeof resolveMcodeDataEnvironment;
  fetchImpl?: typeof fetch;
  sharedAuthCore?: Pick<
    MCodeOAuthCore,
    'getStatus' | 'getAccessToken' | 'handleUnauthorized' | 'watch'
  >;
  prepareMcodeToolsIntegration?: typeof prepareTuiMcodeToolsIntegration;
}

export interface CreatedTuiRuntime {
  host: EmbeddedRuntimeHost;
  adapter: TuiRuntimeAdapter;
  browserProvider?: TuiBrowserProvider;
  logDirectory: string;
  observability: TuiObservability;
  synchronizeAuthContext(authState: 'authenticated' | 'logged_out'): Promise<void>;
  shutdownAuth(): Promise<void>;
  shutdownLogging(): Promise<void>;
}

export async function createTuiRuntime(
  options: CreateTuiRuntimeOptions,
  dependencies: CreateTuiRuntimeDependencies = {},
): Promise<CreatedTuiRuntime> {
  const getSourceConfig = dependencies.getConfig ?? getDefaultLocalRuntimeConfig;
  const configPath = options.configPath ?? join(options.dataDir, 'config.yaml');
  const browserUseToolingEnabled = readBrowserUseToolingOptIn(
    configPath,
    dependencies.readExplicitBetaFeature ?? readExplicitBetaFeatureFromFile,
  );
  const getConfig = (): LocalRuntimeConfig => {
    const config = getSourceConfig();
    return {
      ...config,
      beta: {
        ...config.beta,
        browserUseTooling: browserUseToolingEnabled,
      },
    };
  };
  // Reject unreadable or unsafe config before auth watchers can keep a failed CLI alive.
  const requestedMcodeTools = getConfig().beta?.mcodeTools === true;
  const readAuthContext = dependencies.readAuthContext ?? readCliAuthContext;
  const importSharedAuthContext =
    dependencies.importSharedAuthContext ?? importSharedCliAuthContext;
  const authScope: CliAuthScope = {
    region: getRuntimeRegion(),
    buildEnv: getRuntimeBuildEnv(),
  };
  const bedrockLane = resolveTuiManagedBackendLane(options.lane, authScope.buildEnv);
  const routingContext = bedrockLane ? { bedrockLane } : undefined;
  const useSharedOAuth =
    Boolean(dependencies.sharedAuthCore) || !usesLegacyAuthTestHarness(dependencies);
  let sharedAuthContext: LocalRuntimeAuthContext | undefined;
  let sharedAuthGeneration = 0;
  let sharedAuthProjectionRevision = 0;
  let sharedAuthProjectionPending: Promise<void> | undefined;
  let sharedAuthRecovery: Promise<void> | undefined;
  let sharedAuthRecoveryRejectedToken: string | undefined;
  let stopSharedAuthWatch: () => void = () => undefined;
  let applySharedLease:
    | ((signal?: AbortSignal, minValidityMs?: number) => Promise<void>)
    | undefined;
  let resolveSharedFeedbackAuthContext:
    | ((forceRefresh: boolean, signal: AbortSignal) => Promise<LocalRuntimeAuthContext | undefined>)
    | undefined;
  const rawAuthContextGetter = useSharedOAuth
    ? () => sharedAuthContext
    : () => readAuthContext(options.dataDir, authScope);
  const projectVerifiedIdentity = (auth: LocalRuntimeAuthContext | undefined) => {
    const accessToken = auth?.accessToken?.trim();
    if (!accessToken || auth?.realUserID?.trim()) return auth;
    const identity = (dependencies.readVerifiedIdentity ?? readVerifiedCliAccountIdentity)(
      options.dataDir,
      authScope,
      accessToken,
    );
    if (!identity) return auth;
    const { verifiedAtMs, ...verifiedIdentity } = identity;
    void verifiedAtMs;
    return { ...auth, ...verifiedIdentity };
  };
  const authContextGetter = () => projectVerifiedIdentity(rawAuthContextGetter());
  const accountClient = new TuiMatrixAccountClient({
    authContextGetter,
    ...(routingContext ? { routingContextGetter: () => routingContext } : {}),
    region: authScope.region,
    buildEnv: authScope.buildEnv,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  let sharedAuthCore: CreateTuiRuntimeDependencies['sharedAuthCore'];
  if (useSharedOAuth) {
    const activeSharedAuthCore =
      dependencies.sharedAuthCore ??
      createMcodeSharedAuthSession({
        dataDir: options.dataDir,
        region: authScope.region,
        buildEnv: authScope.buildEnv,
        oauthEndpoints: resolveMCodeOAuthEndpointConfig(process.env, authScope),
      });
    sharedAuthCore = activeSharedAuthCore;
    const projectSharedLease = async (
      signal?: AbortSignal,
      minValidityMs = 60_000,
    ): Promise<void> => {
      const projectionRevision = ++sharedAuthProjectionRevision;
      const lease = await readSharedAccessToken(activeSharedAuthCore, minValidityMs);
      if (projectionRevision !== sharedAuthProjectionRevision) return;
      if (!lease) {
        sharedAuthContext = undefined;
        return;
      }
      if (
        sharedAuthContext?.realUserID?.trim() &&
        sharedAuthContext.accessToken === lease.accessToken &&
        sharedAuthGeneration === lease.generation
      )
        return;
      const tokenOnlyAuth = { accessToken: lease.accessToken, loginEpoch: lease.loginEpoch };
      sharedAuthContext = tokenOnlyAuth;
      sharedAuthGeneration = lease.generation;
      try {
        const resolvedAuth =
          (await resolveCompleteAuthContext(
            accountClient,
            tokenOnlyAuth,
            authScope,
            dependencies,
            signal,
          )) ?? tokenOnlyAuth;
        if (
          projectionRevision === sharedAuthProjectionRevision &&
          sharedAuthGeneration === lease.generation &&
          sharedAuthContext?.accessToken === lease.accessToken
        ) {
          sharedAuthContext = { ...resolvedAuth, loginEpoch: lease.loginEpoch };
        }
      } catch {
        // Account profile enrichment is optional; the shared Bearer remains usable in memory.
      }
    };
    applySharedLease = (signal, minValidityMs) => {
      const pending = projectSharedLease(signal, minValidityMs);
      sharedAuthProjectionPending = pending;
      return pending;
    };
    resolveSharedFeedbackAuthContext = async (forceRefresh, signal) => {
      if (signal.aborted) throw signal.reason;
      if (forceRefresh) {
        const rejectedGeneration = sharedAuthGeneration;
        const loginEpoch = sharedAuthContext?.loginEpoch;
        sharedAuthProjectionRevision += 1;
        sharedAuthContext = undefined;
        const action = await activeSharedAuthCore.handleUnauthorized({
          generation: rejectedGeneration,
          loginEpoch,
        });
        if (action !== 'retry') return undefined;
      }
      await applySharedLease?.(signal);
      return sharedAuthContext;
    };
    // Account checks surface transient failures; startup can still render local work.
    await applySharedLease().catch(() => undefined);
    stopSharedAuthWatch = activeSharedAuthCore.watch((status) => {
      if (!isSharedCredentialState(status)) {
        sharedAuthProjectionRevision += 1;
        sharedAuthContext = undefined;
        sharedAuthGeneration = status.generation;
        return;
      }
      // Refresh progress/failure does not trigger another refresh. A new lease
      // is projected on its authenticated event or the next explicit account check.
      if (status.status !== 'authenticated') return;
      if (sharedAuthContext && sharedAuthGeneration === status.generation) return;
      // Notifications project the current lease; account checks own proactive renewal.
      void applySharedLease?.(undefined, 0).catch(() => undefined);
    });
  } else {
    const cliAuth =
      authContextGetter() ??
      projectVerifiedIdentity(importSharedAuthContext(options.dataDir, authScope, undefined));
    if (cliAuth?.accessToken) {
      const authAvailable = await renewStartupAuthContext(
        options.dataDir,
        cliAuth,
        authScope,
        accountClient,
        dependencies,
      );
      if (!authAvailable) {
        const sharedAuth = projectVerifiedIdentity(
          importSharedAuthContext(options.dataDir, authScope, cliAuth.accessToken),
        );
        if (sharedAuth?.accessToken) {
          await renewStartupAuthContext(
            options.dataDir,
            sharedAuth,
            authScope,
            accountClient,
            dependencies,
          );
        }
      }
    }
  }
  let mcodeToolsReadiness: McodeToolsReadiness = fallbackMcodeToolsReadiness(
    requestedMcodeTools,
    authScope.buildEnv,
  );
  if (useSharedOAuth && sharedAuthCore) {
    mcodeToolsReadiness = await (
      dependencies.prepareMcodeToolsIntegration ?? prepareTuiMcodeToolsIntegration
    )({
      requested: requestedMcodeTools,
      dataDir: options.dataDir,
      buildEnv: authScope.buildEnv,
      region: authScope.region,
      session: createMcodeToolsBrokerAuthSession(sharedAuthCore),
      entryUrl: import.meta.url,
      ...(bedrockLane ? { bedrockLane } : {}),
    });
  }
  const effectiveMcodeTools = mcodeToolsReadiness.ready;
  let authShutdown = false;
  const shutdownAuth = async (): Promise<void> => {
    if (authShutdown) return;
    authShutdown = true;
    stopSharedAuthWatch();
    await mcodeToolsReadiness.dispose();
  };
  const publicAuthContextResolver = (input: {
    readonly forceRefresh: boolean;
    readonly signal: AbortSignal;
  }) => {
    if (useSharedOAuth) {
      const resolver = resolveSharedFeedbackAuthContext;
      return resolver ? resolver(input.forceRefresh, input.signal) : Promise.resolve(undefined);
    }
    return resolveFeedbackAuthContext(
      options.dataDir,
      authScope,
      rawAuthContextGetter,
      accountClient,
      dependencies,
      input.forceRefresh,
      input.signal,
    );
  };
  const ownsObservability = options.observability === undefined;
  const observability =
    options.observability ??
    (dependencies.createObservability ?? createTuiObservability)(options.dataDir, {
      surface: options.surface ?? 'inspection',
    });
  const logging = (dependencies.createLogging ?? createTuiRuntimeLogging)(options.dataDir);
  const hostOptions: Omit<
    CreateLocalRuntimeHostOptions,
    'runtimeOwnerKind' | 'runtimeMode' | 'legacyOpencodeEnabled' | 'enableLiveMcp'
  > = {
    dataDir: options.dataDir,
    defaultWorkspaceDir: options.workspaceDir,
    appVersion: options.version,
    ...(options.promptMode ? { promptMode: options.promptMode } : {}),
    configGetter: () => {
      const config = getConfig();
      return {
        ...config,
        dataDir: options.dataDir,
        ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        beta: {
          ...config.beta,
          mcodeTools: effectiveMcodeTools,
        },
      };
    },
    configSource: dependencies.configSource,
    authContextGetter,
    ...(routingContext ? { routingContextGetter: () => routingContext } : {}),
    authContextInvalidator: async (rejectedAccessToken, loginEpoch) => {
      if (!useSharedOAuth) {
        invalidateRejectedAuthContext(
          options.dataDir,
          authScope,
          rawAuthContextGetter(),
          dependencies,
        );
        return;
      }
      const rejectedToken = rejectedAccessToken?.trim();
      const currentAccessToken = sharedAuthContext?.accessToken?.trim();
      if (rejectedToken && currentAccessToken && currentAccessToken !== rejectedToken) {
        return;
      }
      if (!sharedAuthCore || !applySharedLease) return;
      while (sharedAuthRecovery) {
        const activeRecovery = sharedAuthRecovery;
        const activeRejectedToken = sharedAuthRecoveryRejectedToken;
        await activeRecovery;
        if (!rejectedToken || activeRejectedToken === rejectedToken) return;
        const projectedAccessToken = sharedAuthContext?.accessToken?.trim();
        if (!projectedAccessToken || projectedAccessToken !== rejectedToken) return;
      }
      if (!sharedAuthRecovery) {
        const rejectedGeneration = sharedAuthGeneration;
        const requestEpoch = loginEpoch ?? sharedAuthContext?.loginEpoch;
        // A logout notification can clear the projection before the old 401 arrives.
        // Keep its response without clearing or recovering a different login.
        if (!requestEpoch || requestEpoch !== sharedAuthContext?.loginEpoch) return;
        sharedAuthProjectionRevision += 1;
        sharedAuthContext = undefined;
        const recovery = (async () => {
          try {
            const action = await sharedAuthCore.handleUnauthorized({
              generation: rejectedGeneration,
              loginEpoch: requestEpoch,
            });
            if (action !== 'retry') return;
            await applySharedLease();
          } catch (error) {
            if (error instanceof AuthSessionChangedError) await applySharedLease();
            // The rejected request retains its original 401 when recovery cannot complete.
          }
        })().finally(() => {
          if (sharedAuthRecovery === recovery) {
            sharedAuthRecovery = undefined;
            sharedAuthRecoveryRejectedToken = undefined;
          }
        });
        sharedAuthRecoveryRejectedToken = rejectedToken;
        sharedAuthRecovery = recovery;
      }
      await sharedAuthRecovery;
    },
    capabilities: {
      questionnaireReply: options.surface !== 'headless',
      permissionPrompt: options.surface !== 'headless',
      elicitation: options.surface !== 'headless',
    },
    ...(options.surface === 'headless' ||
    options.surface === 'acp' ||
    (dependencies.getDataEnvironment ?? resolveMcodeDataEnvironment)() === 'test'
      ? { startupExecutionPolicy: 'quarantined' }
      : {}),
  };
  const startupStartedAt = performance.now();
  if (ownsObservability) {
    observability.recordStartup({
      phase: 'runtime.initialize',
      outcome: 'started',
    });
  }
  let browserProvider: TuiBrowserProvider | undefined;
  try {
    browserProvider = (dependencies.createBrowserProvider ?? createTuiBrowserProvider)(
      options.dataDir,
      getConfig(),
    );
    const host = await logging.runDuringStartup(() =>
      createEmbeddedRuntimeHost(
        {
          ...hostOptions,
          ...(browserProvider ? { browserAdapter: browserProvider } : {}),
          productCapabilities: { mcodeTools: effectiveMcodeTools },
        },
        dependencies.factory,
      ),
    );
    mcodeToolsReadiness.ensureCommandPath();
    if (ownsObservability) {
      observability.recordStartup({
        phase: 'runtime.initialize',
        outcome: 'succeeded',
        durationMs: performance.now() - startupStartedAt,
      });
    }
    return {
      host,
      adapter: new TuiRuntimeAdapter(host.cliService, {
        workspaceDir: options.workspaceDir,
        observability,
        onSessionDeleted: browserProvider?.disposeSession
          ? browserProvider.disposeSession.bind(browserProvider)
          : (sessionId) => disposeTuiBrowserSessionStorage(options.dataDir, sessionId),
        ...(useSharedOAuth
          ? { synchronizeAuth: () => applySharedLease?.() ?? Promise.resolve() }
          : {}),
        tokenPlanAccountStatusGetter: (accountOptions) =>
          accountClient.getTokenPlanAccountStatus(undefined, accountOptions),
        accountIdentityGetter: () => {
          const identity = authContextGetter();
          return identity?.accessToken
            ? { email: identity.userEmail, name: identity.userName ?? identity.subUserName }
            : undefined;
        },
        dailyCheckin: new TuiDailyCheckinApplication(
          new TuiDailyCheckinHttpGateway({
            appVersion: options.version,
            authContextGetter,
            authContextResolver: publicAuthContextResolver,
            ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
            region: () => authScope.region,
            buildEnv: () => authScope.buildEnv,
          }),
        ),
        feedback: new TuiFeedbackService({
          appVersion: options.version,
          authContextGetter,
          authContextResolver: publicAuthContextResolver,
          ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
          region: () => authScope.region,
          buildEnv: () => authScope.buildEnv,
          diagnosticLogUploader: (input) =>
            uploadTuiFeedbackDiagnostics(input, {
              dataDir: options.dataDir,
              appVersion: options.version,
              ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
              region: () => authScope.region,
              buildEnv: () => authScope.buildEnv,
              flushLogs: async () => {
                await Promise.allSettled([observability.flush(), logging.flush()]);
              },
              collectSessionReport: (sessionId) => {
                return host.cliService.collectSessionReport(sessionId);
              },
            }),
        }),
      }),
      ...(browserProvider ? { browserProvider } : {}),
      logDirectory: logging.logDirectory,
      observability,
      synchronizeAuthContext: async (authState) => {
        if (!useSharedOAuth) return;
        if (authState === 'logged_out') {
          sharedAuthProjectionRevision += 1;
          sharedAuthContext = undefined;
          return;
        }
        // A file-watch update may supersede this read. Login must wait for the
        // latest projection too, instead of returning with the old Bearer.
        let pending = applySharedLease?.();
        do {
          await pending;
          if (pending === sharedAuthProjectionPending) break;
          pending = sharedAuthProjectionPending;
        } while (pending);
      },
      shutdownAuth,
      shutdownLogging: () => logging.shutdown(),
    };
  } catch (error) {
    if (ownsObservability) {
      observability.recordStartup({
        phase: 'runtime.initialize',
        outcome: 'failed',
        durationMs: performance.now() - startupStartedAt,
        errorKind: errorKind(error),
      });
    }
    const cleanupFailures: unknown[] = [];
    try {
      await shutdownAuth();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (browserProvider) {
      try {
        await browserProvider.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    try {
      await logging.shutdown();
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (ownsObservability) {
      try {
        await observability.flush();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Minimax Code Runtime startup cleanup failed.',
      );
    }
    throw error;
  }
}

function readBrowserUseToolingOptIn(
  configPath: string,
  readFeature: typeof readExplicitBetaFeatureFromFile,
): boolean {
  try {
    return readFeature(configPath, 'browserUseTooling') === true;
  } catch {
    return false;
  }
}

function usesLegacyAuthTestHarness(dependencies: CreateTuiRuntimeDependencies): boolean {
  return Boolean(
    dependencies.readAuthContext ||
    dependencies.importSharedAuthContext ||
    dependencies.renewAccessToken ||
    dependencies.writeAuthContext ||
    dependencies.invalidateAuthContext,
  );
}

async function readSharedAccessToken(
  core: NonNullable<CreateTuiRuntimeDependencies['sharedAuthCore']>,
  minValidityMs: number,
): Promise<AccessTokenLease | undefined> {
  try {
    return await core.getAccessToken({
      requiredScopes: [...MCODE_OAUTH_SCOPES],
      minValidityMs,
    });
  } catch (error) {
    if (requiresInteractiveLogin(error)) return undefined;
    throw error;
  }
}

function isSharedCredentialState(status: AuthStatusSnapshot): boolean {
  return (
    status.status === 'authenticated' ||
    status.status === 'expired' ||
    status.status === 'refreshing'
  );
}

function createMcodeToolsBrokerAuthSession(
  core: NonNullable<CreateTuiRuntimeDependencies['sharedAuthCore']>,
): McodeToolsHostAuthSession {
  const projectStatus = (status: AuthStatusSnapshot) => ({
    status: status.status,
    generation: status.generation,
    ...(status.expiresAtMs === undefined ? {} : { expiresAtMs: status.expiresAtMs }),
  });
  return {
    getStatus: async () => projectStatus(await core.getStatus()),
    getAccessToken: (minValidityMs) =>
      core.getAccessToken({
        requiredScopes: [...MCODE_OAUTH_SCOPES],
        minValidityMs,
      }),
    handleUnauthorized: (generation) => core.handleUnauthorized({ generation }),
    watch: (listener) => core.watch((status) => listener(projectStatus(status))),
  };
}

function fallbackMcodeToolsReadiness(
  requested: boolean,
  buildEnv: CliAuthScope['buildEnv'],
): McodeToolsReadiness {
  return {
    requested,
    ready: false,
    category: requested ? 'host_unavailable' : 'disabled',
    buildEnv: buildEnv === 'dev' ? 'test' : buildEnv,
    ensureCommandPath: () => undefined,
    dispose: async () => undefined,
  };
}

async function renewStartupAuthContext(
  dataDir: string,
  auth: LocalRuntimeAuthContext,
  scope: CliAuthScope,
  accountClient: TuiMatrixAccountClient,
  dependencies: CreateTuiRuntimeDependencies,
): Promise<boolean> {
  let effectiveAuth = auth;
  try {
    const renewedToken = await (
      dependencies.renewAccessToken ?? ((client) => client.renewAccessToken())
    )(accountClient);
    effectiveAuth = renewedToken ? { ...auth, accessToken: renewedToken } : auth;
    if (renewedToken && renewedToken !== auth.accessToken) {
      writeRefreshedAuthContext(dataDir, effectiveAuth, scope, auth, dependencies);
    }
    const verifiedAuth = await resolveCompleteAuthContext(
      accountClient,
      effectiveAuth,
      scope,
      dependencies,
      undefined,
      // A successful renewal keeps the account binding; carry the verified ID to the new token.
      Boolean(effectiveAuth.realUserID?.trim()),
    );
    const effectiveToken = verifiedAuth?.accessToken?.trim();
    if (verifiedAuth?.realUserID && effectiveToken) {
      writeRefreshedAuthContext(dataDir, verifiedAuth, scope, auth, dependencies);
      (dependencies.writeVerifiedIdentity ?? writeVerifiedCliAccountIdentity)(
        dataDir,
        scope,
        effectiveToken,
        verifiedAuth,
      );
    }
    return true;
  } catch (error) {
    if (!(error instanceof TuiAuthenticationError)) return true;
    invalidateRejectedAuthContext(dataDir, scope, effectiveAuth, dependencies);
    return false;
  }
}

async function resolveFeedbackAuthContext(
  dataDir: string,
  scope: CliAuthScope,
  readAuthContext: () => LocalRuntimeAuthContext | undefined,
  accountClient: TuiMatrixAccountClient,
  dependencies: CreateTuiRuntimeDependencies,
  forceRefresh: boolean,
  signal: AbortSignal,
): Promise<LocalRuntimeAuthContext | undefined> {
  const current = readAuthContext();
  const accessToken = current?.accessToken?.trim();
  if (!accessToken) return undefined;
  let effectiveAuth: LocalRuntimeAuthContext = { ...current, accessToken };
  const expectedSharedAuth = effectiveAuth;
  try {
    if (forceRefresh) {
      const renewedToken = await (
        dependencies.renewAccessToken ?? ((client) => client.renewAccessToken(signal))
      )(accountClient);
      if (renewedToken && renewedToken !== accessToken) {
        effectiveAuth = { ...current, accessToken: renewedToken };
        writeRefreshedAuthContext(dataDir, effectiveAuth, scope, expectedSharedAuth, dependencies);
      }
    }
    const verifiedAuth = await resolveCompleteAuthContext(
      accountClient,
      effectiveAuth,
      scope,
      dependencies,
      signal,
    );
    if (!verifiedAuth?.realUserID) return effectiveAuth;
    const effectiveToken = verifiedAuth.accessToken?.trim();
    if (!effectiveToken) return undefined;
    writeRefreshedAuthContext(dataDir, verifiedAuth, scope, expectedSharedAuth, dependencies);
    (dependencies.writeVerifiedIdentity ?? writeVerifiedCliAccountIdentity)(
      dataDir,
      scope,
      effectiveToken,
      verifiedAuth,
    );
    return verifiedAuth;
  } catch (error) {
    if (!(error instanceof TuiAuthenticationError)) throw error;
    invalidateRejectedAuthContext(dataDir, scope, effectiveAuth, dependencies);
    return undefined;
  }
}

function writeRefreshedAuthContext(
  dataDir: string,
  auth: LocalRuntimeAuthContext,
  scope: CliAuthScope,
  expectedSharedAuth: LocalRuntimeAuthContext,
  dependencies: CreateTuiRuntimeDependencies,
): void {
  if (dependencies.writeAuthContext) {
    dependencies.writeAuthContext(dataDir, auth, scope);
    return;
  }
  writeCliAuthContext(dataDir, auth, scope, { expectedSharedAuth });
}

async function resolveCompleteAuthContext(
  accountClient: TuiMatrixAccountClient,
  auth: LocalRuntimeAuthContext,
  scope: CliAuthScope,
  dependencies: CreateTuiRuntimeDependencies,
  signal?: AbortSignal,
  reuseKnownIdentity = false,
): Promise<LocalRuntimeAuthContext | undefined> {
  if (dependencies.resolveAuthContext) {
    return dependencies.resolveAuthContext(accountClient, auth, signal);
  }
  if (dependencies.resolveRealUserID) {
    const realUserID = await dependencies.resolveRealUserID(accountClient, auth);
    return realUserID ? { ...auth, realUserID } : auth;
  }
  if (dependencies.completeAuthContext) {
    return dependencies.completeAuthContext(auth, scope);
  }
  if (reuseKnownIdentity && auth.realUserID?.trim()) return auth;
  return accountClient.getAuthContextForAuth(auth, signal);
}

function invalidateRejectedAuthContext(
  dataDir: string,
  scope: CliAuthScope,
  auth: LocalRuntimeAuthContext | undefined,
  dependencies: CreateTuiRuntimeDependencies,
): void {
  const accessToken = auth?.accessToken?.trim();
  if (accessToken) {
    (dependencies.writeRejectedIdentity ?? writeRejectedCliAccountIdentity)(
      dataDir,
      scope,
      accessToken,
    );
  }
  (dependencies.invalidateAuthContext ?? invalidateCliAuthContext)(dataDir, scope);
}

export interface TuiRuntimeShutdownDependencies {
  reportFailure?: (step: string, error: unknown) => void;
  shutdownTimeoutMs?: number;
}

export async function shutdownTuiRuntime(
  runtime: CreatedTuiRuntime,
  dependencies: TuiRuntimeShutdownDependencies = {},
): Promise<boolean> {
  const observability = runtime.observability ?? noopTuiObservability;
  const shutdownStartedAt = performance.now();
  observability.recordStartup({
    phase: 'runtime.shutdown',
    outcome: 'started',
  });
  const reportFailure =
    dependencies.reportFailure ??
    ((step: string, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[minimax-code] ${step} cleanup failed: ${message}\n`);
    });
  const shutdownTimeoutMs = normalizeShutdownTimeout(dependencies.shutdownTimeoutMs);
  const shutdownDeadline = shutdownStartedAt + shutdownTimeoutMs;
  const timedOut = Symbol('shutdown timeout');
  let failed = false;
  const cleanup = async (step: string, operation: () => void | Promise<void>): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Invoke every owner in order even when only an immediate cleanup can still finish.
      const operationPromise = Promise.resolve(operation());
      void operationPromise.catch(() => undefined);
      const remainingMs = Math.max(0, shutdownDeadline - performance.now());
      const timeoutPromise =
        remainingMs > 0
          ? new Promise<typeof timedOut>((resolve) => {
              // Keep headless alive until it can publish the bounded shutdown result.
              timeout = setTimeout(() => resolve(timedOut), remainingMs);
            })
          : Promise.resolve(timedOut);
      const result = await Promise.race([operationPromise, timeoutPromise]);
      if (result === timedOut) {
        failed = true;
        reportCleanupTimeout(step, shutdownTimeoutMs);
      }
    } catch (error) {
      failed = true;
      try {
        reportFailure(step, error);
      } catch {
        // A reporting sink must not prevent the remaining owners from closing.
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  await cleanup('embedded Runtime', () => runtime.host.apiHost.close());
  await cleanup('shared OAuth watch', () => runtime.shutdownAuth?.());
  await cleanup('Browser provider', () => runtime.browserProvider?.close());
  await cleanup('runtime logging', () => runtime.shutdownLogging());
  observability.recordStartup({
    phase: 'runtime.shutdown',
    outcome: failed ? 'failed' : 'succeeded',
    durationMs: performance.now() - shutdownStartedAt,
  });
  await cleanup('runtime observability', () => observability.flush());
  return failed;

  function reportCleanupTimeout(step: string, timeoutMs: number): void {
    try {
      reportFailure(step, new Error(`Runtime shutdown deadline exceeded after ${timeoutMs}ms`));
    } catch {
      // A reporting sink must not prevent the remaining owners from closing.
    }
  }
}

function errorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

function normalizeShutdownTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS;
  }
  return Math.max(0, timeoutMs);
}
