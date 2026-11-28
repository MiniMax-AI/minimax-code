import { describe, expect, it, vi } from 'vitest';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
} from '@earendil-works/pi-ai';
import { formatByokErrorAttribution } from '@mavis/shared/byok-error-attribution';
import {
  LLM_ERROR_CODES,
  classifyLLMRequestRejectionMessage,
  isLLMDeterministicRequestRejection,
  isLLMImageLimitMessage,
  isLLMRequestTooLargeMessage,
  normalizeLLMError,
} from '@mavis/shared/llm-error-classifier';
import {
  DEFAULT_LLM_RETRY_POLICY,
  LLM_RETRY_REQUEST_SETTLED_OBSERVER,
  LLMRequestStoppedError,
  LLM_RETRY_BEFORE_REQUEST,
  withLLMRetry,
  type LLMCallSettledEvent,
  type LLMRequestAdmission,
  type LLMRequestLifecycle,
  type LLMRequestLifecycleSettlement,
  type LLMRequestSettledEvent,
  type LLMUsageRecorder,
  type LLMRetryEvent,
} from '../../../src/pi-turn-runner/llm-retry.js';
import {
  parseContentReviewError,
  withContentReviewErrorShield,
} from '../../../src/pi-turn-runner/content-review.js';

function fakeModel(provider = 'fake-provider'): Model<any> {
  return {
    id: 'fake-model',
    name: 'fake-model',
    api: 'test-messages',
    provider,
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  } as Model<any>;
}

const CONTEXT: Context = { messages: [] };

function assistant(
  stopReason: AssistantMessage['stopReason'],
  content: AssistantMessage['content'],
  errorMessage?: string,
  usage?: Partial<AssistantMessage['usage']>,
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test-messages',
    provider: 'fake-provider',
    model: 'fake-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...(usage ?? {}),
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 0,
  } as AssistantMessage;
}

function stream(
  events: AssistantMessageEvent[],
  final: AssistantMessage,
): AssistantMessageEventStream {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < events.length) return { value: events[index++], done: false };
          return { value: undefined, done: true };
        },
      } as AsyncIterableIterator<AssistantMessageEvent>;
    },
    async result() {
      return final;
    },
  } as unknown as AssistantMessageEventStream;
}

function successStream(text: string): AssistantMessageEventStream {
  const empty = assistant('stop', []);
  const partial = assistant('stop', [{ type: 'text', text }]);
  const final = assistant('stop', [{ type: 'text', text }]);
  return stream(
    [
      { type: 'start', partial: empty },
      { type: 'text_start', contentIndex: 0, partial: empty },
      { type: 'text_delta', contentIndex: 0, delta: text, partial },
      { type: 'text_end', contentIndex: 0, content: text, partial },
      { type: 'done', reason: 'stop', message: final },
    ],
    final,
  );
}

function errorStream(
  message: string,
  partialText = '',
  usage?: Partial<AssistantMessage['usage']>,
): AssistantMessageEventStream {
  const empty = assistant('error', []);
  const content = partialText ? [{ type: 'text' as const, text: partialText }] : [];
  const partial = assistant('error', content);
  const final = assistant('error', content, message, usage);
  return stream(
    [
      { type: 'start', partial: empty },
      ...(partialText
        ? ([
            { type: 'text_start', contentIndex: 0, partial: empty },
            { type: 'text_delta', contentIndex: 0, delta: partialText, partial },
          ] satisfies AssistantMessageEvent[])
        : []),
      { type: 'error', reason: 'error', error: final },
    ],
    final,
  );
}

async function collectEvents(value: Awaited<ReturnType<StreamFn>>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of value) events.push(event);
  return events;
}

/** Retries in the default budget: a call sends one more request than this. */
const RETRIES = DEFAULT_LLM_RETRY_POLICY.maxRetries;

/** Every default wait at zero jitter: half of each 5 s-based step, capped at 30 s. */
const ZERO_JITTER_DELAYS = [
  2_500, 5_000, 10_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000,
];

function retryOptions(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    scope: 'agent' as const,
    generateCallId: () => 'call-1',
    random: () => 0,
    nowMs: () => 1_000,
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('withLLMRetry', () => {
  it('observes each physical provider request, including a retry that fails first', async () => {
    let attempts = 0;
    const physical: LLMRequestSettledEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return errorStream('[Error] 429 Too Many Requests', '', {
          input: 11,
          output: 2,
          cacheRead: Number.NaN,
          cacheWrite: 4,
        });
      }
      const final = assistant('stop', [{ type: 'text', text: 'ok' }], undefined, {
        input: 17,
        output: 3,
        cacheRead: 5,
        cacheWrite: 7,
      });
      return stream([{ type: 'done', reason: 'stop', message: final }], final);
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions());

    const result = await wrapped(fakeModel(), CONTEXT, {
      [LLM_RETRY_REQUEST_SETTLED_OBSERVER]: (event: LLMRequestSettledEvent) => {
        physical.push(event);
      },
    });
    await collectEvents(result);

    expect(physical).toEqual([
      {
        requestAttempt: 1,
        outcome: 'error',
        usage: { input: 11, output: 2, cacheRead: 0, cacheWrite: 4 },
        reportedUsage: { input: 11, output: 2, cacheWrite: 4, totalTokens: 0 },
        usageComplete: false,
        route: { api: 'test-messages', provider: 'fake-provider' },
      },
      {
        requestAttempt: 2,
        outcome: 'success',
        usage: { input: 17, output: 3, cacheRead: 5, cacheWrite: 7 },
        reportedUsage: { input: 17, output: 3, cacheRead: 5, cacheWrite: 7, totalTokens: 0 },
        usageComplete: true,
        route: { api: 'test-messages', provider: 'fake-provider' },
      },
    ]);
  });

  it('reports the partial usage of an interrupted stream as incomplete', async () => {
    let attempts = 0;
    const physical: LLMRequestSettledEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      // The input counted at message start arrived; the output never did.
      if (attempts === 1) {
        return errorStream('[Error] 429 Too Many Requests', 'partial', {
          input: 100,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        });
      }
      return successStream('ok');
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions());

    const result = await wrapped(fakeModel(), CONTEXT, {
      [LLM_RETRY_REQUEST_SETTLED_OBSERVER]: (event: LLMRequestSettledEvent) => {
        physical.push(event);
      },
    });
    await collectEvents(result);

    expect(physical[0]).toEqual({
      requestAttempt: 1,
      outcome: 'error',
      usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
      reportedUsage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      usageComplete: false,
      route: { api: 'test-messages', provider: 'fake-provider' },
    });
  });

  it.each([1, 2])('stops before physical request %s when required accounting admission fails', async (blocked) => {
    const failure = new Error('accounting unavailable');
    const beforeRequest = vi.fn((attempt: number) => { if (attempt === blocked) throw failure; });
    const inner = vi.fn(() => errorStream('[Error] 429 Too Many Requests'));
    const wrapped = withLLMRetry(inner as StreamFn, retryOptions());
    await expect(wrapped(fakeModel(), CONTEXT, {
      [LLM_RETRY_BEFORE_REQUEST]: beforeRequest,
    })).rejects.toBe(failure);
    expect(inner).toHaveBeenCalledTimes(blocked - 1);
    expect(beforeRequest).toHaveBeenCalledTimes(blocked);
  });

  it('disables provider-native retries so the framework owns the request budget', async () => {
    const maxRetries: Array<number | undefined> = [];
    const inner = ((_model, _context, options) => {
      maxRetries.push(options?.maxRetries);
      return successStream('ok');
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions());

    const result = await wrapped(fakeModel(), CONTEXT, { maxRetries: 9 });
    await collectEvents(result);

    expect(maxRetries).toEqual([0]);
  });

  // Built by the same formatter the Runtime's BYOK attribution uses, so a
  // format change cannot drift past this test.
  const byokFailure = (providerId: string) =>
    formatByokErrorAttribution({
      errorCode: 50111,
      providerId,
      detail: '429 capacity is temporarily limited',
    });

  it.each([
    // An OAuth custom provider resolves `model.provider` to its bare key; the
    // id still comes from the host's BYOK attribution, as the final error's does.
    ['an attributed OAuth custom provider', 'acme-gateway', byokFailure('custom_provider:acme-gateway'), 'custom_provider:acme-gateway'],
    // Error extraction may cut the envelope after its message field.
    ['a cut attribution', 'acme-gateway', byokFailure('custom_provider:acme-gateway').split('"errorSource"')[0], 'custom_provider:acme-gateway'],
    ['a legacy attributed custom provider', 'acme-gateway', 'BYOK provider custom_provider:acme-gateway upstream error: 429 Too Many Requests', 'custom_provider:acme-gateway'],
    ['the user MiniMax API key', 'minimax_api', byokFailure('minimax_api'), undefined],
    ['an unattributed failure', 'custom_provider:acme-gateway', '[Error] 429 Too Many Requests', undefined],
  ] as const)('names the custom provider on the public retry error for %s', async (_name, provider, failure, providerId) => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return attempts === 1 ? errorStream(failure) : successStream('ok');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({ observer: (event: LLMRetryEvent) => observed.push(event) }),
    );

    await collectEvents(await wrapped(fakeModel(provider), CONTEXT, {}));

    const waiting = observed.find((event) => event.status === 'waiting');
    // The public wording stays fixed; only the user's own provider id is added.
    expect(waiting?.error).toMatchObject({
      reason: 'rate_limited',
      message: 'LLM provider rate limited the request',
    });
    expect(waiting?.error?.providerId).toBe(providerId);
  });

  it('discards a pre-commit 429 attempt and exposes only the recovered stream', async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return attempts === 1 ? errorStream('[Error] 429 Too Many Requests') : successStream('ok');
    }) as StreamFn;
    const sleep = vi.fn(async () => {});
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        sleep,
        observer: (event: LLMRetryEvent) => observed.push(event),
        onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
      }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    const events = await collectEvents(result);

    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      'start',
      'text_start',
      'text_delta',
      'text_end',
      'done',
    ]);
    // Every retry starts from the 5 s base, so the first wait is half of it at
    // zero jitter.
    expect(sleep).toHaveBeenCalledWith(2_500, undefined);
    expect(observed).toMatchObject([
      {
        callId: 'call-1',
        status: 'waiting',
        retryAttempt: 1,
        maxRetries: RETRIES,
        requestAttempt: 2,
        delayMs: 2_500,
        error: { reason: 'rate_limited' },
      },
      {
        callId: 'call-1',
        status: 'recovered',
        retryAttempt: 1,
        maxRetries: RETRIES,
        requestAttempt: 2,
      },
    ]);
    await result.result();
    expect(settled).toMatchObject([
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        callId: 'call-1',
        scope: 'agent',
        provider: 'fake-provider',
        model: 'fake-model',
        final: { outcome: 'success', errorKind: 'none' },
        retryTriggered: true,
        retryReason: 'rate_limited',
        requestAttempts: 2,
        // Successful calls carry the raw provider buckets; this fixture reports
        // an all-zero usage.
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it('retries a pre-output MiniMax server-side timeout (2066) and recovers', async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return attempts === 1
        ? errorStream(
            '500 {"type":"error","error":{"type":"api_error","message":"请求处理超时，请稍后重试 (2066)"}}',
          )
        : successStream('ok');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        observer: (event: LLMRetryEvent) => observed.push(event),
        onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
      }),
    );

    const result = await wrapped(fakeModel('minimax'), CONTEXT, {});
    await collectEvents(result);
    await result.result();

    expect(attempts).toBe(2);
    expect(observed).toMatchObject([
      { status: 'waiting', requestAttempt: 2, error: { reason: 'timeout' } },
      { status: 'recovered', requestAttempt: 2 },
    ]);
    expect(settled).toMatchObject([
      {
        final: { outcome: 'success', errorKind: 'none' },
        retryTriggered: true,
        retryReason: 'timeout',
        requestAttempts: 2,
      },
    ]);
  });

  it('settles a successful logical Call with only its normalized tool identities', async () => {
    const final = assistant('toolUse', [
      { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'README.md' } },
    ]);
    const settled: LLMCallSettledEvent[] = [];
    const wrapped = withLLMRetry(
      (async () => stream([{ type: 'done', reason: 'toolUse', message: final }], final)) as StreamFn,
      retryOptions({ onCallSettled: (event: LLMCallSettledEvent) => settled.push(event) }),
    );

    await (await wrapped(fakeModel(), CONTEXT, {})).result();

    expect(settled[0]?.expectedTools).toEqual([{ toolCallId: 'tool-1', toolName: 'read' }]);
    expect(settled[0]).not.toHaveProperty('assistantMessage');
    expect(JSON.stringify(settled[0])).not.toContain('README.md');
  });

  it('does not count a committed retry stream as recovered when its final result fails', async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return attempts === 1
        ? errorStream('[Error] 429 Too Many Requests')
        : errorStream('ECONNRESET', 'partial');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        observer: (event: LLMRetryEvent) => observed.push(event),
        onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
      }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    await collectEvents(result);
    await result.result();

    expect(observed.map((event) => event.status)).toEqual(['waiting', 'recovered']);
    expect(settled).toMatchObject([
      {
        final: { outcome: 'error', errorKind: 'network' },
        retryTriggered: true,
        retryReason: 'rate_limited',
        requestAttempts: 2,
      },
    ]);
  });

  it.each([2056, 2067])(
    'never retries Token Plan exhaustion status %i even when the outer status looks transient',
    async (statusCode) => {
      let attempts = 0;
      const observed: LLMRetryEvent[] = [];
      const settled: LLMCallSettledEvent[] = [];
      const inner = (async () => {
        attempts += 1;
        return errorStream(
          `[Error] 429 {"status_code":${statusCode},"status_msg":"plan exhausted"}`,
        );
      }) as StreamFn;
      const wrapped = withLLMRetry(
        inner,
        retryOptions({
          observer: (event: LLMRetryEvent) => observed.push(event),
          onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
        }),
      );

      const result = await wrapped(fakeModel(), CONTEXT, {});
      const events = await collectEvents(result);

      expect(attempts).toBe(1);
      expect(events.at(-1)?.type).toBe('error');
      expect(observed).toEqual([]);
      await result.result();
      expect(settled).toMatchObject([
        {
          final: { outcome: 'error', errorKind: 'usage_limit' },
          retryTriggered: false,
          requestAttempts: 1,
        },
      ]);
    },
  );

  it('never retries the platform send-message restriction (40320)', async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return errorStream('400 {"error":"当前功能被限制，请联系客服获取详情","errorCode":40320}');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        observer: (event: LLMRetryEvent) => observed.push(event),
        onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
      }),
    );

    // Managed MiniMax provider uses the strict retry allowlist rather than BYOK retry-all.
    const result = await wrapped(fakeModel('minimax'), CONTEXT, {});
    const events = await collectEvents(result);

    expect(attempts).toBe(1);
    expect(events.at(-1)?.type).toBe('error');
    expect(observed).toEqual([]);
    await result.result();
    expect(settled).toMatchObject([{ retryTriggered: false, requestAttempts: 1 }]);
  });

  it('does not report recovered when a retry ends in a non-retryable quota error', async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return attempts === 1
        ? errorStream('[Error] 429 Too Many Requests')
        : errorStream('[Error] 500 {"status_code":2056,"status_msg":"plan exhausted"}');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        observer: (event: LLMRetryEvent) => observed.push(event),
        onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
      }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    await collectEvents(result);

    expect(attempts).toBe(2);
    expect(observed.map((event) => event.status)).toEqual(['waiting', 'exhausted']);
    expect(observed.at(-1)?.error).toEqual({
      reason: 'usage_limit',
      code: LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED,
      message: 'LLM usage limit reached',
    });
    await expect(result.result()).resolves.toMatchObject({
      errorMessage: '[Error] 500 {"status_code":2056,"status_msg":"plan exhausted"}',
    });
    expect(settled).toMatchObject([
      {
        final: { outcome: 'error', errorKind: 'usage_limit' },
        retryTriggered: true,
        retryReason: 'rate_limited',
        requestAttempts: 2,
      },
    ]);
  });

  it.each([
    {
      finalError: '[Error] 401 invalid api key',
      expectedReason: 'auth',
      expectedCode: LLM_ERROR_CODES.LLM_AUTH_ERROR,
      expectedMessage: 'LLM provider authentication failed',
    },
    {
      finalError: '[Error] 503 upstream unavailable',
      expectedReason: 'server_error',
      expectedCode: LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
      expectedMessage: 'LLM provider request failed',
    },
  ])(
    'attributes an exhausted retry to the final $expectedReason failure',
    async ({ finalError, expectedReason, expectedCode, expectedMessage }) => {
      let attempts = 0;
      const observed: LLMRetryEvent[] = [];
      const settled: LLMCallSettledEvent[] = [];
      const inner = (async () => {
        attempts += 1;
        return attempts === 1
          ? errorStream('[Error] 429 Too Many Requests')
          : errorStream(finalError);
      }) as StreamFn;
      const wrapped = withLLMRetry(
        inner,
        retryOptions({
          observer: (event: LLMRetryEvent) => observed.push(event),
          onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
        }),
      );

      const result = await wrapped(fakeModel(), CONTEXT, {});
      await collectEvents(result);

      expect(attempts).toBe(2);
      expect(observed.at(-1)).toMatchObject({
        status: 'exhausted',
        error: {
          reason: expectedReason,
          code: expectedCode,
          message: expectedMessage,
        },
      });
      await expect(result.result()).resolves.toMatchObject({ errorMessage: finalError });
      expect(settled).toMatchObject([
        {
          final: { outcome: 'error', errorKind: expectedReason },
          retryTriggered: true,
          retryReason: 'rate_limited',
          requestAttempts: 2,
        },
      ]);
    },
  );

  it.each(['iterator', 'error-event'] as const)(
    'recovers a pre-output socket disconnect delivered by %s with one logical settlement',
    async (mode) => {
      const disconnect = new TypeError('terminated', {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      });
      const observed: LLMRetryEvent[] = [];
      const settled: LLMCallSettledEvent[] = [];
      const physical: LLMRequestSettledEvent[] = [];
      const settle = vi.fn(async () => {});
      const onProviderError = vi.fn(() => { throw new Error('observer failure'); });
      let attempts = 0;
      const inner: StreamFn = (_model, _context, options) => {
        attempts += 1;
        if (attempts > 1) return successStream('recovered');
        if (mode === 'error-event') {
          options?.onProviderError?.(disconnect, fakeModel());
          return errorStream('terminated');
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'start', partial: assistant('stop', []) };
            throw disconnect;
          },
          result: () => new Promise<AssistantMessage>(() => {}),
        } as AssistantMessageEventStream;
      };
      const wrapped = withLLMRetry(inner, retryOptions({
        observer: (event: LLMRetryEvent) => observed.push(event),
        onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
        requestLifecycle: {
          admit: async () => ({ kind: 'send', tools: 'all' }),
          beforeAttempt: async () => {},
          settle,
        },
      }));
      const result = await wrapped(fakeModel(), CONTEXT, {
        onProviderError,
        [LLM_RETRY_REQUEST_SETTLED_OBSERVER]: (event: LLMRequestSettledEvent) => physical.push(event),
      });
      const events = await collectEvents(result);
      await result.result();
      expect(attempts).toBe(2);
      expect(events.filter((event) => event.type === 'start')).toHaveLength(1);
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(observed.map((event) => event.status)).toEqual(['waiting', 'recovered']);
      expect(observed[0]?.error?.reason).toBe('network');
      expect(physical.map((event) => event.outcome)).toEqual(['error', 'success']);
      expect(settle).toHaveBeenCalledOnce();
      expect(settled).toMatchObject([{ requestAttempts: 2, final: { outcome: 'success' } }]);
      expect(onProviderError).toHaveBeenCalledTimes(mode === 'error-event' ? 1 : 0);
    },
  );

  it('does not reuse the previous attempt raw error for a terminal retry failure', async () => {
    let attempts = 0;
    const inner: StreamFn = (model, _context, options) => {
      attempts += 1;
      if (attempts === 1) {
        options?.onProviderError?.(Object.assign(new Error('terminated'), { code: 'UND_ERR_SOCKET' }), model);
        return errorStream('terminated');
      }
      return errorStream('unknown provider failure');
    };
    const result = await withLLMRetry(inner, retryOptions())(fakeModel(), CONTEXT, {});
    await collectEvents(result);
    expect(attempts).toBe(2);
    expect((await result.result()).errorMessage).toBe('unknown provider failure');
  });

  it.each([
    'Vendor stream ended without any message events (rawEventCount=0)',
    'Stream ended without finish_reason',
  ])('retries managed premature EOF: %s', async (message) => {
    let attempts = 0;
    const inner: StreamFn = () => ++attempts === 1 ? errorStream(message) : successStream('ok');
    const result = await withLLMRetry(inner, retryOptions())(fakeModel(), CONTEXT, {});
    expect((await collectEvents(result)).at(-1)?.type).toBe('done');
    expect(attempts).toBe(2);
  });

  it.each(['fake-provider', 'minimax_api', 'custom_provider:work'])(
    'does not replay %s after a tool intent has been exposed', async (provider) => {
      const partial = assistant('error', [{ type: 'toolCall', id: 'tool-1', name: 'write', arguments: {} }]);
      const final = { ...partial, errorMessage: 'Stream ended without finish_reason' };
      const inner = vi.fn(() => stream([
        { type: 'toolcall_start', contentIndex: 0, partial },
        { type: 'error', reason: 'error', error: final },
      ], final));
      const result = await withLLMRetry(inner, retryOptions())(fakeModel(provider), CONTEXT, {});
      expect((await collectEvents(result)).at(-1)?.type).toBe('error');
      expect(inner).toHaveBeenCalledOnce();
    },
  );

  it.each(['minimax_api', 'custom_provider:work'])(
    'keeps terminal rejections out of the %s fallback retry policy', async (provider) => {
      for (const message of [
        '[Error] 401 invalid api key', '[Error] 403 forbidden', '[Error] 402 insufficient balance',
        'usage limit exceeded 2056', 'content_filter', 'Request was aborted',
      ]) {
        const inner = vi.fn(() => errorStream(message));
        const result = await withLLMRetry(inner, retryOptions())(fakeModel(provider), CONTEXT, {});
        expect((await collectEvents(result)).at(-1)?.type).toBe('error');
        expect(inner).toHaveBeenCalledOnce();
      }
    },
  );

  it('does not dispatch after cancellation while awaiting the attempt barrier', async () => {
    const controller = new AbortController();
    const inner = vi.fn(() => successStream('unexpected'));
    const settle = vi.fn(async () => {});
    const wrapped = withLLMRetry(inner, retryOptions({ requestLifecycle: {
      admit: async () => ({ kind: 'send', tools: 'all' }),
      beforeAttempt: async () => { controller.abort(); },
      settle,
    } }));
    await expect(wrapped(fakeModel(), CONTEXT, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(inner).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'abort', attempts: [] }));
  });

  it('retries a network error thrown before a stream is returned', async () => {
    let attempts = 0;
    const inner = (async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      return successStream('ok');
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions());

    const result = await wrapped(fakeModel(), CONTEXT, {});
    expect((await collectEvents(result)).at(-1)?.type).toBe('done');
    expect(attempts).toBe(2);
  });

  it.each(['throw', 'stream'] as const)('recovers a managed TLS failure from %s before output', async (failureKind) => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      if (attempts === 1) {
        if (failureKind === 'throw') {
          throw Object.assign(new Error('TLS record failure'), { code: 'ERR_SSL_BAD_RECORD_MAC_ALERT' });
        }
        return errorStream('net::ERR_SSL_BAD_RECORD_MAC_ALERT');
      }
      return successStream('recovered');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({ observer: (event: LLMRetryEvent) => observed.push(event) }),
    );

    const result = await wrapped(fakeModel('minimax'), CONTEXT, {});
    const events = await collectEvents(result);

    expect(attempts).toBe(2);
    expect(observed.map((event) => event.status)).toEqual(['waiting', 'recovered']);
    expect(observed[0]?.error?.reason).toBe('network');
    expect(events.some((event) => event.type === 'error')).toBe(false);
    await expect(result.result()).resolves.toMatchObject({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'recovered' }],
    });
  });

  it.each([
    ['[Error] 529 overloaded', 'overloaded'],
    ['net::ERR_SSL_BAD_RECORD_MAC_ALERT', 'network'],
  ] as const)('uses the whole retry budget and exhausts after the last request for %s', async (errorMessage, errorKind) => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const sleep = vi.fn(async () => {});
    const inner = (async () => {
      attempts += 1;
      return errorStream(errorMessage);
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        sleep,
        observer: (event: LLMRetryEvent) => observed.push(event),
        onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
      }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    await collectEvents(result);

    expect(attempts).toBe(RETRIES + 1);
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual(ZERO_JITTER_DELAYS);
    expect(observed.filter((event) => event.status === 'waiting')).toHaveLength(RETRIES);
    expect(observed.at(-1)).toMatchObject({
      status: 'exhausted',
      retryAttempt: RETRIES,
      maxRetries: RETRIES,
      requestAttempt: RETRIES + 1,
      error: { reason: errorKind },
    });
    await result.result();
    expect(settled).toMatchObject([
      {
        final: { outcome: 'error', errorKind },
        retryTriggered: true,
        retryReason: errorKind,
        requestAttempts: RETRIES + 1,
      },
    ]);
  });

  it('limits unclassified BYOK errors to the retry budget', async () => {
    let attempts = 0;
    const inner = (async () => {
      attempts += 1;
      return errorStream('unknown gateway failure');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({ sleep: vi.fn(async () => {}) }),
    );

    const result = await wrapped(fakeModel('minimax_api'), CONTEXT, {});
    await collectEvents(result);

    expect(attempts).toBe(RETRIES + 1);
  });

  // An ordinary BYOK Turn: a gateway that refuses the request body inside a
  // 500 (`invalid_argument`) fails the same way on every resend, so it is sent
  // once; any other 5xx keeps the full BYOK retry budget.
  it.each([
    ['custom_provider:work', '500 upstream error (invalid_argument): There is an issue with this request', 1],
    ['minimax_api', '500 upstream error (invalid_argument): There is an issue with this request', 1],
    ['custom_provider:work', '500 Internal Server Error', RETRIES + 1],
    ['custom_provider:work', '502 Bad Gateway', RETRIES + 1],
    ['custom_provider:work', '503 upstream error (invalid_argument): overloaded', RETRIES + 1],
  ])('sends an ordinary BYOK %s failure "%s" %s time(s)', async (provider, message, expected) => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const inner = (async () => {
      attempts += 1;
      return errorStream(message);
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ sleep }));

    await collectEvents(await wrapped(fakeModel(provider), CONTEXT, {}));

    expect(attempts).toBe(expected);
    expect(sleep).toHaveBeenCalledTimes(expected - 1);
  });

  // Retrying every BYOK failure decides only whether to retry; the reason the
  // retry metrics and the waiting notice carry is the error's own class.
  it.each([
    ['[Error] 429 rate limit exceeded', 'rate_limited'],
    ['[Error] 529 overloaded', 'overloaded'],
    ['500 Internal Server Error', 'server_error'],
    ['net::ERR_SSL_BAD_RECORD_MAC_ALERT', 'network'],
  ] as const)('keeps the BYOK retry budget for "%s" and reports it as %s', async (message, reason) => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return errorStream(message);
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        sleep: vi.fn(async () => {}),
        observer: (event: LLMRetryEvent) => observed.push(event),
        onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
      }),
    );

    const result = await wrapped(fakeModel('custom_provider:work'), CONTEXT, {});
    await collectEvents(result);
    await result.result();

    expect(attempts).toBe(RETRIES + 1);
    expect(observed.find((event) => event.status === 'waiting')?.error?.reason).toBe(reason);
    expect(settled).toMatchObject([{ retryTriggered: true, retryReason: reason }]);
  });

  // #425: a request the provider deterministically rejects (too many images,
  // invalid_request_error) fails the same way on every resend, so the BYOK
  // retry-all budget only delays the real reason by minutes.
  it.each([
    ['custom_provider:work', '400 Upstream [invalid_request_error] Too many images in request: 31 > 30'],
    ['minimax_api', '400 Upstream [invalid_request_error] Too many images in request: 31 > 30'],
    ['custom_provider:work', '400 {"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}'],
    ['fake-provider', '400 Too many images in request: 31 > 30'],
    ['custom_provider:work', '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}'],
    [
      'custom_provider:work',
      '{"type":"error","error":{"type":"invalid_request_error","message":"上游返回 413，取消重试：request body too large: 154339079 bytes exceeds limit of 134217728 bytes"}}',
    ],
    ['custom_provider:work', 'Input is too long for requested model.'],
    ['minimax_api', 'invalid params, context window exceeds limit'],
    ['custom_provider:work', '400 image dimensions exceed max allowed size: 8000 pixels'],
    ['custom_provider:work', '400 {"error":{"message":"gateway error 413 occurred"}}'],
    ['custom_provider:work', '400 messages.0.content.1.image.source.base64: image exceeds 5 MB maximum'],
    [
      'custom_provider:test-gateway',
      '500 upstream error (invalid_argument): There is an issue with this request, please try a different model. (request id: 1fe797ea)',
    ],
  ])('does not retry a deterministic request rejection from %s: %s', async (provider, message) => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const inner = (async () => {
      attempts += 1;
      return errorStream(message);
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ sleep }));

    const events = await collectEvents(await wrapped(fakeModel(provider), CONTEXT, {}));

    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    const error = events.find((event) => event.type === 'error');
    expect(error?.type === 'error' ? error.error.errorMessage : undefined).toBe(message);
  });

  // A gateway that relays Bedrock through Anthropic Messages opens the stream
  // with HTTP 200 and only then reports the rejection as an SSE `error` event.
  // The 200 is not the failure's status, so it must not veto the size check.
  it.each([
    '{"type":"error","error":{"type":"api_error","message":"Input is too long."}}',
    '{"type":"error","error":{"type":"api_error","message":"413 Request too large (request id: 99e6cc4a)"}}',
  ])('does not retry a size rejection reported inside an HTTP 200 stream: %s', async (message) => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const inner = (async (model, _context, options) => {
      attempts += 1;
      await options?.onResponse?.({ status: 200, headers: {} }, model);
      return errorStream(message);
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ sleep }));

    const events = await collectEvents(await wrapped(fakeModel('custom_provider:work'), CONTEXT, {}));

    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    const error = events.find((event) => event.type === 'error');
    expect(error?.type === 'error' ? error.error.errorMessage : undefined).toBe(message);
  });

  it('keeps retrying a transient error reported inside an HTTP 200 stream', async () => {
    let attempts = 0;
    const inner = (async (model, _context, options) => {
      attempts += 1;
      await options?.onResponse?.({ status: 200, headers: {} }, model);
      return errorStream('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ sleep: vi.fn(async () => {}) }));

    await collectEvents(await wrapped(fakeModel('custom_provider:work'), CONTEXT, {}));

    expect(attempts).toBe(RETRIES + 1);
  });

  it.each([
    '[Error] 400 Bad Request',
    '503 Service Unavailable: too many images queued, try again',
    '429 rate limited while processing images',
    '503 payload too large for the upstream queue, try again',
    '400 context window has 4130 tokens left',
  ])('keeps the BYOK retry-all budget for transient or unclassified errors: %s', async (message) => {
    let attempts = 0;
    const inner = (async () => {
      attempts += 1;
      return errorStream(message);
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ sleep: vi.fn(async () => {}) }));

    await collectEvents(await wrapped(fakeModel('custom_provider:work'), CONTEXT, {}));

    expect(attempts).toBe(RETRIES + 1);
  });

  it('keeps the exhausted attempt open when returning its terminal failure stream', async () => {
    const attemptReturns: Array<ReturnType<typeof vi.fn>> = [];
    const inner = (async () => {
      const failed = errorStream('[Error] 529 overloaded');
      const iterator = failed[Symbol.asyncIterator]();
      let cancelled = false;
      const closeAttempt = vi.fn(async () => {
        cancelled = true;
        return { value: undefined, done: true as const };
      });
      attemptReturns.push(closeAttempt);
      return {
        [Symbol.asyncIterator]() {
          return { next: () => iterator.next(), return: closeAttempt };
        },
        async result() {
          if (cancelled) throw new Error('provider stream was cancelled');
          return failed.result();
        },
      } as unknown as AssistantMessageEventStream;
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({ policy: { maxRetries: 1 }, sleep: vi.fn(async () => {}) }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    const events = await collectEvents(result);

    expect(events.at(-1)?.type).toBe('error');
    await expect(result.result()).resolves.toMatchObject({
      stopReason: 'error',
      errorMessage: '[Error] 529 overloaded',
    });
    expect(attemptReturns).toHaveLength(2);
    expect(attemptReturns[0]).toHaveBeenCalledOnce();
    expect(attemptReturns[1]).not.toHaveBeenCalled();
  });

  it('settles result-only calls when every attempt disconnects before the first token', async () => {
    const disconnect = Object.assign(new Error('socket reset before first token'), {
      code: 'ECONNRESET',
    });
    const settled: LLMCallSettledEvent[] = [];
    let attempts = 0;
    const inner = (async () => {
      attempts += 1;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<AssistantMessageEvent>> {
              throw disconnect;
            },
          };
        },
        result: () => new Promise<AssistantMessage>(() => {}),
      } as unknown as AssistantMessageEventStream;
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        policy: { maxRetries: 1 },
        sleep: vi.fn(async () => {}),
        onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
      }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    const timeout = Symbol('result timeout');
    const outcome = await Promise.race([
      result.result().catch((error: unknown) => error),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(timeout), 100)),
    ]);

    expect(attempts).toBe(2);
    expect(outcome).toBe(disconnect);
    expect(settled).toMatchObject([
      {
        final: { outcome: 'error', errorKind: 'network' },
        retryTriggered: true,
        retryReason: 'network',
        requestAttempts: 2,
      },
    ]);
  });

  it('stops before a backoff that would exceed the retry elapsed-time budget', async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const sleep = vi.fn(async () => {});
    const inner = (async () => {
      attempts += 1;
      return errorStream('[Error] 429 Too Many Requests');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        sleep,
        observer: (event: LLMRetryEvent) => observed.push(event),
        policy: { maxRetryElapsedMs: 499 },
      }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    await collectEvents(result);

    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(observed).toMatchObject([
      { status: 'exhausted', retryAttempt: 0, requestAttempt: 1 },
    ]);
  });

  it('initiates cleanup for a discarded attempt before the next provider request', async () => {
    let attempts = 0;
    const discardedReturn = vi.fn(async () => ({ value: undefined, done: true as const }));
    const inner = (async () => {
      attempts += 1;
      if (attempts > 1) return successStream('ok');
      const failed = errorStream('[Error] 429 Too Many Requests');
      return {
        [Symbol.asyncIterator]() {
          const iterator = failed[Symbol.asyncIterator]();
          return { next: () => iterator.next(), return: discardedReturn };
        },
        result: () => failed.result(),
      } as unknown as AssistantMessageEventStream;
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions());

    const result = await wrapped(fakeModel(), CONTEXT, {});
    await collectEvents(result);

    expect(discardedReturn).toHaveBeenCalledOnce();
    expect(attempts).toBe(2);
  });

  it.each(['ECONNRESET', 'net::ERR_SSL_BAD_RECORD_MAC_ALERT'])('does not retry %s after visible output', async (errorMessage) => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return errorStream(errorMessage, 'partial');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({ observer: (event: LLMRetryEvent) => observed.push(event) }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    const events = await collectEvents(result);

    expect(attempts).toBe(1);
    expect(events.some((event) => event.type === 'text_delta')).toBe(true);
    expect(events.at(-1)?.type).toBe('error');
    expect(observed).toEqual([]);
  });

  it.each(['fake-provider', 'custom_provider:work'])(
    'treats a model safety refusal from %s as a terminal content_filter without retrying',
    async (provider) => {
      let attempts = 0;
      const observed: LLMRetryEvent[] = [];
      const settled: LLMCallSettledEvent[] = [];
      const inner = (async () => {
        attempts += 1;
        return errorStream(
          'Model declined the request (stop_reason: refusal; category: cyber): could enable cyber harm, see 500 {"x":1}',
        );
      }) as StreamFn;
      const wrapped = withLLMRetry(
        inner,
        retryOptions({
          observer: (event: LLMRetryEvent) => observed.push(event),
          onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
        }),
      );

      const result = await wrapped(fakeModel(provider), CONTEXT, {});
      const events = await collectEvents(result);

      expect(attempts).toBe(1);
      expect(observed).toEqual([]);
      expect(events.at(-1)?.type).toBe('error');
      expect((await result.result()).errorMessage).toContain('stop_reason: refusal');
      expect(settled).toMatchObject([
        { retryTriggered: false, final: { outcome: 'error', errorKind: 'content_filter' } },
      ]);
    },
  );

  it('commits BYOK streaming after visible output in every host composition', async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return errorStream('[Error] 401 invalid api key', 'partial');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        observer: (event: LLMRetryEvent) => observed.push(event),
        sleep: vi.fn(async () => {}),
      }),
    );

    const result = await wrapped(fakeModel('custom_provider:work'), CONTEXT, {});
    const events = await collectEvents(result);

    expect(attempts).toBe(1);
    expect(events.some((event) => event.type === 'text_delta')).toBe(true);
    expect(events.at(-1)?.type).toBe('error');
    expect(observed).toEqual([]);
  });

  it('retries a BYOK provider stream that ended without any message event', async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return attempts === 1
        ? errorStream(
            'Provider stream ended without any message events (rawEventCount=0; messageEventCount=0; firstEventAtMs=none; lastEventAtMs=none; eofAtMs=61000)',
          )
        : successStream('recovered');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        observer: (event: LLMRetryEvent) => observed.push(event),
        sleep: vi.fn(async () => {}),
      }),
    );

    const result = await wrapped(fakeModel('custom_provider:byok-gateway'), CONTEXT, {});
    const events = await collectEvents(result);

    expect(attempts).toBe(2);
    expect(events.at(-1)?.type).toBe('done');
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect((await result.result()).stopReason).toBe('stop');
    expect(observed).toMatchObject([
      // BYOK retries every error, but the reason keeps the classifier's own kind:
      // a stream that ended without any message event is a transport disconnect.
      { status: 'waiting', retryAttempt: 1, requestAttempt: 2, error: { reason: 'network' } },
      { status: 'recovered', retryAttempt: 1, requestAttempt: 2 },
    ]);
  });

  it('returns a BYOK stream before the provider finishes after its first visible delta', async () => {
    const empty = assistant('error', []);
    const partial = assistant('error', [{ type: 'thinking', thinking: 'live' }]);
    const final = assistant(
      'error',
      [{ type: 'thinking', thinking: 'live' }],
      'late disconnect',
    );
    let releaseTail = () => undefined;
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    let attempts = 0;
    const inner = (async () => {
      attempts += 1;
      let index = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<AssistantMessageEvent>> {
              index += 1;
              if (index === 1) return { value: { type: 'start', partial: empty }, done: false };
              if (index === 2) {
                return {
                  value: {
                    type: 'thinking_delta',
                    contentIndex: 0,
                    delta: 'live',
                    partial,
                  },
                  done: false,
                };
              }
              await tail;
              if (index === 3) {
                return { value: { type: 'error', reason: 'error', error: final }, done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
        async result() {
          await tail;
          return final;
        },
      } as AssistantMessageEventStream;
    }) as StreamFn;
    const order: string[] = [];
    const wrapped = withLLMRetry(inner, retryOptions({ sleep: vi.fn(async () => {}) }));
    const committed = wrapped(fakeModel('custom_provider:work'), CONTEXT, {}).then((result) => {
      order.push('committed');
      return result;
    });
    setTimeout(() => {
      order.push('tail');
      releaseTail();
    }, 0);

    const result = await committed;
    expect(order[0]).toBe('committed');
    expect((await collectEvents(result)).some((event) => event.type === 'thinking_delta')).toBe(true);
    expect(attempts).toBe(1);
  });

  // SDKs throw on an error status before the provider reports the response,
  // so a real 429/529 carries its Retry-After only on the thrown HTTP error.
  it.each([
    ['a Fetch Headers', () => new Headers({ 'retry-after': '2' })],
    ['a plain record', () => ({ 'Retry-After': '2' })],
  ])('honors Retry-After on the provider HTTP error as %s', async (_shape, headers) => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const inner: StreamFn = (model, _context, options) => {
      attempts += 1;
      if (attempts <= 2) {
        options?.onProviderError?.(
          Object.assign(new Error('529 Overloaded'), { status: 529, headers: headers() }),
          model,
        );
        return errorStream('[Error] 529 overloaded');
      }
      return successStream('ok');
    };

    await collectEvents(await withLLMRetry(inner, retryOptions({ sleep }))(fakeModel(), CONTEXT, {}));

    expect(attempts).toBe(3);
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([2_000, 2_000]);
  });

  it('prefers the response header over the provider error', async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    const inner: StreamFn = async (model, _context, options) => {
      attempts += 1;
      if (attempts === 1) {
        await options?.onResponse?.({ status: 429, headers: { 'retry-after': '7' } }, model);
        options?.onProviderError?.(
          Object.assign(new Error('429'), { status: 429, headers: { 'retry-after': '2' } }),
          model,
        );
        return errorStream('[Error] 429 Too Many Requests');
      }
      return successStream('ok');
    };

    await collectEvents(await withLLMRetry(inner, retryOptions({ sleep }))(fakeModel(), CONTEXT, {}));

    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([7_000]);
  });

  it('honors a bounded Retry-After response header', async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const inner = (async (model, _context, options) => {
      attempts += 1;
      if (attempts === 1) {
        await options?.onResponse?.(
          { status: 429, headers: { 'retry-after': '300' } },
          model,
        );
        return errorStream('provider throttled');
      }
      return successStream('ok');
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ sleep }));

    const result = await wrapped(fakeModel(), CONTEXT, {});
    await collectEvents(result);

    expect(sleep).toHaveBeenCalledWith(30_000, undefined);
  });

  it('waits out a refusal cool-down the 429 names before each retry', async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const inner = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return errorStream('429 caller user is cooling down after refusal, retry after 16s');
      }
      if (attempts === 2) {
        return errorStream(
          'BYOK provider custom_provider:work upstream error: 429 {"error":{"message":"caller user is cooling down after refusal, retry after 45s"}}',
        );
      }
      return successStream('ok');
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ sleep }));

    await collectEvents(await wrapped(fakeModel(), CONTEXT, {}));

    expect(attempts).toBe(3);
    // The named wait holds even past the backoff cap of 30 s.
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([16_000, 45_000]);
  });

  it('keeps the retry limit while waiting out a refusal cool-down', async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const sleep = vi.fn(async () => {});
    const inner = (async () => {
      attempts += 1;
      return errorStream('429 caller user is cooling down after refusal, retry after 5s');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({ sleep, observer: (event: LLMRetryEvent) => observed.push(event) }),
    );

    await collectEvents(await wrapped(fakeModel(), CONTEXT, {}));

    expect(attempts).toBe(DEFAULT_LLM_RETRY_POLICY.maxRetries + 1);
    // Backoff above the cool-down keeps its own length; below it, the cool-down
    // wins. The 5 s base clears the 5 s cool-down from the third retry on.
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([
      5_000,
      ...ZERO_JITTER_DELAYS.slice(1),
    ]);
    expect(observed.at(-1)).toMatchObject({ status: 'exhausted', retryAttempt: RETRIES });
  });

  it('cancels an in-flight backoff without starting another request', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const sleep = vi.fn(
      async (_delayMs: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('sleep aborted')), { once: true });
        }),
    );
    const inner = (async () => {
      attempts += 1;
      return errorStream('[Error] 429 Too Many Requests');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        sleep,
        observer: (event: LLMRetryEvent) => observed.push(event),
        onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
      }),
    );

    const pending = wrapped(fakeModel(), CONTEXT, { signal: controller.signal });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
    controller.abort('user_stop');

    await expect(pending).rejects.toThrow('sleep aborted');
    expect(attempts).toBe(1);
    expect(observed.at(-1)).toMatchObject({
      status: 'cancelled',
      retryAttempt: 1,
      requestAttempt: 2,
    });
    expect(settled).toMatchObject([
      {
        final: { outcome: 'abort', errorKind: 'abort' },
        retryTriggered: true,
        retryReason: 'rate_limited',
        requestAttempts: 1,
      },
    ]);
  });

  it('reports cancellation when the user aborts an active retry attempt', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      if (attempts === 1) return errorStream('[Error] 429 Too Many Requests');
      controller.abort('user_stop');
      throw new DOMException('The operation was aborted', 'AbortError');
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({ observer: (event: LLMRetryEvent) => observed.push(event) }),
    );

    await expect(wrapped(fakeModel(), CONTEXT, { signal: controller.signal })).rejects.toThrow(
      'aborted',
    );
    expect(attempts).toBe(2);
    expect(observed.map((event) => event.status)).toEqual(['waiting', 'cancelled']);
  });
});

describe('withLLMRetry request lifecycle', () => {
  function recordingLifecycle(admission: LLMRequestAdmission = { kind: 'send', tools: 'all' }) {
    const log: string[] = [];
    const settlements: LLMRequestLifecycleSettlement[] = [];
    const lifecycle: LLMRequestLifecycle = {
      admit: vi.fn(async ({ callId }) => {
        log.push(`admit:${callId}`);
        return admission;
      }),
      beforeAttempt: vi.fn(async ({ callId, requestAttempt }) => {
        log.push(`attempt:${callId}:${requestAttempt}`);
      }),
      settle: vi.fn(async (settlement) => {
        log.push(`settle:${settlement.callId}:${settlement.outcome}`);
        settlements.push(settlement);
      }),
    };
    return { lifecycle, log, settlements };
  }

  it('admits once, gates every attempt, and settles one logical request with each attempt', async () => {
    const { lifecycle, log, settlements } = recordingLifecycle();
    let attempts = 0;
    const inner = (async () => {
      attempts += 1;
      log.push(`provider:${attempts}`);
      if (attempts === 1) {
        return errorStream('[Error] 500 network error', '', { input: 5, output: 1 });
      }
      const final = assistant('stop', [{ type: 'text', text: 'ok' }], undefined, {
        input: 7,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
      });
      return stream([{ type: 'done', reason: 'stop', message: final }], final);
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ requestLifecycle: lifecycle }));

    const result = await wrapped(fakeModel(), CONTEXT, {});
    await collectEvents(result);
    await result.result();

    expect(log).toEqual([
      'admit:call-1',
      'attempt:call-1:1',
      'provider:1',
      'attempt:call-1:2',
      'provider:2',
      'settle:call-1:success',
    ]);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.attempts.map((attempt) => attempt.usage)).toEqual([
      { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
      { input: 7, output: 2, cacheRead: 1, cacheWrite: 0 },
    ]);
  });

  it('settles with the known attempts when an attempt cannot be marked as dispatching', async () => {
    const { lifecycle, log, settlements } = recordingLifecycle();
    vi.mocked(lifecycle.beforeAttempt).mockImplementation(async ({ callId, requestAttempt }) => {
      log.push(`attempt:${callId}:${requestAttempt}`);
      if (requestAttempt === 2) throw new Error('database is locked');
    });
    let providerCalls = 0;
    const inner = (async () => {
      providerCalls += 1;
      return errorStream('[Error] 500 network error', '', { input: 5, output: 1 });
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ requestLifecycle: lifecycle }));

    await expect(wrapped(fakeModel(), CONTEXT, {})).rejects.toThrow('database is locked');

    expect(providerCalls).toBe(1);
    expect(log.at(-1)).toBe('settle:call-1:error');
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.attempts.map((attempt) => attempt.usage)).toEqual([
      { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
    ]);

    // The first attempt failing to mark means nothing was sent: no attempts.
    const first = recordingLifecycle();
    vi.mocked(first.lifecycle.beforeAttempt).mockRejectedValueOnce(new Error('disk full'));
    const unsent = withLLMRetry(inner, retryOptions({ requestLifecycle: first.lifecycle }));
    await expect(unsent(fakeModel(), CONTEXT, {})).rejects.toThrow('disk full');
    expect(providerCalls).toBe(1);
    expect(first.settlements).toHaveLength(1);
    expect(first.settlements[0]?.attempts).toEqual([]);
  });

  it('holds the logical result until the settlement has been written', async () => {
    let releaseSettle: () => void = () => undefined;
    const lifecycle: LLMRequestLifecycle = {
      admit: async () => ({ kind: 'send', tools: 'all' }),
      beforeAttempt: async () => undefined,
      settle: () =>
        new Promise<void>((resolve) => {
          releaseSettle = resolve;
        }),
    };
    const wrapped = withLLMRetry(
      (() => successStream('done')) as StreamFn,
      retryOptions({ requestLifecycle: lifecycle }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    let released = false;
    const pending = result.result().then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(released).toBe(false);
    releaseSettle();
    await pending;
    expect(released).toBe(true);
  });

  it('sends a request without tools and with the admission instruction appended', async () => {
    const { lifecycle } = recordingLifecycle({
      kind: 'send',
      tools: 'none',
      instruction: 'Summarize now.',
    });
    const seen: Context[] = [];
    const inner = ((_model, context) => {
      seen.push(context);
      return successStream('summary');
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ requestLifecycle: lifecycle }));

    await collectEvents(
      await wrapped(
        fakeModel(),
        {
          systemPrompt: 'base',
          messages: [],
          tools: [{ name: 'get_goal', description: 'x', parameters: {} as never }],
        },
        {},
      ),
    );

    expect(seen[0]?.tools).toEqual([]);
    expect(seen[0]?.systemPrompt).toBe('base\n\nSummarize now.');
  });

  it('drops tool intents from a request sent without tools but settles its usage', async () => {
    const { lifecycle, settlements } = recordingLifecycle({ kind: 'send', tools: 'none' });
    const toolCall = { type: 'toolCall', id: 'tc-1', name: 'edit', arguments: {} } as const;
    const final = assistant(
      'toolUse',
      [{ type: 'text', text: 'summary' }, toolCall],
      undefined,
      { input: 9, output: 3, cacheRead: 0, cacheWrite: 0 },
    );
    const inner = (() =>
      stream(
        [
          { type: 'toolcall_start', contentIndex: 1, partial: final },
          { type: 'toolcall_end', contentIndex: 1, toolCall, partial: final },
          { type: 'done', reason: 'toolUse', message: final },
        ] as AssistantMessageEvent[],
        final,
      )) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ requestLifecycle: lifecycle }));

    const result = await wrapped(fakeModel(), CONTEXT, {});
    const events = await collectEvents(result);
    const message = await result.result();

    expect(events.map((event) => event.type)).toEqual(['done']);
    expect(message.content).toEqual([{ type: 'text', text: 'summary' }]);
    expect(message.stopReason).toBe('stop');
    expect(settlements[0]?.outcome).toBe('success');
    expect(settlements[0]?.attempts.map((attempt) => attempt.usage)).toEqual([
      { input: 9, output: 3, cacheRead: 0, cacheWrite: 0 },
    ]);
  });

  it('keeps a gateway content_error recognizable when a request without tools returns tool intents', async () => {
    // When a toolless request (e.g. goal wrap-up) still emits tool_use and gets rejected by the gateway,
    // the message must remain recognizable so the runner retracts and retries instead of failing normally.
    const { lifecycle } = recordingLifecycle({ kind: 'send', tools: 'none' });
    const toolCall = { type: 'toolCall', id: 'tc-1', name: 'edit', arguments: {} } as const;
    const rejection = JSON.stringify({
      type: 'error',
      error: {
        type: 'content_error',
        message: 'content unavailable',
        code: 50201,
        action: 4,
        guide_prompt: 'guide',
        request_id: 'req-no-tools',
      },
    });
    const final = assistant('error', [{ type: 'text', text: 'draft' }, toolCall], rejection);
    const inner = (() =>
      stream(
        [
          { type: 'toolcall_start', contentIndex: 1, partial: final },
          { type: 'error', reason: 'error', error: final },
        ] as AssistantMessageEvent[],
        final,
      )) as StreamFn;
    const wrapped = withLLMRetry(
      withContentReviewErrorShield(inner),
      retryOptions({ requestLifecycle: lifecycle }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    await collectEvents(result);
    const message = await result.result();

    expect(message.stopReason).toBe('error');
    // 换成网关给的 message，不留带引导词的原始错误。
    expect(message.errorMessage).toBe('content unavailable');
    expect(parseContentReviewError(message)).toMatchObject({
      code: 50201,
      action: 4,
      requestId: 'req-no-tools',
    });
  });

  it('never calls the provider for a stopped request and settles it with no attempt', async () => {
    const { lifecycle, settlements } = recordingLifecycle({ kind: 'stop', reason: 'closed' });
    const inner = vi.fn(() => successStream('never')) as unknown as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ requestLifecycle: lifecycle }));

    await expect(wrapped(fakeModel(), CONTEXT, {})).rejects.toBeInstanceOf(LLMRequestStoppedError);
    expect(inner).not.toHaveBeenCalled();
    expect(settlements).toEqual([{ callId: 'call-1', outcome: 'abort', attempts: [] }]);
  });

  it('settles a request cancelled before its first attempt with no attempt', async () => {
    const { lifecycle, settlements } = recordingLifecycle();
    const controller = new AbortController();
    controller.abort('user_stop');
    const wrapped = withLLMRetry(
      (() => successStream('never')) as StreamFn,
      retryOptions({ requestLifecycle: lifecycle }),
    );

    await expect(wrapped(fakeModel(), CONTEXT, { signal: controller.signal })).rejects.toThrow();
    expect(settlements).toMatchObject([{ outcome: 'abort', attempts: [] }]);
    expect(lifecycle.beforeAttempt).not.toHaveBeenCalled();
  });

  it('settles a terminal provider failure after its attempt', async () => {
    const { lifecycle, settlements } = recordingLifecycle();
    const wrapped = withLLMRetry(
      (() => errorStream('[Error] 401 Unauthorized')) as StreamFn,
      retryOptions({ requestLifecycle: lifecycle }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    await collectEvents(result);
    await result.result();

    expect(settlements).toMatchObject([{ outcome: 'error', attempts: [{ requestAttempt: 1 }] }]);
  });

  it('leaves auxiliary scopes unaccounted', async () => {
    const { lifecycle } = recordingLifecycle();
    const wrapped = withLLMRetry(
      (() => successStream('summary')) as StreamFn,
      retryOptions({ scope: 'compaction', requestLifecycle: lifecycle }),
    );

    await collectEvents(await wrapped(fakeModel(), CONTEXT, {}));
    expect(lifecycle.admit).not.toHaveBeenCalled();
  });

  describe('attempt records', () => {
    /** A first attempt that fails retryably with known usage, then an answer. */
    function failThenAnswer(log: string[]): StreamFn {
      let attempts = 0;
      return (async () => {
        attempts += 1;
        log.push(`provider:${attempts}`);
        if (attempts === 1) {
          return errorStream('[Error] 500 network error', '', { input: 5, output: 1 });
        }
        const final = assistant('stop', [{ type: 'text', text: 'ok' }], undefined, {
          input: 7,
          output: 2,
        });
        return stream([{ type: 'done', reason: 'stop', message: final }], final);
      }) as StreamFn;
    }

    it('records every receipt so far at each attempt boundary, before the settlement', async () => {
      const { lifecycle, log, settlements } = recordingLifecycle();
      const records: (readonly LLMRequestSettledEvent[])[] = [];
      lifecycle.recordAttempts = vi.fn(async ({ callId, attempts }) => {
        log.push(`record:${callId}:${attempts.length}`);
        records.push(attempts);
      });
      const wrapped = withLLMRetry(failThenAnswer(log), retryOptions({ requestLifecycle: lifecycle }));

      const result = await wrapped(fakeModel(), CONTEXT, {});
      await collectEvents(result);
      await result.result();

      // The failed attempt's usage is recorded before the retry is sent.
      expect(log).toEqual([
        'admit:call-1',
        'attempt:call-1:1',
        'provider:1',
        'record:call-1:1',
        'attempt:call-1:2',
        'provider:2',
        'record:call-1:2',
        'settle:call-1:success',
      ]);
      expect(records.map((attempts) => attempts.map((attempt) => attempt.usage))).toEqual([
        [{ input: 5, output: 1, cacheRead: 0, cacheWrite: 0 }],
        [
          { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
          { input: 7, output: 2, cacheRead: 0, cacheWrite: 0 },
        ],
      ]);
      expect(settlements[0]?.attempts).toEqual(records[1]);
    });

    it('starts the settlement only after the last record has been written', async () => {
      const { lifecycle, log } = recordingLifecycle();
      let releaseRecord: () => void = () => undefined;
      lifecycle.recordAttempts = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseRecord = () => {
              log.push('record-written');
              resolve();
            };
          }),
      );
      const wrapped = withLLMRetry(
        (() => successStream('done')) as StreamFn,
        retryOptions({ requestLifecycle: lifecycle }),
      );

      const result = await wrapped(fakeModel(), CONTEXT, {});
      const pending = result.result();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(lifecycle.recordAttempts).toHaveBeenCalledTimes(1);
      expect(lifecycle.settle).not.toHaveBeenCalled();

      releaseRecord();
      await pending;
      expect(log.slice(-2)).toEqual(['record-written', 'settle:call-1:success']);
    });

    it('keeps the request going and settles every attempt when a record fails', async () => {
      const { lifecycle, settlements } = recordingLifecycle();
      lifecycle.recordAttempts = vi.fn(async () => {
        throw new Error('ledger unavailable');
      });
      const wrapped = withLLMRetry(
        failThenAnswer([]),
        retryOptions({ requestLifecycle: lifecycle }),
      );

      const result = await wrapped(fakeModel(), CONTEXT, {});
      await collectEvents(result);
      const message = await result.result();

      expect(message.content).toEqual([{ type: 'text', text: 'ok' }]);
      expect(lifecycle.recordAttempts).toHaveBeenCalledTimes(2);
      expect(settlements).toMatchObject([
        { outcome: 'success', attempts: [{ requestAttempt: 1 }, { requestAttempt: 2 }] },
      ]);
    });
  });
});

describe('withLLMRetry usage recorder', () => {
  function recorder() {
    const log: string[] = [];
    const usageRecorder: LLMUsageRecorder = {
      recordAttempts: vi.fn(async ({ callId, scope, attempts }) => {
        log.push(`record:${scope}:${callId}:${attempts.length}`);
      }),
      settle: vi.fn(async ({ callId, scope, outcome, attempts }) => {
        log.push(`settle:${scope}:${callId}:${outcome}:${attempts.length}`);
      }),
    };
    return { usageRecorder, log };
  }

  it('records the agent and compaction scopes without changing the request', async () => {
    for (const scope of ['agent', 'compaction'] as const) {
      const { usageRecorder, log } = recorder();
      const contexts: unknown[] = [];
      const wrapped = withLLMRetry(
        ((_model, context) => {
          contexts.push(context);
          return successStream('ok');
        }) as StreamFn,
        retryOptions({ scope, usageRecorder }),
      );

      const result = await wrapped(fakeModel(), CONTEXT, {});
      await collectEvents(result);
      await result.result();

      expect(contexts).toEqual([CONTEXT]);
      expect(log).toEqual([`record:${scope}:call-1:1`, `settle:${scope}:call-1:success:1`]);
    }
  });

  it('settles every attempt, before the logical result is released', async () => {
    const { usageRecorder } = recorder();
    let settled = false;
    usageRecorder.settle = vi.fn(async ({ attempts }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled = attempts.length === 2;
    });
    let attempts = 0;
    const wrapped = withLLMRetry(
      (async () => {
        attempts += 1;
        if (attempts === 1) {
          return errorStream('[Error] 500 network error', '', { input: 5, output: 1 });
        }
        return successStream('ok');
      }) as StreamFn,
      retryOptions({ usageRecorder }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    await collectEvents(result);
    await result.result();

    expect(settled).toBe(true);
  });

  it('never records title requests, and leaves the agent scope to a request lifecycle', async () => {
    const title = recorder();
    await collectEvents(
      await withLLMRetry(
        (() => successStream('Title')) as StreamFn,
        retryOptions({ scope: 'title', usageRecorder: title.usageRecorder }),
      )(fakeModel(), CONTEXT, {}),
    );
    expect(title.log).toEqual([]);

    const governed = recorder();
    const lifecycle: LLMRequestLifecycle = {
      admit: vi.fn(async () => ({ kind: 'send', tools: 'all' }) as const),
      beforeAttempt: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
    };
    const result = await withLLMRetry(
      (() => successStream('ok')) as StreamFn,
      retryOptions({ requestLifecycle: lifecycle, usageRecorder: governed.usageRecorder }),
    )(fakeModel(), CONTEXT, {});
    await collectEvents(result);
    await result.result();
    expect(lifecycle.settle).toHaveBeenCalledTimes(1);
    expect(governed.log).toEqual([]);
  });

  it('keeps the request when the recorder fails', async () => {
    const usageRecorder: LLMUsageRecorder = {
      settle: vi.fn(async () => {
        throw new Error('charge failed');
      }),
    };
    const result = await withLLMRetry(
      (() => successStream('done')) as StreamFn,
      retryOptions({ scope: 'compaction', usageRecorder }),
    )(fakeModel(), CONTEXT, {});
    await collectEvents(result);

    expect((await result.result()).content).toEqual([{ type: 'text', text: 'done' }]);
  });
});

describe("deterministic request rejection classification", () => {
  const rejection = (errorMessage: string, statusCode?: number) =>
    isLLMDeterministicRequestRejection(normalizeLLMError({ errorMessage, statusCode }));

  it("recognises provider image-count limits in common phrasings", () => {
    for (const message of [
      "Upstream [invalid_request_error] Too many images in request: 31 > 30",
      "A maximum of 8 images may be provided in one request.",
      "Number of images exceeds the limit of 20",
      "You can only include at most 100 images",
    ]) {
      expect(isLLMImageLimitMessage(message), message).toBe(true);
      expect(classifyLLMRequestRejectionMessage(message), message).toBe("image_limit");
    }
    expect(isLLMImageLimitMessage("image too large")).toBe(false);
  });

  it("treats image limits and HTTP 400 invalid_request_error as terminal", () => {
    expect(rejection("400 Upstream [invalid_request_error] Too many images in request: 31 > 30")).toBe(true);
    expect(rejection("Too many images in request: 31 > 30")).toBe(true);
    expect(rejection("Too many images", 413)).toBe(true);
    expect(rejection('400 {"type":"invalid_request_error","message":"bad"}')).toBe(true);
    expect(classifyLLMRequestRejectionMessage('400 {"type":"invalid_request_error"}')).toBe("invalid_request");
  });

  it("treats every size rejection request media recovery handles as terminal", () => {
    for (const message of [
      "Input is too long.",
      "413 <html><body>nginx</body></html>",
      "Request too large for gpt-4o",
      "request body too large",
      "Request exceeds the maximum allowed size",
      "messages.0.content.1.image.source.base64: image exceeds 5 MB maximum",
      "At least one of the image dimensions exceed max allowed size for many-image requests",
      '{"error":{"message":"gateway error 413 occurred"}}',
    ]) {
      expect(isLLMRequestTooLargeMessage(message), message).toBe(true);
      expect(rejection(message, 400), message).toBe(true);
      expect(rejection(message), message).toBe(true);
      expect(rejection(message, 503), message).toBe(false);
    }
    expect(isLLMRequestTooLargeMessage("context window has 4130 tokens left")).toBe(false);
  });

  it("classifies the BYOK-attributed form the retry loop actually sees", () => {
    // local-runtime-v2 wraps BYOK failures before withLLMRetry inspects them.
    const byok = (detail: string) =>
      `BYOK upstream error: ${JSON.stringify({
        errorCode: LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
        message: `BYOK provider custom_provider:fixture upstream error: ${detail}`,
        errorSource: "byok_upstream",
        errorDetail: detail,
        errorProviderId: "custom_provider:fixture",
      })}`;
    expect(rejection(byok("400 Upstream [invalid_request_error] Too many images in request: 31 > 30"))).toBe(true);
    expect(rejection(byok('400 {"type":"invalid_request_error","message":"bad"}'))).toBe(true);
    // axum's body limit behind a gateway that reports it as a 400.
    expect(rejection(byok("400 Failed to buffer the request body: length limit exceeded"))).toBe(true);
    expect(rejection(byok("400 Bad Request"))).toBe(false);
    expect(rejection(byok("503 Service Unavailable"))).toBe(false);
  });

  it("keeps transient, unclassified or ambiguous errors retryable", () => {
    expect(rejection("400 Bad Request")).toBe(false);
    expect(rejection("invalid_request_error: overloaded")).toBe(false);
    expect(rejection("Too many images", 503)).toBe(false);
    expect(rejection("Too many images", 429)).toBe(false);
    expect(rejection("invalid_request_error", 500)).toBe(false);
    expect(rejection("401 invalid api key")).toBe(false);
    expect(classifyLLMRequestRejectionMessage("invalid_request_error without a status")).toBeUndefined();
  });

  it("treats HTTP 413, byte-limit and context-overflow rejections as deterministic", () => {
    const oversized = rejection;
    expect(oversized("413 Request Entity Too Large")).toBe(true);
    expect(oversized("anything", 413)).toBe(true);
    expect(oversized('{"type":"error","error":{"type":"request_too_large","message":"too big"}}')).toBe(true);
    expect(oversized("Request body too large: 9 bytes exceeds client limit 8 bytes.")).toBe(true);
    expect(oversized("400 invalid params, context window exceeds limit (2013)")).toBe(true);
    expect(oversized("prompt is too long: 213462 tokens > 200000 maximum")).toBe(true);
    expect(rejection("413 Payload Too Large")).toBe(true);
  });

  it("does not treat transient or unrelated size-like errors as deterministic", () => {
    const oversized = rejection;
    // The bare MiniMax 2013 code is a generic invalid-params code.
    expect(oversized("400 invalid params (2013)")).toBe(false);
    expect(oversized("400 Bad Request")).toBe(false);
    expect(oversized("prompt is too long", 503)).toBe(false);
    expect(oversized("429 rate limited: request too large for TPM")).toBe(false);
    expect(oversized("Request body too large: timeout while uploading")).toBe(false);
    expect(oversized("401 invalid api key")).toBe(false);
  });

  it("classifies the BYOK-attributed form of an oversized request", () => {
    const byok = (detail: string) =>
      `BYOK upstream error: ${JSON.stringify({
        errorCode: LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
        message: `BYOK provider custom_provider:fixture upstream error: ${detail}`,
        errorSource: "byok_upstream",
        errorDetail: detail,
        errorProviderId: "custom_provider:fixture",
      })}`;
    expect(rejection(byok("413 Payload Too Large"))).toBe(true);
    expect(rejection(byok("400 invalid params, context window exceeds limit (2013)"))).toBe(true);
    expect(rejection(byok("503 Service Unavailable"))).toBe(false);
  });

  it("treats a gateway invalid_argument rejection as deterministic even inside a 500", () => {
    const detail =
      "500 upstream error (invalid_argument): There is an issue with this request, please try a different model. (request id: abc)";
    const byok = `BYOK upstream error: ${JSON.stringify({
      errorCode: LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
      message: `BYOK provider custom_provider:test-gateway upstream error: ${detail}`,
      errorSource: "byok_upstream",
      errorDetail: detail,
      errorProviderId: "custom_provider:test-gateway",
    })}`;
    expect(rejection(detail)).toBe(true);
    expect(rejection(detail, 500)).toBe(true);
    expect(rejection(byok)).toBe(true);
    expect(rejection("upstream error (invalid_argument): bad", 503)).toBe(false);
    expect(rejection("upstream error (invalid_argument): bad", 529)).toBe(false);
    expect(rejection("upstream error (invalid_argument): bad", 429)).toBe(false);
    // A bare invalid_request_error inside a 5xx stays retryable.
    expect(rejection("invalid_request_error", 500)).toBe(false);
  });
});


describe('oversized request retry regression', () => {
  // A request that is too large (HTTP 413, request_too_large, the local
  // pre-send body check, or a context-window overflow) is rejected again on
  // every resend; the BYOK retry-all budget used to send it six times.
  it.each([
    ["minimax_api", "413 Request Entity Too Large"],
    ["minimax_api", '413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed number of bytes."}}'],
    ["custom_provider:work", "413 Payload Too Large"],
    ["custom_provider:work", "413 status code (no body)"],
    ["minimax_api", "Request body too large: 70000000 bytes exceeds client limit 67108864 bytes."],
    ["minimax_api", "400 invalid params, context window exceeds limit (2013)"],
    ["custom_provider:work", '400 {"error":{"message":"prompt is too long: 600000 tokens > 512000 maximum"}}'],
    ["custom_provider:work", "400 Failed to buffer the request body: length limit exceeded"],
    ["custom_provider:work", "400 Request payload size exceeds the limit: 20971520 bytes."],
    ["custom_provider:work", "400 total message size 5943865 exceeds limit 2097152"],
    ["custom_provider:work", '400 {"error":{"code":"1261","message":"Prompt exceeds max length"}}'],
    ["custom_provider:work", "400 <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 202745]"],
    ["minimax", "413 Request Entity Too Large"],
    ["minimax", "Request body too large: 70000000 bytes exceeds client limit 67108864 bytes."],
  ])("sends an oversized request from %s only once: %s", async (provider, message) => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const inner = (async () => {
      attempts += 1;
      return errorStream(message);
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ sleep }));

    const events = await collectEvents(await wrapped(fakeModel(provider), CONTEXT, {}));

    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    const error = events.find((event) => event.type === "error");
    expect(error?.type === "error" ? error.error.errorMessage : undefined).toBe(message);
  });
});

describe('gateway content_error retry regression', () => {
  // 网关审核结论是确定的：通用重试只会重复同一结论、重复计费，还会把 action=4 的
  // 单次重发、整轮撤回等处理推迟到整个退避窗口之后。重发由 runner 按 action 决定。
  const body = (error: Record<string, unknown>) =>
    JSON.stringify({
      type: 'error',
      error: { type: 'content_error', message: 'content unavailable', ...error },
    });
  it.each([
    ['minimax', body({ code: 50201, action: 4, guide_prompt: 'guide', request_id: 'req-1' })],
    ['minimax', body({ code: 50200, request_id: 'req-2' })],
    ['minimax', `400 ${body({ code: 50201, action: 2, request_id: 'req-3' })}`],
    ['custom_provider:work', body({ code: 50201, action: 4, guide_prompt: 'guide', request_id: 'req-4' })],
    ['minimax_api', body({ code: 50200, request_id: 'req-5' })],
  ])('sends a content_error request from %s only once: %s', async (provider, message) => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const inner = (async () => {
      attempts += 1;
      return errorStream(message);
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ sleep }));

    const events = await collectEvents(await wrapped(fakeModel(provider), CONTEXT, {}));

    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  it('does not retry a content_error thrown by the provider stream function', async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const inner = (async () => {
      attempts += 1;
      throw new Error(body({ code: 50201, action: 3, suggestion: 'fixed', request_id: 'req-6' }));
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ sleep }));

    await expect(
      Promise.resolve().then(() => wrapped(fakeModel('custom_provider:work'), CONTEXT, {})),
    ).rejects.toThrow('content_error');
    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('unified backoff', () => {
  // The failures that reach a retry recover on the provider's clock: a 429
  // window, a 529 overload or a gateway 5xx lasts tens of seconds to minutes.
  // So every retryable reason backs off the same way, from the same budget.
  it('pins the default budget', () => {
    expect(DEFAULT_LLM_RETRY_POLICY).toEqual({
      maxRetries: 10,
      baseDelayMs: 5_000,
      maxDelayMs: 30_000,
      maxRetryElapsedMs: 300_000,
    });
  });

  it.each([
    ['fake-provider', '[Error] 429 Too Many Requests', 'rate_limited'],
    ['fake-provider', '[Error] 529 overloaded', 'overloaded'],
    ['fake-provider', 'net::ERR_SSL_BAD_RECORD_MAC_ALERT', 'network'],
    ['custom_provider:work', '502 Bad Gateway', 'server_error'],
    ['custom_provider:work', '[Error] 400 Bad Request', 'bad_request'],
  ] as const)('backs off %s "%s" on the one schedule and keeps its reason', async (provider, message, reason) => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const sleep = vi.fn(async () => {});
    const inner = (async () => {
      attempts += 1;
      return errorStream(message);
    }) as StreamFn;

    await collectEvents(
      await withLLMRetry(
        inner,
        retryOptions({ sleep, observer: (event: LLMRetryEvent) => observed.push(event) }),
      )(fakeModel(provider), CONTEXT, {}),
    );

    expect(attempts).toBe(RETRIES + 1);
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual(ZERO_JITTER_DELAYS);
    expect(observed.find((event) => event.status === 'waiting')?.error?.reason).toBe(reason);
    expect(observed.at(-1)).toMatchObject({ status: 'exhausted', retryAttempt: RETRIES, maxRetries: RETRIES });
  });

  it('fits every wait inside the elapsed window at full jitter', async () => {
    const sleep = vi.fn(async () => {});
    const inner = (async () => errorStream('[Error] 529 overloaded')) as StreamFn;

    await collectEvents(
      await withLLMRetry(inner, retryOptions({ sleep, random: () => 1 }))(fakeModel(), CONTEXT, {}),
    );

    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([
      5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000,
    ]);
    const waited = sleep.mock.calls.reduce((sum, [delayMs]) => sum + (delayMs as number), 0);
    expect(waited).toBe(245_000);
    expect(waited).toBeLessThanOrEqual(DEFAULT_LLM_RETRY_POLICY.maxRetryElapsedMs);
  });

  it('ends at the elapsed window before the retry count when the failing requests are slow', async () => {
    let now = 0;
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    // Each failing request itself takes 40 s.
    const inner = (async () => {
      attempts += 1;
      now += 40_000;
      return errorStream('[Error] 529 overloaded');
    }) as StreamFn;

    await collectEvents(
      await withLLMRetry(
        inner,
        retryOptions({
          nowMs: () => now,
          sleep: vi.fn(async (delayMs: number) => {
            now += delayMs;
          }),
          observer: (event: LLMRetryEvent) => observed.push(event),
        }),
      )(fakeModel(), CONTEXT, {}),
    );

    // Failures end at 40, 82.5, 127.5, 177.5, 232.5, 287.5 and 342.5 s; the
    // wait after the seventh would end 317.5 s after the first failure.
    expect(attempts).toBe(7);
    expect(attempts).toBeLessThan(RETRIES + 1);
    expect(observed.at(-1)).toMatchObject({ status: 'exhausted', retryAttempt: 6 });
  });
});
