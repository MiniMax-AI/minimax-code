import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ProcessTerminal, setKeybindings, type Terminal, type TuiMode } from './engine/public.js';
import { detectProcessTerminalCapabilities } from './platform/terminal-capabilities.js';
import {
  installTuiProcessGuards,
  type TuiProcessFailureContext,
} from './platform/process-guards.js';
import { createObservedTerminal } from './platform/observed-terminal.js';
import { createTuiProcessStopObservation } from './platform/process-stop-observation.js';
import type { TuiProcessStopCause } from './platform/process-stop-cause.js';
import { prepareTuiDataDir } from '../runtime/data-dir.js';
import { readTuiPresentationConfig } from './shell/status-line-config.js';
import { createTuiHostKeybindings } from './shell/keybindings.js';
import {
  readTuiKeybindingOverrides,
  writeTuiKeybindingOverrides,
} from '../host/tui-keybindings.js';
import { createTuiApp, type CreateTuiAppOptions, type TuiApp } from './app.js';
import type { CreatedTuiRuntime, CreateTuiRuntimeDependencies } from '../runtime/lifecycle.js';
import { parseHeadlessModelOverride } from '../headless/model-selection.js';
import type { TuiRuntime, TuiWorkspaceRoot } from '../runtime/port.js';
import { createDeferredTuiRuntime } from '../runtime/deferred.js';
import {
  captureTuiIncidentBestEffort,
  createTuiIncidentReporter,
  createTuiObservability,
  noopTuiIncidentReporter,
  type CreateTuiIncidentReporterOptions,
  type TuiIncidentReporter,
  type TuiObservability,
} from '../observability/index.js';
import { resolveMcodeAuthEnvironment } from '../auth/environment.js';
import { TuiMatrixAccountClient } from '../account/matrix-account-client.js';
import {
  createMcodeBusinessTelemetry,
  resolveMcodeBusinessTelemetryPolicy,
  type CreateMcodeBusinessTelemetryOptions,
  type McodeBusinessTelemetry,
} from '../analytics/business-telemetry.js';
import { createDefaultMcodeAuthApplication } from '../auth/factory.js';
import { createMcodeSharedAuthSession } from '../runtime/auth-session.js';
import {
  MCODE_OAUTH_SCOPES,
  resolveMCodeOAuthEndpointConfig,
  type AccessTokenLease,
  type MCodeOAuthCore,
} from '@mavis/oauth-core';
import {
  resolveTuiManagedBackendLane,
  resolveTuiStartupEnvironmentOption,
} from '../cli/environment.js';
import { resolveMcodeStartupUpdateNotice } from '../update/startup-notice.js';
import type { McodeUpdateApplication } from '../update/application.js';
import { tuiErrorDiagnostic } from '../user-facing-failure.js';
import { getConfig, resetConfig, writeTuiStatusLineSetting, type MavisRegion } from '@mavis/config';
import { markLoginRestartHandoff } from './login-restart-handoff.js';
import {
  readTuiModeSetting,
  readTuiThemeSetting,
  writeTuiModeSetting,
  writeTuiThemeSetting,
} from '../host/tui-settings.js';
import { schedulePendingMcodePrefixUpdate } from '../update/prefix-update.js';
import { MCODE_TUI_RESULT_PATH_ENV } from './automation/result-writer.js';
import { startTuiStartupStatus, type TuiStartupStatus } from './startup-status.js';

const MINIMAX_CODE_EXIT_SLOGAN = 'Intelligence with everyone, bye~';
export interface LaunchTuiOptions {
  version: string;
  initialPrompt?: string;
  model?: string;
  sessionId?: string;
  showSessionPicker?: boolean;
  continueLatestSession?: boolean;
  workspaceDir?: string;
  workspaceRoots?: readonly TuiWorkspaceRoot[];
  homeDir?: string;
  dataDir?: string;
  terminal?: Terminal;
  tuiMode?: TuiMode;
  theme?: string;
  externalEditorCommand?: string;
  resumeDraftAfterLogin?: boolean;
  lane?: string;
}

type LaunchApp = Pick<TuiApp, 'ready' | 'firstFrame' | 'start' | 'stop' | 'stopped' | 'submit'> & {
  readonly editor?: Pick<TuiApp['editor'], 'disableSubmit'>;
  readonly setStartupStatus?: TuiApp['setStartupStatus'];
  readonly controller?: Pick<TuiApp['controller'], 'snapshot'> &
    Partial<Pick<TuiApp['controller'], 'ensureSession'>>;
  readonly openSession?: TuiApp['openSession'];
  readonly continueLatestSession?: TuiApp['continueLatestSession'];
  readonly suspend?: TuiApp['suspend'];
  readonly resume?: TuiApp['resume'];
};

interface RuntimeLifecycleModule {
  createTuiRuntime(
    options: {
      dataDir: string;
      workspaceDir: string;
      version: string;
      surface: 'tui';
      observability: TuiObservability;
      lane?: string;
    },
    dependencies?: Pick<CreateTuiRuntimeDependencies, 'sharedAuthCore'>,
  ): Promise<CreatedTuiRuntime>;
  shutdownTuiRuntime(
    runtime: CreatedTuiRuntime,
    dependencies?: { reportFailure?: (step: string, error: unknown) => void },
  ): Promise<boolean>;
}

export interface LaunchTuiDependencies {
  createApp?: (options: CreateTuiAppOptions) => LaunchApp;
  createObservability?: typeof createTuiObservability;
  installProcessGuards?: typeof installTuiProcessGuards;
  loadRuntimeLifecycle?: () => Promise<RuntimeLifecycleModule>;
  loadUpdateApplication?: (
    currentVersion: string,
  ) => Promise<Pick<McodeUpdateApplication, 'inspect' | 'apply'>>;
  writeExitMessage?: (message: string) => void;
  prepareDataDir?: typeof prepareTuiDataDir;
  restartProcess?: (
    sessionId?: string,
    region?: MavisRegion,
    initialPrompt?: string,
  ) => Promise<void>;
  createBusinessTelemetry?: typeof createMcodeBusinessTelemetry;
  readTelemetryEnabled?: () => boolean;
  createIncidentReporter?: typeof createTuiIncidentReporter;
  readTuiMode?: typeof readTuiModeSetting;
  writeTuiMode?: typeof writeTuiModeSetting;
  readTuiTheme?: typeof readTuiThemeSetting;
  writeTuiTheme?: typeof writeTuiThemeSetting;
  createSharedAuthSession?: typeof createMcodeSharedAuthSession;
  createAuthApplication?: typeof createDefaultMcodeAuthApplication;
}

export function createConfiguredTuiBusinessTelemetry(options: {
  readonly configEnabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly telemetryOptions: CreateMcodeBusinessTelemetryOptions;
  readonly createTelemetry?: typeof createMcodeBusinessTelemetry;
}): McodeBusinessTelemetry | undefined {
  const policy = resolveMcodeBusinessTelemetryPolicy({
    configEnabled: options.configEnabled,
    environment: options.environment,
  });
  if (!policy.enabled) return undefined;
  return (options.createTelemetry ?? createMcodeBusinessTelemetry)(options.telemetryOptions);
}

export async function launchTui(
  options: LaunchTuiOptions,
  dependencies: LaunchTuiDependencies = {},
): Promise<void> {
  if (options.model !== undefined) parseHeadlessModelOverride(options.model.trim());
  if (options.model !== undefined && options.showSessionPicker) {
    throw new Error(
      '--model requires a Session id with --session; use --session <id> or --continue.',
    );
  }
  if (!options.terminal && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Minimax Code interactive mode requires a TTY.');
  }

  const homeDirectory = options.homeDir ?? homedir();
  const workspaceDir = options.workspaceDir ?? process.cwd();
  const dataDir = options.dataDir ?? (await (dependencies.prepareDataDir ?? prepareTuiDataDir)());
  const baseTerminal = options.terminal ?? new ProcessTerminal();
  const tuiMode = options.tuiMode ?? (dependencies.readTuiMode ?? readTuiModeSetting)(dataDir);
  const theme = options.theme ?? (dependencies.readTuiTheme ?? readTuiThemeSetting)(dataDir);
  const terminalCapabilities = detectProcessTerminalCapabilities();
  const authEnvironment = resolveMcodeAuthEnvironment({
    runtimeRegion: process.env.MAVIS_REGION === 'en' ? 'en' : 'cn',
  });
  const bedrockLane = resolveTuiManagedBackendLane(options.lane, authEnvironment.buildEnv);
  const routingContext = bedrockLane ? { bedrockLane } : undefined;
  const sharedAuthCore: MCodeOAuthCore = (
    dependencies.createSharedAuthSession ?? createMcodeSharedAuthSession
  )({
    dataDir,
    ...authEnvironment,
    oauthEndpoints: resolveMCodeOAuthEndpointConfig(process.env, authEnvironment),
  });
  let accountAuthContext: { accessToken: string; realUserID?: string } | undefined;
  const accountIdentityClient = new TuiMatrixAccountClient({
    authContextGetter: () => accountAuthContext,
    ...(routingContext ? { routingContextGetter: () => routingContext } : {}),
    ...authEnvironment,
  });
  const resolveAccessTokenLease = async (): Promise<AccessTokenLease | undefined> => {
    try {
      const lease = await sharedAuthCore.getAccessToken({
        requiredScopes: [...MCODE_OAUTH_SCOPES],
        minValidityMs: 30_000,
      });
      if (accountAuthContext?.accessToken !== lease.accessToken) {
        accountAuthContext = { accessToken: lease.accessToken };
      }
      return lease;
    } catch {
      accountAuthContext = undefined;
      return undefined;
    }
  };
  const resolveIdentityForToken = createTokenScopedAsyncResolver(async () => {
    const accessToken = accountAuthContext?.accessToken;
    if (!accessToken) return undefined;
    const realUserID = await accountIdentityClient.getRealUserID();
    if (realUserID && accountAuthContext?.accessToken === accessToken) {
      accountAuthContext = { ...accountAuthContext, realUserID };
    }
    return realUserID;
  });
  const incidentReporterOptions = {
    dataDir,
    appVersion: options.version,
    ...authEnvironment,
    terminal: terminalCapabilities.terminalId,
    tuiMode,
    resolveAuthContext: async () => {
      const auth = await resolveAccessTokenLease();
      if (!auth) return undefined;
      const realUserID = await resolveIdentityForToken(auth.accessToken.trim());
      return realUserID ? { accessToken: auth.accessToken, realUserID } : undefined;
    },
  } satisfies CreateTuiIncidentReporterOptions;
  const incidentReporter: TuiIncidentReporter = dependencies.createIncidentReporter
    ? dependencies.createIncidentReporter(incidentReporterOptions)
    : isVitestRuntime()
      ? noopTuiIncidentReporter
      : createTuiIncidentReporter(incidentReporterOptions);
  const onUncaughtExceptionMonitor = (error: Error, origin: string): void => {
    const operation = origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException';
    captureTuiIncidentBestEffort(incidentReporter, {
      eventType: 'cli_process_error',
      error,
      component: 'process',
      operation,
      codeLocation: 'src/tui/launcher.ts#uncaughtExceptionMonitor',
      severity: 'fatal',
      impact: 'exit',
      handled: false,
    });
  };
  const businessTelemetry = createConfiguredTuiBusinessTelemetry({
    configEnabled: (dependencies.readTelemetryEnabled ?? (() => getConfig().telemetry.enabled))(),
    environment: process.env,
    telemetryOptions: {
      ...authEnvironment,
      version: options.version,
    },
    ...(dependencies.createBusinessTelemetry
      ? { createTelemetry: dependencies.createBusinessTelemetry }
      : isVitestRuntime()
        ? {
            createTelemetry: () => ({
              track: () => undefined,
              flush: async () => undefined,
            }),
          }
        : {}),
  });
  const trackTuiLaunch = (launchType: 'cold' | 'hot'): void => {
    try {
      businessTelemetry?.track('tui_launch', { launch_type: launchType });
    } catch {
      // Business telemetry must not affect TUI lifecycle.
    }
  };
  const observability: TuiObservability = (
    dependencies.createObservability ?? createTuiObservability
  )(dataDir, { surface: 'tui' });
  let processStopRecorded = false;
  let terminalDeadObserved = false;
  const recordFirstProcessStop = (cause: TuiProcessStopCause): void => {
    if (cause.terminalDead) terminalDeadObserved = true;
    if (processStopRecorded) return;
    processStopRecorded = true;
    try {
      observability.recordProcessStop(
        createTuiProcessStopObservation(cause, { homeDirectory, workspaceDir }),
      );
    } catch {
      // Process diagnostics must never replace the original stop cause.
    }
  };
  const terminal = createObservedTerminal(baseTerminal, recordFirstProcessStop);
  observability.recordStartup({ phase: 'cli.process', outcome: 'started' });
  observability.recordTerminal({
    ...terminalCapabilities,
    columns: terminal.columns,
    rows: terminal.rows,
  });
  const loadUpdateApplication =
    dependencies.loadUpdateApplication ??
    (async (currentVersion: string) => {
      const { McodeUpdateApplication } = await import('../update/application.js');
      return new McodeUpdateApplication({ currentVersion });
    });
  let updateApplicationPromise: ReturnType<typeof loadUpdateApplication> | undefined;
  const updateApplication = () => {
    updateApplicationPromise ??= loadUpdateApplication(options.version);
    return updateApplicationPromise;
  };
  let resolveProcessStopFailure: (() => void) | undefined;
  const processStopFailure = new Promise<void>((resolve) => {
    resolveProcessStopFailure = resolve;
  });
  let removeProcessGuards: (() => void) | undefined;
  let lifecycle: RuntimeLifecycleModule | undefined;
  let runtimePromise: Promise<CreatedTuiRuntime> | undefined;
  let runtime: CreatedTuiRuntime | undefined;
  let app: LaunchApp | undefined;
  let startupStatus: TuiStartupStatus | undefined;
  let firstFrameObservation: Promise<boolean> | undefined;
  let activeSessionId: string | undefined;
  let stoppedNormally = false;
  let runtimeInitialized = false;
  let tuiRunning = false;
  let runtimeShutdownFailed = false;
  let restartRequested = false;
  let restartRegion: MavisRegion | undefined;
  let restartInitialPrompt: string | undefined;
  if (incidentReporter.runId) {
    process.on('uncaughtExceptionMonitor', onUncaughtExceptionMonitor);
  }
  try {
    const runtimeStartedAt = performance.now();
    incidentReporter.breadcrumb('cli.runtime.initialize.started');
    observability.recordStartup({ phase: 'runtime.initialize', outcome: 'started' });
    try {
      lifecycle = await (
        dependencies.loadRuntimeLifecycle ?? (() => import('../runtime/lifecycle.js'))
      )();
      runtimePromise = lifecycle.createTuiRuntime(
        {
          dataDir,
          workspaceDir,
          version: options.version,
          surface: 'tui',
          observability,
          ...(bedrockLane ? { lane: bedrockLane } : {}),
        },
        { sharedAuthCore },
      );
      // Initialization can fail while presentation config is still loading.
      void runtimePromise.catch(() => undefined);
    } catch (error) {
      observability.recordStartup({
        phase: 'runtime.initialize',
        outcome: 'failed',
        durationMs: performance.now() - runtimeStartedAt,
        errorKind: errorKind(error),
      });
      throw error;
    }

    const tuiStartedAt = performance.now();
    observability.recordStartup({ phase: 'tui.start', outcome: 'started' });
    const presentationConfig = await readTuiPresentationConfig(dataDir);
    const tuiKeybindingRead = readTuiKeybindingOverrides(dataDir);
    let tuiKeybindingOverrides = tuiKeybindingRead.overrides;
    let initialStateReady = true;
    try {
      const initializingRuntime = runtimePromise;
      if (!initializingRuntime) throw new Error('Runtime initialization did not start.');
      const keybindings = createTuiHostKeybindings({
        platform: process.platform,
        suspendSupported: process.platform !== 'win32',
        windowsClipboardInterop:
          process.platform === 'linux' &&
          Boolean(process.env.WSL_DISTRO_NAME || process.env.WSLENV),
        userOverrides: tuiKeybindingOverrides,
      });
      setKeybindings(keybindings.manager);
      app = (dependencies.createApp ?? createTuiApp)({
        runtime: createDeferredTuiRuntime(initializingRuntime.then((created) => created.adapter)),
        dataDir,
        version: options.version,
        workspaceDir,
        terminalCapabilities,
        ...(presentationConfig.terminalTitle !== undefined
          ? { terminalTitle: presentationConfig.terminalTitle }
          : {}),
        ...(presentationConfig.statusLineItems
          ? { statusLineItems: presentationConfig.statusLineItems }
          : {}),
        ...(presentationConfig.customStatusLine
          ? { customStatusLine: presentationConfig.customStatusLine }
          : {}),
        ...(presentationConfig.showTips === undefined
          ? {}
          : { showTips: presentationConfig.showTips }),
        ...(presentationConfig.notifications
          ? { notifications: presentationConfig.notifications }
          : {}),
        ...(process.env[MCODE_TUI_RESULT_PATH_ENV]
          ? { automationResultPath: process.env[MCODE_TUI_RESULT_PATH_ENV] }
          : {}),
        ...(options.workspaceRoots ? { workspaceRoots: options.workspaceRoots } : {}),
        homeDir: homeDirectory,
        terminal,
        tuiMode,
        persistTuiMode: (mode) => (dependencies.writeTuiMode ?? writeTuiModeSetting)(dataDir, mode),
        ...(theme ? { theme } : {}),
        persistTheme: (value) =>
          (dependencies.writeTuiTheme ?? writeTuiThemeSetting)(dataDir, value),
        persistStatusLineItems: (items) => writeTuiStatusLineSetting(dataDir, items),
        externalEditorCommand: options.externalEditorCommand,
        observability,
        incidentReporter,
        ...(businessTelemetry ? { businessTelemetry } : {}),
        auth: (dependencies.createAuthApplication ?? createDefaultMcodeAuthApplication)({
          dataDir,
          ...authEnvironment,
          sharedAuthCore,
          ...(businessTelemetry ? { telemetry: businessTelemetry } : {}),
          telemetrySource: 'mcode_tui',
        }),
        notifyAuthContextChanged: async (authState: 'authenticated' | 'logged_out') => {
          const activeRuntime = await initializingRuntime;
          await activeRuntime.synchronizeAuthContext(authState);
          await activeRuntime.host.notifyAuthContextChanged?.(authState);
          if (authState === 'authenticated') await resolveAccessTokenLease();
          else accountAuthContext = undefined;
          incidentReporter.breadcrumb('cli.auth.context.changed', { authState });
          if (authState === 'authenticated') void incidentReporter.drain();
        },
        readClipboardImage: async (signal) => {
          const { readTuiClipboardImage } = await import('../host/clipboard-image.js');
          return readTuiClipboardImage({ signal });
        },
        keybindings: keybindings.registry,
        ...(process.platform === 'win32'
          ? {}
          : { requestProcessSuspend: () => process.kill(process.pid, 'SIGTSTP') }),
        requestRestart: (region, initialPrompt) => {
          restartRequested = true;
          if (region) restartRegion = region;
          if (initialPrompt) restartInitialPrompt = initialPrompt;
        },
        getTuiKeybindingOverrides: () => ({ ...tuiKeybindingOverrides }),
        saveTuiKeybindingOverrides: (overrides) => {
          const next = { ...overrides };
          writeTuiKeybindingOverrides(dataDir, next);
          tuiKeybindingOverrides = next;
          keybindings.manager.setUserBindings({ ...keybindings.hostOverrides, ...next });
        },
        reloadTui: async () => {
          const created = await initializingRuntime;
          const next = readTuiKeybindingOverrides(dataDir);
          if (next.error) throw new Error(`Couldn't reload ${next.path}: ${next.error}`);
          const conflicts = keybindings.registry.findConflicts(next.overrides);
          if (conflicts.length > 0) {
            const details = conflicts
              .map((conflict) => `${conflict.key} (${conflict.ids.join(', ')})`)
              .join('; ');
            throw new Error(`Conflicting TUI keybindings: ${details}`);
          }
          resetConfig();
          await created.adapter.refreshPlugins();
          tuiKeybindingOverrides = next.overrides;
          keybindings.manager.setUserBindings({ ...keybindings.hostOverrides, ...next.overrides });
        },
        ...(options.resumeDraftAfterLogin ? { resumeDraftAfterLogin: true } : {}),
        checkForUpdate: async () =>
          resolveMcodeStartupUpdateNotice(await (await updateApplication()).inspect()),
        inspectUpdate: async () => (await updateApplication()).inspect(),
        applyUpdate: async (plan, progress) => (await updateApplication()).apply(plan, progress),
      });
      // Runtime failure also rejects hydration, which may never reach the await below.
      void app.ready.catch(() => undefined);
      if (app.editor) app.editor.disableSubmit = true;
      startupStatus = startTuiStartupStatus((status) => app?.setStartupStatus?.(status));
      removeProcessGuards = (dependencies.installProcessGuards ?? installTuiProcessGuards)({
        process,
        stop: () => app?.stop() ?? Promise.resolve(),
        report: (error) => {
          try {
            process.stderr.write(
              `Minimax Code TUI stopped unexpectedly: ${tuiErrorDiagnostic(error)}. Restart MCode; if it keeps happening, report it through an available support channel.\n`,
            );
          } catch {
            // The terminal may already be disconnected.
          }
        },
        capture: (error, context) => captureProcessFailure(incidentReporter, error, context),
        onStopCause: recordFirstProcessStop,
        onStopFailure: () => resolveProcessStopFailure?.(),
        isTerminalDead: () => terminalDeadObserved,
        ...(process.platform === 'win32'
          ? {}
          : {
              suspend: () => app?.suspend?.(),
              resume: async () => {
                await app?.resume?.();
                trackTuiLaunch('hot');
              },
              suspendProcess: () => process.kill(process.pid, 'SIGTSTP'),
            }),
      });
      app.start();
      firstFrameObservation = observeFirstTuiFrame(app, observability, processStopFailure);
      void firstFrameObservation.catch(() => undefined);
      const runtimeResult = await Promise.race([
        initializingRuntime.then(
          (created) => ({ status: 'ready' as const, runtime: created }),
          (error: unknown) => ({ status: 'failed' as const, error }),
        ),
        app.stopped.then(() => ({ status: 'stopped' as const })),
        processStopFailure.then(() => ({ status: 'stopped' as const })),
      ]);
      if (runtimeResult.status === 'stopped') {
        observability.recordStartup({
          phase: 'runtime.initialize',
          outcome: 'failed',
          durationMs: performance.now() - runtimeStartedAt,
          errorKind: 'StoppedDuringInitialization',
        });
        return;
      }
      if (runtimeResult.status === 'failed') {
        observability.recordStartup({
          phase: 'runtime.initialize',
          outcome: 'failed',
          durationMs: performance.now() - runtimeStartedAt,
          errorKind: errorKind(runtimeResult.error),
        });
        throw runtimeResult.error;
      }
      runtime = runtimeResult.runtime;
      runtimeInitialized = true;
      incidentReporter.breadcrumb('cli.runtime.initialize.succeeded');
      observability.recordStartup({
        phase: 'runtime.initialize',
        outcome: 'succeeded',
        durationMs: performance.now() - runtimeStartedAt,
      });
      await app.ready;
      initialStateReady = await prepareInitialTuiState(app, observability, options, runtime.adapter);
      startupStatus.stop();
      startupStatus = undefined;
      if (app.editor) app.editor.disableSubmit = false;
    } catch (error) {
      observability.recordStartup({
        phase: 'tui.start',
        outcome: 'failed',
        durationMs: performance.now() - tuiStartedAt,
        errorKind: errorKind(error),
      });
      throw error;
    }
    observability.recordStartup({
      phase: 'tui.start',
      outcome: 'succeeded',
      durationMs: performance.now() - tuiStartedAt,
    });
    const firstFrameRendered = await firstFrameObservation;
    if (!firstFrameRendered) {
      return;
    }
    tuiRunning = true;
    trackTuiLaunch('cold');
    incidentReporter.setPhase('runtime');
    incidentReporter.breadcrumb('cli.first-frame.rendered');

    const initialPrompt = initialStateReady ? options.initialPrompt?.trim() : undefined;
    if (initialPrompt) void submitInitialTuiPrompt(app, observability, initialPrompt);
    stoppedNormally = await Promise.race([
      app.stopped.then(() => true),
      processStopFailure.then(() => false),
    ]);
    if (stoppedNormally) activeSessionId = app.controller?.snapshot().session?.sessionId;
  } catch (error) {
    captureTuiIncidentBestEffort(incidentReporter, {
      eventType: tuiRunning ? 'cli_process_error' : 'cli_startup_error',
      error,
      component: tuiRunning ? 'tui' : 'startup',
      operation: 'launch-lifecycle',
      codeLocation: 'src/tui/launcher.ts#launchTui',
      severity: 'fatal',
      impact: 'exit',
      handled: false,
    });
    throw error;
  } finally {
    incidentReporter.setPhase('shutdown');
    incidentReporter.breadcrumb('cli.shutdown.started');
    stopStartupStatus(startupStatus);
    removeProcessGuards?.();
    if (app) {
      try {
        await Promise.resolve(app.stop());
      } catch (error) {
        captureShutdownFailure(incidentReporter, 'cli-ui', error);
      }
    }
    if (runtime && lifecycle) {
      try {
        runtimeShutdownFailed = await lifecycle.shutdownTuiRuntime(runtime, {
          reportFailure: (step, error) => {
            captureShutdownFailure(incidentReporter, step, error);
            try {
              process.stderr.write(
                `[minimax-code] ${step} cleanup failed: ${tuiErrorDiagnostic(error)}\n`,
              );
            } catch {
              // The terminal may already be disconnected.
            }
          },
        });
      } catch (error) {
        runtimeShutdownFailed = true;
        captureShutdownFailure(incidentReporter, 'runtime', error);
      }
      if (runtimeShutdownFailed) process.exitCode = 1;
    } else if (runtimePromise && lifecycle) {
      schedulePendingRuntimeShutdown(runtimePromise, lifecycle, incidentReporter);
    }
    try {
      await observability.flush();
    } catch (error) {
      captureTuiIncidentBestEffort(incidentReporter, {
        eventType: 'cli_persistence_error',
        error,
        component: 'observability',
        operation: 'flush',
        codeLocation: 'src/tui/launcher.ts#observability.flush',
        severity: 'warning',
        impact: 'degraded',
        handled: true,
      });
    }
    try {
      await businessTelemetry?.flush();
    } catch {
      // Business telemetry must not affect TUI shutdown.
    }
    incidentReporter.completeRun();
    await incidentReporter.flush();
    if (incidentReporter.runId) {
      process.off('uncaughtExceptionMonitor', onUncaughtExceptionMonitor);
    }
  }
  if (restartRequested && stoppedNormally && runtimeInitialized && !runtimeShutdownFailed) {
    await (dependencies.restartProcess ?? restartTuiProcess)(
      activeSessionId,
      restartRegion,
      restartInitialPrompt,
    );
    return;
  }
  if (stoppedNormally && runtimeInitialized && !runtimeShutdownFailed) {
    try {
      (dependencies.writeExitMessage ?? ((message) => process.stdout.write(message)))(
        formatTuiExitMessage(activeSessionId),
      );
    } catch {
      // A closed output stream must not turn a completed TUI shutdown into a failure.
    }
  }
}

function captureProcessFailure(
  incidentReporter: TuiIncidentReporter,
  error: unknown,
  context: TuiProcessFailureContext,
): void {
  const terminalFailure = context.origin === 'stdout' || context.origin === 'stderr';
  const shutdownFailure = context.origin === 'shutdown';
  captureTuiIncidentBestEffort(incidentReporter, {
    eventType: terminalFailure
      ? 'cli_terminal_error'
      : shutdownFailure
        ? 'cli_shutdown_error'
        : context.origin === 'suspend' || context.origin === 'resume'
          ? 'cli_interaction_error'
          : 'cli_process_error',
    error,
    component: terminalFailure ? 'terminal' : shutdownFailure ? 'shutdown' : 'process',
    operation: shutdownFailure ? 'cli-ui' : context.origin,
    codeLocation: 'src/tui/platform/process-guards.ts#installTuiProcessGuards',
    severity: context.terminalDead || shutdownFailure ? 'error' : 'fatal',
    impact: 'exit',
    handled: Boolean(context.terminalDead || shutdownFailure),
    context: {
      origin: context.origin,
      ...(context.terminalDead === undefined ? {} : { terminalDead: context.terminalDead }),
    },
  });
}

function captureShutdownFailure(
  incidentReporter: TuiIncidentReporter,
  step: string,
  error: unknown,
): void {
  captureTuiIncidentBestEffort(incidentReporter, {
    eventType: 'cli_shutdown_error',
    error,
    component: 'shutdown',
    operation: step,
    codeLocation: 'src/tui/launcher.ts#shutdown',
    severity: 'error',
    impact: 'degraded',
    handled: true,
  });
}

function schedulePendingRuntimeShutdown(
  runtimePromise: Promise<CreatedTuiRuntime>,
  lifecycle: RuntimeLifecycleModule,
  incidentReporter: TuiIncidentReporter,
): void {
  void runtimePromise
    .then(async (created) => {
      if (
        await lifecycle.shutdownTuiRuntime(created, {
          reportFailure: (step, error) => captureShutdownFailure(incidentReporter, step, error),
        })
      ) {
        process.exitCode = 1;
      }
    })
    .catch((error) => captureShutdownFailure(incidentReporter, 'pending-runtime', error));
}

async function observeFirstTuiFrame(
  app: LaunchApp,
  observability: TuiObservability,
  processStopFailure: Promise<void>,
): Promise<boolean> {
  const startedAt = performance.now();
  observability.recordStartup({ phase: 'tui.first-frame', outcome: 'started' });
  let rendered: boolean;
  try {
    rendered = await Promise.race([
      app.firstFrame.then(() => true),
      app.stopped.then(() => false),
      processStopFailure.then(() => false),
    ]);
  } catch (error) {
    observability.recordStartup({
      phase: 'tui.first-frame',
      outcome: 'failed',
      durationMs: performance.now() - startedAt,
      errorKind: errorKind(error),
    });
    throw error;
  }
  observability.recordStartup({
    phase: 'tui.first-frame',
    outcome: rendered ? 'succeeded' : 'failed',
    durationMs: performance.now() - startedAt,
    ...(rendered ? {} : { errorKind: 'StoppedBeforeFirstFrame' }),
  });
  return rendered;
}

function createTokenScopedAsyncResolver(
  resolveValue: () => Promise<string | undefined>,
): (accessToken: string | undefined) => Promise<string | undefined> {
  let activeAccessToken: string | undefined;
  let resolvedValue: string | undefined;
  let resolvePromise: Promise<string | undefined> | undefined;
  let retryAfter = 0;

  return async (accessToken) => {
    if (!accessToken) return undefined;
    if (activeAccessToken !== accessToken) {
      activeAccessToken = accessToken;
      resolvedValue = undefined;
      resolvePromise = undefined;
      retryAfter = 0;
    }
    if (resolvedValue) return resolvedValue;
    if (Date.now() < retryAfter) return undefined;
    const pending =
      resolvePromise ??
      resolveValue()
        .then((value) => {
          if (value) resolvedValue = value;
          else retryAfter = Date.now() + 60_000;
          return value;
        })
        .catch(() => {
          retryAfter = Date.now() + 60_000;
          return undefined;
        });
    resolvePromise = pending;
    try {
      return await pending;
    } finally {
      if (resolvePromise === pending) resolvePromise = undefined;
    }
  };
}

function stopStartupStatus(status: TuiStartupStatus | undefined): void {
  try {
    status?.stop();
  } catch {
    // Startup feedback must never affect the TUI lifecycle.
  }
}

export async function restartTuiProcess(
  sessionId?: string,
  region?: MavisRegion,
  initialPrompt?: string,
): Promise<void> {
  const args = resolveRestartArguments(process.execPath, process.argv, sessionId, initialPrompt);
  const environment = resolveRestartEnvironment(process.env, region);
  if (
    await schedulePendingMcodePrefixUpdate(
      process.argv[1],
      process.execPath,
      process.pid,
      args,
      environment,
    )
  ) {
    return;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== null && code !== 0) process.exitCode = code;
      else if (signal) process.exitCode = 1;
      resolve();
    });
  });
}

export function resolveRestartEnvironment(
  environment: NodeJS.ProcessEnv,
  region?: MavisRegion,
): NodeJS.ProcessEnv {
  return region ? markLoginRestartHandoff({ ...environment, MAVIS_REGION: region }) : environment;
}

export function resolveRestartArguments(
  executable: string,
  argv: readonly string[],
  sessionId?: string,
  initialPrompt?: string,
): string[] {
  const nodeExecutable = isNodeExecutable(executable);
  const userArgs = argv.slice(nodeExecutable ? 2 : 1);
  const startupEnvironment = resolveTuiStartupEnvironmentOption(userArgs, true);
  const environmentArgs = startupEnvironment ? ['--env', startupEnvironment] : [];
  const resumeArgs = sessionId ? ['--session', sessionId] : [];
  const promptArgs = initialPrompt ? [initialPrompt] : [];
  if (!nodeExecutable) return [...environmentArgs, ...resumeArgs, ...promptArgs];
  const entryFile = argv[1];
  if (!entryFile || !isExistingFile(entryFile)) {
    throw new Error('Unable to restart MCode because its Node.js entry file is unavailable.');
  }
  return [entryFile, ...environmentArgs, ...resumeArgs, ...promptArgs];
}

function isNodeExecutable(executable: string): boolean {
  const base = path.basename(executable).toLocaleLowerCase();
  return base === 'node' || base === 'node.exe';
}

function isVitestRuntime(): boolean {
  return (
    Boolean((import.meta as ImportMeta & { vitest?: unknown }).vitest) ||
    process.env.VITEST === 'true'
  );
}

function isExistingFile(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
}

export function formatTuiExitMessage(sessionId?: string): string {
  const sessionHint = sessionId ? formatTuiSessionHint(sessionId) : undefined;
  return `${sessionHint ?? '\n'}${sessionHint ? '\n' : ''}${MINIMAX_CODE_EXIT_SLOGAN}\n`;
}

export function formatTuiSessionHint(sessionId: string): string | undefined {
  const normalized = sessionId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(normalized)) return undefined;
  return `\nContinue this session with:\n  mcode --session ${normalized}\n`;
}

async function prepareInitialTuiState(
  app: LaunchApp,
  observability: TuiObservability,
  options: LaunchTuiOptions,
  runtime: TuiRuntime,
): Promise<boolean> {
  const sessionId = options.sessionId?.trim();
  if (sessionId) {
    try {
      if (!app.openSession) throw new Error('TUI Session open is unavailable.');
      await app.openSession(sessionId);
    } catch (error) {
      observability.recordStartup({
        phase: 'tui.initial-session-open',
        outcome: 'failed',
        errorKind: errorKind(error),
      });
      return false;
    }
  }
  if (options.continueLatestSession) {
    try {
      if (!app.continueLatestSession) throw new Error('TUI Session continuation is unavailable.');
      if (!(await app.continueLatestSession())) return false;
    } catch (error) {
      observability.recordStartup({
        phase: 'tui.initial-session-open',
        outcome: 'failed',
        errorKind: errorKind(error),
      });
      return false;
    }
  }
  if (options.model !== undefined) {
    const model = parseHeadlessModelOverride(options.model.trim());
    if (!app.controller?.ensureSession || !app.openSession) {
      throw new Error('TUI Session model selection is unavailable.');
    }
    const session = await app.controller.ensureSession();
    // The normal model picker also saves the global default. Startup overrides
    // must use the Session-only operation, before login checks or any submission.
    if (!(await runtime.selectSessionModel(model, session.sessionId))) {
      throw new Error(`Could not select --model ${options.model}. Check the provider and model id.`);
    }
    // Rehydrate account status, model/effort and queued-input state from Runtime.
    await app.openSession(session.sessionId);
  }
  if (options.showSessionPicker) await app.submit('/sessions');
  return true;
}

async function submitInitialTuiPrompt(
  app: LaunchApp,
  observability: TuiObservability,
  initialPrompt: string,
): Promise<void> {
  try {
    await app.submit(initialPrompt);
  } catch (error) {
    observability.recordStartup({
      phase: 'tui.initial-prompt',
      outcome: 'failed',
      errorKind: errorKind(error),
    });
  }
}

function errorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}
