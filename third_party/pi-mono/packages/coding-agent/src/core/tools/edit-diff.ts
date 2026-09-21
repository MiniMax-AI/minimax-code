/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize a single line for fuzzy matching (no newlines expected).
 * Applies NFKC, strips trailing whitespace, and folds smart quotes,
 * Unicode dashes and special spaces to their ASCII equivalents.
 */
function normalizeLineForFuzzyMatch(line: string): string {
	return (
		line
			.normalize("NFKC")
			// Strip trailing whitespace
			.trimEnd()
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 *
 * Normalization is line-local (NFKC never composes across a newline and the
 * character folds are per-character), which lets fuzzy matches found in
 * normalized space be mapped back to spans of the original content.
 */
export function normalizeForFuzzyMatch(text: string): string {
	return text.split("\n").map(normalizeLineForFuzzyMatch).join("\n");
}

/**
 * Map a column of the NFKC-normalized form of `origLine` back to a column of
 * the original line. Uses the fact that NFKC prefix length is monotonically
 * non-decreasing in the original prefix length.
 *
 * When the column falls inside the expansion of a single original character
 * (no exact original boundary exists), the span is widened so a replacement
 * never splits an original character: `start` rounds down, `end` rounds up.
 */
function mapNfkcColumnToOriginal(origLine: string, column: number, kind: "start" | "end"): number {
	if (column === 0) return 0;
	// Fast path: the line is already NFKC-normalized, so columns map 1:1.
	if (origLine.normalize("NFKC") === origLine) return column;
	const nfkcLength = (chars: number): number => origLine.slice(0, chars).normalize("NFKC").length;
	// Binary search for the largest original prefix whose normalized length is <= column.
	let low = 0;
	let high = origLine.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (nfkcLength(mid) <= column) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	if (nfkcLength(low) === column) return low;
	return kind === "start" ? low : low + 1;
}

/**
 * Map a position in `normalizeForFuzzyMatch(originalContent)` back to a
 * position in `originalContent`.
 *
 * Line structure is preserved by normalization, so the position resolves to a
 * (line, column) pair in normalized space and the column is mapped through
 * the per-line NFKC transform. Trailing whitespace stays outside the span: a
 * span starting at a normalized newline starts at the original newline, and a
 * span ending at a trimmed line end excludes the original trailing whitespace.
 */
function mapNormalizedPositionToOriginal(originalContent: string, position: number, kind: "start" | "end"): number {
	const origLines = originalContent.split("\n");
	let origOffset = 0;
	let normOffset = 0;
	for (let i = 0; i < origLines.length; i++) {
		const origLine = origLines[i];
		const normLineLength = normalizeLineForFuzzyMatch(origLine).length;
		const normLineEnd = normOffset + normLineLength;
		const isLastLine = i === origLines.length - 1;
		if (position < normLineEnd || (position === normLineEnd && (isLastLine || kind === "end"))) {
			return origOffset + mapNfkcColumnToOriginal(origLine, position - normOffset, kind);
		}
		if (position === normLineEnd) {
			// A start boundary sitting on the newline separator: the match begins
			// with "\n", so anchor at the original newline (after any trailing
			// whitespace, which stays outside the span).
			return origOffset + origLine.length;
		}
		origOffset += origLine.length + 1;
		normOffset = normLineEnd + 1;
	}
	return originalContent.length;
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts, in the original content */
	index: number;
	/** Length of the matched text, in the original content */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
}

export interface Edit {
	oldText: string;
	newText: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * Both exact and fuzzy results are expressed as spans of the original
 * content; fuzzy normalization is only used to locate the match.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
	}

	// Try fuzzy match - locate in normalized space, then map back
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyOldText.length === 0 ? -1 : fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
	}

	// Map the normalized-space hit back to a span of the original content so
	// the replacement only ever touches the matched region.
	const start = mapNormalizedPositionToOriginal(content, fuzzyIndex, "start");
	const end = mapNormalizedPositionToOriginal(content, fuzzyIndex + fuzzyOldText.length, "end");

	// Fidelity guard: the back-map widens outward (start rounds down, end
	// rounds up) so it never splits an original code point. That widening can
	// otherwise SWALLOW a whole compatibility character the model only named
	// part of — e.g. oldText "ix" against a line "ﬁx" (NFKC ﬁ→fi) would map
	// onto "ﬁx" and silently destroy the ligature. Re-normalizing the mapped
	// original span must reproduce exactly the text we located; if widening
	// pulled in extra characters it won't, so we fail closed (not-found) and
	// let the model retry with an unambiguous oldText rather than clobber
	// bytes it never asked to touch.
	if (normalizeForFuzzyMatch(content.slice(start, end)) !== fuzzyOldText) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
	}

	return { found: true, index: start, matchLength: Math.max(0, end - start), usedFuzzyMatch: true };
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	if (fuzzyOldText.length === 0) return 0;
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

/** 1-based line numbers of the first few matches (line structure is shared between spaces). */
function findOccurrenceLineNumbers(content: string, oldText: string, limit = 3): number[] {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	if (fuzzyOldText.length === 0) return [];
	const lineNumbers: number[] = [];
	let lineNumber = 1;
	let scanned = 0;
	let index = fuzzyContent.indexOf(fuzzyOldText);
	while (index !== -1 && lineNumbers.length < limit) {
		for (let i = scanned; i < index; i++) {
			if (fuzzyContent.charCodeAt(i) === 10) lineNumber++;
		}
		scanned = index;
		lineNumbers.push(lineNumber);
		index = fuzzyContent.indexOf(fuzzyOldText, index + fuzzyOldText.length);
	}
	return lineNumbers;
}

const RELOAD_HINT =
	"If oldText was written from memory or an earlier read, the file may have changed since - use the read tool to reload it before retrying.";

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines. ${RELOAD_HINT}`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines. ${RELOAD_HINT}`,
	);
}

function formatMatchLines(lineNumbers: number[], occurrences: number): string {
	if (lineNumbers.length === 0) return "";
	const suffix = occurrences > lineNumbers.length ? ", ..." : "";
	return ` Matches start at lines ${lineNumbers.join(", ")}${suffix}.`;
}

function getDuplicateError(
	path: string,
	editIndex: number,
	totalEdits: number,
	occurrences: number,
	lineNumbers: number[],
): Error {
	const matchLines = formatMatchLines(lineNumbers, occurrences);
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}.${matchLines} The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}.${matchLines} Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getDisproportionateError(path: string, editIndex: number, totalEdits: number): Error {
	const target = totalEdits === 1 ? "the text" : `edits[${editIndex}]`;
	return new Error(
		`Refusing to replace ${target} in ${path}: the fuzzy match spans far more text than oldText. Provide a more exact oldText (copy it from the file, including whitespace).`,
	);
}

/**
 * Guard against a fuzzy match ballooning far beyond the text the model asked
 * to replace. Thresholds follow opencode's isDisproportionateMatch.
 */
export function isDisproportionateMatch(matchedText: string, oldText: string): boolean {
	const oldLines = oldText.split("\n").length;
	const matchedLines = matchedText.split("\n").length;
	if (matchedLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
	if (oldLines > 1) {
		const oldLength = oldText.trim().length;
		const matchedLength = matchedText.trim().length;
		if (matchedLength > Math.max(oldLength + 500, oldLength * 4)) return true;
	}
	return false;
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content and applied in
 * reverse order so offsets remain stable. Fuzzy matching is only used to
 * locate a span of the original content; bytes outside the matched spans
 * are never rewritten.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(normalizedContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = countOccurrences(normalizedContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(
				path,
				i,
				normalizedEdits.length,
				occurrences,
				findOccurrenceLineNumbers(normalizedContent, edit.oldText),
			);
		}

		if (matchResult.usedFuzzyMatch) {
			const matchedText = normalizedContent.substring(
				matchResult.index,
				matchResult.index + matchResult.matchLength,
			);
			if (isDisproportionateMatch(matchedText, edit.oldText)) {
				throw getDisproportionateError(path, i, normalizedEdits.length);
			}
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = normalizedContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (normalizedContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent: normalizedContent, newContent };
}

/**
 * Bounds for the post-edit diff. The diff is a receipt computed after the file
 * has already been written (and, for the TUI preview, a courtesy rendering), so
 * giving it up never changes what lands on disk.
 *
 * Myers runs in O((N+M)·D) where D is the edit-script length. A whole-file
 * replacement that touches tens of thousands of lines therefore takes minutes
 * and hundreds of MB unbounded, and produces a multi-MB diff nothing can
 * render. `maxEditLength` caps D deterministically (the same input always
 * aborts at the same point, so the behavior is unit-testable); `timeout` is a
 * wall-clock safety net for slow machines and pathological inputs.
 */
export const DIFF_MAX_EDIT_LENGTH = 1000;
export const DIFF_TIMEOUT_MS = 5_000;

/** Why no diff was produced: the edit script exceeded DIFF_MAX_EDIT_LENGTH, or DIFF_TIMEOUT_MS elapsed first. */
export type DiffOmittedReason = "too_many_changes" | "timeout";

const DIFF_BOUNDS = { maxEditLength: DIFF_MAX_EDIT_LENGTH, timeout: DIFF_TIMEOUT_MS } as const;

/**
 * Generate a standard unified patch.
 * Returns `undefined` when the diff exceeds DIFF_MAX_EDIT_LENGTH or DIFF_TIMEOUT_MS.
 */
export function generateUnifiedPatch(
	path: string,
	oldContent: string,
	newContent: string,
	contextLines = 4,
): string | undefined {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
		...DIFF_BOUNDS,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 *
 * When the diff exceeds DIFF_MAX_EDIT_LENGTH or DIFF_TIMEOUT_MS, `diff` is a
 * single notice line (so every renderer still has something to show) and
 * `omitted` names the reason.
 */
export function generateDiffString(oldContent: string, newContent: string, contextLines = 4): EditDiffResult {
	const startedAt = Date.now();
	const parts = Diff.diffLines(oldContent, newContent, DIFF_BOUNDS);
	if (parts === undefined) {
		// jsdiff stops on whichever bound trips first; only the clock tells them apart.
		const omitted: DiffOmittedReason = Date.now() - startedAt >= DIFF_TIMEOUT_MS ? "timeout" : "too_many_changes";
		return {
			diff:
				omitted === "timeout"
					? `(diff omitted: computing it exceeded ${DIFF_TIMEOUT_MS} ms)`
					: `(diff omitted: more than ${DIFF_MAX_EDIT_LENGTH} lines changed)`,
			firstChangedLine: undefined,
			omitted,
		};
	}
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
	/** Set when the diff was not computed; `diff` then holds a one-line notice. */
	omitted?: DiffOmittedReason;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
