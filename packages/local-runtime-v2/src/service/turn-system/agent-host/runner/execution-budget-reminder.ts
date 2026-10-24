import type {
  PiBeforeLlmCallAppendMessage,
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookInput,
  PiTurnRunnerLogger,
} from '@mavis/agent-core/pi-turn-runner';
import type { ExecutionBudgetReminderAdmission } from '../execution/contracts.js';

const EXECUTION_BUDGET_REMINDER_CUSTOM_TYPE = 'execution_budget_reminder';

type HistoryMessage = PiBeforeLlmCallHookInput['canonicalMessages'][number];

/** Remaining-budget fractions that each emit one reminder when first crossed. */
const BUDGET_FRACTION_THRESHOLDS = [0.5, 0.25, 0.1] as const;
/** Inside this window a reminder is emitted whenever its coarse text changes. */
const FINAL_WINDOW_MS = 120_000;
const FINAL_WINDOW_LEVEL = BUDGET_FRACTION_THRESHOLDS.length + 1;

interface ExecutionBudgetReminderDetails {
  /** Deadline the reminder was sampled for; separates the budgets of different Turns. */
  readonly deadlineAtMs: number;
  readonly level: number;
}

interface PreviousReminder {
  readonly level: number;
  readonly content: string;
}

/**
 * Hidden durable context; the caller's existing cancellation timer remains
 * authoritative. Each reminder is appended to canonical history, so every
 * later provider request keeps it in place and the prompt-cache prefix stays
 * append-only.
 *
 * To avoid spending tokens on every model request, the reminder is emitted
 * on the first request (announces the budget), when the remaining budget first
 * drops to ≤50%, ≤25% and ≤10% of the total, and inside the final two minutes
 * whenever its text changes. Progress is read back from the latest reminder of
 * the same deadline in canonical history, so a repeated request does not
 * duplicate it and a compaction that summarized it away announces the budget
 * again. The total budget is measured from hook creation (turn preparation),
 * since requests carry no start time. Precision is whole minutes outside the
 * final window and 10-second steps inside it.
 */
export function createExecutionBudgetReminder(
  executionDeadlineAtMs: number | undefined,
  nowMs: () => number = Date.now,
  canAppend?: ExecutionBudgetReminderAdmission,
  logger?: Pick<PiTurnRunnerLogger, 'info'>,
): PiBeforeLlmCallHook | undefined {
  if (executionDeadlineAtMs === undefined || !canAppend) return undefined;
  const totalMs = Math.max(0, executionDeadlineAtMs - nowMs());
  return (input) => {
    try {
      if (input.signal?.aborted) return undefined;
      const now = nowMs();
      const remainingMs = executionDeadlineAtMs - now;
      if (remainingMs <= 0) return undefined;
      const level = budgetLevel(remainingMs, totalMs);
      const previous = latestReminder(input.canonicalMessages, executionDeadlineAtMs);
      const content = formatBudgetReminder(remainingMs, totalMs, previous === undefined);
      if (previous && !isReminderDue(previous, level, content)) return undefined;
      const marker: PiBeforeLlmCallAppendMessage = {
        role: 'custom',
        customType: EXECUTION_BUDGET_REMINDER_CUSTOM_TYPE,
        content,
        display: false,
        details: { deadlineAtMs: executionDeadlineAtMs, level },
        timestamp: now,
      };
      if (!canAppend(input, marker)) return undefined;
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
        type: 'appendMessage',
        reason: EXECUTION_BUDGET_REMINDER_CUSTOM_TYPE,
        message: marker,
      };
    } catch {
      return undefined;
    }
  };
}

function isReminderDue(previous: PreviousReminder, level: number, content: string): boolean {
  return level === FINAL_WINDOW_LEVEL ? content !== previous.content : level > previous.level;
}

/** Latest reminder for this deadline; reminders of other budgets are ignored. */
function latestReminder(
  messages: readonly HistoryMessage[],
  deadlineAtMs: number,
): PreviousReminder | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const reminder = readReminder(messages[index]);
    if (reminder?.details.deadlineAtMs === deadlineAtMs) {
      return { level: reminder.details.level, content: reminder.content };
    }
  }
  return undefined;
}

function readReminder(
  message: HistoryMessage | undefined,
): { readonly content: string; readonly details: ExecutionBudgetReminderDetails } | undefined {
  if (
    message?.role !== 'custom' ||
    message.customType !== EXECUTION_BUDGET_REMINDER_CUSTOM_TYPE ||
    typeof message.content !== 'string'
  ) {
    return undefined;
  }
  const details: unknown = message.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const deadlineAtMs = Reflect.get(details, 'deadlineAtMs');
  const level = Reflect.get(details, 'level');
  return typeof deadlineAtMs === 'number' && typeof level === 'number'
    ? { content: message.content, details: { deadlineAtMs, level } }
    : undefined;
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

function formatRemainingBudget(remainingMs: number): string {
  if (remainingMs > FINAL_WINDOW_MS) return `about ${Math.floor(remainingMs / 60_000)} minutes`;
  if (remainingMs >= 10_000) return `about ${Math.floor(remainingMs / 10_000) * 10} seconds`;
  return 'under 10 seconds';
}

function formatBudgetReminder(remainingMs: number, totalMs: number, first: boolean): string {
  const remaining = formatRemainingBudget(remainingMs);
  const total =
    totalMs > FINAL_WINDOW_MS
      ? `${Math.round(totalMs / 60_000)} minutes`
      : `${Math.max(10, Math.round(totalMs / 10_000) * 10)} seconds`;
  const scope = first ? ' Model generation, tools, and waiting all count against it.' : '';
  return `<system-reminder>Execution time remaining: ${remaining} of ${total} total.${scope}</system-reminder>`;
}
