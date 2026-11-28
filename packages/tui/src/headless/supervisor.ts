import type { CliSendMessageReq } from '@mavis/local-runtime-v2/cli-service';

import type {
  TuiActiveRunControlPort,
  TuiConversationPort,
  TuiSessionPort,
  TuiSessionTurnPort,
} from '../runtime/port.js';
import type { TuiMessage, TuiStreamEvent } from '../runtime/stream-events.js';
import type { TuiRunRuntime } from '../application/run-coordinator.js';
import { loadTurnHistory } from '../application/turn-execution-facts.js';

export type ExecRunSupervisorRuntime = TuiConversationPort &
  TuiSessionTurnPort &
  TuiActiveRunControlPort &
  Pick<TuiSessionPort, 'getSession' | 'listMessagePage'>;

export interface ExecRunSupervisorOptions {
  readonly maxConsecutiveRecoveryAttempts?: number;
  readonly reconnectDelayMs?: number;
  readonly wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface StreamState {
  readonly seenMessageIds: Set<string>;
  readonly seenCursors: Set<string>;
  sawEvent: boolean;
  terminal: boolean;
  heartbeatSeen: boolean;
  doneSeen: boolean;
  cursor?: string;
  afterMsgId?: string;
}

interface ReconciliationResult {
  readonly progressed: boolean;
  readonly recoverable: boolean;
  readonly terminal: boolean;
}

const DEFAULT_MAX_CONSECUTIVE_RECOVERY_ATTEMPTS = 5;
const DEFAULT_RECONNECT_DELAY_MS = 100;

/** Keeps one admitted Exec Turn attached to its durable Runtime facts. */
export class ExecRunSupervisor {
  constructor(
    private readonly runtime: ExecRunSupervisorRuntime,
    private readonly options: ExecRunSupervisorOptions = {},
  ) {}

  conversationPort(): TuiRunRuntime {
    return {
      sendMessage: (request, signal) => this.sendMessage(request, signal),
      abortSession: (request) => this.runtime.abortSession(request),
      steer: (request) => this.runtime.steer(request),
    };
  }

  async *sendMessage(
    request: CliSendMessageReq,
    signal?: AbortSignal,
  ): AsyncGenerator<TuiStreamEvent> {
    if (!request.turnId) throw supervisorError('EXEC_TURN_ID_REQUIRED', 'Exec requires a Turn id.');
    const turnId = request.turnId;
    signal?.throwIfAborted();
    const state: StreamState = {
      seenMessageIds: new Set(),
      seenCursors: new Set(),
      sawEvent: false,
      terminal: false,
      heartbeatSeen: false,
      doneSeen: false,
    };
    let initial = true;
    let consecutiveRecoveries = 0;
    let lastFailure: unknown;

    for (;;) {
      signal?.throwIfAborted();
      let resyncRequired = false;
      let progressed = false;
      try {
        const stream = initial
          ? this.runtime.sendMessage(request, signal)
          : this.runtime.watchSessionTurn(request.id, turnId, requireSignal(signal), {
              ...(state.cursor ? { afterCursor: state.cursor } : {}),
              ...(!state.cursor && state.afterMsgId ? { afterMsgId: state.afterMsgId } : {}),
            });
        initial = false;
        for await (const event of stream) {
          signal?.throwIfAborted();
          const cursorAlreadySeen = event.cursor ? state.seenCursors.has(event.cursor) : false;
          if (event.cursor) {
            state.cursor = event.cursor;
            if (!cursorAlreadySeen) {
              state.seenCursors.add(event.cursor);
              progressed = true;
            }
          }
          const messageAlreadySeen =
            event.type === 'message' && event.message.id
              ? state.seenMessageIds.has(event.message.id)
              : false;
          const cursorlessSentinelAlreadySeen =
            !event.cursor &&
            ((event.type === 'heartbeat' && state.heartbeatSeen) ||
              (event.type === 'done' && state.doneSeen));
          if (cursorAlreadySeen || messageAlreadySeen || cursorlessSentinelAlreadySeen) continue;
          if (event.type === 'message') progressed = true;
          if (event.type === 'heartbeat') state.heartbeatSeen = true;
          if (event.type === 'done') state.doneSeen = true;
          if (!event.cursor && event.type !== 'message') progressed = !state.sawEvent;
          state.sawEvent = true;
          rememberMessage(state, event);
          if (event.type === 'resync-required') {
            resyncRequired = true;
            yield event;
            break;
          }
          yield event;
          if (isTerminalEvent(event)) {
            state.terminal = true;
            // The direct Runtime stream closes only after Turn ownership settles.
            // Keep consuming so Exec cannot race shutdown against that release.
          }
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        lastFailure = error;
      }

      if (state.terminal) return;
      const reconciliation = yield* this.reconcile(request, turnId, state, resyncRequired, signal);
      if (reconciliation.terminal) return;
      if (!reconciliation.recoverable) {
        throw (
          lastFailure ??
          supervisorError(
            'EXEC_STREAM_ENDED_WITHOUT_TERMINAL',
            'Runtime stream ended without a durable terminal fact.',
          )
        );
      }
      consecutiveRecoveries =
        progressed || reconciliation.progressed ? 0 : consecutiveRecoveries + 1;
      if (
        consecutiveRecoveries >
        (this.options.maxConsecutiveRecoveryAttempts ?? DEFAULT_MAX_CONSECUTIVE_RECOVERY_ATTEMPTS)
      ) {
        throw supervisorError(
          'EXEC_STREAM_RECOVERY_EXHAUSTED',
          'Runtime stream recovery was exhausted before a terminal fact arrived.',
          lastFailure,
        );
      }
      await (this.options.wait ?? waitForReconnect)(
        this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
        signal,
      );
    }
  }

  private async *reconcile(
    request: CliSendMessageReq,
    turnId: string,
    state: StreamState,
    resyncRequired: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<TuiStreamEvent, ReconciliationResult> {
    signal?.throwIfAborted();
    const [activeRun, session] = await Promise.all([
      this.runtime.getActiveRun(request.id),
      this.runtime.getSession(request.id),
    ]);
    const expectedTurnActive =
      (activeRun.state === 'running' || activeRun.state === 'decision-blocked') &&
      (!activeRun.turnId || activeRun.turnId === turnId);
    const shouldReadHistory = resyncRequired || !expectedTurnActive || activeRun.state === 'idle';
    let finalMessageSeen = false;
    let historyProgressed = false;
    if (shouldReadHistory) {
      const { messages } = await loadTurnHistory(this.runtime, request.id, turnId);
      for (const message of messages) {
        if (message.id) state.afterMsgId = message.id;
        if (isFinalAssistantMessage(message)) finalMessageSeen = true;
        if (message.id && state.seenMessageIds.has(message.id)) continue;
        if (message.id) state.seenMessageIds.add(message.id);
        state.sawEvent = true;
        historyProgressed = true;
        yield { type: 'message', message };
      }
      if (resyncRequired) state.cursor = undefined;
    }

    if (session.status === 'error') {
      yield {
        type: 'session-status',
        status: 'error',
        turnId,
        message: session.errorMessage ?? 'Runtime turn failed.',
      };
      return { progressed: historyProgressed, recoverable: false, terminal: true };
    }
    if (session.status === 'aborted') {
      yield { type: 'session-status', status: 'aborted', turnId };
      return { progressed: historyProgressed, recoverable: false, terminal: true };
    }
    if (session.status === 'idle' && finalMessageSeen) {
      yield { type: 'session-status', status: 'finished', turnId };
      return { progressed: historyProgressed, recoverable: false, terminal: true };
    }
    if (activeRun.state === 'decision-blocked') {
      throw supervisorError(
        'INTERACTION_NOT_AVAILABLE',
        'Runtime is waiting for user interaction from a non-interactive Exec host.',
      );
    }
    return {
      progressed: historyProgressed,
      recoverable: expectedTurnActive || state.sawEvent,
      terminal: false,
    };
  }
}

function rememberMessage(state: StreamState, event: TuiStreamEvent): void {
  if (event.type !== 'message' || !event.message.id) return;
  state.seenMessageIds.add(event.message.id);
  state.afterMsgId = event.message.id;
}

function isFinalAssistantMessage(message: TuiMessage): boolean {
  return (
    message.role === 'assistant' &&
    (message.kind === 'final' ||
      message.finishReason === 'stop' ||
      message.finishReason === 'end_turn' ||
      message.finishReason === 'stop_sequence')
  );
}

function isTerminalEvent(event: TuiStreamEvent): boolean {
  if (event.type === 'error') return true;
  return (
    event.type === 'session-status' &&
    (event.status === 'finished' ||
      event.status === 'error' ||
      event.status === 'aborted' ||
      event.status === 'interrupted')
  );
}

function requireSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal;
}

async function waitForReconnect(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('Exec stream recovery was cancelled.'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function supervisorError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    category: 'runtime',
    code,
    retryable: false,
  });
}
