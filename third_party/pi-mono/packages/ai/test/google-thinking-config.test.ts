import { describe, expect, it } from "vitest";
import { getSimpleGoogleThinkingConfig } from "../src/providers/google.js";
import {
	getDisabledGoogleThinkingConfig,
	usesGoogleThinkingLevel,
} from "../src/providers/google-shared.js";
import type { Model, ThinkingLevelMap } from "../src/types.js";

function makeGoogleModel(id: string, thinkingLevelMap?: ThinkingLevelMap): Model<"google-generative-ai"> {
	return {
		id,
		name: id,
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: true,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	};
}

describe("Google thinkingConfig resolution", () => {
	it.each([
		["gemini-flash-latest", true],
		["gemini-flash-lite-latest", true],
		["gemini-pro-latest", true],
		["gemini-4-carbon", true],
		["gemini-4-hydrogen", true],
		["gemini-2.5-pro", false],
		["gemini-2.5-flash", false],
	])("detects usesGoogleThinkingLevel(%s) === %s", (id, expected) => {
		expect(usesGoogleThinkingLevel(makeGoogleModel(id))).toBe(expected);
	});

	it("uses discrete thinkingLevel for custom gateway model IDs with an explicit thinkingLevelMap", () => {
		const customModel = makeGoogleModel("gateway/custom-gemini-next", { high: "high" });
		expect(usesGoogleThinkingLevel(customModel)).toBe(true);
		expect(getSimpleGoogleThinkingConfig(customModel, "high")).toEqual({
			includeThoughts: true,
			thinkingLevel: "HIGH",
		});
	});

	it("keeps Gemini 2.5 models on thinkingBudget even when a thinkingLevelMap is attached", () => {
		const flash25 = makeGoogleModel("gemini-2.5-flash", { low: "low" });
		expect(usesGoogleThinkingLevel(flash25)).toBe(false);
		expect(getSimpleGoogleThinkingConfig(flash25, "low")).toEqual({
			includeThoughts: true,
			thinkingBudget: 2048,
		});
	});

	it("sends XHIGH when explicitly mapped on Gemini 4 Hydrogen", () => {
		const hydrogen = makeGoogleModel("gemini-4-hydrogen", { xhigh: "xhigh" });
		expect(getSimpleGoogleThinkingConfig(hydrogen, "xhigh")).toEqual({
			includeThoughts: true,
			thinkingLevel: "XHIGH",
		});
	});

	it("clamps unmapped xhigh to HIGH on Gemini 4 Carbon", () => {
		const carbon = makeGoogleModel("gemini-4-carbon");
		expect(getSimpleGoogleThinkingConfig(carbon, "xhigh")).toEqual({
			includeThoughts: true,
			thinkingLevel: "HIGH",
		});
	});

	it("uses minimum budget 128 on gemini-2.5-pro, 0 on Gemma 4 / 2.5-flash, and LOW on rolling aliases", () => {
		expect(getDisabledGoogleThinkingConfig(makeGoogleModel("gemini-2.5-pro"))).toEqual({
			thinkingBudget: 128,
		});
		expect(getDisabledGoogleThinkingConfig(makeGoogleModel("gemini-2.5-flash"))).toEqual({
			thinkingBudget: 0,
		});
		expect(getDisabledGoogleThinkingConfig(makeGoogleModel("models/gemma-4-27b-it"))).toEqual({
			thinkingBudget: 0,
		});
		expect(getDisabledGoogleThinkingConfig(makeGoogleModel("gemini-flash-latest"))).toEqual({
			thinkingLevel: "LOW",
		});
	});
});
