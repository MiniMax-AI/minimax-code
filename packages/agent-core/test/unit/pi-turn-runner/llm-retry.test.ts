import { describe, expect, it, vi } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { LLM_ERROR_CODES } from "@mavis/shared/llm-error-classifier";
import {
  DEFAULT_LLM_RETRY_POLICY,
  LLM_RETRY_REQUEST_SETTLED_OBSERVER,
  withLLMRetry,
  type LLMCallSettledEvent,
  type LLMRequestSettledEvent,
  type LLMRetryEvent,
} from "../../../src/pi-turn-runner/llm-retry.js";

function fakeModel(provider = "fake-provider"): Model<any> {
  return {
    id: "fake-model",
    name: "fake-model",
    api: "test-messages",
    provider,
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  } as Model<any>;
}

const CONTEXT: Context = { messages: [] };

function assistant(
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"],
  errorMessage?: string,
  usage?: Partial<AssistantMessage["usage"]>,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test-messages",
    provider: "fake-provider",
    model: "fake-model",
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
          if (index < events.length)
            return { value: events[index++], done: false };
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
  const empty = assistant("stop", []);
  const partial = assistant("stop", [{ type: "text", text }]);
  const final = assistant("stop", [{ type: "text", text }]);
  return stream(
    [
      { type: "start", partial: empty },
      { type: "text_start", contentIndex: 0, partial: empty },
      { type: "text_delta", contentIndex: 0, delta: text, partial },
      { type: "text_end", contentIndex: 0, content: text, partial },
      { type: "done", reason: "stop", message: final },
    ],
    final,
  );
}

function errorStream(
  message: string,
  partialText = "",
  usage?: Partial<AssistantMessage["usage"]>,
): AssistantMessageEventStream {
  const empty = assistant("error", []);
  const content = partialText
    ? [{ type: "text" as const, text: partialText }]
    : [];
  const partial = assistant("error", content);
  const final = assistant("error", content, message, usage);
  return stream(
    [
      { type: "start", partial: empty },
      ...(partialText
        ? ([
            { type: "text_start", contentIndex: 0, partial: empty },
            {
              type: "text_delta",
              contentIndex: 0,
              delta: partialText,
              partial,
            },
          ] satisfies AssistantMessageEvent[])
        : []),
      { type: "error", reason: "error", error: final },
    ],
    final,
  );
}

async function collectEvents(
  value: Awaited<ReturnType<StreamFn>>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of value) events.push(event);
  return events;
}

function retryOptions(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    scope: "agent" as const,
    generateCallId: () => "call-1",
    random: () => 0,
    nowMs: () => 1_000,
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("withLLMRetry", () => {
  it("observes each physical provider request, including a retry that fails first", async () => {
    let attempts = 0;
    const physical: LLMRequestSettledEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return errorStream("[Error] 429 Too Many Requests", "", {
          input: 11,
          output: 2,
          cacheRead: Number.NaN,
          cacheWrite: 4,
        });
      }
      const final = assistant(
        "stop",
        [{ type: "text", text: "ok" }],
        undefined,
        {
          input: 17,
          output: 3,
          cacheRead: 5,
          cacheWrite: 7,
        },
      );
      return stream([{ type: "done", reason: "stop", message: final }], final);
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
        outcome: "error",
        usage: { input: 11, output: 2, cacheRead: 0, cacheWrite: 4 },
        usageComplete: false,
      },
      {
        requestAttempt: 2,
        outcome: "success",
        usage: { input: 17, output: 3, cacheRead: 5, cacheWrite: 7 },
        usageComplete: true,
      },
    ]);
  });

  it("disables provider-native retries so the framework owns the request budget", async () => {
    const maxRetries: Array<number | undefined> = [];
    const inner = ((_model, _context, options) => {
      maxRetries.push(options?.maxRetries);
      return successStream("ok");
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions());

    const result = await wrapped(fakeModel(), CONTEXT, { maxRetries: 9 });
    await collectEvents(result);

    expect(maxRetries).toEqual([0]);
  });

  it("discards a pre-commit 429 attempt and exposes only the recovered stream", async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return attempts === 1
        ? errorStream("[Error] 429 Too Many Requests")
        : successStream("ok");
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
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(sleep).toHaveBeenCalledWith(500, undefined);
    expect(observed).toMatchObject([
      {
        callId: "call-1",
        status: "waiting",
        retryAttempt: 1,
        maxRetries: 5,
        requestAttempt: 2,
        delayMs: 500,
        error: { reason: "rate_limited" },
      },
      {
        callId: "call-1",
        status: "recovered",
        retryAttempt: 1,
        maxRetries: 5,
        requestAttempt: 2,
      },
    ]);
    await result.result();
    expect(settled).toMatchObject([
      {
        sessionId: "session-1",
        turnId: "turn-1",
        callId: "call-1",
        scope: "agent",
        provider: "fake-provider",
        model: "fake-model",
        final: { outcome: "success", errorKind: "none" },
        retryTriggered: true,
        retryReason: "rate_limited",
        requestAttempts: 2,
        // Successful calls carry the raw provider buckets; this fixture reports
        // an all-zero usage.
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it("settles a successful logical Call with only its normalized tool identities", async () => {
    const final = assistant("toolUse", [
      {
        type: "toolCall",
        id: "tool-1",
        name: "read",
        arguments: { path: "README.md" },
      },
    ]);
    const settled: LLMCallSettledEvent[] = [];
    const wrapped = withLLMRetry(
      (async () =>
        stream(
          [{ type: "done", reason: "toolUse", message: final }],
          final,
        )) as StreamFn,
      retryOptions({
        onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
      }),
    );

    await (await wrapped(fakeModel(), CONTEXT, {})).result();

    expect(settled[0]?.expectedTools).toEqual([
      { toolCallId: "tool-1", toolName: "read" },
    ]);
    expect(settled[0]).not.toHaveProperty("assistantMessage");
    expect(JSON.stringify(settled[0])).not.toContain("README.md");
  });

  it("does not count a committed retry stream as recovered when its final result fails", async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return attempts === 1
        ? errorStream("[Error] 429 Too Many Requests")
        : errorStream("ECONNRESET", "partial");
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

    expect(observed.map((event) => event.status)).toEqual([
      "waiting",
      "recovered",
    ]);
    expect(settled).toMatchObject([
      {
        final: { outcome: "error", errorKind: "network" },
        retryTriggered: true,
        retryReason: "rate_limited",
        requestAttempts: 2,
      },
    ]);
  });

  it.each([2056, 2067])(
    "never retries Token Plan exhaustion status %i even when the outer status looks transient",
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
      expect(events.at(-1)?.type).toBe("error");
      expect(observed).toEqual([]);
      await result.result();
      expect(settled).toMatchObject([
        {
          final: { outcome: "error", errorKind: "usage_limit" },
          retryTriggered: false,
          requestAttempts: 1,
        },
      ]);
    },
  );

  it("does not report recovered when a retry ends in a non-retryable quota error", async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return attempts === 1
        ? errorStream("[Error] 429 Too Many Requests")
        : errorStream(
            '[Error] 500 {"status_code":2056,"status_msg":"plan exhausted"}',
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
    await collectEvents(result);

    expect(attempts).toBe(2);
    expect(observed.map((event) => event.status)).toEqual([
      "waiting",
      "exhausted",
    ]);
    expect(observed.at(-1)?.error).toEqual({
      reason: "usage_limit",
      code: LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED,
      message: "LLM usage limit reached",
    });
    await expect(result.result()).resolves.toMatchObject({
      errorMessage:
        '[Error] 500 {"status_code":2056,"status_msg":"plan exhausted"}',
    });
    expect(settled).toMatchObject([
      {
        final: { outcome: "error", errorKind: "usage_limit" },
        retryTriggered: true,
        retryReason: "rate_limited",
        requestAttempts: 2,
      },
    ]);
  });

  it.each([
    {
      finalError: "[Error] 401 invalid api key",
      expectedReason: "auth",
      expectedCode: LLM_ERROR_CODES.LLM_AUTH_ERROR,
      expectedMessage: "LLM provider authentication failed",
    },
    {
      finalError: "[Error] 503 upstream unavailable",
      expectedReason: "server_error",
      expectedCode: LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
      expectedMessage: "LLM provider request failed",
    },
  ])(
    "attributes an exhausted retry to the final $expectedReason failure",
    async ({ finalError, expectedReason, expectedCode, expectedMessage }) => {
      let attempts = 0;
      const observed: LLMRetryEvent[] = [];
      const settled: LLMCallSettledEvent[] = [];
      const inner = (async () => {
        attempts += 1;
        return attempts === 1
          ? errorStream("[Error] 429 Too Many Requests")
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
        status: "exhausted",
        error: {
          reason: expectedReason,
          code: expectedCode,
          message: expectedMessage,
        },
      });
      await expect(result.result()).resolves.toMatchObject({
        errorMessage: finalError,
      });
      expect(settled).toMatchObject([
        {
          final: { outcome: "error", errorKind: expectedReason },
          retryTriggered: true,
          retryReason: "rate_limited",
          requestAttempts: 2,
        },
      ]);
    },
  );

  it("retries a network error thrown before a stream is returned", async () => {
    let attempts = 0;
    const inner = (async () => {
      attempts += 1;
      if (attempts === 1)
        throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      return successStream("ok");
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions());

    const result = await wrapped(fakeModel(), CONTEXT, {});
    expect((await collectEvents(result)).at(-1)?.type).toBe("done");
    expect(attempts).toBe(2);
  });

  it("uses five retries by default and emits exhausted after the sixth request", async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const sleep = vi.fn(async () => {});
    const inner = (async () => {
      attempts += 1;
      return errorStream("[Error] 529 overloaded");
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

    expect(DEFAULT_LLM_RETRY_POLICY.maxRetries).toBe(5);
    expect(attempts).toBe(6);
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([
      500, 1_000, 2_000, 4_000, 8_000,
    ]);
    expect(observed.filter((event) => event.status === "waiting")).toHaveLength(
      5,
    );
    expect(observed.at(-1)).toMatchObject({
      status: "exhausted",
      retryAttempt: 5,
      maxRetries: 5,
      requestAttempt: 6,
      error: { reason: "overloaded" },
    });
    await result.result();
    expect(settled).toMatchObject([
      {
        final: { outcome: "error", errorKind: "overloaded" },
        retryTriggered: true,
        retryReason: "overloaded",
        requestAttempts: 6,
      },
    ]);
  });

  it("limits BYOK errors to five retries regardless of error classification", async () => {
    let attempts = 0;
    const inner = (async () => {
      attempts += 1;
      return errorStream("[Error] 401 invalid api key");
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({ sleep: vi.fn(async () => {}) }),
    );

    const result = await wrapped(fakeModel("minimax_api"), CONTEXT, {});
    await collectEvents(result);

    expect(attempts).toBe(6);
  });

  it("keeps the exhausted attempt open when returning its terminal failure stream", async () => {
    const attemptReturns: Array<ReturnType<typeof vi.fn>> = [];
    const inner = (async () => {
      const failed = errorStream("[Error] 529 overloaded");
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
          if (cancelled) throw new Error("provider stream was cancelled");
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

    expect(events.at(-1)?.type).toBe("error");
    await expect(result.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "[Error] 529 overloaded",
    });
    expect(attemptReturns).toHaveLength(2);
    expect(attemptReturns[0]).toHaveBeenCalledOnce();
    expect(attemptReturns[1]).not.toHaveBeenCalled();
  });

  it("settles result-only calls when every attempt disconnects before the first token", async () => {
    const disconnect = Object.assign(
      new Error("socket reset before first token"),
      {
        code: "ECONNRESET",
      },
    );
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
    const timeout = Symbol("result timeout");
    const outcome = await Promise.race([
      result.result().catch((error: unknown) => error),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(timeout), 100)),
    ]);

    expect(attempts).toBe(2);
    expect(outcome).toBe(disconnect);
    expect(settled).toMatchObject([
      {
        final: { outcome: "error", errorKind: "network" },
        retryTriggered: true,
        retryReason: "network",
        requestAttempts: 2,
      },
    ]);
  });

  it("stops before a backoff that would exceed the retry elapsed-time budget", async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const sleep = vi.fn(async () => {});
    const inner = (async () => {
      attempts += 1;
      return errorStream("[Error] 429 Too Many Requests");
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
      { status: "exhausted", retryAttempt: 0, requestAttempt: 1 },
    ]);
  });

  it("initiates cleanup for a discarded attempt before the next provider request", async () => {
    let attempts = 0;
    const discardedReturn = vi.fn(async () => ({
      value: undefined,
      done: true as const,
    }));
    const inner = (async () => {
      attempts += 1;
      if (attempts > 1) return successStream("ok");
      const failed = errorStream("[Error] 429 Too Many Requests");
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

  it("does not retry a disconnect after a visible text delta has committed", async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return errorStream("ECONNRESET", "partial");
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        observer: (event: LLMRetryEvent) => observed.push(event),
      }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    const events = await collectEvents(result);

    expect(attempts).toBe(1);
    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
    expect(observed).toEqual([]);
  });

  it.each(["throw", "stream"] as const)(
    "recovers a TLS record failure from %s before output",
    async (failureKind) => {
      let attempts = 0;
      const observed: LLMRetryEvent[] = [];
      const inner = (async () => {
        attempts += 1;
        if (attempts === 1) {
          if (failureKind === "throw") {
            throw Object.assign(new Error("TLS record failure"), {
              code: "ERR_SSL_BAD_RECORD_MAC_ALERT",
            });
          }
          return errorStream("net::ERR_SSL_BAD_RECORD_MAC_ALERT");
        }
        return successStream("recovered");
      }) as StreamFn;
      const wrapped = withLLMRetry(
        inner,
        retryOptions({ observer: (event: LLMRetryEvent) => observed.push(event) }),
      );

      const result = await wrapped(fakeModel("minimax"), CONTEXT, {});
      const events = await collectEvents(result);

      expect(attempts).toBe(2);
      expect(observed.map((event) => event.status)).toEqual(["waiting", "recovered"]);
      expect(observed[0]?.error?.reason).toBe("network");
      expect(events.some((event) => event.type === "error")).toBe(false);
      await expect(result.result()).resolves.toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "recovered" }],
      });
    },
  );

  it("does not retry a TLS record failure after visible output", async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return errorStream("net::ERR_SSL_BAD_RECORD_MAC_ALERT", "partial");
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({ observer: (event: LLMRetryEvent) => observed.push(event) }),
    );

    const result = await wrapped(fakeModel(), CONTEXT, {});
    const events = await collectEvents(result);

    expect(attempts).toBe(1);
    expect(events.at(-1)?.type).toBe("error");
    expect(observed).toEqual([]);
  });

  it.each(["fake-provider", "custom_provider:work"])(
    "treats a model safety refusal from %s as a terminal content_filter without retrying",
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
      expect(events.at(-1)?.type).toBe("error");
      expect((await result.result()).errorMessage).toContain("stop_reason: refusal");
      expect(settled).toMatchObject([
        { retryTriggered: false, final: { outcome: "error", errorKind: "content_filter" } },
      ]);
    },
  );

  it("commits BYOK streaming after visible output in every host composition", async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return errorStream("[Error] 401 invalid api key", "partial");
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        observer: (event: LLMRetryEvent) => observed.push(event),
        sleep: vi.fn(async () => {}),
      }),
    );

    const result = await wrapped(
      fakeModel("custom_provider:work"),
      CONTEXT,
      {},
    );
    const events = await collectEvents(result);

    expect(attempts).toBe(1);
    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("error");
    expect(observed).toEqual([]);
  });

  it("retries a BYOK provider stream that ended without any message event", async () => {
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      return attempts === 1
        ? errorStream(
            "Provider stream ended without any message events (rawEventCount=0; messageEventCount=0; firstEventAtMs=none; lastEventAtMs=none; eofAtMs=61000)",
          )
        : successStream("recovered");
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        observer: (event: LLMRetryEvent) => observed.push(event),
        sleep: vi.fn(async () => {}),
      }),
    );

    const result = await wrapped(
      fakeModel("custom_provider:byok-gateway"),
      CONTEXT,
      {},
    );
    const events = await collectEvents(result);

    expect(attempts).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect((await result.result()).stopReason).toBe("stop");
    expect(observed).toMatchObject([
      {
        status: "waiting",
        retryAttempt: 1,
        requestAttempt: 2,
        error: { reason: "network" },
      },
      { status: "recovered", retryAttempt: 1, requestAttempt: 2 },
    ]);
  });

  it("returns a BYOK stream before the provider finishes after its first visible delta", async () => {
    const empty = assistant("error", []);
    const partial = assistant("error", [
      { type: "thinking", thinking: "live" },
    ]);
    const final = assistant(
      "error",
      [{ type: "thinking", thinking: "live" }],
      "late disconnect",
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
              if (index === 1)
                return {
                  value: { type: "start", partial: empty },
                  done: false,
                };
              if (index === 2) {
                return {
                  value: {
                    type: "thinking_delta",
                    contentIndex: 0,
                    delta: "live",
                    partial,
                  },
                  done: false,
                };
              }
              await tail;
              if (index === 3) {
                return {
                  value: { type: "error", reason: "error", error: final },
                  done: false,
                };
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
    const wrapped = withLLMRetry(
      inner,
      retryOptions({ sleep: vi.fn(async () => {}) }),
    );
    const committed = wrapped(
      fakeModel("custom_provider:work"),
      CONTEXT,
      {},
    ).then((result) => {
      order.push("committed");
      return result;
    });
    setTimeout(() => {
      order.push("tail");
      releaseTail();
    }, 0);

    const result = await committed;
    expect(order[0]).toBe("committed");
    expect(
      (await collectEvents(result)).some(
        (event) => event.type === "thinking_delta",
      ),
    ).toBe(true);
    expect(attempts).toBe(1);
  });

  it("honors a bounded Retry-After response header", async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const inner = (async (model, _context, options) => {
      attempts += 1;
      if (attempts === 1) {
        await options?.onResponse?.(
          { status: 429, headers: { "retry-after": "300" } },
          model,
        );
        return errorStream("provider throttled");
      }
      return successStream("ok");
    }) as StreamFn;
    const wrapped = withLLMRetry(inner, retryOptions({ sleep }));

    const result = await wrapped(fakeModel(), CONTEXT, {});
    await collectEvents(result);

    expect(sleep).toHaveBeenCalledWith(30_000, undefined);
  });

  it("cancels an in-flight backoff without starting another request", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const settled: LLMCallSettledEvent[] = [];
    const sleep = vi.fn(
      async (_delayMs: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("sleep aborted")),
            { once: true },
          );
        }),
    );
    const inner = (async () => {
      attempts += 1;
      return errorStream("[Error] 429 Too Many Requests");
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        sleep,
        observer: (event: LLMRetryEvent) => observed.push(event),
        onCallSettled: (event: LLMCallSettledEvent) => settled.push(event),
      }),
    );

    const pending = wrapped(fakeModel(), CONTEXT, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
    controller.abort("user_stop");

    await expect(pending).rejects.toThrow("sleep aborted");
    expect(attempts).toBe(1);
    expect(observed.at(-1)).toMatchObject({
      status: "cancelled",
      retryAttempt: 1,
      requestAttempt: 2,
    });
    expect(settled).toMatchObject([
      {
        final: { outcome: "abort", errorKind: "abort" },
        retryTriggered: true,
        retryReason: "rate_limited",
        requestAttempts: 1,
      },
    ]);
  });

  it("reports cancellation when the user aborts an active retry attempt", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const observed: LLMRetryEvent[] = [];
    const inner = (async () => {
      attempts += 1;
      if (attempts === 1) return errorStream("[Error] 429 Too Many Requests");
      controller.abort("user_stop");
      throw new DOMException("The operation was aborted", "AbortError");
    }) as StreamFn;
    const wrapped = withLLMRetry(
      inner,
      retryOptions({
        observer: (event: LLMRetryEvent) => observed.push(event),
      }),
    );

    await expect(
      wrapped(fakeModel(), CONTEXT, { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(attempts).toBe(2);
    expect(observed.map((event) => event.status)).toEqual([
      "waiting",
      "cancelled",
    ]);
  });
});
