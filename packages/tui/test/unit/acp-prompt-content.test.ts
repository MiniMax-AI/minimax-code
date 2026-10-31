import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseTuiAcpPrompt } from '../../src/acp/prompt-content.js';

describe('ACP prompt content', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'more images than the count limit',
      count: 12,
      bytesPerImage: 1024,
      message: 'A prompt can include at most 10 images.',
    },
    {
      name: 'images over the total size limit',
      count: 3,
      bytesPerImage: 40 * 1024 * 1024,
      message: 'Prompt images exceed the 100 MB total limit.',
    },
  ])('rejects $name before decoding any image', ({ count, bytesPerImage, message }) => {
    const data = Buffer.alloc(bytesPerImage).toString('base64');
    const decode = vi.spyOn(Buffer, 'from');

    expect(() =>
      parseTuiAcpPrompt(
        Array.from({ length: count }, () => ({
          type: 'image' as const,
          mimeType: 'image/png',
          data,
        })),
      ),
    ).toThrow(message);
    expect(decode.mock.calls.filter(([, encoding]) => encoding === 'base64')).toHaveLength(0);
  });

  it('accepts images exactly at the total size limit', () => {
    const data = Buffer.alloc(50 * 1024 * 1024).toString('base64');

    const prompt = parseTuiAcpPrompt([
      { type: 'image', mimeType: 'image/png', data },
      { type: 'image', mimeType: 'image/jpeg', data: `${data.slice(0, 76)}\n${data.slice(76)}` },
    ]);

    expect(prompt.images.map((image) => [image.fileName, image.bytes.byteLength])).toEqual([
      ['image-1.png', 50 * 1024 * 1024],
      ['image-2.jpg', 50 * 1024 * 1024],
    ]);
  });
});
