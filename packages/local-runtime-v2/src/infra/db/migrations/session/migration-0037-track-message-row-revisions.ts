import type { MigrationEntry } from '../../migrate.js';
import { MESSAGE_ROW_REVISION_OBJECTS } from '../../schema/messages.js';

export const migration: MigrationEntry = {
  version: 37,
  name: 'track_message_row_revisions',
  up(database) {
    for (const definition of Object.values(MESSAGE_ROW_REVISION_OBJECTS)) database.exec(definition);
    database.exec(`INSERT INTO local_runtime_message_row_revisions (row_id, session_id, msg_id)
      SELECT id, session_id, msg_id FROM local_runtime_message_rows ORDER BY id`);
  },
};
