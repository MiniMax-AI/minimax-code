/**
 * Process-wide limits on decoding images into memory.
 *
 * Every image entering the conversation is decoded at full size before it is
 * scaled down (see request-media.ts). One decode holds roughly 20 bytes per
 * source pixel plus a fixed overhead, so a burst of large photos decoded at
 * once can take more memory than the process has: one message carrying 16
 * phone photos took a 4 GiB cloud-harness-server pod down. A host that runs
 * many sessions in one process configures limits here; without configuration
 * every limit is off and images decode as before.
 *
 * The gate reads only the image header. An image over the source byte, pixel
 * or memory budget limit is never decoded, and under memory pressure neither
 * is an image above 4 MP or of unknown size. Every other decode waits in
 * arrival order until both the decode count and the estimated memory of the
 * decodes in flight allow it, and is deferred once it waited past the queue
 * timeout. A decode of unknown size runs alone.
 */
import { parseImageDimensionsFromBytes } from '@mavis/shared/image-dimensions';

/** Why the gate did not decode an image. */
export const IMAGE_DECODE_DEFER_REASONS = [
  'image_too_large_to_decode',
  'image_decode_busy',
  'memory_pressure',
] as const;
export type ImageDecodeDeferReason = (typeof IMAGE_DECODE_DEFER_REASONS)[number];

/** Why an image was not decoded: deferred by the gate, or past the per-input image limit. */
export const IMAGE_DECODE_SKIP_REASONS = [
  ...IMAGE_DECODE_DEFER_REASONS,
  'max_images_per_input',
] as const;
export type ImageDecodeSkipReason = (typeof IMAGE_DECODE_SKIP_REASONS)[number];

export interface ImageDecodeDeferral {
  readonly deferred: ImageDecodeDeferReason;
  /** Source size from the image header, when it could be read. */
  readonly width?: number;
  readonly height?: number;
}

export interface ImageDecodeLease {
  /** Ends this decode; later calls do nothing. */
  release(): void;
}

export interface ImageDecodeLimits {
  /** Bytes of one source image; 0 is unlimited. */
  readonly maxSourceBytes: number;
  /** Pixels of one source image; 0 is unlimited. */
  readonly maxPixels: number;
  /** Decodes in flight; 0 is unlimited. */
  readonly maxConcurrent: number;
  /** Estimated memory of the decodes in flight, in bytes; 0 is unlimited. */
  readonly memoryBudgetBytes: number;
  /** How long a decode waits for its turn before it is deferred, in ms; 0 waits until its turn. */
  readonly queueTimeoutMs: number;
  /** Images of one user input decoded for inline media; 0 is unlimited. Read by the host. */
  readonly maxImagesPerInput: number;
  /** True while the process is short of memory; a probe that throws counts as false. */
  readonly underMemoryPressure?: () => boolean | Promise<boolean>;
}

export interface ImageDecodeStats {
  readonly active: number;
  readonly queued: number;
  /** Decodes started since the process started. */
  readonly decoded: number;
  /** Images not decoded since the process started, by reason. */
  readonly deferred: Readonly<Record<ImageDecodeSkipReason, number>>;
}

/** Decoded RGBA plus the scaled and re-encoded copies, per source pixel; measured ~25 B with Photon. */
const BYTES_PER_PIXEL = 20;
/** Image processor worker and its buffers, per decode. */
const DECODE_OVERHEAD_BYTES = 64 * 1024 * 1024;
/** A decode this small (a 2000x2000 image) costs little, so memory pressure does not defer it. */
const PRESSURE_EXEMPT_PIXELS = 4_000_000;

const UNLIMITED: ImageDecodeLimits = {
  maxSourceBytes: 0,
  maxPixels: 0,
  maxConcurrent: 0,
  memoryBudgetBytes: 0,
  queueTimeoutMs: 0,
  maxImagesPerInput: 0,
};

interface Waiter {
  readonly weight: number;
  readonly grant: () => void;
}

let limits: ImageDecodeLimits = UNLIMITED;
let active = 0;
let activeBytes = 0;
let decoded = 0;
const queue: Waiter[] = [];
const skipped = Object.fromEntries(
  IMAGE_DECODE_SKIP_REASONS.map((reason) => [reason, 0]),
) as Record<ImageDecodeSkipReason, number>;

/** Replaces every limit; an absent or invalid one is off, so `{}` turns the gate off. */
export function configureImageDecoding(next: Partial<ImageDecodeLimits>): void {
  limits = {
    maxSourceBytes: count(next.maxSourceBytes),
    maxPixels: count(next.maxPixels),
    maxConcurrent: count(next.maxConcurrent),
    memoryBudgetBytes: count(next.memoryBudgetBytes),
    queueTimeoutMs: count(next.queueTimeoutMs),
    maxImagesPerInput: count(next.maxImagesPerInput),
    ...(next.underMemoryPressure ? { underMemoryPressure: next.underMemoryPressure } : {}),
  };
  pump();
}

export function imageDecodeLimits(): ImageDecodeLimits {
  return limits;
}

export function imageDecodeStats(): ImageDecodeStats {
  return { active, queued: queue.length, decoded, deferred: { ...skipped } };
}

/** Counts images a host left undecoded on its own, e.g. past `maxImagesPerInput`. */
export function recordImageDecodeSkipped(reason: ImageDecodeSkipReason, images = 1): void {
  if (images > 0) skipped[reason] += images;
}

export function isImageDecodeDeferral(value: unknown): value is ImageDecodeDeferral {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly deferred?: unknown }).deferred === 'string'
  );
}

/**
 * Waits for a turn to decode `bytes`; the caller must release the lease once
 * the decoded image is gone. A deferral means the image must not be decoded now.
 */
export async function acquireImageDecode(
  bytes: Uint8Array,
): Promise<ImageDecodeLease | ImageDecodeDeferral> {
  const current = limits;
  const size = parseImageDimensionsFromBytes(bytes);
  const pixels = size ? size.width * size.height : undefined;
  const budget = current.memoryBudgetBytes;
  const weight = pixels === undefined ? budget : pixels * BYTES_PER_PIXEL + DECODE_OVERHEAD_BYTES;
  if (
    (current.maxSourceBytes > 0 && bytes.byteLength > current.maxSourceBytes) ||
    (pixels !== undefined && current.maxPixels > 0 && pixels > current.maxPixels) ||
    (pixels !== undefined && budget > 0 && weight > budget)
  ) {
    return defer('image_too_large_to_decode', size);
  }
  const probe = current.underMemoryPressure;
  if (
    probe &&
    (pixels === undefined || pixels > PRESSURE_EXEMPT_PIXELS) &&
    (await pressured(probe))
  ) {
    return defer('memory_pressure', size);
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter: Waiter = {
      weight,
      grant: () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(start(weight));
      },
    };
    queue.push(waiter);
    pump();
    if (!queue.includes(waiter) || current.queueTimeoutMs <= 0) return;
    timer = setTimeout(() => {
      const index = queue.indexOf(waiter);
      if (index < 0) return;
      queue.splice(index, 1);
      resolve(defer('image_decode_busy', size));
      pump();
    }, current.queueTimeoutMs);
    timer.unref?.();
  });
}

function start(weight: number): ImageDecodeLease {
  active += 1;
  activeBytes += weight;
  decoded += 1;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      active -= 1;
      activeBytes -= weight;
      pump();
    },
  };
}

/** Grants waiters in arrival order while the next one fits. */
function pump(): void {
  for (let next = queue[0]; next && admits(next.weight); next = queue[0]) {
    queue.shift();
    next.grant();
  }
}

function admits(weight: number): boolean {
  if (active === 0) return true;
  const { maxConcurrent, memoryBudgetBytes } = limits;
  return (
    (maxConcurrent <= 0 || active < maxConcurrent) &&
    (memoryBudgetBytes <= 0 || activeBytes + weight <= memoryBudgetBytes)
  );
}

function defer(
  reason: ImageDecodeDeferReason,
  size: { readonly width: number; readonly height: number } | undefined,
): ImageDecodeDeferral {
  skipped[reason] += 1;
  return size ? { deferred: reason, width: size.width, height: size.height } : { deferred: reason };
}

async function pressured(probe: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return (await probe()) === true;
  } catch {
    return false;
  }
}

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
