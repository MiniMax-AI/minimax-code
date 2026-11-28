import { isUtf8 } from "node:buffer";
import { execFile, spawnSync } from "node:child_process";
import { join } from "node:path";
import { TextDecoder } from "node:util";

/**
 * Shell output encoding helpers.
 *
 * Native Windows programs commonly write piped output in the system ANSI code
 * page (for example GBK on Chinese Windows) instead of UTF-8. Decoding those
 * bytes as UTF-8 turns every non-ASCII character into U+FFFD. These helpers keep
 * UTF-8 as the primary encoding and fall back to the ANSI code page only for
 * output that is not valid UTF-8.
 */

/** A held line longer than this is flushed even without a line break. */
const MAX_HELD_BYTES = 8 * 1024;

const WINDOWS_CODE_PAGE_ENCODINGS: Readonly<Record<number, string>> = {
	874: "windows-874",
	932: "shift_jis",
	936: "gbk",
	949: "euc-kr",
	950: "big5",
	1250: "windows-1250",
	1251: "windows-1251",
	1252: "windows-1252",
	1253: "windows-1253",
	1254: "windows-1254",
	1255: "windows-1255",
	1256: "windows-1256",
	1257: "windows-1257",
	1258: "windows-1258",
};

/**
 * Lead bytes of double-byte code pages. Other bytes above 0x7f are single-byte
 * characters, such as Shift_JIS half-width katakana (0xa1-0xdf) or GBK 0x80.
 */
const DOUBLE_BYTE_LEAD_BYTES: Readonly<Partial<Record<string, (byte: number) => boolean>>> = {
	shift_jis: (byte) => (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc),
	gbk: (byte) => byte >= 0x81 && byte <= 0xfe,
	"euc-kr": (byte) => byte >= 0x81 && byte <= 0xfe,
	big5: (byte) => byte >= 0x81 && byte <= 0xfe,
};

export interface ShellOutputDecoder {
	/** Decode the next chunk; may hold back an incomplete line. */
	write(data: Uint8Array): string;
	/** Flush every held byte. */
	end(): string;
	/** Bytes written but not yet returned, for example an unfinished code page line. */
	readonly pendingBytes: number;
}

export interface ShellOutputDecoderOptions {
	/**
	 * Encoding used for output that is not valid UTF-8. `undefined` uses the
	 * Windows ANSI code page (no fallback on other platforms); `null` disables the
	 * fallback and decodes invalid bytes as U+FFFD.
	 */
	fallbackEncoding?: string | null;
}

/** Detected code page encoding; null when it is not mapped; undefined until a lookup completes. */
let cachedWindowsAnsiEncoding: string | null | undefined;
let pendingWindowsAnsiEncoding: Promise<string | undefined> | undefined;

const REG_QUERY_ARGS = ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "ACP"];
const REG_QUERY_OPTIONS = { encoding: "latin1", timeout: 3000, windowsHide: true } as const;

function regExePath(): string {
	return join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "reg.exe");
}

function encodingFromRegQuery(stdout: string): string | null {
	const codePage = /\bACP\s+REG_SZ\s+(\d+)/i.exec(stdout)?.[1];
	return (codePage && WINDOWS_CODE_PAGE_ENCODINGS[Number(codePage)]) || null;
}

/**
 * WHATWG encoding label of the Windows ANSI code page, or undefined when it is
 * UTF-8, unmapped or unknown. Queries the registry synchronously when
 * {@link prepareWindowsAnsiCodePageEncoding} has not completed yet. A lookup
 * that could not run (spawn failure, timeout) is not cached and is retried.
 */
export function getWindowsAnsiCodePageEncoding(): string | undefined {
	if (process.platform !== "win32") return undefined;
	if (cachedWindowsAnsiEncoding === undefined) {
		try {
			const result = spawnSync(regExePath(), REG_QUERY_ARGS, REG_QUERY_OPTIONS);
			if (result.error) return undefined;
			cachedWindowsAnsiEncoding = encodingFromRegQuery(String(result.stdout ?? ""));
		} catch {
			return undefined;
		}
	}
	return cachedWindowsAnsiEncoding ?? undefined;
}

/**
 * Resolve the Windows ANSI code page without blocking the event loop. Local
 * shell execution awaits this before spawning, so decoders created for that
 * command read the cached value instead of querying the registry from a data
 * callback. A failed lookup is not cached; the next call retries.
 */
export function prepareWindowsAnsiCodePageEncoding(): Promise<string | undefined> {
	if (process.platform !== "win32") return Promise.resolve(undefined);
	if (cachedWindowsAnsiEncoding !== undefined) return Promise.resolve(cachedWindowsAnsiEncoding ?? undefined);
	pendingWindowsAnsiEncoding ??= new Promise((resolve) => {
		const finish = (error: { code?: unknown } | null, stdout: unknown) => {
			pendingWindowsAnsiEncoding = undefined;
			// reg.exe ran to completion (exit code is a number); spawn errors and timeouts are retried.
			if (!error || typeof error.code === "number") {
				cachedWindowsAnsiEncoding ??= encodingFromRegQuery(String(stdout ?? ""));
			}
			resolve(cachedWindowsAnsiEncoding ?? undefined);
		};
		try {
			execFile(regExePath(), REG_QUERY_ARGS, REG_QUERY_OPTIONS, (error, stdout) => finish(error, stdout));
		} catch (error) {
			finish(error as { code?: unknown }, "");
		}
	});
	return pendingWindowsAnsiEncoding;
}

/**
 * Create a streaming decoder for one shell output stream.
 *
 * Valid UTF-8 is always decoded as UTF-8. With a fallback encoding, output is
 * decided per line: a line that is not valid UTF-8 is decoded with the fallback
 * encoding. An unfinished line is emitted early when it is ASCII, or when it is
 * complete UTF-8 with a three- or four-byte sequence (CJK text, emoji) and the
 * stream has already ended such a UTF-8 line without showing non-UTF-8 output.
 * Other bytes are held until a line break, the end of the stream, or the hold
 * limit, because a partial code page line can look like valid UTF-8 (GBK "史"
 * is UTF-8 "ʷ", GBK "涓" plus a lead byte is UTF-8 "丰"). Without a fallback
 * this is a plain streaming UTF-8 decoder.
 */
export function createShellOutputDecoder(options: ShellOutputDecoderOptions = {}): ShellOutputDecoder {
	if (options.fallbackEncoding !== undefined) return createDecoderForEncoding(options.fallbackEncoding);
	if (process.platform !== "win32") return new Utf8ShellOutputDecoder();
	if (cachedWindowsAnsiEncoding !== undefined) return createDecoderForEncoding(cachedWindowsAnsiEncoding);
	// Defer the lookup to the first write, which normally follows the awaited
	// prepareWindowsAnsiCodePageEncoding() of the command that produces it.
	return new DeferredShellOutputDecoder();
}

function createDecoderForEncoding(label: string | null | undefined): ShellOutputDecoder {
	if (!label) return new Utf8ShellOutputDecoder();
	let fallback: TextDecoder;
	try {
		fallback = new TextDecoder(label);
	} catch {
		// Runtime without this encoding (small ICU): keep UTF-8.
		return new Utf8ShellOutputDecoder();
	}
	if (fallback.encoding === "utf-8") return new Utf8ShellOutputDecoder();
	const isLeadByte = DOUBLE_BYTE_LEAD_BYTES[fallback.encoding];
	return new FallbackShellOutputDecoder(
		fallback,
		isLeadByte,
		isLeadByte ? new TextDecoder(fallback.encoding, { fatal: true }) : undefined,
	);
}

/** Decode complete shell output with the same rules as {@link createShellOutputDecoder}. */
export function decodeShellOutput(data: Uint8Array, options?: ShellOutputDecoderOptions): string {
	const decoder = createShellOutputDecoder(options);
	return decoder.write(data) + decoder.end();
}

class DeferredShellOutputDecoder implements ShellOutputDecoder {
	private decoder: ShellOutputDecoder | undefined;

	write(data: Uint8Array): string {
		return this.resolve().write(data);
	}

	end(): string {
		return this.resolve().end();
	}

	get pendingBytes(): number {
		return this.decoder?.pendingBytes ?? 0;
	}

	private resolve(): ShellOutputDecoder {
		this.decoder ??= createDecoderForEncoding(getWindowsAnsiCodePageEncoding());
		return this.decoder;
	}
}

class Utf8ShellOutputDecoder implements ShellOutputDecoder {
	private readonly decoder = new TextDecoder();

	write(data: Uint8Array): string {
		return this.decoder.decode(data, { stream: true });
	}

	end(): string {
		return this.decoder.decode();
	}

	get pendingBytes(): number {
		return 0;
	}
}

class FallbackShellOutputDecoder implements ShellOutputDecoder {
	private held: Buffer = Buffer.alloc(0);
	private atStart = true;
	private sawNonUtf8 = false;
	private sawUtf8Line = false;
	private readonly fallback: TextDecoder;
	private readonly isLeadByte: ((byte: number) => boolean) | undefined;
	private readonly strictFallback: TextDecoder | undefined;

	constructor(
		fallback: TextDecoder,
		isLeadByte: ((byte: number) => boolean) | undefined,
		strictFallback: TextDecoder | undefined,
	) {
		this.fallback = fallback;
		this.isLeadByte = isLeadByte;
		this.strictFallback = strictFallback;
	}

	get pendingBytes(): number {
		return this.held.length;
	}

	write(data: Uint8Array): string {
		const chunk = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
		const input = this.held.length > 0 ? Buffer.concat([this.held, chunk]) : chunk;
		// LF and CR never occur inside a UTF-8 or supported code page character.
		const lastBreak = Math.max(input.lastIndexOf(0x0a), input.lastIndexOf(0x0d));
		let output = lastBreak === -1 ? "" : this.decodeLines(input.subarray(0, lastBreak + 1));
		let rest = input.subarray(lastBreak + 1);
		const early = this.earlyLength(rest);
		if (early > 0) {
			output += this.decodeSegment(rest.subarray(0, early));
			rest = rest.subarray(early);
		}
		if (rest.length > MAX_HELD_BYTES) {
			const cut = this.safeCut(rest);
			output += this.decodeSegment(rest.subarray(0, cut));
			rest = rest.subarray(cut);
		}
		this.held = Buffer.from(rest);
		return output;
	}

	end(): string {
		const output = this.decodeSegment(this.held);
		this.held = Buffer.alloc(0);
		return output;
	}

	/** Bytes of an unfinished line that can be decoded without waiting for its end. */
	private earlyLength(rest: Buffer): number {
		let ascii = 0;
		while (ascii < rest.length && rest[ascii] < 0x80) ascii++;
		if (ascii === rest.length || !this.sawUtf8Line || this.sawNonUtf8) return ascii;
		const complete = completeUtf8Length(rest);
		if (complete <= ascii || !isUtf8(rest.subarray(0, complete))) return ascii;
		// Two-byte UTF-8 stays held: GBK "史" (CA B7) is also UTF-8 "ʷ".
		for (let index = ascii; index < complete; index++) {
			if (rest[index] >= 0xe0) return complete;
		}
		return ascii;
	}

	private decodeLines(lines: Buffer): string {
		if (!this.sawNonUtf8 && isUtf8(lines)) return this.decodeSegment(lines);
		const segments: Buffer[] = [];
		let start = 0;
		for (let index = 0; index < lines.length; index++) {
			const byte = lines[index];
			if (byte !== 0x0a && byte !== 0x0d) continue;
			segments.push(lines.subarray(start, index + 1));
			start = index + 1;
		}
		// A code page line later in the same chunk also decides ambiguous lines before it.
		if (!this.sawNonUtf8 && segments.some((segment) => !isUtf8(segment))) this.sawNonUtf8 = true;
		return segments.map((segment) => this.decodeSegment(segment)).join("");
	}

	private decodeSegment(segment: Buffer): string {
		if (segment.length === 0) return "";
		let text: string;
		if (isUtf8(segment) && !this.prefersCodePage(segment)) {
			text = segment.toString("utf8");
			if (!this.sawUtf8Line && endsWithLineBreak(segment) && segment.some((byte) => byte >= 0xe0)) {
				this.sawUtf8Line = true;
			}
		} else {
			this.sawNonUtf8 = true;
			text = this.fallback.decode(segment);
		}
		if (this.atStart) {
			this.atStart = false;
			if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		}
		return text;
	}

	/**
	 * Once a stream has shown code page output, a line whose non-ASCII bytes
	 * are all two-byte UTF-8 sequences and that is also valid in the double-byte
	 * code page is decoded as code page text: GBK "史" (CA B7) is UTF-8 "ʷ", while
	 * CJK text in UTF-8 always uses three-byte sequences. Lines with a three- or
	 * four-byte sequence stay UTF-8, because UTF-8 CJK text is often valid GBK
	 * too (UTF-8 "中文" is GBK "涓枃").
	 */
	private prefersCodePage(segment: Buffer): boolean {
		if (!this.sawNonUtf8 || !this.strictFallback) return false;
		let multiByte = false;
		for (const byte of segment) {
			if (byte >= 0xe0) return false;
			if (byte >= 0x80) multiByte = true;
		}
		if (!multiByte) return false;
		try {
			this.strictFallback.decode(segment);
			return true;
		} catch {
			return false;
		}
	}

	/** End of the longest prefix that does not split a character. */
	private safeCut(bytes: Buffer): number {
		const utf8End = completeUtf8Length(bytes);
		if (utf8End > 0 && isUtf8(bytes.subarray(0, utf8End))) return utf8End;
		const isLeadByte = this.isLeadByte;
		if (!isLeadByte) return bytes.length;
		let index = 0;
		while (index < bytes.length) index += isLeadByte(bytes[index]) ? 2 : 1;
		return index > bytes.length ? bytes.length - 1 : bytes.length;
	}
}

function endsWithLineBreak(bytes: Buffer): boolean {
	const last = bytes[bytes.length - 1];
	return last === 0x0a || last === 0x0d;
}

/** Length without a trailing incomplete UTF-8 sequence. */
function completeUtf8Length(bytes: Buffer): number {
	for (let back = 1; back <= Math.min(4, bytes.length); back++) {
		const byte = bytes[bytes.length - back];
		if ((byte & 0xc0) === 0x80) continue;
		const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return needed > back ? bytes.length - back : bytes.length;
	}
	return bytes.length;
}

/**
 * Default environment for local shells.
 *
 * On Windows, Python writes piped stdio in the ANSI code page and raises
 * UnicodeEncodeError for characters outside it (for example "✔" under GBK).
 * `PYTHONIOENCODING` changes only stdio. It also applies to stdin, so
 * `surrogateescape` keeps code page input piped from a native program from
 * raising UnicodeDecodeError; echoing it writes the original bytes back, which
 * the output decoder still recognizes. `PYTHONUTF8` is deliberately not set
 * because it also changes the default encoding of `open()` for user files. A
 * value the user already set (any letter case) is kept.
 */
export function applyShellEncodingDefaults(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): void {
	if (platform !== "win32") return;
	const userSet = Object.keys(env).some((key) => key.toUpperCase() === "PYTHONIOENCODING" && env[key] !== undefined);
	if (!userSet) env.PYTHONIOENCODING = "utf-8:surrogateescape";
}
