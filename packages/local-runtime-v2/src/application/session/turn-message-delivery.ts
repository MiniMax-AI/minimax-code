import { Role } from '@mavis/agent-core/protocol';
import type { GlobalEventInput } from '@mavis/shared/global-events';

import type { UserMessageTurnDelivery } from '../conversation/index.js';
import type { SessionSystemOwner } from '../../service/session-system/index.js';
import type { InitializeTurnSystemOptions } from '../../service/turn-system/index.js';

/**
 * Turn-system message delivery adapters split out of `services.ts` to keep that
 * composition root inside the local-runtime layout budget. Composition wiring
 * stays in `services.ts`; only the adapter bodies live here.
 */

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createQueueWakeFailureReporter(
  reportFailure: ((sessionId: string, message: string) => void) | undefined,
  prefix: string,
): (input: { readonly sessionId: string; readonly error: unknown }) => void {
  return ({ sessionId, error }) => {
    reportFailure?.(sessionId, `${prefix}:${describeError(error)}`);
  };
}

type ActivationSubmission = Parameters<
  ReturnType<InitializeTurnSystemOptions['createMessageDelivery']>['activation']['execute']
>[0];

function clientRequestFields(input: ActivationSubmission) {
  return {
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    ...(input.receiptAliases?.length ? { receiptAliases: input.receiptAliases } : {}),
  };
}

function activationDeliveryFields(delivery: ActivationSubmission['delivery']) {
  return {
    ...(delivery?.messageKey ? { messageKey: delivery.messageKey } : {}),
    propagateDeliveryFailure: delivery?.propagateDeliveryFailure,
    unstartedFromTurnIds: delivery?.unstartedFromTurnIds,
    beforeSubmit: delivery?.beforeSubmit,
    ...(delivery?.createdAt !== undefined ? { createdAt: delivery.createdAt } : {}),
    ...(delivery?.userMessageId ? { userMessageId: delivery.userMessageId } : {}),
    ...(delivery?.hideUserMessage ? { hideUserMessage: true } : {}),
    ...(delivery?.displayContent !== undefined ? { displayContent: delivery.displayContent } : {}),
    ...(delivery?.displayAttachments ? { displayAttachments: delivery.displayAttachments } : {}),
    ...(delivery?.onAccepted ? { onAccepted: delivery.onAccepted } : {}),
    ...(delivery?.beforeStart ? { beforeStart: delivery.beforeStart } : {}),
  };
}

export function createTurnSystemMessageDelivery(
  delivery: UserMessageTurnDelivery,
): InitializeTurnSystemOptions['createMessageDelivery'] {
  return ({ execution }) => ({
    activation: {
      execute: (input) =>
        delivery.deliver({
          sessionId: input.sessionId,
          input: input.input,
          immediateSendBatch: input.immediateSendBatch,
          provenance: input.provenance,
          ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
          ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
          ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
          ...activationDeliveryFields(input.delivery),
          submit: ({
            requestedTurnId,
            executionStart,
            genuineUserQueryText,
            requiresInputReview,
          }) =>
            execution.execute({
              sessionId: input.sessionId,
              input: input.input,
              immediateSendBatch: input.immediateSendBatch,
              ...executionOptionsFields(input),
              genuineUserQueryText,
              ...(input.inputSafetyDecision
                ? { inputSafetyDecision: input.inputSafetyDecision }
                : {}),
              requiresInputReview,
              provenance: input.provenance,
              requestedTurnId,
              executionStart,
              ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
              ...((input.userMessageId ?? input.delivery?.userMessageId)
                ? { userMessageId: input.userMessageId ?? input.delivery?.userMessageId }
                : {}),
              ...clientRequestFields(input),
              ...(input.admissionPriority ? { admissionPriority: input.admissionPriority } : {}),
              ...(input.resume ? { resume: input.resume } : {}),
              ...(input.delivery?.preDelivery ? { preDelivery: input.delivery.preDelivery } : {}),
            }),
        }),
    },
    queue: {
      execute: (input) => {
        let deliveryTurnId: string;
        return delivery.deliver({
          sessionId: input.sessionId,
          input: input.input,
          createdAt: input.candidateCreatedAtMs,
          immediateSendBatch: input.immediateSendBatch,
          provenance: input.ingress.provenance,
          propagateDeliveryFailure: true,
          onAccepted: input.onAccepted,
          unstartedFromTurnIds: input.unstartedFromTurnIds,
          beforeSubmit: async (turnId) => {
            deliveryTurnId = turnId;
            await input.beforeSubmit?.(turnId);
          },
          beforeStart: async () => {
            await input.beforeStart?.(deliveryTurnId);
          },
          ...(input.ingress.provenance.source === 'api' ||
          input.ingress.provenance.source === 'code_review'
            ? { sourceMessageId: input.ingress.itemId }
            : {}),
          ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
          ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
          ...(input.hideUserMessage ? { hideUserMessage: true } : {}),
          ...(input.displayContent !== undefined ? { displayContent: input.displayContent } : {}),
          ...(input.displayAttachments ? { displayAttachments: input.displayAttachments } : {}),
          ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
          submit: ({
            requestedTurnId,
            executionStart,
            genuineUserQueryText,
            requiresInputReview,
          }) =>
            execution.execute({
              sessionId: input.sessionId,
              input: input.input,
              immediateSendBatch: input.immediateSendBatch,
              genuineUserQueryText,
              ...(input.inputSafetyDecision
                ? { inputSafetyDecision: input.inputSafetyDecision }
                : {}),
              requiresInputReview,
              ingress: input.ingress,
              ...(input.queueSelection ? { queueSelection: input.queueSelection } : {}),
              // GOAL-05: the rows that yielded their FIFO position for this
              // claim have to reach the admitting transaction, or the priority
              // fence re-blocks the claim on the row selection just skipped.
              ...(input.yieldedQueueItemIds && input.yieldedQueueItemIds.length > 0
                ? { yieldedQueueItemIds: input.yieldedQueueItemIds }
                : {}),
              candidateCreatedAtMs: input.candidateCreatedAtMs,
              requestedTurnId,
              executionStart,
              ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
              ...((input.userMessageId ?? input.ingress.userMessageId)
                ? { userMessageId: input.userMessageId ?? input.ingress.userMessageId }
                : {}),
            }),
        });
      },
    },
  });
}

function executionOptionsFields(
  input: Pick<ActivationSubmission, 'outputContract' | 'executionDeadlineAtMs'>,
) {
  return {
    ...(input.outputContract ? { outputContract: input.outputContract } : {}),
    ...(input.executionDeadlineAtMs !== undefined
      ? { executionDeadlineAtMs: input.executionDeadlineAtMs }
      : {}),
  };
}

export function createConsumedSteeringHandler(
  delivery: UserMessageTurnDelivery,
  sessions: SessionSystemOwner,
  publish: (event: GlobalEventInput) => void,
  reportFailure: ((sessionId: string, message: string) => void) | undefined,
) {
  return async (input: Parameters<UserMessageTurnDelivery['consumeSteering']>[0]) => {
    await delivery.consumeSteering(input);
    await publishConsumedSteeringStart({ input, sessions, publish, reportFailure });
  };
}

export function createApprovedTitleHandler(
  sessions: SessionSystemOwner,
  reportFailure: ((sessionId: string, message: string) => void) | undefined,
): (input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly rejected: boolean;
}) => void {
  return (input) => generateTitleAfterApprovedInputReview({ ...input, sessions, reportFailure });
}

const detachedTitleResolutions = new WeakSet<Promise<void>>();

function generateTitleAfterApprovedInputReview(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly rejected: boolean;
  readonly sessions: SessionSystemOwner;
  readonly reportFailure: ((sessionId: string, message: string) => void) | undefined;
}): void {
  if (input.rejected) return;
  detachedTitleResolutions.add(generateTitleFromCommittedUserMessage(input));
}

async function generateTitleFromCommittedUserMessage(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sessions: SessionSystemOwner;
  readonly reportFailure: ((sessionId: string, message: string) => void) | undefined;
}): Promise<void> {
  try {
    const messages = await input.sessions.messages.repository.listTurn(
      input.sessionId,
      input.turnId,
    );
    const userMessage = messages.find((message) => message.role === Role.User);
    const titleSource = userMessage?.msg_content;
    if (typeof titleSource === 'string' && titleSource.length > 0) {
      input.sessions.titles.generate(input.sessionId, titleSource);
    }
  } catch (error) {
    try {
      input.reportFailure?.(
        input.sessionId,
        `session_title_source_resolution_failed:${describeError(error)}`,
      );
    } catch {
      // Detached title diagnostics cannot change the owning Turn.
    }
  }
}

async function publishConsumedSteeringStart(input: {
  readonly input: Parameters<UserMessageTurnDelivery['consumeSteering']>[0];
  readonly sessions: SessionSystemOwner;
  readonly publish: (event: GlobalEventInput) => void;
  readonly reportFailure: ((sessionId: string, message: string) => void) | undefined;
}): Promise<void> {
  try {
    const session = await input.sessions.sessions.repository.get(input.input.sessionId);
    if (!session) throw new Error(`Consumed steer Session not found: ${input.input.sessionId}`);
    input.publish({
      type: 'session.start',
      payload: {
        sessionId: input.input.sessionId,
        agentName: session.agentName,
        turnId: input.input.turnId,
        ...(consumedBackgroundTaskDeliveryIdentity(input.input.message) ?? {}),
      },
    });
  } catch (error) {
    input.reportFailure?.(
      input.input.sessionId,
      `steer_session_start_publish_failed:${describeError(error)}`,
    );
  }
}

function consumedBackgroundTaskDeliveryIdentity(
  message: Parameters<UserMessageTurnDelivery['consumeSteering']>[0]['message'],
): { readonly source: 'background-task-delivery'; readonly taskId: string } | undefined {
  if (message.producerId !== 'background-task-delivery') return undefined;
  const taskId = message.idempotencyKey.trim();
  return taskId ? { source: 'background-task-delivery', taskId } : undefined;
}

export function reportRootBestEffortFailure(
  reportFailure: ((sessionId: string, message: string) => void) | undefined,
  input: { readonly stage: string; readonly sessionId: string; readonly error: unknown },
): void {
  const stage = input.stage === 'turn-abort' ? 'abort' : input.stage.replaceAll('-', '_');
  reportFailure?.(
    input.sessionId,
    `root_replacement_${stage}_failed:${describeError(input.error)}`,
  );
}
