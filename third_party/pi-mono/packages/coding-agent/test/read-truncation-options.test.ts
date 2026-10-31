import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/core/tools/truncate.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("");
}

describe("read text truncation options", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "read-truncation-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("keeps the default line limit when no option is given", async () => {
		const lines = Array.from({ length: DEFAULT_MAX_LINES + 5 }, (_, index) => `line-${index + 1}`);
		writeFileSync(join(cwd, "long.txt"), lines.join("\n"));

		const result = await createReadTool(cwd).execute("read", { path: "long.txt" });

		expect(textOf(result)).toContain(`[Showing lines 1-${DEFAULT_MAX_LINES} of ${DEFAULT_MAX_LINES + 5}.`);
		expect(result.details?.truncation?.truncated).toBe(true);
		expect(result.details?.textFile?.numLines).toBe(DEFAULT_MAX_LINES);
	});

	it("returns the whole file when both limits are disabled", async () => {
		const lines = Array.from({ length: DEFAULT_MAX_LINES * 2 }, (_, index) => `line-${index + 1}-${"x".repeat(40)}`);
		const text = lines.join("\n");
		expect(Buffer.byteLength(text)).toBeGreaterThan(DEFAULT_MAX_BYTES);
		writeFileSync(join(cwd, "long.txt"), text);

		const result = await createReadTool(cwd, {
			truncation: { maxLines: Number.POSITIVE_INFINITY, maxBytes: Number.POSITIVE_INFINITY },
		}).execute("read", { path: "long.txt" });

		expect(textOf(result)).toBe(text);
		expect(result.details?.truncation).toBeUndefined();
		expect(result.details?.textFile).toMatchObject({
			content: text,
			numLines: lines.length,
			totalLines: lines.length,
			truncatedByOutputLimit: false,
		});
	});

	it("still honors offset and limit with the limits disabled", async () => {
		const lines = Array.from({ length: DEFAULT_MAX_LINES * 2 }, (_, index) => `line-${index + 1}`);
		writeFileSync(join(cwd, "long.txt"), lines.join("\n"));

		const result = await createReadTool(cwd, {
			truncation: { maxLines: Number.POSITIVE_INFINITY, maxBytes: Number.POSITIVE_INFINITY },
		}).execute("read", { path: "long.txt", offset: 11, limit: 3000 });

		expect(textOf(result)).toBe(
			`${lines.slice(10, 3010).join("\n")}\n\n[${lines.length - 3010} more lines in file. Use offset=3011 to continue.]`,
		);
		expect(result.details?.textFile).toMatchObject({ startLine: 11, numLines: 3000 });
	});

	it("names the configured byte limit when the first line exceeds it", async () => {
		writeFileSync(join(cwd, "wide.txt"), "y".repeat(2048));

		const result = await createReadTool(cwd, { truncation: { maxBytes: 1024 } }).execute("read", {
			path: "wide.txt",
		});

		expect(textOf(result)).toBe("[Line 1 is 2.0KB, exceeds 1.0KB limit. Use bash: sed -n '1p' wide.txt | head -c 1024]");
	});
});
