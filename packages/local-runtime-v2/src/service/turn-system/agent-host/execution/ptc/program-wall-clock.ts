import type { PtcToolExecutionBatch } from '@mavis/agent-core/tools';

/**
 * Admission time (child hooks and approvals) moves the batch deadline later
 * without counting against the program. `admissionWaitMs` is the part of it
 * that passed while this program ran: the batch's paused total at the end
 * minus the total when the program started (an earlier run_code's approvals
 * already moved the starting deadline). `allowedMs` leaves it out.
 */
export function programWallClock(
  start: {
    readonly batch: PtcToolExecutionBatch | undefined;
    readonly startedAtMs: number;
    readonly wallClockMs: number;
  },
  final: PtcToolExecutionBatch | undefined,
): { readonly allowedMs: number; readonly admissionWaitMs: number } {
  const pausedAtStartMs = start.batch?.pausedMs ?? 0;
  const admissionWaitMs = Math.max(0, (final?.pausedMs ?? pausedAtStartMs) - pausedAtStartMs);
  return {
    allowedMs: allowedWallClockMs(
      start.wallClockMs,
      start.startedAtMs,
      final?.deadlineAtMs,
      admissionWaitMs,
    ),
    admissionWaitMs,
  };
}

/**
 * What a program was finally allowed, including any Bash extension of the
 * batch deadline. Admission time that passed while it ran also moved the
 * deadline but was never program time, so it is taken back out: "This program
 * had N ms" keeps meaning the program's own budget.
 */
function allowedWallClockMs(
  startingMs: number,
  startedAtMs: number,
  deadlineAtMs: number | undefined,
  admissionWaitMs: number,
): number {
  return deadlineAtMs === undefined
    ? startingMs
    : Math.max(startingMs, deadlineAtMs - startedAtMs - admissionWaitMs);
}
