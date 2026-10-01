import {
  CONTEXT_USAGE_COMPONENT_KINDS,
  RuntimeEventStatus,
  RuntimeStopReasonType,
  RuntimeEventType,
  type ContextUsageComponent,
  type ContextUsageComponentKind,
  type ContextUsageSnapshot,
  type RuntimeEvent,
} from '@mavis/agent-core/protocol';
import { RespDataType, Role, type AgentMessage } from '@mavis/agent-core/protocol/agent-message';
import type { CompactionTokenUsage } from '@mavis/shared/global-events';

import type { MessageRepository } from './messages/repo/contract.js';
import type { QueryCollapseProjector } from './query-collapse-projector.js';
import type {
  ConversationActionProjectionService,
  ConversationMessageActionDelta,
} from './messages/query/conversation-action-projection.js';
import type { SessionStateWriter } from './sessions/recovery/capabilities.js';
import type { SessionRepository } from './sessions/repo/contract.js';
import type { SessionStreamWriter } from './stream/session-frame.js';

export interface SessionAgentEventContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnSequence: number;
  readonly clientRequestId?: string;
  readonly queueItemIds?: readonly string[];
  readonly provenance?: {
    readonly source: string;
    readonly routingFingerprint: string;
    readonly sourceContext?: Readonly<Record<string, unknown>>;
  };
}

export interface SessionAgentProjectionInput {
  readonly context: SessionAgentEventContext;
  readonly event: RuntimeEvent;
  readonly signal?: AbortSignal;
}

export interface SessionSystemAgentProjectionOptions {
  readonly state: Pick<SessionStateWriter, 'markStarted' | 'markIdle' | 'markTerminal'>;
  readonly sessions: Pick<SessionRepository, 'update'>;
  readonly messages: Pick<MessageRepository, 'upsert' | 'listTurn' | 'rewind'>;
  readonly stream: Pick<SessionStreamWriter, 'write'>;
  readonly conversationActions?: Pick<ConversationActionProjectionService, 'projectTerminalTurn'>;
  readonly conversationFacts: SessionConversationFactSink;
  /** Display sidecar is read only for Session-owned message/stream projection. */
  readonly queryKeyForTurn?: (sessionId: string, turnId: string) => Promise<string | undefined>;
  /** Injected steered-provenance derivation; the query-key format stays owned upstream. */
  readonly steeringProjection?: (queryKey: string) => Readonly<Record<string, unknown>>;
  /** Best-effort lifecycle projection; it never changes a Turn outcome. */
  readonly queryCollapse?: QueryCollapseProjector;
  readonly compactionFacts?: SessionCompactionFactSink;
  readonly compactionMetrics?: {
    counter(name: string, delta?: number, labels?: Record<string, string>): void;
    histogram(name: string, value: number, labels?: Record<string, string>): void;
  };
  readonly nowMs?: () => number;
}

export function createSessionSystemAgentProjection(options: SessionSystemAgentProjectionOptions) {
  const compactionLane = createCompactionProjectionLane();
  const startedCompactions = new Map<
    string,
    { readonly startedAtMs: number; readonly trigger: 'auto' | 'manual' }
  >();
  return {
    session: {
      projectRuntimeEvent: (input: SessionAgentProjectionInput) =>
        projectSessionRuntime(options, input),
    },
    messages: {
      projectRuntimeEvent: async (input: SessionAgentProjectionInput) => {
        const message = displayMessage(input.event);
        if (message && !isTerminalAssistantDisplayError(message)) {
          const queryKey = await queryKeyForTurn(options, input.context);
          await options.messages.upsert(
            {
              sessionId: input.context.sessionId,
              turnId: input.context.turnId,
              message: {
                ...message,
                turn_id: input.context.turnId,
                ...(queryKey ? { query_key: queryKey } : {}),
              },
              source: input.context.provenance?.source ?? 'agent',
              ...(input.context.provenance?.sourceContext
                ? { sourceContext: input.context.provenance.sourceContext }
                : {}),
            },
            // Complete tool messages describe work already executed, including
            // abort cleanup. Persist these facts within the write-lock budget
            // even when the lease is cancelled; text-only waits may stop early.
            message.tool_calls?.length ? undefined : { signal: input.signal },
          );
        }
        await projectQueryCollapse(() => options.queryCollapse?.projectRuntimeEvent(input));
      },
      projectHistoryCommitted: async (input: SessionAgentHistoryProjectionInput) => {
        await projectCanonicalAssistantBoundaries(options, input);
        await projectCommittedConversation(options, input);
        await projectQueryCollapse(() =>
          options.queryCollapse?.projectHistoryCommitted({
            context: input.context,
            change: input.change,
          }),
        );
      },
    },
    attemptRecall: {
      recallAssistantAttempt: (input: SessionAssistantAttemptRecallInput) =>
        recallAssistantAttempt(options, input),
    },
    stream: {
      projectRuntimeEvent: async (input: SessionAgentProjectionInput) => {
        const terminal = terminalOutcome(input.event);
        const streamData = terminal
          ? undefined
          : streamProjectionData(options, input, await queryKeyForTurn(options, input.context));
        const messageActionDeltas = terminal
          ? await terminalConversationActions(options, input.context)
          : [];
        options.stream.write({
          identity: `runtime:${input.event.event_id}`,
          sessionId: input.context.sessionId,
          turnId: input.context.turnId,
          kind: terminal ? 'turn-terminal' : 'runtime-event',
          data: terminal ? terminalFrameData(input.event, terminal) : (streamData ?? input.event),
          ...(messageActionDeltas.length > 0 ? { messageActionDeltas } : {}),
        });
      },
    },
    historyFailures: {
      projectHistoryFailure: async (input: {
        readonly sessionId: string;
        readonly turnId: string;
        readonly metadata?: unknown;
      }) => {
        const updated = await options.sessions.update(input.sessionId, {
          status: 'error',
          errorMessage: `Canonical history commit failed for ${input.turnId}`,
          errorSource: 'canonical-history',
          ...(input.metadata === undefined ? {} : { errorDetail: safeJson(input.metadata) }),
        });
        if (!updated) throw new Error(`Session not found: ${input.sessionId}`);
      },
    },
    failures: {
      project: async (input: {
        readonly sessionId: string;
        readonly turnId: string;
        readonly turnSequence: number;
        readonly eventId: string;
        readonly error: unknown;
        readonly status?: 'aborted';
      }) => {
        const status = input.status ?? 'failed';
        const errorMessage = describeError(input.error);
        const result = await options.state.markTerminal({
          sessionId: input.sessionId,
          turnId: input.turnId,
          turnSequence: input.turnSequence,
          eventId: input.eventId,
          outcome: status,
          ...(status === 'failed' ? { errorMessage, errorSource: 'turn-system' } : {}),
        });
        assertStateWrite(result.status);
        await projectQueryCollapse(() => options.queryCollapse?.projectFailure(input));
        const messageActionDeltas = await terminalConversationActions(options, {
          sessionId: input.sessionId,
          turnId: input.turnId,
        });
        options.stream.write({
          identity: `turn-${status === 'aborted' ? 'abort' : 'failure'}:${input.eventId}`,
          sessionId: input.sessionId,
          turnId: input.turnId,
          kind: 'turn-terminal',
          data: { status, ...(status === 'failed' ? { error: errorMessage } : {}) },
          ...(messageActionDeltas.length > 0 ? { messageActionDeltas } : {}),
        });
      },
    },
    compactionLifecycle: {
      completeCommittedHistory: (input: SessionCompactionLifecycleInput) =>
        compactionLane.run(input.attemptId, async () => {
          await writeCompactionFact(options, input, 'compaction');
          recordCompletedCompactionMetrics(options, input, startedCompactions.get(input.attemptId));
        }),
      failCommittedHistory: (input: SessionCompactionFailureInput) =>
        compactionLane.run(input.attemptId, () =>
          writeCompactionFact(options, input, 'compaction_failed'),
        ),
    },
    compactionObserver: {
      observe: (input: SessionCompactionObservation) =>
        compactionLane.run(input.attemptId, async () => {
          await projectCompactionObservation(options, startedCompactions, input);
        }),
    },
  };
}

async function terminalConversationActions(
  options: SessionSystemAgentProjectionOptions,
  context: Pick<SessionAgentEventContext, 'sessionId' | 'turnId'>,
): Promise<readonly ConversationMessageActionDelta[]> {
  try {
    return (
      (await options.conversationActions?.projectTerminalTurn({
        sessionId: context.sessionId,
        turnId: context.turnId,
      })) ?? []
    );
  } catch {
    // Transient action projection must never suppress the durable terminal boundary.
    return [];
  }
}

export type SessionConversationFact =
  | {
      readonly kind: 'turn-retracted';
      readonly sessionId: string;
      readonly turnId: string;
      readonly variant: 'content' | 'network' | 'auth';
      readonly lastUserMsgId?: string;
    }
  | {
      readonly kind: 'network-stopped';
      readonly sessionId: string;
      readonly turnId: string;
    }
  | {
      readonly kind: 'attempt-recalled';
      readonly sessionId: string;
      readonly turnId: string;
      readonly attempt: number;
    };

export interface SessionConversationFactSink {
  handle(fact: SessionConversationFact): void | Promise<void>;
}

export type SessionCompactionFact =
  | {
      readonly kind: 'started';
      readonly sessionId: string;
      readonly attemptId: string;
    }
  | {
      readonly kind: 'failed';
      readonly sessionId: string;
      readonly attemptId: string;
      readonly tokenUsage?: CompactionTokenUsage;
    }
  | {
      readonly kind: 'completed';
      readonly sessionId: string;
      readonly attemptId: string;
      /** Canonical snapshot identity emitted by the committed compaction. */
      readonly snapshotId: string;
      readonly messagesBefore: number;
      readonly messagesAfter: number;
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly contextUsage?: SessionPostCompactionContextUsage;
      readonly tokenUsage?: CompactionTokenUsage;
    };

/**
 * Immediate post-compaction Context Usage estimate. Carried alongside the
 * compaction fact so Context Usage surfaces can drop right away instead of
 * waiting for the next provider-anchored turn.
 */
export interface SessionPostCompactionContextUsage extends ContextUsageSnapshot {
  readonly totalCountSource: 'LOCAL_ESTIMATE';
}

export interface SessionCompactionFactSink {
  handle(fact: SessionCompactionFact): void | Promise<void>;
}

export type SessionCompactionObservation = {
  readonly context: SessionAgentEventContext;
  readonly attemptId: string;
} & (
  | {
      readonly status: 'started';
      readonly reason?: string;
    }
  | {
      readonly status: 'completed';
      readonly compactionId: string;
      readonly messagesBefore: number;
      readonly messagesAfter: number;
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly contextUsage?: SessionPostCompactionContextUsage;
      readonly tokenUsage?: CompactionTokenUsage;
    }
  | {
      readonly status: 'unchanged';
      readonly reason?: string;
    }
  | {
      readonly status: 'aborted' | 'failed';
      readonly compactionId?: string;
      readonly reason?: string;
      readonly tokenUsage?: CompactionTokenUsage;
    }
);

export interface SessionCompactionLifecycleInput {
  readonly context: SessionAgentEventContext;
  readonly attemptId: string;
  readonly operationId: string;
  readonly committedRevision: string;
  readonly metadata: unknown;
}

export interface SessionCompactionFailureInput {
  readonly context: SessionAgentEventContext;
  readonly attemptId: string;
  readonly error: unknown;
  readonly metadata?: unknown;
}

export interface SessionAgentHistoryProjectionInput {
  readonly context: SessionAgentEventContext;
  readonly change: {
    readonly reason?: string;
    readonly messages?: readonly { readonly role?: string }[];
    readonly committedIdentityVector?: readonly string[];
    readonly operation: {
      readonly kind: string;
      readonly variant?: 'content' | 'network' | 'auth';
    };
  };
}

async function projectCanonicalAssistantBoundaries(
  options: SessionSystemAgentProjectionOptions,
  input: SessionAgentHistoryProjectionInput,
): Promise<void> {
  const canonicalMessageIds = canonicalAssistantMessageIds(input.change);
  if (canonicalMessageIds.length === 0) return;
  try {
    const displayMessages = await options.messages.listTurn(
      input.context.sessionId,
      input.context.turnId,
    );
    const assistants = displayMessages.filter(isCanonicalAssistantDisplayMessage);
    if (assistants.length < canonicalMessageIds.length) return;
    const targets = assistants.slice(-canonicalMessageIds.length);
    await Promise.all(
      targets.flatMap((message, index) => {
        const canonicalMessageId = canonicalMessageIds[index];
        return canonicalMessageId
          ? [
              options.messages.upsert({
                sessionId: input.context.sessionId,
                turnId: input.context.turnId,
                message: {
                  ...message,
                  canonical_message_id: canonicalMessageId,
                },
              }),
            ]
          : [];
      }),
    );
  } catch {
    // The canonical commit is authoritative. This Display-side Fork anchor is
    // best-effort and old rows retain the next-User compatibility boundary.
  }
}

function canonicalAssistantMessageIds(
  change: SessionAgentHistoryProjectionInput['change'],
): readonly string[] {
  const messages = change.messages;
  const identities = change.committedIdentityVector;
  if (
    change.reason !== 'messageDelta' ||
    !messages ||
    !identities ||
    identities.length < messages.length
  ) {
    return [];
  }
  const offset = identities.length - messages.length;
  return messages.flatMap((message, index) => {
    const identity = identities[offset + index];
    return message.role === Role.Assistant && typeof identity === 'string' && identity.length > 0
      ? [identity]
      : [];
  });
}

function isCanonicalAssistantDisplayMessage(message: {
  readonly role?: string;
  readonly kind?: string;
  readonly displayKind?: unknown;
}): boolean {
  return (
    message.role === Role.Assistant &&
    !(typeof message.kind === 'string' && message.kind.length > 0) &&
    !(typeof message.displayKind === 'string' && message.displayKind.length > 0)
  );
}

export interface SessionAssistantAttemptRecallInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly messageIds: readonly string[];
}

async function recallAssistantAttempt(
  options: SessionSystemAgentProjectionOptions,
  input: SessionAssistantAttemptRecallInput,
): Promise<void> {
  const displayMessages = await options.messages.listTurn(input.sessionId, input.turnId);
  const userMessageIds = new Set(
    displayMessages.flatMap((message) =>
      message.role === Role.User && typeof message.msg_id === 'string' && message.msg_id.length > 0
        ? [message.msg_id]
        : [],
    ),
  );
  const durableAssistantIds = displayMessages.flatMap((message) =>
    message.role === Role.Assistant &&
    typeof message.msg_id === 'string' &&
    message.msg_id.length > 0
      ? [message.msg_id]
      : [],
  );
  const messageIds = [
    ...new Set([
      ...durableAssistantIds,
      ...input.messageIds.filter((messageId) => !userMessageIds.has(messageId)),
    ]),
  ];
  if (messageIds.length > 0) {
    await options.messages.rewind({ sessionId: input.sessionId, messageIds });
  }
  options.stream.write({
    identity: `messages-rewound:${input.turnId}:attempt:${String(input.attempt)}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    kind: 'messages-rewound',
    data: { messageIds },
  });
  await options.conversationFacts.handle({
    kind: 'attempt-recalled',
    sessionId: input.sessionId,
    turnId: input.turnId,
    attempt: input.attempt,
  });
}

async function projectCommittedConversation(
  options: SessionSystemAgentProjectionOptions,
  input: SessionAgentHistoryProjectionInput,
): Promise<void> {
  if (input.change.operation.kind === 'network-reconcile') {
    await options.conversationFacts.handle({
      kind: 'network-stopped',
      sessionId: input.context.sessionId,
      turnId: input.context.turnId,
    });
    return;
  }
  if (input.change.operation.kind !== 'output-recall') return;
  const displayMessages = await options.messages.listTurn(
    input.context.sessionId,
    input.context.turnId,
  );
  const messageIds = displayMessages.flatMap((message) =>
    typeof message.msg_id === 'string' && message.msg_id.length > 0 ? [message.msg_id] : [],
  );
  const lastUserMsgId = displayMessages.reduce<string | undefined>(
    (latest, message) =>
      message.role === Role.User && typeof message.msg_id === 'string' && message.msg_id.length > 0
        ? message.msg_id
        : latest,
    undefined,
  );
  await options.messages.rewind({
    sessionId: input.context.sessionId,
    messageIds,
  });
  options.stream.write({
    identity: `messages-rewound:${input.context.turnId}`,
    sessionId: input.context.sessionId,
    turnId: input.context.turnId,
    kind: 'messages-rewound',
    data: { messageIds },
  });
  await options.conversationFacts.handle({
    kind: 'turn-retracted',
    sessionId: input.context.sessionId,
    turnId: input.context.turnId,
    variant: input.change.operation.variant ?? 'content',
    ...(lastUserMsgId ? { lastUserMsgId } : {}),
  });
}

async function projectCompactionObservation(
  options: SessionSystemAgentProjectionOptions,
  startedCompactions: Map<
    string,
    { readonly startedAtMs: number; readonly trigger: 'auto' | 'manual' }
  >,
  input: SessionCompactionObservation,
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now;
  if (input.status === 'started') {
    if (startedCompactions.has(input.attemptId)) return;
    startedCompactions.set(input.attemptId, {
      startedAtMs: nowMs(),
      trigger: input.reason === 'automatic' ? 'auto' : 'manual',
    });
    await writeCompactionFact(options, input, 'compaction_start');
    await options.compactionFacts?.handle({
      kind: 'started',
      sessionId: input.context.sessionId,
      attemptId: input.attemptId,
    });
    return;
  }
  if (input.status === 'completed') {
    startedCompactions.delete(input.attemptId);
    await options.compactionFacts?.handle({
      kind: 'completed',
      sessionId: input.context.sessionId,
      attemptId: input.attemptId,
      snapshotId: input.compactionId,
      messagesBefore: input.messagesBefore,
      messagesAfter: input.messagesAfter,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter,
      ...(input.contextUsage === undefined ? {} : { contextUsage: input.contextUsage }),
      ...compactionTokenUsageMetadata(input.tokenUsage),
    });
    return;
  }
  const started = startedCompactions.get(input.attemptId);
  startedCompactions.delete(input.attemptId);
  recordTerminalCompactionMetrics(options, input, started, nowMs());
  if (input.status === 'unchanged') {
    if (!started) return;
    await writeCompactionFact(
      options,
      {
        context: input.context,
        attemptId: input.attemptId,
        error: input.reason ?? 'nothing-to-compact',
      },
      'compaction_failed',
    );
  }
  await options.compactionFacts?.handle({
    kind: 'failed',
    sessionId: input.context.sessionId,
    attemptId: input.attemptId,
    ...terminalCompactionTokenUsageMetadata(input),
  });
}

function recordCompletedCompactionMetrics(
  options: SessionSystemAgentProjectionOptions,
  input: SessionCompactionLifecycleInput,
  started: { readonly startedAtMs: number; readonly trigger: 'auto' | 'manual' } | undefined,
): void {
  const metrics = options.compactionMetrics;
  const metadata = readCompactionMetricMetadata(input.metadata);
  if (!metrics || !metadata) return;
  const {
    phase,
    method,
    tokensBefore,
    tokensAfter,
    bytesBefore,
    bytesAfter,
    hmidOverflowRecovered,
    tokenUsage,
  } = metadata;
  const trigger = phase === 'manual' ? 'manual' : 'auto';
  try {
    metrics.counter('compact_outcome_total', 1, { trigger, outcome: 'completed', method });
    if (hmidOverflowRecovered) {
      metrics.counter('compact_hmid_overflow_recovery_total', 1, { trigger });
    }
    if (started) {
      metrics.histogram(
        'compact_duration_ms',
        (options.nowMs ?? Date.now)() - started.startedAtMs,
        {
          trigger,
        },
      );
    }
    const ratioLabels = { trigger, method };
    if (tokensBefore > 0) {
      metrics.histogram('compact_saved_ratio', 1 - tokensAfter / tokensBefore, {
        ...ratioLabels,
        dimension: 'tokens',
      });
    }
    if (bytesBefore > 0) {
      metrics.histogram('compact_saved_ratio', 1 - bytesAfter / bytesBefore, {
        ...ratioLabels,
        dimension: 'serialized_bytes',
      });
    }
    recordCompactionTokenUsage(metrics, tokenUsage, { trigger, outcome: 'completed' });
  } catch {
    // Metrics must never change projection or Host outcomes.
  }
}

function recordTerminalCompactionMetrics(
  options: SessionSystemAgentProjectionOptions,
  input: Exclude<SessionCompactionObservation, { readonly status: 'started' | 'completed' }>,
  started: { readonly startedAtMs: number; readonly trigger: 'auto' | 'manual' } | undefined,
  terminalAtMs: number,
): void {
  const metrics = options.compactionMetrics;
  if (!metrics) return;
  const trigger = started?.trigger ?? fallbackCompactionTrigger(input);
  const outcome = terminalCompactionOutcome(input);
  try {
    metrics.counter('compact_outcome_total', 1, { trigger, outcome, method: 'none' });
    if (started) {
      metrics.histogram('compact_duration_ms', terminalAtMs - started.startedAtMs, { trigger });
    }
    recordCompactionTokenUsage(metrics, terminalCompactionTokenUsage(input), { trigger, outcome });
  } catch {
    // Metrics must never change projection or Host outcomes.
  }
}

function fallbackCompactionTrigger(
  input: Exclude<SessionCompactionObservation, { readonly status: 'started' | 'completed' }>,
): 'auto' | 'unknown' {
  return input.status === 'unchanged' ? 'auto' : 'unknown';
}

function terminalCompactionOutcome(
  input: Exclude<SessionCompactionObservation, { readonly status: 'started' | 'completed' }>,
): 'below_trigger' | 'filter_only' | 'failed' | 'aborted' {
  if (input.status !== 'unchanged') return input.status;
  return input.reason === 'internal-context-filter' ? 'filter_only' : 'below_trigger';
}

function readCompactionMetricMetadata(value: unknown):
  | {
      readonly phase: 'initial' | 'iteration' | 'manual';
      readonly method: 'tool_archive' | 'tool_trim' | 'llm_checkpoint';
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly bytesBefore: number;
      readonly bytesAfter: number;
      readonly hmidOverflowRecovered: boolean;
      readonly tokenUsage?: CompactionTokenUsage;
    }
  | undefined {
  if (!isRecord(value)) return undefined;
  const phase = value.phase;
  if (phase !== 'initial' && phase !== 'iteration' && phase !== 'manual') return undefined;
  const method = value.method;
  if (method !== 'tool_archive' && method !== 'tool_trim' && method !== 'llm_checkpoint') {
    return undefined;
  }
  const counts = readCompactionMetricCounts(value);
  const tokenUsage = readCompactionTokenUsage(value.tokenUsage);
  return counts
    ? {
        phase,
        method,
        ...counts,
        ...compactionTokenUsageMetadata(tokenUsage),
        hmidOverflowRecovered:
          method === 'llm_checkpoint' && Reflect.get(value, 'hmidOverflowRecovered') === true,
      }
    : undefined;
}

function compactionTokenUsageMetadata(tokenUsage: CompactionTokenUsage | undefined): {
  readonly tokenUsage?: CompactionTokenUsage;
} {
  if (tokenUsage === undefined) return {};
  return { tokenUsage };
}

function terminalCompactionTokenUsage(
  input: Exclude<SessionCompactionObservation, { readonly status: 'started' | 'completed' }>,
): CompactionTokenUsage | undefined {
  if (input.status === 'unchanged') return undefined;
  return input.tokenUsage;
}

function terminalCompactionTokenUsageMetadata(
  input: Exclude<SessionCompactionObservation, { readonly status: 'started' | 'completed' }>,
): { readonly tokenUsage?: CompactionTokenUsage } {
  return compactionTokenUsageMetadata(terminalCompactionTokenUsage(input));
}

function recordCompactionTokenUsage(
  metrics: SessionSystemAgentProjectionOptions['compactionMetrics'],
  tokenUsage: CompactionTokenUsage | undefined,
  labels: { readonly trigger: string; readonly outcome: string },
): void {
  if (!metrics || !tokenUsage) return;
  for (const [kind, value] of [
    ['input', tokenUsage.inputTokens],
    ['output', tokenUsage.outputTokens],
    ['cache_read', tokenUsage.cacheReadTokens],
    ['cache_write', tokenUsage.cacheWriteTokens],
  ] as const) {
    try {
      metrics.counter('compact_provider_tokens_total', value, { ...labels, kind });
    } catch {
      // Metrics must never change projection or Host outcomes.
    }
  }
  if (tokenUsage.incomplete) {
    try {
      metrics.counter('compact_provider_token_usage_incomplete_total', 1, labels);
    } catch {
      // Metrics must never change projection or Host outcomes.
    }
  }
}

function readCompactionTokenUsage(value: unknown): CompactionTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = readNonNegativeNumber(value.inputTokens);
  const outputTokens = readNonNegativeNumber(value.outputTokens);
  const cacheReadTokens = readNonNegativeNumber(value.cacheReadTokens);
  const cacheWriteTokens = readNonNegativeNumber(value.cacheWriteTokens);
  const totalTokens = readNonNegativeNumber(value.totalTokens);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined ||
    totalTokens === undefined ||
    typeof value.incomplete !== 'boolean' ||
    totalTokens !== inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    incomplete: value.incomplete,
  };
}

function readCompactionMetricCounts(value: Readonly<Record<string, unknown>>):
  | {
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly bytesBefore: number;
      readonly bytesAfter: number;
    }
  | undefined {
  const tokensBefore = readNonNegativeNumber(value.tokensBefore);
  const tokensAfter = readNonNegativeNumber(value.tokensAfter);
  const bytesBefore = readNonNegativeNumber(value.serializedBytesBefore);
  const bytesAfter = readNonNegativeNumber(value.serializedBytesAfter);
  if (tokensBefore === undefined) return undefined;
  if (tokensAfter === undefined) return undefined;
  if (bytesBefore === undefined) return undefined;
  if (bytesAfter === undefined) return undefined;
  return { tokensBefore, tokensAfter, bytesBefore, bytesAfter };
}

async function projectSessionRuntime(
  options: SessionSystemAgentProjectionOptions,
  input: SessionAgentProjectionInput,
): Promise<
  | { readonly terminal: false }
  | { readonly terminal: true; readonly outcome: 'completed' | 'failed' | 'aborted' }
> {
  const identity = eventIdentity(input);
  const terminal = terminalOutcome(input.event);
  if (terminal) {
    const error = terminalError(input.event);
    const result = await options.state.markTerminal({
      ...identity,
      outcome: terminal,
      ...(error?.message ? { errorMessage: error.message } : {}),
      ...(error?.code !== undefined ? { errorCode: error.code } : {}),
      ...(error?.errorSource ? { errorSource: error.errorSource } : {}),
      ...(error?.details ? { errorDetail: error.details } : {}),
    });
    assertStateWrite(result.status);
    return { terminal: true, outcome: terminal };
  }
  if (isSessionStatus(input.event, RuntimeEventStatus.RUNNING)) {
    const result = await options.state.markStarted(identity);
    assertStateWrite(result.status);
  } else if (isSessionStatus(input.event, RuntimeEventStatus.IDLE)) {
    const result = await options.state.markIdle(identity);
    assertStateWrite(result.status);
  }
  return { terminal: false };
}

function eventIdentity(input: SessionAgentProjectionInput) {
  return {
    sessionId: input.context.sessionId,
    turnId: input.context.turnId,
    turnSequence: input.context.turnSequence,
    eventId: input.event.event_id,
    ...(typeof input.event.runtime_seq === 'number' ? { runtimeSeq: input.event.runtime_seq } : {}),
  };
}

function terminalOutcome(event: RuntimeEvent): 'completed' | 'failed' | 'aborted' | undefined {
  if (
    event.type !== RuntimeEventType.SESSION_STATUS &&
    event.type !== RuntimeEventType.TURN_TERMINAL
  ) {
    return undefined;
  }
  if (event.payload.status === RuntimeEventStatus.COMPLETED) return 'completed';
  if (event.payload.status === RuntimeEventStatus.FAILED) return 'failed';
  return event.payload.status === RuntimeEventStatus.ABORTED ? 'aborted' : undefined;
}

function terminalFrameData(
  event: RuntimeEvent,
  status: 'completed' | 'failed' | 'aborted',
): Readonly<Record<string, unknown>> {
  const error = terminalError(event);
  return {
    status,
    ...(error?.message ? { error: error.message } : {}),
    ...(error?.code !== undefined ? { errorCode: error.code } : {}),
    ...(error?.details ? { detail: error.details } : {}),
  };
}

function terminalError(event: RuntimeEvent):
  | {
      readonly message?: string;
      readonly code?: number;
      readonly details?: string;
      readonly errorSource?: 'agent-runtime';
    }
  | undefined {
  const protocolError = event.payload.error;
  const stopReasonMessage =
    event.payload.status === RuntimeEventStatus.FAILED &&
    event.payload.stop_reason?.type === RuntimeStopReasonType.ERROR
      ? event.payload.stop_reason.message
      : undefined;
  const message = protocolError?.message || stopReasonMessage;
  if (!protocolError && !message) return undefined;
  return {
    ...(message ? { message } : {}),
    ...(protocolError?.code !== undefined ? { code: protocolError.code } : {}),
    ...(protocolError?.details !== undefined ? { details: protocolError.details } : {}),
    ...(protocolError ? { errorSource: 'agent-runtime' as const } : {}),
  };
}

function isSessionStatus(event: RuntimeEvent, status: RuntimeEventStatus): boolean {
  return (
    (event.type === RuntimeEventType.SESSION_STATUS ||
      event.type === RuntimeEventType.TURN_TERMINAL) &&
    event.payload.status === status
  );
}

function assertStateWrite(status: string): void {
  if (status !== 'applied' && status !== 'duplicate') {
    throw new Error(`Session Agent state projection rejected: ${status}`);
  }
}

function streamResponseData(event: RuntimeEvent): string | undefined {
  if (event.type !== RuntimeEventType.STREAM_RESP) return undefined;
  const raw = event.payload.stream_resp;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function streamProjectionData(
  options: Pick<SessionSystemAgentProjectionOptions, 'steeringProjection'>,
  input: SessionAgentProjectionInput,
  queryKey: string | undefined,
): string | undefined {
  const raw = streamResponseData(input.event);
  if (!raw) return undefined;
  let response: unknown;
  try {
    response = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!isRecord(response)) return raw;
  const messageField = streamMessageField(response);
  if (!messageField || !isRecord(response[messageField])) return raw;
  return JSON.stringify({
    ...response,
    [messageField]: {
      ...response[messageField],
      turn_id: input.context.turnId,
      ...(queryKey ? { query_key: queryKey } : {}),
      ...(queryKey ? (options.steeringProjection?.(queryKey) ?? {}) : {}),
    },
  });
}

async function queryKeyForTurn(
  options: SessionSystemAgentProjectionOptions,
  context: Pick<SessionAgentEventContext, 'sessionId' | 'turnId'>,
): Promise<string | undefined> {
  try {
    return await options.queryKeyForTurn?.(context.sessionId, context.turnId);
  } catch {
    return undefined;
  }
}

async function projectQueryCollapse(
  project: () => Promise<void> | void | undefined,
): Promise<void> {
  try {
    await project();
  } catch {
    // The sidecar is a display projection and must not change Session/Turn durability.
  }
}

function streamMessageField(
  response: Readonly<Record<string, unknown>>,
): 'agent_message' | 'agent_message_chunk' | undefined {
  if (response.type === RespDataType.AgentMessage) return 'agent_message';
  if (response.type === RespDataType.AgentMessageChunk) return 'agent_message_chunk';
  return undefined;
}

function displayMessage(event: RuntimeEvent): AgentMessage | undefined {
  const raw = streamResponseData(event);
  if (!raw) return undefined;
  try {
    const response: unknown = JSON.parse(raw);
    if (!isRecord(response) || response.type !== RespDataType.AgentMessage) return undefined;
    const message = response.agent_message;
    return isAgentMessage(message) ? message : undefined;
  } catch {
    return undefined;
  }
}

function isAgentMessage(value: unknown): value is AgentMessage {
  return isRecord(value) && typeof value.msg_id === 'string' && value.msg_id.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTerminalAssistantDisplayError(message: AgentMessage): boolean {
  return message.role === Role.Assistant && finishReason(message) === 'error';
}

function finishReason(message: AgentMessage): string | undefined {
  if (message.finish_reason) return message.finish_reason;
  const value = Reflect.get(message, 'finishReason');
  return typeof value === 'string' ? value : undefined;
}

async function writeCompactionFact(
  options: SessionSystemAgentProjectionOptions,
  input: SessionCompactionDisplayInput,
  kind: 'compaction_start' | 'compaction' | 'compaction_failed',
): Promise<void> {
  const contextUsage = readCommittedContextUsage(input, kind);
  const message = {
    msg_id: `compaction-${input.attemptId}`,
    role: 'assistant',
    kind,
    timestamp: (options.nowMs ?? Date.now)(),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(contextUsage ? { context_usage: contextUsage } : {}),
    ...(kind === 'compaction_failed' && input.error !== undefined
      ? { error: describeError(input.error) }
      : {}),
    ...(input.committedRevision !== undefined && input.operationId !== undefined
      ? {
          operationId: input.operationId,
          committedRevision: input.committedRevision,
        }
      : {}),
  } as const;
  await options.messages.upsert({
    sessionId: input.context.sessionId,
    turnId: input.context.turnId,
    message,
    source: input.context.provenance?.source ?? 'agent',
  });
  options.stream.write({
    identity: `compaction:${input.attemptId}:${kind}`,
    sessionId: input.context.sessionId,
    turnId: input.context.turnId,
    kind: 'message-committed',
    data: { messages: [message] },
  });
}

function readCommittedContextUsage(
  input: SessionCompactionDisplayInput,
  kind: 'compaction_start' | 'compaction' | 'compaction_failed',
): SessionPostCompactionContextUsage | undefined {
  return kind === 'compaction' && isRecord(input.metadata)
    ? readContextUsage(input.metadata.contextUsage)
    : undefined;
}

function readContextUsage(value: unknown): SessionPostCompactionContextUsage | undefined {
  if (!isRecord(value)) return undefined;
  const contextWindowTokens = readNonNegativeNumber(value.contextWindowTokens);
  const usedTokens = readNonNegativeNumber(value.usedTokens);
  if (
    contextWindowTokens === undefined ||
    usedTokens === undefined ||
    value.totalCountSource !== 'LOCAL_ESTIMATE'
  ) {
    return undefined;
  }
  const components = readContextUsageComponents(value.components);
  if (!components) return undefined;
  return {
    contextWindowTokens,
    usedTokens,
    totalCountSource: 'LOCAL_ESTIMATE',
    components,
  };
}

function readContextUsageComponents(value: unknown): readonly ContextUsageComponent[] | undefined {
  if (!Array.isArray(value) || value.length !== CONTEXT_USAGE_COMPONENT_KINDS.length) {
    return undefined;
  }
  const components = value.flatMap((component): ContextUsageComponent[] => {
    if (!isRecord(component) || !isContextUsageComponentKind(component.kind)) return [];
    const tokens = readNonNegativeNumber(component.tokens);
    return tokens === undefined ? [] : [{ kind: component.kind, tokens }];
  });
  return components.length === CONTEXT_USAGE_COMPONENT_KINDS.length &&
    new Set(components.map((component) => component.kind)).size ===
      CONTEXT_USAGE_COMPONENT_KINDS.length
    ? components
    : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isContextUsageComponentKind(value: unknown): value is ContextUsageComponentKind {
  return CONTEXT_USAGE_COMPONENT_KINDS.some((kind) => kind === value);
}

interface SessionCompactionDisplayInput {
  readonly context: SessionAgentEventContext;
  readonly attemptId: string;
  readonly operationId?: string;
  readonly committedRevision?: string;
  readonly metadata?: unknown;
  readonly error?: unknown;
}

function createCompactionProjectionLane() {
  const tails = new Map<string, Promise<void>>();
  return {
    async run<T>(attemptId: string, operation: () => Promise<T>): Promise<T> {
      const previous = tails.get(attemptId) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(attemptId, current);
      try {
        await previous;
        return await operation();
      } finally {
        release();
        if (tails.get(attemptId) === current) tails.delete(attemptId);
      }
    },
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
