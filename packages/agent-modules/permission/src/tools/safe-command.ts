/**
 * Codex-aligned read-only command whitelist.
 *
 * Direct port of OpenAI Codex
 * `shell-command/src/command_safety/is_safe_command.rs`. A command that
 * `isKnownSafeCommand` accepts is a known read-only operation that can be
 * auto-approved without prompting the user and without persisting any rule.
 *
 * Two entry points:
 *   - `isSafeToCallWithExec(argv)` — judges a single tokenised command.
 *   - `isKnownSafeCommand(argv)`   — also unwraps `bash -lc "<script>"` and is
 *     true only when EVERY command in the (word-only) script is itself safe.
 *
 * The conditional rules (git / find / rg / sed / base64) mirror Codex's option
 * blacklists exactly so a flag that can write / execute disqualifies the
 * otherwise read-only command.
 */

import { parseShellLcPlainCommands } from './bash-ast.js';

/** Basename of an executable path, used as the whitelist lookup key. */
function executableNameLookupKey(raw: string): string | undefined {
  const normalized = raw.replaceAll('\\', '/');
  const idx = normalized.lastIndexOf('/');
  const name = idx === -1 ? normalized : normalized.slice(idx + 1);
  return name.length > 0 ? name : undefined;
}

/** Unconditionally read-only commands (Codex `is_safe_to_call_with_exec`). */
const ALWAYS_SAFE_COMMANDS = new Set<string>([
  'cat',
  'cd',
  'cut',
  'echo',
  'expr',
  'false',
  'grep',
  'head',
  'id',
  'ls',
  'nl',
  'paste',
  'pwd',
  'rev',
  'seq',
  'stat',
  'tail',
  'tr',
  'true',
  'uname',
  'uniq',
  'wc',
  'which',
  'whoami',
]);

export function isSafeToCallWithExec(command: readonly string[]): boolean {
  const cmd0 = command[0];
  if (cmd0 === undefined) return false;
  const key = executableNameLookupKey(cmd0);
  if (key === undefined) return false;

  if (ALWAYS_SAFE_COMMANDS.has(key)) return true;

  switch (key) {
    case 'base64':
      return isSafeBase64(command);
    case 'find':
      return isSafeFind(command);
    case 'rg':
      return isSafeRipgrep(command);
    case 'git':
      return isSafeGitCommand(command);
    case 'mcode-tools':
      return isSafeMcodeTools(command);
    case 'sed':
      return isSafeSed(command);
    default:
      return false;
  }
}

/**
 * Codex `is_known_safe_command`: normalises `zsh` → `bash`, then accepts a
 * single safe command OR a `bash -lc "<script>"` where every word-only command
 * in the script is itself safe.
 */
export function isKnownSafeCommand(command: readonly string[]): boolean {
  const normalized = command.map((token) => (token === 'zsh' ? 'bash' : token));

  if (isSafeToCallWithExec(normalized)) return true;

  const allCommands = parseShellLcPlainCommands(normalized);
  if (
    allCommands &&
    allCommands.length > 0 &&
    allCommands.every((cmd) => isSafeToCallWithExec(cmd))
  ) {
    return true;
  }
  return false;
}

const POWERSHELL_READ_ONLY_COMMANDS = new Set([
  'get-childitem',
  'get-command',
  'get-content',
  'get-help',
  'get-item',
  'get-location',
  'get-member',
  'get-variable',
  'measure-object',
  'resolve-path',
  'select-string',
  'test-path',
]);

/**
 * Conservative classifier for the Windows desktop `bash` tool, whose payload is
 * actually evaluated by PowerShell. Only one simple foreground command is
 * accepted; operators, interpolation, assignments and script blocks fail closed.
 */
export function isKnownSafePowerShellCommand(command: string): boolean {
  const tokens = tokenizeSimplePowerShell(command);
  if (!tokens || tokens.length === 0) return false;
  const executable = tokens[0]!.toLowerCase();
  if (POWERSHELL_READ_ONLY_COMMANDS.has(executable)) return true;
  const nativeExecutable = executable.endsWith('.exe') ? executable.slice(0, -4) : executable;
  if (!POWERSHELL_NATIVE_READ_ONLY_COMMANDS.has(nativeExecutable)) return false;
  return isSafeToCallWithExec([nativeExecutable, ...tokens.slice(1)]);
}

/** Native CLIs whose read-only subsets {@link isSafeToCallWithExec} already models. */
const POWERSHELL_NATIVE_READ_ONLY_COMMANDS = new Set(['git', 'rg', 'mcode-tools']);

/**
 * PowerShell's own quote and dash characters (System.Management.Automation
 * CharTraits): any single quote closes a single-quoted string, any double
 * quote closes a double-quoted one, and an en/em dash or horizontal bar starts
 * a parameter just like `-`.
 */
const POWERSHELL_SINGLE_QUOTES = "'\u2018\u2019\u201A\u201B";
const POWERSHELL_DOUBLE_QUOTES = '"\u201C\u201D\u201E';
const POWERSHELL_DASHES = '\u2013\u2014\u2015';

/**
 * Split one PowerShell command into literal words, reading typographic quotes
 * and dashes the way PowerShell does. Returns undefined for any operator,
 * interpolation, assignment, script block or line break.
 */
export function tokenizeSimplePowerShell(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let quote: 'single' | 'double' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === '\r' || character === '\n') return undefined;
    if (quote) {
      const closes =
        quote === 'single'
          ? POWERSHELL_SINGLE_QUOTES.includes(character)
          : POWERSHELL_DOUBLE_QUOTES.includes(character);
      if (closes) {
        quote = undefined;
      } else {
        if (quote === 'double' && (character === '$' || character === '`')) return undefined;
        token += character;
      }
      continue;
    }
    if (POWERSHELL_SINGLE_QUOTES.includes(character)) {
      quote = 'single';
      started = true;
      continue;
    }
    if (POWERSHELL_DOUBLE_QUOTES.includes(character)) {
      quote = 'double';
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = '';
      started = false;
      continue;
    }
    if (';|><&{}()=`$'.includes(character)) return undefined;
    // Only a dash that begins an unquoted word introduces a parameter.
    token += !started && POWERSHELL_DASHES.includes(character) ? '-' : character;
    started = true;
  }
  if (quote) return undefined;
  if (token) tokens.push(token);
  return tokens;
}

// ───────────────────────────────────────────────────────────────────────────
// Conditional command rules
// ───────────────────────────────────────────────────────────────────────────

function isSafeBase64(command: readonly string[]): boolean {
  const UNSAFE = new Set(['-o', '--output']);
  return !command
    .slice(1)
    .some(
      (arg) =>
        UNSAFE.has(arg) || arg.startsWith('--output=') || (arg.startsWith('-o') && arg !== '-o'),
    );
}

function isSafeFind(command: readonly string[]): boolean {
  const UNSAFE_FIND_OPTIONS = new Set([
    // Execute arbitrary commands.
    '-exec',
    '-execdir',
    '-ok',
    '-okdir',
    // Delete matching files.
    '-delete',
    // Write pathnames to a file.
    '-fls',
    '-fprint',
    '-fprint0',
    '-fprintf',
  ]);
  return !command.some((arg) => UNSAFE_FIND_OPTIONS.has(arg));
}

function isSafeRipgrep(command: readonly string[]): boolean {
  const UNSAFE_WITH_ARGS = ['--pre', '--hostname-bin'];
  const UNSAFE_WITHOUT_ARGS = new Set(['--search-zip', '-z']);
  return !command.some(
    (arg) =>
      UNSAFE_WITHOUT_ARGS.has(arg) ||
      UNSAFE_WITH_ARGS.some((opt) => arg === opt || arg.startsWith(`${opt}=`)),
  );
}

/**
 * mcode-tools discovery commands. Only the connector catalog reads seen in
 * feedback replays are listed: `connector tools [--keyword <text>]` and
 * `connector tool <name>`. `connector call` (effect depends on the tool),
 * `upload_temp_url` (uploads a local file) and generation commands stay
 * with the regular gate.
 */
function isSafeMcodeTools(command: readonly string[]): boolean {
  if (command[1] !== 'connector') return false;
  const args = command.slice(3);
  const first = args[0] ?? '';
  if (command[2] === 'tool') return args.length === 1 && !first.startsWith('-');
  if (command[2] !== 'tools') return false;
  if (args.length === 0) return true;
  if (args.length === 1) return first.startsWith('--keyword=');
  return args.length === 2 && first === '--keyword';
}

function isSafeSed(command: readonly string[]): boolean {
  // Special-case `sed -n {N|M,N}p`.
  return command.length <= 4 && command[1] === '-n' && isValidSedNArg(command[2]);
}

/** Returns true if `arg` matches /^(\d+,)?\d+p$/ (Codex `is_valid_sed_n_arg`). */
function isValidSedNArg(arg: string | undefined): boolean {
  if (arg === undefined) return false;
  if (!arg.endsWith('p')) return false;
  const core = arg.slice(0, -1);
  const parts = core.split(',');
  const isNum = (s: string): boolean => s.length > 0 && /^[0-9]+$/.test(s);
  if (parts.length === 1) return isNum(parts[0]!);
  if (parts.length === 2) return isNum(parts[0]!) && isNum(parts[1]!);
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// git
// ───────────────────────────────────────────────────────────────────────────

const GIT_READ_ONLY_SUBCOMMANDS = ['status', 'log', 'diff', 'show', 'branch'];

type GitOptionPattern =
  | { kind: 'exact'; option: string }
  | { kind: 'shortInline'; option: string }
  | { kind: 'prefix'; prefix: string };

const UNSAFE_GIT_GLOBAL_OPTIONS: GitOptionPattern[] = [
  { kind: 'exact', option: '-C' },
  { kind: 'shortInline', option: '-C' },
  { kind: 'exact', option: '-c' },
  { kind: 'shortInline', option: '-c' },
  { kind: 'exact', option: '-p' },
  { kind: 'exact', option: '--config-env' },
  { kind: 'prefix', prefix: '--config-env=' },
  { kind: 'exact', option: '--exec-path' },
  { kind: 'prefix', prefix: '--exec-path=' },
  { kind: 'exact', option: '--git-dir' },
  { kind: 'prefix', prefix: '--git-dir=' },
  { kind: 'exact', option: '--namespace' },
  { kind: 'prefix', prefix: '--namespace=' },
  { kind: 'exact', option: '--paginate' },
  { kind: 'exact', option: '--super-prefix' },
  { kind: 'prefix', prefix: '--super-prefix=' },
  { kind: 'exact', option: '--work-tree' },
  { kind: 'prefix', prefix: '--work-tree=' },
];

const UNSAFE_GIT_SUBCOMMAND_OPTIONS: GitOptionPattern[] = [
  { kind: 'exact', option: '--output' },
  { kind: 'prefix', prefix: '--output=' },
  { kind: 'exact', option: '--ext-diff' },
  { kind: 'exact', option: '--textconv' },
  { kind: 'exact', option: '--exec' },
  { kind: 'prefix', prefix: '--exec=' },
];

function gitOptionMatches(arg: string, pattern: GitOptionPattern): boolean {
  switch (pattern.kind) {
    case 'exact':
      return arg === pattern.option;
    case 'shortInline':
      return arg.startsWith(pattern.option) && arg.length > pattern.option.length;
    case 'prefix':
      return arg.startsWith(pattern.prefix);
  }
}

function gitMatchesAny(arg: string, patterns: GitOptionPattern[]): boolean {
  return patterns.some((pattern) => gitOptionMatches(arg, pattern));
}

/** git global options that take a following value (used to skip that value). */
function isGitGlobalOptionWithValue(arg: string): boolean {
  return [
    '-C',
    '-c',
    '--config-env',
    '--exec-path',
    '--git-dir',
    '--namespace',
    '--super-prefix',
    '--work-tree',
  ].includes(arg);
}

function isGitGlobalOptionWithInlineValue(arg: string): boolean {
  return (
    arg.startsWith('--config-env=') ||
    arg.startsWith('--exec-path=') ||
    arg.startsWith('--git-dir=') ||
    arg.startsWith('--namespace=') ||
    arg.startsWith('--super-prefix=') ||
    arg.startsWith('--work-tree=') ||
    ((arg.startsWith('-C') || arg.startsWith('-c')) && arg.length > 2)
  );
}

/**
 * Find the first matching git subcommand, skipping known global options that
 * may appear before it. Mirrors Codex `find_git_subcommand`.
 */
export function findGitSubcommand(
  command: readonly string[],
  subcommands: readonly string[],
): { index: number; subcommand: string } | undefined {
  const cmd0 = command[0];
  if (cmd0 === undefined || executableNameLookupKey(cmd0) !== 'git') return undefined;

  let skipNext = false;
  for (let idx = 1; idx < command.length; idx++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const arg = command[idx]!;
    if (isGitGlobalOptionWithInlineValue(arg)) continue;
    if (isGitGlobalOptionWithValue(arg)) {
      skipNext = true;
      continue;
    }
    if (arg === '--' || arg.startsWith('-')) continue;
    if (subcommands.includes(arg)) return { index: idx, subcommand: arg };
    // First non-option token is the subcommand; if it isn't one we want, stop.
    return undefined;
  }
  return undefined;
}

function isSafeGitCommand(command: readonly string[]): boolean {
  const found = findGitSubcommand(command, GIT_READ_ONLY_SUBCOMMANDS);
  if (!found) return false;

  const globalArgs = command.slice(1, found.index);
  if (globalArgs.some((arg) => gitMatchesAny(arg, UNSAFE_GIT_GLOBAL_OPTIONS))) {
    return false;
  }

  const subArgs = command.slice(found.index + 1);
  switch (found.subcommand) {
    case 'status':
    case 'log':
    case 'diff':
    case 'show':
      return gitSubcommandArgsAreReadOnly(subArgs);
    case 'branch':
      return gitSubcommandArgsAreReadOnly(subArgs) && gitBranchIsReadOnly(subArgs);
    default:
      return false;
  }
}

function gitSubcommandArgsAreReadOnly(args: readonly string[]): boolean {
  return !args.some((arg) => gitMatchesAny(arg, UNSAFE_GIT_SUBCOMMAND_OPTIONS));
}

function gitBranchIsReadOnly(branchArgs: readonly string[]): boolean {
  if (branchArgs.length === 0) return true; // `git branch` lists branches.
  let sawReadOnlyFlag = false;
  for (const arg of branchArgs) {
    if (
      [
        '--list',
        '-l',
        '--show-current',
        '-a',
        '--all',
        '-r',
        '--remotes',
        '-v',
        '-vv',
        '--verbose',
      ].includes(arg)
    ) {
      sawReadOnlyFlag = true;
    } else if (arg.startsWith('--format=')) {
      sawReadOnlyFlag = true;
    } else {
      // Any other flag or positional may create / rename / delete a branch.
      return false;
    }
  }
  return sawReadOnlyFlag;
}
