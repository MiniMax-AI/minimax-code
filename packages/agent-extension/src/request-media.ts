import type {
  AfterLlmCallHandler,
  AfterToolCallHandler,
  AgentExtension,
} from '@mavis/agent-runtime';
import {
  encodeRequestImageBlocks,
  isRequestMediaRejection,
  type RequestImageEncoding,
} from '@mavis/context-manager';

export interface RequestMediaExtensionOptions {
  readonly id?: string;
  readonly description?: string;
  /** Read for every tool result; the Read tool's limits when absent. */
  readonly getImageEncoding?: () => RequestImageEncoding;
}

/**
 * Keeps request media within provider limits: re-encodes tool result images to
 * the per-image limit, and asks the turn to repeat once a request the provider
 * rejected for its size, images or context length. The repeated request
 * compacts the history first, moving every image out of it.
 */
export function requestMediaExtension(options: RequestMediaExtensionOptions = {}): AgentExtension {
  const afterToolCall: AfterToolCallHandler = async (toolContext) => {
    const content = await encodeRequestImageBlocks(
      toolContext.result.content,
      options.getImageEncoding?.(),
    );
    return content ? { content } : undefined;
  };

  const afterLlmCall: AfterLlmCallHandler = (event) =>
    isRequestMediaRejection(event.message)
      ? { type: 'recover', reason: 'request_media' }
      : { type: 'continue' };

  return {
    id: options.id ?? 'request-media',
    description:
      options.description ??
      'Re-encode tool result images and compact once after a request rejected for its size.',
    init(pi) {
      pi.on('after_tool_call', afterToolCall);
      pi.on('after_llm_call', afterLlmCall);
    },
  };
}
