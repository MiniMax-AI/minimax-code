import { describe, expect, it, vi } from 'vitest';
import type { SendMessageReq } from '@mavis/local-runtime-v2/cli-service';
import { TuiFailure } from '../../src/failure.js';
import {
  TuiChatController as ProductionTuiChatController,
  type CreateTuiChatControllerOptions,
} from '../../src/tui/controller/chat-controller.js';
import type { TuiStreamEvent } from '../../src/runtime/stream-events.js';
import { TranscriptStore } from '../../src/tui/transcript/store.js';
import { TranscriptView } from '../../src/tui/transcript/view.js';
import { TuiRunCoordinator, type TuiRunRuntime } from '../../src/application/run-coordinator.js';
import { resolveTuiVisiblePresentation } from '../../src/tui/controller/projection/visible-presentation.js';
import { TuiActivityLine } from '../../src/tui/shell/activity-line.js';
import { isQuestionnaireTool } from '../../src/tui/controller/projection/turn-tool-projection.js';

class TuiChatController extends ProductionTuiChatController {
  constructor(options: CreateTuiChatControllerOptions) {
    super(options);
  }
}

describe('TuiChatController', () => {
  it('hides plain and namespaced AskUser protocol tools from the transcript', () => {
    expect(isQuestionnaireTool('ask_user')).toBe(true);
    expect(isQuestionnaireTool('functions.AskUser')).toBe(true);
    expect(isQuestionnaireTool('tools.ask_user_question')).toBe(true);
    expect(isQuestionnaireTool('read_file')).toBe(false);
  });

  it('shows estimated output throughput while a text response is still streaming', async () => {
    let nowMs = 0;
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-live-output-rate' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield {
          type: 'delta',
          turnId: 'turn-live-output-rate',
          messageId: 'message-live-output-rate',
          content: 'hello',
          timestamp: 1_000,
        };
        nowMs = 250;
        yield {
          type: 'delta',
          turnId: 'turn-live-output-rate',
          messageId: 'message-live-output-rate',
          content: ' world',
          timestamp: 2_000,
        };
        await responseGate;
        yield {
          type: 'delta',
          turnId: 'turn-live-output-rate',
          messageId: 'message-live-output-rate',
          finish: true,
          timestamp: 3_000,
        };
        yield {
          type: 'message',
          message: {
            id: 'message-live-output-rate',
            turnId: 'turn-live-output-rate',
            role: 'assistant',
            content: 'hello world',
            usage: { outputTokens: 126, requestDurationMs: 2_000 },
          },
        };
        yield { type: 'done', turnId: 'turn-live-output-rate' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new ProductionTuiChatController({
      runtime: runtime as never,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-live-output-rate',
      now: () => nowMs,
    });

    const submission = controller.submit('Say hello');
    await vi.waitFor(() =>
      expect(controller.snapshot()).toMatchObject({
        activeTurnId: 'turn-live-output-rate',
        outputTokensPerSecond: 2,
        outputTokensPerSecondEstimated: true,
      }),
    );
    const snapshot = controller.snapshot();
    const presentation = resolveTuiVisiblePresentation({
      snapshot,
      connection: { phase: 'live', generation: 1 },
      surface: 'conversation',
      currentLiveRunId: snapshot.activeTurnId,
      transcript,
      runtimeQueuedCount: 0,
      queueEnabled: true,
      activePermission: false,
      activeQuestionnaire: false,
      compacting: false,
      attachmentCount: 0,
      version: 'test',
      workspace: '/workspace',
    });
    const line = new TuiActivityLine(presentation.activity, { animate: false });
    expect(line.render(120).join('\n')).toContain('⚡ ~2.0 tok/s');

    releaseResponse?.();
    await submission;
  });

  it('keeps provider-calibrated output throughput visible after a text-only turn settles', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-output-rate' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield {
          type: 'delta',
          turnId: 'turn-output-rate',
          messageId: 'message-output-rate',
          content: 'hello',
          timestamp: 1_000,
        };
        yield {
          type: 'delta',
          turnId: 'turn-output-rate',
          messageId: 'message-output-rate',
          finish: true,
          timestamp: 3_000,
        };
        yield {
          type: 'message',
          message: {
            id: 'message-output-rate',
            turnId: 'turn-output-rate',
            role: 'assistant',
            content: 'hello',
            usage: { outputTokens: 126, requestDurationMs: 2_000 },
          },
        };
        yield { type: 'done', turnId: 'turn-output-rate' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new ProductionTuiChatController({
      runtime: runtime as never,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-output-rate',
    });

    await controller.submit('Say hello');

    const view = new TranscriptView(() => transcript.snapshot());
    expect(view.render(80).join('\n')).toContain('⚡ 63.0 tok/s');
  });

  it('accumulates provider output throughput for one turn and resets it for the next', () => {
    const controller = new ProductionTuiChatController({
      runtime: {} as never,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
    });

    controller.beginRuntimeTurn('turn-1', 500);
    controller.applyRuntimeTurnEvent('turn-1', {
      type: 'delta',
      turnId: 'turn-1',
      messageId: 'message-1',
      content: 'first chunk',
      timestamp: 1_000,
    });
    controller.applyRuntimeTurnEvent('turn-1', {
      type: 'delta',
      turnId: 'turn-1',
      messageId: 'message-1',
      finish: true,
      timestamp: 3_000,
    });
    controller.applyRuntimeTurnEvent('turn-1', {
      type: 'message',
      message: {
        id: 'message-1',
        turnId: 'turn-1',
        role: 'assistant',
        usage: { outputTokens: 126, requestDurationMs: 2_000 },
      },
    });

    expect(controller.snapshot().outputTokensPerSecond).toBe(63);

    controller.beginRuntimeTurn('turn-2', 4_000);
    expect(controller.snapshot().outputTokensPerSecond).toBeUndefined();
  });

  it('publishes one state change when a stream event updates throughput and Transcript', () => {
    let nowMs = 0;
    const onChange = vi.fn();
    const controller = new ProductionTuiChatController({
      runtime: {} as never,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      onChange,
      now: () => nowMs,
    });
    controller.beginRuntimeTurn('turn-batched', 500);
    controller.applyRuntimeTurnEvent('turn-batched', {
      type: 'delta',
      turnId: 'turn-batched',
      messageId: 'message-batched',
      content: 'first chunk',
      timestamp: 1_000,
    });
    onChange.mockClear();
    nowMs = 250;

    controller.applyRuntimeTurnEvent('turn-batched', {
      type: 'delta',
      turnId: 'turn-batched',
      messageId: 'message-batched',
      content: 'second chunk',
      timestamp: 2_000,
    });

    expect(controller.snapshot().outputTokensPerSecond).toBeGreaterThan(0);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('projects a pending user message before the login preflight settles', async () => {
    let resolveAccount:
      | ((account: { status: 'ready'; managedTokenPresent: true; warnings: never[] }) => void)
      | undefined;
    const runtime = {
      getAccountStatus: vi.fn(
        () =>
          new Promise<{
            status: 'ready';
            managedTokenPresent: true;
            warnings: never[];
          }>((resolve) => {
            resolveAccount = resolve;
          }),
      ),
      createSession: vi.fn(async () => ({
        sessionId: 'session-optimistic',
        workspaceDir: '/workspace',
      })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'done', turnId: 'turn-optimistic' };
      }),
      abortSession: vi.fn(async () => true),
      steer: vi.fn(),
    };
    const transcript = new TranscriptStore();
    const onUserSubmissionProjected = vi.fn();
    const controller = new ProductionTuiChatController({
      runtime: runtime as never,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-optimistic',
      now: () => 100,
      onUserSubmissionProjected,
    });

    transcript.upsert({
      id: 'turn-duration:previous-turn',
      kind: 'turn-duration',
      status: 'cancelled',
      content: '',
      durationMs: 12_000,
      turnId: 'previous-turn',
      ephemeral: true,
      createdAtMs: 80,
      updatedAtMs: 80,
    });
    const view = new TranscriptView(transcript);
    expect(view.render(80).join('\n')).toContain('Interrupted after 12s');
    controller.projectOptimisticUserMessage('submission-1', 'Show this immediately', 90);
    expect(view.render(80).join('\n')).not.toContain('Interrupted after 12s');
    expect(transcript.get('turn-duration:previous-turn')).toBeUndefined();
    const sending = controller.submit('Show this immediately', {
      optimisticRequestId: 'submission-1',
    });

    expect(transcript.get('user:turn-optimistic')).toMatchObject({
      kind: 'user',
      status: 'pending',
      content: 'Show this immediately',
      createdAtMs: 90,
    });
    expect(transcript.get('optimistic:user:submission-1')).toBeUndefined();
    expect(transcript.snapshot().filter((cell) => cell.kind === 'user')).toHaveLength(1);
    expect(view.render(80).join('\n')).not.toContain('Interrupted after 12s');
    expect(transcript.get('turn-duration:previous-turn')).toBeUndefined();
    expect(onUserSubmissionProjected).toHaveBeenCalledOnce();
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    resolveAccount?.({ status: 'ready', managedTokenPresent: true, warnings: [] });
    await expect(sending).resolves.toBe('succeeded');
  });

  it('keeps the previous duration while projecting a steer for the current turn', () => {
    const transcript = new TranscriptStore();
    transcript.upsert({
      id: 'turn-duration:previous-turn',
      kind: 'turn-duration',
      status: 'cancelled',
      content: '',
      durationMs: 12_000,
      turnId: 'previous-turn',
      ephemeral: true,
      createdAtMs: 80,
      updatedAtMs: 80,
    });
    const controller = new ProductionTuiChatController({
      runtime: {} as never,
      transcript,
      workspaceDir: '/workspace',
    });

    controller.projectOptimisticUserMessage('steer-1', 'Continue this turn', 90, [], 'pending-steer');

    expect(transcript.get('turn-duration:previous-turn')).toBeDefined();
  });

  it('detaches the foreground observer when switching Sessions without aborting the Runtime turn', async () => {
    let releaseTurn: (() => void) | undefined;
    const runtime = {
      createSession: vi.fn(),
      getSession: vi.fn(async (sessionId: string) => ({
        sessionId,
        workspaceDir: '/workspace',
      })),
      getMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        yield { type: 'delta', text: 'late answer from A' };
        yield { type: 'done' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-a',
      now: () => 100,
    });
    await controller.loadSessionProjection('session-a');
    const running = controller.submit('keep running in A');
    await vi.waitFor(() => expect(releaseTurn).toBeTypeOf('function'));

    await controller.loadSessionProjection('session-b');

    expect(runtime.abortSession).not.toHaveBeenCalled();
    expect(controller.snapshot().session?.sessionId).toBe('session-b');
    releaseTurn?.();
    await expect(running).resolves.toBe('succeeded');
    expect(controller.snapshot().session?.sessionId).toBe('session-b');
    expect(transcript.snapshot().some((cell) => cell.content.includes('late answer from A'))).toBe(
      false,
    );
  });

  it('requires MiniMax login before starting a managed-model Turn', async () => {
    const runtime = {
      getAccountStatus: vi.fn(async () => ({
        status: 'needs-login' as const,
        authMode: 'managed-login',
        modelSource: 'token-plan' as const,
        managedTokenPresent: false,
        warnings: [],
      })),
      createSession: vi.fn(async () => ({
        sessionId: 'session-login-required',
        workspaceDir: '/workspace',
      })),
      sendMessage: vi.fn(),
      abortSession: vi.fn(async () => true),
      steer: vi.fn(),
    };
    const transcript = new TranscriptStore();
    const controller = new ProductionTuiChatController({
      runtime: runtime as never,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-login-required',
      now: () => 100,
    });

    await expect(controller.submit('Do not send this yet')).rejects.toMatchObject({
      name: 'TuiLoginRequiredError',
      code: 'auth.login_required',
    });

    expect(runtime.getAccountStatus).toHaveBeenCalledWith(undefined, undefined);
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(transcript.snapshot()).toEqual([]);
    expect(controller.snapshot()).toMatchObject({
      status: 'idle',
      activeTurnId: undefined,
      account: { managedTokenPresent: false },
    });
  });

  it('defers owner history reconciliation until the active Turn has settled', async () => {
    let releaseTurn: (() => void) | undefined;
    const runtime = {
      createSession: vi.fn(async () => ({
        sessionId: 'session-history-deferred',
        workspaceDir: '/workspace',
      })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        yield { type: 'done', turnId: 'turn-history-deferred' };
      }),
      abortSession: vi.fn(async () => true),
      getSession: vi.fn(async () => ({
        sessionId: 'session-history-deferred',
        workspaceDir: '/workspace',
      })),
      getMessages: vi.fn(async () => []),
    };
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-history-deferred',
      now: () => 100,
    });

    const submission = controller.submit('Keep the Turn active');
    await vi.waitFor(() =>
      expect(controller.snapshot().activeTurnId).toBe('turn-history-deferred'),
    );
    await vi.waitFor(() => expect(releaseTurn).toBeTypeOf('function'));

    await expect(controller.reconcileOwnerHistory(false)).resolves.toBe(false);
    expect(runtime.getMessages).not.toHaveBeenCalled();

    releaseTurn?.();
    await submission;

    await vi.waitFor(() =>
      expect(runtime.getMessages).toHaveBeenCalledWith('session-history-deferred'),
    );
  });

  it('shares in-flight session creation with runtime-owned follow-up submission', async () => {
    let resolveSession: ((session: { sessionId: string }) => void) | undefined;
    const runtime = {
      createSession: vi.fn(
        () =>
          new Promise<{ sessionId: string }>((resolve) => {
            resolveSession = resolve;
          }),
      ),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'done' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
    });

    const submitting = controller.submit('First turn');
    await vi.waitFor(() => expect(resolveSession).toBeTypeOf('function'));
    const waitingForSession = controller.waitForCurrentSession();
    resolveSession?.({ sessionId: 'session-1' });

    await expect(waitingForSession).resolves.toEqual({ sessionId: 'session-1' });
    await submitting;
    expect(runtime.createSession).toHaveBeenCalledTimes(1);
  });

  it('creates a session lazily and updates one assistant cell in place while streaming', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({
        sessionId: 'session-1',
        title: 'New session',
        workspaceDir: '/workspace',
      })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'delta', turnId: 'turn-1', role: 'assistant', content: 'Hel' };
        yield { type: 'delta', turnId: 'turn-1', role: 'assistant', content: 'lo' };
        yield { type: 'done', turnId: 'turn-1' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-1',
      now: (() => {
        let value = 100;
        return () => value++;
      })(),
    });

    await controller.submit('  Say hello  ');

    expect(runtime.createSession).toHaveBeenCalledWith({ workspaceDir: '/workspace' });
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      { id: 'session-1', content: 'Say hello', turnId: 'turn-1' },
      expect.any(AbortSignal),
    );
    expect(transcript.snapshot()).toEqual([
      expect.objectContaining({
        id: 'user:turn-1',
        kind: 'user',
        status: 'succeeded',
        content: 'Say hello',
      }),
      expect.objectContaining({
        id: 'assistant:turn-1',
        kind: 'assistant',
        status: 'succeeded',
        content: 'Hello',
      }),
      expect.objectContaining({
        id: 'turn-duration:turn-1',
        kind: 'turn-duration',
        status: 'succeeded',
      }),
    ]);
    expect(controller.snapshot()).toMatchObject({
      status: 'idle',
      session: { sessionId: 'session-1' },
    });
  });

  it('refreshes the authoritative interaction mode after an accepted direct Turn', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({
        sessionId: 'session-plan-sync',
        workspaceDir: '/workspace',
      })),
      getSession: vi.fn(async () => ({
        sessionId: 'session-plan-sync',
        workspaceDir: '/workspace',
        interactionMode: 'plan' as const,
      })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'done', turnId: 'turn-plan-sync' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-plan-sync',
    });

    await expect(controller.submit('Let the Agent decide whether to plan')).resolves.toBe(
      'succeeded',
    );

    expect(runtime.getSession).toHaveBeenCalledWith('session-plan-sync');
    expect(controller.snapshot().session?.interactionMode).toBe('plan');
  });

  it('records content review rewind as failed even after assistant output', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-blocked' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield {
          type: 'message',
          message: {
            id: 'message-before-block',
            turnId: 'turn-blocked',
            role: 'assistant',
            content: 'Partial response before the block.',
          },
        };
        yield {
          type: 'generic',
          eventType: 'messages-rewound',
          data: {},
        } as TuiStreamEvent;
      }),
      abortSession: vi.fn(async () => true),
    };
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-blocked',
    });

    await expect(controller.submit('Stop for input')).resolves.toBe('failed');
    expect(controller.snapshot().lastSettledTurn).toEqual({
      sessionId: 'session-blocked',
      turnId: 'turn-blocked',
      status: 'failed',
    });
  });

  it('records every Runtime-owned terminal outcome against its current Session', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-runtime-owned' })),
    };
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
    });
    await controller.ensureSession();

    for (const [turnId, status] of [
      ['turn-runtime-done', 'succeeded'],
      ['turn-runtime-fail', 'failed'],
      ['turn-runtime-blocked', 'blocked'],
      ['turn-runtime-cancel', 'cancelled'],
    ] as const) {
      controller.beginRuntimeTurn(turnId, 0);
      await controller.runtimeTurnSettlement.settle('session-runtime-owned', turnId, status, 12);
      expect(controller.snapshot().lastSettledTurn).toEqual({
        sessionId: 'session-runtime-owned',
        turnId,
        status,
      });
    }

    await controller.runtimeTurnSettlement.settle('session-other', 'turn-foreign', 'succeeded', 12);
    expect(controller.snapshot().lastSettledTurn).toEqual({
      sessionId: 'session-runtime-owned',
      turnId: 'turn-runtime-cancel',
      status: 'cancelled',
    });
  });

  it('writes a Runtime-owned result before publishing its terminal outcome', async () => {
    const delivered = Promise.withResolvers<void>();
    const writeAutomationResult = vi.fn(async () => delivered.promise);
    const transcript = new TranscriptStore();
    transcript.upsert({
      id: 'assistant:turn-previous',
      kind: 'assistant',
      status: 'succeeded',
      content: 'Previous answer',
      turnId: 'turn-previous',
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const controller = new TuiChatController({
      runtime: {
        createSession: vi.fn(async () => ({ sessionId: 'session-runtime-result' })),
      },
      transcript,
      workspaceDir: '/workspace',
      writeAutomationResult,
    });
    await controller.ensureSession();
    controller.beginRuntimeTurn('turn-runtime-result', 10);
    controller.applyRuntimeTurnEvent('turn-runtime-result', {
      type: 'message',
      message: {
        id: 'message-runtime-result',
        turnId: 'turn-runtime-result',
        role: 'assistant',
        content: 'Runtime-owned answer',
      },
    });
    controller.runtimeTurnSettlement.settleProjection('turn-runtime-result', 'succeeded', 20);
    const settledTurn = controller.runtimeTurnSettlement.prepare(
      'session-runtime-result',
      'turn-runtime-result',
      'succeeded',
    );
    expect(settledTurn).toBeDefined();
    if (!settledTurn) throw new Error('Expected a Runtime-owned settled turn.');

    const publishing = controller.runtimeTurnSettlement.publish(settledTurn, 20);
    await vi.waitFor(() => expect(writeAutomationResult).toHaveBeenCalledOnce());
    expect(writeAutomationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-runtime-result',
        turnId: 'turn-runtime-result',
        status: 'succeeded',
        answer: 'Runtime-owned answer',
        durationMs: 20,
      }),
    );
    expect(controller.snapshot().lastSettledTurn).toBeUndefined();

    delivered.resolve();
    await publishing;
    expect(controller.snapshot().lastSettledTurn).toEqual({
      sessionId: 'session-runtime-result',
      turnId: 'turn-runtime-result',
      status: 'succeeded',
    });
  });

  it('fails a Runtime-owned automation turn that has no final assistant answer', async () => {
    const writeAutomationResult = vi.fn();
    const controller = new TuiChatController({
      runtime: {
        createSession: vi.fn(async () => ({ sessionId: 'session-runtime-empty' })),
      },
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      writeAutomationResult,
    });
    await controller.ensureSession();
    controller.beginRuntimeTurn('turn-runtime-empty', 10);
    controller.runtimeTurnSettlement.settleProjection('turn-runtime-empty', 'succeeded', 20);
    const settledTurn = controller.runtimeTurnSettlement.prepare(
      'session-runtime-empty',
      'turn-runtime-empty',
      'succeeded',
    );
    if (!settledTurn) throw new Error('Expected a Runtime-owned settled turn.');

    await controller.runtimeTurnSettlement.publish(settledTurn, 20);

    expect(writeAutomationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        answer: null,
        error: expect.objectContaining({ code: 'EMPTY_RESPONSE' }),
      }),
    );
    expect(controller.snapshot().lastSettledTurn).toEqual({
      sessionId: 'session-runtime-empty',
      turnId: 'turn-runtime-empty',
      status: 'failed',
    });
  });

  it('does not publish a terminal turn before the enabled automation result is written', async () => {
    const delivered = Promise.withResolvers<void>();
    const writeAutomationResult = vi.fn(async () => delivered.promise);
    const onAutomationResultPublished = vi.fn();
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-automation-result' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield {
          type: 'message',
          message: { role: 'assistant', content: 'structured answer' },
        };
        yield { type: 'done' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-automation-result',
      writeAutomationResult,
      onAutomationResultPublished,
    });

    const submission = controller.submit('Answer');
    await vi.waitFor(() => expect(writeAutomationResult).toHaveBeenCalledOnce());
    expect(onAutomationResultPublished).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      status: 'running',
      activeTurnId: 'turn-automation-result',
      lastSettledTurn: undefined,
    });

    delivered.resolve();
    await expect(submission).resolves.toBe('succeeded');
    expect(onAutomationResultPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-automation-result',
        turnId: 'turn-automation-result',
        status: 'succeeded',
      }),
    );
    expect(controller.snapshot().lastSettledTurn).toEqual({
      sessionId: 'session-automation-result',
      turnId: 'turn-automation-result',
      status: 'succeeded',
    });
  });

  it.each([
    ['local_session_busy', 'queue-required'],
    ['local_session_compacting', 'queue-required'],
    ['local_session_queue_paused', 'draft-kept'],
  ] as const)('does not publish unaccepted %s as a terminal result', async (code, status) => {
    const writeAutomationResult = vi.fn();
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-queue-fallback' })),
      sendMessage: vi.fn(async function* rejectedAdmission(): AsyncGenerator<TuiStreamEvent> {
        yield* [];
        throw new TuiFailure('runtime', 'Session is busy', {
          code,
          retryable: false,
        });
      }),
      abortSession: vi.fn(async () => true),
    };
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-queue-fallback',
      writeAutomationResult,
    });

    await expect(controller.submit('Queue this', { onQueuePaused: async () => 'cancel' })).resolves.toBe(status);
    expect(writeAutomationResult).not.toHaveBeenCalled();
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    expect(controller.snapshot().lastSettledTurn).toBeUndefined();
    expect(controller.snapshot()).toMatchObject({
      status: 'idle',
      activeTurnId: undefined,
      error: undefined,
    });
  });

  it('retains a rejected paused recovery instead of silently enqueuing the new instruction', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-recovery-race' })),
      sendMessage: vi.fn<TuiRunRuntime['sendMessage']>(async function* (_request, _signal, options) {
        yield* [];
        throw new TuiFailure('runtime', 'Admission rejected', {
          code: options ? 'local_session_busy' : 'local_session_queue_paused',
          retryable: false,
        });
      }),
      abortSession: vi.fn(async () => true),
    };
    const controller = new TuiChatController({ runtime, transcript: new TranscriptStore(), workspaceDir: '/workspace' });

    await expect(controller.submit('Enter Plan first', {
      clientIntent: 'plan-entry', onQueuePaused: async () => 'paused-queue-keep',
    })).resolves.toBe('failed');
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage.mock.calls[1]?.[0]).toMatchObject({ clientIntent: 'plan-entry' });
  });

  it('keeps submission serialized until authoritative Session metadata is refreshed', async () => {
    let resolveMetadata: ((session: { sessionId: string }) => void) | undefined;
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-metadata-fence' })),
      getSession: vi.fn(
        async () =>
          await new Promise<{ sessionId: string }>((resolve) => {
            resolveMetadata = resolve;
          }),
      ),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'done', turnId: 'turn-metadata-fence' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-metadata-fence',
    });

    const first = controller.submit('First');
    await vi.waitFor(() => expect(resolveMetadata).toBeTypeOf('function'));

    await expect(controller.submit('Second')).rejects.toThrow('already running');
    resolveMetadata?.({ sessionId: 'session-metadata-fence' });
    await expect(first).resolves.toBe('succeeded');
  });

  it('keeps pre-token waiting state out of the durable Transcript', async () => {
    let releaseFirstEvent: (() => void) | undefined;
    const firstEventGate = new Promise<void>((resolve) => {
      releaseFirstEvent = resolve;
    });
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-thinking-placeholder' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        await firstEventGate;
        yield {
          type: 'delta',
          turnId: 'turn-thinking-placeholder',
          content: 'Direct answer',
        };
        yield { type: 'done', turnId: 'turn-thinking-placeholder' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-thinking-placeholder',
      now: () => 100,
    });

    const submission = controller.submit('Answer directly');
    await vi.waitFor(() =>
      expect(transcript.snapshot()).toEqual([
        expect.objectContaining({ kind: 'user', content: 'Answer directly' }),
      ]),
    );

    releaseFirstEvent?.();
    await submission;

    expect(transcript.snapshot()).toEqual([
      expect.objectContaining({ kind: 'user', content: 'Answer directly' }),
      expect.objectContaining({
        id: 'assistant:turn-thinking-placeholder',
        kind: 'assistant',
        status: 'succeeded',
        content: 'Direct answer',
      }),
      expect.objectContaining({
        id: 'turn-duration:turn-thinking-placeholder',
        kind: 'turn-duration',
        status: 'succeeded',
      }),
    ]);
  });

  it('preserves thinking, preamble, tool, and final-answer chronology across one turn', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-segmented' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'delta', turnId: 'turn-segmented', thinking: 'Plan the inspection' };
        yield {
          type: 'delta',
          turnId: 'turn-segmented',
          messageId: 'message-preamble',
          content: 'I will inspect the workspace.',
        };
        yield {
          type: 'delta',
          turnId: 'turn-segmented',
          toolCalls: [
            {
              id: 'tool-read',
              name: 'read',
              status: 'running',
              input: { path: 'README.md' },
            },
          ],
        };
        yield {
          type: 'delta',
          turnId: 'turn-segmented',
          toolCalls: [
            {
              id: 'tool-read',
              name: 'read',
              status: 'completed',
              input: { path: 'README.md' },
              output: 'workspace details',
            },
          ],
        };
        yield { type: 'delta', turnId: 'turn-segmented', thinking: 'Interpret the result' };
        yield {
          type: 'delta',
          turnId: 'turn-segmented',
          messageId: 'message-final',
          content: 'Here is the conclusion.',
        };
        yield { type: 'done', turnId: 'turn-segmented' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-segmented',
      now: (() => {
        let value = 100;
        return () => value++;
      })(),
    });

    await controller.submit('Inspect');

    expect(transcript.snapshot()).toEqual([
      expect.objectContaining({
        id: 'user:turn-segmented',
        kind: 'user',
        content: 'Inspect',
      }),
      expect.objectContaining({
        id: 'thinking:turn-segmented',
        kind: 'thinking',
        status: 'succeeded',
        content: 'Plan the inspection',
      }),
      expect.objectContaining({
        id: 'assistant:turn-segmented',
        kind: 'assistant-preamble',
        status: 'succeeded',
        content: 'I will inspect the workspace.',
      }),
      expect.objectContaining({
        id: 'tool:turn-segmented:tool-read',
        kind: 'tool',
        status: 'succeeded',
        content: '{"path":"README.md"}',
        detail: 'workspace details',
      }),
      expect.objectContaining({
        id: 'thinking:turn-segmented:2',
        kind: 'thinking',
        status: 'succeeded',
        content: 'Interpret the result',
      }),
      expect.objectContaining({
        id: 'assistant:turn-segmented:2',
        kind: 'assistant',
        status: 'succeeded',
        content: 'Here is the conclusion.',
      }),
      expect.objectContaining({
        id: 'turn-duration:turn-segmented',
        kind: 'turn-duration',
        status: 'succeeded',
      }),
    ]);
  });

  it('does not reactivate an earlier preamble when its completed message arrives after a tool', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-delayed-completion' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield {
          type: 'delta',
          turnId: 'turn-delayed-completion',
          messageId: 'message-preamble',
          content: 'I will inspect this.',
        };
        yield {
          type: 'delta',
          turnId: 'turn-delayed-completion',
          toolCalls: [{ id: 'tool-read', name: 'read', status: 'completed' }],
        };
        yield {
          type: 'message',
          message: {
            id: 'message-preamble',
            turnId: 'turn-delayed-completion',
            role: 'assistant',
            content: 'I will inspect this.',
          },
        };
        yield {
          type: 'delta',
          turnId: 'turn-delayed-completion',
          messageId: 'message-final',
          content: 'The inspection is complete.',
        };
        yield { type: 'done', turnId: 'turn-delayed-completion' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-delayed-completion',
      now: () => 100,
    });

    await controller.submit('Inspect');

    expect(
      transcript
        .snapshot()
        .filter((cell) => cell.kind === 'assistant' || cell.kind === 'assistant-preamble'),
    ).toEqual([
      expect.objectContaining({
        id: 'assistant:turn-delayed-completion',
        kind: 'assistant-preamble',
        content: 'I will inspect this.',
      }),
      expect.objectContaining({
        id: 'assistant:turn-delayed-completion:2',
        kind: 'assistant',
        content: 'The inspection is complete.',
      }),
    ]);
  });

  it('uses authoritative Thinking duration from the completed message lifecycle', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-thinking-duration' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield {
          type: 'delta',
          turnId: 'turn-thinking-duration',
          messageId: 'message-1',
          thinking: 'Inspect carefully',
        };
        yield {
          type: 'message',
          message: {
            id: 'message-1',
            turnId: 'turn-thinking-duration',
            role: 'assistant',
            kind: 'final',
            thinking: 'Inspect carefully',
            thinkingDurationMs: 4_200,
            content: 'Done.',
          },
        };
        yield { type: 'done', turnId: 'turn-thinking-duration' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-thinking-duration',
      now: () => 100,
    });

    await controller.submit('Inspect');

    expect(transcript.get('thinking:turn-thinking-duration')).toMatchObject({
      status: 'succeeded',
      durationMs: 4_200,
      content: 'Inspect carefully',
    });
  });

  it('restores aggregate Thinking before text when its empty start placeholder was removed', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-late-thinking-snapshot' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield {
          type: 'delta',
          turnId: 'turn-late-thinking-snapshot',
          messageId: 'message-1',
          started: true,
        };
        yield {
          type: 'delta',
          turnId: 'turn-late-thinking-snapshot',
          messageId: 'message-1',
          content: 'Direct answer',
        };
        yield {
          type: 'message',
          message: {
            id: 'message-1',
            turnId: 'turn-late-thinking-snapshot',
            role: 'assistant',
            kind: 'final',
            thinking: 'Late aggregate snapshot',
            thinkingDurationMs: 900,
            content: 'Direct answer',
          },
        };
        yield { type: 'done', turnId: 'turn-late-thinking-snapshot' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-late-thinking-snapshot',
      now: () => 100,
    });

    await expect(controller.submit('Answer')).resolves.toBe('succeeded');
    expect(transcript.snapshot()).toEqual([
      expect.objectContaining({ kind: 'user' }),
      expect.objectContaining({
        kind: 'thinking',
        status: 'succeeded',
        content: 'Late aggregate snapshot',
        durationMs: 900,
      }),
      expect.objectContaining({ kind: 'assistant', content: 'Direct answer' }),
      expect.objectContaining({ kind: 'turn-duration', status: 'succeeded' }),
    ]);
  });

  it('opens a new ordered Thinking segment when a real delta follows direct text', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-late-thinking-delta' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield {
          type: 'delta',
          turnId: 'turn-late-thinking-delta',
          messageId: 'message-1',
          started: true,
        };
        yield {
          type: 'delta',
          turnId: 'turn-late-thinking-delta',
          messageId: 'message-1',
          content: 'First text',
        };
        yield {
          type: 'delta',
          turnId: 'turn-late-thinking-delta',
          messageId: 'message-1',
          thinking: 'Reconsider',
        };
        yield {
          type: 'delta',
          turnId: 'turn-late-thinking-delta',
          messageId: 'message-2',
          content: 'Final text',
        };
        yield { type: 'done', turnId: 'turn-late-thinking-delta' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-late-thinking-delta',
      now: () => 100,
    });

    await expect(controller.submit('Reconsider')).resolves.toBe('succeeded');
    expect(transcript.snapshot().map((cell) => cell.kind)).toEqual([
      'user',
      'assistant-preamble',
      'thinking',
      'assistant',
      'turn-duration',
    ]);
  });

  it('appends partial tool updates without duplicating cumulative snapshots', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-tool-progress' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield {
          type: 'delta',
          turnId: 'turn-tool-progress',
          toolCalls: [
            {
              id: 'tool-bash',
              name: 'bash',
              status: 'started',
              input: { command: 'pnpm test' },
            },
          ],
        };
        yield {
          type: 'delta',
          turnId: 'turn-tool-progress',
          toolCalls: [{ id: 'tool-bash', name: 'bash', status: 'running', output: 'first\n' }],
        };
        yield {
          type: 'delta',
          turnId: 'turn-tool-progress',
          toolCalls: [
            {
              id: 'tool-bash',
              name: 'bash',
              status: 'running',
              output: 'first\nsecond\n',
            },
          ],
        };
        yield {
          type: 'delta',
          turnId: 'turn-tool-progress',
          toolCalls: [
            {
              id: 'tool-bash',
              name: 'bash',
              status: 'completed',
              output: 'first\nsecond\npassed',
            },
          ],
        };
        yield { type: 'done', turnId: 'turn-tool-progress' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-tool-progress',
      now: () => 100,
    });

    await controller.submit('Test');

    expect(transcript.get('tool:turn-tool-progress:tool-bash')).toMatchObject({
      status: 'succeeded',
      content: '{"command":"pnpm test"}',
      detail: 'first\nsecond\npassed',
    });
  });

  it('places a final reply after tool activity when tool events arrive first', async () => {
    let releaseReply: (() => void) | undefined;
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-ordered' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield {
          type: 'delta',
          turnId: 'turn-ordered',
          thinking: 'Inspecting files',
          toolCalls: [
            {
              id: 'read-a',
              name: 'read',
              status: 'completed',
              input: { path: 'src/a.ts' },
            },
            {
              id: 'read-b',
              name: 'read',
              status: 'completed',
              input: { path: 'src/b.ts' },
            },
          ],
        };
        await new Promise<void>((resolve) => {
          releaseReply = resolve;
        });
        yield { type: 'delta', turnId: 'turn-ordered', content: 'Finished.' };
        yield { type: 'done', turnId: 'turn-ordered' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-ordered',
      now: () => 100,
    });

    const submission = controller.submit('Inspect');
    await vi.waitFor(() =>
      expect(transcript.snapshot().map((cell) => cell.kind)).toEqual([
        'user',
        'thinking',
        'tool',
        'tool',
      ]),
    );
    releaseReply?.();
    await submission;

    expect(transcript.snapshot().map((cell) => cell.kind)).toEqual([
      'user',
      'thinking',
      'tool',
      'tool',
      'assistant',
      'turn-duration',
    ]);
    expect(transcript.snapshot().at(-2)).toMatchObject({
      kind: 'assistant',
      content: 'Finished.',
      status: 'succeeded',
    });
  });

  it('does not create an empty assistant row for a successful turn with no text', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-no-text' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'done', turnId: 'turn-no-text' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-no-text',
      now: () => 100,
    });

    await controller.submit('Run');

    expect(transcript.snapshot().map((cell) => cell.kind)).toEqual(['user', 'turn-duration']);
  });

  it('does not create a thinking row for whitespace-only runtime deltas or history', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-empty-thinking' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'delta', turnId: 'turn-empty-thinking', thinking: ' \n\t' };
        yield {
          type: 'message',
          turnId: 'turn-empty-thinking',
          message: {
            role: 'assistant',
            thinking: '   ',
          },
        };
        yield { type: 'done', turnId: 'turn-empty-thinking' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-empty-thinking',
      now: () => 100,
    });

    await controller.submit('Run');

    expect(transcript.snapshot().map((cell) => cell.kind)).toEqual(['user', 'turn-duration']);
  });

  it('submits attachment-only turns and keeps attachment metadata in the user transcript', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-attachment' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'done' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-attachment',
      now: () => 100,
    });
    const attachments = [
      {
        type: 'image' as const,
        filePath: '/workspace/diagram.png',
        fileName: 'diagram.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
      },
    ];

    await controller.submit('', { attachments });

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      {
        id: 'session-attachment',
        content: '',
        turnId: 'turn-attachment',
        attachments: [
          {
            local: { filePath: '/workspace/diagram.png' },
            meta: {
              attachmentType: 'image',
              fileName: 'diagram.png',
              mimeType: 'image/png',
              sizeBytes: 2048,
            },
          },
        ],
      },
      expect.any(AbortSignal),
    );
    expect(transcript.get('user:turn-attachment')).toMatchObject({
      content: '',
      attachments: [
        {
          type: 'image',
          fileName: 'diagram.png',
          mimeType: 'image/png',
          sizeBytes: 2048,
          filePath: '/workspace/diagram.png',
        },
      ],
    });
  });

  it('reconciles a pasted image with a Runtime echo that omits its local size', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-image-echo' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield {
          type: 'message',
          message: {
            id: 'message-image-echo',
            turnId: 'turn-image-echo',
            role: 'user',
            content: 'Inspect this image',
            attachments: [
              {
                type: 'image',
                fileName: 'clipboard.png',
                mimeType: 'image/png',
              },
            ],
          },
        };
        yield { type: 'done', turnId: 'turn-image-echo' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-image-echo',
      now: () => 100,
    });

    await controller.submit('Inspect this image', {
      attachments: [
        {
          type: 'image',
          filePath: '/tmp/clipboard.png',
          fileName: 'clipboard.png',
          mimeType: 'image/png',
          sizeBytes: 2_048,
        },
      ],
    });

    const userCells = transcript.snapshot().filter((cell) => cell.kind === 'user');
    expect(userCells).toHaveLength(1);
    expect(userCells[0]).toMatchObject({
      id: 'user:turn-image-echo',
      sourceMessageId: 'message-image-echo',
      status: 'succeeded',
      attachments: [expect.objectContaining({ sizeBytes: 2_048 })],
    });
    const rendered = new TranscriptView(() => transcript.snapshot()).render(80).join('\n');
    expect(rendered.match(/Image {2}clipboard\.png/gu)).toHaveLength(1);
    expect(rendered.match(/2 KB/gu)).toHaveLength(1);
    expect(rendered.match(/Inspect this image/gu)).toHaveLength(1);
  });

  it('renders thinking, tools, and a useful runtime error without losing partial output', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-2' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'delta', turnId: 'turn-2', thinking: 'Inspecting files' };
        yield {
          type: 'delta',
          turnId: 'turn-2',
          content: 'Partial answer',
          toolCalls: [{ id: 'tool-1', name: 'read', status: 'running' }],
        };
        yield { type: 'error', turnId: 'turn-2', message: 'provider unavailable' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-2',
      now: () => 100,
    });

    await controller.submit('Inspect');

    expect(transcript.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'thinking:turn-2',
          kind: 'thinking',
          content: 'Inspecting files',
        }),
        expect.objectContaining({
          id: 'tool:turn-2:tool-1',
          kind: 'tool',
          status: 'failed',
          title: 'read',
        }),
        expect.objectContaining({
          id: 'assistant:turn-2',
          kind: 'assistant-preamble',
          status: 'succeeded',
          content: 'Partial answer',
        }),
        expect.objectContaining({
          id: 'error:turn-2',
          kind: 'error',
          content:
            'The model provider is temporarily unavailable.\nRun /retry to resend your last message. Your prompt is preserved.',
        }),
      ]),
    );
    expect(transcript.snapshot()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'provider unavailable' })]),
    );
    expect(controller.snapshot().status).toBe('error');
  });

  it('preserves the submitted message and renders an error when session creation fails', async () => {
    const runtime = {
      createSession: vi.fn(async () => {
        throw new Error('authentication required');
      }),
      sendMessage: vi.fn(),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-auth',
      now: () => 100,
    });

    await expect(controller.submit('Hello')).resolves.toBe('failed');

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(transcript.snapshot()).toEqual([
      expect.objectContaining({
        id: 'user:turn-auth',
        kind: 'user',
        status: 'failed',
        content: 'Hello',
      }),
      expect.objectContaining({
        id: 'assistant:turn-auth',
        kind: 'assistant',
        status: 'failed',
      }),
      expect.objectContaining({
        id: 'error:turn-auth',
        kind: 'error',
        content:
          'The service rejected request authentication.\nIf the problem persists, report this error and its code. Your prompt is preserved.',
      }),
    ]);
    expect(controller.snapshot()).toMatchObject({
      status: 'error',
      error:
        'The service rejected request authentication.\nIf the problem persists, report this error and its code. Your prompt is preserved.',
    });
  });

  it('does not suggest retry when local-runtime marks a failure as non-retryable', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-non-retryable' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield* [] as TuiStreamEvent[];
        throw Object.assign(new Error('provider unavailable'), { retryable: false });
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-non-retryable',
      now: () => 100,
    });

    await expect(controller.submit('Unsupported request')).resolves.toBe('failed');

    expect(controller.snapshot()).toMatchObject({
      status: 'error',
      errorRetryable: false,
    });
    expect(controller.snapshot().error).not.toContain('/retry');
    expect(transcript.get('error:turn-non-retryable')?.content).not.toContain('/retry');
  });

  it('maps local-runtime numeric tool statuses to terminal states', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-tools' })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield {
          type: 'delta',
          toolCalls: [
            { id: 'tool-finished', name: 'read', status: 2 },
            { id: 'tool-failed', name: 'bash', status: 3 },
          ],
        };
        yield { type: 'done' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-tools',
      now: () => 100,
    });

    await controller.submit('Run tools');

    expect(transcript.get('tool:turn-tools:tool-finished')).toMatchObject({
      status: 'succeeded',
    });
    expect(transcript.get('tool:turn-tools:tool-failed')).toMatchObject({
      status: 'failed',
    });
  });

  it('routes stop through local-runtime and marks the turn cancelled', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-3' })),
      sendMessage: vi.fn(async function* sendMessage(
        _req: SendMessageReq,
        signal?: AbortSignal,
      ): AsyncGenerator<TuiStreamEvent> {
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'done', turnId: 'turn-3' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-3',
      now: () => 100,
    });

    const submitting = controller.submit('Wait');
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('running'));
    await expect(controller.abort()).resolves.toBe(true);
    await submitting;

    expect(runtime.abortSession).toHaveBeenCalledWith({
      id: 'session-3',
      turnId: 'turn-3',
      reason: 'user_stop',
    });
    expect(transcript.get('assistant:turn-3')).toMatchObject({ status: 'cancelled' });
    expect(controller.snapshot().status).toBe('idle');
  });

  it('cancels a turn while its first session is still being created', async () => {
    let finishSessionCreation:
      | ((session: { sessionId: string; workspaceDir: string }) => void)
      | undefined;
    const runtime = {
      createSession: vi.fn(
        async () =>
          await new Promise<{ sessionId: string; workspaceDir: string }>((resolve) => {
            finishSessionCreation = resolve;
          }),
      ),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'done' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-creating-session',
      now: () => 100,
    });

    const submitting = controller.submit('Wait for the session');
    await vi.waitFor(() =>
      expect(controller.snapshot()).toMatchObject({
        status: 'starting',
        activeTurnId: 'turn-creating-session',
      }),
    );
    await expect(controller.abort()).resolves.toBe(true);
    finishSessionCreation?.({ sessionId: 'session-created', workspaceDir: '/workspace' });
    await expect(submitting).resolves.toBe('cancelled');

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(runtime.abortSession).not.toHaveBeenCalled();
    expect(transcript.get('assistant:turn-creating-session')).toMatchObject({
      status: 'cancelled',
    });
    expect(controller.snapshot()).toMatchObject({
      status: 'idle',
      activeTurnId: undefined,
    });
    expect(controller.snapshot().session).toBeUndefined();
  });

  it('retries Session creation after cancellation and ignores the stale result', async () => {
    const resolvers: Array<(session: { sessionId: string; workspaceDir: string }) => void> = [];
    const runtime = {
      createSession: vi.fn(
        async () =>
          await new Promise<{ sessionId: string; workspaceDir: string }>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'done' };
      }),
      abortSession: vi.fn(async () => true),
    };
    let turnSequence = 0;
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      createTurnId: () => `turn-session-retry-${++turnSequence}`,
      now: () => 100,
    });

    const first = controller.submit('First attempt');
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    await expect(controller.abort()).resolves.toBe(true);
    await expect(first).resolves.toBe('cancelled');

    const second = controller.submit('Second attempt');
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.({ sessionId: 'session-current', workspaceDir: '/workspace' });
    await expect(second).resolves.toBe('succeeded');

    resolvers[0]?.({ sessionId: 'session-stale', workspaceDir: '/workspace' });
    await Promise.resolve();

    expect(runtime.createSession).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      {
        id: 'session-current',
        content: 'Second attempt',
        turnId: 'turn-session-retry-2',
      },
      expect.any(AbortSignal),
    );
    expect(controller.snapshot().session?.sessionId).toBe('session-current');
  });

  it('stops the local stream even when the remote abort request fails', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-4' })),
      sendMessage: vi.fn(async function* sendMessage(
        _req: SendMessageReq,
        signal?: AbortSignal,
      ): AsyncGenerator<TuiStreamEvent> {
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'done', turnId: 'turn-4' };
      }),
      abortSession: vi.fn(async () => {
        throw new Error('abort endpoint unavailable');
      }),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-4',
      now: () => 100,
    });

    const submitting = controller.submit('Wait');
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('running'));
    await expect(controller.abort()).resolves.toBe(false);
    await submitting;

    expect(transcript.get('assistant:turn-4')).toMatchObject({ status: 'cancelled' });
    expect(controller.snapshot().status).toBe('idle');
  });

  it('keeps the controller editable but blocks a new turn until cancellation retires', async () => {
    let sequence = 0;
    let releaseCancelledStream: (() => void) | undefined;
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-hung-cancel' })),
      sendMessage: vi.fn(async function* sendMessage(
        req: SendMessageReq,
        signal?: AbortSignal,
      ): AsyncGenerator<TuiStreamEvent> {
        if (req.content === 'First') {
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', resolve, { once: true });
          });
          await new Promise<void>((resolve) => {
            releaseCancelledStream = resolve;
          });
        }
        yield { type: 'delta', content: 'Recovered' };
        yield { type: 'done' };
      }),
      abortSession: vi.fn(async () => true),
      steer: vi.fn(),
    };
    const transcript = new TranscriptStore();
    const controller = new ProductionTuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      createTurnId: () => `turn-${++sequence}`,
      retirementWarningTimeoutMs: 5,
      runCoordinator: new TuiRunCoordinator(runtime, {
        cancellationSettlementTimeoutMs: 10,
      }),
    });

    void controller.submit('First');
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('running'));
    await expect(controller.abort()).resolves.toBe(true);

    expect(controller.snapshot()).toMatchObject({
      status: 'idle',
      activeTurnId: undefined,
      cancelling: false,
      retiringTurnId: 'turn-1',
    });
    await expect(controller.submit('Second')).rejects.toThrow(
      'The previous run is still stopping.',
    );

    await vi.waitFor(() => {
      expect(controller.snapshot()).toMatchObject({
        status: 'error',
        retiringTurnId: 'turn-1',
        error: expect.stringContaining('taking too long to stop'),
      });
    });

    releaseCancelledStream?.();
    await vi.waitFor(() => expect(controller.snapshot().retiringTurnId).toBeUndefined());
    expect(controller.snapshot()).toMatchObject({ status: 'idle', error: undefined });
    await expect(controller.submit('Second')).resolves.toBe('succeeded');
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(transcript.get('assistant:turn-2')).toMatchObject({
      status: 'succeeded',
      content: 'Recovered',
    });
  });

  it('defers an automation cancel terminal until a slow result write retires', async () => {
    const resultWritten = Promise.withResolvers<void>();
    const writeAutomationResult = vi.fn(async () => resultWritten.promise);
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-slow-result-cancel' })),
      sendMessage: vi.fn(async function* sendMessage(
        _req: SendMessageReq,
        signal?: AbortSignal,
      ): AsyncGenerator<TuiStreamEvent> {
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', resolve, { once: true });
        });
        yield { type: 'done' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      createTurnId: () => 'turn-slow-result-cancel',
      writeAutomationResult,
      runCoordinator: new TuiRunCoordinator(runtime, {
        cancellationSettlementTimeoutMs: 1,
      }),
    });

    const submitting = controller.submit('Wait');
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('running'));
    await expect(controller.abort()).resolves.toBe(true);
    await vi.waitFor(() => expect(writeAutomationResult).toHaveBeenCalledOnce());
    expect(controller.snapshot()).toMatchObject({
      retiringTurnId: 'turn-slow-result-cancel',
      lastSettledTurn: undefined,
    });

    resultWritten.resolve();
    await submitting;
    await vi.waitFor(() =>
      expect(controller.snapshot().lastSettledTurn).toEqual({
        sessionId: 'session-slow-result-cancel',
        turnId: 'turn-slow-result-cancel',
        status: 'cancelled',
      }),
    );
  });

  it('loads Desktop sessions, hydrates history, and supports rename and archive', async () => {
    const runtime = {
      createSession: vi.fn(async (input: { parentSessionId?: string; title?: string }) => ({
        sessionId: 'session-fork',
        parentSessionId: input.parentSessionId,
        title: input.title,
        workspaceDir: '/workspace',
      })),
      listSessions: vi.fn(async () => [
        {
          sessionId: 'session-1',
          title: 'Existing',
          workspaceDir: '/workspace',
          updatedAt: 200,
        },
      ]),
      getSession: vi.fn(async () => ({
        sessionId: 'session-1',
        title: 'Existing',
        workspaceDir: '/workspace',
      })),
      getMessages: vi.fn(async () => [
        {
          id: 'message-user',
          turnId: 'turn-history',
          role: 'user' as const,
          content: 'Earlier question',
          attachments: [
            {
              type: 'file' as const,
              fileName: 'notes.md',
              mimeType: 'text/markdown',
              sizeBytes: 2048,
            },
          ],
          timestamp: 100,
        },
        {
          id: 'message-assistant',
          turnId: 'turn-history',
          role: 'assistant' as const,
          content: 'Earlier answer',
          toolCalls: [{ id: 'tool-history', name: 'read', status: 'completed' }],
          timestamp: 101,
        },
      ]),
      renameSession: vi.fn(async (_sessionId: string, title: string) => ({
        sessionId: 'session-1',
        title,
        workspaceDir: '/workspace',
      })),
      archiveSession: vi.fn(async () => undefined),
      getAccountStatus: vi.fn(async () => ({
        status: 'ready' as const,
        defaultModel: 'minimax/MiniMax-M2.7',
        providerId: 'minimax',
        authMode: 'managed-login',
        managedTokenPresent: true,
        warnings: [],
      })),
      sendMessage: vi.fn(),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      now: () => 300,
    });

    await controller.initialize();
    await controller.loadSessionProjection('session-1');

    expect(controller.snapshot()).toMatchObject({
      status: 'idle',
      session: { sessionId: 'session-1', title: 'Existing' },
      sessions: [expect.objectContaining({ sessionId: 'session-1' })],
      account: expect.objectContaining({
        status: 'ready',
        defaultModel: 'minimax/MiniMax-M2.7',
      }),
    });
    expect(transcript.snapshot()).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'Earlier question',
        attachments: [
          {
            type: 'file',
            fileName: 'notes.md',
            mimeType: 'text/markdown',
            sizeBytes: 2048,
          },
        ],
        turnId: 'turn-history',
      }),
      expect.objectContaining({
        kind: 'assistant-preamble',
        content: 'Earlier answer',
        turnId: 'turn-history',
      }),
      expect.objectContaining({
        kind: 'tool',
        title: 'read',
        status: 'succeeded',
      }),
    ]);

    await controller.renameCurrentSession('Renamed');
    expect(controller.snapshot().session?.title).toBe('Renamed');
    await controller.runtimeTurnSettlement.settle('session-1', 'turn-archived', 'succeeded', 0);

    await controller.archiveCurrentSession();
    expect(runtime.archiveSession).toHaveBeenCalledWith('session-1', true);
    expect(controller.snapshot().session).toBeUndefined();
    expect(controller.snapshot().lastSettledTurn).toBeUndefined();
  });

  it('drops a stale Session resume when a newer Session finishes loading first', async () => {
    let resolveFirstMessages:
      | ((messages: Array<{ id: string; role: 'user'; content: string }>) => void)
      | undefined;
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-created' })),
      getSession: vi.fn(async (sessionId: string) => ({ sessionId, title: sessionId })),
      getMessages: vi.fn(async (sessionId: string) => {
        if (sessionId === 'session-a') {
          return await new Promise<Array<{ id: string; role: 'user'; content: string }>>(
            (resolve) => {
              resolveFirstMessages = resolve;
            },
          );
        }
        return [{ id: 'message-b', role: 'user' as const, content: 'History B' }];
      }),
      sendMessage: vi.fn(),
      abortSession: vi.fn(async () => true),
      steer: vi.fn(),
    };
    const transcript = new TranscriptStore();
    const controller = new ProductionTuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
    });

    const firstResume = controller.loadSessionProjection('session-a');
    await vi.waitFor(() => expect(resolveFirstMessages).toBeTypeOf('function'));
    await controller.loadSessionProjection('session-b');
    resolveFirstMessages?.([{ id: 'message-a', role: 'user', content: 'History A' }]);
    await firstResume;

    expect(controller.snapshot()).toMatchObject({
      status: 'idle',
      session: { sessionId: 'session-b' },
    });
    expect(transcript.snapshot()).toEqual([
      expect.objectContaining({ kind: 'user', content: 'History B' }),
    ]);
  });

  it('keeps the latest Session catalog when refreshes resolve out of order', async () => {
    const sessionResolvers: Array<(sessions: Array<{ sessionId: string; title: string }>) => void> =
      [];
    const runtime = {
      listSessions: vi.fn(
        async () =>
          await new Promise<Array<{ sessionId: string; title: string }>>((resolve) => {
            sessionResolvers.push(resolve);
          }),
      ),
    };
    const controller = new ProductionTuiChatController({
      runtime: runtime as never,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
    });

    const olderRefresh = controller.refreshSessionList();
    const newerRefresh = controller.refreshSessionList();
    await vi.waitFor(() => expect(sessionResolvers).toHaveLength(2));
    sessionResolvers[1]?.([{ sessionId: 'session-new', title: 'New catalog' }]);
    await newerRefresh;
    sessionResolvers[0]?.([{ sessionId: 'session-old', title: 'Old catalog' }]);
    await olderRefresh;

    expect(controller.snapshot().sessions).toEqual([
      expect.objectContaining({ sessionId: 'session-new', title: 'New catalog' }),
    ]);
  });

  it('refreshes account quota after a completed turn', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-meters' })),
      listSessions: vi.fn(async () => []),
      getAccountStatus: vi.fn(async (_sessionId, options) => ({
        status: 'ready' as const,
        defaultModel: 'minimax/MiniMax-M2.7',
        providerId: 'minimax',
        modelId: 'MiniMax-M2.7',
        authMode: 'managed-login',
        managedTokenPresent: true,
        modelSource: 'token-plan' as const,
        ...(options?.includeMembership === true
          ? {
              tokenPlanQuota: {
                fiveHour: { remainingPercent: 82, unlimited: false },
                weekly: { remainingPercent: 64, unlimited: false },
              },
            }
          : {}),
        warnings: [],
      })),
      sendMessage: vi.fn(async function* sendMessage(): AsyncGenerator<TuiStreamEvent> {
        yield { type: 'delta', content: 'Done' };
        yield { type: 'done' };
      }),
      abortSession: vi.fn(async () => true),
    };
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
    });

    await controller.initialize();
    await controller.submit('Measure this turn');

    await vi.waitFor(() => {
      expect(controller.snapshot()).toMatchObject({
        account: {
          modelSource: 'token-plan',
          tokenPlanQuota: {
            fiveHour: { remainingPercent: 82 },
            weekly: { remainingPercent: 64 },
          },
        },
      });
    });
    expect(runtime.getAccountStatus).toHaveBeenCalledWith(undefined, {
      includeMembership: false,
    });
    expect(runtime.getAccountStatus).toHaveBeenCalledWith('session-meters', {
      includeMembership: false,
    });
    await vi.waitFor(() =>
      expect(runtime.getAccountStatus).toHaveBeenCalledWith('session-meters', {
        includeMembership: true,
      }),
    );
  });

  it('preserves ephemeral local cells in place during same-Session history reconciliation', async () => {
    let messages = [
      {
        id: 'message-1',
        turnId: 'turn-1',
        role: 'assistant' as const,
        content: 'First durable answer',
      },
    ];
    const runtime = {
      getSession: vi.fn(async (sessionId: string) => ({ sessionId })),
      getMessages: vi.fn(async () => messages),
    };
    const transcript = new TranscriptStore();
    const controller = new ProductionTuiChatController({
      runtime: runtime as never,
      transcript,
      workspaceDir: '/workspace',
    });

    await controller.loadSessionProjection('session-local-cells');
    transcript.upsert({
      id: 'local:status',
      kind: 'final-summary',
      status: 'succeeded',
      content: 'MCode status',
      ephemeral: true,
      createdAtMs: 100,
      updatedAtMs: 100,
    });
    messages = [
      {
        ...messages[0],
        id: 'message-1-reprojected',
      },
      {
        id: 'message-2',
        turnId: 'turn-2',
        role: 'assistant' as const,
        content: 'Second durable answer',
      },
    ];

    await controller.refreshCurrentSessionHistory();

    expect(transcript.snapshot().map((cell) => cell.content)).toEqual([
      'First durable answer',
      'MCode status',
      'Second durable answer',
    ]);

    messages = [];
    await controller.loadSessionProjection('session-other');
    expect(transcript.snapshot()).toEqual([]);
  });

  it('restores thinking, tool evidence and Tasks while filtering durable protocol rows', async () => {
    const onTodoChange = vi.fn();
    const runtime = {
      createSession: vi.fn(),
      getSession: vi.fn(async () => ({ sessionId: 'session-resume' })),
      getMessages: vi.fn(async () => [
        {
          id: 'assistant-tool',
          turnId: 'turn-resume',
          role: 'assistant' as const,
          thinking: 'Inspect the history projection.',
          toolCalls: [
            {
              id: 'tool-grep',
              name: 'grep',
              status: 'completed',
              input: '{"pattern":"hydrateHistory","path":"packages/tui"}',
              output:
                '{"content":[{"type":"text","text":"packages/tui/src/a.ts:12:hydrateHistory"}]}',
            },
          ],
        },
        {
          id: 'todo-event',
          turnId: 'turn-resume',
          role: 'unknown' as const,
          content: JSON.stringify({
            eventType: 'todo_updated',
            todos: [{ content: 'Verify resume', status: 'completed', priority: 'high' }],
          }),
        },
        {
          id: 'todo-tool',
          turnId: 'turn-resume',
          role: 'assistant' as const,
          toolCalls: [{ id: 'todo-write', name: 'functions.TodoWrite', status: 'completed' }],
        },
      ]),
      sendMessage: vi.fn(),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
      onTodoChange,
    });

    await controller.loadSessionProjection('session-resume');

    expect(transcript.snapshot()).toEqual([
      expect.objectContaining({
        kind: 'thinking',
        content: 'Inspect the history projection.',
      }),
      expect.objectContaining({
        kind: 'tool',
        title: 'grep',
        content: '{"pattern":"hydrateHistory","path":"packages/tui"}',
        detail: 'packages/tui/src/a.ts:12:hydrateHistory',
      }),
    ]);
    expect(onTodoChange).toHaveBeenLastCalledWith([
      { content: 'Verify resume', status: 'completed' },
    ]);
    const view = new TranscriptView(() => transcript.snapshot());
    const compact = view.render(80).join('\n');
    expect(compact).toContain('Thought');
    expect(compact).toContain('Searched (hydrateHistory in packages/tui)');
    expect(compact).not.toContain('Inspect the history projection.');
    expect(compact).not.toContain('packages/tui/src/a.ts:12:hydrateHistory');
    view.toggleDetailMode();
    const detailed = view.render(80).join('\n');
    expect(detailed).toContain('Inspect the history projection.');
    expect(detailed).toContain('Searched (hydrateHistory in packages/tui)');
    expect(detailed).toContain('packages/tui/src/a.ts:12:hydrateHistory');
    expect(detailed).not.toContain('todo_updated');
    expect(detailed).not.toContain('TodoWrite');
  });

  it('hydrates ordered message parts without flattening text and tools', async () => {
    const runtime = {
      createSession: vi.fn(),
      listSessions: vi.fn(async () => []),
      getSession: vi.fn(async () => ({ sessionId: 'session-parts' })),
      getMessages: vi.fn(async () => [
        {
          id: 'message-parts',
          turnId: 'turn-parts',
          role: 'assistant' as const,
          parts: [
            { id: 'thinking-1', type: 'thinking' as const, content: 'Plan' },
            { id: 'text-1', type: 'text' as const, content: 'I will inspect.' },
            {
              id: 'tool-1',
              type: 'tool' as const,
              toolCall: {
                id: 'call-1',
                name: 'read',
                status: 'completed',
                input: { path: 'README.md' },
              },
            },
            { id: 'thinking-2', type: 'thinking' as const, content: 'Interpret' },
            { id: 'text-2', type: 'text' as const, content: 'Done.' },
          ],
        },
      ]),
      sendMessage: vi.fn(),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
    });

    await controller.loadSessionProjection('session-parts');

    expect(
      transcript.snapshot().map((cell) => ({
        kind: cell.kind,
        content: cell.content,
        title: cell.title,
      })),
    ).toEqual([
      { kind: 'thinking', content: 'Plan', title: undefined },
      { kind: 'assistant-preamble', content: 'I will inspect.', title: undefined },
      { kind: 'tool', content: '{"path":"README.md"}', title: 'read' },
      { kind: 'thinking', content: 'Interpret', title: undefined },
      { kind: 'assistant', content: 'Done.', title: undefined },
    ]);
  });

  it('keeps distinct durable assistant messages when one turn repeats the same text', async () => {
    const runtime = {
      createSession: vi.fn(),
      getSession: vi.fn(async () => ({ sessionId: 'session-repeated-text' })),
      getMessages: vi.fn(async () => [
        {
          id: 'assistant-first',
          turnId: 'turn-repeated-text',
          role: 'assistant' as const,
          content: 'Same answer',
          timestamp: 100,
        },
        {
          id: 'assistant-second',
          turnId: 'turn-repeated-text',
          role: 'assistant' as const,
          content: 'Same answer',
          timestamp: 101,
        },
      ]),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
    });

    await controller.loadSessionProjection('session-repeated-text');

    expect(
      transcript
        .snapshot()
        .filter((cell) => cell.kind === 'assistant')
        .map((cell) => cell.id),
    ).toEqual(['history:assistant:assistant-first', 'history:assistant:assistant-second']);
  });

  it('projects questionnaire history as a readable receipt and hides internal Ask User protocol', async () => {
    const runtime = {
      createSession: vi.fn(async () => ({ sessionId: 'session-questionnaire' })),
      listSessions: vi.fn(async () => []),
      getSession: vi.fn(async () => ({ sessionId: 'session-questionnaire' })),
      getMessages: vi.fn(async () => [
        {
          id: 'ask-preamble',
          turnId: 'turn-ask',
          role: 'assistant' as const,
          content: 'I need two choices before continuing.',
          toolCalls: [
            {
              id: 'ask-tool',
              name: 'functions.AskUser',
              status: 'completed',
              input: { title: 'Choose', steps: [{ question: 'Which option?' }] },
            },
          ],
        },
        {
          id: 'ask-reply',
          turnId: 'turn-ask-reply',
          role: 'user' as const,
          content: [
            '<questionnaire-response>',
            '  <requestId>ask_1</requestId>',
            '  <answers />',
            '</questionnaire-response>',
            '',
            'Q: Which option?  ',
            'A: Stable',
          ].join('\n'),
        },
        {
          id: 'final-a',
          turnId: 'turn-final',
          role: 'assistant' as const,
          content: 'Continuing with Stable.',
        },
      ]),
      sendMessage: vi.fn(),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
    });

    await controller.loadSessionProjection('session-questionnaire');

    expect(transcript.snapshot()).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        content: 'I need two choices before continuing.',
      }),
      expect.objectContaining({
        id: 'question:ask_1',
        kind: 'question',
        status: 'resolved',
        title: 'Answers sent',
        content: 'Which option?  Stable',
      }),
      expect.objectContaining({
        kind: 'assistant',
        content: 'Continuing with Stable.',
      }),
    ]);
    const renderedContent = transcript
      .snapshot()
      .map((cell) => `${cell.title ?? ''}\n${cell.content}`)
      .join('\n');
    expect(renderedContent).not.toContain('functions.AskUser');
    expect(renderedContent).not.toContain('questionnaire-response');
    expect(renderedContent.match(/Continuing with Stable\./gu)).toHaveLength(1);
  });

  it('replays the durable continuation reply after a resolved questionnaire', async () => {
    const runtime = {
      createSession: vi.fn(),
      getSession: vi.fn(async () => ({ sessionId: 'session-questionnaire-continuation' })),
      getMessages: vi.fn(async () => [
        {
          id: 'ask-user-turn',
          turnId: 'turn-ask-user',
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ name: 'ask_user', status: 'completed' }],
          timestamp: 100,
        },
        {
          id: 'ask-user-reply',
          turnId: 'turn-questionnaire-continuation',
          role: 'user' as const,
          content: [
            '<questionnaire-response>',
            '  <requestId>ask_1</requestId>',
            '  <answers />',
            '</questionnaire-response>',
            '',
            'Q: What next?  ',
            'A: Chat',
          ].join('\n'),
          timestamp: 200,
        },
        {
          id: 'continuation-final',
          turnId: 'turn-questionnaire-continuation',
          role: 'assistant' as const,
          content: '好呀，那就随便聊聊。',
          timestamp: 300,
        },
      ]),
      sendMessage: vi.fn(),
      abortSession: vi.fn(async () => true),
    };
    const transcript = new TranscriptStore();
    const controller = new TuiChatController({
      runtime,
      transcript,
      workspaceDir: '/workspace',
    });

    await controller.loadSessionProjection('session-questionnaire-continuation');

    expect(transcript.snapshot()).toContainEqual(
      expect.objectContaining({
        kind: 'assistant',
        turnId: 'turn-questionnaire-continuation',
        content: '好呀，那就随便聊聊。',
      }),
    );
  });

  it('restores an archived Session before making it the active projection', async () => {
    let archived = true;
    const runtime = {
      getSession: vi.fn(async () => ({
        sessionId: 'session-archived',
        workspaceDir: '/workspace',
        archived,
      })),
      getMessages: vi.fn(async () => []),
      archiveSession: vi.fn(async (_sessionId: string, value: boolean) => {
        archived = value;
      }),
      sendMessage: vi.fn(),
      abortSession: vi.fn(async () => true),
    };
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
    });

    await controller.loadSessionProjection('session-archived');

    expect(runtime.archiveSession).toHaveBeenCalledWith('session-archived', false);
    expect(controller.snapshot().session).toMatchObject({
      sessionId: 'session-archived',
      archived: false,
    });
  });

  it('manages a selected Desktop session without requiring it to be active first', async () => {
    let archived = false;
    const runtime = {
      createSession: vi.fn(
        async (input: { parentSessionId?: string; title?: string; workspaceDir: string }) => ({
          sessionId: 'session-fork',
          parentSessionId: input.parentSessionId,
          title: input.title,
          workspaceDir: input.workspaceDir,
        }),
      ),
      listSessions: vi.fn(async () => [
        {
          sessionId: 'session-1',
          title: 'First',
          workspaceDir: '/workspace',
          updatedAt: 200,
        },
        {
          sessionId: 'session-2',
          title: 'Second',
          workspaceDir: '/other',
          updatedAt: 100,
        },
      ]),
      getSession: vi.fn(async (sessionId: string) => ({
        sessionId,
        title: sessionId === 'session-2' ? 'Renamed second' : 'First',
        workspaceDir: sessionId === 'session-2' ? '/other' : '/workspace',
        archived,
      })),
      getMessages: vi.fn(async () => []),
      renameSession: vi.fn(async (sessionId: string, title: string) => ({
        sessionId,
        title,
        workspaceDir: '/other',
      })),
      archiveSession: vi.fn(async (_sessionId: string, value: boolean) => {
        archived = value;
      }),
      getAccountStatus: vi.fn(async () => ({
        status: 'ready' as const,
        warnings: [],
      })),
      sendMessage: vi.fn(),
      abortSession: vi.fn(async () => true),
    };
    const controller = new TuiChatController({
      runtime,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
    });

    await controller.initialize();
    await controller.loadSessionProjection('session-1');
    await expect(controller.renameSession('session-2', 'Renamed second')).resolves.toMatchObject({
      sessionId: 'session-2',
      title: 'Renamed second',
    });
    expect(controller.snapshot().session?.sessionId).toBe('session-1');

    await controller.loadSessionProjection('session-1');
    await controller.setSessionArchived('session-2', true);
    expect(controller.snapshot().sessions.map((session) => session.sessionId)).not.toContain(
      'session-2',
    );
    expect(controller.snapshot().session?.sessionId).toBe('session-1');

    await expect(controller.renameSession('session-2', 'Archived second')).resolves.toMatchObject({
      sessionId: 'session-2',
      title: 'Archived second',
      archived: true,
    });
    expect(controller.snapshot().sessions.map((session) => session.sessionId)).not.toContain(
      'session-2',
    );

    await expect(controller.setSessionArchived('session-2', false)).resolves.toMatchObject({
      sessionId: 'session-2',
      archived: false,
    });
    expect(controller.snapshot().sessions.map((session) => session.sessionId)).toContain(
      'session-2',
    );
  });

  it('clears input-adjacent tasks when starting a new session', () => {
    const onTodoChange = vi.fn();
    const controller = new ProductionTuiChatController({
      runtime: {} as never,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      onTodoChange,
    });

    controller.applyRuntimeTurnEvent('turn-todo', {
      type: 'generic',
      eventType: 'todo_updated',
      turnId: 'turn-todo',
      data: { todos: [{ content: 'Current session task', status: 'in_progress' }] },
    });
    expect(onTodoChange).toHaveBeenLastCalledWith([
      { content: 'Current session task', status: 'in_progress' },
    ]);

    controller.startNewSession();

    expect(onTodoChange).toHaveBeenLastCalledWith([]);
  });

  it('carries the clear source from /new to the lazily-created session', async () => {
    const onSessionLifecycle = vi.fn();
    const controller = new ProductionTuiChatController({
      runtime: {
        createSession: vi.fn(async () => ({ sessionId: 'session-after-clear' })),
      } as never,
      transcript: new TranscriptStore(),
      workspaceDir: '/workspace',
      onSessionLifecycle,
    });

    controller.startNewSession();
    await controller.ensureSession();

    expect(onSessionLifecycle.mock.calls).toEqual([[], ['session-after-clear']]);
  });
});
