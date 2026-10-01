import type { TuiComposerDraft } from '../../features/composer/draft.js';
import { isTuiTerminalImagePaste } from '../../features/composer/terminal-image-paste.js';
import type { Editor, EditorDraftSnapshot } from '../../widgets/editor/editor.js';
import type { TuiInlinePanelHost } from '../../shell/inline-panel.js';
import type { TuiComposerState } from '../../shell/composer.js';
import type { TuiInteractionSurface } from '../../shell/interaction-surface.js';
import {
  formatTuiKeybinding,
  getDefaultTuiKeybindingRegistry,
  type TuiKeybindingRegistry,
} from '../../shell/keybindings.js';
import { isKeyRelease, matchesKey } from '../../engine/public.js';
import type { TUI } from '../../engine/public.js';
import type { EditTuiDraftInExternalEditor } from '../../../host/external-editor.js';
import { TuiExternalEditorFlow } from './external-editor-flow.js';
import type { TuiCommandFlow } from '../product/command-flow.js';
import type { TuiSubmissionSnapshot } from '../../features/composer/submission.js';
import type { TuiFeatureFlow } from '../product/feature-flow.js';
import type { TuiInteractionFlow } from './interaction-flow.js';
import type { TuiPermissionModeFlow } from './permission-mode-flow.js';
import type { TuiPlanModeFlow } from './plan-mode-flow.js';
import { TuiHistorySearchPanel } from '../../features/history/search-panel.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import type { RecentCodexSession } from '../../../host/recent-codex-session.js';
import { parseTuiBashInput } from '../../commands/bash-input.js';

const DOUBLE_ESCAPE_WINDOW_MS = 500;

export interface TuiInputFlowOptions {
  readonly cancelBash?: () => boolean;
  readonly tui: TUI;
  readonly addInputListener?: TUI['addInputListener'];
  readonly renderLifecycle?: Pick<TUI, 'start' | 'stop' | 'requestRender'>;
  readonly editor: Editor;
  readonly workspaceDir: string;
  readonly externalEditorCommand?: string;
  readonly editDraftInExternalEditor?: EditTuiDraftInExternalEditor;
  readonly interaction: TuiInlinePanelHost;
  readonly interactionSurface: TuiInteractionSurface;
  readonly interactionFlow: TuiInteractionFlow;
  readonly featureFlow: TuiFeatureFlow;
  readonly commandFlow: TuiCommandFlow;
  readonly permissionModeFlow: TuiPermissionModeFlow;
  readonly planModeFlow?: TuiPlanModeFlow;
  readonly composerDraft: TuiComposerDraft;
  readonly liveRunId: () => string | undefined;
  readonly hasWaitingMessage: () => boolean;
  readonly restoreWaitingMessage: () => Promise<boolean>;
  readonly openQueueManager: () => void;
  readonly toggleTasks: () => void;
  readonly isStopped: () => boolean;
  readonly abortLiveTurn: () => Promise<boolean>;
  readonly cancelSessionEdit?: () => boolean;
  readonly isEditImageAttachment?: (id: string) => boolean;
  readonly takeRecentCodexSession?: () => RecentCodexSession | undefined;
  readonly restoreRecentCodexSession?: (session: RecentCodexSession) => void;
  readonly dismissRecentCodexSession?: () => void;
  readonly leaveUi: () => Promise<void>;
  /** True while the side half of a paired BTW conversation is visible. */
  readonly isSideModeActive?: () => boolean;
  /** Switches between the parent and side projections without ending either one. */
  readonly toggleSideConversation?: () => Promise<boolean>;
  /** Stops and destroys the visible side conversation. */
  readonly closeSideConversation?: (exitReason: 'ctrl_c' | 'ctrl_d') => Promise<boolean>;
  readonly requestProcessSuspend?: () => void;
  readonly keybindings?: TuiKeybindingRegistry;
  readonly append: (content: string, kind?: 'final-summary' | 'warning' | 'error') => void;
  readonly setHint: (message: string | undefined, tone?: TuiComposerState['hintTone']) => void;
  readonly onChanged: () => void;
  readonly onSubmissionStarted?: (
    input?: string,
    seed?: ReturnType<TuiCommandFlow['captureSubmissionSeed']>,
  ) => string | undefined;
  readonly onSubmissionAdmitted?: (submissionToken?: string) => void;
  readonly onSubmissionPrepared?: (
    submissionToken: string | undefined,
    submission: TuiSubmissionSnapshot,
  ) => void;
  readonly onSubmissionSettled?: (submissionToken?: string) => void;
  readonly requestInteractionRender: () => void;
}

export class TuiInputFlow {
  private readonly externalEditorFlow: TuiExternalEditorFlow;
  private clearedEditorDraft: EditorDraftSnapshot | undefined;
  private ctrlCExitArmed = false;
  private lastEscapeAtMs = 0;
  private nextBusySubmission: { readonly busyAction: 'steer' | 'queue' } | undefined;

  constructor(private readonly options: TuiInputFlowOptions) {
    this.externalEditorFlow = new TuiExternalEditorFlow({
      editor: options.editor,
      tui: options.renderLifecycle ?? options.tui,
      workspaceDir: options.workspaceDir,
      configuredCommand: options.externalEditorCommand,
      editDraft: options.editDraftInExternalEditor,
      isAppStopped: options.isStopped,
      append: options.append,
      setHint: options.setHint,
      onChanged: options.onChanged,
      keybindings: options.keybindings,
    });
  }

  attach(): () => void {
    const previousAutocompleteSelect = this.options.editor.onAutocompleteSelect;
    const onAutocompleteSelect: NonNullable<Editor['onAutocompleteSelect']> = (
      suggestions,
      item,
    ) => {
      previousAutocompleteSelect?.(suggestions, item);
      if ('pluginId' in item) return;
      const imageReference = selectedImageMentionReference(item.value, suggestions.prefix);
      if (!imageReference) return;
      void this.options.composerDraft.queueAttachment(imageReference).catch((error: unknown) =>
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't attach that image.",
            nextStep: 'Check the path and try again.',
          }),
          'error',
        ),
      );
    };
    this.options.editor.onAutocompleteSelect = onAutocompleteSelect;
    this.options.editor.onPaste = (value) => {
      if (!isTuiTerminalImagePaste(value)) return false;
      void this.options.composerDraft
        .queueAttachment(value, { source: 'terminal-paste' })
        .catch((error: unknown) =>
          this.options.append(
            formatTuiActionFailure(error, {
              summary: "Couldn't attach that file.",
              nextStep: 'Check the path and try again.',
            }),
            'error',
          ),
        );
      return true;
    };
    this.options.editor.onAttachmentPlaceholderDeleted = (id) => {
      void this.options.composerDraft
        .removeAttachmentById(id)
        .then((removed) => {
          if (!removed) this.options.composerDraft.ensureAttachmentPlaceholders();
        })
        .catch((error: unknown) =>
          this.options.append(
            formatTuiActionFailure(error, {
              summary: "Couldn't remove that attachment.",
              nextStep: 'Retry.',
            }),
            'error',
          ),
        );
    };
    this.options.editor.onAttachmentPlaceholderRestored = (id) => {
      if (!this.options.composerDraft.restoreAttachmentById(id)) {
        this.options.composerDraft.ensureAttachmentPlaceholders();
      }
    };
    this.options.editor.onSubmit = (input, editorDraft) => {
      const busySubmission = this.nextBusySubmission;
      this.nextBusySubmission = undefined;
      let submission: ReturnType<TuiCommandFlow['captureSubmissionSeed']>;
      try {
        submission = this.options.commandFlow.captureSubmissionSeed(editorDraft);
      } catch (error) {
        this.options.editor.restoreDraft(editorDraft);
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't prepare this message.",
            nextStep: 'Review attachments and retry.',
            preservation: 'Your draft is preserved.',
          }),
          'error',
        );
        this.options.onChanged();
        return;
      }
      const isLiteralRecovery = Boolean(submission.transportContent);
      const submissionToken =
        !isLiteralRecovery &&
        (this.options.commandFlow.catalog.resolve(input.trim()) || parseTuiBashInput(input))
          ? undefined
          : this.options.onSubmissionStarted?.(input, submission);
      if (input.trim()) this.options.editor.addToHistory(input);
      this.options.editor.setText('');
      void this.options.commandFlow
        .submit(input, submission, {
          ...(busySubmission ?? {}),
          onRuntimeAccepted: () => this.options.onSubmissionAdmitted?.(submissionToken),
          onSubmissionPrepared: (prepared) =>
            this.options.onSubmissionPrepared?.(submissionToken, prepared),
        })
        .then(
          (disposition) => {
            if (disposition === 'consumed') {
              this.options.onSubmissionSettled?.(submissionToken);
            }
            this.options.onChanged();
          },
          async (error: unknown) => {
            const message = formatTuiActionFailure(error, {
              summary: "Couldn't send this message.",
              nextStep: 'Retry.',
              preservation: 'Your draft is preserved.',
            });
            await this.options.commandFlow.restoreFailedSeed(input, submission);
            this.options.append(message, 'error');
            this.options.onChanged();
          },
        )
        .catch((error: unknown) =>
          this.options.append(
            formatTuiActionFailure(error, {
              summary: "Couldn't preserve this failed message.",
              nextStep: 'Copy it before exiting.',
            }),
            'error',
          ),
        );
    };
    const detach = (this.options.addInputListener ?? this.options.tui.addInputListener)((data) =>
      this.handle(data),
    );
    return () => {
      detach();
      this.options.editor.onPaste = undefined;
      this.options.editor.onAttachmentPlaceholderDeleted = undefined;
      this.options.editor.onAttachmentPlaceholderRestored = undefined;
      if (this.options.editor.onAutocompleteSelect === onAutocompleteSelect) {
        this.options.editor.onAutocompleteSelect = previousAutocompleteSelect;
      }
    };
  }

  private handle(data: string): { consume: true; render?: false } | undefined {
    if (isKeyRelease(data)) return undefined;
    const interactionActive = this.options.interaction.isActive();
    if ((matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) && this.options.cancelBash?.()) {
      return { consume: true };
    }
    const keybindingRegistry = this.options.keybindings ?? getDefaultTuiKeybindingRegistry();
    const keyAction = keybindingRegistry.resolve(data, {
      interactionActive,
      hasLiveRun: Boolean(this.options.liveRunId()),
      hasWaitingMessage: this.options.hasWaitingMessage(),
      hasRestorableDraft: Boolean(this.clearedEditorDraft),
    });
    if (keyAction !== 'resume-codex') this.options.dismissRecentCodexSession?.();
    if (keyAction !== 'clear') this.ctrlCExitArmed = false;
    if (keyAction !== 'interrupt') this.lastEscapeAtMs = 0;
    if (keyAction === 'suspend' && this.options.requestProcessSuspend) {
      this.options.requestProcessSuspend();
      return { consume: true };
    }
    if (keyAction === 'toggle-side-session') {
      void this.options.toggleSideConversation?.().then((toggled) => {
        if (!toggled) {
          this.options.setHint(
            'No side conversation is open. Run /btw first; this shortcut only switches conversations.',
            'warning',
          );
        }
        this.options.onChanged();
      });
      return { consume: true };
    }
    if (this.options.featureFlow.isFeatureScreenActive()) {
      this.ctrlCExitArmed = false;
      this.lastEscapeAtMs = 0;
      return undefined;
    }
    if (interactionActive) {
      this.lastEscapeAtMs = 0;
      if (keyAction !== 'scroll-up' && keyAction !== 'scroll-down') return undefined;
      const direction = keyAction === 'scroll-up' ? -1 : 1;
      const interactionScroll = this.options.interaction.scrollByPage(direction);
      if (interactionScroll === undefined) return undefined;
      this.options.tui.requestRender();
      return { consume: true };
    }
    const preview = this.options.editor.getAttachmentPreview();
    const previewIsImage =
      preview &&
      (this.options.isEditImageAttachment?.(preview.id) ||
        this.options.composerDraft
          .snapshot()
          .attachments.some((item) => item.filePath === preview.id && item.type === 'image'));
    if (previewIsImage && matchesKey(data, 'escape')) {
      this.options.editor.dismissAttachmentPreview();
      this.lastEscapeAtMs = 0;
      return { consume: true };
    }
    if (this.clearedEditorDraft && keyAction === 'restore-draft') {
      const restored = this.clearedEditorDraft;
      this.clearedEditorDraft = undefined;
      this.ctrlCExitArmed = false;
      this.options.composerDraft.restoreClearedDraft();
      this.options.editor.restoreDraft(restored);
      this.options.setHint('Draft restored');
      this.options.onChanged();
      return { consume: true };
    }
    if (this.clearedEditorDraft) {
      this.clearedEditorDraft = undefined;
      void this.options.composerDraft.discardClearedDraft().catch((error: unknown) =>
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't discard the saved draft.",
            nextStep: 'Retry.',
          }),
          'error',
        ),
      );
    }
    if (keyAction === 'resume-codex') {
      if (this.options.editor.getText().length > 0 || this.options.composerDraft.hasContent()) {
        return undefined;
      }
      const session = this.options.takeRecentCodexSession?.();
      if (!session) return undefined;
      const input = `/resume-codex ${session.sessionId}`;
      const submissionToken = this.options.onSubmissionStarted?.(input);
      void this.options.commandFlow
        .submit(input)
        .then((disposition) => {
          if (disposition === 'retained') this.options.restoreRecentCodexSession?.(session);
          this.options.onChanged();
        })
        .catch((error: unknown) => {
          this.options.restoreRecentCodexSession?.(session);
          this.options.append(
            formatTuiActionFailure(error, {
              summary: "Couldn't resume that Codex session.",
              nextStep: 'Press Ctrl+U to retry or run /resume-codex with the session id.',
            }),
            'error',
          );
          this.options.onChanged();
        })
        .finally(() => this.options.onSubmissionSettled?.(submissionToken));
      return { consume: true };
    }
    if (keyAction === 'paste-image') {
      void this.options.composerDraft.pasteClipboard();
      return { consume: true };
    }
    if (keyAction === 'open-external-editor') {
      void this.externalEditorFlow.open().catch((error: unknown) =>
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't open the external editor.",
            nextStep: 'Check $VISUAL or $EDITOR and retry.',
            preservation: 'Your draft is preserved.',
          }),
          'error',
        ),
      );
      return { consume: true };
    }
    if (keyAction === 'search-history') {
      this.openHistorySearch();
      return { consume: true };
    }
    if (keyAction === 'submit-guidance' || keyAction === 'queue-draft') {
      if (this.options.editor.getText().length === 0 && !this.options.composerDraft.hasContent()) {
        return { consume: true };
      }
      this.nextBusySubmission = {
        busyAction: keyAction === 'submit-guidance' ? 'steer' : 'queue',
      };
      if (!this.options.editor.submit()) this.nextBusySubmission = undefined;
      return { consume: true };
    }
    if (keyAction === 'restore-waiting') {
      void this.options.restoreWaitingMessage().catch((error: unknown) =>
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't restore the latest queued message.",
            nextStep: 'Retry.',
          }),
          'error',
        ),
      );
      return { consume: true };
    }
    if (keyAction === 'manage-waiting') {
      this.options.openQueueManager();
      return { consume: true };
    }
    if (keyAction === 'toggle-tasks') {
      this.options.toggleTasks();
      this.options.onChanged();
      return { consume: true };
    }
    if (keyAction === 'toggle-details') {
      this.options.featureFlow.toggleTranscriptDetails();
      this.options.tui.requestRender();
      return { consume: true, render: false };
    }
    if (keyAction === 'cycle-permission') {
      void this.options.permissionModeFlow.cycle();
      return { consume: true };
    }
    if (keyAction === 'toggle-plan') {
      if (this.options.interactionFlow.hasPending()) {
        this.options.setHint('Resolve the pending Agent interaction before changing Plan Mode.');
        this.options.interactionFlow.showPending();
        this.options.onChanged();
        return { consume: true };
      }
      this.options.planModeFlow?.toggle();
      return { consume: true };
    }
    if (keyAction === 'exit') {
      if (this.options.editor.getText().length > 0 || this.options.composerDraft.hasContent()) {
        return undefined;
      }
      if (this.options.isSideModeActive?.()) {
        void this.options.closeSideConversation?.('ctrl_d');
        return { consume: true };
      }
      void this.options.leaveUi();
      return { consume: true };
    }
    const isCtrlC = keyAction === 'clear';
    const isEscape = keyAction === 'interrupt';
    if (!isCtrlC && !isEscape) {
      this.options.setHint(undefined);
      return undefined;
    }
    if (isCtrlC && this.options.composerDraft.abortClipboardRead()) {
      return { consume: true };
    }
    if (isEscape) {
      if (this.options.cancelSessionEdit?.()) {
        this.lastEscapeAtMs = 0;
        this.options.tui.requestRender();
        return { consume: true };
      }
      if (this.options.liveRunId()) {
        this.lastEscapeAtMs = 0;
        void this.options.abortLiveTurn();
        this.options.tui.requestRender();
        return { consume: true };
      }
      if (this.options.editor.getText().length > 0 || this.options.composerDraft.hasContent()) {
        this.lastEscapeAtMs = 0;
        return undefined;
      }
      const now = Date.now();
      if (this.lastEscapeAtMs > 0 && now - this.lastEscapeAtMs < DOUBLE_ESCAPE_WINDOW_MS) {
        this.lastEscapeAtMs = 0;
        this.options.setHint(undefined);
        void this.options.commandFlow.submit('/edit').then(
          () => this.options.onChanged(),
          (error: unknown) => {
            this.options.append(
              formatTuiActionFailure(error, {
                summary: "Couldn't edit the latest message.",
                nextStep: 'Run /edit to retry.',
              }),
              'error',
            );
            this.options.onChanged();
          },
        );
        return { consume: true };
      }
      this.lastEscapeAtMs = now;
      this.options.setHint('Press Esc again to edit the latest message');
      this.options.onChanged();
      return undefined;
    }

    if (
      this.options.isSideModeActive?.() &&
      this.options.editor.getText().length === 0 &&
      !this.options.composerDraft.hasContent()
    ) {
      // In side mode an empty Ctrl+C closes the temporary side conversation;
      // it never arms the application-level quit latch.
      this.ctrlCExitArmed = false;
      this.options.setHint(undefined);
      void this.options.closeSideConversation?.('ctrl_c').then(
        () => this.options.onChanged(),
        () => this.options.onChanged(),
      );
      this.options.tui.requestRender();
      return { consume: true };
    }

    if (this.ctrlCExitArmed) {
      this.ctrlCExitArmed = false;
      void this.options.leaveUi();
    } else if (
      this.options.editor.getText().length > 0 ||
      this.options.composerDraft.hasContent()
    ) {
      this.ctrlCExitArmed = true;
      this.options.editor.addToHistory(this.options.editor.getText());
      this.clearedEditorDraft = this.options.editor.captureDraft();
      this.options.composerDraft.stashForClear();
      this.options.editor.restoreDraft({
        ...this.clearedEditorDraft,
        text: '',
        pluginMentions: [],
        cursor: 0,
        pastes: [],
        attachmentPlaceholders: [],
      });
      const keybindings = this.options.keybindings ?? getDefaultTuiKeybindingRegistry();
      this.options.setHint(
        `Draft cleared · ${formatTuiKeybinding('composer.restore-draft', keybindings)} restore · ${formatTuiKeybinding('app.clear', keybindings)} exit`,
      );
      this.options.onChanged();
    } else {
      this.ctrlCExitArmed = true;
      const keybindings = this.options.keybindings ?? getDefaultTuiKeybindingRegistry();
      this.options.setHint(`Press ${formatTuiKeybinding('app.clear', keybindings)} again to exit`);
      this.options.onChanged();
    }
    this.options.tui.requestRender();
    return { consume: true };
  }

  private openHistorySearch(): void {
    const entries = this.options.editor.getHistoryEntries();
    if (entries.length === 0) {
      this.options.setHint('No prompt history yet.');
      this.options.onChanged();
      return;
    }
    const originalDraft = this.options.editor.getText();
    const panel = new TuiHistorySearchPanel({
      entries,
      initialQuery: originalDraft,
      onSelect: (entry) => {
        this.options.editor.setText(entry);
        this.options.interactionSurface.close(panel);
        this.options.onChanged();
      },
      onCancel: () => {
        this.options.interactionSurface.close(panel);
        this.options.onChanged();
      },
      requestRender: this.options.requestInteractionRender,
    });
    this.options.interactionSurface.show(panel);
  }
}

const IMAGE_MENTION_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/iu;

function selectedImageMentionReference(value: string, prefix: string): string | undefined {
  if (!prefix.startsWith('@') || !value.startsWith('@')) return undefined;
  const reference = value.slice(1);
  const unquoted =
    reference.length >= 2 && reference.startsWith('"') && reference.endsWith('"')
      ? reference.slice(1, -1)
      : reference;
  if (!IMAGE_MENTION_EXTENSION.test(unquoted)) return undefined;
  return reference;
}
