import { randomUUID } from 'node:crypto';

import { createUserMessageId } from '../session-system/index.js';
import type {
  QueueDispatchCapability,
  QueueDispatchClaim,
  QueueMessageAttachment,
} from '../session-system/index.js';
import type {
  AgentHostInputAttachment,
  AgentHostUserInput,
  QueueTurnDeliveryInput,
  QueueDispatchDisposition,
  QueueSteerDispatchResult,
  QueueTurnExecutor,
  TurnAdmissionRejectionReason,
} from './contracts.js';
import { parseBackgroundTaskOriginMetadata } from './agent-host/contracts.js';

export interface QueueDispatcherOptions {
  readonly queue: QueueDispatchCapability;
  readonly executor: QueueTurnExecutor;
  readonly recoverState: () => Promise<void>;
  readonly onPreparing?: (claim: QueueDispatchClaim, turnId: string) => void;
  readonly onExecution?: (
    claim: QueueDispatchClaim,
    result: Awaited<ReturnType<QueueTurnExecutor['execute']>>,
  ) => void;
  readonly isCancellationRequested?: (item: QueueDispatchClaim['item']) => boolean;
  readonly classifyQueuedItem?: (
    item: QueueDispatchClaim['item'],
  ) => QueueDispatchDisposition | Promise<QueueDispatchDisposition>;
  /**
   * Decides whether a deferred FIFO head gives up its position for the rest of
   * this drain pass (GOAL-05: an autonomous Goal yields to queued user work).
   * The item is neither cancelled nor reordered — it stays queued, keeps its
   * identity and is re-examined from scratch on the next drain pass.
   */
  readonly shouldYieldFifoPosition?: (
    item: QueueDispatchClaim['item'],
  ) => boolean | Promise<boolean>;
}

export interface QueueDispatcher {
  dispatch(sessionId: string): Promise<void>;
  continuePaused(sessionId: string): Promise<QueueSteerDispatchResult>;
  recoverPending(input: { readonly processStartedAtMs: number }): Promise<void>;
  quiesceSession(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

interface SessionDispatchState {
  requestedWake: number;
  startedWake: number;
  recoverBeforeNextClaim: boolean;
  running?: Promise<void>;
}

interface QueueDrainContext {
  readonly options: QueueDispatcherOptions;
  readonly states: Map<string, SessionDispatchState>;
  readonly recoveries: Set<Promise<void>>;
  readonly blockedSessions: Set<string>;
  readonly continuedDispatches: Map<string, Promise<QueueSteerDispatchResult>>;
  wakeSession?: (sessionId: string) => Promise<void>;
  closed: boolean;
}

export function createQueueDispatcher(options: QueueDispatcherOptions): QueueDispatcher {
  const states = new Map<string, SessionDispatchState>();
  const context: QueueDrainContext = {
    options,
    states,
    recoveries: new Set(),
    blockedSessions: new Set(),
    continuedDispatches: new Map(),
    closed: false,
  };
  let closePromise: Promise<void> | undefined;

  const dispatch = async (sessionId: string): Promise<void> => {
    assertDispatcherOpen(context);
    if (context.blockedSessions.has(sessionId)) return;
    const state = states.get(sessionId) ?? {
      requestedWake: 0,
      startedWake: 0,
      recoverBeforeNextClaim: false,
    };
    states.set(sessionId, state);
    const wake = ++state.requestedWake;
    while (state.startedWake < wake) {
      const running = state.running ?? startDrain(context, sessionId, state);
      try {
        await running;
      } catch (error) {
        if (state.startedWake >= wake) throw error;
      }
    }
  };

  const recoverPending = async (input: { readonly processStartedAtMs: number }): Promise<void> => {
    assertDispatcherOpen(context);
    const recovery = recoverDispatcher(context, input);
    context.recoveries.add(recovery);
    try {
      await recovery;
    } finally {
      context.recoveries.delete(recovery);
    }
  };

  context.wakeSession = dispatch;
  return {
    dispatch,
    continuePaused: (sessionId) => continuePaused(context, sessionId),
    quiesceSession: (sessionId) => quiesceSession(context, sessionId),
    resumeSession: async (sessionId) => {
      context.blockedSessions.delete(sessionId);
      if (!context.closed) await dispatch(sessionId);
    },
    close: () => {
      if (closePromise) return closePromise;
      context.closed = true;
      closePromise = drainDispatcher(context);
      return closePromise;
    },
    recoverPending,
  };
}

async function recoverDispatcher(
  context: QueueDrainContext,
  input: { readonly processStartedAtMs: number },
): Promise<void> {
  await context.options.recoverState();
  if (context.closed) return;
  const sessionIds = await context.options.queue.listPendingSessionIds();
  for (const sessionId of sessionIds) {
    if (context.closed) return;
    await context.options.queue.recoverClaims(sessionId, {
      claimedAtOrBeforeMs: input.processStartedAtMs,
    });
  }
}

async function drainDispatcher(context: QueueDrainContext): Promise<void> {
  const operations = [
    ...context.recoveries,
    ...context.continuedDispatches.values(),
    ...[...context.states.values()].flatMap((state) => (state.running ? [state.running] : [])),
  ];
  const results = await Promise.allSettled(operations);
  context.states.clear();
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}

function continuePaused(
  context: QueueDrainContext,
  sessionId: string,
): Promise<QueueSteerDispatchResult> {
  assertDispatcherOpen(context);
  const active = context.continuedDispatches.get(sessionId);
  if (active) return active;
  const operation = runContinuedHead(context, sessionId);
  context.continuedDispatches.set(sessionId, operation);
  return operation;
}

async function runContinuedHead(
  context: QueueDrainContext,
  sessionId: string,
): Promise<QueueSteerDispatchResult> {
  try {
    return await dispatchContinuedHead(context, sessionId);
  } finally {
    context.continuedDispatches.delete(sessionId);
  }
}

async function dispatchContinuedHead(
  context: QueueDrainContext,
  sessionId: string,
): Promise<QueueSteerDispatchResult> {
  if (context.blockedSessions.has(sessionId)) {
    return { status: 'not-claimed' };
  }
  const claim = await context.options.queue.claimNext({ sessionId, continuePaused: true });
  if (!claim) return { status: 'not-claimed' };
  if (context.closed || context.blockedSessions.has(sessionId)) {
    await context.options.queue.release({ sessionId, claimId: claim.claimId });
    return { status: 'not-claimed' };
  }
  const attempt = await dispatchClaim(context, claim, () => undefined);
  return attempt.result;
}

async function quiesceSession(context: QueueDrainContext, sessionId: string): Promise<void> {
  context.blockedSessions.add(sessionId);
  const running = context.states.get(sessionId)?.running;
  const operations = [...(running ? [running] : []), ...context.recoveries];
  const results = await Promise.allSettled(operations);
  context.states.delete(sessionId);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}

function assertDispatcherOpen(context: QueueDrainContext): void {
  if (context.closed) throw new Error('Queue dispatcher is shutting down');
}

function startDrain(
  context: QueueDrainContext,
  sessionId: string,
  state: SessionDispatchState,
): Promise<void> {
  const running = drainAndRelease(context, sessionId, state);
  state.running = running;
  return running;
}

async function drainAndRelease(
  context: QueueDrainContext,
  sessionId: string,
  state: SessionDispatchState,
): Promise<void> {
  try {
    await drain(context, sessionId, state);
  } finally {
    state.running = undefined;
    if (
      state.startedWake === state.requestedWake &&
      !state.recoverBeforeNextClaim &&
      context.states.get(sessionId) === state
    ) {
      context.states.delete(sessionId);
    }
  }
}

async function drain(
  context: QueueDrainContext,
  sessionId: string,
  state: SessionDispatchState,
): Promise<void> {
  let drainAgain = false;
  /*
   * Drain-local and monotonic within one pass: every yielded item is skipped
   * by later claims of the same pass, so the pass always ends. A new wake is a
   * new pass boundary — it must re-examine every blocker, so nothing stays
   * yielded across it. Losing this set (crash, restart) only restores the
   * previous park behaviour; claim and Turn receipt remain the sole duplicate
   * defence.
   */
  const yielded = new Set<string>();
  do {
    if (state.startedWake < state.requestedWake) yielded.clear();
    state.startedWake = state.requestedWake;
    if (
      state.recoverBeforeNextClaim &&
      !context.closed &&
      !context.blockedSessions.has(sessionId)
    ) {
      await context.options.queue.recoverClaims(sessionId);
      state.recoverBeforeNextClaim = false;
    }
    drainAgain = await dispatchNext(
      context,
      sessionId,
      () => {
        state.recoverBeforeNextClaim = true;
      },
      yielded,
    );
  } while (
    !context.closed &&
    !context.blockedSessions.has(sessionId) &&
    (drainAgain || state.startedWake < state.requestedWake)
  );
}

async function dispatchNext(
  context: QueueDrainContext,
  sessionId: string,
  requireRecovery: () => void,
  yielded: Set<string>,
): Promise<boolean> {
  const claim = await claimNextIfOpen(context, sessionId, yielded);
  if (!claim) return false;
  const attempt = await dispatchClaim(context, claim, requireRecovery, yielded);
  return attempt.drainAgain;
}

interface QueueDispatchAttempt {
  readonly result: QueueSteerDispatchResult;
  readonly drainAgain: boolean;
}

async function dispatchClaim(
  context: QueueDrainContext,
  claim: QueueDispatchClaim,
  requireRecovery: () => void,
  yielded?: Set<string>,
): Promise<QueueDispatchAttempt> {
  let disposition: QueueDispatchDisposition;
  try {
    disposition = (await context.options.classifyQueuedItem?.(claim.item)) ?? 'ready';
  } catch (error) {
    return settleThrownClaim(context, claim, error);
  }
  const cancelled = await cancelRequestedClaim(context, claim);
  if (cancelled) return cancelled;
  const classified = await settleClassifiedClaim(context, claim, disposition, yielded);
  if (classified) return classified;
  return executeClaim(context, claim, requireRecovery, yielded);
}

async function settleClassifiedClaim(
  context: QueueDrainContext,
  claim: QueueDispatchClaim,
  disposition: QueueDispatchDisposition,
  yielded?: Set<string>,
): Promise<QueueDispatchAttempt | undefined> {
  const sessionId = claim.sessionId;
  if (disposition === 'ready') return undefined;
  if (disposition === 'defer' || isRetryableSelection(claim)) {
    const yieldsPosition =
      disposition === 'defer' && !isRetryableSelection(claim) && yielded !== undefined
        ? await yieldsFifoPosition(context, claim)
        : false;
    await context.options.queue.release({ sessionId, claimId: claim.claimId });
    if (yieldsPosition) yielded?.add(claim.item.itemId);
    return {
      result: {
        status: disposition === 'defer' ? 'deferred' : 'cancelled',
        queueItemId: claim.item.itemId,
      },
      drainAgain: yieldsPosition,
    };
  }
  await context.options.queue.cancelClaim({ sessionId, claimId: claim.claimId });
  return {
    result: { status: 'cancelled', queueItemId: claim.item.itemId },
    drainAgain: true,
  };
}

/** Asked while the claim is still held; an unreadable policy keeps the park. */
async function yieldsFifoPosition(
  context: QueueDrainContext,
  claim: QueueDispatchClaim,
): Promise<boolean> {
  if (!context.options.shouldYieldFifoPosition) return false;
  try {
    return await context.options.shouldYieldFifoPosition(claim.item);
  } catch {
    return false;
  }
}

async function executeClaim(
  context: QueueDrainContext,
  claim: QueueDispatchClaim,
  requireRecovery: () => void,
  yielded?: Set<string>,
): Promise<QueueDispatchAttempt> {
  let result: Awaited<ReturnType<QueueTurnExecutor['execute']>>;
  let acknowledged = false;
  let observed = false;
  try {
    result = await context.options.executor.execute({
      ...queueClaimDeliveryInput(claim, yielded),
      onAccepted: (accepted) => {
        context.options.onExecution?.(claim, accepted);
        observed = true;
      },
      beforeSubmit: async (turnId) => {
        context.options.onPreparing?.(claim, turnId);
        await context.options.queue.prepareDelivery({
          sessionId: claim.sessionId,
          claimId: claim.claimId,
          turnId,
        });
      },
      beforeStart: async (turnId) => {
        await acknowledgeAccepted(context, claim, { accepted: true, turnId }, requireRecovery);
        acknowledged = true;
      },
    });
    if (!observed) context.options.onExecution?.(claim, result);
  } catch (error) {
    if (acknowledged) throw error;
    return settleThrownClaim(context, claim, error);
  }
  return settleExecutedClaim(
    context,
    claim,
    { result, acknowledged, ...(yielded ? { yielded } : {}) },
    requireRecovery,
  );
}

async function settleThrownClaim(
  context: QueueDrainContext,
  claim: QueueDispatchClaim,
  error: unknown,
): Promise<QueueDispatchAttempt> {
  const cancelled = await cancelRequestedClaim(context, claim);
  if (cancelled) return cancelled;
  await context.options.queue.release({ sessionId: claim.sessionId, claimId: claim.claimId });
  throw error;
}

async function settleExecutedClaim(
  context: QueueDrainContext,
  claim: QueueDispatchClaim,
  execution: {
    readonly result: Awaited<ReturnType<QueueTurnExecutor['execute']>>;
    readonly acknowledged: boolean;
    readonly yielded?: Set<string>;
  },
  requireRecovery: () => void,
): Promise<QueueDispatchAttempt> {
  const { result, acknowledged, yielded } = execution;
  const sessionId = claim.sessionId;
  if (result.accepted || result.reason === 'duplicate') {
    const drainAgain = acknowledged
      ? !result.accepted
      : await acknowledgeAccepted(context, claim, result, requireRecovery);
    return {
      result: {
        status: 'started',
        mode: result.accepted ? 'accepted' : 'duplicate',
        queueItemId: claim.item.itemId,
        turnId: result.turnId,
      },
      drainAgain,
    };
  }
  const cancelled = await cancelRequestedClaim(context, claim);
  if (cancelled) return cancelled;
  const handoffSettlement = await settleHandoffRejection(context, claim, result);
  if (handoffSettlement) return handoffSettlement;
  if (isRetryableSelection(claim)) {
    await context.options.queue.release({ sessionId, claimId: claim.claimId });
    return {
      result: exactRejectedResult(claim.item.itemId, result),
      drainAgain: false,
    };
  }
  if (result.queueDisposition === 'defer') {
    return settleAdmissionDeferral(context, claim, yielded);
  }
  if (result.queueDisposition === 'cancel') {
    await context.options.queue.cancelClaim({ sessionId, claimId: claim.claimId });
    return {
      result: { status: 'cancelled', queueItemId: claim.item.itemId },
      drainAgain: result.reason !== 'policy:turn-abort:pre-admission',
    };
  }
  return {
    result: {
      status: 'rejected',
      queueItemId: claim.item.itemId,
      reason: result.reason,
    },
    drainAgain: await settleRejected(context.options, claim, result.reason),
  };
}

/**
 * The second defer point: a blocker that only appears between queue
 * classification and the final admission recheck.
 *
 * Without the same yield as the classify stage, the item parked here would hold
 * the FIFO head for the rest of the pass — the head-of-line symptom, reached
 * through the later branch. The set stays drain-local and monotonic within the
 * pass, so termination is unchanged.
 */
async function settleAdmissionDeferral(
  context: QueueDrainContext,
  claim: QueueDispatchClaim,
  yielded?: Set<string>,
): Promise<QueueDispatchAttempt> {
  const yieldsPosition =
    yielded !== undefined && !isRetryableSelection(claim)
      ? await yieldsFifoPosition(context, claim)
      : false;
  await context.options.queue.release({
    sessionId: claim.sessionId,
    claimId: claim.claimId,
  });
  if (yieldsPosition) yielded?.add(claim.item.itemId);
  return {
    result: { status: 'deferred', queueItemId: claim.item.itemId },
    drainAgain: yieldsPosition,
  };
}

async function settleHandoffRejection(
  context: QueueDrainContext,
  claim: QueueDispatchClaim,
  result: Exclude<
    Awaited<ReturnType<QueueTurnExecutor['execute']>>,
    { readonly accepted: true } | { readonly reason: 'duplicate' }
  >,
): Promise<QueueDispatchAttempt | undefined> {
  // Query failures retain the original item (including intent); definitive
  // refusals are committed and notified, not silently cancelled.
  if (!result.reason.startsWith('policy:cloud-handoff:') || result.queueDisposition !== 'cancel')
    return undefined;
  const reason = result.reason as `policy:${string}`;
  const denied = reason.startsWith('policy:cloud-handoff:denied:');
  const input = { sessionId: claim.sessionId, claimId: claim.claimId, reason };
  if (denied) await context.options.queue.reject(input);
  else await context.options.queue.release(input);
  return {
    result: { status: 'rejected', queueItemId: claim.item.itemId, reason },
    drainAgain: denied && !isRetryableSelection(claim),
  };
}

async function cancelRequestedClaim(
  context: QueueDrainContext,
  claim: QueueDispatchClaim,
): Promise<QueueDispatchAttempt | undefined> {
  if (!context.options.isCancellationRequested?.(claim.item)) return undefined;
  await context.options.queue.cancelClaim({ sessionId: claim.sessionId, claimId: claim.claimId });
  return {
    result: { status: 'cancelled', queueItemId: claim.item.itemId },
    drainAgain: true,
  };
}

function isRetryableSelection(claim: QueueDispatchClaim): boolean {
  return claim.selection === 'exact' || claim.selection === 'continued-fifo';
}

async function claimNextIfOpen(
  context: QueueDrainContext,
  sessionId: string,
  yielded: Set<string>,
): Promise<QueueDispatchClaim | undefined> {
  if (context.closed || context.blockedSessions.has(sessionId)) {
    return undefined;
  }
  const claim = await context.options.queue.claimNext({
    sessionId,
    ...(yielded.size > 0 ? { excludeItemIds: [...yielded] } : {}),
  });
  if (!claim) return undefined;
  if (!context.closed && !context.blockedSessions.has(sessionId)) {
    return claim;
  }
  await context.options.queue.release({ sessionId, claimId: claim.claimId });
  return undefined;
}

async function acknowledgeAccepted(
  context: Pick<QueueDrainContext, 'options'>,
  claim: QueueDispatchClaim,
  result: { readonly turnId: string; readonly accepted: boolean },
  requireRecovery: () => void,
): Promise<boolean> {
  const acknowledgement = {
    sessionId: claim.sessionId,
    claimId: claim.claimId,
    turnId: result.turnId,
  };
  try {
    await context.options.queue.acknowledge(acknowledgement);
  } catch {
    try {
      await context.options.queue.acknowledge(acknowledgement);
    } catch (error) {
      requireRecovery();
      throw error;
    }
  }
  return !result.accepted;
}

async function settleRejected(
  options: QueueDispatcherOptions,
  claim: QueueDispatchClaim,
  reason: TurnAdmissionRejectionReason,
): Promise<boolean> {
  if (reason !== 'invalid-session' && reason !== 'ingress-conflict' && reason !== 'invalid-input') {
    await options.queue.release({ sessionId: claim.sessionId, claimId: claim.claimId });
    return false;
  }
  await options.queue.reject({
    sessionId: claim.sessionId,
    claimId: claim.claimId,
    reason: reason === 'invalid-input' ? 'ingress-conflict' : reason,
  });
  return true;
}

/** Shared claim projection for FIFO dispatch and the send-now steer workflow. */
export function queueClaimDeliveryInput(
  claim: QueueDispatchClaim,
  yielded?: ReadonlySet<string>,
): QueueTurnDeliveryInput {
  const item = claim.item;
  const userMessageId =
    item.userMessageId ??
    createUserMessageId({ sessionId: claim.sessionId, messageKey: `queue:${item.itemId}` });
  /*
   * One item owns one claim and one Turn. An explicit immediate-send item
   * carries its original members within that same ownership boundary.
   */
  return {
    sessionId: claim.sessionId,
    candidateCreatedAtMs: item.createdAt,
    immediateSendBatch: item.immediateSendBatch,
    queueSelection: claim.selection,
    ...(yielded && yielded.size > 0 ? { yieldedQueueItemIds: [...yielded] } : {}),
    ...queueDeliveryIdentity(claim),
    ...(claim.message.clientIntent ? { clientIntent: claim.message.clientIntent } : {}),
    userMessageId,
    input: toAgentInput(claim, item),
    ...(claim.message.inputSafetyDecision
      ? { inputSafetyDecision: claim.message.inputSafetyDecision }
      : {}),
    ...(claim.message.hideUserMessage !== undefined
      ? { hideUserMessage: claim.message.hideUserMessage }
      : {}),
    ...(claim.message.displayContent !== undefined
      ? { displayContent: claim.message.displayContent }
      : {}),
    ...(claim.message.displayAttachments
      ? {
          displayAttachments: claim.message.displayAttachments.map((attachment) => ({
            ...attachment,
          })),
        }
      : {}),
    ingress: {
      claimId: claim.claimId,
      itemId: item.itemId,
      userMessageId,
      ...queueClientRequestIdentity(claim),
      provenance: withMessageOrigin(claim),
    },
  };
}

function queueDeliveryIdentity(claim: QueueDispatchClaim) {
  const attempts = claim.item.deliveryAttempts;
  const firstAttempt = attempts?.[0];
  if (!firstAttempt)
    return claim.item.requestedTurnId ? { requestedTurnId: claim.item.requestedTurnId } : {};
  return {
    requestedTurnId: `turn_${randomUUID()}`,
    unstartedFromTurnIds: attempts.map((attempt) => attempt.turnId),
  };
}

function queueClientRequestIdentity(claim: QueueDispatchClaim) {
  if (!claim.clientRequestId) return {};
  const clientRequestId = claim.item.deliveryAttempts?.length
    ? `queue-delivery:${claim.claimId}`
    : claim.clientRequestId;
  return { clientRequestId };
}

function exactRejectedResult(
  queueItemId: string,
  result: {
    readonly reason: TurnAdmissionRejectionReason;
    readonly queueDisposition?: 'defer' | 'cancel';
  },
): QueueSteerDispatchResult {
  if (result.queueDisposition === 'defer') return { status: 'deferred', queueItemId };
  if (result.queueDisposition === 'cancel') return { status: 'cancelled', queueItemId };
  return { status: 'rejected', queueItemId, reason: result.reason };
}

function withMessageOrigin(claim: QueueDispatchClaim): QueueDispatchClaim['provenance'] {
  if (claim.message.origin === undefined) return claim.provenance;
  return {
    ...claim.provenance,
    sourceContext: {
      ...claim.provenance.sourceContext,
      origin: claim.message.origin,
    },
  };
}

function toAgentInput(
  claim: QueueDispatchClaim,
  item: QueueDispatchClaim['item'],
): AgentHostUserInput {
  const channelContext = claim.message.channelContext ?? item.channelContext;
  const model = toModel(item.model);
  const origin = isTrustedBackgroundQueueClaim(claim)
    ? parseBackgroundTaskOriginMetadata(claim.message.origin)
    : undefined;
  return {
    text:
      item.immediateSendBatch?.members.map((member) => member.message.content).join('\n\n') ??
      claim.message.content,
    attachments: (item.immediateSendBatch
      ? item.immediateSendBatch.members.flatMap((member) => member.message.attachments)
      : claim.message.attachments
    ).map(toAttachment),
    ...(origin ? { origin } : {}),
    ...(channelContext ? { channelContext } : {}),
    ...(claim.message.quotedMessage ? { quotedMessage: claim.message.quotedMessage } : {}),
    ...(model ? { model } : {}),
  };
}

function isTrustedBackgroundQueueClaim(claim: QueueDispatchClaim): boolean {
  return (
    claim.source === 'background-task' &&
    claim.item.source === 'background-task' &&
    claim.provenance.source === 'background-task'
  );
}

function toModel(model: QueueDispatchClaim['item']['model']) {
  if (!model) return undefined;
  return {
    ...(model.provider_id ? { providerId: model.provider_id } : {}),
    ...(model.model_id ? { modelId: model.model_id } : {}),
    ...(model.parameterSnapshot ? { parameterSnapshot: model.parameterSnapshot } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.context_limit !== undefined ? { contextLimit: model.context_limit } : {}),
    ...(typeof model.variant === 'string' ? { variant: model.variant } : {}),
    ...(model.thinking !== undefined
      ? { thinking: model.thinking.effort != null ? { effort: model.thinking.effort } : {} }
      : {}),
  };
}

function toAttachment(attachment: QueueMessageAttachment): AgentHostInputAttachment {
  return { ...attachment };
}
