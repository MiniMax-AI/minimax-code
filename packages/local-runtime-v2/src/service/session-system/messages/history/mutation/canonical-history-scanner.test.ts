import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalHistoryRevision } from '../../../../../infra/file/canonical-history.js';
import {
  scanCanonicalHistoryArtifacts,
  type CanonicalHistoryScannerPaths,
} from './canonical-history-scanner.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('scanCanonicalHistoryArtifacts', () => {
  it('reports the reachable chain without building a user-message locator index', async () => {
    const paths = await fixture({
      active: [user('msg-user-v1-u1'), assistant('msg-a1')],
    });

    const result = await scanCanonicalHistoryArtifacts(paths);

    expect(result.catalog.activeGeneration).toBe(0);
    expect(result.catalog.artifacts.map((artifact) => artifact.fileName)).toEqual([
      'messages.jsonl',
    ]);
    expect(result.orphans).toEqual([]);
    // The removed on-disk index was the only consumer of locators; nothing
    // writes a per-user-message offset list any more.
    expect(result).not.toHaveProperty('locators');
  });

  it('validates a g0/g1 reachable chain and reports the orphan snapshot', async () => {
    const g0 = [user('msg-user-v1-u1'), assistant('msg-a1')];
    const active = [
      userWithMarker('msg-user-v1-c1', marker(1, 0, 'zero', revision(g0))),
      user('msg-user-v1-u2'),
    ];
    const paths = await fixture({
      active,
      snapshots: {
        'g000000000000--zero.jsonl': g0,
        'g000000000099--orphan.jsonl': [assistant('msg-orphan')],
      },
    });

    const result = await scanCanonicalHistoryArtifacts(paths);

    expect(result.catalog.activeGeneration).toBe(1);
    expect(result.catalog.artifacts.map((artifact) => artifact.generation)).toEqual([
      0, 1,
    ]);
    expect(result.orphans).toEqual(['g000000000099--orphan.jsonl']);
  });

  it('still refuses a reachable chain whose external user message changed across generations', async () => {
    const g0 = [user('msg-user-v1-u1', 'first ask'), assistant('msg-a1')];
    const active = [
      userWithMarker('msg-user-v1-c1', marker(1, 0, 'zero', revision(g0))),
      user('msg-user-v1-u1', 'rewritten ask'),
    ];
    const paths = await fixture({
      active,
      snapshots: { 'g000000000000--zero.jsonl': g0 },
    });

    await expect(scanCanonicalHistoryArtifacts(paths)).rejects.toThrow(
      /external-user-lineage-conflict/u,
    );
  });
});

async function fixture(input: {
  active: unknown[];
  snapshots?: Record<string, unknown[]>;
}): Promise<CanonicalHistoryScannerPaths> {
  const root = await mkdtemp(join(tmpdir(), 'history-scanner-'));
  tempDirs.push(root);
  await mkdir(join(root, 'snapshots'));
  await writeFile(
    join(root, 'messages.jsonl'),
    `${input.active.map((value) => JSON.stringify(value)).join('\n')}\n`,
    'utf8',
  );
  for (const [name, records] of Object.entries(input.snapshots ?? {})) {
    await writeFile(
      join(root, 'snapshots', name),
      `${records.map((value) => JSON.stringify(value)).join('\n')}\n`,
      'utf8',
    );
  }
  return {
    activePath: join(root, 'messages.jsonl'),
    snapshotsPath: join(root, 'snapshots'),
    sessionId: 's1',
  };
}

function envelope(
  id: string,
  role: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  return {
    message_id: id,
    turn_id: id,
    message: {
      role,
      timestamp: 1,
      ...(role === 'user' ? { content } : { content: [] }),
      ...extra,
    },
    ...(role === 'user'
      ? {
          turn_config: {
            system_prompt: '',
            model: { provider: 'test', id: 'test' },
            tools: [],
          },
        }
      : {}),
  };
}

function user(id: string, content = 'hello') {
  return envelope(id, 'user', content);
}

function userWithMarker(id: string, archonCompaction: unknown) {
  return envelope(id, 'user', 'hello', { archonCompaction });
}

function assistant(id: string) {
  return envelope(id, 'assistant', '');
}

function marker(
  generation: number,
  parentGeneration: number,
  compactionId: string,
  parentRevision: string,
) {
  return {
    schemaVersion: 2,
    summary: 'summary',
    generation,
    parentSnapshot: {
      generation: parentGeneration,
      compactionId,
      revision: parentRevision,
    },
  };
}

function revision(records: unknown[]) {
  return canonicalHistoryRevision(records as never[]);
}
