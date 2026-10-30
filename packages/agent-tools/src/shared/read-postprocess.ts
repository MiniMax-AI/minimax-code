/**
 * read-postprocess.ts — model-facing formatting for `read` text output,
 * applied by the desktop / cloud wrappers on top of the pi read engine.
 *
 * Why (design: `.harness/docs/design/tools-optimize/read-tool-optimization.md`
 * §2.3):
 *
 * - Line numbers (①): the pi engine returns raw file text; line numbers only
 *   exist in the TUI renderer, so the model never sees them. Without model-
 *   visible line numbers the model has to count lines itself — `file:line`
 *   references drift and edit targeting degrades. The format is copied from
 *   reference CLI `addLineNumbers` (src/utils/file.ts): right-aligned 6-wide
 *   `NNNNNN→line`, switching to unpadded `N→line` at 7+ digits. Benefit:
 *   stable `file:line` grounding, same convention frontier models are
 *   already trained on.
 *
 * - Long-line truncation (⑤): a single minified/JSON line can eat the whole
 *   50KB byte budget (or trigger pi's empty `firstLineExceedsLimit` reply),
 *   crowding out every other line. Truncating individual lines at 2000
 *   chars (OpenCode/Kimi convention) keeps the rest of the file readable.
 *
 * - Empty file reminder: an empty tool result is a known model-confuser;
 *   reference CLI replaces it with an explicit `<system-reminder>` warning.
 *   We do the same at the wrapper level.
 *
 * Deviation from reference CLI, on purpose: cc normalizes CRLF→LF (and strips
 * the BOM) inside its own file reader, so it can split on /\r?\n/. Our
 * content comes from pi verbatim and must stay byte-identical to the file —
 * the model copies these lines into `edit.oldText`. We therefore split on
 * '\n' only; a trailing '\r' stays inside the numbered line content.
 */

import { READ_MAX_LINE_CHARS } from './read-contract.js';

// Re-export the contract for existing read post-processing consumers.
export { READ_MAX_LINE_CHARS } from './read-contract.js';

export const READ_LINE_TRUNCATED_SUFFIX = '... (line truncated)';

/** Copied from reference CLI FileReadTool mapToolResultToToolResultBlockParam. */
export const READ_EMPTY_FILE_REMINDER =
  '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>';

/**
 * Prefix `content` lines with 1-indexed line numbers, cat -n style.
 *
 * `startLine` is the absolute (1-indexed) file line number of the first
 * line. Values <= 0 are normalized to 1: the previous tool definitions
 * documented `offset` as 0-based (the ⑥ bug), so in-flight models may keep
 * sending `offset=0`. The pi engine treats 0 like 1 (`offset ? offset - 1
 * : 0`, same as reference CLI's `offset === 0 ? 0 : offset - 1`); numbering
 * from 0 here would put an off-by-one straight into the model context.
 *
 * A trailing newline does NOT get a number (CR !4027 round-2 P1): `"a\n"`
 * is a one-line file — numbering the empty split tail would invent a
 * phantom line after EOF on virtually every source file, skewing
 * line-based references. The trailing `\n` byte itself is preserved
 * (output stays copy-safe); real empty lines in the middle or produced by
 * multiple newlines are still numbered, matching `cat -n`.
 */
export function addLineNumbers(content: string, startLine = 1): string {
  if (!content) return content;
  const base = startLine > 0 ? startLine : 1;
  const endsWithNewline = content.endsWith('\n');
  const body = endsWithNewline ? content.slice(0, -1) : content;
  const numbered = body
    .split('\n')
    .map((line, index) => {
      const numStr = String(base + index);
      if (numStr.length >= 6) {
        return `${numStr}→${line}`;
      }
      return `${numStr.padStart(6, ' ')}→${line}`;
    })
    .join('\n');
  return endsWithNewline ? `${numbered}\n` : numbered;
}

/**
 * Inverse of addLineNumbers — strips the `N→` (or legacy `N\t`) prefix from
 * a single line. Co-located so format changes here and in addLineNumbers
 * stay in sync (same pairing as reference CLI's stripLineNumberPrefix).
 */
export function stripLineNumberPrefix(line: string): string {
  const match = line.match(/^\s*\d+[→\t](.*)$/);
  return match?.[1] ?? line;
}

/**
 * Normalize a text block that was copied verbatim from line-numbered read
 * output: if EVERY non-empty line carries a `N→` / `N\t` prefix, strip them
 * all and return the clean block; otherwise return null (the block is not
 * read-shaped — leave it untouched).
 *
 * Consumed by the edit wrappers as a FAILURE-ONLY retry (Codex Review
 * !4027 P1): when the model copies `     2→foo` from read output into
 * `edit.oldText`, pi's exact match fails; the wrapper then retries once
 * with the prefixes stripped. Never applied to a first attempt, so genuine
 * file content that happens to look line-numbered still matches exactly.
 */
export function stripLineNumberPrefixesFromBlock(text: string): string | null {
  if (!text) return null;
  const lines = text.split('\n');
  let sawPrefix = false;
  const stripped: string[] = [];
  for (const line of lines) {
    if (line === '') {
      // A block copied with a trailing newline ends in an unprefixed ''.
      stripped.push(line);
      continue;
    }
    const match = line.match(/^\s*\d+[→\t](.*)$/);
    if (!match) return null;
    sawPrefix = true;
    stripped.push(match[1] ?? '');
  }
  return sawPrefix ? stripped.join('\n') : null;
}

export interface LongLineTruncationResult {
  text: string;
  /** Absolute (1-indexed) line numbers that were truncated. */
  truncatedLines: number[];
}

/**
 * Truncate individual lines longer than `maxChars` characters (code points,
 * not bytes — a cut must not split a surrogate pair) and record which
 * absolute line numbers were affected (Kimi-style reporting, so the model
 * knows the file content is longer than what it sees).
 */
export function truncateLongLines(
  content: string,
  maxChars: number = READ_MAX_LINE_CHARS,
  startLine = 1,
): LongLineTruncationResult {
  if (!content) return { text: content, truncatedLines: [] };
  const base = startLine > 0 ? startLine : 1;
  const truncatedLines: number[] = [];
  const lines = content.split('\n').map((line, index) => {
    if (line.length <= maxChars) return line;
    // Cheap length pre-check above uses UTF-16 units; only pay the code
    // point split for suspicious lines.
    const points = Array.from(line);
    if (points.length <= maxChars) return line;
    truncatedLines.push(base + index);
    return points.slice(0, maxChars).join('') + READ_LINE_TRUNCATED_SUFFIX;
  });
  return { text: lines.join('\n'), truncatedLines };
}

/**
 * Matches the three continuation notices pi's read engine appends
 * (third_party/pi-mono .../core/tools/read.ts:312/314/321):
 *   `\n\n[Showing lines X-Y of N. Use offset=Z to continue.]`
 *   `\n\n[Showing lines X-Y of N (50.0 KB limit). Use offset=Z to continue.]`
 *   `\n\n[N more lines in file. Use offset=Z to continue.]`
 * Locked by unit tests that run the real pi tool — if an upstream sync
 * changes the wording, the tests break loudly instead of the notice being
 * silently line-numbered. If no notice matches, the whole text is numbered
 * (safe degradation).
 */
const PI_READ_TAIL_NOTICE =
  /\n\n\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines in file\.)[^\n]*\]$/;

export interface PostprocessPiReadTextResult {
  text: string;
  /** Absolute (1-indexed) line numbers truncated by the long-line guard. */
  truncatedLines: number[];
}

/**
 * Full text pipeline: split off pi's trailing continuation notice, truncate
 * over-long lines, add line numbers (truncation first — the 2000-char cap
 * applies to file content, not to the number prefix), then re-attach the
 * notice verbatim (never numbered).
 *
 * Empty body (empty file) returns the reference CLI system-reminder instead
 * of an empty string.
 */
export function postprocessPiReadText(
  outputText: string,
  /** maxLineChars: per-line cap, READ_MAX_LINE_CHARS unless a caller (a PTC child) lifts it. */
  opts: { offset?: number; maxLineChars?: number } = {},
): PostprocessPiReadTextResult {
  if (outputText === '') {
    return { text: READ_EMPTY_FILE_REMINDER, truncatedLines: [] };
  }

  const noticeMatch = outputText.match(PI_READ_TAIL_NOTICE);
  const notice = noticeMatch ? noticeMatch[0] : '';
  const body = notice ? outputText.slice(0, -notice.length) : outputText;

  const startLine = opts.offset !== undefined && opts.offset > 0 ? opts.offset : 1;
  const { text: truncatedBody, truncatedLines } = truncateLongLines(
    body,
    opts.maxLineChars ?? READ_MAX_LINE_CHARS,
    startLine,
  );
  return {
    text: addLineNumbers(truncatedBody, startLine) + notice,
    truncatedLines,
  };
}
