import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/providers/google-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

function makeGemini3Model<TApi extends "google-generative-ai" | "google-vertex">(
	api: TApi,
	provider: Model<TApi>["provider"],
	id = "gemini-3-pro-preview",
): Model<TApi> {
	return {
		id,
		name: "Gemini 3 Pro Preview",
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function makeContext(model: { api: string; provider: string; id: string }, thoughtSignature?: string): Context {
	const now = Date.now();
	return {
		messages: [
			{ role: "user", content: "Hi", timestamp: now },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "bash",
						arguments: { command: "echo hi" },
						...(thoughtSignature && { thoughtSignature }),
					},
					{
						type: "toolCall",
						id: "call_2",
						name: "bash",
						arguments: { command: "ls -la" },
					},
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: now,
			},
		],
	};
}

describe("google-shared convertMessages — Gemini 3 unsigned tool calls", () => {
	// Gemini 3+ rejects the request with 400 when the first function call of a current-turn step
	// is unsigned; the Gemini Developer API accepts the documented placeholder instead.
	it("signs only the first unsigned current-turn call with the placeholder for Google Gen AI", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const contents = convertMessages(model, makeContext({ ...model, id: "other-model" }));

		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];
		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBe("skip_thought_signature_validator");
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();

		const textParts = modelTurn?.parts?.filter((p) => p.text !== undefined) ?? [];
		const historicalText = textParts.filter((p) => p.text?.includes("Historical context"));
		expect(historicalText).toHaveLength(0);
	});

	it("leaves unsigned calls of earlier turns untouched for Google Gen AI", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const context = makeContext({ ...model, id: "other-model" });
		const toolCallTurn = context.messages[1] as AssistantMessage;
		context.messages.push(
			{ role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [], isError: false, timestamp: 1 },
			{ role: "toolResult", toolCallId: "call_2", toolName: "bash", content: [], isError: false, timestamp: 1 },
			{ ...toolCallTurn, content: [{ type: "text", text: "Done" }], stopReason: "stop" },
			{ role: "user", content: "Next question", timestamp: 2 },
		);
		const contents = convertMessages(model, context);

		expect(JSON.stringify(contents)).not.toContain("skip_thought_signature_validator");
	});

	it("does not add skip_thought_signature_validator for unsigned Vertex tool calls", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const contents = convertMessages(model, makeContext(model));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBeUndefined();
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();
		expect(JSON.stringify(modelTurn)).not.toContain("skip_thought_signature_validator");
	});

	it("preserves valid thoughtSignature when present for the same provider and model", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const validSig = "AAAAAAAAAAAAAAAAAAAAAA==";
		const contents = convertMessages(model, makeContext(model, validSig));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBe(validSig);
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();
	});

	it("does not add a thoughtSignature for non-Gemini-3 models", () => {
		const model = makeGemini3Model("google-generative-ai", "google", "gemini-2.5-flash");
		const contents = convertMessages(model, makeContext({ ...model, id: "other-model" }));
		const modelTurn = contents.find((c) => c.role === "model");
		const fcPart = modelTurn?.parts?.find((p) => p.functionCall !== undefined);

		expect(fcPart).toBeTruthy();
		expect(fcPart?.thoughtSignature).toBeUndefined();
	});
});
