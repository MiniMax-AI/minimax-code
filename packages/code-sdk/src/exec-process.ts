import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline';

import type { SpawnCommand } from './cli-resolver.js';
import {
  errorForExit,
  MCodeAbortError,
  MCodeError,
  MCodeNotFoundError,
  MCodeProtocolError,
  MCodeRunError,
  MCodeVersionError,
} from './errors.js';
import { parseEventLine } from './protocol.js';
import type { ThreadEvent, ThreadItem } from './types.js';

/**
 * CLI runtime shutdown budget (`DEFAULT_RUNTIME_SHUTDOWN_TIMEOUT_MS` in
 * `packages/tui/src/runtime/lifecycle.ts`). Cancel and the timeout backstop wait at least this
 * long so a CLI that is already shutting down can still write `exec.completed`.
 */
export const CLI_SHUTDOWN_BUDGET_MS = 60_000;

/** Slack for work the CLI does before it starts its own `timeoutMs` timer. */
export const CLI_STARTUP_SLACK_MS = 30_000;

/** Cancellation and cleanup timings. Mutable only so tests can shorten them. */
export const processTimings = {
  /** SIGTERM → SIGKILL. Covers {@link CLI_SHUTDOWN_BUDGET_MS}. */
  cancelGraceMs: CLI_SHUTDOWN_BUDGET_MS,
  /** After `exec.completed`, how long a lingering CLI may take to exit before SIGKILL. */
  terminateGraceMs: 5_000,
  /**
   * Extra time after `timeoutMs` before the SDK force-kills a CLI that did not stop itself.
   * Shutdown budget plus startup slack, because the SDK timer starts at spawn and the CLI timer
   * starts only after access, session and model resolution.
   */
  backstopExtraMs: CLI_SHUTDOWN_BUDGET_MS + CLI_STARTUP_SLACK_MS,
  /**
   * After the CLI exits, how long to keep reading stdout / stderr. A grandchild process that
   * inherited the pipes can keep them open indefinitely; the streams are destroyed afterwards.
   */
  exitDrainMs: 2_000,
};

const STDERR_TAIL_BYTES = 64 * 1024;

const liveChildren = new Set<ChildProcess>();
const tempDirectories = new Set<string>();
let exitHookInstalled = false;

/** Registers a prompt directory so `process.exit()` can delete it synchronously. */
export function trackTempDir(directory: string): void {
  tempDirectories.add(directory);
  ensureExitHook();
}

export function untrackTempDir(directory: string): void {
  tempDirectories.delete(directory);
}

/**
 * SIGTERM to live CLI processes, then `rmSync` of prompt directories. Installed as the `exit`
 * hook: asynchronous cleanup does not run after `process.exit()`.
 */
export function releaseTrackedResources(): void {
  for (const live of liveChildren) {
    try {
      // The CLI treats SIGTERM as a graceful cancel.
      live.kill('SIGTERM');
    } catch {
      // The child already exited.
    }
  }
  liveChildren.clear();
  for (const directory of tempDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Already removed.
    }
  }
  tempDirectories.clear();
}

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', releaseTrackedResources);
}

function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  ensureExitHook();
}

export interface ExecProcessOptions {
  readonly command: SpawnCommand;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly prompt: string;
  /** Test seam. Production uses `node:child_process` `spawn` with `shell: false`. */
  readonly spawn?: typeof spawn;
  readonly signal?: AbortSignal;
  /** CLI-side timeout; enables the SDK backstop at `timeoutMs + backstopExtraMs`. */
  readonly timeoutMs?: number;
  /** Called for each parsed event; return false to drop it from the stream. */
  readonly onEvent?: (event: ThreadEvent) => boolean;
  /** Current normalized items, attached to errors raised without an `exec.completed` result. */
  readonly items?: () => readonly ThreadItem[];
  /** Session already known before the first event (resumed Threads). */
  readonly sessionId?: string;
}

/**
 * One `mcode exec` child process. Starts immediately and buffers parsed events until consumed,
 * so an unconsumed stream still runs to completion and releases its resources.
 */
export class ExecProcess {
  private readonly child: ChildProcess;
  private readonly queue: ThreadEvent[] = [];
  private wake: (() => void) | undefined;
  private finished = false;
  private failure: Error | undefined;
  private completed = false;
  private exited = false;
  private abortRequested = false;
  private backstopFired = false;
  private stderrTail = '';
  private sessionId: string | undefined;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly onAbort = (): void => this.interrupt();
  private exitCodeValue: number | null = null;
  private resolveDone!: () => void;
  /** Resolves once the child has exited (or failed to start) and resources are released. */
  readonly done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(private readonly options: ExecProcessOptions) {
    const { command } = options;
    const spawnChild = options.spawn ?? spawn;
    this.child = spawnChild(command.command, command.args, {
      env: options.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    this.sessionId = options.sessionId;
    trackChild(this.child);
    // Before attach(): a failed spawn emits 'error' with null stdio on the next tick, and
    // reading stdout throws before a listener registered later in attach() can run.
    this.child.once('error', (error: NodeJS.ErrnoException) => this.onChildError(error));
    this.attach();
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    // `abort` listeners added after the signal fired are never called.
    if (options.signal?.aborted) this.interrupt();
    if (options.timeoutMs !== undefined) {
      this.schedule(options.timeoutMs + processTimings.backstopExtraMs, () => {
        // After exit only the pipe drain is pending; that is not a timeout.
        if (this.exited) return;
        this.backstopFired = true;
        this.kill('SIGKILL');
      });
    }
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  /** Yields events in CLI order; throws on process or protocol failure. */
  async *events(): AsyncGenerator<ThreadEvent, void, undefined> {
    try {
      for (;;) {
        const next = this.queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (this.finished) {
          if (this.failure) throw this.failure;
          return;
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    } finally {
      // The consumer stopped early: cancel the Turn instead of leaving the CLI running.
      if (!this.exited) this.interrupt();
    }
  }

  /**
   * SIGTERM, then SIGKILL after {@link processTimings.cancelGraceMs}.
   * SIGTERM is the CLI's cancel signal (same path as SIGINT). Starting there avoids a second
   * SIGINT after Ctrl+C, which would hit the default action once the CLI's one-shot SIGINT
   * handler has already run and would skip shutdown and `exec.completed`. On Windows,
   * `kill('SIGTERM')` is a hard kill.
   */
  interrupt(): void {
    if (this.exited || this.abortRequested) return;
    this.abortRequested = true;
    this.kill('SIGTERM');
    this.schedule(processTimings.cancelGraceMs, () => this.kill('SIGKILL'));
  }

  private onChildError(error: NodeJS.ErrnoException): void {
    this.exited = true;
    this.fail(
      error.code === 'ENOENT' || error.code === 'EACCES'
        ? new MCodeNotFoundError(`Could not start mcode (${error.code}).`, { cause: error })
        : new MCodeError(`Could not start mcode: ${error.message}`, { cause: error }),
    );
    this.cleanup();
  }

  private attach(): void {
    const { child } = this;
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      this.exited = true;
      const error = new MCodeError('mcode stdout is unavailable.');
      this.fail(error);
      this.cleanup();
      throw error;
    }
    let lines = 0;
    let streamsOpen = 2;
    let settled = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const settle = (force = false): void => {
      if (settled || !exit || (streamsOpen > 0 && !force)) return;
      settled = true;
      this.settle(exit.code, exit.signal);
    };

    stdin.on('error', () => {
      // EPIPE when the CLI exits before reading stdin; the exit code reports the cause.
    });
    stdin.end(JSON.stringify({ prompt: this.options.prompt }));

    stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    stderr.once('close', () => {
      streamsOpen -= 1;
      settle();
    });

    const reader = createInterface({ input: stdout, crlfDelay: Infinity });
    reader.on('line', (line) => {
      if (this.finished || this.completed) return;
      lines += 1;
      try {
        const event = parseEventLine(line);
        if (!event) return;
        this.sessionId ??= event.sessionId;
        if (this.options.onEvent?.(event) === false) return;
        this.push(event);
        if (event.type === 'exec.completed') this.onCompleted();
      } catch (error) {
        this.fail(withDiagnostics(error, this.stderrTail, lines));
        this.interrupt();
      }
    });
    reader.once('close', () => {
      streamsOpen -= 1;
      settle();
    });

    child.once('exit', (code, signal) => {
      this.exited = true;
      exit = { code, signal };
      settle();
      if (settled) return;
      // Normally the pipes close right after exit; a grandchild holding them must not stall us.
      // Settling clears this timer together with the other process timers.
      this.schedule(processTimings.exitDrainMs, () => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        reader.close();
        settle(true);
      });
    });
  }

  private onCompleted(): void {
    this.completed = true;
    // exec.completed is terminal; a CLI that lingers afterwards is force-stopped.
    this.schedule(processTimings.terminateGraceMs, () => this.kill('SIGKILL'));
  }

  private settle(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCodeValue = code;
    this.cleanup();
    if (this.finished) return;
    if (this.completed) {
      this.finish();
      return;
    }
    const items = this.options.items?.() ?? [];
    const details = {
      exitCode: code,
      signal,
      stderr: this.stderrTail,
      items,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
    };
    if (this.backstopFired) {
      this.fail(
        new MCodeRunError('The MCode run exceeded timeoutMs and was force-stopped by the SDK.', {
          ...details,
          status: 'timeout',
        }),
      );
      return;
    }
    if (this.abortRequested && code !== 2) {
      this.fail(new MCodeAbortError('The MCode run was cancelled.', details));
      return;
    }
    this.fail(errorForExit(details));
  }

  private push(event: ThreadEvent): void {
    this.queue.push(event);
    this.signalConsumer();
  }

  private fail(error: Error): void {
    if (this.finished) return;
    this.failure = error;
    this.finish();
  }

  private finish(): void {
    this.finished = true;
    this.signalConsumer();
  }

  private signalConsumer(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private kill(signal: NodeJS.Signals): void {
    if (this.exited) return;
    try {
      this.child.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private schedule(delayMs: number, action: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      action();
    }, delayMs);
    this.timers.add(timer);
  }

  private cleanup(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    liveChildren.delete(this.child);
    this.options.signal?.removeEventListener('abort', this.onAbort);
    this.resolveDone();
  }
}

function withDiagnostics(error: unknown, stderr: string, line: number): Error {
  const message = `${error instanceof Error ? error.message : String(error)} (stdout line ${String(line)})`;
  const details = { stderr, cause: error instanceof Error ? error.cause : undefined };
  if (error instanceof MCodeVersionError) return new MCodeVersionError(message, details);
  return new MCodeProtocolError(message, details);
}
