import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateHead, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
	strategy?: "tail" | "head_tail";
	/** Disable when the host already owns the complete output log. */
	persistOutput?: boolean;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	rawBytes: number;
}

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly strategy: "tail" | "head_tail";
	private readonly persistOutput: boolean;
	private readonly decoders = new Map<string, TextDecoder>();

	private decodedChunks: Buffer[] = [];
	private tailText = "";
	private headText = "";
	private headBytes = 0;
	private headClosed = false;
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;
	private tempFileError: Error | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
		this.strategy = options.strategy ?? "tail";
		this.persistOutput = options.persistOutput !== false;
	}

	append(data: Buffer, stream: "stdout" | "stderr" | "combined" = "combined"): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		let decoder = this.decoders.get(stream);
		if (!decoder) {
			decoder = new TextDecoder();
			this.decoders.set(stream, decoder);
		}
		this.appendDecodedChunk(decoder.decode(data, { stream: true }));
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		for (const decoder of this.decoders.values()) {
			this.appendDecodedChunk(decoder.decode());
		}
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		let tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		if (this.strategy === "head_tail" && truncated) {
			const marker = "\n\n[... output omitted ...]\n\n";
			const budget = Math.max(0, this.maxBytes - byteLength(marker));
			const headBudget = Math.floor(budget * 0.45);
			const head = truncateHead(this.headText, { maxBytes: headBudget, maxLines: this.maxLines }).content
				|| utf8Prefix(this.headText, headBudget);
			const tail = truncateTail(this.tailText, { maxBytes: budget - headBudget, maxLines: this.maxLines }).content;
			const content = utf8Prefix(head + marker + tail, this.maxBytes);
			tailTruncation = { ...tailTruncation, content, outputBytes: byteLength(content), outputLines: content.split("\n").length };
		}
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFileError ? undefined : this.tempFilePath,
			rawBytes: this.totalRawBytes,
		};
	}

	async closeTempFile(): Promise<void> {
		if (this.tempFileError) throw this.tempFileError;
		if (!this.tempFileStream) {
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		if (this.strategy === "head_tail" && !this.headClosed) {
			this.headClosed = this.headBytes + bytes >= this.maxBytes;
			this.headText += utf8Prefix(text, this.maxBytes - this.headBytes);
			this.headBytes = byteLength(this.headText);
		}
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private appendDecodedChunk(text: string): void {
		this.appendDecodedText(text);
		if (!this.persistOutput || this.tempFileError) return;
		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			if (text.length > 0) this.tempFileStream?.write(text, "utf-8");
		} else if (text.length > 0) {
			this.decodedChunks.push(Buffer.from(text, "utf-8"));
		}
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (!this.persistOutput || this.tempFilePath) {
			return;
		}
		this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
		this.tempFileStream = createWriteStream(this.tempFilePath);
		this.tempFileStream.on("error", (error) => {
			this.tempFileError = error;
		});
		for (const chunk of this.decodedChunks) {
			this.tempFileStream.write(chunk);
		}
		this.decodedChunks = [];
	}
}

function utf8Prefix(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	let end = Math.min(buffer.length, Math.max(0, maxBytes));
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}
