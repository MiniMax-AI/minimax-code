import {
  isTurnStoppingToolResultDetails,
  isTurnTerminatingToolResultDetails,
} from '@mavis/agent-core/tools';
import {
  validateCanonicalHistoryMessages,
  validateCanonicalHistorySnapshot,
} from './canonical-history-validation.js';
import { isBackgroundTaskReadSettlement } from './background/task-read-settlement.js';
import type { CanonicalHistoryMessage, CanonicalHistorySnapshot } from './contracts.js';

export type CanonicalContinuationState = 'unavailable' | 'available' | 'waiting-for-user';

class TurnContinuationUnavailableError extends Error {
  override readonly name = 'TurnContinuationUnavailableError';

  constructor(readonly state: CanonicalContinuationState) {
    super(`Turn continuation is unavailable: ${state}.`);
  }
}

/** Derives product continuation state from canonical Pi history only. */
export function inspectContinuationHistory(
  messages: readonly unknown[],
): CanonicalContinuationState {
  validateCanonicalHistoryMessages(messages);
  const last = decidingTail(messages);
  if (!last || last.role === 'compactionSummary') return 'unavailable';
  if (last.role === 'toolResult') {
    if (isWaitingForUser(last)) return 'waiting-for-user';
    if (isTurnTerminatingToolResultDetails(last.details)) return 'unavailable';
  }
  if (last.role !== 'assistant') return 'available';
  return last.stopReason === 'stop' ? 'unavailable' : 'available';
}

/**
 * Builds the transcript accepted by Pi `continue()`. A non-terminal assistant
 * tail is the interrupted LLM attempt itself, so it is retried in memory while
 * the durable canonical record remains available for audit and projection.
 */
export function continuationRunnerHistory(
  snapshot: CanonicalHistorySnapshot,
): CanonicalHistorySnapshot {
  validateCanonicalHistorySnapshot(snapshot);
  const state = inspectContinuationHistory(snapshot.messages);
  if (state !== 'available') throw new TurnContinuationUnavailableError(state);
  const tail = continuationTail(snapshot.messages);
  if (tail?.message.role !== 'assistant') return snapshot;
  return {
    ...snapshot,
    messages: snapshot.messages.filter((_, index) => index !== tail.index),
    ...(snapshot.identityVector
      ? { identityVector: snapshot.identityVector.filter((_, index) => index !== tail.index) }
      : {}),
  };
}

function continuationTail(
  messages: readonly CanonicalHistoryMessage[],
): { readonly index: number; readonly message: CanonicalHistoryMessage } | undefined {
  let index = messages.length - 1;
  while (index >= 0) {
    const message = messages[index];
    if (message && !isBackgroundTaskReadSettlement(message)) return { index, message };
    index -= 1;
  }
  return undefined;
}

function decidingTail(
  messages: readonly CanonicalHistoryMessage[],
): CanonicalHistoryMessage | undefined {
  const tail = continuationTail(messages);
  if (!tail) return undefined;
  const batch: CanonicalHistoryMessage[] = [];
  for (let at = tail.index; at >= 0; at -= 1) {
    const message = messages[at];
    if (message?.role !== 'toolResult') break;
    batch.push(message);
  }
  const stop = batch.find(
    (message) => message.role === 'toolResult' && isTurnStoppingToolResultDetails(message.details),
  );
  if (!stop) return tail.message;
  return (
    batch.find(
      (message) =>
        message.role === 'toolResult' &&
        isRecord(message.details) &&
        message.details.waiting_for_user === true,
    ) ?? stop
  );
}

function isWaitingForUser(message: {
  readonly role: 'toolResult';
  readonly toolName: string;
  readonly details?: unknown;
}): boolean {
  return (
    message.toolName === 'ask_user' ||
    (isRecord(message.details) && message.details.waiting_for_user === true)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
