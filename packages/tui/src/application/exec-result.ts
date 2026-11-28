import { isExecAdvisorSummary, type ExecAdvisorSummary } from './advisor-calls.js';
import type { TuiTurnRunOutcome } from './turn-run-outcome.js';

export type ExecResultStatus =
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'timeout'
  | 'cancelled'
  | 'limit_exceeded';

export interface ExecResultError {
  readonly category: 'config' | 'runtime' | 'internal';
  readonly code?: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface ExecResultModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
}

/** Small process-local result assembled by TUI/Headless from Runtime-owned stream facts. */
export interface ExecResultV1 {
  readonly schemaVersion: 1;
  readonly type: 'exec.result';
  readonly sessionId: string;
  readonly turnId: string;
  readonly status: ExecResultStatus;
  readonly answer?: string | null;
  readonly model?: ExecResultModel;
  readonly error?: ExecResultError;
  /** Present only when the main model called the advisor in this Turn. */
  readonly advisor?: ExecAdvisorSummary;
  readonly durationMs: number;
}

export function createExecResultV1(outcome: TuiTurnRunOutcome): ExecResultV1 {
  return {
    schemaVersion: 1,
    type: 'exec.result',
    sessionId: outcome.sessionId,
    turnId: outcome.turnId,
    status:
      outcome.status === 'awaiting-user-continuation' ? 'blocked' : outcome.status,
    answer: outcome.answer ?? null,
    ...(outcome.model ? { model: { ...outcome.model } } : {}),
    ...(outcome.error ? { error: { ...outcome.error } } : {}),
    ...(outcome.advisor ? { advisor: outcome.advisor } : {}),
    durationMs: outcome.durationMs,
  };
}

export function isExecResultV1(value: unknown): value is ExecResultV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<ExecResultV1>;
  const validModel =
    result.model === undefined ||
    (typeof result.model === 'object' &&
      result.model !== null &&
      typeof result.model.providerId === 'string' &&
      typeof result.model.modelId === 'string' &&
      (result.model.variant === undefined || typeof result.model.variant === 'string'));
  return (
    result.schemaVersion === 1 &&
    result.type === 'exec.result' &&
    typeof result.sessionId === 'string' &&
    typeof result.turnId === 'string' &&
    typeof result.durationMs === 'number' &&
    validModel &&
    (result.advisor === undefined || isExecAdvisorSummary(result.advisor)) &&
    (result.status === 'succeeded' ||
      result.status === 'failed' ||
      result.status === 'blocked' ||
      result.status === 'timeout' ||
      result.status === 'cancelled' ||
      result.status === 'limit_exceeded')
  );
}
