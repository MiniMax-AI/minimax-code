import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { splitCommand, splitShellSourceSegments } from '@mavis/permission';

import {
  isWindowsWriteOrDeleteCommand,
  readPowerShellPathVariables,
  readWindowsCopyOrMoveOperands,
  type WindowsCopyOrMoveOperands,
  readWindowsWriteTargets,
  resolveWindowsTargets,
} from '../decision/windows/write-targets.js';
import { readWindowsRedirectionTargets } from '../decision/windows/command-surfaces.js';
import { bashWritesInside, literalCdTargets } from './bash-write-targets.js';
import { canonicalPath, isInside, type Protects } from './canonical-paths.js';
import type { ProtectedRootRequest, ProtectedRootSession } from './write-targets.js';

/**
 * How a protected directory can be spelled in program text, and what of it is protected.
 * @internal Exported only for focused tests.
 */
export interface DirectoryNames {
  /** The directory as written: resolved and canonical. */
  readonly spellings: readonly string[];
  /** The canonical directory that protects() is called with. */
  readonly root: string;
  readonly homeDir: string;
  readonly protects: Protects;
  /** Directories in it the command literally cd's into, which relative paths start from. */
  readonly workingDirectories?: readonly string[];
}

const MAX_SCRIPT_FILES = 8;
/** Agent-written scripts are small; large tools are not read. */
const MAX_SCRIPT_BYTES = 64 * 1024;
const SEPARATOR = /[\\/]+/.source;
/** Path segments after a name, up to a quote, a space or a code delimiter. */
const CONTINUATION = /((?:[\\/]+[^\\/\s'"\x60,;|&<>()]*)*)/.source;
const NOT_PATH_AFTER = /(?![\w.-])/.source;
const HOME_PREFIX =
  /(?:~|\$HOME|\$\{HOME\}|\$env:HOME|\$env:USERPROFILE|\$\{env:USERPROFILE\}|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%)/
    .source;
/** Code that builds a path from the home directory, as in join(homedir(), '.minimax'). */
const HOME_EXPRESSION =
  /\b(?:homedir|expanduser|gethomedir)\s*\(|Path\.home\s*\(|\$HOME\b|\$\{HOME\}|USERPROFILE|GetFolderPath\s*\(|getenv\s*\(\s*['"]HOME/i;
const SCRIPT_EXTENSION =
  /\.(?:py|pyw|js|mjs|cjs|ts|mts|cts|ps1|psm1|sh|bash|zsh|rb|pl|php|lua|bat|cmd|vbs|vbe|wsf|jse)$/i;
/**
 * Programs that run the script file named after them, without a version
 * suffix (python3.12 reads as python). Each language here has its write calls
 * in WRITE_API; shell scripts go through the shell parser and cmd scripts
 * through BATCH_WRITE.
 */
const INTERPRETERS: ReadonlySet<string> = new Set([
  'python',
  'python2',
  'python3',
  'py',
  'pythonw',
  'node',
  'nodejs',
  'bun',
  'deno',
  'tsx',
  'ts-node',
  'pwsh',
  'powershell',
  'bash',
  'sh',
  'zsh',
  'ruby',
  'perl',
  'php',
  'lua',
  'cscript',
  'wscript',
  'cmd',
  'uv',
]);
/** Statements that change the current directory, in PowerShell and cmd (lower case). */
const LOCATION_COMMANDS: ReadonlySet<string> = new Set([
  'cd',
  'chdir',
  'sl',
  'set-location',
  'pushd',
  'push-location',
]);
/** PowerShell here-strings, shell heredocs and inline -c (also -lc) / -e / -Command code. */
const CODE_BODIES: readonly RegExp[] = [
  /@(['"])[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1@/g,
  /<<(?!<)-?[ \t]*(['"]?)([A-Za-z_][\w.-]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g,
  /\s-(?:[a-z]*c|e|Command|command|-eval)\s+(['"])((?:\\.|(?!\1)[\s\S])*)\1/g,
];
/** SQL that changes a database, which names the database it changes. */
const SQL_WRITE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|UPDATE\s+[\w."\x60[\]]+\s+SET|VACUUM(?!\s+INTO))\b/i;

/**
 * Calls that write, copy over, move or delete files in the languages the
 * interpreters above run (Node.js, Deno, Bun, Python, PowerShell, .NET, Ruby,
 * PHP, Perl and Windows Script Host), and SQL that changes a database. Shell builtins and cp/mv/rm
 * are left out: bashWritesInside parses their targets exactly.
 */
const WRITE_API = new RegExp(
  [
    /\b(?:writeFile|appendFile|copyFile|cp|rename|unlink|rm|rmdir|truncate)Sync\b/.source,
    /\b(?:writeFile|appendFile|copyFile|createWriteStream)\s*\(/.source,
    /\bfs(?:\.promises)?\.(?:rm|cp|rename|unlink|rmdir|truncate|write)\s*\(/.source,
    /\b(?:writeSync|writevSync)\s*\(/.source,
    /\bopenSync\s*\([^()\n]*?,\s*['"][^'"\n]*[wax+]/.source,
    /\bDeno\.(?:writeTextFile|writeFile|remove|rename|copyFile|truncate)(?:Sync)?\s*\(/.source,
    /\bBun\.write\s*\(/.source,
    // copy(), rename() and unlink() as functions: PHP, Perl's File::Copy, destructured fs/promises.
    /(?<![.\w$])(?:copy|move|rename|unlink|rmtree|remove_tree)\s*\(/.source,
    /(?<![.\w$])(?:unlink|rename)\s+[$'"]/.source,
    /\bfile_put_contents\s*\(/.source,
    /\bfopen\s*\([^()\n]*?,\s*['"][^'"\n]*[waxc+]/.source,
    /\b(?:File|IO)\.(?:write|binwrite|delete|unlink|rename)\b/.source,
    /\bFileUtils\.(?:cp|mv|rm|copy|move|remove|touch|install|ln|mkdir|rmdir)\w*/.source,
    // Perl's open with a write mode: open(my $fh, '>', $path) or open(FH, ">$path").
    /\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*['"]\s*\+?>/.source,
    // Windows Script Host (cscript, wscript): FileSystemObject and ADODB.Stream.
    /\.(?:CreateTextFile|CopyFile|CopyFolder|MoveFile|MoveFolder|DeleteFile|DeleteFolder|SaveToFile)\b/
      .source,
    /\.OpenTextFile\s*\([^()\n]*?,\s*[28]\b/.source,
    /\bshutil\.(?:copy\w*|move|rmtree)\s*\(/.source,
    /\bos\.(?:remove|unlink|replace|renames?|truncate|rmdir|removedirs)\s*\(/.source,
    /\.(?:write_text|write_bytes|unlink|rmdir|touch)\s*\(/.source,
    /\bopen\s*\([^()\n]*?,\s*(?:mode\s*=\s*)?[rbu]?['"][^'"\n]*[wax+]/.source,
    /\b(?:Set-Content|Add-Content|Out-File|Clear-Content|Copy-Item|Move-Item|Rename-Item|Remove-Item)\b/
      .source,
    /\[(?:System\.)?IO\.(?:File|Directory)\]::(?:Write\w*|Append\w*|Copy|Move|Delete|Replace|Create\w*|OpenWrite)\b/
      .source,
    /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE)\b/
      .source,
    /\bUPDATE\s+[\w."\x60[\]]+\s+SET\b/.source,
    /\bVACUUM\b(?!\s+INTO)/.source,
    /\bPRAGMA\s+(?:\w+\.)?(?:wal_checkpoint|journal_mode\s*=)/.source,
  ].join('|'),
  'i',
);

/**
 * Whether program text calls an API that writes, moves or deletes files or changes a database.
 * @internal Exported only for focused tests.
 */
export function writesFiles(text: string): boolean {
  return WRITE_API.test(text);
}

/** cmd commands that write, move or delete files, at the start of a batch script statement. */
const BATCH_WRITE =
  /(?:^|[&|(])[ \t]*@?(?:copy|xcopy|robocopy|move|del|erase|ren|rename|rd|rmdir)\b/im;

/**
 * Shell commands that rewrite or delete whatever files a sweep hands them
 * (sed -i, perl -i, find -delete, find -exec rm, xargs rm), whose targets the
 * shell parser cannot see. Copies are left out: their destination is literal.
 */
const SHELL_IN_PLACE = new RegExp(
  [
    /\bsed\b[^|;&\n]*?\s(?:-[a-zA-Z]*i|--in-place)/.source,
    /\bperl\s+-[a-zA-Z]*i/.source,
    /\s-delete\b/.source,
    /\s-exec(?:dir)?\s+(?:rm|mv|truncate|shred)\b/.source,
    /\bxargs\b[^|;&\n]*?\b(?:rm|mv|truncate|shred)\b/.source,
  ].join('|'),
);
/** A shell loop, also one a pipeline, a group, a subshell or an if branch holds. */
const SHELL_LOOP = /(?:^|[|{(]\s*|\b(?:then|do|else)\s+)(?:for|while|until|select)\b/;
/** A delete or move of a variable, as a loop body does with each file the loop walks. */
const VARIABLE_DELETE = /\b(?:rm|mv|unlink|truncate|shred)\s[^|;&\n]*\$/;

/**
 * Whether a bash command writes inside the protected directory in a way the
 * shell parser does not see. Three readings, each with what it may conclude:
 *
 * - Code handed to an interpreter (heredocs, here-strings, -c, -e, -Command)
 *   and the local script an interpreter runs: naming the directory, or a
 *   protected part of it, next to a file-writing call. This matches what the
 *   code names, not where it writes, so a script that only copies protected
 *   data out is denied too.
 * - The shell text around that code: PowerShell write commands are parsed for
 *   their targets; otherwise only naming the directory or a protected
 *   directory in it on the same line as a write (a sweep over it), or a
 *   protected database next to SQL that changes one, counts: an argument naming
 *   one file, such as a source path, says nothing about where the command writes.
 */
export async function scriptWritesInside(
  directory: string,
  session: ProtectedRootSession | undefined,
  request: ProtectedRootRequest,
  protects: Protects,
): Promise<boolean> {
  if (request.toolName !== 'bash') return false;
  const command = [request.toolInput.command, request.toolInput.cmd].find(
    (value): value is string => typeof value === 'string',
  );
  if (!command?.trim()) return false;
  const home = homedir();
  const resolved = path.resolve(directory);
  const root = canonicalPath(resolved);
  const names: DirectoryNames = {
    spellings: resolved === root ? [root] : [resolved, root],
    root,
    homeDir: home,
    protects,
  };
  const sessionBases = [session?.workspaceDir, session?.runLocation?.resolvedDir].filter(
    (base): base is string => Boolean(base),
  );
  const { outer, bodies } = splitCodeBodies(command);
  // A cd inside wrapped code (bash -c "cd X && ...") moves that code too.
  // On Windows the shell is PowerShell, where a backslash is a path separator, not an escape.
  const cdTargets = [
    ...new Set(
      [command, ...bodies].flatMap((code) => [
        ...literalCdTargets(code, sessionBases, home),
        ...powerShellLocations(code, sessionBases, home),
      ]),
    ),
  ];
  const scoped = withWorkingDirectories(names, cdTargets);
  if (outerWritesInside(outer, scoped, sessionBases)) return true;
  // A script named relative to a directory the command cd's into is read from there too.
  const bases = [...sessionBases, ...cdTargets];
  // Code run through a wrapper (bash -c, pwsh -Command) can run a script too.
  const scripts = await executedScriptTexts([command, ...bodies], bases, home);
  return (
    bodies.some(
      (code) =>
        (writesFiles(code) &&
          (namesProtectedPath(code, names) || namesRelativeLiteral(code, scoped))) ||
        sweeps(code, scoped),
    ) || scripts.some((script) => scriptFileWritesInside(script, scoped, bases))
  );
}

/** The names, with the directories a command cd's into in the protected directory or above it. */
function withWorkingDirectories(
  names: DirectoryNames,
  cdTargets: readonly string[],
): DirectoryNames {
  const inside = cdTargets
    .map(canonicalPath)
    .filter((target) => isInside(names.root, target) || isInside(target, names.root));
  return inside.length > 0 ? { ...names, workingDirectories: inside } : names;
}

/**
 * A script an interpreter runs: shell scripts are parsed like the command
 * itself; other languages count when they name protected state and call a
 * file-writing API.
 */
function scriptFileWritesInside(
  { text, file }: { readonly text: string; readonly file: string },
  names: DirectoryNames,
  bases: readonly string[],
): boolean {
  if (
    /\.(?:sh|bash|zsh)$/i.test(file) &&
    (bashWritesInside(names.root, bases, { command: text }, names.protects) ||
      sweeps(text, withWorkingDirectories(names, literalCdTargets(text, bases, homedir()))))
  ) {
    return true;
  }
  const writes = writesFiles(text) || (/\.(?:bat|cmd)$/i.test(file) && BATCH_WRITE.test(text));
  return (
    writes &&
    (namesProtectedPath(text, names, { joinedDirectory: false }) ||
      namesRelativeLiteral(text, names))
  );
}

/** The shell text around interpreter code: parsed PowerShell targets, a sweep of the directory, or SQL. */
function outerWritesInside(
  outer: string,
  names: DirectoryNames,
  bases: readonly string[],
): boolean {
  const { root, protects } = names;
  // PowerShell syntax is the Windows host's shell; elsewhere cp and rm are not its aliases.
  // Relative targets resolve from each directory the Session may run in, as the other layers do.
  if (
    process.platform === 'win32' &&
    (bases.length > 0 ? bases : [undefined]).some((workspaceDir) =>
      powerShellWritesInside(outer, {
        root,
        ...(workspaceDir ? { workspaceDir } : {}),
        protects,
        names,
      }),
    )
  ) {
    return true;
  }
  if (sweeps(outer, names)) return true;
  return SQL_WRITE.test(outer) && namesProtectedPath(outer, names);
}

/**
 * A statement that names a protected directory or glob and writes in it, as a
 * pipeline or loop does: PowerShell statements across lines, and shell
 * pipelines or loops. Shell in-place edits count only within one pipeline or
 * loop, so editing a copy made earlier in the command does not.
 */
function sweeps(text: string, names: DirectoryNames): boolean {
  const named = (part: string) => namesProtectedPath(part, names, { directories: true });
  return (
    shellStatements(text).some((statement) => writesFiles(statement) && named(statement)) ||
    shellPipelines(text).some(
      (pipeline) =>
        (writesFiles(pipeline) && named(pipeline)) ||
        (shellSweep(pipeline) && (named(pipeline) || namesRelativePath(pipeline, names))),
    )
  );
}

/** An in-place edit, or a loop that deletes or moves each file it walks. */
function shellSweep(pipeline: string): boolean {
  return (
    SHELL_IN_PLACE.test(pipeline) || (SHELL_LOOP.test(pipeline) && VARIABLE_DELETE.test(pipeline))
  );
}

/**
 * A relative path in a shell pipeline that reaches the protected directory or a
 * protected part of it from a directory the command cd's into. sed expressions
 * and single files are not what a sweep walks.
 */
function namesRelativePath(pipeline: string, names: DirectoryNames): boolean {
  const tokens = [...pipeline.matchAll(/'([^']*)'|"([^"]*)"|([^\s;|&]+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
  return tokens.some((token) => relativeReaches(token, names, false));
}

/** A quoted relative path in interpreter code, as in open('runtime-state.sqlite', 'w') after a cd. */
function namesRelativeLiteral(code: string, names: DirectoryNames): boolean {
  return [...code.matchAll(/(['"])([^'"\n]+)\1/g)].some((match) =>
    relativeReaches(match[2] ?? '', names, true),
  );
}

/**
 * Whether a relative path, read from each directory the command cd's into,
 * reaches the protected directory or a protected part of it. A bare word
 * (find sqlite) counts only when it names an entry that exists there, so
 * command names, shell keywords and option values are not taken as paths; in
 * program code a file name (runtime-state.sqlite-wal) counts before it exists.
 */
function relativeReaches(token: string, names: DirectoryNames, files: boolean): boolean {
  const directories = names.workingDirectories ?? [];
  if (directories.length === 0 || !token) return false;
  if (/^[-/\\~$%]|^[A-Za-z]:|^[sy][^\w\s\\]|[=<>|;&(){}]/.test(token)) return false;
  const segments = literalSegments(token);
  const last = segments.at(-1) ?? '';
  if (!files && !/[*?[]/.test(last) && /\.[^.]+$/.test(last)) return false;
  const pathLike = looksLikePath(token, files);
  return directories.some((directory) => {
    const target = path.join(directory, ...segments);
    if (!pathLike && !existsSync(target)) return false;
    return (
      target === names.root || (isInside(names.root, target) && names.protects(names.root, target))
    );
  });
}

/** A relative path written as one: ./x, a separator or a glob, or in code a file name. */
function looksLikePath(token: string, files: boolean): boolean {
  return (
    /^\.\.?(?:[\\/]|$)|[*?[\\/]/.test(token) || (files && /^[\w.-]+\.[A-Za-z][\w-]*$/.test(token))
  );
}

/** Pipelines between ;, && and newlines, with a for / while / until loop kept whole. */
function shellPipelines(text: string): string[] {
  const pipelines: string[] = [];
  let loop: string[] = [];
  let depth = 0;
  for (const segment of splitShellSourceSegments(text, true)) {
    const opens = SHELL_LOOP.test(segment);
    if (depth === 0 && !opens) {
      pipelines.push(segment);
      continue;
    }
    loop.push(segment);
    depth += (opens ? 1 : 0) - (/^done\b/.test(segment) ? 1 : 0);
    if (depth <= 0) {
      pipelines.push(loop.join('; '));
      loop = [];
      depth = 0;
    }
  }
  // A loop without done is not a shell loop (PowerShell's while closes with a brace): keep its parts apart.
  pipelines.push(...loop);
  return pipelines;
}

/**
 * Lines joined into the statements they continue: a line inside an open
 * bracket (a ForEach-Object or foreach block), after a trailing pipe, backtick
 * or backslash, or starting with a pipe belongs to the statement before it.
 */
function shellStatements(text: string): string[] {
  const statements: string[] = [];
  let open = 0;
  for (const line of text.split(/\r?\n/)) {
    const last = statements.at(-1);
    if (last !== undefined && (open > 0 || /[|\x60\\]\s*$/.test(last) || /^\s*\|/.test(line))) {
      statements[statements.length - 1] = `${last}\n${line}`;
    } else {
      statements.push(line);
    }
    open = Math.max(0, open + bracketBalance(line));
  }
  return statements;
}

/** Brackets a line opens, less those it closes, outside quoted strings. */
function bracketBalance(line: string): number {
  let balance = 0;
  for (const character of line.replace(/'[^']*'|"(?:[^"\x60]|\x60.)*"/g, '')) {
    if (character === '{' || character === '(') balance += 1;
    else if (character === '}' || character === ')') balance -= 1;
  }
  return balance;
}

/**
 * Whether program text names the directory itself or a protected part of it.
 * With directories, a protected part counts only when it is a directory (its
 * last segment has no extension) or a glob: naming one file says nothing about
 * where a command writes. Without joinedDirectory, building the
 * directory itself from the home directory (as tools do to find its config)
 * does not count; a join that reaches a protected part still does.
 * @internal Exported only for focused tests.
 */
export function namesProtectedPath(
  text: string,
  names: DirectoryNames,
  options: { readonly directories?: boolean; readonly joinedDirectory?: boolean } = {},
): boolean {
  return references(text, names).some(({ segments, joined }) => {
    if (segments.length === 0) return !joined || options.joinedDirectory !== false;
    const last = segments.at(-1) ?? '';
    if (options.directories && !/[*?[]/.test(last) && /\.[^.]+$/.test(last)) return false;
    return names.protects(names.root, path.join(names.root, ...segments));
  });
}

/**
 * Targets PowerShell write commands name, such as Copy-Item's destination or
 * Set-Content -Path. Variables the command assigns a literal path are read as
 * that path, and relative targets resolve from the last Set-Location. A write
 * command whose targets cannot be read (a wildcard, an expression), or a
 * relative target after a Set-Location that names protected state without a
 * literal path, counts when it names or lands in a protected path.
 * @internal Exported only for focused tests.
 */
export function powerShellWritesInside(
  text: string,
  scope: {
    readonly root: string;
    readonly workspaceDir?: string;
    readonly protects: Protects;
    /** Enables the fallbacks for targets that cannot be resolved. */
    readonly names?: DirectoryNames;
  },
): boolean {
  const state: PowerShellState = {
    location: scope.workspaceDir,
    protectedLocation: false,
    variables: new Map(),
    pushed: [],
  };
  return splitCommand(text).some((segment) =>
    powerShellStatementWritesInside(segment.trim(), state, scope),
  );
}

interface PowerShellLocation {
  location: string | undefined;
  /** The current directory names protected state but is not a literal path. */
  protectedLocation: boolean;
}

interface PowerShellState extends PowerShellLocation {
  readonly variables: Map<string, string>;
  /** Locations Push-Location left, which Pop-Location returns to. */
  readonly pushed: PowerShellLocation[];
}

/**
 * Applies a statement that only changes state (an assignment, a location
 * change) and returns the command left to judge, with known variables read.
 */
function followStatement(
  statement: string,
  state: PowerShellState,
  names: DirectoryNames | undefined,
): string | undefined {
  // An assignment replaces what the variable held; recordAssignment keeps it only when literal.
  const assigned = /^\$([A-Za-z_]\w*)\s*=(?!=)/.exec(statement)?.[1];
  if (assigned) state.variables.delete(assigned.toLowerCase());
  const command = substituteVariables(statement, state.variables);
  if (!command || recordAssignment(command, state.variables)) return undefined;
  return moveLocation(command, state, names) ? undefined : command;
}

function powerShellStatementWritesInside(
  statement: string,
  state: PowerShellState,
  scope: Parameters<typeof powerShellWritesInside>[1],
): boolean {
  const command = followStatement(statement, state, scope.names);
  if (!command) return false;
  const raw = readWindowsWriteTargets(command, 'powershell', false);
  const operands = readWindowsCopyOrMoveOperands(command, 'powershell');
  // A move takes its sources away, so they are written as much as its destination.
  const moved = operands?.move ? operands.sources : [];
  const targets = [...(raw ?? []), ...readWindowsRedirectionTargets(command), ...moved];
  if (state.protectedLocation && targets.some((target) => !WINDOWS_ROOTED.test(target))) {
    return true;
  }
  const variables = readPowerShellPathVariables(command);
  const reaches = (target: string) => targetWritesInside(target, state.location, variables, scope);
  if (!raw && unreadableWriteInside(command, operands, reaches, scope.names)) return true;
  return targets.some(reaches) || moved.some((source) => holdsRoot(source, state.location, scope));
}

/**
 * A write command whose targets the shared reader cannot read (a wildcard
 * source, a path it takes for a switch): a copy or move is judged by its
 * destination (a move's sources are judged with the other targets); any other
 * write counts when the statement names protected state.
 */
function unreadableWriteInside(
  command: string,
  operands: WindowsCopyOrMoveOperands | undefined,
  reaches: (target: string) => boolean,
  names: DirectoryNames | undefined,
): boolean {
  if (!names || !isWindowsWriteOrDeleteCommand(command, 'powershell')) return false;
  if (operands?.destination === undefined) return namesProtectedPath(command, names);
  return reaches(operands.destination);
}

/** Moving the data directory itself, or a directory that holds it, takes it away too. */
function holdsRoot(
  source: string,
  location: string | undefined,
  { root }: Parameters<typeof powerShellWritesInside>[1],
): boolean {
  const [resolved] = resolveWindowsTargets([source], location).resolved;
  if (resolved === undefined) return false;
  const paths = WINDOWS_ROOTED.test(root) ? path.win32 : path;
  const relative = paths.relative(resolved, root);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
  );
}

/**
 * One write target, resolved from the current location. A target that cannot
 * be resolved (an expression, no known location) counts when it names
 * protected state itself; a source argument naming it does not make a copy
 * out a write in.
 */
function targetWritesInside(
  target: string,
  location: string | undefined,
  variables: ReturnType<typeof readPowerShellPathVariables>,
  { root, protects, names }: Parameters<typeof powerShellWritesInside>[1],
): boolean {
  const [resolved] = resolveWindowsTargets([target], location, variables).resolved;
  if (resolved === undefined) return names !== undefined && namesProtectedPath(target, names);
  return protects(root, path.isAbsolute(resolved) ? canonicalPath(resolved) : resolved);
}

const WINDOWS_ROOTED = /^(?:[A-Za-z]:[\\/]|\\\\)/;
/** The home directory at the start of a location, as PowerShell writes it. */
const HOME_LOCATION = /^(?:~|\$env:USERPROFILE|\$\{env:USERPROFILE\}|\$HOME)(?=$|[\\/])/i;

/** A location with the home directory written out, when the home is drive-rooted. */
function expandHome(location: string | undefined, home: string | undefined): string | undefined {
  if (!location || !home || !WINDOWS_ROOTED.test(home)) return location;
  return location.replace(HOME_LOCATION, () => home);
}

/** Follows a Set-Location, Push-Location or Pop-Location statement; false for anything else. */
function moveLocation(
  command: string,
  state: PowerShellState,
  names: DirectoryNames | undefined,
): boolean {
  const program = /^\S+/.exec(command)?.[0].toLowerCase() ?? '';
  if (program === 'pop-location' || program === 'popd') {
    // With nothing pushed, Pop-Location fails and the location stays.
    const previous = state.pushed.pop();
    if (previous) Object.assign(state, previous);
    return true;
  }
  const moved = readLocation(command, state.location, names?.homeDir);
  if (!moved) return false;
  if (program === 'push-location' || program === 'pushd') {
    state.pushed.push({ location: state.location, protectedLocation: state.protectedLocation });
  }
  state.location = moved.literal;
  state.protectedLocation =
    moved.literal === undefined && names !== undefined && namesProtectedPath(command, names);
  return true;
}

/** $name = 'literal path' (or "..."), remembered so later statements read the path. */
function recordAssignment(command: string, variables: Map<string, string>): boolean {
  const match = /^\$([A-Za-z_]\w*)\s*=\s*(['"])([^'"\n]*)\2$/.exec(command);
  if (!match?.[1] || match[3] === undefined) return false;
  variables.set(match[1].toLowerCase(), match[3]);
  return true;
}

function substituteVariables(command: string, variables: ReadonlyMap<string, string>): string {
  if (variables.size === 0) return command;
  return command.replace(
    /\$([A-Za-z_]\w*)(?![\w:])/g,
    (whole, name: string) => variables.get(name.toLowerCase()) ?? whole,
  );
}

/**
 * A Set-Location / cd / Push-Location statement: the drive-rooted directory it
 * moves to, resolved from the current one when relative, or no literal path.
 * The home directory (~, $env:USERPROFILE, $HOME) reads as the drive-rooted home.
 */
function readLocation(
  command: string,
  current: string | undefined,
  home: string | undefined,
): { readonly literal?: string } | undefined {
  const tokens = [...command.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
  const [program, ...args] = tokens;
  if (!program || !LOCATION_COMMANDS.has(program.toLowerCase())) return undefined;
  const operand = expandHome(
    args.find((arg) => !/^-(?:path|literalpath)$/i.test(arg)),
    home,
  );
  if (!operand || /[$*?(\x60]/.test(operand) || operand.startsWith('~')) return {};
  if (/^[A-Za-z]:[\\/]/.test(operand)) return { literal: operand };
  return current && WINDOWS_ROOTED.test(current)
    ? { literal: path.win32.resolve(current, operand) }
    : {};
}

/**
 * The directories a command moves to with cd, Set-Location or Push-Location,
 * read as PowerShell does: Windows paths keep their backslashes, and a
 * relative location resolves from the one before it, starting at each base.
 * @internal Exported only for focused tests.
 */
export function powerShellLocations(
  command: string,
  bases: readonly string[],
  home: string,
): string[] {
  const found = new Set<string>();
  for (const base of bases) {
    let current: string | undefined = base;
    for (const segment of splitCommand(command)) {
      const moved = readLocation(segment.trim(), current, home);
      if (!moved) continue;
      current = moved.literal;
      if (current) found.add(current);
    }
  }
  return [...found];
}

/** The command with interpreter-fed code cut out, and that code, wrappers in wrappers included. */
function splitCodeBodies(command: string): { outer: string; bodies: string[] } {
  const { outer, bodies } = cutCodeBodies(command);
  const all = [...bodies];
  let level = bodies;
  for (let depth = 0; depth < 2 && level.length > 0; depth += 1) {
    level = level.flatMap((body) => cutCodeBodies(body).bodies);
    all.push(...level);
  }
  return { outer, bodies: all };
}

function cutCodeBodies(command: string): { outer: string; bodies: string[] } {
  const bodies: string[] = [];
  let outer = command;
  for (const pattern of CODE_BODIES) {
    outer = outer.replace(pattern, (...groups: unknown[]) => {
      const captures = groups
        .slice(1, -2)
        .filter((value): value is string => typeof value === 'string');
      bodies.push(captures.at(-1) ?? '');
      return ' ';
    });
  }
  return { outer, bodies };
}

interface Reference {
  /** Literal path segments after the directory; none for the directory itself. */
  readonly segments: string[];
  /** Built from the home directory in code rather than written as a path. */
  readonly joined: boolean;
}

/** Every name of the directory in the text, with the literal segments after it. */
function references(text: string, names: DirectoryNames): Reference[] {
  const found: Reference[] = [];
  for (const spelling of names.spellings) {
    const absolute = new RegExp(absolutePattern(spelling) + NOT_PATH_AFTER + CONTINUATION, 'gi');
    for (const match of text.matchAll(absolute)) {
      found.push({ segments: literalSegments(match[1] ?? ''), joined: false });
    }
    const relative = homeRelative(spelling, names.homeDir);
    if (!relative) continue;
    const body = relative.map(escapeRegExp).join(SEPARATOR);
    const home = new RegExp(
      /(?<![\w$%{}-])/.source + HOME_PREFIX + SEPARATOR + body + NOT_PATH_AFTER + CONTINUATION,
      'gi',
    );
    for (const match of text.matchAll(home)) {
      found.push({ segments: literalSegments(match[1] ?? ''), joined: false });
    }
    if (HOME_EXPRESSION.test(text)) {
      for (const segments of joinedFromHome(text, relative)) found.push({ segments, joined: true });
    }
  }
  return found;
}

/** The directory spelled as an absolute path, with either separator. */
function absolutePattern(spelling: string): string {
  const tokens = spelling.split(/[\\/]+/);
  const body = tokens.filter(Boolean).map(escapeRegExp).join(SEPARATOR);
  return /^[A-Za-z]:$/.test(tokens[0] ?? '')
    ? /(?<![\w.-])/.source + body
    : /(?<![\w.~$%}-])/.source + SEPARATOR + body;
}

/** The directory's segments below the home directory, compared without regard to case. */
function homeRelative(spelling: string, homeDir: string): string[] | undefined {
  const target = spelling.split(/[\\/]+/).filter(Boolean);
  const home = homeDir.split(/[\\/]+/).filter(Boolean);
  if (home.length === 0 || target.length <= home.length) return undefined;
  const under = home.every((token, index) => token.toLowerCase() === target[index]?.toLowerCase());
  return under ? target.slice(home.length) : undefined;
}

/** Quoted literals that start with the directory's name, as in join(homedir(), '.minimax', 'v2'). */
function joinedFromHome(text: string, relative: readonly string[]): string[][] {
  const found: string[][] = [];
  for (const match of text.matchAll(/(['"])([^'"\n]*)\1/g)) {
    const tokens = (match[2] ?? '').split(/[\\/]+/).filter(Boolean);
    if (tokens.length < relative.length) continue;
    const starts = relative.every(
      (token, index) => token.toLowerCase() === tokens[index]?.toLowerCase(),
    );
    if (!starts) continue;
    const segments = tokens.slice(relative.length);
    let rest = text.slice((match.index ?? 0) + match[0].length);
    for (;;) {
      const next = /^\s*[,/+]\s*(['"])([^'"\n]*)\1/.exec(rest);
      if (!next) break;
      segments.push(...(next[2] ?? '').split(/[\\/]+/).filter(Boolean));
      rest = rest.slice(next[0].length);
    }
    found.push(literalSegments(segments.join('/')));
  }
  return found;
}

/** Segments up to the first one only the shell or the program expands; a glob segment ends them. */
function literalSegments(continuation: string): string[] {
  const segments: string[] = [];
  for (const segment of continuation.split(/[\\/]+/)) {
    if (!segment) continue;
    if (/[$%\x60{}]/.test(segment)) break;
    segments.push(segment);
    if (/[*?[]/.test(segment)) break;
  }
  return segments;
}

/** The text of each local script an interpreter in these commands runs (the first one each names). */
async function executedScriptTexts(
  commands: readonly string[],
  bases: readonly string[],
  home: string,
): Promise<{ readonly text: string; readonly file: string }[]> {
  const texts: { text: string; file: string }[] = [];
  const named = [...new Set(commands.flatMap(executedScripts))];
  for (const raw of named.slice(0, MAX_SCRIPT_FILES)) {
    const expanded = /^~[\\/]/.test(raw) ? path.join(home, raw.slice(2)) : raw;
    const candidates = path.isAbsolute(expanded)
      ? [expanded]
      : bases.map((base) => path.resolve(base, expanded));
    for (const candidate of candidates) {
      const text = await readScript(candidate);
      if (text === undefined) continue;
      texts.push({ text: withoutComments(text, candidate), file: candidate });
      break;
    }
  }
  return texts;
}

/** Script paths a segment runs: the first script argument after an interpreter, or the program itself. */
function executedScripts(command: string): string[] {
  const scripts: string[] = [];
  for (const segment of splitCommand(command)) {
    const tokens = [...segment.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(
      (match) => match[1] ?? match[2] ?? match[3] ?? '',
    );
    let interpreter = false;
    for (const [index, token] of tokens.entries()) {
      const program = programName(token);
      if (
        SCRIPT_EXTENSION.test(token) &&
        !isWholeCommand(token) &&
        (interpreter || index === 0 || /^[&.]$/.test(tokens[index - 1] ?? ''))
      ) {
        scripts.push(token);
        break;
      }
      if (INTERPRETERS.has(program)) interpreter = true;
    }
  }
  return scripts;
}

/** A quoted command such as "python3 restore.py", which a wrapper runs, is not a script path. */
function isWholeCommand(token: string): boolean {
  const [first, ...rest] = token.trim().split(/\s+/);
  return rest.length > 0 && INTERPRETERS.has(programName(first ?? ''));
}

/** A program as INTERPRETERS lists it: no directory, .exe or version suffix (python3.12 is python). */
function programName(token: string): string {
  return path
    .basename(token.replaceAll('\\', '/'))
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/(?<=[a-z])\d+(?:\.\d+)*$/, '');
}

/**
 * Quoted strings first, so comment markers inside one (glob patterns often
 * hold them) are kept, then the comment forms a language may use.
 */
const STRING_OR_COMMENT =
  /(?<string>'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|\x60(?:\\.|[^\x60\\])*\x60)|(?<block>\/\*[\s\S]*?\*\/)|(?<powershell><#[\s\S]*?#>)|(?<slashes>\/\/[^\n]*)|(?<=^|[ \t])(?<hash>#[^\n]*)/gm;
/** Languages with block and double-slash comments, where # is not a comment. */
const C_STYLE = /\.(?:[cm]?js|[cm]?ts|jse|php)$/i;

/**
 * Comments say where a tool looks, not what it does: drop the comments the
 * script's language has, outside quoted strings. JavaScript's # is a private
 * field, Python's // divides and PowerShell's // is plain text.
 */
function withoutComments(text: string, file: string): string {
  const cStyle = C_STYLE.test(file);
  const hash = !/\.(?:[cm]?js|[cm]?ts|jse)$/i.test(file);
  const powershell = /\.psm?1$/i.test(file);
  return text.replace(STRING_OR_COMMENT, (match, ...rest: unknown[]) => {
    const groups = rest.at(-1) as Record<string, string | undefined>;
    if (groups.block !== undefined) return cStyle ? ' ' : match;
    if (groups.slashes !== undefined) return cStyle ? '' : match;
    if (groups.powershell !== undefined) return powershell ? ' ' : match;
    if (groups.hash !== undefined) return hash ? '' : match;
    return match;
  });
}

async function readScript(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) return undefined;
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}
