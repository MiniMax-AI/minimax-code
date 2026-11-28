import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  TextContent,
  UserMessage,
} from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent/messages';
import { stripMiniAppSuggestionTags } from '@mavis/shared/miniapp-suggestion';

import { imageDimensions } from './image-dimensions.js';
import { limitRequestImages, resolveMaxImagesPerRequest } from './request-image-limit.js';
import {
  projectUnsupportedMediaBlocks,
  resolveRequestMediaSupport,
} from './request-media-support.js';
import { hasThinkingPrefixBinding } from './thinking-prefix-binding.js';

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
// The MiniMax gateway rejects the whole request for an image whose long edge is
// more than 200 times its short edge (`image's aspect ratio exceeds 200:1`,
// measured with an 8000x8 PNG; reported incident). Such a strip carries
// almost nothing once a vision encoder resizes it, so the placeholder costs
// little on other providers too.
const MAX_PROVIDER_IMAGE_ASPECT_RATIO = 200;

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
  /**
   * Older image blocks replaced by a placeholder so the request stays within
   * the model's per-request image limit (see `request-image-limit.ts`).
   */
  omittedImageCount: number;
} {
  const providerVisible = messages.filter((message) => !isHostOnlyMessage(message));
  const compatible = removeOrphanToolResults(
    mergeImmediateSendBatches(convertToLlm(providerVisible)).map(stripHostOnlyFields),
  );
  const normalized = normalizeOutboundMessagesForModel(compatible.messages, targetModel);
  const undetermined = new Map<string, number>();
  const mediaSupport = resolveRequestMediaSupport(targetModel);
  // Order matters: projectVideoBlocks turns `video` blocks into `image` blocks,
  // so the media-support and size filters have to run after it or they would
  // miss every video-derived image. Unsupported media go before the size
  // filter so a dropped video is not counted as an undetermined image.
  const projected = normalized
    .map(projectVideoBlocks)
    // Audio/PDF become text first: the media-support filter treats every
    // non-video image block as a still image.
    .map((message) => projectNonNativeDocumentMedia(message, targetModel))
    .map((message) => projectUnsupportedMediaBlocks(message, mediaSupport))
    .map((message) => projectDegenerateImageBlocks(message, undetermined))
    .map((message) => projectErrorToolResultImages(message, targetModel));
  // Last, so the ceiling counts exactly the images that would be sent: video
  // frames projected to images count, undersized placeholders do not. A model
  // whose thinking is bound to its prefix keeps every image; compaction
  // removes them instead.
  const limited = hasThinkingPrefixBinding(targetModel)
    ? { messages: projected, omittedCount: 0 }
    : limitRequestImages(projected, resolveMaxImagesPerRequest(targetModel));
  return {
    removedCount: compatible.removedCount,
    messages: limited.messages,
    omittedImageCount: limited.omittedCount,
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
  const prefixBound = hasThinkingPrefixBinding(targetModel);
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') return message;
    const normalized = normalizeAssistantMessage(message, targetModel);
    // Keep the signed prefix intact, including during a later tool call.
    if (prefixBound) return normalized;
    const projected = projectAssistantCardMetadata(normalized);
    return projected !== normalized && projected.content.length === 0 ? [] : projected;
  });
}

function projectAssistantCardMetadata(message: AssistantMessage): AssistantMessage {
  let changed = false;
  const content = message.content.flatMap((block) => {
    if (block.type !== 'text') return block;
    const text = stripMiniAppSuggestionTags(block.text);
    if (text === block.text) return block;
    changed = true;
    return text.trim() ? { type: 'text' as const, text } : [];
  });
  return changed ? { ...message, content } : message;
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

/** Thinking replayed as plain text for a target that cannot verify its signature. */
export function thinkingToPortableText(block: {
  readonly redacted?: boolean;
  readonly thinking?: string;
}): TextContent[] {
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
 * Replace images the provider would reject for being degenerate (an edge below
 * the minimum, or an aspect ratio above the maximum) with a text placeholder,
 * on the temporary request copy only.
 *
 * Fails open in every uncertain case: an image whose size cannot be read is
 * kept untouched and only counted, because wrongly dropping real user content
 * is worse than forwarding a small image. The replacement is a `text` block, so
 * a message whose only block was an undersized image still has content — no
 * special "would this message become empty" branch is needed.
 */
function projectDegenerateImageBlocks(
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
      // telemetry skips media blocks (video, audio, PDF) that ride the image
      // block with their real mimeType and are unparseable by design.
      // Counting them would pre-pollute the very signal this counter exists
      // to surface.
      const mimeType = typeof candidate.mimeType === 'string' ? candidate.mimeType : 'unknown';
      if (!isNonImageMediaMime(mimeType)) {
        undetermined.set(mimeType, (undetermined.get(mimeType) ?? 0) + 1);
      }
      return block;
    }
    const placeholder = degenerateImagePlaceholder(size.width, size.height);
    if (placeholder === undefined) return block;
    changed = true;
    return { type: 'text' as const, text: placeholder };
  });
  return changed ? ({ ...message, content } as Message) : message;
}

/**
 * Why the model provider would reject this image (an edge below
 * `MIN_PROVIDER_IMAGE_EDGE_PX` or an aspect ratio above
 * `MAX_PROVIDER_IMAGE_ASPECT_RATIO`), in the words the request placeholder
 * uses and without a full stop; undefined when it passes or its size cannot be
 * read (only PNG and JPEG headers are read). `data` is base64 text or the raw
 * bytes. User attachments and the read tool use it to refuse such an image
 * when it comes in, so it never reaches history and only the request
 * placeholder below would have hidden it.
 */
export function findDegenerateImageReason(data: unknown, mimeType?: unknown): string | undefined {
  const size = imageDimensions(data, mimeType);
  return size ? degenerateImageReason(size.width, size.height) : undefined;
}

function degenerateImagePlaceholder(width: number, height: number): string | undefined {
  const reason = degenerateImageReason(width, height);
  return reason === undefined ? undefined : `[image omitted: ${reason}]`;
}

function degenerateImageReason(width: number, height: number): string | undefined {
  const shortEdge = Math.min(width, height);
  if (shortEdge < MIN_PROVIDER_IMAGE_EDGE_PX) {
    return `${width}x${height} px is below the ${MIN_PROVIDER_IMAGE_EDGE_PX} px minimum edge required by the model provider`;
  }
  const ratio = Math.max(width, height) / shortEdge;
  if (ratio <= MAX_PROVIDER_IMAGE_ASPECT_RATIO) return undefined;
  return `${width}x${height} px has an aspect ratio of ${formatAspectRatio(ratio)}:1, above the ${MAX_PROVIDER_IMAGE_ASPECT_RATIO}:1 maximum the model provider accepts. Crop it into less elongated pieces to send it again`;
}

/** Two decimals at most, rounded down, so 200.4:1 does not read as the 200:1 limit itself. */
function formatAspectRatio(ratio: number): string {
  return String(Math.floor(ratio * 100) / 100);
}

/** Protocols whose wire format carries audio and PDF inline (see the BYOK capability gate). */
const NATIVE_DOCUMENT_MEDIA_APIS: ReadonlySet<string> = new Set(['google-generative-ai']);

function isDocumentMediaMime(mimeType: unknown): mimeType is string {
  if (typeof mimeType !== 'string') return false;
  const normalized = mimeType.toLowerCase();
  return normalized.startsWith('audio/') || normalized === 'application/pdf';
}

function isNonImageMediaMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('video/') || isDocumentMediaMime(mimeType);
}

/**
 * Audio and PDF blocks exist only in sessions that ran on a native transport
 * (Gemini). After a switch to another protocol they would be sent as images
 * and rejected, so the request copy gets a text placeholder instead.
 */
function projectNonNativeDocumentMedia(message: Message, targetModel: Model<Api>): Message {
  if (NATIVE_DOCUMENT_MEDIA_APIS.has(targetModel.api)) return message;
  if (typeof message.content === 'string' || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((block) => {
    // Persisted history can hold malformed (null) blocks; pass them through.
    if (block?.type !== 'image' || !isDocumentMediaMime(block.mimeType)) return block;
    changed = true;
    const kind = block.mimeType.toLowerCase() === 'application/pdf' ? 'PDF' : 'audio';
    return {
      type: 'text' as const,
      text: `[${kind} omitted: the current model cannot read ${block.mimeType} inline]`,
    };
  });
  return changed ? ({ ...message, content } as Message) : message;
}

/**
 * Anthropic Messages rejects the whole request when an `is_error` tool_result
 * holds anything but text ("all content must be type `text` if `is_error` is
 * true"), and the result is persisted history, so the session would fail on
 * every later request. A failed run_code attaches its children's media
 * (Browser and Computer Use screenshots), and other tools can return an image
 * with an error. Keep the error and its text; replace each image on the
 * request copy only, so a request that would have been accepted is unchanged.
 */
function projectErrorToolResultImages(message: Message, targetModel: Model<Api>): Message {
  if (targetModel.api !== 'anthropic-messages') return message;
  if (message.role !== 'toolResult' || !message.isError || !Array.isArray(message.content)) {
    return message;
  }
  if (!message.content.some((block) => block.type === 'image')) return message;
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === 'image'
        ? {
            type: 'text' as const,
            text: '[image omitted: the model provider accepts only text in a failed tool result]',
          }
        : block,
    ),
  };
}
