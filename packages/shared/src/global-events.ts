import type { AskQuestionnaireRequest } from "./questionnaire.js";
import type { SessionLLMRetryEventPayload } from "./llm-retry-event.js";

// Contract admission rules: ./global-events/README.md

export const GLOBAL_EVENT_TYPES = [
  "agent.created",
  "agent.updated",
  "session.created",
  "session.visibility_updated",
  "session.deleted",
  "session.pinned_updated",
  "session.title_updated",
  "session.model_updated",
  "session.interaction_mode.changed",
  "session.start",
  "session.finish",
  "session.error",
  "session.abort",
  "session.queue.updated",
  "session.compaction.started",
  "session.compaction.completed",
  "session.compaction.failed",
  "session.llm_retry",
  "permission.ask",
  "permission.resolved",
  "config.permission_mode.changed",
  "config.browser_use_tooling.changed",
  "questionnaire.ask",
  "questionnaire.dismiss",
  "questionnaire.superseded",
  "message.rewind",
  "turn.prompt_suggestion.generated",
  "turn.prompt_suggestion.status",
  "notification.read",
  "notification.refresh",
  "content.retry.exceeded",
  "rotation.completed",
  "thread_goal.updated",
  "thread_goal.cleared",
  "thread_goal.objective_updated_steering",
  "workspace.git.changed",
] as const satisfies readonly (keyof GlobalEventPayloadMap)[];

export type GlobalEventType = keyof GlobalEventPayloadMap;

export interface CompactionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  incomplete: boolean;
}

/** Correlated event name + payload emitted by backend product-event producers. */
export type GlobalEventInput<Type extends GlobalEventType = GlobalEventType> = {
  [EventType in Type]: {
    type: EventType;
    payload: GlobalEventPayloadMap[EventType];
  };
}[Type];

type SessionStartSource =
  | "queued-drain"
  | "background-task-delivery"
  | "subagent-headless-turn";

type SessionTerminalSource =
  | "background-task-delivery"
  | "subagent-headless-turn";

type SessionTerminalPayload<
  Status extends "finished" | "error" | "aborted" | "interrupted",
> = {
  sessionId: string;
  agentName: string;
  turnId: string;
  status: Status;
  taskId?: string;
  source?: SessionTerminalSource;
  date?: string;
  error?: string;
  errorCode?: number;
  errorSource?: string;
  errorDetail?: string;
  errorProviderId?: string;
};

export type GlobalThreadGoalStatusReason =
  | "complete(worker_proposal)"
  | "complete(verifier_met)"
  | "complete(user_requested)"
  | "paused(user_requested)"
  | "paused(retracted)"
  | "paused(infra_retryable)"
  | "paused(accounting_unavailable)"
  | "paused(verifier_unavailable)"
  | "paused(route_unavailable)"
  | "paused(verifier_timeout)"
  | "paused(verifier_protocol)"
  | "paused(verifier_runtime)"
  | "paused(verifier_budget)"
  | "paused(verifier_capability)"
  | "paused(verifier_aborted)"
  | "paused(no_progress)"
  | "paused(no_progress_after_completion_claim)"
  | "blocked(worker_reported)"
  | "blocked(safety_policy)"
  | "blocked(verifier_impossible)"
  | "budget_limited(token)"
  | "budget_limited(main_turn)"
  | "budget_limited(active_time)"
  | "usage_limited(provider_quota)"
  | "usage_limited(rate_limit)";

/** Why an `active` Goal has not started its next Turn. Mirrors `ThreadGoalWaitReason`. */
export type GlobalThreadGoalWaitReason =
  | "questionnaire"
  | "permission"
  | "plan"
  | "required_background"
  | "automation_owner_conflict"
  | "dependency_unavailable"
  | "verification"
  | "unknown";

export type GlobalThreadGoal = {
  goalId: string;
  sessionId: string;
  objective: string;
  status:
    | "active"
    | "paused"
    | "blocked"
    | "complete"
    | "budget_limited"
    | "usage_limited";
  createdAt: number;
  updatedAt: number;
  tokensUsed: number;
  turnsUsed: number;
  timeUsedSeconds: number;
  tokenBudget: number | null;
  statusReason: GlobalThreadGoalStatusReason | null;
  lastVerification?: {
    backend: "evaluator" | "subagent";
    verdict: "met" | "not_met" | "impossible" | "inconclusive";
    reason: string;
    missing: string[];
    notMetStreak: number;
    at: number;
  };
  hasKickoffAttachments: boolean;
  /**
   * Why an `active` Goal is not running yet; `null`/absent when unblocked.
   * Orthogonal to `status`; follows the local Goal execution state.
   */
  executionWait?: {
    reason: GlobalThreadGoalWaitReason;
    sinceMs: number;
  } | null;
};

/** Closed catalog of product events exchanged between the runtime and its frontends. */
export type GlobalEventPayloadMap = {
  "agent.created": { agentName: string };
  "agent.updated": {
    agentName: string;
    agentId?: string;
    change?: "updated";
  };
  "session.created": {
    sessionId: string;
    agentName: string;
    sessionType: "root" | "branch";
    sessionKind?: string;
    visibility?: "visible" | "hidden";
    title?: string | null;
    parentSessionId?: string | null;
  };
  "session.visibility_updated": {
    sessionId: string;
    agentName?: string;
    visibility: "visible" | "hidden";
  };
  "session.deleted": { sessionId: string; agentName?: string };
  "session.pinned_updated": {
    sessionId: string;
    agentName?: string;
    pinned: boolean;
  };
  "session.title_updated": {
    sessionId: string;
    agentName?: string;
    title: string;
  };
  "session.model_updated": {
    /** Omitted for a committed global-default selection. */
    sessionId?: string;
    agentName?: string;
    providerId: string;
    modelId: string;
    variant?: string | null;
    thinking?: { effort?: string } | null;
    contextLimit?: number | null;
  };
  "session.interaction_mode.changed": {
    sessionId: string;
    interactionMode: "default" | "plan" | "goal";
  };
  "session.start": {
    sessionId: string;
    agentName: string;
    turnId?: string;
    taskId?: string;
    source?: SessionStartSource;
    queueItemIds?: string[];
  };
  "session.finish": SessionTerminalPayload<"finished">;
  "session.error": SessionTerminalPayload<"error">;
  "session.abort": SessionTerminalPayload<"aborted" | "interrupted">;
  "session.queue.updated": {
    sessionId: string;
    itemId?: string;
    status?:
      | "queued"
      | "running"
      | "completed"
      | "failed"
      | "expired"
      | "cancelled"
      | "injected"
      | "accepted"
      | "composer-transferred"
      | "admission-rejected";
    failedReason?: string;
    queuedCount?: number;
    source?: string;
    clientRequestId?: string;
    reason?:
      | "enqueued"
      | "cancelled"
      | "expired"
      | "accepted"
      | "injected"
      | "composer-transferred"
      | "admission-rejected";
    admissionReason?:
      | `policy:${string}`
      | "invalid-session"
      | "unsupported-runtime"
      | "ingress-conflict"
      | "duplicate-ingress";
    /** Optional structured rejection details; not a Session lifecycle error. */
    errorSource?: string;
    error?: string;
  };
  "session.compaction.started": { sessionId: string; compactionId: string };
  "session.compaction.completed": {
    sessionId: string;
    compactionId: string;
    messagesBefore: number;
    messagesAfter: number;
    tokensBefore: number;
    tokensAfter: number;
    tokenUsage?: CompactionTokenUsage;
  };
  "session.compaction.failed": {
    sessionId: string;
    compactionId: string;
    tokenUsage?: CompactionTokenUsage;
  };
  "session.llm_retry": SessionLLMRetryEventPayload;
  "permission.ask": {
    requestId: string;
    sessionId: string;
    /** Turn that produced this ask. Missing only on historical/external events. */
    turnId?: string;
    agentName: string;
    toolName: string;
    ruleContents: string[];
    toolInput?: string;
    toolDescription?: string;
    /** Parent run_code id for a PTC child request. */
    parentToolCallId?: string;
    /** Model-provided outer run_code description, displayed by current Desktop UI. */
    parentToolDescription?: string;
    /** Denial stops only the enclosing PTC program, never the entire Turn. */
    stopPtcOnDeny?: boolean;
    reason: string;
    allowAlwaysSupported: boolean;
    createdAt: number;
  };
  "permission.resolved": {
    requestId: string;
    sessionId: string;
    decision: "allowAlways" | "allowOnce" | "deny";
  };
  "config.permission_mode.changed": {
    permissionMode:
      | "default"
      | "acceptEdits"
      | "bypassPermissions"
      | "auto"
      | "off";
  };
  "config.browser_use_tooling.changed": { browserUseTooling: boolean };
  "questionnaire.ask": {
    requestId: string;
    sessionId: string;
    agentName?: string;
    request: AskQuestionnaireRequest;
  };
  "questionnaire.dismiss": {
    requestId: string;
    sessionId: string;
    agentName?: string;
    status: "answered" | "dismissed";
  };
  "questionnaire.superseded": {
    requestId: string;
    sessionId: string;
    agentName?: string;
    keepRequestId: string;
    supersededAt: number;
  };
  "message.rewind": { sessionId: string; contextReset?: boolean };
  "turn.prompt_suggestion.status": {
    sessionId: string;
    turnId: string;
    status: "generating" | "unavailable" | "cancelled";
  };
  "turn.prompt_suggestion.generated": {
    sessionId: string;
    turnId: string;
    suggestion: string;
    /** Binds this text to the exact prompt that produced it. */
    promptVersion?: string;
    elapsedMs?: number;
    usage?: {
      /** The whole prompt, including any provider-cached prefix. */
      inputTokens?: number;
      outputTokens?: number;
    };
  };
  "notification.read": {
    notification_id: string;
    read_at_ms: number;
  };
  "notification.refresh": {
    scope: "user" | "biz";
    reason:
      | "direct_created"
      | "broadcast_created"
      | "revoked"
      | "mark_all_read";
  };
  "content.retry.exceeded": {
    sessionId: string;
    variant: "content" | "network" | "auth";
    lastUserMsgId?: string;
  };
  "rotation.completed": {
    agentName: string;
    oldSessionId: string;
    newSessionId: string;
    reason: string;
  };
  "thread_goal.updated": { goal: GlobalThreadGoal };
  "thread_goal.cleared": { sessionId: string; goalId: string };
  "thread_goal.objective_updated_steering": {
    sessionId: string;
    goalId: string;
  };
  "workspace.git.changed": {
    /** Canonical realpath owned by the Runtime snapshot manager. */
    workspace: string;
    /** Caller-visible spellings that share the canonical snapshot. */
    aliases?: string[];
    snapshotId: string;
    kind: "workspace" | "repository";
    reason: "watcher" | "watcher-error" | "mutation" | "manual";
  };
};

type AssertNever<Value extends never> = Value;
type GlobalEventCatalogMissingTypeMustBeNever = AssertNever<
  Exclude<GlobalEventType, (typeof GLOBAL_EVENT_TYPES)[number]>
>;

type GlobalEventFor<Type extends GlobalEventType> = {
  type: Type;
  timestamp: number;
  source: "local-runtime";
  payload: GlobalEventPayloadMap[Type];
};

export type GlobalEvent = {
  [Type in GlobalEventType]: GlobalEventFor<Type>;
}[GlobalEventType] &
  ([GlobalEventCatalogMissingTypeMustBeNever] extends [never]
    ? unknown
    : never);

export type DecodedGlobalEventFrame =
  | { kind: "heartbeat"; timestamp: number }
  | { kind: "event"; event: GlobalEvent };

const GLOBAL_EVENT_TYPE_SET: ReadonlySet<string> = new Set(GLOBAL_EVENT_TYPES);

export function isGlobalEventType(value: unknown): value is GlobalEventType {
  return typeof value === "string" && GLOBAL_EVENT_TYPE_SET.has(value);
}

/** Decode the generated Thrift/SSE frame without duplicating every payload schema at runtime. */
export function decodeGlobalEventFrame(
  frame: unknown,
): DecodedGlobalEventFrame | undefined {
  if (!isRecord(frame) || !isTimestamp(frame.timestamp)) return undefined;

  if (frame.kind === "heartbeat") {
    return { kind: "heartbeat", timestamp: frame.timestamp };
  }
  if (
    frame.kind !== "event" ||
    frame.source !== "local-runtime" ||
    !isGlobalEventType(frame.type) ||
    typeof frame.payloadJson !== "string"
  ) {
    return undefined;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(frame.payloadJson);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;

  return {
    kind: "event",
    event: {
      type: frame.type,
      timestamp: frame.timestamp,
      source: "local-runtime",
      payload,
    } as GlobalEvent,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
