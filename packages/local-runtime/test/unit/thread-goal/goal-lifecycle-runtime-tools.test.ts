import { describe, expect, it, vi } from "vitest";

import type { ThreadGoalState, ThreadGoalStatus } from "@mavis/goal";

import { GoalLifecycle } from "../../../src/thread-goal/lifecycle.js";

function lifecycleWith(goal: Partial<ThreadGoalState> | undefined, enabled = true) {
  const getBySession = vi.fn(async () => goal as ThreadGoalState | undefined);
  const lifecycle = new GoalLifecycle({
    runtime: { isEnabled: () => enabled },
    store: () => ({ getBySession }),
    signalCollector: { collect: () => "accepted" },
  } as never);
  return { lifecycle, getBySession };
}

async function names(lifecycle: GoalLifecycle): Promise<string[]> {
  return (await lifecycle.runtimeToolsFor(false, "sess_a")).map((tool) => tool.def.name).sort();
}

describe("GoalLifecycle.runtimeToolsFor", () => {
  it("exposes no goal tools when the session has no goal", async () => {
    const { lifecycle, getBySession } = lifecycleWith(undefined);
    expect(await names(lifecycle)).toEqual([]);
    expect(getBySession).toHaveBeenCalledWith("sess_a");
  });

  it("exposes nothing when the feature is disabled, without reading the store", async () => {
    const { lifecycle, getBySession } = lifecycleWith({ status: "active" }, false);
    expect(await names(lifecycle)).toEqual([]);
    expect(await lifecycle.runtimeToolsFor(true, "sess_a")).toEqual([]);
    expect(getBySession).not.toHaveBeenCalled();
  });

  it("exposes only get_goal for a completed goal", async () => {
    const { lifecycle } = lifecycleWith({ status: "complete" });
    expect(await names(lifecycle)).toEqual(["get_goal"]);
  });

  it.each<ThreadGoalStatus>(["active", "paused", "budget_limited", "blocked", "usage_limited"])(
    "exposes both tools for an unfinished %s goal",
    async (status) => {
      const { lifecycle } = lifecycleWith({ status });
      expect(await names(lifecycle)).toEqual(["get_goal", "update_goal"]);
    },
  );
});
