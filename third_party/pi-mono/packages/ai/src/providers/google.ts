import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type HttpOptions,
	type ThinkingConfig,
} from "@google/genai";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { notifyProviderError } from "../utils/provider-error.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import type { GoogleThinkingLevel } from "./google-shared.ts";
import {
	consumeGoogleStream,
	convertMessages,
	convertTools,
	getDisabledGoogleThinkingConfig,
	getGeminiMajorVersion,
	mapToolChoice,
	resolveGoogleThinkingRequest,
	toGoogleSdkThinkingLevel,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

/** Gemini `thinkingConfig` request field, as sent by this transport. */
export type GoogleThinkingConfig = ThinkingConfig;

export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		level?: GoogleThinkingLevel;
	};
}

export const streamGoogle: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: GoogleOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-generative-ai" as Api,
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
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const client = createClient(model, apiKey, options?.headers, options?.fetch);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			const googleStream = await client.models.generateContentStream(params);
			await consumeGoogleStream(googleStream, output, stream, model, options);
		} catch (error) {
			notifyProviderError(options?.onProviderError, error, model);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleGoogle: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	return streamGoogle(model, context, {
		...buildBaseOptions(model, options, apiKey),
		thinking: resolveGoogleThinkingRequest(model, options?.reasoning, options?.thinkingBudgets),
	} satisfies GoogleOptions);
};

function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: Record<string, string>,
	fetch?: StreamOptions["fetch"],
): GoogleGenAI {
	const httpOptions: HttpOptions = {};
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
	}
	if (model.headers || optionsHeaders) {
		httpOptions.headers = { ...model.headers, ...optionsHeaders };
	}
	// Send through the host transport (proxy, CA, capture) like the other providers.
	if (fetch) httpOptions.fetch = fetch;

	return new GoogleGenAI({
		apiKey,
		httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
	});
}

function buildParams(
	model: Model<"google-generative-ai">,
	context: Context,
	options: GoogleOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);

	// The SDK resumes CONTINUATION with the original prompt and output budget.
	const generationConfig: GenerateContentConfig = {
		automaticContinuation: getGeminiMajorVersion(model.id) === 4,
	};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
		...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) }),
	};

	if (context.tools && context.tools.length > 0 && options.toolChoice) {
		config.toolConfig = {
			functionCallingConfig: {
				mode: mapToolChoice(options.toolChoice),
			},
		};
	} else {
		config.toolConfig = undefined;
	}

	const thinkingConfig = buildThinkingConfig(model, options.thinking);
	if (thinkingConfig) config.thinkingConfig = thinkingConfig;

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	return {
		model: model.id,
		contents,
		config,
	};
}

/**
 * The `thinkingConfig` that `streamSimpleGoogle` sends for a pi reasoning level
 * (`undefined` reasoning means thinking off). Hosts use it to build REST probes
 * that match real turns.
 */
export function getSimpleGoogleThinkingConfig(
	model: Model<"google-generative-ai">,
	reasoning?: SimpleStreamOptions["reasoning"],
	thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"],
): ThinkingConfig | undefined {
	return buildThinkingConfig(model, resolveGoogleThinkingRequest(model, reasoning, thinkingBudgets));
}

function buildThinkingConfig(
	model: Model<"google-generative-ai">,
	thinking: GoogleOptions["thinking"],
): ThinkingConfig | undefined {
	if (!model.reasoning || !thinking) return undefined;
	if (!thinking.enabled) return getDisabledGoogleThinkingConfig(model);
	const thinkingConfig: ThinkingConfig = { includeThoughts: true };
	if (thinking.level !== undefined) {
		thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(thinking.level);
	} else if (thinking.budgetTokens !== undefined) {
		thinkingConfig.thinkingBudget = thinking.budgetTokens;
	}
	return thinkingConfig;
}
