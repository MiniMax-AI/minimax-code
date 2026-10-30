import {
  type CreateLocalRuntimeHostOptions,
  type CreatedLocalRuntimeHost,
} from "@mavis/local-runtime";
import { DeferredRuntimeConversation } from "@mavis/conversation-contract";
import type { ThreadGoalState, ThreadGoalStore } from "@mavis/goal";
import type { AgentReferenceResolver } from "@mavis/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupFailedV1Startup,
  createDeferredAgentRuntimeTelemetry,
  createV1RuntimeCompatibility,
  withAgentStorageScope,
} from "../../../../src/compat/v1/runtime.js";

type ThreadGoalIntegration = CreatedLocalRuntimeHost["apiHost"]["threadGoal"];

const mocked = vi.hoisted(() => ({
  adapter: { marker: "adapter" },
  agentHost: { marker: "agent-host-capabilities" },
  attachmentRegistration: { marker: "attachment-registration" },
  channel: { marker: "channel-capabilities" },
  bindCalls: [] as unknown[],
  cleanupBindCalls: [] as unknown[],
  deleteAgentCronTasks: vi.fn(async () => undefined),
  sessionCompatibility: { marker: "session-v2" },
  sessionCompatibilityHosts: [] as unknown[],
  agentResolver: {
    marker: "agent-resolver",
  } as unknown as AgentReferenceResolver,
  closeAgentDb: vi.fn(),
  inspectCollision: vi.fn(),
  applyCollision: vi.fn(),
  suppressedDeliveryTaskIds: new Set<string>(),
}));

vi.mock("@mavis/local-runtime", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@mavis/local-runtime",
  );
  return {
    ...actual,
    closeAgentDb: mocked.closeAgentDb,
    scanWorkspace: mocked.scanWorkspace,
    isTaskDeliverySuppressed: (_host: unknown, taskId: string) =>
      mocked.suppressedDeliveryTaskIds.has(taskId),
    withAgentNameConflictMigrationScope: async (
      _dataDir: string,
      operation: (scope: {
        inspectCollision: () => unknown;
        applyCollision: (nowMs?: () => number) => unknown;
      }) => unknown,
    ) =>
      operation({
        inspectCollision: mocked.inspectCollision,
        applyCollision: mocked.applyCollision,
      }),
  };
});

vi.mock("../../../../src/compat/v1/cron.js", () => ({
  createV1MavisCronAdapterBridge: () => ({
    adapter: mocked.adapter,
    bindHandleRequest: (handleRequest: unknown) =>
      mocked.bindCalls.push(handleRequest),
  }),
  createV1CronAgentCleanupBridge: () => ({
    deleteAgentCronTasks: mocked.deleteAgentCronTasks,
    bind: (service: unknown) => mocked.cleanupBindCalls.push(service),
  }),
}));

vi.mock("../../../../src/compat/v1/agent-host.js", () => ({
  createV1AttachmentRegistration: () => mocked.attachmentRegistration,
  createV1AgentHostProductCapabilities: () => mocked.agentHost,
  createV1ChannelProductCapabilities: () => mocked.channel,
}));

vi.mock("../../../../src/compat/v1/session.js", () => ({
  createV1SessionCompatibility: (host: unknown) => {
    mocked.sessionCompatibilityHosts.push(host);
    return mocked.sessionCompatibility;
  },
}));

function resetRuntimeCompatibilityMocks(): void {
  mocked.bindCalls.length = 0;
  mocked.cleanupBindCalls.length = 0;
  mocked.deleteAgentCronTasks.mockClear();
  mocked.sessionCompatibilityHosts.length = 0;
}

describe("v1 runtime compatibility", () => {
  beforeEach(() => {
    resetRuntimeCompatibilityMocks();
    mocked.closeAgentDb.mockReset();
    mocked.inspectCollision.mockReset();
    mocked.applyCollision.mockReset();
  });

  it.each([true, false])(
    "passes resolved prompt autoUpdate=%s into service compatibility",
    (autoUpdate) => {
      const services = createCompatibility().createServiceCompatibility(
        createdHost({ configGetter: () => ({ promptConfig: { autoUpdate } }) }),
        { dataDir: "/tmp/runtime" } as CreateLocalRuntimeHostOptions,
      );
      expect(services.promptConfig).toEqual({ autoUpdate });
    },
  );

  it("revokes an escaped storage callback without closing a later cached connection", async () => {
    const laterCachedConnection = { closed: false };
    mocked.closeAgentDb.mockImplementation(() => {
      laterCachedConnection.closed = true;
    });
    mocked.applyCollision.mockImplementation(() => {
      throw new Error("underlying scope should not be reached after revoke");
    });
    let escaped: (() => unknown) | undefined;

    await withAgentStorageScope("/tmp/runtime", async (scope) => {
      escaped = scope.applyLegacyAgentStorage;
    });
    const escapedCallback = escaped;
    if (!escapedCallback) throw new Error("storage callback was not captured");

    expect(() => escapedCallback()).toThrow(
      "Agent storage lock scope is no longer active",
    );
    expect(mocked.applyCollision).not.toHaveBeenCalled();
    expect(mocked.closeAgentDb).not.toHaveBeenCalled();
    expect(laterCachedConnection.closed).toBe(false);
  });

  it("exposes the scan/apply seam and closes the cached Agent DB after apply", async () => {
    const inspection = {
      status: "skipped" as const,
      sourceKind: "legacy-agent-sqlite" as const,
      targetKind: "legacy-runtime-references" as const,
      sourceRowCount: 0,
      conflictCount: 0,
      mappings: [],
      referenceCounts: {
        primaryDatabase: 0,
        runtimeDatabase: 0,
        yamlFiles: 0,
        planFiles: 0,
        legacyUnclassified: 0,
      },
      skipCode: "source_missing" as const,
    };
    mocked.inspectCollision.mockReturnValue(inspection);
    mocked.applyCollision.mockReturnValue({
      status: "completed",
      mappings: [],
    });

    await withAgentStorageScope("/tmp/runtime", async (scope) => {
      expect(scope.inspectLegacyAgentStorage()).toBe(inspection);
      expect(scope.applyLegacyAgentStorage()).toEqual({
        status: "completed",
        mappings: [],
      });
      expect(scope).not.toHaveProperty("reportCutover");
    });

    expect(mocked.inspectCollision).toHaveBeenCalledOnce();
    expect(mocked.applyCollision).toHaveBeenCalledOnce();
    expect(mocked.closeAgentDb).toHaveBeenCalledWith("/tmp/runtime");
  });
  it("closes the cached Agent DB when apply throws", async () => {
    mocked.applyCollision.mockImplementation(() => {
      throw new Error("rewrite failed");
    });

    await expect(
      withAgentStorageScope("/tmp/runtime", async (scope) =>
        scope.applyLegacyAgentStorage(),
      ),
    ).rejects.toThrow("rewrite failed");

    expect(mocked.applyCollision).toHaveBeenCalledOnce();
    expect(mocked.closeAgentDb).toHaveBeenCalledWith("/tmp/runtime");
  });

  it("keeps the apply error primary when cached Agent DB cleanup also fails", async () => {
    const applyError = Object.assign(new Error("rewrite failed"), {
      failureStep: "primary_rewrite",
      migrationId: "agent-name-conflicts-17",
    });
    const closeError = new Error("close failed");
    mocked.applyCollision.mockImplementation(() => {
      throw applyError;
    });
    mocked.closeAgentDb.mockImplementation(() => {
      throw closeError;
    });

    let error: unknown;
    try {
      await withAgentStorageScope("/tmp/runtime", async (scope) =>
        scope.applyLegacyAgentStorage(),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      failureStep: "primary_rewrite",
      migrationId: "agent-name-conflicts-17",
    });
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError & { cause?: unknown };
    expect(aggregate.cause).toBe(applyError);
    expect(aggregate.errors).toEqual([applyError, closeError]);
  });

  it("retains the completed migration correlation id when cached Agent DB cleanup fails", async () => {
    const closeError = new Error("close failed");
    mocked.applyCollision.mockReturnValue({
      status: "completed",
      mappings: [],
      migrationId: "agent-name-conflicts-18",
    });
    mocked.closeAgentDb.mockImplementation(() => {
      throw closeError;
    });

    let error: unknown;
    try {
      await withAgentStorageScope("/tmp/runtime", async (scope) =>
        scope.applyLegacyAgentStorage(),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ migrationId: "agent-name-conflicts-18" });
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError & { cause?: unknown }).cause).toBe(
      closeError,
    );
  });
});

describe("v1 prompt suggestion setting compatibility", () => {
  beforeEach(resetRuntimeCompatibilityMocks);

  it("persists the next-message suggestion switch through the validated config writer", async () => {
    let config: { promptSuggestion?: { enabled: boolean } } = {
      promptSuggestion: { enabled: true },
    };
    const updateConfig = vi.fn(async (body: { field: string; set: boolean }) => {
      config = { promptSuggestion: { enabled: body.set } };
      return { config };
    });
    const configuration = createCompatibility().createServiceCompatibility(
      createdHost({ configGetter: () => config, updateConfig }),
      { dataDir: "/tmp/runtime" } as CreateLocalRuntimeHostOptions,
    ).peripherals.configuration;
    if (!configuration?.setPromptSuggestionEnabled || !configuration.getPromptSuggestionEnabled) {
      throw new Error("Prompt suggestion setting is unavailable");
    }

    await expect(configuration.getPromptSuggestionEnabled()).resolves.toBe(true);
    await expect(configuration.setPromptSuggestionEnabled({ enabled: false })).resolves.toBe(false);
    expect(updateConfig).toHaveBeenCalledWith({ field: "promptSuggestion.enabled", set: false });
    await expect(configuration.getPromptSuggestionEnabled()).resolves.toBe(false);
  });
});


describe('v1 Agent reference compatibility', () => {
  function resolver(overrides: Partial<AgentReferenceResolver> = {}): AgentReferenceResolver {
    return {
      resolveAgentReadScope: vi.fn(async (requestedName: string) => ({
        requestedName,
        canonicalName: "coder",
        primaryName: "mavis",
        compatibleNames: ["coder"],
        exact: true,
        source: "explicit_agent" as const,
        exactOwnerName: "coder",
      })),
      resolveAgentWriteTarget: vi.fn(async () => "coder"),
      requireExactAgentKey: vi.fn(async () => "coder"),
      resolveAgentExecutionTarget: vi.fn(async () => "coder"),
      ...overrides,
    };
  }

  function resolveDelegatable(
    targetResolver: AgentReferenceResolver,
    requestRef: string,
  ) {
    return createCompatibility()
      .createServiceCompatibility(
        createdHost({ agentResolver: targetResolver }),
        { dataDir: "/tmp/runtime" } as CreateLocalRuntimeHostOptions,
      )
      .agentReferences.resolveDelegatable(requestRef);
  }

  it("uses the complete Task resolver chain for a delegatable roster target", async () => {
    const targetResolver = resolver();

    await expect(
      resolveDelegatable(targetResolver, "agent:coder"),
    ).resolves.toBe("authorized");
    expect(targetResolver.resolveAgentReadScope).toHaveBeenCalledWith(
      "agent:coder",
    );
    expect(targetResolver.resolveAgentWriteTarget).toHaveBeenCalledWith(
      "agent:coder",
    );
    expect(targetResolver.requireExactAgentKey).toHaveBeenCalledWith("coder");
    expect(targetResolver.resolveAgentExecutionTarget).toHaveBeenCalledWith(
      "coder",
    );
  });

  it("rejects the canonical primary/self target before Task resolution", async () => {
    const targetResolver = resolver({
      resolveAgentReadScope: vi.fn(async (requestedName: string) => ({
        requestedName,
        canonicalName: "mavis",
        primaryName: "mavis",
        compatibleNames: ["mavis", "main"],
        exact: true,
        source: "explicit_agent" as const,
        exactOwnerName: "mavis",
      })),
    });

    await expect(
      resolveDelegatable(targetResolver, "agent:mavis"),
    ).resolves.toBe("unauthorized");
    expect(targetResolver.resolveAgentWriteTarget).not.toHaveBeenCalled();
    expect(targetResolver.requireExactAgentKey).not.toHaveBeenCalled();
    expect(targetResolver.resolveAgentExecutionTarget).not.toHaveBeenCalled();
  });

  it("fails closed when the trusted roster resolver cannot resolve a target", async () => {
    const targetResolver = resolver({
      resolveAgentReadScope: vi.fn(async () => {
        throw Object.assign(new Error("missing"), { code: "AGENT_NOT_FOUND" });
      }),
    });

    await expect(
      resolveDelegatable(targetResolver, "agent:missing"),
    ).resolves.toBe("unknown");
    expect(targetResolver.resolveAgentWriteTarget).not.toHaveBeenCalled();
  });
});

describe("v1 runtime compatibility Task recovery", () => {
  beforeEach(() => {
    resetRuntimeCompatibilityMocks();
    mocked.closeAgentDb.mockReset();
    mocked.inspectCollision.mockReset();
    mocked.applyCollision.mockReset();
  });

  it("binds task ownership and forwards exact recovered Turn evidence to the Task service", async () => {
    const bindRuntimeOwner = vi.fn();
    const reconcileStartupLostTasks = vi.fn(async () => []);
    const compatibility = createCompatibility();
    const host = createdHost({
      backgroundTaskService: {
        bindRuntimeOwner,
        reconcileStartupLostTasks,
        hasPendingStartupRecovery: () => true,
        pollStartupLostTasks: async () => false,
      },
    });
    const service = compatibility.createServiceCompatibility(host, {
      dataDir: "/tmp/runtime",
      runtimeOwnerKind: "tui",
    });
    const owner = {
      ownerId: "background-task:current",
      isOwnerAlive: () => true,
    };
    service.backgroundTasks.bindRuntimeOwner(owner);
    await expect(
      service.backgroundTasks.recover(["turn-recovered"]),
    ).resolves.toBe(true);
    await expect(service.backgroundTasks.pollRecovery()).resolves.toBe(false);
    expect(bindRuntimeOwner).toHaveBeenCalledWith(owner);
    expect(reconcileStartupLostTasks).toHaveBeenCalledWith({
      recoveredTurnIds: ["turn-recovered"],
    });
  });
});

describe("v1 runtime compatibility host composition", () => {
  beforeEach(() => {
    resetRuntimeCompatibilityMocks();
    mocked.closeAgentDb.mockReset();
    mocked.inspectCollision.mockReset();
    mocked.applyCollision.mockReset();
  });

  it.each([
    { kind: "cli", embedded: true, enabled: false },
    { kind: "tui", embedded: true, enabled: false },
    { kind: "cli", embedded: false, enabled: false },
    { kind: "tui", embedded: false, enabled: false },
    { kind: "electron", embedded: true, enabled: false },
    { kind: "diagnostic", embedded: true, enabled: false },
  ] as const)(
    "disables built-in Matrix while retaining configured MCP for $kind / embedded=$embedded",
    ({ kind, embedded, enabled }) => {
      const compatibility = createCompatibility();
      const host = createdHost({
        configGetter: () => ({ beta: { mcodeTools: true } }),
      });
      const services = compatibility.createServiceCompatibility(host, {
        dataDir: "/tmp/runtime",
        runtimeOwnerKind: kind,
        capabilities: { cliEmbedded: embedded },
        enableLiveMcp: true,
      });
      expect(services.mcp).toMatchObject({
        enableLiveMcp: true,
        builtinMatrix: enabled,
        matrixWebSearchOnly: false,
      });
    },
  );

  it("caps the background task listing at 100 results", async () => {
    const tasks = Array.from({ length: 101 }, (_, index) => ({
      taskId: `bg-${index}`,
      kind: "bash" as const,
      status: "running" as const,
      ownerSessionId: "session-1",
      createdAt: 100,
      updatedAt: 200,
    }));
    const services = createCompatibility().createServiceCompatibility(
      createdHost({
        backgroundTaskService: {
          list: async ({ limit }: { limit: number }) => ({
            items: tasks.slice(0, limit),
          }),
        },
      }),
      { dataDir: "/tmp/runtime", runtimeOwnerKind: "cli" },
    );

    await expect(
      services.peripherals.backgroundTasks.list({
        ownerSessionId: "session-1",
        limit: 200,
      }),
    ).resolves.toEqual(tasks.slice(0, 100));
  });

  it("routes Agent cleanup through the bound V2 Cron owner", async () => {
    const compatibility = createCompatibility();
    const configured = compatibility.configureHostOptions(
      { dataDir: "/tmp/runtime" } as CreateLocalRuntimeHostOptions,
      mocked.agentResolver,
      preparedPorts(),
    );
    const services = compatibility.createServiceCompatibility(createdHost({}), {
      dataDir: "/tmp/runtime",
    } as CreateLocalRuntimeHostOptions);
    const cron = { deleteDefinitionsByAgent: vi.fn() };

    services.cron.bindAgentCleanup(cron);
    await configured.deleteAgentCronTasks?.("coder");

    expect(mocked.cleanupBindCalls).toEqual([cron]);
    expect(mocked.deleteAgentCronTasks).toHaveBeenCalledWith("coder");
  });
});

describe("v1 background Task notification projection", () => {
  beforeEach(resetRuntimeCompatibilityMocks);

  it("settles a terminal Task as soon as its notification is bound to a still-running Turn", async () => {
    const tasks = [
      {
        taskId: "bg-done",
        kind: "subagent" as const,
        status: "succeeded" as const,
        ownerSessionId: "session-1",
        createdAt: 100,
        updatedAt: 200,
      },
      {
        taskId: "bg-running",
        kind: "bash" as const,
        status: "running" as const,
        ownerSessionId: "session-1",
        createdAt: 100,
        updatedAt: 200,
      },
    ];
    const services = createCompatibility().createServiceCompatibility(
      createdHost({
        backgroundTaskService: { list: async () => ({ items: tasks }) },
      }),
      { dataDir: "/tmp/runtime", runtimeOwnerKind: "tui" },
    );
    const findClientRequestBindings = vi.fn(async () => [
      {
        clientRequestId: "background-task-notification:bg-done",
        turnId: "turn-delivery",
      },
    ]);
    services.backgroundTasks.bindNotificationReceipts({
      findClientRequestBindings,
    });

    await expect(
      services.peripherals.backgroundTasks.list({
        ownerSessionId: "session-1",
      }),
    ).resolves.toEqual(tasks);
    expect(findClientRequestBindings).not.toHaveBeenCalled();

    await expect(
      services.peripherals.backgroundTasks.list({
        ownerSessionId: "session-1",
        includeNotification: true,
      }),
    ).resolves.toEqual([
      {
        ...tasks[0],
        notification: { state: "settled", turnId: "turn-delivery" },
      },
      tasks[1],
    ]);
    expect(findClientRequestBindings).toHaveBeenCalledWith({
      sessionId: "session-1",
      clientRequestIds: ["background-task-notification:bg-done"],
    });
  });

  it("settles an unbound notification from a completed read or a user stop", async () => {
    mocked.suppressedDeliveryTaskIds.clear();
    mocked.suppressedDeliveryTaskIds.add("stopped");
    const task = (taskId: string, overrides: Record<string, unknown> = {}) => ({
      taskId,
      kind: "bash" as const,
      status: "succeeded" as const,
      ownerSessionId: "session-1",
      createdAt: 100,
      updatedAt: 200,
      ...overrides,
    });
    const tasks = [
      task("read", { deliveredAt: 300 }),
      task("stopped", { status: "canceled" }),
      task("pending", { status: "failed" }),
    ];
    const services = createCompatibility().createServiceCompatibility(
      createdHost({
        backgroundTaskService: { list: async () => ({ items: tasks }) },
      }),
      { dataDir: "/tmp/runtime", runtimeOwnerKind: "tui" },
    );
    const query = { ownerSessionId: "session-1", includeNotification: true };

    await expect(
      services.peripherals.backgroundTasks.list(query),
    ).resolves.toEqual(tasks);

    services.backgroundTasks.bindNotificationReceipts({
      findClientRequestBindings: async () => [],
    });
    const annotated = await services.peripherals.backgroundTasks.list(query);

    expect(
      annotated.map((entry) => [entry.taskId, entry.notification]),
    ).toEqual([
      ["read", { state: "settled" }],
      ["stopped", { state: "settled" }],
      ["pending", { state: "pending" }],
    ]);
  });

  it("lists Tasks with an unknown notification state when the Turn ledger cannot be read", async () => {
    const tasks = [
      {
        taskId: "bg-done",
        kind: "bash" as const,
        status: "succeeded" as const,
        ownerSessionId: "session-1",
        createdAt: 100,
        updatedAt: 200,
      },
    ];
    const warn = vi.fn();
    const services = createCompatibility().createServiceCompatibility(
      createdHost({
        backgroundTaskService: { list: async () => ({ items: tasks }) },
        matrixLogger: { info: vi.fn(), warn },
      }),
      { dataDir: "/tmp/runtime", runtimeOwnerKind: "tui" },
    );
    services.backgroundTasks.bindNotificationReceipts({
      findClientRequestBindings: async () => {
        throw new Error("database is locked");
      },
    });

    await expect(
      services.peripherals.backgroundTasks.list({
        ownerSessionId: "session-1",
        includeNotification: true,
      }),
    ).resolves.toEqual(tasks);
    expect(warn).toHaveBeenCalledWith(
      { sessionId: "session-1", turnId: "background-task-notification" },
      expect.stringContaining("database is locked"),
    );
  });
});

describe("v1 runtime compatibility seams", () => {
  beforeEach(() => {
    resetRuntimeCompatibilityMocks();
    mocked.closeAgentDb.mockReset();
    mocked.inspectCollision.mockReset();
    mocked.applyCollision.mockReset();
  });

  it("shares one deferred conversation bridge across host options and service binding", async () => {
    const compatibility = createCompatibility();
    const configured = compatibility.configureHostOptions(
      { dataDir: "/tmp/runtime" } as CreateLocalRuntimeHostOptions,
      mocked.agentResolver,
      preparedPorts(),
    );
    const serviceCompatibility = compatibility.createServiceCompatibility(
      createdHost({
        subscribeGlobalEvents: vi.fn(() => () => undefined),
      }),
      { dataDir: "/tmp/runtime" } as CreateLocalRuntimeHostOptions,
    );
    const pending =
      configured.runtimeConversation?.query.getSession("session-1");
    const provider = {
      query: {
        getSession: vi.fn(async () => undefined),
        listSessions: vi.fn(async () => []),
        listMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
      },
      lifecycle: {},
      ingress: {},
      maintenance: {},
    } as never;

    await serviceCompatibility.conversation.bind(provider);

    await expect(pending).resolves.toBeUndefined();
    compatibility.shutdownConversation(new Error("runtime close"));
    await expect(
      configured.runtimeConversation?.query.listSessions(),
    ).rejects.toMatchObject({
      code: "RUNTIME_CONVERSATION_SHUTDOWN",
    });
  });

  it("reconciles persisted Goal kickoffs before exposing the conversation provider", async () => {
    const compatibility = createCompatibility();
    const configured = compatibility.configureHostOptions(
      { dataDir: "/tmp/runtime" } as CreateLocalRuntimeHostOptions,
      mocked.agentResolver,
      preparedPorts(),
    );
    const recovery = deferred();
    const recoverThreadGoalKickoffs = vi.fn(async () => recovery.promise);
    const serviceCompatibility = compatibility.createServiceCompatibility(
      createdHost({
        subscribeGlobalEvents: vi.fn(() => () => undefined),
        recoverThreadGoalKickoffs,
      }),
      { dataDir: "/tmp/runtime" } as CreateLocalRuntimeHostOptions,
    );
    const getSession = vi.fn(async () => undefined);
    const provider = {
      query: {
        getSession,
        listSessions: vi.fn(async () => []),
        listMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
      },
      lifecycle: {},
      ingress: {},
      maintenance: {},
    } as never;
    const pendingQuery =
      configured.runtimeConversation?.query.getSession("session-1");

    const binding = serviceCompatibility.conversation.bind(provider);
    await Promise.resolve();

    expect(recoverThreadGoalKickoffs).toHaveBeenCalledWith(provider);
    expect(getSession).not.toHaveBeenCalled();

    recovery.resolve();
    await binding;
    await expect(pendingQuery).resolves.toBeUndefined();
    expect(getSession).toHaveBeenCalledWith("session-1");
  });

  it("does not expose model catalog or provider ownership through v1 compatibility", () => {
    const services = createCompatibility().createServiceCompatibility(
      createdHost({}),
      {
        dataDir: "/tmp/runtime",
      } as CreateLocalRuntimeHostOptions,
    );

    expect(services.peripherals).not.toHaveProperty("models");
    expect(services.peripherals).not.toHaveProperty("modelProviders");
  });
});

describe("v1 runtime compatibility adapters and cleanup", () => {
  beforeEach(resetRuntimeCompatibilityMocks);

  it("injects a write-only global event publisher and detaches it without subscribing to v1", () => {
    const compatibility = createCompatibility();
    const configured = compatibility.configureHostOptions(
      { dataDir: "/tmp/runtime" } as CreateLocalRuntimeHostOptions,
      mocked.agentResolver,
      preparedPorts(),
    );
    const apiHost = { subscribeGlobalEvents: vi.fn(() => () => undefined) };
    const host = createdHost(apiHost);
    const publish = vi.fn();
    const event = {
      type: "session.deleted" as const,
      payload: { sessionId: "session-1" },
    };

    const events = compatibility.createServiceCompatibility(host, {
      dataDir: "/tmp/runtime",
    } as CreateLocalRuntimeHostOptions).events;
    const unbind = events.bindPublisher(publish);
    configured.globalEventPublisher?.(event);
    unbind();
    configured.globalEventPublisher?.({
      type: "session.deleted",
      payload: { sessionId: "late-session" },
    });

    expect(apiHost.subscribeGlobalEvents).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(event);
  });
});

describe("v1 safety compatibility", () => {
  it("keeps the concrete content-safety transport in the v1 compatibility seam", () => {
    const compatibility = createCompatibility();
    const contentSafetyChecker = vi.fn(async () => ({ pass: true as const }));
    const services = compatibility.createServiceCompatibility(
      createdHost({ contentSafetyChecker }),
      { dataDir: "/tmp/runtime" } as CreateLocalRuntimeHostOptions,
    );

    expect(services.safety.review).toBe(contentSafetyChecker);
  });
});

describe("v1 runtime cleanup", () => {
  it("best-effort cleans every acquired v1 resource in dependency order", async () => {
    const events: string[] = [];
    const warnings: string[] = [];
    const v1 = {
      apiHost: {
        cronRuntime: { stop: () => events.push("cron") },
        shutdownChannelSubsystem: () => {
          events.push("channels");
          throw new Error("channel cleanup failed");
        },
      },
      metricsClient: { close: () => events.push("metrics") },
    } as unknown as CreatedLocalRuntimeHost;

    await cleanupFailedV1Startup(
      v1,
      async () => {
        events.push("close");
      },
      (step) => warnings.push(step),
    );

    expect(events).toEqual(["cron", "channels", "close", "metrics"]);
    expect(warnings).toEqual(["stop_channels"]);
  });

  it("continues cleanup when the warning reporter throws", async () => {
    const events: string[] = [];
    const v1 = {
      apiHost: {
        cronRuntime: {
          stop: () => {
            events.push("cron");
            throw new Error("cron cleanup failed");
          },
        },
        shutdownChannelSubsystem: () => events.push("channels"),
      },
      metricsClient: { close: () => events.push("metrics") },
    } as unknown as CreatedLocalRuntimeHost;

    await cleanupFailedV1Startup(
      v1,
      async () => {
        events.push("close");
      },
      () => {
        throw new Error("warning reporter failed");
      },
    );

    expect(events).toEqual(["cron", "channels", "close", "metrics"]);
  });
});

describe("v1 Agent telemetry compatibility", () => {
  it("bridges Agent facts to v1 telemetry and remains fail-open", () => {
    const counter = vi.fn();
    const gauge = vi.fn();
    const histogram = vi.fn();
    const emitBusEvent = vi.fn();
    const telemetry = createDeferredAgentRuntimeTelemetry();
    telemetry.bind({
      metricsClient: { counter, gauge, histogram },
      emitBusEvent,
    });

    telemetry.facts.onNameCompatResolve?.({
      intent: "read",
      canonicalClass: "worker",
      source: "canonical_name",
      success: true,
      memberCountBucket: "2",
    });
    telemetry.facts.onAgentRoleObservation?.({
      status: "unsupported",
      source: "sqlite_decode",
      role: "worker",
    });

    expect(counter).toHaveBeenCalledWith("agent_name_compat_resolve_total", 1, {
      intent: "read",
      canonical_class: "worker",
      source: "canonical_name",
      success: "true",
      member_count_bucket: "2",
    });
    expect(counter).toHaveBeenCalledWith("agent_role_observation_total", 1, {
      status: "unsupported",
      source: "sqlite_decode",
      role_class: "worker",
    });
    expect(emitBusEvent).toHaveBeenCalledWith("agent_name_compat.resolve", {
      intent: "read",
      canonical_class: "worker",
      source: "canonical_name",
      success: true,
      member_count_bucket: "2",
    });

    const failingTelemetry = createDeferredAgentRuntimeTelemetry();
    failingTelemetry.bind({
      metricsClient: {
        counter: () => {
          throw new Error("metrics unavailable");
        },
        gauge: () => {
          throw new Error("metrics unavailable");
        },
        histogram: () => {
          throw new Error("metrics unavailable");
        },
      },
      emitBusEvent: () => {
        throw new Error("event bus unavailable");
      },
    });
    expect(() => {
      failingTelemetry.facts.onNameCompatResolve?.({
        intent: "write",
        canonicalClass: "other",
        source: "explicit_agent",
        success: false,
      });
      failingTelemetry.facts.onAgentRoleObservation?.({
        status: "missing",
        source: "builtin_seed",
        role: undefined,
      });
      failingTelemetry.close();
      failingTelemetry.facts.onNameCompatResolve?.({
        intent: "read",
        canonicalClass: "other",
        source: "stable_name",
        success: true,
      });
    }).not.toThrow();
  });
});

const goal: ThreadGoalState = {
  goalId: "goal-1",
  sessionId: "session-1",
  objective: "Ship Goal support",
  status: "active",
  createdAt: 10,
  updatedAt: 20,
  tokensUsed: 4,
  turnsUsed: 1,
  timeUsedSeconds: 2,
  tokenBudget: null,
  replyFingerprint: "reply-fingerprint",
  noProgressStreak: 0,
  noToolStreak: 0,
  lastVerification: {
    v: 1,
    backend: "evaluator",
    verdict: "not_met",
    reason: "Acceptance evidence is still missing.",
    missing: ["focused test evidence"],
    notMetStreak: 1,
    turnId: "turn-1",
    objectiveDigest: "objective-digest",
    at: 20,
  },
  statusReason: null,
  kickoffAttachments: [],
  kickoffState: "consumed",
  executionWait: null,
};

function createThreadGoalFixture() {
  const isReadOnlyLegacySession = vi.fn(async () => false);
  const store = {
    create: vi.fn(
      async (_input: Parameters<ThreadGoalStore["create"]>[0]) => goal,
    ),
    getBySession: vi.fn(async () => goal),
    patch: vi.fn(async (_goalId: string, patch: Partial<ThreadGoalState>) => ({
      ...goal,
      ...patch,
    })),
    delete: vi.fn(async () => undefined),
  };
  const integration = {
    isEnabled: vi.fn(() => true),
    store,
    getGoalForResponse: vi.fn<ThreadGoalIntegration["getGoalForResponse"]>(
      async () => goal,
    ),
    createGoal: vi.fn(
      async (
        input: Parameters<ThreadGoalStore["create"]>[0],
        _options?: { readonly requireKickoffAdmission?: boolean },
      ) => store.create(input),
    ),
    patchGoal: vi.fn<ThreadGoalIntegration["patchGoal"]>(
      async (_sessionId: string, patch: Partial<ThreadGoalState>) => ({
        ...goal,
        ...patch,
      }),
    ),
    deleteGoal: vi.fn(async (_sessionId: string) => true),
    handleChanged: vi.fn(),
  };
  const application = createCompatibility().createServiceCompatibility(
    createdHost(
      {
        threadGoal: integration,
        isReadOnlyLegacySession,
        skillService: { listRuntimeSkills: async () => ({ skills: [] }) },
        skillHubStore: {
          getInstalledIdentities: async () => ({
            names: new Set<string>(),
            sourceUrls: new Set<string>(),
          }),
        },
      },
      {
        metricsClient: {},
        mcpService: { listServers: async () => [] },
      },
    ),
    { dataDir: "/tmp/runtime" } as CreateLocalRuntimeHostOptions,
  ).peripherals.goals;
  return {
    application,
    integration,
    isReadOnlyLegacySession,
    store,
  };
}

describe("createThreadGoalApplication", () => {
  it("creates and reads the Runtime-owned Goal without a transport hop", async () => {
    const fixture = createThreadGoalFixture();

    await expect(
      fixture.application.create({
        sessionId: " session-1 ",
        objective: " Ship Goal support ",
        tokenBudget: 50_000,
        kickoffAttachments: [
          {
            type: "file",
            filePath: "/repo/spec.md",
            fileName: "spec.md",
            mimeType: "text/markdown",
          },
        ],
      }),
    ).resolves.toMatchObject({
      goalId: "goal-1",
      status: "active",
      turnsUsed: 1,
      statusReason: null,
      lastVerification: {
        backend: "evaluator",
        verdict: "not_met",
        missing: ["focused test evidence"],
      },
    });
    expect(fixture.store.create).toHaveBeenCalledWith({
      sessionId: "session-1",
      objective: "Ship Goal support",
      tokenBudget: 50_000,
      kickoffAttachments: [expect.objectContaining({ fileName: "spec.md" })],
    });
    expect(fixture.integration.createGoal).toHaveBeenCalledWith(
      {
        sessionId: "session-1",
        objective: "Ship Goal support",
        tokenBudget: 50_000,
        kickoffAttachments: [expect.objectContaining({ fileName: "spec.md" })],
      },
      { requireKickoffAdmission: true },
    );

    await expect(fixture.application.get("session-1")).resolves.toMatchObject({
      objective: "Ship Goal support",
      hasKickoffAttachments: false,
    });
  });

  it("omits the verification result until the Runtime has produced one", async () => {
    const fixture = createThreadGoalFixture();
    fixture.integration.getGoalForResponse
      .mockResolvedValueOnce({ ...goal, lastVerification: undefined })
      .mockResolvedValueOnce(undefined);

    const projected = await fixture.application.get("session-1");
    expect(projected).not.toHaveProperty("lastVerification");
    await expect(fixture.application.get("session-1")).resolves.toBeUndefined();
  });

  it("rejects an empty Goal session id before reaching the Runtime integration", async () => {
    const fixture = createThreadGoalFixture();

    await expect(fixture.application.get("   ")).rejects.toThrow(
      "sessionId is required.",
    );
    expect(fixture.integration.getGoalForResponse).not.toHaveBeenCalled();
  });

  it("uses Desktop soft-fail kickoff admission for a text-only Goal", async () => {
    const fixture = createThreadGoalFixture();

    await expect(
      fixture.application.create({
        sessionId: "session-1",
        objective: "Ship without attachments",
      }),
    ).resolves.toMatchObject({ goalId: "goal-1", status: "active" });

    expect(fixture.integration.createGoal).toHaveBeenCalledWith({
      sessionId: "session-1",
      objective: "Ship without attachments",
    });
  });

  it("uses live projection for resume and publishes edit and clear changes", async () => {
    const fixture = createThreadGoalFixture();
    const resumed = { ...goal, status: "active" as const, timeUsedSeconds: 12 };
    fixture.integration.patchGoal.mockResolvedValueOnce(resumed);

    await expect(
      fixture.application.patch("session-1", { status: "active" }),
    ).resolves.toMatchObject({
      status: "active",
      timeUsedSeconds: 12,
    });
    expect(fixture.integration.patchGoal).toHaveBeenCalledWith("session-1", {
      status: "active",
    });

    await fixture.application.patch("session-1", {
      objective: "New objective",
      tokenBudget: null,
    });
    expect(fixture.integration.patchGoal).toHaveBeenLastCalledWith(
      "session-1",
      {
        objective: "New objective",
        tokenBudget: null,
      },
    );

    await fixture.application.patch("session-1", { tokenBudget: 75_000 });
    expect(fixture.integration.patchGoal).toHaveBeenLastCalledWith(
      "session-1",
      {
        tokenBudget: 75_000,
      },
    );

    await expect(fixture.application.clear("session-1")).resolves.toBe(true);
    expect(fixture.integration.deleteGoal).toHaveBeenCalledWith("session-1");
  });

  it("rejects a Goal patch after all mutable fields are omitted", async () => {
    const fixture = createThreadGoalFixture();

    await expect(fixture.application.patch("session-1", {})).rejects.toThrow(
      "Goal patch must include status, objective, or tokenBudget.",
    );
    expect(fixture.integration.patchGoal).not.toHaveBeenCalled();
  });

  it("preserves objective validation and the missing-Goal patch contract", async () => {
    const fixture = createThreadGoalFixture();

    await expect(
      fixture.application.patch("session-1", { objective: "   " }),
    ).rejects.toThrow("goal objective must not be empty");

    fixture.integration.patchGoal.mockResolvedValueOnce(undefined);
    await expect(
      fixture.application.patch("session-1", { objective: "still shipping" }),
    ).rejects.toMatchObject({
      status: 404,
      code: "GOAL_NOT_FOUND",
      message: "Goal not found for session: session-1",
    });
  });

  it("reports the Desktop GOAL_NOT_FOUND contract when clear loses the Goal race", async () => {
    const fixture = createThreadGoalFixture();
    fixture.integration.deleteGoal.mockResolvedValue(false);

    await expect(fixture.application.clear("session-1")).rejects.toMatchObject({
      status: 404,
      code: "GOAL_NOT_FOUND",
      message: "Goal not found for session: session-1",
    });
  });

  it("rejects every Goal mutation for a read-only legacy session", async () => {
    const fixture = createThreadGoalFixture();
    fixture.isReadOnlyLegacySession.mockResolvedValue(true);

    await expect(
      fixture.application.create({
        sessionId: "session-1",
        objective: "Do not mutate legacy state",
      }),
    ).rejects.toThrow("read-only");
    await expect(
      fixture.application.patch("session-1", { status: "paused" }),
    ).rejects.toThrow("read-only");
    await expect(fixture.application.clear("session-1")).rejects.toThrow(
      "read-only",
    );

    expect(fixture.isReadOnlyLegacySession).toHaveBeenCalledTimes(3);
    expect(fixture.integration.createGoal).not.toHaveBeenCalled();
    expect(fixture.integration.patchGoal).not.toHaveBeenCalled();
    expect(fixture.integration.deleteGoal).not.toHaveBeenCalled();
  });

  it("fails closed when Thread Goal is disabled", async () => {
    const fixture = createThreadGoalFixture();
    fixture.integration.isEnabled.mockReturnValue(false);

    expect(fixture.application.isEnabled()).toBe(false);
    await expect(fixture.application.get("session-1")).rejects.toThrow(
      "disabled",
    );
    expect(fixture.integration.getGoalForResponse).not.toHaveBeenCalled();
  });
});

function createCompatibility() {
  const compatibility = createV1RuntimeCompatibility(
    new DeferredRuntimeConversation(),
    {
      createQuestionnaireService: () =>
        ({ marker: "questionnaire-service" }) as never,
    },
  );
  return {
    ...compatibility,
    createServiceCompatibility: (
      host: CreatedLocalRuntimeHost,
      options: CreateLocalRuntimeHostOptions,
    ) => compatibility.createServiceCompatibility(host, options),
  };
}

function preparedPorts() {
  return {
    skillEnabledState: {
      getDisabledLocationUris: vi.fn(async () => new Set<string>()),
      setEnabled: vi.fn(async () => undefined),
      forget: vi.fn(async () => undefined),
    },
    runLegacyImCredentialMigration: vi.fn(async (action: () => Promise<void>) =>
      action(),
    ),
    cliSunsetNotice: {
      evaluate: vi.fn(async () => undefined),
    },
  };
}

function createdHost(
  apiHost: object,
  host: object = {},
): CreatedLocalRuntimeHost {
  return {
    dataDir: "/tmp/runtime",
    apiHost: {
      configGetter: () => ({ promptConfig: { autoUpdate: false } }),
      recoverThreadGoalKickoffs: async () => undefined,
      contentSafetyChecker: vi.fn(async () => ({ pass: true })),
      bindQuestionnaireOwnedActionHandler: vi.fn(),
      questionnaireServiceDeps: () => ({
        store: {},
        nowMs: Date.now,
        primaryAgentName: "mavis",
        configGetter: () => ({}),
        getSessionById: vi.fn(),
        startUserMessageTurn: vi.fn(),
        emitBusEvent: vi.fn(),
        publishGlobalEvent: vi.fn(),
      }),
      ...apiHost,
    },
    ...host,
  } as unknown as CreatedLocalRuntimeHost;
}

function deferred() {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}
