import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent/tools';
import { LocalBashTool, LocalTaskOutputTool, LocalTaskQueryTool } from '@mavis/agent-tools/desktop';

import {
  DEFAULT_BACKGROUND_BASH_MAX_RUN_MS,
  MAX_BACKGROUND_BASH_MAX_RUN_MS,
  buildLocalBashAdapter,
  resolveBackgroundBashMaxRunMs,
  runManagedForegroundLocalBash,
  startBackgroundLocalBash,
  stopBackgroundLocalBashTask,
  type LocalBackgroundBashExecutor,
} from '../../src/background-task/bash-runner.js';
import { createLocalBackgroundBashExecutor } from '../../../local-runtime-v2/src/service/background-bash/executor.js';
import { LocalBackgroundTaskService } from '../../src/background-task/service.js';
import {
  FsLocalTaskOutputStore,
  SqliteLocalBackgroundTaskStore,
} from '../../src/background-task/store.js';
import { closeLocalRuntimeDb } from '../../src/persistence/db.js';
import { logger } from '../../src/common/logger.js';
import {
  backgroundBashHost,
  parentSessionRecord,
  taskRecord,
  taskStoreWithPatch,
  toolContext,
  waitForTaskOutput,
  waitForTaskStatus,
} from './background-task-test-helpers.js';

const MOVED_LOCAL_BACKGROUND_BASH_EXECUTOR = createLocalBackgroundBashExecutor(
  {
    create: (input) =>
      createLocalBashOperations({
        parentDeathGuard: input.identity.operationClass !== 'direct_foreground',
      }),
  },
  { mode: 'off' },
);

describe('local background bash runner', () => {
  it.skipIf(process.platform === 'win32').each([
    {
      description: '运行测试命令',
      command: "printf 'partial-output'; exit 0",
      status: 'succeeded',
      reason: 'exited',
      exitCode: 0,
    },
    { description: '运行测试命令', command: "printf 'partial-output'; exit 7", status: 'failed', reason: 'exited', exitCode: 7 },
    {
      description: '运行测试命令',
      command: "printf 'partial-output'; kill -TERM $$",
      status: 'failed',
      reason: 'signaled',
      exitCode: null,
      signal: 'SIGTERM',
    },
    {
      description: '运行测试命令',
      command: "printf 'partial-output'; sleep 2",
      timeout: 0.1,
      status: 'failed',
      reason: 'command_timeout',
      exitCode: null,
    },
  ] as const)(
    'preserves the same execution facts across all Bash modes: $reason / $exitCode',
    async (scenario) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'local-bash-result-contract-'));
      try {
        const service = new LocalBackgroundTaskService({
          store: new SqliteLocalBackgroundTaskStore(dataDir),
          outputStore: new FsLocalTaskOutputStore(dataDir),
        });
        const host = backgroundBashHost(service, dataDir);
        const ctx = { ...toolContext('session-a'), canConsumeBackgroundBashOutput: true };
        const args = {
          description: '运行测试命令',
          command: scenario.command,
          timeout: 'timeout' in scenario ? scenario.timeout : 3,
        };
        const direct = await new LocalBashTool(dataDir, undefined, { mode: 'off' }).execute(
          ctx,
          args,
        );
        const managed = await new LocalBashTool(
          dataDir,
          buildLocalBashAdapter(host, parentSessionRecord(dataDir), MOVED_LOCAL_BACKGROUND_BASH_EXECUTOR),
          { mode: 'off' },
        ).execute(ctx, args);
        const started = await startBackgroundLocalBash({
          host,
          parentSession: parentSessionRecord(dataDir),
          toolCtx: ctx,
          bashInput: { ...args, run_in_background: true },
          executor: MOVED_LOCAL_BACKGROUND_BASH_EXECUTOR,
        });
        const task = await waitForTaskStatus(service, started.taskId!, scenario.status);
        const expected = {
          status: scenario.status,
          reason: scenario.reason,
          exitCode: scenario.exitCode,
          ...('signal' in scenario ? { signal: scenario.signal } : {}),
        };
        expect(direct.details).toMatchObject({ execution: expected, timing: { commandTimeoutSeconds: args.timeout, commandTimerStartedAt: expect.any(Number), commandDeadlineAt: expect.any(Number) } });
        expect(managed.details).toMatchObject({ status: scenario.status, execution: expected });
        expect(task.metadata?.bashDetails).toMatchObject({ execution: expected });
        expect(direct.isError === true).toBe(scenario.status === 'failed');
        expect(managed.isError === true).toBe(scenario.status === 'failed');
        expect(direct.text).toContain('partial-output');
        expect(managed.text).toBe(direct.text);
        expect(managed.details?.processOutput).toMatchObject({ stdout: 'partial-output', stderr: '' });
        const output = await new LocalTaskOutputTool(service).execute(ctx, {
          task_id: task.taskId,
        });
        expect(output.details).toMatchObject({ execution: expected });
        expect(output.isError).not.toBe(true);
        expect(output.text).toContain('partial-output');
        const query = await new LocalTaskQueryTool(service).execute(ctx, { task_id: task.taskId });
        expect(query.details).toMatchObject({ task: { execution: expected } });
        if (scenario.status === 'failed') expect(task.lastError?.message).toBeTruthy();
      } finally {
        closeLocalRuntimeDb(dataDir);
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it.each(['visible', 'hidden'] as const)(
    'enables both background paths for %s task children',
    (visibility) => {
      const adapter = buildLocalBashAdapter({} as Parameters<typeof buildLocalBashAdapter>[0], {
        ...parentSessionRecord('/tmp/workspace'),
        sessionType: 'branch',
        sessionKind: 'task',
        parentSessionId: 'parent',
        visibility,
      });
      expect(adapter.startBackground).toBeTypeOf('function');
      expect(adapter.runManagedForeground).toBeTypeOf('function');
    },
  );

  it('keeps managed foreground soft-yield enabled for ordinary sessions', () => {
    const adapter = buildLocalBashAdapter(
      {} as Parameters<typeof buildLocalBashAdapter>[0],
      parentSessionRecord('/tmp/workspace'),
    );

    expect(adapter.runManagedForeground).toBeTypeOf('function');
  });

  it('reaches succeeded even when output persistence and finalization fail', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-output-failure-'));
    try {
      const store = new SqliteLocalBackgroundTaskStore(dataDir, () => 29_000);
      const backingOutputStore = new FsLocalTaskOutputStore(dataDir);
      const service = new LocalBackgroundTaskService({
        store,
        outputStore: {
          append: async () => {
            throw new Error('output append unavailable');
          },
          read: (taskId, options) => backingOutputStore.read(taskId, options),
          tail: (taskId, limitBytes) => backingOutputStore.tail(taskId, limitBytes),
          finalize: async () => {
            throw new Error('output finalize unavailable');
          },
        },
        nowMs: () => 29_000,
      });
      const host = backgroundBashHost(service, dataDir);
      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'echo durable-status', run_in_background: true },
        executor: { execute: async () => ({ text: 'durable-status\n' }) },
      });

      const task = await waitForTaskStatus(service, started.taskId!, 'succeeded');
      expect(task.outputRef).toBeUndefined();
      expect(task.metadata?.bashDetails).toMatchObject({ output: { persistence: 'incomplete' } });
      expect(task.metadata?.bashDetails).not.toHaveProperty('fullOutputPath');
      expect(task.lastError).toBeUndefined();
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reaches failed even when the failure output cannot be persisted', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-failure-output-'));
    try {
      const store = new SqliteLocalBackgroundTaskStore(dataDir, () => 29_250);
      const backingOutputStore = new FsLocalTaskOutputStore(dataDir);
      const service = new LocalBackgroundTaskService({
        store,
        outputStore: {
          append: async () => {
            throw new Error('output append unavailable');
          },
          read: (taskId, options) => backingOutputStore.read(taskId, options),
          tail: (taskId, limitBytes) => backingOutputStore.tail(taskId, limitBytes),
          finalize: (taskId, summary) => backingOutputStore.finalize(taskId, summary),
        },
        nowMs: () => 29_250,
      });
      const host = backgroundBashHost(service, dataDir);
      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'exit 7', run_in_background: true },
        executor: {
          execute: async () => {
            throw new Error('exit 7');
          },
        },
      });

      const task = await waitForTaskStatus(service, started.taskId!, 'failed');
      expect(task.outputRef).toBeUndefined();
      expect(task.metadata?.bashDetails).toMatchObject({ output: { persistence: 'incomplete' } });
      expect(task.metadata?.bashDetails).not.toHaveProperty('fullOutputPath');
      expect(task.lastError?.code).toBe('BASH_FAILED');
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('still stops the runtime when the stop_requested event cannot be persisted', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-stop-event-failure-'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    try {
      const store = new SqliteLocalBackgroundTaskStore(dataDir, () => 29_500);
      const trackingStore = taskStoreWithPatch(store, async () => undefined);
      const appendEvent = trackingStore.appendEvent.bind(trackingStore);
      trackingStore.appendEvent = async (event) => {
        if (event.type === 'stop_requested') throw new Error('event store unavailable');
        await appendEvent(event);
      };
      let stopped = false;
      const service = new LocalBackgroundTaskService({
        store: trackingStore,
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 29_500,
        stopRuntime: async () => {
          stopped = true;
        },
      });
      await store.create(taskRecord('running-task', 'session-a', { status: 'running' }));

      await expect(service.stop('running-task', 'user stopped')).resolves.toMatchObject({
        status: 'canceled',
      });
      expect(stopped).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ lifecycleType: 'stop_requested' }),
        'Failed to persist background task lifecycle event',
      );
    } finally {
      warn.mockRestore();
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('streams output while the task is still running without duplicating the final snapshot', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-stream-'));
    try {
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 30_000),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 30_000,
      });
      const host = backgroundBashHost(service, dataDir);
      let finish!: () => void;
      const executor: LocalBackgroundBashExecutor = {
        execute: async ({ onOutput, onPreflightComplete }) => {
          await onPreflightComplete?.();
          onOutput?.('first\n');
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          onOutput?.('second\n');
          return { text: 'first\nsecond\n' };
        },
      };

      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'stream', run_in_background: true },
        executor,
      });

      await expect(waitForTaskOutput(service, started.taskId!, 'first')).resolves.toContain('first');
      expect((await service.get(toolContext('session-a'), started.taskId!))?.status).toBe('running');
      finish();
      await waitForTaskStatus(service, started.taskId!, 'succeeded');
      const output = await service.readOutput(toolContext('session-a'), started.taskId!, { offset: 0 });
      expect(output.content).toBe('first\nsecond\n');
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns a fast managed command inline and suppresses its completion wake-up', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-managed-bash-fast-'));
    try {
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 32_000),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 32_000,
      });
      const host = backgroundBashHost(service, dataDir);
      let managedIdentity: Parameters<LocalBackgroundBashExecutor['execute']>[0]['identity'];
      const result = await runManagedForegroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: { ...toolContext('session-a'), forceReadOnlyFilesystem: true },
        bashInput: { description: '运行测试命令', command: 'echo fast', timeout: 120 },
        softYieldMs: 50,
        executor: {
          execute: async ({ identity, onPreflightComplete }) => {
            managedIdentity = identity;
            await onPreflightComplete?.();
            return { text: 'fast\n' };
          },
        },
      });

      expect(result).toMatchObject({ status: 'completed', text: 'fast\n' });
      expect(managedIdentity!).toEqual({
        operationClass: 'managed_foreground',
        invocationId: result.taskId,
        sessionId: 'session-a',
        turnId: 'turn-session-a',
        toolCallId: 'call-session-a',
        taskId: result.taskId,
        forceReadOnlyFilesystem: true,
      });
      const task = await service.get(toolContext('session-a'), result.taskId!);
      expect(task).toMatchObject({ status: 'succeeded', deliveredAt: 32_000 });
      expect(task?.metadata).toMatchObject({ completionOrigin: 'foreground' });
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    { timeout: undefined, effectiveTimeout: 600 },
    { timeout: 45, effectiveTimeout: 45 },
    { timeout: 600, effectiveTimeout: 600 },
    { timeout: 900, effectiveTimeout: 600 },
  ])('soft-yields with total command timeout $effectiveTimeout for requested $timeout', async ({ timeout, effectiveTimeout }) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-managed-bash-slow-'));
    try {
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 33_000),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 33_000,
      });
      const host = backgroundBashHost(service, dataDir);
      let finish!: () => void;
      let dispatchedTimeout: number | undefined;
      const result = await runManagedForegroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'slow', timeout },
        softYieldMs: 10,
        executor: {
          execute: async ({ onPreflightComplete, timeout: commandTimeout }) => {
            dispatchedTimeout = commandTimeout;
            await onPreflightComplete?.();
            return new Promise((resolve) => {
              finish = () => resolve({ text: 'done\n' });
            });
          },
        },
      });

      expect(result).toMatchObject({ status: 'auto_promoted', details: { description: '运行测试命令' } });
      expect(dispatchedTimeout).toBe(effectiveTimeout);
      expect(result.details).toMatchObject({ timing: { commandTimeoutSeconds: effectiveTimeout } });
      expect((await service.get(result.taskId!))?.description).toBe('运行测试命令');
      expect((await service.get(toolContext('session-a'), result.taskId!))?.status).toBe('running');
      finish();
      await waitForTaskStatus(service, result.taskId!, 'succeeded');
      expect((await service.get(toolContext('session-a'), result.taskId!))?.metadata).toMatchObject({
        executionMode: 'auto_promoted',
        bashDetails: { timing: { commandTimeoutSeconds: effectiveTimeout } },
      });
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns spawn-time env sanitization details on an auto-promoted command', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-managed-bash-env-hint-'));
    process.env.MAVIS_ACCESS_TOKEN = 'must-not-reach-child';
    try {
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 33_500),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 33_500,
      });
      const host = backgroundBashHost(service, dataDir);
      const result = await runManagedForegroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'sleep 0.1; echo done', timeout: 120 },
        softYieldMs: 10,
        executor: MOVED_LOCAL_BACKGROUND_BASH_EXECUTOR,
      });

      expect(result).toMatchObject({
        status: 'auto_promoted',
        details: { envSanitized: expect.arrayContaining(['MAVIS_ACCESS_TOKEN']) },
      });
      await waitForTaskStatus(service, result.taskId!, 'succeeded');
    } finally {
      delete process.env.MAVIS_ACCESS_TOKEN;
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('runs local bash in the background and stores final output', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-'));
    try {
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 31_000),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 31_000,
      });
      const host = backgroundBashHost(service, dataDir);
      let explicitIdentity: Parameters<LocalBackgroundBashExecutor['execute']>[0]['identity'];
      const executor: LocalBackgroundBashExecutor = {
        execute: async ({ command, identity, onPreflightComplete }) => {
          explicitIdentity = identity;
          await onPreflightComplete?.();
          return { text: `ran:${command}` };
        },
      };

      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: { ...toolContext('session-a'), forceReadOnlyFilesystem: true },
        bashInput: { description: '运行测试命令', command: 'echo ok', run_in_background: true },
        executor,
      });

      expect(started.status).toBe('started');
      const task = await waitForTaskStatus(service, started.taskId!, 'succeeded');
      expect(task).toMatchObject({ kind: 'bash', description: '运行测试命令' });
      expect(explicitIdentity!).toEqual({
        operationClass: 'explicit_background',
        invocationId: started.taskId,
        sessionId: 'session-a',
        turnId: 'turn-session-a',
        toolCallId: 'call-session-a',
        taskId: started.taskId,
        forceReadOnlyFilesystem: true,
      });
      await expect(service.readOutput(toolContext('session-a'), started.taskId!)).resolves.toMatchObject({
        content: 'ran:echo ok',
      });
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('aborts a running background bash task through the shared task stop path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-stop-'));
    try {
      const store = new SqliteLocalBackgroundTaskStore(dataDir, () => 41_000);
      const service = new LocalBackgroundTaskService({
        store,
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 41_000,
        stopRuntime: stopBackgroundLocalBashTask,
      });
      const host = backgroundBashHost(service, dataDir);
      let aborted = false;
      const executor: LocalBackgroundBashExecutor = {
        execute: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
      };

      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'sleep 100', run_in_background: true },
        executor,
      });

      await service.stop(toolContext('session-a'), started.taskId!, 'user stopped');
      const task = await waitForTaskStatus(service, started.taskId!, 'canceled');
      expect(aborted).toBe(true);
      expect(task).toMatchObject({ kind: 'bash', status: 'canceled' });
      await expect(
        waitForTaskOutput(service, started.taskId!, 'Background bash canceled'),
      ).resolves.toContain('Background bash canceled');
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps task_stop in stopping until runner cleanup and final output settle', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-stop-settle-'));
    try {
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 42_000),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 42_000,
        stopRuntime: stopBackgroundLocalBashTask,
      });
      const host = backgroundBashHost(service, dataDir);
      let releaseCleanup!: () => void;
      const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      const executor: LocalBackgroundBashExecutor = {
        execute: ({ signal, onOutput }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              void cleanupGate.then(() => {
                onOutput?.('cleanup-finished\n');
                reject(new Error('aborted after cleanup'));
              });
            });
          }),
      };

      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'deferred-cleanup', run_in_background: true },
        executor,
      });

      let stopSettled = false;
      const stopping = service
        .stop(toolContext('session-a'), started.taskId!, 'user stopped')
        .then((task) => {
          stopSettled = true;
          return task;
        });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stopSettled).toBe(false);
      expect((await service.get(toolContext('session-a'), started.taskId!))?.status).toBe(
        'stopping',
      );

      releaseCleanup();
      await expect(stopping).resolves.toMatchObject({ status: 'canceled' });
      await expect(service.readOutput(toolContext('session-a'), started.taskId!)).resolves.toMatchObject({
        status: 'canceled',
        content: expect.stringContaining('cleanup-finished'),
      });
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps a user stop canceled when cleanup outlives the maxRun watchdog', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-stop-watchdog-'));
    try {
      const store = new SqliteLocalBackgroundTaskStore(dataDir, () => 43_000);
      const completedEvents: string[] = [];
      const trackingStore = taskStoreWithPatch(store, async () => undefined);
      const appendEvent = trackingStore.appendEvent.bind(trackingStore);
      trackingStore.appendEvent = async (event) => {
        if (event.type === 'completed') completedEvents.push(event.type);
        await appendEvent(event);
      };
      const service = new LocalBackgroundTaskService({
        store: trackingStore,
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 43_000,
        stopRuntime: stopBackgroundLocalBashTask,
      });
      const host = backgroundBashHost(service, dataDir);
      let releaseCleanup!: () => void;
      const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      const executor: LocalBackgroundBashExecutor = {
        execute: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              void cleanupGate.then(() => reject(new Error('stopped after cleanup')));
            });
          }),
      };

      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'slow-cleanup', run_in_background: true },
        executor,
        maxRunMs: 20,
      });
      const stopping = service.stop(toolContext('session-a'), started.taskId!, 'user stopped');
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseCleanup();

      await expect(stopping).resolves.toMatchObject({
        status: 'canceled',
        lastError: { code: 'BASH_CANCELED' },
      });
      expect(completedEvents).toEqual(['completed']);
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('clears a stop-request marker when the command wins the race and succeeds', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-stop-success-'));
    try {
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 44_000),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 44_000,
        stopRuntime: stopBackgroundLocalBashTask,
      });
      const host = backgroundBashHost(service, dataDir);
      const executor: LocalBackgroundBashExecutor = {
        execute: ({ signal }) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ text: 'finished anyway' }));
          }),
      };

      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'finish-on-stop', run_in_background: true },
        executor,
      });
      const stopped = await service.stop(
        toolContext('session-a'),
        started.taskId!,
        'user stopped',
      );

      expect(stopped).toMatchObject({ status: 'succeeded' });
      expect(stopped?.lastError).toBeUndefined();
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  // L7 regression: task_stop must let the bash `trap ... TERM` cleanup run
  // before the process dies. The runner aborts the controller, pi delivers
  // SIGTERM to the process group first (was: immediate uncatchable SIGKILL), so
  // the trap fires and its output reaches the task before the graceful exit.
  // Real child process + real pi bash tool; Unix signal semantics only.
  it.skipIf(process.platform === 'win32')(
    'L7: task_stop lets the bash TERM trap run cleanup (SIGTERM→grace, not immediate SIGKILL)',
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-trap-'));
      try {
        const service = new LocalBackgroundTaskService({
          store: new SqliteLocalBackgroundTaskStore(dataDir, () => 61_000),
          outputStore: new FsLocalTaskOutputStore(dataDir),
          nowMs: () => 61_000,
          stopRuntime: stopBackgroundLocalBashTask,
        });
        const host = backgroundBashHost(service, dataDir);
        const command =
          "trap 'echo CLEANUP-RAN; exit 0' TERM INT; echo started; while true; do sleep 0.2; done";

        const started = await startBackgroundLocalBash({
          host,
          parentSession: parentSessionRecord(dataDir),
          toolCtx: toolContext('session-a'),
          bashInput: { description: '运行测试命令', command, run_in_background: true },
          executor: MOVED_LOCAL_BACKGROUND_BASH_EXECUTOR,
        });

        // Incremental output is persisted while the process runs, so wait for
        // the shell's first line before stopping and exercising its TERM trap.
        await waitForTaskOutput(service, started.taskId!, 'started');
        await service.stop(toolContext('session-a'), started.taskId!, 'user stopped');

        const output = await waitForTaskOutput(service, started.taskId!, 'CLEANUP-RAN');
        expect(output).toContain('CLEANUP-RAN');
        const task = await waitForTaskStatus(service, started.taskId!, 'canceled');
        expect(task).toMatchObject({ kind: 'bash', status: 'canceled' });
        expect(task.metadata?.bashDetails).toMatchObject({
          execution: {
            status: 'canceled', reason: 'canceled', exitCode: 0, cancellationReason: 'user stopped',
          },
          processOutput: { interrupted: true, stdout: expect.stringContaining('CLEANUP-RAN') },
        });
        const reported = await new LocalTaskOutputTool(service).execute(toolContext('session-a'), {
          task_id: started.taskId!,
        });
        expect(reported.isError).not.toBe(true);
        expect(reported.details).toMatchObject({ execution: { status: 'canceled', reason: 'canceled' } });
      } finally {
        closeLocalRuntimeDb(dataDir);
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it('BG-U01: kills a runaway background bash at maxRunMs → failed + TIMEOUT (not canceled)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-maxrun-'));
    try {
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 51_000),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 51_000,
        stopRuntime: stopBackgroundLocalBashTask,
      });
      const host = backgroundBashHost(service, dataDir);
      let aborted = false;
      // Executor hangs until the watchdog aborts it — mimics a stuck command.
      const executor: LocalBackgroundBashExecutor = {
        execute: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
      };

      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'sleep 100000', run_in_background: true },
        executor,
        maxRunMs: 50,
      });

      const task = await waitForTaskStatus(service, started.taskId!, 'failed');
      expect(aborted).toBe(true);
      expect(task.status).toBe('failed');
      expect(task.lastError?.code).toBe('TIMEOUT');
      expect(task.lastError?.message).toContain('maxRunMs');
      expect(task.metadata?.bashDetails).toMatchObject({
        execution: { status: 'failed', reason: 'watchdog_timeout', errorCode: 'TIMEOUT' },
      });
      await expect(
        waitForTaskOutput(service, started.taskId!, 'timed out'),
      ).resolves.toContain('timed out');
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('BG-U03: watchdog is cleared when the command finishes in time (no late false timeout)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-maxrun-clear-'));
    try {
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 52_000),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 52_000,
      });
      const host = backgroundBashHost(service, dataDir);
      const executor: LocalBackgroundBashExecutor = {
        execute: async ({ command }) => ({ text: `ran:${command}` }),
      };

      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'echo quick', run_in_background: true },
        executor,
        maxRunMs: 40,
      });

      const task = await waitForTaskStatus(service, started.taskId!, 'succeeded');
      expect(task.status).toBe('succeeded');
      // Give any un-cleared watchdog a chance to (wrongly) fire, then re-read.
      await new Promise((resolve) => setTimeout(resolve, 80));
      const after = await service.get(toolContext('session-a'), started.taskId!);
      expect(after?.status).toBe('succeeded');
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('BG-U08: user stop still yields canceled (not TIMEOUT) even with a maxRunMs set', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-stop-vs-maxrun-'));
    try {
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 53_000),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 53_000,
        stopRuntime: stopBackgroundLocalBashTask,
      });
      const host = backgroundBashHost(service, dataDir);
      const executor: LocalBackgroundBashExecutor = {
        execute: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      };

      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'sleep 100000', run_in_background: true },
        executor,
        maxRunMs: 60_000,
      });

      await service.stop(toolContext('session-a'), started.taskId!, 'user stopped');
      const task = await waitForTaskStatus(service, started.taskId!, 'canceled');
      expect(task.status).toBe('canceled');
      expect(task.lastError?.code).not.toBe('TIMEOUT');
      // Wait for the runner's async output append to settle before cleanup so
      // the SQLite dir is quiescent (avoids an ENOTEMPTY rmdir race).
      await waitForTaskOutput(service, started.taskId!, 'Background bash canceled');
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('BG-U07: a fast executor failure is BASH_FAILED, not a TIMEOUT (watchdog stays clear)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-bash-fail-'));
    try {
      const service = new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, () => 54_000),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 54_000,
      });
      const host = backgroundBashHost(service, dataDir);
      const executor: LocalBackgroundBashExecutor = {
        execute: async () => {
          throw new Error('boom');
        },
      };

      const started = await startBackgroundLocalBash({
        host,
        parentSession: parentSessionRecord(dataDir),
        toolCtx: toolContext('session-a'),
        bashInput: { description: '运行测试命令', command: 'false', run_in_background: true },
        executor,
        maxRunMs: 60_000,
      });

      const task = await waitForTaskStatus(service, started.taskId!, 'failed');
      expect(task.lastError?.code).toBe('BASH_FAILED');
      expect(task.lastError?.code).not.toBe('TIMEOUT');
      // Give a (wrongly-armed) watchdog time to misfire, then confirm no flip.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const after = await service.get(toolContext('session-a'), started.taskId!);
      expect(after?.status).toBe('failed');
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('resolveBackgroundBashMaxRunMs', () => {
  it('defaults to the 30-min ceiling when no timeout is given', () => {
    expect(resolveBackgroundBashMaxRunMs(undefined)).toBe(DEFAULT_BACKGROUND_BASH_MAX_RUN_MS);
    expect(DEFAULT_BACKGROUND_BASH_MAX_RUN_MS).toBe(30 * 60 * 1000);
  });

  it('never undercuts an explicit longer timeout (raises the ceiling to match)', () => {
    // 60-min explicit timeout must not be killed by the 30-min default.
    expect(resolveBackgroundBashMaxRunMs(60 * 60)).toBe(60 * 60 * 1000);
  });

  it('keeps the default ceiling when the explicit timeout is shorter', () => {
    expect(resolveBackgroundBashMaxRunMs(60)).toBe(DEFAULT_BACKGROUND_BASH_MAX_RUN_MS);
  });

  it('treats 0 / negative timeout as "no explicit value" → default ceiling', () => {
    expect(resolveBackgroundBashMaxRunMs(0)).toBe(DEFAULT_BACKGROUND_BASH_MAX_RUN_MS);
    expect(resolveBackgroundBashMaxRunMs(-5)).toBe(DEFAULT_BACKGROUND_BASH_MAX_RUN_MS);
  });

  it('caps explicit timeouts at the maximum delay supported by Node timers', () => {
    expect(resolveBackgroundBashMaxRunMs(2_147_484)).toBe(MAX_BACKGROUND_BASH_MAX_RUN_MS);
    expect(MAX_BACKGROUND_BASH_MAX_RUN_MS).toBe(2_147_483_647);
  });
});

describe('reconcileStartupLostTasks — idempotence (learned from kimi reconcile.test)', () => {
  it('a second reconcile pass is a no-op: no re-transition, no duplicate completion events', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-reconcile-idem-'));
    try {
      const store = new SqliteLocalBackgroundTaskStore(dataDir, () => 61_000);
      const events: string[] = [];
      const trackingStore = taskStoreWithPatch(store, async () => undefined);
      // Wrap appendEvent to count completion emissions for the orphan.
      const originalAppend = trackingStore.appendEvent.bind(trackingStore);
      trackingStore.appendEvent = async (event) => {
        if (event.taskId === 'orphan' && event.type === 'completed') events.push(event.type);
        return originalAppend(event);
      };
      const service = new LocalBackgroundTaskService({
        store: trackingStore,
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 62_000,
      });
      await store.create(taskRecord('orphan', 'session-a', { status: 'running', createdAt: 1_000 }));

      const first = await service.reconcileStartupLostTasks({ reason: 'restarted' });
      expect(first.map((t) => t.taskId)).toEqual(['orphan']);
      expect(first[0]!.status).toBe('lost');

      const second = await service.reconcileStartupLostTasks({ reason: 'restarted' });
      expect(second).toEqual([]); // already terminal → not re-collected
      expect(events).toEqual(['completed']); // exactly one completion event
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
