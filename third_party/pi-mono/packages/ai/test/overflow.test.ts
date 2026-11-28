import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";

function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "ollama",
		model: "qwen3.5:35b",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isContextOverflow", () => {
	it("detects explicit Ollama prompt-too-long errors", () => {
		const message = createErrorMessage("400 `prompt too long; exceeded max context length by 100918 tokens`");
		expect(isContextOverflow(message, 32768)).toBe(true);
	});

	it("detects Together AI context length errors", () => {
		const message = createErrorMessage(
			"400 The input (516368 tokens) is longer than the model's context length (262144 tokens).",
		);
		expect(isContextOverflow(message, 262144)).toBe(true);
	});

	it("detects LiteLLM-wrapped OpenAI maximum context length errors", () => {
		const message = createErrorMessage(
			"Error: 503 litellm.ServiceUnavailableError: litellm.MidStreamFallbackError: litellm.APIConnectionError: APIConnectionError: OpenAIException - Requested token count exceeds the model's maximum context length of 131072 tokens.",
		);
		expect(isContextOverflow(message, 131072)).toBe(true);
	});

	it("detects OpenRouter Poolside maximum allowed input length errors", () => {
		const message = createErrorMessage(
			"Provider returned error: Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
		);
		expect(isContextOverflow(message, 131072)).toBe(true);
	});

	it("does not treat generic non-overflow Ollama errors as overflow", () => {
		const message = createErrorMessage("500 `model runner crashed unexpectedly`");
		expect(isContextOverflow(message, 32768)).toBe(false);
	});

	it("does not treat Bedrock throttling 'Too many tokens' as overflow", () => {
		// Bedrock returns this for HTTP 429 rate limiting, NOT context overflow.
		// formatBedrockError uses a human-readable prefix for ThrottlingException.
		const message = createErrorMessage("Throttling error: Too many tokens, please wait before trying again.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat Bedrock service unavailable as overflow", () => {
		const message = createErrorMessage("Service unavailable: The service is temporarily unavailable.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat generic rate limit errors as overflow", () => {
		const message = createErrorMessage("Rate limit exceeded, please retry after 30 seconds.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat HTTP 429 style errors as overflow", () => {
		const message = createErrorMessage("Too many requests. Please slow down.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	function createLengthStopMessage(input: number, cacheRead: number, output: number): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "xiaomi",
			model: "mimo-v2.5-pro",
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite: 0,
				totalTokens: input + cacheRead + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
	}

	it("detects Xiaomi-style overflow (length stop with zero output and filled context)", () => {
		const message = createLengthStopMessage(58, 1048512, 0);
		expect(isContextOverflow(message, 1048576)).toBe(true);
	});

	it("does not treat normal length stops with output as overflow", () => {
		const message = createLengthStopMessage(1000, 0, 4096);
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat length stops far below context as overflow", () => {
		const message = createLengthStopMessage(100, 0, 0);
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	function createStopMessage(usage: {
		input: number;
		cacheRead: number;
		output: number;
		contextTokens?: number;
	}): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-4-carbon",
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: 0,
				totalTokens: usage.input + usage.cacheRead + usage.output,
				...(usage.contextTokens !== undefined ? { contextTokens: usage.contextTokens } : {}),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	it("does not misclassify multi-hop continuation cumulative input as silent overflow when single-turn contextTokens fits", () => {
		const message = createStopMessage({
			input: 1_200_000,
			cacheRead: 65_536,
			output: 80_000,
			contextTokens: 680_000,
		});
		expect(isContextOverflow(message, 1_048_576)).toBe(false);
	});

	it("still detects silent overflow on multi-hop continuation when single-turn prompt exceeds contextWindow", () => {
		const message = createStopMessage({
			input: 2_200_000,
			cacheRead: 65_536,
			output: 80_000,
			contextTokens: 1_180_000,
		});
		expect(isContextOverflow(message, 1_048_576)).toBe(true);
	});

	it("uses single-turn contextTokens for zero-output length-stop overflow checks", () => {
		const belowWindow: AssistantMessage = {
			...createLengthStopMessage(1_200_000, 0, 0),
			usage: {
				...createLengthStopMessage(1_200_000, 0, 0).usage,
				contextTokens: 600_000,
			},
		};
		expect(isContextOverflow(belowWindow, 1_048_576)).toBe(false);

		const fillingWindow: AssistantMessage = {
			...createLengthStopMessage(2_097_000, 0, 0),
			usage: {
				...createLengthStopMessage(2_097_000, 0, 0).usage,
				contextTokens: 1_048_500,
			},
		};
		expect(isContextOverflow(fillingWindow, 1_048_576)).toBe(true);
	});
});
