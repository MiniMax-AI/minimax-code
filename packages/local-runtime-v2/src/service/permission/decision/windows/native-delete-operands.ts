/**
 * Best-effort delete operands for positive matching under native deletion.
 * A result is never proof that a command is confined. Parameters follow the
 * executing shell's own binding rules so option values are not read as
 * targets; any shape this reader cannot bind confidently yields `undefined`,
 * which leaves the command to ordinary permissions instead of denying it.
 */
import { normalizeWindowsProgramName, tokenizeWindowsCommand } from './command-surfaces.js';
import type { WindowsCommandSurface } from './command-surfaces.js';

type NativeDeleteSyntax = 'powershell' | 'cmd' | 'posix';

export interface NativeDeleteTarget {
  /** Unquoted operand text. */
  readonly value: string;
  /** Syntax whose variable and home spellings apply to this operand. */
  readonly syntax: NativeDeleteSyntax;
  /** A PowerShell single-quoted literal: `$HOME` names a relative item there. */
  readonly literal: boolean;
}

export interface NativeDeleteOperands {
  readonly recursive: boolean;
  readonly targets: NativeDeleteTarget[];
}

interface ShellWord {
  readonly text: string;
  /** Characters outside quotes, used for syntax such as `-Name` and `(`. */
  readonly bare: string;
  /** Elements split at unquoted array commas; a quoted comma stays inside one element. */
  readonly elements: readonly WordElement[];
  /** The word starts / ends with an unquoted array comma. */
  readonly leadingComma: boolean;
  readonly trailingComma: boolean;
}

interface WordElement {
  readonly value: string;
  /** Unquoted characters of this element. */
  readonly bare: string;
  readonly singleQuoted: boolean;
  readonly doubleQuoted: boolean;
}

/** One PowerShell argument: a word, or words joined by unquoted commas into an array. */
type PowerShellArgument = readonly ShellWord[];

interface PowerShellParameter {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly kind: 'switch' | 'target' | 'value';
}

/** Remove-Item plus common parameters, as bound by PowerShell 5.1 and 7. */
const REMOVE_ITEM_PARAMETERS: readonly PowerShellParameter[] = [
  { name: 'path', aliases: [], kind: 'target' },
  { name: 'literalpath', aliases: ['pspath', 'lp'], kind: 'target' },
  { name: 'recurse', aliases: [], kind: 'switch' },
  { name: 'force', aliases: [], kind: 'switch' },
  { name: 'whatif', aliases: ['wi'], kind: 'switch' },
  { name: 'confirm', aliases: ['cf'], kind: 'switch' },
  { name: 'verbose', aliases: ['vb'], kind: 'switch' },
  { name: 'debug', aliases: ['db'], kind: 'switch' },
  { name: 'usetransaction', aliases: ['usetx'], kind: 'switch' },
  ...[
    ['filter'],
    ['include'],
    ['exclude'],
    ['credential'],
    ['stream'],
    ['erroraction', 'ea'],
    ['warningaction', 'wa'],
    ['informationaction', 'infa'],
    ['progressaction', 'proga'],
    ['errorvariable', 'ev'],
    ['warningvariable', 'wv'],
    ['informationvariable', 'iv'],
    ['outvariable', 'ov'],
    ['outbuffer', 'ob'],
    ['pipelinevariable', 'pv'],
  ].map(([name = '', ...aliases]) => ({ name, aliases, kind: 'value' as const })),
];

const POWERSHELL_DELETE_COMMANDS: ReadonlySet<string> = new Set(['remove-item', 'ri', 'remove']);
const CMD_DELETE_COMMANDS: ReadonlySet<string> = new Set(['del', 'erase', 'rd', 'rmdir']);

export function readNativeDeleteOperands(
  surface: WindowsCommandSurface,
): NativeDeleteOperands | undefined {
  const [program] = tokenizeWindowsCommand(surface.command, surface.shellFamily);
  if (!program) return undefined;
  const name = normalizeWindowsProgramName(program);
  if (surface.shellFamily === 'posix') return readPosixRm(surface.command);
  const powershell =
    POWERSHELL_DELETE_COMMANDS.has(name) ||
    (surface.shellFamily === 'powershell' && (name === 'rm' || CMD_DELETE_COMMANDS.has(name)));
  if (powershell) return readRemoveItem(splitShellWords(surface.command, true).slice(1));
  const words = splitShellWords(surface.command, false).slice(1);
  return name === 'rm' ? readRmWords(words, 'cmd') : readCmdDelete(words);
}

/** PowerShell `~` goes through the provider; variables expand outside single quotes. */
export function isNativeHomeReference(target: NativeDeleteTarget): boolean {
  const value = target.value.toLowerCase().replace(/[\\/]$/, '');
  if (target.syntax === 'cmd') return value === '%userprofile%' || value === '%home%';
  if (target.syntax === 'posix') {
    return /^(?:~|\$home|\$\{home\}|\$userprofile|\$\{userprofile\})$/.test(value);
  }
  if (value === '~') return true;
  return (
    !target.literal &&
    /^(?:\$home|\$\{home\}|\$env:(?:userprofile|home)|\$\{\s*env:\s*(?:userprofile|home)\s*\})$/.test(
      value,
    )
  );
}

function readRemoveItem(words: ShellWord[]): NativeDeleteOperands | undefined {
  if (words.some(isPowerShellExpression)) return undefined;
  const args = groupPowerShellArguments(words);
  const targets: NativeDeleteTarget[] = [];
  let recursive = false;
  for (let index = 0; index < args.length; index += 1) {
    const binding = bindPowerShellArgument(args[index] ?? [], args[index + 1]);
    if (!binding) return undefined;
    index += binding.consumed;
    targets.push(...binding.targets);
    if (binding.parameter?.name === 'recurse') recursive = binding.enabled === true;
  }
  return { recursive, targets };
}

/** A positional argument is a target; a parameter binds its own value. */
function bindPowerShellArgument(
  arg: PowerShellArgument,
  next: PowerShellArgument | undefined,
): (PowerShellBinding & { targets: NativeDeleteTarget[] }) | undefined {
  const binding = arg[0]?.bare.startsWith('-')
    ? bindPowerShellParameter(arg, next)
    : { consumed: 0, value: arg };
  if (!binding) return undefined;
  return { ...binding, targets: binding.value ? powerShellTargets(binding.value) : [] };
}

/** PowerShell joins `a, b` and `a ,b` into one array argument across spaces. */
function groupPowerShellArguments(words: ShellWord[]): PowerShellArgument[] {
  const groups: ShellWord[][] = [];
  for (const word of words) {
    const last = groups[groups.length - 1];
    const previous = last?.[last.length - 1];
    if (last && previous && (previous.trailingComma || word.leadingComma)) {
      last.push(word);
    } else {
      groups.push([word]);
    }
  }
  return groups;
}

type PowerShellBinding = {
  parameter?: PowerShellParameter;
  consumed: number;
  value?: PowerShellArgument;
  enabled?: boolean;
};

function bindPowerShellParameter(
  arg: PowerShellArgument,
  next: PowerShellArgument | undefined,
): PowerShellBinding | undefined {
  const [word, ...rest] = arg;
  if (!word) return undefined;
  const colon = word.text.indexOf(':');
  const rawName = (colon < 0 ? word.text : word.text.slice(0, colon)).slice(1).toLowerCase();
  const parameter = resolvePowerShellParameter(rawName);
  // A parameter name cannot itself start an array.
  if (!parameter || (colon < 0 && rest.length > 0)) return undefined;
  const first = colon < 0 ? undefined : inlineWord(word, colon);
  const inline = first ? [first, ...rest] : undefined;
  if (parameter.kind === 'switch') {
    return bindSwitch(parameter, colon >= 0, inline ?? next, !inline);
  }
  return bindValue(parameter, inline, next);
}

/** `-Name` enables a switch; `-Name:$true` / `-Name: $false` sets it explicitly. */
function bindSwitch(
  parameter: PowerShellParameter,
  explicit: boolean,
  value: PowerShellArgument | undefined,
  separate: boolean,
): PowerShellBinding | undefined {
  if (!explicit) return { parameter, consumed: 0, enabled: true };
  const enabled = value?.length === 1 ? readSwitchValue(value[0]?.text) : undefined;
  if (enabled === undefined) return undefined;
  return { parameter, consumed: separate ? 1 : 0, enabled };
}

/** Only target parameters report their value; other option values are skipped whole. */
function bindValue(
  parameter: PowerShellParameter,
  inline: PowerShellArgument | undefined,
  next: PowerShellArgument | undefined,
): PowerShellBinding | undefined {
  const value = inline ?? next;
  if (!value?.[0] || (!inline && value[0].bare.startsWith('-'))) return undefined;
  const consumed = inline ? 0 : 1;
  return parameter.kind === 'target' ? { parameter, consumed, value } : { parameter, consumed };
}

/** Exact names and aliases win; otherwise a prefix must select one parameter. */
function resolvePowerShellParameter(rawName: string): PowerShellParameter | undefined {
  if (!rawName) return undefined;
  const exact = REMOVE_ITEM_PARAMETERS.find(
    (parameter) => parameter.name === rawName || parameter.aliases.includes(rawName),
  );
  if (exact) return exact;
  const matches = REMOVE_ITEM_PARAMETERS.filter((parameter) =>
    [parameter.name, ...parameter.aliases].some((candidate) => candidate.startsWith(rawName)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function readSwitchValue(text: string | undefined): boolean | undefined {
  const value = text?.toLowerCase();
  if (value === '$true') return true;
  if (value === '$false') return false;
  return undefined;
}

/** The value after `-Name:`; the parameter name itself is always unquoted text. */
function inlineWord(word: ShellWord, colon: number): ShellWord | undefined {
  const text = word.text.slice(colon + 1);
  if (!text) return undefined;
  const bareColon = word.bare.indexOf(':');
  const bare = bareColon < 0 ? '' : word.bare.slice(bareColon + 1);
  const [first, ...rest] = word.elements;
  if (!first) return undefined;
  const value = {
    ...first,
    value: first.value.slice(colon + 1),
    bare: first.bare.slice(colon + 1),
  };
  return {
    ...word,
    text,
    bare,
    elements: [value, ...rest],
    leadingComma: value.value === '' && rest.length > 0,
  };
}

/** Unquoted commas separate array elements; a quoted comma is part of one path. */
function powerShellTargets(arg: PowerShellArgument): NativeDeleteTarget[] {
  return arg.flatMap((word) =>
    word.elements
      .filter((element) => element.value.trim() !== '')
      .map((element) => ({
        value: element.value.trim(),
        syntax: 'powershell' as const,
        // Wholly single-quoted: PowerShell does not expand `$HOME` there.
        literal: element.singleQuoted && !element.doubleQuoted && element.bare === '',
      })),
  );
}

const PROTECTED_VARIABLES = String.raw`systemroot|windir|programfiles(?:\(x86\))?|programw6432|commonprogramfiles(?:\(x86\))?`;
const PROTECTED_DIRECTORIES = String.raw`windows|program files(?: \(x86\))?`;
const POWERSHELL_PROTECTED_REFERENCE = new RegExp(
  String.raw`^(?:\$env:(?:${PROTECTED_VARIABLES})|\$\{\s*env:\s*(?:${PROTECTED_VARIABLES})\s*\}|(?:\$env:systemdrive|\$\{\s*env:\s*systemdrive\s*\})[\\/](?:${PROTECTED_DIRECTORIES}))(?:[\\/]|$)`,
  'i',
);
const CMD_PROTECTED_REFERENCE = new RegExp(
  String.raw`^(?:%(?:${PROTECTED_VARIABLES})%|%systemdrive%[\\/](?:${PROTECTED_DIRECTORIES}))(?:[\\/]|$)`,
  'i',
);

/**
 * A protected-directory variable in the executing shell's own syntax. Other
 * spellings, such as `%SystemRoot%` in PowerShell, are ordinary file names.
 */
export function isNativeProtectedReference(target: NativeDeleteTarget): boolean {
  if (target.syntax === 'cmd') return CMD_PROTECTED_REFERENCE.test(target.value);
  return (
    target.syntax === 'powershell' &&
    !target.literal &&
    POWERSHELL_PROTECTED_REFERENCE.test(target.value)
  );
}

/** Subexpressions, script blocks and calls build a target this reader cannot evaluate. */
function isPowerShellExpression(word: ShellWord): boolean {
  return /[(){}@`]/.test(word.bare.replace(/\$\{[^}]*\}/g, '')) || word.text === '--%';
}

function readCmdDelete(words: ShellWord[]): NativeDeleteOperands {
  const targets: NativeDeleteTarget[] = [];
  let recursive = false;
  for (const word of words) {
    if (/^\/s$/i.test(word.bare)) recursive = true;
    else if (!/^\/[a-z?](?::\S*)?$/i.test(word.bare)) {
      targets.push({ value: word.text, syntax: 'cmd', literal: false });
    }
  }
  return { recursive, targets };
}

function readPosixRm(command: string): NativeDeleteOperands {
  const words = tokenizeWindowsCommand(command, 'posix')
    .slice(1)
    .map((text) => plainWord(text));
  return readRmWords(words, 'posix');
}

function readRmWords(words: ShellWord[], syntax: 'cmd' | 'posix'): NativeDeleteOperands {
  const targets: NativeDeleteTarget[] = [];
  let recursive = false;
  let operandsOnly = false;
  for (const word of words) {
    if (!operandsOnly && word.bare === '--') operandsOnly = true;
    else if (!operandsOnly && word.bare.startsWith('-') && word.bare.length > 1) {
      recursive ||= /^-[a-z]*r/i.test(word.bare) || word.bare === '--recursive';
    } else targets.push({ value: word.text, syntax, literal: false });
  }
  return { recursive, targets };
}

/**
 * Split shell words while remembering which characters were quoted. CMD has
 * no single-quote syntax, so a `'` is an ordinary path character there.
 */
function splitShellWords(command: string, singleQuotes: boolean): ShellWord[] {
  const words: ShellWord[] = [];
  let word = emptyWordState();
  let quote: string | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else appendChar(word, char, quote);
    } else if (char === '"' || (singleQuotes && char === "'")) {
      quote = char;
      markQuote(word, char);
    } else if (/\s/.test(char)) {
      if (word.started) words.push(finishWord(word));
      word = emptyWordState();
    } else {
      appendChar(word, char, undefined);
    }
  }
  if (word.started) words.push(finishWord(word));
  return words;
}

interface ElementState {
  value: string;
  bare: string;
  doubleQuoted: boolean;
  singleQuoted: boolean;
}

interface WordState {
  text: string;
  bare: string;
  started: boolean;
  elements: ElementState[];
  leadingComma: boolean | undefined;
  trailingComma: boolean;
}

function emptyElement(): ElementState {
  return { value: '', bare: '', doubleQuoted: false, singleQuoted: false };
}

function emptyWordState(): WordState {
  return {
    text: '',
    bare: '',
    started: false,
    elements: [emptyElement()],
    leadingComma: undefined,
    trailingComma: false,
  };
}

function currentElement(word: WordState): ElementState {
  const element = word.elements[word.elements.length - 1];
  if (element) return element;
  const created = emptyElement();
  word.elements.push(created);
  return created;
}

function markQuote(word: WordState, quote: string): void {
  word.started = true;
  word.leadingComma ??= false;
  word.trailingComma = false;
  const element = currentElement(word);
  if (quote === "'") element.singleQuoted = true;
  else element.doubleQuoted = true;
}

/** Only an unquoted comma separates PowerShell array elements. */
function appendChar(word: WordState, char: string, quote: string | undefined): void {
  word.started = true;
  word.text += char;
  const arrayComma = quote === undefined && char === ',';
  word.leadingComma ??= arrayComma;
  word.trailingComma = arrayComma;
  if (quote === undefined) word.bare += char;
  if (arrayComma) {
    word.elements.push(emptyElement());
    return;
  }
  const element = currentElement(word);
  element.value += char;
  if (quote === undefined) element.bare += char;
}

function finishWord(word: WordState): ShellWord {
  return {
    text: word.text,
    bare: word.bare,
    elements: word.elements,
    leadingComma: word.leadingComma === true,
    trailingComma: word.trailingComma,
  };
}

function plainWord(text: string): ShellWord {
  return {
    text,
    bare: text,
    elements: [{ value: text, bare: text, singleQuoted: false, doubleQuoted: false }],
    leadingComma: false,
    trailingComma: false,
  };
}
