/**
 * Bash rule parsing + matching primitives.
 *
 * Extracted from `bash-permission.ts` to keep that module under the
 * 2000-line pre-commit block. Pure functions on strings — no I/O,
 * no permission state. Consumed by Step 5 user-allow gate and the
 * suggestion generator in `bash-checker.ts`.
 *
 * Rule shapes:
 *   - `git status`      → exact match
 *   - `npm:*`           → prefix match (literal `command === prefix`
 *                         OR `command.startsWith(prefix + ' ')`)
 *   - `npm run *`       → wildcard match (case-insensitive, `*` → `.*`
 *                         across newlines, `\*` literal `*`, `\\` literal `\`)
 */

import type { ShellPermissionRule } from '../types.js';
import { parseScriptPlainCommands } from './bash-ast.js';

export type CompiledShellPermissionRule =
  | Extract<ShellPermissionRule, { type: 'exact' }>
  | Extract<ShellPermissionRule, { type: 'prefix' }>
  | Extract<ShellPermissionRule, { type: 'argvPrefix' }>
  | { type: 'wildcard'; pattern: string; segments: readonly string[] };

/**
 * Encode a tokenised argv into the persisted rule-content string for an
 * argv-prefix rule. Codex-aligned: the stored form is a JSON array of the exact
 * command tokens (`["cargo","build","--release"]`), so a later invocation must
 * share that argv prefix to match. Mirrors Codex
 * `canonicalize_command_for_approval` collapsing a plain command to its argv.
 */
export function encodeArgvPrefixRule(argv: readonly string[]): string {
  return JSON.stringify(argv);
}

/** Decode a rule-content string into an argv array iff it is a JSON string[]. */
function tryDecodeArgvPrefix(ruleContent: string): string[] | undefined {
  const trimmed = ruleContent.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every((item) => typeof item === 'string')
  ) {
    return parsed as string[];
  }
  return undefined;
}

/**
 * Parse a rule's ruleContent into a typed ShellPermissionRule.
 *
 * | Syntax                          | Type        |
 * |---------------------------------|-------------|
 * | `["cargo","build"]` (JSON argv) | argvPrefix  |
 * | `git status`                    | exact       |
 * | `npm:*`                         | prefix      |
 * | `npm run *`                     | wildcard    |
 */
export function parseShellRule(ruleContent: string): ShellPermissionRule {
  // Codex-aligned argv-prefix rule: a JSON array of command tokens.
  const argv = tryDecodeArgvPrefix(ruleContent);
  if (argv) {
    return { type: 'argvPrefix', argv };
  }

  // Prefix syntax: "command:*" or "git commit:*"
  const prefixMatch = ruleContent.match(/^(.+):\*$/);
  if (prefixMatch?.[1] && !containsUnescapedWildcard(prefixMatch[1])) {
    return { type: 'prefix', prefix: prefixMatch[1] };
  }

  // Wildcard: contains unescaped *
  if (containsUnescapedWildcard(ruleContent)) {
    return { type: 'wildcard', pattern: ruleContent };
  }

  // Exact match
  return { type: 'exact', command: ruleContent };
}

export function compileShellRule(ruleContent: string): CompiledShellPermissionRule {
  const parsed = parseShellRule(ruleContent);
  if (parsed.type !== 'wildcard') return parsed;
  return { ...parsed, segments: wildcardSegments(parsed.pattern) };
}

function containsUnescapedWildcard(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '*' && (i === 0 || s[i - 1] !== '\\')) {
      return true;
    }
  }
  return false;
}

/**
 * Match a command against a wildcard pattern.
 *
 * - `*` matches any run of characters, newlines included. Callers match one
 *   `splitCommand` subcommand at a time, and splitCommand cuts at every
 *   top-level newline, so a newline here can only sit inside a heredoc body
 *   or a quoted argument.
 * - `\*` is treated as literal `*`
 * - `\\` is treated as literal `\`
 * - Matching is case-insensitive
 *
 * Literal pieces are found left to right with indexOf, so the cost stays
 * linear in the command length however many `*` a user rule holds (a regex
 * `.*` chain backtracks polynomially on a long heredoc and blocks the runtime).
 */
export function matchWildcardPattern(command: string, pattern: string): boolean {
  return matchWildcardSegments(command, wildcardSegments(pattern));
}

/** Lower-cased literal pieces between unescaped `*`; one piece means no wildcard. */
function wildcardSegments(pattern: string): string[] {
  const segments: string[] = [];
  let current = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    const next = pattern[i + 1];
    if (ch === '\\' && (next === '\\' || next === '*')) {
      current += next;
      i++;
    } else if (ch === '*') {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments.map((segment) => segment.toLowerCase());
}

function matchWildcardSegments(command: string, segments: readonly string[]): boolean {
  const text = command.toLowerCase();
  const first = segments[0] ?? '';
  if (segments.length === 1) return text === first;
  const last = segments[segments.length - 1] ?? '';
  const end = text.length - last.length;
  if (end < first.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  let position = first.length;
  for (const segment of segments.slice(1, -1)) {
    const found = text.indexOf(segment, position);
    if (found < 0 || found + segment.length > end) return false;
    position = found + segment.length;
  }
  return true;
}

/**
 * Check a single sub-command against a parsed ShellPermissionRule.
 */
export function matchShellRule(
  command: string,
  rule: ShellPermissionRule | CompiledShellPermissionRule,
): boolean {
  switch (rule.type) {
    case 'exact':
      return command === rule.command;
    case 'prefix':
      return command === rule.prefix || command.startsWith(`${rule.prefix} `);
    case 'argvPrefix':
      return matchArgvPrefix(command, rule.argv);
    case 'wildcard':
      if ('segments' in rule) return matchWildcardSegments(command, rule.segments);
      return matchWildcardPattern(command, rule.pattern);
  }
}

/**
 * Codex-aligned argv-prefix match: parse `command` into a single plain argv and
 * test whether `argv` is a token-wise prefix of it. Returns false when the
 * command is not a single word-only command (operators / substitutions /
 * redirects), so a stored prefix can never wave through a compound line.
 * Mirrors Codex matching a canonicalised argv against a stored prefix rule.
 */
function matchArgvPrefix(command: string, argv: readonly string[]): boolean {
  const commands = parseScriptPlainCommands(command);
  if (!commands || commands.length !== 1) return false;
  const target = commands[0]!;
  if (argv.length > target.length) return false;
  return argv.every((token, i) => token === target[i]);
}
