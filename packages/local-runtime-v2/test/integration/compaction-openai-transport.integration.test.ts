import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { streamSimple, type Context, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compactContext } from "../../src/service/turn-system/compaction/algorithm/compact-context.js";
import { createCheckpointSession } from "../../src/service/turn-system/compaction/execution/checkpoint-provider.js";

const summary =
  "The synthetic file was read. Continue with the pending user request.";

function history(model: Model<"openai-completions">): Context["messages"] {
  return [
    { role: "user", content: "Read the synthetic file.", timestamp: 1 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "read-1",
          name: "read",
          arguments: { path: "fixture.txt" },
        },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "toolUse",
      timestamp: 2,
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "Synthetic file contents." }],
      isError: false,
      timestamp: 3,
    },
  ];
}

describe("OpenAI compaction HTTP transport", () => {
  let server: ReturnType<typeof createServer>;
  let model: Model<"openai-completions">;
  let requests: Record<string, unknown>[];

  beforeEach(async () => {
    requests = [];
    // Exercise the real SDK serializer and stream parser with a local fixture.
    // This models the reported validation rule, not acceptance by a live service.
    server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      if (Array.isArray(body.tools) && body.tools.length === 0) {
        response.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: {
              message: "tools must not be an empty array",
              type: "invalid_request_error",
              param: "tools",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "synthetic-checkpoint",
          object: "chat.completion.chunk",
          model: body.model,
          choices: [
            { index: 0, delta: { content: summary }, finish_reason: null },
          ],
        })}\n\n`,
      );
      response.end(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 15,
            total_tokens: 115,
          },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    model = {
      id: "fixture-model",
      name: "Fixture model",
      api: "openai-completions",
      provider: "custom",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      reasoning: false,
      input: ["text"],
      contextWindow: 32_768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });

  afterEach(async () => {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each(["custom", "openai"])(
    "compacts tool history through the %s provider without empty tools",
    async (provider) => {
      model = { ...model, provider };
      const result = await compactContext({
        history: history(model),
        allowLegacyToolTrim: false,
        limits: {
          providerInputLimit: 20_000,
          maxSerializedInputBytes: 100_000,
        },
        // Admission is synthetic; checkpoint generation and HTTP transport are real.
        measurePair: async () => ({
          before: { inputTokens: 1000, serializedBytes: 10_000 },
          after: { inputTokens: 100, serializedBytes: 1000 },
        }),
        checkpoint: {
          tokensBefore: 1000,
          timestamp: 4,
          open: () =>
            createCheckpointSession({
              model,
              streamFn: streamSimple,
              thinkingLevel: "off",
              apiKey: "synthetic-key",
              maxOutputTokens: 1024,
              providerInputLimit: 20_000,
            }),
        },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty("tools");
      expect(requests[0]).not.toHaveProperty("tool_choice");
      expect(requests[0].messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            tool_calls: [expect.objectContaining({ id: "read-1" })],
          }),
          expect.objectContaining({
            role: "tool",
            tool_call_id: "read-1",
            content: "Synthetic file contents.",
          }),
        ]),
      );
      expect(result).toMatchObject({
        method: "llm_checkpoint",
        summary,
        generationAttempts: 1,
      });
      expect(result.replacementMessages[0]).toMatchObject({
        role: "compactionSummary",
      });
    },
  );

  it.each([
    { label: "absent", tools: undefined },
    { label: "empty", tools: [] },
  ])("omits $label tool definitions with tool history", async ({ tools }) => {
    const result = await streamSimple(
      model,
      { messages: history(model), tools },
      { apiKey: "synthetic-key" },
    ).result();
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("tools");
    expect(result.stopReason).toBe("stop");
  });

  it.each(["explicit", "detected"])(
    "omits tools with %s Anthropic cache compatibility and tool history",
    async (mode) => {
      model =
        mode === "explicit"
          ? { ...model, compat: { cacheControlFormat: "anthropic" } }
          : { ...model, provider: "openrouter", id: "anthropic/fixture-model" };
      const result = await streamSimple(
        model,
        { messages: history(model) },
        {
          apiKey: "synthetic-key",
          cacheRetention: "none",
        },
      ).result();
      expect(result.stopReason).toBe("stop");
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty("tools");

      await streamSimple(
        model,
        {
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
          tools: [],
        },
        {
          apiKey: "synthetic-key",
          cacheRetention: "none",
        },
      ).result();
      expect(requests[1]).not.toHaveProperty("tools");
    },
  );

  it("preserves nonempty tool definitions on ordinary agent requests", async () => {
    const result = await streamSimple(
      model,
      {
        messages: history(model),
        tools: [
          {
            name: "read",
            description: "Read a synthetic file",
            parameters: Type.Object({ path: Type.String() }),
          },
        ],
      },
      { apiKey: "synthetic-key" },
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(requests[0].tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "read" }),
      }),
    ]);
  });
});
