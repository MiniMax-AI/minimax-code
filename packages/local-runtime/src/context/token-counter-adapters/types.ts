import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, CacheRetention, Model, SimpleStreamOptions, Tool } from '@earendil-works/pi-ai';

export type RemoteTokenCounterKind = 'messages' | 'responses' | 'openai-chat-tokenizer';

export interface RemoteTokenCountContext {
  messages: AgentMessage[];
  model: Model<Api>;
  /**
   * Dev-only capture of the exact provider payload used by the generation
   * request. Protocol adapters may derive their count request from this body
   * instead of reconstructing the final stage from logical context.
   */
  exactProviderPayload?: unknown;
  apiKey?: string;
  headers?: Record<string, string>;
  systemPrompt?: string;
  tools?: Tool[];
  maxTokens?: number;
  cacheRetention?: CacheRetention;
  thinkingLevel?: SimpleStreamOptions['reasoning'] | 'off';
  /**
   * An already prepared, count-compatible final Messages payload. Request
   * preparation owns all side effects (including File API uploads); the
   * counter may only serialize this value and must never prepare it itself.
   */
  preparedPayload?: unknown;
  signal?: AbortSignal;
}

export interface RemoteTokenCountResult {
  tokens: number;
  /** 'remote' = provider-counted ground truth; 'estimate' = local BPE fallback. */
  source: 'remote' | 'estimate';
  /** Machine-readable reason when `source === 'estimate'`. */
  fallbackReason?: string;
  /**
   * @deprecated Remote success no longer runs a synchronous local BPE
   * comparison. Kept optional for callers compiled against the previous shape.
   */
  localEstimateTokens?: number;
  /** @deprecated See `localEstimateTokens`. */
  tokenDelta?: number;
  /** @deprecated See `localEstimateTokens`. */
  tokenDeltaRatio?: number;
  counterKind?: RemoteTokenCounterKind;
}

export interface RemoteTokenCounter {
  countContextTokens(ctx: RemoteTokenCountContext): Promise<RemoteTokenCountResult>;
}

export interface RemoteTokenCounterHttpRequest {
  url: string;
  body: unknown;
  headers: Record<string, string>;
  hasImages: boolean;
}

/**
 * Protocol adapters own only request/response shape. Transport, timeout,
 * negative caching, logging, and BPE fallback stay in HttpRemoteTokenCounter.
 */
export interface RemoteTokenCounterAdapter {
  readonly id: string;
  readonly counterKind: RemoteTokenCounterKind;
  matches(ctx: RemoteTokenCountContext): boolean;
  buildRequest(
    ctx: RemoteTokenCountContext,
  ): RemoteTokenCounterHttpRequest | undefined | Promise<RemoteTokenCounterHttpRequest | undefined>;
  parseTokens(payload: unknown): number | undefined;
}
