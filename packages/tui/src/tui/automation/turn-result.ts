import type { ExecAdvisorSummary } from '../../application/advisor-calls.js';
import type { ExecResultError, ExecResultV1 } from '../../application/exec-result.js';
import type { TuiSettledTurn } from '../controller/chat-controller-types.js';
import type { TranscriptStore } from '../transcript/store.js';

export interface CreateTuiAutomationTurnResultInput {
  readonly agentName?: string;
  readonly settledTurn: TuiSettledTurn;
  readonly transcript: TranscriptStore;
  /** Answer captured by runtime-turn-settlement before history rehydration. */
  readonly capturedAnswer?: string | null;
  readonly durationMs?: number;
  readonly error?: ExecResultError;
  readonly advisor?: ExecAdvisorSummary;
}

export function createTuiAutomationTurnResult(
  input: CreateTuiAutomationTurnResultInput,
): ExecResultV1 {
  const answer =
    assistantAnswerForTurn(input.transcript, input.settledTurn.turnId, input.agentName) ??
    capturedAnswerOrNull(input.capturedAnswer);
  let status: ExecResultV1['status'] = input.settledTurn.status;
  let error = input.error;
  if (status === 'succeeded' && answer === null) {
    status = 'failed';
    error = {
      category: 'runtime',
      code: 'EMPTY_RESPONSE',
      message: 'Runtime completed without a final assistant response.',
      retryable: true,
    };
  } else if (status === 'failed' && !error) {
    error = {
      category: 'runtime',
      message: 'Runtime turn failed.',
    };
  }

  return {
    schemaVersion: 1,
    type: 'exec.result',
    sessionId: input.settledTurn.sessionId,
    turnId: input.settledTurn.turnId,
    status,
    answer,
    ...(error ? { error } : {}),
    ...(input.advisor ? { advisor: input.advisor } : {}),
    durationMs: validDuration(input.durationMs),
  };
}

export function assistantAnswerForTurn(
  transcript: TranscriptStore,
  turnId: string,
  _agentName?: string,
): string | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const cell = transcript.cellAt(index);
    if (
      !cell ||
      cell.kind !== 'assistant' ||
      cell.turnId !== turnId ||
      !cell.content.trim()
    ) {
      continue;
    }
    return cell.content;
  }
  return null;
}

function capturedAnswerOrNull(capturedAnswer: string | null | undefined): string | null {
  return capturedAnswer !== undefined && capturedAnswer !== null && capturedAnswer.trim()
    ? capturedAnswer
    : null;
}

function validDuration(durationMs: number | undefined): number {
  return durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs
    : 0;
}
