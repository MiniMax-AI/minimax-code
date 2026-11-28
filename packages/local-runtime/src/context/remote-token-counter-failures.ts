import { createHash, scryptSync } from 'node:crypto';

import { MANAGED_PROVIDER_API_KEY_PLACEHOLDER } from '../runtime/model-resolver.js';
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
const MANAGED_ROTATING_AUTH_HEADERS = new Set(['authorization', 'token']);
const MANAGED_OAUTH_SCOPE_MARKER = '<managed-oauth>';

export interface RemoteTokenCounterFailureScope {
  /** Exact credential/header fingerprint for 4xx/501 configuration rejections. */
  readonly credential: string;
  /**
   * Normalizes managed-login OAuth bearer headers so periodic JWT refreshes do not
   * wipe out transient timeout / 5xx backoff on constrained uplinks, while keeping
   * 401/403 credential rejections scoped to the exact token.
   */
  readonly transient: string;
}

interface CredentialFailure {
  failures: number;
  /** Consecutive 400/422 answers; any other outcome resets it. */
  requestRejections: number;
  retryAfterMs: number;
  disabledReason?: string;
}

interface TransientFailure {
  failures: number;
  retryAfterMs: number;
}

/** Failure state belongs to the configured counter, independent of tool schemas. */
export class RemoteTokenCounterFailures {
  private readonly credentialStates = new Map<string, CredentialFailure>();
  private readonly transientStates = new Map<string, TransientFailure>();

  constructor(private readonly nowMs: () => number = Date.now) {}

  scope(
    ctx: RemoteTokenCountContext,
    adapterId: string,
    counterUrl = ctx.model.baseUrl,
  ): RemoteTokenCounterFailureScope {
    const normalizedHeaders = Object.entries(ctx.headers ?? {})
      .map(([key, value]): [string, string] => [key.toLowerCase(), value])
      .filter(([key]) => !REQUEST_CONTEXT_HEADERS.has(key))
      .sort(([left], [right]) => left.localeCompare(right));
    const credential = hashScope({
      adapterId,
      api: ctx.model.api,
      provider: ctx.model.provider,
      model: ctx.model.id,
      counterUrl,
      credential: credentialFingerprint(ctx.apiKey),
      headers: fingerprintHeaders(normalizedHeaders),
    });
    const isManagedOAuth =
      ctx.apiKey === MANAGED_PROVIDER_API_KEY_PLACEHOLDER &&
      normalizedHeaders.some(([key]) => MANAGED_ROTATING_AUTH_HEADERS.has(key));
    if (!isManagedOAuth) {
      return { credential, transient: credential };
    }
    const transient = hashScope({
      adapterId,
      api: ctx.model.api,
      provider: ctx.model.provider,
      model: ctx.model.id,
      counterUrl,
      credential: credentialFingerprint(ctx.apiKey),
      headers: fingerprintHeaders(
        normalizedHeaders.map(([key, value]): [string, string] =>
          MANAGED_ROTATING_AUTH_HEADERS.has(key) ? [key, MANAGED_OAUTH_SCOPE_MARKER] : [key, value],
        ),
      ),
    });
    return { credential, transient };
  }

  fallbackReason(scope: RemoteTokenCounterFailureScope): string | undefined {
    const credentialState = this.credentialStates.get(scope.credential);
    if (credentialState?.disabledReason) return credentialState.disabledReason;
    const now = this.nowMs();
    if (credentialState && now < credentialState.retryAfterMs) return 'counter_cooldown';
    const transientState = this.transientStates.get(scope.transient);
    return transientState && now < transientState.retryAfterMs ? 'counter_cooldown' : undefined;
  }

  succeeded(scope: RemoteTokenCounterFailureScope): void {
    // An older in-flight success must not reopen an explicitly rejected route.
    if (this.credentialStates.get(scope.credential)?.disabledReason) return;
    this.credentialStates.delete(scope.credential);
    this.transientStates.delete(scope.transient);
  }

  failed(scope: RemoteTokenCounterFailureScope, status?: number, retryAfter?: string | null): void {
    const previousCredential = this.credentialStates.get(scope.credential);
    if (previousCredential?.disabledReason) return;
    const requestRejections =
      status !== undefined && REQUEST_REJECTED_STATUSES.has(status)
        ? (previousCredential?.requestRejections ?? 0) + 1
        : 0;
    const disabledReason = rejectionReason(status, requestRejections);
    const now = this.nowMs();
    if (disabledReason || requestRejections > 0) {
      const failures = (previousCredential?.failures ?? 0) + 1;
      const backoffMs = Math.min(RETRY_DELAY_MS * 2 ** (failures - 1), MAX_RETRY_DELAY_MS);
      this.credentialStates.set(scope.credential, {
        failures,
        requestRejections,
        retryAfterMs: now + Math.max(backoffMs, retryDelay(retryAfter, now)),
        ...(disabledReason ? { disabledReason } : {}),
      });
      return;
    }
    // Non-400/422 outcomes reset consecutive validation-rejection counts.
    this.credentialStates.delete(scope.credential);
    // Transient failures never stop a configuration: a supported endpoint must
    // recover after an outage, so the delay is bounded instead.
    const previousTransient = this.transientStates.get(scope.transient);
    const failures = (previousTransient?.failures ?? 0) + 1;
    const backoffMs = Math.min(RETRY_DELAY_MS * 2 ** (failures - 1), MAX_RETRY_DELAY_MS);
    this.transientStates.set(scope.transient, {
      failures,
      retryAfterMs: now + Math.max(backoffMs, retryDelay(retryAfter, now)),
    });
  }
}

function hashScope(payload: Record<string, unknown>): string {
  // Hash credentials instead of retaining them in cache keys or logs. Model,
  // endpoint and credential edits get a fresh probe without restarting Runtime.
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
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

const SENSITIVE_AUTH_HEADERS = new Set(['authorization', 'token', 'x-api-key', 'x-goog-api-key', 'proxy-authorization']);

function credentialFingerprint(secret: string | undefined): string {
  if (!secret) return '';
  return scryptSync(secret, 'mcode-remote-token-counter', 16, { N: 1024 }).toString('hex');
}

function fingerprintHeaders(headers: ReadonlyArray<readonly [string, string]>): Array<[string, string]> {
  return headers.map(([key, value]): [string, string] =>
    SENSITIVE_AUTH_HEADERS.has(key) && value !== MANAGED_OAUTH_SCOPE_MARKER
      ? [key, credentialFingerprint(value)]
      : [key, value],
  );
}
