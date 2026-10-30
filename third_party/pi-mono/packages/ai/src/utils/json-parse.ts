import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

type JsonReviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

const INTEGER_LITERAL = /^-?(?:0|[1-9]\d*)$/;

/**
 * Keeps integer literals that a double cannot hold exactly as their source digits.
 *
 * Models sometimes emit long digit strings (ID numbers, snowflake IDs) as unquoted JSON
 * numbers. Plain JSON.parse rounds them to the nearest double, and schema coercion then
 * stringifies the rounded value, so a string parameter silently receives different digits.
 * Keeping the source text lets string parameters receive the digits the model emitted, while
 * number/integer parameters coerce the string back to the same double as before.
 * Relies on JSON.parse source text access (Node 21+); without it the rounded number is kept.
 */
const preserveUnsafeIntegerSource: JsonReviver = (_key, value, context) => {
	if (
		typeof value === "number" &&
		!Number.isSafeInteger(value) &&
		typeof context?.source === "string" &&
		INTEGER_LITERAL.test(context.source)
	) {
		return context.source;
	}
	return value;
};

export function parseJsonWithRepair<T>(json: string, reviver?: JsonReviver): T {
	try {
		return JSON.parse(json, reviver) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson, reviver) as T;
		}
		throw error;
	}
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 * Integers beyond Number.MAX_SAFE_INTEGER in complete JSON are returned as their source digits.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson, preserveUnsafeIntegerSource);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}
