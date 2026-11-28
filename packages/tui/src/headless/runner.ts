import { resolve } from 'node:path';

import type { TuiAttachment } from '../application/invocation.js';
import { TuiRunCoordinator, sessionModelReference } from '../application/run-coordinator.js';
import type { TuiTurnRunOutcome } from '../application/turn-run-outcome.js';
import { createTuiTurnId } from '../application/turn-id.js';
import {
  resolveTurnExecutionFacts,
  resolveTurnModelFacts,
  type TuiTurnExecutionFacts,
} from '../application/turn-execution-facts.js';
import type {
  TuiAdvisorSelection,
  TuiConfigurationPort,
  TuiConversationPort,
  TuiActiveRunControlPort,
  TuiInspectionPort,
  TuiInteractionPort,
  TuiSession,
  TuiSessionPort,
  TuiSessionTurnPort,
} from '../runtime/port.js';
import {
  exitCodeForExecError,
  exitCodeForExecResult,
  MINIMAX_CODE_EXEC_EXIT_CODES,
  TuiExecError,
} from './exit-policy.js';
import {
  createHeadlessOutputEncoder,
  createNodeStreamWriter,
  writeHeadlessLastMessage,
  type TuiExecFormat,
  type TuiHeadlessOutputEncoder,
  type TuiOutputWrite,
} from './output.js';
import type { TuiPermissionPolicy } from './invocation.js';
import { parseHeadlessModelOverride, resolveHeadlessModelSelection } from './model-selection.js';
import { TuiFailure } from '../failure.js';
import { formatTuiExecFailure, formatTuiExecResultFailure } from './error-presentation.js';
import { MINIMAX_CODE_DEFAULT_AGENT_NAME } from '../product-context.js';
import { requireTuiAgentAccess } from '../application/login-gate.js';
import { formatTuiActionFailure } from '../user-facing-failure.js';
import { isTuiInternalSubagentSession } from '../runtime/delegation.js';
import { ExecRunSupervisor } from './supervisor.js';
import { createExecResult, validateExecOutput, type ExecResult } from './contract.js';
import { ExecEventProjector } from './events.js';
import {
  createPassingReviewResult,
  parseTuiReviewResult,
  renderReviewResultText,
  reviewOutcomeFromOrigin,
  type ReviewResultV1,
  type TuiReviewOutcome,
} from '../review/result.js';
import type { TuiStreamEvent } from '../runtime/stream-events.js';
import { ExecDiagnostics, outputSchemaHash } from './diagnostics.js';
import { waitForExecSettlement } from './settlement.js';
import { ExecProgress } from './progress.js';

export interface TuiExecInput {
  prompt: string;
  workspaceDir: string;
  version: string;
  attachments?: readonly TuiAttachment[];
  format?: TuiExecFormat;
  model?: string;
  effort?: string;
  advisor?: TuiAdvisorSelection;
  sessionId?: string;
  continueSession?: boolean;
  permission?: TuiPermissionPolicy;
  timeoutMs?: number;
  maxSteps?: number;
  outputSchema?: Readonly<Record<string, unknown>>;
  outputLastMessagePath?: string;
  reviewRequest?: { readonly scope: 'local_changes' };
  diagnosticsDir?: string;
}

export type TuiHeadlessRuntime = Pick<
  TuiSessionPort,
  'createSession' | 'getSession' | 'listSessionPage' | 'listMessagePage'
> &
  TuiConversationPort &
  TuiSessionTurnPort &
  TuiActiveRunControlPort &
  Pick<TuiInspectionPort, 'getSessionUsage'> &
  Pick<TuiInteractionPort, 'getPendingQuestionnaire' | 'listPendingPermissions'> &
  Pick<
    TuiConfigurationPort,
    | 'getAccountStatus'
    | 'listModels'
    | 'selectSessionAdvisor'
    | 'getAdvisorEnabled'
    | 'setAdvisorEnabled'
  >;

export interface TuiExecDependencies {
  runtime: TuiHeadlessRuntime;
  stdout?: TuiOutputWrite;
  stderr?: TuiOutputWrite;
  shutdown: () => Promise<void | boolean>;
  signal?: AbortSignal;
  processRef?: Pick<NodeJS.Process, 'once' | 'off'>;
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
        readonly lastMessage?: { readonly filePath: string; readonly answer: string };
      }
    | undefined;
  const diagnostics: string[] = [];
  let evidence: ExecDiagnostics | undefined;
  let answerSelection: Readonly<Record<string, unknown>> = {};
  let executionMetadata: Readonly<Record<string, unknown>> = {};
  let stoppedForRecovery = false;
  let originalAnswer: string | null | undefined;
  const progress = input.diagnosticsDir
    ? new ExecProgress((event) => evidence?.record({ ...executionMetadata, ...event }))
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
  let reviewTerminal: { readonly outcome: TuiReviewOutcome; readonly content: string } | undefined;

  let cancelled = dependencies.signal?.aborted ?? false;
  const cancel = () => {
    cancelled = true;
    // Shutdown can legitimately take a while; only bound the final output wait.
    if (finalOutputStarted) stopOutput.start();
    void coordinator.abort();
  };
  const assertNotCancelled = () => {
    if (cancelled) throw new TuiExecError('cancelled', 'Execution was cancelled.');
  };
  dependencies.signal?.addEventListener('abort', cancel, { once: true });
  processRef.once('SIGINT', cancel);
  processRef.once('SIGTERM', cancel);
  processRef.once('SIGHUP', cancel);
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
      dependencies.runtime,
      input.sessionId,
      undefined,
      undefined,
      loginModel ? { model: loginModel } : undefined,
    );
    assertNotCancelled();
    const session = await resolveSession(input, dependencies.runtime, assertNotCancelled);
    assertNotCancelled();
    await assertSessionHasNoPendingInteraction(dependencies.runtime, session);
    assertNotCancelled();
    const model = await resolveHeadlessModelSelection({
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      session,
      runtime: dependencies.runtime,
    });
    // The requested model is what this Run asked Runtime for: the resolved model
    // selection (--model, including the --effort default) else the Session's model.
    const requestedModel = model
      ? {
          providerId: model.providerId,
          modelId: model.modelId,
          ...(model.variant !== undefined ? { variant: model.variant } : {}),
        }
      : sessionModelReference(session);
    assertNotCancelled();
    if (input.advisor) {
      const notice = await applyHeadlessAdvisor(
        dependencies.runtime,
        input.advisor,
        session.sessionId,
      );
      if (notice) diagnostics.push(notice);
      assertNotCancelled();
    }
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
    evidence?.record({ kind: 'execution_started', sessionId: session.sessionId, turnId });
    const encoder = createHeadlessOutputEncoder(input.format ?? 'text', stdout, {
      ...(input.format === 'stream-json'
        ? {
            eventProjector: new ExecEventProjector({
              runId,
              sessionId: session.sessionId,
              turnId,
              resumed: Boolean(input.sessionId || input.continueSession),
            }),
          }
        : {}),
    });
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
                ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
                ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
                requireAnswer: true,
              },
            }
          : { policy: { requireAnswer: true } }),
      },
      async (event) => {
        let reviewOutcome: TuiReviewOutcome | undefined;
        if (event.type === 'message') {
          reviewOutcome = reviewOutcomeFromOrigin(event.message.origin);
          if (reviewOutcome) {
            reviewTerminal = {
              outcome: reviewOutcome,
              content: event.message.content ?? '',
            };
          }
        }
        progress?.observe(event);
        if (event.type === 'session-status') {
          evidence?.record({ kind: 'session_status', status: event.status });
        } else if (event.type === 'message' && event.message.role === 'assistant') {
          evidence?.record({
            kind: 'assistant_completed',
            messageId: event.message.id,
            finishReason: event.message.finishReason,
            requestDurationMs: event.message.usage?.requestDurationMs,
          });
        }
        try {
          await encoder.event(projectHeadlessReviewStreamEvent(event, reviewOutcome));
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
    if (input.reviewRequest && outcome.status === 'succeeded') {
      const projected = projectHeadlessReviewResult(reviewTerminal);
      if ('error' in projected) {
        outcome = {
          ...outcome,
          status: 'failed',
          answer: null,
          error: projected.error,
        };
      } else {
        reviewResult = projected.result;
      }
    }
    originalAnswer = outcome.answer;
    const validation =
      outcome.status === 'succeeded'
        ? validateExecOutput(outcome.answer, input.outputSchema)
        : undefined;
    const needsExecutionFacts = isMachineFormat(input.format) || Boolean(evidence);
    const facts: Partial<TuiTurnExecutionFacts> = needsExecutionFacts
      ? await resolveTurnExecutionFacts(
          dependencies.runtime,
          session.sessionId,
          turnId,
          outcome,
          requestedModel,
        )
      : {};
    // The replacement notice is not a machine-format feature: a plain text Run
    // reports it on stderr as well, so the default output format stays honest.
    const modelReplacement =
      facts.modelReplacement ??
      (needsExecutionFacts || !requestedModel
        ? undefined
        : (
            await resolveTurnModelFacts(
              dependencies.runtime,
              session.sessionId,
              turnId,
              outcome,
              requestedModel,
            )
          ).modelReplacement);
    if (modelReplacement) {
      diagnostics.push(formatModelReplacementWarning(modelReplacement));
    }
    const resultOptions = {
      runId,
      ...(validation ? { validation } : {}),
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      ...(facts.requestedModel ? { requestedModel: facts.requestedModel } : {}),
      ...(modelReplacement ? { modelReplacement } : {}),
      ...(facts.model
        ? {
            model: {
              ...facts.model,
              ...(input.outputSchema && outcome.status === 'succeeded'
                ? { structuredOutputMode: 'native_strict' as const }
                : {}),
            },
          }
        : {}),
      ...(facts.usage ? { usage: facts.usage } : {}),
      ...(facts.usage ? { usageTotalIncludesCacheRead: true } : {}),
      ...('usageSource' in facts
        ? { usageSource: facts.usageSource, usageIncomplete: facts.usageIncomplete }
        : {}),
    };
    const execResult = createExecResult(outcome, resultOptions);
    const result: ExecResult = reviewResult ? { ...execResult, output: reviewResult } : execResult;
    if (evidence && result.status === 'timeout') {
      stoppedForRecovery = await waitForExecSettlement(dependencies.runtime, session.sessionId);
      evidence.record({ kind: 'stop_confirmed', stopped: stoppedForRecovery });
    }
    executionMetadata = {
      ...executionMetadata,
      model: facts.model,
      status: result.status,
      durationMs: result.durationMs,
    };
    if (result.status !== 'succeeded') {
      evidence?.failure(outcome.answer, {
        ...progress?.summary(),
        ...answerSelection,
        error: result.error,
        status: result.status,
        ...(validation && !validation.ok ? { validationKind: validation.kind } : {}),
      });
    }
    terminal = {
      encoder,
      result,
      ...(result.status === 'succeeded' && input.outputLastMessagePath
        ? {
            lastMessage: {
              filePath: input.outputLastMessagePath,
              answer: reviewResult ? renderReviewResultText(reviewResult) : (outcome.answer ?? ''),
            },
          }
        : {}),
    };
  } catch (error) {
    const normalized = normalizeRunError(error);
    evidence?.failure(undefined, { error: { message: normalized.message }, phase: 'execution' });
    exitCode = exitCodeForExecError(normalized);
    if (exitCode !== MINIMAX_CODE_EXEC_EXIT_CODES.brokenPipe) {
      diagnostics.push(`mcode exec failed: ${formatTuiExecFailure(normalized)}\n`);
    }
  } finally {
    // Signal listeners stay attached until final output finishes, so a signal
    // that arrives while stdout is blocked still bounds the remaining wait.
    let shutdownFailure: string | undefined;
    let shutdownFailurePublished = false;
    try {
      const shutdownFailed = await dependencies.shutdown();
      if (shutdownFailed === true) shutdownFailure = 'Runtime shutdown did not complete cleanly.';
    } catch (error) {
      shutdownFailure = formatTuiActionFailure(error, {
        summary: 'mcode exec shutdown failed.',
        nextStep: 'Verify no process is still running.',
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
      if (shutdownFailure && terminal.result.status === 'succeeded') {
        terminal.result = internalFailureResult(
          terminal.result,
          'RUNTIME_SHUTDOWN_FAILED',
          shutdownFailure,
        );
        shutdownFailurePublished = true;
      }
      if (terminal.result.status === 'succeeded' && terminal.lastMessage) {
        try {
          await writeHeadlessLastMessage(
            terminal.lastMessage.filePath,
            terminal.lastMessage.answer,
          );
        } catch (error) {
          terminal.result = internalFailureResult(
            terminal.result,
            'OUTPUT_LAST_MESSAGE_WRITE_FAILED',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      try {
        if (
          terminal.result.status !== 'succeeded' &&
          terminal.result.error?.category === 'internal'
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
        if (terminal.result.status !== 'succeeded') {
          diagnostics.push(
            `mcode exec ${terminal.result.status}: ${formatTuiExecResultFailure(terminal.result)}\n`,
          );
        }
      } catch (error) {
        const normalized = normalizeRunError(error);
        exitCode = exitCodeForExecError(normalized);
        if (exitCode !== MINIMAX_CODE_EXEC_EXIT_CODES.brokenPipe) {
          diagnostics.push(`mcode exec failed: ${formatTuiExecFailure(normalized)}\n`);
        }
      }
    } else if (shutdownFailure && exitCode !== MINIMAX_CODE_EXEC_EXIT_CODES.brokenPipe) {
      exitCode = MINIMAX_CODE_EXEC_EXIT_CODES.internal;
    }
    if (shutdownFailure && !shutdownFailurePublished) diagnostics.push(`${shutdownFailure}\n`);
    evidence?.execution({
      ...executionMetadata,
      endedAt: Date.now(),
      shutdownComplete: !shutdownFailure,
      exitCode,
    });
    evidence?.record({
      kind: 'execution_finished',
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
        if (!(await untilOutputReleased(writeDiagnostic(stderr, diagnostic), stopOutput.signal))) {
          break;
        }
      }
    }
    stopOutput.dispose();
    dependencies.signal?.removeEventListener('abort', cancel);
    processRef.off('SIGINT', cancel);
    processRef.off('SIGTERM', cancel);
    processRef.off('SIGHUP', cancel);
  }
  return exitCode;
}

function projectHeadlessReviewResult(
  terminal: { readonly outcome: TuiReviewOutcome; readonly content: string } | undefined,
):
  | { readonly result: ReviewResultV1 }
  | { readonly error: NonNullable<TuiTurnRunOutcome['error']> } {
  if (!terminal) {
    return {
      error: {
        category: 'runtime',
        code: 'REVIEW_RESULT_MISSING',
        message: 'Runtime completed without a validated code review result.',
        retryable: true,
      },
    };
  }
  if (terminal.outcome === 'failed') {
    return {
      error: {
        category: 'runtime',
        code: 'REVIEW_RESULT_INVALID',
        message: terminal.content.trim() || 'Runtime rejected an invalid code review result.',
        retryable: true,
      },
    };
  }
  const result =
    terminal.outcome === 'pass'
      ? createPassingReviewResult(terminal.content)
      : parseTuiReviewResult(terminal.content);
  return result
    ? { result }
    : {
        error: {
          category: 'runtime',
          code: 'REVIEW_RESULT_INVALID',
          message: 'Runtime returned an invalid code review result.',
          retryable: true,
        },
      };
}

function projectHeadlessReviewStreamEvent(
  event: TuiStreamEvent,
  outcome: TuiReviewOutcome | undefined,
): TuiStreamEvent {
  if (event.type !== 'message' || outcome !== 'needs_changes') return event;
  const result = parseTuiReviewResult(event.message.content ?? '');
  return {
    ...event,
    message: {
      ...event.message,
      content: result
        ? renderReviewResultText(result)
        : 'Runtime returned an invalid code review result.',
    },
  };
}

function internalFailureResult(result: ExecResult, code: string, message: string): ExecResult {
  return {
    ...result,
    status: 'failed',
    output: undefined,
    error: { category: 'internal', code, message, retryable: false },
  };
}

function toHeadlessOutcome(outcome: TuiTurnRunOutcome): TuiTurnRunOutcome {
  if (outcome.status !== 'awaiting-user-continuation') return outcome;
  return {
    ...outcome,
    status: 'failed',
    error: {
      category: 'runtime',
      code: 'INTERACTION_NOT_AVAILABLE',
      message: 'The Runtime requested user interaction from a non-interactive Exec host.',
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
  const interaction = questionnaire ? 'a pending questionnaire' : 'a pending permission request';
  throw new TuiExecError(
    'runtime',
    `Session ${session.sessionId} has ${interaction} and requires an interactive host. Continue it in the TUI or ACP.`,
  );
}

/**
 * `--advisor` writes only this Session's advisor, after every other check so a rejected Run
 * leaves an existing Session as it was. A selection Runtime refuses is a configuration error.
 * A model is an explicit choice to use the advisor, so it also turns the global switch on when
 * it is off; the returned notice says so on stderr.
 */
async function applyHeadlessAdvisor(
  runtime: TuiHeadlessRuntime,
  selection: TuiAdvisorSelection,
  sessionId: string,
): Promise<string | undefined> {
  const requested = selection.enabled ? `${selection.providerId}/${selection.modelId}` : 'off';
  if (!runtime.selectSessionAdvisor) {
    throw new TuiExecError(
      'config',
      `--advisor ${requested} cannot be applied: this Runtime has no advisor.`,
    );
  }
  try {
    await runtime.selectSessionAdvisor(selection, sessionId);
    if (!selection.enabled || (await runtime.getAdvisorEnabled?.()) !== false) return undefined;
    await runtime.setAdvisorEnabled?.(true);
  } catch (error) {
    throw new TuiExecError(
      'config',
      `--advisor ${requested} could not be applied: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return 'Notice: --advisor turned the advisor on for all sessions (advisor.enabled in config.yaml); turn it off in Settings or with /advisor off.';
}

function formatModelReplacementWarning(
  replacement: NonNullable<TuiTurnExecutionFacts['modelReplacement']>,
): string {
  return (
    `Warning: requested model ${formatModelReference(replacement.requestedModel)} was replaced with ` +
    `${formatModelReference(replacement.actualModel)} by tier ${replacement.tier} ` +
    `(${replacement.reason}).\n`
  );
}

function formatModelReference(model: {
  readonly providerId: string;
  readonly modelId: string;
}): string {
  return `${model.providerId}/${model.modelId}`;
}

function isMachineFormat(format: TuiExecFormat | undefined): boolean {
  return format === 'json' || format === 'stream-json';
}

function normalizeRunError(error: unknown): TuiExecError {
  if (error instanceof TuiExecError) return error;
  if (error instanceof TuiFailure) {
    const kind =
      error.category === 'config' ||
      error.category === 'invocation' ||
      error.category === 'cancelled' ||
      error.category === 'brokenPipe' ||
      error.category === 'internal'
        ? error.category
        : 'runtime';
    return new TuiExecError(kind, error.message, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new TuiExecError('runtime', message, { cause: error });
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
        'runtime',
        `No active Session exists for workspace ${input.workspaceDir}; omit --continue to start a new Session.`,
        { retryable: false },
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
    throw new TuiExecError('invocation', 'Sub-agent Sessions are internal and cannot be opened.');
  }
  if (session.archived) {
    throw new TuiExecError(
      'runtime',
      `Session ${session.sessionId} is archived; unarchive it in MCode or start a new Session.`,
      { retryable: false },
    );
  }
  if (!session.workspaceDir) {
    throw new TuiExecError(
      'runtime',
      `Session ${session.sessionId} has no recorded workspace and cannot be continued.`,
      { retryable: false },
    );
  }
  if (!sameWorkspace(session.workspaceDir, workspaceDir)) {
    throw new TuiExecError(
      'runtime',
      `Session ${session.sessionId} belongs to workspace ${session.workspaceDir}, not --cwd ${workspaceDir}; rerun with --cwd ${session.workspaceDir}.`,
      { retryable: false },
    );
  }
}

function sameWorkspace(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function writeDiagnostic(write: TuiOutputWrite, value: string): Promise<void> {
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
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (!normalized)
    return attachmentCount === 1 ? 'Attachment run' : `${attachmentCount} attachments`;
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}
