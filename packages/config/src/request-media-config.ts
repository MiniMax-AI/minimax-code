/** Every image entering the conversation is encoded to fit these limits. */
export interface RequestImageSettings {
  /** Pixels; a wider image is scaled down, keeping its aspect ratio. */
  readonly max_width: number;
  /** Pixels; a taller image is scaled down, keeping its aspect ratio. */
  readonly max_height: number;
  /** Base64 bytes of one image; a larger one is re-encoded, then scaled down. */
  readonly max_base64_bytes: number;
}

export interface RequestMediaSettings {
  /**
   * A request the provider rejected for its size or images is repeated with
   * 1/recoveryDivisor of its images and image bytes. Must be above 1.
   */
  readonly recoveryDivisor: number;
  readonly image: RequestImageSettings;
}

/** Strictest known per-image provider limit; a larger image is never sent. */
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

export const REQUEST_MEDIA_DEFAULTS: Readonly<RequestMediaSettings> = {
  recoveryDivisor: 2,
  image: { max_width: 2_000, max_height: 2_000, max_base64_bytes: 4.5 * 1024 * 1024 },
};

/** Resolves the user-facing `requestMedia` config.yaml block. */
export function parseRequestMediaConfig(raw: unknown): RequestMediaSettings {
  const value = isRecord(raw) ? raw : {};
  const divisor = value.recoveryDivisor;
  const image = isRecord(value.image) ? value.image : {};
  const defaults = REQUEST_MEDIA_DEFAULTS.image;
  return {
    recoveryDivisor:
      typeof divisor === 'number' && Number.isFinite(divisor) && divisor > 1
        ? divisor
        : REQUEST_MEDIA_DEFAULTS.recoveryDivisor,
    image: {
      max_width: positiveInteger(image.max_width) ?? defaults.max_width,
      max_height: positiveInteger(image.max_height) ?? defaults.max_height,
      max_base64_bytes: Math.min(
        positiveInteger(image.max_base64_bytes) ?? defaults.max_base64_bytes,
        MAX_IMAGE_BASE64_BYTES,
      ),
    },
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
