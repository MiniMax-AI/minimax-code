import type * as GoogleGenAiModule from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	chunks: [] as Array<Record<string, unknown>>,
}));

vi.mock("@google/genai", async (importOriginal) => {
	const actual = await importOriginal<typeof GoogleGenAiModule>();
	class GoogleGenAI {
		models = {
			generateContentStream: async () =>
				(async function* () {
					yield* googleGenAiMock.chunks;
				})(),
		};
	}
	return { ...actual, GoogleGenAI };
});

import { streamGoogle, streamSimpleGoogle } from "../src/providers/google.ts";
import { streamGoogleVertex, streamSimpleGoogleVertex } from "../src/providers/google-vertex.ts";
import type { AssistantMessageEvent, Context, Model, ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };

function googleModel(id: string, thinkingLevelMap?: ThinkingLevelMap): Model<"google-generative-ai"> {
	return {
		id,
		name: id,
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://example.invalid/v1beta",
		reasoning: true,
		...(thinkingLevelMap && { thinkingLevelMap }),
		input: ["text"],
		cost: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	};
}

function vertexModel(id: string, thinkingLevelMap?: ThinkingLevelMap): Model<"google-vertex"> {
	return { ...googleModel(id, thinkingLevelMap), api: "google-vertex", provider: "google-vertex" };
}

const adapters = [
	{ name: "Google Generative AI", run: () => streamGoogle(googleModel("gemini-3.5-flash"), context, { apiKey: "k" }) },
	{
		name: "Google Vertex",
		run: () => streamGoogleVertex(vertexModel("gemini-3.5-flash"), context, { apiKey: "k" }),
	},
] as const;

beforeEach(() => {
	googleGenAiMock.chunks = [];
});

describe("Google stream consumption", () => {
	it.each(adapters)("emits thinking, text and tool call blocks with signatures for $name", async ({ run }) => {
		googleGenAiMock.chunks = [
			{ responseId: "resp_1", candidates: [{ content: { parts: [{ text: "plan", thought: true }] } }] },
			{ candidates: [{ content: { parts: [{ text: " more", thought: true, thoughtSignature: "c2lnMQ==" }] } }] },
			{ candidates: [{ content: { parts: [{ text: "Hi" }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: { id: "call_a", name: "bash", args: { cmd: "ls" } },
									thoughtSignature: "c2lnMg==",
								},
								{ functionCall: { id: "call_b", name: "read", args: { path: "a" } } },
							],
						},
						finishReason: "STOP",
					},
				],
			},
		];

		const stream = run();
		const types: AssistantMessageEvent["type"][] = [];
		for await (const event of stream) types.push(event.type);
		const message = await stream.result();

		expect(types).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(message.stopReason).toBe("toolUse");
		expect(message.responseId).toBe("resp_1");
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "plan more", thinkingSignature: "c2lnMQ==" },
			{ type: "text", text: "Hi" },
			{ type: "toolCall", id: "call_a", name: "bash", arguments: { cmd: "ls" }, thoughtSignature: "c2lnMg==" },
			{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "a" } },
		]);
	});

	it.each(adapters)("keeps the signature of a trailing empty text part for $name", async ({ run }) => {
		googleGenAiMock.chunks = [
			{ candidates: [{ content: { parts: [{ text: "Done" }] } }] },
			{ candidates: [{ content: { parts: [{ text: "", thoughtSignature: "c2lnMw==" }] }, finishReason: "STOP" }] },
		];

		const message = await run().result();

		expect(message.content).toEqual([{ type: "text", text: "Done", textSignature: "c2lnMw==" }]);
	});

	it.each(adapters)(
		"parses cumulative usage including cache, thinking and tool-use tokens for $name",
		async ({ run }) => {
			googleGenAiMock.chunks = [
				{
					candidates: [{ content: { parts: [{ text: "a" }] } }],
					usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, totalTokenCount: 100 },
				},
				{ candidates: [{ content: { parts: [{ text: "b" }] } }], usageMetadata: { trafficType: "ON_DEMAND" } },
				{
					candidates: [{ finishReason: "STOP" }],
					usageMetadata: {
						promptTokenCount: 100,
						cachedContentTokenCount: 40,
						toolUsePromptTokenCount: 5,
						candidatesTokenCount: 20,
						thoughtsTokenCount: 30,
						totalTokenCount: 155,
					},
				},
			];

			const message = await run().result();

			expect(message.usage).toMatchObject({ input: 65, output: 50, cacheRead: 40, cacheWrite: 0, totalTokens: 155 });
			expect(message.usage.cost.total).toBeCloseTo((65 * 1 + 50 * 10 + 40 * 0.1) / 1_000_000);
		},
	);

	it.each([
		{ finishReason: "MAX_TOKENS", stopReason: "length" },
		{ finishReason: "CONTINUATION", stopReason: "length" },
	])("maps $finishReason to $stopReason even with a tool call", async ({ finishReason, stopReason }) => {
		googleGenAiMock.chunks = [
			{
				candidates: [{ content: { parts: [{ functionCall: { id: "c", name: "bash", args: {} } }] }, finishReason }],
			},
		];

		const message = await streamGoogle(googleModel("gemini-3.5-flash"), context, { apiKey: "k" }).result();

		expect(message.stopReason).toBe(stopReason);
	});

	it.each(["MALFORMED_FUNCTION_CALL", "MISSING_THOUGHT_SIGNATURE", "SAFETY"])(
		"reports %s as a provider error",
		async (finishReason) => {
			googleGenAiMock.chunks = [{ candidates: [{ finishReason, finishMessage: "details" }] }];

			const message = await streamGoogle(googleModel("gemini-3.5-flash"), context, { apiKey: "k" }).result();

			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toBe(`Provider stopped with: ${finishReason} (details)`);
		},
	);

	it("reports a blocked prompt and a truncated stream as errors", async () => {
		googleGenAiMock.chunks = [{ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }];
		const blocked = await streamGoogle(googleModel("gemini-3.5-flash"), context, { apiKey: "k" }).result();
		expect(blocked.stopReason).toBe("error");
		expect(blocked.errorMessage).toBe("Prompt blocked by provider: PROHIBITED_CONTENT");

		googleGenAiMock.chunks = [{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }];
		const truncated = await streamGoogle(googleModel("gemini-3.5-flash"), context, { apiKey: "k" }).result();
		expect(truncated.stopReason).toBe("error");
		expect(truncated.errorMessage).toBe("Google stream ended without a finish reason");
	});
});

async function capturePayload(
	model: Model<"google-generative-ai"> | Model<"google-vertex">,
	reasoning?: ThinkingLevel,
): Promise<GenerateContentParameters> {
	let payload: GenerateContentParameters | undefined;
	const options = {
		apiKey: "k",
		reasoning,
		onPayload: (request: unknown) => {
			payload = request as GenerateContentParameters;
			throw new Error("payload captured");
		},
	};
	const result =
		model.api === "google-generative-ai"
			? await streamSimpleGoogle(model as Model<"google-generative-ai">, context, options).result()
			: await streamSimpleGoogleVertex(model as Model<"google-vertex">, context, options).result();
	expect(result.errorMessage).toContain("payload captured");
	if (!payload) throw new Error("payload was not captured");
	return payload;
}

const payloadAdapters = [
	{ name: "Google Generative AI", model: googleModel },
	{ name: "Google Vertex", model: vertexModel },
] as const;

describe("Google thinking request", () => {
	it.each(payloadAdapters)("sends the native level for Gemini 3.x on $name", async ({ model }) => {
		const payload = await capturePayload(model("gemini-3.1-pro-preview", { off: null, minimal: null }), "medium");
		expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" });
	});

	it.each(payloadAdapters)("uses thinking levels for Gemini 4 on $name", async ({ model }) => {
		const payload = await capturePayload(model("gemini-4-argon"), "high");
		expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
	});

	it.each(payloadAdapters)(
		"falls back to the lowest supported level when reasoning is off on $name",
		async ({ model }) => {
			const payload = await capturePayload(model("gemini-3.1-pro-preview", { off: null, minimal: null }));
			expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
		},
	);

	it.each(payloadAdapters)("disables Gemini 2.5 thinking with a zero budget on $name", async ({ model }) => {
		const payload = await capturePayload(model("gemini-2.5-flash"));
		expect(payload.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
	});

	it.each(payloadAdapters)(
		"uses thinkingLevel LOW instead of thinkingBudget 0 for qualified Gemini 3/4 model IDs on $name",
		async ({ model }) => {
			for (const id of [
				"models/gemini-4-argon",
				"publishers/google/models/gemini-4-argon",
				"google/gemini-3.8-flash",
			]) {
				const payload = await capturePayload(model(id));
				expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
			}
		},
	);

	it.each(payloadAdapters)("keeps thinkingBudget 0 for Gemma 4 models when reasoning is off on $name", async ({ model }) => {
		const payload = await capturePayload(model("models/gemma-4-27b-it"));
		expect(payload.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
	});

	it.each(payloadAdapters)("maps extended levels through the model map on $name", async ({ model }) => {
		const payload = await capturePayload(model("gemini-3.5-flash", { xhigh: "high", max: "high" }), "max");
		expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
	});
});
