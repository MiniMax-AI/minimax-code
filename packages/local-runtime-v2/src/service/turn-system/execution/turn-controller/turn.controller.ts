import { waitForRelease } from './wait-for-release.js';
import type { SteeringDiscardCause, TurnControllerOptions } from './contracts.js';
import type {
  AcceptedCompactionLease,
  AcceptedTurnLease,
  AgentHostCloseResult,
  AgentHostScopedTurnControl,
  AgentHostSteeringMessage,
} from '../../agent-host/contracts.js';
import { isUserSteeringProducer } from '../../agent-host/contracts.js';
import type {
  AcceptedAgentTurn,
  AcceptedCompactionTurn,
  AcceptedTurn,
  RegisterAcceptedTurnInput,
  SteerTurnResult,
  TurnController,
} from '../contracts.js';

const DEFAULT_ABORT_TIMEOUT_MS = 5_000;
const DEFAULT_RENEWAL_INTERVAL_MS = 10_000;

interface ActiveTurnEntry {
  readonly turn: AcceptedTurn;
  readonly abortController: AbortController;
  readonly released: Promise<void>;
  readonly resolveReleased: () => void;
  readonly steering: AgentHostSteeringMessage[];
  steeringWake: AbortController;
  readonly steeringIdentities: Set<string>;
  readonly steeringClaims: Set<string>;
  readonly toolResultTail: AgentHostSteeringMessage[];
  readonly toolResultTailClaims: Map<string, readonly AgentHostSteeringMessage[]>;
  readonly renewalTimer: ReturnType<typeof setInterval>;
  /** `onReleased` of accepted aborts; each runs once, synchronously, in `complete`. */
  readonly releaseListeners: (() => void)[];
  toolResultTailOpen: number;
  phase: 'running' | 'closing' | 'aborted';
  abortReason?: string;
  renewalTask?: Promise<void>;
}

export function createTurnController(options: TurnControllerOptions): TurnController {
  const entries = new Map<string, ActiveTurnEntry>();
  const abortTimeoutMs = positiveInteger(options.abortTimeoutMs, DEFAULT_ABORT_TIMEOUT_MS);
  const renewalIntervalMs = positiveInteger(options.renewalIntervalMs, DEFAULT_RENEWAL_INTERVAL_MS);
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const discardSteering = (
    entry: ActiveTurnEntry,
    messages: readonly AgentHostSteeringMessage[],
    cause: SteeringDiscardCause,
  ): void => {
    if (messages.length === 0) return;
    try {
      options.onSteeringDiscarded?.({
        sessionId: entry.turn.sessionId,
        turnId: entry.turn.turnId,
        messages,
        cause,
        ...(entry.abortReason ? { abortReason: entry.abortReason } : {}),
        turnReleased: entry.released,
      });
    } catch {
      // The steering hand-off must never break Turn teardown.
    }
  };

  function register(
    input: RegisterAcceptedTurnInput & { readonly busyReason: 'turn' },
  ): AcceptedAgentTurn;
  function register(
    input: RegisterAcceptedTurnInput & { readonly busyReason: 'compaction' },
  ): AcceptedCompactionTurn;
  function register(input: RegisterAcceptedTurnInput): AcceptedTurn {
    if (closed) throw new Error('Turn controller is shutting down');
    if (entries.has(input.sessionId)) throw new Error(`Turn already active: ${input.sessionId}`);
    const abortController = new AbortController();
    const turn = { ...input, signal: abortController.signal } as AcceptedTurn;
    const released = deferred();
    const entry: ActiveTurnEntry = {
      turn,
      abortController,
      released: released.promise,
      resolveReleased: released.resolve,
      steering: [],
      steeringWake: new AbortController(),
      steeringIdentities: new Set(),
      steeringClaims: new Set(),
      toolResultTail: [],
      toolResultTailClaims: new Map(),
      toolResultTailOpen: 0,
      phase: 'running',
      releaseListeners: [],
      renewalTimer: setInterval(() => scheduleRenewal(entry), renewalIntervalMs),
    };
    entry.renewalTimer.unref?.();
    entries.set(input.sessionId, entry);
    const cancellationReason = options.onRegister?.(input.sessionId, input.turnId);
    if (cancellationReason !== undefined) abortEntry(entry, cancellationReason, discardSteering);
    return turn;
  }

  async function renew(entry: ActiveTurnEntry): Promise<void> {
    try {
      const renewed = await options.renew({
        sessionId: entry.turn.sessionId,
        leaseId: entry.turn.leaseId,
      });
      if (entries.get(entry.turn.sessionId) !== entry || entry.phase !== 'running') return;
      if (!renewed) abortEntry(entry, 'lease-lost', discardSteering);
    } catch {
      if (entries.get(entry.turn.sessionId) === entry && entry.phase === 'running') {
        abortEntry(entry, 'lease-renewal-failed', discardSteering);
      }
    } finally {
      entry.renewalTask = undefined;
    }
  }

  function scheduleRenewal(entry: ActiveTurnEntry): void {
    if (entry.renewalTask || entry.phase !== 'running') return;
    entry.renewalTask = renew(entry);
  }

  function scope(lease: AcceptedTurnLease): AgentHostScopedTurnControl {
    return {
      drainSteering: () => drainSteering(entries, lease),
      steeringSignal: () => matchingEntry(entries, lease)?.steeringWake.signal,
      ackSteering: (messages) => ackSteering(entries, lease, messages),
      restoreSteering: (messages) => restoreSteering(entries, lease, messages, discardSteering),
      tryBeginClose: () => tryBeginClose(entries, lease, discardSteering),
      sealAbnormalTerminal: () => sealAbnormalTerminal(entries, lease, discardSteering),
      openToolResultTail: () => openToolResultTail(entries, lease),
      closeAndClaimToolResultTail: (toolCallId) =>
        closeAndClaimToolResultTail(entries, lease, toolCallId),
      ackToolResultTail: (toolCallId) => ackToolResultTail(entries, lease, toolCallId),
    };
  }

  return {
    register,
    scope,
    abort: async ({ sessionId, turnId, reason, onAccepted, onReleased }) => {
      const entry = entries.get(sessionId);
      if (!entry) return { status: 'not-running' };
      if (turnId && entry.turn.turnId !== turnId) return { status: 'turn-mismatch' };
      // Attached before `onAccepted` can yield: the Turn may release while that
      // hook is still running, and the release moment must not be missed.
      watchRelease(entry, onReleased);
      if (entry.phase === 'closing') {
        await onAccepted?.();
        const released = await waitForRelease(entry.released, abortTimeoutMs);
        return released
          ? { status: 'released', turnId: entry.turn.turnId }
          : { status: 'abort-timeout', turnId: entry.turn.turnId };
      }
      if (!entry.turn.signal.aborted) abortEntry(entry, reason, discardSteering);
      await onAccepted?.();
      const released = await waitForRelease(entry.released, abortTimeoutMs);
      return released
        ? { status: 'aborted', turnId: entry.turn.turnId }
        : { status: 'abort-timeout', turnId: entry.turn.turnId };
    },
    steerActiveTurn: (input) => steer(entries, input, 'ordinary'),
    steerToolResultTail: (input) => steer(entries, input, 'tool-result-tail'),
    hasPendingUserSteering: (sessionId) => {
      const entry = entries.get(sessionId);
      if (!entry) return false;
      return entry.steering.some((message) => isUserSteeringProducer(message.producerId));
    },
    beginClose: (lease: AcceptedCompactionLease) => tryBeginClose(entries, lease, discardSteering),
    complete: (turn) => {
      const entry = matchingEntry(entries, turn);
      if (!entry) return;
      clearInterval(entry.renewalTimer);
      entries.delete(turn.sessionId);
      clearControl(entry);
      // Synchronously, right after `entries.delete`: nothing can register the
      // next Turn in between, so a listener sees the exact release moment.
      notifyReleased(options, entry);
      entry.resolveReleased();
    },
    activeTurnId: (sessionId) => entries.get(sessionId)?.turn.turnId,
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      const active = [...entries.values()];
      const shutdownAborts = active.filter((entry) => !entry.turn.signal.aborted);
      logRuntimeShutdown(options, active, shutdownAborts);
      for (const entry of shutdownAborts) {
        abortEntry(entry, 'runtime-shutdown', discardSteering);
      }
      closePromise = drainActiveTurns(active, abortTimeoutMs);
      return closePromise;
    },
  };
}

function logRuntimeShutdown(
  options: TurnControllerOptions,
  active: readonly ActiveTurnEntry[],
  shutdownAborts: readonly ActiveTurnEntry[],
): void {
  try {
    const shutdownAbortEntries = new Set(shutdownAborts);
    options.logger?.info(
      {
        reason: 'runtime-shutdown',
        active_turn_count: active.length,
        shutdown_abort_count: shutdownAborts.length,
        active_turns: active.map((entry) => ({
          session_id: entry.turn.sessionId,
          turn_id: entry.turn.turnId,
          busy_reason: entry.turn.busyReason,
          phase: entry.phase,
          ...(entry.abortReason ? { abort_reason: entry.abortReason } : {}),
          shutdown_abort: shutdownAbortEntries.has(entry),
        })),
      },
      '[local-runtime-v2] Turn controller shutdown',
    );
  } catch {
    // Diagnostics must never change shutdown behavior.
  }
}

function watchRelease(entry: ActiveTurnEntry, listener: (() => void) | undefined): void {
  if (listener) entry.releaseListeners.push(listener);
}

/**
 * Runs each accepted abort's `onReleased` exactly once. A failing listener is
 * logged and never reaches the caller settling the Turn: releasing ownership
 * must not depend on a stop's follow-up, nor may one listener starve the next.
 */
function notifyReleased(options: TurnControllerOptions, entry: ActiveTurnEntry): void {
  for (const listener of entry.releaseListeners.splice(0)) {
    try {
      listener();
    } catch (error) {
      logReleaseListenerFailure(options, entry, error);
    }
  }
}

function logReleaseListenerFailure(
  options: TurnControllerOptions,
  entry: ActiveTurnEntry,
  error: unknown,
): void {
  try {
    options.logger?.info(
      {
        event: 'turn_release_listener_failed',
        session_id: entry.turn.sessionId,
        turn_id: entry.turn.turnId,
        error: error instanceof Error ? error.message : String(error),
      },
      '[local-runtime-v2] Turn release listener failed',
    );
  } catch {
    // Diagnostics must never change release behavior.
  }
}

async function drainActiveTurns(
  entries: readonly ActiveTurnEntry[],
  timeoutMs: number,
): Promise<void> {
  const drained = await Promise.all(
    entries.map((entry) => waitForRelease(entryDrain(entry), timeoutMs)),
  );
  const timedOut = entries.filter((_entry, index) => !drained[index]);
  if (timedOut.length === 0) return;
  throw new Error(
    `Turn controller shutdown timed out: ${timedOut.map(({ turn }) => turn.turnId).join(',')}`,
  );
}

async function entryDrain(entry: ActiveTurnEntry): Promise<void> {
  await Promise.all([entry.released, entry.renewalTask ?? Promise.resolve()]);
}

function steer(
  entries: ReadonlyMap<string, ActiveTurnEntry>,
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly message: AgentHostSteeringMessage;
    readonly foreground?: true;
  },
  lane: 'ordinary' | 'tool-result-tail',
): Promise<SteerTurnResult> {
  const entry = entries.get(input.sessionId);
  if (!entry) return Promise.resolve({ status: 'not-running' });
  if (entry.turn.turnId !== input.turnId) {
    return Promise.resolve({ status: 'turn-mismatch' });
  }
  if (entry.turn.busyReason !== 'turn') {
    return Promise.resolve({ status: 'unsupported-delivery' });
  }
  if (entry.phase !== 'running') return Promise.resolve({ status: 'closing' });
  if (lane === 'tool-result-tail' && entry.toolResultTailOpen === 0) {
    return Promise.resolve({ status: 'delivery-closed' });
  }
  const identity = steeringIdentity(input.message);
  promoteForegroundSteer(entry.turn, lane, input.foreground);
  if (entry.steeringIdentities.has(identity)) {
    return Promise.resolve({ status: 'accepted', turnId: input.turnId });
  }
  const target = lane === 'ordinary' ? entry.steering : entry.toolResultTail;
  target.push(input.message);
  entry.steeringIdentities.add(identity);
  wakeOrdinarySteering(entry, lane);
  return Promise.resolve({ status: 'accepted', turnId: input.turnId });
}

function promoteForegroundSteer(
  turn: AcceptedAgentTurn,
  lane: 'ordinary' | 'tool-result-tail',
  foreground: true | undefined,
): void {
  if (lane === 'ordinary' && foreground) turn.foreground = true;
}

function wakeOrdinarySteering(entry: ActiveTurnEntry, lane: 'ordinary' | 'tool-result-tail'): void {
  if (lane !== 'ordinary') return;
  const wake = entry.steeringWake;
  entry.steeringWake = new AbortController();
  wake.abort();
}

function drainSteering(
  entries: ReadonlyMap<string, ActiveTurnEntry>,
  lease: AcceptedTurnLease,
): readonly AgentHostSteeringMessage[] {
  const entry = matchingEntry(entries, lease);
  if (!entry || entry.phase === 'aborted') return [];
  const claimed = entry.steering.splice(0);
  claimed.forEach((message) => entry.steeringClaims.add(steeringIdentity(message)));
  return claimed;
}

function ackSteering(
  entries: ReadonlyMap<string, ActiveTurnEntry>,
  lease: AcceptedTurnLease,
  messages: readonly AgentHostSteeringMessage[],
): void {
  const entry = matchingEntry(entries, lease);
  messages.forEach((message) => entry?.steeringClaims.delete(steeringIdentity(message)));
}

type SteeringDiscard = (
  entry: ActiveTurnEntry,
  messages: readonly AgentHostSteeringMessage[],
  cause: SteeringDiscardCause,
) => void;

function restoreSteering(
  entries: ReadonlyMap<string, ActiveTurnEntry>,
  lease: AcceptedTurnLease,
  messages: readonly AgentHostSteeringMessage[],
  onDiscarded: SteeringDiscard,
): void {
  const entry = matchingEntry(entries, lease);
  if (!entry) return;
  const restored = messages.filter((message) => {
    const identity = steeringIdentity(message);
    if (!entry.steeringClaims.has(identity)) return false;
    entry.steeringClaims.delete(identity);
    return true;
  });
  if (entry.phase === 'aborted') {
    onDiscarded(entry, restored, 'abort');
    return;
  }
  entry.steering.unshift(...restored);
}

function openToolResultTail(
  entries: ReadonlyMap<string, ActiveTurnEntry>,
  lease: AcceptedTurnLease,
): boolean {
  const entry = matchingEntry(entries, lease);
  if (!entry || entry.phase !== 'running') return false;
  entry.toolResultTailOpen += 1;
  return true;
}

function closeAndClaimToolResultTail(
  entries: ReadonlyMap<string, ActiveTurnEntry>,
  lease: AcceptedTurnLease,
  toolCallId: string,
): readonly AgentHostSteeringMessage[] {
  const entry = matchingEntry(entries, lease);
  if (!entry || entry.phase === 'aborted') return [];
  entry.toolResultTailOpen = Math.max(0, entry.toolResultTailOpen - 1);
  const replay = entry.toolResultTailClaims.get(toolCallId);
  if (replay) return replay;
  const claimed = entry.toolResultTail.splice(0);
  if (claimed.length > 0) entry.toolResultTailClaims.set(toolCallId, claimed);
  return claimed;
}

function ackToolResultTail(
  entries: ReadonlyMap<string, ActiveTurnEntry>,
  lease: AcceptedTurnLease,
  toolCallId: string,
): void {
  matchingEntry(entries, lease)?.toolResultTailClaims.delete(toolCallId);
}

function tryBeginClose(
  entries: ReadonlyMap<string, ActiveTurnEntry>,
  lease: AcceptedTurn,
  onDiscarded: SteeringDiscard,
): AgentHostCloseResult {
  const entry = matchingEntry(entries, lease);
  if (!entry) return { closed: false, reason: 'stale-lease' };
  if (entry.phase === 'aborted') {
    return {
      closed: false,
      reason: 'aborted',
      ...(entry.abortReason ? { abortReason: entry.abortReason } : {}),
    };
  }
  if (hasInFlightConsumption(entry)) return { closed: false, reason: 'steer-pending' };
  // Acknowledged non-user steering (cron, communication, task appends) has no
  // requeue lane: hold the close so the runner polls again and consumes it,
  // matching the pre-exit-boundary contract. Losing delivered machine input
  // outweighs finishing the answer one step earlier.
  if (entry.steering.some((message) => !isUserSteeringProducer(message.producerId))) {
    return { closed: false, reason: 'steer-pending' };
  }
  // Exit-boundary rule: user steering that was not consumed by the final step
  // never extends the finished answer. The batch goes to the discard callback
  // (user producers are requeued as plain queries) and the close proceeds.
  if (entry.steering.length > 0) onDiscarded(entry, entry.steering.splice(0), 'exit-close');
  entry.phase = 'closing';
  return { closed: true };
}

function sealAbnormalTerminal(
  entries: ReadonlyMap<string, ActiveTurnEntry>,
  lease: AcceptedTurnLease,
  onDiscarded: SteeringDiscard,
): Promise<void> {
  const entry = matchingEntry(entries, lease);
  if (!entry) {
    return Promise.reject(new Error(`Stale Turn lease: ${lease.sessionId}/${lease.turnId}`));
  }
  onDiscarded(entry, entry.steering.slice(), 'abnormal-seal');
  clearControl(entry);
  if (entry.phase !== 'aborted') entry.phase = 'closing';
  return Promise.resolve();
}

function matchingEntry(
  entries: ReadonlyMap<string, ActiveTurnEntry>,
  turn: AcceptedTurn,
): ActiveTurnEntry | undefined {
  const entry = entries.get(turn.sessionId);
  if (!entry) return undefined;
  const accepted = entry.turn;
  return accepted.turnId === turn.turnId &&
    accepted.leaseId === turn.leaseId &&
    accepted.acceptedSequence === turn.acceptedSequence &&
    accepted.busyReason === turn.busyReason &&
    accepted.signal === turn.signal
    ? entry
    : undefined;
}

function abortEntry(entry: ActiveTurnEntry, reason: string, onDiscarded: SteeringDiscard): void {
  clearInterval(entry.renewalTimer);
  entry.phase = 'aborted';
  entry.abortReason = reason;
  onDiscarded(entry, entry.steering.slice(), 'abort');
  clearControl(entry, true);
  entry.abortController.abort(reason);
}

function clearControl(entry: ActiveTurnEntry, preserveSteeringClaims = false): void {
  entry.steering.splice(0);
  if (!preserveSteeringClaims) entry.steeringClaims.clear();
  entry.toolResultTail.splice(0);
  entry.toolResultTailClaims.clear();
  entry.toolResultTailOpen = 0;
}

/** Drained or claimed steering whose consumption is still committing. */
function hasInFlightConsumption(entry: ActiveTurnEntry): boolean {
  return (
    entry.steeringClaims.size > 0 ||
    entry.toolResultTail.length > 0 ||
    entry.toolResultTailClaims.size > 0
  );
}

function steeringIdentity(
  message: Pick<AgentHostSteeringMessage, 'producerId' | 'idempotencyKey'>,
): string {
  return `${message.producerId}\u0000${message.idempotencyKey}`;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(value ?? fallback));
}
