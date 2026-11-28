import type {
  AfterToolCallContext,
  AfterToolCallResult,
  Agent,
  AgentMessage,
  BeforeToolCallContext,
  BeforeToolCallResult,
  CustomMessage,
  ThinkingLevel,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessage,
  CacheRetention,
  Model,
  SimpleStreamOptions,
  Tool,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { NormalizedLLMError } from '@mavis/shared/llm-error-classifier';
import type { PiEventWriter } from './types.js';

export type PiBeforeLlmCallPhase = 'initial' | 'iteration';

export interface PiLlmCallRecovery {
  readonly reason: string;
  /** Provider error text of the response that was dropped. */
  readonly errorMessage: string;
  /** Request view the provider rejected, before any hook of the repeated call. */
  readonly requestMessages: readonly AgentMessage[];
  /** Host data a turn-failure hook attached to the recovery it asked for. */
  readonly detail?: unknown;
  /**
   * The repeated call sends `requestMessages` as they were sent, without
   * running any beforeLlmCall hook. Set only when the failed call had a
   * prepared request to repeat.
   */
  readonly replay?: boolean;
}

export interface PiBeforeLlmCallHookInput {
  sessionId: string;
  turnId: string;
  phase: PiBeforeLlmCallPhase;
  /**
   * Set when this call repeats a call an afterLlmCall or turn-failure hook
   * recovered from; the failed response is already gone from `messages`.
   */
  recovery?: PiLlmCallRecovery;
  /** Current provider request view after request-only hook transforms. */
  messages: AgentMessage[];
  /** Current durable history, updated only by canonical replacements. */
  canonicalMessages: AgentMessage[];
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  /** Host-owned serialized request cap used by final context admission. */
  maxSerializedInputBytes?: number;
  cacheRetention?: CacheRetention;
  /** Host-composed auxiliary provider stream (for example auto compaction). */
  streamFn?: StreamFn;
  /**
   * 本轮真实 provider 请求发出前应用的 onPayload transform 链（例如
   * local-runtime 的 video patcher / openplatform thinking patcher）。
   * hook 若要对 provider payload 做 token 计数等同形操作，必须先把它
   * 应用到自建 body 上，否则计数对象与实际发出的请求不同形。
   */
  payloadTransform?: SimpleStreamOptions['onPayload'];
  /** Provider payload transform for hook-owned auxiliary LLM calls. */
  auxiliaryPayloadTransform?: SimpleStreamOptions['onPayload'];
  /** Composed system prompt for this turn. */
  systemPrompt?: string;
  /** Provider-bound tool declarations for this turn. */
  tools?: Tool[];
  thinkingLevel: ThinkingLevel;
  signal?: AbortSignal;
  eventWriter?: PiEventWriter;
  eventIdGenerator?: (kind: string) => string;
  runtimeSeqGenerator?: () => number;
}

export interface PiBeforeLlmCallReplaceMetadata {
  replacementId: string;
  strategyVersion: string;
  summary: string;
  compactedMessages: AgentMessage[];
  keptMessages: AgentMessage[];
  firstKeptIndex: number;
  tokensBefore?: number;
  tokensAfter?: number;
  messagesBefore?: number;
  messagesAfter?: number;
  /**
   * Explicit output-to-input lineage for technical replacements. Each output
   * message points at the index whose canonical identity it preserves.
   */
  replacementSourceIndexes?: number[];
  /** Reserved lineage for a placement-owned exact current-user tail. */
  currentUserSourceIndex?: number;
  /**
   * Reserved count of hidden markers placed immediately before the
   * placement-owned current-user tail. Maintained by the runner alongside
   * `currentUserSourceIndex`; hooks must not set it. Absent means 1 when
   * `currentUserSourceIndex` is present, keeping older persisted metadata valid.
   */
  placedMarkerCount?: number;
}

export type PiBeforeLlmCallAppendMessage = Omit<CustomMessage, 'content' | 'display'> & {
  content: string;
  display: false;
};

export type PiAfterLlmReplacementCommit = () =>
  | Promise<PiBeforeLlmCallAppendMessage | undefined>
  | PiBeforeLlmCallAppendMessage
  | undefined;

export type PiBeforeLlmCallHookDecision =
  | { type: 'continue' }
  | { type: 'skip'; reason: string }
  | { type: 'respond'; reason: string; text: string }
  | {
      /** Replaces only the current Provider request context, never canonical history. */
      type: 'replaceRequestMessages';
      messages: AgentMessage[];
      reason: string;
    }
  | {
      type: 'replaceMessages';
      messages: AgentMessage[];
      metadata: PiBeforeLlmCallReplaceMetadata;
      /** Runs after durable history replacement and before the Provider request. */
      afterCommit?: PiAfterLlmReplacementCommit;
    }
  | {
      /**
       * Durably appends one hidden typed context message before the Provider request.
       * Appends accumulate: later hooks still run and receive the registered
       * markers in `messages` and `canonicalMessages`. All markers are committed
       * once after the pipeline (placed markers inside the durable replacement,
       * tail markers in registration order with one history flush). A durable
       * `replaceMessages` after a registered append aborts the request.
       */
      type: 'appendMessage';
      message: PiBeforeLlmCallAppendMessage;
      reason: string;
      /** Initial-compaction-only placement for a Host marker before the current real user. */
      placement?: 'before-current-user';
    }
  | { type: 'abort'; reason: string };

export type PiBeforeLlmCallHook = (
  input: PiBeforeLlmCallHookInput,
) => Promise<PiBeforeLlmCallHookDecision | undefined> | PiBeforeLlmCallHookDecision | undefined;

/**
 * Final main-agent request view, observed after every before-LLM decision has
 * settled and immediately before the logical provider call starts.
 *
 * Unlike `PiBeforeLlmCallHook`, this hook cannot transform or stop a request
 * and deliberately omits transport credentials and provider functions.
 */
export interface PiLlmCallPreparedHookInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly phase: PiBeforeLlmCallPhase;
  readonly scope: 'agent';
  readonly messages: readonly AgentMessage[];
  readonly model: Model<Api>;
  readonly maxTokens?: number;
  readonly hostMaxOutputTokens?: number;
  readonly maxSerializedInputBytes?: number;
  readonly cacheRetention?: CacheRetention;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly thinkingLevel: ThinkingLevel;
  readonly signal?: AbortSignal;
}

/**
 * What an observer of a prepared main request may ask for: `onPayload` sees
 * the provider body of each attempt once the request's own payload transform
 * has run. It observes only; its failures never reach the request.
 */
export interface PiLlmCallPreparedObservation {
  readonly onPayload?: (payload: unknown) => void;
}

export type PiOnLlmCallPreparedHook = (
  input: PiLlmCallPreparedHookInput,
) => Promise<PiLlmCallPreparedObservation | void> | PiLlmCallPreparedObservation | void;

export interface PiAfterLlmCallHookInput {
  sessionId: string;
  turnId: string;
  /** Assistant response, before Pi selects and executes any tool calls it contains. */
  message: AssistantMessage;
  /** Current transcript projection, including `message`. */
  messages: readonly AgentMessage[];
  signal?: AbortSignal;
}

export type PiAfterLlmCallHookDecision =
  | { type: 'continue' }
  /**
   * Replaces an assistant message's text before completed-message delivery.
   *
   * PiTurnRunner applies this at assistant message_end, before EventBridge
   * emits the completed message and before onHistoryChangedHook receives the
   * message delta. Both downstream paths therefore observe the replacement
   * text, never the original assistant text.
   *
   * The runner puts one replacement text block where the first existing text
   * block was and drops the other text blocks. A response without text gets
   * the replacement in front of its first toolCall block, or at the end when
   * it has none. Every non-text block keeps its order, including pending
   * toolCall blocks; the message is persisted and resent as is, so the text
   * never moves behind a tool call. A response whose only text block already
   * holds the replacement text is left unchanged.
   *
   * Pi selects the preserved tool calls after listeners settle, so
   * replaceText changes only the delivered text; it does not block tool
   * execution.
   *
   * Use retry or fail to reject a response and prevent its pending tool calls
   * from causing side effects. Use the tool hooks for per-tool control.
   */
  | { type: 'replaceText'; text: string }
  | { type: 'retry'; reason: string; prompt: string }
  /**
   * Keeps a final assistant response (one without tool calls) and asks the
   * model once more with `prompt` as a user message, so the Turn continues
   * instead of ending. Ignored for a response with tool calls or an error
   * response. The hook decides how often it asks; the runner never repeats it.
   */
  | { type: 'followUp'; reason: string; prompt: string }
  /**
   * Drops a provider error response and repeats the same provider request
   * once per LLM call. Only honoured for `stopReason: 'error'`; the repeated
   * call's beforeLlmCall input carries `recovery` so a hook can shrink the
   * context first. Ignored for other responses or when the repeated request
   * fails again.
   */
  | { type: 'recover'; reason: string }
  | { type: 'fail'; reason: string };

export type PiAfterLlmCallHook = (
  input: PiAfterLlmCallHookInput,
) => Promise<PiAfterLlmCallHookDecision | undefined> | PiAfterLlmCallHookDecision | undefined;

/** Why a Turn is about to end as failed. */
export type PiTurnFailure =
  /** The provider (or the host while preparing the call) reported an error response. */
  | {
      readonly kind: 'provider_error';
      readonly errorMessage: string;
      /** The transport's classification of the final attempt, when it observed one. */
      readonly normalized?: NormalizedLLMError;
    }
  /** An afterLlmCall hook rejected the response with `fail`. */
  | { readonly kind: 'response_rejected'; readonly reason: string }
  /** An afterLlmCall hook threw. */
  | { readonly kind: 'hook_error'; readonly errorMessage: string };

export interface PiTurnFailureHookInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly failure: PiTurnFailure;
  /** The failed response; its tool calls never run. */
  readonly message: AssistantMessage;
  /** Request view of the failed call; absent when the call failed before one was prepared. */
  readonly requestMessages?: readonly AgentMessage[];
  readonly signal?: AbortSignal;
  /**
   * False when a `recover` would be refused: the Turn's history could not be
   * delivered, or its turn-failure recoveries are used up. `restore` still applies.
   */
  readonly recoverable: boolean;
}

export type PiTurnFailureHookDecision =
  /** Leave the failure to the next hook, or let the Turn fail. */
  | { type: 'continue' }
  /**
   * Drop the failed response and repeat the call. The repeated call's
   * beforeLlmCall input carries `recovery` with `reason` and `detail`; with
   * `replay`, the failed request is sent again as it was, without hooks.
   */
  | { type: 'recover'; reason: string; detail?: unknown; replay?: boolean }
  /**
   * End the Turn with the failure the latest `recover` replaced, instead of
   * this one: the repeated call failed for a reason of the host's own.
   */
  | { type: 'restore' };

/**
 * Consulted once when the Turn is about to end as failed: after every
 * afterLlmCall recovery is spent, never for a stopped Turn. Other sessions
 * register none and keep their failure semantics.
 */
export type PiTurnFailureHook = (
  input: PiTurnFailureHookInput,
) => Promise<PiTurnFailureHookDecision | undefined> | PiTurnFailureHookDecision | undefined;

/** blockedBy is trusted admission provenance, observed in this step only. */
export type PiBeforeToolCallHook = (
  toolContext: BeforeToolCallContext,
  signal?: AbortSignal,
) =>
  | Promise<(BeforeToolCallResult & { readonly blockedBy?: 'permission' }) | undefined>
  | (BeforeToolCallResult & { readonly blockedBy?: 'permission' })
  | undefined;

export type PiAfterToolCallHook = (
  toolContext: AfterToolCallContext,
  signal?: AbortSignal,
) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;

export type PiHistoryChangeReason = 'messageDelta' | 'replaceMessages';

export interface PiHistoryChangedHookInput {
  sessionId: string;
  turnId: string;
  reason: PiHistoryChangeReason;
  /**
   * For `messageDelta`, the new messages since the previous notification.
   * For `replaceMessages`, the full replacement history currently in Pi state.
   */
  messages: AgentMessage[];
  /** Previous full history, only populated for `replaceMessages`. */
  previousMessages?: AgentMessage[];
  /** Replacement metadata, only populated for `replaceMessages`. */
  metadata?: PiBeforeLlmCallReplaceMetadata;
  /**
   * `messageDelta` only: the display `msg_id` the event stream carried for an
   * assistant message of {@link messages}, by its index there. Present only
   * when at least one assistant message has one; a message whose id
   * allocation failed, or that ended aborted, has none.
   */
  assistantMessageIds?: readonly PiAssistantMessageId[];
}

export interface PiAssistantMessageId {
  readonly index: number;
  readonly messageId: string;
}

export type PiOnHistoryChangedHook = (input: PiHistoryChangedHookInput) => Promise<void> | void;

/** Fires after permission/pre-tool admission, immediately before tool execution. */
export type PiToolExecutionStartHook = (input: BeforeToolCallContext) => void;

export interface PiStepEndHookInput {
  agent: Agent;
  message: AgentMessage;
  toolResults: ToolResultMessage[];
  signal: AbortSignal;
  /** Trusted admission interceptions for this step only; never inferred from tool output. */
  readonly blockedToolCalls?: readonly {
    readonly toolCallId: string;
    readonly blockedBy: 'permission';
  }[];
}

/** @deprecated Use `PiStepEndHookInput`; this payload is emitted per pi step. */
export type PiTurnEndHookInput = PiStepEndHookInput;

/**
 * Fires when a single pi turn ends (one LLM assistant response + its tool
 * execution). Per the agent-runtime design doc §11 that unit is called a
 * "step" — a full `agent.run()` invocation (which the daemon exposes as a
 * "turn") wraps N of these. Preferred name for the step-boundary hook per
 * §11.6 Step A.
 */
export type PiOnStepEndHook = (input: PiStepEndHookInput) => Promise<void> | void;

/** @deprecated Use `PiOnStepEndHook`; this hook fires once per pi step. */
export type PiOnTurnEndHook = PiOnStepEndHook;

export interface PiTurnHooks {
  beforeLlmCallHook?: readonly PiBeforeLlmCallHook[];
  /** Best-effort observers of actual logical main-agent provider calls. */
  onLlmCallPreparedHook?: readonly PiOnLlmCallPreparedHook[];
  afterLlmCallHook?: readonly PiAfterLlmCallHook[];
  turnFailureHook?: readonly PiTurnFailureHook[];
  beforeToolCallHook?: readonly PiBeforeToolCallHook[];
  onToolExecutionStartHook?: readonly PiToolExecutionStartHook[];
  afterToolCallHook?: readonly PiAfterToolCallHook[];
  onHistoryChangedHook?: readonly PiOnHistoryChangedHook[];
  /**
   * Step-boundary hook (fires per LLM step). Filled by agent-runtime and read
   * by `PiTurnRunner`. See `PiOnStepEndHook` docstring for the vocabulary.
   */
  onStepEndHook?: readonly PiOnStepEndHook[];
  /** @deprecated Use `onStepEndHook`; retained for legacy per-step consumers. */
  onTurnEndHook?: readonly PiOnTurnEndHook[];
}
