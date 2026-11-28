import type * as acp from '@agentclientprotocol/sdk';

import {
  normalizeTurnUsage,
  resolveTurnExecutionFacts,
  type TuiTurnExecutionFactsRuntime,
  type TuiTurnModelIdentity,
} from '../application/turn-execution-facts.js';
import type { TuiTurnRunOutcome, TuiTurnRunUsage } from '../application/turn-run-outcome.js';

const TUI_ACP_TURN_META_KEY = 'minimax-code/turn';

/** MCode Turn facts published in `PromptResponse._meta["minimax-code/turn"]`. */
export interface TuiAcpTurnMeta {
  /** Identifies this ACP Prompt execution; stable across questionnaire continuations. */
  readonly runId: string;
  /** Runtime Turn admitted for this Prompt. */
  readonly turnId: string;
  /**
   * Later Runtime Turns followed within the same Prompt: questionnaire continuations and
   * Turns that background work, queues, Goals or self reminders start before it ends.
   */
  readonly continuationTurnIds?: readonly string[];
  readonly model?: TuiTurnModelIdentity;
  readonly durationMs: number;
  /** True when `usage` is absent or may not cover every provider call of the Prompt. */
  readonly usageIncomplete: boolean;
}

function tuiAcpRunId(turnId: string): string {
  return `acp_${turnId}`;
}

/** Builds the Prompt response from the same Runtime Turn facts that `mcode exec` publishes. */
export async function createTuiAcpPromptResponse(options: {
  readonly runtime: TuiTurnExecutionFactsRuntime;
  readonly sessionId: string;
  readonly stopReason: acp.StopReason;
  readonly outcome: TuiTurnRunOutcome;
  readonly continuationTurnIds: readonly string[];
  readonly durationMs: number;
}): Promise<acp.PromptResponse> {
  const turnIds = [options.outcome.turnId, ...options.continuationTurnIds];
  const facts = await Promise.all(
    turnIds.map((turnId, index) =>
      resolveTurnExecutionFacts(
        options.runtime,
        options.sessionId,
        turnId,
        index === 0 ? initialOutcome(options) : continuationOutcome(options, turnId),
      ),
    ),
  );
  const combined = sumTurnUsage(facts.map((fact) => fact.usage));
  const usage = toAcpUsage(combined.usage);
  const model = [...facts].reverse().find((fact) => fact.model)?.model;
  const meta: TuiAcpTurnMeta = {
    runId: tuiAcpRunId(options.outcome.turnId),
    turnId: options.outcome.turnId,
    ...(options.continuationTurnIds.length > 0
      ? { continuationTurnIds: [...options.continuationTurnIds] }
      : {}),
    ...(model ? { model } : {}),
    durationMs: Math.max(0, Math.round(options.durationMs)),
    usageIncomplete: !usage || combined.incomplete || facts.some((fact) => fact.usageIncomplete),
  };
  return {
    stopReason: options.stopReason,
    ...(usage ? { usage } : {}),
    _meta: { [TUI_ACP_TURN_META_KEY]: meta },
  };
}

function initialOutcome(options: {
  readonly outcome: TuiTurnRunOutcome;
  readonly stopReason: acp.StopReason;
}): TuiTurnRunOutcome {
  // A questionnaire hand-off ends the admitted Turn normally; its responses are complete.
  return options.outcome.status === 'awaiting-user-continuation' &&
    options.stopReason === 'end_turn'
    ? { ...options.outcome, status: 'succeeded' }
    : options.outcome;
}

function continuationOutcome(
  options: { readonly outcome: TuiTurnRunOutcome; readonly stopReason: acp.StopReason },
  turnId: string,
): TuiTurnRunOutcome {
  // Continuation Turns are observed through history only; usage comes from persisted responses.
  return {
    sessionId: options.outcome.sessionId,
    turnId,
    status: options.stopReason === 'end_turn' ? 'succeeded' : 'cancelled',
    durationMs: 0,
  };
}

function sumTurnUsage(values: readonly (TuiTurnRunUsage | undefined)[]): {
  readonly usage?: TuiTurnRunUsage;
  readonly incomplete: boolean;
} {
  const keys = [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
  ] as const;
  const sum: { -readonly [K in (typeof keys)[number]]?: number } = {};
  for (const value of values) {
    if (!value) continue;
    for (const key of keys) {
      const amount = value[key];
      if (amount !== undefined) sum[key] = (sum[key] ?? 0) + amount;
    }
  }
  const usage = normalizeTurnUsage(sum);
  return {
    ...(usage ? { usage } : {}),
    incomplete: values.some((value) => value === undefined),
  };
}

function toAcpUsage(usage: TuiTurnRunUsage | undefined): acp.Usage | undefined {
  // ACP requires input, output and total counts; never fabricate a missing side as zero.
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return {
    // normalizeTurnUsage already sums every token type, as ACP defines the total.
    totalTokens:
      usage.totalTokens ??
      usage.inputTokens +
        usage.outputTokens +
        (usage.cacheReadTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.reasoningTokens !== undefined ? { thoughtTokens: usage.reasoningTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cachedReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cachedWriteTokens: usage.cacheWriteTokens } : {}),
  };
}
