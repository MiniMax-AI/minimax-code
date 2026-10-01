import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { calculateContextTokens } from '@earendil-works/pi-coding-agent/compaction';
import {
  computeCompactionTriggerAt as computeSharedCompactionTriggerAt,
  createDefaultTokenEstimator,
} from '@mavis/context-manager';
import type { PiBeforeLlmCallHookInput } from '@mavis/agent-core/pi-turn-runner';

type LocalContextMessage = PiBeforeLlmCallHookInput['messages'][number];
type PiUsage = Parameters<typeof calculateContextTokens>[0];

interface TokenEstimateOptions {
  model?: Model<Api>;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

export function estimateMessagesTokens(
  messages: readonly PiAgentMessage[],
  _options: TokenEstimateOptions = {},
): number {
  return createDefaultTokenEstimator().estimateMessages([...messages]);
}

/**
 * Estimate of the provider-payload parts that live OUTSIDE the message list:
 * the composed system prompt and the active tool declarations. The message
 * usage/text estimators alone systematically under-count the real payload —
 * a large system prompt plus an MCP-heavy tool registry easily adds tens of
 * thousands of tokens — so trigger gates comparing against the real context
 * window must include this footprint.
 */
export function estimateSystemPromptAndToolTokens(
  systemPrompt: string | undefined,
  tools: PiBeforeLlmCallHookInput['tools'] | undefined,
): number {
  const syntheticMessages: PiAgentMessage[] = [];
  if (systemPrompt) {
    syntheticMessages.push(textEstimateMessage(systemPrompt));
  }
  for (const tool of tools ?? []) {
    syntheticMessages.push(
      textEstimateMessage(
        [tool.name ?? '', tool.description ?? '', safeJsonStringify(tool.parameters)].join('\n'),
      ),
    );
  }
  return syntheticMessages.length > 0 ? estimateMessagesTokens(syntheticMessages) : 0;
}

function textEstimateMessage(text: string): PiAgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: 0,
  } as PiAgentMessage;
}

export interface ActiveContextTokensEstimate {
  tokens: number;
  /**
   * True when `tokens` is anchored on provider-reported usage. Provider usage
   * counts the WHOLE request payload — system prompt and tool declarations
   * included — so callers must not add an out-of-band system prompt/tools
   * estimate on top of an anchored value: that double-counts them and fires
   * the compaction trigger early.
   */
  usageAnchored: boolean;
}

export function estimateActiveContextTokens(
  messages: readonly LocalContextMessage[],
  _options: TokenEstimateOptions = {},
): ActiveContextTokensEstimate {
  const compactedAfterMs = readLeadingCompactionSummaryTimestamp(messages);
  const lastUsageIndex = findLastFreshAssistantUsageIndex(messages, compactedAfterMs);
  if (lastUsageIndex < 0) {
    return { tokens: estimateMessagesTokens(messages), usageAnchored: false };
  }

  const usage = readFreshAssistantUsage(messages[lastUsageIndex]!, compactedAfterMs);
  if (!usage) {
    return { tokens: estimateMessagesTokens(messages), usageAnchored: false };
  }

  const lastEstimate =
    calculateContextTokens(usage) + estimateMessagesTokens(messages.slice(lastUsageIndex + 1));

  // Floor the estimate at the PEAK fresh-usage context since the last
  // compaction. When usage oscillates (small sub-call turns interleave between
  // large main-thread turns), anchoring purely on the LAST usage lets a small
  // trailing turn deflate the estimate below the trigger line and silently skip
  // compaction. Once any post-compaction turn reported a context over the line,
  // latch the gate to that peak. For a monotonic session peak == last, so this
  // is a no-op there.
  return {
    tokens: Math.max(lastEstimate, maxFreshUsageContextTokens(messages, compactedAfterMs)),
    usageAnchored: true,
  };
}

export function computeCompactionTriggerAt(input: {
  modelId?: string;
  contextWindow: number;
  perTurnMaxTokens: number;
  reserveTokens: number;
  safetyMarginTokens: number;
}): number {
  return computeSharedCompactionTriggerAt(input);
}

// Max `calculateContextTokens` over fresh (post-compaction) assistant usages.
// Returns 0 when none qualify.
function maxFreshUsageContextTokens(
  messages: readonly LocalContextMessage[],
  compactedAfterMs: number | undefined,
): number {
  let peak = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const usage = readFreshAssistantUsage(messages[i]!, compactedAfterMs);
    if (!usage) continue;
    const candidate = calculateContextTokens(usage);
    if (candidate > peak) peak = candidate;
  }
  return peak;
}

function findLastFreshAssistantUsageIndex(
  messages: readonly LocalContextMessage[],
  compactedAfterMs: number | undefined,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (readFreshAssistantUsage(messages[index]!, compactedAfterMs)) return index;
  }
  return -1;
}

function readFreshAssistantUsage(
  message: LocalContextMessage,
  compactedAfterMs: number | undefined,
): PiUsage | undefined {
  const assistant = message as { role?: unknown; stopReason?: unknown; usage?: unknown };
  if (assistant.role !== 'assistant') return undefined;
  if (assistant.stopReason === 'aborted' || assistant.stopReason === 'error') return undefined;
  const timestamp = readMessageTimestamp(message);
  if (
    compactedAfterMs !== undefined &&
    (timestamp === undefined || timestamp <= compactedAfterMs)
  ) {
    return undefined;
  }
  return normalizeUsage(assistant.usage);
}

function normalizeUsage(usage: unknown): PiUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const raw = usage as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
  };
  const input = readPositiveTokenCount(raw.input) ?? 0;
  const output = readPositiveTokenCount(raw.output) ?? 0;
  const cacheRead = readPositiveTokenCount(raw.cacheRead) ?? 0;
  const cacheWrite = readPositiveTokenCount(raw.cacheWrite) ?? 0;
  const totalTokens = readPositiveTokenCount(raw.totalTokens) ?? 0;
  if (input + output + cacheRead + cacheWrite + totalTokens <= 0) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function readPositiveTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readLeadingCompactionSummaryTimestamp(
  messages: readonly LocalContextMessage[],
): number | undefined {
  const first = messages[0];
  if (!first) return undefined;
  const role = (first as { role?: unknown }).role;
  // Current policy: compaction produces a synthetic user message marked `archonCompaction`;
  // legacy history may still start with a pi-style `compactionSummary` message. Accept both.
  const isCompactionArtifact =
    role === 'compactionSummary' ||
    (role === 'user' &&
      typeof (first as { archonCompaction?: { summary?: unknown } }).archonCompaction?.summary ===
        'string');
  if (!isCompactionArtifact) return undefined;
  return readMessageTimestamp(first);
}

function readMessageTimestamp(message: LocalContextMessage): number | undefined {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined;
}
