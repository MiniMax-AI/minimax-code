import { describe, expect, it, vi } from "vitest";

import type { TuiChatSnapshot } from "../../../../../src/tui/controller/chat-controller.js";
import type { TuiAgentInteractionReadback } from "../../../../../src/tui/controller/interaction/interaction-flow.js";
import { TuiChromeFlow } from "../../../../../src/tui/controller/product/chrome-flow.js";
import type {
  TuiActivityLineState,
  TuiComposerState,
  TuiShellState,
} from "../../../../../src/tui/shell/index.js";
import { TranscriptStore } from "../../../../../src/tui/transcript/store.js";
import {
  createTuiCommandCatalog,
  isTuiCommandDiscoverable,
  type TuiCommand,
} from "../../../../../src/tui/commands/catalog.js";

describe("TuiChromeFlow agent status sequence", () => {
  it("projects the live Draft as prompt, command, or Skill instructions", () => {
    let draft = "Explain this repository";
    const composers: TuiComposerState[] = [];
    const shellSink = { setState: vi.fn() };
    const skillCommands: readonly TuiCommand[] = [
      {
        name: "docs",
        description: "[Skill] Read project docs",
        category: "Capability",
        invocationKind: "skill",
        argumentHint: "[instructions]",
        usage: "/docs [instructions]",
        composerTemplate: "/docs ",
      },
    ];
    const flow = new TuiChromeFlow({
      version: "0.1.0",
      workspace: "/workspace",
      queueEnabled: true,
      isStarted: () => true,
      isStopped: () => false,
      setTerminalTitle: vi.fn(),
      connection: () => ({ phase: "live", generation: 1 }),
      liveRunId: () => undefined,
      runProjection: () => ({
        queuedItems: [],
        queuedCount: 0,
        queueHandoffPending: false,
      }),
      transcript: new TranscriptStore(),
      shouldResumeDraftAfterLogin: () => false,
      activePermission: () => false,
      activeQuestionnaire: () => false,
      agentInteraction: () => undefined,
      attachmentCount: () => 0,
      expandedDraft: () => draft,
      inputCommands: () => [
        ...createTuiCommandCatalog().commands.filter(isTuiCommandDiscoverable),
        ...skillCommands,
      ],
      selectedModel: () => undefined,
      permissionMode: () => undefined,
      welcome: shellSink,
      status: shellSink,
      activity: { setState: vi.fn() },
      composer: { setState: (state) => composers.push(state) },
    });
    const snapshot = {
      status: "idle",
      sessions: [],
      session: { sessionId: "session-1" },
    } as TuiChatSnapshot;

    flow.update(snapshot);
    expect(composers.at(-1)?.inputIntent).toEqual({ kind: "prompt" });

    draft = "/context";
    flow.update(snapshot);
    expect(composers.at(-1)?.inputIntent).toEqual({
      kind: "command",
      token: "/context",
    });

    draft = "/context explain this repository";
    flow.update(snapshot);
    expect(composers.at(-1)?.inputIntent).toEqual({ kind: "prompt" });

    draft = "/docs summarize this repository";
    flow.update(snapshot);
    expect(composers.at(-1)?.inputIntent).toEqual({
      kind: "skill-instructions",
      token: "/docs",
    });
  });

  it("carries warning hints to the composer and clears the tone on replacement or dismissal", () => {
    const composers: TuiComposerState[] = [];
    const shellSink = { setState: vi.fn() };
    const flow = new TuiChromeFlow({
      version: "0.1.0",
      workspace: "/workspace",
      queueEnabled: true,
      isStarted: () => true,
      isStopped: () => false,
      setTerminalTitle: vi.fn(),
      connection: () => ({ phase: "live", generation: 1 }),
      liveRunId: () => undefined,
      runProjection: () => ({
        queuedItems: [],
        queuedCount: 0,
        queueHandoffPending: false,
      }),
      transcript: new TranscriptStore(),
      shouldResumeDraftAfterLogin: () => false,
      activePermission: () => false,
      activeQuestionnaire: () => false,
      agentInteraction: () => undefined,
      attachmentCount: () => 0,
      expandedDraft: () => "",
      selectedModel: () => undefined,
      permissionMode: () => undefined,
      welcome: shellSink,
      status: shellSink,
      activity: { setState: vi.fn() },
      composer: { setState: (state) => composers.push(state) },
    });
    const snapshot = {
      status: "idle",
      sessions: [],
      session: { sessionId: "session-1" },
    } as TuiChatSnapshot;

    flow.setHint("Run /btw first.", "warning");
    flow.update(snapshot);
    expect(composers.at(-1)).toMatchObject({
      hint: "Run /btw first.",
      hintTone: "warning",
    });

    flow.setHint("Draft restored");
    flow.update(snapshot);
    expect(composers.at(-1)?.hint).toBe("Draft restored");
    expect(composers.at(-1)?.hintTone).toBeUndefined();

    flow.setHint("Run /btw first.", "warning");
    flow.setHint(undefined);
    flow.update(snapshot);
    expect(composers.at(-1)?.hint).toBeUndefined();
    expect(composers.at(-1)?.hintTone).toBeUndefined();
  });

  it("places the server startup animation in the composer header slot", () => {
    const activities: TuiActivityLineState[] = [];
    const composers: TuiComposerState[] = [];
    const shellSink = { setState: vi.fn() };
    const flow = new TuiChromeFlow({
      version: "0.1.0",
      workspace: "/workspace",
      queueEnabled: true,
      isStarted: () => true,
      isStopped: () => false,
      setTerminalTitle: vi.fn(),
      connection: () => ({ phase: "live", generation: 1 }),
      liveRunId: () => undefined,
      runProjection: () => ({
        queuedItems: [],
        queuedCount: 0,
        queueHandoffPending: false,
      }),
      transcript: new TranscriptStore(),
      shouldResumeDraftAfterLogin: () => false,
      activePermission: () => false,
      activeQuestionnaire: () => false,
      agentInteraction: () => undefined,
      attachmentCount: () => 0,
      expandedDraft: () => "",
      selectedModel: () => undefined,
      permissionMode: () => undefined,
      welcome: shellSink,
      status: shellSink,
      activity: { setState: (state) => activities.push(state) },
      composer: { setState: (state) => composers.push(state) },
    });

    flow.setWelcomeTip({
      id: "codex-handoff",
      command: "resume-codex",
      text: "Tip: Ctrl+U resumes your recent Codex session",
      shortText: "Tip: Ctrl+U resumes Codex",
    });
    flow.setStartupHint("⠋ Starting server...");
    flow.update({ status: "starting", sessions: [] } as TuiChatSnapshot);

    expect(activities.at(-1)).toEqual({ phase: "idle" });
    expect(composers.at(-1)).toMatchObject({
      surface: "welcome",
      hint: "⠋ Starting server...",
      headerHidden: false,
    });

    flow.setStartupHint(undefined);
    flow.update({ status: "idle", sessions: [] } as TuiChatSnapshot);
    expect(composers.at(-1)).toMatchObject({
      surface: "welcome",
      mode: "message",
      contextualTip: {
        id: "codex-handoff",
        command: "resume-codex",
      },
    });
    expect(composers.at(-1)?.hint).toBeUndefined();
  });

  it("increments only when the semantic tuple changes and resets on session switch", () => {
    let interaction: TuiAgentInteractionReadback | undefined;
    let agentCounts = { active: 0, total: 0 };
    const shells: TuiShellState[] = [];
    const setTerminalTitle = vi.fn();
    const shellSink = {
      setState: (state: TuiShellState) => shells.push(state),
    };
    const flow = new TuiChromeFlow({
      version: "0.1.0",
      workspace: "/workspace",
      queueEnabled: true,
      isStarted: () => true,
      isStopped: () => false,
      setTerminalTitle,
      connection: () => ({ phase: "live", generation: 1 }),
      liveRunId: (snapshot) => snapshot.activeTurnId,
      runProjection: () => ({
        queuedItems: [],
        queuedCount: 0,
        queueHandoffPending: false,
      }),
      transcript: new TranscriptStore(),
      shouldResumeDraftAfterLogin: () => false,
      activePermission: () => interaction?.kind === "permission",
      activeQuestionnaire: () =>
        interaction?.kind === "questionnaire" || interaction?.kind === "plan",
      agentInteraction: () => interaction,
      agentCounts: () => agentCounts,
      attachmentCount: () => 0,
      expandedDraft: () => "",
      selectedModel: () => undefined,
      permissionMode: () => undefined,
      welcome: shellSink,
      status: shellSink,
      activity: { setState: vi.fn() },
      composer: { setState: vi.fn() },
    });
    const snapshot = (sessionId: string): TuiChatSnapshot =>
      ({
        status: "idle",
        sessions: [],
        session: { sessionId },
      }) as TuiChatSnapshot;

    flow.update(snapshot("session-1"));
    flow.update(snapshot("session-1"));
    expect(setTerminalTitle).toHaveBeenLastCalledWith("Ready | workspace (session-) | MCode");
    expect(shells.at(-1)).toMatchObject({
      agentSeq: "0",
      agentStatus: "ready",
      agentActiveCount: 0,
      agentTotalCount: 0,
    });

    agentCounts = { active: 2, total: 3 };
    flow.update(snapshot("session-1"));
    expect(shells.at(-1)).toMatchObject({
      agentSeq: "1",
      agentActiveCount: 2,
      agentTotalCount: 3,
    });

    interaction = {
      kind: "permission",
      requestId: "permission-1",
      submitting: false,
    };
    const interactingSnapshot: TuiChatSnapshot = {
      ...snapshot("session-1"),
      status: "running",
      activeTurnId: "turn-1",
    };
    flow.update(interactingSnapshot);
    expect(setTerminalTitle).toHaveBeenLastCalledWith("Needs approval | workspace (session-) | MCode");
    expect(shells.at(-1)).toMatchObject({
      agentSeq: "2",
      agentStatus: "perm",
      agentRequestId: "permission-1",
    });

    interaction = { ...interaction, submitting: true };
    flow.update(interactingSnapshot);
    flow.update(interactingSnapshot);
    expect(setTerminalTitle).toHaveBeenLastCalledWith("Working | workspace (session-) | MCode");
    expect(shells.at(-1)).toMatchObject({
      agentSeq: "3",
      agentStatus: "run",
      agentRunId: "turn-1",
    });
    expect(shells.at(-1)?.agentRequestId).toBeUndefined();

    interaction = undefined;
    flow.update(snapshot("session-2"));
    expect(shells.at(-1)).toMatchObject({
      agentSeq: "0",
      agentStatus: "ready",
    });

    flow.update({
      ...snapshot("session-2"),
      status: "running",
      activeTurnId: "turn-queued",
    });
    expect(shells.at(-1)).toMatchObject({
      agentStatus: "run",
      agentRunId: "turn-queued",
    });

    flow.update(snapshot("session-2"));
    expect(shells.at(-1)).toMatchObject({
      agentStatus: "run",
      agentRunId: "turn-queued",
    });

    flow.update({
      ...snapshot("session-2"),
      lastSettledTurn: {
        sessionId: "session-2",
        turnId: "turn-queued",
        status: "succeeded",
      },
    });
    expect(shells.at(-1)).toMatchObject({
      agentStatus: "done",
      agentRunId: "turn-queued",
    });
    expect(setTerminalTitle).toHaveBeenLastCalledWith("Done | workspace (session-) | MCode");

    flow.update({
      ...snapshot("session-2"),
      lastSettledTurn: {
        sessionId: "session-1",
        turnId: "turn-session-1",
        status: "succeeded",
      },
    });
    expect(shells.at(-1)).toMatchObject({
      agentStatus: "done",
      agentRunId: "turn-queued",
    });

    flow.update({
      status: "idle",
      sessions: [],
      lastSettledTurn: {
        sessionId: "session-1",
        turnId: "turn-archived",
        status: "succeeded",
      },
    });
    expect(shells.at(-1)).toMatchObject({ agentStatus: "ready" });
    expect(shells.at(-1)?.agentRunId).toBeUndefined();
  });
});
