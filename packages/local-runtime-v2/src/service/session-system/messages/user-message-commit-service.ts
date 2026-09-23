import {
  UserMessageCommitAdmissionError,
  UserMessageCommitConflictError,
  type DisplayMessageRecord,
  type MessageRepository,
} from './repo/contract.js';
import { createUserMessageId, type UserMessageId } from '../shared/user-message-id.js';
import type { MessageSource, MessageSourceContext } from './source.js';

export interface UserMessageAttachment extends Readonly<Record<string, unknown>> {
  readonly meta?: {
    readonly attachmentType?: string;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly sizeBytes?: number;
  };
  readonly local?: {
    readonly assetId?: string;
    readonly filePath?: string;
    readonly desktopPath?: string;
    readonly dataUrl?: string;
  };
  readonly cloud?: {
    readonly uploadId?: string;
    readonly driveNodeId?: string;
    readonly url?: string;
    readonly dataUrl?: string;
  };
  readonly type?: string;
  readonly filePath?: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly dataUrl?: string;
  readonly assetId?: string;
}

export interface CommitUserMessageInput {
  /** Trusted unconsumed steering handoff; never an external commit option. */
  readonly unconsumedFromTurnIds?: readonly string[];
  /** Trusted Queue startup lineage; the initial Host never read these rows. */
  readonly unstartedFromTurnIds?: readonly string[];
  readonly timestamp?: number;
  readonly sessionId: string;
  readonly turnId: string;
  /** Stable producer identity; it is not persisted outside the derived Message id. */
  readonly messageKey: string;
  /** Pre-generated identity shared by Queue, Display and canonical history. */
  readonly userMessageId?: UserMessageId;
  readonly content?: string;
  /** Canonical input retained when readable display text hides explicit plugin identities. */
  readonly editContent?: string;
  /** Display classification independent from Turn/query identity. */
  readonly kind?: string;
  /** Query sidecar identity; absent only for legacy or non-query user Messages. */
  readonly queryKey?: string;
  readonly attachments?: readonly UserMessageAttachment[];
  readonly sourceMessageId?: string;
  readonly source?: MessageSource;
  readonly sourceContext?: MessageSourceContext;
}

export interface CommittedUserMessage {
  readonly sessionId: string;
  readonly turnId: string;
  readonly messageKey: string;
  readonly created: boolean;
  readonly firstUserMessageForSession: boolean;
  readonly message: DisplayMessageRecord & {
    readonly msg_id: string;
    readonly role: 'user';
    readonly msg_content: string;
    readonly timestamp: number;
  };
}

export interface UserMessageCommitServiceOptions {
  readonly messages: Pick<MessageRepository, 'commitUserMessage'>;
  readonly nowMs?: () => number;
  readonly makeMessageId?: (input: {
    readonly sessionId: string;
    readonly messageKey: string;
  }) => string;
}

/** Retries transient Message writes once without repeating deterministic rejections. */
export async function retryUserMessageCommit<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof UserMessageCommitAdmissionError ||
      error instanceof UserMessageCommitConflictError
    ) {
      throw error;
    }
    return operation();
  }
}

/** Lightweight idempotent projection directly onto the authoritative Message table. */
export class UserMessageCommitService {
  private readonly nowMs: () => number;
  private readonly makeMessageId: NonNullable<UserMessageCommitServiceOptions['makeMessageId']>;

  constructor(private readonly options: UserMessageCommitServiceOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    this.makeMessageId = options.makeMessageId ?? ((input) => createUserMessageId(input));
  }

  async commit(input: CommitUserMessageInput): Promise<CommittedUserMessage> {
    const messageId = input.userMessageId ?? this.makeMessageId(input);
    const result = await this.options.messages.commitUserMessage({
      sessionId: input.sessionId,
      turnId: input.turnId,
      unconsumedFromTurnIds: input.unconsumedFromTurnIds,
      unstartedFromTurnIds: input.unstartedFromTurnIds,
      ...(input.source ? { source: input.source } : {}),
      ...(input.sourceContext ? { sourceContext: { ...input.sourceContext } } : {}),
      message: {
        msg_id: messageId,
        role: 'user',
        msg_content: input.content ?? '',
        ...(input.editContent !== undefined ? { editContent: input.editContent } : {}),
        msg_type: 1,
        timestamp: input.timestamp ?? this.nowMs(),
        kind: input.kind,
        ...(input.sourceMessageId ? { source_message_id: input.sourceMessageId } : {}),
        ...(input.queryKey ? { query_key: input.queryKey } : {}),
        ...(input.attachments?.length
          ? { attachments: input.attachments.map(toDisplayAttachment) }
          : {}),
      },
    });
    if (!isCommittedUserMessage(result.message, messageId)) {
      throw new TypeError(`Stable committed user Message row is malformed: ${messageId}`);
    }
    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      messageKey: input.messageKey,
      created: result.created,
      firstUserMessageForSession: result.firstUserMessageForSession,
      message: result.message,
    };
  }
}

function toDisplayAttachment(attachment: UserMessageAttachment): Readonly<Record<string, unknown>> {
  if (attachment.meta || attachment.local || attachment.cloud) {
    return toStructuredDisplayAttachment(attachment);
  }
  return toLegacyDisplayAttachment(attachment);
}

function toStructuredDisplayAttachment(
  attachment: UserMessageAttachment,
): Readonly<Record<string, unknown>> {
  return {
    ...(attachment.meta ? { meta: { ...attachment.meta } } : {}),
    ...(attachment.local ? { local: { ...attachment.local } } : {}),
    ...(attachment.cloud ? { cloud: { ...attachment.cloud } } : {}),
  };
}

function toLegacyDisplayAttachment(
  attachment: UserMessageAttachment,
): Readonly<Record<string, unknown>> {
  return {
    ...(attachment.type ? { type: attachment.type } : {}),
    ...(attachment.filePath ? { file_path: attachment.filePath } : {}),
    ...(attachment.fileName ? { file_name: attachment.fileName } : {}),
    ...(attachment.mimeType ? { mime_type: attachment.mimeType } : {}),
    ...(attachment.dataUrl ? { data_url: attachment.dataUrl } : {}),
    ...(attachment.assetId ? { asset_id: attachment.assetId } : {}),
  };
}

function isCommittedUserMessage(
  message: DisplayMessageRecord,
  messageId: string,
): message is CommittedUserMessage['message'] {
  return (
    message.msg_id === messageId &&
    message.role === 'user' &&
    typeof message.msg_content === 'string' &&
    typeof message.timestamp === 'number' &&
    Number.isFinite(message.timestamp)
  );
}
