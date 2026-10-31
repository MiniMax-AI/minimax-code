import type {
  ActivateTurnResult,
  SteerSessionInput,
  SteerSessionResult,
  TurnActivationSubmission,
  TurnMessageSubmission,
} from '../../contracts.js';
import { isUserSteeringProducer } from '../../agent-host/contracts.js';
import type { AgentHostSteeringMessage } from '../../agent-host/contracts.js';
import { captureAgentHostSteeringInput } from '../../agent-host/canonical-user-input.js';
import type { TurnExecutionService } from '../contracts.js';
import type { TurnRepository } from '../../persistence/contracts.js';
import { resolveGenuineUserQueryText } from '../message-query-authorship.js';
import { steeringMessageKey, steeringReceiptId } from '../../steering-identity.js';
import { createUserMessageId } from '../../../session-system/shared/user-message-id.js';

interface TurnActivation {
  execute(input: TurnActivationSubmission): Promise<ActivateTurnResult>;
}

interface SteerSessionServiceOptions {
  readonly turns: Pick<TurnExecutionService, 'activeTurnId' | 'steerActiveTurn'>;
  readonly activation: TurnActivation;
  readonly receipts: Pick<
    TurnRepository,
    'findSteeringReceipt' | 'reserveSteeringReceipt' | 'releaseSteeringReceipt'
  >;
}

type ActiveDeliveryReservation =
  | { readonly kind: 'deliver'; readonly receiptReserved: boolean }
  | { readonly kind: 'duplicate'; readonly turnId: string }
  | { readonly kind: 'not-accepted' };

interface ReservedActiveDelivery {
  readonly input: SteerSessionInput;
  readonly clientRequestId: string | undefined;
  readonly activeTurnId: string;
  readonly reservation: Extract<ActiveDeliveryReservation, { readonly kind: 'deliver' }>;
}

type ActivationSteerOutcome =
  | { readonly kind: 'result'; readonly result: SteerSessionResult }
  | { readonly kind: 'race'; readonly reason: ActiveRaceReason };

type ActiveRaceReason = 'active-turn' | 'compaction-active';

export function createSteerSessionService(options: SteerSessionServiceOptions): {
  steer(input: SteerSessionInput): Promise<SteerSessionResult>;
} {
  return {
    steer: (input) =>
      deliver(
        options,
        identifyVisibleSteering({
          ...input,
          ...(isUserSteeringProducer(input.producerId)
            ? { createdAt: input.createdAt ?? Date.now() }
            : {}),
        }),
      ),
  };
}

async function deliver(
  options: SteerSessionServiceOptions,
  input: SteerSessionInput,
): Promise<SteerSessionResult> {
  const clientRequestId = durableSteeringReceiptId(input);
  if (clientRequestId) {
    const receipt = await options.receipts.findSteeringReceipt({
      sessionId: input.sessionId,
      clientRequestId,
    });
    if (receipt) return { delivered: true, mode: 'duplicate', turnId: receipt.turnId };
  }
  const activeDelivery =
    input.clientIntent === 'cloud-handoff'
      ? undefined
      : await deliverToActive(options, input, clientRequestId);
  if (activeDelivery) return activeDelivery;
  return activateOrSteerRace(options, input, clientRequestId);
}

async function deliverToActive(
  options: SteerSessionServiceOptions,
  input: SteerSessionInput,
  clientRequestId: string | undefined,
  observedTurnId?: string,
): Promise<SteerSessionResult | undefined> {
  const turns = options.turns;
  const activeTurnId = observedTurnId ?? turns.activeTurnId(input.sessionId);
  if (!activeTurnId) return undefined;
  if (hasModelOverride(input.input.model) && input.modelSelectionScope !== 'activation-only') {
    return { delivered: false, reason: 'active-model-override-unsupported' };
  }
  return deliverToKnownActive(options, activeSteeringInput(input), clientRequestId, activeTurnId);
}

async function deliverToKnownActive(
  options: SteerSessionServiceOptions,
  input: SteerSessionInput,
  clientRequestId: string | undefined,
  activeTurnId: string,
): Promise<SteerSessionResult | undefined> {
  const reservation = await reserveActiveDeliveryReceipt(
    options,
    input,
    clientRequestId,
    activeTurnId,
  );
  if (reservation.kind === 'duplicate') {
    return { delivered: true, mode: 'duplicate', turnId: reservation.turnId };
  }
  if (reservation.kind === 'not-accepted') return undefined;
  return deliverToReservedActive(options, {
    input,
    clientRequestId,
    activeTurnId,
    reservation,
  });
}

async function reserveActiveDeliveryReceipt(
  options: SteerSessionServiceOptions,
  input: SteerSessionInput,
  clientRequestId: string | undefined,
  turnId: string,
): Promise<ActiveDeliveryReservation> {
  if (!clientRequestId) return { kind: 'deliver', receiptReserved: false };
  const receipt = await options.receipts.reserveSteeringReceipt({
    sessionId: input.sessionId,
    clientRequestId,
    turnId,
    ...(input.receiptAliases?.length ? { receiptAliases: input.receiptAliases } : {}),
  });
  if (receipt.status === 'duplicate') return { kind: 'duplicate', turnId: receipt.turnId };
  if (receipt.status === 'not-accepted') return { kind: 'not-accepted' };
  return { kind: 'deliver', receiptReserved: true };
}

async function deliverToReservedActive(
  options: SteerSessionServiceOptions,
  delivery: ReservedActiveDelivery,
): Promise<SteerSessionResult | undefined> {
  const { activeTurnId, input } = delivery;
  try {
    await input.preDelivery?.accept({ mode: 'steered', turnId: activeTurnId });
  } catch (error) {
    await releaseReservedReceipt(options, delivery);
    throw error;
  }
  const result = await steer(options.turns, input, activeTurnId);
  if (!result.delivered) {
    // Controller returned a definitive non-acceptance, so no content reached
    // the active Turn and this receipt is safe to compensate.
    await releaseReservedReceipt(options, delivery);
  }
  return result.delivered || result.reason === 'delivery-closed' ? result : undefined;
}

async function releaseReservedReceipt(
  options: SteerSessionServiceOptions,
  delivery: ReservedActiveDelivery,
): Promise<void> {
  if (!delivery.reservation.receiptReserved || !delivery.clientRequestId) return;
  await releaseKnownUndeliveredReceipt(options, {
    sessionId: delivery.input.sessionId,
    clientRequestId: delivery.clientRequestId,
    turnId: delivery.activeTurnId,
    ...(delivery.input.receiptAliases?.length
      ? { receiptAliases: delivery.input.receiptAliases }
      : {}),
  });
}

async function activateOrSteerRace(
  options: SteerSessionServiceOptions,
  input: SteerSessionInput,
  clientRequestId: string | undefined,
): Promise<SteerSessionResult> {
  const activated = await options.activation.execute(steerActivationInput(input, clientRequestId));
  const outcome = activationSteerOutcome(activated);
  if (outcome.kind === 'result') return outcome.result;
  if (input.clientIntent === 'cloud-handoff') return { delivered: false, reason: outcome.reason };
  return deliverToRacedActive(options, input, clientRequestId, outcome.reason);
}

function steerActivationInput(
  input: SteerSessionInput,
  clientRequestId: string | undefined,
): TurnActivationSubmission {
  return {
    sessionId: input.sessionId,
    input: input.input,
    ...activationReceipt(input, clientRequestId),
    provenance: input.provenance,
    ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
    ...(input.resumePausedQueue
      ? { admissionPriority: { kind: 'paused-queue-send' as const } }
      : {}),
    ...(input.outputContract ? { outputContract: input.outputContract } : {}),
    ...(input.admissionPriority ? { admissionPriority: input.admissionPriority } : {}),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
    ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
    delivery: activationDelivery(input),
    immediateSendBatch: input.immediateSendBatch,
  };
}

/** Per-item aliases are only admitted alongside the durable producer receipt. */
function activationReceipt(
  input: SteerSessionInput,
  clientRequestId: string | undefined,
): Pick<TurnActivationSubmission, 'clientRequestId' | 'receiptAliases'> {
  return {
    clientRequestId: clientRequestId ?? input.idempotencyKey,
    ...(clientRequestId && input.receiptAliases?.length
      ? { receiptAliases: input.receiptAliases }
      : {}),
  };
}

function activationDelivery(input: SteerSessionInput): TurnMessageSubmission['delivery'] {
  const preDelivery = input.preDelivery;
  return {
    ...input.delivery,
    messageKey: steeringMessageKey(input),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
    ...(preDelivery
      ? {
          preDelivery: {
            accept: ({ turnId }) => preDelivery.accept({ mode: 'activated', turnId }),
          },
        }
      : {}),
  };
}

function activationSteerOutcome(activated: ActivateTurnResult): ActivationSteerOutcome {
  if (activated.accepted) {
    return { kind: 'result', result: activatedResult(activated) };
  }
  if (activated.reason === 'duplicate') {
    return {
      kind: 'result',
      result: { delivered: true, mode: 'duplicate', turnId: activated.turnId },
    };
  }
  if (isActiveRaceReason(activated.reason)) {
    return { kind: 'race', reason: activated.reason };
  }
  return { kind: 'result', result: { delivered: false, reason: activated.reason } };
}

function activatedResult(
  activated: Extract<ActivateTurnResult, { readonly accepted: true }>,
): SteerSessionResult {
  return {
    delivered: true,
    mode: 'activated',
    turnId: activated.turnId,
    completion: activated.completion,
  };
}

function isActiveRaceReason(reason: string): reason is ActiveRaceReason {
  return reason === 'active-turn' || reason === 'compaction-active';
}

async function deliverToRacedActive(
  options: SteerSessionServiceOptions,
  input: SteerSessionInput,
  clientRequestId: string | undefined,
  rejectionReason: ActiveRaceReason,
): Promise<SteerSessionResult> {
  const racedTurnId = options.turns.activeTurnId(input.sessionId);
  if (!racedTurnId) return { delivered: false, reason: rejectionReason };
  const raced = await deliverToActive(options, input, clientRequestId, racedTurnId);
  return raced ?? { delivered: false, reason: 'active-turn' };
}

function activeSteeringInput(input: SteerSessionInput): SteerSessionInput {
  if (input.modelSelectionScope !== 'activation-only' || !input.input.model) return input;
  const { model: activationPreference, ...activeInput } = input.input;
  // The join never switches the running Turn's model, but an exit-boundary
  // requeue turns this message into a fresh query that must keep the user's
  // explicit choice.
  return { ...input, input: activeInput, requeueModel: activationPreference };
}

async function releaseKnownUndeliveredReceipt(
  options: SteerSessionServiceOptions,
  receipt: Parameters<TurnRepository['releaseSteeringReceipt']>[0],
): Promise<void> {
  try {
    await options.receipts.releaseSteeringReceipt(receipt);
  } catch {
    // The receipt stays durable on a compensation write failure. Replaying it
    // is less safe than accepting the documented at-most-once loss boundary.
  }
}

async function steer(
  turns: Pick<TurnExecutionService, 'steerActiveTurn'>,
  input: SteerSessionInput,
  turnId: string,
): Promise<SteerSessionResult> {
  const result = await turns.steerActiveTurn({
    sessionId: input.sessionId,
    turnId,
    ...(input.resumePausedQueue || isForegroundSteerSend(input.clientIntent)
      ? { foreground: true as const }
      : {}),
    message: bufferedSteeringMessage(input),
  });
  if (result.status === 'accepted') {
    return { delivered: true, mode: 'steered', turnId: result.turnId };
  }
  if (
    result.status === 'unsupported-delivery' ||
    result.status === 'delivery-closed' ||
    result.status === 'closing'
  ) {
    return { delivered: false, reason: 'delivery-closed' };
  }
  return { delivered: false, reason: 'active-turn' };
}

function bufferedSteeringMessage(input: SteerSessionInput): AgentHostSteeringMessage {
  const genuineUserQueryText = resolveGenuineUserQueryText({
    input: input.input,
    provenance: input.provenance,
    delivery: input.delivery,
  });
  const request = captureAgentHostSteeringInput({
    input: input.input,
    provenance: input.provenance,
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
  });
  const delivery = steeringDelivery(input.delivery);
  return {
    producerId: input.producerId,
    unstartedFromTurnIds: input.delivery?.unstartedFromTurnIds,
    ...(input.immediateSendBatch
      ? {
          batchMembers: input.immediateSendBatch.members.map((member, index) => ({
            producerId: input.producerId,
            idempotencyKey: `${input.idempotencyKey}:${member.userMessageId}`,
            messageKey: member.messageKey,
            userMessageId: member.userMessageId,
            createdAt: member.createdAt,
            unstartedFromTurnIds: [
              ...new Set([
                ...(member.unstartedFromTurnIds ?? []),
                ...(input.delivery?.unstartedFromTurnIds ?? []),
              ]),
            ],
            ...(member.unconsumedFromTurnIds
              ? { unconsumedFromTurnIds: member.unconsumedFromTurnIds }
              : {}),
            ...(member.sourceMessageId ? { sourceMessageId: member.sourceMessageId } : {}),
            ...(index === 0 && input.sourceMessageId
              ? { queueClaim: { itemId: input.sourceMessageId, claimId: input.idempotencyKey } }
              : {}),
            message: {
              text: member.message.content,
              attachments: member.message.attachments,
              ...(member.message.quotedMessage
                ? { quotedMessage: member.message.quotedMessage }
                : {}),
            },
            genuineUserQueryText: member.message.displayContent ?? member.message.content,
            provenance: member.provenance,
            delivery: {
              hideUserMessage: member.message.hideUserMessage,
              displayContent: member.message.displayContent,
              displayAttachments: member.message.displayAttachments,
            },
            ...(member.model
              ? {
                  requeueModel: {
                    providerId: member.model.provider_id,
                    modelId: member.model.model_id,
                    variant: member.model.variant,
                    thinking: member.model.thinking,
                  },
                }
              : {}),
          })),
        }
      : {}),
    ...(input.producerId === 'queue-immediate-send' && input.sourceMessageId
      ? { queueClaim: { itemId: input.sourceMessageId, claimId: input.idempotencyKey } }
      : {}),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    idempotencyKey: input.idempotencyKey,
    ...(request.userMessageId ? { userMessageId: request.userMessageId } : {}),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.requeueModel ? { requeueModel: input.requeueModel } : {}),
    message: request.input,
    genuineUserQueryText,
    provenance: request.provenance,
    ...(delivery ? { delivery } : {}),
  };
}

function isPausedQueueSend(clientIntent: string | undefined): boolean {
  return clientIntent === 'paused-queue-keep' || clientIntent === 'paused-queue-clear';
}

/** Steer sends that keep an attached SSE consumer promote the Turn to foreground. */
function isForegroundSteerSend(clientIntent: string | undefined): boolean {
  return isPausedQueueSend(clientIntent) || clientIntent === 'composer-steer';
}

function durableSteeringReceiptId(input: SteerSessionInput): string | undefined {
  return input.preDelivery || input.receiptAliases?.length ? steeringReceiptId(input) : undefined;
}

function identifyVisibleSteering(input: SteerSessionInput): SteerSessionInput {
  if (input.userMessageId || !projectsVisibleUserMessage(input.delivery)) return input;
  return {
    ...input,
    userMessageId: createUserMessageId({
      sessionId: input.sessionId,
      messageKey: steeringMessageKey(input),
    }),
  };
}

function projectsVisibleUserMessage(delivery: SteerSessionInput['delivery']): boolean {
  return (
    delivery?.hideUserMessage !== true ||
    (typeof delivery.displayContent === 'string' && delivery.displayContent.length > 0)
  );
}

function steeringDelivery(input: SteerSessionInput['delivery']) {
  if (!input) return undefined;
  const delivery = {
    ...(input.hideUserMessage !== undefined ? { hideUserMessage: input.hideUserMessage } : {}),
    ...(input.displayContent !== undefined ? { displayContent: input.displayContent } : {}),
    ...(input.displayAttachments
      ? { displayAttachments: input.displayAttachments.map((attachment) => ({ ...attachment })) }
      : {}),
  };
  return Object.keys(delivery).length > 0 ? delivery : undefined;
}

function hasModelOverride(model: SteerSessionInput['input']['model']): boolean {
  return Boolean(model?.providerId || model?.modelId || model?.variant);
}
