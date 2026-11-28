import type { SessionRecord } from "../../service/session-system/index.js";

type PresentFields<T> = { [Key in keyof T]: Exclude<T[Key], null> };

// Preserve existing terminal-adapter status values; this module contains no network routing, account, or RPC envelope.
export const SessionTypeView = { Branch: 0, Root: 1 } as const;
export type SessionTypeView =
  (typeof SessionTypeView)[keyof typeof SessionTypeView];
export const SessionStatusView = {
  Idle: 0,
  Started: 1,
  Error: 2,
  Abort: 3,
} as const;
export const SessionInteractionModeView = {
  Default: 0,
  Plan: 1,
  Goal: 2,
} as const;
export type SessionInteractionModeView =
  (typeof SessionInteractionModeView)[keyof typeof SessionInteractionModeView];
export const SessionKind = {
  Unknown: 0,
  Conversation: 1,
  Task: 2,
  Peek: 3,
  Channel: 4,
  Cron: 5,
} as const;
export type SessionKind = (typeof SessionKind)[keyof typeof SessionKind];

export interface ModelThinkingInput {
  effort?: string;
  offBehavior?: string;
  budgets?: Partial<Record<"minimal" | "low" | "medium" | "high", number>>;
}
export interface ModelInfoView {
  providerId: string;
  modelId: string;
  contextLimit?: number;
  variant?: string;
  thinking?: ModelThinkingInput;
}
export type RunLocationView = NonNullable<SessionRecord["runLocation"]>;
export interface SessionMemoryPolicyView {
  recallEnabled: boolean;
  writeEnabled: boolean;
  recallLocked: boolean;
  recallLockedAtMs?: number;
}
export type SessionStatusInfoView = {
  statusType: (typeof SessionStatusView)[keyof typeof SessionStatusView];
  message?: string;
} & PresentFields<
  Pick<
    SessionRecord,
    "errorCode" | "errorSource" | "errorDetail" | "errorProviderId"
  >
>;
export type SessionInfoView = PresentFields<
  Pick<
    SessionRecord,
    | "sessionId"
    | "agentName"
    | "title"
    | "parentSessionId"
    | "archived"
    | "workspaceDir"
    | "purpose"
    | "effectiveModel"
    | "effectiveModelVariant"
  >
> & {
  sessionType: SessionTypeView;
  status: SessionStatusInfoView;
  createdAt: SessionRecord["createdAtMs"];
  updatedAt: SessionRecord["updatedAtMs"];
  frameworkType: SessionRecord["runtime"];
  isDefaultWorkspace: boolean;
  visibility: NonNullable<SessionRecord["visibility"]>;
  sessionKind: SessionKind;
  interactionMode: SessionInteractionModeView;
  memoryPolicy: SessionMemoryPolicyView;
  conversationCapabilities?: { fork: boolean; rewind: boolean };
  model?: ModelInfoView;
  advisor?: import("./model-provider-contracts.js").AdvisorSelectionView;
  runLocation?: RunLocationView;
};
export type SessionTreeChildView = Pick<
  SessionInfoView,
  | "sessionId"
  | "agentName"
  | "frameworkType"
  | "title"
  | "createdAt"
  | "updatedAt"
  | "archived"
  | "status"
  | "sessionKind"
> & { compressed: boolean };
