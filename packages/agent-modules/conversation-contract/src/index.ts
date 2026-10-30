export type ConversationSource =
  | "api"
  | "cron"
  | "task"
  | "background-task"
  | "team"
  | "thread-goal"
  | "questionnaire"
  | "communication"
  | "code_review"
  | "greeting"
  | "channel:wechat"
  | "channel:feishu"
  | "channel:telegram";

export type ConversationSessionKind =
  | "conversation"
  | "task"
  | "peek"
  | "channel"
  | "cron"
  | "unknown";

export type ConversationSessionStatus =
  | "idle"
  | "started"
  | "error"
  | "aborted"
  | "interrupted";

/**
 * Durable line marker written only after a historical Agent root is verified
 * against an adopted IM credential route. It lets Project queries surface the
 * one trusted legacy root without treating every Agent root as a project task.
 */
export const TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER =
  "[mavis:trusted-legacy-im-root]";

/** A user-selected model thinking configuration persisted with one Conversation. */
export interface ConversationModelThinkingSelection {
  readonly effort?: string;
  readonly off_behavior?: string;
  readonly budgets?: ConversationModelThinkingBudgets;
}

export interface ConversationModelThinkingBudgets {
  readonly minimal?: number | string;
  readonly low?: number | string;
  readonly medium?: number | string;
  readonly high?: number | string;
}

/** Sparse Task-owned overrides resolved with the target Agent and parent Session model groups. */
export interface ConversationTaskModelSelection {
  readonly model?: string;
  readonly effort?: string;
}

/** Prevent an empty Task override from changing the Runtime default selection semantics. */
export function hasConversationTaskModelSelection(
  selection: ConversationTaskModelSelection | undefined,
): selection is ConversationTaskModelSelection {
  return selection?.model !== undefined || selection?.effort !== undefined;
}

export const SESSION_TITLE_MAX_UNICODE_LENGTH = 50;

/** Normalizes user-supplied Session titles to the same boundary as generated titles. */
export function normalizeConversationSessionTitle(
  input: string | null | undefined,
): string | undefined {
  if (typeof input !== "string") return undefined;
  const title = input.replace(/\s+/gu, " ").trim();
  return title && Array.from(title).length <= SESSION_TITLE_MAX_UNICODE_LENGTH
    ? title
    : undefined;
}

export interface ConversationRunLocation {
  readonly mode: "current" | "new-worktree" | "existing-worktree";
  readonly resolvedDir: string;
  readonly resolvedBranch?: string;
  readonly parentRepoDir?: string;
  readonly createdAt: number;
}

export interface ConversationSession {
  readonly sessionId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly runtime: "pi-agent" | "opencode";
  readonly sessionType: "root" | "branch";
  readonly sessionKind: ConversationSessionKind;
  readonly archived: boolean;
  readonly status: ConversationSessionStatus;
  readonly isDefaultWorkspace?: boolean;
  readonly title?: string | null;
  readonly parentSessionId?: string | null;
  readonly visibility?: "visible" | "hidden";
  readonly purpose?: string;
  readonly originCronId?: string;
  readonly runLocation?: ConversationRunLocation;
  readonly appMode?: "coding" | "work";
  readonly errorMessage?: string;
  readonly errorCode?: number;
  readonly errorSource?: string;
  readonly errorDetail?: string;
  readonly errorProviderId?: string;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
  readonly scratchpadPath?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ConversationSessionListOptions {
  readonly agentName?: string;
  readonly originCronId?: string;
  readonly parentSessionId?: string | null;
  readonly archived?: boolean;
  readonly includeHidden?: boolean;
  readonly includeSessionKinds?: readonly ConversationSessionKind[];
  readonly excludeSessionKinds?: readonly ConversationSessionKind[];
  readonly includePurposePrefix?: string;
  readonly excludePurposePrefix?: string;
  readonly sessionType?: "root" | "branch";
  readonly search?: string;
  readonly cursor?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly scanLimit?: number;
}

export interface ConversationSessionCreateInput {
  readonly agentName: string;
  readonly workspaceDir?: string;
  readonly sessionType?: "root" | "branch";
  readonly sessionKind?: ConversationSessionKind;
  readonly title?: string | null;
  readonly parentSessionId?: string | null;
  readonly visibility?: "visible" | "hidden";
  readonly purpose?: string;
  readonly originCronId?: string;
  readonly runLocation?: ConversationRunLocation;
  readonly appMode?: "coding" | "work";
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
  /** Explicit sparse Task model request resolved atomically with the frozen Task Agent binding. */
  readonly taskModelSelection?: ConversationTaskModelSelection;
  readonly isDefaultWorkspace?: boolean;
  readonly origin?: "user" | "root-repair";
  /**
   * Trusted Task-only Plugin Agent copied from the parent Turn's capability
   * lease. Request mappers never populate it; the Task host is the only writer.
   */
  readonly pluginAgentDefinition?: ConversationPluginAgentDefinition;
}

/**
 * LOCAL Plugin subagent frozen with one Turn capability generation. Selectors
 * use the Custom Agent encoding: `undefined` inherits, `[]` explicitly disables.
 */
export interface ConversationPluginAgentDefinition {
  /** Task target `<plugin>:<agent>`. */
  readonly scopedName: string;
  readonly pluginName: string;
  readonly agentName: string;
  readonly sourceFormat: 'minimax' | '\u0063\u006c\u0061\u0075\u0064\u0065';
  readonly packageDigest: string;
  readonly pluginRoot: string;
  readonly description: string;
  readonly displayName?: string;
  /** Markdown body before Plugin path placeholders are expanded. */
  readonly systemPrompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
  readonly extensionSkills?: readonly string[];
  /** MCP server names this Plugin package declares, whether or not they published tools. */
  readonly declaredMcpServers?: readonly string[];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export interface ConversationSessionUpdate {
  readonly title?: string | null;
  readonly visibility?: "visible" | "hidden";
  readonly purpose?: string;
  readonly workspaceDir?: string;
  readonly isDefaultWorkspace?: boolean;
  readonly sessionType?: "root" | "branch";
  readonly parentSessionId?: string | null;
  readonly archived?: boolean;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
}

export interface ConversationRootReplacement {
  readonly nextRoot: ConversationSession;
  readonly previousRoots: readonly ConversationSession[];
  readonly archivedRootTitle: string;
  readonly fallbackName: string;
}

export interface ConversationSessionQuery {
  getSession(sessionId: string): Promise<ConversationSession | undefined>;
  listSessions(
    options?: ConversationSessionListOptions,
  ): Promise<ConversationSession[]>;
  listMessages(
    sessionId: string,
    options?: { readonly limit?: number; readonly before?: string },
  ): Promise<{
    readonly messages: readonly ConversationCommittedMessage[];
    readonly nextCursor?: string;
    readonly hasMore: boolean;
  }>;
}

export interface ConversationSessionLifecycle {
  createSession(
    input: ConversationSessionCreateInput,
  ): Promise<ConversationSession>;
  createRootSession(input: {
    readonly agentName: string;
    readonly workspaceDir?: string;
  }): Promise<ConversationSession>;
  replaceRootSession(
    agentName: string,
    sessionId: string,
  ): Promise<ConversationRootReplacement>;
  updateSession(
    sessionId: string,
    fields: ConversationSessionUpdate,
  ): Promise<ConversationSession>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface ConversationAttachment {
  readonly type?: string;
  readonly filePath?: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly dataUrl?: string;
  readonly assetId?: string;
  readonly error?: string;
}

export interface ConversationChannelContext {
  readonly platform: string;
  readonly chatType: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly clientName: string;
  readonly threadId?: string;
  readonly sourceMessageId?: string;
  readonly contextToken?: string;
  readonly channel?: string;
  readonly channel_id?: string;
}

export interface ConversationModelSelection {
  readonly reasoning?: boolean;
  readonly contextLimit?: number;
  readonly thinking?: ConversationModelThinkingSelection;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly variant?: string;
}

export interface ConversationMessageInput {
  readonly content: string;
  readonly attachments?: readonly ConversationAttachment[];
  readonly hideUserMessage?: boolean;
  readonly displayContent?: string;
  readonly origin?: unknown;
  readonly channelContext?: ConversationChannelContext;
  readonly quotedMessage?: {
    readonly text: string;
    readonly senderName?: string;
  };
  readonly model?: ConversationModelSelection;
}

export type ConversationToolCallStatus = 1 | 2 | 3;

export interface ConversationToolCall {
  readonly tool_name: string;
  readonly tool_call_id: string;
  readonly tool_call_status: ConversationToolCallStatus;
  readonly tool_call_args?: string;
  readonly tool_call_result_data?: string;
  readonly tool_call_duration_ms?: number;
  /** Optional outer run_code ToolCall id for a PTC child invocation. */
  readonly parent_tool_call_id?: string;
}

export interface ConversationCommittedMessage {
  readonly msgId?: string;
  readonly role?: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly toolCalls?: readonly ConversationToolCall[];
  readonly kind?: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/**
 * Facts observed while settling one turn. These are deliberately neutral
 * conversation facts: they describe what the runtime recorded, but do not
 * claim that the observation is a filesystem security guarantee.
 */
export type ConversationFileChangeObservation =
  | "no_observed_change"
  | "change_observed"
  | "uncertain"
  | "recording_failed";

export interface TurnFileChangeObservation {
  readonly fileChange: ConversationFileChangeObservation;
  readonly changedFiles?: readonly string[];
  readonly observationNotes: readonly string[];
}

export interface TurnCommittedFacts {
  readonly fileChangeObservation?: TurnFileChangeObservation;
}

export interface ConversationTurnResult {
  readonly turnId: string;
  readonly status: "completed" | "aborted" | "failed";
  readonly messages: readonly ConversationCommittedMessage[];
  readonly workspaceDir?: string;
  readonly error?: string;
  readonly committedFacts?: TurnCommittedFacts;
}

export interface ConversationAcceptedTurn {
  readonly turnId: string;
  readonly mode: "started" | "queued";
  readonly queue?: {
    readonly itemId: string;
    readonly position: number;
    readonly ahead: number;
  };
  readonly completion: Promise<ConversationTurnResult>;
}

export type ConversationTurnRejectionReason =
  | "invalid-session"
  | "active-turn"
  | "compaction-active"
  | "session-deleting"
  | "session-mutating"
  | "priority-blocked"
  | "ingress-conflict"
  | `policy:${string}`
  | "duplicate"
  | "invalid-input"
  | "active-model-override-unsupported"
  | "delivery-closed";

export class ConversationTurnRejectedError extends Error {
  readonly code = "CONVERSATION_TURN_REJECTED";

  constructor(
    readonly sessionId: string,
    readonly reason: ConversationTurnRejectionReason,
  ) {
    super(`Conversation Turn was rejected for ${sessionId}: ${reason}`);
    this.name = "ConversationTurnRejectedError";
  }
}

export type ConversationDisplaySource =
  | ConversationSource
  | "cron-report"
  | (string & { readonly __conversationDisplaySourceBrand?: never });

export interface ConversationDisplayProvenance {
  readonly source?: ConversationDisplaySource;
  readonly origin?: unknown;
}

export interface ConversationSubmitInput {
  readonly sessionId: string;
  readonly source: ConversationSource;
  readonly message: ConversationMessageInput;
  readonly allowQueue: boolean;
  /** Internal control-plane continuation that must precede already queued ordinary input. */
  readonly queuePlacement?: "front";
  readonly clientRequestId?: string;
  readonly requestedTurnId?: string;
  readonly dedupeKey?: string;
  readonly expiresAt?: number;
}

/**
 * Resumes a persisted user-input wait. This is a narrow internal admission
 * seam: it never joins the ordinary Queue, and requestId is its durable replay
 * identity.
 */
export interface ConversationResumeUserInput {
  readonly sessionId: string;
  readonly source: "questionnaire";
  readonly requestId: string;
  /** Product owner whose suspended Turn this persisted reply continues. */
  readonly owner?: UserInputResumeOwner;
  /** Server-owned Turn identity for a Runtime-owned continuation such as Plan. */
  readonly requestedTurnId?: string;
  readonly message: ConversationMessageInput;
}

export interface UserInputResumeOwner {
  readonly kind: "thread-goal";
  readonly goalId: string;
}

export interface ConversationResumeUserInputResult {
  readonly turnId: string;
  readonly mode: "started" | "duplicate";
}

export interface ConversationSteerInput {
  readonly sessionId: string;
  readonly source: ConversationSource;
  readonly message: ConversationMessageInput;
  readonly producerId: string;
  readonly idempotencyKey: string;
  readonly requestedTurnId?: string;
  /**
   * Internal, opt-in admission hook for a producer that must verify the exact
   * Turn before its content is handed to the runtime. Ordinary steering does
   * not provide this hook and keeps its existing semantics.
   */
  readonly preDelivery?: ConversationSteerPreDelivery;
  /**
   * Internal per-item receipt ids that the runtime durably binds to the exact
   * Turn admitting this steer, in the same write as the producer receipt. A
   * batching producer uses them to answer which Turn carried each item.
   */
  readonly receiptAliases?: readonly string[];
}

export interface ConversationSteerPreDelivery {
  accept(input: {
    readonly mode: "activated" | "steered";
    readonly turnId: string;
  }): void | Promise<void>;
}

/**
 * `activated` means the steer had no Turn to join and started one instead, so
 * it owns a completion just like `submit`. `steered` and `duplicate` join an
 * existing Turn owned by another producer and only carry the admission ACK.
 */
export type ConversationSteerResult =
  | {
      readonly turnId: string;
      readonly mode: "steered" | "duplicate";
    }
  | {
      readonly turnId: string;
      readonly mode: "activated";
      readonly completion: Promise<ConversationTurnResult>;
    };

export interface ConversationQueuedItem {
  readonly itemId: string;
  readonly sessionId: string;
  readonly agentName: string;
  readonly source: ConversationSource;
  readonly status: "queued" | "claimed";
  readonly message: ConversationMessageInput;
  readonly createdAt: number;
  readonly clientRequestId?: string;
  readonly dedupeKey?: string;
  readonly expiresAt?: number;
}

export interface ConversationQueueUpdate {
  readonly message?: ConversationMessageInput;
  readonly model?: ConversationModelSelection | null;
  readonly expiresAt?: number;
}

export interface ConversationIngress {
  submit(input: ConversationSubmitInput): Promise<ConversationAcceptedTurn>;
  resumeUserInput(
    input: ConversationResumeUserInput,
  ): Promise<ConversationResumeUserInputResult>;
  steer(input: ConversationSteerInput): Promise<ConversationSteerResult>;
  listQueued(sessionId: string): Promise<ConversationQueuedItem[]>;
  /**
   * Exact idempotency lookup. Unlike listQueued(), this includes an item that
   * is currently claimed so a producer does not mistake in-flight work for
   * completed work.
   */
  findQueuedByClientRequestId(
    sessionId: string,
    clientRequestId: string,
  ): Promise<ConversationQueuedItem | undefined>;
  updateQueued(
    sessionId: string,
    itemId: string,
    update: ConversationQueueUpdate,
  ): Promise<ConversationQueuedItem | "not_editable" | undefined>;
  promoteQueuedSource(
    sessionId: string,
    itemId: string,
    source: ConversationSource,
  ): Promise<ConversationQueuedItem | "not_editable" | undefined>;
  cancelQueued(
    sessionId: string,
    itemId: string,
  ): Promise<ConversationQueuedItem | "not_editable" | undefined>;
  reorderQueued(
    sessionId: string,
    itemIds: readonly string[],
  ): Promise<ConversationQueuedItem[]>;
  abort(sessionId: string, reason?: string, turnId?: string): Promise<boolean>;
  dispatchQueue(sessionId: string): Promise<void>;
}

export interface ConversationCompactionInput {
  readonly sessionId: string;
  readonly agentName: string;
  readonly customInstructions?: string;
  readonly reason?: string;
  readonly onStarted?: () => Promise<void>;
}

export interface ConversationCompactionOutcome {
  readonly success: boolean;
  readonly code: string;
  readonly status: number;
  readonly sessionId?: string;
  readonly compactionId?: string;
  readonly messagesBefore?: number;
  readonly messagesAfter?: number;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly error?: string;
}

export interface ConversationMaintenance {
  compact(
    input: ConversationCompactionInput,
  ): Promise<ConversationCompactionOutcome>;
}

export interface RuntimeConversation {
  readonly query: ConversationSessionQuery;
  readonly lifecycle: ConversationSessionLifecycle;
  readonly ingress: ConversationIngress;
  readonly maintenance: ConversationMaintenance;
}

export interface RuntimeConversationChannelView {
  readonly query: Pick<ConversationSessionQuery, "getSession" | "listSessions">;
  readonly lifecycle: Pick<
    ConversationSessionLifecycle,
    "createSession" | "createRootSession" | "deleteSession"
  >;
  readonly ingress: Pick<
    ConversationIngress,
    "submit" | "abort" | "dispatchQueue"
  >;
  readonly maintenance: Pick<ConversationMaintenance, "compact">;
}

export const RUNTIME_CONVERSATION_UNAVAILABLE_CODE =
  "RUNTIME_CONVERSATION_UNAVAILABLE";
export const RUNTIME_CONVERSATION_SHUTDOWN_CODE =
  "RUNTIME_CONVERSATION_SHUTDOWN";

export class RuntimeConversationUnavailableError extends Error {
  readonly code = RUNTIME_CONVERSATION_UNAVAILABLE_CODE;
  readonly originalError?: unknown;

  constructor(
    message = "Runtime conversation is unavailable.",
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = "RuntimeConversationUnavailableError";
    if (options && "cause" in options) this.originalError = options.cause;
  }
}

export class RuntimeConversationShutdownError extends Error {
  readonly code = RUNTIME_CONVERSATION_SHUTDOWN_CODE;
  readonly originalError?: unknown;

  constructor(
    message = "Runtime conversation is shutting down.",
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = "RuntimeConversationShutdownError";
    if (options && "cause" in options) this.originalError = options.cause;
  }
}

export function isRuntimeConversationUnavailableError(error: unknown): boolean {
  return hasRuntimeConversationCode(
    error,
    RUNTIME_CONVERSATION_UNAVAILABLE_CODE,
  );
}

export function isRuntimeConversationShutdownError(error: unknown): boolean {
  return hasRuntimeConversationCode(error, RUNTIME_CONVERSATION_SHUTDOWN_CODE);
}

export class DeferredRuntimeConversation implements RuntimeConversation {
  private readonly readiness: Promise<RuntimeConversation>;
  private resolveReady!: (conversation: RuntimeConversation) => void;
  private rejectReady!: (error: unknown) => void;
  private bound?: RuntimeConversation;
  private terminalError?: unknown;
  private settled = false;

  readonly query: ConversationSessionQuery = {
    getSession: (sessionId) =>
      this.use((conversation) => conversation.query.getSession(sessionId)),
    listSessions: (options) =>
      this.use((conversation) => conversation.query.listSessions(options)),
    listMessages: (sessionId, options) =>
      this.use((conversation) =>
        conversation.query.listMessages(sessionId, options),
      ),
  };

  readonly lifecycle: ConversationSessionLifecycle = {
    createSession: (input) =>
      this.use((conversation) => conversation.lifecycle.createSession(input)),
    createRootSession: (input) =>
      this.use((conversation) =>
        conversation.lifecycle.createRootSession(input),
      ),
    replaceRootSession: (agentName, sessionId) =>
      this.use((conversation) =>
        conversation.lifecycle.replaceRootSession(agentName, sessionId),
      ),
    updateSession: (sessionId, fields) =>
      this.use((conversation) =>
        conversation.lifecycle.updateSession(sessionId, fields),
      ),
    deleteSession: (sessionId) =>
      this.use((conversation) =>
        conversation.lifecycle.deleteSession(sessionId),
      ),
  };

  readonly ingress: ConversationIngress = {
    submit: (input) =>
      this.use((conversation) => conversation.ingress.submit(input)),
    resumeUserInput: (input) =>
      this.use((conversation) => conversation.ingress.resumeUserInput(input)),
    steer: (input) =>
      this.use((conversation) => conversation.ingress.steer(input)),
    listQueued: (sessionId) =>
      this.use((conversation) => conversation.ingress.listQueued(sessionId)),
    findQueuedByClientRequestId: (sessionId, clientRequestId) =>
      this.use((conversation) =>
        conversation.ingress.findQueuedByClientRequestId(
          sessionId,
          clientRequestId,
        ),
      ),
    updateQueued: (sessionId, itemId, update) =>
      this.use((conversation) =>
        conversation.ingress.updateQueued(sessionId, itemId, update),
      ),
    promoteQueuedSource: (sessionId, itemId, source) =>
      this.use((conversation) =>
        conversation.ingress.promoteQueuedSource(sessionId, itemId, source),
      ),
    cancelQueued: (sessionId, itemId) =>
      this.use((conversation) =>
        conversation.ingress.cancelQueued(sessionId, itemId),
      ),
    reorderQueued: (sessionId, itemIds) =>
      this.use((conversation) =>
        conversation.ingress.reorderQueued(sessionId, itemIds),
      ),
    abort: (sessionId, reason, turnId) =>
      this.use((conversation) =>
        conversation.ingress.abort(sessionId, reason, turnId),
      ),
    dispatchQueue: (sessionId) =>
      this.use((conversation) => conversation.ingress.dispatchQueue(sessionId)),
  };

  readonly maintenance: ConversationMaintenance = {
    compact: (input) =>
      this.use((conversation) => conversation.maintenance.compact(input)),
  };

  constructor() {
    this.readiness = new Promise<RuntimeConversation>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readiness.catch(() => undefined);
  }

  bind(conversation: RuntimeConversation): void {
    if (this.settled)
      throw new Error("Runtime conversation binding is already settled.");
    this.settled = true;
    this.bound = conversation;
    this.resolveReady(conversation);
  }

  fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.terminalError = normalizeUnavailableError(error);
    this.rejectReady(this.terminalError);
  }

  shutdown(error?: unknown): void {
    if (isRuntimeConversationShutdownError(this.terminalError)) return;
    const normalized = normalizeShutdownError(error);
    this.terminalError = normalized;
    this.bound = undefined;
    if (!this.settled) {
      this.settled = true;
      this.rejectReady(normalized);
    }
  }

  private async use<T>(
    operation: (conversation: RuntimeConversation) => Promise<T>,
  ): Promise<T> {
    if (this.terminalError) throw this.terminalError;
    const conversation = this.bound ?? (await this.readiness);
    if (this.terminalError) throw this.terminalError;
    return operation(conversation);
  }
}

function normalizeUnavailableError(error: unknown): unknown {
  if (
    isRuntimeConversationUnavailableError(error) ||
    isRuntimeConversationShutdownError(error)
  ) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RuntimeConversationUnavailableError(message, { cause: error });
}

function normalizeShutdownError(
  error: unknown,
): RuntimeConversationShutdownError {
  if (error instanceof RuntimeConversationShutdownError) return error;
  const message = error instanceof Error ? error.message : undefined;
  return new RuntimeConversationShutdownError(message, { cause: error });
}

function hasRuntimeConversationCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === code
  );
}

export type {
  ProcessLocalContext,
  ProcessLocalStreamResult,
} from "./process-local.js";
