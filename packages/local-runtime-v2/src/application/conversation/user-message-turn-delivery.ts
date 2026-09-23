import { parsePluginMentions } from '@mavis/shared/plugin-mention';
import { randomUUID } from 'node:crypto';

import {
  UserMessageCommitAdmissionError,
  UserMessageCommitConflictError,
  retryUserMessageCommit,
  writeQueryCollapseView,
  type CommittedUserMessage,
  type QueryCollapseViewState,
  type SessionStreamService,
  type UserMessageAttachment,
  type UserMessageCommitService,
  type UserMessageId,
  type QueueImmediateSendBatch,
} from '../../service/session-system/index.js';
import {
  isUserSteeringProducer,
  resolveGenuineUserQueryText,
  type ActivateTurnResult,
  type AgentHostSteeringMessage,
  type SubmitTurnSubmission,
} from '../../service/turn-system/index.js';
import { queryCollapseQueryKey } from './query-collapse-identity.js';

const STEERED_USER_MESSAGE_KIND = 'steered_user';

interface UserMessageTurnAdmission {
  readonly requestedTurnId: string;
  readonly executionStart: Promise<void>;
  readonly genuineUserQueryText: string;
  readonly requiresInputReview: boolean;
}

export interface UserMessageTurnDeliveryInput {
  /** Queue owns retryable input until the Host start fence is released. */
  readonly propagateDeliveryFailure?: true;
  readonly unstartedFromTurnIds?: readonly string[];
  readonly beforeSubmit?: (turnId: string) => Promise<void>;
  readonly immediateSendBatch?: QueueImmediateSendBatch;
  readonly createdAt?: number;
  readonly sessionId: string;
  readonly input: SubmitTurnSubmission['input'];
  readonly provenance: SubmitTurnSubmission['provenance'];
  readonly requestedTurnId?: string;
  readonly messageKey?: string;
  readonly sourceMessageId?: string;
  readonly clientIntent?: string;
  readonly userMessageId?: UserMessageId;
  readonly hideUserMessage?: boolean;
  readonly displayContent?: string;
  readonly displayAttachments?: readonly UserMessageAttachment[];
  readonly submit: (input: UserMessageTurnAdmission) => Promise<ActivateTurnResult>;
  readonly onAccepted?: (
    result: Extract<ActivateTurnResult, { readonly accepted: true }>,
  ) => void | Promise<void>;
  readonly beforeStart?: () => void | Promise<void>;
}

export interface ConsumedSteeringMessageInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly message: AgentHostSteeringMessage;
}

export interface UserMessageTurnDelivery {
  deliver(input: UserMessageTurnDeliveryInput): Promise<ActivateTurnResult>;
  consumeSteering(input: ConsumedSteeringMessageInput): Promise<void>;
}

export interface UserMessageTurnDeliveryServiceOptions {
  readonly messages: Pick<UserMessageCommitService, 'commit'>;
  readonly stream: Pick<SessionStreamService, 'write'>;
  readonly queryCollapse: {
    readonly resolveQueryKey: (
      sessionId: string,
      turnId: string,
      input?: { readonly reuseLatestVisibleQuery: boolean },
    ) => Promise<string>;
    readonly start: (input: {
      readonly sessionId: string;
      readonly queryKey: string;
      readonly currentTurnId: string;
    }) => Promise<QueryCollapseViewState>;
  };
  readonly beforeExecution?: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly provenance: SubmitTurnSubmission['provenance'];
  }) => void | Promise<void>;
  readonly makeTurnId?: () => string;
}

/** Commits visible user Messages only after durable Turn acceptance or steer consumption. */
export class UserMessageTurnDeliveryService implements UserMessageTurnDelivery {
  private readonly makeTurnId: () => string;

  constructor(private readonly options: UserMessageTurnDeliveryServiceOptions) {
    this.makeTurnId = options.makeTurnId ?? (() => `turn_${randomUUID()}`);
  }

  deliver(input: UserMessageTurnDeliveryInput): Promise<ActivateTurnResult> {
    return executeDelivery(this.options, {
      ...input,
      requestedTurnId: input.requestedTurnId ?? this.makeTurnId(),
    });
  }

  async consumeSteering(input: ConsumedSteeringMessageInput): Promise<void> {
    const delivery = input.message.delivery;
    if (!shouldProjectMessage(delivery)) return;
    const attachments = deliveryAttachments(delivery, input.message.message.attachments);
    const queryKey = await resolveQueryKeyForTurn(this.options, input.sessionId, input.turnId);
    const commit = await commitMessage(this.options, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      queryKey,
      ...(isUserSteeringProducer(input.message.producerId)
        ? { kind: STEERED_USER_MESSAGE_KIND }
        : {}),
      messageKey:
        input.message.messageKey ??
        `steer:${input.message.producerId}:${input.message.idempotencyKey}`,
      ...(input.message.unconsumedFromTurnIds
        ? { unconsumedFromTurnIds: input.message.unconsumedFromTurnIds }
        : {}),
      ...(input.message.userMessageId ? { userMessageId: input.message.userMessageId } : {}),
      unstartedFromTurnIds: input.message.unstartedFromTurnIds,
      content: projectedMessageContent(delivery, input.message.message.text),
      inputContent: input.message.message.text,
      ...(attachments ? { attachments } : {}),
      ...(input.message.sourceMessageId ? { sourceMessageId: input.message.sourceMessageId } : {}),
      provenance: input.message.provenance,
      ...(input.message.createdAt !== undefined ? { timestamp: input.message.createdAt } : {}),
    });
    projectCommitted(this.options, commit);
  }
}

type PreparedDeliveryInput = UserMessageTurnDeliveryInput & {
  readonly requestedTurnId: string;
};

async function executeDelivery(
  options: UserMessageTurnDeliveryServiceOptions,
  input: PreparedDeliveryInput,
): Promise<ActivateTurnResult> {
  const start = createStartFence();
  const visibleQuery = shouldProjectMessage(input);
  let accepted: Extract<ActivateTurnResult, { readonly accepted: true }> | undefined;
  try {
    const requiresInputReview = shouldProjectMessage(input);
    const genuineUserQueryText = resolveGenuineUserQueryText({
      input: input.input,
      provenance: input.provenance,
      delivery: input,
    });
    await input.beforeSubmit?.(input.requestedTurnId);
    const result = await input.submit({
      requestedTurnId: input.requestedTurnId,
      executionStart: start.promise,
      genuineUserQueryText,
      requiresInputReview,
    });
    if (!result.accepted) {
      start.release();
      await repairDuplicateMessage(options, input, result);
      return result;
    }
    accepted = result;
    await completeAcceptedDelivery(options, input, result, visibleQuery);
    start.release();
    return result;
  } catch (error) {
    if (accepted && input.propagateDeliveryFailure) {
      start.fail(error);
      throw error;
    }
    return handleDeliveryFailure(error, accepted, start);
  }
}

async function repairDuplicateMessage(
  options: UserMessageTurnDeliveryServiceOptions,
  input: PreparedDeliveryInput,
  result: Extract<ActivateTurnResult, { readonly accepted: false }>,
): Promise<void> {
  if (result.reason !== 'duplicate' || !shouldProjectMessage(input)) return;
  const stableQueryKey = await resolveQueryKeyForTurn(options, input.sessionId, result.turnId);
  await commitTurnMessages(options, input, result.turnId, stableQueryKey);
}

async function completeAcceptedDelivery(
  options: UserMessageTurnDeliveryServiceOptions,
  input: PreparedDeliveryInput,
  result: Extract<ActivateTurnResult, { readonly accepted: true }>,
  visibleQuery: boolean,
): Promise<void> {
  await input.onAccepted?.(result);
  const queryKey = await resolveQueryKey(options, input, visibleQuery);
  if (visibleQuery) {
    await commitTurnMessages(options, input, result.turnId, queryKey);
  }
  await startQueryCollapse(options, input.sessionId, result.turnId, queryKey);
  await input.beforeStart?.();
  await observeBeforeExecution(options, input, result.turnId);
}

async function startQueryCollapse(
  options: UserMessageTurnDeliveryServiceOptions,
  sessionId: string,
  turnId: string,
  queryKey: string,
): Promise<void> {
  try {
    const state = await options.queryCollapse.start({
      sessionId,
      queryKey,
      currentTurnId: turnId,
    });
    writeQueryCollapseView(options.stream, state);
  } catch {
    // The accepted Turn and durable Message remain valid when the display sidecar is unavailable.
  }
}

async function resolveQueryKey(
  options: UserMessageTurnDeliveryServiceOptions,
  input: PreparedDeliveryInput,
  visibleQuery: boolean,
): Promise<string> {
  return resolveQueryKeyForTurn(options, input.sessionId, input.requestedTurnId, {
    reuseLatestVisibleQuery: shouldReuseLatestVisibleQuery(input, visibleQuery),
  });
}

function shouldReuseLatestVisibleQuery(
  input: PreparedDeliveryInput,
  visibleQuery: boolean,
): boolean {
  if (visibleQuery) return false;
  return input.input.origin?.kind !== 'background-task-terminal';
}

async function resolveQueryKeyForTurn(
  options: UserMessageTurnDeliveryServiceOptions,
  sessionId: string,
  turnId: string,
  input?: { readonly reuseLatestVisibleQuery: boolean },
): Promise<string> {
  try {
    return await options.queryCollapse.resolveQueryKey(sessionId, turnId, input);
  } catch {
    return queryCollapseQueryKey(turnId);
  }
}

function handleDeliveryFailure(
  error: unknown,
  accepted: Extract<ActivateTurnResult, { readonly accepted: true }> | undefined,
  start: StartFence,
): ActivateTurnResult {
  if (accepted) {
    start.fail(error);
    return accepted;
  }
  start.release();
  if (error instanceof UserMessageCommitAdmissionError) {
    return { accepted: false, reason: error.reason };
  }
  if (error instanceof UserMessageCommitConflictError) {
    return { accepted: false, reason: 'ingress-conflict' };
  }
  throw error;
}

async function commitTurnMessages(
  options: UserMessageTurnDeliveryServiceOptions,
  input: PreparedDeliveryInput,
  turnId: string,
  queryKey: string,
): Promise<void> {
  if (!input.immediateSendBatch) {
    projectCommitted(options, await commitTurnMessage(options, input, turnId, queryKey));
    return;
  }
  for (const member of input.immediateSendBatch.members) {
    if (!shouldProjectMessage(member.message)) continue;
    const commit = await commitMessage(options, {
      sessionId: input.sessionId,
      turnId,
      queryKey,
      unstartedFromTurnIds: [
        ...(input.unstartedFromTurnIds ?? []),
        ...(member.unstartedFromTurnIds ?? []),
      ],
      messageKey: member.messageKey,
      userMessageId: member.userMessageId,
      content: projectedMessageContent(member.message, member.message.content),
      inputContent: member.message.content,
      timestamp: member.createdAt,
      ...(member.unconsumedFromTurnIds
        ? { unconsumedFromTurnIds: member.unconsumedFromTurnIds }
        : {}),
      attachments:
        member.message.displayAttachments ??
        member.message.attachments.map((attachment) => ({ ...attachment })),
      ...(member.sourceMessageId ? { sourceMessageId: member.sourceMessageId } : {}),
      provenance: member.provenance,
    });
    projectCommitted(options, commit);
  }
}

async function commitTurnMessage(
  options: UserMessageTurnDeliveryServiceOptions,
  input: PreparedDeliveryInput,
  turnId: string,
  queryKey?: string,
): Promise<CommittedUserMessage> {
  const attachments = deliveryAttachments(input, input.input.attachments);
  return commitMessage(options, {
    sessionId: input.sessionId,
    turnId,
    unstartedFromTurnIds: input.unstartedFromTurnIds,
    messageKey: input.messageKey ?? `turn:${turnId}`,
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
    content: projectedMessageContent(input, input.input.text),
    inputContent: input.input.text,
    ...(queryKey ? { queryKey } : {}),
    ...(attachments ? { attachments } : {}),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
    provenance: input.provenance,
    ...(input.createdAt !== undefined ? { timestamp: input.createdAt } : {}),
  });
}

function commitMessage(
  options: UserMessageTurnDeliveryServiceOptions,
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly messageKey: string;
    readonly userMessageId?: UserMessageId;
    readonly content: string;
    readonly inputContent: string;
    readonly timestamp?: number;
    readonly unconsumedFromTurnIds?: readonly string[];
    readonly unstartedFromTurnIds?: readonly string[];
    readonly kind?: string;
    readonly queryKey?: string;
    readonly attachments?: readonly UserMessageAttachment[];
    readonly sourceMessageId?: string;
    readonly provenance: SubmitTurnSubmission['provenance'];
    readonly clientIntent?: string;
  },
): Promise<CommittedUserMessage> {
  const context = sourceContext(input.provenance);
  return retryUserMessageCommit(() =>
    options.messages.commit({
      sessionId: input.sessionId,
      turnId: input.turnId,
      unstartedFromTurnIds: input.unstartedFromTurnIds,
      messageKey: input.messageKey,
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      content: input.content,
      ...(input.inputContent !== input.content && parsePluginMentions(input.inputContent).length > 0
        ? { editContent: input.inputContent }
        : {}),
      ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
      ...(input.unconsumedFromTurnIds
        ? { unconsumedFromTurnIds: input.unconsumedFromTurnIds }
        : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.queryKey ? { queryKey: input.queryKey } : {}),
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      source:
        input.clientIntent === 'cloud-handoff' ? 'cloud_session_handoff' : input.provenance.source,
      ...(context ? { sourceContext: context } : {}),
    }),
  );
}

function shouldProjectMessage(
  input:
    | {
        readonly hideUserMessage?: boolean;
        readonly displayContent?: string;
        readonly displayAttachments?: readonly Readonly<Record<string, unknown>>[];
      }
    | undefined,
): boolean {
  if (!input) return true;
  return input.hideUserMessage !== true || hasDisplayContent(input);
}

function projectedMessageContent(
  input: { readonly displayContent?: string } | undefined,
  fallback: string,
): string {
  return hasDisplayContent(input) ? input.displayContent : fallback;
}

function hasDisplayContent(
  input: { readonly displayContent?: string } | undefined,
): input is { readonly displayContent: string } {
  return typeof input?.displayContent === 'string' && input.displayContent.length > 0;
}

function deliveryAttachments(
  delivery: { readonly displayAttachments?: readonly UserMessageAttachment[] } | undefined,
  execution: SubmitTurnSubmission['input']['attachments'],
): readonly UserMessageAttachment[] | undefined {
  const attachments = delivery?.displayAttachments ?? execution;
  return attachments?.map((attachment) => ({ ...attachment }));
}

function sourceContext(
  provenance: SubmitTurnSubmission['provenance'],
): Readonly<Record<string, unknown>> | undefined {
  const context = provenance.sourceContext;
  if (!context) return undefined;
  const { channelContext: nested, ...outer } = context;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? { ...outer, ...(nested as Readonly<Record<string, unknown>>) }
    : { ...context };
}

function projectCommitted(
  options: UserMessageTurnDeliveryServiceOptions,
  commit: CommittedUserMessage,
): void {
  publish(options, commit);
}

function publish(
  options: UserMessageTurnDeliveryServiceOptions,
  commit: CommittedUserMessage,
): void {
  try {
    options.stream.write({
      identity: `message:${commit.message.msg_id}`,
      sessionId: commit.sessionId,
      turnId: commit.turnId,
      kind: 'message-committed',
      data: { messages: [commit.message] },
    });
  } catch {
    // Durable Message commit is authoritative; resume replays it if live publication fails.
  }
}

async function observeBeforeExecution(
  options: UserMessageTurnDeliveryServiceOptions,
  input: PreparedDeliveryInput,
  turnId: string,
): Promise<void> {
  try {
    await options.beforeExecution?.({
      sessionId: input.sessionId,
      turnId,
      provenance: input.provenance,
    });
  } catch {
    // Product feedback such as Channel typing must not fail an accepted Turn.
  }
}

interface StartFence {
  readonly promise: Promise<void>;
  release(): void;
  fail(error: unknown): void;
}

function createStartFence(): StartFence {
  let resolveStart: (() => void) | undefined;
  let rejectStart: ((error: unknown) => void) | undefined;
  let settled = false;
  return {
    promise: new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    }),
    release: () => {
      if (settled) return;
      settled = true;
      resolveStart?.();
    },
    fail: (error) => {
      if (settled) return;
      settled = true;
      rejectStart?.(error);
    },
  };
}
