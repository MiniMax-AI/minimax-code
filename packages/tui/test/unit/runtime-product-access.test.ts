import {
  requireTuiAgentAccess,
  requireTuiAccountLogin,
} from "../../src/application/login-gate.js";
import type { CliService } from "@mavis/local-runtime-v2/cli-service";
import { describe, expect, it, vi } from "vitest";

import { TuiRuntimeAdapter } from "../../src/runtime/adapter.js";
import { buildTuiSkillCommands } from "../../src/tui/controller/run/active-run-flow.js";

describe("TuiRuntimeAdapter product access", () => {
  it("forwards the shared Provider Presets and Codex OAuth capability", async () => {
    const listProviderPresets = vi.fn(async () => [
      {
        providerId: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiFormat: "openai-responses",
        models: [{ modelId: "gpt-5.6", toolCall: true }],
      },
    ]);
    const getCodexOAuthStatus = vi.fn(async () => ({
      state: "disconnected",
      providerId: "openai-codex",
    }));
    const startCodexOAuthLogin = vi.fn(async () => ({
      state: "pending",
      providerId: "openai-codex",
      authUrl: "https://auth.example",
    }));
    const cancelCodexOAuthLogin = vi.fn(async () => ({
      state: "disconnected",
      providerId: "openai-codex",
    }));
    const adapter = new TuiRuntimeAdapter({
      cancelCodexOAuthLogin,
      listProviderPresets,
      getCodexOAuthStatus,
      startCodexOAuthLogin,
    } as never);

    await expect(adapter.listProviderPresets()).resolves.toEqual([
      expect.objectContaining({
        providerId: "openai",
        apiFormat: "openai-responses",
      }),
    ]);
    await expect(adapter.getCodexOAuthStatus()).resolves.toMatchObject({
      state: "disconnected",
    });
    await expect(
      adapter.startCodexOAuthLogin({ method: "device_code" }),
    ).resolves.toMatchObject({
      state: "pending",
      authUrl: "https://auth.example",
    });
    expect(listProviderPresets).toHaveBeenCalledOnce();
    expect(getCodexOAuthStatus).toHaveBeenCalledOnce();
    expect(startCodexOAuthLogin).toHaveBeenCalledWith({
      method: "device_code",
    });
    await adapter.cancelCodexOAuthLogin("attempt-1");
    expect(cancelCodexOAuthLogin).toHaveBeenCalledWith("attempt-1");
  });

  it("uses the Runtime startup model projection without saving a global selection", async () => {
    const service = {
      listModels: vi.fn(async () => [
        { providerId: "minimax", modelId: "MiniMax-M3", selected: true },
      ]),
      selectModel: vi.fn(async () => true),
    };
    const adapter = new TuiRuntimeAdapter(service as never);
    await expect(adapter.listModels()).resolves.toEqual([
      { providerId: "minimax", modelId: "MiniMax-M3", selected: true },
    ]);
    expect(service.selectModel).not.toHaveBeenCalled();
  });

  it("keeps manual model selection available if no official legacy replacement exists", async () => {
    const work = {
      providerId: "custom_provider:work",
      modelId: "work-model",
      selected: false,
    };
    const selectModel = vi.fn(async () => true);
    const adapter = new TuiRuntimeAdapter({
      listModels: vi.fn(async () => [work]),
      selectModel,
    } as never);
    await expect(adapter.listModels()).resolves.toEqual([work]);
    expect(selectModel).not.toHaveBeenCalled();
  });
  it.each([
    "custom_provider:minimax-legacy",
    "custom_provider:minimax-legacy-2",
  ])(
    "uses the Runtime projection while preserving the stored Session alias: %s",
    async (providerId) => {
      const legacy = { providerId, modelId: "MiniMax-M3" };
      const official = { providerId: "minimax", modelId: "MiniMax-M3" };
      const service = {
        listModels: vi.fn(async () => [
          { ...official, selected: true },
          {
            providerId: "custom_provider:work",
            modelId: "work-model",
            selected: false,
          },
        ]),
        getSession: vi.fn(async () => ({ session: { model: legacy } })),
        getMessages: vi.fn(async () => ({ messages: [] })),
        selectModel: vi.fn(async () => true),
      };
      const adapter = new TuiRuntimeAdapter(service as never);
      const models = await adapter.listModels("session-1");
      expect(service.selectModel).not.toHaveBeenCalled();
      expect(models.find((model) => model.selected)).toEqual({
        ...official,
        selected: true,
      });
      expect(models.map((model) => model.providerId)).toEqual([
        "minimax",
        "custom_provider:work",
      ]);
      await expect(
        adapter.getContextSnapshot("session-1"),
      ).resolves.toMatchObject({
        model: { provider: "minimax", id: "MiniMax-M3" },
      });
    },
  );
  it("forwards tested provider candidates through the process-local Runtime", async () => {
    const saveUserModelProviderCandidate = vi.fn(async () => ({
      success: true,
      provider: { providerId: "custom_provider:deepseek" },
    }));
    const adapter = new TuiRuntimeAdapter({
      saveUserModelProviderCandidate,
    } as never);

    await expect(
      adapter.saveUserModelProviderCandidate({
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-test",
        apiFormat: "openai-completions",
        models: [{ modelId: "deepseek-chat", toolCall: true }],
        modelId: "deepseek-chat",
        saveAndUse: true,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(saveUserModelProviderCandidate).toHaveBeenCalledWith({
      candidate: {
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-test",
        apiFormat: "openai-completions",
        models: [{ modelId: "deepseek-chat", toolCall: true }],
      },
      modelId: "deepseek-chat",
      saveAndUse: true,
    });
  });

  it("projects the process-local model catalog with the same thinking shape as Desktop", async () => {
    const listModels = vi.fn(async () => [
      {
        providerId: "custom_provider:openai",
        modelId: "gpt-5.6",
        thinkingConfig: { mode: "switchable", default_value: "true" },
        effortOptions: ["low", "high", "max"],
      },
    ]);
    const getSession = vi.fn(async () => ({ session: { id: "session-1" } }));
    const adapter = new TuiRuntimeAdapter({ listModels, getSession } as never);

    await expect(adapter.listModels("session-1")).resolves.toEqual([
      {
        providerId: "custom_provider:openai",
        modelId: "gpt-5.6",
        thinkingConfig: { mode: "switchable", defaultValue: "true" },
        effortOptions: ["low", "high", "max"],
      },
    ]);
    expect(listModels).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("reuses generated CliService usage, context, compaction, and Session contracts", async () => {
    const cliService = cliServiceFixture();
    const adapter = new TuiRuntimeAdapter(cliService);

    await expect(adapter.getSessionUsage("session-1")).resolves.toEqual({
      summary: { inputTokens: 10, outputTokens: 5, totalTokens: 15, turns: 1 },
      rows: [{ model: "minimax/MiniMax-M3" }],
    });
    await expect(adapter.getSessionUsageSummary("session-1")).resolves.toEqual({
      inputTokens: 10,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
    });
    expect(cliService.getSessionUsageSummary).toHaveBeenCalledWith({
      id: "session-1",
    });
    const signal = new AbortController().signal;
    const commits = adapter.watchSessionUsageCommits(signal);
    await expect(commits.next()).resolves.toEqual({
      done: false,
      value: "session-1",
    });
    expect(cliService.watchSessionUsageCommits).toHaveBeenCalledWith(signal);
    await expect(
      adapter.requestCompaction("session-1", "mavis", "keep decisions"),
    ).resolves.toMatchObject({
      success: true,
      sessionId: "session-1",
      tokensBefore: 100,
      tokensAfter: 40,
    });
    expect(cliService.requestCompaction).toHaveBeenCalledWith({
      name: "mavis",
      id: "session-1",
      reason: "ui_request",
      customInstructions: "keep decisions",
    });
    await expect(
      adapter.getContextSnapshot("session-1"),
    ).resolves.toMatchObject({
      status: "stale",
      model: { provider: "minimax", id: "MiniMax-M3", contextWindow: 1000 },
      contextUsage: {
        contextWindowTokens: 1000,
        usedTokens: 300,
        totalCountSource: "PROVIDER_USAGE_ANCHORED",
      },
    });
    expect(cliService.getMessages).toHaveBeenCalledWith({
      id: "session-1",
      limit: 80,
    });
    expect(cliService.listModels).toHaveBeenCalledWith({
      sessionId: "session-1",
    });
    await expect(adapter.getActiveRun("session-1")).resolves.toEqual({
      schemaVersion: 1,
      sessionId: "session-1",
      state: "running",
      turnId: "turn-1",
      actions: { steer: true },
    });
    expect(cliService.getActiveTurn).toHaveBeenCalledWith("session-1");
  });

  it("derives decision-blocked active state from generated interaction contracts", async () => {
    const cliService = cliServiceFixture();
    vi.mocked(cliService.listPendingPermissions).mockResolvedValueOnce({
      requests: [
        {
          requestId: "permission-1",
          sessionId: "session-1",
          agentName: "mavis",
          toolName: "bash",
          ruleContents: ["git status"],
          reason: "needs approval",
          allowAlwaysSupported: true,
          createdAt: 10,
        },
      ],
    });
    const adapter = new TuiRuntimeAdapter(cliService);

    await expect(adapter.getActiveRun("session-1")).resolves.toMatchObject({
      state: "decision-blocked",
      actions: { steer: false },
    });
  });

  it("does not advertise steer for a Turn owned by another Runtime", async () => {
    const cliService = cliServiceFixture();
    vi.mocked(cliService.getActiveTurn).mockResolvedValueOnce({
      turnId: "turn-foreign",
      busyReason: "turn",
      locallyOwned: false,
    });
    const adapter = new TuiRuntimeAdapter(cliService);

    await expect(adapter.getActiveRun("session-1")).resolves.toMatchObject({
      state: "running",
      turnId: "turn-foreign",
      actions: { steer: false },
    });
  });

  it("routes peripheral product capabilities through CliService", async () => {
    const adapter = new TuiRuntimeAdapter(cliServiceFixture());

    await expect(adapter.getAccountStatus("session-1")).resolves.toMatchObject({
      status: "ready",
      defaultModel: "minimax/MiniMax-M3",
    });
    await expect(adapter.getRuntimeDiagnostics()).resolves.toMatchObject({
      status: "ok",
    });
    await expect(adapter.getInstructionSources("/repo")).resolves.toEqual([
      { scope: "project", path: "/repo/AGENTS.md" },
    ]);
    await expect(adapter.getPermissionMode()).resolves.toBe("default");
    await expect(adapter.setPermissionMode("bypassPermissions")).resolves.toBe(
      "bypassPermissions",
    );
    await expect(adapter.listModels("session-1")).resolves.toEqual([
      {
        providerId: "minimax",
        modelId: "MiniMax-M3",
        selected: true,
        contextLimit: 400_000,
      },
    ]);
    await expect(adapter.listSkills("mavis")).resolves.toEqual({
      skills: [{ name: "review", enabled: true }],
      hasMore: false,
    });
    await expect(adapter.listMcpServers()).resolves.toEqual([
      { name: "browser", enabled: true, transport: "stdio" },
    ]);
  });

  it("projects only verified identity fields during lightweight account hydration", async () => {
    const tokenPlanAccountStatusGetter = vi.fn(async () => ({
      quotaState: "available" as const,
      quota: {
        fiveHour: { remainingPercent: 90, unlimited: false },
        weekly: { remainingPercent: 80, unlimited: false },
      },
    }));
    const service = cliServiceFixture();
    const adapter = new TuiRuntimeAdapter(service, {
      tokenPlanAccountStatusGetter,
      accountIdentityGetter: () => ({
        email: "dev@example.com",
        name: "Dev",
        accessToken: "never-project",
      }),
    });

    await expect(
      adapter.getAccountStatus(undefined, { includeMembership: false }),
    ).resolves.toMatchObject({
      modelSource: "token-plan",
      managedTokenPresent: true,
    });
    expect(tokenPlanAccountStatusGetter).not.toHaveBeenCalled();
    const account = await adapter.getAccountStatus(undefined, {
      includeMembership: false,
    });
    expect(account.identity).toEqual({ email: "dev@example.com", name: "Dev" });
    expect(JSON.stringify(account)).not.toContain("never-project");

    await expect(
      adapter.getAccountStatus(undefined, { includeMembership: true }),
    ).resolves.toMatchObject({
      tokenPlanQuotaState: "available",
      tokenPlanQuota: { fiveHour: { remainingPercent: 90 } },
    });
    expect(tokenPlanAccountStatusGetter).toHaveBeenCalledOnce();
    vi.mocked(service.getAccountStatus).mockResolvedValueOnce({
      auth: { tokenPresent: false },
    });
    expect(
      (await adapter.getAccountStatus(undefined, { includeMembership: false }))
        .identity,
    ).toBeUndefined();
  });

  it("keeps BYOK usable while account-only actions surface unavailable OAuth", async () => {
    const cliService = cliServiceFixture();
    vi.mocked(cliService.getAccountStatus).mockResolvedValue({
      selection: { defaultModel: "custom/model" },
      provider: { id: "custom_provider:example", authMode: "api-key" },
      auth: { tokenPresent: false },
      warnings: [],
    });
    const failure = new TypeError("fetch failed");
    const synchronizeAuth = vi.fn(async () => {
      throw failure;
    });
    const adapter = new TuiRuntimeAdapter(cliService, { synchronizeAuth });
    await expect(requireTuiAgentAccess(adapter)).resolves.toMatchObject({
      modelSource: "byok",
    });
    expect(synchronizeAuth).not.toHaveBeenCalled();
    await expect(requireTuiAccountLogin(adapter)).rejects.toBe(failure);
    expect(synchronizeAuth).toHaveBeenCalledOnce();
  });

  it("keeps BYOK usable while account-only actions surface unavailable OAuth", async () => {
    const cliService = cliServiceFixture();
    vi.mocked(cliService.getAccountStatus).mockResolvedValue({
      selection: { defaultModel: "custom/model" },
      provider: { id: "custom_provider:example", authMode: "api-key" },
      auth: { tokenPresent: false },
      warnings: [],
    });
    const failure = new TypeError("fetch failed");
    const synchronizeAuth = vi.fn(async () => {
      throw failure;
    });
    const adapter = new TuiRuntimeAdapter(cliService, { synchronizeAuth });
    await expect(requireTuiAgentAccess(adapter)).resolves.toMatchObject({
      modelSource: "byok",
    });
    expect(synchronizeAuth).not.toHaveBeenCalled();
    await expect(requireTuiAccountLogin(adapter)).rejects.toBe(failure);
    expect(synchronizeAuth).toHaveBeenCalledOnce();
  });

  it("hydrates explicit Token Plan usage for a BYOK account", async () => {
    const cliService = cliServiceFixture();
    vi.mocked(cliService.getAccountStatus).mockResolvedValueOnce({
      selection: { defaultModel: "custom/gpt-5.6" },
      provider: { id: "custom_provider:openai", authMode: "api-key" },
      auth: { tokenPresent: false },
      warnings: [],
    });
    const tokenPlanAccountStatusGetter = vi.fn(async () => ({
      summary: { tier: "Pro Plan" },
      quotaState: "available" as const,
      quota: {
        fiveHour: { remainingPercent: 75, unlimited: false },
        weekly: { remainingPercent: 50, unlimited: false },
      },
    }));
    const adapter = new TuiRuntimeAdapter(cliService, {
      tokenPlanAccountStatusGetter,
    });

    await expect(
      adapter.getAccountStatus(undefined, {
        includeMembership: true,
        forceRefresh: true,
      }),
    ).resolves.toMatchObject({
      modelSource: "byok",
      managedTokenPresent: false,
      tokenPlanSummary: { tier: "Pro Plan" },
      tokenPlanQuotaState: "available",
      tokenPlanQuota: { fiveHour: { remainingPercent: 75 } },
    });
    expect(tokenPlanAccountStatusGetter).toHaveBeenCalledWith({
      forceRefresh: true,
    });
  });

  it("forwards an explicit account refresh to Token Plan hydration", async () => {
    const tokenPlanAccountStatusGetter = vi.fn(async () => ({
      quotaState: "available" as const,
      quota: {
        fiveHour: { remainingPercent: 90, unlimited: false },
        weekly: { remainingPercent: 80, unlimited: false },
      },
    }));
    const adapter = new TuiRuntimeAdapter(cliServiceFixture(), {
      tokenPlanAccountStatusGetter,
    });

    await adapter.getAccountStatus(undefined, {
      includeMembership: true,
      forceRefresh: true,
    });

    expect(tokenPlanAccountStatusGetter).toHaveBeenCalledWith({
      forceRefresh: true,
    });
  });

  it("updates both the active Session and the TUI default model", async () => {
    const cliService = cliServiceFixture();
    const adapter = new TuiRuntimeAdapter(cliService);
    const selection = {
      providerId: "minimax",
      modelId: "MiniMax-M3",
      variant: "thinking",
      contextLimit: 1_000_000,
      thinking: { effort: "high" },
    };
    const defaultSelection = {
      providerId: selection.providerId,
      modelId: selection.modelId,
      variant: selection.variant,
      contextLimit: selection.contextLimit,
      thinking: selection.thinking,
    };

    await expect(adapter.selectModel(selection, "session-1")).resolves.toBe(
      true,
    );

    expect(cliService.selectModel).toHaveBeenNthCalledWith(1, defaultSelection);
    expect(cliService.selectModel).toHaveBeenNthCalledWith(2, {
      ...selection,
      sessionId: "session-1",
    });

    vi.mocked(cliService.selectModel).mockClear();
    await expect(adapter.selectModel(selection)).resolves.toBe(true);
    expect(cliService.selectModel).toHaveBeenCalledOnce();
    expect(cliService.selectModel).toHaveBeenCalledWith(defaultSelection);
  });

  it("can update one Session model without changing the process default", async () => {
    const cliService = cliServiceFixture();
    const adapter = new TuiRuntimeAdapter(cliService);
    const selection = {
      providerId: "minimax",
      modelId: "MiniMax-M3",
      variant: "thinking",
      thinking: { effort: "high" },
    };

    await expect(
      adapter.selectSessionModel(selection, "session-1"),
    ).resolves.toBe(true);

    expect(cliService.selectModel).toHaveBeenCalledOnce();
    expect(cliService.selectModel).toHaveBeenCalledWith({
      ...selection,
      sessionId: "session-1",
    });
  });

  it("does not change the active Session when saving the TUI default is rejected", async () => {
    const cliService = cliServiceFixture();
    vi.mocked(cliService.selectModel).mockResolvedValueOnce(false);
    const adapter = new TuiRuntimeAdapter(cliService);
    const selection = {
      providerId: "minimax",
      modelId: "MiniMax-M3",
    };

    await expect(adapter.selectModel(selection, "session-1")).resolves.toBe(
      false,
    );

    expect(cliService.selectModel).toHaveBeenCalledOnce();
    expect(cliService.selectModel).toHaveBeenCalledWith(selection);
  });

  it("discovers Skills in the requested Session workspace without changing the adapter default", async () => {
    const cliService = cliServiceFixture();
    const adapter = new TuiRuntimeAdapter(cliService, {
      workspaceDir: "/default-workspace",
    });
    await adapter.listSkills("reviewer", undefined, "/session-workspace");
    await adapter.listSkills("mavis");
    expect(cliService.listRuntimeSkills).toHaveBeenNthCalledWith(1, {
      agentName: "reviewer",
      workspaceDir: "/session-workspace",
      includePluginSkills: true,
    });
    expect(cliService.listRuntimeSkills).toHaveBeenNthCalledWith(2, {
      agentName: "mavis",
      workspaceDir: "/default-workspace",
      includePluginSkills: true,
    });
  });

  it("registers installed Plugin Skills from the unified Runtime roster as slash commands", async () => {
    const cliService = cliServiceFixture();
    vi.mocked(cliService.listRuntimeSkills).mockImplementationOnce(
      async (input) => {
        const skills = [{ name: "review", enabled: true }];
        if (input.includePluginSkills === true) {
          skills.push({ name: "traceink:generate", enabled: true });
        }
        return { skills, refreshedAt: 123 };
      },
    );
    const adapter = new TuiRuntimeAdapter(cliService);

    const result = await adapter.listSkills("mavis");

    expect(cliService.listRuntimeSkills).toHaveBeenCalledWith({
      agentName: "mavis",
      includePluginSkills: true,
    });
    expect(result.skills).toHaveLength(2);
    expect(buildTuiSkillCommands(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "traceink:generate" }),
      ]),
    );
    expect(result.hasMore).toBe(false);
  });
});

function cliServiceFixture(): CliService {
  return {
    watchSessionUsageCommits: vi.fn(async function* watchSessionUsageCommits() {
      yield "session-1";
    }),
    getSessionUsageSummary: vi.fn(async () => ({
      inputTokens: 10,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
    })),
    getSessionUsage: vi.fn(async () => ({
      summary: { inputTokens: 10, outputTokens: 5, totalTokens: 15, turns: 1 },
      rows: [{ model: "minimax/MiniMax-M3" }],
    })),
    getMessages: vi.fn(async () => ({
      messages: [
        {
          msgId: "assistant-1",
          kind: "final",
          rawJson: JSON.stringify({
            msg_id: "assistant-1",
            turnId: "turn-1",
            context_usage: {
              contextWindowTokens: 1000,
              usedTokens: 300,
              totalCountSource: "PROVIDER_USAGE_ANCHORED",
              components: [{ kind: "MESSAGES", tokens: 300 }],
            },
          }),
        },
      ],
    })),
    requestCompaction: vi.fn(async () => ({
      success: true,
      sessionId: "session-1",
      compactionId: "compaction-1",
      messagesBefore: 10,
      messagesAfter: 4,
      tokensBefore: 100,
      tokensAfter: 40,
    })),
    getSession: vi.fn(async () => ({
      session: {
        sessionId: "session-1",
        agentName: "mavis",
        status: { statusType: 1 },
        model: {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          contextLimit: 1000,
        },
      },
    })),
    listModels: vi.fn(async () => [
      {
        providerId: "minimax",
        modelId: "MiniMax-M3",
        selected: true,
        contextLimit: 400_000,
      },
    ]),
    getActiveTurn: vi.fn(async () => ({
      turnId: "turn-1",
      busyReason: "turn" as const,
      locallyOwned: true,
    })),
    listPendingPermissions: vi.fn(async () => ({ requests: [] })),
    getPendingQuestionnaire: vi.fn(async () => ({})),
    getAccountStatus: vi.fn(async () => ({
      selection: { defaultModel: "minimax/MiniMax-M3" },
      provider: { id: "minimax", authMode: "managed-login" },
      auth: { tokenPresent: true },
      warnings: [],
    })),
    getRuntimeDiagnostics: vi.fn(async () => ({ status: "ok" })),
    getInstructionSources: vi.fn(async ({ workspaceDir }) => [
      { scope: "project", path: `${workspaceDir}/AGENTS.md` },
    ]),
    getPermissionMode: vi.fn(async () => "default"),
    setPermissionMode: vi.fn(async ({ mode }) => mode),
    selectModel: vi.fn(async () => true),
    listRuntimeSkills: vi.fn(async () => ({
      skills: [{ name: "review", enabled: true }],
      refreshedAt: 123,
    })),
    listMcpServers: vi.fn(async () => ({
      servers: [{ name: "browser", enabled: true, transport: "stdio" }],
    })),
  } as unknown as CliService;
}

it("forwards saved-credential discovery and revision-checked model-only updates", async () => {
  const discoverUserModelsCandidate = vi.fn(async () => [
    { modelId: "latest" },
  ]);
  const saveUserModelProviderCandidate = vi.fn(async () => ({ success: true }));
  const adapter = new TuiRuntimeAdapter({
    discoverUserModelsCandidate,
    saveUserModelProviderCandidate,
  } as never);
  const candidate = {
    providerId: "custom_provider:work",
    expectedRevision: "rev-1",
    baseUrl: "https://models.example/v1",
  };
  await expect(adapter.discoverUserModelsCandidate(candidate)).resolves.toEqual(
    [{ modelId: "latest" }],
  );
  expect(discoverUserModelsCandidate).toHaveBeenCalledWith(candidate);
  await adapter.saveUserModelProviderCandidate({
    ...candidate,
    models: [{ modelId: "latest" }],
    modelId: "latest",
    skipConnectionTest: true,
    saveAndUse: false,
  });
  expect(saveUserModelProviderCandidate).toHaveBeenCalledWith({
    candidate: { ...candidate, models: [{ modelId: "latest" }] },
    modelId: "latest",
    skipConnectionTest: true,
    saveAndUse: false,
  });
  await adapter.saveUserModelProviderCandidate({
    ...candidate,
    apiKey: "new-key",
    modelId: "latest",
    saveAndUse: false,
  });
  expect(saveUserModelProviderCandidate).toHaveBeenLastCalledWith({
    candidate: { ...candidate, apiKey: "new-key" },
    modelId: "latest",
    saveAndUse: false,
  });
});
