import { validPluginMentions } from '../../widgets/editor/plugin-mentions.js';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { TuiAttachment, TuiTransportAttachment } from '../../../types/invocation.js';
import type { EditorDraftSnapshot } from '../../widgets/editor/editor.js';
import type { TuiRetrySubmission, TuiSubmissionSnapshot } from './submission.js';

const DRAFT_SCHEMA_VERSION = 2;
const MAX_DRAFT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RECOVERED_ATTACHMENTS = 64;
const MAX_RECOVERED_RETRIES = 32;
const DEFAULT_DEBOUNCE_MS = 250;

export class TuiDraftRecoveryError extends Error {
  constructor(
    readonly operation: 'save' | 'cleanup' | 'migrate' | 'load',
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'TuiDraftRecoveryError';
  }
}

export interface TuiRecoverableDraft {
  readonly editor: EditorDraftSnapshot;
  readonly attachments: TuiAttachment[];
  readonly retrySubmissions?: TuiRetrySubmission[];
}

interface StoredDraft extends TuiRecoverableDraft {
  readonly schemaVersion: 1 | 2;
  readonly updatedAtMs: number;
}

export class TuiDraftRecovery {
  private readonly dataDir: string;
  private readonly workspaceDir: string;
  private sessionKey?: string;
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest: TuiRecoverableDraft | undefined;
  private writeChain = Promise.resolve();
  private writeGeneration = 0;
  private disposed = false;
  private suspended = false;
  private readonly onError?: (error: unknown) => void;
  private readonly onPersisted?: () => void;

  constructor(options: {
    readonly dataDir: string;
    readonly workspaceDir: string;
    readonly sessionKey?: string;
    readonly debounceMs?: number;
    readonly onError?: (error: unknown) => void;
    readonly onPersisted?: () => void;
  }) {
    this.dataDir = options.dataDir;
    this.workspaceDir = options.workspaceDir;
    this.sessionKey = options.sessionKey;
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.onError = options.onError;
    this.onPersisted = options.onPersisted;
  }

  private get filePath(): string {
    return resolveTuiDraftRecoveryPath(this.dataDir, this.workspaceDir, this.sessionKey);
  }

  private get assetsDirectory(): string {
    return `${this.filePath.slice(0, -'.json'.length)}.assets`;
  }

  async switchSession(
    sessionKey: string,
    options: { readonly migrateCurrent?: boolean } = {},
  ): Promise<void> {
    const normalized = normalizeSessionKey(sessionKey);
    if (normalized === this.sessionKey) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.writeChain.catch(() => undefined);
    const previousFilePath = this.filePath;
    const previousAssetsDirectory = this.assetsDirectory;
    const previousSessionKey = this.sessionKey;
    this.sessionKey = normalized;
    if (!options.migrateCurrent) return;
    const nextFilePath = this.filePath;
    try {
      await mkdir(dirname(nextFilePath), { recursive: true, mode: 0o700 });
      await this.migrateSessionState(
        previousFilePath,
        previousAssetsDirectory,
        nextFilePath,
        this.assetsDirectory,
      );
    } catch (error) {
      this.sessionKey = previousSessionKey;
      throw new TuiDraftRecoveryError('migrate', error);
    }
  }

  async load(): Promise<TuiRecoverableDraft | undefined> {
    await this.migrateLegacyWorkspaceDraft();
    let bytes: Buffer;
    try {
      const info = await stat(this.filePath);
      if (!info.isFile() || info.size > MAX_DRAFT_FILE_BYTES) return undefined;
      bytes = await readFile(this.filePath);
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      return undefined;
    }
    if (!isStoredDraft(parsed)) return undefined;
    const attachments: TuiAttachment[] = [];
    for (const attachment of parsed.attachments) {
      if (attachments.length >= MAX_RECOVERED_ATTACHMENTS) break;
      const exists = await stat(attachment.filePath)
        .then((info) => info.isFile())
        .catch(() => false);
      if (exists) attachments.push(attachment);
    }
    const retrySubmissions: TuiRetrySubmission[] = [];
    for (const retry of parsed.retrySubmissions ?? []) {
      if (retrySubmissions.length >= MAX_RECOVERED_RETRIES) break;
      const retryAttachments: TuiAttachment[] = [];
      for (const attachment of retry.snapshot.attachments) {
        const exists = await stat(attachment.filePath)
          .then((info) => info.isFile())
          .catch(() => false);
        if (exists) retryAttachments.push(attachment);
      }
      const transportAttachments: TuiTransportAttachment[] = [];
      for (const attachment of retry.snapshot.transportAttachments ?? []) {
        if (attachment.assetId) {
          transportAttachments.push(attachment);
          continue;
        }
        if (!attachment.filePath) continue;
        const exists = await stat(attachment.filePath)
          .then((info) => info.isFile())
          .catch(() => false);
        if (exists) transportAttachments.push(attachment);
      }
      retrySubmissions.push({
        retryId: retry.retryId,
        failedReason: retry.failedReason,
        ...(retry.failureCode ? { failureCode: retry.failureCode } : {}),
        snapshot: {
          ...retry.snapshot,
          editor: retainAvailableAttachmentPlaceholders(retry.snapshot.editor, retryAttachments),
          attachments: retryAttachments,
          ...(retry.snapshot.transportAttachments ? { transportAttachments } : {}),
        },
      });
    }
    return {
      editor: retainAvailableAttachmentPlaceholders(parsed.editor, attachments),
      attachments,
      ...(retrySubmissions.length > 0 ? { retrySubmissions } : {}),
    };
  }

  schedule(draft: TuiRecoverableDraft): void {
    if (this.disposed) return;
    this.latest = cloneDraft(draft);
    if (this.timer) clearTimeout(this.timer);
    if (this.suspended) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const latest = this.latest;
      if (latest) void this.enqueueWrite(latest, false).catch((error) => this.onError?.(error));
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async flush(
    draft: TuiRecoverableDraft,
    options: { readonly materializeVolatileAttachments?: boolean } = {},
  ): Promise<void> {
    this.suspended = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.latest = cloneDraft(draft);
    await this.enqueueWrite(this.latest, options.materializeVolatileAttachments === true);
  }

  suspend(): void {
    if (this.disposed) return;
    this.suspended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.latest = undefined;
    this.suspended = false;
  }

  private enqueueWrite(
    draft: TuiRecoverableDraft,
    materializeVolatileAttachments: boolean,
  ): Promise<void> {
    const captured = cloneDraft(draft);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => this.persist(captured, materializeVolatileAttachments))
      .then(() => this.onPersisted?.())
      .catch((error: unknown) => {
        throw error instanceof TuiDraftRecoveryError
          ? error
          : new TuiDraftRecoveryError(hasDraftContent(captured) ? 'save' : 'cleanup', error);
      });
    return this.writeChain;
  }

  private async persist(
    draft: TuiRecoverableDraft,
    materializeVolatileAttachments: boolean,
  ): Promise<void> {
    if (!hasDraftContent(draft)) {
      await removeExistingDraftPath(this.filePath);
      await removeExistingDraftPath(this.assetsDirectory, true);
      return;
    }
    const updatedAtMs = Date.now();
    const preliminary: StoredDraft = {
      schemaVersion: DRAFT_SCHEMA_VERSION,
      updatedAtMs,
      editor: draft.editor,
      attachments: [...draft.attachments],
      retrySubmissions: [...(draft.retrySubmissions ?? [])].slice(0, MAX_RECOVERED_RETRIES),
    };
    assertDraftWithinSizeLimit(preliminary);
    const materializedDraft = materializeVolatileAttachments
      ? await this.materializeEditorAttachments(draft.editor, draft.attachments)
      : { editor: draft.editor, attachments: draft.attachments };
    const retrySubmissions = await Promise.all(
      (draft.retrySubmissions ?? []).slice(0, MAX_RECOVERED_RETRIES).map(async (retry) => ({
        retryId: retry.retryId,
        failedReason: retry.failedReason,
        ...(retry.failureCode ? { failureCode: retry.failureCode } : {}),
        snapshot: await this.materializeSubmission(retry.snapshot),
      })),
    );
    const stored: StoredDraft = {
      schemaVersion: DRAFT_SCHEMA_VERSION,
      updatedAtMs,
      editor: materializedDraft.editor,
      attachments: [...materializedDraft.attachments],
      retrySubmissions,
    };
    const content = `${JSON.stringify(stored)}\n`;
    if (Buffer.byteLength(content) > MAX_DRAFT_FILE_BYTES) throw draftTooLargeError();
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${this.filePath}.${process.pid}.${++this.writeGeneration}.tmp`;
    let temporaryCreated = false;
    try {
      await writeDraftTemporaryFile(temporaryPath, content);
      temporaryCreated = true;
      await rename(temporaryPath, this.filePath);
      temporaryCreated = false;
      await chmod(this.filePath, 0o600);
      await this.pruneMaterializedAssets(stored);
    } finally {
      if (temporaryCreated) await removeExistingDraftPath(temporaryPath).catch(() => undefined);
    }
  }

  private async migrateSessionState(
    previousFilePath: string,
    previousAssetsDirectory: string,
    nextFilePath: string,
    nextAssetsDirectory: string,
  ): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await readFile(previousFilePath);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      parsed = undefined;
    }
    if (!isStoredDraft(parsed)) {
      await chmod(previousFilePath, 0o600);
      await rename(previousFilePath, nextFilePath);
      return;
    }

    let assetsMoved = false;
    try {
      await rename(previousAssetsDirectory, nextAssetsDirectory);
      assetsMoved = true;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    const temporaryPath = `${nextFilePath}.${process.pid}.${++this.writeGeneration}.tmp`;
    let temporaryCreated = false;
    let draftMoved = false;
    try {
      await chmod(previousFilePath, 0o600);
      if (assetsMoved) {
        const relocated = relocateStoredDraftAssets(
          parsed,
          previousAssetsDirectory,
          nextAssetsDirectory,
        );
        await writeDraftTemporaryFile(temporaryPath, `${JSON.stringify(relocated)}\n`);
        temporaryCreated = true;
      }
      await rename(previousFilePath, nextFilePath);
      draftMoved = true;
      if (temporaryCreated) {
        await rename(temporaryPath, nextFilePath);
        temporaryCreated = false;
      }
    } catch (error) {
      // Until the relocated metadata commits, the moved file still contains the original paths.
      if (draftMoved) await rename(nextFilePath, previousFilePath).catch(() => undefined);
      if (assetsMoved) {
        await rename(nextAssetsDirectory, previousAssetsDirectory).catch(() => undefined);
      }
      throw error;
    } finally {
      if (temporaryCreated) await removeExistingDraftPath(temporaryPath).catch(() => undefined);
    }
  }

  private async migrateLegacyWorkspaceDraft(): Promise<void> {
    if (this.sessionKey !== 'new-session') return;
    const currentExists = await stat(this.filePath)
      .then((info) => info.isFile())
      .catch(() => false);
    if (currentExists) return;
    const legacyFilePath = resolveTuiDraftRecoveryPath(this.dataDir, this.workspaceDir);
    const legacyAssetsDirectory = `${legacyFilePath.slice(0, -'.json'.length)}.assets`;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await this.migrateSessionState(
      legacyFilePath,
      legacyAssetsDirectory,
      this.filePath,
      this.assetsDirectory,
    );
  }

  private async materializeEditorAttachments(
    editor: EditorDraftSnapshot,
    attachments: readonly TuiAttachment[],
  ): Promise<{ editor: EditorDraftSnapshot; attachments: TuiAttachment[] }> {
    const output: TuiAttachment[] = [];
    const relocatedPaths = new Map<string, string>();
    for (const attachment of attachments) {
      if (!isVolatileClipboardMedia(attachment)) {
        output.push(attachment);
        continue;
      }
      const suffix = extname(attachment.fileName).slice(0, 16);
      const id = createHash('sha256').update(attachment.filePath).digest('hex').slice(0, 16);
      const target = join(this.assetsDirectory, `${id}${suffix}`);
      try {
        await mkdir(this.assetsDirectory, { recursive: true, mode: 0o700 });
        await chmod(this.assetsDirectory, 0o700);
        await copyFile(attachment.filePath, target);
        await chmod(target, 0o600);
        output.push({ ...attachment, filePath: target });
        relocatedPaths.set(attachment.filePath, target);
      } catch (error) {
        throw new Error(`Unable to preserve clipboard media Draft: ${toErrorMessage(error)}`);
      }
    }
    return {
      editor: relocateEditorAttachmentPlaceholders(editor, relocatedPaths),
      attachments: output,
    };
  }

  private async materializeSubmission(
    snapshot: TuiSubmissionSnapshot,
  ): Promise<TuiSubmissionSnapshot> {
    const materialized = await this.materializeEditorAttachments(
      snapshot.editor,
      snapshot.attachments,
    );
    const relocatedPaths = new Map<string, string>();
    snapshot.attachments.forEach((attachment, index) => {
      const materializedAttachment = materialized.attachments[index];
      if (materializedAttachment && materializedAttachment.filePath !== attachment.filePath) {
        relocatedPaths.set(attachment.filePath, materializedAttachment.filePath);
      }
    });
    return {
      submissionId: snapshot.submissionId,
      ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
      editor: materialized.editor,
      content: snapshot.content,
      ...(snapshot.transportContent ? { transportContent: snapshot.transportContent } : {}),
      attachments: materialized.attachments,
      ...(snapshot.transportAttachments
        ? {
            transportAttachments: snapshot.transportAttachments.map((attachment) => {
              const relocatedPath = attachment.filePath
                ? relocatedPaths.get(attachment.filePath)
                : undefined;
              return {
                ...attachment,
                ...(relocatedPath ? { filePath: relocatedPath } : {}),
              };
            }),
          }
        : {}),
      createdAtMs: snapshot.createdAtMs,
      ...(snapshot.clientIntent ? { clientIntent: snapshot.clientIntent } : {}),
      ...(snapshot.reviewRequest ? { reviewRequest: snapshot.reviewRequest } : {}),
    };
  }

  private async pruneMaterializedAssets(stored: StoredDraft): Promise<void> {
    const retained = new Set(
      [
        ...stored.attachments,
        ...(stored.retrySubmissions ?? []).flatMap((retry) => retry.snapshot.attachments),
      ]
        .map((attachment) => resolve(attachment.filePath))
        .filter((filePath) => dirname(filePath) === resolve(this.assetsDirectory)),
    );
    const entries = await readdir(this.assetsDirectory, {
      withFileTypes: true,
    }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const filePath = resolve(this.assetsDirectory, entry.name);
        if (!retained.has(filePath)) await removeExistingDraftPath(filePath);
      }),
    );
  }
}

async function writeDraftTemporaryFile(filePath: string, content: string): Promise<void> {
  const file = await open(filePath, 'wx', 0o600);
  try {
    try {
      await file.writeFile(content, 'utf8');
    } finally {
      await file.close();
    }
  } catch (error) {
    await removeExistingDraftPath(filePath).catch(() => undefined);
    throw error;
  }
}

async function removeExistingDraftPath(filePath: string, recursive = false): Promise<void> {
  try {
    try {
      await lstat(filePath);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    await rm(filePath, { recursive, force: true });
  } catch (error) {
    throw new TuiDraftRecoveryError('cleanup', error);
  }
}

export function resolveTuiDraftRecoveryPath(
  dataDir: string,
  workspaceDir: string,
  sessionKey?: string,
): string {
  const workspaceId = createHash('sha256').update(resolve(workspaceDir)).digest('hex').slice(0, 24);
  if (!sessionKey) {
    return join(resolve(dataDir), 'v2', 'mcode', 'drafts', `${workspaceId}.json`);
  }
  const sessionId = createHash('sha256')
    .update(normalizeSessionKey(sessionKey))
    .digest('hex')
    .slice(0, 24);
  return join(resolve(dataDir), 'v2', 'mcode', 'drafts', workspaceId, `${sessionId}.json`);
}

function cloneDraft(draft: TuiRecoverableDraft): TuiRecoverableDraft {
  return {
    editor: {
      ...draft.editor,
      pluginMentions: draft.editor.pluginMentions?.map((mention) => ({ ...mention })),
      pastes: draft.editor.pastes.map((paste) => ({ ...paste })),
      ...(draft.editor.attachmentPlaceholders
        ? {
            attachmentPlaceholders: draft.editor.attachmentPlaceholders.map((element) => ({
              ...element,
            })),
          }
        : {}),
    },
    attachments: draft.attachments.map((attachment) => ({ ...attachment })),
    ...(draft.retrySubmissions
      ? { retrySubmissions: draft.retrySubmissions.map(cloneRetrySubmission) }
      : {}),
  };
}

function cloneRetrySubmission(retry: TuiRetrySubmission): TuiRetrySubmission {
  return {
    retryId: retry.retryId,
    failedReason: retry.failedReason,
    ...(retry.failureCode ? { failureCode: retry.failureCode } : {}),
    snapshot: {
      submissionId: retry.snapshot.submissionId,
      ...(retry.snapshot.sessionId ? { sessionId: retry.snapshot.sessionId } : {}),
      editor: cloneEditorDraft(retry.snapshot.editor),
      content: retry.snapshot.content,
      ...(retry.snapshot.transportContent
        ? { transportContent: retry.snapshot.transportContent }
        : {}),
      attachments: retry.snapshot.attachments.map((attachment) => ({
        ...attachment,
      })),
      ...(retry.snapshot.transportAttachments
        ? {
            transportAttachments: retry.snapshot.transportAttachments.map((attachment) => ({
              ...attachment,
            })),
          }
        : {}),
      createdAtMs: retry.snapshot.createdAtMs,
      ...(retry.snapshot.clientIntent ? { clientIntent: retry.snapshot.clientIntent } : {}),
      ...(retry.snapshot.reviewRequest ? { reviewRequest: retry.snapshot.reviewRequest } : {}),
    },
  };
}

function cloneEditorDraft(editor: EditorDraftSnapshot): EditorDraftSnapshot {
  return {
    ...editor,
    pluginMentions: editor.pluginMentions?.map((mention) => ({ ...mention })),
    pastes: editor.pastes.map((paste) => ({ ...paste })),
    ...(editor.attachmentPlaceholders
      ? {
          attachmentPlaceholders: editor.attachmentPlaceholders.map((placeholder) => ({
            ...placeholder,
          })),
        }
      : {}),
  };
}

function relocateEditorAttachmentPlaceholders(
  editor: EditorDraftSnapshot,
  relocatedPaths: ReadonlyMap<string, string>,
): EditorDraftSnapshot {
  if (relocatedPaths.size === 0 || !editor.attachmentPlaceholders) return editor;
  return {
    ...editor,
    attachmentPlaceholders: editor.attachmentPlaceholders.map((placeholder) => ({
      ...placeholder,
      id: relocatedPaths.get(placeholder.id) ?? placeholder.id,
    })),
  };
}

/** Drops editor attachment placeholders whose backing file no longer exists. */
export function retainAvailableAttachmentPlaceholders(
  editor: EditorDraftSnapshot,
  attachments: readonly TuiAttachment[],
): EditorDraftSnapshot {
  if (!editor.attachmentPlaceholders) return editor;
  const available = new Set(attachments.map((attachment) => attachment.filePath));
  return {
    ...editor,
    attachmentPlaceholders: editor.attachmentPlaceholders.filter((placeholder) =>
      available.has(placeholder.id),
    ),
  };
}

function relocateStoredDraftAssets(
  draft: StoredDraft,
  previousAssetsDirectory: string,
  nextAssetsDirectory: string,
): StoredDraft {
  const relocatedPaths = new Map<string, string>();
  const relocateAttachments = (attachments: readonly TuiAttachment[]): TuiAttachment[] =>
    attachments.map((attachment) => {
      const relativePath = relative(resolve(previousAssetsDirectory), resolve(attachment.filePath));
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        return { ...attachment };
      }
      const filePath = resolve(nextAssetsDirectory, relativePath);
      relocatedPaths.set(attachment.filePath, filePath);
      return { ...attachment, filePath };
    });
  const attachments = relocateAttachments(draft.attachments);
  const retrySubmissions = (draft.retrySubmissions ?? []).map((retry) => {
    const retryAttachments = relocateAttachments(retry.snapshot.attachments);
    return {
      retryId: retry.retryId,
      failedReason: retry.failedReason,
      ...(retry.failureCode ? { failureCode: retry.failureCode } : {}),
      snapshot: {
        ...retry.snapshot,
        attachments: retryAttachments,
        editor: relocateEditorAttachmentPlaceholders(retry.snapshot.editor, relocatedPaths),
        ...(retry.snapshot.transportAttachments
          ? {
              transportAttachments: retry.snapshot.transportAttachments.map((attachment) => ({
                ...attachment,
                ...(attachment.filePath && relocatedPaths.has(attachment.filePath)
                  ? { filePath: relocatedPaths.get(attachment.filePath) }
                  : {}),
              })),
            }
          : {}),
      },
    };
  });
  return {
    ...draft,
    attachments,
    editor: relocateEditorAttachmentPlaceholders(draft.editor, relocatedPaths),
    retrySubmissions,
  };
}

function hasDraftContent(draft: TuiRecoverableDraft): boolean {
  return (
    draft.editor.text.length > 0 ||
    draft.attachments.length > 0 ||
    (draft.retrySubmissions?.length ?? 0) > 0
  );
}

function assertDraftWithinSizeLimit(draft: StoredDraft): void {
  if (Buffer.byteLength(`${JSON.stringify(draft)}\n`) > MAX_DRAFT_FILE_BYTES) {
    throw draftTooLargeError();
  }
}

function draftTooLargeError(): Error {
  return new Error('Draft recovery exceeds the 2 MiB safety limit.');
}

function isStoredDraft(value: unknown): value is StoredDraft {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== DRAFT_SCHEMA_VERSION)
  ) {
    return false;
  }
  if (!Number.isFinite(value.updatedAtMs) || !isEditorDraft(value.editor)) return false;
  if (
    !Array.isArray(value.attachments) ||
    value.attachments.length > MAX_RECOVERED_ATTACHMENTS ||
    !value.attachments.every(isAttachment)
  ) {
    return false;
  }
  if (
    value.retrySubmissions !== undefined &&
    (!Array.isArray(value.retrySubmissions) ||
      value.retrySubmissions.length > MAX_RECOVERED_RETRIES ||
      !value.retrySubmissions.every(isRetrySubmission))
  ) {
    return false;
  }
  if (value.retrySubmissions === undefined) value.retrySubmissions = [];
  const attachmentPaths = new Set(value.attachments.map((attachment) => attachment.filePath));
  return (value.editor.attachmentPlaceholders ?? []).every((element) =>
    attachmentPaths.has(element.id),
  );
}

function isRetrySubmission(value: unknown): value is TuiRetrySubmission {
  return (
    isRecord(value) &&
    typeof value.retryId === 'string' &&
    value.retryId.startsWith('retry:') &&
    typeof value.failedReason === 'string' &&
    value.failedReason.length > 0 &&
    (value.failureCode === undefined ||
      (typeof value.failureCode === 'string' && value.failureCode.length > 0)) &&
    isSubmissionSnapshot(value.snapshot)
  );
}

function isSubmissionSnapshot(value: unknown): value is TuiSubmissionSnapshot {
  if (
    !isRecord(value) ||
    typeof value.submissionId !== 'string' ||
    value.submissionId.length === 0 ||
    (value.sessionId !== undefined && typeof value.sessionId !== 'string') ||
    !isEditorDraft(value.editor) ||
    typeof value.content !== 'string' ||
    (value.transportContent !== undefined && typeof value.transportContent !== 'string') ||
    !Array.isArray(value.attachments) ||
    value.attachments.length > MAX_RECOVERED_ATTACHMENTS ||
    !value.attachments.every(isAttachment) ||
    (value.transportAttachments !== undefined &&
      (!Array.isArray(value.transportAttachments) ||
        value.transportAttachments.length > MAX_RECOVERED_ATTACHMENTS ||
        !value.transportAttachments.every(isTransportAttachment))) ||
    (value.clientIntent !== undefined &&
      value.clientIntent !== 'plan-entry' &&
      value.clientIntent !== 'plan-exit') ||
    (value.reviewRequest !== undefined &&
      (!isRecord(value.reviewRequest) || value.reviewRequest.scope !== 'local_changes')) ||
    !Number.isFinite(value.createdAtMs)
  ) {
    return false;
  }
  const attachmentPaths = new Set(value.attachments.map((attachment) => attachment.filePath));
  return (value.editor.attachmentPlaceholders ?? []).every((placeholder) =>
    attachmentPaths.has(placeholder.id),
  );
}

function normalizeSessionKey(value: string): string {
  return value.trim() || 'new-session';
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isEditorDraft(value: unknown): value is EditorDraftSnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.text !== 'string' ||
    !validPluginMentions(value.text, value.pluginMentions) ||
    !Number.isInteger(value.cursor) ||
    (value.cursor as number) < 0 ||
    (value.cursor as number) > value.text.length ||
    !Number.isInteger(value.pasteCounter) ||
    (value.pasteCounter as number) < 0 ||
    !Array.isArray(value.pastes) ||
    (value.attachmentPlaceholders !== undefined && !Array.isArray(value.attachmentPlaceholders))
  ) {
    return false;
  }
  const text = value.text as string;
  const ids = new Set<number>();
  const validPastes = value.pastes.every((paste) => {
    if (
      !isRecord(paste) ||
      !Number.isInteger(paste.id) ||
      (paste.id as number) <= 0 ||
      (paste.id as number) > (value.pasteCounter as number) ||
      ids.has(paste.id as number) ||
      typeof paste.content !== 'string'
    ) {
      return false;
    }
    ids.add(paste.id as number);
    return true;
  });
  if (!validPastes) return false;
  const attachmentIds = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
  return (value.attachmentPlaceholders ?? []).every((element) => {
    if (
      !isRecord(element) ||
      typeof element.id !== 'string' ||
      !element.id ||
      attachmentIds.has(element.id) ||
      typeof element.label !== 'string' ||
      !element.label ||
      !Number.isInteger(element.start) ||
      !Number.isInteger(element.end) ||
      (element.leadingSpace !== undefined && typeof element.leadingSpace !== 'boolean')
    ) {
      return false;
    }
    const start = element.start as number;
    const end = element.end as number;
    const atomicStart = element.leadingSpace === true ? start - 1 : start;
    if (
      start < 0 ||
      end <= start ||
      end > text.length ||
      text.slice(start, end) !== element.label ||
      (element.leadingSpace === true && text[start - 1] !== ' ') ||
      ranges.some((range) => atomicStart < range.end && end > range.start)
    ) {
      return false;
    }
    attachmentIds.add(element.id);
    ranges.push({ start: atomicStart, end });
    return true;
  });
}

function isAttachment(value: unknown): value is TuiAttachment {
  return (
    isRecord(value) &&
    (value.type === 'file' || value.type === 'image') &&
    typeof value.filePath === 'string' &&
    isAbsolute(value.filePath) &&
    typeof value.fileName === 'string' &&
    value.fileName.length > 0 &&
    typeof value.mimeType === 'string' &&
    Number.isFinite(value.sizeBytes) &&
    (value.sizeBytes as number) >= 0
  );
}

function isTransportAttachment(value: unknown): value is TuiTransportAttachment {
  return (
    isRecord(value) &&
    (value.type === 'file' || value.type === 'image') &&
    typeof value.fileName === 'string' &&
    value.fileName.length > 0 &&
    typeof value.mimeType === 'string' &&
    (value.sizeBytes === undefined ||
      (Number.isFinite(value.sizeBytes) && (value.sizeBytes as number) >= 0)) &&
    ((typeof value.filePath === 'string' && isAbsolute(value.filePath)) ||
      (typeof value.assetId === 'string' && value.assetId.length > 0))
  );
}

function isVolatileClipboardMedia(attachment: TuiAttachment): boolean {
  const pathFromTemporaryDirectory = relative(resolve(tmpdir()), resolve(attachment.filePath));
  if (
    !pathFromTemporaryDirectory ||
    pathFromTemporaryDirectory.startsWith('..') ||
    isAbsolute(pathFromTemporaryDirectory)
  ) {
    return false;
  }
  return (
    pathFromTemporaryDirectory.split(/[\\/]/u)[0]?.startsWith('minimax-code-clipboard-') === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
