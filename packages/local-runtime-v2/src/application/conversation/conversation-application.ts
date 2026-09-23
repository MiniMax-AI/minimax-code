import { toUserModelSelection } from "./model-selection.js";
import type {
  AbortSessionInput as AbortSessionReq,
  AbortSessionResult as AbortSessionResp,
  ContinueTurnInput as ContinueTurnReq,
  EnqueueMessageInput as EnqueueMessageReq,
  EnqueueMessageResult as EnqueueMessageResp,
  ModelSelectionInput,
  RequestCompactionInput as RequestCompactionReq,
  RequestCompactionResult as RequestCompactionResp,
  InspectTurnContinuationInput as InspectTurnContinuationReq,
  InspectTurnContinuationResult as InspectTurnContinuationResp,
  ResumeSessionInput as ResumeSessionReq,
  SendMessageInput as SendMessageReq,
  SteerSessionInput as SteerSessionReq,
  SteerSessionResult as SteerSessionResp,
  SessionStreamErrorBody,
  SessionStreamFrameView,
} from "@mavis/protocol/local";
import { TurnContinuationState as TurnContinuationStateView } from "@mavis/protocol/local";
import type {
  ProcessLocalContext,
  ProcessLocalStreamResult,
} from "@mavis/conversation-contract";
import type {
  ConversationSteerInput,
  ConversationSteerResult,
} from "@mavis/conversation-contract";
import { normalizeAbortSource } from "@mavis/agent-core/pi-turn-runner";
import { isServerOwnedTurnId } from "@mavis/shared/turn-identity";

import {
  isSameSessionAgentName,
  QueueServiceError,
  type CommittedQueueCapability,
  type ResumeSessionInput,
  type SessionFrame,
  type SessionStatus,
  type UserMessageAttachment,
} from "../../service/session-system/index.js";
import type {
  AgentHostInputAttachment,
  RequestCompactionResult,
  TurnOutputContract,
  TurnService,
  TurnSystemOwner,
} from "../../service/turn-system/index.js";
import { DEFAULT_RETRY_CONTINUATION_PROMPT } from "../../service/turn-system/index.js";
import {
  AttachmentRegistrationError,
  attachmentRegistrationResponse,
  materializeLocalAttachmentInputs,
  type LocalAttachmentRegistrationPort,
} from "./attachment-registration.js";
import type {
  DirectSendDelivery,
  DirectSendInput,
} from "./direct-send-delivery.js";
import type { TurnContinuationDelivery } from "./turn-continuation-delivery.js";
import { ApplicationError, turnAdmissionError } from "./errors.js";
import type { QueueSteerWorkflow } from "./queue-steer-workflow.js";
import { queueServiceApplicationError } from "./queue-service-error.js";
import {
  countApplicationMetric,
  type ApplicationMetricsClient,
} from "../session/metrics.js";
import {
  mapV2TurnStreamResult,
  openV2SessionStream,
} from "./session-stream-delivery.js";

export interface ConversationSendMessageRequest extends SendMessageReq {
  /** Readable projection supplied by the process-local composer; content retains transport identity. */
  readonly displayContent?: string;
  /** Process-local caller's Unix-ms deadline; its cancellation owner still enforces it. */
  readonly executionDeadlineAtMs?: number;
  /** Process-local opt-in; emits metadata only, never provider payloads. */
  readonly executionDiagnostics?: boolean;
  /** Provider-neutral native JSON response format for one Turn. */
  readonly outputFormat?: TurnOutputContract;
  /** @deprecated Use outputFormat with type json_schema for new process-local callers. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}
export interface ConversationSendOptions {
  readonly pausedQueueAction?: "keep" | "clear";
}
export interface ConversationApplicationOptions {
  readonly directSend: DirectSendDelivery;
  readonly continuation: TurnContinuationDelivery;
  readonly turn: Pick<
    TurnService,
    | "submit"
    | "abort"
    | "requestCompaction"
    | "dispatchSessionQueue"
    | "dispatchQueue"
    | "inspectContinuation"
  >;
  readonly queue: Pick<CommittedQueueCapability, "clearUserManageable">;
  readonly stream: {
    resume(input: ResumeSessionInput): AsyncIterableIterator<SessionFrame>;
  };
  readonly sessionReader: {
    find(sessionId: string): Promise<
      | {
          readonly agentName: string;
          readonly status: SessionStatus;
          /** Read only to gate Slash Review, which is coding-mode only. */
          readonly appMode?: "coding" | "work";
        }
      | undefined
    >;
  };
  readonly attachmentRegistration: LocalAttachmentRegistrationPort;
  readonly threadGoal: {
    pauseActiveForAbort(sessionId: string): Promise<void>;
  };
  readonly steer: (
    input: ConversationSteerInput,
  ) => Promise<ConversationSteerResult>;
  readonly queueSteer: Pick<QueueSteerWorkflow, "execute">;
  readonly turnInspection?: NonNullable<TurnSystemOwner["inspection"]>;
  readonly metrics?: ApplicationMetricsClient;
}

/** Owns the conversation use cases migrated from SessionController. */
export class ConversationApplication {
  constructor(private readonly options: ConversationApplicationOptions) {}

  getActiveTurn(sessionId: string) {
    return (
      this.options.turnInspection?.activeTurn(sessionId) ??
      Promise.resolve(undefined)
    );
  }

  steer(input: ConversationSteerInput): Promise<ConversationSteerResult> {
    return this.options.steer(input);
  }

  async steerSession(
    _ctx: ProcessLocalContext,
    req: SteerSessionReq,
  ): Promise<SteerSessionResp> {
    const result = await this.options.queueSteer.execute({
      sessionId: req.id,
      ...(req.queueItemId ? { queueItemId: req.queueItemId } : {}),
    });
    return {
      success: true,
      queueItemId: result.queueItemId,
      turnId: result.turnId,
    };
  }

  async sendMessage(
    _ctx: ProcessLocalContext,
    req: ConversationSendMessageRequest,
    options: ConversationSendOptions = {},
  ): Promise<
    ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody>
  > {
    const gateError = await this.sendMessageGateError(req, options);
    if (gateError) return gateError;
    let prepared: PreparedDirectSendInput;
    try {
      prepared = await toDirectSendInput(
        req,
        this.options.attachmentRegistration,
      );
    } catch (error) {
      const mapped = sendMessagePreparationError(error);
      if (mapped) {
        return streamOpenError(mapped.status, mapped.key, mapped.message);
      }
      throw error;
    }
    const submission = prepared.submission;
    if (!submission) {
      await prepared.discardCreated();
      return streamOpenError(
        400,
        "local_message_content_required",
        "Local message content or attachments are required.",
      );
    }
    try {
      const result = await this.options.directSend.open({
        ...submission,
        ...(options.pausedQueueAction ? { resumePausedQueue: true } : {}),
      });
      if (!result.accepted) await prepared.discardCreated();
      return mapV2TurnStreamResult(result);
    } catch (error) {
      await prepared.discardCreated();
      throw error;
    }
  }

  private async sendMessageGateError(
    req: ConversationSendMessageRequest,
    options: ConversationSendOptions,
  ): Promise<
    | ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody>
    | undefined
  > {
    const deadlineError = executionDeadlineAdmissionError(req, options);
    if (deadlineError) {
      return streamOpenError(
        deadlineError.status,
        deadlineError.key,
        deadlineError.message,
      );
    }
    if (
      options.pausedQueueAction === "clear" ||
      req.clientIntent === "paused-queue-clear"
    ) {
      try {
        await this.options.queue.clearUserManageable(req.id);
      } catch (error) {
        if (error instanceof QueueServiceError) {
          const mapped = queueServiceApplicationError(error);
          return streamOpenError(mapped.status, mapped.key, mapped.message);
        }
        throw error;
      }
    }
    if (req.turnId && isServerOwnedTurnId(req.turnId)) {
      return streamOpenError(
        400,
        "local_turn_id_reserved",
        "The requested Turn identity is reserved for an internal workflow.",
      );
    }
    return this.reviewGateError(req);
  }

  /**
   * Slash Review admission checks. v1 enforced both in `routes/sessions.ts`
   * before the turn was admitted; the Agent owner cutover retired that route,
   * so they live here now.
   */
  private async reviewGateError(
    req: SendMessageReq,
  ): Promise<
    | ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody>
    | undefined
  > {
    const error = await this.reviewAdmissionError(req);
    return error
      ? streamOpenError(error.status, error.key, error.message)
      : undefined;
  }

  private async reviewAdmissionError(
    req: Pick<SendMessageReq, "id" | "reviewRequest">,
  ): Promise<ApplicationError | undefined> {
    if (!req.reviewRequest) return undefined;
    if (req.reviewRequest.scope !== "local_changes") {
      return new ApplicationError(
        400,
        "local_review_scope_unsupported",
        'Only reviewRequest.scope="local_changes" is supported.',
      );
    }
    const session = await this.options.sessionReader.find(req.id);
    if (session && (session.appMode ?? "coding") !== "coding") {
      return new ApplicationError(
        400,
        "local_review_coding_mode_required",
        "Built-in code review is only available in coding mode.",
      );
    }
    return undefined;
  }

  async resumeSession(
    _ctx: ProcessLocalContext,
    req: ResumeSessionReq,
  ): Promise<
    ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody>
  > {
    return this.withSessionLifecycle("resume", async () => {
      const session = await this.options.sessionReader.find(req.id);
      if (!session) {
        return streamOpenError(
          404,
          "local_session_not_found",
          `Session not found: ${req.id}`,
        );
      }
      const frames = this.options.stream.resume({
        sessionId: req.id,
        ...(req.afterMsgId ? { afterMsgId: req.afterMsgId } : {}),
        ...(req.afterCursor ? { afterCursor: req.afterCursor } : {}),
        waitForTerminal: shouldWaitForTerminal(
          req.drainQueued === true || req.continuePausedQueue === true,
          session.status,
        ),
      });
      try {
        if (req.continuePausedQueue) {
          const result = await this.options.turn.dispatchSessionQueue(req.id);
          if (result.status !== "started")
            throw queueContinueApplicationError(result, req.id);
        } else if (req.drainQueued) {
          await this.options.turn.dispatchQueue(req.id);
        }
      } catch (error) {
        await frames.return?.();
        throw error;
      }
      return openV2SessionStream(frames);
    });
  }

  async inspectTurnContinuation(
    _ctx: ProcessLocalContext,
    req: InspectTurnContinuationReq,
  ): Promise<InspectTurnContinuationResp> {
    if (!(await this.options.sessionReader.find(req.id)))
      throw sessionNotFound(req.id);
    const result = await this.options.turn.inspectContinuation(req.id);
    return { state: turnContinuationStateView(result.state) };
  }

  async continueTurn(
    _ctx: ProcessLocalContext,
    req: ContinueTurnReq,
  ): Promise<
    ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody>
  > {
    if (!(await this.options.sessionReader.find(req.id))) {
      return streamOpenError(
        404,
        "local_session_not_found",
        `Session not found: ${req.id}`,
      );
    }
    return mapV2TurnStreamResult(await this.options.continuation.open(req.id));
  }

  async abortSession(
    _ctx: ProcessLocalContext,
    req: AbortSessionReq,
  ): Promise<AbortSessionResp> {
    const abortSource = normalizeAbortSource(req.reason);
    const result = await this.withSessionLifecycle("abort", async () => {
      if (!(await this.options.sessionReader.find(req.id)))
        throw sessionNotFound(req.id);
      return this.options.turn.abort({
        sessionId: req.id,
        ...(req.turnId ? { turnId: req.turnId } : {}),
        reason: req.reason ?? "user",
        ...(abortSource === "user_stop"
          ? {
              onAccepted: () => this.pauseActiveGoalForAbort(req.id),
            }
          : {}),
      });
    });
    if (
      result.status === "aborted" ||
      result.status === "released" ||
      result.status === "not-running"
    ) {
      return { success: true };
    }
    const timeout = result.status === "abort-timeout";
    throw new ApplicationError(
      409,
      timeout ? "local_turn_abort_timeout" : "local_turn_not_active",
      timeout
        ? "Abort was signalled but the Turn is still closing"
        : "Turn is not active",
    );
  }

  private async pauseActiveGoalForAbort(sessionId: string): Promise<void> {
    try {
      await this.options.threadGoal.pauseActiveForAbort(sessionId);
    } catch {
      // Turn abort is authoritative; Goal pause remains a best-effort side effect.
    }
  }

  async enqueueMessage(
    _ctx: ProcessLocalContext,
    req: EnqueueMessageReq,
  ): Promise<EnqueueMessageResp> {
    const reviewAdmissionError = await this.reviewAdmissionError(req);
    if (reviewAdmissionError) throw reviewAdmissionError;
    let result;
    let discardCreated = async (): Promise<void> => undefined;
    try {
      const input = await toEnqueueMessageInput(
        req,
        this.options.attachmentRegistration,
      );
      discardCreated = input.discardCreated;
      result = await this.options.turn.submit({
        sessionId: input.sessionId,
        allowQueue: true,
        input: input.input,
        provenance: enqueueMessageProvenance(req),
        ...enqueueSubmissionMetadata(input),
      });
    } catch (error) {
      await discardCreated();
      throw enqueueApplicationError(error);
    }
    if (!result.accepted) {
      await discardCreated();
      throw submissionApplicationError(result.reason, req.id);
    }
    if (result.mode !== "queued") {
      throw new Error("Queue-enabled submit returned a non-queued result");
    }
    return {
      itemId: result.queue.itemId,
      status: "queued",
      position: result.queue.position,
    };
  }

  async requestCompaction(
    _ctx: ProcessLocalContext,
    req: RequestCompactionReq,
  ): Promise<RequestCompactionResp> {
    return this.countBuiltinCommand("compact", async () => {
      validateCompactionName(req);
      await validateCompactionSession(req, this.options.sessionReader);
      const result = await this.options.turn.requestCompaction({
        sessionId: req.id,
        ...(req.reason ? { reason: req.reason } : {}),
        ...(req.customInstructions
          ? { customInstructions: req.customInstructions }
          : {}),
      });
      return compactionResponse(result, req.id);
    });
  }

  private async withSessionLifecycle<T>(
    action: "resume" | "abort",
    run: () => T | Promise<T>,
  ): Promise<T> {
    try {
      const result = await run();
      countApplicationMetric(this.options.metrics, "session_lifecycle_total", {
        action,
        status: lifecycleSucceeded(result) ? "ok" : "error",
      });
      return result;
    } catch (error) {
      countApplicationMetric(this.options.metrics, "session_lifecycle_total", {
        action,
        status: "error",
      });
      throw error;
    }
  }

  private async countBuiltinCommand<T>(
    command: "compact",
    operation: () => Promise<T>,
  ): Promise<T> {
    countApplicationMetric(this.options.metrics, "builtin_command_total", {
      command,
      status: "started",
    });
    try {
      const result = await operation();
      countApplicationMetric(this.options.metrics, "builtin_command_total", {
        command,
        status: "succeeded",
      });
      return result;
    } catch (error) {
      countApplicationMetric(this.options.metrics, "builtin_command_total", {
        command,
        status: "failed",
      });
      throw error;
    }
  }
}

function queueContinueApplicationError(
  result: Exclude<
    Awaited<ReturnType<TurnService["dispatchSessionQueue"]>>,
    { readonly status: "started" }
  >,
  sessionId: string,
): ApplicationError {
  if (result.status === "rejected")
    return compactionRejectionError(result.reason, sessionId);
  if (result.status === "not-claimed") {
    return new ApplicationError(
      409,
      "local_queue_continue_not_claimed",
      "The paused Queue head is no longer available",
    );
  }
  return new ApplicationError(
    409,
    "local_queue_continue_not_ready",
    "The paused Queue head could not be started",
  );
}

function shouldWaitForTerminal(
  drainQueued: boolean | undefined,
  status: SessionStatus,
): boolean {
  return drainQueued === true || status === "started";
}

function turnContinuationStateView(
  state: Awaited<ReturnType<TurnService["inspectContinuation"]>>["state"],
) {
  switch (state) {
    case "available":
      return TurnContinuationStateView.Available;
    case "running":
      return TurnContinuationStateView.Running;
    case "waiting-for-user":
      return TurnContinuationStateView.WaitingForUser;
    default:
      return TurnContinuationStateView.Unavailable;
  }
}

export function createConversationApplication(
  options: ConversationApplicationOptions,
): ConversationApplication {
  return new ConversationApplication(options);
}

function requireNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().length === 0 ? undefined : value;
}

async function toDirectSendInput(
  req: ConversationSendMessageRequest,
  registration: LocalAttachmentRegistrationPort,
): Promise<PreparedDirectSendInput> {
  const executionOptions = directExecutionOptions(req);
  const materialized = await materializeLocalAttachmentInputs(registration, {
    sessionId: req.id,
    ...(req.turnId ? { turnId: req.turnId } : {}),
    attachments: req.attachments,
  });
  const attachments = materialized.executionAttachments;
  const clientIntent = normalizedRetryClientIntent(
    req.clientIntent,
    req.content,
    attachments.length > 0,
  );
  const retryContinuation = clientIntent === "retry-continuation";
  const text = directSendText(
    req.content,
    retryContinuation,
    attachments.length > 0,
  );
  if (text === undefined) {
    return {
      submission: undefined,
      discardCreated: materialized.discardCreated,
    };
  }
  return {
    submission: {
      sessionId: req.id,
      input: toAgentHostUserInput(req, text, attachments),
      ...executionOptions,
      provenance: messageProvenance(req),
      ...(req.displayContent !== undefined
        ? { displayContent: req.displayContent }
        : {}),
      ...(materialized.displayAttachments.length > 0
        ? { displayAttachments: materialized.displayAttachments }
        : {}),
      ...(req.turnId ? { requestedTurnId: req.turnId } : {}),
      ...(clientIntent ? { clientIntent } : {}),
      ...(retryContinuation ? { hideUserMessage: true } : {}),
    },
    discardCreated: materialized.discardCreated,
  };
}

function directExecutionOptions(req: ConversationSendMessageRequest) {
  const outputContract = outputContractField(req);
  const deadlineError = executionDeadlineAdmissionError(req);
  if (deadlineError) throw deadlineError;
  const executionDeadlineAtMs = req.executionDeadlineAtMs;
  return {
    ...outputContract,
    ...(executionDeadlineAtMs !== undefined ? { executionDeadlineAtMs } : {}),
  };
}

function executionDeadlineAdmissionError(
  req: Pick<
    ConversationSendMessageRequest,
    "executionDeadlineAtMs" | "clientIntent"
  >,
  options: ConversationSendOptions = {},
): ApplicationError | undefined {
  const deadline = req.executionDeadlineAtMs;
  if (deadline === undefined) return undefined;
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    return new ApplicationError(
      400,
      "local_execution_deadline_invalid",
      "executionDeadlineAtMs must be a positive safe integer in Unix milliseconds.",
    );
  }
  if (
    options.pausedQueueAction !== undefined ||
    ["paused-queue-clear", "paused-queue-keep", "composer-steer"].includes(
      req.clientIntent ?? "",
    )
  ) {
    return new ApplicationError(
      400,
      "local_turn_invalid_input",
      "Execution deadlines require an immediate Turn without steering or paused Queue intents.",
    );
  }
  return undefined;
}

function outputContractField(
  req: Pick<ConversationSendMessageRequest, "outputFormat" | "outputSchema">,
): { readonly outputContract?: TurnOutputContract } {
  if (req.outputFormat !== undefined && req.outputSchema !== undefined) {
    throw new ApplicationError(
      400,
      "local_output_format_conflict",
      "outputFormat and outputSchema cannot be used together.",
    );
  }
  if (req.outputSchema !== undefined) {
    return {
      outputContract: {
        type: "json_schema" as const,
        schema: snapshotLegacyOutputSchema(req.outputSchema),
      },
    };
  }
  if (req.outputFormat === undefined) return {};
  if (!isPlainRecord(req.outputFormat)) {
    throw invalidOutputFormat(
      "outputFormat must be an object with a supported type.",
    );
  }
  if (req.outputFormat.type === "json_object") {
    assertExactKeys(req.outputFormat, ["type"], "json_object outputFormat");
    return { outputContract: { type: "json_object" as const } };
  }
  if (req.outputFormat.type === "json_schema") {
    assertExactKeys(
      req.outputFormat,
      ["type", "schema"],
      "json_schema outputFormat",
    );
    return {
      outputContract: {
        type: "json_schema" as const,
        schema: snapshotJsonSchemaObject(
          req.outputFormat.schema,
          "outputFormat.schema",
        ),
      },
    };
  }
  throw invalidOutputFormat(
    "outputFormat.type must be json_object or json_schema.",
  );
}

function snapshotLegacyOutputSchema(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    throw invalidOutputFormat("outputSchema must be a JSON Schema object.");
  }
  // Keep the legacy Host snapshot semantics, including optional undefined values.
  // Detach before attachment registration; Host validation still runs downstream.
  try {
    return structuredClone(value);
  } catch {
    throw invalidOutputFormat("outputSchema must support structured cloning.");
  }
}

function snapshotJsonSchemaObject(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    throw invalidOutputFormat(`${field} must be a JSON Schema object.`);
  }
  return snapshotJsonValue(value, field, new Set()) as Readonly<
    Record<string, unknown>
  >;
}

function snapshotJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw invalidOutputFormat(`${path} must contain only finite JSON numbers.`);
  }
  if (typeof value !== "object") {
    throw invalidOutputFormat(
      `${path} must contain only JSON-compatible values.`,
    );
  }
  return snapshotJsonComposite(value, path, ancestors);
}

function snapshotJsonComposite(
  value: object,
  path: string,
  ancestors: Set<object>,
): unknown {
  if (ancestors.has(value)) {
    throw invalidOutputFormat(`${path} must not contain circular references.`);
  }
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? snapshotJsonArray(value, path, ancestors)
      : snapshotJsonRecord(value, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function snapshotJsonArray(
  value: readonly unknown[],
  path: string,
  ancestors: Set<object>,
): readonly unknown[] {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalidOutputFormat(`${path} must not contain symbol properties.`);
  }
  const snapshot = Array.from({ length: value.length }, (_, index) => {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw invalidOutputFormat(
        `${path}[${String(index)}] must not be an array hole.`,
      );
    }
    return snapshotJsonValue(
      value[index],
      `${path}[${String(index)}]`,
      ancestors,
    );
  });
  return Object.freeze(snapshot);
}

function snapshotJsonRecord(
  value: object,
  path: string,
  ancestors: Set<object>,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    throw invalidOutputFormat(`${path} must contain only plain JSON objects.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalidOutputFormat(`${path} must not contain symbol properties.`);
  }
  const snapshot: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(snapshot, key, {
      value: snapshotJsonValue(child, `${path}.${key}`, ancestors),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  field: string,
): void {
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw invalidOutputFormat(`${field} contains unsupported fields.`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidOutputFormat(message: string): ApplicationError {
  return new ApplicationError(400, "local_output_format_invalid", message);
}

function messageProvenance(
  req: Pick<
    ConversationSendMessageRequest,
    "id" | "reviewRequest" | "clientIntent" | "executionDiagnostics"
  >,
): DirectSendInput["provenance"] {
  if (req.clientIntent === "cloud-handoff") {
    return {
      source: "api",
      routingFingerprint: `cloud_handoff:${req.id}`,
      sourceContext: { cloudHandoff: { trigger: "slash" } },
    };
  }
  if (!req.reviewRequest) {
    return {
      source: "api",
      routingFingerprint: `api:${req.id}`,
      ...(req.executionDiagnostics === true
        ? { sourceContext: { executionDiagnostics: true } }
        : {}),
    };
  }
  return {
    source: "code_review",
    routingFingerprint: `code_review:${req.id}`,
    sourceContext: {
      ...(req.executionDiagnostics === true
        ? { executionDiagnostics: true }
        : {}),
      review: {
        trigger: "slash",
        scope: "local_changes",
      },
    },
  };
}

function enqueueMessageProvenance(
  req: EnqueueMessageReq,
): DirectSendInput["provenance"] {
  if (req.reviewRequest || req.clientIntent === "cloud-handoff")
    return messageProvenance(req);
  return {
    source: "api",
    routingFingerprint: `api:${req.id}:${req.clientRequestId ?? "queue"}`,
  };
}

interface PreparedDirectSendInput {
  readonly submission: DirectSendInput | undefined;
  readonly discardCreated: () => Promise<void>;
}

function directSendText(
  content: string | undefined,
  retryContinuation: boolean,
  hasAttachments: boolean,
): string | undefined {
  const text = content ?? "";
  if (text.trim().length > 0 || hasAttachments) return text;
  return retryContinuation ? DEFAULT_RETRY_CONTINUATION_PROMPT : undefined;
}

function normalizedRetryClientIntent(
  clientIntent: string | undefined,
  content: string | undefined,
  hasAttachments: boolean,
): string | undefined {
  if (clientIntent !== "retry-continuation") return clientIntent;
  return content?.trim() || hasAttachments ? "retry-message" : clientIntent;
}

function toAgentHostUserInput(
  req: ConversationSendMessageRequest,
  text: string,
  attachments: readonly AgentHostInputAttachment[],
) {
  return {
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(req.model ? { model: toUserModelSelection(req.model) } : {}),
  };
}

interface ConversationEnqueueInput {
  readonly sessionId: string;
  readonly input: {
    readonly text: string;
    readonly attachments?: readonly AgentHostInputAttachment[];
    readonly model?: ModelSelectionInput;
  };
  readonly displayAttachments?: readonly UserMessageAttachment[];
  readonly clientRequestId?: string;
  readonly expiresAt?: number;
  readonly clientIntent?: string;
  readonly discardCreated: () => Promise<void>;
}

function enqueueSubmissionMetadata(input: ConversationEnqueueInput) {
  return {
    ...(input.clientRequestId
      ? { clientRequestId: input.clientRequestId }
      : {}),
    ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    delivery: {
      ...(input.displayAttachments
        ? { displayAttachments: input.displayAttachments }
        : {}),
    },
  };
}

async function toEnqueueMessageInput(
  req: EnqueueMessageReq,
  registration: LocalAttachmentRegistrationPort,
): Promise<ConversationEnqueueInput> {
  const content = req.content ?? "";
  validateReservedQueueIdentity(req);
  const materialized = await materializeLocalAttachmentInputs(registration, {
    sessionId: req.id,
    attachments: req.attachments,
  });
  const attachments = materialized.executionAttachments;
  if (content.trim().length === 0 && attachments.length === 0) {
    throw new ApplicationError(
      400,
      "local_queue_invalid",
      "Queue message is invalid",
    );
  }
  return {
    sessionId: req.id,
    input: {
      text: content,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(req.model ? { model: toUserModelSelection(req.model) } : {}),
    },
    ...(materialized.displayAttachments.length > 0
      ? { displayAttachments: materialized.displayAttachments }
      : {}),
    ...(req.clientRequestId ? { clientRequestId: req.clientRequestId } : {}),
    ...(req.expiresAt !== undefined ? { expiresAt: req.expiresAt } : {}),
    ...(req.clientIntent ? { clientIntent: req.clientIntent } : {}),
    discardCreated: materialized.discardCreated,
  };
}

function validateReservedQueueIdentity(req: EnqueueMessageReq): void {
  if (req.clientRequestId && isServerOwnedTurnId(req.clientRequestId)) {
    throw new ApplicationError(
      400,
      "local_client_request_id_reserved",
      "The Queue request identity is reserved for an internal workflow.",
    );
  }
}

function validateCompactionName(req: RequestCompactionReq): void {
  if (!requireNonEmpty(req.name)) {
    throw new ApplicationError(400, "VALIDATION_ERROR", "name is required");
  }
}

async function validateCompactionSession(
  req: RequestCompactionReq,
  sessionReader: ConversationApplicationOptions["sessionReader"],
): Promise<void> {
  const session = await sessionReader.find(req.id);
  if (!session) throw sessionNotFound(req.id);
  // The caller-supplied Agent name is a page identity, never the owner of
  // record. A main-owned primary Session is still the same Agent as mavis.
  if (!isSameSessionAgentName(session.agentName, req.name)) {
    throw new ApplicationError(
      403,
      "FORBIDDEN",
      "sessionId does not belong to this agent",
    );
  }
}

function compactionResponse(
  result: RequestCompactionResult,
  sessionId: string,
): RequestCompactionResp {
  if (!result.accepted)
    throw compactionRejectionError(result.reason, sessionId);
  const outcome = result.outcome;
  if (outcome.status === "completed") {
    return {
      success: true,
      sessionId,
      compactionId: outcome.compactionId,
      messagesBefore: outcome.messagesBefore,
      messagesAfter: outcome.messagesAfter,
      tokensBefore: outcome.tokensBefore,
      tokensAfter: outcome.tokensAfter,
    };
  }
  if (outcome.status === "unchanged") {
    throw new ApplicationError(400, "NOTHING_TO_COMPACT", "Nothing to compact");
  }
  if (outcome.status === "failed") {
    const message =
      outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
    throw new ApplicationError(500, "local_compaction_failed", message);
  }
  throw new ApplicationError(
    409,
    "local_compaction_aborted",
    outcome.reason ?? "Compaction aborted",
  );
}

function lifecycleSucceeded(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  if ("status" in result)
    return result.status === "aborted" || result.status === "released";
  return true;
}

function sessionNotFound(sessionId: string): ApplicationError {
  return new ApplicationError(
    404,
    "local_session_not_found",
    `Session not found: ${sessionId}`,
  );
}

function enqueueApplicationError(error: unknown): unknown {
  if (error instanceof QueueServiceError)
    return queueServiceApplicationError(error);
  if (error instanceof AttachmentRegistrationError) {
    const mapped = attachmentRegistrationResponse(error);
    return new ApplicationError(mapped.status, mapped.key, mapped.message);
  }
  return error;
}

function sendMessagePreparationError(
  error: unknown,
): ApplicationError | undefined {
  if (error instanceof ApplicationError) return error;
  if (!(error instanceof AttachmentRegistrationError)) return undefined;
  const mapped = attachmentRegistrationResponse(error);
  return new ApplicationError(mapped.status, mapped.key, mapped.message);
}

function streamOpenError(
  status: number,
  key: string,
  message: string,
): ProcessLocalStreamResult<SessionStreamFrameView, SessionStreamErrorBody> {
  return {
    ok: false,
    status,
    body: { sseErrorCode: 0, code: status, key, message },
  };
}

function submissionApplicationError(
  reason:
    | "invalid-session"
    | "invalid-input"
    | "active-turn"
    | "compaction-active"
    | "session-deleting"
    | "session-mutating"
    | "priority-blocked"
    | "ingress-conflict"
    | `policy:${string}`
    | "duplicate",
  sessionId: string,
): ApplicationError {
  if (reason === "invalid-input") {
    return new ApplicationError(
      400,
      "local_queue_invalid",
      "Queue message is invalid",
    );
  }
  return compactionRejectionError(reason, sessionId);
}

function compactionRejectionError(
  ...args: Parameters<typeof genericRejectionError>
): ApplicationError {
  const admissionError = turnAdmissionError(args[0]);
  return admissionError
    ? new ApplicationError(
        admissionError.status,
        admissionError.key,
        admissionError.message,
      )
    : genericRejectionError(...args);
}

function genericRejectionError(
  reason:
    | "invalid-session"
    | "active-turn"
    | "compaction-active"
    | "session-deleting"
    | "session-mutating"
    | "priority-blocked"
    | "ingress-conflict"
    | `policy:${string}`
    | "duplicate"
    | "invalid-input",
  sessionId: string,
): ApplicationError {
  if (reason === "invalid-session") return sessionNotFound(sessionId);
  if (reason === "invalid-input") {
    return new ApplicationError(
      400,
      "local_turn_invalid_input",
      "Turn input is invalid",
    );
  }
  if (reason === "priority-blocked") {
    return new ApplicationError(
      409,
      "local_session_has_queued_messages",
      "An earlier queued message has priority",
    );
  }
  if (reason === "ingress-conflict") {
    return new ApplicationError(
      409,
      "local_turn_ingress_conflict",
      "Turn ingress conflicts",
    );
  }
  const planError = planRejectionError(reason);
  if (planError) return planError;
  if (reason === "duplicate") {
    return new ApplicationError(
      409,
      "local_turn_duplicate",
      "Turn was already accepted",
    );
  }
  if (reason === "session-deleting") {
    return new ApplicationError(
      409,
      "local_session_deleting",
      "Session is being deleted",
    );
  }
  if (reason === "session-mutating") {
    return new ApplicationError(
      409,
      "local_session_mutating",
      "Session conversation is being changed",
    );
  }
  if (reason === "compaction-active") {
    return new ApplicationError(
      409,
      "local_session_compacting",
      "Session compaction is active",
    );
  }
  return new ApplicationError(
    409,
    "local_session_busy",
    "Session already has an active Turn. Retry with queueing enabled to deliver it later.",
  );
}

function planRejectionError(
  reason:
    | "invalid-session"
    | "active-turn"
    | "compaction-active"
    | "session-deleting"
    | "session-mutating"
    | "priority-blocked"
    | "ingress-conflict"
    | `policy:${string}`
    | "duplicate"
    | "invalid-input",
): ApplicationError | undefined {
  if (reason === "policy:plan:lifecycle-active") {
    return new ApplicationError(
      409,
      "local_plan_lifecycle_active",
      "Plan review processing must finish before this request can run",
    );
  }
  if (reason === "policy:plan:questionnaire-active") {
    return new ApplicationError(
      409,
      "local_plan_questionnaire_active",
      "Resolve the pending questionnaire before entering Plan Mode",
    );
  }
  if (reason === "policy:plan:entry-disabled") {
    return new ApplicationError(
      409,
      "local_plan_entry_disabled",
      "New Plan Mode entry is temporarily disabled",
    );
  }
  if (reason === "policy:plan:mode-conflict") {
    return new ApplicationError(
      409,
      "local_plan_mode_conflict",
      "Session mode changed before Plan Mode entry",
    );
  }
  return undefined;
}
