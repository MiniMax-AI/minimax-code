/**
 * Add `<dataDir>/bin` to the user's shell or user-level PATH so that
 * `mavis`, `minimax`, and `mavis-trash` are available in new terminal
 * sessions.
 *
 * Best-effort: failures are swallowed — PATH integration must never block
 * local-runtime startup.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PATH_MARKER = '# Added by MiniMax Code';

export function ensurePathIntegration(dataDir: string): void {
  const binDir = join(dataDir, 'bin');

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

// ---------------------------------------------------------------------------
// POSIX (macOS / Linux)
// ---------------------------------------------------------------------------

function ensurePosixShellPath(binDir: string): void {
  const home = homedir();
  const rcFiles =
    process.platform === 'darwin'
      ? [join(home, '.zshrc'), join(home, '.bashrc')]
      : [join(home, '.bashrc'), join(home, '.zshrc')];
  const exportLine = `export PATH="${binDir}:$PATH"`;

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
    const hasBinDir = currentPath
      .split(';')
      .some((entry) => entry.trim().replace(/\\/g, '/').toLowerCase() === normalizedBinDir);
    if (hasBinDir) return;
  } catch {
    // Timeout, access errors, missing key, etc. must never trigger an overwrite.
    return;
  }

  const newPath = currentPath ? `${binDir};${currentPath}` : binDir;
  execFileSync(
    'reg',
    ['add', 'HKCU\\Environment', '/v', 'Path', '/t', registryType, '/d', newPath, '/f'],
    { timeout: 5000, stdio: 'ignore', windowsHide: true },
  );
}
