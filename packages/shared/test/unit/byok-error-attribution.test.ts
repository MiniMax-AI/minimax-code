import { describe, expect, it } from 'vitest';

import {
  byokProviderErrorDetail,
  formatByokErrorAttribution,
  isByokErrorAttribution,
  parseByokErrorAttribution,
} from '../../src/byok-error-attribution.js';

describe('BYOK error attribution', () => {
  it('reads back what the formatter wrote', () => {
    const text = formatByokErrorAttribution({
      errorCode: 50111,
      providerId: 'custom_provider:acme-gateway',
      detail: '429 capacity is temporarily limited',
    });

    expect(isByokErrorAttribution(text)).toBe(true);
    expect(parseByokErrorAttribution(text)).toEqual({
      errorCode: 50111,
      message: 'BYOK provider custom_provider:acme-gateway upstream error: 429 capacity is temporarily limited',
      errorDetail: '429 capacity is temporarily limited',
      errorProviderId: 'custom_provider:acme-gateway',
    });
  });

  it('treats an attribution behind an [Error] prefix or spaces as already attributed', () => {
    const text = formatByokErrorAttribution({
      errorCode: 50111,
      providerId: 'custom_provider:acme-gateway',
      detail: '429 rate limited',
    });

    for (const wrapped of [`[Error] ${text}`, `  ${text}\n`]) {
      expect(isByokErrorAttribution(wrapped)).toBe(true);
      expect(parseByokErrorAttribution(wrapped)?.errorProviderId).toBe(
        'custom_provider:acme-gateway',
      );
    }
    expect(isByokErrorAttribution('429 Too Many Requests')).toBe(false);
  });

  it('still names the provider when the envelope is cut after its message field', () => {
    const text = formatByokErrorAttribution({
      errorCode: 50111,
      providerId: 'custom_provider:acme-gateway',
      detail: 'quota "pro" reached',
    });
    const cut = text.slice(0, text.indexOf('"errorSource"'));

    expect(parseByokErrorAttribution(cut)).toEqual({
      errorCode: 50111,
      message: 'BYOK provider custom_provider:acme-gateway upstream error: quota "pro" reached',
      errorDetail: 'quota "pro" reached',
      errorProviderId: 'custom_provider:acme-gateway',
    });
  });

  it.each([
    formatByokErrorAttribution({ errorCode: 50111, providerId: 'custom_provider:a', detail: 'x' }),
    'BYOK provider custom_provider:a upstream error: boom',
    '[Error] BYOK provider custom_provider:a upstream error: boom',
    'BYOK upstream error: not json',
    'BYOK upstream error: {"errorDetail":"no provider"}',
    '429 Too Many Requests',
  ])('counts a text as attributed exactly when it parses (%s)', (text) => {
    expect(isByokErrorAttribution(text)).toBe(parseByokErrorAttribution(text) !== undefined);
  });

  it('normalizes plain text the same way as an attribution for classification', () => {
    expect(byokProviderErrorDetail('  [Error] 400 invalid_prompt: rejected ')).toBe(
      '400 invalid_prompt: rejected',
    );
    expect(
      byokProviderErrorDetail('[Error] BYOK provider custom_provider:a upstream error: 400 invalid_prompt: rejected'),
    ).toBe('400 invalid_prompt: rejected');
  });

  it('reads the legacy sentence and an [Error] line prefix', () => {
    expect(
      parseByokErrorAttribution('[Error] BYOK provider custom_provider:acme-gateway upstream error: boom'),
    ).toEqual({
      message: 'BYOK provider custom_provider:acme-gateway upstream error: boom',
      errorDetail: 'boom',
      errorProviderId: 'custom_provider:acme-gateway',
    });
  });

  it.each([
    undefined,
    '',
    '429 Too Many Requests',
    'BYOK upstream error: not json',
    'BYOK upstream error: {"errorCode":50111}',
  ])('ignores text that names no BYOK provider (%s)', (text) => {
    expect(parseByokErrorAttribution(text)).toBeUndefined();
  });
});
