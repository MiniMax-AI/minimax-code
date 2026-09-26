import type { CompactionSubagentState } from './compat.js';

export type ContextCompactionErrorCode =
  | 'INVALID_HISTORY'
  | 'INVALID_CHECKPOINT'
  | 'CHECKPOINT_PROVIDER_FAILED'
  | 'COMPACTION_INPUT_TOO_LARGE'
  | 'POST_ADMISSION_FAILED';

export type ContextCompactionStage = 'tool_trim' | 'llm_checkpoint' | 'post_admission';

export type CheckpointResponseContentKind = 'text' | 'thinking' | 'toolCall' | 'unknown';
type CheckpointStopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

export interface SubagentCheckpointStateSource {
  captureSubagents(input: {
    readonly sessionId: string;
  }): Promise<CompactionSubagentState | undefined>;
}

/** Runtime-owned thresholds shared by recoverable archive and destructive trim. */
export interface ToolResultCompactionConfig {
  readonly enabled?: boolean;
  /** Per-result pre-History safety fuse. Independent from enabled. */
  readonly maxInlineBytes?: number;
  /** Raw MCP detail fuse applied after Plugin hooks and before History. Independent from enabled. */
  readonly mcpDetailsMaxInlineBytes?: number;
  readonly watermarkBytes?: number;
  readonly minSavingsBytes?: number;
  readonly minCandidateBytes?: number;
  /** Positive count of recent complete tool rounds excluded from archive and trim. */
  readonly keepRecentRounds?: number;
}

export interface CheckpointGenerationMetadata {
  readonly responseContentKinds: readonly CheckpointResponseContentKind[];
  readonly stopReason: CheckpointStopReason;
  readonly outputTokens: number;
}

/**
 * Content-free sizing facts captured when compaction cannot admit a candidate
 * or a generated checkpoint. Counts, token estimates, and limits only; never
 * message text.
 */
export interface ContextCompactionSizeDiagnostics {
  readonly historyMessageCount: number;
  readonly protectedMessageCount?: number;
  readonly protectedInputTokens?: number;
  readonly protectedSerializedBytes?: number;
  readonly providerInputLimit: number;
  readonly maxSerializedInputBytes?: number;
  readonly hminAvailable?: boolean;
  /** Post-admission sizing: the measured next request before/after replacement. */
  readonly beforeInputTokens?: number;
  readonly beforeSerializedBytes?: number;
  readonly afterInputTokens?: number;
  readonly afterSerializedBytes?: number;
}

export class ContextCompactionError extends Error {
  override readonly name = 'ContextCompactionError';
  readonly diagnostics?: ContextCompactionSizeDiagnostics;

  constructor(
    readonly code: ContextCompactionErrorCode,
    readonly stage: ContextCompactionStage,
    message: string,
    options?: ErrorOptions & { readonly diagnostics?: ContextCompactionSizeDiagnostics },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.diagnostics !== undefined) this.diagnostics = options.diagnostics;
  }
}

/**
 * Why the Provider could not turn a candidate into a checkpoint within one request:
 * the input overflowed the context window, or the shared output budget ran out
 * (for example on reasoning) before any checkpoint text. Diagnostics only; the
 * candidate ladder treats both reasons identically.
 */
export type CheckpointCandidateTooLargeReason = 'input_overflow' | 'output_exhausted';

/**
 * The candidate is too large to checkpoint in one Provider request, normalized
 * at the request boundary. The candidate ladder advances to the next, smaller
 * candidate regardless of `reason`.
 */
export class CheckpointCandidateTooLargeError extends Error {
  override readonly name = 'CheckpointCandidateTooLargeError';

  constructor(
    cause: unknown,
    readonly reason: CheckpointCandidateTooLargeReason = 'input_overflow',
  ) {
    super(
      reason === 'output_exhausted'
        ? 'Checkpoint output budget was exhausted before any checkpoint text.'
        : 'Provider rejected checkpoint input because it exceeded the context limit.',
      { cause },
    );
  }
}
