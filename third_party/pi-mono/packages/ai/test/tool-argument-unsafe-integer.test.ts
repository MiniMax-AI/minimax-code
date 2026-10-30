import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Tool, ToolCall } from "../src/types.ts";
import { parseStreamingJson } from "../src/utils/json-parse.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

const usage = { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function toolUseSse(tool: string, partialJsonChunks: string[]): Response {
	const events = [
		{ type: "message_start", message: { id: "msg_test", usage: { ...usage, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_test", name: tool, input: {} } },
		...partialJsonChunks.map((partial_json) => ({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json },
		})),
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage },
		{ type: "message_stop" },
	];
	const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeClient(response: Response): Anthropic {
	return { messages: { create: () => ({ asResponse: async () => response }) } } as unknown as Anthropic;
}

async function streamToolCall(tool: Tool, partialJsonChunks: string[]): Promise<ToolCall> {
	const context: Context = {
		messages: [{ role: "user", content: "Submit the result.", timestamp: Date.now() }],
		tools: [tool],
	};
	const stream = streamAnthropic(getModel("anthropic", "claude-haiku-4-5"), context, {
		client: fakeClient(toolUseSse(tool.name, partialJsonChunks)),
	});
	const result = await stream.result();
	expect(result.stopReason).toBe("toolUse");
	const toolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
	if (!toolCall) throw new Error("expected a tool call");
	return toolCall;
}

describe("tool-call arguments with integers beyond Number.MAX_SAFE_INTEGER", () => {
	it("keeps the digits of an unquoted long number for a string parameter", async () => {
		// Plain JSON Schema, as host-defined structured-result tools send it.
		const submit = {
			name: "submit",
			description: "Submit entities.",
			parameters: {
				type: "object",
				required: ["entities"],
				additionalProperties: false,
				properties: {
					entities: {
						type: "array",
						items: {
							type: "object",
							required: ["typeId", "text"],
							additionalProperties: false,
							properties: { typeId: { type: "string" }, text: { type: "string", minLength: 1 } },
						},
					},
				},
			},
		} as unknown as Tool;

		// The model emitted the 18-digit ID without quotes, split across stream deltas.
		const toolCall = await streamToolCall(submit, [
			'{"entities":[{"typeId":"id-number","text":4401031980',
			'04279575},{"typeId":"phone","text":16765277584}]}',
		]);

		expect(validateToolArguments(submit, toolCall)).toEqual({
			entities: [
				{ typeId: "id-number", text: "440103198004279575" },
				{ typeId: "phone", text: "16765277584" },
			],
		});
	});

	it("gives numeric parameters the same value as before", async () => {
		const tool: Tool = {
			name: "lookup",
			description: "Look up a row.",
			parameters: Type.Object({ id: Type.Integer(), score: Type.Number(), label: Type.String() }),
		};

		const toolCall = await streamToolCall(tool, ['{"id":440103198004279575,"score":2.5,"label":2512292042121000001}']);

		expect(validateToolArguments(tool, toolCall)).toEqual({
			id: 440103198004279575,
			score: 2.5,
			label: "2512292042121000001",
		});
	});

	it("only rewrites integer literals that a double cannot hold exactly", () => {
		expect(
			parseStreamingJson('{"max":9007199254740991,"neg":-9007199254740993,"big":9007199254740993,"float":1.5,"exp":1e21,"inner":"9007199254740993"}'),
		).toEqual({
			max: 9007199254740991,
			neg: "-9007199254740993",
			big: "9007199254740993",
			float: 1.5,
			exp: 1e21,
			inner: "9007199254740993",
		});
	});
});
