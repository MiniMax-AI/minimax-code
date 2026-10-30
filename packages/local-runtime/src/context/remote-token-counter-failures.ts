import { createHash } from 'node:crypto';

import type { RemoteTokenCountContext } from './token-counter-adapters/types.js';

const RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 30 * 60_000;
/** A missing endpoint is conclusive after one answer. */
const UNSUPPORTED_STATUSES = new Set([404, 405, 501]);
/** Credential and account rejections do not depend on the request body. */
const CONFIGURATION_REJECTED_STATUSES = new Set([401, 402, 403, 410]);
/**
 * Validation errors may belong to one request body (for example one tool
 * schema), so only a repeated rejection stops this configuration.
 */
const REQUEST_REJECTED_STATUSES = new Set([400, 422]);
const REQUEST_REJECTIONS_BEFORE_STOP = 2;
const REQUEST_CONTEXT_HEADERS = new Set([
  'x-mavis-session-id',
  'x-mavis-agent-id',
  'x-mavis-timezone-offset',
  'x-opencode-session',
  'x-request-id',
  'traceparent',
  'tracestate',
]);

interface CounterFailure {
  failures: number;
  /** Consecutive 400/422 answers; any other outcome resets it. */
  requestRejections: number;
  retryAfterMs: number;
  disabledReason?: string;
}

/** Failure state belongs to the configured counter, independent of tool schemas. */
export class RemoteTokenCounterFailures {
  private readonly states = new Map<string, CounterFailure>();

  constructor(private readonly nowMs: () => number = Date.now) {}

  scope(ctx: RemoteTokenCountContext, adapterId: string, counterUrl = ctx.model.baseUrl): string {
    // Hash credentials instead of retaining them in cache keys or logs. Model,
    // endpoint and credential edits get a fresh probe without restarting Runtime.
    return createHash('sha256')
      .update(
        JSON.stringify({
          adapterId,
          api: ctx.model.api,
          provider: ctx.model.provider,
          model: ctx.model.id,
          counterUrl,
          apiKey: ctx.apiKey,
          headers: Object.entries(ctx.headers ?? {})
            .map(([key, value]): [string, string] => [key.toLowerCase(), value])
            .filter(([key]) => !REQUEST_CONTEXT_HEADERS.has(key))
            .sort(([left], [right]) => left.localeCompare(right)),
        }),
      )
      .digest('hex');
  }

  fallbackReason(scope: string): string | undefined {
    const state = this.states.get(scope);
    if (!state) return undefined;
    if (state.disabledReason) return state.disabledReason;
    return this.nowMs() < state.retryAfterMs ? 'counter_cooldown' : undefined;
  }

  succeeded(scope: string): void {
    // An older in-flight success must not reopen an explicitly rejected route.
    if (!this.states.get(scope)?.disabledReason) this.states.delete(scope);
  }

  failed(scope: string, status?: number, retryAfter?: string | null): void {
    const previous = this.states.get(scope);
    if (previous?.disabledReason) return;
    const failures = (previous?.failures ?? 0) + 1;
    const requestRejections =
      status !== undefined && REQUEST_REJECTED_STATUSES.has(status)
        ? (previous?.requestRejections ?? 0) + 1
        : 0;
    const disabledReason = rejectionReason(status, requestRejections);
    const now = this.nowMs();
    // Transient failures never stop a configuration: a supported endpoint must
    // recover after an outage, so the delay is bounded instead.
    const backoffMs = Math.min(RETRY_DELAY_MS * 2 ** (failures - 1), MAX_RETRY_DELAY_MS);
    this.states.set(scope, {
      failures,
      requestRejections,
      retryAfterMs: now + Math.max(backoffMs, retryDelay(retryAfter, now)),
      ...(disabledReason ? { disabledReason } : {}),
    });
  }
}

function rejectionReason(
  status: number | undefined,
  requestRejections: number,
): string | undefined {
  if (status === undefined) return undefined;
  if (UNSUPPORTED_STATUSES.has(status)) return 'endpoint_unsupported';
  // A rejected request does not prove that the endpoint is absent. Stop probes
  // for this configuration, while allowing a different model/key/route to work.
  if (CONFIGURATION_REJECTED_STATUSES.has(status)) return 'counter_rejected';
  return requestRejections >= REQUEST_REJECTIONS_BEFORE_STOP ? 'counter_rejected' : undefined;
}

function retryDelay(value: string | null | undefined, now: number): number {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}
