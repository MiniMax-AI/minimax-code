import type { AppDb } from '../../../../infra/db/client.js';

export interface DisplayMessageRecord extends Record<string, unknown> {
  readonly msg_id?: string;
  /** Canonical user input preserved when display text hides plugin identities. */
  readonly editContent?: string;
  /** Stable canonical identity of this completed assistant message, when known. */
  readonly canonical_message_id?: string;
  readonly role?: string;
  readonly turnId?: string;
  readonly meta?: { readonly turnId?: string };
  readonly timestamp?: number;
  readonly created_at?: number;
  readonly source?: string;
  readonly sourceContext?: Record<string, unknown>;
  readonly kind?: string;
  readonly forkOrigin?: Readonly<Record<string, unknown>> & { readonly sourceSessionId?: string };
}

export interface NormalizedDisplayMessage {
  readonly msgId: string;
  readonly role: string | null;
  readonly turnId: string | null;
  readonly source: string | null;
  readonly sourceContextJson: string | null;
  readonly createdAtMs: number;
  readonly dataJson: string;
}

export interface MessageSourceRecord {
  readonly source?: string;
  readonly sourceContext?: Record<string, unknown>;
}

export interface MessageUpsertInput {
  readonly sessionId: string;
  readonly message: DisplayMessageRecord;
  readonly turnId?: string;
  readonly source?: string;
  readonly sourceContext?: Record<string, unknown>;
}
export interface MessageWriteOptions {
  /** Cancels lock contention waits; immediately available cleanup writes still commit. */
  readonly signal?: AbortSignal;
}
export interface UserMessageCommitInput extends MessageUpsertInput {
  readonly unconsumedFromTurnIds?: readonly string[];
  /** Trusted Queue startup lineage; the initial Host never read these rows. */
  readonly unstartedFromTurnIds?: readonly string[];
  readonly turnId: string;
}
export interface UserMessageCommitResult {
  readonly created: boolean;
  readonly firstUserMessageForSession: boolean;
  readonly message: DisplayMessageRecord;
}
export interface MessageReplaceInput {
  readonly sessionId: string;
  readonly messages: readonly DisplayMessageRecord[];
}
export interface MessageReplaceStreamInput {
  readonly sessionId: string;
  readonly batches: AsyncIterable<readonly DisplayMessageRecord[]>;
}
export interface MessageRewindInclusiveInput {
  readonly sessionId: string;
  readonly fromMessageId: string;
  /** Exact suffix captured before canonical publication, used for idempotent recovery. */
  readonly expectedDeletedMessageIds?: readonly string[];
}
export interface MessageRewindInclusiveResult {
  readonly deletedMessageIds: readonly string[];
}
export interface MessageRewindInput {
  readonly sessionId: string;
  readonly messageIds?: readonly string[];
  readonly afterMessageId?: string;
}
export interface ListMessagesOptions {
  readonly limit?: number;
  readonly before?: string;
}
export interface ListMessagesResult {
  readonly messages: readonly DisplayMessageRecord[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}
export type MessageReplayResult =
  | { readonly status: 'ok'; readonly messages: readonly DisplayMessageRecord[] }
  | { readonly status: 'missing-anchor'; readonly messages: readonly [] };

export interface MessageRepository {
  get(sessionId: string, msgId: string): Promise<DisplayMessageRecord | undefined>;
  list(sessionId: string, options?: ListMessagesOptions): Promise<ListMessagesResult>;
  listAfter(sessionId: string, afterMsgId?: string): Promise<MessageReplayResult>;
  listTurn(sessionId: string, turnId: string): Promise<DisplayMessageRecord[]>;
  listRecent(
    sessionId: string,
    options: {
      readonly limit: number;
      readonly role?: string;
      readonly excludePermissionResponses?: boolean;
    },
  ): Promise<DisplayMessageRecord[]>;
  commitUserMessage(input: UserMessageCommitInput): Promise<UserMessageCommitResult>;
  upsert(input: MessageUpsertInput, options?: MessageWriteOptions): Promise<NormalizedDisplayMessage>;
  upsertMany(
    inputs: readonly MessageUpsertInput[],
    options?: MessageWriteOptions,
  ): Promise<readonly NormalizedDisplayMessage[]>;
  replace(input: MessageReplaceInput): Promise<void>;
  replaceStream(input: MessageReplaceStreamInput): Promise<void>;
  rewindInclusive(input: MessageRewindInclusiveInput): Promise<MessageRewindInclusiveResult>;
  rewind(input: MessageRewindInput): Promise<void>;
  resolveTurnSource(sessionId: string, turnId: string): Promise<MessageSourceRecord | undefined>;
  latestDisplayRowId(sessionId: string): Promise<number>;
  delete(sessionId: string): Promise<void>;
  deleteSessionData(sessionId: string): Promise<void>;
  copyPrefix(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly throughMessageId: string;
  }): Promise<void>;
  copyPrefixAndAppendForkOrigin(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly throughMessageId: string;
  }): Promise<void>;
  appendForkOrigin(input: {
    readonly targetSessionId: string;
    readonly sourceSessionId: string;
  }): Promise<void>;
}

export interface MessageRepositoryOptions {
  readonly db: AppDb;
  /** Defaults to true; false skips source extraction and projection writes, including forks. */
  readonly sourceProjectionEnabled?: boolean;
  readonly nowMs?: () => number;
  readonly userMessageAdmission?: {
    rejectionInTransaction(
      db: AppDb,
      input: { readonly sessionId: string },
    ): 'invalid-session' | 'session-deleting' | undefined;
  };
}

export class MessageDataCorruptionError extends Error {
  constructor(
    readonly sessionId: string,
    readonly messageId: string,
  ) {
    super(`Display message row is corrupt: ${sessionId}/${messageId}`);
    this.name = 'MessageDataCorruptionError';
  }
}

export class UserMessageCommitConflictError extends Error {
  override readonly name = 'UserMessageCommitConflictError';
  readonly code = 'USER_MESSAGE_COMMIT_CONFLICT' as const;

  constructor(
    readonly sessionId: string,
    readonly messageId: string,
  ) {
    super(`Committed user message payload changed: ${sessionId}/${messageId}`);
  }
}

export class UserMessageCommitAdmissionError extends Error {
  override readonly name = 'UserMessageCommitAdmissionError';

  constructor(
    readonly sessionId: string,
    readonly reason: 'invalid-session' | 'session-deleting',
  ) {
    super(`User message commit rejected: ${sessionId}/${reason}`);
  }
}
