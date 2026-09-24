/**
 * Application composition helpers for `createTuiApp`.
 *
 * This file consolidates the previous `application-*.ts` set into a single
 * module so that the TUI composition root can import a flat list of
 * factories instead of jumping across five thin files. Each factory is
 * independent and is wired together by `app.ts`; the split is purely for
 * reader ergonomics, not because the factories share lifecycle.
 */

import { TuiComposerImagePreview } from './features/composer/image-preview.js';
import { createTuiExternalTargetOpener } from '../host/open-external.js';
import { readTuiClipboardText, writeTuiClipboardText } from '../host/clipboard-text.js';
import { formatTuiActionFailure } from '../user-facing-failure.js';
import type { McodeBusinessTelemetry } from '../analytics/business-telemetry.js';
import type { TuiBackgroundTask } from '../runtime/port.js';
import { TuiBusinessEventTracker } from '../analytics/tui-business-event-tracker.js';
import type {
  CreateTuiChatControllerOptions,
  TuiChatController,
  TuiChatSnapshot,
} from './controller/chat-controller.js';
import { TuiDelegationFlow } from './controller/delegation-flow.js';
import type { TuiAgentTeamSnapshot } from './agent-team/model.js';
import type { TuiFeatureFlow } from './controller/product/feature-flow.js';
import { TuiSessionMutationFlow } from './controller/product/session-mutation-flow.js';
import type { TuiSessionFlow } from './controller/session-flow.js';
import { createTuiInitialAutocomplete } from './controller/run/active-run-flow.js';
import { TuiActivityLine } from './shell/activity-line.js';
import { TuiChatLayout } from './shell/chat-layout.js';
import { TuiComposer } from './shell/composer.js';
import { TuiFollowUpPanel } from './shell/follow-up-panel.js';
import { TuiInlinePanelHost } from './shell/inline-panel.js';
import { TuiInteractionSurface } from './shell/interaction-surface.js';
import { TuiSurfaceHost } from './shell/surface-host.js';
import { TuiOverlayRegularFeaturePresenter } from './shell/regular-feature-presenter.js';
import { TuiTaskPanel } from './shell/task-panel.js';
import { createTuiWorkspaceStatusLine } from './shell/workspace-status-line.js';
import { TuiUpdateNotice, TuiWelcome } from './shell/chrome.js';
import { composerText } from './features/composer/copy.js';
import { TuiDraftLifecycle } from './features/composer/draft-lifecycle.js';
import { TuiDraftRecoveryError } from './features/composer/draft-recovery.js';
import type { TuiComposerDraft } from './features/composer/draft.js';
import type { TuiSubmissionSnapshot } from './features/composer/submission.js';
import {
  createTuiWorkspaceRoots,
  type TuiWorkspaceRoots,
} from './features/composer/workspace-roots.js';
import { TuiGoalBanner } from './features/goal/banner.js';
import {
  extractTuiVersionChangelogEntries,
  readPackagedTuiChangelog,
  selectRandomTuiItems,
} from './features/changelog/content.js';
import { detectProcessTerminalCapabilities } from './platform/terminal-capabilities.js';
import { createTuiTextClipboardWriter } from './platform/terminal-clipboard.js';
import { TuiTerminalNotifications } from './platform/terminal-notifications.js';
import { TuiTerminalTitle } from './platform/terminal-title.js';
import {
  ProcessTerminal,
  type Component,
  type Terminal,
  type TUI,
  type TuiMode,
} from './engine/public.js';
import { McodeInteractiveRenderer } from './renderer/index.js';
import type { TuiRunProjection } from './state/run-projection.js';
import type { TuiStateStore } from './state/index.js';
import { TuiThemeController } from './theme/controller.js';
import { tuiChalk, tuiColors, tuiEditorTheme } from './theme/runtime.js';
import { bindThemeRendering } from './theme/render-binding.js';
import type { TranscriptStore } from './transcript/store.js';
import type { LocalTranscriptCellKind } from './transcript/local-appender.js';
import type { TranscriptView } from './transcript/view.js';
import type { CreateTuiAppOptions } from '../types/tui-app.js';
import { Editor } from './widgets/editor/editor.js';
import { MINIMAX_CODE_DEFAULT_AGENT_NAME } from '../product-context.js';
import { createTuiAutomationResultWriter } from './automation/result-writer.js';
import { MINIMAX_CODE_WELCOME_DESIGN } from './shell/welcome/design.js';

// ---------------------------------------------------------------------------
// Small numeric / utility helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a free-form row count into the supported interaction overlay range.
 * Kept here because it is only consumed by the application composition layer.
 */
export function resolveTuiInteractionMaxRows(rows: number): number {
  const terminalRows = Number.isFinite(rows) ? rows : 24;
  return Math.max(4, Math.min(12, terminalRows - 6));
}

export function createTuiChatControllerComposition(options: CreateTuiAppOptions): {
  readonly defaultAgentName: string;
  readonly writeAutomationResult?: CreateTuiChatControllerOptions['writeAutomationResult'];
  readonly workspaceRoots: TuiWorkspaceRoots;
} {
  const defaultAgentName = options.defaultAgentName ?? MINIMAX_CODE_DEFAULT_AGENT_NAME;
  const writer = createTuiAutomationResultWriter({
    statusLineItems: options.statusLineItems,
    resultPath: options.automationResultPath,
  });
  return {
    defaultAgentName,
    workspaceRoots: createTuiWorkspaceRoots(options),
    ...(writer ? { writeAutomationResult: (result) => writer.write(result) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Renderer + terminal capabilities assembly
// ---------------------------------------------------------------------------

/**
 * Build the `ProcessTerminal` + `McodeInteractiveRenderer` + `TuiThemeController`
 * triad. Returned `themeController` is held by the caller so that
 * `McodeInteractiveRenderer.onRendererChanged` can rebind it after a
 * main/fullscreen mode switch.
 */
export function createTuiApplicationRenderer(options: CreateTuiAppOptions) {
  const terminal = options.terminal ?? new ProcessTerminal();
  const capabilities = options.terminalCapabilities ?? detectProcessTerminalCapabilities();
  const openExternalTarget =
    options.openExternalTarget ?? createTuiExternalTargetOpener(options.workspaceDir);
  const writeClipboardText =
    options.writeClipboardText ??
    createTuiTextClipboardWriter({
      terminal,
      capabilities,
      nativeWriter: writeTuiClipboardText,
    });
  const readClipboardText = options.readClipboardText ?? readTuiClipboardText;
  let themeController: TuiThemeController | undefined;
  const styleSearchMatch = (text: string): string => tuiChalk.hex(tuiColors.signal)(text);
  const renderer = new McodeInteractiveRenderer({
    terminal,
    initialMode: options.tuiMode ?? 'regular',
    logDirectory: options.runtimeLogDirectory,
    incidentReporter: options.incidentReporter,
    altScreen: {
      searchMatchStyle: (text) => tuiChalk.underline(styleSearchMatch(text)),
      searchCurrentMatchStyle: (text) => tuiChalk.bold.inverse(styleSearchMatch(text)),
      openUrl: (target) => {
        void openExternalTarget(target).catch(() => undefined);
      },
      onRightClickPaste: () => {
        void pasteFocusedComponentFromClipboard({
          getFocusedComponent: () => renderer.activeRenderer.getFocusedComponent(),
          readClipboardText,
          requestRender: () => renderer.ui.requestRender(),
        });
      },
      copySelection: async (text) => {
        try {
          await writeClipboardText(text);
          return true;
        } catch {
          return false;
        }
      },
    },
    onRendererChanged: () => themeController?.rebindUi(),
  });
  const tui = renderer.ui;
  const terminalNotifications = new TuiTerminalNotifications(
    {
      write: (data) => terminal.write(data),
      get focused() {
        return terminal.focused;
      },
    },
    { settings: options.notifications, capabilities },
  );
  const terminalTitle = new TuiTerminalTitle(terminal, capabilities.isTTY);
  themeController = new TuiThemeController({
    ui: tui,
    colorLevel: capabilities.colorLevel,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.theme ? { theme: options.theme } : {}),
    onDetection: (snapshot) => options.observability?.recordTheme?.(snapshot),
  });

  return {
    terminal,
    renderer,
    tui,
    terminalNotifications,
    terminalTitle,
    themeController,
    openExternalTarget,
    writeClipboardText,
  };
}

// ---------------------------------------------------------------------------
// Editor, draft lifecycle, session actions
// ---------------------------------------------------------------------------

/**
 * Build the `Editor` instance wired to the active `TUI` reference and the
 * workspace-roots-aware autocomplete provider.
 */
export function createTuiApplicationEditor(
  tui: TUI,
  workspaceRoots: TuiWorkspaceRoots,
  runtime: Parameters<typeof createTuiInitialAutocomplete>[1],
): Editor {
  const editor = new Editor(tui, tuiEditorTheme, {
    paddingX: 1,
    autocompleteMaxVisible: 8,
    placeholder: composerText('placeholder'),
  });
  editor.setAutocompleteProvider(createTuiInitialAutocomplete(workspaceRoots.list(), runtime));
  return editor;
}

interface TuiApplicationDraftOptions {
  readonly app: Pick<CreateTuiAppOptions, 'dataDir' | 'workspaceDir'>;
  readonly editor: Editor;
  readonly composerDraft: TuiComposerDraft;
  readonly setHint: (message: string) => void;
  readonly updateChrome: () => void;
  readonly append: (content: string, kind: 'warning') => void;
  readonly onRetryRestored?: (submission: TuiSubmissionSnapshot) => void;
}

/**
 * Build the draft persistence lifecycle bound to the editor + composer draft.
 * Translates `TuiDraftLifecycle` errors into user-facing warning cells.
 */
export function createTuiApplicationDraftLifecycle(
  options: TuiApplicationDraftOptions,
): TuiDraftLifecycle {
  return new TuiDraftLifecycle({
    ...(options.app.dataDir ? { dataDir: options.app.dataDir } : {}),
    workspaceDir: options.app.workspaceDir,
    editor: options.editor,
    composerDraft: options.composerDraft,
    onRestored: (message) => {
      options.setHint(message);
      options.updateChrome();
    },
    ...(options.onRetryRestored ? { onRetryRestored: options.onRetryRestored } : {}),
    onError: (error) => {
      const operation = error instanceof TuiDraftRecoveryError ? error.operation : 'save';
      const summaries = {
        save: 'draftSaveFailed',
        cleanup: 'draftCleanupFailed',
        migrate: 'draftMigrationFailed',
        load: 'draftRestoreFailed',
      } as const;
      options.append(
        formatTuiActionFailure(error, {
          summary: composerText(summaries[operation]),
          nextStep: composerText(
            operation === 'cleanup' ? 'draftCleanupNextStep' : 'draftRecoveryUnavailable',
          ),
        }),
        'warning',
      );
    },
  });
}

interface TuiApplicationSessionActionsOptions {
  readonly ready: Promise<void>;
  readonly sessionFlow: Pick<TuiSessionFlow, 'activateSessionById' | 'activateLatestSession'>;
  readonly workspaceDir: string;
  readonly append: (content: string, kind?: LocalTranscriptCellKind) => void;
}

/**
 * Open / continue-session entry points used by the launcher and
 * command palette. Both wrap `TuiSessionFlow` calls and surface failures
 * as user-facing error cells.
 */
export function createTuiApplicationSessionActions(options: TuiApplicationSessionActionsOptions): {
  openSession(sessionId: string): Promise<void>;
  continueLatestSession(): Promise<boolean>;
} {
  return {
    async openSession(sessionId) {
      await options.ready;
      try {
        await options.sessionFlow.activateSessionById(sessionId);
      } catch (error) {
        options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't open this conversation.",
            nextStep: 'Retry after the connection recovers.',
          }),
          'error',
        );
        throw error;
      }
    },
    async continueLatestSession() {
      await options.ready;
      try {
        return await options.sessionFlow.activateLatestSession(options.workspaceDir);
      } catch (error) {
        options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't continue the latest conversation.",
            nextStep: 'Retry after the connection recovers.',
          }),
          'error',
        );
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Widgets, layout, surface host
// ---------------------------------------------------------------------------

/**
 * Build the welcome/update/status/activity/composer/interaction/follow-up
 * widget bag that the layout layer composes. The widgets themselves are
 * stateless shells until bound to a `TuiChatController` later in `app.ts`.
 */
export function createTuiApplicationWidgets(options: {
  readonly app: CreateTuiAppOptions;
  readonly tui: TUI;
  readonly terminal: Terminal;
  readonly editor: Editor;
  readonly requestRender: () => void;
}) {
  const changelog = readPackagedTuiChangelog();
  const welcome = new TuiWelcome(
    {
      version: options.app.version,
      workspace: options.app.workspaceDir,
      homeDir: options.app.homeDir,
      runtimeStatus: 'starting',
    },
    options.app.keybindings,
    {
      tips: selectRandomTuiItems(MINIMAX_CODE_WELCOME_DESIGN.tipPool, 3),
      ...(changelog
        ? {
            changelogEntries: selectRandomTuiItems(
              extractTuiVersionChangelogEntries(changelog, options.app.version),
              3,
            ),
          }
        : {}),
    },
  );
  const updateNotice = new TuiUpdateNotice();
  const status = createTuiWorkspaceStatusLine(options.app, options.requestRender);
  const activity = new TuiActivityLine(
    { phase: 'idle' },
    {
      requestRender: () => options.tui.requestRender(),
      keybindings: options.app.keybindings,
    },
  );
  const imagePreview = new TuiComposerImagePreview({
    editor: options.editor,
    terminalRows: () => options.terminal.rows,
    requestRender: options.requestRender,
  });
  const composer = new TuiComposer(
    options.editor,
    {
      mode: 'message',
      surface: 'welcome',
    },
    {
      imagePreview,
      supportsShiftEnter: () => options.terminal.kittyProtocolActive,
      showTips: options.app.showTips,
      keybindings: options.app.keybindings,
    },
  );
  const interaction = new TuiInlinePanelHost();
  const followUp = new TuiFollowUpPanel({ keybindings: options.app.keybindings });
  const goal = new TuiGoalBanner({ requestRender: options.requestRender });
  const tasks = new TuiTaskPanel(options.app.keybindings);
  return {
    welcome,
    updateNotice,
    status,
    activity,
    composer,
    interaction,
    followUp,
    goal,
    tasks,
    imagePreview,
  };
}

export function checkTuiApplicationUpdate(
  options: CreateTuiAppOptions,
  notice: TuiUpdateNotice,
  isStopped: () => boolean,
  tui: Pick<TUI, 'requestRender'>,
): void {
  void options
    .checkForUpdate?.()
    .then((update) => {
      if (!update || isStopped()) return;
      notice.setAvailableVersion(update.latestVersion);
      tui.requestRender();
    })
    .catch(() => undefined);
}

/**
 * Build the chrome-level `TuiChatLayout` + `TuiSurfaceHost` +
 * fullscreen layout + theme render binding. The returned `interactionSurface`
 * is the bridge between inline panels and the renderer's render requests.
 */
export function createTuiApplicationSurface(options: {
  readonly terminal: Terminal;
  readonly tui: TUI;
  readonly editor: Editor;
  readonly controller: TuiChatController;
  readonly transcript: TranscriptStore;
  readonly transcriptView: TranscriptView;
  readonly widgets: ReturnType<typeof createTuiApplicationWidgets>;
  readonly themeController: TuiThemeController;
  readonly liveRunId: (snapshot?: TuiChatSnapshot) => string | undefined;
  readonly shouldResumeDraftAfterLogin: () => boolean;
  readonly isActive: () => boolean;
  readonly requestInteractionRender: () => void;
  readonly mode: () => TuiMode;
  readonly switchMode: (mode: TuiMode) => boolean;
  readonly chatMode: TuiMode;
}) {
  const { welcome, updateNotice, status, activity, composer, interaction, followUp, goal, tasks } =
    options.widgets;
  const layout = new TuiChatLayout(
    options.terminal,
    {
      surface: () => {
        const snapshot = options.controller.snapshot();
        return snapshot.session ||
          options.liveRunId(snapshot) ||
          options.transcript.length > 0 ||
          options.shouldResumeDraftAfterLogin()
          ? 'conversation'
          : 'welcome';
      },
      welcome,
      notice: updateNotice,
      transcript: options.transcriptView,
      interaction,
      goal,
      activity,
      followUp,
      tasks,
      composer,
      status,
    },
    () => (options.mode() === 'fullscreen' ? 'fixed' : 'document'),
  );
  const surfaceHost = new TuiSurfaceHost({
    chat: {
      component: layout,
      focus: options.editor,
      layoutRoot: layout.fullscreenLayoutRoot,
    },
    chatMode: options.chatMode,
    mode: options.mode,
    viewportRows: () => options.terminal.rows,
    regularFeaturePresenter: new TuiOverlayRegularFeaturePresenter(
      options.terminal,
      options.tui,
      () => options.tui.requestRender(),
    ),
    setFocus: (component) => options.tui.setFocus(component),
    requestRender: () => options.tui.requestImmediateRender(),
    switchMode: options.switchMode,
  });
  const themeRendering = bindThemeRendering(options.themeController, options.tui, options.isActive);
  options.tui.addChild(surfaceHost);
  const interactionSurface = new TuiInteractionSurface(
    interaction,
    surfaceHost,
    options.requestInteractionRender,
    (active) => {
      activity.setAnimationPaused(active);
      goal.setAnimationPaused(active);
    },
    () => layout.followBottom(),
  );
  return { layout, surfaceHost, fullscreenLayout: surfaceHost, themeRendering, interactionSurface };
}

// ---------------------------------------------------------------------------
// Telemetry + small identity helpers
// ---------------------------------------------------------------------------

/**
 * Build the business-event tracker. Returns `undefined` when no telemetry
 * sink was provided so the caller can skip wiring.
 */
export function createTuiBusinessEventTracker(options: {
  readonly telemetry?: McodeBusinessTelemetry;
  readonly workspaceDir: string;
  readonly controller: TuiChatController;
  readonly featureFlow: TuiFeatureFlow;
  readonly stateStore: TuiStateStore;
  readonly transcript: TranscriptStore;
}): TuiBusinessEventTracker | undefined {
  if (!options.telemetry) return undefined;
  return new TuiBusinessEventTracker(options.telemetry, {
    chatType: () => {
      const sessionId = options.controller.snapshot().session?.sessionId;
      const sessionState = sessionId
        ? options.stateStore.snapshot().sessions.get(sessionId)
        : undefined;
      return sessionState?.execution.subagents.size ? 'agent_team' : 'chat';
    },
    userMessageCount: () =>
      options.transcript.snapshot().filter((cell) => cell.kind === 'user').length,
    skillCommandNames: () =>
      new Set(
        options.featureFlow.skillCommands().map((command) => command.name.toLocaleLowerCase()),
      ),
  });
}

/**
 * Resolve the live "active turn id" from either the chat controller snapshot
 * or the runtime projection. Both must agree, but the projection is the
 * authoritative source after suspend/resume.
 */
export function createTuiRunIdentity(
  controller: TuiChatController,
  runProjection: TuiRunProjection,
) {
  const latestRuntimeTurnId = (): string | undefined =>
    runProjection.snapshot().latestRuntimeTurnId;
  const liveRunId = (snapshot: TuiChatSnapshot = controller.snapshot()) =>
    snapshot.activeTurnId ?? latestRuntimeTurnId();
  return { latestRuntimeTurnId, liveRunId };
}

/** Assemble Session-scoped product flows that share the delayed Session owner. */
export function createTuiApplicationSessionFeatures(options: {
  readonly app: CreateTuiAppOptions;
  readonly controller: TuiChatController;
  readonly transcript: TranscriptStore;
  readonly surfaceHost: TuiSurfaceHost;
  readonly editor: Editor;
  readonly sessionFlow: () => Pick<TuiSessionFlow, 'activateSessionById'>;
  readonly setHint: (message: string | undefined) => void;
  readonly append: (content: string, kind?: LocalTranscriptCellKind) => void;
  readonly setEditTranscriptBoundary: (sourceMessageId: string | undefined) => void;
  readonly onAgentTeamChanged: (snapshot: TuiAgentTeamSnapshot) => void;
  readonly onBackgroundTasksChanged: (tasks: readonly TuiBackgroundTask[]) => void;
  readonly onChanged: () => void;
  readonly hasLiveRun: () => boolean;
}) {
  const activateSessionById = (sessionId: string) =>
    options.sessionFlow().activateSessionById(sessionId);
  const sessionMutationFlow = new TuiSessionMutationFlow({
    runtime: options.app.runtime,
    controller: options.controller,
    sessionFlow: { activateSessionById },
    surfaceHost: options.surfaceHost,
    editor: options.editor,
    setHint: options.setHint,
    append: options.append,
    setEditTranscriptBoundary: options.setEditTranscriptBoundary,
    onChanged: options.onChanged,
    hasLiveRun: options.hasLiveRun,
    refreshProjection: async (sessionId) => {
      if (options.controller.snapshot().session?.sessionId !== sessionId) return;
      await options.controller.reconcileOwnerHistory();
      options.onChanged();
    },
    reloadSessionProjection: async (sessionId) => {
      if (options.controller.snapshot().session?.sessionId !== sessionId) return;
      await options.controller.loadSessionProjection(sessionId);
      options.onChanged();
    },
  });
  const delegationFlow = new TuiDelegationFlow({
    runtime: options.app.runtime,
    currentSession: () => options.controller.snapshot().session,
    surfaceHost: options.surfaceHost,
    openSession: activateSessionById,
    onAgentTeamChanged: options.onAgentTeamChanged,
    onBackgroundTasksChanged: options.onBackgroundTasksChanged,
    onChanged: options.onChanged,
    onError: (error) =>
      options.append(
        formatTuiActionFailure(error, {
          summary: "Couldn't refresh delegated agents.",
          nextStep: 'Their status will update when the connection recovers.',
        }),
        'warning',
      ),
  });
  return { sessionMutationFlow, delegationFlow };
}

// ---------------------------------------------------------------------------
// Cross-cutting helpers
// ---------------------------------------------------------------------------

/**
 * Paste clipboard text into the focused Pi component via the bracketed-paste
 * protocol. Used by the renderer's alt-screen right-click handler.
 *
 * Kept exported (rather than inlined into `createTuiApplicationRenderer`)
 * so the unit test can exercise the focus/race behavior without spinning
 * up a full renderer.
 */
export async function pasteFocusedComponentFromClipboard(options: {
  readonly getFocusedComponent: () => Component | null;
  readonly readClipboardText: () => Promise<string | null>;
  readonly requestRender: () => void;
}): Promise<void> {
  const target = options.getFocusedComponent();
  const handleInput = target?.handleInput;
  if (!target || !handleInput) return;
  const text = await options.readClipboardText().catch(() => null);
  if (!text || options.getFocusedComponent() !== target) return;
  handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
  options.requestRender();
}
