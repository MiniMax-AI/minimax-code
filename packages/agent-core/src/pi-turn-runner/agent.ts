import { Agent } from '@earendil-works/pi-agent-core';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { TurnTerminationReason } from '../event-bridge/types.js';
import { projectAgentMessagesForModel } from './outbound-message-normalizer.js';
import { resolveMaxImagesPerRequest } from './request-image-limit.js';
import { failureReason } from './terminal.js';
import type { turnState } from './turn.js';
import type { UserMessageInput } from './types.js';

type PiUserMessage = UserMessage &
  Pick<UserMessageInput, 'canonicalTextRange' | 'genuineUserQueryText' | 'hostMetadata'>;

export function toPiUserMessage(input: UserMessageInput): PiUserMessage {
  const message: PiUserMessage = {
    role: 'user',
    content: [{ type: 'text', text: input.text }, ...(input.attachments ?? [])],
    timestamp: input.timestamp ?? Date.now(),
    ...(input.canonicalTextRange
      ? {
          canonicalTextRange: {
            startOffset: input.canonicalTextRange.startOffset,
            endOffset: input.canonicalTextRange.endOffset,
          },
        }
      : {}),
    ...(input.genuineUserQueryText !== undefined
      ? { genuineUserQueryText: input.genuineUserQueryText }
      : {}),
    ...(input.hostMetadata ? { hostMetadata: { ...input.hostMetadata } } : {}),
  };
  return message;
}

export function newAgent(turn: turnState): Agent {
  return new Agent({
    initialState: {
      systemPrompt: turn.input.systemPrompt,
      model: turn.llm.model,
      thinkingLevel: turn.thinkingLevel,
      tools: turn.tools,
      messages: turn.initialMessages,
    },
    convertToLlm: (messages) => {
      const outbound = projectAgentMessagesForModel(messages, turn.llm.model);
      if (outbound.removedCount > 0) {
        turn.logger.warn(
          {
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            provider: turn.llm.model.provider,
            removed_count: outbound.removedCount,
          },
          '[pi-turn-runner] removed orphan tool results from provider-bound history',
        );
      }
      const undeterminedImages = Object.entries(outbound.undeterminedImageMimeTypes);
      if (undeterminedImages.length > 0) {
        // Images kept because their size is unreadable. A recurring cluster here
        // is the signal to teach imageDimensions another format. Diagnostic, not
        // an error: nothing is broken, the block is deliberately passed through,
        // and history is re-projected on every request of the session.
        turn.logger.info(
          {
            event: 'outbound_image_size_undetermined',
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            provider: turn.llm.model.provider,
            undetermined_image_count: undeterminedImages.reduce(
              (total, [, count]) => total + count,
              0,
            ),
            undetermined_image_mime_types: outbound.undeterminedImageMimeTypes,
          },
          '[pi-turn-runner] kept provider-bound images whose dimensions could not be determined',
        );
      }
      if (outbound.omittedImageCount > 0) {
        // History keeps every image; only this request copy drops the oldest
        // ones so it stays within the model's per-request image limit (#425).
        turn.logger.info(
          {
            event: 'outbound_images_limited',
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            provider: turn.llm.model.provider,
            omitted_image_count: outbound.omittedImageCount,
            max_images_per_request: resolveMaxImagesPerRequest(turn.llm.model),
          },
          '[pi-turn-runner] replaced older provider-bound images with placeholders',
        );
      }
      return outbound.messages;
    },
    streamFn: turn.streamFn,
    getApiKey: (provider) => (provider === turn.llm.model.provider ? turn.llm.apiKey : undefined),
    toolExecution: 'parallel',
    sessionId: turn.input.sessionId,
    ...(turn.input.shouldStopAfterSteering
      ? { shouldStopAfterSteering: turn.input.shouldStopAfterSteering }
      : {}),
    ...(turn.input.shouldStopAfterTurn
      ? { shouldStopAfterTurn: turn.input.shouldStopAfterTurn }
      : {}),
    ...(turn.llm.payloadTransform ? { onPayload: turn.llm.payloadTransform } : {}),
    ...(turn.llm.responseObserver ? { onResponse: turn.llm.responseObserver } : {}),
  });
}

export async function runAgent(
  agent: Agent,
  turn: turnState,
  convergeAtIdle?: () => Promise<void>,
): Promise<TurnTerminationReason | undefined> {
  const startMode = turn.input.startMode ?? 'prompt';
  try {
    if (startMode === 'continue') {
      await agent.continue();
    } else {
      await agent.prompt([
        ...(turn.input.beforeUserMessages ?? []),
        toPiUserMessage(turn.input.userMessage),
      ]);
    }
    await agent.waitForIdle();
    await convergeAtIdle?.();
    await agent.waitForIdle();
    if (turn.input.signal?.aborted) {
      return { kind: 'aborted' };
    }
    if (agent.state.errorMessage) {
      return failureReason(
        agent.state.errorMessage,
        turn.metrics.getLLMFailureObservation()?.normalized,
      );
    }
    return undefined;
  } catch (err) {
    if (turn.input.signal?.aborted) {
      return { kind: 'aborted' };
    }
    const runError = err instanceof Error ? err.message : String(err);
    turn.logger.error(
      {
        session_id: turn.input.sessionId,
        turn_id: turn.input.turnId,
        start_mode: startMode,
        error: runError,
      },
      '[pi-turn-runner] agent start threw',
    );
    return failureReason(runError);
  }
}
