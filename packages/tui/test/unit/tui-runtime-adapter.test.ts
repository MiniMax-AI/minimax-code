import { describe, expect, it, vi } from "vitest";
import { TuiRuntimeAdapter } from "../../src/runtime/adapter.js";

describe("TuiRuntimeAdapter process-local facades", () => {
  it("projects active and recent terminal Runtime background work for the current Session", async () => {
    const listBackgroundTasks = vi.fn(
      async (input: { statuses?: readonly string[] }) =>
        input.statuses?.includes("succeeded")
          ? [
              {
                taskId: "bg-failed",
                kind: "bash" as const,
                status: "failed" as const,
                ownerSessionId: "session-1",
                description: "build docs",
                metadata: { command: "pnpm build\necho complete" },
                createdAt: 100,
                updatedAt: 300,
                startedAt: 120,
                endedAt: 280,
                lastError: { message: "exit code 1" },
              },
              {
                taskId: "bg-delivered",
                kind: "bash" as const,
                status: "succeeded" as const,
                ownerSessionId: "session-1",
                description: "build docs successfully",
                createdAt: 90,
                updatedAt: 250,
                startedAt: 100,
                endedAt: 220,
                deliveredAt: 250,
              },
            ]
          : [
              {
                taskId: "bg-running",
                kind: "bash" as const,
                status: "running" as const,
                ownerSessionId: "session-1",
                description: "pnpm test",
                createdAt: 100,
                updatedAt: 200,
                startedAt: 110,
              },
            ],
    );
    const adapter = new TuiRuntimeAdapter({ listBackgroundTasks } as never);

    await expect(adapter.listBackgroundTasks("session-1")).resolves.toEqual([
      {
        taskId: "bg-failed",
        kind: "bash",
        status: "failed",
        ownerSessionId: "session-1",
        description: "build docs",
        command: "pnpm build\necho complete",
        createdAtMs: 100,
        updatedAtMs: 300,
        startedAtMs: 120,
        endedAtMs: 280,
        lastError: "exit code 1",
      },
      {
        taskId: "bg-delivered",
        kind: "bash",
        status: "succeeded",
        ownerSessionId: "session-1",
        description: "build docs successfully",
        createdAtMs: 90,
        updatedAtMs: 250,
        startedAtMs: 100,
        endedAtMs: 220,
        deliveredAtMs: 250,
      },
      {
        taskId: "bg-running",
        kind: "bash",
        status: "running",
        ownerSessionId: "session-1",
        description: "pnpm test",
        createdAtMs: 100,
        updatedAtMs: 200,
        startedAtMs: 110,
      },
    ]);
    expect(listBackgroundTasks).toHaveBeenNthCalledWith(1, {
      ownerSessionId: "session-1",
      statuses: ["queued", "running", "stopping"],
      kinds: ["bash", "workflow", "custom"],
      limit: 100,
    });
    expect(listBackgroundTasks).toHaveBeenNthCalledWith(2, {
      ownerSessionId: "session-1",
      statuses: ["succeeded", "failed", "canceled", "lost"],
      kinds: ["bash", "workflow", "custom"],
      limit: 100,
    });
  });

  it.each([undefined, null, 42, { source: "echo hidden" }])(
    "does not treat non-string command metadata as Bash source: %s",
    async (command) => {
      const adapter = new TuiRuntimeAdapter({
        listBackgroundTasks: vi.fn(async () => [
          {
            taskId: "legacy",
            kind: "bash",
            status: "succeeded",
            ownerSessionId: "root",
            description: "legacy command...",
            createdAt: 1,
            updatedAt: 2,
            metadata: { command },
          },
        ]),
      } as never);
      expect(await adapter.listBackgroundTasks("root")).toEqual([
        expect.objectContaining({ description: "legacy command..." }),
      ]);
      expect((await adapter.listBackgroundTasks("root"))[0]).not.toHaveProperty(
        "command",
      );
    },
  );

  it("reattaches a foreground Turn without asking resumeSession to drain the Queue", async () => {
    const cliService = {
      resumeSession: vi.fn(async () => ({
        ok: true as const,
        source: [{ dataJson: "[DONE]" }],
      })),
    };
    const adapter = new TuiRuntimeAdapter(cliService as never);
    const events = [];

    for await (const event of adapter.watchSessionTurn(
      "session-1",
      "turn-queued",
      new AbortController().signal,
      { afterMsgId: "message-1" },
    )) {
      events.push(event);
    }

    expect(cliService.resumeSession).toHaveBeenCalledWith(
      {
        id: "session-1",
        afterMsgId: "message-1",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(events).toEqual([{ type: "done", turnId: "turn-queued" }]);
  });

  it("uses the process-local Goal facade with TUI attachment snapshots", async () => {
    const goal = {
      goalId: "goal-1",
      sessionId: "session-1",
      objective: "Ship TUI Goal support",
      status: "active" as const,
      createdAt: 10,
      updatedAt: 20,
      tokensUsed: 0,
      turnsUsed: 0,
      timeUsedSeconds: 0,
      tokenBudget: null,
      statusReason: null,
      hasKickoffAttachments: true,
    };
    const cliService = {
      isGoalEnabled: vi.fn(() => true),
      getGoal: vi.fn(async () => goal),
      createGoal: vi.fn(async () => goal),
      patchGoal: vi.fn(async () => ({ ...goal, status: "paused" as const })),
      clearGoal: vi.fn(async () => true),
    };
    const adapter = new TuiRuntimeAdapter(cliService as never);

    expect(adapter.isGoalEnabled()).toBe(true);
    await expect(adapter.getGoal("session-1")).resolves.toBe(goal);
    await expect(
      adapter.createGoal({
        sessionId: "session-1",
        objective: goal.objective,
        tokenBudget: 50_000,
        attachments: [
          {
            type: "file",
            filePath: "/repo/spec.md",
            fileName: "spec.md",
            mimeType: "text/markdown",
            sizeBytes: 100,
          },
        ],
      }),
    ).resolves.toBe(goal);
    await expect(
      adapter.patchGoal("session-1", {
        status: "paused",
        tokenBudget: null,
      }),
    ).resolves.toMatchObject({ status: "paused" });
    await expect(adapter.clearGoal("session-1")).resolves.toBe(true);
    expect(cliService.createGoal).toHaveBeenCalledWith({
      sessionId: "session-1",
      objective: goal.objective,
      tokenBudget: 50_000,
      kickoffAttachments: [
        {
          type: "file",
          filePath: "/repo/spec.md",
          fileName: "spec.md",
          mimeType: "text/markdown",
        },
      ],
    });
    expect(cliService.patchGoal).toHaveBeenCalledWith("session-1", {
      status: "paused",
      tokenBudget: null,
    });
  });

  it("uses process-local questionnaire and permission facades", async () => {
    const cliService = {
      getPendingQuestionnaire: vi.fn(async () => ({
        request: {
          id: "question-1",
          schemaVersion: 2,
          presentation: {
            replaceComposer: true,
            showProgress: true,
            allowBackNavigation: true,
          },
          steps: [],
        },
      })),
      replyQuestionnaire: vi.fn(async () => ({ ok: true })),
      dismissQuestionnaire: vi.fn(async () => ({ ok: true })),
      listPendingPermissions: vi.fn(async () => ({
        requests: [
          {
            requestId: "permission-1",
            sessionId: "session-1",
            agentName: "mavis",
            toolName: "bash",
            ruleContents: ["pnpm test"],
            reason: "Run the relevant tests",
            allowAlwaysSupported: true,
            createdAt: 1,
          },
        ],
      })),
      replyPermission: vi.fn(async () => ({ success: true })),
    };
    const adapter = new TuiRuntimeAdapter(cliService as never);

    await expect(
      adapter.getPendingQuestionnaire("mavis", "session-1"),
    ).resolves.toMatchObject({
      id: "question-1",
    });
    await expect(
      adapter.replyQuestionnaire("mavis", "question-1", []),
    ).resolves.toBe(true);
    await expect(
      adapter.dismissQuestionnaire("mavis", "question-1"),
    ).resolves.toBe(true);
    await expect(adapter.listPendingPermissions()).resolves.toEqual([
      expect.objectContaining({ requestId: "permission-1" }),
    ]);
    await expect(
      adapter.replyPermission("mavis", "permission-1", "allowAlways"),
    ).resolves.toBe(true);
    expect(cliService.getPendingQuestionnaire).toHaveBeenCalledWith({
      name: "mavis",
      sessionId: "session-1",
    });
    expect(cliService.replyQuestionnaire).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "mavis",
        requestId: "question-1",
        answers: [],
        submittedAt: expect.any(Number),
      }),
    );
    expect(cliService.dismissQuestionnaire).toHaveBeenCalledWith({
      name: "mavis",
      requestId: "question-1",
    });
    expect(cliService.replyPermission).toHaveBeenCalledWith({
      name: "mavis",
      requestId: "permission-1",
      reply: 1,
    });
  });

  it("uses process-local product capability facades", async () => {
    const cliService = {
      listRuntimeSkills: vi.fn(async () => ({
        skills: [{ name: "docs", enabled: true }],
        refreshedAt: 123,
      })),
      listMcpServers: vi.fn(async () => ({
        servers: [{ name: "browser", enabled: true }],
      })),
      getSessionUsage: vi.fn(async () => ({
        summary: { totalTokens: 120, turns: 1 },
        rows: [],
      })),
      requestCompaction: vi.fn(async () => ({
        success: true,
        sessionId: "session-1",
        compactionId: "compact-1",
      })),
    };
    const adapter = new TuiRuntimeAdapter(cliService as never, {
      workspaceDir: "/workspace",
    });

    await expect(adapter.getSessionUsage("session-1")).resolves.toMatchObject({
      summary: { totalTokens: 120 },
    });
    await expect(
      adapter.requestCompaction("session-1", "mavis", "keep evidence"),
    ).resolves.toMatchObject({ success: true, compactionId: "compact-1" });
    await expect(adapter.listSkills("mavis", "docs")).resolves.toMatchObject({
      skills: [expect.objectContaining({ name: "docs" })],
      hasMore: false,
    });
    await expect(adapter.listMcpServers("browser")).resolves.toEqual([
      expect.objectContaining({ name: "browser" }),
    ]);

    expect(cliService.getSessionUsage).toHaveBeenCalledWith({
      id: "session-1",
    });
    expect(cliService.requestCompaction).toHaveBeenCalledWith({
      name: "mavis",
      id: "session-1",
      reason: "ui_request",
      customInstructions: "keep evidence",
    });
    expect(cliService.listRuntimeSkills).toHaveBeenCalledWith({
      agentName: "mavis",
      workspaceDir: "/workspace",
      includePluginSkills: true,
    });
    expect(cliService.listMcpServers).toHaveBeenCalledWith({
      keyword: "browser",
    });
  });

  it("projects Runtime-owned Plugin catalogs without exposing generated DTOs", async () => {
    const cliService = {
      listInstalledPlugins: vi.fn(async () => ({
        plugins: [
          {
            name: "docs",
            displayName: "Documents",
            source: 1,
            enabled: true,
            capabilities: { appCount: 0, mcpServerCount: 0, skillCount: 1 },
          },
          {
            name: "notes",
            source: 2,
            enabled: false,
            capabilities: { appCount: 0, mcpServerCount: 1, skillCount: 0 },
          },
          {
            name: "unknown",
            source: 999,
            enabled: true,
            capabilities: { appCount: 0, mcpServerCount: 0, skillCount: 0 },
          },
        ],
        hasMore: false,
      })),
      listMarketplacePlugins: vi.fn(async () => ({
        plugins: [
          {
            name: "calendar",
            displayName: "Calendar",
            installExists: false,
            enabled: false,
            capabilities: { appCount: 1, mcpServerCount: 0, skillCount: 0 },
          },
        ],
        hasMore: false,
      })),
    };
    const adapter = new TuiRuntimeAdapter(cliService as never);

    await expect(
      adapter.listInstalledPlugins({ marketplace: "official" }),
    ).resolves.toEqual([
      {
        pluginId: "docs@official",
        name: "docs",
        displayName: "Documents",
        marketplace: "official",
        installed: true,
        enabled: true,
        capabilities: { appCount: 0, mcpServerCount: 0, skillCount: 1 },
      },
    ]);
    await expect(
      adapter.listMarketplacePlugins({ marketplace: "local" }),
    ).resolves.toEqual([
      {
        pluginId: "calendar@local",
        name: "calendar",
        displayName: "Calendar",
        marketplace: "local",
        installed: false,
        enabled: false,
        capabilities: { appCount: 1, mcpServerCount: 0, skillCount: 0 },
      },
    ]);
    expect(cliService.listInstalledPlugins).toHaveBeenCalledWith({
      limit: 200,
    });
    expect(cliService.listMarketplacePlugins).toHaveBeenCalledWith({
      source: 2,
      limit: 200,
    });
  });

  it("routes Plugin mutations and refresh through CliService", async () => {
    const cliService = {
      installPlugin: vi.fn(async () => ({
        installExists: true,
        enabled: true,
      })),
      disablePlugin: vi.fn(async () => ({
        installExists: true,
        enabled: false,
      })),
      uninstallPlugin: vi.fn(async () => ({
        installExists: false,
        enabled: false,
      })),
      refreshPlugins: vi.fn(async () => undefined),
    };
    const adapter = new TuiRuntimeAdapter(cliService as never);

    await expect(
      adapter.mutatePlugin({
        action: "install",
        plugin: { name: "docs", marketplace: "official" },
      }),
    ).resolves.toEqual({ installed: true, enabled: true });
    await expect(
      adapter.mutatePlugin({
        action: "disable",
        plugin: { name: "notes", marketplace: "local" },
      }),
    ).resolves.toEqual({ installed: true, enabled: false });
    await expect(
      adapter.mutatePlugin({
        action: "remove",
        plugin: { name: "notes", marketplace: "local" },
      }),
    ).resolves.toEqual({ installed: false, enabled: false });
    await expect(adapter.refreshPlugins()).resolves.toBeUndefined();

    expect(cliService.installPlugin).toHaveBeenCalledWith({
      pluginName: "docs",
      source: 1,
    });
    expect(cliService.disablePlugin).toHaveBeenCalledWith({
      pluginName: "notes",
      source: 2,
    });
    expect(cliService.uninstallPlugin).toHaveBeenCalledWith({
      pluginName: "notes",
      source: 2,
    });
    expect(cliService.refreshPlugins).toHaveBeenCalledOnce();
  });

  it("reads Runtime events through CliService", async () => {
    const cliService = {
      watchEvents: vi.fn(async function* watchEvents() {
        yield {
          type: "permission.ask",
          timestamp: 123,
          source: "local-runtime",
          payload: { requestId: "permission-1", sessionId: "session-1" },
        };
      }),
    };
    const adapter = new TuiRuntimeAdapter(cliService as never);

    const events = [];
    for await (const event of adapter.watchEvents(
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "permission.ask",
        timestampMs: 123,
        source: "local-runtime",
        sessionId: "session-1",
        request: { requestId: "permission-1", sessionId: "session-1" },
      },
    ]);
    expect(cliService.watchEvents).toHaveBeenCalledOnce();
  });

  it("exposes the session-mutation Runtime facade through the adapter", async () => {
    const cliService = {
      listSessionInputSummaries: vi
        .fn()
        .mockResolvedValueOnce({
          summaries: [
            {
              userInput: { msgId: "msg-user-v1-2", timestamp: 1700000000456 },
            },
          ],
          hasMore: true,
          nextCursor: "cursor-older",
        })
        .mockResolvedValueOnce({
          summaries: [
            {
              userInput: {
                msgId: "msg-user-v1-1",
                contentHead: "first line",
                timestamp: 1700000000000,
              },
              assistantResponse: {
                msgId: "msg-assistant-v1-1",
                timestamp: 1700000000123,
              },
              fileChangeCount: 2,
            },
          ],
          hasMore: false,
        }),
      getSessionForkOptions: vi.fn(async () => ({
        canFork: true,
        suggestedTitle: "Fork of: hi",
        nextForkOrdinal: 2,
        sourceTitle: "hi",
        worktreeVisible: true,
        worktreeEligible: true,
      })),
      forkSession: vi.fn(async () => ({
        session: {
          sessionId: "child-1",
          agentName: "mavis",
          title: "Fork of: hi",
          workspaceDir: "/repo",
        },
        forkOriginMessageId: "msg-assistant-v1-1",
        sourceDisplayMessageId: "msg-assistant-v1-1",
        displayRevision: "rev-1",
        historyRevision: "hist-1",
      })),
      getSessionRewindPreview: vi.fn(async () => ({
        turns: [
          {
            turnId: "turn-1",
            files: [
              { filePath: "/repo/a.ts", action: "modify", skipped: false },
            ],
          },
        ],
      })),
      rewindSession: vi.fn(async () => ({
        rewound: true,
        displayRevision: "disp-1",
        historyRevision: "hist-1",
        deletedMessageIds: ["msg-user-v1-1"],
        turnDiffRewind: {
          status: "partial",
          revertedTurnIds: ["turn-1"],
        },
      })),
      editSessionMessage: vi.fn(async () => ({
        rewound: true,
        turnId: "turn-edit-1",
        userMessageId: "msg-user-v1-edited",
        displayRevision: "disp-2",
        historyRevision: "hist-2",
        deletedMessageIds: ["msg-user-v1-1", "msg-assistant-v1-1"],
      })),
    };
    const adapter = new TuiRuntimeAdapter(cliService as never);

    await expect(
      adapter.listSessionInputSummaries("session-1", { limit: 50 }),
    ).resolves.toEqual([
      {
        userMessageId: "msg-user-v1-1",
        assistantMessageId: "msg-assistant-v1-1",
        contentHead: "first line",
        timestamp: 1700000000000,
        fileChangeCount: 2,
      },
      {
        userMessageId: "msg-user-v1-2",
        timestamp: 1700000000456,
        fileChangeCount: 0,
      },
    ]);
    expect(cliService.listSessionInputSummaries).toHaveBeenNthCalledWith(1, {
      id: "session-1",
      limit: 50,
    });
    expect(cliService.listSessionInputSummaries).toHaveBeenNthCalledWith(2, {
      id: "session-1",
      limit: 50,
      before: "cursor-older",
    });

    await expect(
      adapter.getSessionForkOptions("session-1", "msg-1"),
    ).resolves.toEqual({
      canFork: true,
      suggestedTitle: "Fork of: hi",
      nextForkOrdinal: 2,
      sourceTitle: "hi",
      worktreeVisible: true,
      worktreeEligible: true,
    });
    expect(cliService.getSessionForkOptions).toHaveBeenCalledWith({
      id: "session-1",
      assistantMessageId: "msg-1",
    });

    await expect(
      adapter.forkSession({
        sessionId: "session-1",
        assistantMessageId: "msg-assistant-v1-1",
        clientRequestId: "fork-req-1",
        title: "Fork of: hi",
        useSuggestedTitle: false,
        createIsolatedWorktree: true,
      }),
    ).resolves.toEqual({
      session: {
        sessionId: "child-1",
        agentName: "mavis",
        title: "Fork of: hi",
        workspaceDir: "/repo",
      },
      forkOriginMessageId: "msg-assistant-v1-1",
      sourceDisplayMessageId: "msg-assistant-v1-1",
      displayRevision: "rev-1",
      historyRevision: "hist-1",
    });
    expect(cliService.forkSession).toHaveBeenCalledWith({
      id: "session-1",
      assistantMessageId: "msg-assistant-v1-1",
      clientRequestId: "fork-req-1",
      title: "Fork of: hi",
      useSuggestedTitle: false,
      createIsolatedWorktree: true,
    });

    await expect(
      adapter.getSessionRewindPreview({
        sessionId: "session-1",
        userMessageId: "msg-user-v1-1",
      }),
    ).resolves.toEqual({
      turns: [
        {
          turnId: "turn-1",
          files: [{ filePath: "/repo/a.ts", action: "modify", skipped: false }],
        },
      ],
    });
    expect(cliService.getSessionRewindPreview).toHaveBeenCalledWith({
      id: "session-1",
      userMessageId: "msg-user-v1-1",
    });

    await expect(
      adapter.rewindSession({
        sessionId: "session-1",
        userMessageId: "msg-user-v1-1",
        clientRequestId: "rewind-1",
        rewindTurnDiff: true,
      }),
    ).resolves.toEqual({
      rewound: true,
      displayRevision: "disp-1",
      historyRevision: "hist-1",
      deletedMessageIds: ["msg-user-v1-1"],
      turnDiffRewind: {
        status: "partial",
        revertedTurnIds: ["turn-1"],
      },
    });
    expect(cliService.rewindSession).toHaveBeenCalledWith({
      id: "session-1",
      userMessageId: "msg-user-v1-1",
      clientRequestId: "rewind-1",
      rewindTurnDiff: true,
    });

    await expect(
      adapter.editSessionMessage({
        sessionId: "session-1",
        userMessageId: "msg-user-v1-1",
        clientRequestId: "edit-1",
        content: "updated prompt",
        attachments: [
          {
            type: "file",
            filePath: "/repo/spec.md",
            fileName: "spec.md",
            mimeType: "text/markdown",
            sizeBytes: 42,
          },
        ],
        rewindTurnDiff: true,
      }),
    ).resolves.toEqual({
      rewound: true,
      turnId: "turn-edit-1",
      userMessageId: "msg-user-v1-edited",
      displayRevision: "disp-2",
      historyRevision: "hist-2",
      deletedMessageIds: ["msg-user-v1-1", "msg-assistant-v1-1"],
    });
    expect(cliService.editSessionMessage).toHaveBeenCalledWith({
      id: "session-1",
      userMessageId: "msg-user-v1-1",
      clientRequestId: "edit-1",
      content: "updated prompt",
      attachments: [
        {
          meta: {
            attachmentType: "file",
            fileName: "spec.md",
            mimeType: "text/markdown",
            sizeBytes: 42,
          },
          local: { filePath: "/repo/spec.md" },
        },
      ],
      rewindTurnDiff: true,
    });
  });

  it("fails closed when the Runtime omits the forked Session", async () => {
    const adapter = new TuiRuntimeAdapter({
      forkSession: vi.fn(async () => ({})),
    } as never);

    await expect(
      adapter.forkSession({
        sessionId: "session-1",
        assistantMessageId: "msg-assistant-v1-1",
        clientRequestId: "fork-req-1",
      }),
    ).rejects.toThrow("Runtime did not return the created Session.");
  });

  it.each([false, true] as const)(
    "forwards rewindTurnDiff=%s without generating an operation id",
    async (rewindTurnDiff) => {
      const cliService = {
        rewindSession: vi.fn(async (input: { rewindTurnDiff?: boolean }) => ({
          rewound: true,
          turnDiffRewind: { status: "rewound" },
          rewindTurnDiff: input.rewindTurnDiff,
        })),
      };
      const adapter = new TuiRuntimeAdapter(cliService as never);

      const result = await adapter.rewindSession({
        sessionId: "session-1",
        userMessageId: "msg-user-v1-target",
        clientRequestId: "caller-supplied-op-id",
        ...(rewindTurnDiff ? { rewindTurnDiff: true } : {}),
      });

      expect(result.rewound).toBe(true);
      expect(cliService.rewindSession).toHaveBeenCalledWith({
        id: "session-1",
        userMessageId: "msg-user-v1-target",
        clientRequestId: "caller-supplied-op-id",
        ...(rewindTurnDiff ? { rewindTurnDiff: true } : {}),
      });
    },
  );
});

describe("TuiRuntimeAdapter startup model override", () => {
  const savedGlobalSelection = {
    providerId: "global-provider",
    modelId: "global-model",
  };

  function createAdapter(options?: {
    readonly startupModelOverride?: {
      providerId: string;
      modelId: string;
      variant?: string;
      thinking?: { effort?: string };
    };
  }) {
    const createSession = vi.fn(async () => ({ sessionId: "session-new" }));
    const listModels = vi.fn(async () => [
      { ...savedGlobalSelection, selected: true },
    ]);
    const cliService = {
      createSession,
      listModels,
    };
    const adapter = new TuiRuntimeAdapter(cliService as never, options ?? {});
    return { adapter, cliService, createSession, listModels };
  }

  it("keeps the --model override on every Session so /new does not fall back", async () => {
    const { adapter, createSession } = createAdapter({
      startupModelOverride: {
        providerId: "override-provider",
        modelId: "override-model",
      },
    });

    await adapter.createSession({ workspaceDir: "/repo" });
    await adapter.createSession({ workspaceDir: "/repo" });

    expect(createSession).toHaveBeenCalledTimes(2);
    for (const [call] of createSession.mock.calls) {
      expect(call).toMatchObject({
        model: {
          providerId: "override-provider",
          modelId: "override-model",
        },
      });
    }
  });

  it("does not consult the saved global selection while an override is active", async () => {
    const { adapter, listModels } = createAdapter({
      startupModelOverride: {
        providerId: "override-provider",
        modelId: "override-model",
      },
    });

    await adapter.createSession({ workspaceDir: "/repo" });

    expect(listModels).not.toHaveBeenCalled();
  });

  it("inherits the saved global selection when no override is configured", async () => {
    const { adapter, createSession } = createAdapter();

    await adapter.createSession({ workspaceDir: "/repo" });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          providerId: "global-provider",
          modelId: "global-model",
        },
      }),
    );
  });

  it("forwards variant and think effort declared by the override", async () => {
    const { adapter, createSession } = createAdapter({
      startupModelOverride: {
        providerId: "override-provider",
        modelId: "override-model",
        variant: "thinking",
        thinking: { effort: "high" },
      },
    });

    await adapter.createSession({ workspaceDir: "/repo" });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          providerId: "override-provider",
          modelId: "override-model",
          variant: "thinking",
          thinking: { effort: "high" },
        },
      }),
    );
  });
});
