import type { MigrationEntry } from './migrate.js';
import { migration as m0014 } from './migrations/agent/migration-0014-create-agents.js';
import { migration as m0024 } from './migrations/canvas/migration-0024-create-canvas.js';
import { migration as m0031 } from './migrations/canvas/migration-0031-repair-canvas-version-collision.js';
import { migration as m0002 } from './migrations/cron/migration-0002-copy-legacy-cron-data.js';
import { migration as m0004 } from './migrations/cron/migration-0004-copy-legacy-cron-run-history.js';
import { migration as m0036 } from './migrations/cron/migration-0036-repair-cron-manual-request-index.js';
import { migration as m0005 } from './migrations/plugin/migration-0005-adopt-plugin-state.js';
import { migration as m0023 } from './migrations/miniapp/migration-0023-create-miniapp-state.js';
import { migration as m0030 } from './migrations/miniapp/migration-0030-repair-liveboard-state-version-collision.js';
import { migration as m0001 } from './migrations/runtime/migration-0001-runtime-v2-baseline.js';
import { migration as m0003 } from './migrations/runtime/migration-0003-add-scheduler-generation.js';
import { migration as m0006 } from './migrations/session/migration-0006-create-session-storage.js';
import { migration as m0007 } from './migrations/session/migration-0007-backfill-session-storage.js';
import { migration as m0008 } from './migrations/session/migration-0008-normalize-turn-ingress.js';
import { migration as m0009 } from './migrations/session/migration-0009-session-query-indexes.js';
import { migration as m0010 } from './migrations/session/migration-0010-converge-session-queue.js';
import { migration as m0011 } from './migrations/session/migration-0011-create-file-api-upload-cache.js';
import { migration as m0012 } from './migrations/session/migration-0012-restore-legacy-primary-agent.js';
import { migration as m0013 } from './migrations/session/migration-0013-backfill-v1-session-record-json.js';
import { migration as m0015 } from './migrations/session/migration-0015-repair-legacy-default-projects.js';
import { migration as m0016 } from './migrations/session/migration-0016-create-query-collapse-view-states.js';
import { migration as m0017 } from './migrations/session/migration-0017-align-project-task-aggregates.js';
import { migration as m0018 } from './migrations/session/migration-0018-restore-project-v5-trigger-compatibility.js';
import { migration as m0020 } from './migrations/session/migration-0020-create-task-session-bindings.js';
import { migration as m0021 } from './migrations/session/migration-0021-add-session-history-relative-dir.js';
import { migration as m0022 } from './migrations/session/migration-0022-create-queue-pauses.js';
import { migration as m0025 } from './migrations/session/migration-0025-create-session-resources.js';
import { migration as m0026 } from './migrations/session/migration-0026-relax-source-tool-call-index.js';
import { migration as m0027 } from './migrations/session/migration-0027-repair-task-session-bindings-version-collision.js';
import { migration as m0028 } from './migrations/session/migration-0028-repair-session-history-relative-dir-version-collision.js';
import { migration as m0029 } from './migrations/session/migration-0029-repair-queue-pauses-version-collision.js';
import { migration as m0032 } from './migrations/session/migration-0032-repair-query-continuation-duration.js';
import { migration as m0033 } from './migrations/session/migration-0033-converge-channel-session-project-schema.js';
import { migration as m0034 } from './migrations/session/migration-0034-restore-shared-project-schema-compatibility.js';
import { migration as m0035 } from './migrations/session/migration-0035-converge-published-schema-collisions.js';

import { migration as m0037 } from './migrations/session/migration-0037-track-message-row-revisions.js';

export const ALL_MIGRATIONS: readonly MigrationEntry[] = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
  m0010,
  m0011,
  m0012,
  m0013,
  m0014,
  m0015,
  m0016,
  m0017,
  m0018,
  m0020,
  m0021,
  m0022,
  m0023,
  m0024,
  m0025,
  m0026,
  m0027,
  m0028,
  m0029,
  m0030,
  m0031,
  m0032,
  m0033,
  m0034,
  m0035,
  m0036,
  m0037,
];
