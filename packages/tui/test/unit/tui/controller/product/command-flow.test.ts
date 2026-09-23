import { describe, expect, it, vi } from "vitest";
import { TuiCommandFlow } from "../../../../../src/tui/controller/product/command-flow.js";
import {
  MINIMAX_CODE_TUI_LOGIN_REQUIRED_MESSAGE,
  TuiLoginRequiredError,
} from "../../../../../src/application/login-gate.js";

function createFeatureFlowMock() {
  return {
    skillCommands: () => [],
    waitForWelcomeModelSelection: vi.fn(async () => undefined),
    applyPendingModelSelection: vi.fn(async () => undefined),
    applyPendingModelSelection: vi.fn(async () => undefined),
    showChangelog: vi.fn(async () => undefined),
  };
}

function createReadinessCommandFlow(options: {
  whenReady: () => Promise<void>;
  whenControllerReady?: () => Promise<void>;
  showHelp?: () => void | Promise<void>;
  showChangelog?: () => void | Promise<void>;
  showTasks?: () => void | Promise<void>;
  showStatusLine?: () => void;
  showAccountStatus?: () => void | Promise<void>;
  copyLastAssistantReply?: () => void | Promise<void>;
  exportCurrentTranscript?: (args: string) => void | Promise<void>;
  hasSession?: boolean;
  setHint?: (message: string | undefined) => void;
  surface?: {
    show(component: unknown): void;
    close(component?: unknown): boolean;
  };
  surfaceHost?: {
    getChatMode(): "regular" | "fullscreen";
    setChatMode(mode: "regular" | "fullscreen"): boolean;
  };
  persistTuiMode?: (mode: "regular" | "fullscreen") => void;
  reloadTui?: () => Promise<void>;
  append?: (text: string, kind?: "info" | "warning" | "error") => void;
  queuedCount?: number;
}) {
  return new TuiCommandFlow({
    workspaceDir: "/workspace",
    controller: {
      snapshot: vi.fn(() => ({
        status: "idle" as const,
        sessions: [],
        ...(options.hasSession ? { session: { sessionId: "session-a" } } : {}),
      })),
    } as never,
    activeRunFlow: { showHelp: options.showHelp ?? vi.fn() } as never,
    featureFlow: {
      ...createFeatureFlowMock(),
      skillCommands: () => [],
      showAccountStatus: options.showAccountStatus ?? vi.fn(),
      showChangelog: options.showChangelog ?? vi.fn(),
      copyLastAssistantReply: options.copyLastAssistantReply ?? vi.fn(),
      exportCurrentTranscript: options.exportCurrentTranscript ?? vi.fn(),
    } as never,
    feedbackFlow: {} as never,
    updateFlow: {} as never,
    interactionFlow: {
      handleCommand: vi.fn(async () => false),
      hasPending: vi.fn(() => false),
    } as never,
    sessionFlow: {} as never,
    queueFlow: {} as never,
    composerDraft: { hasContent: vi.fn(() => false) } as never,
    workspaceRoots: { additionalDirectories: () => [] } as never,
    runProjection: {
      snapshot: () => ({ queuedCount: options.queuedCount ?? 0 }),
    } as never,
    editor: {} as never,
    surface: (options.surface ?? {}) as never,
    surfaceHost: (options.surfaceHost ?? {}) as never,
    ...(options.showTasks ? { showTasks: options.showTasks } : {}),
    persistTuiMode: options.persistTuiMode,
    showStatusLine: options.showStatusLine,
    reloadTui: options.reloadTui,
    queueEnabled: true,
    liveRunId: () => undefined,
    runtimeStopping: () => false,
    abortLiveTurn: vi.fn(async () => false),
    leaveUi: vi.fn(async () => undefined),
    whenReady: options.whenReady,
    ...(options.whenControllerReady
      ? { whenControllerReady: options.whenControllerReady }
      : {}),
    append: options.append ?? vi.fn(),
    setHint: options.setHint ?? vi.fn(),
    onChanged: vi.fn(),
  });
}

describe("TuiCommandFlow", () => {
  it("opens /statusline locally without waiting for hydration or submitting a model turn", async () => {
    const showStatusLine = vi.fn();
    const whenReady = vi.fn(() => new Promise<void>(() => undefined));
    const flow = createReadinessCommandFlow({ whenReady, showStatusLine });
    await expect(flow.submit("/statusline")).resolves.toBe("consumed");
    expect(showStatusLine).toHaveBeenCalledOnce();
    expect(whenReady).not.toHaveBeenCalled();
  });
  it("opens local help without waiting for application hydration", async () => {
    let releaseReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const showHelp = vi.fn();
    const flow = createReadinessCommandFlow({
      whenReady: () => ready,
      showHelp,
    });

    const opening = flow.submit("/help");

    await vi.waitFor(() => expect(showHelp).toHaveBeenCalledOnce());
    await expect(opening).resolves.toBe("consumed");
    releaseReady?.();
  });

  it("opens the packaged changelog through the command catalog", async () => {
    const showChangelog = vi.fn(async () => undefined);
    const flow = createReadinessCommandFlow({
      whenReady: async () => undefined,
      showChangelog,
    });

    await expect(flow.submit("/changelog")).resolves.toBe("consumed");

    expect(showChangelog).toHaveBeenCalledOnce();
  });

  it("submits /review with hidden fixed transport and local_changes provenance", async () => {
    const submit = vi.fn(
      async (
        _content: string,
        options: {
          onSessionResolved?: (sessionId: string) => void;
          onRuntimeAccepted?: (sessionId: string) => void;
        },
      ) => {
        options.onSessionResolved?.("session-a");
        options.onRuntimeAccepted?.("session-a");
        return "succeeded" as const;
      },
    );
    const attachment = {
      type: "file" as const,
      filePath: "/workspace/context.txt",
      fileName: "context.txt",
      mimeType: "text/plain",
      sizeBytes: 10,
    };
    const resources = { attachments: [attachment] };
    const restoreSubmission = vi.fn();
    const completeSubmission = vi.fn(async () => undefined);
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: {
        snapshot: vi.fn(() => ({
          status: "idle" as const,
          sessions: [],
          session: { sessionId: "session-a" },
        })),
        submit,
        refreshSessionMetadata: vi.fn(async () => undefined),
      } as never,
      activeRunFlow: {} as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: {} as never,
      queueFlow: {} as never,
      composerDraft: {
        hasContent: vi.fn(() => false),
        capture: vi.fn(() => resources),
        reserveSubmission: vi.fn(),
        restoreSubmission,
        completeSubmission,
      } as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: {
        captureDraft: vi.fn(() => ({
          schemaVersion: 1,
          text: "/review",
          cursor: 7,
          pastes: [],
          pasteCounter: 0,
        })),
      } as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => undefined,
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });

    await expect(
      flow.submit("/review", {
        sessionId: "session-a",
        editor: {
          schemaVersion: 1,
          text: "/review",
          cursor: 7,
          pastes: [],
          pasteCounter: 0,
        },
        resources,
      }),
    ).resolves.toBe("consumed");

    expect(restoreSubmission).toHaveBeenCalledWith(resources);
    expect(submit).toHaveBeenCalledWith(
      "Please review my uncommitted changes.",
      expect.objectContaining({
        displayContent: "/review",
        reviewRequest: { scope: "local_changes" },
        attachments: [],
      }),
    );
    expect(completeSubmission).toHaveBeenCalledWith({ attachments: [] });
  });

  it("opens the unified background task center for the current Session", async () => {
    const showTasks = vi.fn(async () => undefined);
    const flow = createReadinessCommandFlow({
      whenReady: async () => undefined,
      hasSession: true,
      showTasks,
    });

    await expect(flow.submit("/tasks")).resolves.toBe("consumed");

    expect(showTasks).toHaveBeenCalledOnce();
  });

  it("starts status after controller hydration without waiting for unrelated readiness", async () => {
    const fullReady = new Promise<void>(() => undefined);
    let releaseController: (() => void) | undefined;
    const controllerReady = new Promise<void>((resolve) => {
      releaseController = resolve;
    });
    let releaseStatus: (() => void) | undefined;
    const status = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const showAccountStatus = vi.fn(() => status);
    const setHint = vi.fn();
    const flow = createReadinessCommandFlow({
      whenReady: () => fullReady,
      whenControllerReady: () => controllerReady,
      showAccountStatus,
      setHint,
    });

    const loading = flow.submit("/status");

    expect(setHint).toHaveBeenCalledWith("Loading account status…");
    expect(showAccountStatus).not.toHaveBeenCalled();
    releaseController?.();
    await vi.waitFor(() => expect(showAccountStatus).toHaveBeenCalledOnce());
    expect(setHint).toHaveBeenLastCalledWith("Loading account status…");
    releaseStatus?.();
    await expect(loading).resolves.toBe("consumed");
    expect(setHint).toHaveBeenLastCalledWith(undefined);
  });

  it("dispatches /copy to the latest Assistant response clipboard action", async () => {
    const copyLastAssistantReply = vi.fn(async () => undefined);
    const flow = createReadinessCommandFlow({
      whenReady: vi.fn(async () => undefined),
      copyLastAssistantReply,
      hasSession: true,
    });

    await expect(flow.submit("/copy")).resolves.toBe("consumed");

    expect(copyLastAssistantReply).toHaveBeenCalledOnce();
  });

  it("dispatches /export with the requested Markdown path", async () => {
    const exportCurrentTranscript = vi.fn(async () => undefined);
    const flow = createReadinessCommandFlow({
      whenReady: vi.fn(async () => undefined),
      exportCurrentTranscript,
      hasSession: true,
    });

    await expect(flow.submit('/export "docs/session.md"')).resolves.toBe(
      "consumed",
    );

    expect(exportCurrentTranscript).toHaveBeenCalledWith('"docs/session.md"');
  });

  it("switches and persists the explicitly selected TUI mode", async () => {
    const surface = { show: vi.fn(), close: vi.fn(() => true) };
    const surfaceHost = {
      getChatMode: vi.fn(() => "regular" as const),
      setChatMode: vi.fn(() => true),
    };
    const persistTuiMode = vi.fn();
    const flow = createReadinessCommandFlow({
      whenReady: vi.fn(async () => undefined),
      surface,
      surfaceHost,
      persistTuiMode,
    });

    await expect(flow.submit("/settings")).resolves.toBe("consumed");
    const picker = surface.show.mock.calls.at(-1)?.[0] as {
      handleInput(data: string): void;
    };
    picker.handleInput("\u001b[B");
    picker.handleInput("\r");

    expect(surfaceHost.setChatMode).toHaveBeenCalledWith("fullscreen");
    expect(persistTuiMode).toHaveBeenCalledWith("fullscreen");
    expect(surface.close).toHaveBeenCalledWith(picker);
  });

  it("reloads TUI configuration only while the product is idle", async () => {
    const reloadTui = vi.fn(async () => undefined);
    const setHint = vi.fn();
    const flow = createReadinessCommandFlow({
      whenReady: vi.fn(async () => undefined),
      reloadTui,
      setHint,
    });

    await expect(flow.submit("/reload")).resolves.toBe("consumed");

    expect(reloadTui).toHaveBeenCalledOnce();
    expect(setHint).toHaveBeenCalledWith("Reloading TUI configuration…");
    expect(setHint).toHaveBeenLastCalledWith("TUI configuration reloaded.");
  });

  it.each(['Plugin refresh failed', 'Invalid keybindings.json'])("preserves /reload cause: %s", async (message) => {
    const append = vi.fn();
    const flow = createReadinessCommandFlow({
      whenReady: async () => {}, append,
      reloadTui: async () => { throw new Error(message); },
    });
    await expect(flow.submit('/reload')).resolves.toBe('consumed');
    expect(append).toHaveBeenCalledWith(expect.stringContaining(message), 'warning');
    expect(append).toHaveBeenCalledWith(expect.stringContaining('configuration or plugin refresh error'), 'warning');
    expect(JSON.stringify(append.mock.calls)).not.toContain('Fix keybindings.json');
  });

  it("retains /reload while queued work is present", async () => {
    const reloadTui = vi.fn(async () => undefined);
    const setHint = vi.fn();
    const flow = createReadinessCommandFlow({
      whenReady: vi.fn(async () => undefined),
      reloadTui,
      queuedCount: 1,
      setHint,
    });

    await expect(flow.submit("/reload")).resolves.toBe("retained");

    expect(reloadTui).not.toHaveBeenCalled();
    expect(setHint).toHaveBeenCalledWith(
      "Clear the Queue before reloading TUI.",
    );
  });

  it.each([
    {
      prompt: "/context  这样还是会显示上下文信息",
      stagesOptimistically: true,
    },
    { prompt: "/ALLOW", stagesOptimistically: false },
  ])(
    "submits command-like prompt $prompt after TUI readiness settles",
    async ({ prompt, stagesOptimistically }) => {
      let releaseReady: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        releaseReady = resolve;
      });
      const projectOptimisticUserMessage = vi.fn();
      const removeOptimisticUserMessage = vi.fn();
      const submit = vi.fn(async () => "succeeded" as const);
      const resources = { attachments: [] };
      const flow = new TuiCommandFlow({
        workspaceDir: "/workspace",
        controller: {
          snapshot: vi.fn(() => ({
            status: "idle" as const,
            sessions: [],
            session: { sessionId: "session-a" },
          })),
          projectOptimisticUserMessage,
          removeOptimisticUserMessage,
          submit,
        } as never,
        activeRunFlow: {} as never,
        featureFlow: createFeatureFlowMock() as never,
        feedbackFlow: {} as never,
        updateFlow: {} as never,
        interactionFlow: {
          handleCommand: vi.fn(async () => false),
          hasPending: vi.fn(() => false),
        } as never,
        sessionFlow: {} as never,
        queueFlow: {} as never,
        composerDraft: {
          hasContent: vi.fn(() => false),
          completeSubmission: vi.fn(async () => undefined),
        } as never,
        workspaceRoots: { additionalDirectories: () => [] } as never,
        runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
        editor: {} as never,
        surface: {} as never,
        surfaceHost: {} as never,
        queueEnabled: true,
        liveRunId: () => undefined,
        runtimeStopping: () => false,
        abortLiveTurn: vi.fn(async () => false),
        leaveUi: vi.fn(async () => undefined),
        whenReady: vi.fn(() => ready),
        append: vi.fn(),
        setHint: vi.fn(),
        onChanged: vi.fn(),
        userMessageCount: () => 0,
      });
      const seed = {
        sessionId: "session-a",
        editor: {
          schemaVersion: 1 as const,
          text: prompt,
          cursor: prompt.length,
          pasteCounter: 0,
          pastes: [],
        },
        resources,
      };

      const sending = flow.submit(prompt, seed);

      if (stagesOptimistically) {
        expect(projectOptimisticUserMessage).toHaveBeenCalledWith(
          expect.stringMatching(/^\d+-\d+$/u),
          prompt,
          expect.any(Number),
          [],
        );
      } else {
        expect(projectOptimisticUserMessage).not.toHaveBeenCalled();
      }
      expect(submit).not.toHaveBeenCalled();

      releaseReady?.();
      await expect(sending).resolves.toBe("consumed");
      expect(submit).toHaveBeenCalledWith(
        prompt,
        expect.objectContaining({ attachments: [] }),
      );
      if (stagesOptimistically)
        expect(removeOptimisticUserMessage).toHaveBeenCalled();
    },
  );

  it("reserves one captured seed and restores its resources before a Session command", async () => {
    const editorDraft = {
      schemaVersion: 1 as const,
      text: "/new [Image #1] ",
      cursor: 4,
      pasteCounter: 0,
      pastes: [],
      attachmentPlaceholders: [
        { id: "/tmp/a.png", label: "[Image #1]", start: 5, end: 15 },
      ],
    };
    const resources = {
      attachments: [
        { filePath: "/tmp/a.png", fileName: "a.png", mimeType: "image/png" },
      ],
    };
    const reserveSubmission = vi.fn();
    const restoreSubmission = vi.fn();
    const startNew = vi.fn();
    const projectOptimisticUserMessage = vi.fn();
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: {
        snapshot: vi.fn(() => ({
          status: "idle" as const,
          sessions: [],
          session: { sessionId: "session-a" },
        })),
        projectOptimisticUserMessage,
      } as never,
      activeRunFlow: {} as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: { startNew } as never,
      queueFlow: {} as never,
      composerDraft: {
        capture: vi.fn(() => resources),
        reserveSubmission,
        restoreSubmission,
        hasContent: vi.fn(() => false),
      } as never,
      workspaceRoots: {
        additionalDirectories: () => ["/captured-root"],
      } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: { captureDraft: vi.fn(() => editorDraft) } as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => undefined,
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });

    const seed = flow.captureSubmissionSeed(editorDraft);
    await expect(flow.submit("/new", seed)).resolves.toBe("consumed");

    expect(seed).toEqual({
      sessionId: "session-a",
      editor: editorDraft,
      resources,
    });
    expect(reserveSubmission).toHaveBeenCalledWith(resources);
    expect(restoreSubmission).toHaveBeenCalledWith(resources);
    expect(restoreSubmission.mock.invocationCallOrder[0]).toBeLessThan(
      startNew.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(projectOptimisticUserMessage).not.toHaveBeenCalled();
  });

  it("keeps Goal command attachments in the Composer instead of submitting an ordinary Turn", async () => {
    const attachment = {
      type: "image" as const,
      filePath: "/tmp/goal.png",
      fileName: "goal.png",
      mimeType: "image/png",
      sizeBytes: 100,
    };
    const resources = { attachments: [attachment] };
    const restoreSubmission = vi.fn();
    const executeGoal = vi.fn(async () => "consumed" as const);
    const submit = vi.fn(async () => "succeeded" as const);
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: {
        snapshot: vi.fn(() => ({
          status: "idle" as const,
          sessions: [],
          session: { sessionId: "session-a" },
        })),
        submit,
      } as never,
      activeRunFlow: {} as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      goalFlow: { execute: executeGoal },
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: {} as never,
      queueFlow: {} as never,
      composerDraft: {
        hasContent: vi.fn(() => false),
        restoreSubmission,
      } as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: {} as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => undefined,
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });
    const seed = {
      sessionId: "session-a",
      editor: {
        schemaVersion: 1 as const,
        text: "/goal clear",
        cursor: 11,
        pasteCounter: 0,
        pastes: [],
      },
      resources,
    };

    await expect(flow.submit("/goal clear", seed)).resolves.toBe("consumed");

    expect(restoreSubmission).toHaveBeenCalledWith(resources);
    expect(executeGoal).toHaveBeenCalledWith("clear");
    expect(restoreSubmission.mock.invocationCallOrder[0]).toBeLessThan(
      executeGoal.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("admits an attachment-only captured Submission", async () => {
    const attachment = {
      filePath: "/tmp/a.png",
      fileName: "a.png",
      mimeType: "image/png",
    };
    const submit = vi.fn(async () => "succeeded" as const);
    const completeSubmission = vi.fn(async () => undefined);
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: {
        snapshot: vi.fn(() => ({
          status: "idle" as const,
          sessions: [],
          session: { sessionId: "session-a" },
        })),
        submit,
      } as never,
      activeRunFlow: {} as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: {} as never,
      queueFlow: {} as never,
      composerDraft: {
        hasContent: vi.fn(() => false),
        completeSubmission,
      } as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: {} as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => undefined,
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });
    const resources = { attachments: [attachment] };

    await expect(
      flow.submit("", {
        sessionId: "session-a",
        editor: {
          schemaVersion: 1,
          text: "[Image #1] ",
          cursor: 0,
          pasteCounter: 0,
          pastes: [],
        },
        resources,
      }),
    ).resolves.toBe("consumed");

    expect(submit).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ attachments: [attachment] }),
    );
    expect(completeSubmission).toHaveBeenCalledWith(resources);
  });

  it("sends directory-like @ text without resolving a directory reference", async () => {
    const resolveMentionedDirectories = vi.fn(async () => [
      {
        schemaVersion: 1 as const,
        referenceId: "dirref_src",
        rootName: "src",
        rootPath: "/workspace/src",
      },
    ]);
    const submit = vi.fn(async () => "succeeded" as const);
    const completeSubmission = vi.fn(async () => undefined);
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: {
        snapshot: vi.fn(() => ({
          status: "idle" as const,
          sessions: [],
          session: { sessionId: "session-a" },
        })),
        submit,
      } as never,
      activeRunFlow: {} as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: {} as never,
      queueFlow: {} as never,
      composerDraft: {
        hasContent: vi.fn(() => false),
        resolveMentionedDirectories,
        completeSubmission,
      } as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: {} as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => undefined,
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });
    const resources = { attachments: [] };

    await expect(
      flow.submit("Review @src/ ", {
        sessionId: "session-a",
        editor: {
          schemaVersion: 1,
          text: "Review @src/ ",
          cursor: 13,
          pasteCounter: 0,
          pastes: [],
        },
        resources,
      }),
    ).resolves.toBe("consumed");

    expect(resolveMentionedDirectories).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(
      "Review @src/",
      expect.objectContaining({ attachments: [] }),
    );
    expect(completeSubmission).toHaveBeenCalledWith(resources);
  });

  it("waits for Draft recovery before releasing a Submission during shutdown", async () => {
    let stopped = false;
    let finishPrimary: ((status: "cancelled") => void) | undefined;
    let finishRecovery: (() => void) | undefined;
    const primary = new Promise<"cancelled">((resolve) => {
      finishPrimary = resolve;
    });
    const recovery = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    const completeSubmission = vi.fn(async () => undefined);
    const submit = vi.fn(() => primary);
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: {
        snapshot: vi.fn(() => ({
          status: "idle" as const,
          sessions: [],
          session: { sessionId: "session-a" },
        })),
        submit,
      } as never,
      activeRunFlow: {} as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: {} as never,
      queueFlow: {} as never,
      composerDraft: {
        hasContent: vi.fn(() => false),
        completeSubmission,
      } as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: {} as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => undefined,
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      whenStopping: vi.fn(() => recovery),
      isStopped: () => stopped,
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });
    const resources = {
      attachments: [
        { filePath: "/tmp/a.png", fileName: "a.png", mimeType: "image/png" },
      ],
    };

    const sending = flow.submit("preserve attachment", {
      sessionId: "session-a",
      editor: {
        schemaVersion: 1,
        text: "preserve attachment",
        cursor: 19,
        pasteCounter: 0,
        pastes: [],
      },
      resources,
    });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());

    stopped = true;
    finishPrimary?.("cancelled");
    await Promise.resolve();
    expect(completeSubmission).not.toHaveBeenCalled();

    finishRecovery?.();
    await expect(sending).resolves.toBe("consumed");
    expect(completeSubmission).toHaveBeenCalledWith(resources);
  });

  it("routes a rapid follow-up into the Runtime queue", async () => {
    let liveRunId: string | undefined;
    let finishPrimary: ((status: "succeeded") => void) | undefined;
    let releaseQueueLogin: (() => void) | undefined;
    const primary = new Promise<"succeeded">((resolve) => {
      finishPrimary = resolve;
    });
    const queueLogin = new Promise<void>((resolve) => {
      releaseQueueLogin = resolve;
    });
    const projectOptimisticUserMessage = vi.fn();
    const controller = {
      snapshot: vi.fn(() => ({
        status: liveRunId ? ("running" as const) : ("idle" as const),
        sessions: [],
        session: { sessionId: "session-1" },
        activeTurnId: liveRunId,
      })),
      submit: vi.fn(() => {
        liveRunId = "turn-1";
        return primary;
      }),
      requireLoginForAgentAction: vi.fn(() => queueLogin),
      projectOptimisticUserMessage,
      removeOptimisticUserMessage: vi.fn(),
    };
    const composerDraft = {
      hasContent: vi.fn(() => false),
      capture: vi.fn(() => ({
        attachments: [],
      })),
      reserveSubmission: vi.fn(() => ({
        attachments: [],
      })),
      restoreSubmission: vi.fn(),
      completeSubmission: vi.fn(async () => undefined),
    };
    const queueFlow = {
      beginAdmission: vi.fn(),
      cancelAdmission: vi.fn(),
      enqueue: vi.fn(async () => undefined),
    };
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: controller as never,
      activeRunFlow: {} as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
        showPending: vi.fn(),
      } as never,
      sessionFlow: {} as never,
      queueFlow: queueFlow as never,
      composerDraft: composerDraft as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: { setText: vi.fn() } as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => liveRunId,
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });

    const first = flow.submit("first");
    await vi.waitFor(() => expect(controller.submit).toHaveBeenCalledTimes(1));
    const followUpSeed = {
      sessionId: "session-1",
      editor: {
        schemaVersion: 1 as const,
        text: "follow-up",
        cursor: 9,
        pasteCounter: 0,
        pastes: [],
      },
      resources: { attachments: [] },
    };
    const followUp = flow.submit("follow-up", followUpSeed);

    expect(projectOptimisticUserMessage).not.toHaveBeenCalled();
    expect(queueFlow.beginAdmission).toHaveBeenCalledWith(
      expect.stringMatching(/^\d+-\d+$/u),
      "follow-up",
      [],
    );
    expect(queueFlow.enqueue).not.toHaveBeenCalled();

    releaseQueueLogin?.();
    await vi.waitFor(() => expect(queueFlow.enqueue).toHaveBeenCalledTimes(1));
    await expect(followUp).resolves.toBe("consumed");
    expect(projectOptimisticUserMessage).not.toHaveBeenCalled();
    expect(controller.submit).toHaveBeenCalledTimes(1);
    expect(queueFlow.enqueue).toHaveBeenCalledWith(
      "follow-up",
      expect.objectContaining({ attachments: [] }),
      expect.objectContaining({ content: "follow-up" }),
      expect.stringMatching(/^\d+-\d+$/u),
    );

    finishPrimary?.("succeeded");
    await expect(first).resolves.toBe("consumed");
    expect(composerDraft.completeSubmission).toHaveBeenCalledTimes(1);
  });

  it("steers an active Turn with Enter intent and preserves structured attachments", async () => {
    const attachment = {
      type: "image" as const,
      filePath: "/workspace/diagram.png",
      fileName: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const activeRunFlow = { steer: vi.fn(async () => true) };
    const controller = {
      snapshot: vi.fn(() => ({
        status: "running" as const,
        sessions: [],
        session: { sessionId: "session-1" },
        activeTurnId: "turn-active",
      })),
      hasInProcessRun: vi.fn(() => true),
      requireLoginForAgentAction: vi.fn(async () => undefined),
      projectOptimisticUserMessage: vi.fn(),
      removeOptimisticUserMessage: vi.fn(),
    };
    const composerDraft = {
      hasContent: vi.fn(() => false),
      restoreSubmission: vi.fn(),
      completeSubmission: vi.fn(async () => undefined),
    };
    const queueFlow = {
      beginAdmission: vi.fn(),
      cancelAdmission: vi.fn(),
      enqueue: vi.fn(async () => undefined),
    };
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: controller as never,
      activeRunFlow: activeRunFlow as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: {} as never,
      queueFlow: queueFlow as never,
      composerDraft: composerDraft as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: {} as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => "turn-active",
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });
    const seed = {
      sessionId: "session-1",
      editor: {
        schemaVersion: 1 as const,
        text: "[Image #1] focus on this diagram",
        cursor: 32,
        pasteCounter: 0,
        pastes: [],
      },
      resources: { attachments: [attachment] },
    };

    await expect(
      flow.submit("focus on this diagram", seed, { busyAction: "steer" }),
    ).resolves.toBe("consumed");

    expect(activeRunFlow.steer).toHaveBeenCalledWith("focus on this diagram", {
      requireActiveTurn: true,
      attachments: [attachment],
      transcriptAttachments: [attachment],
    });
    expect(queueFlow.beginAdmission).not.toHaveBeenCalled();
    expect(queueFlow.enqueue).not.toHaveBeenCalled();
    expect(controller.projectOptimisticUserMessage).not.toHaveBeenCalled();
    expect(composerDraft.completeSubmission).toHaveBeenCalledWith({
      attachments: [attachment],
    });
  });

  it.each([
    ["accepts the handoff", false, "queue-item-1"],
    ["rejects the handoff", true, undefined],
    ["drops a stale Session result", false, undefined],
  ] as const)(
    "preserves direct-admission semantics when the Runtime queue %s",
    async (_scenario, enqueueFails, queuedItemId) => {
      const draft = { attachments: [] };
      const append = vi.fn();
      const onMessageAdmitted = vi.fn();
      const controller = {
        snapshot: vi.fn(() => ({
          status: "idle" as const,
          sessions: [],
          session: { sessionId: "session-1" },
          activeTurnId: undefined,
        })),
        submit: vi.fn(async () => "queue-required" as const),
        requireLoginForAgentAction: vi.fn(async () => undefined),
      };
      const composerDraft = {
        hasContent: vi.fn(() => false),
        reserveSubmission: vi.fn(() => draft),
        restoreSubmission: vi.fn(),
        completeSubmission: vi.fn(async () => undefined),
      };
      const queueFlow = {
        beginAdmission: vi.fn(),
        cancelAdmission: vi.fn(),
        enqueue: vi.fn(async () => {
          if (enqueueFails) throw new Error("queue unavailable");
          return queuedItemId;
        }),
      };
      const flow = new TuiCommandFlow({
        workspaceDir: "/workspace",
        controller: controller as never,
        activeRunFlow: {} as never,
        featureFlow: createFeatureFlowMock() as never,
        feedbackFlow: {} as never,
        updateFlow: {} as never,
        interactionFlow: {
          handleCommand: vi.fn(async () => false),
          hasPending: vi.fn(() => false),
        } as never,
        sessionFlow: {} as never,
        queueFlow: queueFlow as never,
        composerDraft: composerDraft as never,
        workspaceRoots: { additionalDirectories: () => [] } as never,
        runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
        editor: {} as never,
        surface: {} as never,
        surfaceHost: {} as never,
        queueEnabled: true,
        liveRunId: () => undefined,
        runtimeStopping: () => false,
        abortLiveTurn: vi.fn(async () => false),
        leaveUi: vi.fn(async () => undefined),
        whenReady: vi.fn(async () => undefined),
        append,
        setHint: vi.fn(),
        onChanged: vi.fn(),
        onMessageAdmitted,
      });

      await expect(flow.submit("follow-up")).resolves.toBe(
        enqueueFails ? "retained" : "consumed",
      );

      expect(queueFlow.enqueue).toHaveBeenCalledWith(
        "follow-up",
        draft,
        undefined,
        expect.stringMatching(/^\d+-\d+$/u),
      );
      expect(queueFlow.beginAdmission).toHaveBeenCalledWith(
        expect.stringMatching(/^\d+-\d+$/u),
        "follow-up",
        [],
      );
      expect(composerDraft.completeSubmission).not.toHaveBeenCalled();
      if (queuedItemId) {
        expect(onMessageAdmitted).toHaveBeenCalledOnce();
      } else {
        expect(onMessageAdmitted).not.toHaveBeenCalled();
      }
      if (enqueueFails) {
        expect(queueFlow.cancelAdmission).toHaveBeenCalledWith(
          expect.stringMatching(/^\d+-\d+$/u),
        );
        expect(composerDraft.restoreSubmission).toHaveBeenCalledWith(draft);
        expect(append).toHaveBeenCalledWith(
          "Couldn't add this message to the Queue: queue unavailable. Retry after the current response finishes. Your draft is preserved.",
          "warning",
        );
      } else {
        expect(queueFlow.cancelAdmission).not.toHaveBeenCalled();
        expect(composerDraft.restoreSubmission).not.toHaveBeenCalled();
      }
    },
  );

  it("moves a direct optimistic message into Queue projection on queue-required fallback", async () => {
    const projectOptimisticUserMessage = vi.fn();
    const removeOptimisticUserMessage = vi.fn();
    const beginAdmission = vi.fn();
    const enqueue = vi.fn(async () => undefined);
    const draft = { attachments: [] };
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: {
        snapshot: vi.fn(() => ({
          status: "idle" as const,
          sessions: [],
          session: { sessionId: "session-1" },
        })),
        submit: vi.fn(async () => "queue-required" as const),
        requireLoginForAgentAction: vi.fn(async () => undefined),
        projectOptimisticUserMessage,
        removeOptimisticUserMessage,
      } as never,
      activeRunFlow: {} as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: {} as never,
      queueFlow: {
        beginAdmission,
        cancelAdmission: vi.fn(),
        enqueue,
      } as never,
      composerDraft: {
        hasContent: vi.fn(() => false),
        completeSubmission: vi.fn(async () => undefined),
      } as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: {} as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => undefined,
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });
    const seed = {
      sessionId: "session-1",
      editor: {
        schemaVersion: 1 as const,
        text: "follow-up",
        cursor: 9,
        pasteCounter: 0,
        pastes: [],
      },
      resources: draft,
    };

    await expect(flow.submit("follow-up", seed)).resolves.toBe("consumed");

    expect(projectOptimisticUserMessage).toHaveBeenCalledOnce();
    expect(
      removeOptimisticUserMessage.mock.invocationCallOrder[0],
    ).toBeLessThan(
      beginAdmission.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(enqueue).toHaveBeenCalledWith(
      "follow-up",
      draft,
      expect.objectContaining({ content: "follow-up" }),
      expect.stringMatching(/^\d+-\d+$/u),
    );
  });

  it("preserves the draft and guides login when a direct Agent Turn is blocked", async () => {
    const draft = { attachments: [] };
    const append = vi.fn();
    const controller = {
      snapshot: vi.fn(() => ({ status: "idle" as const, sessions: [] })),
      submit: vi.fn(async () => {
        throw new TuiLoginRequiredError(
          { status: "needs-login", managedTokenPresent: false, warnings: [] },
          MINIMAX_CODE_TUI_LOGIN_REQUIRED_MESSAGE,
        );
      }),
      requireLoginForAgentAction: vi.fn(async () => undefined),
    };
    const composerDraft = {
      hasContent: vi.fn(() => false),
      reserveSubmission: vi.fn(() => draft),
      restoreSubmission: vi.fn(),
      completeSubmission: vi.fn(async () => undefined),
    };
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: controller as never,
      activeRunFlow: {} as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: {} as never,
      queueFlow: {} as never,
      composerDraft: composerDraft as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: {} as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => undefined,
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append,
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });

    await expect(flow.submit("retry after login")).resolves.toBe("retained");

    expect(composerDraft.restoreSubmission).toHaveBeenCalledWith(draft);
    expect(composerDraft.completeSubmission).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      MINIMAX_CODE_TUI_LOGIN_REQUIRED_MESSAGE,
      "warning",
    );
  });

  it("restores one atomic Submission to the Composer when admission throws synchronously", async () => {
    const restoreSubmittedDraft = vi.fn(() => true);
    const setChatFocus = vi.fn();
    const controller = {
      snapshot: vi.fn(() => ({
        status: "idle" as const,
        sessions: [],
        session: { sessionId: "session-1" },
      })),
      submit: vi.fn(() => {
        throw new Error("admission failed");
      }),
      requireLoginForAgentAction: vi.fn(async () => undefined),
    };
    const composerDraft = {
      hasContent: vi.fn(() => true),
      reserveSubmission: vi.fn(),
      restoreSubmission: vi.fn(),
      completeSubmission: vi.fn(async () => undefined),
    };
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: controller as never,
      activeRunFlow: {} as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: {} as never,
      queueFlow: {} as never,
      composerDraft: composerDraft as never,
      workspaceRoots: { additionalDirectories: () => ["/shared"] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: { restoreSubmittedDraft } as never,
      surface: {} as never,
      surfaceHost: { setChatFocus } as never,
      queueEnabled: true,
      liveRunId: () => undefined,
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });
    const seed = {
      sessionId: "session-1",
      editor: {
        schemaVersion: 1 as const,
        text: "send A",
        cursor: 6,
        pasteCounter: 0,
        pastes: [],
      },
      resources: {
        attachments: [],
      },
    };

    await expect(flow.submit("send A", seed)).resolves.toBe("retained");

    expect(restoreSubmittedDraft).toHaveBeenCalledWith(seed.editor);
    expect(composerDraft.restoreSubmission).toHaveBeenCalledWith(
      seed.resources,
    );
    expect(setChatFocus).toHaveBeenCalled();
  });

  it.each(["failed", "retracted"] as const)(
    "restores an atomic Submission to the Composer when the Turn is %s",
    async (status) => {
      const restoreSubmittedDraft = vi.fn(() => true);
      const restoreSubmission = vi.fn();
      const flow = new TuiCommandFlow({
        workspaceDir: "/workspace",
        controller: {
          snapshot: vi.fn(() => ({
            status: "idle" as const,
            sessions: [],
            session: { sessionId: "session-1" },
          })),
          submit: vi.fn(async () => status),
        } as never,
        activeRunFlow: {} as never,
        featureFlow: createFeatureFlowMock() as never,
        feedbackFlow: {} as never,
        updateFlow: {} as never,
        interactionFlow: {
          handleCommand: vi.fn(async () => false),
          hasPending: vi.fn(() => false),
        } as never,
        sessionFlow: {} as never,
        queueFlow: {} as never,
        composerDraft: {
          hasContent: vi.fn(() => false),
          restoreSubmission,
        } as never,
        workspaceRoots: { additionalDirectories: () => [] } as never,
        runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
        editor: { restoreSubmittedDraft } as never,
        surface: {} as never,
        surfaceHost: { setChatFocus: vi.fn() } as never,
        queueEnabled: true,
        liveRunId: () => undefined,
        runtimeStopping: () => false,
        abortLiveTurn: vi.fn(async () => false),
        leaveUi: vi.fn(async () => undefined),
        whenReady: vi.fn(async () => undefined),
        append: vi.fn(),
        setHint: vi.fn(),
        onChanged: vi.fn(),
      });
      const seed = {
        sessionId: "session-1",
        editor: {
          schemaVersion: 1 as const,
          text: "send A",
          cursor: 6,
          pasteCounter: 0,
          pastes: [],
        },
        resources: { attachments: [] },
      };

      await expect(flow.submit("send A", seed)).resolves.toBe("retained");

      expect(restoreSubmittedDraft).toHaveBeenCalledWith(seed.editor);
      expect(restoreSubmission).toHaveBeenCalledWith(seed.resources);
    },
  );

  it("restores a captured Submission to the Composer when focus changes before admission", async () => {
    const restoreSubmittedDraft = vi.fn(() => true);
    const restoreSubmission = vi.fn();
    const controller = {
      snapshot: vi.fn(() => ({
        status: "idle" as const,
        sessions: [],
        session: { sessionId: "session-b" },
      })),
      submit: vi.fn(),
      requireLoginForAgentAction: vi.fn(),
    };
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: controller as never,
      activeRunFlow: {} as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: {} as never,
      queueFlow: {} as never,
      composerDraft: {
        hasContent: vi.fn(() => true),
        restoreSubmission,
      } as never,
      workspaceRoots: {
        additionalDirectories: () => ["/current-root"],
      } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: { restoreSubmittedDraft } as never,
      surface: {} as never,
      surfaceHost: { setChatFocus: vi.fn() } as never,
      queueEnabled: true,
      liveRunId: () => undefined,
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });

    await expect(
      flow.submit("send in A", {
        sessionId: "session-a",
        editor: {
          schemaVersion: 1,
          text: "send in A",
          cursor: 9,
          pasteCounter: 0,
          pastes: [],
        },
        resources: { attachments: [] },
      }),
    ).resolves.toBe("retained");

    expect(controller.submit).not.toHaveBeenCalled();
    expect(restoreSubmittedDraft).toHaveBeenCalledWith(
      expect.objectContaining({ text: "send in A" }),
    );
    expect(restoreSubmission).toHaveBeenCalledWith({ attachments: [] });
  });

  it("does not admit protected actions when their login gate rejects", async () => {
    const loginError = new TuiLoginRequiredError(
      {
        status: "needs-login",
        managedTokenPresent: false,
        warnings: [],
      },
      MINIMAX_CODE_TUI_LOGIN_REQUIRED_MESSAGE,
    );
    const append = vi.fn();
    const queueFlow = { enqueue: vi.fn(async () => undefined) };
    const feedbackFlow = { show: vi.fn(async () => undefined) };
    const activeRunFlow = {
      handle: vi.fn(async () => {
        throw loginError;
      }),
    };
    const featureFlow = {
      skillCommands: () => [],
      compactSession: vi.fn(async () => undefined),
    };
    const controller = {
      snapshot: vi.fn(() => ({
        status: "running" as const,
        sessions: [],
        session: { sessionId: "session-1" },
        activeTurnId: "turn-1",
      })),
      submit: vi.fn(),
      requireLoginForAgentAction: vi.fn(async () => {
        throw loginError;
      }),
    };
    const composerDraft = {
      hasContent: vi.fn(() => false),
      capture: vi.fn(() => ({ attachments: [] })),
      reserveSubmission: vi.fn(),
      restoreSubmission: vi.fn(),
      completeSubmission: vi.fn(async () => undefined),
    };
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: controller as never,
      activeRunFlow: activeRunFlow as never,
      featureFlow: featureFlow as never,
      feedbackFlow: feedbackFlow as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: {} as never,
      queueFlow: queueFlow as never,
      composerDraft: composerDraft as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: {} as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => "run-1",
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append,
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });

    await expect(flow.submit("queue me")).resolves.toBe("retained");
    await expect(flow.submit("/compact")).resolves.toBe("consumed");
    await expect(flow.submit("/steer focus here")).resolves.toBe("retained");

    expect(queueFlow.enqueue).not.toHaveBeenCalled();
    expect(featureFlow.compactSession).not.toHaveBeenCalled();
    expect(activeRunFlow.handle).toHaveBeenCalledWith("/steer focus here");
    expect(append).toHaveBeenCalledWith(
      MINIMAX_CODE_TUI_LOGIN_REQUIRED_MESSAGE,
      "warning",
    );
  });

  it("retains steer text when fresh Runtime admission rejects it", async () => {
    const activeRunFlow = { handle: vi.fn(async () => false) };
    const controller = {
      snapshot: vi.fn(() => ({
        status: "running" as const,
        sessions: [],
        session: { sessionId: "session-1" },
        activeTurnId: "turn-1",
      })),
      requireLoginForAgentAction: vi.fn(async () => undefined),
    };
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: controller as never,
      activeRunFlow: activeRunFlow as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => false),
      } as never,
      sessionFlow: {} as never,
      queueFlow: {} as never,
      composerDraft: { hasContent: vi.fn(() => false) } as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: {} as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => "turn-1",
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });

    await expect(flow.submit("/steer keep this guidance")).resolves.toBe(
      "retained",
    );
    expect(activeRunFlow.handle).toHaveBeenCalledWith(
      "/steer keep this guidance",
    );
  });

  it("retains steer guidance while an Agent interaction is pending", async () => {
    const activeRunFlow = { handle: vi.fn(async () => true) };
    const showPending = vi.fn();
    const flow = new TuiCommandFlow({
      workspaceDir: "/workspace",
      controller: {
        snapshot: vi.fn(() => ({
          status: "running" as const,
          sessions: [],
          session: { sessionId: "session-1" },
          activeTurnId: "turn-1",
        })),
      } as never,
      activeRunFlow: activeRunFlow as never,
      featureFlow: createFeatureFlowMock() as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: {
        handleCommand: vi.fn(async () => false),
        hasPending: vi.fn(() => true),
        showPending,
      } as never,
      sessionFlow: {} as never,
      queueFlow: {} as never,
      composerDraft: { hasContent: vi.fn(() => false) } as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: { snapshot: () => ({ queuedCount: 0 }) } as never,
      editor: {} as never,
      surface: {} as never,
      surfaceHost: {} as never,
      queueEnabled: true,
      liveRunId: () => "turn-1",
      runtimeStopping: () => false,
      abortLiveTurn: vi.fn(async () => false),
      leaveUi: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => undefined),
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });

    await expect(flow.submit("/steer keep rollback guidance")).resolves.toBe(
      "retained",
    );
    expect(showPending).toHaveBeenCalledTimes(1);
    expect(activeRunFlow.handle).not.toHaveBeenCalled();
  });
});
