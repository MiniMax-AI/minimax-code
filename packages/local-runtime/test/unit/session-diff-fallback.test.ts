import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeLocalRuntimeDb } from '../../src/persistence/db.js';
import { SqliteLocalTurnDiffStore } from '../../src/persistence/sqlite-persistence.js';
import { readLocalSessionDiff } from '../../src/turns/diff-api.js';

let root: string;
let workspaceDir: string;
let dataDir: string;
let diffStore: SqliteLocalTurnDiffStore;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: workspaceDir, encoding: 'utf8' });
}

async function write(file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(workspaceDir, file)), { recursive: true });
  await writeFile(path.join(workspaceDir, file), content);
}

function commit(): void {
  git('add', '--all');
  git('commit', '-qm', 'Synthetic baseline');
}

async function read(messageId?: string) {
  return readLocalSessionDiff({
    diffStore,
    session: { sessionId: 'test-session', workspaceDir },
    messageId,
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'session-diff-'));
  workspaceDir = path.join(root, 'workspace');
  dataDir = path.join(root, 'data');
  await mkdir(workspaceDir);
  // Keep user hooks, attributes, diff drivers and quoting defaults out of fixtures.
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'no-global-config'));
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) {
    vi.stubEnv(key, undefined);
  }
  git('init', '-q');
  git('config', 'user.name', 'Diff Test');
  git('config', 'user.email', 'diff-test@example.com');
  git('config', 'core.autocrlf', 'false');
  git('config', 'diff.renames', 'true');
  await write('baseline.txt', 'unchanged\n');
  commit();
  diffStore = new SqliteLocalTurnDiffStore(dataDir);
});

afterEach(async () => {
  closeLocalRuntimeDb(dataDir);
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const portableNames = ['中文.txt', 'with spaces.txt', 'dir/{before after}.txt'];
const posixNames = [
  'tab\tname.txt',
  'line\nname.txt',
  'literal => arrow.txt',
  ' quote"slash\\.txt',
  ' trailing.txt ',
];

describe.each(['true', 'false'])('session diff fallback with core.quotePath=%s', (quotePath) => {
  beforeEach(() => {
    git('config', 'core.quotePath', quotePath);
  });

  it('preserves Unicode paths and attaches each tracked patch through the public API', async () => {
    for (const file of portableNames) await write(file, 'first\n');
    commit();
    for (const [index, file] of portableNames.entries()) {
      await appendFile(path.join(workspaceDir, file), `added-${index}\n`);
    }
    const result = await read();
    expect(result.diffs).toHaveLength(portableNames.length);
    for (const [index, file] of portableNames.entries()) {
      expect(result.diffs.find((entry) => entry.file === file)).toMatchObject({
        file,
        additions: 1,
        deletions: 0,
        status: 'modified',
        diff: expect.stringContaining(`+added-${index}\n`),
      });
    }
  });

  it('reports rename edits against the destination path', async () => {
    await write('before.txt', 'a\nb\nc\nd\ne\nf\n');
    commit();
    git('mv', 'before.txt', 'after.txt');
    await appendFile(path.join(workspaceDir, 'after.txt'), 'added\n');
    expect((await read('missing-message')).diffs).toEqual([
      {
        file: 'after.txt',
        additions: 1,
        deletions: 0,
        status: 'renamed',
        diff: expect.stringContaining('+added\n'),
      },
    ]);
  });

  it('keeps additions, deletions, binary changes and untracked paths distinct', async () => {
    await write('deleted 中文.txt', 'remove\n');
    await write('binary.bin', Buffer.from([0, 1, 2]));
    commit();
    await rm(path.join(workspaceDir, 'deleted 中文.txt'));
    await write('binary.bin', Buffer.from([0, 3, 4]));
    await write('staged 中文.txt', 'staged\n');
    git('add', '--', 'staged 中文.txt');
    for (const file of portableNames) await write(file, 'untracked\n++content\n');
    await write('untracked.bin', Buffer.from([0, 5, 6]));
    await write('empty.txt', '');
    const { diffs } = await read();
    expect(diffs).toHaveLength(portableNames.length + 5);
    expect(diffs.find((entry) => entry.file === 'deleted 中文.txt')).toMatchObject({
      additions: 0,
      deletions: 1,
      status: 'deleted',
      diff: expect.stringContaining('-remove\n'),
    });
    expect(diffs.find((entry) => entry.file === 'staged 中文.txt')).toMatchObject({
      additions: 1,
      deletions: 0,
      status: 'added',
      diff: expect.stringContaining('+staged\n'),
    });
    for (const file of ['binary.bin', 'untracked.bin']) {
      expect(diffs.find((entry) => entry.file === file)).toMatchObject({
        additions: 0,
        deletions: 0,
        diff: expect.stringContaining('Binary files '),
      });
    }
    for (const file of portableNames) {
      expect(diffs.find((entry) => entry.file === file)).toMatchObject({
        additions: 2,
        deletions: 0,
        status: 'added',
        diff: expect.stringContaining('+++content\n'),
      });
    }
    expect(diffs.find((entry) => entry.file === 'empty.txt')).toMatchObject({
      additions: 0,
      deletions: 0,
      status: 'added',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'preserves POSIX whitespace, escape and arrow names for tracked and untracked files',
    async () => {
      for (const file of posixNames) await write(file, 'first\n');
      commit();
      for (const [index, file] of posixNames.entries()) {
        await appendFile(path.join(workspaceDir, file), `tracked-${index}\n`);
        await write(`untracked/${file}`, `untracked-${index}\n`);
      }
      const { diffs } = await read();
      expect(diffs).toHaveLength(posixNames.length * 2);
      for (const [index, file] of posixNames.entries()) {
        expect(diffs.find((entry) => entry.file === file)).toMatchObject({
          additions: 1,
          deletions: 0,
          diff: expect.stringContaining(`+tracked-${index}\n`),
        });
        expect(diffs.find((entry) => entry.file === `untracked/${file}`)).toMatchObject({
          additions: 1,
          deletions: 0,
          diff: expect.stringContaining(`+untracked-${index}\n`),
        });
      }
    },
  );

  it('retains a rename-only patch with zero line changes', async () => {
    await write('old 中文.txt', 'same\n');
    commit();
    git('mv', 'old 中文.txt', 'new 中文.txt');
    expect((await read()).diffs).toEqual([
      {
        file: 'new 中文.txt',
        additions: 0,
        deletions: 0,
        status: 'renamed',
        diff: expect.stringContaining('similarity index 100%'),
      },
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'consumes both rename paths without splitting tabs or literal arrows',
    async () => {
      const source = 'dir/old\tline\n{left => right}.txt';
      const destination = 'dir/new\tline\n{right => left}.txt';
      await write(source, 'a\nb\nc\nd\ne\nf\n');
      commit();
      git('mv', source, destination);
      await appendFile(path.join(workspaceDir, destination), 'renamed\n');
      expect((await read()).diffs).toEqual([
        {
          file: destination,
          additions: 1,
          deletions: 0,
          status: 'renamed',
          diff: expect.stringContaining('+renamed\n'),
        },
      ]);
    },
  );

  it('handles brace-compressed renames and copies with destination stats and patches', async () => {
    await write('dir/old 中文.txt', 'a\nb\nc\nd\ne\nf\n');
    await write('copy-source.txt', 'unique\ncopy\nsource\nlines\nhere\nend\n');
    commit();
    git('mv', 'dir/old 中文.txt', 'dir/new 中文.txt');
    await appendFile(path.join(workspaceDir, 'dir/new 中文.txt'), 'renamed\n');
    await appendFile(path.join(workspaceDir, 'copy-source.txt'), 'source-edit\n');
    await write('copy 中文.txt', 'unique\ncopy\nsource\nlines\nhere\nend\ncopied\n');
    git('add', '--', 'copy 中文.txt');
    git('config', 'diff.renames', 'copies');
    const { diffs } = await read();
    expect(diffs).toHaveLength(3);
    expect(diffs.find((entry) => entry.file === 'dir/new 中文.txt')).toMatchObject({
      additions: 1,
      deletions: 0,
      status: 'renamed',
      diff: expect.stringContaining('+renamed\n'),
    });
    expect(diffs.find((entry) => entry.file === 'copy 中文.txt')).toMatchObject({
      additions: 1,
      deletions: 0,
      status: 'copied',
      diff: expect.stringContaining('+copied\n'),
    });
    expect(diffs.find((entry) => entry.file === 'copy-source.txt')).toMatchObject({
      additions: 1,
      deletions: 0,
      status: 'modified',
      diff: expect.stringContaining('+source-edit\n'),
    });
  });
});

it('returns an empty diff for a clean workspace', async () => {
  expect(await read()).toEqual({ diffs: [] });
});

it('prefers stored session/message diffs and falls back only when the selected record is absent', async () => {
  await write('live.txt', 'live\n');
  const fileChanges = [{ file: 'stored.txt', additions: 7, deletions: 2, diff: 'stored patch' }];
  await diffStore.upsert({
    sessionId: 'test-session',
    turnId: 'test-turn',
    changeSetId: 'test-change',
    assistantMessageId: 'test-message',
    workspaceDir,
    capturedAtMs: Date.now(),
    status: 'active',
    fileChanges,
  });
  for (const messageId of [undefined, 'test-message']) {
    expect(await read(messageId)).toEqual({ diffs: fileChanges, changeSetId: 'test-change' });
  }
  expect((await read('absent-message')).diffs).toEqual([
    {
      file: 'live.txt',
      additions: 1,
      deletions: 0,
      status: 'added',
      diff: expect.stringContaining('+live\n'),
    },
  ]);
});

it('associates patches without relying on color or path prefixes', async () => {
  await write('中文.txt', 'first\n');
  commit();
  await appendFile(path.join(workspaceDir, '中文.txt'), 'added\n');
  git('config', 'color.ui', 'always');
  git('config', 'diff.noprefix', 'true');
  expect((await read()).diffs).toEqual([
    {
      file: '中文.txt',
      additions: 1,
      deletions: 0,
      status: 'modified',
      diff: expect.stringContaining('+added\n'),
    },
  ]);
});
