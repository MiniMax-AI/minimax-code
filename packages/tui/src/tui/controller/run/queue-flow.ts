import { decodePluginMentions, encodePluginMentions, transformPluginMentions } from '../../widgets/editor/plugin-mentions.js';
import type {
  TuiModelSelection,
  TuiQueuePort,
  TuiQueuedMessage,
  TuiPausedQueueSendIntent,
} from '../../../runtime/port.js';
import type { TuiTransportAttachment } from '../../../types/invocation.js';
import type { TuiComposerDraft, TuiComposerDraftSnapshot } from '../../features/composer/draft.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import type { TuiFollowUpPanel, TuiFollowUpPanelItem } from '../../shell/follow-up-panel.js';
import type { TuiInteractionSurface } from '../../shell/interaction-surface.js';
import { TuiQueuePanel, type TuiQueuePanelItem } from '../../features/queue/panel.js';
import { isPendingQueueStatus, type TuiRunProjection } from '../../state/run-projection.js';
import { TuiPausedQueueSendPanel } from '../../features/queue/paused-send-panel.js';
import type { TranscriptStore } from '../../transcript/store.js';
import type { TranscriptAttachment } from '../../transcript/model.js';
import type { TuiChatController } from '../chat-controller.js';
import {
  formatTuiHistorySubmission,
  toTuiTranscriptAttachments,
} from '../../features/composer/attachments.js';
import type { TuiSubmissionSnapshot } from '../../features/composer/submission.js';
import {
  rebuildSessionMutationTransport,
  visibleSessionMutationContent,
} from '../../features/session-mutation/transport.js';

export interface TuiQueueFlowOptions {
  readonly runtime: TuiQueuePort;
  readonly controller: TuiChatController;
  readonly composerDraft: TuiComposerDraft;
  readonly runProjection: TuiRunProjection;
  readonly transcript: TranscriptStore;
  readonly followUp: TuiFollowUpPanel;
  readonly surface: TuiInteractionSurface;
  readonly enabled: boolean;
  readonly setHint: (message: string | undefined) => void;
  readonly onChanged: () => void;
  readonly requestRender: () => void;
  readonly selectedModel?: () => TuiModelSelection | undefined;
  readonly adoptRuntimeTurn?: (sessionId: string, turnId: string, acceptedAtMs: number) => void;
  readonly isStopped?: () => boolean;
  readonly onSubmissionQueued?: (
    itemId: string,
    sessionId: string,
    clientIntent: TuiSubmissionSnapshot['clientIntent'],
    submissionId: string,
  ) => void;
  readonly onSubmissionRestored?: (
    sessionId: string,
    clientIntent: NonNullable<TuiSubmissionSnapshot['clientIntent']>,
  ) => void;
  readonly restoreSubmission?: (submission: TuiSubmissionSnapshot) => void;
}

export class TuiQueueFlow {
  private refreshSequence = 0;
  private steeringNext = false;
  private manager?: TuiQueuePanel;
  private continuing = false;
  private cancelPausedSend?: () => void;
  private readonly queuedSubmissions = new Map<string, TuiSubmissionSnapshot>();
  private readonly queuedTransportContents = new Map<string, string>();
  private readonly protectedQueueItemIds = new Set<string>();
  private readonly pendingAdmissions = new Map<string, TuiFollowUpPanelItem>();

  constructor(private readonly options: TuiQueueFlowOptions) {}

  updatePanel(): void {
    if (this.isStopped()) return;
    const items = this.options.enabled ? this.options.runProjection.snapshot().queuedItems : [];
    const { queuePaused, queuePendingCount } = this.options.runProjection.snapshot();
    const summary = { paused: queuePaused, pendingCount: queuePendingCount };
    const queuedItems = items.filter(
      (item) => isPendingQueueStatus(item.status) && isUserManageableQueueItem(item),
    );
    this.options.followUp.setQueueSummary(summary);
    this.options.followUp.setItems([
      ...queuedItems.map(toFollowUpPanelItem),
      ...this.pendingAdmissions.values(),
    ]);
    this.manager?.setItems(queuedItems.map(toQueuePanelItem));
    this.manager?.setQueueSummary(summary);
  }

  beginAdmission(admissionId: string, content: string, attachmentNames: readonly string[]): void {
    if (!this.options.enabled || this.isStopped()) return;
    this.pendingAdmissions.set(admissionId, {
      itemId: admissionId,
      status: 'queued',
      content,
      attachmentNames,
    });
    this.updatePanel();
    this.options.onChanged();
    this.options.requestRender();
  }

  cancelAdmission(admissionId: string): void {
    if (!this.pendingAdmissions.delete(admissionId)) return;
    this.updatePanel();
    this.options.onChanged();
    this.options.requestRender();
  }

  openManager(initialItemId?: string): void {
    if (!this.options.enabled || this.isStopped()) return;
    const queuedItems = this.options.runProjection
      .snapshot()
      .queuedItems.filter(
        (item) => isPendingQueueStatus(item.status) && isUserManageableQueueItem(item),
      );
    const panelItems = queuedItems.map(toQueuePanelItem);
    const initial = initialItemId ?? panelItems.at(-1)?.itemId;
    const manager = new TuiQueuePanel({
      items: panelItems,
      summary: {
        paused: this.options.runProjection.snapshot().queuePaused,
        pendingCount: this.options.runProjection.snapshot().queuePendingCount,
      },
      onContinue: () => this.continueQueue(),
      ...(initial ? { initialItemId: initial } : {}),
      onUpdate: (itemId, content) => this.updateContent(itemId, content),
      onDelete: (itemId) => this.deleteItem(itemId),
      ...(this.options.restoreSubmission
        ? { onRestore: (itemId: string) => this.restoreItem(itemId) }
        : {}),
      onRetry: async () => false,
      onCancel: () => {
        if (this.options.surface.close(manager)) this.manager = undefined;
      },
      requestRender: this.options.requestRender,
    });
    this.manager = manager;
    this.options.surface.show(manager);
  }

  project(item: TuiQueuedMessage): void {
    if (!this.options.enabled || this.isStopped()) return;
    const projectedItem = this.withLocalDisplayContent(item);
    if (!isUserManageableQueueItem(projectedItem)) {
      this.protectedQueueItemIds.add(projectedItem.itemId);
      this.options.runProjection.updateQueueItem({ ...projectedItem, status: 'cancelled' });
      this.options.transcript.remove(`queue:${projectedItem.itemId}`);
      this.updatePanel();
      this.options.requestRender();
      return;
    }
    this.refreshSequence += 1;
    const now = Date.now();
    const existing = this.options.transcript.get(`queue:${projectedItem.itemId}`);
    const content =
      existing && projectedItem.content === undefined && projectedItem.attachments === undefined
        ? existing.content
        : formatQueuedSubmission(projectedItem);
    const attachments =
      projectedItem.attachments === undefined
        ? existing?.attachments
        : toQueuedTranscriptAttachments(projectedItem.attachments);

    if (
      projectedItem.status === 'running' ||
      projectedItem.status === 'completed' ||
      projectedItem.status === 'injected'
    ) {
      this.options.transcript.upsert({
        id: `queue:${projectedItem.itemId}`,
        kind: 'user',
        status: 'succeeded',
        content,
        ...(attachments?.length ? { attachments } : {}),
        createdAtMs:
          existing?.createdAtMs ??
          (typeof projectedItem.createdAt === 'number' ? projectedItem.createdAt : now),
        updatedAtMs: now,
      });
    } else {
      this.options.transcript.remove(`queue:${projectedItem.itemId}`);
    }
    this.updatePanel();
    this.options.requestRender();
  }

  reset(): void {
    this.cancelPausedSend?.();
    this.refreshSequence += 1;
    this.protectedQueueItemIds.clear();
    this.pendingAdmissions.clear();
    this.queuedSubmissions.clear();
    this.queuedTransportContents.clear();
    this.options.runProjection.reset();
    this.updatePanel();
    this.options.onChanged();
    this.options.requestRender();
  }

  async refresh(sessionId?: string): Promise<TuiQueuedMessage[]> {
    if (!this.options.enabled || this.isStopped()) return [];
    const targetSessionId = sessionId ?? this.options.controller.snapshot().session?.sessionId;
    if (!targetSessionId) {
      this.reset();
      return [];
    }
    const refreshSequence = ++this.refreshSequence;
    const summary = await this.options.runtime.getQueueSnapshot(targetSessionId);
    const runtimeItems = summary.items;
    for (const item of runtimeItems) {
      if (!isUserManageableQueueItem(item)) this.protectedQueueItemIds.add(item.itemId);
    }
    const items = runtimeItems
      .filter(isUserManageableQueueItem)
      .map((item) => this.withLocalDisplayContent(item));
    if (
      this.isStopped() ||
      refreshSequence !== this.refreshSequence ||
      this.options.controller.snapshot().session?.sessionId !== targetSessionId
    ) {
      return items;
    }
    this.options.runProjection.replaceQueue(items, summary);
    this.updatePanel();
    for (const item of items) this.project(item);
    this.options.onChanged();
    return items;
  }

  async continueQueue(): Promise<boolean> {
    const chat = this.options.controller.snapshot();
    const sessionId = chat.session?.sessionId;
    if (
      !sessionId ||
      !this.options.enabled ||
      this.isStopped() ||
      this.continuing ||
      chat.activeTurnId ||
      chat.retiringTurnId
    )
      return false;
    this.continuing = true;
    try {
      await this.refresh(sessionId);
      if (
        this.isStopped() ||
        this.options.controller.snapshot().session?.sessionId !== sessionId ||
        !this.options.runProjection.snapshot().queuePaused
      )
        return false;
      await this.options.controller.requireLoginForAgentAction();
      if (this.isStopped() || this.options.controller.snapshot().session?.sessionId !== sessionId)
        return false;
      await this.options.runtime.continueQueue(sessionId);
      return true;
    } finally {
      this.continuing = false;
      await this.refresh(sessionId).catch(() => undefined);
    }
  }

  async requestPausedSendDecision(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<TuiPausedQueueSendIntent | 'cancel'> {
    await this.refresh(sessionId);
    if (
      this.isStopped() ||
      signal?.aborted ||
      this.options.controller.snapshot().session?.sessionId !== sessionId
    )
      return 'cancel';
    if (!this.options.runProjection.snapshot().queuePaused) return 'paused-queue-keep';
    this.cancelPausedSend?.();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: TuiPausedQueueSendIntent | 'cancel') => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        this.cancelPausedSend = undefined;
        this.options.surface.close(panel);
        resolve(
          this.options.controller.snapshot().session?.sessionId === sessionId ? decision : 'cancel',
        );
      };
      const cancel = () => finish('cancel');
      const panel = new TuiPausedQueueSendPanel({
        pendingCount: this.options.runProjection.snapshot().queuePendingCount,
        onDecision: finish,
        requestRender: this.options.requestRender,
      });
      this.cancelPausedSend = cancel;
      signal?.addEventListener('abort', cancel, { once: true });
      this.options.surface.show(panel);
    });
  }

  private withLocalDisplayContent(item: TuiQueuedMessage): TuiQueuedMessage {
    const submission = this.queuedSubmissions.get(item.itemId);
    const rememberedTransport = this.queuedTransportContents.get(item.itemId);
    const transportContent =
      item.reviewRequest && item.content?.trim() === '/review'
        ? (submission?.transportContent ?? rememberedTransport)
        : (item.content ?? submission?.transportContent ?? rememberedTransport);
    if (!transportContent) return item;
    const decoded = decodePluginMentions(visibleSessionMutationContent(transportContent));
    if (decoded.mentions.length) {
      this.queuedTransportContents.set(item.itemId, transportContent);
      return { ...item, content: decoded.text };
    }
    if (rememberedTransport && decodePluginMentions(visibleSessionMutationContent(rememberedTransport)).text === item.content) return item;
    if (item.reviewRequest) {
      this.queuedTransportContents.set(item.itemId, transportContent);
      return { ...item, content: '/review' };
    }
    const visibleContent = submission?.content ?? visibleSessionMutationContent(transportContent);
    const rebuilt = rebuildSessionMutationTransport(transportContent, visibleContent);
    if (!rebuilt) {
      if (
        !rememberedTransport ||
        visibleSessionMutationContent(rememberedTransport) !== transportContent.trim()
      ) {
        this.queuedTransportContents.delete(item.itemId);
      }
      return item;
    }
    this.queuedTransportContents.set(item.itemId, transportContent);
    return { ...item, content: visibleContent };
  }

  async enqueue(
    content: string,
    draft: TuiComposerDraftSnapshot,
    submission?: TuiSubmissionSnapshot,
    admissionId?: string,
  ): Promise<string | undefined> {
    return this.enqueueSnapshot(
      content,
      draft,
      submission ? { snapshot: submission } : undefined,
      admissionId,
    );
  }

  takeOverFailedQueueItem(itemId: string): TuiSubmissionSnapshot | undefined {
    const cached = this.options.runProjection.findQueueItem(itemId);
    const captured = this.queuedSubmissions.get(itemId);
    if (!cached && !captured) return undefined;
    const snapshot =
      captured ??
      (cached
        ? createSubmissionFromQueuedMessage(
            cached,
            `queue:${itemId}`,
            this.queuedTransportContents.get(itemId),
          )
        : undefined);
    if (!snapshot) return undefined;
    if (snapshot.clientIntent && snapshot.sessionId) {
      this.options.onSubmissionRestored?.(snapshot.sessionId, snapshot.clientIntent);
    }
    this.options.composerDraft.restoreQueuedSubmission(itemId, {
      attachments: snapshot.attachments,
    });
    this.queuedSubmissions.delete(itemId);
    this.queuedTransportContents.delete(itemId);
    if (cached) this.options.runProjection.updateQueueItem({ ...cached, status: 'completed' });
    this.updatePanel();
    this.options.onChanged();
    this.options.requestRender();
    return snapshot;
  }

  private async enqueueSnapshot(
    content: string,
    draft: TuiComposerDraftSnapshot,
    transfer?: { snapshot: TuiSubmissionSnapshot },
    admissionId?: string,
  ): Promise<string | undefined> {
    if (!this.options.enabled || this.isStopped()) return;
    const model = this.options.selectedModel?.();
    const session = await this.options.controller.waitForCurrentSession();
    if (transfer?.snapshot.sessionId && transfer.snapshot.sessionId !== session.sessionId) {
      throw new Error('The active Session changed before this message could enter the queue.');
    }
    const queuedDraft = this.options.composerDraft.prepareQueueSubmission
      ? await this.options.composerDraft.prepareQueueSubmission(draft)
      : draft;
    const attachments = queuedDraft.attachments;
    const transportAttachments = relocateTransportAttachments(
      transfer?.snapshot.transportAttachments ?? transfer?.snapshot.attachments ?? attachments,
      draft.attachments,
      attachments,
    );
    const transportContent = transfer?.snapshot.transportContent ?? content;
    let result: Awaited<ReturnType<TuiQueuePort['enqueueMessage']>>;
    try {
      result = await this.options.runtime.enqueueMessage(session.sessionId, transportContent, {
        attachments: transportAttachments,
        ...(model ? { model } : {}),
        ...(transfer?.snapshot.clientIntent
          ? { clientIntent: transfer.snapshot.clientIntent }
          : {}),
        ...(transfer?.snapshot.reviewRequest
          ? { reviewRequest: transfer.snapshot.reviewRequest }
          : {}),
      });
      if (!result.itemId) throw new Error('Runtime did not return a queue item id.');
    } catch (error) {
      await this.options.composerDraft.releasePreparedQueueSubmission?.(draft, queuedDraft);
      throw error;
    }
    const sourceSnapshot =
      transfer?.snapshot ??
      createSubmissionForQueue(result.itemId, session.sessionId, content, queuedDraft);
    const snapshot = bindSubmissionToSession(
      sourceSnapshot,
      session.sessionId,
      draft.attachments,
      attachments,
    );
    this.options.onSubmissionQueued?.(
      result.itemId,
      session.sessionId,
      snapshot.clientIntent,
      snapshot.submissionId,
    );
    this.queuedSubmissions.set(result.itemId, snapshot);
    if (snapshot.transportContent) {
      this.queuedTransportContents.set(result.itemId, snapshot.transportContent);
    }
    this.options.composerDraft.completeQueuedSubmission(draft, result.itemId, queuedDraft);
    if (this.isStopped()) return;
    if (this.options.controller.snapshot().session?.sessionId !== session.sessionId) return;
    const item: TuiQueuedMessage = {
      itemId: result.itemId,
      sessionId: session.sessionId,
      status: result.status ?? 'queued',
      content,
      ...(snapshot.reviewRequest ? { reviewRequest: snapshot.reviewRequest } : {}),
      attachments: transportAttachments.map((attachment) => ({
        meta: {
          attachmentType: attachment.type,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        },
        local: {
          ...(attachment.filePath ? { filePath: attachment.filePath } : {}),
          ...(attachment.assetId ? { assetId: attachment.assetId } : {}),
        },
      })),
      createdAt: Date.now(),
    };
    if (admissionId) this.pendingAdmissions.delete(admissionId);
    this.options.runProjection.recordEnqueued(item, result.position);
    this.updatePanel();
    this.options.onChanged();
    void this.refresh(session.sessionId).catch(() => undefined);
    return result.itemId;
  }

  async cancelLatest(): Promise<boolean> {
    if (!this.options.enabled || this.isStopped()) return false;
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    const latest = this.options.runProjection
      .snapshot()
      .queuedItems.filter(
        (item) => isPendingQueueStatus(item.status) && isUserManageableQueueItem(item),
      )
      .at(-1);
    if (!sessionId || !latest) {
      this.options.setHint('No waiting message to remove.');
      this.options.onChanged();
      this.options.requestRender();
      return false;
    }

    return this.deleteItem(latest.itemId);
  }

  async restoreLatest(): Promise<TuiSubmissionSnapshot | undefined> {
    if (!this.options.enabled || this.isStopped()) return;
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    const latest = this.options.runProjection
      .snapshot()
      .queuedItems.filter(
        (item) => isPendingQueueStatus(item.status) && isUserManageableQueueItem(item),
      )
      .at(-1);
    if (!sessionId || !latest || latest.sessionId !== sessionId) return;

    const snapshot =
      this.queuedSubmissions.get(latest.itemId) ??
      createSubmissionFromQueuedMessage(
        latest,
        `queue:${latest.itemId}`,
        this.queuedTransportContents.get(latest.itemId),
      );
    const removed = await this.options.runtime.deleteQueuedMessage(sessionId, latest.itemId);
    if (!removed) {
      await this.refresh(sessionId);
      return;
    }
    if (this.isStopped() || this.options.controller.snapshot().session?.sessionId !== sessionId) {
      await this.options.composerDraft.releaseQueueItem(latest.itemId);
      this.queuedSubmissions.delete(latest.itemId);
      this.queuedTransportContents.delete(latest.itemId);
      return;
    }

    if (snapshot.clientIntent) {
      this.options.onSubmissionRestored?.(sessionId, snapshot.clientIntent);
    }
    this.options.composerDraft.restoreQueuedSubmission(latest.itemId, {
      attachments: snapshot.attachments,
    });
    this.queuedSubmissions.delete(latest.itemId);
    this.queuedTransportContents.delete(latest.itemId);
    this.options.transcript.remove(`queue:${latest.itemId}`);
    this.options.runProjection.updateQueueItem({ ...latest, status: 'cancelled' });
    this.updatePanel();
    this.options.onChanged();
    this.options.requestRender();
    void this.refresh(sessionId).catch(() => undefined);
    return snapshot;
  }

  async steerNext(): Promise<boolean> {
    if (!this.options.enabled || this.isStopped() || this.steeringNext) return false;
    const next = this.options.runProjection
      .snapshot()
      .queuedItems.find(
        (item) => isPendingQueueStatus(item.status) && isUserManageableQueueItem(item),
      );
    if (!next) return false;
    if (next.attachments?.length) {
      this.options.setHint('Steer accepts text only. Attachments will run next.');
      this.options.onChanged();
      this.options.requestRender();
      return false;
    }
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    if (!sessionId || next.sessionId !== sessionId) return false;

    this.steeringNext = true;
    try {
      let receipt: Awaited<ReturnType<TuiQueuePort['steerQueuedMessage']>>;
      try {
        receipt = await this.options.runtime.steerQueuedMessage(sessionId, next.itemId);
      } catch (error) {
        await this.refresh(sessionId).catch(() => undefined);
        throw error;
      }
      if (
        !this.isStopped() &&
        this.options.controller.snapshot().session?.sessionId === sessionId
      ) {
        this.options.adoptRuntimeTurn?.(sessionId, receipt.turnId, Date.now());
        this.options.runProjection.updateQueueItem({ ...next, status: 'running' });
        this.updatePanel();
        this.options.onChanged();
        void this.refresh(sessionId).catch(() => undefined);
      }
      return true;
    } finally {
      this.steeringNext = false;
      this.options.requestRender();
    }
  }

  async updateContent(itemId: string, content: string): Promise<boolean> {
    if (!this.options.enabled || this.isStopped()) return false;
    const cached = this.options.runProjection.findQueueItem(itemId);
    if (this.protectedQueueItemIds.has(itemId) || (cached && !isUserManageableQueueItem(cached))) {
      return false;
    }
    if (cached?.reviewRequest) {
      this.options.setHint('Review commands cannot be edited in the Queue.');
      this.options.onChanged();
      this.options.requestRender();
      return false;
    }
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    if (!sessionId) return false;
    const previousTransport = this.queuedTransportContents.get(itemId);
    const previous = decodePluginMentions(visibleSessionMutationContent(previousTransport ?? cached?.content));
    const mentions = transformPluginMentions(previous.text, content, previous.mentions);
    const boundContent = encodePluginMentions(content, mentions);
    const transportContent = rebuildSessionMutationTransport(previousTransport, boundContent) ?? boundContent;
    const updated = await this.options.runtime.updateQueuedMessageContent(
      sessionId,
      itemId,
      transportContent,
    );
    if (this.isStopped()) return Boolean(updated);
    if (this.options.controller.snapshot().session?.sessionId !== sessionId) return false;
    if (!updated) {
      await this.refresh(sessionId);
      return false;
    }
    if (transportContent !== content) this.queuedTransportContents.set(itemId, transportContent);
    else this.queuedTransportContents.delete(itemId);
    const captured = this.queuedSubmissions.get(itemId);
    if (captured) {
      this.queuedSubmissions.set(itemId, {
        ...captured,
        editor: {
          schemaVersion: 1,
          text: content,
          cursor: content.length,
          pluginMentions: mentions,
          pastes: [],
          pasteCounter: 0,
        },
        content,
        ...(captured.transportContent ? { transportContent } : {}),
      });
    }
    this.options.runProjection.updateQueueItem(this.withLocalDisplayContent(updated));
    await this.refresh(sessionId);
    this.options.onChanged();
    return true;
  }

  async deleteItem(itemId: string): Promise<boolean> {
    if (!this.options.enabled || this.isStopped()) return false;
    const cached = this.options.runProjection.findQueueItem(itemId);
    if (this.protectedQueueItemIds.has(itemId) || (cached && !isUserManageableQueueItem(cached))) {
      return false;
    }
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    if (!sessionId) return false;
    const removed = await this.options.runtime.deleteQueuedMessage(sessionId, itemId);
    if (this.isStopped()) {
      if (removed) await this.options.composerDraft.releaseQueueItem(itemId);
      return Boolean(removed);
    }
    if (this.options.controller.snapshot().session?.sessionId !== sessionId) {
      if (removed) await this.options.composerDraft.releaseQueueItem(itemId);
      return Boolean(removed);
    }
    if (!removed) {
      await this.refresh(sessionId);
      return false;
    }

    await this.options.composerDraft.releaseQueueItem(itemId);
    this.queuedSubmissions.delete(itemId);
    this.queuedTransportContents.delete(itemId);
    this.options.transcript.remove(`queue:${itemId}`);
    await this.refresh(sessionId);
    this.options.onChanged();
    this.options.requestRender();
    return true;
  }

  async restoreItem(itemId: string): Promise<boolean> {
    if (!this.options.enabled || this.isStopped() || !this.options.restoreSubmission) return false;
    const cached = this.options.runProjection.findQueueItem(itemId);
    if (!cached || this.protectedQueueItemIds.has(itemId) || !isUserManageableQueueItem(cached)) {
      return false;
    }
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    if (!sessionId || cached.sessionId !== sessionId) return false;
    const captured = this.queuedSubmissions.get(itemId);
    const transportContent = this.queuedTransportContents.get(itemId);
    const snapshot =
      captured ?? createSubmissionFromQueuedMessage(cached, `queue:${itemId}`, transportContent);

    const removed = await this.options.runtime.deleteQueuedMessage(sessionId, itemId);
    if (this.isStopped() || this.options.controller.snapshot().session?.sessionId !== sessionId) {
      if (removed) await this.options.composerDraft.releaseQueueItem(itemId);
      return Boolean(removed);
    }
    if (!removed) {
      await this.refresh(sessionId);
      return false;
    }

    if (snapshot.clientIntent) {
      this.options.onSubmissionRestored?.(sessionId, snapshot.clientIntent);
    }
    this.options.composerDraft.restoreQueuedSubmission(itemId, {
      attachments: snapshot.attachments,
    });
    this.queuedSubmissions.delete(itemId);
    this.queuedTransportContents.delete(itemId);
    this.options.runProjection.updateQueueItem({ ...cached, status: 'cancelled' });
    this.options.transcript.remove(`queue:${itemId}`);
    this.updatePanel();
    this.options.restoreSubmission(snapshot);
    this.options.setHint('Message restored to Composer.');
    this.options.onChanged();
    this.options.requestRender();
    void this.refresh(sessionId).catch(() => undefined);
    return true;
  }

  private isStopped(): boolean {
    return Boolean(this.options.isStopped?.());
  }

  async releaseQueuedSubmission(itemId: string): Promise<void> {
    this.queuedSubmissions.delete(itemId);
    this.queuedTransportContents.delete(itemId);
    await this.options.composerDraft.releaseQueueItem(itemId);
  }
}

function isUserManageableQueueItem(item: Pick<TuiQueuedMessage, 'source'>): boolean {
  return item.source !== 'thread-goal';
}

function formatQueuedSubmission(item: TuiQueuedMessage): string {
  return formatTuiHistorySubmission(
    item.content ?? '',
    (item.attachments ?? []).map((attachment) => ({
      fileName: sanitizeTerminalText(
        attachment.meta?.fileName ?? attachment.local?.filePath ?? 'attachment',
      ),
      mimeType: sanitizeTerminalText(attachment.meta?.mimeType ?? 'application/octet-stream'),
      ...(attachment.meta?.sizeBytes !== undefined ? { sizeBytes: attachment.meta.sizeBytes } : {}),
    })),
  );
}

function toQueuedTranscriptAttachments(
  attachments: readonly NonNullable<TuiQueuedMessage['attachments']>[number][],
): TranscriptAttachment[] {
  return toTuiTranscriptAttachments(
    attachments.map((attachment) => {
      const mimeType = attachment.meta?.mimeType ?? 'application/octet-stream';
      const previewUrl = attachment.previewUrl ?? attachment.cloud?.url;
      return {
        type:
          attachment.meta?.attachmentType === 'image' || mimeType.startsWith('image/')
            ? ('image' as const)
            : ('file' as const),
        fileName: attachment.meta?.fileName ?? attachment.local?.filePath ?? 'attachment',
        mimeType,
        ...(attachment.meta?.sizeBytes !== undefined
          ? { sizeBytes: attachment.meta.sizeBytes }
          : {}),
        ...(attachment.local?.filePath ? { filePath: attachment.local.filePath } : {}),
        ...(attachment.local?.assetId ? { assetId: attachment.local.assetId } : {}),
        ...(previewUrl ? { previewUrl } : {}),
      };
    }),
  );
}

function toFollowUpPanelItem(item: TuiQueuedMessage): TuiFollowUpPanelItem {
  return {
    itemId: item.itemId,
    status: item.status,
    content: item.content ?? '',
    attachmentNames:
      item.attachments?.map((attachment) =>
        sanitizeTerminalText(
          attachment.meta?.fileName ?? attachment.local?.filePath ?? 'attachment',
        ),
      ) ?? [],
    ...(item.failedReason ? { failedReason: sanitizeTerminalText(item.failedReason) } : {}),
  };
}

function toQueuePanelItem(item: TuiQueuedMessage): TuiQueuePanelItem {
  return {
    itemId: item.itemId,
    status: item.status === 'paused' ? 'paused' : 'queued',
    content: item.content ?? '',
    attachmentNames:
      item.attachments?.map((attachment) =>
        sanitizeTerminalText(
          attachment.meta?.fileName ?? attachment.local?.filePath ?? 'attachment',
        ),
      ) ?? [],
  };
}

function createSubmissionForQueue(
  submissionId: string,
  sessionId: string,
  content: string,
  draft: TuiComposerDraftSnapshot,
): TuiSubmissionSnapshot {
  return {
    submissionId,
    sessionId,
    editor: {
      schemaVersion: 1,
      text: content,
      cursor: content.length,
      pastes: [],
      pasteCounter: 0,
    },
    content,
    attachments: draft.attachments,
    createdAtMs: Date.now(),
  };
}

function createSubmissionFromQueuedMessage(
  item: TuiQueuedMessage,
  submissionId: string,
  transportContent?: string,
): TuiSubmissionSnapshot {
  const decoded = decodePluginMentions(visibleSessionMutationContent(transportContent ?? item.content));
  const content = decoded.text;
  const transportAttachments = (item.attachments ?? []).flatMap<TuiTransportAttachment>(
    (attachment) => {
      const filePath = attachment.local?.filePath;
      const assetId = attachment.local?.assetId;
      if (!filePath && !assetId) return [];
      const metadata = {
        type: attachment.meta?.attachmentType === 'image' ? ('image' as const) : ('file' as const),
        fileName: attachment.meta?.fileName ?? filePath ?? assetId ?? 'attachment',
        mimeType: attachment.meta?.mimeType ?? 'application/octet-stream',
        ...(attachment.meta?.sizeBytes !== undefined
          ? { sizeBytes: attachment.meta.sizeBytes }
          : {}),
      };
      if (filePath) return [{ ...metadata, filePath, ...(assetId ? { assetId } : {}) }];
      return assetId ? [{ ...metadata, assetId }] : [];
    },
  );
  return {
    submissionId,
    sessionId: item.sessionId,
    editor: {
      schemaVersion: 1,
      text: content,
      pluginMentions: decoded.mentions,
      cursor: content.length,
      pastes: [],
      pasteCounter: 0,
    },
    content,
    ...(transportContent || decoded.mentions.length ? { transportContent: transportContent ?? item.content } : {}),
    attachments: (item.attachments ?? []).flatMap((attachment) => {
      const filePath = attachment.local?.filePath;
      if (!filePath) return [];
      return [
        {
          type:
            attachment.meta?.attachmentType === 'image' ? ('image' as const) : ('file' as const),
          filePath,
          fileName: attachment.meta?.fileName ?? filePath,
          mimeType: attachment.meta?.mimeType ?? 'application/octet-stream',
          sizeBytes: attachment.meta?.sizeBytes ?? 0,
        },
      ];
    }),
    ...(transportAttachments.length > 0 ? { transportAttachments } : {}),
    ...(item.reviewRequest ? { reviewRequest: item.reviewRequest } : {}),
    createdAtMs: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
  };
}

function bindSubmissionToSession(
  snapshot: TuiSubmissionSnapshot,
  sessionId: string,
  originalAttachments: readonly TuiSubmissionSnapshot['attachments'][number][],
  queuedAttachments: readonly TuiSubmissionSnapshot['attachments'][number][],
): TuiSubmissionSnapshot {
  const relocatedPaths = new Map<string, string>();
  originalAttachments.forEach((attachment, index) => {
    const queued = queuedAttachments[index];
    if (queued && queued.filePath !== attachment.filePath) {
      relocatedPaths.set(attachment.filePath, queued.filePath);
    }
  });
  return {
    ...snapshot,
    sessionId,
    editor:
      relocatedPaths.size === 0 || !snapshot.editor.attachmentPlaceholders
        ? snapshot.editor
        : {
            ...snapshot.editor,
            attachmentPlaceholders: snapshot.editor.attachmentPlaceholders.map((placeholder) => ({
              ...placeholder,
              id: relocatedPaths.get(placeholder.id) ?? placeholder.id,
            })),
          },
    attachments: queuedAttachments.map((attachment) => ({ ...attachment })),
    ...(snapshot.transportAttachments
      ? {
          transportAttachments: relocateTransportAttachments(
            snapshot.transportAttachments,
            originalAttachments,
            queuedAttachments,
          ),
        }
      : {}),
  };
}

function relocateTransportAttachments(
  transportAttachments: readonly NonNullable<
    TuiSubmissionSnapshot['transportAttachments']
  >[number][],
  originalAttachments: readonly TuiSubmissionSnapshot['attachments'][number][],
  queuedAttachments: readonly TuiSubmissionSnapshot['attachments'][number][],
) {
  const relocatedPaths = new Map<string, string>();
  originalAttachments.forEach((attachment, index) => {
    const queued = queuedAttachments[index];
    if (queued && queued.filePath !== attachment.filePath) {
      relocatedPaths.set(attachment.filePath, queued.filePath);
    }
  });
  return transportAttachments.map((attachment) => {
    const relocatedPath = attachment.filePath ? relocatedPaths.get(attachment.filePath) : undefined;
    return { ...attachment, ...(relocatedPath ? { filePath: relocatedPath } : {}) };
  });
}
