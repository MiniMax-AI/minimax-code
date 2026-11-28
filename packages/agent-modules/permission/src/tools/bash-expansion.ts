/** A lexical expansion boundary, never an evaluated word or authorization. */
export interface BashExpansion {
  end: number;
  script: string;
  kind: 'command' | 'arithmetic';
  malformed: boolean;
}

function isCharEscaped(input: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && input[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

/** Callers own quote state. Escapes and continued words cannot open comments. */
export function isShellCommentStart(
  input: string,
  index: number,
  inSingleQuote: boolean,
  inDoubleQuote: boolean,
  previousExpansionEnd = -1,
): boolean {
  if (inSingleQuote || inDoubleQuote || input[index] !== '#') return false;
  let previous = index - 1;
  // Bash removes escaped newlines before recognising words and comments.
  while (previous >= 0 && input[previous] === '\n') {
    const newlineStart = input[previous - 1] === '\r' ? previous - 1 : previous;
    if (!isCharEscaped(input, newlineStart)) break;
    previous = newlineStart - 2;
  }
  if (previous < 0) return true;
  // A substitution closes a word; a subshell closes a control operator.
  if (input[previous] === ')') {
    return previous + 1 !== previousExpansionEnd && !isCharEscaped(input, previous);
  }
  return /[ \t\n;&|(]/.test(input[previous] ?? '') && !isCharEscaped(input, previous);
}

export function findShellCommentLineEnd(input: string, start: number): number {
  const lf = input.indexOf('\n', start);
  return lf === -1 ? input.length : lf;
}

/**
 * Keep whitespace, separators and nested quotes inside an expansion together.
 * Callers own the outer quote/escape state and must not call this in literals.
 * An unclosed/over-nested expansion consumes the remainder and fails closed.
 */
export function readBashExpansion(
  input: string,
  start: number,
  allowProcessSubstitution = true,
  nesting = 0,
): BashExpansion | undefined {
  const backtick = input[start] === '`';
  const paren =
    input[start + 1] === '(' &&
    (input[start] === '$' ||
      (allowProcessSubstitution && (input[start] === '<' || input[start] === '>')));
  if (!backtick && !paren) return undefined;
  const arithmetic = !backtick && input[start] === '$' && input[start + 2] === '(';
  const bodyStart = start + (backtick ? 1 : arithmetic ? 3 : 2);
  const kind = arithmetic ? 'arithmetic' : 'command';
  const malformed = (): BashExpansion => ({
    end: input.length,
    script: input.slice(bodyStart),
    kind,
    malformed: true,
  });
  if (nesting > 64) return malformed();
  let quote: string | undefined;
  let previousExpansionEnd = -1;
  let depth = 1;
  for (let i = bodyStart; i < input.length; i++) {
    const char = input[i];
    if (char === '\\' && (backtick || quote !== "'")) {
      i++;
      continue;
    }
    // Backtick boundaries are independent of quotes/comments in the payload.
    if (backtick) {
      if (char === '`') {
        return {
          end: i + 1,
          script: input.slice(bodyStart, i).replace(/\\([$`\\])/g, '$1'),
          kind,
          malformed: false,
        };
      }
      continue;
    }
    if (isShellCommentStart(input, i, quote === "'", quote === '"', previousExpansionEnd)) {
      i = findShellCommentLineEnd(input, i);
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote ? undefined : "'";
      continue;
    }
    if (quote === "'") continue;
    const nested = readBashExpansion(input, i, !quote, nesting + 1);
    if (nested) {
      if (nested.malformed) return malformed();
      previousExpansionEnd = nested.end;
      i = nested.end - 1;
      continue;
    }
    if (char === '"') {
      quote = quote ? undefined : '"';
      continue;
    }
    if (quote) continue;
    if (char === '(') depth++;
    if (char === ')' && --depth === 0) {
      if (arithmetic && input[i + 1] !== ')') return malformed();
      return {
        end: i + (arithmetic ? 2 : 1),
        // Preserve all commands after comments for recursive safety inspection.
        script: input.slice(bodyStart, i),
        kind,
        malformed: false,
      };
    }
  }
  return malformed();
}
