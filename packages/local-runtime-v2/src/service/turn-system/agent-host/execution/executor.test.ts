import { createLocalTurnEventWriter } from '../events/runtime-event-writer.js';
import { createLocalTurnOutcomeTracker } from '../runner/turn-outcome.js';
import { RespDataType, ToolCallStatus } from '@mavis/agent-core/protocol/agent-message';
import {
  RUNTIME_EVENT_SCHEMA,
  RuntimeEventStatus,
  RuntimeEventType,
  type RuntimeEvent,
} from "@mavis/agent-core/protocol";
import type {
  LLMModelConfig,
  PiBeforeLlmCallHookInput,
} from "@mavis/agent-core/pi-turn-runner";
import {
  composeStreamFn,
  PiTurnRunner,
} from "@mavis/agent-core/pi-turn-runner";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  toRuntimeTool,
  type RuntimeTool,
  type ToolExecutionContext,
  type ToolResult,
} from "@mavis/agent-core/tools";
import {
  LocalBashTool,
  type LocalSandboxBashOperationsFactory,
} from "@mavis/agent-tools/desktop";
import {
  buildLocalTurnToolCatalog,
  type LocalTurnAgentProfileFacts,
} from "../assembly/local-turn-tool-catalog.js";
import {
  BuiltinAgentCatalog,
  resolveCanonicalCapabilities,
} from "../../../agent/builtin/catalog.js";
import type { AssemblyResult } from "@mavis/agent-runtime";
import { createAgentRuntime } from "@mavis/agent-runtime";
import { sessionReportExtension } from "@mavis/agent-extension";
import {
  pluginHookCodexTranscriptPath,
  pluginHookTranscriptPath,
} from "@mavis/agent-tools";
import { serializeAgentReference } from "@mavis/shared/agent-mention";
import { Type } from "@sinclair/typebox";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { digestSafetyInput } from "../../../content-safety/index.js";
import type {
  SessionLlmCallReportCapability,
  SessionRecord,
} from "../../../session-system/index.js";
import { ContextUsageAnchorState } from "../../compaction/execution/usage-anchor.js";
import { createTurnController } from "../../execution/turn-controller/turn.controller.js";
import { createBackgroundCadenceReminder } from "../../execution/reminder/background-cadence-reminder.js";
import type { AgentExecutionSnapshot } from "../preparation/contracts.js";
import type {
  AgentHostCloseResult,
  AgentHostFileChangeObservation,
  LocalTurnExecutionInput,
} from "../runner/contracts.js";
import type { AgentEventDelivery } from "../events/contracts.js";
import type { CanonicalHistoryStore } from "../history/contracts.js";
import { AgentHostCommittedHistoryWriter } from "../history/committed-history-writer.js";
import {
  AgentTerminalConfirmationError,
  LocalRuntimeTerminalError,
  LocalRuntimeTerminalIdentityError,
  TurnCommitPipeline,
} from "../events/turn-commit-pipeline.js";
import {
  LocalRuntimeTurnExecutor,
  type LocalRuntimeTurnExecutorOptions,
  type LocalRuntimeTurnRunnerInput,
  type LocalRuntimeTurnRunnerResult,
} from "./executor.js";
import { localPluginHookCoordinator } from "../assembly/local-turn-plugin-hooks.js";
import { NativeLocalTurnExecutionPreparationSource } from "../assembly/local-turn-execution-preparation.js";
import { LocalTurnInputPreparer } from "../assembly/local-turn-input-preparation.js";

interface LocalToolContext extends ToolExecutionContext {
  readonly permissionScope?: string;
}

const MESSAGES_API = "anthropic-messages";
const MESSAGES_SUFFIX = MESSAGES_API.slice(0, -"-messages".length);

const terminalEvent = (status: RuntimeEventStatus): RuntimeEvent => ({
  schema: RUNTIME_EVENT_SCHEMA,
  event_id: `terminal-${status}`,
  session_id: "session-1",
  turn_id: "turn-1",
  runtime_seq: 2,
  type: RuntimeEventType.SESSION_STATUS,
  payload: {
    status,
    stop_reason: { message: `terminal:${status}`, type: 1 },
  },
});

const assembly = (): AssemblyResult => ({
  systemPromptPrefix: "extension system",
  userPromptPrefix: "extension user",
  tools: [],
  hooks: {
    beforeLlmCallHook: [vi.fn()],
    onHistoryChangedHook: [vi.fn()],
  },
  reminders: [
    {
      providerName: "urgent",
      reminder: {
        content: "<system-reminder>urgent reminder</system-reminder>",
        priority: 100,
      },
    },
    {
      providerName: "normal",
      reminder: {
        content: "<system-reminder>normal reminder</system-reminder>",
        priority: 1,
      },
    },
  ],
  turnStartHandlers: [],
  turnEndHandlers: [],
  diagnostic: {
    loadedExtensions: [],
    enabledExtensions: [],
    disabledExtensions: [],
    toolCount: 0,
    reminderCount: 2,
  },
});

function executionInput(
  overrides: Partial<LocalTurnExecutionInput> = {},
): LocalTurnExecutionInput {
  const {
    onRuntimeEvent: observeRuntimeEvent,
    resolveTerminalOutcome,
    ...remainingOverrides
  } = overrides;
  const terminalPipeline = createTerminalPipeline();
  const session: SessionRecord = {
    sessionId: "session-1",
    agentName: "agent-1",
    workspaceDir: "/workspace",
    runtime: "pi-agent",
    sessionType: "root",
    sessionKind: "conversation",
    archived: false,
    status: "idle",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const agent: AgentExecutionSnapshot = {
    agentName: "agent-1",
    systemPrompt: "base system",
    model: { providerId: "provider", modelId: "model" },
  };
  const preparation = {
    agentConfig: {
      system_prompt: "base system",
      model: { provider: "provider", model_id: "model" },
    },
    llm: modelConfig(),
  } as const;
  const canonicalUserInput = {
    text: "hello",
    messages: [{ text: "hello" }],
  } as const;
  return {
    lease: {
      sessionId: "session-1",
      turnId: "turn-1",
      leaseId: "lease-1",
      acceptedSequence: 1,
      acceptedAtMs: 100,
      busyReason: "turn",
      signal: new AbortController().signal,
    },
    request: {
      clientRequestId: "request-1",
      input: { text: "hello", attachments: [{ assetId: "attachment-1" }] },
      genuineUserQueryText: "hello",
      requiresInputReview: true,
      provenance: { source: "api", routingFingerprint: "api:1" },
    },
    session,
    agent,
    preparation,
    assemblyContext: {
      sessionId: "session-1",
      turnId: "turn-1",
      agentName: "agent-1",
      workspaceDir: "/workspace",
      agentConfig: preparation.agentConfig,
      model: preparation.agentConfig.model,
      history: [{ role: "user", content: "history", timestamp: 1 }],
      userInput: { text: canonicalUserInput.text },
    },
    assembly: assembly(),
    history: {
      revision: "r1",
      messages: [{ role: "user", content: "history", timestamp: 1 }],
    },
    canonicalUserInput,
    onRuntimeEvent: async (event) => {
      await terminalPipeline.onRuntimeEvent(event);
      await observeRuntimeEvent?.(event);
    },
    onHistoryChanged: vi.fn(async () => undefined),
    registerCanonicalUserMessageIds: vi.fn(),
    rearmPrimaryUserMessageIdAfterOutputRecall: vi.fn(),
    resolveTerminalOutcome:
      resolveTerminalOutcome ??
      ((reconcile) => terminalPipeline.resolveOutcome(reconcile)),
    control: {
      sealAbnormalTerminal: vi.fn(async () => undefined),
      openToolResultTail: vi.fn(() => true),
      closeAndClaimToolResultTail: vi.fn(() => []),
      ackToolResultTail: vi.fn(),
      drainSteering: vi.fn(() => []),
      ackSteering: vi.fn(),
      restoreSteering: vi.fn(),
      tryBeginClose: vi.fn((): AgentHostCloseResult => ({ closed: true })),
    },
    ...remainingOverrides,
  };
}

function taskExecutionInput(
  mode: "foreground" | "background" | "team",
): LocalTurnExecutionInput {
  const base = executionInput();
  const purpose =
    mode === "foreground"
      ? "local-task:turn-1:tool-1"
      : mode === "background"
        ? "local-background-task:task-1"
        : "team-plan:plan-1:task-1";
  const agentConfig = {
    ...base.preparation.agentConfig,
    agent_profile: {
      surface: "task-child",
      task_execution_mode: mode,
    },
  };
  return executionInput({
    ...(mode === "background"
      ? {
          request: {
            ...base.request,
            provenance: {
              source: "background-task",
              routingFingerprint: "background-task:task-1",
            },
          },
        }
      : {}),
    session: {
      ...base.session,
      sessionType: "branch",
      sessionKind: "task",
      parentSessionId: "session-parent",
      visibility: "visible",
      purpose,
    },
    preparation: {
      ...base.preparation,
      agentConfig,
    } as never,
    assemblyContext: {
      ...base.assemblyContext,
      agentConfig,
    } as never,
  });
}

function videoGateExecutionInput(
  mode:
    | "owner"
    | "foreground"
    | "background"
    | "team"
    | "forged-background-chat"
    | "profile-only-background"
    | "session-only-background"
    | "wrong-session-kind-background",
): LocalTurnExecutionInput {
  if (mode === "owner") return executionInput();
  if (mode === "foreground" || mode === "background" || mode === "team") {
    return taskExecutionInput(mode);
  }
  const owner = executionInput();
  const background = taskExecutionInput("background");
  if (mode === "forged-background-chat") {
    return executionInput({
      ...background,
      request: {
        ...background.request,
        provenance: {
          source: "api",
          routingFingerprint: "api:forged-background",
        },
      },
    });
  }
  if (mode === "wrong-session-kind-background") {
    return executionInput({
      ...background,
      session: { ...background.session, sessionKind: "conversation" },
    });
  }
  return mode === "profile-only-background"
    ? executionInput({
        preparation: background.preparation,
        assemblyContext: {
          ...owner.assemblyContext,
          agentConfig: background.preparation.agentConfig,
        },
      })
    : executionInput({
        session: background.session,
        preparation: owner.preparation,
        assemblyContext: {
          ...background.assemblyContext,
          agentConfig: owner.preparation.agentConfig,
        },
      });
}

function createTerminalPipeline(): TurnCommitPipeline {
  const history: CanonicalHistoryStore = {
    read: vi.fn(),
    append: vi.fn(),
    replace: vi.fn(),
  };
  const events: AgentEventDelivery = {
    handleRuntimeEvent: vi.fn(async () => ({ terminal: false as const })),
    handleHistoryCommitted: vi.fn(),
  };
  return new TurnCommitPipeline({
    context: { sessionId: "session-1", turnId: "turn-1", turnSequence: 1 },
    lease: {
      sessionId: "session-1",
      turnId: "turn-1",
      leaseId: "lease-1",
      acceptedSequence: 1,
      acceptedAtMs: 100,
      busyReason: "turn",
      signal: new AbortController().signal,
    },
    initialHistory: { revision: "r1", messages: [] },
    events,
    committedHistory: new AgentHostCommittedHistoryWriter({ history, events }),
    isRuntimeErrorRetryable: () => false,
  });
}

function modelConfig(): LLMModelConfig {
  return {
    model: {
      id: "model",
      name: "Model",
      api: "openai-completions",
      provider: "provider",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024,
    },
    apiKey: "credential",
  };
}

function runtimeMatrixTool(): RuntimeTool {
  const result: ToolResult = {
    tool_name: "matrix_gen_videos",
    text: "insufficient credits",
    content: [{ type: "text", text: "insufficient credits" }],
    details: { ok: false },
  };
  return {
    def: {
      name: "matrix_gen_videos",
      description: "test Matrix tool",
      schema: { type: "object" } as never,
    },
    impl: { execute: vi.fn(async () => result) },
    source: "builtin-matrix",
  };
}

function options(
  runTurn: (
    input: LocalRuntimeTurnRunnerInput<LocalToolContext>,
  ) => Promise<LocalRuntimeTurnRunnerResult | void>,
): LocalRuntimeTurnExecutorOptions<AgentExecutionSnapshot, LocalToolContext> {
  return {
    runtime: { runTurn },
    backgroundCadenceReminder: createBackgroundCadenceReminder(
      new ContextUsageAnchorState(),
    ),
    executionPreparation: {
      prepare: vi.fn(async ({ execution }) => ({
        userMessage: {
          attachments: [
            { type: "image" as const, data: "data", mimeType: "image/png" },
          ],
        },
        caller: "chat" as const,
        reminderBlocks: [],
        loadBackgroundReminder: vi.fn(async () => ({
          tasks: [],
          undeliveredTotal: 0,
          terminalTotal: 0,
        })),
        confirmBackgroundTaskReads: vi.fn(async () => undefined),
        toolResolution: {
          disableBuiltinToolFallback: true,
          permissionGuard: vi.fn(async () => undefined),
          context: {
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            permissionScope: "workspace",
          },
        },
      })),
    },
    fileChanges: {
      begin: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    },
    attemptRecall: {
      recallAssistantAttempt: vi.fn(async () => undefined),
    },
    captureToolTiming: vi.fn(() => true),
  };
}

function agentReferenceText(
  suffix: string,
  reference = { requestRef: "agent:coder", displayName: "Coder" },
): string {
  const serialized = serializeAgentReference(reference);
  if (!serialized)
    throw new Error("Agent reference test fixture failed to serialize.");
  return `${serialized} ${suffix}`;
}

function agentReferenceExecutionInput(input: {
  readonly agentProfile: Readonly<Record<string, unknown>>;
  readonly current: string;
  readonly history: string;
}): LocalTurnExecutionInput {
  const base = executionInput();
  const agentConfig = {
    ...base.preparation.agentConfig,
    agent_profile: input.agentProfile,
  };
  return executionInput({
    request: {
      ...base.request,
      input: { text: input.current },
      genuineUserQueryText: input.current,
    },
    preparation: { ...base.preparation, agentConfig } as never,
    assemblyContext: {
      ...base.assemblyContext,
      agentConfig,
      history: [{ role: "user", content: input.history, timestamp: 7 }],
      userInput: { text: input.current },
    } as never,
    assembly: { ...base.assembly, userPromptPrefix: "", reminders: [] },
    history: {
      revision: "r1",
      messages: [{ role: "user", content: input.history, timestamp: 7 }],
    },
    canonicalUserInput: {
      text: input.current,
      messages: [{ text: input.current }],
    },
  });
}

function agentReferenceExecutionPreparation(
  resolveAgentReference: (
    requestRef: string,
  ) => Promise<"authorized" | "unknown" | "unauthorized">,
) {
  return new NativeLocalTurnExecutionPreparationSource(
    new LocalTurnInputPreparer({
      agentReferenceProjection: { resolveAgentReference },
      reminders: {
        buildBackground: vi.fn(async () => ({
          tasks: [],
          undeliveredTotal: 0,
          terminalTotal: 0,
        })),
        buildSystem: vi.fn(async () => ({ content: "" })),
        confirmBackgroundTaskReads: vi.fn(async () => []),
      },
    }),
    { beforeToolCall: vi.fn(async () => undefined) } as never,
  );
}

function afterToolContext() {
  return {
    assistantMessage: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tool-call-a",
          name: "runtime-tool",
          arguments: { input: "approved input" },
        },
      ],
      api: "openai-completions",
      provider: "provider",
      model: "model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: 1,
    },
    toolCall: {
      type: "toolCall",
      id: "tool-call-a",
      name: "runtime-tool",
      arguments: { input: "approved input" },
    },
    args: { input: "approved input" },
    result: {
      content: [{ type: "text", text: "original tool output" }],
      details: { original: true },
    },
    isError: false,
    context: {
      systemPrompt: "system",
      messages: [{ role: "user", content: "history", timestamp: 1 }],
      tools: [],
    },
  };
}

describe("LocalRuntimeTurnExecutor", () => {
  it("injects SessionStart and UserPromptSubmit Hook context into the admitted prompt", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const handlers = [
      {
        kind: "command" as const,
        sourceFormat: "MINIMAX" as const,
        pluginName: "context-plugin",
        pluginRoot: "/tmp/context-plugin",
        sourcePath: "hooks/hooks.json",
        event: "SessionStart" as const,
        command: "true",
        timeoutMs: 100,
        declarationOrder: 0,
      },
    ];
    const frozenHandlers = [...handlers];
    const handlersForTurn = vi
      .spyOn(localPluginHookCoordinator, "handlersForTurn")
      .mockReturnValue(frozenHandlers);
    const beginTurn = vi
      .spyOn(localPluginHookCoordinator, "beginTurn")
      .mockResolvedValue({
        decision: {
          decision: "allow",
          additionalContext: "initialized context",
        },
        diagnostics: [],
      });
    const startSubagent = vi
      .spyOn(localPluginHookCoordinator, "startSubagent")
      .mockResolvedValue({
        decision: "allow",
        additionalContext: "child context",
      });
    const resumeIdle = vi.spyOn(
      localPluginHookCoordinator,
      "resumeIdleCountdown",
    );
    const bindOwnership = vi.spyOn(
      localPluginHookCoordinator,
      "bindSessionOwnershipClaim",
    );
    const clearPluginHookSessionPermissions = vi.fn(async () => undefined);
    const preparePluginHookSessionOwnership = vi.fn(async () => undefined);
    const activatePluginHookSessionOwnership = vi.fn(async () => undefined);
    const executorOptions = {
      ...options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      clearPluginHookSessionPermissions,
      preparePluginHookSessionOwnership,
      activatePluginHookSessionOwnership,
    };

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(
        executionInput({ pluginHooks: handlers }),
      ),
    ).resolves.toEqual({ status: "completed" });

    expect(captured?.includeDetailedUsage).toBe(true);
    expect(handlersForTurn).toHaveBeenCalledWith("session-1", handlers);
    expect(beginTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        handlers: frozenHandlers,
        prompt: "hello",
        resumeExistingSession: true,
        sessionEndCleanup: expect.any(Function),
      }),
    );
    expect(preparePluginHookSessionOwnership).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-1",
      ownershipClaimId: "lease-1",
    });
    expect(bindOwnership).toHaveBeenCalledWith("session-1", "lease-1");
    expect(activatePluginHookSessionOwnership).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-1",
      ownershipClaimId: "lease-1",
    });
    expect(
      preparePluginHookSessionOwnership.mock.invocationCallOrder[0],
    ).toBeLessThan(beginTurn.mock.invocationCallOrder[0]!);
    expect(beginTurn.mock.invocationCallOrder[0]).toBeLessThan(
      bindOwnership.mock.invocationCallOrder[0]!,
    );
    expect(bindOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      activatePluginHookSessionOwnership.mock.invocationCallOrder[0]!,
    );
    const sessionEndCleanup = beginTurn.mock.calls[0]?.[0].sessionEndCleanup;
    await sessionEndCleanup?.();
    expect(clearPluginHookSessionPermissions).toHaveBeenCalledWith("session-1");
    expect(captured?.userMessage.text).toContain(
      "<plugin-hook-context>\ninitialized context\n</plugin-hook-context>",
    );
    expect(captured?.toolContext).toHaveProperty("pluginSubagentLifecycle");
    const lifecycle = Reflect.get(
      captured?.toolContext ?? {},
      "pluginSubagentLifecycle",
    ) as {
      start(
        input: Readonly<Record<string, unknown>>,
      ): Promise<string | undefined>;
    };
    await expect(
      lifecycle.start({
        childSessionId: "child-session",
        childTurnId: "child-turn",
        agentId: "child-agent",
        agentType: "researcher",
      }),
    ).resolves.toBe("child context");
    expect(startSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "session-1",
        parentTurnId: "turn-1",
        parentPromptId: "turn-1",
        childSessionId: "child-session",
        agentId: "child-agent",
        agentType: "researcher",
      }),
      undefined,
    );
    expect(resumeIdle).toHaveBeenCalledWith("session-1");
    handlersForTurn.mockRestore();
    beginTurn.mockRestore();
    startSubagent.mockRestore();
    resumeIdle.mockRestore();
    bindOwnership.mockRestore();
  });

  it("restores the prior process-local Hook owner when durable activation fails", async () => {
    const beginTurn = vi
      .spyOn(localPluginHookCoordinator, "beginTurn")
      .mockResolvedValue({
        decision: { decision: "allow" },
        diagnostics: [],
      });
    const bindOwnership = vi
      .spyOn(localPluginHookCoordinator, "bindSessionOwnershipClaim")
      .mockReturnValue("previous-claim");
    const rollbackOwnership = vi.spyOn(
      localPluginHookCoordinator,
      "rollbackSessionOwnershipClaim",
    );
    const resumeIdle = vi.spyOn(
      localPluginHookCoordinator,
      "resumeIdleCountdown",
    );
    const preparePluginHookSessionOwnership = vi.fn(async () => undefined);
    const activatePluginHookSessionOwnership = vi.fn(async () => {
      throw new Error("activation CAS failed");
    });
    const runTurn = vi.fn(async () => undefined);
    const executorOptions = {
      ...options(runTurn),
      preparePluginHookSessionOwnership,
      activatePluginHookSessionOwnership,
    };

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(executionInput()),
    ).rejects.toThrow("activation CAS failed");

    expect(rollbackOwnership).toHaveBeenCalledWith(
      "session-1",
      "lease-1",
      "previous-claim",
    );
    expect(runTurn).not.toHaveBeenCalled();
    expect(resumeIdle).toHaveBeenCalledWith("session-1");
    beginTurn.mockRestore();
    bindOwnership.mockRestore();
    rollbackOwnership.mockRestore();
    resumeIdle.mockRestore();
  });

  it("releases a transcript created before durable ownership preparation fails", async () => {
    const handler = {
      kind: "command" as const,
      sourceFormat: "MINIMAX" as const,
      pluginName: "prepare-failure-plugin",
      pluginRoot: "/tmp/prepare-failure-plugin",
      sourcePath: "hooks/hooks.json",
      event: "SessionStart" as const,
      command: "true",
      timeoutMs: 100,
      declarationOrder: 0,
    };
    const preparePluginHookSessionOwnership = vi.fn(async () => {
      throw new Error("ownership preparation failed");
    });
    const executorOptions = {
      ...options(async () => undefined),
      resolvePluginHookRuntimeContext: () => ({
        transcriptPath: "/requested/transcript.jsonl",
      }),
      preparePluginHookSessionOwnership,
      activatePluginHookSessionOwnership: vi.fn(async () => undefined),
    };

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(
        executionInput({ pluginHooks: [handler] }),
      ),
    ).rejects.toThrow("ownership preparation failed");

    await expect(
      stat(pluginHookTranscriptPath("session-1")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(pluginHookCodexTranscriptPath("session-1")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("LocalRuntimeTurnExecutor Plugin prompt admission", () => {
  it("rejects a prompt denied by a Plugin Hook and still resumes the idle countdown", async () => {
    const beginTurn = vi
      .spyOn(localPluginHookCoordinator, "beginTurn")
      .mockResolvedValue({
        decision: { decision: "deny" },
        diagnostics: [],
      });
    const resumeIdle = vi.spyOn(
      localPluginHookCoordinator,
      "resumeIdleCountdown",
    );
    const runTurn = vi.fn(async () => undefined);
    const preparePluginHookSessionOwnership = vi.fn(async () => undefined);
    const activatePluginHookSessionOwnership = vi.fn(async () => undefined);

    await expect(
      new LocalRuntimeTurnExecutor({
        ...options(runTurn),
        preparePluginHookSessionOwnership,
        activatePluginHookSessionOwnership,
      }).execute(executionInput()),
    ).rejects.toThrow("User prompt was rejected by a Plugin Hook.");
    expect(runTurn).not.toHaveBeenCalled();
    expect(preparePluginHookSessionOwnership).toHaveBeenCalledOnce();
    expect(activatePluginHookSessionOwnership).toHaveBeenCalledOnce();
    expect(resumeIdle).toHaveBeenCalledWith("session-1");
    beginTurn.mockRestore();
    resumeIdle.mockRestore();
  });
});

describe("LocalRuntimeTurnExecutor Bash output capability", () => {
  it.each([true, false])(
    "bounds Bash receipt purpose text (run_in_background=%s)",
    async (runInBackground) => {
      const startBackground = vi.fn(async (_ctx: unknown, _input: unknown) => ({
        status: "started" as const,
        taskId: "receipt-task",
      }));
      const runManagedForeground = vi.fn(async (_ctx: unknown, _input: unknown) => ({
        status: "auto_promoted" as const,
        taskId: "receipt-task",
      }));
      const tool = new LocalBashTool(
        "/tmp/workspace",
        { startBackground, runManagedForeground },
        { mode: "off" },
      );
      const command = "echo " + "x".repeat(100_000);
      for (const description of [undefined, "说明🙂".repeat(20_000), "Inspect workspace"]) {
        const result = await tool.execute(
          {
            sessionId: "session-1",
            turnId: "turn-1",
            canConsumeBackgroundBashOutput: true,
          },
          { command, description, timeout: 600, run_in_background: runInBackground },
        );
        expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(24 * 1024);
        expect(result.text).not.toContain("\uFFFD");
        for (const retained of [
          'task_id="receipt-task"', "Command limit: 600s", "task_output", "task_stop",
        ]) {
          expect(result.text).toContain(retained);
        }
        expect(result.text).toContain(
          description === "Inspect workspace"
            ? "Purpose: Inspect workspace\n"
            : "[purpose truncated]",
        );
        expect(result.content).toEqual([{ type: "text", text: result.text }]);
        expect(result.details?.description).toBe(description ?? command);
        const adapter = runInBackground ? startBackground : runManagedForeground;
        expect(adapter.mock.lastCall?.[1]).toMatchObject({
          command, description: description ?? command,
        });
      }
    },
  );

  it.each([
    {
      name: "custom bash-only selector",
      role: undefined,
      selection: { tools: ["bash"] },
      allowed: false,
    },
    {
      name: "explicit output denial",
      role: "worker",
      selection: { disallowedTools: ["task_output"] },
      allowed: false,
    },
    {
      name: "frozen legacy Worker selector",
      role: "worker",
      selection: { tools: ["read", "bash"] },
      allowed: false,
    },
    {
      name: "frozen legacy Verifier selector",
      role: "verifier",
      selection: { tools: ["read", "bash"] },
      allowed: false,
    },
    {
      name: "current Explore has no task output",
      role: "explore",
      selection: undefined,
      allowed: false,
    },
    {
      name: "current Worker controls",
      role: "worker",
      selection: undefined,
      allowed: true,
    },
    {
      name: "current Verifier controls",
      role: "verifier",
      selection: undefined,
      allowed: true,
    },
  ])(
    "gates automatic Bash promotion after routing: $name",
    async ({ role, selection, allowed }) => {
      const definition = role
        ? await new BuiltinAgentCatalog().readDefinition(role)
        : undefined;
      const capabilities = resolveCanonicalCapabilities(
        undefined,
        definition?.capabilityOverride,
      );
      const runManagedForeground = vi.fn(async () => ({
        status: "auto_promoted" as const,
        taskId: "managed-task",
      }));
      const startBackground = vi.fn(async () => ({
        status: "started" as const,
        taskId: "background-task",
      }));
      const direct = vi.fn<
        ReturnType<LocalSandboxBashOperationsFactory["create"]>["exec"]
      >(async (_command, _cwd, opts) => {
        opts.onData(Buffer.from("foreground output"));
        return { exitCode: 0 };
      });
      const bash = toRuntimeTool(
        new LocalBashTool(
          "/tmp/workspace",
          { startBackground, runManagedForeground },
          { mode: "off" },
          undefined,
          { create: () => ({ exec: direct }) },
        ),
      );
      const profile: LocalTurnAgentProfileFacts = {
        trustedBuiltin: role !== undefined,
        ...(role ? { canonicalRole: role } : {}),
        surface: "task-child",
        capabilityCeiling: {
          personaEnabled: capabilities.persona.enabled,
          tools: capabilities.tools,
          features: capabilities.features,
        },
        configSelection: selection ?? {
          tools: definition?.capabilityOverride?.tools,
        },
      };
      const catalog = buildLocalTurnToolCatalog({
        sessionId: "session-1",
        sources: {
          nativeTools: [
            bash,
            {
              ...runtimeMatrixTool(),
              def: { ...runtimeMatrixTool().def, name: "task_output" },
              source: "builtin",
            },
          ],
          mcpEntries: [],
          threadGoalTools: [],
          cuRuntimeAvailable: false,
        },
        agentProfile: profile,
        llmModel: { provider: "p", id: "m", contextWindow: 100_000 },
        env: {},
      });
      const opts = options(async (runInput) => {
        expect(runInput.toolContext).toHaveProperty(
          "allowBashAutoPromotion",
          allowed,
        );
        expect(runInput.toolContext).toHaveProperty(
          "canConsumeBackgroundBashOutput",
          allowed,
        );
        const admittedBash = runInput.tools?.find(
          (tool) => tool.def.name === "bash",
        );
        const toolContext = runInput.toolContext;
        if (!admittedBash || !toolContext) {
          throw new Error(
            "Expected the native Bash tool and its Turn context to remain admitted",
          );
        }
        const properties = admittedBash.def.schema.properties as Record<string, unknown>;
        expect('run_in_background' in properties).toBe(allowed);
        expect(admittedBash.def.description).toContain(
          allowed ? 'task_output' : 'foreground execution only',
        );
        expect(bash.def.schema.properties).toHaveProperty('run_in_background');
        expect(admittedBash.def.schema).not.toBe(bash.def.schema);
        const result = await admittedBash.impl.execute(
          toolContext,
          { command: "controlled command" },
          runInput.signal,
        );
        if (allowed) expect(result.details?.status).toBe("auto_promoted");
        else {
          expect(result.text).toContain("foreground output");
          expect(result.details?.task_id).toBeUndefined();
        }
        const backgroundResult = await admittedBash.impl.execute(
          toolContext,
          { command: "controlled background command", run_in_background: true },
          runInput.signal,
        );
        if (allowed) {
          expect(backgroundResult.details).toMatchObject({
            status: "started",
            task_id: "background-task",
          });
        } else {
          expect(backgroundResult).toMatchObject({
            isError: true,
            details: {
              status: "background_output_unavailable",
              error_code: "BASH_BACKGROUND_OUTPUT_UNAVAILABLE",
            },
          });
        }
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      });
      const input = taskExecutionInput("background");
      await new LocalRuntimeTurnExecutor(opts).execute({
        ...input,
        assembly: { ...input.assembly, tools: catalog.tools },
      });
      expect(runManagedForeground).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(startBackground).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(direct).toHaveBeenCalledTimes(allowed ? 0 : 1);
    },
  );

  it.each([
    { source: undefined, allowed: true },
    { source: "builtin" as const, allowed: true },
    { source: "configured" as const, allowed: false },
    { source: "builtin-matrix" as const, allowed: false },
  ])(
    "allows explicit background Bash only for trusted native output provenance: $source",
    async ({ source, allowed }) => {
      const input = executionInput();
      const startBackground = vi.fn(async () => ({
        status: "started" as const,
        taskId: "background-task",
      }));
      const bash = toRuntimeTool(
        new LocalBashTool(
          "/tmp/workspace",
          { startBackground },
          { mode: "off" },
        ),
      );
      const output = {
        impl: runtimeMatrixTool().impl,
        def: { ...runtimeMatrixTool().def, name: "task_output" },
        ...(source ? { source } : {}),
      };
      await new LocalRuntimeTurnExecutor(
        options(async (runInput) => {
          expect(runInput.toolContext).toHaveProperty(
            "allowBashAutoPromotion",
            allowed,
          );
          expect(runInput.toolContext).toHaveProperty(
            "canConsumeBackgroundBashOutput",
            allowed,
          );
          const admittedBash = runInput.tools?.find(
            (tool) => tool.def.name === "bash",
          );
          const toolContext = runInput.toolContext;
          if (!admittedBash || !toolContext) {
            throw new Error(
              "Expected the native Bash tool and its Turn context to remain admitted",
            );
          }
          expect('run_in_background' in admittedBash.def.schema.properties).toBe(allowed);
          const result = await admittedBash.impl.execute(
            toolContext,
            {
              command: "controlled background command",
              run_in_background: true,
            },
            runInput.signal,
          );
          if (allowed) {
            expect(result.details).toMatchObject({
              status: "started",
              task_id: "background-task",
            });
          } else {
            expect(result).toMatchObject({
              isError: true,
              details: {
                status: "background_output_unavailable",
                error_code: "BASH_BACKGROUND_OUTPUT_UNAVAILABLE",
              },
            });
          }
          await runInput.eventWriter.pushRuntime(
            terminalEvent(RuntimeEventStatus.COMPLETED),
          );
        }),
      ).execute({
        ...input,
        assembly: { ...input.assembly, tools: [bash, output] },
      });
      expect(startBackground).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );
});

describe("LocalRuntimeTurnExecutor", () => {
  it("projects runtime events before they reach the v2 commit pipeline", async () => {
    const delivered: string[] = [];
    const input = executionInput({
      onRuntimeEvent: vi.fn(async (event) => {
        delivered.push(event.event_id);
      }),
    });
    const executorOptions = options(async (runInput) => {
      await runInput.eventWriter.appendEvents([
        {
          ...terminalEvent(RuntimeEventStatus.COMPLETED),
          event_id: "candidate-xml-chunk",
          runtime_seq: 1,
          payload: { status: RuntimeEventStatus.RUNNING },
        },
        terminalEvent(RuntimeEventStatus.COMPLETED),
      ]);
    });
    const projectRuntimeEvent = vi.fn(
      async ({ event }: { readonly event: RuntimeEvent }) =>
        event.event_id === "candidate-xml-chunk" ? undefined : event,
    );
    const runner = new LocalRuntimeTurnExecutor({
      ...executorOptions,
      projectRuntimeEvent,
    });

    await expect(runner.execute(input)).resolves.toEqual({
      status: "completed",
    });
    expect(delivered).toEqual([`terminal-${RuntimeEventStatus.COMPLETED}`]);
    expect(projectRuntimeEvent).toHaveBeenCalledTimes(2);
    expect(projectRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
      }),
    );
  });

  it("maps the complete Host input into RunTurnInput and awaits history/event callbacks", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const order: string[] = [];
    const input = executionInput({
      onRuntimeEvent: vi.fn(async (event) => {
        order.push(`event:${event.event_id}`);
      }),
      onHistoryChanged: vi.fn(async () => {
        await Promise.resolve();
        order.push("history");
      }),
    });
    const runner = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        captured = runInput;
        await runInput.hooks?.onHistoryChangedHook?.[0]?.({
          sessionId: "session-1",
          turnId: "turn-1",
          reason: "messageDelta",
          messages: [{ role: "user", content: "new", timestamp: 2 }],
        });
        await runInput.eventWriter.appendEvents([
          {
            ...terminalEvent(RuntimeEventStatus.COMPLETED),
            event_id: "event-1",
            runtime_seq: 1,
            payload: { status: RuntimeEventStatus.RUNNING },
          },
          terminalEvent(RuntimeEventStatus.COMPLETED),
        ]);
      }),
    );

    await expect(runner.execute(input)).resolves.toEqual({
      status: "completed",
    });

    expect(captured).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-1",
      workspaceDir: "/workspace",
      systemPrompt: "extension system\n\nbase system",
      userMessage: {
        text:
          "extension user\n\n<system-reminder>urgent reminder</system-reminder>" +
          "\n\n<system-reminder>normal reminder</system-reminder>\n\nhello",
      },
      reviewUserInput: "hello",
      llm: { apiKey: "credential" },
      history: input.history.messages,
      signal: input.lease.signal,
      caller: "chat",
      captureToolTiming: true,
      tools: [],
      disableBuiltinToolFallback: true,
      toolContext: {
        sessionId: "session-1",
        turnId: "turn-1",
        permissionScope: "workspace",
      },
    });
    expect(captured?.llm.payloadTransform).toEqual(expect.any(Function));
    expect(captured?.userMessage.attachments).toHaveLength(1);
    expect(captured?.hooks?.beforeLlmCallHook).toEqual([
      ...(input.assembly.hooks.beforeLlmCallHook ?? []),
      expect.any(Function),
      expect.any(Function),
    ]);
    expect(captured?.hooks?.onHistoryChangedHook).toHaveLength(2);
    expect(order).toEqual([
      "history",
      "event:event-1",
      `event:terminal-${RuntimeEventStatus.COMPLETED}`,
    ]);
  });
});

describe("LocalRuntimeTurnExecutor runtime contracts", () => {
  it("starts continuation with the selected canonical provider history", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const history = agentReferenceText("unfinished work");
    const resolveAgentReference = vi.fn(async () => "authorized" as const);
    const runner = new LocalRuntimeTurnExecutor({
      ...options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      executionPreparation: agentReferenceExecutionPreparation(
        resolveAgentReference,
      ),
    });
    const base = agentReferenceExecutionInput({
      agentProfile: {
        agent_role: "orchestrator",
        canonical_view_name: "mavis",
        trusted_builtin: true,
        surface: "interactive",
      },
      current: "",
      history,
    });
    const input = agentReferenceExecutionInput({
      agentProfile: {
        agent_role: "orchestrator",
        canonical_view_name: "mavis",
        trusted_builtin: true,
        surface: "interactive",
      },
      current: "",
      history,
    });
    const continuation: LocalTurnExecutionInput = {
      ...input,
      request: {
        ...base.request,
        requiresInputReview: false,
        executionMode: "continuation",
      },
      runnerHistory: {
        revision: "r-runner",
        messages: [{ role: "user", content: history, timestamp: 1 }],
      },
    };

    await expect(runner.execute(continuation)).resolves.toEqual({
      status: "completed",
    });

    expect(captured).toMatchObject({
      startMode: "continue",
      history: continuation.runnerHistory?.messages,
    });
    expect(captured?.history?.[0]).toMatchObject({ content: history });
    expect(continuation.history.messages).toEqual(base.history.messages);
    expect(resolveAgentReference).not.toHaveBeenCalled();
  });

  it("passes materialized deployed website source to the runtime prompt", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const executorOptions = options(async (runInput) => {
      captured = runInput;
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    vi.mocked(executorOptions.executionPreparation.prepare).mockImplementation(
      async ({ execution }) => ({
        promptText:
          '<deployed-website-context>{"node_id":"node-1","source_path":"/workspace/source"}</deployed-website-context>',
        userMessage: {},
        caller: "chat",
        reminderBlocks: [],
        loadBackgroundReminder: vi.fn(async () => ({
          tasks: [],
          undeliveredTotal: 0,
          terminalTotal: 0,
        })),
        confirmBackgroundTaskReads: vi.fn(async () => undefined),
        toolResolution: {
          disableBuiltinToolFallback: true,
          permissionGuard: vi.fn(async () => undefined),
          context: {
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            permissionScope: "workspace",
          },
        },
      }),
    );
    const runner = new LocalRuntimeTurnExecutor(executorOptions);
    const input = executionInput({
      assembly: { ...assembly(), userPromptPrefix: "", reminders: [] },
    });

    await expect(runner.execute(input)).resolves.toEqual({
      status: "completed",
    });

    expect(captured?.userMessage.text).toContain(
      '"source_path":"/workspace/source"',
    );
  });
});

describe("LocalRuntimeTurnExecutor Agent reference canonical history", () => {
  const unavailableInternalAgent = (displayName: string) =>
    `这是当前不可调用的内部 Agent 引用，显示名为 ${JSON.stringify(`@${displayName}`)}。不要将其视为联系人或外部 @ 提及。`;

  const mainProfile = {
    agent_role: "orchestrator",
    canonical_view_name: "mavis",
    trusted_builtin: true,
    surface: "interactive",
  } as const;

  it("projects current references once and keeps committed history unchanged", async () => {
    const current = agentReferenceText("fix current");
    const history = agentReferenceText("fix history");
    const resolveAgentReference = vi.fn(async () => "authorized" as const);
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    let initialHookInput: PiBeforeLlmCallHookInput | undefined;
    const executor = new LocalRuntimeTurnExecutor({
      ...options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      executionPreparation: agentReferenceExecutionPreparation(
        resolveAgentReference,
      ),
      backgroundCadenceReminder: {
        prepare: vi.fn(async ({ hookInput }) => {
          initialHookInput = hookInput;
          return { beforeUserMessages: [], hook: async () => undefined };
        }),
      },
    });
    const input = agentReferenceExecutionInput({
      agentProfile: mainProfile,
      current,
      history,
    });

    await expect(executor.execute(input)).resolves.toEqual({
      status: "completed",
    });

    const projectedCurrent =
      "通过 Task tool 调用 agent:coder Agent fix current";
    expect(captured?.userMessage.text).toBe(projectedCurrent);
    expect(captured?.history?.[0]).toMatchObject({
      role: "user",
      content: history,
      timestamp: 7,
    });
    expect(initialHookInput?.canonicalMessages[0]).toMatchObject({
      role: "user",
      content: history,
      timestamp: 7,
    });
    expect(input.canonicalUserInput.text).toBe(current);
    expect(input.history.messages[0]).toMatchObject({
      role: "user",
      content: history,
      timestamp: 7,
    });
    expect(resolveAgentReference).toHaveBeenCalledTimes(1);
    expect(resolveAgentReference).toHaveBeenCalledWith("agent:coder");
  });

  it.each([
    [
      "direct SubAgent",
      {
        agent_role: "worker",
        canonical_view_name: "worker",
        trusted_builtin: true,
        surface: "interactive",
      },
    ],
    [
      "task child",
      {
        agent_role: "orchestrator",
        canonical_view_name: "mavis",
        trusted_builtin: true,
        surface: "task-child",
      },
    ],
  ] as const)(
    "does not resolve references from a %s model input",
    async (_label, agentProfile) => {
      const current = agentReferenceText("fix current");
      const history = agentReferenceText("fix history");
      const resolveAgentReference = vi.fn(async () => "authorized" as const);
      let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
      const executor = new LocalRuntimeTurnExecutor({
        ...options(async (runInput) => {
          captured = runInput;
          await runInput.eventWriter.pushRuntime(
            terminalEvent(RuntimeEventStatus.COMPLETED),
          );
        }),
        executionPreparation: agentReferenceExecutionPreparation(
          resolveAgentReference,
        ),
      });

      await expect(
        executor.execute(
          agentReferenceExecutionInput({ agentProfile, current, history }),
        ),
      ).resolves.toEqual({ status: "completed" });

      expect(resolveAgentReference).not.toHaveBeenCalled();
      expect(captured?.userMessage.text).toBe(
        `${unavailableInternalAgent("Coder")} fix current`,
      );
      expect(captured?.history?.[0]).toMatchObject({
        content: history,
      });
      expect(captured?.userMessage.text).not.toContain("<agent-reference");
    },
  );

  it.each([
    [
      "unknown",
      "unknown",
      { requestRef: "agent:missing", displayName: "Missing" },
    ],
    [
      "self",
      "unauthorized",
      { requestRef: "agent:mavis", displayName: "Mavis" },
    ],
  ] as const)(
    "degrades a %s main-surface reference to visible text",
    async (_label, resolution, reference) => {
      const current = agentReferenceText("fix current", reference);
      const history = agentReferenceText("fix history", reference);
      const resolveAgentReference = vi.fn(async () => resolution);
      let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
      const executor = new LocalRuntimeTurnExecutor({
        ...options(async (runInput) => {
          captured = runInput;
          await runInput.eventWriter.pushRuntime(
            terminalEvent(RuntimeEventStatus.COMPLETED),
          );
        }),
        executionPreparation: agentReferenceExecutionPreparation(
          resolveAgentReference,
        ),
      });

      await expect(
        executor.execute(
          agentReferenceExecutionInput({
            agentProfile: mainProfile,
            current,
            history,
          }),
        ),
      ).resolves.toEqual({ status: "completed" });

      expect(resolveAgentReference).toHaveBeenCalledTimes(1);
      expect(captured?.userMessage.text).toBe(
        `${unavailableInternalAgent(reference.displayName)} fix current`,
      );
      expect(captured?.history?.[0]).toMatchObject({
        content: history,
      });
      expect(captured?.userMessage.text).not.toContain("<agent-reference");
    },
  );
});

describe("LocalRuntimeTurnExecutor structured output", () => {
  it("binds json_object to every Provider call in the Turn", async () => {
    const baseInput = executionInput();
    const input = executionInput({
      request: {
        ...baseInput.request,
        outputContract: { type: "json_object" },
      },
      preparation: {
        ...baseInput.preparation,
        llm: {
          ...baseInput.preparation.llm,
          supportsJsonObjectOutput: true,
        },
      } as never,
    });
    const runner = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        const payload: Record<string, unknown> = {};
        await expect(
          runInput.llm.payloadTransform?.(payload, runInput.llm.model),
        ).resolves.toBe(payload);
        expect(payload).toEqual({ response_format: { type: "json_object" } });
        const checkpointPayload: Record<string, unknown> = {};
        await expect(
          runInput.llm.auxiliaryPayloadTransform?.(
            checkpointPayload,
            runInput.llm.model,
          ),
        ).resolves.toBeUndefined();
        expect(checkpointPayload).not.toHaveProperty("response_format");
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );

    await expect(runner.execute(input)).resolves.toEqual({
      status: "completed",
    });
  });

  it("rejects json_object for an OpenAI-compatible model without an explicit capability", async () => {
    const baseInput = executionInput();
    const runTurn = vi.fn(async () => undefined);
    const input = executionInput({
      request: {
        ...baseInput.request,
        outputContract: { type: "json_object" },
      },
      preparation: {
        ...baseInput.preparation,
        agentConfig: {
          ...baseInput.preparation.agentConfig,
          model: {
            provider: "provider",
            model_id: "model",
            capabilities: { support_json_object_output: true },
          },
        },
        llm: {
          ...baseInput.preparation.llm,
          supportsJsonObjectOutput: false,
        },
      } as never,
    });
    const runner = new LocalRuntimeTurnExecutor(options(runTurn));

    await expect(runner.execute(input)).rejects.toMatchObject({
      category: "config",
      code: "MODEL_CAPABILITY_UNAVAILABLE",
      retryable: false,
    });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("binds the accepted output contract to the final Provider payload transform", async () => {
    const outputSchema = { type: "object", required: ["status"] };
    const baseInput = executionInput();
    const input = executionInput({
      request: {
        ...baseInput.request,
        outputContract: { type: "json_schema", schema: outputSchema },
      },
    });
    const runner = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        const payload: Record<string, unknown> = {};
        await expect(
          runInput.llm.payloadTransform?.(payload, runInput.llm.model),
        ).resolves.toBe(payload);
        expect(payload).toEqual({
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "mcode_output",
              strict: true,
              schema: outputSchema,
            },
          },
        });
        const checkpointPayload: Record<string, unknown> = {};
        await expect(
          runInput.llm.auxiliaryPayloadTransform?.(
            checkpointPayload,
            runInput.llm.model,
          ),
        ).resolves.toBeUndefined();
        expect(checkpointPayload).not.toHaveProperty("response_format");
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );

    await expect(runner.execute(input)).resolves.toEqual({
      status: "completed",
    });
  });

  it("rejects an unsupported output contract before invoking the Turn runtime", async () => {
    const baseInput = executionInput();
    const runTurn = vi.fn(async () => undefined);
    const input = executionInput({
      request: {
        ...baseInput.request,
        outputContract: {
          type: "json_schema",
          schema: { type: "object", required: ["status"] },
        },
      },
      preparation: {
        ...baseInput.preparation,
        llm: {
          ...baseInput.preparation.llm,
          model: {
            ...baseInput.preparation.llm.model,
            api: "openai-codex-responses",
          },
        },
      },
    });
    const runner = new LocalRuntimeTurnExecutor(options(runTurn));

    await expect(runner.execute(input)).rejects.toMatchObject({
      category: "config",
      code: "MODEL_CAPABILITY_UNAVAILABLE",
      retryable: false,
    });
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("LocalRuntimeTurnExecutor File API", () => {
  it("binds the native Session upload store and turn cancellation to the final payload", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            file: { file_id: "file-v2" },
            base_resp: { status_code: 0 },
          }),
          { status: 200 },
        ),
    );
    const get = vi.fn(() => undefined);
    const set = vi.fn(() => undefined);
    const base = executionInput();
    const input = executionInput({
      preparation: {
        agentConfig: {
          ...base.preparation.agentConfig,
          model: {
            provider: "minimax",
            model_id: "MiniMax-M3",
            capabilities: {
              support_files_api: true,
              files_api_upload_endpoint: "/v1/files/upload",
            },
          },
        },
        llm: {
          ...base.preparation.llm,
          managedProvider: true,
          fileApiGatewayAuth: {
            gatewayHeaders: { Token: "matrix-token" },
            callerIdentityHash: "caller-user-1",
          },
          model: {
            ...base.preparation.llm.model,
            api: MESSAGES_API,
            baseUrl: `https://gateway.example/mavis/api/v1/llm/${MESSAGES_SUFFIX}`,
          },
        },
      },
    });
    const runnerOptions = options(async (runInput) => {
      const payload = {
        messages: [
          {
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "aW1hZ2U=",
                },
              },
            ],
          },
        ],
      };
      await expect(
        runInput.llm.payloadTransform?.(payload, runInput.llm.model),
      ).resolves.toBe(payload);
      expect(payload.messages[0]?.content[0]?.source).toEqual({
        type: "url",
        url: "mm_file://file-v2",
      });
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    const runner = new LocalRuntimeTurnExecutor({
      ...runnerOptions,
      fileApi: {
        uploadStores: {
          forSession: (sessionId) => {
            expect(sessionId).toBe("session-1");
            return { get, set };
          },
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    });

    await expect(runner.execute(input)).resolves.toEqual({
      status: "completed",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledOnce();
  });
});

describe("LocalRuntimeTurnExecutor context publication", () => {
  it.each([
    [RuntimeEventStatus.COMPLETED, { status: "completed" }],
    [
      RuntimeEventStatus.ABORTED,
      { status: "aborted", reason: `terminal:${RuntimeEventStatus.ABORTED}` },
    ],
  ])("maps terminal status %s to a Host outcome", async (status, expected) => {
    const runner = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        await runInput.eventWriter.pushRuntime(terminalEvent(status));
      }),
    );

    await expect(runner.execute(executionInput())).resolves.toEqual(expected);
  });

  it("preserves a completed runner wait-for-user signal in the Host outcome", async () => {
    const runner = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
        return { outcome: { status: "completed", waitingForUser: true } };
      }),
    );

    await expect(runner.execute(executionInput())).resolves.toEqual({
      status: "completed",
      waitingForUser: true,
    });
  });
});

describe("LocalRuntimeTurnExecutor user query provenance", () => {
  it("marks the exact query suffix after assembling the final initial prompt", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const query =
      "<system-reminder>user-authored tag</system-reminder> explain it";
    const base = executionInput();
    const executor = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );

    await executor.execute(
      executionInput({
        request: {
          ...base.request,
          input: { text: query },
          genuineUserQueryText: query,
        },
        canonicalUserInput: { text: query, messages: [{ text: query }] },
      }),
    );

    const text = [
      "extension user",
      "<system-reminder>urgent reminder</system-reminder>",
      "<system-reminder>normal reminder</system-reminder>",
      query,
    ].join("\n\n");
    expect(captured?.userMessage).toMatchObject({
      text,
      canonicalTextRange: {
        startOffset: text.length - query.length,
        endOffset: text.length,
      },
    });
    expect(captured?.userMessage).not.toHaveProperty("genuineUserQueryText");
  });

  it("stores the display-owned Plan query when the final prompt is internal", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const internalPrompt =
      "Implement the approved plan below.\n\n# Internal plan";
    const displayQuery = "开始实施已批准计划";
    const base = executionInput();
    const executor = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );

    await executor.execute(
      executionInput({
        request: {
          ...base.request,
          input: { text: internalPrompt },
          genuineUserQueryText: displayQuery,
          provenance: {
            source: "questionnaire",
            routingFingerprint: "questionnaire:plan",
          },
        },
        canonicalUserInput: {
          text: internalPrompt,
          messages: [{ text: internalPrompt }],
        },
        assembly: { ...base.assembly, userPromptPrefix: "", reminders: [] },
      }),
    );

    expect(captured?.userMessage).toMatchObject({
      text: internalPrompt,
      genuineUserQueryText: displayQuery,
      canonicalTextRange: {
        startOffset: internalPrompt.length,
        endOffset: internalPrompt.length,
      },
    });
  });

  it("marks a known-empty query at the end without copying query text", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const internalPrompt =
      "<background-task-finished>task-1</background-task-finished>";
    const base = executionInput();
    const executor = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );

    await executor.execute(
      executionInput({
        request: {
          ...base.request,
          input: { text: internalPrompt },
          genuineUserQueryText: "",
        },
        canonicalUserInput: {
          text: internalPrompt,
          messages: [{ text: internalPrompt }],
        },
        assembly: { ...base.assembly, userPromptPrefix: "", reminders: [] },
      }),
    );

    expect(captured?.userMessage).toMatchObject({
      text: internalPrompt,
      canonicalTextRange: {
        startOffset: internalPrompt.length,
        endOffset: internalPrompt.length,
      },
    });
    expect(captured?.userMessage).not.toHaveProperty("genuineUserQueryText");
  });
});

describe("LocalRuntimeTurnExecutor live control", () => {
  it("creates one isolated tool safety guard for the admitted Turn", async () => {
    const guard = {
      beforeToolCall: vi.fn(() => undefined),
      afterToolCall: vi.fn(() => undefined),
    };
    const createTurnToolSafetyGuard = vi.fn(() => guard);
    const executorOptions = {
      ...options(async (runInput) => {
        const beforeToolCall = runInput.hooks?.beforeToolCallHook?.[0];
        const afterToolCall = runInput.hooks?.afterToolCallHook?.[0];
        if (!beforeToolCall || !afterToolCall) {
          throw new Error("expected controlled tool hooks");
        }
        await beforeToolCall(
          {
            toolCall: { id: "tool-call-a", name: "read", type: "toolCall" },
            args: { path: "README.md" },
          } as never,
          runInput.signal,
        );
        await afterToolCall(afterToolContext() as never, runInput.signal);
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      createTurnToolSafetyGuard,
    };

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(executionInput()),
    ).resolves.toEqual({ status: "completed" });

    expect(createTurnToolSafetyGuard).toHaveBeenCalledOnce();
    expect(guard.beforeToolCall).toHaveBeenCalledOnce();
    expect(guard.afterToolCall).toHaveBeenCalledOnce();
  });

  it("runs the injected Plan policy before user hooks and permission", async () => {
    const order: string[] = [];
    const executorOptions = {
      ...options(async (runInput) => {
        const context = {
          toolCall: { id: "tool-call-a", name: "read", type: "toolCall" },
          args: { path: "README.md" },
        };
        for (const hook of runInput.hooks?.beforeToolCallHook ?? []) {
          await hook(context as never, runInput.signal);
        }
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      toolPolicyGuard: {
        beforeToolCall: vi.fn(async () => {
          order.push("plan");
          return undefined;
        }),
      },
    };
    vi.mocked(executorOptions.executionPreparation.prepare).mockImplementation(
      async ({ execution }) => ({
        userMessage: {},
        caller: "chat",
        reminderBlocks: [],
        loadBackgroundReminder: vi.fn(async () => ({
          tasks: [],
          undeliveredTotal: 0,
          terminalTotal: 0,
        })),
        confirmBackgroundTaskReads: vi.fn(async () => undefined),
        toolResolution: {
          disableBuiltinToolFallback: true,
          permissionGuard: vi.fn(async () => {
            order.push("permission");
            return undefined;
          }),
          context: {
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            permissionScope: "workspace",
          },
        },
      }),
    );
    const base = executionInput();
    const userHook = vi.fn(async () => {
      order.push("user-hook");
      return undefined;
    });

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(
        executionInput({
          assembly: {
            ...base.assembly,
            hooks: { ...base.assembly.hooks, beforeToolCallHook: [userHook] },
          },
        }),
      ),
    ).resolves.toEqual({ status: "completed" });
    expect(order).toEqual(["plan", "user-hook", "permission"]);
  });
});

describe("LocalRuntimeTurnExecutor video generation tool execution", () => {
  it.each([
    {
      name: "owner direct submit",
      mode: "owner",
      toolName: "submit_video_generation",
      args: {},
    },
    {
      name: "owner nested query",
      mode: "owner",
      toolName: "mcp_invoke",
      args: { tool_name: "query_video_generation", arguments: {} },
    },
    {
      name: "owner namespaced Plugin submit",
      mode: "owner",
      toolName: "mcp__video__submit_video_generation",
      args: {},
      blocked: false,
    },
    {
      name: "owner namespaced legacy Matrix submit alias",
      mode: "owner",
      toolName: "mcp__matrix__matrix_submit_video_generation",
      args: {},
      blocked: false,
    },
    {
      name: "owner nested legacy Matrix query alias",
      mode: "owner",
      toolName: "mcp_invoke",
      args: { tool_name: "mcp_matrix_query_video_generation", arguments: {} },
      blocked: false,
    },
    {
      name: "owner repeated legacy Matrix submit alias",
      mode: "owner",
      toolName: "mcp_matrix_matrix_submit_video_generation",
      args: {},
      blocked: false,
    },
    {
      name: "foreground child direct query",
      mode: "foreground",
      toolName: "query_video_generation",
      args: {},
      blocked: false,
    },
    {
      name: "team child nested submit",
      mode: "team",
      toolName: "mcp_invoke",
      args: { tool_name: "submit_video_generation", arguments: {} },
      blocked: false,
    },
    {
      name: "background child direct submit",
      mode: "background",
      toolName: "submit_video_generation",
      args: {},
      blocked: false,
    },
    {
      name: "background child nested query",
      mode: "background",
      toolName: "mcp_invoke",
      args: { tool_name: "query_video_generation", arguments: {} },
      blocked: false,
    },
    {
      name: "owner direct restored batch text submit",
      mode: "owner",
      toolName: "batch_text_to_video",
      args: {},
      blocked: false,
    },
    {
      name: "background child direct restored gen videos submit",
      mode: "background",
      toolName: "mcp_matrix_gen_videos",
      args: {},
      blocked: false,
    },
    {
      name: "background child direct restored batch image submit",
      mode: "background",
      toolName: "mcp__matrix__matrix_batch_image_to_video",
      args: {},
      blocked: false,
    },
    {
      name: "background child nested restored batch text submit",
      mode: "background",
      toolName: "mcp_invoke",
      args: { tool_name: "mcp_matrix_batch_text_to_video", arguments: {} },
      blocked: false,
    },
    {
      name: "forged background profile and session from chat ingress",
      mode: "forged-background-chat",
      toolName: "submit_video_generation",
      args: {},
      blocked: false,
    },
    {
      name: "root with a forged background profile",
      mode: "profile-only-background",
      toolName: "submit_video_generation",
      args: {},
      blocked: false,
    },
    {
      name: "background-purpose child without the frozen profile fact",
      mode: "session-only-background",
      toolName: "mcp_invoke",
      args: { tool_name: "query_video_generation", arguments: {} },
      blocked: false,
    },
    {
      name: "conversation child with forged background profile, provenance, and purpose",
      mode: "wrong-session-kind-background",
      toolName: "submit_video_generation",
      args: {},
      blocked: false,
    },
  ] as const)(
    "does not add a video-specific execution gate for $name",
    async ({ mode, toolName, args }) => {
      const order: string[] = [];
      let decision: unknown;
      const permissionGuard = vi.fn(async () => {
        order.push("permission");
        return undefined;
      });
      const extensionHook = vi.fn(async () => {
        order.push("extension");
        return undefined;
      });
      const toolPolicyGuard = vi.fn(async () => {
        order.push("plan");
        return undefined;
      });
      const executorOptions = {
        ...options(async (runInput) => {
          for (const hook of runInput.hooks?.beforeToolCallHook ?? []) {
            decision = await hook(
              {
                toolCall: {
                  id: "video-call",
                  name: toolName,
                  type: "toolCall",
                },
                args,
              } as never,
              runInput.signal,
            );
            if ((decision as { block?: boolean } | undefined)?.block) break;
          }
          await runInput.eventWriter.pushRuntime(
            terminalEvent(RuntimeEventStatus.COMPLETED),
          );
        }),
        toolPolicyGuard: { beforeToolCall: toolPolicyGuard },
      };
      vi.mocked(
        executorOptions.executionPreparation.prepare,
      ).mockImplementation(async ({ execution }) => ({
        userMessage: {},
        caller: "chat",
        reminderBlocks: [],
        loadBackgroundReminder: vi.fn(async () => ({
          tasks: [],
          undeliveredTotal: 0,
          terminalTotal: 0,
        })),
        confirmBackgroundTaskReads: vi.fn(async () => undefined),
        toolResolution: {
          disableBuiltinToolFallback: true,
          permissionGuard,
          context: {
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            permissionScope: "workspace",
          },
        },
      }));
      const base = videoGateExecutionInput(mode);
      const input = executionInput({
        ...base,
        assembly: {
          ...base.assembly,
          hooks: {
            ...base.assembly.hooks,
            beforeToolCallHook: [extensionHook],
          },
        },
      });

      await expect(
        new LocalRuntimeTurnExecutor(executorOptions).execute(input),
      ).resolves.toEqual({
        status: "completed",
      });
      expect(decision).toBeUndefined();
      expect(order).toEqual(["plan", "extension", "permission"]);
      expect(toolPolicyGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          genuineUserQueryText: input.request.genuineUserQueryText,
        }),
      );
    },
  );
});

describe("LocalRuntimeTurnExecutor live message control", () => {
  it("stamps an active steer after preparation and projects it through AgentCore", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const query = "review the attached report";
    const preparedText = `<system-reminder>attachment facts</system-reminder>\n\n${query}`;
    const prepareSteering = vi.fn(async () => ({
      userMessage: { text: preparedText },
      genuineUserQueryText: query,
    }));
    const executorOptions = options(async (runInput) => {
      captured = runInput;
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    vi.mocked(executorOptions.executionPreparation.prepare).mockImplementation(
      async ({ execution }) => ({
        userMessage: {},
        caller: "chat",
        reminderBlocks: [],
        loadBackgroundReminder: vi.fn(async () => ({
          tasks: [],
          undeliveredTotal: 0,
          terminalTotal: 0,
        })),
        confirmBackgroundTaskReads: vi.fn(async () => undefined),
        prepareSteering,
        toolResolution: {
          disableBuiltinToolFallback: true,
          permissionGuard: vi.fn(async () => undefined),
          context: {
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            permissionScope: "workspace",
          },
        },
      }),
    );
    const base = executionInput();
    const steering = {
      producerId: "communication",
      idempotencyKey: "prepared-steer",
      message: { text: query },
      genuineUserQueryText: query,
      provenance: {
        source: "communication",
        routingFingerprint: "communication:prepared-steer",
      },
    } as const;

    await new LocalRuntimeTurnExecutor(executorOptions).execute(
      executionInput({
        control: {
          ...base.control,
          drainSteering: vi.fn(() => [steering]),
        },
      }),
    );

    await expect(captured?.getSteeringMessages?.()).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: preparedText }],
        canonicalTextRange: {
          startOffset: preparedText.length - query.length,
          endOffset: preparedText.length,
        },
      }),
    ]);
  });
});

describe("LocalRuntimeTurnExecutor exit-boundary steering", () => {
  const userSteer = (producerId: string, key: string, text: string) =>
    ({
      producerId,
      idempotencyKey: key,
      message: { text },
      genuineUserQueryText: text,
      provenance: { source: "api", routingFingerprint: `api:${key}` },
    }) as const;
  const machineSteer = (key: string, text: string) =>
    ({
      producerId: "communication",
      idempotencyKey: key,
      message: { text },
      genuineUserQueryText: text,
      provenance: {
        source: "communication",
        routingFingerprint: `communication:${key}`,
      },
    }) as const;

  async function runWithSteering(buffer: readonly unknown[]) {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const onSteeringConsumed = vi.fn(async () => undefined);
    const restoreSteering = vi.fn();
    const ackSteering = vi.fn();
    const executorOptions = {
      ...options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      onSteeringConsumed,
    };
    const base = executionInput();
    await new LocalRuntimeTurnExecutor(executorOptions).execute(
      executionInput({
        control: {
          ...base.control,
          drainSteering: vi.fn(() => [...buffer] as never),
          restoreSteering,
          ackSteering,
        },
      }),
    );
    return { captured, onSteeringConsumed, restoreSteering, ackSteering };
  }

  it("leaves user steering unconsumed at the exit boundary while non-user producers inject", async () => {
    const first = userSteer("composer-steer", "u1", "first user steer");
    const middle = machineSteer("c1", "machine delivery");
    const last = userSteer("queue-immediate-send", "u2", "second user steer");
    const { captured, onSteeringConsumed, restoreSteering, ackSteering } =
      await runWithSteering([first, middle, last]);

    await expect(
      captured?.getSteeringMessages?.({ boundary: "exit" }),
    ).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "machine delivery" }],
      }),
    ]);
    expect(restoreSteering).toHaveBeenCalledWith([first, last]);
    expect(ackSteering).toHaveBeenCalledTimes(1);
    expect(ackSteering).toHaveBeenCalledWith([middle]);
    expect(onSteeringConsumed).toHaveBeenCalledTimes(1);
    expect(onSteeringConsumed).toHaveBeenCalledWith(
      expect.objectContaining({ message: middle }),
    );
  });

  it("returns nothing at the exit boundary when only user steering is pending", async () => {
    const first = userSteer("paused-queue-composer", "u1", "first user steer");
    const last = userSteer("composer-steer", "u2", "second user steer");
    const { captured, onSteeringConsumed, restoreSteering, ackSteering } =
      await runWithSteering([first, last]);

    await expect(
      captured?.getSteeringMessages?.({ boundary: "exit" }),
    ).resolves.toEqual([]);
    expect(restoreSteering).toHaveBeenCalledWith([first, last]);
    expect(ackSteering).not.toHaveBeenCalled();
    expect(onSteeringConsumed).not.toHaveBeenCalled();
  });

  it("keeps draining user steering at mid-turn boundaries", async () => {
    const first = userSteer("composer-steer", "u1", "first user steer");
    const last = machineSteer("c1", "machine delivery");
    const { captured, onSteeringConsumed, restoreSteering } =
      await runWithSteering([first, last]);

    await expect(
      captured?.getSteeringMessages?.({ boundary: "mid-turn" }),
    ).resolves.toEqual([
      expect.objectContaining({
        content: [{ type: "text", text: "first user steer" }],
      }),
      expect.objectContaining({
        content: [{ type: "text", text: "machine delivery" }],
      }),
    ]);
    expect(restoreSteering).not.toHaveBeenCalled();
    expect(onSteeringConsumed).toHaveBeenCalledTimes(2);
  });
});

describe("LocalRuntimeTurnExecutor live message control", () => {
  it("maps live control, guards runtime tools, and acknowledges tool-result tails after history commit", async () => {
    type ControlAwareRunnerInput =
      LocalRuntimeTurnRunnerInput<LocalToolContext> & {
        readonly getSteeringMessages?: () =>
          | readonly unknown[]
          | Promise<readonly unknown[]>;
        readonly tryBeginClose?: (context: {
          readonly lastAssistantMessage?: string;
        }) => boolean | Promise<boolean>;
      };
    let captured: ControlAwareRunnerInput | undefined;
    let afterToolDecision: unknown;
    const permissionGuard = vi.fn(async () => undefined);
    const onSteeringConsumed = vi.fn(async () => undefined);
    const registerCanonicalUserMessageIds = vi.fn();
    const executorOptions = {
      ...options(async (runInput) => {
        captured = runInput;
        const toolContext = {
          toolCall: {
            id: "tool-call-a",
            name: "runtime-tool",
            type: "toolCall",
          },
          args: {},
        };
        for (const hook of runInput.hooks?.beforeToolCallHook ?? []) {
          await hook(toolContext as never, runInput.signal);
        }
        afterToolDecision = await runInput.hooks?.afterToolCallHook?.[0]?.(
          {
            ...toolContext,
            result: {
              content: [{ type: "text", text: "tool output" }],
              details: {},
            },
            isError: false,
          } as never,
          runInput.signal,
        );
        await runInput.hooks?.onHistoryChangedHook?.[0]?.({
          sessionId: "session-1",
          turnId: "turn-1",
          reason: "messageDelta",
          messages: [
            {
              role: "toolResult",
              toolCallId: "tool-call-a",
              toolName: "runtime-tool",
              content: [{ type: "text", text: "tool output" }],
              isError: false,
              timestamp: 2,
            },
          ],
        });
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      onSteeringConsumed,
    };
    vi.mocked(executorOptions.executionPreparation.prepare).mockImplementation(
      async ({ execution }) => ({
        userMessage: {},
        caller: "chat",
        reminderBlocks: [],
        loadBackgroundReminder: vi.fn(async () => ({
          tasks: [],
          undeliveredTotal: 0,
          terminalTotal: 0,
        })),
        confirmBackgroundTaskReads: vi.fn(async () => undefined),
        toolResolution: {
          disableBuiltinToolFallback: true,
          permissionGuard,
          context: {
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            permissionScope: "workspace",
          },
        },
      }),
    );
    const drainSteering = vi.fn(() => [
      {
        producerId: "test",
        idempotencyKey: "steering-1",
        userMessageId: "msg-user-v1-steering-1" as const,
        message: { text: "steer now" },
        genuineUserQueryText: "",
        provenance: {
          source: "communication",
          routingFingerprint: "communication:steering-1",
        },
      },
    ]);
    const closeAndClaimToolResultTail = vi.fn(() => [
      {
        producerId: "test",
        idempotencyKey: "tail-1",
        message: { text: "tail content" },
        genuineUserQueryText: "",
        provenance: {
          source: "background-task",
          routingFingerprint: "background-task:tail-1",
        },
      },
    ]);
    const ackToolResultTail = vi.fn();
    const ackSteering = vi.fn();
    const restoreSteering = vi.fn();
    const openToolResultTail = vi.fn(() => true);
    const tryBeginClose = vi.fn(
      (): AgentHostCloseResult => ({ closed: false, reason: "steer-pending" }),
    );
    const input = executionInput({
      assembly: {
        ...assembly(),
        tools: [
          {
            def: {
              name: "runtime-tool",
              description: "runtime tool",
              schema: { type: "object", properties: {} },
            },
            impl: { execute: vi.fn() },
          } as never,
        ],
      },
      control: {
        ...executionInput().control,
        openToolResultTail,
        closeAndClaimToolResultTail,
        ackToolResultTail,
        drainSteering,
        ackSteering,
        restoreSteering,
        tryBeginClose,
      },
      registerCanonicalUserMessageIds,
    });
    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(input),
    ).resolves.toEqual({
      status: "completed",
    });

    expect(permissionGuard).toHaveBeenCalledTimes(1);
    expect(captured?.systemPrompt).toBe("extension system\n\nbase system");
    expect(openToolResultTail).toHaveBeenCalledTimes(1);
    expect(closeAndClaimToolResultTail).toHaveBeenCalledWith("tool-call-a");
    expect(ackToolResultTail).toHaveBeenCalledWith("tool-call-a");
    expect(afterToolDecision).toMatchObject({
      content: [
        { type: "text", text: "tool output" },
        { type: "text", text: "tail content" },
      ],
    });
    await expect(captured?.getSteeringMessages?.()).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "steer now" }],
      }),
    ]);
    expect(captured).not.toHaveProperty("getFollowUpMessages");
    expect(captured?.tryBeginClose?.({})).toBe(false);
    expect(drainSteering).toHaveBeenCalledTimes(1);
    expect(onSteeringConsumed).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-1",
      message: expect.objectContaining({ idempotencyKey: "steering-1" }),
    });
    expect(ackSteering).toHaveBeenCalledWith([
      expect.objectContaining({ idempotencyKey: "steering-1" }),
    ]);
    expect(registerCanonicalUserMessageIds).toHaveBeenCalledWith([
      "msg-user-v1-steering-1",
    ]);
    expect(restoreSteering).not.toHaveBeenCalled();
    expect(tryBeginClose).toHaveBeenCalledTimes(1);
  });
});

describe("LocalRuntimeTurnExecutor live message recovery", () => {
  it("marks all admitted user members as one batch without marking machine input (TS-45/58)", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const members = ["A", "B", "machine"].map((text) => ({
      producerId: text === "machine" ? "communication" : "composer-steer",
      idempotencyKey: text,
      message: { text },
      genuineUserQueryText: text,
      provenance: { source: "api" as const, routingFingerprint: `api:${text}` },
    }));
    const opts = options(async (runInput) => {
      captured = runInput;
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    const claim = { ...members[0]!, batchMembers: members.slice(0, 2) };
    const ackSteering = vi.fn();
    await new LocalRuntimeTurnExecutor(opts).execute(
      executionInput({
        control: {
          ...executionInput().control,
          drainSteering: () => [claim, members[2]!],
          ackSteering,
        },
      }),
    );
    const result = await captured?.getSteeringMessages?.({
      boundary: "mid-turn",
    });
    expect(result).toHaveLength(3);
    expect(ackSteering).toHaveBeenCalledWith([claim, members[2]]);
    const first = result?.[0] as {
      hostMetadata?: { immediateSendBatchId?: string };
    };
    expect(first.hostMetadata?.immediateSendBatchId).toEqual(
      expect.any(String),
    );
    expect(result?.[1]).toHaveProperty(
      "hostMetadata.immediateSendBatchId",
      first.hostMetadata?.immediateSendBatchId,
    );
    expect(result?.[2]).not.toHaveProperty("hostMetadata.immediateSendBatchId");
  });

  it("restores all unexecuted batch members after a partial display failure (TS-55)", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const members = ["A", "B"].map((text) => ({
      producerId: "composer-steer",
      idempotencyKey: text,
      userMessageId: `msg-user-v1-${text}` as never,
      message: { text },
      genuineUserQueryText: text,
      provenance: { source: "api" as const, routingFingerprint: `api:${text}` },
    }));
    const ackSteering = vi.fn();
    const restoreSteering = vi.fn();
    const consumed = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("B failed"));
    const opts = {
      ...options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      onSteeringConsumed: consumed,
    };
    await new LocalRuntimeTurnExecutor(opts).execute(
      executionInput({
        control: {
          ...executionInput().control,
          drainSteering: () => members,
          ackSteering,
          restoreSteering,
        },
      }),
    );
    await expect(
      captured?.getSteeringMessages?.({ boundary: "mid-turn" }),
    ).rejects.toThrow("B failed");
    expect(ackSteering).not.toHaveBeenCalled();
    expect(restoreSteering).toHaveBeenCalledWith(members);
  });

  it("restores a claimed steer when its required consumption projection fails", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const executorOptions = {
      ...options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      onSteeringConsumed: vi.fn(async () => {
        throw new Error("message commit failed");
      }),
    };
    const steering = {
      producerId: "communication",
      idempotencyKey: "message-1",
      message: { text: "persist me" },
      genuineUserQueryText: "",
      provenance: {
        source: "communication",
        routingFingerprint: "communication:message-1",
      },
    } as const;
    const ackSteering = vi.fn();
    const restoreSteering = vi.fn();
    const input = executionInput({
      control: {
        ...executionInput().control,
        drainSteering: vi.fn(() => [steering]),
        ackSteering,
        restoreSteering,
      },
    });

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(input),
    ).resolves.toEqual({
      status: "completed",
    });
    await expect(captured?.getSteeringMessages?.()).rejects.toThrow(
      "message commit failed",
    );

    expect(restoreSteering).toHaveBeenCalledWith([steering]);
    expect(ackSteering).not.toHaveBeenCalled();
  });
});

describe("LocalRuntimeTurnExecutor Plugin lifecycle hooks", () => {
  it("restores every unexecuted member when UserPromptSubmit stops the turn", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const stopped = {
      producerId: "test",
      idempotencyKey: "stopped",
      message: { text: "stop this steer" },
      genuineUserQueryText: "stop this steer",
      provenance: {
        source: "communication",
        routingFingerprint: "communication:stopped",
      },
    } as const;
    const later = {
      producerId: "test",
      idempotencyKey: "later",
      message: { text: "keep this steer too" },
      genuineUserQueryText: "keep this steer too",
      provenance: {
        source: "communication",
        routingFingerprint: "communication:later",
      },
    } as const;
    const accepted = {
      ...stopped,
      producerId: "composer-steer",
      idempotencyKey: "accepted",
      message: { text: "accepted first" },
    };
    const restoreSteering = vi.fn();
    const ackSteering = vi.fn();
    const onSteeringConsumed = vi.fn(async () => undefined);
    const runtimeEvents: RuntimeEvent[] = [];
    const runEvent = vi
      .spyOn(localPluginHookCoordinator, "runEvent")
      .mockResolvedValueOnce({
        decision: { decision: "allow" },
        diagnostics: [],
      })
      .mockResolvedValue({
        decision: {
          decision: "allow",
          continue: false,
          stopReason: "Hook stopped queued input.",
        },
        diagnostics: [],
      });
    const executor = new LocalRuntimeTurnExecutor({
      ...options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      onSteeringConsumed,
    });
    const base = executionInput();

    await executor.execute(
      executionInput({
        pluginHooks: [
          {
            kind: "command",
            sourceFormat: "MINIMAX",
            pluginName: "stop-steering-plugin",
            pluginRoot: "/tmp/stop-steering-plugin",
            sourcePath: "hooks/hooks.json",
            event: "UserPromptSubmit",
            command: "true",
            timeoutMs: 100,
            declarationOrder: 0,
          },
        ],
        onRuntimeEvent: async (event) => {
          runtimeEvents.push(event);
        },
        control: {
          ...base.control,
          drainSteering: vi.fn(() => [accepted, stopped, later]),
          restoreSteering,
          ackSteering,
        },
      }),
    );

    await expect(captured?.getSteeringMessages?.()).resolves.toEqual([]);
    expect(captured?.shouldStopAfterSteering?.()).toBe(true);
    expect(restoreSteering).toHaveBeenCalledWith([accepted, stopped, later]);
    expect(ackSteering).not.toHaveBeenCalled();
    expect(onSteeringConsumed).not.toHaveBeenCalled();
    expect(JSON.stringify(runtimeEvents)).toContain(
      "Hook stopped queued input.",
    );
    runEvent.mockRestore();
  });
});

describe("LocalRuntimeTurnExecutor Plugin lifecycle closure hooks", () => {
  it("applies UserPromptSubmit and Stop Hook decisions to live steering and turn closure", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    let promptAttempt = 0;
    const runEvent = vi
      .spyOn(localPluginHookCoordinator, "runEvent")
      .mockImplementation(async (_handlers, event) => {
        if (event.event !== "UserPromptSubmit") {
          return { decision: { decision: "allow" }, diagnostics: [] };
        }
        promptAttempt += 1;
        return promptAttempt === 1
          ? { decision: { decision: "deny" }, diagnostics: [] }
          : {
              decision: {
                decision: "allow",
                additionalContext: "steering context",
              },
              diagnostics: [],
            };
      });
    const finishTurn = vi
      .spyOn(localPluginHookCoordinator, "finishTurn")
      .mockResolvedValueOnce({
        decision: {
          decision: "allow",
          continuePrompt: "continue after Stop Hook",
        },
        diagnostics: [
          {
            code: "HOOK_TIMEOUT",
            pluginName: "lifecycle-plugin",
            event: "Stop",
            sourcePath: "hooks/hooks.json",
            declarationOrder: 0,
          },
        ],
      })
      .mockResolvedValueOnce({
        decision: { decision: "allow" },
        diagnostics: [],
      });
    const completeTurn = vi.spyOn(localPluginHookCoordinator, "completeTurn");
    const executorOptions = options(async (runInput) => {
      captured = runInput;
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    const denied = {
      producerId: "test",
      idempotencyKey: "denied",
      userMessageId: "msg-user-v1-denied" as const,
      message: { text: "deny this steer" },
      genuineUserQueryText: "deny this steer",
      provenance: {
        source: "communication",
        routingFingerprint: "communication:denied",
      },
    } as const;
    const accepted = {
      producerId: "test",
      idempotencyKey: "accepted",
      userMessageId: "msg-user-v1-accepted" as const,
      message: { text: "accept this steer" },
      genuineUserQueryText: "accept this steer",
      provenance: {
        source: "communication",
        routingFingerprint: "communication:accepted",
      },
    } as const;
    const drainSteering = vi
      .fn()
      .mockReturnValueOnce([denied, accepted])
      .mockReturnValue([]);
    const registerCanonicalUserMessageIds = vi.fn();
    const runtimeEvents: RuntimeEvent[] = [];
    const base = executionInput();

    await new LocalRuntimeTurnExecutor(executorOptions).execute(
      executionInput({
        pluginHooks: [
          {
            kind: "command",
            sourceFormat: "MINIMAX",
            pluginName: "lifecycle-plugin",
            pluginRoot: "/tmp/lifecycle-plugin",
            sourcePath: "hooks/hooks.json",
            event: "UserPromptSubmit",
            command: "true",
            timeoutMs: 100,
            declarationOrder: 0,
          },
        ],
        registerCanonicalUserMessageIds,
        onRuntimeEvent: async (event) => {
          runtimeEvents.push(event);
        },
        control: { ...base.control, drainSteering },
      }),
    );

    const messages = await captured?.getSteeringMessages?.();
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages?.[0])).toContain("Plugin Hook rejected");
    expect(JSON.stringify(messages?.[1])).toContain(
      "<plugin-hook-context>\\nsteering context\\n</plugin-hook-context>",
    );
    expect(registerCanonicalUserMessageIds).toHaveBeenCalledWith([
      "msg-user-v1-accepted",
    ]);

    await expect(captured?.tryBeginClose?.({})).resolves.toBe(false);
    await expect(captured?.getSteeringMessages?.()).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "continue after Stop Hook" }],
      }),
    ]);
    expect(await captured?.tryBeginClose?.({})).toBe(true);
    expect(finishTurn).toHaveBeenCalledTimes(2);
    expect(finishTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ stopHookActive: true }),
    );
    expect(completeTurn).toHaveBeenCalledWith("session-1");
    expect(JSON.stringify(runtimeEvents)).toContain("HOOK_TIMEOUT");
    runEvent.mockRestore();
    finishTurn.mockRestore();
    completeTurn.mockRestore();
  });

  it("forces turn closure after at most eight consecutive Stop Hook continuations", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const finishTurn = vi
      .spyOn(localPluginHookCoordinator, "finishTurn")
      .mockResolvedValue({
        decision: { decision: "allow", continuePrompt: "continue again" },
        diagnostics: [],
      });
    const completeTurn = vi.spyOn(localPluginHookCoordinator, "completeTurn");
    const executor = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );

    await executor.execute(
      executionInput({
        pluginHooks: [
          {
            kind: "command",
            sourceFormat: "CLAUDE",
            pluginName: "stop-plugin",
            pluginRoot: "/tmp/stop-plugin",
            sourcePath: "hooks/hooks.json",
            event: "Stop",
            command: "true",
            timeoutMs: 100,
            declarationOrder: 0,
          },
        ],
      }),
    );

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(captured?.tryBeginClose?.({})).resolves.toBe(false);
      await expect(captured?.getSteeringMessages?.()).resolves.toHaveLength(1);
    }
    await expect(captured?.tryBeginClose?.({})).resolves.toBe(true);
    await expect(captured?.getSteeringMessages?.()).resolves.toEqual([]);
    expect(finishTurn).toHaveBeenCalledTimes(9);
    expect(completeTurn).toHaveBeenCalledWith("session-1");
    finishTurn.mockRestore();
    completeTurn.mockRestore();
  });
});

describe("LocalRuntimeTurnExecutor after-tool hooks", () => {
  it("fails closed when a Compatible PreToolUse Hook requests unsupported deferred execution", async () => {
    const runEvent = vi
      .spyOn(localPluginHookCoordinator, "runEvent")
      .mockResolvedValue({
        decision: {
          decision: "defer",
          toolPermissionDecision: "defer",
          defer: true,
        },
        diagnostics: [],
      });
    let beforeToolDecision: unknown;
    const executor = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        beforeToolDecision = await runInput.hooks?.beforeToolCallHook?.[0]?.(
          {
            toolCall: {
              id: "deferred",
              name: "runtime-tool",
              type: "toolCall",
            },
            args: { input: "defer me" },
          } as never,
          runInput.signal,
        );
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );

    await executor.execute(
      executionInput({
        pluginHooks: [
          {
            kind: "command",
            sourceFormat: "CLAUDE",
            pluginName: "defer-plugin",
            pluginRoot: "/tmp/defer-plugin",
            sourcePath: "hooks/hooks.json",
            event: "PreToolUse",
            command: "true",
            timeoutMs: 100,
            declarationOrder: 0,
          },
        ],
      }),
    );

    expect(beforeToolDecision).toEqual({
      block: true,
      reason:
        "PreToolUse Plugin Hook requested deferred execution, which Desktop does not support.",
    });
    runEvent.mockRestore();
  });
});

describe("LocalRuntimeTurnExecutor Plugin tool-boundary decisions", () => {
  it("applies Plugin Hook input, approval, denial, and result decisions at the tool boundary", async () => {
    let preToolAttempt = 0;
    const runEvent = vi
      .spyOn(localPluginHookCoordinator, "runEvent")
      .mockImplementation(async (_handlers, event) => {
        if (event.event === "PreToolUse") {
          preToolAttempt += 1;
          if (preToolAttempt === 1) {
            return {
              decision: {
                decision: "allow",
                toolPermissionDecision: "allow",
                updatedInput: { unexpected: true },
              },
              diagnostics: [],
            };
          }
          if (preToolAttempt === 2) {
            return {
              decision: {
                decision: "ask",
                toolPermissionDecision: "ask",
                reason: "confirm rewritten input",
                updatedInput: { input: "rewritten input" },
                additionalContext: "pre-tool context",
              },
              diagnostics: [],
            };
          }
          return {
            decision: { decision: "deny", toolPermissionDecision: "deny" },
            diagnostics: [],
          };
        }
        return {
          decision: {
            decision: "allow",
            updatedResult: { status: "rewritten" },
            additionalContext: "post-tool context",
          },
          diagnostics: [],
        };
      });
    const approvals = new Map<
      string,
      { readonly behavior: "allow" | "ask"; readonly reason?: string }
    >();
    const permissionGuard = vi.fn(async (context) => {
      if (context.toolCall.id === "tool-call-a") {
        expect(approvals.get("tool-call-a")).toEqual({
          behavior: "ask",
          reason: "confirm rewritten input",
        });
      }
      return undefined;
    });
    const openToolResultTail = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    let afterToolDecision: unknown;
    const executorOptions = options(async (runInput) => {
      const beforeHooks = runInput.hooks?.beforeToolCallHook ?? [];
      const invalidContext = {
        toolCall: { id: "invalid", name: "runtime-tool", type: "toolCall" },
        args: { input: "original invalid attempt" },
      };
      await beforeHooks[0]?.(invalidContext as never, runInput.signal);
      expect(invalidContext.args).toEqual({
        input: "original invalid attempt",
      });

      const approvedContext = {
        toolCall: { id: "tool-call-a", name: "runtime-tool", type: "toolCall" },
        args: { input: "original approved attempt" },
      };
      for (const hook of beforeHooks) {
        expect(
          await hook(approvedContext as never, runInput.signal),
        ).toBeUndefined();
      }
      expect(approvedContext.args).toEqual({ input: "rewritten input" });
      expect(approvals.has("tool-call-a")).toBe(false);

      const deniedContext = {
        toolCall: { id: "denied", name: "runtime-tool", type: "toolCall" },
        args: { input: "blocked" },
      };
      await expect(
        beforeHooks[0]?.(deniedContext as never, runInput.signal),
      ).resolves.toEqual({
        block: true,
        reason: "Tool blocked by Plugin Hook.",
      });
      expect(
        await beforeHooks.at(-1)?.(deniedContext as never, runInput.signal),
      ).toEqual({
        block: true,
        reason: "Tool-result delivery seam is closed.",
      });

      afterToolDecision = await runInput.hooks?.afterToolCallHook?.[0]?.(
        {
          ...afterToolContext(),
          args: approvedContext.args,
        } as never,
        runInput.signal,
      );
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    vi.mocked(executorOptions.executionPreparation.prepare).mockImplementation(
      async ({ execution }) => ({
        userMessage: {},
        caller: "chat",
        reminderBlocks: [],
        loadBackgroundReminder: vi.fn(async () => ({
          tasks: [],
          undeliveredTotal: 0,
          terminalTotal: 0,
        })),
        toolResolution: {
          disableBuiltinToolFallback: true,
          permissionGuard,
          context: {
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            permissionScope: "workspace",
          },
        },
      }),
    );
    const base = executionInput();
    const input = executionInput({
      pluginHooks: [
        {
          kind: "command",
          sourceFormat: "MINIMAX",
          pluginName: "tool-plugin",
          pluginRoot: "/tmp/tool-plugin",
          sourcePath: "hooks/hooks.json",
          event: "PreToolUse",
          command: "true",
          timeoutMs: 100,
          declarationOrder: 0,
        },
        {
          kind: "command",
          sourceFormat: "MINIMAX",
          pluginName: "tool-plugin",
          pluginRoot: "/tmp/tool-plugin",
          sourcePath: "hooks/hooks.json",
          event: "PostToolUse",
          command: "true",
          timeoutMs: 100,
          declarationOrder: 1,
        },
      ],
      pluginApprovalRequests: approvals,
      assembly: {
        ...base.assembly,
        tools: [
          {
            def: {
              name: "runtime-tool",
              description: "runtime tool",
              schema: Type.Object(
                { input: Type.String() },
                { additionalProperties: false },
              ),
            },
            impl: { execute: vi.fn() },
          } as never,
        ],
      },
      control: { ...base.control, openToolResultTail },
    });

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(input),
    ).resolves.toEqual({
      status: "completed",
    });
    expect(afterToolDecision).toEqual({
      content: [
        { type: "text", text: '{"status":"rewritten"}' },
        {
          type: "text",
          text: "<plugin-hook-context>\npre-tool context\npost-tool context\n</plugin-hook-context>",
        },
      ],
    });
    runEvent.mockRestore();
  });
});

describe("LocalRuntimeTurnExecutor Codex after-tool hooks", () => {
  it("turns Codex PostToolUse blocking output into model feedback without stopping the agent", async () => {
    let hookInput:
      | Parameters<typeof localPluginHookCoordinator.runEvent>[1]
      | undefined;
    const runEvent = vi
      .spyOn(localPluginHookCoordinator, "runEvent")
      .mockImplementation(async (_handlers, input) => {
        hookInput = input;
        return {
          decision: {
            decision: "allow",
            postToolFeedback: "explain and retry safely",
          },
          diagnostics: [],
        };
      });
    let afterToolDecision: unknown;
    const base = executionInput();
    const executor = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        afterToolDecision = await runInput.hooks?.afterToolCallHook?.[0]?.(
          {
            ...afterToolContext(),
            toolCall: {
              ...afterToolContext().toolCall,
              name: "mcp__notes__read",
            },
          } as never,
          runInput.signal,
        );
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );

    await executor.execute(
      executionInput({
        pluginMcpToolOwners: new Map([["mcp__notes__read", "mcp-owner"]]),
        assembly: {
          ...base.assembly,
          hooks: {
            ...base.assembly.hooks,
            afterToolCallHook: [
              vi.fn(async () => ({
                content: [
                  { type: "text" as const, text: "normalized tool output" },
                ],
                isError: false,
              })),
            ],
          },
        },
        pluginHooks: [
          {
            kind: "command",
            sourceFormat: "CODEX",
            pluginName: "codex-hooks",
            pluginRoot: "/tmp/codex-hooks",
            sourcePath: ".codex/hooks.json",
            event: "PostToolUse",
            command: "true",
            timeoutMs: 100,
            declarationOrder: 0,
          },
        ],
      }),
    );

    expect(hookInput).toMatchObject({
      event: "PostToolUse",
      promptId: "turn-1",
      toolProvenance: { kind: "plugin_mcp", pluginName: "mcp-owner" },
    });
    expect(afterToolDecision).toEqual({
      content: [
        {
          type: "text",
          text: "<plugin-hook-feedback>\nexplain and retry safely\n</plugin-hook-feedback>",
        },
      ],
      isError: true,
    });
    expect(afterToolDecision).not.toHaveProperty("terminateAgent");
    runEvent.mockRestore();
  });

  it("passes the lossless Plugin MCP result as Compatible PostToolUse tool_response", async () => {
    let hookInput:
      | Parameters<typeof localPluginHookCoordinator.runEvent>[1]
      | undefined;
    const runEvent = vi
      .spyOn(localPluginHookCoordinator, "runEvent")
      .mockImplementation(async (_handlers, input) => {
        hookInput = input;
        return { decision: { decision: "allow" }, diagnostics: [] };
      });
    const rawMcpResult = {
      content: [{ type: "text", text: "MCP output" }],
      structuredContent: { answer: 42 },
      _meta: { requestId: "request-1" },
    };
    const executor = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        const toolContext = {
          ...afterToolContext(),
          toolCall: {
            ...afterToolContext().toolCall,
            name: "mcp__notes__read",
          },
          result: {
            ...afterToolContext().result,
            details: { mcp: rawMcpResult },
          },
        } as never;
        for (const hook of runInput.hooks?.onToolExecutionStartHook ?? [])
          hook(toolContext);
        await runInput.hooks?.afterToolCallHook?.[0]?.(
          toolContext,
          runInput.signal,
        );
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );

    await executor.execute(
      executionInput({
        pluginMcpToolOwners: new Map([["mcp__notes__read", "notes-plugin"]]),
        pluginHooks: [
          {
            kind: "command",
            sourceFormat: "CLAUDE",
            pluginName: "compatible-hooks",
            pluginRoot: "/tmp/compatible-hooks",
            sourcePath: "hooks/hooks.json",
            event: "PostToolUse",
            command: "true",
            timeoutMs: 100,
            declarationOrder: 0,
          },
        ],
      }),
    );

    expect(hookInput).toMatchObject({
      event: "PostToolUse",
      toolProvenance: { kind: "plugin_mcp", pluginName: "notes-plugin" },
      payload: {
        compatible_tool_response: rawMcpResult,
        codex_tool_response: rawMcpResult,
        duration_ms: expect.any(Number),
      },
    });
    runEvent.mockRestore();
  });
});

describe("LocalRuntimeTurnExecutor mixed after-tool compatibility", () => {
  it("skips lossy Compatible Write output while preserving Codex PostToolUse", async () => {
    localPluginHookCoordinator.cancelSubagent("session-1");
    const root = await mkdtemp(join(tmpdir(), "desktop-mixed-post-tool-"));
    const realRunEvent = localPluginHookCoordinator.runEvent.bind(
      localPluginHookCoordinator,
    );
    const hookRuns: Array<{
      input: Parameters<typeof localPluginHookCoordinator.runEvent>[1];
      result: Awaited<ReturnType<typeof localPluginHookCoordinator.runEvent>>;
    }> = [];
    const runEvent = vi
      .spyOn(localPluginHookCoordinator, "runEvent")
      .mockImplementation(async (handlers, input, signal) => {
        const result = await realRunEvent(handlers, input, signal);
        hookRuns.push({ input, result });
        return result;
      });
    try {
      const script = join(root, "capture.mjs");
      const compatibleCapture = join(root, "compatible.json");
      const codexCapture = join(root, "codex.json");
      const transcriptPath = join(root, "transcript.jsonl");
      await writeFile(transcriptPath, "");
      await writeFile(
        script,
        "import {writeFileSync} from 'node:fs';const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);writeFileSync(process.argv[2],Buffer.concat(chunks))",
      );
      const handler = (
        sourceFormat: "CLAUDE" | "CODEX",
        capturePath: string,
        declarationOrder: number,
      ) => ({
        kind: "command" as const,
        sourceFormat,
        pluginName: `${sourceFormat.toLowerCase()}-hooks`,
        pluginRoot: root,
        sourcePath: script,
        event: "PostToolUse" as const,
        command: process.execPath,
        args: [script, capturePath],
        // This checks output compatibility, not subprocess startup latency under CI coverage.
        timeoutMs: 10_000,
        declarationOrder,
      });
      const executor = new LocalRuntimeTurnExecutor({
        ...options(async (runInput) => {
          await runInput.hooks?.afterToolCallHook?.[0]?.(
            {
              ...afterToolContext(),
              toolCall: { ...afterToolContext().toolCall, name: "write" },
              args: { path: "result.txt", content: "done" },
              result: {
                content: [
                  { type: "text", text: "Successfully wrote result.txt" },
                ],
                details: { bytes_written: 4 },
              },
            } as never,
            runInput.signal,
          );
          await runInput.eventWriter.pushRuntime(
            terminalEvent(RuntimeEventStatus.COMPLETED),
          );
        }),
        resolvePluginHookRuntimeContext: () => ({
          transcriptPath,
          permissionMode: "default",
        }),
      });
      const base = executionInput();

      await executor.execute(
        executionInput({
          session: { ...base.session, workspaceDir: root },
          pluginHooks: [
            handler("CLAUDE", compatibleCapture, 0),
            handler("CODEX", codexCapture, 1),
          ],
        }),
      );

      expect(hookRuns).toEqual([
        expect.objectContaining({
          input: expect.objectContaining({ event: "PostToolUse" }),
          result: expect.objectContaining({
            diagnostics: [
              expect.objectContaining({ code: "HOOK_INVALID_INPUT" }),
            ],
          }),
        }),
      ]);
      await expect(readFile(compatibleCapture, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      const codexInput = JSON.parse(await readFile(codexCapture, "utf8"));
      expect(codexInput).toMatchObject({
        hook_event_name: "PostToolUse",
        tool_name: "apply_patch",
        tool_input: { command: expect.any(String) },
        tool_response: "Successfully wrote result.txt",
      });
      expect(codexInput.tool_input.command).toContain("result.txt");
      expect(codexInput.tool_input.command).toContain("+done");
    } finally {
      runEvent.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("triggers Codex but not Compatible PostToolUse for transport or details.ok=false failures", async () => {
    const runEvent = vi.spyOn(localPluginHookCoordinator, "runEvent");
    const afterToolDecisions: unknown[] = [];
    const executor = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        afterToolDecisions.push(
          await runInput.hooks?.afterToolCallHook?.[0]?.(
            { ...afterToolContext(), isError: true } as never,
            runInput.signal,
          ),
        );
        const structuredFailure = afterToolContext();
        afterToolDecisions.push(
          await runInput.hooks?.afterToolCallHook?.[0]?.(
            {
              ...structuredFailure,
              isError: false,
              result: { ...structuredFailure.result, details: { ok: false } },
            } as never,
            runInput.signal,
          ),
        );
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );

    await executor.execute(
      executionInput({
        pluginHooks: [
          {
            kind: "command",
            sourceFormat: "CLAUDE",
            pluginName: "failed-tool-hooks",
            pluginRoot: "/tmp/failed-tool-hooks",
            sourcePath: "hooks/hooks.json",
            event: "PostToolUse",
            command: "true",
            timeoutMs: 100,
            declarationOrder: 0,
          },
          {
            kind: "command",
            sourceFormat: "CODEX",
            pluginName: "failed-tool-codex-hooks",
            pluginRoot: "/tmp/failed-tool-codex-hooks",
            sourcePath: ".codex/hooks.json",
            event: "PostToolUse",
            command: "true",
            timeoutMs: 100,
            declarationOrder: 1,
          },
        ],
      }),
    );

    expect(runEvent).toHaveBeenCalledTimes(2);
    expect(runEvent.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.arrayContaining([
            expect.objectContaining({
              sourceFormat: "CODEX",
              event: "PostToolUse",
            }),
          ]),
          expect.objectContaining({
            event: "PostToolUse",
            payload: expect.objectContaining({ is_error: true }),
          }),
          expect.any(AbortSignal),
        ],
      ]),
    );
    expect(afterToolDecisions).toEqual([{}, {}]);
    runEvent.mockRestore();
  });
});

describe("LocalRuntimeTurnExecutor after-tool context and ordering", () => {
  it("keeps Plugin Hook context when a background tool-result tail is appended", async () => {
    const runEvent = vi
      .spyOn(localPluginHookCoordinator, "runEvent")
      .mockImplementation(async (_handlers, input) => ({
        decision: {
          decision: "allow",
          ...(input.event === "PostToolUse"
            ? { additionalContext: "hook context" }
            : {}),
        },
        diagnostics: [],
      }));
    let afterToolDecision: unknown;
    const executorOptions = options(async (runInput) => {
      afterToolDecision = await runInput.hooks?.afterToolCallHook?.[0]?.(
        afterToolContext() as never,
        runInput.signal,
      );
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    const base = executionInput();

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(
        executionInput({
          pluginHooks: [
            {
              kind: "command",
              sourceFormat: "MINIMAX",
              pluginName: "tail-plugin",
              pluginRoot: "/tmp/tail-plugin",
              sourcePath: "hooks/hooks.json",
              event: "PostToolUse",
              command: "true",
              timeoutMs: 100,
              declarationOrder: 0,
            },
          ],
          control: {
            ...base.control,
            closeAndClaimToolResultTail: vi.fn(() => [
              {
                producerId: "test",
                idempotencyKey: "tail",
                message: { text: "tail content" },
                genuineUserQueryText: "",
                provenance: {
                  source: "background-task",
                  routingFingerprint: "tail",
                },
              },
            ]),
          },
        }),
      ),
    ).resolves.toEqual({ status: "completed" });

    expect(afterToolDecision).toEqual({
      content: [
        { type: "text", text: "original tool output" },
        {
          type: "text",
          text: "<plugin-hook-context>\nhook context\n</plugin-hook-context>",
        },
        { type: "text", text: "tail content" },
      ],
    });
    runEvent.mockRestore();
  });

  it("preserves Pi live-context ordering and merges returned patches in hook order", async () => {
    const firstPatch = {
      content: [{ type: "text" as const, text: "approved by first hook" }],
      details: { approved: true },
    };
    const secondHookContext = vi.fn();
    const closeAndClaimToolResultTail = vi.fn(() => []);
    let afterToolDecision: unknown;
    const executorOptions = options(async (runInput) => {
      const afterToolHook = runInput.hooks?.afterToolCallHook?.[0];
      afterToolDecision = await afterToolHook?.(
        afterToolContext() as never,
        runInput.signal,
      );
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    const firstAfterHook = vi.fn(
      (
        context: Parameters<
          NonNullable<AssemblyResult["hooks"]["afterToolCallHook"]>[number]
        >[0],
      ) => {
        Object.assign(context.toolCall, {
          id: "spoofed-tool-call",
          name: "spoofed-tool-name",
        });
        Object.assign(context.args as Record<string, unknown>, {
          input: "spoofed input",
        });
        context.result.content[0] = {
          type: "text",
          text: "mutated direct result",
        };
        return firstPatch;
      },
    );
    const secondAfterHook = vi.fn(
      async (
        context: Parameters<
          NonNullable<AssemblyResult["hooks"]["afterToolCallHook"]>[number]
        >[0],
      ) => {
        secondHookContext(context);
        return undefined;
      },
    );
    const base = executionInput();

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(
        executionInput({
          assembly: {
            ...base.assembly,
            hooks: {
              ...base.assembly.hooks,
              afterToolCallHook: [firstAfterHook, secondAfterHook],
            },
          },
          control: {
            ...base.control,
            closeAndClaimToolResultTail,
          },
        }),
      ),
    ).resolves.toEqual({ status: "completed" });

    expect(secondHookContext).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({
          id: "spoofed-tool-call",
          name: "spoofed-tool-name",
        }),
        args: { input: "spoofed input" },
        result: {
          content: [{ type: "text", text: "approved by first hook" }],
          details: { approved: true },
        },
      }),
    );
    expect(closeAndClaimToolResultTail).toHaveBeenCalledWith("tool-call-a");
    expect(afterToolDecision).toEqual({
      content: [{ type: "text", text: "approved by first hook" }],
      details: { approved: true },
    });
  });
});

describe("LocalRuntimeTurnExecutor content review routing", () => {
  it("keeps Desktop content review ownership unchanged when no product policy is set", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const base = executionInput();
    const executor = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );

    await executor.execute(
      executionInput({
        preparation: {
          ...base.preparation,
          llm: { ...base.preparation.llm, managedProvider: false } as never,
        },
      }),
    );

    expect(captured).not.toHaveProperty("contentReviewRequired");
    expect(captured).not.toHaveProperty("streamUnreviewedOutput");
  });

  it.each([
    ["legacy CLI managed", true, undefined, true, false],
    ["legacy CLI BYOK", false, undefined, false, false],
    ["TUI managed CN", true, true, true, false],
    ["TUI managed overseas", true, false, false, true],
    ["TUI BYOK", false, true, false, true],
  ])(
    "routes content review for %s without changing other products",
    async (
      _case,
      managedProvider,
      contentReviewEnabled,
      expected,
      streamUnreviewedOutput,
    ) => {
      let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
      const base = executionInput();
      const executor = new LocalRuntimeTurnExecutor({
        ...options(async (runInput) => {
          captured = runInput;
          await runInput.eventWriter.pushRuntime(
            terminalEvent(RuntimeEventStatus.COMPLETED),
          );
        }),
        cliProductPolicy: true,
        ...(contentReviewEnabled === undefined
          ? {}
          : { tuiProductPolicy: true, contentReviewEnabled }),
      });

      await executor.execute(
        executionInput({
          preparation: {
            ...base.preparation,
            llm: { ...base.preparation.llm, managedProvider } as never,
          },
        }),
      );

      expect(captured?.contentReviewRequired).toBe(expected);
      expect(captured?.streamUnreviewedOutput).toBe(
        streamUnreviewedOutput || undefined,
      );
      expect(captured?.deferInputReviewResolution).toBe(
        contentReviewEnabled === undefined ? undefined : true,
      );
      expect(captured?.includeDetailedUsage).toBe(
        contentReviewEnabled === undefined ? undefined : true,
      );
      // The retry commit boundary is shared by every host. No product policy
      // may inject a host-specific override into llmRetry.
      expect(captured?.llmRetry).toEqual({});
    },
  );
});

describe("LocalRuntimeTurnExecutor tool result routing", () => {
  it.each([
    ["Desktop", false, undefined],
    ["CLI", true, true],
  ])(
    "keeps Matrix failure normalization scoped to %s turns",
    async (_surface, cliProductPolicy, isError) => {
      let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
      const matrixTool = runtimeMatrixTool();
      const executor = new LocalRuntimeTurnExecutor({
        ...options(async (runInput) => {
          captured = runInput;
          await runInput.eventWriter.pushRuntime(
            terminalEvent(RuntimeEventStatus.COMPLETED),
          );
        }),
        ...(cliProductPolicy ? { cliProductPolicy: true } : {}),
      });

      await executor.execute(
        executionInput({
          assembly: { ...assembly(), tools: [matrixTool] },
        }),
      );

      const tool = captured?.tools?.[0];
      const toolContext = captured?.toolContext;
      if (!tool || !toolContext)
        throw new Error("Runner tool input was not captured.");
      const result = await tool.impl.execute(toolContext, {});
      expect(result.isError).toBe(isError);
    },
  );
});

describe("LocalRuntimeTurnExecutor input and tool safety", () => {
  it("preserves every Context Usage prompt range on the extension-prefixed system prompt", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const runner = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );
    const base = executionInput();

    await runner.execute(
      executionInput({
        preparation: {
          ...base.preparation,
          agentConfig: {
            ...base.preparation.agentConfig,
            contextUsagePromptRanges: [
              { kind: "OTHER", startOffset: 0, endOffset: 4 },
              {
                kind: "OTHER",
                startOffset: 5,
                endOffset: "base system".length,
              },
            ],
          },
          llm: { ...base.preparation.llm, managedProvider: false } as never,
        },
      }),
    );

    expect(captured?.systemPrompt).toBe("extension system\n\nbase system");
    expect(captured?.contextUsagePromptRanges).toEqual([
      {
        kind: "OTHER",
        startOffset: "extension system\n\n".length,
        endOffset: "extension system\n\n".length + 4,
      },
      {
        kind: "OTHER",
        startOffset: "extension system\n\n".length + 5,
        endOffset: "extension system\n\nbase system".length,
      },
    ]);
    const range = captured?.contextUsagePromptRanges?.[1];
    expect(
      range && captured?.systemPrompt.slice(range.startOffset, range.endOffset),
    ).toBe("system");
    expect(captured?.contextUsageRequiresProviderAnchor).toBe(true);
  });

  it("passes the digest-bound application decision to the runner unchanged", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const base = executionInput();
    const inputSafetyDecision = {
      inputDigest: digestSafetyInput(base.request.input),
      outcome: "degraded" as const,
    };
    const runner = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );

    await runner.execute(
      executionInput({
        request: {
          ...base.request,
          inputSafetyDecision,
        },
      }),
    );

    expect(captured).toMatchObject({
      inputSafetyDigest: inputSafetyDecision.inputDigest,
      inputSafetyDecision,
    });
  });

  it("preserves the authoritative canonical user text byte-for-byte in review and prompt input", async () => {
    const canonicalText = "  /review foo  \n";
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const runner = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );
    const base = executionInput();

    await runner.execute(
      executionInput({
        canonicalUserInput: {
          text: canonicalText,
          messages: [{ text: canonicalText }],
        },
        assembly: {
          ...base.assembly,
          userPromptPrefix: "",
          reminders: [],
        },
      }),
    );

    expect(captured?.reviewUserInput).toBe(canonicalText);
    expect(captured?.userMessage.text).toBe(canonicalText);
  });

  it("omits input review and its resolution callback for a hidden continuation", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const onInputReviewResolved = vi.fn();
    const executorOptions = {
      ...options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      onInputReviewResolved,
    };
    const base = executionInput();

    await new LocalRuntimeTurnExecutor(executorOptions).execute(
      executionInput({
        request: { ...base.request, requiresInputReview: false },
      }),
    );

    expect(captured?.reviewUserInput).toBeUndefined();
    expect(captured?.onInputReviewResolved).toBeUndefined();
    expect(onInputReviewResolved).not.toHaveBeenCalled();
  });

  it("reports an approved visible input with canonical text for deferred title generation", async () => {
    const onInputReviewResolved = vi.fn();
    const executorOptions = {
      ...options(async (runInput) => {
        runInput.onInputReviewResolved?.(false);
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      onInputReviewResolved,
    };

    await new LocalRuntimeTurnExecutor(executorOptions).execute(
      executionInput(),
    );

    expect(onInputReviewResolved).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-1",
      userInput: "hello",
      rejected: false,
    });
  });

  it("applies the host tool-disable safety switch before extension and permission hooks", async () => {
    const extensionHook = vi.fn(async () => undefined);
    const permissionGuard = vi.fn(async () => undefined);
    let decision: unknown;
    const executorOptions = {
      ...options(async (runInput) => {
        for (const hook of runInput.hooks?.beforeToolCallHook ?? []) {
          decision = await hook(
            {
              toolCall: { id: "tool-1", name: "bash", type: "toolCall" },
              args: { command: "git status" },
            } as never,
            runInput.signal,
          );
          if (decision) break;
        }
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      disableTools: true,
    };
    vi.mocked(executorOptions.executionPreparation.prepare).mockImplementation(
      async ({ execution }) => ({
        userMessage: {},
        caller: "chat",
        reminderBlocks: [],
        loadBackgroundReminder: vi.fn(async () => ({
          tasks: [],
          undeliveredTotal: 0,
          terminalTotal: 0,
        })),
        confirmBackgroundTaskReads: vi.fn(async () => undefined),
        toolResolution: {
          disableBuiltinToolFallback: true,
          permissionGuard,
          context: {
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            permissionScope: "workspace",
          },
        },
      }),
    );
    const input = executionInput({
      assembly: {
        ...assembly(),
        hooks: { ...assembly().hooks, beforeToolCallHook: [extensionHook] },
      },
    });

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(input),
    ).resolves.toEqual({
      status: "completed",
    });

    expect(decision).toEqual({
      block: true,
      reason: "Local runtime tool execution is disabled: bash",
    });
    expect(extensionHook).not.toHaveBeenCalled();
    expect(permissionGuard).not.toHaveBeenCalled();
  });
});

describe("LocalRuntimeTurnExecutor execution budget reminders", () => {
  it.each([
    { durationMs: 600_000, nearDeadlineMs: 60_000 },
    { durationMs: 120_000, nearDeadlineMs: 30_000 },
  ])(
    "reminds a budgeted run ($durationMs ms) without changing history or the system prompt",
    async ({ durationMs, nearDeadlineMs }) => {
      let nowMs = 1_000;
      const executorOptions = options(async (runInput) => {
        const messages = [
          { role: "user" as const, content: "hello", timestamp: 1 },
        ];
        // The budget reminder is registered immediately before the background
        // cadence reminder, so it is the second-to-last host hook.
        const hook = runInput.hooks?.beforeLlmCallHook?.at(-2);
        const hookInput = {
          sessionId: runInput.sessionId,
          turnId: runInput.turnId,
          phase: "initial" as const,
          messages,
          canonicalMessages: messages,
          model: runInput.llm.model,
          thinkingLevel: "off" as const,
        };
        const initial = await hook?.(hookInput);
        expect(initial).toMatchObject({
          type: "replaceRequestMessages",
          reason: "execution-budget-context",
          messages: [
            messages[0],
            {
              role: "user",
              content: expect.stringContaining(`${durationMs / 1_000} seconds`),
            },
          ],
        });
        nowMs = 1_000 + durationMs - nearDeadlineMs - 1;
        expect(
          await hook?.({ ...hookInput, phase: "iteration" }),
        ).toMatchObject({
          type: "replaceRequestMessages",
          messages: [
            messages[0],
            { content: expect.stringContaining("Execution time remaining") },
          ],
        });
        nowMs += 1;
        expect(
          await hook?.({ ...hookInput, phase: "iteration" }),
        ).toMatchObject({
          type: "replaceRequestMessages",
          messages: [
            messages[0],
            {
              role: "user",
              content: expect.stringContaining(
                `${nearDeadlineMs / 1_000} seconds`,
              ),
            },
          ],
        });
        nowMs += 1;
        expect(
          await hook?.({ ...hookInput, phase: "iteration" }),
        ).toMatchObject({
          type: "replaceRequestMessages",
          messages: [
            messages[0],
            { content: expect.stringContaining("Execution time remaining") },
          ],
        });
        nowMs = 1_000 + durationMs;
        expect(
          await hook?.({ ...hookInput, phase: "iteration" }),
        ).toBeUndefined();
        expect(messages).toEqual([
          { role: "user", content: "hello", timestamp: 1 },
        ]);
        expect(runInput.systemPrompt).toBe("extension system\n\nbase system");
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      });
      const input = executionInput();

      await new LocalRuntimeTurnExecutor({
        ...executorOptions,
        nowMs: () => nowMs,
        canAppendExecutionBudgetReminder: () => true,
      }).execute({
        ...input,
        request: {
          ...input.request,
          executionDeadlineAtMs: 1_000 + durationMs,
        },
      });

      expect(input.onHistoryChanged).not.toHaveBeenCalled();
    },
  );

  it("samples budget context while preserving existing request observers", async () => {
    let nowMs = 1_000;
    const existingObserver = vi.fn();
    const logger = { info: vi.fn() };
    const executorOptions = options(async (runInput) => {
      const messages = [
        { role: "user" as const, content: "hello", timestamp: 1 },
      ];
      const input = {
        sessionId: runInput.sessionId,
        turnId: runInput.turnId,
        phase: "initial" as const,
        messages,
        canonicalMessages: messages,
        model: runInput.llm.model,
        thinkingLevel: "off" as const,
      };
      const initial = await runInput.hooks!.beforeLlmCallHook!.at(-2)!(input);
      if (initial?.type !== "replaceRequestMessages")
        throw new Error("Expected initial reminder");
      for (const observer of runInput.hooks!.onLlmCallPreparedHook!) {
        await observer({
          ...input,
          messages: initial.messages,
          scope: "agent",
          systemPrompt: "",
          tools: [],
        });
      }
      expect(existingObserver).toHaveBeenCalledOnce();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ remaining_ms: 600_000 }),
        "execution budget context sampled",
      );
      nowMs = 100_000;
      const next = await runInput.hooks!.beforeLlmCallHook!.at(-2)!(input);
      if (next?.type !== "replaceRequestMessages")
        throw new Error("Expected time context");
      expect(next.messages.at(-1)).toMatchObject({
        content: expect.stringContaining(
          "previous model request was prepared: 99 seconds",
        ),
      });
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    const input = executionInput();
    await new LocalRuntimeTurnExecutor({
      ...executorOptions,
      nowMs: () => nowMs,
      canAppendExecutionBudgetReminder: () => true,
      logger,
    }).execute({
      ...input,
      assembly: {
        ...input.assembly,
        hooks: {
          ...input.assembly.hooks,
          onLlmCallPreparedHook: [existingObserver],
        },
      },
      request: { ...input.request, executionDeadlineAtMs: 601_000 },
    });
    expect(input.onHistoryChanged).not.toHaveBeenCalled();
  });

  it("does not add budget context to unbudgeted or already aborted runs", async () => {
    for (const aborted of [false, true]) {
      const controller = new AbortController();
      if (aborted) controller.abort();
      const executorOptions = options(async (runInput) => {
        const messages = [
          { role: "user" as const, content: "hello", timestamp: 1 },
        ];
        const decision = await runInput.hooks?.beforeLlmCallHook?.at(-2)?.({
          sessionId: runInput.sessionId,
          turnId: runInput.turnId,
          phase: "initial",
          messages,
          canonicalMessages: messages,
          model: runInput.llm.model,
          thinkingLevel: "off",
          signal: controller.signal,
        });
        expect(decision).toBeUndefined();
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      });
      const input = executionInput();
      await new LocalRuntimeTurnExecutor({
        ...executorOptions,
        nowMs: () => 1_000,
        canAppendExecutionBudgetReminder: () => true,
      }).execute({
        ...input,
        request: {
          ...input.request,
          ...(aborted ? { executionDeadlineAtMs: 601_000 } : {}),
        },
      });
    }
  });

  it("registers the request-only budget reminder before the appending background reminder", async () => {
    // runBeforeLLM ends the before-LLM decision pipeline as soon as a hook
    // returns appendMessage. The background cadence reminder appends, so a
    // budget reminder registered after it would be silently skipped for every
    // request where the background reminder fires. The relative order is the
    // only thing keeping the request-only reminder observable.
    const backgroundHook = vi.fn(() => undefined);
    const executorOptions = options(async (runInput) => {
      const messages = [
        { role: "user" as const, content: "hello", timestamp: 1 },
      ];
      const hooks = runInput.hooks?.beforeLlmCallHook ?? [];
      const decisions = await Promise.all(
        hooks.map((hook) =>
          hook({
            sessionId: runInput.sessionId,
            turnId: runInput.turnId,
            phase: "initial",
            messages,
            canonicalMessages: messages,
            model: runInput.llm.model,
            thinkingLevel: "off",
          }),
        ),
      );
      const budgetIndex = decisions.findIndex(
        (decision) =>
          decision?.type === "replaceRequestMessages" &&
          decision.reason === "execution-budget-context",
      );
      const backgroundIndex = hooks.indexOf(backgroundHook);
      expect(budgetIndex).toBeGreaterThanOrEqual(0);
      expect(backgroundIndex).toBeGreaterThanOrEqual(0);
      expect(budgetIndex).toBeLessThan(backgroundIndex);
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    const input = executionInput();
    await new LocalRuntimeTurnExecutor({
      ...executorOptions,
      nowMs: () => 1_000,
      canAppendExecutionBudgetReminder: () => true,
      backgroundCadenceReminder: {
        prepare: async () => ({ beforeUserMessages: [], hook: backgroundHook }),
      },
    }).execute({
      ...input,
      request: { ...input.request, executionDeadlineAtMs: 601_000 },
    });
  });
});

describe("LocalRuntimeTurnExecutor budget with durable reminders", () => {
  it.each([
    { admission: "allow", mode: "append" },
    { admission: "deny", mode: "append" },
    { admission: "throw", mode: "append" },
    { admission: "allow", mode: "defer" },
    { admission: "allow", mode: "placed" },
    { admission: "allow", mode: "delayed" },
    { admission: "allow", mode: "observed" },
  ] as const)(
    "preserves durable reminders with request-only time context ($mode, $admission)",
    async ({ admission, mode }) => {
      let nowMs = 1_000;
      const marker = {
        role: "custom" as const,
        customType: "background_cadence",
        content: "A background result is ready.",
        display: false as const,
        timestamp: 2,
      };
      const backgroundHook = vi.fn(() => ({
        type: "appendMessage" as const,
        reason: "background_cadence",
        message: marker,
        ...(mode === "append" || mode === "delayed" || mode === "observed"
          ? {}
          : { placement: "before-current-user" as const }),
      }));
      const replacement = (hookInput: PiBeforeLlmCallHookInput) => ({
        type: "replaceMessages" as const,
        messages: hookInput.canonicalMessages,
        metadata: {
          replacementId: "budget-test",
          strategyVersion: "budget-test",
          summary: "",
          firstKeptIndex: 0,
          compactedMessages: [],
          keptMessages: hookInput.canonicalMessages,
        },
        afterCommit: async () => {
          if (mode !== "delayed") return undefined;
          nowMs += 90_000;
          return {
            ...marker,
            customType: "compaction",
            content: "Compaction callback finished.",
          };
        },
      });
      const laterHook = vi.fn(replacement);
      const canAppend = vi.fn((hookInput: PiBeforeLlmCallHookInput) => {
        // The request-only reminder runs before the appending background
        // reminder and before any post-commit callback, so it samples the
        // pre-append request view.
        expect(hookInput.messages.some((message) => message === marker)).toBe(
          false,
        );
        expect(JSON.stringify(hookInput.messages)).not.toContain(
          "Compaction callback finished.",
        );
        if (admission === "throw") throw new Error("admission unavailable");
        return admission === "allow";
      });
      const providerContexts: string[] = [];
      const preparedContexts: string[] = [];
      const executorOptions = options((runInput) =>
        new PiTurnRunner().runTurn({
          ...runInput,
          toolConfig: { tools: runInput.tools, context: runInput.toolContext! },
          llm: {
            ...runInput.llm,
            streamFn: (model, context) => {
              providerContexts.push(JSON.stringify(context.messages));
              expect(nowMs).toBe(
                mode === "delayed" || mode === "observed" ? 91_000 : 1_000,
              );
              const final = {
                ...afterToolContext().assistantMessage,
                role: "assistant" as const,
                api: model.api,
                content: [{ type: "text" as const, text: "done" }],
                stopReason: "stop" as const,
              };
              const stream = createAssistantMessageEventStream();
              stream.push({ type: "done", reason: "stop", message: final });
              stream.end(final);
              return stream;
            },
          },
        }),
      );
      const input = executionInput();
      await expect(
        new LocalRuntimeTurnExecutor({
          ...executorOptions,
          nowMs: () => nowMs,
          canAppendExecutionBudgetReminder: canAppend,
          backgroundCadenceReminder: {
            prepare: async () => ({
              beforeUserMessages: [],
              hook: backgroundHook,
            }),
          },
          resolveBeforeLlmCallHooks: async () =>
            mode === "placed" || mode === "delayed" ? [replacement] : [],
          afterCompactionBeforeLlmCallHooks: [laterHook],
        }).execute({
          ...input,
          assembly: {
            ...input.assembly,
            hooks: {
              ...input.assembly.hooks,
              onLlmCallPreparedHook: [
                async (prepared) => {
                  preparedContexts.push(JSON.stringify(prepared.messages));
                  if (mode === "observed") nowMs += 90_000;
                },
              ],
            },
          },
          request: { ...input.request, executionDeadlineAtMs: 121_000 },
        }),
      ).resolves.toEqual({ status: "completed" });
      expect(providerContexts).toHaveLength(1);
      expect(providerContexts).toEqual(preparedContexts);
      const requestContext = providerContexts[0] ?? "";
      expect(requestContext.includes(marker.content)).toBe(mode !== "defer");
      // A later durable replaceMessages hook rebuilds the request from canonical
      // history, which drops an earlier request-only replacement ('defer' runs
      // laterHook because the background marker cannot be placed).
      const keepsRequestContext = admission === "allow" && mode !== "defer";
      expect(
        requestContext.match(/Execution time remaining/g) ?? [],
      ).toHaveLength(keepsRequestContext ? 1 : 0);
      if (keepsRequestContext) {
        expect(requestContext).toContain(
          "Execution time remaining at request preparation: 120 seconds.",
        );
      }
      expect(canAppend).toHaveBeenCalledOnce();
      expect(backgroundHook).toHaveBeenCalledOnce();
      expect(laterHook).toHaveBeenCalledTimes(mode === "defer" ? 1 : 0);
      const historyChanges = vi.mocked(input.onHistoryChanged).mock.calls;
      expect(historyChanges.length).toBeGreaterThan(0);
      const history = historyChanges.flatMap(([change]) => change.messages);
      expect(JSON.stringify(history).includes(marker.content)).toBe(
        mode !== "defer",
      );
      expect(JSON.stringify(history)).not.toContain("Execution time remaining");
    },
  );
});

describe("LocalRuntimeTurnExecutor beforeLlmCall and reconcile", () => {
  it("runs PostCompact and compact SessionStart after an automatic replacement commits", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    let mode: "context" | "aborted" | "failure" = "context";
    const runEvent = vi
      .spyOn(localPluginHookCoordinator, "runEvent")
      .mockImplementation(async (_handlers, event) => {
        if (mode === "failure") throw new Error("hook runtime unavailable");
        if (event.event === "SessionStart" && mode === "aborted") {
          return {
            decision: { decision: "allow" },
            diagnostics: [
              {
                code: "HOOK_ABORTED",
                event: "SessionStart",
                pluginName: "compact-plugin",
                sourcePath: "hooks/hooks.json",
              },
            ],
          } as never;
        }
        return {
          decision: {
            decision: "allow",
            ...(event.event === "SessionStart"
              ? { additionalContext: "context after compaction" }
              : {}),
          },
          diagnostics: [],
        };
      });
    const complete = vi.spyOn(
      localPluginHookCoordinator,
      "completeAutomaticCompaction",
    );
    const markCompacted = vi.spyOn(localPluginHookCoordinator, "markCompacted");
    const contextCompactionHook = vi.fn(async () => ({
      type: "replaceMessages" as const,
      messages: [],
      metadata: { compactionAttemptId: "attempt-1" },
    })) as never;
    const executorOptions = options(async (runInput) => {
      captured = runInput;
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    const input = executionInput({
      contextCompactionHook,
      pluginHooks: [
        {
          kind: "command",
          sourceFormat: "MINIMAX",
          pluginName: "compact-plugin",
          pluginRoot: "/tmp/compact-plugin",
          sourcePath: "hooks/hooks.json",
          event: "PostCompact",
          command: "true",
          timeoutMs: 100,
          declarationOrder: 0,
        },
      ],
    });

    await new LocalRuntimeTurnExecutor(executorOptions).execute(input);
    const wrappedCompaction = captured?.hooks?.beforeLlmCallHook?.[2];
    const decision = await wrappedCompaction?.({} as never);
    if (!decision || decision.type !== "replaceMessages") {
      throw new Error("expected wrapped compaction replacement");
    }

    await expect(decision.afterCommit?.()).resolves.toEqual({
      role: "custom",
      customType: "plugin_hook_context",
      content:
        "<plugin-hook-context>\ncontext after compaction\n</plugin-hook-context>",
      display: false,
      timestamp: expect.any(Number),
    });
    mode = "aborted";
    await expect(decision.afterCommit?.()).resolves.toBeUndefined();
    mode = "failure";
    await expect(decision.afterCommit?.()).resolves.toBeUndefined();

    expect(complete).toHaveBeenCalledTimes(3);
    expect(markCompacted).toHaveBeenCalledTimes(2);
    runEvent.mockRestore();
    complete.mockRestore();
    markCompacted.mockRestore();
  });

  it("retracts the rejected attempt before rearming its primary user identity", async () => {
    const recallOutputAttemptHistory = vi.fn(async () => undefined);
    const rearmPrimaryUserMessageIdAfterOutputRecall = vi.fn();
    const executorOptions = options(async (runInput) => {
      await runInput.recallOutputAttemptHistory?.(1);
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    const input = executionInput({
      history: {
        revision: "r1",
        messages: [{ role: "user", content: "history", timestamp: 1 }],
        identityVector: ["msg-user-v1-history"],
      },
      recallOutputAttemptHistory,
      rearmPrimaryUserMessageIdAfterOutputRecall,
    });

    await new LocalRuntimeTurnExecutor(executorOptions).execute(input);

    expect(recallOutputAttemptHistory).toHaveBeenCalledWith(1);
    expect(rearmPrimaryUserMessageIdAfterOutputRecall).toHaveBeenCalledOnce();
    expect(recallOutputAttemptHistory.mock.invocationCallOrder[0]).toBeLessThan(
      rearmPrimaryUserMessageIdAfterOutputRecall.mock.invocationCallOrder[0] ??
        Number.NaN,
    );
  });

  it("does not rearm the primary identity when the durable attempt retraction fails", async () => {
    const retractionFailure = new Error("canonical retraction failed");
    const rearmPrimaryUserMessageIdAfterOutputRecall = vi.fn();
    const executorOptions = options(async (runInput) => {
      await runInput.recallOutputAttemptHistory?.(1);
    });

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(
        executionInput({
          history: {
            revision: "r1",
            messages: [{ role: "user", content: "history", timestamp: 1 }],
            identityVector: ["msg-user-v1-history"],
          },
          recallOutputAttemptHistory: vi.fn(async () =>
            Promise.reject(retractionFailure),
          ),
          rearmPrimaryUserMessageIdAfterOutputRecall,
        }),
      ),
    ).rejects.toBe(retractionFailure);
    expect(rearmPrimaryUserMessageIdAfterOutputRecall).not.toHaveBeenCalled();
  });

  it("projects an intermediate output recall through the SessionSystem capability", async () => {
    const executorOptions = options(async (runInput) => {
      await runInput.onOutputRecall?.({
        attempt: 2,
        messageIds: ["assistant-live"],
      });
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });

    await new LocalRuntimeTurnExecutor(executorOptions).execute(
      executionInput(),
    );

    expect(
      executorOptions.attemptRecall.recallAssistantAttempt,
    ).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-1",
      attempt: 2,
      messageIds: ["assistant-live"],
    });
  });
});

describe("LocalRuntimeTurnExecutor beforeLlmCall compaction hooks", () => {
  it("wraps automatic compaction after every replacement or abort-capable normal hook", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const hostHook = vi.fn(async () => undefined);
    const compactionHook = vi.fn(async () => undefined);
    const afterCompactionHook = vi.fn(async () => undefined);
    const executorOptions = {
      ...options(async (runInput) => {
        captured = runInput;
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      resolveBeforeLlmCallHooks: vi.fn(async () => [hostHook]),
      afterCompactionBeforeLlmCallHooks: [afterCompactionHook],
    };
    const input = executionInput({ contextCompactionHook: compactionHook });

    await new LocalRuntimeTurnExecutor(executorOptions).execute(input);

    const runtimeHook = input.assembly.hooks.beforeLlmCallHook?.[0];
    expect(captured?.hooks?.beforeLlmCallHook).toEqual([
      runtimeHook,
      hostHook,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      afterCompactionHook,
    ]);
    expect(captured?.hooks?.beforeLlmCallHook?.[3]).not.toBe(compactionHook);
    expect(executorOptions.resolveBeforeLlmCallHooks).toHaveBeenCalledTimes(1);
  });

  it("maps the resolved request body cap into the runner LLM contract", async () => {
    let captured: LocalRuntimeTurnRunnerInput<LocalToolContext> | undefined;
    const base = executionInput();
    const input = executionInput({
      preparation: {
        ...base.preparation,
        llm: { ...base.preparation.llm, maxRequestBodyBytes: 12_345 },
      },
    });
    const executorOptions = options(async (runInput) => {
      captured = runInput;
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });

    await new LocalRuntimeTurnExecutor(executorOptions).execute(input);

    expect(captured?.llm.maxSerializedInputBytes).toBe(12_345);
  });

  it.each(["openai-completions", "anthropic-messages"] as const)(
    "records a secret-free %s envelope at the final prepared boundary",
    async (api) => {
      const base = executionInput();
      const input = executionInput({
        preparation: {
          ...base.preparation,
          llm: {
            ...base.preparation.llm,
            model: { ...base.preparation.llm.model, api },
          },
        },
      });
      const writeCurrent = vi.fn<
        SessionLlmCallReportCapability["writeCurrent"]
      >(async () => undefined);
      const reportingRuntime = await createAgentRuntime({
        base: [sessionReportExtension({ reports: { writeCurrent } })],
      });
      const reportingAssembly = await reportingRuntime.assembleTurn(
        input.assemblyContext,
      );
      const reportedInput = {
        ...input,
        assembly: {
          ...input.assembly,
          hooks: { ...input.assembly.hooks, ...reportingAssembly.hooks },
        },
      };
      const executorOptions = {
        ...options(async (runInput) => {
          const capture = runInput.hooks?.onLlmCallPreparedHook?.at(-1);
          if (!capture) throw new Error("LLM call evidence hook missing");
          await capture({
            sessionId: runInput.sessionId,
            turnId: runInput.turnId,
            phase: "initial",
            scope: "agent",
            messages: [],
            model: runInput.llm.model,
            maxTokens: 1_024,
            hostMaxOutputTokens: 512,
            maxSerializedInputBytes: 2_048,
            cacheRetention: "short",
            systemPrompt: runInput.systemPrompt ?? "",
            tools: [
              {
                name: "read",
                description: "read files",
                parameters: { type: "object" },
              },
            ],
            thinkingLevel: "medium",
          });
          await runInput.eventWriter.pushRuntime(
            terminalEvent(RuntimeEventStatus.COMPLETED),
          );
        }),
        outputTokenCap: { resolveOutputTokenCap: () => 512 },
      };

      await new LocalRuntimeTurnExecutor(executorOptions).execute(
        reportedInput,
      );

      expect(writeCurrent).toHaveBeenCalledWith({
        sessionId: "session-1",
        turnId: "turn-1",
        envelope: expect.objectContaining({
          schemaVersion: 1,
          systemPrompt: expect.any(String),
          model: "model",
          provider: "provider",
          api,
          thinkingLevel: "medium",
          maxTokens: 1_024,
          hostMaxOutputTokens: 512,
          maxSerializedInputBytes: 2_048,
          cacheRetention: "short",
        }),
      });
      const serialized = JSON.stringify(writeCurrent.mock.calls[0]?.[0]);
      expect(serialized).not.toContain("private-api-key");
      expect(serialized).not.toContain("private-token");
      expect(serialized).not.toContain("apiKey");
      expect(serialized).not.toContain("headers");
    },
  );

  it.each([
    [
      { kind: "output-recall" as const, variant: "network" as const },
      { kind: "output-recall" as const, variant: "network" as const },
    ],
    [
      { kind: "network-reconcile" as const, approvedContent: "partial" },
      { kind: "network-reconcile" as const, approvedContent: "partial" },
    ],
    [
      { kind: "abort-reconcile" as const },
      { kind: "abort-reconcile" as const, approvedContent: "" },
    ],
  ])(
    "maps a runner reconcile signal %o onto the terminal outcome",
    async (signal, expected) => {
      const runner = new LocalRuntimeTurnExecutor(
        options(async (runInput) => {
          await runInput.eventWriter.pushRuntime(
            terminalEvent(RuntimeEventStatus.COMPLETED),
          );
          return { reconcile: signal };
        }),
      );

      await expect(runner.execute(executionInput())).resolves.toEqual({
        status: "completed",
        historyReconcile: expected,
      });
    },
  );

  it("omits historyReconcile when the runner returns no reconcile signal", async () => {
    const runner = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
        return {};
      }),
    );

    await expect(runner.execute(executionInput())).resolves.toEqual({
      status: "completed",
    });
  });
});

describe("LocalRuntimeTurnExecutor failure handling", () => {
  it("maps failed terminal details to a typed Host failure root", async () => {
    const runner = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.FAILED),
        );
      }),
    );

    const outcome = await runner.execute(executionInput());

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error).toBeInstanceOf(LocalRuntimeTerminalError);
      expect(outcome.error).toMatchObject({
        eventId: `terminal-${RuntimeEventStatus.FAILED}`,
      });
    }
  });

  it("propagates runtime and tool/permission failures unchanged", async () => {
    const runError = new Error("runner rejected");
    const runner = new LocalRuntimeTurnExecutor(
      options(async () => {
        throw runError;
      }),
    );
    await expect(runner.execute(executionInput())).rejects.toBe(runError);

    const permissionError = new Error("permission context unavailable");
    const permissionOptions = options(async () => undefined);
    vi.mocked(permissionOptions.executionPreparation.prepare).mockRejectedValue(
      permissionError,
    );
    await expect(
      new LocalRuntimeTurnExecutor(permissionOptions).execute(executionInput()),
    ).rejects.toBe(permissionError);
  });

  it("fails closed before runtime when the tool owner omits its permission guard", async () => {
    const runTurn = vi.fn(async () => undefined);
    const executorOptions = options(runTurn);
    vi.mocked(executorOptions.executionPreparation.prepare).mockResolvedValue({
      userMessage: {},
      caller: "chat",
      reminderBlocks: [],
      loadBackgroundReminder: vi.fn(async () => ({
        tasks: [],
        undeliveredTotal: 0,
        terminalTotal: 0,
      })),
      confirmBackgroundTaskReads: vi.fn(async () => undefined),
      toolResolution: {
        disableBuiltinToolFallback: true,
        context: {
          sessionId: "session-1",
          turnId: "turn-1",
          permissionScope: "workspace",
        },
      },
    } as never);

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(executionInput()),
    ).rejects.toThrow("Resolved host tool and permission context is invalid.");
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("rejects a raw reminder body before invoking the runtime", async () => {
    const runTurn = vi.fn(async () => undefined);
    const runner = new LocalRuntimeTurnExecutor(options(runTurn));
    const input = executionInput({
      assembly: {
        ...assembly(),
        reminders: [
          {
            providerName: "raw-provider",
            reminder: { content: "raw reminder body", priority: 10 },
          },
        ],
      },
    });

    await expect(runner.execute(input)).rejects.toThrow(
      "AgentRuntime reminder provider 'raw-provider' must emit one non-empty complete <system-reminder> block.",
    );
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("rejects an empty reminder block before invoking the runtime", async () => {
    const runTurn = vi.fn(async () => undefined);
    const runner = new LocalRuntimeTurnExecutor(options(runTurn));
    const input = executionInput({
      assembly: {
        ...assembly(),
        reminders: [
          {
            providerName: "empty-provider",
            reminder: { content: "   ", priority: 10 },
          },
        ],
      },
    });

    await expect(runner.execute(input)).rejects.toThrow(
      "AgentRuntime reminder provider 'empty-provider' must emit one non-empty complete <system-reminder> block.",
    );
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("fails closed for missing, duplicate, and unsupported terminal events", async () => {
    const missing = new LocalRuntimeTurnExecutor(
      options(async () => undefined),
    );
    await expect(missing.execute(executionInput())).rejects.toMatchObject({
      name: "LocalRuntimeTerminalIdentityError",
      reason: "missing",
    });

    const duplicate = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
    );
    await expect(duplicate.execute(executionInput())).rejects.toMatchObject({
      name: AgentTerminalConfirmationError.name,
      reason: "conflict",
    });

    const unsupported = new LocalRuntimeTurnExecutor(
      options(async (runInput) => {
        await runInput.eventWriter.pushRuntime({
          ...terminalEvent(RuntimeEventStatus.COMPLETED),
          payload: { status: RuntimeEventStatus.IDLE },
        });
      }),
    );
    await expect(unsupported.execute(executionInput())).rejects.toBeInstanceOf(
      LocalRuntimeTerminalIdentityError,
    );
  });
});

describe("LocalRuntimeTurnExecutor committed facts", () => {
  it("commits file-change evidence together with history reconciliation", async () => {
    const executorOptions = options(async (runInput) => {
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
      return {
        reconcile: {
          kind: "network-reconcile",
          approvedContent: "visible partial",
        },
      };
    });
    vi.mocked(executorOptions.fileChanges.finalize).mockResolvedValue({
      fileChange: "change_observed",
      changedFiles: ["src/result.ts"],
      observationNotes: [],
    });

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(executionInput()),
    ).resolves.toEqual({
      status: "completed",
      historyReconcile: {
        kind: "network-reconcile",
        approvedContent: "visible partial",
      },
      committedFacts: {
        fileChangeObservation: {
          fileChange: "change_observed",
          changedFiles: ["src/result.ts"],
          observationNotes: [],
        },
      },
    });
  });

  it("does not invent committed facts when no file-change evidence exists", async () => {
    const executorOptions = options(async (runInput) => {
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
      return undefined;
    });

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(executionInput()),
    ).resolves.toEqual({ status: "completed" });
  });
});

describe("LocalRuntimeTurnExecutor lifecycle failure handling", () => {
  it("stages completed background read candidates after finalizing file changes", async () => {
    const order: string[] = [];
    const executorOptions = {
      ...options(async (runInput) => {
        order.push("runner");
        await runInput.hooks?.afterToolCallHook?.[0]?.(
          {
            toolCall: {
              id: "task-output-1",
              name: "task_output",
              type: "toolCall",
            },
            args: { task_id: "task-1" },
            result: { content: [{ type: "text", text: "done" }], details: {} },
            isError: false,
          } as never,
          runInput.signal,
        );
        await runInput.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
        return { outcome: { status: "completed", messageId: "assistant-1" } };
      }),
    };
    vi.mocked(executorOptions.executionPreparation.prepare).mockImplementation(
      async ({ execution }) => ({
        userMessage: {},
        caller: "chat",
        reminderBlocks: [],
        loadBackgroundReminder: vi.fn(async () => ({
          tasks: [],
          undeliveredTotal: 0,
          terminalTotal: 0,
        })),
        toolResolution: {
          disableBuiltinToolFallback: true,
          permissionGuard: vi.fn(async () => undefined),
          context: {
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            permissionScope: "workspace",
          },
        },
      }),
    );
    vi.mocked(executorOptions.fileChanges.begin).mockImplementation(
      async () => {
        order.push("file:begin");
      },
    );
    vi.mocked(executorOptions.fileChanges.finalize).mockImplementation(
      async (input) => {
        order.push(`file:finalize:${input.assistantMessageId}`);
        return undefined;
      },
    );

    const input = executionInput();
    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(input),
    ).resolves.toEqual({
      status: "completed",
      committedFacts: { backgroundTaskReadCandidates: ["task-1"] },
    });

    expect(order).toEqual([
      "file:begin",
      "runner",
      "file:finalize:assistant-1",
    ]);
    expect(input.onHistoryChanged).not.toHaveBeenCalled();
    expect(executorOptions.fileChanges.markFailed).not.toHaveBeenCalled();
  });

  it("suppresses a due reminder during the tool loop after a successful task_output read", async () => {
    const loadBackgroundReminder = vi.fn(async () => ({
      tasks: [
        { taskId: "task-1", status: "succeeded" as const, endedAtMs: 10 },
      ],
      undeliveredTotal: 1,
      terminalTotal: 1,
    }));
    const executorOptions = options(async (runInput) => {
      await runInput.hooks?.afterToolCallHook?.[0]?.(
        {
          toolCall: {
            id: "task-output-1",
            name: "task_output",
            type: "toolCall",
          },
          args: { task_id: "task-1" },
          result: { content: [{ type: "text", text: "done" }], details: {} },
          isError: false,
        } as never,
        runInput.signal,
      );
      const messages = Array.from({ length: 15 }, (_, index) => ({
        role: "assistant" as const,
        content: [],
        timestamp: index + 1,
      })) as never[];
      await expect(
        Promise.resolve(
          runInput.hooks?.beforeLlmCallHook?.at(-1)?.({
            sessionId: runInput.sessionId,
            turnId: runInput.turnId,
            phase: "iteration",
            messages,
            canonicalMessages: messages,
            model: runInput.llm.model,
            thinkingLevel: "off",
            tools: [],
          }),
        ),
      ).resolves.toBeUndefined();
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    vi.mocked(executorOptions.executionPreparation.prepare).mockImplementation(
      async ({ execution }) => ({
        userMessage: {},
        caller: "chat",
        reminderBlocks: [],
        loadBackgroundReminder,
        toolResolution: {
          disableBuiltinToolFallback: true,
          permissionGuard: vi.fn(async () => undefined),
          context: {
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            permissionScope: "workspace",
          },
        },
      }),
    );

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(executionInput()),
    ).resolves.toEqual({
      status: "completed",
      committedFacts: { backgroundTaskReadCandidates: ["task-1"] },
    });
    expect(loadBackgroundReminder).toHaveBeenCalledOnce();
  });
});

describe("LocalRuntimeTurnExecutor abnormal lifecycle failure handling", () => {
  it.each([RuntimeEventStatus.ABORTED, RuntimeEventStatus.FAILED])(
    "does not settle a successful task_output read when the Turn ends as %s",
    async (terminalStatus) => {
      const executorOptions = options(async (runInput) => {
        await runInput.hooks?.afterToolCallHook?.[0]?.(
          {
            toolCall: {
              id: "task-output-1",
              name: "task_output",
              type: "toolCall",
            },
            args: { task_id: "task-1" },
            result: { content: [{ type: "text", text: "done" }], details: {} },
            isError: false,
          } as never,
          runInput.signal,
        );
        await runInput.eventWriter.pushRuntime(terminalEvent(terminalStatus));
      });
      vi.mocked(
        executorOptions.executionPreparation.prepare,
      ).mockImplementation(async ({ execution }) => ({
        userMessage: {},
        caller: "chat",
        reminderBlocks: [],
        loadBackgroundReminder: vi.fn(async () => ({
          tasks: [],
          undeliveredTotal: 0,
          terminalTotal: 0,
        })),
        toolResolution: {
          disableBuiltinToolFallback: true,
          permissionGuard: vi.fn(async () => undefined),
          context: {
            sessionId: execution.lease.sessionId,
            turnId: execution.lease.turnId,
            permissionScope: "workspace",
          },
        },
      }));
      const input = executionInput();

      const outcome = await new LocalRuntimeTurnExecutor(
        executorOptions,
      ).execute(input);

      expect(
        outcome.committedFacts?.backgroundTaskReadCandidates,
      ).toBeUndefined();
      expect(input.onHistoryChanged).not.toHaveBeenCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({
            id: "background-task-read-settlement:turn-1",
          }),
        }),
      );
    },
  );

  it("finalizes file observations for a failed terminal before returning the outcome", async () => {
    const executorOptions = options(async (runInput) => {
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.FAILED),
      );
    });
    const observation: AgentHostFileChangeObservation = {
      fileChange: "no_observed_change",
      observationNotes: ["runtime_failed_without_observed_write"],
    };
    vi.mocked(executorOptions.fileChanges.finalize).mockResolvedValue(
      observation,
    );

    const outcome = await new LocalRuntimeTurnExecutor(executorOptions).execute(
      executionInput(),
    );

    expect(outcome).toEqual({
      status: "failed",
      error: expect.anything(),
      committedFacts: {
        fileChangeObservation: {
          fileChange: "no_observed_change",
          observationNotes: ["runtime_failed_without_observed_write"],
        },
      },
    });
    expect(executorOptions.fileChanges.finalize).toHaveBeenCalledWith({
      sessionId: "session-1",
      turnId: "turn-1",
    });
    expect(executorOptions.fileChanges.markFailed).not.toHaveBeenCalled();
  });

  it("finalizes file observations for an aborted terminal before returning the outcome", async () => {
    const executorOptions = options(async (runInput) => {
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.ABORTED),
      );
    });
    vi.mocked(executorOptions.fileChanges.finalize).mockResolvedValue({
      fileChange: "uncertain",
      observationNotes: ["aborted_before_capture_completed"],
    });

    await expect(
      new LocalRuntimeTurnExecutor(executorOptions).execute(executionInput()),
    ).resolves.toEqual({
      status: "aborted",
      reason: `terminal:${RuntimeEventStatus.ABORTED}`,
      committedFacts: {
        fileChangeObservation: {
          fileChange: "uncertain",
          observationNotes: ["aborted_before_capture_completed"],
        },
      },
    });
    expect(executorOptions.fileChanges.markFailed).not.toHaveBeenCalled();
  });

  it("preserves finalize and mark-failed errors in owner-first order", async () => {
    const finalizeError = new Error("file finalize failed");
    const markError = new Error("file failure projection failed");
    const order: string[] = [];
    const executorOptions = options(async (runInput) => {
      order.push("runner");
      await runInput.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    vi.mocked(executorOptions.fileChanges.begin).mockImplementation(
      async () => {
        order.push("file:begin");
      },
    );
    vi.mocked(executorOptions.fileChanges.finalize).mockImplementation(
      async () => {
        order.push("file:finalize");
        throw finalizeError;
      },
    );
    vi.mocked(executorOptions.fileChanges.markFailed).mockImplementation(
      async () => {
        order.push("file:failed");
        throw markError;
      },
    );

    const result = new LocalRuntimeTurnExecutor(executorOptions).execute(
      executionInput(),
    );

    await expect(result).rejects.toMatchObject({
      errors: [finalizeError, markError],
    });
    expect(order).toEqual([
      "file:begin",
      "runner",
      "file:finalize",
      "file:failed",
    ]);
  });
});

describe("LocalRuntimeTurnExecutor host output token cap", () => {
  const VERIFIER_INTENT = {
    kind: "goal-verifier",
    attributes: { runId: "run-1", profile: "goal-verifier-readonly" },
  } as const;

  function verifierExecutionInput(): LocalTurnExecutionInput {
    const base = executionInput();
    return executionInput({
      assemblyContext: { ...base.assemblyContext, turnIntent: VERIFIER_INTENT },
    });
  }

  async function capturedLlm(
    executorOptions: LocalRuntimeTurnExecutorOptions<
      AgentExecutionSnapshot,
      LocalToolContext
    >,
    input: LocalTurnExecutionInput,
  ): Promise<LLMModelConfig> {
    let captured: LLMModelConfig | undefined;
    const runner = new LocalRuntimeTurnExecutor({
      ...executorOptions,
      runtime: {
        runTurn: async (runInput) => {
          captured = runInput.llm as LLMModelConfig;
          await runInput.eventWriter.appendEvents([
            terminalEvent(RuntimeEventStatus.COMPLETED),
          ]);
        },
      },
    });
    await expect(runner.execute(input)).resolves.toEqual({
      status: "completed",
    });
    if (!captured) throw new Error("runTurn was never reached");
    return captured;
  }

  /** Drives the real provider seam so the assertion is on the request, not on a field. */
  async function providerMaxTokens(
    llm: LLMModelConfig,
    callOptions?: { readonly maxTokens: number },
  ): Promise<number | undefined> {
    let observed: number | undefined;
    const composed = composeStreamFn({
      ...llm,
      streamFn: ((
        _model: unknown,
        _context: unknown,
        requestOptions?: { readonly maxTokens?: number },
      ) => {
        observed = requestOptions?.maxTokens;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ value: undefined, done: true }),
          }),
          result: async () => undefined,
        } as never;
      }) as never,
    });
    await composed(
      llm.model as never,
      { messages: [] } as never,
      callOptions as never,
    );
    return observed;
  }

  it("leaves an ordinary turn without a host ceiling", async () => {
    const llm = await capturedLlm(
      options(async () => undefined),
      executionInput(),
    );

    expect(llm).not.toHaveProperty("hostMaxOutputTokens");
    // Nothing is filled in: the request reaches the provider exactly as before,
    // which then applies the model's own cap.
    await expect(providerMaxTokens(llm)).resolves.toBeUndefined();
    await expect(providerMaxTokens(llm, { maxTokens: 500_000 })).resolves.toBe(
      500_000,
    );
  });

  it("binds the resolved cap to the verifier child provider request", async () => {
    const llm = await capturedLlm(
      {
        ...options(async () => undefined),
        outputTokenCap: { resolveOutputTokenCap: () => 1_000 },
      },
      verifierExecutionInput(),
    );

    expect(llm.hostMaxOutputTokens).toBe(1_000);
    await expect(providerMaxTokens(llm)).resolves.toBe(1_000);
    // A later request of the same child cannot widen the settled attempt cap.
    await expect(providerMaxTokens(llm, { maxTokens: 500_000 })).resolves.toBe(
      1_000,
    );
  });

  it("hands the resolver the turn intent it must key on", async () => {
    const resolveOutputTokenCap = vi.fn(() => 1_000);

    await capturedLlm(
      {
        ...options(async () => undefined),
        outputTokenCap: { resolveOutputTokenCap },
      },
      verifierExecutionInput(),
    );

    expect(resolveOutputTokenCap).toHaveBeenCalledWith({
      turnIntent: VERIFIER_INTENT,
    });
  });

  it("leaves a turn the resolver claims no budget for untouched", async () => {
    const llm = await capturedLlm(
      {
        ...options(async () => undefined),
        outputTokenCap: { resolveOutputTokenCap: () => undefined },
      },
      executionInput(),
    );

    expect(llm).not.toHaveProperty("hostMaxOutputTokens");
    await expect(providerMaxTokens(llm)).resolves.toBeUndefined();
  });
});

describe("child Bash continuation ownership", () => {
  it("keeps the child Turn open while awaiting Bash, then injects a notice at the same continuation boundary", async () => {
    const input = executionInput();
    let release!: (value: string | undefined) => void;
    const completion = new Promise<string | undefined>((resolve) => {
      release = resolve;
    });
    const poll = vi.fn(async ({ wait }: { wait: boolean }) =>
      wait ? completion : undefined,
    );
    const close = vi.fn(async () => undefined);
    const createChildBashLifecycle = vi.fn(() => ({
      poll,
      close,
      hasPending: async () => true,
    }));
    const started = vi.fn();
    const config = options(async (run) => {
      expect(await run.getSteeringMessages?.({ boundary: "mid-turn" })).toEqual(
        [],
      );
      started();
      const messages = await run.getSteeringMessages?.({ boundary: "exit" });
      expect(JSON.stringify(messages)).toContain("bash finished");
      expect(run.turnId).toBe(input.lease.turnId);
      await run.eventWriter.pushRuntime(
        terminalEvent(RuntimeEventStatus.COMPLETED),
      );
    });
    const executor = new LocalRuntimeTurnExecutor({
      ...config,
      createChildBashLifecycle,
    });
    const pending = executor.execute({
      ...input,
      session: {
        ...input.session,
        sessionKind: "task",
        sessionType: "branch",
        visibility: "visible",
        parentSessionId: "parent",
      },
    });
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    expect(close).not.toHaveBeenCalled();
    release("bash finished");
    await pending;
    expect(close).toHaveBeenCalledOnce();
    expect(createChildBashLifecycle).toHaveBeenCalledWith({
      session: expect.objectContaining({
        sessionId: input.lease.sessionId,
        sessionKind: "task",
      }),
      turnId: input.lease.turnId,
      signal: input.lease.signal,
    });
  });
  it("cleans up child Bash when runtime execution fails", async () => {
    const input = executionInput();
    const close = vi.fn(async () => undefined);
    const executor = new LocalRuntimeTurnExecutor({
      ...options(async () => {
        throw new Error("provider failed");
      }),
      createChildBashLifecycle: () => ({
        poll: async () => undefined,
        close,
        hasPending: async () => false,
      }),
    });
    await expect(
      executor.execute({
        ...input,
        session: {
          ...input.session,
          sessionKind: "task",
          parentSessionId: "parent",
        },
      }),
    ).rejects.toThrow("provider failed");
    expect(close).toHaveBeenCalledOnce();
  });
  it("does not wait or stop Bash belonging to an ordinary conversation", async () => {
    const createChildBashLifecycle = vi.fn();
    await new LocalRuntimeTurnExecutor({
      ...options(async (run) => {
        await run.getSteeringMessages?.({ boundary: "exit" });
        await run.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      createChildBashLifecycle,
    }).execute(executionInput());
    expect(createChildBashLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ sessionKind: "conversation" }),
      }),
    );
  });
});

describe("child Bash waiting steering", () => {
  it.each([
    ["during-wait", "task-append"],
    ["during-drain", "task-append"],
    ["during-wait", "composer-steer"],
    ["during-drain", "composer-steer"],
  ] as const)(
    "processes %s %s before Bash finishes without closing the child",
    async (arrival, producerId) => {
      const controller = createTurnController({ renew: async () => true });
      const input = executionInput();
      const lease = controller.register({ ...input.lease, busyReason: "turn" });
      const control = controller.scope(lease);
      const append = () =>
        controller.steerActiveTurn({
          sessionId: lease.sessionId,
          turnId: lease.turnId,
          message: {
            producerId,
            idempotencyKey: "stop-bash",
            message: { text: "stop the background server now" },
            genuineUserQueryText: "",
            provenance: {
              source: "communication",
              routingFingerprint: "task-append:stop",
            },
          },
        });
      const originalDrain = control.drainSteering;
      let injectOnDrain = arrival === "during-drain";
      const drainSteering = () => {
        const messages = originalDrain();
        if (injectOnDrain) {
          injectOnDrain = false;
          void append();
        }
        return messages;
      };
      const poll = vi.fn(
        async (request: { wait: boolean; steeringSignal?: AbortSignal }) => {
          if (!request.wait || request.steeringSignal?.aborted)
            return undefined;
          return new Promise<undefined>((resolve) => {
            request.steeringSignal?.addEventListener(
              "abort",
              () => resolve(undefined),
              {
                once: true,
              },
            );
          });
        },
      );
      const close = vi.fn(async () => undefined);
      const consumed = vi.fn(async () => undefined);
      const executor = new LocalRuntimeTurnExecutor({
        ...options(async (run) => {
          const messages = await run.getSteeringMessages?.({
            boundary: "exit",
          });
          expect(JSON.stringify(messages)).toContain(
            "stop the background server now",
          );
          expect(close).not.toHaveBeenCalled();
          expect(lease.signal.aborted).toBe(false);
          await run.eventWriter.pushRuntime(
            terminalEvent(RuntimeEventStatus.COMPLETED),
          );
        }),
        createChildBashLifecycle: () => ({
          poll,
          close,
          hasPending: async () => true,
        }),
        onSteeringConsumed: consumed,
      });
      try {
        const running = executor.execute({
          ...input,
          lease,
          control: { ...control, drainSteering },
        });
        if (arrival === "during-wait") {
          await vi.waitFor(() => expect(poll).toHaveBeenCalled());
          await append();
        }
        await running;
        expect(consumed).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
      } finally {
        controller.complete(lease);
      }
    },
  );
  it("preserves exit requeue for user steering when the child has no pending Bash", async () => {
    const discarded = vi.fn();
    const controller = createTurnController({
      renew: async () => true,
      onSteeringDiscarded: discarded,
    });
    const input = executionInput();
    const lease = controller.register({ ...input.lease, busyReason: "turn" });
    const message = {
      producerId: "composer-steer",
      idempotencyKey: "next-query",
      message: { text: "next instruction" },
      genuineUserQueryText: "next instruction",
      provenance: {
        source: "communication" as const,
        routingFingerprint: "next-query",
      },
    };
    await controller.steerActiveTurn({
      sessionId: lease.sessionId,
      turnId: lease.turnId,
      message,
    });
    const consumed = vi.fn(async () => undefined);
    const executor = new LocalRuntimeTurnExecutor({
      ...options(async (run) => {
        expect(await run.getSteeringMessages?.({ boundary: "exit" })).toEqual(
          [],
        );
        expect(await run.tryBeginClose?.({})).toBe(true);
        await run.eventWriter.pushRuntime(
          terminalEvent(RuntimeEventStatus.COMPLETED),
        );
      }),
      createChildBashLifecycle: () => ({
        hasPending: async () => false,
        poll: async () => undefined,
        close: async () => undefined,
      }),
      onSteeringConsumed: consumed,
    });
    try {
      await executor.execute({
        ...input,
        lease,
        control: controller.scope(lease),
      });
      expect(consumed).not.toHaveBeenCalled();
      expect(discarded).toHaveBeenCalledOnce();
      expect(discarded).toHaveBeenCalledWith(
        expect.objectContaining({ messages: [message] }),
      );
    } finally {
      controller.complete(lease);
    }
  });
});


describe("incremental runtime event outcomes", () => {
  function stream(payload: unknown, id = "stream"): RuntimeEvent {
    return { ...terminalEvent(RuntimeEventStatus.COMPLETED), event_id: id,
      type: RuntimeEventType.STREAM_RESP, payload: { stream_resp: JSON.stringify(payload) } };
  }

  it("preserves final message identity, waiting-for-user and terminal replacement semantics", () => {
    const tracker = createLocalTurnOutcomeTracker();
    tracker.observe(stream({ type: RespDataType.AgentMessageChunk,
      agent_message_chunk: { msg_id: "partial", text: "chunk" } }));
    tracker.observe({ ...terminalEvent(RuntimeEventStatus.FAILED),
      payload: { status: RuntimeEventStatus.FAILED, error: { message: "failure", code: 501 } } });
    expect(tracker.read()).toEqual({ status: "failed", errorMessage: "failure", errorCode: 501, messageId: "partial" });
    tracker.observe(stream({ type: RespDataType.AgentMessageChunk, agent_message_chunk: {
      msg_id: "approved", tool_calls: [{ tool_name: "ask_user", tool_call_status: ToolCallStatus.Finished,
        tool_call_result_data: JSON.stringify({ details: { waiting_for_user: false } }) }] } }));
    expect(tracker.read().waitingForUser).toBeUndefined();
    tracker.observe(stream({ type: RespDataType.AgentMessage, agent_message: {
      msg_id: "approved", tool_calls: [{ tool_name: "ask_user", tool_call_status: ToolCallStatus.Finished }] } }));
    tracker.observe(terminalEvent(RuntimeEventStatus.COMPLETED));
    expect(tracker.read()).toEqual({ status: "completed", messageId: "approved", waitingForUser: true });
    expect(tracker.eventCount).toBe(5);
    expect(tracker.read()).not.toBe(tracker.read());
  });

  it("delivers every projected event without retaining the stream and still observes failed delivery", async () => {
    const delivered: RuntimeEvent[] = [];
    const input = { ...executionInput(), onRuntimeEvent: async (event: RuntimeEvent) => {
      delivered.push(event);
      if (event.event_id === "failed-delivery") throw new Error("delivery failed");
    } };
    const writer = createLocalTurnEventWriter(input, ({ event }) =>
      event.event_id === "filtered" ? undefined : event, { retainEvents: false });
    for (let i = 0; i < 2000; i++) await writer.pushRuntime(stream({ type: RespDataType.AgentMessageChunk,
      agent_message_chunk: { msg_id: `message-${i}`, text: "x".repeat(256) } }, `event-${i}`));
    await writer.pushRuntime(stream({}, "filtered"));
    const failure = { ...terminalEvent(RuntimeEventStatus.ABORTED), event_id: "failed-delivery" };
    await expect(writer.pushRuntime(failure)).rejects.toThrow("delivery failed");
    expect(delivered).toHaveLength(2001);
    expect(delivered.at(-1)).toBe(failure);
    expect(writer.events).toEqual([]);
    expect(writer.outcome?.eventCount).toBe(2001);
    expect(writer.outcome?.read()).toEqual({ status: "aborted",
      errorMessage: `terminal:${RuntimeEventStatus.ABORTED}`, messageId: "message-1999" });
  });

  it("retains the original array and event identities by default", async () => {
    const writer = createLocalTurnEventWriter({ ...executionInput(), onRuntimeEvent: async () => {} });
    const events = writer.events;
    const event = terminalEvent(RuntimeEventStatus.COMPLETED);
    await writer.pushRuntime(event);
    expect(writer.events).toBe(events);
    expect(events).toEqual([event]);
    expect(events[0]).toBe(event);
    expect(writer.outcome).toBeUndefined();
  });

  it.each([false, true])("uses summary mode only when the runtime accepts it (%s)", async (acceptsEventSummary) => {
    const runnerOptions = options(async (input) => {
      await input.eventWriter.pushRuntime(terminalEvent(RuntimeEventStatus.COMPLETED));
      expect(Boolean(input.eventWriter.outcome)).toBe(acceptsEventSummary);
      expect(input.eventWriter.events).toHaveLength(acceptsEventSummary ? 0 : 1);
      return { outcome: { status: "completed" } };
    });
    const executor = new LocalRuntimeTurnExecutor({ ...runnerOptions,
      runtime: { ...runnerOptions.runtime, acceptsEventSummary } });
    await expect(executor.execute(executionInput())).resolves.toEqual({ status: "completed" });
  });
});
