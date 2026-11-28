import { describe, expect, it } from 'vitest';

import {
  MAX_PROVIDER_ERROR_SUMMARY_CHARS,
  PROVIDER_ERROR_SUMMARY_VOCABULARY,
  summarizeProviderError,
} from '../../src/logging/provider-error-summary.js';

describe('summarizeProviderError', () => {
  it.each([
    ['fetch failed', { kind: 'network', signals: ['network'], transport: ['fetch_failed'] }],
    ['read ECONNRESET', { kind: 'network', signals: ['network'], transport: ['ECONNRESET'] }],
    [
      'getaddrinfo ENOTFOUND gateway.invalid',
      { kind: 'network', signals: ['network'], transport: ['ENOTFOUND'] },
    ],
    ['getaddrinfo EAI_AGAIN gateway.invalid', { transport: ['EAI_AGAIN'] }],
    ['connect ETIMEDOUT 10.0.0.1:443', { kind: 'timeout', transport: ['ETIMEDOUT'] }],
    [
      '400 image dimensions exceed max allowed size: 8000 pixels',
      { status: 400, kind: 'bad_request', signals: ['request_too_large'] },
    ],
  ])('keeps the category of "%s"', (text, expected) => {
    const summary = summarizeProviderError(text);
    expect(summary).toMatchObject({ chars: text.length, ...expected });
    expect(JSON.stringify(summary)).not.toContain('gateway.invalid');
  });

  it('maps codes at envelope paths onto canonical names and unknown ones to other', () => {
    expect(
      summarizeProviderError(
        '400 {"type":"error","error":{"type":"INVALID_ARGUMENT","code":"vendor_specific_code","input":{"type":"invalid_request_error"}}}',
      ),
    ).toMatchObject({
      status: 400,
      codes: ['error', 'invalid_argument', 'other'],
      fields: ['type:string(5)', 'error.type:string(16)', 'error.code:string(20)', 'error.?:object(1)'],
    });
  });

  it('reads the BYOK envelope, its numeric code and its upstream detail', () => {
    const text = `BYOK upstream error: ${JSON.stringify({
      errorCode: 50113,
      errorSource: 'byok_upstream',
      errorDetail: '500 upstream error (invalid_argument): rejected',
    })}`;
    expect(summarizeProviderError(text)).toMatchObject({
      codes: ['LLM_UPSTREAM_ERROR', 'byok_upstream', 'invalid_argument'],
      fields: ['errorCode:number', 'errorSource:string(13)', 'errorDetail:string(47)'],
    });
  });

  it('reads a gateway code only from the leading gateway prefix', () => {
    expect(
      summarizeProviderError(
        'BYOK provider custom_provider:edge upstream error: 500 upstream error (invalid_argument): x',
      ).codes,
    ).toEqual(['invalid_argument']);
    expect(summarizeProviderError('400 rejected: upstream error (invalid_argument): x').codes).toBe(
      undefined,
    );
  });

  it('keeps an array root as a shape, not as an envelope', () => {
    expect(summarizeProviderError('400 [{"code":"invalid_argument"}]')).toMatchObject({
      fields: ['$:array(1)'],
    });
    expect(summarizeProviderError('400 [{"code":"invalid_argument"}]').codes).toBe(undefined);
  });

  it('takes the request id only from metadata, and only in its accepted form', () => {
    const text = '500 failed (request id: req_from_text_0001)';
    expect(summarizeProviderError(text).requestId).toBe(undefined);
    expect(summarizeProviderError(text, { requestId: 'req-header.01:a' }).requestId).toBe(
      'req-header.01:a',
    );
    expect(summarizeProviderError(text, { requestId: 'has space' }).requestId).toBe(undefined);
    expect(summarizeProviderError(text, { requestId: 'a'.repeat(129) }).requestId).toBe(undefined);
    expect(summarizeProviderError(text, { requestId: 42 }).requestId).toBe(undefined);
  });

  it('trims fields, and only fields, once the serialized summary outgrows its limit', () => {
    const codes = [
      'invalid_request_error',
      'authentication_error',
      'permission_error',
      'not_found_error',
      'rate_limit_error',
      'overloaded_error',
      'context_length_exceeded',
      'missing_required_parameter',
    ];
    // Every transport failure, codes as they are and phrases with spaces.
    const transport = [...PROVIDER_ERROR_SUMMARY_VOCABULARY.transport]
      .map((name) => (name === name.toUpperCase() ? name : name.replaceAll('_', ' ')))
      .join(' ');
    const keys = ['param', 'errorProviderId', 'errorSource', 'request_id', 'requestId'];
    // Envelopes nested through errorDetail to the deepest level read, every
    // field filled: long field paths, every code and transport failure.
    const envelope = (depth: number, valueLength: number): Record<string, unknown> => {
      const value = 'v'.repeat(depth < 3 ? 1 : valueLength);
      const fields = {
        type: codes[(depth * 2) % 8],
        code: codes[(depth * 2 + 1) % 8],
        message: transport,
        ...Object.fromEntries(
          [...keys, 'error_code', 'error_type', 'status', 'errorCode'].map((key) => [key, value]),
        ),
      };
      return {
        ...(depth < 3
          ? { errorDetail: `422 ${JSON.stringify(envelope(depth + 1, valueLength))}` }
          : {}),
        ...fields,
        error: { ...fields },
      };
    };
    const summary = (valueLength: number) =>
      summarizeProviderError(`400 ${JSON.stringify(envelope(0, valueLength))}`);

    // Short values: the summary fits with all 24 fields that are read.
    expect(summary(1).fields).toHaveLength(24);
    // Long values add digits to every `string(n)` shape: the summary outgrows its limit.
    const trimmed = summary(1_000);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(MAX_PROVIDER_ERROR_SUMMARY_CHARS);
    expect(trimmed.fields?.length).toBeLessThan(24);
    expect(trimmed.codes).toHaveLength(8);
    expect(trimmed.transport).toHaveLength(PROVIDER_ERROR_SUMMARY_VOCABULARY.transport.size);
  });
});
