import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { streamSimpleGoogle } from "../src/providers/google.ts";
import { streamSimpleGoogleVertex } from "../src/providers/google-vertex.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

type Api = "google-generative-ai" | "google-vertex";
let server: Server;
let origin: string;
let receivedBodies: string[];

beforeEach(async () => {
	receivedBodies = [];
	server = createServer(async (req, res) => {
		const buffers: Buffer[] = [];
		for await (const buffer of req) buffers.push(Buffer.from(buffer));
		receivedBodies.push(Buffer.concat(buffers).toString());
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(
			"data: " +
				JSON.stringify({
					candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
				}) +
				"\n\n",
		);
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
	messages: [{ role: "user", content: "Say ok.", timestamp: 0 }],
};

function run(api: Api, options: SimpleStreamOptions) {
	const model: Model<Api> = {
		id: "gemini-4-carbon",
		name: "gemini-4-carbon",
		api,
		provider: api === "google-vertex" ? "google-vertex" : "google",
		baseUrl: api === "google-vertex" ? origin : origin + "/v1beta",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 32_768,
		cost: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 },
	};
	const opts = { apiKey: "fixture-key", ...options };
	return api === "google-vertex"
		? streamSimpleGoogleVertex(model as Model<"google-vertex">, context, opts)
		: streamSimpleGoogle(model as Model<"google-generative-ai">, context, opts);
}

for (const api of ["google-generative-ai", "google-vertex"] as const) {
	describe("Gemini transport uses the caller fetch: " + api, () => {
		it("sends the request through options.fetch with the JSON body the server receives", async () => {
			const seen: Array<{ url: string; body: unknown }> = [];
			const callerFetch: typeof fetch = async (input, init) => {
				seen.push({ url: String(input instanceof Request ? input.url : input), body: init?.body });
				return fetch(input, init);
			};

			const result = await run(api, { fetch: callerFetch }).result();

			expect(result.stopReason).toBe("stop");
			expect(seen).toHaveLength(1);
			expect(seen[0]?.url).toContain(":streamGenerateContent");
			expect(typeof seen[0]?.body).toBe("string");
			expect(seen[0]?.body).toBe(receivedBodies[0]);
			expect(JSON.parse(String(seen[0]?.body))).toMatchObject({
				contents: [{ role: "user", parts: [{ text: "Say ok." }] }],
			});
		});
	});
}
