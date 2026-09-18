import { createDecipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { createDesktopErrorReporter, formatErrorLog } from '../../src/error-reporting/reporter.js';
import { createLLMFailureReportHook } from '../../src/error-reporting/llm-integration.js';
import { buildAssociatedData, deriveEventLogKey } from '../../src/error-reporting/crypto.js';
import type { DesktopErrorLog } from '../../src/error-reporting/types.js';

const SECRET = 'SYNTHETIC_PRIVATE_4cd7';
const token = 'synthetic-managed-transport-token';
const userId = 'synthetic-user';

function receiverDecrypt(event: DesktopErrorLog): string {
  const [version, nonce, payload] = event.event_log.split('.');
  expect(version).toBe('v1');
  const bytes = Buffer.from(payload!, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveEventLogKey(token, userId),
    Buffer.from(nonce!, 'base64url'),
  );
  decipher.setAAD(buildAssociatedData(event));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(
    'utf8',
  );
}

function reporterFixture(readTelemetryEnabled: () => boolean | undefined = () => true) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const reporter = createDesktopErrorReporter({
    readTelemetryEnabled,
    authContextGetter: () => ({ accessToken: token, realUserID: userId }),
    region: () => 'en',
    buildEnv: () => 'prod',
    fetchImpl: vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return new Response(null, { status: 204 });
    }),
  });
  return { reporter, requests };
}

describe('automatic error upload privacy boundary', () => {
  it.each([undefined, false])('does not upload without an explicit diagnostics opt-in (%s)', async (enabled) => {
    const { reporter, requests } = reporterFixture(() => enabled);
    reporter.report({ event_type: 'llm_request_failure', event_log: '{}', occurred_at_ms: 1, code_location: 'synthetic' });
    await reporter.flush();
    expect(requests).toEqual([]);
  });

  it.each(['MCODE_DISABLE_TELEMETRY', 'DO_NOT_TRACK'])('%s overrides the diagnostics opt-in', async (key) => {
    vi.stubEnv(key, '1');
    try {
      const { reporter, requests } = reporterFixture(() => true);
      reporter.report({ event_type: 'llm_request_failure', event_log: '{}', occurred_at_ms: 1, code_location: 'synthetic' });
      await reporter.flush();
      expect(requests).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['config', 'MCODE_DISABLE_TELEMETRY', 'DO_NOT_TRACK'])('drops buffered diagnostics when %s revokes consent before flushing', async (source) => {
    let enabled = true;
    const { reporter, requests } = reporterFixture(() => enabled);
    try {
      reporter.report({ event_type: 'llm_request_failure', event_log: '{}', occurred_at_ms: 1, code_location: 'synthetic' });
      if (source === 'config') enabled = false;
      else vi.stubEnv(source, '1');
      await reporter.flush();
      expect(requests).toEqual([]);
      enabled = true;
      vi.unstubAllEnvs();
      await reporter.flush();
      expect(requests).toEqual([]);
    } finally {
      await reporter.close();
      vi.unstubAllEnvs();
    }
  });

  it('captures the final HTTP batch and decrypts it with receiver credentials without recovering provider content', async () => {
    const { reporter, requests } = reporterFixture();
    const headers = new Headers({
      Authorization: `Bearer ${SECRET}`,
      'x-api-key': SECRET,
      cookie: SECRET,
      'x-custom': SECRET,
    });
    const cause = Object.assign(new Error(SECRET), {
      statusCode: 503,
      code: 'ECONNRESET',
      headers,
      prompt: SECRET,
    });
    const error = Object.assign(new AggregateError([cause, SECRET], SECRET, { cause }), {
      status: 429,
      properties: {
        status: 401,
        error: cause,
        prompt: SECRET,
        headers,
        [SECRET]: SECRET,
      },
      request: { body: SECRET },
      data: Buffer.from(SECRET),
      map: new Map([[SECRET, SECRET]]),
    });
    error.stack = SECRET;
    const getter = vi.fn(() => SECRET);
    Object.defineProperty(error, 'toJSON', { get: getter });
    Object.defineProperty(cause, 'request', { get: getter });
    createLLMFailureReportHook(reporter, { appVersion: '0.4.12' })({
      error,
      providerError: { error, properties: { headers, prompt: SECRET } },
      errorMessage: SECRET,
      metricKind: 'rate_limited',
      occurredAtMs: 1234,
      request: {
        api: SECRET,
        model: SECRET,
        provider: SECRET,
        caller: SECRET,
        baseUrl: `https://${SECRET}@example.test/${SECRET}?key=${SECRET}`,
      },
    });
    await reporter.flush();
    expect(requests).toHaveLength(1);
    expect(getter).not.toHaveBeenCalled();
    const request = requests[0]!;
    expect(request.url).not.toContain(token);
    expect(new Headers(request.init.headers).get('Authorization')).toBe(`Bearer ${token}`);
    const batch = JSON.parse(String(request.init.body)) as {
      events: DesktopErrorLog[];
    };
    expect(batch.events).toHaveLength(1);
    const plaintext = receiverDecrypt(batch.events[0]!);
    expect(plaintext).not.toContain(SECRET);
    expect(plaintext).not.toMatch(/headers|prompt|stack|message|baseUrl|request/iu);
    expect(JSON.parse(plaintext)).toMatchObject({
      schemaVersion: 3,
      appVersion: '0.4.12',
      metricKind: 'rate_limited',
      error: {
        status: 429,
        cause: { statusCode: 503, code: 'ECONNRESET' },
        properties: { status: 401 },
      },
    });
    await reporter.close();
  });

  it('minimizes direct report input and prevents caller mutation and plaintext envelope injection', async () => {
    const { reporter, requests } = reporterFixture();
    const event = {
      event_type: 'llm_request_failure',
      occurred_at_ms: 100,
      code_location: SECRET,
      event_log: JSON.stringify({
        error: { status: 500, properties: { prompt: SECRET }, message: SECRET },
        request: SECRET,
      }),
      unexpected: SECRET,
    };
    reporter.report(event);
    event.event_log = SECRET;
    event.code_location = SECRET;
    reporter.report({ ...event, event_type: SECRET });
    reporter.report({ ...event, event_log: SECRET });
    await reporter.flush();
    const batch = JSON.parse(String(requests[0]!.init.body)) as {
      events: DesktopErrorLog[];
    };
    expect(batch.events).toHaveLength(2);
    for (const uploaded of batch.events) {
      expect(JSON.stringify(uploaded)).not.toContain(SECRET);
      expect(receiverDecrypt(uploaded)).not.toContain(SECRET);
    }
    expect(JSON.parse(receiverDecrypt(batch.events[0]!)).error.status).toBe(500);
  });

  it('bounds cyclic/deep errors, rejects unknown scalar fields and never invokes accessors', () => {
    const error: Record<string, unknown> = {
      name: SECRET,
      code: SECRET,
      status: SECRET,
      message: SECRET,
    };
    error.cause = error;
    const getter = vi.fn(() => {
      throw new Error(SECRET);
    });
    Object.defineProperty(error, 'properties', { get: getter });
    const log = formatErrorLog({
      error,
      providerError: new Headers({ authorization: SECRET }),
      appVersion: SECRET,
      metricKind: SECRET,
    });
    expect(log).not.toContain(SECRET);
    expect(log.length).toBeLessThan(512);
    expect(getter).not.toHaveBeenCalled();
    expect(
      formatErrorLog({
        error: new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error(SECRET);
            },
          },
        ),
      }),
    ).not.toContain(SECRET);
  });
});
