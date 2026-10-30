import type { QueueItem, QueueRoutingProvenance } from './repo/contract.js';

/** Stable dispatch identity; missing values and whitespace-only values normalize to null. */
export function queueRoutingFingerprint(item: QueueItem): string {
  const context = routingContext(item);
  const fields = [
    ['source', normalizeRoutingValue(queueExecutionSource(item))],
    ['platform', readRoutingValue(context, ['platform'])],
    ['client', readRoutingValue(context, ['clientName', 'client_name', 'client'])],
    ['agent', normalizeRoutingValue(item.agentName)],
    ['agentBinding', readRoutingValue(context, ['agentName', 'agent_name', 'agentId', 'agent_id'])],
    ['binding', readRoutingValue(context, ['bindingId', 'binding_id'])],
    ['channel', readRoutingValue(context, ['channel'])],
    ['channelId', readRoutingValue(context, ['channel_id', 'channelId'])],
    ['thread', readRoutingValue(context, ['threadId', 'thread_id'])],
    ['chat', readRoutingValue(context, ['chatId', 'chat_id'])],
    ['scope', readRoutingValue(context, ['scope', 'scopeId', 'scope_id'])],
    ['chatType', readRoutingValue(context, ['chatType', 'chat_type'])],
    ['sender', readRoutingValue(context, ['senderId', 'sender_id'])],
  ] as const;
  const trustedFields = queuePtcEligible(item) ? [...fields, ['ptcEligible', true]] : fields;
  return `queue-routing/v1:${JSON.stringify(trustedFields)}`;
}

export function queueRoutingProvenance(item: QueueItem): QueueRoutingProvenance {
  const context = routingContext(item);
  const sourceContext = queuePtcEligible(item) ? { ...context, ptcEligible: true } : context;
  return {
    source: queueExecutionSource(item),
    routingFingerprint: queueRoutingFingerprint(item),
    ...(sourceContext ? { sourceContext: { ...sourceContext } } : {}),
  };
}

/** A composite execution keeps PTC only when every original member was trusted. */
export function queuePtcEligible(
  item: Pick<QueueItem, 'source' | 'message' | 'ptcEligible' | 'immediateSendBatch'>,
): boolean {
  if (item.source !== 'api' || item.message.source === 'code_review' || item.ptcEligible !== true) {
    return false;
  }
  return (
    item.immediateSendBatch === undefined ||
    item.immediateSendBatch.members.every(
      (member) =>
        member.provenance.source === 'api' && member.provenance.sourceContext?.ptcEligible === true,
    )
  );
}

function routingContext(item: QueueItem): Readonly<Record<string, unknown>> | undefined {
  const channelContext = withoutPtcEligibility(item.message.channelContext ?? item.channelContext);
  if (item.message.clientIntent === 'cloud-handoff') {
    return {
      ...(channelContext ?? {}),
      cloudHandoff: { trigger: 'slash' },
    };
  }
  if (queueExecutionSource(item) !== 'code_review') return channelContext;
  return {
    ...(channelContext ?? {}),
    review: {
      trigger: 'slash',
      scope: 'local_changes',
    },
  };
}

function withoutPtcEligibility(
  context: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!context) return undefined;
  const { ptcEligible, ...rest } = context;
  void ptcEligible;
  return rest;
}

export function queueExecutionSource(item: QueueItem): QueueItem['source'] {
  return item.message.source === 'code_review' ? 'code_review' : item.source;
}

function readRoutingValue(
  context: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): string | null {
  if (!context) return null;
  return keys.reduce<string | null>(
    (value, key) => value ?? normalizeRoutingValue(context[key]),
    null,
  );
}

function normalizeRoutingValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
