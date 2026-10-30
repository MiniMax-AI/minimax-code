import { describe, expect, it, vi } from "vitest";
import type { TuiModel } from "../../../../../src/runtime/port.js";
import type { TuiMessage } from "../../../../../src/runtime/stream-events.js";
import type { McodeProviderTemplate } from "../../../../../src/provider/contract.js";
import { TuiFeatureFlow } from "../../../../../src/tui/controller/product/feature-flow.js";
import { stripAnsi } from "../../../../../src/tui/rendering/text.js";
import { TranscriptStore } from "../../../../../src/tui/transcript/store.js";

function model(modelId: string): TuiModel {
  return {
    providerId: "provider",
    modelId,
    displayName: modelId,
  };
}

function createHarness(
  options: {
    readonly writeClipboardText?: (text: string) => Promise<void>;
    readonly openExternalTarget?: (target: string) => Promise<void>;
    readonly loadProviderTemplates?: () => Promise<
      readonly McodeProviderTemplate[]
    >;
    readonly hasLiveRun?: () => boolean;
  } = {},
) {
  let activeSessionId: string | undefined = "session-a";
  const shown: unknown[] = [];
  const closed: unknown[] = [];
  const append = vi.fn();
  const exportTranscript = vi.fn(
    async (input: { readonly markdown: string }) => {
      void input;
      return "/exports/session.md";
    },
  );
  const setCompacting = vi.fn();
  const setHint = vi.fn();
  const refreshCurrentSessionHistory = vi.fn();
  const editor = { setText: vi.fn() };
  const onOpenSession = vi.fn(async () => undefined);
  const runtime = {
    listModels: vi.fn(),
    getAccountStatus: vi.fn(async () => ({
      status: "needs-login",
      managedTokenPresent: false,
      warnings: [],
    })),
    selectModel: vi.fn(),
    getSessionUsage: vi.fn(),
    getContextSnapshot: vi.fn(async () => ({ status: "empty" as const })),
    getRuntimeDiagnostics: vi.fn(),
    getInstructionSources: vi.fn(async () => [
      { scope: "project" as const, path: "/workspace/AGENTS.md" },
    ]),
    getPermissionMode: vi.fn(async () => "auto" as const),
    getWorkspaceGitMetadata: vi.fn(async () => ({
      isGitRepo: true,
      branch: "feat/status-details",
      detached: false,
      isWorktree: true,
    })),
    requestCompaction: vi.fn(),
    listSkills: vi.fn(async () => ({
      skills: [
        { name: "office-tools:compose", sourceKind: "plugin", enabled: true },
      ],
      hasMore: false,
    })),
    listMessagePage: vi.fn(async () => ({
      messages: [] as TuiMessage[],
      hasMore: false,
    })),
    listMarketplacePlugins: vi.fn(),
    listSessionPage: vi.fn(),
    listInstalledPlugins: vi.fn(async () => []),
    mutatePlugin: vi.fn(),
    refreshPlugins: vi.fn(),
    saveUserModelProviderCandidate: vi.fn(),
    listProviderPresets: vi.fn(async () => []),
    getCodexOAuthStatus: vi.fn(async () => ({
      state: "disconnected" as const,
      providerId: "openai-codex" as const,
    })),
    cancelCodexOAuthLogin: vi.fn(async () => ({
      state: "disconnected",
      providerId: "openai-codex",
    })),
    startCodexOAuthLogin: vi.fn(async () => ({
      state: "pending" as const,
      providerId: "openai-codex" as const,
      authUrl: "https://auth.openai.example/authorize",
    })),
    listUserModelProviders: vi.fn(async () => []),
    getMiniMaxApiKeyStatus: vi.fn(async () => ({ hasApiKey: false })),
    getMiniMaxModelSource: vi.fn(async () => "token_plan" as const),
    deleteUserModelProvider: vi.fn(async () => undefined),
  };
  const transcript = new TranscriptStore();
  const flow = new TuiFeatureFlow({
    runtime: runtime as never,
    controller: {
      snapshot: () => ({
        sessions: [],
        session: activeSessionId
          ? {
              sessionId: activeSessionId,
              agentName: "mavis",
              title: "Runtime review",
              workspaceDir: "/workspace",
            }
          : undefined,
      }),
      refreshCurrentSessionHistory,
      refreshStatusMetricsNow: vi.fn(),
    } as never,
    surface: {
      show: (panel: unknown) => shown.push(panel),
      close: (panel: unknown) => closed.push(panel),
    } as never,
    surfaceHost: {
      pushFeature: ({ screen }: { screen: { id: string } }) => {
        shown.push(screen);
        let active = true;
        return {
          id: screen.id,
          close: () => {
            const wasActive = active;
            active = false;
            if (wasActive) closed.push(screen);
            return wasActive;
          },
          isActive: () => active,
        };
      },
      getActiveSurface: () => ({
        kind: shown.length > closed.length ? "feature" : "chat",
      }),
    } as never,
    editor: editor as never,
    transcript,
    transcriptView: { toggleDetailMode: vi.fn() } as never,
    writeClipboardText: options.writeClipboardText,
    openExternalTarget: options.openExternalTarget,
    exportTranscript,
    workspaceDir: "/workspace",
    version: "1.2.3",
    planMode: () => ({ displayMode: "plan", transition: "next-message" }),
    defaultAgentName: "mavis",
    terminalRows: () => 40,
    append,
    setCompacting,
    setHint,
    onChanged: vi.fn(),
    ...(options.hasLiveRun ? { hasLiveRun: options.hasLiveRun } : {}),
    onNewSession: vi.fn(),
    onOpenSession,
    onArchivedCurrentSession: vi.fn(),
    refreshAutocomplete: vi.fn(),
    ...(options.loadProviderTemplates
      ? { loadProviderTemplates: options.loadProviderTemplates }
      : {}),
  });
  return {
    append,
    closed,
    exportTranscript,
    flow,
    editor,
    runtime,
    setCompacting,
    setHint,
    transcript,
    refreshCurrentSessionHistory,
    onOpenSession,
    shown,
    switchSession: (sessionId: string) => {
      activeSessionId = sessionId;
      flow.resetSessionState();
    },
    clearSession: () => {
      activeSessionId = undefined;
      flow.resetSessionState();
    },
  };
}

describe("TuiFeatureFlow", () => {
  it("opens the Codex OAuth URL from the independent /provider row", async () => {
    const openExternalTarget = vi.fn(async () => undefined);
    const harness = createHarness({ openExternalTarget });

    await harness.flow.showProviderManager();
    const manager = harness.shown[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    manager.handleInput("\u001b[A");
    manager.handleInput("\r");

    await vi.waitFor(() => expect(harness.shown).toHaveLength(2));
    const login = harness.shown[1] as {
      render(width: number): string[];
      handleInput(data: string): void;
      dispose(): void;
    };
    await vi.waitFor(() =>
      expect(stripAnsi(login.render(90).join("\n"))).toContain("Browser login"),
    );
    login.handleInput("\r");
    await vi.waitFor(() =>
      expect(harness.runtime.startCodexOAuthLogin).toHaveBeenCalledWith({
        method: "browser",
      }),
    );
    await vi.waitFor(() =>
      expect(openExternalTarget).toHaveBeenCalledWith(
        "https://auth.openai.example/authorize",
      ),
    );
    login.dispose();
  });

  it("does not open a Session manager when a Turn starts during its async load", async () => {
    let live = false;
    let resolvePage:
      | ((page: {
          sessions: [];
          hasMore: false;
          nextCursor: undefined;
        }) => void)
      | undefined;
    const harness = createHarness({ hasLiveRun: () => live });
    harness.runtime.listSessionPage.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolvePage = resolve;
        }),
    );

    const opening = harness.flow.showSessionManager();
    await vi.waitFor(() => expect(resolvePage).toBeTypeOf("function"));
    live = true;
    resolvePage?.({ sessions: [], hasMore: false, nextCursor: undefined });
    await opening;

    expect(harness.shown).toEqual([]);
    expect(harness.setHint).toHaveBeenLastCalledWith(
      "Stop the running turn before using /sessions.",
    );
  });

  it("exports the complete Runtime history in chronological order and reports the file link", async () => {
    const harness = createHarness();
    harness.runtime.listMessagePage
      .mockResolvedValueOnce({
        messages: [
          {
            id: "assistant-2",
            turnId: "turn-2",
            role: "assistant",
            content: "new answer",
          },
        ],
        hasMore: true,
        nextCursor: "message-1",
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: "user-1",
            turnId: "turn-1",
            role: "user",
            content: "old question",
          },
          {
            id: "assistant-1",
            turnId: "turn-1",
            role: "assistant",
            content: "old answer",
          },
        ],
        hasMore: false,
      });

    await harness.flow.exportCurrentTranscript();

    expect(harness.runtime.listMessagePage).toHaveBeenNthCalledWith(
      1,
      "session-a",
      {
        limit: 200,
      },
    );
    expect(harness.runtime.listMessagePage).toHaveBeenNthCalledWith(
      2,
      "session-a",
      {
        limit: 200,
        before: "message-1",
      },
    );
    const markdown = harness.exportTranscript.mock.calls[0]?.[0].markdown ?? "";
    expect(markdown.indexOf("old question")).toBeLessThan(
      markdown.indexOf("new answer"),
    );
    expect(harness.append).toHaveBeenLastCalledWith(
      expect.stringContaining("Exported Markdown:"),
    );
    expect(harness.append).toHaveBeenLastCalledWith(
      expect.stringContaining("session.md"),
    );
  });

  it("copies the last Assistant response as sanitized Markdown and reports clipboard failures", async () => {
    const writeClipboardText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("clipboard unavailable"));
    const harness = createHarness({ writeClipboardText });
    harness.transcript.upsert({
      id: "assistant-1",
      kind: "assistant",
      status: "succeeded",
      content:
        "<think>private reasoning</think><final>## Result\n\n- Fixed **login** with sk-secret12345678.</final>",
      createdAtMs: 1,
    });

    await harness.flow.copyLastAssistantReply();

    expect(writeClipboardText).toHaveBeenLastCalledWith(
      "## Result\n\n- Fixed **login** with sk-[redacted].",
    );
    expect(harness.setHint).toHaveBeenLastCalledWith(
      "Copied last response as Markdown.",
    );

    await harness.flow.copyLastAssistantReply();

    expect(harness.setHint).toHaveBeenLastCalledWith(
      "Couldn't copy the last response: clipboard unavailable. Open /transcript and copy it manually.",
    );
  });

  it("keeps the clipboard unchanged when there is no Assistant response", async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    const harness = createHarness({ writeClipboardText });

    await harness.flow.copyLastAssistantReply();

    expect(writeClipboardText).not.toHaveBeenCalled();
    expect(harness.setHint).toHaveBeenLastCalledWith(
      "No Assistant response to copy.",
    );
  });

  it("opens /plugins as a Runtime-backed feature screen and installs from the catalog", async () => {
    const harness = createHarness();
    harness.runtime.listMarketplacePlugins.mockImplementation(
      async ({ marketplace }: { marketplace: "official" | "local" }) =>
        marketplace === "official"
          ? [
              {
                pluginId: "office-tools@official",
                name: "office-tools",
                displayName: "Office Tools",
                marketplace: "official",
                installed: false,
                enabled: false,
                capabilities: { appCount: 1, mcpServerCount: 0, skillCount: 1 },
              },
            ]
          : [],
    );
    harness.runtime.mutatePlugin.mockResolvedValue({
      installed: true,
      enabled: true,
    });

    await harness.flow.showPlugins("office tools");

    const manager = harness.shown[0] as {
      id: string;
      handleInput(data: string): void;
    };
    expect(manager.id).toBe("plugins");
    manager.handleInput("\r");
    await vi.waitFor(() =>
      expect(harness.runtime.mutatePlugin).toHaveBeenCalledWith({
        action: "install",
        plugin: { name: "office-tools", marketplace: "official" },
      }),
    );
    await vi.waitFor(() =>
      expect(harness.runtime.listSkills).toHaveBeenCalledWith("mavis"),
    );
    expect(harness.flow.skillCommands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "office-tools:compose" }),
      ]),
    );
  });

  it("keeps compaction activity visible until the Runtime request settles", async () => {
    const harness = createHarness();
    let resolveCompaction:
      | ((result: {
          success: true;
          sessionId: string;
          compactionId: string;
        }) => void)
      | undefined;
    harness.runtime.requestCompaction.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveCompaction = resolve;
        }),
    );

    const pending = harness.flow.compactSession("preserve decisions", false);

    expect(harness.setCompacting).toHaveBeenCalledTimes(1);
    expect(harness.setCompacting).toHaveBeenLastCalledWith(true);
    resolveCompaction?.({
      success: true,
      sessionId: "session-a",
      compactionId: "ctx-1",
    });
    await pending;
    expect(harness.setCompacting.mock.calls).toEqual([[true], [false]]);
  });

  it("lets Runtime events own successful compaction rendering like Desktop", async () => {
    const harness = createHarness();
    harness.runtime.requestCompaction.mockResolvedValueOnce({
      success: true,
      sessionId: "session-a",
      compactionId: "ctx-1",
      tokensBefore: 1_081,
      tokensAfter: 400,
    });

    await harness.flow.compactSession("preserve decisions", false);

    expect(harness.runtime.requestCompaction).toHaveBeenCalledWith(
      "session-a",
      "mavis",
      "preserve decisions",
    );
    expect(harness.refreshCurrentSessionHistory).not.toHaveBeenCalled();
    expect(harness.append).not.toHaveBeenCalled();
  });

  it("reports a Runtime compaction failure without manufacturing a success receipt", async () => {
    const harness = createHarness();
    harness.runtime.requestCompaction.mockResolvedValueOnce({
      success: false,
      sessionId: "session-a",
      code: "failed",
      error: "Summary transport failed.",
    });

    await harness.flow.compactSession("", false);

    expect(harness.append).toHaveBeenCalledWith(
      "Couldn't compact this conversation: Summary transport failed. Retry /compact later. Your messages are unchanged.",
      "error",
    );
    expect(harness.append).not.toHaveBeenCalledWith(
      expect.stringContaining("completed"),
      "final-summary",
    );
  });

  it("does not open a stale model picker after switching Session", async () => {
    const harness = createHarness();
    let resolveModels: ((models: TuiModel[]) => void) | undefined;
    harness.runtime.listModels.mockImplementationOnce(
      async () =>
        await new Promise<TuiModel[]>((resolve) => {
          resolveModels = resolve;
        }),
    );

    const showing = harness.flow.showModelPicker("");
    await vi.waitFor(() => expect(resolveModels).toBeTypeOf("function"));
    harness.switchSession("session-b");
    resolveModels?.([model("model-a")]);
    await showing;

    expect(harness.shown).toEqual([]);
    expect(harness.append).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a different model",
      previous: { ...model("model-a"), selected: true },
      history: true,
      active: true,
      success: true,
      warn: true,
    },
    {
      name: "the same model on another provider",
      previous: { ...model("model-b"), providerId: "other", selected: true },
      history: true,
      active: true,
      success: true,
      warn: true,
    },
    {
      name: "the same model",
      previous: { ...model("model-b"), selected: true },
      history: true,
      active: true,
      success: true,
      warn: false,
    },
    {
      name: "an empty Session",
      previous: { ...model("model-a"), selected: true },
      history: false,
      active: true,
      success: true,
      warn: false,
    },
    {
      name: "the welcome screen",
      previous: { ...model("model-a"), selected: true },
      history: true,
      active: false,
      success: true,
      warn: false,
    },
    {
      name: "an unknown previous model",
      previous: model("model-a"),
      history: true,
      active: true,
      success: true,
      warn: false,
    },
    {
      name: "a rejected selection",
      previous: { ...model("model-a"), selected: true },
      history: true,
      active: true,
      success: false,
      warn: false,
    },
  ])(
    "only warns about cache reuse after an actual switch: $name",
    async ({ previous, history, active, success, warn }) => {
      const harness = createHarness();
      if (!active) harness.clearSession();
      harness.transcript.upsert({
        id: "existing-content",
        kind: history ? "user" : "final-summary",
        status: "succeeded",
        content: history ? "Explain the project." : "Model selected.",
        createdAtMs: 1,
      });
      harness.runtime.listModels.mockResolvedValue([
        previous,
        model("model-b"),
      ]);
      harness.runtime.selectModel.mockResolvedValue(success);

      await harness.flow.showModelPicker("provider/model-b");
      const picker = harness.shown[0] as { handleInput(data: string): void };
      picker.handleInput("\r");

      await vi.waitFor(() => expect(harness.append).toHaveBeenCalled());
      const warnings = harness.append.mock.calls.filter(
        ([, kind]) => kind === "warning",
      );
      expect(warnings).toHaveLength(warn ? 1 : 0);
      if (warn) {
        expect(warnings[0]?.[0]).toContain(
          "Switching models may prevent reuse of the existing prompt cache",
        );
        expect(harness.append.mock.calls[0]?.[0]).toContain("Model selected:");
      }
    },
  );

  it("does not emit a cache warning into a different Session after an in-flight selection", async () => {
    const harness = createHarness();
    harness.transcript.upsert({
      id: "user-a",
      kind: "user",
      status: "succeeded",
      content: "Hello",
      createdAtMs: 1,
    });
    harness.runtime.listModels.mockResolvedValue([
      { ...model("model-a"), selected: true },
      model("model-b"),
    ]);
    let finishSelection: ((success: boolean) => void) | undefined;
    harness.runtime.selectModel.mockImplementation(
      async () =>
        await new Promise<boolean>((resolve) => {
          finishSelection = resolve;
        }),
    );
    await harness.flow.showModelPicker("model-b");
    const picker = harness.shown[0] as { handleInput(data: string): void };
    picker.handleInput("\r");
    await vi.waitFor(() => expect(finishSelection).toBeTypeOf("function"));
    harness.switchSession("session-b");
    finishSelection?.(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.append).not.toHaveBeenCalled();
  });

  it("opens the model picker with the initial query and keeps the full catalog available", async () => {
    const harness = createHarness();
    harness.runtime.listModels.mockResolvedValue([
      {
        providerId: "minimax",
        providerName: "MiniMax",
        modelId: "MiniMax-M3",
        displayName: "MiniMax-M3",
      },
      {
        providerId: "deepseek",
        providerName: "DeepSeek",
        modelId: "deepseek-v4-pro",
        displayName: "deepseek-v4-pro",
      },
    ]);

    await harness.flow.showModelPicker("deepseek");

    const picker = harness.shown[0] as { render(width: number): string[] };
    const rendered = picker.render(90).join("\n");
    expect(rendered).toContain("Search: deepseek");
    expect(rendered).toContain("DeepSeek · 1");
    expect(rendered).toContain("deepseek-v4-pro");
    expect(rendered).not.toContain("MiniMax-M3");
  });

  it("keeps the independent Codex OAuth entry visible from /model", async () => {
    const openExternalTarget = vi.fn(async () => undefined);
    const harness = createHarness({ openExternalTarget });
    harness.runtime.listModels.mockResolvedValue([
      {
        providerId: "custom_provider:mafia-openai",
        providerName: "Mafia OpenAI Models",
        modelId: "codex-auto-review",
        displayName: "Codex Auto Review",
      },
    ]);

    await harness.flow.showModelPicker("code");

    const picker = harness.shown[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    expect(stripAnsi(picker.render(90).join("\n"))).toContain(
      "Connect OpenAI Codex",
    );
    picker.handleInput("\u001b[B");
    picker.handleInput("\u001b[B");
    picker.handleInput("\r");

    await vi.waitFor(() => expect(harness.shown).toHaveLength(2));
    const login = harness.shown[1] as {
      render(width: number): string[];
      handleInput(data: string): void;
      dispose(): void;
    };
    await vi.waitFor(() =>
      expect(stripAnsi(login.render(90).join("\n"))).toContain("Browser login"),
    );
    login.handleInput("\r");
    await vi.waitFor(() =>
      expect(harness.runtime.startCodexOAuthLogin).toHaveBeenCalledWith({
        method: "browser",
      }),
    );
    await vi.waitFor(() =>
      expect(openExternalTarget).toHaveBeenCalledWith(
        "https://auth.openai.example/authorize",
      ),
    );
    login.dispose();
  });

  it("keeps provider onboarding available when Runtime has no configured models", async () => {
    const harness = createHarness();
    harness.runtime.listModels.mockResolvedValue([]);
    harness.runtime.getCodexOAuthStatus.mockResolvedValue({
      state: "hidden",
      providerId: "openai-codex",
    });

    await harness.flow.showModelPicker("");

    expect(harness.shown).toHaveLength(1);
    const picker = harness.shown[0] as { render(width: number): string[] };
    const rendered = picker.render(90).join("\n");
    expect(rendered).toContain("Add 3rd-party provider");
    expect(rendered).not.toContain("OpenAI Codex");
    expect(harness.append).not.toHaveBeenCalledWith(
      expect.stringContaining("No models are available"),
      expect.anything(),
    );
  });

  it("leaves provider deletion out of /model", async () => {
    const harness = createHarness();
    harness.runtime.listModels.mockResolvedValue([
      {
        providerId: "custom_provider:openai",
        providerName: "OpenAI",
        providerSource: "custom_provider",
        providerKind: "custom",
        modelId: "gpt-4o",
        displayName: "GPT-4o",
      },
      model("fallback"),
    ]);

    await harness.flow.showModelPicker("");
    const picker = harness.shown[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    expect(stripAnsi(picker.render(120).join("\n"))).not.toContain(
      "delete provider",
    );
    picker.handleInput("\x04");

    const rendered = stripAnsi(picker.render(120).join("\n"));
    expect(rendered).not.toContain("Delete provider?");
    expect(rendered).toContain("GPT-4o");
    expect(harness.runtime.deleteUserModelProvider).not.toHaveBeenCalled();
  });

  it("deletes a custom connection from /provider only after y and refreshes the list", async () => {
    const harness = createHarness();
    const openai = {
      providerId: "custom_provider:openai",
      name: "OpenAI",
      kind: "api_key",
      enabled: true,
      configRevision: "rev-1",
      baseUrl: "https://api.openai.com/v1",
      hasApiKey: true,
      models: [{ modelId: "gpt-4o" }, { modelId: "gpt-4o-mini" }],
    };
    harness.runtime.listUserModelProviders
      .mockResolvedValueOnce([openai] as never)
      .mockResolvedValue([]);
    harness.runtime.listModels.mockResolvedValue([model("fallback")]);

    await harness.flow.showProviderManager();
    const manager = harness.shown[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    // Rows: Codex, minimax OAuth (initial cursor), minimax API Key, OpenAI.
    manager.handleInput("\u001b[B");
    manager.handleInput("\u001b[B");
    manager.handleInput("d");
    const confirmation = stripAnsi(manager.render(100).join("\n"));
    expect(confirmation).toContain("Delete OpenAI?");
    expect(confirmation).toContain("all 2 configured models");

    // Enter is the list's "use" key, so it must cancel instead of confirming.
    manager.handleInput("\r");
    expect(stripAnsi(manager.render(100).join("\n"))).not.toContain(
      "Delete OpenAI?",
    );
    expect(harness.runtime.deleteUserModelProvider).not.toHaveBeenCalled();

    manager.handleInput("d");
    manager.handleInput("y");
    await vi.waitFor(() =>
      expect(harness.runtime.deleteUserModelProvider).toHaveBeenCalledWith(
        "custom_provider:openai",
      ),
    );
    await vi.waitFor(() =>
      expect(stripAnsi(manager.render(100).join("\n"))).toContain(
        "Deleted OpenAI",
      ),
    );
    expect(stripAnsi(manager.render(100).join("\n"))).not.toContain("GPT-4o");
  });

  it("keeps the connection used by the active Session until another model is chosen", async () => {
    const harness = createHarness();
    harness.runtime.listUserModelProviders.mockResolvedValue([
      {
        providerId: "custom_provider:openai",
        name: "OpenAI",
        kind: "api_key",
        enabled: true,
        hasApiKey: true,
        models: [{ modelId: "gpt-4o" }],
      },
    ] as never);
    harness.runtime.listModels.mockResolvedValue([
      {
        providerId: "custom_provider:openai",
        providerName: "OpenAI",
        providerSource: "custom_provider",
        providerKind: "custom",
        modelId: "gpt-4o",
        displayName: "GPT-4o",
        selected: true,
      },
      model("fallback"),
    ]);

    await harness.flow.showProviderManager();
    const manager = harness.shown[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    manager.handleInput("\u001b[B");
    manager.handleInput("\u001b[B");
    manager.handleInput("d");
    manager.handleInput("y");

    await vi.waitFor(() =>
      expect(stripAnsi(manager.render(180).join("\n"))).toContain(
        "Switch to another model before deleting this provider",
      ),
    );
    expect(harness.runtime.deleteUserModelProvider).not.toHaveBeenCalled();
  });

  it("adds a known API Key provider from /model and selects its model for the Session", async () => {
    const template: McodeProviderTemplate = {
      providerId: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiFormat: "openai-completions",
      models: [
        {
          modelId: "deepseek-chat",
          displayName: "DeepSeek Chat",
          configurationSource: "discovered",
          toolCall: true,
        },
        {
          modelId: "deepseek-reasoner",
          displayName: "DeepSeek Reasoner",
          configurationSource: "discovered",
          reasoning: true,
          toolCall: true,
        },
      ],
    };
    const harness = createHarness();
    harness.runtime.listProviderPresets.mockResolvedValue([template]);
    harness.transcript.upsert({
      id: "user-a",
      kind: "user",
      status: "succeeded",
      content: "Hello",
      createdAtMs: 1,
    });
    harness.runtime.listModels
      .mockResolvedValueOnce([{ ...model("existing"), selected: true }])
      .mockResolvedValue([
        { ...model("existing"), selected: true },
        {
          providerId: "custom_provider:deepseek",
          providerName: "DeepSeek",
          modelId: "deepseek-chat",
          displayName: "DeepSeek Chat",
        },
        {
          providerId: "custom_provider:deepseek",
          providerName: "DeepSeek",
          modelId: "deepseek-reasoner",
          displayName: "DeepSeek Reasoner",
        },
      ]);
    harness.runtime.saveUserModelProviderCandidate.mockResolvedValue({
      success: true,
      provider: { providerId: "custom_provider:deepseek" },
    });
    harness.runtime.selectModel.mockResolvedValue(true);

    await harness.flow.showModelPicker("");
    const picker = harness.shown[0] as { handleInput(data: string): void };
    picker.handleInput("\u001b[B");
    picker.handleInput("\r");

    await vi.waitFor(() => expect(harness.shown).toHaveLength(2));
    const onboarding = harness.shown[1] as { handleInput(data: string): void };
    onboarding.handleInput("\r");
    onboarding.handleInput("\t");
    onboarding.handleInput("\r");
    onboarding.handleInput("sk-secret");
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");

    await vi.waitFor(() =>
      expect(harness.runtime.selectModel).toHaveBeenCalled(),
    );
    expect(harness.runtime.listProviderPresets).toHaveBeenCalledOnce();
    expect(harness.runtime.saveUserModelProviderCandidate).toHaveBeenCalledWith(
      {
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-secret",
        apiFormat: "openai-completions",
        models: template.models,
        modelId: "deepseek-chat",
        saveAndUse: true,
      },
    );
    expect(harness.runtime.selectModel).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "custom_provider:deepseek",
        modelId: "deepseek-chat",
      }),
      "session-a",
    );
    await vi.waitFor(() => expect(harness.shown).toHaveLength(3));
    const modelPicker = harness.shown[2] as { render(width: number): string[] };
    expect(stripAnsi(modelPicker.render(90).join("\n"))).toContain(
      "DeepSeek Chat",
    );
    expect(stripAnsi(modelPicker.render(90).join("\n"))).toContain(
      "DeepSeek Reasoner",
    );
    expect(harness.append).toHaveBeenCalledWith(
      "Provider added: DeepSeek · custom_provider:deepseek/deepseek-chat.",
    );
    expect(harness.append).toHaveBeenCalledWith(
      expect.stringContaining(
        "Switching models may prevent reuse of the existing prompt cache",
      ),
      "warning",
    );
  });

  it("falls back to Custom provider onboarding when models.dev is unavailable", async () => {
    const harness = createHarness({
      loadProviderTemplates: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    harness.runtime.listModels.mockResolvedValue([]);

    await harness.flow.showModelPicker("");
    const picker = harness.shown[0] as { handleInput(data: string): void };
    picker.handleInput("\r");

    await vi.waitFor(() => expect(harness.shown).toHaveLength(2));
    const onboarding = harness.shown[1] as { render(width: number): string[] };
    expect(onboarding.render(90).join("\n")).toContain("Custom provider");
    expect(onboarding.render(90).join("\n")).toContain(
      "Known providers unavailable",
    );
  });

  it("drops a late usage result after switching Session", async () => {
    // Regression caught: reopening a usage panel after the Runtime read finishes for a stale Session.
    const harness = createHarness();
    let resolveUsage:
      | ((usage: { summary: { totalTokens: number }; rows: [] }) => void)
      | undefined;
    harness.runtime.getSessionUsage.mockImplementationOnce(
      async () =>
        await new Promise<{ summary: { totalTokens: number }; rows: [] }>(
          (resolve) => {
            resolveUsage = resolve;
          },
        ),
    );
    const showing = harness.flow.showSessionUsage();
    await vi.waitFor(() => expect(resolveUsage).toBeTypeOf("function"));
    expect(harness.shown).toHaveLength(1);
    const panel = harness.shown[0];
    harness.switchSession("session-b");
    resolveUsage?.({ summary: { totalTokens: 42 }, rows: [] });
    await showing;

    expect(harness.closed).toContain(panel);
    expect(harness.append).not.toHaveBeenCalled();
  });

  it("keeps a closed usage inspection out of the Transcript when its request finishes late", async () => {
    const harness = createHarness();
    let resolveUsage:
      | ((usage: { summary: { totalTokens: number }; rows: [] }) => void)
      | undefined;
    harness.runtime.getSessionUsage.mockImplementationOnce(
      async () =>
        await new Promise<{ summary: { totalTokens: number }; rows: [] }>(
          (resolve) => {
            resolveUsage = resolve;
          },
        ),
    );

    const showing = harness.flow.showSessionUsage();
    await vi.waitFor(() => expect(resolveUsage).toBeTypeOf("function"));
    const panel = harness.shown[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    expect(stripAnsi(panel.render(80).join("\n"))).toContain("Loading usage…");

    panel.handleInput("\u001b");
    resolveUsage?.({ summary: { totalTokens: 42 }, rows: [] });
    await showing;

    expect(harness.closed).toContain(panel);
    expect(harness.shown).toHaveLength(1);
    expect(harness.append).not.toHaveBeenCalled();
    expect(stripAnsi(panel.render(80).join("\n"))).toContain("Loading usage…");
  });

  it("shows status and usage in interactions while diagnostics remain Transcript output", async () => {
    // Regression caught: /usage omitting its companion context read or not forwarding the active Session ID.
    const harness = createHarness();
    harness.runtime.getSessionUsage.mockResolvedValueOnce({
      summary: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        turns: 1,
      },
      rows: [],
    });
    harness.runtime.getContextSnapshot.mockResolvedValueOnce({
      status: "live",
      contextUsage: {
        contextWindowTokens: 10_000,
        usedTokens: 3_000,
        totalCountSource: "PROVIDER_USAGE_ANCHORED",
        components: [],
      },
    });
    harness.runtime.getRuntimeDiagnostics.mockResolvedValue({
      status: "ok",
      runtimeMode: "clean",
      runtimeOwnerKind: "cli",
      runtimeOwnerId: "mcode",
      configPresent: true,
      authCachePresent: true,
      managedTokenPresent: true,
      apiKeyPresent: false,
      customProviderCount: 0,
      warnings: [],
    });

    await harness.flow.showAccountStatus();
    await harness.flow.showConfigurationInspection(false);
    await harness.flow.showConfigurationInspection(true);
    await harness.flow.showSessionUsage();

    expect(harness.shown).toHaveLength(2);
    const statusPanel = harness.shown[0] as { render(width: number): string[] };
    const usagePanel = harness.shown[1] as { render(width: number): string[] };
    expect(harness.closed).toContain(statusPanel);
    expect(harness.append.mock.calls).toEqual([
      [
        expect.stringContaining("Configuration check"),
        "inspection",
        expect.objectContaining({ title: "Configuration check" }),
      ],
      [
        expect.stringContaining("Effective configuration"),
        "inspection",
        expect.objectContaining({ title: "Effective configuration" }),
      ],
    ]);
    expect(harness.runtime.getAccountStatus.mock.calls).toEqual([
      ["session-a", { includeMembership: true, forceRefresh: true }],
      ["session-a", { includeMembership: true, forceRefresh: true }],
    ]);
    expect(harness.runtime.getPermissionMode).toHaveBeenCalledOnce();
    expect(harness.runtime.getWorkspaceGitMetadata).toHaveBeenCalledWith(
      "/workspace",
    );
    const statusOutput = stripAnsi(statusPanel.render(120).join("\n"));
    expect(statusOutput).toContain("Thinking unknown");
    expect(statusOutput).toContain("/workspace");
    expect(statusOutput).toContain("feat/status-details · Linked");
    expect(statusOutput).toContain("/workspace/AGENTS.md");
    expect(statusOutput).toContain("Default → Plan (next message)");
    expect(statusOutput).toContain("v1.2.3");
    expect(harness.runtime.getInstructionSources).toHaveBeenCalledWith(
      "/workspace",
    );
    expect(statusOutput).toContain("Runtime review");
    expect(statusOutput).toContain("session-a");
    expect(statusOutput).toMatch(/Permissions:\s+Auto/u);
    expect(harness.runtime.getSessionUsage).toHaveBeenCalledWith("session-a");
    expect(harness.runtime.getContextSnapshot).toHaveBeenCalledWith(
      "session-a",
    );
    const usageOutput = stripAnsi(usagePanel.render(120).join("\n"));
    expect(usageOutput).toContain("Usage");
    expect(usageOutput).toContain("30% used · 70% free · 3k / 10k");
  });

  it("keeps local status available when account and optional details fail", async () => {
    const harness = createHarness();
    harness.runtime.getPermissionMode.mockRejectedValueOnce(
      new Error("config unavailable"),
    );
    harness.runtime.getWorkspaceGitMetadata.mockRejectedValueOnce(
      new Error("git unavailable"),
    );
    harness.runtime.getInstructionSources.mockRejectedValueOnce(
      new Error("instructions unavailable"),
    );
    harness.runtime.getAccountStatus.mockRejectedValueOnce(
      new Error("account unavailable"),
    );

    await harness.flow.showAccountStatus();

    expect(harness.append).not.toHaveBeenCalled();
    expect(harness.shown).toHaveLength(1);
    const panel = harness.shown[0] as { render(width: number): string[] };
    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("MCode status");
    expect(output).toContain("/workspace");
    expect(output).toContain("Unavailable · Unavailable");
    expect(output).toContain("MiniMax account unavailable");
    expect(output).toMatch(/Instructions:\s+Unavailable/u);
  });

  it("shows local status while the account loads and ignores its result after closing", async () => {
    const harness = createHarness();
    let complete!: (
      value: Awaited<ReturnType<typeof harness.runtime.getAccountStatus>>,
    ) => void;
    harness.runtime.getAccountStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const showing = harness.flow.showAccountStatus();
    const panel = harness.shown[0] as {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    await vi.waitFor(() =>
      expect(stripAnsi(panel.render(100).join("\n"))).toContain("/workspace"),
    );
    const localOutput = stripAnsi(panel.render(100).join("\n"));
    expect(localOutput).toContain("Loading account");
    panel.handleInput("\u001b");
    complete({ status: "ready", managedTokenPresent: true, warnings: [] });
    await showing;
    expect(harness.shown).toHaveLength(1);
    expect(harness.closed).toContain(panel);
    expect(harness.append).not.toHaveBeenCalled();
    expect(stripAnsi(panel.render(100).join("\n"))).toBe(localOutput);
  });

  it("shows signed-in account usage before a Session exists", async () => {
    const harness = createHarness();
    harness.clearSession();
    harness.runtime.getAccountStatus.mockResolvedValueOnce({
      status: "ready",
      authMode: "byok",
      managedTokenPresent: false,
      modelSource: "byok",
      tokenPlanQuotaState: "available",
      tokenPlanSummary: { tier: "Pro Plan" },
      tokenPlanQuota: {
        fiveHour: { remainingPercent: 75, unlimited: false },
        weekly: { remainingPercent: 50, unlimited: false },
      },
      warnings: [],
    });

    await harness.flow.showSessionUsage();

    expect(harness.runtime.getSessionUsage).not.toHaveBeenCalled();
    expect(harness.runtime.getAccountStatus).toHaveBeenCalledWith(undefined, {
      includeMembership: true,
      forceRefresh: true,
    });
    expect(harness.append).not.toHaveBeenCalled();
    expect(harness.shown).toHaveLength(1);
    const panel = harness.shown[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("Account only");
    expect(output).toContain("Pro Plan");
    expect(output).toContain("75% left");

    panel.handleInput("\u001b");
    expect(harness.closed).toContain(panel);
  });

  it("keeps usage available when the optional account request fails", async () => {
    // Regression caught: an optional companion request taking down the authoritative usage request.
    const harness = createHarness();
    harness.runtime.getSessionUsage.mockResolvedValueOnce({
      summary: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      rows: [],
    });
    harness.runtime.getAccountStatus.mockRejectedValueOnce(
      new Error("account unavailable"),
    );

    await harness.flow.showSessionUsage();

    expect(harness.append).not.toHaveBeenCalled();
    const panel = harness.shown[0] as { render(width: number): string[] };
    expect(stripAnsi(panel.render(100).join("\n"))).toContain("120 total");
    expect(harness.runtime.getAccountStatus).toHaveBeenCalledWith("session-a", {
      includeMembership: true,
      forceRefresh: true,
    });
  });

  it("reports an authoritative usage request failure", async () => {
    // Regression caught: swallowing the usage request failure with the optional context request.
    const harness = createHarness();
    harness.runtime.getSessionUsage.mockRejectedValueOnce(
      new Error("usage unavailable"),
    );

    await harness.flow.showSessionUsage();

    expect(harness.append).not.toHaveBeenCalled();
    const panel = harness.shown[0] as { render(width: number): string[] };
    expect(stripAnsi(panel.render(100).join("\n"))).toContain(
      "Couldn't load usage: usage unavailable. Retry /usage.",
    );
  });

  it("drops a late diagnostics result after switching Session", async () => {
    const harness = createHarness();
    let resolveDiagnostics:
      | ((value: { warnings: string[] }) => void)
      | undefined;
    harness.runtime.getRuntimeDiagnostics.mockImplementationOnce(
      async () =>
        await new Promise<{ warnings: string[] }>((resolve) => {
          resolveDiagnostics = resolve;
        }),
    );

    const showing = harness.flow.showConfigurationInspection(false);
    await vi.waitFor(() => expect(resolveDiagnostics).toBeTypeOf("function"));
    harness.switchSession("session-b");
    resolveDiagnostics?.({ warnings: [] });
    await showing;

    expect(harness.append).not.toHaveBeenCalled();
  });

  it("drops a late diagnostics failure after the TUI stops", async () => {
    const harness = createHarness();
    let rejectDiagnostics: ((error: Error) => void) | undefined;
    harness.runtime.getRuntimeDiagnostics.mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectDiagnostics = reject;
        }),
    );

    const showing = harness.flow.showConfigurationInspection(false);
    await vi.waitFor(() => expect(rejectDiagnostics).toBeTypeOf("function"));
    harness.flow.stop();
    rejectDiagnostics?.(new Error("late failure"));
    await showing;

    expect(harness.append).not.toHaveBeenCalled();
  });

  it("loads account status with the model catalog so managed models fail closed", async () => {
    const harness = createHarness();
    harness.runtime.listModels.mockResolvedValue([
      {
        providerId: "minimax",
        modelId: "MiniMax-M2.7",
        providerKind: "minimax-managed",
      },
    ]);

    await harness.flow.showModelPicker("");
    const picker = harness.shown[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };

    expect(picker.render(80).join("\n")).toContain(
      "Sign in with /login to use official MiniMax models.",
    );
    picker.handleInput("\r");

    expect(harness.runtime.selectModel).not.toHaveBeenCalled();
    expect(harness.append).toHaveBeenCalledWith(
      "Sign in with /login to use official MiniMax models.",
      "warning",
    );
  });

  it("applies the model and switchable Thinking draft atomically on Enter", async () => {
    // Regression caught: arrow keys either persisting immediately or Enter losing an explicit Off choice.
    const harness = createHarness();
    harness.transcript.upsert({
      id: "user-a",
      kind: "user",
      status: "succeeded",
      content: "Hello",
      createdAtMs: 1,
    });
    harness.runtime.getAccountStatus.mockResolvedValueOnce({
      status: "ready",
      managedTokenPresent: true,
      warnings: [],
    });
    harness.runtime.listModels.mockResolvedValue([
      {
        providerId: "minimax",
        modelId: "MiniMax-M3",
        displayName: "MiniMax-M3",
        selected: true,
        variant: "thinking",
        contextLimit: 512_000,
        contextWindowOptions: [512_000, 1_000_000],
        thinkingConfig: { mode: "switchable", defaultValue: "true" },
      },
    ]);
    harness.runtime.selectModel.mockResolvedValueOnce(true);

    await harness.flow.showModelPicker("");
    const picker = harness.shown[0] as { handleInput(data: string): void };

    picker.handleInput("\t");
    picker.handleInput("\u001b[D");
    expect(harness.runtime.selectModel).not.toHaveBeenCalled();
    picker.handleInput("\r");

    await vi.waitFor(() =>
      expect(harness.runtime.selectModel).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "minimax",
          modelId: "MiniMax-M3",
          variant: "",
          contextLimit: 1_000_000,
        }),
        "session-a",
      ),
    );
    expect(harness.append).toHaveBeenCalledWith(
      "Model selected: minimax/MiniMax-M3 · Thinking Off · Context 1M for this session and saved as the default.",
    );
    expect(
      harness.append.mock.calls.filter(([, kind]) => kind === "warning"),
    ).toHaveLength(0);
  });
});
