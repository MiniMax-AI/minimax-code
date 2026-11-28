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
  isLLMContextOverflowMessage,
  isLLMImageLimitMessage,
  isLLMRequestTooLargeMessage,
  listRequestImages,
  replaceRequestImages,
  resolveMaxImagesPerRequest,
  type RequestImage,
} from '@mavis/agent-core/pi-turn-runner';
import { type ProgrammaticImageEncoding, recordImageEncodedContent } from '@mavis/agent-core/tools';

import {
  acquireImageDecode,
  type ImageDecodeDeferral,
  isImageDecodeDeferral,
} from './image-decode-gate.js';

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
 * reads the same classifier, so such a rejection is not resent unchanged first;
 * the classifier's own overflow wording covers providers Pi's patterns miss.
 */
export function isRequestMediaRejection(message: AssistantMessage): boolean {
  return (
    message.stopReason === 'error' &&
    (isContextOverflow(message) ||
      isLLMContextOverflowMessage(message.errorMessage) ||
      isLLMImageLimitMessage(message.errorMessage) ||
      isLLMRequestTooLargeMessage(message.errorMessage))
  );
}

/**
 * Thinking signatures of prefix-bound models are tied to the exact system
 * prompt, tools and history they were produced on. The isolated summary request
 * has its own system prompt and no tools, so every thinking block (redacted
 * ones included) is removed from that request copy while the other blocks of
 * each turn stay. Messages without thinking keep their identity.
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
 * the provider rejects each one. Returns an `ImageDecodeDeferral` when the
 * process-wide decode limits (`configureImageDecoding`) keep the image from
 * being decoded now; it was not checked, so the caller must not send it either.
 */
export async function encodeRequestImage(
  bytes: Uint8Array,
  mimeType: string,
  encoding: RequestImageEncoding = DEFAULT_REQUEST_IMAGE_ENCODING,
): Promise<EncodedRequestImage | 'undecodable' | ImageDecodeDeferral | undefined> {
  const encoded = await encodeImage(bytes, mimeType, encoding);
  return encoded === 'undecodable' || isImageDecodeDeferral(encoded) ? encoded : encoded?.image;
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
): Promise<EncodedRequestImageDetails | 'undecodable' | ImageDecodeDeferral | undefined> {
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
 * An image the decode limits defer is replaced with a note too, naming a
 * smaller copy to read instead.
 *
 * The returned array is marked with what happened to each changed image
 * (recordImageEncodedContent), so PTC can report a native read's image as
 * resized or omitted instead of as rewritten by an unknown hook. Output with
 * an undecodable or deferred image is not marked: there is no image state to
 * report.
 */
export async function encodeRequestImageBlocks<T extends { readonly type: string }>(
  blocks: readonly T[],
  encoding: RequestImageEncoding = DEFAULT_REQUEST_IMAGE_ENCODING,
): Promise<T[] | undefined> {
  const encoded = await Promise.all(blocks.map((block) => encodeImageBlock(block, encoding)));
  if (!encoded.some(({ fact }) => fact !== undefined)) return undefined;
  const output = encoded.flatMap(({ blocks: next }) => next);
  const facts = encoded.flatMap(({ fact }) => (fact ? [fact] : []));
  if (!facts.some((fact) => typeof fact === 'string')) {
    recordImageEncodedContent(blocks, output, facts as ProgrammaticImageEncoding[]);
  }
  return output;
}

/** One block's replacement and what changed; no fact when it is kept as it was. */
async function encodeImageBlock<T extends { readonly type: string }>(
  block: T,
  encoding: RequestImageEncoding,
): Promise<{
  readonly blocks: T[];
  readonly fact?: ProgrammaticImageEncoding | 'undecodable' | 'deferred';
}> {
  const { data, mimeType } = block as { data?: unknown; mimeType?: unknown };
  if (block.type !== 'image' || typeof data !== 'string' || typeof mimeType !== 'string') {
    return { blocks: [block] };
  }
  const bytes = Buffer.from(data, 'base64');
  const encodedImage = await encodeImageOrUnavailable(bytes, mimeType, encoding);
  if (encodedImage === PROCESSOR_UNAVAILABLE) {
    return {
      blocks: [{ type: 'text', text: IMAGE_PROCESSOR_UNAVAILABLE_NOTE } as unknown as T],
      fact: { mimeType, omittedReason: 'processor_unavailable' },
    };
  }
  if (encodedImage === 'undecodable') {
    const text = `[Image omitted: the ${mimeType} data (${bytes.length} bytes) could not be decoded; it may be corrupt, truncated, or in an unsupported format.]`;
    return { blocks: [{ type: 'text', text } as unknown as T], fact: 'undecodable' };
  }
  if (isImageDecodeDeferral(encodedImage)) {
    const text = deferredImageNote(mimeType, bytes.length, encodedImage, encoding);
    return { blocks: [{ type: 'text', text } as unknown as T], fact: 'deferred' };
  }
  if (!encodedImage) return { blocks: [block] };
  const image = { ...block, ...encodedImage.image };
  const fact = {
    mimeType: encodedImage.image.mimeType,
    width: encodedImage.width,
    height: encodedImage.height,
    originalWidth: encodedImage.originalWidth,
    originalHeight: encodedImage.originalHeight,
  };
  return encodedImage.dimensionNote
    ? { blocks: [image, { type: 'text', text: encodedImage.dimensionNote } as unknown as T], fact }
    : { blocks: [image], fact };
}

/** Points the agent at a copy small enough to decode, or at a later read. */
function deferredImageNote(
  mimeType: string,
  byteLength: number,
  deferral: ImageDecodeDeferral,
  encoding: RequestImageEncoding,
): string {
  const smaller = `save a copy scaled down to at most ${encoding.maxWidth}x${encoding.maxHeight} px inside the workspace and read that copy`;
  if (deferral.deferred === 'image_too_large_to_decode') {
    const size =
      deferral.width !== undefined && deferral.height !== undefined
        ? `${deferral.width}x${deferral.height} px`
        : `${byteLength} bytes`;
    return `[Image omitted: the ${mimeType} image (${size}) is too large for the server to decode. To view it, ${smaller}.]`;
  }
  return `[Image omitted: the server is too busy to decode this ${mimeType} image right now. Read it again later, or ${smaller}.]`;
}

/** The encoder's result with the original size, which only the block encoder reports. */
interface EncodedImage extends EncodedRequestImageDetails {
  readonly originalWidth: number;
  readonly originalHeight: number;
}

async function encodeImage(
  bytes: Uint8Array,
  mimeType: string,
  encoding: RequestImageEncoding,
): Promise<EncodedRequestImageDetails | 'undecodable' | ImageDecodeDeferral | undefined> {
  const encoded = await encodeImageOrUnavailable(bytes, mimeType, encoding);
  if (encoded === PROCESSOR_UNAVAILABLE || encoded === undefined) return undefined;
  if (encoded === 'undecodable' || isImageDecodeDeferral(encoded)) return encoded;
  const { image, width, height, dimensionNote } = encoded;
  return { image, width, height, ...(dimensionNote ? { dimensionNote } : {}) };
}

const PROCESSOR_UNAVAILABLE = Symbol('image processor unavailable');

async function encodeImageOrUnavailable(
  bytes: Uint8Array,
  mimeType: string,
  encoding: RequestImageEncoding,
): Promise<
  EncodedImage | 'undecodable' | ImageDecodeDeferral | typeof PROCESSOR_UNAVAILABLE | undefined
> {
  if (!mimeType.toLowerCase().startsWith('image/')) return undefined;
  const lease = await acquireImageDecode(bytes);
  if (isImageDecodeDeferral(lease)) return lease;
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
      originalWidth: resized.originalWidth,
      originalHeight: resized.originalHeight,
    };
    const shrunk =
      resized.width !== resized.originalWidth || resized.height !== resized.originalHeight;
    const dimensionNote = shrunk ? formatDimensionNote(resized) : undefined;
    return dimensionNote ? { ...encoded, dimensionNote } : encoded;
  } catch (error) {
    return error instanceof ImageProcessorUnavailableError ? PROCESSOR_UNAVAILABLE : undefined;
  } finally {
    lease.release();
  }
}

function countedBytes(image: RequestImage): number {
  return image.mimeType?.toLowerCase().startsWith('video/') ? 0 : image.base64Bytes;
}
