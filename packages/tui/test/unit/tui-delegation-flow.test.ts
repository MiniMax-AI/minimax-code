import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TuiBackgroundTask } from "../../src/runtime/port.js";
import { TuiDelegationFlow } from "../../src/tui/controller/delegation-flow.js";
import { createTranscriptCell } from "../../src/tui/transcript/model.js";
import { TranscriptStore } from "../../src/tui/transcript/store.js";

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    getDelegationSnapshot: vi.fn(async () => ({
      schemaVersion: 1 as const,
      rootSessionId: "root",
      members: [],
    })),
    stopDelegation: vi.fn(),
    getActiveRun: vi.fn(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: "idle" as const,
      actions: { steer: false },
    })),
    getMessages: vi.fn(async () => []),
    getSession: vi.fn(async (sessionId: string) => ({ sessionId })),
    watchSessionTurn: vi.fn(async function* watchSessionTurn() {}),
    ...overrides,
  };
}

describe("TuiDelegationFlow", () => {
  afterEach(() => vi.useRealTimers());

  it("recovers delegated agents into an explicit live projection without writing Transcript", async () => {
    const transcript = new TranscriptStore();
    const runtimePort = runtime({
      getDelegationSnapshot: vi.fn(async () => ({
        schemaVersion: 1 as const,
        rootSessionId: "root",
        members: [
          {
            sessionId: "child-1",
            parentSessionId: "root",
            agentName: "verifier",
            task: "Review recent CLI changes",
            status: "running" as const,
            createdAtMs: 100,
            updatedAtMs: 200,
          },
        ],
      })),
      getActiveRun: vi.fn(async () => ({
        schemaVersion: 1 as const,
        sessionId: "child-1",
        state: "running" as const,
        turnId: "turn-1",
        actions: { steer: false },
      })),
    });
    const flow = new TuiDelegationFlow({
      runtime: runtimePort,
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();

    expect(flow.snapshot()).toMatchObject({
      summary: { total: 1, running: 1 },
      members: [
        {
          sessionId: "child-1",
          agentName: "verifier",
          task: "Review recent CLI changes",
          activity: "Starting",
        },
      ],
    });
    expect(transcript.snapshot()).toEqual([]);
    expect(flow.agentCounts()).toEqual({ active: 1, total: 1 });
    const permissionResolvers = flow.permissionResolvers(() => "root-turn");
    expect(permissionResolvers.permissionOwnerTurnId("root")).toBe("root-turn");
    expect(permissionResolvers.permissionOwnerTurnId("child-1")).toBe("turn-1");
    expect(
      permissionResolvers.permissionOwnerTurnId("missing-child"),
    ).toBeUndefined();
    flow.stop();
  });

  it("keeps mixed failed and running state in the live projection", async () => {
    const transcript = new TranscriptStore();
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "failed-child",
              parentSessionId: "root",
              agentName: "reviewer",
              task: "Review changes",
              status: "failed" as const,
            },
            {
              sessionId: "running-child",
              parentSessionId: "root",
              agentName: "verifier",
              task: "Run focused tests",
              status: "running" as const,
            },
          ],
        })),
        getActiveRun: vi.fn(async (sessionId: string) => ({
          schemaVersion: 1 as const,
          sessionId,
          state:
            sessionId === "running-child"
              ? ("running" as const)
              : ("idle" as const),
          ...(sessionId === "running-child" ? { turnId: "turn-running" } : {}),
          actions: { steer: false },
        })),
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();

    expect(flow.snapshot().summary).toMatchObject({ failed: 1, running: 1 });
    expect(transcript.snapshot()).toEqual([]);
    expect(flow.agentCounts()).toEqual({ active: 1, total: 2 });
    flow.stop();
  });

  it("settles a successful child from the terminal active Run after authoritative refresh", async () => {
    const transcript = new TranscriptStore();
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child-1",
              parentSessionId: "root",
              agentName: "verifier",
              task: "Verify changes",
              status: "queued" as const,
            },
          ],
        })),
        getActiveRun: vi.fn(async () => ({
          schemaVersion: 1 as const,
          sessionId: "child-1",
          state: "terminal" as const,
          turnId: "turn-1",
          actions: { steer: false },
        })),
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();

    expect(flow.snapshot().summary).toMatchObject({ done: 1, queued: 0 });
    expect(transcript.snapshot()).toEqual([]);
    expect(flow.agentCounts()).toEqual({ active: 0, total: 1 });
    flow.stop();
  });

  it("settles a successful idle child from durable history after a cold refresh", async () => {
    const transcript = new TranscriptStore();
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child-1",
              parentSessionId: "root",
              agentName: "verifier",
              task: "Verify changes",
              status: "queued" as const,
            },
          ],
        })),
        getMessages: vi.fn(async (sessionId: string) =>
          sessionId === "child-1"
            ? [
                {
                  id: "child-answer",
                  turnId: "turn-1",
                  role: "assistant" as const,
                  content: "Verified",
                  finishReason: "stop",
                },
              ]
            : [],
        ),
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();

    expect(flow.snapshot().summary).toMatchObject({ done: 1, queued: 0 });
    expect(transcript.snapshot()).toEqual([]);
    expect(flow.agentCounts()).toEqual({ active: 0, total: 1 });
    flow.stop();
  });

  it("keeps an idle child queued when durable history has no successful terminal message", async () => {
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child-1",
              parentSessionId: "root",
              status: "queued" as const,
            },
          ],
        })),
        getMessages: vi.fn(async (sessionId: string) =>
          sessionId === "child-1"
            ? [
                {
                  id: "old-answer",
                  turnId: "turn-old",
                  role: "assistant" as const,
                  finishReason: "stop",
                },
                {
                  id: "tool-request",
                  turnId: "turn-new",
                  role: "assistant" as const,
                  finishReason: "toolUse",
                },
              ]
            : [],
        ),
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();

    expect(flow.agentCounts()).toEqual({ active: 1, total: 1 });
    flow.stop();
  });

  it("keeps background members active until every root delivery Turn is settled", async () => {
    const onChanged = vi.fn();
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child-a",
              parentSessionId: "root",
              status: "completed" as const,
              backgroundTaskId: "task-a",
            },
            {
              sessionId: "child-b",
              parentSessionId: "root",
              status: "completed" as const,
              backgroundTaskId: "task-b",
            },
          ],
        })),
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged,
    });
    await flow.refresh();
    const firstDelivery = {
      type: "session.finish" as const,
      timestampMs: 500,
      source: "runtime",
      sessionId: "root",
      turnId: "delivery-a",
      taskId: "task-a",
      runSource: "background-task-delivery",
      queueItemIds: [],
    };

    expect(flow.agentCounts()).toEqual({ active: 2, total: 2 });
    await flow.handleRuntimeEvent(firstDelivery);
    expect(flow.agentCounts()).toEqual({ active: 2, total: 2 });

    flow.handleSettledRuntimeEvent(firstDelivery);
    expect(flow.agentCounts()).toEqual({ active: 1, total: 2 });
    flow.handleSettledRuntimeEvent({
      ...firstDelivery,
      timestampMs: 600,
      turnId: "delivery-b",
      taskId: "task-b",
    });
    expect(flow.agentCounts()).toEqual({ active: 0, total: 2 });
    expect(onChanged).toHaveBeenCalledTimes(3);
    flow.stop();
  });

  it("settles every background Task steered into one owner Turn without reopening on replay", async () => {
    const onChanged = vi.fn();
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child-a",
              parentSessionId: "root",
              status: "completed" as const,
              backgroundTaskId: "task-a",
            },
            {
              sessionId: "child-b",
              parentSessionId: "root",
              status: "completed" as const,
              backgroundTaskId: "task-b",
            },
            {
              sessionId: "child-c",
              parentSessionId: "root",
              status: "completed" as const,
              backgroundTaskId: "task-c",
            },
          ],
        })),
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged,
    });
    await flow.refresh();
    const steeredStart = {
      type: "session.start" as const,
      timestampMs: 500,
      source: "runtime",
      sessionId: "root",
      turnId: "turn-owner",
      taskId: "task-a",
      runSource: "background-task-delivery",
      queueItemIds: [],
    };
    await flow.handleRuntimeEvent(steeredStart);
    await flow.handleRuntimeEvent({ ...steeredStart, taskId: "task-b" });

    flow.handleAutomationResultPublished({
      sessionId: "root",
      turnId: "turn-unrelated",
    });
    expect(flow.agentCounts()).toEqual({ active: 3, total: 3 });

    flow.handleAutomationResultPublished({
      sessionId: "root",
      turnId: "turn-owner",
    });
    expect(flow.agentCounts()).toEqual({ active: 1, total: 3 });

    flow.handleAutomationResultPublished({
      sessionId: "root",
      turnId: "turn-late-event",
    });
    await flow.handleRuntimeEvent({
      ...steeredStart,
      timestampMs: 550,
      turnId: "turn-late-event",
      taskId: "task-c",
    });
    expect(flow.agentCounts()).toEqual({ active: 0, total: 3 });

    await flow.handleRuntimeEvent({ ...steeredStart, timestampMs: 600 });
    expect(flow.agentCounts()).toEqual({ active: 0, total: 3 });
    expect(onChanged).toHaveBeenCalledTimes(3);
    flow.stop();
  });

  it("does not settle a background member from an unrelated delivery task", async () => {
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child",
              parentSessionId: "root",
              status: "completed" as const,
              backgroundTaskId: "expected-task",
            },
          ],
        })),
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });
    await flow.refresh();

    flow.handleSettledRuntimeEvent({
      type: "session.finish",
      timestampMs: 500,
      source: "runtime",
      sessionId: "root",
      turnId: "other-delivery",
      taskId: "other-task",
      runSource: "background-task-delivery",
      queueItemIds: [],
    });

    expect(flow.agentCounts()).toEqual({ active: 1, total: 1 });
    flow.stop();
  });

  it("keeps durable task turns unchanged while publishing the recovered team", async () => {
    const transcript = new TranscriptStore([
      createTranscriptCell({
        id: "turn-task-answer",
        kind: "assistant",
        status: "succeeded",
        content: "Launching two agents",
        turnId: "turn-task",
        createdAtMs: 100,
      }),
      createTranscriptCell({
        id: "turn-later-answer",
        kind: "assistant",
        status: "succeeded",
        content: "Later answer",
        turnId: "turn-later",
        createdAtMs: 500,
      }),
    ]);
    const taskMessages = [
      {
        id: "message-task",
        turnId: "turn-task",
        role: "assistant" as const,
        timestamp: 100,
        toolCalls: [
          { id: "call-a", name: "task", input: { description: "Task A" } },
          { id: "call-b", name: "task", input: { description: "Task B" } },
        ],
      },
      {
        id: "result-a",
        turnId: "turn-task",
        role: "unknown" as const,
        toolResult: {
          toolCallId: "call-a",
          toolName: "task",
          details: { subSessionId: "child-a" },
        },
      },
      {
        id: "result-b",
        turnId: "turn-task",
        role: "unknown" as const,
        toolResult: {
          toolCallId: "call-b",
          toolName: "task",
          details: { subSessionId: "child-b" },
        },
      },
    ];
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child-a",
              parentSessionId: "root",
              task: "Task A",
              status: "completed" as const,
              createdAtMs: 110,
            },
            {
              sessionId: "child-b",
              parentSessionId: "root",
              task: "Task B",
              status: "completed" as const,
              createdAtMs: 120,
            },
          ],
        })),
        getMessages: vi.fn(async (sessionId: string) =>
          sessionId === "root" ? taskMessages : [],
        ),
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();

    expect(flow.snapshot()).toMatchObject({
      summary: { total: 2 },
      members: [{ sessionId: "child-a" }, { sessionId: "child-b" }],
    });
    expect(transcript.snapshot().map((cell) => cell.id)).toEqual([
      "turn-task-answer",
      "turn-later-answer",
    ]);
  });

  it("keeps sequential task waves out of Transcript and in one live team projection", async () => {
    const transcript = new TranscriptStore([
      createTranscriptCell({
        id: "tool:turn-shared:call-a",
        kind: "tool",
        status: "succeeded",
        content: "Task A",
        turnId: "turn-shared",
        createdAtMs: 100,
      }),
      createTranscriptCell({
        id: "assistant-between-waves",
        kind: "assistant-preamble",
        status: "succeeded",
        content: "The first agent finished; starting another.",
        turnId: "turn-shared",
        createdAtMs: 200,
      }),
      createTranscriptCell({
        id: "tool:turn-shared:call-b",
        kind: "tool",
        status: "failed",
        content: "Task B",
        turnId: "turn-shared",
        createdAtMs: 300,
      }),
      createTranscriptCell({
        id: "later-turn",
        kind: "assistant",
        status: "succeeded",
        content: "Later output",
        turnId: "turn-later",
        createdAtMs: 500,
      }),
    ]);
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child-a",
              parentSessionId: "root",
              status: "completed" as const,
            },
            {
              sessionId: "nested-a",
              parentSessionId: "child-a",
              status: "completed" as const,
            },
            {
              sessionId: "child-b",
              parentSessionId: "root",
              status: "failed" as const,
            },
          ],
        })),
        getMessages: vi.fn(async (sessionId: string) =>
          sessionId === "root"
            ? [
                {
                  id: "call-message-a",
                  turnId: "turn-shared",
                  role: "assistant" as const,
                  timestamp: 100,
                  toolCalls: [{ id: "call-a", name: "task" }],
                },
                {
                  turnId: "turn-shared",
                  role: "unknown" as const,
                  toolResult: {
                    toolCallId: "call-a",
                    toolName: "task",
                    details: { subSessionId: "child-a" },
                  },
                },
                {
                  id: "call-message-b",
                  turnId: "turn-shared",
                  role: "assistant" as const,
                  timestamp: 300,
                  toolCalls: [{ id: "call-b", name: "task" }],
                },
                {
                  turnId: "turn-shared",
                  role: "unknown" as const,
                  toolResult: {
                    toolCallId: "call-b",
                    toolName: "task",
                    details: { subSessionId: "child-b" },
                  },
                },
              ]
            : [],
        ),
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();

    expect(
      flow
        .snapshot()
        .members.map((member) => member.sessionId)
        .sort(),
    ).toEqual(["child-a", "child-b", "nested-a"]);
    expect(flow.snapshot().summary).toMatchObject({ done: 2, failed: 1 });
    expect(transcript.snapshot().map((cell) => cell.id)).toEqual([
      "tool:turn-shared:call-a",
      "assistant-between-waves",
      "tool:turn-shared:call-b",
      "later-turn",
    ]);
  });

  it("preserves an all-stopped team in the live snapshot", async () => {
    const transcript = new TranscriptStore();
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child",
              parentSessionId: "root",
              status: "stopped" as const,
            },
          ],
        })),
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();

    expect(flow.snapshot().summary).toMatchObject({ total: 1, stopped: 1 });
    expect(transcript.snapshot()).toEqual([]);
  });

  it("updates a live team without touching later Transcript rows", async () => {
    const transcript = new TranscriptStore();
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child-1",
              parentSessionId: "root",
              status: "running" as const,
            },
          ],
        })),
        getActiveRun: vi.fn(async () => ({
          schemaVersion: 1 as const,
          sessionId: "child-1",
          state: "running" as const,
          turnId: "turn-1",
          actions: { steer: false },
        })),
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });
    await flow.refresh();
    transcript.upsert(
      createTranscriptCell({
        id: "later-turn",
        kind: "assistant",
        status: "succeeded",
        content: "Later output",
        createdAtMs: 500,
      }),
    );

    await flow.handleRuntimeEvent({
      type: "permission.ask",
      timestampMs: 600,
      source: "runtime",
      sessionId: "child-1",
      request: {
        requestId: "permission-tail",
        sessionId: "child-1",
        toolName: "write",
        description: "Write a file",
      },
    });

    expect(flow.snapshot().members[0]).toMatchObject({
      status: "waiting",
      activity: "Waiting for approval",
    });
    expect(transcript.snapshot().map((cell) => cell.id)).toEqual([
      "later-turn",
    ]);
    flow.stop();
  });

  it("refreshes when a Runtime V2 visible task child is created under the active root", async () => {
    const runtimePort = runtime({
      getDelegationSnapshot: vi.fn(async () => ({
        schemaVersion: 1 as const,
        rootSessionId: "root",
        members: [],
      })),
    });
    const flow = new TuiDelegationFlow({
      runtime: runtimePort,
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.handleRuntimeEvent({
      type: "session.created",
      timestampMs: 100,
      source: "runtime",
      sessionId: "child-1",
      agentName: "verifier",
      sessionType: "branch",
      sessionKind: "task",
      visibility: "visible",
      parentSessionId: "root",
    });

    expect(runtimePort.getDelegationSnapshot).toHaveBeenCalledWith("root");
  });

  it("refreshes when a delegated agent creates a nested task child", async () => {
    const runtimePort = runtime({
      getDelegationSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          schemaVersion: 1,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child-a",
              parentSessionId: "root",
              status: "running",
            },
          ],
        })
        .mockResolvedValueOnce({
          schemaVersion: 1,
          rootSessionId: "root",
          members: [],
        }),
    });
    const flow = new TuiDelegationFlow({
      runtime: runtimePort,
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });
    await flow.refresh();

    await flow.handleRuntimeEvent({
      type: "session.created",
      sessionId: "child-b",
      parentSessionId: "child-a",
      sessionType: "branch",
      sessionKind: "task",
      visibility: "visible",
    });

    expect(runtimePort.getDelegationSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not let a projection refresh failure break the Runtime event loop", async () => {
    const error = new Error("catalog unavailable");
    const onError = vi.fn();
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => Promise.reject(error)),
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
      onError,
    });

    await expect(flow.refresh()).resolves.toBeUndefined();
    await expect(flow.refresh()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("hydrates durable child activity after overflow and resumes without the stale anchor", async () => {
    const watchSessionTurn = vi.fn(async function* watchSessionTurn(
      _sessionId: string,
      _turnId: string,
      _signal: AbortSignal,
      options?: { afterMsgId?: string },
    ) {
      if (options?.afterMsgId) {
        yield { type: "resync-required" as const, turnId: "turn-1" };
        return;
      }
      yield {
        type: "delta" as const,
        turnId: "turn-1",
        toolCalls: [
          {
            id: "tool-1",
            name: "read",
            status: "started",
            input: { path: "packages/tui/src/tui/app.ts" },
          },
        ],
      };
    });
    const runtimePort = runtime({
      getDelegationSnapshot: vi.fn(async () => ({
        schemaVersion: 1 as const,
        rootSessionId: "root",
        members: [
          {
            sessionId: "child-1",
            parentSessionId: "root",
            agentName: "verifier",
            task: "Verify TUI",
            status: "running" as const,
          },
        ],
      })),
      getActiveRun: vi.fn(async () => ({
        schemaVersion: 1 as const,
        sessionId: "child-1",
        state: "running" as const,
        turnId: "turn-1",
        actions: { steer: false },
      })),
      getMessages: vi.fn(async () => [
        { id: "message-anchor", turnId: "turn-1", role: "assistant" as const },
      ]),
      watchSessionTurn,
    });
    const flow = new TuiDelegationFlow({
      runtime: runtimePort,
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();

    await vi.waitFor(() => {
      expect(flow.snapshot().members[0]).toMatchObject({
        activity: "Reading packages/tui/src/tui/app.ts",
        toolCount: 1,
      });
    });
    expect(watchSessionTurn).toHaveBeenNthCalledWith(
      1,
      "child-1",
      "turn-1",
      expect.any(AbortSignal),
      { afterMsgId: "message-anchor" },
    );
    expect(watchSessionTurn).toHaveBeenNthCalledWith(
      2,
      "child-1",
      "turn-1",
      expect.any(AbortSignal),
    );
    flow.stop();
  });

  it("restarts a child watcher when a same-turn stream closes before the Run is terminal", async () => {
    vi.useFakeTimers();
    const watchSessionTurn = vi.fn(async function* watchSessionTurn() {});
    const runtimePort = runtime({
      getDelegationSnapshot: vi.fn(async () => ({
        schemaVersion: 1 as const,
        rootSessionId: "root",
        members: [
          {
            sessionId: "child-1",
            parentSessionId: "root",
            status: "running" as const,
          },
        ],
      })),
      getActiveRun: vi.fn(async () => ({
        schemaVersion: 1 as const,
        sessionId: "child-1",
        state: "running" as const,
        turnId: "turn-1",
        actions: { steer: false },
      })),
      watchSessionTurn,
    });
    const flow = new TuiDelegationFlow({
      runtime: runtimePort,
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();
    await vi.waitFor(() => expect(watchSessionTurn).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() =>
      expect(watchSessionTurn.mock.calls.length).toBeGreaterThan(1),
    );
    flow.stop();
  });

  it("retries after stream and active Run inspection fail together", async () => {
    vi.useFakeTimers();
    const watchSessionTurn = vi.fn(async function* watchSessionTurn() {});
    const running = {
      schemaVersion: 1 as const,
      sessionId: "child-1",
      state: "running" as const,
      turnId: "turn-1",
      actions: { steer: false },
    };
    const getActiveRun = vi
      .fn()
      .mockResolvedValueOnce(running)
      .mockRejectedValueOnce(new Error("inspection unavailable"))
      .mockResolvedValue(running);
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child-1",
              parentSessionId: "root",
              status: "running" as const,
            },
          ],
        })),
        getActiveRun,
        watchSessionTurn,
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();
    await vi.waitFor(() => expect(watchSessionTurn).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() =>
      expect(watchSessionTurn.mock.calls.length).toBeGreaterThan(1),
    );
    expect(getActiveRun.mock.calls.length).toBeGreaterThanOrEqual(3);
    flow.stop();
  });

  it("coalesces simultaneous child watcher retries into one team refresh", async () => {
    vi.useFakeTimers();
    const watchSessionTurn = vi.fn(async function* watchSessionTurn() {});
    const getDelegationSnapshot = vi.fn(async () => ({
      schemaVersion: 1 as const,
      rootSessionId: "root",
      members: ["child-1", "child-2"].map((sessionId) => ({
        sessionId,
        parentSessionId: "root",
        status: "running" as const,
      })),
    }));
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot,
        getActiveRun: vi.fn(async (sessionId: string) => ({
          schemaVersion: 1 as const,
          sessionId,
          state: "running" as const,
          turnId: `turn-${sessionId}`,
          actions: { steer: false },
        })),
        watchSessionTurn,
      }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();
    await vi.waitFor(() => expect(watchSessionTurn).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(watchSessionTurn).toHaveBeenCalledTimes(4));
    expect(getDelegationSnapshot).toHaveBeenCalledTimes(2);
    flow.stop();
  });

  it("aborts child watchers when the active Session changes", async () => {
    let watcherSignal: AbortSignal | undefined;
    const runtimePort = runtime({
      getDelegationSnapshot: vi.fn(async () => ({
        schemaVersion: 1 as const,
        rootSessionId: "root",
        members: [
          {
            sessionId: "child-1",
            parentSessionId: "root",
            status: "running" as const,
          },
        ],
      })),
      getActiveRun: vi.fn(async () => ({
        schemaVersion: 1 as const,
        sessionId: "child-1",
        state: "running" as const,
        turnId: "turn-1",
        actions: { steer: false },
      })),
      watchSessionTurn: vi.fn(async function* watchSessionTurn(
        _sessionId: string,
        _turnId: string,
        signal: AbortSignal,
      ) {
        watcherSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield* [];
      }),
    });
    const flow = new TuiDelegationFlow({
      runtime: runtimePort,
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();
    await vi.waitFor(() => expect(watcherSignal).toBeDefined());
    flow.reset();

    expect(watcherSignal?.aborted).toBe(true);
  });

  it("keeps a same-turn watcher alive across authoritative refreshes", async () => {
    let watcherSignal: AbortSignal | undefined;
    const runtimePort = runtime({
      getDelegationSnapshot: vi.fn(async () => ({
        schemaVersion: 1 as const,
        rootSessionId: "root",
        members: [
          {
            sessionId: "child-1",
            parentSessionId: "root",
            status: "running" as const,
          },
        ],
      })),
      getActiveRun: vi.fn(async () => ({
        schemaVersion: 1 as const,
        sessionId: "child-1",
        state: "running" as const,
        turnId: "turn-1",
        actions: { steer: false },
      })),
      watchSessionTurn: vi.fn(async function* watchSessionTurn(
        _sessionId: string,
        _turnId: string,
        signal: AbortSignal,
      ) {
        watcherSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield* [];
      }),
    });
    const flow = new TuiDelegationFlow({
      runtime: runtimePort,
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    await flow.refresh();
    await vi.waitFor(() => expect(watcherSignal).toBeDefined());
    await flow.refresh();

    expect(watcherSignal?.aborted).toBe(false);
    expect(runtimePort.watchSessionTurn).toHaveBeenCalledOnce();
    flow.stop();
  });

  it("publishes Runtime background work and refreshes changes to the full command", async () => {
    const task = {
      taskId: "bg-1",
      kind: "bash" as const,
      status: "failed" as const,
      ownerSessionId: "root",
      description: "pnpm test",
      createdAtMs: 100,
      updatedAtMs: 200,
      startedAtMs: 110,
      endedAtMs: 190,
      lastError: "exit code 1",
    };
    const onBackgroundTasksChanged = vi.fn();
    const runtimePort = runtime({
      listBackgroundTasks: vi.fn(async () => [task]),
    });
    const flow = new TuiDelegationFlow({
      runtime: runtimePort,
      currentSession: () => ({ sessionId: "root" }),
      onBackgroundTasksChanged,
      onChanged: vi.fn(),
    });

    await flow.refresh();

    expect(runtimePort.listBackgroundTasks).toHaveBeenCalledWith("root");
    expect(onBackgroundTasksChanged).toHaveBeenLastCalledWith([task]);
    const updated = { ...task, command: "pnpm test --filter regression" };
    runtimePort.listBackgroundTasks = vi.fn(async () => [updated]);
    await flow.refresh();
    expect(onBackgroundTasksChanged).toHaveBeenLastCalledWith([updated]);
    flow.stop();
  });

  it("polls background work for a newly created root Session before manual refresh", async () => {
    vi.useFakeTimers();
    const task = {
      taskId: "bg-new-session",
      kind: "bash" as const,
      status: "running" as const,
      ownerSessionId: "root",
      description: "sleep 120",
      createdAtMs: 100,
      updatedAtMs: 200,
    };
    const listBackgroundTasks = vi.fn(async () => [task]);
    const onBackgroundTasksChanged = vi.fn();
    const flow = new TuiDelegationFlow({
      runtime: runtime({ listBackgroundTasks }),
      currentSession: () => ({ sessionId: "root" }),
      onBackgroundTasksChanged,
      onChanged: vi.fn(),
    });

    try {
      await flow.handleRuntimeEvent({
        type: "session.start",
        timestampMs: 100,
        source: "runtime",
        sessionId: "root",
        turnId: "root-turn",
        queueItemIds: [],
      });
      expect(listBackgroundTasks).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(listBackgroundTasks).toHaveBeenCalledWith("root");
      expect(onBackgroundTasksChanged).toHaveBeenLastCalledWith([task]);
    } finally {
      flow.stop();
      vi.useRealTimers();
    }
  });

  it("does not keep polling when only delivered terminal task history remains", async () => {
    vi.useFakeTimers();
    const listBackgroundTasks = vi.fn(async () => [
      {
        taskId: "bg-delivered",
        kind: "bash" as const,
        status: "succeeded" as const,
        ownerSessionId: "root",
        description: "completed validation",
        createdAtMs: 100,
        updatedAtMs: 300,
        startedAtMs: 120,
        endedAtMs: 250,
        deliveredAtMs: 300,
      },
    ]);
    const flow = new TuiDelegationFlow({
      runtime: runtime({ listBackgroundTasks }),
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });

    try {
      await flow.refresh();
      expect(listBackgroundTasks).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(listBackgroundTasks).toHaveBeenCalledOnce();
    } finally {
      flow.stop();
      vi.useRealTimers();
    }
  });

  it("opens one unified feature screen for Agent Team and Runtime background work", async () => {
    const backgroundTask = {
      taskId: "bg-1",
      kind: "bash" as const,
      status: "running" as const,
      ownerSessionId: "root",
      description: "pnpm test",
      createdAtMs: 100,
      updatedAtMs: 200,
    };
    const openSession = vi.fn(async () => undefined);
    const taskClose = vi.fn(() => true);
    const transcriptClose = vi.fn(() => true);
    let screen:
      | {
          readonly id: string;
          render(width: number): string[];
          handleInput(data: string): void;
        }
      | undefined;
    const pushFeature = vi.fn((input: { screen: typeof screen }) => {
      screen = input.screen;
      return {
        id: input.screen?.id ?? "unknown",
        close: input.screen?.id === "transcript" ? transcriptClose : taskClose,
        isActive: () => true,
      };
    });
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child-1",
              parentSessionId: "root",
              agentName: "reviewer",
              task: "Review the implementation",
              status: "running" as const,
              createdAtMs: 100,
              updatedAtMs: 200,
            },
          ],
        })),
        getActiveRun: vi.fn(async (sessionId: string) => ({
          schemaVersion: 1 as const,
          sessionId,
          state: "running" as const,
          turnId: "turn-child",
          actions: { steer: false },
        })),
        getMessages: vi.fn(async () => [
          {
            id: "assistant-1",
            turnId: "turn-child",
            role: "assistant" as const,
            content: "Child transcript response",
            timestamp: 200,
          },
        ]),
        listBackgroundTasks: vi.fn(async () => [backgroundTask]),
      }),
      currentSession: () => ({ sessionId: "root" }),
      surfaceHost: { pushFeature } as never,
      openSession,
      onChanged: vi.fn(),
    });

    await flow.showTasks();

    expect(pushFeature).toHaveBeenCalledOnce();
    expect(screen?.id).toBe("background-work");
    expect(screen?.render(100).join("\n")).toContain("reviewer");
    expect(screen?.render(100).join("\n")).toContain("pnpm test");
    screen?.handleInput("\r");
    await vi.waitFor(() => expect(pushFeature).toHaveBeenCalledTimes(2));
    expect(screen?.id).toBe("transcript");
    screen?.handleInput("\r");
    expect(
      stripVTControlCharacters(screen?.render(100).join("\n") ?? ""),
    ).toContain("Child transcript response");
    expect(openSession).not.toHaveBeenCalled();
    expect(taskClose).not.toHaveBeenCalled();
    flow.stop();
  });

  it("does not open a stale Agent transcript after the task center closes", async () => {
    let resolveMessages: ((messages: readonly []) => void) | undefined;
    const getMessages = vi.fn(
      async () =>
        new Promise<readonly []>((resolve) => {
          resolveMessages = resolve;
        }),
    );
    let taskScreen:
      | {
          readonly id: string;
          render(width: number): string[];
          handleInput(data: string): void;
        }
      | undefined;
    let taskScreenActive = true;
    const pushFeature = vi.fn(
      (input: {
        screen:
          | {
              readonly id: string;
              render(width: number): string[];
              handleInput(data: string): void;
            }
          | undefined;
      }) => {
        taskScreen = input.screen;
        return {
          id: input.screen?.id ?? "unknown",
          close: () => {
            taskScreenActive = false;
            return true;
          },
          isActive: () => taskScreenActive,
        };
      },
    );
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getDelegationSnapshot: vi.fn(async () => ({
          schemaVersion: 1 as const,
          rootSessionId: "root",
          members: [
            {
              sessionId: "child-1",
              parentSessionId: "root",
              agentName: "reviewer",
              task: "Review the implementation",
              status: "running" as const,
            },
          ],
        })),
        getActiveRun: vi.fn(async (sessionId: string) => ({
          schemaVersion: 1 as const,
          sessionId,
          state: "running" as const,
          turnId: "turn-child",
          actions: { steer: false },
        })),
        getMessages,
        listBackgroundTasks: vi.fn(async () => []),
      }),
      currentSession: () => ({ sessionId: "root" }),
      surfaceHost: { pushFeature } as never,
      onChanged: vi.fn(),
    });

    await flow.showTasks();
    taskScreen?.handleInput("\r");
    await vi.waitFor(() =>
      expect(getMessages).toHaveBeenCalledWith("child-1", 200),
    );
    taskScreen?.handleInput("\u001B");
    resolveMessages?.([]);
    await vi.waitFor(() => expect(taskScreenActive).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pushFeature).toHaveBeenCalledOnce();
    flow.stop();
  });

  it("polls once more when the root Turn finishes during an older background task query", async () => {
    vi.useFakeTimers();
    const task = {
      taskId: "bg-after-finish",
      kind: "bash" as const,
      status: "running" as const,
      ownerSessionId: "root",
      description: "pnpm test",
      createdAtMs: 100,
      updatedAtMs: 200,
    };
    let finishStalePoll:
      | ((tasks: readonly (typeof task)[]) => void)
      | undefined;
    const listBackgroundTasks = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise<readonly (typeof task)[]>((resolve) => {
            finishStalePoll = resolve;
          }),
      )
      .mockResolvedValueOnce([task]);
    const onBackgroundTasksChanged = vi.fn();
    const flow = new TuiDelegationFlow({
      runtime: runtime({
        getActiveRun: vi.fn(async (sessionId: string) => ({
          schemaVersion: 1 as const,
          sessionId,
          state:
            sessionId === "root" ? ("running" as const) : ("idle" as const),
          actions: { steer: false },
        })),
        listBackgroundTasks,
      }),
      currentSession: () => ({ sessionId: "root" }),
      onBackgroundTasksChanged,
      onChanged: vi.fn(),
    });

    try {
      await flow.refresh();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(finishStalePoll).toBeTypeOf("function");

      await flow.handleRuntimeEvent({
        type: "session.finish",
        timestampMs: 300,
        source: "runtime",
        sessionId: "root",
        turnId: "root-turn",
        queueItemIds: [],
      });
      finishStalePoll?.([]);
      await vi.waitFor(() =>
        expect(listBackgroundTasks).toHaveBeenCalledTimes(2),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() =>
        expect(listBackgroundTasks).toHaveBeenCalledTimes(3),
      );
      expect(onBackgroundTasksChanged).toHaveBeenLastCalledWith([task]);
    } finally {
      flow.stop();
      vi.useRealTimers();
    }
  });

  it("finds the root team when opened from a nested child Session", async () => {
    const transcript = new TranscriptStore();
    const getSession = vi.fn(async (sessionId: string) => {
      if (sessionId === "child-a") {
        return {
          sessionId,
          parentSessionId: "root",
          sessionType: "branch" as const,
          sessionKind: "task",
          visibility: "visible" as const,
        };
      }
      return {
        sessionId: "root",
        sessionType: "root" as const,
        visibility: "visible" as const,
      };
    });
    const runtimePort = runtime({ getSession });
    const flow = new TuiDelegationFlow({
      runtime: runtimePort,
      currentSession: () => ({
        sessionId: "child-b",
        parentSessionId: "child-a",
        sessionType: "branch",
        sessionKind: "task",
        visibility: "visible",
      }),
      onChanged: vi.fn(),
    });

    await flow.refresh();

    expect(getSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "child-a",
      "root",
    ]);
    expect(runtimePort.getDelegationSnapshot).toHaveBeenCalledWith("root");
    expect(transcript.get("agent-team:root")).toBeUndefined();
    expect(flow.agentCounts()).toEqual({ active: 0, total: 0 });
  });

  it("marks a child as waiting when its Runtime interaction blocks", async () => {
    const runtimePort = runtime({
      getDelegationSnapshot: vi.fn(async () => ({
        schemaVersion: 1 as const,
        rootSessionId: "root",
        members: [
          {
            sessionId: "child-1",
            parentSessionId: "root",
            status: "running" as const,
          },
        ],
      })),
      getActiveRun: vi.fn(async () => ({
        schemaVersion: 1 as const,
        sessionId: "child-1",
        state: "running" as const,
        turnId: "turn-1",
        actions: { steer: false },
      })),
    });
    const flow = new TuiDelegationFlow({
      runtime: runtimePort,
      currentSession: () => ({ sessionId: "root" }),
      onChanged: vi.fn(),
    });
    await flow.refresh();

    await flow.handleRuntimeEvent({
      type: "permission.ask",
      timestampMs: 500,
      source: "runtime",
      sessionId: "child-1",
      request: {
        requestId: "permission-1",
        sessionId: "child-1",
        toolName: "write",
        description: "Write a file",
      },
    });

    expect(flow.snapshot().members[0]).toMatchObject({
      status: "waiting",
      activity: "Waiting for approval",
    });
    flow.stop();
  });

  describe('root background Task status count', () => {
    function bashTask(overrides: Partial<TuiBackgroundTask> = {}): TuiBackgroundTask {
      return {
        taskId: 'bash-1',
        kind: 'bash',
        status: 'running',
        ownerSessionId: 'root',
        command: 'sleep 75; echo finished',
        createdAtMs: 100,
        updatedAtMs: 100,
        ...overrides,
      };
    }

    function rootLifecycle(
      type: 'session.start' | 'session.finish',
      turnId: string,
      deliveredTaskId?: string,
    ) {
      return {
        type,
        timestampMs: 100,
        source: 'runtime',
        sessionId: 'root',
        turnId,
        queueItemIds: [],
        ...(deliveredTaskId
          ? { runSource: 'background-task-delivery' as const, taskId: deliveredTaskId }
          : {}),
      };
    }

    it('counts only queued, running and stopping Tasks, as listed by the Runtime', async () => {
      vi.useFakeTimers();
      let tasks: TuiBackgroundTask[] = [];
      const flow = new TuiDelegationFlow({
        runtime: runtime({ listBackgroundTasks: vi.fn(async () => tasks) }),
        currentSession: () => ({ sessionId: 'root' }),
        onChanged: vi.fn(),
      });

      try {
        await flow.handleRuntimeEvent(rootLifecycle('session.start', 'turn-1'));
        tasks = [bashTask(), bashTask({ taskId: 'bash-2', status: 'stopping' })];
        await vi.advanceTimersByTimeAsync(1_000);
        expect(flow.backgroundTaskCount()).toBe(2);

        await flow.handleRuntimeEvent(rootLifecycle('session.finish', 'turn-1'));
        expect(flow.backgroundTaskCount()).toBe(2);

        // A terminal Task is no longer active, whether or not its result reached the model.
        tasks = [
          bashTask({ status: 'succeeded', endedAtMs: 300, updatedAtMs: 300 }),
          bashTask({ taskId: 'bash-2', status: 'canceled', endedAtMs: 300, updatedAtMs: 300 }),
        ];
        await vi.advanceTimersByTimeAsync(1_000);
        expect(flow.backgroundTaskCount()).toBe(0);
      } finally {
        flow.stop();
      }
    });

    it('keeps sub-Agent Tasks in agents and ignores finished bash history', async () => {
      const flow = new TuiDelegationFlow({
        runtime: runtime({
          getDelegationSnapshot: vi.fn(async () => ({
            schemaVersion: 1 as const,
            rootSessionId: 'root',
            members: [
              {
                sessionId: 'child',
                parentSessionId: 'root',
                status: 'completed' as const,
                backgroundTaskId: 'agent-task',
              },
            ],
          })),
          listBackgroundTasks: vi.fn(async () => [
            bashTask({ status: 'succeeded', endedAtMs: 200, deliveredAtMs: 200 }),
          ]),
        }),
        currentSession: () => ({ sessionId: 'root' }),
        onChanged: vi.fn(),
      });
      await flow.refresh();

      expect(flow.agentCounts()).toEqual({ active: 1, total: 1 });
      expect(flow.backgroundTaskCount()).toBe(0);
      flow.stop();
    });

    it('excludes a foreground-owned bash Task that has not been promoted to the background', async () => {
      const flow = new TuiDelegationFlow({
        runtime: runtime({
          listBackgroundTasks: vi.fn(async () => [
            bashTask({ foreground: true }),
            bashTask({ taskId: 'bash-2', status: 'running' }),
          ]),
        }),
        currentSession: () => ({ sessionId: 'root' }),
        onChanged: vi.fn(),
      });
      await flow.refresh();
      expect(flow.backgroundTaskCount()).toBe(1);
      flow.stop();
    });

    it('never reports zero before a Task list requested after the root settle succeeds', async () => {
      vi.useFakeTimers();
      let finishStalePoll: ((tasks: readonly TuiBackgroundTask[]) => void) | undefined;
      const listBackgroundTasks = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockImplementationOnce(
          () =>
            new Promise<readonly TuiBackgroundTask[]>((resolve) => {
              finishStalePoll = resolve;
            }),
        )
        .mockRejectedValueOnce(new Error('list unavailable'))
        .mockResolvedValueOnce([]);
      const onChanged = vi.fn();
      const flow = new TuiDelegationFlow({
        runtime: runtime({
          getActiveRun: vi.fn(async (sessionId: string) => ({
            schemaVersion: 1 as const,
            sessionId,
            state: 'running' as const,
            actions: { steer: false },
          })),
          listBackgroundTasks,
        }),
        currentSession: () => ({ sessionId: 'root' }),
        onChanged,
      });

      try {
        await flow.refresh();
        expect(flow.backgroundTaskCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(finishStalePoll).toBeTypeOf('function');

        await flow.handleRuntimeEvent(rootLifecycle('session.finish', 'turn-1'));
        expect(flow.backgroundTaskCount()).toBe(1);

        // A list requested before the settle cannot prove that no Task was yielded.
        finishStalePoll?.([]);
        await vi.advanceTimersByTimeAsync(0);
        expect(flow.backgroundTaskCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(listBackgroundTasks).toHaveBeenCalledTimes(3);
        expect(flow.backgroundTaskCount()).toBe(1);

        onChanged.mockClear();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(listBackgroundTasks).toHaveBeenCalledTimes(4);
        expect(flow.backgroundTaskCount()).toBe(0);
        expect(onChanged).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(5_000);
        expect(listBackgroundTasks).toHaveBeenCalledTimes(4);
      } finally {
        flow.stop();
      }
    });
  });
});
