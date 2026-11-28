/**
 * Windows write/delete target readers. Every reader returns `undefined` for a
 * shape it cannot prove, so callers fail closed instead of treating an
 * unrecognized operand as an in-workspace target.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  isRmCommand,
  parseRmTargets,
  parseScriptPlainCommands,
  parseWindowsNativeDelete,
  type ShellFamily,
} from '@mavis/permission';
import {
  expandWindowsCommandSurfacesWithShell,
  normalizeWindowsProgramName,
  tokenizeWindowsCommand,
  type WindowsCommandSurface,
} from './command-surfaces.js';

type ArgumentMatcher = (arg: string) => boolean;

function matchesAny(...patterns: RegExp[]): ArgumentMatcher {
  return (arg) => patterns.some((pattern) => pattern.test(arg));
}

const WINDOWS_NATIVE_DELETE_COMMANDS: ReadonlySet<string> = new Set([
  'del',
  'erase',
  'rd',
  'rmdir',
  'remove-item',
  'ri',
  'remove',
]);

const WINDOWS_WRITE_OR_DELETE_COMMANDS: ReadonlySet<string> = new Set([
  ...WINDOWS_NATIVE_DELETE_COMMANDS,
  'ac',
  'add-content',
  'cp',
  'copy',
  'copy-item',
  'mavis-trash',
  'md',
  'move',
  'move-item',
  'mv',
  'mkdir',
  'new-item',
  'ni',
  'out-file',
  'rm',
  'robocopy',
  'sc',
  'set-content',
  'set-item',
  'si',
  'shred',
  'unlink',
  'xcopy',
]);

/** Every resolved shell may run a native rm; only the recoverable rewrite is exempt. */
const NATIVE_RM_SHELL_FAMILIES: ReadonlySet<ShellFamily | undefined> = new Set<ShellFamily>([
  'posix',
  'powershell',
  'cmd',
  'unknown',
]);

const WINDOWS_MOVE_COMMANDS: ReadonlySet<string> = new Set(['move', 'mv', 'move-item']);

/**
 * Built-in PowerShell aliases of Copy-Item / Move-Item. A bare alias resolves
 * to the cmdlet; `cp.exe` or a path still runs the native program.
 */
const POWERSHELL_COPY_MOVE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['cp', 'copy-item'],
  ['copy', 'copy-item'],
  ['cpi', 'copy-item'],
  ['mv', 'move-item'],
  ['move', 'move-item'],
  ['mi', 'move-item'],
]);

interface WindowsCommandName {
  /** Program basename without extension, as typed. */
  readonly name: string;
  /** The cmdlet a bare PowerShell alias resolves to, otherwise `name`. */
  readonly cmdlet: string;
}

function readWindowsCommandName(
  program: string,
  shellFamily: ShellFamily | undefined,
): WindowsCommandName {
  const name = normalizeWindowsProgramName(program);
  const isBareAlias = shellFamily === 'powershell' && program.toLowerCase() === name;
  return { name, cmdlet: (isBareAlias && POWERSHELL_COPY_MOVE_ALIASES.get(name)) || name };
}

const WINDOWS_COPY_OR_MOVE_COMMANDS: ReadonlySet<string> = new Set([
  'copy',
  'xcopy',
  'robocopy',
  'cp',
  'copy-item',
  'move',
  'mv',
  'move-item',
]);

/**
 * PowerShell binds any unambiguous prefix of a parameter name, with an
 * optional `:value`. `-Recurse:$false` is still treated as recursive.
 */
function powerShellParameterPrefix(parameter: string, minLength: number): RegExp {
  const optionalTail = [...parameter.slice(minLength)].reduceRight(
    (tail, char) => `(?:${char}${tail})?`,
    '',
  );
  return new RegExp(`^-${parameter.slice(0, minLength)}${optionalTail}(?::.*)?$`, 'i');
}

/** Copy-Item and Remove-Item have no other parameter starting with `r`. */
const POWERSHELL_RECURSE = powerShellParameterPrefix('recurse', 1);

/** A GNU cp short-option cluster with -r/-R. Case-sensitive, so `-Fr` (FromSession) is not one. */
const GNU_CP_RECURSIVE_CLUSTER = /^-[abdfHilLnPpRrsStTuvxZ]*[rR][abdfHilLnPpRrsStTuvxZ]*$/;

const RECURSIVE_WRITE_ARGUMENTS: ReadonlyMap<string, ArgumentMatcher> = new Map([
  ['rm', matchesAny(/^-\S*r/i)],
  ['rmdir', matchesAny(/^\/s$/i)],
  ['rd', matchesAny(/^\/s$/i)],
  ['remove-item', matchesAny(POWERSHELL_RECURSE)],
  ['ri', matchesAny(POWERSHELL_RECURSE)],
  ['remove', matchesAny(POWERSHELL_RECURSE)],
  ['mavis-trash', matchesAny(/^-\S*r\S*$/i, /^--recursive$/i)],
  ['xcopy', matchesAny(/^\/(?:e|s|t)$/i)],
  ['robocopy', matchesAny(/^\/(?:e|s|mir|purge|move|mov)$/i)],
  ['cp', matchesAny(/^-[A-Za-z]*[rR][A-Za-z]*$/, /^(?:--recursive|-recurse)$/i)],
]);

/**
 * Copy-Item takes whole-word parameters, so POSIX short-flag matching would
 * read `-Force` or `-ErrorAction` as `-r`.
 */
const POWERSHELL_COPY_RECURSIVE_ARGUMENT = matchesAny(POWERSHELL_RECURSE, /^--recursive$/i);

/**
 * A profile can rebind the bare `cp` alias to a native cp, so its GNU
 * recursive clusters (`-rf`, `-fr`) stay recursive as well.
 */
const POWERSHELL_CP_ALIAS_RECURSIVE_ARGUMENT = matchesAny(
  POWERSHELL_RECURSE,
  GNU_CP_RECURSIVE_CLUSTER,
  /^--recursive$/i,
);

/**
 * PowerShell resolves del/erase/rd/rmdir to Remove-Item, so recursion is
 * -Recurse there; `/s` is kept as a conservative signal.
 */
const POWERSHELL_NATIVE_RECURSIVE_ARGUMENT = matchesAny(POWERSHELL_RECURSE, /^\/s$/i);

const NATIVE_OPERAND_COMMANDS: ReadonlySet<string> = new Set(['mkdir', 'md', 'unlink', 'shred']);

const POWERSHELL_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'mkdir',
  'md',
  'new-item',
  'ni',
  'set-content',
  'sc',
  'add-content',
  'ac',
  'set-item',
  'si',
  'out-file',
]);

const POWERSHELL_POSITIONAL_VALUE_COMMANDS: ReadonlySet<string> = new Set([
  'set-content',
  'sc',
  'add-content',
  'ac',
  'set-item',
  'si',
]);

export function isWindowsCopyOption(token: string): boolean {
  return token.startsWith('/') || token.startsWith('-');
}

export function isRecursiveWindowsWriteCommand(
  command: string,
  shellFamily?: ShellFamily,
): boolean {
  const [program, ...args] = tokenizeWindowsCommand(command, shellFamily);
  if (!program) return false;
  const commandName = readWindowsCommandName(program, shellFamily);
  if (WINDOWS_MOVE_COMMANDS.has(commandName.cmdlet)) return true;
  const recursiveArgument = readRecursiveArgumentMatcher(commandName, shellFamily);
  return recursiveArgument !== undefined && args.some(recursiveArgument);
}

function readRecursiveArgumentMatcher(
  { name, cmdlet }: WindowsCommandName,
  shellFamily: ShellFamily | undefined,
): ArgumentMatcher | undefined {
  if (shellFamily === 'powershell' && WINDOWS_NATIVE_DELETE_COMMANDS.has(name)) {
    return POWERSHELL_NATIVE_RECURSIVE_ARGUMENT;
  }
  if (cmdlet === 'copy-item') {
    return name === 'cp'
      ? POWERSHELL_CP_ALIAS_RECURSIVE_ARGUMENT
      : POWERSHELL_COPY_RECURSIVE_ARGUMENT;
  }
  return RECURSIVE_WRITE_ARGUMENTS.get(name);
}

export function isWindowsWriteOrDeleteCommand(command: string, shellFamily?: ShellFamily): boolean {
  const [program] = tokenizeWindowsCommand(command, shellFamily);
  return (
    !!program &&
    WINDOWS_WRITE_OR_DELETE_COMMANDS.has(readWindowsCommandName(program, shellFamily).cmdlet)
  );
}

export function hasWindowsWriteOrDeleteCommand(
  command: string,
  shellFamily?: ShellFamily,
): boolean {
  return expandWindowsCommandSurfacesWithShell(command, { shellFamily }).some((surface) =>
    isWindowsWriteOrDeleteCommand(surface.command, surface.shellFamily),
  );
}

/** A native delete surface needs proven targets; the recoverable rm rewrite is checked elsewhere. */
export function isNativeDeleteSurface(surface: WindowsCommandSurface): boolean {
  const [program] = tokenizeWindowsCommand(surface.command, surface.shellFamily);
  if (!program) return false;
  const name = normalizeWindowsProgramName(program);
  return (
    WINDOWS_NATIVE_DELETE_COMMANDS.has(name) ||
    (name === 'rm' && NATIVE_RM_SHELL_FAMILIES.has(surface.shellFamily))
  );
}

export function resolveWindowsTargets(
  rawTargets: readonly string[] | undefined,
  workspaceDir: string | undefined,
  pathVariables?: PowerShellPathVariables,
): { resolved: string[]; hasDynamicTarget: boolean } {
  if (!rawTargets) return { resolved: [], hasDynamicTarget: true };
  const resolved: string[] = [];
  let hasDynamicTarget = false;
  const workspace = workspaceDir && /^[A-Za-z]:[\\/]/.test(workspaceDir) ? workspaceDir : undefined;
  for (const rawTarget of rawTargets) {
    const expanded = pathVariables
      ? expandPowerShellPathVariable(rawTarget, pathVariables)
      : rawTarget;
    const target = resolveWindowsTarget(expanded, workspace);
    if (target === undefined) hasDynamicTarget = true;
    else resolved.push(target);
  }
  return { resolved, hasDynamicTarget };
}

/** Static values of `$env:TEMP`, `$env:TMP`, `$env:USERPROFILE` and `~`, keyed by lower-case name. */
export type PowerShellPathVariables = ReadonlyMap<string, string>;

const POWERSHELL_PATH_VARIABLE =
  /^(?:\$env:(temp|tmp|userprofile)|\$\{env:(temp|tmp|userprofile)\}|(~))(?=$|[\\/])/i;

/**
 * A script that may rebind one of these values, or quotes one literally,
 * keeps every variable dynamic: assignment, provider paths (`Set-Item env:TEMP`),
 * .NET setters, the FileSystem provider Home, or a single-quoted `$env:`.
 */
const POWERSHELL_PATH_VARIABLE_REBINDS: readonly RegExp[] = [
  /\$\{?\s*env:\s*(?:temp|tmp|userprofile)\s*\}?\s*(?:[-+*/%]|\?\?)?=(?!=)/i,
  /(?<![$\w{])env:/i,
  /SetEnvironmentVariable/i,
  /\.home\b/i,
  /'[^']*\$\{?\s*env:/i,
];

/**
 * Values PowerShell resolves these variables to in the runtime's child shell.
 * `~` follows the FileSystem provider Home, which is USERPROFILE by default.
 */
export function readPowerShellPathVariables(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): PowerShellPathVariables | undefined {
  if (POWERSHELL_PATH_VARIABLE_REBINDS.some((pattern) => pattern.test(command))) return undefined;
  const profile = env.USERPROFILE ?? homedir();
  const values = new Map<string, string>();
  for (const [name, value] of [
    ['temp', env.TEMP],
    ['tmp', env.TMP],
    ['userprofile', profile],
    ['~', profile],
  ] as const) {
    if (value && /^[A-Za-z]:[\\/]/.test(value)) values.set(name, value);
  }
  return values;
}

function expandPowerShellPathVariable(raw: string, variables: PowerShellPathVariables): string {
  const match = POWERSHELL_PATH_VARIABLE.exec(raw);
  const name = (match?.[1] ?? match?.[2] ?? match?.[3])?.toLowerCase();
  const value = name ? variables.get(name) : undefined;
  return match && value ? value + raw.slice(match[0].length) : raw;
}

function resolveWindowsTarget(
  rawTarget: string,
  workspace: string | undefined,
): string | undefined {
  if (/[%$*?`]/.test(rawTarget) || /^~/.test(rawTarget)) return undefined;
  // A rooted path such as `\Windows` still depends on the current drive.
  // Never let win32.resolve use the host process cwd as an implicit fallback.
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(rawTarget)) return path.win32.normalize(rawTarget);
  return workspace ? path.win32.resolve(workspace, rawTarget) : undefined;
}

/** Parse deletion using the executing shell, before applying Windows path policy. */
export function parseWindowsDeleteTargets(
  command: string,
  shellFamily: ShellFamily | undefined,
): { targets: string[]; recursive?: boolean } | undefined {
  // CMD can execute a native rm.exe from PATH. Reuse the same Windows argv
  // parsing as the write-target check so home protection sees those operands too.
  if (shellFamily === 'cmd' && isRmCommand(command)) {
    const targets = parseRmTargets(command, 'win32');
    return targets.length > 0
      ? { targets, recursive: isRecursiveWindowsWriteCommand(command, shellFamily) }
      : undefined;
  }
  if (shellFamily !== 'posix') {
    return parseWindowsNativeDelete(
      command,
      shellFamily === 'cmd' || shellFamily === 'powershell' ? shellFamily : undefined,
    );
  }
  return parsePosixRmTargets(command);
}

function parsePosixRmTargets(
  command: string,
): { targets: string[]; recursive?: boolean } | undefined {
  if (!isRmCommand(command)) return undefined;
  // The shared rm parser has Windows backslash preservation, and the static
  // tokenizer does not model every double-quoted POSIX escape. Refuse these
  // spellings instead of checking a different target from the executed argv.
  if (command.includes('\\') || parseScriptPlainCommands(command)?.length !== 1) return undefined;
  const targets = parseRmTargets(command, 'linux');
  if (targets.length === 0 || targets.some(isUnprovenPosixTarget)) return undefined;
  return { targets, recursive: isRecursiveWindowsWriteCommand(command, 'posix') };
}

/**
 * Git Bash/MSYS mount roots (/c, /usr, ...) are not current-drive roots.
 * Without the executor's mount mapping, no POSIX absolute path is proven.
 * Residual quotes mean rm's Windows-path preservation kept source text
 * such as C:/Win"dows" instead of the POSIX argv. Do not trust that path.
 */
function isUnprovenPosixTarget(target: string): boolean {
  return path.posix.isAbsolute(target) || /[[\]{}*?"']/.test(target) || /^~/.test(target);
}

/**
 * Return the targets that a write/delete command mutates.
 * An unrecognized shape deliberately returns undefined so the caller fails
 * closed instead of treating the command as an in-workspace operation.
 */
export function readWindowsWriteTargets(
  command: string,
  shellFamily: ShellFamily | undefined,
  recoverableRm: boolean,
): string[] | undefined {
  const nativeDelete = parseWindowsDeleteTargets(command, shellFamily);
  if (nativeDelete) return nativeDelete.targets;
  const rm = readWindowsRmTargets(command, shellFamily, recoverableRm);
  if (rm.decided) return rm.targets;
  const trashTargets = parseDirectTrashTargets(command);
  if (trashTargets.length > 0) return trashTargets;

  const [program, ...args] = tokenizeWindowsCommand(command, shellFamily);
  if (!program) return undefined;
  const commandName = readWindowsCommandName(program, shellFamily);
  return WINDOWS_COPY_OR_MOVE_COMMANDS.has(commandName.cmdlet)
    ? readWindowsCopyTargets(commandName, args)
    : readWindowsSimpleWriteTargets(commandName.name, args, shellFamily);
}

/** Decide rm here unless PowerShell/unknown syntax falls through to the generic readers. */
function readWindowsRmTargets(
  command: string,
  shellFamily: ShellFamily | undefined,
  recoverableRm: boolean,
): { decided: boolean; targets?: string[] } {
  if (!isRmCommand(command)) return { decided: false };
  if (shellFamily === 'posix' && !recoverableRm) return { decided: true };
  if (recoverableRm || shellFamily === 'cmd' || shellFamily === undefined) {
    return { decided: true, targets: parseRmTargets(command, 'win32') };
  }
  return { decided: false };
}

function parseDirectTrashTargets(command: string): string[] {
  const [program, ...tokens] = tokenizeWindowsCommand(command);
  if (!program || normalizeWindowsProgramName(program) !== 'mavis-trash') return [];
  const targets: string[] = [];
  let pastDoubleDash = false;
  for (const token of tokens) {
    if (!pastDoubleDash && token === '--') {
      pastDoubleDash = true;
      continue;
    }
    if (!pastDoubleDash && token.startsWith('-')) continue;
    targets.push(token);
  }
  return targets;
}

/** Literal operand forms of directory creation and PowerShell content/item writes. */
function readWindowsSimpleWriteTargets(
  name: string,
  args: string[],
  shellFamily: ShellFamily | undefined,
): string[] | undefined {
  // Do not interpret expansions, arrays, escaped/concatenated quotes, or unknown
  // options as a literal path. The caller keeps its existing fail-closed result.
  if (args.length === 0 || args.some((arg) => /[%!$`*?[\]^{}(),"']/.test(arg))) return undefined;
  if (NATIVE_OPERAND_COMMANDS.has(name) && shellFamily !== 'powershell') {
    return readNativeOperandTargets(args, shellFamily);
  }
  if (shellFamily !== 'powershell' || !POWERSHELL_WRITE_COMMANDS.has(name)) return undefined;
  return readPowerShellWriteTargets(name, args);
}

function readNativeOperandTargets(
  args: string[],
  shellFamily: ShellFamily | undefined,
): string[] | undefined {
  if (shellFamily === 'unknown') return undefined;
  const delimiter = shellFamily === 'posix' ? args.indexOf('--') : -1;
  const options = delimiter < 0 ? args : args.slice(0, delimiter);
  const targets: string[] = [];
  for (const arg of options) {
    if (!/^[-/]/.test(arg)) {
      targets.push(arg);
      continue;
    }
    if (!isSupportedNativeOperandOption(arg, shellFamily)) return undefined;
  }
  if (delimiter >= 0) targets.push(...args.slice(delimiter + 1));
  return targets.length > 0 ? targets : undefined;
}

function isSupportedNativeOperandOption(
  arg: string,
  shellFamily: ShellFamily | undefined,
): boolean {
  return shellFamily === 'posix' && /^(?:-[pfuvz]+|--parents|--verbose|--zero|--remove)$/.test(arg);
}

interface PowerShellWriteOperands {
  readonly paths: string[];
  readonly positional: string[];
  hasValue: boolean;
}

function readPowerShellWriteTargets(name: string, args: string[]): string[] | undefined {
  const operands = readPowerShellWriteOperands(args);
  if (!operands || operands.paths.length > 1) return undefined;
  const { positional } = operands;
  const target = operands.paths[0] ?? positional.shift();
  if (!target) return undefined;
  // Content/item cmdlets can take one positional value after their path. mkdir
  // accepts only paths; keep every one so relative siblings cannot disappear.
  if (name === 'mkdir' || name === 'md') return [target, ...positional];
  return positional.length > allowedPositionalValues(name, operands.hasValue)
    ? undefined
    : [target];
}

function allowedPositionalValues(name: string, hasValue: boolean): number {
  return !hasValue && POWERSHELL_POSITIONAL_VALUE_COMMANDS.has(name) ? 1 : 0;
}

function readPowerShellWriteOperands(args: string[]): PowerShellWriteOperands | undefined {
  const operands: PowerShellWriteOperands = { paths: [], positional: [], hasValue: false };
  for (let index = 0; index < args.length; index += 1) {
    const consumed = readPowerShellArgument(operands, args[index] ?? '', args[index + 1]);
    if (consumed === undefined) return undefined;
    index += consumed;
  }
  return operands;
}

/** Returns how many following arguments an option consumed, or undefined for unsupported syntax. */
function readPowerShellArgument(
  operands: PowerShellWriteOperands,
  arg: string,
  next: string | undefined,
): number | undefined {
  const kind = classifyPowerShellArgument(arg);
  if (kind === 'positional') {
    operands.positional.push(arg);
    return 0;
  }
  if (kind === 'switch') return 0;
  if (!kind || !next || next.startsWith('-')) return undefined;
  if (kind === 'path') operands.paths.push(next);
  if (kind === 'value') operands.hasValue = true;
  return 1;
}

function classifyPowerShellArgument(
  arg: string,
): 'positional' | 'switch' | 'path' | 'value' | 'other' | undefined {
  if (!arg.startsWith('-')) return 'positional';
  if (/^-(?:force|append|noclobber|nonewline|verbose|debug|whatif|confirm)$/i.test(arg)) {
    return 'switch';
  }
  if (/^-(?:path|literalpath|filepath)$/i.test(arg)) return 'path';
  if (/^-(?:value|inputobject)$/i.test(arg)) return 'value';
  if (/^-(?:itemtype|encoding|width|erroraction|warningaction)$/i.test(arg)) return 'other';
  return undefined;
}

function readWindowsCopyTargets(command: WindowsCommandName, args: string[]): string[] | undefined {
  const { name } = command;
  const explicitDestination = readExplicitWindowsDestination(command, args);
  if (explicitDestination.explicit) {
    return explicitDestination.destination ? [explicitDestination.destination] : undefined;
  }
  const positional = args.filter((arg) => !isWindowsCopyOption(arg));
  if (positional.length < 2) return undefined;
  // xcopy / robocopy accept exactly one source followed by one destination.
  // cp / mv and PowerShell copy/move accept multiple sources, so the final
  // positional argument is the only reliable write target.
  const destination = ['xcopy', 'robocopy'].includes(name) ? positional.at(1) : positional.at(-1);
  return destination ? [destination] : undefined;
}

function readWindowsMoveSourceTargets(
  command: string,
  shellFamily: ShellFamily | undefined,
): string[] | undefined {
  const [program, ...args] = tokenizeWindowsCommand(command);
  if (!program) return undefined;
  const commandName = readWindowsCommandName(program, shellFamily);
  const { name } = commandName;
  if (!isWindowsMoveCommand(commandName.cmdlet, args)) return [];

  const explicitDestination = readExplicitWindowsDestination(commandName, args);
  const positional = readWindowsMovePositionals(commandName, args);
  if (name === 'robocopy') return positional[0] ? [positional[0]] : undefined;
  if (explicitDestination.explicit) return positional.length > 0 ? positional : undefined;
  return positional.length >= 2 ? positional.slice(0, -1) : undefined;
}

/**
 * A PowerShell Move-Item whose every source is a literal existing file is not
 * a recursive write. A directory, wildcard or unresolved source stays recursive.
 */
export function isSingleFileMove(
  surface: WindowsCommandSurface,
  workspaceDir: string | undefined,
): boolean {
  if (surface.shellFamily !== 'powershell') return false;
  const [program] = tokenizeWindowsCommand(surface.command, surface.shellFamily);
  if (!program || readWindowsCommandName(program, 'powershell').cmdlet !== 'move-item')
    return false;
  const sources = readWindowsMoveSourceTargets(surface.command, surface.shellFamily);
  if (!sources || sources.length === 0 || sources.some((source) => /[[\]]/.test(source)))
    return false;
  const resolved = resolveWindowsTargets(sources, surface.cwdChanged ? undefined : workspaceDir);
  return !resolved.hasDynamicTarget && resolved.resolved.every(isExistingFile);
}

function isExistingFile(target: string): boolean {
  // statSync on an unreachable UNC share blocks the runtime until the SMB
  // timeout; such a source keeps the recursive (pre-existing) treatment.
  if (/^[\\/]{2}/.test(target)) return false;
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Copy-Item / Move-Item (and their bare aliases) only add or relocate data, so
 * an out-of-workspace destination needs confirmation rather than a hard stop.
 */
export function isPowerShellCopyOrMoveItem(
  command: string,
  shellFamily: ShellFamily | undefined,
): boolean {
  if (shellFamily !== 'powershell') return false;
  const [program] = tokenizeWindowsCommand(command, shellFamily);
  return (
    !!program &&
    ['copy-item', 'move-item'].includes(readWindowsCommandName(program, shellFamily).cmdlet)
  );
}

function isWindowsMoveCommand(name: string, args: string[]): boolean {
  return (
    WINDOWS_MOVE_COMMANDS.has(name) ||
    (name === 'robocopy' && args.some((arg) => /^\/(?:move|mov)$/i.test(arg)))
  );
}

function readWindowsMovePositionals(
  command: WindowsCommandName,
  args: string[],
  powerShellPaths = false,
): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    // A PowerShell cmdlet takes /tmp/x as a path; only - starts its parameters.
    const skip =
      powerShellPaths && arg.startsWith('/') ? undefined : windowsMoveOptionSkip(command, arg);
    if (skip === 'consume-next') {
      index += 1;
      continue;
    }
    if (skip === 'skip') continue;
    positional.push(arg);
  }
  return positional;
}

/**
 * A bare PowerShell `mv` is Move-Item but a profile can rebind it to a native
 * mv, so both option spellings are honored.
 */
function windowsMoveOptionSkip(
  { name, cmdlet }: WindowsCommandName,
  arg: string,
): 'consume-next' | 'skip' | undefined {
  if (name === 'mv' && ['-t', '--target-directory'].includes(arg)) return 'consume-next';
  if (name === 'mv' && /^(?:-t(?:=)?|--target-directory=)/i.test(arg)) return 'skip';
  if (cmdlet === 'move-item' && /^-destination$/i.test(arg)) return 'consume-next';
  if (cmdlet === 'move-item' && /^-destination(?::|=)/i.test(arg)) return 'skip';
  return isWindowsCopyOption(arg) ? 'skip' : undefined;
}

/**
 * A move deletes its source after producing its destination. Copy permits a
 * protected source to be read into the workspace, but move/robocopy /MOVE
 * must protect both sides of the operation.
 */
export function readWindowsPathSafetyTargets(
  command: string,
  shellFamily: ShellFamily | undefined,
  recoverableRm: boolean,
): string[] | undefined {
  const writeTargets = readWindowsWriteTargets(command, shellFamily, recoverableRm);
  if (!writeTargets) return undefined;
  const moveSourceTargets = readWindowsMoveSourceTargets(command, shellFamily);
  if (moveSourceTargets === undefined) return undefined;
  return [...writeTargets, ...moveSourceTargets];
}

/** The sources and destination of a copy or move, and whether it moves its sources away. */
export interface WindowsCopyOrMoveOperands {
  readonly move: boolean;
  readonly sources: readonly string[];
  readonly destination: string | undefined;
}

/**
 * Operands of a copy or move command (copy, xcopy, robocopy, cp, mv, move,
 * Copy-Item, Move-Item and their aliases), read with the same option rules as
 * the write and move-source readers. For PowerShell cmdlets an argument that
 * starts with / is a path, as PowerShell reads it, not a cmd switch.
 */
export function readWindowsCopyOrMoveOperands(
  command: string,
  shellFamily: ShellFamily | undefined,
): WindowsCopyOrMoveOperands | undefined {
  const [program, ...args] = tokenizeWindowsCommand(command, shellFamily);
  if (!program) return undefined;
  const commandName = readWindowsCommandName(program, shellFamily);
  if (!WINDOWS_COPY_OR_MOVE_COMMANDS.has(commandName.cmdlet)) return undefined;
  const powerShellPaths = ['copy-item', 'move-item'].includes(commandName.cmdlet);
  const positional = readWindowsMovePositionals(commandName, args, powerShellPaths);
  const explicit = readExplicitWindowsDestination(commandName, args);
  const move = isWindowsMoveCommand(commandName.cmdlet, args);
  if (explicit.explicit) return { move, sources: positional, destination: explicit.destination };
  // xcopy and robocopy take one source and then one destination.
  if (['xcopy', 'robocopy'].includes(commandName.name)) {
    return { move, sources: positional.slice(0, 1), destination: positional[1] };
  }
  if (positional.length < 2) return { move, sources: positional, destination: undefined };
  return { move, sources: positional.slice(0, -1), destination: positional.at(-1) };
}

type ExplicitWindowsDestination = { explicit: false } | { explicit: true; destination?: string };

/**
 * Read copy/move destination flags before falling back to a positional
 * destination. A missing or malformed explicit destination deliberately
 * returns `undefined` to the caller so the recursive write is fail-closed.
 */
function readExplicitWindowsDestination(
  command: WindowsCommandName,
  args: string[],
): ExplicitWindowsDestination {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    const destination = readExplicitWindowsDestinationAt(command, arg, args[index + 1]);
    if (destination) return destination;
  }
  return { explicit: false };
}

function explicitWindowsDestination(nextArg: string | undefined): ExplicitWindowsDestination {
  return {
    explicit: true,
    ...(nextArg && !isWindowsCopyOption(nextArg) ? { destination: nextArg } : {}),
  };
}

/** A bare PowerShell cp/mv honors both the GNU `-t` and the cmdlet `-Destination` spellings. */
function readExplicitWindowsDestinationAt(
  { name, cmdlet }: WindowsCommandName,
  arg: string,
  nextArg: string | undefined,
): ExplicitWindowsDestination | undefined {
  if (['cp', 'mv'].includes(name)) {
    if (arg === '-t' || arg === '--target-directory') {
      return explicitWindowsDestination(nextArg);
    }
    const shortTarget = /^-t(?:=)?(.+)$/.exec(arg);
    const longTarget = /^--target-directory=(.+)$/i.exec(arg);
    const destination = shortTarget?.[1] ?? longTarget?.[1];
    if (destination !== undefined) return { explicit: true, destination };
  }

  if (['copy-item', 'move-item'].includes(cmdlet)) {
    if (/^-destination$/i.test(arg)) {
      return explicitWindowsDestination(nextArg);
    }
    const inlineDestination = /^-destination(?::|=)(.+)$/i.exec(arg)?.[1];
    if (inlineDestination !== undefined) return { explicit: true, destination: inlineDestination };
  }
  return undefined;
}
