import { createLocalBashOperations, type BashOperations } from '@earendil-works/pi-coding-agent/tools';
import type { BashEnvPolicy } from '@mavis/agent-core/bash-subprocess-env';
import type { LocalSandboxBashOperationsFactory } from '@mavis/agent-tools/desktop';

import { initializeLocalBackgroundBashExecutor } from '../background-bash/index.js';
import type { DeferredLocalSandboxBashOperationsFactory } from './contracts.js';
import type {
  LocalSandboxService,
  SandboxInvocationLease,
  NativeInvocationLease,
} from './local-sandbox-service.js';
import { SandboxError } from './sandbox-errors.js';
import { sandboxErrorOutcome } from './observability/invocation-trace.js';
import type { SandboxInvocationOutcome } from './observability/contracts.js';

/**
 * Bridges the V1 tool graph constructed before the V2 service owner is ready.
 * An unbound disabled port preserves native execution; an enabled one fails closed.
 */
export function createDeferredLocalSandboxBashOperationsFactory(
  desiredEnabled: () => boolean,
  /** Carries the runtime's PATH shims into background bash; see ensureRmShim. */
  envPolicy: BashEnvPolicy,
): DeferredLocalSandboxBashOperationsFactory {
  let current: LocalSandboxBashOperationsFactory | undefined;
  const fallback = createUnavailableSandboxBashOperationsFactory(desiredEnabled);
  let executor: ReturnType<typeof initializeLocalBackgroundBashExecutor>;
  const port: DeferredLocalSandboxBashOperationsFactory = {
    create: (input) => (current ?? fallback).create(input),
    execute: (input) => executor.execute(input),
    bind: (factory) => {
      current = factory;
    },
  };
  executor = initializeLocalBackgroundBashExecutor(port, envPolicy);
  return port;
}

/** Temporary owner adapter until the concrete operation factory is wired. */
function createUnavailableSandboxBashOperationsFactory(
  effectiveEnabled: () => boolean,
): LocalSandboxBashOperationsFactory {
  return {
    create: (input) => {
      if (effectiveEnabled()) {
        throw new SandboxError(
          'SANDBOX_UNAVAILABLE',
          'invocation',
          'Sandbox Bash operations are unavailable',
        );
      }
      const nativeOperations = createLocalBashOperations({
        parentDeathGuard: input.identity.operationClass !== 'direct_foreground',
      });
      // Unbound and disabled still has to report admission, or a background
      // task started through this fallback would stay `queued` forever.
      return {
        separatesOutputStreams: nativeOperations.separatesOutputStreams,
        exec: async (command, cwd, options) => {
          await input.onPreflightComplete?.();
          return nativeOperations.exec(command, cwd, options);
        },
      };
    },
  };
}

/** Build the single operations path shared by all local Bash operation classes. */
export function createSandboxBashOperationsFactory(
  service: Pick<LocalSandboxService, 'beginInvocation'>,
): LocalSandboxBashOperationsFactory {
  return {
    create: (input) => {
      const nativeOperations = createLocalBashOperations({
        parentDeathGuard: input.identity.operationClass !== 'direct_foreground',
      });
      return {
        separatesOutputStreams: nativeOperations.separatesOutputStreams,
        exec: async (command, cwd, options) => {
          const lease = await service.beginInvocation({
            identity: input.identity,
            workspaceRoot: input.workspaceRoot,
            cwd,
          });
          return executeObserved({
            nativeOperations,
            lease,
            command,
            cwd,
            options,
            ...(input.onPreflightComplete
              ? { onPreflightComplete: input.onPreflightComplete }
              : {}),
          });
        },
      };
    },
  };
}

type ObservedExecutionInput = {
  readonly nativeOperations: BashOperations;
  readonly lease: SandboxInvocationLease | NativeInvocationLease;
  readonly command: string;
  readonly cwd: string;
  readonly options: Parameters<BashOperations['exec']>[2];
  readonly onPreflightComplete?: () => void | Promise<void>;
};

async function executeObserved(
  input: ObservedExecutionInput,
): Promise<{ exitCode: number | null }> {
  const { nativeOperations, lease, command, cwd, options } = input;
  let wrapped: Awaited<ReturnType<SandboxInvocationLease['backend']['wrap']>> | undefined;
  const processFacts = createProcessObserver(input);
  const signal = lease.sandboxed
    ? combineAbortSignals(options.signal, lease.signal)
    : options.signal;
  let outcome: SandboxInvocationOutcome = {
    termination: 'unknown',
    reasonCode: 'EXECUTION_OUTCOME_UNKNOWN',
  };
  try {
    wrapped = await wrapInvocation(input, signal);
    await input.onPreflightComplete?.();
    lease.trace.stage('exec.requested');
    const result = await nativeOperations.exec(wrapped?.command ?? command, cwd, {
      ...options,
      signal,
      env: wrapped?.env ?? options.env,
      onProcessEvent: processFacts.observe,
    });
    outcome = exitOutcome(result.exitCode);
    return result;
  } catch (error) {
    outcome = executionFailureOutcome(error, processFacts, {
      signal,
      callerSignal: options.signal,
    });
    throw error;
  } finally {
    await lease.finish(wrapped?.handle, outcome);
  }
}

async function wrapInvocation(input: ObservedExecutionInput, signal?: AbortSignal) {
  const { lease, command, cwd, options } = input;
  if (!lease.sandboxed) return undefined;
  try {
    const wrapped = await lease.backend.wrap({
      command,
      cwd,
      baseEnv: options.env ?? {},
      sandboxTempDir: lease.context.sandboxTempDir,
      abortSignal: signal,
      commandId: lease.srtCommandId,
      commandText: lease.srtCommandId,
      gitSafeDirectories: lease.context.git.safeDirectories,
      filesystem: lease.context.filesystem,
    });
    lease.trace.stage('invocation.wrapped', wrapped.observation ?? { wrap_policy: 'unknown' });
    return wrapped;
  } catch (error) {
    if (error instanceof SandboxError) throw error;
    throw new SandboxError(
      'SANDBOX_WRAP_FAILED',
      'pre-spawn',
      error instanceof Error ? error.message : 'Sandbox command wrapping failed',
    );
  }
}

function createProcessObserver(input: ObservedExecutionInput) {
  const facts = { spawned: false, spawnFailed: false, timedOut: false };
  const observe: NonNullable<ObservedExecutionInput['options']['onProcessEvent']> = (event) => {
    if (event.type === 'spawned') facts.spawned = true;
    if (event.type === 'spawn_failed') facts.spawnFailed = true;
    if (event.type === 'timeout') facts.timedOut = true;
    input.lease.trace.stage(
      event.type === 'spawned' ? 'process.started' : `process.${event.type}`,
      {
        process_role: event.processRole,
      },
    );
    try {
      input.options.onProcessEvent?.(event);
    } catch {
      /* best effort */
    }
  };
  return Object.assign(facts, { observe });
}

function exitOutcome(exitCode: number | null): SandboxInvocationOutcome {
  if (exitCode === 0)
    return { termination: 'exited_zero', exitCode, reasonCode: 'PROCESS_EXITED_ZERO' };
  if (exitCode === null)
    return { termination: 'unknown', exitCode, reasonCode: 'PROCESS_SIGNAL_EXIT' };
  return { termination: 'exited_nonzero', exitCode, reasonCode: 'PROCESS_NONZERO_EXIT' };
}

function executionFailureOutcome(
  error: unknown,
  facts: { spawned: boolean; spawnFailed: boolean; timedOut: boolean },
  signals: { signal?: AbortSignal; callerSignal?: AbortSignal },
): SandboxInvocationOutcome {
  if (signals.signal?.aborted)
    return {
      termination: 'aborted',
      reasonCode: signals.callerSignal?.aborted ? 'CALLER_ABORTED' : 'RUNTIME_SHUTDOWN',
    };
  if (facts.timedOut) return { termination: 'timed_out', reasonCode: 'PROCESS_TIMEOUT' };
  if (facts.spawnFailed) return { termination: 'spawn_failed', reasonCode: 'PROCESS_SPAWN_FAILED' };
  return { ...sandboxErrorOutcome(error), termination: facts.spawned ? 'unknown' : 'not_started' };
}

function combineAbortSignals(caller: AbortSignal | undefined, service: AbortSignal): AbortSignal {
  return caller ? AbortSignal.any([caller, service]) : service;
}
