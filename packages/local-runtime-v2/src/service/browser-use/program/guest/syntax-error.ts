import { Script } from 'node:vm';

/**
 * Where a syntax error in a model-written Browser program is. QuickJS reports
 * only a short message and a line ("expecting ','"), often a line past the
 * mistake's cause, so a program with long lines gave the model little to fix.
 * V8 only parses the source here (nothing runs): when it rejects the code too,
 * its message, line and column are used; otherwise the QuickJS message and
 * line. The Browser program Worker loads this module, so it uses only Node
 * built-ins.
 */
interface GuestSyntaxError {
  readonly message: string;
  /** 1-based line in the model's code. */
  readonly line: number;
  /** 1-based column; absent when only the line is known. */
  readonly column?: number;
  /** The line with a marker under the error. */
  readonly snippet: string;
}

const V8_FILE = 'guest.js';
/**
 * node's decorated SyntaxError stack: `file:line`, the source line, then the
 * carets. Node draws no carets for an error past column 1020 or one whose
 * range runs off the line; V8's message and line still hold there.
 */
const V8_STACK = /^[^\n]*:(\d+)\n[^\n]*\n(?:([ \t]*)(\^+))?/u;
const MAX_SNIPPET_CHARS = 200;
/** Characters kept before the error when a long line is cut. */
const SNIPPET_LEAD_CHARS = 80;

interface V8SyntaxError {
  readonly message: string;
  readonly line: number;
  readonly column?: number;
  readonly width?: number;
}

function parseWithV8(code: string): V8SyntaxError | undefined {
  try {
    // The wrapper's first line is line 0, so lines are the code's own.
    void new Script(`(async () => {\n${code}\n})`, { filename: V8_FILE, lineOffset: -1 });
    return undefined;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'SyntaxError') return undefined;
    const match = V8_STACK.exec(error.stack ?? '');
    if (!match) return undefined;
    return {
      message: error.message,
      line: Number(match[1]),
      ...(match[3] ? { column: (match[2] ?? '').length + 1, width: match[3].length } : {}),
    };
  }
}

function snippetOf(text: string, line: number, column?: number, width = 1): string {
  const number = String(line);
  const gutter = ' '.repeat(number.length);
  const start =
    column !== undefined && column - 1 > SNIPPET_LEAD_CHARS ? column - 1 - SNIPPET_LEAD_CHARS : 0;
  const shown = text.slice(start, start + MAX_SNIPPET_CHARS);
  const lead = start > 0 ? '…' : '';
  const source = `  ${number} | ${lead}${shown}${start + MAX_SNIPPET_CHARS < text.length ? '…' : ''}`;
  if (column === undefined) return source;
  const offset = column - 1 - start;
  const marks = Math.max(1, Math.min(width, shown.length - offset));
  return `${source}\n  ${gutter} | ${' '.repeat(lead.length + offset)}${'^'.repeat(marks)}`;
}

/** The last line that is not blank; 1 for code with none. */
function lastCodeLine(lines: readonly string[]): number {
  let line = lines.length;
  while (line > 1 && (lines[line - 1] ?? '').trim() === '') line -= 1;
  return line;
}

/**
 * Locates a syntax error in `code`. `reported` is what QuickJS said, its line
 * already in the code's own numbering.
 */
export function locateGuestSyntaxError(
  code: string,
  reported: { readonly message: string; readonly line?: number },
): GuestSyntaxError {
  const lines = code.split('\n');
  const parsed = parseWithV8(code);
  const found = parsed?.line ?? reported.line ?? lines.length;
  // Code that ends too early is reported on the wrapper's closing line.
  const lastLine = lastCodeLine(lines);
  const pastEnd = found > lastLine;
  const line = pastEnd ? lastLine : Math.max(1, found);
  const column = pastEnd ? undefined : parsed?.column;
  return {
    message: parsed?.message ?? reported.message,
    line,
    ...(column === undefined ? {} : { column }),
    snippet: snippetOf(lines[line - 1] ?? '', line, column, parsed?.width),
  };
}
