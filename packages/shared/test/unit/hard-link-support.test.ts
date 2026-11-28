import { describe, expect, it } from 'vitest';

import {
  HARD_LINK_UNSUPPORTED_ERROR_CODE,
  HardLinkUnsupportedError,
  isHardLinkUnsupportedError,
} from '../../src/hard-link-support.js';

describe('HardLinkUnsupportedError', () => {
  it('names the directory, the rejected link code, and a supported filesystem', () => {
    const linkError = Object.assign(new Error('illegal operation on a directory, link'), {
      code: 'EISDIR',
    });

    const error = new HardLinkUnsupportedError('E:\\mcode-data', linkError);

    expect(error).toMatchObject({
      code: HARD_LINK_UNSUPPORTED_ERROR_CODE,
      directoryPath: 'E:\\mcode-data',
      linkErrorCode: 'EISDIR',
      cause: linkError,
    });
    expect(error.message).toContain('Cannot store data in E:\\mcode-data');
    expect(error.message).toContain('does not support hard links (EISDIR)');
    expect(error.message).toContain('NTFS');
    expect(error.message).not.toContain('connection');
  });

  it('omits the code when the rejected link reported none', () => {
    const error = new HardLinkUnsupportedError('/Volumes/USB', 'unknown failure');

    expect(error.linkErrorCode).toBeUndefined();
    expect(error.message).toContain('does not support hard links. ');
  });

  it('is recognized by its stable code rather than its class', () => {
    const relayed = Object.assign(new Error('relayed'), { code: HARD_LINK_UNSUPPORTED_ERROR_CODE });

    expect(isHardLinkUnsupportedError(new HardLinkUnsupportedError('/data', undefined))).toBe(true);
    expect(isHardLinkUnsupportedError(relayed)).toBe(true);
    expect(isHardLinkUnsupportedError({ code: HARD_LINK_UNSUPPORTED_ERROR_CODE })).toBe(false);
    expect(isHardLinkUnsupportedError(Object.assign(new Error('x'), { code: 'EISDIR' }))).toBe(
      false,
    );
  });
});
