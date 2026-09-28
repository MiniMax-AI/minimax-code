import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConversationTurnRejectedError,
  RuntimeConversationShutdownError,
  RuntimeConversationUnavailableError,
  type ConversationSession,
  type ConversationSteerInput,
  type ConversationSteerResult,
  type ConversationTurnResult,
} from '@mavis/conversation-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startBackgroundLocalBash,
  stopBackgroundLocalBashTask,
  type LocalBackgroundBashExecutor,
} from '../../src/background-task/bash-runner.js';
import { scheduleLocalBackgroundTaskDelivery } from '../../src/background-task/delivery.js';
import {
  createBackgroundTaskId,
  type BackgroundTask,
  type TaskStore,
} from '../../src/background-task/domain.js';
import {
  beginBackgroundTaskShutdown,
  drainBackgroundTasks,
  isBackgroundTaskAdmittedHere,
} from '../../src/background-task/lifecycle.js';
import { LocalBackgroundTaskService } from '../../src/background-task/service.js';
import { stopSessionBackgroundWork } from '../../src/background-task/session-cascade.js';
import {
  FsLocalTaskOutputStore,
  SqliteLocalBackgroundTaskStore,
} from '../../src/background-task/store.js';
import { taskTurnId } from '../../src/background-task/turn-id.js';
import { buildLocalTaskAppendAdapter } from '../../src/api/local-task-append.js';
import type { LocalTaskRunnerHostWithSessionLookup } from '../../src/api/local-task-host.js';
import { logger } from '../../src/common/logger.js';
import { closeLocalRuntimeDb } from '../../src/persistence/db.js';
import type { LocalSessionRecord } from '../../src/sessions/controller.js';

vi.mock('../../src/background-task/delivery.js', () => ({
  scheduleLocalBackgroundTaskDelivery: vi.fn(),
}));

const mockedSchedule = vi.mocked(scheduleLocalBackgroundTaskDelivery);

const NOW_MS = 90_000;
const OWNER_SESSION_ID = 'mvs_owner';
const CHILD_SESSION_ID = 'mvs_child';

const toolCtx = {
  sessionId: OWNER_SESSION_ID,
  turnId: 'turn-owner',
  toolCallId: 'call-1',
} as const;

beforeEach(() => {
  vi.clearAllMocks();
});

function childSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    sessionId: CHILD_SESSION_ID,
    agentName: 'worker',
    workspaceDir: '/workspace',
    runtime: 'pi-agent',
    sessionType: 'branch',
    sessionKind: 'task',
    archived: false,
    status: 'idle',
    parentSessionId: OWNER_SESSION_ID,
    visibility: 'hidden',
    purpose: 'local-task:turn-owner:call-0',
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function turnResult(overrides: Partial<ConversationTurnResult> = {}): ConversationTurnResult {
  return {
    turnId: 'turn-child',
    status: 'completed',
    messages: [{ role: 'assistant', text: 'appended answer' }],
    ...overrides,
  };
}

interface AppendHarness {
  readonly host: LocalTaskRunnerHostWithSessionLookup;
  readonly service: LocalBackgroundTaskService;
  readonly store: TaskStore;
  readonly steer: ReturnType<typeof vi.fn>;
  readonly getSession: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly append: (
    input?: {
      taskId?: string;
      content?: string;
      signal?: AbortSignal;
      ctx?: Partial<typeof toolCtx>;
    },
  ) => Promise<{ taskId: string; mode: string }>;
  readonly seedSourceTask: (overrides?: Partial<BackgroundTask>) => Promise<BackgroundTask>;
  readonly dispose: () => Promise<void>;
}

async function appendHarness(
  options: {
    steer?: (input: ConversationSteerInput) => Promise<ConversationSteerResult>;
    session?: ConversationSession | undefined;
  } = {},
): Promise<AppendHarness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'local-task-append-'));
  const store = new SqliteLocalBackgroundTaskStore(dataDir, () => NOW_MS);
  const abort = vi.fn(async (_sessionId: string, _reason: string, _turnId?: string) => true);
  const service = new LocalBackgroundTaskService({
    store,
    outputStore: new FsLocalTaskOutputStore(dataDir),
    nowMs: () => NOW_MS,
    // Mirrors LocalRuntimeApiHost's stopRuntime (api/host.ts): stop a bash runner,
    // then abort the exact child Turn a subagent row records.
    stopRuntime: async (task, reason) => {
      await stopBackgroundLocalBashTask(task, reason);
      const { childSessionId, subTurnId } = task.metadata ?? {};
      if (typeof childSessionId === 'string' && typeof subTurnId === 'string') {
        await abort(childSessionId, 'lifecycle', subTurnId);
      }
    },
  });
  const rawSteer =
    options.steer ??
    (async (input: ConversationSteerInput): Promise<ConversationSteerResult> => ({
      turnId: input.requestedTurnId!,
      mode: 'activated',
      completion: Promise.resolve(turnResult()),
    }));
  const steer = vi.fn(async (input: ConversationSteerInput): Promise<ConversationSteerResult> => {
    const result = await rawSteer(input);
    if (result.mode !== 'duplicate') {
      await input.preDelivery?.accept({ mode: result.mode, turnId: result.turnId });
    }
    return result;
  });
  const target = options.session === undefined ? childSession() : options.session;
  const getSession = vi.fn(async (sessionId: string) =>
    target && target.sessionId === sessionId ? target : undefined,
  );
  const warn = vi.fn();
  const host = {
    runtimeConversation: { query: { getSession }, ingress: { steer, abort } },
    backgroundTaskService: service,
    matrixLogger: { warn, info: vi.fn() },
    nowMs: () => NOW_MS,
    resolveDefaultWorkspaceDir: () => dataDir,
    getSessionById: async () => undefined,
  } as unknown as LocalTaskRunnerHostWithSessionLookup;
  const adapter = buildLocalTaskAppendAdapter(host);
  let seeded = 0;
  return {
    host,
    service,
    store,
    steer,
    getSession,
    abort,
    warn,
    append: (input = {}) =>
      adapter.append(
        { ...toolCtx, ...input.ctx },
        { taskId: input.taskId ?? 'bg_source', content: input.content ?? 'more work' },
        input.signal,
      ),
    seedSourceTask: async (overrides = {}) => {
      seeded += 1;
      const taskId = overrides.taskId ?? 'bg_source';
      return service.create({
        taskId,
        kind: 'subagent',
        status: 'succeeded',
        ownerSessionId: OWNER_SESSION_ID,
        description: `Seeded task ${seeded}`,
        toolCallId: 'call-0',
        createdAt: NOW_MS,
        updatedAt: NOW_MS,
        ...overrides,
        metadata: {
          childSessionId: CHILD_SESSION_ID,
          executionMode: 'foreground',
          agentName: 'worker',
          resolvedAgentName: 'worker',
          requestedAgentName: 'worker',
          canonicalRole: 'worker',
          subTurnId: taskTurnId(taskId),
          ...overrides.metadata,
        },
      });
    },
    dispose: async () => {
      closeLocalRuntimeDb(dataDir);
      // A completion handler may still be flushing output for a task this test
      // deliberately left running, so cleanup tolerates a concurrent write.
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }).catch(
        () => undefined,
      );
    },
  };
}

async function listOwnerTasks(store: TaskStore): Promise<BackgroundTask[]> {
  return (await store.list({ ownerSessionId: OWNER_SESSION_ID })).items;
}

async function captureError(promise: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; status: number };
  }
  throw new Error('Expected task_append to reject');
}

describe('task_append process claim', () => {
  // An activated append runs a new child Turn under its own task row, so this
  // process must claim it like any background task it runs. Without the claim a
  // Session stop cascade skips the row as another process's work — the append and
  // what its child Turn spawned keep running while their notices are suppressed.

  it('lets a Session stop cascade stop an activated append and sweep its child Turn', async () => {
    const harness = await appendHarness({ steer: activatedUntilAborted });
    const info = vi.spyOn(logger, 'info');
    try {
      await harness.seedSourceTask({ deliveredAt: NOW_MS });
      harness.abort.mockImplementation(async (_sessionId, reason, turnId) => {
        finishAbortedTurn(turnId, reason);
        return true;
      });

      const { taskId, mode } = await harness.append();
      const turnId = taskTurnId(taskId);
      expect(mode).toBe('activated');
      expect(isBackgroundTaskAdmittedHere(harness.host, taskId)).toBe(true);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'task_append_admission_identified',
          taskId,
          childSessionId: CHILD_SESSION_ID,
          turnId,
        }),
        expect.any(String),
      );
      // Background bash the append's own child Turn started, via the real runner.
      const bashTaskId = await startChildBash(harness, turnId);
      const onTargets = vi.fn();

      const { targets } = await stopSessionBackgroundWork({
        host: harness.host,
        sessionId: OWNER_SESSION_ID,
        reason: 'owner_abort',
        boundaryMs: NOW_MS,
        ctx: { depth: 0, visited: new Set<string>(), onTargets },
      });

      expect(onTargets.mock.calls.flat(2)).toContain(taskId);
      expect(harness.abort).toHaveBeenCalledWith(CHILD_SESSION_ID, 'lifecycle', turnId);
      expect(targets).toEqual([expect.objectContaining({ taskId, status: 'canceled' })]);
      await expect(harness.store.get(bashTaskId)).resolves.toMatchObject({ status: 'canceled' });
      // The claim outlives the terminal write: drained means the row is terminal.
      await drainBackgroundTasks(harness.host);
      expect(isBackgroundTaskAdmittedHere(harness.host, taskId)).toBe(false);
      await expect(harness.store.get(taskId)).resolves.toMatchObject({ status: 'canceled' });
    } finally {
      info.mockRestore();
      await harness.dispose();
    }
  });

  it('aborts a claimed append at shutdown so the host drain finishes', async () => {
    const harness = await appendHarness({ steer: activatedUntilAborted });
    try {
      await harness.seedSourceTask();
      harness.abort.mockImplementation(async (_sessionId, reason, turnId) => {
        finishAbortedTurn(turnId, reason);
        return true;
      });
      const { taskId } = await harness.append();

      beginBackgroundTaskShutdown(harness.host, 'runtime-shutdown');

      expect(harness.abort).toHaveBeenCalledWith(CHILD_SESSION_ID, 'lifecycle', taskTurnId(taskId));
      await expect(drainsWithin(harness.host, 2_000)).resolves.toBe('drained');
      await expect(harness.store.get(taskId)).resolves.toMatchObject({ status: 'canceled' });
    } finally {
      await harness.dispose();
    }
  });

  it('rejects an activation during shutdown with the append contract error, claiming nothing', async () => {
    const harness = await appendHarness();
    const warn = vi.spyOn(logger, 'warn');
    try {
      await harness.seedSourceTask();
      beginBackgroundTaskShutdown(harness.host, 'runtime-shutdown');

      await expect(captureError(harness.append())).resolves.toMatchObject({
        code: 'TASK_APPEND_UNAVAILABLE',
        status: 503,
      });
      await expect(listOwnerTasks(harness.store)).resolves.toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'task_append_admission_closing_rejected',
          childSessionId: CHILD_SESSION_ID,
          error: 'Local Runtime is shutting down',
        }),
        expect.any(String),
      );
      await expect(drainsWithin(harness.host, 200)).resolves.toBe('drained');
    } finally {
      warn.mockRestore();
      await harness.dispose();
    }
  });

  it.each(['steered', 'duplicate'] as const)(
    'claims nothing for a %s append, which starts no new Turn',
    async (mode) => {
      const activeTaskId = createBackgroundTaskId();
      const harness = await appendHarness({
        steer: async () => ({ turnId: taskTurnId(activeTaskId), mode }),
      });
      try {
        await harness.seedSourceTask();
        await harness.seedSourceTask({ taskId: activeTaskId, status: 'running' });

        await expect(harness.append()).resolves.toEqual({ taskId: activeTaskId, mode });

        await expect(drainsWithin(harness.host, 200)).resolves.toBe('drained');
      } finally {
        await harness.dispose();
      }
    },
  );

  it.each([
    {
      label: 'the task row cannot be persisted',
      reason: 'row_persist_failed',
      steer: undefined,
      failRowCreate: true,
    },
    {
      label: 'delivery fails after the row was created',
      reason: 'activation_failed',
      steer: async (input: ConversationSteerInput): Promise<ConversationSteerResult> => {
        await input.preDelivery?.accept({ mode: 'activated', turnId: input.requestedTurnId! });
        throw new Error('compatibility failed after activation');
      },
      failRowCreate: false,
    },
  ])('releases the claim when $label', async ({ reason, steer, failRowCreate }) => {
    const harness = await appendHarness(steer ? { steer } : {});
    const info = vi.spyOn(logger, 'info');
    try {
      await harness.seedSourceTask();
      if (failRowCreate) {
        vi.spyOn(harness.service, 'create').mockRejectedValueOnce(new Error('task store closed'));
      }

      await expect(harness.append()).rejects.toThrow();

      await expect(drainsWithin(harness.host, 200)).resolves.toBe('drained');
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'task_append_admission_released',
          childSessionId: CHILD_SESSION_ID,
          reason,
        }),
        expect.any(String),
      );
      // A created row is terminal before its claim ends, as the cascade re-read needs.
      const candidates = (await listOwnerTasks(harness.store)).filter(
        (task) => task.taskId !== 'bg_source',
      );
      for (const task of candidates) expect(task.status).toBe('failed');
    } finally {
      info.mockRestore();
      await harness.dispose();
    }
  });
});

/** Activation whose child Turn runs until `finishAbortedTurn` ends it. */
const pendingTurns = new Map<string, (result: ConversationTurnResult) => void>();

async function activatedUntilAborted(
  input: ConversationSteerInput,
): Promise<ConversationSteerResult> {
  const turnId = input.requestedTurnId!;
  const completion = new Promise<ConversationTurnResult>((resolve) => {
    pendingTurns.set(turnId, resolve);
  });
  return { turnId, mode: 'activated', completion };
}

function finishAbortedTurn(turnId: string | undefined, reason: string): void {
  if (!turnId) return;
  pendingTurns.get(turnId)?.(
    turnResult({ turnId, status: 'aborted', messages: [], error: reason }),
  );
  pendingTurns.delete(turnId);
}

/** Starts a background bash in the child Session as the given child Turn's tool call. */
async function startChildBash(harness: AppendHarness, childTurnId: string): Promise<string> {
  // Runs until aborted, like a long command the child Turn left behind.
  const executor: LocalBackgroundBashExecutor = {
    execute: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error(String(signal.reason))));
      }),
  };
  const started = await startBackgroundLocalBash({
    host: harness.host,
    parentSession: { sessionId: CHILD_SESSION_ID, workspaceDir: '/workspace' } as LocalSessionRecord,
    toolCtx: { sessionId: CHILD_SESSION_ID, turnId: childTurnId, toolCallId: 'call-bash' },
    bashInput: { command: 'sleep 600', run_in_background: true },
    executor,
  });
  expect(isBackgroundTaskAdmittedHere(harness.host, started.taskId!)).toBe(true);
  return started.taskId!;
}

/** `drained` once no claim of this host is still open; `pending` after `timeoutMs`. */
async function drainsWithin(
  host: LocalTaskRunnerHostWithSessionLookup,
  timeoutMs: number,
): Promise<'drained' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      drainBackgroundTasks(host).then(() => 'drained' as const),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
