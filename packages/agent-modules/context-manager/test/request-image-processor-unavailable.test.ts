import { describe, expect, it, vi } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent/image-resize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent/image-resize')>();
  return {
    ...actual,
    resizeImage: vi.fn(() => Promise.reject(new actual.ImageProcessorUnavailableError())),
  };
});

const { encodeRequestImage, encodeRequestImageBlocks } = await import('../src/index.js');

describe('image processor unavailable', () => {
  it('replaces a tool result image over the limits with the Read tool note', async () => {
    const blocks = [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ];

    await expect(encodeRequestImageBlocks(blocks)).resolves.toEqual([
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'text', text: '[Image omitted: image processing runtime is unavailable.]' },
    ]);
  });

  it('keeps the original for callers that encode a single image', async () => {
    await expect(
      encodeRequestImage(Buffer.from('AAAA', 'base64'), 'image/png'),
    ).resolves.toBeUndefined();
  });
});
