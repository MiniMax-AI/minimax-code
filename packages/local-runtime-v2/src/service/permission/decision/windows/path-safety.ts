/**
 * Windows protected-path and workspace-boundary policy for write/delete
 * commands and file tools. Denials are bypass-immune: no permission mode,
 * persisted rule or approval may authorize them.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import {
  isRmCommand,
  parseScriptPlainCommands,
  unwrapBashCommandWrappers,
} from '@mavis/permission';
import {
  readPermissionCommand,
  type LocalPermissionCheckerInput,
  type LocalPermissionCheckerResult,
  type PathSafetyFinding,
} from '../checker-input.js';
import {
  evaluateGitBashPathSafety,
  type NativeShellCheck,
} from '../git-bash/git-bash-path-safety.js';
import {
  expandWindowsCommandSurfaces,
  expandWindowsCommandSurfacesWithShell,
  normalizeWindowsProgramName,
  tokenizeWindowsCommand,
  type WindowsCommandSurface,
} from './command-surfaces.js';
import {
  isNativeDeleteSurface,
  isPowerShellCopyOrMoveItem,
  isRecursiveWindowsWriteCommand,
  isSingleFileMove,
  isWindowsCopyOption,
  isWindowsWriteOrDeleteCommand,
  parseWindowsDeleteTargets,
  readPowerShellPathVariables,
  readWindowsPathSafetyTargets,
  readWindowsWriteTargets,
  resolveWindowsTargets,
  type PowerShellPathVariables,
} from './write-targets.js';
import {
  isNativeHomeReference,
  isNativeProtectedReference,
  readNativeDeleteOperands,
  type NativeDeleteTarget,
} from './native-delete-operands.js';

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['read', 'glob', 'grep', 'list']);

const HOME_DELETE_REASON =
  'Refused: recursive deletion targets a root or home directory. This can cause unrecoverable data loss; choose a specific sub-path instead.';

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

interface WindowsPathSafetyScan {
  command?: string;
  directPath?: string;
  /** Every expanded surface; its redirect targets keep the owning stage's cwd. */
  surfaces: WindowsCommandSurface[];
  /** Native deletion surfaces; checked only for positively identified targets. */
  nativeDeleteSurfaces: WindowsCommandSurface[];
  writeSurfaces: WindowsCommandSurface[];
  redirectionTargets: string[];
  values: string[];
  recursiveSurfaces: WindowsCommandSurface[];
  /** PowerShell Move-Item of literal existing files: not recursive, still protected. */
  singleFileMoves: WindowsCommandSurface[];
  /** Static PowerShell path variables, absent when the script may rebind them. */
  pathVariables: PowerShellPathVariables | undefined;
}

function hardFinding(reason: string | undefined): PathSafetyFinding | undefined {
  return reason ? { reason, denyKind: 'bypass-immune' } : undefined;
}

function buildWindowsPathSafetyFinding(
  input: LocalPermissionCheckerInput,
): PathSafetyFinding | undefined {
  if (isOutsideWindowsPathPolicy(input)) return undefined;
  const rawCommand = readPermissionCommand(input.input);
  if (input.trustedShellFamily === 'posix' && rawCommand) {
    return buildGitBashPathSafetyFinding(input, rawCommand);
  }
  const scan = collectWindowsPathSafetyScan(input);
  const nativeDeleteReason = checkNativeDeleteTargets(input, scan.nativeDeleteSurfaces);
  if (nativeDeleteReason) return hardFinding(nativeDeleteReason);
  if (hasNoWindowsWrite(scan)) return undefined;
  return (
    hardFinding(
      checkScriptContext(input, scan) ?? checkWindowsPathSpellings(input.toolName, scan),
    ) ?? checkResolvedWindowsPaths(input, scan)
  );
}

function isOutsideWindowsPathPolicy(input: LocalPermissionCheckerInput): boolean {
  return (input.platform ?? process.platform) !== 'win32' || READ_ONLY_TOOLS.has(input.toolName);
}

function hasNoWindowsWrite(scan: WindowsPathSafetyScan): boolean {
  return (
    scan.command !== undefined &&
    scan.writeSurfaces.length === 0 &&
    scan.redirectionTargets.length === 0
  );
}

/**
 * A trusted Git Bash session owns POSIX decoding and MSYS path mapping.
 * Native wrapper payloads are delegated with their own shell syntax.
 * trustedShellFamily is only set from the session snapshot / resolver path,
 * never from tool input, OS detection or fresh preference reads.
 */
function buildGitBashPathSafetyFinding(
  input: LocalPermissionCheckerInput,
  rawCommand: string,
): PathSafetyFinding | undefined {
  const checkNative: NativeShellCheck = (surface, nesting, uncertainCwd) => {
    // Only the native invocation belongs to the Windows parser. Re-tokenizing
    // the surrounding Bash script would discard /c/... operands as switches.
    const native = buildWindowsPathSafetyFinding({
      ...input,
      input: { ...input.input, command: surface },
      trustedShellFamily: undefined,
      uncertainWorkingDirectory: uncertainCwd,
    });
    if (native?.denyKind === 'bypass-immune') return native;
    return (
      findNestedGitBashFinding(surface, {
        workspaceDir: input.workspaceDir,
        additionalWorkspaceDirs: input.additionalWorkspaceDirs,
        nesting,
        checkNative,
        uncertainCwd,
        nativeDelete: input.nativeDelete === true,
      }) ?? native
    );
  };
  const finding = evaluateGitBashPathSafety(rawCommand, input.workspaceDir, undefined, {
    additionalWorkspaceDirs: input.additionalWorkspaceDirs,
    nesting: 0,
    checkNative,
    nativeDelete: input.nativeDelete === true,
  });
  // This parser owns the complete Bash script, including redirects and native
  // wrapper callbacks. Re-parsing that script as Windows argv would discard
  // MSYS operands and reject safe mixed-shell commands.
  if (!finding) return undefined;
  if (finding.denyKind === 'policy') {
    return finding.reason.startsWith('Local ')
      ? finding
      : {
          ...finding,
          reason: `Local permission check requires approval for ${input.toolName}: ${finding.reason}`,
        };
  }
  return {
    ...finding,
    reason: `Local hard safety policy blocked ${input.toolName}: ${finding.reason}`,
  };
}

function findNestedGitBashFinding(
  surface: string,
  context: {
    readonly workspaceDir: string | undefined;
    readonly additionalWorkspaceDirs: readonly string[] | undefined;
    readonly nesting: number;
    readonly checkNative: NativeShellCheck;
    readonly uncertainCwd: boolean;
    readonly nativeDelete: boolean;
  },
): PathSafetyFinding | undefined {
  let confirmable: PathSafetyFinding | undefined;
  for (const nested of expandWindowsCommandSurfaces(surface)) {
    if (unwrapBashCommandWrappers(nested).length <= 1) continue;
    const finding = evaluateGitBashPathSafety(nested, context.workspaceDir, undefined, {
      additionalWorkspaceDirs: context.additionalWorkspaceDirs,
      nesting: context.nesting + 1,
      checkNative: context.checkNative,
      uncertainCwd: context.uncertainCwd,
      nativeDelete: context.nativeDelete,
    });
    if (finding?.denyKind === 'bypass-immune') return finding;
    confirmable ??= finding;
  }
  return confirmable;
}

function collectWindowsPathSafetyScan(input: LocalPermissionCheckerInput): WindowsPathSafetyScan {
  const command = readPermissionCommand(input.input);
  const directPath = input.input.path ?? input.input.filePath ?? input.input.file_path;
  // Native-delete aware surface expansion: pass shellFamily and recoverableRm so
  // each surface carries enough metadata for the dynamic-POSIX checks below.
  const surfaces = command
    ? expandWindowsCommandSurfacesWithShell(command, {
        shellFamily: input.shellFamily,
        recoverableRm: input.recoverableRm,
      })
    : [];
  // Expansion extracts redirects before dropping `>`, at every wrapper layer,
  // and keeps the owning stage's entry cwd alongside each destination.
  const redirectionTargets = surfaces.flatMap((surface) => surface.redirectionTargets);
  // Native deletion keeps the shell's own delete syntax. Its operands leave the
  // proof-based write pipeline below; every other write keeps that pipeline.
  const nativeDeleteSurfaces = input.nativeDelete
    ? surfaces.filter((surface) => !surface.recoverableRm && isNativeDeleteSurface(surface))
    : [];
  const writeSurfaces = surfaces.filter(
    (surface) =>
      isWindowsWriteOrDeleteCommand(surface.command, surface.shellFamily) &&
      !nativeDeleteSurfaces.includes(surface),
  );
  const values = command
    ? [...writeSurfaces.flatMap(readSurfacePathValues), ...redirectionTargets]
    : directPathValues(directPath);
  const recursiveSurfaces = writeSurfaces.filter((surface) =>
    isRecursiveWindowsWriteCommand(surface.command, surface.shellFamily),
  );
  const singleFileMoves = recursiveSurfaces.filter((surface) =>
    isSingleFileMove(surface, input.workspaceDir),
  );
  return {
    ...(command ? { command } : {}),
    ...(typeof directPath === 'string' ? { directPath } : {}),
    surfaces,
    nativeDeleteSurfaces,
    writeSurfaces,
    redirectionTargets,
    values,
    recursiveSurfaces: recursiveSurfaces.filter((surface) => !singleFileMoves.includes(surface)),
    singleFileMoves,
    pathVariables: command ? readPowerShellPathVariables(command) : undefined,
  };
}

/** Only PowerShell expands `$env:` and `~`; other shells keep them dynamic. */
function surfacePathVariables(
  scan: WindowsPathSafetyScan,
  surface: WindowsCommandSurface,
): PowerShellPathVariables | undefined {
  return surface.shellFamily === 'powershell' ? scan.pathVariables : undefined;
}

function surfaceWorkspace(
  surface: WindowsCommandSurface,
  workspaceDir: string | undefined,
): string | undefined {
  return surface.cwdChanged ? undefined : workspaceDir;
}

function readSurfacePathValues(surface: WindowsCommandSurface): string[] {
  return (
    readWindowsPathSafetyTargets(surface.command, surface.shellFamily, surface.recoverableRm) ?? [
      surface.command,
    ]
  );
}

function directPathValues(directPath: unknown): string[] {
  return typeof directPath === 'string' ? [directPath] : [];
}

function checkScriptContext(
  input: LocalPermissionCheckerInput,
  scan: WindowsPathSafetyScan,
): string | undefined {
  if (
    scan.command &&
    input.shellFamily === 'posix' &&
    hasDynamicPosixWrite(scan.command, scan.writeSurfaces)
  ) {
    return `Local hard safety policy blocked ${input.toolName}: native delete targets cannot be verified safely in a dynamic POSIX command.`;
  }
  // Distinct guard from the MR (b2) facade: a cd / pushd / source earlier in the
  // same script can shift the entry cwd, in which case non-absolute write
  // targets cannot be resolved safely even when shellFamily metadata is set.
  if (
    input.uncertainWorkingDirectory &&
    scan.values.some((value) => !/^[A-Za-z]:[\\/]/.test(value))
  ) {
    return 'Native shell write after a directory change cannot be resolved safely; use absolute paths in a separate command.';
  }
  return undefined;
}

/**
 * Check the original POSIX source: both splitters replace line continuations
 * with spaces, while Bash joins the adjacent characters. Once split, target
 * checks cannot detect that loss (even inside a Windows wrapper payload).
 * Keep the whole source for dynamic cwd/assignment/header checks as well.
 */
function hasDynamicPosixWrite(command: string, writeSurfaces: WindowsCommandSurface[]): boolean {
  if (/\\\r?\n/.test(command) && writeSurfaces.some((surface) => !surface.recoverableRm)) {
    return true;
  }
  return (
    !parseScriptPlainCommands(command) &&
    writeSurfaces.some(
      (surface) =>
        surface.shellFamily === 'posix' && !surface.recoverableRm && isRmCommand(surface.command),
    )
  );
}

function checkResolvedWindowsPaths(
  input: LocalPermissionCheckerInput,
  scan: WindowsPathSafetyScan,
): PathSafetyFinding | undefined {
  const native = collectNativeDeleteTargets(input, scan);
  if (native.reason) return hardFinding(native.reason);
  const cwdReason = checkCwdChangedTargets(input.toolName, scan);
  if (cwdReason) return hardFinding(cwdReason);
  const targets = [
    ...collectWindowsAbsoluteTargets(scan.values),
    ...native.targets,
    ...resolveSingleFileMoveTargets(input.workspaceDir, scan),
  ];
  if (scan.recursiveSurfaces.length === 0) {
    return (
      hardFinding(checkProtectedWindowsTargets(input.toolName, targets)) ??
      findUnverifiableSingleFileMove(input, scan)
    );
  }
  const workspaceDir = input.workspaceDir;
  if (!workspaceDir) {
    return hardFinding(
      `Local hard safety policy blocked ${input.toolName}: recursive write/delete target cannot be verified because the workspace is unavailable.`,
    );
  }
  const recursive = scan.recursiveSurfaces.map((surface) => ({
    confirmable: isPowerShellCopyOrMoveItem(surface.command, surface.shellFamily),
    ...resolveWindowsTargets(
      readWindowsWriteTargets(surface.command, surface.shellFamily, surface.recoverableRm),
      surfaceWorkspace(surface, workspaceDir),
      surfacePathVariables(scan, surface),
    ),
  }));
  const resolvedTargets = recursive.flatMap((result) => result.resolved);
  return (
    hardFinding(checkProtectedWindowsTargets(input.toolName, [...targets, ...resolvedTargets])) ??
    checkRecursiveWindowsTargets({
      toolName: input.toolName,
      workspaceDir,
      additionalWorkspaceDirs: input.additionalWorkspaceDirs ?? [],
      recursive,
    }) ??
    findUnverifiableSingleFileMove(input, scan)
  );
}

/** A known file moved to an unresolvable destination confirms, like any unmapped write. */
function findUnverifiableSingleFileMove(
  input: LocalPermissionCheckerInput,
  scan: WindowsPathSafetyScan,
): PathSafetyFinding | undefined {
  const unverifiable = scan.singleFileMoves.some(
    (surface) =>
      resolveWindowsTargets(
        readWindowsPathSafetyTargets(surface.command, surface.shellFamily, surface.recoverableRm),
        surfaceWorkspace(surface, input.workspaceDir),
        surfacePathVariables(scan, surface),
      ).hasDynamicTarget,
  );
  return unverifiable
    ? {
        reason: `Local permission check requires approval: ${input.toolName} move destination cannot be resolved.`,
        denyKind: 'policy',
      }
    : undefined;
}

/** Sources and destinations of a demoted single-file move keep the protected-path check. */
function resolveSingleFileMoveTargets(
  workspaceDir: string | undefined,
  scan: WindowsPathSafetyScan,
): string[] {
  return scan.singleFileMoves.flatMap(
    (surface) =>
      resolveWindowsTargets(
        readWindowsPathSafetyTargets(surface.command, surface.shellFamily, surface.recoverableRm),
        surfaceWorkspace(surface, workspaceDir),
        surfacePathVariables(scan, surface),
      ).resolved,
  );
}

/**
 * Delete operands cannot fall back to copy's last positional destination:
 * a trailing option value (for example `-ErrorAction Stop`) is not a target.
 * Unknown syntax or shell must remain fail-closed even without -Recurse.
 */
function collectNativeDeleteTargets(
  input: LocalPermissionCheckerInput,
  scan: WindowsPathSafetyScan,
): { reason?: string; targets: string[] } {
  const targets: string[] = [];
  for (const surface of scan.writeSurfaces) {
    if (surface.recoverableRm || !isNativeDeleteSurface(surface)) continue;
    const resolved = resolveNativeDeleteSurface(
      input,
      surface,
      surfacePathVariables(scan, surface),
    );
    if (typeof resolved === 'string') return { reason: resolved, targets };
    targets.push(...resolved);
  }
  return { targets };
}

function resolveNativeDeleteSurface(
  input: LocalPermissionCheckerInput,
  surface: WindowsCommandSurface,
  pathVariables: PowerShellPathVariables | undefined,
): string | string[] {
  const nativeDelete = parseWindowsDeleteTargets(surface.command, surface.shellFamily);
  if (!nativeDelete) {
    return `Local hard safety policy blocked ${input.toolName}: native delete targets cannot be verified safely. Use literal targets with supported delete options.`;
  }
  const resolved = resolveWindowsTargets(
    nativeDelete.targets,
    surfaceWorkspace(surface, input.workspaceDir),
    pathVariables,
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
    return HOME_DELETE_REASON;
  }
  return resolved.resolved;
}

function checkCwdChangedTargets(toolName: string, scan: WindowsPathSafetyScan): string | undefined {
  const unresolvedWrite = scan.writeSurfaces.some(
    (surface) =>
      surface.cwdChanged &&
      resolveWindowsTargets(
        readWindowsPathSafetyTargets(surface.command, surface.shellFamily, surface.recoverableRm),
        undefined,
        surfacePathVariables(scan, surface),
      ).hasDynamicTarget,
  );
  const unresolvedRedirect = scan.surfaces.some(
    (surface) =>
      surface.cwdChanged &&
      resolveWindowsTargets(
        surface.redirectionTargets,
        undefined,
        surfacePathVariables(scan, surface),
      ).hasDynamicTarget,
  );
  return unresolvedWrite || unresolvedRedirect
    ? `Local hard safety policy blocked ${toolName}: write/delete targets cannot be verified safely after a command working directory change.`
    : undefined;
}

function checkWindowsPathSpellings(
  toolName: string,
  scan: WindowsPathSafetyScan,
): string | undefined {
  const protectedPath = scan.values.map(findProtectedWindowsPath).find(Boolean);
  if (protectedPath) return protectedWindowsPathReason(toolName, protectedPath);
  const ambiguous = scan.writeSurfaces
    .map((surface) => findAmbiguousProgramFilesWriteTarget(surface.command))
    .find(Boolean);
  if (ambiguous) return protectedWindowsPathReason(toolName, ambiguous);
  const driveRelative = scan.values.map(findDriveRelativeWindowsPath).find(Boolean);
  return driveRelative ? driveRelativePathReason(toolName, driveRelative) : undefined;
}

function collectWindowsAbsoluteTargets(values: string[]): string[] {
  return values
    .flatMap((value) => value.match(/(?:\\\\\?\\)?[A-Za-z]:[\\/][^\s"';&|<>]*/gi) ?? [])
    .map(canonicalizeWindowsAbsolutePath);
}

interface RecursiveWindowsTargets {
  /** PowerShell Copy-Item / Move-Item: an unprotected outside target needs confirmation. */
  readonly confirmable: boolean;
  readonly resolved: string[];
  readonly hasDynamicTarget: boolean;
}

/**
 * Unverifiable recursive targets and recursive deletes outside the workspace
 * stay bypass-immune. A PowerShell copy/move that only lands outside the
 * workspace (protected targets were already refused) needs confirmation.
 */
function checkRecursiveWindowsTargets(input: {
  toolName: string;
  workspaceDir: string;
  additionalWorkspaceDirs: readonly string[];
  recursive: readonly RecursiveWindowsTargets[];
}): PathSafetyFinding | undefined {
  const { toolName, workspaceDir, additionalWorkspaceDirs, recursive } = input;
  if (recursive.some((result) => result.hasDynamicTarget)) {
    return hardFinding(
      `Local hard safety policy blocked ${toolName}: recursive write/delete target cannot be verified inside the workspace "${workspaceDir}".`,
    );
  }
  const workspaces = [workspaceDir, ...additionalWorkspaceDirs].map(normalizeWindowsPath);
  const findOutside = (confirmable: boolean): string | undefined =>
    recursive
      .filter((result) => result.confirmable === confirmable)
      .flatMap((result) => result.resolved)
      .find((target) => {
        const normalized = normalizeWindowsPath(target);
        return !workspaces.some(
          (workspace) => normalized === workspace || normalized.startsWith(`${workspace}/`),
        );
      });
  const outside = findOutside(false);
  if (outside) {
    return hardFinding(
      `Local hard safety policy blocked ${toolName}: recursive write/delete target "${outside.trim()}" is outside the workspace "${workspaceDir}".`,
    );
  }
  const confirmable = findOutside(true);
  return confirmable
    ? {
        reason: `Local permission check requires approval: ${toolName} recursive copy/move target "${confirmable.trim()}" is outside the workspace "${workspaceDir}".`,
        denyKind: 'policy',
      }
    : undefined;
}

function checkProtectedWindowsTargets(toolName: string, targets: string[]): string | undefined {
  for (const target of targets) {
    const normalized = normalizeWindowsPath(target);
    if (
      /^[a-z]:\/?$/i.test(normalized) ||
      /^[a-z]:\/(?:windows|program files(?: \(x86\))?)(?:\/|$)/i.test(normalized)
    ) {
      return protectedWindowsPathReason(toolName, target.trim());
    }
  }
  return undefined;
}

/**
 * Native deletion keeps the shell's own syntax. Deny only operands positively
 * identified as a drive root, a protected Windows directory or, for a recursive
 * delete, the home directory. Unresolved operands, cwd changes and targets
 * outside the workspace are left to ordinary permissions, rules and sandbox.
 */
function checkNativeDeleteTargets(
  input: LocalPermissionCheckerInput,
  surfaces: WindowsCommandSurface[],
): string | undefined {
  for (const surface of surfaces) {
    // A shape the reader cannot bind is no verdict, never a denial.
    const operands = readNativeDeleteOperands(surface);
    if (!operands) continue;
    // Variables follow the executing shell; literal paths are checked once resolved.
    const protectedSpelling = operands.targets.find(isNativeProtectedReference);
    if (protectedSpelling) {
      return protectedWindowsPathReason(input.toolName, protectedSpelling.value);
    }
    const context = {
      recursive: operands.recursive,
      workspaceDir: surface.cwdChanged ? undefined : input.workspaceDir,
      posix: surface.shellFamily === 'posix',
    };
    for (const target of operands.targets) {
      const reason = checkNativeDeleteOperand(input.toolName, target, context);
      if (reason) return reason;
    }
  }
  return undefined;
}

function checkNativeDeleteOperand(
  toolName: string,
  target: NativeDeleteTarget,
  context: { recursive: boolean; workspaceDir: string | undefined; posix: boolean },
): string | undefined {
  // `X\*` removes X's contents, which is as destructive as removing X itself.
  const operand = target.value.replace(/([\\/])\*(?:\.\*)?$/, '$1');
  if (context.recursive && isNativeHomeReference({ ...target, value: operand })) {
    return HOME_DELETE_REASON;
  }
  // A drive-relative `C:name` depends on per-drive cwd state; it is not a proven target.
  if (/^[a-z]:(?![\\/])/i.test(operand)) return undefined;
  const msysDrive = context.posix ? /^\/([a-z])(?=\/|$)/i.exec(operand) : null;
  const windowsOperand = msysDrive ? `${msysDrive[1]}:\\${operand.slice(2)}` : operand;
  const [resolved] = resolveWindowsTargets([windowsOperand], context.workspaceDir).resolved;
  if (!resolved) return undefined;
  if (context.recursive && normalizeWindowsPath(resolved) === normalizeWindowsPath(homedir())) {
    return HOME_DELETE_REASON;
  }
  return checkProtectedWindowsTargets(toolName, [resolved]);
}

function protectedWindowsPathReason(toolName: string, value: string): string {
  return `Local hard safety policy blocked ${toolName}: protected Windows path "${value}" cannot be written or deleted.`;
}

function driveRelativePathReason(toolName: string, value: string): string {
  return `Local hard safety policy blocked ${toolName}: protected Windows path "${value}" cannot be written or deleted because drive-relative paths cannot be verified safely.`;
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
  const finding = buildWindowsPathSafetyFinding(input);
  return finding ? { behavior: 'deny', ...finding } : undefined;
}
