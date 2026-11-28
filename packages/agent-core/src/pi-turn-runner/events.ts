import type { Agent, AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { buildRunningSessionStatusEvent } from '../event-bridge/index.js';
import type { TurnTerminationReason } from '../event-bridge/types.js';
import type { PiEventWriter, RuntimeEvent } from './types.js';
import type { turnHistory } from './history.js';
import type { turnState } from './turn.js';
import {
  decideContentReview,
  parseContentReviewError,
  type ContentReviewOutcome,
  type ContentReviewRejection,
} from './content-review.js';
import type { PiTurnFailure } from './hooks.js';
import { isLLMRequestStoppedMessage } from './llm-retry.js';
import { llmCallPreemptedNotice } from './llm-preemption.js';
import { immediateSendBatchId } from './outbound-message-normalizer.js';
import { replaceAssistantText } from './replace-text.js';
import { failureReason } from './terminal.js';

/** Bounds a turn-failure hook that keeps asking to recover. */
const MAX_TURN_FAILURE_RECOVERIES = 4;

export interface eventSub {
  unsubscribe(): void;
  drain(): Promise<void>;
  dispatch(event: AgentEvent): Promise<void>;
  convergeAtIdle(): Promise<void>;
  forcedTermination(): TurnTerminationReason | undefined;
}

export async function emitRunning(turn: turnState): Promise<void> {
  try {
    await flushEvents(turn.writer, [
      buildRunningSessionStatusEvent({
        sessionId: turn.input.sessionId,
        turnId: turn.input.turnId,
        eventId: turn.nextEventId('coding_running_status'),
      }),
    ]);
  } catch (err) {
    turn.metrics.tryRecordTerminalFailure(
      { errorSource: 'event_writer', errorKind: 'delivery' },
      err,
    );
    turn.logger.error(
      {
        sessionId: turn.input.sessionId,
        turnId: turn.input.turnId,
        errorSource: 'event_writer',
        error: err instanceof Error ? err.message : String(err),
      },
      '[pi-turn-runner] running event writer failed',
    );
    throw err;
  }
}

export async function emitTerminal(turn: turnState, reason: TurnTerminationReason): Promise<void> {
  let events: RuntimeEvent[];
  try {
    events = (await turn.bridge.emitTerminal(reason)).events;
  } catch (err) {
    turn.metrics.tryRecordTerminalFailure(
      { errorSource: 'event_bridge', errorKind: 'translation' },
      err,
    );
    turn.logger.error(
      {
        sessionId: turn.input.sessionId,
        turnId: turn.input.turnId,
        secondaryErrorSource: 'event_bridge',
        error: err instanceof Error ? err.message : String(err),
      },
      '[pi-turn-runner] terminal event bridge failed',
    );
    throw err;
  }
  try {
    await flushEvents(turn.writer, events);
  } catch (err) {
    turn.metrics.tryRecordTerminalFailure(
      { errorSource: 'event_writer', errorKind: 'delivery' },
      err,
    );
    turn.logger.error(
      {
        sessionId: turn.input.sessionId,
        turnId: turn.input.turnId,
        secondaryErrorSource: 'event_writer',
        error: err instanceof Error ? err.message : String(err),
      },
      '[pi-turn-runner] terminal event writer failed',
    );
    throw err;
  }
}

export function subscribeEvents(
  agent: Agent,
  turn: turnState,
  history: turnHistory,
  nowMs: () => number,
): eventSub {
  let pendingMessageID: Promise<string> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let forcedTermination: TurnTerminationReason | undefined;
  let continuationsClosed = false;
  const existingShouldStopAfterTurn = agent.shouldStopAfterTurn;
  // A recovered response leaves the loop to the runner, which repeats the call:
  // no queued steering may reach the provider ahead of that repeat.
  agent.shouldStopAfterTurn = async (context) =>
    forcedTermination !== undefined ||
    turn.recovery.pending !== undefined ||
    (await existingShouldStopAfterTurn?.(context)) === true;

  /**
   * Asks the turn-failure hooks about a Turn that is about to fail. True when
   * one of them recovers: the response is dropped and the call repeated. Once
   * a history change failed to persist, nothing more of the Turn can be
   * written, so a recovery would end the Turn looking complete with its
   * records missing: only `restore` is honoured then.
   */
  const recoverTurnFailure = async (
    message: AssistantMessage,
    failure: PiTurnFailure,
    termination: TurnTerminationReason,
    errorMessage: string,
  ): Promise<boolean> => {
    const stopped = (): boolean => turn.input.signal?.aborted === true;
    if (turn.hooks.turnFailure.length === 0 || stopped()) return false;
    const requestMessages = turn.recovery.lastRequestPrepared
      ? turn.recovery.lastRequest
      : undefined;
    const recoverable = (): boolean =>
      !history.deliveryFailed() &&
      turn.recovery.turnFailureRecoveries < MAX_TURN_FAILURE_RECOVERIES;
    for (const hook of turn.hooks.turnFailure) {
      let decision: Awaited<ReturnType<typeof hook>>;
      try {
        decision = await hook({
          sessionId: turn.input.sessionId,
          turnId: turn.input.turnId,
          failure,
          message,
          ...(requestMessages ? { requestMessages } : {}),
          signal: turn.input.signal ?? agent.signal,
          recoverable: recoverable(),
        });
      } catch (error) {
        turn.logger.error(
          {
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            error: error instanceof Error ? error.message : String(error),
          },
          '[pi-turn-runner] turnFailure hook threw; leaving the failure as it is',
        );
        continue;
      }
      if (!decision || decision.type === 'continue') continue;
      if (decision.type === 'restore') {
        const replaced = turn.recovery.replacedFailure;
        if (replaced) {
          turn.recovery.restoredFailure = replaced;
          if (message.stopReason === 'error') message.errorMessage = replaced.errorMessage;
        }
        return false;
      }
      // The hook may have awaited a stop.
      if (stopped() || !recoverable()) return false;
      turn.recovery.turnFailureRecoveries += 1;
      message.content = message.content.filter((block) => block.type !== 'toolCall');
      turn.recovery.pending = {
        reason: decision.reason,
        errorMessage,
        requestMessages: requestMessages ?? [],
        ...(decision.detail !== undefined ? { detail: decision.detail } : {}),
        ...(decision.replay === true && requestMessages ? { replay: true } : {}),
      };
      turn.recovery.replacedFailure = { termination, errorMessage };
      return true;
    }
    return false;
  };

  const applyAfterLlmControl = async (
    event: Extract<AgentEvent, { type: 'message_end' }>,
  ): Promise<'emit' | 'discard'> => {
    if (
      event.message.role !== 'assistant' ||
      (turn.hooks.afterLLM.length === 0 && turn.hooks.turnFailure.length === 0)
    ) {
      return 'emit';
    }
    if (event.message.stopReason !== 'error') turn.recovery.used = false;
    // A follow-up is sent only once every hook has kept this response: a later
    // retry or failure discards it, and the follow-up would ask about a reply
    // the model never sees again.
    let followUpPrompt: string | undefined;
    for (const hook of turn.hooks.afterLLM) {
      let decision: Awaited<ReturnType<typeof hook>>;
      try {
        decision = await hook({
          sessionId: turn.input.sessionId,
          turnId: turn.input.turnId,
          message: event.message,
          messages: [...agent.state.messages],
          signal: turn.input.signal ?? agent.signal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        turn.logger.error(
          {
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            error: message,
          },
          '[pi-turn-runner] afterLlmCall hook threw; failing response control closed',
        );
        event.message.content = event.message.content.filter((block) => block.type !== 'toolCall');
        const termination: TurnTerminationReason = {
          kind: 'failed',
          message: `after_llm_call_failed: ${message}`,
        };
        if (
          await recoverTurnFailure(
            event.message,
            { kind: 'hook_error', errorMessage: message },
            termination,
            termination.message,
          )
        ) {
          return 'discard';
        }
        forcedTermination = termination;
        return isEmptyAssistantResponse(event.message) ? 'discard' : 'emit';
      }
      if (!decision || decision.type === 'continue') continue;
      if (decision.type === 'replaceText') {
        event.message.content = replaceAssistantText(event.message.content, decision.text);
        continue;
      }
      if (decision.type === 'retry') {
        // Pi selects tool calls from this same final message after listeners
        // settle. Strip rejected tool intent synchronously so retry cannot
        // leak side effects before the recovery request is processed.
        event.message.content = event.message.content.filter((block) => block.type !== 'toolCall');
        agent.followUp({
          role: 'user',
          content: [{ type: 'text', text: decision.prompt }],
          timestamp: Date.now(),
        });
        return 'discard';
      }
      if (decision.type === 'followUp') {
        const final =
          event.message.stopReason !== 'error' &&
          !event.message.content.some((block) => block.type === 'toolCall');
        if (final) followUpPrompt ??= decision.prompt;
        continue;
      }
      if (decision.type === 'recover') {
        if (
          event.message.stopReason !== 'error' ||
          turn.recovery.used ||
          turn.input.signal?.aborted === true
        ) {
          continue;
        }
        turn.recovery.used = true;
        turn.recovery.pending = {
          reason: decision.reason,
          errorMessage: event.message.errorMessage ?? '',
          requestMessages: turn.recovery.lastRequest ?? [],
        };
        return 'discard';
      }
      // A failed response is rejected as a whole. Never let its still-pending
      // tool intent execute.
      event.message.content = event.message.content.filter((block) => block.type !== 'toolCall');
      const termination: TurnTerminationReason = { kind: 'failed', message: decision.reason };
      if (
        await recoverTurnFailure(
          event.message,
          { kind: 'response_rejected', reason: decision.reason },
          termination,
          decision.reason,
        )
      ) {
        return 'discard';
      }
      forcedTermination = termination;
      return isEmptyAssistantResponse(event.message) ? 'discard' : 'emit';
    }
    if (event.message.stopReason !== 'error') {
      if (followUpPrompt !== undefined) {
        agent.followUp({
          role: 'user',
          content: [{ type: 'text', text: followUpPrompt }],
          timestamp: Date.now(),
        });
      }
      return 'emit';
    }
    const errorMessage = event.message.errorMessage ?? '';
    const normalized = turn.metrics.getLLMFailureObservation()?.normalized;
    const recovered = await recoverTurnFailure(
      event.message,
      { kind: 'provider_error', errorMessage, ...(normalized ? { normalized } : {}) },
      failureReason(errorMessage, normalized),
      errorMessage,
    );
    return recovered ? 'discard' : 'emit';
  };

  /**
   * 网关 content_error：先于 afterLlmCall hook 处理，不交给 recover。被打回的这条回复一律丢弃
   * （不发完成事件、不进历史）；action=4 且预算内时登记重发，由 runAgent 从同一份 transcript 重发，
   * 其他结果记为本轮结果。每次都先通知调用方，带上这条消息的 id 供撤回。
   */
  const applyContentReview = async (
    event: Extract<AgentEvent, { type: 'message_end' }>,
  ): Promise<boolean> => {
    const message = event.message;
    if (message.role !== 'assistant') return false;
    const state = turn.contentReview;
    const error = parseContentReviewError(message);
    if (!error) {
      if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
        state.regenerations = 0;
      }
      return false;
    }
    const regenerations = state.regenerations;
    const kind = decideContentReview(error, {
      regenerations,
      maxRegenerations: state.options?.maxRegenerations ?? 0,
      aborted: turn.input.signal?.aborted === true,
    });
    const assistantMessageId = turn.bridge.getActiveAssistantMessageId();
    const rejection: ContentReviewRejection = {
      kind,
      ...(assistantMessageId ? { assistantMessageId } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.action === undefined ? {} : { action: error.action }),
      ...(kind === 'replace' && error.suggestion ? { suggestion: error.suggestion } : {}),
      regenerations,
    };
    if (kind === 'regenerate') {
      state.regenerations = regenerations + 1;
      state.pending = {
        attempt: regenerations + 1,
        ...(error.requestId ? { requestId: error.requestId } : {}),
        guidePrompt: error.guidePrompt ?? state.options!.defaultGuidePrompt,
      };
    } else {
      state.regenerations = 0;
      state.outcome = rejection as ContentReviewOutcome;
      if (error.message !== undefined) state.message = error.message;
    }
    turn.logger.info(
      {
        session_id: turn.input.sessionId,
        turn_id: turn.input.turnId,
        kind,
        code: error.code,
        action: error.action,
        request_id: error.requestId,
        regenerations,
      },
      '[pi-turn-runner] gateway rejected the model response',
    );
    try {
      await state.options?.onRejected?.(rejection);
    } catch (err) {
      turn.logger.error(
        {
          session_id: turn.input.sessionId,
          turn_id: turn.input.turnId,
          error: err instanceof Error ? err.message : String(err),
        },
        '[pi-turn-runner] content review rejection callback threw; continuing',
      );
    }
    return true;
  };

  /**
   * A request the host refused to send (its request budget closed while a
   * steering, retry or regeneration path still asked for one) ends the Turn
   * normally: Pi reports it as a run failure, which is dropped here and not
   * shown, and `runAgent` does not treat it as a failure.
   */
  const isRefusedRequestFailure = (message: AgentMessage): boolean => {
    if (
      message.role !== 'assistant' ||
      message.stopReason !== 'error' ||
      !isLLMRequestStoppedMessage(message.errorMessage)
    ) {
      return false;
    }
    turn.requestStoppedBeforeSend = true;
    return true;
  };

  const discardAssistantMessage = (event: Extract<AgentEvent, { type: 'message_end' }>): void => {
    // Agent.state and Pi's private loop context are distinct arrays containing
    // the same final message object. Remove the public transcript copy now and
    // let transformContext remove the loop-context copy before the next call.
    turn.rejectedAssistantMessages.add(event.message);
    const messages = agent.state.messages;
    const messageIndex = messages.lastIndexOf(event.message);
    if (messageIndex >= 0) {
      agent.state.messages = [
        ...messages.slice(0, messageIndex),
        ...messages.slice(messageIndex + 1),
      ];
    }
    turn.bridge.discardActiveAssistantMessage();
  };

  /**
   * The preempted response never reached history, so nothing of it is flushed.
   * Its text may already be on screen: the host retracts it by message id.
   */
  const discardPreemptedResponse = async (
    event: Extract<AgentEvent, { type: 'message_end' }>,
  ): Promise<void> => {
    // An id still being allocated would be written back after the discard.
    await pendingMessageID?.catch(() => undefined);
    const messageId = turn.bridge.getActiveAssistantMessageId();
    const delivered = turn.preemption.discarded?.delivered === true;
    delete turn.preemption.discardMessage;
    turn.preemption.resumePending = true;
    discardAssistantMessage(event);
    turn.logger.info(
      { session_id: turn.input.sessionId, turn_id: turn.input.turnId, message_id: messageId },
      '[pi-turn-runner] discarded preempted LLM response',
    );
    // Retraction removes the whole message, including what the user already read.
    if (!messageId || delivered) return;
    try {
      await turn.input.llmPreemption?.onResponseDiscarded?.(messageId);
    } catch (error) {
      turn.logger.warn(
        {
          session_id: turn.input.sessionId,
          turn_id: turn.input.turnId,
          error: error instanceof Error ? error.message : String(error),
        },
        '[pi-turn-runner] retracting preempted response failed; continuing the resend',
      );
    }
  };

  const cannotContinueAtIdle = (): boolean =>
    forcedTermination !== undefined ||
    turn.recovery.pending !== undefined ||
    turn.input.signal?.aborted === true ||
    agent.state.errorMessage !== undefined;

  const failContinuationPoll = (error: unknown): void => {
    const message = formatUnknownError(error);
    forcedTermination = {
      kind: 'failed',
      message: `continuation_poll_failed: ${message}`,
    };
    turn.logger.error(
      {
        session_id: turn.input.sessionId,
        turn_id: turn.input.turnId,
        error: message,
      },
      '[pi-turn-runner] continuation poll threw; failing the turn closed',
    );
  };

  const pollExternalContinuations = async (
    event: Extract<AgentEvent, { type: 'turn_end' }>,
  ): Promise<void> => {
    if (
      cannotContinueAtIdle() ||
      event.message.role !== 'assistant' ||
      event.message.stopReason === 'aborted' ||
      event.message.stopReason === 'error'
    ) {
      return;
    }
    try {
      const hasToolCalls = event.message.content.some((block) => block.type === 'toolCall');
      const resending = turn.preemption.resumePending === true;
      delete turn.preemption.resumePending;
      const discarded = turn.preemption.discarded;
      delete turn.preemption.discarded;
      let closeRefused = false;
      for (;;) {
        // The poll reports whether more steps already follow. At an exit
        // boundary the host may withhold messages so the close below hands
        // them back to the session instead of extending a finished answer.
        // Once the host closed the Turn's work, every poll is an exit.
        const workClosed = (await turn.input.isWorkClosed?.()) === true;
        // A preempted step produced nothing, so it finished no answer: the
        // user steering that caused it must join the resend, not wait for a
        // next Turn. Closed work or a stopping prompt falls through to a close.
        const boundary =
          !workClosed && (resending || hasToolCalls || agent.hasQueuedMessages())
            ? 'mid-turn'
            : 'exit';
        const steering = [
          ...((await turn.input.getSteeringMessages?.(
            workClosed ? { boundary, workClosed } : { boundary, resendBatch: resending },
          )) ?? []),
        ];
        if (
          resending &&
          boundary === 'mid-turn' &&
          (await turn.input.shouldStopAfterSteering?.()) !== true
        ) {
          try {
            // One batch: Pi drains single steering messages one request at a time.
            agent.steerBatch([
              llmCallPreemptedNotice({ timestamp: nowMs(), ...discarded }),
              ...steering,
            ]);
            return;
          } catch (error) {
            // Without the notice the steering still joins the next call, as it always did.
            turn.logger.warn(
              {
                session_id: turn.input.sessionId,
                turn_id: turn.input.turnId,
                error: error instanceof Error ? error.message : String(error),
              },
              '[pi-turn-runner] preempted resend notice failed; queueing steering as usual',
            );
            void Promise.resolve()
              .then(() => turn.input.llmPreemption?.onResendFallback?.())
              .catch(() => undefined);
          }
        }
        enqueueSteering(agent, steering);
        if (steering.length > 0 || hasToolCalls || agent.hasQueuedMessages()) return;
        if (!turn.input.tryBeginClose) return;
        if (
          await turn.input.tryBeginClose({
            ...lastAssistantMessageContext(event.message),
            ...(workClosed ? { workClosed } : {}),
          })
        ) {
          continuationsClosed = true;
          return;
        }
        if (closeRefused) {
          throw new Error('continuation close was refused without drainable work');
        }
        closeRefused = true;
      }
    } catch (error) {
      failContinuationPoll(error);
    }
  };

  /**
   * A refused request ends the Turn: no further request can carry steering
   * into it. Close once anyway, as a final close the host cannot refuse for
   * pending steering, so user steering this Turn never consumed goes back to
   * the session instead of being dropped when the Turn completes (Goal spec
   * §5.5). Steering that keeps arriving cannot loop: nothing continues.
   */
  const closeAfterRefusedRequest = async (): Promise<void> => {
    if (
      continuationsClosed ||
      !turn.requestStoppedBeforeSend ||
      forcedTermination !== undefined ||
      turn.input.signal?.aborted === true
    ) {
      return;
    }
    continuationsClosed = true;
    await turn.input.tryBeginClose?.({
      ...lastAssistantMessageContext(lastAssistantMessage(agent)),
      workClosed: true,
      final: true,
    });
  };

  const convergeAtIdle = async (): Promise<void> => {
    if (!turn.input.tryBeginClose || continuationsClosed) return;
    try {
      let closeRefused = false;
      while (!continuationsClosed && !cannotContinueAtIdle()) {
        // A Turn whose work is closed only closes here: its pending user
        // steering is handed back to the session by the close (spec: no
        // input lost, none run inside a Turn that can only wrap up). When
        // other steering refuses that close, the poll below stays a
        // work-closed exit so it still leaves user steering to the session.
        const workClosed = (await turn.input.isWorkClosed?.()) === true;
        if (
          workClosed &&
          (await turn.input.tryBeginClose?.({
            ...lastAssistantMessageContext(lastAssistantMessage(agent)),
            workClosed: true,
          }))
        ) {
          continuationsClosed = true;
          return;
        }
        const boundary = !workClosed && agent.hasQueuedMessages() ? 'mid-turn' : 'exit';
        const steering = [
          ...((await turn.input.getSteeringMessages?.(
            workClosed ? { boundary, workClosed } : { boundary },
          )) ?? []),
        ];
        if (steering.length > 0) {
          enqueueSteering(agent, steering);
          closeRefused = false;
          await agent.continue();
          continue;
        }
        if (
          await turn.input.tryBeginClose({
            ...lastAssistantMessageContext(lastAssistantMessage(agent)),
            ...(workClosed ? { workClosed } : {}),
          })
        ) {
          continuationsClosed = true;
          return;
        }
        if (closeRefused) {
          throw new Error('continuation close was refused without drainable work');
        }
        closeRefused = true;
      }
      await closeAfterRefusedRequest();
    } catch (error) {
      failContinuationPoll(error);
    }
  };

  const writeAgentEvent = async (event: AgentEvent, observedAtMs: number): Promise<void> => {
    if (requiresPtcLifecycleDelivery(event, turn) && !turn.bridge.getActiveAssistantMessageId()) {
      throw new Error('PTC lifecycle delivery requires an active assistant message id.');
    }
    // Read before the bridge closes the message: a message without tool calls
    // drops its id as soon as its completed frame is built.
    const endedAssistantId =
      event.type === 'message_end' &&
      event.message.role === 'assistant' &&
      event.message.stopReason !== 'aborted'
        ? turn.bridge.getActiveAssistantMessageId()
        : undefined;
    let out: Awaited<ReturnType<typeof turn.bridge.processEvent>>;
    try {
      out = await turn.bridge.processEvent(event, observedAtMs);
    } catch (err) {
      turn.metrics.recordDegradation('event_bridge', 'translation', err);
      throw err;
    }
    if (endedAssistantId && event.type === 'message_end') {
      turn.assistantMessageIds.set(event.message, endedAssistantId);
    }
    if (out.requestAssistantMessageId) {
      // The bridge may ask for the assistant message id before it can emit
      // assistant deltas. Hold later events on the same allocation promise so
      // deltas never race ahead of their message anchor.
      const allocPromise = turn.allocator
        .allocateAssistantMessageId(turn.input.sessionId, turn.input.turnId)
        .then((id) => {
          turn.bridge.setActiveAssistantMessageId(id);
          return id;
        })
        .catch((err) => {
          turn.metrics.recordDegradation('message_identity', 'identity', err);
          const message = err instanceof Error ? err.message : String(err);
          turn.logger.error(
            { session_id: turn.input.sessionId, turn_id: turn.input.turnId, error: message },
            '[pi-turn-runner] assistant message id allocation failed',
          );
          turn.bridge.setActiveAssistantMessageId('');
          throw err;
        });
      pendingMessageID = allocPromise;
      await allocPromise;
    } else if (pendingMessageID) {
      await pendingMessageID;
    }
    if (out.events.length > 0) {
      try {
        await flushEvents(turn.writer, out.events);
      } catch (err) {
        turn.metrics.recordDegradation('event_writer', 'delivery', err);
        throw err;
      }
    }
  };

  const onAgentEvent = async (event: AgentEvent, observedAtMs: number): Promise<void> => {
    // A yielded run writes nothing more: the resuming run re-emits what it
    // owns. History still flows so the host fence keeps settled tool results.
    if (turn.input.isYieldStopped?.() === true) {
      if (event.type === 'message_end' || event.type === 'tool_execution_end') {
        await history.flushTail();
      }
      return;
    }
    let discardMessage = false;
    if (
      event.type === 'tool_execution_start' &&
      !event.parentToolCallId &&
      turn.input.llmPreemption?.deliversOnToolStart?.(event.toolName, event.args) === true
    ) {
      turn.preemption.deliveredInCall = true;
    }
    try {
      if (event.type === 'message_end' && event.message === turn.preemption.discardMessage) {
        discardMessage = true;
        await discardPreemptedResponse(event);
      } else if (event.type === 'message_end') {
        discardMessage =
          (await applyContentReview(event)) ||
          isRefusedRequestFailure(event.message) ||
          (await applyAfterLlmControl(event)) === 'discard';
        if (discardMessage) discardAssistantMessage(event);
      }
      if (!discardMessage) await writeAgentEvent(event, observedAtMs);
    } catch (err) {
      turn.logger.error(
        {
          session_id: turn.input.sessionId,
          turn_id: turn.input.turnId,
          event_type: event.type,
          error: err instanceof Error ? err.message : String(err),
        },
        '[pi-turn-runner] event handler threw',
      );
      if (requiresPtcLifecycleDelivery(event, turn)) throw err;
    }

    if ((!discardMessage && event.type === 'message_end') || event.type === 'tool_execution_end') {
      await history.flushTail();
    }
    // A preempted step did no work, so step-end hooks have nothing to observe.
    if (
      event.type === 'turn_end' &&
      turn.hooks.onStepEnd.length > 0 &&
      turn.preemption.resumePending !== true
    ) {
      const blockedToolCalls = turn.blockedToolCalls;
      turn.blockedToolCalls = [];
      // Step-end hooks may enqueue follow-up messages into the same Agent.
      // Pi polls those follow-ups after this listener settles, so await the
      // hooks here but keep hook failures isolated to this event branch.
      // (Pi's `turn_end` fires per-step in our vocabulary — see design §11.)
      const signal = turn.input.signal ?? new AbortController().signal;
      for (const hook of turn.hooks.onStepEnd) {
        try {
          await hook({
            agent,
            message: event.message,
            toolResults: event.toolResults,
            signal,
            blockedToolCalls,
          });
        } catch (hookErr) {
          turn.metrics.recordDegradation('turn_end_hook', 'hook_error', hookErr);
          turn.logger.error(
            {
              session_id: turn.input.sessionId,
              turn_id: turn.input.turnId,
              error: hookErr instanceof Error ? hookErr.message : String(hookErr),
            },
            '[pi-turn-runner] onStepEnd hook threw; ignoring so agent loop continues',
          );
        }
      }
    }
    if (event.type === 'turn_end') await pollExternalContinuations(event);
  };

  const dispatch = (event: AgentEvent): Promise<void> => {
    // Capture before queueing or awaiting response hooks so decode timing only
    // spans model events, not caller-side control or delivery work.
    const observedAtMs = nowMs();
    // Serialize caller-side work even when Pi emits events from parallel
    // tool completions. History delivery failures reject the current Pi
    // listener; the resolved queue link still lets Pi's failure events drain.
    const queued = queue.then(() => onAgentEvent(event, observedAtMs));
    queue = queued.catch(() => undefined);
    return queued;
  };

  const unsubscribe = agent.subscribe((event: AgentEvent) => dispatch(event));

  return {
    unsubscribe,
    drain: () => queue,
    dispatch,
    convergeAtIdle,
    forcedTermination: () => forcedTermination,
  };
}

function requiresPtcLifecycleDelivery(event: AgentEvent, turn: turnState): boolean {
  if (
    turn.input.toolConfig.ptcTools === undefined ||
    (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end')
  ) {
    return false;
  }
  if (event.parentToolCallId) return true;
  return (
    event.toolName === 'run_code' &&
    (turn.input.toolConfig.tools ?? []).some(
      (tool) => tool.def.name === 'run_code' && tool.source === 'builtin',
    )
  );
}

function enqueueSteering(agent: Agent, messages: AgentMessage[]): void {
  if (messages.some((message) => immediateSendBatchId(message) !== undefined)) {
    agent.steerBatch(messages);
  } else {
    messages.forEach((message) => agent.steer(message));
  }
}

function lastAssistantMessage(agent: Agent): AssistantMessage | undefined {
  return [...agent.state.messages]
    .reverse()
    .find((message): message is AssistantMessage => message.role === 'assistant');
}

function lastAssistantMessageContext(message: AssistantMessage | undefined): {
  readonly lastAssistantMessage?: string;
} {
  if (!message) return {};
  const text = message.content
    .filter(
      (block): block is Extract<(typeof message.content)[number], { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('')
    .trim();
  return text ? { lastAssistantMessage: text } : {};
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'unknown continuation error';
  }
}

function isEmptyAssistantResponse(message: AssistantMessage): boolean {
  const hasVisibleText = message.content.some(
    (block) => block.type === 'text' && block.text.trim().length > 0,
  );
  const hasToolCall = message.content.some((block) => block.type === 'toolCall');
  return !hasVisibleText && !hasToolCall;
}

export async function flushEvents(
  eventWriter: PiEventWriter,
  events: ReadonlyArray<RuntimeEvent>,
): Promise<void> {
  if (events.length === 0) return;
  if (typeof eventWriter.appendEvents === 'function') {
    await eventWriter.appendEvents([...events]);
    return;
  }
  for (const event of events) {
    await eventWriter.pushRuntime(event);
  }
}
