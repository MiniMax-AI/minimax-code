import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectAgentMessagesForModel } from "../../../src/pi-turn-runner/outbound-message-normalizer.js";
import { PiTurnRunner } from "../../../src/pi-turn-runner/pi-turn-runner.js";
import {
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  limitRequestImages,
  normalizeMaxImagesPerRequest,
  resolveMaxImagesPerRequest,
} from "../../../src/pi-turn-runner/request-image-limit.js";
import {
  RuntimeEventStatus,
  RuntimeEventType,
  type RuntimeEvent,
} from "../../../src/protocol/runtime-event.js";
import { NORMAL_40X24_PNG, THIN_432X2_JPEG } from "../image-fixtures.js";

// Regression coverage for #425: inline images live in persisted history and
// every request re-sends the whole history, so a long session eventually
// exceeded the provider's per-request image limit ("Too many images in
// request: 31 > 30") and every later request — even plain text — failed.

const IMAGE = { type: "image" as const, data: NORMAL_40X24_PNG, mimeType: "image/png" };

function model(overrides: Record<string, unknown> = {}): Model<any> {
  return {
    id: "fixture-model",
    name: "fixture-model",
    api: "openai-completions",
    provider: "custom_provider:fixture",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 1_024,
    ...overrides,
  } as Model<any>;
}

function attachmentTag(path: string, inline: boolean): string {
  return `<attachment name="${path.split("/").at(-1)}" mime="image/png" path="${path}" message_index="1" kind="image" inline="${inline}">\nUse the exact local path.\n</attachment>`;
}

function userWithImages(turn: number, imageCount: number, withReminder = true): UserMessage {
  const paths = Array.from({ length: imageCount }, (_, index) => `/tmp/shots/turn${turn}-${index + 1}.png`);
  const reminder = withReminder
    ? `<system-reminder>\n${paths.map((path) => attachmentTag(path, true)).join("\n")}\n</system-reminder>\n`
    : "";
  return {
    role: "user",
    content: [{ type: "text", text: `${reminder}turn ${turn}` }, ...paths.map(() => ({ ...IMAGE }))],
    timestamp: turn,
  };
}

function assistantReply(turn: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: `reply ${turn}` }],
    api: "openai-completions",
    provider: "custom_provider:fixture",
    model: "fixture-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: turn,
  } as AssistantMessage;
}

/** `turns` user turns with `perTurn` inline images each, plus assistant replies. */
function imageHistory(turns: number, perTurn = 1): AgentMessage[] {
  const history: AgentMessage[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    history.push(userWithImages(turn, perTurn), assistantReply(turn));
  }
  return history;
}

function imageCount(messages: readonly Message[]): number {
  return messages.reduce(
    (total, message) =>
      total +
      (Array.isArray(message.content)
        ? message.content.filter((block) => (block as { type?: string }).type === "image").length
        : 0),
    0,
  );
}

function texts(message: Message): string[] {
  return Array.isArray(message.content)
    ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
    : [message.content];
}

describe("limitRequestImages", () => {
  it("leaves a request within the limit untouched", () => {
    const messages = imageHistory(3) as Message[];
    const result = limitRequestImages(messages, 3);
    expect(result.omittedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("keeps the newest images across the request and replaces older ones with placeholders", () => {
    const messages = imageHistory(5, 2) as Message[];
    const result = limitRequestImages(messages, 3);

    expect(result.omittedCount).toBe(7);
    expect(imageCount(result.messages)).toBe(3);
    // Turns 1-3 lose every image; turn 4 keeps its second image; turn 5 keeps both.
    const perUser = result.messages
      .filter((message) => message.role === "user")
      .map((message) => imageCount([message]));
    expect(perUser).toEqual([0, 0, 0, 1, 2]);
    const placeholders = texts(result.messages[0]!).slice(1);
    expect(placeholders).toEqual([
      "[Earlier image omitted: this request keeps only the 3 most recent images. Original file: /tmp/shots/turn1-1.png]",
      "[Earlier image omitted: this request keeps only the 3 most recent images. Original file: /tmp/shots/turn1-2.png]",
    ]);
    expect(texts(result.messages[6]!)[1]).toContain("/tmp/shots/turn4-1.png");
  });

  it("never mutates the canonical messages", () => {
    const messages = imageHistory(4) as Message[];
    const snapshot = structuredClone(messages);
    limitRequestImages(messages, 1);
    expect(messages).toEqual(snapshot);
  });

  it("counts tool-result images and names the file from the matching tool call", () => {
    const messages: Message[] = [
      userWithImages(1, 1),
      {
        ...assistantReply(2),
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/shots/screen.png" } }],
        stopReason: "toolUse",
      } as AssistantMessage,
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "Read image file [image/png]" }, { ...IMAGE }],
        isError: false,
        timestamp: 3,
      } satisfies ToolResultMessage,
      {
        ...assistantReply(4),
        content: [{ type: "toolCall", id: "call-2", name: "browser", arguments: { action: "screenshot" } }],
        stopReason: "toolUse",
      } as AssistantMessage,
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "browser",
        content: [{ ...IMAGE }],
        isError: false,
        timestamp: 5,
      } satisfies ToolResultMessage,
      userWithImages(6, 1),
    ];

    const result = limitRequestImages(messages, 1);

    expect(result.omittedCount).toBe(3);
    expect(imageCount(result.messages)).toBe(1);
    expect(imageCount([result.messages[5]!])).toBe(1);
    expect(texts(result.messages[2]!)[1]).toBe(
      "[Earlier image omitted: this request keeps only the 1 most recent images. Original file: /tmp/shots/screen.png]",
    );
    expect(texts(result.messages[4]!)).toEqual([
      "[Earlier image omitted: this request keeps only the 1 most recent images.]",
    ]);
  });

  it("reads escaped attachment paths and stays linear on adversarial reminder text", () => {
    const escaped: UserMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: '<attachment name="a" mime="image/png" path="/tmp/a &amp; &quot;b&quot;.png" kind="image" inline="true">',
        },
        { ...IMAGE },
      ],
      timestamp: 1,
    };
    const adversarial: UserMessage = {
      role: "user",
      content: [
        { type: "text", text: `<attachment ${"_".repeat(200_000)}> ${"<attachment".repeat(20_000)}` },
        { ...IMAGE },
      ],
      timestamp: 2,
    };
    const startedAt = performance.now();
    const result = limitRequestImages([escaped, adversarial, userWithImages(3, 1)], 1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(texts(result.messages[0]!)[1]).toContain('Original file: /tmp/a & "b".png]');
    expect(texts(result.messages[1]!)[1]).toBe(
      "[Earlier image omitted: this request keeps only the 1 most recent images.]",
    );
  });

  it("omits the path when attachment reminders do not line up with the image blocks", () => {
    const messages: Message[] = [userWithImages(1, 2, false), userWithImages(2, 1)];
    const result = limitRequestImages(messages, 1);
    expect(texts(result.messages[0]!).slice(1)).toEqual([
      "[Earlier image omitted: this request keeps only the 1 most recent images.]",
      "[Earlier image omitted: this request keeps only the 1 most recent images.]",
    ]);
  });
});

describe("request image ceiling resolution", () => {
  it("defaults to a conservative limit below the observed MiniMax gateway limit of 30", () => {
    expect(DEFAULT_MAX_IMAGES_PER_REQUEST).toBeLessThanOrEqual(30);
    expect(resolveMaxImagesPerRequest(model())).toBe(DEFAULT_MAX_IMAGES_PER_REQUEST);
  });

  it("honours a positive integer declared on the model and ignores invalid values", () => {
    expect(resolveMaxImagesPerRequest(model({ maxImagesPerRequest: 8 }))).toBe(8);
    expect(resolveMaxImagesPerRequest(model({ maxImagesPerRequest: 0 }))).toBe(DEFAULT_MAX_IMAGES_PER_REQUEST);
    expect(resolveMaxImagesPerRequest(model({ maxImagesPerRequest: 2.5 }))).toBe(
      DEFAULT_MAX_IMAGES_PER_REQUEST,
    );
    expect(normalizeMaxImagesPerRequest("12")).toBe(12);
    expect(normalizeMaxImagesPerRequest("many")).toBeUndefined();
  });
});

describe("projectAgentMessagesForModel image ceiling", () => {
  it("caps a 31-image history at the default ceiling without touching canonical history", () => {
    const history = imageHistory(31);
    const snapshot = structuredClone(history);
    const projected = projectAgentMessagesForModel(history, model());

    expect(imageCount(projected.messages)).toBe(DEFAULT_MAX_IMAGES_PER_REQUEST);
    expect(projected.omittedImageCount).toBe(31 - DEFAULT_MAX_IMAGES_PER_REQUEST);
    expect(history).toEqual(snapshot);
    // The newest turn keeps its image; the oldest one is a placeholder naming its file.
    expect(imageCount([projected.messages.at(-2)!])).toBe(1);
    expect(texts(projected.messages[0]!).at(-1)).toContain("/tmp/shots/turn1-1.png");
  });

  it("uses the ceiling declared on the model", () => {
    const projected = projectAgentMessagesForModel(imageHistory(31), model({ maxImagesPerRequest: 8 }));
    expect(imageCount(projected.messages)).toBe(8);
    expect(projected.omittedImageCount).toBe(23);
  });

  it("does not count images already replaced for being undersized", () => {
    const history = imageHistory(3);
    (history[0] as UserMessage).content = [
      { type: "text", text: "thin" },
      { type: "image", data: THIN_432X2_JPEG, mimeType: "image/jpeg" },
    ];
    const projected = projectAgentMessagesForModel(history, model({ maxImagesPerRequest: 2 }));
    expect(imageCount(projected.messages)).toBe(2);
    expect(projected.omittedImageCount).toBe(0);
  });
});

describe("text-only turn after more than 30 historical images (real HTTP transport)", () => {
  const LIMIT = 30;
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let requestImages: number[];

  function respond(request: IncomingMessage, response: ServerResponse): void {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw) as { messages?: Array<{ content?: unknown }> };
      const images = (body.messages ?? []).reduce(
        (total, message) =>
          total +
          (Array.isArray(message.content)
            ? message.content.filter((part: { type?: string }) => part?.type === "image_url").length
            : 0),
        0,
      );
      requestImages.push(images);
      if (images > LIMIT) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: `Upstream [invalid_request_error] Too many images in request: ${images} > ${LIMIT}`,
            },
          }),
        );
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

  beforeEach(async () => {
    requestImages = [];
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

  async function runTextTurn(turnModel: Model<any>, history: AgentMessage[]) {
    const events: RuntimeEvent[] = [];
    await new PiTurnRunner().runTurn({
      sessionId: "session-425-images",
      turnId: "turn-text",
      workspaceDir: process.cwd(),
      systemPrompt: "You are a test.",
      userMessage: { text: "hi" },
      history,
      llm: { model: turnModel, apiKey: "synthetic" },
      llmRetry: { policy: { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 1 } },
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
    const status = events.filter((event) => event.type === RuntimeEventType.SESSION_STATUS).at(-1);
    return status?.payload;
  }

  it("sends at most the ceiling and the turn succeeds", async () => {
    const status = await runTextTurn(model({ baseUrl }), imageHistory(44));

    expect(status?.status).toBe(RuntimeEventStatus.COMPLETED);
    expect(requestImages).toEqual([DEFAULT_MAX_IMAGES_PER_REQUEST]);
  });

  it("fails a provider rejection for too many images once, without BYOK retries", async () => {
    // A model that declares a higher ceiling than its gateway accepts still
    // hits the rejection; it must surface immediately instead of being
    // re-sent through the whole BYOK backoff window.
    const status = await runTextTurn(model({ baseUrl, maxImagesPerRequest: 100 }), imageHistory(31));

    expect(status?.status).toBe(RuntimeEventStatus.FAILED);
    expect(JSON.stringify(status)).toContain("Too many images in request: 31 > 30");
    expect(requestImages).toEqual([31]);
  });
});
