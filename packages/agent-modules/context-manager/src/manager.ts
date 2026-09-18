import { generateSummary, type AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookDecision,
  PiBeforeLlmCallHookInput,
} from '@mavis/agent-core/pi-turn-runner';

import { computeCompactionTriggerAt, DEFAULT_CONTEXT_MANAGER_SETTINGS } from './settings.js';
import { createDefaultContextTokenEstimator, type TokenEstimator } from './token-estimator.js';
import type {
  ContextCompactionPlan,
  ContextCompactionSummaryMessage,
  ContextManagerCheckpointOptions,
  ContextManagerLock,
  ContextManagerObserver,
  ContextManagerOptions,
  ContextManagerSettings,
  ContextSummaryGenerator,
  ContextTokenCounter,
} from './types.js';

type SkipReason =
  | 'context_manager_disabled'
  | 'context_manager_not_enough_messages'
  | 'context_manager_below_threshold'
  | 'context_manager_no_safe_cut_point'
  | 'context_manager_deferred_by_plugin_hook'
  | 'context_manager_token_count_failed'
  | 'context_manager_summary_failed'
  | 'context_manager_summary_empty';

interface TriggerEvaluation {
  shouldCompact: boolean;
  reason?: SkipReason;
  tokens: number;
  source: string;
  triggerAt: number;
}

export class ContextManager {
  readonly beforeLlmCall: PiBeforeLlmCallHook;

  private readonly settings: ContextManagerSettings;
  private readonly tokenEstimator: TokenEstimator;
  private readonly tokenCounter?: ContextTokenCounter;
  private readonly summaryGenerator?: ContextSummaryGenerator;
  private readonly lock: ContextManagerLock;
  private readonly observer?: ContextManagerObserver;
  private readonly nowMs: () => number;
  private readonly idGenerator: () => string;

  constructor(options: ContextManagerOptions = {}) {
    this.settings = { ...DEFAULT_CONTEXT_MANAGER_SETTINGS, ...(options.settings ?? {}) };
    this.tokenEstimator = createDefaultContextTokenEstimator();
    this.tokenCounter = options.tokenCounter;
    this.summaryGenerator = options.summaryGenerator;
    this.lock = options.lock ?? new InProcessContextManagerLock();
    this.observer = options.observer;
    this.nowMs = options.nowMs ?? Date.now;
    this.idGenerator = options.idGenerator ?? defaultReplacementId;
    this.beforeLlmCall = (input) => this.checkpoint(input);
  }

  checkpoint(
    input: PiBeforeLlmCallHookInput,
    options: ContextManagerCheckpointOptions = {},
  ): Promise<PiBeforeLlmCallHookDecision> {
    return this.lock.withSessionLock(input.sessionId, () => this.checkpointLocked(input, options));
  }

  private async checkpointLocked(
    input: PiBeforeLlmCallHookInput,
    options: ContextManagerCheckpointOptions,
  ): Promise<PiBeforeLlmCallHookDecision> {
    const activeMessages = [...input.messages];
    const trigger = await this.evaluateTrigger(activeMessages, input);
    await this.notify('onTriggerEvaluated', {
      sessionId: input.sessionId,
      turnId: input.turnId,
      phase: input.phase,
      source: trigger.source,
      tokens: trigger.tokens,
      triggerAt: trigger.triggerAt,
      shouldCompact: trigger.shouldCompact,
    });
    if (!trigger.shouldCompact) {
      return this.skip(input, trigger.reason ?? 'context_manager_below_threshold');
    }

    const plan = this.selectPlan(activeMessages, trigger.tokens, trigger.triggerAt);
    if (!plan) {
      return this.skip(input, 'context_manager_no_safe_cut_point');
    }
    if (options.beforeCompaction && !(await options.beforeCompaction())) {
      return this.skip(input, 'context_manager_deferred_by_plugin_hook');
    }

    let summary: string;
    try {
      summary = await this.generateSummary(input, plan);
    } catch (err) {
      await this.notify('onCompactionFailed', {
        sessionId: input.sessionId,
        turnId: input.turnId,
        phase: input.phase,
        reason: errorReason('context_manager_summary_failed', err),
      });
      return this.skip(input, 'context_manager_summary_failed');
    }
    if (!summary.trim()) {
      return this.skip(input, 'context_manager_summary_empty');
    }

    const replacementId = this.idGenerator();
    const replacementMessages = [
      createCompactionSummary(summary, plan.tokensBefore, this.nowMs(), plan.keptMessages.length),
      ...plan.keptMessages,
    ];
    const tokensAfter = this.tokenEstimator.estimateContextTokens(replacementMessages).tokens;
    await this.notify('onCompactionCommitted', {
      sessionId: input.sessionId,
      turnId: input.turnId,
      phase: input.phase,
      replacementId,
      tokensBefore: plan.tokensBefore,
      tokensAfter,
      messagesBefore: activeMessages.length,
      messagesAfter: replacementMessages.length,
    });

    return {
      type: 'replaceMessages',
      messages: replacementMessages,
      metadata: {
        replacementId,
        strategyVersion: this.settings.strategyVersion,
        summary,
        compactedMessages: plan.compactedMessages,
        keptMessages: plan.keptMessages,
        firstKeptIndex: plan.firstKeptIndex,
        tokensBefore: plan.tokensBefore,
        tokensAfter,
        messagesBefore: activeMessages.length,
        messagesAfter: replacementMessages.length,
      },
    };
  }

  private async evaluateTrigger(
    messages: AgentMessage[],
    input: PiBeforeLlmCallHookInput,
  ): Promise<TriggerEvaluation> {
    const contextWindow =
      input.model.contextWindow > 0
        ? input.model.contextWindow
        : this.settings.contextWindowFallback;
    // Cloud/legacy retains its existing configured-output trigger policy; local-runtime-v2's
    // dynamic provider budget is supplied separately by provider-budget.ts.
    const triggerAt = computeCompactionTriggerAt({
      modelId: input.model.id,
      contextWindow,
      perTurnMaxTokens: input.model.maxTokens,
      reserveTokens: this.settings.reserveTokens,
      safetyMarginTokens: this.settings.safetyMarginTokens,
    });

    if (!this.settings.enabled) {
      return {
        shouldCompact: false,
        reason: 'context_manager_disabled',
        tokens: 0,
        source: 'disabled',
        triggerAt,
      };
    }
    if (messages.length <= 1 || messages.length < this.settings.minMessagesToCompact) {
      return {
        shouldCompact: false,
        reason: 'context_manager_not_enough_messages',
        tokens: 0,
        source: 'not_counted',
        triggerAt,
      };
    }

    let count: { tokens: number; source: string };
    try {
      count = this.tokenCounter
        ? // Forward headers and tools unchanged to the counter: headers may carry gateway authentication
          // (without it, remote count_tokens returns 401), and tool declarations are part of the real LLM payload
          // (tens of thousands of tokens in MCP-heavy sessions). Omitting them systematically undercounts
          // and delays compaction triggers.
          await this.tokenCounter.countContextTokens({
            messages,
            model: input.model,
            apiKey: input.apiKey,
            headers: input.headers,
            systemPrompt: input.systemPrompt,
            tools: input.tools,
            thinkingLevel: input.thinkingLevel,
            signal: input.signal,
          })
        : {
            tokens: this.tokenEstimator.estimateContextTokens(messages).tokens,
            source: 'local_estimate',
          };
    } catch {
      return {
        shouldCompact: false,
        reason: 'context_manager_token_count_failed',
        tokens: 0,
        source: this.tokenCounter ? 'remote_count_tokens' : 'local_estimate',
        triggerAt,
      };
    }

    const shouldCompact = count.tokens > triggerAt;
    return {
      shouldCompact,
      reason: shouldCompact ? undefined : 'context_manager_below_threshold',
      tokens: count.tokens,
      source: count.source,
      triggerAt,
    };
  }

  private selectPlan(
    activeMessages: AgentMessage[],
    tokensBefore: number,
    triggerAt: number,
  ): ContextCompactionPlan | undefined {
    const previousSummaryIndex = findLatestCompactionSummaryIndex(activeMessages);
    const boundaryStartIndex = previousSummaryIndex >= 0 ? previousSummaryIndex + 1 : 0;
    const compactableCount = activeMessages.length - boundaryStartIndex;
    if (compactableCount < this.settings.minMessagesToCompact) return undefined;

    const effectiveKeepRecentTokens = Math.min(
      this.settings.keepRecentTokens,
      Math.max(1, triggerAt),
    );
    const firstKeptIndex = selectFirstKeptIndex(
      activeMessages,
      boundaryStartIndex,
      effectiveKeepRecentTokens,
      this.tokenEstimator,
    );
    if (firstKeptIndex <= boundaryStartIndex || firstKeptIndex >= activeMessages.length) {
      return undefined;
    }

    const compactedMessages = activeMessages.slice(boundaryStartIndex, firstKeptIndex);
    const keptMessages = activeMessages.slice(firstKeptIndex);
    if (
      compactedMessages.length < this.settings.minMessagesToCompact ||
      keptMessages.length === 0
    ) {
      return undefined;
    }

    return {
      previousSummary:
        previousSummaryIndex >= 0
          ? compactionSummaryText(activeMessages[previousSummaryIndex])
          : undefined,
      compactedMessages,
      keptMessages,
      firstKeptIndex,
      boundaryStartIndex,
      tokensBefore,
    };
  }

  private async generateSummary(
    input: PiBeforeLlmCallHookInput,
    plan: ContextCompactionPlan,
  ): Promise<string> {
    if (this.summaryGenerator) {
      return this.summaryGenerator.generateSummary({
        messages: plan.compactedMessages,
        previousSummary: plan.previousSummary,
        model: input.model,
        apiKey: input.apiKey,
        thinkingLevel: input.thinkingLevel,
        reserveTokens: this.settings.reserveTokens,
        signal: input.signal,
      });
    }
    if (!input.apiKey) {
      throw new Error('context_manager_summary_unavailable: missing apiKey for current model');
    }
    const result = await generateSummary(
      plan.compactedMessages,
      input.model,
      this.settings.reserveTokens,
      input.apiKey,
      undefined,
      input.signal,
      undefined,
      plan.previousSummary,
      input.thinkingLevel,
    );
    if (!result.ok) {
      throw new Error(
        `context_manager_summary_failed: ${result.error.code}: ${result.error.message}`,
      );
    }
    return result.value;
  }

  private async skip(
    input: PiBeforeLlmCallHookInput,
    reason: SkipReason,
  ): Promise<PiBeforeLlmCallHookDecision> {
    await this.notify('onCompactionSkipped', {
      sessionId: input.sessionId,
      turnId: input.turnId,
      phase: input.phase,
      reason,
    });
    return { type: 'skip', reason };
  }

  private async notify(
    key: keyof ContextManagerObserver,
    event:
      | Parameters<NonNullable<ContextManagerObserver['onTriggerEvaluated']>>[0]
      | Parameters<NonNullable<ContextManagerObserver['onCompactionSkipped']>>[0]
      | Parameters<NonNullable<ContextManagerObserver['onCompactionCommitted']>>[0]
      | Parameters<NonNullable<ContextManagerObserver['onCompactionFailed']>>[0],
  ): Promise<void> {
    const fn = this.observer?.[key] as ((value: unknown) => void | Promise<void>) | undefined;
    if (!fn) return;
    try {
      await fn(event);
    } catch {
      // Observer errors must never change compaction decisions.
    }
  }
}

class InProcessContextManagerLock implements ContextManagerLock {
  private readonly sessionLocks = new Map<string, Promise<void>>();

  async withSessionLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => current);
    this.sessionLocks.set(sessionId, chained);

    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === chained) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }
}

function selectFirstKeptIndex(
  messages: AgentMessage[],
  boundaryStart: number,
  keepRecentTokens: number,
  tokenEstimator: TokenEstimator,
): number {
  let candidate = firstValidCutAtOrAfter(messages, boundaryStart, boundaryStart);
  if (candidate < 0) return -1;

  let tokens = 0;
  for (let i = messages.length - 1; i >= boundaryStart; i -= 1) {
    tokens += tokenEstimator.estimateMessage(messages[i]!);
    if (tokens >= keepRecentTokens) {
      candidate = safeCutForIndex(messages, i, boundaryStart);
      break;
    }
  }
  return candidate;
}

function safeCutForIndex(messages: AgentMessage[], index: number, boundaryStart: number): number {
  const message = messages[index];
  if (!message) return -1;
  const toolGroupStart = findToolGroupStartForIndex(messages, index, boundaryStart);
  if (toolGroupStart >= boundaryStart) return toolGroupStart;
  if (message.role === 'toolResult') {
    return findAssistantForToolResult(messages, index, boundaryStart);
  }
  if (isValidFirstKeptMessage(message)) return index;
  return firstValidCutAtOrAfter(messages, index, boundaryStart);
}

function firstValidCutAtOrAfter(
  messages: AgentMessage[],
  index: number,
  boundaryStart: number,
): number {
  for (let i = Math.max(index, boundaryStart); i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'toolResult') {
      const assistantIndex = findAssistantForToolResult(messages, i, boundaryStart);
      if (assistantIndex >= boundaryStart) return assistantIndex;
      continue;
    }
    if (isValidFirstKeptMessage(message)) return i;
  }
  return -1;
}

function isValidFirstKeptMessage(message: AgentMessage): boolean {
  return message.role !== 'toolResult';
}

function findToolGroupStartForIndex(
  messages: AgentMessage[],
  index: number,
  boundaryStart: number,
): number {
  for (let i = index; i >= boundaryStart; i -= 1) {
    const candidate = messages[i];
    if (!candidate) continue;
    if (candidate.role === 'assistant') {
      const toolCallIds = assistantToolCallIds(candidate);
      if (toolCallIds.size === 0) return -1;
      const groupEnd = findToolGroupEnd(messages, i, toolCallIds);
      return index <= groupEnd ? i : -1;
    }
    if (isHardToolGroupBoundary(candidate)) break;
  }
  return -1;
}

function findToolGroupEnd(
  messages: AgentMessage[],
  assistantIndex: number,
  toolCallIds: ReadonlySet<string>,
): number {
  let groupEnd = assistantIndex;
  for (let i = assistantIndex + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;
    if (isHardToolGroupBoundary(message) || message.role === 'assistant') break;
    if (message.role === 'toolResult' && toolCallIds.has(message.toolCallId)) {
      groupEnd = i;
    }
  }
  return groupEnd;
}

function assistantToolCallIds(message: Extract<AgentMessage, { role: 'assistant' }>): Set<string> {
  const ids = new Set<string>();
  for (const block of message.content) {
    if (block.type === 'toolCall') ids.add(block.id);
  }
  return ids;
}

function isHardToolGroupBoundary(message: AgentMessage): boolean {
  return (
    message.role === 'user' ||
    message.role === 'branchSummary' ||
    message.role === 'compactionSummary'
  );
}

function findAssistantForToolResult(
  messages: AgentMessage[],
  toolResultIndex: number,
  boundaryStart: number,
): number {
  const result = messages[toolResultIndex] as Extract<AgentMessage, { role: 'toolResult' }>;
  const toolCallId = result.toolCallId;
  for (let i = toolResultIndex - 1; i >= boundaryStart; i -= 1) {
    const candidate = messages[i];
    if (!candidate) continue;
    if (candidate.role === 'assistant' && assistantHasToolCall(candidate, toolCallId)) return i;
    if (isHardToolGroupBoundary(candidate)) break;
  }
  return -1;
}

function assistantHasToolCall(
  message: Extract<AgentMessage, { role: 'assistant' }>,
  toolCallId: string,
): boolean {
  return message.content.some((block) => block.type === 'toolCall' && block.id === toolCallId);
}

function findLatestCompactionSummaryIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (compactionSummaryText(messages[i]) !== undefined) return i;
  }
  return -1;
}

function compactionSummaryText(message: AgentMessage | undefined): string | undefined {
  if (!message || message.role !== 'compactionSummary') return undefined;
  return message.summary;
}

function createCompactionSummary(
  summary: string,
  tokensBefore: number,
  timestamp: number,
  keptMessageCount: number,
): ContextCompactionSummaryMessage {
  return {
    role: 'compactionSummary',
    summary,
    tokensBefore,
    timestamp,
    keptMessageCount,
  };
}

function errorReason(prefix: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith(`${prefix}:`) ? message : `${prefix}: ${message}`;
}

function defaultReplacementId(): string {
  return `ctx-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}
