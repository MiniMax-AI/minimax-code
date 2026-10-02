import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { TuiInputFlow } from "../../../../../src/tui/controller/interaction/input-flow.js";
import { resolveTuiAttachment } from "../../../../../src/tui/features/composer/attachments.js";
import { TuiComposerDraft } from "../../../../../src/tui/features/composer/draft.js";
import { formatTuiKeybinding } from "../../../../../src/tui/shell/keybindings.js";

function createHarness(
  input: string,
  draft: { attachments: unknown[] },
  hasWaitingMessage = false,
  featureScreenActive = false,
  hasLiveRun = true,
  commandDisposition: "consumed" | "retained" = "consumed",
  interactionActive = false,
  cancelSessionEdit = vi.fn(() => false),
  recentCodexSession?: {
    sessionId: string;
    updatedAtMs: number;
    source: "cli" | "vscode";
  },
  inSideSession = false,
) {
  let inputListener: ((data: string) => unknown) | undefined;
  let currentInput = input;
  let sideSessionActive = inSideSession;
  const trackAutocompleteSelect = vi.fn();
  const editor = {
    getAttachmentPreview: vi.fn(() => undefined),
    dismissAttachmentPreview: vi.fn(),
    onPaste: undefined,
    onSubmit: undefined,
    onAttachmentPlaceholderDeleted: undefined,
    onAttachmentPlaceholderRestored: undefined,
    onAutocompleteSelect: trackAutocompleteSelect,
    getExpandedText: vi.fn(() => currentInput),
    getText: vi.fn(() => currentInput),
    captureDraft: vi.fn(() => ({
      schemaVersion: 1 as const,
      text: input,
      cursor: input.length,
      pastes: [],
      pasteCounter: 0,
      attachmentPlaceholders: [],
    })),
    restoreDraft: vi.fn((snapshot: { text: string }) => {
      currentInput = snapshot.text;
      return true;
    }),
    setText: vi.fn((value: string) => {
      currentInput = value;
    }),
    addToHistory: vi.fn(),
    submit: vi.fn(() => {
      const snapshot = editor.captureDraft();
      const value = currentInput;
      currentInput = "";
      editor.onSubmit?.(value, snapshot);
      return true;
    }),
  };
  const submissionSeed = {
    sessionId: "session-1",
    editor: editor.captureDraft(),
    resources: {
      attachments: draft.attachments,
    },
  };
  editor.captureDraft.mockClear();
  const commandFlow = {
    catalog: {
      resolve: vi.fn(() => undefined as { name: string } | undefined),
    },
    captureSubmissionSeed: vi.fn(() => submissionSeed),
    submit: vi.fn(async () => commandDisposition),
    restoreFailedSeed: vi.fn(async () => undefined),
  };
  const cancelBash = vi.fn(() => false);
  const setHint = vi.fn();
  const restoreWaitingMessage = vi.fn(async () => true);
  const onSubmissionStarted = vi.fn();
  const onSubmissionAdmitted = vi.fn();
  const onSubmissionSettled = vi.fn();
  const requestProcessSuspend = vi.fn();
  const abortLiveTurn = vi.fn(async () => false);
  const leaveUi = vi.fn(async () => undefined);
  const returnFromSideSession = vi.fn(async () => {
    sideSessionActive = false;
    return true;
  });
  const toggleSideConversation = vi.fn(async () => {
    if (!inSideSession) return false;
    sideSessionActive = !sideSessionActive;
    return true;
  });
  const toggleTasks = vi.fn();
  const toggleTranscriptDetails = vi.fn();
  const onChanged = vi.fn();
  const requestRender = vi.fn();
  let offeredCodexSession = recentCodexSession;
  const takeRecentCodexSession = vi.fn(() => {
    const selected = offeredCodexSession;
    offeredCodexSession = undefined;
    return selected;
  });
  const restoreRecentCodexSession = vi.fn(
    (session: typeof recentCodexSession) => {
      offeredCodexSession = session;
    },
  );
  const dismissRecentCodexSession = vi.fn(() => {
    offeredCodexSession = undefined;
  });
  const scrollByPage = vi.fn();
  const composerDraft = {
    snapshot: vi.fn(() => ({
      attachments: draft.attachments,
    })),
    capture: vi.fn(() => ({
      attachments: draft.attachments,
    })),
    ensureAttachmentPlaceholders: vi.fn(),
    removeAttachmentById: vi.fn(async () => true),
    restoreAttachmentById: vi.fn(() => true),
    stashForClear: vi.fn(() => true),
    restoreClearedDraft: vi.fn(() => true),
    discardClearedDraft: vi.fn(async () => undefined),
    hasContent: vi.fn(() => draft.attachments.length > 0),
    abortClipboardRead: vi.fn(() => false),
    pasteClipboard: vi.fn(async () => undefined),
    queueAttachment: vi.fn<TuiComposerDraft["queueAttachment"]>(
      async () => undefined,
    ),
  };
  const flow = new TuiInputFlow({
    tui: {
      addInputListener: vi.fn((listener) => {
        inputListener = listener;
        return vi.fn();
      }),
      requestRender,
    } as never,
    editor: editor as never,
    workspaceDir: "/workspace",
    interaction: {
      isActive: vi.fn(() => interactionActive),
      scrollByPage,
    } as never,
    interactionSurface: {} as never,
    interactionFlow: {} as never,
    featureFlow: {
      isFeatureScreenActive: vi.fn(() => featureScreenActive),
      toggleTranscriptDetails,
    } as never,
    commandFlow: commandFlow as never,
    permissionModeFlow: {} as never,
    composerDraft: composerDraft as never,
    liveRunId: () => (hasLiveRun ? "turn-1" : undefined),
    hasWaitingMessage: () => hasWaitingMessage,
    restoreWaitingMessage,
    openQueueManager: vi.fn(),
    toggleTasks,
    isStopped: () => false,
    abortLiveTurn,
    cancelSessionEdit,
    cancelBash,
    takeRecentCodexSession,
    restoreRecentCodexSession,
    dismissRecentCodexSession,
    leaveUi,
    isSideModeActive: () => sideSessionActive,
    toggleSideConversation,
    closeSideConversation: returnFromSideSession,
    append: vi.fn(),
    setHint,
    onChanged,
    onSubmissionStarted,
    onSubmissionAdmitted,
    onSubmissionSettled,
    requestProcessSuspend,
    requestInteractionRender: vi.fn(),
  });
  flow.attach();
  return {
    inputListener,
    cancelBash,
    editor,
    commandFlow,
    submissionSeed,
    composerDraft,
    setHint,
    restoreWaitingMessage,
    onSubmissionStarted,
    onSubmissionAdmitted,
    onSubmissionSettled,
    requestProcessSuspend,
    abortLiveTurn,
    cancelSessionEdit,
    leaveUi,
    returnFromSideSession,
    toggleSideConversation,
    toggleTasks,
    toggleTranscriptDetails,
    onChanged,
    requestRender,
    scrollByPage,
    trackAutocompleteSelect,
    takeRecentCodexSession,
    restoreRecentCodexSession,
    dismissRecentCodexSession,
  };
}

describe("TuiInputFlow steer Draft handling", () => {
  it.skipIf(process.platform === "win32")(
    "attaches a pasted screenshot with escaped spaces without changing draft text",
    async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), "minimax-code-paste-"));
      const imagePath = join(
        workspaceDir,
        "Screen shots",
        "Screenshot 2026-09-17 at 18.03.36.png",
      );
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=",
        "base64",
      );
      try {
        await mkdir(dirname(imagePath));
        await writeFile(imagePath, png);
        const placeholders = vi.fn();
        const draft = new TuiComposerDraft({
          workspaceDir,
          resolveAttachment: resolveTuiAttachment,
          append: vi.fn(),
          onChanged: vi.fn(),
          onAttachmentPlaceholdersChanged: placeholders,
        });
        const harness = createHarness("Describe this image", {
          attachments: [],
        });
        harness.composerDraft.queueAttachment.mockImplementation(
          draft.queueAttachment.bind(draft),
        );
        const onPaste = harness.editor.onPaste as
          | ((text: string) => boolean)
          | undefined;

        expect(onPaste?.(imagePath.replaceAll(" ", "\\ "))).toBe(true);
        await vi.waitFor(() =>
          expect(draft.snapshot().attachments).toEqual([
            {
              type: "image",
              filePath: imagePath,
              fileName: "Screenshot 2026-09-17 at 18.03.36.png",
              mimeType: "image/png",
              sizeBytes: png.length,
            },
          ]),
        );
        expect(placeholders).toHaveBeenLastCalledWith([
          { id: imagePath, label: "[Image #1]" },
        ]);
        expect(harness.editor.getText()).toBe("Describe this image");
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    },
  );

  it("submits the offered Codex session on Ctrl+U and consumes the one-shot hint", async () => {
    const session = {
      sessionId: "01a02373-25ae-76a1-880c-9253ba939cdc",
      updatedAtMs: Date.now(),
      source: "cli" as const,
    };
    const harness = createHarness(
      "",
      { attachments: [] },
      false,
      false,
      false,
      "consumed",
      false,
      vi.fn(() => false),
      session,
    );

    expect(harness.inputListener?.("\x15")).toEqual({ consume: true });
    await vi.waitFor(() =>
      expect(harness.commandFlow.submit).toHaveBeenCalledWith(
        "/resume-codex 01a02373-25ae-76a1-880c-9253ba939cdc",
      ),
    );
    expect(harness.takeRecentCodexSession).toHaveBeenCalledOnce();
    expect(harness.onSubmissionStarted).toHaveBeenCalledWith(
      "/resume-codex 01a02373-25ae-76a1-880c-9253ba939cdc",
    );
    await vi.waitFor(() =>
      expect(harness.onSubmissionSettled).toHaveBeenCalledOnce(),
    );
  });

  it("leaves Ctrl+U to the Editor without a launch hint or with an existing Draft", () => {
    const session = {
      sessionId: "01a02373-25ae-76a1-880c-9253ba939cdc",
      updatedAtMs: Date.now(),
      source: "cli" as const,
    };
    const absent = createHarness("", { attachments: [] }, false, false, false);
    const drafted = createHarness(
      "keep this draft",
      { attachments: [] },
      false,
      false,
      false,
      "consumed",
      false,
      vi.fn(() => false),
      session,
    );

    expect(absent.inputListener?.("\x15")).toBeUndefined();
    expect(drafted.inputListener?.("\x15")).toBeUndefined();
    expect(absent.commandFlow.submit).not.toHaveBeenCalled();
    expect(drafted.commandFlow.submit).not.toHaveBeenCalled();
    expect(drafted.takeRecentCodexSession).not.toHaveBeenCalled();
  });

  it("invalidates a pending launch handoff on any other key", () => {
    const session = {
      sessionId: "01a02373-25ae-76a1-880c-9253ba939cdc",
      updatedAtMs: Date.now(),
      source: "cli" as const,
    };
    const harness = createHarness(
      "",
      { attachments: [] },
      false,
      false,
      false,
      "consumed",
      false,
      vi.fn(() => false),
      session,
    );

    expect(harness.inputListener?.("x")).toBeUndefined();
    expect(harness.dismissRecentCodexSession).toHaveBeenCalledOnce();
    expect(harness.inputListener?.("\x15")).toBeUndefined();
  });
  it("turns a selected image @ mention into a structured attachment", async () => {
    const harness = createHarness("", { attachments: [] }, false, false, false);
    const onAutocompleteSelect = harness.editor.onAutocompleteSelect as
      | ((
          suggestions: {
            prefix: string;
            items: { value: string; label: string }[];
          },
          item: { value: string; label: string },
        ) => void)
      | undefined;
    const item = {
      value: '@"figures/reference overview.png"',
      label: "reference overview.png",
    };

    onAutocompleteSelect?.({ prefix: "@ref", items: [item] }, item);

    expect(harness.trackAutocompleteSelect).toHaveBeenCalledWith(
      { prefix: "@ref", items: [item] },
      item,
    );
    await vi.waitFor(() =>
      expect(harness.composerDraft.queueAttachment).toHaveBeenCalledWith(
        '"figures/reference overview.png"',
      ),
    );
  });

  it("does not attach a selected @ directory completion", () => {
    const harness = createHarness("", { attachments: [] }, false, false, false);
    const onAutocompleteSelect = harness.editor.onAutocompleteSelect as
      | ((
          suggestions: {
            prefix: string;
            items: { value: string; label: string }[];
          },
          item: { value: string; label: string },
        ) => void)
      | undefined;
    const item = {
      value: '@"figures/reference set/"',
      label: "reference set/",
    };

    onAutocompleteSelect?.({ prefix: "@ref", items: [item] }, item);

    expect(harness.composerDraft.queueAttachment).not.toHaveBeenCalled();
  });

  it("restores the pre-clear Editor Draft if seed capture fails", () => {
    const harness = createHarness("send A", { attachments: [] });
    const editorDraft = {
      schemaVersion: 1 as const,
      text: "send A",
      cursor: 3,
      pastes: [],
      pasteCounter: 0,
    };
    harness.commandFlow.captureSubmissionSeed.mockImplementationOnce(() => {
      throw new Error("reserve failed");
    });
    const submit = harness.editor.onSubmit as
      | ((input: string, draft: typeof editorDraft) => void)
      | undefined;

    submit?.("send A", editorDraft);

    expect(harness.editor.restoreDraft).toHaveBeenCalledWith(editorDraft);
    expect(harness.commandFlow.submit).not.toHaveBeenCalled();
    expect(harness.onSubmissionStarted).not.toHaveBeenCalled();
    expect(harness.onSubmissionAdmitted).not.toHaveBeenCalled();
    expect(harness.onSubmissionSettled).not.toHaveBeenCalled();
  });

  it("passes one atomic Editor and resource snapshot to submission without restoring over later input", async () => {
    const harness = createHarness("send A", {
      attachments: [{ filePath: "/tmp/a.png" }],
    });
    const editorDraft = {
      schemaVersion: 1 as const,
      text: "[paste #1 +2 lines] send A",
      cursor: 4,
      pastes: [{ id: 1, content: "line one\nline two" }],
      pasteCounter: 1,
      attachmentPlaceholders: [],
    };
    harness.submissionSeed.editor = editorDraft;
    let settle: ((value: "consumed") => void) | undefined;
    harness.commandFlow.submit.mockImplementationOnce(
      async () =>
        await new Promise<"consumed">((resolve) => {
          settle = resolve;
        }),
    );

    const submit = harness.editor.onSubmit as
      | ((input: string, draft: typeof editorDraft) => void)
      | undefined;
    submit?.("send A", editorDraft);
    harness.editor.getText.mockReturnValue("draft B");
    settle?.("consumed");

    await vi.waitFor(() =>
      expect(harness.onSubmissionSettled).toHaveBeenCalledOnce(),
    );
    expect(harness.commandFlow.captureSubmissionSeed).toHaveBeenCalledWith(
      editorDraft,
    );
    expect(harness.commandFlow.submit).toHaveBeenCalledWith(
      "send A",
      {
        sessionId: "session-1",
        editor: editorDraft,
        resources: {
          attachments: [{ filePath: "/tmp/a.png" }],
        },
      },
      expect.objectContaining({
        onRuntimeAccepted: expect.any(Function),
        onSubmissionPrepared: expect.any(Function),
      }),
    );
    expect(harness.editor.restoreDraft).not.toHaveBeenCalledWith(editorDraft);
    expect(harness.editor.setText).toHaveBeenCalledTimes(1);
    expect(harness.editor.setText).toHaveBeenCalledWith("");
  });

  it("keeps pending recovery when a normal submission is retained before admission", async () => {
    const harness = createHarness(
      "keep pending transport",
      { attachments: [] },
      false,
      false,
      false,
      "retained",
    );
    const editorDraft = harness.submissionSeed.editor;

    harness.editor.onSubmit?.("keep pending transport", editorDraft);

    await vi.waitFor(() =>
      expect(harness.commandFlow.submit).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() => expect(harness.onChanged).toHaveBeenCalled());
    expect(harness.onSubmissionSettled).not.toHaveBeenCalled();
  });

  it("creates a recovery token for literal slash content with hidden transport", async () => {
    const harness = createHarness("/help should remain message text", {
      attachments: [],
    });
    harness.commandFlow.catalog.resolve.mockReturnValue({ name: "help" });
    Object.assign(harness.submissionSeed, {
      transportContent:
        "<mavis-chat-context>hidden</mavis-chat-context>\n\n/help should remain message text",
    });

    harness.editor.onSubmit?.(
      "/help should remain message text",
      harness.submissionSeed.editor,
    );

    await vi.waitFor(() =>
      expect(harness.commandFlow.submit).toHaveBeenCalledOnce(),
    );
    expect(harness.onSubmissionStarted).toHaveBeenCalledWith(
      "/help should remain message text",
      expect.objectContaining({
        transportContent: expect.stringContaining("mavis-chat-context"),
      }),
    );
  });

  it("restores an unexpected submission failure without overwriting later input", async () => {
    const harness = createHarness("send A", {
      attachments: [{ filePath: "/tmp/a.png" }],
    });
    harness.commandFlow.submit.mockRejectedValueOnce(
      new Error("unexpected admission failure"),
    );

    const editorDraft = harness.submissionSeed.editor;
    const submit = harness.editor.onSubmit as
      | ((input: string, draft: typeof editorDraft) => void)
      | undefined;
    submit?.("send A", editorDraft);
    harness.editor.getText.mockReturnValue("draft B");

    await vi.waitFor(() =>
      expect(harness.commandFlow.restoreFailedSeed).toHaveBeenCalledOnce(),
    );
    expect(harness.commandFlow.restoreFailedSeed).toHaveBeenCalledWith(
      "send A",
      expect.objectContaining({
        resources: {
          attachments: [{ filePath: "/tmp/a.png" }],
        },
      }),
    );
    expect(harness.editor.setText).toHaveBeenCalledTimes(1);
    expect(harness.editor.setText).toHaveBeenCalledWith("");
  });

  it("routes Ctrl+Z to the process suspend lifecycle when supported", () => {
    const harness = createHarness(
      "preserve this Draft",
      {
        attachments: [],
      },
      false,
      false,
    );

    expect(harness.inputListener?.("\x1a")).toEqual({ consume: true });
    expect(harness.requestProcessSuspend).toHaveBeenCalledOnce();
    expect(harness.editor.setText).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+Z available while a feature screen or interaction owns focus", () => {
    const featureHarness = createHarness("", { attachments: [] }, false, true);
    const interactionHarness = createHarness(
      "",
      { attachments: [] },
      false,
      false,
      true,
      "consumed",
      true,
    );

    expect(featureHarness.inputListener?.("\x1a")).toEqual({ consume: true });
    expect(interactionHarness.inputListener?.("\x1a")).toEqual({
      consume: true,
    });
    expect(featureHarness.requestProcessSuspend).toHaveBeenCalledOnce();
    expect(interactionHarness.requestProcessSuspend).toHaveBeenCalledOnce();
  });

  it("ignores the Kitty Ctrl+Z release event before the focused Pi component", () => {
    const harness = createHarness("", { attachments: [] });

    expect(harness.inputListener?.("\u001B[122;5:3u")).toBeUndefined();
    expect(harness.requestProcessSuspend).not.toHaveBeenCalled();
  });

  it("routes Ctrl+T to the task list without opening another feature surface", () => {
    const harness = createHarness("", { attachments: [] });

    expect(harness.inputListener?.("\x14")).toEqual({ consume: true });
    expect(harness.toggleTasks).toHaveBeenCalledOnce();
    expect(harness.onChanged).toHaveBeenCalledOnce();
    expect(harness.commandFlow.submit).not.toHaveBeenCalled();
  });

  it("lets Ctrl+O use Pi incremental rendering while a response is streaming", () => {
    const harness = createHarness("", { attachments: [] });

    expect(harness.inputListener?.("\x0f")).toEqual({
      consume: true,
      render: false,
    });
    expect(harness.toggleTranscriptDetails).toHaveBeenCalledOnce();
    expect(harness.requestRender).toHaveBeenCalledWith();
    expect(harness.requestRender).not.toHaveBeenCalledWith(true);
  });

  it("routes keyboard page scrolling only to an active interaction", () => {
    const harness = createHarness(
      "",
      { attachments: [] },
      false,
      false,
      false,
      "consumed",
      true,
    );
    harness.scrollByPage.mockReturnValueOnce(-5).mockReturnValueOnce(5);

    expect(harness.inputListener?.("\u001b[5~")).toEqual({ consume: true });
    expect(harness.inputListener?.("\u001b[6~")).toEqual({ consume: true });

    expect(harness.scrollByPage).toHaveBeenNthCalledWith(1, -1);
    expect(harness.scrollByPage).toHaveBeenNthCalledWith(2, 1);
  });

  it("clears and restores text and attachments as one Draft", () => {
    const harness = createHarness(
      "preserve everything",
      { attachments: [{ fileName: "image.png" }] },
      false,
      false,
      false,
    );

    expect(harness.inputListener?.("\u001B[99;5u")).toEqual({ consume: true });
    expect(harness.editor.captureDraft).toHaveBeenCalledOnce();
    expect(harness.composerDraft.stashForClear).toHaveBeenCalledOnce();
    expect(harness.editor.getText()).toBe("");
    expect(harness.editor.restoreDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "",
        cursor: 0,
        pastes: [],
        attachmentPlaceholders: [],
      }),
    );
    expect(harness.setHint).toHaveBeenCalledWith(
      `Draft cleared · ${formatTuiKeybinding("composer.restore-draft")} restore · ${formatTuiKeybinding("app.clear")} exit`,
    );

    expect(harness.inputListener?.("\u001B[99;5:3u")).toBeUndefined();
    expect(harness.composerDraft.discardClearedDraft).not.toHaveBeenCalled();

    expect(harness.inputListener?.("\x1f")).toEqual({ consume: true });
    expect(harness.composerDraft.restoreClearedDraft).toHaveBeenCalledOnce();
    expect(harness.editor.restoreDraft).toHaveBeenCalledWith(
      expect.objectContaining({ text: "preserve everything" }),
    );
    expect(harness.setHint).toHaveBeenLastCalledWith("Draft restored");
  });

  it("keeps the first Ctrl+C armed across a Kitty release and a pause", () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(
        "",
        { attachments: [] },
        false,
        false,
        false,
      );

      expect(harness.inputListener?.("\u001B[99;5u")).toEqual({
        consume: true,
      });
      expect(harness.setHint).toHaveBeenLastCalledWith(
        "Press Ctrl+C again to exit",
      );

      expect(harness.inputListener?.("\u001B[99;5:3u")).toBeUndefined();
      expect(harness.setHint).toHaveBeenLastCalledWith(
        "Press Ctrl+C again to exit",
      );
      expect(harness.leaveUi).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5_000);
      expect(harness.inputListener?.("\u001B[99;5u")).toEqual({
        consume: true,
      });
      expect(harness.leaveUi).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarms Ctrl+C exit confirmation after another key press", () => {
    const harness = createHarness("", { attachments: [] }, false, false, false);

    expect(harness.inputListener?.("\u001B[99;5u")).toEqual({ consume: true });
    expect(harness.inputListener?.("x")).toBeUndefined();

    expect(harness.inputListener?.("\u001B[99;5u")).toEqual({ consume: true });
    expect(harness.leaveUi).not.toHaveBeenCalled();
    expect(harness.setHint).toHaveBeenLastCalledWith(
      "Press Ctrl+C again to exit",
    );
  });

  it("returns from a side session on empty Ctrl+C and disarms the exit latch", () => {
    const harness = createHarness(
      "",
      { attachments: [] },
      false,
      false,
      false,
      "consumed",
      false,
      vi.fn(() => false),
      undefined,
      true,
    );

    expect(harness.inputListener?.("\x03")).toEqual({ consume: true });
    expect(harness.returnFromSideSession).toHaveBeenCalledOnce();
    expect(harness.leaveUi).not.toHaveBeenCalled();

    // Now back in the parent: the next Ctrl+C arms exit instead of quitting.
    expect(harness.inputListener?.("\x03")).toEqual({ consume: true });
    expect(harness.leaveUi).not.toHaveBeenCalled();
    expect(harness.setHint).toHaveBeenLastCalledWith(
      "Press Ctrl+C again to exit",
    );
  });

  it("clears a non-empty side-session draft without leaving", () => {
    const harness = createHarness(
      "keep me in btw",
      { attachments: [] },
      false,
      false,
      false,
      "consumed",
      false,
      vi.fn(() => false),
      undefined,
      true,
    );

    expect(harness.inputListener?.("\x03")).toEqual({ consume: true });
    expect(harness.editor.getText()).toBe("");
    expect(harness.returnFromSideSession).not.toHaveBeenCalled();
  });

  it("closes the side conversation on empty Ctrl+D instead of quitting MCode", () => {
    const harness = createHarness(
      "",
      { attachments: [] },
      false,
      false,
      false,
      "consumed",
      false,
      vi.fn(() => false),
      undefined,
      true,
    );

    expect(harness.inputListener?.("\x04")).toEqual({ consume: true });
    expect(harness.returnFromSideSession).toHaveBeenCalledOnce();
    expect(harness.leaveUi).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+D as quit outside side mode", () => {
    const harness = createHarness("", { attachments: [] }, false, false, false);

    expect(harness.inputListener?.("\x04")).toEqual({ consume: true });
    expect(harness.leaveUi).toHaveBeenCalledOnce();
    expect(harness.returnFromSideSession).not.toHaveBeenCalled();
  });

  it("switches between parent and side views on Ctrl+/ without closing the pair", async () => {
    const harness = createHarness(
      "",
      { attachments: [] },
      false,
      false,
      false,
      "consumed",
      false,
      vi.fn(() => false),
      undefined,
      true,
    );

    expect(harness.inputListener?.("\u001B[47;5u")).toEqual({ consume: true });
    await vi.waitFor(() =>
      expect(harness.toggleSideConversation).toHaveBeenCalledOnce(),
    );
    expect(harness.returnFromSideSession).not.toHaveBeenCalled();
    expect(harness.leaveUi).not.toHaveBeenCalled();
    expect(harness.setHint).not.toHaveBeenCalled();
  });

  it("hints at /btw when Ctrl+/ is pressed with no side conversation open", async () => {
    const harness = createHarness("", { attachments: [] }, false, false, false);

    expect(harness.inputListener?.("\u001B[47;5u")).toEqual({ consume: true });
    await vi.waitFor(() =>
      expect(harness.setHint).toHaveBeenCalledWith(
        "No side conversation is open. Run /btw first; this shortcut only switches conversations.",
        "warning",
      ),
    );
  });

  it("does not interrupt a background parent run when Escape is pressed in an idle side session", () => {
    const harness = createHarness(
      "",
      { attachments: [] },
      false,
      false,
      false,
      "consumed",
      false,
      vi.fn(() => false),
      undefined,
      true,
    );

    expect(harness.inputListener?.("\u001B")).toBeUndefined();
    expect(harness.abortLiveTurn).not.toHaveBeenCalled();
  });

  it("neither advertises nor opens Edit on double Escape in an idle side session", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const harness = createHarness(
        "",
        { attachments: [] },
        false,
        false,
        false,
        "consumed",
        false,
        vi.fn(() => false),
        undefined,
        true,
      );

      expect(harness.inputListener?.("\u001b")).toBeUndefined();
      now.mockReturnValue(1_200);
      expect(harness.inputListener?.("\u001b")).toBeUndefined();

      expect(harness.setHint).not.toHaveBeenCalledWith(
        "Press Esc again to edit the latest message",
      );
      await Promise.resolve();
      expect(harness.commandFlow.submit).not.toHaveBeenCalled();
      expect(harness.abortLiveTurn).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("uses Pi app semantics: Ctrl+C clears while Escape interrupts a live turn", () => {
    const harness = createHarness("keep this Draft", { attachments: [] });

    expect(harness.inputListener?.("\x03")).toEqual({ consume: true });
    expect(harness.editor.getText()).toBe("");
    expect(harness.abortLiveTurn).not.toHaveBeenCalled();

    expect(harness.inputListener?.("\u001B")).toEqual({ consume: true });
    expect(harness.abortLiveTurn).toHaveBeenCalledOnce();
  });

  it("opens Edit when Escape is pressed twice while chat is idle", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const harness = createHarness(
        "",
        { attachments: [] },
        false,
        false,
        false,
      );

      expect(harness.inputListener?.("\u001b")).toBeUndefined();
      expect(harness.commandFlow.submit).not.toHaveBeenCalled();

      now.mockReturnValue(1_200);
      expect(harness.inputListener?.("\u001b")).toEqual({ consume: true });
      await vi.waitFor(() =>
        expect(harness.commandFlow.submit).toHaveBeenCalledWith("/edit"),
      );
      expect(harness.abortLiveTurn).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("does not open Edit when repeated Escape is late or a draft is present", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const late = createHarness("", { attachments: [] }, false, false, false);
      late.inputListener?.("\u001b");
      now.mockReturnValue(1_500);
      expect(late.inputListener?.("\u001b")).toBeUndefined();
      expect(late.commandFlow.submit).not.toHaveBeenCalled();

      const withDraft = createHarness(
        "keep this draft",
        { attachments: [] },
        false,
        false,
        false,
      );
      now.mockReturnValue(2_000);
      withDraft.inputListener?.("\u001b");
      now.mockReturnValue(2_200);
      withDraft.inputListener?.("\u001b");
      expect(withDraft.commandFlow.submit).not.toHaveBeenCalled();
      expect(withDraft.editor.getText()).toBe("keep this draft");
    } finally {
      now.mockRestore();
    }
  });

  it("does not reuse Escape from cancellation or interruption to open Edit", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const cancelSessionEdit = vi
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValue(false);
      const cancelling = createHarness(
        "",
        { attachments: [] },
        false,
        false,
        false,
        "consumed",
        false,
        cancelSessionEdit,
      );
      expect(cancelling.inputListener?.("\u001b")).toEqual({ consume: true });
      now.mockReturnValue(1_200);
      expect(cancelling.inputListener?.("\u001b")).toBeUndefined();
      expect(cancelling.commandFlow.submit).not.toHaveBeenCalled();

      const running = createHarness(
        "",
        { attachments: [] },
        false,
        false,
        true,
      );
      now.mockReturnValue(2_000);
      running.inputListener?.("\u001b");
      now.mockReturnValue(2_200);
      running.inputListener?.("\u001b");
      expect(running.abortLiveTurn).toHaveBeenCalledTimes(2);
      expect(running.commandFlow.submit).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("leaves interaction keys to the focused Pi component while honoring application suspend", () => {
    const harness = createHarness(
      "preserve this Draft",
      { attachments: [] },
      false,
      false,
      true,
      "consumed",
      true,
    );

    expect(harness.inputListener?.("\x03")).toBeUndefined();
    expect(harness.inputListener?.("\u001B")).toBeUndefined();
    expect(harness.inputListener?.("\x1a")).toEqual({ consume: true });
    expect(harness.editor.setText).not.toHaveBeenCalled();
    expect(harness.abortLiveTurn).not.toHaveBeenCalled();
    expect(harness.leaveUi).not.toHaveBeenCalled();
    expect(harness.requestProcessSuspend).toHaveBeenCalledOnce();
  });

  it("uses Ctrl+D to exit only when the Composer is empty", () => {
    const empty = createHarness("", { attachments: [] }, false, false, false);
    expect(empty.inputListener?.("\x04")).toEqual({ consume: true });
    expect(empty.leaveUi).toHaveBeenCalledOnce();

    const withText = createHarness(
      "keep me",
      { attachments: [] },
      false,
      false,
      false,
    );
    expect(withText.inputListener?.("\x04")).toBeUndefined();
    expect(withText.leaveUi).not.toHaveBeenCalled();

    const withAttachment = createHarness(
      "",
      { attachments: [{}] },
      false,
      false,
      false,
    );
    expect(withAttachment.inputListener?.("\x04")).toBeUndefined();
    expect(withAttachment.leaveUi).not.toHaveBeenCalled();
  });

  it("submits the active Draft as guidance when Enter is pressed", async () => {
    const harness = createHarness("focus on the failing test", {
      attachments: [],
    });

    expect(harness.inputListener?.("\r")).toEqual({ consume: true });

    await vi.waitFor(() =>
      expect(harness.commandFlow.submit).toHaveBeenCalledWith(
        "focus on the failing test",
        harness.submissionSeed,
        expect.objectContaining({ busyAction: "steer" }),
      ),
    );
    expect(harness.editor.addToHistory).toHaveBeenCalledWith(
      "focus on the failing test",
    );
    expect(harness.onSubmissionStarted).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(harness.onSubmissionSettled).toHaveBeenCalledOnce(),
    );
  });

  it("queues the active Draft when Tab is pressed", async () => {
    const harness = createHarness("do this after the current turn", {
      attachments: [],
    });

    expect(harness.inputListener?.("\x1b\r")).toEqual({ consume: true });

    await vi.waitFor(() =>
      expect(harness.commandFlow.submit).toHaveBeenCalledWith(
        "do this after the current turn",
        harness.submissionSeed,
        expect.objectContaining({ busyAction: "queue" }),
      ),
    );
  });

  it.each(["\x1b[1;3A", "\x1b[1;2D"])(
    "restores the latest waiting message for %j",
    async (key) => {
      const harness = createHarness("", { attachments: [] }, true);

      expect(harness.inputListener?.(key)).toEqual({ consume: true });

      await vi.waitFor(() =>
        expect(harness.restoreWaitingMessage).toHaveBeenCalledOnce(),
      );
      expect(harness.commandFlow.submit).not.toHaveBeenCalled();
    },
  );

  it("does not bind Ctrl+X while a turn is running", () => {
    const harness = createHarness("keep editing", { attachments: [] });

    expect(harness.inputListener?.("\x18")).toBeUndefined();
    expect(harness.editor.submit).not.toHaveBeenCalled();
    expect(harness.commandFlow.submit).not.toHaveBeenCalled();
  });

  it("leaves retained Enter guidance pending for CommandFlow recovery", async () => {
    const harness = createHarness(
      "do not lose this guidance",
      { attachments: [] },
      false,
      false,
      true,
      "retained",
    );

    harness.inputListener?.("\r");

    await vi.waitFor(() =>
      expect(harness.commandFlow.submit).toHaveBeenCalledOnce(),
    );
    expect(harness.onSubmissionSettled).not.toHaveBeenCalled();
  });

  it("removes the attachment when its inline placeholder is deleted from the editor", async () => {
    const harness = createHarness("", {
      attachments: [{ fileName: "first.png" }, { fileName: "second.png" }],
    });

    const onDeleted = harness.editor.onAttachmentPlaceholderDeleted as
      | ((id: string) => void)
      | undefined;
    onDeleted?.("/workspace/second.png");

    await vi.waitFor(() =>
      expect(harness.composerDraft.removeAttachmentById).toHaveBeenCalledWith(
        "/workspace/second.png",
      ),
    );
  });

  it("restores a detached attachment when Editor undo restores its element", () => {
    const harness = createHarness("", {
      attachments: [],
    });

    const onRestored = harness.editor.onAttachmentPlaceholderRestored as
      | ((id: string) => void)
      | undefined;
    onRestored?.("/workspace/image.png");

    expect(harness.composerDraft.restoreAttachmentById).toHaveBeenCalledWith(
      "/workspace/image.png",
    );
  });
});

describe("shell cancellation", () => {
  it.each(["\u001b", "\u0003", "\u001b[99;5u"])(
    "cancels shell before Agent or draft actions with %j",
    (key) => {
      const harness = createHarness("draft", { attachments: [] });
      harness.cancelBash.mockReturnValue(true);
      expect(harness.inputListener?.(key)).toEqual({ consume: true });
      expect(harness.cancelBash).toHaveBeenCalledOnce();
      expect(harness.abortLiveTurn).not.toHaveBeenCalled();
      expect(harness.editor.setText).not.toHaveBeenCalled();
    },
  );
});
