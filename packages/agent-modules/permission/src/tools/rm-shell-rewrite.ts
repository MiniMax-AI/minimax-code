import { isRmCommand, shellQuote } from './bash-permission.js';
import { splitCommand, findHeredocBodyRanges } from './bash-split.js';
import { consumeShellWrapperPrefix } from './bash-wrapper-unwrap.js';
import { shellTokenizeWithMetadata } from './shell-tokenize.js';

export const POSIX_TRASH_EXECUTION = Symbol.for('@mavis/permission/posix-trash-execution');

export interface PosixTrashExecution {
  readonly launcher: string;
  readonly dynamic: boolean;
}

export function withPosixTrashExecution(
  input: Record<string, unknown>,
  execution: PosixTrashExecution,
): Record<string, unknown> {
  return Object.defineProperty({ ...input }, POSIX_TRASH_EXECUTION, {
    value: Object.freeze({ ...execution }),
    enumerable: true,
  });
}

export function readPosixTrashExecution(
  input: Record<string, unknown>,
): PosixTrashExecution | undefined {
  const value = Object.getOwnPropertyDescriptor(input, POSIX_TRASH_EXECUTION)?.value as
    | PosixTrashExecution
    | undefined;
  return value && typeof value.launcher === 'string' && typeof value.dynamic === 'boolean'
    ? value
    : undefined;
}

/**
 * Change only the executable, never reconstruct its arguments. Bash retains
 * quoting, expansion, redirection order and the surrounding command sequence.
 * Substitutions that execute code keep the existing conservative path; simple
 * variables and filename expansion are checked by the execution sandbox.
 */
export function rewritePosixRm(
  command: string,
  launcher: string,
):
  | {
      command: string;
      dynamic: boolean;
    }
  | undefined {
  const ranges = findHeredocBodyRanges(command);
  const edits: Array<{ start: number; end: number }> = [];
  let offset = 0;
  let dynamic = false;
  for (const segment of splitCommand(command)) {
    let start = command.indexOf(segment, offset);
    while (start !== -1 && ranges.some((range) => start >= range.start && start < range.end)) {
      start = command.indexOf(segment, start + 1);
    }
    if (start === -1) continue;
    offset = start + segment.length;
    if (!isRmCommand(segment)) continue;
    const tokens = shellTokenizeWithMetadata(segment);
    const commandIndex = consumeShellWrapperPrefix(
      tokens.map((item) => item.value),
      0,
    );
    const token = tokens[commandIndex];
    if (!token || segment.slice(token.start, token.end) !== 'rm') continue;
    const expansion = classifyRmArguments(segment.slice(token.end));
    if (expansion === undefined) return undefined;
    // xargs/parallel append filenames from input that the permission checker
    // cannot resolve. Treat these just like variable/glob-expanded operands.
    const inputDriven = tokens
      .slice(0, commandIndex)
      .some((item) => ['xargs', 'parallel'].includes(item.value.split('/').pop() ?? ''));
    dynamic ||= expansion || inputDriven;
    edits.push({ start: start + token.start, end: start + token.end });
  }
  if (edits.length === 0) return undefined;
  let rewritten = command;
  const executable = `${shellQuote(launcher)} --rm-compatible`;
  for (const edit of edits.reverse()) {
    rewritten = rewritten.slice(0, edit.start) + executable + rewritten.slice(edit.end);
  }
  return { command: rewritten, dynamic };
}

// This is an execution exclusion check, not a shell parser. Only ordinary
// variable references are admitted; command/process/arithmetic substitutions
// must not start executing as a side effect of repairing rm cleanup.
function classifyRmArguments(source: string): boolean | undefined {
  let quote: "'" | '"' | undefined;
  let dynamic = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (ch === quote) {
      quote = undefined;
      continue;
    }
    if ((ch === "'" || ch === '"') && !quote) {
      quote = ch;
      continue;
    }
    if (quote === "'") continue;
    if (ch === '`' || (!quote && /[<>]/.test(ch ?? '') && source[i + 1] === '(')) return undefined;
    if (ch === '$') {
      const variable = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/.exec(
        source.slice(i),
      );
      if (!variable) return undefined;
      dynamic = true;
      i += variable[0].length - 1;
    } else if (!quote && /[*?[{~]/.test(ch ?? '')) dynamic = true;
    if (!quote && source.startsWith('<<', i)) return undefined;
  }
  return quote ? undefined : dynamic;
}
