export type TuiTerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGBREAK';

export type TuiProcessStopSource =
  | 'signal'
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'stdin.error'
  | 'stdout.error'
  | 'stderr.error'
  | 'suspend.failure'
  | 'resume.failure'
  | 'terminal.start.sync'
  | 'terminal.stop.sync'
  | 'terminal.drainInput.async'
  | 'terminal.write.sync'
  | 'terminal.moveBy.sync'
  | 'terminal.hideCursor.sync'
  | 'terminal.showCursor.sync'
  | 'terminal.clearLine.sync'
  | 'terminal.clearFromCursor.sync'
  | 'terminal.clearScreen.sync'
  | 'terminal.setTitle.sync'
  | 'terminal.setProgress.sync';

export interface TuiProcessStopCause {
  readonly source: TuiProcessStopSource;
  readonly terminalDead: boolean;
  readonly error?: unknown;
  readonly signal?: TuiTerminationSignal;
  readonly bytes?: number;
}

const DEAD_TERMINAL_CODES = new Set(['EIO', 'EPIPE', 'ENOTCONN', 'EOF']);

export function isDeadTerminalFailure(source: TuiProcessStopSource, error: unknown): boolean {
  return isTerminalStreamSource(source) && hasDeadTerminalCode(error);
}

function hasDeadTerminalCode(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    DEAD_TERMINAL_CODES.has(error.code)
  );
}

function isTerminalStreamSource(source: TuiProcessStopSource): boolean {
  return (
    source === 'stdin.error' ||
    source === 'stdout.error' ||
    source === 'stderr.error' ||
    source.startsWith('terminal.')
  );
}
