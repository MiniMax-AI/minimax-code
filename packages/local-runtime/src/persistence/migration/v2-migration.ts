import fs from 'node:fs';
import path from 'node:path';
import { loadBetterSqlite3Module } from '../better-sqlite3-loader.js';
import { registerLocalAssetSync, type LocalRuntimeAssetRecord } from '../../assets/store.js';
import { openLocalRuntimeDb, type DatabaseConstructor, type DatabaseLike } from '../db.js';
import { getLocalRuntimeSqliteTableRoleLegend } from '../sqlite-table-roles.js';
import type { ModuleMetricsReporter } from '../../common/metrics.js';
import {
  formatV2TimestampParts,
  isPathInside,
  resolveV2DirectoryContract,
  resolveV2MigrationManifestDir,
  type DataDirInput,
} from '../layout/v2-paths.js';
import { dedupeRootSessionsSync, type RootSessionDedupEntry } from './v2-root-session-dedup.js';

export interface V2MigrationOptions {
  dataDir: DataDirInput;
  nowMs?: () => number;
  onError?: (err: Error) => void;
  /** Structured-log sink for migration sub-steps (defaults to console.log). */
  logLine?: (line: string) => void;
  /** Optional reporter for `legacy_migration_total{layer=v2_layout}`; absent → noop. */
  metrics?: ModuleMetricsReporter;
}

export interface V2MigrationManifest {
  schemaVersion: 1;
  /** Version of the historical attachment-ref scan completed by this run. */
  assetRefMigrationVersion?: number;
  /** Stable file identity used to invalidate the receipt after a DB replacement. */
  assetRefMigrationDbIdentity?: V2MigrationDbIdentity;
  migrationId: string;
  source: 'current-local-runtime';
  status: 'completed' | 'failed';
  startedAtMs: number;
  finishedAtMs: number;
  copied: string[];
  skipped: string[];
  assetRefsUpdated: number;
  errors: string[];
  /**
   * Root session dedup ledger (optional for compatibility with manifests
   * written before the dedup step existed). One entry per agent that had
   * more than one `sessionType === 'root'` session.
   */
  rootSessionsDeduped?: RootSessionDedupEntry[];
  /**
   * Dedup-scoped errors. Deliberately kept out of `errors` and never flip
   * `status` to 'failed': dedup is best-effort cleanup, and a dedup failure
   * must degrade to the previous multi-root behavior instead of bricking
   * startup via `ensureCurrentLocalRuntimeDataMigratedToV2OrThrow`.
   */
  rootSessionsDedupErrors?: string[];
}

/**
 * `dev` is still recorded for diagnostics, but identity checks compare only
 * (ino, birthtimeMs): macOS may assign a different st_dev to the same APFS
 * volume after a reboot, which must not invalidate a completed migration.
 */
export interface V2MigrationDbIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

const MANIFEST_PREFIX = 'current-local-runtime';
const ASSET_REF_MIGRATION_VERSION = 1;
const ASSET_REF_MIGRATION_CURRENT_SKIP = 'sqlite:asset-refs:migration-current';
const ROW_KEY_PAGE_SIZE = 1000;
const RESERVED_RECONCILE_TABLES = new Set(['local_runtime_schema_migrations']);
const REQUIRED_LOCAL_RUNTIME_TABLES = getLocalRuntimeSqliteTableRoleLegend().tables.map(
  (entry) => entry.table,
);
const V2_LAYOUT_MIGRATION_RECEIPT_BRAND = Symbol('v2-layout-migration-receipt-brand');

/**
 * Internal carrier shared only by the V2 composition root and the V1 host
 * boundary. Its value is still validated with the private migration brand.
 */
const V2_LAYOUT_MIGRATION_RECEIPT_CARRIER = Symbol.for(
  'mavis.local-runtime.v2-layout-migration-receipt',
);

export function ensureCurrentLocalRuntimeDataMigratedToV2(
  options: V2MigrationOptions,
): V2MigrationManifest {
  const nowMs = options.nowMs ?? (() => Date.now());
  const dataDir = resolveDataDir(options.dataDir);
  const startedAtMs = nowMs();
  const stamp = formatV2TimestampParts(startedAtMs);
  const manifest: V2MigrationManifest = {
    schemaVersion: 1,
    assetRefMigrationVersion: ASSET_REF_MIGRATION_VERSION,
    migrationId: `${MANIFEST_PREFIX}-${stamp.compact}`,
    source: 'current-local-runtime',
    status: 'completed',
    startedAtMs,
    finishedAtMs: startedAtMs,
    copied: [],
    skipped: [],
    assetRefsUpdated: 0,
    errors: [],
  };

  try {
    copyCurrentLocalRuntimeStores(dataDir, manifest);
    manifest.assetRefMigrationDbIdentity = readCurrentRuntimeDbIdentity(dataDir);
    const skipAssetRefMigration = isAssetRefMigrationCurrent(dataDir, manifest);
    const result = migrateCurrentLocalRuntimeAssetRefs({
      dataDir,
      nowMs,
      manifest,
      skipAssetRefMigration,
      // eslint-disable-next-line no-console
      logLine: options.logLine ?? ((line) => console.log(line)),
      onDone: (finishedManifest) => writeMigrationManifest(dataDir, nowMs(), finishedManifest),
      onError: options.onError,
    });
    reportV2LayoutMigration(options.metrics, result.status, nowMs() - startedAtMs);
    if (result.status === 'completed') {
      markCompletedV2LayoutMigrationReceipt(result, dataDir);
    }
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    manifest.status = 'failed';
    manifest.errors.push(error.message);
    manifest.finishedAtMs = nowMs();
    // Emit before the manifest write so a failing write can't drop the metric.
    reportV2LayoutMigration(options.metrics, 'failed', manifest.finishedAtMs - startedAtMs);
    writeMigrationManifest(dataDir, manifest.finishedAtMs, manifest);
    options.onError?.(error);
    return manifest;
  }
}

function reportV2LayoutMigration(
  metrics: ModuleMetricsReporter | undefined,
  status: V2MigrationManifest['status'],
  durationMs: number,
): void {
  if (!metrics) return;
  const outcome = status === 'completed' ? 'ok' : 'error';
  metrics.incr('legacy_migration_total', { layer: 'v2_layout', status: outcome });
  if (outcome === 'ok') {
    metrics.latency('legacy_migration_duration_ms', durationMs, { layer: 'v2_layout' });
  }
}

export function assertV2MigrationSucceeded(manifest: V2MigrationManifest): void {
  if (manifest.status !== 'failed') return;
  const reason = manifest.errors.length > 0 ? manifest.errors.join('; ') : 'unknown';
  throw new Error(`current_local_runtime_v2_migration_failed:${reason}`);
}

export function ensureCurrentLocalRuntimeDataMigratedToV2OrThrow(
  dataDir: DataDirInput,
  nowMs?: () => number,
  metrics?: ModuleMetricsReporter,
): V2MigrationManifest {
  const manifest = ensureCurrentLocalRuntimeDataMigratedToV2({ dataDir, nowMs, metrics });
  assertV2MigrationSucceeded(manifest);
  return manifest;
}

/** @internal Preserve a V2-owned receipt while constructing the V1 shell. */
export function copyV2LayoutMigrationReceipt<T extends object>(source: object, target: T): T {
  const receipt = readV2LayoutMigrationReceipt(source);
  if (receipt === undefined) return target;
  return attachV2LayoutMigrationReceipt(target, receipt);
}

/** @internal Fail closed unless this exact completed migration created the receipt. */
export function hasCompletedV2LayoutMigrationReceipt(
  carrier: object,
  dataDir: DataDirInput,
): boolean {
  const receipt = readV2LayoutMigrationReceipt(carrier);
  if (!receipt || typeof receipt !== 'object') return false;
  try {
    const manifest = receipt as V2MigrationManifest;
    const resolvedDataDir = resolveDataDir(dataDir);
    return (
      manifest.status === 'completed' &&
      manifest.source === 'current-local-runtime' &&
      Reflect.get(manifest, V2_LAYOUT_MIGRATION_RECEIPT_BRAND) === resolvedDataDir
    );
  } catch {
    return false;
  }
}

function attachV2LayoutMigrationReceipt<T extends object>(target: T, receipt: unknown): T {
  Object.defineProperty(target, V2_LAYOUT_MIGRATION_RECEIPT_CARRIER, {
    value: receipt,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return target;
}

function readV2LayoutMigrationReceipt(carrier: object): unknown {
  try {
    return Reflect.get(carrier, V2_LAYOUT_MIGRATION_RECEIPT_CARRIER);
  } catch {
    return undefined;
  }
}

function markCompletedV2LayoutMigrationReceipt(
  manifest: V2MigrationManifest,
  dataDir: string,
): void {
  Object.defineProperty(manifest, V2_LAYOUT_MIGRATION_RECEIPT_BRAND, {
    value: dataDir,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function copyCurrentLocalRuntimeStores(dataDir: string, manifest: V2MigrationManifest): void {
  const v2 = resolveV2DirectoryContract(dataDir);
  runMigrationStep('sqlite:dev-draft-v2:copy', () =>
    copyOrReconcileSqliteSnapshot(
      v2.legacyDraftDb,
      v2.db,
      'sqlite:dev-draft-v2',
      manifest,
      v2.root,
    ),
  );
  runMigrationStep('sqlite:dev-draft-v2:schema-check', () =>
    ensureCurrentRuntimeSqliteSchemaIfPresent(dataDir),
  );
  runMigrationStep('sqlite:legacy-current:copy', () =>
    copyOrReconcileSqliteSnapshot(
      path.join(dataDir, 'local-runtime', 'local-runtime.sqlite'),
      v2.db,
      'sqlite',
      manifest,
      v2.root,
    ),
  );
  runMigrationStep('sqlite:runtime-state:schema-check', () =>
    ensureCurrentRuntimeSqliteSchemaIfPresent(dataDir),
  );
  runMigrationStep('ledgers:copy', () =>
    copyDirIfMissing(
      path.join(dataDir, 'local-runtime', 'ledgers'),
      v2.legacyDraftLedgers,
      'ledgers',
      manifest,
      v2.root,
    ),
  );
  runMigrationStep('snapshots:copy', () =>
    copyDirIfMissing(
      path.join(dataDir, 'local-runtime', 'snapshots'),
      v2.legacyDraftSnapshots,
      'snapshots',
      manifest,
      v2.root,
    ),
  );
}

function migrateCurrentLocalRuntimeAssetRefs(input: {
  dataDir: string;
  nowMs: () => number;
  manifest: V2MigrationManifest;
  skipAssetRefMigration: boolean;
  logLine: (line: string) => void;
  onDone: (manifest: V2MigrationManifest) => void;
  onError?: (err: Error) => void;
}): V2MigrationManifest {
  try {
    const migratedAssets = new Map<string, LocalRuntimeAssetRecord>();
    const db = runMigrationStep('sqlite:runtime-state:open', () =>
      openLocalRuntimeDb(input.dataDir),
    );
    input.manifest.assetRefMigrationDbIdentity ??= readCurrentRuntimeDbIdentity(input.dataDir);
    runMigrationStep('sqlite:runtime-state:schema-check', () =>
      assertCurrentRuntimeSqliteSchemaComplete(db),
    );
    if (input.skipAssetRefMigration) {
      input.manifest.skipped.push(ASSET_REF_MIGRATION_CURRENT_SKIP);
    } else {
      input.manifest.assetRefsUpdated += runMigrationStep(
        'sqlite:message-rows:asset-ref-migration',
        () =>
          migrateJsonRows(db, {
            table: 'local_runtime_message_rows',
            idColumn: 'id',
            jsonColumn: 'data_json',
            sessionColumn: 'session_id',
            dataDir: input.dataDir,
            nowMs: input.nowMs,
            errors: input.manifest.errors,
            migratedAssets,
          }),
      );
      input.manifest.assetRefsUpdated += runMigrationStep(
        'sqlite:queue-items:asset-ref-migration',
        () =>
          migrateJsonRows(db, {
            table: 'local_runtime_queue_items',
            idColumn: 'id',
            jsonColumn: 'data_json',
            sessionColumn: 'session_id',
            dataDir: input.dataDir,
            nowMs: input.nowMs,
            errors: input.manifest.errors,
            migratedAssets,
          }),
      );
      input.manifest.assetRefsUpdated += runMigrationStep(
        'sqlite:packed-messages:asset-ref-migration',
        () =>
          migratePackedMessageRows(
            db,
            input.dataDir,
            input.nowMs,
            input.manifest.errors,
            migratedAssets,
          ),
      );
    }
    runMigrationStep('sqlite:root-sessions:dedupe', () => dedupeRootSessionsBestEffort(db, input));
    input.manifest.status = 'completed';
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    input.manifest.status = 'failed';
    input.manifest.errors.push(error.message);
    input.onError?.(error);
  } finally {
    input.manifest.finishedAtMs = input.nowMs();
    input.onDone(input.manifest);
  }
  return input.manifest;
}

function isAssetRefMigrationCurrent(dataDir: string, manifest: V2MigrationManifest): boolean {
  const currentDbIdentity = manifest.assetRefMigrationDbIdentity;
  if (!currentDbIdentity) return false;
  if (manifest.copied.some((entry) => entry === 'sqlite' || entry.startsWith('sqlite:'))) {
    return false;
  }
  const previous = readLatestV2LayoutMigrationManifest(dataDir);
  return Boolean(
    previous &&
    previous.status === 'completed' &&
    previous.source === 'current-local-runtime' &&
    previous.assetRefMigrationVersion === ASSET_REF_MIGRATION_VERSION &&
    isSameDbIdentity(previous.assetRefMigrationDbIdentity, currentDbIdentity) &&
    previous.errors.length === 0,
  );
}

function readCurrentRuntimeDbIdentity(dataDir: string): V2MigrationDbIdentity | undefined {
  try {
    const stats = fs.statSync(resolveV2DirectoryContract(dataDir).db);
    return stats.isFile()
      ? { dev: stats.dev, ino: stats.ino, birthtimeMs: Math.floor(stats.birthtimeMs) }
      : undefined;
  } catch {
    return undefined;
  }
}

function isSameDbIdentity(
  previous: V2MigrationDbIdentity | undefined,
  current: V2MigrationDbIdentity,
): boolean {
  return Boolean(
    previous && previous.ino === current.ino && previous.birthtimeMs === current.birthtimeMs,
  );
}

function readLatestV2LayoutMigrationManifest(dataDir: string): V2MigrationManifest | undefined {
  const root = resolveV2DirectoryContract(dataDir).migrationManifests;
  const manifestPath = collectV2LayoutMigrationManifestPaths(root).sort().at(-1);
  if (!manifestPath) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
    return isV2LayoutMigrationManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function collectV2LayoutMigrationManifestPaths(directory: string, depth = 0): string[] {
  if (depth > 3 || !fs.existsSync(directory)) return [];
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isSymbolicLink()) return [];
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectV2LayoutMigrationManifestPaths(entryPath, depth + 1);
      }
      return entry.isFile() && isV2LayoutMigrationManifestFile(entry.name) ? [entryPath] : [];
    });
  } catch {
    return [];
  }
}

function isV2LayoutMigrationManifestFile(fileName: string): boolean {
  return fileName.startsWith(`${MANIFEST_PREFIX}-`) && fileName.endsWith('.json');
}

function isV2LayoutMigrationManifest(value: unknown): value is V2MigrationManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<V2MigrationManifest>;
  return (
    manifest.schemaVersion === 1 &&
    typeof manifest.assetRefMigrationVersion === 'number' &&
    (manifest.status === 'completed' || manifest.status === 'failed') &&
    Array.isArray(manifest.errors)
  );
}

function runMigrationStep<T>(step: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new Error(`${step}:${formatMigrationError(err)}`);
  }
}

function formatMigrationError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the multi-root session dedup step, isolated so that a dedup failure can
 * never fail the surrounding v2 migration (P0: `status='failed'` would make
 * `ensureCurrentLocalRuntimeDataMigratedToV2OrThrow` brick host construction;
 * a dedup bug must only degrade to the previous multi-root behavior).
 *
 * Errors — both per-item soft errors returned by the dedup routine and a
 * thrown hard failure — land exclusively in `manifest.rootSessionsDedupErrors`.
 */
function dedupeRootSessionsBestEffort(
  db: DatabaseLike,
  input: {
    dataDir: string;
    nowMs: () => number;
    manifest: V2MigrationManifest;
    logLine: (line: string) => void;
  },
): void {
  const log = (event: string, payload: Record<string, unknown>) => {
    try {
      input.logLine(`[local-runtime][v2-root-dedup] ${JSON.stringify({ event, ...payload })}`);
    } catch {
      // Logging must never break the migration.
    }
  };
  try {
    const result = dedupeRootSessionsSync({ db, dataDir: input.dataDir, nowMs: input.nowMs, log });
    if (result.deduped.length > 0) input.manifest.rootSessionsDeduped = result.deduped;
    if (result.errors.length > 0) input.manifest.rootSessionsDedupErrors = result.errors;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.manifest.rootSessionsDedupErrors = [
      ...(input.manifest.rootSessionsDedupErrors ?? []),
      `dedup-fatal:${message}`,
    ];
    log('error', { stage: 'dedup-fatal', message });
  }
}

function migrateJsonRows(
  db: DatabaseLike,
  input: {
    table: string;
    idColumn: string;
    jsonColumn: string;
    sessionColumn: string;
    dataDir: string;
    nowMs: () => number;
    errors: string[];
    migratedAssets: Map<string, LocalRuntimeAssetRecord>;
  },
): number {
  if (!tableExists(db, input.table)) return 0;
  const selectRow = db.prepare(
    `SELECT ${input.jsonColumn} AS data, ${input.sessionColumn} AS sessionId FROM ${input.table} WHERE ${input.idColumn} = ?`,
  );
  const updateRow = db.prepare(
    `UPDATE ${input.table} SET ${input.jsonColumn} = ? WHERE ${input.idColumn} = ?`,
  );
  let updated = 0;
  forEachAttachmentRowKey(
    db,
    { table: input.table, keyColumn: input.idColumn, jsonColumns: [input.jsonColumn] },
    (id) => {
      const row = selectRow.get(id) as { data: string; sessionId: string } | undefined;
      if (!row) return;
      const parsed = parseJsonRecord(row.data);
      if (parsed === undefined) return;
      const result = migrateAttachmentRefs(
        parsed,
        input.dataDir,
        input.nowMs,
        input.errors,
        row.sessionId,
        input.migratedAssets,
      );
      if (!result.changed) return;
      updateRow.run(JSON.stringify(result.value), id);
      updated += result.updated;
    },
  );
  return updated;
}

function forEachAttachmentRowKey(
  db: DatabaseLike,
  input: { table: string; keyColumn: string; jsonColumns: readonly string[] },
  visit: (key: number | string) => void,
): void {
  const mentionsAttachments = input.jsonColumns
    .map((column) => `instr(${column}, '"attachments"') > 0`)
    .join(' OR ');
  const select = `SELECT ${input.keyColumn} AS rowKey FROM ${input.table}`;
  const order = `ORDER BY ${input.keyColumn} LIMIT ?`;
  const selectFirstPage = db.prepare(`${select} WHERE (${mentionsAttachments}) ${order}`);
  const selectNextPage = db.prepare(
    `${select} WHERE ${input.keyColumn} > ? AND (${mentionsAttachments}) ${order}`,
  );
  let cursor: number | string | undefined;
  for (;;) {
    const page = (
      cursor === undefined
        ? selectFirstPage.all(ROW_KEY_PAGE_SIZE)
        : selectNextPage.all(cursor, ROW_KEY_PAGE_SIZE)
    ) as Array<{ rowKey: number | string }>;
    const last = page.at(-1);
    if (!last) return;
    cursor = last.rowKey;
    for (const row of page) visit(row.rowKey);
  }
}

function migratePackedMessageRows(
  db: DatabaseLike,
  dataDir: string,
  nowMs: () => number,
  errors: string[],
  migratedAssets: Map<string, LocalRuntimeAssetRecord>,
): number {
  if (!tableExists(db, 'local_runtime_messages')) return 0;
  const selectRow = db.prepare(
    'SELECT display_messages_json AS displayMessages, pi_history_json AS piHistory FROM local_runtime_messages WHERE session_id = ?',
  );
  const updateRow = db.prepare(
    'UPDATE local_runtime_messages SET display_messages_json = ?, pi_history_json = ? WHERE session_id = ?',
  );
  let updated = 0;
  forEachAttachmentRowKey(
    db,
    {
      table: 'local_runtime_messages',
      keyColumn: 'session_id',
      jsonColumns: ['display_messages_json', 'pi_history_json'],
    },
    (sessionId) => {
      const row = selectRow.get(sessionId) as
        | { displayMessages: string; piHistory: string }
        | undefined;
      if (!row) return;
      const displayMessages = parseJsonRecord(row.displayMessages);
      const piHistory = parseJsonRecord(row.piHistory);
      let changed = false;
      let rowUpdated = 0;
      if (displayMessages !== undefined) {
        const result = migrateAttachmentRefs(
          displayMessages,
          dataDir,
          nowMs,
          errors,
          String(sessionId),
          migratedAssets,
        );
        changed = changed || result.changed;
        rowUpdated += result.updated;
        row.displayMessages = JSON.stringify(result.value);
      }
      if (piHistory !== undefined) {
        const result = migrateAttachmentRefs(
          piHistory,
          dataDir,
          nowMs,
          errors,
          String(sessionId),
          migratedAssets,
        );
        changed = changed || result.changed;
        rowUpdated += result.updated;
        row.piHistory = JSON.stringify(result.value);
      }
      if (!changed) return;
      updateRow.run(row.displayMessages, row.piHistory, String(sessionId));
      updated += rowUpdated;
    },
  );
  return updated;
}

function migrateAttachmentRefs(
  value: unknown,
  dataDir: string,
  nowMs: () => number,
  errors: string[],
  sessionId: string,
  migratedAssets: Map<string, LocalRuntimeAssetRecord>,
): { value: unknown; changed: boolean; updated: number } {
  let changed = false;
  let updated = 0;

  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      const next: unknown[] = [];
      for (const child of item) next.push(visit(child));
      return next;
    }
    if (!item || typeof item !== 'object') return item;
    const record = item as Record<string, unknown>;
    if (Array.isArray(record.attachments)) {
      const attachments: unknown[] = [];
      for (const attachment of record.attachments) {
        if (isAttachmentRecord(attachment)) {
          const migrated = migrateOneAttachment(
            attachment,
            dataDir,
            nowMs,
            errors,
            sessionId,
            migratedAssets,
          );
          if (migrated !== attachment) {
            changed = true;
            updated += 1;
          }
          attachments.push(migrated);
        } else {
          attachments.push(visit(attachment));
        }
      }
      record.attachments = attachments;
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === 'attachments') continue;
      record[key] = visit(child);
    }
    return record;
  };

  return { value: visit(value), changed, updated };
}

function migrateOneAttachment(
  attachment: Record<string, unknown>,
  dataDir: string,
  nowMs: () => number,
  errors: string[],
  sessionId: string,
  migratedAssets: Map<string, LocalRuntimeAssetRecord>,
): Record<string, unknown> {
  if (isAttachmentSessionScopedV2Asset(attachment, dataDir, sessionId)) return attachment;
  const filePath = readString(attachment.file_path) ?? readString(attachment.filePath);
  const dataUrl = readString(attachment.data_url) ?? readString(attachment.dataUrl);
  if (!filePath && !dataUrl?.startsWith('data:')) return attachment;
  if (filePath && !fs.existsSync(filePath) && !dataUrl?.startsWith('data:')) return attachment;
  const fileName =
    readString(attachment.file_name) ??
    readString(attachment.fileName) ??
    (filePath ? path.basename(filePath) : 'attachment');
  const mimeType =
    readString(attachment.mime_type) ??
    readString(attachment.mimeType) ??
    'application/octet-stream';
  const cacheKeys = getMigrationAttachmentCacheKeys({
    attachment,
    filePath,
    sessionId,
  });
  let asset = cacheKeys
    .map((key) => migratedAssets.get(key))
    .find((cached) => cached !== undefined);
  if (!asset) {
    try {
      asset = registerLocalAssetSync({
        dataDir,
        fileName,
        mimeType,
        sourcePath: filePath,
        dataUrl: dataUrl?.startsWith('data:') ? dataUrl : undefined,
        sourceKind: 'current-migration',
        sessionId,
        nowMs,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(`attachment:${fileName}:${reason}`);
      return attachment;
    }
    for (const key of cacheKeys) migratedAssets.set(key, asset);
  }
  return {
    ...attachment,
    file_path: asset.absolutePath,
    filePath: asset.absolutePath,
    file_name: asset.fileName,
    fileName: asset.fileName,
    mime_type: asset.mimeType,
    mimeType: asset.mimeType,
    asset_id: asset.assetId,
    assetId: asset.assetId,
    data_url: undefined,
    dataUrl: undefined,
  };
}

function getMigrationAttachmentCacheKeys(input: {
  attachment: Record<string, unknown>;
  filePath: string | undefined;
  sessionId: string;
}): string[] {
  const historicalAssetId =
    readString(input.attachment.asset_id) ?? readString(input.attachment.assetId);
  if (historicalAssetId) return [`${input.sessionId}\u0000asset:${historicalAssetId}`];
  const fileKey = readString(input.attachment.file_key) ?? readString(input.attachment.fileKey);
  if (fileKey) return [`${input.sessionId}\u0000file-key:${fileKey}`];
  if (!input.filePath) return [];
  try {
    return [`${input.sessionId}\u0000source-path:${fs.realpathSync(input.filePath)}`];
  } catch {
    return [];
  }
}

function isAttachmentSessionScopedV2Asset(
  attachment: Record<string, unknown>,
  dataDir: string,
  sessionId: string,
): boolean {
  const assetId = readString(attachment.asset_id) ?? readString(attachment.assetId);
  const filePath = readString(attachment.file_path) ?? readString(attachment.filePath);
  if (!assetId || !filePath) return false;
  try {
    const v2 = resolveV2DirectoryContract(dataDir);
    const assetPath = fs.realpathSync(filePath);
    const assetsRoot = fs.realpathSync(v2.assets);
    if (!isPathInside(assetsRoot, assetPath)) return false;
    const sidecarPath = `${filePath}.asset.json`;
    const sidecarInfo = fs.lstatSync(sidecarPath);
    if (!sidecarInfo.isFile() || sidecarInfo.isSymbolicLink()) return false;
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')) as Record<string, unknown>;
    const relativePath = readString(sidecar.relativePath);
    if (
      readString(sidecar.assetId) !== assetId ||
      readString(sidecar.sessionId) !== sessionId ||
      !relativePath
    ) {
      return false;
    }
    return fs.realpathSync(path.join(v2.root, relativePath)) === assetPath;
  } catch {
    return false;
  }
}

function copyOrReconcileSqliteSnapshot(
  source: string,
  target: string,
  label: string,
  manifest: V2MigrationManifest,
  managedRoot: string,
): void {
  if (!fs.existsSync(source)) {
    manifest.skipped.push(`${label}:source-missing`);
    return;
  }
  if (!fs.statSync(source).isFile()) {
    manifest.skipped.push(`${label}:source-not-file`);
    return;
  }
  ensureManagedDirectory(path.dirname(target), managedRoot);
  ensureManagedWriteTarget(target, managedRoot);
  if (fs.existsSync(target)) {
    const inserted = reconcileMissingSqliteRows(source, target, label, manifest);
    if (inserted > 0) manifest.copied.push(`${label}:reconciled:${inserted}`);
    else manifest.skipped.push(`${label}:target-current`);
    return;
  }
  const tempTarget = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const Database = loadBetterSqlite3Module<DatabaseConstructor>();
  const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
  try {
    sourceDb.prepare('VACUUM INTO ?').run(tempTarget);
  } catch (err) {
    fs.rmSync(tempTarget, { force: true });
    throw err;
  } finally {
    sourceDb.close();
  }
  const published = publishSqliteSnapshot(tempTarget, target);
  if (!published) manifest.skipped.push(`${label}:target-created-race`);
  else manifest.copied.push(label);
}

function reconcileMissingSqliteRows(
  source: string,
  target: string,
  label: string,
  manifest: V2MigrationManifest,
): number {
  const Database = loadBetterSqlite3Module<DatabaseConstructor>();
  const db = new Database(target);
  let inserted = 0;
  try {
    db.prepare('ATTACH DATABASE ? AS source_db').run(source);
    try {
      const targetTables = new Set(listUserTables(db, 'main'));
      for (const table of listUserTables(db, 'source_db')) {
        if (RESERVED_RECONCILE_TABLES.has(table)) {
          manifest.skipped.push(`${label}:${table}:reserved`);
          continue;
        }
        if (!targetTables.has(table)) {
          if (isKnownLocalRuntimeTable(table)) {
            throw new Error(`${label}:${table}:target-table-missing`);
          } else {
            manifest.skipped.push(`${label}:${table}:target-table-missing`);
          }
          continue;
        }
        const commonColumns = intersectColumns(
          tableColumns(db, 'source_db', table),
          tableColumns(db, 'main', table),
        );
        if (commonColumns.length === 0) {
          manifest.skipped.push(`${label}:${table}:no-common-columns`);
          continue;
        }
        try {
          const quotedColumns = commonColumns.map(quoteIdentifier).join(', ');
          db.prepare(
            `INSERT OR IGNORE INTO ${quoteIdentifier(table)} (${quotedColumns}) ` +
              `SELECT ${quotedColumns} FROM source_db.${quoteIdentifier(table)}`,
          ).run();
          inserted += readSqliteChanges(db);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          manifest.errors.push(`${label}:${table}:reconcile_failed:${reason}`);
        }
      }
    } finally {
      db.prepare('DETACH DATABASE source_db').run();
    }
  } finally {
    db.close();
  }
  return inserted;
}

function ensureCurrentRuntimeSqliteSchemaIfPresent(dataDir: string): void {
  if (!fs.existsSync(resolveV2DirectoryContract(dataDir).db)) return;
  const db = openLocalRuntimeDb(dataDir);
  assertCurrentRuntimeSqliteSchemaComplete(db);
}

function assertCurrentRuntimeSqliteSchemaComplete(db: DatabaseLike): void {
  const missing = REQUIRED_LOCAL_RUNTIME_TABLES.filter((table) => !tableExists(db, table));
  if (missing.length === 0) return;
  throw new Error(`current_local_runtime_schema_incomplete:${missing.join(',')}`);
}

function isKnownLocalRuntimeTable(table: string): boolean {
  return REQUIRED_LOCAL_RUNTIME_TABLES.includes(table);
}

function publishSqliteSnapshot(tempTarget: string, target: string): boolean {
  const lockPath = `${target}.promote.lock`;
  const lockFd = acquireSqliteSnapshotPublishLock(lockPath, target);
  if (lockFd === undefined) {
    fs.rmSync(tempTarget, { force: true });
    return false;
  }
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(tempTarget, { force: true });
      return false;
    }
    ensureManagedWriteTarget(target, path.dirname(path.dirname(target)));
    fs.renameSync(tempTarget, target);
    return true;
  } finally {
    fs.closeSync(lockFd);
    fs.rmSync(lockPath, { force: true });
  }
}

function acquireSqliteSnapshotPublishLock(lockPath: string, target: string): number | undefined {
  const startedAt = Date.now();
  while (true) {
    if (fs.existsSync(target)) return undefined;
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${process.pid}\n${startedAt}\n`);
      return fd;
    } catch (err) {
      if (!isAlreadyExistsError(err)) throw err;
      removeStaleSqliteSnapshotPublishLock(lockPath);
      if (Date.now() - startedAt > 10_000) {
        throw new Error(`sqlite_snapshot_publish_lock_timeout:${lockPath}`);
      }
      sleepSync(50);
    }
  }
}

function removeStaleSqliteSnapshotPublishLock(lockPath: string): void {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > 10 * 60_000) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // Lock disappeared between open attempts.
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlreadyExistsError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST');
}

function copyDirIfMissing(
  source: string,
  target: string,
  label: string,
  manifest: V2MigrationManifest,
  managedRoot: string,
): void {
  if (!fs.existsSync(source)) {
    manifest.skipped.push(`${label}:source-missing`);
    return;
  }
  const sourceInfo = fs.statSync(source);
  if (!sourceInfo.isDirectory()) {
    manifest.skipped.push(`${label}:source-not-directory`);
    return;
  }
  if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
    throw new Error(`${label}:target-not-directory`);
  }
  ensureManagedDirectory(target, managedRoot);
  const copied = copyMissingDirEntries(source, target, managedRoot);
  if (copied > 0) {
    manifest.copied.push(`${label}:${copied}`);
  } else {
    manifest.skipped.push(`${label}:target-current`);
  }
}

function copyMissingDirEntries(source: string, target: string, managedRoot: string): number {
  let copied = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      ensureManagedDirectory(targetPath, managedRoot);
      copied += copyMissingDirEntries(sourcePath, targetPath, managedRoot);
    } else if (entry.isFile()) {
      ensureManagedDirectory(path.dirname(targetPath), managedRoot);
      ensureManagedWriteTarget(targetPath, managedRoot);
      if (fs.existsSync(targetPath)) continue;
      fs.copyFileSync(sourcePath, targetPath);
      copied += 1;
    }
  }
  return copied;
}

function writeMigrationManifest(
  dataDir: string,
  epochMs: number,
  manifest: V2MigrationManifest,
): void {
  const dir = resolveV2MigrationManifestDir(dataDir, epochMs);
  ensureManagedDirectory(dir, resolveV2DirectoryContract(dataDir).root);
  const manifestPath = path.join(dir, `${manifest.migrationId}.json`);
  ensureManagedWriteTarget(manifestPath, resolveV2DirectoryContract(dataDir).root);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

function listUserTables(db: DatabaseLike, schema: 'main' | 'source_db'): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`,
      )
      .all() as Array<{ name?: string }>
  )
    .map((row) => row.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

function tableColumns(db: DatabaseLike, schema: 'main' | 'source_db', table: string): string[] {
  return (
    db.prepare(`PRAGMA ${schema}.table_info(${quoteIdentifier(table)})`).all() as Array<{
      name?: string;
    }>
  )
    .map((row) => row.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

function intersectColumns(sourceColumns: string[], targetColumns: string[]): string[] {
  const target = new Set(targetColumns);
  return sourceColumns.filter((column) => target.has(column));
}

function readSqliteChanges(db: DatabaseLike): number {
  const row = db.prepare('SELECT changes() AS changes').get() as { changes?: number } | undefined;
  return typeof row?.changes === 'number' ? row.changes : 0;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function ensureManagedDirectory(dirPath: string, managedRoot: string): void {
  const resolvedRoot = path.resolve(managedRoot);
  const resolvedDir = path.resolve(dirPath);
  if (!isPathInside(resolvedRoot, resolvedDir)) {
    throw new Error(`Unsafe v2 migration directory outside managed root: ${dirPath}`);
  }
  fs.mkdirSync(resolvedRoot, { recursive: true });
  ensureExistingPathNotSymlink(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of path.relative(resolvedRoot, resolvedDir).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    ensureExistingPathNotSymlink(current);
  }
  fs.mkdirSync(resolvedDir, { recursive: true });
}

function ensureManagedWriteTarget(filePath: string, managedRoot: string): void {
  const resolvedRoot = path.resolve(managedRoot);
  const resolvedFile = path.resolve(filePath);
  if (!isPathInside(resolvedRoot, resolvedFile)) {
    throw new Error(`Unsafe v2 migration file outside managed root: ${filePath}`);
  }
  ensureManagedDirectory(path.dirname(resolvedFile), resolvedRoot);
  try {
    const stat = fs.lstatSync(resolvedFile);
    if (stat.isSymbolicLink()) throw new Error(`Unsafe v2 migration symlink target: ${filePath}`);
    if (stat.isDirectory()) throw new Error(`Unsafe v2 migration directory target: ${filePath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

function ensureExistingPathNotSymlink(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`Unsafe v2 migration symlink path: ${filePath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

function tableExists(db: DatabaseLike, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return row?.name === table;
}

function isAttachmentRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.file_path === 'string' ||
    typeof record.filePath === 'string' ||
    typeof record.data_url === 'string' ||
    typeof record.dataUrl === 'string'
  );
}

function parseJsonRecord(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveDataDir(dataDir: DataDirInput): string {
  return typeof dataDir === 'function' ? dataDir() : dataDir;
}
