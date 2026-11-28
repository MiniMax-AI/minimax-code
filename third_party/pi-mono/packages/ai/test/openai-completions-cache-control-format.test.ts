import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { Model } from "../src/types.ts";

interface CacheControl {
	type: "ephemeral";
	ttl?: string;
}

interface TextPart {
	type: "text";
	text: string;
	cache_control?: CacheControl;
}

interface ToolWithCacheControl {
	type: string;
	cache_control?: CacheControl;
	function?: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
		strict?: boolean;
	};
}

interface CapturedParams {
	messages: Array<{
		role: string;
		content: string | TextPart[] | null;
	}>;
	tools?: ToolWithCacheControl[];
	store?: boolean;
	stream_options?: { include_usage?: boolean };
	max_tokens?: number;
	max_completion_tokens?: number;
	reasoning_effort?: string;
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedParams | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedParams) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

async function capturePayload(
	model: Model<"openai-completions">,
	options?: {
		cacheRetention?: "none" | "short" | "long";
		maxTokens?: number;
		sessionId?: string;
		reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	},
): Promise<CapturedParams> {
	const timestamp = Date.now();

	await streamOpenAICompletions(
		model,
		{
			systemPrompt: "System prompt",
			messages: [{ role: "user", content: "Hello", timestamp }],
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: Type.Object(
						{
							path: Type.String(),
						},
						{ $id: "read-tool", $schema: "https://json-schema.org/draft/2020-12/schema" },
					),
				},
			],
		},
		{ apiKey: "test-key", ...options },
	).result();

	if (!mockState.lastParams) {
		throw new Error("Expected payload to be captured");
	}

	// The OpenAI client serializes the params before sending; undefined keys are omitted.
	return JSON.parse(JSON.stringify(mockState.lastParams)) as CapturedParams;
}

function getInstructionMessage(params: CapturedParams) {
	return params.messages.find((message) => message.role === "system" || message.role === "developer");
}

function expectAnthropicCacheMarkers(params: CapturedParams): void {
	const instructionMessage = getInstructionMessage(params);
	expect(instructionMessage).toBeDefined();
	expect(Array.isArray(instructionMessage?.content)).toBe(true);
	expect((instructionMessage?.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });

	expect(params.tools).toHaveLength(1);
	expect(params.tools?.[0]?.cache_control).toEqual({ type: "ephemeral" });

	const lastMessage = params.messages[params.messages.length - 1];
	expect(lastMessage.role).toBe("user");
	expect(Array.isArray(lastMessage.content)).toBe(true);
	expect((lastMessage.content as TextPart[])[0]?.cache_control).toEqual({ type: "ephemeral" });
}

describe("openai-completions request compatibility", () => {
	function createModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
		const { compat: _compat, ...base } = getModel("openai", "gpt-4o-mini");
		return { ...base, api: "openai-completions", ...overrides };
	}

	it.each([
		["official Mistral host", createModel({ provider: "custom", baseUrl: "https://api.mistral.ai:443/v1", reasoning: true })],
		["Mistral provider name", createModel({ provider: "mistral", baseUrl: "https://gateway.example.com/v1", reasoning: true })],
	])("projects %s to the Mistral-compatible outbound body", async (_name, model) => {
		const params = await capturePayload(model, {
			cacheRetention: "long",
			maxTokens: 123,
			sessionId: "mistral-session",
			reasoningEffort: "high",
		});

		expect(params).not.toHaveProperty("store");
		expect(params).not.toHaveProperty("stream_options");
		expect(params.max_tokens).toBe(123);
		expect(params).not.toHaveProperty("max_completion_tokens");
		expect(params).not.toHaveProperty("reasoning_effort");
		expect(params).not.toHaveProperty("prompt_cache_key");
		expect(params).not.toHaveProperty("prompt_cache_retention");
		const toolFunction = params.tools?.[0]?.function;
		expect(toolFunction?.strict).toBeUndefined();
		expect(toolFunction?.parameters).not.toHaveProperty("$schema");
		expect(toolFunction?.parameters).not.toHaveProperty("$id");
	});

	it("preserves the default outbound body for OpenAI and rejects lookalike hosts", async () => {
		const openaiParams = await capturePayload(createModel({ provider: "custom", baseUrl: "https://api.openai.com/v1" }), {
			cacheRetention: "long",
			maxTokens: 123,
			sessionId: "openai-session",
		});
		expect(openaiParams.store).toBe(false);
		expect(openaiParams.stream_options).toEqual({ include_usage: true });
		expect(openaiParams.max_completion_tokens).toBe(123);
		expect(openaiParams.max_tokens).toBeUndefined();
		expect(openaiParams.prompt_cache_key).toBe("openai-session");
		expect(openaiParams.prompt_cache_retention).toBe("24h");
		expect(openaiParams.tools?.[0]?.function?.strict).toBe(false);
		expect(openaiParams.tools?.[0]?.function?.parameters).toHaveProperty("$schema");
		expect(openaiParams.tools?.[0]?.function?.parameters).toHaveProperty("$id");

		const lookalikeParams = await capturePayload(
			createModel({ provider: "custom", baseUrl: "https://api.mistral.ai.example/v1" }),
			{ maxTokens: 123 },
		);
		expect(lookalikeParams.store).toBe(false);
		expect(lookalikeParams.stream_options).toEqual({ include_usage: true });
		expect(lookalikeParams.max_completion_tokens).toBe(123);
	});

	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("applies Anthropic-style cache markers when model compat enables them", async () => {
		const model: Model<"openai-completions"> = {
			id: "custom-qwen",
			name: "Custom Qwen",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 32000,
			compat: {
				cacheControlFormat: "anthropic",
			},
		};

		const params = await capturePayload(model);
		expectAnthropicCacheMarkers(params);
	});

	it("preserves Anthropic-style cache markers for OpenRouter Anthropic models", async () => {
		const model = getModel("openrouter", "anthropic/claude-sonnet-4");
		const params = await capturePayload(model);
		expectAnthropicCacheMarkers(params);
	});

	it("omits Anthropic-style cache markers when cacheRetention is none", async () => {
		const model: Model<"openai-completions"> = {
			id: "custom-qwen",
			name: "Custom Qwen",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 32000,
			compat: {
				cacheControlFormat: "anthropic",
			},
		};
		const params = await capturePayload(model, { cacheRetention: "none" });
		const instructionMessage = getInstructionMessage(params);

		expect(Array.isArray(instructionMessage?.content)).toBe(false);
		expect(params.tools?.[0]?.cache_control).toBeUndefined();
		expect(typeof params.messages[params.messages.length - 1]?.content).toBe("string");
	});
});
