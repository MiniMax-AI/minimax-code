import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat as fileStat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

type OwnedWorktree = {
  readonly sourceDir: string;
  /** Primary worktree root used as the stable logical Project identity. */
  readonly repositoryRoot?: string;
  readonly targetRealpath: string;
  readonly branch: string;
  readonly preparedFingerprint: string;
  readonly ownershipToken: string;
  readonly allowTargetMutation?: boolean;
};

const OWNERSHIP_SIDECAR_SUFFIX = '.mavis-fork-ownership.json';

class ForkWorktreeUnavailableError extends Error {
  override readonly name = 'ForkWorktreeUnavailableError';
}

/** Git adapter for Fork only; it never shells through a command string. */
export function createForkWorktreeAdapter(options: {
  readonly worktreeParent?: string;
  readonly makeSuffix?: () => string;
}) {
  const owned = new Map<string, OwnedWorktree>();
  return {
    isEligible: (source: WorktreeSource) => isEligible(options, source),
    prepare: (input: WorktreePrepareInput) => prepareWorktree(options, owned, input),
    probe: (input: WorktreeProbeInput) => probeWorktree(input),
    cleanup: (input: WorktreeCleanupInput) => cleanupWorktree(owned, input),
  };
}

interface WorktreeRunLocation {
  readonly mode?: 'current' | 'existing-worktree' | 'new-worktree';
  readonly resolvedDir?: string;
  readonly resolvedBranch?: string;
  readonly parentRepoDir?: string;
  readonly createdAt?: number;
}

interface WorktreeSource {
  readonly workspaceDir: string;
  readonly appMode?: string | null;
  readonly status?: string | null;
  readonly runLocation?: WorktreeRunLocation | null;
}

interface WorktreePrepareInput {
  readonly operationId: string;
  readonly source: WorktreeSource;
  readonly allowTargetMutation?: boolean;
}

interface GitRepositoryContext {
  readonly sourceDir: string;
  readonly repositoryRoot: string;
}

interface SourceWorkspaceBase {
  /** Commit used to create the linked worktree. */
  readonly worktreeHead: string;
  /** Raw Git output retained so source and target fingerprints stay byte-compatible. */
  readonly fingerprintHead: string;
  /** Tree-ish used when the source branch does not have a HEAD commit yet. */
  readonly diffBase: string;
}

interface SourceOverlayInput {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly excludedSourceRoots: readonly string[];
  readonly sourceDiffBase: string;
  readonly bestEffort: boolean;
}

interface WorkspaceVerificationInput {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly excludedSourceRoots: readonly string[];
  readonly expectedFingerprint: string;
  readonly sourceBase: SourceWorkspaceBase;
}

interface WorktreeProbeInput {
  readonly operationId: string;
  readonly workspaceDir: string;
  readonly ownershipToken?: string;
  readonly fingerprint?: string;
  readonly runLocation?: WorktreeRunLocation | null;
}

type WorktreeProbeResult = ReturnType<typeof probedWorktreeResult>;

interface WorktreeCleanupInput {
  readonly operationId: string;
  readonly workspaceDir: string;
  readonly ownershipToken?: string;
}

async function prepareWorktree(
  options: Parameters<typeof createForkWorktreeAdapter>[0],
  owned: Map<string, OwnedWorktree>,
  input: WorktreePrepareInput,
) {
  const context = await resolveRepositoryContext(input.source);
  const { sourceDir } = context;
  const location = await resolveWorktreeLocation(options, context, input.operationId);
  const excludedSourceRoots = isWithin(sourceDir, location.parent) ? [location.parent] : [];
  const sourceMayChange = input.source.status !== undefined && input.source.status !== 'idle';
  const before = sourceMayChange
    ? undefined
    : await fingerprint(sourceDir, excludedSourceRoots, location.sourceBase);
  let targetRealpath: string | undefined;
  let ownershipSidecar: string | undefined;
  try {
    await git(
      ['worktree', 'add', '-b', location.branch, location.target, location.head],
      sourceDir,
    );
    targetRealpath = await realpath(location.target);
    assertWithin(location.parent, targetRealpath, 'Worktree escaped its parent');
    await copySourceOverlay({
      sourceDir,
      targetDir: targetRealpath,
      excludedSourceRoots,
      sourceDiffBase: location.sourceBase.diffBase,
      bestEffort: sourceMayChange,
    });
    const preparedFingerprint =
      before === undefined
        ? await fingerprint(targetRealpath)
        : await verifyCopiedWorkspace({
            sourceDir,
            targetDir: targetRealpath,
            excludedSourceRoots,
            expectedFingerprint: before,
            sourceBase: location.sourceBase,
          });
    const ownership = createOwnership({
      operationId: input.operationId,
      sourceDir,
      repositoryRoot: context.repositoryRoot,
      targetRealpath,
      branch: location.branch,
      preparedFingerprint,
      ...(input.allowTargetMutation ? { allowTargetMutation: true } : {}),
    });
    ownershipSidecar = ownershipPath(targetRealpath);
    await writeOwnership(ownershipSidecar, input.operationId, ownership);
    owned.set(input.operationId, ownership);
    return preparedWorktreeResult(ownership);
  } catch (error) {
    await cleanupFailedPreparation(
      context.repositoryRoot,
      location.branch,
      targetRealpath,
      ownershipSidecar,
    );
    throw error;
  }
}

async function isEligible(
  options: Parameters<typeof createForkWorktreeAdapter>[0],
  source: WorktreeSource,
): Promise<boolean> {
  let context: GitRepositoryContext;
  try {
    context = await resolveRepositoryContext(source);
  } catch {
    return false;
  }
  try {
    const configuredParent = resolve(
      options.worktreeParent ?? join(context.repositoryRoot, '.worktrees'),
    );
    const excludedSourceRoots = isWithin(context.sourceDir, configuredParent)
      ? [configuredParent]
      : [];
    const unsupported = await hasUnsupportedUntrackedEntry(context.sourceDir, excludedSourceRoots);
    return !unsupported;
  } catch {
    return false;
  }
}

async function hasUnsupportedUntrackedEntry(
  sourceDir: string,
  excludedSourceRoots: readonly string[],
): Promise<boolean> {
  const entries = await untrackedEntries(sourceDir, excludedSourceRoots);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    try {
      const stat = await lstat(resolve(sourceDir, entry));
      if (stat.isSymbolicLink() || !stat.isFile()) return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return false;
}

async function resolveRepositoryContext(source: WorktreeSource): Promise<GitRepositoryContext> {
  if (source.appMode !== 'coding') {
    throw new ForkWorktreeUnavailableError('Fork worktree requires coding mode');
  }
  const requestedDir = await realpath(source.runLocation?.resolvedDir ?? source.workspaceDir);
  const stat = await lstat(requestedDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ForkWorktreeUnavailableError('Unsafe source workspace');
  }
  const sourceDir = await realpath(
    (await git(['rev-parse', '--show-toplevel'], requestedDir)).trim(),
  );
  const worktreeList = await git(['worktree', 'list', '--porcelain', '-z'], sourceDir);
  const primaryRecord = worktreeList.split('\0').find((record) => record.startsWith('worktree '));
  if (!primaryRecord) {
    throw new ForkWorktreeUnavailableError('Git primary worktree is unavailable');
  }
  const repositoryRoot = await realpath(primaryRecord.slice('worktree '.length));
  const repositoryStat = await lstat(repositoryRoot);
  if (!repositoryStat.isDirectory() || repositoryStat.isSymbolicLink()) {
    throw new ForkWorktreeUnavailableError('Unsafe Git primary worktree');
  }
  return { sourceDir, repositoryRoot };
}

async function resolveWorktreeLocation(
  options: Parameters<typeof createForkWorktreeAdapter>[0],
  context: GitRepositoryContext,
  operationId: string,
) {
  const { sourceDir, repositoryRoot } = context;
  const sourceBase = await resolveSourceWorkspaceBase(sourceDir);
  const configuredParent = resolve(options.worktreeParent ?? join(repositoryRoot, '.worktrees'));
  await mkdir(configuredParent, { recursive: true });
  const parent = await realpath(configuredParent);
  if (parent === sourceDir) {
    throw new ForkWorktreeUnavailableError('Worktree parent must not be the source workspace');
  }
  const suffix = safeSegment((options.makeSuffix ?? defaultSuffix)());
  const operationSegment = createHash('sha256').update(operationId).digest('hex').slice(0, 12);
  const target = resolve(parent, `fork-${operationSegment}-${suffix}`);
  assertWithin(parent, target, 'Unsafe worktree path');
  return {
    head: sourceBase.worktreeHead,
    sourceBase,
    parent,
    target,
    branch: `fork/${operationSegment}-${suffix}`,
  };
}

async function resolveSourceWorkspaceBase(sourceDir: string): Promise<SourceWorkspaceBase> {
  try {
    const head = await git(['rev-parse', '--verify', 'HEAD^{commit}'], sourceDir);
    return { worktreeHead: head.trim(), fingerprintHead: head, diffBase: 'HEAD' };
  } catch (error) {
    if (!(await hasUnbornHead(sourceDir))) throw error;
    return createUnbornWorkspaceBase(sourceDir);
  }
}

async function hasUnbornHead(sourceDir: string): Promise<boolean> {
  try {
    const headRef = (await git(['symbolic-ref', '-q', 'HEAD'], sourceDir)).trim();
    const refs = (await git(['for-each-ref', '--format=%(refname)', headRef], sourceDir))
      .split('\n')
      .filter(Boolean);
    return Boolean(headRef) && !refs.includes(headRef);
  } catch {
    return false;
  }
}

async function createUnbornWorkspaceBase(sourceDir: string): Promise<SourceWorkspaceBase> {
  const emptyTree = (
    await gitWithInput(['mktree'], sourceDir, '', 'Failed to create empty Git tree')
  ).trim();
  const head = await git(
    [
      '-c',
      'user.name=Mavis',
      '-c',
      'user.email=mavis@localhost.invalid',
      'commit-tree',
      emptyTree,
      '-m',
      'Initialize isolated Fork worktree',
    ],
    sourceDir,
  );
  return { worktreeHead: head.trim(), fingerprintHead: head, diffBase: emptyTree };
}

function defaultSuffix(): string {
  return randomUUID().replaceAll('-', '');
}

async function copySourceOverlay(input: SourceOverlayInput): Promise<void> {
  const { sourceDir, targetDir, excludedSourceRoots, sourceDiffBase, bestEffort } = input;
  const pathspec = workspacePathspec(sourceDir, excludedSourceRoots);
  await copyTrackedPatch({
    sourceDir,
    targetDir,
    args: ['diff', '--binary', '--cached', sourceDiffBase, ...pathspec],
    updateIndex: true,
    bestEffort,
  });
  await copyTrackedPatch({
    sourceDir,
    targetDir,
    args: ['diff', '--binary', ...pathspec],
    updateIndex: false,
    bestEffort,
  });
  const entries = await readUntrackedEntries(sourceDir, excludedSourceRoots, bestEffort);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    try {
      const from = resolve(sourceDir, entry);
      const destination = resolve(targetDir, entry);
      assertWithin(sourceDir, from, 'Unsafe untracked path');
      assertWithin(targetDir, destination, 'Unsafe untracked path');
      const stat = await lstat(from);
      if (stat.isSymbolicLink()) {
        throw new ForkWorktreeUnavailableError('Untracked symlinks are not supported');
      }
      await mkdir(dirname(destination), { recursive: true });
      await cp(from, destination, { recursive: true, errorOnExist: true });
    } catch (error) {
      if (!bestEffort) throw error;
    }
  }
}

async function readUntrackedEntries(
  sourceDir: string,
  excludedSourceRoots: readonly string[],
  bestEffort: boolean,
): Promise<readonly string[]> {
  try {
    return await untrackedEntries(sourceDir, excludedSourceRoots);
  } catch (error) {
    if (!bestEffort) throw error;
    return [];
  }
}

async function copyTrackedPatch(input: {
  readonly sourceDir: string;
  readonly targetDir: string;
  readonly args: readonly string[];
  readonly updateIndex: boolean;
  readonly bestEffort: boolean;
}): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'mavis-fork-patch-'));
  try {
    // Patches may be large; use a controlled temporary file to avoid another overflow during copying after fingerprint repair.
    const patchPath = join(temporary, 'changes.patch');
    await streamGit(input.args, input.sourceDir, async (stdout) => {
      await pipeline(stdout, createWriteStream(patchPath, { flags: 'wx', mode: 0o600 }));
    });
    if ((await fileStat(patchPath)).size > 0) {
      await git(
        ['apply', '--binary', ...(input.updateIndex ? ['--index'] : []), '--', patchPath],
        input.targetDir,
      );
    }
  } catch (error) {
    if (!input.bestEffort) throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function assertWithin(parent: string, child: string, message: string): void {
  if (!isWithin(parent, child)) throw new ForkWorktreeUnavailableError(message);
}

async function verifyCopiedWorkspace(input: WorkspaceVerificationInput): Promise<string> {
  const { sourceDir, targetDir, excludedSourceRoots, expectedFingerprint, sourceBase } = input;
  const sourceFingerprint = await fingerprint(sourceDir, excludedSourceRoots, sourceBase);
  if (sourceFingerprint !== expectedFingerprint) {
    throw new ForkWorktreeUnavailableError('Source workspace changed during Fork');
  }
  // Excluded overlays stay at HEAD in the target. Keep its full fingerprint so
  // ownership probes and cleanup still detect any later target mutation.
  const targetFingerprint = await fingerprint(targetDir);
  if (targetFingerprint !== expectedFingerprint) {
    throw new ForkWorktreeUnavailableError('Fork worktree content verification failed');
  }
  return targetFingerprint;
}

function createOwnership(input: {
  readonly operationId: string;
  readonly sourceDir: string;
  readonly repositoryRoot: string;
  readonly targetRealpath: string;
  readonly branch: string;
  readonly preparedFingerprint: string;
  readonly allowTargetMutation?: boolean;
}): OwnedWorktree {
  const ownershipToken = createHash('sha256')
    .update(input.operationId)
    .update('\0')
    .update(input.targetRealpath)
    .update('\0')
    .update(input.preparedFingerprint)
    .digest('hex');
  return {
    sourceDir: input.sourceDir,
    repositoryRoot: input.repositoryRoot,
    targetRealpath: input.targetRealpath,
    branch: input.branch,
    preparedFingerprint: input.preparedFingerprint,
    ownershipToken,
    ...(input.allowTargetMutation ? { allowTargetMutation: true } : {}),
  };
}

async function writeOwnership(
  path: string,
  operationId: string,
  ownership: OwnedWorktree,
): Promise<void> {
  await writeFile(path, `${JSON.stringify({ operationId, ...ownership })}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

function preparedWorktreeResult(ownership: OwnedWorktree) {
  return {
    workspaceDir: ownership.targetRealpath,
    ownershipToken: ownership.ownershipToken,
    fingerprint: ownership.preparedFingerprint,
    runLocation: {
      mode: 'new-worktree' as const,
      resolvedDir: ownership.targetRealpath,
      resolvedBranch: ownership.branch,
      parentRepoDir: ownership.repositoryRoot ?? ownership.sourceDir,
      createdAt: Date.now(),
    },
  };
}

async function cleanupFailedPreparation(
  repositoryRoot: string,
  branch: string,
  targetRealpath: string | undefined,
  ownershipSidecar: string | undefined,
): Promise<void> {
  if (ownershipSidecar) await removeIfPresent(ownershipSidecar);
  if (targetRealpath) {
    await gitBestEffort(['worktree', 'remove', '--force', targetRealpath], repositoryRoot);
  }
  await gitBestEffort(['branch', '-D', branch], repositoryRoot);
}

async function probeWorktree(input: WorktreeProbeInput): Promise<WorktreeProbeResult> {
  const workspaceRealpath = await realpath(input.workspaceDir);
  const persisted = await requireOwnership(workspaceRealpath, input.operationId);
  assertOwnershipProof(input, workspaceRealpath, persisted);
  if (
    !persisted.allowTargetMutation &&
    (await fingerprint(workspaceRealpath)) !== persisted.preparedFingerprint
  ) {
    throw new ForkWorktreeUnavailableError('Worktree changed after preparation');
  }
  const branch = (await git(['branch', '--show-current'], workspaceRealpath)).trim();
  if (
    branch !== persisted.branch ||
    (input.runLocation?.resolvedBranch !== undefined && input.runLocation.resolvedBranch !== branch)
  ) {
    throw new ForkWorktreeUnavailableError('Worktree branch mismatch');
  }
  return probedWorktreeResult(input, workspaceRealpath, branch, {
    sourceDir: persisted.sourceDir,
    repositoryRoot: persisted.repositoryRoot,
  });
}

async function requireOwnership(
  workspaceDir: string,
  operationId: string,
): Promise<PersistedOwnership> {
  const persisted = await readOwnership(workspaceDir);
  if (!persisted || persisted.operationId !== operationId) {
    throw new ForkWorktreeUnavailableError('Worktree is not owned by this Fork operation');
  }
  return persisted;
}

function assertOwnershipProof(
  input: WorktreeProbeInput,
  workspaceRealpath: string,
  persisted: PersistedOwnership,
): void {
  if (
    workspaceRealpath !== persisted.targetRealpath ||
    input.ownershipToken !== persisted.ownershipToken
  ) {
    throw new ForkWorktreeUnavailableError('Worktree ownership proof mismatch');
  }
  if (input.fingerprint && input.fingerprint !== persisted.preparedFingerprint) {
    throw new ForkWorktreeUnavailableError('Persisted worktree fingerprint mismatch');
  }
}

function probedWorktreeResult(
  input: WorktreeProbeInput,
  workspaceDir: string,
  branch: string,
  source: Pick<OwnedWorktree, 'sourceDir' | 'repositoryRoot'>,
) {
  const { sourceDir, repositoryRoot } = source;
  const runLocation = input.runLocation
    ? {
        ...input.runLocation,
        mode: input.runLocation.mode ?? ('new-worktree' as const),
        resolvedDir: workspaceDir,
        resolvedBranch: branch,
        parentRepoDir: repositoryRoot ?? input.runLocation.parentRepoDir ?? sourceDir,
        createdAt: input.runLocation.createdAt ?? Date.now(),
      }
    : {
        mode: 'new-worktree' as const,
        resolvedDir: workspaceDir,
        resolvedBranch: branch,
        parentRepoDir: repositoryRoot ?? sourceDir,
        createdAt: Date.now(),
      };
  return { workspaceDir, runLocation };
}

async function cleanupWorktree(
  owned: Map<string, OwnedWorktree>,
  input: WorktreeCleanupInput,
): Promise<void> {
  const requestedWorkspace = resolve(input.workspaceDir);
  const workspaceRealpath = await realpathIfPresent(input.workspaceDir);
  const ownershipWorkspace = workspaceRealpath ?? requestedWorkspace;
  const persisted = await readOwnership(ownershipWorkspace);
  if (!workspaceRealpath && !persisted) return;
  const resource = owned.get(input.operationId) ?? persisted;
  assertCleanupOwnership(input, ownershipWorkspace, persisted, resource);
  if (
    workspaceRealpath &&
    !resource.allowTargetMutation &&
    (await fingerprint(workspaceRealpath)) !== resource.preparedFingerprint
  ) {
    throw new ForkWorktreeUnavailableError('Worktree changed after preparation');
  }
  await removeOwnedWorktree(resource, ownershipWorkspace, workspaceRealpath);
  await gitBestEffort(
    ['branch', '-D', resource.branch],
    resource.repositoryRoot ?? resource.sourceDir,
  );
  await removeIfPresent(ownershipPath(ownershipWorkspace));
  owned.delete(input.operationId);
}

function assertCleanupOwnership(
  input: WorktreeCleanupInput,
  ownershipWorkspace: string,
  persisted: PersistedOwnership | undefined,
  resource: OwnedWorktree | undefined,
): asserts resource is OwnedWorktree {
  if (!resource || persisted?.operationId !== input.operationId) {
    throw new ForkWorktreeUnavailableError('Worktree is not owned by this Fork operation');
  }
  if (ownershipWorkspace !== resource.targetRealpath) {
    throw new ForkWorktreeUnavailableError('Worktree cleanup path mismatch');
  }
  if (input.ownershipToken !== resource.ownershipToken) {
    throw new ForkWorktreeUnavailableError('Worktree ownership token mismatch');
  }
}

async function removeOwnedWorktree(
  resource: OwnedWorktree,
  ownershipWorkspace: string,
  workspaceRealpath: string | undefined,
): Promise<void> {
  if (workspaceRealpath) {
    await git(
      ['worktree', 'remove', '--force', workspaceRealpath],
      resource.repositoryRoot ?? resource.sourceDir,
    );
    return;
  }
  try {
    await git(
      ['worktree', 'remove', '--force', ownershipWorkspace],
      resource.repositoryRoot ?? resource.sourceDir,
    );
  } catch {
    await git(['worktree', 'prune'], resource.repositoryRoot ?? resource.sourceDir);
  }
}

async function realpathIfPresent(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function gitBestEffort(args: readonly string[], cwd: string): Promise<void> {
  try {
    await git(args, cwd);
  } catch {
    // Compensation is idempotent and ownership is checked before invocation.
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Sidecar cleanup is idempotent.
  }
}

type PersistedOwnership = OwnedWorktree & { readonly operationId: string };

async function readOwnership(workspaceDir: string): Promise<PersistedOwnership | undefined> {
  try {
    const path = ownershipPath(workspaceDir);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isPersistedOwnership(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isPersistedOwnership(value: unknown): value is PersistedOwnership {
  return (
    isRecord(value) &&
    typeof value.operationId === 'string' &&
    typeof value.sourceDir === 'string' &&
    isOptionalString(value.repositoryRoot) &&
    typeof value.targetRealpath === 'string' &&
    typeof value.branch === 'string' &&
    typeof value.preparedFingerprint === 'string' &&
    typeof value.ownershipToken === 'string' &&
    isOptionalBoolean(value.allowTargetMutation)
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function workspacePathspec(cwd: string, excludedRoots: readonly string[]): readonly string[] {
  if (excludedRoots.length === 0) return [];
  return [
    '--',
    '.',
    ...excludedRoots.map(
      (root) => `:(top,exclude,literal)${relative(cwd, root).split(sep).join('/')}`,
    ),
  ];
}

async function fingerprint(
  cwd: string,
  excludedRoots: readonly string[] = [],
  sourceBase?: SourceWorkspaceBase,
): Promise<string> {
  const [head, status, untracked] = await Promise.all([
    sourceBase ? sourceBase.fingerprintHead : git(['rev-parse', 'HEAD'], cwd),
    filteredStatus(cwd, excludedRoots),
    untrackedFingerprint(cwd, excludedRoots),
  ]);
  const hash = createHash('sha256').update(head).update('\0').update(status).update('\0');
  await streamGit(
    ['diff', '--binary', sourceBase?.diffBase ?? 'HEAD', ...workspacePathspec(cwd, excludedRoots)],
    cwd,
    async (stdout) => {
      // Match the original execFile UTF-8 decoding; the stream decoder joins characters split across chunks.
      stdout.setEncoding('utf8');
      for await (const chunk of stdout) hash.update(chunk);
    },
  );
  return hash.update('\0').update(untracked).digest('hex');
}

async function filteredStatus(cwd: string, excludedRoots: readonly string[] = []): Promise<string> {
  const output = await git(
    [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '-z',
      ...workspacePathspec(cwd, excludedRoots),
    ],
    cwd,
  );
  return output.split('\0').filter(Boolean).join('\0');
}

async function untrackedFingerprint(
  cwd: string,
  excludedRoots: readonly string[] = [],
): Promise<Buffer> {
  const hash = createHash('sha256');
  for (const entry of await untrackedEntries(cwd, excludedRoots)) {
    const path = resolve(cwd, entry);
    if (!isWithin(cwd, path)) throw new ForkWorktreeUnavailableError('Unsafe untracked path');
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new ForkWorktreeUnavailableError('Untracked symlinks are not supported');
    if (!stat.isFile())
      throw new ForkWorktreeUnavailableError('Only untracked files are supported');
    hash
      .update(entry)
      .update('\0')
      .update(await readFile(path))
      .update('\0');
  }
  return hash.digest();
}

async function untrackedEntries(
  cwd: string,
  excludedRoots: readonly string[] = [],
): Promise<readonly string[]> {
  const output = await git(
    ['ls-files', '--others', '--exclude-standard', '-z', ...workspacePathspec(cwd, excludedRoots)],
    cwd,
  );
  return output.split('\0').filter(Boolean).sort();
}

async function gitWithInput(
  args: readonly string[],
  cwd: string,
  input: string,
  failureMessage: string,
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', [...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise(stdout)
        : reject(new ForkWorktreeUnavailableError(`${failureMessage}: ${stderr}`)),
    );
    child.stdin.end(input);
  });
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  let result = '';
  await streamGit(args, cwd, async (stdout) => {
    stdout.setEncoding('utf8');
    for await (const chunk of stdout) result += chunk;
  });
  return result;
}

async function streamGit(
  args: readonly string[],
  cwd: string,
  consume: (stdout: Readable) => Promise<void>,
): Promise<void> {
  const child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-64 * 1024);
  });
  const completed = new Promise<void>((resolvePromise, reject) => {
    child.on('error', reject);
    child.stderr.on('error', (error) => {
      child.kill();
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new ForkWorktreeUnavailableError(`git ${args[0]} failed (${code ?? signal}): ${stderr}`),
        );
    });
  });
  const consumed = (async () => {
    try {
      await consume(child.stdout);
    } catch (error) {
      child.kill();
      throw error;
    }
  })();
  // Wait for both output consumption and process exit, including on failure, to avoid cleaning up a file still being written.
  const results = await Promise.allSettled([completed, consumed]);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeSegment(value: string): string {
  if (!value || basename(value) !== value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ForkWorktreeUnavailableError('Unsafe worktree suffix');
  }
  return value;
}

function ownershipPath(workspaceDir: string): string {
  return `${resolve(workspaceDir)}${OWNERSHIP_SIDECAR_SUFFIX}`;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}
