import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { pausesQueueOnAbort } from '../queue-pause-on-abort.js';

import { createUserMessageId, isQueueMessageSource } from '../../../session-system/index.js';
import type {
  CommittedQueueCapability,
  QueueImmediateSendBatch,
  QueueEnqueueInput,
  QueueMessageAttachment,
  QueueModelOverride,
} from '../../../session-system/index.js';
import { isUserSteeringProducer } from '../../agent-host/contracts.js';
import type { AgentHostSteeringMessage } from '../../agent-host/contracts.js';
import type { TurnReleasedSignal } from '../../lifecycle/turn-released-signal.js';

export interface SteeringRequeueOptions {
  readonly queue: Pick<
    CommittedQueueCapability,
    'requireMutableSession' | 'enqueue' | 'pauseIfPending'
  >;
  readonly released: Pick<TurnReleasedSignal, 'publish'>;
  /**
   * Decision v5 fall-to-session sink: commits admitted-but-unconsumed user
   * steering of an abnormally ended Turn into the conversation (display row +
   * canonical history row). When missing, teardown batches degrade to the
   * requeue lane so no admitted message is ever dropped.
   */
  readonly teardown?: SteeringTeardownSink;
  readonly logger?: {
    warn(fields: Record<string, unknown>, message: string): void;
  };
}

interface SteeringTeardownSink {
  /** Resolves true only when every message is durably in the conversation. */
  commit(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly messages: readonly AgentHostSteeringMessage[];
    /**
     * Optional per-message durability progress (see `SteeringTeardownCommit`).
     * A sink that never reports keeps the whole-batch fallback semantics.
     */
    readonly onCommitted?: (message: AgentHostSteeringMessage) => void;
  }): Promise<boolean>;
}

/** Why the Turn handed its unconsumed steering over (Decision v5). */
type DiscardedSteeringCause = 'abort' | 'abnormal-seal' | 'exit-close';

export interface DiscardedSteeringBatch {
  readonly sessionId: string;
  readonly turnId: string;
  readonly messages: readonly AgentHostSteeringMessage[];
  /**
   * Teardown discriminator. `exit-close` keeps the v2 requeue+wake lane;
   * `abort` and `abnormal-seal` fall into the conversation. A missing cause
   * degrades by abortReason presence instead of throwing.
   */
  readonly cause?: DiscardedSteeringCause;
  /** Raw abort reason when the discard came from an abort; closes carry none. */
  readonly abortReason?: string;
  /** Resolves once the aborted Turn's Session ownership is settled and released. */
  readonly turnReleased: Promise<void>;
}

export interface SteeringRequeue {
  /** Detached entry point for Turn teardown; schedules one tracked requeue. */
  readonly discard: (batch: DiscardedSteeringBatch) => void;
  /**
   * Decision v5 pre-release commit: called by the execution coordinator after
   * the aborted Turn's Host outcome resolved (assistant tail already
   * reconciled) and before its terminal settlement and Session ownership
   * release, so the next admitted Turn reads the fallen steering rows. Every
   * pending teardown batch of the Turn merges into one send-ordered commit.
   * Bounded and never throws: on failure or timeout the detached
   * post-release lane and the requeue fallback keep ownership of the batch.
   */
  readonly commitDiscardedBeforeRelease: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly timeoutMs?: number;
  }) => Promise<void>;
  /**
   * Resolves once every scheduled requeue has finished persisting. Shutdown
   * must await this before the SessionSystem and database close, or an
   * admitted-and-acknowledged user message dies with the process. The wake
   * publication stays outside the drain: it awaits `turnReleased`, which a
   * timed-out shutdown abort may never resolve, and the persisted items are
   * recovered by the next process regardless.
   */
  readonly drain: () => Promise<void>;
}

// Wake publications may legitimately outlive `drain` — they await
// `turnReleased`, which a timed-out shutdown abort never resolves — and they
// manage their own errors; collecting them makes the detach explicit.
const detachedWakes = new WeakSet<Promise<void>>();

/** Upper bound for the pre-release commit; release liveness beats the write. */
const PRERELEASE_COMMIT_TIMEOUT_MS = 2_000;

interface TrackedDiscard {
  readonly batch: DiscardedSteeringBatch;
  /** Mutable: partial teardown progress trims the already-durable prefix. */
  messages: readonly AgentHostSteeringMessage[];
  /** Mutable: a failed teardown flips to 'requeue' as the last-resort lane. */
  route: 'teardown' | 'requeue';
}

/**
 * Routes admitted-but-unconsumed user steering of an ended Turn (Decision v5):
 * exit-close batches return to the Session queue as queued items and wake the
 * dispatcher; abort/abnormal-seal batches fall into the conversation instead.
 * Non-user producers keep drop semantics on both lanes.
 */
export function createSteeringRequeue(options: SteeringRequeueOptions): SteeringRequeue {
  const inflight = new Map<string, Promise<void>>();
  const settled = new WeakMap<Promise<void>, Set<string>>();
  const pending = new Map<string, TrackedDiscard>();

  // Never rejects: the persist lanes shield their own failures and the wake
  // is detached above, so `drain` can `Promise.all` the tracked entries safely.
  const persistTracked = async (key: string, retry: TrackedDiscard): Promise<void> => {
    try {
      if (retry.route === 'teardown') {
        const { committed, committedIdentities } = await persistTeardown(
          options,
          retry.batch,
          retry.messages,
        );
        // Trim the durable prefix so a retry resumes at the failure position
        // and the requeue fallback cannot duplicate committed identities. An
        // all-committed report counts as success even when the sink reported
        // failure afterwards: nothing is left to retry or requeue.
        retry.messages = withoutCommitted(retry.messages, committedIdentities);
        if (committed || retry.messages.length === 0) {
          pending.delete(key);
          markSettled(settled, retry.batch, key);
        }
        return;
      }
      const committed = await persistRequeue(options, retry.batch, retry.messages);
      if (committed > 0) {
        pending.delete(key);
        markSettled(settled, retry.batch, key);
        // Only the exit-close lane wakes dispatch. A teardown batch that fell
        // back here after failed conversation commits stays parked as a queued
        // item: settlement may already have judged an empty queue, and a wake
        // would auto-dispatch the instruction the user just stopped. The
        // user-stop pause restore lives inside `persistRequeue`.
        if (resolveCause(retry.batch) === 'exit-close') {
          detachedWakes.add(wakeQueueAfterRelease(options, retry.batch));
        }
      }
    } finally {
      inflight.delete(key);
    }
  };

  const start = (key: string, retry: TrackedDiscard): Promise<void> => {
    const running = inflight.get(key);
    if (running) return running;
    const task = persistTracked(key, retry);
    inflight.set(key, task);
    return task;
  };

  // Decision v5 pre-release lane: every pending teardown batch of one Turn
  // commits as a single send-ordered write, so a restore+abort discard order
  // can never reorder the canonical rows (TS-76). Never rejects.
  const commitMergedTeardown = async (
    entries: readonly (readonly [string, TrackedDiscard])[],
  ): Promise<void> => {
    try {
      const [, first] = entries[0]!;
      const messages = entries
        .flatMap(([, retry]) => retry.messages)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      const { committed, committedIdentities } = await persistTeardown(
        options,
        first.batch,
        messages,
      );
      for (const [key, retry] of entries) {
        // A partially committed merge settles the fully durable batches and
        // trims the rest, so their retries and fallbacks skip fallen rows.
        retry.messages = withoutCommitted(retry.messages, committedIdentities);
        if (!committed && retry.messages.length > 0) continue;
        pending.delete(key);
        markSettled(settled, retry.batch, key);
      }
    } finally {
      for (const [key] of entries) inflight.delete(key);
    }
  };

  return {
    discard(batch) {
      const messages = batch.messages
        .flatMap((message) => message.batchMembers ?? [message])
        .filter((message) => isUserSteeringProducer(message.producerId))
        .map((message) => ({ ...message, createdAt: message.createdAt ?? Date.now() }));
      if (messages.length === 0) return;
      const key = batchIdentity(batch, messages);
      if (pending.has(key) || settled.get(batch.turnReleased)?.has(key)) return;
      const retry: TrackedDiscard = { batch, messages, route: resolveRoute(batch) };
      pending.set(key, retry);
      if (retry.route === 'requeue') {
        const firstAttempt = start(key, retry);
        // Settlement is the normal handoff boundary; it also resolves claimed
        // send-now rows before one bounded retry. Shutdown is a separate fallback.
        detachedWakes.add(
          (async () => {
            try {
              await batch.turnReleased;
              await firstAttempt;
              if (pending.has(key)) await start(key, retry);
            } catch {
              // A rejected release leaves the in-memory batch for drain.
            }
          })(),
        );
        return;
      }
      // Fall-to-session normally lands through the coordinator's pre-release
      // `commitDiscardedBeforeRelease` call (after the assistant tail
      // reconciled, before admission opens). This detached lane is the
      // post-release fallback for a failed or timed-out pre-release commit.
      // Shutdown never waits — `drain` forces the commit instead.
      detachedWakes.add(
        (async () => {
          try {
            await batch.turnReleased;
          } catch {
            // A rejected release still tears the Turn down; commit anyway.
          }
          if (pending.has(key)) await start(key, retry);
          if (pending.has(key)) await start(key, retry);
          if (pending.has(key)) {
            // Bounded retries exhausted: return to the queue rather than
            // dropping an admitted user message (the only non-exit-close
            // requeue remnant, Decision v5 rule 4).
            retry.route = 'requeue';
            await start(key, retry);
          }
        })(),
      );
    },
    async commitDiscardedBeforeRelease({ sessionId, turnId, timeoutMs }) {
      if (!options.teardown) return;
      const { waits, ready } = collectPreReleaseWork(pending, inflight, sessionId, turnId);
      if (ready.length > 0) {
        const task = commitMergedTeardown(ready);
        for (const [key] of ready) inflight.set(key, task);
        waits.push(task);
      }
      if (waits.length === 0) return;
      await boundedSettle(Promise.all(waits), timeoutMs ?? PRERELEASE_COMMIT_TIMEOUT_MS);
    },
    async drain() {
      await Promise.all([...inflight.values()]);
      // Shutdown commits sequentially; send order across batches of the same
      // Turn follows the earliest admitted member, not the discard order.
      for (const [key, retry] of drainOrder(pending)) {
        await start(key, retry);
        if (retry.route === 'teardown' && pending.has(key)) {
          retry.route = 'requeue';
          await start(key, retry);
        }
      }
      await Promise.all([...inflight.values()]);
    },
  };
}

/** A missing cause degrades by abortReason presence instead of throwing. */
function resolveCause(batch: DiscardedSteeringBatch): DiscardedSteeringCause {
  return batch.cause ?? (batch.abortReason !== undefined ? 'abort' : 'exit-close');
}

/** Splits a Turn's pending teardown batches into already-running and mergeable work. */
function collectPreReleaseWork(
  pending: ReadonlyMap<string, TrackedDiscard>,
  inflight: ReadonlyMap<string, Promise<void>>,
  sessionId: string,
  turnId: string,
): { readonly waits: Promise<void>[]; readonly ready: [string, TrackedDiscard][] } {
  const waits: Promise<void>[] = [];
  const ready: [string, TrackedDiscard][] = [];
  for (const [key, retry] of pending) {
    if (retry.route !== 'teardown') continue;
    if (retry.batch.sessionId !== sessionId || retry.batch.turnId !== turnId) continue;
    const running = inflight.get(key);
    if (running) {
      waits.push(running);
      continue;
    }
    ready.push([key, retry]);
  }
  return { waits, ready };
}

/** Bounded, non-throwing wait: a hung or failed commit never blocks release. */
async function boundedSettle(pendingWork: Promise<unknown>, timeoutMs: number): Promise<void> {
  const swallowed = async (): Promise<void> => {
    try {
      await pendingWork;
    } catch {
      // Failures stay owned by the tracked lanes; this wait only bounds them.
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      swallowed(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(1, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function drainOrder(pending: ReadonlyMap<string, TrackedDiscard>): [string, TrackedDiscard][] {
  return [...pending].sort(
    ([, a], [, b]) => earliestCreatedAt(a.messages) - earliestCreatedAt(b.messages),
  );
}

function earliestCreatedAt(messages: readonly AgentHostSteeringMessage[]): number {
  return messages.reduce(
    (earliest, message) => Math.min(earliest, message.createdAt ?? Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
}

function resolveRoute(batch: DiscardedSteeringBatch): TrackedDiscard['route'] {
  return resolveCause(batch) === 'exit-close' ? 'requeue' : 'teardown';
}

function markSettled(
  settled: WeakMap<Promise<void>, Set<string>>,
  batch: DiscardedSteeringBatch,
  key: string,
): void {
  const completed = settled.get(batch.turnReleased) ?? new Set<string>();
  completed.add(key);
  settled.set(batch.turnReleased, completed);
}

interface TeardownProgress {
  readonly committed: boolean;
  /** Identities of messages the sink reported as durably committed. */
  readonly committedIdentities: ReadonlySet<string>;
}

async function persistTeardown(
  options: SteeringRequeueOptions,
  batch: DiscardedSteeringBatch,
  messages: readonly AgentHostSteeringMessage[],
): Promise<TeardownProgress> {
  const committedIdentities = new Set<string>();
  if (!options.teardown) {
    // No sink wired: degrade to the requeue lane rather than losing input.
    options.logger?.warn(
      { sessionId: batch.sessionId, turnId: batch.turnId },
      'Steering teardown sink is missing; falling back to the queue lane',
    );
    return { committed: false, committedIdentities };
  }
  try {
    if (
      await options.teardown.commit({
        sessionId: batch.sessionId,
        turnId: batch.turnId,
        messages,
        onCommitted: (message) => {
          // A malformed report is ignored: an untrimmed message only risks a
          // duplicate on the fallback lane, never a lost user message.
          const identity = messageIdentity(message);
          if (identity !== undefined) committedIdentities.add(identity);
        },
      })
    ) {
      return { committed: true, committedIdentities };
    }
  } catch (error) {
    options.logger?.warn(
      {
        sessionId: batch.sessionId,
        turnId: batch.turnId,
        producerIds: messages.map((message) => message.producerId),
        error: `${error}`,
      },
      'Unconsumed steering could not be committed into the conversation',
    );
  }
  return { committed: false, committedIdentities };
}

/** Identity used to match teardown progress against tracked batch members. */
function messageIdentity(message: AgentHostSteeringMessage): string | undefined {
  if (typeof message?.producerId !== 'string' || typeof message.idempotencyKey !== 'string') {
    return undefined;
  }
  return JSON.stringify([message.producerId, message.idempotencyKey]);
}

/**
 * Drops members the teardown already committed into the conversation so
 * retries and the fallback requeue cannot resend them. Missing or malformed
 * progress keeps the full batch: a duplicate beats a dropped user message.
 */
function withoutCommitted(
  messages: readonly AgentHostSteeringMessage[],
  committedIdentities: ReadonlySet<string>,
): readonly AgentHostSteeringMessage[] {
  if (committedIdentities.size === 0) return messages;
  return messages.filter((message) => {
    const identity = messageIdentity(message);
    return identity === undefined || !committedIdentities.has(identity);
  });
}

async function persistRequeue(
  options: SteeringRequeueOptions,
  batch: DiscardedSteeringBatch,
  messages: readonly AgentHostSteeringMessage[],
): Promise<number> {
  let committed = 0;
  try {
    const session = await options.queue.requireMutableSession(batch.sessionId);
    const result = await options.queue.enqueue(
      toBatchRequeueInput(batch, session.agentName, messages),
    );
    if (result === undefined) throw new Error('Immediate-send batch enqueue rejected');
    // A user stop or session leave that fell back to the queue must leave the queue
    // paused exactly like Stop over pending items: settlement may have judged
    // the pause with an empty queue before this detached requeue landed, and
    // without the pause a later wake would auto-dispatch the instruction the
    // user just stopped. Exit-close batches never carry an abortReason, so
    // the wake lane is unaffected. A pause failure keeps this persist
    // uncommitted so the batch stays on the pending/drain retry lanes — the
    // enqueued row is durable and a retried enqueue of the same identity is
    // absorbed by the queue's clientRequestId replay / itemId restore, so the
    // replay costs one write and buys back the lost pause. Pausing real
    // queued items at settlement stays with the execution coordinator.
    if (pausesQueueOnAbort(batch.abortReason)) {
      await options.queue.pauseIfPending({
        sessionId: batch.sessionId,
        cause: 'user-stop',
        triggerTurnId: batch.turnId,
      });
    }
    committed = 1;
  } catch (error) {
    // Keep this admitted batch in memory for a later hand-off/drain retry.
    // Only successfully persisted items are promised across process restart.
    options.logger?.warn(
      {
        sessionId: batch.sessionId,
        turnId: batch.turnId,
        producerIds: messages.map((message) => message.producerId),
        error: `${error}`,
      },
      'Aborted Turn steering could not be returned to the Session queue',
    );
  }
  return committed;
}

function batchIdentity(
  batch: DiscardedSteeringBatch,
  messages: readonly AgentHostSteeringMessage[],
): string {
  return `steer-batch:${createHash('sha256')
    .update(
      JSON.stringify([
        batch.sessionId,
        batch.turnId,
        messages.map((message) => [message.producerId, message.idempotencyKey]),
      ]),
    )
    .digest('hex')}`;
}

function toBatchRequeueInput(
  batch: DiscardedSteeringBatch,
  agentName: string,
  messages: readonly AgentHostSteeringMessage[],
): QueueEnqueueInput {
  const id = batchIdentity(batch, messages);
  const members: QueueImmediateSendBatch['members'] = messages.map((message) => {
    const input = toRequeueInput(batch.sessionId, agentName, message);
    const messageKey =
      message.messageKey ?? `steer:${message.producerId}:${message.idempotencyKey}`;
    return {
      message: input.message,
      userMessageId:
        message.userMessageId ?? createUserMessageId({ sessionId: batch.sessionId, messageKey }),
      messageKey,
      ...(message.unstartedFromTurnIds?.length
        ? { unstartedFromTurnIds: message.unstartedFromTurnIds }
        : {}),
      unconsumedFromTurnIds: [...new Set([...(message.unconsumedFromTurnIds ?? []), batch.turnId])],
      ...(message.queueClaim ? { queueClaim: message.queueClaim } : {}),
      createdAt: message.createdAt ?? Date.now(),
      ...(message.sourceMessageId ? { sourceMessageId: message.sourceMessageId } : {}),
      provenance: {
        ...message.provenance,
        source: isQueueMessageSource(message.provenance.source) ? message.provenance.source : 'api',
      },
      ...(input.model ? { model: input.model } : {}),
    };
  });
  const first = members[0]!;
  const model = [...members].reverse().find((member) => member.model)?.model;
  return {
    ...toRequeueInput(batch.sessionId, agentName, messages[0]!),
    itemId: messages[0]!.queueClaim?.itemId ?? messages[0]!.sourceMessageId ?? id,
    clientRequestId: id,
    userMessageId: first.userMessageId,
    createdAt: first.createdAt,
    immediateSendBatch: { id, members },
    message: batchQueueMessage(members),
    ...(model ? { model } : {}),
  };
}

function batchQueueMessage(
  members: QueueImmediateSendBatch['members'],
): QueueEnqueueInput['message'] {
  if (members.length === 1) return members[0]!.message;
  return {
    content: members.map((member) => member.message.content).join('\n\n'),
    attachments: members.flatMap((member) => member.message.attachments),
    hideUserMessage: members.every((member) => member.message.hideUserMessage === true),
    ...(members.some((member) => member.message.displayContent !== undefined)
      ? {
          displayContent: members
            .map((member) => member.message.displayContent ?? member.message.content)
            .join('\n\n'),
        }
      : {}),
    ...(members.some((member) => member.message.displayAttachments !== undefined)
      ? {
          displayAttachments: members.flatMap(
            (member) =>
              member.message.displayAttachments ??
              member.message.attachments.map((attachment) => ({ ...attachment })),
          ),
        }
      : {}),
  };
}

/**
 * An aborted Turn settles without publishing a Queue wake, and enqueue only
 * records committed facts, so an idle dispatcher would never see the requeued
 * items. Publish one wake — after the Turn released its Session ownership so
 * dispatch cannot lose an `active-turn` admission race against settlement.
 */
async function wakeQueueAfterRelease(
  options: SteeringRequeueOptions,
  batch: DiscardedSteeringBatch,
): Promise<void> {
  try {
    await batch.turnReleased;
    await options.released.publish(batch.sessionId);
  } catch {
    // The requeued items are durable; a later Queue wake retries dispatch.
  }
}

function toRequeueInput(
  sessionId: string,
  agentName: string,
  message: AgentHostSteeringMessage,
): QueueEnqueueInput {
  const input = message.message;
  const delivery = message.delivery;
  const origin = message.provenance.sourceContext?.origin ?? input.origin;
  return {
    session: { sessionId, agentName },
    ...toRequeueIdentity(message),
    source: 'api',
    queuePlacement: 'front',
    message: {
      content: input.text,
      attachments: (input.attachments ?? []).flatMap(toRequeueAttachment),
      ...(delivery?.hideUserMessage !== undefined
        ? { hideUserMessage: delivery.hideUserMessage }
        : {}),
      ...(delivery?.displayContent !== undefined
        ? { displayContent: delivery.displayContent }
        : {}),
      ...(delivery?.displayAttachments ? { displayAttachments: delivery.displayAttachments } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(input.quotedMessage ? { quotedMessage: { ...input.quotedMessage } } : {}),
    },
    // Activation-only delivery stripped the explicit model before the join;
    // the requeued follow-up query must restore the user's choice.
    ...toRequeueModel(message.requeueModel ?? input.model),
  };
}

/**
 * A send-now steer consumed a Queue item; restoring that identity keeps the
 * dispatched user row on the sourceMessageId the client's optimistic bubble
 * reconciles against (otherwise the same send renders twice).
 */
function toRequeueIdentity(
  message: AgentHostSteeringMessage,
): Pick<QueueEnqueueInput, 'itemId' | 'userMessageId'> {
  return {
    ...(message.sourceMessageId ? { itemId: message.sourceMessageId } : {}),
    ...(message.userMessageId ? { userMessageId: message.userMessageId } : {}),
  };
}

function toRequeueModel(
  model: AgentHostSteeringMessage['message']['model'],
): Pick<QueueEnqueueInput, 'model'> {
  if (!model) return {};
  const override: QueueModelOverride = {
    ...(model.providerId ? { provider_id: model.providerId } : {}),
    ...(model.modelId ? { model_id: model.modelId } : {}),
    ...(model.parameterSnapshot ? { parameterSnapshot: model.parameterSnapshot } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.contextLimit !== undefined ? { context_limit: model.contextLimit } : {}),
    ...(model.variant !== undefined ? { variant: model.variant } : {}),
    ...(model.thinking !== undefined
      ? { thinking: model.thinking.effort != null ? { effort: model.thinking.effort } : {} }
      : {}),
  };
  return { model: override };
}

type SteeringAttachment = NonNullable<AgentHostSteeringMessage['message']['attachments']>[number];

function toRequeueAttachment(input: SteeringAttachment): QueueMessageAttachment[] {
  const filePath = (input.filePath ?? '').trim();
  const optional = optionalAttachmentFields(input);
  if (!filePath && !optional.dataUrl && !optional.assetId && !optional.error) return [];
  const mimeType = (input.mimeType ?? '').trim();
  return [
    {
      type: requeueAttachmentType(input.type, mimeType),
      fileName: requeueAttachmentFileName(input.fileName, filePath),
      mimeType,
      filePath,
      ...optional,
    },
  ];
}

function optionalAttachmentFields(
  input: SteeringAttachment,
): Pick<QueueMessageAttachment, 'dataUrl' | 'assetId' | 'error'> {
  const dataUrl = input.dataUrl?.trim();
  return {
    ...(dataUrl ? { dataUrl } : {}),
    ...(input.assetId ? { assetId: input.assetId } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function requeueAttachmentType(
  type: SteeringAttachment['type'],
  mimeType: string,
): QueueMessageAttachment['type'] {
  return type === 'image' || mimeType.startsWith('image/') ? 'image' : 'file';
}

function requeueAttachmentFileName(fileName: string | undefined, filePath: string): string {
  return fileName?.trim() || basename(filePath) || 'attachment';
}
