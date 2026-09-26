import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type {
  CheckpointAttemptMetadata,
  CheckpointCandidate,
  CompactionTokenUsage,
} from '../../agent-host/contracts.js';
import {
  CheckpointCandidateTooLargeError,
  ContextCompactionError,
  type ContextCompactionSizeDiagnostics,
} from '../contracts.js';
import type { CompactionSubagentState } from '../compat.js';
import {
  buildCheckpointMessage,
  validateCheckpointGeneration,
  type CheckpointGeneration,
} from './checkpoint-format.js';
import {
  buildAllToolResultsCandidate,
  buildAttachmentFreeCandidate,
  buildMiddleDeletionCandidate,
  buildMinimalGenuineQueryCandidate,
  buildProtectedSkeletonCandidate,
  buildToolTrimCandidate,
  type ToolTrimCandidate,
} from './history-reduction.js';
import {
  evaluateToolResultCompactionAdmission,
  evaluateToolTrimAdmission,
  type PairedContextFootprint,
  type ToolTrimLimits,
} from './tool-trim-admission.js';
import type { ToolResultCompactionCandidate } from './tool-result-archiver.js';

export interface CompactContextInput {
  readonly history: readonly AgentMessage[];
  readonly instructions?: string;
  readonly limits: ToolTrimLimits;
  readonly measurePair: (input: {
    readonly beforeMessages: readonly AgentMessage[];
    readonly afterMessages: readonly AgentMessage[];
  }) => Promise<PairedContextFootprint>;
  /** Preplanned and materialized by the compactor after its lifecycle starts. */
  readonly toolResultCompactionCandidate?: ToolResultCompactionCandidate;
  /** Direct-module compatibility only; production disables the legacy 30% trim policy. */
  readonly allowLegacyToolTrim?: boolean;
  /**
   * Final-request admission for the generated checkpoint. Automatic callers
   * enforce it; the manual caller bypasses it because an explicit user request
   * always commits a validly generated checkpoint. A replacement can outgrow a
   * short history (bounded by the checkpoint output cap plus the host
   * appendix); the caller observes that case instead of intercepting it.
   */
  readonly finalAdmission?: 'enforce' | 'bypass';
  readonly checkpoint: {
    readonly tokensBefore: number;
    readonly timestamp: number;
    readonly open: () => Promise<CheckpointSession>;
    readonly onAttemptSettled?: (metadata: CheckpointAttemptMetadata) => void;
    readonly getTokenUsage?: () => CompactionTokenUsage | undefined;
  };
  readonly captureSubagents?: () => Promise<CompactionSubagentState | undefined>;
  readonly onSubagentCaptureFailure?: () => void;
  readonly signal?: AbortSignal;
}

interface CheckpointRequestInput {
  readonly messages: readonly AgentMessage[];
  readonly instructions?: string;
  readonly signal?: AbortSignal;
}

export interface CheckpointSession {
  readonly maxOutputTokens: number;
  readonly fits: (input: Omit<CheckpointRequestInput, 'signal'>) => boolean;
  /** Optional failure-path sizing probe; never used for candidate selection. */
  readonly measure?: (input: Omit<CheckpointRequestInput, 'signal'>) => {
    readonly inputTokens: number;
    readonly serializedBytes: number;
  };
  readonly generate: (input: CheckpointRequestInput) => Promise<CheckpointGeneration>;
}

export type CompactContextDecision =
  | {
      readonly method: 'tool_archive';
      readonly replacementMessages: readonly AgentMessage[];
      readonly archivedResultCount: number;
      readonly measurement: PairedContextFootprint;
    }
  | {
      /** Legacy direct-call compatibility; production compaction injects the archive strategy. */
      readonly method: 'tool_trim';
      readonly replacementMessages: readonly AgentMessage[];
      readonly trimmedResultCount: number;
      readonly measurement: PairedContextFootprint;
    }
  | {
      readonly method: 'llm_checkpoint';
      readonly replacementMessages: readonly AgentMessage[];
      readonly summary: string;
      readonly schemaStatus: 'exact' | 'soft_fallback';
      readonly generationAttempts: number;
      readonly hmidOverflowRecovered?: true;
      readonly tokenUsage?: CompactionTokenUsage;
      readonly measurement: PairedContextFootprint;
    };

export async function compactContext(input: CompactContextInput): Promise<CompactContextDecision> {
  validateInput(input);
  input.signal?.throwIfAborted();
  const instructions = input.instructions?.trim() || undefined;
  let planning;
  if (input.allowLegacyToolTrim === false) {
    planning = instructions
      ? { candidate: input.toolResultCompactionCandidate }
      : await planDirectToolResultCompaction(input, input.toolResultCompactionCandidate);
  } else {
    planning = instructions
      ? { candidate: captureToolTrimCandidate(input.history) }
      : await planDirectTrim(input);
  }
  input.signal?.throwIfAborted();
  if (planning.decision) return planning.decision;

  const generated = await generateCheckpoint(input, planning.candidate, instructions);
  input.signal?.throwIfAborted();
  const validated = validateCheckpointGeneration(generated.generation, generated.maxOutputTokens);
  const subagents = await captureSubagents(input);
  input.signal?.throwIfAborted();
  let replacementMessages = [
    buildCheckpointMessage(input.history, validated.summary, input.checkpoint.tokensBefore, {
      timestamp: input.checkpoint.timestamp,
      ...(subagents ? { subagents } : {}),
    }),
  ];
  let measurement = await input.measurePair({
    beforeMessages: input.history,
    afterMessages: replacementMessages,
  });
  input.signal?.throwIfAborted();
  assertValidMeasurement(measurement);
  if (subagents && !fitsFinalRequest(measurement, input.limits)) {
    replacementMessages = [
      buildCheckpointMessage(input.history, validated.summary, input.checkpoint.tokensBefore, {
        timestamp: input.checkpoint.timestamp,
      }),
    ];
    measurement = await input.measurePair({
      beforeMessages: input.history,
      afterMessages: replacementMessages,
    });
    input.signal?.throwIfAborted();
    assertValidMeasurement(measurement);
  }
  if (!admitsFinalRequest(input, measurement)) {
    throw new ContextCompactionError(
      'POST_ADMISSION_FAILED',
      'post_admission',
      'Generated checkpoint does not fit the next Provider request.',
      { diagnostics: postAdmissionDiagnostics(input, measurement) },
    );
  }
  return {
    method: 'llm_checkpoint',
    replacementMessages,
    summary: validated.summary,
    schemaStatus: validated.schemaStatus,
    generationAttempts: generated.attempts,
    ...hmidRecoveryMetadata(generated.hmidOverflowRecovered),
    ...tokenUsageMetadata(generated.tokenUsage),
    measurement,
  };
}

async function captureSubagents(
  input: CompactContextInput,
): Promise<CompactionSubagentState | undefined> {
  if (!input.captureSubagents) return undefined;
  try {
    const snapshot = await input.captureSubagents();
    return snapshot && snapshot.total > 0 ? snapshot : undefined;
  } catch {
    try {
      input.onSubagentCaptureFailure?.();
    } catch {
      // Diagnostics are best effort and cannot change compaction.
    }
    return undefined;
  }
}

async function planDirectToolResultCompaction(
  input: CompactContextInput,
  candidate: ToolResultCompactionCandidate | undefined,
): Promise<{
  readonly candidate?: ToolResultCompactionCandidate;
  readonly decision?: Extract<
    CompactContextDecision,
    { readonly method: 'tool_archive' | 'tool_trim' }
  >;
}> {
  if (!candidate) return {};
  const admission = await evaluateToolResultCompactionAdmission({
    h0: input.history,
    candidate,
    limits: input.limits,
    measurePair: input.measurePair,
  });
  if (!admission.admitted) return { candidate };
  if ('archivedResultCount' in candidate) {
    return {
      candidate,
      decision: {
        method: 'tool_archive',
        replacementMessages: candidate.messages,
        archivedResultCount: candidate.archivedResultCount,
        measurement: admission.measurement,
      },
    };
  }
  return {
    candidate,
    decision: {
      method: 'tool_trim',
      replacementMessages: candidate.messages,
      trimmedResultCount: candidate.trimmedResultCount,
      measurement: admission.measurement,
    },
  };
}

async function planDirectTrim(input: CompactContextInput): Promise<{
  readonly candidate: ToolTrimCandidate;
  readonly decision?: Extract<CompactContextDecision, { readonly method: 'tool_trim' }>;
}> {
  const candidate = captureToolTrimCandidate(input.history);
  const admission = await evaluateToolTrimAdmission({
    h0: input.history,
    candidate,
    limits: input.limits,
    measurePair: input.measurePair,
  });
  if (!admission.admitted) return { candidate };
  return {
    candidate,
    decision: {
      method: 'tool_trim',
      replacementMessages: candidate.messages,
      trimmedResultCount: candidate.trimmedResultCount,
      measurement: admission.measurement,
    },
  };
}

/**
 * Provider-level checkpoint failures (`stopReason === "error"`) get exactly one
 * bounded in-place retry of the same candidate, keeping the invocation's
 * incremental attempt numbering and never re-sending earlier candidates that
 * already overflowed. A second failure surfaces as CHECKPOINT_PROVIDER_FAILED
 * so callers can attribute the failure to the Provider instead of the
 * checkpoint content. A typed overflow thrown by the retry propagates to the
 * caller's normal candidate progression.
 */
async function generateCandidateWithProviderRetry({
  input,
  session,
  candidate,
  counter,
  messages,
  instructions,
}: {
  readonly input: CompactContextInput;
  readonly session: CheckpointSession;
  readonly candidate: CheckpointCandidate;
  readonly counter: { value: number };
  readonly messages: readonly AgentMessage[];
  readonly instructions: string | undefined;
}): Promise<{ readonly generation: CheckpointGeneration; readonly attemptNumber: number }> {
  counter.value += 1;
  const first = await generateCheckpointAttempt({
    input,
    session,
    candidate,
    attemptNumber: counter.value,
    messages,
    instructions,
  });
  if (first.stopReason !== 'error') return { generation: first, attemptNumber: counter.value };
  input.signal?.throwIfAborted();
  counter.value += 1;
  const second = await generateCheckpointAttempt({
    input,
    session,
    candidate,
    attemptNumber: counter.value,
    messages,
    instructions,
  });
  if (second.stopReason !== 'error') return { generation: second, attemptNumber: counter.value };
  throw new ContextCompactionError(
    'CHECKPOINT_PROVIDER_FAILED',
    'llm_checkpoint',
    'Checkpoint Provider request failed after one retry.',
  );
}

async function generateCheckpoint(
  input: CompactContextInput,
  candidate: ToolResultCompactionCandidate | ToolTrimCandidate | undefined,
  instructions: string | undefined,
): Promise<{
  readonly generation: CheckpointGeneration;
  readonly attempts: number;
  readonly maxOutputTokens: number;
  readonly hmidOverflowRecovered?: true;
  readonly tokenUsage?: CompactionTokenUsage;
}> {
  const session = await input.checkpoint.open();
  validateNonNegativeSafeInteger(session.maxOutputTokens, 'maxOutputTokens');
  const checkpointCandidates: Array<{
    readonly candidate: CheckpointCandidate;
    readonly messages: readonly AgentMessage[];
  }> = [{ candidate: 'h0', messages: input.history }];
  if (candidate && toolResultReplacementCount(candidate) > 0) {
    checkpointCandidates.push({ candidate: 'htrim', messages: candidate.messages });
  }
  const hall = buildAllToolResultsCandidate(checkpointCandidates.at(-1)?.messages ?? input.history);
  if (hall.trimmedResultCount > 0) {
    checkpointCandidates.push({ candidate: 'hall', messages: hall.messages });
  }
  const counter = { value: 0 };
  let overflow: CheckpointCandidateTooLargeError | undefined;

  for (const checkpointCandidate of checkpointCandidates) {
    input.signal?.throwIfAborted();
    if (!session.fits(checkpointRequest(input, checkpointCandidate.messages, instructions))) {
      continue;
    }
    try {
      const settled = await generateCandidateWithProviderRetry({
        input,
        session,
        candidate: checkpointCandidate.candidate,
        counter,
        messages: checkpointCandidate.messages,
        instructions,
      });
      return {
        generation: settled.generation,
        attempts: settled.attemptNumber,
        maxOutputTokens: session.maxOutputTokens,
        ...tokenUsageMetadata(input.checkpoint.getTokenUsage?.()),
      };
    } catch (cause) {
      if (!(cause instanceof CheckpointCandidateTooLargeError)) throw cause;
      overflow = cause;
    }
  }

  return recoverAfterHall({
    input,
    session,
    hallMessages: hall.messages,
    instructions,
    counter,
    priorOverflow: overflow,
  });
}

function toolResultReplacementCount(
  candidate: ToolResultCompactionCandidate | ToolTrimCandidate,
): number {
  return 'archivedResultCount' in candidate
    ? candidate.archivedResultCount
    : candidate.trimmedResultCount;
}

async function recoverAfterHall({
  input,
  session,
  hallMessages,
  instructions,
  counter,
  priorOverflow,
}: {
  readonly input: CompactContextInput;
  readonly session: CheckpointSession;
  readonly hallMessages: readonly AgentMessage[];
  readonly instructions: string | undefined;
  readonly counter: { value: number };
  readonly priorOverflow: CheckpointCandidateTooLargeError | undefined;
}): Promise<{
  readonly generation: CheckpointGeneration;
  readonly attempts: number;
  readonly maxOutputTokens: number;
  readonly hmidOverflowRecovered?: true;
  readonly tokenUsage?: CompactionTokenUsage;
}> {
  input.signal?.throwIfAborted();
  const hvideo = buildAttachmentFreeCandidate(hallMessages);
  let overflow = priorOverflow;
  if (
    hvideo.replacedBlockCount > 0 &&
    session.fits(checkpointRequest(input, hvideo.messages, instructions))
  ) {
    input.signal?.throwIfAborted();
    try {
      const settled = await generateCandidateWithProviderRetry({
        input,
        session,
        candidate: 'hvideo',
        counter,
        messages: hvideo.messages,
        instructions,
      });
      return {
        generation: settled.generation,
        attempts: settled.attemptNumber,
        maxOutputTokens: session.maxOutputTokens,
        ...tokenUsageMetadata(input.checkpoint.getTokenUsage?.()),
      };
    } catch (cause) {
      if (!(cause instanceof CheckpointCandidateTooLargeError)) throw cause;
      overflow = cause;
    }
  }

  const hmid = buildMiddleDeletionCandidate(hvideo.messages, (messages) =>
    session.fits(checkpointRequest(input, messages, instructions)),
  );
  if (!hmid) {
    // No middle-deletion combination fits locally, including the protected
    // skeleton. Hmin stays the last resort instead of failing closed here.
    return generateHminCheckpoint({
      input,
      session,
      attachmentFreeMessages: hvideo.messages,
      instructions,
      counter,
      overflow,
    });
  }

  input.signal?.throwIfAborted();
  try {
    const settled = await generateCandidateWithProviderRetry({
      input,
      session,
      candidate: 'hmid',
      counter,
      messages: hmid,
      instructions,
    });
    return {
      generation: settled.generation,
      attempts: settled.attemptNumber,
      maxOutputTokens: session.maxOutputTokens,
      ...tokenUsageMetadata(input.checkpoint.getTokenUsage?.()),
    };
  } catch (cause) {
    if (!(cause instanceof CheckpointCandidateTooLargeError)) throw cause;
    overflow = cause;
  }

  return generateHminCheckpoint({
    input,
    session,
    attachmentFreeMessages: hvideo.messages,
    instructions,
    counter,
    overflow,
  });
}

async function generateHminCheckpoint({
  input,
  session,
  attachmentFreeMessages,
  instructions,
  counter,
  overflow,
}: {
  readonly input: CompactContextInput;
  readonly session: CheckpointSession;
  readonly attachmentFreeMessages: readonly AgentMessage[];
  readonly instructions: string | undefined;
  readonly counter: { value: number };
  readonly overflow: CheckpointCandidateTooLargeError | undefined;
}): Promise<{
  readonly generation: CheckpointGeneration;
  readonly attempts: number;
  readonly maxOutputTokens: number;
  readonly hmidOverflowRecovered?: true;
  readonly tokenUsage?: CompactionTokenUsage;
}> {
  input.signal?.throwIfAborted();
  const hmin = buildMinimalGenuineQueryCandidate(attachmentFreeMessages);
  if (!hmin || !session.fits(checkpointRequest(input, hmin, instructions))) {
    throw inputTooLarge(
      overflow,
      captureSizeDiagnosticsBestEffort({
        input,
        session,
        attachmentFreeMessages,
        instructions,
        hminAvailable: hmin !== undefined,
      }),
    );
  }
  input.signal?.throwIfAborted();
  try {
    const settled = await generateCandidateWithProviderRetry({
      input,
      session,
      candidate: 'hmin',
      counter,
      messages: hmin,
      instructions,
    });
    return {
      generation: settled.generation,
      attempts: settled.attemptNumber,
      maxOutputTokens: session.maxOutputTokens,
      ...(overflow ? { hmidOverflowRecovered: true as const } : {}),
      ...tokenUsageMetadata(input.checkpoint.getTokenUsage?.()),
    };
  } catch (cause) {
    if (cause instanceof CheckpointCandidateTooLargeError) {
      throw inputTooLarge(
        cause,
        captureSizeDiagnosticsBestEffort({
          input,
          session,
          attachmentFreeMessages,
          instructions,
          hminAvailable: true,
        }),
      );
    }
    throw cause;
  }
}

function hmidRecoveryMetadata(recovered: boolean | undefined): {
  readonly hmidOverflowRecovered?: true;
} {
  return recovered ? { hmidOverflowRecovered: true } : {};
}

function tokenUsageMetadata(tokenUsage: CompactionTokenUsage | undefined): {
  readonly tokenUsage?: CompactionTokenUsage;
} {
  return tokenUsage === undefined ? {} : { tokenUsage };
}

async function generateCheckpointAttempt({
  input,
  session,
  candidate,
  attemptNumber,
  messages,
  instructions,
}: {
  readonly input: CompactContextInput;
  readonly session: CheckpointSession;
  readonly candidate: CheckpointCandidate;
  readonly attemptNumber: number;
  readonly messages: readonly AgentMessage[];
  readonly instructions: string | undefined;
}): Promise<CheckpointGeneration> {
  const startedAt = performance.now();
  try {
    const generation = await session.generate(checkpointRequest(input, messages, instructions));
    reportCheckpointAttempt(input, {
      candidate,
      attemptNumber,
      outcome: checkpointAttemptOutcome(generation.stopReason),
      durationMs: Math.max(0, performance.now() - startedAt),
      inputMessageCount: messages.length,
    });
    return generation;
  } catch (cause) {
    let outcome: CheckpointAttemptMetadata['outcome'] = 'failed';
    if (cause instanceof CheckpointCandidateTooLargeError) {
      outcome = cause.reason === 'output_exhausted' ? 'output_exhausted' : 'input_too_large';
    } else if (input.signal?.aborted) outcome = 'aborted';
    reportCheckpointAttempt(input, {
      candidate,
      attemptNumber,
      outcome,
      durationMs: Math.max(0, performance.now() - startedAt),
      inputMessageCount: messages.length,
    });
    throw cause;
  }
}

function checkpointAttemptOutcome(
  stopReason: CheckpointGeneration['stopReason'],
): CheckpointAttemptMetadata['outcome'] {
  if (stopReason === 'aborted') return 'aborted';
  if (stopReason === 'error') return 'failed';
  return 'generated';
}

function reportCheckpointAttempt(
  input: CompactContextInput,
  metadata: CheckpointAttemptMetadata,
): void {
  try {
    input.checkpoint.onAttemptSettled?.(metadata);
  } catch {
    // Diagnostics cannot change compaction behavior.
  }
}

function checkpointRequest(
  input: CompactContextInput,
  messages: readonly AgentMessage[],
  instructions: string | undefined,
): CheckpointRequestInput {
  return {
    messages,
    ...(instructions ? { instructions } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

function captureToolTrimCandidate(history: readonly AgentMessage[]): ToolTrimCandidate {
  try {
    return buildToolTrimCandidate(history);
  } catch (cause) {
    throw invalidHistory(cause);
  }
}

function validateInput(input: CompactContextInput): void {
  validatePositiveSafeInteger(input.limits.providerInputLimit, 'providerInputLimit');
  if (input.limits.maxSerializedInputBytes !== undefined) {
    validatePositiveSafeInteger(input.limits.maxSerializedInputBytes, 'maxSerializedInputBytes');
  }
  validateNonNegativeSafeInteger(input.checkpoint.tokensBefore, 'tokensBefore');
  if (!Number.isFinite(input.checkpoint.timestamp)) {
    throw new TypeError('Context compaction checkpoint timestamp must be finite.');
  }
}

function assertValidMeasurement(measurement: PairedContextFootprint): void {
  validateFootprint(measurement.before, 'before');
  validateFootprint(measurement.after, 'after');
}

function validateFootprint(
  footprint: PairedContextFootprint['before'],
  side: 'before' | 'after',
): void {
  validateNonNegativeSafeInteger(footprint.inputTokens, `${side}.inputTokens`);
  validateNonNegativeSafeInteger(footprint.serializedBytes, `${side}.serializedBytes`);
}

function validateNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Context compaction ${field} must be a non-negative safe integer.`);
  }
}

function validatePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Context compaction ${field} must be a positive safe integer.`);
  }
}

function fitsFinalRequest(measurement: PairedContextFootprint, limits: ToolTrimLimits): boolean {
  return (
    measurement.after.inputTokens <= limits.providerInputLimit &&
    measurement.after.serializedBytes <=
      (limits.maxSerializedInputBytes ?? measurement.before.serializedBytes)
  );
}

/** The manual caller bypasses the final gate; automatic callers enforce it. */
function admitsFinalRequest(
  input: CompactContextInput,
  measurement: PairedContextFootprint,
): boolean {
  return input.finalAdmission === 'bypass' || fitsFinalRequest(measurement, input.limits);
}

/** Content-free sizing facts for the POST_ADMISSION_FAILED failure log. */
function postAdmissionDiagnostics(
  input: CompactContextInput,
  measurement: PairedContextFootprint,
): ContextCompactionSizeDiagnostics {
  return {
    historyMessageCount: input.history.length,
    providerInputLimit: input.limits.providerInputLimit,
    ...(input.limits.maxSerializedInputBytes === undefined
      ? {}
      : { maxSerializedInputBytes: input.limits.maxSerializedInputBytes }),
    beforeInputTokens: measurement.before.inputTokens,
    beforeSerializedBytes: measurement.before.serializedBytes,
    afterInputTokens: measurement.after.inputTokens,
    afterSerializedBytes: measurement.after.serializedBytes,
  };
}

function invalidHistory(cause: unknown): ContextCompactionError {
  return new ContextCompactionError(
    'INVALID_HISTORY',
    'tool_trim',
    'Context compaction requires a settled canonical ToolRound sequence.',
    { cause },
  );
}

function inputTooLarge(
  cause: unknown,
  diagnostics?: ContextCompactionSizeDiagnostics,
): ContextCompactionError {
  return new ContextCompactionError(
    'COMPACTION_INPUT_TOO_LARGE',
    'llm_checkpoint',
    'Context is too large for bounded checkpoint generation.',
    { cause, ...(diagnostics === undefined ? {} : { diagnostics }) },
  );
}

/**
 * Content-free sizing facts for the COMPACTION_INPUT_TOO_LARGE failure log.
 * Best effort: sizing must never mask or change the original failure.
 */
function captureSizeDiagnosticsBestEffort({
  input,
  session,
  attachmentFreeMessages,
  instructions,
  hminAvailable,
}: {
  readonly input: CompactContextInput;
  readonly session: CheckpointSession;
  readonly attachmentFreeMessages: readonly AgentMessage[];
  readonly instructions: string | undefined;
  readonly hminAvailable: boolean;
}): ContextCompactionSizeDiagnostics | undefined {
  try {
    const skeleton = buildProtectedSkeletonCandidate(attachmentFreeMessages);
    const measured = session.measure?.(checkpointRequest(input, skeleton, instructions));
    return {
      historyMessageCount: input.history.length,
      protectedMessageCount: skeleton.length,
      ...(measured === undefined
        ? {}
        : {
            protectedInputTokens: measured.inputTokens,
            protectedSerializedBytes: measured.serializedBytes,
          }),
      providerInputLimit: input.limits.providerInputLimit,
      ...(input.limits.maxSerializedInputBytes === undefined
        ? {}
        : { maxSerializedInputBytes: input.limits.maxSerializedInputBytes }),
      hminAvailable,
    };
  } catch {
    return undefined;
  }
}
