/**
 * Add `<dataDir>/bin` to the user's shell or user-level PATH so that
 * `mavis`, `minimax`, and `mavis-trash` are available in new terminal
 * sessions.
 *
 * POSIX rc files are commonly synced across machines (dotfiles repos,
 * iCloud Drive), so exports use a portable `$HOME`-relative path whenever the
 * bin directory lives under the user's home, and existing equivalent
 * entries — absolute, `$HOME/...`, or `~/...` — are recognized instead of
 * only the marker this module writes.
 *
 * Set MCODE_NO_MODIFY_PATH to opt out entirely, matching the external
 * installer contract in scripts/mcode-external-install.
 *
 * Ephemeral dataDirs are also skipped: when `dataDir` lives under
 * `os.tmpdir()` (e.g. an `mkdtemp` scratch dir used by unit tests or a
 * one-off smoke run), persisting `<tmpdir>/<rand>/bin` to the user's
 * shell rc or `HKCU\Environment` would leak a doomed path into every
 * future terminal session long after the directory is removed.
 *
 * Best-effort: failures are swallowed — PATH integration must never block
 * local-runtime startup.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { posix, win32 } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const PATH_MARKER = '# Added by MiniMax Code';

/** Use explicit platform semantics for Windows drives and POSIX separators. */
function pathMod(): typeof posix {
  return process.platform === 'win32' ? win32 : posix;
}

export function ensurePathIntegration(dataDir: string): void {
  if (process.env.MCODE_NO_MODIFY_PATH) return;
  if (isEphemeralDataDir(dataDir)) return;
  if (isDevelopmentProfileDataDir(dataDir)) return;
  const p = pathMod();
  const binDir = p.join(dataDir, 'bin');

  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      ensurePosixShellPath(binDir);
    } else if (process.platform === 'win32') {
      ensureWindowsUserPath(binDir);
    }
  } catch {
    // Best-effort — never block startup.
  }
}

/**
 * Data directory basenames owned by this product: the default `.minimax` /
 * legacy `.mavis`, optionally suffixed by a `-<profile>`.
 */
const DATA_DIR_BASENAME = /^\.(?:minimax|mavis)(?:-(.+))?$/iu;

/**
 * Profile-scoped data dirs (`.minimax-<branch>`) only come from development
 * entry points: worktree branch detection in agent-archon/mavis checkouts,
 * `--profile`, or the opt-in legacy runtime env. Each branch would otherwise
 * persist its own `bin` into every future terminal; the running process
 * still receives the directory through in-process PATH injection.
 */
function isDevelopmentProfileDataDir(dataDir: string): boolean {
  const p = pathMod();
  return Boolean(DATA_DIR_BASENAME.exec(p.basename(p.resolve(dataDir)))?.[1]);
}

// ---------------------------------------------------------------------------
// Ephemeral dataDir detection
// ---------------------------------------------------------------------------

/**
 * True when `dataDir` lives under the system scratch directory. Containment
 * is delegated to `pathMod().relative` / `.isAbsolute`, so the check
 * follows the exact path semantics of the (possibly mocked) platform:
 * case-insensitive, drive-aware, and separator-agnostic on Windows;
 * case-sensitive, single-root, and forward-slash-only on POSIX.
 *
 * An empty `os.tmpdir()` is treated as "no containment known" so a
 * misconfigured runtime never silently disables PATH integration for a
 * real install.
 */
function isEphemeralDataDir(dataDir: string): boolean {
  const tmpRoot = tmpdir();
  if (!tmpRoot) return false;
  return isPathInside(tmpRoot, dataDir);
}

function isPathInside(root: string, candidate: string): boolean {
  const p = pathMod();
  const rel = p.relative(p.resolve(root), p.resolve(candidate));
  if (rel === '' || rel === '.') return true;
  if (rel === '..' || rel.startsWith(`..${p.sep}`)) return false;
  // `path.win32.relative` returns an absolute path when the two inputs
  // live on different drives; `path.posix.relative` stays relative, but
  // isAbsolute is harmless there.
  if (p.isAbsolute(rel)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// POSIX (macOS / Linux)
// ---------------------------------------------------------------------------

function ensurePosixShellPath(binDir: string): void {
  const p = pathMod();
  const home = homedir();
  const rcFiles =
    process.platform === 'darwin'
      ? [p.join(home, '.zshrc'), p.join(home, '.bashrc')]
      : [p.join(home, '.bashrc')];
  const exportLine = `export PATH="${portableBinDir(binDir, home)}:$PATH"`;

  for (const rc of rcFiles) {
    try {
      const content = existsSync(rc) ? readFileSync(rc, 'utf-8') : '';
      if (content.includes(PATH_MARKER)) continue;
      appendFileSync(rc, `\n${PATH_MARKER}\n${exportLine}\n`);
    } catch {
      // Individual shell config failures must not prevent updating the next one.
    }
  }
}

/**
 * Express `binDir` relative to `$HOME` when possible: synced rc files must
 * not embed the current machine's absolute home path (e.g. a different
 * macOS username or Linux /home layout on another machine).
 */
function portableBinDir(binDir: string, home: string): string {
  const p = pathMod();
  const homePrefix = home.endsWith(p.sep) ? home : `${home}${p.sep}`;
  if (!binDir.startsWith(homePrefix)) return binDir;
  return `$HOME/${binDir.slice(homePrefix.length)}`;
}

/**
 * True when the rc file already puts the bin directory on PATH — entries
 * users added by hand or an older version wrote with an absolute path — so
 * we never append a duplicate.
 *
 * Only effective configuration lines count: a commented-out export must not
 * block integration, and the directory must match as a complete PATH entry
 * rather than the prefix of a longer name (e.g. `.minimax/bin-old`).
 */
function rcReferencesBinDir(content: string, binDir: string, home: string): boolean {
  const spellings = equivalentBinDirSpellings(binDir, home);
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    for (const spelling of spellings) {
      if (lineContainsPathEntry(line, spelling)) return true;
    }
  }
  return false;
}

function equivalentBinDirSpellings(binDir: string, home: string): string[] {
  const p = pathMod();
  const spellings = [binDir];
  const homePrefix = home.endsWith(p.sep) ? home : `${home}${p.sep}`;
  if (binDir.startsWith(homePrefix)) {
    const relative = binDir.slice(homePrefix.length);
    spellings.push(`$HOME/${relative}`, `\${HOME}/${relative}`, `~/${relative}`);
  }
  return spellings;
}

/**
 * True when `line` references `candidate` as a complete PATH entry: the
 * character after the match must end the directory name (path separator,
 * quote, whitespace, or line end), not continue it (`.minimax/bin-old`).
 */
function lineContainsPathEntry(line: string, candidate: string): boolean {
  let searchFrom = 0;
  for (;;) {
    const at = line.indexOf(candidate, searchFrom);
    if (at === -1) return false;
    const next = line.charAt(at + candidate.length);
    if (next === '' || next === ':' || next === '"' || next === "'" || /\s/.test(next)) {
      return true;
    }
    searchFrom = at + 1;
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function ensureWindowsUserPath(binDir: string): void {
  // Use execFileSync (not execSync) so cmd.exe does not expand values such as
  // %USERPROFILE% while the existing PATH is being read or written.
  const normalizedBinDir = binDir.replace(/\\/g, '/').toLowerCase();
  let currentPath = '';
  let registryType = 'REG_EXPAND_SZ';

  try {
    // Query the whole key: a successful listing can prove Path is absent.
    // A failed /v Path query cannot distinguish absence from read errors.
    const queryResult = execFileSync('reg', ['query', 'HKCU\\Environment'], {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Do not persist text that could not be decoded losslessly.
    if (queryResult.includes('\uFFFD')) return;
    const lines = queryResult.split(/\r?\n/).filter((line) => line.trim());
    if (lines.shift()?.trim().toLowerCase() !== 'hkey_current_user\\environment') return;
    let foundPath = false;
    for (const line of lines) {
      const value = line.match(/^\s+(.+?)\s+(REG_\w+)(?:[ \t]+(.*))?$/);
      // Never interpret unrecognized or partial output as a missing value.
      if (!value?.[1] || !value[2]) return;
      if (value[1].toLowerCase() !== 'path') continue;
      if (foundPath || !['REG_SZ', 'REG_EXPAND_SZ'].includes(value[2])) return;
      foundPath = true;
      registryType = value[2];
      currentPath = value[3] ?? '';
    }
    const entries = currentPath.split(';');
    const isOwnBinDir = (entry: string) =>
      entry.trim().replace(/\\/g, '/').toLowerCase() === normalizedBinDir;
    const kept = entries.filter((entry) => isOwnBinDir(entry) || !isStaleRuntimeBinEntry(entry));
    const hasBinDir = kept.some(isOwnBinDir);
    if (hasBinDir && kept.length === entries.length) return;
    currentPath = kept.join(';');
    if (hasBinDir) {
      writeWindowsUserPath(registryType, currentPath);
      return;
    }
  } catch {
    // Timeout, access errors, missing key, etc. must never trigger an overwrite.
    return;
  }

  writeWindowsUserPath(registryType, currentPath ? `${binDir};${currentPath}` : binDir);
}

function writeWindowsUserPath(registryType: string, value: string): void {
  execFileSync(
    'reg',
    ['add', 'HKCU\\Environment', '/v', 'Path', '/t', registryType, '/d', value, '/f'],
    { timeout: 5000, stdio: 'ignore', windowsHide: true },
  );
}

/**
 * Self-heal for earlier releases that persisted one `~/.minimax-<profile>/bin`
 * per development branch. Only the product's own data-dir layout directly
 * under the home directory qualifies: a `bin` elsewhere — including other
 * tools' directories under the system temp dir — may belong to software that
 * is merely being reinstalled. Entries with unexpanded variables or UNC paths
 * (whose existence checks can block for seconds) are never touched, and only
 * once the directory is gone.
 */
function isStaleRuntimeBinEntry(entry: string): boolean {
  const candidate = entry.trim();
  if (!/^[A-Za-z]:[\\/]/u.test(candidate) || candidate.includes('%')) return false;
  const p = win32;
  const resolved = p.resolve(candidate);
  if (p.basename(resolved).toLowerCase() !== 'bin') return false;
  const dataDir = p.dirname(resolved);
  const home = homedir();
  const ownLayout =
    Boolean(home) &&
    DATA_DIR_BASENAME.test(p.basename(dataDir)) &&
    p.resolve(p.dirname(dataDir)).toLowerCase() === p.resolve(home).toLowerCase();
  if (!ownLayout) return false;
  try {
    return !existsSync(resolved);
  } catch {
    return false;
  }
}
