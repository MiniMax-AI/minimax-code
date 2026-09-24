import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectTerminalCapabilities,
  type TerminalCapabilities,
} from "../../src/tui/platform/terminal-capabilities.js";
import {
  TuiAltScreen,
  VStack,
  type Terminal,
} from "../../src/tui/engine/public.js";
import { createTuiProgram } from "../../src/cli/program.js";
import { resolveTuiStartupEnvironmentOption } from "../../src/cli/environment.js";
import { runTuiCli } from "../../src/cli/main.js";
import { launchTui } from "../../src/tui/launcher.js";
import { createTuiApp } from "../../src/tui/app.js";
import { TuiChatLayout } from "../../src/tui/shell/chat-layout.js";
import type {
  TuiModel,
  TuiQuestionnaireRequest,
  TuiQueuedMessage,
  TuiRuntimeEvent,
  TuiRuntime,
  TuiSessionForkPort,
  TuiStreamEvent,
} from "../../src/runtime/port.js";
import {
  normalizeTuiRuntimeEvent,
  type RawTuiRuntimeEvent,
} from "../../src/runtime/event-normalizer.js";
import type { SendMessageReq } from "@mavis/local-runtime-v2/cli-service";
import type { TuiObservability } from "../../src/observability/local-observability.js";
import type { McodeAuthProgress } from "../../src/auth/application.js";
import { formatTuiShortcut } from "../../src/tui/shell/shortcut-labels.js";
import { createTuiHostKeybindings } from "../../src/tui/shell/keybindings.js";
import { stripAnsi } from "../../src/tui/rendering/text.js";
import {
  TuiDraftRecovery,
  TuiDraftRecoveryError,
} from "../../src/tui/features/composer/draft-recovery.js";
import { composerText } from "../../src/tui/features/composer/copy.js";
import type {
  McodeBusinessEvent,
  McodeBusinessTelemetry,
} from "../../src/analytics/business-telemetry.js";
import { VirtualTerminalScreen } from "../helpers/virtual-terminal.js";
import { VirtualTerminal } from "../pi-084-upstream/virtual-terminal.js";
import { TuiFailure } from "../../src/failure.js";

const runtimeEvent = (event: RawTuiRuntimeEvent): TuiRuntimeEvent =>
  normalizeTuiRuntimeEvent(event);

const TERMINAL_CAPABILITIES = detectTerminalCapabilities({
  platform: "linux",
  isTTY: true,
  env: { TERM_PROGRAM: "vscode" },
});

function planReviewEventRequest(id: string) {
  return {
    schemaVersion: 2,
    id,
    mode: "plan",
    modePayload: {
      planReview: {
        markdown: "# Frozen plan\n\nImplement and verify the change.",
        path: "/history/session-1/artifacts/plan.md",
      },
    },
    presentation: {
      replaceComposer: true,
      showProgress: true,
      allowBackNavigation: true,
    },
    steps: [
      {
        id: "plan-review",
        question: "Approve?",
        selectionMode: "single",
        options: [{ id: "approve", label: "Approve" }],
        allowOther: true,
        required: true,
      },
    ],
  } as const;
}

function planEntryEventRequest(id: string) {
  return {
    schemaVersion: 2,
    id,
    mode: "plan",
    presentation: {
      replaceComposer: true,
      showProgress: true,
      allowBackNavigation: true,
    },
    steps: [
      {
        id: "plan-enter",
        question: "Enter Plan Mode for this task?",
        selectionMode: "single",
        options: [
          { id: "confirm", label: "Confirm" },
          { id: "decline", label: "Decline" },
        ],
        allowOther: true,
        otherPlaceholder: "Others...",
        required: true,
      },
    ],
  } as const;
}

function createObservability(): TuiObservability {
  return {
    recordStartup: vi.fn(),
    recordAccess: vi.fn(),
    recordEventStream: vi.fn(),
    recordTerminal: vi.fn(),
    recordProcessStop: vi.fn(),
    observeRender: vi.fn(),
    snapshot: vi.fn(() => ({
      filePath: "/tmp/mcode-observability.jsonl",
      eventCounts: {
        startup: 0,
        runtimeAccess: 0,
        eventStream: 0,
        terminal: 0,
      },
      accessSources: {},
      reconnects: 0,
      render: {
        frames: 0,
        averageDurationMs: 0,
        maxDurationMs: 0,
        p95DurationMs: 0,
      },
    })),
    flush: vi.fn(async () => undefined),
  };
}

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 18;
  kittyProtocolActive = false;
  started = false;
  stopped = false;
  startCount = 0;
  stopCount = 0;
  drainCount = 0;
  title = "";
  titleUpdates: string[] = [];
  mouseTracking = false;
  mouseTrackingUpdates: boolean[] = [];
  writes: string[] = [];
  input?: (data: string) => void;

  start(onInput: (data: string) => void): void {
    this.started = true;
    this.stopped = false;
    this.startCount += 1;
    this.input = onInput;
  }

  stop(): void {
    this.stopped = true;
    this.stopCount += 1;
  }

  drainInput(): Promise<void> {
    this.drainCount += 1;
    return Promise.resolve();
  }

  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setProgress(): void {}

  setMouseTracking(enabled: boolean): void {
    this.mouseTracking = enabled;
    this.mouseTrackingUpdates.push(enabled);
  }

  setTitle(title: string): void {
    this.title = title;
    this.titleUpdates.push(title);
  }
}

// Apple Terminal can save ED 2 clears into scrollback before the renderer clears history.
class ClearToScrollbackTerminal extends VirtualTerminal {
  override write(data: string): void {
    super.write(data.replaceAll("\x1b[2J", `\x1b[${this.rows};1H${"\r\n".repeat(this.rows)}\x1b[2J`));
  }
}

function renderTerminalViewport(
  app: ReturnType<typeof createTuiApp>,
  terminal: FakeTerminal,
): string {
  app.tui.renderNow();
  const screen = new VirtualTerminalScreen(terminal.columns, terminal.rows);
  try {
    for (const write of terminal.writes) screen.feed(write);
    return screen.viewportText();
  } finally {
    screen.dispose();
  }
}

function createRuntime(): TuiRuntime {
  const abortSession = vi.fn(async () => true);
  let currentGoal: Awaited<ReturnType<TuiRuntime["getGoal"]>>;
  let createdSession:
    | {
        sessionId: string;
        title: string;
        workspaceDir: string;
        interactionMode?: "plan";
      }
    | undefined;
  const runtime: TuiRuntime = {
    createSession: vi.fn(async () => {
      createdSession = {
        sessionId: "session-1",
        title: "New session",
        workspaceDir: "/workspace",
      };
      return { ...createdSession };
    }),
    listSessions: vi.fn(async () => []),
    listSessionPage: vi.fn(async () => ({
      sessions: [],
      hasMore: false,
    })),
    getSession: vi.fn(async (sessionId: string) =>
      createdSession?.sessionId === sessionId
        ? { ...createdSession }
        : {
            sessionId,
            title: "Existing session",
            workspaceDir: "/workspace",
          },
    ),
    getMessages: vi.fn(async () => []),
    listMessagePage: vi.fn(async () => ({ messages: [], hasMore: false })),
    getSessionForkOptions: vi.fn(async () => ({
      canFork: true,
      worktreeVisible: false,
      worktreeEligible: false,
    })),
    forkSession: vi.fn(async () => ({
      session: {
        sessionId: "session-fork",
        parentSessionId: "session-1",
        title: "New session (fork 1)",
        workspaceDir: "/workspace",
      },
    })),
    getWorkspaceGitMetadata: vi.fn(async () => ({
      isGitRepo: false,
      branch: "",
      detached: false,
      isWorktree: false,
    })),
    renameSession: vi.fn(async (sessionId: string, title: string) => ({
      sessionId,
      title,
      workspaceDir: "/workspace",
    })),
    archiveSession: vi.fn(async () => undefined),
    listSessionInputSummaries: vi.fn(async () => []),
    getSessionRewindPreview: vi.fn(async () => ({ turns: [] })),
    rewindSession: vi.fn(async () => ({ rewound: true })),
    editSessionMessage: vi.fn(async () => ({
      rewound: true,
      turnId: "turn-edit-1",
      userMessageId: "msg-user-v1-edited",
    })),
    isGoalEnabled: vi.fn(() => true),
    getGoal: vi.fn(async () => currentGoal),
    createGoal: vi.fn(async ({ sessionId, objective, attachments }) => {
      currentGoal = {
        goalId: "goal-1",
        sessionId,
        objective,
        status: "active",
        createdAt: 10,
        updatedAt: 10,
        tokensUsed: 0,
        turnsUsed: 0,
        timeUsedSeconds: 0,
        tokenBudget: null,
        statusReason: null,
        hasKickoffAttachments: Boolean(attachments?.length),
      };
      return currentGoal;
    }),
    patchGoal: vi.fn(async (_sessionId, patch) => {
      if (!currentGoal) throw new Error("Goal not found");
      currentGoal = {
        ...currentGoal,
        ...patch,
        updatedAt: currentGoal.updatedAt + 1,
      };
      return currentGoal;
    }),
    clearGoal: vi.fn(async () => {
      const existed = Boolean(currentGoal);
      currentGoal = undefined;
      return existed;
    }),
    getInstructionSources: vi.fn(async () => []),
    getRuntimeDiagnostics: vi.fn(async () => ({
      status: "ok",
      surface: "cli-standalone",
      runtimeMode: "clean",
      runtimeOwnerKind: "cli",
      runtimeOwnerId: "minimax-code",
      dataDir: "/home/dev/.minimax",
      configPath: "/home/dev/.minimax/config.yaml",
      configPresent: true,
      authCachePresent: true,
      defaultModel: "minimax/MiniMax-M2.7",
      providerId: "minimax",
      modelId: "MiniMax-M2.7",
      authMode: "managed-login",
      authModeSource: "explicit",
      managedTokenPresent: true,
      apiKeyPresent: false,
      customProviderCount: 0,
      warnings: [],
    })),
    prepareFeedback: vi.fn(async ({ description, sessionId }) => ({
      schemaVersion: 1 as const,
      draftId: "feedback-draft-1",
      description,
      diagnostics: [
        { label: "Client", value: "mcode 0.1.0" },
        { label: "Runtime", value: "clean · cli" },
        { label: "Session", value: sessionId ?? "not included" },
      ],
      included: ["redacted feedback description"],
      excluded: ["credentials and tokens", "conversation prompts and messages"],
      expiresAtMs: Date.now() + 60_000,
    })),
    submitFeedback: vi.fn(async () => ({
      schemaVersion: 1 as const,
      ticketId: "ticket-1",
      status: "processing" as const,
      createdAtMs: Date.now(),
    })),
    cancelFeedback: vi.fn(async () => true),
    runDailyCheckin: vi.fn(async () => ({
      status: "claimed" as const,
      dayNo: 2,
      points: 20,
      expireAtMs: 1_800_000_000_000,
      panel: {
        scene: 2,
        days: Array.from({ length: 7 }, (_, index) => ({
          day_no: index + 1,
          points: (index + 1) * 10,
          status: index <= 1 ? 3 : 1,
          is_today: index === 1,
        })),
      },
    })),
    getAccountStatus: vi.fn(async () => ({
      status: "ready",
      defaultModel: "minimax/MiniMax-M2.7",
      providerId: "minimax",
      modelId: "MiniMax-M2.7",
      authMode: "managed-login",
      managedTokenPresent: true,
      warnings: [],
    })),
    listProviderPresets: vi.fn(async () => []),
    getCodexOAuthStatus: vi.fn(async () => ({
      state: "hidden" as const,
      providerId: "openai-codex" as const,
    })),
    startCodexOAuthLogin: vi.fn(async () => ({
      state: "hidden" as const,
      providerId: "openai-codex" as const,
    })),
    getPermissionMode: vi.fn(async () => "auto" as const),
    setPermissionMode: vi.fn(async (mode) => mode),
    getPlanModeCapabilities: vi.fn(async () => ({ entryEnabled: true })),
    getPendingQuestionnaire: vi.fn(async () => undefined),
    getLatestPlanReview: vi.fn(async () => undefined),
    replyQuestionnaire: vi.fn(async () => true),
    dismissQuestionnaire: vi.fn(async () => true),
    listPendingPermissions: vi.fn(async () => []),
    replyPermission: vi.fn(async () => true),
    listModels: vi.fn(async () => [
      {
        providerId: "minimax",
        modelId: "MiniMax-M2.7",
        displayName: "MiniMax M2.7",
        providerKind: "minimax-managed",
        selected: true,
      },
    ]),
    selectModel: vi.fn(async () => true),
    getSessionUsage: vi.fn(async () => ({
      summary: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        turns: 1,
      },
      rows: [],
    })),
    requestCompaction: vi.fn(async () => ({
      success: true,
      sessionId: "session-1",
      compactionId: "compact-1",
      messagesBefore: 12,
      messagesAfter: 4,
      tokensBefore: 4000,
      tokensAfter: 1200,
    })),
    getContextSnapshot: vi.fn(async () => ({ status: "empty" as const })),
    getActiveRun: vi.fn(async (sessionId: string) => ({
      schemaVersion: 1 as const,
      sessionId,
      state: "idle" as const,
      actions: { steer: false },
    })),
    getDelegationSnapshot: vi.fn(async (rootSessionId: string) => ({
      schemaVersion: 1 as const,
      rootSessionId,
      members: [],
    })),
    stopDelegation: vi.fn(async (rootSessionId: string) => ({
      schemaVersion: 1 as const,
      rootSessionId,
      rootStopped: await abortSession({ id: rootSessionId }),
      stoppedSessionIds: [],
      activeSessionIds: [],
      failedSessionIds: [],
    })),
    steer: vi.fn(async (input) => ({
      turnId: input.requestedTurnId ?? "turn-steer",
      mode: input.requestedTurnId
        ? ("steered" as const)
        : ("activated" as const),
      ...(input.requestedTurnId
        ? {}
        : {
            completion:
              (async function* completion(): AsyncGenerator<TuiStreamEvent> {
                yield { type: "done", turnId: "turn-steer" };
              })(),
          }),
    })),
    listSkills: vi.fn(async () => ({
      skills: [
        {
          name: "docs",
          displayName: "Docs",
          description: "Read project docs",
          enabled: true,
          sourceKind: "builtin",
        },
      ],
      hasMore: false,
    })),
    inspectProjectMcp: vi.fn(async () => undefined),
    listMcpServers: vi.fn(async () => [
      {
        name: "browser",
        enabled: true,
        transport: "stdio",
        description: "Browser tools",
        configJson: '{"env":{"TOKEN":"hidden"}}',
      },
    ]),
    listQueuedMessages: vi.fn(async () => []),
    getQueueSnapshot: vi.fn(async (sessionId: string) => {
      const items = await runtime.listQueuedMessages(sessionId);
      return {
        items,
        paused: items.some((item) => item.status === "paused"),
        pendingCount: items.length,
      };
    }),
    continueQueue: vi.fn(async () => undefined),
    steerQueuedMessage: vi.fn(async (_sessionId: string, itemId: string) => ({
      queueItemId: itemId,
      turnId: "turn-steered-queue",
    })),
    enqueueMessage: vi.fn(async () => ({
      itemId: "queue-1",
      status: "queued",
      position: 1,
    })),
    updateQueuedMessageContent: vi.fn(async () => undefined),
    deleteQueuedMessage: vi.fn(async () => undefined),
    watchEvents: vi.fn(async function* watchEvents(signal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      for (const event of [] as TuiRuntimeEvent[]) yield event;
    }),
    watchSessionTurn: vi.fn(async function* watchSessionTurn() {}),
    sendMessage: vi.fn(
      async function* sendMessage(request): AsyncGenerator<TuiStreamEvent> {
        if (createdSession?.sessionId === request.id) {
          if (request.clientIntent === "plan-entry")
            createdSession.interactionMode = "plan";
          if (request.clientIntent === "plan-exit")
            delete createdSession.interactionMode;
        }
        yield { type: "delta", content: "Hello from the Agent" };
        yield { type: "done" };
      },
    ),
    abortSession,
  };
  return runtime;
}

describe("createTuiApp", () => {
  it("force-follows user submissions, /new, and Session transitions", async () => {
    const forceFollowBottom = vi.spyOn(TuiChatLayout.prototype, "forceFollowBottom");
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal: new FakeTerminal(),
      version: "test",
      workspaceDir: "/workspace",
    });
    app.start();

    try {
      await app.ready;
      await app.openSession("session-1");

      forceFollowBottom.mockClear();
      await app.submit("Continue with the next step");
      await vi.waitFor(() => expect(forceFollowBottom).toHaveBeenCalled());

      forceFollowBottom.mockClear();
      await app.submit("/new");
      expect(forceFollowBottom).toHaveBeenCalled();

      forceFollowBottom.mockClear();
      await app.openSession("session-2");
      expect(forceFollowBottom).toHaveBeenCalled();
    } finally {
      await app.stop();
      forceFollowBottom.mockRestore();
    }
  });

  it("re-arms follow-tail when a follow-up is accepted into the queue", async () => {
    let releaseRun: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* pendingRun() {
        yield {
          type: "delta",
          turnId: "turn-pending",
          role: "assistant",
          content: "Working",
        };
        await runGate;
        yield { type: "done", turnId: "turn-pending" };
      },
    );
    const forceFollowBottom = vi.spyOn(TuiChatLayout.prototype, "forceFollowBottom");
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "test",
      workspaceDir: "/workspace",
      productFeatures: { queue: true },
    });
    app.start();

    try {
      await app.ready;
      const firstSubmission = app.submit("Start the live run");
      await vi.waitFor(() =>
        expect(app.controller.snapshot().status).toBe("running"),
      );

      forceFollowBottom.mockClear();
      await app.submit("Queue the follow-up");

      expect(runtime.enqueueMessage).toHaveBeenCalledWith(
        "session-1",
        "Queue the follow-up",
        expect.objectContaining({ attachments: [] }),
      );
      expect(forceFollowBottom).toHaveBeenCalled();

      releaseRun?.();
      await firstSubmission;
    } finally {
      releaseRun?.();
      await app.stop();
      forceFollowBottom.mockRestore();
    }
  });

  it.each(["regular", "fullscreen"] as const)(
    "configures /statusline from terminal input and reopens the saved selection in %s mode",
    async (tuiMode) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      const persistStatusLineItems = vi.fn(async () => undefined);
      const app = createTuiApp({
        runtime,
        terminal,
        version: "test",
        workspaceDir: "/workspace",
        tuiMode,
        statusLineItems: ["current-dir"],
        persistStatusLineItems,
      });
      try {
        app.start();
        await app.ready;
        app.editor.setText("/statusline");
        terminal.input?.("\r");
        await vi.waitFor(() => expect(app.interaction.isActive()).toBe(true));
        expect(stripAnsi(app.interaction.render(80).join("\n"))).toContain(
          "[x] current-dir",
        );
        terminal.input?.(" ");
        terminal.input?.("\r");
        await vi.waitFor(() => expect(app.interaction.isActive()).toBe(false));
        expect(persistStatusLineItems).toHaveBeenCalledWith([]);
        app.editor.setText("/statusline");
        terminal.input?.("\r");
        await vi.waitFor(() => expect(app.interaction.isActive()).toBe(true));
        expect(stripAnsi(app.interaction.render(80).join("\n"))).toContain(
          "[ ] current-dir",
        );
        terminal.input?.("\x1b");
        expect(app.interaction.isActive()).toBe(false);
        expect(persistStatusLineItems).toHaveBeenCalledOnce();
        expect(runtime.sendMessage).not.toHaveBeenCalled();
      } finally {
        await app.stop();
      }
    },
  );

  it.each([
    ["regular", false],
    ["regular", true],
    ["fullscreen", false],
    ["fullscreen", true],
  ] as const)(
    "runs ls unchanged in %s mode after empty-prefix Tab: %s",
    async (tuiMode, pressTab) => {
      const directory = await mkdtemp(join(tmpdir(), "tui-ls-enter-"));
      await mkdir(join(directory, "aaa-directory"));
      await writeFile(join(directory, "root-only.txt"), "root");
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: directory,
        tuiMode,
      });
      try {
        app.start();
        await app.ready;
        app.editor.setText("!ls");
        terminal.input?.(" ");
        expect(stripAnsi(app.editor.render(100).join("\n"))).not.toContain(
          "aaa-directory/",
        );
        if (pressTab) {
          terminal.input?.("\t");
          await vi.waitFor(() =>
            expect(stripAnsi(app.editor.render(100).join("\n"))).toContain(
              "aaa-directory/",
            ),
          );
        }
        expect(app.editor.getText()).toBe("!ls ");
        terminal.input?.("\r");
        await vi.waitFor(
          () =>
            expect(
              app.transcript.snapshot().find((cell) => cell.kind === "shell")
                ?.status,
            ).toBe("succeeded"),
          { timeout: 5000 },
        );
        expect(
          app.transcript.snapshot().find((cell) => cell.kind === "shell"),
        ).toMatchObject({
          title: "! ls",
          content: expect.stringContaining("root-only.txt"),
        });
        expect(runtime.sendMessage).not.toHaveBeenCalled();
      } finally {
        await app.stop();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["regular", "fullscreen"] as const)(
    "completes a shell path from terminal input in %s mode before executing",
    async (tuiMode) => {
      const directory = await mkdtemp(
        join(tmpdir(), "tui-shell-completion-app-"),
      );
      await writeFile(
        join(directory, "report file.txt"),
        "completed-shell-output",
      );
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: directory,
        tuiMode,
      });
      try {
        app.start();
        await app.ready;
        app.editor.setText(
          process.platform === "win32" ? "!Get-Content " : "!cat ",
        );
        for (const char of "rep") terminal.input?.(char);
        expect(app.editor.getText()).toBe(
          process.platform === "win32" ? "!Get-Content rep" : "!cat rep",
        );
        terminal.input?.("\t");
        await vi.waitFor(() =>
          expect(app.editor.getText()).toBe(
            process.platform === "win32"
              ? "!Get-Content report` file.txt "
              : "!cat report\\ file.txt ",
          ),
        );
        expect(
          app.transcript
            .snapshot()
            .some((cell) => cell.id.startsWith("local:bash:")),
        ).toBe(false);
        terminal.input?.("\r");
        await vi.waitFor(
          () =>
            expect(
              app.transcript
                .snapshot()
                .some(
                  (cell) =>
                    cell.id.startsWith("local:bash:") &&
                    cell.status === "succeeded" &&
                    cell.content.includes("completed-shell-output"),
                ),
            ).toBe(true),
          { timeout: 5000 },
        );
        expect(runtime.sendMessage).not.toHaveBeenCalled();
      } finally {
        await app.stop();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("runs an editor ! command locally and carries its result into the next model message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tui-bash-app-"));
    const runtime = createRuntime();
    const followBottom = vi.spyOn(TuiChatLayout.prototype, "followBottom");
    const forceFollowBottom = vi.spyOn(
      TuiChatLayout.prototype,
      "forceFollowBottom",
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: directory,
    });
    try {
      await app.ready;
      followBottom.mockClear();
      forceFollowBottom.mockClear();
      app.editor.setText(
        process.platform === "win32"
          ? "!Write-Output shell-result"
          : "!printf shell-result",
      );
      app.editor.submit();
      await vi.waitFor(
        () =>
          expect(
            app.transcript
              .snapshot()
              .some(
                (cell) =>
                  cell.id.startsWith("local:bash:") &&
                  cell.status === "succeeded",
              ),
          ).toBe(true),
        { timeout: 5000 },
      );
      expect(followBottom).toHaveBeenCalled();
      expect(forceFollowBottom).not.toHaveBeenCalled();
      expect(runtime.sendMessage).not.toHaveBeenCalled();
      expect(
        app.transcript
          .snapshot()
          .find((cell) => cell.id.startsWith("local:bash:"))?.content,
      ).toContain("shell-result");
      expect(stripAnsi(app.tui.render(100).join("\n"))).toContain(
        "shell-result",
      );
      await app.submit("Explain the output");
      expect(runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("shell-result"),
        }),
        expect.anything(),
      );
    } finally {
      await app.stop();
      followBottom.mockRestore();
      forceFollowBottom.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shows shell output before the command exits and drains it when the app stops", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tui-bash-stream-"));
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: directory,
    });
    try {
      await app.ready;
      const running = app.submit(
        process.platform === "win32"
          ? "!Write-Output streamed-result; Start-Sleep -Seconds 30"
          : "!printf streamed-result; sleep 30",
      );
      await vi.waitFor(
        () =>
          expect(
            app.transcript
              .snapshot()
              .some(
                (cell) =>
                  cell.status === "running" &&
                  cell.content.includes("streamed-result"),
              ),
          ).toBe(true),
        { timeout: 5000 },
      );
      expect(stripAnsi(app.tui.render(100).join("\n"))).toContain(
        "streamed-result",
      );
      await app.stop();
      await running;
      expect(
        app.transcript
          .snapshot()
          .find((cell) => cell.id.startsWith("local:bash:"))?.status,
      ).toBe("cancelled");
    } finally {
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continues a restored paused Queue from its manager without sending a new message", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let paused = true;
    vi.mocked(runtime.listQueuedMessages).mockImplementation(async () => [
      {
        itemId: "paused-follow-up",
        sessionId: "session-1",
        status: paused ? "paused" : "queued",
        content: "Existing queued work",
      },
    ]);
    vi.mocked(runtime.continueQueue).mockImplementation(async () => {
      paused = false;
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "test",
      workspaceDir: "/workspace",
      productFeatures: { queue: true },
    });
    app.start();
    try {
      await app.ready;
      await app.openSession("session-1");
      await app.submit("/queue");
      expect(app.tui.render(120).join("\n")).toContain("c continue queue");
      terminal.input?.("c");
      await vi.waitFor(() =>
        expect(runtime.continueQueue).toHaveBeenCalledWith("session-1"),
      );
      await vi.waitFor(() =>
        expect(app.tui.render(120).join("\n")).toContain("Queue continued."),
      );
      expect(runtime.sendMessage).not.toHaveBeenCalled();
      expect(runtime.enqueueMessage).not.toHaveBeenCalled();
      expect(runtime.deleteQueuedMessage).not.toHaveBeenCalled();
    } finally {
      await app.stop();
    }
  });
  it.each(["keep", "clear", "cancel-enter", "cancel-escape"] as const)(
    "recovers a restored paused Queue when sending a message: %s",
    async (decision) => {
      const dataDir = await mkdtemp(join(tmpdir(), "tui-paused-queue-draft-"));
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      let items: TuiQueuedMessage[] = [
        {
          itemId: "paused-follow-up",
          sessionId: "session-1",
          status: "paused",
          content: "Existing queued work",
        },
      ];
      let emitQueueChange:
        | ((event: TuiRuntimeEvent | undefined) => void)
        | undefined;
      vi.mocked(runtime.watchEvents).mockImplementation(
        async function* (signal) {
          const event = await new Promise<TuiRuntimeEvent | undefined>(
            (resolve) => {
              emitQueueChange = resolve;
              signal.addEventListener("abort", () => resolve(undefined), {
                once: true,
              });
            },
          );
          if (!event || signal.aborted) return;
          yield event;
          if (!signal.aborted) {
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        },
      );
      vi.mocked(runtime.listQueuedMessages).mockImplementation(async () => [
        ...items,
      ]);
      vi.mocked(runtime.sendMessage).mockImplementation(
        async function* (request, _signal, options) {
          if (!options?.pausedQueueAction) {
            throw new TuiFailure("runtime", "Queue paused", {
              code: "local_session_queue_paused",
            });
          }
          items =
            options.pausedQueueAction === "clear"
              ? []
              : items.map((item) => ({ ...item, status: "queued" }));
          emitQueueChange?.({
            type: "session.queue.updated",
            sessionId: "session-1",
            source: "runtime-v2",
            timestampMs: Date.now(),
          });
          yield { type: "done", turnId: request.turnId };
        },
      );
      const appOptions = {
        runtime,
        terminal,
        version: "test",
        dataDir,
        workspaceDir: "/workspace",
        productFeatures: { queue: true },
      };
      let app = createTuiApp(appOptions);
      app.start();
      try {
        await app.ready;
        await app.openSession("session-1");
        await vi.waitFor(() => expect(emitQueueChange).toBeTypeOf("function"));
        await vi.waitFor(() =>
          expect(app.tui.render(120).join("\n")).toContain(
            "Existing queued work",
          ),
        );
        terminal.input?.("Resume safely");
        terminal.input?.("\r");
        await vi.waitFor(() =>
          expect(app.tui.render(120).join("\n")).toContain("Keep my draft"),
        );
        const cancelled = decision.startsWith("cancel");
        if (decision === "cancel-escape") terminal.input?.("\u001b");
        else {
          if (decision === "clear") terminal.input?.("\u001b[B");
          if (decision === "cancel-enter") {
            terminal.input?.("\u001b[B");
            terminal.input?.("\u001b[B");
          }
          terminal.input?.("\r");
        }
        await vi.waitFor(() =>
          expect(app.controller.snapshot().activeTurnId).toBeUndefined(),
        );
        expect(runtime.enqueueMessage).not.toHaveBeenCalled();
        if (cancelled) {
          await vi.waitFor(() =>
            expect(app.editor.getText()).toBe("Resume safely"),
          );
          expect(runtime.sendMessage).toHaveBeenCalledOnce();
          expect(runtime.continueQueue).not.toHaveBeenCalled();
          expect(runtime.deleteQueuedMessage).not.toHaveBeenCalled();
          expect(
            app.transcript.snapshot().filter((cell) => cell.kind === "user"),
          ).toEqual([]);
          expect(
            app.transcript.snapshot().filter((cell) => cell.kind === "error"),
          ).toEqual([]);
          expect(app.tui.render(120).join("\n")).toContain("Queue paused");
          expect(app.tui.render(120).join("\n")).not.toContain("Keep my draft");
          await vi.waitFor(async () => {
            const recovered = await new TuiDraftRecovery({
              dataDir,
              workspaceDir: "/workspace",
              sessionKey: "session-1",
            }).load();
            expect(recovered?.editor.text).toBe("Resume safely");
            expect(recovered?.retrySubmissions ?? []).toEqual([]);
          });
          app.editor.setText("Edited draft");
          await app.stop();
          app = createTuiApp(appOptions);
          app.start();
          await app.ready;
          await app.openSession("session-1");
          await vi.waitFor(() =>
            expect(app.editor.getText()).toBe("Edited draft"),
          );
          expect(runtime.sendMessage).toHaveBeenCalledOnce();
          terminal.input?.("\r");
          await vi.waitFor(() =>
            expect(app.tui.render(120).join("\n")).toContain("Keep my draft"),
          );
          terminal.input?.("\r");
          await vi.waitFor(() =>
            expect(runtime.sendMessage).toHaveBeenCalledTimes(3),
          );
          await vi.waitFor(() =>
            expect(app.controller.snapshot().activeTurnId).toBeUndefined(),
          );
          expect(
            vi.mocked(runtime.sendMessage).mock.calls[2]?.[0],
          ).toMatchObject({
            content: "Edited draft",
          });
          expect(vi.mocked(runtime.sendMessage).mock.calls[2]?.[2]).toEqual({
            pausedQueueAction: "keep",
          });
          await vi.waitFor(() =>
            expect(app.tui.render(120).join("\n")).not.toContain(
              "Queue paused",
            ),
          );
          expect(app.editor.getText()).toBe("");
          expect(app.tui.render(120).join("\n")).toContain(
            "Existing queued work",
          );
        } else {
          expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
          expect(
            vi.mocked(runtime.sendMessage).mock.calls[1]?.[0],
          ).toMatchObject({
            content: "Resume safely",
          });
          expect(vi.mocked(runtime.sendMessage).mock.calls[1]?.[2]).toEqual({
            pausedQueueAction: decision,
          });
          await vi.waitFor(() =>
            expect(app.tui.render(120).join("\n")).not.toContain(
              "Queue paused",
            ),
          );
          const rendered = app.tui.render(120).join("\n");
          if (decision === "clear")
            expect(rendered).not.toContain("Existing queued work");
          else expect(rendered).toContain("Existing queued work");
        }
      } finally {
        await app.stop();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );
  it.each([
    ["plan-entry", "keep"],
    ["plan-entry", "clear"],
    ["plan-entry", "cancel"],
    ["plan-entry", "busy"],
    ["plan-exit", "keep"],
    ["plan-exit", "clear"],
    ["plan-exit", "cancel"],
    ["plan-exit", "busy"],
  ] as const)(
    "recovers a paused Queue with %s and decision %s",
    async (clientIntent, decision) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      let interactionMode: "plan" | undefined =
        clientIntent === "plan-exit" ? "plan" : undefined;
      let rejectRecovery = decision === "busy";
      vi.mocked(runtime.getSession).mockImplementation(async () => ({
        sessionId: "session-1",
        interactionMode,
      }));
      vi.mocked(runtime.listQueuedMessages).mockResolvedValue([
        {
          itemId: "paused-work",
          sessionId: "session-1",
          status: "paused",
          content: "Existing work",
        },
      ]);
      vi.mocked(runtime.sendMessage).mockImplementation(
        async function* (request, _signal, options) {
          if (!options?.pausedQueueAction || rejectRecovery) {
            throw new TuiFailure("runtime", "Admission rejected", {
              code: options?.pausedQueueAction
                ? "local_session_busy"
                : "local_session_queue_paused",
            });
          }
          interactionMode =
            request.clientIntent === "plan-entry" ? "plan" : undefined;
          yield { type: "done", turnId: request.turnId };
        },
      );
      const app = createTuiApp({
        runtime,
        terminal,
        version: "test",
        workspaceDir: "/workspace",
        productFeatures: { queue: true },
      });
      app.start();
      try {
        await app.ready;
        await app.openSession("session-1");
        await app.submit(
          clientIntent === "plan-entry" ? "/plan on" : "/plan off",
        );
        terminal.input?.("Change mode and continue");
        terminal.input?.("\r");
        await vi.waitFor(() =>
          expect(app.tui.render(120).join("\n")).toContain("Keep my draft"),
        );
        if (decision === "clear" || decision === "cancel")
          terminal.input?.("\u001b[B");
        if (decision === "cancel") terminal.input?.("\u001b[B");
        terminal.input?.("\r");
        await vi.waitFor(() =>
          expect(app.controller.snapshot().activeTurnId).toBeUndefined(),
        );
        expect(runtime.enqueueMessage).not.toHaveBeenCalled();

        if (decision === "cancel" || decision === "busy") {
          await vi.waitFor(() =>
            expect(app.editor.getText()).toBe("Change mode and continue"),
          );
          expect(interactionMode === "plan").toBe(clientIntent === "plan-exit");
          rejectRecovery = false;
          app.editor.setText("Edited mode instruction");
          terminal.input?.("\r");
          await vi.waitFor(() =>
            expect(app.tui.render(120).join("\n")).toContain("Keep my draft"),
          );
          terminal.input?.("\r");
          await vi.waitFor(() =>
            expect(app.controller.snapshot().activeTurnId).toBeUndefined(),
          );
        }
        expect(runtime.sendMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ clientIntent }),
          expect.any(AbortSignal),
          { pausedQueueAction: decision === "clear" ? "clear" : "keep" },
        );
        expect(interactionMode === "plan").toBe(clientIntent === "plan-entry");
        expect(app.editor.getText()).toBe("");
      } finally {
        await app.stop();
      }
    },
  );

  it("shows the MCode prompt in an empty Composer and hides it after input", async () => {
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    try {
      app.start();
      await app.ready;

      expect(stripAnsi(app.tui.render(80).join("\n"))).toContain(
        "Ask Mcode to do anything",
      );

      app.editor.handleInput("R");

      expect(stripAnsi(app.tui.render(80).join("\n"))).not.toContain(
        "Ask Mcode to do anything",
      );
      expect(app.editor.getText()).toBe("R");
    } finally {
      await app.stop();
    }
  });

  it("copies the last Assistant reply to the client clipboard over SSH", async () => {
    vi.stubEnv("SSH_CONNECTION", "10.0.0.1 50100 10.0.0.2 22");
    vi.stubEnv("SSH_TTY", "/dev/pts/1");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    const terminal = new FakeTerminal();
    let app: ReturnType<typeof createTuiApp> | undefined;

    try {
      app = createTuiApp({
        runtime: createRuntime(),
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
      });
      app.start();
      await app.ready;
      await app.submit("Say hello");
      await app.submit("/copy");

      expect(terminal.writes).toContain(
        "\u001B]52;c;SGVsbG8gZnJvbSB0aGUgQWdlbnQ=\u0007",
      );
    } finally {
      await app?.stop();
      Reflect.deleteProperty(process.stdin, "isTTY");
      Reflect.deleteProperty(process.stdout, "isTTY");
      vi.unstubAllEnvs();
    }
  });

  it("runs /goal through Runtime ownership and renders the active Goal above the Composer", async () => {
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;

    await app.submit("/goal Ship TUI Goal support");

    expect(runtime.createSession).toHaveBeenCalledOnce();
    expect(runtime.createGoal).toHaveBeenCalledWith({
      sessionId: "session-1",
      objective: "Ship TUI Goal support",
    });
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(app.surfaceHost.render(100).join("\n")).toContain("Goal · Active");
    expect(app.surfaceHost.render(100).join("\n")).toContain(
      "Ship TUI Goal support",
    );

    await app.submit("/goal pause");
    expect(runtime.patchGoal).toHaveBeenCalledWith("session-1", {
      status: "paused",
    });
    expect(app.surfaceHost.render(100).join("\n")).toContain("Goal · Paused");

    await app.stop();
  });

  it("wires complete chat and autocomplete business events into the TUI surface", async () => {
    const events: McodeBusinessEvent[] = [];
    const businessTelemetry: McodeBusinessTelemetry = {
      track: (event, properties) =>
        events.push({ event, properties } as McodeBusinessEvent),
      flush: async () => undefined,
    };
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace/agent-archon",
      businessTelemetry,
    });

    await app.ready;
    await app.submit("First prompt");
    await app.submit("Second prompt");
    for (const character of "/he") app.editor.handleInput(character);
    await vi.waitFor(() =>
      expect(
        events.some((item) => item.event === "slash_command_menu_view"),
      ).toBe(true),
    );
    app.editor.handleInput("\r");

    expect(events.filter((item) => item.event === "chat_send")).toEqual([
      {
        event: "chat_send",
        properties: {
          chat_type: "chat",
          is_first_message: 1,
          is_attachment: "text",
        },
      },
      {
        event: "chat_send",
        properties: {
          chat_type: "chat",
          is_first_message: 0,
          is_attachment: "text",
        },
      },
    ]);
    expect(events).toContainEqual({
      event: "slash_command_click",
      properties: {
        chat_type: "chat",
        command_type: "other",
      },
    });
    await app.stop();
  });

  it("releases the terminal on suspend and reconciles Runtime state after resume", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const requestProcessSuspend = vi.fn();
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
        yield* [];
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      requestProcessSuspend,
    });

    app.start();
    await app.ready;
    await app.openSession("session-1");
    await vi.waitFor(() => expect(runtime.watchEvents).toHaveBeenCalledOnce());

    terminal.input?.("\x1a");
    expect(requestProcessSuspend).toHaveBeenCalledOnce();

    await app.suspend();
    expect(terminal.stopCount).toBe(1);
    expect(app.controller.snapshot().status).not.toBe("error");

    await app.resume();
    expect(terminal.startCount).toBe(2);
    await vi.waitFor(() =>
      expect(runtime.watchEvents).toHaveBeenCalledTimes(2),
    );
    expect(runtime.getActiveRun).toHaveBeenCalled();

    await app.stop();
  });

  it.each(["regular", "fullscreen"] as const)(
    "restores %s Composer input after Ctrl+G returns from the external editor",
    async (tuiMode) => {
      const terminal = new FakeTerminal();
      const stopTerminal = vi.spyOn(terminal, "stop");
      const startTerminal = vi.spyOn(terminal, "start");
      const editDraftInExternalEditor = vi.fn(
        async () => "edited in the external editor",
      );
      const app = createTuiApp({
        runtime: createRuntime(),
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
        tuiMode,
        externalEditorCommand: "code --wait",
        editDraftInExternalEditor,
      });

      app.start();
      await app.ready;
      const longPaste = Array.from(
        { length: 12 },
        (_, index) => `line ${String(index + 1)}`,
      ).join("\n");
      terminal.input?.(`\x1b[200~${longPaste}\x1b[201~`);
      expect(app.editor.getText()).toBe("[paste #1 +12 lines]");

      terminal.input?.("\x07");

      await vi.waitFor(() =>
        expect(editDraftInExternalEditor).toHaveBeenCalledOnce(),
      );
      expect(editDraftInExternalEditor).toHaveBeenCalledWith({
        command: "code --wait",
        draft: longPaste,
        cwd: "/workspace",
      });
      await vi.waitFor(() =>
        expect(app.editor.getText()).toBe("edited in the external editor"),
      );
      expect(stopTerminal).toHaveBeenCalledOnce();
      expect(startTerminal).toHaveBeenCalledTimes(2);

      terminal.input?.("!");
      expect(app.editor.getText()).toBe("edited in the external editor!");
      await app.stop();
    },
  );

  it("loads Runtime-owned Git context into the status rail without blocking startup", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getWorkspaceGitMetadata).mockResolvedValue({
      isGitRepo: true,
      branch: "feat/status-context",
      detached: false,
      isWorktree: true,
    });
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/Users/dev/github/agent-archon",
      homeDir: "/Users/dev",
    });

    await app.ready;
    await vi.waitFor(() => {
      expect(runtime.getWorkspaceGitMetadata).toHaveBeenCalledWith(
        "/Users/dev/github/agent-archon",
      );
      const rendered = app.tui.render(120).join("\n");
      expect(rendered).toContain("~/github/agent-archon");
      expect(rendered).toContain("⎇ feat/status-context · worktree");
    });
    await app.stop();
  });

  it("keeps Pi clear-on-shrink disabled for the inline product by default", async () => {
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    expect(app.tui.getClearOnShrink()).toBe(false);
    await app.ready;
    await app.stop();
  });

  it("drains Pi terminal input before restoring the terminal on shutdown", async () => {
    const terminal = new FakeTerminal();
    const drainInput = vi.spyOn(terminal, "drainInput");
    const stopTerminal = vi.spyOn(terminal, "stop");
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.stop();

    expect(drainInput).toHaveBeenCalledWith(1000);
    expect(stopTerminal).toHaveBeenCalledOnce();
    expect(drainInput.mock.invocationCallOrder[0]).toBeLessThan(
      stopTerminal.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("shows the Runtime initialization error text when the Session catalog is unavailable", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockRejectedValue(
      new Error("Unable to connect to the Runtime on port 1234"),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;

    expect(app.controller.snapshot()).toMatchObject({
      status: "error",
      error:
        "Couldn't load sessions: Unable to connect to the Runtime on port 1234. Retry.",
      sessions: [],
    });
    expect(app.tui.render(80).join("\n")).toContain(
      "Error · Couldn't load sessions:",
    );
    await app.stop();
  });

  it("shows an available update as a dedicated startup notice", async () => {
    const terminal = new FakeTerminal();
    const checkForUpdate = vi.fn(async () => ({ latestVersion: "1.2.4" }));
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "1.2.3",
      workspaceDir: "/workspace",
      checkForUpdate,
    });

    app.start();
    await app.ready;
    await vi.waitFor(() => {
      expect(terminal.writes.join("")).toContain(
        "A new version of MCode is available",
      );
    });

    const rendered = terminal.writes.join("");
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(rendered).toContain("Run '/update' to install MCode 1.2.4");

    await app.submit("Start working");
    expect(app.getSurface()).toBe("conversation");
    expect(app.tui.render(80).join("\n")).not.toContain(
      "A new version of MCode is available",
    );

    await app.submit("/new");
    expect(app.getSurface()).toBe("welcome");
    expect(app.tui.render(80).join("\n")).toContain(
      "A new version of MCode is available",
    );
    await app.stop();
  });

  it("keeps the Welcome handoff out of the primary hint and submits it on Ctrl+U", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSkills).mockResolvedValue({
      skills: [
        {
          name: "resume-codex",
          displayName: "Resume Codex",
          description: "Continue a Codex session",
          enabled: true,
          sourceKind: "builtin",
        },
      ],
      hasMore: false,
    });
    const sessionId = "01a02373-25ae-76a1-880c-9253ba939cdc";
    const findRecentCodexSession = vi.fn(async () => ({
      sessionId,
      updatedAtMs: Date.now() - 60_000,
      source: "cli" as const,
    }));
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      findRecentCodexSession,
    });

    app.start();
    await app.ready;
    await vi.waitFor(() =>
      expect(findRecentCodexSession).toHaveBeenCalledOnce(),
    );

    const welcome = app.tui.render(100).join("\n");
    expect(welcome).toContain("Start");
    expect(welcome).not.toContain("Coming from Codex?");

    terminal.input?.("\x15");

    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledOnce());
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        content: `/resume-codex ${sessionId}`,
      }),
      expect.any(AbortSignal),
    );
    expect(app.tui.render(100).join("\n")).not.toContain("Coming from Codex?");
    await app.stop();
  });

  it("invalidates an in-flight Codex handoff scan after the user starts typing", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSkills).mockResolvedValue({
      skills: [
        {
          name: "resume-codex",
          displayName: "Resume Codex",
          description: "Continue a Codex session",
          enabled: true,
          sourceKind: "builtin",
        },
      ],
      hasMore: false,
    });
    let resolveRecent:
      | ((session: {
          sessionId: string;
          updatedAtMs: number;
          source: "cli";
        }) => void)
      | undefined;
    const findRecentCodexSession = vi.fn(
      async () =>
        await new Promise<{
          sessionId: string;
          updatedAtMs: number;
          source: "cli";
        }>((resolve) => {
          resolveRecent = resolve;
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      findRecentCodexSession,
    });

    app.start();
    terminal.input?.("x");
    await vi.waitFor(() =>
      expect(findRecentCodexSession).toHaveBeenCalledOnce(),
    );
    resolveRecent?.({
      sessionId: "01a02373-25ae-76a1-880c-9253ba939cdc",
      updatedAtMs: Date.now(),
      source: "cli",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(app.editor.getText()).toBe("x");
    expect(app.tui.render(100).join("\n")).not.toContain("Coming from Codex?");
    await app.stop();
  });

  it("does not inspect Codex storage when the resume Skill is unavailable", async () => {
    const runtime = createRuntime();
    const findRecentCodexSession = vi.fn(async () => ({
      sessionId: "01a02373-25ae-76a1-880c-9253ba939cdc",
      updatedAtMs: Date.now(),
      source: "cli" as const,
    }));
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
      findRecentCodexSession,
    });

    app.start();
    await app.ready;
    await vi.waitFor(() => expect(runtime.listSkills).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(findRecentCodexSession).not.toHaveBeenCalled();
    expect(app.tui.render(100).join("\n")).not.toContain("Coming from Codex?");
    await app.stop();
  });

  it.each(["unsupported result", "blank version", "rejected check"] as const)(
    "keeps a %s startup update result out of the notice and transcript",
    async (scenario) => {
      const terminal = new FakeTerminal();
      const checkForUpdate = vi.fn(async () => {
        if (scenario === "rejected check")
          throw new Error("registry unavailable");
        if (scenario === "unsupported result") return undefined;
        return { latestVersion: "   " };
      });
      const app = createTuiApp({
        runtime: createRuntime(),
        terminal,
        version: "1.2.3",
        workspaceDir: "/workspace",
        checkForUpdate,
      });

      app.start();
      await app.ready;
      await vi.waitFor(() => expect(checkForUpdate).toHaveBeenCalledOnce());
      await app.stop();

      expect(terminal.writes.join("")).not.toContain(
        "A new version of MCode is available",
      );
      expect(
        app.transcript.snapshot().filter((cell) => cell.kind === "error"),
      ).toEqual([]);
    },
  );

  it("routes /update through the in-process update confirmation flow", async () => {
    const plan = {
      kind: "available" as const,
      source: "managed-installer" as const,
      currentVersion: "1.2.3",
      latestVersion: "1.2.4",
      channel: "stable" as const,
    };
    const inspectUpdate = vi.fn(async () => plan);
    const applyUpdate = vi.fn(async () => ({
      applied: true,
      message:
        "MCode 1.2.4 is installed. Restart running MCode sessions to use it.",
    }));
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal: new FakeTerminal(),
      version: "1.2.3",
      workspaceDir: "/workspace",
      inspectUpdate,
      applyUpdate,
    });

    await app.ready;
    await app.submit("/update");

    expect(inspectUpdate).toHaveBeenCalledOnce();
    expect(app.interaction.current()?.render(80).join("\n")).toContain(
      "MCode update",
    );
    app.interaction.current()?.handleInput?.("\r");
    await vi.waitFor(() =>
      expect(applyUpdate).toHaveBeenCalledWith(
        plan,
        expect.objectContaining({
          onOutput: expect.any(Function),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        app.transcript
          .snapshot()
          .some((cell) => cell.content.includes("MCode update completed")),
      ).toBe(true),
    );
    await app.stop();
  });

  it("leaves the current TUI after /update stages an npm-prefix replacement", async () => {
    const plan = {
      kind: "package-manager" as const,
      source: "npm-prefix" as const,
      currentVersion: "1.2.3",
      latestVersion: "1.2.4",
      packageTag: "latest" as const,
      command: {
        executable: "npm",
        args: ["install"],
        display: "npm install",
      },
    };
    const requestRestart = vi.fn();
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal: new FakeTerminal(),
      version: "1.2.3",
      workspaceDir: "/workspace",
      inspectUpdate: async () => plan,
      applyUpdate: async () => ({
        applied: true,
        restartRequired: true,
        message: "MCode 1.2.4 is staged safely.",
      }),
      requestRestart,
    });

    app.start();
    await app.ready;
    await app.submit("/update");
    app.interaction.current()?.handleInput?.("\r");

    await vi.waitFor(() => expect(requestRestart).toHaveBeenCalledOnce());
    await app.stopped;
  });

  it("rechecks local and Runtime work before applying an update", async () => {
    const runtime = createRuntime();
    const applyUpdate = vi.fn(async () => ({
      applied: true,
      message: "updated",
    }));
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "1.2.3",
      workspaceDir: "/workspace",
      inspectUpdate: async () => ({
        kind: "available",
        source: "managed-installer",
        currentVersion: "1.2.3",
        latestVersion: "1.2.4",
        channel: "stable",
      }),
      applyUpdate,
    });
    await app.ready;
    await app.openSession("session-1");
    vi.mocked(runtime.getActiveRun).mockResolvedValue({
      schemaVersion: 1,
      sessionId: "session-1",
      state: "running",
      turnId: "turn-active",
      actions: { steer: true },
    });

    await app.submit("/update");
    app.interaction.current()?.handleInput?.("\r");

    await vi.waitFor(() =>
      expect(
        app.transcript
          .snapshot()
          .some((cell) =>
            cell.content.includes(
              "MCode update failed: Finish or stop the active response before updating.",
            ),
          ),
      ).toBe(true),
    );
    expect(applyUpdate).not.toHaveBeenCalled();
    await app.stop();
  });

  it("fails the update gate closed when Runtime state cannot be verified", async () => {
    const runtime = createRuntime();
    const applyUpdate = vi.fn(async () => ({
      applied: true,
      message: "updated",
    }));
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "1.2.3",
      workspaceDir: "/workspace",
      inspectUpdate: async () => ({
        kind: "available",
        source: "managed-installer",
        currentVersion: "1.2.3",
        latestVersion: "1.2.4",
        channel: "stable",
      }),
      applyUpdate,
    });
    await app.ready;
    await app.openSession("session-1");
    vi.mocked(runtime.getActiveRun).mockRejectedValue(
      new Error("Runtime unavailable"),
    );

    await app.submit("/update");
    app.interaction.current()?.handleInput?.("\r");

    await vi.waitFor(() =>
      expect(
        app.transcript
          .snapshot()
          .some((cell) =>
            cell.content.includes("Unable to verify that this Session is idle"),
          ),
      ).toBe(true),
    );
    expect(applyUpdate).not.toHaveBeenCalled();
    await app.stop();
  });

  it("does not expose the TUI before base hydration has settled", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let releaseSessions: (() => void) | undefined;
    vi.mocked(runtime.listSessions).mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseSessions = () => resolve([]);
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    let settled = false;
    void app.ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSessions?.();
    await app.ready;
    app.start();
    const rendered = app.tui.render(80).join("\n");
    expect(rendered).not.toContain("Starting MiniMax Code");
    expect(rendered).not.toContain("Loading session");
    await app.stop();
  });

  it("renders server startup in the welcome composer header until hydration settles", async () => {
    const runtime = createRuntime();
    let releaseSessions: (() => void) | undefined;
    vi.mocked(runtime.listSessions).mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseSessions = () => resolve([]);
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    try {
      app.setStartupStatus("⠋ Starting server...");
      app.start();

      const starting = app.tui.render(80).join("\n");
      expect(starting).toContain("⠋ Starting server...");
      expect(starting).not.toContain("Start · @ file or Plugin · / autocomplete");
      expect(starting).not.toContain("Loading session");

      releaseSessions?.();
      await app.ready;
      app.setStartupStatus(undefined);

      expect(app.tui.render(80).join("\n")).toContain(
        "Start · @ file or Plugin · / autocomplete",
      );
    } finally {
      releaseSessions?.();
      await app.stop();
    }
  });

  it("waits for account hydration before allowing the first message", async () => {
    const runtime = createRuntime();
    let resolveAccount!: (
      account: Awaited<ReturnType<typeof runtime.getAccountStatus>>,
    ) => void;
    vi.mocked(runtime.getAccountStatus).mockReturnValue(
      new Promise((resolve) => {
        resolveAccount = resolve;
      }),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    try {
      const readiness = await Promise.race([
        app.ready.then(() => "ready" as const),
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 100),
        ),
      ]);

      expect(readiness).toBe("blocked");
      expect(runtime.createSession).not.toHaveBeenCalled();
      resolveAccount({
        status: "ready",
        defaultModel: "minimax/MiniMax-M2.7",
        managedTokenPresent: true,
        warnings: [],
      });
      await app.ready;
      const submission = app.submit("Send after account hydration");
      await submission;
      expect(runtime.createSession).toHaveBeenCalledWith({
        workspaceDir: "/workspace",
      });
      expect(app.transcript.snapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "user",
            content: "Send after account hydration",
          }),
          expect.objectContaining({
            kind: "assistant",
            content: "Hello from the Agent",
          }),
        ]),
      );
    } finally {
      resolveAccount({
        status: "ready",
        defaultModel: "minimax/MiniMax-M2.7",
        managedTokenPresent: true,
        warnings: [],
      });
      await app.ready;
      await app.stop();
    }
  });

  it("does not wait for Token Plan membership hydration before App readiness", async () => {
    const runtime = createRuntime();
    const baseAccount = {
      status: "ready" as const,
      defaultModel: "minimax/MiniMax-M2.7",
      providerId: "minimax",
      modelId: "MiniMax-M2.7",
      authMode: "managed-login",
      managedTokenPresent: true,
      modelSource: "token-plan" as const,
      warnings: [],
    };
    const hydratedAccount = {
      ...baseAccount,
      tokenPlanQuotaState: "available" as const,
      tokenPlanQuota: {
        fiveHour: { remainingPercent: 90, unlimited: false },
        weekly: { remainingPercent: 80, unlimited: false },
      },
    };
    let resolveMembership!: (account: typeof hydratedAccount) => void;
    vi.mocked(runtime.getAccountStatus).mockImplementation(
      async (_sessionId, options) => {
        if (options?.includeMembership === true) {
          return await new Promise((resolve) => {
            resolveMembership = resolve;
          });
        }
        return baseAccount;
      },
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    try {
      await app.ready;
      expect(runtime.getAccountStatus).toHaveBeenCalledWith(undefined, {
        includeMembership: false,
      });
      expect(runtime.getAccountStatus).toHaveBeenCalledWith(undefined, {
        includeMembership: true,
      });
      expect(app.controller.snapshot().account).toMatchObject(baseAccount);

      resolveMembership(hydratedAccount);
      await vi.waitFor(() =>
        expect(app.controller.snapshot().account).toMatchObject({
          tokenPlanQuotaState: "available",
        }),
      );
    } finally {
      resolveMembership(hydratedAccount);
      await app.stop();
    }
  });

  it("waits for permission mode hydration before reporting App readiness", async () => {
    const runtime = createRuntime();
    let resolvePermissionMode!: (mode: "auto") => void;
    vi.mocked(runtime.getPermissionMode).mockReturnValue(
      new Promise((resolve) => {
        resolvePermissionMode = resolve;
      }),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    const readiness = Promise.race([
      app.ready.then(() => "ready" as const),
      new Promise<"blocked">((resolve) =>
        setTimeout(() => resolve("blocked"), 100),
      ),
    ]);

    await expect(readiness).resolves.toBe("blocked");
    resolvePermissionMode("auto");
    await app.ready;
    await app.stop();
  });

  it("accepts modeled account and optional permission degradation at the ready boundary", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getAccountStatus).mockRejectedValue(
      new Error("account offline"),
    );
    vi.mocked(runtime.getPermissionMode).mockRejectedValue(
      new Error("config unavailable"),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await expect(app.ready).resolves.toBeUndefined();
    expect(app.controller.snapshot().account).toEqual({
      status: "unknown",
      warnings: [],
    });
    await app.stop();
  });

  it.each([true, false])(
    "hydrates the BYOK model and welcome status with managed token %s",
    async (managedTokenPresent) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      vi.mocked(runtime.getAccountStatus).mockResolvedValue({
        status: "ready",
        defaultModel: "custom_provider:innerTest/MiniMax-M3",
        providerId: "custom_provider:innerTest",
        modelId: "MiniMax-M3",
        authMode: "byok",
        managedTokenPresent,
        modelSource: "byok",
        warnings: [],
      });
      vi.mocked(runtime.listModels).mockResolvedValue([
        {
          providerId: "custom_provider:innerTest",
          modelId: "MiniMax-M3",
          displayName: "m3.05",
          selected: true,
        },
      ]);
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
      });

      app.start();
      await app.ready;

      await vi.waitFor(() => expect(app.tui.render(120).join("\n")).toContain("✦ m3.05"));
      const welcome = stripAnsi(app.tui.render(120).join("\n"));
      expect(welcome).toContain("● Ready");
      expect(welcome).not.toContain("Login required");
      expect(welcome).not.toContain("Sign in with /login");
      await app.stop();
    },
  );

  it("restores a managed-login failure to the Composer", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.getAccountStatus).mockResolvedValue({
      status: "ready",
      defaultModel: "minimax/MiniMax-M2.7",
      authMode: "managed-login",
      modelSource: "token-plan",
      managedTokenPresent: false,
      warnings: [],
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await vi.waitFor(() =>
      expect(app.tui.render(80).join("\n")).toContain("Sign in with /login"),
    );
    terminal.input?.("Keep this until login");
    terminal.input?.("\r");

    await vi.waitFor(() =>
      expect(app.editor.getText()).toBe("Keep this until login"),
    );
    expect(app.tui.render(80).join("\n")).toContain("Keep this until login");
    expect(app.transcript.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "warning",
          content:
            "Sign in to MiniMax to use Agent features. Run /login, then retry.",
        }),
      ]),
    );
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    await app.stop();
  });

  it("renders an Enter submission before the asynchronous login preflight settles", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    let resolveAccount:
      | ((
          account: Awaited<ReturnType<typeof runtime.getAccountStatus>>,
        ) => void)
      | undefined;
    vi.mocked(runtime.getAccountStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAccount = resolve;
        }),
    );
    const writesBeforeSubmission = terminal.writes.length;

    terminal.input?.("Show this immediately");
    terminal.input?.("\r");

    expect(app.editor.getText()).toBe("");
    expect(
      app.transcript.snapshot().filter((cell) => cell.kind === "user"),
    ).toEqual([
      expect.objectContaining({
        status: "pending",
        content: "Show this immediately",
      }),
    ]);
    await vi.waitFor(() =>
      expect(terminal.writes.length).toBeGreaterThan(writesBeforeSubmission),
    );
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(resolveAccount).toBeTypeOf("function"));
    resolveAccount?.({
      status: "ready",
      defaultModel: "minimax/MiniMax-M2.7",
      providerId: "minimax",
      modelId: "MiniMax-M2.7",
      authMode: "managed-login",
      managedTokenPresent: true,
      warnings: [],
    });
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledOnce());
    await app.stop();
  });

  it("keeps a login-blocked submission editable after current-region sign-in", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let authenticated = false;
    vi.mocked(runtime.getAccountStatus).mockImplementation(async () =>
      authenticated
        ? {
            status: "ready",
            defaultModel: "minimax/MiniMax-M2.7",
            providerId: "minimax",
            modelId: "MiniMax-M2.7",
            authMode: "managed-login",
            modelSource: "token-plan",
            managedTokenPresent: true,
            warnings: [],
          }
        : {
            status: "needs-login",
            authMode: "managed-login",
            modelSource: "token-plan",
            managedTokenPresent: false,
            warnings: [],
          },
    );
    const auth = {
      login: vi.fn(async () => {
        authenticated = true;
        return {
          state: "authenticated" as const,
          message: "Signed in with MiniMax.",
        };
      }),
      logout: vi.fn(async () => ({
        state: "signed-out" as const,
        message: "Signed out of MiniMax.",
      })),
    };
    const app = createTuiApp({
      runtime,
      auth,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("Send this after login");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.editor.getText()).toBe("Send this after login"),
    );

    await app.submit("/login");
    app.interaction.current()?.handleInput("\r");

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    app.editor.handleInput("\r");
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledOnce());
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        content: "Send this after login",
        turnId: expect.any(String),
      }),
      expect.any(AbortSignal),
    );
    expect(app.transcript.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "user",
          content: "Send this after login",
        }),
      ]),
    );
    await app.stop();
  });

  it("runs /checkin immediately for a signed-in MiniMax account", async () => {
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/checkin");

    expect(runtime.runDailyCheckin).toHaveBeenCalledOnce();
    expect(app.transcript.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "final-summary",
          content: expect.stringContaining(
            "Checked in: Cycle day 2, +20 Credits",
          ),
        }),
      ]),
    );
    await app.stop();
  });

  it("shows a generic /checkin failure without backend details", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.runDailyCheckin).mockRejectedValue(
      new Error("internal signin shard rejected request"),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/checkin");

    const transcript = app.transcript
      .snapshot()
      .map((cell) => cell.content)
      .join("\n");
    expect(transcript).toContain("Couldn't complete daily check-in.");
    expect(transcript).not.toContain("internal signin shard");
    await app.stop();
  });

  it("does not open login when /checkin cannot verify account status", async () => {
    const runtime = createRuntime();
    const auth = {
      login: vi.fn(),
      logout: vi.fn(async () => ({
        state: "signed-out" as const,
        message: "Signed out of MiniMax.",
      })),
    };
    const app = createTuiApp({
      runtime,
      auth,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    vi.mocked(runtime.getAccountStatus).mockRejectedValue(
      new Error("status unavailable"),
    );
    await app.submit("/checkin");

    expect(app.interaction.current()).toBeUndefined();
    expect(auth.login).not.toHaveBeenCalled();
    expect(runtime.runDailyCheckin).not.toHaveBeenCalled();
    await app.stop();
  });

  it("starts MiniMax login and resumes /checkin once after authentication", async () => {
    const runtime = createRuntime();
    let authenticated = false;
    vi.mocked(runtime.getAccountStatus).mockImplementation(async () => ({
      status: authenticated ? "ready" : "needs-login",
      authMode: "managed-login",
      modelSource: "byok",
      managedTokenPresent: authenticated,
      warnings: [],
    }));
    const auth = {
      login: vi.fn(async () => {
        authenticated = true;
        return {
          state: "authenticated" as const,
          message: "Signed in with MiniMax.",
        };
      }),
      logout: vi.fn(async () => ({
        state: "signed-out" as const,
        message: "Signed out of MiniMax.",
      })),
    };
    const app = createTuiApp({
      runtime,
      auth,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/checkin");
    expect(runtime.runDailyCheckin).not.toHaveBeenCalled();

    app.interaction.current()?.handleInput("\r");

    await vi.waitFor(() =>
      expect(runtime.runDailyCheckin).toHaveBeenCalledOnce(),
    );
    expect(auth.login).toHaveBeenCalledWith(expect.any(Function), "cn");
    await app.stop();
  });

  it("does not resume /checkin when the login picker is cancelled", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getAccountStatus).mockResolvedValue({
      status: "needs-login",
      authMode: "managed-login",
      modelSource: "byok",
      managedTokenPresent: false,
      warnings: [],
    });
    const auth = {
      login: vi.fn(),
      logout: vi.fn(async () => ({
        state: "signed-out" as const,
        message: "Signed out of MiniMax.",
      })),
    };
    const app = createTuiApp({
      runtime,
      auth,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/checkin");
    app.interaction.current()?.handleInput("\u001b");

    expect(auth.login).not.toHaveBeenCalled();
    expect(runtime.runDailyCheckin).not.toHaveBeenCalled();
    await app.stop();
  });

  it("does not resume /checkin when browser login fails", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getAccountStatus).mockResolvedValue({
      status: "needs-login",
      managedTokenPresent: false,
      warnings: [],
    });
    const auth = {
      login: vi.fn(async () => {
        throw new Error("browser login failed");
      }),
      logout: vi.fn(async () => ({
        state: "signed-out" as const,
        message: "Signed out of MiniMax.",
      })),
    };
    const app = createTuiApp({
      runtime,
      auth,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/checkin");
    app.interaction.current()?.handleInput("\r");

    await vi.waitFor(() => expect(auth.login).toHaveBeenCalledOnce());
    expect(runtime.runDailyCheckin).not.toHaveBeenCalled();
    await app.stop();
  });

  it("carries /checkin through a cross-region login restart", async () => {
    const runtime = createRuntime();
    const requestRestart = vi.fn();
    vi.mocked(runtime.getAccountStatus).mockResolvedValue({
      status: "needs-login",
      managedTokenPresent: false,
      warnings: [],
    });
    const auth = {
      login: vi.fn(async () => ({
        state: "authenticated" as const,
        restartRequired: true,
        message: "Signed in with MiniMax Global.",
      })),
      logout: vi.fn(async () => ({
        state: "signed-out" as const,
        message: "Signed out of MiniMax.",
      })),
    };
    const app = createTuiApp({
      runtime,
      auth,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
      requestRestart,
    });

    app.start();
    await app.ready;
    await app.submit("/checkin");
    app.interaction.current()?.handleInput("\u001b[B");
    app.interaction.current()?.handleInput("\r");

    await vi.waitFor(() =>
      expect(requestRestart).toHaveBeenCalledWith("en", "/checkin"),
    );
    expect(runtime.runDailyCheckin).not.toHaveBeenCalled();
    await app.stopped;
  });

  it("restarts after cross-region login while keeping the blocked submission", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const requestRestart = vi.fn();
    const notifyAuthContextChanged = vi.fn(async () => undefined);
    vi.mocked(runtime.getAccountStatus).mockResolvedValue({
      status: "needs-login",
      authMode: "managed-login",
      modelSource: "token-plan",
      managedTokenPresent: false,
      warnings: [],
    });
    const auth = {
      login: vi.fn(async () => ({
        state: "authenticated" as const,
        restartRequired: true,
        message: "Signed in with MiniMax Global.",
      })),
      logout: vi.fn(async () => ({
        state: "signed-out" as const,
        message: "Signed out of MiniMax.",
      })),
    };
    const app = createTuiApp({
      runtime,
      auth,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      requestRestart,
      notifyAuthContextChanged,
    });

    app.start();
    await app.ready;
    terminal.input?.("Keep this through restart");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.editor.getText()).toBe("Keep this through restart"),
    );

    await app.submit("/login");
    app.interaction.current()?.handleInput("\u001b[B");
    app.interaction.current()?.handleInput("\r");

    await vi.waitFor(() => expect(auth.login).toHaveBeenCalledOnce());
    expect(auth.login).toHaveBeenCalledWith(expect.any(Function), "en");
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(requestRestart).toHaveBeenCalledOnce());
    expect(requestRestart).toHaveBeenCalledWith("en");
    expect(notifyAuthContextChanged).not.toHaveBeenCalled();
    await app.stopped;
    expect(app.editor.getText()).toBe("Keep this through restart");
  });

  it("shows ready and runs an unauthenticated builtin BYOK Turn", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getAccountStatus).mockResolvedValue({
      status: "ready",
      defaultModel: "minimax/MiniMax-M3",
      providerId: "minimax",
      authMode: "managed-login",
      modelSource: "byok",
      managedTokenPresent: false,
      warnings: [],
    });
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
      statusLineItems: ["build-mode"],
    });

    app.start();
    await app.ready;
    const welcome = stripAnsi(app.tui.render(120).join("\n"));
    expect(welcome).toContain("● Ready");
    expect(welcome).toContain("state=ready");
    expect(welcome).not.toContain("Sign in with /login");
    expect(welcome).not.toContain("Login required");

    await app.submit("BYOK still runs");

    expect(runtime.createSession).toHaveBeenCalledWith({
      workspaceDir: "/workspace",
    });
    expect(app.transcript.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "user", content: "BYOK still runs" }),
        expect.objectContaining({
          kind: "assistant",
          content: "Hello from the Agent",
        }),
      ]),
    );
    await app.stop();
  });

  it("starts a terminal-native workbench and submits messages through the Agent runtime", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      terminalCapabilities: TERMINAL_CAPABILITIES,
      version: "0.1.0",
      workspaceDir: "/workspace",
      homeDir: "/home/dev",
    });

    app.start();
    await app.ready;
    expect(app.getSurface()).toBe("welcome");
    await app.submit("Say hello");

    expect(app.getSurface()).toBe("conversation");
    const conversation = app.tui.render(80).join("\n");
    expect(conversation).toContain("Tips for getting started");
    expect(conversation).toContain("Say hello");
    expect(conversation).toContain("Hello from the Agent");
    expect(terminal.started).toBe(true);
    expect(terminal.title).toBe("Done | workspace (session-) | MCode");
    expect(runtime.createSession).toHaveBeenCalledWith({
      workspaceDir: "/workspace",
    });
    expect(app.transcript.snapshot()).toEqual([
      expect.objectContaining({ kind: "user", content: "Say hello" }),
      expect.objectContaining({
        kind: "assistant",
        status: "succeeded",
        content: "Hello from the Agent",
      }),
      expect.objectContaining({ kind: "turn-duration", status: "succeeded" }),
    ]);

    await app.stop();
    expect(terminal.stopped).toBe(true);
  });

  it("syncs the generated Session title to the terminal without duplicate writes", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let sessionTitle = "New session";
    let emitEvent: ((event: TuiRuntimeEvent) => void) | undefined;
    vi.mocked(runtime.listSessions).mockImplementation(async () => [
      {
        sessionId: "session-1",
        title: sessionTitle,
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        const event = await new Promise<TuiRuntimeEvent | undefined>(
          (resolve) => {
            emitEvent = resolve;
            signal.addEventListener("abort", () => resolve(undefined), {
              once: true,
            });
          },
        );
        if (event) yield event;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      terminalCapabilities: TERMINAL_CAPABILITIES,
      terminalTitle: ["session-name"],
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("Review uncommitted work");
    await vi.waitFor(() => expect(emitEvent).toBeTypeOf("function"));

    sessionTitle = "Review uncommitted work";
    emitEvent?.(
      runtimeEvent({
        type: "session.title_updated",
        timestamp: Date.now(),
        source: "runtime",
        payload: {
          sessionId: "session-1",
          title: sessionTitle,
        },
      }),
    );

    await vi.waitFor(() => expect(terminal.title).toBe(sessionTitle));
    const titleWrites = terminal.titleUpdates.length;
    await app.submit("/status");
    expect(terminal.titleUpdates).toHaveLength(titleWrites);
    await app.submit("/rename Renamed session");
    expect(terminal.title).toBe("Renamed session");

    await app.suspend();
    expect(terminal.title).toBe("");
    await app.controller.renameCurrentSession("Renamed while suspended");
    expect(terminal.title).toBe("");
    await app.resume();
    expect(terminal.title).toBe("Renamed while suspended");

    await app.stop();
    expect(terminal.title).toBe("");
  });

  it.each([
    ["session.finish", false, 1],
    ["session.finish", true, 0],
    ["session.error", true, 1],
    ["session.abort", false, 0],
  ] as const)("notifies once for %s with queued=%s", async (type, queued, count) => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let handled = false;
    vi.mocked(runtime.listQueuedMessages).mockResolvedValue(
      queued
        ? [{
            itemId: "queued-1",
            sessionId: "session-1",
            status: "queued",
            content: "Next message",
          }]
        : [],
    );
    vi.mocked(runtime.watchEvents).mockImplementation(async function* (signal) {
      const event = runtimeEvent({
        type,
        timestamp: Date.now(),
        source: "runtime",
        payload: {
          sessionId: "session-1",
          turnId: "turn-1",
          error: "Synthetic failure",
        },
      });
      yield event;
      yield event;
      handled = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      terminalCapabilities: TERMINAL_CAPABILITIES,
      notifications: { when: "always", method: "osc9" },
    });
    try {
      await app.ready;
      await app.openSession("session-1");
      app.start();
      await vi.waitFor(() => expect(handled).toBe(true));
      const notifications = terminal.writes.filter((value) => value.startsWith("\u001b]9;"));
      expect(notifications).toHaveLength(count);
      if (count) expect(notifications[0]).toContain("Existing session: Response");
    } finally {
      await app.stop();
    }
  });

  it("keeps chat state alive while a regular feature overlay owns the viewport", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 6;
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    const featureInput = vi.fn();
    const featureContent = {
      render: () => ["feature-header", "feature-body"],
      invalidate: () => undefined,
    };
    const feature = {
      id: "sessions",
      layoutRoot: new VStack([{ component: featureContent }]),
      render: featureContent.render,
      invalidate: () => undefined,
      handleInput: featureInput,
    };

    app.start();
    await app.ready;
    const screen = new VirtualTerminalScreen(terminal.columns, terminal.rows);
    let writeIndex = 0;
    const flushWrites = (): void => {
      for (; writeIndex < terminal.writes.length; writeIndex += 1) {
        screen.feed(terminal.writes[writeIndex] ?? "");
      }
    };
    flushWrites();
    app.editor.setText("preserved draft");
    const handle = app.surfaceHost.pushFeature({ screen: feature });
    app.tui.renderNow();
    flushWrites();

    expect(app.surfaceHost.getActiveSurface()).toEqual({
      kind: "feature",
      id: "sessions",
    });
    expect(app.surfaceHost.render(80).join("\n")).toContain("preserved draft");
    expect(screen.viewportText()).toContain("feature-header");
    expect(screen.viewportText()).toContain("feature-body");
    expect(app.tui.mode).toBe("regular");
    expect(terminal.startCount).toBe(1);
    expect(terminal.stopCount).toBe(0);
    terminal.input?.("j");
    expect(featureInput).toHaveBeenCalledWith("j");

    expect(handle.close()).toBe(true);
    app.tui.renderNow();
    flushWrites();
    expect(app.surfaceHost.getActiveSurface()).toEqual({
      kind: "chat",
      id: "chat",
    });
    expect(app.editor.getText()).toBe("preserved draft");
    expect(app.surfaceHost.render(80).join("\n")).toContain("preserved draft");
    expect(screen.viewportText()).toContain("preserved draft");
    expect(screen.viewportText()).not.toContain("feature-header");

    await app.stop();
    screen.dispose();
  });

  it("switches /settings through explicit choices and closes after applying", async () => {
    const terminal = new FakeTerminal();
    const persistTuiMode = vi.fn();
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.2.0",
      workspaceDir: "/workspace",
      tuiMode: "regular",
      persistTuiMode,
    });

    app.start();
    await app.ready;
    expect(app.surfaceHost.getChatMode()).toBe("regular");
    expect(app.tui.mode).toBe("regular");

    await app.submit("/settings");
    const fullscreenSettings = app.interaction.current();
    expect(app.tui.getFocusedComponent()).toBe(fullscreenSettings);
    expect(app.surfaceHost.render(80).join("\n")).toContain(
      "TUI mode · Regular",
    );
    terminal.input?.("\u001b[B");
    terminal.input?.("\r");

    expect(app.surfaceHost.getChatMode()).toBe("fullscreen");
    expect(app.tui.mode).toBe("fullscreen");
    expect(app.interaction.isActive()).toBe(false);
    expect(app.tui.getFocusedComponent()).toBe(app.editor);
    expect(persistTuiMode).toHaveBeenLastCalledWith("fullscreen");
    expect(app.editor.focused).toBe(true);

    terminal.input?.("/");
    await vi.waitFor(() =>
      expect(app.editor.render(60).join("\n")).toContain(
        "Show available commands",
      ),
    );
    terminal.input?.("\u001b");
    app.editor.setText("");

    await app.submit("/settings");
    const regularSettings = app.interaction.current();
    expect(app.tui.getFocusedComponent()).toBe(regularSettings);
    expect(app.surfaceHost.render(80).join("\n")).toContain(
      "TUI mode · Fullscreen",
    );
    terminal.input?.("\u001b[A");
    terminal.input?.("\r");

    expect(app.surfaceHost.getChatMode()).toBe("regular");
    expect(app.tui.mode).toBe("regular");
    expect(app.interaction.isActive()).toBe(false);
    expect(app.tui.getFocusedComponent()).toBe(app.editor);
    expect(persistTuiMode).toHaveBeenLastCalledWith("regular");

    await app.stop();
  });

  it("keeps the Pi Editor and Slash Command autocomplete active in fullscreen chat", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 8;
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.2.0",
      workspaceDir: "/workspace",
      tuiMode: "fullscreen",
    });

    app.start();
    await app.ready;
    const writesBefore = terminal.writes.length;
    terminal.input?.("/");

    await vi.waitFor(() =>
      expect(app.editor.render(60).join("\n")).toContain(
        "Show available commands",
      ),
    );
    expect(app.editor.getText()).toBe("/");

    terminal.input?.("\u001B[B");
    expect(app.editor.getText()).toBe("/");

    terminal.input?.("\u001B");
    expect(app.editor.getText()).toBe("/");
    expect(app.editor.focused).toBe(true);
    expect(terminal.writes.slice(writesBefore).join("")).not.toContain("\x1b[3J");

    await app.stop();
  });

  it("renders regular-mode Slash Command autocomplete on the first keypress and every update", async () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.2.0",
      workspaceDir: "/workspace",
      tuiMode: "regular",
    });

    app.start();
    await app.ready;
    const screen = new VirtualTerminalScreen(terminal.columns, terminal.rows);
    let writeIndex = 0;
    const flushWrites = (): void => {
      for (; writeIndex < terminal.writes.length; writeIndex += 1) {
        screen.feed(terminal.writes[writeIndex] ?? "");
      }
    };
    flushWrites();

    terminal.input?.("/");
    await vi.waitFor(() => {
      flushWrites();
      expect(screen.viewportText()).toContain("Show available commands");
    });
    expect(screen.viewportText()).toContain("/");

    terminal.input?.("m");
    await vi.waitFor(() => {
      flushWrites();
      expect(screen.viewportText()).toContain("Choose a model");
    });
    expect(screen.viewportText()).toContain("/m");

    screen.dispose();
    await app.stop();
  });

  describe.each([
    ["xterm", VirtualTerminal],
    ["clear-to-scrollback terminal", ClearToScrollbackTerminal],
  ] as const)("autocomplete viewport restoration on %s", (_terminalName, Terminal) => {
    it.each([
      ["Escape", "\x1b", "/"],
      ["Tab", "\t", "/help "],
      ["Backspace", "\x7f", ""],
      ["no matches", "zzzzzz", "/zzzzzz"],
      ["filter to one command", "help", "/help"],
    ] as const)("restores the conversation viewport when Slash Command autocomplete shrinks via %s", async (_name, input, draft) => {
      const terminal = new Terminal(80, 24);
      const app = createTuiApp({
        runtime: createRuntime(),
        terminal,
        version: "0.2.0",
        workspaceDir: "/workspace",
        tuiMode: "regular",
      });

      app.start();
      try {
        await app.ready;
        for (let index = 0; index < 12; index++) await app.submit(`Message ${index}`);
        app.tui.renderNow();
        await terminal.flush();

        terminal.sendInput("/");
        await vi.waitFor(async () => {
          app.tui.renderNow();
          await terminal.flush();
          expect(terminal.getViewport().join("\n")).toContain("Show available commands");
        });
        const menuRows = app.editor.render(78).length;
        terminal.sendInput(input);
        await vi.waitFor(async () => {
          app.tui.renderNow();
          await terminal.flush();
          expect(app.editor.getText()).toBe(draft);
          expect(app.editor.render(78).length).toBeLessThan(menuRows);
          const expected = app.tui.render(80).map((line) => stripAnsi(line).trimEnd()).slice(-24);
          expect(terminal.getViewport().map((line) => line.trimEnd())).toEqual(expected);
        });
        const history = terminal.getScrollBuffer();
        for (let index = 0; index < 12; index++) {
          expect(history.filter((line) => line.trimEnd().endsWith(`› Message ${index}`))).toHaveLength(1);
        }
      } finally {
        await app.stop();
      }
    });
  });

  it("dismisses autocomplete in a short document without clearing native history", async () => {
    const terminal = new VirtualTerminal(80, 100);
    const app = createTuiApp({ runtime: createRuntime(), terminal, version: "0.2.0", workspaceDir: "/workspace" });
    const write = vi.spyOn(terminal, "write");
    app.start();
    try {
      await app.ready;
      terminal.sendInput("/");
      await vi.waitFor(async () => {
        app.tui.renderNow();
        await terminal.flush();
        expect(terminal.getViewport().join("\n")).toContain("Show available commands");
      });
      write.mockClear();
      terminal.sendInput("\x1b");
      app.tui.renderNow();
      await terminal.flush();
      expect(terminal.getViewport().join("\n")).not.toContain("Show available commands");
      expect(write.mock.calls.map(([data]) => data).join("")).not.toContain("\x1b[3J");
    } finally {
      await app.stop();
    }
  });

  it("resumes fullscreen tail following when submitting from scrolled history", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 6;
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.2.0",
      workspaceDir: "/workspace",
      tuiMode: "fullscreen",
    });

    app.start();
    await app.ready;
    for (let index = 1; index <= 4; index += 1) {
      await app.submit(`Prompt ${String(index)}`);
    }
    app.tui.renderNow();

    terminal.input?.("\u001B[5~");
    expect((app.tui as TuiAltScreen).isFollowingOutput).toBe(false);

    await app.submit("Latest prompt");
    expect((app.tui as TuiAltScreen).isFollowingOutput).toBe(true);

    await app.stop();
  });

  it("stops the terminal without waiting for a stalled Desktop event stream", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents() {
        await new Promise<void>(() => undefined);
        yield runtimeEvent({
          type: "unreachable",
          timestamp: 0,
          source: "test",
          payload: {},
        });
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const stopping = app.stop();
    await vi.waitFor(() => expect(terminal.stopped).toBe(true));
    await stopping;
  });

  it("restores the terminal before a stalled remote turn abort finishes", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishRemoteAbort: ((value: boolean) => void) | undefined;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.abortSession).mockImplementation(
      async () =>
        await new Promise<boolean>((resolve) => {
          finishRemoteAbort = resolve;
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const submitting = app.submit("Keep running");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().status).toBe("running"),
    );
    const stopping = app.stop();
    await vi.waitFor(() => expect(terminal.stopped).toBe(true));
    finishRemoteAbort?.(true);
    await Promise.all([submitting, stopping]);
  });

  it("stops the active turn before leaving the UI", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishTurn: (() => void) | undefined;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        yield {
          type: "delta",
          turnId: "turn-detached",
          role: "assistant",
          content: "Still running",
        };
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        yield { type: "done", turnId: "turn-detached" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const submitting = app.submit("Keep running after the UI leaves");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().status).toBe("running"),
    );

    await app.leaveUi();

    expect(terminal.stopped).toBe(true);
    expect(runtime.abortSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1" }),
    );
    finishTurn?.();
    await submitting;
  });

  it("resumes a launcher-selected Session and exposes its ID for the exit hint", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    expect(app.controller.snapshot().session?.sessionId).toBeUndefined();

    await app.openSession("session-existing");

    expect(runtime.getSession).toHaveBeenCalledWith("session-existing");
    expect(runtime.getMessages).toHaveBeenCalledWith("session-existing");
    expect(app.controller.snapshot().session?.sessionId).toBe(
      "session-existing",
    );
    await app.leaveUi();
  });

  it("reports a launcher continue hydration failure in the Transcript", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-existing",
        title: "Existing session",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.getSession).mockRejectedValue(
      new Error("Session hydration failed"),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await expect(app.continueLatestSession()).rejects.toThrow(
      "Session hydration failed",
    );

    expect(app.transcript.snapshot().at(-1)).toMatchObject({
      kind: "error",
      content:
        "Couldn't continue the latest conversation: Session hydration failed. Retry after the connection recovers.",
    });
    await app.leaveUi();
  });

  it("can disable queue UI and preserve the next draft while a turn is running", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishTool: (() => void) | undefined;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        yield {
          type: "delta",
          turnId: "turn-running-tool",
          toolCalls: [
            {
              id: "read-1",
              name: "read",
              status: "running",
              input: { path: "src/cart/price.ts" },
            },
          ],
        };
        await new Promise<void>((resolve) => {
          finishTool = resolve;
        });
        yield { type: "done", turnId: "turn-running-tool" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      productFeatures: { queue: false },
    });
    await app.ready;
    const submission = app.submit("Inspect the pricing logic");

    await vi.waitFor(() => {
      const rendered = app.tui.render(80).join("\n");
      expect(rendered).toContain("Reading (src/cart/price.ts)");
      expect(rendered).toContain("Running");
      expect(rendered).not.toContain("Running · 0s");
      expect(rendered).not.toContain("Running · Read");
      expect(rendered).not.toContain("MCode · Running");
      expect(rendered).toContain("Ctrl+O details");
      expect(rendered).toContain("Esc stop");
      expect(rendered).not.toContain("Enter run next");
      expect(rendered).not.toContain("Message · Enter send");
      expect(rendered).not.toContain("Follow-up");
      expect(rendered).not.toContain("waiting");
    });

    await app.submit("Review the tests next");
    expect(runtime.enqueueMessage).not.toHaveBeenCalled();
    expect(app.editor.getText()).toBe("Review the tests next");
    expect(app.tui.render(80).join("\n")).toContain("Esc to interrupt");

    finishTool?.();
    await submission;
  });

  it("refreshes the running queue hint from the same bindings as the hotkeys panel", async () => {
    const keybindings = createTuiHostKeybindings({
      platform: "linux",
      suspendSupported: true,
    });
    const runtime = createRuntime();
    let finishTurn: (() => void) | undefined;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        yield {
          type: "delta",
          turnId: "turn-custom-queue",
          thinking: "Inspecting the repository",
        };
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        yield { type: "done", turnId: "turn-custom-queue" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
      keybindings: keybindings.registry,
    });
    await app.ready;
    keybindings.manager.setUserBindings({ "run.queue-draft": "ctrl+enter" });
    const submission = app.submit("Inspect the repository");

    try {
      await vi.waitFor(() => {
        const rendered = stripAnsi(app.tui.render(100).join("\n"));
        expect(rendered).toContain("Running");
        expect(rendered).toContain("Ctrl+Enter queue");
        expect(rendered).not.toContain("Alt+Enter queue");
        expect(
          keybindings.registry
            .helpRows()
            .find((row) => row.ids.includes("run.queue-draft"))?.keys,
        ).toBe("Ctrl+Enter");
      });
    } finally {
      finishTurn?.();
      await submission;
      await app.stop();
    }
  });

  it("shows running Thinking in chat and opens the full Transcript with /transcript", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishThinking: (() => void) | undefined;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        yield {
          type: "delta",
          turnId: "turn-running-thinking",
          thinking: "Inspecting the repository",
        };
        await new Promise<void>((resolve) => {
          finishThinking = resolve;
        });
        yield { type: "done", turnId: "turn-running-thinking" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const submission = app.submit("Inspect the repository");
    const countThinkingBodyRows = (rendered: string): number =>
      rendered
        .split("\n")
        .filter(
          (line) =>
            line.includes("Inspecting the repository") &&
            !line.includes("MCode"),
        ).length;
    let expandedThinkingRows = 0;

    try {
      await vi.waitFor(() => {
        const thinking = app.transcript
          .snapshot()
          .find((cell) => cell.kind === "thinking");
        expect(thinking?.content).toBe("Inspecting the repository");
        expect(thinking?.expanded).toBeUndefined();
        const rendered = app.tui.render(80).join("\n");
        expect(rendered).toContain("Running");
        expect(rendered).not.toContain("Running · 0s");
        expect(rendered).toContain(`${formatTuiShortcut("alt+enter")} queue`);
        expect(rendered).toContain("Enter steer");
        expect(rendered).not.toContain(`${formatTuiShortcut("ctrl+x")} steer`);
        expect(rendered).toContain("Ctrl+O details");
        expect(rendered).toContain("Esc stop");
        expect(rendered).toContain("Thinking…");
        expect(rendered).not.toContain("MCode ·");
        expect(rendered).not.toContain("Thinking · Inspecting the repository");
        expandedThinkingRows = countThinkingBodyRows(rendered);
        expect(expandedThinkingRows).toBeGreaterThan(0);
      });

      await app.submit("/transcript");
      await vi.waitFor(() => {
        const rendered = renderTerminalViewport(app, terminal);
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "transcript",
        });
        expect(rendered).toContain("Transcript");
        expect(rendered).not.toContain("Inspecting the repository");
        expect(countThinkingBodyRows(rendered)).toBeLessThan(
          expandedThinkingRows,
        );
      });

      terminal.input?.("\x14");
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "transcript",
      });

      finishThinking?.();
      finishThinking = undefined;
      await submission;
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "transcript",
      });
      expect(app.controller.snapshot().activeTurnId).toBeUndefined();
      expect(
        app.transcript.snapshot().find((cell) => cell.kind === "thinking"),
      ).toMatchObject({
        status: "succeeded",
      });

      terminal.input?.("\u001B");
      await vi.waitFor(() => {
        const rendered = app.tui.render(80).join("\n");
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "chat",
          id: "chat",
        });
        expect(rendered).toContain("Message · Enter send");
        expect(rendered).not.toContain("Running");
      });
    } finally {
      finishThinking?.();
      await submission;
      await app.stop();
    }
  });

  it("toggles hidden and full inline Tool output with Ctrl+O", async () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    app.transcript.upsert({
      id: "tool-detail-toggle",
      kind: "tool",
      status: "succeeded",
      title: "bash",
      content: '{"command":"pnpm test"}',
      detail: [
        "result line 1",
        "result line 2",
        "result line 3",
        "result line 4",
      ].join("\n"),
      createdAtMs: 1,
    });

    expect(app.tui.render(80).join("\n")).not.toContain("result line 1");
    expect(app.tui.render(80).join("\n")).not.toContain("result line 4");
    terminal.input?.("\x0f");
    const detailed = app.tui.render(80).join("\n");
    expect(detailed).toContain("result line 1");
    expect(detailed).toContain("result line 3");
    expect(detailed).toContain("result line 4");
    expect(detailed).not.toContain("Details expanded");
    terminal.input?.("\x0f");
    const compact = app.tui.render(80).join("\n");
    expect(compact).not.toContain("result line 1");
    expect(compact).not.toContain("result line 3");
    expect(compact).not.toContain("result line 4");
    expect(compact).not.toContain("Details collapsed");

    await app.stop();
  });

  it.each(["rewind", "edit"] as const)(
    "removes discarded todos after /history %s",
    async (action) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
        { userMessageId: "before-todo", timestamp: 1, fileChangeCount: 0 },
      ]);
      vi.mocked(runtime.listMessagePage).mockResolvedValue({
        messages: [{ id: "before-todo", role: "user", content: "Original prompt" }],
        hasMore: false,
      });
      const app = createTuiApp({ runtime, terminal, version: "0.1.0", workspaceDir: "/workspace" });
      app.start();
      try {
        await app.ready;
        await app.submit("Seed todo session");
        app.controller.applyRuntimeTurnEvent("discarded-turn", {
          type: "generic",
          eventType: "todo_updated",
          turnId: "discarded-turn",
          data: { todos: [{ content: "Discarded todo", status: "in_progress" }] },
        });
        expect(stripAnsi(app.tui.render(100).join("\n"))).toContain("Discarded todo");
        await app.submit("/history");
        await vi.waitFor(() =>
          expect(app.surfaceHost.getActiveSurface().id).toBe("session-history:explorer"),
        );
        terminal.input?.("\r");
        terminal.input?.("\x1b[B");
        if (action === "rewind") terminal.input?.("\x1b[B");
        terminal.input?.("\r");
        await vi.waitFor(() =>
          expect(app.surfaceHost.getActiveSurface().id).toBe(
            action === "rewind"
              ? "session-mutation:rewind-confirm"
              : "session-mutation:rewind-preview",
          ),
        );
        terminal.input?.("\r");
        if (action === "edit") {
          await vi.waitFor(() => expect(app.editor.getText()).toBe("Original prompt"));
          await app.submit("Revised prompt");
          expect(runtime.editSessionMessage).toHaveBeenCalledOnce();
        } else {
          await vi.waitFor(() => expect(runtime.rewindSession).toHaveBeenCalledOnce());
        }
        await vi.waitFor(() => expect(app.surfaceHost.getActiveSurface().kind).toBe("chat"));
        expect(stripAnsi(app.tui.render(100).join("\n"))).not.toContain("Discarded todo");
      } finally {
        await app.stop();
      }
    },
  );

  it.each([false, true])("handles exact /rewind locally while editing=%s", async (editing) => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      { userMessageId: "before-todo", timestamp: 1, fileChangeCount: 0 },
    ]);
    vi.mocked(runtime.listMessagePage).mockResolvedValue({
      messages: [{ id: "before-todo", role: "user", content: "Original prompt" }],
      hasMore: false,
    });
    const app = createTuiApp({ runtime, terminal, version: "0.1.0", workspaceDir: "/workspace" });
    app.start();
    try {
      await app.ready;
      await app.submit("Seed session");
      if (editing) {
        await app.submit("/edit");
        await vi.waitFor(() => expect(app.editor.getText()).toBe("Original prompt"));
      }
      const sends = vi.mocked(runtime.sendMessage).mock.calls.length;
      app.editor.setText("/rewind");
      app.editor.handleInput("\r");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface().id).toBe("session-mutation:history"),
      );
      expect(runtime.editSessionMessage).not.toHaveBeenCalled();
      expect(runtime.sendMessage).toHaveBeenCalledTimes(sends);
    } finally {
      await app.stop();
    }
  });

  it("uses Ctrl+T for tasks while Ctrl+O remains scoped to transcript details", async () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    app.controller.applyRuntimeTurnEvent("turn-todo", {
      type: "generic",
      eventType: "todo_updated",
      turnId: "turn-todo",
      data: {
        todos: [
          { content: "Inspect Desktop behavior", status: "completed" },
          { content: "Polish the task rail", status: "in_progress" },
          { content: "Run focused tests", status: "pending" },
          { content: "Review narrow layouts", status: "pending" },
          { content: "Update user documentation", status: "pending" },
          { content: "Publish the test package", status: "pending" },
        ],
      },
    });

    const compact = app.tui.render(80).join("\n");
    expect(compact).toContain("✓ Inspect Desktop behavior");
    expect(compact).toContain("● Polish the task rail");
    expect(compact).toContain("Ctrl+T expand");
    expect(compact).not.toContain("Publish the test package");
    expect(compact).not.toContain("todo_updated");

    terminal.input?.("\x0f");
    const transcriptDetailed = app.tui.render(80).join("\n");
    expect(transcriptDetailed).toContain("Ctrl+T expand");
    expect(transcriptDetailed).not.toContain("Publish the test package");

    terminal.input?.("\x14");
    const tasksExpanded = app.tui.render(80).join("\n");
    expect(tasksExpanded).toContain(
      "Todo list 1/6 · 5 remaining · Ctrl+T compact",
    );
    expect(tasksExpanded).toContain("Publish the test package");

    terminal.input?.("\x0f");
    expect(app.tui.render(80).join("\n")).toContain("Publish the test package");

    app.controller.applyRuntimeTurnEvent("turn-todo", {
      type: "generic",
      eventType: "todo_updated",
      turnId: "turn-todo",
      data: {
        todos: [
          { content: "Inspect Desktop behavior", status: "completed" },
          { content: "Polish the task rail", status: "completed" },
          { content: "Run focused tests", status: "completed" },
          { content: "Review narrow layouts", status: "completed" },
          { content: "Update user documentation", status: "completed" },
          { content: "Publish the test package", status: "completed" },
        ],
      },
    });
    expect(app.tui.render(80).join("\n")).toContain(
      "✓ Todo list 6/6 completed",
    );

    await app.stop();
  });

  it("keeps settled Thinking hidden until Ctrl+O requests transcript details", async () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    app.transcript.upsert({
      id: "thinking-detail-toggle",
      kind: "thinking",
      status: "succeeded",
      content: "Private settled reasoning",
      durationMs: 3_200,
      createdAtMs: 1,
      updatedAtMs: 3_201,
    });

    const compact = app.tui.render(80).join("\n");
    expect(compact).toContain("Thought for 3.2s");
    expect(compact).not.toContain("Private settled reasoning");

    terminal.input?.("\x0f");
    expect(app.tui.render(80).join("\n")).toContain(
      "Private settled reasoning",
    );

    terminal.input?.("\x0f");
    expect(app.tui.render(80).join("\n")).not.toContain(
      "Private settled reasoning",
    );

    await app.stop();
  });

  it("returns from the conversation surface to Welcome after /new", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.submit("Start a conversation");
    expect(app.getSurface()).toBe("conversation");

    await app.submit("/new");

    expect(app.getSurface()).toBe("welcome");
    expect(app.transcript.snapshot()).toEqual([]);
  });

  it("clears into a fresh conversation while keeping the previous session resumable", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.submit("Keep this conversation");
    expect(app.controller.snapshot().session?.sessionId).toBe("session-1");

    await app.submit("/clear");

    expect(app.getSurface()).toBe("welcome");
    expect(app.transcript.snapshot()).toEqual([]);
    expect(app.controller.snapshot()).toMatchObject({
      status: "idle",
      session: undefined,
      sessions: [expect.objectContaining({ sessionId: "session-1" })],
    });
    expect(runtime.archiveSession).not.toHaveBeenCalled();
  });

  it("opens read-only Help above the Composer without using a TUI overlay", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    const showOverlay = vi.spyOn(app.tui, "showOverlay");
    app.start();
    await app.ready;
    const modelRequestsBeforeHelp = vi.mocked(runtime.listModels).mock.calls
      .length;
    const activeRunRequestsBeforeHelp = vi.mocked(runtime.getActiveRun).mock
      .calls.length;
    await app.submit("/help");

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(app.transcript.snapshot()).toEqual([]);
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);
    expect(terminal.mouseTracking).toBe(false);

    terminal.input?.("m");
    terminal.input?.("\r");

    expect(app.tui.hasOverlay()).toBe(false);
    await vi.waitFor(() => expect(app.interaction.isActive()).toBe(false));
    expect(app.editor.getText()).toBe("");
    expect(runtime.listModels).toHaveBeenCalledTimes(modelRequestsBeforeHelp);
    expect(runtime.getActiveRun).toHaveBeenCalledTimes(
      activeRunRequestsBeforeHelp,
    );
    expect(showOverlay).not.toHaveBeenCalled();
    await app.stop();
  });

  it("lets Help use the available terminal height instead of capping it at twelve rows", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 30;
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.submit("/help");

    expect(app.interaction.current()?.render?.(terminal.columns)).toHaveLength(
      24,
    );

    terminal.rows = 18;

    expect(app.interaction.current()?.render?.(terminal.columns)).toHaveLength(
      12,
    );
    await app.stop();
  });

  it("keeps steer executable and exposes it in slash-command discovery", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.getActiveRun).mockImplementation(async (sessionId) => ({
      schemaVersion: 1,
      sessionId,
      state: "running",
      turnId: "turn-active",
      actions: { steer: true },
    }));
    vi.mocked(runtime.steer).mockResolvedValue({
      turnId: "turn-active",
      mode: "steered",
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.submit("Create session");
    await app.submit("/help");
    const helpPanel = app.interaction.current();
    expect(helpPanel).toBeDefined();
    expect(app.tui.hasOverlay()).toBe(false);
    const helpPages: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      const current = helpPanel?.render?.(100).join("\n") ?? "";
      if (current === helpPages.at(-1)) break;
      helpPages.push(current);
      helpPanel?.handleInput?.("\x1b[6~");
    }
    const help = helpPages.join("\n");
    expect(help).toContain("/steer <message>");
    expect(help).not.toContain("/send-now");
    expect(help).not.toContain("/retry");
    helpPanel?.handleInput?.("\x1b");

    await app.submit("/steer focus on the failing test");
    expect(runtime.steer).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        source: "api",
        message: { content: "focus on the failing test" },
        producerId: "mcode",
        idempotencyKey: expect.stringMatching(/^run_action_/u),
      }),
    );
    await app.stop();
  });

  it("refreshes Runtime steer capability before Enter submits the active Draft", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishTurn: (() => void) | undefined;
    let consumeSteer: (() => void) | undefined;
    const steerConsumptionReady = new Promise<void>((resolve) => {
      consumeSteer = resolve;
    });
    let steerAvailable = false;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        yield {
          type: "delta",
          turnId: "turn-active",
          content: "Working on it",
        };
        await steerConsumptionReady;
        yield {
          type: "message",
          message: {
            id: "message-steer",
            turnId: "turn-active",
            role: "user",
            content: "focus on the failing test",
          },
        };
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        yield { type: "done", turnId: "turn-active" };
      },
    );
    vi.mocked(runtime.getActiveRun).mockImplementation(async (sessionId) =>
      steerAvailable
        ? {
            schemaVersion: 1,
            sessionId,
            state: "running",
            turnId: "turn-active",
            actions: { steer: true },
          }
        : {
            schemaVersion: 1,
            sessionId,
            state: "idle",
            actions: { steer: false },
          },
    );
    vi.mocked(runtime.steer).mockResolvedValue({
      turnId: "turn-active",
      mode: "steered",
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const submission = app.submit("Inspect the failure");

    try {
      await vi.waitFor(() =>
        expect(app.tui.render(80).join("\n")).toContain("Running"),
      );
      steerAvailable = true;

      terminal.input?.("focus on the failing test");
      terminal.input?.("\r");

      expect(app.editor.getText()).toBe("");

      await vi.waitFor(() =>
        expect(runtime.steer).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: "session-1",
            source: "api",
            message: { content: "focus on the failing test" },
            producerId: "mcode",
            idempotencyKey: expect.stringMatching(/^run_action_/u),
            requestedTurnId: "turn-active",
          }),
        ),
      );
      expect(app.transcript.snapshot().at(-1)).toMatchObject({
        kind: "user",
        status: "pending",
        content: "focus on the failing test",
        userPresentation: "pending-steer",
      });
      expect(stripAnsi(app.tui.render(80).join("\n"))).toContain(
        "↳ Next · focus on the failing test",
      );

      consumeSteer?.();
      await vi.waitFor(() =>
        expect(
          app.transcript.snapshot().filter((cell) => cell.kind === "user"),
        ).toEqual([
          expect.objectContaining({ content: "Inspect the failure" }),
          expect.objectContaining({
            status: "succeeded",
            content: "focus on the failing test",
            sourceMessageId: "message-steer",
            userPresentation: undefined,
          }),
        ]),
      );
      const rendered = app.tui.render(80).join("\n");
      expect(rendered).toContain("Inspect the failure");
      expect(rendered).toContain("focus on the failing test");
      expect(stripAnsi(rendered)).not.toContain("↳ Next ·");
      expect(app.editor.getText()).toBe("");
    } finally {
      consumeSteer?.();
      await vi.waitFor(() => expect(finishTurn).toEqual(expect.any(Function)));
      finishTurn?.();
      await submission;
      await app.stop();
    }
  });

  it("queues with Alt+Enter, restores with Option+Up, then steers with Enter", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const queuedItems: TuiQueuedMessage[] = [];
    let finishTurn: (() => void) | undefined;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        yield {
          type: "delta",
          turnId: "turn-active",
          content: "Working on it",
        };
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        yield { type: "done", turnId: "turn-active" };
      },
    );
    vi.mocked(runtime.enqueueMessage).mockImplementation(
      async (sessionId, content) => {
        const item: TuiQueuedMessage = {
          itemId: "queue-guidance",
          sessionId,
          status: "queued",
          source: "api",
          content,
        };
        queuedItems.push(item);
        return {
          itemId: item.itemId,
          status: item.status,
          position: queuedItems.length,
        };
      },
    );
    vi.mocked(runtime.listQueuedMessages).mockImplementation(async () => [
      ...queuedItems,
    ]);
    vi.mocked(runtime.deleteQueuedMessage).mockImplementation(
      async (_sessionId, itemId) => {
        const index = queuedItems.findIndex((item) => item.itemId === itemId);
        return index >= 0 ? queuedItems.splice(index, 1)[0] : undefined;
      },
    );
    vi.mocked(runtime.getActiveRun).mockImplementation(async (sessionId) => ({
      schemaVersion: 1,
      sessionId,
      state: "running",
      turnId: "turn-active",
      actions: { steer: true },
    }));
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const submission = app.submit("Inspect the failure");
    try {
      await vi.waitFor(() =>
        expect(app.tui.render(80).join("\n")).toContain("Running"),
      );
      terminal.input?.("Use the preview branch directly");
      terminal.input?.("\x1b\r");
      await vi.waitFor(() =>
        expect(app.tui.render(80).join("\n")).toContain(
          "Use the preview branch directly",
        ),
      );
      await vi.waitFor(() =>
        expect(runtime.listQueuedMessages).toHaveBeenCalledWith("session-1"),
      );
      expect(app.editor.getText()).toBe("");

      terminal.input?.("\x1b[1;3A");

      await vi.waitFor(() =>
        expect(app.editor.getText()).toBe("Use the preview branch directly"),
      );
      expect(runtime.deleteQueuedMessage).toHaveBeenCalledWith(
        "session-1",
        "queue-guidance",
      );
      expect(runtime.steerQueuedMessage).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(app.tui.render(80).join("\n")).not.toContain("Queued ·"),
      );
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(runtime.steer).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: "session-1",
            message: { content: "Use the preview branch directly" },
            requestedTurnId: "turn-active",
          }),
        ),
      );
      expect(app.editor.getText()).toBe("");
    } finally {
      finishTurn?.();
      await submission;
      await app.stop();
    }
  });

  it("renders /context from the Runtime-owned persisted context usage", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getContextSnapshot).mockResolvedValue({
      status: "live",
      model: { provider: "minimax", id: "MiniMax-M3", contextWindow: 10_000 },
      contextUsage: {
        contextWindowTokens: 10_000,
        usedTokens: 3_000,
        totalCountSource: "PROVIDER_USAGE_ANCHORED",
        components: [
          { kind: "SYSTEM_PROMPT", tokens: 1_000 },
          { kind: "MEMORY", tokens: 0 },
          { kind: "TOOLS", tokens: 0 },
          { kind: "SKILLS", tokens: 0 },
          { kind: "MESSAGES", tokens: 2_000 },
          { kind: "OTHER", tokens: 0 },
        ],
      },
    });
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.submit("Create session");
    const transcriptBeforeContext = app.transcript.snapshot();
    await app.submit("/context");

    expect(app.transcript.snapshot()).toEqual(transcriptBeforeContext);
    expect(app.interaction.current()).toBeDefined();
    const rendered = app.tui.render(80).join("\n");
    expect(rendered).toContain("Context");
    expect(rendered).toContain("3k/10k tokens (30% used)");
    expect(rendered).toContain("Usage by category");
    expect(rendered).toContain("Messages");
    expect(rendered).toMatch(/[⛁⛀⛶]/u);

    app.interaction.current()?.handleInput?.("\x1b");
    expect(app.interaction.current()).toBeUndefined();
    expect(app.transcript.snapshot()).toEqual(transcriptBeforeContext);
  });

  it("routes /init through the Runtime-owned init Skill and the normal Agent turn", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSkills).mockResolvedValue({
      skills: [
        {
          name: "init",
          displayName: "Init",
          description: "Analyze the codebase and generate AGENTS.md",
          enabled: true,
          sourceKind: "builtin",
        },
      ],
      hasMore: false,
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await vi.waitFor(() => expect(runtime.listSkills).toHaveBeenCalled());
    await app.submit("/init");

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1", content: "/init" }),
      expect.any(AbortSignal),
    );
  });

  it("forwards literal slash-prefixed prompts without invoking local commands", async () => {
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    const prompts = [
      "/commands",
      "/diff",
      "/tool",
      "/tools",
      "/resumex",
      "/renamex Renamed by a typo",
      "/clearx",
      "/tmp/sample-photo.JPG 用 read 工具直接读这个图片，告诉我是什么",
      "/not-a-command explain what this text means",
      "/context  这样还是会显示上下文信息",
    ];

    try {
      app.start();
      await app.ready;
      for (const prompt of prompts) {
        await app.submit(prompt);
        expect(runtime.sendMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({ id: "session-1", content: prompt }),
          expect.any(AbortSignal),
        );
        expect(app.interaction.current()).toBeUndefined();
        expect(app.tui.hasOverlay()).toBe(false);
      }
      expect(runtime.sendMessage).toHaveBeenCalledTimes(prompts.length);
      expect(runtime.renameSession).not.toHaveBeenCalled();
      // Context metrics refresh independently; the overlay assertions above verify no local command ran.
      expect(app.transcript.snapshot()).not.toContainEqual(
        expect.objectContaining({ content: "Unknown command. Use /help." }),
      );
    } finally {
      await app.stop();
    }
  });

  it("keeps contextual commands local and submits other legacy names as prompts", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.submit("/queue");
    expect(runtime.listQueuedMessages).not.toHaveBeenCalled();
    expect(app.transcript.snapshot()).toEqual([]);
    expect(app.tui.render(80).join("\n")).toContain(
      "No messages are waiting and no response is currently running.",
    );

    await app.submit("/queue-clear");
    expect(runtime.deleteQueuedMessage).not.toHaveBeenCalled();

    await app.submit("/send-now do this first");
    await app.submit("/retry");
    expect(
      vi
        .mocked(runtime.sendMessage)
        .mock.calls.map(([request]) => request.content),
    ).toEqual(["/queue-clear", "/send-now do this first"]);
    expect(app.tui.render(80).join("\n")).toContain(
      "There is no failed response to retry in this Session.",
    );
  });

  it("resends the failed user submission through /retry instead of sending the command as text", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let attempt = 0;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        attempt += 1;
        if (attempt === 1) {
          yield { type: "error", message: "terminated" };
          return;
        }
        yield { type: "delta", content: "Recovered response" };
        yield { type: "done" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.submit("Explain this failure");

    expect(app.tui.render(100).join("\n")).toContain(
      "The model connection ended before the response was completed.",
    );
    expect(app.tui.render(100).join("\n")).toContain(
      "Run /retry to resend your last message.",
    );

    await app.submit("/retry");

    expect(
      vi
        .mocked(runtime.sendMessage)
        .mock.calls.map(([request]) => request.content),
    ).toEqual(["Explain this failure", "Explain this failure"]);
    expect(
      vi
        .mocked(runtime.sendMessage)
        .mock.calls.some(([request]) => request.content === "/retry"),
    ).toBe(false);
    expect(app.transcript.snapshot()).toContainEqual(
      expect.objectContaining({
        kind: "assistant",
        content: "Recovered response",
      }),
    );
    await app.stop();
  });

  it("uses Runtime retry-continuation when a terminal failure has no local submission snapshot", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const restoredSession = {
      sessionId: "session-1",
      title: "Restored session",
      workspaceDir: "/workspace",
      status: "error",
      errorMessage: "terminated",
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([restoredSession]);
    vi.mocked(runtime.getSession).mockResolvedValue(restoredSession);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/resume session-1");
    expect(app.tui.render(100).join("\n")).toContain(
      "The model connection ended before the response was completed.",
    );

    await app.submit("/retry");

    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "session-1",
        content: "",
        clientIntent: "retry-continuation",
      }),
      expect.any(AbortSignal),
    );
    await app.stop();
  });

  it("reports service authentication failures without assuming the user needs to sign in", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        yield { type: "error", message: "authentication failed" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.submit("Use the protected model");
    expect(app.tui.render(100).join("\n")).toContain(
      "The service rejected request authentication.",
    );
    expect(app.tui.render(100).join("\n")).not.toContain("Run /login");
    expect(app.tui.render(100).join("\n")).not.toContain("Run /retry");

    await app.submit("/retry");
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    await app.stop();
  });

  it("cycles the shared permission mode with Alt+M without repeating the shortcut", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    expect(app.tui.render(80).join("\n")).toContain("Auto");
    expect(app.tui.render(80).join("\n")).not.toContain("Shift+Tab");
    expect(app.tui.render(80).join("\n")).not.toContain(
      "Shift+Tab switch mode",
    );

    terminal.input?.("\x1bm");

    await vi.waitFor(() => {
      expect(runtime.setPermissionMode).toHaveBeenCalledWith(
        "bypassPermissions",
      );
      const rendered = app.tui.render(80).join("\n");
      expect(rendered).toContain("Full access");
      expect(rendered).not.toContain("Shift+Tab");
      expect(rendered.match(/Full access/g)).toHaveLength(1);
      expect(rendered).not.toContain("Desktop permissions:");
    });
    await app.stop();
  });

  it("projects Token Plan warnings into the status rail", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.getAccountStatus).mockResolvedValue({
      status: "ready",
      defaultModel: "minimax/MiniMax-M2.7",
      providerId: "minimax",
      modelId: "MiniMax-M2.7",
      authMode: "managed-login",
      managedTokenPresent: true,
      modelSource: "token-plan",
      tokenPlanQuotaState: "available",
      tokenPlanQuota: {
        fiveHour: { remainingPercent: 30, unlimited: false },
        weekly: { remainingPercent: 64, unlimited: false },
      },
      warnings: [],
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("Measure this turn");

    await vi.waitFor(() => {
      const rendered = app.tui.render(120).join("\n");
      expect(rendered).toContain("5h 30%");
      expect(rendered).not.toContain("Week 64%");
    });
    await app.stop();
  });

  it("keeps Token Plan subscription state out of the status rail when no quota exists", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.getAccountStatus).mockResolvedValue({
      status: "ready",
      defaultModel: "minimax/MiniMax-M3",
      providerId: "minimax",
      modelId: "MiniMax-M3",
      authMode: "managed-login",
      managedTokenPresent: true,
      modelSource: "token-plan",
      tokenPlanQuotaState: "not-subscribed",
      warnings: [],
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("Measure this turn");

    await vi.waitFor(() => {
      const rendered = app.tui.render(120).join("\n");
      expect(rendered).toContain("✦ MiniMax M2.7");
      expect(rendered).not.toMatch(/Context 5%|Quota|Plan|5h|Week/u);
    });
    await app.stop();
  });

  it("keeps the current permission mode when an Alt+M update fails", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.setPermissionMode).mockRejectedValueOnce(
      new Error("config is read-only"),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("\x1bm");

    await vi.waitFor(() => {
      expect(app.tui.render(80).join("\n")).toContain("Auto");
      expect(app.tui.render(80).join("\n")).not.toContain("FULL");
      expect(app.transcript.snapshot().at(-1)).toMatchObject({
        kind: "warning",
        content:
          "Permission mode was not changed: config is read-only. Retry /permission or Alt+M.",
      });
    });
    await app.stop();
  });

  it("arms Plan with Shift+Tab and sends the one-shot Runtime intent", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("\x1b[Z");
    expect(app.tui.render(100).join("\n")).toContain("PLAN next");
    expect(app.tui.render(100).join("\n")).toContain(
      "Plan Mode · next message enters Plan",
    );

    terminal.input?.("计");
    expect(app.tui.render(100).join("\n")).toContain(
      "Plan Mode · next message enters Plan",
    );
    expect(app.tui.render(32).join("\n")).toContain("Plan Mode");
    terminal.input?.("\x7f");
    expect(app.editor.getText()).toBe("");
    expect(app.tui.render(100).join("\n")).toContain(
      "Plan Mode · next message enters Plan",
    );
    terminal.input?.("计");
    terminal.input?.("划");
    expect(app.editor.getText()).toBe("计划");
    expect(app.tui.render(100).join("\n")).toContain("PLAN next");
    expect(app.tui.render(100).join("\n")).toContain(
      "Plan Mode · next message enters Plan",
    );

    terminal.input?.("\r");
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledOnce());
    await app.controller.whenIdle();

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "计划",
        clientIntent: "plan-entry",
      }),
      expect.any(AbortSignal),
    );
    expect(app.tui.render(100).join("\n")).toContain("PLAN");
    expect(app.tui.render(100).join("\n")).toContain("Auto");
    await app.stop();
  });

  it("keeps ordinary messages in Plan and exits only with an explicit one-shot intent", async () => {
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/plan on");
    await app.submit("Draft the implementation plan");
    await app.submit("Refine the verification section");

    expect(runtime.sendMessage).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ clientIntent: expect.anything() }),
      expect.any(AbortSignal),
    );
    expect(app.tui.render(100).join("\n")).toContain(
      "/workspace │ PLAN │ Auto",
    );

    await app.submit("/plan off");
    await app.submit("Implement the approved direction");

    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientIntent: "plan-exit" }),
      expect.any(AbortSignal),
    );
    expect(app.tui.render(100).join("\n")).not.toContain("PLAN");
    await app.stop();
  });

  it("keeps the one-shot Plan intent armed when direct admission rejects it", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementationOnce(
      async function* rejectedAdmission() {
        yield* [] as TuiStreamEvent[];
        throw Object.assign(new Error("Plan entry is disabled"), {
          code: "local_plan_entry_disabled",
        });
      },
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/plan on");
    await app.submit("Plan this after the feature is enabled");

    expect(app.tui.render(100).join("\n")).toContain("PLAN next");
    await app.submit("Retry the same Plan intent");
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientIntent: "plan-entry" }),
      expect.any(AbortSignal),
    );
    await app.stop();
  });

  it("settles a Plan transition from authoritative Session metadata when the stream is empty", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementationOnce(
      async function* emptyAcceptedStream() {
        yield* [] as TuiStreamEvent[];
      },
    );
    vi.mocked(runtime.getSession).mockResolvedValue({
      sessionId: "session-1",
      workspace: "/workspace",
      interactionMode: "plan",
    });
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/plan on");
    await app.submit("Plan without emitting a stream event");

    expect(runtime.getSession).toHaveBeenCalledWith("session-1");
    expect(app.tui.render(100).join("\n")).toContain(
      "/workspace │ PLAN │ Auto",
    );
    expect(app.tui.render(100).join("\n")).not.toContain("PLAN next");
    await app.stop();
  });

  it("clears accepted Plan entry while authoritative metadata refresh is unavailable", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getSession).mockRejectedValue(
      new Error("metadata temporarily unavailable"),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/plan on");
    await app.submit("OK");

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "OK", clientIntent: "plan-entry" }),
      expect.any(AbortSignal),
    );
    expect(app.tui.render(100).join("\n")).not.toContain("/workspace │ PLAN");
    expect(app.tui.render(100).join("\n")).not.toContain("DEFAULT next");
    await app.stop();
  });

  it("preserves Plan intent through direct busy fallback into the Runtime Queue", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.listModels).mockResolvedValue([
      {
        providerId: "minimax",
        modelId: "MiniMax-M2.7",
        selected: true,
        variant: "",
      },
    ]);
    vi.mocked(runtime.sendMessage).mockImplementationOnce(
      async function* busyAdmission() {
        yield* [] as TuiStreamEvent[];
        throw Object.assign(new Error("Session is busy"), {
          code: "local_session_busy",
        });
      },
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/plan on");
    await app.submit("Queue this Plan request");

    expect(runtime.enqueueMessage).toHaveBeenCalledWith(
      "session-1",
      "Queue this Plan request",
      {
        attachments: [],
        clientIntent: "plan-entry",
        model: { providerId: "minimax", modelId: "MiniMax-M2.7", variant: "" },
      },
    );
    expect(app.tui.render(100).join("\n")).not.toContain("PLAN queued");
    await app.stop();
  });

  it("binds a one-shot Plan intent to only the first concurrent submission", async () => {
    let releaseFirstEvent: (() => void) | undefined;
    const firstEventGate = new Promise<void>((resolve) => {
      releaseFirstEvent = resolve;
    });
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* delayedAdmission() {
        await firstEventGate;
        yield { type: "delta", content: "Planning" };
        yield { type: "done" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/plan on");
    const first = app.submit("Plan the implementation");
    await vi.waitFor(() =>
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1),
    );

    await app.submit("Queue a follow-up while admission is quiet");

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ clientIntent: "plan-entry" }),
      expect.any(AbortSignal),
    );
    expect(runtime.enqueueMessage).toHaveBeenCalledWith(
      "session-1",
      "Queue a follow-up while admission is quiet",
      {
        attachments: [],
        model: { providerId: "minimax", modelId: "MiniMax-M2.7" },
      },
    );

    releaseFirstEvent?.();
    await first;
    await app.stop();
  });

  it("shows the Desktop-aligned confirmation when the Agent calls EnterPlanMode", async () => {
    let emitEvent: ((event: TuiRuntimeEvent) => void) | undefined;
    const runtime = createRuntime();
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        const event = await new Promise<TuiRuntimeEvent | undefined>(
          (resolve) => {
            emitEvent = resolve;
            signal.addEventListener("abort", () => resolve(undefined), {
              once: true,
            });
          },
        );
        if (event) yield event;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
      },
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("Plan a complex change");
    await vi.waitFor(() => expect(emitEvent).toBeTypeOf("function"));
    const askEvent = runtimeEvent({
      type: "questionnaire.ask",
      timestamp: Date.now(),
      source: "runtime",
      payload: {
        sessionId: "session-1",
        agentName: "mavis",
        request: planEntryEventRequest("plan-entry-agent-tool"),
      },
    });
    expect(askEvent).toMatchObject({
      type: "questionnaire.ask",
      sessionId: "session-1",
      request: { id: "plan-entry-agent-tool", mode: "plan" },
    });
    emitEvent?.(askEvent);

    await vi.waitFor(() => expect(app.interaction.isActive()).toBe(true));
    const panel = app.interaction.current();
    const rendered = panel?.render?.(100).join("\n") ?? "";
    expect(rendered).toContain("Use Plan mode?");
    expect(rendered).toContain(
      "Plan mode structures complex tasks before execution.",
    );
    expect(rendered).toContain("Continue with plan");
    expect(rendered).toContain("Deny");

    panel?.handleInput?.("\r");
    await vi.waitFor(() =>
      expect(runtime.replyQuestionnaire).toHaveBeenCalledWith(
        "mavis",
        "plan-entry-agent-tool",
        [
          {
            stepId: "plan-enter",
            selectedOptionIds: ["confirm"],
            selectedOther: false,
          },
        ],
      ),
    );
    await app.stop();
  });

  it("keeps a pending Plan exit armed when steer guides the current Plan Turn", async () => {
    let finishTurn: (() => void) | undefined;
    let interactionMode: "plan" | undefined;
    const runtime = createRuntime();
    vi.mocked(runtime.getSession).mockImplementation(async () => ({
      sessionId: "session-1",
      workspace: "/workspace",
      ...(interactionMode ? { interactionMode } : {}),
    }));
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* activePlanTurn() {
        interactionMode = "plan";
        yield { type: "delta", content: "Drafting the plan" };
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.getActiveRun).mockImplementation(async (sessionId) => ({
      schemaVersion: 1,
      sessionId,
      state: "running",
      turnId: "turn-plan",
      actions: { steer: true },
    }));
    vi.mocked(runtime.steer).mockResolvedValue({
      turnId: "turn-plan",
      mode: "steered",
    });
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/plan on");
    const planTurn = app.submit("Draft a plan");
    await vi.waitFor(() =>
      expect(app.tui.render(100).join("\n")).toContain(
        "/workspace │ PLAN │ Auto",
      ),
    );
    await app.submit("/plan off");

    await app.submit("/steer include rollback checks");

    expect(runtime.steer).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        message: { content: "include rollback checks" },
      }),
    );
    expect(app.tui.render(100).join("\n")).toContain("DEFAULT next");

    finishTurn?.();
    await planTurn;
    await app.stop();
  });

  it("does not arm a mode transition while a Plan Review is pending", async () => {
    let emitEvent: ((event: TuiRuntimeEvent) => void) | undefined;
    const runtime = createRuntime();
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        const event = await new Promise<TuiRuntimeEvent | undefined>(
          (resolve) => {
            emitEvent = resolve;
            signal.addEventListener("abort", () => resolve(undefined), {
              once: true,
            });
          },
        );
        if (event) yield event;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
      },
    );
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/plan on");
    await app.submit("Draft a plan");
    await vi.waitFor(() => expect(emitEvent).toBeTypeOf("function"));
    emitEvent?.(
      runtimeEvent({
        type: "questionnaire.ask",
        timestamp: Date.now(),
        source: "runtime",
        payload: {
          sessionId: "session-1",
          agentName: "mavis",
          request: planReviewEventRequest("plan-review-mode-guard"),
        },
      }),
    );
    await vi.waitFor(() => expect(app.interaction.isActive()).toBe(true));
    // The compact panel owns the decision; the frozen plan is projected to the Transcript.
    expect(app.interaction.current()?.render?.(100).join("\n")).toContain(
      "Plan complete. What would you like to do?",
    );
    expect(app.tui.render(100).join("\n")).toContain("Frozen plan");

    terminal.input?.("\x1b[Z");

    expect(app.interaction.isActive()).toBe(true);
    expect(app.tui.render(100).join("\n")).toContain(
      "/workspace │ PLAN │ Auto",
    );
    expect(app.tui.render(100).join("\n")).not.toContain("DEFAULT next");

    await app.submit("/plan off");

    expect(app.interaction.isActive()).toBe(true);
    expect(app.tui.render(100).join("\n")).toContain(
      "/workspace │ PLAN │ Auto",
    );
    expect(app.tui.render(100).join("\n")).not.toContain("DEFAULT next");
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    await app.submit("/steer bypass the review");

    expect(app.interaction.isActive()).toBe(true);
    expect(runtime.steer).not.toHaveBeenCalled();

    app.interaction.current()?.handleInput?.("\u001b");
    await vi.waitFor(() =>
      expect(runtime.replyQuestionnaire).toHaveBeenCalledWith(
        "mavis",
        "plan-review-mode-guard",
        [expect.objectContaining({ skipped: true })],
      ),
    );
    await vi.waitFor(() => expect(app.interaction.isActive()).toBe(false));
    expect(app.tui.render(100).join("\n")).toContain(
      "/workspace │ PLAN │ Auto",
    );
    await app.stop();
  });

  it("streams Plan feedback and replaces it with the revised Plan Review", async () => {
    let emitReview: ((event: TuiRuntimeEvent) => void) | undefined;
    let releaseContinuation: (() => void) | undefined;
    let finishReply: ((value: boolean) => void) | undefined;
    const runtime = createRuntime();
    vi.mocked(runtime.replyQuestionnaire).mockImplementation(
      async () =>
        await new Promise<boolean>((resolve) => {
          finishReply = resolve;
        }),
    );
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        const review = await new Promise<TuiRuntimeEvent | undefined>(
          (resolve) => {
            emitReview = resolve;
            signal.addEventListener("abort", () => resolve(undefined), {
              once: true,
            });
          },
        );
        if (!review || signal.aborted) return;
        yield review;
        await new Promise<void>((resolve) => {
          releaseContinuation = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
        if (signal.aborted) return;
        const turnId = "turn-runtime-plan-feedback";
        yield runtimeEvent({
          type: "session.start",
          timestamp: Date.now(),
          source: "runtime",
          payload: { sessionId: "session-1", turnId },
        });
        vi.mocked(runtime.getMessages).mockResolvedValue([
          {
            id: "assistant-revised-plan",
            role: "assistant",
            content: "I revised the plan with rollback coverage.",
          },
        ]);
        yield runtimeEvent({
          type: "questionnaire.ask",
          timestamp: Date.now(),
          source: "runtime",
          payload: {
            sessionId: "session-1",
            agentName: "mavis",
            request: {
              ...planReviewEventRequest("plan-review-feedback-revised"),
              modePayload: {
                planReview: {
                  markdown:
                    "# Revised frozen plan\n\nIncludes rollback coverage.",
                  path: "/history/session-1/artifacts/plan.md",
                },
              },
            },
          },
        });
        yield runtimeEvent({
          type: "session.finish",
          timestamp: Date.now(),
          source: "runtime",
          payload: { sessionId: "session-1", turnId },
        });
        finishReply?.(true);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
      },
    );
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/plan on");
    await app.submit("Draft a plan");
    await vi.waitFor(() => expect(emitReview).toBeTypeOf("function"));
    emitReview?.(
      runtimeEvent({
        type: "questionnaire.ask",
        timestamp: Date.now(),
        source: "runtime",
        payload: {
          sessionId: "session-1",
          agentName: "mavis",
          request: planReviewEventRequest("plan-review-feedback-live"),
        },
      }),
    );
    await vi.waitFor(() => expect(app.interaction.isActive()).toBe(true));

    terminal.input?.("\u001b[B");
    terminal.input?.("\u001b[B");
    terminal.input?.("\r");
    for (const character of "Add rollback coverage")
      terminal.input?.(character);
    terminal.input?.("\r");
    await vi.waitFor(() => expect(finishReply).toBeTypeOf("function"));
    releaseContinuation?.();

    await vi.waitFor(() =>
      expect(
        app.transcript
          .snapshot()
          .map((cell) => cell.content)
          .join("\n"),
      ).toContain("I revised the plan with rollback coverage."),
    );
    expect(runtime.watchSessionTurn).toHaveBeenCalledWith(
      "session-1",
      "turn-runtime-plan-feedback",
      expect.any(AbortSignal),
    );
    await vi.waitFor(() => expect(app.interaction.isActive()).toBe(true));
    // The revised plan is projected to the Transcript; the panel stays the compact decision.
    expect(app.interaction.current()?.render?.(100).join("\n")).toContain(
      "Plan complete. What would you like to do?",
    );
    expect(app.tui.render(100).join("\n")).toContain("Revised frozen plan");
    expect(app.tui.render(100).join("\n")).not.toContain(
      "Message · Enter send",
    );
    await app.stop();
  });

  it("supports explicit /plan and /permission mode commands", async () => {
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/plan on");
    expect(app.tui.render(100).join("\n")).toContain("PLAN next");

    await app.submit("/permission full");
    expect(runtime.setPermissionMode).toHaveBeenCalledWith("bypassPermissions");
    expect(app.tui.render(100).join("\n")).toContain("Full access");
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    await app.submit("Plan with Full access");
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ clientIntent: "plan-entry" }),
      expect.any(AbortSignal),
    );
    expect(app.tui.render(100).join("\n")).toContain("PLAN");
    expect(app.tui.render(100).join("\n")).toContain("Full access");
    await app.stop();
  });

  it("opens a permission mode selector for bare /permission", async () => {
    const runtime = createRuntime();
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/permission");

    expect(app.interaction.isActive()).toBe(true);
    const rendered = app.interaction.current()?.render?.(100).join("\n") ?? "";
    expect(rendered).toContain("╭─ Permission");
    expect(rendered).toContain("Current · Auto");
    expect(rendered).toContain("ASK");
    expect(rendered).toContain("› AUTO");
    expect(rendered).toContain("FULL");
    expect(runtime.setPermissionMode).not.toHaveBeenCalled();

    terminal.input?.("\u001b[B");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.setPermissionMode).toHaveBeenCalledWith(
        "bypassPermissions",
      ),
    );
    expect(app.interaction.isActive()).toBe(false);
    expect(app.tui.render(100).join("\n")).toContain("Full access");

    await app.submit("/permission status");
    expect(app.interaction.isActive()).toBe(false);
    expect(
      app.transcript
        .snapshot()
        .map((cell) => cell.content)
        .join("\n"),
    ).toContain("Permission mode: Full access.");
    await app.stop();
  });

  it("opens the latest settled Plan as a read-only full snapshot", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getLatestPlanReview).mockResolvedValue(
      planReviewEventRequest("plan-review-settled"),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.openSession("session-1");
    await app.submit("/plan view");

    expect(runtime.getLatestPlanReview).toHaveBeenCalledWith(
      "mavis",
      "session-1",
    );
    const rendered = app.interaction.current()?.render?.(100).join("\n") ?? "";
    expect(rendered).toContain("Frozen plan");
    expect(rendered).toContain("/history/session-1/artifacts/plan.md");
    expect(rendered).not.toContain("Agree and start implementation");

    app.interaction.current()?.handleInput?.("\u001b");
    expect(app.interaction.isActive()).toBe(false);
    await app.stop();
  });

  it("does not open a settled Plan after the active Session changes", async () => {
    let resolveReview:
      | ((request: TuiQuestionnaireRequest | undefined) => void)
      | undefined;
    const runtime = createRuntime();
    vi.mocked(runtime.getLatestPlanReview).mockImplementation(
      async () =>
        await new Promise<TuiQuestionnaireRequest | undefined>((resolve) => {
          resolveReview = resolve;
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.openSession("session-1");
    const viewing = app.submit("/plan view");
    await vi.waitFor(() => expect(resolveReview).toBeTypeOf("function"));
    await app.openSession("session-2");
    resolveReview?.(planReviewEventRequest("stale-plan-review"));
    await viewing;

    expect(app.interaction.isActive()).toBe(false);
    expect(app.tui.render(100).join("\n")).not.toContain("Frozen plan");
    await app.stop();
  });

  it("blocks Plan entry but still allows Plan exit when the Runtime capability is disabled", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getPlanModeCapabilities).mockResolvedValue({
      entryEnabled: false,
    });
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.openSession("session-1");
    terminal.input?.("\x1b[Z");
    await app.submit("/plan on");
    expect(app.tui.render(100).join("\n")).not.toContain("PLAN next");
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    vi.mocked(runtime.getSession).mockResolvedValue({
      sessionId: "session-1",
      workspace: "/workspace",
      interactionMode: "plan",
    });
    await app.controller.refreshSessionMetadata("session-1");
    terminal.input?.("\x1b[Z");
    expect(app.tui.render(100).join("\n")).toContain("DEFAULT next");
    await app.stop();
  });

  it("fails closed when the Runtime Plan capability cannot be loaded", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getPlanModeCapabilities).mockRejectedValue(
      new Error("Runtime unavailable"),
    );
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("\x1b[Z");
    await app.submit("/plan on");

    expect(app.tui.render(100).join("\n")).not.toContain("PLAN next");
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    await app.stop();
  });

  it("submits the hidden Runtime engineering log command name as an ordinary prompt", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      runtimeLogDirectory: "/home/dev/.minimax/v2/observability/logs",
    });

    await app.submit("/logs");

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1", content: "/logs" }),
      expect.any(AbortSignal),
    );
  });

  it("exposes sanitized checks and submits the hidden /config name as ordinary text", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listPendingPermissions).mockResolvedValue([
      {
        requestId: "permission-1",
        sessionId: "session-1",
        toolName: "bash",
        toolDescription: "Run tests",
      },
    ]);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    await app.submit("/doctor");
    const doctorOutput = app.transcript.snapshot().at(-1)?.content ?? "";
    expect(app.interaction.current()).toBeUndefined();
    await app.submit("/config");
    expect(app.interaction.current()).toBeUndefined();
    await app.submit("/skills docs");
    const skillsPanel = app.interaction.current();
    const skillsOutput = skillsPanel?.render(80).join("\n") ?? "";
    expect(app.tui.render(80).join("\n")).not.toContain("Message · Enter");
    skillsPanel?.handleInput?.("\x1b");
    await app.submit("/mcp browser");
    const mcpPanel = app.interaction.current();
    const mcpOutput = mcpPanel?.render(80).join("\n") ?? "";
    expect(app.tui.render(80).join("\n")).not.toContain("Message · Enter");
    mcpPanel?.handleInput?.("\x1b");
    await app.submit("/permissions");

    const output = app.transcript
      .snapshot()
      .map((cell) => cell.content)
      .join("\n");
    expect(runtime.getRuntimeDiagnostics).toHaveBeenCalledTimes(1);
    expect(runtime.listSkills).toHaveBeenCalledWith("mavis", "docs");
    expect(runtime.listMcpServers).toHaveBeenCalledWith("browser", "session-1");
    expect(runtime.listPendingPermissions).toHaveBeenCalled();
    expect(doctorOutput).toContain("Configuration check");
    expect(doctorOutput).toContain("Status: Valid");
    expect(doctorOutput).not.toContain("/doctor");
    expect(output).toContain("Configuration check");
    expect(output).not.toContain("Effective configuration");
    expect(skillsOutput).toContain("Skills");
    expect(skillsOutput).toContain("Built-in · 1");
    expect(skillsOutput).toContain("Docs");
    expect(skillsOutput).toContain("● available · builtin");
    expect(mcpOutput).toContain("MCP servers");
    expect(mcpOutput).toContain("browser");
    expect(mcpOutput).toContain("◆ configured · stdio");
    expect(output).toContain("bash · Run tests");
    expect(output).not.toContain("TOKEN");
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1", content: "/config" }),
      expect.any(AbortSignal),
    );
  });

  it("previews /feedback without uploading until Enter confirms the Runtime draft", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 30;
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("/feedback Upload failed token=****");

    expect(runtime.prepareFeedback).toHaveBeenCalledWith({
      description: "Upload failed token=****",
    });
    expect(runtime.submitFeedback).not.toHaveBeenCalled();
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);
    const panel = app.interaction.current();
    expect(panel?.render(80).join("\n")).toContain("Review feedback");
    panel?.handleInput?.("d");
    expect(panel?.render(80).join("\n")).toContain("Client  mcode 0.1.0");

    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.submitFeedback).toHaveBeenCalledWith(
        "feedback-draft-1",
        expect.objectContaining({ onPhase: expect.any(Function) }),
      ),
    );
    expect(panel?.render(80).join("\n")).toContain("ticket-1");
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    terminal.input?.("\x1b");
    expect(app.interaction.isActive()).toBe(false);
    await app.stop();
  });

  it("cancels /feedback without uploading and keeps missing descriptions out of the Agent", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;

    await app.submit("/feedback");
    expect(app.transcript.snapshot().at(-1)).toMatchObject({
      kind: "final-summary",
      content: "Usage: /feedback <message>",
    });
    expect(runtime.prepareFeedback).not.toHaveBeenCalled();

    await app.submit("/feedback Cancel this report");
    terminal.input?.("\x1b");
    await vi.waitFor(() =>
      expect(runtime.cancelFeedback).toHaveBeenCalledWith("feedback-draft-1"),
    );
    expect(runtime.submitFeedback).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    await app.stop();
  });

  it("keeps the status report local and submits the hidden /config name as text", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 24;
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const transcriptBeforeStatus = app.transcript.snapshot();
    await app.submit("/status");
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);
    expect(app.transcript.snapshot()).toEqual(transcriptBeforeStatus);
    const statusOutput = app.tui.render(80).join("\n");
    expect(statusOutput).toContain("MCode status");
    expect(statusOutput).toContain("Model");
    expect(statusOutput).not.toContain("/status");
    expect(statusOutput).toContain("/workspace");
    expect(statusOutput).toMatch(/Branch:\s+Not a Git repository/u);
    expect(statusOutput).toContain("Not applicable");
    expect(statusOutput).toContain("Session");
    expect(statusOutput).toContain("Permissions");
    expect(statusOutput).toContain("Auto");

    app.interaction.current()?.handleInput?.("\x1b");
    expect(app.interaction.isActive()).toBe(false);
    expect(app.transcript.snapshot()).toEqual(transcriptBeforeStatus);

    await app.submit("/config");
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(false);
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1", content: "/config" }),
      expect.any(AbortSignal),
    );
    expect(runtime.getRuntimeDiagnostics).not.toHaveBeenCalled();

    await app.stop();
  });

  it("commits the first frame immediately when the Pi renderer starts", async () => {
    const terminal = new FakeTerminal();
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    let firstFrameCommitted = false;
    void app.firstFrame.then(() => {
      firstFrameCommitted = true;
    });

    app.start();
    await app.firstFrame;

    expect(terminal.started).toBe(true);
    expect(firstFrameCommitted).toBe(true);
    expect(terminal.writes.join("")).toContain("Tips for getting started");
    await app.stop();
  });

  it("chooses the account region before routing login through the auth application", async () => {
    const runtime = createRuntime();
    const openedTargets: string[] = [];
    const logoutUrl =
      "https://agent.minimax.io/auth/logout?logout_redirect_uri=https%3A%2F%2Fagent.minimax.io";
    let authenticated = false;
    vi.mocked(runtime.getAccountStatus).mockImplementation(async () =>
      authenticated
        ? {
            status: "ready",
            defaultModel: "minimax/MiniMax-M2.7",
            providerId: "minimax",
            modelId: "MiniMax-M2.7",
            authMode: "managed-login",
            managedTokenPresent: true,
            warnings: [],
          }
        : {
            status: "needs-login",
            authMode: "managed-login",
            managedTokenPresent: false,
            warnings: [],
          },
    );
    const auth = {
      login: vi.fn(
        async (
          onProgress?: (progress: McodeAuthProgress) => void,
          _region?: "cn" | "en",
        ) => {
          authenticated = true;
          onProgress?.({
            state: "device-authorization",
            userCode: "ABCD-EFGH",
            verificationUri: "https://account.example.test/device",
            expiresInSec: 300,
          });
          return {
            state: "authenticated" as const,
            message:
              _region === "en"
                ? "Signed in with MiniMax Global. Restart MCode to use this account region."
                : "Signed in with MiniMax.",
          };
        },
      ),
      logout: vi.fn(async () => {
        authenticated = false;
        return {
          state: "signed-out" as const,
          message: "Signed out of MiniMax.",
          logoutUrl,
        };
      }),
    };
    const notifyAuthContextChanged = vi.fn(async () => {
      throw new Error("Hook lifecycle cleanup failed");
    });
    const app = createTuiApp({
      runtime,
      auth,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
      openExternalTarget: async (target) => {
        openedTargets.push(target);
        throw new Error("no desktop session");
      },
      notifyAuthContextChanged,
    });

    app.start();
    await app.ready;
    expect(app.tui.render(80).join("\n")).toContain("Sign in with /login");
    await app.submit("/login");

    expect(auth.login).not.toHaveBeenCalled();
    expect(app.interaction.render(80).join("\n")).toContain("China (CN)");
    expect(app.interaction.render(80).join("\n")).toContain("Global");
    app.interaction.current()?.handleInput("\u001b[B");
    app.interaction.current()?.handleInput("\r");
    await vi.waitFor(() => expect(auth.login).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(app.controller.snapshot().account?.managedTokenPresent).toBe(true),
    );
    expect(app.getSurface()).toBe("conversation");
    expect(app.tui.render(80).join("\n")).not.toContain("Sign in with /login");
    expect(app.tui.render(80).join("\n")).not.toContain("Login required");

    await app.submit("/logout");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().account?.managedTokenPresent).toBe(
        false,
      ),
    );
    expect(app.tui.render(80).join("\n")).toContain("Sign in with /login");

    expect(auth.login).toHaveBeenCalledWith(expect.any(Function), "en");
    expect(openedTargets).toEqual([
      "https://account.example.test/device?client_surface=tui&download_source=mcode-internal",
      logoutUrl,
    ]);
    await vi.waitFor(() =>
      expect(app.transcript.snapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "warning",
            content:
              "Couldn't open the default browser. Open the authorization URL above manually.",
          }),
          expect.objectContaining({
            kind: "warning",
            content:
              "Couldn't open the default browser. Open the sign-out URL above manually.",
          }),
        ]),
      ),
    );

    expect(app.transcript.snapshot().slice(-6)).toMatchObject([
      {
        kind: "final-summary",
        content:
          "Complete MiniMax login in your browser:\nhttps://account.example.test/device?client_surface=tui&download_source=mcode-internal\nCode: ABCD-EFGH",
      },
      {
        kind: "warning",
        content:
          "Couldn't open the default browser. Open the authorization URL above manually.",
      },
      {
        kind: "final-summary",
        content:
          "Signed in with MiniMax Global. Restart MCode to use this account region.",
      },
      {
        kind: "final-summary",
        content: "Signed out of MiniMax.",
      },
      {
        kind: "final-summary",
        content: `Finish signing out in your browser:\n${logoutUrl}`,
      },
      {
        kind: "warning",
        content:
          "Couldn't open the default browser. Open the sign-out URL above manually.",
      },
    ]);
    expect(auth.login).toHaveBeenCalledOnce();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(notifyAuthContextChanged.mock.calls).toEqual([
      ["authenticated"],
      ["logged_out"],
    ]);
    expect(
      app.transcript
        .snapshot()
        .map((cell) => cell.content)
        .join("\n"),
    ).not.toContain("Sign-in wasn't completed");
    expect(
      app.transcript
        .snapshot()
        .map((cell) => cell.content)
        .join("\n"),
    ).not.toContain("Couldn't sign out");
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    await app.stop();
  });

  it("clears Runtime auth context when the shared account is already signed out", async () => {
    const notifyAuthContextChanged = vi.fn(async () => undefined);
    const logoutUrl =
      "https://agent.minimax.cn/auth/logout?logout_redirect_uri=https%3A%2F%2Fagent.minimax.cn";
    const openExternalTarget = vi.fn(() => new Promise<void>(() => {}));
    const app = createTuiApp({
      runtime: createRuntime(),
      auth: {
        login: vi.fn(),
        logout: vi.fn(async () => ({
          state: "already-signed-out" as const,
          message: "Already signed out of MiniMax.",
          logoutUrl,
        })),
      },
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
      notifyAuthContextChanged,
      openExternalTarget,
    });
    app.start();
    await app.ready;

    await app.submit("/logout");

    expect(notifyAuthContextChanged).toHaveBeenCalledOnce();
    expect(notifyAuthContextChanged).toHaveBeenCalledWith("logged_out");
    expect(openExternalTarget).toHaveBeenCalledWith(logoutUrl);
    expect(app.transcript.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: `Finish signing out in your browser:\n${logoutUrl}`,
        }),
      ]),
    );
    await app.stop();
  });

  it("refreshes Runtime auth context when login renews an existing account", async () => {
    const runtime = createRuntime();
    let authenticated = false;
    vi.mocked(runtime.getAccountStatus).mockImplementation(async () =>
      authenticated
        ? {
            status: "ready",
            defaultModel: "minimax/MiniMax-M2.7",
            providerId: "minimax",
            modelId: "MiniMax-M2.7",
            authMode: "managed-login",
            managedTokenPresent: true,
            warnings: [],
          }
        : {
            status: "needs-login",
            authMode: "managed-login",
            managedTokenPresent: false,
            warnings: [],
          },
    );
    const notifyAuthContextChanged = vi.fn(async () => undefined);
    const auth = {
      login: vi.fn(async () => {
        authenticated = true;
        return {
          state: "already-authenticated" as const,
          message: "Already signed in with MiniMax.",
        };
      }),
      logout: vi.fn(async () => ({
        state: "signed-out" as const,
        message: "Signed out of MiniMax.",
      })),
    };
    const app = createTuiApp({
      runtime,
      auth,
      notifyAuthContextChanged,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    expect(app.tui.render(80).join("\n")).toContain("Sign in with /login");
    await app.submit("/login");
    app.interaction.current()?.handleInput("\u001b[B");
    app.interaction.current()?.handleInput("\r");

    await vi.waitFor(() => expect(auth.login).toHaveBeenCalledOnce());
    expect(notifyAuthContextChanged).toHaveBeenCalledOnce();
    expect(notifyAuthContextChanged).toHaveBeenCalledWith("authenticated");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().account?.managedTokenPresent).toBe(true),
    );
    expect(app.getSurface()).toBe("conversation");
    expect(app.tui.render(80).join("\n")).not.toContain("Sign in with /login");
    expect(app.tui.render(80).join("\n")).not.toContain("Login required");
    await app.stop();
  });

  it("exits immediately through /quit without aborting the shared Runtime turn", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const abortSession = vi.spyOn(runtime, "abortSession");
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/quit");
    await app.stopped;

    expect(terminal.stopped).toBe(true);
    expect(abortSession).not.toHaveBeenCalled();
  });

  it("does not restore /quit after reopening the exited Session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mcode-quit-draft-"));
    try {
      const first = createTuiApp({
        runtime: createRuntime(),
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace",
      });
      await first.ready;
      await first.openSession("session-1");
      first.editor.setText("/quit");

      first.editor.handleInput("\r");
      await first.stopped;

      const restored = createTuiApp({
        runtime: createRuntime(),
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace",
      });
      await restored.ready;
      await restored.openSession("session-1");

      expect(restored.editor.getText()).toBe("");
      await restored.stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps warning status details visible until the local panel closes", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 40;
    const runtime = createRuntime();
    vi.mocked(runtime.getAccountStatus).mockResolvedValue({
      status: "warning",
      defaultModel: "minimax/MiniMax-M2.7",
      providerId: "minimax",
      modelId: "MiniMax-M2.7",
      authMode: "managed-login",
      managedTokenPresent: true,
      warnings: ["Desktop login should be refreshed soon."],
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const transcriptBeforeStatus = app.transcript.snapshot();
    await app.submit("/status");
    const rendered = app.tui.render(80).join("\n");

    expect(app.interaction.current()).toBeDefined();
    expect(app.transcript.snapshot()).toEqual(transcriptBeforeStatus);
    expect(rendered).toContain("Needs attention");
    expect(rendered).toContain("Connected with warnings");
    expect(rendered).toContain("Model");
    expect(rendered).toContain("Desktop login should be refreshed");
    expect(rendered).toContain("soon.");

    app.interaction.current()?.handleInput?.("\x1b");
    expect(app.interaction.current()).toBeUndefined();
    expect(app.transcript.snapshot()).toEqual(transcriptBeforeStatus);
    expect(app.tui.render(80).join("\n")).not.toContain(
      "Desktop login should be refreshed",
    );

    await app.stop();
  });

  it("reports doctor failures and submits the hidden /config name as text", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getRuntimeDiagnostics).mockRejectedValue(
      new Error("Diagnostics unavailable"),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.submit("/doctor");
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.transcript.snapshot().at(-1)).toMatchObject({
      kind: "error",
      content:
        "Couldn't load configuration check: Diagnostics unavailable. Retry.",
    });

    await app.submit("/config");
    expect(app.tui.hasOverlay()).toBe(false);
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1", content: "/config" }),
      expect.any(AbortSignal),
    );
    expect(runtime.getRuntimeDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("lets an async Session card replace a local status panel", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let resolveSessionPage:
      | ((page: {
          sessions: Array<{
            sessionId: string;
            title: string;
            workspaceDir: string;
            updatedAt: number;
          }>;
          hasMore: boolean;
        }) => void)
      | undefined;
    vi.mocked(runtime.listSessionPage).mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveSessionPage = resolve;
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    const transcriptBeforeStatus = app.transcript.snapshot();
    const sessionCard = app.submit("/sessions");
    await vi.waitFor(() =>
      expect(runtime.listSessionPage).toHaveBeenCalledOnce(),
    );
    await app.submit("/status");
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);
    expect(app.transcript.snapshot()).toEqual(transcriptBeforeStatus);
    expect(app.tui.render(80).join("\n")).toContain("MCode status");

    resolveSessionPage?.({
      sessions: [
        {
          sessionId: "session-race",
          title: "Session opened after status",
          workspaceDir: "/workspace",
          updatedAt: Date.now(),
        },
      ],
      hasMore: false,
    });
    await sessionCard;
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);

    app.interaction.current()?.handleInput?.("\x03");
    expect(runtime.getSession).not.toHaveBeenCalled();
    expect(app.interaction.isActive()).toBe(false);
    expect(app.tui.hasOverlay()).toBe(false);
    await app.stop();
  });

  it("keeps unsupported standalone MCP inspection concise and recoverable", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.listMcpServers).mockRejectedValue(
      Object.assign(new Error("DesktopService implementation detail"), {
        status: 501,
        code: "NOT_IMPLEMENTED",
      }),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.submit("/mcp");

    expect(app.transcript.snapshot().at(-1)).toMatchObject({
      kind: "warning",
      content:
        "MCP status is not available in this build. Configured MCP tools remain available.",
    });
  });

  it("registers enabled Skills as discoverable slash commands without shadowing built-ins", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSkills).mockResolvedValue({
      skills: [
        {
          name: "docs",
          displayName: "Docs",
          description: "Read project docs",
          enabled: true,
          sourceKind: "builtin",
        },
        {
          name: "disabled-skill",
          enabled: false,
        },
        {
          name: "help",
          enabled: true,
        },
        ...Array.from({ length: 14 }, (_, index) => ({
          name: `skill-${index}`,
          description: `Generated skill ${index}`,
          enabled: true,
        })),
      ],
      hasMore: false,
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;

    app.editor.setText("/docs summarize this repository");
    expect(stripAnsi(app.tui.render(80).join("\n"))).toContain(
      "Skill · instructions · Enter invoke",
    );
    app.editor.setText("/context");
    expect(stripAnsi(app.tui.render(80).join("\n"))).toContain(
      "Command · Enter run",
    );
    app.editor.setText("/context explain this repository");
    expect(stripAnsi(app.tui.render(80).join("\n"))).toContain(
      "Prompt · Enter send",
    );
    app.editor.setText("/stop");
    expect(stripAnsi(app.tui.render(80).join("\n"))).toContain(
      "Command · Enter run",
    );
    app.editor.setText("/config");
    expect(stripAnsi(app.tui.render(80).join("\n"))).toContain(
      "Prompt · Enter send",
    );
    app.editor.setText("");

    await app.submit("/help");
    expect(app.transcript.snapshot()).toEqual([]);
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);

    for (const character of "docs") terminal.input?.(character);
    terminal.input?.("\r");
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(false);
    expect(app.editor.getText()).toBe("");

    await app.submit("/docs summarize this repository");
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        content: "/docs summarize this repository",
      }),
      expect.any(AbortSignal),
    );

    vi.mocked(runtime.sendMessage).mockClear();
    await app.submit("/disabled-skill");
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1", content: "/disabled-skill" }),
      expect.any(AbortSignal),
    );
    await app.stop();
  });

  it("deduplicates configured Skills case-insensitively and reserves built-in names", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSkills).mockResolvedValue({
      skills: [
        {
          name: "HELP",
          description: "A Skill that must not shadow /help",
          enabled: true,
        },
        {
          name: "Docs",
          description: "Read project docs",
          enabled: true,
        },
        {
          name: "docs",
          description: "Duplicate project docs command",
          enabled: true,
        },
      ],
      hasMore: false,
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/help");
    const helpPanel = app.interaction.current();
    expect(helpPanel).toBeDefined();
    helpPanel?.handleInput?.("\x1b");
    await app.submit("/help [arguments]");
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        content: "/help [arguments]",
      }),
      expect.any(AbortSignal),
    );
    vi.mocked(runtime.sendMessage).mockClear();
    await app.submit("/docs explain this repository");
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        content: "/docs explain this repository",
      }),
      expect.any(AbortSignal),
    );

    await app.stop();
  });

  it.each(["/theme", "/settings", "history search"])("restores the complete chat viewport after closing %s", async (entry) => {
    const terminal = new VirtualTerminal(80, 24);
    const app = createTuiApp({ runtime: createRuntime(), terminal, version: "0.2.0", workspaceDir: "/workspace" });
    app.start();
    try {
      await app.ready;
      for (let index = 0; index < 12; index++) await app.submit(`Message ${index}`);
      if (entry === "history search") {
        for (let index = 0; index < 12; index++) app.editor.addToHistory(`Message ${index}`);
        terminal.sendInput("\x12");
      }
      else await app.submit(entry);
      app.tui.renderNow();
      await terminal.flush();
      expect(app.interaction.isActive()).toBe(true);
      terminal.sendInput("\x1b");
      app.tui.renderNow();
      await terminal.flush();
      expect(app.interaction.isActive()).toBe(false);
      const expected = app.tui.render(80).map((line) => stripAnsi(line).trimEnd()).slice(-24);
      expect(terminal.getViewport().map((line) => line.trimEnd())).toEqual(expected);
      for (let index = 0; index < 12; index++) {
        expect(terminal.getScrollBuffer().filter((line) => line.trimEnd().endsWith(`› Message ${index}`))).toHaveLength(1);
      }
    } finally {
      await app.stop();
    }
  });

  it.each(["multiline draft", "image preview"])("restores the chat viewport after dismissing %s", async (kind) => {
    const terminal = new ClearToScrollbackTerminal(80, 24);
    const app = createTuiApp({
      runtime: createRuntime(), terminal, version: "0.2.0", workspaceDir: "/workspace",
      resolveAttachment: async () => ({ type: "image", filePath: "/tmp/preview-missing.png", fileName: "preview.png", mimeType: "image/png", sizeBytes: 32768 }),
    });
    app.start();
    try {
      await app.ready;
      for (let index = 0; index < 12; index++) await app.submit(`Message ${index}`);
      if (kind === "multiline draft") {
        app.editor.setText(Array.from({ length: 8 }, (_, index) => `Draft ${index}`).join("\n"));
      } else {
        terminal.sendInput("\x1b[200~/tmp/preview-missing.png\x1b[201~");
        await vi.waitFor(() => expect(app.editor.getAttachmentPreview()).toBeDefined());
      }
      app.tui.renderNow();
      await terminal.flush();
      expect(terminal.getViewport().join("\n")).toContain(kind === "multiline draft" ? "Draft 7" : "preview.png");
      terminal.sendInput(kind === "multiline draft" ? "\x03" : "\x1b");
      app.tui.renderNow();
      await terminal.flush();
      if (kind === "multiline draft") expect(app.editor.getText()).toBe("");
      else expect(app.editor.getAttachmentPreview()).toBeUndefined();
      const expected = app.tui.render(80).map((line) => stripAnsi(line).trimEnd()).slice(-24);
      expect(terminal.getViewport().map((line) => line.trimEnd())).toEqual(expected);
    } finally {
      await app.stop();
    }
  });

  it("does not push the conversation downward after closing /usage", async () => {
    const terminal = new VirtualTerminal(80, 50);
    const runtime = createRuntime();
    vi.mocked(runtime.getAccountStatus).mockResolvedValue({
      status: "ready",
      authMode: "managed-login",
      managedTokenPresent: true,
      modelSource: "token-plan",
      tokenPlanQuotaState: "available",
      tokenPlanSummary: { tier: "Ultra Plan", creditBalance: "100" },
      tokenPlanQuota: {
        fiveHour: { remainingPercent: 75, unlimited: false },
        weekly: { remainingPercent: 50, unlimited: false },
        video: { remainingCount: 5, totalCount: 5, unlimited: false },
      },
      warnings: [],
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    try {
      await app.ready;
      for (let index = 0; index < 2; index++) await app.submit(`Message ${index}`);
      app.tui.renderNow();
      await terminal.flush();
      expect(terminal.getViewport().join("\n")).toContain("Message 1");
      const firstContentRowBefore = terminal.getViewport().findIndex((line) => line.trim().length > 0);

      await app.submit("/usage");
      app.tui.renderNow();
      await terminal.flush();
      expect(terminal.getViewport().join("\n")).toContain("Usage");

      terminal.sendInput("\x1b");
      app.tui.renderNow();
      await terminal.flush();
      const viewport = terminal.getViewport().join("\n");
      expect(viewport).toContain("Message 1");
      expect(viewport).toContain("Message");
      expect(app.tui.render(80).findIndex((line) => line.trim().length > 0)).toBe(firstContentRowBefore);
      expect(terminal.getViewport().findIndex((line) => line.trim().length > 0)).toBe(firstContentRowBefore);
    } finally {
      await app.stop();
    }
  });

  it.each([
    ['xterm', VirtualTerminal],
    ['clear-to-scrollback terminal', ClearToScrollbackTerminal],
  ] as const)('restores unique long history after /usage on %s', async (_name, Terminal) => {
    const terminal = new Terminal(80, 24);
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    try {
      await app.ready;
      for (let index = 0; index < 12; index++) await app.submit(`Message ${index}`);
      await app.submit("/usage");
      app.tui.renderNow();
      await terminal.flush();
      expect(terminal.getViewport().join("\n")).toContain("Usage");

      terminal.sendInput("\x1b");
      app.tui.renderNow();
      await terminal.flush();
      const history = terminal.getScrollBuffer();
      for (let index = 0; index < 12; index++) {
        expect(history.filter((line) => line.trimEnd().endsWith(`› Message ${index}`))).toHaveLength(1);
      }
      expect(history.join("\n")).not.toContain("Session usage");
      expect(terminal.getViewport().join("\n")).toContain("Ask Mcode to do anything");
      expect(terminal.getViewport().join("\n")).toContain("/workspace");
    } finally {
      await app.stop();
    }
  });

  it("uses public Runtime owners for Session inspection commands", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 40;
    const runtime = createRuntime();
    vi.mocked(runtime.getAccountStatus).mockResolvedValue({
      status: "ready",
      defaultModel: "minimax/MiniMax-M3",
      providerId: "minimax-cn-coding-plan",
      authMode: "managed-login",
      managedTokenPresent: true,
      modelSource: "token-plan",
      tokenPlanQuotaState: "available",
      tokenPlanSummary: { tier: "Ultra Plan", creditBalance: "0" },
      tokenPlanQuota: {
        fiveHour: { remainingPercent: 100, unlimited: false },
        weekly: { remainingPercent: 99, unlimited: false },
        video: { remainingCount: 5, totalCount: 5, unlimited: false },
      },
      warnings: [],
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.submit("Create a session");
    vi.mocked(runtime.sendMessage).mockClear();
    vi.mocked(runtime.getSessionUsage).mockClear();
    vi.mocked(runtime.getContextSnapshot).mockResolvedValueOnce({
      status: "live",
      contextUsage: {
        contextWindowTokens: 10_000,
        usedTokens: 3_000,
        totalCountSource: "PROVIDER_USAGE_ANCHORED",
        components: [],
      },
    });
    const transcriptBeforeUsage = app.transcript.snapshot();
    await app.submit("/usage");
    const usageOutput = app.tui.render(80).join("\n");

    expect(app.interaction.current()).toBeDefined();
    expect(app.transcript.snapshot()).toEqual(transcriptBeforeUsage);
    expect(usageOutput).toContain("Usage");
    expect(usageOutput).toContain("120 total");
    expect(usageOutput).toContain("30% used · 70% free");
    expect(usageOutput).toContain("Ultra Plan");
    expect(usageOutput).toContain("100% left");

    app.interaction.current()?.handleInput?.("\x1b");
    expect(app.interaction.current()).toBeUndefined();
    expect(app.transcript.snapshot()).toEqual(transcriptBeforeUsage);
    await app.submit("/compact keep test evidence");

    expect(runtime.getSessionUsage).toHaveBeenCalledWith("session-1");
    expect(runtime.getContextSnapshot).toHaveBeenCalledWith("session-1");
    expect(runtime.getAccountStatus).toHaveBeenCalledWith("session-1", {
      includeMembership: true,
      forceRefresh: true,
    });
    expect(runtime.requestCompaction).toHaveBeenCalledWith(
      "session-1",
      "mavis",
      "keep test evidence",
    );
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    const output = app.transcript
      .snapshot()
      .map((cell) => cell.content)
      .join("\n");
    expect(output).not.toContain("Session usage");
    expect(output).not.toMatch(
      /Turns|Total tokens|Cost|Reasoning|Cache|Runtime|source|compaction|snapshot/i,
    );
    expect(output).not.toContain("Compaction completed");
    expect(output).not.toContain("4,000 → 1,200 tokens");
    expect(output).not.toContain("compact-1");
  });

  it("shows compaction as live activity until the Runtime request settles", async () => {
    const runtime = createRuntime();
    let resolveCompaction:
      | ((result: {
          success: true;
          sessionId: string;
          compactionId: string;
        }) => void)
      | undefined;
    vi.mocked(runtime.requestCompaction).mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveCompaction = resolve;
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.submit("Create a session");
    const pending = app.submit("/compact keep decisions");
    await vi.waitFor(() =>
      expect(app.tui.render(80).join("\n")).toContain("Compacting context"),
    );
    expect(app.tui.render(80).join("\n")).not.toContain("Esc to interrupt");

    resolveCompaction?.({
      success: true,
      sessionId: "session-1",
      compactionId: "compact-1",
    });
    await pending;
    expect(app.tui.render(80).join("\n")).not.toContain("Compacting context");
  });

  it("treats Runtime NOTHING_TO_COMPACT as a recoverable Session state", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.requestCompaction).mockRejectedValue(
      Object.assign(new Error("HTTP 400 implementation detail"), {
        status: 400,
        code: "NOTHING_TO_COMPACT",
      }),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.submit("Create a session");
    await app.submit("/compact");

    expect(app.transcript.snapshot().at(-1)).toMatchObject({
      kind: "final-summary",
      content: "No compaction is needed for this conversation yet.",
    });
  });

  it("shows account usage before a Session exists and keeps Session-only inspection recoverable", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getAccountStatus).mockResolvedValue({
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
    const terminal = new FakeTerminal();
    terminal.rows = 40;
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.submit("/usage");
    const usageOutput = app.tui.render(80).join("\n");

    expect(app.interaction.current()).toBeDefined();
    expect(app.transcript.snapshot()).toEqual([]);
    expect(usageOutput).toContain("Usage");
    expect(usageOutput).toContain("Account only");
    expect(usageOutput).toContain("Pro Plan");
    expect(usageOutput).toContain("75% left");

    app.interaction.current()?.handleInput?.("\x1b");
    expect(app.interaction.current()).toBeUndefined();
    expect(app.transcript.snapshot()).toEqual([]);
    await app.submit("/compact");

    expect(runtime.getSessionUsage).not.toHaveBeenCalled();
    expect(runtime.getContextSnapshot).not.toHaveBeenCalled();
    expect(runtime.getAccountStatus).toHaveBeenCalledWith(undefined, {
      includeMembership: true,
      forceRefresh: true,
    });
    expect(app.transcript.snapshot()).toEqual([]);
    expect(app.tui.render(80).join("\n")).toContain(
      "Start or resume a Session before compacting it.",
    );
  });

  it("keeps prompt history and long bracketed paste intact in the Composer", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("first prompt");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1),
    );
    terminal.input?.("second prompt");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.sendMessage).toHaveBeenCalledTimes(2),
    );

    terminal.input?.("\x1b[A");
    expect(app.editor.getText()).toBe("second prompt");
    terminal.input?.("\x1b[A");
    expect(app.editor.getText()).toBe("first prompt");
    terminal.input?.("\x1b[B");
    expect(app.editor.getText()).toBe("second prompt");

    app.editor.setText("");
    const pasted = `Explain this payload:\n${"x".repeat(1_200)}`;
    terminal.input?.(`\x1b[200~${pasted}\x1b[201~`);
    expect(app.editor.getText()).toContain("[paste #");
    expect(app.editor.getExpandedText()).toBe(pasted);
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.sendMessage).toHaveBeenCalledTimes(3),
    );
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "session-1", content: pasted }),
      expect.any(AbortSignal),
    );
    await app.stop();
  });

  it("trusts bracketed paste and submits dense typed input without a false newline", async () => {
    const terminal = new FakeTerminal();
    Object.defineProperty(terminal, "capabilities", {
      value: {
        terminalId: "unknown",
        platform: "linux",
        isTTY: true,
        transport: "local",
        multiplexer: "none",
        color: true,
        colorLevel: 3,
      } satisfies TerminalCapabilities,
    });
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    for (const character of "abcdefgh") terminal.input?.(character);
    terminal.input?.("\r");

    await vi.waitFor(() =>
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1),
    );
    expect(app.editor.getText()).toBe("");
    await app.stop();
  });

  it("projects an otty image paste as an inline editor placeholder", async () => {
    const terminal = new FakeTerminal();
    const resolveAttachment = vi.fn(async () => ({
      type: "image" as const,
      filePath: "/tmp/otty-paste/image-123.png",
      fileName: "image-123.png",
      mimeType: "image/png",
      sizeBytes: 1_024,
    }));
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      resolveAttachment,
    });

    app.start();
    await app.ready;
    terminal.input?.("\x1b[200~/tmp/otty-paste/image-123.png\x1b[201~");
    await vi.waitFor(() => expect(resolveAttachment).toHaveBeenCalledTimes(1));

    const rendered = app.tui.render(80).join("\n");
    expect(app.editor.getText()).toBe("[Image #1] ");
    expect(rendered).toContain("[Image #1]");
    expect(rendered).not.toContain("/tmp/otty-paste/");
    await app.stop();
  });

  it.each(["regular", "fullscreen"] as const)(
    "keeps image preview controls separate from Enter submission in %s mode",
    async (tuiMode) => {
      const terminal = new FakeTerminal();
      terminal.rows = 40;
      const runtime = createRuntime();
      const app = createTuiApp({
        runtime,
        terminal,
        tuiMode,
        version: "0.1.0",
        workspaceDir: "/workspace",
        resolveAttachment: async () => ({
          type: "image",
          filePath: "/tmp/image-preview-missing.png",
          fileName: "preview.png",
          mimeType: "image/png",
          sizeBytes: 32768,
        }),
      });
      app.start();
      await app.ready;
      terminal.input?.("\x1b[200~/tmp/image-preview-missing.png\x1b[201~");
      await vi.waitFor(() =>
        expect(app.editor.getAttachmentPreview()?.id).toBe(
          "/tmp/image-preview-missing.png",
        ),
      );
      expect(app.editor.getText()).toBe("[Image #1] ");
      expect(app.tui.render(80).join("\n")).toContain("preview.png");
      expect(app.tui.render(80).join("\n")).toContain("32 KB");
      expect(app.tui.render(80).join("\n")).not.toMatch(/Option\+I|Alt\+I/);
      expect(runtime.sendMessage).not.toHaveBeenCalled();
      terminal.input?.("\x1b");
      expect(app.editor.getAttachmentPreview()).toBeUndefined();
      terminal.input?.("\x1b[D");
      expect(app.editor.getAttachmentPreview()?.id).toBe(
        "/tmp/image-preview-missing.png",
      );
      terminal.input?.("\r");
      await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalled());
      expect(runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "",
          attachments: [
            expect.objectContaining({
              local: { filePath: "/tmp/image-preview-missing.png" },
            }),
          ],
        }),
        expect.any(AbortSignal),
      );
      expect(app.editor.getAttachmentPreview()).toBeUndefined();
      await app.stop();
    },
  );

  it("projects a pasted absolute WeChat image path as a short inline placeholder", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const wechatImagePath =
      "D:\\Yingyong\\social\\wechat\\xwechat_files\\wxid_demo\\temp\\RWTemp\\2026-08\\3336519cd4d5351f4bc5a5a68c7fea75.png";
    const resolveAttachment = vi.fn(async () => ({
      type: "image" as const,
      filePath: wechatImagePath,
      fileName: "3336519cd4d5351f4bc5a5a68c7fea75.png",
      mimeType: "image/png",
      sizeBytes: 1_024,
    }));
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "D:\\workspace",
      resolveAttachment,
    });

    app.start();
    await app.ready;
    terminal.input?.(`\x1b[200~'${wechatImagePath}'\x1b[201~`);
    await vi.waitFor(() => expect(resolveAttachment).toHaveBeenCalledOnce());

    expect(resolveAttachment).toHaveBeenCalledWith(`'${wechatImagePath}'`, {
      source: "terminal-paste",
      workspaceDir: "D:\\workspace",
    });
    expect(app.editor.getText()).toBe("[Image #1] ");
    expect(app.tui.render(80).join("\n")).not.toContain("xwechat_files");
    await app.submit("Inspect this image");
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Inspect this image",
        attachments: [
          expect.objectContaining({
            local: { filePath: wechatImagePath },
          }),
        ],
      }),
      expect.any(AbortSignal),
    );
    await app.stop();
  });

  it("keeps an image placeholder visible before a long CJK prompt", async () => {
    const terminal = new FakeTerminal();
    const resolveAttachment = vi.fn(async () => ({
      type: "image" as const,
      filePath: "/tmp/otty-paste/logo.png",
      fileName: "logo.png",
      mimeType: "image/png",
      sizeBytes: 1_024,
    }));
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      resolveAttachment,
    });

    app.start();
    await app.ready;
    terminal.input?.("\x1b[200~/tmp/otty-paste/logo.png\x1b[201~");
    await vi.waitFor(() => expect(resolveAttachment).toHaveBeenCalledTimes(1));
    app.editor.insertTextAtCursor(
      "logo 不太对还是，还出现了奇怪的--; logo你自己截取把:",
    );

    const rendered = app.tui.render(80).join("\n");
    expect(rendered).toContain("[Image #1]");
    await app.stop();
  });

  it("removes an inline image placeholder and its attachment with Backspace", async () => {
    const terminal = new FakeTerminal();
    const resolveAttachment = vi.fn(async () => ({
      type: "image" as const,
      filePath: "/tmp/otty-paste/image-123.png",
      fileName: "image-123.png",
      mimeType: "image/png",
      sizeBytes: 1_024,
    }));
    const app = createTuiApp({
      runtime: createRuntime(),
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      resolveAttachment,
    });

    app.start();
    await app.ready;
    app.editor.setText("first line\nsecond line");
    terminal.input?.("\x1b[200~/tmp/otty-paste/image-123.png\x1b[201~");
    await vi.waitFor(() => expect(resolveAttachment).toHaveBeenCalledTimes(1));

    expect(app.editor.getText()).toBe("first line\nsecond line [Image #1] ");
    expect(app.tui.render(80).join("\n")).toContain("[Image #1]");

    terminal.input?.("\x7f");
    await vi.waitFor(() =>
      expect(app.editor.getText().trimEnd()).toBe("first line\nsecond line"),
    );
    expect(app.tui.render(80).join("\n")).not.toContain("[Image #1]");
    await app.stop();
  });

  it("resumes Desktop history, supports rename, and executes the files-unchanged fork flow", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-existing",
        title: "Existing session",
        workspaceDir: "/workspace",
        updatedAt: 200,
      },
    ]);
    const history = [
      {
        id: "msg-user-v1-fork-source",
        turnId: "turn-history",
        role: "user" as const,
        content: "Try the original approach",
        timestamp: 90,
      },
      {
        id: "assistant-fork-source",
        turnId: "turn-history",
        role: "assistant" as const,
        content: "Recovered answer",
        timestamp: 100,
        actions: { fork: true },
      },
    ];
    const forkRuntime = runtime as TuiRuntime & TuiSessionForkPort;
    vi.mocked(runtime.getMessages).mockResolvedValue(history);
    vi.mocked(runtime.listMessagePage).mockResolvedValue({
      messages: history,
      hasMore: false,
    });
    vi.mocked(runtime.getSession).mockImplementation(async (sessionId) =>
      sessionId === "session-fork"
        ? {
            sessionId,
            parentSessionId: "session-existing",
            title: "Existing session (fork 1)",
            workspaceDir: "/workspace",
          }
        : {
            sessionId,
            title: "Existing session",
            workspaceDir: "/workspace",
          },
    );
    vi.mocked(forkRuntime.getSessionForkOptions).mockResolvedValue({
      canFork: true,
      suggestedTitle: "Existing session (fork 1)",
      worktreeVisible: false,
      worktreeEligible: false,
    });
    vi.mocked(forkRuntime.forkSession).mockResolvedValue({
      session: {
        sessionId: "session-fork",
        parentSessionId: "session-existing",
        title: "Existing session (fork 1)",
        workspaceDir: "/workspace",
      },
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("/sessions");
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);
    app.interaction.current()?.handleInput?.("\x1b");
    expect(app.interaction.isActive()).toBe(false);
    await app.submit("/resume 1");
    expect(app.getSurface()).toBe("conversation");
    vi.mocked(runtime.renameSession).mockClear();
    await app.submit("/rename");
    expect(runtime.renameSession).not.toHaveBeenCalled();
    expect(app.interaction.isActive()).toBe(true);
    expect(app.tui.render(100).join("\n")).toContain(
      "Sessions / Rename session",
    );
    app.interaction.current()?.handleInput?.("\x1b");
    expect(app.tui.render(100).join("\n")).toContain("Sessions");
    app.interaction.current()?.handleInput?.("\x1b");
    expect(app.interaction.isActive()).toBe(false);
    await app.submit("/rename Renamed session");
    vi.mocked(runtime.createSession).mockClear();
    await app.submit("/fork");
    await vi.waitFor(() =>
      expect(runtime.listSessionInputSummaries).toHaveBeenCalledWith(
        "session-existing",
        {
          limit: 100,
        },
      ),
    );
    // The new fork flow owns the surface with the history picker, not the
    // generic transcript panel.
    expect(renderTerminalViewport(app, terminal)).toContain(
      "Fork from a previous message",
    );
    expect(renderTerminalViewport(app, terminal)).not.toContain("Transcript");
    // Esc cancels without calling the fork Runtime API.
    const beforeForkCalls = vi.mocked(runtime.forkSession).mock.calls.length;
    app.surfaceHost.popFeature();
    expect(vi.mocked(runtime.forkSession).mock.calls.length).toBe(
      beforeForkCalls,
    );
    const transcriptBeforeStatus = app.transcript.snapshot();
    await app.submit("/status");

    expect(runtime.getSession).toHaveBeenCalledWith("session-existing");
    expect(app.interaction.current()).toBeDefined();
    expect(app.transcript.snapshot()).toEqual(transcriptBeforeStatus);
    expect(app.tui.render(100).join("\n")).toContain("MCode status");
    expect(runtime.renameSession).toHaveBeenCalledWith(
      "session-existing",
      "Renamed session",
    );
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(app.transcript.snapshot()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "Unknown command. Use /help." }),
      ]),
    );
    app.interaction.current()?.handleInput?.("\x1b");
    await app.stop();
  });

  it.each(["regular", "fullscreen"] as const)(
    "presents /history in %s mode and returns to chat on cancel",
    async (tuiMode) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
        {
          userMessageId: "msg-user-history",
          assistantMessageId: "msg-assistant-history",
          contentHead: "Inspect the Session UI",
          timestamp: 1_700_000_000_000,
          fileChangeCount: 1,
        },
      ]);
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
        tuiMode,
      });
      app.start();
      await app.ready;
      await app.submit("Seed the session");
      await app.submit("/history");

      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-history:explorer",
        }),
      );
      expect(renderTerminalViewport(app, terminal)).toContain(
        "Inspect the Session UI",
      );
      expect(renderTerminalViewport(app, terminal)).toContain("Search:");
      expect(renderTerminalViewport(app, terminal)).toContain("Enter actions");

      terminal.input?.("\u001b");
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "chat",
        id: "chat",
      });
      await app.stop();
    },
  );

  it("forks with the assistant boundary and starts a new operation after a terminal failure", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      {
        userMessageId: "msg-user-1",
        assistantMessageId: "msg-assistant-1",
        contentHead: "Investigate flaky login tests",
        timestamp: 1_700_000_000_000,
        fileChangeCount: 2,
      },
      {
        userMessageId: "msg-user-2",
        assistantMessageId: "msg-assistant-2",
        contentHead: "Draft a new CLI handler",
        timestamp: 1_699_999_000_000,
        fileChangeCount: 0,
      },
    ]);
    vi.mocked(runtime.getSessionForkOptions).mockResolvedValue({
      canFork: true,
      worktreeVisible: false,
      worktreeEligible: false,
    });
    vi.mocked(runtime.forkSession).mockRejectedValueOnce(
      Object.assign(new Error("persisted fork recovery failed"), {
        key: "FORK_RECOVERY_FAILED",
      }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;

    // Submit a message so the controller has an active session id.
    await app.submit("Seed the session");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().session?.sessionId).toBe("session-1"),
    );
    const sourceSessionId = app.controller.snapshot().session?.sessionId;
    expect(sourceSessionId).toBe("session-1");

    const transcriptBefore = app.transcript.snapshot();
    vi.mocked(runtime.createSession).mockClear();
    vi.mocked(runtime.forkSession).mockClear();
    vi.mocked(runtime.getSessionForkOptions).mockClear();
    vi.mocked(runtime.listSessionInputSummaries).mockClear();
    await app.submit("/fork");

    // 1. /fork loads input summaries, not the generic transcript.
    await vi.waitFor(() =>
      expect(runtime.listSessionInputSummaries).toHaveBeenCalledWith(
        sourceSessionId,
        {
          limit: 100,
        },
      ),
    );
    expect(renderTerminalViewport(app, terminal)).toContain(
      "Fork from a previous message",
    );
    expect(renderTerminalViewport(app, terminal)).not.toContain("Transcript");

    // 2. The newest summary (last entry) is selected by default; confirm with Enter.
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:history",
      }),
    );
    terminal.input?.("\r");

    // The history selection only fetches options; it must not mutate yet.
    await vi.waitFor(() =>
      expect(runtime.getSessionForkOptions).toHaveBeenCalledWith(
        sourceSessionId,
        "msg-assistant-2",
      ),
    );
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:fork-confirm",
      }),
    );
    expect(runtime.forkSession).not.toHaveBeenCalled();
    expect(renderTerminalViewport(app, terminal)).toContain("Confirm fork");

    // 3. Explicit confirmation performs the mutation.
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.forkSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: sourceSessionId,
          assistantMessageId: "msg-assistant-2",
          useSuggestedTitle: true,
          createIsolatedWorktree: false,
        }),
      ),
    );

    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:fork-confirm",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.forkSession).toHaveBeenCalledTimes(2),
    );
    const forkCalls = vi.mocked(runtime.forkSession).mock.calls;
    const operationIds = forkCalls.map(([input]) => input.clientRequestId);
    expect(operationIds[0]).toBeTruthy();
    expect(operationIds[1]).toBeTruthy();
    expect(operationIds[0]).not.toBe(operationIds[1]);

    // 5. Activation moves the controller to the child session id.
    await vi.waitFor(() =>
      expect(app.controller.snapshot().session?.sessionId).toBe("session-fork"),
    );
    expect(runtime.createSession).not.toHaveBeenCalled();
    // The user message that seeded the source session was already projected
    // into the transcript before the fork ran; the fork flow must not write
    // any new user-typed cell while the picker is open or the mutation runs.
    expect(
      transcriptBefore.filter((cell) => cell.kind === "user").length,
    ).toBeGreaterThan(0);
  });

  it("does not call forkSession when /fork is cancelled, unavailable, or fails", async () => {
    const scenarios: ReadonlyArray<{
      readonly label: string;
      readonly setup: (runtime: ReturnType<typeof createRuntime>) => void;
      readonly interact: (terminal: FakeTerminal) => void | Promise<void>;
      /** When true, expect forkSession to have been called exactly once. */
      readonly expectForkCall: boolean;
      readonly confirmAfterSelection?: boolean;
    }> = [
      {
        label: "esc cancels the picker without invoking fork",
        setup: (runtime) => {
          vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
            {
              userMessageId: "msg-user-1",
              assistantMessageId: "msg-assistant-1",
              contentHead: "Investigate flaky login tests",
              timestamp: 1_700_000_000_000,
              fileChangeCount: 0,
            },
          ]);
        },
        interact: (terminal) => {
          terminal.input?.("\u001b");
        },
        expectForkCall: false,
      },
      {
        label: "unavailable fork surfaces a warning without invoking fork",
        setup: (runtime) => {
          vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
            {
              userMessageId: "msg-user-1",
              assistantMessageId: "msg-assistant-1",
              contentHead: "Investigate flaky login tests",
              timestamp: 1_700_000_000_000,
              fileChangeCount: 0,
            },
          ]);
          vi.mocked(runtime.getSessionForkOptions).mockResolvedValue({
            canFork: false,
            unavailableReason: "No persisted user prompts yet.",
            worktreeVisible: false,
            worktreeEligible: false,
          });
        },
        interact: (terminal) => {
          terminal.input?.("\r");
        },
        expectForkCall: false,
      },
      {
        label:
          "forkSession failure preserves the source session and transcript",
        setup: (runtime) => {
          vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
            {
              userMessageId: "msg-user-1",
              assistantMessageId: "msg-assistant-1",
              contentHead: "Investigate flaky login tests",
              timestamp: 1_700_000_000_000,
              fileChangeCount: 0,
            },
          ]);
          vi.mocked(runtime.getSessionForkOptions).mockResolvedValue({
            canFork: true,
            worktreeVisible: false,
            worktreeEligible: false,
          });
          vi.mocked(runtime.forkSession).mockRejectedValue(
            new Error("Runtime offline."),
          );
        },
        interact: (terminal) => {
          terminal.input?.("\r");
        },
        expectForkCall: true,
        confirmAfterSelection: true,
      },
    ];

    for (const scenario of scenarios) {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      scenario.setup(runtime);
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
      });
      app.start();
      await app.ready;
      await app.submit("Seed the session");
      await vi.waitFor(() =>
        expect(app.controller.snapshot().session?.sessionId).toBe("session-1"),
      );
      const sourceSessionId = app.controller.snapshot().session?.sessionId;
      const transcriptBefore = app.transcript.snapshot();
      await app.submit("/fork");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:history",
        }),
      );
      await scenario.interact(terminal);
      if (scenario.expectForkCall || scenario.label.includes("unavailable")) {
        await vi.waitFor(() =>
          expect(runtime.getSessionForkOptions).toHaveBeenCalled(),
        );
      }
      expect(runtime.forkSession).not.toHaveBeenCalled();
      if (scenario.confirmAfterSelection) {
        terminal.input?.("\r");
      }
      // Give the async fork pipeline a chance to settle.
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (scenario.expectForkCall) {
        expect(
          vi.mocked(runtime.forkSession).mock.calls.length,
          `${scenario.label} should call forkSession once`,
        ).toBe(1);
      } else {
        expect(
          vi.mocked(runtime.forkSession).mock.calls.length,
          `${scenario.label} should not call forkSession`,
        ).toBe(0);
      }
      expect(
        app.controller.snapshot().session?.sessionId,
        `${scenario.label} must not switch sessions`,
      ).toBe(sourceSessionId);
      expect(
        app.transcript.snapshot().filter((cell) => cell.kind === "user").length,
        `${scenario.label} must preserve the source transcript`,
      ).toBe(transcriptBefore.filter((cell) => cell.kind === "user").length);
      await app.stop();
    }
  });

  it("does not call forkSession when the source session changes between summary and selection", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      {
        userMessageId: "msg-user-1",
        assistantMessageId: "msg-assistant-1",
        contentHead: "Investigate flaky login tests",
        timestamp: 1_700_000_000_000,
        fileChangeCount: 0,
      },
    ]);
    vi.mocked(runtime.getSessionForkOptions).mockResolvedValue({
      canFork: true,
      worktreeVisible: false,
      worktreeEligible: false,
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed the session");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().session?.sessionId).toBe("session-1"),
    );

    await app.submit("/fork");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:history",
      }),
    );

    // Simulate the source session changing while the picker is open.
    const otherSession = {
      sessionId: "session-other",
      title: "Other session",
      workspaceDir: "/workspace",
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([otherSession]);
    vi.mocked(runtime.getSession).mockImplementation(async (sessionId) =>
      sessionId === otherSession.sessionId
        ? otherSession
        : { sessionId, workspaceDir: "/workspace" },
    );
    await app.openSession(otherSession.sessionId);
    expect(app.controller.snapshot().session?.sessionId).toBe(
      otherSession.sessionId,
    );

    // Confirming the picker now must not call forkSession.
    terminal.input?.("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(vi.mocked(runtime.forkSession)).not.toHaveBeenCalled();
    expect(vi.mocked(runtime.getSessionForkOptions).mock.calls.length).toBe(0);
  });

  it("preserves the /fork command draft and skips mutation when a turn is running", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishTurn: (() => void) | undefined;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        yield { type: "done" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    const submission = app.submit("Seed the session");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().session?.sessionId).toBe("session-1"),
    );
    await vi.waitFor(() =>
      expect(vi.mocked(runtime.sendMessage)).toHaveBeenCalled(),
    );

    const summariesBefore = vi.mocked(runtime.listSessionInputSummaries).mock
      .calls.length;
    const forkOptionsBefore = vi.mocked(runtime.getSessionForkOptions).mock
      .calls.length;
    const forkBefore = vi.mocked(runtime.forkSession).mock.calls.length;

    // While the turn is still running, /fork should preserve the draft and
    // skip every runtime mutation method.
    app.editor.setText("/fork");
    await app.submit("/fork");

    expect(app.editor.getText()).toBe("/fork");
    expect(vi.mocked(runtime.listSessionInputSummaries).mock.calls.length).toBe(
      summariesBefore,
    );
    expect(vi.mocked(runtime.getSessionForkOptions).mock.calls.length).toBe(
      forkOptionsBefore,
    );
    expect(vi.mocked(runtime.forkSession).mock.calls.length).toBe(forkBefore);
    // The fork surface should not have been pushed either.
    expect(app.surfaceHost.getActiveSurface()).toEqual({
      kind: "chat",
      id: "chat",
    });

    finishTurn?.();
    await submission;
    await app.stop();
  });

  it.each([
    ["conversation", []],
    ["conversation_and_files", ["\u001b[B"]],
  ] as const)(
    "runs /rewind with explicit %s scope and stable operation id",
    async (scope, navigation) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
        {
          userMessageId: "msg-user-rewind",
          contentHead: "Undo this point",
          timestamp: 1_700_000_000_000,
          fileChangeCount: 2,
        },
      ]);
      vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({
        turns: [
          {
            turnId: "turn-1",
            files: [
              { filePath: "src/ready.ts", action: "modified", skipped: false },
              { filePath: "src/skipped.ts", action: "deleted", skipped: true },
            ],
          },
        ],
      });
      vi.mocked(runtime.rewindSession).mockResolvedValue(
        scope === "conversation"
          ? { rewound: true }
          : {
              rewound: true,
              turnDiffRewind: {
                status: "rewound",
                revertedTurnIds: ["turn-1"],
              },
            },
      );
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
      });
      app.start();
      await app.ready;
      await app.submit("Seed rewind session");
      await vi.waitFor(() =>
        expect(app.controller.snapshot().session?.sessionId).toBe("session-1"),
      );
      expect(
        app.transcript.snapshot().some((cell) => cell.kind === "turn-duration"),
      ).toBe(true);
      vi.mocked(runtime.getMessages).mockResolvedValue([]);

      await app.submit("/rewind");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:history",
        }),
      );
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(runtime.getSessionRewindPreview).toHaveBeenCalledWith({
          sessionId: "session-1",
          userMessageId: "msg-user-rewind",
        }),
      );
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:rewind-preview",
        }),
      );
      expect(renderTerminalViewport(app, terminal)).toContain("src/ready.ts");
      expect(renderTerminalViewport(app, terminal)).toContain("src/skipped.ts");
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:scope",
        }),
      );
      for (const key of navigation) terminal.input?.(key);
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:rewind-confirm",
        }),
      );
      expect(runtime.rewindSession).not.toHaveBeenCalled();
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(runtime.rewindSession).toHaveBeenCalledTimes(1),
      );
      const input = vi.mocked(runtime.rewindSession).mock.calls[0]?.[0];
      expect(input).toEqual({
        sessionId: "session-1",
        userMessageId: "msg-user-rewind",
        clientRequestId: expect.stringMatching(/^tui-rewind_/),
        ...(scope === "conversation_and_files" ? { rewindTurnDiff: true } : {}),
      });
      expect(input?.clientRequestId).toMatch(/^tui-rewind_/);
      await vi.waitFor(() => expect(runtime.getMessages).toHaveBeenCalled());
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "chat",
          id: "chat",
        }),
      );
      expect(
        app.transcript
          .snapshot()
          .some((cell) => cell.content === "Rewind completed."),
      ).toBe(false);
      expect(app.transcript.snapshot()).toEqual([]);
      await app.stop();
    },
  );

  it("edits only the latest user turn, hides that turn while editing, and adds no completion cell", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      {
        userMessageId: "msg-user-older",
        assistantMessageId: "msg-assistant-older",
        contentHead: "Older prompt",
        timestamp: 1,
        fileChangeCount: 0,
      },
      {
        userMessageId: "msg-user-latest",
        assistantMessageId: "msg-assistant-latest",
        contentHead: "Latest prompt",
        timestamp: 2,
        fileChangeCount: 0,
      },
    ]);
    vi.mocked(runtime.listMessagePage).mockResolvedValue({
      messages: [
        {
          id: "msg-user-older",
          role: "user",
          content: "Older prompt",
          timestamp: 1,
        },
        {
          id: "msg-user-latest",
          role: "user",
          content: "Latest prompt",
          timestamp: 2,
        },
      ],
      hasMore: false,
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed edit session");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().session?.sessionId).toBe("session-1"),
    );
    app.transcript.upsert({
      id: "older-user-cell",
      kind: "user",
      status: "succeeded",
      content: "Older prompt",
      sourceMessageId: "msg-user-older",
      turnId: "turn-older",
      createdAtMs: 1,
    });
    app.transcript.upsert({
      id: "latest-user-cell",
      kind: "user",
      status: "succeeded",
      content: "Latest prompt",
      sourceMessageId: "msg-user-latest",
      turnId: "turn-latest",
      createdAtMs: 2,
    });
    app.transcript.upsert({
      id: "latest-assistant-cell",
      kind: "assistant",
      status: "succeeded",
      content: "Latest response",
      sourceMessageId: "msg-assistant-latest",
      turnId: "turn-latest",
      createdAtMs: 3,
    });

    await app.submit("/edit");
    await vi.waitFor(() =>
      expect(app.editor.getExpandedText()).toBe("Latest prompt"),
    );
    expect(app.surfaceHost.getActiveSurface()).toEqual({
      kind: "chat",
      id: "chat",
    });
    const editingFrame = app.tui.render(100).join("\n");
    expect(editingFrame).toContain("Older prompt");
    expect(editingFrame).not.toContain("Latest response");

    const historyRefreshCount = vi.mocked(runtime.getMessages).mock.calls
      .length;
    app.editor.setText("Edited latest prompt");
    app.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(runtime.editSessionMessage).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(() =>
      expect(vi.mocked(runtime.getMessages).mock.calls.length).toBeGreaterThan(
        historyRefreshCount,
      ),
    );
    expect(
      app.transcript
        .snapshot()
        .some(
          (cell) =>
            cell.content ===
            "Edited message submitted; regenerating from this point.",
        ),
    ).toBe(false);
    expect(runtime.editSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessageId: "msg-user-latest",
        content: "Edited latest prompt",
      }),
    );
    await app.stop();
  });

  it("restores the hidden latest turn when Edit is cancelled", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      {
        userMessageId: "msg-user-latest",
        assistantMessageId: "msg-assistant-latest",
        contentHead: "Latest prompt",
        timestamp: 2,
        fileChangeCount: 0,
      },
    ]);
    vi.mocked(runtime.listMessagePage).mockResolvedValue({
      messages: [
        {
          id: "msg-user-latest",
          role: "user",
          content: "Latest prompt",
          timestamp: 2,
        },
      ],
      hasMore: false,
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed edit session");
    app.transcript.upsert({
      id: "latest-user-cell",
      kind: "user",
      status: "succeeded",
      content: "Latest prompt",
      sourceMessageId: "msg-user-latest",
      turnId: "turn-latest",
      createdAtMs: 2,
    });
    app.transcript.upsert({
      id: "latest-assistant-cell",
      kind: "assistant",
      status: "succeeded",
      content: "Latest response restored on cancel",
      sourceMessageId: "msg-assistant-latest",
      turnId: "turn-latest",
      createdAtMs: 3,
    });

    await app.submit("/edit");
    await vi.waitFor(() =>
      expect(app.editor.getExpandedText()).toBe("Latest prompt"),
    );
    expect(app.tui.render(100).join("\n")).not.toContain(
      "Latest response restored on cancel",
    );

    terminal.input?.("\u001b");
    await vi.waitFor(() => expect(app.editor.getExpandedText()).toBe(""));
    expect(app.tui.render(100).join("\n")).toContain(
      "Latest response restored on cancel",
    );
    expect(runtime.editSessionMessage).not.toHaveBeenCalled();
    await app.stop();
  });

  it.each([
    { reference: "filePath", action: "cancel" },
    { reference: "assetId", action: "send" },
    { reference: "assetId", action: "delete" },
    { reference: "filePath", action: "undo" },
    { reference: "assetId", action: "add" },
    { reference: "filePath", action: "clear-restore" },
    { reference: "filePath", action: "cached" },
  ] as const)(
    "restores editable image chips after double Escape and retry ($reference / $action)",
    async ({ reference, action }) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
        {
          userMessageId: "msg-user-latest",
          assistantMessageId: "msg-assistant-latest",
          contentHead: "Latest prompt from shortcut",
          timestamp: 2,
          fileChangeCount: 0,
        },
      ]);
      vi.mocked(runtime.listMessagePage).mockResolvedValue({
        messages: [
          {
            id: "msg-user-latest",
            role: "user",
            content: "Latest prompt from shortcut",
            attachments: [
              {
                type: "image",
                fileName: "edit-reference.png",
                mimeType: "image/png",
                [reference]:
                  reference === "filePath"
                    ? "/workspace/edit-reference.png"
                    : "asset-edit-image",
              },
            ],
            timestamp: 2,
          },
        ],
        hasMore: false,
      });
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
        resolveAttachment: async (path) => ({
          type: "image",
          filePath: path,
          fileName: path.endsWith("new.png") ? "new.png" : "edit-reference.png",
          mimeType: "image/png",
          sizeBytes: 123,
        }),
      });
      app.start();
      await app.ready;
      let restoredText = "Latest prompt from shortcut [Image #1] ";
      if (action === "cached") {
        terminal.input?.("\x1b[200~/workspace/edit-reference.png\x1b[201~");
        await vi.waitFor(() =>
          expect(app.editor.getText()).toContain("[Image #1]"),
        );
        app.editor.handleInput("Latest prompt from shortcut");
        restoredText = app.editor.getText();
        app.editor.handleInput("\r");
        await vi.waitFor(() =>
          expect(runtime.sendMessage).toHaveBeenCalledTimes(1),
        );
        await vi.waitFor(() =>
          expect(app.controller.snapshot().activeTurnId).toBeUndefined(),
        );
      } else {
        await app.submit("Seed edit session");
      }

      terminal.input?.("\u001b");
      terminal.input?.("\u001b");

      await vi.waitFor(() =>
        expect(app.editor.getExpandedText()).toBe(restoredText),
      );
      expect(runtime.listSessionInputSummaries).toHaveBeenCalledWith(
        "session-1",
        { limit: 100 },
      );
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "chat",
        id: "chat",
      });
      expect(stripAnsi(app.tui.render(100).join("\n"))).toContain("[Image #1]");
      vi.mocked(runtime.editSessionMessage).mockRejectedValueOnce(
        new Error("Temporary failure"),
      );
      app.editor.handleInput("\r");
      await vi.waitFor(() =>
        expect(runtime.editSessionMessage).toHaveBeenCalledTimes(1),
      );
      await vi.waitFor(() =>
        expect(app.editor.getExpandedText()).toBe(restoredText),
      );
      expect(stripAnsi(app.tui.render(100).join("\n"))).toContain("[Image #1]");
      expect(runtime.editSessionMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Latest prompt from shortcut",
          attachments: [
            expect.objectContaining({
              fileName: "edit-reference.png",
              [reference]:
                reference === "filePath"
                  ? "/workspace/edit-reference.png"
                  : "asset-edit-image",
            }),
          ],
        }),
      );
      if (action === "delete" || action === "undo") {
        app.editor.handleInput("\x05");
        app.editor.handleInput("\x7f");
        await vi.waitFor(() =>
          expect(app.editor.getText()).not.toContain("[Image #1]"),
        );
        if (action === "undo") {
          app.editor.handleInput("\x1f");
          expect(app.editor.getText()).toContain("[Image #1]");
        }
      }
      if (action === "add") {
        terminal.input?.("\x1b[200~/workspace/new.png\x1b[201~");
        await vi.waitFor(() =>
          expect(app.editor.getText()).toContain("[Image #2]"),
        );
        expect(app.editor.captureDraft().attachmentPlaceholders).toHaveLength(
          2,
        );
      }
      if (action === "clear-restore") {
        terminal.input?.("\x03");
        expect(app.editor.getText()).toBe("");
        terminal.input?.("\x1f");
        expect(app.editor.getText()).toContain("[Image #1]");
      }
      if (action === "cancel") {
        terminal.input?.("\u001b");
      } else {
        app.editor.handleInput("\r");
        await vi.waitFor(() =>
          expect(runtime.editSessionMessage).toHaveBeenCalledTimes(2),
        );
        const sent = vi.mocked(runtime.editSessionMessage).mock.calls[1]?.[0];
        expect(sent?.content).toBe("Latest prompt from shortcut");
        expect(sent?.attachments ?? []).toHaveLength(
          action === "delete" ? 0 : action === "add" ? 2 : 1,
        );
        if (action !== "delete")
          expect(sent?.attachments?.[0]?.fileName).toBe("edit-reference.png");
      }
      await vi.waitFor(() =>
        expect(stripAnsi(app.tui.render(100).join("\n"))).not.toContain(
          "[Image #1]",
        ),
      );
      await app.stop();
    },
  );

  it("edits the latest committed user turn through the desktop-aligned mutation contract", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      {
        userMessageId: "msg-user-v1-target",
        assistantMessageId: "msg-assistant-v1-target",
        contentHead: "Original prompt head",
        timestamp: 1_700_000_000_000,
        fileChangeCount: 1,
      },
    ]);
    vi.mocked(runtime.listMessagePage).mockResolvedValue({
      messages: [
        {
          id: "msg-user-v1-target",
          role: "user",
          content: "Original complete prompt",
          attachments: [
            {
              type: "file",
              fileName: "spec.md",
              mimeType: "text/markdown",
              sizeBytes: 42,
              filePath: "/workspace/spec.md",
            },
          ],
          timestamp: 1_700_000_000_000,
        },
      ],
      hasMore: false,
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed edit session");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().session?.sessionId).toBe("session-1"),
    );

    await app.submit("/edit");
    await vi.waitFor(() =>
      expect(app.editor.getExpandedText()).toBe(
        "Original complete prompt [File #1] ",
      ),
    );
    expect(app.surfaceHost.getActiveSurface()).toEqual({
      kind: "chat",
      id: "chat",
    });

    app.editor.setText("Updated prompt");
    app.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(runtime.editSessionMessage).toHaveBeenCalledTimes(1),
    );
    expect(runtime.editSessionMessage).toHaveBeenCalledWith({
      sessionId: "session-1",
      userMessageId: "msg-user-v1-target",
      clientRequestId: expect.stringMatching(/^tui-edit_/u),
      content: "Updated prompt",
      attachments: [
        {
          type: "file",
          fileName: "spec.md",
          mimeType: "text/markdown",
          sizeBytes: 42,
          filePath: "/workspace/spec.md",
        },
      ],
      rewindTurnDiff: true,
    });
    await app.stop();
  });

  it("keeps hidden chat context out of the editor and restores it for Edit transport", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const transportContent = [
      "<user-provided-context>",
      "Referenced context",
      "</user-provided-context>",
      "",
      "Original visible prompt",
    ].join("\n");
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      {
        userMessageId: "msg-user-v1-context",
        assistantMessageId: "msg-assistant-v1-context",
        contentHead: "Original visible prompt",
        timestamp: 1_700_000_000_000,
        fileChangeCount: 0,
      },
    ]);
    vi.mocked(runtime.listMessagePage).mockResolvedValue({
      messages: [
        {
          id: "msg-user-v1-context",
          role: "user",
          content: transportContent,
          timestamp: 1_700_000_000_000,
        },
      ],
      hasMore: false,
    });
    vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({ turns: [] });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed edit session");

    await app.submit("/edit");
    await vi.waitFor(() =>
      expect(app.editor.getExpandedText()).toBe("Original visible prompt"),
    );
    expect(app.editor.getExpandedText()).not.toContain("user-provided-context");

    app.editor.setText("Updated visible prompt");
    app.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(runtime.editSessionMessage).toHaveBeenCalledTimes(1),
    );
    expect(runtime.editSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [
          "<user-provided-context>",
          "Referenced context",
          "</user-provided-context>",
          "",
          "Updated visible prompt",
        ].join("\n"),
      }),
    );
    await app.stop();
  });

  it("preserves hidden context and attachments when Edit recovery requires a new message", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const transportContent = [
      "<mavis-chat-context>",
      "Referenced context",
      "</mavis-chat-context>",
      "",
      "Original visible prompt",
    ].join("\n");
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      {
        userMessageId: "msg-user-v1-recovery",
        assistantMessageId: "msg-assistant-v1-recovery",
        contentHead: "Original visible prompt",
        timestamp: 1_700_000_000_000,
        fileChangeCount: 0,
      },
    ]);
    vi.mocked(runtime.listMessagePage).mockResolvedValue({
      messages: [
        {
          id: "msg-user-v1-recovery",
          role: "user",
          content: transportContent,
          attachments: [
            {
              type: "file",
              fileName: "context.md",
              mimeType: "text/markdown",
              sizeBytes: 42,
              assetId: "asset-context-md",
            },
          ],
          timestamp: 1_700_000_000_000,
        },
      ],
      hasMore: false,
    });
    vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({ turns: [] });
    vi.mocked(runtime.editSessionMessage).mockRejectedValueOnce(
      Object.assign(new Error("history already rewound"), {
        key: "EDIT_RESTART_NEEDS_RESUBMIT",
      }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed edit session");
    const sendCountBeforeEdit = vi.mocked(runtime.sendMessage).mock.calls
      .length;

    await app.submit("/edit");
    await vi.waitFor(() =>
      expect(app.editor.getExpandedText()).toBe(
        "Original visible prompt [File #1] ",
      ),
    );

    app.editor.setText("/help should remain message text");
    app.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(runtime.editSessionMessage).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(() =>
      expect(app.editor.getExpandedText()).toBe(
        "/help should remain message text [File #1] ",
      ),
    );
    expect(app.editor.getExpandedText()).not.toContain("mavis-chat-context");
    expect(runtime.sendMessage).toHaveBeenCalledTimes(sendCountBeforeEdit);

    let releaseAdmission!: () => void;
    vi.mocked(runtime.getAccountStatus).mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          releaseAdmission = () =>
            resolve({
              status: "ready",
              defaultModel: "minimax/MiniMax-M2.7",
              providerId: "minimax",
              modelId: "MiniMax-M2.7",
              authMode: "managed-login",
              managedTokenPresent: true,
              warnings: [],
            });
        }),
    );
    app.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().activeTurnId).toBeDefined(),
    );
    terminal.input?.("\u001b");
    releaseAdmission();
    await vi.waitFor(() =>
      expect(app.editor.getExpandedText()).toBe(
        "/help should remain message text [File #1] ",
      ),
    );
    expect(runtime.sendMessage).toHaveBeenCalledTimes(sendCountBeforeEdit);

    app.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(runtime.sendMessage).toHaveBeenCalledTimes(
        sendCountBeforeEdit + 1,
      ),
    );
    expect(vi.mocked(runtime.sendMessage).mock.calls.at(-1)?.[0]).toMatchObject(
      {
        content: [
          "<mavis-chat-context>",
          "Referenced context",
          "</mavis-chat-context>",
          "",
          "/help should remain message text",
        ].join("\n"),
        attachments: [
          {
            meta: {
              attachmentType: "file",
              fileName: "context.md",
              mimeType: "text/markdown",
              sizeBytes: 42,
            },
            local: { assetId: "asset-context-md" },
          },
        ],
      },
    );
    expect(runtime.editSessionMessage).toHaveBeenCalledTimes(1);
    expect(
      app.transcript
        .snapshot()
        .filter((cell) => cell.kind === "user")
        .map((cell) => cell.content)
        .join("\n"),
    ).toContain("/help should remain message text");
    expect(
      app.transcript
        .snapshot()
        .filter((cell) => cell.kind === "user")
        .map((cell) => cell.content)
        .join("\n"),
    ).not.toContain("mavis-chat-context");
    await app.stop();
  });

  it("allows an attachment-only committed message to enter Edit and gain a body", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      {
        userMessageId: "msg-user-v1-attachment-only",
        assistantMessageId: "msg-assistant-v1-attachment-only",
        timestamp: 1_700_000_000_000,
        fileChangeCount: 0,
      },
    ]);
    vi.mocked(runtime.listMessagePage).mockResolvedValue({
      messages: [
        {
          id: "msg-user-v1-attachment-only",
          role: "user",
          content: "",
          attachments: [
            {
              type: "image",
              fileName: "reference.png",
              mimeType: "image/png",
              filePath: "/workspace/reference.png",
            },
          ],
          timestamp: 1_700_000_000_000,
        },
      ],
      hasMore: false,
    });
    vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({ turns: [] });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed edit session");
    const sendCountBeforeEdit = vi.mocked(runtime.sendMessage).mock.calls
      .length;

    await app.submit("/edit");
    await vi.waitFor(() =>
      expect(app.tui.render(100).join("\n")).toContain(
        "Editing the selected message",
      ),
    );
    expect(app.editor.getExpandedText()).toBe("[Image #1] ");
    expect(app.surfaceHost.getActiveSurface()).toEqual({
      kind: "chat",
      id: "chat",
    });

    app.editor.setText("Describe this reference");
    app.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(runtime.editSessionMessage).toHaveBeenCalledTimes(1),
    );
    expect(runtime.editSessionMessage).toHaveBeenCalledWith({
      sessionId: "session-1",
      userMessageId: "msg-user-v1-attachment-only",
      clientRequestId: expect.stringMatching(/^tui-edit_/u),
      content: "Describe this reference",
      attachments: [
        {
          type: "image",
          fileName: "reference.png",
          mimeType: "image/png",
          filePath: "/workspace/reference.png",
        },
      ],
      rewindTurnDiff: true,
    });
    expect(runtime.sendMessage).toHaveBeenCalledTimes(sendCountBeforeEdit);
    await app.stop();
  });

  it("keeps a second composer submission while an edit request is still in flight", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      {
        userMessageId: "msg-user-v1-target",
        assistantMessageId: "msg-assistant-v1-target",
        contentHead: "Original prompt",
        timestamp: 1,
        fileChangeCount: 0,
      },
    ]);
    vi.mocked(runtime.listMessagePage).mockResolvedValue({
      messages: [
        {
          id: "msg-user-v1-target",
          role: "user",
          content: "Original prompt",
          timestamp: 1,
        },
      ],
      hasMore: false,
    });
    vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({ turns: [] });
    let resolveEdit!: (value: {
      rewound: boolean;
      turnId: string;
      userMessageId: string;
    }) => void;
    vi.mocked(runtime.editSessionMessage).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEdit = resolve;
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed edit session");
    const sendCountBeforeEdit = vi.mocked(runtime.sendMessage).mock.calls
      .length;

    await app.submit("/edit");
    await vi.waitFor(() =>
      expect(app.editor.getText()).toBe("Original prompt"),
    );
    app.editor.setText("First edited prompt");
    app.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(runtime.editSessionMessage).toHaveBeenCalledTimes(1),
    );

    app.editor.setText("Keep this until edit settles");
    app.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(app.editor.getText()).toBe("Keep this until edit settles"),
    );
    expect(runtime.sendMessage).toHaveBeenCalledTimes(sendCountBeforeEdit);

    resolveEdit({
      rewound: true,
      turnId: "turn-edit-1",
      userMessageId: "msg-user-v1-edited",
    });
    await app.stop();
  });

  it("preserves the edit and retries the same operation when submission fails after rewind", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      {
        userMessageId: "msg-user-v1-target",
        assistantMessageId: "msg-assistant-v1-target",
        contentHead: "Original prompt",
        timestamp: 1,
        fileChangeCount: 0,
      },
    ]);
    vi.mocked(runtime.listMessagePage).mockResolvedValue({
      messages: [
        {
          id: "msg-user-v1-target",
          role: "user",
          content: "Original prompt",
          timestamp: 1,
        },
      ],
      hasMore: false,
    });
    vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({ turns: [] });
    vi.mocked(runtime.editSessionMessage)
      .mockRejectedValueOnce(
        Object.assign(new Error("submit failed"), {
          key: "EDIT_SUBMIT_FAILED_AFTER_REWIND",
        }),
      )
      .mockResolvedValueOnce({
        rewound: true,
        turnId: "turn-edit-retry",
        userMessageId: "msg-user-v1-edited",
      });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed edit session");

    await app.submit("/edit");
    await vi.waitFor(() =>
      expect(app.editor.getText()).toBe("Original prompt"),
    );
    app.editor.setText("Preserve this edited prompt");
    app.editor.handleInput("\r");

    await vi.waitFor(() =>
      expect(runtime.editSessionMessage).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(() =>
      expect(app.editor.getText()).toBe("Preserve this edited prompt"),
    );
    expect(
      app.transcript
        .snapshot()
        .some((cell) => cell.content.includes("History was rewound")),
    ).toBe(true);

    const firstOperationId = vi.mocked(runtime.editSessionMessage).mock
      .calls[0]?.[0].clientRequestId;
    const sendCount = vi.mocked(runtime.sendMessage).mock.calls.length;
    app.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(runtime.editSessionMessage).toHaveBeenCalledTimes(2),
    );
    expect(runtime.editSessionMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientRequestId: firstOperationId }),
    );
    expect(runtime.sendMessage).toHaveBeenCalledTimes(sendCount);
    await app.stop();
  });

  it.each(['/rewind', '/fork'])(
    'clears the loading hint after %s history loads and stays clear after cancellation',
    async (command) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      let resolveHistory!: (
        value: Awaited<ReturnType<TuiRuntime['listSessionInputSummaries']>>,
      ) => void;
      vi.mocked(runtime.listSessionInputSummaries).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveHistory = resolve;
          }),
      );
      const app = createTuiApp({ runtime, terminal, version: '0.1.0', workspaceDir: '/workspace' });
      app.start();
      try {
        await app.ready;
        await app.submit('Seed session');
        await app.submit(command);
        const loadingChat = stripAnsi(app.tui.render(120).join('\n'));
        expect(loadingChat).toMatch(/Loading|Finding/);
        resolveHistory([{ userMessageId: 'history-user', timestamp: 1, fileChangeCount: 0 }]);
        await vi.waitFor(() =>
          expect(app.surfaceHost.getActiveSurface()).toEqual({
            kind: 'feature',
            id: 'session-mutation:history',
          }),
        );
        expect(stripAnsi(app.tui.render(120).join('\n'))).not.toMatch(
          /Loading (?:rewind|fork) history|Finding messages/,
        );
        terminal.input?.('\x1b');
        expect(app.surfaceHost.getActiveSurface()).toEqual({ kind: 'chat', id: 'chat' });
        expect(stripAnsi(app.tui.render(120).join('\n'))).not.toMatch(
          /Loading (?:rewind|fork) history|Finding messages/,
        );
      } finally {
        await app.stop();
      }
    },
  );

  it("cancels /rewind preview and ignores duplicate scope submission", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      { userMessageId: "msg-user-rewind", timestamp: 1, fileChangeCount: 1 },
    ]);
    vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({
      turns: [
        {
          turnId: "turn-1",
          files: [{ filePath: "a.ts", action: "modified", skipped: false }],
        },
      ],
    });
    let resolveRewind!: (value: { rewound: boolean }) => void;
    vi.mocked(runtime.rewindSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRewind = resolve;
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed rewind session");
    await app.submit("/rewind");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:history",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:rewind-preview",
      }),
    );
    terminal.input?.("\u001b");
    expect(runtime.rewindSession).not.toHaveBeenCalled();

    await app.submit("/rewind");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:history",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:rewind-preview",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:scope",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:rewind-confirm",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.rewindSession).toHaveBeenCalledTimes(1),
    );
    terminal.input?.("\u001b");
    expect(app.surfaceHost.getActiveSurface()).toEqual({
      kind: "feature",
      id: "session-mutation:rewind-confirm",
    });
    resolveRewind({ rewound: true });
    await vi.waitFor(() => expect(app.surfaceHost.getActiveSurface()).toEqual({ kind: 'chat', id: 'chat' }));
    expect(stripAnsi(app.tui.render(120).join('\n'))).toContain('Rewound 1 turn');
    expect(stripAnsi(app.tui.render(120).join('\n'))).not.toMatch(/Loading rewind history|Finding messages/);
    await app.stop();
  });

  it("invalidates /rewind when the active session switches before mutation", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      { userMessageId: "msg-user-rewind", timestamp: 1, fileChangeCount: 0 },
    ]);
    vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({ turns: [] });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed rewind session");
    await app.submit("/rewind");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:history",
      }),
    );
    const other = {
      sessionId: "session-other",
      title: "Other",
      workspaceDir: "/workspace",
    };
    vi.mocked(runtime.getSession).mockResolvedValue(other);
    await app.openSession(other.sessionId);
    terminal.input?.("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.getSessionRewindPreview).not.toHaveBeenCalled();
    expect(runtime.rewindSession).not.toHaveBeenCalled();
    expect(app.controller.snapshot().session?.sessionId).toBe(other.sessionId);
    await app.stop();
  });

  it("retries a failed file rewind with the same operation id", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      { userMessageId: "msg-user-rewind", timestamp: 1, fileChangeCount: 1 },
    ]);
    vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({
      turns: [
        {
          turnId: "turn-1",
          files: [{ filePath: "a.ts", action: "modified", skipped: false }],
        },
      ],
    });
    vi.mocked(runtime.rewindSession)
      .mockRejectedValueOnce(new Error("temporary conflict"))
      .mockResolvedValueOnce({
        rewound: true,
        turnDiffRewind: { status: "rewound", revertedTurnIds: ["turn-1"] },
      });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed rewind session");
    await app.submit("/rewind");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:history",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:rewind-preview",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:scope",
      }),
    );
    terminal.input?.("\u001b[B");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:rewind-confirm",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.rewindSession).toHaveBeenCalledTimes(1),
    );
    expect(app.surfaceHost.getActiveSurface()).toEqual({
      kind: "feature",
      id: "session-mutation:rewind-confirm",
    });
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.rewindSession).toHaveBeenCalledTimes(2),
    );
    const ids = vi
      .mocked(runtime.rewindSession)
      .mock.calls.map(([input]) => input.clientRequestId);
    expect(ids[0]).toBe(ids[1]);
    await app.stop();
  });

  it.each([
    [
      "terminal busy failure",
      "CONVERSATION_MUTATION_BUSY",
      "Stop the running response and try again.",
      false,
    ],
    [
      "pending display publication",
      "REWIND_DISPLAY_COMMIT_FAILED",
      "retry with the same operation id",
      true,
    ],
  ] as const)(
    "keeps a failed conversation rewind open and retries %s with the correct operation id",
    async (_label, errorCode, expectedCopy, reuseOperationId) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
        { userMessageId: "msg-user-rewind", timestamp: 1, fileChangeCount: 0 },
      ]);
      vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({
        turns: [],
      });
      vi.mocked(runtime.rewindSession)
        .mockRejectedValueOnce(
          Object.assign(new Error("rewind failed"), { key: errorCode }),
        )
        .mockResolvedValueOnce({ rewound: true });
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
      });
      app.start();
      await app.ready;
      await app.submit("Seed rewind session");
      await app.submit("/rewind");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:history",
        }),
      );
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:rewind-preview",
        }),
      );
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:scope",
        }),
      );
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:rewind-confirm",
        }),
      );
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(runtime.rewindSession).toHaveBeenCalledTimes(1),
      );
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:rewind-confirm",
      });
      expect(renderTerminalViewport(app, terminal)).toContain(expectedCopy);

      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(runtime.rewindSession).toHaveBeenCalledTimes(2),
      );
      const ids = vi
        .mocked(runtime.rewindSession)
        .mock.calls.map(([input]) => input.clientRequestId);
      if (reuseOperationId) expect(ids[0]).toBe(ids[1]);
      else expect(ids[0]).not.toBe(ids[1]);
      await app.stop();
    },
  );

  it.each([
    [
      "failed-after-rewind",
      {
        status: "failed-after-rewind",
        revertedTurnIds: ["turn-1"],
        errorCode: "conflict",
      },
    ],
    ["empty-reverted-ids", { status: "rewound", revertedTurnIds: [] }],
    [
      "unknown-status",
      { status: "future-runtime-status", revertedTurnIds: ["turn-1"] },
    ],
  ] as const)(
    "does not report %s as a successful file rewind",
    async (_label, turnDiffRewind) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
        { userMessageId: "msg-user-rewind", timestamp: 1, fileChangeCount: 1 },
      ]);
      vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({
        turns: [
          {
            turnId: "turn-1",
            files: [{ filePath: "a.ts", action: "modified", skipped: false }],
          },
        ],
      });
      vi.mocked(runtime.rewindSession).mockResolvedValue({
        rewound: true,
        turnDiffRewind,
      });
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
      });
      app.start();
      await app.ready;
      await app.submit("Seed rewind session");
      await app.submit("/rewind");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:history",
        }),
      );
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:rewind-preview",
        }),
      );
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:scope",
        }),
      );
      terminal.input?.("\u001b[B");
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:rewind-confirm",
        }),
      );
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(runtime.rewindSession).toHaveBeenCalledTimes(1),
      );
      await vi.waitFor(() =>
        expect(app.transcript.snapshot().at(-1)?.content).toMatch(
          /did not complete|No file changes/,
        ),
      );
      expect(app.transcript.snapshot().at(-1)?.content).not.toContain(
        "Files rewound; conversation history was kept.",
      );
      await app.stop();
    },
  );

  it.each([
    [
      "MESSAGE_BOUNDARY_INVALID",
      "This conversation point is no longer available.",
    ],
    [
      "CONVERSATION_MUTATION_REQUEST_CONFLICT",
      "This action was already submitted or became stale.",
    ],
    ["CONVERSATION_MUTATION_BUSY", "Stop the running response and try again."],
  ] as const)(
    "maps rewind Runtime error %s to stable copy",
    async (code, expected) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
        { userMessageId: "msg-user-rewind", timestamp: 1, fileChangeCount: 1 },
      ]);
      vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({
        turns: [
          {
            turnId: "turn-1",
            files: [{ filePath: "a.ts", action: "modified", skipped: false }],
          },
        ],
      });
      vi.mocked(runtime.rewindSession).mockRejectedValue(
        Object.assign(new Error("raw prompt token=secret"), { key: code }),
      );
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
      });
      app.start();
      await app.ready;
      await app.submit("Seed rewind session");
      await app.submit("/rewind");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:history",
        }),
      );
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:rewind-preview",
        }),
      );
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:scope",
        }),
      );
      terminal.input?.("\u001b[B");
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(app.surfaceHost.getActiveSurface()).toEqual({
          kind: "feature",
          id: "session-mutation:rewind-confirm",
        }),
      );
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(
          app.transcript.snapshot().some((cell) => cell.content === expected),
        ),
      );
      expect(
        app.transcript
          .snapshot()
          .some((cell) => cell.content.includes("raw prompt token")),
      ).toBe(false);
      await app.stop();
    },
  );

  it("reports refresh failure without unhandled rejection after conversation-and-files rewind", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      { userMessageId: "msg-user-rewind", timestamp: 1, fileChangeCount: 1 },
    ]);
    vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({
      turns: [
        {
          turnId: "turn-1",
          files: [{ filePath: "a.ts", action: "modified", skipped: false }],
        },
      ],
    });
    vi.mocked(runtime.rewindSession).mockResolvedValue({
      rewound: true,
      turnDiffRewind: { status: "rewound", revertedTurnIds: ["turn-1"] },
    });
    vi.mocked(runtime.getMessages).mockRejectedValueOnce(
      new Error("refresh unavailable"),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed rewind session");
    await app.submit("/rewind");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:history",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:rewind-preview",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:scope",
      }),
    );
    terminal.input?.("\u001b[B");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:rewind-confirm",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(
        app.transcript
          .snapshot()
          .some((cell) => cell.content.includes("could not be refreshed")),
      ),
    );
    await app.stop();
  });

  it("does not apply a pending rewind refresh result after switching sessions", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
      { userMessageId: "msg-user-rewind", timestamp: 1, fileChangeCount: 1 },
    ]);
    vi.mocked(runtime.getSessionRewindPreview).mockResolvedValue({
      turns: [
        {
          turnId: "turn-1",
          files: [{ filePath: "a.ts", action: "modified", skipped: false }],
        },
      ],
    });
    vi.mocked(runtime.rewindSession).mockResolvedValue({
      rewound: true,
      turnDiffRewind: { status: "rewound", revertedTurnIds: ["turn-1"] },
    });
    let resolveRefresh!: (messages: readonly TuiMessage[]) => void;
    const refreshPromise = new Promise<readonly TuiMessage[]>((resolve) => {
      resolveRefresh = resolve;
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("Seed rewind session");
    vi.mocked(runtime.getMessages).mockImplementationOnce(() => refreshPromise);
    await app.submit("/rewind");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:history",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:rewind-preview",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:scope",
      }),
    );
    terminal.input?.("\u001b[B");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.surfaceHost.getActiveSurface()).toEqual({
        kind: "feature",
        id: "session-mutation:rewind-confirm",
      }),
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.rewindSession).toHaveBeenCalledTimes(1),
    );
    const other = {
      sessionId: "session-other",
      title: "Other",
      workspaceDir: "/workspace",
    };
    vi.mocked(runtime.getSession).mockResolvedValue(other);
    vi.mocked(runtime.getMessages).mockResolvedValue([]);
    const open = app.openSession(other.sessionId);
    resolveRefresh([
      {
        id: "stale-message",
        role: "assistant",
        content: "stale",
        timestamp: 3,
      },
    ]);
    await open;
    expect(app.controller.snapshot().session?.sessionId).toBe(other.sessionId);
    expect(
      app.transcript
        .snapshot()
        .some((cell) => cell.content.includes("Files rewound")),
    ).toBe(false);
    await app.stop();
  });

  it("redirects a hidden task child to its parent before rendering", async () => {
    const runtime = createRuntime();
    const parent = {
      sessionId: "session-parent",
      title: "CLI integration",
      workspaceDir: "/workspace",
    };
    const child = {
      sessionId: "session-child",
      parentSessionId: parent.sessionId,
      title: "Review recent CLI changes",
      workspaceDir: "/workspace",
      sessionType: "branch",
      sessionKind: "task",
      visibility: "hidden",
      purpose: "local-task:turn-1:tool-1",
      agentName: "verifier",
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([parent]);
    vi.mocked(runtime.getSession).mockImplementation(async (sessionId) =>
      sessionId === child.sessionId ? child : parent,
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.openSession(child.sessionId);
    expect(runtime.getSession).toHaveBeenLastCalledWith(parent.sessionId);
    expect(app.controller.snapshot().session?.sessionId).toBe(parent.sessionId);
    expect(app.tui.render(140).join("\n")).not.toContain("Sub: verifier");
    expect(app.transcript.snapshot().at(-1)?.content).toBe(
      "Sub-agent Sessions are internal. Opened the parent Session instead.",
    );
    await app.stop();
  });

  it("shows compact Agent Team status without exposing child details or commands", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 24;
    const runtime = createRuntime();
    const parent = {
      sessionId: "session-parent",
      title: "Agent Team parent",
      workspaceDir: "/workspace",
    };
    const child = {
      sessionId: "session-child",
      parentSessionId: parent.sessionId,
      title: "Verify the TUI",
      workspaceDir: "/workspace",
      sessionType: "branch" as const,
      sessionKind: "task",
      visibility: "hidden" as const,
      purpose: "local-task:turn-1:tool-1",
      agentName: "verifier",
      status: "finished",
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([parent]);
    vi.mocked(runtime.getSession).mockImplementation(async (sessionId) =>
      sessionId === child.sessionId ? child : parent,
    );
    vi.mocked(runtime.getDelegationSnapshot).mockResolvedValue({
      schemaVersion: 1,
      rootSessionId: parent.sessionId,
      members: [
        {
          sessionId: child.sessionId,
          parentSessionId: parent.sessionId,
          agentName: child.agentName,
          task: child.title,
          status: "running",
          createdAtMs: 100,
          updatedAtMs: 200,
        },
      ],
    });
    vi.mocked(runtime.getMessages).mockImplementation(async (sessionId) =>
      sessionId === child.sessionId
        ? [
            {
              id: "child-answer",
              turnId: "turn-child",
              role: "assistant",
              content: "Child verification result",
              timestamp: 200,
            },
          ]
        : [],
    );
    vi.mocked(runtime.getActiveRun).mockImplementation(async (sessionId) => ({
      schemaVersion: 1,
      sessionId,
      state: sessionId === child.sessionId ? "running" : "idle",
      ...(sessionId === child.sessionId ? { turnId: "turn-child" } : {}),
      actions: { steer: false },
    }));
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.openSession(parent.sessionId);
    app.start();

    const summary = app.tui.render(100).join("\n");
    expect(summary).toContain("Tasks · 1 agent active · /tasks details");
    expect(summary).not.toContain("verifier");
    expect(summary).not.toContain("/agents");
    expect(
      app.transcript.snapshot().some((cell) => cell.kind === "agent-team"),
    ).toBe(false);

    await app.submit("/agents");
    await app.submit("/team");

    expect(app.controller.snapshot().session?.sessionId).toBe(parent.sessionId);
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(false);
    expect(app.tui.render(100).join("\n")).not.toContain(
      "Child verification result",
    );
    expect(
      vi
        .mocked(runtime.sendMessage)
        .mock.calls.map(([request]) => request.content),
    ).toEqual(["/agents", "/team"]);
    await app.stop();
  });

  it("allocates enough standard-terminal space for ten session choices", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 24;
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionPage).mockResolvedValue({
      sessions: Array.from({ length: 12 }, (_, index) => ({
        sessionId: `session-${String(index + 1).padStart(2, "0")}`,
        title: `Session ${String(index + 1).padStart(2, "0")}`,
        workspaceDir: "/workspace",
        updatedAt: 12 - index,
      })),
      hasMore: false,
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.submit("/sessions");
    const lines = app.interaction.current()?.render(80) ?? [];
    const rendered = lines.join("\n");

    expect(lines.length).toBeLessThanOrEqual(terminal.rows);
    expect(rendered).toContain("Session 10");
    expect(rendered).not.toContain("Session 11");
  });

  it("switches, restores, and resumes archived Desktop sessions from the session manager", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let archived = true;
    const activeSession = {
      sessionId: "session-active",
      title: "Active session",
      workspaceDir: "/workspace",
      updatedAt: 200,
    };
    const archivedSession = {
      sessionId: "session-archived",
      title: "Archived session",
      workspaceDir: "/workspace",
      updatedAt: 100,
      archived: true,
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([activeSession]);
    vi.mocked(runtime.listSessionPage).mockResolvedValue({
      sessions: [activeSession, archivedSession],
      hasMore: false,
    });
    vi.mocked(runtime.getSession).mockImplementation(async (sessionId) => ({
      ...(sessionId === archivedSession.sessionId
        ? archivedSession
        : activeSession),
      archived: sessionId === archivedSession.sessionId ? archived : false,
    }));
    vi.mocked(runtime.archiveSession).mockImplementation(
      async (_sessionId, value) => {
        archived = value;
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/sessions");
    expect(runtime.listSessionPage).toHaveBeenCalledWith({
      allAgents: true,
      workspaceDir: "/workspace",
      limit: 50,
      includeArchived: true,
      includeHidden: true,
    });
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);

    terminal.input?.("\t");
    terminal.input?.("\r");

    await vi.waitFor(() =>
      expect(runtime.archiveSession).toHaveBeenCalledWith(
        "session-archived",
        false,
      ),
    );
    await vi.waitFor(() =>
      expect(runtime.getMessages).toHaveBeenCalledWith("session-archived"),
    );
    expect(app.getSurface()).toBe("conversation");
    expect(app.controller.snapshot().session?.sessionId).toBe(
      "session-archived",
    );
    expect(app.tui.hasOverlay()).toBe(false);

    await app.stop();
  });

  it("uses the resume alias to search every Desktop session page", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionPage)
      .mockResolvedValueOnce({
        sessions: [
          {
            sessionId: "session-page-1",
            title: "First page",
            workspaceDir: "/workspace",
            updatedAt: 200,
          },
        ],
        hasMore: true,
        nextCursor: "session-page-1",
      })
      .mockResolvedValueOnce({
        sessions: [
          {
            sessionId: "session-page-2",
            title: "Second page",
            workspaceDir: "/workspace",
            updatedAt: 100,
          },
        ],
        hasMore: false,
      });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/resume Second page");

    await vi.waitFor(() =>
      expect(runtime.listSessionPage).toHaveBeenNthCalledWith(2, {
        allAgents: true,
        workspaceDir: "/workspace",
        limit: 50,
        cursor: "session-page-1",
        includeArchived: true,
        includeHidden: true,
      }),
    );
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);
    expect(app.interaction.current()?.render(100).join("\n")).toContain(
      "Second page",
    );

    await app.stop();
  });

  it("queries the current workspace first and reloads the global catalog on Ctrl+A", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessionPage).mockImplementation(
      async (input = {}) => {
        if (input.cursor === "all-page-2") {
          return {
            sessions: [
              {
                sessionId: "session-other-older",
                title: "Older session elsewhere",
                workspaceDir: "/other-workspace",
                updatedAt: 50,
              },
            ],
            hasMore: false,
          };
        }
        return input.workspaceDir
          ? {
              sessions: [
                {
                  sessionId: "session-workspace-old",
                  title: "Older workspace session",
                  workspaceDir: "/workspace",
                  updatedAt: 100,
                },
              ],
              hasMore: false,
            }
          : {
              sessions: [
                {
                  sessionId: "session-other-new",
                  title: "Newer session elsewhere",
                  workspaceDir: "/other-workspace",
                  updatedAt: 200,
                },
                {
                  sessionId: "session-workspace-old",
                  title: "Older workspace session",
                  workspaceDir: "/workspace",
                  updatedAt: 100,
                },
              ],
              hasMore: true,
              nextCursor: "all-page-2",
            };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/sessions");

    expect(runtime.listSessionPage).toHaveBeenNthCalledWith(1, {
      allAgents: true,
      workspaceDir: "/workspace",
      limit: 50,
      includeArchived: true,
      includeHidden: true,
    });
    expect(app.interaction.current()?.render(100).join("\n")).toContain(
      "Older workspace session",
    );

    terminal.input?.("\x01");

    await vi.waitFor(() =>
      expect(runtime.listSessionPage).toHaveBeenNthCalledWith(2, {
        allAgents: true,
        limit: 50,
        includeArchived: true,
        includeHidden: true,
      }),
    );
    await vi.waitFor(() =>
      expect(app.interaction.current()?.render(100).join("\n")).toContain(
        "Newer session elsewhere",
      ),
    );
    expect(app.interaction.current()?.render(100).join("\n")).toContain(
      "All sessions",
    );

    terminal.input?.("\x0c");

    await vi.waitFor(() =>
      expect(runtime.listSessionPage).toHaveBeenNthCalledWith(3, {
        allAgents: true,
        limit: 50,
        cursor: "all-page-2",
        includeArchived: true,
        includeHidden: true,
      }),
    );
    await vi.waitFor(() =>
      expect(app.interaction.current()?.render(100).join("\n")).toContain(
        "Older session elsewhere",
      ),
    );

    await app.stop();
  });

  it("shows account status and resolves pending permission and questionnaire decisions", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-existing",
        title: "Existing session",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.listPendingPermissions).mockResolvedValue([
      {
        requestId: "permission-1",
        sessionId: "session-existing",
        agentName: "mavis",
        toolName: "bash",
        reason: "Run tests",
        allowAlwaysSupported: true,
      },
    ]);
    vi.mocked(runtime.getPendingQuestionnaire).mockResolvedValue({
      id: "question-1",
      title: "Choose",
      steps: [
        {
          id: "step-1",
          question: "Proceed?",
          selectionMode: "single",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
      ],
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    await app.ready;
    await app.submit("/resume session-existing");
    expect(app.transcript.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "permission", status: "blocked" }),
        expect.objectContaining({ kind: "question", status: "blocked" }),
      ]),
    );
    expect(app.transcript.get("permission:permission-1")).toMatchObject({
      title: "bash",
      content: "Run tests",
    });
    expect(
      app.transcript.get("permission:permission-1")?.content,
    ).not.toContain("decision panel");
    expect(app.transcript.get("permission:permission-1")?.content).not.toMatch(
      /\/(?:allow|always|deny)\b/u,
    );
    expect(app.transcript.get("question:question-1")?.content).toBe("");

    await app.submit("/q1 1");
    expect(runtime.replyQuestionnaire).not.toHaveBeenCalled();
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);
    expect(terminal.mouseTracking).toBe(false);

    await app.submit("/allow");
    await app.submit("/q1 1");
    await app.submit("/status");

    expect(runtime.replyPermission).toHaveBeenCalledWith(
      "mavis",
      "permission-1",
      "allowOnce",
    );
    expect(runtime.replyQuestionnaire).toHaveBeenCalledWith(
      "mavis",
      "question-1",
      [
        {
          stepId: "step-1",
          selectedOptionIds: ["yes"],
          selectedOther: false,
        },
      ],
    );
    expect(terminal.mouseTracking).toBe(false);
    expect(app.transcript.get("question:question-1")).toMatchObject({
      status: "resolved",
      title: "Answers sent",
      content: "Proceed?  Yes",
    });
    expect(app.interaction.current()).toBeDefined();
    expect(app.tui.render(80).join("\n")).toContain("MCode status");
    expect(app.transcript.snapshot()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "inspection",
          inspection: expect.objectContaining({
            visualization: { kind: "status" },
          }),
        }),
      ]),
    );
  });

  it("does not let a stale permission response hide a newer decision surface", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-race",
        title: "Decision race",
        workspaceDir: "/workspace",
      },
    ]);
    const firstPermission = {
      requestId: "permission-first",
      sessionId: "session-race",
      agentName: "mavis",
      toolName: "bash",
      reason: "First request",
      allowAlwaysSupported: true,
    };
    const secondPermission = {
      requestId: "permission-second",
      sessionId: "session-race",
      agentName: "mavis",
      toolName: "write_file",
      reason: "Newer request",
      allowAlwaysSupported: false,
    };
    vi.mocked(runtime.listPendingPermissions).mockResolvedValue([
      firstPermission,
    ]);

    let finishReply: ((value: boolean) => void) | undefined;
    vi.mocked(runtime.replyPermission).mockImplementation(
      async () =>
        await new Promise<boolean>((resolve) => {
          finishReply = resolve;
        }),
    );

    let emitEvent: ((event: TuiRuntimeEvent) => void) | undefined;
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        const event = await new Promise<TuiRuntimeEvent | undefined>(
          (resolve) => {
            emitEvent = resolve;
            signal.addEventListener("abort", () => resolve(undefined), {
              once: true,
            });
          },
        );
        if (event) yield event;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
      },
    );

    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/resume session-race");
    const resolving = app.submit("/allow");
    await vi.waitFor(() => expect(runtime.replyPermission).toHaveBeenCalled());
    await vi.waitFor(() => expect(emitEvent).toBeTypeOf("function"));

    emitEvent?.(
      runtimeEvent({
        type: "permission.ask",
        timestamp: Date.now(),
        source: "test",
        payload: secondPermission,
      }),
    );
    await vi.waitFor(() =>
      expect(app.tui.render(80).join("\n")).toContain("Newer request"),
    );

    finishReply?.(true);
    await resolving;

    const rendered = app.tui.render(80).join("\n");
    expect(rendered).toContain("Write file");
    expect(rendered).toContain("Newer request");
    expect(runtime.replyPermission).toHaveBeenCalledTimes(1);
    await app.stop();
  });

  it("closes a permission that another surface resolved before the reply arrived", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const permission = {
      requestId: "permission-stale",
      sessionId: "session-permission-stale",
      agentName: "mavis",
      toolName: "bash",
      reason: "Run tests",
      allowAlwaysSupported: true,
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-permission-stale",
        title: "Permission race",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.listPendingPermissions)
      .mockResolvedValueOnce([permission])
      .mockResolvedValue([]);
    vi.mocked(runtime.replyPermission).mockResolvedValue(false);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.submit("/resume session-permission-stale");
    await app.submit("/allow");

    expect(app.transcript.get("permission:permission-stale")).toMatchObject({
      status: "resolved",
      detail: "Resolved on another surface.",
    });
    expect(app.interaction.isActive()).toBe(false);
  });

  it("keeps an option-only questionnaire pending after an invalid slash answer", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-questionnaire",
        title: "Questionnaire session",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.getPendingQuestionnaire).mockResolvedValue({
      id: "question-options-only",
      title: "Choose",
      steps: [
        {
          id: "channel",
          question: "Choose a release channel",
          selectionMode: "single",
          options: [
            { id: "preview", label: "Preview" },
            { id: "stable", label: "Stable" },
          ],
          allowOther: false,
        },
      ],
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.submit("/resume session-questionnaire");
    await app.submit("/q1 nightly");

    expect(runtime.replyQuestionnaire).not.toHaveBeenCalled();
    expect(app.transcript.get("question:question-options-only")).toMatchObject({
      status: "blocked",
    });
    expect(app.transcript.snapshot().at(-1)).toMatchObject({
      kind: "warning",
      content:
        "/q1 accepts only listed options. Use an option number, ID, or label.",
    });

    await app.submit("/q1 1");
    expect(runtime.replyQuestionnaire).toHaveBeenCalledWith(
      "mavis",
      "question-options-only",
      [
        {
          stepId: "channel",
          selectedOptionIds: ["preview"],
          selectedOther: false,
        },
      ],
    );
  });

  it("shows the first AskUser answer immediately while later questions remain pending", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-multi-question",
        title: "Multi question",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.getPendingQuestionnaire).mockResolvedValue({
      id: "question-multi-step",
      title: "Preferences",
      steps: [
        {
          id: "animal",
          question: "Favorite animal?",
          selectionMode: "single",
          options: [
            { id: "cat", label: "Cat" },
            { id: "dog", label: "Dog" },
          ],
        },
        {
          id: "color",
          question: "Favorite color?",
          selectionMode: "single",
          options: [
            { id: "blue", label: "Blue" },
            { id: "green", label: "Green" },
          ],
        },
      ],
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    app.start();
    await app.submit("/resume session-multi-question");
    const picker = app.interaction.current();
    expect(picker).toBeDefined();

    terminal.input?.("1");

    expect(runtime.replyQuestionnaire).not.toHaveBeenCalled();
    expect(app.interaction.current()).toBe(picker);
    expect(app.transcript.get("question:question-multi-step")).toMatchObject({
      status: "blocked",
      content: "Favorite animal?  Cat",
      detail: "1 of 2 answered",
    });
    const rendered = app.tui.render(80).join("\n");
    expect(rendered).toContain("Answers so far");
    expect(rendered).toContain("Favorite animal?  Cat");
    expect(rendered).toContain("Favorite color?");

    terminal.input?.("\u001B[B");
    expect(app.tui.render(80).join("\n")).toContain("› 2  Green");
    terminal.input?.("\r");

    await vi.waitFor(() => {
      expect(runtime.replyQuestionnaire).toHaveBeenCalledWith(
        "mavis",
        "question-multi-step",
        [
          {
            stepId: "animal",
            selectedOptionIds: ["cat"],
            selectedOther: false,
          },
          {
            stepId: "color",
            selectedOptionIds: ["green"],
            selectedOther: false,
          },
        ],
      );
    });
    await app.stop();
  });

  it("sends the selected answer immediately and refreshes the Agent continuation", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-review",
        title: "Questionnaire review",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.getPendingQuestionnaire).mockResolvedValue({
      id: "question-review",
      title: "Release setup",
      steps: [
        {
          id: "channel",
          question: "Choose a channel",
          selectionMode: "single",
          options: [
            { id: "preview", label: "Preview" },
            { id: "stable", label: "Stable" },
          ],
        },
      ],
    });
    const previousMessages = [
      {
        id: "previous-question-answer",
        role: "user" as const,
        content: [
          "<questionnaire-response>",
          "  <requestId>question-previous</requestId>",
          "  <answers />",
          "</questionnaire-response>",
          "",
          "Q: Choose a channel",
          "A: Preview",
        ].join("\n"),
      },
    ];
    vi.mocked(runtime.getMessages).mockResolvedValue(previousMessages);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    let releaseReply: ((result: boolean) => void) | undefined;
    let releaseContinuation: (() => void) | undefined;
    vi.mocked(runtime.replyQuestionnaire).mockImplementation(
      async () =>
        await new Promise<boolean>((resolve) => {
          releaseReply = resolve;
        }),
    );
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        await new Promise<void>((resolve) => {
          releaseContinuation = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
        if (signal.aborted) return;
        yield runtimeEvent({
          type: "session.start",
          timestamp: Date.now(),
          source: "runtime",
          payload: {
            sessionId: "session-review",
            turnId: "turn-questionnaire-continuation",
          },
        });
        yield runtimeEvent({
          type: "session.finish",
          timestamp: Date.now(),
          source: "runtime",
          payload: {
            sessionId: "session-review",
            turnId: "turn-questionnaire-continuation",
          },
        });
      },
    );

    app.start();
    await app.ready;
    await app.submit("/resume session-review");
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);

    terminal.input?.("2");
    await vi.waitFor(() =>
      expect(runtime.replyQuestionnaire).toHaveBeenCalledWith(
        "mavis",
        "question-review",
        [
          {
            stepId: "channel",
            selectedOptionIds: ["stable"],
            selectedOther: false,
          },
        ],
      ),
    );
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.transcript.get("question:question-review")).toMatchObject({
      status: "pending",
      detail: "Sending your answer…",
    });

    releaseReply?.(true);
    await vi.waitFor(() =>
      expect(app.transcript.get("question:question-review")).toMatchObject({
        status: "resolved",
        detail: "Answer sent · MCode is continuing…",
      }),
    );

    vi.mocked(runtime.getMessages).mockResolvedValue([
      ...previousMessages,
      {
        id: "assistant-after-question",
        role: "assistant",
        content: "Agent continued after your answer.",
      },
    ]);
    releaseContinuation?.();
    await vi.waitFor(() =>
      expect(
        app.transcript
          .snapshot()
          .map((cell) => cell.content)
          .join("\n"),
      ).toContain("Agent continued after your answer."),
    );
    expect(app.transcript.get("question:question-review")).toMatchObject({
      kind: "question",
      status: "resolved",
      title: "Answers sent",
      content: "Choose a channel  Stable",
      detail: undefined,
    });
    expect(
      app.transcript
        .snapshot()
        .filter((cell) => cell.kind === "question")
        .map((cell) => cell.content),
    ).toEqual(["Choose a channel  Preview", "Choose a channel  Stable"]);
    expect(app.tui.render(80).join("\n")).not.toContain("Thinking · Message");
    expect(app.tui.render(80).join("\n")).not.toContain("Esc to interrupt");
    await app.stop();
  });

  it("redraws after a delayed questionnaire reply resolves", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-delayed-reply",
        title: "Delayed questionnaire reply",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.getPendingQuestionnaire).mockResolvedValue({
      id: "question-delayed-reply",
      steps: [
        {
          id: "channel",
          question: "Choose a channel",
          selectionMode: "single",
          options: [{ id: "preview", label: "Preview" }],
        },
      ],
    });
    let finishReply: ((result: boolean) => void) | undefined;
    vi.mocked(runtime.replyQuestionnaire).mockImplementation(
      async () =>
        await new Promise<boolean>((resolve) => {
          finishReply = resolve;
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("/resume session-delayed-reply");
    terminal.input?.("1");
    await vi.waitFor(() =>
      expect(runtime.replyQuestionnaire).toHaveBeenCalledTimes(1),
    );
    expect(app.tui.hasOverlay()).toBe(false);

    const writesBeforeResolution = terminal.writes.length;
    finishReply?.(true);
    await vi.waitFor(() =>
      expect(
        app.transcript.get("question:question-delayed-reply"),
      ).toMatchObject({
        status: "resolved",
        detail: "Answer sent · MCode is continuing…",
      }),
    );
    await vi.waitFor(() =>
      expect(terminal.writes.length).toBeGreaterThan(writesBeforeResolution),
    );

    await app.stop();
  });

  it("keeps the questionnaire interactive when the Runtime cannot start its continuation", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-retry-questionnaire",
        title: "Retry questionnaire",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.getPendingQuestionnaire).mockResolvedValue({
      id: "question-retry",
      title: "Choose a channel",
      steps: [
        {
          id: "channel",
          question: "Choose a channel",
          selectionMode: "single",
          options: [{ id: "preview", label: "Preview" }],
        },
      ],
    });
    vi.mocked(runtime.replyQuestionnaire).mockRejectedValue(
      new Error(
        "Questionnaire answer was saved, but the continuation could not start.",
      ),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    app.start();
    await app.ready;
    await app.submit("/resume session-retry-questionnaire");
    terminal.input?.("1");

    await vi.waitFor(() =>
      expect(app.transcript.get("question:question-retry")).toMatchObject({
        status: "blocked",
        title: "Choose a channel",
        detail: "Answer could not be sent · retry",
      }),
    );
    expect(app.interaction.isActive()).toBe(true);
    expect(app.transcript.snapshot().at(-1)).toMatchObject({
      kind: "error",
      content:
        "Couldn't send your answers: Questionnaire answer was saved, but the continuation could not start. Retry. The question remains open.",
    });
    await app.stop();
  });

  it("redraws after a delayed questionnaire dismissal resolves", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-delayed-dismiss",
        title: "Delayed questionnaire dismissal",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.getPendingQuestionnaire).mockResolvedValue({
      id: "question-delayed-dismiss",
      steps: [{ id: "confirmation", question: "Continue?" }],
    });
    let finishDismiss: ((result: boolean) => void) | undefined;
    vi.mocked(runtime.dismissQuestionnaire).mockImplementation(
      async () =>
        await new Promise<boolean>((resolve) => {
          finishDismiss = resolve;
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });
    app.start();
    await app.ready;
    await app.submit("/resume session-delayed-dismiss");
    const dismissing = app.submit("/ask-cancel");
    await vi.waitFor(() =>
      expect(runtime.dismissQuestionnaire).toHaveBeenCalledTimes(1),
    );

    const writesBeforeResolution = terminal.writes.length;
    finishDismiss?.(true);
    await dismissing;
    expect(
      app.transcript.get("question:question-delayed-dismiss"),
    ).toMatchObject({
      status: "resolved",
      title: "Question dismissed",
      content: "",
      detail: undefined,
    });
    await vi.waitFor(() =>
      expect(terminal.writes.length).toBeGreaterThan(writesBeforeResolution),
    );
    await app.stop();
  });

  it.each([
    { keyName: "Escape", input: "\x1b" },
    { keyName: "Ctrl-C", input: "\x03" },
  ])(
    "keeps AskUser focused while $keyName dismisses the pending questionnaire",
    async ({ input }) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      vi.mocked(runtime.listSessions).mockResolvedValue([
        {
          sessionId: "session-escape-dismiss",
          title: "Escape questionnaire dismissal",
          workspaceDir: "/workspace",
        },
      ]);
      vi.mocked(runtime.getPendingQuestionnaire).mockResolvedValue({
        id: "question-escape-dismiss",
        steps: [
          {
            id: "channel",
            question: "Choose a channel",
            selectionMode: "single",
            options: [{ id: "preview", label: "Preview" }],
          },
        ],
      });
      let finishDismiss: ((result: boolean) => void) | undefined;
      vi.mocked(runtime.dismissQuestionnaire).mockImplementation(
        async () =>
          await new Promise<boolean>((resolve) => {
            finishDismiss = resolve;
          }),
      );
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
      });

      app.start();
      await app.ready;
      await app.submit("/resume session-escape-dismiss");
      terminal.input?.(input);
      if (input === "\x1b") {
        expect(app.interaction.current()?.render(80).join("\n")).toContain(
          "Cancel this question?",
        );
        terminal.input?.("\r");
      }

      await vi.waitFor(() =>
        expect(runtime.dismissQuestionnaire).toHaveBeenCalledWith(
          "mavis",
          "question-escape-dismiss",
        ),
      );
      expect(app.interaction.isActive()).toBe(true);
      expect(app.interaction.current()?.render(80).join("\n")).toContain(
        "Closing question",
      );
      expect(
        app.state.snapshot().sessions.get("session-escape-dismiss")?.attention
          .question,
      ).toBe(true);

      finishDismiss?.(true);
      await vi.waitFor(() => expect(app.interaction.isActive()).toBe(false));
      expect(
        app.transcript.get("question:question-escape-dismiss"),
      ).toMatchObject({
        status: "resolved",
        title: "Question dismissed",
      });
      expect(
        app.state.snapshot().sessions.get("session-escape-dismiss")?.attention
          .question,
      ).toBe(false);
      expect(app.tui.render(80).join("\n")).not.toContain("Reply required");
      await app.stop();
    },
  );

  it("denies a pending permission explicitly and releases the blocked interaction", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-pending",
        title: "Pending permission",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.listPendingPermissions).mockResolvedValue([
      {
        requestId: "permission-pending",
        sessionId: "session-pending",
        agentName: "mavis",
        toolName: "bash",
        toolInput: "pnpm test",
        ruleContents: ["Bash(pnpm test:*)"],
        allowAlwaysSupported: true,
      },
    ]);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/resume session-pending");
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);

    terminal.input?.("3");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.replyPermission).toHaveBeenCalledWith(
        "mavis",
        "permission-pending",
        "deny",
      ),
    );
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(false);
    expect(app.transcript.get("permission:permission-pending")).toMatchObject({
      status: "resolved",
      detail: "Denied · bash",
    });
    expect(app.tui.render(80).join("\n")).not.toContain("Approval required");
    await app.stop();
  });

  it("resolves a regular inline permission without clearing the terminal viewport", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 8;
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-permission-render",
        title: "Permission render",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.listPendingPermissions).mockResolvedValue([
      {
        requestId: "permission-render",
        sessionId: "session-permission-render",
        agentName: "mavis",
        toolName: "bash",
        toolInput: "pnpm test",
        reason: "Run focused tests",
        allowAlwaysSupported: true,
      },
    ]);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.2.6",
      workspaceDir: "/workspace",
      tuiMode: "regular",
    });

    app.start();
    await app.ready;
    await app.submit("/resume session-permission-render");
    await vi.waitFor(() => expect(app.interaction.isActive()).toBe(true));
    app.tui.renderNow();
    terminal.writes.length = 0;

    terminal.input?.("\r");

    await vi.waitFor(() => expect(app.interaction.isActive()).toBe(false));
    await vi.waitFor(() => expect(terminal.writes.length).toBeGreaterThan(0));
    expect(runtime.replyPermission).toHaveBeenCalledWith(
      "mavis",
      "permission-render",
      "allowOnce",
    );
    expect(app.transcript.get("permission:permission-render")).toMatchObject({
      status: "resolved",
      detail: "Allowed for this conversation · bash",
    });
    expect(terminal.writes.join("")).not.toContain("\x1b[2J");
    expect(terminal.writes.join("")).not.toContain("\x1b[3J");
    await app.stop();
  });

  it("keeps a submission retryable when a pending decision blocks admission", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-draft-blocked",
        title: "Pending decision",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.listPendingPermissions).mockResolvedValue([
      {
        requestId: "permission-draft-blocked",
        sessionId: "session-draft-blocked",
        agentName: "mavis",
        toolName: "bash",
        allowAlwaysSupported: true,
      },
    ]);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/resume session-draft-blocked");

    app.editor.setText("Keep this draft for later");
    app.editor.handleInput("\r");
    await vi.waitFor(() => expect(app.editor.getText()).toBe(""));

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(app.tui.render(80).join("\n")).toContain("Approval required");
    expect(app.tui.render(80).join("\n")).not.toContain("Message · Enter");
    await app.stop();
  });

  it("keeps a pending questionnaire when Runtime rejects dismissal", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-existing",
        title: "Existing session",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.getPendingQuestionnaire).mockResolvedValue({
      id: "question-rejected",
      steps: [{ id: "step-1", question: "Proceed?" }],
    });
    vi.mocked(runtime.dismissQuestionnaire).mockResolvedValue(false);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.submit("/resume session-existing");
    await app.submit("/ask-cancel");

    expect(app.transcript.get("question:question-rejected")).toMatchObject({
      status: "blocked",
    });
    expect(app.transcript.snapshot().at(-1)).toMatchObject({
      kind: "error",
      content: "Couldn't dismiss this question. It remains open; retry.",
    });
  });

  it("restores the questionnaire panel when an Escape dismissal request fails", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-dismiss-retry",
        title: "Dismiss retry",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.getPendingQuestionnaire).mockResolvedValue({
      id: "question-dismiss-retry",
      steps: [
        {
          id: "step-1",
          question: "Proceed?",
          selectionMode: "single",
          options: [{ id: "yes", label: "Yes" }],
        },
      ],
    });
    vi.mocked(runtime.dismissQuestionnaire).mockRejectedValue(
      new Error("connection lost"),
    );
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.submit("/resume session-dismiss-retry");
    app.interaction.current()?.handleInput("\u001b");
    app.interaction.current()?.handleInput("\r");

    await vi.waitFor(() =>
      expect(runtime.dismissQuestionnaire).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() => {
      const panel = app.interaction.current();
      expect(panel).toBeDefined();
      expect(panel?.render(80).join("\n")).toContain("Ask");
    });
    expect(app.transcript.get("question:question-dismiss-retry")).toMatchObject(
      {
        status: "blocked",
      },
    );
  });

  it("settles a questionnaire dismissal that already reached a terminal Runtime state", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-terminal-dismiss",
        title: "Terminal dismissal",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.getPendingQuestionnaire).mockResolvedValue({
      id: "question-terminal-dismiss",
      steps: [{ id: "step-1", question: "Proceed?" }],
    });
    vi.mocked(runtime.dismissQuestionnaire).mockRejectedValue(
      Object.assign(new Error("already superseded"), {
        status: 410,
        code: "QUESTIONNAIRE_NOT_PENDING",
      }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.submit("/resume session-terminal-dismiss");
    await app.submit("/ask-cancel");

    expect(
      app.transcript.get("question:question-terminal-dismiss"),
    ).toMatchObject({
      status: "resolved",
      title: "Question closed",
      detail: "Question is no longer pending.",
    });
    expect(app.interaction.isActive()).toBe(false);
  });

  it("projects live Desktop permission events into the transcript", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents() {
        yield runtimeEvent({
          type: "permission.ask",
          timestamp: 100,
          source: "runtime",
          payload: {
            requestId: "permission-live",
            sessionId: "session-1",
            agentName: "mavis",
            toolName: "bash",
            toolDescription: "Run a shell command",
            reason: "Run checks",
            ruleContents: ["Bash(pnpm test:*)"],
            allowAlwaysSupported: true,
          },
        });
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.submit("Start the current session");
    await app.submit("/transcript");
    expect(app.surfaceHost.getActiveSurface()).toEqual({
      kind: "feature",
      id: "transcript",
    });
    app.start();
    await vi.waitFor(() =>
      expect(app.transcript.get("permission:permission-live")).toMatchObject({
        kind: "permission",
        status: "blocked",
        content: expect.stringContaining("Run checks"),
      }),
    );
    expect(app.transcript.get("permission:permission-live")).toMatchObject({
      title: "bash",
      content: "Run checks",
    });
    expect(
      app.transcript.get("permission:permission-live")?.content,
    ).not.toContain("Rules:");
    expect(app.surfaceHost.getActiveSurface()).toEqual({
      kind: "chat",
      id: "chat",
    });

    await app.submit("/allow");
    expect(app.surfaceHost.getActiveSurface()).toEqual({
      kind: "feature",
      id: "transcript",
    });

    await app.stop();
  });

  it("ignores Desktop interaction events until their session is active", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let resolveEventsDelivered: (() => void) | undefined;
    const eventsDelivered = new Promise<void>((resolve) => {
      resolveEventsDelivered = resolve;
    });
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        yield runtimeEvent({
          type: "permission.ask",
          timestamp: 100,
          source: "runtime",
          payload: {
            requestId: "permission-other-session",
            sessionId: "session-other",
            agentName: "mavis",
            toolName: "bash",
          },
        });
        yield runtimeEvent({
          type: "questionnaire.ask",
          timestamp: 101,
          source: "runtime",
          payload: {
            sessionId: "session-other",
            agentName: "mavis",
            request: {
              id: "question-other-session",
              steps: [
                { id: "step-1", question: "Proceed?", selectionMode: "single" },
              ],
            },
          },
        });
        resolveEventsDelivered?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await eventsDelivered;

    expect(
      app.transcript.get("permission:permission-other-session"),
    ).toBeUndefined();
    expect(
      app.transcript.get("question:question-other-session"),
    ).toBeUndefined();
    expect(
      app.state.snapshot().sessions.get("session-other")?.interactions
        .permission?.requestId,
    ).toBe("permission-other-session");
    expect(
      app.state.snapshot().sessions.get("session-other")?.interactions
        .questionnaire?.request.id,
    ).toBe("question-other-session");

    await app.stop();
  });

  it("surfaces only descendant permissions while keeping explicit Deny separate from Stop", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const rootSession = {
      sessionId: "session-root",
      title: "Root session",
      workspaceDir: "/workspace",
      status: "started",
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([rootSession]);
    vi.mocked(runtime.getSession).mockResolvedValue(rootSession);
    vi.mocked(runtime.getDelegationSnapshot).mockResolvedValue({
      schemaVersion: 1,
      rootSessionId: "session-root",
      members: [
        {
          sessionId: "session-child",
          parentSessionId: "session-root",
          agentName: "worker",
          task: "Delegate nested work",
          status: "running",
        },
        {
          sessionId: "session-grandchild",
          parentSessionId: "session-child",
          agentName: "verifier",
          task: "Verify the result",
          status: "running",
        },
      ],
    });
    vi.mocked(runtime.getActiveRun).mockImplementation(
      async (sessionId: string) => ({
        schemaVersion: 1,
        sessionId,
        state:
          sessionId === rootSession.sessionId ? "decision-blocked" : "running",
        turnId:
          sessionId === rootSession.sessionId
            ? "turn-root"
            : `turn-${sessionId}`,
        actions: { steer: false },
      }),
    );
    const deniedPermissionIds = new Set<string>();
    vi.mocked(runtime.replyPermission).mockImplementation(
      async (_agentName, requestId) => {
        deniedPermissionIds.add(requestId);
        return true;
      },
    );
    vi.mocked(runtime.listPendingPermissions).mockImplementation(async () =>
      deniedPermissionIds.has("permission-grandchild")
        ? [
            {
              requestId: "permission-unrelated-next",
              sessionId: "session-unrelated",
              agentName: "worker",
              toolName: "bash",
              reason: "Must remain hidden",
            },
            {
              requestId: deniedPermissionIds.has("permission-child-next")
                ? "permission-child-stop"
                : "permission-child-next",
              sessionId: "session-child",
              agentName: "worker",
              toolName: "read",
              reason: deniedPermissionIds.has("permission-child-next")
                ? "Wait for an explicit Stop"
                : "Inspect the delegated output",
            },
          ]
        : [],
    );
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        yield runtimeEvent({
          type: "permission.ask",
          timestamp: 100,
          source: "runtime",
          payload: {
            requestId: "permission-unrelated",
            sessionId: "session-unrelated",
            agentName: "worker",
            toolName: "bash",
            reason: "Must stay hidden",
          },
        });
        yield runtimeEvent({
          type: "permission.ask",
          timestamp: 101,
          source: "runtime",
          payload: {
            requestId: "permission-grandchild",
            sessionId: "session-grandchild",
            agentName: "verifier",
            toolName: "write",
            reason: "Update the verification report",
            allowAlwaysSupported: true,
          },
        });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.submit("/resume session-root");
    vi.mocked(runtime.abortSession).mockClear();
    vi.mocked(runtime.stopDelegation).mockClear();
    app.start();

    await vi.waitFor(() =>
      expect(
        app.transcript.get("permission:permission-grandchild"),
      ).toMatchObject({
        kind: "permission",
        status: "blocked",
      }),
    );
    expect(
      app.transcript.get("permission:permission-unrelated"),
    ).toBeUndefined();
    expect(app.interaction.current()?.render(80).join("\n")).toContain(
      "Update the verification report",
    );

    app.interaction.current()?.handleInput?.("3");
    app.interaction.current()?.handleInput?.("\r");

    await vi.waitFor(() =>
      expect(runtime.replyPermission).toHaveBeenCalledWith(
        "verifier",
        "permission-grandchild",
        "deny",
      ),
    );
    expect(runtime.stopDelegation).not.toHaveBeenCalled();
    expect(runtime.abortSession).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(app.interaction.current()?.render(80).join("\n")).toContain(
        "Inspect the delegated output",
      ),
    );
    expect(
      app.transcript.get("permission:permission-unrelated-next"),
    ).toBeUndefined();

    terminal.input?.("\x1b");

    await vi.waitFor(() =>
      expect(runtime.replyPermission).toHaveBeenCalledWith(
        "worker",
        "permission-child-next",
        "deny",
      ),
    );
    expect(runtime.abortSession).not.toHaveBeenCalled();
    expect(runtime.stopDelegation).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(app.interaction.current()?.render(80).join("\n")).toContain(
        "Wait for an explicit Stop",
      ),
    );

    terminal.input?.("\x03");

    await vi.waitFor(() =>
      expect(runtime.abortSession).toHaveBeenCalledWith({
        id: rootSession.sessionId,
        turnId: "turn-root",
        reason: "user_stop",
      }),
    );
    expect(runtime.stopDelegation).toHaveBeenCalledOnce();
    expect(runtime.stopDelegation).toHaveBeenCalledWith(rootSession.sessionId);
    expect(runtime.replyPermission).not.toHaveBeenCalledWith(
      "worker",
      "permission-child-stop",
      "deny",
    );
    await app.stop();
  });

  it("recovers a descendant permission from the Runtime pending list without leaking unrelated requests", async () => {
    const runtime = createRuntime();
    const rootSession = {
      sessionId: "session-recovery-root",
      title: "Recovery root",
      workspaceDir: "/workspace",
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([rootSession]);
    vi.mocked(runtime.getSession).mockResolvedValue(rootSession);
    vi.mocked(runtime.getDelegationSnapshot).mockResolvedValue({
      schemaVersion: 1,
      rootSessionId: rootSession.sessionId,
      members: [
        {
          sessionId: "session-recovery-child",
          parentSessionId: rootSession.sessionId,
          agentName: "worker",
          task: "Resume delegated work",
          status: "running",
        },
      ],
    });
    vi.mocked(runtime.listPendingPermissions).mockResolvedValue([
      {
        requestId: "permission-recovery-unrelated",
        sessionId: "session-other-root",
        agentName: "worker",
        toolName: "bash",
        reason: "Do not show this request",
      },
      {
        requestId: "permission-recovery-child",
        sessionId: "session-recovery-child",
        agentName: "worker",
        toolName: "write",
        reason: "Resume the child request",
      },
    ]);
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.submit("/resume session-recovery-root");

    expect(
      app.transcript.get("permission:permission-recovery-child"),
    ).toMatchObject({
      kind: "permission",
      status: "blocked",
    });
    expect(
      app.transcript.get("permission:permission-recovery-unrelated"),
    ).toBeUndefined();
    expect(app.interaction.current()?.render(80).join("\n")).toContain(
      "Resume the child request",
    );
    await app.stop();
  });

  it("reconnects the Runtime event stream after a transient disconnect", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const observability = createObservability();
    let attempt = 0;
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents() {
        attempt += 1;
        if (attempt === 1) throw new Error("connection reset");
        yield runtimeEvent({
          type: "permission.ask",
          timestamp: 101,
          source: "runtime",
          payload: {
            requestId: "permission-after-reconnect",
            sessionId: "session-1",
            toolName: "read",
          },
        });
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      observability,
    });

    await app.ready;
    await app.submit("Start the current session");
    app.start();
    await vi.waitFor(
      () =>
        expect(
          app.transcript.get("permission:permission-after-reconnect"),
        ).toMatchObject({
          status: "blocked",
        }),
      { timeout: 1500 },
    );

    expect(runtime.watchEvents).toHaveBeenCalledTimes(2);
    expect(observability.recordEventStream).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "retry-scheduled",
        attempt: 1,
        retryDelayMs: 250,
        errorKind: "Error",
      }),
    );
    expect(observability.recordEventStream).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "reconnected",
        attempt: 1,
        downtimeMs: expect.any(Number),
      }),
    );
    expect(app.transcript.snapshot()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "warning",
          content: expect.stringContaining("Runtime event stream"),
        }),
      ]),
    );
    await app.stop();
  });

  it("sends pasted local attachments and restores failed sends to the Composer", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const readClipboardImage = vi.fn(async () => ({
      attachment: {
        type: "image" as const,
        filePath: "/tmp/minimax-code-clipboard/diagram.png",
        fileName: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 2048,
      },
      dispose: vi.fn(async () => undefined),
    }));
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      readClipboardImage,
      readClipboardText: async () => null,
    });

    app.start();
    await app.ready;
    terminal.input?.("\u001bv");
    await vi.waitFor(() => expect(readClipboardImage).toHaveBeenCalledTimes(1));
    await app.submit("Inspect the diagram");

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        content: "Inspect the diagram",
        attachments: [
          expect.objectContaining({
            local: { filePath: "/tmp/minimax-code-clipboard/diagram.png" },
            meta: expect.objectContaining({ mimeType: "image/png" }),
          }),
        ],
      }),
      expect.any(AbortSignal),
    );

    expect(app.tui.render(80).join("\n")).not.toContain("[Image #1]");

    vi.mocked(runtime.sendMessage).mockImplementationOnce(
      async function* sendMessage() {
        yield { type: "error", message: "provider unavailable" };
      },
    );
    terminal.input?.("\x16");
    await vi.waitFor(() => expect(readClipboardImage).toHaveBeenCalledTimes(2));
    app.editor.setText("Try again");
    app.editor.handleInput("\r");
    await vi.waitFor(() => expect(app.editor.getText()).toContain("Try again"));
    expect(app.tui.render(80).join("\n")).toContain(
      "Error  The model provider is temporarily unavailable.",
    );
    expect(app.tui.render(80).join("\n")).not.toContain("Request failed");
    expect(app.editor.getText()).toContain("[Image #1]");
    expect(app.tui.render(80).join("\n")).not.toContain(
      "Message kept under Failed",
    );
    await app.submit("/retry");
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: "Try again",
        attachments: [
          expect.objectContaining({
            local: { filePath: "/tmp/minimax-code-clipboard/diagram.png" },
          }),
        ],
      }),
      expect.any(AbortSignal),
    );
    await app.submit("A fresh turn");
    expect(app.tui.render(80).join("\n")).not.toContain("Couldn't send");
    await app.stop();
  });

  it.each([
    ['content', 'Content review withdrew this response. Rephrase your request, then retry.'],
    ['network', 'Content review did not return a usable result, so this response stopped.'],
  ] as const)("presents a %s review stop without a failed Queue item", async (variant, notice) => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const busEvents: TuiRuntimeEvent[] = [];
    let wakeBus: (() => void) | undefined;
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        while (!signal.aborted) {
          if (busEvents.length === 0) {
            await new Promise<void>((resolve) => {
              wakeBus = resolve;
              signal.addEventListener("abort", resolve, { once: true });
            });
          }
          const event = busEvents.shift();
          if (event) yield event;
        }
      },
    );
    let releaseTurn: (() => void) | undefined;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        yield { type: "done" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("review this response");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().activeTurnId).toBeTruthy(),
    );

    busEvents.push(
      runtimeEvent({
        type: "content.retry.exceeded",
        timestamp: 100,
        source: "runtime-v2",
        payload: { sessionId: "session-1", variant },
      }),
      runtimeEvent({
        type: "message.rewind",
        timestamp: 101,
        source: "runtime-v2",
        payload: { sessionId: "session-1", contextReset: true },
      }),
    );
    wakeBus?.();
    releaseTurn?.();

    await vi.waitFor(() =>
      expect(app.editor.getText()).toBe("review this response"),
    );
    const rendered = app.tui.render(100).join("\n");
    expect(rendered).toContain(notice);
    expect(rendered).not.toContain('Check your network');
    expect(rendered).not.toContain("Message kept under Failed");
    await app.submit("/queue");
    expect(app.interaction.current()).toBeUndefined();
    await app.stop();
  });

  it("sends editable @directory/ input as ordinary text", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.submit("Review @src/");
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      { id: "session-1", content: "Review @src/", turnId: expect.any(String) },
      expect.any(AbortSignal),
    );
    await expect(app.submit("Review @generated/")).resolves.toBeUndefined();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("pastes a clipboard image without replacing the text draft and cleans it after send", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const dispose = vi.fn(async () => undefined);
    const readClipboardImage = vi.fn(async () => ({
      attachment: {
        type: "image" as const,
        filePath: "/tmp/minimax-code-clipboard/clipboard-1.png",
        fileName: "clipboard-1.png",
        mimeType: "image/png",
        sizeBytes: 4096,
      },
      dispose,
    }));
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      readClipboardImage,
      readClipboardText: async () => null,
    });

    app.start();
    await app.ready;
    app.editor.setText("Keep this draft");
    terminal.input?.("\u001B[118;9u");
    terminal.input?.("\u001B[118;9:3u");
    await vi.waitFor(() => expect(readClipboardImage).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(app.editor.getText()).toContain("[Image #1]"),
    );

    expect(app.editor.getText()).toBe("Keep this draft [Image #1] ");
    expect(app.tui.render(100).join("\n")).not.toContain(
      "A clipboard media paste is already in progress.",
    );
    await app.submit("Keep this draft");
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "session-1",
        content: "Keep this draft",
        attachments: [
          expect.objectContaining({
            local: { filePath: "/tmp/minimax-code-clipboard/clipboard-1.png" },
            meta: expect.objectContaining({ mimeType: "image/png" }),
          }),
        ],
      }),
      expect.any(AbortSignal),
    );
    expect(dispose).toHaveBeenCalledOnce();
    await app.stop();
  });

  it("retains existing draft state when clipboard read or send fails", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const dispose = vi.fn(async () => undefined);
    const readClipboardImage = vi
      .fn()
      .mockResolvedValueOnce({
        attachment: {
          type: "image" as const,
          filePath: "/tmp/minimax-code-clipboard/clipboard-2.png",
          fileName: "clipboard-2.png",
          mimeType: "image/png",
          sizeBytes: 1024,
        },
        dispose,
      })
      .mockRejectedValueOnce(new Error("clipboard has no image"));
    vi.mocked(runtime.sendMessage).mockImplementationOnce(
      async function* sendMessage() {
        yield { type: "error", message: "provider unavailable" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      readClipboardImage,
      readClipboardText: async () => null,
    });

    app.start();
    await app.ready;
    app.editor.setText("Do not clear me");
    terminal.input?.("\x16");
    await vi.waitFor(() => expect(readClipboardImage).toHaveBeenCalledTimes(1));
    terminal.input?.("\x16");
    await vi.waitFor(() => expect(readClipboardImage).toHaveBeenCalledTimes(2));

    expect(app.editor.getText()).toBe("Do not clear me [Image #1] ");
    await app.submit("Try the image");
    expect(dispose).not.toHaveBeenCalled();
    expect(app.tui.render(80).join("\n")).toContain("[Image #1]");

    terminal.input?.("\x7f");
    expect(app.tui.render(80).join("\n")).not.toContain("[Image #1]");
    expect(dispose).not.toHaveBeenCalled();
    await app.stop();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight clipboard read with Ctrl+C and keeps the draft", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let observedSignal: AbortSignal | undefined;
    const readClipboardImage = vi.fn(
      async (signal?: AbortSignal) =>
        await new Promise<never>((_resolve, reject) => {
          observedSignal = signal;
          signal?.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      readClipboardImage,
      readClipboardText: async () => null,
    });

    app.start();
    await app.ready;
    app.editor.setText("Draft survives");
    terminal.input?.("\x16");
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    terminal.input?.("\x03");
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));

    expect(app.editor.getText()).toBe("Draft survives");
    await app.stop();
  });

  it("keeps queued clipboard files alive until the Runtime reports a terminal queue state", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const dispose = vi.fn(async () => undefined);
    let finishTurn: (() => void) | undefined;
    let deliverQueueEvent: ((event: TuiRuntimeEvent) => void) | undefined;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents() {
        const event = await new Promise<TuiRuntimeEvent>((resolve) => {
          deliverQueueEvent = resolve;
        });
        yield event;
      },
    );
    const readClipboardImage = vi.fn(async () => ({
      attachment: {
        type: "image" as const,
        filePath: "/tmp/minimax-code-clipboard/clipboard-queue.png",
        fileName: "clipboard-queue.png",
        mimeType: "image/png",
        sizeBytes: 2048,
      },
      dispose,
    }));
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      productFeatures: { queue: true },
      readClipboardImage,
    });

    app.start();
    await app.ready;
    const first = app.submit("First turn");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().status).toBe("running"),
    );
    terminal.input?.("\x16");
    await vi.waitFor(() => expect(readClipboardImage).toHaveBeenCalledOnce());
    await app.submit("Queued with image");

    expect(runtime.enqueueMessage).toHaveBeenCalledWith(
      "session-1",
      "Queued with image",
      expect.objectContaining({
        attachments: [
          expect.objectContaining({ fileName: "clipboard-queue.png" }),
        ],
      }),
    );
    expect(dispose).not.toHaveBeenCalled();

    deliverQueueEvent?.(
      runtimeEvent({
        type: "session.queue.updated",
        timestamp: Date.now(),
        source: "runtime",
        payload: {
          sessionId: "session-1",
          itemId: "queue-1",
          status: "completed",
          queuedCount: 0,
        },
      }),
    );
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    finishTurn?.();
    await first;
    await app.stop();
  });

  it("opens the Desktop model picker and applies the selected session model", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listModels).mockResolvedValue([
      {
        providerId: "minimax",
        modelId: "MiniMax-M3",
        displayName: "MiniMax M3",
        variant: "thinking",
        thinkingConfig: { mode: "switchable", defaultValue: "true" },
        providerKind: "minimax-managed",
        selected: true,
      },
    ]);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("Create a session");
    await app.submit("/model");
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);
    terminal.input?.("\x1b");
    expect(app.tui.hasOverlay()).toBe(false);

    await app.submit("/model");
    terminal.input?.("\r");

    await vi.waitFor(() =>
      expect(runtime.selectModel).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "minimax",
          modelId: "MiniMax-M3",
          variant: "thinking",
        }),
        "session-1",
      ),
    );
    await vi.waitFor(() => {
      const rendered = app.tui.render(120).join("\n");
      expect(rendered).toContain("✦ MiniMax M3");
      expect(rendered).toContain("Thinking On");
      expect(rendered).not.toContain("MiniMax M3#thinking");
    });
    await app.stop();
  });

  it("queues a thinking-on model with the configured effort even when the Session stored none", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishTurn: (() => void) | undefined;
    vi.mocked(runtime.listModels).mockResolvedValue([
      {
        providerId: "minimax",
        modelId: "deep-reasoner-1",
        displayName: "deep-reasoner-1",
        selected: true,
        variant: "thinking",
        thinkingConfig: { mode: "switchable", defaultValue: "true" },
        effortOptions: ["xhigh"],
      },
    ]);
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        yield { type: "done" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      productFeatures: { queue: true },
    });

    app.start();
    await app.ready;
    const first = app.submit("First turn");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().status).toBe("running"),
    );
    await app.submit("Queued turn");

    // The Session echo carries no stored effort, so the per-Turn selection has to
    // resolve the configured level. Sending only `variant: thinking` makes Runtime
    // drop the effort and the provider apply its own default.
    expect(runtime.enqueueMessage).toHaveBeenCalledWith(
      "session-1",
      "Queued turn",
      expect.objectContaining({
        model: expect.objectContaining({
          providerId: "minimax",
          modelId: "deep-reasoner-1",
          variant: "thinking",
          thinking: { effort: "xhigh" },
        }),
      }),
    );

    finishTurn?.();
    await first;
    await app.stop();
  });

  it("applies a welcome-screen effort to the new Session before sending its first message", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listModels).mockResolvedValue([
      {
        providerId: "custom_provider:byok",
        modelId: "byok-large-5",
        displayName: "BYOK Large 5",
        selected: true,
        variant: "",
        thinkingConfig: { mode: "switchable", defaultValue: "false" },
        effortOptions: ["low", "medium", "high"],
      },
    ]);
    let releaseDefaultSelection: ((selected: boolean) => void) | undefined;
    let releaseSessionSelection: ((selected: boolean) => void) | undefined;
    vi.mocked(runtime.selectModel)
      .mockImplementationOnce(
        async () =>
          await new Promise<boolean>((resolve) => {
            releaseDefaultSelection = resolve;
          }),
      )
      .mockImplementationOnce(
        async () =>
          await new Promise<boolean>((resolve) => {
            releaseSessionSelection = resolve;
          }),
      );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/model");
    terminal.input?.("\u001b[C");
    terminal.input?.("\r");

    const firstTurn = app.submit("First turn");
    await vi.waitFor(() =>
      expect(runtime.selectModel).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ thinking: { effort: "high" }, variant: "" }),
        undefined,
      ),
    );
    expect(runtime.selectModel).toHaveBeenCalledOnce();
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    releaseDefaultSelection?.(true);
    await vi.waitFor(() =>
      expect(runtime.selectModel).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ thinking: { effort: "high" }, variant: "" }),
        "session-1",
      ),
    );
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    releaseSessionSelection?.(true);
    await firstTurn;

    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    expect(runtime.selectModel.mock.invocationCallOrder[1]).toBeLessThan(
      runtime.sendMessage.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    await app.stop();
  });

  it("does not send the first message when Runtime rejects its pending effort", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listModels).mockResolvedValue([
      {
        providerId: "custom_provider:byok",
        modelId: "byok-large-5",
        displayName: "BYOK Large 5",
        selected: true,
        effortOptions: ["low", "medium", "high"],
      },
    ]);
    vi.mocked(runtime.selectModel)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/model");
    terminal.input?.("\r");
    await vi.waitFor(() => expect(runtime.selectModel).toHaveBeenCalledOnce());

    await app.submit("First turn");

    expect(runtime.selectModel).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    await app.stop();
  });

  it("lets Escape cancel the first turn while Desktop is creating its session", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishSessionCreation:
      | ((session: { sessionId: string; workspaceDir: string }) => void)
      | undefined;
    vi.mocked(runtime.createSession).mockImplementation(
      async () =>
        await new Promise<{ sessionId: string; workspaceDir: string }>(
          (resolve) => {
            finishSessionCreation = resolve;
          },
        ),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const submitting = app.submit("Wait for the session");
    let turnIdAtAbort: string | undefined;
    await vi.waitFor(() => {
      const snapshot = app.controller.snapshot();
      turnIdAtAbort = snapshot.activeTurnId;
      expect(snapshot).toMatchObject({
        status: "starting",
        activeTurnId: expect.any(String),
      });
    });
    expect(app.tui.render(80).join("\n")).toContain("Loading");
    expect(app.tui.render(80).join("\n")).not.toContain("Loading · 0s");
    expect(app.tui.render(80).join("\n")).not.toContain("MCode ·");
    terminal.input?.("\x1b");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().activeTurnId).toBeUndefined(),
    );
    finishSessionCreation?.({
      sessionId: "session-created",
      workspaceDir: "/workspace",
    });
    await submitting;

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    // The turn had produced no output, so its prompt returned to the composer;
    // the user row stays in the transcript, marked cancelled.
    expect(app.editor.getText()).toBe("Wait for the session");
    expect(app.transcript.get(`user:${turnIdAtAbort}`)?.status).toBe("cancelled");
    expect(
      app.transcript
        .snapshot()
        .some((cell) => cell.kind === "assistant" && cell.status === "cancelled"),
    ).toBe(true);
    await app.stop();
  });

  it("restores a submission attempted while the previous cancellation fence is active", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let releaseCancelledStream: (() => void) | undefined;
    let sendCount = 0;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
        sendCount += 1;
        if (sendCount === 1) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          });
          await new Promise<void>((resolve) => {
            releaseCancelledStream = resolve;
          });
        } else {
          yield { type: "delta", content: "Second response" };
        }
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.abortSession).mockImplementation(async () => {
      setTimeout(() => releaseCancelledStream?.(), 10);
      return true;
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("First request");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().status).toBe("running"),
    );

    terminal.input?.("\x1b");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().cancelling).toBe(true),
    );
    terminal.input?.("Second request");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.editor.getText()).toContain("Second request"),
    );
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    await vi.waitFor(() =>
      expect(app.controller.snapshot().activeTurnId).toBeUndefined(),
    );
    await vi.waitFor(() =>
      expect(app.controller.snapshot().retiringTurnId).toBeUndefined(),
    );
    expect(app.controller.snapshot().cancelling).toBe(false);
    // The aborted first prompt (still without output) returns to the composer
    // and merges with the text typed while the fence was active.
    await vi.waitFor(() =>
      expect(app.editor.getText()).toBe("First request\nSecond request"),
    );
    expect(app.tui.render(80).join("\n")).not.toContain(
      "Stopping the current response",
    );
    app.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(runtime.sendMessage).toHaveBeenCalledTimes(2),
    );
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.enqueueMessage).not.toHaveBeenCalled();
    // Restoring the aborted prompt keeps that turn's rows, marked cancelled.
    expect(
      app.transcript
        .snapshot()
        .some((cell) => cell.kind === "assistant" && cell.status === "cancelled"),
    ).toBe(true);
    await app.stop();
  });

  it("restores a failed submission before text typed while cancellation is retiring", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let releaseRuntimeOwnership: (() => void) | undefined;
    const runtimeOwnershipReleased = new Promise<void>((resolve) => {
      releaseRuntimeOwnership = resolve;
    });
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
        // One delta keeps this turn outside the abort-prompt-restore window so
        // this test stays focused on the failed-submission restore below.
        yield { type: "delta", content: "First response" };
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", resolve, { once: true });
        });
        await runtimeOwnershipReleased;
        yield { type: "done" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("First request");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().status).toBe("running"),
    );

    terminal.input?.("\x1b");
    await vi.waitFor(
      () => expect(app.controller.snapshot().retiringTurnId).toBeTruthy(),
      {
        timeout: 2_000,
      },
    );
    expect(app.controller.snapshot()).toMatchObject({
      status: "idle",
      activeTurnId: undefined,
      cancelling: false,
    });

    terminal.input?.("Second request");
    terminal.input?.("\r");
    terminal.input?.("extra detail");
    await vi.waitFor(() => expect(app.editor.getText()).toBe("extra detail"));
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(app.tui.render(160).join("\n")).toContain("Second request"),
    );
    expect(app.editor.getText()).toBe("Second request\nextra detail");

    releaseRuntimeOwnership?.();
    await vi.waitFor(() =>
      expect(app.controller.snapshot().retiringTurnId).toBeUndefined(),
    );
    expect(app.tui.render(160).join("\n")).not.toContain(
      "Runtime is still stopping; your draft is preserved",
    );
    await app.stop();
  });

  it("returns the prompt to the composer when a turn is aborted before any output", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", resolve, { once: true });
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.abortSession).mockResolvedValue(true);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("Fix the typo");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().status).toBe("running"),
    );
    const turnId = app.controller.snapshot().activeTurnId;
    expect(turnId).toBeTruthy();

    terminal.input?.("\x1b");
    await vi.waitFor(() => expect(app.editor.getText()).toBe("Fix the typo"));

    // The user row stays in the transcript, marked cancelled and rendered
    // with the muted marker.
    const cancelledUserCell = app.transcript.get(`user:${turnId}`);
    expect(cancelledUserCell).toBeDefined();
    expect(cancelledUserCell?.status).toBe("cancelled");
    expect(
      app.transcript.snapshot().some((cell) => cell.turnId === turnId),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(app.tui.render(160).join("\n")).toContain("× Cancelled"),
    );
    await vi.waitFor(() =>
      expect(app.tui.render(160).join("\n")).toContain(
        "Stopped · message restored to the Composer.",
      ),
    );
    await app.stop();
  });

  it.each([
    "resubmit",
    "cancel",
    "failed-submit-cancel",
    "new-operation-cancel",
    "rewound-submit-cancel",
    "resubmit-required-cancel",
    "fast-completion",
    "early-rewind",
    "display-commit-cancel",
  ])(
    "keeps the interrupted footer lifecycle correct after double Escape and %s",
    async (action) => {
      const terminal = new FakeTerminal();
      const screen = new VirtualTerminalScreen(terminal.columns, terminal.rows);
      const frames: string[] = [];
      const write = terminal.write.bind(terminal);
      terminal.write = (data) => {
        write(data);
        screen.feed(data);
        if (data.includes("\x1b[?2026l")) frames.push(screen.text());
      };
      const runtime = createRuntime();
      const busEvents: TuiRuntimeEvent[] = [];
      let wakeBus: (() => void) | undefined;
      let finishEdit: (() => void) | undefined;
      vi.mocked(runtime.watchEvents).mockImplementation(async function* (signal) {
        while (!signal.aborted) {
          if (busEvents.length === 0) {
            await new Promise<void>((resolve) => {
              wakeBus = resolve;
              signal.addEventListener("abort", resolve, { once: true });
            });
          }
          const event = busEvents.shift();
          if (event) yield event;
        }
      });
      const originalMessage = {
        id: "msg-user-interrupted",
        role: "user" as const,
        content: "Original query",
        timestamp: 1,
      };
      vi.mocked(runtime.listSessionInputSummaries).mockResolvedValue([
        { userMessageId: originalMessage.id, timestamp: 1, fileChangeCount: 0 },
      ]);
      vi.mocked(runtime.listMessagePage).mockResolvedValue({
        messages: [originalMessage],
        hasMore: false,
      });
      vi.mocked(runtime.sendMessage).mockImplementation(
        async function* (_request, signal) {
          yield { type: "message", message: originalMessage };
          yield { type: "delta", content: "Partial response" };
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          });
          yield { type: "done" };
        },
      );
      // The RPC/history refresh can finish before the replacement session.start event.
      vi.mocked(runtime.editSessionMessage).mockImplementation(async () => {
        if (action === "failed-submit-cancel")
          throw new Error("Edit rejected before rewind");
        const failureCodes: Partial<Record<string, string>> = {
          "new-operation-cancel": "EDIT_RESTART_NEEDS_NEW_OPERATION",
          "rewound-submit-cancel": "EDIT_SUBMIT_FAILED_AFTER_REWIND",
          "resubmit-required-cancel": "EDIT_RESTART_NEEDS_RESUBMIT",
          "display-commit-cancel": "REWIND_DISPLAY_COMMIT_FAILED",
        };
        const failureCode = failureCodes[action];
        if (failureCode)
          throw Object.assign(new Error("Edit failed"), { key: failureCode });
        if (action === "fast-completion") {
          app.controller.beginRuntimeTurn("turn-edited", 1);
          app.controller.runtimeTurnSettlement.settleProjection(
            "turn-edited",
            "succeeded",
            2_000,
          );
        }
        vi.mocked(runtime.getMessages).mockResolvedValue([
          { ...originalMessage, id: "msg-user-edited", content: "Edited query" },
        ]);
        if (action === "early-rewind") {
          busEvents.push(
            runtimeEvent({
              type: "message.rewind",
              timestamp: 101,
              source: "runtime-v2",
              payload: { sessionId: "session-1", contextReset: true },
            }),
          );
          wakeBus?.();
          await new Promise<void>((resolve) => {
            finishEdit = resolve;
          });
        }
        return {
          rewound: true,
          turnId: "turn-edited",
          userMessageId: "msg-user-edited",
        };
      });
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
      });
      app.start();
      try {
        await app.ready;
        terminal.input?.("Original query");
        terminal.input?.("\r");
        await vi.waitFor(() =>
          expect(
            app.transcript
              .snapshot()
              .some((cell) => cell.content === "Partial response"),
          ).toBe(true),
        );
        terminal.input?.("\x1b");
        await vi.waitFor(() =>
          expect(
            app.transcript
              .snapshot()
              .some((cell) => cell.kind === "turn-duration"),
          ).toBe(true),
        );
        expect(app.editor.getText()).toBe("");
        app.tui.renderNow();
        expect(screen.text()).toContain("Interrupted after");

        terminal.input?.("\x1b");
        terminal.input?.("\x1b");
        await vi.waitFor(() =>
          expect(app.editor.getText()).toBe("Original query"),
        );
        app.tui.renderNow();
        expect(screen.text()).not.toContain("Interrupted after");

        if (action === "cancel") {
          terminal.input?.("\x1b");
          app.tui.renderNow();
          expect(screen.text()).toContain("Interrupted after");
          expect(runtime.editSessionMessage).not.toHaveBeenCalled();
          return;
        }

        frames.length = 0;
        app.editor.setText("Edited query");
        terminal.input?.("\r");
        if (action.endsWith("-cancel")) {
          await vi.waitFor(() =>
            expect(app.editor.getText()).toBe("Edited query"),
          );
          expect(runtime.editSessionMessage).toHaveBeenCalledOnce();
          terminal.input?.("\x1b");
          app.tui.renderNow();
          if (
            action === "failed-submit-cancel" ||
            action === "new-operation-cancel"
          ) {
            expect(screen.text()).toContain("Interrupted after");
          } else {
            expect(screen.text()).not.toContain("Interrupted after");
          }
          return;
        }
        await vi.waitFor(() =>
          expect(
            app.transcript
              .snapshot()
              .some((cell) => cell.sourceMessageId === "msg-user-edited"),
          ).toBe(true),
        );
        app.tui.renderNow();
        if (action === "early-rewind") {
          // Inspect the actual screen while the edit RPC is still pending.
          expect(finishEdit).toBeDefined();
          expect(screen.text()).not.toContain("Interrupted after");
          finishEdit?.();
          await vi.waitFor(() => expect(app.editor.getText()).toBe(""));
          app.tui.renderNow();
        }
        expect(runtime.editSessionMessage).toHaveBeenCalledOnce();
        expect(screen.text()).toContain("Edited query");
        expect(screen.text()).not.toContain("Interrupted after");
        if (action === "fast-completion")
          expect(screen.text()).toContain("Completed in 2s");
        expect(
          frames.filter((frame) => frame.includes("Interrupted after")),
        ).toEqual([]);
      } finally {
        finishEdit?.();
        await app.stop();
        screen.dispose();
      }
    },
  );

  it("clears the interrupted duration before the next message input returns", async () => {
    const terminal = new FakeTerminal();
    terminal.rows = 10;
    const screen = new VirtualTerminalScreen(terminal.columns, terminal.rows);
    const frames: string[] = [];
    const write = terminal.write.bind(terminal);
    terminal.write = (data) => {
      write(data);
      // Model terminals that preserve an erased screen in native scrollback.
      screen.feed(
        data.replaceAll(
          "\x1b[2J",
          `\x1b[${terminal.rows};1H${"\r\n".repeat(terminal.rows)}\x1b[2J`,
        ),
      );
      if (data.includes("\x1b[?2026l")) frames.push(screen.text());
    };
    const runtime = createRuntime();
    let finishResend: (() => void) | undefined;
    let sendCount = 0;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* (_request, signal) {
        sendCount += 1;
        if (sendCount <= 10) {
          yield { type: "delta", content: `Preload reply ${sendCount}` };
          yield { type: "done" };
          return;
        }
        if (sendCount === 11) {
          yield { type: "delta", content: "Partial response" };
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          });
        } else {
          await new Promise<void>((resolve) => {
            finishResend = resolve;
          });
        }
        if (sendCount === 12) yield { type: "delta", content: "Agent reply" };
        yield { type: "done" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    try {
      await app.ready;
      for (let i = 0; i < 10; i++) {
        await app.submit(`Preload ${i}`);
        app.tui.renderNow();
      }
      terminal.input?.("First request");
      terminal.input?.("\r");
      await vi.waitFor(() => expect(app.controller.snapshot().status).toBe("running"));
      terminal.input?.("\x1b");
      await vi.waitFor(() =>
        expect(app.tui.render(80).join("\n")).toContain("Partial response"),
      );
      await vi.waitFor(() =>
        expect(
          app.transcript
            .snapshot()
            .some((cell) => cell.kind === "turn-duration" && cell.status === "cancelled"),
        ).toBe(true),
      );
      app.tui.renderNow();
      expect(screen.text()).toContain("Interrupted after");

      app.tui.renderNow();
      frames.length = 0;
      terminal.input?.("Second request");
      terminal.input?.("\r");
      expect(screen.text()).not.toContain("Interrupted after");
      expect(app.tui.render(80).join("\n")).not.toContain("Interrupted after");
      await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(12));
      app.tui.renderNow();

      expect(frames.length).toBeGreaterThan(0);
      expect(frames.filter((frame) => frame.includes("Interrupted after"))).toEqual([]);
    } finally {
      finishResend?.();
      await app.stop();
      screen.dispose();
    }
  });

  it("returns a thinking-only turn's prompt to the composer on abort", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
        yield { type: "delta", thinking: "let me consider" };
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", resolve, { once: true });
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.abortSession).mockResolvedValue(true);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("Wrong question");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().status).toBe("running"),
    );
    const turnId = app.controller.snapshot().activeTurnId;
    await vi.waitFor(() =>
      expect(
        app.transcript.snapshot().some((cell) => cell.kind === "thinking"),
      ).toBe(true),
    );

    terminal.input?.("\x1b");
    await vi.waitFor(() => expect(app.editor.getText()).toBe("Wrong question"));
    expect(
      app.transcript.snapshot().some((cell) => cell.turnId === turnId),
    ).toBe(true);
    await app.stop();
  });

  it("keeps the transcript and leaves the composer empty when aborting after output", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
        yield { type: "delta", content: "partial answer" };
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", resolve, { once: true });
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.abortSession).mockResolvedValue(true);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("Keep this prompt");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().status).toBe("running"),
    );
    const turnId = app.controller.snapshot().activeTurnId;
    await vi.waitFor(() =>
      expect(
        app.transcript.snapshot().some(
          (cell) => cell.kind === "assistant" && cell.content.length > 0,
        ),
      ).toBe(true),
    );

    terminal.input?.("\x1b");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().activeTurnId).toBeUndefined(),
    );
    await vi.waitFor(() =>
      expect(app.controller.snapshot().retiringTurnId).toBeUndefined(),
    );

    expect(app.editor.getText()).toBe("");
    expect(app.transcript.get(`user:${turnId}`)).toBeDefined();
    expect(app.tui.render(160).join("\n")).not.toContain(
      "Stopped · message restored to the Composer.",
    );
    await app.stop();
  });

  it.each([false, true])(
    "restores a mixed submission after abort (local attachment removed: %s)",
    async (removeLocal) => {
      const directory = await mkdtemp(join(tmpdir(), "mcode-mixed-abort-"));
      try {
        const localPath = join(directory, "local.png");
        await writeFile(localPath, "png");
        const terminal = new FakeTerminal();
        const runtime = createRuntime();
        vi.mocked(runtime.sendMessage).mockImplementation(
          async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
            await new Promise<void>((resolve) => {
              signal?.addEventListener("abort", resolve, { once: true });
            });
            yield { type: "done" };
          },
        );
        vi.mocked(runtime.abortSession).mockResolvedValue(true);
        const app = createTuiApp({
          runtime,
          terminal,
          version: "0.1.0",
          workspaceDir: "/workspace",
        });

        app.start();
        await app.ready;
        // Mixed submission: a file-backed attachment (composer chip) plus an
        // asset-only transport attachment. Submit through the seed path so the
        // snapshot carries the full transport list, exactly as a paste flow
        // would produce.
        const seed = {
          editor: {
            schemaVersion: 1 as const,
            text: "Mixed restore",
            cursor: 13,
            pastes: [],
            pasteCounter: 0,
          },
          resources: {
            attachments: [
              {
                type: "image" as const,
                fileName: "local.png",
                mimeType: "image/png",
                sizeBytes: 3,
                filePath: localPath,
              },
            ],
          },
          transportAttachments: [
            {
              type: "image" as const,
              fileName: "local.png",
              mimeType: "image/png",
              filePath: localPath,
            },
            {
              type: "image" as const,
              fileName: "asset.png",
              mimeType: "image/png",
              assetId: "asset-mixed-1",
            },
          ],
        };
        void app.commandFlow.submit("Mixed restore", seed).catch(() => undefined);
        await vi.waitFor(() =>
          expect(app.controller.snapshot().status).toBe("running"),
        );
        const turnIdAtAbort = app.controller.snapshot().activeTurnId;

        terminal.input?.("\x1b");
        await vi.waitFor(() =>
          expect(app.editor.getText()).toBe("Mixed restore [Image #1] "),
        );
        // The retained snapshot was consulted and dropped after the restore.
        await vi.waitFor(() =>
          expect(app.commandFlow.getRetainedSubmission(String(turnIdAtAbort))).toBeUndefined(),
        );

        if (removeLocal) {
          app.editor.handleInput("\x05");
          app.editor.handleInput("\x7f");
          await vi.waitFor(() =>
            expect(app.editor.getText()).not.toContain("[Image #1]"),
          );
        }

        // Resubmit the restored draft with its current attachment selection.
        app.editor.handleInput("\r");
        await vi.waitFor(() =>
          expect(vi.mocked(runtime.sendMessage).mock.calls.length).toBe(2),
        );

        const request = vi.mocked(runtime.sendMessage).mock.calls[1][0];
        expect(request.attachments).toHaveLength(removeLocal ? 1 : 2);
        const locals = request.attachments?.map((attachment) => attachment.local) ?? [];
        expect(locals).toEqual(
          removeLocal
            ? [expect.objectContaining({ assetId: "asset-mixed-1" })]
            : expect.arrayContaining([
                expect.objectContaining({ filePath: localPath }),
                expect.objectContaining({ assetId: "asset-mixed-1" }),
              ]),
        );
        await app.stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "restores hidden transport only for unchanged text (edited: %s)",
    async (edited) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      vi.mocked(runtime.sendMessage).mockImplementation(
        async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          });
          yield { type: "done" };
        },
      );
      vi.mocked(runtime.abortSession).mockResolvedValue(true);
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
      });

      app.start();
      await app.ready;
      void app.commandFlow.submit("Visible prompt", {
        editor: { schemaVersion: 1, text: "", cursor: 0, pastes: [], pasteCounter: 0 },
        resources: { attachments: [] },
        transportContent: "Original hidden transport",
        clientIntent: "plan-entry",
      });
      await vi.waitFor(() => expect(app.controller.snapshot().status).toBe("running"));

      terminal.input?.("\x1b");
      await vi.waitFor(() => expect(app.editor.getText()).toBe("Visible prompt"));
      if (edited) app.editor.setText("Corrected prompt");
      app.editor.handleInput("\r");
      await vi.waitFor(() => expect(vi.mocked(runtime.sendMessage)).toHaveBeenCalledTimes(2));
      const request = vi.mocked(runtime.sendMessage).mock.calls[1][0];
      expect(request.content).toBe(edited ? "Corrected prompt" : "Original hidden transport");
      expect(request.clientIntent).toBe(edited ? undefined : "plan-entry");
      await app.stop();
    },
  );

  it("sends edited visible text instead of stale hidden review transport after abort", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", resolve, { once: true });
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.abortSession).mockResolvedValue(true);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    void app.commandFlow.submit(
      "/review",
      {
        editor: { schemaVersion: 1, text: "/review", cursor: 7, pastes: [], pasteCounter: 0 },
        resources: { attachments: [] },
      },
      {
        forceMessage: true,
        transportContent: "Please review my uncommitted changes.",
        reviewRequest: { scope: "local_changes" },
      },
    );
    await vi.waitFor(() => expect(app.controller.snapshot().status).toBe("running"));

    terminal.input?.("\x1b");
    await vi.waitFor(() => expect(app.editor.getText()).toBe("/review"));
    app.editor.setText("Review only src/foo.ts");
    app.editor.handleInput("\r");
    await vi.waitFor(() => expect(vi.mocked(runtime.sendMessage)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(runtime.sendMessage).mock.calls[1][0]).toMatchObject({
      content: "Review only src/foo.ts",
    });
    expect(vi.mocked(runtime.sendMessage).mock.calls[1][0].reviewRequest).toBeUndefined();
    await app.stop();
  });

  it("does not restore the prompt when the runtime does not confirm the stop", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", resolve, { once: true });
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.abortSession).mockResolvedValue(false);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("Unconfirmed stop");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().status).toBe("running"),
    );
    const turnId = app.controller.snapshot().activeTurnId;

    terminal.input?.("\x1b");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().cancelling).toBe(true),
    );
    // Let the abort funnel (settle race included) finish before asserting; an
    // immediate assert could pass before a regressed restore ever fired.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(app.editor.getText()).toBe("");
    expect(app.transcript.get(`user:${turnId}`)).toBeDefined();
    await app.stop();
  });

  it("does not restore the prompt when only delegated agents stopped", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", resolve, { once: true });
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.abortSession).mockResolvedValue(false);
    vi.mocked(runtime.stopDelegation).mockResolvedValue({
      rootStopped: false,
      stoppedSessionIds: ["child-1"],
      failedSessionIds: [],
      activeSessionIds: [],
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("Root keeps running");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().status).toBe("running"),
    );
    const turnId = app.controller.snapshot().activeTurnId;

    terminal.input?.("\x1b");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().cancelling).toBe(true),
    );
    // Let the abort funnel settle; the root turn was never confirmed stopped.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(app.editor.getText()).toBe("");
    expect(app.transcript.get(`user:${turnId}`)).toBeDefined();
    await app.stop();
  });

  it("does not restore when retirement does not settle within the settlement window", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", resolve, { once: true });
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.abortSession).mockResolvedValue(true);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    terminal.input?.("Hanging retirement");
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().status).toBe("running"),
    );
    const turnId = app.controller.snapshot().activeTurnId;

    // Simulate a retirement that never settles: whenIdle parks its waiter
    // forever, so the bounded settle race must skip the restore instead of
    // hanging the funnel.
    vi.spyOn(app.controller, "whenIdle").mockReturnValue(new Promise(() => undefined));

    terminal.input?.("\x1b");
    // Both the coordinator settle wait and the restore's settle race use the
    // 1s cancellation-settlement window; dwell past both before asserting.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(app.editor.getText()).toBe("");
    expect(app.tui.render(160).join("\n")).not.toContain(
      "Stopped · message restored to the Composer.",
    );
    // The restore never fired; the user row is untouched by it. (Its status
    // may legitimately read 'cancelled' from abort-time markTurn when Esc
    // lands before the user echo, which is unrelated to the restore.)
    expect(app.transcript.get(`user:${turnId}`)).toBeDefined();

    await app.stop();
  });

  it("does not duplicate the restored prompt after relaunch", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mcode-abort-draft-"));
    try {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      vi.mocked(runtime.sendMessage).mockImplementation(
        async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          });
          yield { type: "done" };
        },
      );
      vi.mocked(runtime.abortSession).mockResolvedValue(true);
      const first = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace",
      });
      first.start();
      await first.ready;
      await first.openSession("session-1");
      terminal.input?.("Only once");
      terminal.input?.("\r");
      await vi.waitFor(() =>
        expect(first.controller.snapshot().status).toBe("running"),
      );
      terminal.input?.("\x1b");
      await vi.waitFor(() => expect(first.editor.getText()).toBe("Only once"));
      await first.stop();

      const restored = createTuiApp({
        runtime: createRuntime(),
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace",
      });
      restored.start();
      await restored.ready;
      await restored.openSession("session-1");
      await vi.waitFor(() => expect(restored.editor.getText()).toBe("Only once"));
      await restored.stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("preserves restored asset and hidden submission metadata after relaunch", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mcode-abort-metadata-"));
    try {
      const localPath = join(dataDir, "local.png");
      await writeFile(localPath, "png");
      const runtime = createRuntime();
      vi.mocked(runtime.sendMessage).mockImplementation(
        async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          });
          yield { type: "done" };
        },
      );
      vi.mocked(runtime.abortSession).mockResolvedValue(true);
      const first = createTuiApp({
        runtime,
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace",
      });
      first.start();
      await first.ready;
      await first.openSession("session-1");
      void first.commandFlow.submit("Mixed restore", {
        sessionId: "session-1",
        editor: {
          schemaVersion: 1,
          text: "Mixed restore",
          cursor: 13,
          pastes: [],
          pasteCounter: 0,
        },
        resources: {
          attachments: [{
            type: "image",
            fileName: "local.png",
            mimeType: "image/png",
            sizeBytes: 3,
            filePath: localPath,
          }],
        },
        transportAttachments: [
          { type: "image", fileName: "local.png", mimeType: "image/png", filePath: localPath },
          { type: "image", fileName: "asset.png", mimeType: "image/png", assetId: "asset-1" },
        ],
        transportContent: "Original hidden transport",
        clientIntent: "plan-entry",
      });
      await vi.waitFor(() => expect(first.controller.snapshot().status).toBe("running"));
      await first.abortTurn();
      await vi.waitFor(() => expect(first.editor.getText()).toContain("Mixed restore"));
      await first.stop();

      const nextRuntime = createRuntime();
      const restored = createTuiApp({
        runtime: nextRuntime,
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace",
      });
      restored.start();
      await restored.ready;
      await restored.openSession("session-1");
      await vi.waitFor(() => expect(restored.editor.getText()).toContain("Mixed restore"));
      expect(restored.editor.captureDraft().attachmentPlaceholders).toHaveLength(1);
      restored.editor.handleInput("\r");
      await vi.waitFor(() => expect(nextRuntime.sendMessage).toHaveBeenCalledTimes(1));
      const request = vi.mocked(nextRuntime.sendMessage).mock.calls[0][0];
      expect(request.content).toBe("Original hidden transport");
      expect(request.clientIntent).toBe("plan-entry");
      expect(request.attachments?.map((attachment) => attachment.local)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ filePath: localPath }),
          expect.objectContaining({ assetId: "asset-1" }),
        ]),
      );
      await restored.stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "preserves review metadata after relaunch only when unchanged (edited: %s)",
    async (edited) => {
      const dataDir = await mkdtemp(join(tmpdir(), "mcode-abort-review-"));
      try {
        const runtime = createRuntime();
        vi.mocked(runtime.sendMessage).mockImplementation(
          async function* sendMessage(_req: SendMessageReq, signal?: AbortSignal) {
            await new Promise<void>((resolve) => {
              signal?.addEventListener("abort", resolve, { once: true });
            });
            yield { type: "done" };
          },
        );
        vi.mocked(runtime.abortSession).mockResolvedValue(true);
        const first = createTuiApp({
          runtime,
          terminal: new FakeTerminal(),
          version: "0.1.0",
          dataDir,
          workspaceDir: "/workspace",
        });
        first.start();
        await first.ready;
        await first.openSession("session-1");
        void first.commandFlow.submit(
          "/review",
          {
            sessionId: "session-1",
            editor: { schemaVersion: 1, text: "/review", cursor: 7, pastes: [], pasteCounter: 0 },
            resources: { attachments: [] },
          },
          {
            forceMessage: true,
            transportContent: "Please review my uncommitted changes.",
            reviewRequest: { scope: "local_changes" },
          },
        );
        await vi.waitFor(() => expect(first.controller.snapshot().status).toBe("running"));
        await first.abortTurn();
        await vi.waitFor(() => expect(first.editor.getText()).toBe("/review"));
        await first.stop();

        const nextRuntime = createRuntime();
        const restored = createTuiApp({
          runtime: nextRuntime,
          terminal: new FakeTerminal(),
          version: "0.1.0",
          dataDir,
          workspaceDir: "/workspace",
        });
        restored.start();
        await restored.ready;
        await restored.openSession("session-1");
        await vi.waitFor(() => expect(restored.editor.getText()).toBe("/review"));
        if (edited) restored.editor.setText("Review src/foo.ts");
        restored.editor.handleInput("\r");
        await vi.waitFor(() => expect(nextRuntime.sendMessage).toHaveBeenCalledOnce());
        const request = vi.mocked(nextRuntime.sendMessage).mock.calls[0][0];
        expect(request.content).toBe(
          edited ? "Review src/foo.ts" : "Please review my uncommitted changes.",
        );
        expect(request.reviewRequest).toEqual(
          edited ? undefined : { scope: "local_changes" },
        );
        await restored.stop();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it("aborts session creation when the TUI stops during its first turn", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishSessionCreation:
      | ((session: { sessionId: string; workspaceDir: string }) => void)
      | undefined;
    vi.mocked(runtime.createSession).mockImplementation(
      async () =>
        await new Promise<{ sessionId: string; workspaceDir: string }>(
          (resolve) => {
            finishSessionCreation = resolve;
          },
        ),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const submitting = app.submit("Wait for the session");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().activeTurnId).toEqual(
        expect.any(String),
      ),
    );
    const stopping = app.stop();
    finishSessionCreation?.({
      sessionId: "session-created",
      workspaceDir: "/workspace",
    });
    await Promise.all([submitting, stopping]);

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(app.transcript.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", status: "cancelled" }),
      ]),
    );
    expect(terminal.stopped).toBe(true);
  });

  it.each(["minimax", "custom_provider:work"])(
    "hydrates the Runtime-selected startup model for %s",
    async (providerId) => {
      const runtime = createRuntime();
      vi.mocked(runtime.listModels).mockResolvedValue([
        { providerId, modelId: "MiniMax-M3", selected: true },
      ]);
      const app = createTuiApp({
        runtime,
        terminal: new FakeTerminal(),
        version: "0.1.0",
        workspaceDir: "/workspace",
      });

      try {
        await app.ready;
        expect(runtime.listModels).toHaveBeenCalled();
        expect(runtime.selectModel).not.toHaveBeenCalled();
        await app.submit("/model");
        expect(runtime.selectModel).not.toHaveBeenCalled();
      } finally {
        await app.stop();
      }
    },
  );

  it("offers provider onboarding when Desktop has no models", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listModels).mockResolvedValue([]);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.submit("/model unavailable");

    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);
    const rendered = app.tui.render(120).join("\n");
    expect(rendered).toContain("No matching models");
    expect(rendered).toContain("Add 3rd-party provider");
    terminal.input?.("\x1b");
    await app.stop();
  });

  it("keeps the TUI usable when the Runtime model catalog fails to load", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    vi.mocked(runtime.listModels).mockRejectedValue(
      new Error("catalog unavailable"),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await expect(app.submit("/model")).resolves.toBeUndefined();

    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.transcript.snapshot().at(-1)).toMatchObject({
      kind: "warning",
      content: "Couldn't load models: catalog unavailable. Retry /model.",
    });
  });

  it("shows a follow-up as queued while Runtime admission is pending", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishFirstTurn: (() => void) | undefined;
    let finishEnqueue: (() => void) | undefined;
    let admitted = false;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        await new Promise<void>((resolve) => {
          finishFirstTurn = resolve;
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.enqueueMessage).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finishEnqueue = resolve;
      });
      admitted = true;
      return { itemId: "queue-pending-1", status: "queued", position: 1 };
    });
    vi.mocked(runtime.listQueuedMessages).mockImplementation(async () =>
      admitted
        ? [
            {
              itemId: "queue-pending-1",
              sessionId: "session-1",
              status: "queued",
              content: "Second turn",
            },
          ]
        : [],
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const first = app.submit("First turn");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().activeTurnId).toEqual(
        expect.any(String),
      ),
    );

    terminal.input?.("Second turn");
    terminal.input?.("\x1b\r");
    await vi.waitFor(() =>
      expect(runtime.enqueueMessage).toHaveBeenCalledOnce(),
    );

    try {
      expect(
        app.transcript
          .snapshot()
          .find((cell) => cell.content.includes("Second turn")),
      ).toBeUndefined();
      const rendered = app.tui.render(100).join("\n");
      expect(rendered).not.toContain("Adding to Queue");
      expect(rendered).toContain("Next · after current response");
      expect(rendered).toContain("Second turn");
      finishEnqueue?.();
      await vi.waitFor(() => {
        const confirmed = app.tui.render(100).join("\n");
        expect(confirmed).not.toContain("Adding to Queue");
        expect(confirmed).toContain("Next · after current response");
        expect(confirmed).toContain("Second turn");
      });
    } finally {
      finishEnqueue?.();
      finishFirstTurn?.();
      await first;
      await app.stop();
    }
  });

  it("removes the local Queue admission and restores the Draft when Runtime rejects it", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishFirstTurn: (() => void) | undefined;
    let rejectEnqueue: ((error: Error) => void) | undefined;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        await new Promise<void>((resolve) => {
          finishFirstTurn = resolve;
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.enqueueMessage).mockImplementation(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectEnqueue = reject;
        }),
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const first = app.submit("First turn");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().activeTurnId).toEqual(
        expect.any(String),
      ),
    );
    terminal.input?.("Keep this Draft");
    terminal.input?.("\x1b\r");
    await vi.waitFor(() =>
      expect(app.tui.render(100).join("\n")).toContain(
        "Next · after current response",
      ),
    );
    await vi.waitFor(() =>
      expect(runtime.enqueueMessage).toHaveBeenCalledOnce(),
    );

    rejectEnqueue?.(new Error("queue unavailable"));
    await vi.waitFor(() =>
      expect(app.editor.getText()).toBe("Keep this Draft"),
    );
    const rendered = app.tui.render(100).join("\n");
    expect(rendered).not.toContain("Next · after current response");
    expect(rendered).toContain("Couldn't add this message to the Queue");

    finishFirstTurn?.();
    await first;
    await app.stop();
  });

  it("shows every rapid follow-up as queued while Runtime admissions are serialized", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishFirstTurn: (() => void) | undefined;
    const releaseAdmissions: Array<() => void> = [];
    const queued: TuiQueuedMessage[] = [];
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        await new Promise<void>((resolve) => {
          finishFirstTurn = resolve;
        });
        yield { type: "done" };
      },
    );
    vi.mocked(runtime.enqueueMessage).mockImplementation(
      async (sessionId, content) => {
        await new Promise<void>((resolve) => releaseAdmissions.push(resolve));
        const item = {
          itemId: `queue-rapid-${String(queued.length + 1)}`,
          sessionId,
          status: "queued",
          content,
        } satisfies TuiQueuedMessage;
        queued.push(item);
        return {
          itemId: item.itemId,
          status: item.status,
          position: queued.length,
        };
      },
    );
    vi.mocked(runtime.listQueuedMessages).mockImplementation(async () => [
      ...queued,
    ]);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    const first = app.submit("First turn");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().activeTurnId).toEqual(
        expect.any(String),
      ),
    );
    terminal.input?.("Second turn");
    terminal.input?.("\x1b\r");
    terminal.input?.("Third turn");
    terminal.input?.("\x1b\r");

    await vi.waitFor(() => {
      const rendered = app.tui.render(100).join("\n");
      expect(rendered).not.toContain("Adding");
      expect(rendered).toContain("Queue · 2 next");
      expect(rendered).toContain("Second turn");
      expect(rendered).toContain("Third turn");
    });
    expect(
      app.transcript
        .snapshot()
        .filter(
          (cell) =>
            cell.content.includes("Second turn") ||
            cell.content.includes("Third turn"),
        ),
    ).toEqual([]);

    await vi.waitFor(() =>
      expect(runtime.enqueueMessage).toHaveBeenCalledOnce(),
    );
    releaseAdmissions[0]?.();
    await vi.waitFor(() =>
      expect(runtime.enqueueMessage).toHaveBeenCalledTimes(2),
    );
    const partiallyConfirmed = app.tui.render(100).join("\n");
    expect(partiallyConfirmed).toContain("Queue · 2 next");
    expect(partiallyConfirmed.indexOf("Second turn")).toBeLessThan(
      partiallyConfirmed.indexOf("Third turn"),
    );
    releaseAdmissions[1]?.();
    await vi.waitFor(() =>
      expect(app.tui.render(100).join("\n")).toContain("Queue · 2 next"),
    );

    finishFirstTurn?.();
    await first;
    await app.stop();
  });

  it("submits follow-ups to the runtime-owned queue and never drains them in the CLI", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishFirstTurn: (() => void) | undefined;
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage(req: SendMessageReq) {
        const content = req.content ?? "";
        if (content === "First turn") {
          await new Promise<void>((resolve) => {
            finishFirstTurn = resolve;
          });
        }
        yield { type: "delta", content: `Reply to ${content || "attachment"}` };
        yield { type: "done" };
      },
    );
    const attachment = {
      type: "file" as const,
      filePath: "/workspace/notes.md",
      fileName: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: 32,
    };
    const queued: Array<{
      itemId: string;
      sessionId: string;
      status: string;
      content: string;
    }> = [];
    vi.mocked(runtime.enqueueMessage).mockImplementation(
      async (sessionId, content) => {
        const item = {
          itemId: `queue-${queued.length + 1}`,
          sessionId,
          status: "queued",
          content,
        };
        queued.push(item);
        return {
          itemId: item.itemId,
          status: item.status,
          position: queued.length,
        };
      },
    );
    vi.mocked(runtime.listQueuedMessages).mockImplementation(async () => [
      ...queued,
    ]);
    vi.mocked(runtime.deleteQueuedMessage).mockImplementation(
      async (_sessionId, itemId) => {
        const index = queued.findIndex((item) => item.itemId === itemId);
        if (index < 0) return undefined;
        return queued.splice(index, 1)[0];
      },
    );
    const readClipboardImage = vi.fn(async () => ({
      attachment,
      dispose: vi.fn(async () => undefined),
    }));
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      readClipboardImage,
    });

    app.start();
    await app.ready;
    const first = app.submit("First turn");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().activeTurnId).toEqual(
        expect.any(String),
      ),
    );
    terminal.input?.("\x16");
    await vi.waitFor(() => expect(readClipboardImage).toHaveBeenCalledOnce());
    await app.submit("Second turn");
    await app.submit("Third turn");

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.enqueueMessage).toHaveBeenNthCalledWith(
      1,
      "session-1",
      "Second turn",
      {
        attachments: [attachment],
        model: { providerId: "minimax", modelId: "MiniMax-M2.7" },
      },
    );
    expect(runtime.enqueueMessage).toHaveBeenNthCalledWith(
      2,
      "session-1",
      "Third turn",
      {
        attachments: [],
        model: { providerId: "minimax", modelId: "MiniMax-M2.7" },
      },
    );
    expect(app.transcript.get("queue:queue-1")).toBeUndefined();
    expect(app.transcript.get("queue:queue-2")).toBeUndefined();
    const queuedUi = app.tui.render(80).join("\n");
    expect(queuedUi).toContain("Queue · 2 next");
    expect(queuedUi).toContain("after current response");
    expect(queuedUi).toContain("Second turn");
    expect(queuedUi).toContain("Third turn");
    expect(queuedUi).toContain("/queue manage");

    await app.submit("/queue");
    expect(app.interaction.render(80).join("\n")).toContain("Queue");
    expect(app.interaction.render(80).join("\n")).toContain("2 next");
    expect(app.interaction.render(80).join("\n")).toContain("› 2. Third turn");
    expect(app.editor.getText()).toBe("");
    terminal.input?.("d");
    expect(app.interaction.render(80).join("\n")).toContain(
      "Remove this next message?",
    );
    terminal.input?.("\r");
    await vi.waitFor(() =>
      expect(runtime.deleteQueuedMessage).toHaveBeenCalledWith(
        "session-1",
        "queue-2",
      ),
    );
    await vi.waitFor(() =>
      expect(app.tui.render(80).join("\n")).not.toContain("Third turn"),
    );
    expect(app.tui.render(80).join("\n")).toContain("Second turn");
    terminal.input?.("\x1b");

    finishFirstTurn?.();
    await first;

    expect(
      vi.mocked(runtime.sendMessage).mock.calls.map((call) => call[0].content),
    ).toEqual(["First turn"]);
    expect(app.tui.render(80).join("\n")).toContain(
      "Next · after current response",
    );
    expect(app.tui.render(80).join("\n")).toContain("Second turn");
    expect(app.tui.render(80).join("\n")).not.toContain("Sending next");
    await app.stop();
  });

  it("uses the Runtime queue when a resumed started session is active before queue/model hydration finishes", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let releaseQueue: ((items: TuiQueuedMessage[]) => void) | undefined;
    const slowQueue = new Promise<TuiQueuedMessage[]>((resolve) => {
      releaseQueue = resolve;
    });
    let releaseModels: ((models: TuiModel[]) => void) | undefined;
    const slowModels = new Promise<TuiModel[]>((resolve) => {
      releaseModels = resolve;
    });
    const session = {
      sessionId: "session-running",
      title: "Running session",
      workspaceDir: "/workspace",
      status: "started",
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([session]);
    vi.mocked(runtime.getSession).mockResolvedValue(session);
    vi.mocked(runtime.getActiveRun).mockResolvedValue({
      schemaVersion: 1,
      sessionId: "session-running",
      state: "running",
      turnId: "turn-running",
      actions: { steer: true },
    });
    vi.mocked(runtime.listQueuedMessages).mockImplementation(
      async () => slowQueue,
    );
    vi.mocked(runtime.listModels).mockImplementation(async (sessionId) =>
      sessionId ? slowModels : [],
    );
    vi.mocked(runtime.enqueueMessage).mockResolvedValue({
      itemId: "queue-running-1",
      status: "queued",
      position: 1,
    });
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      productFeatures: { queue: true },
    });

    await app.ready;
    const resuming = app.submit("/resume session-running");
    await vi.waitFor(() =>
      expect(app.tui.render(80).join("\n")).toContain("Loading"),
    );
    expect(app.tui.render(80).join("\n")).not.toContain("Loading · 0s");

    const followUp = app.submit("Send this through the Runtime queue");
    await vi.waitFor(() =>
      expect(runtime.enqueueMessage).toHaveBeenCalledWith(
        "session-running",
        "Send this through the Runtime queue",
        { attachments: [] },
      ),
    );
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    releaseQueue?.([]);
    releaseModels?.([]);
    await Promise.all([resuming, followUp]);
    await app.stop();
  });

  it("does not recover a terminal session as an active turn", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const session = {
      sessionId: "session-finished",
      title: "Finished session",
      workspaceDir: "/workspace",
      status: "finished",
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([session]);
    vi.mocked(runtime.getSession).mockResolvedValue(session);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    await app.submit("/resume session-finished");

    expect(app.tui.render(80).join("\n")).not.toContain("Esc to interrupt");
    expect(app.tui.render(80).join("\n")).toContain("Message · Enter send");
    await app.stop();
  });

  it("does not recover a stale started Session when Runtime is already idle", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const session = {
      sessionId: "session-stale",
      title: "Stale session",
      workspaceDir: "/workspace",
      status: "started",
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([session]);
    vi.mocked(runtime.getSession).mockResolvedValue(session);

    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/resume session-stale");
    await vi.waitFor(() =>
      expect(app.tui.render(80).join("\n")).not.toContain("Loading"),
    );

    const rendered = app.tui.render(80).join("\n");
    expect(rendered).not.toContain("Thinking");
    expect(rendered).not.toContain("Stopping response");
    expect(rendered).not.toContain("Stopping the current response");
    expect(rendered).toContain("Message · Enter send");
    await app.stop();
  });

  it("stops a recovered Runtime turn with /stop and Escape through abortSession", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const session = {
      sessionId: "session-running",
      title: "Running session",
      workspaceDir: "/workspace",
      status: "started",
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([session]);
    vi.mocked(runtime.getSession).mockResolvedValue(session);
    vi.mocked(runtime.getActiveRun).mockResolvedValue({
      schemaVersion: 1,
      sessionId: "session-running",
      state: "running",
      turnId: "turn-running",
      actions: { steer: true },
    });
    vi.mocked(runtime.abortSession).mockResolvedValue(true);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/resume session-running");
    await app.submit("/stop");
    expect(runtime.abortSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-running" }),
    );
    expect(app.tui.render(80).join("\n")).not.toContain("Esc to interrupt");

    vi.mocked(runtime.abortSession).mockClear();
    await app.submit("/resume session-running");
    terminal.input?.("\x1b");
    await vi.waitFor(() =>
      expect(runtime.abortSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: "session-running" }),
      ),
    );
    await vi.waitFor(() =>
      expect(app.tui.render(80).join("\n")).not.toContain("Esc to interrupt"),
    );
    expect(app.tui.render(80).join("\n")).not.toMatch(
      /Stopped after|Interrupted after/u,
    );
    await app.stop();
  });

  it.each([
    [
      "rejects the abort",
      async () => false,
      "Runtime did not confirm that the active response stopped.",
    ],
    [
      "fails the abort request",
      async () => Promise.reject(new Error("connection lost")),
      "Couldn't stop the current response:",
    ],
  ])(
    "clears the recovered foreground projection and reports when Runtime %s",
    async (_label, abort, expectedError) => {
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      const session = {
        sessionId: "session-running",
        title: "Running session",
        workspaceDir: "/workspace",
        status: "started",
      };
      vi.mocked(runtime.listSessions).mockResolvedValue([session]);
      vi.mocked(runtime.getSession).mockResolvedValue(session);
      vi.mocked(runtime.getActiveRun).mockResolvedValue({
        schemaVersion: 1,
        sessionId: "session-running",
        state: "running",
        turnId: "turn-running",
        actions: { steer: false },
      });
      vi.mocked(runtime.abortSession).mockImplementation(abort);
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
      });

      app.start();
      await app.ready;
      await app.submit("/resume session-running");
      terminal.input?.("\x1b");

      await vi.waitFor(() =>
        expect(runtime.abortSession).toHaveBeenCalledWith(
          expect.objectContaining({ id: "session-running" }),
        ),
      );
      await vi.waitFor(() =>
        expect(app.tui.render(80).join("\n")).not.toContain("Esc to interrupt"),
      );
      await vi.waitFor(() =>
        expect(app.tui.render(80).join("\n")).toContain(expectedError),
      );
      await app.stop();
    },
  );

  it("keeps Request failed visible when Runtime still has queued follow-ups", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let finishTurn: (() => void) | undefined;
    const queued = [
      {
        itemId: "queue-after-error",
        sessionId: "session-1",
        status: "queued",
        content: "Continue after failure",
      },
    ];
    vi.mocked(runtime.listQueuedMessages).mockResolvedValue(queued);
    vi.mocked(runtime.enqueueMessage).mockResolvedValue({
      itemId: "queue-after-error",
      status: "queued",
      position: 1,
    });
    vi.mocked(runtime.sendMessage).mockImplementation(
      async function* sendMessage() {
        await new Promise<void>((resolve) => {
          finishTurn = resolve;
        });
        yield { type: "error", message: "provider unavailable" };
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      productFeatures: { queue: true },
    });

    await app.ready;
    const first = app.submit("First turn");
    await vi.waitFor(() =>
      expect(app.controller.snapshot().activeTurnId).toEqual(
        expect.any(String),
      ),
    );
    await app.submit("Continue after failure");
    finishTurn?.();
    await first;

    expect(app.tui.render(80).join("\n")).toContain(
      "Error  The model provider is temporarily unavailable.",
    );
    expect(app.tui.render(80).join("\n")).not.toContain("Request failed");
    await app.stop();
  });

  it("converges a recovered running state after the Runtime emits a terminal event", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const session = {
      sessionId: "session-recovered",
      title: "Recovered session",
      workspaceDir: "/workspace",
      status: "started",
    };
    const busEvents: TuiRuntimeEvent[] = [];
    let wakeBus: (() => void) | undefined;
    const waitForNextBusEvent = (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        wakeBus = resolve;
        signal.addEventListener("abort", resolve, { once: true });
      });
    vi.mocked(runtime.listSessions).mockResolvedValue([session]);
    vi.mocked(runtime.getSession).mockResolvedValue(session);
    let activeRecoveredTurn = true;
    vi.mocked(runtime.getActiveRun).mockImplementation(async () =>
      activeRecoveredTurn
        ? {
            schemaVersion: 1,
            sessionId: "session-recovered",
            state: "running",
            turnId: "turn-recovered",
            actions: { steer: true },
          }
        : {
            schemaVersion: 1,
            sessionId: "session-recovered",
            state: "terminal",
            turnId: "turn-recovered",
            actions: { steer: false },
          },
    );
    let durableMessages: Awaited<ReturnType<TuiRuntime["getMessages"]>> = [];
    vi.mocked(runtime.getMessages).mockImplementation(
      async () => durableMessages,
    );
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        while (!signal.aborted) {
          if (busEvents.length === 0) await waitForNextBusEvent(signal);
          if (signal.aborted) return;
          const event = busEvents.shift();
          if (event) yield event;
        }
      },
    );
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/resume session-recovered");
    expect(app.tui.render(80).join("\n")).toContain("Loading");
    expect(app.tui.render(80).join("\n")).not.toContain("Loading · 0s");
    await vi.waitFor(() =>
      expect(runtime.watchSessionTurn).toHaveBeenCalledWith(
        "session-recovered",
        "turn-recovered",
        expect.any(AbortSignal),
      ),
    );

    activeRecoveredTurn = false;
    const historyCallsBeforeTerminal = vi.mocked(runtime.getMessages).mock.calls
      .length;
    durableMessages = [
      {
        id: "message-recovered-assistant",
        turnId: "turn-recovered",
        role: "assistant",
        content: "Recovered answer",
        timestamp: 101,
      },
    ];
    busEvents.push(
      runtimeEvent({
        type: "session.finish",
        timestamp: 101,
        source: "runtime",
        payload: {
          sessionId: "session-recovered",
          turnId: "turn-recovered",
          status: "finished",
        },
      }),
    );
    wakeBus?.();
    wakeBus = undefined;

    await vi.waitFor(() =>
      expect(vi.mocked(runtime.getMessages).mock.calls.length).toBeGreaterThan(
        historyCallsBeforeTerminal,
      ),
    );
    await vi.waitFor(() => {
      const rendered = app.tui.render(80).join("\n");
      expect(rendered).not.toContain("Esc to interrupt");
      expect(app.transcript.snapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "assistant",
            content: "Recovered answer",
          }),
        ]),
      );
    });
    await app.stop();
  });

  it("clears a recovered decision block when switching to a session without a pending decision", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    let controllerSessionId = "";
    const firstSession = {
      sessionId: "session-blocked",
      title: "Blocked session",
      workspaceDir: "/workspace",
      status: "started",
    };
    const secondSession = {
      sessionId: "session-clear",
      title: "Clear session",
      workspaceDir: "/workspace",
      status: "finished",
    };
    vi.mocked(runtime.listSessions).mockResolvedValue([
      firstSession,
      secondSession,
    ]);
    vi.mocked(runtime.getSession).mockImplementation(async (sessionId) =>
      sessionId === firstSession.sessionId ? firstSession : secondSession,
    );
    vi.mocked(runtime.listPendingPermissions).mockImplementation(async () =>
      controllerSessionId === firstSession.sessionId
        ? [
            {
              requestId: "permission-blocked",
              sessionId: firstSession.sessionId,
              agentName: "mavis",
              toolName: "bash",
              reason: "Run checks",
              allowAlwaysSupported: true,
            },
          ]
        : [],
    );
    vi.mocked(runtime.getPendingQuestionnaire).mockResolvedValue(undefined);
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    controllerSessionId = firstSession.sessionId;
    await app.submit("/resume session-blocked");
    expect(app.tui.hasOverlay()).toBe(false);
    expect(app.interaction.isActive()).toBe(true);
    expect(app.tui.render(80).join("\n")).toContain("Approval required");

    controllerSessionId = secondSession.sessionId;
    await app.submit("/resume session-clear");
    expect(app.tui.hasOverlay()).toBe(false);
    const rendered = app.tui.render(80).join("\n");
    expect(rendered).not.toContain("Approval required");
    expect(rendered).not.toContain("Reply required");
    await app.stop();
  });

  it("moves a sending follow-up from the Composer area into the user transcript", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const busEvents: TuiRuntimeEvent[] = [];
    let wakeBus: (() => void) | undefined;
    const waitForNextBusEvent = (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        wakeBus = resolve;
        signal.addEventListener("abort", resolve, { once: true });
      });
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-existing",
        title: "Existing",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.listQueuedMessages).mockResolvedValue([
      {
        itemId: "queue-with-attachment",
        sessionId: "session-existing",
        status: "queued",
        content: "Review the attached plan",
        attachments: [
          {
            meta: {
              attachmentType: "file",
              fileName: "plan.md",
              mimeType: "text/markdown",
              sizeBytes: 42,
            },
            local: { filePath: "/workspace/plan.md" },
          },
        ],
      },
      {
        itemId: "queue-that-fails",
        sessionId: "session-existing",
        status: "queued",
        content: "Run the failing follow-up",
      },
    ]);
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        while (!signal.aborted) {
          if (busEvents.length === 0) await waitForNextBusEvent(signal);
          if (signal.aborted) return;
          const event = busEvents.shift();
          if (event) yield event;
        }
      },
    );
    const emitQueueStatus = (
      itemId: string,
      status: string,
      failedReason?: string,
    ) => {
      busEvents.push(
        runtimeEvent({
          type: "session.queue.updated",
          timestamp: Date.now(),
          source: "runtime",
          payload: {
            sessionId: "session-existing",
            itemId,
            status,
            queuedCount: status === "queued" ? 1 : 0,
            ...(failedReason ? { failedReason } : {}),
          },
        }),
      );
      wakeBus?.();
      wakeBus = undefined;
    };
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      productFeatures: { queue: true },
    });

    app.start();
    await app.ready;
    await app.submit("/resume session-existing");
    expect(app.tui.render(80).join("\n")).toContain("Queue · 2 next");
    expect(app.tui.render(80).join("\n")).toContain("Review the attached plan");
    expect(app.transcript.get("queue:queue-with-attachment")).toBeUndefined();

    emitQueueStatus("queue-with-attachment", "running");
    await vi.waitFor(() =>
      expect(app.transcript.get("queue:queue-with-attachment")).toMatchObject({
        kind: "user",
        status: "succeeded",
        content: expect.stringContaining("Review the attached plan"),
      }),
    );
    expect(app.tui.render(80).join("\n")).not.toContain("SENDING");
    expect(app.tui.render(80).join("\n")).toContain(
      "Next · after current response",
    );
    expect(app.tui.render(80).join("\n")).toContain(
      "Run the failing follow-up",
    );
    expect(
      app.transcript.get("queue:queue-with-attachment")?.attachments,
    ).toEqual([
      expect.objectContaining({
        fileName: "plan.md",
        mimeType: "text/markdown",
        sizeBytes: 42,
      }),
    ]);

    emitQueueStatus("queue-with-attachment", "completed");
    await vi.waitFor(() =>
      expect(app.transcript.get("queue:queue-with-attachment")).toMatchObject({
        kind: "user",
        status: "succeeded",
        content: expect.stringContaining("Review the attached plan"),
      }),
    );

    emitQueueStatus("queue-that-fails", "running");
    await vi.waitFor(() =>
      expect(app.transcript.get("queue:queue-that-fails")).toMatchObject({
        kind: "user",
        status: "succeeded",
      }),
    );
    emitQueueStatus(
      "queue-that-fails",
      "admission-rejected",
      "provider unavailable",
    );
    await vi.waitFor(() =>
      expect(app.editor.getText()).toBe("Run the failing follow-up"),
    );
    expect(app.tui.render(80).join("\n")).toContain(
      "Error  Message was not added to the Queue: provider unavailable.",
    );
    expect(app.transcript.get("queue:queue-that-fails")).toMatchObject({
      kind: "user",
      status: "succeeded",
    });
    expect(app.tui.render(80).join("\n")).toContain(
      "Run the failing follow-up",
    );

    await app.stop();
  });

  it("refreshes history when Desktop Runtime finishes an auto-drained queued turn", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const busEvents: TuiRuntimeEvent[] = [];
    let wakeBus: (() => void) | undefined;
    const waitForNextBusEvent = (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        wakeBus = resolve;
        signal.addEventListener("abort", resolve, { once: true });
      });
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-existing",
        title: "Existing",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.getMessages)
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          id: "message-user-queued",
          turnId: "turn-queued",
          role: "user",
          content: "Runtime follow-up",
          timestamp: 100,
        },
        {
          id: "message-assistant-queued",
          turnId: "turn-queued",
          role: "assistant",
          content: "Runtime follow-up answer",
          timestamp: 101,
        },
      ]);
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        while (!signal.aborted) {
          if (busEvents.length === 0) {
            await waitForNextBusEvent(signal);
          }
          if (signal.aborted) return;
          const event = busEvents.shift();
          if (event) yield event;
        }
      },
    );
    const emit = (event: RawTuiRuntimeEvent) => {
      busEvents.push(runtimeEvent(event));
      wakeBus?.();
      wakeBus = undefined;
    };
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    app.start();
    await app.ready;
    await app.submit("/resume session-existing");
    emit({
      type: "session.start",
      timestamp: 100,
      source: "runtime",
      payload: {
        sessionId: "session-existing",
        turnId: "turn-queued",
        source: "queued-drain",
        queueItemIds: ["queue-1"],
      },
    });
    await vi.waitFor(() =>
      expect(app.tui.render(80).join("\n")).toContain("Loading"),
    );
    expect(app.tui.render(80).join("\n")).not.toContain("Loading · 0s");
    expect(runtime.watchSessionTurn).toHaveBeenCalledWith(
      "session-existing",
      "turn-queued",
      expect.any(AbortSignal),
    );
    emit({
      type: "session.finish",
      timestamp: 101,
      source: "runtime",
      payload: {
        sessionId: "session-existing",
        turnId: "turn-queued",
        status: "finished",
      },
    });

    await vi.waitFor(() =>
      expect(app.transcript.snapshot()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "assistant",
            content: "Runtime follow-up answer",
          }),
        ]),
      ),
    );
    const historyProjectionCalls = vi
      .mocked(runtime.getMessages)
      .mock.calls.filter(
        ([sessionId, limit]) =>
          sessionId === "session-existing" && limit === undefined,
      );
    expect(historyProjectionCalls).toHaveLength(2);
    await app.stop();
  });

  it("writes one structured result when an auto-drained queued turn finishes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mcode-queued-result-"));
    const resultPath = join(dataDir, "results.jsonl");
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const busEvents: TuiRuntimeEvent[] = [];
    let wakeBus: (() => void) | undefined;
    let durableMessages: Awaited<ReturnType<TuiRuntime["getMessages"]>> = [];
    vi.mocked(runtime.listSessions).mockResolvedValue([
      {
        sessionId: "session-existing",
        title: "Existing",
        workspaceDir: "/workspace",
      },
    ]);
    vi.mocked(runtime.getMessages).mockImplementation(
      async () => durableMessages,
    );
    const waitForBusEvent = (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        wakeBus = resolve;
        signal.addEventListener("abort", resolve, { once: true });
      });
    vi.mocked(runtime.watchEvents).mockImplementation(
      async function* watchEvents(signal) {
        while (!signal.aborted) {
          if (busEvents.length === 0) await waitForBusEvent(signal);
          if (signal.aborted) return;
          const event = busEvents.shift();
          if (event) yield event;
        }
      },
    );
    const emit = (event: RawTuiRuntimeEvent) => {
      busEvents.push(runtimeEvent(event));
      wakeBus?.();
      wakeBus = undefined;
    };
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
      statusLineItems: ["build-mode"],
      automationResultPath: resultPath,
    });

    try {
      app.start();
      await app.ready;
      await app.submit("/resume session-existing");
      emit({
        type: "session.start",
        timestamp: 100,
        source: "runtime",
        payload: {
          sessionId: "session-existing",
          turnId: "turn-queued-result",
          source: "queued-drain",
          queueItemIds: ["queue-result"],
        },
      });
      await vi.waitFor(() =>
        expect(runtime.watchSessionTurn).toHaveBeenCalledWith(
          "session-existing",
          "turn-queued-result",
          expect.any(AbortSignal),
        ),
      );
      durableMessages = [
        {
          id: "message-user-result",
          turnId: "turn-queued-result",
          role: "user",
          content: "Queued request",
          timestamp: 101,
        },
        {
          id: "message-assistant-result",
          turnId: "turn-queued-result",
          role: "assistant",
          content: "Queued structured answer",
          timestamp: 102,
        },
      ];
      emit({
        type: "session.finish",
        timestamp: 103,
        source: "runtime",
        payload: {
          sessionId: "session-existing",
          turnId: "turn-queued-result",
          status: "finished",
        },
      });

      await vi.waitFor(async () => {
        const records = (await readFile(resultPath, "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse);
        expect(records).toEqual([
          expect.objectContaining({
            type: "exec.result",
            sessionId: "session-existing",
            turnId: "turn-queued-result",
            status: "succeeded",
            answer: "Queued structured answer",
          }),
        ]);
      });
      expect(app.controller.snapshot().lastSettledTurn).toEqual({
        sessionId: "session-existing",
        turnId: "turn-queued-result",
        status: "succeeded",
      });
    } finally {
      await app.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps a scrolled host viewport in place when a long streamed answer finishes", async () => {
    const terminal = new FakeTerminal();
    const screen = new VirtualTerminal(terminal.columns, terminal.rows);
    const runtime = createRuntime();
    let finish: (() => void) | undefined;
    const answer = Array.from({ length: 80 }, (_, index) => `Answer ${index}`).join("\n\n");
    vi.mocked(runtime.sendMessage).mockImplementation(async function* () {
      yield { type: "delta", content: answer };
      await new Promise<void>((resolve) => { finish = resolve; });
      yield { type: "done" };
    });
    const app = createTuiApp({ runtime, terminal, version: "0.1.0", workspaceDir: "/workspace" });
    let writeIndex = 0;
    const flush = async () => {
      app.tui.renderNow();
      for (; writeIndex < terminal.writes.length; writeIndex++) screen.write(terminal.writes[writeIndex]!);
      await screen.flush();
    };
    app.start();
    try {
      await app.ready;
      const sending = app.submit("Write a long answer");
      await vi.waitFor(() => expect(app.tui.render(80).join("\n")).toContain("Answer 79"));
      await flush();
      screen.scrollLines(-10);
      const before = screen.getScrollPosition();
      expect(before.viewport).toBeGreaterThan(0);
      const start = writeIndex;
      finish?.();
      await sending;
      await flush();
      expect(screen.getScrollPosition().viewport).toBe(before.viewport);
      expect(terminal.writes.slice(start).join("")).not.toContain("\x1b[3J");
      for (let index = 0; index < 80; index++) {
        expect(screen.getScrollBuffer().filter((line) => line.match(/Answer (\d+)/u)?.[1] === String(index))).toHaveLength(1);
      }
      screen.scrollLines(10000);
      expect(screen.getViewport().join("\n")).toContain("Ask Mcode to do anything");
    } finally {
      finish?.();
      await app.stop();
    }
  });

  it.each([1, 100])(
    "settles an auto-drained follow-up of %i lines with unique terminal history",
    async (lineCount) => {
      const queuedText = Array.from(
        { length: lineCount },
        (_, i) => `Queue line ${i}: 合成测试文字`,
      ).join("\n");
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      const busEvents: TuiRuntimeEvent[] = [];
      const queuedItems: TuiQueuedMessage[] = [];
      let wakeBus: (() => void) | undefined;
      let finishFirstTurn: (() => void) | undefined;
      let finishQueuedStream: (() => void) | undefined;
      const queuedStreamClosed = vi.fn();
      let durableMessages: Awaited<ReturnType<TuiRuntime["getMessages"]>> = [];
      const waitForNextBusEvent = (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          wakeBus = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
      vi.mocked(runtime.sendMessage).mockImplementation(
        async function* sendMessage() {
          await new Promise<void>((resolve) => {
            finishFirstTurn = resolve;
          });
          yield { type: "delta", content: "First answer" };
          yield { type: "done" };
        },
      );
      vi.mocked(runtime.watchSessionTurn).mockImplementation(
        async function* watchSessionTurn() {
          try {
            await new Promise<void>((resolve) => {
              finishQueuedStream = resolve;
            });
            yield { type: "delta", content: "Queued answer" };
            yield { type: "done" };
          } finally {
            queuedStreamClosed();
          }
        },
      );
      vi.mocked(runtime.enqueueMessage).mockImplementation(
        async (sessionId, content) => {
          const item: TuiQueuedMessage = {
            itemId: "queue-b",
            sessionId,
            status: "queued",
            content,
          };
          queuedItems.push(item);
          return { itemId: item.itemId, status: item.status, position: 1 };
        },
      );
      vi.mocked(runtime.listQueuedMessages).mockImplementation(async () => [
        ...queuedItems,
      ]);
      vi.mocked(runtime.getMessages).mockImplementation(
        async () => durableMessages,
      );
      vi.mocked(runtime.watchEvents).mockImplementation(
        async function* watchEvents(signal) {
          while (!signal.aborted) {
            if (busEvents.length === 0) await waitForNextBusEvent(signal);
            if (signal.aborted) return;
            const event = busEvents.shift();
            if (event) yield event;
          }
        },
      );
      const emit = (event: RawTuiRuntimeEvent) => {
        busEvents.push(runtimeEvent(event));
        wakeBus?.();
        wakeBus = undefined;
      };
      const app = createTuiApp({
        runtime,
        terminal,
        version: "0.1.0",
        workspaceDir: "/workspace",
        productFeatures: { queue: true },
      });

      const screen = new VirtualTerminalScreen(terminal.columns, terminal.rows);
      let writeIndex = 0;
      const assertScreen = () => {
        app.tui.renderNow();
        for (; writeIndex < terminal.writes.length; writeIndex++)
          screen.feed(terminal.writes[writeIndex]!);
        const expected = stripAnsi(app.tui.render(terminal.columns).join("\n"))
          .split("\n")
          .map((line) => line.trimEnd())
          .join("\n")
          .trimEnd();
        expect(screen.text()).toBe(expected);
      };
      app.start();
      try {
        await app.ready;
        const first = app.submit("A");
        await vi.waitFor(() =>
          expect(app.controller.snapshot().activeTurnId).toBeDefined(),
        );
        terminal.input?.(`\x1b[200~${queuedText}\x1b[201~`);
        assertScreen();
        terminal.input?.("\x1b\r");
        await vi.waitFor(() =>
          expect(runtime.enqueueMessage).toHaveBeenCalledOnce(),
        );
        await vi.waitFor(() => expect(app.editor.getText()).toBe(""));
        expect(vi.mocked(runtime.enqueueMessage).mock.calls[0]?.[1]).toBe(queuedText);
        expect(app.tui.render(80).join("\n")).toContain(
          "Next · after current response",
        );
        expect(app.tui.render(80).join("\n")).toContain("Queue line 0:");

        assertScreen();
        finishFirstTurn?.();
        await first;
        const queuedItem = queuedItems[0];
        expect(queuedItem).toBeDefined();
        if (!queuedItem) throw new Error("Expected B to be queued.");
        queuedItems[0] = { ...queuedItem, status: "running" };
        emit({
          type: "session.queue.updated",
          timestamp: 200,
          source: "runtime",
          payload: {
            sessionId: "session-1",
            itemId: "queue-b",
            status: "running",
            queuedCount: 0,
          },
        });
        emit({
          type: "session.start",
          timestamp: 201,
          source: "runtime",
          payload: {
            sessionId: "session-1",
            turnId: "turn_queue_b",
            source: "queued-drain",
            queueItemIds: ["queue-b"],
          },
        });
        await vi.waitFor(() =>
          expect(app.tui.render(80).join("\n")).toContain("Loading"),
        );
        expect(app.tui.render(80).join("\n")).not.toContain("Loading · 0s");

        assertScreen();
        queuedItems.length = 0;
        durableMessages = [
          {
            id: "history-user-a",
            turnId: "turn_a",
            role: "user",
            content: "A",
            timestamp: 100,
          },
          {
            id: "history-assistant-a",
            turnId: "turn_a",
            role: "assistant",
            content: "First answer",
            timestamp: 101,
          },
          {
            id: "history-user-b",
            turnId: "turn_queue_b",
            role: "user",
            content: queuedText,
            timestamp: 202,
          },
          {
            id: "history-assistant-b",
            turnId: "turn_queue_b",
            role: "assistant",
            content: "Queued answer",
            timestamp: 203,
          },
        ];
        finishQueuedStream?.();
        await vi.waitFor(() =>
          expect(queuedStreamClosed).toHaveBeenCalledOnce(),
        );
        emit({
          type: "session.finish",
          timestamp: 3_201,
          source: "runtime",
          payload: {
            sessionId: "session-1",
            turnId: "turn_queue_b",
            status: "finished",
          },
        });

        await vi.waitFor(() =>
          expect(
            app.transcript
              .snapshot()
              .filter((cell) => cell.content === "Queued answer"),
          ).toHaveLength(1),
        );
        await vi.waitFor(() =>
          expect(
            app.transcript.get("turn-duration:turn_queue_b"),
          ).toMatchObject({
            status: "succeeded",
            durationMs: 3_000,
          }),
        );
        const settledUi = app.tui.render(80).join("\n");
        expect(settledUi).toContain("Completed in 3s");
        expect(settledUi.indexOf("Completed in 3s")).toBeGreaterThan(
          settledUi.indexOf("Queued answer"),
        );
        expect(settledUi).not.toContain("message waiting");
        expect(settledUi).not.toContain("Next · after current response");
        assertScreen();
      } finally {
        finishFirstTurn?.();
        finishQueuedStream?.();
        await app.stop();
        screen.dispose();
      }
    },
  );

  it("records submitted drafts in editor history", async () => {
    const terminal = new FakeTerminal();
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal,
      version: "0.1.0",
      workspaceDir: "/workspace",
    });

    await app.ready;
    app.editor.setText("Remember this draft");
    app.editor.handleInput("\r");
    await vi.waitFor(() =>
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1),
    );
    app.editor.handleInput("\u001b[A");

    expect(app.editor.getText()).toBe("Remember this draft");
  });

  it("continues sending and switching sessions when draft cleanup fails", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mcode-app-draft-warning-"));
    const runtime = createRuntime();
    const app = createTuiApp({
      runtime,
      terminal: new FakeTerminal(),
      version: "0.1.0",
      dataDir,
      workspaceDir: "/workspace",
    });
    const flush = vi.spyOn(TuiDraftRecovery.prototype, "flush");
    try {
      await app.ready;
      flush.mockRejectedValue(
        new TuiDraftRecoveryError("cleanup", new Error("deletion denied")),
      );
      app.editor.setText("hello");
      app.editor.handleInput("\r");
      await vi.waitFor(() =>
        expect(
          app.transcript.snapshot().filter((cell) => cell.kind === "warning"),
        ).toHaveLength(1),
      );
      const warnings = app.transcript
        .snapshot()
        .filter((cell) => cell.kind === "warning");
      expect(warnings[0]?.content).toContain(
        composerText("draftCleanupNextStep"),
      );
      expect(warnings[0]?.content).not.toContain(
        composerText("draftRecoveryUnavailable"),
      );
      expect(warnings[0]?.content).toContain("deletion denied");
      await vi.waitFor(() =>
        expect(runtime.sendMessage).toHaveBeenCalledOnce(),
      );
      await vi.waitFor(() =>
        expect(app.controller.snapshot().activeTurnId).toBeUndefined(),
      );
      await expect(app.openSession("session-2")).resolves.toBeUndefined();
      expect(app.controller.snapshot().session?.sessionId).toBe("session-2");
      app.editor.setText("after switching");
      app.editor.handleInput("\r");
      await vi.waitFor(() =>
        expect(runtime.sendMessage).toHaveBeenCalledTimes(2),
      );
      await expect(app.stop()).resolves.toBeUndefined();
    } finally {
      await app.stop();
      flush.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not read or restore a persisted Draft during TUI startup", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mcode-app-draft-"));
    try {
      const first = createTuiApp({
        runtime: createRuntime(),
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace/recovery",
      });
      await first.ready;
      first.editor.setText("/exit");
      await first.stop();

      const loadDraft = vi.spyOn(TuiDraftRecovery.prototype, "load");
      const restored = createTuiApp({
        runtime: createRuntime(),
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace/recovery",
      });
      await restored.ready;

      expect(loadDraft).not.toHaveBeenCalled();
      expect(restored.editor.getText()).toBe("");
      expect(restored.tui.render(80).join("\n")).not.toContain(
        "Draft restored",
      );
      loadDraft.mockRestore();

      restored.editor.setText("");
      await restored.stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not resume a persisted Draft during startup when login recovery is enabled", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mcode-login-restart-draft-"));
    try {
      const first = createTuiApp({
        runtime: createRuntime(),
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace/login-recovery",
      });
      await first.ready;
      first.editor.setText("send after Global login");
      await first.stop();

      const restored = createTuiApp({
        runtime: createRuntime(),
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace/login-recovery",
        resumeDraftAfterLogin: true,
      });
      await restored.ready;
      restored.start();

      expect(restored.editor.getText()).toBe("");
      expect(restored.getSurface()).toBe("welcome");
      expect(restored.tui.render(80).join("\n")).toContain(
        "Tips for getting started",
      );
      await restored.stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps the submitted Draft recoverable when shutdown wins before Runtime admission", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mcode-app-pending-draft-"));
    try {
      const runtime = createRuntime();
      vi.spyOn(runtime, "sendMessage").mockImplementation(
        async function* sendMessage(
          _req: SendMessageReq,
          signal?: AbortSignal,
        ) {
          yield* [];
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("admission aborted")),
              {
                once: true,
              },
            );
          });
          throw new Error("unreachable");
        },
      );
      const first = createTuiApp({
        runtime,
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace/pending-recovery",
      });
      await first.ready;
      first.editor.setText("recover me until Runtime accepts");
      await new Promise((resolve) => setTimeout(resolve, 300));

      first.editor.handleInput("\r");
      await vi.waitFor(() =>
        expect(runtime.sendMessage).toHaveBeenCalledOnce(),
      );
      await first.stop();

      const restored = createTuiApp({
        runtime: createRuntime(),
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace/pending-recovery",
      });
      await restored.ready;
      await restored.openSession("session-1");

      expect(restored.editor.getText()).toBe(
        "recover me until Runtime accepts",
      );
      const rendered = restored.tui.render(80).join("\n");
      expect(rendered).toContain("recover me until Runtime accepts");
      expect(rendered).not.toContain("Message kept under Failed");
      await restored.stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not restore a submitted Draft after Runtime accepts the turn", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mcode-app-accepted-draft-"));
    try {
      const runtime = createRuntime();
      vi.mocked(runtime.sendMessage).mockImplementation(
        async function* sendMessage(
          _req: SendMessageReq,
          signal?: AbortSignal,
        ) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          });
          yield { type: "done" };
        },
      );
      const first = createTuiApp({
        runtime,
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace/accepted-recovery",
      });
      await first.ready;
      first.editor.setText("already accepted by Runtime");
      await new Promise((resolve) => setTimeout(resolve, 300));

      first.editor.handleInput("\r");
      await vi.waitFor(() =>
        expect(runtime.sendMessage).toHaveBeenCalledOnce(),
      );
      await first.stop();

      const restored = createTuiApp({
        runtime: createRuntime(),
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace/accepted-recovery",
      });
      await restored.ready;

      expect(restored.editor.getText()).toBe("");
      await restored.stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("serializes rapid Session switches without mixing their Drafts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mcode-app-draft-"));
    try {
      const app = createTuiApp({
        runtime: createRuntime(),
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace/recovery",
      });
      await app.ready;
      await app.openSession("session-a");
      app.editor.setText("Draft for Session A");
      await app.openSession("session-b");
      app.editor.setText("Draft for Session B");

      await Promise.all([
        app.openSession("session-a"),
        app.openSession("session-b"),
      ]);

      expect(app.controller.snapshot().session?.sessionId).toBe("session-b");
      expect(app.editor.getText()).toBe("Draft for Session B");
      await app.openSession("session-a");
      expect(app.editor.getText()).toBe("Draft for Session A");
      await app.openSession("session-b");
      expect(app.editor.getText()).toBe("Draft for Session B");
      await app.stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("moves to the new-session Draft namespace after archiving the current Session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mcode-app-draft-"));
    try {
      const app = createTuiApp({
        runtime: createRuntime(),
        terminal: new FakeTerminal(),
        version: "0.1.0",
        dataDir,
        workspaceDir: "/workspace/recovery",
      });
      await app.ready;
      await app.openSession("session-a");
      app.editor.setText("Archived Session Draft");

      await app.submit("/archive");
      app.editor.setText("Fresh Session Draft");
      await app.openSession("session-a");
      expect(app.editor.getText()).toBe("Archived Session Draft");

      await app.submit("/new");
      expect(app.editor.getText()).toBe("Fresh Session Draft");
      await app.stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("interactive CLI model startup", () => {
  it.each([
    [
      "new with prompt",
      ["-m", "custom_provider:relay/vendor/model#thinking", "hello"],
      "session-1",
      true,
    ],
    [
      "new without prompt",
      ["--model=custom_provider:relay/vendor/model#thinking"],
      "session-1",
      false,
    ],
    [
      "explicit session",
      ["--session", "existing", "--model", "custom_provider:relay/vendor/model#thinking", "hello"],
      "existing",
      true,
    ],
    [
      "continue",
      ["--continue", "--model", "custom_provider:relay/vendor/model#thinking", "hello"],
      "existing",
      true,
    ],
    [
      "missing session",
      ["--session", "missing", "-m", "custom_provider:relay/vendor/model#thinking", "hello"],
      "missing",
      false,
    ],
    [
      "empty continue",
      ["--continue", "-m", "custom_provider:relay/vendor/model#thinking", "hello"],
      "existing",
      false,
    ],
    ["invalid provider", ["--model", "missing/model", "hello"], "session-1", false],
    ["invalid model", ["--model", "custom_provider:relay/missing", "hello"], "session-1", false],
  ] as const)(
    "routes %s through launch, hydration and submission",
    async (_name, args, sessionId, hasPrompt) => {
      const dataDir = await mkdtemp(join(tmpdir(), "mcode-model-startup-"));
      const terminal = new FakeTerminal();
      const runtime = createRuntime();
      runtime.listBackgroundTasks = vi.fn(async () => []);
      const models = new Map<string, { providerId: string; modelId: string; variant?: string }>();
      const requested = {
        providerId: "custom_provider:relay",
        modelId: "vendor/model",
        variant: "thinking",
      };
      const existing = { sessionId: "existing", workspaceDir: "/workspace", updatedAt: 10 };
      vi.mocked(runtime.listSessions).mockResolvedValue([existing]);
      vi.mocked(runtime.listSessionPage).mockResolvedValue({
        sessions: [existing],
        hasMore: false,
      });
      vi.mocked(runtime.getSession).mockImplementation(async (id) => ({
        sessionId: id,
        workspaceDir: "/workspace",
        model: models.get(id),
      }));
      const failedResume = _name === "missing session" || _name === "empty continue";
      if (_name === "missing session")
        vi.mocked(runtime.getSession).mockRejectedValue(new Error("Session not found"));
      if (_name === "empty continue") vi.mocked(runtime.listSessions).mockResolvedValue([]);
      runtime.selectModel = vi.fn(async () => true);
      runtime.selectSessionModel = vi.fn(async (model, id) => {
        if (model.providerId !== requested.providerId || model.modelId !== requested.modelId) {
          throw new Error("Unknown provider or model");
        }
        models.set(id, model);
        return true;
      });
      vi.mocked(runtime.listModels).mockImplementation(async (id) => [
        { ...requested, name: "Startup model", selected: Boolean(id && models.has(id)) },
      ]);
      // A global managed default needs login; the selected BYOK Session does not.
      vi.mocked(runtime.getAccountStatus).mockImplementation(async (id) => ({
        status: id && models.has(id) ? "ready" : "needs-login",
        modelSource: id && models.has(id) ? "byok" : "token-plan",
        managedTokenPresent: false,
        warnings: [],
      }));
      const sentModels: unknown[] = [];
      vi.mocked(runtime.sendMessage).mockImplementation(async function* (request) {
        sentModels.push(models.get(request.id));
        yield { type: "delta", content: "offline reply" };
        yield { type: "done" };
      });
      const invalid = _name.startsWith("invalid");
      const stderr = vi.fn((_text: string, callback?: () => void) => callback?.());
      const processRef = {
        title: "test",
        argv: ["node", "cli.js", ...args],
        env: {},
        versions: { node: "24.2.0" },
        stdout: {
          destroyed: false,
          writableEnded: false,
          write: vi.fn((_text: string, cb?: () => void) => cb?.()),
        },
        stderr: { destroyed: false, writableEnded: false, write: stderr },
        exit: vi.fn(),
        exitCode: 0,
      };
      let app: ReturnType<typeof createTuiApp> | undefined;
      const running = runTuiCli({
        processRef,
        configureNetworkProxy: () => undefined,
        launchTui: (input) =>
          launchTui(
            { ...input, dataDir, terminal, workspaceDir: "/workspace" },
            {
              createObservability,
              readTelemetryEnabled: () => false,
              installProcessGuards: () => () => undefined,
              loadRuntimeLifecycle: async () => ({
                createTuiRuntime: async () => ({ adapter: runtime }) as never,
                shutdownTuiRuntime: async () => false,
              }),
              loadUpdateApplication: async () =>
                ({ inspect: async () => ({ status: "up-to-date" }) }) as never,
              createApp: (options) => {
                app = createTuiApp({ ...options, productFeatures: { queue: false } });
                return app;
              },
              writeExitMessage: () => undefined,
            },
          ),
      });
      try {
        if (invalid) {
          await running;
          expect(processRef.exitCode).toBe(1);
          expect(stderr.mock.calls.flat().join(" ")).toContain("Unknown provider or model");
          expect(runtime.sendMessage).not.toHaveBeenCalled();
        } else if (failedResume) {
          await vi.waitFor(() => expect(app?.editor.disableSubmit).toBe(false));
          expect(runtime.selectSessionModel).not.toHaveBeenCalled();
          expect(runtime.createSession).not.toHaveBeenCalled();
          expect(runtime.sendMessage).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(() => {
            expect(app?.editor.disableSubmit).toBe(false);
            expect(app?.controller.snapshot().session?.model).toEqual(requested);
            if (hasPrompt) expect(sentModels).toEqual([requested]);
          });
          expect(runtime.selectSessionModel).toHaveBeenCalledWith(requested, sessionId);
          expect(app?.controller.snapshot().account?.modelSource).toBe("byok");
          if (sessionId === "existing") expect(runtime.createSession).not.toHaveBeenCalled();
          if (!hasPrompt) {
            expect(runtime.sendMessage).not.toHaveBeenCalled();
            await app?.submit("later prompt");
            expect(sentModels).toEqual([requested]);
          }
          await vi.waitFor(() => expect(app?.controller.snapshot().status).toBe("idle"));
          await app?.submit("/new");
          expect(app?.controller.snapshot().session).toBeUndefined();
          expect(runtime.selectSessionModel).toHaveBeenCalledOnce();
        }
        expect(runtime.selectModel).not.toHaveBeenCalled();
      } finally {
        await app?.stop();
        await running;
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );
});

describe("interactive model argument contract", () => {
  function program() {
    const launch = vi.fn(async () => undefined);
    const command = createTuiProgram({
      version: "test",
      launchTui: launch,
      runExec: vi.fn(),
      runLogin: vi.fn(),
      runLogout: vi.fn(),
      runUpdate: vi.fn(),
    })
      .exitOverride()
      .configureOutput({ writeErr: () => undefined });
    return { command, launch };
  }

  it.each(["-m", "--model"])("rejects missing values for %s", async (flag) => {
    const { command, launch } = program();
    await expect(command.parseAsync([flag], { from: "user" })).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(["", "bare-model", "provider/", "/model", "provider/model#"])(
    "rejects malformed model %j before launch",
    async (model) => {
      const { command, launch } = program();
      await expect(command.parseAsync(["--model", model], { from: "user" })).rejects.toThrow(
        "--model must use provider/model",
      );
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("rejects a model with an untargeted Session picker", async () => {
    const { command, launch } = program();
    await expect(
      command.parseAsync(["--session", "--model", "provider/model"], { from: "user" }),
    ).rejects.toThrow("requires a Session id");
    expect(launch).not.toHaveBeenCalled();
  });

  it("retains the default launch contract without a model", async () => {
    const { command, launch } = program();
    await command.parseAsync(["hello"], { from: "user" });
    expect(launch).toHaveBeenCalledWith({ initialPrompt: "hello" });
  });

  it.each(["-m", "--model"])("scans startup environment after %s values", (flag) => {
    expect(
      resolveTuiStartupEnvironmentOption([flag, "provider/model", "--env", "staging"], true),
    ).toBe("staging");
    expect(() =>
      resolveTuiStartupEnvironmentOption([flag, "provider/model", "--env", "prod"], false),
    ).toThrow("only available");
    expect(
      resolveTuiStartupEnvironmentOption(
        [flag, "provider/model", "exec", "--env", "staging"],
        true,
      ),
    ).toBeUndefined();
  });
});
