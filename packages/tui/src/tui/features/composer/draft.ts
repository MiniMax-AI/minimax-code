import type { TuiAttachment } from '../../../types/invocation.js';
import {
  ClipboardImageDraft,
  type ClipboardImagePasteCallbacks,
  type ClipboardImageReader,
} from './clipboard-image-draft.js';
import {
  MINIMAX_CODE_MAX_ATTACHMENT_COUNT,
  MINIMAX_CODE_MAX_TOTAL_ATTACHMENT_BYTES,
  MINIMAX_CODE_PASTED_TEXT_ATTACHMENT_THRESHOLD,
} from '../../../application/attachment-policy.js';
import { tuiAttachmentLabel, type ResolveTuiAttachmentOptions } from './attachments.js';
import type { TuiClipboardImageLease } from '../../../host/clipboard-image.js';

export interface TuiComposerDraftSnapshot {
  readonly attachments: readonly TuiAttachment[];
}

export interface TuiComposerAttachmentPlaceholder {
  readonly id: string;
  readonly label: string;
}

interface ComposerDraftClipboard {
  paste(callbacks: ClipboardImagePasteCallbacks): Promise<void>;
  abortRead(): boolean;
  attachPastedText?(
    text: string,
    onPasted: (attachment: TuiAttachment) => boolean,
  ): Promise<boolean>;
  transferToQueue(itemId: string, attachments: readonly TuiAttachment[]): void;
  releaseAttachments(attachments: readonly TuiAttachment[]): Promise<void>;
  releaseQueueItem(itemId: string): Promise<void>;
  restoreQueueItem?(itemId: string, attachments: readonly TuiAttachment[]): void;
  prepareAttachmentsForQueue?(attachments: readonly TuiAttachment[]): Promise<TuiAttachment[]>;
  releasePreparedQueueAttachments?(
    original: readonly TuiAttachment[],
    prepared: readonly TuiAttachment[],
  ): Promise<void>;
}

export class TuiComposerDraft {
  private attachments: TuiAttachment[] = [];
  private readonly detachedAttachments = new Map<
    string,
    { attachment: TuiAttachment; index: number }
  >();
  private clearedDraft: TuiComposerDraftSnapshot | undefined;
  private readonly clipboard: ComposerDraftClipboard;
  private draftGeneration = 0;

  constructor(
    private readonly options: {
      workspaceDir: string;
      homeDir?: string;
      resolveAttachment(
        reference: string,
        options: ResolveTuiAttachmentOptions,
      ): Promise<TuiAttachment>;
      clipboard?: ComposerDraftClipboard;
      readClipboardImage?: ClipboardImageReader;
      readClipboardText?: () => Promise<string | null>;
      insertTextAtCursor?(text: string): void;
      /** False while the draft cannot carry attachments, such as a `!` shell command. */
      acceptsPastedTextAttachment?(): boolean;
      draftRecoveryDataDir?: string;
      prepareQueueAttachmentLease?(
        attachment: TuiAttachment,
      ): Promise<TuiClipboardImageLease | undefined>;
      append(message: string, kind?: 'warning' | 'error'): void;
      onChanged(): void;
      onAttachmentPlaceholdersChanged?(
        placeholders: readonly TuiComposerAttachmentPlaceholder[],
      ): void;
      attachmentPlaceholderOffset?(): number;
      isStopped?(): boolean;
      onHint?(message: string | undefined): void;
      onRender?(): void;
    },
  ) {
    this.clipboard =
      options.clipboard ??
      new ClipboardImageDraft(
        options.readClipboardImage,
        options.readClipboardText,
        options.prepareQueueAttachmentLease,
        options.draftRecoveryDataDir,
      );
  }

  snapshot(): TuiComposerDraftSnapshot {
    return {
      attachments: [...this.attachments],
    };
  }

  capture(): TuiComposerDraftSnapshot {
    return this.snapshot();
  }

  reserveSubmission(captured: TuiComposerDraftSnapshot = this.capture()): TuiComposerDraftSnapshot {
    void this.releaseDetachedAttachments();
    void this.discardClearedDraft();
    this.removeCaptured(captured);
    this.notifyChanged();
    return captured;
  }

  restoreSubmission(captured: TuiComposerDraftSnapshot): void {
    const attachmentPaths = new Set(this.attachments.map((item) => item.filePath));
    this.attachments = [
      ...captured.attachments.filter((item) => !attachmentPaths.has(item.filePath)),
      ...this.attachments,
    ];
    this.notifyChanged();
  }

  hasContent(): boolean {
    return this.attachments.length > 0;
  }

  restoreAttachments(attachments: readonly TuiAttachment[]): void {
    const existingPaths = new Set(this.attachments.map((item) => item.filePath));
    const restored: TuiAttachment[] = [];
    for (const item of attachments) {
      if (existingPaths.has(item.filePath)) continue;
      if (!this.canAddAttachment(item, false, [...this.attachments, ...restored])) break;
      existingPaths.add(item.filePath);
      restored.push(item);
    }
    if (restored.length > 0) this.attachments = [...this.attachments, ...restored];
    this.notifyChanged();
  }

  ensureAttachmentPlaceholders(): void {
    this.syncAttachmentPlaceholders();
  }

  async queueAttachment(
    reference: string,
    options: Pick<ResolveTuiAttachmentOptions, 'source'> = {},
  ): Promise<void> {
    if (!reference.trim()) {
      this.options.append('Cannot add an empty attachment path.', 'warning');
      return;
    }
    const draftGeneration = this.draftGeneration;
    const attachment = await this.options.resolveAttachment(reference, {
      ...options,
      workspaceDir: this.options.workspaceDir,
      ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}),
    });
    if (draftGeneration !== this.draftGeneration || this.options.isStopped?.()) return;
    if (this.attachments.some((item) => item.filePath === attachment.filePath)) {
      this.options.append(
        `Already attached for the next message: ${attachment.fileName}`,
        'warning',
      );
      return;
    }
    if (!this.canAddAttachment(attachment)) return;
    this.attachments = [...this.attachments, attachment];
    this.notifyChanged();
  }

  async pasteClipboard(): Promise<void> {
    await this.clipboard.paste({
      isStopped: () => this.options.isStopped?.() ?? false,
      onHint: (message) => this.options.onHint?.(message),
      onPasted: (attachment) => {
        if (!this.canAddAttachment(attachment)) return false;
        this.attachments = [...this.attachments, attachment];
        this.notifyChanged();
        return true;
      },
      onTextPasted: (text) => {
        const insert = (value: string) => {
          this.options.insertTextAtCursor?.(value);
          this.notifyChanged();
        };
        if (!this.pasteLongText(text, insert)) insert(text);
      },
      onWarning: (message) => this.options.append(message, 'warning'),
      onRender: () => this.options.onRender?.(),
    });
  }

  /**
   * Takes a paste of at least {@link MINIMAX_CODE_PASTED_TEXT_ATTACHMENT_THRESHOLD}
   * characters as a `pasted-text.txt` attachment, like the Desktop composer, so the
   * message text and history stay short. Returns false when the caller should insert
   * the text itself. If the file cannot be written the text goes to `insertInline`
   * so the paste is never lost.
   */
  pasteLongText(text: string, insertInline: (text: string) => void): boolean {
    if (text.length < MINIMAX_CODE_PASTED_TEXT_ATTACHMENT_THRESHOLD) return false;
    if (!this.clipboard.attachPastedText) return false;
    if (this.options.acceptsPastedTextAttachment?.() === false) return false;
    const draftGeneration = this.draftGeneration;
    void this.clipboard
      .attachPastedText(text, (attachment) => {
        if (draftGeneration !== this.draftGeneration || this.options.isStopped?.()) return false;
        if (!this.canAddAttachment(attachment)) return false;
        this.attachments = [...this.attachments, attachment];
        this.notifyChanged();
        return true;
      })
      .catch(() => {
        if (draftGeneration !== this.draftGeneration || this.options.isStopped?.()) return;
        this.options.append(
          "Couldn't save the long paste as an attachment. It was kept in the message instead.",
          'warning',
        );
        insertInline(text);
      });
    return true;
  }

  async removeLastAttachment(): Promise<boolean> {
    return this.removeAttachmentAt(this.attachments.length - 1);
  }

  async removeAttachmentById(id: string): Promise<boolean> {
    const index = this.attachments.findIndex((item) => item.filePath === id);
    const attachment = this.attachments[index];
    if (!attachment) return false;
    this.detachedAttachments.set(id, { attachment, index });
    this.attachments = this.attachments.filter((_item, itemIndex) => itemIndex !== index);
    this.notifyChanged();
    return true;
  }

  restoreAttachmentById(id: string): boolean {
    const detached = this.detachedAttachments.get(id);
    if (!detached || this.attachments.some((item) => item.filePath === id)) return false;
    this.detachedAttachments.delete(id);
    const index = Math.max(0, Math.min(detached.index, this.attachments.length));
    this.attachments = [
      ...this.attachments.slice(0, index),
      detached.attachment,
      ...this.attachments.slice(index),
    ];
    this.notifyChanged();
    return true;
  }

  stashForClear(): boolean {
    if (this.clearedDraft || !this.hasContent()) return false;
    void this.releaseDetachedAttachments();
    this.clearedDraft = this.capture();
    this.attachments = [];
    this.notifyChanged();
    return true;
  }

  restoreClearedDraft(): boolean {
    const cleared = this.clearedDraft;
    if (!cleared) return false;
    this.clearedDraft = undefined;
    this.restoreSubmission(cleared);
    return true;
  }

  async discardClearedDraft(): Promise<void> {
    const cleared = this.clearedDraft;
    if (!cleared) return;
    this.clearedDraft = undefined;
    await this.clipboard.releaseAttachments(cleared.attachments);
  }

  async completeSubmission(captured: TuiComposerDraftSnapshot): Promise<void> {
    this.removeCaptured(captured);
    this.notifyChanged();
    await Promise.all([
      this.clipboard.releaseAttachments(captured.attachments),
      this.releaseDetachedAttachments(),
      this.discardClearedDraft(),
    ]);
  }

  async prepareQueueSubmission(
    captured: TuiComposerDraftSnapshot,
  ): Promise<TuiComposerDraftSnapshot> {
    return {
      attachments: this.clipboard.prepareAttachmentsForQueue
        ? await this.clipboard.prepareAttachmentsForQueue(captured.attachments)
        : captured.attachments.map((attachment) => ({ ...attachment })),
    };
  }

  releasePreparedQueueSubmission(
    original: TuiComposerDraftSnapshot,
    prepared: TuiComposerDraftSnapshot,
  ): Promise<void> {
    return (
      this.clipboard.releasePreparedQueueAttachments?.(
        original.attachments,
        prepared.attachments,
      ) ?? Promise.resolve()
    );
  }

  completeQueuedSubmission(
    captured: TuiComposerDraftSnapshot,
    queueItemId: string,
    queued: TuiComposerDraftSnapshot = captured,
  ): void {
    this.removeCaptured(captured);
    this.clipboard.transferToQueue(queueItemId, queued.attachments);
    void this.releaseDetachedAttachments();
    void this.discardClearedDraft();
    this.notifyChanged();
  }

  restoreQueuedSubmission(itemId: string, captured: TuiComposerDraftSnapshot): void {
    this.clipboard.restoreQueueItem?.(itemId, captured.attachments);
    this.restoreSubmission(captured);
  }

  releaseQueueItem(itemId: string): Promise<void> {
    return this.clipboard.releaseQueueItem(itemId);
  }

  abortClipboardRead(): boolean {
    return this.clipboard.abortRead();
  }

  async discard(): Promise<void> {
    this.draftGeneration += 1;
    const removed = [
      ...this.attachments,
      ...[...this.detachedAttachments.values()].map(({ attachment }) => attachment),
      ...(this.clearedDraft?.attachments ?? []),
    ];
    this.attachments = [];
    this.detachedAttachments.clear();
    this.clearedDraft = undefined;
    this.notifyChanged();
    await this.clipboard.releaseAttachments(removed);
  }

  private removeCaptured(captured: TuiComposerDraftSnapshot): void {
    const attachmentPaths = new Set(captured.attachments.map((item) => item.filePath));
    this.attachments = this.attachments.filter((item) => !attachmentPaths.has(item.filePath));
  }

  private async removeAttachmentAt(index: number): Promise<boolean> {
    const removed = this.attachments[index];
    if (!removed) return false;
    this.attachments = this.attachments.filter((_item, itemIndex) => itemIndex !== index);
    this.notifyChanged();
    await this.clipboard.releaseAttachments([removed]);
    return true;
  }

  private async releaseDetachedAttachments(): Promise<void> {
    const detached = [...this.detachedAttachments.values()].map(({ attachment }) => attachment);
    if (detached.length === 0) return;
    this.detachedAttachments.clear();
    await this.clipboard.releaseAttachments(detached);
  }

  private notifyChanged(): void {
    this.syncAttachmentPlaceholders();
    this.options.onChanged();
  }

  private canAddAttachment(
    attachment: TuiAttachment,
    warn = true,
    current: readonly TuiAttachment[] = this.attachments,
  ): boolean {
    if (current.length >= MINIMAX_CODE_MAX_ATTACHMENT_COUNT) {
      if (warn) {
        this.options.append(
          `You can attach up to ${String(MINIMAX_CODE_MAX_ATTACHMENT_COUNT)} files. Remove one before adding another.`,
          'warning',
        );
      }
      return false;
    }
    const totalBytes = current.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (totalBytes + attachment.sizeBytes > MINIMAX_CODE_MAX_TOTAL_ATTACHMENT_BYTES) {
      if (warn) {
        this.options.append(
          'Attachments can total up to 100 MB. Remove an attachment or choose a smaller file.',
          'warning',
        );
      }
      return false;
    }
    return true;
  }

  private syncAttachmentPlaceholders(): void {
    this.options.onAttachmentPlaceholdersChanged?.(
      this.attachments.map((attachment, index) => ({
        id: attachment.filePath,
        label: tuiAttachmentLabel(
          attachment,
          index + (this.options.attachmentPlaceholderOffset?.() ?? 0),
        ),
      })),
    );
  }
}
