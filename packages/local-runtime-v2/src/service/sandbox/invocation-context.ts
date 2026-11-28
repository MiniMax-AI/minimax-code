import { createHmac, randomBytes } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import type { SandboxEffectivePolicy, SandboxPolicyPathRoot } from './backend/types.js';
import { SandboxError } from './sandbox-errors.js';

const TEMP_MARKER = '.mcode-sandbox-owner.json';
const TEMP_MARKER_SCHEMA_VERSION = 1;
const INSTANCE_DIRECTORY_PATTERN = /^runtime-[a-f0-9]{32}$/;
const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000;

export interface SandboxInvocationContextInput {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly sessionTempDir: string;
  readonly runtimeTempInstanceDir: string;
  readonly sandboxTempRoot: string;
  readonly policy: SandboxEffectivePolicy;
}

export interface ResolvedSandboxInvocationContext {
  readonly workspaceRealPath: string;
  readonly cwdRealPath: string;
  readonly gitDirRealPath?: string;
  readonly commonDirRealPath?: string;
  readonly sessionTempRealPath: string;
  readonly sandboxTempDir: string;
  readonly filesystem: {
    readonly allowRead: readonly string[];
    readonly allowWrite: readonly string[];
    readonly unlinkAllowOnly: readonly string[];
    readonly denyRead: readonly string[];
    readonly denyWrite: readonly string[];
  };
  readonly git: { readonly safeDirectories: readonly string[] };
}

export async function resolveSandboxInvocationContext(
  input: SandboxInvocationContextInput,
): Promise<ResolvedSandboxInvocationContext> {
  // The only preconditions left are the ones the resolver itself needs in order
  // to produce real paths. Everything the agent is allowed to read, write or
  // unlink comes from the four filesystem modes; this function deliberately
  // adds no admission rule of its own.
  //
  // In particular there is NO "workspace must live outside the runtime dataDir"
  // rule, and no "cwd must sit inside the workspace" rule. Both used to exist:
  // the first was the companion of a mandatory deny-read of the runtime dataDir
  // that was removed in b68afc99, and it fail-closed every session that uses the
  // default workspace `<dataDir>/sessions/<id>/workspace` — no bash at all could
  // start there, in any mode, because this runs before the mode is consulted.
  const workspaceRealPath = await existingDirectory(input.workspaceRoot, 'workspaceRoot');
  const cwdRealPath = await existingDirectory(input.cwd, 'cwd');

  const sandboxTempRootRealPath = await existingDirectory(input.sandboxTempRoot, 'sandboxTempRoot');
  const runtimeTempInstanceRealPath = await existingDirectory(
    input.runtimeTempInstanceDir,
    'runtimeTempInstanceDir',
  );
  assertDirectChild(runtimeTempInstanceRealPath, sandboxTempRootRealPath, 'runtimeTempInstanceDir');
  const sessionTempRealPath = await existingDirectory(input.sessionTempDir, 'sessionTempDir');
  assertDirectChild(sessionTempRealPath, runtimeTempInstanceRealPath, 'sessionTempDir');

  const git = await resolveGitMetadata(workspaceRealPath);
  const linked = await discoverLinkedGitMetadata(workspaceRealPath, cwdRealPath);
  const surface = dedupe([
    workspaceRealPath,
    git.gitDirRealPath,
    git.commonDirRealPath,
    ...linked.gitDirs,
    ...linked.commonDirs,
    sessionTempRealPath,
  ]);
  const scopePaths = (scopes: readonly SandboxPolicyPathRoot[]) =>
    dedupe(
      scopes.flatMap((scope) => {
        switch (scope) {
          case 'workspace':
            return [workspaceRealPath];
          case 'git-dir':
            return [...(git.gitDirRealPath ? [git.gitDirRealPath] : []), ...linked.gitDirs];
          case 'common-dir':
            return [
              ...(git.commonDirRealPath ? [git.commonDirRealPath] : []),
              ...linked.commonDirs,
            ];
          case 'session-temp':
            return [sessionTempRealPath];
          case 'trash':
            return resolvePlatformTrashRoots();
          case 'host-root':
            return ['/'];
        }
        const unreachable: never = scope;
        return unreachable;
      }),
    );

  return {
    workspaceRealPath,
    cwdRealPath,
    ...(git.gitDirRealPath ? { gitDirRealPath: git.gitDirRealPath } : {}),
    ...(git.commonDirRealPath ? { commonDirRealPath: git.commonDirRealPath } : {}),
    sessionTempRealPath,
    sandboxTempDir: sessionTempRealPath,
    filesystem: {
      allowRead: surface,
      allowWrite: scopePaths(input.policy.filesystem.allowWrite),
      unlinkAllowOnly: scopePaths(input.policy.filesystem.unlinkAllowOnly),
      // Preserve literal and glob entries exactly; SRT owns their precedence.
      // These two are the user's own blacklist (axis two) and the only write or
      // delete restrictions this layer contributes on top of the four modes.
      denyRead: dedupe(input.policy.filesystem.denyRead),
      denyWrite: dedupe(input.policy.filesystem.denyWrite),
    },
    // `safeDirectories` only injects git's `safe.directory` dubious-ownership
    // bypass through GIT_CONFIG_*; it never widens `allowWrite`. A linked
    // worktree keeps its gitdir and commondir outside the workspace, so git
    // still refuses the repository unless those are listed as well.
    git: {
      safeDirectories: dedupe([
        workspaceRealPath,
        ...(git.gitDirRealPath ? [git.gitDirRealPath] : []),
        ...(git.commonDirRealPath ? [git.commonDirRealPath] : []),
        ...linked.worktreeRoots,
        ...linked.gitDirs,
        ...linked.commonDirs,
      ]),
    },
  };
}

interface ResolvedGitMetadata {
  readonly gitDirRealPath?: string;
  readonly commonDirRealPath?: string;
}

/**
 * Platform recoverable-delete destinations, mirroring the `mavis-trash` script
 * exactly (see `packages/local-runtime/src/infra/trash-script.ts`):
 * macOS moves into `~/.Trash`, POSIX/XDG into `$XDG_DATA_HOME/Trash` with
 * `$HOME/.local/share` as the spec default.
 *
 * Resolved lexically rather than through `realpath`: on Linux the directory is
 * created lazily by the script, so requiring it to exist up front would fail an
 * otherwise valid invocation.
 */
function resolvePlatformTrashRoots(): readonly string[] {
  const home = homedir();
  if (!home || !isAbsolute(home)) return [];
  if (process.platform === 'darwin') return [join(home, '.Trash')];
  const xdgDataHome = process.env.XDG_DATA_HOME;
  const dataHome =
    xdgDataHome && isAbsolute(xdgDataHome) ? xdgDataHome : join(home, '.local', 'share');
  return [join(dataHome, 'Trash')];
}

async function resolveGitMetadata(workspaceRealPath: string): Promise<ResolvedGitMetadata> {
  const gitDirCandidate = await resolveGitDirCandidate(workspaceRealPath);
  if (!gitDirCandidate) return {};
  const gitDirRealPath = await existingDirectory(gitDirCandidate, 'gitDir');
  const commonDirRealPath = await resolveCommonGitDir(gitDirRealPath);
  return {
    gitDirRealPath,
    ...(commonDirRealPath ? { commonDirRealPath } : {}),
  };
}

async function resolveGitDirCandidate(workspaceRealPath: string): Promise<string | undefined> {
  const dotGit = join(workspaceRealPath, '.git');
  let dotGitStat;
  try {
    dotGitStat = await stat(dotGit);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw workspaceError(`Unable to inspect workspace Git metadata: ${dotGit}`, 'gitDir');
  }

  if (dotGitStat.isDirectory()) {
    return dotGit;
  }
  if (dotGitStat.isFile()) {
    const gitFile = await readSingleLine(dotGit, 'gitfile');
    const match = /^gitdir: (.+)$/.exec(gitFile);
    if (!match?.[1]) throw workspaceError(`Invalid workspace gitfile: ${dotGit}`, 'gitDir');
    return isAbsolute(match[1]) ? match[1] : resolve(workspaceRealPath, match[1]);
  }
  throw workspaceError(`Workspace .git is neither a directory nor a gitfile: ${dotGit}`, 'gitDir');
}

async function resolveCommonGitDir(gitDirRealPath: string): Promise<string | undefined> {
  const commonDirFile = join(gitDirRealPath, 'commondir');
  try {
    await access(commonDirFile, constants.F_OK);
    const commonDirValue = await readSingleLine(commonDirFile, 'commondir');
    const candidate = isAbsolute(commonDirValue)
      ? commonDirValue
      : resolve(gitDirRealPath, commonDirValue);
    return await existingDirectory(candidate, 'commonDir');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

const LINKED_GIT_DISCOVERY_MAX_DEPTH = 6;
const LINKED_GIT_DISCOVERY_MAX_DIRECTORIES = 2048;
const LINKED_GIT_DISCOVERY_SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

interface DiscoveredLinkedGitMetadata {
  /** External (outside-workspace) gitdirs of linked worktrees found in the workspace. */
  readonly gitDirs: readonly string[];
  /** External commondirs those gitdirs point at (the main repository's `.git`). */
  readonly commonDirs: readonly string[];
  /** Worktree roots whose metadata resolved, for git `safe.directory` injection. */
  readonly worktreeRoots: readonly string[];
}

/**
 * Find linked worktrees nested inside the workspace (gitfile-style `.git`
 * entries) and resolve their external git metadata, so the `git-dir` /
 * `common-dir` scopes and the read surface cover them the same way they cover
 * the workspace root repository. Without this, a worktree checked out under
 * the workspace fails every index/ref lock-rename-unlink sequence in
 * `workspace_write` and `delete_guard` because its real metadata lives
 * outside every allowed root.
 *
 * Deliberately best-effort and bounded: a breadth-first scan (shallow
 * worktrees win) with hard depth and directory-count caps, never following
 * symlinks and never descending into `.git` or `node_modules`. Any error on a
 * candidate skips only that candidate — discovery must never fail-close the
 * whole bash invocation the way the workspace-root resolution legitimately
 * does. Resolved paths are only admitted when every metadata directory keeps
 * a `.git` path segment (covers `repo.git` bare naming), which caps how far a
 * crafted gitfile can widen the surface; results inside the workspace are
 * dropped because the workspace scope already covers them.
 *
 * The cwd is treated as one extra candidate when it differs from the
 * workspace root, covering invocations whose cwd is a worktree that the
 * bounded scan did not reach.
 */
async function discoverLinkedGitMetadata(
  workspaceRealPath: string,
  cwdRealPath: string,
): Promise<DiscoveredLinkedGitMetadata> {
  const candidates = await scanForGitfileWorktrees(workspaceRealPath);
  if (cwdRealPath !== workspaceRealPath && !candidates.includes(cwdRealPath)) {
    candidates.push(cwdRealPath);
  }

  const gitDirs: (string | undefined)[] = [];
  const commonDirs: (string | undefined)[] = [];
  const worktreeRoots: (string | undefined)[] = [];
  for (const worktreeRoot of candidates) {
    const resolved = await resolveLinkedGitMetadataAt(worktreeRoot, workspaceRealPath);
    if (!resolved) continue;
    gitDirs.push(resolved.gitDir);
    commonDirs.push(resolved.commonDir);
    worktreeRoots.push(worktreeRoot);
  }
  return {
    gitDirs: dedupe(gitDirs),
    commonDirs: dedupe(commonDirs),
    worktreeRoots: dedupe(worktreeRoots),
  };
}

/** Bounded breadth-first scan for directories that carry a `.git` gitfile. */
async function scanForGitfileWorktrees(workspaceRealPath: string): Promise<string[]> {
  const candidates: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: workspaceRealPath, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < LINKED_GIT_DISCOVERY_MAX_DIRECTORIES) {
    const next = queue.shift();
    if (!next) break;
    visited += 1;
    let entries;
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git' && entry.isFile()) {
        candidates.push(next.dir);
      } else if (shouldDescendIntoDirectory(entry, next.depth)) {
        queue.push({ dir: join(next.dir, entry.name), depth: next.depth + 1 });
      }
    }
  }
  return candidates;
}

function shouldDescendIntoDirectory(entry: Dirent, depth: number): boolean {
  return (
    entry.isDirectory() &&
    !LINKED_GIT_DISCOVERY_SKIPPED_DIRECTORIES.has(entry.name) &&
    depth < LINKED_GIT_DISCOVERY_MAX_DEPTH
  );
}

async function resolveLinkedGitMetadataAt(
  worktreeRoot: string,
  workspaceRealPath: string,
): Promise<{ gitDir?: string; commonDir?: string } | undefined> {
  try {
    const resolved = await resolveGitfileMetadata(worktreeRoot);
    if (!resolved) return undefined;
    const external = (path: string | undefined) =>
      path && !isInsideWorkspace(path, workspaceRealPath) ? path : undefined;
    const externalGitDir = external(resolved.gitDir);
    const externalCommonDir = external(resolved.commonDir);
    if (!externalGitDir && !externalCommonDir) return undefined;
    return {
      ...(externalGitDir ? { gitDir: externalGitDir } : {}),
      ...(externalCommonDir ? { commonDir: externalCommonDir } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Parse a worktree gitfile into `.git`-segment-constrained metadata directories. */
async function resolveGitfileMetadata(
  worktreeRoot: string,
): Promise<{ gitDir: string; commonDir?: string } | undefined> {
  const dotGit = join(worktreeRoot, '.git');
  if (!(await stat(dotGit)).isFile()) return undefined;
  const gitFile = await readSingleLine(dotGit, 'gitfile');
  const match = /^gitdir: (.+)$/.exec(gitFile);
  if (!match?.[1]) return undefined;
  const candidate = isAbsolute(match[1]) ? match[1] : resolve(worktreeRoot, match[1]);
  const gitDir = await existingDirectory(candidate, 'gitDir');
  if (!hasGitPathSegment(gitDir)) return undefined;
  const commonDir = await resolveCommonGitDir(gitDir);
  if (commonDir && !hasGitPathSegment(commonDir)) return undefined;
  return { gitDir, ...(commonDir ? { commonDir } : {}) };
}

function hasGitPathSegment(path: string): boolean {
  return path.split(sep).some((segment) => segment.endsWith('.git'));
}

function isInsideWorkspace(path: string, workspaceRealPath: string): boolean {
  return path === workspaceRealPath || path.startsWith(workspaceRealPath + sep);
}

async function readSingleLine(path: string, kind: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    throw workspaceError(`Unable to read ${kind}: ${path}`, kind);
  }
  if (content.includes('\0')) throw workspaceError(`Invalid ${kind}: ${path}`, kind);
  let value = content;
  if (value.endsWith('\r\n')) value = value.slice(0, -2);
  else if (value.endsWith('\n')) value = value.slice(0, -1);
  if (!value || value.includes('\n') || value.includes('\r')) {
    throw workspaceError(`Invalid ${kind}: ${path}`, kind);
  }
  return value;
}

async function existingDirectory(path: string, field: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0') || path.includes('\n') || path.includes('\r')) {
    throw workspaceError(`Invalid ${field}: ${path}`, field);
  }
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) {
      throw workspaceError(`${field} is not a directory: ${canonical}`, field);
    }
    return canonical;
  } catch (error) {
    if (error instanceof SandboxError) throw error;
    throw workspaceError(`Unable to resolve ${field}: ${path}`, field);
  }
}

function assertDirectChild(candidate: string, parent: string, field: string): void {
  if (dirname(candidate) !== parent) {
    throw workspaceError(
      `${field} is outside its owner root: ${candidate} not in ${parent}`,
      field,
    );
  }
}

function dedupe(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/**
 * Always name the offending path. A bare `Invalid commondir` cannot be acted
 * on: the reader cannot tell whether the bad path is their repository's
 * `commondir` file or the resolver's own temp directory.
 */
function workspaceError(message: string, fieldPath?: string): SandboxError {
  return new SandboxError('SANDBOX_WORKSPACE_INVALID', 'invocation', message, fieldPath);
}

/** True when `error` is a Node system error carrying `code`. */
export function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export interface SandboxSessionTempManagerOptions {
  readonly totalRoot?: string;
  readonly now?: () => number;
  readonly pidIsAlive?: (pid: number) => boolean;
  readonly orphanGraceMs?: number;
}

export class SandboxSessionTempManager {
  readonly #instanceId = randomBytes(16).toString('hex');
  readonly #sessionKey = randomBytes(32);
  readonly #now: () => number;
  readonly #pidIsAlive: (pid: number) => boolean;
  readonly #orphanGraceMs: number;
  readonly #requestedRoot: string;
  #totalRootRealPath?: string;
  #instanceRealPath?: string;

  constructor(options: SandboxSessionTempManagerOptions = {}) {
    this.#requestedRoot = options.totalRoot ?? join(tmpdir(), 'mcode-sandbox');
    this.#now = options.now ?? Date.now;
    this.#pidIsAlive = options.pidIsAlive ?? defaultPidIsAlive;
    this.#orphanGraceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  }

  get totalRoot(): string {
    if (!this.#totalRootRealPath) throw new Error('Sandbox temp manager is not initialized');
    return this.#totalRootRealPath;
  }

  get instanceDir(): string {
    if (!this.#instanceRealPath) throw new Error('Sandbox temp manager is not initialized');
    return this.#instanceRealPath;
  }

  async initialize(): Promise<void> {
    if (this.#instanceRealPath) return;
    if (!isAbsolute(this.#requestedRoot)) {
      throw workspaceError(`Invalid sandbox temp root: ${this.#requestedRoot}`, 'sandboxTempRoot');
    }
    await mkdir(this.#requestedRoot, { recursive: true, mode: 0o700 });
    await chmod(this.#requestedRoot, 0o700);
    const root = await realpath(this.#requestedRoot);
    await this.#cleanupOrphans(root);
    const instance = join(root, `runtime-${this.#instanceId}`);
    await mkdir(instance, { mode: 0o700 });
    try {
      await writeFile(
        join(instance, TEMP_MARKER),
        `${JSON.stringify({
          schemaVersion: TEMP_MARKER_SCHEMA_VERSION,
          pid: process.pid,
          instanceId: this.#instanceId,
          createdAt: this.#now(),
        })}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      const instanceRealPath = await realpath(instance);
      assertDirectChild(instanceRealPath, root, 'runtime temp instance');
      this.#totalRootRealPath = root;
      this.#instanceRealPath = instanceRealPath;
    } catch (error) {
      // mkdir is not recursive, so this call is the one that created the
      // directory. Leaving it behind would make every later initialize() fail
      // with EEXIST, so one transient failure (ENOSPC, EIO) would disable the
      // temp directory for the rest of the process even after the disk
      // recovers; with no owner marker inside, the orphan sweep a later
      // initialize() runs never removes it either. Removing it can only ever
      // remove what this call created.
      try {
        await removeValidatedInstanceDirectory(instance, root);
      } catch {
        // A failed removal must not hide the original error.
      }
      throw error;
    }
  }

  async sessionDir(sessionId: string): Promise<string> {
    if (!sessionId || sessionId.includes('\0')) throw workspaceError('Invalid session identity');
    const instance = this.instanceDir;
    const hash = createHmac('sha256', this.#sessionKey)
      .update(sessionId)
      .digest('hex')
      .slice(0, 32);
    const target = join(instance, `session-${hash}`);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await chmod(target, 0o700);
    const canonical = await realpath(target);
    assertDirectChild(canonical, instance, 'session temp');
    return canonical;
  }

  async close(): Promise<void> {
    const instance = this.#instanceRealPath;
    const root = this.#totalRootRealPath;
    this.#instanceRealPath = undefined;
    if (!instance || !root) return;
    await removeValidatedInstanceDirectory(instance, root);
  }

  async #cleanupOrphans(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!INSTANCE_DIRECTORY_PATTERN.test(entry.name) || !entry.isDirectory()) continue;
      const candidate = join(root, entry.name);
      const orphan = await this.#expiredOrphan(candidate, entry.name, root);
      if (orphan) await removeValidatedInstanceDirectory(orphan, root);
    }
  }

  async #expiredOrphan(
    candidate: string,
    entryName: string,
    root: string,
  ): Promise<string | undefined> {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    const canonical = await realpath(candidate);
    if (dirname(canonical) !== root) return undefined;
    const marker = await readOwnerMarker(join(canonical, TEMP_MARKER));
    if (!marker || marker.instanceId !== entryName.slice('runtime-'.length)) return undefined;
    if (this.#pidIsAlive(marker.pid)) return undefined;
    if (this.#now() - marker.createdAt < this.#orphanGraceMs) return undefined;
    return canonical;
  }
}

interface TempOwnerMarker {
  readonly schemaVersion: number;
  readonly pid: number;
  readonly instanceId: string;
  readonly createdAt: number;
}

async function readOwnerMarker(path: string): Promise<TempOwnerMarker | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<TempOwnerMarker>;
    if (
      value.schemaVersion !== TEMP_MARKER_SCHEMA_VERSION ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.instanceId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(value.instanceId) ||
      !Number.isSafeInteger(value.createdAt)
    ) {
      return undefined;
    }
    return value as TempOwnerMarker;
  } catch {
    return undefined;
  }
}

async function removeValidatedInstanceDirectory(candidate: string, root: string): Promise<void> {
  if (
    !isAbsolute(candidate) ||
    dirname(candidate) !== root ||
    !INSTANCE_DIRECTORY_PATTERN.test(candidate.slice(root.length + 1))
  ) {
    throw workspaceError(
      `Refusing unsafe sandbox temp cleanup: ${candidate} is not a direct instance dir of ${root}`,
      'sandboxTempInstance',
    );
  }
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(candidate)) !== candidate) {
    throw workspaceError(
      `Refusing unsafe sandbox temp cleanup: ${candidate} is a symlink or not a real directory`,
      'sandboxTempInstance',
    );
  }
  await rm(candidate, { recursive: true, force: false });
}

function defaultPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}
