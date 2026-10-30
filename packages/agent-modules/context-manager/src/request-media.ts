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

// Request body budget assumed when the host declares none.
const DEFAULT_REQUEST_BODY_BYTES = 18 * 1024 * 1024;
// Text, tools and the system prompt need the rest of the request body.
const IMAGE_SHARE_OF_REQUEST_BODY = 2 / 3;
// A rejected request drops at least this many images, so recovery is not
// repeated one image at a time.
const RECOVERY_MIN_EVICTED_IMAGES = 4;
/** A rejected request keeps 1/divisor of its images and their bytes. */
export const DEFAULT_RECOVERY_DIVISOR = 2;

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
 * Image budget once `messages` exceed the automatic compaction trigger because
 * of their images: they may then use half of what the trigger leaves to the
 * rest of the context, keeping at least the newest one. Archiving the older
 * images is enough to fall back below the trigger, so the history is not
 * summarized away together with images the model has only just received.
 * `undefined` when the context is within the trigger, has fewer than two
 * images, or exceeds the trigger without them.
 */
export function tokenRequestMediaBudget(
  messages: readonly AgentMessage[],
  tokens: {
    readonly inputTokens: number;
    readonly triggerAt: number;
    /** Tokens the context estimate counts for one image. */
    readonly perImage: number;
  },
  budget: RequestMediaBudget,
): RequestMediaBudget | undefined {
  if (tokens.inputTokens <= tokens.triggerAt || tokens.perImage <= 0) return undefined;
  const images = listRequestImages(messages).length;
  if (images < 2) return undefined;
  const otherTokens = Math.max(0, tokens.inputTokens - images * tokens.perImage);
  if (otherTokens >= tokens.triggerAt) return undefined;
  const maxImages = Math.max(1, Math.floor((tokens.triggerAt - otherTokens) / tokens.perImage / 2));
  return maxImages < images ? { maxImages, maxImageBytes: budget.maxImageBytes } : undefined;
}

/**
 * Budget the repeated request must fall to after the provider rejected
 * `rejected`, a request that carried N images: the rejection shows the real
 * limit is below N, so keep 1/`divisor` of them and of their bytes, dropping at
 * least `RECOVERY_MIN_EVICTED_IMAGES` and never the newest. `undefined` when
 * the request had fewer than two images, so images are not what can be removed.
 * A `divisor` that is not a finite number above 1 falls back to the default.
 */
export function recoveryRequestMediaBudget(
  rejected: readonly AgentMessage[],
  budget: RequestMediaBudget,
  divisor: number = DEFAULT_RECOVERY_DIVISOR,
): RequestMediaBudget | undefined {
  const { kept } = selectRequestImages(rejected, budget);
  const sent = kept.length;
  if (sent < 2) return undefined;
  const share = Number.isFinite(divisor) && divisor > 1 ? divisor : DEFAULT_RECOVERY_DIVISOR;
  const evicted = Math.min(
    sent - 1,
    Math.max(sent - Math.floor(sent / share), RECOVERY_MIN_EVICTED_IMAGES),
  );
  const sentBytes = kept.reduce((total, image) => total + countedBytes(image), 0);
  return { maxImages: sent - evicted, maxImageBytes: Math.floor(sentBytes / share) };
}

/**
 * Images to archive out of history so the newest ones within `target` stay,
 * oldest first. Images `canArchive` rejects stay in history (and in the count).
 */
export function selectImagesToArchive(
  messages: readonly AgentMessage[],
  target: RequestMediaBudget,
  canArchive: (image: RequestImage) => boolean,
): RequestImage[] {
  const images = listRequestImages(messages);
  const kept = new Set<string>();
  let keptBytes = 0;
  for (let index = images.length - 1; index >= 0; index -= 1) {
    const image = images[index]!;
    const bytes = countedBytes(image);
    if (bytes > PROVIDER_IMAGE_MAX_BASE64_BYTES) continue;
    if (
      kept.size > 0 &&
      (kept.size + 1 > target.maxImages || keptBytes + bytes > target.maxImageBytes)
    ) {
      break;
    }
    kept.add(image.key);
    keptBytes += bytes;
  }
  return images.filter((image) => !kept.has(image.key) && canArchive(image));
}

/**
 * The request copy holding only the newest images within `target`, whoever
 * sent them; canonical history is untouched.
 */
export function fitRequestMedia<T extends AgentMessage>(
  messages: readonly T[],
  target: RequestMediaBudget,
): { readonly messages: T[]; readonly omittedCount: number } {
  const dropped = new Set(
    selectImagesToArchive(messages, target, () => true).map(({ key }) => key),
  );
  if (dropped.size === 0) return { messages: [...messages], omittedCount: 0 };
  return {
    messages: replaceRequestImages(messages, (image) =>
      dropped.has(image.key) ? omittedRequestImageText(image.path) : undefined,
    ),
    omittedCount: dropped.size,
  };
}

/**
 * A provider rejection that fewer request images can fix: a context overflow
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
 * Only tool result images may leave history: user attachments are the user's
 * own payload and stay, limited per request only.
 */
export function isArchivableRequestImage(image: RequestImage): boolean {
  return image.role === 'toolResult';
}

/**
 * `failed` is a media rejection and the next request can carry half of the
 * images, so dropping the response and repeating the request may succeed.
 */
export function canRecoverByDroppingImages(
  failed: AssistantMessage,
  messages: readonly AgentMessage[],
): boolean {
  return isRequestMediaRejection(failed) && listRequestImages(messages).length >= 2;
}

/** Placeholder for an image a request leaves out; history still has it. */
export function omittedRequestImageText(path: string | undefined): string {
  const scope = 'to keep this request within its image budget';
  return path
    ? `[Earlier image omitted ${scope}. Original file: ${path}]`
    : `[Earlier image omitted ${scope}. Capture it again if the current visual state is needed.]`;
}

/** Receipt for an image archived out of history. */
export function archivedImageText(path: string | undefined): string {
  const scope = 'to keep requests within their size limit';
  return path
    ? `[Earlier image archived ${scope}. File: ${path}]`
    : `[Earlier image removed ${scope}. Capture it again if the current visual state is needed.]`;
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

/** Default `requestMedia.image`: the limits Pi's Read tool applies on its own. */
export const DEFAULT_REQUEST_IMAGE_ENCODING: Readonly<RequestImageEncoding> = {
  maxWidth: 2_000,
  maxHeight: 2_000,
  maxBase64Bytes: 4.5 * 1024 * 1024,
};

/**
 * Re-encode an image entering the conversation so every provider the session
 * may switch to accepts it: within `encoding.maxWidth` × `encoding.maxHeight`
 * and `encoding.maxBase64Bytes` of base64 data.
 *
 * Returns `undefined` when the caller should keep the original: the image
 * already fits, is not an image, or cannot be decoded or shrunk. Dropping the
 * image costs more than a provider that rejects it.
 */
export async function encodeRequestImage(
  bytes: Uint8Array,
  mimeType: string,
  encoding: RequestImageEncoding = DEFAULT_REQUEST_IMAGE_ENCODING,
): Promise<EncodedRequestImage | undefined> {
  return (await encodeImage(bytes, mimeType, encoding))?.image;
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
): Promise<EncodedRequestImageDetails | undefined> {
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
 * when the image processor cannot load, as the Read tool did.
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
      const encodedImage = await encodeImageOrUnavailable(
        Buffer.from(data, 'base64'),
        mimeType,
        encoding,
      );
      if (encodedImage === PROCESSOR_UNAVAILABLE) {
        changed = true;
        return [{ type: 'text', text: IMAGE_PROCESSOR_UNAVAILABLE_NOTE } as unknown as T];
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
): Promise<EncodedRequestImageDetails | undefined> {
  const encoded = await encodeImageOrUnavailable(bytes, mimeType, encoding);
  return encoded === PROCESSOR_UNAVAILABLE ? undefined : encoded;
}

const PROCESSOR_UNAVAILABLE = Symbol('image processor unavailable');

async function encodeImageOrUnavailable(
  bytes: Uint8Array,
  mimeType: string,
  encoding: RequestImageEncoding,
): Promise<EncodedRequestImageDetails | typeof PROCESSOR_UNAVAILABLE | undefined> {
  if (!mimeType.toLowerCase().startsWith('image/')) return undefined;
  try {
    const resized = await resizeImage(bytes, mimeType, {
      maxWidth: encoding.maxWidth,
      maxHeight: encoding.maxHeight,
      maxBytes: encoding.maxBase64Bytes,
    });
    if (!resized?.wasResized) return undefined;
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
