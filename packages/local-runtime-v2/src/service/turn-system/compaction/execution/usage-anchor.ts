import { createHash } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

export interface ContextUsageAnchorKey {
  readonly scope: string;
  readonly provider: string;
  readonly api: string;
  readonly model: string;
  readonly contextFingerprint: string;
}

export interface ContextUsageAnchorMatch {
  readonly absoluteTokens: number;
  readonly trailingMessages: readonly AgentMessage[];
}

export interface ContextUsageAnchorKeyInput {
  readonly scope: string;
  readonly provider: string;
  readonly api: string;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly tools?: readonly unknown[];
}

function createContextUsageAnchorKey(input: ContextUsageAnchorKeyInput): ContextUsageAnchorKey {
  const context = JSON.stringify(
    { systemPrompt: input.systemPrompt ?? '', tools: input.tools ?? [] },
    sortKeys,
  );
  if (context === undefined) throw new TypeError('Context usage anchor input is not serializable.');
  const key = {
    scope: input.scope,
    provider: input.provider,
    api: input.api,
    model: input.model,
    contextFingerprint: createHash('sha256').update(context).digest('hex'),
  };
  if (!isValidKey(key)) throw new TypeError('Context usage anchor key is invalid.');
  return key;
}

interface StoredAnchor {
  readonly key: ContextUsageAnchorKey;
  readonly historyEpoch: number;
  readonly assistantIdentity: string;
  readonly absoluteTokens: number;
}

/** Process-local trigger optimization. A miss always falls back to a full local footprint. */
export class ContextUsageAnchorState {
  private readonly anchorsByScope = new Map<string, StoredAnchor>();
  private readonly epochsByScope = new Map<string, number>();
  private readonly keysByScope = new Map<string, ContextUsageAnchorKey>();

  bind(input: ContextUsageAnchorKeyInput): {
    readonly state: ContextUsageAnchorState;
    readonly key: ContextUsageAnchorKey;
    readonly historyEpoch: number;
  } {
    const key = createContextUsageAnchorKey(input);
    this.keysByScope.set(key.scope, key);
    return {
      state: this,
      key,
      historyEpoch: this.epochsByScope.get(key.scope) ?? 0,
    };
  }

  recordBound(scope: string, messages: readonly unknown[]): boolean {
    const key = this.keysByScope.get(scope);
    if (!key) return false;
    const historyEpoch = this.epochsByScope.get(scope) ?? 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const assistant = messages[index];
      if (isAssistantMessage(assistant) && this.record({ key, historyEpoch, assistant }))
        return true;
    }
    return false;
  }

  advanceHistory(scope: string): void {
    this.epochsByScope.set(scope, (this.epochsByScope.get(scope) ?? 0) + 1);
  }

  invalidate(scope: string): void {
    this.anchorsByScope.delete(scope);
  }

  record(input: {
    readonly key: ContextUsageAnchorKey;
    readonly historyEpoch: number;
    readonly assistant: AgentMessage;
  }): boolean {
    const absoluteTokens = readAbsoluteTokens(input.assistant);
    const assistantIdentity = identifyAssistant(input.assistant);
    if (
      !isValidKey(input.key) ||
      !Number.isSafeInteger(input.historyEpoch) ||
      input.historyEpoch < 0 ||
      !assistantMatchesKey(input.assistant, input.key) ||
      absoluteTokens === undefined ||
      assistantIdentity === undefined
    ) {
      return false;
    }

    this.anchorsByScope.set(input.key.scope, {
      key: { ...input.key },
      historyEpoch: input.historyEpoch,
      assistantIdentity,
      absoluteTokens,
    });
    return true;
  }

  resolve(input: {
    readonly key: ContextUsageAnchorKey;
    readonly historyEpoch: number;
    readonly messages: readonly AgentMessage[];
  }): ContextUsageAnchorMatch | undefined {
    const anchor = this.anchorsByScope.get(input.key.scope);
    if (!anchor || anchor.historyEpoch !== input.historyEpoch || !sameKey(anchor.key, input.key)) {
      return undefined;
    }

    let anchoredIndex = -1;
    for (let index = 0; index < input.messages.length; index += 1) {
      const message = input.messages[index];
      if (!message || identifyAssistant(message) !== anchor.assistantIdentity) continue;
      if (anchoredIndex !== -1) return undefined;
      anchoredIndex = index;
    }
    if (anchoredIndex === -1) return undefined;

    return {
      absoluteTokens: anchor.absoluteTokens,
      trailingMessages: input.messages.slice(anchoredIndex + 1),
    };
  }
}

function isAssistantMessage(value: unknown): value is AgentMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.get(value, 'role') === 'assistant'
  );
}

function isValidKey(key: ContextUsageAnchorKey): boolean {
  return [key.scope, key.provider, key.api, key.model, key.contextFingerprint].every(
    (value) => typeof value === 'string' && value.length > 0,
  );
}

function sameKey(left: ContextUsageAnchorKey, right: ContextUsageAnchorKey): boolean {
  return (
    left.scope === right.scope &&
    left.provider === right.provider &&
    left.api === right.api &&
    left.model === right.model &&
    left.contextFingerprint === right.contextFingerprint
  );
}

function assistantMatchesKey(message: AgentMessage, key: ContextUsageAnchorKey): boolean {
  return (
    message.role === 'assistant' &&
    message.provider === key.provider &&
    message.api === key.api &&
    message.model === key.model
  );
}

function readAbsoluteTokens(message: AgentMessage): number | undefined {
  if (message.role !== 'assistant') return undefined;
  if (message.stopReason === 'error' || message.stopReason === 'aborted') return undefined;
  const values = [
    message.usage.input,
    message.usage.output,
    message.usage.cacheRead,
    message.usage.cacheWrite,
    message.usage.totalTokens,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  const rawUsage = message.usage as unknown as Record<string, unknown>;
  if (typeof rawUsage.contextTokens === 'number' && Number.isSafeInteger(rawUsage.contextTokens) && rawUsage.contextTokens > 0) {
    return rawUsage.contextTokens;
  }
  const componentTotal =
    message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
  const absoluteTokens = message.usage.totalTokens || componentTotal;
  return Number.isSafeInteger(absoluteTokens) && absoluteTokens > 0 ? absoluteTokens : undefined;
}

function identifyAssistant(message: AgentMessage): string | undefined {
  if (message.role !== 'assistant') return undefined;
  if (typeof message.responseId === 'string' && message.responseId.length > 0) {
    return `response:${message.provider}:${message.api}:${message.model}:${message.responseId}`;
  }
  try {
    const serialized = JSON.stringify({
      api: message.api,
      provider: message.provider,
      model: message.model,
      timestamp: message.timestamp,
      content: message.content,
      usage: message.usage,
      stopReason: message.stopReason,
    });
    return serialized === undefined
      ? undefined
      : `message:${createHash('sha256').update(serialized).digest('hex')}`;
  } catch {
    return undefined;
  }
}

function sortKeys(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}
