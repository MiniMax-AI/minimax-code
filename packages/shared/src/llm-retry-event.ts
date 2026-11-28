import type { LLMMetricErrorKind } from './llm-error-classifier.js';

export const SESSION_LLM_RETRY_EVENT_TYPE = 'session.llm_retry' as const;

export type SessionLLMRetryScope = 'agent' | 'compaction' | 'title' | 'archive-title';
export type SessionLLMRetryStatus = 'waiting' | 'recovered' | 'exhausted' | 'cancelled';
/** What a `waiting` retry waits for beyond its backoff; absent for an ordinary backoff. */
export type SessionLLMRetryWaitingFor = 'network';
/** Retry trigger reasons plus the bounded final-attempt reason on terminal events. */
export type SessionLLMRetryReason = LLMMetricErrorKind;

export interface SessionLLMRetryEventPayload {
  schemaVersion: 1;
  sessionId: string;
  turnId: string;
  callId: string;
  scope: SessionLLMRetryScope;
  status: SessionLLMRetryStatus;
  retryAttempt: number;
  maxRetries: number;
  requestAttempt: number;
  delayMs?: number;
  nextRetryAtMs?: number;
  /**
   * `network`: the device is offline. The retry does not count against
   * `maxRetries` and resumes once the network is back.
   */
  waitingFor?: SessionLLMRetryWaitingFor;
  error?: {
    reason: SessionLLMRetryReason;
    code?: number;
    message: string;
    /**
     * The user-configured custom provider (`custom_provider:<id>`) the call
     * went to. Absent for MiniMax routes, so clients only blame a third-party
     * provider when the Runtime says so.
     */
    providerId?: string;
  };
}
