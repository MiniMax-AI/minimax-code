import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RuntimeEventStatus,
  RuntimeEventType,
  type RuntimeEvent,
} from "../../../src/protocol/runtime-event.js";
import {
  LLM_FIRST_EVENT_TIMEOUT_ENV,
  LLM_FIRST_EVENT_TIMEOUT_MS,
  LLM_STREAM_IDLE_TIMEOUT_ENV,
  LLM_STREAM_IDLE_TIMEOUT_MS,
} from "../../../src/pi-turn-runner/defaults.js";
import { composeStreamFn } from "../../../src/pi-turn-runner/llm.js";
import { withLLMRetry } from "../../../src/pi-turn-runner/llm-retry.js";
import {
  LLM_STREAM_TIMEOUT_MESSAGE_PREFIX,
  resolveLLMStreamTimeouts,
  withLLMStreamTimeouts,
} from "../../../src/pi-turn-runner/llm-stream-timeout.js";
import { PiTurnRunner } from "../../../src/pi-turn-runner/pi-turn-runner.js";

// Regression coverage for #425: a provider that accepts the request but never
// answers used to hold the turn for the transport default (~300 s). The
// watchdog must fail the attempt within its bound so the existing retry path
// runs, and the session must accept new input afterwards.

const CONTEXT: Context = { messages: [] };

function fakeModel(provider = "custom_provider:test"): Model<any> {
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

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "test-messages",
    provider: "custom_provider:test",
    model: "fake-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  } as AssistantMessage;
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** A provider stub that accepts the call and never emits anything, ignoring abort. */
function neverResponding(signals: AbortSignal[]): StreamFn {
  return ((_model, _context, options) => {
    if (options?.signal) signals.push(options.signal);
    return createAssistantMessageEventStream();
  }) as StreamFn;
}

describe("withLLMStreamTimeouts", () => {
  it("fails a never-answered request as a retryable error within the first-event bound", async () => {
    const signals: AbortSignal[] = [];
    const wrapped = withLLMStreamTimeouts(neverResponding(signals), {
      firstEventTimeoutMs: 50,
      idleTimeoutMs: 0,
    });
    const started = Date.now();
    const stream = await wrapped(fakeModel(), CONTEXT, {});
    const events = await collect(stream);
    const final = await stream.result();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(1_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", reason: "error" });
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toContain(LLM_STREAM_TIMEOUT_MESSAGE_PREFIX);
    expect(final.errorMessage).toContain("within 50ms");
    expect(final.errorMessage).toContain(LLM_FIRST_EVENT_TIMEOUT_ENV);
    expect(final.errorMessage).toContain("firstEventTimeoutMs");
    expect(final.errorMessage).not.toContain(LLM_STREAM_IDLE_TIMEOUT_ENV);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  });

  it("fails a stream that stalls after its first event within the idle bound", async () => {
    let signal: AbortSignal | undefined;
    const partial = assistant("");
    const inner = ((_model, _context, options) => {
      signal = options?.signal;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial });
      return stream;
    }) as StreamFn;
    const wrapped = withLLMStreamTimeouts(inner, { firstEventTimeoutMs: 1_000, idleTimeoutMs: 60 });
    const stream = await wrapped(fakeModel(), CONTEXT, {});
    const events = await collect(stream);
    const final = await stream.result();

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toContain("idle for 60ms");
    expect(final.errorMessage).toContain(LLM_STREAM_IDLE_TIMEOUT_ENV);
    expect(final.errorMessage).toContain("streamIdleTimeoutMs");
    expect(final.errorMessage).not.toContain(LLM_FIRST_EVENT_TIMEOUT_ENV);
    expect(signal?.aborted).toBe(true);
  });

  it("passes a healthy stream through and does not fire after completion", async () => {
    const message = assistant("hello");
    const inner = (() => {
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        stream.push({ type: "start", partial: assistant("") });
        stream.push({ type: "text_start", contentIndex: 0, partial: assistant("") });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      }, 10);
      return stream;
    }) as StreamFn;
    const wrapped = withLLMStreamTimeouts(inner, { firstEventTimeoutMs: 40, idleTimeoutMs: 40 });
    const stream = await wrapped(fakeModel(), CONTEXT, {});
    const events = await collect(stream);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "done"]);
    expect(await stream.result()).toBe(message);
  });

  it("reports a caller abort as aborted, never as a timeout", async () => {
    const caller = new AbortController();
    const inner = ((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        const error = { ...assistant(""), stopReason: "aborted" as const, errorMessage: "Request was aborted" };
        stream.push({ type: "error", reason: "aborted", error });
        stream.end();
      });
      return stream;
    }) as StreamFn;
    const wrapped = withLLMStreamTimeouts(inner, { firstEventTimeoutMs: 100, idleTimeoutMs: 100 });
    const stream = await wrapped(fakeModel(), CONTEXT, { signal: caller.signal });
    setTimeout(() => caller.abort(), 10);
    const final = await stream.result();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(final.stopReason).toBe("aborted");
    expect(final.errorMessage ?? "").not.toContain(LLM_STREAM_TIMEOUT_MESSAGE_PREFIX);
  });

  it.each(["first", "idle"] as const)(
    "stops reading a stream that ignores abort after the %s bound fires",
    async (phase) => {
      let nextCalls = 0;
      let returnCalls = 0;
      // Yields `start` (idle case only), then never yields or settles again and
      // ignores the abort signal entirely.
      const ignoresAbort = {
        [Symbol.asyncIterator]() {
          let yieldedStart = phase === "first";
          return {
            next(): Promise<IteratorResult<AssistantMessageEvent>> {
              nextCalls += 1;
              if (!yieldedStart) {
                yieldedStart = true;
                return Promise.resolve({ done: false, value: { type: "start", partial: assistant("") } });
              }
              return new Promise(() => undefined);
            },
            return(): Promise<IteratorResult<AssistantMessageEvent>> {
              returnCalls += 1;
              return new Promise(() => undefined);
            },
          };
        },
        result: () => new Promise<AssistantMessage>(() => undefined),
      };
      const inner = (() => ignoresAbort) as unknown as StreamFn;
      const wrapped = withLLMStreamTimeouts(inner, { firstEventTimeoutMs: 40, idleTimeoutMs: 40 });
      const started = Date.now();
      const stream = await wrapped(fakeModel(), CONTEXT, {});
      const events = await collect(stream);
      const final = await stream.result();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
      expect(final.errorMessage).toContain(LLM_STREAM_TIMEOUT_MESSAGE_PREFIX);
      // The read loop left the pending next() and released the iterator.
      expect(nextCalls).toBe(phase === "first" ? 1 : 2);
      expect(returnCalls).toBe(1);
    },
  );

  it("stops waiting for a provider call that never returns its stream", async () => {
    const inner = (() => new Promise(() => undefined)) as unknown as StreamFn;
    const wrapped = withLLMStreamTimeouts(inner, { firstEventTimeoutMs: 40, idleTimeoutMs: 0 });
    const stream = await wrapped(fakeModel(), CONTEXT, {});
    const final = await stream.result();

    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toContain("within 40ms");
  });

  it("returns the inner StreamFn unchanged when both bounds are disabled", () => {
    const inner = neverResponding([]);
    expect(withLLMStreamTimeouts(inner, { firstEventTimeoutMs: 0, idleTimeoutMs: 0 })).toBe(inner);
  });
});

describe("resolveLLMStreamTimeouts", () => {
  it("defaults both bounds to the previous effective transport wait", () => {
    expect(LLM_FIRST_EVENT_TIMEOUT_MS).toBe(300_000);
    expect(LLM_STREAM_IDLE_TIMEOUT_MS).toBe(300_000);
  });

  it("uses defaults, then environment overrides, then explicit host config", () => {
    expect(resolveLLMStreamTimeouts({}, {})).toEqual({
      firstEventTimeoutMs: LLM_FIRST_EVENT_TIMEOUT_MS,
      idleTimeoutMs: LLM_STREAM_IDLE_TIMEOUT_MS,
    });
    const env = { [LLM_FIRST_EVENT_TIMEOUT_ENV]: "5000", [LLM_STREAM_IDLE_TIMEOUT_ENV]: "0" };
    expect(resolveLLMStreamTimeouts({}, env)).toEqual({ firstEventTimeoutMs: 5_000, idleTimeoutMs: 0 });
    expect(
      resolveLLMStreamTimeouts({ firstEventTimeoutMs: 7, streamIdleTimeoutMs: 9 }, env),
    ).toEqual({ firstEventTimeoutMs: 7, idleTimeoutMs: 9 });
  });

  it("ignores invalid values", () => {
    const env = { [LLM_FIRST_EVENT_TIMEOUT_ENV]: "soon", [LLM_STREAM_IDLE_TIMEOUT_ENV]: "-1" };
    expect(resolveLLMStreamTimeouts({ firstEventTimeoutMs: -5, streamIdleTimeoutMs: 1.5 }, env)).toEqual({
      firstEventTimeoutMs: LLM_FIRST_EVENT_TIMEOUT_MS,
      idleTimeoutMs: LLM_STREAM_IDLE_TIMEOUT_MS,
    });
  });
});

describe("hung OpenAI-compatible provider (real HTTP transport)", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  /** Requests to leave unanswered (headers never sent) before answering normally. */
  let hangFirst: number;
  let requests: number;
  const hung: ServerResponse[] = [];

  function respond(request: IncomingMessage, response: ServerResponse): void {
    requests += 1;
    // Drain the body, then either hold the socket open forever or answer.
    request.resume();
    request.on("end", () => {
      if (requests <= hangFirst) {
        hung.push(response);
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          model: "fixture-model",
          choices: [{ index: 0, delta: { content: "PONG" }, finish_reason: null }],
        })}\n\n`,
      );
      response.end(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
  }

  function model(provider: string): Model<"openai-completions"> {
    return {
      id: "fixture-model",
      name: "Fixture model",
      api: "openai-completions",
      provider,
      baseUrl,
      reasoning: false,
      input: ["text"],
      contextWindow: 32_768,
      maxTokens: 1_024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  beforeEach(async () => {
    requests = 0;
    hangFirst = 0;
    hung.length = 0;
    server = createServer(respond);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each(["custom_provider:fixture", "openai"])(
    "retries a hung %s request after the first-event bound and recovers",
    async (provider) => {
      hangFirst = 1;
      const streamFn = withLLMRetry(
        composeStreamFn({ model: model(provider), apiKey: "synthetic", firstEventTimeoutMs: 200 }),
        {
          sessionId: "session-425",
          turnId: "turn-1",
          scope: "agent",
          policy: { baseDelayMs: 10, maxDelayMs: 10 },
        },
      );
      const started = Date.now();
      const stream = await streamFn(
        model(provider),
        { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
        { apiKey: "synthetic" },
      );
      await collect(stream);
      const final = await stream.result();
      const elapsed = Date.now() - started;

      expect(final.stopReason).toBe("stop");
      expect(final.content).toEqual([{ type: "text", text: "PONG" }]);
      expect(requests).toBe(2);
      expect(elapsed).toBeGreaterThanOrEqual(190);
      expect(elapsed).toBeLessThan(5_000);
    },
  );

  it("fails the turn within the bound and the next turn on the same runner succeeds", async () => {
    hangFirst = Number.POSITIVE_INFINITY;
    const runner = new PiTurnRunner();
    const runTurn = async (turnId: string, text: string) => {
      const events: RuntimeEvent[] = [];
      const started = Date.now();
      await runner.runTurn({
        sessionId: "session-425",
        turnId,
        workspaceDir: process.cwd(),
        systemPrompt: "You are a test.",
        userMessage: { text },
        llm: { model: model("custom_provider:fixture"), apiKey: "synthetic", firstEventTimeoutMs: 150 },
        llmRetry: { policy: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 10 } },
        eventWriter: {
          pushRuntime: (event) => {
            events.push(event);
          },
          appendEvents: (batch) => {
            events.push(...batch);
          },
        },
        toolConfig: { tools: [], disableBuiltinToolFallback: true, context: {} as never },
      });
      return { events, elapsed: Date.now() - started };
    };

    const first = await runTurn("turn-hung", "ping");
    const firstStatus = terminalStatus(first.events);
    expect(firstStatus.status).toBe(RuntimeEventStatus.FAILED);
    expect(JSON.stringify(firstStatus)).toContain(LLM_STREAM_TIMEOUT_MESSAGE_PREFIX);
    // Two attempts (initial + one retry), each bounded by 150 ms.
    expect(requests).toBe(2);
    expect(first.elapsed).toBeLessThan(5_000);

    hangFirst = 0;
    const second = await runTurn("turn-after", "hi");
    expect(terminalStatus(second.events).status).toBe(RuntimeEventStatus.COMPLETED);
    expect(requests).toBe(3);
  });
});

function terminalStatus(events: readonly RuntimeEvent[]): NonNullable<RuntimeEvent["payload"]> {
  const last = events.filter((event) => event.type === RuntimeEventType.SESSION_STATUS).at(-1);
  expect(last?.payload).toBeDefined();
  return last!.payload!;
}
