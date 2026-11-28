import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { getModel } from "../src/models.ts";
import { streamSimpleGoogle } from "../src/providers/google.ts";
import { streamSimpleGoogleVertex } from "../src/providers/google-vertex.ts";
import type { AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "../src/types.ts";

type Api = "google-generative-ai" | "google-vertex";
type Chunk = Record<string, unknown>;
let server: Server;
let origin: string;
let replies: Array<{ chunks?: Chunk[]; status?: number }>;
let requests: Array<{ url: string; body: Record<string, unknown> }>;

beforeEach(async () => {
	replies = [];
	requests = [];
	server = createServer(async (req, res) => {
		const buffers: Buffer[] = [];
		for await (const buffer of req) buffers.push(Buffer.from(buffer));
		requests.push({ url: req.url ?? "", body: JSON.parse(Buffer.concat(buffers).toString()) });
		const reply = replies.shift();
		if (!reply || reply.status) {
			res.writeHead(reply?.status ?? 400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { code: reply?.status ?? 400, message: "fixture rejected request" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const chunk of reply.chunks ?? []) res.write("data: " + JSON.stringify(chunk) + "\n\n");
		res.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});

afterEach(async () => {
	const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	server.closeAllConnections();
	await closed;
});

const context: Context = {
	systemPrompt: "Keep the complete answer.",
	messages: [{ role: "user", content: "Produce the long answer, then call finish.", timestamp: 0 }],
	tools: [{ name: "finish", description: "Finish the answer", parameters: Type.Object({ ok: Type.Boolean() }) }],
};

function run(api: Api, options: SimpleStreamOptions = {}, id = "gemini-4-carbon", baseUrl?: string) {
	const model: Model<Api> = {
		id,
		name: id,
		api,
		provider: api === "google-vertex" ? "google-vertex" : "google",
		baseUrl: baseUrl ?? (api === "google-vertex" ? origin : origin + "/v1beta"),
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		// Explicit caller budgets must not be clamped to outdated catalog metadata.
		maxTokens: 32_768,
		cost: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 },
	};
	const opts = { apiKey: "fixture-key", reasoning: "high" as const, maxTokens: 200_000, ...options };
	return api === "google-vertex"
		? streamSimpleGoogleVertex(model as Model<"google-vertex">, context, opts)
		: streamSimpleGoogle(model as Model<"google-generative-ai">, context, opts);
}

function chunk(text: string, finishReason?: string, continuationToken?: string): Chunk {
	return {
		candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason, continuationToken }],
	};
}

for (const api of ["google-generative-ai", "google-vertex"] as const) {
	describe("Gemini 4 continuation over HTTP: " + api, () => {
		it("resends the original payload with the latest token and emits one complete tool turn", async () => {
			replies = [
				{
					chunks: [
						{
							candidates: [
								{ content: { parts: [{ text: "plan", thought: true, thoughtSignature: "c2ln" }] } },
							],
						},
						{
							...chunk("first ", "CONTINUATION", "dG9rZW4x"),
							usageMetadata: {
								promptTokenCount: 100,
								candidatesTokenCount: 65_516,
								thoughtsTokenCount: 20,
								totalTokenCount: 65_636,
							},
						},
					],
				},
				{
					chunks: [
						{
							...chunk("second "),
							usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 100, totalTokenCount: 300 },
						},
						{
							...chunk("", "CONTINUATION", "dG9rZW4y"),
							usageMetadata: {
								promptTokenCount: 200,
								cachedContentTokenCount: 150,
								candidatesTokenCount: 65_536,
								totalTokenCount: 65_736,
							},
						},
					],
				},
				{
					chunks: [
						chunk("last"),
						{
							candidates: [
								{
									content: {
										parts: [
											{
												functionCall: { id: "call-1", name: "finish", args: { ok: true } },
												thoughtSignature: "c2ln",
											},
										],
									},
									finishReason: "STOP",
								},
							],
							usageMetadata: {
								promptTokenCount: 300,
								cachedContentTokenCount: 250,
								candidatesTokenCount: 17,
								totalTokenCount: 317,
							},
						},
					],
				},
			];
			const stream = run(api);
			const events: AssistantMessageEvent["type"][] = [];
			for await (const event of stream) events.push(event.type);
			const result = await stream.result();
			expect(result.errorMessage).toBeUndefined();
			expect(requests).toHaveLength(3);
			const initial = requests[0].body;
			expect(initial).not.toHaveProperty("continuationToken");
			expect(initial.generationConfig).toMatchObject({
				maxOutputTokens: 200_000,
				thinkingConfig: { thinkingLevel: "HIGH" },
			});
			expect(initial).toHaveProperty("systemInstruction");
			expect(initial).toHaveProperty("tools");
			expect(requests[1].body).toEqual({ ...initial, continuationToken: "dG9rZW4x" });
			expect(requests[2].body).toEqual({ ...initial, continuationToken: "dG9rZW4y" });
			expect(requests.every((request) => request.url.includes(":streamGenerateContent"))).toBe(true);
			if (api === "google-vertex") expect(requests[0].url).toEqual(expect.stringMatching("^/v1beta1/"));
			expect(events.filter((type) => type === "start")).toHaveLength(1);
			expect(events.filter((type) => type === "done")).toHaveLength(1);
			expect(result.stopReason).toBe("toolUse");
			expect(result.content).toEqual([
				{ type: "thinking", thinking: "plan", thinkingSignature: "c2ln" },
				{ type: "text", text: "first second last" },
				{ type: "toolCall", id: "call-1", name: "finish", arguments: { ok: true }, thoughtSignature: "c2ln" },
			]);
			expect(result.usage).toMatchObject({
				input: 200,
				cacheRead: 400,
				output: 131_089,
				totalTokens: 131_689,
				contextTokens: 131_189,
			});
			expect(result.usage.cost.total).toBeCloseTo((200 + 400 * 0.1 + 131_089 * 10) / 1_000_000);
		});

		it.each([65_536, 65_537, 1_048_576])(
			"preserves a %i token budget and stops naturally without a token",
			async (maxTokens) => {
				replies = [
					{
						chunks: [
							{
								...chunk("done", "STOP"),
								usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 4, totalTokenCount: 104 },
							},
						],
					},
				];
				const result = await run(api, { maxTokens }).result();
				expect(result.stopReason).toBe("stop");
				expect(requests).toHaveLength(1);
				expect(requests[0].body.generationConfig).toHaveProperty("maxOutputTokens", maxTokens);
				expect(result.usage.contextTokens).toBeUndefined();
			},
		);

		it.each([0, 1])("keeps all usage when hop %i ends with traffic-only metadata", async (hop) => {
			replies = [
				{
					chunks: [
						{
							...chunk("a", "CONTINUATION", "dG9rZW4x"),
							usageMetadata: {
								promptTokenCount: 100,
								candidatesTokenCount: 65_536,
								totalTokenCount: 65_636,
							},
						},
					],
				},
				{
					chunks: [
						{
							...chunk("b", "STOP"),
							usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 10, totalTokenCount: 210 },
						},
					],
				},
			];
			replies[hop].chunks?.push({ usageMetadata: { trafficType: "ON_DEMAND" } });
			const result = await run(api).result();
			expect(result.stopReason).toBe("stop");
			expect(result.usage).toMatchObject({
				input: 300,
				output: 65_546,
				totalTokens: 65_846,
				contextTokens: 65_646,
			});
			expect(result.usage.cost.total).toBeCloseTo((300 + 65_546 * 10) / 1_000_000);
		});

		it("stops at MAX_TOKENS after continuation without restarting generation", async () => {
			replies = [{ chunks: [chunk("a", "CONTINUATION", "dG9rZW4x")] }, { chunks: [chunk("b", "MAX_TOKENS")] }];
			const result = await run(api).result();
			expect(requests).toHaveLength(2);
			expect(result.stopReason).toBe("length");
			expect(result.content).toEqual([{ type: "text", text: "ab" }]);
		});

		it("fails clearly when CONTINUATION has no token", async () => {
			replies = [{ chunks: [chunk("partial", "CONTINUATION")] }];
			const result = await run(api).result();
			expect(requests).toHaveLength(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("without a usable continuation token");
		});

		it("does not loop when the provider repeats its continuation token", async () => {
			replies = [
				{ chunks: [chunk("a", "CONTINUATION", "dG9rZW4x")] },
				{ chunks: [chunk("b", "CONTINUATION", "dG9rZW4x")] },
			];
			const result = await run(api).result();
			expect(requests).toHaveLength(2);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("Google stream ended with CONTINUATION without a usable continuation token");
		});

		it("preserves partial output and reports rejection of a continuation request", async () => {
			replies = [{ chunks: [chunk("partial", "CONTINUATION", "dG9rZW4x")] }, { status: 403 }];
			const result = await run(api).result();
			expect(requests).toHaveLength(2);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("fixture rejected request");
			expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		});

		it("does not start another request when aborted at a checkpoint", async () => {
			const controller = new AbortController();
			replies = [{ chunks: [chunk("partial", "CONTINUATION", "dG9rZW4x")] }];
			const result = await run(api, {
				signal: controller.signal,
				onProviderStreamEvent: () => controller.abort(),
			}).result();
			expect(result.stopReason).toBe("aborted");
			expect(requests).toHaveLength(1);
		});

		it("resumes an unfinished stream from its last checkpoint without replaying text", async () => {
			replies = [
				{ chunks: [chunk("partial ", undefined, "dG9rZW4x")] },
				{ chunks: [chunk("continued", "STOP")] },
			];
			const result = await run(api).result();
			expect(result.stopReason).toBe("stop");
			expect(requests).toHaveLength(2);
			expect(requests[1].body).toEqual({ ...requests[0].body, continuationToken: "dG9rZW4x" });
			expect(result.content).toEqual([{ type: "text", text: "partial continued" }]);
		});

		it("reports a dropped stream without a checkpoint as an error", async () => {
			replies = [{ chunks: [chunk("partial")] }];
			const result = await run(api).result();
			expect(result.stopReason).toBe("error");
			expect(requests).toHaveLength(1);
		});

		it("keeps Gemini 3 continuation behavior unchanged", async () => {
			replies = [{ chunks: [chunk("partial", "CONTINUATION", "dG9rZW4x")] }];
			const result = await run(api, {}, "gemini-3.8-flash").result();
			expect(result.stopReason).toBe("length");
			expect(requests).toHaveLength(1);
			if (api === "google-vertex") expect(requests[0].url).toEqual(expect.stringMatching("^/v1/"));
		});
	});
}

it.each([
	"/v1",
	"/v1/",
	"/v1?key=override",
	"/api/v2/vertex/v1/projects/v1beta1/locations/global",
])("rejects an explicitly versioned Vertex v1 endpoint (%s) before sending a long-output request", async (suffix) => {
	const result = await run("google-vertex", {}, "gemini-4-argon", origin + suffix).result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("requires a v1beta1 Vertex endpoint");
	expect(requests).toHaveLength(0);
});

it("evaluates the Vertex v1 long-output guard against the effective onPayload request", async () => {
	replies = [{ chunks: [chunk("ok", "STOP")] }];
	const lowered = await run(
		"google-vertex",
		{
			onPayload: (payload) => {
				const next = payload as { config?: { maxOutputTokens?: number } };
				return { ...next, config: { ...next.config, maxOutputTokens: 32_768 } };
			},
		},
		"gemini-4-argon",
		origin + "/v1",
	).result();
	expect(lowered.stopReason).toBe("stop");
	expect(requests).toHaveLength(1);

	requests = [];
	const raised = await run(
		"google-vertex",
		{
			maxTokens: 32_768,
			onPayload: (payload) => {
				const next = payload as { config?: { maxOutputTokens?: number } };
				return { ...next, config: { ...next.config, maxOutputTokens: 200_000 } };
			},
		},
		"gemini-4-argon",
		origin + "/v1",
	).result();
	expect(raised.stopReason).toBe("error");
	expect(raised.errorMessage).toContain("requires a v1beta1 Vertex endpoint");
	expect(requests).toHaveLength(0);
});

it("configures a 256K default maxTokens ceiling for built-in gemini-4-argon models", () => {
	expect(getModel("google", "gemini-4-argon").maxTokens).toBe(262_144);
	expect(getModel("google-vertex", "gemini-4-argon").maxTokens).toBe(262_144);
});

it("supports versioned Vertex proxies and publisher-qualified Gemini 4 model IDs", async () => {
	replies = [{ chunks: [chunk("a", "CONTINUATION", "dG9rZW4x")] }, { chunks: [chunk("b", "STOP")] }];
	const result = await run(
		"google-vertex",
		{},
		"publishers/google/models/gemini-4-argon",
		origin + "/v1beta1",
	).result();
	expect(result.stopReason).toBe("stop");
	expect(requests).toHaveLength(2);
	expect(requests[0].url).toEqual(
		expect.stringContaining("/v1beta1/publishers/google/models/gemini-4-argon:streamGenerateContent"),
	);
});
