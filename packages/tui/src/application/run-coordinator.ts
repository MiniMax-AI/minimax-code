import type { CliSendMessageReq } from '@mavis/local-runtime-v2/cli-service';

import type { TuiTransportAttachment } from '../types/invocation.js';
import { TuiFailure } from '../failure.js';
import type {
  TuiConversationPort,
  TuiClientIntent,
  TuiSession,
  TuiPausedQueueSendIntent,
} from '../runtime/port.js';
import type { TuiStreamEvent } from '../runtime/stream-events.js';
import type {
  TuiTurnRunError,
  TuiTurnRunOutcome,
  TuiTurnRunStatus,
  TuiTurnResponseUsage,
} from './turn-run-outcome.js';
import {
  isTurnCompactionMessage,
  responseUsageFromMessage,
  sumResponseUsage,
  upsertResponseUsage,
} from './response-usage.js';

export type TuiRunRuntime = TuiConversationPort;

export interface TuiRunRequest {
  turnId: string;
  session: Promise<TuiSession>;
  content: string;
  displayContent?: string;
  workspace: string;
  version: string;
  attachments?: readonly TuiTransportAttachment[];
  clientIntent?: TuiClientIntent;
  reviewRequest?: { readonly scope: 'local_changes' };
  onQueuePaused?: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<TuiPausedQueueSendIntent | 'cancel'>;
  model?: {
    providerId: string;
    modelId: string;
    variant?: string;
    /** Per-Turn reasoning strength. Runtime does not persist it on the Session. */
    thinking?: { effort?: string };
  };
  outputSchema?: Readonly<Record<string, unknown>>;
  executionDiagnostics?: boolean;
  policy?: {
    timeoutMs?: number;
    maxSteps?: number;
    requireAnswer?: boolean;
  };
}

export type TuiRunStatus = TuiTurnRunStatus;

export interface TuiRunResult {
  turnId: string;
  session?: TuiSession;
  status: TuiRunStatus;
  outcome: TuiTurnRunOutcome;
  error?: string;
}

export type TuiRunObserver = (event: TuiStreamEvent) => void | Promise<void>;
export type TuiRunOutcomeObserver = (outcome: TuiTurnRunOutcome) => void | Promise<void>;

interface ActiveRun {
  turnId: string;
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled: () => void;
  sessionId?: string;
  stopReason?: 'user_stop' | 'timeout' | 'limit';
  abortPromise?: Promise<boolean>;
}

interface RetiringRun {
  turnId: string;
  settlement: Promise<boolean>;
}

export interface TuiRunCoordinatorOptions {
  onAnswerSelection?: (event: Readonly<Record<string, unknown>>) => void;
  cancellationSettlementTimeoutMs?: number;
  nowMs?: () => number;
}

export const DEFAULT_CANCELLATION_SETTLEMENT_TIMEOUT_MS = 1_000;

export class TuiRunCoordinator {
  private activeRun?: ActiveRun;
  private retiringRun?: RetiringRun;
  private readonly nowMs: () => number;

  constructor(
    private readonly runtime: TuiRunRuntime,
    private readonly options: TuiRunCoordinatorOptions = {},
  ) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  activeTurnId(): string | undefined {
    return this.activeRun?.turnId;
  }

  /**
   * Releases local ownership without aborting the Runtime Turn. The detached
   * stream continues to drain in the background, while another Session can
   * start its own independently tracked Turn.
   */
  detachActiveRun(turnId?: string): boolean {
    const activeRun = this.activeRun;
    if (!activeRun || (turnId !== undefined && activeRun.turnId !== turnId)) return false;
    this.activeRun = undefined;
    return true;
  }

  retiringTurnId(): string | undefined {
    return this.retiringRun?.turnId;
  }

  retirement(): Promise<boolean> | undefined {
    return this.retiringRun?.settlement;
  }

  private async *sendWithQueueRecovery(
    request: TuiRunRequest,
    session: TuiSession,
    signal: AbortSignal,
    executionDeadlineAtMs?: number,
  ): AsyncGenerator<TuiStreamEvent> {
    const input = toSendMessageRequest(request, session, executionDeadlineAtMs);
    let accepted = false;
    try {
      for await (const event of this.runtime.sendMessage(input, signal)) {
        accepted = true;
        yield event;
      }
    } catch (error) {
      if (
        accepted ||
        executionDeadlineAtMs !== undefined ||
        !(error instanceof TuiFailure) ||
        error.code !== 'local_session_queue_paused' ||
        !request.onQueuePaused ||
        signal.aborted
      )
        throw error;
      const intent = await request.onQueuePaused(session.sessionId, signal);
      signal.throwIfAborted();
      if (intent === 'cancel')
        throw new TuiFailure('cancelled', 'The draft was kept.', {
          code: 'PAUSED_QUEUE_SEND_CANCELLED',
        });
      // A paused admission has not created a Turn. Reuse this submission's
      // identity and attachments; never retry once any stream frame arrived.
      yield* this.runtime.sendMessage(input, signal, {
        pausedQueueAction: intent === 'paused-queue-clear' ? 'clear' : 'keep',
      });
    }
  }

  async execute(
    request: TuiRunRequest,
    observe: TuiRunObserver = () => undefined,
    onAccepted?: () => void,
    onOutcome?: TuiRunOutcomeObserver,
  ): Promise<TuiRunResult> {
    if (this.activeRun) throw new Error('A run is already active.');
    if (this.retiringRun) throw new Error('The previous run is still stopping.');

    const activeRun = createActiveRun(request.turnId);
    this.activeRun = activeRun;
    const startedAtMs = this.nowMs();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let session: TuiSession | undefined;
    let accepted = false;
    let status: TuiTurnRunStatus = 'succeeded';
    let answer: string | null = null;
    let assistantDraft = '';
    let failure: TuiTurnRunError | undefined;
    let completedAssistantSteps = 0;
    const usageResponses: TuiTurnResponseUsage[] = [];
    let usageIncomplete = false;

    try {
      session = await waitForSession(request.session, activeRun.controller.signal);
      if (!session) {
        throw (
          activeRun.controller.signal.reason ?? new Error('Turn cancelled before Session setup.')
        );
      }
      activeRun.sessionId = session.sessionId;
      let executionDeadlineAtMs: number | undefined;
      if (request.policy?.timeoutMs !== undefined) {
        executionDeadlineAtMs = this.nowMs() + request.policy.timeoutMs;
        timeout = setTimeout(() => {
          void this.stopActive(activeRun, 'timeout').catch(() => undefined);
        }, request.policy.timeoutMs);
        timeout.unref?.();
      }

      const source = this.sendWithQueueRecovery(
        request,
        session,
        activeRun.controller.signal,
        executionDeadlineAtMs,
      )[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await source.next();
          if (next.done) break;
          const event = next.value;
          if (!accepted) {
            accepted = true;
            onAccepted?.();
          }
          const continuation = continuationFromEvent(event);
          if (continuation) {
            status = 'awaiting-user-continuation';
            failure = continuation;
            await observeBestEffort(observe, event);
            break;
          }
          if (isCompletedAssistantMessage(event)) {
            usageIncomplete ||= isTurnCompactionMessage(event.message, request.turnId);
            const responseUsage = responseUsageFromMessage(event.message, request.turnId);
            if (responseUsage) upsertResponseUsage(usageResponses, responseUsage);
            if (
              request.policy?.maxSteps !== undefined &&
              completedAssistantSteps >= request.policy.maxSteps
            ) {
              status = 'limit_exceeded';
              await this.stopActive(activeRun, 'limit');
              break;
            }
            completedAssistantSteps += 1;
            if (event.message.toolCalls?.length) {
              // Pre-tool prose is not the final answer.
              this.reportAnswerSelection({
                kind: 'answer_excluded',
                messageId: event.message.id,
                reason: 'tool_calls',
              });
              answer = null;
              assistantDraft = '';
            } else {
              const completed = event.message.content?.trim()
                ? event.message.content
                : assistantDraft;
              answer = completed.trim() ? completed : null;
              this.reportAnswerSelection({
                kind: 'answer_selected',
                messageId: event.message.id,
                answerSource: event.message.content?.trim()
                  ? 'completed_message'
                  : 'completed_message_draft',
                answerBytes: Buffer.byteLength(completed),
                finishReason: event.message.finishReason,
              });
              assistantDraft = '';
            }
          } else if (isAssistantTextDelta(event)) {
            assistantDraft += event.content;
          }
          const eventFailure = failureFromEvent(event);
          if (eventFailure) {
            status = eventFailure.status;
            failure = eventFailure.error;
          }
          await observeBestEffort(observe, event);
        }
      } finally {
        await source.return?.(undefined);
      }
      if (assistantDraft.trim()) {
        this.reportAnswerSelection({
          kind: 'answer_selected',
          answerSource: 'trailing_draft',
          answerBytes: Buffer.byteLength(assistantDraft),
          replacedAnswer: answer !== null,
        });
        answer = assistantDraft;
      }
      if (request.policy?.requireAnswer === true && status === 'succeeded' && answer === null) {
        status = 'failed';
        failure = {
          category: 'runtime',
          code: 'EMPTY_RESPONSE',
          message: 'Runtime completed without a final assistant response.',
          retryable: true,
        };
      }
      status = statusFromStopReason(activeRun.stopReason, status);
    } catch (error) {
      if (activeRun.stopReason || activeRun.controller.signal.aborted) {
        status = statusFromStopReason(activeRun.stopReason, 'cancelled');
      } else {
        status = 'failed';
        failure = execError(error);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.activeRun === activeRun) this.activeRun = undefined;
    }

    const { usage } = sumResponseUsage(usageResponses);
    let outcome: TuiTurnRunOutcome = {
      sessionId: session?.sessionId ?? '',
      turnId: request.turnId,
      status,
      answer,
      ...(request.model ? { model: { ...request.model } } : {}),
      ...(usage ? { usage } : {}),
      ...(usageResponses.length ? { usageResponses } : {}),
      ...(usageIncomplete ? { usageIncomplete: true } : {}),
      ...(failure ? { error: failure } : {}),
      durationMs: Math.max(0, this.nowMs() - startedAtMs),
    };
    if (onOutcome) {
      try {
        await onOutcome(outcome);
      } catch {
        status = 'failed';
        const deliveryFailure: TuiTurnRunError = {
          category: 'internal',
          code: 'AUTOMATION_RESULT_WRITE_FAILED',
          message: 'Could not publish the TUI automation result.',
          retryable: true,
        };
        failure = deliveryFailure;
        outcome = { ...outcome, status, error: deliveryFailure };
      }
    }
    // Resolve only after optional result delivery completes.
    activeRun.resolveSettled();
    return {
      turnId: request.turnId,
      ...(session ? { session } : {}),
      status,
      outcome,
      ...(failure?.message ? { error: failure.message } : {}),
    };
  }

  async abort(): Promise<boolean> {
    const activeRun = this.activeRun;
    if (!activeRun) return false;
    activeRun.abortPromise ??= this.stopAndSettle(activeRun);
    return activeRun.abortPromise;
  }

  private reportAnswerSelection(event: Readonly<Record<string, unknown>>): void {
    try {
      this.options.onAnswerSelection?.(event);
    } catch {
      // Optional diagnostics must never alter execution or final-answer selection.
    }
  }

  private async stopAndSettle(activeRun: ActiveRun): Promise<boolean> {
    const requested = await this.stopActive(activeRun, 'user_stop');
    const settlement = activeRun.settled.then(() => requested);
    const bounded = await settleWithin(
      settlement,
      this.options.cancellationSettlementTimeoutMs ?? DEFAULT_CANCELLATION_SETTLEMENT_TIMEOUT_MS,
    );
    if (this.activeRun === activeRun) this.activeRun = undefined;
    if (bounded.settled) return bounded.value;
    const retiringRun: RetiringRun = { turnId: activeRun.turnId, settlement };
    retiringRun.settlement = settlement.finally(() => {
      if (this.retiringRun === retiringRun) this.retiringRun = undefined;
    });
    this.retiringRun = retiringRun;
    return requested;
  }

  private async stopActive(
    activeRun: ActiveRun,
    reason: NonNullable<ActiveRun['stopReason']>,
  ): Promise<boolean> {
    activeRun.stopReason ??= reason;
    const sessionId = activeRun.sessionId;
    const abortRequest = sessionId
      ? this.runtime
          .abortSession({
            id: sessionId,
            turnId: activeRun.turnId,
            reason: reason === 'limit' ? 'max_steps' : reason,
          })
          .catch(() => false)
      : Promise.resolve(true);
    activeRun.controller.abort(new Error(`Turn stopped: ${reason}`));
    return abortRequest;
  }
}

function toSendMessageRequest(
  request: TuiRunRequest,
  session: TuiSession,
  executionDeadlineAtMs?: number,
): CliSendMessageReq {
  return {
    id: session.sessionId,
    turnId: request.turnId,
    content: request.content,
    ...(request.displayContent !== undefined ? { displayContent: request.displayContent } : {}),
    ...(executionDeadlineAtMs !== undefined ? { executionDeadlineAtMs } : {}),
    ...(request.executionDiagnostics ? { executionDiagnostics: true } : {}),
    ...(request.clientIntent ? { clientIntent: request.clientIntent } : {}),
    ...(request.reviewRequest ? { reviewRequest: request.reviewRequest } : {}),
    ...(request.attachments?.length
      ? {
          attachments: request.attachments.map((attachment) => ({
            meta: {
              attachmentType: attachment.type,
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
            local: {
              ...(attachment.filePath ? { filePath: attachment.filePath } : {}),
              ...(attachment.assetId ? { assetId: attachment.assetId } : {}),
            },
          })),
        }
      : {}),
    ...(request.model ? { model: { ...request.model } } : {}),
    ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
  };
}

function isCompletedAssistantMessage(
  event: TuiStreamEvent,
): event is Extract<TuiStreamEvent, { type: 'message' }> {
  return event.type === 'message' && event.message.role === 'assistant';
}

function isAssistantTextDelta(
  event: TuiStreamEvent,
): event is Extract<TuiStreamEvent, { type: 'delta' }> & { content: string } {
  return event.type === 'delta' && event.role === 'assistant' && typeof event.content === 'string';
}

function isQuestionnaireContinuation(event: TuiStreamEvent): boolean {
  return (
    event.type === 'generic' &&
    (event.eventType.includes('questionnaire') ||
      (event.eventType === 'runtime.action-required' && event.data.kind === 'questionnaire'))
  );
}

function continuationFromEvent(event: TuiStreamEvent): TuiTurnRunError | undefined {
  if (!isQuestionnaireContinuation(event)) return undefined;
  return {
    category: 'runtime',
    code: 'QUESTIONNAIRE_REQUIRED',
    message: 'Questionnaire requires user input.',
    retryable: true,
  };
}

function failureFromEvent(event: TuiStreamEvent):
  | {
      readonly status: TuiTurnRunStatus;
      readonly error?: TuiTurnRunError;
    }
  | undefined {
  if (event.type === 'generic' && event.eventType === 'messages-rewound') {
    return {
      status: 'failed',
      error: {
        category: 'runtime',
        code: 'CONTENT_REVIEW_BLOCKED',
        message: 'Content review blocked the request.',
        retryable: true,
      },
    };
  }
  if (event.type === 'error') {
    return {
      status: 'failed',
      error: { category: 'runtime', message: event.message, retryable: true },
    };
  }
  if (event.type !== 'session-status') return undefined;
  if (event.status === 'error') {
    return {
      status: 'failed',
      error: {
        category: 'runtime',
        message: event.message ?? 'Runtime turn failed.',
        retryable: true,
      },
    };
  }
  if (event.status === 'aborted' || event.status === 'interrupted') {
    return { status: 'cancelled' };
  }
  return undefined;
}

function execError(error: unknown): TuiTurnRunError {
  if (error instanceof TuiFailure) {
    const category =
      error.category === 'config' || error.category === 'internal' ? error.category : 'runtime';
    return {
      category,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error && typeof error === 'object') {
    const candidate = error as {
      readonly category?: unknown;
      readonly code?: unknown;
      readonly message?: unknown;
      readonly retryable?: unknown;
    };
    if (typeof candidate.message === 'string') {
      return {
        category:
          candidate.category === 'config' || candidate.category === 'internal'
            ? candidate.category
            : 'runtime',
        ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
        message: candidate.message,
        ...(typeof candidate.retryable === 'boolean'
          ? { retryable: candidate.retryable }
          : { retryable: true }),
      };
    }
  }
  return {
    category: 'runtime',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function statusFromStopReason(
  reason: ActiveRun['stopReason'],
  fallback: TuiTurnRunStatus,
): TuiTurnRunStatus {
  if (reason === 'timeout') return 'timeout';
  if (reason === 'limit') return 'limit_exceeded';
  if (reason === 'user_stop') return 'cancelled';
  return fallback;
}

async function observeBestEffort(observe: TuiRunObserver, event: TuiStreamEvent): Promise<void> {
  try {
    await observe(event);
  } catch {
    // Display output cannot replace the Runtime-owned turn outcome.
  }
}

function createActiveRun(turnId: string): ActiveRun {
  let resolveSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return { turnId, controller: new AbortController(), settled, resolveSettled };
}

async function waitForSession(
  session: Promise<TuiSession>,
  signal: AbortSignal,
): Promise<TuiSession | undefined> {
  if (signal.aborted) return undefined;
  return new Promise<TuiSession | undefined>((resolve, reject) => {
    const finish = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      finish();
      resolve(undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    session.then(
      (resolved) => {
        finish();
        resolve(resolved);
      },
      (error: unknown) => {
        finish();
        reject(error);
      },
    );
  });
}

type BoundedSettlement<T> = { settled: true; value: T } | { settled: false };

async function settleWithin<T>(task: Promise<T>, timeoutMs: number): Promise<BoundedSettlement<T>> {
  if (timeoutMs <= 0) return { settled: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race<BoundedSettlement<T>>([
    task.then((value) => ({ settled: true as const, value })),
    new Promise<BoundedSettlement<T>>((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}
