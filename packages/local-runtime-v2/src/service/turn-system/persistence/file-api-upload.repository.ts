import { and, eq } from 'drizzle-orm';

import type { AppDb } from '../../../infra/db/client.js';
import { fileApiUploads } from '../../../infra/db/schema/file-api.js';
import type {
  FileApiUploadKey,
  FileApiUploadStore,
  FileApiUploadStoreSource,
  MessagesFileApiPatcherLogger,
} from '../agent-host/assembly/messages-file-api-patcher.js';

export function createFileApiRuntime(options: {
  readonly db: AppDb;
  readonly nowMs?: (() => number) | undefined;
  readonly product?:
    | { readonly fetchImpl?: typeof fetch; readonly logger?: MessagesFileApiPatcherLogger }
    | undefined;
}): {
  readonly uploadStores: FileApiUploadStoreSource;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: MessagesFileApiPatcherLogger;
} {
  return {
    uploadStores: createFileApiUploadStoreSource({
      db: options.db,
      ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    }),
    ...(options.product?.fetchImpl ? { fetchImpl: options.product.fetchImpl } : {}),
    ...(options.product?.logger ? { logger: options.product.logger } : {}),
  };
}

export function createFileApiUploadStoreSource(options: {
  readonly db: AppDb;
  readonly nowMs?: () => number;
}): FileApiUploadStoreSource {
  const nowMs = options.nowMs ?? Date.now;
  return {
    forSession: (sessionId) => createSessionStore(options.db, sessionId, nowMs),
  };
}

function createSessionStore(db: AppDb, sessionId: string, nowMs: () => number): FileApiUploadStore {
  return {
    get: (cacheKey, key) => {
      const row = db
        .select()
        .from(fileApiUploads)
        .where(and(eq(fileApiUploads.sessionId, sessionId), eq(fileApiUploads.cacheKey, cacheKey)))
        .get();
      if (!row || !matchesKey(row, key)) return undefined;
      if (row.expiresAtMs <= nowMs()) {
        db.delete(fileApiUploads)
          .where(
            and(eq(fileApiUploads.sessionId, sessionId), eq(fileApiUploads.cacheKey, cacheKey)),
          )
          .run();
        return undefined;
      }
      return { fileId: row.fileId, expiresAtMs: row.expiresAtMs };
    },
    set: (cacheKey, _entry, record) => {
      const now = nowMs();
      db.insert(fileApiUploads)
        .values({
          sessionId,
          cacheKey,
          contentHash: record.contentHash,
          endpointHash: record.endpointHash,
          callerIdentityHash: record.callerIdentityHash,
          ttlSec: record.ttlSec,
          fileId: record.fileId,
          expiresAtMs: record.expiresAtMs,
          createdAtMs: now,
          updatedAtMs: now,
        })
        .onConflictDoUpdate({
          target: [fileApiUploads.sessionId, fileApiUploads.cacheKey],
          set: {
            contentHash: record.contentHash,
            endpointHash: record.endpointHash,
            callerIdentityHash: record.callerIdentityHash,
            ttlSec: record.ttlSec,
            fileId: record.fileId,
            expiresAtMs: record.expiresAtMs,
            updatedAtMs: now,
          },
        })
        .run();
    },
  };
}

function matchesKey(row: typeof fileApiUploads.$inferSelect, key: FileApiUploadKey): boolean {
  return (
    row.contentHash === key.contentHash &&
    row.endpointHash === key.endpointHash &&
    row.callerIdentityHash === key.callerIdentityHash &&
    row.ttlSec === key.ttlSec
  );
}
