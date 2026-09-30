import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { EventBridge } from "../../../src/event-bridge/bridge.js";
import type { RuntimeEvent } from "@mavis/protocol";

function assistant(
  content: AssistantMessage["content"] = [],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    stopReason: content.some((part) => part.type === "toolCall")
      ? "toolUse"
      : "stop",
    timestamp: 0,
    usage: {
      input: 10,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function messageUsage(events: RuntimeEvent[]) {
  return events
    .map((event) => event.payload.stream_resp)
    .filter((raw): raw is string => typeof raw === "string")
    .map((raw) => JSON.parse(raw).agent_message?.usage)
    .find((usage) => usage !== undefined);
}

function fixture(detailed = true) {
  let now = 0;
  let sequence = 0;
  const bridge = new EventBridge({
    sessionId: "session-test",
    turnId: "turn-test",
    eventIdGenerator: (kind) => `${kind}-${++sequence}`,
    runtimeSeqGenerator: () => ++sequence,
    nowMs: () => now,
    includeDetailedUsage: detailed,
    requestDurationMs: () => 7_000,
  });
  return {
    bridge,
    setTime: (value: number) => {
      now = value;
    },
  };
}

function delta(
  type: "text_delta" | "thinking_delta" | "toolcall_delta",
  value: string,
): AgentEvent {
  return {
    type: "message_update",
    message: assistant(),
    assistantMessageEvent: {
      type,
      contentIndex: 0,
      delta: value,
      partial: assistant(),
    },
  };
}

describe("EventBridge generation timing", () => {
  it.each(["text_delta", "thinking_delta", "toolcall_delta"] as const)(
    "preserves the observed thinking start across later %s and tool completion",
    async (kind) => {
      const { bridge, setTime } = fixture();
      await bridge.processEvent({
        type: "message_start",
        message: assistant(),
      });
      bridge.setActiveAssistantMessageId("thinking-message");
      setTime(50_000);
      const thinkingStart: AgentEvent = {
        type: "message_update",
        message: assistant(),
        assistantMessageEvent: {
          type: "thinking_start",
          contentIndex: 0,
          partial: assistant([{ type: "thinking", thinking: "" }]),
        },
      };
      await bridge.processEvent(thinkingStart, 0);
      await bridge.processEvent(thinkingStart, 1_000);
      await bridge.processEvent(delta(kind, "answer"), 2_980);
      const tool = {
        type: "toolCall" as const,
        id: "t",
        name: "bash",
        arguments: {},
      };
      const ended = await bridge.processEvent(
        {
          type: "message_end",
          message: assistant([tool]),
        },
        3_000,
      );
      expect(messageUsage(ended.events)).toBeUndefined();
      setTime(90_000);
      const completed = await bridge.processEvent({
        type: "tool_execution_end",
        toolCallId: "t",
        toolName: "bash",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      });
      expect(messageUsage(completed.events)?.decode_duration_ms).toBe(3_000);
      await bridge.processEvent({
        type: "message_start",
        message: assistant(),
      });
      bridge.setActiveAssistantMessageId("next-message");
      await bridge.processEvent(delta("text_delta", "next"), 100_000);
      const next = await bridge.processEvent(
        {
          type: "message_end",
          message: assistant([{ type: "text", text: "next" }]),
        },
        102_000,
      );
      expect(messageUsage(next.events)?.decode_duration_ms).toBe(2_000);
    },
  );

  it("ignores thinking starts before an assistant message is anchored", async () => {
    const { bridge, setTime } = fixture();
    const start: AgentEvent = {
      type: "message_update",
      message: assistant(),
      assistantMessageEvent: {
        type: "thinking_start",
        contentIndex: 0,
        partial: assistant(),
      },
    };
    await bridge.processEvent(start, 0);
    await bridge.processEvent({ type: "message_start", message: assistant() });
    await bridge.processEvent(start, 100);
    bridge.setActiveAssistantMessageId("active");
    setTime(10_000);
    await bridge.processEvent(delta("text_delta", "answer"));
    setTime(12_000);
    const result = await bridge.processEvent({
      type: "message_end",
      message: assistant([{ type: "text", text: "answer" }]),
    });
    expect(messageUsage(result.events)?.decode_duration_ms).toBe(2_000);
  });

  it.each([true, false])(
    "counts hidden thinking before visible output with detailed usage enabled: %s",
    async (detailed) => {
      const { bridge, setTime } = fixture(detailed);
      await bridge.processEvent({
        type: "message_start",
        message: assistant(),
      });
      bridge.setActiveAssistantMessageId("hidden-thinking");
      setTime(1_000);
      const started = await bridge.processEvent({
        type: "message_update",
        message: assistant(),
        assistantMessageEvent: {
          type: "thinking_start",
          contentIndex: 0,
          partial: assistant([{ type: "thinking", thinking: "" }]),
        },
      });
      expect(started.events).toEqual([]);
      setTime(60_980);
      await bridge.processEvent(delta("text_delta", "Done."));
      setTime(61_000);
      const completed = await bridge.processEvent({
        type: "message_end",
        message: assistant([{ type: "text", text: "Done." }]),
      });
      expect(messageUsage(completed.events)?.decode_duration_ms).toBe(
        detailed ? 60_000 : undefined,
      );
    },
  );

  it.each(["text", "thinking", "tool"] as const)(
    "starts at the first nonempty %s token and excludes delayed tool completion",
    async (kind) => {
      const { bridge, setTime } = fixture();
      await bridge.processEvent({
        type: "message_start",
        message: assistant(),
      });
      bridge.setActiveAssistantMessageId("message-1");
      setTime(100);
      for (const type of [
        "text_delta",
        "thinking_delta",
        "toolcall_delta",
      ] as const) {
        await bridge.processEvent(delta(type, ""));
      }
      const tool = {
        type: "toolCall" as const,
        id: "tool-1",
        name: "bash",
        arguments: {},
      };
      setTime(5_000);
      await bridge.processEvent(
        kind === "tool"
          ? {
              type: "message_update",
              message: assistant(),
              assistantMessageEvent: {
                type: "toolcall_start",
                contentIndex: 0,
                partial: assistant([tool]),
              },
            }
          : delta(kind === "text" ? "text_delta" : "thinking_delta", "hello"),
      );
      setTime(7_000);
      const finished = await bridge.processEvent({
        type: "message_end",
        message: assistant([tool]),
      });
      expect(messageUsage(finished.events)).toBeUndefined();
      setTime(20_000);
      const completed = await bridge.processEvent({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      });
      expect(messageUsage(completed.events)).toMatchObject({
        decode_duration_ms: 2_000,
        request_duration_ms: 7_000,
      });
      await bridge.processEvent({
        type: "message_start",
        message: assistant(),
      });
      bridge.setActiveAssistantMessageId("message-2");
      const buffered = await bridge.processEvent({
        type: "message_end",
        message: assistant([{ type: "text", text: "buffered" }]),
      });
      expect(messageUsage(buffered.events)?.decode_duration_ms).toBeUndefined();
    },
  );

  it.each([true, false])(
    "preserves zero-duration samples only with detailed usage enabled: %s",
    async (detailed) => {
      const { bridge } = fixture(detailed);
      await bridge.processEvent({
        type: "message_start",
        message: assistant(),
      });
      bridge.setActiveAssistantMessageId("instant");
      await bridge.processEvent(delta("text_delta", "hello"));
      const result = await bridge.processEvent({
        type: "message_end",
        message: assistant([{ type: "text", text: "hello" }]),
      });
      expect(messageUsage(result.events)?.decode_duration_ms).toBe(
        detailed ? 0 : undefined,
      );
    },
  );
});
