import { desc } from 'drizzle-orm';
import { alias, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const legacyMessages = sqliteTable('local_runtime_messages', {
  sessionId: text('session_id').primaryKey(),
  displayMessagesJson: text('display_messages_json').notNull(),
  piHistoryJson: text('pi_history_json').notNull(),
});

export const messageRows = sqliteTable(
  'local_runtime_message_rows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    messageId: text('msg_id').notNull(),
    role: text('role'),
    turnId: text('turn_id'),
    source: text('source'),
    sourceContextJson: text('source_context_json'),
    createdAtMs: integer('created_at_ms').notNull(),
    dataJson: text('data_json').notNull(),
  },
  (table) => [
    uniqueIndex('local_runtime_message_rows_session_message').on(table.sessionId, table.messageId),
    index('idx_local_runtime_message_rows_session_id').on(table.sessionId, table.id),
    index('idx_local_runtime_message_rows_session_role_id').on(
      table.sessionId,
      table.role,
      table.id,
    ),
    index('idx_local_runtime_message_rows_turn_source').on(
      table.sessionId,
      table.turnId,
      table.role,
      table.id,
    ),
  ],
);

export const messageRowMigrations = sqliteTable('local_runtime_message_row_migrations', {
  sessionId: text('session_id').primaryKey(),
  displayRowsBackfilledAtMs: integer('display_rows_backfilled_at_ms').notNull(),
});

export const sessionAssets = sqliteTable(
  'local_runtime_session_assets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    messageId: text('msg_id').notNull(),
    role: text('role'),
    messageCreatedAtMs: integer('message_created_at_ms').notNull(),
    assetIndex: integer('asset_index').notNull(),
    assetKey: text('asset_key').notNull(),
    sourceTag: text('source_tag').notNull(),
    path: text('path').notNull(),
    name: text('name'),
    assetType: text('asset_type'),
    artifactId: text('artifact_id'),
    driveNodeId: text('drive_node_id'),
    dataJson: text('data_json').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    uniqueIndex('local_runtime_session_assets_session_message_key').on(
      table.sessionId,
      table.messageId,
      table.assetKey,
    ),
    index('idx_local_runtime_session_assets_session_time').on(
      table.sessionId,
      desc(table.messageCreatedAtMs),
      desc(table.id),
    ),
    index('idx_local_runtime_session_assets_session_message').on(table.sessionId, table.messageId),
    index('idx_local_runtime_session_assets_session_key_time').on(
      table.sessionId,
      table.assetKey,
      desc(table.messageCreatedAtMs),
      desc(table.id),
    ),
  ],
);

export const newerSessionAssets = alias(sessionAssets, 'newer_asset');

export const sessionAssetIndexState = sqliteTable('local_runtime_session_asset_index_state', {
  sessionId: text('session_id').primaryKey(),
  indexVersion: integer('index_version').notNull(),
  indexedThroughMessageRowId: integer('indexed_through_message_row_id').notNull(),
  indexedAtMs: integer('indexed_at_ms').notNull(),
  status: text('status').notNull(),
  errorJson: text('error_json'),
});

/** SQLite maintains these revisions for repository writes and other connections alike. */
export const MESSAGE_ROW_REVISION_OBJECTS = {
  local_runtime_message_row_revisions: `CREATE TABLE local_runtime_message_row_revisions (
    version INTEGER PRIMARY KEY AUTOINCREMENT,
    row_id INTEGER NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    UNIQUE(session_id, msg_id)
  )`,
  local_runtime_message_revision_insert: `CREATE TRIGGER local_runtime_message_revision_insert
    AFTER INSERT ON local_runtime_message_rows BEGIN
      DELETE FROM local_runtime_message_row_revisions WHERE row_id = NEW.id
        OR (session_id = NEW.session_id AND msg_id = NEW.msg_id);
      INSERT INTO local_runtime_message_row_revisions (row_id, session_id, msg_id)
        VALUES (NEW.id, NEW.session_id, NEW.msg_id);
    END`,
  local_runtime_message_revision_update: `CREATE TRIGGER local_runtime_message_revision_update
    AFTER UPDATE ON local_runtime_message_rows BEGIN
      DELETE FROM local_runtime_message_row_revisions WHERE row_id IN (OLD.id, NEW.id)
        OR (session_id = NEW.session_id AND msg_id = NEW.msg_id);
      INSERT INTO local_runtime_message_row_revisions (row_id, session_id, msg_id)
        VALUES (NEW.id, NEW.session_id, NEW.msg_id);
    END`,
  local_runtime_message_revision_delete: `CREATE TRIGGER local_runtime_message_revision_delete
    AFTER DELETE ON local_runtime_message_rows BEGIN
      DELETE FROM local_runtime_message_row_revisions WHERE row_id = OLD.id;
    END`,
} as const;
