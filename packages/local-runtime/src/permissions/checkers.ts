import { homedir } from 'node:os';
import path from 'node:path';

import {
  isRmCommand,
  parseRmTargets,
  parseScriptPlainCommands,
  parseWindowsNativeDelete,
  resolvePermissionPath,
  splitCommand,
  splitShellSourceSegments,
  unwrapCommandWrappers,
  type ShellFamily,
} from '@mavis/permission';
import { shellSourceStages } from '@mavis/shared/shell-source-stages';

export type LocalPermissionCheckerBehavior = 'deny' | 'ask';

/**
 * Distinguishes two flavours of local deny so the facade can honour
 * `bypassPermissions` ('Always allow'):
 *
 *   - `bypass-immune` — UNC/SMB share access + recursive deletion of root /
 *     home directories. Stays a deny across every askPolicy because no user
 *     toggle should make these reachable.
 *
 *   - `policy` — sensitive credential paths (`~/.ssh`, `~/.aws`, `*.pem`, …).
 *     These route to the LLM gate / user confirmation, not a flat
 *     deny. The facade demotes a `policy` deny to ask under default/auto
 *     so the cloud gateway or the user can clear it; under bypass we let
 *     the engine's own allow-lists take over.
 *
 * Asks ride this same channel — they were never bypass-immune.
 */
export type LocalPermissionDenyKind = 'bypass-immune' | 'policy';

export interface LocalPermissionCheckerResult {
  behavior: LocalPermissionCheckerBehavior;
  reason: string;
  /** Only meaningful when `behavior === 'deny'`. */
  denyKind?: LocalPermissionDenyKind;
}

export interface LocalPermissionCheckerInput {
  toolName: string;
  input: Record<string, unknown>;
  workspaceDir?: string;
  platform?: NodeJS.Platform;
  /** Only skips Windows path policy; the remaining local checks still run. */
  skipWindowsHardSafetyChecks?: boolean;
  shellFamily?: ShellFamily;
  /** Trusted caller guarantees top-level rm goes through the recoverable rewrite. */
  recoverableRm?: boolean;
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

function resolveWindowsTargets(
  rawTargets: readonly string[] | undefined,
  workspaceDir: string | undefined,
): { resolved: string[]; hasDynamicTarget: boolean } {
  if (!rawTargets) return { resolved: [], hasDynamicTarget: true };
  const resolved: string[] = [];
  let hasDynamicTarget = false;
  const workspace = workspaceDir && /^[A-Za-z]:[\\/]/.test(workspaceDir) ? workspaceDir : undefined;
  for (const rawTarget of rawTargets) {
    // A rooted path such as `\Windows` still depends on the current drive.
    // Never let win32.resolve use the host process cwd as an implicit fallback.
    const fullyQualified = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(rawTarget);
    if (/[%$*?`]/.test(rawTarget) || /^~/.test(rawTarget) || (!fullyQualified && !workspace)) {
      hasDynamicTarget = true;
      continue;
    }
    resolved.push(
      fullyQualified ? path.win32.normalize(rawTarget) : path.win32.resolve(workspace!, rawTarget),
    );
  }
  return { resolved, hasDynamicTarget };
}

function isRecursiveWindowsWriteCommand(command: string, shellFamily?: ShellFamily): boolean {
  const [program, ...args] = tokenizeWindowsCommand(command, shellFamily);
  if (!program) return false;
  const name = normalizeWindowsProgramName(program);
  if (name === 'rm') return args.some((arg) => /^-\S*r/i.test(arg));
  // PowerShell resolves del/erase/rd/rmdir to Remove-Item, so recursion is
  // -Recurse there; `/s` is kept as a conservative signal.
  if (shellFamily === 'powershell' && WINDOWS_NATIVE_DELETE_COMMANDS.has(name)) {
    return args.some((arg) => /^(?:-recurse|-r|\/s)$/i.test(arg));
  }
  if (['rmdir', 'rd'].includes(name)) return args.some((arg) => /^\/s$/i.test(arg));
  if (['remove-item', 'ri', 'remove'].includes(name)) {
    return args.some((arg) => /^(?:-recurse|-r)$/i.test(arg));
  }
  if (name === 'mavis-trash') {
    return args.some((arg) => /^-\S*r\S*$/i.test(arg) || /^--recursive$/i.test(arg));
  }
  if (name === 'xcopy') return args.some((arg) => /^\/(?:e|s|t)$/i.test(arg));
  if (name === 'robocopy') {
    return args.some((arg) => /^\/(?:e|s|mir|purge|move|mov)$/i.test(arg));
  }
  if (['move', 'mv', 'move-item'].includes(name)) return true;
  return (
    ['cp', 'copy-item'].includes(name) &&
    args.some(
      (arg) => /^-[A-Za-z]*[rR][A-Za-z]*$/.test(arg) || /^(?:--recursive|-recurse)$/i.test(arg),
    )
  );
}

const WINDOWS_NATIVE_DELETE_COMMANDS = new Set([
  'del',
  'erase',
  'rd',
  'rmdir',
  'remove-item',
  'ri',
  'remove',
]);

const WINDOWS_WRITE_OR_DELETE_COMMANDS = new Set([
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

function isWindowsWriteOrDeleteCommand(command: string, shellFamily?: ShellFamily): boolean {
  const [program] = tokenizeWindowsCommand(command, shellFamily);
  return !!program && WINDOWS_WRITE_OR_DELETE_COMMANDS.has(normalizeWindowsProgramName(program));
}

export function hasWindowsWriteOrDeleteCommand(
  command: string,
  shellFamily?: ShellFamily,
): boolean {
  return expandWindowsCommandSurfacesWithShell(command, shellFamily).some((surface) =>
    isWindowsWriteOrDeleteCommand(surface.command, surface.shellFamily),
  );
}

/**
 * Fully expand a shell surface into the individual executable-command
 * candidates that must each be inspected: split into segments, unwrap
 * transparent shell wrappers (`cmd /c "…"`, `powershell -Command "…"`,
 * `bash -c "…"`, `nohup`, `setsid`, `timeout`, …) at every depth, then
 * split again so a wrapper payload with embedded `&&`/`|`/`;` chains is
 * observed segment-by-segment. Callers filter this list by whatever
 * predicate they need (`isDeleteLikeCommand`, `isWindowsWriteOrDeleteCommand`,
 * `matchHardBlockedBash`, …) without duplicating the traversal.
 */
export function expandWindowsCommandSurfaces(command: string): string[] {
  return splitWindowsCommandSegments(command).flatMap((segment) =>
    unwrapCommandWrappers(segment).flatMap(splitWindowsCommandSegments),
  );
}

export function parseWindowsShellFamily(command: string): 'cmd' | 'powershell' | undefined {
  const [program] = tokenizeWindowsCommand(command);
  if (!program) return undefined;
  const name = normalizeWindowsProgramName(program);
  if (name === 'cmd') return 'cmd';
  if (name === 'powershell' || name === 'pwsh') return 'powershell';
  return undefined;
}

interface WindowsCommandSurface {
  command: string;
  shellFamily: LocalPermissionCheckerInput['shellFamily'];
  recoverableRm: boolean;
  /** Whether this shell's entry cwd has already become untrusted at this stage. */
  cwdChanged: boolean;
  redirectionTargets: string[];
}

function isWindowsCwdChange(command: string, shellFamily?: ShellFamily): boolean {
  const tokens = tokenizeWindowsCommand(command, shellFamily);
  // Unlike process wrappers, POSIX `command cd` runs the builtin in this shell.
  while (tokens[0] === 'command') {
    tokens.shift();
    while (/^(?:-p|--)$/.test(tokens[0] ?? '')) tokens.shift();
  }
  return /^(?:(?:cd|chdir)(?:$|[.\\/])|pushd$|popd$|set-location$|sl$|push-location$|pop-location$|[A-Za-z]:$)/i.test(
    tokens[0] ?? '',
  );
}

function expandWindowsCommandSurfacesWithShell(
  command: string,
  shellFamily?: LocalPermissionCheckerInput['shellFamily'],
  recoverableRm = false,
  depth = 0,
  cwdChanged = false,
): WindowsCommandSurface[] {
  const sourceStages =
    shellFamily === 'posix'
      ? splitShellSourceSegments(command)
      : splitWindowsCommandSource(command, true);
  const stages = shellFamily === 'posix' ? splitCommand(command) : sourceStages;
  // A loop or jump can execute an earlier write again after a later cd. Scan
  // inside unquoted blocks too, while quoted text and wrapper payloads stay
  // opaque. This only selects a conservative cwd fallback, not an execution AST.
  const controlStages = sourceStages.flatMap((stage) =>
    splitWindowsCommandSource(stage, true, true),
  );
  const mayRepeat = controlStages.some((stage) =>
    /^(?:for|foreach|while|until|do|goto)\b/i.test(stage),
  );
  let previousCwdChange =
    cwdChanged ||
    (mayRepeat && controlStages.some((stage) => isWindowsCwdChange(stage, shellFamily)));
  return stages.flatMap((stage) => {
    const stageCwdChanged = previousCwdChange;
    const segments = shellFamily === 'posix' ? [stage] : splitWindowsCommandSegments(stage);
    // Redirects use the cwd before the command executes. A filename after `>`
    // is not a command and must not itself be interpreted as a location change.
    previousCwdChange ||= isWindowsCwdChange(segments[0] ?? '', shellFamily);
    return segments.flatMap((segment, index) => {
      const rewritableRm = recoverableRm && isRmCommand(segment);
      const surface: WindowsCommandSurface = {
        command: segment,
        shellFamily,
        recoverableRm: rewritableRm,
        cwdChanged: stageCwdChanged,
        redirectionTargets: index === 0 ? readWindowsRedirectionTargets(stage) : [],
      };
      // Peel one layer at a time, splitting its payload before the next unwrap.
      // Each alternative payload inherits this stage's entry cwd independently;
      // child-shell location changes never leak into its parent or siblings.
      if (depth >= 8) return [surface];
      const innerShell =
        parseWindowsShellFamily(segment) ?? (isRmCommand(segment) ? shellFamily : 'unknown');
      const surfaces: WindowsCommandSurface[] = [surface];
      const candidates = new Set(unwrapCommandWrappers(segment).slice(1));
      for (const inner of candidates) {
        // The existing unwrap also includes descendants and alternative decoded
        // payloads. Visit descendants through their parent so their shell is kept.
        for (const descendant of unwrapCommandWrappers(inner).slice(1)) {
          candidates.delete(descendant);
        }
        surfaces.push(
          ...expandWindowsCommandSurfacesWithShell(
            inner,
            innerShell,
            rewritableRm,
            depth + 1,
            stageCwdChanged,
          ),
        );
      }
      return surfaces;
    });
  });
}

/** Parse deletion using the executing shell, before applying Windows path policy. */
function parseWindowsDeleteTargets(
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
  if (!isRmCommand(command)) return undefined;
  // The shared rm parser has Windows backslash preservation, and the static
  // tokenizer does not model every double-quoted POSIX escape. Refuse these
  // spellings instead of checking a different target from the executed argv.
  if (command.includes('\\') || parseScriptPlainCommands(command)?.length !== 1) return undefined;
  const targets = parseRmTargets(command, 'linux');
  if (
    targets.length === 0 ||
    targets.some(
      // Git Bash/MSYS mount roots (/c, /usr, ...) are not current-drive roots.
      // Without the executor's mount mapping, no POSIX absolute path is proven.
      // Residual quotes mean rm's Windows-path preservation kept source text
      // such as C:/Win"dows" instead of the POSIX argv. Do not trust that path.
      (target) => path.posix.isAbsolute(target) || /[[\]{}*?"']/.test(target) || /^~/.test(target),
    )
  )
    return undefined;
  return { targets, recursive: isRecursiveWindowsWriteCommand(command, shellFamily) };
}

/**
 * Return the targets that a write/delete command mutates.
 * An unrecognized shape deliberately returns undefined so the caller fails
 * closed instead of treating the command as an in-workspace operation.
 */
function readWindowsWriteTargets(
  command: string,
  shellFamily: LocalPermissionCheckerInput['shellFamily'],
  recoverableRm: boolean,
): string[] | undefined {
  const nativeDelete = parseWindowsDeleteTargets(command, shellFamily);
  if (nativeDelete) return nativeDelete.targets;
  if (shellFamily === 'posix' && !recoverableRm && isRmCommand(command)) return undefined;
  if (
    isRmCommand(command) &&
    (recoverableRm || shellFamily === 'cmd' || shellFamily === undefined)
  ) {
    return parseRmTargets(command, 'win32');
  }
  const trashTargets = parseDirectTrashTargets(command);
  if (trashTargets.length > 0) return trashTargets;

  const [program, ...args] = tokenizeWindowsCommand(command, shellFamily);
  if (!program) return undefined;
  const name = normalizeWindowsProgramName(program);
  if (!['copy', 'xcopy', 'robocopy', 'cp', 'copy-item', 'move', 'mv', 'move-item'].includes(name)) {
    return readWindowsSimpleWriteTargets(name, args, shellFamily);
  }
  const explicitDestination = readExplicitWindowsDestination(program, args);
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

/** Literal operand forms of directory creation and PowerShell content/item writes. */
function readWindowsSimpleWriteTargets(
  name: string,
  args: string[],
  shellFamily: ShellFamily | undefined,
): string[] | undefined {
  // Do not interpret expansions, arrays, escaped/concatenated quotes, or unknown
  // options as a literal path. The caller keeps its existing fail-closed result.
  if (args.length === 0 || args.some((arg) => /[%!$`*?[\]^{}(),"']/.test(arg))) return undefined;
  if (['mkdir', 'md', 'unlink', 'shred'].includes(name) && shellFamily !== 'powershell') {
    if (shellFamily === 'unknown') return undefined;
    const targets: string[] = [];
    let pastDoubleDash = false;
    for (const arg of args) {
      if (shellFamily === 'posix' && !pastDoubleDash && arg === '--') {
        pastDoubleDash = true;
      } else if (!pastDoubleDash && /^[-/]/.test(arg)) {
        if (
          shellFamily !== 'posix' ||
          !/^(?:-[pfuvz]+|--parents|--verbose|--zero|--remove)$/.test(arg)
        ) {
          return undefined;
        }
      } else {
        targets.push(arg);
      }
    }
    return targets.length > 0 ? targets : undefined;
  }
  if (
    shellFamily !== 'powershell' ||
    ![
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
    ].includes(name)
  )
    return undefined;

  let target: string | undefined;
  const positional: string[] = [];
  let hasValue = false;
  const operands = args.values();
  for (const arg of operands) {
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (/^-(?:force|append|noclobber|nonewline|verbose|debug|whatif|confirm)$/i.test(arg)) continue;
    const pathOption = /^-(?:path|literalpath|filepath)$/i.test(arg);
    const valueOption = /^-(?:value|inputobject)$/i.test(arg);
    if (
      !pathOption &&
      !valueOption &&
      !/^-(?:itemtype|encoding|width|erroraction|warningaction)$/i.test(arg)
    ) {
      return undefined;
    }
    const value = operands.next().value;
    if (!value || value.startsWith('-')) return undefined;
    if (pathOption) {
      if (target !== undefined) return undefined;
      target = value;
    }
    if (valueOption) hasValue = true;
  }
  target ??= positional.shift();
  // Content/item cmdlets can take one positional value after their path. mkdir
  // accepts only paths; keep every one so relative siblings cannot disappear.
  if (name === 'mkdir' || name === 'md') return target ? [target, ...positional] : undefined;
  const acceptsPositionalValue =
    !hasValue && ['set-content', 'sc', 'add-content', 'ac', 'set-item', 'si'].includes(name);
  if (positional.length > (acceptsPositionalValue ? 1 : 0)) return undefined;
  return target ? [target] : undefined;
}

function readWindowsMoveSourceTargets(command: string): string[] | undefined {
  const [program, ...args] = tokenizeWindowsCommand(command);
  if (!program) return undefined;
  const name = normalizeWindowsProgramName(program);
  const isRobocopyMove = name === 'robocopy' && args.some((arg) => /^\/(?:move|mov)$/i.test(arg));
  if (!['move', 'mv', 'move-item'].includes(name) && !isRobocopyMove) return [];

  const explicitDestination = readExplicitWindowsDestination(program, args);
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    // Only `mv` reaches this branch (the outer guard filters to move-family
    // commands + robocopy /MOVE), so we consume mv's target-directory flag
    // pair here. cp is handled by readWindowsWriteTargets, not here.
    if (name === 'mv' && (arg === '-t' || arg === '--target-directory')) {
      index += 1;
      continue;
    }
    if (name === 'mv' && /^(?:-t(?:=)?|--target-directory=)/i.test(arg)) {
      continue;
    }
    if (name === 'move-item' && /^-destination$/i.test(arg)) {
      index += 1;
      continue;
    }
    if (name === 'move-item' && /^-destination(?::|=)/i.test(arg)) continue;
    if (isWindowsCopyOption(arg)) continue;
    positional.push(arg);
  }

  if (name === 'robocopy') return positional[0] ? [positional[0]] : undefined;
  if (explicitDestination.explicit) return positional.length > 0 ? positional : undefined;
  return positional.length >= 2 ? positional.slice(0, -1) : undefined;
}

/**
 * A move deletes its source after producing its destination. Copy permits a
 * protected source to be read into the workspace, but move/robocopy /MOVE
 * must protect both sides of the operation.
 */
function readWindowsPathSafetyTargets(
  command: string,
  shellFamily: LocalPermissionCheckerInput['shellFamily'],
  recoverableRm: boolean,
): string[] | undefined {
  const writeTargets = readWindowsWriteTargets(command, shellFamily, recoverableRm);
  if (!writeTargets) return undefined;
  const moveSourceTargets = readWindowsMoveSourceTargets(command);
  if (moveSourceTargets === undefined) return undefined;
  return [...writeTargets, ...moveSourceTargets];
}

/**
 * Split a shell surface at executable command boundaries before interpreting
 * copy/move arguments. A following `&& echo`, pipeline, or redirection is
 * not an argument of the preceding write command. Quoted separators remain
 * literal so normal quoted paths are preserved.
 */
export function splitWindowsCommandSegments(command: string): string[] {
  return splitWindowsCommandSource(command, false);
}

/** Keep redirects attached for cwd tracking; optionally expose block control words. */
function splitWindowsCommandSource(
  command: string,
  preserveRedirections: boolean,
  splitBlocks = false,
): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === quote) {
      quote = undefined;
      continue;
    }
    if (!quote && (character === '"' || character === "'")) {
      quote = character;
      continue;
    }
    // CMD's caret and PowerShell's backtick quote the immediately following
    // character. Consume a complete CRLF continuation so its LF cannot become
    // a separate command boundary and detach the real destination.
    if (character === '^' || character === '`') {
      index += command[index + 1] === '\r' && command[index + 2] === '\n' ? 2 : 1;
      continue;
    }
    if (
      !quote &&
      ((character === '&' && !(preserveRedirections && command[index - 1] === '>')) ||
        character === '|' ||
        character === ';' ||
        (character === '>' && !preserveRedirections) ||
        (splitBlocks && /[(){}]/.test(character ?? '')) ||
        character === '\n' ||
        character === '\r')
    ) {
      const segment = command.slice(start, index).trim();
      if (segment) segments.push(segment);
      // Treat CRLF as one command boundary. A backtick/caret immediately before
      // the newline was already consumed above, so shell continuations remain
      // part of the same surface.
      start = character === '\r' && command[index + 1] === '\n' ? index + 2 : index + 1;
      if (character === '\r' && command[index + 1] === '\n') index += 1;
    }
  }

  const trailing = command.slice(start).trim();
  if (trailing) segments.push(trailing);
  return segments;
}

/**
 * Reads redirect destinations before command segmentation discards the
 * operator. The caller applies normal protected-path checks to each target.
 */
function readWindowsRedirectionTargets(command: string): string[] {
  const targets: string[] = [];
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === quote) {
      quote = undefined;
      continue;
    }
    if (!quote && (character === '"' || character === "'")) {
      quote = character;
      continue;
    }
    if (character === '^' || character === '`') {
      index += 1;
      continue;
    }
    if (quote || character !== '>') continue;

    let targetStart = index + 1;
    if (command[targetStart] === '>') targetStart += 1;
    while (/\s/.test(command[targetStart] ?? '')) targetStart += 1;
    if (!command[targetStart] || command[targetStart] === '&') continue;

    const targetQuote = command[targetStart];
    let targetEnd = targetStart;
    if (targetQuote === '"' || targetQuote === "'") {
      targetStart += 1;
      targetEnd = targetStart;
      while (targetEnd < command.length && command[targetEnd] !== targetQuote) targetEnd += 1;
    } else {
      while (targetEnd < command.length && !/[\s;&|<>]/.test(command[targetEnd] ?? '')) {
        targetEnd += 1;
      }
    }
    const target = command.slice(targetStart, targetEnd);
    if (target) targets.push(target);
    // Skip the closing quote as well; otherwise it would be interpreted as
    // the beginning of a new quoted region on the next scanner iteration.
    index = targetQuote === '"' || targetQuote === "'" ? targetEnd : targetEnd - 1;
  }

  return targets;
}

export function hasWindowsWriteRedirection(command: string): boolean {
  // Scan the raw command's wrapper unwraps AND each top-level segment's
  // wrapper unwraps to detect writes hidden inside chained wrappers.
  // Redirect target extraction depends on `>` being present in the surface,
  // so we cannot feed it post-split surfaces (which discard `>`).
  const scanTargets = new Set<string>([
    ...unwrapCommandWrappers(command),
    ...splitWindowsCommandSegments(command).flatMap(unwrapCommandWrappers),
  ]);
  for (const surface of scanTargets) {
    if (readWindowsRedirectionTargets(surface).length > 0) return true;
  }
  return false;
}

function tokenizeWindowsCommand(command: string, shellFamily?: ShellFamily): string[] {
  if (shellFamily === 'posix') {
    const parsed = parseScriptPlainCommands(command);
    if (parsed?.length === 1) return parsed[0] ?? [];
    // Keep an rm with dynamic operands visible to the fail-closed target parser.
    if (isRmCommand(command)) return ['rm'];
  }
  const tokens: string[] = [];
  const tokenPattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(tokenPattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

function normalizeWindowsProgramName(program: string): string {
  return path.win32
    .basename(program)
    .replace(/\.(?:exe|cmd|bat)$/i, '')
    .toLowerCase();
}

function isWindowsCopyOption(token: string): boolean {
  return token.startsWith('/') || token.startsWith('-');
}

type ExplicitWindowsDestination = { explicit: false } | { explicit: true; destination?: string };

/**
 * Read copy/move destination flags before falling back to a positional
 * destination. A missing or malformed explicit destination deliberately
 * returns `undefined` to the caller so the recursive write is fail-closed.
 */
function readExplicitWindowsDestination(
  program: string,
  args: string[],
): ExplicitWindowsDestination {
  const name = normalizeWindowsProgramName(program);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (['cp', 'mv'].includes(name)) {
      if (arg === '-t' || arg === '--target-directory') {
        const destination = args[index + 1];
        return {
          explicit: true,
          ...(destination && !isWindowsCopyOption(destination) ? { destination } : {}),
        };
      }
      const shortTarget = /^-t(?:=)?(.+)$/.exec(arg);
      const longTarget = /^--target-directory=(.+)$/i.exec(arg);
      const destination = shortTarget?.[1] ?? longTarget?.[1];
      if (destination !== undefined) return { explicit: true, destination };
    }

    if (['copy-item', 'move-item'].includes(name)) {
      if (/^-destination$/i.test(arg)) {
        const destination = args[index + 1];
        return {
          explicit: true,
          ...(destination && !isWindowsCopyOption(destination) ? { destination } : {}),
        };
      }
      const inlineDestination = /^-destination(?::|=)(.+)$/i.exec(arg)?.[1];
      if (inlineDestination !== undefined)
        return { explicit: true, destination: inlineDestination };
    }
  }
  return { explicit: false };
}

/**
 * Detect protected Windows directories directly from the command surface.
 *
 * Do not rely solely on the generic absolute-path collector below: it may
 * start at an absolute source and consume the whitespace plus a later
 * absolute destination. That would make `copy C:\\source C:\\Windows\\...`
 * look like one ordinary source path. This matcher starts at every command
 * boundary, so every protected destination is independently visible even
 * when a preceding source is absolute or the target contains spaces.
 */
function findProtectedWindowsPath(value: string): string | undefined {
  // `path.win32.normalize` is required before matching a protected root:
  // `C:\\project\\..\\..\\Windows` is an absolute Windows path even though it
  // does not lexically start with `C:\\Windows`. Scan both the complete value
  // (for a direct target) and absolute path fragments (for a command surface).
  const absolutePathFragments = value.match(/(?:\\\\\?\\)?[A-Za-z]:[\\/][^\s"';&|<>]*/gi) ?? [];
  for (const candidate of [value, ...absolutePathFragments]) {
    const normalizedCandidate = canonicalizeWindowsAbsolutePath(candidate);
    const match =
      /(?:^|[\s"';&|<>])((?:\\\\\?\\)?[A-Za-z]:[\\/](?:windows|program files(?: \(x86\))?)(?:[\\/]|$))/i.exec(
        normalizedCandidate,
      );
    if (match) return match[1];
  }

  // Environment-variable and drive-relative spellings can resolve to a
  // protected directory without containing a literal absolute drive path.
  // Fail closed on these known protected roots rather than relying on CMD's
  // per-drive current-directory semantics.
  //
  // Recognized forms (all case-insensitive):
  //   CMD:         %SystemRoot%, %windir%, %ProgramFiles%,
  //                %ProgramFiles(x86)%, %ProgramW6432%,
  //                %CommonProgramFiles%, %CommonProgramFiles(x86)%,
  //                %SystemDrive%\Windows, %SystemDrive%\Program Files,
  //                %SystemDrive%\Program Files (x86)
  //   PowerShell:  $env:SystemRoot, $env:windir, $env:ProgramFiles,
  //                $env:ProgramW6432, $env:CommonProgramFiles,
  //                $env:SystemDrive\Windows / Program Files
  //   PowerShell braced: ${env:SystemRoot}, ${env:windir}, ${env:ProgramFiles},
  //                ${env:ProgramFiles(x86)}, ${env:ProgramW6432},
  //                ${env:CommonProgramFiles}, ${env:CommonProgramFiles(x86)},
  //                ${env:SystemDrive}\Windows / Program Files
  //     — PowerShell requires braces for identifiers containing `(` `)`;
  //       ${env:ProgramFiles(x86)} was the concrete gap Codex Review flagged.
  //   Drive-relative literal: C:Windows, C:Program Files (drive-current-dir),
  //     which CMD resolves against the drive's per-process working directory —
  //     we cannot reconstruct that safely, so any of those spellings is
  //     rejected up-front.
  const protectedNames = String.raw`systemroot|windir|programfiles(?:\(x86\))?|programw6432|commonprogramfiles(?:\(x86\))?`;
  const symbolicPath = new RegExp(
    // group 1 = the offending path fragment
    String.raw`(?:^|[\s"';&|<>])(` +
      // %CMD_ENV%
      String.raw`(?:%(?:${protectedNames})%` +
      // %SystemDrive%\Windows or %SystemDrive%\Program Files ...
      String.raw`|%systemdrive%[\\/](?:windows|program files(?: \(x86\))?)` +
      // $env:VAR  (unbraced PowerShell env var — cannot express names with `(`)
      String.raw`|\$env:(?:${protectedNames})` +
      // $env:SystemDrive\Windows or Program Files ...
      String.raw`|\$env:systemdrive[\\/](?:windows|program files(?: \(x86\))?)` +
      // ${env:VAR}  (braced PowerShell env var — the ONLY form that can
      // express ProgramFiles(x86); allow leading/trailing whitespace inside
      // the braces because PowerShell tolerates it)
      String.raw`|\$\{\s*env:\s*(?:${protectedNames})\s*\}` +
      // ${env:SystemDrive}\Windows or Program Files ...
      String.raw`|\$\{\s*env:\s*systemdrive\s*\}[\\/](?:windows|program files(?: \(x86\))?)` +
      // Drive-relative literal `C:Windows` / `C:Program Files ...`
      String.raw`|[A-Za-z]:(?:windows|program files(?: \(x86\))?)` +
      String.raw`)(?:[\\/]|$))`,
    'i',
  );
  return symbolicPath.exec(value)?.[1];
}

function findAmbiguousProgramFilesWriteTarget(command: string): string | undefined {
  const [program, ...args] = tokenizeWindowsCommand(command);
  if (
    !program ||
    !['copy', 'cp', 'xcopy', 'robocopy', 'move', 'mv'].includes(
      normalizeWindowsProgramName(program),
    )
  ) {
    return undefined;
  }

  // An unquoted `C:\\Program Files\\...` destination is split by CMD into
  // `C:\\Program` and `Files\\...`. When it follows at least one source it
  // cannot be recovered as the parsed final positional target, so retain a
  // narrow fail-closed check for that unsafe spelling. A protected source in
  // the first positional slot remains a read and is not blocked here.
  let positionalCount = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (isWindowsCopyOption(arg)) continue;
    if (
      positionalCount > 0 &&
      /^[A-Za-z]:\\program$/i.test(arg) &&
      /^files(?:\\|$)/i.test(args[index + 1] ?? '')
    ) {
      return `${arg} ${args[index + 1]}`;
    }
    positionalCount += 1;
  }
  return undefined;
}

function findDriveRelativeWindowsPath(value: string): string | undefined {
  // `C:foo` and `C:..\\Windows` resolve against CMD's per-drive current
  // directory, which this permission boundary cannot reconstruct safely.
  // A recursive delete/write must never rely on that ambient state, so deny
  // every drive-relative spelling rather than trying to infer its target.
  const match = /(?:^|[\s"';&|<>])([A-Za-z]:(?![\\/])[^\s"';&|<>]*)/.exec(value);
  return match?.[1];
}

function buildWindowsPathSafetyDenyReason(input: LocalPermissionCheckerInput): string | undefined {
  if ((input.platform ?? process.platform) !== 'win32') return undefined;
  if (['read', 'glob', 'grep', 'list'].includes(input.toolName)) return undefined;
  const command = readPermissionCommand(input.input);
  const surfaces = command
    ? expandWindowsCommandSurfacesWithShell(command, input.shellFamily, input.recoverableRm)
    : [];
  const directPath = input.input.path ?? input.input.filePath ?? input.input.file_path;
  // Expansion extracts redirects before dropping `>`, at every wrapper layer,
  // and keeps the owning stage's entry cwd alongside each destination.
  const redirectionTargets = surfaces.flatMap((surface) => surface.redirectionTargets);
  const writeOrDeleteSurfaces = surfaces.filter((surface) =>
    isWindowsWriteOrDeleteCommand(surface.command, surface.shellFamily),
  );
  if (command && writeOrDeleteSurfaces.length === 0 && redirectionTargets.length === 0) {
    return undefined;
  }
  const values = command
    ? [
        ...writeOrDeleteSurfaces.flatMap(
          ({ command: surfaceCommand, shellFamily, recoverableRm }) =>
            readWindowsPathSafetyTargets(surfaceCommand, shellFamily, recoverableRm) ?? [
              surfaceCommand,
            ],
        ),
        ...redirectionTargets,
      ]
    : typeof directPath === 'string'
      ? [directPath]
      : [];
  // Check the original POSIX source: both splitters replace line continuations
  // with spaces, while Bash joins the adjacent characters. Once split, target
  // checks cannot detect that loss (even inside a Windows wrapper payload).
  // Keep the whole source for dynamic cwd/assignment/header checks as well.
  if (
    command &&
    input.shellFamily === 'posix' &&
    ((/\\\r?\n/.test(command) && writeOrDeleteSurfaces.some((surface) => !surface.recoverableRm)) ||
      (!parseScriptPlainCommands(command) &&
        writeOrDeleteSurfaces.some(
          (surface) =>
            surface.shellFamily === 'posix' &&
            !surface.recoverableRm &&
            isRmCommand(surface.command),
        )))
  ) {
    return `Local hard safety policy blocked ${input.toolName}: native delete targets cannot be verified safely in a dynamic POSIX command.`;
  }
  const recursiveSurfaces = writeOrDeleteSurfaces.filter((surface) =>
    isRecursiveWindowsWriteCommand(surface.command, surface.shellFamily),
  );
  const recursive = recursiveSurfaces.length > 0;
  const protectedPath = values.map(findProtectedWindowsPath).find(Boolean);
  if (protectedPath) {
    return `Local hard safety policy blocked ${input.toolName}: protected Windows path "${protectedPath}" cannot be written or deleted.`;
  }
  const ambiguousProgramFilesTarget = writeOrDeleteSurfaces
    .map((surface) => findAmbiguousProgramFilesWriteTarget(surface.command))
    .find(Boolean);
  if (ambiguousProgramFilesTarget) {
    return `Local hard safety policy blocked ${input.toolName}: protected Windows path "${ambiguousProgramFilesTarget}" cannot be written or deleted.`;
  }
  const driveRelativePath = values.map(findDriveRelativeWindowsPath).find(Boolean);
  if (driveRelativePath) {
    return `Local hard safety policy blocked ${input.toolName}: protected Windows path "${driveRelativePath}" cannot be written or deleted because drive-relative paths cannot be verified safely.`;
  }
  // Delete operands cannot fall back to copy's last positional destination:
  // a trailing option value (for example `-ErrorAction Stop`) is not a target.
  // Unknown syntax or shell must remain fail-closed even without -Recurse.
  const nativeTargets: string[] = [];
  for (const {
    command: surfaceCommand,
    shellFamily,
    recoverableRm,
    cwdChanged,
  } of writeOrDeleteSurfaces) {
    const [program] = tokenizeWindowsCommand(surfaceCommand, shellFamily);
    const name = program ? normalizeWindowsProgramName(program) : undefined;
    const nativeDeleteCommand =
      !!name &&
      (WINDOWS_NATIVE_DELETE_COMMANDS.has(name) ||
        (name === 'rm' &&
          (shellFamily === 'posix' ||
            shellFamily === 'powershell' ||
            shellFamily === 'cmd' ||
            shellFamily === 'unknown')));
    if (!nativeDeleteCommand || recoverableRm) continue;
    const nativeDelete = parseWindowsDeleteTargets(surfaceCommand, shellFamily);
    if (!nativeDelete) {
      return `Local hard safety policy blocked ${input.toolName}: native delete targets cannot be verified safely. Use literal targets with supported delete options.`;
    }
    const resolved = resolveWindowsTargets(
      nativeDelete.targets,
      cwdChanged ? undefined : input.workspaceDir,
    );
    if (resolved.hasDynamicTarget) {
      return `Local hard safety policy blocked ${input.toolName}: native delete targets cannot be verified safely because the workspace or command working directory is unavailable.`;
    }
    if (
      nativeDelete.recursive &&
      resolved.resolved.some(
        (target) => normalizeWindowsPath(target) === normalizeWindowsPath(homedir()),
      )
    ) {
      return 'Refused: recursive deletion targets a root or home directory. This can cause unrecoverable data loss; choose a specific sub-path instead.';
    }
    nativeTargets.push(...resolved.resolved);
  }
  if (
    writeOrDeleteSurfaces.some(
      (surface) =>
        surface.cwdChanged &&
        resolveWindowsTargets(
          readWindowsPathSafetyTargets(surface.command, surface.shellFamily, surface.recoverableRm),
          undefined,
        ).hasDynamicTarget,
    ) ||
    surfaces.some(
      (surface) =>
        surface.cwdChanged &&
        resolveWindowsTargets(surface.redirectionTargets, undefined).hasDynamicTarget,
    )
  ) {
    return `Local hard safety policy blocked ${input.toolName}: write/delete targets cannot be verified safely after a command working directory change.`;
  }
  const targets = values
    .flatMap((value) => value.match(/(?:\\\\\?\\)?[A-Za-z]:[\\/][^\s"';&|<>]*/gi) ?? [])
    .map(canonicalizeWindowsAbsolutePath);
  targets.push(...nativeTargets);
  const recursiveTargets: string[] = [];
  let hasDynamicRecursiveTarget = false;
  if (recursive) {
    const workspaceDir = input.workspaceDir;
    if (!workspaceDir) {
      return `Local hard safety policy blocked ${input.toolName}: recursive write/delete target cannot be verified because the workspace is unavailable.`;
    }
    for (const surface of recursiveSurfaces) {
      const resolved = resolveWindowsTargets(
        readWindowsWriteTargets(surface.command, surface.shellFamily, surface.recoverableRm),
        surface.cwdChanged ? undefined : input.workspaceDir,
      );
      recursiveTargets.push(...resolved.resolved);
      hasDynamicRecursiveTarget ||= resolved.hasDynamicTarget;
    }
    targets.push(...recursiveTargets);
  }
  for (const target of targets) {
    const normalized = normalizeWindowsPath(target);
    if (
      /^[a-z]:\/?$/i.test(normalized) ||
      /^[a-z]:\/(?:windows|program files(?: \(x86\))?)(?:\/|$)/i.test(normalized)
    ) {
      return `Local hard safety policy blocked ${input.toolName}: protected Windows path "${target.trim()}" cannot be written or deleted.`;
    }
  }
  if (recursive) {
    const workspaceDir = input.workspaceDir!;
    if (hasDynamicRecursiveTarget) {
      return `Local hard safety policy blocked ${input.toolName}: recursive write/delete target cannot be verified inside the workspace "${workspaceDir}".`;
    }
    const workspace = normalizeWindowsPath(workspaceDir);
    const outside = recursiveTargets.find((target) => {
      const normalized = normalizeWindowsPath(target);
      return normalized !== workspace && !normalized.startsWith(`${workspace}/`);
    });
    if (outside) {
      return `Local hard safety policy blocked ${input.toolName}: recursive write/delete target "${outside.trim()}" is outside the workspace "${workspaceDir}".`;
    }
  }
  return undefined;
}

function normalizeWindowsPath(value: string): string {
  const normalized = canonicalizeWindowsAbsolutePath(value)
    .trim()
    .replaceAll('\\', '/')
    .toLowerCase();
  return normalized.length > 3 ? normalized.replace(/\/$/, '') : normalized;
}

function canonicalizeWindowsAbsolutePath(value: string): string {
  const unquoted = value
    .trim()
    .replace(/^\\?["']|["']$/g, '')
    .replace(/^\\\\\?\\/i, '');
  return path.win32.isAbsolute(unquoted) ? path.win32.normalize(unquoted) : unquoted;
}

export function evaluateWindowsPathSafetyCheck(
  input: LocalPermissionCheckerInput,
): LocalPermissionCheckerResult | undefined {
  const reason = buildWindowsPathSafetyDenyReason(input);
  return reason ? { behavior: 'deny', reason, denyKind: 'bypass-immune' } : undefined;
}

const FS_PERMISSION_TOOLS = new Set(['edit', 'write', 'read', 'glob', 'grep', 'list']);
const HUGE_SCAN_ROOTS = new Set([
  '/',
  '/Users',
  '/home',
  '/System',
  '/Library',
  '/Applications',
  '/usr',
  '/var',
  '/opt',
  '/private',
]);

export function evaluateLocalPermissionCheck(
  input: LocalPermissionCheckerInput,
): LocalPermissionCheckerResult | undefined {
  const immune = buildLocalBypassImmuneDenyReason(input.toolName, input.input, input.workspaceDir);
  if (immune) return { behavior: 'deny', reason: immune, denyKind: 'bypass-immune' };

  const windowsPathSafety =
    input.skipWindowsHardSafetyChecks === true ? undefined : evaluateWindowsPathSafetyCheck(input);
  if (windowsPathSafety) return windowsPathSafety;

  const policy = buildLocalPolicyDenyReason(input.toolName, input.input);
  if (policy) return { behavior: 'deny', reason: policy, denyKind: 'policy' };

  if (input.toolName === 'bash') {
    const command = readPermissionCommand(input.input);
    if (!command) return undefined;
    return evaluateLocalBashCommand(command);
  }

  if (FS_PERMISSION_TOOLS.has(input.toolName)) {
    return evaluateLocalFsTool(input.toolName, input.input, input.workspaceDir);
  }

  return undefined;
}

/**
 * Reasons that survive bypassPermissions ('Always allow'). Keep narrow:
 *
 *   1. UNC / SMB share access — desktop runtime supports local filesystem access only
 *      and must never let the agent talk to network shares directly.
 *   2. Recursive deletion of `/`, `~`, drive roots — irrecoverable
 *      and not a decision a user toggle can reasonably authorize.
 *
 * Sensitive credential paths (`~/.ssh`, `*.pem`, …) are NOT here — they
 * live in `buildLocalPolicyDenyReason` so bypass mode can let the
 * engine's allow-list / cloud gateway decide.
 */
export function buildLocalBypassImmuneDenyReason(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir?: string,
): string | undefined {
  const networkShare = findNetworkShareAccess(toolName, input, workspaceDir);
  if (networkShare) {
    return (
      `Local hard safety policy blocked ${toolName}: direct access to the network share ` +
      `"${networkShare}" is not supported from built-in or bash tools. Copy the file into a local workspace first.`
    );
  }
  if (toolName === 'bash') {
    const command = readPermissionCommand(input);
    if (command && isRootRecursiveDelete(command, workspaceDir)) {
      return (
        `Local hard safety policy blocked ${toolName}: recursive deletion targets a root or home ` +
        `directory, which is unrecoverable. Target a specific sub-path instead of "/", a drive ` +
        `root, or the home directory.`
      );
    }
  }
  return undefined;
}

/**
 * Policy-grade deny — sensitive credential / system-secret paths. The
 * facade demotes this to an ask under default/auto so the LLM gate or the
 * user can authorize. Under bypassPermissions the engine's own fast-allow /
 * rule store takes over (no facade-side block).
 *
 * Mirrors the design intent in
 * `packages/local-runtime/src/permission/tools/bash-fast-allow.ts` — sensitive
 * reads route to the LLM gate, not to a flat deny.
 */
export function buildLocalPolicyDenyReason(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName === 'web_fetch' || toolName === 'website_deploy') {
    if (toolName === 'web_fetch') {
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      return (
        `Local permission check requires approval: web_fetch will request ` +
        `${url || 'a URL'} from this device's local network context.`
      );
    }
    return (
      'Local permission check requires approval: website_deploy publishes files to a public endpoint ' +
      'on this device network context.'
    );
  }
  const values = collectPermissionPathOrCommandStrings(toolName, input);
  const sensitive = values.find(containsSensitiveLocalPath);
  if (sensitive) {
    return `Local hard safety policy blocked ${toolName}: sensitive credential path in ${sensitive}`;
  }
  return undefined;
}

/**
 * @deprecated Use `buildLocalBypassImmuneDenyReason` or
 *   `buildLocalPolicyDenyReason`. Kept for one release so downstream
 *   callers compile while they switch over. Combines both deny kinds
 *   without distinguishing them — preserves the pre-split behaviour.
 */
export function buildLocalHardDenyReason(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir?: string,
): string | undefined {
  return (
    buildLocalBypassImmuneDenyReason(toolName, input, workspaceDir) ??
    buildLocalPolicyDenyReason(toolName, input)
  );
}

function evaluateLocalBashCommand(command: string): LocalPermissionCheckerResult | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (hasCurlPipeShell(trimmed)) {
    return {
      behavior: 'ask',
      reason: 'Local permission check requires approval: curl-pipe-shell command.',
    };
  }
  if (hasShellSubstitution(trimmed)) {
    return {
      behavior: 'ask',
      reason: 'Local permission check requires approval: shell substitution in bash command.',
    };
  }
  if (isSlowWholeTreeScan(trimmed)) {
    return {
      behavior: 'ask',
      reason: 'Local permission check requires approval: slow unbounded filesystem scan.',
    };
  }
  if (isRecursiveRmCommand(trimmed)) {
    return {
      behavior: 'ask',
      reason: 'Local permission check requires approval: recursive rm command.',
    };
  }
  return undefined;
}

function evaluateLocalFsTool(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir: string | undefined,
): LocalPermissionCheckerResult | undefined {
  if (!workspaceDir) return undefined;
  const target = readFsToolPath(toolName, input);
  if (!target) return undefined;
  if (isWorkspacePathEscape(target, workspaceDir)) {
    return {
      behavior: 'ask',
      reason: `Local permission check requires approval: ${toolName} path escapes workspace (${target}).`,
    };
  }
  return undefined;
}

function readFsToolPath(toolName: string, input: Record<string, unknown>): string | undefined {
  const direct = input.path ?? input.filePath ?? input.file_path;
  if (typeof direct === 'string' && direct.trim()) return direct;
  if (toolName === 'glob' || toolName === 'grep' || toolName === 'list') {
    const pattern = input.pattern;
    if (typeof pattern === 'string' && pattern.trim()) return pattern;
  }
  return undefined;
}

function findNetworkShareAccess(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir: string | undefined,
): string | undefined {
  if (toolName === 'bash') {
    const command = readPermissionCommand(input);
    if (!command) return undefined;
    const commandShare = findNetworkShareToken(command);
    if (commandShare) return commandShare;
    if (workspaceDir && isNetworkSharePath(workspaceDir)) return workspaceDir;
    return undefined;
  }

  if (!FS_PERMISSION_TOOLS.has(toolName)) return undefined;
  const target = readFsToolPath(toolName, input);
  if (!target) return undefined;
  if (isNetworkSharePath(target)) return target;
  if (workspaceDir && !isAbsolutePathLike(target) && isNetworkSharePath(workspaceDir)) {
    return `${workspaceDir.replace(/[\\/]+$/, '')}/${target}`;
  }
  return undefined;
}

function findNetworkShareToken(value: string): string | undefined {
  for (const token of tokenizeShellLike(value)) {
    if (isNetworkSharePath(token)) return token;
  }
  const unc = value.match(
    /(?:^|[\s"'=])((?:\\\\\?\\UNC\\|\\\\(?!\?\\))[^\\/\s"';&|()<>]+[\\/][^\\/\s"';&|()<>]+(?:[\\/][^\s"';&|()<>]+)*)/i,
  );
  if (unc?.[1]) return unc[1];
  const slashUnc = value.match(
    /(?:^|[\s"'=])(\/\/[^/\s"';&|()<>]+\/[^/\s"';&|()<>]+(?:\/[^\s"';&|()<>]+)*)/,
  );
  return slashUnc?.[1];
}

function isNetworkSharePath(value: string): boolean {
  const trimmed = trimWrappingQuotes(value.trim());
  return (
    /^\\\\\?\\UNC\\[^\\/]+[\\/][^\\/]+/i.test(trimmed) ||
    /^\\\\(?!\?\\)[^\\/\s]+[\\/][^\\/\s]+/.test(trimmed) ||
    /^\/\/[^/\s]+\/[^/\s]+/.test(trimmed)
  );
}

function trimWrappingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value;
}

function isAbsolutePathLike(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^[A-Za-z]:$/.test(value)
  );
}

function isWorkspacePathEscape(target: string, workspaceDir: string): boolean {
  const normalizedTarget = target.replaceAll('\\', '/').trim();
  if (looksLikeNonPathGlob(normalizedTarget)) return false;
  const workspace = resolvePathForCompare(workspaceDir);
  const resolved = resolvePathForCompare(
    path.isAbsolute(normalizedTarget)
      ? normalizedTarget
      : path.join(workspaceDir, normalizedTarget),
  );
  return resolved !== workspace && !resolved.startsWith(`${workspace}/`);
}

function looksLikeNonPathGlob(value: string): boolean {
  return !value.startsWith('/') && !value.startsWith('..') && !value.includes('/');
}

function hasCurlPipeShell(command: string): boolean {
  return (
    /\b(?:curl|wget)\b[\s\S]*\|[\s\S]*(?:^|[\s;&|])(?:sudo\s+)?(?:bash|sh|zsh|fish|dash|ksh)\b/i.test(
      command,
    ) || /\b(?:bash|sh|zsh|fish|dash|ksh)\b[\s\S]*<\s*<\s*\(?\s*(?:curl|wget)\b/i.test(command)
  );
}

function hasShellSubstitution(command: string): boolean {
  return /`[^`]*`|\$\(|<\(|>\(/.test(command);
}

function isSlowWholeTreeScan(command: string): boolean {
  return splitShellCommands(command).some((part) => {
    const tokens = tokenizeShellLike(part);
    const unwrapped = unwrapCommand(tokens);
    const commandName = commandBasename(unwrapped[0] ?? '');
    const args = unwrapped.slice(1);
    if (commandName === 'find') {
      const roots = findStartPaths(args);
      return roots.some(isHugeScanRoot) && !args.includes('-maxdepth');
    }
    if (commandName === 'rg' || commandName === 'grep') {
      if (args.some((arg) => arg === '--max-depth' || arg.startsWith('--max-depth='))) {
        return false;
      }
      return readSearchPaths(args).some(isHugeScanRoot);
    }
    if (commandName === 'tree') {
      if (args.some((arg) => arg === '-L' || /^-L\d+$/.test(arg) || arg.startsWith('--level'))) {
        return false;
      }
      return args.some(isHugeScanRoot);
    }
    return false;
  });
}

function findStartPaths(args: string[]): string[] {
  const paths: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    if (arg === '-H' || arg === '-L' || arg === '-P') {
      i += 1;
      continue;
    }
    if (arg === '-D' || arg === '-O') {
      i += arg.length === 2 ? 2 : 1;
      continue;
    }
    break;
  }
  for (; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg.startsWith('-') || arg === '(' || arg === '!' || arg === ')') break;
    paths.push(arg);
  }
  return paths;
}

function readSearchPaths(args: string[]): string[] {
  let patternSeen = false;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '-e' || arg === '-f' || arg === '--regexp' || arg === '--file') {
      i += 1;
      patternSeen = true;
      continue;
    }
    if (arg.startsWith('-')) continue;
    if (!patternSeen) {
      patternSeen = true;
      continue;
    }
    paths.push(arg);
  }
  return paths;
}

function isHugeScanRoot(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  return (
    HUGE_SCAN_ROOTS.has(normalized) ||
    normalized === '~' ||
    normalized === '$HOME' ||
    /^\$\{HOME\}$/.test(normalized) ||
    /^[A-Za-z]:$/.test(normalized)
  );
}

function isRecursiveRmCommand(command: string): boolean {
  return splitShellCommands(command).some((part) => {
    const tokens = unwrapCommand(tokenizeShellLike(part));
    const commandName = commandBasename(tokens[0] ?? '');
    if (commandName !== 'rm') return false;
    return tokens.slice(1).some((token) => token.startsWith('-') && /r/i.test(token));
  });
}

function splitShellCommands(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n\r]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function unwrapCommand(tokens: string[]): string[] {
  let cursor = 0;
  while (cursor < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor] ?? '')) {
    cursor += 1;
  }
  while (cursor < tokens.length) {
    const name = commandBasename(tokens[cursor] ?? '');
    if (name === 'sudo' || name === 'env' || name === 'command' || name === 'exec') {
      cursor += 1;
      continue;
    }
    break;
  }
  return tokens.slice(cursor);
}

function collectPermissionPathOrCommandStrings(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const values = [
    input.path,
    input.filePath,
    input.file_path,
    toolName === 'grep' ? undefined : input.pattern,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (toolName === 'bash') {
    const command = readPermissionCommand(input);
    if (command && !values.includes(command)) values.push(command);
  }
  return values;
}

function readPermissionCommand(input: Record<string, unknown>): string | undefined {
  return typeof input.command === 'string'
    ? input.command
    : typeof input.cmd === 'string'
      ? input.cmd
      : undefined;
}

function containsSensitiveLocalPath(value: string): boolean {
  return sensitivePathVariants(value).some(
    (normalized) =>
      /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.ssh(\/|$|[\s"';&|)])/i.test(normalized) ||
      /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.aws(\/|$|[\s"';&|)])/i.test(normalized) ||
      /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.config\/gcloud(\/|$|[\s"';&|)])/i.test(
        normalized,
      ) ||
      /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.kube\/config(?=$|[\s"';&|)])/i.test(
        normalized,
      ) ||
      /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.docker\/config\.json(?=$|[\s"';&|)])/i.test(
        normalized,
      ) ||
      /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.gnupg(\/|$|[\s"';&|)])/i.test(normalized) ||
      /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.npmrc(?=$|[\s"';&|)])/i.test(normalized) ||
      /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.netrc(?=$|[\s"';&|)])/i.test(normalized) ||
      /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.git-credentials(?=$|[\s"';&|)])/i.test(
        normalized,
      ) ||
      /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.env(\.|$|[\s"';&|)])/i.test(normalized) ||
      /(^|[/\s"'=:$])(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/\s"';&|)]+\.(?:key|pem|p12|pfx))(?=$|[\s"';&|)])/i.test(
        normalized,
      ),
  );
}

function sensitivePathVariants(value: string): string[] {
  const variants = new Set<string>();
  for (const candidate of [value, value.replace(/\\(.)/g, '$1')]) {
    variants.add(candidate.replaceAll('\\', '/').replace(/['"]/g, '').toLowerCase());
  }
  return [...variants];
}

function isRootRecursiveDelete(command: string, workspaceDir?: string, depth = 0): boolean {
  const stages = shellSourceStages(command, workspaceDir, resolveLiteralDeletePath);
  // Dynamic shell flow has no trustworthy cwd. Still inspect each command
  // separately so options (including --) cannot leak across command boundaries.
  if (stages.length === 0) {
    stages.push(
      ...splitShellSourceSegments(command).map((segment) => ({
        command: segment,
        directory: undefined,
      })),
    );
  }
  for (const stage of stages) {
    const tokens = tokenizeShellLike(stage.command);
    const commandIndex = tokens.length - unwrapCommand(tokens).length;
    if (depth < 4) {
      for (let i = 0; i < tokens.length - 2; i += 1) {
        if (!isShellEvalCommand(tokens[i]!)) continue;
        if (!isShellEvalOption(tokens[i + 1]!)) continue;
        // Login shells and unsupported wrapper options may change cwd.
        const directory =
          i === commandIndex && tokens[i + 1] === '-c' ? stage.directory : undefined;
        if (isRootRecursiveDelete(tokens[i + 2]!, directory, depth + 1)) return true;
      }
    }
    for (let i = 0; i < tokens.length; i += 1) {
      if (commandBasename(tokens[i]!).toLowerCase() !== 'rm') continue;
      const directory = i === commandIndex ? stage.directory : undefined;
      let recursive = false;
      let pastDoubleDash = false;
      let hasWhitespaceExpansion = false;
      const targets: string[] = [];
      for (let j = i + 1; j < tokens.length; j += 1) {
        const token = tokens[j]!;
        if (!pastDoubleDash && token === '--') {
          pastDoubleDash = true;
          continue;
        }
        hasWhitespaceExpansion ||= containsShellWhitespaceExpansion(token);
        if (!pastDoubleDash && token.startsWith('-') && token.length > 1) {
          recursive ||= token.includes('r') || token.includes('R');
          continue;
        }
        targets.push(token);
      }
      // rm accepts options after operands, but never after its -- delimiter.
      if (
        recursive &&
        (hasWhitespaceExpansion ||
          targets.some((target) => isRootOrHomeDeleteTarget(target, directory)))
      ) {
        return true;
      }
    }
  }
  return false;
}

function resolveLiteralDeletePath(target: string, workspaceDir?: string): string | undefined {
  // Brace expansion and escaped shell syntax are not literal path identities.
  if (
    /[{}\\]/.test(target) ||
    (target.startsWith('~') && target !== '~' && !target.startsWith('~/'))
  ) {
    return undefined;
  }
  return resolvePermissionPath(target, {
    workingDirectory: workspaceDir && path.isAbsolute(workspaceDir) ? workspaceDir : undefined,
    homeDir: homedir(),
  }).resolved;
}

function containsShellWhitespaceExpansion(token: string): boolean {
  return /\$\{?ifs(?:\b|[:}])/i.test(token);
}

function isShellEvalCommand(token: string): boolean {
  return ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(commandBasename(token));
}

function isShellEvalOption(token: string): boolean {
  return token.startsWith('-') && token.includes('c');
}

function tokenizeShellLike(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    token.replace(/^['"]|['"]$/g, ''),
  );
}

function commandBasename(token: string): string {
  return token.replaceAll('\\', '/').split('/').pop() || token;
}

function isRootOrHomeDeleteTarget(target: string, workspaceDir?: string): boolean {
  // A glob has no single resolved path. Resolve its literal parent instead,
  // preserving the existing top-level home rule without blocking child globs.
  const globIndex = /[$`\\]/.test(target) ? -1 : target.search(/[*?[{]/);
  const literalTarget =
    globIndex < 0 ? target : target.slice(0, target.lastIndexOf('/', globIndex) + 1) || '.';
  const resolved = resolveLiteralDeletePath(literalTarget, workspaceDir);
  if (resolved && path.isAbsolute(resolved)) {
    const normalized = path.resolve(resolved);
    const home = path.resolve(homedir());
    if (
      normalized === path.parse(normalized).root ||
      (process.platform === 'win32'
        ? normalized.toLowerCase() === home.toLowerCase()
        : normalized === home)
    ) {
      return true;
    }
  }
  const bracedHome = ['$', '{home}'].join('');
  const bracedHomeOpen = ['$', '{home'].join('');
  const raw = target.toLowerCase().replaceAll('\\', '/');
  if (raw === '/' || raw.startsWith('/*') || raw.startsWith('/.*')) return true;
  if (/^[a-z]:(?:\/?$|\/(?:\*|\.))/.test(raw)) return true;
  if (/^\/\/[^/]+\/[^/]+(?:\/?$|\/(?:\*|\.))/.test(raw)) return true;
  const normalized = raw.replace(/\/+$/, '');
  // Home-directory forms mirror the `/` handling above: block only the
  // bare home (`~`, `$HOME`, `${HOME}`) or a top-level *glob* at home
  // whose first path segment contains any shell glob/brace metacharacter
  // (`*`, `?`, `[`, `{`). This covers `~/*`, `~/.*`, `~/[!.]*`, `~/?*`,
  // `${HOME}/{Desktop,Downloads}`, etc. — every one of them expands to
  // a batch of top-level home entries and would be catastrophic to
  // hard-delete. Do NOT block ordinary subpaths like `~/Desktop/hihi`
  // (no metachars in the first segment) — the caller runs this check
  // bypass-immune, so a plain-subpath match here would prevent the
  // permission engine's `rm → mavis-trash` rewrite from ever taking
  // effect and force the model to fall back to a hard delete.
  const isBareHome = (form: string): boolean => normalized === form;
  const hasTopLevelHomeGlob = (form: string): boolean => {
    const prefix = `${form}/`;
    if (!normalized.startsWith(prefix)) return false;
    const remainder = normalized.slice(prefix.length);
    // Extract the first path segment after the home prefix. Anything
    // before the first `/` decides the fan-out; nested `foo/*` under a
    // literal first segment is fine (the rewrite handles it).
    const firstSegment = remainder.split('/')[0] ?? '';
    return /[*?[{]/.test(firstSegment);
  };
  if (
    isBareHome('~') ||
    hasTopLevelHomeGlob('~') ||
    isBareHome('$home') ||
    hasTopLevelHomeGlob('$home') ||
    isBareHome(bracedHome) ||
    hasTopLevelHomeGlob(bracedHome)
  ) {
    return true;
  }
  // `${home` followed by parameter-expansion syntax (`:`, `-`, `+`, `?`,
  // `=`, `#`, `%`) or an unterminated brace — the resolved value is
  // unclear at parse time, so treat it as suspicious. `${home}` (closed)
  // followed by nothing or `/subpath` is handled by the branches above
  // and falls through to the plain rules.
  if (normalized.startsWith(bracedHomeOpen) && !normalized.startsWith(bracedHome)) {
    return true;
  }
  return false;
}

function resolvePathForCompare(value: string): string {
  const resolved = path.resolve(value.replaceAll('\\', path.sep));
  const normalized = resolved.split(path.sep).join('/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
