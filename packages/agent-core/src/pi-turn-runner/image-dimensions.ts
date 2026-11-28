/**
 * Pure, dependency-free image header reader for PNG and JPEG.
 *
 * The outbound request projection and the media entry checks (user
 * attachments, the read tool) need this, and only to answer one question: "is
 * this image so small or so elongated that the provider will reject the whole
 * request?". Every unknown input — unrecognised format, truncated payload,
 * invalid base64 — resolves to `undefined`, meaning "cannot determine", and the
 * caller fails open by keeping the block untouched. Nothing in this module
 * throws: a parser that rejects real-world bytes would be strictly worse than
 * one that shrugs, because the fallback is the current (working) behaviour.
 *
 * Deliberately no third-party dependency and deliberately no GIF/BMP/WebP: the
 * only producer that can emit a degenerate image here is our own Browser
 * screenshot path, which encodes JPEG or PNG. Unparseable formats are counted
 * and logged by the caller, which is the signal to widen this list if real
 * traffic ever needs it.
 */

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Only the leading bytes are ever needed. A JPEG's SOF marker sits after any
 * EXIF/ICC segments, but never megabytes in, so decoding a bounded prefix keeps
 * this cheap for the multi-megabyte screenshots that dominate real history.
 */
const MAX_HEADER_BYTES = 64 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * `mimeType` is an advisory hint only, never a gate. Blocks projected from
 * `video` content keep their source `video/*` type while carrying image bytes,
 * so dispatch is driven by the magic bytes and the declared type merely picks
 * which parser is tried first. `data` is base64 text or the raw bytes.
 */
export function imageDimensions(data: unknown, mimeType?: unknown): ImageDimensions | undefined {
  const bytes = decodeHeaderBytes(data);
  if (!bytes) return undefined;
  const declaredPng = typeof mimeType === 'string' && mimeType.toLowerCase().includes('png');
  return declaredPng
    ? (readPngDimensions(bytes) ?? readJpegDimensions(bytes))
    : (readJpegDimensions(bytes) ?? readPngDimensions(bytes));
}

function decodeHeaderBytes(data: unknown): Buffer | undefined {
  if (data instanceof Uint8Array) {
    if (data.length === 0) return undefined;
    return Buffer.from(data.buffer, data.byteOffset, Math.min(data.length, MAX_HEADER_BYTES));
  }
  if (typeof data !== 'string' || data.length === 0) return undefined;
  // Trim to a whole base64 group so the bounded prefix decodes cleanly.
  const maxChars = Math.ceil((MAX_HEADER_BYTES * 4) / 3);
  const prefix = data.length > maxChars ? data.slice(0, maxChars - (maxChars % 4)) : data;
  const bytes = Buffer.from(prefix, 'base64');
  return bytes.length > 0 ? bytes : undefined;
}

function readPngDimensions(bytes: Buffer): ImageDimensions | undefined {
  // Signature, then a fixed-offset IHDR chunk whose first two fields are the
  // dimensions. Any deviation means this is not a PNG we can read.
  if (bytes.length < 24) return undefined;
  for (const [index, expected] of PNG_SIGNATURE.entries()) {
    if (bytes[index] !== expected) return undefined;
  }
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return validDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function readJpegDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  // Walk the segment chain: the frame header can sit behind EXIF, ICC or
  // comment segments, so a fixed offset is not safe.
  while (offset + 3 < bytes.length) {
    const marker = bytes[offset + 1];
    if (bytes[offset] !== 0xff || marker === undefined) return undefined;
    if (marker === 0xff) {
      // Fill byte before the next marker.
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      // Standalone marker, no payload length follows.
      offset += 2;
      continue;
    }
    // EOI or the start of entropy-coded data: no frame header will appear.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2) return undefined;
    if (isStartOfFrame(marker)) {
      // A frame header is length(2) + precision(1) + height(2) + width(2) +
      // component count(1). A shorter declared length means the dimension bytes
      // would be read from outside the segment, fabricating a size.
      if (segmentLength < 8) return undefined;
      if (offset + 9 >= bytes.length) return undefined;
      return validDimensions(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

function isStartOfFrame(marker: number): boolean {
  // SOF0..SOF15, excluding DHT (0xc4), JPG (0xc8) and DAC (0xcc).
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function validDimensions(width: number, height: number): ImageDimensions | undefined {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
}
