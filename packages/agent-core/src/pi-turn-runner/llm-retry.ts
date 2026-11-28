import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  isContextOverflow,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type ProviderResponse,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  isLLMDeterministicRequestRejection,
  isLLMDeterministicStreamRefusal,
  isLLMRecoverableStreamInterruption,
  normalizeLLMError,
  toLLMMetricErrorKind,
  toLLMRetryDecision,
  type LLMFailureErrorKind,
  type LLMMetricErrorKind,
  type NormalizedLLMError,
} from '@mavis/shared/llm-error-classifier';
import { parseContentReviewError } from './content-review.js';

import { LLM_PARTIAL_STREAM_RESET, type AbandonedStreamAttempt } from '../protocol/stream-reset.js';

import {
  runWithLLMCallLifecycle,
  type LLMCallLifecycle,
  type LLMCallLease,
  type LLMCallRetryDecision,
} from './llm-call-lifecycle.js';
import {
  LLMReplyLoopGuard,
  llmReplyLoopMessage,
  type LLMReplyLoopTrip,
} from './llm-reply-loop-guard.js';
import { withLLMStreamFailure, type LLMStreamFailureKind } from './llm-stream-failure.js';
import {
  type RetryBudget,
  abortError,
  abortableSleep,
  asError,
  callSettledEvent,
  captureProviderError,
  classifyCallOutcome,
  commitsOutput,
  createRetryBudget,
  createSystemWakeLatch,
  defaultCallId,
  isDeviceOffline,
  isEmptyReply,
  isFailureMessage,
  failureRetryAfterMs,
  offlinePollPolicy,
  PUBLIC_ERROR_MESSAGES,
  publicRetryError,
  readProviderUsage,
  releaseIterator,
  replayStream,
  retryDelayMs,
  retryTimeout,
  signalAborted,
  sleepUntilResume,
  throwingReplayStream,
  refusalWaitFields,
} from './llm-retry-support.js';

function isByokProvider(provider: string): boolean {
  return provider === 'minimax_api' || provider.startsWith('custom_provider:');
}

/** `advisor`: the advisor tool's own request on behalf of an agent Turn, outside its step budget. */
export type LLMCallScope =
  | 'agent'
  | 'compaction'
  | 'title'
  | 'archive-title'
  | 'memory'
  | 'goal-evaluator'
  | 'miniapp-ideas'
  | 'handoff-recommendation'
  | 'handoff-summary'
  | 'probe'
  | 'advisor'
  /** A plugin extension's own text completion (`ctx.model.complete`). */
  | 'extension';
export type LLMRetryStatus = 'waiting' | 'recovered' | 'exhausted' | 'cancelled';
export type LLMCallOutcome = 'success' | 'error' | 'abort';
export type LLMCallErrorKind = LLMFailureErrorKind | 'none';

/** Symbol-keyed identity shared by physical attempts of one logical call. */
export const LLM_RETRY_CALL_IDENTITY: unique symbol = Symbol('mavis.llmRetryCallIdentity');

/** Required synchronous admission hook, called before each physical request; failures stop dispatch. */
export const LLM_RETRY_BEFORE_REQUEST: unique symbol = Symbol('mavis.llmRetryBeforeRequest');

/** Symbol-keyed observer for every physical provider request in a logical call. */
export const LLM_RETRY_REQUEST_SETTLED_OBSERVER: unique symbol = Symbol(
  'mavis.llmRetryRequestSettledObserver',
);

export interface LLMRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryElapsedMs: number;
}

/** A wait that overran its delay by more than this spanned a system sleep. */
export const SYSTEM_SLEEP_GAP_MS = 30_000;

/**
 * Whether a wait of `delayMs` that started at `sleptFromMs` spanned a system
 * sleep. Timers stand still while the system sleeps and the wall clock does
 * not, and an overdue timer fires on wake before any resume hint arrives, so
 * the overrun itself marks the wake: time asleep is not time waited.
 */
export function overranSystemSleep(sleptFromMs: number, nowMs: number, delayMs: number): boolean {
  return nowMs - sleptFromMs > delayMs + SYSTEM_SLEEP_GAP_MS;
}

/**
 * One backoff for every retryable failure, whatever its reason.
 *
 * Why one: the failures that reach a retry recover on the provider's clock,
 * not ours. A 429 is metered over a rolling minute, and a 529 overload or a
 * gateway 5xx typically lasts tens of seconds to minutes. A 1 s base spent a
 * whole budget in ~16 s (0.5/1/2/4/8 s at zero jitter), inside the very window
 * that had just refused the request, so the call gave up while the provider
 * was still refusing. A timeout already spent its own wait before failing, so
 * a few more seconds before its retry do not show; a device that is offline is
 * waited out by network recovery instead, outside this budget.
 *
 * Shape: equal-jitter exponential from a 5 s base, each wait capped at 30 s
 * (2.5–5, 5–10, 10–20 s, then 15–30 s), at most ten retries and at most 300 s
 * from the first failure, whichever comes first. Ten waits take ~122 s at zero
 * jitter and ~245 s at full jitter, so the elapsed window only cuts in when the
 * failing requests themselves are slow. `Retry-After` still wins over the
 * computed wait (`retryDelayMs`), and a refusal cool-down still sets a floor.
 */
export const DEFAULT_LLM_RETRY_POLICY: Readonly<LLMRetryPolicy> = {
  maxRetries: 10,
  baseDelayMs: 5_000,
  maxDelayMs: 30_000,
  maxRetryElapsedMs: 300_000,
};

/**
 * Safeguards on the reply stream of every physical attempt: empty-reply retries,
 * a reasoning hold and a loop guard (see THIRD_PARTY_NOTICES.md). They only add
 * failure branches before the retry commit boundary and a loop cut after it; a
 * reply that trips none streams exactly as before.
 */
export interface LLMReplyGuardPolicy {
  /**
   * A reply that ended `stop` with no text and no tool call (reasoning alone
   * says nothing) is retried this many times, through the host lease when there
   * is one, before it is handed over as it is. Only a reply nothing of which was
   * released yet can be retried. `0` disables.
   */
  emptyRetries: number;
  /**
   * Hold reasoning back until the first text or tool-call output, so a failure
   * (or an empty or looping reply) that comes while the model only reasons can
   * still be retried or moved to another account. Off by default: the user sees
   * reasoning only once the hold ends, and the reasoning duration is measured
   * from its release.
   */
  holdReasoning: boolean;
  /** Longest reasoning is held, from its first held event. */
  holdReasoningMaxMs: number;
  /** Most held events before the hold ends. */
  holdReasoningMaxEvents: number;
  /** Most held reasoning characters before the hold ends. */
  holdReasoningMaxChars: number;
  /** End a reply whose reasoning or text is stuck in a loop with an error. */
  loopGuard: boolean;
  /** Retries of a reply whose held reasoning looped before anything was released. */
  loopRetries: number;
}

export const DEFAULT_LLM_REPLY_GUARD_POLICY: Readonly<LLMReplyGuardPolicy> = {
  emptyRetries: 2,
  holdReasoning: false,
  holdReasoningMaxMs: 4 * 60_000,
  holdReasoningMaxEvents: 20_000,
  holdReasoningMaxChars: 1 << 20,
  loopGuard: true,
  loopRetries: 1,
};

/** A hold never runs into the call's own deadline: it is released this long before it. */
const HOLD_DEADLINE_MARGIN_MS = 1_000;

export interface LLMRetryError {
  reason: LLMMetricErrorKind;
  code?: number;
  message: string;
  /** Set only when the failure names a user-configured custom provider (`custom_provider:<id>`). */
  providerId?: string;
}

export interface LLMRetryEvent {
  sessionId: string;
  turnId: string;
  callId: string;
  scope: LLMCallScope;
  status: LLMRetryStatus;
  /** Number of retries already used or about to start; the initial request is zero. */
  retryAttempt: number;
  maxRetries: number;
  /** One-based physical provider request ordinal. */
  requestAttempt: number;
  delayMs?: number;
  nextRetryAtMs?: number;
  /** Set on `waiting` while the device is offline; such waits never consume `maxRetries`. */
  waitingFor?: 'network';
  error?: LLMRetryError;
}

/**
 * Host view of device connectivity. The retry layer only asks whether a
 * retryable network failure means the device itself is offline, and wakes
 * early on resume and online hints; probing, sleep detection and watching the
 * network stay with the host.
 */
export interface LLMNetworkRecovery {
  /** Longest offline period one logical call waits through before it fails. */
  readonly maxOfflineWaitMs: number;
  /** A provider answered at this endpoint, so the device has reached it before. */
  markReachable(baseUrl: string): void;
  /** Whether a retryable network failure at this endpoint means the device is offline. */
  isOffline(baseUrl: string, signal?: AbortSignal): Promise<boolean>;
  /** Subscribe to system resume hints; returns the unsubscribe. */
  onResume(listener: () => void): () => void;
  /**
   * Subscribe to hints that the device has a network again; returns the
   * unsubscribe. An offline wait retries at once on one instead of sleeping
   * out its backoff, and keeps its offline window, so a network that keeps
   * flapping still ends the call.
   */
  onOnline(listener: () => void): () => void;
}

/** Raw provider token buckets from the final attempt of a successful call. */
export interface LLMCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface LLMRequestSettledEvent {
  /** One-based physical provider request ordinal within the logical call. */
  requestAttempt: number;
  outcome: LLMCallOutcome;
  /** Known provider buckets, with invalid or missing buckets normalised to zero. */
  usage?: LLMCallUsage;
  /** Valid provider fields only; absent fields stay absent, including the reported total. */
  reportedUsage?: Partial<LLMCallUsage> & { totalTokens?: number };
  /** False when the provider did not report all four valid buckets. */
  usageComplete: boolean;
  /**
   * The wire protocol and provider id the response came back through, so a
   * consumer can tell which buckets that route actually reports. Absent when
   * the attempt produced no response.
   */
  route?: LLMRequestRoute;
}

export interface LLMRequestRoute {
  api: string;
  provider: string;
}

export type LLMRequestSettledObserver = (event: LLMRequestSettledEvent) => void;

export interface LLMExpectedToolIdentity {
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface LLMCallSettledEvent {
  sessionId: string;
  turnId: string;
  callId: string;
  scope: LLMCallScope;
  provider: string;
  model: string;
  final: {
    outcome: LLMCallOutcome;
    errorKind: LLMCallErrorKind;
  };
  /**
   * Set only when the call ran out of a local resource (`final.errorKind` is a
   * local resource kind): the outcome and kind the call metrics reported before
   * those kinds existed, with the host verdict applied. Hosts without registry
   * metrics report this instead of `final`.
   */
  legacyFinal?: {
    outcome: LLMCallOutcome;
    errorKind: LLMMetricErrorKind | 'none';
  };
  /** True once the framework schedules the first retry, even if the user cancels its backoff. */
  retryTriggered: boolean;
  retryReason?: LLMMetricErrorKind;
  /** Physical provider requests actually started for this logical call. */
  requestAttempts: number;
  /** Normalized tool identities from a successful final response; arguments are never exposed. */
  expectedTools?: readonly LLMExpectedToolIdentity[];
  /**
   * Raw provider token buckets for a successful call. Absent when the call did
   * not settle with a provider response, so consumers never report synthesised
   * usage for a failed or cancelled call.
   */
  usage?: LLMCallUsage;
}

/**
 * Host decision for one logical request, taken before its first physical
 * attempt. `send` may narrow the request: `tools: 'none'` sends it without tool
 * declarations and `instruction` is appended to this request's system prompt
 * only (never to the transcript). `stop` refuses to send it at all.
 */
export type LLMRequestAdmission =
  | { readonly kind: 'send'; readonly tools: 'all' | 'none'; readonly instruction?: string }
  | { readonly kind: 'stop'; readonly reason: string };

export interface LLMRequestLifecycleSettlement {
  readonly callId: string;
  readonly outcome: LLMCallOutcome;
  /** Physical attempts handed to the transport, each with its known usage. */
  readonly attempts: readonly LLMRequestSettledEvent[];
}

/**
 * Required per-request barrier for hosts that account logical requests. Every
 * required method is awaited on the request path: a failure fails the request
 * instead of letting it run unaccounted, and the logical result is not
 * released to the agent loop until `settle` has resolved.
 */
export interface LLMRequestLifecycle {
  admit(input: { readonly callId: string }): Promise<LLMRequestAdmission>;
  /** Just before a physical attempt is handed to the transport. */
  beforeAttempt(input: { readonly callId: string; readonly requestAttempt: number }): Promise<void>;
  /**
   * Each time an attempt reports its receipt, with every receipt of the
   * request so far, so the known usage of a failed attempt does not wait in
   * memory through the retry backoff and the next attempt. Records run one
   * after another and `settle` starts only after the last one finished. It is
   * not a barrier: a failure is swallowed, and `settle` still carries every
   * attempt.
   */
  recordAttempts?(input: {
    readonly callId: string;
    readonly attempts: readonly LLMRequestSettledEvent[];
  }): Promise<void>;
  settle(input: LLMRequestLifecycleSettlement): Promise<void>;
}

/**
 * Counting-only observation of a logical request's attempts, for hosts that
 * charge a request's tokens without gating it (for example a Goal charging
 * automatic compaction or a sub-session round). It never refuses or narrows a
 * request. `settle` is awaited before the logical result is released, so the
 * charge is visible to whatever runs next; a failure is swallowed and never
 * fails the request.
 */
export interface LLMUsageRecorder {
  recordAttempts?(input: {
    readonly callId: string;
    readonly scope: LLMCallScope;
    readonly attempts: readonly LLMRequestSettledEvent[];
  }): Promise<void>;
  settle(input: LLMRequestLifecycleSettlement & { readonly scope: LLMCallScope }): Promise<void>;
}

/** Message prefix of {@link LLMRequestStoppedError}; Pi keeps only the message of a run failure. */
export const LLM_REQUEST_STOPPED_MESSAGE_PREFIX = 'LLM request stopped before sending:';

/** The host refused to send a logical request (see `LLMRequestAdmission`). */
export class LLMRequestStoppedError extends Error {
  override readonly name = 'LLMRequestStoppedError';

  constructor(readonly reason: string) {
    super(`${LLM_REQUEST_STOPPED_MESSAGE_PREFIX} ${reason}`);
  }
}

/** Whether a Pi run failure is a request the host refused to send. */
export function isLLMRequestStoppedMessage(message: string | undefined): boolean {
  return message?.startsWith(LLM_REQUEST_STOPPED_MESSAGE_PREFIX) === true;
}

export interface LLMRetryOptions {
  sessionId: string;
  turnId: string;
  scope: LLMCallScope;
  /** Awaited request accounting; applied to the `agent` scope only. */
  requestLifecycle?: LLMRequestLifecycle;
  /**
   * Counting-only usage observation for the `agent` and `compaction` scopes,
   * on a scope no `requestLifecycle` governs. Title requests are never
   * recorded.
   */
  usageRecorder?: LLMUsageRecorder;
  policy?: Partial<LLMRetryPolicy>;
  /** Reply-stream safeguards; unset fields take {@link DEFAULT_LLM_REPLY_GUARD_POLICY}. */
  replyGuard?: Partial<LLMReplyGuardPolicy>;
  /** Required resource lifecycle; unlike observers its failures are not swallowed. */
  lifecycle?: LLMCallLifecycle;
  /**
   * Opt-in offline handling: while the device is offline a call keeps waiting,
   * up to `maxOfflineWaitMs`, instead of spending its retry budget.
   */
  networkRecovery?: LLMNetworkRecovery;
  /**
   * Resend a logical request whose stream broke after the consumer already saw
   * output, but only for a recognised transient stream interruption (see
   * `isLLMRecoverableStreamInterruption`). The resend shares this call's budget,
   * backoff, elapsed window, offline wait, cancellation, observers and
   * settlement; the consumer is told to drop the abandoned attempt through a
   * stream-reset event before the resend. Every other post-commit failure keeps
   * failing closed, so hosts whose consumers cannot show the split must leave
   * this off.
   */
  recoverPartialStream?: boolean;
  observer?: (event: LLMRetryEvent) => void | Promise<void>;
  /** Final logical outcome observer. It is isolated from provider-call behavior. */
  onCallSettled?: (event: LLMCallSettledEvent) => void | Promise<void>;
  generateCallId?: () => string;
  nowMs?: () => number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface RetryFailure {
  normalized: NormalizedLLMError;
  error: LLMRetryError;
  stream?: AssistantMessageEventStream;
  iterator?: AsyncIterator<AssistantMessageEvent>;
  buffered: AssistantMessageEvent[];
  thrown?: unknown;
  final?: AssistantMessage;
  response?: ProviderResponse;
  retryAfterMs?: number;
  /** The wait a provider's refusal cool-down names: no retry goes out before it ends. */
  cooldownMs?: number;
  /**
   * A failure this layer decided on a reply the provider completed or was
   * still sending (an empty or looping reply), not one the provider reported.
   * `retry` says whether this layer would ask again; `handover` is how the call
   * ends when it does not: the empty reply as it came, or the loop cut with an
   * error.
   */
  streamFailure?: {
    readonly kind: Extract<LLMStreamFailureKind, 'llm_empty_response' | 'llm_reply_loop'>;
    readonly retry: boolean;
    readonly handover: () => AssistantMessageEventStream;
  };
}

interface RetryableFailure extends RetryFailure {
  retryReason: LLMMetricErrorKind;
}

interface RetryCallState {
  retryTriggered: boolean;
  retryReason?: LLMMetricErrorKind;
  requestAttempts: number;
  settled?: boolean;
  terminalErrorKind?: LLMMetricErrorKind;
  /** What the provider of the current attempt reported through `onProviderError`. */
  providerError?: unknown;
}

export interface CallSettlementContext {
  input: LLMRetryOptions;
  model: Parameters<StreamFn>[0];
  callId: string;
  state: RetryCallState;
  signal: AbortSignal | undefined;
}

/**
 * What one physical attempt reported about itself, captured while it runs —
 * also after the commit boundary, so a post-commit failure is classified from
 * the provider's own typed error, not only its flattened message.
 */
interface AttemptFacts {
  response?: ProviderResponse;
  providerError?: unknown;
}

/** How a failed attempt is judged beyond the default classification. */
interface FailurePolicy {
  /**
   * Opt-in: a recognised transient stream interruption may also be resent
   * before any output was produced.
   */
  readonly recoverStreamInterruptions?: boolean;
  /**
   * Set for attempts the partial-stream recovery itself started: a
   * deterministic rejection is final there, so a transient word in the message
   * (`invalid_request_error: timeout …`) cannot turn a 4xx back into a resend.
   */
  readonly vetoDeterministicRejections?: boolean;
}

type PreflightResult =
  | { kind: 'committed'; stream: AssistantMessageEventStream; facts: AttemptFacts }
  | { kind: 'terminal'; failure: RetryFailure }
  | { kind: 'failure'; failure: RetryableFailure };

/** Add framework-owned transport retry to a provider StreamFn. Hosts opt in explicitly. */
export function withLLMRetry(inner: StreamFn, input: LLMRetryOptions): StreamFn {
  return (async (model, context, options) => {
    const callId = input.generateCallId?.() ?? defaultCallId();
    const identity = {};
    const state: RetryCallState = { retryTriggered: false, requestAttempts: 0 };
    if (!input.lifecycle)
      return createRetryLoop(inner, input, callId, identity, state)(model, context, options);
    const callerSignal = options?.signal ?? new AbortController().signal;
    // The host contract is absolute Unix ms, independent of a test/observer clock.
    // Short auxiliary requests must not acquire a fresh, longer budget during admission/recovery.
    const requestedMs = options?.timeoutMs;
    const timeoutMs =
      typeof requestedMs === 'number' && Number.isFinite(requestedMs) && requestedMs > 0
        ? requestedMs
        : Infinity;
    // Admission (and the host's recovery) is bounded by the retry budget, including the per-attempt
    // admission the lease runs before it sends (an account's queue for a free slot). The request
    // itself is not: once sent, only the caller's own timeout bounds it, as without a host lease
    // (agent-core's first-event and idle watchdogs bound the wait for a reply).
    const deadlineAt =
      Date.now() + Math.floor(Math.min(resolvePolicy(input.policy).maxRetryElapsedMs, timeoutMs));
    const hardDeadlineAt = Number.isFinite(timeoutMs)
      ? Date.now() + Math.floor(timeoutMs)
      : undefined;
    const budget = createRetryBudget(callerSignal, deadlineAt);
    // The lease calls this once its admission is done and the request goes out.
    const sent: StreamFn = (sentModel, sentContext, sentOptions) => {
      budget.arm(hardDeadlineAt);
      return inner(sentModel, sentContext, sentOptions);
    };
    const settlement = { input, model, callId, state, signal: callerSignal };
    try {
      const stream = await runWithLLMCallLifecycle(
        input.lifecycle,
        {
          identity,
          callId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          scope: input.scope,
          signal: budget.signal,
          deadlineAt,
        },
        async (lease) =>
          createRetryLoop(
            lease.wrapAttempt(sent),
            input,
            callId,
            identity,
            state,
            lease,
            hardDeadlineAt,
            budget,
            deadlineAt,
          )(model, context, { ...options, signal: lease.signal }),
      );
      // Required cleanup settles before the logical outcome is published.
      return observeCallSettlement(stream, settlement);
    } catch (error) {
      if (budget.expired() && !callerSignal.aborted) state.terminalErrorKind = 'timeout';
      notifyCallSettled(settlement, error);
      throw error;
    } finally {
      budget.stop();
    }
  }) as StreamFn;
}

function createRetryLoop(
  inner: StreamFn,
  input: LLMRetryOptions,
  callId: string,
  callIdentity: object,
  state: RetryCallState,
  lease?: LLMCallLease,
  /** With a host lease: the caller's own timeout, the only bound on a request in flight. */
  hardDeadlineAt?: number,
  budget?: RetryBudget,
  /** With a host lease: the bound on the first attempt's admission (the retry budget). */
  admissionDeadlineAt?: number,
): StreamFn {
  const policy = resolvePolicy(input.policy);
  const replyGuard = resolveReplyGuardPolicy(input.replyGuard);
  const nowMs = input.nowMs ?? Date.now;
  const random = input.random ?? Math.random;
  const sleep = input.sleep ?? abortableSleep;

  // Request accounting (upstream): the agent scope's admission lifecycle, or a
  // counting-only recorder for every non-title scope.
  const lifecycle =
    input.scope === 'agent' && input.requestLifecycle
      ? input.requestLifecycle
      : input.scope !== 'title' && input.usageRecorder
        ? recordingLifecycle(input.usageRecorder, input.scope)
        : undefined;

  return (async (model, originalContext, options) => {
    // Admission may stop the request before any transport: no call settles then.
    const request = await admitRequest(lifecycle, callId, originalContext);
    const { context } = request;
    // With a host lease, only the outer cleanup wrapper may publish settlement.
    const settlement = {
      input: lease ? { ...input, onCallSettled: undefined } : input,
      model,
      callId,
      state,
      signal: options?.signal,
    };
    // Retries charged to `policy`; offline waits never count against it.
    let retriesUsed = 0;
    let retryStartedAtMs: number | undefined;
    // Offline waits are not charged. They are bounded by `maxOfflineWaitMs` from
    // the first offline verdict; only a system wake opens a fresh offline window,
    // so a probe that flips between verdicts still ends the call.
    let offlineSinceMs: number | undefined;
    let offlinePolls = 0;
    // With a host lease: retries and recovery share the retry budget from the first failure.
    let retryDeadlineAt: number | undefined;
    const deadlineAt = (): number | undefined => retryDeadlineAt ?? hardDeadlineAt;
    // A host lease bounds the whole call itself, so offline waits and wake resets stay off.
    const offlineRecovery = lease === undefined ? input.networkRecovery : undefined;
    let requestAttempt = 1;
    // Asks spent on empty and looping replies; each is also a retry of the policy's budget.
    let emptyRetries = 0;
    let loopRetries = 0;
    const wake = createSystemWakeLatch(offlineRecovery);
    const event = (status: LLMRetryStatus, error?: LLMRetryError): LLMRetryEvent => ({
      sessionId: input.sessionId,
      turnId: input.turnId,
      callId,
      scope: input.scope,
      status,
      retryAttempt: retriesUsed,
      maxRetries: policy.maxRetries,
      requestAttempt,
      ...(error ? { error } : {}),
    });
    try {
      while (retriesUsed <= policy.maxRetries) {
        if (options?.signal?.aborted) throw abortError(options.signal);
        const attemptDeadlineAt = deadlineAt();
        if (attemptDeadlineAt !== undefined && Date.now() >= attemptDeadlineAt)
          throw retryTimeout();
        // The lease's admission for this attempt is bounded by the retry budget; the wrapped inner
        // re-arms the caller's own timeout once the request is sent.
        budget?.arm(retryDeadlineAt ?? admissionDeadlineAt);
        state.terminalErrorKind = undefined;
        state.providerError = undefined;
        const beforeRequest = (
          options as
            | (Parameters<StreamFn>[2] & {
                [LLM_RETRY_BEFORE_REQUEST]?: (requestAttempt: number) => void;
              })
            | undefined
        )?.[LLM_RETRY_BEFORE_REQUEST];
        beforeRequest?.(requestAttempt);
        await lifecycle?.beforeAttempt({ callId, requestAttempt });
        // Admission/accounting can yield while the user stops the turn.
        if (options?.signal?.aborted) throw abortError(options.signal);
        state.requestAttempts = requestAttempt;
        const preflight = await preflightAttempt(
          inner,
          model,
          context,
          captureProviderError(options, state),
          nowMs,
          callIdentity,
          isByokProvider(model.provider),
          requestAttempt,
          request.observeAttempt(requestSettledObserver(options)),
          budget,
          {
            policy: replyGuard,
            emptyRetry: emptyRetries < replyGuard.emptyRetries && retriesUsed < policy.maxRetries,
            loopRetry: loopRetries < replyGuard.loopRetries && retriesUsed < policy.maxRetries,
            ...(attemptDeadlineAt !== undefined ? { deadlineAt: attemptDeadlineAt } : {}),
          },
          { recoverStreamInterruptions: input.recoverPartialStream === true },
        );
        if (options?.signal?.aborted) {
          if (preflight.kind !== 'committed') {
            if (requestAttempt > 1)
              await notify(input.observer, event('cancelled', preflight.failure.error));
            return request.settleWith(
              await request.guardThrow(options?.signal, () =>
                observeTerminalFailure(preflight.failure, settlement),
              ),
              options?.signal,
            );
          }
          throw abortError(options.signal);
        }
        if (preflight.kind === 'committed') {
          budget?.stop();
          input.networkRecovery?.markReachable(model.baseUrl);
          if (requestAttempt > 1) await notify(input.observer, event('recovered'));
          const committed =
            input.recoverPartialStream === true
              ? recoveringStream(preflight.stream, preflight.facts, {
                  inner,
                  input,
                  policy,
                  replyGuard,
                  model,
                  context,
                  options,
                  callId,
                  callIdentity,
                  state,
                  lifecycle,
                  request,
                  // A host lease bounds the whole call by its deadline, so it keeps
                  // the bounded budget only, as before the commit.
                  networkRecovery: offlineRecovery,
                  ...(attemptDeadlineAt !== undefined ? { deadlineAt: attemptDeadlineAt } : {}),
                  requestAttempt,
                  retriesUsed,
                  // A wake since the window opened hands the resend a fresh window.
                  ...(retryStartedAtMs !== undefined && !wake.take() ? { retryStartedAtMs } : {}),
                  nowMs,
                  random,
                  sleep,
                })
              : preflight.stream;
          return request.settleWith(observeCallSettlement(committed, settlement), options?.signal);
        }

        const failure = preflight.failure;
        const owned = failure.streamFailure;
        // A reply this layer ends on its own (a loop cut) is not the host's to judge.
        const hostDecision =
          owned && !owned.retry
            ? undefined
            : await lease?.classifyFailure?.({
                ...(failure.thrown !== undefined ? { thrown: failure.thrown } : {}),
                ...(failure.final !== undefined ? { final: failure.final } : {}),
                ...(failure.response !== undefined ? { response: failure.response } : {}),
              });
        const ownDecision: LLMCallRetryDecision = {
          kind: preflight.kind === 'failure' ? 'retry' : 'terminal',
          errorKind: failure.error.reason,
          ...(preflight.kind === 'failure' ? { retryReason: preflight.failure.retryReason } : {}),
          retryAfterMs: failure.retryAfterMs,
        };
        // An empty or looping reply came whole over a healthy transport, which a provider
        // classifier only reads as a bad request: the host may move it to another account
        // (`retry`), and any other verdict leaves it to this layer's own bounded retry.
        const decision: LLMCallRetryDecision = owned
          ? owned.retry && hostDecision?.kind === 'retry'
            ? hostDecision
            : ownDecision
          : (hostDecision ?? ownDecision);
        if (hostDecision && !owned) {
          failure.error = publicRetryError(failure.normalized, decision.errorKind);
          state.terminalErrorKind = decision.errorKind;
        }
        const failureAtMs = nowMs();
        // An offline device is waited out instead of spending the retry budget.
        // A host lease bounds the whole call by its deadline, so it keeps the
        // bounded budget only.
        const recovery = offlineRecovery;
        if (
          recovery &&
          preflight.kind === 'failure' &&
          decision.kind === 'retry' &&
          !owned &&
          !isAbortFailure(failure) &&
          (await isDeviceOffline(
            recovery,
            model.baseUrl,
            preflight.failure.retryReason,
            options?.signal,
          ))
        ) {
          offlineSinceMs ??= failureAtMs;
          if (failureAtMs - offlineSinceMs > recovery.maxOfflineWaitMs) {
            await notify(input.observer, event('exhausted', failure.error));
            return request.settleWith(
              await request.guardThrow(options?.signal, () =>
                observeTerminalFailure(failure, settlement),
              ),
              options?.signal,
            );
          }
          // Time spent offline does not count against the charged window.
          retryStartedAtMs = undefined;
          offlinePolls += 1;
          await discardAttempt(failure);
          if (options?.signal?.aborted) throw abortError(options.signal);
          const offlineDelayMs = retryDelayMs(
            undefined,
            offlinePolls,
            offlinePollPolicy(policy),
            random,
          );
          await notify(input.observer, {
            ...event('waiting', failure.error),
            retryAttempt: 0,
            requestAttempt: requestAttempt + 1,
            delayMs: offlineDelayMs,
            nextRetryAtMs: nowMs() + offlineDelayMs,
            waitingFor: 'network',
          });
          let resumed: boolean;
          try {
            const sleptFromMs = nowMs();
            resumed =
              (await sleepUntilResume(sleep, offlineDelayMs, options?.signal, recovery)) ||
              overranSystemSleep(sleptFromMs, nowMs(), offlineDelayMs);
          } catch (error) {
            await notify(input.observer, {
              ...event('cancelled', failure.error),
              retryAttempt: 0,
              requestAttempt: requestAttempt + 1,
            });
            throw error;
          }
          if (resumed) {
            // A wake gives the network a fresh window; time asleep is not waiting.
            offlineSinceMs = undefined;
            offlinePolls = 0;
          }
          requestAttempt += 1;
          continue;
        }
        offlinePolls = 0;
        // A wake since the window opened restarts it: time asleep is not time retrying.
        if (wake.take()) retryStartedAtMs = undefined;
        retryStartedAtMs ??= failureAtMs;
        wake.arm();
        if (budget && retryDeadlineAt === undefined) {
          retryDeadlineAt = Math.min(
            hardDeadlineAt ?? Infinity,
            Date.now() + policy.maxRetryElapsedMs,
          );
          budget.arm(retryDeadlineAt);
        }
        const delayMs = Math.max(
          retryDelayMs(
            decision.retryAfterMs ?? failure.retryAfterMs,
            retriesUsed + 1,
            policy,
            random,
          ),
          failure.cooldownMs ?? 0,
        );
        const expired =
          retryDeadlineAt !== undefined
            ? Date.now() + delayMs >= retryDeadlineAt
            : failureAtMs + delayMs - retryStartedAtMs > policy.maxRetryElapsedMs;
        const cannotRecover =
          decision.kind === 'recover' && (!lease?.recover || retryDeadlineAt === undefined);
        if (
          isAbortFailure(failure) ||
          decision.kind === 'terminal' ||
          cannotRecover ||
          retriesUsed >= policy.maxRetries ||
          expired
        ) {
          // An empty reply handed over as it came ends the call with that reply, not a failure.
          const handedOver = owned?.kind === 'llm_empty_response';
          if (handedOver) {
            if (requestAttempt > 1) await notify(input.observer, event('recovered'));
          } else if (preflight.kind === 'failure' || requestAttempt > 1) {
            await notify(
              input.observer,
              event(isAbortFailure(failure) ? 'cancelled' : 'exhausted', failure.error),
            );
          }
          return request.settleWith(
            await request.guardThrow(options?.signal, () =>
              observeTerminalFailure(failure, settlement),
            ),
            options?.signal,
          );
        }

        // A failed attempt must release transport and credential resources before recovery.
        await discardAttempt(failure);
        if (options?.signal?.aborted) throw abortError(options.signal);
        if (decision.kind === 'recover' && lease?.recover && retryDeadlineAt !== undefined) {
          if (Date.now() >= retryDeadlineAt) throw retryTimeout();
          await lease.recover({ signal: lease.signal, deadlineAt: retryDeadlineAt });
        }
        if (options?.signal?.aborted) throw abortError(options.signal);
        if (retryDeadlineAt !== undefined && Date.now() + delayMs >= retryDeadlineAt)
          throw retryTimeout();
        state.retryTriggered = true;
        retriesUsed += 1;
        if (owned?.kind === 'llm_empty_response') emptyRetries += 1;
        if (owned?.kind === 'llm_reply_loop') loopRetries += 1;
        // Credential recovery has no transport retry reason; never inherit BYOK's network fallback.
        state.retryReason ??= decision.retryReason;
        await notify(input.observer, {
          ...event('waiting', failure.error),
          retryAttempt: retriesUsed,
          requestAttempt: requestAttempt + 1,
          delayMs,
          nextRetryAtMs: nowMs() + delayMs,
        });
        try {
          const sleptFromMs = nowMs();
          await sleep(delayMs, options?.signal);
          if (overranSystemSleep(sleptFromMs, nowMs(), delayMs)) wake.mark();
        } catch (error) {
          await notify(input.observer, {
            ...event('cancelled', failure.error),
            retryAttempt: retriesUsed,
            requestAttempt: requestAttempt + 1,
          });
          throw error;
        }
        requestAttempt += 1;
      }
      throw new Error('LLM retry loop ended without a provider result');
    } catch (error) {
      notifyCallSettled(settlement, error);
      await request.settleThrown(error, options?.signal);
      throw error;
    } finally {
      wake.dispose();
    }
  }) as StreamFn;
}

interface AdmittedRequest {
  /** The request as it will be sent: narrowed by the admission when needed. */
  readonly context: Parameters<StreamFn>[1];
  /** Chain the caller's per-attempt observer with this request's attempt log. */
  observeAttempt(
    observer: LLMRequestSettledObserver | undefined,
  ): LLMRequestSettledObserver | undefined;
  /** Release `stream`'s result only after the lifecycle settled the request. */
  settleWith(
    stream: AssistantMessageEventStream,
    signal: AbortSignal | undefined,
  ): AssistantMessageEventStream;
  /** Settle a request that ends by throwing; the caller rethrows. */
  settleThrown(error: unknown, signal: AbortSignal | undefined): Promise<void>;
  /** Run a synchronous step that may throw, settling the request first when it does. */
  guardThrow(
    signal: AbortSignal | undefined,
    step: () => AssistantMessageEventStream,
  ): Promise<AssistantMessageEventStream>;
}

/** A lifecycle that admits every request unchanged and only records its attempts. */
function recordingLifecycle(recorder: LLMUsageRecorder, scope: LLMCallScope): LLMRequestLifecycle {
  return {
    admit: async () => ({ kind: 'send', tools: 'all' }),
    beforeAttempt: async () => undefined,
    ...(recorder.recordAttempts
      ? {
          recordAttempts: async ({ callId, attempts }) => {
            await recorder.recordAttempts?.({ callId, scope, attempts });
          },
        }
      : {}),
    settle: async (settlement) => {
      try {
        await recorder.settle({ ...settlement, scope });
      } catch {
        // Counting only: a recorder failure never fails the request.
      }
    },
  };
}

/**
 * Admit one logical request through the host lifecycle. Without a lifecycle
 * every method is a pass-through, so hosts that do not account requests keep
 * the exact pre-lifecycle stream composition.
 */
async function admitRequest(
  lifecycle: LLMRequestLifecycle | undefined,
  callId: string,
  context: Parameters<StreamFn>[1],
): Promise<AdmittedRequest> {
  if (!lifecycle) {
    return {
      context,
      observeAttempt: (observer) => observer,
      settleWith: (stream) => stream,
      settleThrown: async () => undefined,
      guardThrow: async (_signal, step) => step(),
    };
  }
  const admission = await lifecycle.admit({ callId });
  if (admission.kind === 'stop') {
    // Nothing was handed to the transport: settle so the reservation is
    // released. No call settles either, so call metrics see no LLM failure.
    const error = new LLMRequestStoppedError(admission.reason);
    await lifecycle.settle({ callId, outcome: 'abort', attempts: [] });
    throw error;
  }
  const attempts: LLMRequestSettledEvent[] = [];
  const recordAttempts = lifecycle.recordAttempts?.bind(lifecycle);
  // The chain of attempt records issued so far; settlement waits for it.
  let recorded: Promise<void> | undefined;
  let settled: Promise<void> | undefined;
  const settle = (final: AssistantMessage | undefined, thrown: unknown, aborted: boolean) => {
    if (!settled) {
      const settlement: LLMRequestLifecycleSettlement = {
        callId,
        outcome: classifyCallOutcome(final, thrown, aborted).outcome,
        attempts: [...attempts],
      };
      settled = recorded
        ? recorded.then(() => lifecycle.settle(settlement))
        : lifecycle.settle(settlement);
    }
    return settled;
  };
  return {
    context: projectAdmittedContext(context, admission),
    observeAttempt: (observer) => (event) => {
      attempts.push(event);
      if (recordAttempts) {
        const input = { callId, attempts: [...attempts] };
        recorded = (recorded ?? Promise.resolve())
          .then(() => recordAttempts(input))
          .catch(() => {
            // A record is a durability checkpoint, not a barrier: `settle`
            // still carries every attempt, so the request goes on.
          });
      }
      observer?.(event);
    },
    settleWith: (stream, signal) =>
      gateResult(
        stream,
        settle,
        signal,
        admission.tools === 'none' ? withoutToolIntents : undefined,
      ),
    settleThrown: (error, signal) => settle(undefined, error, signal?.aborted === true),
    guardThrow: async (signal, step) => {
      try {
        return step();
      } catch (error) {
        await settle(undefined, error, signal?.aborted === true);
        throw error;
      }
    },
  };
}

function projectAdmittedContext(
  context: Parameters<StreamFn>[1],
  admission: Extract<LLMRequestAdmission, { kind: 'send' }>,
): Parameters<StreamFn>[1] {
  if (admission.tools === 'all' && !admission.instruction) return context;
  return {
    ...context,
    ...(admission.tools === 'none' ? { tools: [] } : {}),
    ...(admission.instruction
      ? {
          systemPrompt: context.systemPrompt
            ? `${context.systemPrompt}\n\n${admission.instruction}`
            : admission.instruction,
        }
      : {}),
  };
}

/**
 * A request sent without tools may still come back with tool intents. They
 * are dropped before the agent loop sees the message, so nothing runs and no
 * proposal is made; the request is still settled with the provider's answer.
 */
function withoutToolIntents(final: AssistantMessage): AssistantMessage {
  // Return failed messages unchanged: the agent loop does not execute their tool calls,
  // and cloning would drop object-keyed gateway rejection metadata (e.g. content_error).
  if (final.stopReason === 'error') return final;
  if (!final.content.some((block) => block.type === 'toolCall')) return final;
  return {
    ...final,
    content: final.content.filter((block) => block.type !== 'toolCall'),
    stopReason: final.stopReason === 'toolUse' ? 'stop' : final.stopReason,
  };
}

function withoutToolIntentEvent(event: AssistantMessageEvent): AssistantMessageEvent | undefined {
  if (
    event.type === 'toolcall_start' ||
    event.type === 'toolcall_delta' ||
    event.type === 'toolcall_end'
  ) {
    return undefined;
  }
  if (event.type !== 'done') return event;
  return {
    ...event,
    reason: event.reason === 'toolUse' ? 'stop' : event.reason,
    message: withoutToolIntents(event.message),
  };
}

/**
 * Hold the logical result until the host settled the request. Pi awaits
 * `result()` before it emits `message_end`, runs tools or sends the next
 * request, so every later step observes the settled ledger.
 */
function gateResult(
  source: AssistantMessageEventStream,
  settle: (final: AssistantMessage | undefined, thrown: unknown, aborted: boolean) => Promise<void>,
  signal: AbortSignal | undefined,
  project?: (final: AssistantMessage) => AssistantMessage,
): AssistantMessageEventStream {
  let gated: Promise<AssistantMessage> | undefined;
  const result = (): Promise<AssistantMessage> => {
    gated ??= Promise.resolve()
      .then(() => source.result())
      .then(
        async (final) => {
          await settle(final, undefined, signal?.aborted === true);
          return project ? project(final) : final;
        },
        async (error: unknown) => {
          await settle(undefined, error, signal?.aborted === true);
          throw error;
        },
      );
    return gated;
  };
  return {
    [Symbol.asyncIterator]() {
      const inner = source[Symbol.asyncIterator]();
      // A consumer that only iterates still waits for the settlement at the end.
      const iterator: AsyncIterator<AssistantMessageEvent> = {
        async next(...args) {
          for (;;) {
            let next: IteratorResult<AssistantMessageEvent>;
            try {
              next = await inner.next(...args);
            } catch (error) {
              await result().catch(() => undefined);
              throw error;
            }
            if (next.done) {
              await result().catch(() => undefined);
              return next;
            }
            if (!project) return next;
            const event = withoutToolIntentEvent(next.value);
            if (event) return { done: false, value: event };
          }
        },
      };
      if (inner.return) iterator.return = inner.return.bind(inner);
      if (inner.throw) iterator.throw = inner.throw.bind(inner);
      return iterator;
    },
    result,
  } as unknown as AssistantMessageEventStream;
}

/** This attempt's reply safeguards, as the retry loop allows them now. */
interface ReplyGuardAttempt {
  readonly policy: LLMReplyGuardPolicy;
  /** An empty reply may be asked again: the empty-retry and retry budgets have room. */
  readonly emptyRetry: boolean;
  /** A reply whose held reasoning looped may be asked again. */
  readonly loopRetry: boolean;
  /** The logical call's deadline (absolute Unix ms), which a hold never runs into. */
  readonly deadlineAt?: number;
}

const NO_REPLY_GUARD: ReplyGuardAttempt = {
  policy: { ...DEFAULT_LLM_REPLY_GUARD_POLICY, emptyRetries: 0, loopGuard: false, loopRetries: 0 },
  emptyRetry: false,
  loopRetry: false,
};

async function preflightAttempt(
  inner: StreamFn,
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  nowMs: () => number,
  callIdentity: object,
  retryAllErrors: boolean,
  requestAttempt: number,
  onRequestSettled: LLMRequestSettledObserver | undefined,
  budget?: RetryBudget,
  guard: ReplyGuardAttempt = NO_REPLY_GUARD,
  failurePolicy: FailurePolicy = {},
): Promise<PreflightResult> {
  // Filled by the provider callbacks for as long as the attempt runs, so a
  // committed attempt still reports what it says after the commit boundary.
  const facts: AttemptFacts = {};
  const callerOnResponse = options?.onResponse;
  // A reply cut for looping must also stop the provider request (it would otherwise run to its
  // output limit): this attempt's own signal, linked to the caller's.
  const stopController = guard.policy.loopGuard ? new AbortController() : undefined;
  const callerOnProviderError = options?.onProviderError;
  const attemptOptions: SimpleStreamOptions = {
    ...(options ?? {}),
    ...(stopController
      ? {
          signal: options?.signal
            ? AbortSignal.any([options.signal, stopController.signal])
            : stopController.signal,
        }
      : {}),
    maxRetries: 0,
    onProviderError: (error, responseModel) => {
      // Providers flatten exceptions to text in their error events. Keep the
      // typed cause for this attempt only; never put it into public events.
      facts.providerError = error;
      try {
        callerOnProviderError?.(error, responseModel);
      } catch {
        // Observability must not replace the original transport failure.
      }
    },
    onResponse: async (value, responseModel) => {
      facts.response = value;
      await callerOnResponse?.(value, responseModel);
    },
  };
  Object.defineProperty(attemptOptions, LLM_RETRY_CALL_IDENTITY, {
    value: callIdentity,
    // StreamFn composition uses object spread. Enumerable symbol keys survive
    // those wrappers while remaining invisible to JSON/provider payloads.
    enumerable: true,
  });
  let stream: AssistantMessageEventStream;
  try {
    stream = await inner(model, context, attemptOptions);
  } catch (thrown) {
    notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
    return failureResult({
      thrown,
      response: facts.response,
      buffered: [],
      nowMs,
      retryAllErrors,
      ...failurePolicy,
    });
  }

  let iterator: AsyncIterator<AssistantMessageEvent>;
  try {
    iterator = stream[Symbol.asyncIterator]();
  } catch (thrown) {
    notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
    return failureResult({
      thrown,
      response: facts.response,
      stream,
      buffered: [],
      nowMs,
      retryAllErrors,
      ...failurePolicy,
    });
  }

  const buffered: AssistantMessageEvent[] = [];
  const loop = guard.policy.loopGuard ? new LLMReplyLoopGuard() : undefined;
  const hold = guard.policy.holdReasoning
    ? new ReasoningHold(guard.policy, guard.deadlineAt)
    : undefined;
  let lastPartial: AssistantMessage | undefined;
  const stopProvider = (): void => {
    if (stopController && !stopController.signal.aborted)
      stopController.abort(replyLoopStopReason());
    releaseIterator(iterator);
  };
  const cutFinal = (trip: LLMReplyLoopTrip): AssistantMessage =>
    withLLMStreamFailure(
      detachedPartial(lastPartial, model),
      'llm_reply_loop',
      llmReplyLoopMessage(trip),
      { channel: trip.reasoning ? 'reasoning' : 'text', window: trip.window, runOn: trip.runOn },
    );
  const commit = (pending?: Promise<IteratorResult<AssistantMessageEvent>>): PreflightResult => {
    budget?.stop();
    return {
      kind: 'committed',
      stream: observeRequestSettlement(
        replayStream(stream, iterator, buffered, {
          ...(pending ? { pending } : {}),
          ...(loop
            ? {
                // After the commit boundary a loop is cut with an error; nothing is asked again.
                guard: (event: AssistantMessageEvent) => {
                  const partial = partialOf(event);
                  if (partial) lastPartial = partial;
                  const trip = loop.feed(event);
                  return trip ? cutFinal(trip) : undefined;
                },
                stop: stopProvider,
              }
            : {}),
        }),
        requestAttempt,
        onRequestSettled,
        options?.signal,
      ),
      facts,
    };
  };
  const emptyFailure = (final: AssistantMessage): PreflightResult =>
    ownedFailure({
      kind: 'llm_empty_response',
      final: withLLMStreamFailure(final, 'llm_empty_response', EMPTY_REPLY_MESSAGE),
      retry: true,
      // When nobody asks again, the empty reply goes on exactly as the provider sent it.
      handover: () => replayStream(stream, iterator, buffered),
      response: facts.response,
      stream,
      iterator,
      buffered,
    });

  for (;;) {
    let next: IteratorResult<AssistantMessageEvent> | typeof HOLD_EXPIRED;
    try {
      const pending = iterator.next();
      next = hold?.active ? await hold.race(pending) : await pending;
      // Reasoning held as long as it may be: what is held goes now, and the reply commits.
      if (next === HOLD_EXPIRED) return commit(pending);
    } catch (thrown) {
      notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
      return failureResult({
        thrown,
        response: facts.response,
        stream,
        iterator,
        buffered,
        nowMs,
        retryAllErrors,
        ...failurePolicy,
      });
    }
    if (next.done) {
      try {
        const final = await stream.result();
        notifyRequestSettled(onRequestSettled, requestAttempt, final, undefined, options?.signal);
        if (isFailureMessage(final)) {
          return failureResult({
            final,
            providerError: facts.providerError,
            response: facts.response,
            stream,
            iterator,
            buffered,
            nowMs,
            retryAllErrors,
            ...failurePolicy,
          });
        }
        if (guard.emptyRetry && isEmptyReply(final)) return emptyFailure(final);
        return { kind: 'committed', stream: replayStream(stream, iterator, buffered), facts };
      } catch (thrown) {
        notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
        return failureResult({
          thrown,
          response: facts.response,
          stream,
          iterator,
          buffered,
          nowMs,
          retryAllErrors,
          ...failurePolicy,
        });
      }
    }

    const event = next.value;
    buffered.push(event);
    const partial = partialOf(event);
    if (partial) lastPartial = partial;
    if (event.type === 'error') {
      notifyRequestSettled(
        onRequestSettled,
        requestAttempt,
        event.error,
        undefined,
        options?.signal,
      );
      return failureResult({
        final: event.error,
        providerError: facts.providerError,
        response: facts.response,
        stream,
        iterator,
        buffered,
        nowMs,
        retryAllErrors,
        ...failurePolicy,
      });
    }
    const trip = loop?.feed(event);
    if (trip) {
      // Nothing of this reply was released yet: one whose held reasoning looped before it said
      // anything is asked again; any other loop ends the reply with its error.
      const final = cutFinal(trip);
      stopProvider();
      notifyRequestSettled(onRequestSettled, requestAttempt, final, undefined, options?.signal);
      const retry = guard.loopRetry && trip.reasoning && !loop!.spoke;
      return ownedFailure({
        kind: 'llm_reply_loop',
        final,
        retry,
        handover: () => cutStream(buffered, final),
        response: facts.response,
        stream,
        iterator,
        buffered,
      });
    }
    if (event.type === 'done' && guard.emptyRetry && isEmptyReply(event.message)) {
      notifyRequestSettled(
        onRequestSettled,
        requestAttempt,
        event.message,
        undefined,
        options?.signal,
      );
      return emptyFailure(event.message);
    }
    // A visible delta is the retry commit boundary for every provider. Once
    // callers can observe output, silently replacing the physical request
    // would either buffer the whole response or replay duplicate content.
    // BYOK keeps its broader pre-output retry classification, but a later
    // stream failure must stay on the already-committed attempt. Held
    // reasoning is not visible yet: it commits with the first text or tool
    // call, or once the hold reaches its bounds.
    if (commitsOutput(event, hold !== undefined) || (!retryAllErrors && event.type === 'done')) {
      return commit();
    }
    if (hold && commitsOutput(event)) {
      hold.note(event);
      if (hold.over(buffered.length)) return commit();
    }
  }
}

const EMPTY_REPLY_MESSAGE =
  'LLM provider returned an empty response: the reply ended without text or a tool call';

/** A failure decided by this layer on a reply the provider sent (empty or looping). */
function ownedFailure(input: {
  kind: Extract<LLMStreamFailureKind, 'llm_empty_response' | 'llm_reply_loop'>;
  final: AssistantMessage;
  retry: boolean;
  handover: () => AssistantMessageEventStream;
  response?: ProviderResponse;
  stream: AssistantMessageEventStream;
  iterator: AsyncIterator<AssistantMessageEvent>;
  buffered: AssistantMessageEvent[];
}): PreflightResult {
  const normalized = normalizeLLMError({
    ...(input.final.errorMessage ? { errorMessage: input.final.errorMessage } : {}),
  });
  const reason: LLMMetricErrorKind =
    input.kind === 'llm_empty_response' ? 'empty_response' : 'reply_loop';
  const failure: RetryFailure = {
    normalized,
    error: publicRetryError(normalized, reason),
    stream: input.stream,
    iterator: input.iterator,
    buffered: input.buffered,
    final: input.final,
    ...(input.response ? { response: input.response } : {}),
    streamFailure: { kind: input.kind, retry: input.retry, handover: input.handover },
  };
  return input.retry
    ? // Shown as an interrupted connection being retried, as a dropped stream is.
      { kind: 'failure', failure: { ...failure, retryReason: 'network' } }
    : { kind: 'terminal', failure };
}

const HOLD_EXPIRED: unique symbol = Symbol('llm-reasoning-hold-expired');

/**
 * Reasoning held back before the first text or tool call. It ends at its time bound, its event or
 * character bound, or ahead of the call's own deadline, whichever comes first.
 */
class ReasoningHold {
  private startedAt: number | undefined;
  private chars = 0;

  constructor(
    private readonly policy: LLMReplyGuardPolicy,
    private readonly deadlineAt: number | undefined,
  ) {}

  get active(): boolean {
    return this.startedAt !== undefined;
  }

  note(event: AssistantMessageEvent): void {
    this.startedAt ??= Date.now();
    if (event.type === 'thinking_delta') this.chars += event.delta.length;
  }

  over(heldEvents: number): boolean {
    return (
      heldEvents >= this.policy.holdReasoningMaxEvents ||
      this.chars >= this.policy.holdReasoningMaxChars ||
      Date.now() >= this.releaseAt()
    );
  }

  async race<T>(pending: Promise<T>): Promise<T | typeof HOLD_EXPIRED> {
    const wait = this.releaseAt() - Date.now();
    if (wait <= 0) return HOLD_EXPIRED;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof HOLD_EXPIRED>((resolve) => {
      timer = setTimeout(() => resolve(HOLD_EXPIRED), wait);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([pending, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private releaseAt(): number {
    const held = (this.startedAt ?? Date.now()) + this.policy.holdReasoningMaxMs;
    return this.deadlineAt === undefined
      ? held
      : Math.min(held, this.deadlineAt - HOLD_DEADLINE_MARGIN_MS);
  }
}

function replyLoopStopReason(): Error {
  const error = new Error('LLM reply stopped: stuck in a loop');
  error.name = 'AbortError';
  return error;
}

function partialOf(event: AssistantMessageEvent): AssistantMessage | undefined {
  if (event.type === 'done') return event.message;
  if (event.type === 'error') return event.error;
  return event.partial;
}

/** Detach from the provider's mutable partial so a late write cannot rewrite the cut message. */
function detachedPartial(
  partial: AssistantMessage | undefined,
  model: Parameters<StreamFn>[0],
): AssistantMessage {
  if (partial) {
    return { ...partial, content: partial.content.map((block) => ({ ...block })) };
  }
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    timestamp: Date.now(),
  };
}

/** What came of a reply before its loop was found, then its error. */
function cutStream(
  buffered: readonly AssistantMessageEvent[],
  final: AssistantMessage,
): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of buffered) yield event;
      yield { type: 'error', reason: 'error', error: final } satisfies AssistantMessageEvent;
    },
    result: async () => final,
  } as unknown as AssistantMessageEventStream;
}

interface PartialStreamRecoveryContext {
  readonly inner: StreamFn;
  readonly input: LLMRetryOptions;
  readonly policy: LLMRetryPolicy;
  readonly replyGuard: LLMReplyGuardPolicy;
  readonly model: Parameters<StreamFn>[0];
  readonly context: Parameters<StreamFn>[1];
  readonly options: Parameters<StreamFn>[2];
  readonly callId: string;
  readonly callIdentity: object;
  readonly state: RetryCallState;
  readonly lifecycle: LLMRequestLifecycle | undefined;
  readonly request: AdmittedRequest;
  /** Offline handling for this call; absent under a host lease. */
  readonly networkRecovery: LLMNetworkRecovery | undefined;
  /** A host lease's deadline (absolute Unix ms), which bounds every resend too. */
  readonly deadlineAt?: number;
  /** Where the pre-commit loop left the shared budget. */
  readonly requestAttempt: number;
  readonly retriesUsed: number;
  readonly retryStartedAtMs?: number;
  readonly nowMs: () => number;
  readonly random: () => number;
  readonly sleep: NonNullable<LLMRetryOptions['sleep']>;
}

type DrainedAttempt =
  | { kind: 'done'; event: AssistantMessageEvent; message: AssistantMessage }
  | { kind: 'ended' }
  | {
      kind: 'error';
      event: AssistantMessageEvent;
      message: AssistantMessage;
      partial?: AssistantMessage;
    }
  | { kind: 'thrown'; error: unknown; partial?: AssistantMessage };

/**
 * Forward one committed attempt in real time, pushing every frame to `push` as
 * it arrives. A visible delta is already in the consumer's hands, so nothing is
 * buffered: only the terminal frames are held back, and the caller releases
 * them once the attempt that produced them can no longer be resent.
 *
 * `suppressStart` drops the `start` frame of a resent attempt. pi's agent loop
 * pushes a partial into the transcript on every `start` it sees, so a second one
 * would leave the abandoned attempt in the message history.
 */
async function forwardCommittedAttempt(
  stream: AssistantMessageEventStream,
  suppressStart: boolean,
  push: (event: AssistantMessageEvent) => void,
): Promise<DrainedAttempt> {
  let partial: AssistantMessage | undefined;
  try {
    for await (const event of stream) {
      if (event.type === 'start') {
        partial = event.partial;
        if (suppressStart) continue;
      } else if ('partial' in event) {
        partial = event.partial;
      }
      if (event.type === 'error') {
        return { kind: 'error', event, message: event.error, ...(partial ? { partial } : {}) };
      }
      if (event.type === 'done') {
        return { kind: 'done', event, message: event.message };
      }
      push(event);
    }
  } catch (error) {
    return { kind: 'thrown', error, ...(partial ? { partial } : {}) };
  }
  // No terminal frame: the attempt's own result decides, exactly as before.
  return { kind: 'ended' };
}

/**
 * Classify a post-commit failure. Only a recognised transient stream
 * interruption may be resent: the request already produced output, so anything
 * deterministic, cancelled or unknown fails closed.
 */
function streamInterruptionFailure(
  drained: DrainedAttempt,
  facts: AttemptFacts,
  nowMs: number,
): { error: LLMRetryError; retryAfterMs?: number } | undefined {
  if (drained.kind !== 'error' && drained.kind !== 'thrown') return undefined;
  const final = drained.kind === 'error' ? drained.message : undefined;
  const responseStatus = facts.response?.status;
  const failureStatus =
    responseStatus !== undefined && (responseStatus < 200 || responseStatus >= 300)
      ? responseStatus
      : undefined;
  const normalized = normalizeLLMError({
    ...(drained.kind === 'thrown'
      ? { raw: drained.error }
      : facts.providerError !== undefined
        ? { raw: { message: final?.errorMessage, cause: facts.providerError } }
        : {}),
    ...(final?.stopReason ? { finishReason: final.stopReason } : {}),
    ...(final?.errorMessage ? { errorMessage: final.errorMessage } : {}),
    ...(failureStatus !== undefined ? { statusCode: failureStatus } : {}),
    explicitAbort: final?.stopReason === 'aborted',
  });
  if (!isLLMRecoverableStreamInterruption(normalized)) return undefined;
  return {
    // Fixed public wording and a numeric code only: no parameter, prompt or
    // credential from the failed attempt reaches the observer.
    error: publicRetryError(normalized, toLLMMetricErrorKind(normalized.facts)),
    retryAfterMs: failureRetryAfterMs(
      facts.response?.headers,
      [facts.providerError, drained.kind === 'thrown' ? drained.error : undefined],
      nowMs,
    ),
  };
}

/**
 * Report the abandoned attempt so the bridge can close what the consumer already
 * rendered and start the resent attempt as a new message.
 *
 * The frame carries an empty partial for pi's agent loop, which keeps the
 * abandoned attempt out of the model context, and the abandoned message itself
 * on the marker beside it, so the bridge still has the content to close.
 */
function partialStreamResetEvent(
  partial: AssistantMessage | undefined,
  model: Parameters<StreamFn>[0],
): AssistantMessageEvent {
  const cleared = clearedPartial(partial, model);
  const event: AssistantMessageEvent = {
    type: 'text_start',
    contentIndex: 0,
    partial: cleared,
  };
  Object.defineProperty(event, LLM_PARTIAL_STREAM_RESET, {
    value: { abandoned: partial ?? cleared } satisfies AbandonedStreamAttempt,
    // StreamFn composition spreads options and events, so an enumerable symbol
    // survives the wrappers while staying invisible to JSON and provider
    // payloads. Same convention as LLM_RETRY_CALL_IDENTITY.
    enumerable: true,
  });
  return event;
}

/** The same assistant message with nothing generated yet. */
function clearedPartial(
  partial: AssistantMessage | undefined,
  model: Parameters<StreamFn>[0],
): AssistantMessage {
  if (!partial) {
    return {
      role: 'assistant',
      content: [],
      api: String(model.api),
      provider: String(model.provider),
      model: String(model.id),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 0,
    } as AssistantMessage;
  }
  const cleared = { ...partial, content: [], stopReason: 'stop' as const };
  delete (cleared as { errorMessage?: string }).errorMessage;
  return cleared as AssistantMessage;
}

/** How the resent message ends when no further attempt is made after a reset. */
function endedAfterReset(
  partial: AssistantMessage | undefined,
  model: Parameters<StreamFn>[0],
  stopReason: 'aborted' | 'error',
  errorMessage: string,
): AssistantMessage {
  return { ...clearedPartial(partial, model), stopReason, errorMessage } as AssistantMessage;
}

/** Release a failed attempt's transport before waiting for the next one. */
async function releaseAttempt(failure: RetryFailure | undefined): Promise<undefined> {
  if (failure) await discardAttempt(failure);
  return undefined;
}

/**
 * Replay a pre-commit failure's own frames to the consumer. Call settlement is
 * left to the wrapper around the whole recovery stream, so this must not
 * observe it a second time.
 */
async function replayFailure(
  stream: AssistantMessageEventStream,
  suppressStart: boolean,
  push: (event: AssistantMessageEvent) => void,
): Promise<void> {
  for await (const event of stream) {
    if (suppressStart && event.type === 'start') continue;
    push(event);
  }
}

/**
 * Own a committed attempt so a stream that breaks after the consumer already saw
 * output can be resent inside the same logical call.
 *
 * The resend continues the pre-commit loop's budget, backoff, elapsed window,
 * offline wait, cancellation, observer events, request lifecycle and
 * settlement — there is no second budget. Events are forwarded as they
 * arrive; a stream-reset frame tells the consumer to close the abandoned
 * attempt before the resend, and the resent attempt's `start` frame is
 * suppressed so pi keeps a single assistant slot in the message history.
 *
 * The loop runs on its own instead of being pulled by the consumer: a
 * result-only consumer (checkpoint compaction, the title scope) never iterates,
 * and a pull-driven loop would leave `result()` pending forever.
 */
function recoveringStream(
  first: AssistantMessageEventStream,
  firstFacts: AttemptFacts,
  recovery: PartialStreamRecoveryContext,
): AssistantMessageEventStream {
  const { input, policy, state, callId, model, nowMs, random, sleep, deadlineAt } = recovery;
  const networkRecovery = recovery.networkRecovery;
  const options = recovery.options;
  const signal = options?.signal;
  const queue = createAssistantMessageEventStream();
  const push = (event: AssistantMessageEvent): void => queue.push(event);
  // The logical result is decided by the recovery itself, not by the attempt
  // that happened to commit first: the wrapper around this stream reads
  // `result()` as soon as it is built, so it must be a promise this loop
  // settles when the delivered attempt ends.
  let resolveFinal!: (message: AssistantMessage) => void;
  let rejectFinal!: (error: unknown) => void;
  const finalResult = new Promise<AssistantMessage>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  // An iterate-only consumer never attaches a handler to the logical result;
  // the rejection still reaches it through the iteration.
  void finalResult.catch(() => undefined);
  let pendingError: { readonly error: unknown } | undefined;

  let requestAttempt = recovery.requestAttempt;
  let retriesUsed = recovery.retriesUsed;
  let retryStartedAtMs = recovery.retryStartedAtMs;
  const wake = createSystemWakeLatch(networkRecovery);
  if (retryStartedAtMs !== undefined) wake.arm();
  let offlineSinceMs: number | undefined;
  let offlinePolls = 0;
  const event = (status: LLMRetryStatus, error?: LLMRetryError): LLMRetryEvent => ({
    sessionId: input.sessionId,
    turnId: input.turnId,
    callId,
    scope: input.scope,
    status,
    retryAttempt: retriesUsed,
    maxRetries: policy.maxRetries,
    requestAttempt,
    ...(error ? { error } : {}),
  });
  const beforeRequest = (
    options as
      | (Parameters<StreamFn>[2] & {
          [LLM_RETRY_BEFORE_REQUEST]?: (requestAttempt: number) => void;
        })
      | undefined
  )?.[LLM_RETRY_BEFORE_REQUEST];

  const run = async (): Promise<void> => {
    let stream = first;
    let facts = firstFacts;
    let suppressStart = false;

    for (;;) {
      const drained = await forwardCommittedAttempt(stream, suppressStart, push);
      if (drained.kind === 'done') {
        // The attempt's own result is the authority on what the provider
        // produced: a provider that fails while finalising must never be
        // reported as a success, or the agent loop would run the tools of a
        // message that does not exist.
        let physical: AssistantMessage;
        try {
          physical = await stream.result();
        } catch (error) {
          rejectFinal(error);
          throw error;
        }
        resolveFinal(physical);
        push(drained.event);
        return;
      }
      if (drained.kind === 'ended') {
        void stream.result().then(resolveFinal, rejectFinal);
        return;
      }
      // The attempt's known usage must be on the ledger before the next
      // physical request. Best effort: a broken attempt may never settle.
      if (drained.kind === 'error') await stream.result().catch(() => undefined);
      const interruption = streamInterruptionFailure(drained, facts, nowMs());
      if (!interruption || signalAborted(signal)) {
        // Fail closed exactly as before: this attempt's own terminal frame.
        if (drained.kind === 'thrown') throw drained.error;
        resolveFinal(drained.message);
        push(drained.event);
        return;
      }
      const partial = drained.partial;
      const interruptedMessage =
        drained.kind === 'error'
          ? (drained.message.errorMessage ?? PUBLIC_ERROR_MESSAGES.network)
          : asError(drained.error).message;
      let reset = false;
      const ensureReset = (): void => {
        if (reset) return;
        reset = true;
        // The consumer must close what it already rendered before the resend.
        push(partialStreamResetEvent(partial, model));
      };
      /** End the call when no further attempt is made, with the failure that ended it. */
      const giveUp = async (
        status: 'exhausted' | 'cancelled',
        error: LLMRetryError,
        last: RetryFailure | undefined,
      ): Promise<void> => {
        await notify(input.observer, event(status, error));
        if (last) {
          const delivered = terminalFailure(last);
          void delivered.result().then(resolveFinal, rejectFinal);
          await replayFailure(delivered, suppressStart, push);
          return;
        }
        if (!reset) {
          if (drained.kind === 'thrown') throw drained.error;
          resolveFinal(drained.message);
          push(drained.event);
          return;
        }
        const ended = endedAfterReset(
          partial,
          model,
          status === 'cancelled' ? 'aborted' : 'error',
          status === 'cancelled' ? PUBLIC_ERROR_MESSAGES.abort : interruptedMessage,
        );
        resolveFinal(ended);
        push({ type: 'error', reason: status === 'cancelled' ? 'aborted' : 'error', error: ended });
      };

      let error = interruption.error;
      let retryAfterMs = interruption.retryAfterMs;
      let retryReason: LLMMetricErrorKind = 'network';
      let last: RetryFailure | undefined;
      for (;;) {
        const failureAtMs = nowMs();
        if (
          networkRecovery &&
          (await isDeviceOffline(networkRecovery, model.baseUrl, retryReason, signal))
        ) {
          // An offline device is waited out instead of spending the budget, as
          // before the commit.
          offlineSinceMs ??= failureAtMs;
          if (failureAtMs - offlineSinceMs > networkRecovery.maxOfflineWaitMs) {
            await giveUp('exhausted', error, last);
            return;
          }
          retryStartedAtMs = undefined;
          offlinePolls += 1;
          last = await releaseAttempt(last);
          ensureReset();
          const offlineDelayMs = retryDelayMs(
            undefined,
            offlinePolls,
            offlinePollPolicy(policy),
            random,
          );
          await notify(input.observer, {
            ...event('waiting', error),
            retryAttempt: 0,
            requestAttempt: requestAttempt + 1,
            delayMs: offlineDelayMs,
            nextRetryAtMs: nowMs() + offlineDelayMs,
            waitingFor: 'network',
          });
          let resumed: boolean;
          try {
            const sleptFromMs = nowMs();
            resumed =
              (await sleepUntilResume(sleep, offlineDelayMs, signal, networkRecovery)) ||
              overranSystemSleep(sleptFromMs, nowMs(), offlineDelayMs);
          } catch {
            await giveUp('cancelled', error, undefined);
            return;
          }
          if (resumed) {
            offlineSinceMs = undefined;
            offlinePolls = 0;
          }
        } else {
          offlinePolls = 0;
          if (wake.take()) retryStartedAtMs = undefined;
          retryStartedAtMs ??= failureAtMs;
          wake.arm();
          const delayMs = Math.max(
            retryDelayMs(retryAfterMs, retriesUsed + 1, policy, random),
            last?.cooldownMs ?? 0,
          );
          const expired =
            deadlineAt !== undefined
              ? Date.now() + delayMs >= deadlineAt
              : failureAtMs + delayMs - retryStartedAtMs > policy.maxRetryElapsedMs;
          if (retriesUsed >= policy.maxRetries || expired) {
            await giveUp('exhausted', error, last);
            return;
          }
          state.retryTriggered = true;
          retriesUsed += 1;
          state.retryReason ??= retryReason;
          last = await releaseAttempt(last);
          ensureReset();
          await notify(input.observer, {
            ...event('waiting', error),
            requestAttempt: requestAttempt + 1,
            delayMs,
            nextRetryAtMs: nowMs() + delayMs,
          });
          try {
            const sleptFromMs = nowMs();
            await sleep(delayMs, signal);
            if (overranSystemSleep(sleptFromMs, nowMs(), delayMs)) wake.mark();
          } catch {
            await giveUp('cancelled', error, undefined);
            return;
          }
        }

        // From here on every attempt resends a message the consumer already saw
        // a `start` for, including a retry that ends before producing output.
        suppressStart = true;
        if (signalAborted(signal)) {
          await giveUp('cancelled', error, undefined);
          return;
        }
        requestAttempt += 1;
        beforeRequest?.(requestAttempt);
        await recovery.lifecycle?.beforeAttempt({ callId, requestAttempt });
        // Admission can yield while the user stops the turn: nothing is sent then.
        if (signalAborted(signal)) {
          await giveUp('cancelled', error, undefined);
          return;
        }
        state.requestAttempts = requestAttempt;
        state.providerError = undefined;
        const next = await preflightAttempt(
          recovery.inner,
          model,
          recovery.context,
          captureProviderError(options, state),
          nowMs,
          recovery.callIdentity,
          // A resend never inherits the BYOK retry-everything path: a
          // deterministic rejection or an unknown upstream error on the resent
          // attempt ends the call instead of spending the rest of the budget.
          false,
          requestAttempt,
          recovery.request.observeAttempt(requestSettledObserver(options)),
          undefined,
          {
            policy: recovery.replyGuard,
            emptyRetry: false,
            loopRetry: false,
            ...(deadlineAt !== undefined ? { deadlineAt } : {}),
          },
          { recoverStreamInterruptions: true, vetoDeterministicRejections: true },
        );
        if (next.kind === 'committed') {
          input.networkRecovery?.markReachable(model.baseUrl);
          await notify(input.observer, event('recovered'));
          stream = next.stream;
          facts = next.facts;
          break;
        }
        if (next.kind === 'terminal' || isAbortFailure(next.failure) || signalAborted(signal)) {
          const cancelled = signalAborted(signal) || isAbortFailure(next.failure);
          await giveUp(cancelled ? 'cancelled' : 'exhausted', next.failure.error, next.failure);
          return;
        }
        // A retryable pre-output failure of a resent attempt: same budget, same
        // backoff and the same offline wait. No second reset frame. It is kept
        // until the next wait, so an exhausted call still replays it.
        last = next.failure;
        error = next.failure.error;
        retryAfterMs = next.failure.retryAfterMs;
        retryReason = next.failure.retryReason;
      }
    }
  };

  void run()
    .finally(() => wake.dispose())
    .then(
      () => queue.end(),
      (error: unknown) => {
        pendingError = { error };
        rejectFinal(error);
        queue.end();
      },
    );

  return {
    [Symbol.asyncIterator]() {
      const inner = queue[Symbol.asyncIterator]();
      const iterator: AsyncIterator<AssistantMessageEvent> = {
        async next(...args) {
          const next = await inner.next(...args);
          if (next.done && pendingError) throw pendingError.error;
          return next;
        },
      };
      if (inner.return) iterator.return = inner.return.bind(inner);
      if (inner.throw) iterator.throw = inner.throw.bind(inner);
      return iterator;
    },
    result: () => finalResult,
  } as unknown as AssistantMessageEventStream;
}

function requestSettledObserver(
  options: Parameters<StreamFn>[2],
): LLMRequestSettledObserver | undefined {
  return (
    options as
      | (Parameters<StreamFn>[2] & {
          [LLM_RETRY_REQUEST_SETTLED_OBSERVER]?: LLMRequestSettledObserver;
        })
      | undefined
  )?.[LLM_RETRY_REQUEST_SETTLED_OBSERVER];
}

function notifyRequestSettled(
  observer: LLMRequestSettledObserver | undefined,
  requestAttempt: number,
  final: AssistantMessage | undefined,
  thrown: unknown,
  signal: AbortSignal | undefined,
): void {
  if (!observer) return;
  const providerUsage = readProviderUsage(final);
  try {
    observer({
      requestAttempt,
      outcome: classifyCallOutcome(final, thrown, signal?.aborted === true).outcome,
      ...(providerUsage.usage ? { usage: providerUsage.usage } : {}),
      ...(providerUsage.reportedUsage ? { reportedUsage: providerUsage.reportedUsage } : {}),
      usageComplete: providerUsage.complete,
      ...(final && typeof final.api === 'string' && typeof final.provider === 'string'
        ? { route: { api: final.api, provider: final.provider } }
        : {}),
    });
  } catch {
    // Physical-call observability must never change provider-call behavior.
  }
}

function observeRequestSettlement(
  source: AssistantMessageEventStream,
  requestAttempt: number,
  observer: LLMRequestSettledObserver | undefined,
  signal: AbortSignal | undefined,
): AssistantMessageEventStream {
  if (!observer) return source;
  let settled = false;
  const settle = (final: AssistantMessage | undefined, error?: unknown): void => {
    if (settled) return;
    settled = true;
    notifyRequestSettled(observer, requestAttempt, final, error, signal);
  };
  const result = settleResult(source, settle);
  observe(result);

  return {
    [Symbol.asyncIterator]() {
      let inner: AsyncIterator<AssistantMessageEvent>;
      try {
        inner = source[Symbol.asyncIterator]();
      } catch (error) {
        settle(undefined, error);
        throw error;
      }
      const iterator: AsyncIterator<AssistantMessageEvent> = {
        async next(...args) {
          try {
            return await inner.next(...args);
          } catch (error) {
            settle(undefined, error);
            throw error;
          }
        },
      };
      if (inner.return) iterator.return = inner.return.bind(inner);
      if (inner.throw) iterator.throw = inner.throw.bind(inner);
      return iterator;
    },
    result: () => result,
  } as unknown as AssistantMessageEventStream;
}

async function settleResult(
  source: AssistantMessageEventStream,
  settle: (final: AssistantMessage | undefined, error?: unknown) => void,
): Promise<AssistantMessage> {
  try {
    const final = await source.result();
    settle(final);
    return final;
  } catch (error) {
    settle(undefined, error);
    throw error;
  }
}

async function observe(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // The consumer-facing result retains the rejection.
  }
}

function failureResult(
  input: {
    final?: AssistantMessage;
    providerError?: unknown;
    thrown?: unknown;
    response?: ProviderResponse;
    stream?: AssistantMessageEventStream;
    iterator?: AsyncIterator<AssistantMessageEvent>;
    buffered: AssistantMessageEvent[];
    nowMs: () => number;
    retryAllErrors?: boolean;
  } & FailurePolicy,
): PreflightResult {
  // A 2xx response status only says the stream opened; a gateway that reports
  // the rejection inside the stream (an SSE `error` event after HTTP 200) has
  // no HTTP status for it. Classify such a failure by its own payload, so a
  // wrapped size rejection is not vetoed as "status 200" and resent.
  const responseStatus = input.response?.status;
  const failureStatus =
    responseStatus !== undefined && (responseStatus < 200 || responseStatus >= 300)
      ? responseStatus
      : undefined;
  const normalized = normalizeLLMError({
    ...(input.thrown !== undefined
      ? { raw: input.thrown }
      : input.providerError !== undefined
        ? { raw: { message: input.final?.errorMessage, cause: input.providerError } }
        : {}),
    ...(input.final?.stopReason ? { finishReason: input.final.stopReason } : {}),
    ...(input.final?.errorMessage ? { errorMessage: input.final.errorMessage } : {}),
    ...(failureStatus !== undefined ? { statusCode: failureStatus } : {}),
    explicitAbort: input.final?.stopReason === 'aborted',
  });
  // BYOK retries every pre-output failure because custom gateways report errors
  // inconsistently, but some failures are deterministic: a model safety refusal,
  // or a request the provider rejects as invalid (too many images, or an HTTP
  // 400 `invalid_request_error`). Retrying those only re-sends the same request,
  // repeats (and may re-bill) the rejection and delays the actionable error by
  // the whole backoff window. The deterministic check excludes anything that
  // also looks transient (timeout, network, 408/429/5xx). A context overflow,
  // by tokens or by request bytes, is left to context management as in Pi.
  // 网关 content_error 是确定的审核结论，重发同一请求只会重复结论、重复计费；
  // 要不要带引导词重发由 runner 按 action 决定，这里一律不重试（BYOK 也一样）。
  const contentReviewed =
    parseContentReviewError(input.final) !== undefined ||
    parseContentReviewError(input.thrown) !== undefined;
  // Retrying everything changes only whether to retry: the reason stays the
  // error's own classification (429 is rate_limited, 529 overloaded, a 5xx
  // server_error), so metrics and the public error do not read every BYOK
  // failure as a network one.
  const classifiedDecision = toLLMRetryDecision(normalized);
  // Custom gateways may have unclassified failures, but never override a
  // known cancellation, business limit, authentication or safety rejection.
  const terminalDecision =
    !classifiedDecision.retryable &&
    (classifiedDecision.reason === 'abort' ||
      classifiedDecision.reason === 'auth' ||
      classifiedDecision.reason === 'usage_limit' ||
      classifiedDecision.reason === 'credits_exhausted' ||
      classifiedDecision.reason === 'content_filter');
  const decision: { readonly retryable: boolean; readonly reason: LLMMetricErrorKind } =
    contentReviewed
      ? { retryable: false, reason: toLLMMetricErrorKind(normalized.facts) }
      : input.retryAllErrors &&
          !classifiedDecision.retryable &&
          !terminalDecision &&
          !isLLMDeterministicRequestRejection(normalized) &&
          !(input.final && isContextOverflow(input.final))
        ? { retryable: true, reason: classifiedDecision.reason }
        : // Opt-in hosts also resend a recognised transient stream interruption
          // that happened before any output reached the consumer. Nothing was
          // rendered, so this needs no reset frame.
          input.recoverStreamInterruptions && isLLMRecoverableStreamInterruption(normalized)
          ? { retryable: true, reason: 'network' as const }
          : input.vetoDeterministicRejections && isLLMDeterministicStreamRefusal(normalized)
            ? { retryable: false, reason: toLLMMetricErrorKind(normalized.facts) }
            : classifiedDecision;
  if (!decision.retryable) {
    return {
      kind: 'terminal',
      failure: {
        normalized,
        error: publicRetryError(normalized, decision.reason),
        stream: input.stream,
        iterator: input.iterator,
        buffered: input.buffered,
        thrown: input.thrown,
        final: input.final,
        response: input.response,
      },
    };
  }
  return {
    kind: 'failure',
    failure: {
      normalized,
      error: publicRetryError(normalized, decision.reason),
      retryReason: decision.reason,
      stream: input.stream,
      iterator: input.iterator,
      buffered: input.buffered,
      thrown: input.thrown,
      final: input.final,
      response: input.response,
      retryAfterMs: failureRetryAfterMs(
        input.response?.headers,
        [input.providerError, input.thrown],
        input.nowMs(),
      ),
      ...refusalWaitFields(input.final?.errorMessage, normalized.sanitizedMessage, input.thrown),
    },
  };
}

function isAbortFailure(failure: RetryFailure): boolean {
  return failure.normalized.facts.explicitAbort;
}

async function discardAttempt(failure: RetryFailure): Promise<void> {
  if (!failure.iterator?.return) return;
  await failure.iterator.return();
}

function terminalFailure(failure: RetryFailure): AssistantMessageEventStream {
  if (failure.streamFailure) return failure.streamFailure.handover();
  if (!failure.stream) throw asError(failure.thrown);
  if (failure.thrown !== undefined) {
    return throwingReplayStream(failure.buffered, failure.thrown);
  }
  if (!failure.iterator) throw new Error('LLM failure stream iterator is unavailable');
  return replayStream(failure.stream, failure.iterator, failure.buffered);
}

function observeTerminalFailure(
  failure: RetryFailure,
  context: CallSettlementContext,
): AssistantMessageEventStream {
  try {
    return observeCallSettlement(terminalFailure(failure), context);
  } catch (error) {
    notifyCallSettled(context, error);
    throw error;
  }
}

function observeCallSettlement(
  source: AssistantMessageEventStream,
  context: CallSettlementContext,
): AssistantMessageEventStream {
  if (!context.input.onCallSettled) return source;
  let settled = false;
  const settle = (final: AssistantMessage | undefined, error?: unknown): void => {
    if (settled) return;
    settled = true;
    notifyCallSettled(context, error, final);
  };
  const result = settleResult(source, settle);
  observe(result);

  return {
    [Symbol.asyncIterator]() {
      let inner: AsyncIterator<AssistantMessageEvent>;
      try {
        inner = source[Symbol.asyncIterator]();
      } catch (error) {
        settle(undefined, error);
        throw error;
      }
      const iterator: AsyncIterator<AssistantMessageEvent> = {
        async next(...args) {
          try {
            return await inner.next(...args);
          } catch (error) {
            settle(undefined, error);
            throw error;
          }
        },
      };
      if (inner.return) iterator.return = inner.return.bind(inner);
      if (inner.throw) iterator.throw = inner.throw.bind(inner);
      return iterator;
    },
    result: () => result,
  } as unknown as AssistantMessageEventStream;
}

function notifyCallSettled(
  context: CallSettlementContext,
  thrown?: unknown,
  final?: AssistantMessage,
): void {
  const observer = context.input.onCallSettled;
  if (!observer || context.state.settled) return;
  context.state.settled = true;
  observeObserver(observer, callSettledEvent(context, thrown, final));
}

async function observeObserver(
  observer: NonNullable<LLMRetryOptions['onCallSettled']>,
  event: LLMCallSettledEvent,
): Promise<void> {
  try {
    await observer(event);
  } catch {
    // Final-call observability must never change provider-call behavior.
  }
}

function resolvePolicy(policy: Partial<LLMRetryPolicy> | undefined): LLMRetryPolicy {
  return { ...DEFAULT_LLM_RETRY_POLICY, ...(policy ?? {}) };
}

function resolveReplyGuardPolicy(
  policy: Partial<LLMReplyGuardPolicy> | undefined,
): LLMReplyGuardPolicy {
  const merged = { ...DEFAULT_LLM_REPLY_GUARD_POLICY, ...(policy ?? {}) };
  const count = (value: number, fallback: number) =>
    Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  const d = DEFAULT_LLM_REPLY_GUARD_POLICY;
  return {
    emptyRetries: count(merged.emptyRetries, d.emptyRetries),
    holdReasoning: merged.holdReasoning === true,
    holdReasoningMaxMs: count(merged.holdReasoningMaxMs, d.holdReasoningMaxMs),
    holdReasoningMaxEvents: count(merged.holdReasoningMaxEvents, d.holdReasoningMaxEvents),
    holdReasoningMaxChars: count(merged.holdReasoningMaxChars, d.holdReasoningMaxChars),
    loopGuard: merged.loopGuard !== false,
    loopRetries: count(merged.loopRetries, d.loopRetries),
  };
}

async function notify(observer: LLMRetryOptions['observer'], event: LLMRetryEvent): Promise<void> {
  try {
    await observer?.(event);
  } catch {
    // Observability must never change provider-call correctness.
  }
}
