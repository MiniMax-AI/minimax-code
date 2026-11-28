import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { setImmediate } from "node:timers/promises";
import { Type } from "typebox";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { AssistantMessageEvent, Context, Model, OpenAICompletionsCompat } from "../src/types.ts";

const context: Context = {
	systemPrompt: "Be concise.",
	messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
	tools: [
		{
			name: "read",
			description: "Read a file",
			parameters: Type.Object(
				{ path: Type.String() },
				{
					$id: "read-tool",
					$schema: "https://json-schema.org/draft/2020-12/schema",
				},
			),
		},
	],
};

// Reproduce the three rejected pre-fix fields through the real request builder.
// This is not a copy of the entire historical implementation.
const legacyCompat: OpenAICompletionsCompat = {
	supportsStore: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
};

interface Exchange {
	body: Record<string, unknown>;
	status: number;
	rejectedFields: string[];
}

describe("Mistral compatibility over real HTTP and SSE", () => {
	let server: Server;
	let model: Model<"openai-completions">;
	const exchanges: Exchange[] = [];

	beforeAll(async () => {
		// Deliberately narrow fixture: the three rejection rules from the ticket,
		// not an assertion that we emulate every rule of the live Mistral service.
		server = createServer((request, response) => {
			void (async () => {
				if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
					response.writeHead(404).end();
					return;
				}
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
				const rejectedFields = ["store", "stream_options", "max_completion_tokens"].filter((field) =>
					Object.hasOwn(body, field),
				);
				const status = rejectedFields.length > 0 ? 422 : 200;
				exchanges.push({ body, status, rejectedFields });
				if (status === 422) {
					response.writeHead(422, { "content-type": "application/json" }).end(
						JSON.stringify({
							error: {
								message: `Unsupported fields: ${rejectedFields.join(", ")}`,
								type: "invalid_request_error",
								param: rejectedFields[0],
								code: "extra_forbidden",
							},
						}),
					);
					return;
				}

				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				const choices = [
					{ index: 0, delta: { role: "assistant" }, finish_reason: null },
					{ index: 0, delta: { content: "Hello " }, finish_reason: null },
					{ index: 0, delta: { content: "世界" }, finish_reason: null },
					{ index: 0, delta: {}, finish_reason: "stop" },
				];
				for (const choice of choices) {
					const frame = Buffer.from(
						`data: ${JSON.stringify({
							id: "chatcmpl-local-mistral",
							object: "chat.completion.chunk",
							created: 1,
							model: "mistral-local-test",
							choices: [choice],
						})}\n\n`,
					);
					// Split framing and a multibyte UTF-8 character across writes.
					const unicodeOffset = frame.indexOf("世界");
					const split = unicodeOffset >= 0 ? unicodeOffset + 1 : 3;
					response.write(frame.subarray(0, split));
					await setImmediate();
					response.write(frame.subarray(split));
				}
				response.end("data: [DONE]\n\n");
			})().catch(() => {
				if (!response.headersSent) response.writeHead(500);
				response.end();
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected a local TCP listener");
		model = {
			id: "mistral-local-test",
			name: "Local Mistral fixture",
			api: "openai-completions",
			provider: "mistral",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32000,
			maxTokens: 4096,
		};
	});

	beforeEach(() => {
		exchanges.length = 0;
	});
	afterAll(async () => {
		if (!server?.listening) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			server.closeAllConnections();
		});
	});

	async function request(compat?: OpenAICompletionsCompat) {
		const events: AssistantMessageEvent[] = [];
		const errors: unknown[] = [];
		const statuses: number[] = [];
		const stream = streamOpenAICompletions({ ...model, compat }, context, {
			apiKey: "local-fixture-only",
			maxTokens: 123,
			cacheRetention: "long",
			sessionId: "mistral-local-session",
			reasoningEffort: "high",
			timeoutMs: 5000,
			maxRetries: 0,
			onProviderError: (error) => {
				errors.push(error);
			},
			onResponse: (response) => {
				statuses.push(response.status);
			},
		});
		for await (const event of stream) events.push(event);
		return { result: await stream.result(), events, errors, statuses };
	}

	it("rejects the pre-fix fields with 422, then accepts default Mistral projection and parses SSE", async () => {
		const before = await request(legacyCompat);
		expect(exchanges).toHaveLength(1);
		expect(exchanges[0]).toMatchObject({
			status: 422,
			rejectedFields: ["store", "stream_options", "max_completion_tokens"],
			body: { store: false, stream_options: { include_usage: true }, max_completion_tokens: 123 },
		});
		expect(exchanges[0].body).not.toHaveProperty("max_tokens");
		expect(before.errors).toHaveLength(1);
		expect(before.errors[0]).toMatchObject({ status: 422, code: "extra_forbidden", param: "store" });
		expect(before.events.map((event) => event.type)).toEqual(["error"]);
		expect(before.result.stopReason).toBe("error");
		expect(before.result.errorMessage).toContain("Unsupported fields: store, stream_options, max_completion_tokens");

		const after = await request();
		expect(exchanges).toHaveLength(2);
		expect(exchanges[1]).toMatchObject({
			status: 200,
			rejectedFields: [],
			body: { model: "mistral-local-test", stream: true, max_tokens: 123 },
		});
		for (const field of [
			"store",
			"stream_options",
			"max_completion_tokens",
			"prompt_cache_key",
			"prompt_cache_retention",
			"reasoning_effort",
		]) {
			expect(exchanges[1].body).not.toHaveProperty(field);
		}
		expect(exchanges[1].body.tools).toEqual([
			{
				type: "function",
				function: {
					name: "read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
			},
		]);
		expect(after.statuses).toEqual([200]);
		expect(after.errors).toEqual([]);
		expect(after.events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(after.events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual([
			"Hello ",
			"世界",
		]);
		expect(after.result).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Hello 世界" }],
			stopReason: "stop",
		});
		expect(after.result.errorMessage).toBeUndefined();
		console.info(
			JSON.stringify({
				before: { ...exchanges[0], errorMessage: before.result.errorMessage },
				after: { ...exchanges[1], content: after.result.content, events: after.events.map((event) => event.type) },
			}),
		);
	});

	it.each([
		["store", { supportsStore: true }],
		["stream_options", { supportsUsageInStreaming: true }],
		["max_completion_tokens", { maxTokensField: "max_completion_tokens" }],
	] satisfies [string, OpenAICompletionsCompat][])(
		"rejects %s even when the other two forbidden fields are absent",
		async (field, compat) => {
			const response = await request(compat);
			expect(exchanges).toHaveLength(1);
			expect(exchanges[0]).toMatchObject({ status: 422, rejectedFields: [field] });
			expect(response.errors).toHaveLength(1);
			expect(response.errors[0]).toMatchObject({ status: 422, param: field });
			expect(response.result.stopReason).toBe("error");
			expect(response.events.map((event) => event.type)).toEqual(["error"]);
		},
	);
});
