import { execFile as execFileCallback, type ExecFileException } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export type LocalRunLocationMode = 'current' | 'new-worktree' | 'existing-worktree';

export interface LocalRunLocationInput {
  readonly mode: LocalRunLocationMode;
  readonly worktreeDir?: string;
  readonly branch?: string;
  readonly newWorktreeBranch?: string;
  readonly newWorktreeBase?: string;
}

export interface ResolvedLocalRunLocation {
  readonly mode: LocalRunLocationMode;
  readonly resolvedDir: string;
  readonly resolvedBranch?: string;
  readonly parentRepoDir?: string;
  readonly createdAt: number;
}

export class LocalRunLocationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LocalRunLocationError';
  }
}

export function readLocalRunLocationInput(value: unknown): LocalRunLocationInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const mode = Reflect.get(value, 'mode');
  if (mode !== 'current' && mode !== 'new-worktree' && mode !== 'existing-worktree') {
    throw new LocalRunLocationError(
      `Unknown runLocation.mode "${String(mode)}"`,
      'RUN_LOCATION_INVALID_MODE',
    );
  }
  return {
    mode,
    ...optionalField(value, 'worktreeDir'),
    ...optionalField(value, 'branch'),
    ...optionalField(value, 'newWorktreeBranch'),
    ...optionalField(value, 'newWorktreeBase'),
  };
}

export async function applyLocalRunLocation(
  input: LocalRunLocationInput,
  workspaceDir: string,
  nowMs: () => number,
  refreshBeforeCreate = true,
): Promise<ResolvedLocalRunLocation> {
  const createdAt = nowMs();
  if (input.mode === 'current') {
    await checkoutOptionalBranch(input.branch, workspaceDir);
    return {
      mode: 'current',
      resolvedDir: workspaceDir,
      ...(input.branch ? { resolvedBranch: input.branch } : {}),
      createdAt,
    };
  }
  if (input.mode === 'new-worktree') {
    return createNewWorktree(input, workspaceDir, createdAt, refreshBeforeCreate);
  }
  return resolveExistingWorktree(input, workspaceDir, createdAt);
}

async function createNewWorktree(
  input: LocalRunLocationInput,
  workspaceDir: string,
  createdAt: number,
  refreshBeforeCreate: boolean,
): Promise<ResolvedLocalRunLocation> {
  const branch =
    input.newWorktreeBranch ?? input.branch ?? generateDefaultWorktreeBranch(createdAt);
  await assertSafeBranchName(branch, workspaceDir);
  const baseSha = await resolveWorktreeBase(
    input.newWorktreeBase ?? 'HEAD',
    workspaceDir,
    refreshBeforeCreate,
  );
  const worktreeParentDir = await resolveSafeWorktreeParent(workspaceDir);
  const targetDir = join(worktreeParentDir, branch.replaceAll('/', '-'));
  await createPinnedBranch(branch, input.newWorktreeBase ?? 'HEAD', baseSha, workspaceDir);
  const result = await git(['worktree', 'add', targetDir, branch], workspaceDir);
  if (result.code !== 0) {
    throw new LocalRunLocationError(
      `git worktree add failed: ${result.stderr || result.stdout}`,
      'RUN_LOCATION_WORKTREE_ADD_FAILED',
    );
  }
  return {
    mode: 'new-worktree',
    resolvedDir: targetDir,
    resolvedBranch: branch,
    parentRepoDir: workspaceDir,
    createdAt,
  };
}

async function createPinnedBranch(
  branch: string,
  baseRef: string,
  baseSha: string,
  cwd: string,
): Promise<void> {
  // Let Git apply autoSetupMerge/autoSetupRebase to the selected reference before
  // pinning the new branch. Starting directly from a SHA loses that information.
  const createBranch = await git(['branch', branch, baseRef], cwd);
  if (createBranch.code !== 0) {
    throw new LocalRunLocationError(
      `git branch failed: ${createBranch.stderr || createBranch.stdout}`,
      'RUN_LOCATION_WORKTREE_ADD_FAILED',
    );
  }
  const branchRef = `refs/heads/${branch}`;
  const initial = await git(['rev-parse', '--verify', branchRef], cwd);
  const pin =
    initial.code === 0
      ? await git(['update-ref', branchRef, baseSha, initial.stdout.trim()], cwd)
      : initial;
  if (pin.code !== 0) {
    throw new LocalRunLocationError(
      `Could not pin worktree branch: ${pin.stderr || pin.stdout}`,
      'RUN_LOCATION_WORKTREE_ADD_FAILED',
    );
  }
}

async function resolveExistingWorktree(
  input: LocalRunLocationInput,
  workspaceDir: string,
  createdAt: number,
): Promise<ResolvedLocalRunLocation> {
  if (!input.worktreeDir) {
    throw new LocalRunLocationError(
      'runLocation.mode="existing-worktree" requires `worktreeDir`',
      'RUN_LOCATION_WORKTREE_DIR_REQUIRED',
    );
  }
  if (!isAbsolute(input.worktreeDir)) {
    throw new LocalRunLocationError(
      `runLocation.worktreeDir must be an absolute path, got "${input.worktreeDir}"`,
      'RUN_LOCATION_WORKTREE_DIR_NOT_ABSOLUTE',
    );
  }
  if (!existsSync(input.worktreeDir)) {
    throw new LocalRunLocationError(
      `Worktree directory does not exist: ${input.worktreeDir}`,
      'RUN_LOCATION_WORKTREE_NOT_FOUND',
    );
  }
  await checkoutOptionalBranch(input.branch, input.worktreeDir);
  return {
    mode: 'existing-worktree',
    resolvedDir: input.worktreeDir,
    ...(input.branch ? { resolvedBranch: input.branch } : {}),
    parentRepoDir: workspaceDir,
    createdAt,
  };
}

async function checkoutOptionalBranch(branch: string | undefined, cwd: string): Promise<void> {
  if (!branch) return;
  await assertSafeBranchName(branch, cwd);
  const result = await git(['checkout', branch], cwd);
  if (result.code !== 0) {
    throw new LocalRunLocationError(
      `Failed to checkout branch "${branch}" in ${cwd}: ${result.stderr || result.stdout}`,
      'RUN_LOCATION_CHECKOUT_FAILED',
    );
  }
}

async function resolveSafeWorktreeParent(workspaceDir: string): Promise<string> {
  const workspaceReal = await realpath(workspaceDir);
  const parent = join(workspaceDir, '.worktrees');
  await mkdir(parent, { recursive: true });
  const parentReal = await realpath(parent);
  const pathFromParent = relative(resolve(workspaceReal), resolve(parentReal));
  if (pathFromParent.startsWith('..') || isAbsolute(pathFromParent)) {
    throw new LocalRunLocationError(
      `Refusing to create worktree outside workspace: ${parent}`,
      'RUN_LOCATION_WORKTREE_PARENT_ESCAPES',
    );
  }
  return parentReal;
}

function assertSafeBaseRef(baseRef: string): void {
  if (baseRef.startsWith('-') || baseRef.includes('\0')) {
    throw new LocalRunLocationError(
      `Invalid git base ref "${baseRef}"`,
      'RUN_LOCATION_INVALID_BASE',
    );
  }
}

/** Resolve the selected ref once; the worktree setting owns network refresh policy. */
async function resolveWorktreeBase(
  baseRef: string,
  cwd: string,
  refresh: boolean,
): Promise<string> {
  assertSafeBaseRef(baseRef);
  const ref = refresh ? await resolvePreferredRef(baseRef, cwd) : baseRef;
  const result = await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd);
  const sha = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new LocalRunLocationError(
      `Could not resolve worktree base "${baseRef}": ${result.stderr || result.stdout}`,
      'RUN_LOCATION_INVALID_BASE',
    );
  }
  return sha;
}

async function resolvePreferredRef(baseRef: string, cwd: string): Promise<string> {
  const result = await git(['remote'], cwd);
  if (result.code !== 0) {
    throw new LocalRunLocationError(result.stderr, 'RUN_LOCATION_INVALID_BASE');
  }
  const remotes = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const localName = baseRef.replace(/^refs\/heads\//, '');
  const local = await git(['show-ref', '--verify', '--quiet', `refs/heads/${localName}`], cwd);
  if (local.code === 0 || baseRef === 'HEAD') {
    const branchResult =
      baseRef === 'HEAD'
        ? await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)
        : { stdout: localName };
    const branch = branchResult.stdout.trim();
    return branch ? resolveBranchUpstream(branch, cwd) : baseRef;
  }
  const shortRef = baseRef.replace(/^refs\/remotes\//, '');
  const remote = remotes.find((name) => shortRef.startsWith(`${name}/`));
  if (remote) return fetchBaseRef(remote, shortRef.slice(remote.length + 1), cwd);
  if (baseRef.startsWith('refs/remotes/')) {
    throw new LocalRunLocationError(
      `Remote no longer exists for ${baseRef}`,
      'RUN_LOCATION_FETCH_FAILED',
    );
  }
  return baseRef;
}

async function resolveBranchUpstream(branch: string, cwd: string): Promise<string> {
  const [remoteConfig, mergeConfig] = await Promise.all([
    git(['config', '--get', `branch.${branch}.remote`], cwd),
    git(['config', '--get', `branch.${branch}.merge`], cwd),
  ]);
  const remote = remoteConfig.stdout.trim();
  const mergeRef = mergeConfig.stdout.trim();
  if (remote === '.' && mergeRef) return mergeRef;
  if (remote && mergeRef.startsWith('refs/heads/')) {
    return fetchBaseRef(remote, mergeRef.slice('refs/heads/'.length), cwd);
  }
  return `refs/heads/${branch}`;
}

async function resolveRemoteBranch(remote: string, branch: string, cwd: string): Promise<string> {
  if (branch !== 'HEAD') return branch;
  const prefix = `refs/remotes/${remote}/`;
  const result = await git(['symbolic-ref', '--quiet', `${prefix}HEAD`], cwd);
  const target = result.stdout.trim();
  if (result.code !== 0 || !target.startsWith(prefix)) {
    throw new LocalRunLocationError(
      `Could not resolve ${remote}/HEAD`,
      'RUN_LOCATION_INVALID_BASE',
    );
  }
  return target.slice(prefix.length);
}

async function fetchBaseRef(
  remote: string,
  branch: string,
  cwd: string,
  timeoutMs = 60_000,
): Promise<string> {
  const resolvedBranch = await resolveRemoteBranch(remote, branch, cwd);
  const ref = `refs/remotes/${remote}/${resolvedBranch}`;
  const validRef = await git(['check-ref-format', ref], cwd);
  if (!remote || remote.startsWith('-') || !resolvedBranch || validRef.code !== 0) {
    throw new LocalRunLocationError(
      `Invalid remote base "${remote}/${resolvedBranch}"`,
      'RUN_LOCATION_INVALID_BASE',
    );
  }
  const result = await git(
    [
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--',
      remote,
      `+refs/heads/${resolvedBranch}:${ref}`,
    ],
    cwd,
    timeoutMs,
  );
  if (result.code !== 0) {
    throw new LocalRunLocationError(
      `Failed to fetch latest ${remote}/${resolvedBranch}. Retry or turn off upstream refresh in Worktree settings: ${result.stderr || result.stdout}`,
      'RUN_LOCATION_FETCH_FAILED',
    );
  }
  return ref;
}

async function assertSafeBranchName(branch: string, cwd: string): Promise<void> {
  if (branch.startsWith('-') || branch.startsWith('@') || branch.includes('\0')) {
    throw new LocalRunLocationError(
      `Invalid git branch name "${branch}"`,
      'RUN_LOCATION_INVALID_BRANCH',
    );
  }
  const result = await git(['check-ref-format', `refs/heads/${branch}`], cwd);
  if (result.code !== 0) {
    throw new LocalRunLocationError(
      `Invalid git branch name "${branch}": ${result.stderr || result.stdout}`,
      'RUN_LOCATION_INVALID_BRANCH',
    );
  }
}

async function git(
  args: readonly string[],
  cwd: string,
  timeoutMs?: number,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  try {
    const result = await execFile('git', args, {
      cwd,
      encoding: 'utf-8',
      env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0' },
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
    return { code: 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  } catch (error) {
    const failure = error as ExecFileException & {
      readonly stdout?: string | Buffer;
      readonly stderr?: string | Buffer;
    };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: bufferToString(failure.stdout),
      stderr: bufferToString(failure.stderr) || failure.message,
    };
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

function generateDefaultWorktreeBranch(nowMs: number): string {
  const date = new Date(nowMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `feat/auto-${stamp}-${randomBytes(4).toString('hex')}`;
}

function optionalField(value: object, key: string): Record<string, string> {
  const field = Reflect.get(value, key);
  return typeof field === 'string' && field.length > 0 ? { [key]: field } : {};
}

function bufferToString(value: string | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString('utf-8') : String(value ?? '');
}
