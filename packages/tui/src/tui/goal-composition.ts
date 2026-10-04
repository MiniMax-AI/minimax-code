import type { CreateTuiAppOptions } from '../types/tui-app.js';
import { readTuiClipboardText } from '../host/clipboard-text.js';
import type { TuiChatController } from './controller/chat-controller.js';
import type { TuiChromeFlow } from './controller/product/chrome-flow.js';
import { TuiGoalFlow } from './controller/product/goal-flow.js';
import { resolveTuiAttachment } from './features/composer/attachments.js';
import { TuiComposerDraft } from './features/composer/draft.js';
import type { TuiGoalBanner } from './features/goal/banner.js';
import type { TuiSurfaceHost } from './shell/surface-host.js';
import type { Editor, EditorAttachmentPlaceholder } from './widgets/editor/editor.js';

interface TuiGoalCompositionOptions {
  readonly app: CreateTuiAppOptions;
  readonly controller: TuiChatController;
  readonly banner: TuiGoalBanner;
  readonly editor: Editor;
  readonly surfaceHost: TuiSurfaceHost;
  readonly append: (content: string, kind?: 'warning' | 'error') => void;
  readonly scheduleDraft: () => void;
  readonly chrome: () => TuiChromeFlow | undefined;
  readonly isStopped: () => boolean;
  readonly hasLiveRun?: () => boolean;
  readonly updateChrome: () => void;
  readonly onEditorChanged?: () => void;
  readonly requestRender: () => void;
  readonly editAttachmentPlaceholders?: () => readonly EditorAttachmentPlaceholder[];
  readonly editAttachmentCount?: () => number;
}

/** Keeps Composer attachment ownership and Goal assembly outside the app composition root. */
export function createTuiGoalComposition(options: TuiGoalCompositionOptions): {
  readonly composerDraft: TuiComposerDraft;
  readonly goalFlow: TuiGoalFlow;
} {
  const resolveAttachment = options.app.resolveAttachment ?? resolveTuiAttachment;
  const composerDraft = new TuiComposerDraft({
    workspaceDir: options.app.workspaceDir,
    ...(options.app.homeDir ? { homeDir: options.app.homeDir } : {}),
    resolveAttachment,
    ...(options.app.readClipboardImage
      ? { readClipboardImage: options.app.readClipboardImage }
      : {}),
    readClipboardText: options.app.readClipboardText ?? readTuiClipboardText,
    insertTextAtCursor: (text) => options.editor.insertTextAtCursor(text),
    ...(options.app.dataDir ? { draftRecoveryDataDir: options.app.dataDir } : {}),
    append: options.append,
    onAttachmentPlaceholdersChanged: (placeholders) =>
      options.editor.syncAttachmentPlaceholders([
        ...(options.editAttachmentPlaceholders?.() ?? []),
        ...placeholders,
      ]),
    attachmentPlaceholderOffset: options.editAttachmentCount,
    onChanged: () => {
      options.scheduleDraft();
      options.updateChrome();
    },
    isStopped: options.isStopped,
    onHint: (message) => {
      options.chrome()?.setHint(message);
      options.updateChrome();
    },
    onRender: () => {
      if (!options.isStopped()) options.requestRender();
    },
  });
  options.editor.onChange = () => {
    options.onEditorChanged?.();
    options.scheduleDraft();
    options.updateChrome();
  };

  const goalFlow = new TuiGoalFlow({
    runtime: options.app.runtime,
    currentSessionId: () => options.controller.snapshot().session?.sessionId,
    ensureSessionId: async () => (await options.controller.ensureSession()).sessionId,
    banner: options.banner,
    composerDraft,
    editor: options.editor,
    surfaceHost: options.surfaceHost,
    append: options.append,
    setHint: (message) => options.chrome()?.setHint(message),
    ...(options.hasLiveRun ? { hasLiveRun: options.hasLiveRun } : {}),
    onChanged: () => {
      options.updateChrome();
      options.requestRender();
    },
  });
  return { composerDraft, goalFlow };
}
