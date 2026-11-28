import type { TuiAttachment } from '../../../application/invocation.js';
import {
  copyTuiAttachmentToTemporaryLease,
  TuiClipboardImageError,
  type TuiClipboardImageLease,
} from '../../../host/clipboard-image.js';
import type { TuiTextClipboardReader } from '../../../host/clipboard-text.js';
import { createTuiPastedTextLease } from '../../../host/pasted-text-attachment.js';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

export type ClipboardImageReader = (signal?: AbortSignal) => Promise<TuiClipboardImageLease>;

export interface ClipboardImagePasteCallbacks {
  isStopped(): boolean;
  onHint(message: string | undefined): void;
  onPasted(attachment: TuiAttachment): boolean;
  onTextPasted(text: string): void;
  onWarning(message: string): void;
  onRender(): void;
}

export class ClipboardImageDraft {
  private readonly pendingDisposals = new Map<string, () => Promise<void>>();
  private readonly queuedDisposals = new Map<string, Array<() => Promise<void>>>();
  private activeRead?: AbortController;

  constructor(
    private readonly readClipboardImage?: ClipboardImageReader,
    private readonly readClipboardText?: TuiTextClipboardReader,
    private readonly prepareQueueLease?: (
      attachment: TuiAttachment,
    ) => Promise<TuiClipboardImageLease | undefined>,
    private readonly draftRecoveryDataDir?: string,
    private readonly createPastedTextLease?: (text: string) => Promise<TuiClipboardImageLease>,
  ) {}

  async paste(callbacks: ClipboardImagePasteCallbacks): Promise<void> {
    if (!this.readClipboardImage && !this.readClipboardText) {
      callbacks.onWarning(
        'Clipboard paste is unavailable in this host. Save media and reference it in the prompt with @.',
      );
      return;
    }
    if (this.activeRead) return;

    const controller = new AbortController();
    this.activeRead = controller;
    callbacks.onHint('Reading clipboard…');
    try {
      let imageError: unknown;
      if (this.readClipboardImage) {
        try {
          const lease = await this.readClipboardImage(controller.signal);
          if (callbacks.isStopped() || controller.signal.aborted) {
            await lease.dispose().catch(() => undefined);
            return;
          }
          if (callbacks.onPasted(lease.attachment)) {
            this.pendingDisposals.set(lease.attachment.filePath, lease.dispose);
          } else {
            await lease.dispose().catch(() => undefined);
          }
          return;
        } catch (error) {
          imageError = error;
        }
      }

      const text = await this.readClipboardText?.().catch(() => null);
      if (callbacks.isStopped() || controller.signal.aborted) return;
      if (text) {
        callbacks.onTextPasted(text);
        return;
      }
      if (imageError && shouldReportClipboardImageError(imageError)) {
        callbacks.onWarning(
          formatTuiActionFailure(imageError, {
            summary: "Couldn't paste media from the clipboard.",
            nextStep: 'Copy the image or video file again, or attach the saved file with @.',
          }),
        );
      }
    } finally {
      if (this.activeRead === controller) this.activeRead = undefined;
      callbacks.onHint(undefined);
      callbacks.onRender();
    }
  }

  abortRead(): boolean {
    if (!this.activeRead) return false;
    this.activeRead.abort();
    return true;
  }

  /**
   * Saves a long paste as a text file attachment. `onPasted` returning false releases the
   * file. A write failure rejects so the caller can keep the text inline instead.
   */
  async attachPastedText(
    text: string,
    onPasted: (attachment: TuiAttachment) => boolean,
  ): Promise<boolean> {
    const lease = await (this.createPastedTextLease ?? createTuiPastedTextLease)(text);
    if (onPasted(lease.attachment)) {
      this.pendingDisposals.set(lease.attachment.filePath, lease.dispose);
      return true;
    }
    await lease.dispose().catch(() => undefined);
    return false;
  }

  transferToQueue(itemId: string, attachments: readonly TuiAttachment[]): void {
    const disposals = this.take(attachments);
    if (disposals.length > 0) this.append(this.queuedDisposals, itemId, disposals);
  }

  async prepareAttachmentsForQueue(
    attachments: readonly TuiAttachment[],
  ): Promise<TuiAttachment[]> {
    const prepareQueueLease =
      this.prepareQueueLease ??
      (this.draftRecoveryDataDir
        ? createDraftRecoveryQueueLeaseFactory(this.draftRecoveryDataDir)
        : undefined);
    if (!prepareQueueLease) return attachments.map((attachment) => ({ ...attachment }));
    const prepared: TuiAttachment[] = [];
    const created: TuiClipboardImageLease[] = [];
    try {
      for (const attachment of attachments) {
        if (this.pendingDisposals.has(attachment.filePath)) {
          prepared.push({ ...attachment });
          continue;
        }
        const lease = await prepareQueueLease(attachment);
        if (!lease) {
          prepared.push({ ...attachment });
          continue;
        }
        created.push(lease);
        this.pendingDisposals.set(lease.attachment.filePath, lease.dispose);
        prepared.push({ ...lease.attachment });
      }
      return prepared;
    } catch (error) {
      for (const lease of created) this.pendingDisposals.delete(lease.attachment.filePath);
      await release(created.map((lease) => lease.dispose));
      throw error;
    }
  }

  async releasePreparedQueueAttachments(
    original: readonly TuiAttachment[],
    prepared: readonly TuiAttachment[],
  ): Promise<void> {
    const originalPaths = new Set(original.map((attachment) => attachment.filePath));
    await this.releaseAttachments(
      prepared.filter((attachment) => !originalPaths.has(attachment.filePath)),
    );
  }

  async releaseAttachments(attachments: readonly TuiAttachment[]): Promise<void> {
    await release(this.take(attachments));
  }

  async releaseQueueItem(itemId: string): Promise<void> {
    const disposals = this.queuedDisposals.get(itemId);
    if (!disposals) return;
    this.queuedDisposals.delete(itemId);
    await release(disposals);
  }

  restoreQueueItem(itemId: string, attachments: readonly TuiAttachment[]): void {
    const disposals = this.queuedDisposals.get(itemId);
    if (!disposals) return;
    this.queuedDisposals.delete(itemId);
    for (const [index, attachment] of attachments.entries()) {
      const dispose = disposals[index];
      if (dispose) this.pendingDisposals.set(attachment.filePath, dispose);
    }
  }

  private take(attachments: readonly TuiAttachment[]): Array<() => Promise<void>> {
    const disposals: Array<() => Promise<void>> = [];
    for (const attachment of attachments) {
      const dispose = this.pendingDisposals.get(attachment.filePath);
      if (!dispose) continue;
      this.pendingDisposals.delete(attachment.filePath);
      disposals.push(dispose);
    }
    return disposals;
  }

  private append(
    target: Map<string, Array<() => Promise<void>>>,
    id: string,
    disposals: readonly (() => Promise<void>)[],
  ): void {
    target.set(id, [...(target.get(id) ?? []), ...disposals]);
  }
}

function shouldReportClipboardImageError(error: unknown): boolean {
  return !(error instanceof TuiClipboardImageError && error.code === 'no-image');
}

function createDraftRecoveryQueueLeaseFactory(dataDir: string) {
  return async (attachment: TuiAttachment) =>
    isDraftRecoveryAssetPath(dataDir, attachment.filePath) || isDetachedClipboardMedia(attachment)
      ? copyTuiAttachmentToTemporaryLease(attachment)
      : undefined;
}

function isDraftRecoveryAssetPath(dataDir: string, filePath: string): boolean {
  const draftsDirectory = resolve(dataDir, 'v2', 'mcode', 'drafts');
  const pathFromDrafts = relative(draftsDirectory, resolve(filePath));
  if (!pathFromDrafts || pathFromDrafts.startsWith('..') || isAbsolute(pathFromDrafts))
    return false;
  return pathFromDrafts.split(/[\\/]/u).some((part) => part.endsWith('.assets'));
}

function isDetachedClipboardMedia(attachment: TuiAttachment): boolean {
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

async function release(disposals: readonly (() => Promise<void>)[]): Promise<void> {
  await Promise.allSettled(disposals.map((dispose) => dispose()));
}
