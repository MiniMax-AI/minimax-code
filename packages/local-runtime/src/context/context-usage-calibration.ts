import { createHash, scryptSync } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';

import { MANAGED_PROVIDER_API_KEY_PLACEHOLDER } from '../runtime/model-resolver.js';
import type {
  RemoteTokenCountContext,
  RemoteTokenCountResult,
  RemoteTokenCounter,
} from './remote-token-counter.js';

const BASELINE_MESSAGE: AgentMessage = {
  role: 'user',
  content: [{ type: 'text', text: '.' }],
  timestamp: 0,
};

const DEFAULT_RETRY_COOLDOWN_MS = 60_000;
const MAX_RETRY_COOLDOWN_MS = 30 * 60_000;
const MAX_TRACKED_FAILED_ENDPOINTS = 128;
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

export interface ContextUsageToolCalibration {
  fingerprint: string;
  status: 'REMOTE' | 'EMPTY' | 'UNAVAILABLE';
  tokens?: number;
}

export interface ContextUsageCalibrationCoordinatorOptions {
  nowMs?: () => number;
  retryCooldownMs?: number;
}

interface ToolCalibrationCacheEntry {
  result?: ContextUsageToolCalibration;
  pending?: Promise<ContextUsageToolCalibration>;
  scopeKey?: string;
  transient?: boolean;
  failures?: number;
  retryAfterMs?: number;
}

interface MarginalOutcome {
  readonly calibration: ContextUsageToolCalibration;
  readonly transient: boolean;
}

interface CalibrationCredentialScopes {
  readonly credential: string;
  readonly transient: string;
}

/**
 * Process-local Context Usage calibration state.
 *
 * It is intentionally not a domain store: no persistence, API, database row,
 * or UI identity is introduced. Tool marginals are reused only while the
 * provider/model/tool-definition fingerprint stays byte-identical.
 */
export class ContextUsageCalibrationCoordinator {
  private readonly nowMs: () => number;
  private readonly retryCooldownMs: number;
  private readonly toolCalibrations = new Map<string, ToolCalibrationCacheEntry>();
  private readonly withToolsFailedEndpoints = new Set<string>();

  constructor(
    readonly counter: RemoteTokenCounter,
    options: ContextUsageCalibrationCoordinatorOptions = {},
  ) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.retryCooldownMs = options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
  }

  async calibrateTools(input: {
    context: Context;
    model: Model<Api>;
    streamOptions?: SimpleStreamOptions;
    fetchFn?: typeof fetch;
  }): Promise<ContextUsageToolCalibration> {
    const tools = [...(input.context.tools ?? [])];
    const fingerprint = buildToolFingerprint(input.model, tools);
    if (tools.length === 0) {
      return { fingerprint, status: 'EMPTY', tokens: 0 };
    }

    const now = this.nowMs();
    const cached = this.toolCalibrations.get(fingerprint);
    if (cached?.result?.status === 'REMOTE') return cached.result;
    if (cached?.pending) return cached.pending;

    const scopes = buildCalibrationCredentialScopes(input.streamOptions);
    if (isCalibrationCoolingDown(cached, scopes, now)) {
      return { fingerprint, status: 'UNAVAILABLE' };
    }

    const previousFailures = readPreviousTransientFailures(cached, scopes);
    const pending = this.refreshToolCalibration({
      ...input,
      fingerprint,
      scopes,
      previousFailures,
    });
    this.toolCalibrations.set(
      fingerprint,
      buildPendingCalibrationEntry(pending, scopes, previousFailures),
    );
    return pending;
  }

  /**
   * Read a completed Tool calibration without starting a Provider request.
   * Manual compaction uses this to keep its immediate local-only Snapshot on
   * the same Tool scale as the preceding generated turn.
   */
  getCachedToolCalibration(input: {
    context: Context;
    model: Model<Api>;
  }): ContextUsageToolCalibration | undefined {
    const tools = [...(input.context.tools ?? [])];
    const fingerprint = buildToolFingerprint(input.model, tools);
    if (tools.length === 0) {
      return { fingerprint, status: 'EMPTY', tokens: 0 };
    }
    const result = this.toolCalibrations.get(fingerprint)?.result;
    return result?.status === 'REMOTE' ? result : undefined;
  }

  getToolFingerprint(input: { context: Context; model: Model<Api> }): string {
    return buildToolFingerprint(input.model, input.context.tools ?? []);
  }

  private async refreshToolCalibration(input: {
    context: Context;
    model: Model<Api>;
    streamOptions?: SimpleStreamOptions;
    fetchFn?: typeof fetch;
    fingerprint: string;
    scopes: CalibrationCredentialScopes;
    previousFailures: number;
  }): Promise<ContextUsageToolCalibration> {
    let outcome: MarginalOutcome;
    try {
      outcome = await this.countToolMarginal(input);
    } catch {
      outcome = {
        calibration: { fingerprint: input.fingerprint, status: 'UNAVAILABLE' },
        transient: true,
      };
    }
    this.toolCalibrations.set(
      input.fingerprint,
      buildCompletedCalibrationEntry({
        outcome,
        scopes: input.scopes,
        previousFailures: input.previousFailures,
        retryCooldownMs: this.retryCooldownMs,
        now: this.nowMs(),
      }),
    );
    return outcome.calibration;
  }

  private async countToolMarginal(input: {
    context: Context;
    model: Model<Api>;
    streamOptions?: SimpleStreamOptions;
    fetchFn?: typeof fetch;
    fingerprint: string;
  }): Promise<MarginalOutcome> {
    const endpointKey = buildModelEndpointKey(input.model);
    const base: RemoteTokenCountContext = {
      messages: [BASELINE_MESSAGE],
      model: input.model,
      ...(input.context.systemPrompt ? { systemPrompt: input.context.systemPrompt } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
      ...buildCalibrationStreamOptions(input.streamOptions),
    };
    const withToolsContext: RemoteTokenCountContext = {
      ...base,
      tools: [...(input.context.tools ?? [])],
    };
    const probed = this.withToolsFailedEndpoints.has(endpointKey)
      ? await this.probeWithToolsFirst(endpointKey, base, withToolsContext)
      : await this.probeWithoutToolsFirst(endpointKey, base, withToolsContext);
    if ('failureReason' in probed) {
      return {
        calibration: { fingerprint: input.fingerprint, status: 'UNAVAILABLE' },
        transient: isTransientFallbackReason(probed.failureReason),
      };
    }
    const tokens = probed.withTools.tokens - probed.withoutTools.tokens;
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      return {
        calibration: { fingerprint: input.fingerprint, status: 'UNAVAILABLE' },
        transient: true,
      };
    }
    return {
      calibration: { fingerprint: input.fingerprint, status: 'REMOTE', tokens },
      transient: false,
    };
  }

  private async probeWithoutToolsFirst(
    endpointKey: string,
    base: RemoteTokenCountContext,
    withToolsContext: RemoteTokenCountContext,
  ): Promise<
    | { withoutTools: RemoteTokenCountResult; withTools: RemoteTokenCountResult }
    | { failureReason: string | undefined }
  > {
    // Probe without tools first. An unavailable counter cannot calibrate the
    // marginal, so do not upload the much larger tool definitions in that case.
    const withoutTools = await this.counter.countContextTokens(base);
    if (withoutTools.source !== 'remote') return { failureReason: withoutTools.fallbackReason };
    const withTools = await this.counter.countContextTokens(withToolsContext);
    if (withTools.source !== 'remote') {
      this.rememberWithToolsFailure(endpointKey);
      return { failureReason: withTools.fallbackReason };
    }
    return { withoutTools, withTools };
  }

  private async probeWithToolsFirst(
    endpointKey: string,
    base: RemoteTokenCountContext,
    withToolsContext: RemoteTokenCountContext,
  ): Promise<
    | { withoutTools: RemoteTokenCountResult; withTools: RemoteTokenCountResult }
    | { failureReason: string | undefined }
  > {
    // A prior probe proved the endpoint exists (withoutTools succeeded) while the
    // larger withTools payload failed (e.g. slow uplink timeout). Probe withTools
    // first so a small withoutTools success cannot reset counter backoff before
    // withTools times out again.
    const withTools = await this.counter.countContextTokens(withToolsContext);
    if (withTools.source !== 'remote') return { failureReason: withTools.fallbackReason };
    this.withToolsFailedEndpoints.delete(endpointKey);
    const withoutTools = await this.counter.countContextTokens(base);
    if (withoutTools.source !== 'remote') return { failureReason: withoutTools.fallbackReason };
    return { withoutTools, withTools };
  }

  private rememberWithToolsFailure(endpointKey: string): void {
    if (this.withToolsFailedEndpoints.size >= MAX_TRACKED_FAILED_ENDPOINTS) {
      const oldest = this.withToolsFailedEndpoints.values().next().value;
      if (oldest !== undefined) this.withToolsFailedEndpoints.delete(oldest);
    }
    this.withToolsFailedEndpoints.add(endpointKey);
  }
}

function readPreviousTransientFailures(
  cached: ToolCalibrationCacheEntry | undefined,
  scopes: CalibrationCredentialScopes,
): number {
  return cached?.transient && cached.scopeKey === scopes.transient ? (cached.failures ?? 0) : 0;
}

function buildPendingCalibrationEntry(
  pending: Promise<ContextUsageToolCalibration>,
  scopes: CalibrationCredentialScopes,
  previousFailures: number,
): ToolCalibrationCacheEntry {
  if (previousFailures <= 0) return { pending };
  return { pending, scopeKey: scopes.transient, transient: true, failures: previousFailures };
}

function isCalibrationCoolingDown(
  cached: ToolCalibrationCacheEntry | undefined,
  scopes: CalibrationCredentialScopes,
  now: number,
): boolean {
  if (!cached || (cached.retryAfterMs ?? 0) <= now) return false;
  const activeScope = cached.transient ? scopes.transient : scopes.credential;
  return cached.scopeKey === activeScope;
}

function buildCompletedCalibrationEntry(input: {
  outcome: MarginalOutcome;
  scopes: CalibrationCredentialScopes;
  previousFailures: number;
  retryCooldownMs: number;
  now: number;
}): ToolCalibrationCacheEntry {
  const { outcome, scopes, previousFailures, retryCooldownMs, now } = input;
  if (outcome.calibration.status === 'REMOTE') {
    return { result: outcome.calibration };
  }
  if (!outcome.transient) {
    // Credential and configuration rejections keep the base cooldown scoped to
    // the exact credential, so replacing an API key or refreshing an expired
    // OAuth token recalibrates immediately instead of waiting up to 30 minutes.
    return {
      result: outcome.calibration,
      scopeKey: scopes.credential,
      transient: false,
      failures: 1,
      retryAfterMs: now + retryCooldownMs,
    };
  }
  const failures = previousFailures + 1;
  const maxCooldownMs = Math.max(retryCooldownMs, MAX_RETRY_COOLDOWN_MS);
  const backoffMs = Math.min(retryCooldownMs * 2 ** (failures - 1), maxCooldownMs);
  return {
    result: outcome.calibration,
    scopeKey: scopes.transient,
    transient: true,
    failures,
    retryAfterMs: now + backoffMs,
  };
}

function isTransientFallbackReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return (
    reason === 'request_failed' ||
    reason === 'request_build_failed' ||
    reason === 'counter_cooldown' ||
    reason === 'malformed_body' ||
    /^http_(?:408|429|5\d\d)$/u.test(reason)
  );
}

function buildCalibrationCredentialScopes(
  options: SimpleStreamOptions = {},
): CalibrationCredentialScopes {
  const normalizedHeaders = Object.entries(options.headers ?? {})
    .map(([key, value]): [string, string] => [key.toLowerCase(), value])
    .filter(([key]) => !REQUEST_CONTEXT_HEADERS.has(key))
    .sort(([left], [right]) => left.localeCompare(right));
  const credential = createHash('sha256')
    .update(safeJsonStringify({ credential: credentialFingerprint(options.apiKey), headers: fingerprintHeaders(normalizedHeaders) }))
    .digest('hex');
  const isManagedOAuth =
    options.apiKey === MANAGED_PROVIDER_API_KEY_PLACEHOLDER &&
    normalizedHeaders.some(([key]) => MANAGED_ROTATING_AUTH_HEADERS.has(key));
  if (!isManagedOAuth) {
    return { credential, transient: credential };
  }
  const transient = createHash('sha256')
    .update(
      safeJsonStringify({
        credential: credentialFingerprint(options.apiKey),
        headers: fingerprintHeaders(
          normalizedHeaders.map(([key, value]): [string, string] =>
            MANAGED_ROTATING_AUTH_HEADERS.has(key) ? [key, MANAGED_OAUTH_SCOPE_MARKER] : [key, value],
          ),
        ),
      }),
    )
    .digest('hex');
  return { credential, transient };
}

function buildCalibrationStreamOptions(options: SimpleStreamOptions = {}) {
  return {
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.cacheRetention ? { cacheRetention: options.cacheRetention } : {}),
    ...(options.reasoning ? { thinkingLevel: options.reasoning } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function buildModelEndpointKey(model: Model<Api>): string {
  return safeJsonStringify([model.provider, model.api, model.id, model.baseUrl]);
}

function buildToolFingerprint(model: Model<Api>, tools: Context['tools']): string {
  const serialized = safeJsonStringify({
    provider: model.provider,
    api: model.api,
    model: model.id,
    baseUrl: model.baseUrl,
    tools,
  });
  return createHash('sha256').update(serialized).digest('hex');
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
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
