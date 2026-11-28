import {
  SessionKind as DesktopSessionKind,
  SessionInteractionModeView,
  SessionStatusView,
  SessionTypeView,
  type ModelInfoView,
  type ModelThinkingInput,
  type RunLocationView,
  type SessionInfoView,
  type SessionKind as DesktopSessionKindValue,
  type SessionMemoryPolicyView,
  type SessionStatusInfoView,
  type SessionTreeChildView,
} from "./view-contract.js";

import type {
  SessionKind,
  SessionRecord,
} from "../../service/session-system/index.js";
import { advisorSelectionToView } from "./model-provider-advisor.js";
import {
  CURRENT_SESSION_DATA_VERSION,
  effectiveSessionMemoryPolicy,
  isConversationMutationEligibleSession,
} from "../../service/session-system/index.js";

const SESSION_KIND_TO_DESKTOP: Readonly<
  Record<SessionKind, DesktopSessionKindValue>
> = {
  unknown: DesktopSessionKind.Unknown,
  conversation: DesktopSessionKind.Conversation,
  task: DesktopSessionKind.Task,
  peek: DesktopSessionKind.Peek,
  channel: DesktopSessionKind.Channel,
  cron: DesktopSessionKind.Cron,
};

export function toSessionInfoView(session: SessionRecord): SessionInfoView {
  const model = toSessionModelInfoView(session);
  return {
    sessionId: session.sessionId,
    agentName: session.agentName,
    sessionType:
      session.sessionType === "root"
        ? SessionTypeView.Root
        : SessionTypeView.Branch,
    ...(typeof session.title === "string" ? { title: session.title } : {}),
    ...(typeof session.parentSessionId === "string"
      ? { parentSessionId: session.parentSessionId }
      : {}),
    archived: session.archived,
    status: toSessionStatusInfoView(session),
    createdAt: session.createdAtMs,
    updatedAt: session.updatedAtMs,
    workspaceDir: session.workspaceDir,
    frameworkType: session.runtime,
    isDefaultWorkspace: session.isDefaultWorkspace === true,
    visibility: session.visibility ?? "visible",
    sessionKind: SESSION_KIND_TO_DESKTOP[session.sessionKind],
    ...conversationCapabilities(session),
    ...(session.purpose ? { purpose: session.purpose } : {}),
    ...optionalSessionModel(model),
    ...(typeof session.effectiveModel === "string"
      ? { effectiveModel: session.effectiveModel }
      : {}),
    ...(typeof session.effectiveModelVariant === "string"
      ? { effectiveModelVariant: session.effectiveModelVariant }
      : {}),
    ...(session.runLocation
      ? { runLocation: toRunLocationView(session.runLocation) }
      : {}),
    interactionMode: toSessionInteractionModeView(session.interactionMode),
    memoryPolicy: toSessionMemoryPolicyView(session),
    ...(session.advisor ? { advisor: advisorSelectionToView(session.advisor) } : {}),
  };
}

function toSessionMemoryPolicyView(
  session: SessionRecord,
): SessionMemoryPolicyView {
  const policy = effectiveSessionMemoryPolicy(session.memoryPolicy);
  return {
    recallEnabled: policy.recallEnabled,
    writeEnabled: policy.writeEnabled,
    recallLocked: policy.recallLocked,
    ...(policy.recallLockedAtMs === undefined
      ? {}
      : { recallLockedAtMs: policy.recallLockedAtMs }),
  };
}

function toSessionInteractionModeView(
  mode: SessionRecord["interactionMode"],
): SessionInteractionModeView {
  if (mode === "plan") return SessionInteractionModeView.Plan;
  if (mode === "goal") return SessionInteractionModeView.Goal;
  return SessionInteractionModeView.Default;
}

function optionalSessionModel(
  model: ModelInfoView | undefined,
): Pick<SessionInfoView, "model"> {
  return model ? { model } : {};
}

function toSessionModelInfoView(
  session: SessionRecord,
): ModelInfoView | undefined {
  const model = parseEffectiveModel(session.effectiveModel);
  if (!model) return undefined;
  return {
    ...model,
    ...(session.effectiveModelContextWindow != null
      ? { contextLimit: session.effectiveModelContextWindow }
      : {}),
    ...(typeof session.effectiveModelVariant === "string"
      ? { variant: session.effectiveModelVariant }
      : {}),
    ...(typeof session.effectiveModelThinking?.effort === "string" &&
    session.effectiveModelThinking.effort.trim()
      ? { reasoning: true }
      : {}),
    ...(session.effectiveModelThinking
      ? { thinking: toModelThinkingInput(session.effectiveModelThinking) }
      : {}),
  };
}

function parseEffectiveModel(
  effectiveModel: SessionRecord["effectiveModel"],
): Pick<ModelInfoView, "providerId" | "modelId"> | undefined {
  if (typeof effectiveModel !== "string") return undefined;
  const separator = effectiveModel.indexOf("/");
  if (separator <= 0 || separator === effectiveModel.length - 1)
    return undefined;
  return {
    providerId: effectiveModel.slice(0, separator),
    modelId: effectiveModel.slice(separator + 1),
  };
}

function toModelThinkingInput(
  thinking: NonNullable<SessionRecord["effectiveModelThinking"]>,
): ModelThinkingInput {
  return {
    ...(typeof thinking.effort === "string" ? { effort: thinking.effort } : {}),
    ...(typeof thinking.off_behavior === "string"
      ? { offBehavior: thinking.off_behavior }
      : {}),
    ...(thinking.budgets
      ? { budgets: toModelThinkingBudgetsInput(thinking.budgets) }
      : {}),
  };
}

function toModelThinkingBudgetsInput(
  budgets: NonNullable<
    NonNullable<SessionRecord["effectiveModelThinking"]>["budgets"]
  >,
): NonNullable<ModelThinkingInput["budgets"]> {
  const minimal = toThinkingBudget(budgets.minimal);
  const low = toThinkingBudget(budgets.low);
  const medium = toThinkingBudget(budgets.medium);
  const high = toThinkingBudget(budgets.high);
  return {
    ...(minimal !== undefined ? { minimal } : {}),
    ...(low !== undefined ? { low } : {}),
    ...(medium !== undefined ? { medium } : {}),
    ...(high !== undefined ? { high } : {}),
  };
}

function toThinkingBudget(
  value: number | string | undefined,
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function conversationCapabilities(
  session: SessionRecord,
): Partial<SessionInfoView> {
  if (
    !isConversationMutationEligibleSession(
      session,
      CURRENT_SESSION_DATA_VERSION,
    )
  ) {
    return {};
  }
  if (session.interactionMode === "plan") {
    return { conversationCapabilities: { fork: true, rewind: false } };
  }
  return { conversationCapabilities: { fork: true, rewind: true } };
}

export function toSessionTreeChildView(
  session: SessionRecord,
): SessionTreeChildView {
  return {
    sessionId: session.sessionId,
    agentName: session.agentName,
    frameworkType: session.runtime,
    ...(typeof session.title === "string" ? { title: session.title } : {}),
    createdAt: session.createdAtMs,
    updatedAt: session.updatedAtMs,
    archived: session.archived,
    compressed: session.archived,
    status: toSessionStatusInfoView(session),
    sessionKind: SESSION_KIND_TO_DESKTOP[session.sessionKind],
  };
}

function toSessionStatusInfoView(
  session: SessionRecord,
): SessionStatusInfoView {
  return {
    statusType: toSessionStatusType(session.status),
    ...(session.errorMessage ? { message: session.errorMessage } : {}),
    ...(typeof session.errorCode === "number"
      ? { errorCode: session.errorCode }
      : {}),
    ...(session.errorSource ? { errorSource: session.errorSource } : {}),
    ...(session.errorDetail ? { errorDetail: session.errorDetail } : {}),
    ...(session.errorProviderId
      ? { errorProviderId: session.errorProviderId }
      : {}),
  };
}

function toSessionStatusType(
  status: SessionRecord["status"],
): SessionStatusInfoView["statusType"] {
  switch (status) {
    case "started":
      return SessionStatusView.Started;
    case "error":
      return SessionStatusView.Error;
    case "aborted":
    case "interrupted":
      return SessionStatusView.Abort;
    case "idle":
      return SessionStatusView.Idle;
  }
}

function toRunLocationView(
  location: NonNullable<SessionRecord["runLocation"]>,
): RunLocationView {
  return {
    mode: location.mode,
    resolvedDir: location.resolvedDir,
    ...(location.resolvedBranch
      ? { resolvedBranch: location.resolvedBranch }
      : {}),
    ...(location.parentRepoDir
      ? { parentRepoDir: location.parentRepoDir }
      : {}),
    createdAt: location.createdAt,
  };
}
