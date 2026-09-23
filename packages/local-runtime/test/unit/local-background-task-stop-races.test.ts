import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { LocalTaskStopTool } from '@mavis/agent-tools/desktop';

import { LocalBackgroundTaskService } from '../../src/background-task/service.js';
import {
  FsLocalTaskOutputStore,
  SqliteLocalBackgroundTaskStore,
} from '../../src/background-task/store.js';
import { closeLocalRuntimeDb } from '../../src/persistence/db.js';
import { taskRecord, taskStoreWithPatch, toolContext } from './background-task-test-helpers.js';

describe('local background task stop concurrency', () => {
  it.each(['running', 'succeeded', 'failed'] as const)(
    'reports stop failure without overwriting a concurrent %s outcome',
    async (outcome) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'local-background-stop-failure-'));
      try {
        const store = new SqliteLocalBackgroundTaskStore(dataDir);
        const service = new LocalBackgroundTaskService({
          store,
          outputStore: new FsLocalTaskOutputStore(dataDir),
          stopRuntime: async () => {
            if (outcome !== 'running')
              await service.patch('stop-failure', {
                status: outcome,
                endedAt: 10,
                lastError:
                  outcome === 'failed'
                    ? { code: 'BASH_FAILED', message: 'command failed' }
                    : undefined,
              });
            throw new Error('runtime cleanup failed');
          },
        });
        await store.create(
          taskRecord('stop-failure', 'session-a', { kind: 'bash', status: 'running' }),
        );
        const result = await new LocalTaskStopTool(service).execute(toolContext('session-a'), {
          task_id: 'stop-failure',
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('runtime cleanup failed');
        expect(result.text).toContain('Process cleanup could not be confirmed');
        expect(result.details).toMatchObject({
          status: outcome === 'running' ? 'canceled' : outcome,
          stopError: { code: 'TASK_STOP_FAILED', message: 'runtime cleanup failed' },
        });
        const persisted = await store.get('stop-failure');
        expect(persisted?.metadata?.stopError).toMatchObject({ code: 'TASK_STOP_FAILED' });
        if (outcome === 'failed')
          expect(persisted?.lastError).toEqual({ code: 'BASH_FAILED', message: 'command failed' });
        const repeated = await new LocalTaskStopTool(service).execute(toolContext('session-a'), {
          task_id: 'stop-failure',
        });
        expect(repeated.isError).toBe(true);
      } finally {
        closeLocalRuntimeDb(dataDir);
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it('coalesces concurrent task_stop calls into one runtime stop and one completion event', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'local-background-stop-race-'));
    try {
      const store = new SqliteLocalBackgroundTaskStore(dataDir, () => 70_000);
      const trackingStore = taskStoreWithPatch(store, async () => undefined);
      const appendEvent = trackingStore.appendEvent.bind(trackingStore);
      let completedEvents = 0;
      trackingStore.appendEvent = async (event) => {
        if (event.type === 'completed') completedEvents += 1;
        await appendEvent(event);
      };
      let stopCalls = 0;
      let reportStopEntered!: () => void;
      const stopEntered = new Promise<void>((resolve) => {
        reportStopEntered = resolve;
      });
      let releaseStop!: () => void;
      const stopGate = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      const service = new LocalBackgroundTaskService({
        store: trackingStore,
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs: () => 70_000,
        stopRuntime: async () => {
          stopCalls += 1;
          reportStopEntered();
          await stopGate;
        },
      });
      await store.create(taskRecord('running-task', 'session-a', { status: 'running' }));

      const first = service.stop('running-task', 'reason-a');
      await stopEntered;
      const second = service.stop('running-task', 'reason-b');
      await Promise.resolve();
      expect(stopCalls).toBe(1);

      releaseStop();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toMatchObject({
        status: 'canceled',
        lastError: { code: 'TASK_CANCELED', message: 'reason-a' },
      });
      expect(secondResult).toEqual(firstResult);
      expect(stopCalls).toBe(1);
      expect(completedEvents).toBe(1);
    } finally {
      closeLocalRuntimeDb(dataDir);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
