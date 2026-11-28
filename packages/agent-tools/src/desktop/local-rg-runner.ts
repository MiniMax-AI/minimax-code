/**
 * Desktop-side ripgrep process runner — shared by the local grep / glob tools.
 *
 * Mirrors `cloud/sandbox-rg-runner.ts`: cloud delegates rg to the sandbox
 * `executeShell` channel; desktop spawns the bundled `@vscode/ripgrep` binary
 * (PATH `rg` fallback) directly on the user machine.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from '../shared/physical-fs.js';
import { createRequire } from 'node:module';
import { basename, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { type GrepTarget, resolveSearchRoot } from '../core-tools/paths.js';

export { type GrepTarget, resolveSearchRoot, textResult } from '../core-tools/paths.js';

const PATH_RG_FALLBACK = 'rg';
const ASAR_PATH_PATTERN = /\.asar([/\\])/;
const DEFAULT_RG_TIMEOUT_MS = 30_000;
// SIGTERM→SIGKILL grace window (P0-4). 5s mirrors reference CLI: rg stuck in
// uninterruptible IO may never see SIGTERM.
const KILL_GRACE_MS = 5_000;
// stdout byte safety cap (P1-5). Generous: normal searches never hit it;
// runaway output (broad pattern over a huge tree) gets killed early instead
// of ballooning process memory.
const MAX_RG_STDOUT_BYTES = 8 * 1024 * 1024;

/**
 * Resolve the ripgrep binary path.
 *
 * Prefers the binary bundled with `@vscode/ripgrep` (the same one the classic
 * Electron `file/grep.ts` uses) so local-runtime search works even when the host
 * has no system-wide ripgrep. Falls back to the bare `rg` command (resolved via
 * PATH) when the bundled binary cannot be located.
 *
 * Pure / dependency-injected so the resolution branches can be unit-tested
 * without spawning a process or mutating the real module graph.
 */
export function resolveRgBinaryPath(
  bundledRgPath: () => unknown,
  fileExists: (p: string) => boolean,
): string {
  try {
    const rgPath = bundledRgPath();
    if (typeof rgPath === 'string' && rgPath.length > 0) {
      const spawnPath = toSpawnableRgPath(rgPath);
      if (fileExists(spawnPath)) return spawnPath;
    }
  } catch {
    // fall through to PATH fallback
  }
  return PATH_RG_FALLBACK;
}

function toSpawnableRgPath(rgPath: string): string {
  return rgPath.replace(ASAR_PATH_PATTERN, '.asar.unpacked$1');
}

function readBundledRgPath(): string | undefined {
  const require = createRequire(import.meta.url);
  const rg = require('@vscode/ripgrep') as { rgPath?: unknown };
  return typeof rg.rgPath === 'string' ? rg.rgPath : undefined;
}

let cachedRgBinary: string | undefined;

function getRgBinary(): string {
  if (cachedRgBinary === undefined) {
    cachedRgBinary = resolveRgBinaryPath(readBundledRgPath, existsSync);
  }
  return cachedRgBinary;
}

export interface RgResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** stdout exceeded the byte safety cap and the process was killed early (P1-5). */
  stdoutTruncated: boolean;
  /** A caller-supplied complete-record limit was reached before process exit. */
  stdoutLimitReached: boolean;
}

/**
 * Resolve a grep target to an rg cwd + search path. A directory searches `.`
 * from within it; a single file runs rg from the file's parent with just the
 * basename — so `grep` works when pointed at one file, not only a directory
 * (ported from dev `local-search.ts` `resolveGrepTarget`, d8a411b20).
 */
export function resolveGrepTarget(workspaceRoot: string, inputPath?: string): GrepTarget {
  const resolvedPath = resolveSearchRoot(workspaceRoot, inputPath);
  if (!existsSync(resolvedPath)) throw new Error(`grep path does not exist: ${resolvedPath}`);
  const stats = statSync(resolvedPath);
  if (stats.isDirectory()) return { cwd: resolvedPath, searchPath: '.' };
  if (stats.isFile()) return { cwd: dirname(resolvedPath), searchPath: basename(resolvedPath) };
  throw new Error(`grep path must be a file or directory: ${resolvedPath}`);
}

export interface RunRgOptions {
  signal?: AbortSignal;
  /**
   * Overrides the resolved rg path — test-only injection point so
   * process-level branches (ENOENT, timeout, SIGKILL escalation, ...) are
   * exercisable without mutating the module-level binary cache.
   */
  binary?: string;
  /** Overrides the default timeout. Test-only. */
  timeoutMs?: number;
  /** Overrides the SIGTERM→SIGKILL grace window. Test-only. */
  killGraceMs?: number;
  /**
   * Byte-level safety cap on accumulated stdout (P1-5). Exceeding it kills
   * the process and flags `stdoutTruncated` — protects memory on runaway
   * output (broad patterns over huge trees). Content mode is already
   * bounded by --max-count; files/count modes need full output for exact
   * totals, so this stays a generous last-resort cap rather than a
   * per-result early stop.
   */
  maxStdoutBytes?: number;
  /** Keep only complete stdout lines matching this regex before byte accounting. */
  stdoutLineRegex?: RegExp;
  /** Stop the child after collecting this many matching stdout lines. */
  maxStdoutLines?: number;
  /** Delimiter used to count complete stdout records without buffering unbounded output. */
  stdoutRecordSeparator?: '\n' | '\0';
  /** Stop the child after collecting this many complete stdout records. */
  maxStdoutRecords?: number;
}

/**
 * Spawn ripgrep and collect its output.
 *
 * Termination (P0-4, mirrors reference CLI ripgrep.ts): on timeout/abort send
 * SIGTERM first; if the process is still alive after the grace window,
 * escalate to SIGKILL — rg can block in uninterruptible filesystem IO where
 * SIGTERM alone never lands. On Windows `kill('SIGTERM')` throws, so the
 * default `kill()` is used without escalation.
 */
export function runRg(args: string[], cwd: string, opts: RunRgOptions = {}): Promise<RgResult> {
  const {
    signal,
    binary,
    timeoutMs,
    killGraceMs,
    maxStdoutBytes,
    stdoutLineRegex,
    maxStdoutLines,
    stdoutRecordSeparator,
    maxStdoutRecords,
  } = opts;
  const stdoutCap = maxStdoutBytes ?? MAX_RG_STDOUT_BYTES;
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error('Operation aborted'));
      return;
    }

    const child = spawn(binary ?? getRgBinary(), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stdoutRemainder = '';
    let stdoutRecordRemainder = '';
    const stdoutDecoder = new StringDecoder('utf8');
    let stderr = '';
    let stdoutBytes = 0;
    let stdoutLines = 0;
    let stdoutRecords = 0;
    let stdoutTruncated = false;
    let stdoutLimitReached = false;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      if (process.platform === 'win32') {
        child.kill();
        return;
      }
      // Re-arming (timeout then abort, cap then abort, ...) replaces the
      // fallback timer instead of leaking the previous one.
      clearTimeout(killTimer);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, killGraceMs ?? KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs ?? DEFAULT_RG_TIMEOUT_MS);
    const abort = () => {
      terminate();
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        // Deliberately do NOT clear killTimer here: the caller gets the
        // rejection immediately, but the SIGTERM→SIGKILL escalation must
        // stay armed so a SIGTERM-ignoring rg cannot linger after a user
        // cancel. close/error clean it up once the process actually dies.
        reject(new Error('Operation aborted'));
      }
    };
    signal?.addEventListener('abort', abort, { once: true });

    const appendStdout = (text: string, processStillRunning = true) => {
      if (stdoutTruncated) return;
      stdout += text;
      stdoutBytes += Buffer.byteLength(text, 'utf-8');
      if (stdoutBytes > stdoutCap) {
        stdoutTruncated = true;
        if (processStillRunning) terminate();
      }
    };
    const normalizePathLine = (line: string) => line.replace(/\r$/, '').replaceAll('\\', '/');
    const handleStdoutText = (text: string) => {
      if (stdoutRecordSeparator) {
        const complete = `${stdoutRecordRemainder}${text}`.split(stdoutRecordSeparator);
        stdoutRecordRemainder = complete.pop() ?? '';
        const remainingRecords =
          maxStdoutRecords === undefined ? complete.length : maxStdoutRecords - stdoutRecords;
        const selected = complete.slice(0, Math.max(0, remainingRecords));
        if (selected.length > 0) {
          appendStdout(`${selected.join(stdoutRecordSeparator)}${stdoutRecordSeparator}`);
          stdoutRecords += selected.length;
        }
        if (
          !stdoutTruncated &&
          maxStdoutRecords !== undefined &&
          stdoutRecords >= maxStdoutRecords
        ) {
          stdoutLimitReached = true;
          stdoutTruncated = true;
          terminate();
        }
        return;
      }
      if (!stdoutLineRegex) {
        appendStdout(text);
        return;
      }
      const complete = `${stdoutRemainder}${text}`.split('\n');
      stdoutRemainder = complete.pop() ?? '';
      const matched = complete.filter((line) => stdoutLineRegex.test(normalizePathLine(line)));
      const remainingLines =
        maxStdoutLines === undefined ? matched.length : maxStdoutLines - stdoutLines;
      const selected = matched.slice(0, Math.max(0, remainingLines));
      if (selected.length > 0) {
        appendStdout(`${selected.join('\n')}\n`);
        stdoutLines += selected.length;
      }
      if (!stdoutTruncated && maxStdoutLines !== undefined && stdoutLines >= maxStdoutLines) {
        stdoutTruncated = true;
        terminate();
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return;
      handleStdoutText(stdoutDecoder.write(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      // Cleanup must run even when abort already settled the promise.
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (settled) return;
      settled = true;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new Error(
            'ripgrep binary not found: the bundled @vscode/ripgrep binary is unavailable and `rg` is not on PATH',
          ),
        );
        return;
      }
      reject(err);
    });
    child.on('close', (exitCode) => {
      // Cleanup must run even when abort already settled the promise —
      // this is where the (intentionally kept) abort kill fallback is
      // finally disarmed, after the process is confirmed dead.
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (settled) return;
      settled = true;
      if (!stdoutTruncated) handleStdoutText(stdoutDecoder.end());
      if (!stdoutTruncated && stdoutRecordSeparator && stdoutRecordRemainder.length > 0) {
        appendStdout(stdoutRecordRemainder, false);
      } else if (!stdoutTruncated && stdoutLineRegex && stdoutRemainder.length > 0) {
        if (stdoutLineRegex.test(normalizePathLine(stdoutRemainder))) {
          appendStdout(stdoutRemainder, false);
        }
      }
      if (stdoutTruncated && !stdoutLimitReached) {
        // The kill lands mid-chunk, so the tail line is almost certainly torn.
        // A partial path/content fragment would surface as a hallucinated
        // result — drop everything after the last complete line (mirrors
        // reference CLI's torn-tail handling in ripGrepStream).
        const separator = stdoutRecordSeparator ?? '\n';
        const lastSeparator = stdout.lastIndexOf(separator);
        stdout = lastSeparator < 0 ? '' : stdout.slice(0, lastSeparator + separator.length);
      }
      resolvePromise({
        exitCode,
        stdout,
        stderr,
        timedOut,
        stdoutTruncated,
        stdoutLimitReached,
      });
    });
  });
}
