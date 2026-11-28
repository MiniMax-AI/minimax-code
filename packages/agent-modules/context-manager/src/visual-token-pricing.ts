import { Buffer } from 'node:buffer';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { PiBeforeLlmCallHookInput } from '@mavis/agent-core/pi-turn-runner';
import { parseImageDimensionsFromBytes } from '@mavis/shared/image-dimensions';

import { createDefaultTokenEstimator } from './token-estimator.js';

type LocalContextMessage = PiBeforeLlmCallHookInput['messages'][number];
type MediaDetail = 'low' | 'default' | 'high';

interface ImageDimensions {
  width: number;
  height: number;
}

export interface ImageTokenEstimateOptions {
  model?: { id?: string; name?: string; provider?: string };
}

/**
 * Vision token estimation, dimension-based.
 *
 * Visual tokens are a function of the image's (resized) pixel dimensions,
 * not its file size — a PNG screenshot and a JPEG photo of the same
 * dimensions can differ 10x in bytes but cost the same tokens. So we parse
 * width/height from the image header inside the base64 data, simulate the
 * provider-side proportional resize, and count 28px patches.
 *
 * The default path uses a single conservative tier (the high-res one:
 * maxEdge=2576, maxTokens=4784) instead of a broad per-model tier table.
 * minimax-M is the one explicit exception because its media-token helper is
 * known locally. Under-estimation is the dangerous direction
 * (context-overflow retry loop), so fallbacks stay conservative.
 *
 * This module is the single owner of that arithmetic. The compaction trigger,
 * checkpoint candidate selection, the context-usage donut and the dynamic
 * output budget all import it; a second copy is exactly how those callers
 * drifted apart before.
 */
const MAX_IMAGE_EDGE = 2_576;
const MAX_IMAGE_TOKENS = 4_784;
const IMAGE_PATCH_SIZE = 28;
const MAX_MEDIA_DIMENSION = 1_000_000;
const MAX_BINARY_SEARCH_ITERATIONS = 64;
const MINIMAX_M_MIN_SHORT_SIDE = 112;
const MINIMAX_M_FACTOR = 28;
const MINIMAX_M_IMAGE_LONG_SIDE: Record<MediaDetail, number> = {
  low: 672,
  default: 2_016,
  high: 3_584,
};
const MINIMAX_M_VIDEO_LONG_SIDE: Record<MediaDetail, number> = {
  low: 504,
  default: 672,
  high: 1_288,
};

/**
 * Default fallback when the header cannot be parsed (unknown format,
 * truncated data, or no dimensions). minimax-M uses its own per-detail
 * fallback because image/video limits differ there.
 * @internal Exported only for focused tests.
 */
export const FALLBACK_IMAGE_TOKENS = MAX_IMAGE_TOKENS;

/**
 * Only base64-decode a bounded prefix for header sniffing. PNG/GIF/WebP
 * dimensions live in the first ~32 bytes; JPEG's SOF marker can sit after
 * a large EXIF/APPn block, so allow up to ~96KB of decoded prefix before
 * giving up. Never decode the full payload (images can be many MB).
 */
const HEADER_SNIFF_BASE64_CHARS = 131_072;

/**
 * Only the fields {@link estimateImageBlockTokens} actually reads. Typing the parameter to
 * the full `Model<Api>` would make callers cast a model they never had, and typing it wider
 * would let a caller pass something the pricer silently ignores.
 */
export type VisualPricingModel = ImageTokenEstimateOptions['model'];

/**
 * The estimator charges the stand-in only in the roles whose content it walks for visual
 * blocks (see `estimateMessage`): user, toolResult and custom. An assistant message has no
 * visual branch at all, so subtracting the stand-in there would credit tokens that were
 * never charged and let the count drift below the request the Provider will actually see.
 */
const VISUAL_CHARGING_ROLES = new Set<unknown>(['user', 'toolResult', 'custom']);

export function messagesContainImageData(messages: readonly LocalContextMessage[]): boolean {
  for (const message of messages) {
    const content = 'content' in message ? message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const type: unknown = block.type;
      if (type === 'image' || type === 'video') return true;
    }
  }
  return false;
}

/**
 * The one message-counting path for everything that has to agree on how much a
 * request costs: the compaction trigger, checkpoint candidate selection, the
 * context-usage donut and the dynamic output budget.
 *
 * The shared estimator charges every visual block a flat 4_800-token stand-in, while the
 * context-usage donut prices images by their real dimensions. On a 640x480 screenshot the
 * two disagree by up to 11.59x, so any decision that used the flat value while the donut
 * used the dimensioned one was deciding on a different request than the one the user was
 * shown.
 *
 * Both the automatic trigger and checkpoint candidate selection go through here. Keeping a
 * second copy of this arithmetic is exactly how the two drifted apart, so there is no local
 * variant to re-introduce.
 */
export function countMessagesWithVisualPricing(
  messages: readonly AgentMessage[],
  model: VisualPricingModel,
): number {
  const estimator = createDefaultTokenEstimator();
  let total = estimator.estimateMessages([...messages]);
  const standIn = estimator.estimateVisualTokens();
  for (const message of messages) {
    if (!VISUAL_CHARGING_ROLES.has((message as { role?: unknown }).role)) continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const type = (block as { type?: unknown }).type;
      if (type !== 'image' && type !== 'video') continue;
      total += estimateImageBlockTokens(block as Record<string, unknown>, { model }) - standIn;
    }
  }
  return total;
}

/**
 * Estimate visual tokens for one image (or video) block. Parses dimensions
 * from the base64 header and simulates the provider resize; falls back to
 * {@link FALLBACK_IMAGE_TOKENS} when the data is missing or unparseable.
 */
export function estimateImageBlockTokens(
  block: Record<string, unknown>,
  options: ImageTokenEstimateOptions = {},
): number {
  const isVideo = isVideoBlock(block);
  const dimensions =
    readDimensionsFromBlock(block) ?? readDimensionsFromBase64Block(block, isVideo);
  if (isMiniMaxMModel(options.model)) {
    const detail = readMediaDetail(block);
    if (!dimensions) return minimaxMFallbackTokens(detail, isVideo);
    return estimateMiniMaxMVisualTokensForDimensions({
      height: dimensions.height,
      width: dimensions.width,
      detail,
      isVideo,
      maxLongSidePixel: readMaxLongSidePixel(block),
    });
  }
  if (!dimensions) return FALLBACK_IMAGE_TOKENS;
  return estimateVisualTokensForDimensions(dimensions.width, dimensions.height);
}

/**
 * Replicates the provider resize helper: binary-search the largest
 * proportional scale whose resized dimensions satisfy both the edge cap
 * and the visual-token cap, then count 28px patches on the result.
 * @internal Exported only for focused tests.
 */
export function estimateVisualTokensForDimensions(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return FALLBACK_IMAGE_TOKENS;
  }
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (fitsWithinCaps(w, h)) return visualTokensAt(w, h);

  const longerEdge = Math.max(w, h);
  let lo = 1;
  let hi = longerEdge;
  let bestW = 1;
  let bestH = 1;
  // visualTokensAt is monotone non-decreasing in the scaled edge, so binary
  // search over the target longer-edge length is valid.
  for (let iterations = 0; lo <= hi && iterations < MAX_BINARY_SEARCH_ITERATIONS; iterations += 1) {
    const mid = Math.floor((lo + hi) / 2);
    const scale = mid / longerEdge;
    const scaledW = Math.max(1, Math.floor(w * scale));
    const scaledH = Math.max(1, Math.floor(h * scale));
    if (fitsWithinCaps(scaledW, scaledH)) {
      bestW = scaledW;
      bestH = scaledH;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return visualTokensAt(bestW, bestH);
}

/**
 * minimax-M helper mirrors the provider formula, whose public signature uses
 * (H, W, detail, is_video, max_long_side_pixel), so height intentionally comes
 * before width here.
 * @internal Exported only for focused tests.
 */
export function estimateMiniMaxMVisualTokensForDimensions(input: {
  height: number;
  width: number;
  detail?: MediaDetail;
  isVideo?: boolean;
  maxLongSidePixel?: number;
}): number {
  const { height, width, detail = 'default', isVideo = false, maxLongSidePixel } = input;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return minimaxMFallbackTokens(detail, isVideo);
  }
  const h = Math.floor(height);
  const w = Math.floor(width);
  const limits = isVideo ? MINIMAX_M_VIDEO_LONG_SIDE : MINIMAX_M_IMAGE_LONG_SIDE;
  const longSideLimit = maxLongSidePixel ?? limits[detail];
  let beta: number;
  if (Math.max(h, w) > longSideLimit) {
    beta = longSideLimit / Math.max(h, w);
  } else if (Math.min(h, w) < MINIMAX_M_MIN_SHORT_SIDE) {
    beta = MINIMAX_M_MIN_SHORT_SIDE / Math.min(h, w);
  } else {
    beta = 1;
  }
  return (
    ceilScaledPatches(h, beta, MINIMAX_M_FACTOR) * ceilScaledPatches(w, beta, MINIMAX_M_FACTOR)
  );
}

/**
 * Parse width/height from a base64 image payload (PNG/JPEG/GIF/WebP).
 * @internal Exported only for focused tests.
 */
export function parseImageDimensionsFromBase64(data: string): ImageDimensions | undefined {
  let b64 = data;
  // Tolerate data URLs ("data:image/png;base64,....").
  const commaIndex = b64.indexOf(',');
  if (b64.startsWith('data:') && commaIndex !== -1) b64 = b64.slice(commaIndex + 1);
  b64 = b64.slice(0, HEADER_SNIFF_BASE64_CHARS);
  b64 = b64.slice(0, b64.length - (b64.length % 4));
  if (b64.length === 0) return undefined;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch {
    return undefined;
  }
  if (buffer.length < 4) return undefined;
  return parseImageDimensionsFromBytes(buffer);
}

function visualTokensAt(width: number, height: number): number {
  return Math.ceil(width / IMAGE_PATCH_SIZE) * Math.ceil(height / IMAGE_PATCH_SIZE);
}

function ceilScaledPatches(value: number, scale: number, factor: number): number {
  // Match the intended math.ceil(value * beta / factor) semantics without
  // letting JS floating point noise turn exact integers into N + epsilon.
  return Math.ceil((value * scale) / factor - 1e-9);
}

function fitsWithinCaps(width: number, height: number): boolean {
  return (
    width <= MAX_IMAGE_EDGE &&
    height <= MAX_IMAGE_EDGE &&
    visualTokensAt(width, height) <= MAX_IMAGE_TOKENS
  );
}

function readDimensionsFromBase64Block(
  block: Record<string, unknown>,
  isVideo: boolean,
): ImageDimensions | undefined {
  if (isVideo) return undefined;
  const data = resolveBase64Data(block);
  return data ? parseImageDimensionsFromBase64(data) : undefined;
}

function readDimensionsFromBlock(block: Record<string, unknown>): ImageDimensions | undefined {
  const width = readDimensionNumber(block.width ?? block.w);
  const height = readDimensionNumber(block.height ?? block.h);
  if (width !== undefined && height !== undefined) return normalizeDimensions(width, height);
  const source = block.source as Record<string, unknown> | undefined;
  if (!source) return undefined;
  const sourceWidth = readDimensionNumber(source.width ?? source.w);
  const sourceHeight = readDimensionNumber(source.height ?? source.h);
  return sourceWidth !== undefined && sourceHeight !== undefined
    ? normalizeDimensions(sourceWidth, sourceHeight)
    : undefined;
}

function readMediaDetail(block: Record<string, unknown>): MediaDetail {
  const source = block.source as Record<string, unknown> | undefined;
  const raw = block.detail ?? source?.detail;
  return raw === 'low' || raw === 'high' || raw === 'default' ? raw : 'default';
}

function readMaxLongSidePixel(block: Record<string, unknown>): number | undefined {
  const source = block.source as Record<string, unknown> | undefined;
  return (
    readPositiveNumber(block.max_long_side_pixel ?? block.maxLongSidePixel) ??
    readPositiveNumber(source?.max_long_side_pixel ?? source?.maxLongSidePixel)
  );
}

function isMiniMaxMModel(model: ImageTokenEstimateOptions['model']): boolean {
  const id = model?.id?.trim() ?? '';
  const name = model?.name?.trim() ?? '';
  return /^minimax-m(?:\b|[\d.-])/i.test(id) || /^minimax-m(?:\b|[\d.-])/i.test(name);
}

function minimaxMFallbackTokens(detail: MediaDetail, isVideo: boolean): number {
  const limits = isVideo ? MINIMAX_M_VIDEO_LONG_SIDE : MINIMAX_M_IMAGE_LONG_SIDE;
  const edge = limits[detail];
  return estimateMiniMaxMVisualTokensForDimensions({
    height: edge,
    width: edge,
    detail,
    isVideo,
    maxLongSidePixel: edge,
  });
}

function isVideoBlock(block: Record<string, unknown>): boolean {
  if (block.type === 'video') return true;
  const source = block.source as Record<string, unknown> | undefined;
  const mediaType = block.mimeType ?? block.media_type ?? source?.media_type ?? source?.mimeType;
  return typeof mediaType === 'string' && mediaType.toLowerCase().startsWith('video/');
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readDimensionNumber(value: unknown): number | undefined {
  const number = readPositiveNumber(value);
  return number !== undefined && number <= MAX_MEDIA_DIMENSION ? number : undefined;
}

function normalizeDimensions(width: number, height: number): ImageDimensions | undefined {
  if (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_MEDIA_DIMENSION &&
    height <= MAX_MEDIA_DIMENSION
  ) {
    return { width, height };
  }
  return undefined;
}

function resolveBase64Data(block: Record<string, unknown>): string | undefined {
  if (typeof block.data === 'string' && block.data.length > 0) return block.data;
  const source = block.source as Record<string, unknown> | undefined;
  if (source && typeof source.data === 'string' && source.data.length > 0) return source.data;
  return undefined;
}
