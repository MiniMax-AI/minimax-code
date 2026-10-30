import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  DiagnosticArtifact,
  DiagnosticArtifactCollectInput,
  DiagnosticArtifactSource,
  DiagnosticSourceDescription,
} from '../observability/diagnostic-bundle.js';
import type { LocalMessageInput } from '../messages/input.js';
import {
  formatV2TimestampParts,
  isPathInside,
  resolveV2AssetDir,
  resolveV2DirectoryContract,
  sanitizeV2PathSegment,
  type DataDirInput,
} from '../persistence/layout/v2-paths.js';
import { readRemoteAssetSource, type RemoteAssetTransport } from './remote-source.js';

/** Strips trailing `char` repeats in linear time (no backtracking regex). */
function trimTrailingChar(value: string, char: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === char) end -= 1;
  return value.slice(0, end);
}


const DEFAULT_MAX_LOCAL_ASSET_BYTES = 100 * 1024 * 1024;

export type LocalAssetKind =
  | 'file'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'archive'
  | 'binary';
export type LocalAssetSourceKind =
  | 'user-upload'
  | 'user-paste'
  | 'generated'
  | 'legacy-migration'
  | 'current-migration'
  | 'unknown';

export interface LocalRuntimeAssetRecord {
  schemaVersion: 1;
  assetId: string;
  kind: LocalAssetKind;
  sourceKind: LocalAssetSourceKind;
  fileName: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  absolutePath: string;
  relativePath: string;
  createdAtMs: number;
  privacy: 'raw-user-asset';
  diagnosticUploadDefault: 'never';
  sessionId?: string;
  turnId?: string;
  sourcePath?: string;
  generatedBy?: string;
}

export class LocalAssetManifestDiagnosticSource implements DiagnosticArtifactSource {
  readonly id = 'asset-manifest';
  private readonly dataDir: DataDirInput;

  constructor(dataDir: DataDirInput) {
    this.dataDir = dataDir;
  }

  describe(): DiagnosticSourceDescription {
    return {
      label: 'Local asset manifest',
      privacy: 'masked',
      uploadDefault: 'consent-required',
    };
  }

  async collect(input: DiagnosticArtifactCollectInput): Promise<DiagnosticArtifact[]> {
    const records = listAssetSidecars(resolveV2DirectoryContract(this.dataDir).assets)
      .flatMap((filePath) => readAssetSidecar(filePath))
      .filter((record) => record.createdAtMs >= input.sinceMs)
      .map((record) => ({
        assetId: record.assetId,
        kind: record.kind,
        sourceKind: record.sourceKind,
        fileName: record.fileName,
        mimeType: record.mimeType,
        bytes: record.bytes,
        sha256: record.sha256,
        relativePath: record.relativePath,
        createdAtMs: record.createdAtMs,
        diagnosticUploadDefault: record.diagnosticUploadDefault,
        rawIncluded: false,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        ...(record.turnId ? { turnId: record.turnId } : {}),
      }));
    if (records.length === 0) return [];
    const content = Buffer.from(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedAtMs: input.nowMs,
          rawAssetsIncluded: false,
          assets: records,
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    return [
      {
        name: 'mavis-assets/asset-manifest.json',
        content,
        bytes: content.byteLength,
        source: this.id,
        privacy: 'masked',
        uploadDefault: 'consent-required',
      },
    ];
  }
}

export interface RegisterLocalAssetInput {
  dataDir: DataDirInput;
  fileName: string;
  mimeType?: string;
  kind?: LocalAssetKind;
  sourceKind?: LocalAssetSourceKind;
  sourcePath?: string;
  sourceUrl?: string;
  dataUrl?: string;
  remoteAssetTransport?: RemoteAssetTransport;
  sessionId?: string;
  turnId?: string;
  generatedBy?: string;
  nowMs?: () => number;
  maxBytes?: number;
}

export interface LocalAssetAttachmentLike {
  type?: unknown;
  filePath?: unknown;
  file_path?: unknown;
  desktopPath?: unknown;
  desktop_path?: unknown;
  fileName?: unknown;
  file_name?: unknown;
  mimeType?: unknown;
  mime_type?: unknown;
  dataUrl?: unknown;
  data_url?: unknown;
  previewUrl?: unknown;
  preview_url?: unknown;
  assetId?: unknown;
  asset_id?: unknown;
}

export interface RegisteredMessageAttachment {
  type: 'file' | 'image';
  filePath: string;
  fileName: string;
  mimeType: string;
  desktopPath?: string;
  dataUrl?: string;
  assetId?: string;
}

export interface LocalAssetRegistrationReceipt {
  readonly assetId: string;
  readonly filePath: string;
}

export interface ResolveSessionLocalAssetInput {
  readonly dataDir: DataDirInput;
  readonly sessionId: string;
  readonly assetId: string;
}

export interface ResolveSessionLocalAssetSourceInput {
  readonly dataDir: DataDirInput;
  readonly sessionId: string;
  readonly filePath: string;
}

export interface ResolvedSessionLocalAssetSource {
  readonly filePath: string;
  readonly fileName: string;
  readonly assetPath: string;
}

export interface RegisterSessionLocalAssetInput {
  readonly dataDir: DataDirInput;
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly kind?: LocalAssetKind;
  readonly generatedBy?: string;
  readonly nowMs?: () => number;
  readonly maxBytes?: number;
}

/** Resolve one immutable v2 asset only when its sidecar owns the exact Session. */
export async function resolveSessionLocalAsset(
  input: ResolveSessionLocalAssetInput,
): Promise<LocalRuntimeAssetRecord | undefined> {
  const assetId = input.assetId.trim();
  const sessionId = input.sessionId.trim();
  if (!assetId || !sessionId) return undefined;
  return listRegisteredV2Assets(input.dataDir).find(
    (record) => record.assetId === assetId && record.sessionId === sessionId,
  );
}

/** Resolves either an immutable asset path or its original local source path within one Session. */
export function resolveSessionLocalAssetSource(
  input: ResolveSessionLocalAssetSourceInput,
): ResolvedSessionLocalAssetSource | undefined {
  const sessionId = input.sessionId.trim();
  const candidate = canonicalExistingPath(input.filePath);
  if (!sessionId || !candidate) return undefined;
  const record = listRegisteredV2Assets(input.dataDir).find((asset) => {
    if (asset.sessionId !== sessionId) return false;
    if (canonicalExistingPath(asset.absolutePath) === candidate) return true;
    return asset.sourcePath ? canonicalExistingPath(asset.sourcePath) === candidate : false;
  });
  if (!record) return undefined;
  return {
    filePath:
      (record.sourcePath && canonicalExistingPath(record.sourcePath)) || record.absolutePath,
    fileName: record.fileName,
    assetPath: record.absolutePath,
  };
}

/**
 * Adopt a Session-owned file into the shared v2 asset store. Assets with the
 * same immutable bytes are reused inside one Session; an overwritten source
 * path receives a new assetId because its sha256 changes.
 */
export async function registerSessionLocalAsset(
  input: RegisterSessionLocalAssetInput,
): Promise<LocalRuntimeAssetRecord> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error('asset_session_required');
  const canonicalSource = await realpath(expandHomePath(input.sourcePath));
  const sourceInfo = await stat(canonicalSource);
  if (!sourceInfo.isFile()) throw new Error('asset_source_not_file');
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_LOCAL_ASSET_BYTES;
  if (sourceInfo.size > maxBytes) throw new Error('asset_too_large');
  const sourceBytes = await readFile(canonicalSource);
  const sha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const reusable = listRegisteredV2Assets(input.dataDir).find(
    (record) =>
      record.sessionId === sessionId &&
      record.sha256 === sha256 &&
      record.bytes === sourceBytes.byteLength &&
      isSameAssetSource(record, canonicalSource),
  );
  if (reusable) return reusable;

  return materializeLocalAsset(
    {
      dataDir: input.dataDir,
      fileName: input.fileName?.trim() || path.basename(canonicalSource),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      sourceKind: 'generated',
      sourcePath: canonicalSource,
      sessionId,
      ...(input.generatedBy ? { generatedBy: input.generatedBy } : {}),
      ...(input.nowMs ? { nowMs: input.nowMs } : {}),
      maxBytes,
    },
    {
      buffer: sourceBytes,
      mimeType: input.mimeType || mimeFromPath(canonicalSource),
    },
  );
}

export async function registerLocalAsset(
  input: RegisterLocalAssetInput,
): Promise<LocalRuntimeAssetRecord> {
  const source = await readAssetSource(input);
  return materializeLocalAsset(input, source);
}

async function materializeLocalAsset(
  input: RegisterLocalAssetInput,
  source: { readonly buffer: Buffer; readonly mimeType: string },
): Promise<LocalRuntimeAssetRecord> {
  const now = input.nowMs?.() ?? Date.now();
  const sha256 = createHash('sha256').update(source.buffer).digest('hex');
  const stamp = formatV2TimestampParts(now);
  const fileName = sanitizeV2PathSegment(input.fileName, 'attachment');
  const assetId = `asset_${stamp.compact}_${sha256.slice(0, 12)}_${randomUUID().slice(0, 8)}`;
  const dir = resolveV2AssetDir(input.dataDir, now);
  await mkdir(dir, { recursive: true });
  const targetName = `${stamp.time}-${assetId}-${fileName}`;
  const targetPath = path.join(dir, targetName);
  const tempPath = path.join(dir, `.${targetName}.${randomUUID().slice(0, 8)}.tmp`);
  const root = resolveV2DirectoryContract(input.dataDir).root;
  const record: LocalRuntimeAssetRecord = {
    schemaVersion: 1,
    assetId,
    kind: input.kind ?? inferAssetKind(input.mimeType ?? source.mimeType, fileName),
    sourceKind: input.sourceKind ?? 'unknown',
    fileName,
    mimeType: input.mimeType || source.mimeType || 'application/octet-stream',
    bytes: source.buffer.byteLength,
    sha256,
    absolutePath: targetPath,
    relativePath: path.relative(root, targetPath).replaceAll(path.sep, '/'),
    createdAtMs: now,
    privacy: 'raw-user-asset',
    diagnosticUploadDefault: 'never',
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    ...(input.generatedBy ? { generatedBy: input.generatedBy } : {}),
  };
  try {
    await writeFile(tempPath, source.buffer);
    await writeFile(`${targetPath}.asset.json`, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    await rename(tempPath, targetPath);
    await writeFile(path.join(dir, 'assets.jsonl'), `${JSON.stringify(record)}\n`, {
      encoding: 'utf-8',
      flag: 'a',
    });
  } catch (err) {
    await Promise.all([
      rm(tempPath, { force: true }).catch(() => undefined),
      rm(targetPath, { force: true }).catch(() => undefined),
      rm(`${targetPath}.asset.json`, { force: true }).catch(() => undefined),
    ]);
    throw err;
  }
  return record;
}

export function registerLocalAssetSync(input: RegisterLocalAssetInput): LocalRuntimeAssetRecord {
  const now = input.nowMs?.() ?? Date.now();
  const source = readAssetSourceSync(input);
  const sha256 = createHash('sha256').update(source.buffer).digest('hex');
  const stamp = formatV2TimestampParts(now);
  const fileName = sanitizeV2PathSegment(input.fileName, 'attachment');
  const assetId = `asset_${stamp.compact}_${sha256.slice(0, 12)}_${randomUUID().slice(0, 8)}`;
  const dir = resolveV2AssetDir(input.dataDir, now);
  mkdirSync(dir, { recursive: true });
  const targetName = `${stamp.time}-${assetId}-${fileName}`;
  const targetPath = path.join(dir, targetName);
  const tempPath = path.join(dir, `.${targetName}.${randomUUID().slice(0, 8)}.tmp`);
  const root = resolveV2DirectoryContract(input.dataDir).root;
  const record: LocalRuntimeAssetRecord = {
    schemaVersion: 1,
    assetId,
    kind: input.kind ?? inferAssetKind(input.mimeType ?? source.mimeType, fileName),
    sourceKind: input.sourceKind ?? 'unknown',
    fileName,
    mimeType: input.mimeType || source.mimeType || 'application/octet-stream',
    bytes: source.buffer.byteLength,
    sha256,
    absolutePath: targetPath,
    relativePath: path.relative(root, targetPath).replaceAll(path.sep, '/'),
    createdAtMs: now,
    privacy: 'raw-user-asset',
    diagnosticUploadDefault: 'never',
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    ...(input.generatedBy ? { generatedBy: input.generatedBy } : {}),
  };
  try {
    writeFileSync(tempPath, source.buffer);
    writeFileSync(`${targetPath}.asset.json`, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, targetPath);
    writeFileSync(path.join(dir, 'assets.jsonl'), `${JSON.stringify(record)}\n`, {
      encoding: 'utf-8',
      flag: 'a',
    });
  } catch (err) {
    safeRmSync(tempPath);
    safeRmSync(targetPath);
    safeRmSync(`${targetPath}.asset.json`);
    throw err;
  }
  return record;
}

export async function registerMessageAttachments(input: {
  dataDir: DataDirInput;
  attachments: RegisteredMessageAttachment[];
  sessionId?: string;
  turnId?: string;
  nowMs?: () => number;
  remoteAssetTransport?: RemoteAssetTransport;
}): Promise<RegisteredMessageAttachment[]> {
  const output: RegisteredMessageAttachment[] = [];
  const created: LocalAssetRegistrationReceipt[] = [];
  try {
    for (const attachment of input.attachments) {
      if (
        attachment.assetId &&
        isRegisteredV2AssetPath(input.dataDir, attachment.filePath, attachment.assetId)
      ) {
        output.push(attachment);
        continue;
      }
      const sourcePath = attachment.filePath || undefined;
      const inlineDataUrl = attachment.dataUrl?.startsWith('data:')
        ? attachment.dataUrl
        : undefined;
      const sourceDataUrl = attachment.dataUrl && !inlineDataUrl ? attachment.dataUrl : undefined;
      const remoteSourceUrl = !sourcePath && !inlineDataUrl ? sourceDataUrl : undefined;
      const desktopPath = attachment.desktopPath ?? (!inlineDataUrl ? sourcePath : undefined);
      if (!sourcePath && !inlineDataUrl && !remoteSourceUrl) {
        output.push(attachment);
        continue;
      }
      const record = await registerLocalAsset({
        dataDir: input.dataDir,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        kind: attachment.type === 'image' ? 'image' : undefined,
        sourceKind: inlineDataUrl ? 'user-paste' : 'user-upload',
        sourcePath,
        ...(remoteSourceUrl ? { sourceUrl: remoteSourceUrl } : {}),
        dataUrl: inlineDataUrl,
        ...(input.remoteAssetTransport ? { remoteAssetTransport: input.remoteAssetTransport } : {}),
        sessionId: input.sessionId,
        turnId: input.turnId,
        nowMs: input.nowMs,
      });
      created.push({ assetId: record.assetId, filePath: record.absolutePath });
      output.push({
        type: attachment.type,
        filePath: record.absolutePath,
        fileName: record.fileName,
        mimeType: record.mimeType,
        ...(desktopPath ? { desktopPath } : {}),
        assetId: record.assetId,
        ...(sourceDataUrl ? { dataUrl: sourceDataUrl } : {}),
      });
    }
  } catch (error) {
    await discardLocalAssetRegistrations({
      dataDir: input.dataDir,
      sessionId: input.sessionId,
      receipts: created,
    });
    throw error;
  }
  return output;
}

/** Removes only request-scoped assets that never reached durable admission. */
export async function discardLocalAssetRegistrations(input: {
  readonly dataDir: DataDirInput;
  readonly sessionId?: string;
  readonly receipts: readonly LocalAssetRegistrationReceipt[];
}): Promise<void> {
  await Promise.all(
    input.receipts.map(async ({ assetId, filePath }) => {
      try {
        if (!isRegisteredV2AssetPath(input.dataDir, filePath, assetId)) return;
        const [record] = readAssetSidecar(`${filePath}.asset.json`);
        if (!record || record.sessionId !== input.sessionId) return;
        await Promise.all([
          rm(filePath, { force: true }),
          rm(`${filePath}.asset.json`, { force: true }),
        ]);
      } catch {
        // Cleanup is best effort and must not replace the original admission failure.
      }
    }),
  );
}

export async function registerLocalMessageInputAttachments(input: {
  dataDir: DataDirInput;
  sessionId: string;
  turnId: string;
  messages: LocalMessageInput[];
  nowMs?: () => number;
}): Promise<LocalMessageInput[]> {
  return Promise.all(
    input.messages.map(async (message) => ({
      ...message,
      attachments: await registerMessageAttachments({
        dataDir: input.dataDir,
        attachments: message.attachments,
        sessionId: input.sessionId,
        turnId: input.turnId,
        nowMs: input.nowMs,
      }),
    })),
  );
}

export function inferAssetKind(mimeType: string | undefined, fileName: string): LocalAssetKind {
  const mime = (mimeType ?? '').toLowerCase();
  const ext = path.extname(fileName).toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'document';
  if (
    [
      '.pdf',
      '.doc',
      '.docx',
      '.ppt',
      '.pptx',
      '.xls',
      '.xlsx',
      '.csv',
      '.numbers',
      '.pages',
      '.key',
    ].includes(ext)
  ) {
    return 'document';
  }
  if (['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z'].includes(ext)) return 'archive';
  if (mime.startsWith('text/')) return 'file';
  if (mime) return 'binary';
  return 'file';
}

function isV2AssetPath(dataDir: DataDirInput, filePath: string): boolean {
  if (!filePath) return false;
  try {
    const assetsRoot = realpathSync(resolveV2DirectoryContract(dataDir).assets);
    const assetPath = realpathSync(filePath);
    return isPathInside(assetsRoot, assetPath);
  } catch {
    return false;
  }
}

function isRegisteredV2AssetPath(
  dataDir: DataDirInput,
  filePath: string,
  assetId: string,
): boolean {
  if (!isV2AssetPath(dataDir, filePath)) return false;
  const sidecarPath = `${filePath}.asset.json`;
  try {
    const sidecarInfo = lstatSync(sidecarPath);
    if (sidecarInfo.isSymbolicLink() || !sidecarInfo.isFile()) return false;
    const [record] = readAssetSidecar(sidecarPath);
    if (!record || record.assetId !== assetId) return false;
    const root = resolveV2DirectoryContract(dataDir).root;
    const recordedPath = path.join(root, record.relativePath);
    const fileInfo = statSync(filePath);
    return (
      fileInfo.isFile() &&
      fileInfo.size === record.bytes &&
      realpathSync(recordedPath) === realpathSync(filePath)
    );
  } catch {
    return false;
  }
}

function listRegisteredV2Assets(dataDir: DataDirInput): LocalRuntimeAssetRecord[] {
  const contract = resolveV2DirectoryContract(dataDir);
  return listAssetSidecars(contract.assets).flatMap((sidecarPath) => {
    const [record] = readAssetSidecar(sidecarPath);
    if (!record) return [];
    const filePath = path.join(contract.root, record.relativePath);
    if (!isRegisteredV2AssetPath(dataDir, filePath, record.assetId)) return [];
    try {
      return [{ ...record, absolutePath: realpathSync(filePath) }];
    } catch {
      return [];
    }
  });
}

/** Lists the asset files registered by the given Sessions, for read grants. */
export interface SessionAssetPathIndex {
  /**
   * Lexical paths (`<dataDir>/v2/assets/...`) of valid assets whose sidecar
   * names one of `sessionIds`. Never realpaths: the permission layer
   * canonicalizes each grant itself and rejects one reached through a symlink.
   */
  listSessionAssetPaths(sessionIds: readonly string[]): Promise<readonly string[]>;
}

interface AssetDirectoryEntry {
  readonly sessionId: string;
  readonly filePath: string;
}

interface AssetDirectorySnapshot {
  readonly mtimeMs: number;
  readonly entries: readonly AssetDirectoryEntry[];
}

const SESSION_ASSET_INDEX_REFRESH_MS = 1_000;

/**
 * Per-Session view of the shared v2 asset store, cheap enough for every
 * permission check. The store is one dated tree shared by all Sessions, and
 * each asset's sidecar names the Session that registered it.
 *
 * All file-system work is asynchronous, so even the cold first scan of a large
 * store never blocks the runtime's event loop; concurrent callers share one
 * in-flight scan. A directory is re-read only when its mtime changes (adding
 * or removing an asset changes it), and the tree is re-walked at most once per
 * refresh interval.
 */
export function createSessionAssetPathIndex(
  dataDir: DataDirInput,
  options: { readonly nowMs?: () => number; readonly refreshIntervalMs?: number } = {},
): SessionAssetPathIndex {
  const nowMs = options.nowMs ?? Date.now;
  const refreshIntervalMs = options.refreshIntervalMs ?? SESSION_ASSET_INDEX_REFRESH_MS;
  let directories = new Map<string, AssetDirectorySnapshot>();
  let refreshedAtMs: number | undefined;
  let inFlight: Promise<void> | undefined;

  const scan = async (): Promise<void> => {
    const contract = resolveV2DirectoryContract(dataDir);
    const assetsRoot = await realpath(contract.assets).catch(() => undefined);
    const next = new Map<string, AssetDirectorySnapshot>();
    if (assetsRoot) {
      for (const { directory, mtimeMs } of await listAssetDirectories(contract.assets)) {
        const previous = directories.get(directory);
        next.set(
          directory,
          previous?.mtimeMs === mtimeMs
            ? previous
            : {
                mtimeMs,
                entries: await readAssetDirectoryEntries(contract.root, assetsRoot, directory),
              },
        );
      }
    }
    directories = next;
  };

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    const now = nowMs();
    if (refreshedAtMs !== undefined && now - refreshedAtMs < refreshIntervalMs) {
      return Promise.resolve();
    }
    refreshedAtMs = now;
    inFlight = scan().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    async listSessionAssetPaths(sessionIds) {
      const wanted = new Set(sessionIds.map((id) => id.trim()).filter(Boolean));
      if (wanted.size === 0) return [];
      await refresh();
      const paths: string[] = [];
      for (const { entries } of directories.values()) {
        for (const entry of entries) {
          if (wanted.has(entry.sessionId)) paths.push(entry.filePath);
        }
      }
      return paths;
    },
  };
}

/** Real (non-symlink) directories under the asset root, with their mtimes. */
async function listAssetDirectories(
  root: string,
): Promise<{ directory: string; mtimeMs: number }[]> {
  const found: { directory: string; mtimeMs: number }[] = [];
  const visit = async (directory: string): Promise<void> => {
    const info = await lstat(directory).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
    found.push({ directory, mtimeMs: info.mtimeMs });
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names) {
      // Asset files and sidecars carry an extension; dated directories do not.
      if (!name.includes('.')) await visit(path.join(directory, name));
    }
  };
  await visit(root);
  return found;
}

/**
 * Valid Session-owned assets in one directory. Each sidecar is read once; the
 * asset must sit next to it, be a regular file of the recorded size, and
 * resolve inside the canonical asset root.
 */
async function readAssetDirectoryEntries(
  v2Root: string,
  assetsRoot: string,
  directory: string,
): Promise<AssetDirectoryEntry[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const entries: AssetDirectoryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.asset.json')) continue;
    const entry = await readAssetDirectoryEntry(v2Root, assetsRoot, path.join(directory, name));
    if (entry) entries.push(entry);
  }
  return entries;
}

async function readAssetDirectoryEntry(
  v2Root: string,
  assetsRoot: string,
  sidecarPath: string,
): Promise<AssetDirectoryEntry | undefined> {
  try {
    const sidecarInfo = await lstat(sidecarPath);
    if (sidecarInfo.isSymbolicLink() || !sidecarInfo.isFile()) return undefined;
    const parsed = JSON.parse(await readFile(sidecarPath, 'utf-8')) as unknown;
    if (!isLocalRuntimeAssetRecord(parsed) || !parsed.sessionId) return undefined;
    const filePath = path.join(v2Root, parsed.relativePath);
    if (`${filePath}.asset.json` !== sidecarPath) return undefined;
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile() || fileInfo.size !== parsed.bytes) return undefined;
    if (!isPathInside(assetsRoot, await realpath(filePath))) return undefined;
    return { sessionId: parsed.sessionId, filePath };
  } catch {
    return undefined;
  }
}

function isSameAssetSource(record: LocalRuntimeAssetRecord, canonicalSource: string): boolean {
  if (record.absolutePath === canonicalSource) return true;
  if (!record.sourcePath) return false;
  try {
    return realpathSync(record.sourcePath) === canonicalSource;
  } catch {
    return false;
  }
}

function expandHomePath(sourcePath: string): string {
  return sourcePath.startsWith('~/') ? path.resolve(homedir(), sourcePath.slice(2)) : sourcePath;
}

function canonicalExistingPath(sourcePath: string): string | undefined {
  try {
    return realpathSync(expandHomePath(sourcePath));
  } catch {
    return undefined;
  }
}

async function readAssetSource(input: RegisterLocalAssetInput): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_LOCAL_ASSET_BYTES;
  if (input.dataUrl) {
    const decoded = decodeDataUrl(input.dataUrl, maxBytes);
    if (decoded === 'too_large') throw new Error('asset_too_large');
    if (!decoded) throw new Error('invalid_asset_data_url');
    return decoded;
  }
  if (input.sourceUrl) {
    return readRemoteAssetSource({
      url: input.sourceUrl,
      maxBytes,
      ...(input.remoteAssetTransport ? { transport: input.remoteAssetTransport } : {}),
    });
  }
  if (!input.sourcePath) throw new Error('asset_source_required');
  const info = await stat(input.sourcePath);
  if (!info.isFile()) throw new Error('asset_source_not_file');
  if (info.size > maxBytes) throw new Error('asset_too_large');
  return {
    buffer: await readFile(input.sourcePath),
    mimeType: input.mimeType ?? mimeFromPath(input.sourcePath),
  };
}

function readAssetSourceSync(input: RegisterLocalAssetInput): {
  buffer: Buffer;
  mimeType: string;
} {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_LOCAL_ASSET_BYTES;
  if (input.dataUrl) {
    const decoded = decodeDataUrl(input.dataUrl, maxBytes);
    if (decoded === 'too_large') throw new Error('asset_too_large');
    if (!decoded) throw new Error('invalid_asset_data_url');
    return decoded;
  }
  if (input.sourceUrl) throw new Error('asset_remote_source_requires_async_registration');
  if (!input.sourcePath) throw new Error('asset_source_required');
  const info = statSync(input.sourcePath);
  if (!info.isFile()) throw new Error('asset_source_not_file');
  if (info.size > maxBytes) throw new Error('asset_too_large');
  return {
    buffer: readFileSync(input.sourcePath),
    mimeType: input.mimeType ?? mimeFromPath(input.sourcePath),
  };
}

function decodeDataUrl(
  dataUrl: string,
  maxBytes: number,
): { mimeType: string; buffer: Buffer } | 'too_large' | null {
  if (!dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const meta = dataUrl.slice('data:'.length, comma);
  const body = dataUrl.slice(comma + 1);
  const [rawMime = '', ...rawParams] = meta.split(';');
  const mimeType = (rawMime || 'application/octet-stream').toLowerCase();
  const isBase64 = rawParams.some((param) => param.toLowerCase() === 'base64');
  const estimatedBytes = isBase64 ? Math.floor(trimTrailingChar(body, '=').length * 0.75) : body.length;
  if (estimatedBytes > maxBytes) return 'too_large';
  try {
    const buffer = isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body));
    if (buffer.byteLength > maxBytes) return 'too_large';
    return {
      mimeType,
      buffer,
    };
  } catch {
    return null;
  }
}

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.json') return 'application/json';
  if (ext === '.md' || ext === '.markdown') return 'text/markdown';
  if (ext === '.txt') return 'text/plain';
  return 'application/octet-stream';
}

function safeRmSync(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {
    // Best effort cleanup after a failed asset materialization.
  }
}

function listAssetSidecars(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const filePath = path.join(dir, name);
      let info;
      try {
        info = lstatSync(filePath);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (info.isFile() && name.endsWith('.asset.json')) files.push(filePath);
    }
  };
  visit(root);
  return files;
}

function readAssetSidecar(filePath: string): LocalRuntimeAssetRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return isLocalRuntimeAssetRecord(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
}

function isLocalRuntimeAssetRecord(value: unknown): value is LocalRuntimeAssetRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<LocalRuntimeAssetRecord>;
  return (
    record.schemaVersion === 1 &&
    typeof record.assetId === 'string' &&
    typeof record.fileName === 'string' &&
    typeof record.mimeType === 'string' &&
    typeof record.bytes === 'number' &&
    typeof record.sha256 === 'string' &&
    typeof record.relativePath === 'string' &&
    typeof record.createdAtMs === 'number'
  );
}
