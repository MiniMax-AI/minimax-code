import { randomUUID } from 'node:crypto';

import {
  type CommittedQueueCapability,
  type QueuePause,
  type SessionFrame,
  type SessionStreamReservation,
  type SessionStreamService,
  type UserMessageAttachment,
} from '../../service/session-system/index.js';
import {
  type AgentHostTurnOutcome,
  type SteerSessionResult,
  type SubmitTurnResult,
  type SubmitTurnSubmission,
  type TurnService,
} from '../../service/turn-system/index.js';

type DirectSendUserInput = SubmitTurnSubmission['input'];

const directSendObservations = new WeakSet<Promise<void>>();

export interface DirectSendInput {
  readonly sessionId: string;
  readonly input: DirectSendUserInput;
  readonly outputContract?: SubmitTurnSubmission['outputContract'];
  readonly executionDeadlineAtMs?: SubmitTurnSubmission['executionDeadlineAtMs'];
  readonly provenance: SubmitTurnSubmission['provenance'];
  readonly displayContent?: string;
  readonly displayAttachments?: readonly UserMessageAttachment[];
  readonly requestedTurnId?: string;
  readonly hideUserMessage?: boolean;
  readonly clientIntent?: string;
  readonly resumePausedQueue?: boolean;
}

export type DirectSendResult =
  | {
      readonly accepted: true;
      readonly turnId: string;
      readonly completion?: Promise<AgentHostTurnOutcome>;
      readonly frames: AsyncIterableIterator<SessionFrame>;
    }
  | Exclude<SubmitTurnResult, { readonly accepted: true }>
  | {
      readonly accepted: false;
      readonly reason: 'active-model-override-unsupported' | 'delivery-closed' | 'queue-paused';
    };

export interface DirectSendDelivery {
  open(input: DirectSendInput): Promise<DirectSendResult>;
}

export interface DirectSendDeliveryServiceOptions {
  readonly turns: Pick<TurnService, 'submit' | 'steer'>;
  readonly queue: Pick<CommittedQueueCapability, 'snapshot' | 'continueQueue'>;
  readonly stream: Pick<SessionStreamService, 'reserve'>;
  readonly activation: {
    prepareForUserActivation(sessionId: string): Promise<unknown>;
  };
}

/** Adds send_msg SSE and Session activation callbacks around no-Queue submit. */
export class DirectSendDeliveryService implements DirectSendDelivery {
  // ponytail: failed cleanup tokens live until replay; bound this map if failures become sustained.
  private readonly pendingQueuePauseCleanups = new Map<string, QueuePause>();

  constructor(private readonly options: DirectSendDeliveryServiceOptions) {}

  async open(input: DirectSendInput): Promise<DirectSendResult> {
    const reservation = this.options.stream.reserve(input.sessionId);
    try {
      const steerSend = this.openSteerIntentSend(input, reservation);
      if (steerSend) return await steerSend;
      const result = await this.options.turns.submit({
        sessionId: input.sessionId,
        input: input.input,
        ...(input.outputContract ? { outputContract: input.outputContract } : {}),
        ...(input.executionDeadlineAtMs !== undefined
          ? { executionDeadlineAtMs: input.executionDeadlineAtMs }
          : {}),
        allowQueue: false,
        provenance: input.provenance,
        ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
        ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
        ...(input.resumePausedQueue ? { resumePausedQueue: true } : {}),
        delivery: {
          ...directSendDisplayOptions(input),
          onAccepted: ({ turnId }) => reservation.bindTurn(turnId),
          beforeStart: async () => {
            await retryOnce(() =>
              this.options.activation.prepareForUserActivation(input.sessionId),
            );
          },
        },
      });
      if (!result.accepted) {
        reservation.discardIfEmpty();
        return classifyQueuePauseBlock(this.options.queue, input.sessionId, result);
      }
      observeCompletion(result.completion, reservation.complete);
      return {
        accepted: true,
        turnId: result.turnId,
        completion: result.completion,
        frames: reservation.source,
      };
    } catch (error) {
      reservation.discardIfEmpty();
      throw error;
    }
  }

  /** Routes steer client intents to their authoritative steer-or-activate flow. */
  private openSteerIntentSend(
    input: DirectSendInput,
    reservation: SessionStreamReservation,
  ): Promise<DirectSendResult> | undefined {
    if (
      input.executionDeadlineAtMs !== undefined &&
      (isPausedQueueSend(input) || isComposerSteerSend(input.clientIntent))
    ) {
      reservation.discardIfEmpty();
      return Promise.resolve({ accepted: false, reason: 'invalid-input' });
    }
    const changesPlanMode =
      input.clientIntent === 'plan-entry' || input.clientIntent === 'plan-exit';
    if (isPausedQueueSend(input) && !changesPlanMode) {
      return this.openPausedQueueSend(input, reservation);
    }
    if (isComposerSteerSend(input.clientIntent)) {
      return this.openComposerSteerSend(input, reservation);
    }
    return undefined;
  }

  /**
   * Composer steer-intent send: joins the running Turn instead of queueing;
   * an idle Session falls back to normal activation semantics.
   */
  private async openComposerSteerSend(
    input: DirectSendInput,
    reservation: SessionStreamReservation,
  ): Promise<DirectSendResult> {
    const idempotencyKey = input.requestedTurnId ?? `composer-steer:${randomUUID()}`;
    const result = await this.options.turns.steer({
      sessionId: input.sessionId,
      input: input.input,
      provenance: input.provenance,
      producerId: 'composer-steer',
      idempotencyKey,
      modelSelectionScope: 'activation-only',
      ...(input.outputContract ? { outputContract: input.outputContract } : {}),
      ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
      ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
      ...(input.resumePausedQueue ? { resumePausedQueue: true } : {}),
      delivery: {
        ...directSendDisplayOptions(input),
        beforeStart: async () => {
          await retryOnce(() => this.options.activation.prepareForUserActivation(input.sessionId));
        },
      },
      preDelivery: {
        accept: async ({ turnId }) => {
          reservation.bindTurn(turnId);
        },
      },
    });
    if (!result.delivered) {
      reservation.discardIfEmpty();
      return { accepted: false, reason: result.reason };
    }
    if (result.mode === 'duplicate') {
      reservation.discardIfEmpty();
      return { accepted: false, reason: 'duplicate', turnId: result.turnId };
    }
    if (result.mode === 'activated') {
      observeCompletion(result.completion, reservation.complete);
      return {
        accepted: true,
        turnId: result.turnId,
        completion: result.completion,
        frames: reservation.source,
      };
    }
    return {
      accepted: true,
      turnId: result.turnId,
      frames: completeOnTurnTerminal(reservation),
    };
  }

  private async openPausedQueueSend(
    input: DirectSendInput,
    reservation: ReturnType<DirectSendDeliveryServiceOptions['stream']['reserve']>,
  ): Promise<DirectSendResult> {
    const idempotencyKey = input.requestedTurnId ?? `paused-queue-send:${randomUUID()}`;
    const observedPause = await readQueuePause(this.options.queue, input.sessionId);
    const result = await this.options.turns.steer({
      sessionId: input.sessionId,
      input: input.input,
      provenance: input.provenance,
      producerId: 'paused-queue-composer',
      idempotencyKey,
      modelSelectionScope: 'activation-only',
      ...(input.outputContract ? { outputContract: input.outputContract } : {}),
      ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
      ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
      ...(input.resumePausedQueue ? { resumePausedQueue: true } : {}),
      delivery: {
        ...directSendDisplayOptions(input),
        beforeStart: async () => {
          await retryOnce(() => this.options.activation.prepareForUserActivation(input.sessionId));
        },
      },
      preDelivery: {
        accept: async ({ turnId }) => {
          reservation.bindTurn(turnId);
        },
      },
    });
    return this.handlePausedQueueSendResult(input, reservation, result, observedPause);
  }

  private async handlePausedQueueSendResult(
    input: DirectSendInput,
    reservation: SessionStreamReservation,
    result: SteerSessionResult,
    observedPause: QueuePause | undefined,
  ): Promise<DirectSendResult> {
    const cleanupKey = input.requestedTurnId
      ? `${input.sessionId}\u0000${input.requestedTurnId}`
      : undefined;
    if (!result.delivered) {
      reservation.discardIfEmpty();
      return { accepted: false, reason: result.reason };
    }
    if (result.mode === 'duplicate') {
      await this.retryPendingQueuePauseCleanup(input.sessionId, cleanupKey);
      reservation.discardIfEmpty();
      return { accepted: false, reason: 'duplicate', turnId: result.turnId };
    }
    if (result.mode === 'activated') {
      observeCompletion(result.completion, reservation.complete);
      return {
        accepted: true,
        turnId: result.turnId,
        completion: result.completion,
        frames: reservation.source,
      };
    }
    if (cleanupKey && observedPause) {
      this.pendingQueuePauseCleanups.set(cleanupKey, observedPause);
    }
    const cleaned = await continueQueueAfterDeliveredSteer(
      this.options.queue,
      input.sessionId,
      observedPause,
    );
    if (cleanupKey && observedPause && cleaned) {
      this.pendingQueuePauseCleanups.delete(cleanupKey);
    }
    return {
      accepted: true,
      turnId: result.turnId,
      frames: completeOnTurnTerminal(reservation),
    };
  }

  private async retryPendingQueuePauseCleanup(
    sessionId: string,
    cleanupKey: string | undefined,
  ): Promise<void> {
    if (!cleanupKey) return;
    const pendingCleanup = this.pendingQueuePauseCleanups.get(cleanupKey);
    if (!pendingCleanup) return;
    if (await continueQueueAfterDeliveredSteer(this.options.queue, sessionId, pendingCleanup)) {
      this.pendingQueuePauseCleanups.delete(cleanupKey);
    }
  }
}

async function continueQueueAfterDeliveredSteer(
  queue: Pick<CommittedQueueCapability, 'continueQueue'>,
  sessionId: string,
  expectedPause: QueuePause | undefined,
): Promise<boolean> {
  if (!expectedPause) return true;
  try {
    await queue.continueQueue(sessionId, expectedPause);
    return true;
  } catch {
    // The message already reached the active Turn; cleanup cannot roll delivery back.
    return false;
  }
}

async function readQueuePause(
  queue: Pick<CommittedQueueCapability, 'snapshot'>,
  sessionId: string,
): Promise<QueuePause | undefined> {
  try {
    return (await queue.snapshot(sessionId)).pause;
  } catch {
    // Delivery stays available when Queue cleanup state cannot be read safely.
    return undefined;
  }
}

async function classifyQueuePauseBlock(
  queue: Pick<CommittedQueueCapability, 'snapshot'>,
  sessionId: string,
  result: Exclude<SubmitTurnResult, { readonly accepted: true }>,
): Promise<DirectSendResult> {
  if (result.reason !== 'priority-blocked') return result;
  return (await readQueuePause(queue, sessionId))
    ? { accepted: false, reason: 'queue-paused' }
    : result;
}

function isPausedQueueSend(input: DirectSendInput): boolean {
  return (
    input.resumePausedQueue === true ||
    input.clientIntent === 'paused-queue-keep' ||
    input.clientIntent === 'paused-queue-clear'
  );
}

function isComposerSteerSend(clientIntent: string | undefined): boolean {
  return clientIntent === 'composer-steer';
}

function completeOnTurnTerminal(
  reservation: SessionStreamReservation,
): AsyncIterableIterator<SessionFrame> {
  const source = reservation.source;
  let closed = false;
  const done = (): IteratorResult<SessionFrame> => ({ done: true, value: undefined });
  const iterator: AsyncIterableIterator<SessionFrame> = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async next() {
      if (closed) return done();
      const result = await source.next();
      if (result.done) {
        closed = true;
        return result;
      }
      if (result.value.kind === 'turn-terminal') {
        closed = true;
        reservation.complete();
      }
      return result;
    },
    async return() {
      if (!closed) {
        closed = true;
        reservation.close();
      }
      return done();
    },
  };
  return iterator;
}

async function retryOnce<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    return operation();
  }
}

function observeCompletion(completion: Promise<unknown>, complete: () => void): void {
  directSendObservations.add(completeAfterSettlement(completion, complete));
}

async function completeAfterSettlement(
  completion: Promise<unknown>,
  complete: () => void,
): Promise<void> {
  try {
    await completion;
  } finally {
    complete();
  }
}

function directSendDisplayOptions(
  input: DirectSendInput,
): Pick<
  NonNullable<SubmitTurnSubmission['delivery']>,
  'displayContent' | 'displayAttachments' | 'hideUserMessage'
> {
  return {
    ...(input.displayContent !== undefined ? { displayContent: input.displayContent } : {}),
    ...(input.displayAttachments
      ? { displayAttachments: input.displayAttachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(input.hideUserMessage ? { hideUserMessage: true } : {}),
  };
}
