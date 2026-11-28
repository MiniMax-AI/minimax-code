import type { ToolUserSteering } from './types.js';

const STEER_INTERRUPTION = 'ToolSteerInterruption';

/** Matched by name, so a tool still recognises it when the reason crossed a module copy. */
function steerInterruption(): Error {
  const reason = new Error('The user sent a new message.');
  reason.name = STEER_INTERRUPTION;
  return reason;
}

/** Whether `signal` aborted because the user steered, not because the Turn was stopped. */
export function isToolSteerInterruption(signal: AbortSignal | undefined): boolean {
  const reason: unknown = signal?.aborted === true ? signal.reason : undefined;
  return reason instanceof Error && reason.name === STEER_INTERRUPTION;
}

/**
 * The signal one `interruptOnSteer` call runs with. It follows the tool's own `signal` and also
 * aborts with a steer interruption once user steering is pending, at once when it already is:
 * the host re-arms its wake right after firing, so a message that arrived before the call
 * started would otherwise be missed. A wake from machine delivery re-checks and keeps waiting.
 * Watching stops when `until` aborts.
 */
export function steerInterruptibleSignal(
  signal: AbortSignal | undefined,
  steering: ToolUserSteering,
  until: AbortSignal,
): AbortSignal {
  const steered = new AbortController();
  const watch = (): void => {
    if (until.aborted || steered.signal.aborted) return;
    // Subscribe before checking so steering admitted in between still wakes this call.
    const wake = steering.changed();
    if (steering.pending()) {
      steered.abort(steerInterruption());
      return;
    }
    wake?.addEventListener('abort', watch, { once: true, signal: until });
  };
  watch();
  // The tool's own signal comes first: a stop that already happened keeps its reason.
  return signal ? AbortSignal.any([signal, steered.signal]) : steered.signal;
}
