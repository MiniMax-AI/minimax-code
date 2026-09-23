import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBashTool } from '@mavis/agent-tools/desktop';
import { createLocalBashOperations } from '@earendil-works/pi-coding-agent/tools';
import { getShellConfig } from '@earendil-works/pi-coding-agent/shell';
import { createChildBashLifecycle } from '../../src/background-task/child-bash-lifecycle.js';
import { LocalBackgroundTaskService } from '../../src/background-task/service.js';
import {
  FsLocalTaskOutputStore,
  SqliteLocalBackgroundTaskStore,
} from '../../src/background-task/store.js';
import {
  buildLocalBashAdapter,
  abortBackgroundLocalBashTasksForHost,
  stopBackgroundLocalBashTask,
} from '../../src/background-task/bash-runner.js';
import { closeLocalBackgroundTaskDelivery } from '../../src/background-task/delivery.js';
import { createLocalBackgroundBashExecutor } from '../../../local-runtime-v2/src/service/background-bash/executor.js';
import { closeLocalRuntimeDb } from '../../src/persistence/db.js';
import {
  backgroundBashHost,
  parentSessionRecord,
  taskRecord,
  toolContext,
} from './background-task-test-helpers.js';

function nodeCommand(script: string): string {
  const shell = getShellConfig().type;
  const powershell = shell === 'pwsh' || shell === 'powershell';
  const quote = (value: string) => powershell
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
  return `${powershell ? '& ' : ''}${quote(process.execPath)} -e ${quote(script)}`;
}

const directories: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];
// Windows CI has exceeded the 10s teardown budget for these SQLite/output fixtures.
// Keep the execution deadlines below separate from this bounded teardown budget.
afterEach(async () => {
  // A terminal task can still be finalizing output or scheduling delivery.
  // Drain that work before closing SQLite, otherwise it can reopen the file
  // while Windows is trying to remove the fixture directory.
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  for (const path of directories.splice(0)) {
    closeLocalRuntimeDb(path);
    await rm(path, { recursive: true, force: true });
  }
}, process.platform === 'win32' ? 30_000 : 10_000);
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'child-bash-lifecycle-'));
  directories.push(dataDir);
  const service = new LocalBackgroundTaskService({
    store: new SqliteLocalBackgroundTaskStore(dataDir),
    outputStore: new FsLocalTaskOutputStore(dataDir),
    stopRuntime: (task, reason) => stopBackgroundLocalBashTask(task, reason),
  });
  const host = backgroundBashHost(service, dataDir);
  shutdowns.push(async () => {
    closeLocalBackgroundTaskDelivery(host);
    await abortBackgroundLocalBashTasksForHost(host, 'Test fixture shutdown');
  });
  const controller = new AbortController();
  const lifecycle = createChildBashLifecycle(service, {
    sessionId: 'child',
    turnId: 'turn-child',
    signal: controller.signal,
  });
  const create = (id: string, overrides: Parameters<typeof taskRecord>[2] = {}) =>
    service.create(
      taskRecord(id, 'child', {
        kind: 'bash',
        status: 'running',
        metadata: { parentTurnId: 'turn-child' },
        ...overrides,
      }),
    );
  return { dataDir, service, host, controller, lifecycle, create };
}
const poll = { wait: false, readTaskIds: new Set<string>() };

// Force Windows PowerShell 5.1 even when pwsh 7 is installed on the host.
// These are real shell checks, not a simulation of PowerShell exit semantics.
describe.skipIf(process.platform !== 'win32')('Windows PowerShell 5.1 exit codes', () => {
  const shellPath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const native = (code: number) => `& ${quote(process.execPath)} -e ${quote(`console.error('native-evidence');process.exit(${code})`)}`;

  describe.each([false, true])('parentDeathGuard=%s', (parentDeathGuard) => {
    it.each([
      ['native failure', native(7), 7, 'native-evidence'],
      ['native failure followed by PowerShell output', `${native(7)}; Write-Output 'tail'`, 7, 'tail'],
      ['native success', native(0), 0, 'native-evidence'],
      ['last native command succeeds', `${native(7)}; ${native(0)}`, 0, 'native-evidence'],
      ['pure PowerShell success', "Write-Output 'success-evidence'", 0, 'success-evidence'],
      ['terminating PowerShell error', "throw 'ps-error'", 1, 'ps-error'],
      ['explicit exit', 'exit 9', 9, ''],
    ] as const)('%s', async (_name, command, exitCode, evidence) => {
      let output = '';
      const result = await createLocalBashOperations({ shellPath, parentDeathGuard }).exec(command, tmpdir(), {
        onData: (chunk) => { output += chunk.toString(); },
        timeout: 10,
      });
      expect(output).toContain(evidence);
      expect(result.exitCode).toBe(exitCode);
    }, 15_000);
  });
});

describe('child Bash lifecycle', () => {
  it.each(['succeeded', 'failed', 'canceled', 'lost'] as const)(
    'notifies %s exactly once without acknowledging consumption',
    async (status) => {
      const { create, lifecycle, service } = await fixture();
      await create('bash', { status });
      expect(await lifecycle.poll(poll)).toContain(`status="${status}"`);
      expect(await lifecycle.poll(poll)).toBeUndefined();
      expect((await service.get('bash'))?.deliveredAt).toBeUndefined();
    },
  );
  it('waits at exit, wakes on terminal state, and does not wait mid-turn', async () => {
    const { create, lifecycle, service } = await fixture();
    expect(await lifecycle.hasPending()).toBe(false);
    await create('bash');
    expect(await lifecycle.hasPending()).toBe(true);
    expect(await lifecycle.poll(poll)).toBeUndefined();
    const complete = vi.fn();
    const waiting = vi.spyOn(service, 'waitForTaskChange');
    const pending = lifecycle.poll({ ...poll, wait: true }).then(complete);
    await vi.waitFor(() => expect(waiting).toHaveBeenCalled());
    expect(complete).not.toHaveBeenCalled();
    await service.patch('bash', { status: 'succeeded' });
    await pending;
    expect(complete).toHaveBeenCalledWith(expect.stringContaining('task_id="bash"'));
  });
  it('isolates session and turn, ignores synchronous/consumed results, and pages all tasks', async () => {
    const { create, lifecycle, service } = await fixture();
    await create('other-session', { ownerSessionId: 'other' });
    await create('old-turn', { metadata: { parentTurnId: 'old-turn' } });
    await create('read', { status: 'succeeded' });
    await create('delivered', { status: 'succeeded', deliveredAt: 1 });
    for (let i = 0; i < 105; i++) await create(`done-${i}`, { status: 'succeeded' });
    const notice = await lifecycle.poll({ wait: true, readTaskIds: new Set(['read']) });
    expect(notice?.match(/<task /g)).toHaveLength(105);
    expect(notice).not.toContain('task_id="read"');
    await lifecycle.close();
    expect((await service.get('other-session'))?.status).toBe('running');
    expect((await service.get('old-turn'))?.status).toBe('running');
  });
  it('cancels a waiting child and stops only its unfinished Bash', async () => {
    const { create, lifecycle, service, controller } = await fixture();
    await create('bash');
    await create('other', { ownerSessionId: 'other' });
    const waiting = lifecycle.poll({ ...poll, wait: true });
    const rejected = expect(waiting).rejects.toThrow('cancel child');
    controller.abort(new Error('cancel child'));
    await rejected;
    await lifecycle.close();
    expect((await service.get('bash'))?.status).toBe('canceled');
    expect((await service.get('other'))?.status).toBe('running');
  });
  it('observes a completion that raced waiter registration', async () => {
    const { create, service, controller } = await fixture();
    await create('bash', { status: 'succeeded' });
    await service.waitForTaskChange('child', ['bash'], controller.signal);
  });
  it.each(['explicit', 'promoted'] as const)(
    'returns real shell output through the %s background path',
    async (mode) => {
      const { dataDir, host, lifecycle, service, controller } = await fixture();
      const session = {
        ...parentSessionRecord(dataDir),
        sessionId: 'child',
        sessionType: 'branch' as const,
        sessionKind: 'task',
        parentSessionId: 'parent',
        visibility: 'visible' as const,
      };
      const executor = createLocalBackgroundBashExecutor(
        { create: () => createLocalBashOperations({ parentDeathGuard: false }) },
        { mode: 'off' },
      );
      const adapter = buildLocalBashAdapter(host, session, executor);
      const command = nodeCommand("setTimeout(() => { console.log('child-bash-ok'); }, 80)");
      const started =
        mode === 'explicit'
          ? await adapter.startBackground(
              toolContext('child'),
              { command, run_in_background: true },
              controller.signal,
            )
          : await adapter.runManagedForeground!(
              toolContext('child'),
              { command },
              1,
              controller.signal,
            );
      expect(started.status).toBe(mode === 'explicit' ? 'started' : 'auto_promoted');
      const taskId = started.taskId!;
      try {
        expect(await lifecycle.poll({ ...poll, wait: true })).toContain(taskId);
        const task = await service.get(taskId);
        expect(task).toMatchObject({
          status: 'succeeded',
          ownerSessionId: 'child',
          metadata: { parentTurnId: 'turn-child' },
        });
        const output = await service.readOutput(toolContext('child'), taskId, { offset: 0 });
        expect(output.content).toContain('child-bash-ok');
        expect(await service.get(toolContext('other'), taskId)).toBeUndefined();
        expect((await service.readOutput(toolContext('other'), taskId)).content).toBe('');
        expect(await service.stop(toolContext('other'), taskId)).toBeUndefined();
      } finally {
        await lifecycle.close();
      }
    },
  );
});

describe('real child Bash boundaries', () => {
  it('keeps the 600 second command deadline across the actual 60 second soft yield', async () => {
    const { dataDir, host, lifecycle, service, controller } = await fixture();
    const session = {
      ...parentSessionRecord(dataDir),
      sessionId: 'child',
      sessionKind: 'task',
      parentSessionId: 'parent',
    };
    const executor = createLocalBackgroundBashExecutor(
      { create: () => createLocalBashOperations({ parentDeathGuard: false }) },
      { mode: 'off' },
    );
    const tool = new LocalBashTool(dataDir, buildLocalBashAdapter(host, session, executor), {
      mode: 'off',
    });
    const startedAt = Date.now();
    try {
      const receipt = await tool.execute(
        { ...toolContext('child'), canConsumeBackgroundBashOutput: true },
        {
          command: nodeCommand("setTimeout(() => console.log('after-real-soft-yield'), 61500)"),
        },
        controller.signal,
      );
      expect(receipt.details).toMatchObject({ status: 'auto_promoted' });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60000);
      const timing = receipt.details?.timing as {
        commandTimeoutSeconds: number;
        commandTimerStartedAt: number;
        commandDeadlineAt: number;
      };
      expect(timing.commandTimeoutSeconds).toBe(600);
      expect(timing.commandTimerStartedAt).toBeGreaterThanOrEqual(startedAt);
      expect(timing.commandDeadlineAt - timing.commandTimerStartedAt).toBe(600_000);
      expect(timing.commandDeadlineAt - Date.now()).toBeLessThan(550_000);
      const taskId = String(receipt.details?.task_id);
      expect(await lifecycle.poll({ ...poll, wait: true })).toContain(taskId);
      expect((await service.readOutput(toolContext('child'), taskId)).content).toContain(
        'after-real-soft-yield',
      );
      expect((await service.get(taskId))?.metadata?.bashDetails).toMatchObject({
        timing: {
          commandTimeoutSeconds: 600,
          commandTimerStartedAt: timing.commandTimerStartedAt,
          commandDeadlineAt: timing.commandDeadlineAt,
        },
      });
    } finally {
      await lifecycle.close();
    }
  }, 90000);
  it.each(['failure', 'timeout', 'cancel'] as const)(
    'preserves real shell %s and cleans up the process',
    async (mode) => {
      const { dataDir, host, lifecycle, service, controller } = await fixture();
      const session = {
        ...parentSessionRecord(dataDir),
        sessionId: 'child',
        sessionKind: 'task',
        parentSessionId: 'parent',
      };
      const executor = createLocalBackgroundBashExecutor(
        { create: () => createLocalBashOperations({ parentDeathGuard: false }) },
        { mode: 'off' },
      );
      const adapter = buildLocalBashAdapter(host, session, executor);
      const script =
        mode === 'failure'
          ? "console.error('failure-evidence');process.exit(7)"
          : "setTimeout(() => console.log('too-late'), 10000)";
      const receipt = await adapter.startBackground(
        toolContext('child'),
        {
          command: nodeCommand(script),
          ...(mode === 'timeout' ? { timeout: 1 } : {}),
        },
        controller.signal,
      );
      const taskId = receipt.taskId!;
      try {
        if (mode === 'cancel') {
          controller.abort(new Error('parent canceled'));
          await lifecycle.close();
          expect((await service.get(taskId))?.status).toBe('canceled');
        } else {
          expect(await lifecycle.poll({ ...poll, wait: true })).toContain(taskId);
          expect((await service.get(taskId))?.status).toBe('failed');
          const output = await service.readOutput(taskId);
          expect(output.content).toContain(mode === 'failure' ? 'failure-evidence' : 'timed out');
        }
      } finally {
        await lifecycle.close();
      }
    },
    15000,
  );
});

describe('child Bash steering interruption', () => {
  it.each(['before-wait', 'during-wait'] as const)(
    'yields to steering %s without canceling Bash or consuming its result',
    async (arrival) => {
      const { create, lifecycle, service, controller } = await fixture();
      await create('bash');
      const steering = new AbortController();
      const waiting = vi.spyOn(service, 'waitForTaskChange');
      if (arrival === 'before-wait') steering.abort();
      const pending = lifecycle.poll({ ...poll, wait: true, steeringSignal: steering.signal });
      if (arrival === 'during-wait') {
        await vi.waitFor(() => expect(waiting).toHaveBeenCalled());
        steering.abort();
      }
      await expect(pending).resolves.toBeUndefined();
      expect(controller.signal.aborted).toBe(false);
      expect((await service.get('bash'))?.status).toBe('running');
      await service.stop('bash', 'parent requested stop');
    expect(await lifecycle.hasPending()).toBe(false);
      expect(await lifecycle.poll(poll)).toContain('status="canceled"');
      expect(await lifecycle.poll(poll)).toBeUndefined();
    },
  );
});
