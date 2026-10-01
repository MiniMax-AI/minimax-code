import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { RUNTIME_EVENT_SCHEMA, RuntimeEventType } from '@mavis/agent-core/protocol';
import { RespDataType, type AgentMessage } from '@mavis/agent-core/protocol/agent-message';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DatabaseClient,
  type AppDb,
} from '../packages/local-runtime-v2/src/infra/db/client.js';
import { initializeDatabase } from '../packages/local-runtime-v2/src/infra/db/initialize.js';
import {
  runWithWriteLock,
  WriteLockWaitAbortedError,
} from '../packages/local-runtime-v2/src/infra/db/write-transaction.js';
import { createSessionSystemAgentProjection } from '../packages/local-runtime-v2/src/service/session-system/agent-projection.js';
import { createMessageRepository } from '../packages/local-runtime-v2/src/service/session-system/messages/repo/drizzle.js';
import { RequiredAgentEventDelivery } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/events/required-agent-event-delivery.js';
import { TurnCommitPipeline } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/events/turn-commit-pipeline.js';
import { AgentHostCommittedHistoryWriter } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/history/committed-history-writer.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'mcode-message-contention-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const client = new DatabaseClient({ dataDir });
  cleanup.push(() => client.close());
  await initializeDatabase({ database: client, dataDir });
  const messages = createMessageRepository({ db: client.db, sourceProjectionEnabled: false });
  await messages.upsert({ sessionId: 'synthetic', message: { msg_id: 'seed', role: 'user' } });
  return { client, messages, dataDir };
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

it('commits one message after a foreign writer outlasts the native busy timeout', async () => {
  const { dataDir, messages } = await fixture();
  await holdWriter(dataDir, 6_500);
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 20);
  try {
    await messages.upsert({
      sessionId: 'synthetic',
      message: { msg_id: 'answer', role: 'assistant' },
    });
  } finally {
    clearInterval(timer);
  }
  expect((await messages.list('synthetic')).messages.map((message) => message.msg_id)).toEqual([
    'seed',
    'answer',
  ]);
  expect(ticks).toBeGreaterThan(20);
}, 20_000);

it('bounds admission retries and restores the shared connection timeout before yielding', async () => {
  const { client, dataDir } = await fixture();
  client.db.run(sql`PRAGMA busy_timeout = 1234`);
  await holdWriter(dataDir, 2_000);
  const mutation = vi.fn();
  const started = performance.now();
  const pending = runWithWriteLock(client.db, mutation, { timeoutMs: 200 });
  expect(client.db.get(sql`PRAGMA busy_timeout`)).toEqual({ timeout: 1234 });
  await expect(pending).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(mutation).not.toHaveBeenCalled();
  expect(client.db.get(sql`PRAGMA busy_timeout`)).toEqual({ timeout: 1234 });
});

it.each(['SQLITE_BUSY', 'SQLITE_CONSTRAINT_UNIQUE'])(
  'rolls back without replaying a callback that throws %s',
  async (code) => {
    const { client } = await fixture();
    client.db.run(sql`CREATE TABLE contention_probe (value INTEGER)`);
    const error = Object.assign(new Error('Synthetic callback failure'), { code });
    const mutation = vi.fn((tx: AppDb) => {
      expect(client.db.get(sql`PRAGMA busy_timeout`)).toEqual({ timeout: 5000 });
      tx.run(sql`INSERT INTO contention_probe VALUES (1)`);
      throw error;
    });
    await expect(runWithWriteLock(client.db, mutation)).rejects.toBe(error);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(client.db.all(sql`SELECT * FROM contention_probe`)).toEqual([]);
    expect(client.db.get(sql`PRAGMA busy_timeout`)).toEqual({ timeout: 5000 });
  },
);

it('persists uncontended cleanup messages after the lease is cancelled', async () => {
  const { messages } = await fixture();
  const controller = new AbortController();
  controller.abort(new Error('Synthetic cancellation'));
  await messages.upsert(
    { sessionId: 'synthetic', message: { msg_id: 'tool-completion', role: 'assistant' } },
    { signal: controller.signal },
  );
  expect((await messages.list('synthetic')).messages.map((message) => message.msg_id)).toEqual([
    'seed',
    'tool-completion',
  ]);
});

it('does not wait for a contended cleanup write when its lease is already cancelled', async () => {
  const { client, dataDir, messages } = await fixture();
  const controller = new AbortController();
  controller.abort(new Error('Synthetic cancellation'));
  const { exited } = await holdWriter(dataDir, 1_500);
  const started = performance.now();
  await expect(
    messages.upsert(
      { sessionId: 'synthetic', message: { msg_id: 'cancelled', role: 'assistant' } },
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({
    name: 'WriteLockWaitAbortedError',
    signal: controller.signal,
    cause: controller.signal.reason,
  });
  expect(performance.now() - started).toBeLessThan(500);
  expect(client.db.get(sql`PRAGMA busy_timeout`)).toEqual({ timeout: 5000 });
  await exited;
  expect((await messages.list('synthetic')).messages.map((message) => message.msg_id)).toEqual([
    'seed',
  ]);
});

async function pipelineFixture() {
  const storage = await fixture();
  const { messages } = storage;
  const controller = new AbortController();
  const context = { sessionId: 'synthetic', turnId: 'turn', turnSequence: 1 };
  const projection = createSessionSystemAgentProjection({
    messages,
    sessions: { update: vi.fn() },
    state: { markStarted: vi.fn(), markIdle: vi.fn(), markTerminal: vi.fn() },
    stream: { write: vi.fn() },
    conversationFacts: { handle: vi.fn() },
  });
  const stream = { projectRuntimeEvent: vi.fn() };
  const events = new RequiredAgentEventDelivery({
    projectors: {
      session: projection.session,
      messages: projection.messages,
      stream,
      turnFacts: { projectRuntimeEvent: vi.fn(), projectHistoryCommitted: vi.fn() },
    },
  });
  const pipeline = new TurnCommitPipeline({
    context,
    lease: {
      ...context,
      leaseId: 'lease',
      acceptedSequence: 1,
      acceptedAtMs: 1,
      busyReason: 'turn',
      signal: controller.signal,
    },
    initialHistory: { revision: 'initial', messages: [] },
    events,
    committedHistory: new AgentHostCommittedHistoryWriter({
      events,
      history: { read: vi.fn(), append: vi.fn(), replace: vi.fn() },
    }),
    isRuntimeErrorRetryable: () => false,
  });
  return { ...storage, controller, pipeline, stream };
}

it('cancels a blocked write through the turn event pipeline without persisting it later', async () => {
  const { client, dataDir, messages, controller, pipeline, stream } = await pipelineFixture();
  const { exited } = await holdWriter(dataDir, 1_500);
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await expect(pipeline.onRuntimeEvent(messageEvent())).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
  } finally {
    clearTimeout(timer);
  }
  expect(client.db.get(sql`PRAGMA busy_timeout`)).toEqual({ timeout: 5000 });
  expect(stream.projectRuntimeEvent).not.toHaveBeenCalled();
  await exited;
  expect((await messages.list('synthetic')).messages.map((message) => message.msg_id)).toEqual([
    'seed',
  ]);
  await expect(pipeline.drain()).resolves.toBeUndefined();
});

it.each(['before', 'during'])(
  'preserves completed tool facts when the lease is cancelled %s contention',
  async (timing) => {
    const { dataDir, messages, controller, pipeline, stream } = await pipelineFixture();
    const completedTool: AgentMessage = {
      msg_id: 'completed-tool',
      role: 'assistant',
      tool_calls: [
        {
          tool_call_id: 'executed-tool',
          tool_name: 'bash',
          tool_call_status: 2,
          tool_call_args: '{"command":"echo synthetic"}',
          tool_call_result_data: '{"output":"synthetic","exitCode":0}',
        },
      ],
    };
    const { exited } = await holdWriter(dataDir, 1_500);
    if (timing === 'before') controller.abort();
    const timer = timing === 'during' ? setTimeout(() => controller.abort(), 100) : undefined;
    try {
      await pipeline.onRuntimeEvent(messageEvent(completedTool));
    } finally {
      clearTimeout(timer);
    }
    await exited;
    expect(controller.signal.aborted).toBe(true);
    const persisted = (await messages.list('synthetic')).messages;
    expect(
      persisted.find((message) => message.msg_id === 'completed-tool')?.tool_calls,
    ).toEqual(completedTool.tool_calls);
    expect(stream.projectRuntimeEvent).toHaveBeenCalledTimes(1);
    await expect(pipeline.drain()).resolves.toBeUndefined();
  },
);

function messageEvent(message: AgentMessage = { msg_id: 'cancelled', role: 'assistant' }) {
  return {
    schema: RUNTIME_EVENT_SCHEMA,
    event_id: 'blocked-message',
    session_id: 'synthetic',
    turn_id: 'turn',
    runtime_seq: 1,
    type: RuntimeEventType.STREAM_RESP,
    payload: {
      stream_resp: JSON.stringify({
        type: RespDataType.AgentMessage,
        agent_message: message,
      }),
    },
  };
}

it.each(['unrelated-abort', 'different-lease', 'mutation-failure'])(
  'preserves fail-closed delivery for %s even when the current lease is cancelled',
  async (kind) => {
    const { client, messages, controller, pipeline } = await pipelineFixture();
    const other = new AbortController();
    other.abort();
    const error =
      kind === 'different-lease'
        ? new WriteLockWaitAbortedError(other.signal)
        : new DOMException('Synthetic unrelated failure', 'AbortError');
    vi.spyOn(messages, 'upsert').mockImplementation(async () => {
      if (kind === 'mutation-failure') {
        // Cancellation during a callback must not reclassify its error as an
        // abandoned admission: the transaction started and must fail closed.
        return runWithWriteLock(
          client.db,
          () => {
            controller.abort(error);
            throw error;
          },
          { signal: controller.signal },
        );
      }
      controller.abort(error);
      throw error;
    });
    await expect(pipeline.onRuntimeEvent(messageEvent())).rejects.toBe(error);
    await expect(pipeline.drain()).rejects.toBe(error);
  },
);
