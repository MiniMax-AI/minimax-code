import { submittedEditorTransport } from '../../widgets/editor/editor.js';
import type { TuiChatController } from '../chat-controller.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { matchesKey } from '../../engine/public.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
} from '../../theme/runtime.js';
import type { TuiSessionFlow } from '../session-flow.js';
import type {
  TuiFeatureScreen,
  TuiFeatureScreenHandle,
  TuiSurfaceHost,
} from '../../shell/surface-host.js';
import type { Editor, EditorDraftSnapshot } from '../../widgets/editor/editor.js';
import { tuiAttachmentLabel } from '../../features/composer/attachments.js';
import {
  TUI_SESSION_MUTATION_HISTORY_PICKER_SCREEN_ID,
  TuiSessionMutationHistoryPicker,
  type TuiSessionMutationMode,
} from '../../features/session-mutation/history-picker.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import { TuiSessionMutationRewindPreviewPanel } from '../../features/session-mutation/rewind-preview-panel.js';
import { TuiSessionMutationScopePicker } from '../../features/session-mutation/scope-picker.js';
import {
  TuiSessionHistoryExplorer,
  type TuiSessionHistoryAction,
} from '../../features/session-mutation/history-explorer.js';
import {
  sessionHistoryText,
  sessionMutationTemplate,
  sessionMutationText,
} from '../../features/session-mutation/copy.js';
import {
  formatPromptHead,
  summarizeFileChangeCount,
} from '../../features/session-mutation/format.js';
import {
  rebuildSessionMutationTransport,
  visibleSessionMutationContent,
} from '../../features/session-mutation/transport.js';
import type {
  TuiRewindPreview,
  TuiRewindResult,
  TuiRewindScope,
  TuiEditMessageAttachment,
  TuiMessage,
  TuiSessionForkOptions,
  TuiSessionForkPort,
  TuiSessionForkResult,
  TuiSessionInputSummary,
  TuiSessionPort,
} from '../../../runtime/port.js';

const DEFAULT_MUTATION_SUMMARY_LIMIT = 100;

export interface TuiSessionMutationFlowOptions {
  readonly runtime: Pick<
    TuiSessionPort,
    | 'listSessionInputSummaries'
    | 'listMessagePage'
    | 'getSessionRewindPreview'
    | 'rewindSession'
    | 'editSessionMessage'
  > &
    Partial<TuiSessionForkPort>;
  readonly controller: TuiChatController;
  readonly sessionFlow: Pick<TuiSessionFlow, 'activateSessionById'>;
  readonly refreshProjection?: (sessionId: string) => Promise<void>;
  readonly reloadSessionProjection: (sessionId: string) => Promise<void>;
  readonly surfaceHost: TuiSurfaceHost;
  readonly editor: Editor;
  readonly setHint: (message: string | undefined) => void;
  readonly append: (content: string, kind?: 'final-summary' | 'warning' | 'error') => void;
  readonly setEditTranscriptBoundary?: (sourceMessageId: string | undefined) => void;
  readonly onChanged: () => void;
  readonly hasLiveRun: () => boolean;
  readonly nowMs?: () => number;
  /**
   * Generates the per-invocation operation id. Defaults to a UUID-shaped
   * string. The id is held by the flow for the duration of one invocation
   * and reused only if a runtime result returns a retryable persisted id.
   */
  readonly createOperationId?: () => string;
}

export interface TuiEditResubmitRequest {
  readonly kind: 'resubmit';
  readonly transportContent: string;
  readonly attachments?: readonly TuiEditMessageAttachment[];
}

interface TuiSessionMutationRewindInvocation {
  readonly mode: 'rewind';
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly operationId: string;
  readonly token: number;
  readonly screenHandle?: TuiFeatureScreenHandle;
  readonly picker?: TuiSessionMutationHistoryPicker;
  readonly previewPanel?: TuiSessionMutationRewindPreviewPanel;
  readonly scopePicker?: TuiSessionMutationScopePicker;
  readonly confirmation?: TuiSessionMutationRewindConfirmation;
  readonly selectedSummary?: TuiSessionInputSummary;
  readonly preview?: TuiRewindPreview;
  readonly scope?: TuiRewindScope;
  readonly affectedTurnCount?: number;
  readonly phase:
    | 'loading'
    | 'picking'
    | 'preview-loading'
    | 'preview'
    | 'scope'
    | 'confirming'
    | 'rewinding';
}

interface TuiSessionMutationForkInvocation {
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly mode: 'fork';
  readonly operationId: string;
  readonly token: number;
  readonly screenHandle: TuiFeatureScreenHandle | undefined;
  readonly picker?: TuiSessionMutationHistoryPicker;
  readonly confirmation?: TuiSessionMutationForkConfirmation;
  readonly selectedSummary?: TuiSessionInputSummary;
  readonly forkOptions?: TuiSessionForkOptions;
  readonly phase: 'loading' | 'picking' | 'options' | 'confirming' | 'forking';
}

interface TuiSessionMutationEditInvocation {
  readonly mode: 'edit';
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly operationId: string;
  readonly token: number;
  readonly screenHandle?: TuiFeatureScreenHandle;
  readonly previewPanel?: TuiSessionMutationRewindPreviewPanel;
  readonly preview?: TuiRewindPreview;
  readonly selectedSummary?: TuiSessionInputSummary;
  readonly targetMessage?: TuiMessage;
  readonly affectedTurnCount?: number;
  readonly phase:
    | 'loading'
    | 'preview-loading'
    | 'preview'
    | 'target-loading'
    | 'editing'
    | 'submitting'
    | 'resubmit'
    | 'resubmitting';
}

type TuiSessionMutationInvocation =
  | TuiSessionMutationForkInvocation
  | TuiSessionMutationRewindInvocation
  | TuiSessionMutationEditInvocation;

export class TuiSessionMutationFlow {
  private mutationScreen: TuiFeatureScreenHandle | undefined;
  private historyScreen: TuiFeatureScreenHandle | undefined;
  private historyExplorer: TuiSessionHistoryExplorer | undefined;
  private historySourceSessionId: string | undefined;
  private historyLoadSequence = 0;
  private mutationSequence = 0;
  private readonly invocations = new Map<number, TuiSessionMutationInvocation>();

  constructor(private readonly options: TuiSessionMutationFlowOptions) {}

  /**
   * Public entry point for `/fork`. Captures the source session id immediately
   * and dispatches the async load/pick/fork pipeline.
   */
  startFork(): void {
    if (this.options.hasLiveRun()) {
      // Preserve the command draft so the user does not lose the typed command
      // while a turn is running. The mutation pipeline must not run.
      this.options.editor.setText('/fork');
      this.options.surfaceHost.setChatFocus(this.options.editor);
      this.options.setHint(sessionMutationText('sessionMutation.hint.forkRunning'));
      this.options.onChanged();
      return;
    }
    const snapshot = this.options.controller.snapshot();
    const sourceSessionId = snapshot.session?.sessionId;
    if (!sourceSessionId) {
      this.options.setHint(sessionMutationText('sessionMutation.hint.forkNoSession'));
      this.options.onChanged();
      return;
    }
    this.options.setHint(sessionMutationText('sessionMutation.hint.loadingFork'));
    this.options.onChanged();
    this.beginInvocation('fork', sourceSessionId);
  }

  /** Public entry point for `/rewind`. */
  startRewind(): void {
    if (this.options.hasLiveRun()) {
      this.options.editor.setText('/rewind');
      this.options.surfaceHost.setChatFocus(this.options.editor);
      this.options.setHint(sessionMutationText('sessionMutation.error.busy'));
      this.options.onChanged();
      return;
    }
    const sourceSessionId = this.options.controller.snapshot().session?.sessionId;
    if (!sourceSessionId) {
      this.options.setHint(sessionMutationText('sessionMutation.hint.rewindNoSession'));
      this.options.onChanged();
      return;
    }
    this.options.setHint(sessionMutationText('sessionMutation.hint.loadingRewind'));
    this.options.onChanged();
    this.beginInvocation('rewind', sourceSessionId);
  }

  /** Public entry point for `/edit`. Editing rewinds and resubmits through the desktop contract. */
  startEdit(): void {
    if (this.options.hasLiveRun()) {
      this.options.editor.setText('/edit');
      this.options.surfaceHost.setChatFocus(this.options.editor);
      this.options.setHint(sessionMutationText('sessionMutation.hint.editRunning'));
      this.options.onChanged();
      return;
    }
    const sourceSessionId = this.options.controller.snapshot().session?.sessionId;
    if (!sourceSessionId) {
      this.options.setHint(sessionMutationText('sessionMutation.hint.editNoSession'));
      this.options.onChanged();
      return;
    }
    this.options.setHint(sessionMutationText('sessionMutation.hint.loadingEdit'));
    this.options.onChanged();
    this.beginInvocation('edit', sourceSessionId);
  }

  /** Browse persisted user-message boundaries without introducing a second Session model. */
  startHistory(): void {
    const session = this.options.controller.snapshot().session;
    if (!session) {
      this.options.setHint(sessionHistoryText('noSession'));
      this.options.onChanged();
      return;
    }
    this.closeHistoryScreen();
    const sourceSessionId = session.sessionId;
    this.historySourceSessionId = sourceSessionId;
    let handle: TuiFeatureScreenHandle | undefined;
    const mutationAvailable = !this.options.hasLiveRun();
    let load = (): void => undefined;
    const explorer = new TuiSessionHistoryExplorer({
      ...(session.title ? { sessionTitle: session.title } : {}),
      summaries: [],
      loading: true,
      mutationAvailable,
      ...(!mutationAvailable
        ? {
            mutationUnavailableReason: sessionHistoryText('running'),
          }
        : {}),
      onAction: (action, summary, affectedTurnCount) =>
        this.startHistoryAction(action, summary, affectedTurnCount),
      onRetryLoad: () => load(),
      onCancel: () => {
        const current = this.invocations.get(this.mutationSequence);
        if (current?.sourceSessionId === sourceSessionId) {
          this.invalidateMutation(current.sequence);
        }
        if (handle?.close()) this.clearHistoryScreen(handle);
      },
      requestRender: this.options.onChanged,
      ...(this.options.nowMs ? { nowMs: this.options.nowMs() } : {}),
    });
    load = () => {
      const loadSequence = ++this.historyLoadSequence;
      this.historySourceSessionId = sourceSessionId;
      void this.options.runtime
        .listSessionInputSummaries(sourceSessionId, { limit: DEFAULT_MUTATION_SUMMARY_LIMIT })
        .then((summaries) => {
          if (
            loadSequence !== this.historyLoadSequence ||
            this.options.controller.snapshot().session?.sessionId !== sourceSessionId
          ) {
            return;
          }
          explorer.setSummaries(summaries);
        })
        .catch((error: unknown) => {
          if (loadSequence !== this.historyLoadSequence) return;
          explorer.setLoadError(
            formatTuiActionFailure(error, {
              summary: sessionMutationText('sessionMutation.error.loadHistory'),
              nextStep: 'Press Enter to retry.',
              preservation: sessionMutationText('sessionMutation.error.sessionUnchanged'),
            }),
          );
        });
    };
    handle = this.options.surfaceHost.pushFeature({ screen: explorer, focus: explorer });
    this.historyExplorer = explorer;
    this.historyScreen = handle;
    this.options.onChanged();
    load();
  }

  isEditing(): boolean {
    const invocation = this.getEditInvocation(this.mutationSequence);
    return (
      invocation?.phase === 'editing' ||
      invocation?.phase === 'submitting' ||
      invocation?.phase === 'resubmit'
    );
  }

  private editAttachmentEntries(requireCurrent = true) {
    const invocation = this.getEditInvocation(this.mutationSequence);
    if (!invocation || (requireCurrent && !this.isCurrentMutation(invocation))) return [];
    return (mergeEditAttachments(invocation.targetMessage?.attachments ?? [], []) ?? []).map(
      (attachment, index) => ({
        attachment,
        id: `edit:${invocation.sourceSessionId}:${invocation.targetMessage?.id}:${index}`,
        label: tuiAttachmentLabel(attachment, index),
      }),
    );
  }

  editAttachmentCount(): number {
    return this.retainedEditAttachments().length;
  }

  retainedEditAttachments(draft?: EditorDraftSnapshot) {
    const entries = this.editAttachmentEntries();
    if (entries.length === 0) return [];
    const ids = new Set(
      (draft ?? this.options.editor.captureDraft()).attachmentPlaceholders?.map(({ id }) => id),
    );
    return entries
      .filter(({ id }) => ids.has(id))
      .map(({ attachment, id }, index) => ({
        ...attachment,
        id,
        label: tuiAttachmentLabel(attachment, index),
      }));
  }

  private clearEditAttachmentPlaceholders(): void {
    const ids = new Set(this.editAttachmentEntries(false).map(({ id }) => id));
    if (ids.size === 0) return;
    this.options.editor.syncAttachmentPlaceholders(
      (this.options.editor.captureDraft().attachmentPlaceholders ?? []).filter(
        ({ id }) => !ids.has(id),
      ),
    );
  }

  cancelActiveEdit(): boolean {
    const invocation = this.getEditInvocation(this.mutationSequence);
    if (!invocation || (invocation.phase !== 'editing' && invocation.phase !== 'resubmit')) {
      return false;
    }
    this.clearEditAttachmentPlaceholders();
    this.options.editor.setText('');
    this.options.setHint(undefined);
    this.options.setEditTranscriptBoundary?.(undefined);
    this.invocations.delete(invocation.sequence);
    this.options.onChanged();
    return true;
  }

  settleEditResubmit(completed: boolean): void {
    const invocation = this.getEditInvocation(this.mutationSequence);
    if (!invocation || invocation.phase !== 'resubmitting') return;
    if (completed) {
      this.options.setEditTranscriptBoundary?.(undefined);
      this.invocations.delete(invocation.sequence);
      this.options.setHint(undefined);
    } else {
      this.invocations.set(invocation.sequence, { ...invocation, phase: 'resubmit' });
      this.options.setHint(sessionMutationText('sessionMutation.hint.editResubmit'));
    }
    this.options.onChanged();
  }

  async submitEdit(
    content: string,
    attachments: readonly TuiEditMessageAttachment[] = [],
    draft?: EditorDraftSnapshot,
  ): Promise<'consumed' | 'retained' | TuiEditResubmitRequest | undefined> {
    const invocation = this.getEditInvocation(this.mutationSequence);
    if (invocation?.phase === 'submitting') return 'retained';
    if (
      !invocation ||
      (invocation.phase !== 'editing' && invocation.phase !== 'resubmit') ||
      !invocation.selectedSummary
    ) {
      return undefined;
    }
    if (!this.isCurrentMutation(invocation)) {
      this.invalidateMutation(invocation.sequence);
      return 'retained';
    }
    if (this.options.hasLiveRun()) {
      this.options.setHint(sessionHistoryText('running'));
      this.options.onChanged();
      return 'retained';
    }
    const mergedAttachments = mergeEditAttachments(
      this.retainedEditAttachments(draft),
      attachments,
    );
    if (!content.trim()) {
      this.options.setHint(sessionMutationText('sessionMutation.hint.editing'));
      this.options.onChanged();
      return 'retained';
    }
    const boundContent = draft ? submittedEditorTransport(draft) ?? content : content;
    const transportContent =
      rebuildSessionMutationTransport(
        invocation.targetMessage?.editContent ?? invocation.targetMessage?.content,
        boundContent,
      ) ?? boundContent;
    if (invocation.phase === 'resubmit') {
      this.invocations.set(invocation.sequence, { ...invocation, phase: 'resubmitting' });
      this.options.setHint(sessionMutationText('sessionMutation.hint.editSubmitting'));
      this.options.onChanged();
      return {
        kind: 'resubmit',
        transportContent,
        ...(mergedAttachments ? { attachments: mergedAttachments } : {}),
      };
    }
    const previousDurationId = this.options.controller.getTerminalDurationId();
    this.invocations.set(invocation.sequence, { ...invocation, phase: 'submitting' });
    this.options.setHint(sessionMutationText('sessionMutation.hint.editSubmitting'));
    this.options.onChanged();
    try {
      await this.options.runtime.editSessionMessage({
        sessionId: invocation.sourceSessionId,
        userMessageId: invocation.selectedSummary.userMessageId,
        clientRequestId: invocation.operationId,
        content: transportContent,
        attachments: mergedAttachments,
        rewindTurnDiff: true,
      });
    } catch (error) {
      const current = this.getEditInvocation(invocation.sequence);
      if (!current || !this.isCurrentMutation(current)) {
        this.invalidateMutation(invocation.sequence);
        return 'retained';
      }
      const code = rewindErrorCode(error);
      if (
        code === 'EDIT_RESTART_NEEDS_RESUBMIT' ||
        code === 'EDIT_SUBMIT_FAILED_AFTER_REWIND' ||
        code === 'REWIND_DISPLAY_COMMIT_FAILED'
      ) {
        this.options.controller.dismissTerminalDuration(previousDurationId);
      }
      if (code === 'EDIT_RESTART_NEEDS_NEW_OPERATION') {
        this.invocations.set(invocation.sequence, {
          ...current,
          operationId: this.createOperationId('edit', current.operationId),
          phase: 'editing',
        });
        this.options.setHint(sessionMutationText('sessionMutation.hint.editing'));
        this.options.onChanged();
        this.options.append(
          sessionMutationText('sessionMutation.error.editNeedsNewOperation'),
          'warning',
        );
        return 'retained';
      }
      if (code === 'EDIT_RESTART_NEEDS_RESUBMIT') {
        this.invocations.set(invocation.sequence, { ...current, phase: 'resubmit' });
        this.options.setHint(sessionMutationText('sessionMutation.hint.editResubmit'));
        this.options.onChanged();
        this.options.append(
          sessionMutationText('sessionMutation.error.editNeedsResubmit'),
          'warning',
        );
        return 'retained';
      }
      this.invocations.set(invocation.sequence, { ...current, phase: 'editing' });
      this.options.setHint(sessionMutationText('sessionMutation.hint.editing'));
      this.options.onChanged();
      this.options.append(
        code === 'EDIT_SUBMIT_FAILED_AFTER_REWIND'
          ? sessionMutationText('sessionMutation.error.editSubmitAfterRewind')
          : editFailureCopy(error),
        'warning',
      );
      return 'retained';
    }
    // Edit bypasses normal submit. Discard only the captured footer on success,
    // before history refresh can expose it; a new run may already have finished.
    if (this.isCurrentMutation(invocation)) {
      this.options.controller.dismissTerminalDuration(previousDurationId);
    }
    try {
      await this.options.refreshProjection?.(invocation.sourceSessionId);
    } catch {
      if (this.isCurrentMutation(invocation)) {
        this.options.append(sessionMutationText('sessionMutation.error.editRefresh'), 'warning');
      }
    }
    const current = this.getEditInvocation(invocation.sequence);
    if (!current || !this.isCurrentMutation(current)) return 'consumed';
    this.options.setEditTranscriptBoundary?.(undefined);
    this.invocations.delete(invocation.sequence);
    this.options.setHint(undefined);
    this.options.onChanged();
    return 'consumed';
  }

  isRewindPickerActive(): boolean {
    return Boolean(this.mutationScreen?.isActive());
  }

  private async loadEditHistoryPreview(
    sequence: number,
    summary: TuiSessionInputSummary,
  ): Promise<void> {
    const invocation = this.getEditInvocation(sequence);
    if (!invocation || !this.isCurrentMutation(invocation)) return;
    this.invocations.set(sequence, {
      ...invocation,
      selectedSummary: summary,
      phase: 'preview-loading',
    });
    try {
      const preview = await this.options.runtime.getSessionRewindPreview({
        sessionId: invocation.sourceSessionId,
        userMessageId: summary.userMessageId,
      });
      const current = this.getEditInvocation(sequence);
      if (!current || !this.isCurrentMutation(current)) return this.invalidateMutation(sequence);
      this.historyExplorer?.restoreAfterAction();
      const panel = new TuiSessionMutationRewindPreviewPanel({
        preview,
        heading: sessionHistoryText('editPreviewHeading'),
        target: mutationTarget(summary),
        impact: mutationImpact(current.affectedTurnCount, summary.fileChangeCount),
        continueHint: sessionMutationText('sessionMutation.preview.editHint'),
        requestRender: this.options.onChanged,
        onCancel: () => this.invalidateMutation(sequence),
        onContinue: () => {
          const selected = this.getEditInvocation(sequence);
          if (!selected?.selectedSummary || !this.isCurrentMutation(selected)) return;
          this.historyExplorer?.setBusy(true, sessionHistoryText('preparingTarget'));
          this.closeMutationScreen();
          this.invocations.set(sequence, { ...selected, phase: 'loading' });
          void this.loadEditTarget(sequence, selected.selectedSummary);
        },
      });
      const handle = this.options.surfaceHost.pushFeature({ screen: panel, focus: panel });
      this.mutationScreen = handle;
      this.invocations.set(sequence, {
        ...current,
        preview,
        previewPanel: panel,
        screenHandle: handle,
        phase: 'preview',
      });
    } catch (error) {
      const current = this.getEditInvocation(sequence);
      if (!current || !this.isCurrentMutation(current)) return this.invalidateMutation(sequence);
      this.invocations.delete(sequence);
      this.historyExplorer?.restoreAfterAction(
        formatTuiActionFailure(error, {
          summary: sessionMutationText('sessionMutation.error.loadPreview'),
          nextStep: sessionMutationText('sessionMutation.error.chooseAgain'),
          preservation: sessionMutationText('sessionMutation.error.sessionUnchanged'),
        }),
      );
    }
  }

  private async loadEditSummaries(sequence: number): Promise<void> {
    const invocation = this.getEditInvocation(sequence);
    if (!invocation || !this.isCurrentMutation(invocation)) return;
    try {
      const summaries = await this.options.runtime.listSessionInputSummaries(
        invocation.sourceSessionId,
        { limit: DEFAULT_MUTATION_SUMMARY_LIMIT },
      );
      if (!this.isCurrentMutation(invocation)) return this.invalidateMutation(sequence);
      const latest = latestSessionInputSummary(summaries);
      if (!latest) {
        this.invalidateMutation(sequence);
        this.options.setHint(sessionMutationText('sessionMutation.history.empty'));
        this.options.onChanged();
        return;
      }
      void this.loadEditTarget(sequence, latest);
    } catch (error) {
      if (!this.isCurrentMutation(invocation)) return this.invalidateMutation(sequence);
      this.invalidateMutation(sequence);
      this.options.append(
        formatTuiActionFailure(error, {
          summary: sessionMutationText('sessionMutation.error.loadHistory'),
          nextStep: sessionMutationText('sessionMutation.error.retryEdit'),
          preservation: sessionMutationText('sessionMutation.error.sessionUnchanged'),
        }),
        'warning',
      );
    }
  }

  private async loadEditTarget(sequence: number, summary: TuiSessionInputSummary): Promise<void> {
    const invocation = this.getEditInvocation(sequence);
    if (!invocation || invocation.phase !== 'loading' || !this.isCurrentMutation(invocation)) {
      return this.invalidateMutation(sequence);
    }
    this.invocations.set(sequence, {
      ...invocation,
      selectedSummary: summary,
      phase: 'target-loading',
    });
    try {
      const targetMessage = await this.findMessage(
        invocation.sourceSessionId,
        summary.userMessageId,
      );
      const current = this.getEditInvocation(sequence);
      if (!current || !this.isCurrentMutation(current)) return this.invalidateMutation(sequence);
      if (!targetMessage || targetMessage.role !== 'user') {
        throw new Error('The selected committed user message could not be loaded.');
      }
      this.beginEditing(sequence, current, targetMessage);
    } catch (error) {
      const current = this.getEditInvocation(sequence);
      if (!current || !this.isCurrentMutation(current)) return this.invalidateMutation(sequence);
      const failure = formatTuiActionFailure(error, {
        summary: sessionMutationText('sessionMutation.error.loadPreview'),
        nextStep: sessionMutationText('sessionMutation.error.retryEdit'),
        preservation: sessionMutationText('sessionMutation.error.sessionUnchanged'),
      });
      this.invalidateMutation(sequence);
      if (this.historyExplorer) this.historyExplorer.restoreAfterAction(failure);
      else this.options.append(failure, 'warning');
    }
  }

  private beginEditing(
    sequence: number,
    invocation: TuiSessionMutationEditInvocation,
    targetMessage: TuiMessage,
  ): void {
    if (invocation.phase !== 'target-loading' || !this.isCurrentMutation(invocation)) {
      return this.invalidateMutation(sequence);
    }
    if (this.options.hasLiveRun()) {
      const running = sessionHistoryText('running');
      this.invalidateMutation(sequence);
      if (this.historyExplorer) this.historyExplorer.restoreAfterAction(running);
      else this.options.append(running, 'warning');
      return;
    }
    this.closeMutationScreen();
    this.closeHistoryScreen();
    this.options.setEditTranscriptBoundary?.(targetMessage.id);
    this.invocations.set(sequence, { ...invocation, targetMessage, phase: 'editing' });
    const content = visibleSessionMutationContent(
      targetMessage.editContent ?? targetMessage.content,
    );
    const placeholders = this.editAttachmentEntries();
    if (placeholders.length > 0) this.options.editor.restoreMessageDraft(content, placeholders);
    else this.options.editor.setText(content);
    this.options.surfaceHost.setChatFocus(this.options.editor);
    this.options.setHint(sessionMutationText('sessionMutation.hint.editing'));
    this.options.onChanged();
  }

  private async findMessage(sessionId: string, messageId: string): Promise<TuiMessage | undefined> {
    let before: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.options.runtime.listMessagePage(sessionId, {
        limit: DEFAULT_MUTATION_SUMMARY_LIMIT,
        ...(before ? { before } : {}),
      });
      const target = page.messages.find((message) => message.id === messageId);
      if (target) return target;
      if (!page.hasMore || !page.nextCursor || seen.has(page.nextCursor)) return undefined;
      seen.add(page.nextCursor);
      before = page.nextCursor;
    } while (before);
    return undefined;
  }

  private async loadRewindSummaries(sequence: number): Promise<void> {
    const invocation = this.getRewindInvocation(sequence);
    if (!invocation || !this.isCurrentMutation(invocation)) return;
    try {
      const summaries = await this.options.runtime.listSessionInputSummaries(
        invocation.sourceSessionId,
        { limit: DEFAULT_MUTATION_SUMMARY_LIMIT },
      );
      if (!this.isCurrentMutation(invocation)) return this.invalidateMutation(sequence);
      this.openRewindPicker(sequence, summaries);
    } catch (error) {
      if (!this.isCurrentMutation(invocation)) return this.invalidateMutation(sequence);
      this.invalidateMutation(sequence);
      this.options.append(
        formatTuiActionFailure(error, {
          summary: sessionMutationText('sessionMutation.error.loadHistory'),
          nextStep: sessionMutationText('sessionMutation.error.retryRewind'),
          preservation: sessionMutationText('sessionMutation.error.sessionUnchanged'),
        }),
        'warning',
      );
    }
  }

  private openRewindPicker(sequence: number, summaries: readonly TuiSessionInputSummary[]): void {
    const invocation = this.getRewindInvocation(sequence);
    if (!invocation || !this.isCurrentMutation(invocation)) return;
    this.closeMutationScreen();
    const picker = new TuiSessionMutationHistoryPicker({
      summaries,
      mode: 'rewind',
      onSelect: (summary) => void this.loadRewindPreview(sequence, summary),
      onCancel: () => this.cancelRewind(sequence),
      requestRender: this.options.onChanged,
      ...(this.options.nowMs ? { nowMs: this.options.nowMs() } : {}),
    });
    this.options.setHint(undefined);
    this.options.onChanged();
    const handle = this.options.surfaceHost.pushFeature({ screen: picker, focus: picker });
    this.mutationScreen = handle;
    this.invocations.set(sequence, {
      ...invocation,
      picker,
      screenHandle: handle,
      phase: 'picking',
    });
  }

  private async loadRewindPreview(
    sequence: number,
    summary: TuiSessionInputSummary,
  ): Promise<void> {
    const invocation = this.getRewindInvocation(sequence);
    if (!invocation || invocation.phase !== 'picking' || !this.isCurrentMutation(invocation))
      return this.invalidateMutation(sequence);
    this.invocations.set(sequence, {
      ...invocation,
      selectedSummary: summary,
      phase: 'preview-loading',
    });
    try {
      const preview = await this.options.runtime.getSessionRewindPreview({
        sessionId: invocation.sourceSessionId,
        userMessageId: summary.userMessageId,
      });
      const current = this.getRewindInvocation(sequence);
      if (!current || !this.isCurrentMutation(current)) return this.invalidateMutation(sequence);
      this.historyExplorer?.restoreAfterAction();
      this.openRewindPreview(sequence, current, preview);
    } catch (error) {
      const current = this.getRewindInvocation(sequence);
      if (!current || !this.isCurrentMutation(current)) return this.invalidateMutation(sequence);
      const failure = formatTuiActionFailure(error, {
        summary: sessionMutationText('sessionMutation.error.loadPreview'),
        nextStep: sessionMutationText('sessionMutation.error.chooseAgain'),
        preservation: sessionMutationText('sessionMutation.error.sessionUnchanged'),
      });
      if (this.historyExplorer) {
        this.invocations.delete(sequence);
        this.historyExplorer.restoreAfterAction(failure);
        return;
      }
      current.picker?.resetSelection(failure);
      this.invocations.set(sequence, { ...current, phase: 'picking' });
      this.options.append(failure, 'warning');
    }
  }

  private openRewindPreview(
    sequence: number,
    invocation: TuiSessionMutationRewindInvocation,
    preview: TuiRewindPreview,
  ): void {
    this.closeMutationScreen();
    const panel = new TuiSessionMutationRewindPreviewPanel({
      preview,
      ...(invocation.selectedSummary
        ? {
            target: mutationTarget(invocation.selectedSummary),
            impact: mutationImpact(
              invocation.affectedTurnCount ?? preview.turns.length,
              invocation.selectedSummary.fileChangeCount,
            ),
          }
        : {}),
      continueHint:
        invocation.scope === 'conversation_and_files'
          ? sessionMutationText('sessionMutation.preview.confirmRewindHint')
          : sessionMutationText('sessionMutation.preview.rewindHint'),
      requestRender: this.options.onChanged,
      onCancel: () => this.cancelRewind(sequence),
      onContinue: () => this.continueRewindAfterPreview(sequence),
    });
    const handle = this.options.surfaceHost.pushFeature({ screen: panel, focus: panel });
    this.mutationScreen = handle;
    this.invocations.set(sequence, {
      ...invocation,
      preview,
      previewPanel: panel,
      screenHandle: handle,
      phase: 'preview',
    });
  }

  private continueRewindAfterPreview(sequence: number): void {
    const invocation = this.getRewindInvocation(sequence);
    if (
      invocation?.phase === 'confirming' &&
      invocation.scope === 'conversation_and_files' &&
      this.historyExplorer &&
      this.isCurrentMutation(invocation)
    ) {
      void this.confirmRewind(sequence, invocation.scope);
      return;
    }
    if (
      !invocation ||
      invocation.phase !== 'preview' ||
      !invocation.preview ||
      !this.isCurrentMutation(invocation)
    ) {
      return this.invalidateMutation(sequence);
    }
    if (invocation.scope) {
      if (invocation.scope === 'conversation_and_files' && this.historyExplorer) {
        this.invocations.set(sequence, { ...invocation, phase: 'confirming' });
        void this.confirmRewind(sequence, invocation.scope);
      } else {
        this.openRewindConfirmation(sequence, invocation, invocation.scope);
      }
      return;
    }
    this.openRewindScope(sequence);
  }

  private openRewindScope(sequence: number): void {
    const invocation = this.getRewindInvocation(sequence);
    if (!invocation || !invocation.preview || !this.isCurrentMutation(invocation))
      return this.invalidateMutation(sequence);
    this.closeMutationScreen();
    const picker = new TuiSessionMutationScopePicker({
      onSelect: (scope) => this.handleRewindScope(sequence, scope),
      onCancel: () => this.cancelRewind(sequence),
      requestRender: this.options.onChanged,
    });
    const handle = this.options.surfaceHost.pushFeature({ screen: picker, focus: picker });
    this.mutationScreen = handle;
    this.invocations.set(sequence, {
      ...invocation,
      scopePicker: picker,
      screenHandle: handle,
      phase: 'scope',
    });
  }

  private handleRewindScope(sequence: number, scope: TuiRewindScope): void {
    const invocation = this.getRewindInvocation(sequence);
    if (!invocation || invocation.phase !== 'scope' || !this.isCurrentMutation(invocation))
      return this.invalidateMutation(sequence);
    this.openRewindConfirmation(sequence, invocation, scope);
  }

  private openRewindConfirmation(
    sequence: number,
    invocation: TuiSessionMutationRewindInvocation,
    scope: TuiRewindScope,
  ): void {
    if (scope === 'conversation_and_files' && !invocation.preview) {
      return this.invalidateMutation(sequence);
    }
    this.closeMutationScreen();
    const confirmation = new TuiSessionMutationRewindConfirmation({
      preview: invocation.preview,
      summary: invocation.selectedSummary,
      affectedTurnCount: invocation.affectedTurnCount,
      scope,
      onConfirm: () => void this.confirmRewind(sequence, scope),
      onCancel: () => this.cancelRewind(sequence),
      requestRender: this.options.onChanged,
    });
    const handle = this.options.surfaceHost.pushFeature({
      screen: confirmation,
      focus: confirmation,
    });
    this.mutationScreen = handle;
    this.invocations.set(sequence, {
      ...invocation,
      scope,
      confirmation,
      screenHandle: handle,
      phase: 'confirming',
    });
  }

  private async confirmRewind(sequence: number, scope: TuiRewindScope): Promise<void> {
    const invocation = this.getRewindInvocation(sequence);
    if (!invocation || !invocation.selectedSummary || !this.isCurrentMutation(invocation)) {
      return this.invalidateMutation(sequence);
    }
    if (invocation.phase !== 'confirming') return;
    if (this.options.hasLiveRun()) {
      const running = sessionHistoryText('running');
      invocation.confirmation?.setError(running);
      invocation.previewPanel?.setError(running);
      invocation.scopePicker?.setError(running);
      this.options.onChanged();
      return;
    }
    invocation.confirmation?.setBusy(true);
    invocation.previewPanel?.setBusy(true);
    invocation.scopePicker?.setBusy(true);
    this.invocations.set(sequence, { ...invocation, scope, phase: 'rewinding' });

    let result: TuiRewindResult;
    try {
      result = await this.options.runtime.rewindSession({
        sessionId: invocation.sourceSessionId,
        userMessageId: invocation.selectedSummary.userMessageId,
        clientRequestId: invocation.operationId,
        ...(scope === 'conversation_and_files' ? { rewindTurnDiff: true } : {}),
      });
    } catch (error) {
      const current = this.getRewindInvocation(sequence);
      if (!current || !this.isCurrentMutation(current)) return this.invalidateMutation(sequence);
      current.confirmation?.setBusy(false);
      current.previewPanel?.setBusy(false);
      current.scopePicker?.setBusy(false);
      current.confirmation?.setError(rewindRetryCopy(error));
      current.previewPanel?.setError(rewindRetryCopy(error));
      current.scopePicker?.resetSelection();
      current.scopePicker?.setError(rewindRetryCopy(error));
      this.invocations.set(sequence, {
        ...current,
        ...(shouldCreateNewRewindOperation(error)
          ? { operationId: this.createOperationId('rewind', current.operationId) }
          : {}),
        phase: 'confirming',
      });
      this.options.append(rewindFailureCopy(error), 'warning');
      return;
    }

    const outcome = classifyRewindOutcome(scope, result, invocation.preview);
    try {
      await this.options.reloadSessionProjection(invocation.sourceSessionId);
    } catch {
      const current = this.getRewindInvocation(sequence);
      if (!current || !this.isCurrentMutation(current)) return this.invalidateMutation(sequence);
      this.options.append(sessionMutationText('sessionMutation.error.refresh'), 'warning');
      this.closeMutationScreen();
      this.closeHistoryScreen();
      this.invocations.delete(sequence);
      return;
    }

    const current = this.getRewindInvocation(sequence);
    if (!current || !this.isCurrentMutation(current)) return this.invalidateMutation(sequence);
    this.closeMutationScreen();
    this.closeHistoryScreen();
    this.invocations.delete(sequence);
    if (outcome) {
      this.options.append(outcome.message, outcome.kind);
    } else {
      const affected = Math.max(
        1,
        invocation.affectedTurnCount ?? invocation.preview?.turns.length ?? 1,
      );
      const turns = sessionMutationTemplate(
        affected === 1 ? 'sessionMutation.format.turn.one' : 'sessionMutation.format.turn.many',
        { count: affected },
      );
      const counts = rewindPreviewCounts(invocation.preview);
      this.options.setHint(
        scope === 'conversation'
          ? sessionMutationTemplate('sessionMutation.outcome.conversationSuccess', { turns })
          : sessionMutationTemplate('sessionMutation.outcome.filesSuccess', {
              turns,
              files: summarizeFileChangeCount(counts.ready),
            }),
      );
      this.options.onChanged();
    }
  }

  private cancelRewind(sequence: number): void {
    if (!this.invocations.has(sequence)) return;
    this.historyExplorer?.restoreAfterAction();
    this.invalidateMutation(sequence);
  }

  private closeMutationScreen(): void {
    const handle = this.mutationScreen;
    this.mutationScreen = undefined;
    handle?.close();
  }

  private closeHistoryScreen(): void {
    this.historyLoadSequence += 1;
    const handle = this.historyScreen;
    this.historyScreen = undefined;
    this.historyExplorer = undefined;
    this.historySourceSessionId = undefined;
    handle?.close();
  }

  private clearHistoryScreen(handle: TuiFeatureScreenHandle): void {
    if (this.historyScreen !== handle) return;
    this.historyLoadSequence += 1;
    this.historyScreen = undefined;
    this.historyExplorer = undefined;
    this.historySourceSessionId = undefined;
  }

  /** True while a fork picker is the active feature surface. */
  isForkPickerActive(): boolean {
    return Boolean(this.mutationScreen?.isActive());
  }

  private startHistoryAction(
    action: TuiSessionHistoryAction,
    summary: TuiSessionInputSummary,
    affectedTurnCount: number,
  ): void {
    const sourceSessionId = this.historySourceSessionId;
    if (
      !sourceSessionId ||
      this.options.controller.snapshot().session?.sessionId !== sourceSessionId
    ) {
      this.closeHistoryScreen();
      return;
    }
    if (this.options.hasLiveRun()) {
      this.historyExplorer?.restoreAfterAction(sessionHistoryText('running'));
      return;
    }

    const sequence = this.beginMutationInvocation();
    if (action === 'fork') {
      const invocation: TuiSessionMutationForkInvocation = {
        sequence,
        sourceSessionId,
        mode: 'fork',
        operationId: this.createOperationId('fork'),
        token: sequence,
        screenHandle: undefined,
        phase: 'picking',
      };
      this.invocations.set(sequence, invocation);
      void this.handleSelection(sequence, summary);
      return;
    }
    if (action === 'edit') {
      const invocation: TuiSessionMutationEditInvocation = {
        sequence,
        sourceSessionId,
        mode: 'edit',
        operationId: this.createOperationId('edit'),
        token: sequence,
        selectedSummary: summary,
        affectedTurnCount,
        phase: 'loading',
      };
      this.invocations.set(sequence, invocation);
      void this.loadEditHistoryPreview(sequence, summary);
      return;
    }
    const scope: TuiRewindScope =
      action === 'rewind-conversation' ? 'conversation' : 'conversation_and_files';
    const invocation: TuiSessionMutationRewindInvocation = {
      sequence,
      sourceSessionId,
      mode: 'rewind',
      operationId: this.createOperationId('rewind'),
      token: sequence,
      scope,
      affectedTurnCount,
      selectedSummary: summary,
      phase: 'picking',
    };
    this.invocations.set(sequence, invocation);
    if (scope === 'conversation') {
      this.openRewindConfirmation(sequence, invocation, scope);
      return;
    }
    void this.loadRewindPreview(sequence, summary);
  }

  private beginMutationInvocation(): number {
    this.closeMutationScreen();
    if ([...this.invocations.values()].some((invocation) => invocation.mode === 'edit')) {
      this.options.setEditTranscriptBoundary?.(undefined);
    }
    const sequence = ++this.mutationSequence;
    this.invocations.clear();
    return sequence;
  }

  private beginInvocation(mode: TuiSessionMutationMode, sourceSessionId: string): void {
    this.closeHistoryScreen();
    const sequence = this.beginMutationInvocation();
    const operationId = this.createOperationId(mode);
    if (mode === 'rewind') {
      this.invocations.set(sequence, {
        sequence,
        sourceSessionId,
        mode,
        operationId,
        token: sequence,
        phase: 'loading',
      });
      void this.loadRewindSummaries(sequence);
      return;
    }
    if (mode === 'edit') {
      this.invocations.set(sequence, {
        sequence,
        sourceSessionId,
        mode,
        operationId,
        token: sequence,
        phase: 'loading',
      });
      void this.loadEditSummaries(sequence);
      return;
    }
    this.invocations.set(sequence, {
      sequence,
      sourceSessionId,
      mode,
      operationId,
      token: sequence,
      screenHandle: undefined,
      phase: 'loading',
    });
    void this.loadSummaries(sequence);
  }

  private createOperationId(mode: TuiSessionMutationMode, previous?: string): string {
    const generated = this.options.createOperationId?.() ?? createDefaultOperationId();
    const operationId =
      mode === 'rewind'
        ? generated.replace('tui-fork_', 'tui-rewind_')
        : mode === 'edit'
          ? generated.replace('tui-fork_', 'tui-edit_')
          : generated;
    if (operationId !== previous) return operationId;
    const fallback = createDefaultOperationId();
    return mode === 'rewind'
      ? fallback.replace('tui-fork_', 'tui-rewind_')
      : mode === 'edit'
        ? fallback.replace('tui-fork_', 'tui-edit_')
        : fallback;
  }

  private async loadSummaries(sequence: number): Promise<void> {
    const invocation = this.getForkInvocation(sequence);
    if (!invocation) return;
    if (this.hasSessionChanged(invocation)) {
      this.invocations.delete(sequence);
      return;
    }
    let summaries: readonly TuiSessionInputSummary[];
    try {
      summaries = await this.options.runtime.listSessionInputSummaries(invocation.sourceSessionId, {
        limit: DEFAULT_MUTATION_SUMMARY_LIMIT,
      });
    } catch (error) {
      if (!this.isCurrentMutation(invocation)) {
        this.invalidateMutation(sequence);
        return;
      }
      this.invalidateMutation(sequence);
      this.options.append(
        formatTuiActionFailure(error, {
          summary: sessionMutationText('sessionMutation.error.loadHistory'),
          nextStep: sessionMutationText('sessionMutation.error.retryFork'),
          preservation: sessionMutationText('sessionMutation.error.sourceUnchanged'),
        }),
        'warning',
      );
      return;
    }
    if (!this.isCurrentMutation(invocation)) {
      this.invalidateMutation(sequence);
      return;
    }
    if (this.options.hasLiveRun()) {
      invocation.confirmation?.setError(sessionHistoryText('running'));
      this.options.onChanged();
      return;
    }
    if (summaries.length === 0) {
      this.options.setHint(sessionMutationText('sessionMutation.hint.noForkPrompts'));
      this.options.onChanged();
    }
    this.openPicker(sequence, summaries);
  }

  private openPicker(sequence: number, summaries: readonly TuiSessionInputSummary[]): void {
    const invocation = this.getForkInvocation(sequence);
    if (!invocation) return;
    this.closeMutationScreen();
    const picker = new TuiSessionMutationHistoryPicker({
      summaries,
      mode: invocation.mode,
      onSelect: (summary) => this.handleSelection(sequence, summary),
      onCancel: () => this.handleCancel(sequence),
      requestRender: this.options.onChanged,
      ...(this.options.nowMs ? { nowMs: this.options.nowMs() } : {}),
    });
    this.options.setHint(undefined);
    this.options.onChanged();
    const handle = this.options.surfaceHost.pushFeature({
      screen: picker,
      focus: picker,
    });
    this.mutationScreen = handle;
    this.invocations.set(sequence, {
      ...invocation,
      screenHandle: handle,
      picker,
      phase: 'picking',
    });
  }

  private handleCancel(sequence: number): void {
    const invocation = this.getForkInvocation(sequence);
    if (!invocation) return;
    if (this.mutationSequence === sequence) {
      this.closeMutationScreen();
    }
    this.invocations.delete(sequence);
  }

  private async handleSelection(sequence: number, summary: TuiSessionInputSummary): Promise<void> {
    const invocation = this.getForkInvocation(sequence);
    if (!invocation || invocation.phase !== 'picking') return;
    if (!this.isCurrentMutation(invocation)) {
      this.invalidateMutation(sequence);
      return;
    }
    this.invocations.set(sequence, {
      ...invocation,
      selectedSummary: summary,
      phase: 'options',
    });
    const options = await this.fetchForkOptions(sequence, invocation, summary);
    if (!options) return;
    const current = this.getForkInvocation(sequence);
    if (!current || !this.isCurrentMutation(current)) {
      this.invalidateMutation(sequence);
      return;
    }
    if (!options.canFork) {
      const unavailable = forkUnavailableMessage(options);
      if (this.historyExplorer) {
        this.invocations.delete(sequence);
        this.historyExplorer.restoreAfterAction(unavailable);
        return;
      }
      current.picker?.resetSelection(unavailable);
      this.invocations.set(sequence, { ...current, phase: 'picking' });
      this.options.append(unavailable, 'warning');
      return;
    }
    this.openConfirmation(sequence, current, summary, options);
  }

  private openConfirmation(
    sequence: number,
    invocation: TuiSessionMutationForkInvocation,
    summary: TuiSessionInputSummary,
    options: TuiSessionForkOptions,
  ): void {
    if (!this.isCurrentMutation(invocation)) {
      this.invalidateMutation(sequence);
      return;
    }
    this.historyExplorer?.restoreAfterAction();
    this.closeMutationScreen();
    const confirmation = new TuiSessionMutationForkConfirmation({
      summary,
      options,
      onConfirm: () => this.confirmFork(sequence),
      onCancel: () => this.handleCancel(sequence),
      requestRender: this.options.onChanged,
    });
    const handle = this.options.surfaceHost.pushFeature({
      screen: confirmation,
      focus: confirmation,
    });
    this.mutationScreen = handle;
    this.invocations.set(sequence, {
      ...invocation,
      screenHandle: handle,
      confirmation,
      selectedSummary: summary,
      forkOptions: options,
      phase: 'confirming',
    });
  }

  private async confirmFork(sequence: number): Promise<void> {
    const invocation = this.getForkInvocation(sequence);
    if (!invocation || invocation.phase !== 'confirming' || !invocation.selectedSummary) return;
    if (!this.isCurrentMutation(invocation)) {
      this.invalidateMutation(sequence);
      return;
    }
    this.invocations.set(sequence, { ...invocation, phase: 'forking' });
    invocation.confirmation?.setBusy(true);
    let result: TuiSessionForkResult | undefined;
    let forkError: unknown;
    try {
      result = await this.forkSession(invocation, invocation.selectedSummary);
    } catch (error) {
      forkError = error;
    }
    if (!result) {
      const current = this.getForkInvocation(sequence);
      if (!current || !this.isCurrentMutation(current)) {
        this.invalidateMutation(sequence);
        return;
      }
      this.options.append(
        formatTuiActionFailure(forkError ?? new Error('Runtime fork request failed.'), {
          summary: sessionMutationText('sessionMutation.error.forkRequest'),
          nextStep: sessionMutationText('sessionMutation.error.forkRetry'),
          preservation: sessionMutationText('sessionMutation.error.sourceUnchanged'),
        }),
        'warning',
      );
      current.confirmation?.setBusy(false);
      current.confirmation?.setError(
        rewindErrorCode(forkError)
          ? sessionMutationText('sessionMutation.error.forkRetry')
          : sessionMutationText('sessionMutation.error.forkRetrySameOperation'),
      );
      this.invocations.set(sequence, {
        ...current,
        ...(rewindErrorCode(forkError)
          ? { operationId: this.createOperationId('fork', current.operationId) }
          : {}),
        phase: 'confirming',
      });
      return;
    }
    if (!this.isCurrentMutation(invocation)) {
      this.invalidateMutation(sequence);
      return;
    }
    this.closeMutationScreen();
    this.closeHistoryScreen();
    this.invocations.delete(sequence);
    try {
      await this.options.sessionFlow.activateSessionById(result.session.sessionId);
    } catch (error) {
      this.options.append(
        formatTuiActionFailure(error, {
          summary: sessionMutationText('sessionMutation.error.activateFork'),
          nextStep: sessionMutationTemplate('sessionMutation.error.openForkManually', {
            sessionId: result.session.sessionId,
          }),
          preservation: sessionMutationText('sessionMutation.error.sourceUnchanged'),
        }),
        'warning',
      );
    }
  }

  private async fetchForkOptions(
    sequence: number,
    invocation: TuiSessionMutationForkInvocation,
    summary: TuiSessionInputSummary,
  ): Promise<TuiSessionForkOptions | undefined> {
    const getOptions = this.options.runtime.getSessionForkOptions;
    if (!getOptions) {
      this.invalidateMutation(sequence);
      const failure = sessionMutationText('sessionMutation.error.forkRequest');
      if (this.historyExplorer) this.historyExplorer.restoreAfterAction(failure);
      else this.options.append(failure, 'warning');
      return undefined;
    }
    try {
      return await getOptions.call(
        this.options.runtime,
        invocation.sourceSessionId,
        summary.assistantMessageId,
      );
    } catch (error) {
      if (this.mutationSequence !== sequence) return undefined;
      const current = this.getForkInvocation(sequence);
      if (!current || !this.isCurrentMutation(current)) {
        this.invalidateMutation(sequence);
        return undefined;
      }
      const failure = formatTuiActionFailure(error, {
        summary: sessionMutationText('sessionMutation.error.loadForkOptions'),
        nextStep: sessionMutationText('sessionMutation.error.chooseAgain'),
        preservation: sessionMutationText('sessionMutation.error.sourceUnchanged'),
      });
      if (this.historyExplorer) {
        this.invocations.delete(sequence);
        this.historyExplorer.restoreAfterAction(failure);
        return undefined;
      }
      current.picker?.resetSelection(failure);
      this.invocations.set(sequence, { ...current, phase: 'picking' });
      this.options.append(failure, 'warning');
      return undefined;
    }
  }

  private async forkSession(
    invocation: TuiSessionMutationForkInvocation,
    summary: TuiSessionInputSummary,
  ): Promise<TuiSessionForkResult | undefined> {
    const forkSession = this.options.runtime.forkSession;
    if (!forkSession) return undefined;
    return await forkSession.call(this.options.runtime, {
      sessionId: invocation.sourceSessionId,
      ...(summary.assistantMessageId ? { assistantMessageId: summary.assistantMessageId } : {}),
      clientRequestId: invocation.operationId,
      useSuggestedTitle: true,
      createIsolatedWorktree: false,
    });
  }

  /** @internal Test-only lifecycle assertion; not part of product behavior. */
  getInvocationCountForTesting(): number {
    return this.invocations.size;
  }
  /** Close any mutation surface whose captured source no longer matches the active session. */
  reconcileSession(): void {
    const current = this.invocations.get(this.mutationSequence);
    if (current && this.hasSessionChanged(current)) this.invalidateMutation(current.sequence);
    const currentSessionId = this.options.controller.snapshot().session?.sessionId;
    if (this.historySourceSessionId && this.historySourceSessionId !== currentSessionId) {
      this.closeHistoryScreen();
    }
  }

  private invalidateMutation(sequence: number): void {
    const invocation = this.invocations.get(sequence);
    if (invocation?.mode === 'edit' && sequence === this.mutationSequence) {
      this.clearEditAttachmentPlaceholders();
    }
    if (
      invocation?.mode === 'edit' &&
      (invocation.phase === 'editing' || invocation.phase === 'submitting')
    ) {
      this.options.setHint(undefined);
    }
    if (invocation?.mode === 'edit') this.options.setEditTranscriptBoundary?.(undefined);
    if (sequence === this.mutationSequence) {
      this.closeMutationScreen();
      this.options.setHint(undefined);
      this.options.onChanged();
    }
    this.invocations.delete(sequence);
  }

  private isCurrentMutation(invocation: TuiSessionMutationInvocation): boolean {
    const current = this.invocations.get(invocation.sequence);
    return (
      current?.token === invocation.token &&
      current.mode === invocation.mode &&
      invocation.sequence === this.mutationSequence &&
      !this.hasSessionChanged(invocation)
    );
  }

  private getForkInvocation(sequence: number): TuiSessionMutationForkInvocation | undefined {
    const invocation = this.invocations.get(sequence);
    return invocation?.mode === 'fork' ? invocation : undefined;
  }

  private getRewindInvocation(sequence: number): TuiSessionMutationRewindInvocation | undefined {
    const invocation = this.invocations.get(sequence);
    return invocation?.mode === 'rewind' ? invocation : undefined;
  }

  private getEditInvocation(sequence: number): TuiSessionMutationEditInvocation | undefined {
    const invocation = this.invocations.get(sequence);
    return invocation?.mode === 'edit' ? invocation : undefined;
  }

  private hasSessionChanged(invocation: { readonly sourceSessionId: string }): boolean {
    const currentSessionId = this.options.controller.snapshot().session?.sessionId;
    return currentSessionId !== invocation.sourceSessionId;
  }
}

export const TUI_SESSION_MUTATION_FORK_CONFIRMATION_SCREEN_ID = 'session-mutation:fork-confirm';

interface TuiSessionMutationForkConfirmationOptions {
  readonly summary: TuiSessionInputSummary;
  readonly options: TuiSessionForkOptions;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly requestRender: () => void;
}

export class TuiSessionMutationForkConfirmation implements TuiFeatureScreen, Component, Focusable {
  readonly id = TUI_SESSION_MUTATION_FORK_CONFIRMATION_SCREEN_ID;
  readonly layoutRoot: Component = this;
  focused = false;
  private busy = false;
  private error: string | undefined;
  private closed = false;

  constructor(private readonly options: TuiSessionMutationForkConfirmationOptions) {}

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      if (this.closed) return;
      this.closed = true;
      this.options.onCancel();
      return;
    }
    if (!this.busy && matchesKey(data, 'enter')) this.options.onConfirm();
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.renderViewport(width, 24);
  }

  renderViewport(rawWidth: number, rawHeight: number): string[] {
    const width = Math.max(0, Math.floor(rawWidth));
    const height = Math.max(1, Math.floor(rawHeight));
    if (width === 0) return [];
    const title = sanitizeTerminalText(
      this.options.options.suggestedTitle?.trim() ||
        sessionMutationText('sessionMutation.confirm.fork.suggestedTitle'),
    );
    const source = sanitizeTerminalText(
      this.options.options.sourceTitle?.trim() ||
        sessionMutationText('sessionMutation.confirm.fork.currentSession'),
    );
    const prompt = sanitizeTerminalText(
      this.options.summary.contentHead?.trim() ||
        sessionMutationText('sessionMutation.format.noPrompt'),
    );
    const worktree = this.options.options.worktreeVisible
      ? this.options.options.worktreeEligible
        ? sessionMutationText('sessionMutation.confirm.fork.workspaceEligible')
        : sessionMutationTemplate('sessionMutation.confirm.fork.workspaceUnavailable', {
            reason:
              this.options.options.worktreeUnavailableReason?.trim() ||
              sessionMutationText('sessionMutation.confirm.fork.worktreeUnavailable'),
          })
      : sessionMutationText('sessionMutation.confirm.fork.workspaceCurrent');
    const status = this.busy
      ? chalk.hex(colors.signal)(sessionMutationText('sessionMutation.confirm.fork.busy'))
      : renderTuiActionHint(sessionMutationText('sessionMutation.confirm.confirmHint'));
    const content = [
      chalk.bold.hex(colors.signal)(sessionMutationText('sessionMutation.confirm.fork.title')),
      chalk.hex(colors.muted)(sessionMutationText('sessionMutation.confirm.fork.helper')),
      '',
      `${chalk.hex(colors.muted)(sessionMutationText('sessionMutation.confirm.titleLabel'))}  ${chalk.hex(colors.text)(title)}`,
      `${chalk.hex(colors.muted)(sessionMutationText('sessionMutation.confirm.sourceLabel'))} ${chalk.hex(colors.text)(source)}`,
      `${chalk.hex(colors.muted)(sessionMutationText('sessionMutation.confirm.fromLabel'))}   ${chalk.hex(colors.text)(prompt)}`,
      chalk.hex(colors.muted)(sanitizeTerminalText(worktree)),
      ...(this.error ? ['', chalk.hex(colors.warning)(sanitizeTerminalText(this.error))] : []),
    ];
    const lines = pinMutationFooter(content, ['', status], height).map((line) =>
      fitLine(line, width),
    );
    if (lines.length >= height) return lines.slice(0, height);
    const padded = [...lines];
    while (padded.length < height) padded.push('');
    return padded;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    if (busy) this.error = undefined;
    this.options.requestRender();
  }

  setError(error: string): void {
    this.error = error;
    this.options.requestRender();
  }
}

export const TUI_SESSION_MUTATION_REWIND_CONFIRMATION_SCREEN_ID = 'session-mutation:rewind-confirm';

class TuiSessionMutationRewindConfirmation implements TuiFeatureScreen, Component, Focusable {
  readonly id = TUI_SESSION_MUTATION_REWIND_CONFIRMATION_SCREEN_ID;
  readonly layoutRoot: Component = this;
  focused = false;
  private busy = false;
  private error: string | undefined;

  constructor(
    private readonly options: {
      readonly preview?: TuiRewindPreview;
      readonly summary?: TuiSessionInputSummary;
      readonly affectedTurnCount?: number;
      readonly scope: TuiRewindScope;
      readonly onConfirm: () => void;
      readonly onCancel: () => void;
      readonly requestRender: () => void;
    },
  ) {}

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) return this.options.onCancel();
    if (matchesKey(data, 'enter')) this.options.onConfirm();
  }

  invalidate(): void {}
  render(width: number): string[] {
    return this.renderViewport(width, 24);
  }
  renderViewport(width: number, height: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    if (!safeWidth) return [];
    const ready = (this.options.preview?.turns ?? [])
      .flatMap((turn) => turn.files)
      .filter((file) => !file.skipped).length;
    const skipped = (this.options.preview?.turns ?? [])
      .flatMap((turn) => turn.files)
      .filter((file) => file.skipped).length;
    const affectedTurnCount = Math.max(
      1,
      this.options.affectedTurnCount ?? this.options.preview?.turns.length ?? 1,
    );
    const impact = sessionMutationTemplate(
      affectedTurnCount === 1
        ? 'sessionMutation.format.affected.one'
        : 'sessionMutation.format.affected.many',
      { count: affectedTurnCount },
    );
    const target = formatPromptHead(
      this.options.summary?.contentHead,
      Math.max(16, safeWidth - 10),
    );
    const warning =
      this.options.scope === 'conversation_and_files'
        ? sessionMutationText('sessionMutation.confirm.rewind.filesWarning')
        : sessionMutationText('sessionMutation.confirm.rewind.conversationWarning');
    const content = [
      chalk.bold.hex(colors.signal)(sessionMutationText('sessionMutation.confirm.rewind.title')),
      chalk.hex(colors.muted)(sanitizeTerminalText(warning)),
      `${chalk.hex(colors.muted)(sessionMutationText('sessionMutation.confirm.targetLabel'))} ${chalk.hex(colors.text)(sanitizeTerminalText(target))}`,
      `${chalk.hex(colors.muted)(sessionMutationText('sessionMutation.confirm.impactLabel'))} ${chalk.hex(colors.text)(impact)}`,
      `${chalk.hex(colors.muted)(sessionMutationText('sessionMutation.confirm.scopeLabel'))} ${chalk.hex(colors.text)(rewindScopeLabel(this.options.scope))}`,
      `${chalk.hex(colors.muted)(sessionMutationText('sessionMutation.confirm.filesLabel'))} ${
        this.options.scope === 'conversation'
          ? sessionMutationText('sessionMutation.confirm.filesUnchanged')
          : sessionMutationTemplate('sessionMutation.confirm.fileCounts', { ready, skipped })
      }`,
      ...(ready === 0 && this.options.scope === 'conversation_and_files'
        ? [chalk.hex(colors.warning)('No file changes can be safely rewound at this point.')]
        : []),
      ...(this.error ? [chalk.hex(colors.warning)(sanitizeTerminalText(this.error))] : []),
    ];
    const footer = [
      '',
      this.busy
        ? chalk.hex(colors.signal)(sessionMutationText('sessionMutation.confirm.rewind.busy'))
        : renderTuiActionHint(sessionMutationText('sessionMutation.confirm.confirmHint')),
    ];
    const lines = pinMutationFooter(content, footer, safeHeight).map((line) =>
      fitLine(line, safeWidth),
    );
    if (lines.length >= safeHeight) return lines.slice(0, safeHeight);
    while (lines.length < safeHeight) lines.push('');
    return lines;
  }
  setBusy(value: boolean): void {
    this.busy = value;
    this.options.requestRender();
  }
  setError(value: string): void {
    this.error = value;
    this.options.requestRender();
  }
}

function rewindPreviewCounts(preview: TuiRewindPreview | undefined): {
  readonly ready: number;
  readonly skipped: number;
} {
  let ready = 0;
  let skipped = 0;
  for (const turn of preview?.turns ?? []) {
    for (const file of turn.files) {
      if (file.skipped) skipped += 1;
      else ready += 1;
    }
  }
  return { ready, skipped };
}

function rewindScopeLabel(scope: TuiRewindScope): string {
  if (scope === 'conversation') {
    return sessionMutationText('sessionMutation.scope.conversation.label');
  }
  return sessionMutationText('sessionMutation.scope.both.label');
}

interface TuiRewindOutcomeWarning {
  readonly message: string;
  readonly kind: 'warning';
}

function classifyRewindOutcome(
  scope: TuiRewindScope,
  result: TuiRewindResult,
  preview: TuiRewindPreview | undefined,
): TuiRewindOutcomeWarning | undefined {
  const outcome = result.turnDiffRewind;
  if (scope === 'conversation') {
    if (result.rewound && (!outcome || outcome.status === 'not-requested')) {
      return undefined;
    }
    if (!result.rewound || outcome?.status === 'no-diff') {
      return {
        message: sessionMutationText('sessionMutation.outcome.boundaryUnavailable'),
        kind: 'warning',
      };
    }
  }
  if (!outcome || outcome.status === 'no-diff' || outcome.status === 'skipped') {
    return {
      message: sessionMutationText('sessionMutation.outcome.noSafeFiles'),
      kind: 'warning',
    };
  }
  const counts = rewindPreviewCounts(preview);
  if (outcome.status === 'partial') {
    const error = outcome.errorCode
      ? sessionMutationTemplate('sessionMutation.outcome.errorSuffix', {
          code: safeRewindErrorCode(outcome.errorCode),
        })
      : '';
    return {
      message: sessionMutationTemplate('sessionMutation.outcome.partial', {
        error,
      }),
      kind: 'warning',
    };
  }
  if (outcome.status === 'failed-after-rewind') {
    const error = outcome.errorCode
      ? sessionMutationTemplate('sessionMutation.outcome.errorSuffix', {
          code: safeRewindErrorCode(outcome.errorCode),
        })
      : '';
    return {
      message: sessionMutationTemplate('sessionMutation.outcome.failedAfterRewind', {
        error,
      }),
      kind: 'warning',
    };
  }
  if (outcome.status === 'rewound' && (outcome.revertedTurnIds?.length ?? 0) > 0) {
    return undefined;
  }
  return {
    message: sessionMutationTemplate('sessionMutation.outcome.unsafe', {
      status: safeRewindErrorCode(outcome.status),
      ready: counts.ready,
      skipped: counts.skipped,
    }),
    kind: 'warning',
  };
}

function rewindFailureCopy(error: unknown): string {
  const code = rewindErrorCode(error);
  if (
    code === 'STALE' ||
    code === 'INVALID_BOUNDARY' ||
    code === 'MESSAGE_NOT_FOUND' ||
    code === 'MESSAGE_BOUNDARY_NOT_FOUND' ||
    code === 'MESSAGE_BOUNDARY_INVALID'
  ) {
    return sessionMutationText('sessionMutation.outcome.boundaryUnavailable');
  }
  if (
    code === 'CONFLICT' ||
    code === 'ALREADY_SUBMITTED' ||
    code === 'DUPLICATE' ||
    code === 'CONVERSATION_MUTATION_REQUEST_CONFLICT'
  ) {
    return sessionMutationText('sessionMutation.error.conflict');
  }
  if (code === 'BUSY' || code === 'ACTIVE_TURN' || code === 'CONVERSATION_MUTATION_BUSY') {
    return sessionMutationText('sessionMutation.error.busy');
  }
  return sessionMutationText('sessionMutation.error.retry');
}

function rewindRetryCopy(error: unknown): string {
  const copy = rewindFailureCopy(error);
  return copy === sessionMutationText('sessionMutation.error.retry')
    ? sessionMutationText('sessionMutation.error.retrySameOperation')
    : copy;
}

function editFailureCopy(error: unknown): string {
  const code = rewindErrorCode(error);
  if (
    code === 'MESSAGE_BOUNDARY_INVALID' ||
    code === 'MESSAGE_BOUNDARY_NOT_FOUND' ||
    code === 'MESSAGE_NOT_FOUND'
  ) {
    return sessionMutationText('sessionMutation.outcome.boundaryUnavailable');
  }
  if (code === 'CONVERSATION_MUTATION_REQUEST_CONFLICT') {
    return sessionMutationText('sessionMutation.error.conflict');
  }
  if (code === 'CONVERSATION_MUTATION_BUSY') {
    return sessionMutationText('sessionMutation.error.busy');
  }
  return sessionMutationText('sessionMutation.error.editRequest');
}

function mergeEditAttachments(
  attachments: readonly TuiEditMessageAttachment[],
  additions: readonly TuiEditMessageAttachment[],
): TuiEditMessageAttachment[] | undefined {
  const original = attachments
    .filter((attachment) => Boolean(attachment.filePath || attachment.assetId))
    .map((attachment) => ({
      type: attachment.type,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
      ...(attachment.filePath ? { filePath: attachment.filePath } : {}),
      ...(attachment.assetId ? { assetId: attachment.assetId } : {}),
    }));
  const merged = new Map<string, TuiEditMessageAttachment>();
  for (const attachment of [...original, ...additions]) {
    const key =
      attachment.assetId ?? attachment.filePath ?? `${attachment.type}:${attachment.fileName}`;
    merged.set(key, attachment);
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

function latestSessionInputSummary(
  summaries: readonly TuiSessionInputSummary[],
): TuiSessionInputSummary | undefined {
  return summaries.reduce<TuiSessionInputSummary | undefined>(
    (latest, summary) => (!latest || summary.timestamp >= latest.timestamp ? summary : latest),
    undefined,
  );
}

function rewindErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = error as { code?: unknown; key?: unknown };
  const code =
    typeof value.code === 'string' ? value.code : typeof value.key === 'string' ? value.key : '';
  return code.toUpperCase().replace(/[^A-Z0-9_-]/gu, '');
}

function shouldCreateNewRewindOperation(error: unknown): boolean {
  const code = rewindErrorCode(error);
  return Boolean(code && code !== 'REWIND_DISPLAY_COMMIT_FAILED');
}

function safeRewindErrorCode(value: string): string {
  return (
    value
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/gu, '')
      .slice(0, 64) || 'UNKNOWN'
  );
}

function fitLine(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  return truncateToWidth(value, width, chalk.hex(colors.dim)('…'));
}

function pinMutationFooter(
  content: readonly string[],
  footer: readonly string[],
  height: number,
): string[] {
  if (height <= footer.length) return footer.slice(Math.max(0, footer.length - height));
  return [...content.slice(0, height - footer.length), ...footer];
}

function forkUnavailableMessage(options: TuiSessionForkOptions): string {
  const reason = options.unavailableReason?.trim();
  if (reason) {
    return sessionMutationTemplate('sessionMutation.fork.unavailableReason', { reason });
  }
  return sessionMutationText('sessionMutation.fork.unavailableDefault');
}

function mutationTarget(summary: TuiSessionInputSummary): string {
  return `${sessionMutationText('sessionMutation.confirm.targetLabel')}  ${formatPromptHead(
    summary.contentHead,
    72,
  )}`;
}

function mutationImpact(affectedTurnCount: number | undefined, fileChangeCount: number): string {
  const count = Math.max(1, affectedTurnCount ?? 1);
  const turns = sessionMutationTemplate(
    count === 1 ? 'sessionMutation.format.affected.one' : 'sessionMutation.format.affected.many',
    { count },
  );
  return `${turns} · ${summarizeFileChangeCount(fileChangeCount)}`;
}

function createDefaultOperationId(): string {
  // Uses Date.now + Math.random for the TUI-internal flow; runtime still owns
  // the persisted-operation idempotency contract.
  return `tui-fork_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export { TUI_SESSION_MUTATION_HISTORY_PICKER_SCREEN_ID };
