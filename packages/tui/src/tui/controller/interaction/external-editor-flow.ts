import {
  editTuiDraftInExternalEditor,
  resolveTuiExternalEditorCommand,
  type EditTuiDraftInExternalEditor,
} from '../../../host/external-editor.js';
import { formatTuiKeybinding, type TuiKeybindingRegistry } from '../../shell/keybindings.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

export const MINIMAX_CODE_EXTERNAL_EDITOR_SETUP_HINT = `Set MCODE_EDITOR, VISUAL, or EDITOR to use ${formatTuiKeybinding('composer.external-editor')}; GUI editors need --wait.`;

interface ExternalEditorDraft {
  getExpandedText(): string;
  setText(value: string): void;
  replaceTextUndoable?(value: string): void;
  pruneMissingAttachmentPlaceholders?(): void;
}

interface ExternalEditorTuiLifecycle {
  start(): void;
  stop(): void | Promise<void>;
  requestRender(force?: boolean): void;
}

export interface TuiExternalEditorFlowOptions {
  readonly editor: ExternalEditorDraft;
  readonly tui: ExternalEditorTuiLifecycle;
  readonly workspaceDir: string;
  readonly configuredCommand?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly editDraft?: EditTuiDraftInExternalEditor;
  readonly isAppStopped: () => boolean;
  readonly append: (content: string, kind: 'error') => void;
  readonly setHint: (message: string | undefined) => void;
  readonly onChanged: () => void;
  readonly keybindings?: TuiKeybindingRegistry;
}

export class TuiExternalEditorFlow {
  private opening = false;

  constructor(private readonly options: TuiExternalEditorFlowOptions) {}

  async open(): Promise<void> {
    if (this.opening || this.options.isAppStopped()) return;
    const command = resolveTuiExternalEditorCommand({
      configuredCommand: this.options.configuredCommand,
      env: this.options.env,
      platform: this.options.platform,
    });
    if (!command) {
      this.options.setHint(
        `Set MCODE_EDITOR, VISUAL, or EDITOR to use ${formatTuiKeybinding('composer.external-editor', this.options.keybindings)}; GUI editors need --wait.`,
      );
      this.options.onChanged();
      return;
    }

    const original = normalizeLineEndings(this.options.editor.getExpandedText());
    const shouldResumeTui = !this.options.isAppStopped();
    this.opening = true;
    try {
      if (shouldResumeTui) {
        this.options.setHint('External editor open · save and close to return.');
        this.options.onChanged();
        await this.options.tui.stop();
      }
      if (this.options.isAppStopped()) return;
      const edited = await (this.options.editDraft ?? editTuiDraftInExternalEditor)({
        command,
        draft: original,
        cwd: this.options.workspaceDir,
      });
      if (this.options.isAppStopped()) return;
      const normalized = normalizeLineEndings(edited);
      if (normalized !== original) {
        if (this.options.editor.replaceTextUndoable) {
          this.options.editor.replaceTextUndoable(normalized);
        } else {
          this.options.editor.setText(normalized);
        }
        this.options.editor.pruneMissingAttachmentPlaceholders?.();
        this.options.setHint('External edit applied.');
      } else {
        this.options.setHint('External editor closed · draft unchanged.');
      }
      this.options.onChanged();
    } catch (error) {
      if (!this.options.isAppStopped()) {
        this.options.setHint(undefined);
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't open the external editor.",
            nextStep: 'Check $VISUAL or $EDITOR and retry.',
            preservation: 'Your draft is preserved.',
          }),
          'error',
        );
        this.options.onChanged();
      }
    } finally {
      this.opening = false;
      if (shouldResumeTui && !this.options.isAppStopped()) {
        this.options.tui.start();
        this.options.tui.requestRender(true);
      }
    }
  }
}

function normalizeLineEndings(value: string): string {
  return value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
}
