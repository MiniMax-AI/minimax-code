import {
  MINIMAX_CODE_SUPPORTED_NODE_VERSIONS,
  MINIMAX_CODE_VERSION,
  supportsTuiNodeVersion,
} from '../build-info.js';
import type { RawTuiExecOptions } from '../headless/invocation.js';
import type { MavisRegion } from '@mavis/config';
import { createTuiProgram, type TuiInteractiveLaunchRequest } from './program.js';
import type { McodeProviderCliRequest } from './provider-command.js';
import type { McodePluginCliRequest } from '../plugin/contract.js';
import { tuiErrorDiagnostic } from '../user-facing-failure.js';
import { configureTuiNetworkProxy } from './network-proxy.js';
import { consumeLoginRestartHandoff } from '../tui/login-restart-handoff.js';
import type { McodeTelemetryCliAction } from './telemetry-command.js';

const OUTPUT_DRAIN_TIMEOUT_MS = 250;
const MINIMAX_CODE_PROCESS_TITLE = 'minimax-code';

export interface TuiOutputStream {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(value: string, callback?: (error?: Error | null) => void): unknown;
  once?(event: 'error', listener: (error: Error) => void): unknown;
  off?(event: 'error', listener: (error: Error) => void): unknown;
}

export interface TuiCliProcess {
  title: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly versions: { readonly node: string };
  readonly stdout: TuiOutputStream;
  readonly stderr: TuiOutputStream;
  exitCode?: number | string;
  exit(code: number): unknown;
}

interface LaunchTuiInput extends TuiInteractiveLaunchRequest {
  readonly version: string;
}

export interface RunTuiCliDependencies {
  readonly processRef?: TuiCliProcess;
  readonly platform?: NodeJS.Platform;
  readonly createProgram?: typeof createTuiProgram;
  readonly supportsNodeVersion?: (version: string) => boolean;
  readonly launchTui?: (input: LaunchTuiInput) => Promise<void>;
  readonly runExec?: (
    prompt: string | undefined,
    options: RawTuiExecOptions,
    version: string,
  ) => Promise<void>;
  readonly runAcp?: (version: string, lane?: string) => Promise<void>;
  readonly runLogin?: (
    region?: MavisRegion,
    openBrowser?: boolean,
    lane?: string,
  ) => Promise<string>;
  readonly runLogout?: (region?: MavisRegion) => Promise<string>;
  readonly runUpdate?: (version: string) => Promise<void>;
  readonly runProvider?: (
    request: McodeProviderCliRequest,
    version: string,
    lane?: string,
  ) => Promise<string>;
  readonly runPlugin?: (
    request: McodePluginCliRequest,
    version: string,
    lane?: string,
  ) => Promise<string>;
  readonly runTelemetry?: (
    action: McodeTelemetryCliAction,
    version: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<string> | string;
  readonly configureNetworkProxy?: typeof configureTuiNetworkProxy;
  readonly allowStartupEnvironmentSelection?: boolean;
  readonly outputDrainTimeoutMs?: number;
}

export async function runTuiCli(dependencies: RunTuiCliDependencies = {}): Promise<void> {
  const processRef = dependencies.processRef ?? process;
  processRef.title = MINIMAX_CODE_PROCESS_TITLE;
  const resumeDraftAfterLogin = consumeLoginRestartHandoff(processRef.env);
  const supportsNodeVersion =
    dependencies.supportsNodeVersion ?? ((version: string) => supportsTuiNodeVersion(version));
  if (!supportsNodeVersion(processRef.versions.node)) {
    processRef.stderr.write(
      `Minimax Code supports Node.js ${MINIMAX_CODE_SUPPORTED_NODE_VERSIONS}; current version is ${processRef.versions.node}.\n`,
    );
    processRef.exitCode = 1;
    return;
  }

  let completedCommandExitMode: 'force' | 'natural' | undefined;
  try {
    (dependencies.configureNetworkProxy ?? configureTuiNetworkProxy)({
      environment: processRef.env,
    });
    const createProgram = dependencies.createProgram ?? createTuiProgram;
    await createProgram({
      version: MINIMAX_CODE_VERSION,
      allowStartupEnvironmentSelection: dependencies.allowStartupEnvironmentSelection,
      launchTui: async ({
        initialPrompt,
        model,
        sessionId,
        showSessionPicker,
        continueLatestSession,
        workspaceDir,
        tuiMode,
        lane,
      }) => {
        const launchTui = dependencies.launchTui ?? defaultLaunchTui;
        await launchTui({
          version: MINIMAX_CODE_VERSION,
          ...(initialPrompt ? { initialPrompt } : {}),
          ...(model ? { model } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(showSessionPicker ? { showSessionPicker: true } : {}),
          ...(continueLatestSession ? { continueLatestSession: true } : {}),
          ...(workspaceDir ? { workspaceDir } : {}),
          ...(tuiMode ? { tuiMode } : {}),
          ...(lane ? { lane } : {}),
          ...(resumeDraftAfterLogin ? { resumeDraftAfterLogin: true } : {}),
        });
        completedCommandExitMode = 'force';
      },
      runExec: async (prompt, commandOptions, lane) => {
        const runExec = dependencies.runExec ?? defaultRunExec;
        await runExec(
          prompt,
          lane ? { ...commandOptions, lane } : commandOptions,
          MINIMAX_CODE_VERSION,
        );
        completedCommandExitMode = 'natural';
      },
      runAcp: async (lane) => {
        const runAcp = dependencies.runAcp ?? defaultRunAcp;
        await runAcp(MINIMAX_CODE_VERSION, lane);
        completedCommandExitMode = 'natural';
      },
      runLogin: async (region, openBrowser, lane) => {
        const runLogin = dependencies.runLogin ?? defaultRunLogin;
        processRef.stdout.write(`${await runLogin(region, openBrowser, lane)}\n`);
        completedCommandExitMode = 'natural';
      },
      runLogout: async (region) => {
        const runLogout = dependencies.runLogout ?? defaultRunLogout;
        processRef.stdout.write(`${await runLogout(region)}\n`);
        completedCommandExitMode = 'natural';
      },
      runUpdate: async () => {
        completedCommandExitMode = 'natural';
        const runUpdate = dependencies.runUpdate ?? defaultRunUpdate;
        await runUpdate(MINIMAX_CODE_VERSION);
      },
      runProvider: async (request, lane) => {
        const runProvider = dependencies.runProvider ?? defaultRunProvider;
        processRef.stdout.write(`${await runProvider(request, MINIMAX_CODE_VERSION, lane)}\n`);
        completedCommandExitMode = 'natural';
      },
      runPlugin: async (request, lane) => {
        const runPlugin = dependencies.runPlugin ?? defaultRunPlugin;
        processRef.stdout.write(`${await runPlugin(request, MINIMAX_CODE_VERSION, lane)}\n`);
        completedCommandExitMode = 'natural';
      },
      runTelemetry: async (action) => {
        const runTelemetry = dependencies.runTelemetry ?? defaultRunTelemetry;
        processRef.stdout.write(await runTelemetry(action, MINIMAX_CODE_VERSION, processRef.env));
        completedCommandExitMode = 'natural';
      },
    }).parseAsync(processRef.argv, { from: 'node' });

    if (completedCommandExitMode) {
      const exitCode = typeof processRef.exitCode === 'number' ? processRef.exitCode : 0;
      await Promise.all([
        drainTuiOutput(
          processRef.stdout,
          dependencies.outputDrainTimeoutMs ?? OUTPUT_DRAIN_TIMEOUT_MS,
        ),
        drainTuiOutput(
          processRef.stderr,
          dependencies.outputDrainTimeoutMs ?? OUTPUT_DRAIN_TIMEOUT_MS,
        ),
      ]);
      if (
        (dependencies.platform ?? process.platform) === 'win32' &&
        completedCommandExitMode === 'natural'
      ) {
        processRef.exitCode = exitCode;
      } else {
        processRef.exit(exitCode);
      }
    }
  } catch (error) {
    processRef.stderr.write(`${await formatTuiCliError(error)}\n`);
    processRef.exitCode = 1;
  }
}

async function formatTuiCliError(error: unknown): Promise<string> {
  const diagnostic = tuiErrorDiagnostic(error);
  if (
    !/better[-_]sqlite3/iu.test(diagnostic) ||
    !/Could not locate the bindings file|Cannot find (?:module|package)|NODE_MODULE_VERSION|Module did not self-register/iu.test(
      diagnostic,
    )
  ) {
    return diagnostic;
  }

  const { buildMcodePackageManagerCommand } = await import('../update/install-source.js');
  const command = buildMcodePackageManagerCommand('npm-global', MINIMAX_CODE_VERSION);
  return [
    'MCode could not load its native SQLite dependency.',
    'If npm reported blocked install scripts, the installation needs explicit script approval.',
    'Reinstall with the original installer. For npm installations, run:',
    `  ${command.display} --foreground-scripts`,
    '',
    `Original error: ${diagnostic}`,
  ].join('\n');
}

export function drainTuiOutput(stream: TuiOutputStream, timeoutMs: number): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onError = () => finish(true);
    const finish = (awaitingErrorEvent = false) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (!awaitingErrorEvent) stream.off?.('error', onError);
      resolve();
    };
    timeout = setTimeout(finish, timeoutMs);
    timeout.unref?.();
    stream.once?.('error', onError);
    try {
      stream.write('', (error) => finish(Boolean(error)));
    } catch {
      finish();
    }
  });
}

async function defaultLaunchTui(input: LaunchTuiInput): Promise<void> {
  const { launchTui } = await import('../tui/launcher.js');
  await launchTui(input);
}

async function defaultRunExec(
  prompt: string | undefined,
  options: RawTuiExecOptions,
  version: string,
): Promise<void> {
  const { runTuiExecCommand } = await import('./run-exec-command.js');
  await runTuiExecCommand(prompt, options, version);
}

async function defaultRunAcp(version: string, lane?: string): Promise<void> {
  const { runTuiAcpCommand } = await import('./run-acp-command.js');
  await runTuiAcpCommand(version, {}, lane);
}

async function defaultRunLogin(
  region?: MavisRegion,
  openBrowser = true,
  lane?: string,
): Promise<string> {
  const { runTuiLogin } = await import('./auth-command.js');
  return runTuiLogin({ region, openBrowser, lane });
}

async function defaultRunLogout(region?: MavisRegion): Promise<string> {
  const { runTuiLogout } = await import('./auth-command.js');
  return runTuiLogout({ region });
}

async function defaultRunUpdate(version: string): Promise<void> {
  const { runMcodeUpdate } = await import('./update.js');
  await runMcodeUpdate(version);
}

async function defaultRunProvider(
  request: McodeProviderCliRequest,
  version: string,
  lane?: string,
): Promise<string> {
  const { runMcodeProviderCommand } = await import('./provider-command.js');
  return runMcodeProviderCommand({ request, version, lane });
}

async function defaultRunPlugin(
  request: McodePluginCliRequest,
  version: string,
  lane?: string,
): Promise<string> {
  const { runMcodePluginCommand } = await import('./plugin-command.js');
  return runMcodePluginCommand({ request, version, lane });
}

async function defaultRunTelemetry(
  action: McodeTelemetryCliAction,
  version: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const { runMcodeTelemetryCommand } = await import('./telemetry-command.js');
  return runMcodeTelemetryCommand(action, version, { environment });
}
