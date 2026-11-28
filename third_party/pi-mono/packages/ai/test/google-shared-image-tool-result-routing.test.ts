import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/providers/google-shared.ts";
import type { Context, Model } from "../src/types.ts";

function makeModel<TApi extends "google-generative-ai">(
	api: TApi,
	provider: Model<TApi>["provider"],
	id: string,
): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function makeContext(
	model: { api: string; provider: string; id: string },
	mediaMimeType = "image/png",
): Context {
	const now = Date.now();
	return {
		messages: [
			{ role: "user", content: "read the files", timestamp: now },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.txt" } },
					{ type: "toolCall", id: "call_img", name: "read", arguments: { path: "image.png" } },
					{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "b.txt" } },
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
			{
				role: "toolResult",
				toolCallId: "call_a",
				toolName: "read",
				content: [{ type: "text", text: "alpha text" }],
				isError: false,
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_img",
				toolName: "read",
				content: [{ type: "image", data: "abc", mimeType: mediaMimeType }],
				isError: false,
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_b",
				toolName: "read",
				content: [{ type: "text", text: "beta text" }],
				isError: false,
				timestamp: now,
			},
		],
	};
}

describe("google-shared image tool result routing", () => {
	it("keeps parallel function responses together and appends images after them for Gemini 2.x", () => {
		const model = makeModel("google-generative-ai", "google", "gemini-2.5-flash");
		const contents = convertMessages(model, makeContext(model));

		expect(contents).toHaveLength(3);
		const parts = contents[2].parts ?? [];
		expect(parts).toHaveLength(5);
		expect(parts.slice(0, 3).every((part) => part.functionResponse && !part.functionResponse.parts)).toBe(true);
		expect(parts[3]?.text).toBe("Tool result image:");
		expect(parts[4]?.inlineData).toEqual({ mimeType: "image/png", data: "abc" });
	});

	it("nests image tool results for Gemini 3 Google API models", () => {
		const model = makeModel("google-generative-ai", "google", "gemini-3-pro-preview");
		const contents = convertMessages(model, makeContext(model));

		expect(contents).toHaveLength(3);
		const toolResultTurn = contents[2];
		expect(toolResultTurn.parts).toHaveLength(3);
		const imageResponse = toolResultTurn.parts?.[1]?.functionResponse;
		expect(imageResponse).toBeTruthy();
		expect(imageResponse?.parts).toHaveLength(1);
		expect(imageResponse?.parts?.[0]?.inlineData).toBeTruthy();
	});

	it.each(["audio/mpeg", "video/mp4"])("appends %s tool output after the Gemini 3 function responses", (mimeType) => {
		const model = makeModel("google-generative-ai", "google", "gemini-4-argon");
		const contents = convertMessages(model, makeContext(model, mimeType));

		expect(contents).toHaveLength(3);
		const parts = contents[2].parts ?? [];
		expect(parts.slice(0, 3).every((part) => part.functionResponse && !part.functionResponse.parts)).toBe(true);
		expect(parts.slice(3)).toEqual([{ text: "Tool result media from read:" }, { inlineData: { mimeType, data: "abc" } }]);
	});

	it("carries user text after parallel tool results inside the last function response", () => {
		const model = makeModel("google-generative-ai", "google", "gemini-3.8-flash");
		const context = makeContext(model, "application/pdf");
		context.messages.push(
			{ role: "user", content: "<system-reminder>todo</system-reminder>", timestamp: Date.now() },
			{ role: "user", content: [{ type: "text", text: "what now?" }], timestamp: Date.now() },
		);
		const contents = convertMessages(model, context);

		expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
		const parts = contents[2].parts ?? [];
		expect(parts).toHaveLength(3);
		expect(parts.every((part) => part.functionResponse && part.text === undefined)).toBe(true);
		expect(parts[0].functionResponse?.response).toEqual({ output: "alpha text" });
		expect(parts[2].functionResponse?.response).toEqual({
			output: "beta text",
			user_message: "<system-reminder>todo</system-reminder>\n\nwhat now?",
		});
	});

	it("carries user text beside the error of a failed tool result", () => {
		const model = makeModel("google-generative-ai", "google", "gemini-3.8-flash");
		const context = makeContext(model, "application/pdf");
		const lastResult = context.messages[context.messages.length - 1];
		if (lastResult.role === "toolResult") lastResult.isError = true;
		context.messages.push({ role: "user", content: "try again", timestamp: Date.now() });
		const contents = convertMessages(model, context);

		expect(contents[2].parts?.[2]?.functionResponse?.response).toEqual({
			error: "beta text",
			user_message: "try again",
		});
	});

	it("keeps a user image beside the function responses because it cannot ride their text", () => {
		const model = makeModel("google-generative-ai", "google", "gemini-3.8-flash");
		const context = makeContext(model, "application/pdf");
		context.messages.push({
			role: "user",
			content: [
				{ type: "text", text: "see this" },
				{ type: "image", data: "xyz", mimeType: "image/png" },
			],
			timestamp: Date.now(),
		});
		const contents = convertMessages(model, context);

		expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
		const parts = contents[2].parts ?? [];
		expect(parts.slice(0, 3).every((part) => part.functionResponse)).toBe(true);
		expect(parts.slice(3)).toEqual([{ text: "see this" }, { inlineData: { mimeType: "image/png", data: "xyz" } }]);
		expect(parts[2].functionResponse?.response).toEqual({ output: "beta text" });
	});

	it("does not treat text folded into function responses as a new turn for placeholder signatures", () => {
		const model = makeModel("google-generative-ai", "google", "gemini-3.8-flash");
		const context = makeContext({ ...model, id: "gemini-2.5-flash", provider: "other" }, "application/pdf");
		context.messages.push({ role: "user", content: "<system-reminder>todo</system-reminder>", timestamp: Date.now() });
		const contents = convertMessages(model, context);

		// The unsigned cross-model step stays in Gemini's current turn, so it must be signed.
		expect(contents[1].parts?.find((part) => part.functionCall)?.thoughtSignature).toBe(
			"skip_thought_signature_validator",
		);
	});

	it("nests PDF tool output inside the Gemini 3 function response", () => {
		const model = makeModel("google-generative-ai", "google", "gemini-4-argon");
		const contents = convertMessages(model, makeContext(model, "application/pdf"));

		expect(contents).toHaveLength(3);
		expect(contents[2].parts?.[1]?.functionResponse?.parts).toEqual([
			{ inlineData: { mimeType: "application/pdf", data: "abc" } },
		]);
	});
});
