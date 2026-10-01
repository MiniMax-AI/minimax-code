import { describe, expect, it } from "vitest";
import { resolveTuiVisiblePresentation } from "../../../../../src/tui/controller/projection/visible-presentation.js";
import { createTranscriptCell } from "../../../../../src/tui/transcript/model.js";
import { TranscriptStore } from "../../../../../src/tui/transcript/store.js";
import { createTuiHostKeybindings } from "../../../../../src/tui/shell/keybindings.js";
import { formatTuiShortcut } from "../../../../../src/tui/shell/shortcut-labels.js";
import { normalizeAccountStatus } from "../../../../../src/runtime/adapters/normalizers.js";
import { TuiWelcome } from "../../../../../src/tui/shell/welcome/component.js";
import { stripAnsi } from "../../../../../src/tui/rendering/text.js";

const defaultQueueLabel = `${formatTuiShortcut("alt+enter")} queue`;

const idleChat = {
  status: "idle" as const,
  sessions: [],
};

function resolve(
  overrides: Partial<Parameters<typeof resolveTuiVisiblePresentation>[0]> = {},
) {
  return resolveTuiVisiblePresentation({
    snapshot: idleChat,
    connection: { phase: "live", generation: 1 },
    surface: "conversation",
    currentLiveRunId: undefined,
    transcript: new TranscriptStore(),
    runtimeQueuedCount: 0,
    queueEnabled: true,
    activePermission: false,
    activeQuestionnaire: false,
    compacting: false,
    attachmentCount: 0,
    version: "0.1.0",
    workspace: "/workspace",
    ...overrides,
  });
}

describe("visible presentation selector", () => {
  it("keeps the idle surface focused on the Composer", () => {
    expect(resolve()).toMatchObject({
      activity: { phase: "idle" },
      composer: {
        surface: "conversation",
        mode: "message",
        attachmentCount: 0,
      },
      shell: {
        version: "0.1.0",
        workspace: "/workspace",
        runtimeStatus: "ready",
      },
    });
  });

  it("updates both side conversation footers and queued input hints after rebinding", () => {
    const { registry, manager, hostOverrides } = createTuiHostKeybindings({
      platform: "linux",
      suspendSupported: true,
    });
    const side = () =>
      resolve({ keybindings: registry, sideConversation: { view: "side" } });
    const parent = () =>
      resolve({ keybindings: registry, sideConversation: { view: "parent" } });
    const originalSideLabel = side().composer.contextLabel;
    const originalParentLabel = parent().composer.contextLabel;

    manager.setUserBindings({
      ...hostOverrides,
      "app.toggle-side-session": ["ctrl+x", "alt+x"],
      "app.clear": "ctrl+q",
      "tui.input.submit": "ctrl+s",
    });
    expect(side().composer.contextLabel).toBe(
      "Side from main session · Ctrl+X / Alt+X to main · Ctrl+Q to close",
    );
    expect(parent().composer.contextLabel).toBe("Ctrl+X / Alt+X for side");
    expect(
      resolve({ keybindings: registry, runtimeQueuedCount: 1 }).composer.hint,
    ).toBe("Message · Ctrl+S send");

    manager.setUserBindings({
      ...hostOverrides,
      "app.toggle-side-session": [],
      "app.clear": [],
    });
    expect(side().composer.contextLabel).toBe(
      "Side from main session · Unbound to main · Unbound to close",
    );
    expect(parent().composer.contextLabel).toBe("Unbound for side");

    manager.setUserBindings(hostOverrides);
    expect(side().composer.contextLabel).toBe(originalSideLabel);
    expect(parent().composer.contextLabel).toBe(originalParentLabel);
  });

  it("projects an idle /goal draft as the client-aligned Goal composer mode", () => {
    expect(
      resolve({ goalDraft: true, attachmentCount: 1 }).composer,
    ).toMatchObject({
      mode: "goal",
      attachmentCount: 1,
    });
    expect(
      resolve({ goalDraft: true, currentLiveRunId: "turn-1" }).composer.mode,
    ).toBe("follow-up");
  });

  it("shows the active Session workspace after opening a Session from another workspace", () => {
    expect(
      resolve({
        snapshot: {
          ...idleChat,
          session: {
            sessionId: "session-other",
            workspaceDir: "/other/workspace",
          },
        },
      }).shell.workspace,
    ).toBe("/other/workspace");
  });

  it("projects Runtime context independently from account quota and cache metrics", () => {
    const contextUsage = {
      usedTokens: 80,
      contextWindowTokens: 100,
      totalCountSource: "LOCAL_ESTIMATE" as const,
      components: [],
    };
    const shell = resolve({
      snapshot: {
        ...idleChat,
        contextSnapshot: { status: "live", contextUsage },
      },
    }).shell;
    expect(shell.contextUsage).toEqual(contextUsage);
    expect(shell.sessionCacheReadRatio).toBeUndefined();
    expect(shell.tokenPlanQuota).toBeUndefined();
  });

  it("shows the selected default context window before a Session exists", () => {
    expect(
      resolve({
        selectedModel: {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          contextLimit: 1_000_000,
        },
      }).shell.contextWindowTokens,
    ).toBe(1_000_000);
  });

  it("uses only the active Session snapshot instead of a global selection", () => {
    const input = {
      selectedModel: {
        providerId: "minimax",
        modelId: "MiniMax-M3",
        contextLimit: 1_000_000,
      },
      snapshot: {
        ...idleChat,
        session: { sessionId: "existing" },
      },
    };
    expect(resolve(input).shell.contextWindowTokens).toBeUndefined();
    expect(
      resolve({
        ...input,
        snapshot: {
          ...input.snapshot,
          contextSnapshot: {
            status: "live",
            model: {
              provider: "minimax",
              id: "MiniMax-M3",
              contextWindow: 200_000,
            },
          },
        },
      }).shell.contextWindowTokens,
    ).toBe(200_000);
    expect(
      resolve({
        ...input,
        snapshot: { ...idleChat, session: { sessionId: "other" } },
      }).shell.contextWindowTokens,
    ).toBeUndefined();
  });

  it("projects the active Session cache read ratio into the status shell", () => {
    expect(
      resolve({
        snapshot: {
          ...idleChat,
          session: { sessionId: "session-1", workspaceDir: "/workspace" },
          sessionUsage: {
            inputTokens: 10,
            cacheReadTokens: 80,
            cacheWriteTokens: 10,
          },
        },
      }).shell.sessionCacheReadRatio,
    ).toBe(0.8);
  });

  it("shows one aggregate Loading line before the first concrete Turn activity", () => {
    const presentation = resolve({
      snapshot: { ...idleChat, status: "starting", activeTurnId: "turn-1" },
      currentLiveRunId: "turn-1",
      transcript: new TranscriptStore([
        createTranscriptCell({
          id: "thinking-placeholder",
          kind: "thinking",
          status: "running",
          content: "",
          turnId: "turn-1",
          createdAtMs: 1,
        }),
      ]),
    });

    expect(presentation.activity).toEqual({
      phase: "loading",
      runId: "turn-1",
      controls: ["guide", "details", "interrupt"],
      draftLabel: defaultQueueLabel,
    });
    expect(presentation.composer).toMatchObject({
      mode: "follow-up",
      headerHidden: true,
    });
    expect(presentation.composer.hint).toBeUndefined();
  });

  it("keeps a pending Runtime stop more urgent than a transient warning", () => {
    expect(
      resolve({
        runtimeStoppingRunId: "turn-stopping",
        transientHint: "Run /btw first.",
        transientHintTone: "warning",
      }).composer.hintTone,
    ).toBe("danger");
  });

  it("keeps a recovered Runtime turn visible as Stopping until the terminal event arrives", () => {
    const presentation = resolve({
      currentLiveRunId: "turn-recovered",
      runtimeStoppingRunId: "turn-recovered",
    });

    expect(presentation.activity).toEqual({
      phase: "stopping",
      runId: "turn-recovered",
      draftLabel: defaultQueueLabel,
    });
    expect(presentation.composer).toMatchObject({
      mode: "follow-up",
      hint: "Stopping · draft preserved",
      hintTone: "danger",
    });
  });

  it.each([
    { keys: "ctrl+enter", attachmentCount: 0, label: "Ctrl+Enter queue" },
    {
      keys: "ctrl+enter",
      attachmentCount: 1,
      label: "1 attachment · Ctrl+Enter queue",
    },
    {
      keys: ["ctrl+enter", "alt+enter"],
      attachmentCount: 2,
      label: "2 attachments · Ctrl+Enter / Alt+Enter queue",
    },
    { keys: [], attachmentCount: 0, label: "Unbound queue" },
  ] as const)(
    "uses the effective queue binding in the merged draft label: $label",
    ({ keys, attachmentCount, label }) => {
      const { registry } = createTuiHostKeybindings({
        platform: "linux",
        suspendSupported: true,
        userOverrides: {
          "run.queue-draft": typeof keys === "string" ? keys : [...keys],
        },
      });

      expect(
        resolve({
          currentLiveRunId: "turn-1",
          keybindings: registry,
          attachmentCount,
        }).activity.draftLabel,
      ).toBe(label);
    },
  );

  it("collapses Thinking, Tool, and response details into one Running line", () => {
    const presentation = resolve({
      currentLiveRunId: "turn-1",
      transcript: new TranscriptStore([
        createTranscriptCell({
          id: "tool-1",
          kind: "tool",
          status: "running",
          title: "Read",
          content: JSON.stringify({ path: "src/app.ts" }),
          turnId: "turn-1",
          createdAtMs: 1,
        }),
      ]),
    });

    expect(presentation.activity).toEqual({
      phase: "running",
      runId: "turn-1",
      controls: ["guide", "details", "interrupt"],
      draftLabel: defaultQueueLabel,
    });
    expect(JSON.stringify(presentation.activity)).not.toContain("src/app.ts");
  });

  it("projects current-turn output throughput into the active line", () => {
    const presentation = resolve({
      snapshot: {
        ...idleChat,
        activeTurnId: "turn-1",
        outputTokensPerSecond: 63,
      },
    });

    expect(presentation.activity).toMatchObject({
      runId: "turn-1",
      outputTokensPerSecond: 63,
    });
  });

  it("keeps visible blocking flags on the interaction surface", () => {
    const permission = resolve({ activePermission: true });
    const questionnaire = resolve({ activeQuestionnaire: true });

    expect(permission.activity.phase).toBe("idle");
    expect(questionnaire.activity.phase).toBe("idle");
  });

  it("uses the Activity line for reconnecting without replacing an active decision panel", () => {
    const presentation = resolve({
      connection: {
        phase: "disconnected",
        generation: 1,
        lastError: "authentication expired",
      },
      activePermission: true,
    });

    expect(presentation.activity).toEqual({
      phase: "reconnecting",
      runId: undefined,
      message: "authentication expired",
    });
    expect(presentation.composer).toMatchObject({
      mode: "blocked",
      attention: "permission",
    });
  });

  it("offers interrupt without guidance when the Queue feature is disabled", () => {
    const presentation = resolve({
      snapshot: { ...idleChat, activeTurnId: "turn-1" },
      queueEnabled: false,
    });

    expect(presentation.activity).toMatchObject({
      controls: ["details", "interrupt"],
    });
    expect(presentation.activity.draftLabel).toBeUndefined();
    expect(presentation.composer.mode).toBe("working");
  });

  it("offers guidance and queueing when the Draft has attachments", () => {
    const presentation = resolve({
      snapshot: { ...idleChat, activeTurnId: "turn-1" },
      attachmentCount: 1,
    });

    expect(presentation.activity).toMatchObject({
      controls: ["guide", "details", "interrupt"],
      draftLabel: `1 attachment · ${defaultQueueLabel}`,
    });
  });

  it("shows bounded retry reason, delay, and code while Runtime automatic retry is active", () => {
    const presentation = resolve({
      snapshot: { ...idleChat, activeTurnId: "turn-1" },
      llmRetry: {
        type: "session.llm_retry",
        timestampMs: 100,
        source: "runtime",
        sessionId: "session-1",
        turnId: "turn-1",
        callId: "call-1",
        scope: "agent",
        status: "waiting",
        retryAttempt: 2,
        maxRetries: 5,
        requestAttempt: 3,
        delayMs: 2_500,
        error: { reason: "rate_limited", code: 50_111 },
      },
    });

    expect(presentation.activity).toMatchObject({
      phase: "retrying",
      message:
        "Retrying model request · 2/5 · next in 3s · Rate Limited · code 50111",
    });
  });

  it("withdraws both run controls once the Turn is already stopping", () => {
    const presentation = resolve({
      snapshot: { ...idleChat, activeTurnId: "turn-1", cancelling: true },
    });

    expect(presentation.activity).toEqual({
      phase: "stopping",
      runId: "turn-1",
      draftLabel: defaultQueueLabel,
    });
  });

  it("never advertises run controls for a compaction, which runs without a Turn", () => {
    const presentation = resolve({ compacting: true });

    expect(presentation.activity).toEqual({
      phase: "compacting",
      runId: undefined,
      draftLabel: defaultQueueLabel,
    });
  });

  it("shows a Runtime initialization error when no Transcript cell can carry it", () => {
    expect(
      resolve({
        snapshot: {
          status: "error",
          sessions: [],
          error: "Unable to connect to the Runtime on port 1234",
        },
        surface: "welcome",
      }).activity,
    ).toEqual({
      phase: "error",
      message: "Unable to connect to the Runtime on port 1234",
    });
  });

  it("keeps reporting a settled failure once its error is already in the Transcript", () => {
    const error = "The response failed: provider unavailable";
    const presentation = resolve({
      snapshot: { ...idleChat, status: "error", error },
      transcript: new TranscriptStore([
        createTranscriptCell({
          id: "err-1",
          kind: "error",
          status: "failed",
          content: error,
          turnId: "turn-1",
          createdAtMs: 1,
        }),
      ]),
    });

    expect(presentation.activity).toEqual({
      phase: "error",
      errorSettled: true,
      runId: "turn-1",
    });
  });

  it("tags a settled failure with the turn id from its own failed transcript cell", () => {
    const error = "The response failed: provider unavailable";
    const presentation = resolve({
      snapshot: { ...idleChat, status: "error", error },
      transcript: new TranscriptStore([
        createTranscriptCell({
          id: "err-1",
          kind: "error",
          status: "failed",
          content: error,
          turnId: "turn_boom",
          createdAtMs: 1,
        }),
      ]),
    });

    expect(presentation.activity).toEqual({
      phase: "error",
      errorSettled: true,
      runId: "turn_boom",
    });
  });

  it("reports a session-level error without blaming the last settled turn", () => {
    const presentation = resolve({
      snapshot: {
        ...idleChat,
        status: "error",
        error: "Couldn't refresh this session.",
      },
    });

    expect(presentation.activity).toEqual({
      phase: "error",
      message: "Couldn't refresh this session.",
    });
  });

  it("still tags an active-turn failure that is not yet transcribed with the live turn id", () => {
    // When the turn is still the active one, the live id is authoritative even before the error
    // reaches the transcript — this is a real turn failure, not a session-level one.
    const presentation = resolve({
      snapshot: {
        ...idleChat,
        status: "error",
        error: "provider unavailable",
        activeTurnId: "turn_live",
      },
      currentLiveRunId: "turn_live",
    });

    expect(presentation.activity).toEqual({
      phase: "error",
      message: "provider unavailable",
      runId: "turn_live",
    });
  });

  it("does not treat the initial connection snapshot as a reconnect", () => {
    expect(
      resolve({ connection: { phase: "snapshotting", generation: 0 } })
        .activity,
    ).toEqual({
      phase: "idle",
    });
  });

  it("keeps queued content in the Follow-up panel instead of the Activity line", () => {
    const presentation = resolve({ runtimeQueuedCount: 2 });

    expect(presentation.activity).toEqual({ phase: "idle" });
    expect(presentation.composer.mode).toBe("follow-up");
    expect(JSON.stringify(presentation.activity)).not.toContain("2");
  });

  it("uses CLI product language for account state", () => {
    expect(resolve().shell.accountStatus).toBe("Checking account");
    expect(
      resolve({
        snapshot: {
          status: "idle",
          sessions: [],
          account: { status: "ready", warnings: [] },
        },
      }).shell.accountStatus,
    ).toBe("Account ready");
    expect(
      resolve({
        snapshot: {
          status: "idle",
          sessions: [],
          account: { status: "needs-login", warnings: [] },
        },
      }).shell.accountStatus,
    ).toBe("Sign in with /login");
  });

  it.each([
    ["BYOK without a managed account", "api-key", false, [], "Ready", false],
    ["BYOK with a managed account", "api-key", true, [], "Ready", false],
    [
      "BYOK with no saved API key",
      "api-key",
      false,
      ["Provider API key is not configured"],
      "Setup warning",
      false,
    ],
    [
      "BYOK with invalid configuration",
      "api-key",
      true,
      ["Selected provider is disabled"],
      "Setup warning",
      false,
    ],
    ["official model signed out", "managed-login", false, [], "Login required", true],
    [
      "official model with expired credentials",
      "managed-login",
      false,
      ["Managed token expired"],
      "Login required",
      true,
    ],
    ["official model signed in", "managed-login", true, [], "Ready", false],
  ] as const)(
    "renders the selected route's readiness: %s",
    (_name, authMode, tokenPresent, warnings, activity, loginRequired) => {
      const providerId = authMode === "api-key" ? "custom_provider:test" : "minimax";
      const account = normalizeAccountStatus({
        selection: {
          providerId,
          modelId: "test-model",
          defaultModel: `${providerId}/test-model`,
        },
        provider: { id: providerId, authMode },
        auth: { tokenPresent },
        warnings,
      });
      const { shell } = resolve({
        snapshot: { ...idleChat, account },
        selectedModel: {
          providerId,
          modelId: "test-model",
          displayName: "Selected model",
        },
      });
      expect(shell.model).toBe("Selected model");
      expect(account.warnings).toEqual(warnings);
      for (const width of [50, 80, 120]) {
        const rendered = stripAnsi(new TuiWelcome(shell).render(width).join("\n"));
        expect(rendered).toContain(activity);
        expect(rendered.includes("Sign in with /login")).toBe(loginRequired);
        expect(rendered.includes("Login required")).toBe(loginRequired);
        if (warnings.length && !loginRequired) {
          expect(rendered).not.toContain("● Ready");
          expect(rendered).toContain("/provider or /status");
        }
      }
    },
  );

  it("does not infer readiness from a model label while account state is unknown", () => {
    for (const account of [
      undefined,
      normalizeAccountStatus({ auth: { tokenPresent: false } }),
    ]) {
      const { shell } = resolve({
        snapshot: { ...idleChat, account },
        selectedModel: { providerId: "custom_provider:test", modelId: "test-model" },
      });
      const rendered = stripAnsi(new TuiWelcome(shell).render(80).join("\n"));
      expect(rendered).toContain(account ? "Account unavailable" : "Checking account");
      expect(rendered).not.toContain("● Ready");
      expect(rendered).not.toContain("Login required");
      expect(rendered).not.toContain("Sign in with /login");
    }
  });

  it("projects the selected model and Token Plan quota without live activity details", () => {
    const presentation = resolve({
      currentLiveRunId: "turn-1",
      selectedModel: {
        providerId: "minimax",
        modelId: "MiniMax-M2.7",
        displayName: "m2.7",
        variant: "high",
      },
      snapshot: {
        status: "running",
        sessions: [],
        account: {
          status: "ready",
          authMode: "managed-login",
          managedTokenPresent: true,
          modelSource: "token-plan",
          tokenPlanQuota: {
            fiveHour: { unlimited: false, remainingPercent: 20 },
            weekly: { unlimited: false, remainingPercent: 50 },
          },
          warnings: [],
        },
      },
    });

    expect(presentation.shell).toMatchObject({
      model: "m2.7#high",
      accountStatus: "Account ready",
      tokenPlanQuotaState: "available",
      busy: true,
    });
    expect(JSON.stringify(presentation.shell)).not.toMatch(
      /Esc|Read|Thinking|waiting/u,
    );
  });

  it("projects switchable Thinking independently from the selected model label", () => {
    expect(
      resolve({
        selectedModel: {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          displayName: "MiniMax-M3",
          selected: true,
          variant: "thinking",
          thinkingConfig: { mode: "switchable", defaultValue: "true" },
        },
      }).shell,
    ).toMatchObject({ model: "MiniMax-M3", thinking: "on" });
    expect(
      resolve({
        selectedModel: {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          displayName: "MiniMax-M3",
          selected: true,
          variant: "",
          thinkingConfig: { mode: "switchable", defaultValue: "false" },
        },
      }).shell,
    ).toMatchObject({ model: "MiniMax-M3", thinking: "off" });
  });

  it("projects forced Thinking and hides undisclosed Thinking state", () => {
    expect(
      resolve({
        selectedModel: {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          thinkingConfig: { mode: "forced_on" },
        },
      }).shell,
    ).toMatchObject({ model: "minimax/MiniMax-M3", thinking: "on" });
    expect(
      resolve({
        selectedModel: {
          providerId: "provider",
          modelId: "hidden-model",
          variant: "thinking",
          thinkingConfig: { mode: "hidden" },
        },
      }).shell,
    ).not.toHaveProperty("thinking");
  });

  it("projects Session effort only while thinking is enabled", () => {
    const model = {
      providerId: "custom_provider:byok",
      modelId: "byok-large-5",
      displayName: "byok-large-5",
      selected: true,
      effortOptions: ["low", "medium", "high", "xhigh", "max"],
      variant: "",
      thinkingConfig: { mode: "switchable", defaultValue: "false" },
    };

    expect(
      resolve({
        selectedModel: { ...model, variant: "thinking" },
        selectedEffort: "max",
      }).shell,
    ).toMatchObject({
      model: "byok-large-5",
      effort: "max",
    });
    const off = resolve({ selectedModel: model, selectedEffort: "max" }).shell;
    expect(off).toMatchObject({ thinking: "off" });
    expect(off).not.toHaveProperty("effort");
    expect(resolve({ selectedModel: model }).shell).toMatchObject({
      thinking: "off",
    });
    expect(resolve({ selectedModel: model }).shell).not.toHaveProperty(
      "effort",
    );
  });

  it("omits think effort for models that expose no levels", () => {
    expect(
      resolve({
        selectedModel: { providerId: "minimax", modelId: "MiniMax-M3" },
        selectedEffort: "high",
      }).shell,
    ).not.toHaveProperty("effort");
  });

  it("keeps a failed turn settled as a failure after history reconciliation clears the snapshot error", () => {
    const presentation = resolve({
      snapshot: { ...idleChat, status: "idle", error: undefined },
      transcript: new TranscriptStore([
        createTranscriptCell({
          id: "terminal-error:turn-1:1",
          kind: "error",
          status: "failed",
          content: "Runtime failure",
          turnId: "turn-1",
          createdAtMs: 5,
        }),
      ]),
    });
    expect(presentation.activity).toMatchObject({
      phase: "error",
      errorSettled: true,
    });
  });
});
