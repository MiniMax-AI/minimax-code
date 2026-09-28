import { describe, expect, it } from "vitest";
import {
  normalizeTuiMessage,
  projectTuiSessionStreamFrame,
} from "../../src/runtime/stream-events.js";

describe("Minimax Code stream event projection", () => {
  it("projects generated Session SSE frames without a Runtime-private event contract", () => {
    expect(
      projectTuiSessionStreamFrame(
        {
          cursor: "cursor-1",
          dataJson: JSON.stringify({
            type: 6,
            agent_message_chunk: {
              msg_id: "message-1",
              role: "assistant",
              msg_content: "hello",
              chunk_index: 0,
            },
          }),
        },
        "turn-1",
      ),
    ).toEqual({
      type: "delta",
      messageId: "message-1",
      turnId: "turn-1",
      role: "assistant",
      content: "hello",
      chunkIndex: 0,
      cursor: "cursor-1",
    });
    expect(
      projectTuiSessionStreamFrame({ dataJson: "[DONE]" }, "turn-1"),
    ).toEqual({
      type: "done",
      turnId: "turn-1",
    });
  });

  it("projects Runtime terminal and overflow frames from the generated stream", () => {
    expect(
      projectTuiSessionStreamFrame(
        {
          dataJson: JSON.stringify({
            type: "session_status",
            session_status: { type: "finished" },
          }),
        },
        "turn-1",
      ),
    ).toEqual({ type: "session-status", status: "finished", turnId: "turn-1" });
    expect(
      projectTuiSessionStreamFrame(
        { dataJson: '{"type":"resume_overflow"}' },
        "turn-1",
      ),
    ).toEqual({ type: "resync-required", turnId: "turn-1" });
  });

  it("preserves Runtime-owned Review kind, source, and outcome metadata", () => {
    expect(
      normalizeTuiMessage({
        msg_id: "review-1",
        role: "assistant",
        kind: "review_result",
        source: "code_review",
        origin: { reviewOutcome: "needs_changes" },
        msg_content: "<annotation-result />",
      }),
    ).toMatchObject({
      id: "review-1",
      kind: "review_result",
      source: "code_review",
      origin: { reviewOutcome: "needs_changes" },
    });
  });

  it("parses durable Review originJson metadata", () => {
    expect(
      normalizeTuiMessage({
        msgId: "review-pass",
        role: "assistant",
        msgContent: "No reportable issues were found.",
        originJson: JSON.stringify({ reviewOutcome: "pass" }),
      }),
    ).toMatchObject({
      id: "review-pass",
      origin: { reviewOutcome: "pass" },
    });
  });

  it("derives an applied structured preview while normalizing durable Edit Tool Calls", () => {
    const message = normalizeTuiMessage({
      msg_id: "message-edit",
      role: "assistant",
      tool_calls: [
        {
          tool_name: "edit",
          tool_call_id: "tool-edit",
          tool_call_status: 2,
          tool_call_args: JSON.stringify({
            path: "src/greeting.ts",
            edits: [{ oldText: "old", newText: "new" }],
          }),
          tool_call_result_data: JSON.stringify({
            details: { diff: "- old\n+ new" },
          }),
        },
      ],
    });

    expect(message.toolCalls?.[0]?.structuredPreview).toEqual({
      schemaVersion: 1,
      state: "applied",
      blocks: [
        expect.objectContaining({
          kind: "diff",
          path: "src/greeting.ts",
          addedLines: 1,
          removedLines: 1,
        }),
      ],
    });
  });

  it("decodes generated Session Tool Call payloads while normalizing durable history", () => {
    expect(
      normalizeTuiMessage({
        msgId: "message-task",
        role: "assistant",
        toolCalls: [
          {
            toolName: "task",
            toolCallId: "tool-task",
            toolCallStatus: 2,
            toolCallArgs: JSON.stringify({
              description: "Inspect the Runtime boundary",
            }),
            toolCallResultData: JSON.stringify({
              details: { subSessionId: "session-child" },
            }),
          },
        ],
      }).toolCalls,
    ).toEqual([
      expect.objectContaining({
        id: "tool-task",
        name: "task",
        status: 2,
        input: { description: "Inspect the Runtime boundary" },
        output: { details: { subSessionId: "session-child" } },
      }),
    ]);
  });

  it("preserves ordered message parts instead of rebuilding chronology from flat fields", () => {
    expect(
      normalizeTuiMessage({
        msg_id: "message-1",
        role: "assistant",
        msg_content: "fallback",
        parts: [
          { id: "part-thinking", type: "thinking", content: "Inspect" },
          { id: "part-text-1", type: "text", content: "I will read it." },
          {
            id: "part-tool",
            type: "toolCall",
            name: "read",
            status: 2,
            arguments: { path: "README.md" },
          },
          { id: "part-thinking-2", type: "thinking", thinking: "Interpret" },
          { id: "part-text-2", type: "text", content: "Done." },
        ],
      }),
    ).toMatchObject({
      id: "message-1",
      parts: [
        { id: "part-thinking", type: "thinking", content: "Inspect" },
        { id: "part-text-1", type: "text", content: "I will read it." },
        {
          id: "part-tool",
          type: "tool",
          toolCall: { id: "part-tool", name: "read", status: 2 },
        },
        { id: "part-thinking-2", type: "thinking", content: "Interpret" },
        { id: "part-text-2", type: "text", content: "Done." },
      ],
    });
  });

  it("normalizes Desktop attachment views for durable history rendering", () => {
    expect(
      normalizeTuiMessage({
        msgId: "message-attachment",
        role: "user",
        msgContent: "Inspect this",
        attachments: [
          {
            meta: {
              attachmentType: "image",
              fileName: "diagram.png",
              mimeType: "image/png",
              sizeBytes: "2048",
            },
            local: {
              assetId: "asset-1",
              filePath: "/runtime/assets/diagram.png",
            },
          },
        ],
      }),
    ).toEqual({
      id: "message-attachment",
      role: "user",
      content: "Inspect this",
      attachments: [
        {
          type: "image",
          fileName: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          filePath: "/runtime/assets/diagram.png",
          assetId: "asset-1",
        },
      ],
    });
  });

  it("preserves Runtime-owned compaction lifecycle messages", () => {
    expect(
      normalizeTuiMessage({
        msg_id: "compaction-attempt-1",
        turnId: "turn-compact",
        role: "assistant",
        kind: "compaction_failed",
        error: "summary was larger than the original context",
        timestamp: 100,
      }),
    ).toEqual({
      id: "compaction-attempt-1",
      turnId: "turn-compact",
      role: "assistant",
      kind: "compaction_failed",
      error: "summary was larger than the original context",
      timestamp: 100,
    });
  });

  it("preserves Runtime-owned compaction token counts", () => {
    expect(
      normalizeTuiMessage({
        msg_id: "compaction-attempt-1",
        turnId: "turn-compact",
        role: "assistant",
        kind: "compaction",
        tokensBefore: 14_200,
        tokensAfter: 5_100,
        timestamp: 100,
      }),
    ).toMatchObject({
      kind: "compaction",
      tokensBefore: 14_200,
      tokensAfter: 5_100,
    });
  });

  it("preserves provider-reported output token usage for live throughput", () => {
    expect(
      normalizeTuiMessage({
        msg_id: "message-usage",
        role: "assistant",
        usage: {
          total_tokens: 1_600,
          input_tokens: 1_400,
          output_tokens: 200,
          reasoning_tokens: 80,
          request_duration_ms: 4_000,
          decode_duration_ms: 2_000,
        },
      }),
    ).toMatchObject({
      usage: {
        totalTokens: 1_600,
        inputTokens: 1_400,
        outputTokens: 200,
        reasoningTokens: 80,
        requestDurationMs: 4_000,
        decodeDurationMs: 2_000,
      },
    });
  });
});
