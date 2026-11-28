import type {
  PiBeforeLlmCallAppendMessage,
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookInput,
  PiTurnRunnerLogger,
} from '@mavis/agent-core/pi-turn-runner';
import type { ExecutionBudgetReminderAdmission } from '../execution/contracts.js';

const EXECUTION_BUDGET_REMINDER_CUSTOM_TYPE = 'execution_budget_reminder';
const LIFTED_REMINDER =
  '<system-reminder>No execution time limit applies to this turn. Earlier execution time limits applied only to their own turns.</system-reminder>';

type HistoryMessage = PiBeforeLlmCallHookInput['canonicalMessages'][number];

/** Remaining-budget fractions that each emit one reminder when first crossed. */
const BUDGET_FRACTION_THRESHOLDS = [0.5, 0.25, 0.1] as const;
/** Inside this window a reminder is emitted whenever its coarse text changes. */
const FINAL_WINDOW_MS = 120_000;
const FINAL_WINDOW_LEVEL = BUDGET_FRACTION_THRESHOLDS.length + 1;

interface ExecutionBudgetReminderDetails {
  /**
   * Deadline the reminder was sampled for; separates the budgets of different
   * Turns. `null` marks the notice that a later Turn runs without a limit.
   */
  readonly deadlineAtMs: number | null;
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
 * A deadline belongs to one Turn, but its reminders stay visible in later
 * Turns. Instead of rewriting history, a later Turn appends what changed: a
 * Turn without a deadline says once that no limit applies any more, and a new
 * deadline announces that it replaces the earlier one. Both are derived from
 * the latest reminder in canonical history, so the hook holds no state.
 *
 * To avoid spending tokens on every model request, a budgeted Turn emits the
 * reminder on the first request (announces the budget), when the remaining
 * budget first drops to ≤50%, ≤25% and ≤10% of the total, and inside the final
 * two minutes whenever its text changes. Progress is read back from the latest
 * reminder of the same deadline in canonical history, so a repeated request
 * does not duplicate it and a compaction that summarized it away announces the
 * budget again. The total budget is measured from hook creation (turn
 * preparation), since requests carry no start time. Precision is whole minutes
 * outside the final window and 10-second steps inside it.
 */
export function createExecutionBudgetReminder(
  executionDeadlineAtMs: number | undefined,
  nowMs: () => number = Date.now,
  canAppend?: ExecutionBudgetReminderAdmission,
  logger?: Pick<PiTurnRunnerLogger, 'info'>,
): PiBeforeLlmCallHook | undefined {
  if (!canAppend) return undefined;
  if (executionDeadlineAtMs === undefined) return createLiftedLimitReminder(nowMs, canAppend);
  const totalMs = Math.max(0, executionDeadlineAtMs - nowMs());
  return (input) => {
    try {
      if (input.signal?.aborted) return undefined;
      const now = nowMs();
      const remainingMs = executionDeadlineAtMs - now;
      if (remainingMs <= 0) return undefined;
      const level = budgetLevel(remainingMs, totalMs);
      const previous = latestReminder(input.canonicalMessages, executionDeadlineAtMs);
      const content = formatBudgetReminder(
        remainingMs,
        totalMs,
        previous === undefined,
        previous === undefined &&
          supersedesEarlierLimit(input.canonicalMessages, executionDeadlineAtMs),
      );
      if (previous && !isReminderDue(previous, level, content)) return undefined;
      const marker = reminderMarker(content, { deadlineAtMs: executionDeadlineAtMs, level }, now);
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
      return appendReminder(marker);
    } catch {
      return undefined;
    }
  };
}

/**
 * A Turn without a deadline only speaks when the latest reminder in history
 * still describes an earlier limit; after its notice it stays silent.
 */
function createLiftedLimitReminder(
  nowMs: () => number,
  canAppend: ExecutionBudgetReminderAdmission,
): PiBeforeLlmCallHook {
  return (input) => {
    try {
      if (input.signal?.aborted) return undefined;
      const latest = latestAnyReminder(input.canonicalMessages);
      if (latest === undefined || latest.details.deadlineAtMs === null) return undefined;
      const marker = reminderMarker(LIFTED_REMINDER, { deadlineAtMs: null, level: 0 }, nowMs());
      return canAppend(input, marker) ? appendReminder(marker) : undefined;
    } catch {
      return undefined;
    }
  };
}

function reminderMarker(
  content: string,
  details: ExecutionBudgetReminderDetails,
  timestamp: number,
): PiBeforeLlmCallAppendMessage {
  return {
    role: 'custom',
    customType: EXECUTION_BUDGET_REMINDER_CUSTOM_TYPE,
    content,
    display: false,
    details,
    timestamp,
  };
}

function appendReminder(message: PiBeforeLlmCallAppendMessage) {
  return {
    type: 'appendMessage' as const,
    reason: EXECUTION_BUDGET_REMINDER_CUSTOM_TYPE,
    message,
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

/** True when the latest reminder in history still describes another limit. */
function supersedesEarlierLimit(
  messages: readonly HistoryMessage[],
  deadlineAtMs: number,
): boolean {
  const latest = latestAnyReminder(messages)?.details.deadlineAtMs;
  return typeof latest === 'number' && latest !== deadlineAtMs;
}

function latestAnyReminder(
  messages: readonly HistoryMessage[],
): { readonly content: string; readonly details: ExecutionBudgetReminderDetails } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const reminder = readReminder(messages[index]);
    if (reminder) return reminder;
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
  return (typeof deadlineAtMs === 'number' || deadlineAtMs === null) && typeof level === 'number'
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

function formatBudgetReminder(
  remainingMs: number,
  totalMs: number,
  first: boolean,
  replacesEarlier: boolean,
): string {
  const remaining = formatRemainingBudget(remainingMs);
  const total =
    totalMs > FINAL_WINDOW_MS
      ? `${Math.round(totalMs / 60_000)} minutes`
      : `${Math.max(10, Math.round(totalMs / 10_000) * 10)} seconds`;
  const scope = first ? ' Model generation, tools, and waiting all count against it.' : '';
  const replaces = replacesEarlier ? ' This replaces any earlier execution time limit.' : '';
  return `<system-reminder>Execution time remaining for this turn: ${remaining} of ${total} total.${scope}${replaces}</system-reminder>`;
}
