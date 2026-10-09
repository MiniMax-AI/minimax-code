import type {
  LLMModelConfig,
  PiAgentMessage,
  PiBeforeLlmCallHookInput,
  LLMRequestSettledEvent,
} from '@mavis/agent-core/pi-turn-runner';
import type { ContextUsageSnapshot } from '@mavis/agent-core/protocol';

import type { AgentEventContext } from '../events/contracts.js';
import type { CanonicalHistoryMessages } from '../history/contracts.js';
import type { AcceptedCompactionLease, AgentHostCloseResult } from '../runner/contracts.js';

export type CheckpointResponseContentKind = 'text' | 'thinking' | 'toolCall' | 'unknown';
export type CheckpointStopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

export interface CheckpointGenerationMetadata {
  readonly responseContentKinds: readonly CheckpointResponseContentKind[];
  readonly stopReason: CheckpointStopReason;
  readonly outputTokens: number;
}

export type CheckpointCandidate = 'h0' | 'htrim' | 'hall' | 'hvideo' | 'hmid' | 'hmin';
type CheckpointAttemptOutcome =
  | 'generated'
  | 'input_too_large'
  | 'output_exhausted'
  | 'aborted'
  | 'failed';

export interface CompactionTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly incomplete: boolean;
}

export interface CheckpointAttemptMetadata {
  readonly candidate: CheckpointCandidate;
  /** One-based logical Provider attempt number. */
  readonly attemptNumber: number;
  readonly outcome: CheckpointAttemptOutcome;
  /** Elapsed time inside the Provider generation request only. */
  readonly durationMs: number;
  /** Safe structural size; message bodies are never exposed. */
  readonly inputMessageCount?: number;
}

export interface AgentCompactionInput {
  readonly lease: AcceptedCompactionLease;
  readonly reason?: string;
  readonly customInstructions?: string;
}

export type CompactionOutcome =
  | {
      readonly status: 'completed';
      readonly compactionId: string;
      readonly messagesBefore: number;
      readonly messagesAfter: number;
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly contextUsage?: PostCompactionContextUsage;
      /**
       * A Codex PostCompact Hook stopped further processing after the history
       * commit. The compaction remains successful and must not be rolled back.
       */
      readonly hookStopReason?: string;
    }
  | {
      readonly status: 'unchanged';
      readonly reason: 'nothing-to-compact';
    }
  | {
      readonly status: 'aborted';
      readonly reason?: string;
    }
  | {
      readonly status: 'failed';
      readonly error: unknown;
    };

export type ContextCompactionPhase = PiBeforeLlmCallHookInput['phase'] | 'manual';

export interface ManualContextCompactionInput {
  readonly sessionId: string;
  readonly messages: readonly PiAgentMessage[];
  readonly model: LLMModelConfig['model'];
  readonly thinkingLevel: PiBeforeLlmCallHookInput['thinkingLevel'];
  readonly maxSerializedInputBytes?: number;
  readonly apiKey?: LLMModelConfig['apiKey'];
  readonly headers?: LLMModelConfig['headers'];
  readonly streamFn?: LLMModelConfig['streamFn'];
  readonly maxTokens?: PiBeforeLlmCallHookInput['maxTokens'];
  readonly cacheRetention?: PiBeforeLlmCallHookInput['cacheRetention'];
  readonly payloadTransform?: PiBeforeLlmCallHookInput['payloadTransform'];
  readonly systemPrompt?: PiBeforeLlmCallHookInput['systemPrompt'];
  readonly tools?: PiBeforeLlmCallHookInput['tools'];
  readonly signal?: AbortSignal;
  readonly customInstructions?: string;
}

interface CompletedContextCompactionBase {
  readonly status: 'completed';
  readonly compactionId: string;
  readonly strategyVersion: string;
  readonly replacementMessages: CanonicalHistoryMessages;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly serializedBytesBefore: number;
  readonly serializedBytesAfter: number;
  /** Hmin recovered from the single Hmid Provider overflow. */
  readonly hmidOverflowRecovered?: true;
  readonly tokenUsage?: CompactionTokenUsage;
  /**
   * Post-compaction Context Usage measured over the replacement messages.
   * Absent when the estimate could not be produced; a successful compaction is
   * never downgraded because observability failed.
   */
  readonly contextUsage?: PostCompactionContextUsage;
}

type ContextCompactionMethod = 'tool_archive' | 'tool_trim' | 'llm_checkpoint';

export type CompletedContextCompaction = CompletedContextCompactionBase &
  (
    | {
        readonly method: 'tool_archive';
        /** Exact source H0 envelope index for each replacement message. */
        readonly replacementSourceIndexes: readonly number[];
        readonly summary?: never;
      }
    | {
        /** Legacy durable method retained only for recovery compatibility. */
        readonly method: 'tool_trim';
        /** Exact source H0 envelope index for each replacement message. */
        readonly replacementSourceIndexes: readonly number[];
        readonly summary?: never;
      }
    | {
        readonly method: 'llm_checkpoint';
        readonly replacementSourceIndexes?: never;
        readonly summary: string;
      }
  );

/**
 * Immediate local estimate published so Context Usage surfaces (CLI status
 * line, Desktop donut) drop right after compaction instead of waiting for the
 * next provider-anchored turn.
 */
export interface PostCompactionContextUsage extends ContextUsageSnapshot {
  readonly totalCountSource: 'LOCAL_ESTIMATE';
}

export interface FilteredContextReplacement {
  readonly status: 'replaced';
  readonly reason: 'internal-context-filter';
  readonly replacementId: string;
  readonly strategyVersion: string;
  readonly replacementMessages: CanonicalHistoryMessages;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
}

export type ContextCompactionResult =
  | CompletedContextCompaction
  | FilteredContextReplacement
  | {
      readonly status: 'unchanged';
      readonly reason: 'nothing-to-compact';
    };

export interface ContextCompactionHooks {
  /** Called when the trigger matches and the required one-shot policy starts. */
  readonly onStarted: () => void | Promise<void>;
  /** One bounded observation for each Provider checkpoint request that actually runs. */
  readonly onCheckpointAttemptSettled?: (metadata: CheckpointAttemptMetadata) => void;
  /** Safe terminal generation metadata; checkpoint prose and thinking are never exposed. */
  readonly onCheckpointGenerated?: (metadata: CheckpointGenerationMetadata) => void;
  /** Every physical Provider request in this compact invocation. */
  readonly onProviderRequestSettled?: (event: LLMRequestSettledEvent) => void;
  /** Returns the invocation-wide Provider usage snapshot, if a request ran. */
  readonly getProviderTokenUsage?: () => CompactionTokenUsage | undefined;
}

export type AutomaticContextCompactionInput = Readonly<
  Pick<
    PiBeforeLlmCallHookInput,
    | 'sessionId'
    | 'phase'
    | 'messages'
    | 'model'
    | 'streamFn'
    | 'apiKey'
    | 'headers'
    | 'maxTokens'
    | 'cacheRetention'
    | 'payloadTransform'
    | 'systemPrompt'
    | 'tools'
    | 'thinkingLevel'
    | 'signal'
  > & {
    readonly maxSerializedInputBytes?: number;
  }
>;

export interface AutomaticContextCompactionProbe {
  readonly shouldStart: boolean;
}

export interface AutomaticContextCompactor {
  /**
   * Synchronous trigger probe. A false result lets the Host
   * avoid detaching a history that will be returned to the Provider unchanged.
   * Implementations must use the same trigger semantics as compactBeforeLlm.
   */
  probeBeforeLlm?(input: AutomaticContextCompactionInput): AutomaticContextCompactionProbe;
  compactBeforeLlm(
    input: AutomaticContextCompactionInput,
    hooks?: ContextCompactionHooks,
  ): Promise<ContextCompactionResult>;
}

export interface ContextCompactor {
  compactManual(
    input: ManualContextCompactionInput,
    hooks?: ContextCompactionHooks,
  ): Promise<ContextCompactionResult>;
}

export interface ContextCompactionLifecycleMetadata {
  /** Opaque Host-owned identity for this compactor invocation. */
  readonly attemptId: string;
  readonly compactionId: string;
  readonly method: ContextCompactionMethod;
  readonly strategyVersion: string;
  readonly phase: ContextCompactionPhase;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly serializedBytesBefore: number;
  readonly serializedBytesAfter: number;
  /** Counted only after this metadata reaches durable History completion. */
  readonly hmidOverflowRecovered?: true;
  readonly contextUsage?: PostCompactionContextUsage;
  readonly tokenUsage?: CompactionTokenUsage;
}

export interface ContextCompactionLifecycle {
  completeCommittedHistory(input: {
    readonly context: AgentEventContext;
    readonly attemptId: string;
    readonly operationId: string;
    readonly committedRevision: string;
    readonly metadata: ContextCompactionLifecycleMetadata;
  }): Promise<void>;
  failCommittedHistory(input: {
    readonly context: AgentEventContext;
    /** Identifies the exact attempt being failed, even when metadata is invalid. */
    readonly attemptId: string;
    readonly error: unknown;
    readonly metadata?: ContextCompactionLifecycleMetadata;
  }): Promise<void>;
}

interface ContextCompactionObservationBase {
  readonly context: AgentEventContext;
  readonly attemptId: string;
}

export type ContextCompactionObservation = ContextCompactionObservationBase &
  (
    | {
        readonly status: 'started';
        readonly reason?: string;
      }
    | {
        readonly status: 'completed';
        readonly compactionId: string;
        readonly messagesBefore: number;
        readonly messagesAfter: number;
        readonly tokensBefore: number;
        readonly tokensAfter: number;
        readonly contextUsage?: PostCompactionContextUsage;
        readonly tokenUsage?: CompactionTokenUsage;
      }
    | {
        readonly status: 'unchanged';
        readonly reason?: string;
      }
    | {
        readonly status: 'aborted' | 'failed';
        readonly compactionId?: string;
        readonly reason?: string;
        readonly tokenUsage?: CompactionTokenUsage;
      }
  );

export interface ContextCompactionObserver {
  /**
   * Non-authoritative live fact. AgentHost supplies a detached, recursively
   * frozen snapshot and never awaits this callback when deciding the
   * compaction outcome.
   */
  observe(input: ContextCompactionObservation): void | Promise<void>;
}

export interface AgentHostCompactionControl {
  beginClose(lease: AcceptedCompactionLease): AgentHostCloseResult;
}
