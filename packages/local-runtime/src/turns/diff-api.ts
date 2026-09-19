import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  LocalFileDiff,
  LocalTurnDiffRecord,
  LocalTurnDiffStore,
} from '../persistence/ports.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import { json } from '../api/host-helpers.js';
import { applyLocalTurnDiffSnapshotMutation } from './file-changes.js';

const execFile = promisify(execFileCallback);
// Read paths and metrics as NUL records; patch headers are presentation only.
const WORKSPACE_DIFF_ARGS = [
  '--raw',
  '--numstat',
  '-z',
  '--patch',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
];

export interface LocalDiffSession {
  readonly sessionId: string;
  readonly workspaceDir: string;
}

export interface LocalSessionDiffView {
  readonly diffs: LocalFileDiff[];
  readonly changeSetId?: string;
}

export interface LocalTurnDiffSelector {
  readonly assistantMessageId?: string;
  readonly turnId?: string;
  readonly changeSetId?: string;
}

export interface LocalTurnDiffView {
  readonly fileChanges: LocalFileDiff[];
  readonly sourceMessageId?: string;
  readonly changeSetId?: string;
  readonly status?: string;
  readonly revertedAt?: number;
  readonly undoable?: boolean;
  readonly canUndo?: boolean;
  readonly canReapply?: boolean;
}

export type LocalTurnDiffMutationBody = {
  readonly success: boolean;
  readonly error?: string;
} & Partial<LocalTurnDiffView>;

export interface LocalTurnDiffMutationOutcome {
  readonly status: 200 | 404 | 409;
  readonly body: LocalTurnDiffMutationBody;
}

export async function readLocalSessionDiff(input: {
  diffStore: LocalTurnDiffStore;
  session: LocalDiffSession;
  messageId?: string;
}): Promise<LocalSessionDiffView> {
  const record = input.messageId
    ? await input.diffStore.getByAssistantMessage(input.session.sessionId, input.messageId)
    : await input.diffStore.latestForSession(input.session.sessionId);
  if (record) return { diffs: record.fileChanges, changeSetId: record.changeSetId };
  const live = await readWorkspaceDiff(input.session.workspaceDir);
  return { diffs: live.fileChanges };
}

export async function readLocalTurnDiff(input: {
  diffStore: LocalTurnDiffStore;
  sessionId: string;
  selector?: LocalTurnDiffSelector;
}): Promise<LocalTurnDiffView> {
  const record = await findTurnDiffRecord(input.diffStore, input.sessionId, input.selector ?? {});
  if (!record) return { fileChanges: [] };
  const latest = await input.diffStore.latestForSession(input.sessionId);
  return serializeTurnDiffRecord(record, latest?.changeSetId === record.changeSetId);
}

export async function mutateLocalTurnDiff(input: {
  diffStore: LocalTurnDiffStore;
  sessionId: string;
  selector?: LocalTurnDiffSelector;
  action: 'revert' | 'reapply';
  nowMs: () => number;
}): Promise<LocalTurnDiffMutationOutcome> {
  const record = await findTurnDiffRecord(input.diffStore, input.sessionId, input.selector ?? {});
  if (!record) {
    return { status: 404, body: { success: false, error: 'Turn diff not found' } };
  }
  if (input.action === 'revert' && record.status === 'reverted') {
    return { status: 200, body: { success: true, ...serializeTurnDiffRecord(record, true) } };
  }
  if (input.action === 'reapply' && record.status === 'active') {
    return { status: 200, body: { success: true, ...serializeTurnDiffRecord(record, true) } };
  }
  const latest = await input.diffStore.latestForSession(input.sessionId);
  if (latest?.changeSetId !== record.changeSetId) {
    return {
      status: 409,
      body: { success: false, error: 'Only the latest turn diff can be changed' },
    };
  }
  const result = await applyTurnDiffMutation(record, input.action);
  if (!result.ok) {
    return { status: 409, body: { success: false, error: result.error } };
  }
  const updated = await input.diffStore.updateStatus(
    input.sessionId,
    record.changeSetId,
    input.action === 'revert' ? 'reverted' : 'active',
    input.action === 'revert' ? input.nowMs() : undefined,
  );
  return {
    status: 200,
    body: { success: true, ...serializeTurnDiffRecord(updated ?? record, true) },
  };
}

export async function routeLocalSessionDiffApi(input: {
  diffStore: LocalTurnDiffStore;
  session: LocalSessionRecord;
  url: URL;
}): Promise<Response> {
  const messageId =
    input.url.searchParams.get('messageID') ??
    input.url.searchParams.get('messageId') ??
    input.url.searchParams.get('assistantMessageId');
  return json(
    await readLocalSessionDiff({
      diffStore: input.diffStore,
      session: input.session,
      ...(messageId ? { messageId } : {}),
    }),
  );
}

export async function routeLocalTurnDiffApi(input: {
  diffStore: LocalTurnDiffStore;
  session: LocalSessionRecord;
  url: URL;
}): Promise<Response> {
  const result = await readLocalTurnDiff({
    diffStore: input.diffStore,
    sessionId: input.session.sessionId,
    selector: readTurnDiffSelector(input.url.searchParams),
  });
  return json(toLegacyTurnDiffBody(result));
}

export async function routeLocalTurnDiffMutationApi(input: {
  diffStore: LocalTurnDiffStore;
  session: LocalSessionRecord;
  action: 'revert' | 'reapply';
  body: Record<string, unknown>;
  nowMs: () => number;
}): Promise<Response> {
  const result = await mutateLocalTurnDiff({
    diffStore: input.diffStore,
    sessionId: input.session.sessionId,
    selector: readTurnDiffSelector(input.body),
    action: input.action,
    nowMs: input.nowMs,
  });
  return json(toLegacyTurnDiffBody(result.body), { status: result.status });
}

async function applyTurnDiffMutation(
  record: LocalTurnDiffRecord,
  action: 'revert' | 'reapply',
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (record.undoable && record.undo?.length) {
    const result = await applyLocalTurnDiffSnapshotMutation(record, action);
    return result.success
      ? { ok: true }
      : { ok: false, error: result.reason ?? 'Turn diff conflict' };
  }
  if (!record.rawDiff) return { ok: false, error: 'Turn diff is not undoable' };
  return applyGitPatch({
    cwd: record.workspaceDir,
    patch: record.rawDiff,
    reverse: action === 'revert',
  });
}

function serializeTurnDiffRecord(
  record: LocalTurnDiffRecord,
  isLatest: boolean,
): LocalTurnDiffView {
  const undoable = record.undoable === true || Boolean(record.rawDiff);
  return {
    fileChanges: record.fileChanges,
    sourceMessageId: record.assistantMessageId,
    changeSetId: record.changeSetId,
    status: record.status,
    revertedAt: record.revertedAt,
    undoable,
    canUndo: undoable && isLatest && record.status === 'active',
    canReapply: undoable && isLatest && record.status === 'reverted',
  };
}

async function findTurnDiffRecord(
  store: LocalTurnDiffStore,
  sessionId: string,
  selector: LocalTurnDiffSelector,
): Promise<LocalTurnDiffRecord | undefined> {
  if (selector.changeSetId) return store.getByChangeSetId(sessionId, selector.changeSetId);
  if (selector.assistantMessageId) {
    return store.getByAssistantMessage(sessionId, selector.assistantMessageId);
  }
  if (selector.turnId) return store.getByTurn(sessionId, selector.turnId);
  return store.latestForSession(sessionId);
}

function readTurnDiffSelector(
  source: URLSearchParams | Record<string, unknown>,
): LocalTurnDiffSelector {
  const read = (key: string): string | undefined => {
    if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
    return typeof source[key] === 'string' ? source[key] : undefined;
  };
  const assistantMessageId = read('assistantMessageId') ?? read('messageId') ?? read('messageID');
  return {
    ...(read('changeSetId') ? { changeSetId: read('changeSetId') } : {}),
    ...(assistantMessageId ? { assistantMessageId } : {}),
    ...(read('turnId') ? { turnId: read('turnId') } : {}),
  };
}

function toLegacyTurnDiffBody(
  view: LocalTurnDiffView | LocalTurnDiffMutationBody,
): Record<string, unknown> {
  const { fileChanges, ...rest } = view;
  return {
    ...rest,
    ...(fileChanges ? { file_changes: fileChanges } : {}),
  };
}

async function readWorkspaceDiff(
  workspaceDir: string,
): Promise<{ fileChanges: LocalFileDiff[]; rawDiff?: string }> {
  try {
    const result = await execGit(['diff', 'HEAD', ...WORKSPACE_DIFF_ARGS, '--'], workspaceDir);
    const trackedDiffs = parseGitDiffSummary(result.stdout);
    const untracked = await readUntrackedFiles(workspaceDir);
    const untrackedDiffs = await Promise.all(
      untracked.map((file) => readUntrackedFileDiff(workspaceDir, file)),
    );
    const raw = [
      ...trackedDiffs.flatMap((item) => item.diff ?? []),
      ...untrackedDiffs.flatMap((item) => item.rawDiff ?? []),
    ]
      .filter(Boolean)
      .join('\n');
    const fileChanges = [...trackedDiffs, ...untrackedDiffs.map((item) => item.fileChange)];
    return { fileChanges, ...(raw ? { rawDiff: raw } : {}) };
  } catch {
    return { fileChanges: [] };
  }
}

async function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFile('git', args, {
    cwd,
    env: cleanGitEnv(),
    maxBuffer: 10 * 1024 * 1024,
  });
}

function parseGitDiffSummary(output: string): LocalFileDiff[] {
  if (!output) return [];
  // --raw --numstat -z --patch emits raw records, then numstat records,
  // then an extra NUL before the patches. Git uses the same order for raw
  // records and patch blocks, including rename-only and binary changes.
  const boundary = output.indexOf('\0\0');
  if (boundary < 0) throw new Error('Git diff is missing its patch boundary');
  const records = output.slice(0, boundary).split('\0');
  const files: Array<{ file: string; status: string }> = [];
  let index = 0;
  while (records[index]?.startsWith(':')) {
    const status = records[index++]!.split(' ').at(-1)!;
    const source = records[index++];
    const file = /^[RC]/u.test(status) ? records[index++] : source;
    if (!file) throw new Error('Git diff is missing a raw path');
    files.push({ file, status: mapGitStatus(status) });
  }
  const stats = new Map<string, { additions: number; deletions: number }>();
  while (index < records.length) {
    const [additions, deletions, ...pathParts] = records[index++]!.split('\t');
    let file = pathParts.join('\t');
    // Renames/copies have an empty numstat path followed by old and new paths.
    if (!file) {
      index += 1;
      file = records[index++] ?? '';
    }
    if (!file) throw new Error('Git diff is missing a numstat path');
    stats.set(file, {
      additions: numericDiffStat(additions),
      deletions: numericDiffStat(deletions),
    });
  }
  const patches = output
    .slice(boundary + 2)
    .split(/(?=^diff --git )/mu)
    .filter(Boolean);
  if (files.length !== patches.length) {
    throw new Error('Git diff raw paths and patch blocks do not match');
  }
  return files.map(({ file, status }, position) => {
    const stat = stats.get(file);
    if (!stat) throw new Error('Git diff is missing file metrics');
    return { file, status, ...stat, diff: patches[position] };
  });
}

async function readUntrackedFiles(workspaceDir: string): Promise<string[]> {
  try {
    const result = await execGit(
      ['ls-files', '--others', '--exclude-standard', '-z'],
      workspaceDir,
    );
    return result.stdout.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

async function readUntrackedFileDiff(
  workspaceDir: string,
  file: string,
): Promise<{ fileChange: LocalFileDiff; rawDiff?: string }> {
  try {
    const rawDiff = await execFile(
      'git',
      ['diff', '--no-index', ...WORKSPACE_DIFF_ARGS, '--', '/dev/null', file],
      {
        cwd: workspaceDir,
        env: cleanGitEnv(),
        maxBuffer: 10 * 1024 * 1024,
      },
    ).catch((err: unknown) => {
      const error = err as { stdout?: string; code?: number };
      if (error.code === 1 && typeof error.stdout === 'string') return { stdout: error.stdout };
      throw err;
    });
    const parsed = parseGitDiffSummary(rawDiff.stdout)[0];
    if (!parsed) throw new Error('Git diff is missing an untracked file');
    return {
      fileChange: { ...parsed, file, status: 'added' },
      ...(parsed.diff ? { rawDiff: parsed.diff } : {}),
    };
  } catch {
    return {
      fileChange: {
        file,
        additions: 0,
        deletions: 0,
        status: 'added',
      },
    };
  }
}

function mapGitStatus(status: string | undefined): string {
  const code = status?.[0];
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  return 'modified';
}

function numericDiffStat(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function applyGitPatch(input: {
  cwd: string;
  patch: string;
  reverse: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const args = ['apply', '--whitespace=nowarn', ...(input.reverse ? ['--reverse'] : [])];
    const child = spawn('git', args, { cwd: input.cwd, env: cleanGitEnv() });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      resolve({ ok: false, error: stderr.trim() || `git apply exited with ${String(code)}` });
    });
    child.stdin.end(input.patch);
  });
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  delete env['GIT_INDEX_FILE'];
  delete env['GIT_PREFIX'];
  delete env['GIT_OBJECT_DIRECTORY'];
  delete env['GIT_ALTERNATE_OBJECT_DIRECTORIES'];
  return env;
}
