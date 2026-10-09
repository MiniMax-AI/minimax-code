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
import type { PiEventWriter } from './types.js';

export type PiBeforeLlmCallPhase = 'initial' | 'iteration';

export interface PiBeforeLlmCallHookInput {
  sessionId: string;
  turnId: string;
  phase: PiBeforeLlmCallPhase;
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
   * The onPayload transform chain applied before this turn's actual provider request (e.g.
   * local-runtime's video patcher / openplatform thinking patcher). Hooks performing
   * payload-sensitive operations such as token counting must apply it to their constructed body
   * first; otherwise, the counted payload differs from the request actually sent.
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
       * A successful append ends the before-LLM decision pipeline.
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

export type PiOnLlmCallPreparedHook = (input: PiLlmCallPreparedHookInput) => Promise<void> | void;

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
   * The runner removes every existing text block and appends one replacement
   * text block. It preserves every non-text block in order, including pending
   * toolCall blocks. Pi selects those preserved tool calls after listeners
   * settle, so replaceText changes only the delivered text; it does not block
   * tool execution.
   *
   * Use retry or fail to reject a response and prevent its pending tool calls
   * from causing side effects. Use the tool hooks for per-tool control.
   */
  | { type: 'replaceText'; text: string }
  | { type: 'retry'; reason: string; prompt: string }
  | { type: 'fail'; reason: string };

export type PiAfterLlmCallHook = (
  input: PiAfterLlmCallHookInput,
) => Promise<PiAfterLlmCallHookDecision | undefined> | PiAfterLlmCallHookDecision | undefined;

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
