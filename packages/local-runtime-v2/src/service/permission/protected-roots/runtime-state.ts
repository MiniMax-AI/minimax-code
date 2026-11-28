import { homedir } from 'node:os';
import path from 'node:path';

import type { Protects } from './canonical-paths.js';
import type { RuntimeProtectedRoot } from './protected-roots.js';

/** What the Agent reads when a write to the app's own state is denied. */
const RUNTIME_STATE_DENIAL =
  "This path is the running MiniMax Code app's own state: its databases, sign-in credentials, " +
  'session history or background-task records. No Session may write, move or delete it, in any ' +
  'permission mode, and no rule can allow it. A command or script that names it next to a ' +
  'file-writing call counts as writing it, even when it only copies data out. Reading it is ' +
  'fine: to work on a copy, copy it out with one plain cp, Copy-Item or robocopy command and ' +
  'point the script at the copy. Do not try another way to change it; if the user needs it ' +
  'changed, ask them to quit MiniMax Code and do it themselves.';

/** Top-level directories only the runtime writes (lower case), sign-in credentials included. */
const STATE_DIRECTORIES: ReadonlySet<string> = new Set([
  'v2',
  'auth',
  'background-tasks',
  'run',
  'cli-auth',
  'mcp-oauth',
  'credentials',
]);
/** Top-level files only the runtime writes (lower case), besides databases. */
const STATE_FILES: ReadonlySet<string> = new Set(['local-runtime.auth.json', 'codex-auth.json']);
/** A SQLite database and its WAL, shared-memory and rollback journal files. */
const DATABASE_FILE = /\.(?:sqlite|db)(?:-wal|-shm|-journal)?$/i;
/**
 * Parts of v2/ the running app does not depend on: logs and pre-migration
 * database backups (safe to delete), the extension dev directories the Agent
 * authors in, and the data directories plugins and hooks own.
 */
const WRITABLE_V2: ReadonlyArray<readonly string[]> = [
  ['observability'],
  ['sqlite', 'backups'],
  ['plugin-dev'],
  ['plugin-data'],
  ['hook-data'],
];
/** Names a top-level glob is tested against: one of each kind of protected entry. */
const STATE_NAMES: readonly string[] = [
  ...STATE_DIRECTORIES,
  ...STATE_FILES,
  'runtime-state.sqlite',
  'runtime-state.sqlite-wal',
  'sqlite.db',
  'sqlite.db-shm',
];

/**
 * The parts of the data directory only the running app writes: everything
 * under v2/ (except the parts in WRITABLE_V2), auth/, background-tasks/, run/,
 * the stored sign-in credentials (cli-auth/, mcp-oauth/, credentials/,
 * codex-auth.json, local-runtime.auth.json) and the SQLite databases at the
 * top level. Configuration, skills, plugins, agents and
 * memory stay with the ordinary policy: users change them through the Agent.
 * APFS and NTFS ignore case by default, so names are compared that way.
 * @internal Exported only for focused tests.
 */
export const protectsRuntimeState: Protects = (root, target) => {
  // A drive-letter root is a Windows path wherever it is checked.
  const paths = /^[A-Za-z]:[\\/]/.test(root) ? path.win32 : path;
  const relative = paths.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) {
    return false;
  }
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  return protectsStatePath(segments);
};

/** Whether the path below the data directory, as segments, is runtime state. */
function protectsStatePath(segments: readonly string[]): boolean {
  const [first] = segments;
  if (!first) return false;
  if (/[*?[]/.test(first)) {
    const pattern = globPattern(first);
    return STATE_NAMES.some((name) => pattern.test(name));
  }
  const name = first.toLowerCase();
  if (name === 'v2') {
    return !WRITABLE_V2.some((prefix) =>
      prefix.every((part, index) => segments[index + 1]?.toLowerCase() === part),
    );
  }
  if (STATE_DIRECTORIES.has(name)) return true;
  return segments.length === 1 && (STATE_FILES.has(name) || DATABASE_FILE.test(name));
}

/**
 * The running app's own state, for every Session: the data directory and the
 * default ~/.minimax, which another profile's app may hold open. Shell write
 * targets are parsed; code handed to an interpreter is read for names.
 */
export function runtimeStateProtectedRoots(
  dataDir: string,
  homeDir: string = homedir(),
): RuntimeProtectedRoot[] {
  const directories = [path.resolve(dataDir), path.resolve(homeDir, '.minimax')];
  return directories
    .filter(
      (directory, index) =>
        directories.findIndex((other) => path.relative(other, directory) === '') === index,
    )
    .map((directory) => ({
      directory,
      protects: protectsRuntimeState,
      scripts: true,
      reason: RUNTIME_STATE_DENIAL,
    }));
}

function globPattern(segment: string): RegExp {
  const body = segment
    .split('')
    .map((char) => {
      if (char === '*') return '.*';
      if (char === '?') return '.';
      if (char === '[' || char === ']') return char;
      return char.replace(/[.+^$(){}|\\]/g, '\\$&');
    })
    .join('');
  try {
    return new RegExp(`^${body}$`, 'i');
  } catch {
    // An unbalanced class cannot be read; treat it as matching anything.
    return /^/;
  }
}
