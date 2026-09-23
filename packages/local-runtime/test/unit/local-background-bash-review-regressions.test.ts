import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  runManagedForegroundLocalBash,
  startBackgroundLocalBash,
} from '../../src/background-task/bash-runner.js';
import { recordBashMetrics } from '../../src/background-task/bash-runner-lifecycle.js';
import { BackgroundBashOutputWriter } from '../../src/background-task/bash-output-writer.js';
import type { LocalTaskRunnerHostWithSessionLookup } from '../../src/api/local-task-host.js';
import { LocalBackgroundTaskService } from '../../src/background-task/service.js';
import {
  FsLocalTaskOutputStore,
  SqliteLocalBackgroundTaskStore,
} from '../../src/background-task/store.js';
import { closeLocalRuntimeDb } from '../../src/persistence/db.js';
import {
  backgroundBashHost,
  parentSessionRecord,
  toolContext,
  waitForTaskStatus,
} from './background-task-test-helpers.js';

describe('local background bash review regressions', () => {
  it('records Bash completion correlation even when the metrics client throws', () => {
    const recorded: unknown[] = [];
    const host = {
      metricsClient: {
        counter: () => {
          throw new Error('metrics unavailable');
        },
      },
      matrixLogger: {
        warn: () => {
          throw new Error('logger unavailable');
        },
      },
      recordSessionBashCompletion: (sessionId: string, completion: unknown) =>
        recorded.push({ sessionId, completion }),
    } as unknown as LocalTaskRunnerHostWithSessionLookup;

    expect(() =>
      recordBashMetrics(
        host,
        'session-a',
        {
          taskId: 'task-a',
          status: 'succeeded',
          text: '',
          endedAt: 2_000,
          durationMs: 1_000,
          outputBytes: 0,
        },
        'managed_foreground',
      ),
    ).not.toThrow();

    expect(recorded).toEqual([
      { sessionId: 'session-a', completion: { endedAt: 2_000, durationMs: 1_000 } },
    ]);
  });

  it('aligns arbitrary byte offsets before returning a four-byte UTF-8 code point', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-utf8-range-'));
    try {
      const outputStore = new FsLocalTaskOutputStore(dataDir);
      await outputStore.append({ taskId: 'utf8-offset', content: '😀😀' });

      const page = await outputStore.read('utf8-offset', { offset: 1, limitBytes: 1 });
      const fractionalPage = await outputStore.read('utf8-offset', {
        offset: 1.5,
        limitBytes: 1,
      });

      expect(page.content).toBe('😀');
      expect(page.content).not.toContain('�');
      expect(page.nextOffset).toBe(8);
      expect(page.truncated).toBe(false);
      expect(fractionalPage).toMatchObject(page);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('propagates a parent abort from managed foreground instead of returning completed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-managed-bash-parent-abort-'));
    try {
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 71_000),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 71_000,
      });
      const host = backgroundBashHost(service, dataDir);
      const parentAbort = new AbortController();
      let markExecutorStarted!: () => void;
      const executorStarted = new Promise<void>((resolve) => {
        markExecutorStarted = resolve;
      });
      const result = runManagedForegroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { command: 'wait for cancel', timeout: 120 },
        softYieldMs: 5_000,
        signal: parentAbort.signal,
        executor: {
          execute: ({ signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              markExecutorStarted();
            }),
        },
      });

      await executorStarted;
      const abortError = Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
      parentAbort.abort(abortError);

      await expect(result).rejects.toBe(abortError);
      const tasks = await service.list({ ownerSessionId: 'session-a' });
      expect(tasks.items).toHaveLength(1);
      expect(tasks.items[0]?.status).toBe('canceled');
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('repairs task output after a streamed append fails mid-command', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-output-repair-'));
    try {
      const backingOutputStore = new FsLocalTaskOutputStore(dataDir);
      let appendCount = 0;
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 72_000),
        outputStore: {
          append: async (chunk) => {
            appendCount += 1;
            if (appendCount === 2) throw new Error('transient output append failure');
            return backingOutputStore.append(chunk);
          },
          read: (taskId, options) => backingOutputStore.read(taskId, options),
          tail: (taskId, limitBytes) => backingOutputStore.tail(taskId, limitBytes),
          finalize: (taskId, summary) => backingOutputStore.finalize(taskId, summary),
        },
        nowMs: () => 72_000,
      });
      const host = backgroundBashHost(service, dataDir);
      const first = `${'a'.repeat(65_535)}中`;
      const expected = `${first}second\n`;
      const secondEmitted = deferred<void>();
      const releaseExecutor = deferred<void>();
      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { command: 'stream with transient persistence failure' },
        executor: {
          execute: async ({ onOutput, onPreflightComplete }) => {
            await onPreflightComplete?.();
            onOutput?.(first);
            await new Promise<void>((resolve) => setImmediate(resolve));
            onOutput?.('second\n');
            secondEmitted.resolve();
            await releaseExecutor.promise;
            return { text: expected };
          },
        },
      });

      await secondEmitted.promise;
      await expect
        .poll(async () => {
          const output = await service.readOutput(toolContext('session-a'), started.taskId!, {
            offset: 0,
            limitBytes: Buffer.byteLength(expected, 'utf8') + 1,
          });
          return output.content;
        })
        .toBe(expected);
      expect((await service.get(toolContext('session-a'), started.taskId!))?.status).toBe(
        'running',
      );
      releaseExecutor.resolve();
      await waitForTaskStatus(service, started.taskId!, 'succeeded');
      const output = await service.readOutput(toolContext('session-a'), started.taskId!, {
        offset: 0,
        limitBytes: Buffer.byteLength(expected, 'utf8') + 1,
      });
      expect(output.content).toBe(expected);

      const firstPage = await service.readOutput(toolContext('session-a'), started.taskId!, {
        offset: 0,
        limitBytes: 65_536,
      });
      const secondPage = await service.readOutput(toolContext('session-a'), started.taskId!, {
        offset: firstPage.nextOffset,
        limitBytes: 65_536,
      });
      expect(firstPage.content + secondPage.content).toBe(expected);
      expect(firstPage.content + secondPage.content).not.toContain('�');
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('bounds recovery after persistent output failure and records an omission marker', async () => {
    const firstAppendFailed = deferred<void>();
    const allowRecoveryRead = deferred<void>();
    const appendedPayloads: string[] = [];
    let persisted = '';
    let appendAttempts = 0;
    const host = {
      nowMs: () => 72_250,
      matrixLogger: { warn: () => undefined },
      backgroundTaskService: {
        appendOutput: async ({ content }: { content: string }) => {
          appendAttempts += 1;
          appendedPayloads.push(content);
          if (appendAttempts === 1) {
            firstAppendFailed.resolve();
            throw new Error('persistent output append failure');
          }
          persisted += content;
          return {
            taskId: 'bounded-recovery',
            kind: 'memory',
            uri: 'memory://bounded-recovery',
            offset: Buffer.byteLength(persisted, 'utf8'),
          };
        },
        readOutput: async (_taskId: string, options: { offset?: number }) => {
          await allowRecoveryRead.promise;
          const offset = options.offset ?? 0;
          const bytes = Buffer.from(persisted, 'utf8');
          const content = bytes.subarray(offset).toString('utf8');
          return {
            content,
            nextOffset: bytes.length,
            truncated: false,
            outputRef: {
              taskId: 'bounded-recovery',
              kind: 'memory',
              uri: 'memory://bounded-recovery',
              offset: bytes.length,
            },
          };
        },
      },
    } as unknown as LocalTaskRunnerHostWithSessionLookup;
    const writer = new BackgroundBashOutputWriter(host, 'session-a', 'bounded-recovery');

    writer.push('seed');
    await firstAppendFailed.promise;
    const recoveryState = writer as unknown as {
      persistenceIncomplete: boolean;
      recoveryContent: string;
      droppedRecoveryBytes: number;
    };
    await expect.poll(() => recoveryState.persistenceIncomplete).toBe(true);
    for (let index = 0; index < 8; index += 1) writer.push('x'.repeat(1024 * 1024));
    expect(recoveryState.recoveryContent.length).toBe(1024 * 1024);
    expect(recoveryState.droppedRecoveryBytes).toBe(7_340_036);
    allowRecoveryRead.resolve();
    const outputRef = await writer.settleSuccess({ text: '' });
    expect(writer.describePersistence(outputRef)).toMatchObject({ persistence: 'incomplete', omittedBytes: 7_340_036, rawBytes: 8 * 1024 * 1024 + 4 });

    expect(Math.max(...appendedPayloads.map((content) => content.length))).toBeLessThan(
      2 * 1024 * 1024,
    );
    expect(persisted).toContain('omitted 7340036 bytes');
    expect(persisted.length).toBeLessThan(2 * 1024 * 1024);
  });

  it('repairs the failure reason when its terminal append also fails transiently', async () => {
    let appendAttempts = 0;
    let persisted = '';
    const host = {
      nowMs: () => 72_375,
      matrixLogger: { warn: () => undefined },
      backgroundTaskService: {
        appendOutput: async ({ content }: { content: string }) => {
          appendAttempts += 1;
          if (appendAttempts === 1 || appendAttempts === 3) {
            throw new Error('transient output append failure');
          }
          persisted += content;
          return {
            taskId: 'terminal-recovery',
            kind: 'memory',
            uri: 'memory://terminal-recovery',
            offset: Buffer.byteLength(persisted, 'utf8'),
          };
        },
        readOutput: async (_taskId: string, options: { offset?: number }) => {
          const offset = options.offset ?? 0;
          const bytes = Buffer.from(persisted, 'utf8');
          return {
            content: bytes.subarray(offset).toString('utf8'),
            nextOffset: bytes.length,
            truncated: false,
            outputRef: {
              taskId: 'terminal-recovery',
              kind: 'memory',
              uri: 'memory://terminal-recovery',
              offset: bytes.length,
            },
          };
        },
      },
    } as unknown as LocalTaskRunnerHostWithSessionLookup;
    const writer = new BackgroundBashOutputWriter(host, 'session-a', 'terminal-recovery');
    const terminal = '\n<bash_status>Background bash failed: exit 7</bash_status>\n';

    writer.push('streamed suffix');
    await writer.settleFailure(terminal);

    expect(appendAttempts).toBe(4);
    expect(persisted).toBe(`streamed suffix${terminal}`);
  });

  it('repairs failed task output after a streamed append fails mid-command', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-failed-output-repair-'));
    try {
      const backingOutputStore = new FsLocalTaskOutputStore(dataDir);
      let appendCount = 0;
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 72_500),
        outputStore: {
          append: async (chunk) => {
            appendCount += 1;
            if (appendCount === 2) throw new Error('transient output append failure');
            return backingOutputStore.append(chunk);
          },
          read: (taskId, options) => backingOutputStore.read(taskId, options),
          tail: (taskId, limitBytes) => backingOutputStore.tail(taskId, limitBytes),
          finalize: (taskId, summary) => backingOutputStore.finalize(taskId, summary),
        },
        nowMs: () => 72_500,
      });
      const host = backgroundBashHost(service, dataDir);
      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { command: 'stream then fail' },
        executor: {
          execute: async ({ onOutput }) => {
            onOutput?.('first\n');
            await new Promise<void>((resolve) => setImmediate(resolve));
            onOutput?.('second\n');
            throw new Error('exit 7');
          },
        },
      });

      await waitForTaskStatus(service, started.taskId!, 'failed');
      const output = await service.readOutput(toolContext('session-a'), started.taskId!, {
        limitBytes: 64 * 1024,
      });
      expect(output.content).toContain('first\nsecond\n');
      expect(output.content).toContain('<bash_status>Background bash failed: exit 7</bash_status>');
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('coalesces bursty streamed output instead of queuing one persistence promise per chunk', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-output-burst-'));
    try {
      const backingOutputStore = new FsLocalTaskOutputStore(dataDir);
      let appendCount = 0;
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 73_000),
        outputStore: {
          append: async (chunk) => {
            appendCount += 1;
            await new Promise<void>((resolve) => setImmediate(resolve));
            return backingOutputStore.append(chunk);
          },
          read: (taskId, options) => backingOutputStore.read(taskId, options),
          tail: (taskId, limitBytes) => backingOutputStore.tail(taskId, limitBytes),
          finalize: (taskId, summary) => backingOutputStore.finalize(taskId, summary),
        },
        nowMs: () => 73_000,
      });
      const host = backgroundBashHost(service, dataDir);
      const chunks = Array.from({ length: 1_000 }, (_, index) => `${index}\n`);
      const expected = chunks.join('');
      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { command: 'emit burst' },
        executor: {
          execute: async ({ onOutput }) => {
            for (const chunk of chunks) onOutput?.(chunk);
            return { text: expected };
          },
        },
      });

      await waitForTaskStatus(service, started.taskId!, 'succeeded');
      const output = await service.readOutput(toolContext('session-a'), started.taskId!, {
        limitBytes: Buffer.byteLength(expected, 'utf8') + 1,
      });
      expect(output.content).toBe(expected);
      expect(appendCount).toBeLessThan(10);
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
