/**
 * Bash command splitting helpers — extracted from bash-permission.ts to keep
 * the main module under the 2000-line pre-commit block. These helpers run
 * BEFORE permission evaluation: they turn a raw bash string into individual
 * subcommand strings that the per-subcommand evaluator can score
 * independently. No path/permission/IO logic lives here.
 *
 * Reference: permission_design.md §5.1
 */

import { shellTokenizeWithMetadata } from './shell-tokenize.js';
import { isShellCommentStart, readBashExpansion } from './bash-expansion.js';

/**
 * POSIX shell keywords that introduce control flow. When a split subcommand
 * has one of these as its leading token, the remainder of the segment is
 * the actual command to evaluate (e.g. `if ps -p 1` → evaluate `ps -p 1`;
 * `then kill 1` → evaluate `kill 1`).
 *
 * Standalone keywords (`fi`, `done`, `esac`) carry no command — splitCommand
 * drops them so permission evaluation skips them as no-ops.
 */
const LEADING_SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  '!',
  '{',
]);
const STANDALONE_SHELL_KEYWORDS: ReadonlySet<string> = new Set(['fi', 'done', 'esac', '}']);

// `for <var> in <list>` and `case <word> in` are loop / branch HEADERS — the
// body lives in separate segments (`do <cmd>; done` / `<pat>) <cmd>;; esac`).
// The header itself never carries a command, so it must be dropped as a no-op
// instead of falling through to first-word evaluation, where the iteration
// variable (`f`, `i`, ...) would be misclassified as an unknown command.
const SEGMENT_DROP_KEYWORDS: ReadonlySet<string> = new Set(['for', 'case', 'select']);

/**
 * Strip a leading shell control-flow keyword (`if`, `then`, `while`, ...) and
 * trim leading `(` or `{` blocks. Standalone keywords (`fi`, `done`, `esac`)
 * that carry no command on the same line are returned as undefined.
 *
 * Examples:
 *   `if ps -p 15593`     → `ps -p 15593`
 *   `then kill 15593`    → `kill 15593`
 *   `fi`                 → undefined  (no-op subcommand, dropped by splitCommand)
 *   `do echo hi`         → `echo hi`
 *   `ps -p 1`            → `ps -p 1`  (unchanged)
 */
export function stripLeadingShellKeyword(segment: string): string | undefined {
  let cur = segment.trim();
  if (cur.length === 0) return undefined;

  // Trim leading parser tokens: opens `(` / `{` for subshells / brace groups,
  // and orphan closes `)` / `}` left over when a multi-line block was split
  // across the segment boundary (e.g. `awk '{print $1}')\necho ...`). Closes
  // alone never carry a command; the rest of the segment is then evaluated
  // as if the close had been absorbed by a matching open in a prior segment.
  while (cur.length > 0 && (cur[0] === '(' || cur[0] === '{' || cur[0] === ')' || cur[0] === '}')) {
    cur = cur.slice(1).trim();
  }
  if (cur.length === 0) return undefined;

  // Strip one or more leading control-flow keywords (e.g. `if ! ps`, `then ps`).
  while (cur.length > 0) {
    const spaceIdx = cur.search(/\s/);
    const head = spaceIdx === -1 ? cur : cur.slice(0, spaceIdx);
    if (STANDALONE_SHELL_KEYWORDS.has(head)) {
      // Standalone keyword: nothing to evaluate. If anything follows it on
      // the same line (unusual but possible like `fi ; echo done`), bail —
      // splitCommand already handles `;` separators, so this branch is rare.
      const rest = spaceIdx === -1 ? '' : cur.slice(spaceIdx + 1).trim();
      if (rest.length === 0) return undefined;
      cur = rest;
      continue;
    }
    if (SEGMENT_DROP_KEYWORDS.has(head)) {
      // `for VAR in LIST` / `case WORD in` headers are not commands — they
      // configure the loop / branch dispatch. Drop the entire segment.
      return undefined;
    }
    if (LEADING_SHELL_KEYWORDS.has(head)) {
      cur = spaceIdx === -1 ? '' : cur.slice(spaceIdx + 1).trim();
      continue;
    }
    break;
  }

  return cur.length > 0 ? cur : undefined;
}

/** Remove escaped newlines without creating a word/comment boundary. */
function foldLineContinuationsWithSourceMap(input: string): FoldedSourceMap {
  let out = '';
  const ranges: FoldedSourceRange[] = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inComment = false;
  let previousExpansionEnd = -1;

  const append = (index: number): void => {
    out += input[index];
    ranges.push({ start: index, end: index + 1 });
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? '';
    if (inComment) {
      append(i);
      if (ch === '\n') inComment = false;
      continue;
    }
    if (isShellCommentStart(input, i, inSingleQuote, inDoubleQuote, previousExpansionEnd)) {
      inComment = true;
      append(i);
      continue;
    }
    if (ch === '\\' && !inSingleQuote) {
      if (input[i + 1] === '\n') {
        i++;
        continue;
      }
      if (input[i + 1] === '\r' && input[i + 2] === '\n') {
        i += 2;
        continue;
      }
      append(i);
      // Escaped quotes cannot alter the surrounding quote state.
      if (i + 1 < input.length) append(++i);
      continue;
    }
    const expansion = !inSingleQuote && readBashExpansion(input, i, !inDoubleQuote);
    if (expansion) {
      // Its own quotes/comments belong to the nested shell, not this one.
      for (let j = i; j < expansion.end; j++) append(j);
      previousExpansionEnd = expansion.end;
      i = expansion.end - 1;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote;
    if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote;
    append(i);
  }
  return { text: out, ranges };
}

function foldLineContinuations(input: string): string {
  return foldLineContinuationsWithSourceMap(input).text;
}

/** Literal assignments are inert, but attached redirects still open files. */
function isAssignmentOnlySegment(seg: string): boolean {
  const input = seg.trim();
  const tokens = shellTokenizeWithMetadata(input, true);
  if (tokens.length === 0) return false;
  return tokens.every(
    (token) =>
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value) &&
      !token.pathSyntax?.dynamic &&
      !hasUnquotedRedirect(input.slice(token.start, token.end)),
  );
}

function hasUnquotedRedirect(input: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '<' || ch === '>') return true;
  }
  // An incomplete word must remain visible to fail-closed safety callers.
  return quote !== undefined;
}

interface HeredocMarker {
  marker: string;
  stripTabs: boolean;
  quoted: boolean;
}

interface SegmentHeredocMarker extends HeredocMarker {
  segmentIndex: number;
}

export interface HeredocBodyRange {
  start: number;
  end: number;
}

export interface HeredocBody extends HeredocBodyRange {
  quoted: boolean;
  /** The owning command pipeline, excluding independent ; / && / || commands. */
  header: string;
}

interface FoldedSourceRange {
  start: number;
  end: number;
}

interface FoldedSourceMap {
  text: string;
  ranges: FoldedSourceRange[];
}

function findLineBreakStart(input: string, start: number): number {
  const lf = input.indexOf('\n', start);
  if (lf === -1) return -1;
  return lf > 0 && input[lf - 1] === '\r' ? lf - 1 : lf;
}

function heredocWordIsTerminator(ch: string): boolean {
  return /[\s;&|<>]/.test(ch);
}

function heredocMarkerCanMatchLine(marker: string): boolean {
  return marker.length > 0 && !/[\0\r\n]/.test(marker);
}

function decodeSimpleAnsiCEscape(ch: string): string | undefined {
  if (ch === 'a') return '\x07';
  if (ch === 'b') return '\b';
  if (ch === 'e' || ch === 'E') return '\x1b';
  if (ch === 'f') return '\f';
  if (ch === 'n') return '\n';
  if (ch === 'r') return '\r';
  if (ch === 't') return '\t';
  if (ch === 'v') return '\v';
  if (ch === '\\' || ch === "'" || ch === '"' || ch === '?') return ch;
  return undefined;
}

function parseAnsiCHeredocWord(
  input: string,
  start: number,
): { marker: string; nextIndex: number } | undefined {
  let marker = '';
  let i = start;

  while (i < input.length) {
    const ch = input[i] ?? '';
    if (ch === "'") {
      return heredocMarkerCanMatchLine(marker) ? { marker, nextIndex: i + 1 } : undefined;
    }
    if (ch === '\\') {
      const next = input[i + 1];
      if (next === undefined) return undefined;
      const decoded = decodeSimpleAnsiCEscape(next);
      if (decoded === undefined) return undefined;
      marker += decoded;
      i += 2;
      continue;
    }
    marker += ch;
    i++;
  }

  return undefined;
}

function parseHeredocWord(
  input: string,
  start: number,
): { marker: string; nextIndex: number } | undefined {
  let marker = '';
  let quote: "'" | '"' | undefined;
  let i = start;

  while (i < input.length) {
    const ch = input[i] ?? '';

    if (quote) {
      if (ch === quote) {
        quote = undefined;
        i++;
        continue;
      }
      if (ch === '\\') {
        const next = input[i + 1];
        if (quote === '"' && next !== undefined && /[$`"\\\n]/.test(next)) {
          marker += next;
          i += 2;
          continue;
        }
      }
      marker += ch;
      i++;
      continue;
    }

    if (heredocWordIsTerminator(ch)) break;
    if (ch === '$' && input[i + 1] === "'") {
      const parsed = parseAnsiCHeredocWord(input, i + 2);
      if (!parsed) return undefined;
      marker += parsed.marker;
      i = parsed.nextIndex;
      continue;
    }
    if (ch === '$' && input[i + 1] === '"') return undefined;
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '\\') {
      const next = input[i + 1];
      if (next === undefined) return undefined;
      marker += next;
      i += 2;
      continue;
    }

    marker += ch;
    i++;
  }

  return quote === undefined && heredocMarkerCanMatchLine(marker)
    ? { marker, nextIndex: i }
    : undefined;
}

function parseHeredocMarkerAt(
  input: string,
  operatorIndex: number,
): { marker: HeredocMarker; nextIndex: number } | undefined {
  if (input[operatorIndex] !== '<' || input[operatorIndex + 1] !== '<') return undefined;
  if (input[operatorIndex - 1] === '<' || input[operatorIndex + 2] === '<') return undefined;

  let i = operatorIndex + 2;
  const stripTabs = input[i] === '-';
  if (stripTabs) i++;
  while (i < input.length && /[ \t]/.test(input[i] ?? '')) i++;
  if (i >= input.length) return undefined;

  const parsedWord = parseHeredocWord(input, i);
  if (!parsedWord) return undefined;

  const quoted = /['"\\]/.test(input.slice(i, parsedWord.nextIndex));
  return {
    marker: { marker: parsedWord.marker, stripTabs, quoted },
    nextIndex: parsedWord.nextIndex,
  };
}

function shellCommentStartsAt(input: string, index: number): boolean {
  return isShellCommentStart(input, index, false, false);
}

function findLineEnd(input: string, start: number): number {
  const lf = input.indexOf('\n', start);
  return lf === -1 ? input.length : lf;
}

function skipArithmeticContext(input: string, start: number): number | undefined {
  const markerLength =
    input[start] === '$' && input[start + 1] === '(' && input[start + 2] === '('
      ? 3
      : input[start] === '(' && input[start + 1] === '('
        ? 2
        : undefined;
  if (markerLength === undefined) return undefined;

  let depth = 1;
  for (let i = start + markerLength; i < input.length; i++) {
    const ch = input[i] ?? '';
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch !== ')') continue;
    if (input[i + 1] === ')' && depth === 1) return i + 2;
    if (depth > 1) depth--;
  }

  return input.length;
}

function parseHeredocMarkers(header: string): HeredocMarker[] {
  const markers: HeredocMarker[] = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < header.length; i++) {
    const ch = header[i] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;

    if (shellCommentStartsAt(header, i)) {
      i = findLineEnd(header, i);
      continue;
    }

    const arithmeticEnd = skipArithmeticContext(header, i);
    if (arithmeticEnd !== undefined) {
      i = arithmeticEnd - 1;
      continue;
    }

    const parsed = parseHeredocMarkerAt(header, i);
    if (parsed) {
      markers.push(parsed.marker);
      i = parsed.nextIndex - 1;
    }
  }

  return markers;
}

function findFirstHeredocBodyStart(input: string): number | undefined {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;

    if (shellCommentStartsAt(input, i)) {
      i = findLineEnd(input, i);
      continue;
    }

    const arithmeticEnd = skipArithmeticContext(input, i);
    if (arithmeticEnd !== undefined) {
      i = arithmeticEnd - 1;
      continue;
    }

    if (parseHeredocMarkerAt(input, i)) {
      const lineBreakStart = findLineBreakStart(input, i);
      return lineBreakStart === -1 ? undefined : lineBreakStart;
    }
  }

  return undefined;
}

function lineMatchesHeredocMarker(line: string, marker: HeredocMarker): boolean {
  const candidate = marker.stripTabs ? line.replace(/^\t+/, '') : line;
  return candidate === marker.marker;
}

function consumeHeredocBody(input: string, start: number, marker: HeredocMarker): number {
  let pos = start;
  while (pos < input.length) {
    const lineEnd = input.indexOf('\n', pos);
    const next = lineEnd === -1 ? input.length : lineEnd + 1;
    const rawLine = input.slice(pos, lineEnd === -1 ? input.length : lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (lineMatchesHeredocMarker(line, marker)) return next;
    pos = next;
  }
  return input.length;
}

/** Preserve source text, including executable substitutions in shell headers. */
export function splitShellSourceSegments(input: string, preservePipes = false): string[] {
  // Fold POSIX line-continuations (`\<NL>` outside single quotes) so the
  // tokenizer sees a single logical line per segment. Heredoc bodies are
  // handled before this helper is called, so body text is never folded here.
  const folded = foldLineContinuations(input);

  const rawSegments: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  let inComment = false;
  let previousExpansionEnd = -1;

  const flushSegment = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      rawSegments.push(trimmed);
    }
    current = '';
  };

  for (let i = 0; i < folded.length; i++) {
    const ch = folded[i] ?? '';

    if (inComment) {
      if (ch === '\n') {
        inComment = false;
        flushSegment();
      }
      continue;
    }

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingleQuote) {
      escaped = true;
      current += ch;
      continue;
    }

    // Recognize an unquoted shell comment BEFORE the expansion/quote branches
    // so a comment containing an unbalanced quote (e.g. `# don't`) can't leak
    // its open state forward and merge the next line into the same segment.
    if (isShellCommentStart(folded, i, inSingleQuote, inDoubleQuote, previousExpansionEnd)) {
      inComment = true;
      continue;
    }

    const expansion = !inSingleQuote && readBashExpansion(folded, i, !inDoubleQuote);
    if (expansion) {
      current += folded.slice(i, expansion.end);
      previousExpansionEnd = expansion.end;
      i = expansion.end - 1;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }

    // Outside quotes: check for separators
    if (!inSingleQuote && !inDoubleQuote) {
      const arithmeticEnd = skipArithmeticContext(folded, i);
      if (arithmeticEnd !== undefined) {
        current += folded.slice(i, arithmeticEnd);
        i = arithmeticEnd - 1;
        continue;
      }
      // Consume redirect operators before recognizing a background-list '&'.
      // Looking only at the preceding character would mistake quoted/escaped
      // literal '>' or '<' for a redirect operator.
      if (
        (ch === '>' && (folded[i + 1] === '|' || folded[i + 1] === '&')) ||
        (ch === '<' && folded[i + 1] === '&') ||
        (ch === '&' && folded[i + 1] === '>')
      ) {
        current += folded.slice(i, i + 2);
        i++;
        continue;
      }
      // Check for && or ||
      if ((ch === '&' && folded[i + 1] === '&') || (ch === '|' && folded[i + 1] === '|')) {
        flushSegment();
        i++; // skip second char of && or ||
        continue;
      }

      // Both synchronous and asynchronous lists contain independent commands.
      if (ch === ';' || ch === '&') {
        flushSegment();
        continue;
      }

      // Keep |& atomic: its ampersand is part of the pipeline, not a list.
      if (ch === '|') {
        const pipe = folded[i + 1] === '&' ? '|&' : '|';
        if (preservePipes) current += pipe;
        else flushSegment();
        i += pipe.length - 1;
        continue;
      }

      // Unquoted newline (or `\r\n`) — POSIX subcommand separator. Without
      // this multi-line bash glued together with newlines (verifier setup
      // scripts, `read`-piped heredoc, daemon-cleanup wrappers) is treated
      // as a single subcommand and trips whole-segment safety checks
      // (e.g. `bashCommandIsSafe` matching `^\s*source\s+` against a 5-line
      // segment that starts with `source` but actually contains
      // `source\nkill\nps`).
      if (ch === '\n') {
        flushSegment();
        continue;
      }
      if (ch === '\r' && folded[i + 1] === '\n') {
        flushSegment();
        i++; // consume \n half of \r\n
        continue;
      }
    }

    current += ch;
  }

  flushSegment();
  return rawSegments;
}

function splitCommandWithoutHeredoc(input: string): string[] {
  const rawSegments = splitShellSourceSegments(input);
  // Comments were removed at their own shell level, without slicing expansions.
  // Drop literal assignments and standalone control-flow keywords as no-ops.
  const commands: string[] = [];
  for (const seg of rawSegments) {
    if (isAssignmentOnlySegment(seg)) continue;
    const stripped = stripLeadingShellKeyword(seg);
    if (stripped !== undefined) commands.push(stripped);
  }

  return commands;
}

function findHeaderSegmentSources(header: string, segments: readonly string[]): string[] {
  const sources: string[] = [];
  const folded = foldLineContinuationsWithSourceMap(header);
  let foldedSearchFrom = 0;

  for (const segment of segments) {
    const start = folded.text.indexOf(segment, foldedSearchFrom);
    if (start === -1 || segment.length === 0) {
      sources.push(segment);
      continue;
    }

    const foldedEnd = start + segment.length;
    const sourceStart = folded.ranges[start]?.start;
    let sourceEnd = folded.ranges[foldedEnd - 1]?.end;
    if (sourceStart === undefined || sourceEnd === undefined) {
      sources.push(segment);
      foldedSearchFrom = foldedEnd;
      continue;
    }

    while (sourceEnd < header.length && /[ \t]/.test(header[sourceEnd] ?? '')) sourceEnd++;
    sources.push(header.slice(sourceStart, sourceEnd));
    foldedSearchFrom = foldedEnd;
  }

  return sources;
}

function splitCommandWithHeredoc(input: string, bodyStart: number): string[] {
  const header = input.slice(0, bodyStart);
  const segments = splitCommandWithoutHeredoc(header);
  const segmentSources = findHeaderSegmentSources(header, segments);
  const markers: SegmentHeredocMarker[] = segments.flatMap((segment, segmentIndex) =>
    parseHeredocMarkers(segment).map((marker) => ({ ...marker, segmentIndex })),
  );

  if (markers.length === 0) return splitCommandWithoutHeredoc(input);

  const appendedBodies = new Map<number, string>();
  let cursor = bodyStart;
  for (const marker of markers) {
    const next = consumeHeredocBody(input, cursor, marker);
    appendedBodies.set(
      marker.segmentIndex,
      `${appendedBodies.get(marker.segmentIndex) ?? ''}${input.slice(cursor, next)}`,
    );
    cursor = next;
  }

  const withBodies = segments.map((segment, index) =>
    appendedBodies.has(index)
      ? `${segmentSources[index] ?? segment}${appendedBodies.get(index) ?? ''}`
      : segment,
  );
  const suffix = input.slice(cursor);
  return suffix.trim().length > 0 ? [...withBodies, ...splitCommand(suffix)] : withBodies;
}

function collectHeredocBodyRanges(input: string, offset: number, ranges: HeredocBody[]): void {
  const rest = input.slice(offset);
  const bodyStart = findFirstHeredocBodyStart(rest);
  if (bodyStart === undefined) return;

  const header = rest.slice(0, bodyStart);
  const segments = splitShellSourceSegments(header, true);
  const markers = segments.flatMap((segment) =>
    parseHeredocMarkers(segment).map((marker) => ({ ...marker, header: segment })),
  );
  if (markers.length === 0) return;

  let cursor = offset + bodyStart;
  for (const marker of markers) {
    const next = consumeHeredocBody(input, cursor, marker);
    ranges.push({ start: cursor, end: next, quoted: marker.quoted, header: marker.header });
    cursor = next;
  }

  collectHeredocBodyRanges(input, cursor, ranges);
}

/**
 * Source ranges occupied by non-executed heredoc body text. Callers that need
 * to map split subcommands back to the original command must skip these ranges
 * because heredoc split segments can be logical, not contiguous source slices.
 */
export function findHeredocBodyRanges(input: string): HeredocBodyRange[] {
  return findHeredocBodies(input).map(({ start, end }) => ({ start, end }));
}

/** Preserve each body's expansion mode and owning pipeline for safety callers. */
export function findHeredocBodies(input: string): HeredocBody[] {
  const ranges: HeredocBody[] = [];
  collectHeredocBodyRanges(input, 0, ranges);
  return ranges;
}

/**
 * Split a compound command string into individual sub-commands.
 *
 * Handles `&&`, `||`, `;`, `&`, `|`, `|&` and unquoted newline separators while
 * respecting quoted strings and escaped characters. Line-continuations
 * (`\<NL>`) are removed before splitting. After splitting,
 * leading shell control-flow keywords (`if`, `then`, `do`, ...) are
 * stripped so the actual command gets evaluated (e.g.
 * `if ps -p 1; then kill 1; fi` splits into `['ps -p 1', 'kill 1']`;
 * standalone `fi` is dropped). Comment-only segments and pure
 * env-assignment segments are also dropped — they carry no command.
 *
 * @example
 * splitCommand('git add . && npm publish')
 * // => ['git add .', 'npm publish']
 *
 * splitCommand('echo "a && b"; ls')
 * // => ['echo "a && b"', 'ls']
 *
 * splitCommand('if ps -p 1; then kill 1; fi')
 * // => ['ps -p 1', 'kill 1']
 *
 * splitCommand('source /tmp/env\nkill 1\nps -p 1')
 * // => ['source /tmp/env', 'kill 1', 'ps -p 1']
 */
export function splitCommand(input: string): string[] {
  const bodyStart = findFirstHeredocBodyStart(input);
  return bodyStart === undefined
    ? splitCommandWithoutHeredoc(input)
    : splitCommandWithHeredoc(input, bodyStart);
}
