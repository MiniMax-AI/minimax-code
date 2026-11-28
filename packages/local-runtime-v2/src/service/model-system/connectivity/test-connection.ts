// Minimal-completion connection tester for BYOK providers. Sends a single
// non-streaming ping with the model's configured output limit and normalizes
// the outcome to `unauthorized` / `timeout` / `network` / `http_<status>` /
// `provider_error` / `invalid_response`. Structured upstream failures retain
// their reason after removing configured secrets and common credential shapes.

import type { Model } from '@earendil-works/pi-ai';
import {
  type GoogleThinkingConfig,
  getSimpleGoogleThinkingConfig,
} from '@earendil-works/pi-ai/google';

import { logger } from '@mavis/shared/local-runtime-logging';

import { describeFetchFailure } from './fetch-failure.js';
import { buildProviderHeaders, providerCompletionUrl } from './provider-request.js';
import {
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

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_UPSTREAM_ERROR_CHARS = 1_200;
const MAX_GEMINI_PROBE_STREAM_CHARS = 256 * 1_024;

export class ModelConnectionTester {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly inFlight = new Map<string, Promise<ModelConnectionTestResult>>();

  constructor(options: ModelConnectionTesterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    const { url, init } = buildTestRequest(target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
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
          errorMessage: `Request timed out after ${this.timeoutMs}ms`,
        };
      }
      logger.warn(
        { event: 'model_provider_request_failed', op: 'test', ...describeFetchFailure(err, url) },
        'Model provider request failed',
      );
      return { ok: false, errorCode: 'network', errorMessage: 'Network error' };
    } finally {
      clearTimeout(timer);
    }
  }
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

export function redactConnectionTestError(
  value: string,
  target: Pick<ModelConnectionTestTarget, 'apiKey' | 'headers'>,
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
  const url = providerCompletionUrl(target.api, target.baseUrl, target.modelId);
  const headers = buildProviderHeaders(target);
  const maxTokens = resolveTestOutputLimit(target);
  if (target.api === 'google-generative-ai') {
    const thinkingConfig = geminiProbeThinkingConfig(target);
    return {
      url,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            ...(thinkingConfig && { thinkingConfig }),
          },
        }),
      },
    };
  }
  const messages = [{ role: 'user', content: 'ping' }];
  const thinking = resolveModelThinkingProtocol(target.api, target.effort, target.modelId);
  const requestPatch = target.minimaxM3ThinkingMode
    ? resolveMiniMaxM3ThinkingProtocol(target.api, target.minimaxM3ThinkingMode)
    : (thinking?.requestPatch ?? {});
  if (target.api === 'anthropic-messages') {
    return {
      url,
      init: {
        method: 'POST',
        headers,
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
      url,
      init: {
        method: 'POST',
        headers,
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
    url,
    init: {
      method: 'POST',
      headers,
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

/**
 * Gemini thinking is not a request patch: Pi's Google transport derives
 * `thinkingConfig` from the resolved model and level. Rebuild the same model
 * fields the resolver produces so the probe sends what a real turn sends.
 */
function geminiProbeThinkingConfig(
  target: ModelConnectionTestTarget,
): GoogleThinkingConfig | undefined {
  const thinking = resolveModelThinkingProtocol(target.api, target.effort, target.modelId);
  if (!thinking) return undefined;
  const enabled = thinking.enabled !== false;
  const model: Model<'google-generative-ai'> = {
    id: target.modelId,
    name: target.modelId,
    api: 'google-generative-ai',
    provider: 'byok-probe',
    baseUrl: target.baseUrl,
    reasoning: true,
    thinkingLevelMap: thinking.thinkingLevelMap,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: resolveTestOutputLimit(target),
  };
  const reasoning = enabled && thinking.piLevel !== 'off' ? thinking.piLevel : undefined;
  return getSimpleGoogleThinkingConfig(model, reasoning);
}

async function validateSuccessResponse(
  response: Response,
  api: ModelProviderTestApi,
  target: ModelConnectionTestTarget,
): Promise<ModelConnectionTestResult> {
  if (api === 'google-generative-ai') {
    return validateGeminiStreamResponse(response, target);
  }
  const payload = await readJsonBody(response);
  const providerError = extractExplicitProviderErrorReason(readRecord(payload));
  if (providerError) {
    return {
      ok: false,
      errorCode: 'provider_error',
      errorMessage: redactConnectionTestError(providerError, target) ?? 'Model provider error',
    };
  }
  if (SUCCESS_RESPONSE_SHAPES[api](payload)) {
    return { ok: true };
  }
  return invalidProviderResponse();
}

function invalidProviderResponse(): ModelConnectionTestResult {
  return {
    ok: false,
    errorCode: 'invalid_response',
    errorMessage: 'Invalid response from model provider',
  };
}

function inspectGeminiProbePayload(
  payload: unknown,
  target: ModelConnectionTestTarget,
): ModelConnectionTestResult | undefined {
  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items) {
    const providerError = extractExplicitProviderErrorReason(readRecord(item));
    if (providerError) {
      return {
        ok: false,
        errorCode: 'provider_error',
        errorMessage: redactConnectionTestError(providerError, target) ?? 'Model provider error',
      };
    }
    if (isGeminiGenerateContentResponse(item)) {
      return { ok: true };
    }
  }
  return undefined;
}

function inspectGeminiSseBlock(
  block: string,
  target: ModelConnectionTestTarget,
): { sawDataLine: boolean; verdict?: ModelConnectionTestResult } {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  if (dataLines.length === 0) return { sawDataLine: false };
  const joined = dataLines.join('\n').trim();
  if (!joined || joined === '[DONE]') return { sawDataLine: true };
  try {
    return {
      sawDataLine: true,
      verdict: inspectGeminiProbePayload(JSON.parse(joined), target),
    };
  } catch {
    return { sawDataLine: true };
  }
}

async function cancelStreamReaderQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Closing an already-settled or aborted stream is harmless.
  }
}

/**
 * Gemini probes `streamGenerateContent?alt=sse` — the same endpoint real turns
 * hit — and cancels the stream as soon as the first valid `candidates` event
 * arrives. Plain JSON responses from gateways that buffer or ignore `alt=sse`
 * are accepted as well.
 */
interface GeminiProbeStreamState {
  raw: string;
  pendingSse: string;
  sawSseDataLine: boolean;
}

function consumeGeminiProbeChunk(
  state: GeminiProbeStreamState,
  chunk: string,
  target: ModelConnectionTestTarget,
): ModelConnectionTestResult | undefined {
  state.raw += chunk;
  state.pendingSse += chunk;
  const blocks = state.pendingSse.split(/\r?\n\r?\n/u);
  state.pendingSse = blocks.pop() ?? '';
  for (const block of blocks) {
    const { sawDataLine, verdict } = inspectGeminiSseBlock(block, target);
    if (sawDataLine) state.sawSseDataLine = true;
    if (verdict) return verdict;
  }
  if (state.raw.length > MAX_GEMINI_PROBE_STREAM_CHARS) {
    return invalidProviderResponse();
  }
  return undefined;
}

function finalizeGeminiProbeBuffer(
  state: GeminiProbeStreamState,
  target: ModelConnectionTestTarget,
): ModelConnectionTestResult {
  if (state.pendingSse.trim()) {
    const { sawDataLine, verdict } = inspectGeminiSseBlock(state.pendingSse, target);
    if (sawDataLine) state.sawSseDataLine = true;
    if (verdict) return verdict;
  }
  if (!state.sawSseDataLine && state.raw.trim()) {
    try {
      return (
        inspectGeminiProbePayload(JSON.parse(state.raw.trim()), target) ?? invalidProviderResponse()
      );
    } catch {
      return invalidProviderResponse();
    }
  }
  return invalidProviderResponse();
}

async function readGeminiProbeStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  target: ModelConnectionTestTarget,
): Promise<ModelConnectionTestResult> {
  const decoder = new TextDecoder('utf-8');
  const state: GeminiProbeStreamState = { raw: '', pendingSse: '', sawSseDataLine: false };
  for (;;) {
    const { value, done } = await reader.read();
    const chunk = value ? decoder.decode(value, { stream: !done }) : decoder.decode();
    const verdict = chunk ? consumeGeminiProbeChunk(state, chunk, target) : undefined;
    if (verdict) {
      await cancelStreamReaderQuietly(reader);
      return verdict;
    }
    if (done) return finalizeGeminiProbeBuffer(state, target);
  }
}

async function validateGeminiStreamResponse(
  response: Response,
  target: ModelConnectionTestTarget,
): Promise<ModelConnectionTestResult> {
  if (!response.body) return invalidProviderResponse();
  const reader = response.body.getReader();
  try {
    return await readGeminiProbeStream(reader, target);
  } catch (err) {
    if (isAbortError(err)) throw err;
    return invalidProviderResponse();
  }
}

const SUCCESS_RESPONSE_SHAPES: Record<ModelProviderTestApi, (payload: unknown) => boolean> = {
  'anthropic-messages': isMessagesResponse,
  'openai-completions': isOpenAiChatCompletionsResponse,
  'openai-responses': isOpenAiResponsesResponse,
  'google-generative-ai': isGeminiGenerateContentResponse,
};

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

function isGeminiGenerateContentResponse(payload: unknown): boolean {
  return Array.isArray(readRecord(payload).candidates);
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
