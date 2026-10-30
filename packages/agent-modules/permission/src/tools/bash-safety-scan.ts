/**
 * Bash safety scans + permission-check surface stripping.
 *
 * Extracted from `bash-permission.ts` to keep that module under the
 * 2000-line pre-commit block. Pure functions on shell text — no I/O,
 * no permission state.
 *
 * Two responsibilities:
 *   1. {@link bashCommandIsSafe} — narrow SOFT pre-scan for shape-level
 *      smells ($(), backticks, eval, source, process substitution).
 *   2. {@link checkDangerousPatterns} — broad SUBCOMMAND_DANGEROUS
 *      sweep including rm-bypass aliases. Both run on the
 *      stripped surface (heredoc bodies and echo/printf data masked).
 *
 * Heredoc / echo-printf / option-value stripping
 * ({@link getShellPermissionCheckSurface}) is shared because both scans
 * must ignore literal data unless it is actually executed by the shell.
 */

import { ALL_DANGEROUS_COMMAND_PATTERNS } from '../classifier/dangerous-patterns.js';
import { shellTokenize } from './shell-tokenize.js';

// ---------------------------------------------------------------------------
// Permission-check surface (heredoc bodies + echo/printf + option-value masking)
// ---------------------------------------------------------------------------

const HEREDOC_PATTERN = /<<-?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/;
const STDIN_CODE_INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'ksh',
  'dash',
  'node',
  'deno',
  'python',
  'python3',
  'ruby',
]);
const SHELL_WRAPPERS = new Set(['sudo', 'env', 'command', 'exec']);
const TEXT_DATA_LONG_OPTIONS = new Set([
  '--body',
  '--caption',
  '--comment',
  '--content',
  '--description',
  '--markdown',
  '--message',
  '--note',
  '--prompt',
  '--reason',
  '--text',
  '--title',
]);

type ShellTokenSpan = {
  raw: string;
  value: string;
  start: number;
  end: number;
};

/**
 * Return the part of a shell command that is actually interpreted as shell.
 *
 * Text-only heredoc bodies, echo/printf arguments, and quoted values passed
 * to whitelisted text-data long options (`--prompt`, `--content`, etc.) are
 * data, not shell, so dangerous strings inside them should not trigger
 * permission checks. Unknown options and values containing executable
 * expansions (`$()`, backticks, process substitution) stay visible. If data
 * is piped into a shell or fed directly to a shell interpreter (`cat <<EOF |
 * bash`, `cat <<EOF | /bin/bash`, `bash <<EOF`), the payload is retained.
 */
export function getShellPermissionCheckSurface(command: string): string {
  return stripNonExecutedEchoPrintfData(
    stripNonExecutedOptionValues(stripNonExecutedHeredocBodies(command)),
  );
}

export function commandHasExecutedHeredocBody(command: string): boolean {
  if (!HEREDOC_PATTERN.test(command)) return false;

  return command
    .replace(/\r\n/g, '\n')
    .split('\n')
    .some((line) => HEREDOC_PATTERN.test(line) && heredocBodyIsExecuted(line));
}

function stripNonExecutedHeredocBodies(command: string): string {
  if (!HEREDOC_PATTERN.test(command)) return command;

  const lines = command.replace(/\r\n/g, '\n').split('\n');
  const keptLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = line.match(HEREDOC_PATTERN);
    if (!marker) {
      keptLines.push(line);
      continue;
    }

    const delimiter = marker[1] ?? marker[2] ?? marker[3];
    if (!delimiter) {
      keptLines.push(line);
      continue;
    }

    const allowIndentedTerminator = marker[0].startsWith('<<-');
    const bodyLines: string[] = [];
    keptLines.push(line);

    let terminator: string | undefined;
    while (i + 1 < lines.length) {
      i++;
      const bodyLine = lines[i]!;
      const comparable = allowIndentedTerminator ? bodyLine.replace(/^\t+/, '') : bodyLine;
      if (comparable === delimiter) {
        terminator = bodyLine;
        break;
      }
      bodyLines.push(bodyLine);
    }

    if (heredocBodyIsExecuted(line)) keptLines.push(...bodyLines);
    if (terminator !== undefined) keptLines.push(terminator);
  }

  return keptLines.join('\n');
}

function stripNonExecutedEchoPrintfData(command: string): string {
  const tokens = shellTokenize(command.trim());
  const firstWord = tokens[0];
  if (
    (firstWord === 'echo' || firstWord === 'printf') &&
    !/[`]|\$\(|\\x/.test(command) &&
    !/[<>]/.test(command) &&
    !/[;&]/.test(command) &&
    !hasUnquotedPipe(command)
  ) {
    return firstWord;
  }
  return command;
}

function stripNonExecutedOptionValues(command: string): string {
  const tokens = shellTokenizeWithSpans(command);
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const optionWithEquals = getLongOptionEqualsValue(token.raw);
    if (optionWithEquals && shouldMaskLongOptionValue(optionWithEquals.option, optionWithEquals)) {
      replacements.push({
        start: token.start + optionWithEquals.valueStart,
        end: token.start + optionWithEquals.valueEnd,
        value: optionWithEquals.replacement,
      });
      continue;
    }

    if (!isMaskableLongOption(token.value)) continue;
    const next = tokens[i + 1];
    if (!next) continue;
    const quoted = getFullyQuotedTokenValue(next.raw);
    if (!quoted || !shouldMaskLongOptionValue(token.value, quoted)) continue;

    replacements.push({
      start: next.start + quoted.valueStart,
      end: next.start + quoted.valueEnd,
      value: quoted.replacement,
    });
    i++;
  }

  if (replacements.length === 0) return command;

  let out = '';
  let cursor = 0;
  for (const replacement of replacements) {
    out += command.slice(cursor, replacement.start);
    out += replacement.value;
    cursor = replacement.end;
  }
  out += command.slice(cursor);
  return out;
}

function shellTokenizeWithSpans(input: string): ShellTokenSpan[] {
  const tokens: ShellTokenSpan[] = [];
  let raw = '';
  let value = '';
  let start = -1;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  const pushToken = (end: number) => {
    if (start === -1) return;
    tokens.push({ raw, value, start, end });
    raw = '';
    value = '';
    start = -1;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (start === -1 && !/\s/.test(ch)) start = i;

    if (escaped) {
      raw += ch;
      value += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingleQuote) {
      raw += ch;
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      raw += ch;
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      raw += ch;
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (/\s/.test(ch) && !inSingleQuote && !inDoubleQuote) {
      pushToken(i);
      continue;
    }

    raw += ch;
    value += ch;
  }

  pushToken(input.length);
  return tokens;
}

function getLongOptionEqualsValue(raw: string): {
  option: string;
  rawValue: string;
  quote: string;
  valueStart: number;
  valueEnd: number;
  replacement: string;
} | null {
  const match = raw.match(/^(--[A-Za-z0-9][A-Za-z0-9._-]*)=(['"])/);
  if (!match) return null;
  const option = match[1]!;
  const quote = match[2]!;
  const minLength = match[0].length + 1;
  if (!isMaskableLongOption(option) || raw.length < minLength || raw[raw.length - 1] !== quote) {
    return null;
  }
  const valueStart = match[0].length;
  const valueEnd = raw.length - 1;
  const rawValue = raw.slice(valueStart, valueEnd);
  return { option, rawValue, quote, valueStart, valueEnd, replacement: '<option-value>' };
}

function getFullyQuotedTokenValue(raw: string): {
  rawValue: string;
  quote: string;
  valueStart: number;
  valueEnd: number;
  replacement: string;
} | null {
  if (raw.length < 2) return null;
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) return null;
  return {
    rawValue: raw.slice(1, -1),
    quote,
    valueStart: 1,
    valueEnd: raw.length - 1,
    replacement: '<option-value>',
  };
}

function isMaskableLongOption(option: string): boolean {
  return TEXT_DATA_LONG_OPTIONS.has(option);
}

function shouldMaskLongOptionValue(
  option: string,
  value: { rawValue: string; quote: string },
): boolean {
  if (!isMaskableLongOption(option)) return false;
  return !containsExecutableExpansion(value.rawValue, value.quote);
}

function containsExecutableExpansion(rawValue: string, quote: string): boolean {
  if (quote === "'") return false;

  let escaped = false;
  for (let i = 0; i < rawValue.length; i++) {
    const ch = rawValue[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '`') return true;
    if (ch === '$' && rawValue[i + 1] === '(') return true;
    if ((ch === '<' || ch === '>') && rawValue[i + 1] === '(') return true;
  }
  return false;
}

function heredocBodyIsExecuted(commandLine: string): boolean {
  return hasUnquotedPipeToShell(commandLine) || startsWithShellInterpreter(commandLine);
}

function hasUnquotedPipeToShell(input: string): boolean {
  const pipeIndex = findUnquotedPipe(input);
  if (pipeIndex === -1) return false;

  const tokens = shellTokenize(input.slice(pipeIndex + 1).trim());
  return isStdinCodeInterpreterToken(tokens[skipShellWrappers(tokens)]);
}

function hasUnquotedPipe(input: string): boolean {
  return findUnquotedPipe(input) !== -1;
}

/**
 * Detect an `rm <whitespace>` invocation at an unquoted shell-command boundary:
 * start of string, after `;`, `&`, `|`, or `\n`. Quote-aware so that `rm`
 * appearing inside a single- or double-quoted argument (e.g. a regex pattern
 * passed to `rg`/`grep`/`sed`/`awk`) does NOT count — those are data, not an
 * executed command. Tracks backslash escapes the same way `findUnquotedPipe`
 * does, so `\;rm` (escaped) is also ignored.
 */
function hasUnquotedRmAtCommandStart(input: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  let atBoundary = true; // start of string is a boundary

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (escaped) {
      escaped = false;
      atBoundary = false;
      continue;
    }
    if (ch === '\\' && !inSingleQuote) {
      escaped = true;
      atBoundary = false;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      atBoundary = false;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      atBoundary = false;
      continue;
    }

    if (inSingleQuote || inDoubleQuote) {
      atBoundary = false;
      continue;
    }

    // Unquoted separators and newline establish a fresh command boundary.
    if (ch === ';' || ch === '&' || ch === '\n') {
      atBoundary = true;
      continue;
    }
    if (ch === '|') {
      // `||` is logical-OR — still a command boundary (the second branch is a
      // new command). Single `|` is a pipe; also a command boundary.
      atBoundary = true;
      continue;
    }

    if (/\s/.test(ch)) {
      // Whitespace after a separator keeps us at the boundary.
      continue;
    }

    if (atBoundary && ch === 'r' && input[i + 1] === 'm' && /\s/.test(input[i + 2] ?? '')) {
      return true;
    }

    atBoundary = false;
  }
  return false;
}

function findUnquotedPipe(input: string): number {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
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
    if (ch === '|' && !inSingleQuote && !inDoubleQuote && input[i + 1] !== '|') return i;
  }

  return -1;
}

function startsWithShellInterpreter(commandLine: string): boolean {
  const withoutHeredoc = commandLine.replace(HEREDOC_PATTERN, '');
  const tokens = shellTokenize(withoutHeredoc);
  return isStdinCodeInterpreterToken(tokens[skipShellWrappers(tokens)]);
}

function skipShellWrappers(tokens: string[]): number {
  let i = 0;
  while (SHELL_WRAPPERS.has(tokens[i] ?? '')) {
    const wrapper = tokens[i];
    i++;
    if (wrapper === 'env') {
      while (tokens[i]?.startsWith('-') || tokens[i]?.includes('=')) i++;
    }
    if (wrapper === 'command' && tokens[i] === '--') i++;
  }
  return i;
}

function isStdinCodeInterpreterToken(token: string | undefined): boolean {
  const executable = token?.split('/').pop();
  return executable ? STDIN_CODE_INTERPRETERS.has(executable) : false;
}

// ---------------------------------------------------------------------------
// Soft pre-scan
// ---------------------------------------------------------------------------

/**
 * Check if a bash command is safe (no shell injection patterns).
 *
 * Returns `null` if safe, or a reason string if unsafe.
 */
export function bashCommandIsSafe(command: string): string | null {
  const permissionSurface = getShellPermissionCheckSurface(command);

  // Check for command substitution: $(...) or `...`
  if (/\$\(/.test(permissionSurface)) {
    return 'Contains command substitution $(...)';
  }
  if (/`[^`]*`/.test(permissionSurface)) {
    return 'Contains backtick command substitution';
  }

  // Check for process substitution: <(...) or >(...)
  if (/<\(/.test(permissionSurface) || />\(/.test(permissionSurface)) {
    return 'Contains process substitution';
  }

  // Check for eval
  if (/\beval\b/.test(permissionSurface)) {
    return 'Contains eval';
  }

  // Check for source / dot-source
  if (/^\s*source\s+/.test(permissionSurface) || /^\s*\.\s+\S/.test(permissionSurface)) {
    return 'Contains source command';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Subcommand-graded danger sweep
// ---------------------------------------------------------------------------

/**
 * Check if a command matches any dangerous pattern from the extended pattern sets.
 *
 * Returns `null` if no dangerous pattern matched, or a description string
 * identifying the matched pattern category.
 *
 * This function checks ALL_DANGEROUS_COMMAND_PATTERNS which includes:
 * - Deletion command variants (rm via path/wrapper, rmdir, unlink, find -delete, etc.)
 * - Encoding bypass patterns (base64 -d | bash, curl | sh, eval, etc.)
 * - macOS irrecoverable deletion (srm, diskutil erase*, etc.)
 * - Storage/disk-level destructive operations (wipefs, sgdisk, zfs destroy, etc.)
 */
export function checkDangerousPatterns(
  command: string,
  options: { nativeDelete?: boolean } = {},
): string | null {
  const permissionSurface = getShellPermissionCheckSurface(command);

  // Direct `rm` is normally rewritten by the bash permission layer before this
  // function runs. Keep it here for shell text that is executed indirectly,
  // such as heredoc payloads piped to bash, where the rewrite cannot apply.
  // Quote-aware: `rm` inside a quoted argument (regex pattern passed to
  // rg/grep/sed/awk) is data, not an executed command — do NOT match.
  if (!options.nativeDelete && hasUnquotedRmAtCommandStart(permissionSurface)) {
    return 'Dangerous deletion command';
  }

  // Read-only regex/search/data tools (grep/rg/sed/awk) never execute their
  // string arguments — patterns matched purely by dangerous-keyword literals
  // inside those arguments (e.g. `grep "Remove-Item" src.ts`) are false
  // positives. Skip the broad pattern sweep for them. Other tools, including
  // `find -exec sh -c '<payload>'`, must NOT short-circuit because they DO
  // execute their args (the `sh -c` wrapper is caught by its own patterns).
  if (commandStartsWithReadOnlyDataTool(permissionSurface)) {
    return null;
  }

  for (const { pattern, category, recoverableDeleteOnly } of ALL_DANGEROUS_COMMAND_PATTERNS) {
    if (options.nativeDelete && recoverableDeleteOnly) continue;
    if (pattern.test(permissionSurface)) {
      return category;
    }
  }
  return null;
}

/**
 * Read-only data-extraction / regex-search tools whose string arguments are
 * always interpreted as DATA (a search pattern or substitution rule) and
 * never executed as shell commands. Keep this list narrow: any tool whose
 * args might be sent to a child interpreter (`find -exec`, `xargs`,
 * `parallel`, `watch`, etc.) MUST stay subject to the full pattern sweep.
 */
const READ_ONLY_DATA_TOOLS: ReadonlySet<string> = new Set(['grep', 'rg', 'sed', 'awk', 'jq', 'yq']);

function commandStartsWithReadOnlyDataTool(command: string): boolean {
  const tokens = shellTokenize(command.trim());
  let i = 0;
  // Skip env-var assignment prefixes (e.g. `FOO=bar grep ...`).
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/i.test(tokens[i] ?? '')) i++;
  const first = tokens[i];
  if (!first) return false;
  // Strip any directory prefix (`/usr/bin/grep` → `grep`).
  const exe = first.split('/').pop();
  return READ_ONLY_DATA_TOOLS.has(exe ?? '');
}
