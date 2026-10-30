import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  isContextOverflow,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import {
  formatDimensionNote,
  ImageProcessorUnavailableError,
  resizeImage,
} from '@earendil-works/pi-coding-agent/image-resize';
import {
  isLLMImageLimitMessage,
  isLLMRequestTooLargeMessage,
  listRequestImages,
  replaceRequestImages,
  resolveMaxImagesPerRequest,
  type RequestImage,
} from '@mavis/agent-core/pi-turn-runner';

/** Strictest known per-image provider limit, in base64 bytes. */
export const PROVIDER_IMAGE_MAX_BASE64_BYTES = 5 * 1024 * 1024;

// Request body budget assumed when the host declares none; matches the
// client default for endpoints it does not recognize.
const DEFAULT_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
// Text, tools and the system prompt need the rest of the request body.
const IMAGE_SHARE_OF_REQUEST_BODY = 2 / 3;

/** Images one provider request may carry. */
export interface RequestMediaBudget {
  readonly maxImages: number;
  /** Base64 bytes of all images; video is counted by number only. */
  readonly maxImageBytes: number;
}

/**
 * Budget from the model's declared image limit and the host's request body
 * limit, so each API is controlled by its own model configuration.
 */
export function resolveRequestMediaBudget(input: {
  readonly model: Model<Api>;
  readonly maxSerializedInputBytes?: number;
}): RequestMediaBudget {
  const bodyBytes = input.maxSerializedInputBytes ?? DEFAULT_REQUEST_BODY_BYTES;
  return {
    maxImages: resolveMaxImagesPerRequest(input.model),
    maxImageBytes: Math.floor(bodyBytes * IMAGE_SHARE_OF_REQUEST_BODY),
  };
}

/** Low watermark: half of each limit, keeping at least one image. */
export function halfRequestMediaBudget(budget: RequestMediaBudget): RequestMediaBudget {
  return {
    maxImages: Math.max(1, Math.floor(budget.maxImages / 2)),
    maxImageBytes: Math.floor(budget.maxImageBytes / 2),
  };
}

/**
 * Images this request sends and the ones it replaces with a placeholder.
 *
 * Images are replayed in history order. Once the kept images exceed either
 * limit of `budget`, the oldest are dropped until both fall to half of it; the
 * newest image is always kept unless it alone exceeds the per-image limit.
 * Replay depends only on the messages, so a longer history drops a superset of
 * what a shorter one dropped and the request prefix stays byte-identical
 * between drops, which keeps the provider prompt cache.
 */
export function selectRequestImages(
  messages: readonly AgentMessage[],
  budget: RequestMediaBudget,
): { readonly kept: RequestImage[]; readonly dropped: RequestImage[] } {
  const low = halfRequestMediaBudget(budget);
  const kept: RequestImage[] = [];
  const dropped: RequestImage[] = [];
  let keptBytes = 0;
  for (const image of listRequestImages(messages)) {
    const bytes = countedBytes(image);
    if (bytes > PROVIDER_IMAGE_MAX_BASE64_BYTES) {
      dropped.push(image);
      continue;
    }
    kept.push(image);
    keptBytes += bytes;
    if (kept.length <= budget.maxImages && keptBytes <= budget.maxImageBytes) continue;
    while (kept.length > 1 && (kept.length > low.maxImages || keptBytes > low.maxImageBytes)) {
      const oldest = kept.shift()!;
      keptBytes -= countedBytes(oldest);
      dropped.push(oldest);
    }
  }
  return { kept, dropped };
}

/** The request copy `selectRequestImages` allows; canonical history is untouched. */
export function boundRequestMedia<T extends AgentMessage>(
  messages: readonly T[],
  budget: RequestMediaBudget,
): { readonly messages: T[]; readonly omittedCount: number } {
  const dropped = new Set(selectRequestImages(messages, budget).dropped.map((image) => image.key));
  if (dropped.size === 0) return { messages: [...messages], omittedCount: 0 };
  return {
    messages: replaceRequestImages(messages, (image) =>
      dropped.has(image.key) ? omittedRequestImageText(image.path) : undefined,
    ),
    omittedCount: dropped.size,
  };
}

/**
 * A provider rejection that compacting the history can fix: a context overflow
 * by tokens or request bytes, or an image count or size limit. The retry layer
 * reads the same classifier, so such a rejection is not resent unchanged first.
 */
export function isRequestMediaRejection(message: AssistantMessage): boolean {
  return (
    message.stopReason === 'error' &&
    (isContextOverflow(message) ||
      isLLMImageLimitMessage(message.errorMessage) ||
      isLLMRequestTooLargeMessage(message.errorMessage))
  );
}

/**
 * Thinking signatures of prefix-cached models are bound to the exact system
 * prompt, tools and history they were produced on. A compaction changes them
 * (its summary request has its own system prompt and no tools; an archive
 * rewrites earlier messages), so every thinking block (redacted ones included)
 * is removed while the other blocks of each turn stay. Messages without
 * thinking keep their identity.
 */
export function withoutThinking<T extends AgentMessage>(messages: readonly T[]): T[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    if (!message.content.some((block) => block.type === 'thinking')) return message;
    return { ...message, content: message.content.filter((block) => block.type !== 'thinking') };
  });
}

/** Placeholder for an image a request leaves out; history still has it. */
export function omittedRequestImageText(path: string | undefined): string {
  const scope = 'to keep this request within its image budget';
  return path
    ? `[Earlier image omitted ${scope}. Original file: ${path}]`
    : `[Earlier image omitted ${scope}. Capture it again if the current visual state is needed.]`;
}

/** Receipt for an image compaction moved out of history. */
export function archivedImageText(path: string | undefined): string {
  return path
    ? `[Earlier image removed by context compaction. File: ${path}]`
    : '[Earlier image removed by context compaction. Capture it again if the current visual state is needed.]';
}

/** Stands in for an image a checkpoint summary request does not carry. */
export function checkpointImageText(path: string | undefined): string {
  return path
    ? `[Image not sent to the summary request. File: ${path}]`
    : '[Image not sent to the summary request.]';
}

export interface EncodedRequestImage {
  readonly data: string;
  readonly mimeType: string;
}

/** Size every image entering the conversation is encoded down to. */
export interface RequestImageEncoding {
  /** Pixels; a wider image is scaled down, keeping its aspect ratio. */
  readonly maxWidth: number;
  /** Pixels; a taller image is scaled down, keeping its aspect ratio. */
  readonly maxHeight: number;
  /** Base64 bytes of one image; a larger one is re-encoded, then scaled down. */
  readonly maxBase64Bytes: number;
}

/** Default `requestMedia.image`. */
export const DEFAULT_REQUEST_IMAGE_ENCODING: Readonly<RequestImageEncoding> = {
  maxWidth: 2_000,
  maxHeight: 2_000,
  maxBase64Bytes: 3.5 * 1024 * 1024,
};

/**
 * Re-encode an image entering the conversation so every provider the session
 * may switch to accepts it: within `encoding.maxWidth` × `encoding.maxHeight`
 * and `encoding.maxBase64Bytes` of base64 data.
 *
 * Returns `undefined` when the caller should keep the original: the image
 * already fits, is not an image, or the image processor cannot load. Returns
 * `'undecodable'` when the image processor cannot decode the data: the caller
 * must not send it, because history replays it into every later request and
 * the provider rejects each one.
 */
export async function encodeRequestImage(
  bytes: Uint8Array,
  mimeType: string,
  encoding: RequestImageEncoding = DEFAULT_REQUEST_IMAGE_ENCODING,
): Promise<EncodedRequestImage | 'undecodable' | undefined> {
  const encoded = await encodeImage(bytes, mimeType, encoding);
  return encoded === 'undecodable' ? encoded : encoded?.image;
}

export interface EncodedRequestImageDetails {
  readonly image: EncodedRequestImage;
  readonly width: number;
  readonly height: number;
  /** Maps coordinates on a shrunk image back to the original; absent when the size is unchanged. */
  readonly dimensionNote?: string;
}

/** `encodeRequestImage` with the encoded size and its note on the original size. */
export async function encodeRequestImageDetails(
  bytes: Uint8Array,
  mimeType: string,
  encoding: RequestImageEncoding = DEFAULT_REQUEST_IMAGE_ENCODING,
): Promise<EncodedRequestImageDetails | 'undecodable' | undefined> {
  return encodeImage(bytes, mimeType, encoding);
}

/** The Read tool's note for an image over the limits while the image processor cannot load. */
const IMAGE_PROCESSOR_UNAVAILABLE_NOTE =
  '[Image omitted: image processing runtime is unavailable.]';

/**
 * `encodeRequestImage` over every base64 image block; `undefined` when none
 * changed. A shrunk image is followed by the Read tool's note on its original
 * size, so coordinates read off it can be mapped back to the original. An
 * image over the limits is replaced with `IMAGE_PROCESSOR_UNAVAILABLE_NOTE`
 * when the image processor cannot load, as the Read tool did, and an image it
 * cannot decode is replaced with a note, so its bytes never enter history.
 */
export async function encodeRequestImageBlocks<T extends { readonly type: string }>(
  blocks: readonly T[],
  encoding: RequestImageEncoding = DEFAULT_REQUEST_IMAGE_ENCODING,
): Promise<T[] | undefined> {
  let changed = false;
  const encoded = await Promise.all(
    blocks.map(async (block): Promise<T[]> => {
      const { data, mimeType } = block as { data?: unknown; mimeType?: unknown };
      if (block.type !== 'image' || typeof data !== 'string' || typeof mimeType !== 'string') {
        return [block];
      }
      const bytes = Buffer.from(data, 'base64');
      const encodedImage = await encodeImageOrUnavailable(bytes, mimeType, encoding);
      if (encodedImage === PROCESSOR_UNAVAILABLE) {
        changed = true;
        return [{ type: 'text', text: IMAGE_PROCESSOR_UNAVAILABLE_NOTE } as unknown as T];
      }
      if (encodedImage === 'undecodable') {
        changed = true;
        const text = `[Image omitted: the ${mimeType} data (${bytes.length} bytes) could not be decoded; it may be corrupt, truncated, or in an unsupported format.]`;
        return [{ type: 'text', text } as unknown as T];
      }
      if (!encodedImage) return [block];
      changed = true;
      const image = { ...block, ...encodedImage.image };
      return encodedImage.dimensionNote
        ? [image, { type: 'text', text: encodedImage.dimensionNote } as unknown as T]
        : [image];
    }),
  );
  return changed ? encoded.flat() : undefined;
}

async function encodeImage(
  bytes: Uint8Array,
  mimeType: string,
  encoding: RequestImageEncoding,
): Promise<EncodedRequestImageDetails | 'undecodable' | undefined> {
  const encoded = await encodeImageOrUnavailable(bytes, mimeType, encoding);
  return encoded === PROCESSOR_UNAVAILABLE ? undefined : encoded;
}

const PROCESSOR_UNAVAILABLE = Symbol('image processor unavailable');

async function encodeImageOrUnavailable(
  bytes: Uint8Array,
  mimeType: string,
  encoding: RequestImageEncoding,
): Promise<EncodedRequestImageDetails | 'undecodable' | typeof PROCESSOR_UNAVAILABLE | undefined> {
  if (!mimeType.toLowerCase().startsWith('image/')) return undefined;
  try {
    const resized = await resizeImage(bytes, mimeType, {
      maxWidth: encoding.maxWidth,
      maxHeight: encoding.maxHeight,
      maxBytes: encoding.maxBase64Bytes,
    });
    // Photon returns null when it cannot decode the data. It also does when
    // even a 1x1 encoding exceeds the byte limit, which takes a limit of ~100 B.
    if (!resized) return 'undecodable';
    if (!resized.wasResized) return undefined;
    const encoded = {
      image: { data: resized.data, mimeType: resized.mimeType },
      width: resized.width,
      height: resized.height,
    };
    const shrunk =
      resized.width !== resized.originalWidth || resized.height !== resized.originalHeight;
    const dimensionNote = shrunk ? formatDimensionNote(resized) : undefined;
    return dimensionNote ? { ...encoded, dimensionNote } : encoded;
  } catch (error) {
    return error instanceof ImageProcessorUnavailableError ? PROCESSOR_UNAVAILABLE : undefined;
  }
}

function countedBytes(image: RequestImage): number {
  return image.mimeType?.toLowerCase().startsWith('video/') ? 0 : image.base64Bytes;
}
