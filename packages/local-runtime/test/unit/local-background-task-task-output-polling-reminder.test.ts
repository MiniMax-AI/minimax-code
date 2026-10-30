import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { toRuntimeTool, type RuntimeTool } from '@mavis/agent-core/tools';
import { LocalTaskOutputTool } from '@mavis/agent-tools/desktop';
import { describe, expect, it, vi } from 'vitest';

import type { LocalTaskRunnerHostWithSessionLookup } from '../../src/api/local-task-host.js';
import { startLocalBackgroundTaskDeliveryTurn } from '../../src/background-task/delivery.js';

import type { AppDb } from '../../../local-runtime-v2/src/infra/db/client.js';
import { createSessionSystemAgentProjection } from '../../../local-runtime-v2/src/service/session-system/agent-projection.js';
import { createSessionSystemCanonicalHistoryProvider } from '../../../local-runtime-v2/src/service/session-system/messages/history/canonical-history-provider.js';
import { createSessionHistoryMutationAdapter } from '../../../local-runtime-v2/src/service/session-system/messages/history/mutation/session-history-mutation-adapter.js';
import type {
  MessageUpsertInput,
  NormalizedDisplayMessage,
} from '../../../local-runtime-v2/src/service/session-system/messages/repo/contract.js';
import type { SessionRecord } from '../../../local-runtime-v2/src/service/session-system/sessions/repo/contract.js';
import type {
  SessionFrameInput,
  SessionFrameWriteResult,
} from '../../../local-runtime-v2/src/service/session-system/stream/session-frame.js';
import {
  createLocalAgentHost,
  createProductionAgentPreparation,
} from '../../../local-runtime-v2/src/service/turn-system/production-composition.js';

const TASK_OUTPUT_POLLING_REMINDER = `<system-reminder>
Three task_output reads for the same task have returned an unchanged status and output cursor. Avoid repeated polling; you will be notified automatically and this conversation will resume when the background task completes.
This reminder applies only to the current Turn. Do not save or generalize it into Memory, Skills, or other persistent instructions.
</system-reminder>`;

interface TaskOutputState {
  readonly taskId: string;
  readonly task: {
    readonly taskId: string;
    readonly kind: 'bash';
    readonly status: 'succeeded';
    readonly ownerSessionId: string;
    readonly description: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly startedAt: number;
    readonly endedAt: number;
  };
  readonly taskOutput: RuntimeTool;
  readonly hasCompletedTask: () => boolean;
  readonly readOutputCalls: () => number;
  readonly setTaskStatus: (status: 'running' | 'succeeded') => void;
}

interface PollingHostInput {
  readonly agent: { readonly agentName: string; readonly displayName: string; readonly systemPrompt: string };
  readonly canonicalHistory: ReturnType<typeof createSessionSystemCanonicalHistoryProvider>;
  readonly dataDir: string;
  readonly hasCompletedTask: () => boolean;
  readonly historyMutation: ReturnType<typeof createSessionHistoryMutationAdapter>;
  readonly projection: ReturnType<typeof createSessionSystemAgentProjection>;
  readonly session: SessionRecord;
  readonly sessionRepository: {
    readonly get: (sessionId: string) => Promise<SessionRecord | undefined>;
  };
  readonly streamFn: StreamFn;
  readonly taskId: string;
  readonly taskOutput: RuntimeTool;
}

async function createTaskOutputPollingCompositionHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'task-output-polling-composition-'));
  const session = createSession(dataDir);
  const agent = {
    agentName: 'mavis',
    displayName: 'Mavis',
    systemPrompt: 'You are Mavis.',
  };
  const sessionRepository = {
    get: vi.fn(async (sessionId: string) =>
      sessionId === session.sessionId ? session : undefined,
    ),
  };
  const canonicalHistory = createSessionSystemCanonicalHistoryProvider({
    dataDir,
    sessions: sessionRepository,
  });
  const historyMutation = createSessionHistoryMutationAdapter({
    dataDir,
    sessions: sessionRepository,
  });
  const display = createDisplayProjection(session);
  const taskState = createTaskOutputState(session.sessionId);
  const providerContexts: unknown[] = [];
  const composition = await createTaskOutputPollingHost({
    agent,
    canonicalHistory,
    dataDir,
    hasCompletedTask: taskState.hasCompletedTask,
    historyMutation,
    projection: display.projection,
    session,
    sessionRepository,
    streamFn: createPollingStream(taskState.taskId, providerContexts),
    taskId: taskState.taskId,
    taskOutput: taskState.taskOutput,
  });

  return {
    dataDir,
    displayStreamWrites: display.streamWrites,
    displayUpserts: display.upserts,
    providerContexts,
    run: (turnId: string, input: { readonly text: string; readonly origin?: unknown }) =>
      composition.host.run({
        lease: {
          sessionId: session.sessionId,
          turnId,
          leaseId: `lease-${turnId}`,
          busyReason: 'turn',
          acceptedSequence: turnId === 'turn-polling' ? 1 : 2,
          acceptedAtMs: 1_000,
          signal: new AbortController().signal,
        },
        request: {
          input,
          genuineUserQueryText: input.origin ? '' : input.text,
          requiresInputReview: !input.origin,
          provenance: {
            source: input.origin ? 'background-task' : 'api',
            routingFingerprint: input.origin
              ? `background-task:${taskState.taskId}`
              : 'api:polling',
          },
        },
      } as never),
    session,
    task: taskState.task,
    taskId: taskState.taskId,
    readOutputCalls: taskState.readOutputCalls,
    setTaskStatus: taskState.setTaskStatus,
  };
}

function createSession(dataDir: string): SessionRecord {
  return {
    sessionId: 'session-task-output-polling',
    agentName: 'mavis',
    workspaceDir: dataDir,
    runtime: 'pi-agent',
    sessionType: 'root',
    sessionKind: 'conversation',
    archived: false,
    status: 'idle',
    createdAtMs: Date.UTC(2026, 8, 16, 0, 0, 0),
    updatedAtMs: Date.UTC(2026, 8, 16, 0, 0, 0),
  };
}

function createDisplayProjection(session: SessionRecord) {
  const upserts: MessageUpsertInput[] = [];
  const streamWrites: SessionFrameInput[] = [];
  const projection = createSessionSystemAgentProjection({
    state: {
      markStarted: vi.fn(async () => ({ status: 'applied' as const })),
      markIdle: vi.fn(async () => ({ status: 'applied' as const })),
      markTerminal: vi.fn(async () => ({ status: 'applied' as const })),
    },
    sessions: { update: vi.fn(async () => session) },
    messages: {
      get: vi.fn(async () => undefined),
      upsert: vi.fn(async (input: MessageUpsertInput): Promise<NormalizedDisplayMessage> => {
        upserts.push(input);
        return normalizeDisplayMessage(input, upserts.length);
      }),
      listTurn: vi.fn(async () => []),
      rewind: vi.fn(async () => undefined),
    },
    stream: {
      write: vi.fn((input: SessionFrameInput): SessionFrameWriteResult => {
        streamWrites.push(input);
        return writeSessionFrame(input);
      }),
    },
    conversationFacts: { handle: vi.fn(async () => undefined) },
  });
  return { projection, streamWrites, upserts };
}

function normalizeDisplayMessage(
  input: MessageUpsertInput,
  position: number,
): NormalizedDisplayMessage {
  const sourceContext = input.sourceContext ?? input.message.sourceContext;
  return {
    msgId: input.message.msg_id ?? `display-${position}`,
    role: input.message.role ?? null,
    turnId: input.turnId ?? input.message.turnId ?? input.message.meta?.turnId ?? null,
    source: input.source ?? input.message.source ?? null,
    sourceContextJson: sourceContext ? JSON.stringify(sourceContext) : null,
    createdAtMs: input.message.timestamp ?? input.message.created_at ?? 0,
    dataJson: JSON.stringify(input.message),
  };
}

function writeSessionFrame(input: SessionFrameInput): SessionFrameWriteResult {
  return {
    appended: true,
    retained: true,
    frame: {
      identity: input.identity,
      sessionId: input.sessionId,
      kind: input.kind,
      data: input.data,
      createdAtMs: input.createdAtMs ?? 0,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.messageActionDeltas ? { messageActionDeltas: input.messageActionDeltas } : {}),
    },
  };
}

function createTaskOutputState(sessionId: string): TaskOutputState {
  let taskStatus: 'running' | 'succeeded' = 'running';
  let readOutputCalls = 0;
  const taskId = 'task-background-result';
  const task = {
    taskId,
    kind: 'bash' as const,
    status: 'succeeded' as const,
    ownerSessionId: sessionId,
    description: 'Produce the final background result',
    createdAt: 1_000,
    updatedAt: 2_000,
    startedAt: 1_500,
    endedAt: 2_000,
  };
  const taskOutput = {
    ...toRuntimeTool(
      new LocalTaskOutputTool({
        get: vi.fn(async (_context, requestedTaskId) =>
          requestedTaskId === taskId ? { ...task, status: taskStatus } : undefined,
        ),
        list: vi.fn(async () => ({ items: [] })),
        readOutput: vi.fn(async (_context, requestedTaskId) => {
          readOutputCalls += 1;
          return {
            content:
              requestedTaskId === taskId && taskStatus === 'succeeded'
                ? 'verified terminal background result'
                : '',
            nextOffset: taskStatus === 'succeeded' ? 34 : 0,
            status: taskStatus,
          };
        }),
        stop: vi.fn(async () => undefined),
      } as never),
    ),
    source: 'builtin' as const,
  };
  return {
    task,
    taskId,
    taskOutput,
    hasCompletedTask: () => taskStatus === 'succeeded',
    readOutputCalls: () => readOutputCalls,
    setTaskStatus: (status) => {
      taskStatus = status;
    },
  };
}

function createPollingStream(taskId: string, providerContexts: unknown[]): StreamFn {
  let providerCall = 0;
  return async (_model, context) => {
    providerContexts.push(providerContextSnapshot(context));
    const response = providerCall++;
    if (response === 0) {
      return completedAssistantStream(
        assistantMessage(
          [
            { type: 'toolCall', id: 'poll-1', name: 'task_output', arguments: { task_id: taskId } },
            { type: 'toolCall', id: 'poll-2', name: 'task_output', arguments: { task_id: taskId } },
            { type: 'toolCall', id: 'poll-3', name: 'task_output', arguments: { task_id: taskId } },
          ],
          'toolUse',
        ),
      );
    }
    if (response === 1) {
      return completedAssistantStream(
        assistantMessage([{ type: 'text', text: 'Waiting for the background task.' }], 'stop'),
      );
    }
    if (response === 2) {
      return completedAssistantStream(
        assistantMessage(
          [
            {
              type: 'toolCall',
              id: 'completed-read',
              name: 'task_output',
              arguments: { task_id: taskId },
            },
          ],
          'toolUse',
        ),
      );
    }
    return completedAssistantStream(
      assistantMessage(
        [{ type: 'text', text: 'Background task result: verified terminal background result.' }],
        'stop',
      ),
    );
  };
}

async function createTaskOutputPollingHost(input: PollingHostInput) {
  const model = {
    id: 'model',
    name: 'Test model',
    api: 'openai-completions' as const,
    provider: 'test',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
  const configBuilder = {
    config: () => ({
      dataDir: input.dataDir,
      defaultModel: 'test/model',
      provider: {
        test: {
          options: { apiKey: 'test-key', baseURL: 'https://example.invalid' },
          models: { model: { limit: { context: 200_000, output: 8_192 } } },
        },
      },
    }),
    skills: {
      listRuntimeSkills: vi.fn(async () => ({ skills: [] })),
      renderCatalog: vi.fn(async () => ''),
    },
    staticPrompts: {
      readBasePrompt: vi.fn(async () => ''),
      readSessionPrompt: vi.fn(async () => ''),
      readProjectInstructions: vi.fn(async () => ''),
    },
  };
  const preparation = createProductionAgentPreparation({
    configBuilder,
    modelResolver: {
      resolveModel: vi.fn(async () => ({ model, apiKey: 'test-key', streamFn: input.streamFn })),
    },
  } as never);
  const scopedControl = {
    drainSteering: vi.fn(() => []),
    ackSteering: vi.fn(),
    restoreSteering: vi.fn(),
    tryBeginClose: vi.fn(() => ({ closed: true as const })),
    sealAbnormalTerminal: vi.fn(async () => undefined),
    openToolResultTail: vi.fn(() => true),
    closeAndClaimToolResultTail: vi.fn(() => []),
    ackToolResultTail: vi.fn(),
  };
  return createLocalAgentHost({
    product: {
      agents: { getExecutionSnapshot: vi.fn(async () => input.agent) },
      preparation: { configBuilder },
      turnRuntimeFacts: { snapshot: vi.fn(() => ({ cuModeActive: false })) },
      checkpointState: { captureSubagents: vi.fn(async () => undefined) },
      toolSources: {
        resolve: vi.fn(async () => ({
          nativeTools: [input.taskOutput],
          mcpEntries: [],
          threadGoalTools: [],
          cuRuntimeAvailable: false,
        })),
      },
      inputPreparation: {
        reminders: {
          buildBackground: vi.fn(async () => ({
            tasks: [],
            undeliveredTotal: 0,
            terminalTotal: 0,
          })),
          buildSystem: vi.fn(async () => ({ content: '' })),
          confirmBackgroundTaskReads: vi.fn(async () =>
            input.hasCompletedTask() ? [input.taskId] : [],
          ),
        },
      },
      terminalMemory: { record: vi.fn(async () => undefined) },
      permission: {
        decisions: { check: vi.fn(async () => ({ behavior: 'allow' as const, reason: 'test' })) },
      },
      runner: { logger: { info: vi.fn(), error: vi.fn() } },
      executor: {
        fileChanges: {
          begin: vi.fn(async () => undefined),
          finalize: vi.fn(async () => undefined),
          markFailed: vi.fn(async () => undefined),
        },
        reportFailure: vi.fn(),
      },
    },
    db: {} as AppDb,
    preparation,
    sessions: {
      llmCalls: { writeCurrent: vi.fn(async () => undefined) },
      sessions: {
        repository: input.sessionRepository,
        execution: { getExecutionSnapshot: vi.fn(async () => input.session) },
        historyMutation: input.historyMutation,
      },
      canonicalHistory: input.canonicalHistory,
      artifacts: {
        ensureReportsDirectory: vi.fn(async () => {
          const reportsDirectory = join(input.dataDir, 'reports');
          await mkdir(reportsDirectory, { recursive: true });
          return reportsDirectory;
        }),
      },
      agentProjection: {
        session: input.projection.session,
        messages: input.projection.messages,
        attemptRecall: input.projection.attemptRecall,
        stream: input.projection.stream,
        historyFailures: input.projection.historyFailures,
        compactionLifecycle: input.projection.compactionLifecycle,
        compactionObserver: input.projection.compactionObserver,
      },
      usage: { projector: { record: vi.fn() } },
    },
    safety: { review: vi.fn(async () => ({ pass: true })) },
    turnControl: {
      scope: vi.fn(() => scopedControl),
      beginClose: vi.fn(() => ({ closed: true as const })),
    },
    pluginHookSessionOwnership: {
      prepare: vi.fn(async () => undefined),
      activate: vi.fn(async () => undefined),
    },
    turnFacts: {
      projectRuntimeEvent: vi.fn(async () => undefined),
      projectHistoryCommitted: vi.fn(async () => undefined),
    },
    onInputReviewResolved: vi.fn(),
    onSteeringConsumed: vi.fn(async () => undefined),
    cliProductPolicy: true,
  } as never);
}

function assistantMessage(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'test',
    model: 'model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1_000,
  };
}

function completedAssistantStream(final: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: 'done',
    reason: final.stopReason === 'toolUse' ? 'toolUse' : 'stop',
    message: final,
  });
  return stream;
}

function includesValue(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value.includes(expected);
  if (Array.isArray(value)) return value.some((entry) => includesValue(entry, expected));
  if (value && typeof value === 'object')
    return Object.values(value).some((entry) => includesValue(entry, expected));
  return false;
}

function providerContextSnapshot(context: unknown): unknown {
  const value = context as {
    readonly systemPrompt: unknown;
    readonly messages: unknown;
    readonly tools?: readonly Readonly<Record<string, unknown>>[];
  };
  return structuredClone({
    systemPrompt: value.systemPrompt,
    messages: value.messages,
    ...(value.tools
      ? {
          tools: value.tools.map(({ execute: _execute, ...tool }) => tool),
        }
      : {}),
  });
}

describe('task_output polling reminder through Local Runtime background delivery', () => {
  it('keeps the reminder durable and resumes the original session after a terminal delivery', async () => {
    const fixture = await createTaskOutputPollingCompositionHarness();

    // Keep cleanup in the async body: a runner timeout does not stop the
    // pending history writes, so afterEach must not remove their directory.
    try {
      const pollingOutcome = await fixture.run('turn-polling', {
        text: 'Check the running background task.',
      });
      if (pollingOutcome.status === 'failed') throw pollingOutcome.error;
      expect(pollingOutcome).toMatchObject({ status: 'completed' });
      expect(fixture.providerContexts).toHaveLength(2);
      expect(includesValue(fixture.providerContexts[0], TASK_OUTPUT_POLLING_REMINDER)).toBe(false);
      expect(includesValue(fixture.providerContexts[1], TASK_OUTPUT_POLLING_REMINDER)).toBe(true);
      expect(fixture.readOutputCalls()).toBe(3);

      const reloadedHistory = createSessionSystemCanonicalHistoryProvider({
        dataDir: fixture.dataDir,
        sessions: { get: vi.fn(async () => fixture.session) },
      });
      const reloadedAfterPolling = await reloadedHistory.read(fixture.session.sessionId);
      const remindersAfterPolling = reloadedAfterPolling.messages.flatMap((message, index) =>
        includesValue(message, TASK_OUTPUT_POLLING_REMINDER) ? [{ message, index }] : [],
      );
      expect(remindersAfterPolling).toHaveLength(1);
      const reminder = remindersAfterPolling[0];
      expect(reminder?.message).toMatchObject({
        role: 'user',
        content: TASK_OUTPUT_POLLING_REMINDER,
      });
      expect(reloadedAfterPolling.identityVector[reminder?.index ?? -1]).not.toMatch(
        /^msg-user-v1-/u,
      );

      fixture.setTaskStatus('succeeded');
      let continuation: Promise<unknown> | undefined;
      const steer = vi.fn(
        async (input: {
          readonly message: { readonly content: string; readonly origin: unknown };
        }) => {
          continuation = fixture.run('turn-background-delivery', {
            text: input.message.content,
            origin: input.message.origin,
          });
          return {
            turnId: 'turn-background-delivery',
            mode: 'activated' as const,
            completion: continuation,
          };
        },
      );
      const deliveryHost = {
        runtimeConversation: { ingress: { steer } },
        backgroundTaskService: {
          get: vi.fn(async (taskId: string) =>
            taskId === fixture.taskId ? fixture.task : undefined,
          ),
          reminderSnapshot: vi.fn(async () => ({
            tasks: [fixture.task],
            undeliveredTotal: 1,
            terminalTotal: 1,
          })),
        },
        nowMs: () => 2_000,
        getSessionById: vi.fn(async () => fixture.session),
      } as unknown as LocalTaskRunnerHostWithSessionLookup;

      await expect(startLocalBackgroundTaskDeliveryTurn(deliveryHost, fixture.taskId)).resolves.toBe(
        'delivered',
      );
      if (!continuation) throw new Error('background terminal delivery did not start a continuation');
      await expect(continuation).resolves.toMatchObject({ status: 'completed' });
      expect(steer).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: fixture.session.sessionId,
          source: 'background-task',
          message: expect.objectContaining({
            hideUserMessage: true,
            content: expect.stringContaining('<background-task-finished>'),
          }),
        }),
      );
      expect(includesValue(fixture.providerContexts[2], TASK_OUTPUT_POLLING_REMINDER)).toBe(true);
      expect(includesValue(fixture.providerContexts[3], 'verified terminal background result')).toBe(
        true,
      );
      expect(fixture.readOutputCalls()).toBe(4);

      const reloadedAfterDelivery = await reloadedHistory.read(fixture.session.sessionId);
      expect(
        reloadedAfterDelivery.messages.filter((message) =>
          includesValue(message, TASK_OUTPUT_POLLING_REMINDER),
        ),
      ).toHaveLength(1);
      expect(
        reloadedAfterDelivery.messages.find(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            Reflect.get(message, 'role') === 'toolResult' &&
            Reflect.get(message, 'toolCallId') === 'completed-read',
        ),
      ).toMatchObject({ details: { status: 'succeeded' } });

      const display = JSON.stringify({
        upserts: fixture.displayUpserts,
        stream: fixture.displayStreamWrites,
      });
      expect(display).not.toContain(TASK_OUTPUT_POLLING_REMINDER);
      expect(display).not.toContain('msg-user-v1-');
      expect(display).toContain('Waiting for the background task.');
      expect(display).toContain('Background task result: verified terminal background result.');
    } finally {
      await rm(fixture.dataDir, { recursive: true, force: true });
    }
  }, 15_000); // Real history persistence and continuation on slower CI disks.
});
