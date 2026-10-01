import type { Agent, AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import { streamSimple, type CacheRetention, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { LLM_REQUEST_TIMEOUT_MS } from './defaults.js';
import type {
  PiAfterLlmReplacementCommit,
  PiBeforeLlmCallAppendMessage,
  PiBeforeLlmCallReplaceMetadata,
} from './hooks.js';
import type { LLMModelConfig } from './types.js';
import type { turnHistory } from './history.js';
import type { turnState } from './turn.js';

export function composeStreamFn(resolved: LLMModelConfig): StreamFn {
  // Order matters: each wrapper only fills the option it owns, while
  // explicit per-call options from upstream wrappers still win. The host
  // ceiling is the exception and therefore the innermost link: it has to see
  // the fully accumulated options in order to shrink them.
  const callerHeaders =
    resolved.headers && Object.keys(resolved.headers).length > 0 ? resolved.headers : undefined;
  const hostClamped = withHostMaxOutputTokens(resolved.streamFn, resolved.hostMaxOutputTokens);
  const cacheWrapped = withCacheRetention(hostClamped, resolved.cacheRetention);
  const maxTokensWrapped =
    typeof resolved.maxTokens === 'number' && resolved.maxTokens > 0
      ? withMaxTokens(cacheWrapped, resolved.maxTokens)
      : cacheWrapped;
  const headerWrapped = callerHeaders
    ? withHeaders(maxTokensWrapped, callerHeaders)
    : maxTokensWrapped;
  const fetchWrapped = resolved.fetch ? withFetch(headerWrapped, resolved.fetch) : headerWrapped;
  return wrapStreamFnWithTimeout(fetchWrapped, LLM_REQUEST_TIMEOUT_MS);
}

export function setLLMHook(agent: Agent, turn: turnState, history: turnHistory): void {
  if (turn.hooks.beforeLLM.length === 0 && turn.hooks.afterLLM.length === 0) return;

  let checkpointCallCount = 0;
  agent.transformContext = async (messages, signal) => {
    const rejectedMessages = messages.filter((message) =>
      turn.rejectedAssistantMessages.has(message),
    );
    if (rejectedMessages.length > 0) {
      messages.splice(
        0,
        messages.length,
        ...messages.filter((message) => !turn.rejectedAssistantMessages.has(message)),
      );
      for (const message of rejectedMessages) turn.rejectedAssistantMessages.delete(message);
    }

    if (turn.hooks.beforeLLM.length === 0) return messages;
    const phase = checkpointCallCount === 0 ? 'initial' : 'iteration';
    checkpointCallCount += 1;
    const checkpoint = await runBeforeLLM(turn, messages, phase, signal);
    if (checkpoint.type === 'abort') {
      turn.metrics.tryRecordTerminalFailure({
        errorSource: 'before_llm_hook',
        errorKind: 'hook_error',
      });
      throw new Error(`before_llm_checkpoint_aborted: ${checkpoint.reason}`);
    }
    if (checkpoint.type === 'respond') {
      turn.syntheticResponse.pending = {
        text: checkpoint.text,
        reason: checkpoint.reason,
      };
      return messages;
    }
    if (checkpoint.type === 'requestOnly') {
      return checkpoint.messages;
    }
    if (checkpoint.type !== 'replace' && checkpoint.type !== 'append') return messages;

    const replacement =
      checkpoint.type === 'replace'
        ? {
            messages: checkpoint.durableMessages,
            metadata: checkpoint.metadata,
            ...(checkpoint.afterCommit ? { afterCommit: checkpoint.afterCommit } : {}),
          }
        : checkpoint.durableReplacement;
    if (replacement) {
      // Pi passes the provider-bound context array into transformContext, but
      // Agent.state.messages is the transcript later event reducers read. A
      // request-only hook may further filter the Provider copy after a durable
      // replacement, so persist the durable snapshot independently.
      const previousMessages = [...agent.state.messages];
      messages.splice(0, messages.length, ...replacement.messages);
      agent.state.messages = replacement.messages;
      try {
        await history.replace(replacement.messages, previousMessages, replacement.metadata);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`before_llm_checkpoint_persistence_failed: ${message}`);
      }
      const postCommitMessage = await replacement.afterCommit?.();
      if (postCommitMessage) {
        const invalidAppendReason = validAppendMessage(postCommitMessage);
        if (invalidAppendReason) {
          throw new Error(`after_commit append message invalid: ${invalidAppendReason}`);
        }
        const appendMessage = checkpoint.type === 'append' ? checkpoint.messages.at(-1) : undefined;
        checkpoint.messages = appendMessage
          ? [...checkpoint.messages.slice(0, -1), postCommitMessage, appendMessage]
          : [...checkpoint.messages, postCommitMessage];
        messages.push(postCommitMessage);
        agent.state.messages = [...agent.state.messages, postCommitMessage];
        await history.flushTail();
      }
    }

    if (checkpoint.type === 'replace') return checkpoint.messages;

    messages.push(...checkpoint.tailMessages);
    agent.state.messages = [...agent.state.messages, ...checkpoint.tailMessages];
    try {
      await history.flushTail();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`before_llm_append_persistence_failed: ${message}`);
    }
    return checkpoint.messages;
  };
}

async function runBeforeLLM(
  turn: turnState,
  messages: AgentMessage[],
  phase: 'initial' | 'iteration',
  signal?: AbortSignal,
): Promise<
  | { type: 'unchanged'; messages: AgentMessage[] }
  | { type: 'requestOnly'; messages: AgentMessage[] }
  | {
      type: 'replace';
      messages: AgentMessage[];
      durableMessages: AgentMessage[];
      metadata: PiBeforeLlmCallReplaceMetadata;
      afterCommit?: PiAfterLlmReplacementCommit;
    }
  | {
      type: 'append';
      messages: AgentMessage[];
      message: PiBeforeLlmCallAppendMessage;
      tailMessages: AgentMessage[];
      durableReplacement?: {
        messages: AgentMessage[];
        metadata: PiBeforeLlmCallReplaceMetadata;
        afterCommit?: PiAfterLlmReplacementCommit;
      };
    }
  | { type: 'respond'; text: string; reason: string }
  | { type: 'abort'; reason: string }
> {
  const initialCurrentUser = captureInitialCurrentUser(messages, phase);
  let currentMessages = [...messages];
  let canonicalMessages = [...messages];
  let requestMessagesReplaced = false;
  let durableReplacement:
    | {
        messages: AgentMessage[];
        metadata: PiBeforeLlmCallReplaceMetadata;
        afterCommit?: PiAfterLlmReplacementCommit;
      }
    | undefined;
  for (const hook of turn.hooks.beforeLLM) {
    let decision: Awaited<ReturnType<typeof hook>>;
    try {
      decision = await hook({
        sessionId: turn.input.sessionId,
        turnId: turn.input.turnId,
        phase,
        messages: [...currentMessages],
        canonicalMessages: [...canonicalMessages],
        model: turn.llm.model,
        apiKey: turn.llm.apiKey,
        ...(turn.llm.headers && Object.keys(turn.llm.headers).length > 0
          ? { headers: { ...turn.llm.headers } }
          : {}),
        ...(typeof turn.llm.maxTokens === 'number' && turn.llm.maxTokens > 0
          ? { maxTokens: turn.llm.maxTokens }
          : {}),
        ...(turn.llm.maxSerializedInputBytes === undefined
          ? {}
          : { maxSerializedInputBytes: turn.llm.maxSerializedInputBytes }),
        ...(turn.llm.cacheRetention ? { cacheRetention: turn.llm.cacheRetention } : {}),
        ...(turn.auxiliaryStreamFn ? { streamFn: turn.auxiliaryStreamFn } : {}),
        ...(turn.llm.payloadTransform ? { payloadTransform: turn.llm.payloadTransform } : {}),
        ...(turn.llm.auxiliaryPayloadTransform
          ? { auxiliaryPayloadTransform: turn.llm.auxiliaryPayloadTransform }
          : {}),
        systemPrompt: turn.input.systemPrompt,
        tools: turn.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        thinkingLevel: turn.thinkingLevel,
        signal,
        eventWriter: turn.writer,
        eventIdGenerator: turn.nextEventId,
        runtimeSeqGenerator: turn.nextRuntimeSeq,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      turn.logger.error(
        {
          session_id: turn.input.sessionId,
          turn_id: turn.input.turnId,
          phase,
          error: message,
        },
        '[pi-turn-runner] beforeLlmCall hook threw; aborting provider call to keep context lifecycle fail-closed',
      );
      return { type: 'abort', reason: message };
    }
    if (!decision || decision.type === 'continue') continue;
    if (decision.type === 'skip') {
      if (typeof decision.reason !== 'string') {
        turn.logger.warn(
          {
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            phase,
            reason_type: typeof decision.reason,
          },
          '[pi-turn-runner] before_llm_skip_reason_invalid; continuing provider call',
        );
        continue;
      }
      if (decision.reason.startsWith('context_lifecycle_')) {
        turn.logger.warn(
          {
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            phase,
            reason: decision.reason,
          },
          '[pi-turn-runner] beforeLlmCall skipped context lifecycle replacement',
        );
      }
      continue;
    }
    if (decision.type === 'abort') {
      turn.logger.error(
        {
          session_id: turn.input.sessionId,
          turn_id: turn.input.turnId,
          phase,
          reason: decision.reason,
        },
        '[pi-turn-runner] beforeLlmCall aborted provider call',
      );
      return { type: 'abort', reason: decision.reason };
    }
    if (decision.type === 'respond') {
      if (typeof decision.text !== 'string' || decision.text.length === 0) {
        return { type: 'abort', reason: 'beforeLlmCall trusted response must be non-empty' };
      }
      turn.logger.info(
        {
          session_id: turn.input.sessionId,
          turn_id: turn.input.turnId,
          phase,
          reason: decision.reason,
        },
        '[pi-turn-runner] beforeLlmCall supplied a trusted response',
      );
      return { type: 'respond', text: decision.text, reason: decision.reason };
    }
    if (decision.type === 'replaceRequestMessages') {
      if (typeof decision.reason !== 'string' || decision.reason.length === 0) {
        return {
          type: 'abort',
          reason: 'beforeLlmCall request replacement reason must be non-empty',
        };
      }
      currentMessages = [...decision.messages];
      requestMessagesReplaced = true;
      turn.logger.info(
        {
          session_id: turn.input.sessionId,
          turn_id: turn.input.turnId,
          phase,
          reason: decision.reason,
        },
        '[pi-turn-runner] beforeLlmCall replaced request messages',
      );
      continue;
    }
    if (decision.type === 'appendMessage') {
      const invalidAppendReason = validAppendMessage(decision.message);
      if (typeof decision.reason !== 'string' || decision.reason.trim().length === 0) {
        return { type: 'abort', reason: 'beforeLlmCall append reason must be non-empty' };
      }
      if (invalidAppendReason) {
        return {
          type: 'abort',
          reason: `beforeLlmCall append message invalid: ${invalidAppendReason}`,
        };
      }
      if (decision.placement === 'before-current-user') {
        const placement = placeBeforeCurrentUser({
          phase,
          initialMessages: messages,
          initialCurrentUser,
          currentMessages,
          durableReplacement,
          marker: decision.message,
        });
        if (typeof placement === 'string') {
          turn.logger.error(
            {
              session_id: turn.input.sessionId,
              turn_id: turn.input.turnId,
              phase,
              reason: placement,
            },
            '[pi-turn-runner] beforeLlmCall placement aborted provider call',
          );
          return { type: 'abort', reason: placement };
        }
        if (placement.type === 'defer') continue;
        if (placement.type === 'placed') {
          return {
            type: 'append',
            messages: placement.messages,
            message: decision.message,
            tailMessages: [],
            durableReplacement: placement.durableReplacement,
          };
        }
        // 'tail': a continuation has no current user to precede, so the ordinary
        // tail append already keeps real user input last.
      }
      return {
        type: 'append',
        messages: [...currentMessages, decision.message],
        message: decision.message,
        tailMessages: [decision.message],
        ...(durableReplacement ? { durableReplacement } : {}),
      };
    }
    const invalidReplacementReason = validReplacement(decision.metadata);
    if (invalidReplacementReason) {
      const reason = `beforeLlmCall replacement metadata invalid: ${invalidReplacementReason}`;
      turn.logger.error(
        {
          session_id: turn.input.sessionId,
          turn_id: turn.input.turnId,
          phase,
          reason,
        },
        '[pi-turn-runner] beforeLlmCall replacement rejected',
      );
      return { type: 'abort', reason };
    }
    currentMessages = [...decision.messages];
    canonicalMessages = [...decision.messages];
    durableReplacement = {
      messages: currentMessages,
      metadata: decision.metadata,
      ...(decision.afterCommit ? { afterCommit: decision.afterCommit } : {}),
    };
    turn.logger.info(
      {
        session_id: turn.input.sessionId,
        turn_id: turn.input.turnId,
        phase,
        replacement_id: decision.metadata.replacementId,
        strategy_version: decision.metadata.strategyVersion,
        summary_length: decision.metadata.summary.length,
        first_kept_index: decision.metadata.firstKeptIndex,
        ...(decision.metadata.tokensBefore === undefined
          ? {}
          : { tokens_before: decision.metadata.tokensBefore }),
        ...(decision.metadata.tokensAfter === undefined
          ? {}
          : { tokens_after: decision.metadata.tokensAfter }),
        ...(decision.metadata.messagesBefore === undefined
          ? {}
          : { messages_before: decision.metadata.messagesBefore }),
        ...(decision.metadata.messagesAfter === undefined
          ? {}
          : { messages_after: decision.metadata.messagesAfter }),
      },
      '[pi-turn-runner] beforeLlmCall replaced context messages',
    );
  }
  if (durableReplacement) {
    return {
      type: 'replace',
      messages: currentMessages,
      durableMessages: durableReplacement.messages,
      metadata: durableReplacement.metadata,
      ...(durableReplacement.afterCommit ? { afterCommit: durableReplacement.afterCommit } : {}),
    };
  }
  return requestMessagesReplaced
    ? { type: 'requestOnly', messages: currentMessages }
    : { type: 'unchanged', messages };
}

function captureInitialCurrentUser(
  messages: readonly AgentMessage[],
  phase: 'initial' | 'iteration',
): AgentMessage | undefined {
  if (phase !== 'initial') return undefined;
  const candidate = messages.at(-1);
  if (candidate?.role !== 'user') return undefined;
  return messages.filter((message) => message === candidate).length === 1 ? candidate : undefined;
}

function placeBeforeCurrentUser(input: {
  readonly phase: 'initial' | 'iteration';
  readonly initialMessages: readonly AgentMessage[];
  readonly initialCurrentUser: AgentMessage | undefined;
  readonly currentMessages: readonly AgentMessage[];
  readonly durableReplacement:
    | { readonly messages: AgentMessage[]; readonly metadata: PiBeforeLlmCallReplaceMetadata }
    | undefined;
  readonly marker: PiBeforeLlmCallAppendMessage;
}):
  | string
  | { readonly type: 'defer' }
  | { readonly type: 'tail' }
  | {
      readonly type: 'placed';
      readonly messages: AgentMessage[];
      readonly durableReplacement: {
        readonly messages: AgentMessage[];
        readonly metadata: PiBeforeLlmCallReplaceMetadata;
      };
    } {
  if (input.phase !== 'initial') return 'before-current-user requires the initial phase';
  if (!input.durableReplacement) return { type: 'defer' };
  const currentUser = input.initialCurrentUser;
  if (!currentUser) {
    // Continuation re-enters from history that can end with a tool round; with
    // no real user at the tail there is nothing to precede. Aborting here would
    // discard the durable replacement (e.g. a finished compaction) every retry.
    if (input.initialMessages.at(-1)?.role !== 'user') return { type: 'tail' };
    return 'before-current-user could not locate one current real user';
  }
  const sourceIndex = input.initialMessages.length - 1;
  const sourceIndexes = input.durableReplacement.metadata.replacementSourceIndexes;
  const durableMatches = input.durableReplacement.messages.flatMap((message, index) =>
    message === currentUser || sourceIndexes?.[index] === sourceIndex ? [index] : [],
  );
  if (new Set(durableMatches).size > 1) {
    return 'before-current-user located multiple replacement users';
  }
  const durableUserIndex = durableMatches[0];
  const currentMatches = input.currentMessages.flatMap((message, index) =>
    message === currentUser || index === durableUserIndex ? [index] : [],
  );
  if (new Set(currentMatches).size > 1) {
    return 'before-current-user located multiple request users';
  }
  const currentUserIndex = currentMatches[0];
  const requestBase = input.currentMessages.filter((_message, index) => index !== currentUserIndex);
  const durableBase = input.durableReplacement.messages.filter(
    (_message, index) => index !== durableUserIndex,
  );
  const durableMessages = [...durableBase, input.marker, currentUser];
  return {
    type: 'placed',
    messages: [...requestBase, input.marker, currentUser],
    durableReplacement: {
      messages: durableMessages,
      metadata: withCurrentUserTailMetadata(
        input.durableReplacement.metadata,
        durableUserIndex,
        durableMessages.length,
        sourceIndex,
      ),
    },
  };
}

function withCurrentUserTailMetadata(
  metadata: PiBeforeLlmCallReplaceMetadata,
  removedIndex: number | undefined,
  messagesAfter: number,
  currentUserSourceIndex: number,
): PiBeforeLlmCallReplaceMetadata {
  const replacementSourceIndexes =
    removedIndex === undefined
      ? metadata.replacementSourceIndexes
      : metadata.replacementSourceIndexes?.filter((_sourceIndex, index) => index !== removedIndex);
  return {
    ...metadata,
    messagesAfter,
    currentUserSourceIndex,
    ...(replacementSourceIndexes === undefined ? {} : { replacementSourceIndexes }),
  };
}

function validAppendMessage(message: PiBeforeLlmCallAppendMessage): string | undefined {
  if (!message || typeof message !== 'object') return 'message is required';
  if (message.role !== 'custom') return 'role must be custom';
  if (message.display !== false) return 'display must be false';
  if (typeof message.customType !== 'string' || message.customType.trim().length === 0) {
    return 'customType must be non-empty';
  }
  if (typeof message.content !== 'string' || message.content.trim().length === 0) {
    return 'content must be non-empty text';
  }
  if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) {
    return 'timestamp must be finite';
  }
  return undefined;
}

function validReplacement(metadata: PiBeforeLlmCallReplaceMetadata): string | undefined {
  if (!metadata || typeof metadata !== 'object') return 'metadata is required';
  if (Object.hasOwn(metadata, 'currentUserSourceIndex')) {
    return 'currentUserSourceIndex is reserved for placement';
  }
  if (!metadata.replacementId) return 'replacementId is required';
  if (!metadata.strategyVersion) return 'strategyVersion is required';
  if (typeof metadata.summary !== 'string') return 'summary is required';
  if (!Array.isArray(metadata.compactedMessages)) return 'compactedMessages is required';
  if (!Array.isArray(metadata.keptMessages)) return 'keptMessages is required';
  if (
    typeof metadata.firstKeptIndex !== 'number' ||
    !Number.isInteger(metadata.firstKeptIndex) ||
    metadata.firstKeptIndex < 0
  ) {
    return 'firstKeptIndex must be a non-negative integer';
  }
  return undefined;
}

function withCacheRetention(
  inner: StreamFn | undefined,
  cacheRetention: CacheRetention | undefined,
): StreamFn {
  const base = inner ?? streamSimple;
  return ((model, context, options) => {
    const mergedOptions: SimpleStreamOptions =
      cacheRetention !== undefined
        ? { ...(options ?? {}), cacheRetention: options?.cacheRetention ?? cacheRetention }
        : (options ?? {});
    return base(model, context, mergedOptions);
  }) as StreamFn;
}

function withHeaders(inner: StreamFn | undefined, headers: Record<string, string>): StreamFn {
  const base = inner ?? streamSimple;
  return ((model, context, options) => {
    const mergedHeaders: Record<string, string> = {
      ...headers,
      ...(options?.headers ?? {}),
    };
    return base(model, context, {
      ...(options ?? {}),
      headers: mergedHeaders,
    });
  }) as StreamFn;
}

function withFetch(inner: StreamFn | undefined, fetch: SimpleStreamOptions['fetch']): StreamFn {
  const base = inner ?? streamSimple;
  return ((model, context, options) => {
    return base(model, context, {
      ...(options ?? {}),
      fetch: options?.fetch ?? fetch,
    });
  }) as StreamFn;
}

function withMaxTokens(inner: StreamFn | undefined, maxTokens: number): StreamFn {
  const base = inner ?? streamSimple;
  return ((model, context, options) => {
    return base(model, context, {
      ...(options ?? {}),
      maxTokens:
        options && typeof options.maxTokens === 'number' && options.maxTokens > 0
          ? options.maxTokens
          : maxTokens,
    });
  }) as StreamFn;
}

/**
 * Binds a host-owned output ceiling to every provider request of this turn.
 *
 * `withMaxTokens` fills a default and steps aside once anything upstream has
 * an opinion; a ceiling cannot work that way. This one takes the smallest of
 * the host cap, whatever the request already asked for, and the model's own
 * cap, so a provider that allows less still wins and nothing downstream can
 * widen a budget the host already clamped.
 *
 * No cap means the caller keeps its stream function untouched. A cap that is
 * present but not a positive integer is rejected here, while the turn is being
 * assembled, rather than silently degrading into "no ceiling".
 */
function withHostMaxOutputTokens(
  inner: StreamFn | undefined,
  hostMaxOutputTokens: number | undefined,
): StreamFn | undefined {
  if (hostMaxOutputTokens === undefined) return inner;
  if (!Number.isInteger(hostMaxOutputTokens) || hostMaxOutputTokens <= 0) {
    throw new TypeError(
      `host_max_output_tokens_invalid: ${String(hostMaxOutputTokens)} is not a positive integer`,
    );
  }
  const base = inner ?? streamSimple;
  return ((model, context, options) => {
    return base(model, context, {
      ...(options ?? {}),
      maxTokens: smallestPositive([hostMaxOutputTokens, options?.maxTokens, model?.maxTokens]),
    });
  }) as StreamFn;
}

function smallestPositive(candidates: readonly (number | undefined)[]): number {
  return Math.min(
    ...candidates.filter(
      (candidate): candidate is number =>
        typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0,
    ),
  );
}

export function wrapStreamFnWithTimeout(inner: StreamFn | undefined, timeoutMs: number): StreamFn {
  const base = inner ?? streamSimple;
  return ((model, context, options) => {
    return base(model, context, {
      ...(options ?? {}),
      timeoutMs: options?.timeoutMs ?? timeoutMs,
    });
  }) as StreamFn;
}
