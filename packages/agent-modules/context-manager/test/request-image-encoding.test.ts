import { crc32, deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { encodeRequestImage, encodeRequestImageBlocks } from '../src/index.js';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, checksum]);
}

/** Opaque grey RGB PNG of the given size. */
function png(width: number, height: number, level = -1): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngWidth(base64: string): number {
  return Buffer.from(base64, 'base64').readUInt32BE(16);
}

describe('encodeRequestImage', () => {
  it('keeps an image that already fits', async () => {
    await expect(encodeRequestImage(png(40, 24), 'image/png')).resolves.toBeUndefined();
  });

  it('shrinks an image wider than 2000 px', async () => {
    const normalized = await encodeRequestImage(png(2_400, 8), 'image/png');
    expect(normalized?.mimeType).toMatch(/^image\//u);
    if (normalized?.mimeType === 'image/png') expect(pngWidth(normalized.data)).toBe(2_000);
    expect(normalized?.data.length).toBeLessThan(4.5 * 1024 * 1024);
  });

  it('re-encodes an image within 2000 px whose data exceeds 4.5 MiB', async () => {
    const heavy = png(1_900, 900, 0);
    expect(heavy.toString('base64').length).toBeGreaterThan(4.5 * 1024 * 1024);
    const encoded = await encodeRequestImage(heavy, 'image/png');
    expect(encoded?.mimeType).toBe('image/png');
    expect(pngWidth(encoded!.data)).toBe(1_900);
    expect(encoded!.data.length).toBeLessThan(4.5 * 1024 * 1024);
  });

  it('encodes to the given width, height and base64 size', async () => {
    const encoding = { maxWidth: 1_600, maxHeight: 1_600, maxBase64Bytes: 153_600 };
    const wide = await encodeRequestImage(png(2_400, 8), 'image/png', encoding);
    if (wide?.mimeType === 'image/png') expect(pngWidth(wide.data)).toBe(1_600);
    expect(wide).toBeDefined();

    const tall = await encodeRequestImage(png(8, 1_200), 'image/png', {
      ...encoding,
      maxHeight: 600,
    });
    if (tall?.mimeType === 'image/png') {
      expect(Buffer.from(tall.data, 'base64').readUInt32BE(20)).toBe(600);
    }
    expect(tall).toBeDefined();

    const heavy = await encodeRequestImage(png(1_500, 900, 0), 'image/png', encoding);
    expect(heavy!.data.length).toBeLessThan(153_600);
  });

  it('keeps non-image media and undecodable images', async () => {
    await expect(encodeRequestImage(Buffer.from('video'), 'video/mp4')).resolves.toBeUndefined();
    await expect(encodeRequestImage(Buffer.from('broken'), 'image/png')).resolves.toBeUndefined();
  });
});

describe('encodeRequestImageBlocks', () => {
  it('re-encodes oversized image blocks and leaves every other block untouched', async () => {
    const small = { type: 'image', data: png(40, 24).toString('base64'), mimeType: 'image/png' };
    const wide = { type: 'image', data: png(2_400, 8).toString('base64'), mimeType: 'image/png' };
    const text = { type: 'text', text: 'caption' };

    const [keptSmall, shrunk, note, keptText] = (await encodeRequestImageBlocks([
      small,
      wide,
      text,
    ]))!;

    expect(keptSmall).toBe(small);
    expect(keptText).toBe(text);
    expect(shrunk).not.toBe(wide);
    expect(shrunk).toMatchObject({ type: 'image' });
    expect(note).toEqual({
      type: 'text',
      text: '[Image: original 2400x8, displayed at 2000x7. Multiply coordinates by 1.20 to map to original image.]',
    });
  });

  it('adds no size note when only the encoding changed', async () => {
    const heavy = { type: 'image', data: png(1_900, 900, 0).toString('base64'), mimeType: 'image/png' };
    const blocks = await encodeRequestImageBlocks([heavy]);
    expect(blocks).toHaveLength(1);
    expect(blocks![0]).toMatchObject({ type: 'image' });
  });

  it('notes the size the given encoding shrinks an image to', async () => {
    const wide = { type: 'image', data: png(2_400, 8).toString('base64'), mimeType: 'image/png' };
    const blocks = await encodeRequestImageBlocks([wide], {
      maxWidth: 1_200,
      maxHeight: 1_200,
      maxBase64Bytes: 153_600,
    });
    expect(blocks?.[1]).toEqual({
      type: 'text',
      text: expect.stringContaining('original 2400x8, displayed at 1200x4. Multiply coordinates by 2.00'),
    });
  });

  it('reports no change when every image already fits', async () => {
    const small = { type: 'image', data: png(40, 24).toString('base64'), mimeType: 'image/png' };
    await expect(encodeRequestImageBlocks([small])).resolves.toBeUndefined();
  });
});
