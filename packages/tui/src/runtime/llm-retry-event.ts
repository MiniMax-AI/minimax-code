import { LLM_ERROR_REASONS } from '@mavis/shared/llm-error-classifier';
import type {
  SessionLLMRetryEventPayload,
  SessionLLMRetryReason,
  SessionLLMRetryScope,
  SessionLLMRetryStatus,
} from '@mavis/shared/llm-retry-event';

const SCOPES = new Set<SessionLLMRetryScope>(['agent', 'compaction', 'title']);
const STATUSES = new Set<SessionLLMRetryStatus>(['waiting', 'recovered', 'exhausted', 'cancelled']);
const REASONS = new Set<SessionLLMRetryReason>(LLM_ERROR_REASONS);

export function parseSessionLLMRetryEventPayload(raw: unknown): SessionLLMRetryEventPayload | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return null;
  if (!isNonEmptyString(raw.sessionId) || !isNonEmptyString(raw.turnId)) return null;
  if (!isNonEmptyString(raw.callId) || !SCOPES.has(raw.scope as SessionLLMRetryScope)) return null;
  if (!STATUSES.has(raw.status as SessionLLMRetryStatus)) return null;
  if (!isNonNegativeInteger(raw.retryAttempt) || !isNonNegativeInteger(raw.maxRetries)) return null;
  if (!isPositiveInteger(raw.requestAttempt)) return null;
  if (
    !isOptionalNonNegativeNumber(raw.delayMs) ||
    !isOptionalNonNegativeNumber(raw.nextRetryAtMs)
  ) {
    return null;
  }
  const error = parseError(raw.error);
  if (raw.error !== undefined && !error) return null;
  return {
    schemaVersion: 1,
    sessionId: raw.sessionId,
    turnId: raw.turnId,
    callId: raw.callId,
    scope: raw.scope as SessionLLMRetryScope,
    status: raw.status as SessionLLMRetryStatus,
    retryAttempt: raw.retryAttempt,
    maxRetries: raw.maxRetries,
    requestAttempt: raw.requestAttempt,
    ...(raw.delayMs !== undefined ? { delayMs: raw.delayMs } : {}),
    ...(raw.nextRetryAtMs !== undefined ? { nextRetryAtMs: raw.nextRetryAtMs } : {}),
    ...(raw.waitingFor === 'network' ? { waitingFor: 'network' as const } : {}),
    ...(error ? { error } : {}),
  };
}

function parseError(raw: unknown): SessionLLMRetryEventPayload['error'] | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !REASONS.has(raw.reason as SessionLLMRetryReason)) return undefined;
  if (!isNonEmptyString(raw.message)) return undefined;
  if (raw.code !== undefined && (typeof raw.code !== 'number' || !Number.isFinite(raw.code))) {
    return undefined;
  }
  return {
    reason: raw.reason as SessionLLMRetryReason,
    message: raw.message,
    ...(typeof raw.code === 'number' ? { code: raw.code } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isOptionalNonNegativeNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}
