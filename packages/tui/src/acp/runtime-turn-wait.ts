/**
 * The wait a new ACP prompt makes, before admission or before its bounded busy retry, for a
 * Runtime-owned Turn to release the Session busy lock, and how its outcome maps to the prompt.
 */
import type * as acp from '@agentclientprotocol/sdk';

import type { TuiStreamEvent } from '../runtime/stream-events.js';
import {
  createTuiAcpSessionAwaitingDecisionError,
  createTuiAcpSessionBusyError,
} from './extensions.js';
import type { TuiAcpRuntime } from './runtime.js';
import { isSessionTurnTerminal } from './session-settle.js';

/**
 * - `settled`: the Runtime reports no active Turn;
 * - `unknown`: the Runtime state could not be read or watched; callers fail open;
 * - `cancelled`: the caller's signal ended the wait;
 * - `timed-out`: the Turn was still active when the bound elapsed;
 * - `running-elsewhere`: another MCode process runs the Turn, which no ACP prompt here started;
 * - `decision-blocked`: the Turn waits for an answer to a questionnaire or permission request.
 *   Unlike settlement this does not end by itself, and between prompts ACP has no channel to
 *   show the request to the Client, so waiting would only run into the bound.
 */
export type RuntimeTurnWait =
  | 'settled'
  | 'unknown'
  | 'cancelled'
  | 'timed-out'
  | 'running-elsewhere'
  | 'decision-blocked';

/**
 * The error a prompt fails with after its admission wait; `undefined` admits the prompt. A
 * `cancelled` wait is answered as a cancelled prompt by the caller's own cancellation check.
 */
export function admissionWaitError(
  wait: RuntimeTurnWait,
  maxWaitMs: number,
): acp.RequestError | undefined {
  switch (wait) {
    case 'settled':
    case 'unknown':
    case 'cancelled':
      return undefined;
    case 'timed-out':
      return createTuiAcpSessionBusyError(
        'turn-wait-timeout',
        `The prompt waited ${maxWaitMs} ms for the active Runtime Turn; nothing was sent.`,
      );
    case 'running-elsewhere':
      return createTuiAcpSessionBusyError(
        'turn-running-elsewhere',
        'Another MiniMax Code process runs this Session Turn; nothing was sent.',
      );
    case 'decision-blocked':
      return createTuiAcpSessionAwaitingDecisionError();
    default: {
      const unhandled: never = wait;
      return unhandled;
    }
  }
}

/**
 * Whether a send rejected as busy is retried after waiting. Only a released lock (or an
 * unreadable state, fail-open) can admit the same send; a bounded-out, foreign or
 * decision-blocked Turn would reject it again.
 */
export function retriesAfterBusyWait(wait: RuntimeTurnWait): boolean {
  switch (wait) {
    case 'settled':
    case 'unknown':
      return true;
    case 'cancelled':
    case 'timed-out':
    case 'running-elsewhere':
    case 'decision-blocked':
      return false;
    default: {
      const unhandled: never = wait;
      return unhandled;
    }
  }
}

/**
 * A Turn stream frame announcing that the Turn now waits for a questionnaire answer (the frames
 * run-coordinator treats as a questionnaire). It ends a watch round early so the next Runtime read
 * reports `decision-blocked` instead of the wait running into its bound. Permission requests have
 * no Turn stream frame; a running Turn that asks one is seen by the Runtime re-read that
 * {@link watchTurnUntilStateChange} makes every `maxPollIntervalMs` while it watches.
 */
function isAwaitingDecisionFrame(event: TuiStreamEvent): boolean {
  return (
    event.type === 'generic' &&
    (event.eventType === 'questionnaire.ask' ||
      (event.eventType === 'runtime.action-required' && event.data.kind === 'questionnaire'))
  );
}

/** Total bound of one wait, and the first and largest gap between two Runtime re-reads. */
export interface RuntimeTurnWaitTiming {
  readonly maxWaitMs: number;
  readonly pollIntervalMs: number;
  readonly maxPollIntervalMs: number;
}

/**
 * Waits, at most `timing.maxWaitMs`, for a Runtime-owned Turn to release the Session busy lock.
 * Each round reads the Runtime, then watches the active Turn while re-reading the Runtime every
 * `maxPollIntervalMs` ({@link watchTurnUntilStateChange}), so a blocker without a Turn stream
 * frame (a permission request) is found within one re-read. A watch that ends on a frame or a
 * close is followed by a sleep with a doubling gap capped at `maxPollIntervalMs` before the next
 * read: a watch that ends while the Runtime still reports the Turn active (stale terminal frame,
 * or a close in the settlement gap) cannot spin.
 */
export async function waitForRuntimeTurnToSettle(
  runtime: TuiAcpRuntime,
  sessionId: string,
  signal: AbortSignal,
  timing: RuntimeTurnWaitTiming,
): Promise<RuntimeTurnWait> {
  const timeout = AbortSignal.timeout(timing.maxWaitMs);
  const waitSignal = AbortSignal.any([signal, timeout]);
  const interrupted = (): RuntimeTurnWait | undefined =>
    signal.aborted ? 'cancelled' : timeout.aborted ? 'timed-out' : undefined;
  let pollIntervalMs = timing.pollIntervalMs;
  while (!waitSignal.aborted) {
    let active;
    try {
      active = await runtime.getActiveRun(sessionId);
    } catch {
      return 'unknown';
    }
    if (!active.turnId || active.state === 'idle' || active.state === 'terminal') return 'settled';
    // Checked before `runningElsewhere`: the pending decision is the more specific blocker.
    if (active.state === 'decision-blocked') return 'decision-blocked';
    if (active.runningElsewhere) return 'running-elsewhere';

    const watched = await watchTurnUntilStateChange(
      runtime,
      sessionId,
      active.turnId,
      waitSignal,
      timing.maxPollIntervalMs,
    );
    if (watched === 'failed') return interrupted() ?? 'unknown';
    if (waitSignal.aborted) break;
    // A re-read already saw the change; the next read classifies it without a further gap.
    if (watched === 'state-changed') continue;
    // Neither a terminal frame nor a closed watch proves the lock is released (it is released at
    // durable settlement); re-read the Runtime-owned state after a growing gap.
    await delay(pollIntervalMs, waitSignal);
    pollIntervalMs = Math.min(pollIntervalMs * 2, timing.maxPollIntervalMs);
  }
  return interrupted() ?? 'cancelled';
}

/**
 * Watches one Turn until a terminal or questionnaire frame or the stream's close (`ended`), and
 * re-reads the Runtime every `recheckMs` meanwhile: once the Runtime no longer reports this Turn
 * running here (settled, decision-blocked, running elsewhere, another Turn) it returns
 * `state-changed`. A watch or read failure returns `failed`. The one watch stays subscribed
 * across re-reads and is aborted only when it is left with a frame still pending, so a long wait
 * neither re-subscribes the Turn stream nor accumulates timers or abort listeners.
 */
async function watchTurnUntilStateChange(
  runtime: TuiAcpRuntime,
  sessionId: string,
  turnId: string,
  signal: AbortSignal,
  recheckMs: number,
): Promise<'ended' | 'state-changed' | 'failed'> {
  if (signal.aborted) return 'ended';
  const watch = new AbortController();
  const stopWatch = () => watch.abort();
  signal.addEventListener('abort', stopWatch, { once: true });
  let events: AsyncIterator<TuiStreamEvent> | undefined;
  let pending: Promise<IteratorResult<TuiStreamEvent>> | undefined;
  try {
    events = runtime.watchSessionTurn(sessionId, turnId, watch.signal)[Symbol.asyncIterator]();
    for (;;) {
      if (!pending) {
        pending = events.next();
        // Left behind when a re-read ends the watch; its settlement after the abort is not news.
        pending.catch(() => undefined);
      }
      const step = await raceWithTimer(pending, recheckMs);
      if (step === 'timer') {
        if (signal.aborted) return 'ended';
        let active;
        try {
          active = await runtime.getActiveRun(sessionId);
        } catch {
          return 'failed';
        }
        const stillRunningHere =
          active.turnId === turnId &&
          active.state !== 'idle' &&
          active.state !== 'terminal' &&
          active.state !== 'decision-blocked' &&
          !active.runningElsewhere;
        if (!stillRunningHere) return 'state-changed';
        continue;
      }
      pending = undefined;
      if (step.done) return 'ended';
      if (isSessionTurnTerminal(step.value) || isAwaitingDecisionFrame(step.value)) return 'ended';
    }
  } catch {
    return 'failed';
  } finally {
    signal.removeEventListener('abort', stopWatch);
    // A pending frame blocks the generator's return; only aborting the watch releases it.
    if (pending) watch.abort();
    else await events?.return?.(undefined).catch(() => undefined);
  }
}

/** Settles with `promise`, or with `'timer'` after `ms`; the timer is cleared either way. */
function raceWithTimer<T>(promise: Promise<T>, ms: number): Promise<T | 'timer'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<'timer'>((resolveTimer) => {
    timer = setTimeout(() => resolveTimer('timer'), ms);
  });
  return Promise.race([promise, elapsed]).finally(() => clearTimeout(timer));
}

/**
 * Sleeps `ms` or until `signal` aborts. Exactly one abort listener lives per call and is removed
 * on whichever side finishes first, so a long wait never accumulates listeners on its signal.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
