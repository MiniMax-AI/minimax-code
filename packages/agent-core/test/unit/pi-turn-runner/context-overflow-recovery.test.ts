import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import {
  newContextOverflowRecoveryState,
  withContextOverflowRecovery,
} from "../../../src/pi-turn-runner/context-overflow-recovery.js";
import { PiTurnRunner } from "../../../src/pi-turn-runner/pi-turn-runner.js";
import type {
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookInput,
  PiHistoryChangedHookInput,
} from "../../../src/pi-turn-runner/hooks.js";
import type { RuntimeEvent } from "../../../src/pi-turn-runner/types.js";
import { RuntimeEventStatus } from "../../../src/protocol/runtime-event.js";

function fakeModel(provider = "minimax_api"): Model<any> {
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

function assistant(
  stopReason: AssistantMessage["stopReason"],
  content: AssistantMessage["content"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test-messages",
    provider: "minimax_api",
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
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 0,
  } as AssistantMessage;
}

function stream(events: AssistantMessageEvent[], final: AssistantMessage): AssistantMessageEventStream {
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
  const empty = assistant("stop", []);
  const final = assistant("stop", [{ type: "text", text }]);
  return stream(
    [
      { type: "start", partial: empty },
      { type: "text_start", contentIndex: 0, partial: empty },
      { type: "text_delta", contentIndex: 0, delta: text, partial: final },
      { type: "text_end", contentIndex: 0, content: text, partial: final },
      { type: "done", reason: "stop", message: final },
    ],
    final,
  );
}

function errorStream(message: string): AssistantMessageEventStream {
  const empty = assistant("error", []);
  const final = assistant("error", [], message);
  return stream(
    [
      { type: "start", partial: empty },
      { type: "error", reason: "error", error: final },
    ],
    final,
  );
}

const OVERSIZED = "413 Request Entity Too Large";

function textOf(message: { content: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return (content as { type: string; text?: string }[])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

function summaryMessage(): AgentMessage {
  return { role: "user", content: [{ type: "text", text: "SUMMARY" }], timestamp: 1 } as AgentMessage;
}

function compactingHook(calls: PiBeforeLlmCallHookInput[]): PiBeforeLlmCallHook {
  return (input) => {
    calls.push(input);
    const kept = input.messages.slice(-1);
    return {
      type: "replaceMessages",
      messages: [summaryMessage(), ...kept],
      metadata: {
        replacementId: `r${calls.length}`,
        strategyVersion: "test",
        summary: "SUMMARY",
        compactedMessages: input.messages.slice(0, -1),
        keptMessages: kept,
        firstKeptIndex: input.messages.length - 1,
      },
    };
  };
}

async function runTurn(options: {
  responses: Array<() => AssistantMessageEventStream>;
  recoveryHooks?: PiBeforeLlmCallHook[];
  beforeLlmCallHook?: PiBeforeLlmCallHook[];
  provider?: string;
}) {
  const contexts: Context[] = [];
  let index = 0;
  const streamFn = (async (_model: Model<any>, context: Context) => {
    contexts.push({ ...context, messages: structuredClone(context.messages) });
    const next = options.responses[Math.min(index, options.responses.length - 1)]!;
    index += 1;
    return next();
  }) as unknown as StreamFn;
  const events: RuntimeEvent[] = [];
  const historyChanges: PiHistoryChangedHookInput[] = [];
  const runner = new PiTurnRunner();
  await runner.runTurn({
    sessionId: "session-1",
    turnId: "turn-1",
    workspaceDir: "/tmp",
    systemPrompt: "system",
    userMessage: { text: "current question", timestamp: 2 },
    history: [
      { role: "user", content: [{ type: "text", text: "old question" }], timestamp: 0 } as AgentMessage,
      assistant("stop", [{ type: "text", text: "old answer ".repeat(100) }]) as AgentMessage,
    ],
    llm: { model: fakeModel(options.provider), apiKey: "k", streamFn },
    eventWriter: {
      pushRuntime: (event) => void events.push(event),
      appendEvents: (batch) => void events.push(...batch),
    },
    toolConfig: { tools: [], context: {} as never },
    llmRetry: { sleep: vi.fn(async () => {}), random: () => 0 },
    hooks: {
      beforeLlmCallHook: options.beforeLlmCallHook ?? [() => ({ type: "continue" })],
      ...(options.recoveryHooks ? { contextOverflowRecoveryHook: options.recoveryHooks } : {}),
      onHistoryChangedHook: [async (change) => void historyChanges.push(change)],
    },
  });
  const terminal = events
    .map((event) => event as unknown as { type?: string; payload?: { status?: string } })
    .filter((event) => event.payload?.status !== undefined)
    .at(-1);
  return { contexts, events, historyChanges, terminal };
}

describe("context overflow recovery", () => {
  it("compacts once and resends once after a BYOK 413", async () => {
    const recoveryCalls: PiBeforeLlmCallHookInput[] = [];
    const result = await runTurn({
      responses: [() => errorStream(OVERSIZED), () => successStream("recovered")],
      recoveryHooks: [compactingHook(recoveryCalls)],
    });

    // One rejected request, one resend: the 413 is not retried five times.
    expect(result.contexts).toHaveLength(2);
    expect(recoveryCalls).toHaveLength(1);
    expect(recoveryCalls[0]!.trigger).toBe("context_overflow_recovery");
    expect(result.contexts[0]!.messages).toHaveLength(3);
    expect(result.contexts[1]!.messages.map(textOf)).toEqual(["SUMMARY", "current question"]);
    // The compaction is persisted as a durable replacement before the resend.
    const replace = result.historyChanges.find((change) => change.reason === "replaceMessages");
    expect(replace?.messages.map((message) => textOf(message as never))).toEqual([
      "SUMMARY",
      "current question",
    ]);
    // The rejected attempt never reaches history; only the recovered answer does.
    const deltas = result.historyChanges
      .filter((change) => change.reason === "messageDelta")
      .flatMap((change) => change.messages);
    const assistants = deltas.filter((message) => message.role === "assistant");
    expect(assistants.map((message) => (message as AssistantMessage).stopReason)).toEqual(["stop"]);
    expect(result.terminal?.payload?.status).toBe(RuntimeEventStatus.COMPLETED);
  });

  it("surfaces the rejection when the resent request is still too large", async () => {
    const recoveryCalls: PiBeforeLlmCallHookInput[] = [];
    const result = await runTurn({
      responses: [() => errorStream(OVERSIZED)],
      recoveryHooks: [compactingHook(recoveryCalls)],
    });

    expect(result.contexts).toHaveLength(2);
    expect(recoveryCalls).toHaveLength(1);
    const deltas = result.historyChanges
      .filter((change) => change.reason === "messageDelta")
      .flatMap((change) => change.messages);
    expect((deltas.at(-1) as AssistantMessage).errorMessage).toBe(OVERSIZED);
    expect(result.terminal?.payload?.status).toBe(RuntimeEventStatus.FAILED);
  });

  it("does not resend when recovery leaves the context unchanged", async () => {
    const recovery = vi.fn<PiBeforeLlmCallHook>(() => ({ type: "skip", reason: "context_compaction_failed" }));
    const result = await runTurn({
      responses: [() => errorStream(OVERSIZED)],
      recoveryHooks: [recovery],
    });

    expect(result.contexts).toHaveLength(1);
    expect(recovery).toHaveBeenCalledOnce();
  });

  it("does not run recovery for errors that are not about request size", async () => {
    const recoveryCalls: PiBeforeLlmCallHookInput[] = [];
    const result = await runTurn({
      responses: [() => errorStream('400 {"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}')],
      recoveryHooks: [compactingHook(recoveryCalls)],
    });

    expect(result.contexts).toHaveLength(1);
    expect(recoveryCalls).toHaveLength(0);
  });

  it("does not re-run ordinary before-LLM hooks during recovery", async () => {
    const ordinary = vi.fn<PiBeforeLlmCallHook>(() => ({ type: "continue" }));
    const recoveryCalls: PiBeforeLlmCallHookInput[] = [];
    const result = await runTurn({
      responses: [() => errorStream(OVERSIZED), () => successStream("recovered")],
      recoveryHooks: [compactingHook(recoveryCalls)],
      beforeLlmCallHook: [ordinary],
    });

    expect(result.contexts).toHaveLength(2);
    expect(ordinary).toHaveBeenCalledOnce();
  });

  it("keeps the previous single-failure behaviour when no recovery hook is installed", async () => {
    const result = await runTurn({ responses: [() => errorStream(OVERSIZED)] });
    expect(result.contexts).toHaveLength(1);
  });
});

describe("withContextOverflowRecovery", () => {
  it("surfaces the original rejection when recovery itself throws", async () => {
    const calls: number[] = [];
    const inner = (async () => {
      calls.push(1);
      return errorStream(OVERSIZED);
    }) as unknown as StreamFn;
    const state = newContextOverflowRecoveryState();
    state.recover = async () => {
      throw new Error("compaction exploded");
    };
    const wrapped = withContextOverflowRecovery(inner, state);
    const out = await wrapped(fakeModel(), { messages: [] } as unknown as Context, {});
    const types: string[] = [];
    for await (const event of out) types.push(event.type);
    expect(types).toContain("error");
    expect(calls).toHaveLength(1);
    expect(state.attempted).toBe(true);
  });
});
