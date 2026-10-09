import {
  RuntimeEventStatus,
  RuntimeEventType,
  type RuntimeEvent,
} from "@mavis/agent-core/protocol";
import { createHookExtension, type AgentExtension } from "@mavis/agent-runtime";
import type {
  CreatedLocalRuntimeHost,
  LocalRuntimeApiHost,
} from "@mavis/local-runtime";

import { summarizeCommittedPiGoalUsage } from "../../service/session-system/index.js";
import type {
  AgentEventBestEffortObserver,
  AgentEventContext,
  ProductionAgentProductCapabilities,
} from "../../service/turn-system/index.js";

type HostedAgentCapabilitySource = Pick<
  LocalRuntimeApiHost,
  "createHostedAgentCapabilities"
>;
type HostedEvalReporterFactory = CreatedLocalRuntimeHost["evalReporterFactory"];
type HostedAgentCapabilities = ReturnType<
  LocalRuntimeApiHost["createHostedAgentCapabilities"]
>;
type V1ModelResolver =
  V1AgentHostProductCapabilities["preparation"]["modelResolver"];
type HostedAttachmentCapabilities = ReturnType<
  LocalRuntimeApiHost["createHostedAgentCapabilities"]
>["attachments"];
type HostedWebsiteDeployCapabilities = ReturnType<
  LocalRuntimeApiHost["createHostedAgentCapabilities"]
>["websiteDeploy"];
type HostedWebsiteDeployProjection = ReturnType<
  HostedWebsiteDeployCapabilities["createTurnProjection"]
>;
type HostedChannelCapabilitySource = Pick<
  LocalRuntimeApiHost,
  "createHostedChannelCapabilities"
>;
type HostedChannelFinalReplyInput = Parameters<
  ReturnType<
    LocalRuntimeApiHost["createHostedChannelCapabilities"]
  >["finalReplies"]["deliver"]
>[0];
type HostedChannelTypingInput = Parameters<
  ReturnType<
    LocalRuntimeApiHost["createHostedChannelCapabilities"]
  >["typing"]["start"]
>[0];

interface V1ModelImageCompressionInput {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly budget: {
    readonly maxBytes: number;
    readonly maxEdgePx: number;
  };
}

interface V1CompressedModelImage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

interface V1GeneratedAssetRegistrationInput {
  readonly fileName: string;
  readonly mimeType: string;
  readonly kind: "image";
  readonly sourceKind: "generated";
  readonly dataUrl: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly generatedBy: string;
}

interface V1GeneratedAssetRegistration {
  readonly assetId: string;
  readonly absolutePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: number;
}

/** Temporary neutral local asset/codec bridge; it contains no product policy. */
export interface V1GeneratedAssetInfrastructure {
  readonly compressModelImage: (
    input: V1ModelImageCompressionInput,
  ) => V1CompressedModelImage | undefined;
  readonly registerGeneratedAsset: (
    input: V1GeneratedAssetRegistrationInput,
  ) => Promise<V1GeneratedAssetRegistration>;
}

export interface V1ChannelProductCapabilities {
  readonly finalReplies: {
    deliver(input: HostedChannelFinalReplyInput): Promise<void>;
  };
  readonly typing: {
    start(input: HostedChannelTypingInput): Promise<void>;
    end(input: HostedChannelTypingInput): Promise<void>;
  };
}

export type V1AgentHostProductCapabilities = Omit<
  ProductionAgentProductCapabilities,
  "agents"
>;

export interface V1AttachmentRegistration {
  readonly register: HostedAttachmentCapabilities["register"];
  readonly discard: HostedAttachmentCapabilities["discard"];
  readonly resolveSource: HostedAttachmentCapabilities["resolveSource"];
}

/** Exposes only durable local attachment registration to v2 ingress owners. */
export function createV1AttachmentRegistration(
  source: HostedAgentCapabilitySource,
): V1AttachmentRegistration {
  const attachments = source.createHostedAgentCapabilities().attachments;
  return {
    register: attachments.register,
    discard: attachments.discard,
    resolveSource: attachments.resolveSource,
  };
}

/**
 * Optional model-resolver ports are spread only when the host supplies them.
 * Extracted so the adapter below stays within its complexity budget.
 */
function createV1ModelResolver(
  hosted: HostedAgentCapabilities,
): V1ModelResolver {
  return {
    ...(hosted.authContextGetter
      ? { authContextGetter: hosted.authContextGetter }
      : {}),
    ...(hosted.authContextInvalidator
      ? { authContextInvalidator: hosted.authContextInvalidator }
      : {}),
    ...(hosted.routingContextGetter
      ? { routingContextGetter: hosted.routingContextGetter }
      : {}),
    providerAuthGetter: hosted.providerAuthGetter,
    ...(hosted.fetchImpl ? { fetchImpl: hosted.fetchImpl } : {}),
  };
}

/**
 * The only v1 -> v2 AgentHost adapter. It maps product owners into native
 * composition ports and never exposes the v1 Host to TurnSystem.
 */
export function createV1AgentHostProductCapabilities(
  source: HostedAgentCapabilitySource,
  evalReporterFactory?: HostedEvalReporterFactory,
): V1AgentHostProductCapabilities {
  const hosted = source.createHostedAgentCapabilities();
  const websiteDeploy = createV1WebsiteDeployProjectionAdapter(
    hosted.websiteDeploy,
  );
  const goalTurnLifecycle = createV1ThreadGoalTurnLifecycle(
    hosted.turnLifecycle,
  );
  const goalBudgetGuard = createV1GoalBudgetGuardExtension(
    hosted.turnLifecycle.checkBudget,
    goalTurnLifecycle.observedUsage,
  );
  return {
    preparation: {
      configBuilder: {
        config: hosted.config,
        memory: hosted.memory,
        skills: hosted.skills,
        modelRepairLogger: hosted.runnerLogger,
      },
      modelResolver: createV1ModelResolver(hosted),
    },
    turnRuntimeFacts: hosted.turnRuntimeFacts,
    checkpointState: hosted.checkpointState,
    toolSources: hosted.toolSources,
    inputPreparation: {
      assets: hosted.attachments,
      materializePrompt: hosted.websiteDeploy.materializeSources,
      reminders: {
        buildBackground: hosted.reminders.buildBackground,
        buildSystem: (input) => {
          const model = systemReminderModel(input.agentConfig);
          return hosted.reminders.buildSystem({
            session: input.session,
            resourceAgentName:
              input.agent.resourceAgentName ?? input.agent.agentName,
            promptText: input.promptText,
            turnId: input.turnId,
            deferTelemetry: true,
            ...(input.sessionIdInContext ? { sessionIdInContext: true } : {}),
            ...(model ? { model } : {}),
          });
        },
        confirmBackgroundTaskReads: async (input) => {
          const confirmed =
            await hosted.reminders.confirmBackgroundTaskReads(input);
          return confirmed.flatMap((value) => {
            if (typeof value === "string") return [value];
            const taskId = Reflect.get(Object(value), "taskId");
            return typeof taskId === "string" ? [taskId] : [];
          });
        },
      },
    },
    permission: hosted.permissions,
    terminalMemory: hosted.terminalMemory,
    runner: {
      contextUsage: hosted.contextUsage,
      logger: hosted.runnerLogger,
      ...(hosted.metricsClient ? { metricsClient: hosted.metricsClient } : {}),
      ...(hosted.llmRequestFailureHook
        ? { onLLMRequestFailure: hosted.llmRequestFailureHook }
        : {}),
      ...(hosted.observeLLMRequest
        ? { observeLLMRequest: hosted.observeLLMRequest }
        : {}),
      ...(evalReporterFactory ? { evalReporterFactory } : {}),
    },
    fileApi: {
      ...(hosted.fetchImpl ? { fetchImpl: hosted.fetchImpl } : {}),
      logger: hosted.runnerLogger,
    },
    executor: {
      createChildBashLifecycle: hosted.createChildBashLifecycle,
      fileChanges: {
        begin: hosted.fileChanges.begin,
        finalize: (input) => hosted.fileChanges.finalize(input),
        markFailed: async (input) => {
          await hosted.fileChanges.markFailed(input);
        },
      },
      reportFailure: hosted.reportFailure,
      projectRuntimeEvent: async ({ sessionId, turnId, event }) => {
        const reviewed = hosted.review.projectRuntimeEvent(
          { sessionId, turnId },
          event,
        );
        return reviewed
          ? websiteDeploy.projectRuntimeEvent({
              sessionId,
              turnId,
              event: reviewed,
            })
          : undefined;
      },
    },
    eventObserver: goalTurnLifecycle.observer,
    turnSettlement: goalTurnLifecycle.settlement,
    normalExtensions: [
      websiteDeploy.extension,
      goalBudgetGuard,
      createHookExtension({
        id: "local-builtin-tool-hooks",
        description: "Product-internal tool policies and result handlers.",
        handlers: {
          before_tool_call: (toolContext, _signal, turn) =>
            hosted.hooks.beforeToolCall({
              agentName: turn.agentName,
              sessionId: turn.sessionId,
              turnId: turn.turnId,
              model: modelIdentity(turn.model),
              toolContext,
            }),
          after_tool_call: (toolContext, _signal, turn) =>
            hosted.hooks.afterToolCall({
              agentName: turn.agentName,
              sessionId: turn.sessionId,
              turnId: turn.turnId,
              toolContext,
            }),
        },
      }),
      createHostedReviewExtension(hosted.review),
    ],
  };
}

function createV1GoalBudgetGuardExtension(
  checkBudget: V1ThreadGoalTurnLifecycle["checkBudget"],
  observedUsage: (input: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => {
    readonly tokens: number;
  },
): AgentExtension {
  return {
    id: "local-v1-goal-budget-guard",
    description:
      "Stop new tools when the admitted Goal execution budget is exhausted.",
    init(pi) {
      pi.on("before_tool_call", async (_input, _signal, turn) => {
        let decision;
        try {
          decision = await checkBudget({
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            observedTokens: observedUsage(turn).tokens,
          });
        } catch {
          return {
            block: true,
            reason:
              "GOAL_BUDGET_CHECK_UNAVAILABLE: Tool execution is disabled because the Goal budget check failed closed.",
          };
        }
        if (decision.decision === "allow") return undefined;
        return { block: true, reason: decision.message };
      });
    },
  };
}

function createV1WebsiteDeployProjectionAdapter(
  capability: HostedWebsiteDeployCapabilities,
) {
  const projections = new Map<string, HostedWebsiteDeployProjection>();
  const projectionFor = (
    sessionId: string,
    turnId: string,
  ): HostedWebsiteDeployProjection => {
    const key = turnKey({ sessionId, turnId });
    const existing = projections.get(key);
    if (existing) return existing;
    const created = capability.createTurnProjection();
    projections.set(key, created);
    return created;
  };
  return {
    projectRuntimeEvent: (input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly event: Parameters<
        HostedWebsiteDeployProjection["projectRuntimeEvent"]
      >[0];
    }) =>
      projectionFor(input.sessionId, input.turnId).projectRuntimeEvent(
        input.event,
      ),
    extension: {
      id: "local-v1-website-deploy-projection",
      description:
        "Project local website deploy output through the v2 turn owner.",
      init(pi) {
        pi.on("after_tool_call", (input, _signal, turn) =>
          projectionFor(turn.sessionId, turn.turnId).afterToolCallHook(input),
        );
        pi.on("after_llm_call", (input, turn) =>
          projectionFor(turn.sessionId, turn.turnId).afterLlmCallHook(input),
        );
        pi.on("turn_end", (_event, turn) => {
          projections.delete(turnKey(turn));
        });
      },
    } satisfies AgentExtension,
  } as const;
}

function createHostedReviewExtension(
  review: ReturnType<
    LocalRuntimeApiHost["createHostedAgentCapabilities"]
  >["review"],
): AgentExtension {
  return {
    id: "local-code-review",
    description:
      "Activate and validate the local structured code review workflow.",
    init(pi) {
      pi.contributeUserPromptPrefix((turn) =>
        review.buildUserPromptPrefix({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          agentName: turn.agentName,
          workspaceDir: turn.workspaceDir,
          userInput: turn.userInput.text,
          ...(turn.promptRead ? { promptRead: turn.promptRead } : {}),
          ...(turn.turnIntent ? { intent: turn.turnIntent } : {}),
        }),
      );
      pi.on("before_llm_call", (input, turn) =>
        review.beforeLlmCall(input, {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
        }),
      );
      pi.on("after_llm_call", (input, turn) =>
        review.afterLlmCall(
          input,
          { sessionId: turn.sessionId, turnId: turn.turnId },
          modelIdentity(turn.model),
        ),
      );
      pi.on("before_tool_call", (input, signal, turn) =>
        review.beforeToolCall(input, signal, {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
        }),
      );
      pi.on("turn_end", (_event, turn) => {
        review.endTurn({ sessionId: turn.sessionId, turnId: turn.turnId });
      });
    },
  };
}

interface V1ThreadGoalTurnLifecycle {
  started(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly source?: string;
  }): void;
  checkBudget: ReturnType<
    LocalRuntimeApiHost["createHostedAgentCapabilities"]
  >["turnLifecycle"]["checkBudget"];
  classifyFailure: ReturnType<
    LocalRuntimeApiHost["createHostedAgentCapabilities"]
  >["turnLifecycle"]["classifyFailure"];
  settled(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly status: "completed" | "failed" | "aborted";
    readonly tokens: number;
    readonly retracted: boolean;
    readonly usageIncomplete?: boolean;
    readonly failureClass?: V1ThreadGoalFailureClass;
    readonly finalAssistantText?: string;
    readonly workerModelKey?: string;
    readonly workSignals?: { readonly toolCalls: number };
  }): Promise<void>;
  abandoned(input: {
    readonly sessionId: string;
    readonly turnId: string;
  }): void;
}

type V1ThreadGoalFailureClass = ReturnType<
  V1ThreadGoalTurnLifecycle["classifyFailure"]
>;

interface ObservedTurn {
  tokens: number;
  retracted: boolean;
  started: boolean;
  usageIncomplete: boolean;
  /** True once at least one committed message delta was observed for this Turn. */
  historyObserved: boolean;
  /** Tool calls committed by this Turn; only trustworthy when `historyObserved`. */
  toolCalls: number;
  failureClass?: V1ThreadGoalFailureClass;
  finalAssistantText?: string;
  workerModelKey?: string;
}

function createV1ThreadGoalTurnLifecycle(
  lifecycle: V1ThreadGoalTurnLifecycle,
): {
  readonly observer: AgentEventBestEffortObserver;
  readonly observedUsage: (input: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => {
    readonly tokens: number;
    readonly usageIncomplete: boolean;
  };
  readonly settlement: {
    settle(input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly status: "completed" | "failed" | "aborted";
    }): Promise<void>;
    abandon(input: {
      readonly sessionId: string;
      readonly turnId: string;
    }): Promise<void>;
  };
} {
  const turns = new Map<string, ObservedTurn>();
  const state = (
    context: Pick<AgentEventContext, "sessionId" | "turnId" | "executionModel">,
  ): ObservedTurn => {
    const key = turnKey(context);
    const existing = turns.get(key);
    if (existing) {
      const workerModelKey = context.executionModel
        ? modelIdentity(context.executionModel)
        : undefined;
      if (workerModelKey) existing.workerModelKey = workerModelKey;
      return existing;
    }
    const created: ObservedTurn = {
      tokens: 0,
      retracted: false,
      started: false,
      usageIncomplete: false,
      historyObserved: false,
      toolCalls: 0,
    };
    const workerModelKey = context.executionModel
      ? modelIdentity(context.executionModel)
      : undefined;
    if (workerModelKey) Object.assign(created, { workerModelKey });
    turns.set(key, created);
    return created;
  };
  const ensureStarted = (
    context: Pick<AgentEventContext, "sessionId" | "turnId" | "provenance">,
    observed: ObservedTurn,
  ): void => {
    if (observed.started) return;
    observed.started = true;
    lifecycle.started({
      sessionId: context.sessionId,
      turnId: context.turnId,
      ...(context.provenance?.source
        ? { source: context.provenance.source }
        : {}),
    });
  };
  const observer: AgentEventBestEffortObserver = {
    observeHistoryCommitted: ({ context, change }) => {
      const observed = state(context);
      if (change.reason === "messageDelta") {
        const usage = summarizeCommittedPiGoalUsage(change.messages);
        observed.tokens += usage.tokens;
        observed.usageIncomplete ||= usage.incomplete;
        observed.historyObserved = true;
        observed.toolCalls += countCommittedToolCalls(change.messages);
        const finalAssistant = readLastAssistantText(change.messages);
        if (finalAssistant.seen) {
          if (finalAssistant.text === undefined)
            delete observed.finalAssistantText;
          else observed.finalAssistantText = finalAssistant.text;
        }
      }
      if (
        change.operation.kind === "output-recall" ||
        change.operation.kind === "turn-retraction"
      ) {
        observed.retracted = true;
      }
    },
    observeRuntimeEvent: ({ context, event }) => {
      const status = observedRuntimeStatus(event);
      if (!status) return;
      const observed = state(context);
      ensureStarted(context, observed);
      if (status === "failed") {
        observed.failureClass = preferFailureClass(
          observed.failureClass,
          lifecycle.classifyFailure(event.payload.error),
        );
      }
    },
  };
  return {
    observer,
    observedUsage: (input) => {
      const observed = turns.get(turnKey(input));
      return {
        tokens: observed?.tokens ?? 0,
        usageIncomplete: observed?.usageIncomplete ?? false,
      };
    },
    settlement: {
      settle: async (input) => {
        const observed = state(input);
        ensureStarted(input, observed);
        await lifecycle.settled({
          ...input,
          tokens: observed.tokens,
          retracted: observed.retracted,
          ...(observed.usageIncomplete ? { usageIncomplete: true } : {}),
          ...(input.status === "failed"
            ? { failureClass: observed.failureClass ?? "unknown" }
            : {}),
          ...(observed.finalAssistantText !== undefined
            ? { finalAssistantText: observed.finalAssistantText }
            : {}),
          ...(observed.workerModelKey
            ? { workerModelKey: observed.workerModelKey }
            : {}),
          // Only report work signals backed by an actual history observation.
          // An omitted field means "unknown" downstream; a fabricated zero
          // would let the Goal no-tool breaker count an observation gap.
          ...(observed.historyObserved
            ? { workSignals: { toolCalls: observed.toolCalls } }
            : {}),
        });
        turns.delete(turnKey(input));
      },
      abandon: async (input) => {
        // TurnSystem is out of settle retries, so the Goal decision for this
        // Turn is never happening. Drop the observation and let the host
        // release the Turn-scoped timing it froze for settlement.
        turns.delete(turnKey(input));
        lifecycle.abandoned(input);
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Count committed tool calls produced by this Turn.
 *
 * Pi-agent assistant messages carry tool calls as `toolCall` content blocks
 * (`AssistantMessage['content'][number].type`), which is the same durable shape
 * the history projection and compaction paths read. Only committed assistant
 * messages are counted, so an in-flight or discarded call never inflates it.
 */
function countCommittedToolCalls(messages: readonly unknown[]): number {
  let count = 0;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isRecord(block) && block.type === "toolCall") count += 1;
    }
  }
  return count;
}

function readLastAssistantText(messages: readonly unknown[]): {
  readonly seen: boolean;
  readonly text?: string;
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message))
      continue;
    if (Reflect.get(message, "role") !== "assistant") continue;
    const content = Reflect.get(message, "content");
    if (!Array.isArray(content)) return { seen: true };
    const text = content
      .flatMap((block) => {
        if (!block || typeof block !== "object" || Array.isArray(block))
          return [];
        return Reflect.get(block, "type") === "text" &&
          typeof Reflect.get(block, "text") === "string"
          ? [Reflect.get(block, "text") as string]
          : [];
      })
      .join("");
    return text.length > 0 ? { seen: true, text } : { seen: true };
  }
  return { seen: false };
}

function preferFailureClass(
  current: V1ThreadGoalFailureClass | undefined,
  next: V1ThreadGoalFailureClass,
): V1ThreadGoalFailureClass {
  const rank: Record<V1ThreadGoalFailureClass, number> = {
    unknown: 0,
    infra_retryable: 1,
    rate_limit: 2,
    provider_quota: 3,
    safety: 4,
  };
  return current !== undefined && rank[current] >= rank[next] ? current : next;
}

function observedRuntimeStatus(
  event: RuntimeEvent,
): "running" | "completed" | "failed" | "aborted" | undefined {
  if (
    event.type !== RuntimeEventType.SESSION_STATUS &&
    event.type !== RuntimeEventType.TURN_TERMINAL
  ) {
    return undefined;
  }
  if (event.payload.status === RuntimeEventStatus.RUNNING) return "running";
  if (event.payload.status === RuntimeEventStatus.COMPLETED) return "completed";
  if (event.payload.status === RuntimeEventStatus.FAILED) return "failed";
  return event.payload.status === RuntimeEventStatus.ABORTED
    ? "aborted"
    : undefined;
}

function turnKey(
  context: Pick<AgentEventContext, "sessionId" | "turnId">,
): string {
  return `${context.sessionId}\0${context.turnId}`;
}

/**
 * Temporary v1 product transport for the v2 ChannelSystem owner. Inbound
 * Channel orchestration can migrate behind the same owner without entering
 * TurnSystem or SessionSystem.
 */
export function createV1ChannelProductCapabilities(
  source: HostedChannelCapabilitySource,
): V1ChannelProductCapabilities {
  const channel = source.createHostedChannelCapabilities();
  return {
    finalReplies: {
      deliver: async (input) => {
        await channel.finalReplies.deliver(input);
      },
    },
    typing: {
      start: async (input) => {
        await channel.typing.start(input);
      },
      end: async (input) => {
        await channel.typing.end(input);
      },
    },
  };
}

function modelIdentity(
  model: Readonly<Record<string, unknown>>,
): string | undefined {
  const provider =
    typeof model.provider === "string" ? model.provider : undefined;
  const id = readModelId(model);
  return provider && id ? `${provider}/${id}` : id;
}

function readModelId(
  model: Readonly<Record<string, unknown>>,
): string | undefined {
  if (typeof model.model_id === "string") return model.model_id;
  return typeof model.id === "string" ? model.id : undefined;
}

function systemReminderModel(agentConfig: Readonly<Record<string, unknown>>):
  | {
      providerID: string;
      modelID: string;
      variant?: string;
    }
  | undefined {
  const raw = agentConfig.model;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const model = raw as Readonly<Record<string, unknown>>;
  const providerID =
    typeof model.provider === "string" ? model.provider : undefined;
  const modelID = readModelId(model);
  if (!providerID || !modelID) return undefined;
  return {
    providerID,
    modelID,
    ...(typeof model.variant === "string" && model.variant
      ? { variant: model.variant }
      : {}),
  };
}
