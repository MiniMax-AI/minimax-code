import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.ts";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "../src/types.ts";

// A reply cut off in the middle of a tool call is stored with stopReason "aborted" (or
// "error"). transformMessages skips that reply; a tool result written for it afterwards
// (e.g. by crash recovery after a restart) must be skipped with it, or the request
// carries a tool result whose tool call is gone and the API rejects every request.

const model: Model<"anthropic-messages"> = {
	id: "model-a",
	name: "Model A",
	api: "anthropic-messages",
	provider: "provider-a",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8_192,
};

function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function assistant(
	toolCallIds: readonly string[],
	stopReason: AssistantMessage["stopReason"],
	source: { provider: string; model: string } = { provider: model.provider, model: model.id },
): AssistantMessage {
	return {
		role: "assistant",
		content: toolCallIds.map((id) => ({ type: "toolCall" as const, id, name: "run_code", arguments: {} })),
		api: "anthropic-messages",
		provider: source.provider,
		model: source.model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(stopReason === "aborted" ? { errorMessage: "Request was aborted" } : {}),
		timestamp: 1,
	};
}

function toolResult(toolCallId: string, text = "done"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "run_code",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 3 });

function toolResultIds(messages: readonly Message[]): string[] {
	return messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : []));
}

function toolCallIds(messages: readonly Message[]): string[] {
	return messages.flatMap((message) =>
		message.role === "assistant" ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) : [],
	);
}

describe("transformMessages with skipped assistant messages", () => {
	it.each(["aborted", "error"] as const)("drops the tool results of a %s assistant message", (stopReason) => {
		const output = transformMessages(
			[user("start"), assistant(["call_cut"], stopReason), toolResult("call_cut", "interrupted"), user("next")],
			model,
		);

		expect(toolCallIds(output)).toEqual([]);
		expect(toolResultIds(output)).toEqual([]);
		expect(output.map((message) => message.role)).toEqual(["user", "user"]);
	});

	it("recovers a stuck history: earlier tool rounds stay, only the aborted round goes", () => {
		// The shape of a conversation that failed every request after a restart:
		// a completed run_code round, then a run_code reply aborted mid-stream
		// followed by the result crash recovery wrote for it.
		const output = transformMessages(
			[
				user("do it"),
				assistant(["call_done"], "toolUse"),
				toolResult("call_done"),
				assistant(["call_cut"], "aborted"),
				toolResult("call_cut", "PTC_INTERRUPTED_BY_RUNTIME_RESTART"),
				user("continue please"),
			],
			model,
		);

		expect(toolCallIds(output)).toEqual(["call_done"]);
		expect(toolResultIds(output)).toEqual(["call_done"]);
		expect(output.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
	});

	it("matches the results by normalized ID when the aborted message came from another model", () => {
		const output = transformMessages(
			[
				user("start"),
				assistant(["call|cut"], "aborted", { provider: "other", model: "other-model" }),
				toolResult("call|cut"),
				user("next"),
			],
			model,
			normalizeToolCallId,
		);

		expect(toolResultIds(output)).toEqual([]);
	});

	it("keeps the result of a later valid message that reuses the tool call ID", () => {
		const output = transformMessages(
			[
				user("start"),
				assistant(["call_same"], "aborted"),
				assistant(["call_same"], "toolUse"),
				toolResult("call_same"),
			],
			model,
		);

		expect(toolCallIds(output)).toEqual(["call_same"]);
		expect(toolResultIds(output)).toEqual(["call_same"]);
	});

	it("leaves complete tool rounds and synthesized results unchanged", () => {
		const output = transformMessages(
			[user("start"), assistant(["call_a", "call_b"], "toolUse"), toolResult("call_a"), user("next")],
			model,
		);

		expect(toolCallIds(output)).toEqual(["call_a", "call_b"]);
		expect(toolResultIds(output)).toEqual(["call_a", "call_b"]);
	});
});
