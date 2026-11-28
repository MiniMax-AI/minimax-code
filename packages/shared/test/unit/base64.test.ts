import { describe, expect, it } from 'vitest';
import { decodeBase64Bytes } from '../../src/base64.js';

describe('base64 byte decoding', () => {
  it.each(['', 'a', 'ab', 'abc', '中文', '\0\u00ff'])('decodes the original bytes of %j', (text) => {
    const bytes = new TextEncoder().encode(text);
    const encoded = Buffer.from(bytes).toString('base64');
    expect(decodeBase64Bytes(encoded)).toEqual(bytes);
    expect(decodeBase64Bytes(encoded.replace(/=+$/u, ''))).toEqual(bytes);
  });
  it('retains atob whitespace handling and invalid-input errors', () => {
    expect(decodeBase64Bytes(' YW Jj\n')).toEqual(new Uint8Array([97, 98, 99]));
    for (const value of ['a', 'YWJj!', '===', '_-']) {
      expect(() => decodeBase64Bytes(value)).toThrow();
    }
  });
});
