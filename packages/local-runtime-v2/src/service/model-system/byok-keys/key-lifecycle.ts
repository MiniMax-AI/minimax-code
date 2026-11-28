import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEventStream } from '@earendil-works/pi-ai';
import type {
  LLMCallFailure,
  LLMCallLease,
  LLMCallLifecycle,
  LLMCallRetryDecision,
} from '@mavis/agent-core/pi-turn-runner';

import { settleInBackground } from '../../../infra/async/settle.js';
import {
  classifyGenericFailure,
  failureEvidence,
  type FailureEvidence,
  type GenericFailure,
} from './failure-rules.js';
import { parseByokErrorStatus } from '../resolution/byok-error-attribution.js';
import type { ApiKeyRestReason, ByokKeyPool } from './key-pool.js';

/** One enabled key of the provider, its value already resolved. */
export interface ByokCallKey {
  readonly id: string;
  readonly value: string;
}

const BYOK_API_KEYS_RESTING = 'BYOK_API_KEYS_RESTING';

/** Every enabled key of the provider is resting; `until` is when the first is back (Unix ms). @internal */
export class ByokApiKeysRestingError extends Error {
  override name = 'ByokApiKeysRestingError';
  readonly code = BYOK_API_KEYS_RESTING;

  constructor(
    readonly provider: string,
    readonly until: number | undefined,
  ) {
    const back = until !== undefined ? ` until ${new Date(until).toISOString()}` : '';
    super(`${BYOK_API_KEYS_RESTING}: every API key of "${provider}" is resting${back}`);
  }
}

const ERROR_KIND: Readonly<Record<ApiKeyRestReason, LLMCallRetryDecision['errorKind']>> = {
  auth: 'auth',
  rate: 'rate_limited',
  quota: 'usage_limit',
};

/**
 * Whether the failure is this key's, and why. Only the status itself moves the call: 401, a 403
 * that is not about the model, 429, 402 or a used-up allowance a 403/429/5xx names. 5xx, network,
 * timeouts, an oversized request and a model the vendor doesn't serve are the request's: every key
 * hits the same address, so another key would fail alike.
 */
function byokKeyFailure(
  generic: GenericFailure,
): { readonly reason: ApiKeyRestReason; readonly credit?: boolean } | undefined {
  const rule = KEY_FAILURES[generic.kind];
  return rule?.(generic.status);
}

const usedUp = (status: number | undefined): boolean =>
  status === 402 || status === 403 || status === 429 || (status ?? 0) >= 500;

const KEY_FAILURES: Partial<
  Record<GenericFailure['kind'], (status: number | undefined) => ReturnType<typeof byokKeyFailure>>
> = {
  credential: () => ({ reason: 'auth' }),
  restricted: () => ({ reason: 'auth' }),
  other: (status) => (status === 403 ? { reason: 'auth' } : undefined),
  'rate-limit': (status) => (status === 429 ? { reason: 'rate' } : undefined),
  quota: (status) => (usedUp(status) ? { reason: 'quota' } : undefined),
  credit: (status) => (usedUp(status) ? { reason: 'quota', credit: true } : undefined),
};

/**
 * BYOK streams wrap the vendor's error as `BYOK upstream error: {json}` before it reaches the
 * lease, which hides the status inside `errorDetail` ("401 Authentication Fails …"). Read the
 * vendor's own words so the status and the wording are judged, not the wrapper.
 */
function byokFailureEvidence(failure: LLMCallFailure): FailureEvidence {
  const evidence = failureEvidence(failure);
  if (evidence.status !== undefined) return evidence;
  const detail = parseByokErrorStatus(evidence.text)?.errorDetail;
  if (!detail) return evidence;
  const unwrapped = failureEvidence({ final: { errorMessage: detail } as AssistantMessage });
  return {
    ...unwrapped,
    ...(evidence.headers ? { headers: evidence.headers } : {}),
  };
}

/**
 * Multi-key lifecycle for an ordinary BYOK provider. The key is read on every physical request:
 * agent-core wraps the inner stream once per logical call and retries through that same wrapper,
 * so a switch decided in classifyFailure takes effect when the next attempt starts. Each attempt
 * sets its own `apiKey`; pi derives the auth header from it, so no header of the previous key
 * survives.
 */
export function createByokKeyLifecycle(input: {
  readonly pool: ByokKeyPool;
  readonly providerKey: string;
  /** For the resting error only. */
  readonly providerName: string;
  readonly keys: readonly ByokCallKey[];
}): LLMCallLifecycle {
  return {
    async open({ signal }) {
      // Every key resting: the one back soonest from a limit is asked once rather than failing
      // until its rest ends.
      const first =
        input.pool.pick(input.providerKey, input.keys) ??
        input.pool.probe(input.providerKey, input.keys);
      if (!first)
        throw new ByokApiKeysRestingError(
          input.providerName,
          input.pool.earliestBack(input.providerKey, input.keys),
        );
      return new ByokKeyLease(input, first, signal);
    },
  };
}

class ByokKeyLease implements LLMCallLease {
  private pending: ByokCallKey | undefined;

  constructor(
    private readonly input: Parameters<typeof createByokKeyLifecycle>[0],
    private current: ByokCallKey,
    readonly signal: AbortSignal,
  ) {}

  wrapAttempt(inner: StreamFn): StreamFn {
    return (async (model, context, options) => {
      if (this.pending) {
        this.current = this.pending;
        this.pending = undefined;
      } else this.current = this.freeKey() ?? this.current;
      const key = this.current;
      const stream = await inner(model, context, { ...options, apiKey: key.value });
      this.observe(key, stream);
      return stream;
    }) as StreamFn;
  }

  classifyFailure(failure: LLMCallFailure): LLMCallRetryDecision | undefined {
    const { pool, providerKey, keys } = this.input;
    const generic = classifyGenericFailure(byokFailureEvidence(failure), pool.now());
    const verdict = byokKeyFailure(generic);
    if (!verdict) return undefined;
    pool.restKey(providerKey, this.current.id, verdict.reason, {
      ...(generic.status ? { status: generic.status } : {}),
      ...(generic.retryAtMs ? { until: generic.retryAtMs } : {}),
    });
    // No other key to take the call: the last one is retried as a single key would be, by
    // agent-core's own rules (backoff, Retry-After, the retry budget), not ended at once. Keys
    // sharing one limit (an organization, a relay) all meet the same brief 429 together.
    const next = pool.pick(providerKey, keys);
    if (!next) return undefined;
    this.pending = next;
    const errorKind = verdict.credit ? 'credits_exhausted' : ERROR_KIND[verdict.reason];
    return { kind: 'retry', errorKind, retryAfterMs: 0 };
  }

  /** While retrying a resting key, a key that came back since takes the next attempt. */
  private freeKey(): ByokCallKey | undefined {
    const { pool, providerKey, keys } = this.input;
    return pool.resting(providerKey, this.current.id) ? pool.pick(providerKey, keys) : undefined;
  }

  async close(): Promise<void> {}

  /** A key that answered is no longer resting; never awaited, never rejects. */
  private observe(key: ByokCallKey, stream: AssistantMessageEventStream): void {
    settleInBackground(this.servedBy(key, stream));
  }

  private async servedBy(key: ByokCallKey, stream: AssistantMessageEventStream): Promise<void> {
    try {
      const final = await stream.result();
      if (final.stopReason !== 'error' && final.stopReason !== 'aborted')
        this.input.pool.served(this.input.providerKey, key.id);
    } catch {
      /* The call owns the failure. */
    }
  }
}
