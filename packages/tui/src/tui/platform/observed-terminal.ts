import type { Terminal } from '../engine/public.js';
import {
  isDeadTerminalFailure,
  type TuiProcessStopCause,
  type TuiProcessStopSource,
} from './process-stop-cause.js';

export function createObservedTerminal(
  terminal: Terminal,
  onStopCause: (cause: TuiProcessStopCause) => void,
): Terminal {
  const observeSync = <T>(source: TuiProcessStopSource, operation: () => T, bytes?: number): T => {
    try {
      return operation();
    } catch (error) {
      notifyStopCause(onStopCause, {
        source,
        error,
        terminalDead: isDeadTerminalFailure(source, error),
        ...(bytes === undefined ? {} : { bytes }),
      });
      throw error;
    }
  };

  return {
    get columns() {
      return terminal.columns;
    },
    get rows() {
      return terminal.rows;
    },
    get kittyProtocolActive() {
      return terminal.kittyProtocolActive;
    },
    get focused() {
      return terminal.focused;
    },
    start: (onInput, onResize) =>
      observeSync('terminal.start.sync', () => terminal.start(onInput, onResize)),
    stop: () => observeSync('terminal.stop.sync', () => terminal.stop()),
    drainInput: (maxMs, idleMs) =>
      terminal.drainInput(maxMs, idleMs).catch((error: unknown) => {
        const source = 'terminal.drainInput.async';
        notifyStopCause(onStopCause, {
          source,
          error,
          terminalDead: isDeadTerminalFailure(source, error),
        });
        throw error;
      }),
    write: (data) =>
      observeSync(
        'terminal.write.sync',
        () => terminal.write(data),
        Buffer.byteLength(data, 'utf8'),
      ),
    moveBy: (lines) => observeSync('terminal.moveBy.sync', () => terminal.moveBy(lines)),
    hideCursor: () => observeSync('terminal.hideCursor.sync', () => terminal.hideCursor()),
    showCursor: () => observeSync('terminal.showCursor.sync', () => terminal.showCursor()),
    clearLine: () => observeSync('terminal.clearLine.sync', () => terminal.clearLine()),
    clearFromCursor: () =>
      observeSync('terminal.clearFromCursor.sync', () => terminal.clearFromCursor()),
    clearScreen: () => observeSync('terminal.clearScreen.sync', () => terminal.clearScreen()),
    setTitle: (title) => observeSync('terminal.setTitle.sync', () => terminal.setTitle(title)),
    setProgress: (active) =>
      observeSync('terminal.setProgress.sync', () => terminal.setProgress(active)),
  };
}

function notifyStopCause(
  callback: (cause: TuiProcessStopCause) => void,
  cause: TuiProcessStopCause,
): void {
  try {
    callback(cause);
  } catch {
    // Diagnostics must never replace the terminal failure.
  }
}
