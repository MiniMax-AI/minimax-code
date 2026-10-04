import { describe, expect, it, vi } from "vitest";
import {
  TUI_GOAL_LIVE_RUN_HINT_SUFFIX,
  TuiGoalFlow,
} from "../../../../../src/tui/controller/product/goal-flow.js";

// #425: `/goal clear` during a hung response used to report only "Goal cleared."
// while the response kept running, which read as the command doing nothing.
function createGoalFlow(hasLiveRun: boolean) {
  const goal = {
    goalId: "goal-1",
    sessionId: "session-a",
    objective: "Count to one hundred",
    status: "active",
  };
  const runtime = {
    isGoalEnabled: () => true,
    getGoal: vi.fn(async () => goal),
    clearGoal: vi.fn(async () => undefined),
    patchGoal: vi.fn(async (_sessionId: string, patch: { status?: string }) => ({
      ...goal,
      ...patch,
    })),
  };
  const setHint = vi.fn();
  const banner = { setGoal: vi.fn(), getGoal: vi.fn(() => goal) };
  const flow = new TuiGoalFlow({
    runtime: runtime as never,
    currentSessionId: () => "session-a",
    banner: banner as never,
    composerDraft: { capture: vi.fn(() => ({})) } as never,
    editor: {} as never,
    surfaceHost: {} as never,
    append: vi.fn(),
    setHint,
    onChanged: vi.fn(),
    hasLiveRun: () => hasLiveRun,
  });
  return { flow, runtime, setHint, banner };
}

describe("TuiGoalFlow while a response is in flight", () => {
  it("clears the Goal and says the current response keeps running", async () => {
    const { flow, runtime, setHint, banner } = createGoalFlow(true);
    await expect(flow.execute("clear")).resolves.toBe("consumed");
    expect(runtime.clearGoal).toHaveBeenCalledWith("session-a");
    expect(banner.setGoal).toHaveBeenCalledWith(undefined);
    expect(setHint).toHaveBeenCalledWith(`Goal cleared. ${TUI_GOAL_LIVE_RUN_HINT_SUFFIX}`);
  });

  it("pauses the Goal and says the current response keeps running", async () => {
    const { flow, runtime, setHint } = createGoalFlow(true);
    await expect(flow.execute("pause")).resolves.toBe("consumed");
    expect(runtime.patchGoal).toHaveBeenCalledWith("session-a", { status: "paused" });
    expect(setHint).toHaveBeenCalledWith(`Goal paused. ${TUI_GOAL_LIVE_RUN_HINT_SUFFIX}`);
  });

  it("keeps the plain hints when idle", async () => {
    const { flow, setHint } = createGoalFlow(false);
    await flow.execute("clear");
    expect(setHint).toHaveBeenLastCalledWith("Goal cleared.");
    await flow.execute("resume");
    expect(setHint).toHaveBeenLastCalledWith("Goal resumed.");
  });
});
