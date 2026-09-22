import { and, asc, desc, eq, gt, gte, inArray, lt, lte, placeholder, sql } from 'drizzle-orm';

import type { AppDb } from '../../../../infra/db/client.js';
import { runWithWriteLock } from '../../../../infra/db/write-transaction.js';
import {
  legacyMessages,
  messageRowMigrations,
  messageRows,
  sessionAssetIndexState,
  sessionAssets,
} from '../../../../infra/db/schema/messages.js';
import { replaceMessageAssets } from '../asset-index.js';
import { decodeDisplayMessage, decodeMessageSource, normalizeDisplayMessage } from './codec.js';
import type {
  ListMessagesOptions,
  ListMessagesResult,
  MessageRepository,
  MessageRepositoryOptions,
  MessageReplayResult,
  MessageReplaceInput,
  MessageReplaceStreamInput,
  MessageRewindInput,
  MessageRewindInclusiveInput,
  MessageRewindInclusiveResult,
  MessageUpsertInput,
  MessageWriteOptions,
  DisplayMessageRecord,
  NormalizedDisplayMessage,
  UserMessageCommitInput,
  UserMessageCommitResult,
} from './contract.js';
import { UserMessageCommitAdmissionError, UserMessageCommitConflictError } from './contract.js';
import { ensureMessageRowsReadyInTransaction } from './readiness.js';
import { syncMessageSourceProjection } from './source-projection.js';

export function createMessageRepository(options: MessageRepositoryOptions): MessageRepository {
  return new DrizzleMessageRepository(options);
}

function prepareMessageRead(db: AppDb) {
  return db
    .select()
    .from(messageRows)
    .where(
      and(
        eq(messageRows.sessionId, placeholder('sessionId')),
        eq(messageRows.messageId, placeholder('msgId')),
      ),
    )
    .prepare();
}

function prepareTurnRead(db: AppDb) {
  return db
    .select()
    .from(messageRows)
    .where(
      and(
        eq(messageRows.sessionId, placeholder('sessionId')),
        eq(messageRows.turnId, placeholder('turnId')),
      ),
    )
    .orderBy(asc(messageRows.id))
    .prepare();
}

const messageReads = new WeakMap<AppDb, ReturnType<typeof prepareMessageRead>>();
const turnReads = new WeakMap<AppDb, ReturnType<typeof prepareTurnRead>>();

function isCanonicalAssistant(message: DisplayMessageRecord): boolean {
  return message.role === 'assistant' &&
    !(typeof message.kind === 'string' && message.kind.length > 0) &&
    !(typeof message.displayKind === 'string' && message.displayKind.length > 0);
}

class DrizzleMessageRepository implements MessageRepository {
  private readonly nowMs: () => number;
  constructor(private readonly options: MessageRepositoryOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  async get(sessionId: string, msgId: string): Promise<DisplayMessageRecord | undefined> {
    this.ensureReady(sessionId);
    const db = this.options.db;
    let query = messageReads.get(db);
    if (!query) {
      query = prepareMessageRead(db);
      messageReads.set(db, query);
    }
    const row = query.get({ sessionId, msgId });
    return row ? decodeDisplayMessage(row) : undefined;
  }

  async list(sessionId: string, options: ListMessagesOptions = {}): Promise<ListMessagesResult> {
    this.ensureReady(sessionId);
    const anchorId = options.before ? this.messageRowId(sessionId, options.before) : undefined;
    const limit = normalizeLimit(options.limit, 0);
    const query = this.options.db
      .select()
      .from(messageRows)
      .where(
        and(
          eq(messageRows.sessionId, sessionId),
          anchorId === undefined ? undefined : lt(messageRows.id, anchorId),
        ),
      )
      .orderBy(desc(messageRows.id));
    const rows = limit > 0 ? query.limit(limit + 1).all() : query.all();
    const hasMore = limit > 0 && rows.length > limit;
    const selected = (hasMore ? rows.slice(0, limit) : rows).reverse();
    return {
      messages: selected.map(decodeDisplayMessage),
      hasMore,
      ...(hasMore && selected[0] ? { nextCursor: selected[0].messageId } : {}),
    };
  }

  async listAfter(sessionId: string, afterMsgId?: string): Promise<MessageReplayResult> {
    this.ensureReady(sessionId);
    const anchorId = afterMsgId ? this.messageRowId(sessionId, afterMsgId) : undefined;
    if (afterMsgId && anchorId === undefined) return { status: 'missing-anchor', messages: [] };
    const rows = this.options.db
      .select()
      .from(messageRows)
      .where(
        and(
          eq(messageRows.sessionId, sessionId),
          anchorId === undefined ? undefined : gt(messageRows.id, anchorId),
        ),
      )
      .orderBy(asc(messageRows.id))
      .all();
    return { status: 'ok', messages: rows.map(decodeDisplayMessage) };
  }

  async listTurn(sessionId: string, turnId: string): Promise<DisplayMessageRecord[]> {
    this.ensureReady(sessionId);
    const db = this.options.db;
    let query = turnReads.get(db);
    if (!query) {
      query = prepareTurnRead(db);
      turnReads.set(db, query);
    }
    return query.all({ sessionId, turnId }).map(decodeDisplayMessage);
  }

  async listCanonicalAssistantTail(
    sessionId: string, turnId: string, limit: number,
  ): Promise<DisplayMessageRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    this.ensureReady(sessionId);
    return this.options.db.transaction((tx) => {
      // Keep exact raw payloads inside SQLite. Unrelated writes through other
      // connections must not invalidate every row, and row ids alone are not
      // proof: external SQL can replace or rewrite an existing row.
      tx.run(sql`CREATE TEMP TABLE IF NOT EXISTS mcode_display_validation (
        id INTEGER PRIMARY KEY, message_id TEXT NOT NULL, data_json TEXT NOT NULL,
        source TEXT, source_context_json TEXT, assistant INTEGER NOT NULL
      )`);
      const turn = and(eq(messageRows.sessionId, sessionId), eq(messageRows.turnId, turnId));
      const size = tx.get<{ count: number; bytes: number }>(sql`SELECT count(*) AS count,
        coalesce(sum(length(CAST(data_json AS BLOB)) + length(CAST(msg_id AS BLOB)) +
          coalesce(length(CAST(source AS BLOB)), 0) +
          coalesce(length(CAST(source_context_json AS BLOB)), 0)), 0) AS bytes
        FROM ${messageRows} WHERE ${turn}`)!;
      // Bound the temporary payload copy. Oversized turns retain the uncached
      // full-decode behavior, including errors in rows outside the final tail.
      if (size.count > 4096 || size.bytes > 4 * 1024 * 1024) {
        tx.run(sql`DELETE FROM temp.mcode_display_validation`);
        return tx.select().from(messageRows).where(turn).orderBy(asc(messageRows.id))
          .all().map(decodeDisplayMessage).filter(isCanonicalAssistant).slice(-limit);
      }
      // Retain one turn only, including after deletes and turn transfers.
      tx.run(sql`DELETE FROM temp.mcode_display_validation WHERE id NOT IN
        (SELECT id FROM ${messageRows} WHERE ${turn})`);
      const changed = tx.select().from(messageRows).where(and(turn,
        sql`NOT EXISTS (SELECT 1 FROM temp.mcode_display_validation v
          WHERE v.id = ${messageRows.id} AND v.message_id IS ${messageRows.messageId}
            AND v.data_json IS ${messageRows.dataJson} AND v.source IS ${messageRows.source}
            AND v.source_context_json IS ${messageRows.sourceContextJson})`,
      )).orderBy(asc(messageRows.id)).all();
      for (const row of changed) {
        const message = decodeDisplayMessage(row);
        tx.run(sql`INSERT OR REPLACE INTO temp.mcode_display_validation VALUES
          (${row.id}, ${row.messageId}, ${row.dataJson}, ${row.source},
            ${row.sourceContextJson}, ${isCanonicalAssistant(message) ? 1 : 0})`);
      }
      return tx.select().from(messageRows).where(and(turn,
        sql`EXISTS (SELECT 1 FROM temp.mcode_display_validation v
          WHERE v.id = ${messageRows.id} AND v.assistant = 1)`,
      )).orderBy(desc(messageRows.id)).limit(limit).all().reverse().map(decodeDisplayMessage);
    });
  }

  async listRecent(
    sessionId: string,
    options: {
      readonly limit: number;
      readonly role?: string;
      readonly excludePermissionResponses?: boolean;
    },
  ): Promise<DisplayMessageRecord[]> {
    if (!Number.isFinite(options.limit) || options.limit <= 0) return [];
    this.ensureReady(sessionId);
    const rows = this.options.db
      .select()
      .from(messageRows)
      .where(
        and(
          eq(messageRows.sessionId, sessionId),
          options.role ? eq(messageRows.role, options.role) : undefined,
          options.excludePermissionResponses
            ? sql`instr(${messageRows.dataJson}, '<permission-response>') = 0`
            : undefined,
        ),
      )
      .orderBy(desc(messageRows.id))
      .limit(normalizeLimit(options.limit, 0))
      .all()
      .reverse();
    return rows.map(decodeDisplayMessage);
  }

  async commitUserMessage(input: UserMessageCommitInput): Promise<UserMessageCommitResult> {
    const normalized = normalizeDisplayMessage(input.message, {
      turnId: input.turnId,
      source: input.source,
      sourceContext: input.sourceContext,
      generatedIdDiscriminator: `user:${input.turnId}`,
      nowMs: this.nowMs,
    });
    return this.options.db.transaction(
      (tx) => {
        const rejection = this.options.userMessageAdmission?.rejectionInTransaction(tx, {
          sessionId: input.sessionId,
        });
        if (rejection) throw new UserMessageCommitAdmissionError(input.sessionId, rejection);
        this.ensureReadyInTransaction(tx, input.sessionId);
        const existing = tx
          .select()
          .from(messageRows)
          .where(
            and(
              eq(messageRows.sessionId, input.sessionId),
              eq(messageRows.messageId, normalized.msgId),
            ),
          )
          .get();
        if (existing) {
          const stored = normalizedFromRow(existing);
          if (!sameUserMessageCommit(stored, normalized)) {
            const transferred = unconsumedSteeringTransfer(stored, normalized, input);
            if (!transferred)
              throw new UserMessageCommitConflictError(input.sessionId, normalized.msgId);
            this.write(tx, input.sessionId, transferred, hasMessageProvenance(input));
            return {
              created: false,
              firstUserMessageForSession: false,
              message: decodeDisplayMessage({ ...existing, ...transferred }),
            };
          }
          return {
            created: false,
            firstUserMessageForSession: false,
            message: decodeDisplayMessage(existing),
          };
        }
        this.write(tx, input.sessionId, normalized, hasMessageProvenance(input));
        const inserted = tx
          .select()
          .from(messageRows)
          .where(
            and(
              eq(messageRows.sessionId, input.sessionId),
              eq(messageRows.messageId, normalized.msgId),
            ),
          )
          .get();
        if (!inserted) throw new Error('Stable user Message insert did not produce a row');
        const userMessageCount =
          tx
            .select({ count: sql<number>`count(*)` })
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, input.sessionId), eq(messageRows.role, 'user')))
            .get()?.count ?? 0;
        return {
          created: true,
          firstUserMessageForSession: userMessageCount === 1,
          message: decodeDisplayMessage(inserted),
        };
      },
      { behavior: 'immediate' },
    );
  }

  async upsert(
    input: MessageUpsertInput,
    options?: MessageWriteOptions,
  ): Promise<NormalizedDisplayMessage> {
    const [result] = await this.upsertMany([input], options);
    if (!result) throw new Error('Message upsert returned no row');
    return result;
  }

  async upsertMany(
    inputs: readonly MessageUpsertInput[],
    options?: MessageWriteOptions,
  ): Promise<readonly NormalizedDisplayMessage[]> {
    const sessionId = inputs[0]?.sessionId;
    if (!sessionId) return [];
    if (inputs.some((input) => input.sessionId !== sessionId)) {
      throw new TypeError('Atomic message upsert must target one Session');
    }
    const normalized = inputs.map((input, index) => ({
      message: normalizeDisplayMessage(input.message, {
        turnId: input.turnId,
        source: input.source,
        sourceContext: input.sourceContext,
        generatedIdDiscriminator: `upsert:${index}`,
        nowMs: this.nowMs,
      }),
      replaceProvenance: hasMessageProvenance(input),
    }));
    await runWithWriteLock(
      this.options.db,
      (tx) => {
        this.ensureReadyInTransaction(tx, sessionId);
        normalized.forEach(({ message, replaceProvenance }) =>
          this.write(tx, sessionId, message, replaceProvenance),
        );
      },
      options,
    );
    return normalized.map(({ message }) => message);
  }

  async replace(input: MessageReplaceInput): Promise<void> {
    const normalized = this.normalizeReplacementBatch(input.messages, 0);
    this.writeReplacementBatch(input.sessionId, normalized, true);
  }

  async replaceStream(input: MessageReplaceStreamInput): Promise<void> {
    let replaceExisting = true;
    let messageIndex = 0;
    for await (const batch of input.batches) {
      if (batch.length === 0) continue;
      const normalized = this.normalizeReplacementBatch(batch, messageIndex);
      this.writeReplacementBatch(input.sessionId, normalized, replaceExisting);
      messageIndex += normalized.length;
      replaceExisting = false;
    }
    if (replaceExisting) this.writeReplacementBatch(input.sessionId, [], true);
  }

  async rewindInclusive(input: MessageRewindInclusiveInput): Promise<MessageRewindInclusiveResult> {
    return this.options.db.transaction(
      (tx) => {
        this.ensureReadyInTransaction(tx, input.sessionId);
        if (!input.fromMessageId.startsWith('msg-user-v1-')) {
          throw new Error(`Rewind target must be a committed user message: ${input.fromMessageId}`);
        }
        const target = tx
          .select({ id: messageRows.id, messageId: messageRows.messageId, role: messageRows.role })
          .from(messageRows)
          .where(
            and(
              eq(messageRows.sessionId, input.sessionId),
              eq(messageRows.messageId, input.fromMessageId),
            ),
          )
          .get();
        if (!target || target.role !== 'user') {
          if (input.expectedDeletedMessageIds?.includes(input.fromMessageId)) {
            const remaining = tx
              .select({ messageId: messageRows.messageId })
              .from(messageRows)
              .where(
                and(
                  eq(messageRows.sessionId, input.sessionId),
                  inArray(messageRows.messageId, [...input.expectedDeletedMessageIds]),
                ),
              )
              .limit(1)
              .get();
            if (!remaining) return { deletedMessageIds: input.expectedDeletedMessageIds };
          }
          throw new Error(
            `Rewind target user message not found: ${input.sessionId}/${input.fromMessageId}`,
          );
        }
        const deletedRows = tx
          .select({ messageId: messageRows.messageId })
          .from(messageRows)
          .where(and(eq(messageRows.sessionId, input.sessionId), gte(messageRows.id, target.id)))
          .orderBy(asc(messageRows.id))
          .all();
        const deletedMessageIds = deletedRows.map(({ messageId }) => messageId);
        if (
          input.expectedDeletedMessageIds &&
          (deletedMessageIds.length !== input.expectedDeletedMessageIds.length ||
            deletedMessageIds.some(
              (messageId, index) => messageId !== input.expectedDeletedMessageIds?.[index],
            ))
        ) {
          throw new Error(
            `Display Rewind suffix changed: ${input.sessionId}/${input.fromMessageId}`,
          );
        }
        tx.delete(messageRows)
          .where(and(eq(messageRows.sessionId, input.sessionId), gte(messageRows.id, target.id)))
          .run();
        tx.delete(sessionAssets)
          .where(
            and(
              eq(sessionAssets.sessionId, input.sessionId),
              inArray(sessionAssets.messageId, deletedMessageIds),
            ),
          )
          .run();
        this.markSessionAssetIndexCurrent(tx, input.sessionId);
        return { deletedMessageIds };
      },
      { behavior: 'immediate' },
    );
  }

  async rewind(input: MessageRewindInput): Promise<void> {
    this.mutationTransaction(input.sessionId, (tx) => {
      const ids = new Set(input.messageIds ?? []);
      const anchorId = input.afterMessageId
        ? this.messageRowId(input.sessionId, input.afterMessageId, tx)
        : undefined;
      if (anchorId !== undefined) {
        tx.select({ messageId: messageRows.messageId })
          .from(messageRows)
          .where(and(eq(messageRows.sessionId, input.sessionId), gt(messageRows.id, anchorId)))
          .all()
          .forEach(({ messageId }) => ids.add(messageId));
      }
      if (ids.size === 0) return;
      tx.delete(messageRows)
        .where(
          and(eq(messageRows.sessionId, input.sessionId), inArray(messageRows.messageId, [...ids])),
        )
        .run();
      tx.delete(sessionAssets)
        .where(
          and(
            eq(sessionAssets.sessionId, input.sessionId),
            inArray(sessionAssets.messageId, [...ids]),
          ),
        )
        .run();
    });
  }

  async resolveTurnSource(sessionId: string, turnId: string) {
    this.ensureReady(sessionId);
    const row = this.options.db
      .select()
      .from(messageRows)
      .where(
        and(
          eq(messageRows.sessionId, sessionId),
          eq(messageRows.turnId, turnId),
          eq(messageRows.role, 'user'),
        ),
      )
      .orderBy(asc(messageRows.id))
      .limit(1)
      .get();
    return row ? decodeMessageSource(row) : undefined;
  }

  async latestDisplayRowId(sessionId: string): Promise<number> {
    this.ensureReady(sessionId);
    return (
      this.options.db
        .select({ id: messageRows.id })
        .from(messageRows)
        .where(eq(messageRows.sessionId, sessionId))
        .orderBy(desc(messageRows.id))
        .limit(1)
        .get()?.id ?? 0
    );
  }

  async copyPrefix(input: {
    sourceSessionId: string;
    targetSessionId: string;
    throughMessageId: string;
  }): Promise<void> {
    this.copyPrefixInTransaction(this.options.db, input);
  }

  async copyPrefixAndAppendForkOrigin(input: {
    sourceSessionId: string;
    targetSessionId: string;
    throughMessageId: string;
  }): Promise<void> {
    this.options.db.transaction(
      (tx) => {
        this.copyPrefixInTransaction(tx, input);
        this.appendForkOriginInTransaction(tx, input);
      },
      { behavior: 'immediate' },
    );
  }

  private copyPrefixInTransaction(
    db: AppDb,
    input: { sourceSessionId: string; targetSessionId: string; throughMessageId: string },
  ): void {
    this.ensureReadyInTransaction(db, input.sourceSessionId);
    const anchor = db
      .select({ id: messageRows.id })
      .from(messageRows)
      .where(
        and(
          eq(messageRows.sessionId, input.sourceSessionId),
          eq(messageRows.messageId, input.throughMessageId),
        ),
      )
      .get();
    if (!anchor)
      throw new Error(
        `Prefix anchor not found: ${input.sourceSessionId}/${input.throughMessageId}`,
      );
    const rows = db
      .select()
      .from(messageRows)
      .where(and(eq(messageRows.sessionId, input.sourceSessionId), lte(messageRows.id, anchor.id)))
      .orderBy(asc(messageRows.id))
      .all()
      .filter((row) => !isForkOriginMessage(decodeDisplayMessage(row)));
    for (const row of rows) {
      const message = normalizedFromRow(row);
      db.insert(messageRows)
        .values({
          sessionId: input.targetSessionId,
          messageId: message.msgId,
          role: message.role,
          turnId: message.turnId,
          source: message.source,
          sourceContextJson: message.sourceContextJson,
          createdAtMs: message.createdAtMs,
          dataJson: message.dataJson,
        })
        .onConflictDoUpdate({
          target: [messageRows.sessionId, messageRows.messageId],
          set: {
            role: message.role,
            turnId: message.turnId,
            source: message.source,
            sourceContextJson: message.sourceContextJson,
            createdAtMs: message.createdAtMs,
            dataJson: message.dataJson,
          },
        })
        .run();
      if (this.options.sourceProjectionEnabled !== false) {
        syncMessageSourceProjection(db, input.targetSessionId, message, this.nowMs());
      }
    }
  }

  async appendForkOrigin(input: {
    targetSessionId: string;
    sourceSessionId: string;
  }): Promise<void> {
    this.options.db.transaction((tx) => {
      this.ensureReadyInTransaction(tx, input.targetSessionId);
      this.appendForkOriginInTransaction(tx, input);
    });
  }

  private appendForkOriginInTransaction(
    db: AppDb,
    input: { readonly targetSessionId: string; readonly sourceSessionId: string },
  ): void {
    const message = {
      role: 'system',
      kind: 'fork-origin',
      forkOrigin: { sourceSessionId: input.sourceSessionId },
    };
    this.write(
      db,
      input.targetSessionId,
      normalizeDisplayMessage(message, {
        generatedIdDiscriminator: `fork-origin:${input.targetSessionId}`,
        nowMs: this.nowMs,
      }),
    );
  }

  async delete(sessionId: string): Promise<void> {
    await this.replace({ sessionId, messages: [] });
  }

  async deleteSessionData(sessionId: string): Promise<void> {
    this.options.db.transaction((tx) => {
      tx.delete(sessionAssets).where(eq(sessionAssets.sessionId, sessionId)).run();
      tx.delete(sessionAssetIndexState)
        .where(eq(sessionAssetIndexState.sessionId, sessionId))
        .run();
      tx.delete(messageRows).where(eq(messageRows.sessionId, sessionId)).run();
      tx.delete(messageRowMigrations).where(eq(messageRowMigrations.sessionId, sessionId)).run();
      const legacy = tx
        .select({ piHistoryJson: legacyMessages.piHistoryJson })
        .from(legacyMessages)
        .where(eq(legacyMessages.sessionId, sessionId))
        .get();
      if (legacy?.piHistoryJson === '[]') {
        tx.delete(legacyMessages).where(eq(legacyMessages.sessionId, sessionId)).run();
      } else if (legacy) {
        tx.update(legacyMessages)
          .set({ displayMessagesJson: '[]' })
          .where(eq(legacyMessages.sessionId, sessionId))
          .run();
      }
    });
  }

  private ensureReady(sessionId: string): void {
    const marker = this.options.db
      .select({ sessionId: messageRowMigrations.sessionId })
      .from(messageRowMigrations)
      .where(eq(messageRowMigrations.sessionId, sessionId))
      .get();
    if (marker) return;
    this.mutationTransaction(sessionId, () => undefined);
  }
  private mutationTransaction<T>(sessionId: string, mutation: (db: AppDb) => T): T {
    return this.options.db.transaction(
      (tx) => {
        this.ensureReadyInTransaction(tx, sessionId);
        return mutation(tx);
      },
      { behavior: 'immediate' },
    );
  }
  private ensureReadyInTransaction(db: AppDb, sessionId: string): void {
    ensureMessageRowsReadyInTransaction(db, sessionId, this.nowMs(), (message, index) => {
      const normalized = normalizeDisplayMessage(message, {
        generatedIdDiscriminator: `legacy:${index}`,
        nowMs: this.nowMs,
      });
      this.write(db, sessionId, normalized);
    });
  }
  private write(
    db: AppDb,
    sessionId: string,
    message: NormalizedDisplayMessage,
    replaceProvenance = true,
  ): void {
    const existing = replaceProvenance
      ? undefined
      : db
          .select({
            source: messageRows.source,
            sourceContextJson: messageRows.sourceContextJson,
          })
          .from(messageRows)
          .where(
            and(eq(messageRows.sessionId, sessionId), eq(messageRows.messageId, message.msgId)),
          )
          .get();
    const source = existing?.source ?? message.source;
    const sourceContextJson = existing?.sourceContextJson ?? message.sourceContextJson;
    db.insert(messageRows)
      .values({
        sessionId,
        messageId: message.msgId,
        role: message.role,
        turnId: message.turnId,
        source,
        sourceContextJson,
        createdAtMs: message.createdAtMs,
        dataJson: message.dataJson,
      })
      .onConflictDoUpdate({
        target: [messageRows.sessionId, messageRows.messageId],
        set: {
          role: message.role,
          turnId: message.turnId,
          source,
          sourceContextJson,
          createdAtMs: message.createdAtMs,
          dataJson: message.dataJson,
        },
      })
      .run();
    if (this.options.sourceProjectionEnabled !== false) {
      syncMessageSourceProjection(db, sessionId, message, this.nowMs());
    }
    replaceMessageAssets(db, sessionId, message, this.nowMs());
  }
  private normalizeReplacementBatch(
    messages: readonly DisplayMessageRecord[],
    startIndex: number,
  ): readonly NormalizedDisplayMessage[] {
    return messages.map((message, index) =>
      normalizeDisplayMessage(message, {
        generatedIdDiscriminator: `replace:${String(startIndex + index)}`,
        nowMs: this.nowMs,
      }),
    );
  }
  private writeReplacementBatch(
    sessionId: string,
    messages: readonly NormalizedDisplayMessage[],
    replaceExisting: boolean,
  ): void {
    this.mutationTransaction(sessionId, (tx) => {
      if (replaceExisting) {
        tx.delete(messageRows).where(eq(messageRows.sessionId, sessionId)).run();
        tx.delete(sessionAssets).where(eq(sessionAssets.sessionId, sessionId)).run();
        tx.delete(sessionAssetIndexState)
          .where(eq(sessionAssetIndexState.sessionId, sessionId))
          .run();
      }
      messages.forEach((message) => this.write(tx, sessionId, message));
      this.markSessionAssetIndexCurrent(tx, sessionId);
    });
  }
  private markSessionAssetIndexCurrent(db: AppDb, sessionId: string): void {
    const latestRowId =
      db
        .select({ id: messageRows.id })
        .from(messageRows)
        .where(eq(messageRows.sessionId, sessionId))
        .orderBy(desc(messageRows.id))
        .limit(1)
        .get()?.id ?? 0;
    const state = {
      sessionId,
      indexVersion: 1,
      indexedThroughMessageRowId: latestRowId,
      indexedAtMs: this.nowMs(),
      status: 'ready',
      errorJson: null,
    };
    db.insert(sessionAssetIndexState)
      .values(state)
      .onConflictDoUpdate({ target: sessionAssetIndexState.sessionId, set: state })
      .run();
  }
  private messageRowId(
    sessionId: string,
    messageId: string,
    db: AppDb = this.options.db,
  ): number | undefined {
    return db
      .select({ id: messageRows.id })
      .from(messageRows)
      .where(and(eq(messageRows.sessionId, sessionId), eq(messageRows.messageId, messageId)))
      .get()?.id;
  }
}

function normalizedFromRow(row: typeof messageRows.$inferSelect): NormalizedDisplayMessage {
  return {
    msgId: row.messageId,
    role: row.role,
    turnId: row.turnId,
    source: row.source,
    sourceContextJson: row.sourceContextJson,
    createdAtMs: row.createdAtMs,
    dataJson: row.dataJson,
  };
}

function unconsumedSteeringTransfer(
  stored: NormalizedDisplayMessage,
  intended: NormalizedDisplayMessage,
  input: Pick<UserMessageCommitInput, 'unconsumedFromTurnIds' | 'unstartedFromTurnIds'>,
): NormalizedDisplayMessage | undefined {
  if (stored.role !== 'user') return undefined;
  const oldData = parseJsonRecord(stored.dataJson);
  if (!canTransferUnconsumedDisplay(stored, oldData, input)) return undefined;
  const newData = parseJsonRecord(intended.dataJson);
  const samePayload = { ...newData };
  for (const field of ['kind', 'query_key', 'turnId']) {
    if (Object.hasOwn(oldData, field)) samePayload[field] = oldData[field];
    else delete samePayload[field];
  }
  if (
    !sameUserMessageCommit(stored, {
      ...intended,
      turnId: stored.turnId,
      dataJson: JSON.stringify(samePayload),
    })
  )
    return undefined;
  return {
    ...intended,
    createdAtMs: stored.createdAtMs,
    dataJson: JSON.stringify({
      ...newData,
      timestamp: oldData.timestamp,
      ...(oldData.created_at !== undefined ? { created_at: oldData.created_at } : {}),
    }),
  };
}

function canTransferUnconsumedDisplay(
  stored: NormalizedDisplayMessage,
  data: Record<string, unknown>,
  input: Pick<UserMessageCommitInput, 'unconsumedFromTurnIds' | 'unstartedFromTurnIds'>,
): boolean {
  const turnId = stored.turnId ?? '';
  return (
    input.unstartedFromTurnIds?.includes(turnId) === true ||
    (data.kind === 'steered_user' && input.unconsumedFromTurnIds?.includes(turnId) === true)
  );
}

function sameUserMessageCommit(
  stored: NormalizedDisplayMessage,
  intended: NormalizedDisplayMessage,
): boolean {
  return JSON.stringify(commitIdentity(stored)) === JSON.stringify(commitIdentity(intended));
}

function commitIdentity(message: NormalizedDisplayMessage): unknown {
  const data = parseJsonRecord(message.dataJson);
  delete data.timestamp;
  delete data.created_at;
  return canonicalJsonValue({
    role: message.role,
    turnId: message.turnId,
    source: message.source,
    sourceContext: message.sourceContextJson ? parseJsonRecord(message.sourceContextJson) : null,
    data,
  });
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Committed user Message JSON must be an object');
  }
  return { ...(parsed as Record<string, unknown>) };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

function hasMessageProvenance(input: MessageUpsertInput): boolean {
  return (
    input.message.source !== undefined ||
    input.message.sourceContext !== undefined ||
    input.source !== undefined ||
    input.sourceContext !== undefined
  );
}

function isForkOriginMessage(message: DisplayMessageRecord): boolean {
  return message.kind === 'fork-origin' || message.displayKind === 'fork-origin';
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : fallback;
}
