import { createHash } from 'node:crypto';

import type { LocalBrowserScreenshotPreprocessor } from '@mavis/agent-tools/desktop';
import { encodeRequestImageDetails } from '@mavis/context-manager';
import { parseImageDimensionsFromBytes } from '@mavis/shared/image-dimensions';

import type { BrowserScreenshotImageEncoding, BrowserUseServiceOptions } from './contracts.js';

type BrowserGeneratedAssetRegistrar = BrowserUseServiceOptions['registerGeneratedAsset'];

const MAX_POST_ACTION_VISUAL_DEDUP_SESSIONS = 128;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Post-action images are supplemental evidence, so they stay below `requestMedia.image`. */
const POST_ACTION_SCREENSHOT_CEILING = {
  maxWidth: 1_280,
  maxHeight: 1_280,
  maxBase64Bytes: 1024 * 1024,
} as const satisfies BrowserScreenshotImageEncoding;

export interface BrowserScreenshotPreprocessor extends LocalBrowserScreenshotPreprocessor {
  clearSession(sessionId: string): void;
  clear(): void;
}

/**
 * Explicit screenshots keep the captured image: the host encodes every tool
 * result image to `requestMedia.image` once, adding the only size note.
 * Post-action screenshots are encoded here to the stricter of that config and
 * `POST_ACTION_SCREENSHOT_CEILING`, which the host encoder then leaves as is.
 */
export function createBrowserScreenshotPreprocessor(options: {
  readonly getImageEncoding: () => BrowserScreenshotImageEncoding;
  readonly registerGeneratedAsset: BrowserGeneratedAssetRegistrar;
}): BrowserScreenshotPreprocessor {
  const lastPostActionFingerprintBySession = new Map<string, string>();
  const preprocess: LocalBrowserScreenshotPreprocessor = async (
    result,
    ctx,
    signal,
    preprocessOptions,
  ) => {
    throwIfAborted(signal);
    const screenshot = readScreenshot(result);
    if (!screenshot) return result;

    if (preprocessOptions?.purpose === 'post-action') {
      const prepared = await prepareScreenshot(
        screenshot,
        postActionEncoding(options.getImageEncoding()),
      );
      throwIfAborted(signal);
      return preprocessPostActionScreenshot(
        prepared,
        ctx.sessionId,
        lastPostActionFingerprintBySession,
      );
    }
    const prepared = await prepareScreenshot(screenshot);
    throwIfAborted(signal);
    return registerExplicitScreenshot(prepared, ctx, options.registerGeneratedAsset, signal);
  };
  return Object.assign(preprocess, {
    clearSession: (sessionId: string) => lastPostActionFingerprintBySession.delete(sessionId),
    clear: () => lastPostActionFingerprintBySession.clear(),
  });
}

interface PreparedScreenshot {
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly result: Readonly<Record<string, unknown>>;
}

function readScreenshot(result: unknown): Record<string, unknown> | undefined {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined;
  const screenshot = result as Record<string, unknown>;
  return typeof screenshot.data === 'string' && screenshot.data.length > 0 ? screenshot : undefined;
}

function postActionEncoding(
  configured: BrowserScreenshotImageEncoding,
): BrowserScreenshotImageEncoding {
  return {
    maxWidth: Math.min(configured.maxWidth, POST_ACTION_SCREENSHOT_CEILING.maxWidth),
    maxHeight: Math.min(configured.maxHeight, POST_ACTION_SCREENSHOT_CEILING.maxHeight),
    maxBase64Bytes: Math.min(
      configured.maxBase64Bytes,
      POST_ACTION_SCREENSHOT_CEILING.maxBase64Bytes,
    ),
  };
}

async function prepareScreenshot(
  screenshot: Record<string, unknown> & { readonly data?: unknown },
  encoding?: BrowserScreenshotImageEncoding,
): Promise<PreparedScreenshot> {
  const captured = Buffer.from(screenshot.data as string, 'base64');
  const capturedMime = screenshotMimeType(captured);
  if (!capturedMime) {
    throw new Error(
      'BROWSER_SCREENSHOT_PREPROCESS_FAILED: Browser screenshot is not a PNG, JPEG, or WebP image',
    );
  }
  const encoded = encoding
    ? await encodeRequestImageDetails(captured, capturedMime, encoding)
    : undefined;
  const bytes = encoded ? Buffer.from(encoded.image.data, 'base64') : captured;
  const mimeType = encoded?.image.mimeType ?? capturedMime;
  const size = encoded ?? parseImageDimensionsFromBytes(captured);
  return {
    bytes,
    mimeType,
    result: {
      ...screenshot,
      format: mimeType.slice('image/'.length),
      ...(size ? { width: size.width, height: size.height } : {}),
      bytes: bytes.byteLength,
      data: bytes.toString('base64'),
      ...(encoded?.dimensionNote ? { dimensionNote: encoded.dimensionNote } : {}),
      ...(encoding ? { visualBudget: encoding } : {}),
    },
  };
}

function screenshotMimeType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

function preprocessPostActionScreenshot(
  prepared: PreparedScreenshot,
  sessionId: string,
  fingerprints: Map<string, string>,
): Readonly<Record<string, unknown>> {
  const fingerprint = createHash('sha256').update(prepared.bytes).digest('hex');
  if (fingerprints.get(sessionId) === fingerprint) {
    const metadata: Record<string, unknown> = { ...prepared.result };
    delete metadata.data;
    return { ...metadata, deduplicated: true };
  }
  fingerprints.set(sessionId, fingerprint);
  trimOldestEntries(fingerprints);
  return prepared.result;
}

async function registerExplicitScreenshot(
  prepared: PreparedScreenshot,
  ctx: { readonly sessionId: string; readonly turnId: string },
  registerGeneratedAsset: BrowserGeneratedAssetRegistrar,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    const asset = await registerGeneratedAsset({
      fileName: `browser-screenshot.${screenshotExtension(prepared.mimeType)}`,
      mimeType: prepared.mimeType,
      kind: 'image',
      sourceKind: 'generated',
      dataUrl: `data:${prepared.mimeType};base64,${prepared.bytes.toString('base64')}`,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      generatedBy: 'browser_screenshot',
    });
    throwIfAborted(signal);
    return {
      ...prepared.result,
      userDelivery: {
        available: true,
        requiresExplicitUserRequest: true,
        assetId: asset.assetId,
        filePath: asset.absolutePath,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        bytes: asset.bytes,
        mediaMarkup: `<media src="${escapeMediaAttribute(asset.absolutePath)}" caption="Browser screenshot" />`,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...prepared.result,
      userDelivery: {
        available: false,
        requiresExplicitUserRequest: true,
        code: 'SCREENSHOT_ASSET_WRITE_FAILED',
      },
    };
  }
}

function screenshotExtension(mimeType: string): string {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
}

function trimOldestEntries(values: Map<string, string>): void {
  while (values.size > MAX_POST_ACTION_VISUAL_DEDUP_SESSIONS) {
    const oldest = values.keys().next().value;
    if (typeof oldest !== 'string') return;
    values.delete(oldest);
  }
}

function escapeMediaAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}
