import { Console } from 'node:console';
import type { Readable, Writable } from 'node:stream';

import { getConfig, resetConfig, resolveBetaFeature, type MavisRegion } from '@mavis/config';

import type { TuiAcpRuntime } from '../acp/runtime.js';
import { takeAcpAuthApiKeyFromEnvironment } from '../acp/agent.js';
import { serveTuiAcpStdio } from '../acp/stdio.js';
import { resolveMcodeAuthEnvironment } from '../auth/environment.js';
import { writeTuiRegionPreference } from '../auth/region-preference.js';
import { prepareTuiDataDir } from '../runtime/data-dir.js';
import { createDeferredTuiRuntime } from '../runtime/deferred.js';
import type { SystemPromptOverrides } from './system-prompt-options.js';
import type {
  CreatedTuiRuntime,
  createTuiRuntime,
  shutdownTuiRuntime,
} from '../runtime/lifecycle.js';

type TuiTerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

interface TuiAcpProcess {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  once(signal: TuiTerminationSignal, listener: () => void): unknown;
  off(signal: TuiTerminationSignal, listener: () => void): unknown;
}

export interface RunTuiAcpCommandDependencies {
  readonly processRef?: TuiAcpProcess;
  readonly workspaceDir?: () => string;
  readonly prepareDataDir?: typeof prepareTuiDataDir;
  readonly createRuntime?: typeof createTuiRuntime;
  readonly shutdownRuntime?: typeof shutdownTuiRuntime;
  readonly serve?: typeof serveTuiAcpStdio;
  readonly loadRuntimeLifecycle?: () => Promise<{
    createTuiRuntime: typeof createTuiRuntime;
    shutdownTuiRuntime: typeof shutdownTuiRuntime;
  }>;
}

interface ResolvedRuntimeLifecycle {
  readonly createTuiRuntime: typeof createTuiRuntime;
  readonly shutdownTuiRuntime: typeof shutdownTuiRuntime;
}

export async function runTuiAcpCommand(
  version: string,
  dependencies: RunTuiAcpCommandDependencies = {},
  lane?: string,
  systemPromptOverrides?: SystemPromptOverrides,
): Promise<void> {
  const processRef = dependencies.processRef ?? process;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('ACP process is stopping.'));
  const restoreConsole = redirectConsoleOutputToStderr(processRef.stderr);
  let runtime: CreatedTuiRuntime | undefined;
  let shutdownRuntime = dependencies.shutdownRuntime;
  let pendingRegionSwitch: Promise<unknown> = Promise.resolve();
  let serveSettled = false;
  processRef.once('SIGINT', cancel);
  processRef.once('SIGTERM', cancel);
  processRef.once('SIGHUP', cancel);
  try {
    // Taken before the embedded Runtime exists, which spawns model Bash commands with this process
    // environment: a client may pass the key at every start even when it never calls authenticate.
    const authApiKey = takeAcpAuthApiKeyFromEnvironment();
    const dataDir = await (dependencies.prepareDataDir ?? prepareTuiDataDir)();
    const runtimeOptions = {
      dataDir,
      workspaceDir: (dependencies.workspaceDir ?? (() => process.cwd()))(),
      version,
      surface: 'acp' as const,
      // ACP clients choose a mode per process; it must not change Desktop or other
      // Runtimes that share this profile's config.yaml.
      permissionModeScope: 'process' as const,
      ...(lane ? { lane } : {}),
      ...(systemPromptOverrides ? { systemPromptOverrides } : {}),
    };

    let loadedLifecycle: ResolvedRuntimeLifecycle | undefined =
      dependencies.createRuntime && dependencies.shutdownRuntime
        ? {
            createTuiRuntime: dependencies.createRuntime,
            shutdownTuiRuntime: dependencies.shutdownRuntime,
          }
        : undefined;
    let lifecyclePromise: Promise<ResolvedRuntimeLifecycle> | undefined;
    const resolveLifecycle = async (): Promise<ResolvedRuntimeLifecycle> => {
      if (loadedLifecycle) return loadedLifecycle;
      lifecyclePromise ??= (
        dependencies.loadRuntimeLifecycle ?? (() => import('../runtime/lifecycle.js'))
      )().then((module) => {
        loadedLifecycle = {
          createTuiRuntime: dependencies.createRuntime ?? module.createTuiRuntime,
          shutdownTuiRuntime: dependencies.shutdownRuntime ?? module.shutdownTuiRuntime,
        };
        shutdownRuntime ??= loadedLifecycle.shutdownTuiRuntime;
        return loadedLifecycle;
      });
      return lifecyclePromise;
    };

    // Start Runtime loading in the background so ACP stdio can answer `initialize` immediately
    // instead of blocking behind chunk imports, auth checks, and SQLite/Runtime initialization.
    const initialAdapterPromise = (async (): Promise<TuiAcpRuntime> => {
      const lifecycle = loadedLifecycle ?? (await resolveLifecycle());
      shutdownRuntime ??= lifecycle.shutdownTuiRuntime;
      if (serveSettled && !dependencies.createRuntime) {
        throw new Error('ACP connection closed before Runtime initialization started.');
      }
      runtime = await lifecycle.createTuiRuntime(runtimeOptions);
      return runtime.adapter;
    })();
    void initialAdapterPromise.catch(() => undefined);
    pendingRegionSwitch = initialAdapterPromise.catch(() => undefined);

    // Serialized after initial startup so concurrent authenticate requests cannot stop or start a Runtime twice.
    const switchRegion = (region: MavisRegion): Promise<TuiAcpRuntime> => {
      const next = pendingRegionSwitch.then(async () => {
        if (runtime && process.env.MAVIS_REGION === region) return runtime.adapter;
        const lifecycle = loadedLifecycle ?? (await resolveLifecycle());
        const stopRuntime = shutdownRuntime ?? lifecycle.shutdownTuiRuntime;
        shutdownRuntime ??= stopRuntime;
        const previousRuntime = runtime;
        // A failed rebuild must not leave the stopped Runtime for a retry or the final shutdown.
        runtime = undefined;
        if (previousRuntime) await stopRuntime(previousRuntime);
        process.env.MAVIS_REGION = region;
        // Config caches region-derived defaults such as the managed MiniMax gateway.
        resetConfig();
        runtime = await lifecycle.createTuiRuntime(runtimeOptions);
        return runtime.adapter;
      });
      pendingRegionSwitch = next.catch(() => undefined);
      return next;
    };
    const rememberRegion = (region: MavisRegion): void => {
      try {
        // The record `mcode login --region` writes; the next ACP or CLI start reads it.
        writeTuiRegionPreference(dataDir, {
          region,
          buildEnv: resolveMcodeAuthEnvironment().buildEnv,
        });
      } catch (error) {
        // As with `mcode login`, the completed authentication stands; only the next start's
        // region default is lost.
        const message = error instanceof Error ? error.message : String(error);
        processRef.stderr.write(
          `[minimax-code] Could not remember the account region for the next start: ${message}\n`,
        );
      }
    };

    const deferredRuntime = createDeferredTuiRuntime(initialAdapterPromise, {
      isGoalEnabled: () => {
        try {
          return resolveBetaFeature('threadGoal', getConfig().beta?.threadGoal, {
            internalBuild: process.env.__MAVIS_BUILD_INTERNAL === 'true',
          });
        } catch {
          return false;
        }
      },
    });

    try {
      await (dependencies.serve ?? serveTuiAcpStdio)({
        runtime: deferredRuntime,
        version,
        input: processRef.stdin,
        output: processRef.stdout,
        signal: controller.signal,
        switchRegion,
        rememberRegion,
        ...(authApiKey ? { authApiKey } : {}),
      });
    } finally {
      serveSettled = true;
    }
  } finally {
    processRef.off('SIGINT', cancel);
    processRef.off('SIGTERM', cancel);
    processRef.off('SIGHUP', cancel);
    try {
      // The connection can close while startup or authenticate is still building the Runtime.
      await pendingRegionSwitch;
      if (runtime && shutdownRuntime) await shutdownRuntime(runtime);
    } finally {
      restoreConsole();
    }
  }
}

function redirectConsoleOutputToStderr(stderr: Writable): () => void {
  const original = globalThis.console;
  globalThis.console = new Console({ stdout: stderr, stderr });
  return () => {
    globalThis.console = original;
  };
}
