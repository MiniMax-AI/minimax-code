import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context } from "../src/types.ts";

// Synthetic fixtures shaped like a gateway stream that was cut mid-thinking and then closed
// with an empty stop_reason. No real user content.

const encoder = new TextEncoder();
const MISSING_STOP_REASON = "Anthropic stream ended without stop_reason (";
const THINKING_TEXT = "synthetic-thinking-fragment";

function sseChunk(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

function streamingResponse(body: ReadableStream<Uint8Array>): Response {
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function runStream(chunks: string[]) {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return runResponse(streamingResponse(body));
}

function runResponse(response: Response, signal?: AbortSignal) {
	const model = getModel("anthropic", "claude-haiku-4-5");
	const context: Context = {
		messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
	};
	return streamAnthropic(model, context, {
		client: createFakeAnthropicClient(response),
		...(signal ? { signal } : {}),
	}).result();
}

const MESSAGE_START = sseChunk("message_start", {
	type: "message_start",
	message: {
		id: "msg_missing_stop_reason",
		usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
});

/** Thinking block that was cut off: no signature and no content_block_stop. */
const TRUNCATED_THINKING = [
	sseChunk("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "thinking", thinking: "" },
	}),
	sseChunk("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "thinking_delta", thinking: THINKING_TEXT },
	}),
].join("");

const TOOL_BLOCK = [
	sseChunk("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
	}),
	sseChunk("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
	}),
	sseChunk("content_block_stop", { type: "content_block_stop", index: 0 }),
].join("");

const TEXT_BLOCK = [
	sseChunk("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	}),
	sseChunk("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "Hello" },
	}),
	sseChunk("content_block_stop", { type: "content_block_stop", index: 0 }),
].join("");

function messageDelta(delta: Record<string, unknown>, usage = { input_tokens: 0, output_tokens: 0 }): string {
	return sseChunk("message_delta", { type: "message_delta", delta, usage });
}

const MESSAGE_STOP = sseChunk("message_stop", { type: "message_stop" });

describe("Anthropic stream without stop_reason", () => {
	it("fails a truncated thinking stream closed with an empty stop_reason and keeps the thinking", async () => {
		const result = await runStream([
			MESSAGE_START,
			TRUNCATED_THINKING,
			messageDelta({ stop_reason: "" }),
			MESSAGE_STOP,
		]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage?.startsWith(MISSING_STOP_REASON)).toBe(true);
		expect(result.errorMessage).toContain("messageDeltaCount=1");
		expect(result.errorMessage).toMatch(/eofAtMs=\d+/);
		expect(result.errorMessage).not.toContain(THINKING_TEXT);
		expect(result.errorMessage).not.toContain("data=");
		expect(result.content).toEqual([expect.objectContaining({ type: "thinking", thinking: THINKING_TEXT })]);
	});

	it("fails when the message_delta omits stop_reason", async () => {
		const result = await runStream([MESSAGE_START, TEXT_BLOCK, messageDelta({}), MESSAGE_STOP]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage?.startsWith(MISSING_STOP_REASON)).toBe(true);
	});

	it("fails a message with no content blocks and an empty stop_reason", async () => {
		const result = await runStream([MESSAGE_START, messageDelta({ stop_reason: "" }), MESSAGE_STOP]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage?.startsWith(MISSING_STOP_REASON)).toBe(true);
		expect(result.content).toEqual([]);
	});

	it("accepts a stop_reason that arrives on a later message_delta", async () => {
		const result = await runStream([
			MESSAGE_START,
			TEXT_BLOCK,
			messageDelta({ stop_reason: null }),
			messageDelta({ stop_reason: "end_turn" }, { input_tokens: 7, output_tokens: 2 }),
			MESSAGE_STOP,
		]);

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("keeps a normal tool_use stream successful", async () => {
		const result = await runStream([
			MESSAGE_START,
			TOOL_BLOCK,
			messageDelta({ stop_reason: "tool_use" }, { input_tokens: 7, output_tokens: 3 }),
			MESSAGE_STOP,
		]);

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content.map((block) => block.type)).toEqual(["toolCall"]);
	});

	it("keeps a normal end_turn stream successful", async () => {
		const result = await runStream([
			MESSAGE_START,
			TEXT_BLOCK,
			messageDelta({ stop_reason: "end_turn" }, { input_tokens: 7, output_tokens: 2 }),
			MESSAGE_STOP,
		]);

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("reports an abort mid-stream as aborted, not as a missing stop_reason", async () => {
		const abortController = new AbortController();
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls === 1) {
					controller.enqueue(encoder.encode(MESSAGE_START + TRUNCATED_THINKING));
					return;
				}
				abortController.abort();
				controller.enqueue(encoder.encode(messageDelta({ stop_reason: "" }) + MESSAGE_STOP));
				controller.close();
			},
		});

		const result = await runResponse(streamingResponse(body), abortController.signal);

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage ?? "").not.toContain("without stop_reason");
	});
});
