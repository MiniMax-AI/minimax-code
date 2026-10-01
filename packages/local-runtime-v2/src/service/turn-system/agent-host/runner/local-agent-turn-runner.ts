import { logger } from '../../../../infra/logging/index.js';
import {
  PiTurnRunner,
  type LLMModelConfig,
  type PiEventWriter,
  type PiLLMRequestFailureHook,
  type PiLLMRequestObserver,
  type PiTurnRunnerOptions,
  type PiTurnRunnerLogger,
  type RunTurnInput,
} from '@mavis/agent-core/pi-turn-runner';
import {
  buildCompletedTerminalStatusEvent,
  buildAbortedTerminalStatusEvent,
} from '@mavis/agent-core/event-bridge';
import { getRuntimeBuildEnv } from '@mavis/config';
import { RuntimeEventStatus, RuntimeEventType } from '@mavis/protocol';
import type { MetricsClient } from '@mavis/shared/metrics-proxy';

import {
  isInputSafetyDecisionFor,
  reviewBlocks,
  reviewBlocksInput,
  type ContentSafetyReviewPort,
  type SafetyCheckResult,
} from '../../../content-safety/index.js';
import type {
  LocalRuntimeTurnRunnerInput,
  LocalRuntimeTurnRunnerPort,
  LocalRuntimeTurnRunnerResult,
  LocalRuntimeTurnToolContext,
} from '../execution/executor.js';
import { LocalOutputSafetyEventWriter } from './output-safety-event-writer.js';
import { runWithLocalEvalReporter, type LocalEvalReporterFactoryPort } from './eval-reporter.js';
import { deriveLocalTurnRuntimeOutcome } from './turn-outcome.js';
import { appendSafetyReplacement } from './safety-replacement.js';
import { DEFAULT_OUTPUT_REVISION_INSTRUCTION } from '../preparation/config/prompt-templates.js';

export interface LocalPiTurnRunner {
  runTurn(input: RunTurnInput<LocalRuntimeTurnToolContext>): Promise<void>;
}

export interface LocalAgentTurnRunnerOptions {
  readonly piRunner?: LocalPiTurnRunner;
  readonly reviewContent: ContentSafetyReviewPort;
  readonly outputSafetyMaxRegenerations?: number;
  readonly outputSafetyRetryDelay?: () => Promise<void>;
  readonly metricsClient?: MetricsClient;
  readonly logger?: PiTurnRunnerLogger;
  readonly contextUsage?: LocalContextUsageCapabilities;
  readonly onLLMRequestFailure?: PiLLMRequestFailureHook;
  readonly observeLLMRequest?: PiLLMRequestObserver;
  readonly evalReporterFactory?: LocalEvalReporterFactoryPort;
  /**
   * Per-turn recorder factory for the development LLM Context Inspector; when omitted, Pi assembly
   * is identical to behavior before injection.
   */
  readonly llmCaptureFactory?: PiTurnRunnerOptions['llmCaptureFactory'];
}

export interface LocalContextUsageCapabilities {
  isEnabled(): boolean;
  prepareAttempt(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly promptRanges: NonNullable<LocalRuntimeTurnRunnerInput['contextUsagePromptRanges']>;
    readonly requiresProviderAnchor: boolean;
    readonly llm: LLMModelConfig;
    readonly eventWriter: PiEventWriter;
  }): { readonly llm: LLMModelConfig; readonly eventWriter: PiEventWriter };
}

export interface LocalAgentTurnRunnerResult extends LocalRuntimeTurnRunnerResult {
  readonly events: LocalRuntimeTurnRunnerInput['eventWriter']['events'];
  readonly retracted: boolean;
  readonly networkStopped: boolean;
  readonly outcome: NonNullable<LocalRuntimeTurnRunnerResult['outcome']>;
}

const OUTPUT_SAFETY_MAX_REGENERATIONS = 3;
/** V2 production runner: direct Pi invocation plus local input/output safety policy. */
export class LocalAgentTurnRunner implements LocalRuntimeTurnRunnerPort {
  readonly acceptsEventSummary: boolean;
  private readonly piRunner: LocalPiTurnRunner;
  private readonly outputSafetyMaxRegenerations: number;

  constructor(private readonly options: LocalAgentTurnRunnerOptions) {
    // Injected runners and evaluation reporters retain their full event contract.
    this.acceptsEventSummary = !options.piRunner && !options.evalReporterFactory;
    this.piRunner = options.piRunner ?? new PiTurnRunner(buildLocalPiTurnRunnerOptions(options));
    this.outputSafetyMaxRegenerations =
      options.outputSafetyMaxRegenerations ?? OUTPUT_SAFETY_MAX_REGENERATIONS;
  }

  async runTurn(input: LocalRuntimeTurnRunnerInput): Promise<LocalAgentTurnRunnerResult> {
    const isUserTurn =
      input.reviewUserInput !== undefined &&
      (input.caller === undefined || input.caller === 'chat' || input.caller === 'channel_feishu');
    const observation = { regenerations: 0 };
    try {
      return await runWithLocalEvalReporter(
        this.options.evalReporterFactory,
        input,
        (reportedInput) => this.runTurnCore(reportedInput, observation),
        this.options.logger,
      );
    } finally {
      if (isUserTurn) this.recordRegenerations(input, observation.regenerations);
    }
  }

  private async runTurnCore(
    input: LocalRuntimeTurnRunnerInput,
    observation: { regenerations: number },
  ): Promise<LocalAgentTurnRunnerResult> {
    const baseToolContext = requireToolContext(input);
    const observedLlm = withLlmResponseIdentifierLogging(input.llm, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      logger: this.options.logger,
    });
    const state = this.createRunState(input);
    const toolContext = withTurnEventReporter(baseToolContext, state);
    if (input.signal?.aborted) {
      await appendCancelledTurn(input, state);
      return buildRunnerResult(input, state);
    }
    await this.runAttempts({ input, toolContext, observedLlm, state, observation });
    const inputRejected = await waitForInputReview(state.inputReview, input.signal);
    if (input.signal?.aborted) return buildRunnerResult(input, state);
    if (input.deferInputReviewResolution === true && shouldReportInputReviewResolution(input)) {
      input.onInputReviewResolved?.(state.inputTitleRejected);
    }
    await this.settleInputReview(input, state, inputRejected);
    return buildRunnerResult(input, state);
  }

  private recordRegenerations(input: LocalRuntimeTurnRunnerInput, regenerations: number): void {
    try {
      this.options.metricsClient?.histogram(
        'output_safety_regenerations_per_user_turn',
        regenerations,
        {
          provider: String(input.llm.model.provider),
          model: String(input.llm.model.id),
          caller: input.caller ?? 'unknown',
        },
      );
    } catch {
      // Metrics must not change or mask the product-path outcome.
    }
  }

  private createRunState(input: LocalRuntimeTurnRunnerInput): MutableRunnerState {
    const state = createMutableRunnerState(input);
    state.inputReview = this.reviewInput(
      input,
      (rejected, variant, safetyReviewUnknown, result) => {
        state.inputRejected = rejected;
        state.inputTitleRejected = result ? reviewBlocks(result) : rejected;
        state.retractionVariant = variant;
        state.inputSafetyReviewUnknown ||= safetyReviewUnknown;
        applyInputCorrection(state, result);
        if (rejected) {
          state.retractionSource = 'input-review';
        }
        if (rejected || state.inputCorrectionPending) state.activeWriter?.block();
      },
    );
    return state;
  }

  private async runAttempts(scope: {
    readonly input: LocalRuntimeTurnRunnerInput;
    readonly toolContext: LocalRuntimeTurnToolContext;
    readonly observedLlm: LLMModelConfig;
    readonly state: MutableRunnerState;
    readonly observation: { regenerations: number };
  }): Promise<void> {
    const { input, toolContext, observedLlm, state, observation } = scope;
    let regenerationCount = 0;
    let attemptIndex = 0;
    while (regenerationCount <= this.outputSafetyMaxRegenerations) {
      const safetyAbort = new AbortController();
      const safetyWriter = this.createSafetyWriter(input, state, safetyAbort);
      state.activeWriter = safetyWriter;
      if (state.inputRejected) safetyWriter.block();
      state.finalAttemptEventStart = (input.eventWriter.outcome?.eventCount ?? input.eventWriter.events.length);
      try {
        await this.runPiAttempt({
          input,
          toolContext,
          observedLlm,
          state,
          safetyAbort,
          safetyWriter,
          regenerationCount,
          attemptIndex,
        });
      } catch (attemptFailure) {
        try {
          await safetyWriter.drain();
        } catch (deliveryFailure) {
          throw new AggregateError(
            [attemptFailure, deliveryFailure],
            'Pi attempt and event delivery failed.',
          );
        }
        throw attemptFailure;
      }
      await safetyWriter.drain();
      await waitForInputReview(state.inputReview, input.signal);
      const decision = await this.settleAttempt({
        input,
        state,
        safetyWriter,
        regenerationCount,
        attemptIndex,
      });
      if (decision === 'break') return;
      attemptIndex += 1;
      if (decision === 'continue') {
        regenerationCount += 1;
        observation.regenerations += 1;
      }
    }
  }

  private createSafetyWriter(
    input: LocalRuntimeTurnRunnerInput,
    state: MutableRunnerState,
    safetyAbort: AbortController,
  ): LocalOutputSafetyEventWriter {
    return new LocalOutputSafetyEventWriter(gateTerminalOnInputReview(input, state), {
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(input.streamUnreviewedOutput === true && input.contentReviewRequired === false
        ? { reviewRequired: false, checkText: async () => ({ pass: true as const }) }
        : {
            checkText:
              input.contentReviewRequired === false
                ? async () => ({ pass: true as const })
                : this.options.reviewContent,
          }),
      onBlocked: () => safetyAbort.abort(state.inputRejected ? 'input_safety' : 'output_safety'),
      ...(this.options.outputSafetyRetryDelay
        ? { retryDelay: this.options.outputSafetyRetryDelay }
        : {}),
      ...(this.options.metricsClient ? { metricsClient: this.options.metricsClient } : {}),
      ...(input.contentReviewRequired === true ? { authErrorVariant: 'auth' as const } : {}),
      ...(input.persistApprovedPartialOnNetworkStop === false
        ? { persistApprovedPartialOnNetworkStop: false }
        : {}),
    });
  }

  private async runPiAttempt(scope: {
    readonly input: LocalRuntimeTurnRunnerInput;
    readonly toolContext: LocalRuntimeTurnToolContext;
    readonly observedLlm: LLMModelConfig;
    readonly state: MutableRunnerState;
    readonly safetyAbort: AbortController;
    readonly safetyWriter: LocalOutputSafetyEventWriter;
    readonly regenerationCount: number;
    readonly attemptIndex: number;
  }): Promise<void> {
    const { input, toolContext, observedLlm, state, safetyAbort, safetyWriter, regenerationCount } =
      scope;
    const systemPrompt = systemPromptForAttempt(
      input.systemPrompt,
      regenerationCount,
      state.pendingRevisionInstruction ?? input.outputRevisionInstruction,
      state.pendingRevisionInstruction !== undefined,
    );
    state.pendingRevisionInstruction = undefined;
    observeLlmAttempt(input, scope.attemptIndex, systemPrompt);
    const contextUsageAttempt = this.prepareContextUsageAttempt(input, observedLlm, safetyWriter);
    await this.piRunner.runTurn({
      ...toPiRunTurnInput(input),
      llm: contextUsageAttempt?.llm ?? observedLlm,
      systemPrompt,
      eventWriter: contextUsageAttempt?.eventWriter ?? safetyWriter,
      signal: combineAbortSignals(input.signal, safetyAbort.signal),
      captureToolTiming: getRuntimeBuildEnv() !== 'prod',
      eventIdGenerator: state.eventIdGenerator,
      runtimeSeqGenerator: state.runtimeSeqGenerator,
      toolConfig: {
        tools: input.tools ?? [],
        disableBuiltinToolFallback: input.disableBuiltinToolFallback ?? true,
        context: toolContext,
      },
    });
  }

  private prepareContextUsageAttempt(
    input: LocalRuntimeTurnRunnerInput,
    llm: LLMModelConfig,
    eventWriter: PiEventWriter,
  ): ReturnType<LocalContextUsageCapabilities['prepareAttempt']> | undefined {
    const capability = this.options.contextUsage;
    if (
      !capability ||
      input.contextUsagePromptRanges === undefined ||
      input.toolContext?.channelContext
    ) {
      return undefined;
    }
    try {
      if (!capability.isEnabled()) return undefined;
      return capability.prepareAttempt({
        sessionId: input.sessionId,
        turnId: input.turnId,
        promptRanges: input.contextUsagePromptRanges,
        requiresProviderAnchor: input.contextUsageRequiresProviderAnchor === true,
        llm,
        eventWriter,
      });
    } catch {
      // Context Usage is diagnostic decoration and cannot change the owning Turn.
      return undefined;
    }
  }

  private async settleAttempt(scope: {
    readonly input: LocalRuntimeTurnRunnerInput;
    readonly state: MutableRunnerState;
    readonly safetyWriter: LocalOutputSafetyEventWriter;
    readonly regenerationCount: number;
    readonly attemptIndex: number;
  }): Promise<'break' | 'continue' | 'retry-input'> {
    const { input, state, safetyWriter, regenerationCount, attemptIndex } = scope;
    if (input.signal?.aborted) {
      await appendCancelledTurn(input, state);
      return 'break';
    }
    if (state.inputRejected) return 'break';
    const inputCorrection = await settleInputCorrection(
      input,
      state,
      safetyWriter,
      attemptIndex + 1,
    );
    if (inputCorrection) return inputCorrection;
    if (safetyWriter.networkStopped) {
      await settleNetworkStop(input, state, safetyWriter);
      return 'break';
    }
    if (!safetyWriter.blocked) {
      state.approvedPartial = safetyWriter.getApprovedPartial();
      return 'break';
    }
    if (safetyWriter.immediateBlock || regenerationCount >= this.outputSafetyMaxRegenerations) {
      await settleOutputRetraction(input, state);
      return 'break';
    }
    state.pendingRevisionInstruction = safetyWriter.guidePrompt;
    await recallAttempt(input, safetyWriter, attemptIndex + 1);
    return 'continue';
  }

  private async settleInputReview(
    input: LocalRuntimeTurnRunnerInput,
    state: MutableRunnerState,
    inputRejected: boolean,
  ): Promise<void> {
    if (!inputRejected || state.retracted) return;
    state.retracted = true;
    state.retractionVariant ??= 'content';
    await appendSyntheticCompleted(input, `local-input-retracted-${input.turnId}-status`);
  }

  private async reviewInput(
    input: LocalRuntimeTurnRunnerInput,
    observe: (
      rejected: boolean,
      variant: 'content' | 'network' | 'auth' | undefined,
      safetyReviewUnknown: boolean,
      result?: SafetyCheckResult,
    ) => void,
  ): Promise<boolean> {
    if (input.signal?.aborted) return false;
    if (input.contentReviewRequired === false) {
      reportInputReviewResolution(input, false);
      return false;
    }
    if (
      input.inputSafetyDigest &&
      isInputSafetyDecisionFor(input.inputSafetyDecision, input.inputSafetyDigest)
    ) {
      observe(false, undefined, input.inputSafetyDecision.outcome === 'degraded');
      reportInputReviewResolution(input, false);
      return false;
    }
    if (!input.reviewUserInput?.trim()) return false;
    try {
      const result = normalizeInputReviewResult(
        await this.options.reviewContent(input.reviewUserInput, 300),
      );
      if (input.signal?.aborted) return false;
      const rejected = reviewBlocksInput(result);
      observe(
        rejected,
        inputReviewVariant(rejected, result.errorKind, input.contentReviewRequired === true),
        result.errorKind === 'api_error',
        result,
      );
      reportInputReviewResolution(input, reviewBlocks(result));
      return rejected;
    } catch {
      if (input.signal?.aborted) return false;
      observe(true, 'network', false);
      reportInputReviewResolution(input, true);
      return true;
    }
  }
}

function reportInputReviewResolution(input: LocalRuntimeTurnRunnerInput, rejected: boolean): void {
  if (input.deferInputReviewResolution !== true) {
    input.onInputReviewResolved?.(rejected);
  }
}

function shouldReportInputReviewResolution(input: LocalRuntimeTurnRunnerInput): boolean {
  if (!input.onInputReviewResolved) return false;
  if (input.contentReviewRequired === false) return true;
  if (
    input.inputSafetyDigest &&
    isInputSafetyDecisionFor(input.inputSafetyDecision, input.inputSafetyDigest)
  ) {
    return true;
  }
  return Boolean(input.reviewUserInput?.trim());
}

/** Pass concrete implementations only the process-level capabilities needed by the Pi runner. */
function buildLocalPiTurnRunnerOptions(
  options: Pick<
    LocalAgentTurnRunnerOptions,
    'metricsClient' | 'logger' | 'onLLMRequestFailure' | 'observeLLMRequest' | 'llmCaptureFactory'
  >,
): PiTurnRunnerOptions {
  return {
    ...(options.metricsClient ? { metricsClient: options.metricsClient } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.onLLMRequestFailure ? { onLLMRequestFailure: options.onLLMRequestFailure } : {}),
    ...(options.observeLLMRequest ? { observeLLMRequest: options.observeLLMRequest } : {}),
    ...(options.llmCaptureFactory ? { llmCaptureFactory: options.llmCaptureFactory } : {}),
  };
}

interface MutableRunnerState {
  inputRejected: boolean;
  inputTitleRejected: boolean;
  inputCorrectionPending: boolean;
  replacementText?: string;
  pendingRevisionInstruction?: string;
  inputReview: Promise<boolean>;
  activeWriter?: LocalOutputSafetyEventWriter;
  retracted: boolean;
  networkStopped: boolean;
  inputSafetyReviewUnknown: boolean;
  approvedPartial?: LocalRuntimeTurnRunnerResult['approvedPartial'];
  retractionVariant?: LocalRuntimeTurnRunnerResult['retractionVariant'];
  retractionSource?: 'input-review' | 'output-review';
  finalAttemptEventStart: number;
  readonly eventIdGenerator: NonNullable<LocalRuntimeTurnRunnerInput['eventIdGenerator']>;
  readonly runtimeSeqGenerator: NonNullable<LocalRuntimeTurnRunnerInput['runtimeSeqGenerator']>;
}

function createMutableRunnerState(input: LocalRuntimeTurnRunnerInput): MutableRunnerState {
  let eventIdentitySequence = 0;
  let runtimeSequence = 0;
  return {
    inputRejected: false,
    inputTitleRejected: false,
    inputCorrectionPending: false,
    inputReview: Promise.resolve(false),
    retracted: false,
    networkStopped: false,
    inputSafetyReviewUnknown: false,
    finalAttemptEventStart: (input.eventWriter.outcome?.eventCount ?? input.eventWriter.events.length),
    eventIdGenerator:
      input.eventIdGenerator ??
      ((kind: string) => `evt_${input.turnId}_${kind}_${++eventIdentitySequence}`),
    runtimeSeqGenerator: input.runtimeSeqGenerator ?? (() => ++runtimeSequence),
  };
}

function normalizeInputReviewResult(result: SafetyCheckResult): SafetyCheckResult {
  // Input guides without text pass without interrupting the active attempt.
  return result.action === 'guide' && !result.guide_prompt?.trim()
    ? { pass: true, action: 'allow' }
    : result;
}

function applyInputCorrection(state: MutableRunnerState, result?: SafetyCheckResult): void {
  if (result?.action === 'replace' && result.suggestion?.trim()) {
    state.replacementText = result.suggestion;
    state.inputCorrectionPending = state.activeWriter !== undefined;
  } else if (result?.action === 'guide') {
    state.pendingRevisionInstruction = result.guide_prompt?.trim();
    state.inputCorrectionPending = state.activeWriter !== undefined;
  }
}

function gateTerminalOnInputReview(
  input: LocalRuntimeTurnRunnerInput,
  state: MutableRunnerState,
): PiEventWriter {
  const suppressTerminal = async (): Promise<boolean> =>
    (await waitForInputReview(state.inputReview, input.signal)) ||
    state.inputCorrectionPending ||
    input.signal?.aborted === true;
  return {
    pushRuntime: async (event) => {
      if (isTerminalStatus(event) && (await suppressTerminal())) return;
      await input.eventWriter.pushRuntime(event);
    },
    appendEvents: async (events) => {
      if (!events.some(isTerminalStatus)) {
        await input.eventWriter.appendEvents(events);
        return;
      }
      const accepted = (await suppressTerminal())
        ? events.filter((event) => !isTerminalStatus(event))
        : events;
      if (accepted.length > 0) await input.eventWriter.appendEvents(accepted);
    },
  };
}

function isTerminalStatus(event: Parameters<PiEventWriter['pushRuntime']>[0]): boolean {
  if (event.type !== RuntimeEventType.SESSION_STATUS) return false;
  const status = event.payload?.status;
  return (
    status === RuntimeEventStatus.COMPLETED ||
    status === RuntimeEventStatus.ABORTED ||
    status === RuntimeEventStatus.FAILED
  );
}

async function waitForInputReview(
  review: Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signal) return review;
  if (signal.aborted) return false;
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false);
  });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([review, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function withTurnEventReporter(
  context: LocalRuntimeTurnToolContext,
  state: MutableRunnerState,
): LocalRuntimeTurnToolContext {
  return {
    ...context,
    reporter: {
      nextEventId: state.eventIdGenerator,
      nextRuntimeSeq: state.runtimeSeqGenerator,
      appendEvents: async (events) => {
        // Native side-events must share the attempt writer with Pi so safety buffering
        // cannot deliver a newer runtime sequence before an older buffered event.
        const writer = state.activeWriter;
        if (!writer) throw new Error('Turn event reporter requires an active safety writer.');
        await writer.appendEvents(events);
      },
    },
  };
}

async function appendCancelledTurn(
  input: LocalRuntimeTurnRunnerInput,
  state: MutableRunnerState,
): Promise<void> {
  if ((input.eventWriter.outcome?.read() ?? deriveLocalTurnRuntimeOutcome(input.eventWriter.events)).status === 'aborted') return;
  await input.eventWriter.appendEvents([
    buildAbortedTerminalStatusEvent({
      sessionId: input.sessionId,
      turnId: input.turnId,
      statusEventId: state.eventIdGenerator('safety-review-aborted'),
    }),
  ]);
}

async function recallAttempt(
  input: LocalRuntimeTurnRunnerInput,
  safetyWriter: LocalOutputSafetyEventWriter,
  attempt: number,
): Promise<void> {
  if (!input.onOutputRecall) {
    throw new Error('Output recall Display retraction is unavailable.');
  }
  if (!input.recallOutputAttemptHistory) {
    throw new Error('Output recall canonical history retraction is unavailable.');
  }
  await input.onOutputRecall({ attempt, messageIds: safetyWriter.getAttemptMessageIds() });
  await input.recallOutputAttemptHistory(attempt);
}

async function settleInputCorrection(
  input: LocalRuntimeTurnRunnerInput,
  state: MutableRunnerState,
  safetyWriter: LocalOutputSafetyEventWriter,
  attempt: number,
): Promise<'break' | 'retry-input' | undefined> {
  if (!state.inputCorrectionPending) return undefined;
  // An input guide cannot override a final output Block.
  if (!state.replacementText && safetyWriter.immediateBlock) {
    return undefined;
  }
  await recallAttempt(input, safetyWriter, attempt);
  state.inputCorrectionPending = false;
  if (input.signal?.aborted) {
    await appendCancelledTurn(input, state);
    return 'break';
  }
  if (!state.replacementText) return 'retry-input';
  if (!(await appendSafetyReplacement(input, state.replacementText, state))) {
    await appendCancelledTurn(input, state);
  }
  return 'break';
}

async function settleNetworkStop(
  input: LocalRuntimeTurnRunnerInput,
  state: MutableRunnerState,
  safetyWriter: LocalOutputSafetyEventWriter,
): Promise<void> {
  if (safetyWriter.terminalFailed) return;
  logger.warn(
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
      reviewOutcome: safetyWriter.reviewStopVariant === 'auth' ? 'auth_error' : 'unavailable',
      outputSuppressed: true,
      terminalStatus: 'completed',
    },
    '[content-safety] output review stopped turn',
  );
  state.networkStopped = true;
  state.retractionVariant = safetyWriter.reviewStopVariant;
  state.approvedPartial = safetyWriter.getApprovedPartial();
  await appendSyntheticCompleted(input, `local-output-network-stopped-${input.turnId}-status`);
}

async function settleOutputRetraction(
  input: LocalRuntimeTurnRunnerInput,
  state: MutableRunnerState,
): Promise<void> {
  state.retracted = true;
  state.retractionVariant = 'content';
  state.retractionSource = 'output-review';
  await appendSyntheticCompleted(input, `local-output-retracted-${input.turnId}-status`);
}

async function appendSyntheticCompleted(
  input: LocalRuntimeTurnRunnerInput,
  statusEventId: string,
): Promise<void> {
  await input.eventWriter.appendEvents([
    buildCompletedTerminalStatusEvent({
      sessionId: input.sessionId,
      turnId: input.turnId,
      statusEventId,
    }),
  ]);
}

function systemPromptForAttempt(
  systemPrompt: string,
  regenerationCount: number,
  outputRevisionInstruction = DEFAULT_OUTPUT_REVISION_INSTRUCTION,
  hasInputInstruction = false,
): string {
  return regenerationCount > 0 || hasInputInstruction
    ? `${systemPrompt}\n\n${outputRevisionInstruction}`
    : systemPrompt;
}

function observeLlmAttempt(
  input: LocalRuntimeTurnRunnerInput,
  attemptIndex: number,
  systemPrompt: string,
): void {
  try {
    input.onLlmAttempt?.({ attemptIndex, systemPrompt });
  } catch {
    // Debug observers are best effort and cannot change the owning Turn.
  }
}

function inputReviewVariant(
  rejected: boolean,
  errorKind: 'rejected' | 'api_error' | 'local_error' | 'auth_error' | undefined,
  authVariantEnabled: boolean,
): 'content' | 'network' | 'auth' | undefined {
  if (!rejected) return undefined;
  if (errorKind === 'auth_error') return authVariantEnabled ? 'auth' : 'network';
  return errorKind === 'local_error' ? 'network' : 'content';
}

function buildRunnerResult(
  input: LocalRuntimeTurnRunnerInput,
  state: MutableRunnerState,
): LocalAgentTurnRunnerResult {
  const events = input.eventWriter.events;
  const outcome = input.eventWriter.outcome?.read() ?? deriveLocalTurnRuntimeOutcome(events);
  const reconcile = deriveReconcile(state, outcome.status);
  const hasRetractionVariant = (state.retracted || state.networkStopped) && state.retractionVariant;
  return {
    events,
    retracted: state.retracted,
    networkStopped: state.networkStopped,
    outcome,
    ...(reconcile ? { reconcile } : {}),
    ...(hasRetractionVariant ? { retractionVariant: state.retractionVariant } : {}),
    ...(state.approvedPartial ? { approvedPartial: state.approvedPartial } : {}),
    ...(state.finalAttemptEventStart > 0
      ? { timingEventsStartIndex: state.finalAttemptEventStart }
      : {}),
  };
}

function deriveReconcile(
  state: MutableRunnerState,
  status: LocalAgentTurnRunnerResult['outcome']['status'],
): LocalRuntimeTurnRunnerResult['reconcile'] {
  if (state.retracted) {
    return {
      kind: 'output-recall',
      source: state.retractionSource ?? 'output-review',
      variant: state.retractionVariant ?? 'content',
    };
  }
  if (state.networkStopped) {
    return { kind: 'network-reconcile', approvedContent: state.approvedPartial?.content };
  }
  if (status === 'aborted') {
    return { kind: 'abort-reconcile', approvedContent: state.approvedPartial?.content };
  }
  return undefined;
}

function requireToolContext(input: LocalRuntimeTurnRunnerInput): LocalRuntimeTurnToolContext {
  if (!input.toolContext) {
    throw new Error('LocalAgentTurnRunner requires a v2 LocalRuntimeTurnToolContext.');
  }
  return input.toolContext;
}

function toPiRunTurnInput(
  input: LocalRuntimeTurnRunnerInput,
): Omit<RunTurnInput<LocalRuntimeTurnToolContext>, 'eventWriter' | 'toolConfig'> {
  return {
    ...toPiCoreInput(input),
    ...toPiControlInput(input),
  };
}

function toPiCoreInput(
  input: LocalRuntimeTurnRunnerInput,
): Omit<
  RunTurnInput<LocalRuntimeTurnToolContext>,
  | 'eventWriter'
  | 'toolConfig'
  | 'eventIdGenerator'
  | 'runtimeSeqGenerator'
  | 'getSteeringMessages'
  | 'shouldStopAfterSteering'
  | 'shouldStopAfterTurn'
  | 'tryBeginClose'
> {
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    workspaceDir: input.workspaceDir,
    systemPrompt: input.systemPrompt,
    userMessage: input.userMessage,
    ...(input.beforeUserMessages ? { beforeUserMessages: input.beforeUserMessages } : {}),
    ...(input.startMode ? { startMode: input.startMode } : {}),
    llm: input.llm,
    ...(input.history ? { history: input.history } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.hooks ? { hooks: input.hooks } : {}),
    ...(input.llmRetry ? { llmRetry: input.llmRetry } : {}),
    ...(input.captureToolTiming !== undefined
      ? { captureToolTiming: input.captureToolTiming }
      : {}),
    ...(input.includeDetailedUsage === true ? { includeDetailedUsage: true } : {}),
    ...(input.caller ? { caller: input.caller } : {}),
  };
}

function toPiControlInput(
  input: LocalRuntimeTurnRunnerInput,
): Pick<
  RunTurnInput<LocalRuntimeTurnToolContext>,
  | 'eventIdGenerator'
  | 'runtimeSeqGenerator'
  | 'getSteeringMessages'
  | 'shouldStopAfterSteering'
  | 'shouldStopAfterTurn'
  | 'tryBeginClose'
> {
  return {
    ...(input.eventIdGenerator ? { eventIdGenerator: input.eventIdGenerator } : {}),
    ...(input.runtimeSeqGenerator ? { runtimeSeqGenerator: input.runtimeSeqGenerator } : {}),
    ...(input.getSteeringMessages ? { getSteeringMessages: input.getSteeringMessages } : {}),
    ...(input.shouldStopAfterSteering
      ? { shouldStopAfterSteering: input.shouldStopAfterSteering }
      : {}),
    ...(input.shouldStopAfterTurn ? { shouldStopAfterTurn: input.shouldStopAfterTurn } : {}),
    ...(input.tryBeginClose ? { tryBeginClose: input.tryBeginClose } : {}),
  };
}

function combineAbortSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  signals.forEach((signal) => {
    if (!signal || controller.signal.aborted) return;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        if (!controller.signal.aborted) controller.abort(signal.reason);
      },
      { once: true },
    );
  });
  return controller.signal;
}

function withLlmResponseIdentifierLogging(
  llm: LLMModelConfig,
  context: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly logger?: PiTurnRunnerLogger;
  },
): LLMModelConfig {
  const responseObserver = llm.responseObserver;
  return {
    ...llm,
    responseObserver: async (response, model) => {
      const requestId = pickResponseIdentifier(response.headers, [
        'request-id',
        'x-request-id',
        'x-mm-request-id',
      ]);
      const traceId = pickResponseIdentifier(response.headers, [
        'x-trace-id',
        'trace-id',
        'uber-trace-id',
      ]);
      if (requestId || traceId) {
        context.logger?.info?.(
          {
            session_id: context.sessionId,
            turn_id: context.turnId,
            provider: model.provider,
            model: model.id,
            response_status: response.status,
            ...(requestId ? { downstream_request_id: requestId } : {}),
            ...(traceId ? { downstream_trace_id: traceId } : {}),
          },
          'llm_response_identifiers',
        );
      }
      await responseObserver?.(response, model);
    },
  };
}

function pickResponseIdentifier(
  headers: Readonly<Record<string, string>>,
  names: readonly string[],
): string | undefined {
  return names.map((name) => headers[name]).find((value) => value?.trim());
}
