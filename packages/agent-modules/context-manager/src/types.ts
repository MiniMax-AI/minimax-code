import type {
  AgentMessage,
  CompactionSummaryMessage,
  StreamFn,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { Api, Model, Tool } from '@earendil-works/pi-ai';

export interface ContextCompactionSummaryMessage extends CompactionSummaryMessage {
  /**
   * Number of following messages retained from the old context, whose usage is stale.
   * Persist this with the summary so a restored transcript has the same usage boundary.
   * Absent on legacy summaries, which must use timestamp-based freshness instead.
   */
  keptMessageCount?: number;
}

export interface ContextManagerSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  minMessagesToCompact: number;
  contextWindowFallback: number;
  safetyMarginTokens: number;
  strategyVersion: string;
}

export interface ContextTokenCount {
  tokens: number;
  source: 'remote_count_tokens' | 'local_estimate' | string;
}

export interface ContextTokenCounter {
  countContextTokens(input: {
    messages: AgentMessage[];
    model: Model<Api>;
    apiKey?: string;
    headers?: Record<string, string>;
    systemPrompt?: string;
    tools?: Tool[];
    streamFn?: StreamFn;
    thinkingLevel: ThinkingLevel;
    signal?: AbortSignal;
  }): Promise<ContextTokenCount>;
}

export interface ContextSummaryGenerator {
  generateSummary(input: {
    messages: AgentMessage[];
    previousSummary?: string;
    model: Model<Api>;
    apiKey?: string;
    streamFn?: StreamFn;
    thinkingLevel: ThinkingLevel;
    reserveTokens: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface ContextManagerLock {
  withSessionLock<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
}

export interface ContextCompactionPlan {
  previousSummary?: string;
  compactedMessages: AgentMessage[];
  keptMessages: AgentMessage[];
  firstKeptIndex: number;
  boundaryStartIndex: number;
  tokensBefore: number;
}

export type ContextCompactionDecision =
  | { type: 'continue' }
  | { type: 'skip'; reason: string }
  | { type: 'abort'; reason: string }
  | {
      type: 'replaceMessages';
      messages: AgentMessage[];
      metadata: {
        replacementId: string;
        strategyVersion: string;
        summary: string;
        compactedMessages: AgentMessage[];
        keptMessages: AgentMessage[];
        firstKeptIndex: number;
        tokensBefore?: number;
        tokensAfter?: number;
        messagesBefore?: number;
        messagesAfter?: number;
      };
    };

export interface ContextTriggerEvaluatedEvent {
  sessionId: string;
  turnId: string;
  phase: string;
  source: string;
  tokens: number;
  triggerAt: number;
  shouldCompact: boolean;
}

export interface ContextCompactionSkippedEvent {
  sessionId: string;
  turnId: string;
  phase: string;
  reason: string;
}

export interface ContextCompactionCommittedEvent {
  sessionId: string;
  turnId: string;
  phase: string;
  replacementId: string;
  tokensBefore?: number;
  tokensAfter?: number;
  messagesBefore: number;
  messagesAfter: number;
}

export interface ContextCompactionFailedEvent {
  sessionId: string;
  turnId: string;
  phase: string;
  reason: string;
}

export interface ContextManagerObserver {
  onTriggerEvaluated?(event: ContextTriggerEvaluatedEvent): void | Promise<void>;
  onCompactionSkipped?(event: ContextCompactionSkippedEvent): void | Promise<void>;
  onCompactionCommitted?(event: ContextCompactionCommittedEvent): void | Promise<void>;
  onCompactionFailed?(event: ContextCompactionFailedEvent): void | Promise<void>;
}

export interface ContextManagerOptions {
  settings?: Partial<ContextManagerSettings>;
  tokenCounter?: ContextTokenCounter;
  summaryGenerator?: ContextSummaryGenerator;
  lock?: ContextManagerLock;
  observer?: ContextManagerObserver;
  nowMs?: () => number;
  idGenerator?: () => string;
}

export interface ContextManagerCheckpointOptions {
  /** Called only after compaction is required and a safe plan exists. False defers this attempt. */
  beforeCompaction?: () => boolean | Promise<boolean>;
}
