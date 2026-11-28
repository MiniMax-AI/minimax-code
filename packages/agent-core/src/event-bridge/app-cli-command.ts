/**
 * Display-only App attribution, never execution or authorization evidence.
 * Parse command positions, not substrings in arguments/output. Shell commands are
 * never executed and scripts, environment variables and PATH are never resolved.
 */
type Word = { kind: 'word'; text: string; literal: boolean; assignment: boolean };
type Token = Word | { kind: 'operator'; text: string };
const REDIRECTS = new Set(['>', '>>', '>|', '<', '<>', '>&', '<&', '&>', '&>>']);
const SHELL_SYNTAX = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  'eval',
  'source',
  '.',
  'alias',
  'xargs',
  'parallel',
]);

export function parseAppCliToolName(command: unknown): string | undefined {
  if (typeof command !== 'string' || command.length > 65_536) return undefined;
  const names = parseCommands(command, 0);
  const unique = new Set(names ?? []);
  return unique.size === 1 ? [...unique][0] : undefined;
}

/** null means unsupported/ambiguous syntax; [] means no App invocation. */
function parseCommands(command: string, depth: number): string[] | null {
  if (depth > 4) return null;
  const tokens = tokenize(command);
  if (!tokens) return null;
  const names: string[] = [];
  let words: Word[] = [];
  let needsCommand = false;
  const finish = (): boolean => {
    if (words.length === 0) return false;
    const found = parseInvocation(words, depth);
    words = [];
    if (found === null) return false;
    names.push(...found);
    return true;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) return null;
    if (token.kind === 'word') {
      words.push(token);
      needsCommand = false;
    } else if (REDIRECTS.has(token.text)) {
      // Redirect operands are files/fds, never commands or CLI options.
      if (tokens[++i]?.kind !== 'word') return null;
    } else {
      if (token.text === '\n' && words.length === 0) continue;
      if (!finish()) return null;
      needsCommand = ['|', '|&', '&&', '||'].includes(token.text);
    }
  }
  if (needsCommand || (words.length > 0 && !finish())) return null;
  return names;
}

function parseInvocation(input: Word[], depth: number): string[] | null {
  const words = [...input];
  // Assignment values may expand, but cannot change the command position.
  while (words[0]?.assignment) words.shift();
  if (!words.length) return [];
  for (;;) {
    const first = words[0];
    if (!first?.literal) return null;
    const executable = executableName(first.text);
    if (SHELL_SYNTAX.has(executable)) return null;
    if (['env', 'command', 'exec', 'nohup', 'timeout', 'nice', 'time'].includes(executable)) {
      words.shift();
      if (!unwrapLauncher(executable, words)) return null;
      continue;
    }
    if (['bash', 'sh', 'zsh'].includes(executable)) {
      const flag = words[1];
      // Only literal inline scripts. Files, stdin, and arbitrary shell flags
      // could hide other App calls or change the shell's parsing rules.
      if (!flag?.literal || !['-c', '-lc', '-cl'].includes(flag.text) || !words[2]?.literal)
        return null;
      return parseCommands(words[2].text, depth + 1);
    }
    if (!['mcode-tools', 'mcode-tools.cmd'].includes(executable)) return [];
    return parseDirectCall(words);
  }
}

function executableName(value: string): string {
  // POSIX absolute/relative paths and quoted Windows drive paths.
  return value.split(/[\\/]/u).at(-1) ?? value;
}

function unwrapLauncher(name: string, words: Word[]): boolean {
  if (name === 'env') {
    while (words[0]) {
      const word = words[0];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)) {
        words.shift();
        continue;
      }
      if (!word.literal) return false;
      if (word.text === '--') {
        words.shift();
        break;
      }
      if (['-i', '--ignore-environment'].includes(word.text)) {
        words.shift();
        continue;
      }
      if (['-u', '--unset', '-C', '--chdir'].includes(word.text)) {
        if (!words[1]?.literal) return false;
        words.splice(0, 2);
        continue;
      }
      if (/^--(?:unset|chdir)=.+$/u.test(word.text)) {
        words.shift();
        continue;
      }
      if (word.text.startsWith('-')) return false;
      break;
    }
    while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text)) words.shift();
  } else if (name === 'timeout') {
    while (words[0]?.literal && words[0].text.startsWith('-')) {
      const option = words.shift()?.text;
      if (!option) return false;
      if (option === '--') break;
      if (['--foreground', '--preserve-status', '-v', '--verbose'].includes(option)) continue;
      if (['-s', '--signal', '-k', '--kill-after'].includes(option)) {
        if (!words.shift()?.literal) return false;
      } else if (!/^--(?:signal|kill-after)=.+$/u.test(option)) return false;
    }
    const duration = words.shift();
    if (!duration?.literal || !/^\d+(?:\.\d+)?[smhd]?$/u.test(duration.text)) return false;
  } else if (name === 'nice') {
    if (words[0]?.literal && ['-n', '--adjustment'].includes(words[0].text)) {
      words.shift();
      const value = words.shift();
      if (!value?.literal || !/^-?\d+$/u.test(value.text)) return false;
    } else if (words[0]?.literal && /^(?:-\d+|--adjustment=-?\d+)$/u.test(words[0].text))
      words.shift();
    if (words[0]?.text === '--') words.shift();
  } else {
    if (['command', 'time'].includes(name) && words[0]?.literal && words[0].text === '-p')
      words.shift();
    if (words[0]?.literal && words[0].text === '--') words.shift();
  }
  return Boolean(words[0]?.literal && !words[0].text.startsWith('-'));
}

function parseDirectCall(words: Word[]): string[] | null {
  const [, group, action, toolName, ...options] = words;
  if (!group?.literal || !action?.literal) return null;
  if (group.text !== 'connector' || action.text !== 'call') return [];
  if (!toolName?.literal || !/^connector__[a-zA-Z0-9_-]+__[a-zA-Z0-9_.-]+$/u.test(toolName.text))
    return null;
  let argumentsOption = false;
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (!option) return null;
    if (option.literal && option.text === '--raw') continue;
    if (/^--args(?:-file)?=.+$/s.test(option.text)) {
      if (argumentsOption) return null;
      argumentsOption = true;
    } else if (option.literal && ['--args', '--args-file'].includes(option.text)) {
      const value = options[++i];
      if (
        argumentsOption ||
        !value ||
        !value.text ||
        (value.literal && value.text.startsWith('--'))
      )
        return null;
      argumentsOption = true;
    } else return null;
  }
  return [toolName.text];
}

/** Quote-aware shell tokenization. Expansion never supplies command/tool names. */
function tokenize(command: string): Token[] | null {
  const tokens: Token[] = [];
  let text = '';
  let started = false;
  let wordStart = 0;
  let literal = true;
  let quoted = false;
  let quote: "'" | '"' | undefined;
  const flush = () => {
    if (started)
      tokens.push({
        kind: 'word',
        text,
        literal,
        assignment: /^[A-Za-z_][A-Za-z0-9_]*=/u.test(command.slice(wordStart)),
      });
    text = '';
    started = false;
    literal = true;
    quoted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (!started) wordStart = i;
    if (ch === '\0' || ch === '\r') return null;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else text += ch;
      continue;
    }
    if (ch === '\\') {
      const next = command[++i];
      if (next === undefined) return null;
      if (next === '\n') continue;
      if (quote && !['$', '`', '"', '\\'].includes(next)) text += '\\';
      text += next;
      started = true;
      quoted = true;
      continue;
    }
    if (quote === '"' && command.startsWith('$(cat ', i)) {
      // A common JSON argument form. Only literal cat file reads are recognized;
      // arbitrary command substitutions can contain additional App invocations.
      const end = command.indexOf(')', i + 2);
      if (end < 0) return null;
      const inner = command.slice(i + 2, end);
      if (/[\n$`()]/u.test(inner)) return null;
      const read = tokenize(inner);
      if (!read || read.length < 2 || read.some((part) => part.kind !== 'word' || !part.literal))
        return null;
      text += command.slice(i, end + 1);
      literal = false;
      i = end;
      continue;
    }
    if (quote === '"' && ch === '$' && command[i + 1] === '{') {
      const parameter = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/u.exec(command.slice(i))?.[0];
      if (!parameter) return null;
      text += parameter;
      literal = false;
      i += parameter.length - 1;
      continue;
    }
    if (ch === '`' || (ch === '$' && ['(', "'", '"', '{'].includes(command[i + 1] ?? '')))
      return null;
    if (ch === '$') {
      // Quoted simple parameter expansion is one argument. Unquoted expansion
      // may split into more argv entries and is deliberately unsupported.
      if (quote !== '"') return null;
      literal = false;
      text += ch;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else text += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      quoted = true;
    } else if (ch === ' ' || ch === '\t') flush();
    else if (ch === '#' && !started) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
    } else if (';&|<>\n'.includes(ch)) {
      const operator = /^(?:&>>|&&|\|\||\|&|&>|>>|>\||>&|<&|<>|<<|[;&|<>\n])/u.exec(
        command.slice(i),
      )?.[0];
      if (!operator || operator === '<<') return null; // heredocs/here-strings need their own grammar
      if (REDIRECTS.has(operator) && !quoted && /^\d+$/u.test(text)) {
        text = '';
        started = false;
      }
      flush();
      tokens.push({ kind: 'operator', text: operator });
      i += operator.length - 1;
    } else {
      if ('(){}*?[]!~'.includes(ch)) return null;
      text += ch;
      started = true;
    }
  }
  if (quote) return null;
  flush();
  return tokens;
}
