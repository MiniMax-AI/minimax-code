import { setTimeout as delay } from 'node:timers/promises';

import { TuiAdvisorCallLedger } from '../../../application/advisor-calls.js';
import { writeTuiAutomationDiagnostic } from '../../../application/automation-diagnostics.js';
import type { ExecResultError, ExecResultV1 } from '../../../application/exec-result.js';
import type { TuiStreamEvent } from '../../../runtime/stream-events.js';
import type { TranscriptStore } from '../../transcript/store.js';
import {
  createTuiAutomationTurnResult,
  assistantAnswerForTurn,
} from '../../automation/turn-result.js';
import type { TuiChatSnapshot, TuiSettledTurn } from '../chat-controller-types.js';
import type { TuiTurnOutputRate } from '../projection/turn-output-rate.js';
import type { TuiTurnProjection } from '../projection/turn-projection.js';
import { createTuiSettledTurn, settleTuiRuntimeTurnProjection } from './turn-settlement.js';
import { pendingQuestionnaireForTurn } from '../../../application/pending-questionnaire.js';
import type { TuiInteractionPort } from '../../../runtime/port.js';

export interface TuiRuntimeTurnSettlementOptions {
  readonly turnProjection: TuiTurnProjection;
  readonly outputRate: TuiTurnOutputRate;
  readonly transcript: TranscriptStore;
  readonly currentSessionId: () => string | undefined;
  readonly updateState: (patch: Partial<TuiChatSnapshot>) => void;
  readonly writeAutomationResult?: (result: ExecResultV1) => void | Promise<void>;
  readonly runtime: Partial<Pick<TuiInteractionPort, 'getPendingQuestionnaire'>>;
  readonly currentAgentName: () => string;
  readonly refreshActiveDelegatedAgentCount?: () => number | Promise<number>;
}

/** A Turn that never publishes, such as one that asked a question, must not pile up. */
const MAX_OBSERVED_TURNS = 8;
const DELEGATED_REFRESH_TIMEOUT_MS = 2_000;

/** Publishes Runtime-owned outcomes after optional result delivery. */
export class TuiRuntimeTurnSettlement {
  private readonly advisorCalls = new Map<string, TuiAdvisorCallLedger>();
  /** Answers read from the live transcript before a rehydration could drop them. */
  private readonly capturedAnswers = new Map<string, string>();

  constructor(private readonly options: TuiRuntimeTurnSettlementOptions) {}

  enabled(): boolean {
    return Boolean(this.options.writeAutomationResult);
  }

  /** Feeds a Runtime-owned Turn's stream to its automation result; a no-op without one. */
  observe(turnId: string, event: TuiStreamEvent): void {
    if (!this.enabled()) return;
    let ledger = this.advisorCalls.get(turnId);
    if (!ledger) {
      ledger = new TuiAdvisorCallLedger();
      this.advisorCalls.set(turnId, ledger);
      const oldest = this.advisorCalls.keys().next().value;
      if (this.advisorCalls.size > MAX_OBSERVED_TURNS && oldest !== undefined) {
        this.advisorCalls.delete(oldest);
      }
    }
    ledger.observe(event);
  }

  /**
   * Records a Turn's delivered answer while the live transcript still holds it.
   *
   * A terminal Turn rehydrates the saved transcript view before it publishes, and that
   * rehydration clears every durable cell first. The rebuilt view is regularly unable to
   * represent the Turn that just finished, so the answer is captured here and used as the
   * fallback in `publish`. Call it before any history refresh, never after.
   */
  captureTurnAnswer(turnId: string): string | null {
    const answer = assistantAnswerForTurn(
      this.options.transcript,
      turnId,
      this.options.currentAgentName(),
    );
    if (answer === null) return null;
    this.capturedAnswers.set(turnId, answer);
    while (this.capturedAnswers.size > MAX_OBSERVED_TURNS) {
      const oldest = this.capturedAnswers.keys().next().value;
      if (oldest === undefined) break;
      this.capturedAnswers.delete(oldest);
    }
    return answer;
  }

  async requiresQuestionnaireContinuation(settledTurn: TuiSettledTurn): Promise<boolean> {
    // A resolved receipt still identifies a Turn that asked rather than finished
    // the task. The user's reply belongs to a different Runtime-owned Turn.
    if (settledTurn.status !== 'succeeded') return false;
    for (let index = this.options.transcript.length - 1; index >= 0; index -= 1) {
      const cell = this.options.transcript.cellAt(index);
      if (
        cell?.kind === 'question' &&
        cell.questionnaireRequester?.sessionId === settledTurn.sessionId &&
        cell.questionnaireRequester.turnId === settledTurn.turnId
      )
        return true;
    }
    return Boolean(
      await pendingQuestionnaireForTurn(
        this.options.runtime,
        settledTurn.sessionId,
        settledTurn.turnId,
        this.options.currentAgentName(),
      ),
    );
  }

  prepare(
    sessionId: string,
    turnId: string,
    status: TuiSettledTurn['status'],
  ): TuiSettledTurn | undefined {
    return createTuiSettledTurn(
      sessionId === this.options.currentSessionId() ? sessionId : undefined,
      turnId,
      status,
    );
  }

  /** Clears the live projection without publishing a canonical outcome. */
  settleProjection(turnId: string, status: TuiSettledTurn['status'], durationMs?: number): void {
    settleTuiRuntimeTurnProjection(
      this.options.turnProjection,
      this.options.outputRate,
      turnId,
      status,
      durationMs,
    );
  }

  /** `failurePresented`: the transcript already explains the failure, so add no error cell. */
  async publish(
    settledTurn: TuiSettledTurn,
    durationMs?: number,
    error?: ExecResultError,
    failurePresented = false,
  ): Promise<void> {
    const advisor = this.advisorCalls.get(settledTurn.turnId)?.summary();
    this.advisorCalls.delete(settledTurn.turnId);
    // Only a succeeded Turn can be downgraded to `EMPTY_RESPONSE`, so only it needs the
    // fallback; a failed or cancelled Turn keeps whatever answer the rebuilt view projects.
    const capturedAnswer =
      settledTurn.status === 'succeeded' ? this.capturedAnswers.get(settledTurn.turnId) : undefined;
    this.capturedAnswers.delete(settledTurn.turnId);
    if (await this.requiresQuestionnaireContinuation(settledTurn)) return;
    const writer = this.options.writeAutomationResult;
    if (!writer) {
      this.options.updateState({ lastSettledTurn: settledTurn });
      return;
    }

    const agentName = this.options.currentAgentName();
    const projectedAnswer = assistantAnswerForTurn(
      this.options.transcript,
      settledTurn.turnId,
      agentName,
    );
    const result = createTuiAutomationTurnResult({
      settledTurn,
      agentName,
      transcript: this.options.transcript,
      ...(capturedAnswer !== undefined ? { capturedAnswer } : {}),
      durationMs,
      ...(error ? { error } : {}),
      ...(advisor ? { advisor } : {}),
    });
    if (
      capturedAnswer !== undefined &&
      projectedAnswer === null &&
      typeof result.answer === 'string'
    ) {
      this.reportAnswerRecovered(settledTurn, result.answer);
    }
    try {
      await writer(result);
    } catch {
      this.publishDeliveryFailure(settledTurn);
      return;
    }

    const status = settledStatus(result.status);
    if (status === 'failed') {
      if (!failurePresented) {
        this.options.turnProjection.failTurn(
          settledTurn.turnId,
          result.error?.message ?? 'Runtime turn failed.',
        );
      }
      this.options.turnProjection.clearTurn(settledTurn.turnId);
    }
    this.options.updateState({ lastSettledTurn: { ...settledTurn, status } });
  }

  async settle(
    sessionId: string,
    turnId: string,
    status: TuiSettledTurn['status'],
    durationMs?: number,
  ): Promise<void> {
    const settledTurn = this.prepare(sessionId, turnId, status);
    if (settledTurn) await this.publish(settledTurn, durationMs);
  }

  private async refreshDelegatedAgentCount(settledTurn: TuiSettledTurn): Promise<number> {
    const refresh = this.options.refreshActiveDelegatedAgentCount;
    if (!refresh) return 0;
    const cancellation = new AbortController();
    const timeout = delay(DELEGATED_REFRESH_TIMEOUT_MS, undefined, {
      signal: cancellation.signal,
    }).then(() => {
      throw new Error(`delegated state refresh exceeded ${DELEGATED_REFRESH_TIMEOUT_MS}ms`);
    });
    try {
      return await Promise.race([Promise.resolve().then(refresh), timeout]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      writeTuiAutomationDiagnostic(
        `[mcode-tui] could not confirm delegated work; applying empty-response contract ` +
          `(session=${settledTurn.sessionId}, turn=${settledTurn.turnId}): ${reason}`,
      );
      return 0;
    } finally {
      cancellation.abort();
    }
  }

  private reportAnswerRecovered(settledTurn: TuiSettledTurn, answer: string): void {
    const message =
      '[mcode-tui] automation result: recovered the delivered answer from the live transcript ' +
      `after durable history rehydration (answerChars=${answer.length}, ` +
      `session=${settledTurn.sessionId}, turn=${settledTurn.turnId})`;
    writeTuiAutomationDiagnostic(message);
  }

  private publishDeliveryFailure(settledTurn: TuiSettledTurn): void {
    const message = 'Could not publish the TUI automation result.';
    this.options.turnProjection.failTurn(settledTurn.turnId, message);
    this.options.turnProjection.clearTurn(settledTurn.turnId);
    this.options.updateState({
      status: 'error',
      error: message,
      errorRetryable: true,
      lastSettledTurn: { ...settledTurn, status: 'failed' },
    });
  }
}

function settledStatus(status: ExecResultV1['status']): TuiSettledTurn['status'] {
  if (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'blocked' ||
    status === 'cancelled'
  ) {
    return status;
  }
  return 'failed';
}
