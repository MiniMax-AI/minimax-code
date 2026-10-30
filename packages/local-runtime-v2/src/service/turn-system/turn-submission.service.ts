import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import {
  isInlineDisplayDataUrl,
  sanitizeDisplayAttachment,
  type CommittedQueueCapability,
  type QueueChannelContext,
  type QueueEnqueueInput,
  type QueueMessageAttachment,
  type QueueMessageInput,
  type QueueModelOverride,
  type QueueMessageSource,
} from '../session-system/index.js';
import type {
  ActivateTurnResult,
  ResumeUserInputSubmission,
  SubmitTurnResult,
  SubmitTurnSubmission,
  TurnActivationSubmission,
} from './contracts.js';
import type { QueueDispatcher } from './queue.dispatcher.js';
import { createUserMessageId } from '../session-system/shared/user-message-id.js';
import type { QueuedTurnCompletionRegistry } from './queued-turn-completion.js';

interface TurnSubmissionServiceOptions {
  readonly activation: {
    execute(input: TurnActivationSubmission): Promise<ActivateTurnResult>;
  };
  readonly queue: Pick<
    CommittedQueueCapability,
    'requireMutableSession' | 'enqueue' | 'list' | 'get'
  >;
  readonly dispatcher: Pick<QueueDispatcher, 'dispatch'>;
  readonly completions: QueuedTurnCompletionRegistry;
  readonly activeTurnId: (sessionId: string) => string | undefined;
  readonly makeTurnId?: () => string;
  readonly onQueueWakeFailure?: (input: {
    readonly sessionId: string;
    readonly error: unknown;
  }) => void;
}

export interface TurnSubmissionService {
  submit(input: SubmitTurnSubmission): Promise<SubmitTurnResult>;
  resumeUserInput(input: ResumeUserInputSubmission): Promise<ActivateTurnResult>;
}

/** Owns immediate-vs-queued submit semantics above pure Turn execution. */
export function createTurnSubmissionService(
  options: TurnSubmissionServiceOptions,
): TurnSubmissionService {
  const makeTurnId = options.makeTurnId ?? (() => `turn_${randomUUID()}`);
  return {
    submit: (input) =>
      input.allowQueue
        ? submitQueued(options, input, makeTurnId)
        : submitImmediate(options, input, makeTurnId),
    resumeUserInput: (input) => resumeUserInput(options, input, makeTurnId),
  };
}

function resumeUserInput(
  options: TurnSubmissionServiceOptions,
  input: ResumeUserInputSubmission,
  makeTurnId: () => string,
): Promise<ActivateTurnResult> {
  const requestId = input.resume.requestId.trim();
  if (!requestId || requestId !== input.resume.requestId) {
    return Promise.resolve({ accepted: false, reason: 'invalid-input' });
  }
  const identity = `user-input-resume:${input.resume.kind}:${requestId}`;
  const userMessageId =
    input.userMessageId ??
    createUserMessageId({ sessionId: input.sessionId, messageKey: identity });
  return options.activation.execute({
    sessionId: input.sessionId,
    input: input.input,
    ...(input.inputSafetyDecision ? { inputSafetyDecision: input.inputSafetyDecision } : {}),
    provenance: input.provenance,
    requestedTurnId: input.requestedTurnId ?? makeTurnId(),
    userMessageId,
    clientRequestId: identity,
    admissionPriority: { kind: 'user-input-resume' },
    resume: input.resume,
    delivery: { ...input.delivery, messageKey: identity, userMessageId },
  });
}

async function submitImmediate(
  options: TurnSubmissionServiceOptions,
  input: SubmitTurnSubmission,
  makeTurnId: () => string,
): Promise<SubmitTurnResult> {
  const requestedTurnId = input.requestedTurnId ?? makeTurnId();
  const messageKey = input.delivery?.messageKey ?? `turn:${requestedTurnId}`;
  const userMessageId =
    input.userMessageId ?? createUserMessageId({ sessionId: input.sessionId, messageKey });
  const result = await options.activation.execute({
    sessionId: input.sessionId,
    input: input.input,
    ...(input.outputContract ? { outputContract: input.outputContract } : {}),
    ...(input.executionDeadlineAtMs !== undefined
      ? { executionDeadlineAtMs: input.executionDeadlineAtMs }
      : {}),
    ...(input.inputSafetyDecision ? { inputSafetyDecision: input.inputSafetyDecision } : {}),
    provenance: input.provenance,
    requestedTurnId,
    userMessageId,
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
    ...directSubmissionPriority(input),
    delivery: { ...input.delivery, userMessageId },
  });
  return result.accepted ? { ...result, mode: 'started' } : result;
}

function directSubmissionPriority(
  input: SubmitTurnSubmission,
): Pick<TurnActivationSubmission, 'admissionPriority'> {
  if (input.resumePausedQueue) return { admissionPriority: { kind: 'paused-queue-send' } };
  return input.clientIntent === 'retry-continuation'
    ? { admissionPriority: { kind: 'retry-continuation' } }
    : {};
}

async function submitQueued(
  options: TurnSubmissionServiceOptions,
  input: SubmitTurnSubmission,
  makeTurnId: () => string,
): Promise<SubmitTurnResult> {
  const source = validQueueSource(input);
  if (!source) return { accepted: false, reason: 'invalid-input' };
  const requestedTurnId = input.requestedTurnId ?? makeTurnId();
  const activeTurnIdAtAdmission = options.activeTurnId(input.sessionId);
  const messageKey = input.delivery?.messageKey ?? `turn:${requestedTurnId}`;
  const userMessageId =
    input.userMessageId ?? createUserMessageId({ sessionId: input.sessionId, messageKey });
  let completion = options.completions.register(requestedTurnId, input.sessionId);
  let committed;
  try {
    const session = await options.queue.requireMutableSession(input.sessionId);
    committed = await options.queue.enqueue(
      toQueueInput(input, { requestedTurnId, userMessageId, agentName: session.agentName, source }),
    );
  } catch (error) {
    options.completions.discard(requestedTurnId);
    throw error;
  }
  if (!committed) {
    options.completions.discard(requestedTurnId);
    return { accepted: false, reason: 'invalid-input' };
  }
  const turnId = committed.item.requestedTurnId ?? requestedTurnId;
  completion = rebindCompletion(options, completion, {
    requestedTurnId,
    turnId,
    sessionId: input.sessionId,
  });
  options.completions.bind(turnId, committed.item.itemId);
  await dispatchBestEffort(options, input.sessionId);
  const ahead = await queuedWorkAhead(options, {
    sessionId: input.sessionId,
    itemId: committed.item.itemId,
    turnId,
    admittedPosition: committed.position,
    activeTurnIdAtAdmission,
  });
  return {
    accepted: true,
    mode: 'queued',
    turnId,
    completion,
    queue: {
      itemId: committed.item.itemId,
      position: committed.position,
      ahead,
    },
  };
}

function validQueueSource(input: SubmitTurnSubmission): QueueMessageSource | undefined {
  if (
    input.outputContract ||
    input.executionDeadlineAtMs !== undefined ||
    input.delivery?.onAccepted ||
    input.delivery?.beforeStart
  ) {
    return undefined;
  }
  return queueSource(input.provenance.source);
}

function rebindCompletion(
  options: TurnSubmissionServiceOptions,
  completion: ReturnType<QueuedTurnCompletionRegistry['register']>,
  identity: {
    readonly requestedTurnId: string;
    readonly turnId: string;
    readonly sessionId: string;
  },
): ReturnType<QueuedTurnCompletionRegistry['register']> {
  if (identity.turnId === identity.requestedTurnId) return completion;
  options.completions.discard(identity.requestedTurnId);
  return options.completions.register(identity.turnId, identity.sessionId);
}

async function dispatchBestEffort(
  options: TurnSubmissionServiceOptions,
  sessionId: string,
): Promise<void> {
  try {
    await options.dispatcher.dispatch(sessionId);
  } catch (error) {
    reportWakeFailure(options, sessionId, error);
  }
}

function toQueueInput(
  input: SubmitTurnSubmission,
  values: {
    readonly requestedTurnId: string;
    readonly userMessageId: import('../session-system/shared/user-message-id.js').UserMessageId;
    readonly agentName: string;
    readonly source: QueueMessageSource;
  },
): QueueEnqueueInput {
  return {
    session: { sessionId: input.sessionId, agentName: values.agentName },
    requestedTurnId: values.requestedTurnId,
    userMessageId: values.userMessageId,
    // Review is still an interactive API queue row. Its execution provenance
    // lives on the nested message so the composer can keep managing the row.
    source: values.source === 'code_review' ? 'api' : values.source,
    ...(input.queuePlacement ? { queuePlacement: input.queuePlacement } : {}),
    message: toQueueMessage(input),
    ...toQueueModel(input.input.model),
    ...toQueueMetadata(input),
  };
}

function toQueueMessage(input: SubmitTurnSubmission): QueueMessageInput {
  const channelContext = toQueueChannelContext(input);
  return {
    content: input.input.text,
    attachments: (input.input.attachments ?? []).flatMap(toQueueAttachment),
    ...(input.inputSafetyDecision ? { inputSafetyDecision: input.inputSafetyDecision } : {}),
    ...toQueueDeliveryMetadata(input),
    ...toQueueCanonicalMetadata(input),
    ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
    ...(input.provenance.source === 'code_review' ? { source: 'code_review' } : {}),
    ...(channelContext ? { channelContext } : {}),
  };
}

function toQueueDeliveryMetadata(
  input: SubmitTurnSubmission,
): Pick<QueueMessageInput, 'hideUserMessage' | 'displayContent' | 'displayAttachments'> {
  return {
    ...(input.delivery?.hideUserMessage !== undefined
      ? { hideUserMessage: input.delivery.hideUserMessage }
      : {}),
    ...(input.delivery?.displayContent !== undefined
      ? { displayContent: input.delivery.displayContent }
      : {}),
    ...(input.delivery?.displayAttachments
      ? {
          displayAttachments: input.delivery.displayAttachments.map((attachment) =>
            sanitizeDisplayAttachment(attachment),
          ),
        }
      : {}),
  };
}

async function queuedWorkAhead(
  options: TurnSubmissionServiceOptions,
  input: {
    readonly sessionId: string;
    readonly itemId: string;
    readonly turnId: string;
    readonly admittedPosition: number;
    readonly activeTurnIdAtAdmission?: string;
  },
): Promise<number> {
  try {
    const [pending, exact] = await Promise.all([
      options.queue.list(input.sessionId),
      options.queue.get(input.sessionId, input.itemId),
    ]);
    const activeTurnId = options.activeTurnId(input.sessionId);
    const pendingIndex = pending.findIndex((item) => item.itemId === input.itemId);
    if (pendingIndex >= 0) return pendingIndex + (activeTurnId ? 1 : 0);
    if (exact?.status === 'claimed') {
      return activeTurnId && activeTurnId !== input.turnId ? 1 : 0;
    }
    return 0;
  } catch {
    return (
      Math.max(0, input.admittedPosition - 1) +
      (input.activeTurnIdAtAdmission && input.activeTurnIdAtAdmission !== input.turnId ? 1 : 0)
    );
  }
}

function toQueueCanonicalMetadata(
  input: SubmitTurnSubmission,
): Pick<QueueMessageInput, 'origin' | 'quotedMessage'> {
  const origin = input.provenance.sourceContext?.origin ?? input.input.origin;
  return {
    ...(origin !== undefined ? { origin } : {}),
    ...(input.input.quotedMessage ? { quotedMessage: { ...input.input.quotedMessage } } : {}),
  };
}

function toQueueModel(
  model: SubmitTurnSubmission['input']['model'],
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
      ? {
          thinking: model.thinking.effort != null ? { effort: model.thinking.effort } : {},
        }
      : {}),
  };
  return { model: override };
}

function toQueueMetadata(
  input: SubmitTurnSubmission,
): Pick<QueueEnqueueInput, 'clientRequestId' | 'dedupeKey' | 'expiresAt'> {
  return {
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
}

function toQueueAttachment(
  input: NonNullable<SubmitTurnSubmission['input']['attachments']>[number],
): QueueMessageAttachment[] {
  const filePath = input.filePath?.trim() ?? '';
  const candidateDataUrl = input.dataUrl?.trim();
  const inlineDataUrl = isInlineDisplayDataUrl(candidateDataUrl);
  if (inlineDataUrl && !filePath) {
    throw new TypeError('Inline attachment must be registered before Queue admission.');
  }
  const dataUrl = inlineDataUrl ? undefined : candidateDataUrl;
  if (!hasQueueAttachmentPayload(input, filePath, dataUrl)) return [];
  const attachment: QueueMessageAttachment = {
    ...queueAttachmentMetadata(input, filePath),
    filePath,
    ...(dataUrl ? { dataUrl } : {}),
    ...(input.assetId ? { assetId: input.assetId } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
  return [attachment];
}

function hasQueueAttachmentPayload(
  input: Pick<QueueMessageAttachment, 'assetId' | 'error'>,
  filePath: string,
  dataUrl: string | undefined,
): boolean {
  return Boolean(filePath || dataUrl || input.assetId || input.error);
}

function queueAttachmentMetadata(
  input: NonNullable<SubmitTurnSubmission['input']['attachments']>[number],
  filePath: string,
): Pick<QueueMessageAttachment, 'type' | 'fileName' | 'mimeType'> {
  const mimeType = input.mimeType?.trim() ?? '';
  return {
    type: input.type === 'image' || mimeType.startsWith('image/') ? 'image' : 'file',
    fileName: input.fileName?.trim() || basename(filePath) || 'attachment',
    mimeType,
  };
}

function toQueueChannelContext(input: SubmitTurnSubmission): QueueChannelContext | undefined {
  const context = provenanceChannelContext(input);
  const fallback = input.input.channelContext;
  const platform = channelField(context, fallback?.platform, 'platform');
  const chatId = channelField(context, fallback?.chatId, 'chatId');
  const senderId = channelField(context, fallback?.senderId, 'senderId');
  if (!platform || !chatId || !senderId) return undefined;
  return {
    ...(context ?? {}),
    platform,
    chatType: channelField(context, fallback?.chatType, 'chatType') ?? 'private',
    chatId,
    senderId,
    clientName: channelField(context, fallback?.clientName, 'clientName') ?? platform,
  };
}

function provenanceChannelContext(
  input: SubmitTurnSubmission,
): Readonly<Record<string, unknown>> | undefined {
  const nested = input.provenance.sourceContext?.channelContext;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Readonly<Record<string, unknown>>)
    : input.provenance.sourceContext;
}

function channelField(
  context: Readonly<Record<string, unknown>> | undefined,
  fallback: string | undefined,
  key: string,
): string | undefined {
  return readString(context, key) ?? fallback;
}

function readString(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' && field.trim() ? field : undefined;
}

function queueSource(value: string): QueueMessageSource | undefined {
  return QUEUE_SOURCES.has(value as QueueMessageSource) ? (value as QueueMessageSource) : undefined;
}

function reportWakeFailure(
  options: TurnSubmissionServiceOptions,
  sessionId: string,
  error: unknown,
): void {
  try {
    options.onQueueWakeFailure?.({ sessionId, error });
  } catch {
    // Durable Queue admission remains authoritative when diagnostics fail.
  }
}

const QUEUE_SOURCES = new Set<QueueMessageSource>([
  'api',
  'cron',
  'task',
  'background-task',
  'team',
  'thread-goal',
  'questionnaire',
  'communication',
  'code_review',
  'greeting',
  'channel:wechat',
  'channel:feishu',
  'channel:telegram',
]);
