import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { streamSimple, type Context, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compactContext } from "../../src/service/turn-system/compaction/algorithm/compact-context.js";
import { createCheckpointSession } from "../../src/service/turn-system/compaction/execution/checkpoint-provider.js";

const summary =
  "The synthetic file was read. Continue with the pending user request.";
const missingTools =
  "litellm.UnsupportedParamsError: Anthropic doesn't support tool calling without `tools=` param specified";
interface Rejection {
  status: number;
  message: string;
  param?: string;
  code?: string;
}

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
  let allowEmptyTools: boolean;
  let rejectRequest: (body: Record<string, unknown>) => Rejection | undefined;
  let incompleteStream: boolean;

  beforeEach(async () => {
    requests = [];
    allowEmptyTools = false;
    rejectRequest = () => undefined;
    incompleteStream = false;
    // Exercise the real SDK serializer and stream parser with a local fixture.
    // This models the reported validation rule, not acceptance by a live service.
    server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const rejection = rejectRequest(body);
      if (rejection) {
        const { status, ...error } = rejection;
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify({ error }));
        return;
      }
      if (
        !allowEmptyTools &&
        Array.isArray(body.tools) &&
        body.tools.length === 0
      ) {
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
      if (incompleteStream) {
        response.end();
        return;
      }
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

  it.each([
    { provider: "custom", requiresTools: false },
    { provider: "openai", requiresTools: false },
    { provider: "custom", requiresTools: true },
  ])(
    "compacts tool history through $provider (backend requires tools: $requiresTools)",
    async ({ provider, requiresTools }) => {
      model = { ...model, provider };
      if (requiresTools) {
        allowEmptyTools = true;
        rejectRequest = (body) =>
          body.tools === undefined
            ? { status: 400, message: missingTools }
            : undefined;
      }
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
      expect(requests).toHaveLength(requiresTools ? 2 : 1);
      expect(requests[0]).not.toHaveProperty("tools");
      if (requiresTools)
        expect(requests[1]).toEqual({ ...requests[0], tools: [] });
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

  it.each(["short", "none"] as const)(
    "honors the independent tools requirement with cache retention %s",
    async (cacheRetention) => {
      allowEmptyTools = true;
      model = { ...model, compat: { requiresToolsForToolHistory: true } };
      rejectRequest = (body) =>
        body.tools === undefined &&
        JSON.stringify(body.messages).includes("tool_calls")
          ? { status: 400, message: missingTools }
          : undefined;
      const result = await streamSimple(
        model,
        { messages: history(model) },
        {
          apiKey: "synthetic-key",
          cacheRetention,
        },
      ).result();
      expect(result.stopReason).toBe("stop");
      expect(requests).toHaveLength(1);
      expect(requests[0].tools).toEqual([]);

      await streamSimple(
        model,
        {
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
          tools: [],
        },
        {
          apiKey: "synthetic-key",
          cacheRetention,
        },
      ).result();
      expect(requests[1]).not.toHaveProperty("tools");
    },
  );

  it.each(["explicit", "detected"])(
    "does not infer a tools requirement from %s Anthropic caching",
    async (mode) => {
      model =
        mode === "explicit"
          ? { ...model, compat: { cacheControlFormat: "anthropic" } }
          : { ...model, provider: "openrouter", id: "anthropic/fixture-model" };
      const result = await streamSimple(
        model,
        { messages: history(model) },
        { apiKey: "synthetic-key" },
      ).result();
      expect(result.stopReason).toBe("stop");
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty("tools");
    },
  );

  it.each(["missing_required_parameter", "missing_required_argument"])(
    "recovers once from structured %s for tools",
    async (code) => {
      allowEmptyTools = true;
      rejectRequest = (body) =>
        body.tools === undefined
          ? {
              status: 400,
              message: "Required field missing",
              param: "tools",
              code,
            }
          : undefined;
      const onPayload = vi.fn((payload: unknown) => ({
        ...(payload as Record<string, unknown>),
        user: "synthetic-user",
      }));
      const result = await streamSimple(
        model,
        { messages: history(model) },
        { apiKey: "synthetic-key", onPayload },
      ).result();
      expect(result.stopReason).toBe("stop");
      expect(requests).toHaveLength(2);
      expect(onPayload).toHaveBeenCalledTimes(2);
      expect(requests[1]).toEqual({ ...requests[0], tools: [] });
    },
  );

  it("does not retry again if the recovery request also fails", async () => {
    rejectRequest = () => ({ status: 400, message: missingTools });
    const result = await streamSimple(
      model,
      { messages: history(model) },
      { apiKey: "synthetic-key" },
    ).result();
    expect(requests).toHaveLength(2);
    expect(requests[1].tools).toEqual([]);
    expect(result.stopReason).toBe("error");
  });

  it("disables SDK retries on the recovery request", async () => {
    rejectRequest = (body) =>
      body.tools === undefined
        ? { status: 400, message: missingTools }
        : { status: 500, message: "Synthetic server failure" };
    const result = await streamSimple(
      model,
      { messages: history(model) },
      {
        apiKey: "synthetic-key",
        maxRetries: 3,
      },
    ).result();
    expect(requests).toHaveLength(2);
    expect(result.stopReason).toBe("error");
  });

  it.each([
    "no history",
    "nonempty definitions",
    "explicit true",
    "hook tools",
  ])("does not recover with %s", async (mode) => {
    rejectRequest = () => ({ status: 400, message: missingTools });
    if (mode === "explicit true")
      model = { ...model, compat: { requiresToolsForToolHistory: true } };
    const context: Context = {
      messages:
        mode === "no history"
          ? [{ role: "user", content: "Hello", timestamp: 1 }]
          : history(model),
    };
    if (mode === "nonempty definitions")
      context.tools = [
        {
          name: "read",
          description: "Read a file",
          parameters: Type.Object({}),
        },
      ];
    const result = await streamSimple(model, context, {
      apiKey: "synthetic-key",
      onPayload:
        mode === "hook tools"
          ? (payload) => ({
              ...(payload as Record<string, unknown>),
              tools: [],
            })
          : undefined,
    }).result();
    expect(requests).toHaveLength(1);
    expect(result.stopReason).toBe("error");
  });

  it.each([
    {
      status: 400,
      message: "tools must not be an empty array",
      param: "tools",
    },
    { status: 400, message: "invalid tool schema", param: "tools" },
    { status: 400, message: `Invalid user content: ${missingTools}` },
    {
      status: 400,
      message: "Required field missing",
      param: "messages",
      code: "missing_required_parameter",
    },
    ...[401, 403, 429, 500].map((status) => ({
      status,
      message: missingTools,
    })),
  ])(
    "does not recover unrelated error $status: $message ($param)",
    async (rejection) => {
      rejectRequest = () => rejection;
      const result = await streamSimple(
        model,
        { messages: history(model) },
        { apiKey: "synthetic-key" },
      ).result();
      expect(requests).toHaveLength(1);
      expect(result.stopReason).toBe("error");
    },
  );

  it("honors explicit false even when the backend requires tools", async () => {
    model = { ...model, compat: { requiresToolsForToolHistory: false } };
    rejectRequest = () => ({ status: 400, message: missingTools });
    const result = await streamSimple(
      model,
      { messages: history(model) },
      { apiKey: "synthetic-key" },
    ).result();
    expect(requests).toHaveLength(1);
    expect(result.stopReason).toBe("error");
  });

  it("does not recover without tool history in the final payload", async () => {
    rejectRequest = () => ({ status: 400, message: missingTools });
    const result = await streamSimple(
      model,
      { messages: history(model) },
      {
        apiKey: "synthetic-key",
        onPayload: (payload) => ({
          ...(payload as Record<string, unknown>),
          messages: [{ role: "user", content: "Hello" }],
        }),
      },
    ).result();
    expect(requests).toHaveLength(1);
    expect(result.stopReason).toBe("error");
  });

  it("does not resend when a payload hook removes the recovery tools", async () => {
    rejectRequest = () => ({ status: 400, message: missingTools });
    const onPayload = vi.fn((payload: unknown) => {
      const { tools: _tools, ...rest } = payload as Record<string, unknown>;
      return rest;
    });
    const result = await streamSimple(
      model,
      { messages: history(model) },
      { apiKey: "synthetic-key", onPayload },
    ).result();
    expect(onPayload).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(1);
    expect(result.stopReason).toBe("error");
  });

  it("honors cancellation during the recovery payload hook", async () => {
    rejectRequest = () => ({ status: 400, message: missingTools });
    const controller = new AbortController();
    const onPayload = vi.fn((payload: unknown) => {
      if (Array.isArray((payload as Record<string, unknown>).tools))
        controller.abort();
    });
    const result = await streamSimple(
      model,
      { messages: history(model) },
      {
        apiKey: "synthetic-key",
        signal: controller.signal,
        onPayload,
      },
    ).result();
    expect(onPayload).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(1);
    expect(result.stopReason).toBe("aborted");
  });

  it("does not restart a response stream that ended without a finish reason", async () => {
    incompleteStream = true;
    const result = await streamSimple(
      model,
      { messages: history(model) },
      { apiKey: "synthetic-key" },
    ).result();
    expect(requests).toHaveLength(1);
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: summary }),
    ]);
    expect(result.stopReason).toBe("error");
  });

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
