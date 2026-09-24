import type { TuiIncidentSink, TuiObservability } from '../observability/index.js';
import type { McodeAuthPort } from '../auth/application.js';
import type { TuiRuntime, TuiWorkspaceRoot } from '../runtime/port.js';
import type { TuiCommandFlow } from '../tui/controller/product/command-flow.js';
import type {
  TuiAttachment,
  ResolveTuiAttachmentOptions,
} from '../tui/features/composer/attachments.js';
import type { ClipboardImageReader } from '../tui/features/composer/clipboard-image-draft.js';
import type { TuiCommandContribution } from '../tui/commands/catalog.js';
import type { TuiChatController } from '../tui/controller/chat-controller.js';
import type { TuiUpdateOptions } from '../tui/controller/product/update-flow.js';
import type { Terminal, TUI, TuiMode } from '../tui/engine/public.js';
import type { TuiProductFeatures } from '../tui/product-features.js';
import type { TuiInlinePanelHost, TuiSurfaceHost, TuiSurface } from '../tui/shell/index.js';
import type { TuiStateStore } from '../tui/state/index.js';
import type { TranscriptStore } from '../tui/transcript/store.js';
import type { Editor } from '../tui/widgets/editor/editor.js';
import type { TuiCustomStatusLineConfig } from '../host/custom-status-command.js';
import type { EditTuiDraftInExternalEditor } from '../host/external-editor.js';
import type { TuiTextClipboardReader, TuiTextClipboardWriter } from '../host/clipboard-text.js';
import type { TuiExternalTargetOpener } from '../host/open-external.js';
import type { TuiTranscriptExporter } from '../host/transcript-export.js';
import type { McodeBusinessTelemetry } from '../analytics/business-telemetry.js';
import type { TuiNotificationSettings } from '../tui/platform/terminal-notifications.js';
import type { TerminalCapabilities } from '../tui/platform/terminal-capabilities.js';
import type { MavisRegion } from '@mavis/config';
import type { TuiKeybindingOverride, TuiKeybindingRegistry } from '../tui/shell/keybindings.js';
import type { FindRecentCodexSession } from '../host/recent-codex-session.js';

export interface CreateTuiAppOptions extends TuiUpdateOptions {
  runtime: TuiRuntime;
  dataDir?: string;
  workspaceDir: string;
  workspaceRoots?: readonly TuiWorkspaceRoot[];
  homeDir?: string;
  terminal?: Terminal;
  terminalCapabilities?: TerminalCapabilities;
  tuiMode?: TuiMode;
  persistTuiMode?: (mode: TuiMode) => void;
  /** Saved theme selection, e.g. `aurora` or `aurora/dark`. */
  theme?: string;
  persistTheme?: (theme: string) => void;
  runtimeLogDirectory?: string;
  resolveAttachment?: (
    reference: string,
    options: ResolveTuiAttachmentOptions,
  ) => Promise<TuiAttachment>;
  readClipboardImage?: ClipboardImageReader;
  commandContributions?: readonly TuiCommandContribution[];
  defaultAgentName?: string;
  /**
   * Status line item ids, in display order, from `tui.statusLine`. Unknown ids
   * are ignored. Omit to use the build default.
   */
  statusLineItems?: readonly string[];
  persistStatusLineItems?: (items: readonly string[] | undefined) => Promise<void>;
  /**
   * Custom status command settings from `tui.customStatusLine`. Only used when
   * `statusLineItems` names `custom-command` without `build-mode`.
   */
  customStatusLine?: TuiCustomStatusLineConfig;
  /** Whether the idle conversation composer may show contextual Tips. Defaults to true. */
  showTips?: boolean;
  /** Ordered terminal title items from tui.terminalTitle; null or [] disables updates. */
  terminalTitle?: readonly string[] | null;
  notifications?: TuiNotificationSettings;
  /** Internal result-channel path; ignored unless statusLineItems enables build-mode. */
  automationResultPath?: string;
  productFeatures?: Partial<TuiProductFeatures>;
  observability?: TuiObservability;
  incidentReporter?: TuiIncidentSink;
  businessTelemetry?: McodeBusinessTelemetry;
  auth?: McodeAuthPort;
  externalEditorCommand?: string;
  editDraftInExternalEditor?: EditTuiDraftInExternalEditor;
  readClipboardText?: TuiTextClipboardReader;
  writeClipboardText?: TuiTextClipboardWriter;
  openExternalTarget?: TuiExternalTargetOpener;
  exportTranscript?: TuiTranscriptExporter;
  requestProcessSuspend?: () => void;
  keybindings?: TuiKeybindingRegistry;
  getTuiKeybindingOverrides?: () => Readonly<Record<string, TuiKeybindingOverride>>;
  saveTuiKeybindingOverrides?: (
    overrides: Readonly<Record<string, TuiKeybindingOverride>>,
  ) => Promise<void> | void;
  reloadTui?: () => Promise<void>;
  requestRestart?: (region?: MavisRegion, initialPrompt?: string) => void;
  notifyAuthContextChanged?: (authState: 'authenticated' | 'logged_out') => void | Promise<void>;
  resumeDraftAfterLogin?: boolean;
  findRecentCodexSession?: FindRecentCodexSession;
}

export interface TuiApp {
  tui: TUI;
  surfaceHost: TuiSurfaceHost;
  editor: Editor;
  interaction: TuiInlinePanelHost;
  controller: TuiChatController;
  state: TuiStateStore;
  transcript: TranscriptStore;
  ready: Promise<void>;
  firstFrame: Promise<void>;
  stopped: Promise<void>;
  getSurface(): TuiSurface;
  start(): void;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  openSession(sessionId: string): Promise<void>;
  continueLatestSession(): Promise<boolean>;
  /** Internal startup chrome shown while the embedded Runtime is initializing. */
  setStartupStatus(status?: string): void;
  submit(input: string): Promise<void>;
  /** Exposed for integration tests that submit with an explicit seed. */
  commandFlow: TuiCommandFlow;
  abortTurn(): Promise<boolean>;
  leaveUi(): Promise<void>;
  stop(options?: TuiStopOptions): Promise<void>;
}

export interface TuiStopOptions {
  readonly abortActiveTurn?: boolean;
}
