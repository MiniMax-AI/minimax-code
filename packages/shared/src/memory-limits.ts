/**
 * Memory size limits and thresholds — shared across daemon, legacy local-runtime plugin, and CLI.
 *
 * Layered memory architecture:
 *   - MEMORY.md (hot layer, always injected)
 *   - memory/<topic>.md (on-demand topic files with frontmatter description)
 *   - daily/<date>.md (daily digests, 60-day TTL)
 */

/** Soft target for MEMORY.md (hot layer). Above this, cleanup is encouraged but not forced. */
export const MEMORY_SOFT_LIMIT_BYTES = 15 * 1024; // 15KB

/** Hard limit for MEMORY.md. Above this, immediate cleanup is triggered. */
export const MEMORY_HARD_LIMIT_BYTES = 20 * 1024; // 20KB

/**
 * Threshold above which memory.append triggers an immediate cleanup spawn.
 * Sits between soft and hard so we curate proactively before hitting the hard cap.
 */
export const MEMORY_CLEANUP_TRIGGER_BYTES = 18 * 1024; // 18KB

/**
 * @deprecated No longer used for injection. Replaced by MEMORY_SUMMARY_INJECTION_CAP_CHARS
 * and MEMORY_TAIL_INJECTION_CAP_CHARS which provide separate budgets for summary and tail.
 * Kept for backward compatibility with any external consumers.
 */
export const MEMORY_INJECTION_CAP_CHARS = MEMORY_HARD_LIMIT_BYTES;

/** 每轮自动注入的全部 V1 记忆块共用的字符预算，包含正文、包装和分隔符。 */
export const MEMORY_CONTEXT_CAP_CHARS = 16 * 1024;

/** 原生 memory 工具单次返回的字节预算。 */
export const MEMORY_TOOL_OUTPUT_MAX_BYTES = 16 * 1024;

/**
 * Maximum characters of the .summary.md (compressed index) to inject.
 * Kept small so it fits alongside the tail without blowing out the token budget.
 */
export const MEMORY_SUMMARY_INJECTION_CAP_CHARS = 4 * 1024; // 4KB

/**
 * Maximum characters of the MEMORY.md tail to inject into system prompt.
 * After cleanup, MEMORY.md is expected to be ≤ 10KB, so this cap is generous.
 * Combined with .summary.md the total budget is ~14KB (vs previous 20KB flat).
 */
export const MEMORY_TAIL_INJECTION_CAP_CHARS = 10 * 1024; // 10KB

/** Maximum characters of daily digest content to inject for recent days (day 0-1). */
export const DAILY_RECENT_CAP_CHARS = 10 * 1024; // ~10K chars

/** Maximum topic files allowed per agent. Hard cap enforced by topic CRUD. */
export const MAX_TOPIC_FILES = 10;

/** Maximum size per topic file. */
export const MAX_TOPIC_FILE_BYTES = 30 * 1024; // 30KB

/** Daily digest TTL in days — older daily files get archived. */
export const DAILY_DIGEST_TTL_DAYS = 60;

/**
 * Minimum interval (ms) between immediate cleanup spawns for the same agent.
 * Prevents storm of cleanup sessions when an agent writes a lot in a short window.
 */
export const CLEANUP_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Minimum MEMORY.md size (bytes) required before the daily-cron cleanup runs.
 * After cleanup, MEMORY.md is expected to be ≤ 10KB — so if memory is already
 * under this threshold, running cleanup would be a no-op and waste tokens.
 */
export const MEMORY_CLEANUP_MIN_BYTES = 10 * 1024; // 10KB
