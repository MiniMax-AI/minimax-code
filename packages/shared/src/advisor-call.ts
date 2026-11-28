/**
 * Timing of one advisor consultation. The runtime enforces the limit; Desktop and the TUI use the
 * same values to tell the user how long a call may still take.
 */

/** Limit on one whole advisor call; past it the call returns `timed_out` and the Turn goes on. */
export const ADVISOR_CALL_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a call runs before clients show its elapsed time. About the median call in the advisor
 * evaluation (p50 16s over 932 calls that returned advice), so most calls never show a clock.
 */
export const ADVISOR_ELAPSED_REVEAL_MS = 15_000;

/**
 * How long a call runs before clients also state the limit and how to interrupt it. About the p90
 * call in the same evaluation (34s), so only the slow tail sees it.
 */
export const ADVISOR_LIMIT_HINT_MS = 35_000;
