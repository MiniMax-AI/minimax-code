import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type HttpOptions,
	ResourceScope,
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

export interface GoogleVertexOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		level?: GoogleThinkingLevel;
	};
	project?: string;
	location?: string;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

export const streamGoogleVertex: StreamFunction<"google-vertex", GoogleVertexOptions> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-vertex" as Api,
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
			const apiKey = resolveApiKey(options);
			// Create the client using either a Vertex API key, if provided, or ADC with project and location
			const client = apiKey
				? createClientWithApiKey(model, apiKey, options?.headers, options?.fetch)
				: createClient(model, resolveProject(options), resolveLocation(options), options?.headers, options?.fetch);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			if (
				getGeminiMajorVersion(params.model || model.id) === 4 &&
				(params.config?.maxOutputTokens ?? 0) > 65_536 &&
				resolveBaseUrlApiVersion(model.baseUrl) === "v1"
			) {
				throw new Error(
					"Gemini 4 output above 65,536 tokens requires a v1beta1 Vertex endpoint; update the base URL from v1 to v1beta1",
				);
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

export const streamSimpleGoogleVertex: StreamFunction<"google-vertex", SimpleStreamOptions> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	return streamGoogleVertex(model, context, {
		...buildBaseOptions(model, options, undefined),
		thinking: resolveGoogleThinkingRequest(model, options?.reasoning, options?.thinkingBudgets),
	} satisfies GoogleVertexOptions);
};

function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	optionsHeaders?: Record<string, string>,
	fetch?: StreamOptions["fetch"],
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		project,
		location,
		apiVersion: getGeminiMajorVersion(model.id) === 4 ? "v1beta1" : API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders, fetch),
	});
}

function createClientWithApiKey(
	model: Model<"google-vertex">,
	apiKey: string,
	optionsHeaders?: Record<string, string>,
	fetch?: StreamOptions["fetch"],
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		apiKey,
		apiVersion: getGeminiMajorVersion(model.id) === 4 ? "v1beta1" : API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders, fetch),
	});
}

function buildHttpOptions(
	model: Model<"google-vertex">,
	optionsHeaders?: Record<string, string>,
	fetch?: StreamOptions["fetch"],
): HttpOptions | undefined {
	const httpOptions: HttpOptions = {};
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	if (baseUrl) {
		httpOptions.baseUrl = baseUrl;
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
		if (resolveBaseUrlApiVersion(baseUrl) !== undefined) {
			httpOptions.apiVersion = "";
		}
	}

	if (model.headers || optionsHeaders) {
		httpOptions.headers = { ...model.headers, ...optionsHeaders };
	}
	// Send through the host transport (proxy, CA, capture) like the other providers.
	if (fetch) httpOptions.fetch = fetch;

	return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed || trimmed.includes("{location}")) {
		return undefined;
	}
	return trimmed;
}

function resolveBaseUrlApiVersion(baseUrl: string): string | undefined {
	const resolved = resolveCustomBaseUrl(baseUrl);
	if (!resolved) return undefined;
	let pathname = resolved;
	try {
		pathname = new URL(resolved).pathname;
	} catch {
		pathname = resolved.split(/[?#]/, 1)[0] ?? resolved;
	}
	let version: string | undefined;
	const parts = pathname.split("/");
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index] ?? "";
		const prev = index > 0 ? (parts[index - 1] ?? "").toLowerCase() : "";
		if (prev === "projects" || prev === "locations" || prev === "publishers" || prev === "models") {
			continue;
		}
		if (/^v\d+(?:beta\d*)?$/i.test(part)) {
			version = part.toLowerCase();
		}
	}
	return version;
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	const apiKey = options?.apiKey?.trim();
	if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
		return undefined;
	}
	return apiKey;
}

function isPlaceholderApiKey(apiKey: string): boolean {
	return /^<[^>]+>$/.test(apiKey);
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project = options?.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
	const location = options?.location || process.env.GOOGLE_CLOUD_LOCATION;
	if (!location) {
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	}
	return location;
}

function buildParams(
	model: Model<"google-vertex">,
	context: Context,
	options: GoogleVertexOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);

	const longOutputModel = getGeminiMajorVersion(model.id) === 4;
	const generationConfig: GenerateContentConfig = { automaticContinuation: longOutputModel };
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

	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = getDisabledGoogleThinkingConfig(model);
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	const params: GenerateContentParameters = {
		model: model.id,
		contents,
		config,
	};

	return params;
}
