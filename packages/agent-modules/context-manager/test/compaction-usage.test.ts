import type {
  AgentMessage,
  CompactionSummaryMessage,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiBeforeLlmCallHookInput } from "@mavis/agent-core/pi-turn-runner";
import { describe, expect, it, vi } from "vitest";
import { ContextManager } from "../src/manager.js";
import { BpeTokenEstimator } from "../src/token-estimator.js";

const estimator = new BpeTokenEstimator();
function assistant(tokens = 180_100, timestamp = 10): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Retained reply." }],
    api: "anthropic-messages",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp,
    usage: {
      input: tokens - 100,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    },
  };
}
function user(content = "Continue."): AgentMessage {
  return { role: "user", content, timestamp: 10 };
}
function summary(timestamp = 20): CompactionSummaryMessage {
  return {
    role: "compactionSummary",
    summary: "Small summary.",
    tokensBefore: 180_100,
    timestamp,
  };
}
function input(messages: AgentMessage[]): PiBeforeLlmCallHookInput {
  return {
    sessionId: "synthetic-session",
    turnId: "synthetic-turn",
    phase: "iteration",
    messages,
    canonicalMessages: messages,
    thinkingLevel: "off",
    model: {
      id: "test",
      name: "test",
      api: "anthropic-messages",
      provider: "test",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 1024,
    },
  };
}
function history(): AgentMessage[] {
  return [
    user("Old request."),
    assistant(),
    user("Old follow-up."),
    assistant(),
    user("Latest request."),
    assistant(),
  ];
}

describe("compaction usage provenance", () => {
  it("locally counts a restored legacy summary and retained pre-compaction reply", () => {
    const messages = JSON.parse(JSON.stringify([summary(), assistant()]));
    const estimate = estimator.estimateContextTokens(messages);
    expect(estimate.tokens).toBe(estimator.estimateMessages(messages));
    expect(estimate.tokens).toBeLessThan(100);
    expect(estimate.lastUsageIndex).toBeNull();
    expect(messages[1].usage.totalTokens).toBe(180_100);
  });

  it("uses fresh legacy usage and estimates only its trailing messages", () => {
    const messages = [summary(), assistant(), assistant(2100, 21), user()];
    expect(estimator.estimateContextTokens(messages)).toMatchObject({
      tokens: 2100 + estimator.estimateMessage(messages[3]!),
      usageTokens: 2100,
      lastUsageIndex: 2,
    });
  });

  it.each([undefined, NaN, 20])(
    "rejects legacy usage with ambiguous timestamp %s",
    (timestamp) => {
      const retained = { ...assistant(), timestamp } as AgentMessage;
      expect(
        estimator.estimateContextTokens([summary(), retained]).lastUsageIndex,
      ).toBeNull();
    },
  );

  it("does not trust any usage when the latest legacy summary lacks a timestamp", () => {
    const messages = [
      assistant(),
      { role: "compactionSummary", summary: "Restored." },
      assistant(2100, 30),
    ];
    expect(
      estimator.estimateContextTokens(messages as AgentMessage[])
        .lastUsageIndex,
    ).toBeNull();
  });

  it("leaves uncompacted usage and unsuccessful-response filtering unchanged", () => {
    const messages = [
      user(),
      assistant(2100),
      { ...assistant(), stopReason: "error" as const },
      { ...assistant(), stopReason: "aborted" as const },
    ];
    expect(estimator.estimateContextTokens(messages)).toMatchObject({
      usageTokens: 2100,
      lastUsageIndex: 1,
      tokens: 2100 + estimator.estimateMessages(messages.slice(2)),
    });
  });

  it("uses the latest summary boundary and counts an unanchored trailing window", () => {
    const messages = [
      summary(1),
      assistant(),
      { ...summary(20), keptMessageCount: 2 },
      user(),
      assistant(180_100, 50),
      { ...assistant(2000, 51), stopReason: "error" as const },
      user(),
    ];
    expect(estimator.estimateContextTokens(messages)).toEqual({
      tokens: estimator.estimateMessages(messages),
      usageTokens: 0,
      trailingTokens: estimator.estimateMessages(messages),
      lastUsageIndex: null,
    });
    messages.push(assistant(2100, 20), user());
    expect(estimator.estimateContextTokens(messages)).toMatchObject({
      tokens: 2100 + estimator.estimateMessage(messages[8]!),
      lastUsageIndex: 7,
    });
  });

  it.each([-1, 0.5, Infinity, 100])(
    "falls back locally for an unusable retained count %s",
    (keptMessageCount) => {
      const messages = [
        { ...summary(), keptMessageCount },
        assistant(2100, 30),
      ];
      expect(
        estimator.estimateContextTokens(messages).lastUsageIndex,
      ).toBeNull();
    },
  );

  it("recounts replacements, skips the next checkpoint, and retains historical usage across restore", async () => {
    const generateSummary = vi.fn(async () => "Small summary.");
    const committed = vi.fn();
    const options = {
      settings: { keepRecentTokens: 1 },
      summaryGenerator: { generateSummary },
      nowMs: () => 5,
      observer: { onCompactionCommitted: committed },
    };
    const original = history();
    const before = structuredClone(original);
    const decision = await new ContextManager(options).checkpoint(
      input(original),
    );
    expect(decision.type).toBe("replaceMessages");
    if (decision.type !== "replaceMessages")
      throw new Error("Expected compaction");
    expect(decision.metadata.tokensBefore).toBe(180_100);
    expect(decision.metadata.tokensAfter).toBe(
      estimator.estimateMessages(decision.messages),
    );
    expect(decision.metadata.tokensAfter).toBeLessThan(100);
    expect(committed).toHaveBeenCalledWith(
      expect.objectContaining({ tokensAfter: decision.metadata.tokensAfter }),
    );
    expect(original).toEqual(before);
    expect(decision.messages[1]).toEqual(original[5]);
    expect(decision.metadata.keptMessages).toEqual([original[5]]);

    const restored: AgentMessage[] = JSON.parse(
      JSON.stringify(decision.messages),
    );
    const manager = new ContextManager(options);
    // Enough messages for trigger evaluation, with no new provider usage yet.
    const next = await manager.checkpoint(input([...restored, user(), user()]));
    expect(next).toEqual({
      type: "skip",
      reason: "context_manager_below_threshold",
    });
    expect(generateSummary).toHaveBeenCalledTimes(1);
    // Explicit provenance also works when the clock moved backwards or ties the summary.
    expect(
      estimator.estimateContextTokens([...restored, assistant(2100, 5)]),
    ).toMatchObject({
      usageTokens: 2100,
      lastUsageIndex: 2,
    });
    expect(
      estimator.estimateContextTokens([...restored, assistant(2100, 1)]),
    ).toMatchObject({
      usageTokens: 2100,
      lastUsageIndex: 2,
    });
  });

  it("invalidates fresh usage again on a subsequent compaction", async () => {
    const manager = new ContextManager({
      settings: { keepRecentTokens: 1 },
      summaryGenerator: { generateSummary: async () => "Small summary." },
      nowMs: () => 20,
    });
    const first = await manager.checkpoint(input(history()));
    if (first.type !== "replaceMessages")
      throw new Error("Expected compaction");
    const second = await manager.checkpoint(
      input([...first.messages, ...history()]),
    );
    if (second.type !== "replaceMessages")
      throw new Error("Expected second compaction");
    expect(second.metadata.tokensBefore).toBe(180_100);
    expect(second.metadata.tokensAfter).toBeLessThan(100);
    expect(
      estimator.estimateContextTokens(second.messages).lastUsageIndex,
    ).toBeNull();
  });

  it("preserves the remote counter decision and payload after compaction", async () => {
    const countContextTokens = vi
      .fn()
      .mockResolvedValueOnce({ tokens: 190_000, source: "remote_count_tokens" })
      .mockResolvedValueOnce({ tokens: 40, source: "remote_count_tokens" });
    const onTriggerEvaluated = vi.fn();
    const manager = new ContextManager({
      settings: { keepRecentTokens: 1 },
      tokenCounter: { countContextTokens },
      observer: { onTriggerEvaluated },
      summaryGenerator: { generateSummary: async () => "Small summary." },
    });
    const decision = await manager.checkpoint(input(history()));
    if (decision.type !== "replaceMessages")
      throw new Error("Expected compaction");
    expect(decision.metadata.tokensBefore).toBe(190_000);
    expect(decision.metadata.tokensAfter).toBeLessThan(100);
    const nextInput = {
      ...input([...decision.messages, user(), user()]),
      apiKey: "synthetic-test-key",
      headers: { "x-test": "synthetic" },
      systemPrompt: "Test system.",
      tools: [],
    };
    expect(await manager.checkpoint(nextInput)).toEqual({
      type: "skip",
      reason: "context_manager_below_threshold",
    });
    expect(countContextTokens).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: nextInput.messages,
        apiKey: nextInput.apiKey,
        headers: nextInput.headers,
        systemPrompt: nextInput.systemPrompt,
        tools: nextInput.tools,
      }),
    );
    expect(onTriggerEvaluated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tokens: 40,
        source: "remote_count_tokens",
        shouldCompact: false,
      }),
    );
  });
});
