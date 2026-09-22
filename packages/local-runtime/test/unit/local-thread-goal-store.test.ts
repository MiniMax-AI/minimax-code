/**
 * `SqliteThreadGoalStore` — MR-1 accounting + MR-2 tokenBudget /
 * BudgetLimited coverage.
 *
 * Pins:
 *   - `create` returns tokensUsed=0 / timeUsedSeconds=0 for a fresh goal,
 *     and `tokenBudget` round-trips through DB (null vs positive integer)
 *   - `bumpBoundUsage` adds non-negative deltas, bumps the decision epoch when
 *     it actually decides something (and keeps it on a stale, decision-free
 *     charge), and no-ops on a 0+0 delta (avoids spurious SSE re-renders)
 *   - `bumpBoundUsage` on an unknown goalId returns typed `missing_goal`
 *   - `bumpBoundUsage` auto-transitions `active` → `budget_limited` once
 *     `tokensUsed >= tokenBudget` and reports `transitioned`
 *   - the transition does NOT fire when `tokenBudget` is null, when the
 *     goal is already in a terminal state, or on the second bump after
 *     the first transition (we still flip a second time on `active`-only)
 *   - `patch` leaves accounting columns untouched, accepts tokenBudget,
 *     and `patch(... tokenBudget: null)` clears the cap
 *   - Round-trip through a fresh store instance proves both v14 and v15
 *     ALTER columns are durable on disk
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  digestThreadGoalObjective,
  type GoalTurnBinding,
  type LastVerificationV1,
} from "@mavis/goal";

import {
  closeLocalRuntimeDb,
  openLocalRuntimeDb,
  resolveLocalRuntimeDbPath,
} from "../../src/persistence/db.js";
import { SqliteThreadGoalStore } from "../../src/thread-goal/store.js";

async function withDataDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "goal-accounting-"));
  try {
    await fn(dataDir);
  } finally {
    closeLocalRuntimeDb(dataDir);
    await rm(dataDir, { recursive: true, force: true });
  }
}

const TEST_LIMITS = {
  tokens: 10_000,
  mainTurns: 10,
  activeSeconds: 1_000,
} as const;

function bindingFor(
  goal: {
    readonly goalId: string;
    readonly updatedAt: number;
    readonly objective: string;
  },
  overrides: Partial<GoalTurnBinding> = {},
): GoalTurnBinding {
  return {
    goalId: goal.goalId,
    admittedGoalUpdatedAt: goal.updatedAt,
    objectiveDigest: digestThreadGoalObjective(goal.objective),
    turnId: "turn-bound",
    ...overrides,
  };
}

function verificationResult(
  goal: { readonly objective: string },
  overrides: Partial<LastVerificationV1> = {},
): LastVerificationV1 {
  return {
    v: 1,
    backend: "evaluator",
    verdict: "not_met",
    reason: "More evidence is required.",
    missing: ["test evidence"],
    notMetStreak: 0,
    turnId: "turn-verifier",
    objectiveDigest: digestThreadGoalObjective(goal.objective),
    at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("SqliteThreadGoalStore — accounting + budget", () => {
  it.each([false, true])("idempotently upgrades a pre-v31 database without persisting Goal verification policy (historical indexing marker: %s)", async (hasHistoricalIndexingMarker) => {
    await withDataDir(async (dataDir) => {
      const db = openLocalRuntimeDb(dataDir);
      if (hasHistoricalIndexingMarker) {
        db.prepare("INSERT INTO local_runtime_schema_migrations (version, applied_at_ms) VALUES (?, ?)").run(28, 1);
      }
      db.exec(`
        DROP TABLE local_runtime_thread_goals;
        CREATE TABLE local_runtime_thread_goals (
          goal_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL UNIQUE,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );
        INSERT INTO local_runtime_thread_goals (
          goal_id, session_id, objective, status, created_at_ms, updated_at_ms
        ) VALUES ('goal-old', 'session-old', 'old goal', 'active', 1, 1);
        DELETE FROM local_runtime_schema_migrations WHERE version IN (27, 29, 30, 31);
      `);
      closeLocalRuntimeDb(dataDir);

      const upgraded = openLocalRuntimeDb(dataDir);
      const columns = upgraded
        .prepare("PRAGMA table_info(local_runtime_thread_goals)")
        .all()
        .map((row) => String((row as { name?: unknown }).name));
      const migrationVersions = upgraded
        .prepare(
          "SELECT version FROM local_runtime_schema_migrations WHERE version IN (26, 27, 28, 29, 30, 31) ORDER BY version",
        )
        .all()
        .map((row) => Number((row as { version?: unknown }).version));
      const legacyGoal = upgraded
        .prepare(
          `SELECT kickoff_attachments_json, kickoff_state, turns_used, reply_fingerprint,
                  no_progress_streak, last_verification, last_worker_proposal, status_reason,
                  execution_wait_reason, execution_wait_since_ms, execution_wait_epoch
           FROM local_runtime_thread_goals WHERE goal_id = ?`,
        )
        .get("goal-old") as
        | {
            kickoff_attachments_json: string;
            kickoff_state: string;
            turns_used: number;
            reply_fingerprint: string | null;
            no_progress_streak: number;
            last_verification: string | null;
            last_worker_proposal: string | null;
            status_reason: string | null;
            execution_wait_reason: string | null;
            execution_wait_since_ms: number | null;
            execution_wait_epoch: number | null;
          }
        | undefined;

      expect(columns).toEqual(
        expect.arrayContaining([
          "kickoff_attachments_json",
          "kickoff_state",
          "turns_used",
          "reply_fingerprint",
          "no_progress_streak",
          "last_verification",
          "last_worker_proposal",
          "status_reason",
          "execution_wait_reason",
          "execution_wait_since_ms",
          "execution_wait_epoch",
        ]),
      );
      // Version 28 belongs to retired workspace indexing; a fresh public DB
      // must not recreate its marker. Goal migrations still run and retain data.
      expect(migrationVersions).toEqual(
        hasHistoricalIndexingMarker ? [26, 27, 28, 29, 30, 31] : [26, 27, 29, 30, 31],
      );
      expect(legacyGoal).toEqual({
        kickoff_attachments_json: "[]",
        kickoff_state: "consumed",
        turns_used: 0,
        reply_fingerprint: null,
        no_progress_streak: 0,
        last_verification: null,
        last_worker_proposal: null,
        status_reason: null,
        execution_wait_reason: null,
        execution_wait_since_ms: null,
        execution_wait_epoch: null,
      });

      closeLocalRuntimeDb(dataDir);
      const reopened = openLocalRuntimeDb(dataDir);
      expect(
        reopened
          .prepare("PRAGMA table_info(local_runtime_thread_goals)")
          .all()
          .filter(
            (row) =>
              String((row as { name?: unknown }).name) === "verification",
          ),
      ).toHaveLength(0);
    });
  });

  it("records migration 27 without replaying Goal ALTERs on a collided version-26 database", async () => {
    await withDataDir(async (dataDir) => {
      const db = openLocalRuntimeDb(dataDir);
      db.prepare(
        "DELETE FROM local_runtime_schema_migrations WHERE version = 27",
      ).run();
      closeLocalRuntimeDb(dataDir);

      const upgraded = openLocalRuntimeDb(dataDir);
      const marker = upgraded
        .prepare(
          "SELECT version FROM local_runtime_schema_migrations WHERE version = 27",
        )
        .get() as { version?: unknown } | undefined;
      const indexes = upgraded
        .prepare("PRAGMA index_list(local_runtime_thread_goals)")
        .all()
        .map((row) => String((row as { name?: unknown }).name));

      expect(marker?.version).toBe(27);
      expect(indexes).toContain("idx_local_runtime_thread_goals_kickoff_state");
    });
  });

  it("persists Goal-owned kickoff attachments in pending state until Queue materialization", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_attachment",
        objective: "Read the brief",
        kickoffAttachments: [
          {
            type: "file",
            filePath: "/tmp/brief.pdf",
            fileName: "brief.pdf",
            mimeType: "application/pdf",
            assetId: "asset-1",
          },
        ],
      });

      expect(created).toMatchObject({
        kickoffState: "pending",
        kickoffAttachments: [
          {
            type: "file",
            filePath: "/tmp/brief.pdf",
            fileName: "brief.pdf",
            mimeType: "application/pdf",
            assetId: "asset-1",
          },
        ],
      });

      const fresh = new SqliteThreadGoalStore(dataDir);
      expect(await fresh.getById(created.goalId)).toMatchObject({
        kickoffState: "pending",
        kickoffAttachments: created.kickoffAttachments,
      });
    });
  });

  it("lists recoverable kickoffs and advances their state with compare-and-set semantics", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_recoverable",
        objective: "Recover me",
      });

      expect(await store.listRecoverableKickoffs()).toEqual([created]);
      await expect(
        store.transitionKickoffState(created.goalId, "pending", "enqueued"),
      ).resolves.toMatchObject({ kickoffState: "enqueued" });
      await expect(
        store.transitionKickoffState(created.goalId, "pending", "consumed"),
      ).resolves.toBeUndefined();
      await expect(
        store.transitionKickoffState(created.goalId, "enqueued", "consumed"),
      ).resolves.toMatchObject({ kickoffState: "consumed" });
      expect(await store.listRecoverableKickoffs()).toEqual([]);
      expect(await store.listRecoverableActiveGoals()).toEqual([
        expect.objectContaining({ goalId: created.goalId, status: "active" }),
      ]);
      await store.patch(created.goalId, { status: "paused" });
      expect(await store.listRecoverableActiveGoals()).toEqual([]);
    });
  });

  it("lists every durable budget-limited Goal as a recoverable summary candidate", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_budget_summary_recovery",
        objective: "Stop at the limit",
        tokenBudget: 1,
      });
      await store.transitionKickoffState(created.goalId, "pending", "consumed");
      now += 1;
      const limited = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 1, activeSeconds: 0, mainTurns: 1 },
        { ...TEST_LIMITS, tokens: 1 },
      );

      expect(limited?.goal.status).toBe("budget_limited");
      expect(await store.listRecoverableBudgetLimitSummaries()).toEqual([
        limited?.goal,
      ]);
    });
  });

  it("creates a goal with accounting columns initialized to 0 and tokenBudget=null when omitted", async () => {
    await withDataDir(async (dataDir) => {
      const now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const goal = await store.create({
        sessionId: "sess_a",
        objective: "audit",
      });
      expect(goal.tokensUsed).toBe(0);
      expect(goal.turnsUsed).toBe(0);
      expect(goal.timeUsedSeconds).toBe(0);
      expect(goal.tokenBudget).toBeNull();
      expect(goal.replyFingerprint).toBeNull();
      expect(goal.noProgressStreak).toBe(0);
      expect(goal.lastVerification).toBeUndefined();
      expect(goal.statusReason).toBeNull();
      expect(goal.createdAt).toBe(now);
      expect(goal.updatedAt).toBe(now);
    });
  });

  it("creates a goal with the given tokenBudget when supplied", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const goal = await store.create({
        sessionId: "sess_a2",
        objective: "audit",
        tokenBudget: 5_000,
      });
      expect(goal.tokenBudget).toBe(5_000);
    });
  });

  it("projects an execution wait with epoch CAS while keeping its time and Goal epoch stable", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_wait",
        objective: "wait safely",
      });

      now += 100;
      await expect(
        store.setExecutionWaitAtEpoch({
          goalId: created.goalId,
          expectedUpdatedAt: created.updatedAt,
          reason: "permission",
        }),
      ).resolves.toMatchObject({
        updatedAt: created.updatedAt,
        executionWait: { reason: "permission", sinceMs: now },
      });

      now += 100;
      await expect(
        store.setExecutionWaitAtEpoch({
          goalId: created.goalId,
          expectedUpdatedAt: created.updatedAt,
          reason: "permission",
        }),
      ).resolves.toBeUndefined();
      await expect(store.getById(created.goalId)).resolves.toMatchObject({
        updatedAt: created.updatedAt,
        executionWait: { reason: "permission", sinceMs: now - 100 },
      });

      await expect(
        store.setExecutionWaitAtEpoch({
          goalId: created.goalId,
          expectedUpdatedAt: created.updatedAt + 1,
          reason: "plan",
        }),
      ).resolves.toBeUndefined();
      await expect(
        store.clearExecutionWaitAtEpoch({
          goalId: created.goalId,
          expectedUpdatedAt: created.updatedAt,
        }),
      ).resolves.toMatchObject({
        updatedAt: created.updatedAt,
        executionWait: null,
      });
    });
  });

  it("retires the previous execution wait whenever a lifecycle write advances the epoch", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_wait_reset",
        objective: "resume cleanly",
      });
      now += 1;
      await store.setExecutionWaitAtEpoch({
        goalId: created.goalId,
        expectedUpdatedAt: created.updatedAt,
        reason: "required_background",
      });

      now += 1;
      const paused = await store.patch(created.goalId, {
        status: "paused",
        statusReason: "paused(user_requested)",
      });
      expect(paused.executionWait).toBeNull();
      now += 1;
      const resumed = await store.patch(created.goalId, { status: "active" });
      // The resumed Goal is `active` again, so only the epoch stamp keeps the
      // superseded reason from resurfacing. `patch` never touches the wait
      // columns — that is the point: no epoch writer has to remember to.
      expect(resumed.executionWait).toBeNull();
      await expect(store.getById(created.goalId)).resolves.toMatchObject({
        status: "active",
        executionWait: null,
      });

      const raw = openLocalRuntimeDb(dataDir)
        .prepare(
          `SELECT execution_wait_reason, execution_wait_epoch, updated_at_ms
           FROM local_runtime_thread_goals WHERE goal_id = ?`,
        )
        .get(created.goalId) as {
        execution_wait_reason: string | null;
        execution_wait_epoch: number | null;
        updated_at_ms: number;
      };
      expect(raw.execution_wait_reason).toBe("required_background");
      expect(raw.execution_wait_epoch).not.toBe(raw.updated_at_ms);
    });
  });

  it("rewrites a wait whose reason is unchanged but whose epoch was superseded", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_wait_reepoch",
        objective: "wait across epochs",
      });
      now += 1;
      await store.setExecutionWaitAtEpoch({
        goalId: created.goalId,
        expectedUpdatedAt: created.updatedAt,
        reason: "required_background",
      });

      now += 1;
      const repatched = await store.patch(created.goalId, {
        objective: "wait again",
      });
      expect(repatched.executionWait).toBeNull();

      // Same reason, new epoch. Deduplicating on the reason alone would leave
      // the row invisible to readers forever, so this must write.
      now += 1;
      await expect(
        store.setExecutionWaitAtEpoch({
          goalId: created.goalId,
          expectedUpdatedAt: repatched.updatedAt,
          reason: "required_background",
        }),
      ).resolves.toMatchObject({
        updatedAt: repatched.updatedAt,
        executionWait: { reason: "required_background", sinceMs: now },
      });
    });
  });

  it("reads unknown status and verification-result JSON fail-closed", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_unknown_policy",
        objective: "audit",
      });
      openLocalRuntimeDb(dataDir)
        .prepare(
          `UPDATE local_runtime_thread_goals
           SET status = 'future_status', last_verification = '{"v":2}'
           WHERE goal_id = ?`,
        )
        .run(created.goalId);

      expect(await store.getById(created.goalId)).toMatchObject({
        status: "paused",
        lastVerification: undefined,
      });
      await expect(
        store.patch(created.goalId, { status: "active" }),
      ).rejects.toMatchObject({
        currentStatus: "paused",
      });
    });
  });

  it("rejects budget_limited rearm but resets breaker streak on usage_limited rearm", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const budgeted = await store.create({
        sessionId: "sess_budget_rearm",
        objective: "audit",
        tokenBudget: 1,
      });
      await store.bumpBoundUsage(
        bindingFor(budgeted),
        { tokens: 1, activeSeconds: 1, mainTurns: 1 },
        { ...TEST_LIMITS, tokens: 1 },
      );
      await expect(
        store.patch(budgeted.goalId, { status: "active" }),
      ).rejects.toMatchObject({
        code: "GOAL_BUDGET_LIMITED",
      });

      const recoverable = await store.create({
        sessionId: "sess_usage_rearm",
        objective: "audit",
      });
      await store.patch(recoverable.goalId, {
        status: "usage_limited",
        statusReason: "usage_limited(rate_limit)",
      });
      openLocalRuntimeDb(dataDir)
        .prepare(
          `UPDATE local_runtime_thread_goals
           SET reply_fingerprint = 'same', no_progress_streak = 2, no_tool_streak = 2
           WHERE goal_id = ?`,
        )
        .run(recoverable.goalId);

      expect(
        await store.patch(recoverable.goalId, { status: "active" }),
      ).toMatchObject({
        status: "active",
        tokensUsed: 0,
        replyFingerprint: null,
        noProgressStreak: 0,
        noToolStreak: 0,
      });
    });
  });

  describe("no-tool breaker", () => {
    const breakerInput = (
      expectedEpoch: number,
      toolActivity: "used" | "absent" | "unknown",
      fingerprint: string | null = null,
      limit = 3,
    ) => ({ expectedEpoch, fingerprint, toolActivity, limit });

    it("pauses on the third consecutive tool-less Turn and keeps both counters apart", async () => {
      await withDataDir(async (dataDir) => {
        let now = 1_700_000_000_000;
        const store = new SqliteThreadGoalStore(dataDir, () => (now += 1));
        const created = await store.create({
          sessionId: "sess_no_tool",
          objective: "audit",
        });

        // Every reply differs, so only the no-tool condition can act here.
        const first = await store.updateBreaker(
          created.goalId,
          breakerInput(created.updatedAt, "absent", "fp-a"),
        );
        expect(first).toMatchObject({ action: "none" });
        if (first.action === "stale") throw new Error("unexpected stale");
        expect(first.goal).toMatchObject({
          noToolStreak: 1,
          noProgressStreak: 0,
        });

        const second = await store.updateBreaker(
          created.goalId,
          breakerInput(first.goal.updatedAt, "absent", "fp-b"),
        );
        if (second.action === "stale") throw new Error("unexpected stale");
        expect(second).toMatchObject({ action: "nudge", cause: "no_tool" });
        expect(second.goal).toMatchObject({
          noToolStreak: 2,
          noProgressStreak: 0,
          status: "active",
        });

        const third = await store.updateBreaker(
          created.goalId,
          breakerInput(second.goal.updatedAt, "absent", "fp-c"),
        );
        if (third.action === "stale") throw new Error("unexpected stale");
        expect(third).toMatchObject({ action: "pause", cause: "no_tool" });
        expect(third.goal).toMatchObject({
          status: "paused",
          statusReason: "paused(no_progress)",
          noToolStreak: 3,
          // The repeated-reply counter never absorbed the tool-less turns.
          noProgressStreak: 0,
        });
      });
    });

    it("clears the streak on a real tool call and on an unobservable Turn", async () => {
      await withDataDir(async (dataDir) => {
        let now = 1_700_000_000_000;
        const store = new SqliteThreadGoalStore(dataDir, () => (now += 1));
        const created = await store.create({
          sessionId: "sess_no_tool_reset",
          objective: "audit",
        });

        const first = await store.updateBreaker(
          created.goalId,
          breakerInput(created.updatedAt, "absent", "fp-a"),
        );
        if (first.action === "stale") throw new Error("unexpected stale");
        expect(first.goal.noToolStreak).toBe(1);

        const worked = await store.updateBreaker(
          created.goalId,
          breakerInput(first.goal.updatedAt, "used", "fp-b"),
        );
        if (worked.action === "stale") throw new Error("unexpected stale");
        expect(worked.goal.noToolStreak).toBe(0);

        const absentAgain = await store.updateBreaker(
          created.goalId,
          breakerInput(worked.goal.updatedAt, "absent", "fp-c"),
        );
        if (absentAgain.action === "stale") throw new Error("unexpected stale");
        expect(absentAgain.goal.noToolStreak).toBe(1);

        // An unobservable Turn is an observation gap, not a trustworthy zero:
        // it may not be stitched into the consecutive run.
        const gap = await store.updateBreaker(
          created.goalId,
          breakerInput(absentAgain.goal.updatedAt, "unknown", "fp-d"),
        );
        if (gap.action === "stale") throw new Error("unexpected stale");
        expect(gap.goal).toMatchObject({ noToolStreak: 0, status: "active" });
      });
    });

    it("scores the no-tool condition even when the Turn produced no reply text", async () => {
      await withDataDir(async (dataDir) => {
        let now = 1_700_000_000_000;
        const store = new SqliteThreadGoalStore(dataDir, () => (now += 1));
        const created = await store.create({
          sessionId: "sess_no_tool_empty",
          objective: "audit",
        });
        await store.updateBreaker(
          created.goalId,
          breakerInput(created.updatedAt, "used", "fp-a"),
        );
        const seeded = await store.getById(created.goalId);
        if (!seeded) throw new Error("expected goal");

        let epoch = seeded.updatedAt;
        for (let i = 0; i < 3; i += 1) {
          const result = await store.updateBreaker(
            created.goalId,
            // fingerprint null == empty reply: the fingerprint branch is
            // skipped but the no-tool branch still scores.
            breakerInput(epoch, "absent", null),
          );
          if (result.action === "stale") throw new Error("unexpected stale");
          epoch = result.goal.updatedAt;
          expect(result.goal.noToolStreak).toBe(i + 1);
          // The stored fingerprint from the earlier reply survives untouched.
          expect(result.goal.replyFingerprint).toBe("fp-a");
        }
        const final = await store.getById(created.goalId);
        expect(final).toMatchObject({
          status: "paused",
          statusReason: "paused(no_progress)",
        });
      });
    });

    it("shares one configured limit with the repeated-reply condition", async () => {
      await withDataDir(async (dataDir) => {
        let now = 1_700_000_000_000;
        const store = new SqliteThreadGoalStore(dataDir, () => (now += 1));
        const created = await store.create({
          sessionId: "sess_no_tool_limit",
          objective: "audit",
        });

        let epoch = created.updatedAt;
        for (let i = 0; i < 3; i += 1) {
          const result = await store.updateBreaker(
            created.goalId,
            breakerInput(epoch, "absent", `fp-${i}`, 4),
          );
          if (result.action === "stale") throw new Error("unexpected stale");
          epoch = result.goal.updatedAt;
          expect(result.goal.status).toBe("active");
        }
        const fourth = await store.updateBreaker(
          created.goalId,
          breakerInput(epoch, "absent", "fp-3", 4),
        );
        if (fourth.action === "stale") throw new Error("unexpected stale");
        expect(fourth).toMatchObject({ action: "pause", cause: "no_tool" });
        expect(fourth.goal).toMatchObject({
          noToolStreak: 4,
          status: "paused",
        });
      });
    });

    // Combination guard: the explicit-user-Turn reset and the no-tool counter
    // arrived in two separate changesets, so no single-source test could cover
    // that one `resetBreakerAtEpoch` has to clear BOTH breaker conditions. A
    // reset that cleared only the reply fingerprint would let a Goal the user
    // just intervened on pause again after a single further tool-less Turn.
    it("clears the no-tool streak together with the reply streak on an explicit user reset", async () => {
      await withDataDir(async (dataDir) => {
        let now = 1_700_000_000_000;
        const store = new SqliteThreadGoalStore(dataDir, () => (now += 1));
        const created = await store.create({
          sessionId: "sess_reset_both",
          objective: "audit",
        });

        const first = await store.updateBreaker(
          created.goalId,
          breakerInput(created.updatedAt, "absent", "same"),
        );
        if (first.action === "stale") throw new Error("unexpected stale");
        const second = await store.updateBreaker(
          created.goalId,
          breakerInput(first.goal.updatedAt, "absent", "same"),
        );
        if (second.action === "stale") throw new Error("unexpected stale");
        // Both conditions are one Turn away from pausing.
        expect(second.goal).toMatchObject({
          noToolStreak: 2,
          noProgressStreak: 1,
        });

        const reset = await store.resetBreakerAtEpoch(
          created.goalId,
          second.goal.updatedAt,
        );
        expect(reset).toMatchObject({
          replyFingerprint: null,
          noProgressStreak: 0,
          noToolStreak: 0,
        });

        // The very next tool-less Turn restarts from 1 rather than pausing.
        const afterReset = await store.updateBreaker(
          created.goalId,
          breakerInput(reset!.updatedAt, "absent", "same"),
        );
        if (afterReset.action === "stale") throw new Error("unexpected stale");
        expect(afterReset).toMatchObject({ action: "none" });
        expect(afterReset.goal).toMatchObject({
          noToolStreak: 1,
          status: "active",
        });
      });
    });

    it("rejects a stale epoch without touching the no-tool streak", async () => {
      await withDataDir(async (dataDir) => {
        let now = 1_700_000_000_000;
        const store = new SqliteThreadGoalStore(dataDir, () => (now += 1));
        const created = await store.create({
          sessionId: "sess_no_tool_cas",
          objective: "audit",
        });
        const first = await store.updateBreaker(
          created.goalId,
          breakerInput(created.updatedAt, "absent", "fp-a"),
        );
        if (first.action === "stale") throw new Error("unexpected stale");

        const stale = await store.updateBreaker(
          created.goalId,
          breakerInput(created.updatedAt, "absent", "fp-b"),
        );
        expect(stale).toMatchObject({
          action: "stale",
          staleReason: "goal_epoch",
        });
        expect(await store.getById(created.goalId)).toMatchObject({
          noToolStreak: 1,
        });
      });
    });

    it("still enforces the epoch CAS when the decision changes nothing", async () => {
      await withDataDir(async (dataDir) => {
        let now = 1_700_000_000_000;
        const store = new SqliteThreadGoalStore(dataDir, () => (now += 1));
        const created = await store.create({
          sessionId: "sess_no_tool_noop_cas",
          objective: "audit",
        });
        // A concurrent user PATCH advances the epoch without leaving `active`.
        const patched = await store.patch(created.goalId, {
          tokenBudget: 1000,
        });
        expect(patched.updatedAt).not.toBe(created.updatedAt);

        // Tool used, no reply text, both counters already zero: nothing to
        // write. The breaker must still refuse the superseded epoch instead of
        // handing the settled Turn the post-PATCH epoch.
        const result = await store.updateBreaker(
          created.goalId,
          breakerInput(created.updatedAt, "used", null),
        );
        expect(result).toMatchObject({
          action: "stale",
          staleReason: "goal_epoch",
        });
      });
    });
  });

  it("atomically raises or clears a token cap and rearms only token-limited goals", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_token_budget_rearm",
        objective: "audit",
        tokenBudget: 10,
      });
      const limited = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 10, activeSeconds: 1, mainTurns: 1 },
        { ...TEST_LIMITS, tokens: 10 },
      );
      if (!limited.goal) throw new Error("expected persisted goal");

      const raised = await store.patch(created.goalId, {
        status: "active",
        statusReason: null,
        tokenBudget: 20,
        rejectIfUpdatedAtChangedFrom: limited.goal.updatedAt,
      });
      expect(raised).toMatchObject({
        status: "active",
        statusReason: null,
        tokensUsed: 10,
        tokenBudget: 20,
      });

      await store.patch(created.goalId, {
        status: "budget_limited",
        statusReason: "budget_limited(token)",
      });
      const current = await store.getById(created.goalId);
      if (!current) throw new Error("expected persisted goal");
      await expect(
        store.patch(created.goalId, {
          status: "active",
          statusReason: null,
          tokenBudget: null,
          rejectIfUpdatedAtChangedFrom: current.updatedAt,
        }),
      ).resolves.toMatchObject({ status: "active", tokenBudget: null });
    });
  });

  it("rejects stale, already-exhausted, and non-token budget recovery writes", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_budget_guards",
        objective: "audit",
      });
      const accounted = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 10, activeSeconds: 1, mainTurns: 1 },
        TEST_LIMITS,
      );
      if (!accounted.goal) throw new Error("expected persisted goal");

      await expect(
        store.patch(created.goalId, {
          tokenBudget: 10,
          rejectIfUpdatedAtChangedFrom: accounted.goal.updatedAt,
        }),
      ).rejects.toMatchObject({ code: "GOAL_TOKEN_BUDGET_EXHAUSTED" });
      await expect(
        store.patch(created.goalId, {
          tokenBudget: 20,
          rejectIfUpdatedAtChangedFrom: created.updatedAt,
        }),
      ).rejects.toMatchObject({ code: "GOAL_EPOCH_CONFLICT" });

      const mainTurnLimited = await store.patch(created.goalId, {
        status: "budget_limited",
        statusReason: "budget_limited(main_turn)",
      });
      await expect(
        store.patch(created.goalId, {
          status: "active",
          statusReason: null,
          tokenBudget: 100,
          rejectIfUpdatedAtChangedFrom: mainTurnLimited.updatedAt,
        }),
      ).rejects.toMatchObject({ code: "GOAL_BUDGET_LIMITED" });
    });
  });

  it("persists repeated replies and pauses on the third identical reply", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_breaker",
        objective: "audit",
      });

      const first = await store.updateBreaker(created.goalId, {
        expectedEpoch: created.updatedAt,
        fingerprint: "fingerprint-a",
        limit: 3,
      });
      expect(first).toMatchObject({
        action: "none",
        goal: { noProgressStreak: 0, status: "active" },
      });
      if (first.action === "stale")
        throw new Error("unexpected stale breaker result");

      const repeat1 = await store.updateBreaker(created.goalId, {
        expectedEpoch: first.epoch,
        fingerprint: "fingerprint-a",
        limit: 3,
      });
      expect(repeat1).toMatchObject({
        action: "nudge",
        goal: { noProgressStreak: 1, status: "active" },
      });
      if (repeat1.action === "stale")
        throw new Error("unexpected stale breaker result");

      const repeat2 = await store.updateBreaker(created.goalId, {
        expectedEpoch: repeat1.epoch,
        fingerprint: "fingerprint-a",
        limit: 3,
      });
      expect(repeat2).toMatchObject({
        action: "pause",
        goal: {
          noProgressStreak: 2,
          status: "paused",
          statusReason: "paused(no_progress)",
        },
      });

      const reopened = new SqliteThreadGoalStore(dataDir);
      expect(await reopened.getById(created.goalId)).toMatchObject({
        replyFingerprint: "fingerprint-a",
        noProgressStreak: 2,
        status: "paused",
        statusReason: "paused(no_progress)",
      });
    });
  });

  it("persists the host-selected reason when no progress overrides a completion claim", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_completion_breaker",
        objective: "audit",
      });
      const first = await store.updateBreaker(created.goalId, {
        expectedEpoch: created.updatedAt,
        fingerprint: "same-completion-claim",
        limit: 1,
      });
      if (first.action === "stale")
        throw new Error("unexpected stale breaker result");

      const repeated = await store.updateBreaker(created.goalId, {
        expectedEpoch: first.epoch,
        fingerprint: "same-completion-claim",
        limit: 1,
        pauseReason: "paused(no_progress_after_completion_claim)",
      });

      expect(repeated).toMatchObject({
        action: "pause",
        goal: {
          status: "paused",
          statusReason: "paused(no_progress_after_completion_claim)",
        },
      });
      expect(await store.getById(created.goalId)).toMatchObject({
        status: "paused",
        statusReason: "paused(no_progress_after_completion_claim)",
      });
    });
  });

  it("resets the repeated-reply streak when the fingerprint changes", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_breaker_change",
        objective: "audit",
      });
      const first = await store.updateBreaker(created.goalId, {
        expectedEpoch: created.updatedAt,
        fingerprint: "fingerprint-a",
        limit: 3,
      });
      if (first.action === "stale")
        throw new Error("unexpected stale breaker result");
      const repeated = await store.updateBreaker(created.goalId, {
        expectedEpoch: first.epoch,
        fingerprint: "fingerprint-a",
        limit: 3,
      });
      if (repeated.action === "stale")
        throw new Error("unexpected stale breaker result");

      await expect(
        store.updateBreaker(created.goalId, {
          expectedEpoch: repeated.epoch,
          fingerprint: "fingerprint-b",
          limit: 3,
        }),
      ).resolves.toMatchObject({
        action: "none",
        goal: { replyFingerprint: "fingerprint-b", noProgressStreak: 0 },
      });
    });
  });

  it("returns typed stale results without mutating a newer Goal epoch", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_breaker_stale",
        objective: "audit",
      });
      const observed = await store.updateBreaker(created.goalId, {
        expectedEpoch: created.updatedAt,
        fingerprint: "previous-fingerprint",
        limit: 3,
      });
      if (observed.action === "stale")
        throw new Error("unexpected stale breaker result");
      now += 1;
      const edited = await store.patch(created.goalId, {
        objective: "new objective",
      });

      await expect(
        store.updateBreaker(created.goalId, {
          expectedEpoch: observed.epoch,
          fingerprint: "stale-fingerprint",
          limit: 3,
        }),
      ).resolves.toMatchObject({
        action: "stale",
        staleReason: "goal_epoch",
        goal: { updatedAt: edited.updatedAt, objective: "new objective" },
      });
      expect(await store.getById(created.goalId)).toMatchObject({
        replyFingerprint: null,
        noProgressStreak: 0,
      });
      await expect(
        store.updateBreaker("missing-goal", {
          expectedEpoch: 1,
          fingerprint: "fingerprint",
          limit: 3,
        }),
      ).resolves.toEqual({ action: "stale", staleReason: "missing_goal" });
    });
  });

  it("resets breaker state only for the exact active epoch after explicit user work", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_user_reset",
        objective: "audit",
      });
      const first = await store.updateBreaker(created.goalId, {
        expectedEpoch: created.updatedAt,
        fingerprint: "same",
        limit: 3,
      });
      if (first.action === "stale")
        throw new Error("unexpected stale breaker result");
      const repeated = await store.updateBreaker(created.goalId, {
        expectedEpoch: first.epoch,
        fingerprint: "same",
        limit: 3,
      });
      if (repeated.action === "stale")
        throw new Error("unexpected stale breaker result");

      now += 1;
      await expect(
        store.resetBreakerAtEpoch(created.goalId, repeated.epoch - 1),
      ).resolves.toBeUndefined();
      const reset = await store.resetBreakerAtEpoch(
        created.goalId,
        repeated.epoch,
      );
      expect(reset).toMatchObject({
        replyFingerprint: null,
        noProgressStreak: 0,
      });
      expect(reset?.updatedAt).toBeGreaterThan(repeated.epoch);
    });
  });

  it("applies a typed final-admission stop only to the exact active epoch", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_final_pause",
        objective: "audit",
      });

      await expect(
        store.transitionActiveAtEpoch(created.goalId, created.updatedAt - 1, {
          status: "budget_limited",
          statusReason: "budget_limited(token)",
        }),
      ).resolves.toBeUndefined();
      await expect(
        store.transitionActiveAtEpoch(created.goalId, created.updatedAt, {
          status: "budget_limited",
          statusReason: "budget_limited(token)",
        }),
      ).resolves.toMatchObject({
        status: "budget_limited",
        statusReason: "budget_limited(token)",
      });
    });
  });

  it("pauseActiveBySession atomically transitions only active goals to paused", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_abort",
        objective: "audit",
      });

      const paused = await store.pauseActiveBySession(created.sessionId);
      expect(paused).toMatchObject({
        goalId: created.goalId,
        status: "paused",
        statusReason: "paused(user_requested)",
      });
      expect(paused?.updatedAt).toBeGreaterThan(created.updatedAt);

      now += 500;
      expect(
        await store.pauseActiveBySession(created.sessionId),
      ).toBeUndefined();
      expect((await store.getById(created.goalId))?.updatedAt).toBe(
        paused?.updatedAt,
      );
    });
  });

  it.each([
    "paused",
    "blocked",
    "complete",
    "budget_limited",
    "usage_limited",
  ] as const)(
    "pauseActiveBySession does not overwrite a %s goal",
    async (status) => {
      await withDataDir(async (dataDir) => {
        const store = new SqliteThreadGoalStore(
          dataDir,
          () => 1_700_000_000_000,
        );
        const created = await store.create({
          sessionId: `sess_abort_${status}`,
          objective: "audit",
        });
        await store.patch(created.goalId, { status });

        expect(
          await store.pauseActiveBySession(created.sessionId),
        ).toBeUndefined();
        expect((await store.getById(created.goalId))?.status).toBe(status);
      });
    },
  );

  it("atomically rejects a model status write when the goal is paused", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_model_race",
        objective: "audit",
      });
      await store.patch(created.goalId, { status: "paused" });

      await expect(
        store.patch(created.goalId, {
          status: "complete",
          rejectIfCurrentStatus: "paused",
        }),
      ).rejects.toMatchObject({ currentStatus: "paused" });
      expect((await store.getById(created.goalId))?.status).toBe("paused");
    });
  });

  it("atomically rejects a model status write when the captured objective was edited", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_objective_race",
        objective: "old objective",
      });
      await store.patch(created.goalId, { objective: "new objective" });

      await expect(
        store.patch(created.goalId, {
          status: "complete",
          rejectIfObjectiveChangedFrom: "old objective",
        }),
      ).rejects.toMatchObject({ currentObjective: "new objective" });
      expect(await store.getById(created.goalId)).toMatchObject({
        objective: "new objective",
        status: "active",
      });
    });
  });

  it("bumpBoundUsage adds deltas atomically and chains its decision epoch", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_b",
        objective: "audit",
      });

      now = 1_700_000_000_500;
      const after1 = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 1_500, activeSeconds: 12, mainTurns: 1 },
        TEST_LIMITS,
      );
      expect(after1?.goal.tokensUsed).toBe(1_500);
      expect(after1?.goal.timeUsedSeconds).toBe(12);
      expect(after1?.goal.turnsUsed).toBe(1);
      expect(after1?.goal.updatedAt).toBe(now);
      expect(after1?.transitioned).toBeNull();

      now = 1_700_000_001_000;
      const after2 = await store.bumpBoundUsage(
        bindingFor(after1.goal!, {
          admittedGoalUpdatedAt: after1.decisionEpoch,
          turnId: "turn-bound-2",
        }),
        { tokens: 3_200, activeSeconds: 8, mainTurns: 1 },
        TEST_LIMITS,
      );
      expect(after2?.goal.tokensUsed).toBe(4_700);
      expect(after2?.goal.timeUsedSeconds).toBe(20);
      expect(after2?.goal.turnsUsed).toBe(2);
      expect(after2?.goal.updatedAt).toBe(now);
      expect(after2?.transitioned).toBeNull();
    });
  });

  it("bumpBoundUsage no-ops a zero summary delta but still returns the current epoch", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_c",
        objective: "audit",
      });

      now = 1_700_000_000_900;
      const result = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 0, activeSeconds: 0, mainTurns: 0 },
        TEST_LIMITS,
      );
      expect(result?.goal.tokensUsed).toBe(0);
      expect(result?.goal.timeUsedSeconds).toBe(0);
      expect(result?.goal.updatedAt).toBe(created.updatedAt);
      expect(result?.transitioned).toBeNull();
    });
  });

  it("bumpBoundUsage clamps negative inputs to 0 (defence-in-depth)", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_d",
        objective: "audit",
      });

      const result = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: -5, activeSeconds: -10, mainTurns: 0 },
        TEST_LIMITS,
      );
      expect(result?.goal.tokensUsed).toBe(0);
      expect(result?.goal.timeUsedSeconds).toBe(0);
    });
  });

  it("bumpBoundUsage returns typed missing_goal when the binding no longer exists", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir);
      const result = await store.bumpBoundUsage(
        {
          goalId: "tg_nonexistent",
          admittedGoalUpdatedAt: 1,
          objectiveDigest: digestThreadGoalObjective("missing"),
          turnId: "turn-missing",
        },
        { tokens: 100, activeSeconds: 1, mainTurns: 1 },
        TEST_LIMITS,
      );
      expect(result).toEqual({ staleReason: "missing_goal" });
    });
  });

  it("bumpBoundUsage flips status at the effective token limit", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_budget",
        objective: "audit",
        tokenBudget: 1_000,
      });
      // 600 < 1000 — still active
      const r1 = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 600, activeSeconds: 5, mainTurns: 1 },
        { tokens: 1_000, mainTurns: 10, activeSeconds: 1_000 },
      );
      expect(r1?.goal.status).toBe("active");
      expect(r1?.transitioned).toBeNull();

      // 600 + 400 = 1000 — `>= tokenBudget` triggers the transition
      const r2 = await store.bumpBoundUsage(
        bindingFor(r1.goal!, {
          admittedGoalUpdatedAt: r1.decisionEpoch,
          turnId: "turn-budget-2",
        }),
        { tokens: 400, activeSeconds: 3, mainTurns: 1 },
        { tokens: 1_000, mainTurns: 10, activeSeconds: 1_000 },
      );
      expect(r2?.goal.status).toBe("budget_limited");
      expect(r2?.transitioned).toBe("token");
    });
  });

  it("bumpBoundUsage records summary overrun without transitioning or advancing its stable epoch", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_double",
        objective: "audit",
        tokenBudget: 100,
      });
      const limited = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 200, activeSeconds: 1, mainTurns: 1 },
        { tokens: 100, mainTurns: 10, activeSeconds: 1_000 },
      );
      const r2 = await store.bumpBoundUsage(
        bindingFor(limited.goal!, {
          admittedGoalUpdatedAt: limited.decisionEpoch,
          turnId: "turn-budget-summary",
        }),
        { tokens: 50, activeSeconds: 1, mainTurns: 0 },
        { tokens: 100, mainTurns: 10, activeSeconds: 1_000 },
      );
      expect(r2?.goal.status).toBe("budget_limited");
      expect(r2?.transitioned).toBeNull();
      expect(r2.decisionEpoch).toBe(limited.decisionEpoch);
      expect(r2.goal?.turnsUsed).toBe(1);
    });
  });

  /*
   * The invariant this trio pins: a write that only records what was already
   * spent is a fact *about* the Goal, while the decision epoch is the token
   * saying *who owns its next step*. A stale charge — the late subagent
   * verifier being the only producer today — must therefore never retire the
   * execution binding the Goal has since admitted, unless the charge itself
   * makes a lifecycle decision by crossing a budget.
   */
  it("bumpBoundUsage records a stale charge without invalidating the current execution binding", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_stale_epoch",
        objective: "audit",
      });

      now = 1_700_000_000_500;
      const mainTurn = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 1_752, activeSeconds: 108, mainTurns: 1 },
        TEST_LIMITS,
      );
      const ea = mainTurn.decisionEpoch;
      if (ea === undefined)
        throw new Error("expected the main Turn charge to land");

      // The explicit user Turn's breaker reset, not a `patch`: an objective
      // edit would add `objective_digest` to the staleness reason and stop
      // testing the epoch dimension on its own.
      now = 1_700_000_000_800;
      const afterReset = await store.resetBreakerAtEpoch(created.goalId, ea);
      const e1 = afterReset?.updatedAt;
      if (e1 === undefined)
        throw new Error("expected the breaker reset to advance the epoch");
      expect(e1).toBeGreaterThan(ea);

      // The verifier dispatched at `ea` finishes afterwards and is charged.
      now = 1_700_000_001_200;
      const staleCharge = await store.bumpBoundUsage(
        bindingFor(created, {
          admittedGoalUpdatedAt: ea,
          turnId: "turn-verifier",
        }),
        { tokens: 1_887, activeSeconds: 0, mainTurns: 0 },
        TEST_LIMITS,
      );

      expect(staleCharge.staleReason).toBe("goal_epoch");
      // Accounting is unconditional: the tokens were really spent.
      expect(staleCharge.goal?.tokensUsed).toBe(1_752 + 1_887);
      expect(staleCharge.goal?.turnsUsed).toBe(1);
      // And the Turn admitted at `e1` keeps its binding.
      expect(staleCharge.goal?.updatedAt).toBe(e1);
      expect(staleCharge.decisionEpoch).toBe(e1);
      expect((await store.getById(created.goalId))?.updatedAt).toBe(e1);
    });
  });

  it("bumpBoundUsage still transitions and advances the epoch when a stale charge crosses the budget", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_stale_overrun",
        objective: "audit",
        tokenBudget: 2_000,
      });
      const limits = {
        tokens: 2_000,
        mainTurns: 10,
        activeSeconds: 1_000,
      } as const;

      now = 1_700_000_000_500;
      const mainTurn = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 900, activeSeconds: 5, mainTurns: 1 },
        limits,
      );
      const ea = mainTurn.decisionEpoch;
      if (ea === undefined)
        throw new Error("expected the main Turn charge to land");

      now = 1_700_000_000_800;
      const e1 = (await store.resetBreakerAtEpoch(created.goalId, ea))
        ?.updatedAt;
      if (e1 === undefined)
        throw new Error("expected the breaker reset to advance the epoch");

      now = 1_700_000_001_200;
      const staleOverrun = await store.bumpBoundUsage(
        bindingFor(created, {
          admittedGoalUpdatedAt: ea,
          turnId: "turn-verifier",
        }),
        { tokens: 1_500, activeSeconds: 0, mainTurns: 0 },
        limits,
      );

      // A budget crossing *is* a lifecycle decision, so it keeps the right to
      // retire whatever the Goal was running.
      expect(staleOverrun.staleReason).toBe("goal_epoch");
      expect(staleOverrun.transitioned).toBe("token");
      expect(staleOverrun.goal?.status).toBe("budget_limited");
      expect(staleOverrun.goal?.updatedAt).not.toBe(e1);
      expect(staleOverrun.goal?.updatedAt).toBeGreaterThan(e1);
    });
  });

  it("bumpBoundUsage keeps the execution wait consistent across the epoch it publishes", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_stale_wait",
        objective: "audit",
      });

      now = 1_700_000_000_500;
      const mainTurn = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 1_000, activeSeconds: 5, mainTurns: 1 },
        TEST_LIMITS,
      );
      const ea = mainTurn.decisionEpoch;
      if (ea === undefined)
        throw new Error("expected the main Turn charge to land");

      now = 1_700_000_000_800;
      const e1 = (await store.resetBreakerAtEpoch(created.goalId, ea))
        ?.updatedAt;
      if (e1 === undefined)
        throw new Error("expected the breaker reset to advance the epoch");
      await store.setExecutionWaitAtEpoch({
        goalId: created.goalId,
        expectedUpdatedAt: e1,
        reason: "required_background",
      });
      expect((await store.getById(created.goalId))?.executionWait?.reason).toBe(
        "required_background",
      );

      now = 1_700_000_001_200;
      const staleCharge = await store.bumpBoundUsage(
        bindingFor(created, {
          admittedGoalUpdatedAt: ea,
          turnId: "turn-verifier",
        }),
        { tokens: 500, activeSeconds: 0, mainTurns: 0 },
        TEST_LIMITS,
      );

      // The returned goal is published as a `thread_goal.updated` event while
      // the row behind `getById` answers the API, so the two must not diverge.
      expect(staleCharge.goal?.updatedAt).toBe(e1);
      expect(staleCharge.goal?.executionWait?.reason).toBe(
        "required_background",
      );
      expect(staleCharge.goal?.executionWait).toEqual(
        (await store.getById(created.goalId))?.executionWait,
      );

      // The reverse lock: a charge that does advance the epoch retires the
      // wait in both projections, exactly as before.
      now = 1_700_000_001_600;
      const currentCharge = await store.bumpBoundUsage(
        bindingFor(created, {
          admittedGoalUpdatedAt: e1,
          turnId: "turn-current",
        }),
        { tokens: 100, activeSeconds: 1, mainTurns: 1 },
        TEST_LIMITS,
      );
      expect(currentCharge.staleReason).toBeUndefined();
      expect(currentCharge.goal?.updatedAt).toBeGreaterThan(e1);
      expect(currentCharge.goal?.executionWait).toBeNull();
      expect((await store.getById(created.goalId))?.executionWait).toBeNull();
    });
  });

  it("bumpBoundUsage records usage without transitioning when all dimensions are uncapped", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_nobudget",
        objective: "audit",
      });
      const result = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 1_000_000, activeSeconds: 1_000_000, mainTurns: 1 },
        { tokens: null, mainTurns: null, activeSeconds: null },
      );
      expect(result?.goal.status).toBe("active");
      expect(result?.goal.tokensUsed).toBe(1_000_000);
      expect(result?.goal.timeUsedSeconds).toBe(1_000_000);
      expect(result?.goal.turnsUsed).toBe(1);
      expect(result?.transitioned).toBeNull();
    });
  });

  it("patch keeps accounting columns untouched and accepts tokenBudget overrides", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_e",
        objective: "audit",
        tokenBudget: 500,
      });

      now = 1_700_000_000_500;
      await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 200, activeSeconds: 7, mainTurns: 1 },
        TEST_LIMITS,
      );

      now = 1_700_000_001_000;
      const patched = await store.patch(created.goalId, {
        status: "paused",
        tokenBudget: 2_000,
      });
      expect(patched.status).toBe("paused");
      expect(patched.tokensUsed).toBe(200);
      expect(patched.timeUsedSeconds).toBe(7);
      expect(patched.tokenBudget).toBe(2_000);

      // patch with explicit null clears the cap.
      now = 1_700_000_002_000;
      const cleared = await store.patch(created.goalId, { tokenBudget: null });
      expect(cleared.tokenBudget).toBeNull();
    });
  });

  it("restarts a paused goal via one objective+status patch, keeping budget and usage", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_restart",
        objective: "audit",
        tokenBudget: 5_000,
      });

      now = 1_700_000_000_500;
      await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 200, activeSeconds: 7, mainTurns: 1 },
        TEST_LIMITS,
      );

      now = 1_700_000_001_000;
      const paused = await store.patch(created.goalId, { status: "paused" });
      expect(paused.status).toBe("paused");

      now = 1_700_000_002_000;
      const restarted = await store.patch(created.goalId, {
        objective: "audit, but the flaky suite first",
        status: "active",
      });
      expect(restarted.status).toBe("active");
      expect(restarted.objective).toBe("audit, but the flaky suite first");
      // Budget and accounting are inherited; only the run state restarts.
      expect(restarted.tokenBudget).toBe(5_000);
      expect(restarted.tokensUsed).toBe(200);
      expect(restarted.turnsUsed).toBe(1);
      expect(restarted.timeUsedSeconds).toBe(7);
      // Resume semantics: the no-progress breaker starts fresh.
      expect(restarted.noProgressStreak).toBe(0);
      expect(restarted.replyFingerprint).toBeNull();
    });
  });

  it("rowToState reads tokenBudget back from disk (v15 roundtrip via a fresh store instance)", async () => {
    await withDataDir(async (dataDir) => {
      const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
      const created = await store.create({
        sessionId: "sess_legacy",
        objective: "audit",
        tokenBudget: 9_000,
      });
      await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 4_321, activeSeconds: 17, mainTurns: 1 },
        TEST_LIMITS,
      );

      const fresh = new SqliteThreadGoalStore(dataDir);
      const row = await fresh.getById(created.goalId);
      expect(row?.tokensUsed).toBe(4_321);
      expect(row?.timeUsedSeconds).toBe(17);
      expect(row?.tokenBudget).toBe(9_000);
    });
  });
});

describe("SqliteThreadGoalStore — verifier CAS", () => {
  it("persists the completion proposal in the same CAS as a not-met verdict", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_verifier_proposal",
        objective: "Ship with evidence",
      });

      now += 1;
      const result = await store.recordVerification({
        goalId: created.goalId,
        expectedEpoch: created.updatedAt,
        objectiveDigest: digestThreadGoalObjective(created.objective),
        result: verificationResult(created),
        repeatedNotMetLimit: 5,
        workerProposal: {
          type: "complete",
          turnId: "turn-worker",
          summary: "Implementation is ready for review.",
        },
      });

      expect(result).toMatchObject({
        status: "settled",
        goal: {
          status: "active",
          lastVerification: { verdict: "not_met" },
          lastWorkerProposal: {
            v: 1,
            source: "worker",
            type: "complete",
            turnId: "turn-worker",
            summary: "Implementation is ready for review.",
            at: now,
          },
        },
      });
    });
  });

  it("clears verifier and worker evidence when the objective changes", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_objective_evidence_reset",
        objective: "Ship the first objective",
      });

      now += 1;
      const recorded = await store.recordVerification({
        goalId: created.goalId,
        expectedEpoch: created.updatedAt,
        objectiveDigest: digestThreadGoalObjective(created.objective),
        result: verificationResult(created),
        repeatedNotMetLimit: 5,
        workerProposal: {
          type: "complete",
          turnId: "turn-first-objective",
          summary: "Evidence for the first objective.",
        },
      });
      if (recorded.status !== "settled")
        throw new Error("expected verification settlement");

      now += 1;
      await expect(
        store.patch(created.goalId, {
          objective: "Ship the replacement objective",
        }),
      ).resolves.toMatchObject({
        objective: "Ship the replacement objective",
        lastVerification: undefined,
        lastWorkerProposal: undefined,
      });
      expect(await store.getById(created.goalId)).toMatchObject({
        lastVerification: undefined,
        lastWorkerProposal: undefined,
      });
    });
  });

  it("normalizes missing gaps and increments only the same consecutive fingerprint", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_verifier_streak",
        objective: "Ship the verified result",
      });

      now += 1;
      const first = await store.recordVerification({
        goalId: created.goalId,
        expectedEpoch: created.updatedAt,
        objectiveDigest: digestThreadGoalObjective(created.objective),
        result: verificationResult(created, {
          missing: ["  beta   proof ", "alpha proof", "alpha proof"],
        }),
        repeatedNotMetLimit: 5,
      });
      expect(first).toMatchObject({
        status: "settled",
        goal: {
          status: "active",
          lastVerification: {
            verdict: "not_met",
            missing: ["alpha proof", "beta proof"],
            notMetStreak: 1,
          },
        },
      });
      if (first.status !== "settled")
        throw new Error("expected first verification settlement");
      const fingerprint = first.goal.lastVerification?.missingFingerprint;
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);

      now += 1;
      const repeated = await store.recordVerification({
        goalId: created.goalId,
        expectedEpoch: first.decisionEpoch,
        objectiveDigest: digestThreadGoalObjective(created.objective),
        result: verificationResult(created, {
          missing: ["beta proof", " alpha proof "],
        }),
        repeatedNotMetLimit: 5,
      });
      expect(repeated).toMatchObject({
        status: "settled",
        goal: {
          status: "active",
          lastVerification: {
            missingFingerprint: fingerprint,
            notMetStreak: 2,
          },
        },
      });
      if (repeated.status !== "settled")
        throw new Error("expected repeated verification settlement");

      now += 1;
      const progressed = await store.recordVerification({
        goalId: created.goalId,
        expectedEpoch: repeated.decisionEpoch,
        objectiveDigest: digestThreadGoalObjective(created.objective),
        result: verificationResult(created, { missing: ["release evidence"] }),
        repeatedNotMetLimit: 5,
      });
      expect(progressed).toMatchObject({
        status: "settled",
        goal: { status: "active", lastVerification: { notMetStreak: 1 } },
      });
    });
  });

  it("pauses no-progress in the same write that reaches the repeated gap limit", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_verifier_pause",
        objective: "Close the same gap",
      });
      now += 1;
      const first = await store.recordVerification({
        goalId: created.goalId,
        expectedEpoch: created.updatedAt,
        objectiveDigest: digestThreadGoalObjective(created.objective),
        result: verificationResult(created),
        repeatedNotMetLimit: 2,
      });
      if (first.status !== "settled")
        throw new Error("expected first verification settlement");

      now += 1;
      const stopped = await store.recordVerification({
        goalId: created.goalId,
        expectedEpoch: first.decisionEpoch,
        objectiveDigest: digestThreadGoalObjective(created.objective),
        result: verificationResult(created),
        repeatedNotMetLimit: 2,
      });
      expect(stopped).toMatchObject({
        status: "settled",
        goal: {
          status: "paused",
          statusReason: "paused(no_progress)",
          lastVerification: { notMetStreak: 2 },
        },
      });
    });
  });

  it("commits a verifier terminal decision with the verdict and returns typed stale outcomes", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_verifier_terminal",
        objective: "Prove completion",
      });
      const objectiveDigest = digestThreadGoalObjective(created.objective);

      await expect(
        store.recordVerification({
          goalId: "missing-goal",
          expectedEpoch: created.updatedAt,
          objectiveDigest,
          result: verificationResult(created),
          repeatedNotMetLimit: 5,
        }),
      ).resolves.toEqual({ status: "stale", staleReason: "missing_goal" });
      await expect(
        store.recordVerification({
          goalId: created.goalId,
          expectedEpoch: created.updatedAt + 1,
          objectiveDigest,
          result: verificationResult(created),
          repeatedNotMetLimit: 5,
        }),
      ).resolves.toMatchObject({ status: "stale", staleReason: "goal_epoch" });
      await expect(
        store.recordVerification({
          goalId: created.goalId,
          expectedEpoch: created.updatedAt,
          objectiveDigest: digestThreadGoalObjective("different objective"),
          result: verificationResult(created),
          repeatedNotMetLimit: 5,
        }),
      ).resolves.toMatchObject({
        status: "stale",
        staleReason: "objective_digest",
      });

      now += 1;
      const completed = await store.recordVerification({
        goalId: created.goalId,
        expectedEpoch: created.updatedAt,
        objectiveDigest,
        result: verificationResult(created, {
          verdict: "met",
          reason: "The current evidence proves every requirement.",
          missing: [],
        }),
        repeatedNotMetLimit: 5,
        decision: {
          status: "complete",
          statusReason: "complete(verifier_met)",
        },
      });
      expect(completed).toMatchObject({
        status: "settled",
        goal: {
          status: "complete",
          statusReason: "complete(verifier_met)",
          lastVerification: { verdict: "met", missing: [], notMetStreak: 0 },
        },
      });
      if (completed.status !== "settled")
        throw new Error("expected terminal settlement");
      await expect(
        store.recordVerification({
          goalId: created.goalId,
          expectedEpoch: completed.decisionEpoch,
          objectiveDigest,
          result: verificationResult(created),
          repeatedNotMetLimit: 5,
        }),
      ).resolves.toMatchObject({ status: "stale", staleReason: "goal_status" });
    });
  });
});

describe("SqliteThreadGoalStore — bound settlement", () => {
  it("atomically persists a worker block summary and rejects stale replacement evidence", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_block_evidence",
        objective: "audit",
      });

      now += 10;
      const settled = await store.settleBoundTurn({
        goalId: created.goalId,
        expectedEpoch: created.updatedAt,
        objectiveDigest: digestThreadGoalObjective(created.objective),
        next: { status: "blocked", statusReason: "blocked(worker_reported)" },
        workerProposal: {
          type: "blocked",
          turnId: "turn-blocked",
          summary: "The same external dependency remained unavailable.",
        },
      });
      expect(settled).toMatchObject({
        status: "settled",
        goal: {
          status: "blocked",
          lastWorkerProposal: {
            source: "worker",
            type: "blocked",
            turnId: "turn-blocked",
            summary: "The same external dependency remained unavailable.",
            at: now,
          },
        },
      });

      now += 10;
      await expect(
        store.settleBoundTurn({
          goalId: created.goalId,
          expectedEpoch: created.updatedAt,
          objectiveDigest: digestThreadGoalObjective(created.objective),
          next: {
            status: "complete",
            statusReason: "complete(worker_proposal)",
          },
          workerProposal: {
            type: "complete",
            turnId: "turn-stale",
            summary:
              "This stale evidence must not replace the accepted blocker.",
          },
        }),
      ).resolves.toMatchObject({ status: "stale" });
      expect(await store.getById(created.goalId)).toMatchObject({
        lastWorkerProposal: {
          type: "blocked",
          turnId: "turn-blocked",
          summary: "The same external dependency remained unavailable.",
        },
      });
    });
  });

  it("returns each typed stale reason and still attributes usage to an existing bound Goal", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_bound_stale",
        objective: "audit",
      });

      await expect(
        store.bumpBoundUsage(
          { ...bindingFor(created), goalId: "tg_missing" },
          { tokens: 5, activeSeconds: 1, mainTurns: 1 },
          TEST_LIMITS,
        ),
      ).resolves.toEqual({ staleReason: "missing_goal" });

      now += 10;
      const patched = await store.patch(created.goalId, {
        objective: "audit revised",
      });
      now += 10;
      const epochStale = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 5, activeSeconds: 2, mainTurns: 1 },
        TEST_LIMITS,
      );
      expect(epochStale).toMatchObject({
        staleReason: "goal_epoch",
        // A stale charge decides nothing, so it records the spend at the epoch
        // the current owner holds instead of retiring that owner.
        decisionEpoch: patched.updatedAt,
        goal: {
          goalId: created.goalId,
          tokensUsed: 5,
          turnsUsed: 1,
          timeUsedSeconds: 2,
        },
      });

      now += 10;
      const digestStale = await store.bumpBoundUsage(
        bindingFor(patched, {
          admittedGoalUpdatedAt: epochStale.decisionEpoch,
          objectiveDigest: digestThreadGoalObjective("wrong objective"),
          turnId: "turn-digest-stale",
        }),
        { tokens: 7, activeSeconds: 3, mainTurns: 0 },
        TEST_LIMITS,
      );
      expect(digestStale).toMatchObject({
        staleReason: "objective_digest",
        decisionEpoch: patched.updatedAt,
        goal: { tokensUsed: 12, turnsUsed: 1, timeUsedSeconds: 5 },
      });
    });
  });

  it.each([
    {
      label: "token",
      limits: { tokens: 10, mainTurns: 1, activeSeconds: 1 },
      delta: { tokens: 10, activeSeconds: 1, mainTurns: 1 as const },
      reason: "budget_limited(token)",
      dimension: "token",
    },
    {
      label: "main turn",
      limits: { tokens: 100, mainTurns: 1, activeSeconds: 1 },
      delta: { tokens: 1, activeSeconds: 1, mainTurns: 1 as const },
      reason: "budget_limited(main_turn)",
      dimension: "main_turn",
    },
    {
      label: "active time",
      limits: { tokens: 100, mainTurns: 10, activeSeconds: 1 },
      delta: { tokens: 1, activeSeconds: 1, mainTurns: 1 as const },
      reason: "budget_limited(active_time)",
      dimension: "active_time",
    },
  ])(
    "atomically stops at the $label limit with deterministic priority",
    async (fixture) => {
      await withDataDir(async (dataDir) => {
        const store = new SqliteThreadGoalStore(
          dataDir,
          () => 1_700_000_000_010,
        );
        const created = await store.create({
          sessionId: `sess_limit_${fixture.dimension}`,
          objective: "audit",
        });

        const result = await store.bumpBoundUsage(
          bindingFor(created),
          fixture.delta,
          fixture.limits,
        );

        expect(result).toMatchObject({
          transitioned: fixture.dimension,
          goal: { status: "budget_limited", statusReason: fixture.reason },
        });
      });
    },
  );

  it("chains accounting epoch into settlement and rejects a later user mutation", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const created = await store.create({
        sessionId: "sess_epoch_chain",
        objective: "audit",
      });
      now += 10;
      const accounted = await store.bumpBoundUsage(
        bindingFor(created),
        { tokens: 5, activeSeconds: 2, mainTurns: 1 },
        TEST_LIMITS,
      );
      expect(accounted.staleReason).toBeUndefined();
      expect(accounted.decisionEpoch).toBe(now);

      now += 10;
      await store.patch(created.goalId, {
        objective: "user changed objective",
      });
      now += 10;
      await expect(
        store.settleBoundTurn({
          goalId: created.goalId,
          expectedEpoch: accounted.decisionEpoch!,
          objectiveDigest: digestThreadGoalObjective(created.objective),
          next: {
            status: "complete",
            statusReason: "complete(worker_proposal)",
          },
        }),
      ).resolves.toMatchObject({ status: "stale", staleReason: "goal_epoch" });
      expect(await store.getById(created.goalId)).toMatchObject({
        objective: "user changed objective",
        status: "active",
      });
    });
  });

  it("settles an exact active epoch and preserves the budget decision epoch for summary usage", async () => {
    await withDataDir(async (dataDir) => {
      let now = 1_700_000_000_000;
      const store = new SqliteThreadGoalStore(dataDir, () => now);
      const settleGoal = await store.create({
        sessionId: "sess_settle",
        objective: "audit",
      });
      now += 10;
      await expect(
        store.settleBoundTurn({
          goalId: settleGoal.goalId,
          expectedEpoch: settleGoal.updatedAt,
          objectiveDigest: digestThreadGoalObjective(settleGoal.objective),
          next: { status: "paused", statusReason: "paused(infra_retryable)" },
        }),
      ).resolves.toMatchObject({
        status: "settled",
        decisionEpoch: now,
        goal: { status: "paused", statusReason: "paused(infra_retryable)" },
      });

      now += 10;
      const limited = await store.create({
        sessionId: "sess_summary",
        objective: "summarize",
        tokenBudget: 1,
      });
      now += 10;
      const transition = await store.bumpBoundUsage(
        bindingFor(limited),
        { tokens: 1, activeSeconds: 1, mainTurns: 1 },
        { ...TEST_LIMITS, tokens: 1 },
      );
      now += 10;
      const summary = await store.bumpBoundUsage(
        bindingFor(transition.goal!, {
          admittedGoalUpdatedAt: transition.decisionEpoch,
          turnId: "turn-summary",
        }),
        { tokens: 3, activeSeconds: 2, mainTurns: 0 },
        TEST_LIMITS,
      );
      expect(summary).toMatchObject({
        decisionEpoch: transition.decisionEpoch,
        transitioned: null,
        goal: {
          status: "budget_limited",
          tokensUsed: 4,
          turnsUsed: 1,
          timeUsedSeconds: 3,
          updatedAt: transition.decisionEpoch,
        },
      });
    });
  });
});

/**
 * Issue #282: the v1 Goal store shares `runtime-state.sqlite` with every other
 * `mcode` process. A foreign writer holding the WAL write lock used to surface
 * `SQLITE_BUSY` out of `transaction(...).immediate()` and fail the Turn.
 */
describe("SqliteThreadGoalStore write contention", () => {
  it("commits a goal after a foreign writer outlasts the native busy timeout", async () => {
    await withDataDir(async (dataDir) => {
      openLocalRuntimeDb(dataDir);
      const holder = await holdForeignWriter(dataDir, 8_000);
      try {
        const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
        const goal = await store.create({ sessionId: "s-contended", objective: "survive" });
        expect(goal.status).toBe("active");
        expect((await store.getBySession("s-contended"))?.goalId).toBe(goal.goalId);
      } finally {
        await holder();
      }
    });
  }, 20_000);

  it("leaves reads on the synchronous path while a writer holds the lock", async () => {
    await withDataDir(async (dataDir) => {
      openLocalRuntimeDb(dataDir);
      const holder = await holdForeignWriter(dataDir, 2_000);
      try {
        const store = new SqliteThreadGoalStore(dataDir, () => 1_700_000_000_000);
        expect(await store.getBySession("missing")).toBeUndefined();
      } finally {
        await holder();
      }
    });
  }, 20_000);
});

/** Hold the single WAL write lock from another process, like a second `mcode`. */
async function holdForeignWriter(
  dataDir: string,
  durationMs: number,
): Promise<() => Promise<void>> {
  const { fork } = await import("node:child_process");
  const { once } = await import("node:events");
  const { createRequire } = await import("node:module");
  const { writeFile } = await import("node:fs/promises");
  const script = join(dataDir, "goal-lock-holder.cjs");
  await writeFile(
    script,
    `const Database = require(process.argv[2]);
     const db = new Database(process.argv[3]);
     db.exec('BEGIN IMMEDIATE');
     process.send('locked');
     setTimeout(() => { db.exec('COMMIT'); db.close(); process.disconnect(); }, Number(process.argv[4]));`,
  );
  const child = fork(
    script,
    [createRequire(import.meta.url).resolve("better-sqlite3"), resolveLocalRuntimeDbPath(dataDir), String(durationMs)],
    { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const exited = once(child, "exit");
  await Promise.race([
    once(child, "message"),
    exited.then(() => {
      throw new Error("Lock holder exited before acquiring the lock");
    }),
  ]);
  return async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
}
