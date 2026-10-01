import {
  createContinuationControl,
  resolveChildBashSteeringContext,
  prepareInitialImmediateSendBatch,
  withGenuineQueryProvenance,
} from './user-input-control.js';
import {
  type LLMModelConfig,
  type PiBeforeLlmCallHook,
  type PiBeforeLlmCallHookInput,
  type PiEventWriter,
  type PiTurnHooks,
  type RunTurnCaller,
  type RunTurnInput,
  type UserMessageInput,
  toPiUserMessage,
} from '@mavis/agent-core/pi-turn-runner';
import { type RuntimeTool, type ToolExecutionContext } from '@mavis/agent-core/tools';
import { prepareBashTurnTools } from '../assembly/local-turn-tool-catalog.js';
import { buildCompletedTerminalStatusEvent } from '@mavis/agent-core/event-bridge';
import {
  beginLocalPluginHookTurn,
  createLocalPluginHookEventReporter,
  emitLocalPluginHookWarnings,
  localPluginHookCoordinator as pluginHookCoordinator,
} from '../assembly/local-turn-plugin-hooks.js';
import type { HistoryReconcileIntent } from '../history/contracts.js';
import { copyCanonicalHistoryForPiCompatibility } from '../history/canonical-history-validation.js';
import type { AgentExecutionSnapshot, TurnOutputContract } from '../preparation/contracts.js';
import type {
  AgentHostSteeringMessage,
  AgentHostTurnOutcome,
  LocalTurnExecutionInput,
  LocalTurnExecutor,
} from '../runner/contracts.js';
import {
  assertLocalOutputFormatCapability,
  buildTurnPayloadTransforms,
} from '../assembly/local-turn-payload-transform.js';
import {
  AgentHostDependencyUnavailableError,
  assertAgentHostCapabilityAvailable,
} from '../empty-dependencies.js';
import {
  createLocalTurnEventWriter,
  type LocalTurnEventWriter,
} from '../events/runtime-event-writer.js';
import { AgentEventAssociationError } from '../local-agent-host.js';
import { inputReviewRunnerOptions } from '../runner/policy/input-review-runner-options.js';
import { createLocalCuScreenshotPruner } from '../runner/local-cu-screenshot-pruner.js';
import { applyProcessLocalToolResultPolicy } from '../runner/policy/process-local-tool-result-policy.js';
import type {
  LocalContextUsagePromptRange,
  LocalRuntimeTurnExecutorOptions,
  LocalRuntimeTurnRunnerResult,
  LocalTurnHookMergeOptions,
  LocalTurnPermissionResolution,
  PreparedSteeringUserMessage,
} from './contracts.js';
import {
  joinPrompt,
  joinUserPrompt,
  readPreparedContextUsagePromptRanges,
  readPreparedSystemPrompt,
  renderAgentRuntimeReminders,
} from './prompt.js';
import {
  createAgentHostPluginHookTranscript,
  type AgentHostPluginHookTranscript,
} from '../tools/index.js';
import { withPluginAutomaticCompactionLifecycle } from './plugin-hook-compaction-lifecycle.js';
import { createControlledToolHooks } from './plugin-hook-tool-lifecycle.js';
import { createExecutionBudgetReminder } from '../runner/execution-budget-reminder.js';
import { withExecutionObservability } from './execution-observability.js';
import {
  ackCommittedToolResultTailClaims,
  attachCommittedFacts,
  attachWaitingForUser,
  continuationRunMode,
  contentReviewOptions,
  hostOutputTokenCap,
  providerHistory,
  resolveLlmRetryOptions,
} from './turn-execution-policy.js';

export type {
  LocalRuntimeTurnExecutorOptions,
  LocalRuntimeTurnReconcileSignal,
  LocalRuntimeTurnRunnerPort,
  LocalRuntimeTurnRunnerInput,
  LocalRuntimeTurnRunnerResult,
  LocalRuntimeTurnRuntimeOutcome,
  LocalRuntimeTurnToolContext,
  LocalTurnEventWriter,
  LocalTurnExecutionPreparation,
  LocalTurnExecutionPreparationSource,
  LocalTurnFileChangeLifecycle,
  LocalTurnPermissionResolution,
} from './contracts.js';

export type {
  LocalTurnOutputTokenCapResolver,
  LocalTurnToolPolicyGuard,
} from '../runner/contracts.js';

type PiAgentMessage = NonNullable<RunTurnInput['history']>[number];
type LocalPluginHookAdmissionTransaction = Awaited<
  ReturnType<typeof beginLocalPluginHookTurn>
>['transaction'];
interface LocalPluginSubagentInput {
  readonly childSessionId: string;
  readonly childTurnId: string;
  readonly agentId?: string;
  readonly agentType: string;
  readonly agentTranscriptPath?: string;
  readonly agentCodexTranscriptPath?: string;
}

/**
 * Host-owned orchestration around a neutral runtime port. All work that can
 * fail before runtime invocation stays inside `execute()`, so LocalAgentHost
 * can commit exactly one failed terminal before receipt/release.
 */
export class LocalRuntimeTurnExecutor<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
  TContext extends ToolExecutionContext = ToolExecutionContext,
> implements LocalTurnExecutor<TAgent> {
  constructor(private readonly options: LocalRuntimeTurnExecutorOptions<TAgent, TContext>) {
    validateOptions(options);
  }
  async execute(input: LocalTurnExecutionInput<TAgent>): Promise<AgentHostTurnOutcome> {
    let unboundPluginHookTranscriptCleanup: (() => Promise<void>) | undefined;
    try {
      const eventWriter = createLocalTurnEventWriter(input, this.options.projectRuntimeEvent, {
        retainEvents: this.options.runtime.acceptsEventSummary !== true,
      });
      const pluginHookEventReporter = createLocalPluginHookEventReporter({
        writer: eventWriter,
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        ...(this.options.tuiProductPolicy === true
          ? { terminalSequenceSurface: 'tui' as const }
          : {}),
      });
      const pluginHookProjection = input.pluginHooks?.length
        ? await this.resolvePluginHookProjection(input)
        : { runtimeContext: this.resolvePluginHookRuntimeContext(input) };
      const pluginHookTranscriptWriter = pluginHookProjection.writer;
      unboundPluginHookTranscriptCleanup = pluginHookTranscriptCleanup(pluginHookTranscriptWriter);
      const pluginHookRuntimeContext = pluginHookProjection.runtimeContext;
      const contextualInput = input.pluginHooks?.length
        ? {
            ...input,
            pluginHookRuntimeContext,
            pluginHookEventReporter,
            ...(pluginHookTranscriptWriter ? { pluginHookTranscriptWriter } : {}),
          }
        : { ...input, pluginHookEventReporter };
      const clearPluginHookSessionPermissions = this.options.clearPluginHookSessionPermissions;
      const sessionOwnershipClaim = resolvePluginHookSessionOwnershipClaim(
        this.options.preparePluginHookSessionOwnership,
        input.lease.leaseId,
      );
      if (sessionOwnershipClaim) {
        await this.options.preparePluginHookSessionOwnership?.({
          sessionId: input.lease.sessionId,
          turnId: input.lease.turnId,
          ownershipClaimId: sessionOwnershipClaim,
        });
      }
      const admission = await beginLocalPluginHookTurn(contextualInput, {
        ...pluginHookRuntimeContext,
        ...(pluginHookTranscriptWriter
          ? { transcriptCleanup: () => pluginHookTranscriptWriter.cleanup() }
          : {}),
        ...(clearPluginHookSessionPermissions
          ? {
              sessionEndCleanup: () => clearPluginHookSessionPermissions(input.lease.sessionId),
            }
          : {}),
      });
      unboundPluginHookTranscriptCleanup = undefined;
      await this.commitPluginHookAdmission(input, admission.transaction, sessionOwnershipClaim);
      if (admission.kind !== 'continue') {
        if (admission.kind === 'deny') throw new Error(admission.reason);
        await eventWriter.pushRuntime(
          buildCompletedTerminalStatusEvent({
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            statusEventId: `${input.lease.turnId}:plugin-hook-stop`,
          }),
        );
        return input.resolveTerminalOutcome();
      }
      return await this.executeTurn(admission.input, eventWriter);
    } finally {
      await cleanupPluginHookTranscriptBestEffort(unboundPluginHookTranscriptCleanup);
      pluginHookCoordinator.resumeIdleCountdown(input.lease.sessionId);
    }
  }

  private async commitPluginHookAdmission(
    input: LocalTurnExecutionInput<TAgent>,
    transaction: LocalPluginHookAdmissionTransaction,
    sessionOwnershipClaim: string | undefined,
  ): Promise<void> {
    if (!sessionOwnershipClaim) {
      await transaction.commit();
      return;
    }
    const previousSessionOwnershipClaim = pluginHookCoordinator.bindSessionOwnershipClaim(
      input.lease.sessionId,
      sessionOwnershipClaim,
    );
    try {
      await this.options.activatePluginHookSessionOwnership?.({
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        ownershipClaimId: sessionOwnershipClaim,
      });
      await transaction.commit();
    } catch (error) {
      pluginHookCoordinator.rollbackSessionOwnershipClaim(
        input.lease.sessionId,
        sessionOwnershipClaim,
        previousSessionOwnershipClaim,
      );
      await transaction.rollback();
      throw error;
    }
  }

  private resolvePluginHookRuntimeContext(
    input: LocalTurnExecutionInput<TAgent>,
  ): NonNullable<LocalTurnExecutionInput['pluginHookRuntimeContext']> {
    const host =
      input.pluginHookRuntimeContext ??
      this.options.resolvePluginHookRuntimeContext?.(input.session) ??
      {};
    return {
      ...host,
      model: input.preparation.llm.model.id,
      promptId: input.lease.turnId,
    };
  }

  private async resolvePluginHookProjection(input: LocalTurnExecutionInput<TAgent>): Promise<{
    readonly runtimeContext: NonNullable<LocalTurnExecutionInput['pluginHookRuntimeContext']>;
    readonly writer?: AgentHostPluginHookTranscript;
  }> {
    const runtimeContext = this.resolvePluginHookRuntimeContext(input);
    if (!runtimeContext.transcriptPath) return { runtimeContext };
    try {
      const writer = await createAgentHostPluginHookTranscript({
        cwd: input.session.workspaceDir,
        sessionId: input.lease.sessionId,
        messages: copyCanonicalHistoryForPiCompatibility(input.history.messages),
      });
      return {
        writer,
        runtimeContext: {
          ...runtimeContext,
          transcriptPath: writer.path,
          codexTranscriptPath: writer.codexPath,
        },
      };
    } catch {
      return {
        runtimeContext: {
          ...runtimeContext,
          transcriptPath: null,
          codexTranscriptPath: null,
        },
      };
    }
  }

  private async executeTurn(
    input: LocalTurnExecutionInput<TAgent>,
    eventWriter: LocalTurnEventWriter,
  ): Promise<AgentHostTurnOutcome> {
    const prepared = await this.prepareRunnerInput(input, eventWriter);
    const outputContract = input.request.outputContract;
    assertLocalOutputFormatCapability(
      input.preparation.llm.model,
      outputContract,
      input.preparation.llm.supportsJsonObjectOutput === true,
    );
    await this.beginFileChanges(input);
    let settled: SettledRuntimeTurn<TContext>;
    try {
      settled = await this.runPreparedTurn(input, prepared, eventWriter, outputContract);
    } catch (error) {
      return this.throwWithFileFailure(input, error);
    }
    return this.settleTurn(input, settled);
  }

  private async runPreparedTurn(
    input: LocalTurnExecutionInput<TAgent>,
    prepared: PreparedRunnerInput<TContext>,
    eventWriter: LocalTurnEventWriter,
    outputContract: TurnOutputContract | undefined,
  ): Promise<SettledRuntimeTurn<TContext>> {
    const pendingToolResultTailClaims = new Set<string>();
    const readTaskOutputTaskIds = prepared.readTaskOutputTaskIds;
    const terminalTaskOutputReadIds = new Set<string>();
    const continuation = createContinuationControl(
      input,
      prepared.prepareSteering,
      this.options.onSteeringConsumed,
    );
    const toolSafetyGuard = this.options.createTurnToolSafetyGuard?.();
    const payloadTransforms = buildTurnPayloadTransforms(input, outputContract, this.options);
    const childBash = this.options.createChildBashLifecycle?.({
      session: input.session,
      turnId: input.lease.turnId,
      signal: input.lease.signal,
    });
    let runnerResult: LocalRuntimeTurnRunnerResult | void;
    try {
      runnerResult = await this.options.runtime.runTurn({
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        workspaceDir: input.session.workspaceDir,
        systemPrompt: prepared.systemPrompt,
        promptMetadata: (
          input.preparation.agentConfig as { prompt_metadata?: Readonly<Record<string, unknown>> }
        ).prompt_metadata,
        userMessage: prepared.userMessage,
        ...(prepared.beforeUserMessages.length > 0
          ? { beforeUserMessages: prepared.beforeUserMessages }
          : {}),
        outputRevisionInstruction: input.preparation.outputRevisionInstruction,
        ...continuationRunMode(input),
        ...inputReviewRunnerOptions(input, this.options.onInputReviewResolved),
        ...contentReviewOptions(input, this.options),
        ...(this.options.tuiProductPolicy === true ? { deferInputReviewResolution: true } : {}),
        llm: {
          ...prepared.llm,
          ...hostOutputTokenCap(this.options.outputTokenCap, input),
          ...payloadTransforms,
        },
        eventWriter,
        eventIdGenerator: input.pluginHookEventReporter?.nextEventId,
        runtimeSeqGenerator: input.pluginHookEventReporter?.nextRuntimeSeq,
        history: prepared.history,
        signal: input.lease.signal,
        tools: prepared.tools,
        disableBuiltinToolFallback: prepared.toolResolution.disableBuiltinToolFallback,
        toolContext: prepared.toolContext,
        hooks: withExecutionObservability(
          mergeHooks({
            input,
            toolResolution: prepared.toolResolution,
            pendingToolResultTailClaims,
            hostBeforeLlmCallHooks: prepared.beforeLlmCallHooks,
            readTaskOutputTaskIds,
            terminalTaskOutputReadIds,
            toolsDisabled: this.options.disableTools === true,
            toolSafetyGuard,
            toolPolicyGuard: this.options.toolPolicyGuard,
            finalizeToolResultForHistory: this.options.finalizeToolResultForHistory,
          }),
          input.request.provenance.sourceContext?.executionDiagnostics === true,
        ),
        caller: prepared.caller,
        getSteeringMessages: async (context) => {
          for (;;) {
            // Subscribe before draining so an append racing the wait cannot be missed.
            const steeringSignal = input.control.steeringSignal?.();
            const steeringContext = await resolveChildBashSteeringContext(context, childBash);
            const messages = (await continuation.getSteeringMessages?.(steeringContext)) ?? [];
            const notice = await childBash?.poll({
              wait:
                context?.boundary === 'exit' &&
                messages.length === 0 &&
                !continuation.shouldStopAfterSteering?.(),
              readTaskIds: terminalTaskOutputReadIds,
              ...(steeringSignal ? { steeringSignal } : {}),
            });
            if (notice) return [...messages, toPiUserMessage({ text: notice })];
            if (messages.length > 0 || !childBash || !steeringSignal?.aborted) return messages;
          }
        },
        shouldStopAfterSteering: continuation.shouldStopAfterSteering,
        tryBeginClose: continuation.tryBeginClose,
        llmRetry: await resolveLlmRetryOptions(input, this.options),
        // Desktop and TUI both consume provider-measured output throughput.
        ...(this.options.cliProductPolicy !== true || this.options.tuiProductPolicy === true
          ? { includeDetailedUsage: true }
          : {}),
        ...(prepared.contextUsagePromptRanges !== undefined
          ? {
              contextUsagePromptRanges: prepared.contextUsagePromptRanges,
              contextUsageRequiresProviderAnchor: prepared.contextUsageRequiresProviderAnchor,
            }
          : {}),
        recallOutputAttemptHistory: async (attempt) => {
          if (!input.recallOutputAttemptHistory) {
            throw new AgentHostDependencyUnavailableError('history-retract-turn');
          }
          await input.recallOutputAttemptHistory(attempt);
          input.rearmPrimaryUserMessageIdAfterOutputRecall();
        },
        onOutputRecall: (recall) =>
          this.options.attemptRecall.recallAssistantAttempt({
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            attempt: recall.attempt,
            messageIds: recall.messageIds,
          }),
        ...(this.options.captureToolTiming?.(input) ? { captureToolTiming: true } : {}),
      });
    } finally {
      await childBash?.close();
    }
    return {
      outcome: attachWaitingForUser(
        input.resolveTerminalOutcome(reconcileIntent(runnerResult)),
        runnerResult?.outcome?.waitingForUser === true,
      ),
      prepared,
      readTaskOutputTaskIds,
      runnerResult,
    };
  }

  private async settleTurn(
    input: LocalTurnExecutionInput<TAgent>,
    settled: SettledRuntimeTurn<TContext>,
  ): Promise<AgentHostTurnOutcome> {
    try {
      const observation = await this.options.fileChanges.finalize({
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        ...(settled.runnerResult?.outcome?.messageId
          ? { assistantMessageId: settled.runnerResult.outcome.messageId }
          : {}),
      });
      return attachCommittedFacts(settled.outcome, observation, settled.readTaskOutputTaskIds);
    } catch (error) {
      return this.throwWithFileFailure(input, error);
    }
  }

  private async throwWithFileFailure(
    input: LocalTurnExecutionInput<TAgent>,
    error: unknown,
  ): Promise<never> {
    const fileFailure = await this.markFileChangesFailed(input);
    if (fileFailure !== undefined) {
      throw new AggregateError(
        [error, fileFailure],
        'Agent Turn failed and file-change failure projection also failed.',
      );
    }
    throw error;
  }

  private async prepareRunnerInput(
    input: LocalTurnExecutionInput<TAgent>,
    eventWriter: PiEventWriter,
  ): Promise<PreparedRunnerInput<TContext>> {
    const { maxRequestBodyBytes, ...preparedLlm } = input.preparation.llm;
    const llm: LLMModelConfig = {
      ...preparedLlm,
      ...(maxRequestBodyBytes === undefined
        ? {}
        : { maxSerializedInputBytes: maxRequestBodyBytes }),
    };
    const baseSystemPrompt = readPreparedSystemPrompt(input.preparation.agentConfig);
    const preparedExecution = await this.options.executionPreparation.prepare({
      execution: input,
      eventWriter,
    });
    const readTaskOutputTaskIds = new Set<string>();
    const toolResolution = preparedExecution.toolResolution;
    const admittedTools = applyProcessLocalToolResultPolicy(
      validateRoutedTurnTools(input.assembly.tools),
      this.options.cliProductPolicy === true,
    );
    const canConsumeBackgroundBashOutput = admittedTools.some(
      (tool) =>
        tool.def.name === 'task_output' && (tool.source === undefined || tool.source === 'builtin'),
    );
    const tools = prepareBashTurnTools(admittedTools, canConsumeBackgroundBashOutput);
    const toolContext = {
      ...toolResolution.context,
      ...(input.pluginHooks?.length
        ? { pluginSubagentLifecycle: createPluginSubagentLifecycle(input) }
        : {}),
      // Use admitted tools, including frozen selectors and final routing. A
      // configured/MCP namesake cannot read the native background task store.
      allowBashAutoPromotion: canConsumeBackgroundBashOutput,
      canConsumeBackgroundBashOutput,
    } as TContext;
    const caller = preparedExecution.caller;
    const systemPrompt = joinPrompt(input.assembly.systemPromptPrefix, baseSystemPrompt);
    const contextUsagePromptRanges = readPreparedContextUsagePromptRanges(
      input.preparation.agentConfig,
      input.assembly.systemPromptPrefix,
      baseSystemPrompt,
    );
    input.onContextUsagePromptRangesResolved?.(contextUsagePromptRanges);
    const userPromptPrefix = joinUserPrompt(
      input.assembly.userPromptPrefix,
      renderAgentRuntimeReminders(input.assembly.reminders),
      joinPrompt(
        preparedExecution.reminderBlocks.join('\n\n'),
        input.pluginHookContext
          ? `<plugin-hook-context>\n${input.pluginHookContext}\n</plugin-hook-context>`
          : '',
      ),
      '',
    );
    let userMessage = withGenuineQueryProvenance(
      {
        ...preparedExecution.userMessage,
        text: joinUserPrompt(
          userPromptPrefix,
          '',
          '',
          preparedExecution.promptText ?? input.canonicalUserInput.text,
        ),
      },
      preparedExecution.genuineUserQueryText ?? input.request.genuineUserQueryText,
    );
    const history = copyCanonicalHistoryForPiCompatibility(providerHistory(input));
    const batchMessages = prepareInitialImmediateSendBatch(
      input,
      {
        messages: preparedExecution.initialBatchMessages,
        genuineUserQueryTexts: preparedExecution.initialBatchGenuineUserQueryTexts,
      },
      userMessage,
      userPromptPrefix,
    );
    const beforeBatchMessages = batchMessages.slice(0, -1).map(toPiUserMessage);
    userMessage = batchMessages.at(-1)!;
    const canonicalMessages = [...history, ...beforeBatchMessages, toPiUserMessage(userMessage)];
    const initialHookInput = createInitialHookInput({
      sessionId: input.lease.sessionId,
      turnId: input.lease.turnId,
      signal: input.lease.signal,
      llm,
      canonicalMessages,
      systemPrompt,
      tools,
      eventWriter,
    });
    const backgroundReminder = await this.options.backgroundCadenceReminder?.prepare({
      hookInput: initialHookInput,
      loadFacts: preparedExecution.loadBackgroundReminder,
      hasSuccessfulTaskOutputRead: () => readTaskOutputTaskIds.size > 0,
    });
    const beforeLlmCallHooks = await this.resolveBeforeLlmCallHooks(
      input,
      afterCompactionReminderHooks(
        createExecutionBudgetReminder(
          input.request.executionDeadlineAtMs,
          this.options.nowMs,
          this.options.canAppendExecutionBudgetReminder,
          this.options.logger,
        ),
        backgroundReminder?.hook,
      ),
    );
    validateResolvedInput({
      input,
      llm,
      systemPrompt,
      userMessage,
      tools: toolResolution,
      toolContext,
      beforeLlmCallHooks,
    });
    return {
      llm,
      systemPrompt,
      userMessage,
      history,
      beforeUserMessages: [
        ...(backgroundReminder?.beforeUserMessages ?? []),
        ...beforeBatchMessages,
      ],
      tools,
      toolResolution,
      toolContext,
      beforeLlmCallHooks,
      caller,
      ...(contextUsagePromptRanges !== undefined
        ? {
            contextUsagePromptRanges,
            contextUsageRequiresProviderAnchor: input.preparation.llm.managedProvider !== true,
          }
        : {}),
      readTaskOutputTaskIds,
      prepareSteering: preparedExecution.prepareSteering ?? preparePlainSteering,
    };
  }

  private async resolveBeforeLlmCallHooks(
    input: LocalTurnExecutionInput<TAgent>,
    afterCompactionHooks: readonly PiBeforeLlmCallHook[] = [],
  ): Promise<readonly PiBeforeLlmCallHook[]> {
    return [
      ...((await this.options.resolveBeforeLlmCallHooks?.(input)) ?? []),
      createLocalCuScreenshotPruner(2),
      ...(input.contextCompactionHook
        ? [withPluginAutomaticCompactionLifecycle(input.contextCompactionHook, input)]
        : []),
      ...afterCompactionHooks,
      ...(this.options.afterCompactionBeforeLlmCallHooks ?? []),
    ];
  }

  private async beginFileChanges(input: LocalTurnExecutionInput<TAgent>): Promise<void> {
    try {
      await this.options.fileChanges.begin({
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        agentName: input.agent.agentName,
        workspaceDir: input.session.workspaceDir,
      });
    } catch (error) {
      this.reportBestEffortFailure(
        input.lease.sessionId,
        `local_turn_diff_begin_failed:${describeUnknownError(error)}`,
      );
    }
  }

  private async markFileChangesFailed(
    input: LocalTurnExecutionInput<TAgent>,
  ): Promise<unknown | undefined> {
    try {
      await this.options.fileChanges.markFailed({
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
      });
      return undefined;
    } catch (error) {
      this.reportBestEffortFailure(
        input.lease.sessionId,
        `local_turn_diff_failed:${describeUnknownError(error)}`,
      );
      return error;
    }
  }

  private reportBestEffortFailure(sessionId: string, message: string): void {
    try {
      this.options.reportFailure?.(sessionId, message);
    } catch {
      // Diagnostic reporting cannot replace the owning Turn failure.
    }
  }
}

function createPluginSubagentLifecycle<TAgent extends AgentExecutionSnapshot>(
  input: LocalTurnExecutionInput<TAgent>,
) {
  return {
    start: (child: LocalPluginSubagentInput, signal?: AbortSignal) =>
      startPluginSubagent(input, child, signal),
    cancel: (childSessionId: string) => pluginHookCoordinator.cancelSubagent(childSessionId),
  };
}

async function startPluginSubagent<TAgent extends AgentExecutionSnapshot>(
  input: LocalTurnExecutionInput<TAgent>,
  child: LocalPluginSubagentInput,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const decision = await pluginHookCoordinator.startSubagent(
    buildPluginSubagentRegistration(input, child),
    signal,
  );
  await emitLocalPluginHookWarnings({
    reporter: input.pluginHookEventReporter,
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    event: 'SubagentStart',
    decision,
  });
  if (decision.continue === false) {
    throw new Error(decision.stopReason ?? 'Subagent stopped by Plugin Hook.');
  }
  return decision.additionalContext;
}

function buildPluginSubagentRegistration<TAgent extends AgentExecutionSnapshot>(
  input: LocalTurnExecutionInput<TAgent>,
  child: LocalPluginSubagentInput,
) {
  const runtimeContext = input.pluginHookRuntimeContext;
  return {
    handlers: input.pluginHooks ?? [],
    parentSessionId: input.lease.sessionId,
    parentTurnId: input.lease.turnId,
    parentPromptId: runtimeContext?.promptId ?? input.lease.turnId,
    childSessionId: child.childSessionId,
    childTurnId: child.childTurnId,
    cwd: input.session.workspaceDir,
    ...(runtimeContext?.transcriptPath !== undefined
      ? { parentTranscriptPath: runtimeContext.transcriptPath }
      : {}),
    ...(runtimeContext?.codexTranscriptPath !== undefined
      ? { parentCodexTranscriptPath: runtimeContext.codexTranscriptPath }
      : {}),
    ...(runtimeContext?.model ? { model: runtimeContext.model } : {}),
    ...(runtimeContext?.permissionMode ? { permissionMode: runtimeContext.permissionMode } : {}),
    ...(runtimeContext?.effort ? { effort: runtimeContext.effort } : {}),
    agentId: resolvePluginSubagentAgentId(child),
    agentType: child.agentType,
    ...(child.agentTranscriptPath ? { agentTranscriptPath: child.agentTranscriptPath } : {}),
    ...(child.agentCodexTranscriptPath
      ? { agentCodexTranscriptPath: child.agentCodexTranscriptPath }
      : {}),
  };
}

function resolvePluginHookSessionOwnershipClaim(
  prepareOwnership: LocalRuntimeTurnExecutorOptions<
    AgentExecutionSnapshot,
    ToolExecutionContext
  >['preparePluginHookSessionOwnership'],
  leaseId: string,
): string | undefined {
  return prepareOwnership ? leaseId : undefined;
}

function resolvePluginSubagentAgentId(child: LocalPluginSubagentInput): string {
  return child.agentId ?? child.childSessionId;
}

async function cleanupPluginHookTranscriptBestEffort(
  cleanup: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!cleanup) return;
  try {
    await cleanup();
  } catch {
    // Ownership preparation failed before the transcript could be attached.
  }
}

function pluginHookTranscriptCleanup(
  writer: AgentHostPluginHookTranscript | undefined,
): (() => Promise<void>) | undefined {
  return writer ? () => writer.cleanup() : undefined;
}

/**
 * Order is load-bearing: `runBeforeLLM` ends the before-LLM decision pipeline
 * as soon as a hook returns `appendMessage`, so a request-only reminder placed
 * after an appending hook is silently skipped for that request. The budget
 * reminder is request-only and therefore always precedes the background
 * cadence reminder, which appends.
 */
function afterCompactionReminderHooks(
  budgetReminder: PiBeforeLlmCallHook | undefined,
  backgroundReminder: PiBeforeLlmCallHook | undefined,
): readonly PiBeforeLlmCallHook[] {
  return [
    ...(budgetReminder ? [budgetReminder] : []),
    ...(backgroundReminder ? [backgroundReminder] : []),
  ];
}

interface PreparedRunnerInput<TContext extends ToolExecutionContext> {
  readonly llm: LLMModelConfig;
  readonly systemPrompt: string;
  readonly userMessage: UserMessageInput;
  readonly history: PiAgentMessage[];
  readonly beforeUserMessages: NonNullable<RunTurnInput['beforeUserMessages']>;
  readonly tools: readonly RuntimeTool[];
  readonly toolResolution: LocalTurnPermissionResolution<TContext>;
  readonly toolContext: TContext;
  readonly beforeLlmCallHooks: readonly PiBeforeLlmCallHook[];
  readonly caller: RunTurnCaller;
  readonly contextUsagePromptRanges?: readonly LocalContextUsagePromptRange[];
  readonly contextUsageRequiresProviderAnchor?: boolean;
  readonly readTaskOutputTaskIds: Set<string>;
  readonly prepareSteering: (
    input: AgentHostSteeringMessage,
  ) => Promise<PreparedSteeringUserMessage>;
}

interface SettledRuntimeTurn<TContext extends ToolExecutionContext> {
  readonly outcome: AgentHostTurnOutcome;
  readonly prepared: PreparedRunnerInput<TContext>;
  readonly readTaskOutputTaskIds: ReadonlySet<string>;
  readonly runnerResult: LocalRuntimeTurnRunnerResult | void;
}

/**
 * Maps the neutral runner's optional reconcile signal onto a host reconcile
 * intent. The concrete detection lives in the v2 native runner adapter; the
 * host only normalizes the approved partial content to a string.
 */
function reconcileIntent(
  result: LocalRuntimeTurnRunnerResult | void,
): HistoryReconcileIntent | undefined {
  const signal = result?.reconcile;
  if (!signal) return undefined;
  switch (signal.kind) {
    case 'output-recall':
      return { kind: 'output-recall', source: signal.source, variant: signal.variant };
    case 'network-reconcile':
      return { kind: 'network-reconcile', approvedContent: signal.approvedContent ?? '' };
    case 'abort-reconcile':
      return { kind: 'abort-reconcile', approvedContent: signal.approvedContent ?? '' };
    default:
      return undefined;
  }
}

function mergeHooks<TAgent extends AgentExecutionSnapshot, TContext extends ToolExecutionContext>(
  options: LocalTurnHookMergeOptions<TAgent, TContext>,
): PiTurnHooks {
  const {
    input,
    toolResolution,
    pendingToolResultTailClaims,
    hostBeforeLlmCallHooks,
    readTaskOutputTaskIds,
    terminalTaskOutputReadIds,
    toolsDisabled,
    toolSafetyGuard,
    toolPolicyGuard,
    finalizeToolResultForHistory,
  } = options;
  const toolHooks = createControlledToolHooks({
    input,
    permissionGuard: toolResolution.permissionGuard,
    pendingToolResultTailClaims,
    readTaskOutputTaskIds,
    terminalTaskOutputReadIds,
    toolsDisabled,
    toolSafetyGuard,
    toolPolicyGuard,
    finalizeToolResultForHistory,
  });
  return {
    ...input.assembly.hooks,
    ...toolHooks,
    beforeLlmCallHook: [
      ...(input.assembly.hooks.beforeLlmCallHook ?? []),
      ...hostBeforeLlmCallHooks,
    ],
    onHistoryChangedHook: [
      async (change) => {
        await input.onHistoryChanged(change);
        await input.pluginHookTranscriptWriter?.apply(change);
        ackCommittedToolResultTailClaims(change.messages, pendingToolResultTailClaims, input);
      },
      ...(input.assembly.hooks.onHistoryChangedHook ?? []),
    ],
    onStepEndHook: input.assembly.hooks.onStepEndHook ?? [],
  };
}

function validateRoutedTurnTools(tools: readonly RuntimeTool[]): readonly RuntimeTool[] {
  return tools.reduce<RuntimeTool[]>((catalog, tool) => {
    if (catalog.some((candidate) => candidate.def.name === tool.def.name)) {
      throw new Error(`Duplicate tool name '${tool.def.name}' after v2 tool routing.`);
    }
    return [...catalog, tool];
  }, []);
}

function validateOptions<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
>(options: LocalRuntimeTurnExecutorOptions<TAgent, TContext>): void {
  assertAgentHostCapabilityAvailable(
    'local-runtime-turn-runner',
    typeof options.runtime?.runTurn === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'turn-execution-preparation',
    typeof options.executionPreparation?.prepare === 'function',
  );
  assertAgentHostCapabilityAvailable(
    'turn-file-change-lifecycle',
    [
      options.fileChanges?.begin,
      options.fileChanges?.finalize,
      options.fileChanges?.markFailed,
    ].every((operation) => typeof operation === 'function'),
  );
  if (
    Boolean(options.preparePluginHookSessionOwnership) !==
    Boolean(options.activatePluginHookSessionOwnership)
  ) {
    throw new TypeError('Plugin Hook Session ownership preparation and activation must be paired.');
  }
}

interface ResolvedInputValidation<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
> {
  readonly input: LocalTurnExecutionInput<TAgent>;
  readonly llm: LLMModelConfig;
  readonly systemPrompt: string;
  readonly userMessage: UserMessageInput;
  readonly tools: LocalTurnPermissionResolution<TContext>;
  readonly toolContext: TContext;
  readonly beforeLlmCallHooks: readonly PiBeforeLlmCallHook[];
}

function validateResolvedInput<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
>(resolved: ResolvedInputValidation<TAgent, TContext>): void {
  validateResolvedPrompt(resolved);
  validateResolvedTools(resolved);
  validateResolvedBeforeLlmCallHooks(resolved);
}

function validateResolvedBeforeLlmCallHooks<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
>(resolved: ResolvedInputValidation<TAgent, TContext>): void {
  if (
    !Array.isArray(resolved.beforeLlmCallHooks) ||
    resolved.beforeLlmCallHooks.some((hook) => typeof hook !== 'function')
  ) {
    throw new TypeError('Resolved host beforeLlmCall hooks are invalid.');
  }
}

function validateResolvedPrompt<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
>(resolved: ResolvedInputValidation<TAgent, TContext>): void {
  if (!resolved.llm?.model) throw new TypeError('Resolved LLMModelConfig.model is required.');
  if (typeof resolved.systemPrompt !== 'string') {
    throw new TypeError('Resolved system prompt is invalid.');
  }
  if (typeof resolved.userMessage?.text !== 'string') {
    throw new TypeError('Prepared user message is invalid.');
  }
  if (
    resolved.userMessage.attachments !== undefined &&
    !Array.isArray(resolved.userMessage.attachments)
  ) {
    throw new TypeError('Prepared user message attachments are invalid.');
  }
}

function validateResolvedTools<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
>(resolved: ResolvedInputValidation<TAgent, TContext>): void {
  if (!resolved.tools?.context || typeof resolved.tools.permissionGuard !== 'function') {
    throw new TypeError('Resolved host tool and permission context is invalid.');
  }
  if (resolved.toolContext.sessionId !== resolved.input.lease.sessionId) {
    throw new AgentEventAssociationError(
      'sessionId',
      resolved.input.lease.sessionId,
      resolved.toolContext.sessionId,
    );
  }
  if (resolved.toolContext.turnId !== resolved.input.lease.turnId) {
    throw new AgentEventAssociationError(
      'turnId',
      resolved.input.lease.turnId,
      resolved.toolContext.turnId,
    );
  }
}

function preparePlainSteering(
  input: AgentHostSteeringMessage,
): Promise<PreparedSteeringUserMessage> {
  return Promise.resolve({
    userMessage: { text: input.message.text },
    genuineUserQueryText: input.genuineUserQueryText,
  });
}

function createInitialHookInput(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly llm: LLMModelConfig;
  readonly canonicalMessages: PiAgentMessage[];
  readonly systemPrompt: string;
  readonly tools: readonly RuntimeTool[];
  readonly eventWriter: PiEventWriter;
}): PiBeforeLlmCallHookInput {
  const { llm } = input;
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    phase: 'initial',
    messages: input.canonicalMessages,
    canonicalMessages: input.canonicalMessages,
    model: llm.model,
    ...(llm.apiKey === undefined ? {} : { apiKey: llm.apiKey }),
    ...(llm.headers === undefined ? {} : { headers: llm.headers }),
    ...(llm.maxTokens === undefined ? {} : { maxTokens: llm.maxTokens }),
    ...(llm.maxSerializedInputBytes === undefined
      ? {}
      : { maxSerializedInputBytes: llm.maxSerializedInputBytes }),
    systemPrompt: input.systemPrompt,
    tools: input.tools.map((tool) => ({
      name: tool.def.name,
      description: tool.def.description,
      parameters: tool.def.schema,
    })),
    thinkingLevel: llm.thinkingLevel ?? 'off',
    signal: input.signal,
    eventWriter: input.eventWriter,
  };
}

function describeUnknownError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unknown error';
  }
}
