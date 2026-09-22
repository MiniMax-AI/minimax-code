import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createStructuredLogger } from '../../src/logging/index.js';
import {
  isSecretKey,
  redactSecretText,
  redactSecretValue,
} from '../../src/logging/redact-log-secret.js';

function collectLogLines(log: (logger: ReturnType<typeof createStructuredLogger>) => void): string {
  const dest = new PassThrough();
  const chunks: string[] = [];
  dest.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
  const logger = createStructuredLogger({
    destination: dest,
    level: 'info',
    env: { NODE_ENV: 'production' },
  });
  log(logger);
  return chunks.join('');
}

describe('redactSecretText', () => {
  it('removes an api key literal', () => {
    expect(redactSecretText('upstream failed with key sk-fixturefixturefixture')).toBe(
      'upstream failed with key sk-***',
    );
  });

  it('removes a bearer credential from a header form', () => {
    expect(redactSecretText('Authorization: Bearer fixturefixture00')).toBe(
      'Authorization: Bearer ***',
    );
  });

  it('removes an api-key header value', () => {
    expect(redactSecretText('x-api-key: fixturefixture00')).toBe('x-api-key: ***');
  });

  it('removes the credential payload, not just the scheme word', () => {
    // `Basic`/`Digest` are scheme names, not the secret. Stopping after the
    // scheme left the payload — the base64 or the nonce — in clear. The scheme
    // stays so the line still says which auth was attempted.
    expect(redactSecretText('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic ***');
    expect(redactSecretText('authorization=Bearer fixturefixture00, next=1')).toBe(
      'authorization=Bearer ***, next=1',
    );
    expect(redactSecretText('Authorization: Digest username="x", nonce="y"')).toBe(
      'Authorization: Digest ***, nonce="y"',
    );
  });

  it('removes a credential inside a quoted JSON pair', () => {
    // The value sits between quotes, so the unquoted pattern could not reach it
    // and the whole string passed through untouched.
    expect(redactSecretText('detail: {"x-api-key":"fixturefixture00"}')).toBe(
      'detail: {"x-api-key":"***"}',
    );
    expect(redactSecretText('{"access_token":"tok-fixturefixture"}')).toBe(
      '{"access_token":"***"}',
    );
    expect(redactSecretText('{"apiKey":"sk-secret-value-here","model":"gpt-x"}')).toBe(
      '{"apiKey":"***","model":"gpt-x"}',
    );
  });

  it('leaves text with no credential alone', () => {
    expect(redactSecretText('model=gpt-x resolved in 42ms')).toBe('model=gpt-x resolved in 42ms');
  });

  it('removes a bare bearer token', () => {
    expect(redactSecretText('send Bearer fixturefixture00 now')).toBe('send Bearer *** now');
  });

  it('leaves unrelated text alone', () => {
    expect(redactSecretText('model resolve finished in 42ms')).toBe(
      'model resolve finished in 42ms',
    );
  });
});

describe('redactSecretValue', () => {
  it('removes credential fields at any depth', () => {
    const result = redactSecretValue({
      provider: 'mafia',
      options: {
        baseURL: 'https://api.example.com',
        apiKey: 'sk-fixturefixture00',
        headers: { 'x-api-key': 'fixturefixture00', 'x-trace': 'keep' },
      },
      nested: { list: [{ password: 'hunter2' }] },
    });

    expect(result).toEqual({
      provider: 'mafia',
      options: {
        baseURL: 'https://api.example.com',
        apiKey: '***',
        headers: { 'x-api-key': '***', 'x-trace': 'keep' },
      },
      nested: { list: [{ password: '***' }] },
    });
  });

  it('keeps the token accounting fields users read for throughput', () => {
    // The tok/s panel is a headline feature; redacting these would remove the
    // exact signal the log line exists to carry.
    const result = redactSecretValue({
      context_usage: { components: [{ kind: 'TOOLS', tokens: 21170 }] },
      cache_read: 113792,
      input_tokens: 8165,
      total_tokens: 122154,
    });

    expect(result).toEqual({
      context_usage: { components: [{ kind: 'TOOLS', tokens: 21170 }] },
      cache_read: 113792,
      input_tokens: 8165,
      total_tokens: 122154,
    });
  });

  it('keeps a credential environment variable name readable', () => {
    expect(redactSecretValue({ apiKeyEnv: 'MAFIA_API_KEY' })).toEqual({ apiKeyEnv: 'MAFIA_API_KEY' });
  });

  it('strips a credential literal that only appears inside a leaf string', () => {
    expect(redactSecretValue({ detail: 'request used sk-fixturefixture00' })).toEqual({
      detail: 'request used sk-***',
    });
  });

  it('replaces a cycle with a marker instead of re-emitting the original', () => {
    const cyclic: Record<string, unknown> = { name: 'root', apiKey: 'sk-inside-cycle' };
    cyclic.self = cyclic;

    const result = redactSecretValue(cyclic) as Record<string, unknown>;

    expect(result.name).toBe('root');
    expect(result.apiKey).toBe('***');
    expect(result.self).toBe('[circular]');
    expect(JSON.stringify(result)).not.toContain('sk-inside-cycle');
  });

  it('redacts a credential nested past the depth cap', () => {
    // The cap must truncate the branch, not hand the original object back:
    // anything below the cap would otherwise reach the log unredacted.
    let deep: Record<string, unknown> = { apiKey: 'sk-past-the-cap' };
    for (let level = 0; level < 12; level += 1) deep = { nested: deep };

    const serialized = JSON.stringify(redactSecretValue(deep));

    expect(serialized).not.toContain('sk-past-the-cap');
    expect(serialized).toContain('[truncated]');
  });
});

describe('isSecretKey', () => {
  it('matches credential names regardless of case and separator', () => {
    for (const key of ['apiKey', 'api_key', 'API-KEY', 'Authorization', 'clientSecret', 'jwt']) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  it('does not match unrelated fields', () => {
    for (const key of ['token', 'tokens', 'apiKeyEnv', 'monkey', 'token_usage', 'id']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe('structured logger redaction', () => {
  it('never writes a credential to the destination', () => {
    const output = collectLogLines((logger) => {
      logger.info(
        {
          provider: 'mafia',
          options: { apiKey: 'sk-fixturefixture00', baseURL: 'https://api.example.com' },
        },
        'provider request failed with Authorization: Bearer fixturefixture00',
      );
    });

    expect(output).not.toContain('sk-fixturefixture00');
    expect(output).not.toContain('fixturefixture00');
    expect(output).toContain('provider request failed');
    // Non-secret context must survive so the line stays useful.
    expect(output).toContain('api.example.com');
  });

  it('redacts on the error level too', () => {
    const output = collectLogLines((logger) => {
      logger.error({ authorization: 'Bearer fixturefixture00' }, 'upstream rejected the request');
    });

    expect(output).not.toContain('fixturefixture00');
    expect(output).toContain('upstream rejected the request');
  });
});
