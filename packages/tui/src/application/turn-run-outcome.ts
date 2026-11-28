import type { ExecAdvisorSummary } from './advisor-calls.js';

export type TuiTurnRunStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'awaiting-user-continuation'
  | 'timeout'
  | 'limit_exceeded';

export interface TuiTurnRunError {
  readonly category: 'config' | 'runtime' | 'internal';
  readonly code?: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface TuiTurnRunModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  /**
   * The per-Turn selection that was requested. Runtime resolves the level it
   * actually applies, so this is not evidence of the effective effort.
   */
  readonly thinking?: { readonly effort?: string };
}

export type TuiModelReplacementTier = 'runtime_fallback' | 'runtime_selection';
export type TuiModelReplacementReason =
  | 'requested_model_not_in_runtime_catalog'
  | 'runtime_selected_different_effective_model';

export interface TuiModelReplacement {
  readonly requestedModel: TuiTurnRunModel;
  readonly actualModel: TuiTurnRunModel;
  readonly tier: TuiModelReplacementTier;
  readonly reason: TuiModelReplacementReason;
}

export interface TuiTurnRunUsage {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** Response identity is required to reconcile replayed and persisted usage. */
export interface TuiTurnResponseUsage {
  readonly messageId?: string;
  readonly usage?: TuiTurnRunUsage;
  readonly usageIncomplete?: boolean;
}

/** Application-neutral outcome assembled from Runtime-owned Turn facts. */
export interface TuiTurnRunOutcome {
  readonly sessionId: string;
  readonly turnId: string;
  readonly status: TuiTurnRunStatus;
  readonly answer?: string | null;
  readonly model?: TuiTurnRunModel;
  /** The explicit --model or Session model used as the caller's request. */
  readonly requestedModel?: TuiTurnRunModel;
  readonly modelReplacement?: TuiModelReplacement;
  readonly usage?: TuiTurnRunUsage;
  readonly usageResponses?: readonly TuiTurnResponseUsage[];
  /** Other observed Turn activity has usage outside the completed-response projection. */
  readonly usageIncomplete?: boolean;
  readonly error?: TuiTurnRunError;
  /** Present only when the main model called the advisor in this Turn. */
  readonly advisor?: ExecAdvisorSummary;
  readonly durationMs: number;
}
