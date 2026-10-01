import {
  LocalActiveTurnTimingRegistry,
  LocalThreadGoalIntegration,
  admitGoalTurn,
  boundUsageResult,
  continuationQueueItem,
  describe,
  digestThreadGoalObjective,
  expect,
  flushContinuationKick,
  goal,
  it,
  kickoffQueueItem,
  makeIntegration,
  makeStore,
  settledDecision,
  submitGoalProposal,
  vi,
  type GoalTurnBinding,
  type HostGoalStore,
  type LocalQueuedMessage,
  type ThreadGoalBoundUsageDelta,
  type ThreadGoalBoundUsageResult,
  type ThreadGoalDecisionResult,
  type ThreadGoalState,
} from "./host-integration-testkit.js";

describe("LocalThreadGoalIntegration injected v2 Turn settlement", () => {
  it("accounts a bound main Turn and durably queues its continuation", async () => {
    const active = goal();
    const bumpBoundUsage = vi.fn(async () => boundUsageResult(active));
    const updateBreaker = vi.fn();
    const enqueuePostTurnContinuation = vi.fn(async () => undefined);
    const { integration, emitRuntimeEvent } = makeIntegration({
      store: makeStore({
        getBySession: async () => active,
        bumpBoundUsage,
        updateBreaker,
      }),
      enqueuePostTurnContinuation,
    });
    await admitGoalTurn(integration, active, "turn_int");

    const decision = await integration.settleInjectedTurn({
      sessionId: active.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 10,
      retracted: false,
      usageIncomplete: true,
    });

    expect(decision).toEqual({
      stage: 10,
      action: "continued",
      reason: "goal_active",
      goalId: active.goalId,
      decisionEpoch: active.updatedAt,
    });

    expect(bumpBoundUsage).toHaveBeenCalledWith(
      expect.objectContaining({ goalId: active.goalId, turnId: "turn_int" }),
      { tokens: 10, activeSeconds: 0, mainTurns: 1 },
      { tokens: null, mainTurns: null, activeSeconds: null },
    );
    expect(updateBreaker).not.toHaveBeenCalled();
    expect(emitRuntimeEvent).toHaveBeenCalledWith({
      type: "goal.turn_settled",
      at: 1_700_000_000_000,
      payload: expect.objectContaining({
        goalId: active.goalId,
        sessionId: active.sessionId,
        turnId: "turn_int",
        status: "completed",
        tokens: 10,
        usageIncomplete: true,
      }),
    });
    expect(enqueuePostTurnContinuation).toHaveBeenCalledWith({
      sessionId: active.sessionId,
      turnId: "turn_int",
      message: expect.objectContaining({
        content: expect.stringContaining(
          "follow the goal contract from the kickoff context",
        ),
        origin: expect.objectContaining({
          goalId: active.goalId,
          kind: "active",
        }),
      }),
    });
  });

  it("pauses a bound Goal with a distinct reason when accounting fails", async () => {
    const active = goal();
    const paused = goal({
      status: "paused",
      statusReason: "paused(accounting_unavailable)",
      updatedAt: active.updatedAt + 1,
    });
    const settleBoundTurn = vi.fn(async () => settledDecision(paused));
    const reportFailure = vi.fn();
    const { integration, emitBusEvent } = makeIntegration({
      store: makeStore({
        getBySession: async () => active,
        bumpBoundUsage: async () => {
          throw new Error("sqlite busy");
        },
        settleBoundTurn,
      }),
      reportFailure,
    });
    await admitGoalTurn(integration, active, "turn_int");

    await expect(
      integration.settleInjectedTurn({
        sessionId: active.sessionId,
        turnId: "turn_int",
        status: "completed",
        tokens: 10,
        retracted: false,
      }),
    ).resolves.toEqual({
      stage: 1,
      action: "settled",
      reason: "paused(accounting_unavailable)",
      goalId: paused.goalId,
      decisionEpoch: paused.updatedAt,
    });
    expect(settleBoundTurn).toHaveBeenCalledWith({
      goalId: active.goalId,
      expectedEpoch: active.updatedAt,
      objectiveDigest: digestThreadGoalObjective(active.objective),
      next: {
        status: "paused",
        statusReason: "paused(accounting_unavailable)",
      },
    });
    expect(reportFailure).toHaveBeenCalledWith(
      active.sessionId,
      "thread_goal_accounting_failed:sqlite busy",
    );
    expect(emitBusEvent).toHaveBeenCalledWith({
      type: "thread_goal.updated",
      payload: {
        goal: expect.objectContaining({
          goalId: paused.goalId,
          status: "paused",
          statusReason: "paused(accounting_unavailable)",
        }),
      },
    });
  });

  it("settles an accepted completion proposal only after accounting and breaker CAS", async () => {
    const active = goal();
    let current = active;
    const accounted = goal({ turnsUsed: 1, updatedAt: active.updatedAt + 1 });
    const breakerChecked = goal({
      turnsUsed: 1,
      replyFingerprint: "checked",
      updatedAt: accounted.updatedAt + 1,
    });
    const completed = goal({
      status: "complete",
      statusReason: "complete(worker_proposal)",
      turnsUsed: 1,
      replyFingerprint: "checked",
      updatedAt: breakerChecked.updatedAt + 1,
    });
    const updateBreaker = vi.fn(async () => {
      current = breakerChecked;
      return {
        action: "none" as const,
        goal: breakerChecked,
        epoch: breakerChecked.updatedAt,
      };
    });
    const settleBoundTurn = vi.fn(async () => {
      current = completed;
      return settledDecision(completed);
    });
    const enqueuePostTurnContinuation = vi.fn(async () => undefined);
    const { integration } = makeIntegration({
      store: makeStore({
        getBySession: async () => current,
        bumpBoundUsage: async () => {
          current = accounted;
          return boundUsageResult(accounted);
        },
        updateBreaker,
        settleBoundTurn,
      }),
      enqueuePostTurnContinuation,
    });
    await admitGoalTurn(integration, active, "turn_int");

    const proposal = await submitGoalProposal(integration, "complete");
    expect(JSON.parse(proposal.text)).toMatchObject({
      proposal: { status: "complete" },
      goal: { status: "active" },
    });
    expect(proposal.terminate).toBe(true);
    expect(current.status).toBe("active");

    const decision = await integration.settleInjectedTurn({
      sessionId: active.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 0,
      retracted: false,
      finalAssistantText: "all work is complete",
    });

    expect(decision).toEqual({
      stage: 9,
      action: "settled",
      reason: "complete(worker_proposal)",
      goalId: completed.goalId,
      decisionEpoch: completed.updatedAt,
    });

    expect(updateBreaker).toHaveBeenCalledWith(active.goalId, {
      expectedEpoch: accounted.updatedAt,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      toolActivity: "unknown",
      limit: 3,
      pauseReason: "paused(no_progress_after_completion_claim)",
    });
    expect(settleBoundTurn).toHaveBeenCalledWith({
      goalId: active.goalId,
      expectedEpoch: breakerChecked.updatedAt,
      objectiveDigest: digestThreadGoalObjective(active.objective),
      next: { status: "complete", statusReason: "complete(worker_proposal)" },
      workerProposal: { type: "complete", turnId: "turn_int" },
    });
    expect(current.status).toBe("complete");
    expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
  });

  it("lets a block proposal win over completion in the same Turn and skips the breaker", async () => {
    const active = goal();
    const accounted = goal({ turnsUsed: 1, updatedAt: active.updatedAt + 1 });
    const blocked = goal({
      status: "blocked",
      statusReason: "blocked(worker_reported)",
      turnsUsed: 1,
      updatedAt: accounted.updatedAt + 1,
    });
    const updateBreaker = vi.fn();
    const settleBoundTurn = vi.fn(async () => settledDecision(blocked));
    const { integration, emitRuntimeEvent, enqueuePostTurnContinuation } =
      makeIntegration({
        store: makeStore({
          getBySession: async () => active,
          bumpBoundUsage: async () => boundUsageResult(accounted),
          updateBreaker,
          settleBoundTurn,
        }),
      });
    await admitGoalTurn(integration, active, "turn_int");
    await submitGoalProposal(integration, "complete");
    await submitGoalProposal(
      integration,
      "blocked",
      "turn_int",
      "The same inaccessible dependency persisted.",
    );

    await integration.settleInjectedTurn({
      sessionId: active.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 0,
      retracted: false,
      finalAssistantText: "cannot proceed",
    });

    expect(settleBoundTurn).toHaveBeenCalledWith({
      goalId: active.goalId,
      expectedEpoch: accounted.updatedAt,
      objectiveDigest: digestThreadGoalObjective(active.objective),
      next: { status: "blocked", statusReason: "blocked(worker_reported)" },
      workerProposal: {
        type: "blocked",
        turnId: "turn_int",
        summary: "The same inaccessible dependency persisted.",
      },
    });
    expect(emitRuntimeEvent).toHaveBeenCalledWith({
      type: "goal.worker_proposal_decided",
      at: 1_700_000_000_000,
      payload: {
        goalId: active.goalId,
        sessionId: active.sessionId,
        turnId: "turn_int",
        source: "worker",
        proposal: "blocked",
        disposition: "accepted",
        resultStatus: "blocked",
        statusReason: "blocked(worker_reported)",
        summaryPresent: true,
        summaryDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(updateBreaker).not.toHaveBeenCalled();
    expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
  });

  it("keeps a concurrent user pause authoritative after proposal collection", async () => {
    let current = goal();
    const admitted = current;
    const paused = goal({
      status: "paused",
      statusReason: "paused(user_requested)",
      updatedAt: current.updatedAt + 1,
    });
    const settleBoundTurn = vi.fn();
    const { integration, enqueuePostTurnContinuation } = makeIntegration({
      store: makeStore({
        getBySession: async () => current,
        bumpBoundUsage: async (_binding, delta) =>
          boundUsageResult(
            {
              ...paused,
              tokensUsed: paused.tokensUsed + delta.tokens,
              turnsUsed: paused.turnsUsed + delta.mainTurns,
            },
            { staleReason: "goal_epoch" },
          ),
        settleBoundTurn,
      }),
    });
    await admitGoalTurn(integration, admitted, "turn_int");
    await submitGoalProposal(integration, "complete");
    current = paused;

    await integration.settleInjectedTurn({
      sessionId: admitted.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 5,
      retracted: false,
    });

    expect(settleBoundTurn).not.toHaveBeenCalled();
    expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
    expect(current.status).toBe("paused");
  });

  it("queues a deferable continuation without breaker work when a dependency appears", async () => {
    const active = goal();
    let current = active;
    const accounted = goal({ turnsUsed: 1, updatedAt: active.updatedAt + 1 });
    let pendingPermission = false;
    const settleBoundTurn = vi.fn();
    const updateBreaker = vi.fn();
    const { integration, enqueuePostTurnContinuation } = makeIntegration({
      store: makeStore({
        getBySession: async () => current,
        bumpBoundUsage: async () => {
          current = accounted;
          return boundUsageResult(accounted);
        },
        updateBreaker,
        settleBoundTurn,
      }),
      hasPendingPermission: async () => pendingPermission,
    });
    await admitGoalTurn(integration, active, "turn_int");
    await submitGoalProposal(integration, "complete");
    pendingPermission = true;

    const decision = await integration.settleInjectedTurn({
      sessionId: active.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 0,
      retracted: false,
    });

    expect(decision).toEqual({
      stage: 5,
      action: "deferred",
      reason: "deferred(permission)",
      goalId: active.goalId,
      decisionEpoch: accounted.updatedAt,
    });
    expect(settleBoundTurn).not.toHaveBeenCalled();
    expect(updateBreaker).not.toHaveBeenCalled();
    expect(enqueuePostTurnContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: active.sessionId,
        turnId: "turn_int",
        message: expect.objectContaining({
          origin: expect.objectContaining({
            goalUpdatedAt: accounted.updatedAt,
          }),
        }),
      }),
    );
    expect(current.status).toBe("active");
  });

  it("applies the dependency gate even without a terminal proposal", async () => {
    const active = goal();
    let pendingQuestionnaire = false;
    const updateBreaker = vi.fn();
    const { integration, enqueuePostTurnContinuation } = makeIntegration({
      store: makeStore({
        getBySession: async () => active,
        bumpBoundUsage: async () => boundUsageResult(active),
        updateBreaker,
      }),
      hasPendingQuestionnaire: async () => pendingQuestionnaire,
    });
    await admitGoalTurn(integration, active, "turn_int");
    pendingQuestionnaire = true;

    const decision = await integration.settleInjectedTurn({
      sessionId: active.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 0,
      retracted: false,
    });

    expect(decision).toMatchObject({
      stage: 5,
      action: "deferred",
      reason: "deferred(questionnaire)",
    });
    expect(updateBreaker).not.toHaveBeenCalled();
    expect(enqueuePostTurnContinuation).toHaveBeenCalledOnce();
  });

  it.each(["evaluator", "subagent"] as const)(
    "pauses %s verification when no verifier provider is installed",
    async (verification) => {
      const active = goal();
      const paused = goal({
        status: "paused",
        statusReason: "paused(verifier_unavailable)",
        updatedAt: active.updatedAt + 1,
      });
      const updateBreaker = vi.fn();
      const settleBoundTurn = vi.fn(async () => settledDecision(paused));
      const { integration, enqueuePostTurnContinuation } = makeIntegration({
        store: makeStore({
          getBySession: async () => active,
          bumpBoundUsage: async () => boundUsageResult(active),
          updateBreaker,
          settleBoundTurn,
        }),
      });
      integration.bindConfigGetter(() => ({ goal: { verification } }));
      await admitGoalTurn(integration, active, "turn_int");
      // Only a completion claim opens a verification, so only a claiming turn
      // can discover that no verifier is installed.
      await submitGoalProposal(integration, "complete");

      const decision = await integration.settleInjectedTurn({
        sessionId: active.sessionId,
        turnId: "turn_int",
        status: "completed",
        tokens: 0,
        retracted: false,
      });

      expect(decision).toMatchObject({
        stage: 9,
        action: "settled",
        reason: "paused(verifier_unavailable)",
      });
      expect(settleBoundTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          next: {
            status: "paused",
            statusReason: "paused(verifier_unavailable)",
          },
        }),
      );
      expect(updateBreaker).not.toHaveBeenCalled();
      expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
    },
  );

  it("discards a collected proposal when the process-local Turn lifecycle is lost", async () => {
    const active = goal();
    const bumpBoundUsage = vi.fn();
    const settleBoundTurn = vi.fn();
    const { integration, turnTimings, enqueuePostTurnContinuation } =
      makeIntegration({
        store: makeStore({
          getBySession: async () => active,
          bumpBoundUsage,
          settleBoundTurn,
        }),
      });
    await admitGoalTurn(integration, active, "turn_int");
    await submitGoalProposal(integration, "complete");

    turnTimings.finish(active.sessionId, "turn_int");
    await integration.settleInjectedTurn({
      sessionId: active.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 0,
      retracted: false,
    });

    expect(bumpBoundUsage).not.toHaveBeenCalled();
    expect(settleBoundTurn).not.toHaveBeenCalled();
    expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
    expect(active.status).toBe("active");
  });

  it.each(["active", "complete"] as const)(
    "rejects an unbound proposal without ending the user Turn or changing the %s Goal",
    async (status) => {
      const currentGoal = goal({ status });
      const bumpBoundUsage = vi.fn();
      const settleBoundTurn = vi.fn();
      const enqueuePostTurnContinuation = vi.fn(async () => undefined);
      const { integration } = makeIntegration({
        store: makeStore({
          getBySession: async () => currentGoal,
          bumpBoundUsage,
          settleBoundTurn,
        }),
        enqueuePostTurnContinuation,
      });

      const proposal = await submitGoalProposal(integration, "complete");

      expect(proposal.isError).toBe(true);
      expect(proposal.terminate).toBeUndefined();
      expect(JSON.parse(proposal.text)).toMatchObject({
        reason: "not_a_goal_turn",
        currentGoal: {
          goalId: currentGoal.goalId,
          status,
          objective: currentGoal.objective,
        },
      });
      expect(JSON.parse(proposal.text)).not.toHaveProperty("proposal");

      const decision = await integration.settleInjectedTurn({
        sessionId: currentGoal.sessionId,
        turnId: "turn_int",
        status: "completed",
        tokens: 99,
        retracted: false,
      });

      expect(bumpBoundUsage).not.toHaveBeenCalled();
      expect(settleBoundTurn).not.toHaveBeenCalled();
      expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
      expect(decision).toEqual({
        stage: 1,
        action: "ignored",
        reason: "not_a_goal_turn",
      });
      expect(
        await integration.store.getBySession(currentGoal.sessionId),
      ).toEqual(currentGoal);
    },
  );

  it("never attributes an old binding to a replacement Goal in the same session", async () => {
    let current = goal({ goalId: "tg_old" });
    const replacement = goal({
      goalId: "tg_replacement",
      objective: "Replacement objective",
    });
    const bumpBoundUsage = vi.fn(async (binding: GoalTurnBinding) => {
      expect(binding.goalId).toBe("tg_old");
      return { staleReason: "missing_goal" as const };
    });
    const settleBoundTurn = vi.fn();
    const enqueuePostTurnContinuation = vi.fn(async () => undefined);
    const { integration } = makeIntegration({
      store: makeStore({
        getBySession: async () => current,
        getById: async (goalId) =>
          current.goalId === goalId ? current : undefined,
        bumpBoundUsage,
        settleBoundTurn,
      }),
      enqueuePostTurnContinuation,
    });
    await admitGoalTurn(integration, current, "turn_int");
    current = replacement;

    const proposal = await submitGoalProposal(integration, "complete");
    expect(proposal.isError).toBe(true);
    expect(proposal.terminate).toBe(true);

    await integration.settleInjectedTurn({
      sessionId: current.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 25,
      retracted: false,
    });

    expect(bumpBoundUsage).toHaveBeenCalledWith(
      expect.objectContaining({ goalId: "tg_old" }),
      { tokens: 25, activeSeconds: 0, mainTurns: 1 },
      expect.any(Object),
    );
    expect(settleBoundTurn).not.toHaveBeenCalled();
    expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
    expect(current).toBe(replacement);
  });

  it.each(["goal_epoch", "objective_digest"] as const)(
    "records usage but stops all business decisions for a stale %s binding",
    async (staleReason) => {
      let current = goal();
      const admitted = current;
      const bumpBoundUsage = vi.fn(
        async (_binding, delta: ThreadGoalBoundUsageDelta) => {
          current = {
            ...current,
            tokensUsed: current.tokensUsed + delta.tokens,
            turnsUsed: current.turnsUsed + delta.mainTurns,
            objective:
              staleReason === "objective_digest"
                ? "Edited objective"
                : current.objective,
            updatedAt:
              staleReason === "goal_epoch"
                ? current.updatedAt + 1
                : current.updatedAt,
          };
          return boundUsageResult(current, { staleReason });
        },
      );
      const updateBreaker = vi.fn();
      const settleBoundTurn = vi.fn();
      const enqueuePostTurnContinuation = vi.fn(async () => undefined);
      const { integration } = makeIntegration({
        store: makeStore({
          getBySession: async () => current,
          bumpBoundUsage,
          updateBreaker,
          settleBoundTurn,
        }),
        enqueuePostTurnContinuation,
      });
      await admitGoalTurn(integration, admitted, "turn_int");

      await integration.settleInjectedTurn({
        sessionId: admitted.sessionId,
        turnId: "turn_int",
        status: "completed",
        tokens: 25,
        retracted: false,
        finalAssistantText: "stale result",
      });

      expect(current).toMatchObject({ tokensUsed: 25, turnsUsed: 1 });
      expect(updateBreaker).not.toHaveBeenCalled();
      expect(settleBoundTurn).not.toHaveBeenCalled();
      expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
    },
  );

  it("persists a repeated reply and puts a no-progress nudge in the next Turn", async () => {
    let current = goal();
    const admitted = current;
    const repeated = goal({
      replyFingerprint: "persisted-fingerprint",
      noProgressStreak: 1,
      updatedAt: current.updatedAt + 1,
    });
    const updateBreaker = vi.fn(async () => {
      current = repeated;
      return {
        action: "nudge" as const,
        goal: repeated,
        epoch: repeated.updatedAt,
      };
    });
    const enqueuePostTurnContinuation = vi.fn(async () => undefined);
    const { integration, emitRuntimeEvent } = makeIntegration({
      store: makeStore({
        getBySession: async () => current,
        bumpBoundUsage: async () => boundUsageResult(current),
        updateBreaker,
      }),
      enqueuePostTurnContinuation,
    });
    integration.bindConfigGetter(() => ({
      goal: { breaker: { repeatedReplyLimit: 4 } },
    }));
    await admitGoalTurn(integration, admitted, "turn_int");

    await integration.settleInjectedTurn({
      sessionId: admitted.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 0,
      retracted: false,
      finalAssistantText: "same final reply",
    });

    expect(updateBreaker).toHaveBeenCalledWith(admitted.goalId, {
      expectedEpoch: admitted.updatedAt,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      toolActivity: "unknown",
      limit: 4,
    });
    expect(JSON.stringify(emitRuntimeEvent.mock.calls)).not.toContain(
      "same final reply",
    );
    expect(enqueuePostTurnContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          content: expect.stringContaining("No-progress guard:"),
          origin: expect.objectContaining({
            goalUpdatedAt: repeated.updatedAt,
          }),
        }),
      }),
    );
  });

  it("injects one terminal audit after the fifth settled main Goal Turn", async () => {
    const admitted = goal({ turnsUsed: 4 });
    let current = admitted;
    const accounted = goal({ turnsUsed: 5, updatedAt: admitted.updatedAt + 1 });
    const enqueuePostTurnContinuation = vi.fn(async () => undefined);
    const { integration, emitRuntimeEvent } = makeIntegration({
      store: makeStore({
        getBySession: async () => current,
        bumpBoundUsage: async () => {
          current = accounted;
          return boundUsageResult(accounted);
        },
      }),
      enqueuePostTurnContinuation,
    });
    await admitGoalTurn(integration, admitted, "turn_five");

    const decision = await integration.settleInjectedTurn({
      sessionId: admitted.sessionId,
      turnId: "turn_five",
      status: "completed",
      tokens: 0,
      retracted: false,
    });

    expect(decision).toMatchObject({ stage: 10, action: "continued" });
    expect(enqueuePostTurnContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          content: expect.stringContaining("scheduled five-Turn checkpoint"),
        }),
      }),
    );
    expect(emitRuntimeEvent).toHaveBeenCalledWith({
      type: "goal.reminder_injected",
      at: expect.any(Number),
      payload: {
        goalId: admitted.goalId,
        sessionId: admitted.sessionId,
        turnsUsed: 5,
        reasons: ["terminal-audit"],
      },
    });
  });

  it("records when the repeated-reply threshold overrides a completion proposal", async () => {
    const active = goal({
      noProgressStreak: 1,
      replyFingerprint: "persisted-fingerprint",
    });
    const paused = goal({
      status: "paused",
      statusReason: "paused(no_progress_after_completion_claim)",
      noProgressStreak: 2,
      replyFingerprint: "persisted-fingerprint",
      updatedAt: active.updatedAt + 1,
    });
    const updateBreaker = vi.fn(async () => ({
      action: "pause" as const,
      goal: paused,
      epoch: paused.updatedAt,
    }));
    const enqueuePostTurnContinuation = vi.fn(async () => undefined);
    const { integration, emitBusEvent, emitRuntimeEvent } = makeIntegration({
      store: makeStore({
        getBySession: async () => active,
        bumpBoundUsage: async () => boundUsageResult(active),
        updateBreaker,
      }),
      enqueuePostTurnContinuation,
    });
    await admitGoalTurn(integration, active, "turn_int");
    await submitGoalProposal(integration, "complete");

    const decision = await integration.settleInjectedTurn({
      sessionId: active.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 0,
      retracted: false,
      finalAssistantText: "same final reply",
    });

    expect(decision).toMatchObject({
      stage: 8,
      action: "stopped",
      reason: "paused(no_progress_after_completion_claim)",
    });
    expect(updateBreaker).toHaveBeenCalledWith(active.goalId, {
      expectedEpoch: active.updatedAt,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      toolActivity: "unknown",
      limit: 3,
      pauseReason: "paused(no_progress_after_completion_claim)",
    });
    expect(emitBusEvent).toHaveBeenCalledWith({
      type: "thread_goal.updated",
      payload: {
        goal: expect.objectContaining({
          status: "paused",
          statusReason: "paused(no_progress_after_completion_claim)",
        }),
      },
    });
    expect(emitRuntimeEvent).toHaveBeenCalledWith({
      type: "goal.breaker_decided",
      at: expect.any(Number),
      payload: {
        goalId: active.goalId,
        sessionId: active.sessionId,
        action: "pause",
        occurrences: 3,
        streak: 2,
        toolActivity: "unknown",
        noToolStreak: 0,
      },
    });
    expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
  });

  it("pauses after three consecutive tool-less main Turns even when every reply differs", async () => {
    // GOAL-11 second breaker condition: the replies are all distinct, so only
    // the no-tool streak can stop this Goal.
    let current = goal();
    const admitted = current;
    const observed: Array<{ toolActivity: string; limit: number }> = [];
    const updateBreaker = vi.fn(
      async (
        _goalId: string,
        input: { toolActivity: string; limit: number; expectedEpoch: number },
      ) => {
        observed.push({ toolActivity: input.toolActivity, limit: input.limit });
        const streak = current.noToolStreak + 1;
        const paused = streak >= input.limit;
        current = goal({
          ...(paused
            ? { status: "paused" as const, statusReason: "paused(no_progress)" }
            : {}),
          noToolStreak: streak,
          updatedAt: current.updatedAt + 1,
        });
        return {
          action: paused
            ? ("pause" as const)
            : streak >= 2
              ? ("nudge" as const)
              : ("none" as const),
          cause: "no_tool" as const,
          goal: current,
          epoch: current.updatedAt,
        };
      },
    );
    const { integration } = makeIntegration({
      store: makeStore({
        getBySession: async () => current,
        bumpBoundUsage: async () => boundUsageResult(current),
        updateBreaker,
      }),
    });

    const decisions = [];
    for (const [index, reply] of ["reply A", "reply B", "reply C"].entries()) {
      const turnId = `turn_no_tool_${index}`;
      await admitGoalTurn(integration, current, turnId);
      decisions.push(
        await integration.settleInjectedTurn({
          sessionId: admitted.sessionId,
          turnId,
          status: "completed",
          tokens: 0,
          retracted: false,
          finalAssistantText: reply,
          workSignals: { toolCalls: 0 },
        }),
      );
    }

    expect(observed).toEqual([
      { toolActivity: "absent", limit: 3 },
      { toolActivity: "absent", limit: 3 },
      { toolActivity: "absent", limit: 3 },
    ]);
    expect(decisions[0]).toMatchObject({ action: "continued" });
    expect(decisions[1]).toMatchObject({ action: "continued" });
    expect(decisions[2]).toMatchObject({
      stage: 8,
      action: "stopped",
      reason: "paused(no_progress)",
    });
  });

  it("reports a real tool call as `used` and a missing work signal as `unknown`", async () => {
    const active = goal();
    const updateBreaker = vi.fn(async () => ({
      action: "none" as const,
      goal: active,
      epoch: active.updatedAt,
    }));
    const { integration } = makeIntegration({
      store: makeStore({
        getBySession: async () => active,
        bumpBoundUsage: async () => boundUsageResult(active),
        updateBreaker,
      }),
    });

    await admitGoalTurn(integration, active, "turn_used");
    await integration.settleInjectedTurn({
      sessionId: active.sessionId,
      turnId: "turn_used",
      status: "completed",
      tokens: 0,
      retracted: false,
      finalAssistantText: "did work",
      workSignals: { toolCalls: 2 },
    });

    await admitGoalTurn(integration, active, "turn_unobserved");
    await integration.settleInjectedTurn({
      sessionId: active.sessionId,
      turnId: "turn_unobserved",
      status: "completed",
      tokens: 0,
      retracted: false,
      finalAssistantText: "no observation for this Turn",
    });

    expect(
      updateBreaker.mock.calls.map(
        (call) => (call[1] as { toolActivity: string }).toolActivity,
      ),
    ).toEqual(["used", "unknown"]);
  });

  it("retries a failed continuation enqueue without charging the same Turn twice", async () => {
    const active = goal();
    const bumpBoundUsage = vi.fn(async () => boundUsageResult(active));
    const enqueuePostTurnContinuation = vi
      .fn()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(undefined);
    const { integration, reportFailure } = makeIntegration({
      store: makeStore({ getBySession: async () => active, bumpBoundUsage }),
      enqueuePostTurnContinuation,
    });
    await admitGoalTurn(integration, active, "turn_int");
    const settlement = {
      sessionId: active.sessionId,
      turnId: "turn_int",
      status: "completed" as const,
      tokens: 10,
      retracted: false,
    };

    await expect(integration.settleInjectedTurn(settlement)).rejects.toThrow(
      "queue unavailable",
    );
    await expect(
      integration.settleInjectedTurn(settlement),
    ).resolves.toMatchObject({
      stage: 10,
      action: "continued",
      reason: "goal_active",
    });

    expect(bumpBoundUsage).toHaveBeenCalledOnce();
    expect(enqueuePostTurnContinuation).toHaveBeenCalledTimes(2);
    expect(reportFailure).toHaveBeenCalledWith(
      active.sessionId,
      "thread_goal_continuation_enqueue_failed:queue unavailable",
    );
  });

  it("replays the first breaker decision when a tool-less Turn is settled again", async () => {
    // The breaker advances the Goal epoch when it writes, while the retry
    // reuses the accounting receipt captured before that write. Scoring the
    // Turn twice would either double-count the streak or fail its own CAS and
    // strand an active Goal without a continuation.
    const active = goal();
    const afterBreaker = goal({
      noToolStreak: 1,
      updatedAt: active.updatedAt + 1,
    });
    const updateBreaker = vi.fn(async () => ({
      action: "none" as const,
      goal: afterBreaker,
      epoch: afterBreaker.updatedAt,
    }));
    const enqueuePostTurnContinuation = vi
      .fn()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(undefined);
    const { integration } = makeIntegration({
      store: makeStore({
        getBySession: async () => active,
        bumpBoundUsage: async () => boundUsageResult(active),
        updateBreaker,
      }),
      enqueuePostTurnContinuation,
    });
    await admitGoalTurn(integration, active, "turn_int");
    const settlement = {
      sessionId: active.sessionId,
      turnId: "turn_int",
      status: "completed" as const,
      tokens: 0,
      retracted: false,
      workSignals: { toolCalls: 0 },
    };

    await expect(integration.settleInjectedTurn(settlement)).rejects.toThrow(
      "queue unavailable",
    );
    await expect(
      integration.settleInjectedTurn(settlement),
    ).resolves.toMatchObject({
      stage: 10,
      action: "continued",
    });

    expect(updateBreaker).toHaveBeenCalledOnce();
  });

  it("clears the no-tool streak on a dependency wait that really used tools", async () => {
    // A dependency wait returns at stage 5 and keeps the Goal active. Its real
    // tool calls must still interrupt the streak, otherwise the first tool-less
    // Turn after the dependency clears would be counted as the third
    // consecutive one.
    let current = goal({ noToolStreak: 2 });
    const admitted = current;
    const cleared = goal({ noToolStreak: 0, updatedAt: current.updatedAt + 1 });
    const updateBreaker = vi.fn(async () => {
      current = cleared;
      return {
        action: "none" as const,
        goal: cleared,
        epoch: cleared.updatedAt,
      };
    });
    const enqueuePostTurnContinuation = vi.fn(async () => undefined);
    let permissionPending = false;
    const { integration } = makeIntegration({
      store: makeStore({
        getBySession: async () => current,
        bumpBoundUsage: async () => boundUsageResult(current),
        updateBreaker,
      }),
      hasPendingPermission: async () => permissionPending,
      enqueuePostTurnContinuation,
    });
    await admitGoalTurn(integration, admitted, "turn_int");
    // The dependency appears during the Turn, after admission cleared.
    permissionPending = true;

    const decision = await integration.settleInjectedTurn({
      sessionId: admitted.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 0,
      retracted: false,
      finalAssistantText: "waiting on a permission prompt",
      workSignals: { toolCalls: 3 },
    });

    expect(decision).toMatchObject({ stage: 5, action: "deferred" });
    expect(updateBreaker).toHaveBeenCalledWith(admitted.goalId, {
      expectedEpoch: admitted.updatedAt,
      // The fingerprint branch stays untouched: this Turn is not being scored
      // for repetition, only cleared of its no-tool streak.
      fingerprint: null,
      toolActivity: "used",
      limit: 3,
    });
  });

  it("leaves a dependency wait alone when there is no live no-tool streak", async () => {
    const active = goal();
    const updateBreaker = vi.fn(async () => ({
      action: "none" as const,
      goal: active,
      epoch: active.updatedAt,
    }));
    let permissionPending = false;
    const { integration } = makeIntegration({
      store: makeStore({
        getBySession: async () => active,
        bumpBoundUsage: async () => boundUsageResult(active),
        updateBreaker,
      }),
      hasPendingPermission: async () => permissionPending,
    });
    await admitGoalTurn(integration, active, "turn_int");
    permissionPending = true;

    const decision = await integration.settleInjectedTurn({
      sessionId: active.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 0,
      retracted: false,
      workSignals: { toolCalls: 3 },
    });

    expect(decision).toMatchObject({ stage: 5, action: "deferred" });
    expect(updateBreaker).not.toHaveBeenCalled();
  });

  it.each([
    ["infra_retryable", "paused", "paused(infra_retryable)"],
    ["unknown", "paused", "paused(infra_retryable)"],
    ["provider_quota", "usage_limited", "usage_limited(provider_quota)"],
    ["rate_limit", "usage_limited", "usage_limited(rate_limit)"],
    ["safety", "blocked", "blocked(safety_policy)"],
  ] as const)(
    "maps %s failure through the bound settlement CAS to %s",
    async (failureClass, status, statusReason) => {
      const active = goal();
      const settled = goal({
        status,
        statusReason,
        updatedAt: active.updatedAt + 1,
      });
      const settleBoundTurn = vi.fn(async () => settledDecision(settled));
      const enqueuePostTurnContinuation = vi.fn(async () => undefined);
      const { integration, emitBusEvent, emitRuntimeEvent } = makeIntegration({
        store: makeStore({
          getBySession: async () => active,
          bumpBoundUsage: async () => boundUsageResult(active),
          settleBoundTurn,
        }),
        enqueuePostTurnContinuation,
      });
      await admitGoalTurn(integration, active, "turn_int");

      await integration.settleInjectedTurn({
        sessionId: active.sessionId,
        turnId: "turn_int",
        status: "failed",
        failureClass,
        tokens: 0,
        retracted: false,
      });

      expect(settleBoundTurn).toHaveBeenCalledWith({
        goalId: active.goalId,
        expectedEpoch: active.updatedAt,
        objectiveDigest: digestThreadGoalObjective(active.objective),
        next: { status, statusReason },
      });
      expect(emitBusEvent).toHaveBeenCalledWith({
        type: "thread_goal.updated",
        payload: { goal: expect.objectContaining({ status, statusReason }) },
      });
      expect(emitRuntimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "goal.turn_settled",
          payload: expect.objectContaining({ failureClass }),
        }),
      );
      expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
    },
  );

  it("pauses a retracted bound Turn through the same settlement CAS", async () => {
    const active = goal();
    const paused = goal({
      status: "paused",
      statusReason: "paused(retracted)",
      updatedAt: active.updatedAt + 1,
    });
    const settleBoundTurn = vi.fn(async () => settledDecision(paused));
    const { integration, enqueuePostTurnContinuation } = makeIntegration({
      store: makeStore({
        getBySession: async () => active,
        bumpBoundUsage: async () => boundUsageResult(active),
        settleBoundTurn,
      }),
    });
    await admitGoalTurn(integration, active, "turn_int");

    await integration.settleInjectedTurn({
      sessionId: active.sessionId,
      turnId: "turn_int",
      status: "completed",
      tokens: 0,
      retracted: true,
    });

    expect(settleBoundTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        goalId: active.goalId,
        next: { status: "paused", statusReason: "paused(retracted)" },
      }),
    );
    expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
  });

  it("accounts an aborted bound Turn but leaves Goal completion authority untouched", async () => {
    const active = goal();
    const bumpBoundUsage = vi.fn(async () => boundUsageResult(active));
    const settleBoundTurn = vi.fn();
    const { integration, enqueuePostTurnContinuation } = makeIntegration({
      store: makeStore({
        getBySession: async () => active,
        bumpBoundUsage,
        settleBoundTurn,
      }),
    });
    await admitGoalTurn(integration, active, "turn_int");

    await integration.settleInjectedTurn({
      sessionId: active.sessionId,
      turnId: "turn_int",
      status: "aborted",
      tokens: 7,
      retracted: false,
    });

    expect(bumpBoundUsage).toHaveBeenCalledOnce();
    expect(settleBoundTurn).not.toHaveBeenCalled();
    expect(enqueuePostTurnContinuation).not.toHaveBeenCalled();
  });
});
