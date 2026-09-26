import type {
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookDecision,
  PiBeforeLlmCallHookInput,
  PiBeforeLlmCallReplaceMetadata,
  PiTurnRunnerLogger,
} from '@mavis/agent-core/pi-turn-runner';
import {
  CONTEXT_USAGE_COMPONENT_KINDS,
  type ContextUsageComponent,
} from '@mavis/agent-core/protocol';

import type { AgentHostCompactionDependencies } from '../contracts.js';
import type { AgentEventContext } from '../events/contracts.js';
import type {
  CheckpointAttemptMetadata,
  CompletedContextCompaction,
  CompactionTokenUsage,
  CheckpointGenerationMetadata,
  CheckpointResponseContentKind,
  CheckpointStopReason,
  AutomaticContextCompactionInput,
  ContextCompactionLifecycleMetadata,
  ContextCompactionObservation,
  ContextCompactionObserver,
  ContextCompactionPhase,
  ContextCompactionResult,
  PostCompactionContextUsage,
} from './contracts.js';
import {
  copyCanonicalHistoryForPiCompatibility,
  validateCanonicalHistoryMessages,
} from '../history/canonical-history-validation.js';
import { captureSemanticSnapshot } from '../history/semantic-identity.js';
import {
  compactionTokenUsageMetadata,
  createCompactionTokenUsageAccumulator,
  readCompactionTokenUsage,
} from './token-usage.js';

export { createCompactionTokenUsageAccumulator, readCompactionTokenUsage } from './token-usage.js';

// Mark fire-and-forget deliveries as consumed without retaining a pending
// observer forever. `deliverObservation` catches both sync and async failures.
const nonAuthoritativeObservations = new WeakSet<Promise<void>>();

export class ContextCompactionResultValidationError extends Error {
  override readonly name = 'ContextCompactionResultValidationError';

  constructor(readonly field: string) {
    super(`Context compaction result ${field} is invalid.`);
  }
}

class AutomaticContextCompactionDeferredError extends Error {
  override readonly name = 'AutomaticContextCompactionDeferredError';
}

class AutomaticContextCompactionHookAbortError extends Error {
  override readonly name = 'AutomaticContextCompactionHookAbortError';
}

export type AgentHostCompactionHookDependencies = Pick<
  AgentHostCompactionDependencies,
  'automatic' | 'lifecycle' | 'observer' | 'metricsClient'
>;

export class ContextCompactionAttemptFactory {
  private namespace: string | undefined;
  private sequence = 0;

  create(context: AgentEventContext, leaseId: string, phase: ContextCompactionPhase): string {
    validateContextCompactionAttemptScope(context, leaseId, phase);
    this.namespace ??= createAttemptNamespace();
    return createContextCompactionAttemptId(this.namespace, ++this.sequence);
  }
}

export function createAutomaticContextCompactionHook(
  dependencies: AgentHostCompactionHookDependencies,
  context: AgentEventContext,
  leaseId: string,
  options: {
    readonly maxSerializedInputBytes?: number;
    readonly attempts?: ContextCompactionAttemptFactory;
    readonly logger?: Pick<PiTurnRunnerLogger, 'info' | 'error'> | undefined;
    /** Runs only after the automatic trigger matches, immediately before compaction starts. */
    readonly beforeCompaction?: () => Promise<
      boolean | { readonly abort: true; readonly reason: string }
    >;
  } = {},
): PiBeforeLlmCallHook {
  const attempts = options.attempts ?? new ContextCompactionAttemptFactory();
  const trustedContext = captureSemanticSnapshot(context).value;
  return async (input): Promise<PiBeforeLlmCallHookDecision> => {
    const attemptId = attempts.create(trustedContext, leaseId, input.phase);
    const attemptState: {
      started: boolean;
      checkpoint?: CheckpointGenerationMetadata;
    } = { started: false };
    const providerTokenUsage = createCompactionTokenUsageAccumulator();
    try {
      const automaticInput = automaticContextCompactionInput(
        input,
        options.maxSerializedInputBytes,
      );
      const probe = dependencies.automatic.probeBeforeLlm?.(automaticInput);
      if (probe?.shouldStart === false) {
        return resolveAutomaticCompactionResult({
          dependencies,
          context: trustedContext,
          attemptId,
          input,
          messages: input.messages,
          result: { status: 'unchanged', reason: 'nothing-to-compact' },
        });
      }
      const messages = captureSemanticSnapshot(input.messages).value;
      const result = captureContextCompactionResult(
        await dependencies.automatic.compactBeforeLlm(
          {
            ...automaticInput,
            messages,
          },
          {
            onStarted: async () => {
              const admission = await options.beforeCompaction?.();
              if (admission === false) throw new AutomaticContextCompactionDeferredError();
              if (typeof admission === 'object' && admission.abort) {
                throw new AutomaticContextCompactionHookAbortError(admission.reason);
              }
              attemptState.started = true;
              observeCompactionBestEffort(dependencies.observer, {
                context: trustedContext,
                attemptId,
                status: 'started',
                reason: 'automatic',
              });
            },
            onCheckpointGenerated: (metadata) => {
              attemptState.checkpoint = logCheckpointGeneratedBestEffort(options.logger, {
                context: trustedContext,
                attemptId,
                phase: input.phase,
                thinkingLevel: input.thinkingLevel,
                checkpoint: metadata,
              });
            },
            onCheckpointAttemptSettled: (metadata) =>
              recordCheckpointAttemptBestEffort(options.logger, dependencies.metricsClient, {
                context: trustedContext,
                attemptId,
                phase: input.phase,
                thinkingLevel: input.thinkingLevel,
                checkpoint: metadata,
              }),
            onProviderRequestSettled: providerTokenUsage.observe,
            getProviderTokenUsage: providerTokenUsage.snapshot,
          },
        ),
        messages.length,
      );
      return resolveAutomaticCompactionResult({
        dependencies,
        context: trustedContext,
        attemptId,
        input,
        messages,
        result,
      });
    } catch (error) {
      if (error instanceof AutomaticContextCompactionDeferredError) {
        return { type: 'skip', reason: 'context_compaction_deferred_by_plugin_hook' };
      }
      if (error instanceof AutomaticContextCompactionHookAbortError) {
        return { type: 'abort', reason: error.message };
      }
      if (!attemptState.started && input.signal?.aborted) {
        return {
          type: 'skip',
          reason: 'context_compaction_aborted_before_start',
        };
      }
      logCompactionFailureBestEffort(options.logger, {
        context: trustedContext,
        attemptId,
        phase: input.phase,
        thinkingLevel: input.thinkingLevel,
        checkpoint: attemptState.checkpoint,
        error,
      });
      const lifecycle = await captureFailure(() =>
        dependencies.lifecycle.failCommittedHistory({
          context: trustedContext,
          attemptId,
          error,
        }),
      );
      observeCompactionBestEffort(dependencies.observer, {
        context: trustedContext,
        attemptId,
        status: compactionFailureStatus(input.signal, attemptState.checkpoint),
        reason: describeUnknownError(error),
        ...compactionTokenUsageMetadata(providerTokenUsage.snapshot()),
      });
      // Automatic compaction is optional maintenance and always fails open:
      // the failure is recorded above while the parent Turn continues with the
      // pre-compaction history, and the Provider stays the final admission
      // authority. This includes POST_ADMISSION_FAILED — a local estimate must
      // never wedge a session that the Provider would accept.
      return {
        type: 'skip',
        reason: lifecycle.failed
          ? 'context_compaction_failure_record_failed'
          : 'context_compaction_failed',
      };
    }
  };
}

function automaticContextCompactionInput(
  input: PiBeforeLlmCallHookInput,
  maxSerializedInputBytes: number | undefined,
): AutomaticContextCompactionInput {
  return {
    sessionId: input.sessionId,
    phase: input.phase,
    messages: input.messages,
    model: input.model,
    ...(maxSerializedInputBytes === undefined ? {} : { maxSerializedInputBytes }),
    streamFn: input.streamFn,
    apiKey: input.apiKey,
    headers: input.headers,
    maxTokens: input.maxTokens,
    cacheRetention: input.cacheRetention,
    payloadTransform: input.auxiliaryPayloadTransform ?? input.payloadTransform,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    thinkingLevel: input.thinkingLevel,
    signal: input.signal,
  };
}

const CHECKPOINT_CONTENT_KINDS = new Set<CheckpointResponseContentKind>([
  'text',
  'thinking',
  'toolCall',
  'unknown',
]);
const CHECKPOINT_STOP_REASONS = new Set<CheckpointStopReason>([
  'stop',
  'length',
  'toolUse',
  'error',
  'aborted',
]);
const CHECKPOINT_CANDIDATES = new Set<CheckpointAttemptMetadata['candidate']>([
  'h0',
  'htrim',
  'hall',
  'hvideo',
  'hmid',
  'hmin',
]);
const CHECKPOINT_ATTEMPT_OUTCOMES = new Set<CheckpointAttemptMetadata['outcome']>([
  'generated',
  'input_too_large',
  'output_exhausted',
  'aborted',
  'failed',
]);
const STABLE_COMPACTION_FAILURES = [
  ['INVALID_HISTORY', 'tool_trim'],
  ['INVALID_CHECKPOINT', 'llm_checkpoint'],
  ['CHECKPOINT_PROVIDER_FAILED', 'llm_checkpoint'],
  ['COMPACTION_INPUT_TOO_LARGE', 'llm_checkpoint'],
  ['POST_ADMISSION_FAILED', 'post_admission'],
] as const;

function captureCheckpointGenerationMetadata(
  value: CheckpointGenerationMetadata,
): CheckpointGenerationMetadata | undefined {
  if (
    !Array.isArray(value.responseContentKinds) ||
    !CHECKPOINT_STOP_REASONS.has(value.stopReason) ||
    !Number.isSafeInteger(value.outputTokens) ||
    value.outputTokens < 0
  ) {
    return undefined;
  }
  const responseContentKinds = [
    ...new Set(value.responseContentKinds.filter((kind) => CHECKPOINT_CONTENT_KINDS.has(kind))),
  ];
  return Object.freeze({
    responseContentKinds: Object.freeze(responseContentKinds),
    stopReason: value.stopReason,
    outputTokens: value.outputTokens,
  });
}

export function logCheckpointGeneratedBestEffort(
  logger: Pick<PiTurnRunnerLogger, 'info' | 'error'> | undefined,
  input: {
    readonly context: AgentEventContext;
    readonly attemptId: string;
    readonly phase: ContextCompactionPhase;
    readonly thinkingLevel: PiBeforeLlmCallHookInput['thinkingLevel'];
    readonly checkpoint: CheckpointGenerationMetadata;
  },
): CheckpointGenerationMetadata | undefined {
  let checkpoint: CheckpointGenerationMetadata | undefined;
  try {
    checkpoint = captureCheckpointGenerationMetadata(input.checkpoint);
    if (!checkpoint) return undefined;
    logger?.info?.(
      {
        event: 'context_compaction_checkpoint_generated',
        session_id: input.context.sessionId,
        turn_id: input.context.turnId,
        turn_sequence: input.context.turnSequence,
        attempt_id: input.attemptId,
        phase: input.phase,
        thinking_level: input.thinkingLevel,
        response_content_kinds: [...checkpoint.responseContentKinds],
        stop_reason: checkpoint.stopReason,
        output_tokens: checkpoint.outputTokens,
      },
      '[local-runtime-v2] context compaction checkpoint generated',
    );
  } catch {
    // Engineering diagnostics must never change the compaction outcome.
  }
  return checkpoint;
}

export function recordCheckpointAttemptBestEffort(
  logger: Pick<PiTurnRunnerLogger, 'info'> | undefined,
  metrics: AgentHostCompactionDependencies['metricsClient'],
  input: {
    readonly context: AgentEventContext;
    readonly attemptId: string;
    readonly phase: ContextCompactionPhase;
    readonly thinkingLevel: PiBeforeLlmCallHookInput['thinkingLevel'];
    readonly checkpoint: CheckpointAttemptMetadata;
  },
): void {
  const checkpoint = captureCheckpointAttemptMetadata(input.checkpoint);
  if (!checkpoint) return;
  try {
    logger?.info?.(
      {
        event: 'context_compaction_checkpoint_attempt_settled',
        session_id: input.context.sessionId,
        turn_id: input.context.turnId,
        turn_sequence: input.context.turnSequence,
        attempt_id: input.attemptId,
        phase: input.phase,
        thinking_level: input.thinkingLevel,
        checkpoint_candidate: checkpoint.candidate,
        checkpoint_attempt: checkpoint.attemptNumber,
        ...checkpointAttemptLogFields(checkpoint),
        outcome: checkpoint.outcome,
        duration_ms: checkpoint.durationMs,
      },
      '[local-runtime-v2] context compaction checkpoint attempt settled',
    );
  } catch {
    // Engineering diagnostics must never change the compaction outcome.
  }
  try {
    metrics?.counter('compact_checkpoint_candidate_total', 1, {
      candidate: checkpoint.candidate,
      outcome: checkpoint.outcome,
    });
  } catch {
    // Metrics must never change the compaction outcome.
  }
  try {
    metrics?.histogram('compact_checkpoint_candidate_duration_ms', checkpoint.durationMs, {
      candidate: checkpoint.candidate,
    });
  } catch {
    // Metrics must never change the compaction outcome.
  }
}

function checkpointAttemptLogFields(checkpoint: CheckpointAttemptMetadata): {
  readonly input_message_count?: number;
} {
  return {
    ...(checkpoint.inputMessageCount === undefined
      ? {}
      : { input_message_count: checkpoint.inputMessageCount }),
  };
}

export function logCompactionFailureBestEffort(
  logger: Pick<PiTurnRunnerLogger, 'info' | 'error'> | undefined,
  input: {
    readonly context: AgentEventContext;
    readonly attemptId: string;
    readonly phase: ContextCompactionPhase;
    readonly thinkingLevel: PiBeforeLlmCallHookInput['thinkingLevel'];
    readonly checkpoint?: CheckpointGenerationMetadata;
    readonly error: unknown;
  },
): void {
  try {
    const failure =
      captureStableCompactionFailure(input.error) ??
      (input.checkpoint?.stopReason === 'aborted'
        ? (['COMPACTION_ABORTED', 'llm_checkpoint'] as const)
        : undefined);
    logger?.error?.(
      {
        event: 'context_compaction_failed',
        session_id: input.context.sessionId,
        turn_id: input.context.turnId,
        turn_sequence: input.context.turnSequence,
        attempt_id: input.attemptId,
        phase: input.phase,
        thinking_level: input.thinkingLevel,
        ...(input.checkpoint === undefined
          ? {}
          : {
              response_content_kinds: [...input.checkpoint.responseContentKinds],
              stop_reason: input.checkpoint.stopReason,
              output_tokens: input.checkpoint.outputTokens,
            }),
        error_code: failure?.[0] ?? 'UNKNOWN_ERROR',
        error_stage: failure?.[1] ?? 'unknown',
        ...captureCompactionSizeDiagnosticsFields(input.error),
      },
      '[local-runtime-v2] context compaction failed',
    );
  } catch {
    // Engineering diagnostics must never change the compaction outcome.
  }
}

const COMPACTION_SIZE_DIAGNOSTIC_FIELDS = [
  ['historyMessageCount', 'history_message_count'],
  ['protectedMessageCount', 'protected_message_count'],
  ['protectedInputTokens', 'protected_input_tokens'],
  ['protectedSerializedBytes', 'protected_serialized_bytes'],
  ['providerInputLimit', 'provider_input_limit'],
  ['maxSerializedInputBytes', 'max_serialized_input_bytes'],
  ['beforeInputTokens', 'before_input_tokens'],
  ['beforeSerializedBytes', 'before_serialized_bytes'],
  ['afterInputTokens', 'after_input_tokens'],
  ['afterSerializedBytes', 'after_serialized_bytes'],
] as const;

/** Content-free sizing facts attached by the compaction algorithm, when present. */
function captureCompactionSizeDiagnosticsFields(
  error: unknown,
): Readonly<Record<string, number | boolean>> {
  try {
    if (error === null || typeof error !== 'object') return {};
    const diagnostics = Reflect.get(error, 'diagnostics');
    if (!isRecord(diagnostics)) return {};
    const fields: Record<string, number | boolean> = {};
    for (const [source, target] of COMPACTION_SIZE_DIAGNOSTIC_FIELDS) {
      const value = diagnostics[source];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        fields[target] = value;
      }
    }
    const hminAvailable = diagnostics['hminAvailable'];
    if (typeof hminAvailable === 'boolean') fields['hmin_available'] = hminAvailable;
    return fields;
  } catch {
    return {};
  }
}

function compactionFailureStatus(
  signal: AbortSignal | undefined,
  checkpoint: CheckpointGenerationMetadata | undefined,
): 'aborted' | 'failed' {
  return signal?.aborted || checkpoint?.stopReason === 'aborted' ? 'aborted' : 'failed';
}

function captureStableCompactionFailure(
  error: unknown,
): (typeof STABLE_COMPACTION_FAILURES)[number] | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  try {
    const code = Reflect.get(error, 'code');
    const stage = Reflect.get(error, 'stage');
    return STABLE_COMPACTION_FAILURES.find(
      ([stableCode, stableStage]) => code === stableCode && stage === stableStage,
    );
  } catch {
    return undefined;
  }
}

function captureCheckpointAttemptMetadata(value: unknown): CheckpointAttemptMetadata | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const candidate = Reflect.get(value, 'candidate');
    const attemptNumber = Reflect.get(value, 'attemptNumber');
    const outcome = Reflect.get(value, 'outcome');
    const durationMs = Reflect.get(value, 'durationMs');
    if (!CHECKPOINT_CANDIDATES.has(candidate as CheckpointAttemptMetadata['candidate'])) {
      return undefined;
    }
    if (
      typeof attemptNumber !== 'number' ||
      !Number.isSafeInteger(attemptNumber) ||
      attemptNumber < 1
    ) {
      return undefined;
    }
    if (!CHECKPOINT_ATTEMPT_OUTCOMES.has(outcome as CheckpointAttemptMetadata['outcome'])) {
      return undefined;
    }
    if (!isNonNegativeFiniteNumber(durationMs)) {
      return undefined;
    }
    return {
      candidate: candidate as CheckpointAttemptMetadata['candidate'],
      attemptNumber,
      outcome: outcome as CheckpointAttemptMetadata['outcome'],
      durationMs,
      ...captureCheckpointAttemptDetails(value),
    };
  } catch {
    return undefined;
  }
}

function captureCheckpointAttemptDetails(
  value: Readonly<Record<PropertyKey, unknown>>,
): Pick<CheckpointAttemptMetadata, 'inputMessageCount'> {
  const inputMessageCount = readOptionalNonNegativeSafeInteger(value, 'inputMessageCount');
  return inputMessageCount === undefined ? {} : { inputMessageCount };
}

function readOptionalNonNegativeSafeInteger(
  value: Readonly<Record<PropertyKey, unknown>>,
  key: string,
): number | undefined {
  const field = Reflect.get(value, key);
  return typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

interface AutomaticCompactionResultPlan {
  readonly dependencies: AgentHostCompactionHookDependencies;
  readonly context: AgentEventContext;
  readonly attemptId: string;
  readonly input: PiBeforeLlmCallHookInput;
  readonly messages: PiBeforeLlmCallHookInput['messages'];
  readonly result: ContextCompactionResult;
}

function resolveAutomaticCompactionResult(
  plan: AutomaticCompactionResultPlan,
): PiBeforeLlmCallHookDecision {
  const { dependencies, context, attemptId, input, result } = plan;
  if (result.status === 'unchanged') {
    observeCompactionBestEffort(dependencies.observer, {
      context,
      attemptId,
      status: 'unchanged',
      reason: result.reason,
    });
    return { type: 'continue' };
  }
  if (result.status === 'replaced') {
    observeCompactionBestEffort(dependencies.observer, {
      context,
      attemptId,
      status: 'unchanged',
      reason: result.reason,
    });
    return {
      type: 'replaceRequestMessages',
      messages: copyCanonicalHistoryForPiCompatibility(result.replacementMessages),
      reason: result.reason,
    };
  }
  return {
    type: 'replaceMessages',
    messages: copyCanonicalHistoryForPiCompatibility(result.replacementMessages),
    metadata: createCompactionReplaceMetadata(result, input.phase, attemptId),
  };
}

export function captureContextCompactionResult(
  result: ContextCompactionResult,
  expectedMessagesBefore?: number,
): ContextCompactionResult {
  const snapshot = captureSemanticSnapshot(result).value;
  if (snapshot.status === 'unchanged') {
    if (snapshot.reason !== 'nothing-to-compact') {
      throw new ContextCompactionResultValidationError('reason');
    }
    return snapshot;
  }
  if (snapshot.status === 'replaced') {
    if (snapshot.reason !== 'internal-context-filter') {
      throw new ContextCompactionResultValidationError('reason');
    }
    const replacementId = normalizeIdentity(snapshot.replacementId, 'replacementId');
    const strategyVersion = normalizeIdentity(snapshot.strategyVersion, 'strategyVersion');
    validateReplacement(snapshot, expectedMessagesBefore);
    return captureSemanticSnapshot({
      ...snapshot,
      replacementId,
      strategyVersion,
    }).value;
  }
  if (snapshot.status !== 'completed') {
    throw new ContextCompactionResultValidationError('status');
  }
  const compactionId = normalizeIdentity(snapshot.compactionId, 'compactionId');
  const strategyVersion = normalizeIdentity(snapshot.strategyVersion, 'strategyVersion');
  validateCompletedCompaction(snapshot, expectedMessagesBefore);
  const { contextUsage: rawContextUsage, tokenUsage: rawTokenUsage, ...completed } = snapshot;
  const contextUsage = readPostCompactionContextUsage(rawContextUsage);
  const tokenUsage = readCompactionTokenUsage(rawTokenUsage);
  return captureSemanticSnapshot({
    ...completed,
    compactionId,
    strategyVersion,
    ...(contextUsage === undefined ? {} : { contextUsage }),
    ...compactionTokenUsageMetadata(tokenUsage),
  }).value;
}

function validateCompletedCompaction(
  snapshot: CompletedContextCompaction,
  expectedMessagesBefore: number | undefined,
): void {
  if (
    snapshot.method !== 'tool_archive' &&
    snapshot.method !== 'tool_trim' &&
    snapshot.method !== 'llm_checkpoint'
  ) {
    throw new ContextCompactionResultValidationError('method');
  }
  if (
    (snapshot.method !== 'llm_checkpoint' && Object.hasOwn(snapshot, 'summary')) ||
    (snapshot.method === 'llm_checkpoint' && typeof snapshot.summary !== 'string')
  ) {
    throw new ContextCompactionResultValidationError('summary');
  }
  validateHmidOverflowRecovery(snapshot);
  validateCompletedTokenUsage(snapshot);
  validateReplacement(snapshot, expectedMessagesBefore);
  if (snapshot.method !== 'llm_checkpoint') {
    validateReplacementSourceIndexes(snapshot);
  }
  validateCounts(snapshot, [
    'tokensBefore',
    'tokensAfter',
    'serializedBytesBefore',
    'serializedBytesAfter',
  ]);
}

function validateCompletedTokenUsage(snapshot: CompletedContextCompaction): void {
  if (
    Object.hasOwn(snapshot, 'tokenUsage') &&
    readCompactionTokenUsage(snapshot.tokenUsage) === undefined
  ) {
    throw new ContextCompactionResultValidationError('tokenUsage');
  }
}

function validateHmidOverflowRecovery(snapshot: CompletedContextCompaction): void {
  if (!Object.hasOwn(snapshot, 'hmidOverflowRecovered')) return;
  if (snapshot.method === 'llm_checkpoint' && snapshot.hmidOverflowRecovered === true) return;
  throw new ContextCompactionResultValidationError('hmidOverflowRecovered');
}

export function createCompactionReplaceMetadata(
  result: CompletedContextCompaction,
  phase: ContextCompactionPhase,
  attemptId: string,
): PiBeforeLlmCallReplaceMetadata & {
  readonly compactionPhase: ContextCompactionPhase;
  readonly compactionAttemptId: string;
  readonly compactionMethod: ContextCompactionLifecycleMetadata['method'];
  readonly serializedBytesBefore: number;
  readonly serializedBytesAfter: number;
  readonly hmidOverflowRecovered?: true;
  readonly replacementSourceIndexes?: readonly number[];
  readonly contextUsage?: PostCompactionContextUsage;
  readonly tokenUsage?: CompactionTokenUsage;
} {
  const contextUsage = readPostCompactionContextUsage(result.contextUsage);
  const tokenUsage = readCompactionTokenUsage(result.tokenUsage);
  return captureSemanticSnapshot({
    compactionAttemptId: attemptId,
    replacementId: result.compactionId,
    strategyVersion: result.strategyVersion,
    compactionMethod: result.method,
    summary: '',
    compactedMessages: [],
    keptMessages: [],
    firstKeptIndex: 0,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    serializedBytesBefore: result.serializedBytesBefore,
    serializedBytesAfter: result.serializedBytesAfter,
    messagesBefore: result.messagesBefore,
    messagesAfter: result.messagesAfter,
    compactionPhase: phase,
    ...(result.hmidOverflowRecovered ? { hmidOverflowRecovered: true as const } : {}),
    ...(result.method !== 'llm_checkpoint'
      ? { replacementSourceIndexes: [...result.replacementSourceIndexes] }
      : {}),
    ...(contextUsage === undefined ? {} : { contextUsage }),
    ...compactionTokenUsageMetadata(tokenUsage),
  }).value;
}

function validateReplacementSourceIndexes(
  result: Extract<CompletedContextCompaction, { readonly method: 'tool_archive' | 'tool_trim' }>,
): void {
  if (
    !Array.isArray(result.replacementSourceIndexes) ||
    result.replacementSourceIndexes.length !== result.replacementMessages.length
  ) {
    throw new ContextCompactionResultValidationError('replacementSourceIndexes');
  }
  let previous = -1;
  result.replacementSourceIndexes.forEach((index) => {
    if (!Number.isSafeInteger(index) || index <= previous || index >= result.messagesBefore) {
      throw new ContextCompactionResultValidationError('replacementSourceIndexes');
    }
    previous = index;
  });
}

function validateReplacement(
  result: Extract<ContextCompactionResult, { readonly status: 'completed' | 'replaced' }>,
  expectedMessagesBefore: number | undefined,
): void {
  if (!Array.isArray(result.replacementMessages)) {
    throw new ContextCompactionResultValidationError('replacementMessages');
  }
  validateCanonicalHistoryMessages(result.replacementMessages);
  validateCounts(result, ['messagesBefore', 'messagesAfter']);
  if (
    (expectedMessagesBefore !== undefined && result.messagesBefore !== expectedMessagesBefore) ||
    result.messagesAfter !== result.replacementMessages.length
  ) {
    throw new ContextCompactionResultValidationError('messageCounts');
  }
}

function validateCounts(result: object, fields: readonly string[]): void {
  fields.forEach((field) => {
    const value = Reflect.get(result, field);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new ContextCompactionResultValidationError(field);
    }
  });
}

export function readCompactionLifecycleMetadata(
  value: unknown,
): ContextCompactionLifecycleMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const attemptId = readCompactionAttemptId(value);
  const compactionId = readNonEmpty(value, 'replacementId');
  const strategyVersion = readNonEmpty(value, 'strategyVersion');
  const method = readCompactionMethod(Reflect.get(value, 'compactionMethod'));
  const phase = Reflect.get(value, 'compactionPhase');
  if (!attemptId || !compactionId || !strategyVersion || !method || !isCompactionPhase(phase)) {
    return undefined;
  }
  const counts = readCompactionLifecycleCounts(value);
  const contextUsage = readPostCompactionContextUsage(Reflect.get(value, 'contextUsage'));
  const tokenUsage = readCompactionTokenUsage(Reflect.get(value, 'tokenUsage'));
  if (!counts) return undefined;
  return Object.freeze({
    attemptId,
    compactionId,
    method,
    strategyVersion,
    phase,
    ...counts,
    ...(Reflect.get(value, 'hmidOverflowRecovered') === true
      ? { hmidOverflowRecovered: true as const }
      : {}),
    ...(contextUsage === undefined ? {} : { contextUsage }),
    ...compactionTokenUsageMetadata(tokenUsage),
  });
}

function readCompactionLifecycleCounts(
  value: Readonly<Record<PropertyKey, unknown>>,
):
  | Pick<
      ContextCompactionLifecycleMetadata,
      | 'messagesBefore'
      | 'messagesAfter'
      | 'tokensBefore'
      | 'tokensAfter'
      | 'serializedBytesBefore'
      | 'serializedBytesAfter'
    >
  | undefined {
  const messagesBefore = readCount(value, 'messagesBefore');
  const messagesAfter = readCount(value, 'messagesAfter');
  const tokensBefore = readCount(value, 'tokensBefore');
  const tokensAfter = readCount(value, 'tokensAfter');
  const serializedBytesBefore = readCount(value, 'serializedBytesBefore');
  const serializedBytesAfter = readCount(value, 'serializedBytesAfter');
  return messagesBefore !== undefined &&
    messagesAfter !== undefined &&
    tokensBefore !== undefined &&
    tokensAfter !== undefined &&
    serializedBytesBefore !== undefined &&
    serializedBytesAfter !== undefined
    ? {
        messagesBefore,
        messagesAfter,
        tokensBefore,
        tokensAfter,
        serializedBytesBefore,
        serializedBytesAfter,
      }
    : undefined;
}

function readCompactionMethod(
  value: unknown,
): ContextCompactionLifecycleMetadata['method'] | undefined {
  return value === 'tool_archive' || value === 'tool_trim' || value === 'llm_checkpoint'
    ? value
    : undefined;
}

export function readPostCompactionContextUsage(
  value: unknown,
): PostCompactionContextUsage | undefined {
  if (!isRecord(value) || Reflect.get(value, 'totalCountSource') !== 'LOCAL_ESTIMATE') {
    return undefined;
  }
  const contextWindowTokens = readPositiveTokenEstimate(value, 'contextWindowTokens');
  const usedTokens = readTokenEstimate(value, 'usedTokens');
  const rawComponents = Reflect.get(value, 'components');
  if (
    contextWindowTokens === undefined ||
    usedTokens === undefined ||
    !Array.isArray(rawComponents) ||
    rawComponents.length !== CONTEXT_USAGE_COMPONENT_KINDS.length
  ) {
    return undefined;
  }
  const components = rawComponents.flatMap((component, index): ContextUsageComponent[] => {
    if (!isRecord(component)) return [];
    const expectedKind = CONTEXT_USAGE_COMPONENT_KINDS[index];
    const tokens = readTokenEstimate(component, 'tokens');
    return expectedKind !== undefined &&
      Reflect.get(component, 'kind') === expectedKind &&
      tokens !== undefined
      ? [{ kind: expectedKind, tokens }]
      : [];
  });
  if (
    components.length !== CONTEXT_USAGE_COMPONENT_KINDS.length ||
    !tokenEstimatesMatch(
      components.reduce((sum, component) => sum + component.tokens, 0),
      usedTokens,
    )
  ) {
    return undefined;
  }
  return {
    contextWindowTokens,
    usedTokens,
    totalCountSource: 'LOCAL_ESTIMATE',
    components,
  };
}

type CompactionCommitMetadata =
  | {
      readonly compactionId: string;
      readonly method: 'tool_archive' | 'tool_trim';
      readonly summary: string;
      readonly replacementSourceIndexes: readonly number[];
      readonly currentUserSourceIndex?: number;
    }
  | {
      readonly compactionId: string;
      readonly method: 'llm_checkpoint';
      readonly summary: string;
      readonly currentUserSourceIndex?: number;
    };

export function readCompactionCommitMetadata(value: unknown): CompactionCommitMetadata | undefined {
  const lifecycle = readCompactionLifecycleMetadata(value);
  if (!lifecycle || !isRecord(value)) return undefined;
  const summary = Reflect.get(value, 'summary');
  if (typeof summary !== 'string') return undefined;
  const currentUserSourceIndex = readOptionalCurrentUserSourceIndex(value, lifecycle);
  if (currentUserSourceIndex === null) return undefined;
  return lifecycle.method === 'llm_checkpoint'
    ? readCheckpointCommitMetadata(lifecycle, summary, currentUserSourceIndex)
    : readToolResultCommitMetadata(value, lifecycle, summary, currentUserSourceIndex);
}

function readCheckpointCommitMetadata(
  lifecycle: ContextCompactionLifecycleMetadata,
  summary: string,
  currentUserSourceIndex: number | undefined,
): CompactionCommitMetadata | undefined {
  if (currentUserSourceIndex !== undefined && lifecycle.messagesAfter !== 3) return undefined;
  return Object.freeze({
    compactionId: lifecycle.compactionId,
    method: 'llm_checkpoint',
    summary,
    ...(currentUserSourceIndex === undefined ? {} : { currentUserSourceIndex }),
  });
}

function readToolResultCommitMetadata(
  value: Readonly<Record<PropertyKey, unknown>>,
  lifecycle: ContextCompactionLifecycleMetadata,
  summary: string,
  currentUserSourceIndex: number | undefined,
): CompactionCommitMetadata | undefined {
  if (lifecycle.method === 'llm_checkpoint') return undefined;
  const replacementSourceIndexes = Reflect.get(value, 'replacementSourceIndexes');
  const expectedSourceCount =
    currentUserSourceIndex === undefined ? lifecycle.messagesAfter : lifecycle.messagesAfter - 2;
  if (
    !Array.isArray(replacementSourceIndexes) ||
    expectedSourceCount < 0 ||
    replacementSourceIndexes.length !== expectedSourceCount ||
    !replacementSourceIndexes.every(
      (index, position) =>
        Number.isSafeInteger(index) &&
        index >= 0 &&
        index < lifecycle.messagesBefore &&
        index !== currentUserSourceIndex &&
        (position === 0 || index > replacementSourceIndexes[position - 1]),
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    compactionId: lifecycle.compactionId,
    method: lifecycle.method,
    summary,
    replacementSourceIndexes: Object.freeze([...replacementSourceIndexes]) as readonly number[],
    ...(currentUserSourceIndex === undefined ? {} : { currentUserSourceIndex }),
  });
}

function readOptionalCurrentUserSourceIndex(
  value: Readonly<Record<PropertyKey, unknown>>,
  lifecycle: { readonly messagesBefore: number },
): number | undefined | null {
  if (!Object.hasOwn(value, 'currentUserSourceIndex')) return undefined;
  const index = Reflect.get(value, 'currentUserSourceIndex');
  return typeof index === 'number' &&
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < lifecycle.messagesBefore
    ? index
    : null;
}

export function readCompactionAttemptId(value: unknown): string | undefined {
  return isRecord(value) ? readNonEmpty(value, 'compactionAttemptId') : undefined;
}

function createContextCompactionAttemptId(namespace: string, sequence: number): string {
  return JSON.stringify(['agent-host-context-compaction', namespace, sequence]);
}

function validateContextCompactionAttemptScope(
  context: AgentEventContext,
  leaseId: string,
  phase: ContextCompactionPhase,
): void {
  assertAttemptIdentity(context.sessionId);
  assertAttemptIdentity(context.turnId);
  assertAttemptIdentity(leaseId);
  assertAttemptSequence(context.turnSequence);
  if (!isCompactionPhase(phase)) {
    throw new ContextCompactionResultValidationError('attemptId');
  }
}

function assertAttemptIdentity(value: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContextCompactionResultValidationError('attemptId');
  }
}

function assertAttemptSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ContextCompactionResultValidationError('attemptId');
  }
}

function createAttemptNamespace(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== 'function') {
    throw new ContextCompactionResultValidationError('attemptId');
  }
  return Reflect.apply(randomUUID, globalThis.crypto, []);
}

export function observeCompactionBestEffort(
  observer: ContextCompactionObserver | undefined,
  fact: ContextCompactionObservation,
): void {
  if (!observer) return;
  try {
    const detached = captureSemanticSnapshot(fact).value;
    nonAuthoritativeObservations.add(deliverObservation(observer, detached));
  } catch {
    // Live/UI observation is explicitly outside the authoritative outcome.
  }
}

async function deliverObservation(
  observer: ContextCompactionObserver,
  fact: ContextCompactionObservation,
): Promise<void> {
  try {
    await observer.observe(fact);
  } catch {
    // Live/UI observation is explicitly outside the authoritative outcome.
  }
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

type CapturedFailure =
  | { readonly failed: false }
  | { readonly failed: true; readonly error: unknown };

async function captureFailure(operation: () => Promise<void>): Promise<CapturedFailure> {
  try {
    await operation();
    return { failed: false };
  } catch (error) {
    return { failed: true, error };
  }
}

function normalizeIdentity(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContextCompactionResultValidationError(field);
  }
  const normalized = value.trim();
  try {
    encodeURIComponent(normalized);
  } catch {
    throw new ContextCompactionResultValidationError(field);
  }
  return normalized;
}

function readNonEmpty(
  value: Readonly<Record<PropertyKey, unknown>>,
  key: string,
): string | undefined {
  const field = Reflect.get(value, key);
  return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}

function readCount(value: Readonly<Record<PropertyKey, unknown>>, key: string): number | undefined {
  const field = Reflect.get(value, key);
  return typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
}

function readTokenEstimate(
  value: Readonly<Record<PropertyKey, unknown>>,
  key: string,
): number | undefined {
  const field = Reflect.get(value, key);
  return typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : undefined;
}

function readPositiveTokenEstimate(
  value: Readonly<Record<PropertyKey, unknown>>,
  key: string,
): number | undefined {
  const field = readTokenEstimate(value, key);
  return field !== undefined && field > 0 ? field : undefined;
}

function tokenEstimatesMatch(left: number, right: number): boolean {
  const tolerance =
    Number.EPSILON *
    Math.max(1, Math.abs(left), Math.abs(right)) *
    CONTEXT_USAGE_COMPONENT_KINDS.length;
  return Math.abs(left - right) <= tolerance;
}

function isCompactionPhase(value: unknown): value is ContextCompactionPhase {
  return value === 'initial' || value === 'iteration' || value === 'manual';
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
