import { describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import {
	applyShellEncodingDefaults,
	createShellOutputDecoder,
	decodeShellOutput,
	getWindowsAnsiCodePageEncoding,
	prepareWindowsAnsiCodePageEncoding,
} from "../src/core/tools/shell-encoding.ts";

// "史允奥" encoded in GBK (code page 936), as Python writes it on Chinese Windows.
const GBK_NAME = Buffer.from("cab7d4cab0c2", "hex");
const NAME = "史允奥";

function decodeInChunks(bytes: Buffer, chunkSizes: number[], fallbackEncoding: string | null = "gbk"): string {
	const decoder = createShellOutputDecoder({ fallbackEncoding });
	let output = "";
	let offset = 0;
	let index = 0;
	while (offset < bytes.length) {
		const size = chunkSizes[index++ % chunkSizes.length];
		output += decoder.write(bytes.subarray(offset, offset + size));
		offset += size;
	}
	return output + decoder.end();
}

describe("shell output decoding", () => {
	it("decodes code page output that is not valid UTF-8", () => {
		expect(decodeShellOutput(Buffer.concat([GBK_NAME, Buffer.from("\r\n")]), { fallbackEncoding: "gbk" })).toBe(
			`${NAME}\r\n`,
		);
	});

	it("keeps valid UTF-8 as UTF-8 even when a fallback is configured", () => {
		const text = "你好 ✔ 😀 café\n第二行";
		expect(decodeShellOutput(Buffer.from(text), { fallbackEncoding: "gbk" })).toBe(text);
	});

	it("decides per line so UTF-8 and code page lines can be mixed", () => {
		const bytes = Buffer.concat([
			Buffer.from("utf8 中文\n"),
			Buffer.from("gbk "),
			GBK_NAME,
			Buffer.from("\n"),
			Buffer.from("尾行✔"),
		]);
		expect(decodeShellOutput(bytes, { fallbackEncoding: "gbk" })).toBe(`utf8 中文\ngbk ${NAME}\n尾行✔`);
	});

	it("never splits a character when chunks cut multi-byte sequences", () => {
		const bytes = Buffer.concat([
			Buffer.from("开始 start\n"),
			GBK_NAME,
			Buffer.from(" ok\r\n"),
			GBK_NAME,
			GBK_NAME,
			Buffer.from("\nUTF-8 ✔ 结束"),
		]);
		const expected = `开始 start\n${NAME} ok\r\n${NAME}${NAME}\nUTF-8 ✔ 结束`;
		for (const sizes of [[1], [2], [3], [5], [1, 2], [2, 3, 1], [7]]) {
			expect(decodeInChunks(bytes, sizes)).toBe(expected);
		}
	});

	it("streams ASCII and, after a UTF-8 line, CJK UTF-8 without waiting for a line break", () => {
		const decoder = createShellOutputDecoder({ fallbackEncoding: "gbk" });
		expect(decoder.write(Buffer.from("progress 10%"))).toBe("progress 10%");
		expect(decoder.write(Buffer.from(" 中文"))).toBe(" ");
		expect(decoder.pendingBytes).toBe(6);
		expect(decoder.write(Buffer.from("\n"))).toBe("中文\n");
		expect(decoder.write(Buffer.from("中文"))).toBe("中文");
		expect(decoder.write(Buffer.from([0xe4, 0xb8]))).toBe("");
		expect(decoder.write(Buffer.from([0xad]))).toBe("中");
		expect(decoder.write(Buffer.from("😀"))).toBe("😀");
		expect(decoder.end()).toBe("");
	});

	it("holds a code page line whose prefix is a valid three-byte UTF-8 character", () => {
		// GBK "涓啊" is E4 B8 B0 A1; its first three bytes are UTF-8 "丰".
		const gbk = Buffer.from("e4b8b0a1", "hex");
		const expected = new TextDecoder("gbk").decode(gbk);
		const decoder = createShellOutputDecoder({ fallbackEncoding: "gbk" });
		expect(decoder.write(Buffer.from("ascii line\n"))).toBe("ascii line\n");
		expect(decoder.write(gbk.subarray(0, 3))).toBe("");
		expect(decoder.write(Buffer.concat([gbk.subarray(3), Buffer.from("\n")]))).toBe(`${expected}\n`);
	});

	it("holds ambiguous two-byte UTF-8 until the line ends", () => {
		const decoder = createShellOutputDecoder({ fallbackEncoding: "gbk" });
		expect(decoder.write(Buffer.from("café"))).toBe("caf");
		expect(decoder.write(Buffer.from("\n"))).toBe("é\n");
	});

	it("stops early UTF-8 output once the stream has shown code page output", () => {
		const decoder = createShellOutputDecoder({ fallbackEncoding: "gbk" });
		expect(decoder.write(Buffer.concat([GBK_NAME, Buffer.from("\n")]))).toBe(`${NAME}\n`);
		expect(decoder.write(Buffer.from("中文"))).toBe("");
		expect(decoder.write(Buffer.from("\n"))).toBe("中文\n");
	});

	it("decodes a code page line that is also valid two-byte UTF-8 after code page output", () => {
		// GBK "史" is CA B7, which is also UTF-8 "ʷ".
		const bytes = Buffer.concat([
			GBK_NAME,
			Buffer.from("\n"),
			Buffer.from("cab70a", "hex"),
			Buffer.from("x "),
			Buffer.from("cab7", "hex"),
			Buffer.from(" y\r\n"),
		]);
		const expected = `${NAME}\n史\nx 史 y\r\n`;
		for (const sizes of [[1], [2], [3], [64]]) expect(decodeInChunks(bytes, sizes)).toBe(expected);
	});

	it("decodes an ambiguous line before the first code page line of the same chunk", () => {
		// print("史"); print("中文") under block buffering arrives as one chunk.
		const bytes = Buffer.from("cab70ad6d0cec40a", "hex");
		expect(decodeShellOutput(bytes, { fallbackEncoding: "gbk" })).toBe("史\n中文\n");
		expect(decodeInChunks(bytes, [8])).toBe("史\n中文\n");
	});

	it("keeps CJK UTF-8 lines that are also valid GBK after code page output", () => {
		// UTF-8 "中文" (E4 B8 AD E6 96 87) is also valid GBK ("涓枃").
		const bytes = Buffer.concat([GBK_NAME, Buffer.from("\n中文\n完成 ✔\n")]);
		for (const sizes of [[1], [5], [64]]) expect(decodeInChunks(bytes, sizes)).toBe(`${NAME}\n中文\n完成 ✔\n`);
	});

	it("keeps two-byte UTF-8 lines while the stream has shown no code page output", () => {
		expect(decodeShellOutput(Buffer.from("ascii\ncafé ʷ\n"), { fallbackEncoding: "gbk" })).toBe("ascii\ncafé ʷ\n");
	});

	it("holds a code page line whose prefix looks like UTF-8 until it is complete", () => {
		const decoder = createShellOutputDecoder({ fallbackEncoding: "gbk" });
		expect(decoder.write(Buffer.concat([Buffer.from("name: "), GBK_NAME.subarray(0, 3)]))).toBe("name: ");
		expect(decoder.write(GBK_NAME.subarray(3))).toBe("");
		expect(decoder.write(Buffer.from("\n"))).toBe(`${NAME}\n`);
	});

	it("bounds a long code page line without a line break", () => {
		const bytes = Buffer.concat(Array.from({ length: 3000 }, () => GBK_NAME));
		const output = decodeInChunks(bytes, [4093, 1, 4099]);
		expect(output).toBe(NAME.repeat(3000));
	});

	it("cuts Shift_JIS between characters when half-width katakana precede the limit", () => {
		// Half-width katakana are single bytes; "日" is a two-byte character.
		const unit = Buffer.concat([Buffer.from([0xb1]), Buffer.from("93fa", "hex")]);
		const text = new TextDecoder("shift_jis").decode(unit);
		const bytes = Buffer.concat(Array.from({ length: 4000 }, () => unit));
		expect(decodeInChunks(bytes, [9001, 4096], "shift_jis")).toBe(text.repeat(4000));
	});

	it("falls back to lossy UTF-8 when the fallback is disabled", () => {
		expect(decodeShellOutput(GBK_NAME, { fallbackEncoding: null })).toBe("ʷ\ufffdʰ\ufffd");
	});

	it("strips a leading byte order mark like the default UTF-8 decoder", () => {
		expect(decodeShellOutput(Buffer.from("\ufeffhello"), { fallbackEncoding: "gbk" })).toBe("hello");
		expect(decodeShellOutput(Buffer.from("\ufeffhello"), { fallbackEncoding: null })).toBe("hello");
	});

	it("uses no fallback outside Windows", () => {
		if (process.platform === "win32") return;
		expect(getWindowsAnsiCodePageEncoding()).toBeUndefined();
		expect(decodeShellOutput(GBK_NAME)).toBe("ʷ\ufffdʰ\ufffd");
	});
});

describe("output accumulator with a code page fallback", () => {
	it("stops on the total limit even while an unfinished line is held", () => {
		const accumulator = new OutputAccumulator({
			maxBytes: 8,
			maxTotalBytes: 16,
			persistOutput: false,
			fallbackEncoding: "gbk",
		});
		accumulator.append(Buffer.concat(Array.from({ length: 10 }, () => GBK_NAME)), "stdout");
		expect(accumulator.limitExceeded).toEqual({ kind: "output", limitBytes: 16 });
		accumulator.finish();
	});

	it("decodes split stdout and stderr code page output", () => {
		const accumulator = new OutputAccumulator({ maxBytes: 1024, persistOutput: false, fallbackEncoding: "gbk" });
		const stdout = Buffer.concat([GBK_NAME, Buffer.from("\n")]);
		accumulator.append(stdout.subarray(0, 1), "stdout");
		accumulator.append(Buffer.from("err ✔\n"), "stderr");
		accumulator.append(stdout.subarray(1), "stdout");
		accumulator.finish();
		expect(accumulator.snapshot().content).toBe(`err ✔\n${NAME}\n`);
	});

	it("keeps lossy UTF-8 when the fallback is disabled", () => {
		const accumulator = new OutputAccumulator({ maxBytes: 1024, persistOutput: false, fallbackEncoding: null });
		accumulator.append(GBK_NAME, "stdout");
		accumulator.finish();
		expect(accumulator.snapshot().content).toBe("ʷ\ufffdʰ\ufffd");
	});
});

describe("Windows ANSI code page lookup", () => {
	it("resolves asynchronously to the same encoding as the synchronous lookup", async () => {
		const [first, second] = await Promise.all([
			prepareWindowsAnsiCodePageEncoding(),
			prepareWindowsAnsiCodePageEncoding(),
		]);
		expect(second).toBe(first);
		expect(getWindowsAnsiCodePageEncoding()).toBe(first);
		if (process.platform !== "win32") expect(first).toBeUndefined();
	});
});

describe("shell encoding environment defaults", () => {
	it("sets PYTHONIOENCODING on Windows only", () => {
		const windowsEnv: NodeJS.ProcessEnv = { PATH: "x" };
		applyShellEncodingDefaults(windowsEnv, "win32");
		expect(windowsEnv.PYTHONIOENCODING).toBe("utf-8:surrogateescape");
		expect(windowsEnv.PYTHONUTF8).toBeUndefined();

		for (const platform of ["darwin", "linux"] as const) {
			const env: NodeJS.ProcessEnv = { PATH: "x" };
			applyShellEncodingDefaults(env, platform);
			expect(env).toEqual({ PATH: "x" });
		}
	});

	it("keeps a value the user already set in any letter case", () => {
		const env: NodeJS.ProcessEnv = { PythonIOEncoding: "cp936" };
		applyShellEncodingDefaults(env, "win32");
		expect(env).toEqual({ PythonIOEncoding: "cp936" });
	});
});
