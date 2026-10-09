import type { PiBeforeLlmCallHook, PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import type { ExecutionBudgetReminderAdmission } from '../execution/contracts.js';

/** Remaining-budget fractions that each emit one reminder when first crossed. */
const BUDGET_FRACTION_THRESHOLDS = [0.5, 0.25, 0.1] as const;
/** Inside this window every request carries a (coarse) reminder. */
const FINAL_WINDOW_MS = 120_000;
const FINAL_WINDOW_LEVEL = BUDGET_FRACTION_THRESHOLDS.length + 1;

/**
 * Request-only context; the caller's existing cancellation timer remains
 * authoritative. `replaceRequestMessages` keeps the marker out of durable
 * history, so it must be registered before any hook that returns
 * `appendMessage` — `runBeforeLLM` ends the pipeline on a successful append.
 *
 * To avoid spending tokens on every model request, the reminder is emitted
 * only on the first request (announces the budget), when the remaining budget
 * first drops to ≤50%, ≤25% and ≤10% of the total, and on every request inside
 * the final two minutes. The total budget is measured from hook creation
 * (turn preparation), since requests carry no start time. Precision is whole
 * minutes outside the final window and 10-second steps inside it, so the text
 * does not churn between otherwise identical requests.
 */
export function createExecutionBudgetReminder(
  executionDeadlineAtMs: number | undefined,
  nowMs: () => number = Date.now,
  canAppend?: ExecutionBudgetReminderAdmission,
  logger?: Pick<PiTurnRunnerLogger, 'info'>,
): PiBeforeLlmCallHook | undefined {
  if (executionDeadlineAtMs === undefined || !canAppend) return undefined;
  const totalMs = Math.max(0, executionDeadlineAtMs - nowMs());
  let emittedLevel: number | undefined;
  return (input) => {
    try {
      if (input.signal?.aborted) return undefined;
      const now = nowMs();
      const remainingMs = executionDeadlineAtMs - now;
      if (remainingMs <= 0) return undefined;
      const level = budgetLevel(remainingMs, totalMs);
      const first = emittedLevel === undefined;
      if (!first && level !== FINAL_WINDOW_LEVEL && level <= emittedLevel!) return undefined;
      const marker = {
        role: 'user' as const,
        content: formatBudgetReminder(remainingMs, totalMs, first),
        timestamp: now,
      };
      if (!canAppend(input, marker)) return undefined;
      emittedLevel = level;
      try {
        logger?.info?.(
          {
            session_id: input.sessionId,
            turn_id: input.turnId,
            sampled_at_ms: now,
            remaining_ms: remainingMs,
            total_ms: totalMs,
            budget_level: level,
          },
          'execution budget context sampled',
        );
      } catch {
        // Diagnostics must not affect the request context.
      }
      return {
        type: 'replaceRequestMessages',
        reason: 'execution-budget-context',
        messages: [...input.messages, marker],
      };
    } catch {
      return undefined;
    }
  };
}

/** 0 = above 50%; 1..3 = crossed 50/25/10%; FINAL_WINDOW_LEVEL = final two minutes. */
function budgetLevel(remainingMs: number, totalMs: number): number {
  if (remainingMs <= FINAL_WINDOW_MS) return FINAL_WINDOW_LEVEL;
  let level = 0;
  BUDGET_FRACTION_THRESHOLDS.forEach((fraction, index) => {
    if (remainingMs <= totalMs * fraction) level = index + 1;
  });
  return level;
}

function formatBudgetReminder(remainingMs: number, totalMs: number, first: boolean): string {
  const remaining =
    remainingMs > FINAL_WINDOW_MS
      ? `about ${Math.floor(remainingMs / 60_000)} minutes`
      : remainingMs >= 10_000
        ? `about ${Math.floor(remainingMs / 10_000) * 10} seconds`
        : 'under 10 seconds';
  const total =
    totalMs > FINAL_WINDOW_MS
      ? `${Math.round(totalMs / 60_000)} minutes`
      : `${Math.max(10, Math.round(totalMs / 10_000) * 10)} seconds`;
  const scope = first ? ' Model generation, tools, and waiting all count against it.' : '';
  return `<system-reminder>Execution time remaining: ${remaining} of ${total} total.${scope}</system-reminder>`;
}
