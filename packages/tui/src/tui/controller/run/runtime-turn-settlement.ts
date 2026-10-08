import type { ExecResultError, ExecResultV1 } from '../../../application/exec-result.js';
import type { TranscriptStore } from '../../transcript/store.js';
import { createTuiAutomationTurnResult } from '../../automation/turn-result.js';
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
}

/** Publishes Runtime-owned outcomes after optional result delivery. */
export class TuiRuntimeTurnSettlement {
  constructor(private readonly options: TuiRuntimeTurnSettlementOptions) {}

  enabled(): boolean {
    return Boolean(this.options.writeAutomationResult);
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

  async publish(
    settledTurn: TuiSettledTurn,
    durationMs?: number,
    error?: ExecResultError,
  ): Promise<void> {
    if (await this.requiresQuestionnaireContinuation(settledTurn)) return;
    const writer = this.options.writeAutomationResult;
    if (!writer) {
      this.options.updateState({ lastSettledTurn: settledTurn });
      return;
    }

    const result = createTuiAutomationTurnResult({
      settledTurn,
      transcript: this.options.transcript,
      durationMs,
      ...(error ? { error } : {}),
    });
    try {
      await writer(result);
    } catch {
      this.publishDeliveryFailure(settledTurn);
      return;
    }

    const status = settledStatus(result.status);
    if (status === 'failed') {
      this.options.turnProjection.failTurn(
        settledTurn.turnId,
        result.error?.message ?? 'Runtime turn failed.',
      );
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
