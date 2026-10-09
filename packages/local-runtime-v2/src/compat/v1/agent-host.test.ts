import { describe, expect, it, vi } from "vitest";
import {
  RuntimeEventStatus,
  RuntimeEventType,
} from "@mavis/agent-core/protocol";
import type { ThreadGoalBudgetCheckResult } from "@mavis/goal";

import {
  createV1AttachmentRegistration,
  createV1AgentHostProductCapabilities,
  createV1ChannelProductCapabilities,
} from "./agent-host.js";

describe("createV1AttachmentRegistration", () => {
  it("exposes durable asset registration and source resolution to v2", () => {
    const register = vi.fn();
    const discard = vi.fn();
    const resolveSource = vi.fn();
    const registration = createV1AttachmentRegistration({
      createHostedAgentCapabilities: () => ({
        attachments: { register, discard, resolveSource },
      }),
    } as never);

    expect(registration).toEqual({ register, discard, resolveSource });
    expect(registration).not.toHaveProperty("materialize");
  });
});

describe("createV1AgentHostProductCapabilities", () => {
  it("maps the hosted checkpoint snapshot into the product capability", async () => {
    const captureSubagents = vi.fn(async () => undefined);
    const hosted = buildHostedCapabilities({
      buildUserPromptPrefix: vi.fn(),
      beforeLlmCall: vi.fn(),
      afterLlmCall: vi.fn(),
      beforeToolCall: vi.fn(),
      projectRuntimeEvent: vi.fn((_identity, event) => event),
      endTurn: vi.fn(),
    });
    hosted.checkpointState = { captureSubagents };
    const product = createV1AgentHostProductCapabilities({
      createHostedAgentCapabilities: () => hosted,
    } as never);

    await product.checkpointState.captureSubagents({ sessionId: "session-a" });

    expect(captureSubagents).toHaveBeenCalledWith({ sessionId: "session-a" });
  });

  it("injects raw v1 product capabilities into the native v2 composition shape", async () => {
    const websiteDeploy = createWebsiteDeployCapabilities();
    const turnRuntimeFacts = {
      snapshot: vi.fn(() => ({ cuModeActive: true })),
    };
    const toolSources = { resolve: vi.fn() };
    const hosted = {
      config: vi.fn(() => ({ dataDir: "/data", provider: {} })),
      authContextGetter: vi.fn(),
      providerAuthGetter: vi.fn(),
      fetchImpl: vi.fn<typeof fetch>(),
      skills: {
        listRuntimeSkills: vi.fn(),
        renderCatalog: vi.fn(),
      },
      memory: { collectReminderMemory: vi.fn(), getDaily: vi.fn() },
      turnRuntimeFacts,
      toolSources,
      reminders: {
        buildBackground: vi.fn(),
        buildSystem: vi.fn(),
        confirmBackgroundTaskReads: vi.fn(),
      },
      attachments: { materialize: vi.fn() },
      websiteDeploy,
      permissions: { decisions: { check: vi.fn() } },
      hooks: { beforeToolCall: vi.fn(), afterToolCall: vi.fn() },
      review: {
        buildUserPromptPrefix: vi.fn(),
        beforeLlmCall: vi.fn(),
        afterLlmCall: vi.fn(),
        beforeToolCall: vi.fn(),
        projectRuntimeEvent: vi.fn((_identity, event) => event),
        endTurn: vi.fn(),
      },
      reviewContent: vi.fn(),
      fileChanges: { begin: vi.fn(), finalize: vi.fn(), markFailed: vi.fn() },
      turnLifecycle: {
        started: vi.fn(),
        checkBudget: vi.fn(async () => ({ decision: "allow" as const })),
        classifyFailure: vi.fn(() => "unknown" as const),
        settled: vi.fn(),
      },
      terminalMemory: { record: vi.fn() },
      contextUsage: { isEnabled: vi.fn(), prepareAttempt: vi.fn() },
      runnerLogger: { error: vi.fn() },
      llmRequestFailureHook: vi.fn(),
      reportFailure: vi.fn(),
      metricsClient: undefined,
    };
    const evalReporterFactory = {
      canReport: vi.fn(() => true),
      getReporter: vi.fn(),
      releaseReporter: vi.fn(),
      flush: vi.fn(),
    };
    const product = createV1AgentHostProductCapabilities(
      { createHostedAgentCapabilities: () => hosted } as never,
      evalReporterFactory,
    );

    expect(product.preparation.configBuilder.config).toBe(hosted.config);
    expect(product.preparation.configBuilder.skills).toBe(hosted.skills);
    expect(product.preparation.configBuilder.memory).toBe(hosted.memory);
    expect(product.preparation.modelResolver.fetchImpl).toBe(hosted.fetchImpl);
    expect(product.turnRuntimeFacts).toBe(hosted.turnRuntimeFacts);
    expect(product.toolSources).toBe(hosted.toolSources);
    expect(product.inputPreparation.materializePrompt).toBe(
      websiteDeploy.materializeSources,
    );
    await product.inputPreparation.reminders.buildSystem({
      session: { sessionId: "session-1" },
      agent: { agentName: "mavis", resourceAgentName: "main" },
      agentConfig: {},
      promptText: "hello",
      turnId: "turn-1",
    } as never);
    expect(hosted.reminders.buildSystem).toHaveBeenCalledWith({
      session: { sessionId: "session-1" },
      resourceAgentName: "main",
      promptText: "hello",
      turnId: "turn-1",
      deferTelemetry: true,
    });
    await product.inputPreparation.reminders.buildSystem({
      session: { sessionId: "session-1" },
      agent: { agentName: "mavis", resourceAgentName: "main" },
      agentConfig: {},
      promptText: "again",
      turnId: "turn-2",
      sessionIdInContext: true,
    } as never);
    expect(hosted.reminders.buildSystem).toHaveBeenLastCalledWith({
      session: { sessionId: "session-1" },
      resourceAgentName: "main",
      promptText: "again",
      turnId: "turn-2",
      deferTelemetry: true,
      sessionIdInContext: true,
    });
    expect(product.executor.fileChanges.begin).toBe(hosted.fileChanges.begin);
    expect(product.runner.contextUsage).toBe(hosted.contextUsage);
    expect(product.runner.logger).toBe(hosted.runnerLogger);
    expect(product.runner.onLLMRequestFailure).toBe(
      hosted.llmRequestFailureHook,
    );
    expect(product.runner.evalReporterFactory).toBe(evalReporterFactory);
    expect(product.runner).not.toHaveProperty("reviewContent");
    expect(product).not.toHaveProperty("agents");
    expect(product.normalExtensions?.map((extension) => extension.id)).toEqual([
      "local-v1-website-deploy-projection",
      "local-v1-goal-budget-guard",
      "local-builtin-tool-hooks",
      "local-code-review",
    ]);
    expect(product.eventObserver).toBeDefined();
    expect(product.terminalMemory).toBe(hosted.terminalMemory);
    expect(product).not.toHaveProperty("legacyHistory");
    expect(product).not.toHaveProperty("sessionSystem");
  });
});

describe("createV1AgentHostProductCapabilities website projection", () => {
  it("keeps website projection state in the v2 event and extension owners", async () => {
    const projectRuntimeEvent = vi.fn((event: unknown) => event);
    const afterToolCallHook = vi.fn();
    const afterLlmCallHook = vi.fn();
    const createTurnProjection = vi.fn(() => ({
      projectRuntimeEvent,
      afterToolCallHook,
      afterLlmCallHook,
    }));
    const hosted = buildHostedCapabilities({
      buildUserPromptPrefix: vi.fn(),
      beforeLlmCall: vi.fn(),
      afterLlmCall: vi.fn(),
      beforeToolCall: vi.fn(),
      projectRuntimeEvent: vi.fn((_identity, event) => event),
      endTurn: vi.fn(),
    });
    hosted.websiteDeploy = {
      materializeSources: vi.fn(
        async ({ content }: { content: string }) => content,
      ),
      createTurnProjection,
    };
    const product = createHostProduct(hosted);
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const extension = product.normalExtensions?.find(
      (candidate) => candidate.id === "local-v1-website-deploy-projection",
    );
    if (!extension)
      throw new Error("expected website deploy projection extension");
    extension.init({
      params: {},
      on: (event: string, handler: (...args: never[]) => unknown) => {
        handlers.set(event, handler);
      },
    } as never);
    const turn = { sessionId: "session-1", turnId: "turn-1" };
    const event = {
      type: RuntimeEventType.STREAM_RESP,
      payload: { stream_resp: "{}" },
    };
    const projectEvent = product.executor.projectRuntimeEvent;
    if (!projectEvent)
      throw new Error("expected website deploy event projector");

    await projectEvent({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      event: event as never,
    });
    await handlers.get("after_tool_call")?.(
      { toolCall: { name: "website_deploy" } } as never,
      undefined as never,
      turn as never,
    );
    await handlers.get("after_llm_call")?.(
      { message: { content: [] } } as never,
      turn as never,
    );
    await handlers.get("turn_end")?.(
      { reason: "completed" } as never,
      turn as never,
    );

    expect(createTurnProjection).toHaveBeenCalledOnce();
    expect(projectRuntimeEvent).toHaveBeenCalledWith(event);
    expect(afterToolCallHook).toHaveBeenCalledOnce();
    expect(afterLlmCallHook).toHaveBeenCalledOnce();

    await projectEvent({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      event: event as never,
    });
    expect(createTurnProjection).toHaveBeenCalledTimes(2);
  });
});

describe("createV1AgentHostProductCapabilities Goal budget guard", () => {
  it("allows unbound tools and injects the tool-free budget steering only once", async () => {
    const checkBudget = vi
      .fn<() => Promise<ThreadGoalBudgetCheckResult>>(async () => ({
        decision: "steer" as const,
        message:
          "GOAL_BUDGET_EXHAUSTED(token): The Goal budget is exhausted. Do not call another tool; respond now with a concise final summary.",
      }))
      .mockResolvedValueOnce({ decision: "allow" as const })
      .mockResolvedValueOnce({
        decision: "steer" as const,
        message:
          "GOAL_BUDGET_EXHAUSTED(token): The Goal budget is exhausted. Do not call another tool; respond now with a concise final summary.",
      })
      .mockResolvedValueOnce({
        decision: "stop" as const,
        message:
          "GOAL_BUDGET_EXHAUSTED(token): Tool execution remains disabled for this Goal turn.",
      });
    const hosted = buildHostedCapabilities({});
    hosted.turnLifecycle.checkBudget = checkBudget;
    const product = createHostProduct(hosted);
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const extension = product.normalExtensions?.find(
      (candidate) => candidate.id === "local-v1-goal-budget-guard",
    );
    if (!extension) throw new Error("expected Goal budget guard extension");
    extension.init({
      params: {},
      on: (event: string, handler: (...args: never[]) => unknown) => {
        handlers.set(event, handler);
      },
    } as never);
    const turn = { sessionId: "session-1", turnId: "turn-budget" };
    await commitAssistantMessage(
      product,
      { ...turn, turnSequence: 1 },
      {
        usage: { input: 7, output: 2, reasoning: 1 },
        operation: { id: "append-budget", kind: "history-append" },
      },
    );

    await expect(
      handlers.get("before_tool_call")?.(
        {} as never,
        undefined as never,
        turn as never,
      ),
    ).resolves.toBeUndefined();
    await expect(
      handlers.get("before_tool_call")?.(
        {} as never,
        undefined as never,
        turn as never,
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining(
        "respond now with a concise final summary",
      ),
    });
    await expect(
      handlers.get("before_tool_call")?.(
        {} as never,
        undefined as never,
        turn as never,
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("remains disabled"),
    });
    expect(checkBudget).toHaveBeenCalledTimes(3);
    expect(checkBudget).toHaveBeenLastCalledWith({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      observedTokens: 10,
    });
    expect(handlers.has("turn_end")).toBe(false);
  });
});

describe("createV1AgentHostProductCapabilities lifecycle", () => {
  it("collects v2 Turn facts in the observer and settles Goal lifecycle through a required port", async () => {
    const hosted = buildHostedCapabilities({});
    const product = createHostProduct(hosted);
    const observer = product.eventObserver;
    if (!observer) throw new Error("expected v1 lifecycle observer");
    const context = {
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 1,
      provenance: {
        source: "thread-goal" as const,
        routingFingerprint: "goal:continuation",
      },
      executionModel: {
        provider: "custom_provider:work",
        model_id: "worker-large",
      },
    };

    await observer.observeRuntimeEvent?.({
      context,
      event: {
        type: RuntimeEventType.SESSION_STATUS,
        payload: { status: RuntimeEventStatus.RUNNING },
      } as never,
    });
    await commitAssistantMessage(product, context, {
      content: [{ type: "text", text: "durable final answer" }],
      usage: { input: 7, output: 3 },
      operation: { id: "append-1", kind: "history-append" },
    });
    await observer.observeHistoryCommitted?.({
      context,
      change: {
        reason: "replaceMessages",
        messages: [],
        operation: {
          id: "retract-1",
          kind: "output-recall",
          variant: "content",
        },
      } as never,
    });
    await observer.observeRuntimeEvent?.({
      context,
      event: {
        type: RuntimeEventType.TURN_TERMINAL,
        payload: { status: RuntimeEventStatus.COMPLETED },
      } as never,
    });

    expect(hosted.turnLifecycle.started).toHaveBeenCalledOnce();
    expect(hosted.turnLifecycle.started).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-1",
      source: "thread-goal",
    });
    expect(hosted.turnLifecycle.settled).not.toHaveBeenCalled();
    await product.turnSettlement?.settle({
      sessionId: "session-1",
      turnId: "turn-1",
      status: "completed",
    });
    expect(hosted.turnLifecycle.settled).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-1",
      status: "completed",
      tokens: 10,
      retracted: true,
      finalAssistantText: "durable final answer",
      workerModelKey: "custom_provider:work/worker-large",
      // Observed history with no tool call is a trustworthy zero for the Goal
      // no-tool breaker; it is only reported because a commit was seen.
      workSignals: { toolCalls: 0 },
    });
  });

  it("clears an earlier text when the last durable assistant message is tool-only", async () => {
    const hosted = buildHostedCapabilities({});
    const product = createHostProduct(hosted);
    const context = {
      sessionId: "session-1",
      turnId: "turn-tool-only",
      turnSequence: 1,
    };

    await commitAssistantMessage(product, context, {
      content: [{ type: "text", text: "superseded answer" }],
      operation: { id: "append-text", kind: "append" },
    });
    await commitAssistantMessage(product, context, {
      content: [
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      ],
      operation: { id: "append-tool", kind: "append" },
    });
    await product.turnSettlement?.settle({
      sessionId: context.sessionId,
      turnId: context.turnId,
      status: "completed",
    });

    expect(hosted.turnLifecycle.settled).toHaveBeenCalledWith({
      sessionId: context.sessionId,
      turnId: context.turnId,
      status: "completed",
      tokens: 0,
      retracted: false,
      usageIncomplete: true,
      // Both commits are counted: the durable `toolCall` block is the only
      // trustworthy tool-call signal for this Turn.
      workSignals: { toolCalls: 1 },
    });
  });
});

/**
 * GOAL-11 no-tool breaker input: the Goal owner may only count a tool-less Turn
 * when this observer actually saw the committed history.
 */
describe("createV1AgentHostProductCapabilities tool-call observation", () => {
  it("never reports work signals for a Turn whose history was never observed", async () => {
    const hosted = buildHostedCapabilities({});
    const product = createHostProduct(hosted);
    const context = {
      sessionId: "session-1",
      turnId: "turn-unobserved",
      turnSequence: 1,
    };

    await product.eventObserver?.observeRuntimeEvent?.({
      context,
      event: {
        type: RuntimeEventType.TURN_TERMINAL,
        payload: { status: RuntimeEventStatus.COMPLETED },
      } as never,
    });
    await product.turnSettlement?.settle({
      sessionId: context.sessionId,
      turnId: context.turnId,
      status: "completed",
    });

    // A fabricated `{ toolCalls: 0 }` here would let the Goal no-tool breaker
    // count an observation gap as a tool-less Turn.
    const settled = hosted.turnLifecycle.settled.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(settled).toBeDefined();
    expect(settled).not.toHaveProperty("workSignals");
  });

  it("counts every committed tool call across multiple assistant commits", async () => {
    const hosted = buildHostedCapabilities({});
    const product = createHostProduct(hosted);
    const context = {
      sessionId: "session-1",
      turnId: "turn-multi-tool",
      turnSequence: 1,
    };

    await commitAssistantMessage(product, context, {
      content: [
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        { type: "toolCall", id: "call-2", name: "grep", arguments: {} },
      ],
      operation: { id: "append-tools", kind: "append" },
    });
    await commitAssistantMessage(product, context, {
      content: [{ type: "text", text: "done" }],
      operation: { id: "append-text", kind: "append" },
    });
    await product.turnSettlement?.settle({
      sessionId: context.sessionId,
      turnId: context.turnId,
      status: "completed",
    });

    expect(hosted.turnLifecycle.settled).toHaveBeenCalledWith(
      expect.objectContaining({ workSignals: { toolCalls: 2 } }),
    );
  });
});

describe("createV1AgentHostProductCapabilities lifecycle release", () => {
  it("releases the Turn when TurnSystem gives up settling it", async () => {
    const hosted = buildHostedCapabilities({});
    const product = createHostProduct(hosted);
    const context = {
      sessionId: "session-1",
      turnId: "turn-abandoned",
      turnSequence: 1,
    };

    await commitAssistantMessage(product, context, {
      content: [{ type: "text", text: "never settled" }],
      usage: { input: 4, output: 1 },
      operation: { id: "append-1", kind: "append" },
    });
    await product.turnSettlement?.abandon?.({
      sessionId: context.sessionId,
      turnId: context.turnId,
    });

    expect(hosted.turnLifecycle.abandoned).toHaveBeenCalledWith({
      sessionId: context.sessionId,
      turnId: context.turnId,
    });
    expect(hosted.turnLifecycle.settled).not.toHaveBeenCalled();

    // The observation is gone with it: a later settle for the same Turn starts
    // from zero rather than replaying the abandoned Turn's usage.
    await product.turnSettlement?.settle({
      sessionId: context.sessionId,
      turnId: context.turnId,
      status: "failed",
    });
    expect(hosted.turnLifecycle.settled).toHaveBeenCalledWith({
      sessionId: context.sessionId,
      turnId: context.turnId,
      status: "failed",
      tokens: 0,
      retracted: false,
      failureClass: "unknown",
    });
  });

  it.each([
    ["provider quota", 50_110, "credits exhausted", "provider_quota"],
    ["rate limit", 50_111, "rate limited", "rate_limit"],
    ["retryable infra", 50_113, "upstream unavailable", "infra_retryable"],
    ["safety rejection", 50_201, "sensitive content", "safety"],
    ["unknown failure", 41, "unclassified", "unknown"],
  ] as const)(
    "classifies %s from the terminal event before settlement",
    async (_label, code, message, failureClass) => {
      const hosted = buildHostedCapabilities({});
      const product = createHostProduct(hosted);
      const context = {
        sessionId: "session-1",
        turnId: `turn-${code}`,
        turnSequence: 1,
      };

      await product.eventObserver?.observeRuntimeEvent?.({
        context,
        event: {
          type: RuntimeEventType.TURN_TERMINAL,
          payload: {
            status: RuntimeEventStatus.FAILED,
            error: { code, message },
          },
        } as never,
      });
      await product.turnSettlement?.settle({
        sessionId: context.sessionId,
        turnId: context.turnId,
        status: "failed",
      });

      expect(hosted.turnLifecycle.settled).toHaveBeenCalledWith({
        sessionId: context.sessionId,
        turnId: context.turnId,
        status: "failed",
        tokens: 0,
        retracted: false,
        failureClass,
      });
    },
  );
});

describe("createV1ChannelProductCapabilities", () => {
  it("injects v1 Channel transport into the independent v2 ChannelSystem port", async () => {
    const finalReplies = { deliver: vi.fn() };
    const typing = { start: vi.fn(), end: vi.fn() };
    const product = createV1ChannelProductCapabilities({
      createHostedChannelCapabilities: () => ({ finalReplies, typing }),
    } as never);

    const input = {
      channelContext: {
        platform: "wechat",
        chatType: "p2p",
        chatId: "chat-1",
        senderId: "user-1",
        clientName: "wechat",
      },
      sessionId: "session-1",
      messages: [],
    };
    await product.finalReplies.deliver(input);
    await product.typing.start(input);
    await product.typing.end(input);

    expect(finalReplies.deliver).toHaveBeenCalledOnce();
    expect(typing.start).toHaveBeenCalledWith(input);
    expect(typing.end).toHaveBeenCalledWith(input);
  });
});

describe("createV1AgentHostProductCapabilities system reminders", () => {
  it("forwards the prepared model to the v1 system reminder service", async () => {
    const hosted = buildHostedCapabilities({
      buildUserPromptPrefix: vi.fn(),
      beforeLlmCall: vi.fn(),
      afterLlmCall: vi.fn(),
      beforeToolCall: vi.fn(),
      projectRuntimeEvent: vi.fn((_identity, event) => event),
      endTurn: vi.fn(),
    });
    const product = createHostProduct(hosted);

    await product.inputPreparation.reminders.buildSystem({
      session: { sessionId: "session-1" },
      agent: { agentName: "mavis", resourceAgentName: "main" },
      agentConfig: {
        model: {
          provider: "minimax",
          model_id: "MiniMax-M2.7-highspeed",
          variant: "thinking",
        },
      },
      promptText: "hello",
      turnId: "turn-1",
    } as never);

    expect(hosted.reminders.buildSystem).toHaveBeenCalledWith({
      session: { sessionId: "session-1" },
      resourceAgentName: "main",
      promptText: "hello",
      turnId: "turn-1",
      deferTelemetry: true,
      model: {
        providerID: "minimax",
        modelID: "MiniMax-M2.7-highspeed",
        variant: "thinking",
      },
    });
  });

  it("accepts the compatible model id field and omits an absent variant", async () => {
    const hosted = buildHostedCapabilities({});
    const product = createHostProduct(hosted);

    await product.inputPreparation.reminders.buildSystem({
      session: { sessionId: "session-1" },
      agent: { agentName: "mavis", resourceAgentName: "main" },
      agentConfig: { model: { provider: "minimax", id: "MiniMax-M2.7" } },
      promptText: "hello",
      turnId: "turn-1",
    } as never);

    expect(hosted.reminders.buildSystem).toHaveBeenCalledWith({
      session: { sessionId: "session-1" },
      resourceAgentName: "main",
      promptText: "hello",
      turnId: "turn-1",
      deferTelemetry: true,
      model: { providerID: "minimax", modelID: "MiniMax-M2.7" },
    });
  });
});

describe("local code review extension lifecycle", () => {
  it("keeps after-LLM validation step-scoped and cleanup turn-terminal", async () => {
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const review = {
      buildUserPromptPrefix: vi.fn(),
      beforeLlmCall: vi.fn(),
      afterLlmCall: vi.fn(),
      beforeToolCall: vi.fn(),
      projectRuntimeEvent: vi.fn((_identity, event) => event),
      endTurn: vi.fn(),
    };
    const hosted = buildHostedCapabilities(review);
    const product = createHostProduct(hosted);
    const extension = product.normalExtensions?.find(
      (candidate) => candidate.id === "local-code-review",
    );
    if (!extension) throw new Error("expected local-code-review extension");
    extension.init({
      params: {},
      contributeUserPromptPrefix: vi.fn(),
      on: (event: string, handler: (...args: never[]) => unknown) => {
        handlers.set(event, handler);
      },
    } as never);
    const turn = {
      sessionId: "session-1",
      turnId: "turn-1",
      model: { provider: "test", model: "model" },
    };

    await handlers.get("after_llm_call")?.({} as never, turn as never);
    await handlers.get("after_llm_call")?.({} as never, turn as never);

    expect(review.afterLlmCall).toHaveBeenCalledTimes(2);
    expect(review.endTurn).not.toHaveBeenCalled();

    await handlers.get("turn_end")?.(
      { reason: "completed" } as never,
      turn as never,
    );
    expect(review.endTurn).toHaveBeenCalledOnce();
    expect(review.endTurn).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-1",
    });
  });
});

function buildHostedCapabilities(review: Record<string, unknown>) {
  return {
    config: vi.fn(() => ({ dataDir: "/data", provider: {} })),
    authContextGetter: vi.fn(),
    providerAuthGetter: vi.fn(),
    skills: { listRuntimeSkills: vi.fn(), renderCatalog: vi.fn() },
    memory: { collectReminderMemory: vi.fn(), getDaily: vi.fn() },
    turnRuntimeFacts: { snapshot: vi.fn(() => ({ cuModeActive: false })) },
    toolSources: { resolve: vi.fn() },
    checkpointState: { captureSubagents: vi.fn(async () => undefined) },
    reminders: {
      buildBackground: vi.fn(),
      buildSystem: vi.fn(),
      confirmBackgroundTaskReads: vi.fn(),
    },
    attachments: { materialize: vi.fn() },
    websiteDeploy: createWebsiteDeployCapabilities(),
    permissions: { decisions: { check: vi.fn() } },
    hooks: { beforeToolCall: vi.fn(), afterToolCall: vi.fn() },
    review,
    reviewContent: vi.fn(),
    fileChanges: { begin: vi.fn(), finalize: vi.fn(), markFailed: vi.fn() },
    turnLifecycle: {
      started: vi.fn(),
      checkBudget: vi.fn<() => Promise<ThreadGoalBudgetCheckResult>>(
        async () => ({
          decision: "allow",
        }),
      ),
      classifyFailure: vi.fn(({ code }: { code?: number | string }) => {
        const classes = new Map<number, string>([
          [50_110, "provider_quota"],
          [50_111, "rate_limit"],
          [50_113, "infra_retryable"],
          [50_201, "safety"],
        ]);
        return (classes.get(Number(code)) ?? "unknown") as
          | "provider_quota"
          | "rate_limit"
          | "infra_retryable"
          | "safety"
          | "unknown";
      }),
      settled: vi.fn(),
      abandoned: vi.fn(),
    },
    terminalMemory: { record: vi.fn() },
    contextUsage: { isEnabled: vi.fn(), prepareAttempt: vi.fn() },
    runnerLogger: { error: vi.fn() },
    reportFailure: vi.fn(),
    metricsClient: undefined,
  };
}

/** The single-argument product construction every capability test shares. */
function createHostProduct(hosted: unknown) {
  return createV1AgentHostProductCapabilities({
    createHostedAgentCapabilities: () => hosted,
  } as never);
}

type HostProduct = ReturnType<typeof createHostProduct>;
type HistoryCommitInput = Parameters<
  NonNullable<
    NonNullable<HostProduct["eventObserver"]>["observeHistoryCommitted"]
  >
>[0];

/**
 * Commits one durable assistant message the way TurnSystem does.
 *
 * The observer only ever reads `role`, `content`, `usage`, and the operation, so
 * tests state those three and let this fixture own the `messageDelta` envelope.
 */
async function commitAssistantMessage(
  product: HostProduct,
  context: HistoryCommitInput["context"],
  message: {
    readonly content?: unknown;
    readonly usage?: unknown;
    readonly operation: { readonly id: string; readonly kind: string };
  },
): Promise<void> {
  await product.eventObserver?.observeHistoryCommitted?.({
    context,
    change: {
      reason: "messageDelta",
      messages: [
        {
          role: "assistant",
          ...(message.content === undefined
            ? {}
            : { content: message.content }),
          ...(message.usage === undefined ? {} : { usage: message.usage }),
        },
      ],
      operation: message.operation,
    } as never,
  });
}

function createWebsiteDeployCapabilities() {
  return {
    materializeSources: vi.fn(
      async ({ content }: { content: string }) => content,
    ),
    createTurnProjection: vi.fn(() => ({
      projectRuntimeEvent: vi.fn((event: unknown) => event),
      afterToolCallHook: vi.fn(),
      afterLlmCallHook: vi.fn(),
    })),
  };
}
