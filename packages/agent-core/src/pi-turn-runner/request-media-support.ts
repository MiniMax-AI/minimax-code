import type { Api, ImageContent, Message, Model, TextContent } from '@earendil-works/pi-ai';

/**
 * Optional per-model media support carried on the resolved model object, so
 * every request builder that receives the model (agent turns, compaction
 * checkpoints, footprint measurement) drops the same unsupported media.
 *
 * pi-ai has a single `image` input modality and Pi history carries videos as
 * `image` blocks with a `video/*` mimeType, so `model.input` alone cannot tell
 * a model that accepts still images from one that accepts only video. A
 * resolver that knows the model's real capabilities sets these flags; when a
 * flag is absent, support falls back to `model.input.includes('image')`, which
 * is what pi-ai itself checks.
 */
export interface ModelRequestMediaSupport {
  readonly supportsImageInput?: boolean;
  readonly supportsVideoInput?: boolean;
}

export interface RequestMediaSupport {
  readonly image: boolean;
  readonly video: boolean;
}

// Wording mirrors pi-ai's own non-vision placeholders (transform-messages.ts),
// so a text-only target sees the same text whichever layer replaced the image.
const USER_IMAGE_PLACEHOLDER = '(image omitted: model does not support images)';
const TOOL_IMAGE_PLACEHOLDER = '(tool image omitted: model does not support images)';
const USER_VIDEO_PLACEHOLDER = '(video omitted: model does not support video)';
const TOOL_VIDEO_PLACEHOLDER = '(tool video omitted: model does not support video)';

/**
 * Image and video support of `model`: explicit flags first, else its pi-ai input
 * modalities. A model object without `input` (partial models built outside the
 * resolver) declares nothing, so its media passes through unchanged.
 */
export function resolveRequestMediaSupport(model: Model<Api>): RequestMediaSupport {
  const declared = model as Model<Api> & ModelRequestMediaSupport;
  const input: unknown = model.input;
  const acceptsImageBlocks = Array.isArray(input) ? input.includes('image') : true;
  return {
    image: declared.supportsImageInput ?? acceptsImageBlocks,
    video: declared.supportsVideoInput ?? acceptsImageBlocks,
  };
}

/**
 * Replace every image block of a user message or tool result that the target
 * cannot accept with a text placeholder, on the temporary request copy only.
 * Blocks with a `video/*` mimeType are videos and follow video support; every
 * other image block follows image support. Consecutive identical placeholders
 * collapse into one, as pi-ai does. Messages without a replaced block keep
 * their identity, so the projection is deterministic for prefix caching.
 */
export function projectUnsupportedMediaBlocks(
  message: Message,
  support: RequestMediaSupport,
): Message {
  if (support.image && support.video) return message;
  if (message.role !== 'user' && message.role !== 'toolResult') return message;
  if (typeof message.content === 'string') return message;
  const isTool = message.role === 'toolResult';
  let changed = false;
  const content: Array<TextContent | ImageContent> = [];
  for (const block of message.content) {
    const placeholder = unsupportedPlaceholder(block, support, isTool);
    if (placeholder === undefined) {
      content.push(block);
      continue;
    }
    changed = true;
    const previous = content.at(-1);
    if (previous?.type === 'text' && previous.text === placeholder) continue;
    content.push({ type: 'text', text: placeholder });
  }
  return changed ? { ...message, content } : message;
}

function unsupportedPlaceholder(
  block: TextContent | ImageContent,
  support: RequestMediaSupport,
  isTool: boolean,
): string | undefined {
  if (block.type !== 'image') return undefined;
  // Persisted history is not schema-checked; a block without a mimeType is
  // treated as a still image rather than crashing every later request.
  const mimeType: unknown = block.mimeType;
  const normalized = typeof mimeType === 'string' ? mimeType.toLowerCase() : '';
  if (normalized.startsWith('video/')) {
    if (support.video) return undefined;
    return isTool ? TOOL_VIDEO_PLACEHOLDER : USER_VIDEO_PLACEHOLDER;
  }
  // Audio and PDF also ride on `image` blocks but are not still images: the
  // outbound projection decides them by protocol before this filter runs.
  if (normalized.startsWith('audio/') || normalized === 'application/pdf') return undefined;
  if (support.image) return undefined;
  return isTool ? TOOL_IMAGE_PLACEHOLDER : USER_IMAGE_PLACEHOLDER;
}
