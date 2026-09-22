/**
 * Issue #282: concurrent `mcode` processes share one `runtime-state.sqlite`
 * (WAL). A foreign writer that outlasts the five-second native `busy_timeout`
 * used to make the turn-critical write paths throw `SQLITE_BUSY`, which
 * aborted the whole turn at admission, state projection or settlement.
 *
 * These tests drive the real DatabaseClient (real better-sqlite3, real schema)
 * and hold the write lock from a separate process, exactly like a second
 * `mcode` session would. Message upsert is covered by
 * `test/sqlite-message-contention.test.ts`; the paths here are the ones that
 * still failed after that fix.
 */
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DatabaseClient } from '../packages/local-runtime-v2/src/infra/db/client.js';
import { initializeDatabase } from '../packages/local-runtime-v2/src/infra/db/initialize.js';
import { createMessageRepository } from '../packages/local-runtime-v2/src/service/session-system/messages/repo/drizzle.js';
import { createQueueTurnAdmissionPriorityFence } from '../packages/local-runtime-v2/src/service/session-system/queue/turn-priority-fence.js';
import { createSessionRepository } from '../packages/local-runtime-v2/src/service/session-system/sessions/repo/drizzle.js';
import { createTurnRepository } from '../packages/local-runtime-v2/src/service/turn-system/persistence/turn.repository.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'mcode-282-repro-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const client = new DatabaseClient({ dataDir });
  cleanup.push(() => client.close());
  await initializeDatabase({ database: client, dataDir });
  const sessions = createSessionRepository({ db: client.db, nowMs: () => 1_000 });
  const messages = createMessageRepository({ db: client.db, sourceProjectionEnabled: false });
  const turns = createTurnRepository({
    db: client.db,
    priorityFence: createQueueTurnAdmissionPriorityFence(),
    sessionAdmission: { rejectionInTransaction: () => undefined },
    nowMs: () => 1_000,
    makeLeaseId: () => 'lease-282',
  });
  await sessions.create({
    sessionId: 's-282',
    agentName: 'mavis',
    workspaceDir: join(dataDir, 'ws'),
    runtime: 'pi-agent',
  });
  return { client, dataDir, sessions, messages, turns };
}

async function holdWriter(dataDir: string, durationMs: number) {
  const file = join(dataDir, 'lock-holder.cjs');
  await writeFile(
    file,
    `
    const Database = require(process.argv[2]);
    const db = new Database(process.argv[3]);
    db.exec('BEGIN IMMEDIATE');
    process.send('locked');
    setTimeout(() => {
      db.exec('COMMIT');
      db.close();
      process.disconnect();
    }, Number(process.argv[4]));
  `,
  );
  const child = fork(
    file,
    [
      createRequire(import.meta.url).resolve('better-sqlite3'),
      join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'),
      String(durationMs),
    ],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  const exited = once(child, 'exit');
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await Promise.race([
    once(child, 'message'),
    exited.then(() => {
      throw new Error('Lock holder exited before acquiring the lock');
    }),
  ]);
  return { exited };
}

function admitInput() {
  return {
    sessionId: 's-282',
    turnId: 'turn-282',
    busyReason: 'turn' as const,
    inputDigest: 'digest:282',
    inputMetadata: { attachmentCount: 0, hasContent: true },
    candidateCreatedAtMs: 1_000,
    priority: { kind: 'retry-continuation' as const },
  };
}

const FOREIGN_LOCK_MS = 8_000;

it('commits a message after a foreign writer outlasts the native busy timeout', async () => {
  const { dataDir, messages } = await fixture();
  await holdWriter(dataDir, FOREIGN_LOCK_MS);
  await messages.upsert({
    sessionId: 's-282',
    message: { msg_id: 'assistant-1', role: 'assistant' },
  });
  expect((await messages.list('s-282')).messages.map((message) => message.msg_id)).toEqual([
    'assistant-1',
  ]);
}, 20_000);

it('admits a turn after a foreign writer outlasts the native busy timeout', async () => {
  const { dataDir, turns } = await fixture();
  await holdWriter(dataDir, FOREIGN_LOCK_MS);
  await expect(turns.admit(admitInput())).resolves.toMatchObject({ status: 'accepted' });
  expect((await turns.findActiveTurn('s-282'))?.turnId).toBe('turn-282');
}, 20_000);

it('applies agent state after a foreign writer outlasts the native busy timeout', async () => {
  const { dataDir, sessions } = await fixture();
  await holdWriter(dataDir, FOREIGN_LOCK_MS);
  await expect(
    sessions.applyAgentState({
      sessionId: 's-282',
      turnId: 'turn-282',
      turnSequence: 1,
      eventId: 'evt-1',
      update: { status: 'started' },
    }),
  ).resolves.toEqual({ status: 'applied' });
  expect((await sessions.get('s-282'))?.status).toBe('started');
}, 20_000);

it('settles a turn after a foreign writer outlasts the native busy timeout', async () => {
  const { dataDir, turns } = await fixture();
  await turns.admit(admitInput());
  await holdWriter(dataDir, FOREIGN_LOCK_MS);
  await expect(
    turns.settle({
      sessionId: 's-282',
      turnId: 'turn-282',
      leaseId: 'lease-282',
      outcome: 'completed',
    }),
  ).resolves.toMatchObject({ status: 'settled', outcome: 'completed' });
  expect(await turns.findActiveTurn('s-282')).toBeUndefined();
}, 20_000);
