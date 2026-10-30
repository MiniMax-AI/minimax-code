import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { keepsRequestImages } from '@mavis/agent-core/pi-turn-runner';
import { boundRequestMedia, resolveRequestMediaBudget } from '@mavis/context-manager';

export interface RequestMediaProjectionInput<T extends AgentMessage> {
  readonly messages: readonly T[];
  readonly model: Model<Api>;
  readonly maxSerializedInputBytes?: number;
}

/**
 * The request-only image limit applied to every image, user or tool, before
 * model projection, on models that do not cache by prefix. History is
 * untouched; dropped images become placeholders. Prefix-cached models keep
 * every image so their requests stay byte-identical.
 *
 * Both the main request (request media guard hook) and the shared-prefix
 * checkpoint request use this one projection, so the checkpoint repeats the
 * image placeholders the main request already sent and keeps its prefix.
 */
export function projectRequestMedia<T extends AgentMessage>(
  input: RequestMediaProjectionInput<T>,
): { readonly messages: T[]; readonly omittedCount: number } {
  if (keepsRequestImages(input.model)) return { messages: [...input.messages], omittedCount: 0 };
  return boundRequestMedia(input.messages, resolveRequestMediaBudget(input));
}
