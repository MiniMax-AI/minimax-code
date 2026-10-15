// Minimal-completion connection tester for BYOK providers. Sends a single
// ping with the model's configured output limit (Google uses Pi streaming) and normalizes
// the outcome to `unauthorized` / `timeout` / `network` / `http_<status>` /
// `provider_error` / `invalid_response`. Structured upstream failures retain
// their reason after removing configured secrets and common credential shapes.

import { completeSimple, type ThinkingLevel } from '@earendil-works/pi-ai';
import { withOpenCodeGoHeaders } from '@mavis/shared';

import { buildProviderHeaders, providerCompletionUrl } from './provider-request.js';
import {
  isThinkingEffortDisabled,
  resolveMiniMaxM3ThinkingProtocol,
  resolveModelThinkingProtocol,
} from '../resolution/model-ref.js';
import { byokEffectiveOutputLimit } from '../resolution/model-resolver-byok.js';
import type {
  ModelConnectionTestResult,
  ModelConnectionTestTarget,
  ModelProviderTestApi,
} from '../contracts.js';

export interface ModelConnectionTesterOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_ERROR_CHARS = 1_200;

export class ModelConnectionTester {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;
  private readonly inFlight = new Map<string, Promise<ModelConnectionTestResult>>();

  constructor(options: ModelConnectionTesterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs;
  }

  // One in-flight test per dedup key (provider or provider/model): concurrent
  // callers share the same pending promise instead of firing duplicates.
  test(dedupKey: string, target: ModelConnectionTestTarget): Promise<ModelConnectionTestResult> {
    const pending = this.inFlight.get(dedupKey);
    if (pending) return pending;
    const run = this.runAndRelease(dedupKey, target);
    this.inFlight.set(dedupKey, run);
    return run;
  }

  private async runAndRelease(
    dedupKey: string,
    target: ModelConnectionTestTarget,
  ): Promise<ModelConnectionTestResult> {
    try {
      return await this.runTest(target);
    } finally {
      this.inFlight.delete(dedupKey);
    }
  }

  private async runTest(target: ModelConnectionTestTarget): Promise<ModelConnectionTestResult> {
    const timeoutMs =
      this.timeoutMs ?? (target.api === 'google-generative-ai' ? 30_000 : DEFAULT_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (target.api === 'google-generative-ai') return await testGoogle(target, controller.signal);
      const { url, init } = buildTestRequest(target);
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      if (response.ok) return await validateSuccessResponse(response, target.api, target);
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          errorCode: 'unauthorized',
          errorMessage: `Authentication failed (HTTP ${response.status})`,
        };
      }
      const upstreamReason = await readUpstreamErrorReason(response, target);
      return {
        ok: false,
        errorCode: `http_${response.status}`,
        errorMessage: `HTTP ${response.status}${upstreamReason ? `: ${upstreamReason}` : ''}`,
      };
    } catch (err) {
      if (isAbortError(err)) {
        return {
          ok: false,
          errorCode: 'timeout',
          errorMessage: `Request timed out after ${timeoutMs}ms`,
        };
      }
      return { ok: false, errorCode: 'network', errorMessage: 'Network error' };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function testGoogle(
  target: ModelConnectionTestTarget,
  signal: AbortSignal,
): Promise<ModelConnectionTestResult> {
  const reasoning = isThinkingEffortDisabled(target.effort)
    ? undefined
    : (target.effort as ThinkingLevel | undefined);
  const result = await completeSimple(
    {
      id: target.modelId,
      name: target.modelId,
      provider: 'google',
      api: 'google-generative-ai',
      baseUrl: target.baseUrl,
      reasoning: Boolean(reasoning),
      input: ['text'],
      contextWindow: 200_000,
      maxTokens: resolveTestOutputLimit(target),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] },
    {
      apiKey: target.apiKey,
      maxTokens: resolveTestOutputLimit(target),
      signal,
      reasoning,
      headers: withOpenCodeGoHeaders(target.baseUrl, target.headers),
    },
  );
  signal.throwIfAborted();
  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    return {
      ok: false,
      errorCode: 'provider_error',
      errorMessage: redactConnectionTestError(
        result.errorMessage ?? 'Model provider error',
        target,
      ),
    };
  }
  return result.content.length > 0
    ? { ok: true }
    : {
        ok: false,
        errorCode: 'invalid_response',
        errorMessage: 'Invalid response from model provider',
      };
}

async function readUpstreamErrorReason(
  response: Response,
  target: ModelConnectionTestTarget,
): Promise<string | undefined> {
  const raw = (await response.text()).trim();
  if (!raw || raw.startsWith('<')) return undefined;

  let detail: string | undefined;
  try {
    detail = extractStructuredErrorReason(JSON.parse(raw));
  } catch {
    detail = raw;
  }
  if (!detail) return undefined;
  return redactConnectionTestError(detail, target);
}

function extractStructuredErrorReason(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  const record = readRecord(value);
  const explicitProviderError = extractExplicitProviderErrorReason(record);
  if (explicitProviderError) return explicitProviderError;
  for (const candidate of [record.message, record.detail, record.error_description]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function extractExplicitProviderErrorReason(record: Record<string, unknown>): string | undefined {
  return providerErrorReason(record.error) ?? baseResponseErrorReason(record.base_resp);
}

function providerErrorReason(error: unknown): string | undefined {
  if (typeof error === 'string' && error.trim()) return error.trim();
  const errorRecord = readRecord(error);
  return firstNonEmptyString([errorRecord.message, errorRecord.detail, errorRecord.type]);
}

function baseResponseErrorReason(value: unknown): string | undefined {
  const baseResponse = readRecord(value);
  const statusCode = normalizeProviderStatusCode(baseResponse.status_code);
  if (!statusCode || statusCode === '0') return undefined;
  const message = firstNonEmptyString([
    baseResponse.status_msg,
    baseResponse.message,
    baseResponse.detail,
  ]);
  if (!message) return `Provider error (${statusCode})`;
  return message.includes(statusCode) ? message : `${message} (${statusCode})`;
}

function firstNonEmptyString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeProviderStatusCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

function redactConnectionTestError(
  value: string,
  target: ModelConnectionTestTarget,
): string | undefined {
  let message = value.replace(/\s+/gu, ' ').trim();
  const secrets = [target.apiKey, ...Object.values(target.headers ?? {})]
    .map((secret) => secret.trim())
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) message = message.split(secret).join('***');
  message = message
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/gu, 'sk-***')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"',}]+/giu, '$1***')
    .replace(/((?:api[_-]?key|x-api-key)\s*[:=]\s*)[^\s"',}]+/giu, '$1***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/giu, '$1***')
    .slice(0, MAX_UPSTREAM_ERROR_CHARS)
    .trim();
  return message || undefined;
}

/**
 * The probe never reads the reply, so the budget only has to clear the
 * provider's own validation floor. It sends the model's effective output
 * limit — the same value a real turn sends, default included — so whatever
 * the real request would be rejected for, the probe is rejected for.
 */
function resolveTestOutputLimit(target: ModelConnectionTestTarget): number {
  const configured = target.outputLimit;
  if (typeof configured !== 'number' || !Number.isSafeInteger(configured) || configured < 1) {
    // Callers resolve the model before probing, so this only covers a target
    // that never had one: probe with the default a real turn would send.
    return byokEffectiveOutputLimit(undefined);
  }
  return configured;
}

function buildTestRequest(target: ModelConnectionTestTarget): { url: string; init: RequestInit } {
  const messages = [{ role: 'user', content: 'ping' }];
  const thinking = resolveModelThinkingProtocol(target.api, target.effort, target.modelId);
  const requestPatch = target.minimaxM3ThinkingMode
    ? resolveMiniMaxM3ThinkingProtocol(target.api, target.minimaxM3ThinkingMode)
    : (thinking?.requestPatch ?? {});
  const maxTokens = resolveTestOutputLimit(target);
  if (target.api === 'anthropic-messages') {
    return {
      url: providerCompletionUrl(target.api, target.baseUrl),
      init: {
        method: 'POST',
        headers: buildProviderHeaders(target),
        body: JSON.stringify({
          model: target.modelId,
          max_tokens: maxTokens,
          stream: false,
          messages,
          ...requestPatch,
        }),
      },
    };
  }
  if (target.api === 'openai-responses') {
    return {
      url: providerCompletionUrl(target.api, target.baseUrl),
      init: {
        method: 'POST',
        headers: buildProviderHeaders(target),
        body: JSON.stringify({
          model: target.modelId,
          input: 'ping',
          max_output_tokens: maxTokens,
          stream: false,
          ...requestPatch,
        }),
      },
    };
  }
  return {
    url: providerCompletionUrl(target.api, target.baseUrl),
    init: {
      method: 'POST',
      headers: buildProviderHeaders(target),
      body: JSON.stringify({
        model: target.modelId,
        max_tokens: maxTokens,
        stream: false,
        messages,
        ...requestPatch,
      }),
    },
  };
}

async function validateSuccessResponse(
  response: Response,
  api: ModelProviderTestApi,
  target: ModelConnectionTestTarget,
): Promise<ModelConnectionTestResult> {
  const payload = await readJsonBody(response);
  const providerError = extractExplicitProviderErrorReason(readRecord(payload));
  if (providerError) {
    return {
      ok: false,
      errorCode: 'provider_error',
      errorMessage: redactConnectionTestError(providerError, target) ?? 'Model provider error',
    };
  }
  if (api === 'anthropic-messages' && isMessagesResponse(payload)) {
    return { ok: true };
  }
  if (api === 'openai-completions' && isOpenAiChatCompletionsResponse(payload)) {
    return { ok: true };
  }
  if (api === 'openai-responses' && isOpenAiResponsesResponse(payload)) {
    return { ok: true };
  }
  return {
    ok: false,
    errorCode: 'invalid_response',
    errorMessage: 'Invalid response from model provider',
  };
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (err) {
    if (isAbortError(err)) throw err;
    return undefined;
  }
}

function isMessagesResponse(payload: unknown): boolean {
  const data = readRecord(payload);
  return Array.isArray(data.content);
}

function isOpenAiChatCompletionsResponse(payload: unknown): boolean {
  const data = readRecord(payload);
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const first = readRecord(choices[0]);
  const message = readRecord(first.message);
  return typeof message.role === 'string';
}

function isOpenAiResponsesResponse(payload: unknown): boolean {
  const data = readRecord(payload);
  return data.object === 'response' && typeof data.id === 'string' && Array.isArray(data.output);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: unknown }).name === 'AbortError';
}
