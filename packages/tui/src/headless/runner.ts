import { resolve } from "node:path";

import type { TuiAttachment } from "../application/invocation.js";
import { TuiRunCoordinator } from "../application/run-coordinator.js";
import type { TuiTurnRunOutcome } from "../application/turn-run-outcome.js";
import {
  isTurnCompactionMessage,
  responseUsageFromMessage,
  sumResponseUsage,
  upsertResponseUsage,
} from "../application/response-usage.js";
import { createTuiTurnId } from "../application/turn-id.js";
import type {
  TuiConfigurationPort,
  TuiConversationPort,
  TuiActiveRunControlPort,
  TuiInspectionPort,
  TuiInteractionPort,
  TuiSession,
  TuiSessionPort,
  TuiSessionTurnPort,
} from "../runtime/port.js";
import type { TuiModel, TuiSessionUsageRow } from "../types/runtime-models.js";
import {
  exitCodeForExecError,
  exitCodeForExecResult,
  MINIMAX_CODE_EXEC_EXIT_CODES,
  TuiExecError,
} from "./exit-policy.js";
import {
  createHeadlessOutputEncoder,
  createNodeStreamWriter,
  writeHeadlessLastMessage,
  type TuiExecFormat,
  type TuiHeadlessOutputEncoder,
  type TuiOutputWrite,
} from "./output.js";
import type { TuiPermissionPolicy } from "./invocation.js";
import { resolveHeadlessModelSelection, parseHeadlessModelOverride } from "./model-selection.js";
import { TuiFailure } from "../failure.js";
import {
  formatTuiExecFailure,
  formatTuiExecResultFailure,
} from "./error-presentation.js";
import { MINIMAX_CODE_DEFAULT_AGENT_NAME } from "../product-context.js";
import { requireTuiAgentAccess } from "../application/login-gate.js";
import { formatTuiActionFailure } from "../user-facing-failure.js";
import { isTuiInternalSubagentSession } from "../runtime/delegation.js";
import { ExecRunSupervisor, loadTurnHistory } from "./supervisor.js";
import {
  createExecResult,
  validateExecOutput,
  type ExecResult,
  type ExecModelIdentity,
  type ExecTokenUsage,
} from "./contract.js";
import { ExecEventProjector } from "./events.js";
import {
  createPassingReviewResult,
  parseTuiReviewResult,
  renderReviewResultText,
  reviewOutcomeFromOrigin,
  type ReviewResultV1,
  type TuiReviewOutcome,
} from "../review/result.js";
import type { TuiStreamEvent } from "../runtime/stream-events.js";
import { ExecDiagnostics, outputSchemaHash } from "./diagnostics.js";
import { waitForExecSettlement } from "./settlement.js";
import { ExecProgress } from "./progress.js";

export interface TuiExecInput {
  prompt: string;
  workspaceDir: string;
  version: string;
  attachments?: readonly TuiAttachment[];
  format?: TuiExecFormat;
  model?: string;
  effort?: string;
  sessionId?: string;
  continueSession?: boolean;
  permission?: TuiPermissionPolicy;
  timeoutMs?: number;
  maxSteps?: number;
  outputSchema?: Readonly<Record<string, unknown>>;
  outputLastMessagePath?: string;
  reviewRequest?: { readonly scope: "local_changes" };
  diagnosticsDir?: string;
}

export type TuiHeadlessRuntime = Pick<
  TuiSessionPort,
  "createSession" | "getSession" | "listSessionPage" | "listMessagePage"
> &
  TuiConversationPort &
  TuiSessionTurnPort &
  TuiActiveRunControlPort &
  Pick<TuiInspectionPort, "getSessionUsage"> &
  Pick<
    TuiInteractionPort,
    "getPendingQuestionnaire" | "listPendingPermissions"
  > &
  Pick<TuiConfigurationPort, "getAccountStatus" | "listModels">;

export interface TuiExecDependencies {
  runtime: TuiHeadlessRuntime;
  stdout?: TuiOutputWrite;
  stderr?: TuiOutputWrite;
  shutdown: () => Promise<void | boolean>;
  signal?: AbortSignal;
  processRef?: Pick<NodeJS.Process, "once" | "off">;
  createTurnId?: () => string;
  /** Overrides how long a stopped run waits for remaining output to drain. */
  stopOutputGraceMs?: number;
}

/**
 * How long a stopped run (timeout, cancellation or step limit) keeps waiting
 * for stdout/stderr. A reader that stops reading must not keep the run from
 * returning; the CLI entry then exits with the run's exit code.
 */
export const HEADLESS_STOP_OUTPUT_GRACE_MS = 2_000;

export async function runTuiExec(
  input: TuiExecInput,
  dependencies: TuiExecDependencies,
): Promise<number> {
  const stdout = dependencies.stdout ?? createNodeStreamWriter(process.stdout);
  const stderr = dependencies.stderr ?? createNodeStreamWriter(process.stderr);
  const processRef = dependencies.processRef ?? process;
  const createTurnId = dependencies.createTurnId ?? createTuiTurnId;
  let exitCode: number = MINIMAX_CODE_EXEC_EXIT_CODES.internal;
  let streamOutputFailure: unknown;
  let terminal:
    | {
        readonly encoder: TuiHeadlessOutputEncoder;
        result: ExecResult;
        readonly lastMessage?: {
          readonly filePath: string;
          readonly answer: string;
        };
      }
    | undefined;
  const diagnostics: string[] = [];
  let evidence: ExecDiagnostics | undefined;
  let answerSelection: Readonly<Record<string, unknown>> = {};
  let executionMetadata: Readonly<Record<string, unknown>> = {};
  let stoppedForRecovery = false;
  let originalAnswer: string | null | undefined;
  const progress = input.diagnosticsDir
    ? new ExecProgress((event) =>
        evidence?.record({ ...executionMetadata, ...event }),
      )
    : undefined;
  const startedAt = Date.now();
  const stopOutput = createStopOutputRelease(
    dependencies.stopOutputGraceMs ?? HEADLESS_STOP_OUTPUT_GRACE_MS,
  );
  let observations: Promise<void> | undefined;
  let runStopped = false;
  let finalOutputStarted = false;
  const supervisor = new ExecRunSupervisor(dependencies.runtime);
  const coordinator = new TuiRunCoordinator(supervisor.conversationPort(), {
    releaseObserverOnStop: true,
    ...(input.diagnosticsDir
      ? {
          onAnswerSelection: (event: Readonly<Record<string, unknown>>) => {
            answerSelection = event;
            evidence?.record(event);
          },
        }
      : {}),
  });
  let reviewTerminal:
    | { readonly outcome: TuiReviewOutcome; readonly content: string }
    | undefined;

  let cancelled = dependencies.signal?.aborted ?? false;
  const cancel = () => {
    cancelled = true;
    // Shutdown can legitimately take a while; only bound the final output wait.
    if (finalOutputStarted) stopOutput.start();
    void coordinator.abort();
  };
  const assertNotCancelled = () => {
    if (cancelled)
      throw new TuiExecError("cancelled", "Execution was cancelled.");
  };
  dependencies.signal?.addEventListener("abort", cancel, { once: true });
  processRef.once("SIGINT", cancel);
  processRef.once("SIGTERM", cancel);
  processRef.once("SIGHUP", cancel);
  try {
    assertNotCancelled();
    if (input.diagnosticsDir) {
      evidence = await ExecDiagnostics.create(input.diagnosticsDir, (warning) =>
        diagnostics.push(warning),
      );
      assertNotCancelled();
    }
    const loginModel = input.model ? parseHeadlessModelOverride(input.model) : undefined;
    await requireTuiAgentAccess(
      dependencies.runtime, input.sessionId, undefined, undefined,
      loginModel ? { model: loginModel } : undefined,
    );
    assertNotCancelled();
    const session = await resolveSession(
      input,
      dependencies.runtime,
      assertNotCancelled,
    );
    assertNotCancelled();
    await assertSessionHasNoPendingInteraction(dependencies.runtime, session);
    assertNotCancelled();
    const model = await resolveHeadlessModelSelection({
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      session,
      runtime: dependencies.runtime,
    });
    assertNotCancelled();
    const turnId = createTurnId();
    const runId = `exec_${turnId}`;
    executionMetadata = {
      version: input.version,
      sessionId: session.sessionId,
      turnId,
      runId,
      startedAt,
      schemaHash: outputSchemaHash(input.outputSchema),
    };
    evidence?.execution(executionMetadata);
    evidence?.record({
      kind: "execution_started",
      sessionId: session.sessionId,
      turnId,
    });
    const encoder = createHeadlessOutputEncoder(
      input.format ?? "text",
      stdout,
      {
        ...(input.format === "stream-json"
          ? {
              eventProjector: new ExecEventProjector({
                runId,
                sessionId: session.sessionId,
                turnId,
                resumed: Boolean(input.sessionId || input.continueSession),
              }),
            }
          : {}),
      },
    );
    const execution = await coordinator.execute(
      {
        turnId,
        session: Promise.resolve(session),
        content: input.prompt,
        workspace: input.workspaceDir,
        version: input.version,
        ...(evidence ? { executionDiagnostics: true } : {}),
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
        ...(model ? { model } : {}),
        ...(input.reviewRequest ? { reviewRequest: input.reviewRequest } : {}),
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
        ...(input.timeoutMs !== undefined || input.maxSteps !== undefined
          ? {
              policy: {
                ...(input.timeoutMs !== undefined
                  ? { timeoutMs: input.timeoutMs }
                  : {}),
                ...(input.maxSteps !== undefined
                  ? { maxSteps: input.maxSteps }
                  : {}),
                requireAnswer: true,
              },
            }
          : { policy: { requireAnswer: true } }),
      },
      async (event) => {
        let reviewOutcome: TuiReviewOutcome | undefined;
        if (event.type === "message") {
          reviewOutcome = reviewOutcomeFromOrigin(event.message.origin);
          if (reviewOutcome) {
            reviewTerminal = {
              outcome: reviewOutcome,
              content: event.message.content ?? "",
            };
          }
        }
        progress?.observe(event);
        if (event.type === "session-status") {
          evidence?.record({ kind: "session_status", status: event.status });
        } else if (
          event.type === "message" &&
          event.message.role === "assistant"
        ) {
          evidence?.record({
            kind: "assistant_completed",
            messageId: event.message.id,
            finishReason: event.message.finishReason,
            requestDurationMs: event.message.usage?.requestDurationMs,
          });
        }
        try {
          await encoder.event(
            projectHeadlessReviewStreamEvent(event, reviewOutcome),
          );
        } catch (error) {
          streamOutputFailure ??= error;
          void coordinator.abort();
          throw error;
        }
      },
    );
    observations = execution.observations;
    runStopped = isStoppedRunStatus(execution.outcome.status);
    if (streamOutputFailure) throw streamOutputFailure;
    let outcome = toHeadlessOutcome(execution.outcome);
    let reviewResult: ReviewResultV1 | undefined;
    if (input.reviewRequest && outcome.status === "succeeded") {
      const projected = projectHeadlessReviewResult(reviewTerminal);
      if ("error" in projected) {
        outcome = {
          ...outcome,
          status: "failed",
          answer: null,
          error: projected.error,
        };
      } else {
        reviewResult = projected.result;
      }
    }
    originalAnswer = outcome.answer;
    const validation =
      outcome.status === "succeeded"
        ? validateExecOutput(outcome.answer, input.outputSchema)
        : undefined;
    const facts =
      isMachineFormat(input.format) || evidence
        ? await resolveExecutionFacts(
            dependencies.runtime,
            session.sessionId,
            turnId,
            outcome,
          )
        : {};
    const resultOptions = {
      runId,
      ...(validation ? { validation } : {}),
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      ...(facts.model
        ? {
            model: {
              ...facts.model,
              ...(input.outputSchema && outcome.status === "succeeded"
                ? { structuredOutputMode: "native_strict" as const }
                : {}),
            },
          }
        : {}),
      ...(facts.usage ? { usage: facts.usage } : {}),
      ...("usageSource" in facts
        ? {
            usageSource: facts.usageSource,
            usageIncomplete: facts.usageIncomplete,
          }
        : {}),
    };
    const execResult = createExecResult(outcome, resultOptions);
    const result: ExecResult = reviewResult
      ? { ...execResult, output: reviewResult }
      : execResult;
    if (evidence && result.status === "timeout") {
      stoppedForRecovery = await waitForExecSettlement(
        dependencies.runtime,
        session.sessionId,
      );
      evidence.record({ kind: "stop_confirmed", stopped: stoppedForRecovery });
    }
    executionMetadata = {
      ...executionMetadata,
      model: facts.model,
      status: result.status,
      durationMs: result.durationMs,
    };
    if (result.status !== "succeeded") {
      evidence?.failure(outcome.answer, {
        ...progress?.summary(),
        ...answerSelection,
        error: result.error,
        status: result.status,
        ...(validation && !validation.ok
          ? { validationKind: validation.kind }
          : {}),
      });
    }
    terminal = {
      encoder,
      result,
      ...(result.status === "succeeded" && input.outputLastMessagePath
        ? {
            lastMessage: {
              filePath: input.outputLastMessagePath,
              answer: reviewResult
                ? renderReviewResultText(reviewResult)
                : (outcome.answer ?? ""),
            },
          }
        : {}),
    };
  } catch (error) {
    const normalized = normalizeRunError(error);
    evidence?.failure(undefined, {
      error: { message: normalized.message },
      phase: "execution",
    });
    exitCode = exitCodeForExecError(normalized);
    if (exitCode !== MINIMAX_CODE_EXEC_EXIT_CODES.brokenPipe) {
      diagnostics.push(
        `mcode exec failed: ${formatTuiExecFailure(normalized)}\n`,
      );
    }
  } finally {
    // Signal listeners stay attached until final output finishes, so a signal
    // that arrives while stdout is blocked still bounds the remaining wait.
    let shutdownFailure: string | undefined;
    let shutdownFailurePublished = false;
    try {
      const shutdownFailed = await dependencies.shutdown();
      if (shutdownFailed === true)
        shutdownFailure = "Runtime shutdown did not complete cleanly.";
    } catch (error) {
      shutdownFailure = formatTuiActionFailure(error, {
        summary: "mcode exec shutdown failed.",
        nextStep: "Verify no process is still running.",
      });
    }

    finalOutputStarted = true;
    if (runStopped || cancelled) stopOutput.start();
    // A stopped run returns without waiting for the observer; let pending event
    // lines finish first so the terminal result stays last.
    const eventsDelivered = await untilOutputReleased(
      observations ?? Promise.resolve(),
      stopOutput.signal,
    );

    if (terminal) {
      if (shutdownFailure && terminal.result.status === "succeeded") {
        terminal.result = internalFailureResult(
          terminal.result,
          "RUNTIME_SHUTDOWN_FAILED",
          shutdownFailure,
        );
        shutdownFailurePublished = true;
      }
      if (terminal.result.status === "succeeded" && terminal.lastMessage) {
        try {
          await writeHeadlessLastMessage(
            terminal.lastMessage.filePath,
            terminal.lastMessage.answer,
          );
        } catch (error) {
          terminal.result = internalFailureResult(
            terminal.result,
            "OUTPUT_LAST_MESSAGE_WRITE_FAILED",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      try {
        if (
          terminal.result.status !== "succeeded" &&
          terminal.result.error?.category === "internal"
        ) {
          evidence?.failure(originalAnswer, {
            ...answerSelection,
            status: terminal.result.status,
            error: terminal.result.error,
          });
        }
        // Skip the result when earlier event lines are still stuck: it could not
        // be delivered ahead of them, and the exit code carries the outcome.
        if (eventsDelivered) {
          await untilOutputReleased(terminal.encoder.result(terminal.result), stopOutput.signal);
        }
        exitCode = exitCodeForExecResult(terminal.result);
        if (terminal.result.status !== "succeeded") {
          diagnostics.push(
            `mcode exec ${terminal.result.status}: ${formatTuiExecResultFailure(terminal.result)}\n`,
          );
        }
      } catch (error) {
        const normalized = normalizeRunError(error);
        exitCode = exitCodeForExecError(normalized);
        if (exitCode !== MINIMAX_CODE_EXEC_EXIT_CODES.brokenPipe) {
          diagnostics.push(
            `mcode exec failed: ${formatTuiExecFailure(normalized)}\n`,
          );
        }
      }
    } else if (
      shutdownFailure &&
      exitCode !== MINIMAX_CODE_EXEC_EXIT_CODES.brokenPipe
    ) {
      exitCode = MINIMAX_CODE_EXEC_EXIT_CODES.internal;
    }
    if (shutdownFailure && !shutdownFailurePublished)
      diagnostics.push(`${shutdownFailure}\n`);
    evidence?.execution({
      ...executionMetadata,
      endedAt: Date.now(),
      shutdownComplete: !shutdownFailure,
      exitCode,
    });
    evidence?.record({
      kind: "execution_finished",
      ...executionMetadata,
      exitCode,
      shutdownComplete: !shutdownFailure,
    });
    await evidence?.flush({
      version: input.version,
      runId: executionMetadata.runId,
      sessionId: executionMetadata.sessionId,
      turnId: executionMetadata.turnId,
      ...progress?.summary(),
      exitCode,
      shutdownComplete: !shutdownFailure,
      recoveryReady: stoppedForRecovery && !shutdownFailure,
    });
    if (exitCode !== MINIMAX_CODE_EXEC_EXIT_CODES.brokenPipe) {
      for (const diagnostic of diagnostics) {
        const delivered = await untilOutputReleased(
          writeDiagnostic(stderr, diagnostic),
          stopOutput.signal,
        );
        if (!delivered) break;
      }
    }
    stopOutput.dispose();
    dependencies.signal?.removeEventListener("abort", cancel);
    processRef.off("SIGINT", cancel);
    processRef.off("SIGTERM", cancel);
    processRef.off("SIGHUP", cancel);
  }
  return exitCode;
}

function projectHeadlessReviewResult(
  terminal:
    | { readonly outcome: TuiReviewOutcome; readonly content: string }
    | undefined,
):
  | { readonly result: ReviewResultV1 }
  | { readonly error: NonNullable<TuiTurnRunOutcome["error"]> } {
  if (!terminal) {
    return {
      error: {
        category: "runtime",
        code: "REVIEW_RESULT_MISSING",
        message: "Runtime completed without a validated code review result.",
        retryable: true,
      },
    };
  }
  if (terminal.outcome === "failed") {
    return {
      error: {
        category: "runtime",
        code: "REVIEW_RESULT_INVALID",
        message:
          terminal.content.trim() ||
          "Runtime rejected an invalid code review result.",
        retryable: true,
      },
    };
  }
  const result =
    terminal.outcome === "pass"
      ? createPassingReviewResult(terminal.content)
      : parseTuiReviewResult(terminal.content);
  return result
    ? { result }
    : {
        error: {
          category: "runtime",
          code: "REVIEW_RESULT_INVALID",
          message: "Runtime returned an invalid code review result.",
          retryable: true,
        },
      };
}

function projectHeadlessReviewStreamEvent(
  event: TuiStreamEvent,
  outcome: TuiReviewOutcome | undefined,
): TuiStreamEvent {
  if (event.type !== "message" || outcome !== "needs_changes") return event;
  const result = parseTuiReviewResult(event.message.content ?? "");
  return {
    ...event,
    message: {
      ...event.message,
      content: result
        ? renderReviewResultText(result)
        : "Runtime returned an invalid code review result.",
    },
  };
}

function internalFailureResult(
  result: ExecResult,
  code: string,
  message: string,
): ExecResult {
  return {
    ...result,
    status: "failed",
    output: undefined,
    error: { category: "internal", code, message, retryable: false },
  };
}

function toHeadlessOutcome(outcome: TuiTurnRunOutcome): TuiTurnRunOutcome {
  if (outcome.status !== "awaiting-user-continuation") return outcome;
  return {
    ...outcome,
    status: "failed",
    error: {
      category: "runtime",
      code: "INTERACTION_NOT_AVAILABLE",
      message:
        "The Runtime requested user interaction from a non-interactive Exec host.",
      retryable: false,
    },
  };
}

async function assertSessionHasNoPendingInteraction(
  runtime: TuiHeadlessRuntime,
  session: TuiSession,
): Promise<void> {
  const agentName = session.agentName ?? MINIMAX_CODE_DEFAULT_AGENT_NAME;
  const [questionnaire, permissions] = await Promise.all([
    runtime.getPendingQuestionnaire(agentName, session.sessionId),
    runtime.listPendingPermissions(),
  ]);
  const pendingPermission = permissions.some(
    (permission) => permission.sessionId === session.sessionId,
  );
  if (!questionnaire && !pendingPermission) return;
  const interaction = questionnaire
    ? "a pending questionnaire"
    : "a pending permission request";
  throw new TuiExecError(
    "runtime",
    `Session ${session.sessionId} has ${interaction} and requires an interactive host. Continue it in the TUI or ACP.`,
  );
}

function isMachineFormat(format: TuiExecFormat | undefined): boolean {
  return format === "json" || format === "stream-json";
}

async function resolveExecutionFacts(
  runtime: TuiHeadlessRuntime,
  sessionId: string,
  turnId: string,
  outcome: TuiTurnRunOutcome,
): Promise<
  Pick<ExecResult, "model" | "usage" | "usageSource" | "usageIncomplete">
> {
  // Diagnostics must not hold the terminal result open when an inspection RPC stalls.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  const [usage, models, history] = await Promise.all([
    readExecutionFact(
      () => runtime.getSessionUsage(sessionId),
      undefined,
      controller.signal,
    ),
    readExecutionFact(
      () => runtime.listModels(sessionId),
      [],
      controller.signal,
    ),
    readExecutionFact(
      () => loadTurnHistory(runtime, sessionId, turnId, controller.signal),
      undefined,
      controller.signal,
    ),
  ]).finally(() => clearTimeout(timer));
  const rows = usage?.rows?.filter((row) => row.turnId === turnId) ?? [];
  const actualModel = [...rows]
    .reverse()
    .find((row) => row.model?.trim())
    ?.model?.trim();
  const fallbackModel = outcome.model
    ? `${outcome.model.providerId}/${outcome.model.modelId}`
    : undefined;
  const selectedModel = models.find((candidate) => candidate.selected === true);
  const selectedReference = selectedModel
    ? `${selectedModel.providerId}/${selectedModel.modelId}`
    : undefined;
  const model = resolveModelIdentity(
    actualModel ?? fallbackModel ?? selectedReference,
    models,
    outcome.model?.variant,
  );
  const responses = [...(outcome.usageResponses ?? [])];
  const historyIds = new Set<string>();
  for (const message of history?.messages ?? []) {
    const response = responseUsageFromMessage(message, turnId);
    if (!response) continue;
    if (response.messageId) historyIds.add(response.messageId);
    // Unidentified history cannot be reconciled against stream delivery safely.
    if (response.messageId) upsertResponseUsage(responses, response);
  }
  const responseSummary = sumResponseUsage(responses);
  const responseUsage = toExecTokenUsage(
    responseSummary.usage ?? outcome.usage,
  );
  const tokenUsage = responseUsage ?? sumUsageRows(rows);
  const usageIncomplete =
    outcome.status !== "succeeded" ||
    outcome.usageIncomplete === true ||
    !history?.complete ||
    history.messages.some((message) =>
      isTurnCompactionMessage(message, turnId),
    ) ||
    responseSummary.usageIncomplete ||
    (responseUsage !== undefined && responseUsage.totalTokens === undefined) ||
    responses.length === 0 ||
    responses.some(
      (response) =>
        !response.messageId ||
        !historyIds.has(response.messageId) ||
        !toExecTokenUsage(response.usage) ||
        response.usageIncomplete,
    ) ||
    (history?.messages.some((message) => {
      const response = responseUsageFromMessage(message, turnId);
      return response !== undefined && !response.messageId;
    }) ??
      false);
  return {
    ...(model ? { model } : {}),
    ...(tokenUsage ? { usage: tokenUsage } : {}),
    usageSource: responseUsage
      ? "completed_responses"
      : tokenUsage
        ? "analytics_fallback"
        : "unavailable",
    usageIncomplete: !responseUsage || usageIncomplete,
  };
}

function readExecutionFact<T>(
  read: () => Promise<T>,
  fallback: T,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolveFact) => {
    const finish = (value: T) => {
      signal.removeEventListener("abort", abort);
      resolveFact(value);
    };
    const abort = () => finish(fallback);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    void Promise.resolve()
      .then(read)
      .then(finish, () => finish(fallback));
  });
}

function resolveModelIdentity(
  reference: string | undefined,
  models: readonly TuiModel[],
  requestedVariant: string | undefined,
): ExecModelIdentity | undefined {
  const separator = reference?.indexOf("/") ?? -1;
  if (!reference || separator <= 0 || separator === reference.length - 1)
    return undefined;
  const providerId = reference.slice(0, separator);
  const modelId = reference.slice(separator + 1);
  const catalog = models.find(
    (candidate) =>
      candidate.providerId === providerId && candidate.modelId === modelId,
  );
  return {
    providerId,
    modelId,
    ...(catalog?.variant !== undefined
      ? { variant: catalog.variant }
      : requestedVariant !== undefined
        ? { variant: requestedVariant }
        : {}),
    ...(catalog?.providerSource
      ? { providerSource: catalog.providerSource }
      : {}),
    ...(catalog?.providerKind ? { providerKind: catalog.providerKind } : {}),
    ...(catalog?.apiFormat ? { protocol: catalog.apiFormat } : {}),
  };
}

function sumUsageRows(
  rows: readonly TuiSessionUsageRow[],
): ExecTokenUsage | undefined {
  // Analytics has row identity, not response identity: it is only a partial fallback.
  const identified = new Map<number, TuiSessionUsageRow>();
  const anonymous: TuiSessionUsageRow[] = [];
  for (const row of rows) {
    if (row.id === undefined) anonymous.push(row);
    else identified.set(row.id, row);
  }
  const uniqueRows = [...identified.values(), ...anonymous];
  const usage = {
    ...sumUsageField(uniqueRows, "inputTokens"),
    ...sumUsageField(uniqueRows, "outputTokens"),
    ...sumUsageField(uniqueRows, "reasoningTokens"),
    ...sumUsageField(uniqueRows, "cacheReadTokens"),
    ...sumUsageField(uniqueRows, "cacheWriteTokens"),
  };
  return toExecTokenUsage(usage);
}

function toExecTokenUsage(
  value: ExecTokenUsage | undefined,
): ExecTokenUsage | undefined {
  if (!value) return undefined;
  const usage = { ...value };
  delete usage.totalTokens;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const total = (input ?? 0) + (output ?? 0);
  return Object.keys(usage).length === 0
    ? undefined
    : {
        ...usage,
        ...((input !== undefined || output !== undefined) &&
        Number.isFinite(total)
          ? { totalTokens: total }
          : {}),
      };
}

function sumUsageField(
  rows: readonly TuiSessionUsageRow[],
  key: keyof ExecTokenUsage,
): Partial<ExecTokenUsage> {
  const values = rows
    .map((row) => row[key as keyof TuiSessionUsageRow])
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    );
  const sum = values.reduce((accumulated, value) => accumulated + value, 0);
  return values.length > 0 && Number.isFinite(sum) ? { [key]: sum } : {};
}

function normalizeRunError(error: unknown): TuiExecError {
  if (error instanceof TuiExecError) return error;
  if (error instanceof TuiFailure) {
    const kind =
      error.category === "config" ||
      error.category === "invocation" ||
      error.category === "cancelled" ||
      error.category === "brokenPipe" ||
      error.category === "internal"
        ? error.category
        : "runtime";
    return new TuiExecError(kind, error.message, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new TuiExecError("runtime", message, { cause: error });
}

async function resolveSession(
  input: TuiExecInput,
  runtime: TuiHeadlessRuntime,
  assertNotCancelled: () => void,
): Promise<TuiSession> {
  if (input.sessionId) {
    const session = await runtime.getSession(input.sessionId);
    assertSessionUsable(session, input.workspaceDir);
    return session;
  }
  if (input.continueSession) {
    const session = await findLatestWorkspaceSession(
      runtime,
      input.workspaceDir,
      assertNotCancelled,
    );
    if (!session) {
      throw new TuiExecError(
        "runtime",
        `No active Session exists for workspace ${input.workspaceDir}.`,
      );
    }
    assertSessionUsable(session, input.workspaceDir);
    return session;
  }
  return runtime.createSession({
    workspaceDir: input.workspaceDir,
    title: summarizePrompt(input.prompt, input.attachments?.length ?? 0),
  });
}

async function findLatestWorkspaceSession(
  runtime: TuiHeadlessRuntime,
  workspaceDir: string,
  assertNotCancelled: () => void,
): Promise<TuiSession | undefined> {
  let cursor: string | undefined;
  do {
    const page = await runtime.listSessionPage({
      agentName: MINIMAX_CODE_DEFAULT_AGENT_NAME,
      cursor,
      limit: 50,
      includeArchived: false,
    });
    assertNotCancelled();
    const session = page.sessions.find(
      (candidate) =>
        candidate.archived !== true &&
        candidate.workspaceDir !== undefined &&
        sameWorkspace(candidate.workspaceDir, workspaceDir),
    );
    if (session) return session;
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor);
  return undefined;
}

function assertSessionUsable(session: TuiSession, workspaceDir: string): void {
  if (isTuiInternalSubagentSession(session)) {
    throw new TuiExecError(
      "invocation",
      "Sub-agent Sessions are internal and cannot be opened.",
    );
  }
  if (session.archived) {
    throw new TuiExecError(
      "runtime",
      `Session is archived: ${session.sessionId}`,
    );
  }
  if (
    !session.workspaceDir ||
    !sameWorkspace(session.workspaceDir, workspaceDir)
  ) {
    throw new TuiExecError(
      "runtime",
      `Session workspace does not match --cwd: ${session.sessionId}`,
    );
  }
}

function sameWorkspace(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function writeDiagnostic(
  write: TuiOutputWrite,
  value: string,
): Promise<void> {
  try {
    await write(value);
  } catch {
    // Diagnostics are best effort and must not shadow the primary exit contract.
  }
}

function isStoppedRunStatus(status: TuiTurnRunOutcome['status']): boolean {
  return status === 'timeout' || status === 'cancelled' || status === 'limit_exceeded';
}

interface StopOutputRelease {
  readonly signal: AbortSignal;
  /** Starts the grace period once; later calls keep the original deadline. */
  start(): void;
  dispose(): void;
}

function createStopOutputRelease(graceMs: number): StopOutputRelease {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    signal: controller.signal,
    start() {
      if (timer || controller.signal.aborted) return;
      timer = setTimeout(() => controller.abort(), Math.max(0, graceMs));
      timer.unref?.();
    },
    dispose() {
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Waits for `work` unless the stop-output grace period ends first. Returns
 * false when the wait was released; rejections from `work` still propagate.
 */
function untilOutputReleased(work: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.resolve(false);
  }
  return new Promise<boolean>((settle, fail) => {
    const release = () => {
      void work.catch(() => undefined);
      settle(false);
    };
    signal.addEventListener('abort', release, { once: true });
    work.then(
      () => {
        signal.removeEventListener('abort', release);
        settle(true);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', release);
        fail(error);
      },
    );
  });
}

function summarizePrompt(prompt: string, attachmentCount: number): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized)
    return attachmentCount === 1
      ? "Attachment run"
      : `${attachmentCount} attachments`;
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}
