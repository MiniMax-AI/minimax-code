import type { EventEmitter } from 'node:events';
import {
  isDeadTerminalFailure,
  type TuiProcessStopCause,
  type TuiTerminationSignal,
} from './process-stop-cause.js';

type GuardEventSource = Pick<EventEmitter, 'on' | 'off'>;

export interface TuiProcessLike extends GuardEventSource {
  readonly stdin: GuardEventSource;
  readonly stdout: GuardEventSource;
  readonly stderr: GuardEventSource;
  exitCode?: string | number;
}

export interface TuiProcessGuardOptions {
  process: TuiProcessLike;
  stop(): void | Promise<void>;
  report(error: unknown): void;
  capture?(error: unknown, context: TuiProcessFailureContext): void;
  onStopCause?(cause: TuiProcessStopCause): void;
  onStopFailure?(error: unknown): void;
  isTerminalDead?(): boolean;
  suspend?(): void | Promise<void>;
  resume?(): void | Promise<void>;
  suspendProcess?(): void;
}

export interface TuiProcessFailureContext {
  readonly origin:
    | 'uncaughtException'
    | 'unhandledRejection'
    | 'stdin'
    | 'stdout'
    | 'stderr'
    | 'suspend'
    | 'resume'
    | 'shutdown';
  readonly terminalDead?: boolean;
}

export interface TuiProcessWarningEmitter {
  emitWarning: NodeJS.Process['emitWarning'];
  readonly throwDeprecation?: boolean;
  readonly noDeprecation?: boolean;
}

export interface TuiProcessWarningGuardOptions {
  readonly process: TuiProcessWarningEmitter;
  readonly onWarning: (name: string) => void;
}

interface NormalizedProcessWarning {
  readonly fingerprint: string;
  readonly name: string;
  readonly warning: Error;
}

export function installTuiProcessWarningGuard(options: TuiProcessWarningGuardOptions): () => void {
  const originalEmitWarning = options.process.emitWarning;
  const replayWarning = originalEmitWarning as (...args: unknown[]) => void;
  const bufferedWarnings = new Map<string, Error>();
  const emitGuarded = (...args: unknown[]): void => {
    const normalized = normalizeProcessWarning(args, emitGuarded);
    // Node raises a --throw-deprecation warning as a next-tick error and drops a
    // --no-deprecation one, both inside the emitter. Buffering either would move a strict runtime
    // check past TUI shutdown or print a warning Node meant to suppress, so keep Node's timing and
    // only defer the terminal output of non-fatal warnings.
    if (
      normalized.name === 'DeprecationWarning' &&
      (options.process.throwDeprecation === true || options.process.noDeprecation === true)
    ) {
      notifyProcessWarning(options, normalized.name);
      replayWarning.apply(options.process, args);
      return;
    }
    if (bufferedWarnings.has(normalized.fingerprint)) return;
    bufferedWarnings.set(normalized.fingerprint, normalized.warning);
    notifyProcessWarning(options, normalized.name);
  };
  options.process.emitWarning = emitGuarded as NodeJS.Process['emitWarning'];

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    options.process.emitWarning = originalEmitWarning;
    for (const warning of bufferedWarnings.values()) {
      replayWarning.call(options.process, warning);
    }
  };
}

function notifyProcessWarning(options: TuiProcessWarningGuardOptions, name: string): void {
  try {
    options.onWarning(name);
  } catch {
    // Warning diagnostics must never affect the process warning itself.
  }
}

/**
 * Build the Warning object Node would have built, while the emitting call site is still on the
 * stack. Replaying raw arguments later loses that stack — `--trace-warnings` would report the
 * guard and the launcher cleanup instead of the real source, and a caller-supplied `ctor` would
 * already have left the stack, so it could not trim anything.
 */
function normalizeProcessWarning(
  args: readonly unknown[],
  trimTarget: (...args: unknown[]) => void,
): NormalizedProcessWarning {
  const [rawWarning, typeOrOptions, maybeCode] = args;
  const warningOptions =
    typeof typeOrOptions === 'object' && typeOrOptions !== null
      ? (typeOrOptions as { code?: unknown; ctor?: unknown; detail?: unknown; type?: unknown })
      : undefined;
  const source = rawWarning instanceof Error ? rawWarning : undefined;
  // Node only applies type, code and detail to string warnings; an Error keeps its own identity.
  const type = source
    ? undefined
    : typeof typeOrOptions === 'string'
      ? typeOrOptions
      : typeof warningOptions?.type === 'string'
        ? warningOptions.type
        : undefined;
  const code = source
    ? undefined
    : typeof maybeCode === 'string'
      ? maybeCode
      : typeof warningOptions?.code === 'string'
        ? warningOptions.code
        : undefined;
  const detail = source
    ? undefined
    : typeof warningOptions?.detail === 'string'
      ? warningOptions.detail
      : undefined;
  const warning = source ?? new Error(String(rawWarning));
  if (!source) {
    warning.name = type ?? 'Warning';
    const annotated = warning as Error & { code?: string; detail?: string };
    if (code !== undefined) annotated.code = code;
    if (detail !== undefined) annotated.detail = detail;
    captureProcessWarningStack(
      warning,
      [args[3], warningOptions?.ctor].find((candidate) => typeof candidate === 'function'),
      trimTarget,
    );
  }
  const annotated = warning as Error & { code?: unknown; detail?: unknown };
  const name = warning.name;
  return {
    fingerprint: JSON.stringify([
      name,
      warning.message,
      typeof annotated.code === 'string' ? annotated.code : '',
      typeof annotated.detail === 'string' ? annotated.detail : '',
    ]),
    name,
    warning,
  };
}

function captureProcessWarningStack(
  warning: Error,
  ctor: unknown,
  trimTarget: (...args: unknown[]) => void,
): void {
  if (typeof Error.captureStackTrace !== 'function') return;
  // Node trims the emitter frame so the trace starts at the caller of process.emitWarning; the
  // guard takes that role here, and an explicit ctor still trims its own frame.
  Error.captureStackTrace(warning, typeof ctor === 'function' ? ctor : trimTarget);
}

export function installTuiProcessGuards(options: TuiProcessGuardOptions): () => void {
  let stopping = false;
  let disposed = false;
  let suspending = false;
  let suspended = false;

  const report = (error: unknown): void => {
    try {
      options.report(error);
    } catch {
      // Diagnostics must never replace the original process failure.
    }
  };
  const capture = (error: unknown, context: TuiProcessFailureContext): void => {
    try {
      options.capture?.(error, context);
    } catch {
      // Incident capture must never replace the original process failure.
    }
  };
  const notifyStopFailure = (error: unknown): void => {
    try {
      options.onStopFailure?.(error);
    } catch {
      // Failure notification must not replace the shutdown failure.
    }
  };
  const notifyStopCause = (cause: TuiProcessStopCause): void => {
    try {
      options.onStopCause?.(cause);
    } catch {
      // Diagnostics must never replace the original process failure.
    }
  };
  const stop = (
    cause: TuiProcessStopCause,
    failure?: unknown,
    suppressFailureReport = false,
  ): void => {
    if (stopping) return;
    stopping = true;
    notifyStopCause(cause);
    const shouldSuppressFailureReport = (): boolean =>
      suppressFailureReport || cause.terminalDead || options.isTerminalDead?.() === true;
    void Promise.resolve()
      .then(() => options.stop())
      .catch((stopFailure: unknown) => {
        options.process.exitCode = 1;
        const terminalDead =
          shouldSuppressFailureReport() || isDeadTerminalFailure('terminal.stop.sync', stopFailure);
        capture(stopFailure, {
          origin: 'shutdown',
          ...(terminalDead ? { terminalDead: true } : {}),
        });
        if (!terminalDead) report(stopFailure);
        notifyStopFailure(stopFailure);
      })
      .finally(() => {
        if (failure !== undefined && !shouldSuppressFailureReport()) report(failure);
      });
  };
  const fail = (
    source: Extract<
      TuiProcessStopCause['source'],
      `${string}.failure` | 'uncaughtException' | 'unhandledRejection'
    >,
    origin: Extract<
      TuiProcessFailureContext['origin'],
      'uncaughtException' | 'unhandledRejection' | 'suspend' | 'resume'
    >,
    error: unknown,
  ): void => {
    options.process.exitCode = 1;
    const terminalDead = isDeadTerminalFailure(source, error);
    capture(error, { origin, ...(terminalDead ? { terminalDead: true } : {}) });
    stop({ source, error, terminalDead }, error);
  };
  const onSignal = (signal: TuiTerminationSignal): void =>
    stop({ source: 'signal', signal, terminalDead: false });
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  const onSighup = (): void => onSignal('SIGHUP');
  const onSigbreak = (): void => onSignal('SIGBREAK');
  const suspendSupported = Boolean(options.suspend && options.resume && options.suspendProcess);
  const onSuspend = (): void => {
    if (!suspendSupported || stopping || suspending || suspended) return;
    suspending = true;
    void Promise.resolve()
      .then(() => options.suspend?.())
      .then(() => {
        if (stopping || disposed) return;
        suspended = true;
        options.process.off('SIGTSTP', onSuspend);
        options.suspendProcess?.();
      })
      .catch((error: unknown) => fail('suspend.failure', 'suspend', error))
      .finally(() => {
        suspending = false;
      });
  };
  const onContinue = (): void => {
    if (!suspendSupported || stopping || !suspended) return;
    suspended = false;
    options.process.on('SIGTSTP', onSuspend);
    void Promise.resolve()
      .then(() => options.resume?.())
      .catch((error: unknown) => fail('resume.failure', 'resume', error));
  };
  const onUncaughtException = (error: unknown): void =>
    fail('uncaughtException', 'uncaughtException', error);
  const onUnhandledRejection = (error: unknown): void =>
    fail('unhandledRejection', 'unhandledRejection', error);
  const onTerminalStreamError = (origin: 'stdin' | 'stdout' | 'stderr', error: unknown): void => {
    const source = `${origin}.error` as const;
    const cause = {
      source,
      error,
      terminalDead: isDeadTerminalFailure(source, error),
    } satisfies TuiProcessStopCause;
    // A closed terminal (EIO, EPIPE, ...) is not a defect, and it fires on almost every closed
    // window after SIGHUP; the stop cause already records it as `terminal_dead`. Without the stdin
    // listener a hung-up TTY read (`read EIO`) would surface as an uncaught exception instead.
    if (!cause.terminalDead) capture(error, { origin });
    if (!cause.terminalDead) {
      options.process.exitCode = 1;
      stop(cause, error);
      return;
    }
    options.process.exitCode = 1;
    stop(cause, undefined, true);
  };
  const onStdinError = (error: unknown): void => onTerminalStreamError('stdin', error);
  const onStdoutError = (error: unknown): void => onTerminalStreamError('stdout', error);
  const onStderrError = (error: unknown): void => onTerminalStreamError('stderr', error);

  options.process.on('SIGINT', onSigint);
  options.process.on('SIGTERM', onSigterm);
  options.process.on('SIGHUP', onSighup);
  options.process.on('SIGBREAK', onSigbreak);
  if (suspendSupported) {
    options.process.on('SIGTSTP', onSuspend);
    options.process.on('SIGCONT', onContinue);
  }
  options.process.on('uncaughtException', onUncaughtException);
  options.process.on('unhandledRejection', onUnhandledRejection);
  options.process.stdin.on('error', onStdinError);
  options.process.stdout.on('error', onStdoutError);
  options.process.stderr.on('error', onStderrError);

  return () => {
    if (disposed) return;
    disposed = true;
    options.process.off('SIGINT', onSigint);
    options.process.off('SIGTERM', onSigterm);
    options.process.off('SIGHUP', onSighup);
    options.process.off('SIGBREAK', onSigbreak);
    if (suspendSupported) {
      options.process.off('SIGTSTP', onSuspend);
      options.process.off('SIGCONT', onContinue);
    }
    options.process.off('uncaughtException', onUncaughtException);
    options.process.off('unhandledRejection', onUnhandledRejection);
    options.process.stdin.off('error', onStdinError);
    options.process.stdout.off('error', onStdoutError);
    options.process.stderr.off('error', onStderrError);
  };
}
