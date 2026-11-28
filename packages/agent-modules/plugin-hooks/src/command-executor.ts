import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const MAX_OUTPUT_BYTES = 64 * 1024;
const PROCESS_DRAIN_BUDGET_MS = 500;

/** One resolved Hook command, ready to run in the host's execution environment. */
export interface PluginHookCommandExecution {
  /** Session the event belongs to; the child session for subagent events. */
  readonly sessionId: string;
  readonly command: string;
  readonly args: readonly string[];
  /** When true, run `[command, ...args].join(' ')` through the POSIX shell (`/bin/sh -c`). */
  readonly shell: boolean;
  readonly cwd: string;
  /** Complete command environment; nothing else is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** Serialized wire input, written to stdin before stdin is closed. */
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** Host-owned writable Plugin directory; the executor creates it before starting the command. */
  readonly pluginDataDir: string;
  /**
   * Plugin package root (the configuration directory for config handlers). A remote executor may
   * prepare only this package before running the command; the local executor ignores it.
   */
  readonly pluginRoot: string;
}

export type PluginHookCommandOutcome =
  | {
      readonly reason: 'exit';
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
      /** Descendants left running after exit were killed. */
      readonly processKilled: boolean;
    }
  | {
      readonly reason: 'timeout' | 'aborted' | 'overflow' | 'error';
      readonly processKilled: boolean;
    };

/**
 * Runs one Hook command. It resolves `timeout` once `timeoutMs` elapses, `aborted` once
 * `signal` aborts, and `overflow` when stdout or stderr exceeds 64 KiB; `error` covers
 * failures to start. A rejection is treated as `error`.
 */
export type PluginHookCommandExecutor = (
  execution: PluginHookCommandExecution,
) => Promise<PluginHookCommandOutcome>;

/** Default executor: a detached local process group, killed on timeout, abort, or overflow. */
export async function spawnHookCommand(
  execution: PluginHookCommandExecution,
): Promise<PluginHookCommandOutcome> {
  let child: ChildProcess;
  try {
    await mkdir(execution.pluginDataDir, { recursive: true, mode: 0o700 });
    child = spawn(execution.command, execution.args, {
      cwd: execution.cwd,
      env: execution.env,
      shell: execution.shell,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return { reason: 'error', processKilled: false };
  }
  const overflowController = new AbortController();
  const readOutput = collectOutput(child, () => overflowController.abort());
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(execution.stdin);
  const result = await waitForChild(
    child,
    execution.timeoutMs,
    [execution.signal],
    overflowController.signal,
  );
  const captured = readOutput();
  if (result.reason !== 'exit') return { reason: result.reason, processKilled: true };
  if (captured.overflow) return { reason: 'overflow', processKilled: false };
  return {
    reason: 'exit',
    code: result.code,
    stdout: captured.stdout,
    stderr: captured.stderr,
    processKilled: await terminateRemainingProcessGroup(child),
  };
}

function collectOutput(
  child: ChildProcess,
  onOverflow: () => void,
): () => { stdout: string; stderr: string; overflow: boolean } {
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let overflow = false;
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length + chunk.length > MAX_OUTPUT_BYTES && !overflow) {
      overflow = true;
      onOverflow();
    }
    stdout = Buffer.concat([stdout, chunk]).subarray(0, MAX_OUTPUT_BYTES);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length + chunk.length > MAX_OUTPUT_BYTES && !overflow) {
      overflow = true;
      onOverflow();
    }
    stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_OUTPUT_BYTES);
  });
  return () => ({
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
    overflow,
  });
}

function waitForChild(
  child: ChildProcess,
  timeoutMs: number,
  signals: readonly AbortSignal[],
  overflowSignal: AbortSignal,
): Promise<
  | { readonly reason: 'exit'; readonly code: number; readonly killed: false }
  | { readonly reason: 'aborted' | 'timeout' | 'overflow'; readonly killed: true }
> {
  return new Promise((resolve) => {
    let settled = false;
    let stopping = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      value:
        | { readonly reason: 'exit'; readonly code: number; readonly killed: false }
        | { readonly reason: 'aborted' | 'timeout' | 'overflow'; readonly killed: true },
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', abort);
      overflowSignal.removeEventListener('abort', overflow);
      resolve(value);
    };
    const stop = async (reason: 'aborted' | 'timeout' | 'overflow') => {
      if (stopping || settled) return;
      stopping = true;
      await terminateAndDrain(child);
      finish({ reason, killed: true });
    };
    const abort = () => void stop('aborted');
    const overflow = () => void stop('overflow');
    timer = setTimeout(() => void stop('timeout'), timeoutMs);
    child.once('error', () => finish({ reason: 'exit', code: 1, killed: false }));
    child.once('close', (code) => {
      if (!stopping) finish({ reason: 'exit', code: code ?? 1, killed: false });
    });
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    overflowSignal.addEventListener('abort', overflow, { once: true });
    if (signals.some((signal) => signal.aborted)) abort();
    else if (overflowSignal.aborted) overflow();
  });
}

async function terminateAndDrain(child: ChildProcess): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('close', () => resolve());
  });
  try {
    if (process.platform === 'win32' && child.pid) {
      const killed = await waitBounded(runTaskkill(child.pid), PROCESS_DRAIN_BUDGET_MS, false);
      if (!killed) child.kill('SIGKILL');
    } else if (child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may already have exited.
    }
  }
  await waitBounded(closed, PROCESS_DRAIN_BUDGET_MS, undefined);
}

async function terminateRemainingProcessGroup(child: ChildProcess): Promise<boolean> {
  if (!child.pid) return false;
  if (process.platform === 'win32') {
    return await waitBounded(runTaskkill(child.pid), PROCESS_DRAIN_BUDGET_MS, false);
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

async function runTaskkill(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => resolve(false));
    killer.once('close', (code) => resolve(code === 0));
  });
}

async function waitBounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutValue: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
