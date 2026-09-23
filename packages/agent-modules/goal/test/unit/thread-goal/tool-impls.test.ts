/**
 * Thread Goal tool-impl tests against an in-memory ThreadGoalStore.
 *
 * Pins the codex-aligned semantics:
 * (a) create_goal rejects active / paused goals in the tool before writing,
 *     while the store remains the race-safe rejection backstop for other
 *     unfinished states; a complete goal is replaced,
 * (b) create_goal validates that the objective is non-empty without inventing
 *     an implicit length cap,
 * (c) update_goal preserves a user pause instead of overwriting it with
 *     a model-authored complete / blocked status,
 * (d) mutation tools fire the onChanged listener (host SSE projection,
 *     mirrors codex tool.rs emitting ThreadGoalUpdated on tool calls),
 * (e) get_goal returns null when missing, the serialized record when set.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  CreateGoalTool,
  UpdateGoalTool,
  GetGoalTool,
  type ThreadGoalTokenBudgetMutationPort,
  type ThreadGoalSignalCollector,
} from "../../../src/tool-impls.js";
import {
  ThreadGoalAlreadyExistsError,
  ThreadGoalObjectiveConflictError,
  ThreadGoalStatusConflictError,
  type ThreadGoalBreakerResult,
  type ThreadGoalCreateInput,
  type ThreadGoalPatchInput,
  type ThreadGoalStore,
} from "../../../src/store-port.js";
import type { ThreadGoalState } from "../../../src/types.js";

class InMemoryThreadGoalStore implements ThreadGoalStore {
  private bySession = new Map<string, ThreadGoalState>();
  private byId = new Map<string, ThreadGoalState>();
  private seq = 0;
  // Deterministic clock so tests don't depend on real time.
  public now = 1_700_000_000_000;

  async getBySession(sessionId: string): Promise<ThreadGoalState | undefined> {
    return this.bySession.get(sessionId);
  }
  async getById(goalId: string): Promise<ThreadGoalState | undefined> {
    return this.byId.get(goalId);
  }
  async create(input: ThreadGoalCreateInput): Promise<ThreadGoalState> {
    const existing = this.bySession.get(input.sessionId);
    // codex insert_thread_goal: replace only a complete goal; anything
    // else (active / paused / blocked) counts as unfinished.
    if (existing && existing.status !== "complete") {
      throw new ThreadGoalAlreadyExistsError(existing.goalId);
    }
    if (existing) {
      this.byId.delete(existing.goalId);
    }
    this.seq += 1;
    const goal: ThreadGoalState = {
      goalId: `tg_${this.seq}`,
      sessionId: input.sessionId,
      objective: input.objective,
      status: "active",
      createdAt: this.now,
      updatedAt: this.now,
      tokensUsed: 0,
      turnsUsed: 0,
      timeUsedSeconds: 0,
      tokenBudget: input.tokenBudget ?? null,
      replyFingerprint: null,
      noProgressStreak: 0,
      lastVerification: undefined,
      statusReason: null,
      kickoffAttachments: (input.kickoffAttachments ?? []).map(
        (attachment) => ({
          ...attachment,
        }),
      ),
      kickoffState: "pending",
    };
    this.bySession.set(input.sessionId, goal);
    this.byId.set(goal.goalId, goal);
    return goal;
  }
  async patch(
    goalId: string,
    input: ThreadGoalPatchInput,
  ): Promise<ThreadGoalState> {
    const existing = this.byId.get(goalId);
    if (!existing) throw new Error(`goal ${goalId} not found`);
    if (existing.status === input.rejectIfCurrentStatus) {
      throw new ThreadGoalStatusConflictError(goalId, existing.status);
    }
    if (
      input.rejectIfObjectiveChangedFrom !== undefined &&
      existing.objective !== input.rejectIfObjectiveChangedFrom
    ) {
      throw new ThreadGoalObjectiveConflictError(
        goalId,
        input.rejectIfObjectiveChangedFrom,
        existing.objective,
      );
    }
    this.now += 1;
    const next: ThreadGoalState = {
      ...existing,
      status: input.status ?? existing.status,
      objective: input.objective ?? existing.objective,
      statusReason:
        input.statusReason === undefined
          ? existing.statusReason
          : input.statusReason,
      updatedAt: this.now,
    };
    this.byId.set(goalId, next);
    this.bySession.set(existing.sessionId, next);
    return next;
  }
  async updateBreaker(): Promise<ThreadGoalBreakerResult> {
    return { action: "stale", staleReason: "missing_goal" };
  }
  async delete(goalId: string): Promise<void> {
    const existing = this.byId.get(goalId);
    if (!existing) return;
    this.byId.delete(goalId);
    this.bySession.delete(existing.sessionId);
  }
}

const ctx = { sessionId: "sess_a", turnId: "turn_a" } as const;

function signalCollector(
  result: ReturnType<ThreadGoalSignalCollector["collect"]> = "accepted",
) {
  return { collect: vi.fn(() => result) } satisfies ThreadGoalSignalCollector;
}

function budgetMutation(
  result: Awaited<
    ReturnType<ThreadGoalTokenBudgetMutationPort["updateTokenBudget"]>
  >,
) {
  return {
    updateTokenBudget: vi.fn(async () => result),
  } satisfies ThreadGoalTokenBudgetMutationPort;
}

describe("thread-goal tool impls", () => {
  let store: InMemoryThreadGoalStore;
  beforeEach(() => {
    store = new InMemoryThreadGoalStore();
  });

  describe("CreateGoalTool", () => {
    it("creates a new active goal when none exists", async () => {
      const tool = new CreateGoalTool(store);
      const result = await tool.execute(ctx, { objective: "Ship the feature" });
      expect(result.tool_name).toBe("create_goal");
      const payload = JSON.parse(result.text) as { goal: ThreadGoalState };
      expect(payload.goal.objective).toBe("Ship the feature");
      expect(payload.goal.status).toBe("active");
      expect(payload.goal.sessionId).toBe("sess_a");
    });

    it("rejects empty objective with the codex-verbatim message", async () => {
      const tool = new CreateGoalTool(store);
      const result = await tool.execute(ctx, { objective: "   " });
      const payload = JSON.parse(result.text) as { error: string };
      expect(payload.error).toBe("goal objective must not be empty");
    });

    it("does not impose an objective length limit by default", async () => {
      const tool = new CreateGoalTool(store);
      const objective = "x".repeat(4_001);
      const result = await tool.execute(ctx, {
        objective,
      });
      const payload = JSON.parse(result.text) as { goal: ThreadGoalState };
      expect(payload.goal.objective).toBe(objective);
      expect(await store.getBySession(ctx.sessionId)).toMatchObject({
        objective,
      });
    });

    it("refuses before create when an active goal already exists", async () => {
      const tool = new CreateGoalTool(store);
      await store.create({ sessionId: ctx.sessionId, objective: "First" });
      const createSpy = vi.spyOn(store, "create");
      const second = await tool.execute(ctx, { objective: "Second" });
      const payload = JSON.parse(second.text) as {
        error: string;
        existingGoalId: string;
        existingStatus: string;
      };
      expect(payload.error).toBe(
        "this thread already has a goal with status active; do not create another goal",
      );
      expect(payload.existingGoalId).toBe("tg_1");
      expect(payload.existingStatus).toBe("active");
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("refuses before create when a paused goal already exists", async () => {
      await store.create({ sessionId: ctx.sessionId, objective: "First" });
      const first = await store.getBySession(ctx.sessionId);
      await store.patch(first!.goalId, { status: "paused" });
      const createSpy = vi.spyOn(store, "create");
      const second = await new CreateGoalTool(store).execute(ctx, {
        objective: "Second",
      });
      const payload = JSON.parse(second.text) as {
        error: string;
        existingGoalId: string;
        existingStatus: string;
      };
      expect(payload.error).toBe(
        "this thread already has a goal with status paused; do not create another goal",
      );
      expect(payload.existingGoalId).toBe("tg_1");
      expect(payload.existingStatus).toBe("paused");
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("refuses over a blocked goal — blocked counts as unfinished (codex parity)", async () => {
      await new CreateGoalTool(store).execute(ctx, { objective: "First" });
      const first = await store.getBySession(ctx.sessionId);
      await store.patch(first!.goalId, { status: "blocked" });
      const second = await new CreateGoalTool(store).execute(ctx, {
        objective: "Second",
      });
      const payload = JSON.parse(second.text) as { error: string };
      expect(payload.error).toContain("unfinished goal");
    });

    it("replaces a complete goal with a fresh active one (codex ON CONFLICT semantics)", async () => {
      await new CreateGoalTool(store).execute(ctx, { objective: "First" });
      const first = await store.getBySession(ctx.sessionId);
      await store.patch(first!.goalId, { status: "complete" });
      const second = await new CreateGoalTool(store).execute(ctx, {
        objective: "Second",
      });
      const payload = JSON.parse(second.text) as { goal: ThreadGoalState };
      expect(payload.goal.objective).toBe("Second");
      expect(payload.goal.status).toBe("active");
      expect(payload.goal.goalId).not.toBe("tg_1");
    });

    it("fires onChanged with the created goal", async () => {
      const seen: ThreadGoalState[] = [];
      const tool = new CreateGoalTool(store, (goal) => seen.push(goal));
      await tool.execute(ctx, { objective: "Notify me" });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.objective).toBe("Notify me");
      expect(seen[0]?.status).toBe("active");
    });

    it("does NOT fire onChanged when creation is rejected", async () => {
      const seen: ThreadGoalState[] = [];
      await new CreateGoalTool(store).execute(ctx, { objective: "First" });
      const tool = new CreateGoalTool(store, (goal) => seen.push(goal));
      await tool.execute(ctx, { objective: "Second" });
      expect(seen).toHaveLength(0);
    });
  });

  describe("UpdateGoalTool", () => {
    it("updates the token budget through the host mutation port without ending the turn", async () => {
      const goal = await store.create({
        sessionId: ctx.sessionId,
        objective: "x",
        tokenBudget: 80_000,
      });
      const updated = {
        ...goal,
        tokenBudget: 160_000,
        updatedAt: goal.updatedAt + 1,
      };
      const mutation = budgetMutation({
        updated: true,
        goal: updated,
        previousTokenBudget: 80_000,
        resumed: false,
      });
      const collector = signalCollector();

      const result = await new UpdateGoalTool(
        store,
        collector,
        mutation,
      ).execute(ctx, {
        token_budget: 160_000,
        expected_goal_id: goal.goalId,
        expected_updated_at: goal.updatedAt,
      });

      expect(result.terminate).not.toBe(true);
      expect(JSON.parse(result.text)).toEqual({
        updated: true,
        previousTokenBudget: 80_000,
        goal: expect.objectContaining({
          goalId: goal.goalId,
          status: "active",
          tokenBudget: 160_000,
        }),
        resumed: false,
      });
      expect(mutation.updateTokenBudget).toHaveBeenCalledWith(ctx, {
        tokenBudget: 160_000,
        expectedGoalId: goal.goalId,
        expectedUpdatedAt: goal.updatedAt,
      });
      expect(collector.collect).not.toHaveBeenCalled();
    });

    it("clears the token budget and reports a token-limited Goal resume", async () => {
      const goal = await store.create({
        sessionId: ctx.sessionId,
        objective: "x",
        tokenBudget: 80_000,
      });
      const mutation = budgetMutation({
        updated: true,
        goal: {
          ...goal,
          status: "active",
          statusReason: null,
          tokenBudget: null,
          updatedAt: goal.updatedAt + 1,
        },
        previousTokenBudget: 80_000,
        resumed: true,
      });

      const result = await new UpdateGoalTool(
        store,
        signalCollector(),
        mutation,
      ).execute(ctx, {
        token_budget: null,
        expected_goal_id: goal.goalId,
        expected_updated_at: goal.updatedAt,
      });

      expect(JSON.parse(result.text)).toMatchObject({
        updated: true,
        previousTokenBudget: 80_000,
        goal: { status: "active", tokenBudget: null },
        resumed: true,
      });
    });

    it("returns the host rejection and allows a retry until one budget update succeeds", async () => {
      const goal = await store.create({
        sessionId: ctx.sessionId,
        objective: "x",
      });
      const mutation = {
        updateTokenBudget: vi
          .fn<ThreadGoalTokenBudgetMutationPort["updateTokenBudget"]>()
          .mockResolvedValueOnce({
            updated: false,
            error:
              "goal changed; call get_goal again before updating the token budget",
            currentGoal: goal,
          })
          .mockResolvedValueOnce({
            updated: true,
            goal: {
              ...goal,
              tokenBudget: 160_000,
              updatedAt: goal.updatedAt + 1,
            },
            previousTokenBudget: null,
            resumed: false,
          }),
      } satisfies ThreadGoalTokenBudgetMutationPort;
      const tool = new UpdateGoalTool(store, signalCollector(), mutation);
      const input = {
        token_budget: 160_000,
        expected_goal_id: goal.goalId,
        expected_updated_at: goal.updatedAt,
      } as const;

      expect(JSON.parse((await tool.execute(ctx, input)).text).error).toContain(
        "call get_goal again",
      );
      expect(JSON.parse((await tool.execute(ctx, input)).text).updated).toBe(
        true,
      );
      expect(JSON.parse((await tool.execute(ctx, input)).text).error).toContain(
        "already updated the token budget during this turn",
      );
      expect(mutation.updateTokenBudget).toHaveBeenCalledTimes(2);
    });

    it.each([
      [
        { status: "complete", token_budget: 160_000 },
        "cannot combine status and token_budget",
      ],
      [
        { token_budget: 160_000 },
        "expected_goal_id and expected_updated_at are required",
      ],
      [
        {
          token_budget: "80K",
          expected_goal_id: "tg_1",
          expected_updated_at: 1,
        },
        "token_budget must be a positive integer or null",
      ],
      [{}, "provide either status or token_budget"],
    ] as const)("rejects an invalid update mode %#", async (input, error) => {
      const mutation = budgetMutation({
        updated: false,
        error: "must not be called",
      });
      const result = await new UpdateGoalTool(
        store,
        signalCollector(),
        mutation,
      ).execute(ctx, input as never);

      expect(JSON.parse(result.text).error).toContain(error);
      expect(mutation.updateTokenBudget).not.toHaveBeenCalled();
    });

    it("points a mode-less mixed call at the mode field", async () => {
      const result = await new UpdateGoalTool(store, signalCollector()).execute(
        ctx,
        {
          status: "complete",
          token_budget: 160_000,
        } as never,
      );
      expect(JSON.parse(result.text).error).toContain(
        'set mode to "status" or "token_budget" to disambiguate',
      );
    });

    it("updates the budget when mode is token_budget despite terminal filler fields", async () => {
      // Verbatim production payload from hy-5.6-luna (a model that materializes
      // every schema property), plus the explicit mode it is now steered to set.
      const goal = await store.create({
        sessionId: ctx.sessionId,
        objective: "x",
        tokenBudget: 50_000,
      });
      const mutation = budgetMutation({
        updated: true,
        goal: { ...goal, tokenBudget: 100_000, updatedAt: goal.updatedAt + 1 },
        previousTokenBudget: 50_000,
        resumed: true,
      });
      const collector = signalCollector();

      const result = await new UpdateGoalTool(
        store,
        collector,
        mutation,
      ).execute(ctx, {
        mode: "token_budget",
        status: "complete",
        summary: "预算更新请求",
        token_budget: 100_000,
        expected_goal_id: goal.goalId,
        expected_updated_at: goal.updatedAt,
      });

      expect(JSON.parse(result.text)).toMatchObject({
        updated: true,
        previousTokenBudget: 50_000,
        goal: { tokenBudget: 100_000 },
        resumed: true,
      });
      expect(result.terminate).not.toBe(true);
      expect(collector.collect).not.toHaveBeenCalled();
      expect(mutation.updateTokenBudget).toHaveBeenCalledWith(ctx, {
        tokenBudget: 100_000,
        expectedGoalId: goal.goalId,
        expectedUpdatedAt: goal.updatedAt,
      });
    });

    it("proposes a terminal status when mode is status despite a numeric budget filler", async () => {
      const goal = await store.create({
        sessionId: ctx.sessionId,
        objective: "x",
      });
      const collector = signalCollector();
      const mutation = budgetMutation({
        updated: false,
        error: "must not be called",
      });

      const result = await new UpdateGoalTool(
        store,
        collector,
        mutation,
      ).execute(ctx, {
        mode: "status",
        status: "complete",
        summary: "Done.",
        token_budget: 100_000,
        expected_goal_id: goal.goalId,
        expected_updated_at: goal.updatedAt,
      });

      expect(JSON.parse(result.text).proposal).toMatchObject({
        status: "complete",
        summary: "Done.",
        accepted: true,
      });
      expect(result.terminate).toBe(true);
      expect(mutation.updateTokenBudget).not.toHaveBeenCalled();
    });

    it("rejects mode status without a valid terminal status value", async () => {
      await store.create({ sessionId: ctx.sessionId, objective: "x" });
      const collector = signalCollector();
      for (const status of [undefined, null, "paused"]) {
        const result = await new UpdateGoalTool(store, collector).execute(ctx, {
          mode: "status",
          status,
        } as never);
        expect(JSON.parse(result.text).error).toContain(
          'status must be "complete" or "blocked"',
        );
      }
      expect(collector.collect).not.toHaveBeenCalled();
    });

    it("requires the get_goal CAS pair even when mode is token_budget", async () => {
      const result = await new UpdateGoalTool(
        store,
        signalCollector(),
        budgetMutation({ updated: false, error: "must not be called" }),
      ).execute(ctx, { mode: "token_budget", token_budget: 100_000 });
      expect(JSON.parse(result.text).error).toContain(
        "expected_goal_id and expected_updated_at are required",
      );
    });

    it('returns the codex-verbatim "no goal" message when the session has none', async () => {
      const collector = signalCollector();
      const tool = new UpdateGoalTool(store, collector);
      const result = await tool.execute(ctx, { status: "complete" });
      const payload = JSON.parse(result.text) as { error: string };
      expect(payload.error).toBe(
        "cannot update goal because this thread has no goal",
      );
      // A refused proposal has to reach the model as a failed tool call, not as
      // ordinary output that reads like a normal result.
      expect(result.isError).toBe(true);
      expect(collector.collect).not.toHaveBeenCalled();
    });

    it("marks every rejection path as a tool error and leaves the Goal untouched", async () => {
      await new CreateGoalTool(store).execute(ctx, { objective: "Keep me" });
      const before = await store.getBySession(ctx.sessionId);
      const patch = vi.spyOn(store, "patch");

      const stale = await new UpdateGoalTool(
        store,
        signalCollector("stale"),
      ).execute(ctx, {
        status: "complete",
      });
      const unbound = await new UpdateGoalTool(
        store,
        signalCollector("not_a_goal_turn"),
      ).execute(ctx, { status: "complete" });
      const missingMode = await new UpdateGoalTool(
        store,
        signalCollector(),
      ).execute(ctx, {
        mode: "status",
        status: "not_a_status" as never,
      });

      expect(stale.isError).toBe(true);
      expect(unbound.isError).toBe(true);
      expect(unbound.terminate).toBeUndefined();
      expect(missingMode.isError).toBe(true);
      expect(patch).not.toHaveBeenCalled();
      expect(await store.getBySession(ctx.sessionId)).toEqual(before);
    });

    it("does not mark an accepted proposal as a tool error", async () => {
      await new CreateGoalTool(store).execute(ctx, { objective: "x" });
      const result = await new UpdateGoalTool(store, signalCollector()).execute(
        ctx,
        {
          status: "complete",
        },
      );
      expect(result.isError).toBeUndefined();
    });

    it('returns the "no goal" message after the current goal was deleted', async () => {
      const created = await store.create({
        sessionId: ctx.sessionId,
        objective: "Gone",
      });
      await store.delete(created.goalId);

      const result = await new UpdateGoalTool(store, signalCollector()).execute(
        ctx,
        {
          status: "complete",
        },
      );
      const payload = JSON.parse(result.text) as { error: string };

      expect(payload.error).toBe(
        "cannot update goal because this thread has no goal",
      );
    });

    it.each([
      ["complete", "completion_proposed"],
      ["blocked", "block_proposed"],
    ] as const)(
      "collects an active %s proposal without mutating durable state",
      async (status, type) => {
        await new CreateGoalTool(store).execute(ctx, { objective: "x" });
        const collector = signalCollector();
        const patch = vi.spyOn(store, "patch");
        const result = await new UpdateGoalTool(store, collector).execute(ctx, {
          status,
        });
        const payload = JSON.parse(result.text) as {
          proposal: { status: string; accepted: boolean; settlement: string };
          goal: ThreadGoalState;
          goalSnapshotPhase: string;
        };

        expect(payload.proposal).toEqual({
          status,
          accepted: true,
          settlement: "pending_host_validation",
        });
        expect(payload.goal.status).toBe("active");
        expect(payload.goalSnapshotPhase).toBe("before_host_settlement");
        expect(result.terminate).toBe(true);
        expect(collector.collect).toHaveBeenCalledWith(ctx, {
          type,
          goalId: "tg_1",
          objectiveDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        });
        expect(patch).not.toHaveBeenCalled();
        expect((await store.getBySession(ctx.sessionId))?.status).toBe(
          "active",
        );
      },
    );

    it.each([
      ["complete", "completion_proposed"],
      ["blocked", "block_proposed"],
    ] as const)(
      "treats provider-materialized token_budget null as an active %s proposal",
      async (status, type) => {
        const goal = await store.create({
          sessionId: ctx.sessionId,
          objective: "x",
        });
        const collector = signalCollector();
        const mutation = budgetMutation({
          updated: false,
          error: "must not be called",
        });
        const result = await new UpdateGoalTool(
          store,
          collector,
          mutation,
        ).execute(ctx, {
          status,
          summary: "The Goal is terminal.",
          token_budget: null,
          expected_goal_id: goal.goalId,
          expected_updated_at: goal.updatedAt,
        });

        expect(JSON.parse(result.text).proposal).toMatchObject({
          status,
          summary: "The Goal is terminal.",
          accepted: true,
          settlement: "pending_host_validation",
        });
        expect(result.terminate).toBe(true);
        expect(collector.collect).toHaveBeenCalledWith(ctx, {
          type,
          goalId: goal.goalId,
          objectiveDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          summary: "The Goal is terminal.",
        });
        expect(mutation.updateTokenBudget).not.toHaveBeenCalled();
      },
    );

    it("terminates a proposal rejected by the host as an invalidated Turn", async () => {
      await new CreateGoalTool(store).execute(ctx, {
        objective: "Updated objective",
      });
      const collector = signalCollector("stale");
      const patch = vi.spyOn(store, "patch");
      const result = await new UpdateGoalTool(store, collector).execute(ctx, {
        status: "complete",
      });
      const payload = JSON.parse(result.text) as {
        error: string;
        currentGoal: ThreadGoalState;
      };

      expect(payload.error).toContain("objective changed during this turn");
      expect(payload.currentGoal).toMatchObject({
        objective: "Updated objective",
        status: "active",
      });
      expect(result.terminate).toBe(true);
      expect(collector.collect).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({
          type: "completion_proposed",
          goalId: "tg_1",
        }),
      );
      expect(patch).not.toHaveBeenCalled();
    });

    it("passes a trimmed completion summary through the turn-local proposal only", async () => {
      await new CreateGoalTool(store).execute(ctx, { objective: "x" });
      const collector = signalCollector();
      const result = await new UpdateGoalTool(store, collector).execute(ctx, {
        status: "complete",
        summary: "  Changed verifier.ts and ran its focused test.  ",
      });

      expect(JSON.parse(result.text).proposal).toEqual({
        status: "complete",
        summary: "Changed verifier.ts and ran its focused test.",
        accepted: true,
        settlement: "pending_host_validation",
      });
      expect(collector.collect).toHaveBeenCalledWith(ctx, {
        type: "completion_proposed",
        goalId: "tg_1",
        objectiveDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        summary: "Changed verifier.ts and ran its focused test.",
      });
    });

    it.each(["complete", "blocked"] as const)(
      "rejects changing a PAUSED goal to %s and preserves the user pause",
      async (status) => {
        const collector = signalCollector();
        await new CreateGoalTool(store).execute(ctx, { objective: "x" });
        const goal = await store.getBySession(ctx.sessionId);
        await store.patch(goal!.goalId, { status: "paused" });
        const result = await new UpdateGoalTool(store, collector).execute(ctx, {
          status,
        });
        const payload = JSON.parse(result.text) as {
          error: string;
          currentStatus: string;
        };
        expect(payload.error).toBe(
          "cannot update goal because it is paused; resume the goal before completing or blocking it",
        );
        expect(payload.currentStatus).toBe("paused");
        expect((await store.getBySession(ctx.sessionId))?.status).toBe(
          "paused",
        );
        expect(collector.collect).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        "no_goal",
        "cannot update goal because this thread has no goal",
        undefined,
      ],
      [
        "paused",
        "cannot update goal because it is paused; resume the goal before completing or blocking it",
        "paused",
      ],
    ] as const)(
      "maps a collector %s race to the existing rejection",
      async (result, error, currentStatus) => {
        await new CreateGoalTool(store).execute(ctx, { objective: "x" });
        const response = await new UpdateGoalTool(
          store,
          signalCollector(result),
        ).execute(ctx, {
          status: "complete",
        });
        const payload = JSON.parse(response.text) as {
          error: string;
          currentStatus?: string;
        };
        expect(payload.error).toBe(error);
        expect(payload.currentStatus).toBe(currentStatus);
        expect((await store.getBySession(ctx.sessionId))?.status).toBe(
          "active",
        );
      },
    );
  });

  describe("GetGoalTool", () => {
    it("returns goal:null when none exists", async () => {
      const result = await new GetGoalTool(store).execute(ctx, {});
      const payload = JSON.parse(result.text) as { goal: unknown };
      expect(payload.goal).toBeNull();
    });

    it("returns the serialized goal record when set", async () => {
      await new CreateGoalTool(store).execute(ctx, { objective: "See me" });
      const result = await new GetGoalTool(store).execute(ctx, {});
      const payload = JSON.parse(result.text) as { goal: ThreadGoalState };
      expect(payload.goal.objective).toBe("See me");
      expect(payload.goal.status).toBe("active");
    });

    it.each([
      "active",
      "paused",
      "blocked",
      "complete",
      "budget_limited",
    ] as const)(
      "returns status information when the current goal is %s",
      async (status) => {
        const created = await store.create({
          sessionId: ctx.sessionId,
          objective: "Status check",
        });
        if (status !== "active") {
          await store.patch(created.goalId, { status });
        }

        const result = await new GetGoalTool(store).execute(ctx, {});
        const payload = JSON.parse(result.text) as { goal: ThreadGoalState };

        expect(payload.goal.status).toBe(status);
      },
    );
  });
});
