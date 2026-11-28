/**
 * Shell tokenisation primitive used by the bash permission gate and the
 * classifier. Extracted to a dedicated module so both consumers
 * import from the same source — required because the classifier
 * already imports the SAFE first-word set + destructive-kill helper from
 * `bash-permission.ts` would create a circular reference if `shellTokenize`
 * were re-imported in the other direction.
 *
 * Splits an input shell command string into individual arguments,
 * correctly handling single quotes, double quotes, and backslash escaping.
 * Returns unquoted values (e.g. `"my file"` → `my file`).
 *
 * Notes for callers:
 *   - This tokeniser does NOT evaluate command substitution (`$(...)`,
 *     backticks), parameter expansion (`$VAR`), or glob expansion. The
 *     literal text of those constructs is preserved as a token.
 *   - Unquoted backslash escapes the following character. Inside double
 *     quotes it only escapes $, backtick, double quote, backslash or newline.
 *   - Single quotes preserve everything inside literally, including
 *     backslashes and double quotes (no escape processing).
 *   - Double quotes preserve backslashes before other characters literally.
 */
import {
  readBashExpansion,
  isShellCommentStart,
  findShellCommentLineEnd,
} from './bash-expansion.js';

export interface ShellToken {
  value: string;
  start: number;
  end: number;
  quoted: boolean;
  pathSyntax?: { dynamic: boolean; glob: boolean; expandHome: boolean };
}

export function shellTokenize(input: string): string[] {
  return shellTokenizeWithMetadata(input).map((token) => token.value);
}

export function shellTokenizeWithMetadata(input: string, includePathSyntax = false): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = '';
  let currentStart: number | undefined;
  let currentQuoted = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  let previousExpansionEnd = -1;
  let dynamic = false;
  let glob = false;

  const startCurrent = (index: number): void => {
    currentStart ??= index;
  };

  const flushCurrent = (end: number): void => {
    if (current.length > 0) {
      tokens.push({
        value: current,
        start: currentStart ?? end,
        end,
        quoted: currentQuoted,
        ...(includePathSyntax
          ? {
              pathSyntax: {
                dynamic,
                glob,
                expandHome:
                  input[currentStart ?? end] === '~' &&
                  (input[(currentStart ?? end) + 1] === '/' || (currentStart ?? end) + 1 === end),
              },
            }
          : {}),
      });
    }
    current = '';
    currentStart = undefined;
    currentQuoted = false;
    dynamic = false;
    glob = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    // Comments cannot leak quote state into following commands.
    if (
      !escaped &&
      isShellCommentStart(input, i, inSingleQuote, inDoubleQuote, previousExpansionEnd)
    ) {
      flushCurrent(i);
      i = findShellCommentLineEnd(input, i);
      continue;
    }

    if (escaped) {
      startCurrent(i - 1);
      current += ch;
      currentQuoted = true;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingleQuote) {
      const next = input[i + 1];
      if (next === '\n') {
        i += 1;
        continue;
      }
      if (next === '\r' && input[i + 2] === '\n') {
        i += 2;
        continue;
      }
      if (inDoubleQuote && next !== undefined && !['$', '`', '"', '\\'].includes(next)) {
        startCurrent(i);
        current += ch;
        continue;
      }
      startCurrent(i);
      currentQuoted = true;
      escaped = true;
      continue;
    }

    const expansion = !inSingleQuote && readBashExpansion(input, i, !inDoubleQuote);
    if (expansion) {
      startCurrent(i);
      current += input.slice(i, expansion.end);
      dynamic = true;
      previousExpansionEnd = expansion.end;
      i = expansion.end - 1;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      startCurrent(i);
      currentQuoted = true;
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      startCurrent(i);
      currentQuoted = true;
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (isShellWhitespace(ch) && !inSingleQuote && !inDoubleQuote) {
      flushCurrent(i);
      continue;
    }

    startCurrent(i);
    if (!inSingleQuote && (ch === '$' || ch === '`')) dynamic = true;
    if (!inSingleQuote && !inDoubleQuote && /[*?[]/.test(ch)) glob = true;
    current += ch;
  }

  flushCurrent(input.length);

  return tokens;
}

function isShellWhitespace(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === 32 || (code >= 9 && code <= 13);
}
