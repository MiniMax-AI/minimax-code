/**
 * Auxiliary provider token counter for Context Usage and review budgeting.
 *
 * Counts should match the provider-bound payload, including the
 * composed system prompt and active tool declarations. The provider token
 * counter endpoint is ground truth; failures fall back to the shared BPE
 * estimate so a transient network/provider issue does not block the user turn.
 *
 * Result contract
 * ---------------
 * `countContextTokens` never throws. It returns a source-tagged result so the
 * caller can tell ground truth from an estimate: `source: 'remote'` is the
 * provider-reported `input_tokens`; `source: 'estimate'` is the shared BPE
 * estimate of the same logical context (the caller may floor it with its own
 * usage-based estimate).
 *
 * Messages-compatible models use `/v1/messages/count_tokens`. BYOK
 * OpenAI-compatible models use a source-specific tokenizer when the provider
 * exposes one, otherwise `/v1/responses/input_tokens`, while generation stays
 * on `/chat/completions` when that is the configured API format. A counter URL
 * that rejects counting is skipped for the current model/endpoint/credentials.
 * Transient failures receive bounded backoff; all fallbacks stay local.
 */

import { estimateMessagesTokens, estimateSystemPromptAndToolTokens } from './token-estimator.js';
import {
  RemoteTokenCounterFailures,
  type RemoteTokenCounterFailureScope,
} from './remote-token-counter-failures.js';
import {
  DEFAULT_REMOTE_TOKEN_COUNTER_ADAPTERS,
  resolveRemoteTokenCounterAdapter,
} from './token-counter-adapters/registry.js';
import type {
  RemoteTokenCountContext,
  RemoteTokenCountResult,
  RemoteTokenCounter,
  RemoteTokenCounterAdapter,
  RemoteTokenCounterHttpRequest,
} from './token-counter-adapters/types.js';

import { logger } from '../common/logger.js';

export { buildResponsesInputTokensUrl } from './token-counter-adapters/responses.js';
export type {
  RemoteTokenCountContext,
  RemoteTokenCountResult,
  RemoteTokenCounter,
} from './token-counter-adapters/types.js';

const DEFAULT_TIMEOUT_MS = 3_000;
const BODY_PREVIEW_LIMIT = 500;

export interface HttpRemoteTokenCounterOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
  /** Internal/test seam; production callers use the static default registry. */
  adapters?: readonly RemoteTokenCounterAdapter[];
}

interface ResolvedCounterRequest extends RemoteTokenCounterHttpRequest {
  adapter: RemoteTokenCounterAdapter;
}

export class HttpRemoteTokenCounter implements RemoteTokenCounter {
  private readonly timeoutMs: number;
  private readonly customFetchFn: typeof fetch | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly adapters: readonly RemoteTokenCounterAdapter[];
  private readonly failures: RemoteTokenCounterFailures;
  private readonly resolvedFailureScopes = new Map<string, RemoteTokenCounterFailureScope>();

  constructor(opts: HttpRemoteTokenCounterOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.customFetchFn = opts.fetchFn;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.adapters = opts.adapters ?? DEFAULT_REMOTE_TOKEN_COUNTER_ADAPTERS;
    this.failures = new RemoteTokenCounterFailures(opts.nowMs);
  }

  async countContextTokens(ctx: RemoteTokenCountContext): Promise<RemoteTokenCountResult> {
    const estimate = (fallbackReason: string): RemoteTokenCountResult =>
      estimateContextTokens(ctx, fallbackReason);
    if (!ctx.apiKey || !ctx.model.baseUrl) return estimate('counter_unavailable');

    const adapter = resolveRemoteTokenCounterAdapter(ctx, this.adapters);
    if (!adapter) return estimate('counter_unavailable');
    if (shouldSkipRemoteCounting(ctx, adapter)) return estimate('inline_media_unprepared');

    const scope = this.failures.scope(ctx, adapter.id);
    const fallbackReason = this.failures.fallbackReason(
      this.resolvedFailureScopes.get(scope.credential) ?? scope,
    );
    if (fallbackReason) return estimate(fallbackReason);
    return this.countRemote({ ctx, adapter, estimate, scope });
  }

  private async countRemote(input: {
    ctx: RemoteTokenCountContext;
    adapter: RemoteTokenCounterAdapter;
    estimate: (fallbackReason: string) => RemoteTokenCountResult;
    scope: RemoteTokenCounterFailureScope;
  }): Promise<RemoteTokenCountResult> {
    const { ctx, adapter, estimate } = input;
    let { scope } = input;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, controller.signal])
      : controller.signal;
    let request: ResolvedCounterRequest | undefined;
    try {
      const builtRequest = await awaitWithSignal(
        Promise.resolve(adapter.buildRequest(ctx)),
        signal,
      );
      if (!builtRequest) return estimate('counter_unavailable');
      request = { ...builtRequest, adapter };
      scope = this.failures.scope(ctx, adapter.id, request.url);
      this.resolvedFailureScopes.set(input.scope.credential, scope);
      const fallbackReason = this.failures.fallbackReason(scope);
      if (fallbackReason) return estimate(fallbackReason);
      const effectiveFetch = this.customFetchFn ?? ctx.fetchFn ?? this.fetchFn;
      const response = await effectiveFetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal,
      });
      const result = await parseRemoteResponse({
        response,
        request,
        estimate,
      });
      if (!ctx.signal?.aborted) this.recordResponse(scope, result, response);
      return result;
    } catch (err) {
      if (!ctx.signal?.aborted) this.failures.failed(scope);
      logRemoteRequestFailure(ctx, request, err);
      return estimate(request ? 'request_failed' : 'request_build_failed');
    } finally {
      clearTimeout(timer);
    }
  }

  private recordResponse(
    scope: RemoteTokenCounterFailureScope,
    result: RemoteTokenCountResult,
    response: Response,
  ): void {
    if (result.source === 'remote') {
      this.failures.succeeded(scope);
    } else {
      this.failures.failed(scope, response.status, response.headers.get('retry-after'));
    }
  }
}

function estimateContextTokens(
  ctx: RemoteTokenCountContext,
  fallbackReason: string,
): RemoteTokenCountResult {
  try {
    return {
      tokens:
        estimateMessagesTokens(ctx.messages) +
        estimateSystemPromptAndToolTokens(ctx.systemPrompt, ctx.tools),
      source: 'estimate',
      fallbackReason,
    };
  } catch (err) {
    logger.warn(
      {
        model: ctx.model.id,
        api: ctx.model.api,
        provider: ctx.model.provider,
        error: err instanceof Error ? err.message : String(err),
      },
      '[local-remote-token-counter] BPE fallback failed; returning zero estimate',
    );
    return { tokens: 0, source: 'estimate', fallbackReason };
  }
}

function shouldSkipRemoteCounting(
  ctx: RemoteTokenCountContext,
  adapter: RemoteTokenCounterAdapter,
): boolean {
  const hasPreparedProviderPayload =
    ctx.preparedPayload !== undefined || ctx.exactProviderPayload !== undefined;
  return (
    adapter.id === 'anthropic-messages' &&
    !hasPreparedProviderPayload &&
    contextMayContainInlineMedia(ctx)
  );
}

async function parseRemoteResponse(input: {
  response: Response;
  request: ResolvedCounterRequest;
  estimate: (fallbackReason: string) => RemoteTokenCountResult;
}): Promise<RemoteTokenCountResult> {
  const { response, request, estimate } = input;
  if (!response.ok) {
    logNonSuccessfulResponse(response, request);
    return estimate(`http_${response.status}`);
  }
  const json = (await response.json()) as unknown;
  const tokens = request.adapter.parseTokens(json);
  if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens > 0) {
    // The positive signal: without it, "the gateway can count" is only inferable
    // from the absence of a warn.
    logger.info(
      {
        url: request.url,
        counterKind: request.adapter.counterKind,
        adapter_id: request.adapter.id,
        tokens,
      },
      '[local-remote-token-counter] remote count succeeded',
    );
    return { tokens, source: 'remote', counterKind: request.adapter.counterKind };
  }
  logger.warn(
    {
      url: request.url,
      kind: request.adapter.counterKind,
      adapter_id: request.adapter.id,
      body_preview: buildSafeJsonPreview(json),
    },
    '[local-remote-token-counter] malformed body; using BPE fallback',
  );
  return estimate('malformed_body');
}

function logNonSuccessfulResponse(response: Response, request: ResolvedCounterRequest): void {
  const missingEndpoint =
    response.status === 404 || response.status === 405 || response.status === 501;
  logger.warn(
    {
      url: request.url,
      status: response.status,
      kind: request.adapter.counterKind,
      adapter_id: request.adapter.id,
    },
    missingEndpoint
      ? '[local-remote-token-counter] token counter endpoint missing; disabling remote counting for this base url'
      : '[local-remote-token-counter] non-2xx; using BPE fallback',
  );
}

function logRemoteRequestFailure(
  ctx: RemoteTokenCountContext,
  request: ResolvedCounterRequest | undefined,
  error: unknown,
): void {
  logger.warn(
    request
      ? {
          url: request.url,
          kind: request.adapter.counterKind,
          adapter_id: request.adapter.id,
          error: error instanceof Error ? error.message : String(error),
        }
      : {
          model: ctx.model.id,
          api: ctx.model.api,
          provider: ctx.model.provider,
          error: error instanceof Error ? error.message : String(error),
        },
    request
      ? '[local-remote-token-counter] request failed/timed out; using BPE fallback'
      : '[local-remote-token-counter] request build failed/timed out; using BPE fallback',
  );
}

function contextMayContainInlineMedia(ctx: RemoteTokenCountContext): boolean {
  if (!ctx.model.input.includes('image')) return false;
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(visit);
    const record = value as Record<string, unknown>;
    return (
      record.type === 'image' ||
      record.type === 'video' ||
      (Array.isArray(record.content) && record.content.some(visit))
    );
  };
  return ctx.messages.some(visit);
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // The signal only bounds our wait; it cannot cancel a promise unless that
  // promise receives and honors a signal. Adapter construction is therefore
  // required to stay pure and must never upload or perform other side effects.
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
  let abortRequest: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortRequest = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', abortRequest, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (abortRequest) signal.removeEventListener('abort', abortRequest);
  }
}

function buildSafeJsonPreview(value: unknown): string {
  const redact = (input: unknown, depth: number): unknown => {
    if (depth > 4) return '[max-depth]';
    if (input === null || typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input === 'string') return `[string:${input.length}]`;
    if (Array.isArray(input)) return input.slice(0, 10).map((item) => redact(item, depth + 1));
    if (typeof input !== 'object') return `[${typeof input}]`;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, child]) => [key, redact(child, depth + 1)]),
    );
  };

  try {
    return JSON.stringify(redact(value, 0)).slice(0, BODY_PREVIEW_LIMIT);
  } catch {
    return '[unserializable]';
  }
}
