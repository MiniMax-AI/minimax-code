import { loadTuiRuntimeConfig } from '../headless/config.js';
import { exitCodeForExecError, TuiExecError } from '../headless/exit-policy.js';
import { formatTuiExecFailure } from '../headless/error-presentation.js';
import { resolveTuiExecInvocation, type RawTuiExecOptions } from '../headless/invocation.js';
import { runTuiExec } from '../headless/runner.js';
import { prepareTuiDataDir } from '../runtime/data-dir.js';
import { createTuiRuntime, shutdownTuiRuntime } from '../runtime/lifecycle.js';

type TuiTerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

interface TuiExecProcess {
  exitCode?: number | string;
  once(signal: TuiTerminationSignal, listener: () => void): unknown;
  off(signal: TuiTerminationSignal, listener: () => void): unknown;
}

export interface RunTuiExecCommandDependencies {
  readonly processRef?: TuiExecProcess;
  readonly writeError?: (value: string) => void;
  readonly resolveInvocation?: typeof resolveTuiExecInvocation;
  readonly resolveDataDir?: () => string | Promise<string>;
  readonly loadConfig?: typeof loadTuiRuntimeConfig;
  readonly createRuntime?: typeof createTuiRuntime;
  readonly shutdownRuntime?: typeof shutdownTuiRuntime;
  readonly runExec?: typeof runTuiExec;
  readonly readStdin?: (signal: AbortSignal) => Promise<string>;
}

export async function runTuiExecCommand(
  prompt: string | undefined,
  commandOptions: RawTuiExecOptions,
  version: string,
  dependencies: RunTuiExecCommandDependencies = {},
): Promise<void> {
  const processRef = dependencies.processRef ?? process;
  const writeError = dependencies.writeError ?? ((value: string) => process.stderr.write(value));
  const resolveInvocation = dependencies.resolveInvocation ?? resolveTuiExecInvocation;
  const resolveDataDir = dependencies.resolveDataDir ?? prepareTuiDataDir;
  const loadConfig = dependencies.loadConfig ?? loadTuiRuntimeConfig;
  const createRuntime = dependencies.createRuntime ?? createTuiRuntime;
  const shutdownRuntime = dependencies.shutdownRuntime ?? shutdownTuiRuntime;
  const runExec = dependencies.runExec ?? runTuiExec;
  const readStdin = dependencies.readStdin ?? readTuiStdinToEnd;
  const invocationController = new AbortController();
  const cancelInvocation = () => invocationController.abort();
  const assertNotCancelled = () => {
    if (invocationController.signal.aborted) {
      throw new TuiExecError('cancelled', 'Invocation was cancelled.');
    }
  };
  processRef.once('SIGINT', cancelInvocation);
  processRef.once('SIGTERM', cancelInvocation);
  processRef.once('SIGHUP', cancelInvocation);
  try {
    const invocation = await resolveInvocation(
      prompt,
      commandOptions,
      () => readStdin(invocationController.signal),
      invocationController.signal,
    );
    assertNotCancelled();
    const dataDir = await resolveDataDir();
    assertNotCancelled();
    const explicitConfig = invocation.configPath
      ? await loadConfig(invocation.configPath, { dataDir })
      : undefined;
    assertNotCancelled();
    const runtime = await createRuntime(
      {
        dataDir,
        workspaceDir: invocation.workspaceDir,
        version,
        ...(invocation.configPath ? { configPath: invocation.configPath } : {}),
        surface: 'headless',
        promptMode: invocation.promptMode ?? 'tui',
        permissionMode: runtimePermissionMode(invocation.permission),
        ...(invocation.sandboxMode ? { sandboxMode: invocation.sandboxMode } : {}),
        ...(commandOptions.lane ? { lane: commandOptions.lane } : {}),
      },
      explicitConfig
        ? {
            getConfig: () => explicitConfig,
            configSource: 'explicit',
          }
        : {},
    );
    processRef.exitCode = await runExec(
      {
        prompt: invocation.prompt,
        workspaceDir: invocation.workspaceDir,
        version,
        attachments: invocation.attachments,
        format: invocation.format,
        ...(invocation.model ? { model: invocation.model } : {}),
        ...(invocation.effort ? { effort: invocation.effort } : {}),
        ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
        continueSession: invocation.continueSession,
        permission: invocation.permission,
        ...(invocation.diagnosticsDir ? { diagnosticsDir: invocation.diagnosticsDir } : {}),
        ...(invocation.timeoutMs !== undefined ? { timeoutMs: invocation.timeoutMs } : {}),
        ...(invocation.maxSteps !== undefined ? { maxSteps: invocation.maxSteps } : {}),
        ...(invocation.outputSchema === undefined ? {} : { outputSchema: invocation.outputSchema }),
        ...(invocation.outputLastMessagePath === undefined
          ? {}
          : { outputLastMessagePath: invocation.outputLastMessagePath }),
        ...(invocation.reviewRequest ? { reviewRequest: invocation.reviewRequest } : {}),
      },
      {
        runtime: runtime.adapter,
        signal: invocationController.signal,
        shutdown: () => shutdownRuntime(runtime),
      },
    );
  } catch (error) {
    const normalized =
      error instanceof TuiExecError
        ? error
        : new TuiExecError('runtime', error instanceof Error ? error.message : String(error), {
            cause: error,
          });
    writeError(`mcode exec failed: ${formatTuiExecFailure(normalized)}\n`);
    processRef.exitCode = exitCodeForExecError(normalized);
  } finally {
    processRef.off('SIGINT', cancelInvocation);
    processRef.off('SIGTERM', cancelInvocation);
    processRef.off('SIGHUP', cancelInvocation);
  }
}

function runtimePermissionMode(
  permission: 'smart' | 'full' | 'off',
): 'auto' | 'bypassPermissions' | 'off' {
  switch (permission) {
    case 'smart':
      return 'auto';
    case 'full':
      return 'bypassPermissions';
    case 'off':
      return 'off';
  }
}

interface TuiStdinStream {
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
}

export async function readTuiStdinToEnd(
  signal: AbortSignal,
  stream: TuiStdinStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await readNextStdinChunk(iterator, signal);
      if (next.done) break;
      chunks.push(Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value));
    }
  } finally {
    await iterator.return?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readNextStdinChunk(
  iterator: AsyncIterator<Buffer | string>,
  signal: AbortSignal,
): Promise<IteratorResult<Buffer | string>> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      reject(new TuiExecError('cancelled', 'stdin input was cancelled.'));
    };
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    void iterator.next().then(
      (next) => {
        signal.removeEventListener('abort', cancel);
        resolve(next);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
  });
}
