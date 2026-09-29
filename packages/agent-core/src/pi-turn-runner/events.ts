import type { Agent, AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { buildRunningSessionStatusEvent } from '../event-bridge/index.js';
import type { TurnTerminationReason } from '../event-bridge/types.js';
import type { PiEventWriter, RuntimeEvent } from './types.js';
import type { turnHistory } from './history.js';
import type { turnState } from './turn.js';
import { immediateSendBatchId } from './outbound-message-normalizer.js';

export interface eventSub {
  unsubscribe(): void;
  drain(): Promise<void>;
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
    turn.metrics.tryRecordTerminalFailure({ errorSource: 'event_writer', errorKind: 'delivery' });
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
    turn.metrics.tryRecordTerminalFailure({
      errorSource: 'event_bridge',
      errorKind: 'translation',
    });
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
    turn.metrics.tryRecordTerminalFailure({ errorSource: 'event_writer', errorKind: 'delivery' });
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
  agent.shouldStopAfterTurn = async (context) =>
    forcedTermination !== undefined || (await existingShouldStopAfterTurn?.(context)) === true;

  const applyAfterLlmControl = async (
    event: Extract<AgentEvent, { type: 'message_end' }>,
  ): Promise<'emit' | 'discard'> => {
    if (event.message.role !== 'assistant' || turn.hooks.afterLLM.length === 0) return 'emit';
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
        forcedTermination = { kind: 'failed', message: `after_llm_call_failed: ${message}` };
        return isEmptyAssistantResponse(event.message) ? 'discard' : 'emit';
      }
      if (!decision || decision.type === 'continue') continue;
      if (decision.type === 'replaceText') {
        event.message.content = [
          ...event.message.content.filter((block) => block.type !== 'text'),
          { type: 'text', text: decision.text },
        ];
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
      // A failed response is rejected as a whole. Never let its still-pending
      // tool intent execute.
      event.message.content = event.message.content.filter((block) => block.type !== 'toolCall');
      forcedTermination = { kind: 'failed', message: decision.reason };
      return isEmptyAssistantResponse(event.message) ? 'discard' : 'emit';
    }
    return 'emit';
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

  const cannotContinueAtIdle = (): boolean =>
    forcedTermination !== undefined ||
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
      let closeRefused = false;
      for (;;) {
        // The poll reports whether more steps already follow. At an exit
        // boundary the host may withhold messages so the close below hands
        // them back to the session instead of extending a finished answer.
        const boundary = hasToolCalls || agent.hasQueuedMessages() ? 'mid-turn' : 'exit';
        const steering = [...((await turn.input.getSteeringMessages?.({ boundary })) ?? [])];
        enqueueSteering(agent, steering);
        if (steering.length > 0 || hasToolCalls || agent.hasQueuedMessages()) return;
        if (!turn.input.tryBeginClose) return;
        if (
          await turn.input.tryBeginClose({
            ...lastAssistantMessageContext(event.message),
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

  const convergeAtIdle = async (): Promise<void> => {
    if (!turn.input.tryBeginClose || continuationsClosed || cannotContinueAtIdle()) return;
    try {
      let closeRefused = false;
      while (!continuationsClosed && !cannotContinueAtIdle()) {
        const boundary = agent.hasQueuedMessages() ? 'mid-turn' : 'exit';
        const steering = [...((await turn.input.getSteeringMessages?.({ boundary })) ?? [])];
        if (steering.length > 0) {
          enqueueSteering(agent, steering);
          closeRefused = false;
          await agent.continue();
          continue;
        }
        if (
          await turn.input.tryBeginClose({
            ...lastAssistantMessageContext(
              [...agent.state.messages]
                .reverse()
                .find((message): message is AssistantMessage => message.role === 'assistant'),
            ),
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

  const writeAgentEvent = async (event: AgentEvent, observedAtMs: number): Promise<void> => {
    let out: Awaited<ReturnType<typeof turn.bridge.processEvent>>;
    try {
      out = await turn.bridge.processEvent(event, observedAtMs);
    } catch (err) {
      turn.metrics.recordDegradation('event_bridge', 'translation', err);
      throw err;
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
    let discardMessage = false;
    try {
      if (event.type === 'message_end') {
        discardMessage = (await applyAfterLlmControl(event)) === 'discard';
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
    }

    if ((!discardMessage && event.type === 'message_end') || event.type === 'tool_execution_end') {
      await history.flushTail();
    }
    if (event.type === 'turn_end' && turn.hooks.onStepEnd.length > 0) {
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

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    // Capture before queueing or awaiting response hooks so decode timing only
    // spans model events, not caller-side control or delivery work.
    const observedAtMs = nowMs();
    // Serialize caller-side work even when Pi emits events from parallel
    // tool completions. History delivery failures reject the current Pi
    // listener; the resolved queue link still lets Pi's failure events drain.
    const queued = queue.then(() => onAgentEvent(event, observedAtMs));
    queue = queued.catch(() => undefined);
    return queued;
  });

  return {
    unsubscribe,
    drain: () => queue,
    convergeAtIdle,
    forcedTermination: () => forcedTermination,
  };
}

function enqueueSteering(agent: Agent, messages: AgentMessage[]): void {
  if (messages.some((message) => immediateSendBatchId(message) !== undefined)) {
    agent.steerBatch(messages);
  } else {
    messages.forEach((message) => agent.steer(message));
  }
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
