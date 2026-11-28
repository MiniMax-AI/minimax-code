/**
 * file-read-ledger.ts — which file versions each session has read, so the
 * desktop write tool can refuse to overwrite a file the session never read or
 * that changed after its last read (another session, a command or an editor).
 *
 * Process-local and in memory only: records are keyed by session id and the
 * file's realpath, and hold the version seen at read time. Both
 * levels are bounded and drop the least recently used entry; losing a record
 * only means the session has to read the file again before overwriting it.
 * The tool instances are rebuilt for every Turn, which is why the records live
 * at module level rather than on an instance.
 *
 * Only the desktop tools use this. Cloud write keeps its advisory behaviour.
 */

import type { Stats } from 'node:fs';
import type { ToolResult } from '@mavis/agent-core/tools';

import { realpath, stat } from './physical-fs.js';

export const FILE_READ_LEDGER_MAX_SESSIONS = 200;
export const FILE_READ_LEDGER_MAX_FILES_PER_SESSION = 1000;

/**
 * What "unchanged since the read" compares. `ino` and `ctimeMs` catch a
 * same-size replacement that keeps the mtime (`cp -p`, `rsync -t`, `tar`);
 * a metadata-only change (chmod) then asks for one more read, never less.
 */
export interface FileVersion {
  readonly mtimeMs: number;
  readonly size: number;
  readonly ino: number;
  readonly ctimeMs: number;
}

/** The version of a regular file, or undefined for anything else. */
export function regularFileVersion(stats: Stats): FileVersion | undefined {
  if (!stats.isFile()) return undefined;
  return { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino, ctimeMs: stats.ctimeMs };
}

/** A regular file's realpath plus the version observed by one stat. */
export interface ObservedFileVersion {
  readonly key: string;
  readonly version: FileVersion;
}

export type WriteGuardErrorCode = 'WRITE_NOT_READ' | 'WRITE_STALE_READ';

/** Thrown inside the mutation queue to refuse an overwrite before any byte is written. */
export class WriteGuardRejectedError extends Error {
  constructor(
    readonly code: WriteGuardErrorCode,
    readonly recorded: FileVersion | undefined,
    readonly current: FileVersion,
  ) {
    super(code);
    this.name = 'WriteGuardRejectedError';
  }
}

const sessions = new Map<string, Map<string, FileVersion>>();

/** Look up a session's records, marking the session as most recently used. */
function sessionRecords(sessionId: string, create: boolean): Map<string, FileVersion> | undefined {
  const existing = sessions.get(sessionId);
  if (existing) {
    sessions.delete(sessionId);
    sessions.set(sessionId, existing);
    return existing;
  }
  if (!create) return undefined;
  const records = new Map<string, FileVersion>();
  sessions.set(sessionId, records);
  if (sessions.size > FILE_READ_LEDGER_MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  return records;
}

function recordedVersion(sessionId: string, key: string): FileVersion | undefined {
  const records = sessionRecords(sessionId, false);
  const version = records?.get(key);
  if (records && version) {
    records.delete(key);
    records.set(key, version);
  }
  return version;
}

function sameVersion(a: FileVersion, b: FileVersion): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino && a.ctimeMs === b.ctimeMs;
}

/**
 * Stat a regular file. Returns undefined when it is missing, is not a regular
 * file, or cannot be inspected — callers then record nothing.
 */
export async function observeFileVersion(path: string): Promise<ObservedFileVersion | undefined> {
  try {
    const version = regularFileVersion(await stat(path));
    if (!version) return undefined;
    return { key: await realpath(path), version };
  } catch {
    return undefined;
  }
}

export function rememberFileVersion(sessionId: string, observed: ObservedFileVersion): void {
  const records = sessionRecords(sessionId, true);
  if (!records) return;
  records.delete(observed.key);
  records.set(observed.key, observed.version);
  if (records.size > FILE_READ_LEDGER_MAX_FILES_PER_SESSION) {
    const oldest = records.keys().next().value;
    if (oldest !== undefined) records.delete(oldest);
  }
}

/** Record the file's current version for the session (after its own write or edit). */
export async function rememberCurrentFileVersion(sessionId: string, path: string): Promise<void> {
  const observed = await observeFileVersion(path);
  if (observed) rememberFileVersion(sessionId, observed);
}

/** Whether the session's record matches the file as it is now. */
export async function isRememberedVersionCurrent(
  sessionId: string,
  path: string,
): Promise<boolean> {
  const observed = await observeFileVersion(path);
  if (!observed) return false;
  const recorded = recordedVersion(sessionId, observed.key);
  return recorded !== undefined && sameVersion(recorded, observed.version);
}

/**
 * Overwrite check, run inside the mutation queue with the target's pre-write
 * version (undefined when there is no regular file to overwrite). Throws
 * {@link WriteGuardRejectedError} to refuse.
 */
export async function assertOverwriteAllowed(
  sessionId: string,
  path: string,
  current: FileVersion | undefined,
): Promise<void> {
  if (!current) return;
  const recorded = recordedVersion(sessionId, await realpath(path));
  if (!recorded) throw new WriteGuardRejectedError('WRITE_NOT_READ', undefined, current);
  if (!sameVersion(recorded, current)) {
    throw new WriteGuardRejectedError('WRITE_STALE_READ', recorded, current);
  }
}

const NOT_READ_REMINDER =
  '<system-reminder>Read the file with the read tool first (a partial read with offset/limit is enough), then call write again. Do not switch to shell commands to write this file.</system-reminder>';
const STALE_READ_REMINDER =
  '<system-reminder>The file changed after your last read. Read it again, keep changes you did not make, then call write again. Do not switch to shell commands to overwrite it.</system-reminder>';

export function writeGuardRejectedResult(
  toolName: string,
  inputPath: string,
  code: WriteGuardErrorCode,
): ToolResult {
  const text =
    code === 'WRITE_NOT_READ'
      ? `Refusing to overwrite ${inputPath}: this session has not read the file. Nothing was written. Read the file first, then retry; use edit for partial changes.\n\n${NOT_READ_REMINDER}`
      : `Refusing to overwrite ${inputPath}: the file changed after this session last read it (another session, a command, or an editor may have modified it). Nothing was written. Read it again and check what changed before retrying; do not discard changes you did not make.\n\n${STALE_READ_REMINDER}`;
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    isError: true,
    details: { status: 'write_guard_rejected', error_code: code, path: inputPath },
  };
}
