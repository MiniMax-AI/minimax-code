import type { queueItems } from '../../../../infra/db/schema/queue.js';
import { isInputSafetyDecision } from '../../../content-safety/index.js';
import { QueueDataCorruptionError } from './contract.js';
import { isUserMessageId } from '../../shared/user-message-id.js';
import type {
  QueueChannelContext,
  QueueItem,
  QueueImmediateSendBatch,
  QueueMessageAttachment,
  QueueMessageInput,
  QueueMessageSource,
  QueueModelOverride,
} from './contract.js';

export type QueueStorageRow = typeof queueItems.$inferSelect;

export function encodeQueueItem(item: QueueItem): string {
  return JSON.stringify(item);
}
export function decodeQueueRow(row: QueueStorageRow): QueueItem {
  const item = parseQueueItem(row.dataJson);
  if (
    !item ||
    item.sessionId !== row.sessionId ||
    item.itemId !== row.itemId ||
    item.status !== row.status ||
    item.createdAt !== row.createdAtMs
  ) {
    throw new QueueDataCorruptionError(row.sessionId, row.itemId);
  }
  return item;
}
function parseQueueItem(raw: string): QueueItem | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return isQueueItem(value) ? withoutRetiredFields(value) : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Rows written before PTC followed the Session mode alone may carry the retired
 * `ptcEligible` ingress marker. Nothing reads it any more, so it is dropped
 * whatever its value instead of failing the row.
 */
function withoutRetiredFields(item: QueueItem): QueueItem {
  if (!Object.hasOwn(item, 'ptcEligible')) return item;
  const { ptcEligible, ...rest } = item as QueueItem & { readonly ptcEligible?: unknown };
  void ptcEligible;
  return rest;
}
export function isQueueItem(value: unknown): value is QueueItem {
  if (!hasBase(value)) return false;
  if (value.status === 'queued') return claimFieldsAbsent(value);
  return (
    value.status === 'claimed' &&
    nonEmpty(value.claimId) &&
    finite(value.claimedAt) &&
    optionalString(value.claimOwnerId) &&
    optionalFinite(value.claimLeaseExpiresAt)
  );
}
export function isQueueMessageSource(value: unknown): value is QueueMessageSource {
  return SOURCES.has(value as QueueMessageSource);
}
export function isQueueMessageInput(value: unknown): value is QueueMessageInput {
  if (!hasQueueMessageShape(value)) return false;
  return (
    hasValidAttachmentsAndSafety(value) &&
    optionalArray(value.displayAttachments, record) &&
    validMessageOptionals(value) &&
    optionalRecord(value.quotedMessage, isQuoted) &&
    optionalRecord(value.channelContext, isChannelContext)
  );
}
function hasQueueMessageShape(
  value: unknown,
): value is Record<string, unknown> & { content: string; attachments: unknown[] } {
  return record(value) && typeof value.content === 'string' && Array.isArray(value.attachments);
}
function hasValidAttachmentsAndSafety(value: {
  attachments: unknown[];
  inputSafetyDecision?: unknown;
}): boolean {
  return (
    value.attachments.every(isAttachment) &&
    (value.inputSafetyDecision === undefined || isInputSafetyDecision(value.inputSafetyDecision))
  );
}
function hasBase(value: unknown): value is QueueItem & Record<string, unknown> {
  if (!record(value)) return false;
  return hasIdentity(value) && hasOptionalMetadata(value);
}
function hasIdentity(value: Record<string, unknown>) {
  return (
    nonEmpty(value.itemId) &&
    nonEmpty(value.sessionId) &&
    nonEmpty(value.agentName) &&
    isQueueMessageSource(value.source) &&
    (value.status === 'queued' || value.status === 'claimed') &&
    isQueueMessageInput(value.message) &&
    finite(value.createdAt)
  );
}
function hasOptionalMetadata(value: Record<string, unknown>) {
  return (
    [value.requestedTurnId, value.clientRequestId, value.dedupeKey].every(optionalString) &&
    (value.userMessageId === undefined || isUserMessageId(value.userMessageId)) &&
    optionalFinite(value.expiresAt) &&
    optionalRecord(value.channelContext, isChannelContext) &&
    optionalRecord(value.model, isModel) &&
    optionalRecord(value.immediateSendBatch, isQueueImmediateSendBatch) &&
    validDeliveryAttempts(value.deliveryAttempts)
  );
}
export function isQueueImmediateSendBatch(value: unknown): value is QueueImmediateSendBatch {
  if (
    !record(value) ||
    !nonEmpty(value.id) ||
    !Array.isArray(value.members) ||
    value.members.length === 0
  )
    return false;
  const ids = new Set<string>();
  return value.members.every((member) => {
    if (!record(member) || !isUserMessageId(member.userMessageId) || ids.has(member.userMessageId))
      return false;
    ids.add(member.userMessageId);
    return validImmediateSendMember(member);
  });
}

function validImmediateSendMember(member: Record<string, unknown>): boolean {
  return (
    isQueueMessageInput(member.message) &&
    nonEmpty(member.messageKey) &&
    optionalRecord(
      member.queueClaim,
      (claim) => record(claim) && nonEmpty(claim.itemId) && nonEmpty(claim.claimId),
    ) &&
    finite(member.createdAt) &&
    validUnconsumedTurnIds(member.unconsumedFromTurnIds) &&
    validUnconsumedTurnIds(member.unstartedFromTurnIds) &&
    optionalString(member.sourceMessageId) &&
    optionalRecord(member.model, isModel) &&
    validBatchProvenance(member.provenance)
  );
}

function validBatchProvenance(value: unknown): boolean {
  return (
    record(value) &&
    isQueueMessageSource(value.source) &&
    nonEmpty(value.routingFingerprint) &&
    optionalRecord(value.sourceContext, record)
  );
}

function claimFieldsAbsent(value: Record<string, unknown>) {
  return (
    value.claimId === undefined &&
    value.claimedAt === undefined &&
    value.claimOwnerId === undefined &&
    value.claimLeaseExpiresAt === undefined
  );
}
function isAttachment(value: unknown): value is QueueMessageAttachment {
  return (
    record(value) &&
    (value.type === 'file' || value.type === 'image') &&
    typeof value.filePath === 'string' &&
    typeof value.fileName === 'string' &&
    typeof value.mimeType === 'string' &&
    [value.dataUrl, value.assetId, value.error].every(optionalString)
  );
}
function isQuoted(value: unknown) {
  return record(value) && typeof value.text === 'string' && optionalString(value.senderName);
}
function validMessageOptionals(value: Record<string, unknown>) {
  return (
    optionalBoolean(value.hideUserMessage) &&
    [value.displayContent, value.queueItemId, value.source, value.clientIntent].every(
      optionalString,
    )
  );
}
function isChannelContext(value: unknown): value is QueueChannelContext {
  return (
    record(value) &&
    ['platform', 'chatType', 'chatId', 'senderId', 'clientName'].every(
      (key) => typeof value[key] === 'string',
    )
  );
}
function isModel(value: unknown): value is QueueModelOverride {
  return (
    record(value) &&
    optionalString(value.provider_id) &&
    optionalString(value.model_id) &&
    optionalString(value.variant) &&
    (value.reasoning === undefined || typeof value.reasoning === 'boolean') &&
    isModelContext(value.context_limit) &&
    isParameterSnapshot(value.parameterSnapshot) &&
    optionalRecord(value.thinking, isModelThinking)
  );
}
function isModelContext(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647)
  );
}
function isParameterSnapshot(value: unknown): boolean {
  return (
    value === undefined ||
    (record(value) &&
      ['default', 'selection', 'legacy'].includes(String(value.context)) &&
      ['default', 'selection', 'legacy'].includes(String(value.effort)))
  );
}
function isModelThinking(value: unknown) {
  return record(value) && optionalString(value.effort);
}
const SOURCES = new Set<QueueMessageSource>([
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
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function optionalString(value: unknown) {
  return value === undefined || typeof value === 'string';
}
function optionalBoolean(value: unknown) {
  return value === undefined || typeof value === 'boolean';
}
function optionalFinite(value: unknown) {
  return value === undefined || finite(value);
}
function optionalArray(value: unknown, validate: (candidate: unknown) => boolean) {
  return value === undefined || (Array.isArray(value) && value.every(validate));
}
function optionalRecord(value: unknown, validate: (candidate: unknown) => boolean) {
  return value === undefined || validate(value);
}

function validUnconsumedTurnIds(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.every(nonEmpty) &&
      new Set(value).size === value.length)
  );
}

function validDeliveryAttempts(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0) return false;
  const claims = new Set<string>();
  const turns = new Set<string>();
  return value.every((attempt) => {
    if (!record(attempt) || !nonEmpty(attempt.claimId) || !nonEmpty(attempt.turnId)) return false;
    if (claims.has(attempt.claimId) || turns.has(attempt.turnId)) return false;
    claims.add(attempt.claimId);
    turns.add(attempt.turnId);
    return true;
  });
}
