/**
 * SQLite-backed `ThreadGoalStore` implementation for local-runtime.
 *
 * Schema lives in `persistence/db.ts` migration v13 (table
 * `local_runtime_thread_goals`). `session_id` carries a UNIQUE index so
 * each session has at most one goal row at any time, matching codex's
 * `thread_goals.thread_id PRIMARY KEY` semantics.
 *
 * Timestamps are stored as Unix ms (project rule — no ISO strings in
 * storage / API).
 */

import {
  ThreadGoalAlreadyExistsError,
  type GoalTurnBinding,
  type ThreadGoalBoundUsageDelta,
  type ThreadGoalBoundUsageResult,
  type ThreadGoalBudgetLimits,
  type ThreadGoalBreakerInput,
  type ThreadGoalBreakerResult,
  type ThreadGoalCreateInput,
  type ThreadGoalDecisionResult,
  type ThreadGoalKickoffState,
  type ThreadGoalPatchInput,
  type ThreadGoalRecordVerificationInput,
  type ThreadGoalSettleBoundTurnInput,
  type ThreadGoalState,
  type ThreadGoalStatusReason,
  type ThreadGoalStore,
  type ThreadGoalWaitReason,
} from '@mavis/goal';

import {
  type DataDirInput,
  type DatabaseLike,
  runInImmediateTransaction,
  withLocalRuntimeDb,
} from '../persistence/db.js';
import { runGoalStoreWrite } from './db-write-lock.js';
import { updateThreadGoalBreaker } from './store-breaker.js';
import { bumpThreadGoalBoundUsage, settleThreadGoalBoundTurn } from './store-bound-settlement.js';
import {
  clearThreadGoalExecutionWait,
  listThreadGoalsWaitingOnVerification,
  setThreadGoalExecutionWait,
} from './store-execution.js';
import { patchThreadGoal } from './store-patch.js';
import { recordThreadGoalVerification } from './store-verification.js';
import {
  newThreadGoalId,
  positiveOrNull,
  rowToThreadGoalState,
  type ThreadGoalDbRow,
} from './store-row.js';

export class SqliteThreadGoalStore implements ThreadGoalStore {
  constructor(
    private readonly dataDir: DataDirInput,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly genId: () => string = newThreadGoalId,
  ) {}

  async getBySession(sessionId: string): Promise<ThreadGoalState | undefined> {
    return this.withDb((db) => {
      const row = db
        .prepare(`SELECT * FROM local_runtime_thread_goals WHERE session_id = ?`)
        .get(sessionId) as ThreadGoalDbRow | undefined;
      return rowToThreadGoalState(row);
    });
  }

  async getById(goalId: string): Promise<ThreadGoalState | undefined> {
    return this.withDb((db) => {
      const row = db
        .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
        .get(goalId) as ThreadGoalDbRow | undefined;
      return rowToThreadGoalState(row);
    });
  }

  /**
   * Atomically pause the session's goal only while it is still active.
   * Used by the explicit session-abort path so a concurrent model update
   * cannot reopen or overwrite an already-terminal goal.
   */
  async pauseActiveBySession(
    sessionId: string,
    statusReason: ThreadGoalStatusReason = 'paused(user_requested)',
  ): Promise<ThreadGoalState | undefined> {
    return this.withWriteDb((db) => {
      const now = this.nowMs();
      const result = db
        .prepare(
          `UPDATE local_runtime_thread_goals
           SET status = 'paused', status_reason = ?,
               updated_at_ms = MAX(?, updated_at_ms + 1)
           WHERE session_id = ? AND status = 'active'`,
        )
        .run(statusReason, now, sessionId) as { changes?: number };
      if ((result.changes ?? 0) === 0) return undefined;

      const row = db
        .prepare(`SELECT * FROM local_runtime_thread_goals WHERE session_id = ?`)
        .get(sessionId) as ThreadGoalDbRow | undefined;
      return rowToThreadGoalState(row);
    });
  }

  /** Apply a final-admission typed stop only to the exact active Goal epoch. */
  async transitionActiveAtEpoch(
    goalId: string,
    expectedEpoch: number,
    input: {
      readonly status: 'paused' | 'budget_limited';
      readonly statusReason: ThreadGoalStatusReason;
    },
  ): Promise<ThreadGoalState | undefined> {
    return this.withWriteDb((db) =>
      runInImmediateTransaction(db, () => {
        const nextEpoch = Math.max(this.nowMs(), expectedEpoch + 1);
        const result = db
          .prepare(
            `UPDATE local_runtime_thread_goals
             SET status = ?, status_reason = ?, updated_at_ms = ?
             WHERE goal_id = ? AND updated_at_ms = ? AND status = 'active'`,
          )
          .run(input.status, input.statusReason, nextEpoch, goalId, expectedEpoch) as {
          changes?: number;
        };
        if ((result.changes ?? 0) === 0) return undefined;
        const row = db
          .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
          .get(goalId) as ThreadGoalDbRow | undefined;
        return rowToThreadGoalState(row);
      }),
    );
  }

  /** Explicit user work resets breaker state and invalidates older bindings. */
  async resetBreakerAtEpoch(
    goalId: string,
    expectedEpoch: number,
  ): Promise<ThreadGoalState | undefined> {
    return this.withWriteDb((db) =>
      runInImmediateTransaction(db, () => {
        const nextEpoch = Math.max(this.nowMs(), expectedEpoch + 1);
        const result = db
          .prepare(
            `UPDATE local_runtime_thread_goals
             SET reply_fingerprint = NULL, no_progress_streak = 0, no_tool_streak = 0,
                 updated_at_ms = ?
             WHERE goal_id = ? AND updated_at_ms = ? AND status = 'active'`,
          )
          .run(nextEpoch, goalId, expectedEpoch) as { changes?: number };
        if ((result.changes ?? 0) === 0) return undefined;
        const row = db
          .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
          .get(goalId) as ThreadGoalDbRow | undefined;
        return rowToThreadGoalState(row);
      }),
    );
  }

  async create(input: ThreadGoalCreateInput): Promise<ThreadGoalState> {
    return this.withWriteDb((db) =>
      runInImmediateTransaction(db, () => {
        // codex parity (`insert_thread_goal`'s `ON CONFLICT … WHERE
        // status = 'complete'`): silently replace ONLY a complete goal.
        // active / paused / blocked / budget_limited all count as
        // unfinished — the model (or user) must finish or clear them
        // before starting a new one.
        const existing = db
          .prepare(`SELECT goal_id, status FROM local_runtime_thread_goals WHERE session_id = ?`)
          .get(input.sessionId) as ThreadGoalDbRow | undefined;
        if (existing && existing.status !== 'complete') {
          throw new ThreadGoalAlreadyExistsError(existing.goal_id ?? '');
        }
        if (existing) {
          // Complete goal — the model has signed off on it already, so a
          // new objective is semantically a fresh start. Replace it.
          db.prepare(`DELETE FROM local_runtime_thread_goals WHERE session_id = ?`).run(
            input.sessionId,
          );
        }

        const now = this.nowMs();
        const goalId = this.genId();
        const tokenBudget = positiveOrNull(input.tokenBudget ?? null);
        const kickoffAttachments = (input.kickoffAttachments ?? []).map((attachment) => ({
          ...attachment,
        }));
        db.prepare(
          `INSERT INTO local_runtime_thread_goals
         (
           goal_id, session_id, objective, status, created_at_ms, updated_at_ms,
           token_budget, kickoff_attachments_json, kickoff_state, objective_resources_json
         )
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, 'pending', ?)`,
        ).run(
          goalId,
          input.sessionId,
          input.objective,
          now,
          now,
          tokenBudget,
          JSON.stringify(kickoffAttachments),
          JSON.stringify(input.objectiveResources ?? []),
        );

        return {
          goalId,
          sessionId: input.sessionId,
          objective: input.objective,
          objectiveResources: input.objectiveResources ?? [],
          status: 'active',
          createdAt: now,
          updatedAt: now,
          tokensUsed: 0,
          turnsUsed: 0,
          timeUsedSeconds: 0,
          tokenBudget,
          replyFingerprint: null,
          noProgressStreak: 0,
          noToolStreak: 0,
          lastVerification: undefined,
          statusReason: null,
          kickoffAttachments,
          kickoffState: 'pending',
          executionWait: null,
        };
      }),
    );
  }

  async patch(goalId: string, input: ThreadGoalPatchInput): Promise<ThreadGoalState> {
    return this.withWriteDb((db) => patchThreadGoal(db, this.nowMs, goalId, input));
  }

  /** User-authored Goal mutations; kept distinct from host settlement CAS. */
  async patchByUser(goalId: string, input: ThreadGoalPatchInput): Promise<ThreadGoalState> {
    return this.patch(goalId, input);
  }

  async bumpBoundUsage(
    binding: GoalTurnBinding,
    delta: ThreadGoalBoundUsageDelta,
    limits: ThreadGoalBudgetLimits,
  ): Promise<ThreadGoalBoundUsageResult> {
    return this.withWriteDb((db) => bumpThreadGoalBoundUsage(db, this.nowMs, binding, delta, limits));
  }

  async settleBoundTurn(input: ThreadGoalSettleBoundTurnInput): Promise<ThreadGoalDecisionResult> {
    return this.withWriteDb((db) => settleThreadGoalBoundTurn(db, this.nowMs, input));
  }

  async updateBreaker(
    goalId: string,
    input: ThreadGoalBreakerInput,
  ): Promise<ThreadGoalBreakerResult> {
    return this.withWriteDb((db) => updateThreadGoalBreaker(db, this.nowMs, goalId, input));
  }

  async recordVerification(
    input: ThreadGoalRecordVerificationInput,
  ): Promise<ThreadGoalDecisionResult> {
    return this.withWriteDb((db) => recordThreadGoalVerification(db, this.nowMs, input));
  }

  async delete(goalId: string): Promise<void> {
    await this.withWriteDb((db) => {
      db.prepare(`DELETE FROM local_runtime_thread_goals WHERE goal_id = ?`).run(goalId);
    });
  }

  async listRecoverableKickoffs(): Promise<ThreadGoalState[]> {
    return this.withDb((db) =>
      db
        .prepare(
          `SELECT * FROM local_runtime_thread_goals
           WHERE kickoff_state IN ('pending', 'enqueued')
             AND status <> 'complete'
           ORDER BY created_at_ms, goal_id`,
        )
        .all()
        .flatMap((row) => {
          const state = rowToThreadGoalState(row as ThreadGoalDbRow);
          return state ? [state] : [];
        }),
    );
  }

  async listRecoverableActiveGoals(): Promise<ThreadGoalState[]> {
    return this.withDb((db) =>
      db
        .prepare(
          `SELECT * FROM local_runtime_thread_goals
           WHERE kickoff_state = 'consumed'
             AND status = 'active'
           ORDER BY updated_at_ms, goal_id`,
        )
        .all()
        .flatMap((row) => {
          const state = rowToThreadGoalState(row as ThreadGoalDbRow);
          return state ? [state] : [];
        }),
    );
  }

  /** Budget summaries are replayed with an epoch-derived idempotency key. */
  async listRecoverableBudgetLimitSummaries(): Promise<ThreadGoalState[]> {
    return this.withDb((db) =>
      db
        .prepare(
          `SELECT * FROM local_runtime_thread_goals
           WHERE status = 'budget_limited'
           ORDER BY updated_at_ms, goal_id`,
        )
        .all()
        .flatMap((row) => {
          const state = rowToThreadGoalState(row as ThreadGoalDbRow);
          return state ? [state] : [];
        }),
    );
  }

  async transitionKickoffState(
    goalId: string,
    expected: ThreadGoalKickoffState,
    next: ThreadGoalKickoffState,
  ): Promise<ThreadGoalState | undefined> {
    return this.withWriteDb((db) => {
      const result = db
        .prepare(
          `UPDATE local_runtime_thread_goals
           SET kickoff_state = ?
           WHERE goal_id = ? AND kickoff_state = ?`,
        )
        .run(next, goalId, expected) as { changes?: number };
      if ((result.changes ?? 0) === 0) return undefined;
      const row = db
        .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
        .get(goalId) as ThreadGoalDbRow | undefined;
      return rowToThreadGoalState(row);
    });
  }

  async setExecutionWaitAtEpoch(input: {
    readonly goalId: string;
    readonly expectedUpdatedAt: number;
    readonly reason: ThreadGoalWaitReason;
  }): Promise<ThreadGoalState | undefined> {
    return this.withWriteDb((db) => setThreadGoalExecutionWait(db, { ...input, nowMs: this.nowMs() }));
  }

  async clearExecutionWaitAtEpoch(input: {
    readonly goalId: string;
    readonly expectedUpdatedAt: number;
  }): Promise<ThreadGoalState | undefined> {
    return this.withWriteDb((db) => clearThreadGoalExecutionWait(db, input));
  }

  /** Goals still showing `verification` — only ever stale rows at startup. */
  async listGoalsWaitingOnVerification(): Promise<ThreadGoalState[]> {
    return this.withDb((db) => listThreadGoalsWaitingOnVerification(db));
  }

  private withDb<T>(fn: (db: DatabaseLike) => T): T {
    return withLocalRuntimeDb(this.dataDir, fn);
  }

  /**
   * Writes share `runtime-state.sqlite` with every other `mcode` process, so
   * they retry lock acquisition instead of failing the Turn on SQLITE_BUSY.
   */
  private withWriteDb<T>(fn: (db: DatabaseLike) => T): Promise<T> {
    return runGoalStoreWrite(this.dataDir, fn);
  }
}
