/**
 * Session stop cascade, end to end over the assembled V2 Runtime host.
 *
 * Covers the user-visible contract: a user stop tears
 * down the Session's background work, the resulting terminals never wake the
 * Session, and the model still learns what happened on the next turn through
 * the existing background cadence reminder.
 *
 * The Pi runner is mocked so each Turn is a deterministic script, but every
 * other layer is production: real TurnSystem admission/abort, real background
 * task rows, real bash execution (a real OS process), real delivery scheduler.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CreatedLocalRuntimeHost,
  type LocalRuntimeConfig,
} from '@mavis/local-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeLocalRuntimeDb } from '../../../local-runtime/src/persistence/db.js';
import { createLocalRuntimeHostV2ForTest } from '../../src/runtime.js';

interface ScriptedTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly eventIdGenerator?: (kind: string) => string;
  readonly runtimeSeqGenerator?: () => number;
  readonly canonicalMessages?: readonly unknown[];
  readonly hooks?: { readonly beforeLlmCallHook?: readonly ((input: unknown) => unknown)[] };
  readonly model?: unknown;
  readonly eventWriter: {
    pushRuntime(event: Record<string, unknown>): void | Promise<void>;
  };
  readonly toolConfig: {
    readonly context: unknown;
    readonly tools?: readonly {
      readonly def: { readonly name: string };
      readonly impl: {
        execute(
          context: unknown,
          input: Record<string, unknown>,
          signal?: AbortSignal,
        ): Promise<{ readonly details?: Record<string, unknown> }>;
      };
    }[];
  };
  readonly beforeLlmCall?: (input: unknown) => unknown;
}

/**
 * Per-Turn scripts keyed by the order in which Turns start. The harness records
 * everything a "model" would have seen so assertions can inspect the assembled
 * context of a later Turn.
 */
const harness = vi.hoisted(() => ({
  /** Turn scripts run in order; a missing script just completes the Turn. */
  scripts: [] as ((input: ScriptedTurnInput) => Promise<void>)[],
  invocations: 0,
  /** Session ids of every Turn the Runtime actually started. */
  startedTurns: [] as { sessionId: string; turnId: string }[],
  /** Canonical message arrays captured per Turn. */
  observedContexts: [] as { turnId: string; messages: readonly unknown[] }[],
  /** Messages the production before-LLM hooks inject into the provider request. */
  injectedMessages: [] as { turnId: string; content: string }[],
}));

vi.mock('@mavis/agent-core/pi-turn-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mavis/agent-core/pi-turn-runner')>();
  return {
    ...actual,
    PiTurnRunner: class {
      async runTurn(input: ScriptedTurnInput): Promise<void> {
        const index = harness.invocations;
        harness.invocations += 1;
        harness.startedTurns.push({ sessionId: input.sessionId, turnId: input.turnId });
        harness.observedContexts.push({
          turnId: input.turnId,
          messages: [...(input.canonicalMessages ?? [])],
        });
        // The production reminder is injected by a before-LLM hook, not by the
        // durable history. Run the real hooks exactly as PiTurnRunner would and
        // record every message they would have added to the provider request.
        for (const hook of input.hooks?.beforeLlmCallHook ?? []) {
          const decision = await hook({
            sessionId: input.sessionId,
            turnId: input.turnId,
            phase: 'initial',
            messages: [],
            canonicalMessages: [],
            // Shape required by the reminder's context-budget admission check
            // (provider/api/id build the usage-anchor key; the limits gate size).
            model: {
              id: 'model',
              provider: 'test',
              api: 'openai-completions',
              contextWindow: 200_000,
              maxTokens: 8_192,
            },
            systemPrompt: '',
            tools: [],
            thinkingLevel: 'off',
          });
          const message =
            decision && typeof decision === 'object' ? Reflect.get(decision, 'message') : undefined;
          const content =
            message && typeof message === 'object' ? Reflect.get(message, 'content') : undefined;
          if (typeof content === 'string') {
            harness.injectedMessages.push({ turnId: input.turnId, content });
          }
        }
        const script = harness.scripts[index];
        if (script) await script(input);
        await input.eventWriter.pushRuntime(terminalEvent(input, 6, 1, 'completed'));
      }
    },
  };
});

function terminalEvent(
  input: ScriptedTurnInput,
  status: number,
  stopReason: number,
  message: string,
): Record<string, unknown> {
  return {
    schema: 'archon.runtime.event.v1',
    event_id: input.eventIdGenerator?.('session-status') ?? `evt-${input.turnId}-${status}`,
    session_id: input.sessionId,
    turn_id: input.turnId,
    runtime_seq: input.runtimeSeqGenerator?.() ?? status,
    type: 3,
    payload: { status, stop_reason: { type: stopReason, message } },
  };
}

function tool(input: ScriptedTurnInput, name: string) {
  const found = input.toolConfig.tools?.find((candidate) => candidate.def.name === name);
  if (!found) throw new Error(`Production Turn omitted the ${name} tool`);
  return found;
}

/** Starts a detached bash whose OS process outlives the Turn. */
async function startBackgroundBash(input: ScriptedTurnInput, command: string): Promise<string> {
  const result = await tool(input, 'bash').impl.execute(
    input.toolConfig.context,
    { command, run_in_background: true },
    input.signal,
  );
  const taskId = result.details?.task_id;
  if (typeof taskId !== 'string') throw new Error('Background bash returned no task id');
  return taskId;
}

/**
 * Starts a background bash the way a tool call that is ALREADY past its entry
 * signal check behaves: `startBackgroundLocalBash` only tests `signal.aborted`
 * once, on entry (bash-runner.ts:92), and inserts the durable row several awaits
 * later. A stop that lands inside that window still produces a live task row.
 */
async function startBackgroundBashPastSignalCheck(
  input: ScriptedTurnInput,
  command: string,
): Promise<string> {
  const result = await tool(input, 'bash').impl.execute(input.toolConfig.context, {
    command,
    run_in_background: true,
  });
  const taskId = result.details?.task_id;
  if (typeof taskId !== 'string') throw new Error('Late background bash returned no task id');
  return taskId;
}

async function startBackgroundSubagent(input: ScriptedTurnInput, prompt: string): Promise<string> {
  const result = await tool(input, 'task').impl.execute(
    input.toolConfig.context,
    {
      agent_name: 'worker',
      description: 'Long running child',
      prompt,
      run_in_background: true,
    },
    input.signal,
  );
  const taskId = result.details?.task_id;
  if (typeof taskId !== 'string') throw new Error('Background subagent returned no task id');
  return taskId;
}

/** Blocks until aborted; models a child Turn that keeps running on its own. */
function awaitAbort(input: ScriptedTurnInput): Promise<void> {
  const signal = input.signal;
  if (!signal) throw new Error('Production child Turn omitted the AbortSignal');
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

let host: CreatedLocalRuntimeHost | undefined;
let dataDir: string | undefined;
const HOST_TEST_TIMEOUT_MS = 150_000;

afterEach(async () => {
  await host?.apiHost.close().catch(() => undefined);
  await host?.metricsClient.close().catch(() => undefined);
  if (dataDir) {
    closeLocalRuntimeDb(dataDir);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  host = undefined;
  dataDir = undefined;
  harness.scripts = [];
  harness.invocations = 0;
  harness.startedTurns = [];
  harness.observedContexts = [];
  harness.injectedMessages = [];
});

describe('session stop cascade over the production V2 host', () => {
  it(
    'A: stops background bash and subagent, never wakes the Session, and reports them on the next turn',
    async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'stop-cascade-a-'));
      await mkdir(join(dataDir, 'workspace'), { recursive: true });
      host = await createHost(dataDir);
      const conversation = host.apiHost.runtimeConversation!;

      const pidFile = join(dataDir, 'bash.pid');
      const bashTaskId = deferred<string>();
      const subagentTaskId = deferred<string>();

      harness.scripts = [
        // Turn 1 (owner): start a long bash plus a background subagent.
        async (input) => {
          const bashId = await startBackgroundBash(
            input,
            `echo $$ > ${JSON.stringify(pidFile)}; sleep 600`,
          );
          bashTaskId.resolve(bashId);
          subagentTaskId.resolve(await startBackgroundSubagent(input, 'Run until stopped'));
        },
        // Turn 2 (child Session): stays alive until the cascade aborts it.
        async (input) => {
          await awaitAbort(input);
        },
      ];

      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir, 'workspace'),
        sessionType: 'root',
      });
      const firstTurn = await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'Start long background work', attachments: [] },
      });
      await firstTurn.completion;
      const bashId = await bashTaskId.promise;
      const subagentId = await subagentTaskId.promise;

      // The bash task must own a real, live OS process before we stop it.
      const pid = await vi.waitFor(() => readPidFile(pidFile), {
        timeout: 20_000,
        interval: 100,
      });
      expect(isProcessAlive(pid)).toBe(true);

      const turnsBeforeStop = harness.startedTurns.length;

      // Desktop Stop button entry: the same abort sink every stop funnels into.
      const stopStartedAt = Date.now();
      await conversation.ingress.abort(owner.sessionId, 'user_stop');
      const stopDurationMs = Date.now() - stopStartedAt;
      // The stop response must not wait for background teardown.
      expect(stopDurationMs).toBeLessThan(5_000);

      await expectTasksCanceled(host, [bashId, subagentId]);
      await vi.waitFor(() => expect(isProcessAlive(pid)).toBe(false), {
        timeout: 15_000,
        interval: 100,
      });

      // Wait out the delivery retry window (1s/2s/5s). Nothing may wake the Session.
      await new Promise((resolve) => setTimeout(resolve, 9_000));
      expect(harness.startedTurns.length).toBe(turnsBeforeStop);
      expect(
        harness.startedTurns.filter((turn) => turn.turnId.startsWith('turn_task_delivery')),
      ).toEqual([]);

      // The user's next message: the model is told both tasks are canceled.
      const secondTurn = await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'What happened to the background work?', attachments: [] },
      });
      // Assert on what the model is actually handed, not on Turn completion: the
      // reminder is produced by the before-LLM hooks when the request is built.
      const reminder = await vi.waitFor(
        () => {
          const found = harness.injectedMessages
            .map((entry) => entry.content)
            .find((content) => content.includes('<background-task-completion-reminder>'));
          expect(found, 'next turn must carry the background completion reminder').toBeDefined();
          return found!;
        },
        { timeout: 30_000, interval: 100 },
      );
      void secondTurn.completion.catch(() => undefined);
      // Evidence for the report: this is verbatim what the model receives.
      console.log(`REMINDER_EVIDENCE_BEGIN\n${reminder}\nREMINDER_EVIDENCE_END`);
      expect(reminder).toContain('<background-task-completion-reminder>');
      for (const taskId of [bashId, subagentId]) {
        expect(reminder).toContain(taskId);
      }
      // Both are reported with their real terminal status.
      expect(reminder).toContain('"status":"canceled"');
    },
    HOST_TEST_TIMEOUT_MS,
  );
});

describe('session stop cascade boundary', () => {
  it(
    'A2: stops a task the dying Turn created while the abort was still settling',
    async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'stop-cascade-a2-'));
      await mkdir(join(dataDir, 'workspace'), { recursive: true });
      host = await createHost(dataDir);
      const conversation = host.apiHost.runtimeConversation!;

      const lateTaskId = deferred<string>();
      const turnRunning = deferred<void>();

      harness.scripts = [
        async (input) => {
          // Stay alive until the stop signals, then insert one more background
          // row before releasing — the Turn is aborting but has not released yet.
          turnRunning.resolve();
          await awaitAbort(input);
          lateTaskId.resolve(await startBackgroundBashPastSignalCheck(input, 'sleep 600'));
        },
      ];

      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir, 'workspace'),
        sessionType: 'root',
      });
      const running = await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'Work until I stop you', attachments: [] },
      });

      // The Turn must really be executing before the stop, otherwise it is
      // cancelled pre-admission and never reaches the tool call we are testing.
      await turnRunning.promise;
      await conversation.ingress.abort(owner.sessionId, 'user_stop');
      await running.completion.catch(() => undefined);

      const lateId = await lateTaskId.promise;

      // The row was created after the stop was accepted, so an implementation
      // that froze the boundary at `begin` would leave it running and let its
      // terminal wake the Session later. Process teardown itself is covered by A.
      await expectTasksCanceled(host, [lateId]);

      const turnsBefore = harness.startedTurns.length;
      await new Promise((resolve) => setTimeout(resolve, 8_500));
      expect(harness.startedTurns.length).toBe(turnsBefore);
      expect(
        harness.startedTurns.filter((turn) => turn.turnId.startsWith('turn_task_delivery')),
      ).toEqual([]);

      await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'And the background work?', attachments: [] },
      });
      const reminder = await vi.waitFor(
        () => {
          const found = harness.injectedMessages
            .map((entry) => entry.content)
            .find((content) => content.includes('<background-task-completion-reminder>'));
          expect(found, 'the late task must be reported to the model').toBeDefined();
          return found!;
        },
        { timeout: 30_000, interval: 100 },
      );
      expect(reminder).toContain(lateId);
      expect(reminder).toContain('"status":"canceled"');
    },
    HOST_TEST_TIMEOUT_MS,
  );
});

describe('session stop cascade identity', () => {
  it(
    'F1: a stop naming an older Turn is rejected and leaves the newer Turn background work alone',
    async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'stop-cascade-f1-'));
      await mkdir(join(dataDir, 'workspace'), { recursive: true });
      host = await createHost(dataDir);
      const conversation = host.apiHost.runtimeConversation!;

      const pidFile = join(dataDir, 'turn-b.pid');
      const bashTaskId = deferred<string>();
      harness.scripts = [
        // Turn A: finishes immediately. Its id is what a stale client still shows.
        async () => undefined,
        // Turn B: starts real background work and keeps running.
        async (input) => {
          bashTaskId.resolve(
            await startBackgroundBash(input, `echo $$ > ${JSON.stringify(pidFile)}; sleep 600`),
          );
          await awaitAbort(input);
        },
      ];

      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir, 'workspace'),
        sessionType: 'root',
      });
      await (
        await conversation.ingress.submit({
          sessionId: owner.sessionId,
          source: 'api',
          allowQueue: false,
          message: { content: 'First turn', attachments: [] },
        })
      ).completion;
      const turnA = harness.startedTurns[0]!.turnId;
      const running = await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'Second turn with background work', attachments: [] },
      });
      const bashId = await bashTaskId.promise;
      const turnB = harness.startedTurns[1]!.turnId;
      const pid = await vi.waitFor(() => readPidFile(pidFile), { timeout: 20_000, interval: 100 });

      // Stale stop: rejected by identity (false == turn-mismatch on this seam).
      await expect(conversation.ingress.abort(owner.sessionId, 'user_stop', turnA)).resolves.toBe(
        false,
      );
      // Give a (wrong) cascade ample time to act before asserting it did not.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(isProcessAlive(pid)).toBe(true);
      await expect(host.apiHost.backgroundTaskService.get(bashId)).resolves.toMatchObject({
        status: 'running',
      });

      // Stopping the Turn that is actually running cascades as usual.
      await conversation.ingress.abort(owner.sessionId, 'user_stop', turnB);
      await running.completion.catch(() => undefined);
      await expectTasksCanceled(host, [bashId]);
      await vi.waitFor(() => expect(isProcessAlive(pid)).toBe(false), {
        timeout: 15_000,
        interval: 100,
      });
    },
    HOST_TEST_TIMEOUT_MS,
  );
});

describe('session stop cascade must not change unrelated behaviour', () => {
  it(
    'B: without a stop, a finished background bash still wakes the Session',
    async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'stop-cascade-b-'));
      await mkdir(join(dataDir, 'workspace'), { recursive: true });
      host = await createHost(dataDir);
      const conversation = host.apiHost.runtimeConversation!;
      const bashTaskId = deferred<string>();

      harness.scripts = [
        async (input) => {
          bashTaskId.resolve(await startBackgroundBash(input, 'echo finished-normally'));
        },
      ];

      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir, 'workspace'),
        sessionType: 'root',
      });
      const firstTurn = await conversation.ingress.submit({
        sessionId: owner.sessionId,
        source: 'api',
        allowQueue: false,
        message: { content: 'Run a quick background command', attachments: [] },
      });
      await firstTurn.completion;
      const bashId = await bashTaskId.promise;

      // Delivery starts its own Turn and tells the model the task finished.
      await vi.waitFor(
        () => {
          const deliveryTurn = harness.startedTurns.find((turn) =>
            turn.turnId.startsWith('turn_task_delivery'),
          );
          expect(deliveryTurn).toBeDefined();
        },
        { timeout: 20_000, interval: 100 },
      );
      // The task finished on its own and stayed unread, which is what makes the
      // delivery Turn above a genuine wake-up rather than a cascade side effect.
      await expect(host.apiHost.backgroundTaskService.get(bashId)).resolves.toMatchObject({
        status: 'succeeded',
      });
    },
    HOST_TEST_TIMEOUT_MS,
  );

  it(
    'C: work started after a stop is delivered normally again',
    async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'stop-cascade-c-'));
      await mkdir(join(dataDir, 'workspace'), { recursive: true });
      host = await createHost(dataDir);
      const conversation = host.apiHost.runtimeConversation!;
      const stoppedId = deferred<string>();
      const freshId = deferred<string>();

      harness.scripts = [
        async (input) => {
          stoppedId.resolve(await startBackgroundBash(input, 'sleep 600'));
        },
        async (input) => {
          freshId.resolve(await startBackgroundBash(input, 'echo after-stop'));
        },
      ];

      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir, 'workspace'),
        sessionType: 'root',
      });
      await (
        await conversation.ingress.submit({
          sessionId: owner.sessionId,
          source: 'api',
          allowQueue: false,
          message: { content: 'Start slow work', attachments: [] },
        })
      ).completion;
      const slowId = await stoppedId.promise;

      await conversation.ingress.abort(owner.sessionId, 'user_stop');
      await vi.waitFor(
        async () => {
          await expect(host!.apiHost.backgroundTaskService.get(slowId)).resolves.toMatchObject({
            status: 'canceled',
          });
        },
        { timeout: 20_000, interval: 100 },
      );

      await (
        await conversation.ingress.submit({
          sessionId: owner.sessionId,
          source: 'api',
          allowQueue: false,
          message: { content: 'Now run something new', attachments: [] },
        })
      ).completion;
      const newId = await freshId.promise;

      // The suppression is per task, not per Session: new work notifies again.
      await vi.waitFor(
        () => {
          const deliveryTurn = harness.startedTurns.find((turn) =>
            turn.turnId.startsWith('turn_task_delivery'),
          );
          expect(deliveryTurn).toBeDefined();
        },
        { timeout: 20_000, interval: 100 },
      );
      // The fresh task completed and woke the Session; the stopped one stayed
      // suppressed and unread, so only new work can have caused that wake-up.
      await expect(host.apiHost.backgroundTaskService.get(newId)).resolves.toMatchObject({
        status: 'succeeded',
      });
      const stopped = await host.apiHost.backgroundTaskService.get(slowId);
      expect(stopped?.status).toBe('canceled');
      expect(stopped?.deliveredAt).toBeUndefined();
    },
    HOST_TEST_TIMEOUT_MS,
  );
});

describe('session stop cascade scope', () => {
  it(
    'D: leaving the conversation (session_leave) does not cascade',
    async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'stop-cascade-d-'));
      await mkdir(join(dataDir, 'workspace'), { recursive: true });
      host = await createHost(dataDir);
      const conversation = host.apiHost.runtimeConversation!;
      const bashTaskId = deferred<string>();

      harness.scripts = [
        async (input) => {
          bashTaskId.resolve(await startBackgroundBash(input, 'echo leave-keeps-running'));
        },
      ];

      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir, 'workspace'),
        sessionType: 'root',
      });
      await (
        await conversation.ingress.submit({
          sessionId: owner.sessionId,
          source: 'api',
          allowQueue: false,
          message: { content: 'Start background work', attachments: [] },
        })
      ).completion;
      const bashId = await bashTaskId.promise;

      await conversation.ingress.abort(owner.sessionId, 'session_leave');

      // Not a stop: the task runs to its own completion and still notifies.
      await vi.waitFor(
        async () => {
          await expect(host!.apiHost.backgroundTaskService.get(bashId)).resolves.toMatchObject({
            status: 'succeeded',
          });
        },
        { timeout: 20_000, interval: 100 },
      );
      await vi.waitFor(
        () => {
          const deliveryTurn = harness.startedTurns.find((turn) =>
            turn.turnId.startsWith('turn_task_delivery'),
          );
          expect(deliveryTurn).toBeDefined();
        },
        { timeout: 20_000, interval: 100 },
      );
    },
    HOST_TEST_TIMEOUT_MS,
  );

  it(
    'E: stopping only the child Session leaves the owner Session background work alone',
    async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'stop-cascade-e-'));
      await mkdir(join(dataDir, 'workspace'), { recursive: true });
      host = await createHost(dataDir);
      const conversation = host.apiHost.runtimeConversation!;
      const bashTaskId = deferred<string>();
      const subagentTaskId = deferred<string>();

      harness.scripts = [
        async (input) => {
          bashTaskId.resolve(await startBackgroundBash(input, 'echo owner-task-survives'));
          subagentTaskId.resolve(await startBackgroundSubagent(input, 'Run until stopped'));
        },
        async (input) => {
          await awaitAbort(input);
        },
      ];

      const owner = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(dataDir, 'workspace'),
        sessionType: 'root',
      });
      await (
        await conversation.ingress.submit({
          sessionId: owner.sessionId,
          source: 'api',
          allowQueue: false,
          message: { content: 'Start a child and a bash', attachments: [] },
        })
      ).completion;
      const bashId = await bashTaskId.promise;
      const subagentId = await subagentTaskId.promise;

      const subagentTask = await host.apiHost.backgroundTaskService.get(subagentId);
      const childSessionId = subagentTask?.metadata?.['childSessionId'];
      expect(typeof childSessionId).toBe('string');

      // A stop aimed at the child Session must not cascade into the owner.
      await conversation.ingress.abort(String(childSessionId), 'user_stop');

      await vi.waitFor(
        async () => {
          await expect(host!.apiHost.backgroundTaskService.get(bashId)).resolves.toMatchObject({
            status: 'succeeded',
          });
        },
        { timeout: 20_000, interval: 100 },
      );
    },
    HOST_TEST_TIMEOUT_MS,
  );
});

/**
 * The runtime records no child pid, so the command publishes its own shell pid.
 * That is the process group the cascade must actually kill.
 */
async function readPidFile(path: string): Promise<number> {
  const raw = await readFile(path, 'utf8');
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Unusable pid file: ${raw}`);
  return pid;
}

/** Both cascade targets must reach a real terminal state, not just be requested. */
async function expectTasksCanceled(
  liveHost: CreatedLocalRuntimeHost,
  taskIds: readonly string[],
): Promise<void> {
  await vi.waitFor(
    async () => {
      for (const taskId of taskIds) {
        await expect(liveHost.apiHost.backgroundTaskService.get(taskId)).resolves.toMatchObject({
          status: 'canceled',
        });
      }
    },
    { timeout: 20_000, interval: 100 },
  );
}

function createHost(hostDataDir: string): Promise<CreatedLocalRuntimeHost> {
  const config = {
    dataDir: hostDataDir,
    defaultModel: 'test/model',
    provider: {
      test: {
        options: { apiKey: 'test-key', baseURL: 'https://provider.test/v1' },
        models: {
          model: { modalities: { input: ['text'], output: ['text'] } },
        },
      },
    },
  } as LocalRuntimeConfig;
  return createLocalRuntimeHostV2ForTest({
    dataDir: hostDataDir,
    runtimeOwnerKind: 'cli',
    capabilities: { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(hostDataDir, 'workspace'),
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
