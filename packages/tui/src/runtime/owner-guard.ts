import { type Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Read-only, opt-in observation of other Runtime owners; unreadable leases do not block startup. */
// Lease layout and heartbeat match local-runtime-v2/infra/runtime-owner/identity.ts.
const OWNER_LEASE_STALE_MS = 10_000;
const OWNER_LEASE_DIRECTORY = join('v2', 'runtime-owner-leases');

const OWNER_LEASE_SUFFIX = '.owner';
const OWNER_LOCK_SUFFIX = '.lock';

export const TUI_RUNTIME_OWNER_GUARD_ENV = 'MCODE_TUI_RUNTIME_OWNER_GUARD';
export const TUI_RUNTIME_OWNER_CONFLICT_CODE = 'MCODE_TUI_RUNTIME_OWNER_CONFLICT';

/** `strict` refuses to start on a live owner; `warn` reports and continues; the guard is disabled unless explicitly selected. */
export type TuiRuntimeOwnerGuardMode = 'warn' | 'strict';

/** A proven live foreign Runtime owner of the dataDir this launch is about to use. */
export interface TuiRuntimeOwnerConflict {
  readonly pid: number;
  readonly leaseFile: string;
  readonly dataDir: string;
}

export interface TuiRuntimeOwnerScanOptions {
  /** @internal Deterministic liveness seam for focused guard tests. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** @internal Deterministic heartbeat seam for focused guard tests. */
  readonly nowMs?: () => number;
}

export interface TuiRuntimeOwnerGuardOptions extends TuiRuntimeOwnerScanOptions {
  readonly dataDir?: string | undefined;
  /** An explicit mode wins; otherwise `MCODE_TUI_RUNTIME_OWNER_GUARD`, else disabled. */
  readonly mode?: TuiRuntimeOwnerGuardMode;
  /** Overrides the stderr diagnostic sink; mainly for tests. */
  readonly writeDiagnostic?: (line: string) => void;
}

let recordedConflict: TuiRuntimeOwnerConflict | undefined;

export function getTuiRuntimeOwnerConflict(): TuiRuntimeOwnerConflict | undefined {
  return recordedConflict;
}

/** @internal */
export function resetTuiRuntimeOwnerConflict(): void {
  recordedConflict = undefined;
}

export function resolveTuiRuntimeOwnerGuardMode(
  environment: NodeJS.ProcessEnv = process.env,
): TuiRuntimeOwnerGuardMode | undefined {
  const raw = environment[TUI_RUNTIME_OWNER_GUARD_ENV];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const mode = raw.trim();
  if (mode !== 'warn' && mode !== 'strict') {
    throw new Error(
      `${TUI_RUNTIME_OWNER_GUARD_ENV} must be warn or strict. Unset it to disable the guard.`,
    );
  }
  return mode;
}

export async function scanTuiRuntimeOwnerConflict(
  dataDir: string,
  options: TuiRuntimeOwnerScanOptions = {},
): Promise<TuiRuntimeOwnerConflict | undefined> {
  const isProcessAlive = options.isProcessAlive ?? isProcessAliveByPid;
  const nowMs = options.nowMs ?? Date.now;
  const directory = join(dataDir, OWNER_LEASE_DIRECTORY);
  for (const entry of await readOwnerLeases(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(OWNER_LEASE_SUFFIX)) continue;
    const leaseFile = join(directory, entry.name);
    const pid = parseLeasePid(await readLeaseText(leaseFile));
    if (pid === undefined || pid === process.pid) continue;
    const held = await isLeaseLockHeld(leaseFile, nowMs());
    if (held || isProcessAlive(pid)) return { pid, leaseFile, dataDir };
  }
  return undefined;
}

export async function guardTuiRuntimeOwner(
  options: TuiRuntimeOwnerGuardOptions = {},
): Promise<TuiRuntimeOwnerConflict | undefined> {
  const mode = options.mode ?? resolveTuiRuntimeOwnerGuardMode();
  const dataDir = options.dataDir;
  if (mode === undefined || dataDir === undefined || dataDir.length === 0) {
    recordedConflict = undefined;
    return undefined;
  }
  const conflict = await scanConflictSafely(dataDir, options);
  recordedConflict = conflict;
  if (!conflict) return undefined;
  (options.writeDiagnostic ?? writeStderrDiagnostic)(formatConflictDiagnostic(conflict));
  if (mode === 'strict') throw runtimeOwnerConflictError(conflict);
  return conflict;
}

async function scanConflictSafely(
  dataDir: string,
  options: TuiRuntimeOwnerScanOptions,
): Promise<TuiRuntimeOwnerConflict | undefined> {
  try {
    return await scanTuiRuntimeOwnerConflict(dataDir, options);
  } catch {
    return undefined;
  }
}

async function readOwnerLeases(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readLeaseText(leaseFile: string): Promise<string | undefined> {
  try {
    return await readFile(leaseFile, 'utf8');
  } catch {
    return undefined;
  }
}

function parseLeasePid(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const pid = Number.parseInt((text.split('\n', 1)[0] ?? '').trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function isLeaseLockHeld(leaseFile: string, nowMs: number): Promise<boolean> {
  try {
    const heartbeat = await stat(`${leaseFile}${OWNER_LOCK_SUFFIX}`);
    return nowMs - heartbeat.mtimeMs <= OWNER_LEASE_STALE_MS;
  } catch {
    return false;
  }
}

function isProcessAliveByPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function formatConflictDiagnostic(conflict: TuiRuntimeOwnerConflict): string {
  return (
    '[mcode-tui] runtime owner: another minimax Code instance is already running on this ' +
    `dataDir (pid=${String(conflict.pid)} lease=${conflict.leaseFile} ` +
    `dataDir=${conflict.dataDir})\n`
  );
}

function runtimeOwnerConflictError(conflict: TuiRuntimeOwnerConflict): Error {
  return Object.assign(
    new Error(
      'Another minimax Code instance is already running on this dataDir ' +
        `(pid=${String(conflict.pid)} lease=${conflict.leaseFile} dataDir=${conflict.dataDir}). ` +
        `Close it first, or set ${TUI_RUNTIME_OWNER_GUARD_ENV}=warn to continue anyway.`,
    ),
    { code: TUI_RUNTIME_OWNER_CONFLICT_CODE, ...conflict },
  );
}

function writeStderrDiagnostic(line: string): void {
  process.stderr.write(line);
}
