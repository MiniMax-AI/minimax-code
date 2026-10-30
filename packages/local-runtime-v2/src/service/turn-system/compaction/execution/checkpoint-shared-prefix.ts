import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Message, Model, Tool } from '@earendil-works/pi-ai';

import type { CheckpointGeneration } from '../algorithm/checkpoint-format.js';
import type { CheckpointRequestShape, CheckpointSharedPrefixFallbackReason } from '../contracts.js';
import {
  projectRequestMedia,
  type RequestMediaProjectionInput,
} from './request-media-projection.js';

/**
 * The main request's own prefix. A checkpoint request that repeats it and only
 * appends the checkpoint control reads the Provider prompt cache that the main
 * request already wrote.
 */
export interface CheckpointSharedPrefix {
  /** Main-request session id; Providers derive the cache key and affinity from it. */
  readonly sessionId: string;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  /**
   * The request-only media projection the main request applies before model
   * projection. Repeating it keeps the image placeholders of the main prefix.
   */
  readonly projectRequestMedia: (messages: readonly AgentMessage[]) => readonly AgentMessage[];
}

/** The main-request prefix for a Host-selected `shared_prefix` request; otherwise none. */
export function resolveCheckpointSharedPrefix(
  input: Omit<RequestMediaProjectionInput<AgentMessage>, 'messages'> & {
    readonly sessionId: string;
    readonly model: Model<Api>;
    readonly checkpointRequestShape?: CheckpointRequestShape;
    readonly systemPrompt?: string;
    readonly tools?: readonly Tool[];
  },
): CheckpointSharedPrefix | undefined {
  if (input.checkpointRequestShape !== 'shared_prefix' || input.systemPrompt === undefined) {
    return undefined;
  }
  const media: Omit<RequestMediaProjectionInput<AgentMessage>, 'messages'> = {
    model: input.model,
    ...(input.maxSerializedInputBytes === undefined
      ? {}
      : { maxSerializedInputBytes: input.maxSerializedInputBytes }),
  };
  return {
    sessionId: input.sessionId,
    systemPrompt: input.systemPrompt,
    tools: input.tools ?? [],
    projectRequestMedia: (messages) => projectRequestMedia({ ...media, messages }).messages,
  };
}

/**
 * The main request's system prompt, tools, and projected history, followed by
 * the one control message that carries the checkpoint protocol.
 */
export function buildSharedPrefixCheckpointContext(
  prefix: CheckpointSharedPrefix,
  projected: readonly Message[],
  control: Message,
): Parameters<StreamFn>[1] {
  return {
    systemPrompt: prefix.systemPrompt,
    messages: [...projected, control],
    tools: [...prefix.tools],
  };
}

/**
 * A shared-prefix response that called a tool says nothing about whether the
 * candidate fits; the same candidate is re-sent in the isolated shape.
 */
export function sharedPrefixToolCallFallback(
  generation: Pick<CheckpointGeneration, 'responseContentKinds' | 'stopReason'>,
): CheckpointSharedPrefixFallbackReason | undefined {
  return generation.responseContentKinds.includes('toolCall') || generation.stopReason === 'toolUse'
    ? 'tool_call'
    : undefined;
}
