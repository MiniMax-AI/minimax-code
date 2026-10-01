import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  UserMessage,
} from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent/messages';

import { imageDimensions } from './image-dimensions.js';

const PRIOR_THINKING_OPEN = '<|prior-thinking|>';
const PRIOR_THINKING_CLOSE = '<|/prior-thinking|>';

const SIBLING_NATIVE_THINKING_APIS = new Set<string>([
  'anthropic-messages',
  'bedrock-converse-stream',
]);

// Last-resort net: model gateways reject a request outright when any image in it
// is degenerate, and because the image lives in persisted history the session
// then fails forever. The producer-side guard in the Browser tool
// (POST_ACTION_VISUAL_MIN_CLIP_EDGE_PX, 32) stops new ones being created; this
// value exists to heal sessions that were already poisoned.
//
// It is deliberately far tighter than the producer's 32. The rejection
// threshold is a server-side property that can move — measured at <=2px on the
// production gateway and <=4px on the open-platform test gateway — so neither
// side sits on the red line, but the two sides trade off in opposite
// directions. The producer can be generous because it fully controls the clip
// and a sub-32px sliver carries no information. Here the content is the user's,
// the only job is "do not get the whole request rejected", and wrongly dropping
// genuine content costs more than letting a small image through.
const MIN_PROVIDER_IMAGE_EDGE_PX = 8;

/**
 * Build the exact temporary message list sent to a target model.
 * Canonical Agent messages are never rewritten by this projection.
 */
export function projectAgentMessagesForModel(
  messages: readonly AgentMessage[],
  targetModel: Model<Api>,
): {
  messages: Message[];
  removedCount: number;
  /**
   * Images kept because their size could not be determined, counted by declared
   * mimeType. Empty in the normal case. The caller logs this; a recurring
   * cluster is the signal to teach `imageDimensions` another format.
   */
  undeterminedImageMimeTypes: Record<string, number>;
} {
  const providerVisible = messages.filter((message) => !isHostOnlyMessage(message));
  const compatible = removeOrphanToolResults(
    mergeImmediateSendBatches(convertToLlm(providerVisible)).map(stripHostOnlyFields),
  );
  const normalized = normalizeOutboundMessagesForModel(compatible.messages, targetModel);
  const undetermined = new Map<string, number>();
  // Order matters: projectVideoBlocks turns `video` blocks into `image` blocks,
  // so the size filter has to run after it or it would miss every
  // video-derived image.
  const projected = normalized
    .map(projectVideoBlocks)
    .map((message) => projectUndersizedImageBlocks(message, undetermined));
  return {
    removedCount: compatible.removedCount,
    messages: projected,
    undeterminedImageMimeTypes: Object.fromEntries(undetermined),
  };
}

/** Explicit Host grouping; ordinary adjacent user messages remain independent. */
export function immediateSendBatchId(message: AgentMessage): string | undefined {
  if (message.role !== 'user') return undefined;
  const metadata = Reflect.get(message, 'hostMetadata');
  if (!metadata || typeof metadata !== 'object') return undefined;
  const id = Reflect.get(metadata, 'immediateSendBatchId');
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function mergeImmediateSendBatches(messages: Message[]): Message[] {
  const projected: Message[] = [];
  const batchPositions = new Map<string, number>();
  for (const message of messages) {
    const batchId = immediateSendBatchId(message);
    const position = batchId ? batchPositions.get(batchId) : undefined;
    const previous = position === undefined ? undefined : projected[position];
    if (position !== undefined && previous?.role === 'user' && message.role === 'user') {
      const blocks = [
        ...userContent(previous),
        { type: 'text' as const, text: '\n\n' },
        ...userContent(message),
      ];
      const content: ReturnType<typeof userContent> = [];
      for (const block of blocks) {
        const last = content.at(-1);
        if (last?.type === 'text' && block.type === 'text') {
          content[content.length - 1] = { ...last, text: last.text + block.text };
        } else content.push(block);
      }
      projected[position] = { ...previous, content };
    } else {
      if (batchId) batchPositions.set(batchId, projected.length);
      projected.push(message);
    }
  }
  return projected;
}

function userContent(message: UserMessage): Exclude<UserMessage['content'], string> {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content;
}

function stripHostOnlyFields(message: Message): Message {
  if (
    !Object.hasOwn(message, 'genuineUserQueryText') &&
    !Object.hasOwn(message, 'canonicalTextRange') &&
    !Object.hasOwn(message, 'hostMetadata')
  ) {
    return message;
  }
  const projected = { ...message };
  Reflect.deleteProperty(projected, 'genuineUserQueryText');
  Reflect.deleteProperty(projected, 'canonicalTextRange');
  Reflect.deleteProperty(projected, 'hostMetadata');
  return projected;
}

function isHostOnlyMessage(message: AgentMessage): boolean {
  if (message.role !== 'custom') return false;
  const metadata = Reflect.get(message, 'hostMetadata');
  return (
    !!metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    Reflect.get(metadata, 'providerVisibility') === 'omit'
  );
}

function isSourceQualifiedByokProvider(provider: string): boolean {
  return provider === 'minimax_api' || provider.startsWith('custom_provider:');
}

function shouldDropPortableThinking(message: AssistantMessage, targetModel: Model<Api>): boolean {
  return (
    isSourceQualifiedByokProvider(message.provider) ||
    isSourceQualifiedByokProvider(targetModel.provider)
  );
}

export function removeOrphanToolResults(messages: Message[]): {
  messages: Message[];
  removedCount: number;
} {
  const seenToolCallIds = new Set<string>();
  const filtered = messages.filter((message) => {
    if (message.role === 'assistant') {
      message.content
        .filter((block) => block.type === 'toolCall')
        .forEach((block) => seenToolCallIds.add(block.id));
      return true;
    }
    return message.role !== 'toolResult' || seenToolCallIds.has(message.toolCallId);
  });
  return {
    messages: filtered.length === messages.length ? messages : filtered,
    removedCount: messages.length - filtered.length,
  };
}

/**
 * Normalize provider-bound history before pi-ai's provider adapters apply their
 * own model-distance rules.
 *
 * This works on the temporary LLM request copy only. Persisted Pi messages keep
 * the original model/provider metadata for audit and replay.
 */
export function normalizeOutboundMessagesForModel(
  messages: Message[],
  targetModel: Model<Api>,
): Message[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    return normalizeAssistantMessage(message, targetModel);
  });
}

function normalizeAssistantMessage(
  message: AssistantMessage,
  targetModel: Model<Api>,
): AssistantMessage {
  const sameProviderAndApi =
    message.provider === targetModel.provider && message.api === targetModel.api;
  const sameModel = sameProviderAndApi && message.model === targetModel.id;
  if (sameModel) return message;

  const canReplayNativeSibling =
    sameProviderAndApi && SIBLING_NATIVE_THINKING_APIS.has(targetModel.api);
  const dropPortableThinking = shouldDropPortableThinking(message, targetModel);
  const content = message.content.flatMap((block) => {
    if (block.type !== 'thinking') return block;
    if (canReplayNativeSibling) return block;
    if (dropPortableThinking) return [];
    return thinkingToPortableText(block);
  });

  if (!canReplayNativeSibling) {
    return { ...message, content };
  }

  // pi-ai's transformMessages treats a different model id as cross-model and
  // strips provider-native thinking. For same-provider sibling APIs whose
  // thinking signatures are known to be provider-bound rather than model-bound,
  // stamp the outbound copy as the target model so pi-ai preserves the native
  // blocks. Model-bound APIs (Google, OpenAI Responses, unknown APIs) are
  // converted to portable text instead.
  return {
    ...message,
    model: targetModel.id,
    content,
  };
}

function thinkingToPortableText(block: ThinkingContent): TextContent[] {
  if (block.redacted || !block.thinking || block.thinking.trim().length === 0) return [];
  return [
    {
      type: 'text',
      text: `${PRIOR_THINKING_OPEN}\n${block.thinking}\n${PRIOR_THINKING_CLOSE}`,
    },
  ];
}

function projectVideoBlocks(message: Message): Message {
  if (typeof message.content === 'string' || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const candidate = block as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (candidate.type !== 'video') return block;
    changed = true;
    return {
      type: 'image' as const,
      data: candidate.data as string,
      mimeType: candidate.mimeType as string,
    };
  });
  return changed ? ({ ...message, content } as Message) : message;
}

/**
 * Replace images the provider would reject for being degenerate with a text
 * placeholder, on the temporary request copy only.
 *
 * Fails open in every uncertain case: an image whose size cannot be read is
 * kept untouched and only counted, because wrongly dropping real user content
 * is worse than forwarding a small image. The replacement is a `text` block, so
 * a message whose only block was an undersized image still has content — no
 * special "would this message become empty" branch is needed.
 */
function projectUndersizedImageBlocks(
  message: Message,
  undetermined: Map<string, number>,
): Message {
  if (typeof message.content === 'string' || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const candidate = block as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (candidate.type !== 'image') return block;
    const size = imageDimensions(candidate.data, candidate.mimeType);
    if (!size) {
      // The size check itself still ran above and still applies: only the
      // telemetry skips blocks projected from `video`, which keep their
      // `video/*` mimeType and are unparseable by design. Counting them would
      // pre-pollute the very signal this counter exists to surface.
      const mimeType = typeof candidate.mimeType === 'string' ? candidate.mimeType : 'unknown';
      if (!mimeType.toLowerCase().startsWith('video/')) {
        undetermined.set(mimeType, (undetermined.get(mimeType) ?? 0) + 1);
      }
      return block;
    }
    if (Math.min(size.width, size.height) >= MIN_PROVIDER_IMAGE_EDGE_PX) return block;
    changed = true;
    return {
      type: 'text' as const,
      text: `[image omitted: ${size.width}x${size.height} px is below the ${MIN_PROVIDER_IMAGE_EDGE_PX} px minimum edge required by the model provider]`,
    };
  });
  return changed ? ({ ...message, content } as Message) : message;
}
