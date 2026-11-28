import {
  Agent,
  executeToolCall,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AgentToolCall,
  type FinalizedToolCallOutcome,
  type ToolCallLifecycleConfig,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import type { TurnTerminationReason } from '../event-bridge/types.js';
import { projectAgentMessagesForModel } from './outbound-message-normalizer.js';
import { resolveMaxImagesPerRequest } from './request-image-limit.js';
import { failureReason } from './terminal.js';
import { stripVideoAudioForModel } from './video-audio-strip.js';
import {
  omitUnsampleableVideosForModel,
  PROVIDER_MAX_VIDEOS_PER_REQUEST,
  PROVIDER_VIDEO_SAMPLE_FPS,
} from './video-sampling-guard.js';
import { newRuntimeTool } from './tools.js';
import type { turnState } from './turn.js';
import type { RunTurnStartMode, UserMessageInput } from './types.js';

type AgentEventSink = (event: AgentEvent) => Promise<void>;

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
    convertToLlm: async (messages) => {
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
      // Before the audio strip, so a video the provider would reject is not remuxed.
      const sampled = await omitUnsampleableVideosForModel(outbound.messages, turn.llm.model);
      if (sampled.omittedCount > 0) {
        // The provider rejects the whole request for a video that breaks one of
        // its rules (frame sampling, length, aspect ratio, pixel budget), and
        // history replays it into every later request; only this request copy
        // drops it.
        turn.logger.warn(
          {
            event: 'outbound_unsampleable_videos_omitted',
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            provider: turn.llm.model.provider,
            omitted_video_count: sampled.omittedCount,
            video_rule_violations: sampled.ruleViolations,
            provider_video_sample_fps: PROVIDER_VIDEO_SAMPLE_FPS,
          },
          '[pi-turn-runner] replaced provider-bound videos that break a provider video rule with placeholders',
        );
      }
      if (sampled.brokenCount > 0) {
        // A broken container (no moov, no video track, an index pointing past
        // the frames, no keyframe, not a video at all) fails the provider's
        // probe and the whole request with it.
        turn.logger.warn(
          {
            event: 'outbound_broken_videos_omitted',
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            provider: turn.llm.model.provider,
            omitted_video_count: sampled.brokenCount,
            video_container_problems: sampled.containerProblems,
          },
          '[pi-turn-runner] replaced provider-bound videos with a broken container with placeholders',
        );
      }
      if (sampled.limitedCount > 0) {
        // History keeps every video; only this request copy drops the oldest
        // ones so it stays within the provider's per-request video limit.
        turn.logger.info(
          {
            event: 'outbound_videos_limited',
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            provider: turn.llm.model.provider,
            omitted_video_count: sampled.limitedCount,
            max_videos_per_request: PROVIDER_MAX_VIDEOS_PER_REQUEST,
          },
          '[pi-turn-runner] replaced older provider-bound videos with placeholders',
        );
      }
      const stripped = await stripVideoAudioForModel(sampled.messages, turn.llm.model);
      if (stripped.strippedCount > 0 || Object.keys(stripped.keptMimeTypes).length > 0) {
        // The model cannot hear audio, so only this request copy drops the
        // soundtrack; history keeps the original video.
        turn.logger.info(
          {
            event: 'outbound_video_audio_stripped',
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            provider: turn.llm.model.provider,
            stripped_video_count: stripped.strippedCount,
            kept_video_mime_types: stripped.keptMimeTypes,
          },
          '[pi-turn-runner] removed audio tracks from provider-bound videos',
        );
      }
      return stripped.messages;
    },
    streamFn: turn.streamFn,
    getApiKey: (provider) => (provider === turn.llm.model.provider ? turn.llm.apiKey : undefined),
    toolExecution: 'parallel',
    ...(turn.input.toolConfig.missingToolMessage
      ? { missingToolMessage: turn.input.toolConfig.missingToolMessage }
      : {}),
    ...(turn.input.toolConfig.resolveMissingTool
      ? { resolveMissingTool: (toolCall) => resolveMissingTool(turn, toolCall) }
      : {}),
    sessionId: turn.input.sessionId,
    ...(turn.input.shouldStopAfterSteering
      ? { shouldStopAfterSteering: turn.input.shouldStopAfterSteering }
      : {}),
    ...(turn.input.shouldStopAfterTurn
      ? { shouldStopAfterTurn: turn.input.shouldStopAfterTurn }
      : {}),
    ...(turn.input.unexpectedToolCallFallback
      ? { unexpectedToolCallFallback: turn.input.unexpectedToolCallFallback }
      : {}),
    ...(turn.llm.payloadTransform ? { onPayload: turn.llm.payloadTransform } : {}),
    ...(turn.llm.responseObserver ? { onResponse: turn.llm.responseObserver } : {}),
  });
}

/**
 * A direct call the host resolves outside this turn's catalog gets the same Pi wrapper as a
 * catalog tool: the turn's tool context, no PTC parent, no result observer.
 */
function resolveMissingTool(turn: turnState, toolCall: AgentToolCall): AgentTool | undefined {
  const runtimeTool = turn.input.toolConfig.resolveMissingTool?.({
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments,
  });
  if (runtimeTool?.def.name !== toolCall.name) return undefined;
  return newRuntimeTool(runtimeTool, turn.input.toolConfig.context, () =>
    turn.bridge.getActiveAssistantMessageId(),
  );
}

/**
 * Pi ends its loop on a provider error, so a response an afterLlmCall hook
 * recovered from (already removed from the transcript) is repeated here by
 * continuing from the same transcript.
 *
 * 网关 content_error（action=4）打回的回复同样已移出 transcript，这里按同一方式重发：
 * 从同一份 transcript 继续，前面已执行的工具不会重跑；重发参数（引导词、请求头）只交给
 * 这次 continue 的第一次真实请求。
 */
async function repeatRecoveredRequest(
  agent: Agent,
  turn: turnState,
  convergeAtIdle: (() => Promise<void>) | undefined,
): Promise<void> {
  for (;;) {
    const recovery = turn.recovery.pending;
    const regeneration = turn.contentReview.pending;
    if (!recovery && !regeneration) return;
    delete turn.recovery.pending;
    delete turn.contentReview.pending;
    if (turn.input.signal?.aborted) return;
    if (recovery) turn.recovery.active = recovery;
    if (regeneration) turn.contentReview.active = regeneration;
    turn.metrics.forgetLLMFailureObservation();
    await agent.continue();
    await agent.waitForIdle();
    // 没被消费的重发参数（例如这次被 hook 直接作答）作废，不能落到之后的调用上。
    delete turn.contentReview.active;
    await convergeAtIdle?.();
    await agent.waitForIdle();
  }
}

export async function runAgent(
  agent: Agent,
  turn: turnState,
  convergeAtIdle: (() => Promise<void>) | undefined,
  emit: AgentEventSink,
): Promise<TurnTerminationReason | undefined> {
  const startMode = turn.input.startMode ?? 'prompt';
  try {
    await startAgent(agent, turn, startMode, emit);
    await agent.waitForIdle();
    await repeatRecoveredRequest(agent, turn, convergeAtIdle);
    await convergeAtIdle?.();
    await agent.waitForIdle();
    await repeatRecoveredRequest(agent, turn, convergeAtIdle);
    if (turn.input.signal?.aborted) {
      return { kind: 'aborted' };
    }
    if (turn.contentReview.outcome) {
      // 不走 LLM 错误分类：分类结果的 message 可能取自原始错误，只用网关给的中性文案结束。
      return { kind: 'failed', message: turn.contentReview.message ?? '' };
    }
    // A turn-failure hook restored the failure its recovery replaced: the
    // Turn reports that one, not the host error of the repeated call.
    if (turn.recovery.restoredFailure) return turn.recovery.restoredFailure.termination;
    if (agent.state.errorMessage && !turn.requestStoppedBeforeSend) {
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

async function startAgent(
  agent: Agent,
  turn: turnState,
  startMode: RunTurnStartMode,
  emit: AgentEventSink,
): Promise<void> {
  switch (startMode) {
    case 'continue':
      return agent.continue();
    case 'resume-tool-calls':
      return resumePendingToolCalls(agent, turn, emit);
    case 'settle-interrupted-tool-calls':
      return settleInterruptedToolCalls(agent, turn, emit);
    default:
      return agent.prompt([
        ...(turn.input.beforeUserMessages ?? []),
        toPiUserMessage(turn.input.userMessage),
      ]);
  }
}

/**
 * Runs, in order and with their original ids, the tool calls of the last
 * assistant message that have no result yet, then continues the loop unless a
 * result stops the agent or the Turn is aborted. Each result enters the
 * transcript before its `message_end`, so the Host receives it as a
 * `messageDelta` exactly like a tool batch result.
 */
async function resumePendingToolCalls(
  agent: Agent,
  turn: turnState,
  emit: AgentEventSink,
): Promise<void> {
  const { assistant, pending, settled } = pendingToolCalls(agent.state.messages);
  const anchor = turn.input.resumeAssistantMessageId;
  if (anchor) {
    turn.bridge.resumeAssistantMessage({ msgId: anchor, assistant, toolResults: settled });
  }
  const context = {
    systemPrompt: agent.state.systemPrompt,
    messages: [...agent.state.messages],
    tools: toolsForCalls(agent, pending),
  };
  const config = toolLifecycleConfig(agent);
  const outcomes: FinalizedToolCallOutcome[] = [];
  const toolResults: ToolResultMessage[] = [];
  for (const toolCall of pending) {
    if (turn.input.signal?.aborted) return;
    const outcome = await executeToolCall(
      context,
      assistant,
      toolCall,
      config,
      turn.input.signal,
      emit,
    );
    const message = toolResultMessage(outcome);
    agent.state.messages.push(message);
    await emit({ type: 'message_start', message });
    await emit({ type: 'message_end', message });
    outcomes.push(outcome);
    toolResults.push(message);
  }
  await emit({ type: 'turn_end', message: assistant, toolResults });
  if (turn.input.signal?.aborted || stopsAgent(outcomes)) return;
  await agent.continue();
}

const INTERRUPTED_TOOL_CALL_CODE = 'TOOL_CALL_INTERRUPTED_BY_RUN_RESTART';
const INTERRUPTED_TOOL_CALL_MESSAGE =
  'This tool call was interrupted because the run executing it stopped (instance restart or failure). Its result is unknown and it may already have had side effects. Do not replay it automatically; check the current state first when the outcome matters.';

/**
 * Settles the tool calls of the last assistant message that have no result
 * yet: the run executing them stopped, so nobody knows whether they finished.
 * Each gets an error result saying so, with its original id, instead of being
 * dropped or run again; then the loop continues and the model decides. The
 * `tool_execution_end` closes the call's live card; the result enters the
 * transcript before its `message_end`, so the Host receives it as a
 * `messageDelta` exactly like a tool batch result.
 */
async function settleInterruptedToolCalls(
  agent: Agent,
  turn: turnState,
  emit: AgentEventSink,
): Promise<void> {
  const { assistant, pending, settled } = pendingToolCalls(agent.state.messages);
  const anchor = turn.input.resumeAssistantMessageId;
  if (anchor) {
    turn.bridge.resumeAssistantMessage({ msgId: anchor, assistant, toolResults: settled });
  }
  const toolResults: ToolResultMessage[] = [];
  for (const toolCall of pending) {
    if (turn.input.signal?.aborted) return;
    const result = {
      content: [{ type: 'text' as const, text: INTERRUPTED_TOOL_CALL_MESSAGE }],
      details: { interrupted: { code: INTERRUPTED_TOOL_CALL_CODE, outcome_unknown: true } },
    };
    await emit({
      type: 'tool_execution_end',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
      isError: true,
    });
    // The recorder listens to the Agent, which never sees events emitted here.
    turn.metrics.recordInterruptedToolCall('run_restart');
    const message: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: result.content,
      details: result.details,
      isError: true,
      timestamp: Date.now(),
    };
    agent.state.messages.push(message);
    await emit({ type: 'message_start', message });
    await emit({ type: 'message_end', message });
    toolResults.push(message);
  }
  await emit({ type: 'turn_end', message: assistant, toolResults });
  if (turn.input.signal?.aborted) return;
  await agent.continue();
}

function pendingToolCalls(messages: readonly AgentMessage[]): {
  readonly assistant: AssistantMessage;
  readonly pending: readonly AgentToolCall[];
  readonly settled: readonly ToolResultMessage[];
} {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.role !== 'assistant') index -= 1;
  const assistant = messages[index];
  if (assistant?.role !== 'assistant') {
    throw new Error('No assistant message to resume tool calls from');
  }
  const settled = messages
    .slice(index + 1)
    .flatMap((message) => (message.role === 'toolResult' ? [message] : []));
  const settledIds = new Set(settled.map((message) => message.toolCallId));
  const pending = assistant.content.filter(
    (part): part is AgentToolCall => part.type === 'toolCall' && !settledIds.has(part.id),
  );
  if (pending.length === 0) {
    throw new Error('The last assistant message has no tool call without a result');
  }
  return { assistant, pending, settled };
}

/** Catalog tools plus the ones the Host resolves for uncataloged calls, as in a tool batch. */
function toolsForCalls(agent: Agent, calls: readonly AgentToolCall[]): AgentTool[] {
  const tools = [...agent.state.tools];
  for (const call of calls) {
    if (tools.some((tool) => tool.name === call.name)) continue;
    const tool = agent.resolveMissingTool?.(call);
    if (tool?.name === call.name) tools.push(tool);
  }
  return tools;
}

function toolLifecycleConfig(agent: Agent): ToolCallLifecycleConfig {
  return {
    beforeToolCall: agent.beforeToolCall,
    onToolExecutionStart: agent.onToolExecutionStart,
    afterToolCall: agent.afterToolCall,
    missingToolMessage: agent.missingToolMessage,
  };
}

function toolResultMessage(outcome: FinalizedToolCallOutcome): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: outcome.toolCall.id,
    toolName: outcome.toolCall.name,
    content: outcome.result.content,
    details: outcome.result.details,
    isError: outcome.isError,
    timestamp: Date.now(),
  };
}

/** The rule Pi applies to a tool batch: any hook stop, or every result asks to terminate. */
function stopsAgent(outcomes: readonly FinalizedToolCallOutcome[]): boolean {
  return (
    outcomes.some((outcome) => outcome.terminateAgent === true) ||
    (outcomes.length > 0 && outcomes.every((outcome) => outcome.result.terminate === true))
  );
}
