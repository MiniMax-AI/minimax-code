import { formatContextWindow } from '../../features/model/context-window.js';
import type {
  TuiConfigurationPort,
  TuiDailyCheckin,
  TuiInspectionPort,
  TuiInteractionPort,
  TuiModel,
  TuiSession,
  TuiSessionPort,
  TuiSessionForkPort,
  TuiSkillList,
  TuiWorkspaceGitPort,
} from '../../../runtime/port.js';
import type { TuiMessage } from '../../../runtime/stream-events.js';
import type { TuiCommand } from '../../commands/catalog.js';
import {
  createTuiMcpInspectionPanel,
  createTuiSkillsInspectionPanel,
} from '../../features/inspection/capabilities.js';
import { TuiReportInspectionPanel } from '../../features/inspection/report-panel.js';
import { TuiModelPicker } from '../../features/model/picker.js';
import { TuiCodexLogin } from '../../features/auth/codex-login.js';
import { TuiProviderManager } from '../../features/provider/manager.js';
import {
  TuiProviderOnboarding,
  type TuiProviderOnboardingResult,
} from '../../features/provider/onboarding.js';
import { TuiPluginManager } from '../../features/plugin/manager.js';
import { TuiSessionManager } from '../../features/session/manager.js';
import { TuiTranscriptPanel } from '../../features/transcript/panel.js';
import { TuiChangelogPanel } from '../../features/changelog/panel.js';
import {
  extractTuiChangelogMarkdown,
  readPackagedTuiChangelog,
} from '../../features/changelog/content.js';
import {
  createTuiAccountStatusInspection,
  createTuiConfigInspection,
  createTuiRuntimeInspection,
  createTuiUsageInspection,
  formatTuiAccountStatus,
  formatTuiConfigSummary,
  formatTuiPermissions,
  formatTuiRuntimeDiagnostics,
  formatTuiUsage,
} from '../../features/inspection/product-inspection.js';
import type { TranscriptInspectionReport } from '../../transcript/model.js';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Component } from '../../rendering/component.js';
import type { TuiPlanModeSnapshot } from '../interaction/plan-mode-flow.js';
import type { TuiInteractionSurface } from '../../shell/interaction-surface.js';
import type { Editor } from '../../widgets/editor/editor.js';
import type { TuiFeatureScreenHandle, TuiSurfaceHost } from '../../shell/surface-host.js';
import type { TranscriptStore } from '../../transcript/store.js';
import type { TranscriptView } from '../../transcript/view.js';
import { formatTuiSessionMarkdown, latestAssistantReply } from '../../transcript/export.js';
import {
  writeTuiClipboardText,
  type TuiTextClipboardWriter,
} from '../../../host/clipboard-text.js';
import {
  createTuiExternalTargetOpener,
  type TuiExternalTargetOpener,
} from '../../../host/open-external.js';
import { buildTuiSkillCommands } from '../run/active-run-flow.js';
import type { TuiChatController } from '../chat-controller.js';
import { TuiModelState } from './model-state.js';
import { isRuntimeErrorCode, isRuntimeMethodNotImplemented } from '../support.js';
import { resolveTuiThinkingChoice } from '../../features/model/thinking.js';
import { McodeProviderApplication } from '../../../provider/application.js';
import type { McodeCodexOAuthStatus, McodeProviderTemplate } from '../../../provider/contract.js';
import { McodePluginApplication } from '../../../plugin/application.js';
import type { McodePluginRuntimeAccess, McodePluginView } from '../../../plugin/contract.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import type { TuiTranscriptExporter } from '../../../host/transcript-export.js';
import { TuiSessionForkFlow } from '../session-fork-flow.js';
import { hyperlink } from '../../engine/public.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { MINIMAX_CODE_VERSION } from '../../../build-info.js';
import { formatTuiDailyCheckinOutcome } from '../../../checkin/presentation.js';

const OFFICIAL_MODEL_LOGIN_HINT = 'Sign in with /login to use official MiniMax models.';
const SESSION_MANAGER_PAGE_SIZE = 50;
const SESSION_MANAGER_MAX_ROWS = 24;
const SESSION_EXPORT_PAGE_SIZE = 200;

type FeatureRuntime = TuiSessionPort &
  TuiConfigurationPort &
  TuiDailyCheckin &
  TuiInspectionPort &
  TuiInteractionPort &
  TuiWorkspaceGitPort &
  McodePluginRuntimeAccess &
  Partial<TuiSessionForkPort>;

type AppendLocalCell = (
  content: string,
  kind?: 'final-summary' | 'warning' | 'error' | 'inspection',
  inspection?: TranscriptInspectionReport,
) => void;

interface FeatureInspectionResult {
  readonly content: string;
  readonly inspection: TranscriptInspectionReport;
}

interface ReportInspectionResult {
  readonly content: string;
  readonly inspection?: TranscriptInspectionReport;
}

export interface TuiFeatureFlowOptions {
  readonly runtime: FeatureRuntime;
  readonly controller: TuiChatController;
  readonly surface: TuiInteractionSurface;
  readonly surfaceHost: TuiSurfaceHost;
  readonly editor: Editor;
  readonly transcript: TranscriptStore;
  readonly transcriptView: TranscriptView;
  readonly writeClipboardText?: TuiTextClipboardWriter;
  readonly openExternalTarget?: TuiExternalTargetOpener;
  readonly exportTranscript?: TuiTranscriptExporter;
  readonly workspaceDir: string;
  readonly version?: string;
  readonly planMode?: () => TuiPlanModeSnapshot;
  readonly defaultAgentName: string;
  readonly terminalRows: () => number;
  readonly append: AppendLocalCell;
  readonly setCompacting: (active: boolean) => void;
  readonly setHint: (message: string) => void;
  readonly onChanged: () => void;
  readonly onNewSession: () => void;
  readonly onOpenSession: (sessionId: string) => Promise<void>;
  readonly onArchivedCurrentSession: (sessionId: string) => Promise<void>;
  readonly refreshAutocomplete: () => void;
  /** Starts the `/login` sign-in flow; absent when the host has no auth. */
  readonly onStartMiniMaxLogin?: () => void;
  readonly loadProviderTemplates?: () => Promise<readonly McodeProviderTemplate[]>;
  readonly isStopped?: () => boolean;
  readonly hasLiveRun?: () => boolean;
}

export interface TuiSessionManagerOpenOptions {
  /** Select this Session and enter rename mode after the manager loads. */
  readonly initialRenameSessionId?: string;
}

export class TuiFeatureFlow {
  private readonly modelState: TuiModelState;
  private readonly providerApplication: McodeProviderApplication;
  private readonly pluginApplication: McodePluginApplication;
  private readonly sessionForkFlow: TuiSessionForkFlow;
  private skillCommandsValue: TuiCommand[] = [];
  private inspectionPanel: Component | undefined;
  private modelPicker: Component | undefined;
  private providerManager: Component | undefined;
  private codexLogin: TuiCodexLogin | undefined;
  private providerOnboarding: Component | undefined;
  private transcriptScreen: TuiFeatureScreenHandle | undefined;
  private pluginScreen: TuiFeatureScreenHandle | undefined;
  private sessionGeneration = 0;
  private modelLoadSequence = 0;
  private providerLoadSequence = 0;
  private pluginLoadSequence = 0;
  private skillRefreshSequence = 0;
  private sessionManagerLoadSequence = 0;
  private compactionSequence = 0;
  private compacting = false;
  private stopped = false;
  /** Also carry an in-flight welcome choice into the first Session before its
   * Turn is admitted; the global default is persisted by the same selection. */
  private pendingSessionModelSelection:
    | { readonly model: TuiModel; readonly effort: string }
    | undefined;
  private welcomeModelSelectionSettlement: Promise<void> = Promise.resolve();

  constructor(private readonly options: TuiFeatureFlowOptions) {
    this.modelState = new TuiModelState({
      runtime: options.runtime,
      currentSessionId: () => options.controller.snapshot().session?.sessionId,
      onChanged: options.onChanged,
      isStopped: () => this.isStopped(),
    });
    this.providerApplication = new McodeProviderApplication(options.runtime);
    this.pluginApplication = new McodePluginApplication(options.runtime);
    this.sessionForkFlow = new TuiSessionForkFlow({
      runtime: options.runtime,
      currentSession: () => options.controller.snapshot().session,
      isSessionIdle: () => options.controller.snapshot().status === 'idle',
      onOpenSession: options.onOpenSession,
      isStopped: () => this.isStopped(),
    });
  }

  selectedModel(): TuiModel | undefined {
    return this.modelState.selected();
  }

  selectedEffort(): string | undefined {
    return this.modelState.selectedEffort();
  }

  refreshSelectedModel(sessionId?: string): Promise<TuiModel | undefined> {
    return this.modelState.refresh(sessionId);
  }

  /**
   * Settles the latest welcome-screen selection before Session creation can
   * make that no-Session write stale.
   */
  async waitForWelcomeModelSelection(): Promise<void> {
    let settlement: Promise<void>;
    do {
      settlement = this.welcomeModelSelectionSettlement;
      await settlement;
    } while (settlement !== this.welcomeModelSelectionSettlement);
  }

  /** Applies the parked effort after Session creation and before the first
   * Turn. A rejected write keeps the choice pending for a retry. */
  async applyPendingModelSelection(sessionId: string): Promise<void> {
    await this.waitForWelcomeModelSelection();
    const pending = this.pendingSessionModelSelection;
    if (!pending) return;
    const result = await this.modelState.select(
      { ...pending.model, thinking: { effort: pending.effort } },
      sessionId,
    );
    if (result.status !== 'selected') {
      throw new Error(
        `Runtime rejected the pending model effort before the first message (${result.status}).`,
      );
    }
    if (this.pendingSessionModelSelection === pending) {
      this.pendingSessionModelSelection = undefined;
    }
  }

  private currentSessionId(): string | undefined {
    return this.options.controller.snapshot().session?.sessionId;
  }

  skillCommands(): readonly TuiCommand[] {
    return this.skillCommandsValue;
  }

  resetSessionState(): void {
    this.invalidateFeatureLoads();
    this.setCompacting(false);
    this.modelState.reset();
    this.pendingSessionModelSelection = undefined;
    this.welcomeModelSelectionSettlement = Promise.resolve();
    this.closeFeatureSurfaces();
    this.options.onChanged();
  }

  stop(): void {
    this.stopped = true;
    void this.codexLogin?.cancel();
    this.invalidateFeatureLoads({ includeSkillRefresh: true });
    this.modelState.stop();
    this.setCompacting(false);
    this.closeFeatureSurfaces();
  }

  stageCommand(command: TuiCommand): void {
    this.options.editor.setText(command.composerTemplate);
    this.options.surfaceHost.setChatFocus(this.options.editor);
    this.options.setHint(`ready: ${command.usage}`);
    this.options.onChanged();
  }

  showTranscript(): void {
    this.openTranscript();
  }

  async exportCurrentTranscript(rawPath = ''): Promise<void> {
    if (this.isStopped()) return;
    const session = this.options.controller.snapshot().session;
    if (!session) {
      this.options.setHint('Start or resume a Session before exporting it.');
      this.options.onChanged();
      return;
    }
    const exporter = this.options.exportTranscript;
    if (!exporter) {
      this.options.setHint('Transcript export is unavailable.');
      this.options.onChanged();
      return;
    }

    let outputPath: string | undefined;
    try {
      outputPath = parseExportPath(rawPath);
    } catch (error) {
      this.options.append(error instanceof Error ? error.message : String(error), 'warning');
      return;
    }

    const sessionId = session.sessionId;
    const sessionGeneration = this.sessionGeneration;
    this.options.setHint('Exporting Session as Markdown…');
    this.options.onChanged();
    try {
      const messages = await loadAllSessionMessages(this.options.runtime, sessionId);
      if (!this.isCurrentSession(sessionId, sessionGeneration)) return;
      if (!messages.some((message) => message.role === 'user' || message.role === 'assistant')) {
        throw new Error('No conversation content to export.');
      }
      const exportedAtMs = Date.now();
      const markdown = formatTuiSessionMarkdown(messages, {
        sessionId,
        title: session.title,
        exportedAtMs,
      });
      const file = await exporter({
        sessionId,
        markdown,
        exportedAtMs,
        ...(outputPath ? { outputPath } : {}),
        workspaceDirectory: this.options.workspaceDir,
      });
      if (!this.isCurrentSession(sessionId, sessionGeneration)) return;
      this.options.setHint('');
      this.options.append(
        `Exported Markdown: ${hyperlink(basename(file), pathToFileURL(file).href)}`,
      );
    } catch (error) {
      if (!this.isCurrentSession(sessionId, sessionGeneration)) return;
      this.options.setHint('');
      this.options.append(
        formatTuiActionFailure(error, {
          summary: "Couldn't export the Session.",
          nextStep: 'Check the path and permissions, then retry /export.',
        }),
        'warning',
      );
    }
  }

  showForkTranscript(): void {
    this.openTranscript((messageId) => this.sessionForkFlow.forkFromUserMessage(messageId));
  }

  private openTranscript(onForkFromUserMessage?: (messageId: string) => Promise<void>): void {
    if (this.isStopped() || this.transcriptScreen?.isActive()) return;
    this.closeTranscript();
    let handle: TuiFeatureScreenHandle | undefined;
    const exporter = this.options.exportTranscript;
    const panel = new TuiTranscriptPanel({
      source: this.options.transcript,
      onCancel: () => {
        if (handle?.close()) this.transcriptScreen = undefined;
      },
      requestRender: this.options.onChanged,
      writeClipboardText: this.options.writeClipboardText ?? writeTuiClipboardText,
      workspaceDir: this.options.workspaceDir,
      openExternalTarget:
        this.options.openExternalTarget ?? createTuiExternalTargetOpener(this.options.workspaceDir),
      ...(exporter
        ? {
            exportTranscript: async (markdown: string) => {
              const session = this.options.controller.snapshot().session;
              if (!session) throw new Error('Start or resume a Session before exporting.');
              return exporter({
                sessionId: session.sessionId,
                markdown,
                exportedAtMs: Date.now(),
              });
            },
          }
        : {}),
      exportMetadata: () => {
        const session = this.options.controller.snapshot().session;
        return {
          sessionId: session?.sessionId,
          title: session?.title || 'MCode Transcript',
          exportedAtMs: Date.now(),
        };
      },
      ...(onForkFromUserMessage ? { onForkFromUserMessage } : {}),
    });
    handle = this.options.surfaceHost.pushFeature({ screen: panel, focus: panel });
    this.transcriptScreen = handle;
  }

  async copyLastAssistantReply(): Promise<void> {
    if (this.isStopped()) return;
    const reply = latestAssistantReply(this.options.transcript);
    if (!reply) {
      this.options.setHint('No Assistant response to copy.');
      this.options.onChanged();
      return;
    }
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    const sessionGeneration = this.sessionGeneration;
    try {
      await (this.options.writeClipboardText ?? writeTuiClipboardText)(reply);
      if (!this.isCurrentSession(sessionId, sessionGeneration)) return;
      this.options.setHint('Copied last response as Markdown.');
    } catch (error) {
      if (!this.isCurrentSession(sessionId, sessionGeneration)) return;
      this.options.setHint(
        formatTuiActionFailure(error, {
          summary: "Couldn't copy the last response.",
          nextStep: 'Open /transcript and copy it manually.',
        }),
      );
    }
    this.options.onChanged();
  }

  toggleTranscriptDetails(): 'compact' | 'detailed' {
    return this.options.transcriptView.toggleDetailMode();
  }

  async showChangelog(): Promise<void> {
    if (this.isStopped()) return;
    this.closeInspectionPanel();
    try {
      const source = readPackagedTuiChangelog();
      if (!source) throw new Error('Packaged changelog is missing.');
      if (this.isStopped()) return;
      const panel = new TuiChangelogPanel({
        markdown: extractTuiChangelogMarkdown(source),
        version: MINIMAX_CODE_VERSION,
        onClose: () => this.closeInspectionPanel(panel),
        requestRender: this.options.onChanged,
      });
      this.inspectionPanel = panel;
      this.options.surface.show(panel);
    } catch (error) {
      this.options.append(
        formatTuiActionFailure(error, {
          summary: "Couldn't load the packaged changelog.",
          nextStep: 'Reinstall or update MCode, then retry /changelog.',
        }),
        'warning',
      );
    }
  }

  isFeatureScreenActive(): boolean {
    return this.options.surfaceHost.getActiveSurface().kind === 'feature';
  }

  async refreshSkillCommands(current?: TuiSkillList): Promise<TuiSkillList> {
    const agentName =
      this.options.controller.snapshot().session?.agentName ?? this.options.defaultAgentName;
    const refreshSequence = ++this.skillRefreshSequence;
    const result = current ?? (await this.options.runtime.listSkills(agentName));
    const currentAgentName =
      this.options.controller.snapshot().session?.agentName ?? this.options.defaultAgentName;
    if (
      this.isStopped() ||
      refreshSequence !== this.skillRefreshSequence ||
      currentAgentName !== agentName
    ) {
      return result;
    }
    this.skillCommandsValue = buildTuiSkillCommands(result);
    this.options.refreshAutocomplete();
    return result;
  }

  async showSessionManager(
    initialQuery = '',
    openOptions: TuiSessionManagerOpenOptions = {},
  ): Promise<void> {
    if (this.isStopped()) return;
    const sourceCommand = openOptions.initialRenameSessionId ? '/rename' : '/sessions';
    if (this.rejectLiveSessionNavigation(sourceCommand)) return;
    this.closeInspectionPanel();
    const sessionGeneration = this.sessionGeneration;
    const loadSequence = ++this.sessionManagerLoadSequence;
    const snapshot = this.options.controller.snapshot();
    const loadSessionPage = (scope: 'workspace' | 'all', cursor?: string) =>
      this.options.runtime.listSessionPage({
        allAgents: true,
        ...(scope === 'workspace' ? { workspaceDir: this.options.workspaceDir } : {}),
        limit: SESSION_MANAGER_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        includeArchived: true,
        includeHidden: true,
      });
    const firstPage = await loadSessionPage('workspace').catch((error: unknown) => {
      if (!this.isStopped()) {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't load all conversations.",
            nextStep: 'Retry /sessions.',
            preservation: 'Showing saved results.',
          }),
          'warning',
        );
      }
      return {
        sessions: snapshot.sessions,
        hasMore: false,
        nextCursor: undefined,
      };
    });
    if (
      this.isStopped() ||
      sessionGeneration !== this.sessionGeneration ||
      loadSequence !== this.sessionManagerLoadSequence
    ) {
      return;
    }
    if (this.rejectLiveSessionNavigation(sourceCommand)) return;
    let loadedScope: 'workspace' | 'all' = 'workspace';
    let nextCursor = firstPage.nextCursor;
    const sessions =
      snapshot.session &&
      !firstPage.sessions.some((session) => session.sessionId === snapshot.session?.sessionId)
        ? [snapshot.session, ...firstPage.sessions]
        : firstPage.sessions;
    const manager = new TuiSessionManager({
      sessions,
      hasMore: firstPage.hasMore && Boolean(nextCursor),
      activeSessionId: snapshot.session?.sessionId,
      initialRenameSessionId: openOptions.initialRenameSessionId,
      workspaceDir: this.options.workspaceDir,
      initialQuery,
      onLoadMore: async () => {
        if (!nextCursor) return { sessions: [], hasMore: false };
        const page = await loadSessionPage(loadedScope, nextCursor);
        nextCursor = page.nextCursor;
        return {
          sessions: page.sessions,
          hasMore: page.hasMore && Boolean(nextCursor),
        };
      },
      onScopeChange: async (scope) => {
        const page = await loadSessionPage(scope);
        loadedScope = scope;
        nextCursor = page.nextCursor;
        return {
          sessions: page.sessions,
          hasMore: page.hasMore && Boolean(nextCursor),
        };
      },
      onSelect: async (sessionId) => {
        if (this.rejectLiveSessionNavigation('/sessions')) {
          throw new Error('Stop the running turn before switching Sessions.');
        }
        await this.options.onOpenSession(sessionId);
        this.options.surface.close(manager);
      },
      onNew: async () => {
        if (this.rejectLiveSessionNavigation('/new')) return;
        this.options.onNewSession();
        this.options.surface.close(manager);
      },
      onRename: async (sessionId, title) => {
        if (this.rejectLiveSessionNavigation('/rename')) {
          throw new Error('Stop the running turn before renaming a Session.');
        }
        const renamed = await this.options.controller.renameSession(sessionId, title);
        this.options.onChanged();
        return renamed;
      },
      onSetArchived: async (sessionId, archived) => {
        const wasCurrent = this.options.controller.snapshot().session?.sessionId === sessionId;
        if (this.rejectLiveSessionNavigation('/sessions')) {
          throw new Error('Stop the running turn before archiving or restoring a Session.');
        }
        await this.options.controller.setSessionArchived(sessionId, archived);
        if (archived && wasCurrent) await this.options.onArchivedCurrentSession(sessionId);
        this.options.onChanged();
      },
      onCancel: () => this.options.surface.close(manager),
      requestRender: this.options.onChanged,
      maxRows: () => this.sessionManagerMaxRows(),
    });
    this.options.surface.show(manager);
  }

  async showModelPicker(query: string): Promise<void> {
    if (this.isStopped()) return;
    this.closeModelPicker();
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    const sessionGeneration = this.sessionGeneration;
    const loadSequence = ++this.modelLoadSequence;
    let models: TuiModel[];
    let managedTokenPresent = false;
    let codexOAuthStatus: McodeCodexOAuthStatus;
    try {
      const [modelCatalog, account, codexStatus] = await Promise.all([
        this.options.runtime.listModels(sessionId),
        this.options.runtime.getAccountStatus(sessionId),
        this.options.runtime.getCodexOAuthStatus().catch(
          (): McodeCodexOAuthStatus => ({
            state: 'hidden',
            providerId: 'openai-codex',
          }),
        ),
      ]);
      models = modelCatalog;
      managedTokenPresent = account.managedTokenPresent === true;
      codexOAuthStatus = codexStatus;
    } catch (error) {
      if (this.isCurrentSessionRequest(sessionId, sessionGeneration, loadSequence)) {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't load models.",
            nextStep: 'Retry /model.',
          }),
          'warning',
        );
      }
      return;
    }
    if (!this.isCurrentSessionRequest(sessionId, sessionGeneration, loadSequence)) return;
    const normalizedQuery = query.trim();
    const picker = new TuiModelPicker(
      models,
      (model, effort) => {
        if (
          this.modelPicker !== picker ||
          !this.isCurrentSessionRequest(sessionId, sessionGeneration, loadSequence)
        ) {
          return;
        }
        this.options.surface.close(picker);
        this.modelPicker = undefined;
        const chosenEffort = effort?.trim() || undefined;
        if (!sessionId) this.pendingSessionModelSelection = undefined;
        const selection = this.modelState
          .select(
            {
              ...model,
              thinking: chosenEffort ? { effort: chosenEffort } : undefined,
            },
            sessionId,
          )
          .then((result) => {
            if (result.status !== 'selected') {
              if (result.status === 'rejected') {
                this.options.append(
                  "Couldn't switch models. The previous model is still selected. Retry /model.",
                  'error',
                );
                void this.modelState.refresh(sessionId);
              }
              return;
            }
            const contextLabel = model.contextLimit
              ? ` · Context ${formatContextWindow(model.contextLimit)}`
              : '';
            const effortLabel = chosenEffort ? ` · Effort ${chosenEffort}` : '';
            const thinking = chosenEffort ? undefined : resolveTuiThinkingChoice(model);
            const variant =
              thinking === undefined && !chosenEffort && model.variant ? `#${model.variant}` : '';
            const thinkingLabel = thinking ? ` · Thinking ${thinking === 'on' ? 'On' : 'Off'}` : '';
            // Persist the global default now and also apply the welcome choice
            // to the first Session before its Turn.
            const parked = Boolean(chosenEffort) && !sessionId;
            this.pendingSessionModelSelection =
              parked && chosenEffort ? { model: result.model, effort: chosenEffort } : undefined;
            this.options.append(
              `Model selected: ${model.providerId}/${model.modelId}${variant}${thinkingLabel}${effortLabel}${contextLabel}${
                sessionId ? ' for this session and saved as the default' : ' as the default'
              }.${parked ? ' Think effort applies before the first message is sent.' : ''}`,
            );
            this.warnModelCacheImpact(
              models.find((candidate) => candidate.selected),
              result.model,
              sessionId,
            );
            this.options.controller.refreshStatusMetricsNow();
            if (sessionId) void this.modelState.refresh(sessionId);
            return result;
          });
        if (!sessionId) {
          this.welcomeModelSelectionSettlement = selection.then(
            () => undefined,
            () => undefined,
          );
        }
        void selection.catch((error: unknown) => {
          if (this.isCurrentSession(sessionId, sessionGeneration)) {
            this.options.append(
              formatTuiActionFailure(error, {
                summary: "Couldn't switch models.",
                nextStep: 'Retry /model.',
                preservation: 'The previous model is still selected.',
              }),
              'error',
            );
            void this.modelState.refresh(sessionId);
          }
        });
      },
      () => {
        this.options.surface.close(picker);
        if (this.modelPicker === picker) this.modelPicker = undefined;
      },
      {
        isUnavailable: (model) => model.providerKind === 'minimax-managed' && !managedTokenPresent,
        onUnavailable: () => this.options.append(OFFICIAL_MODEL_LOGIN_HINT, 'warning'),
        ...(codexOAuthStatus.state === 'hidden'
          ? {}
          : {
              codexOAuth: {
                state: codexOAuthStatus.state,
                onConnect: () => {
                  if (
                    this.modelPicker !== picker ||
                    !this.isCurrentSessionRequest(sessionId, sessionGeneration, loadSequence)
                  ) {
                    return;
                  }
                  this.closeModelPicker();
                  this.showCodexLogin('model');
                },
              },
            }),
        onAddProvider: () => {
          this.closeModelPicker();
          void this.showProviderOnboarding();
        },
        ...(this.options.runtime.setModelFavorite
          ? {
              // The picker updates the row first and rolls back on failure.
              onToggleFavorite: (model: TuiModel, favorite: boolean) =>
                this.options.runtime.setModelFavorite?.(
                  { providerId: model.providerId, modelId: model.modelId },
                  favorite,
                ) ?? false,
            }
          : {}),
        onDeleteProvider: async (providerId) => {
          if (
            this.modelPicker !== picker ||
            !this.isCurrentSessionRequest(sessionId, sessionGeneration, loadSequence)
          ) {
            return;
          }
          const providerModels = models.filter((model) => model.providerId === providerId);
          const providerName = sanitizeTerminalText(
            providerModels[0]?.providerName?.trim() || providerId,
          );
          if (sessionId && providerModels.some((model) => model.selected)) {
            throw new Error('Switch to another model before deleting this provider');
          }
          await this.providerApplication.remove(providerId);
          if (!this.isCurrentSessionRequest(sessionId, sessionGeneration, loadSequence)) return;
          if (this.pendingSessionModelSelection?.model.providerId === providerId) {
            this.pendingSessionModelSelection = undefined;
          }
          await this.modelState.refresh(sessionId);
          if (!this.isCurrentSessionRequest(sessionId, sessionGeneration, loadSequence)) return;
          this.options.append(
            `Provider deleted: ${providerName} · ${providerModels.length} model${providerModels.length === 1 ? '' : 's'} removed.`,
          );
          this.options.controller.refreshStatusMetricsNow();
          await this.showModelPicker('');
        },
        requestRender: this.options.onChanged,
        ...(!managedTokenPresent && models.some((model) => model.providerKind === 'minimax-managed')
          ? { unavailableHint: OFFICIAL_MODEL_LOGIN_HINT }
          : {}),
      },
      this.modelState.selectedEffort(),
      normalizedQuery,
    );
    this.closeModelPicker();
    this.modelPicker = picker;
    this.options.surface.show(picker);
  }

  private async showProviderOnboarding(): Promise<void> {
    if (this.isStopped()) return;
    this.closeProviderManager();
    this.closeProviderOnboarding();
    const sessionId = this.currentSessionId();
    const sessionGeneration = this.sessionGeneration;
    const loadSequence = ++this.providerLoadSequence;
    this.options.setHint('Loading provider catalog…');
    this.options.onChanged();
    let templates: readonly McodeProviderTemplate[] = [];
    let catalogWarning: string | undefined;
    try {
      templates = await (
        this.options.loadProviderTemplates ?? (() => this.options.runtime.listProviderPresets())
      )();
    } catch {
      catalogWarning = 'Known providers unavailable; Custom remains available.';
    }
    if (
      !this.isCurrentSession(sessionId, sessionGeneration) ||
      loadSequence !== this.providerLoadSequence
    ) {
      return;
    }
    this.options.setHint('');
    let providers;
    try {
      providers = (await this.providerApplication.snapshot()).providers;
    } catch (error) {
      if (
        this.isCurrentSession(sessionId, sessionGeneration) &&
        loadSequence === this.providerLoadSequence
      ) {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't load saved connections.",
            nextStep: 'Retry /model or /provider.',
          }),
          'warning',
        );
      }
      return;
    }
    if (
      !this.isCurrentSession(sessionId, sessionGeneration) ||
      loadSequence !== this.providerLoadSequence
    )
      return;
    const onboarding: TuiProviderOnboarding = new TuiProviderOnboarding({
      templates,
      providers,
      ...(catalogWarning ? { catalogWarning } : {}),
      onSave: (input) => this.providerApplication.saveCandidate(input),
      onComplete: (result) =>
        this.completeProviderOnboarding(onboarding, result, sessionId, sessionGeneration),
      onCancel: () => this.closeProviderOnboarding(),
      requestRender: this.options.onChanged,
    });
    this.providerOnboarding = onboarding;
    this.options.surface.show(onboarding);
  }

  private async completeProviderOnboarding(
    onboarding: Component,
    result: TuiProviderOnboardingResult,
    sessionId: string | undefined,
    sessionGeneration: number,
  ): Promise<void> {
    if (!this.isCurrentSession(sessionId, sessionGeneration)) return;
    let selected = !sessionId;
    let previousModel: TuiModel | undefined;
    let selectedModel: TuiModel | undefined;
    if (sessionId && result.providerId) {
      try {
        const models = await this.options.runtime.listModels(sessionId);
        if (!this.isCurrentSession(sessionId, sessionGeneration)) return;
        const model = models.find(
          (candidate) =>
            candidate.providerId === result.providerId && candidate.modelId === result.modelId,
        );
        if (model) {
          previousModel = models.find((candidate) => candidate.selected);
          const selection = await this.modelState.select(model, sessionId);
          selected = selection.status === 'selected';
          if (selection.status === 'selected') selectedModel = selection.model;
        }
      } catch {
        selected = false;
      }
    } else if (!sessionId) {
      await this.modelState.refresh();
    }
    if (!this.isCurrentSession(sessionId, sessionGeneration)) return;
    if (this.providerOnboarding === onboarding) this.closeProviderOnboarding();
    const providerName = sanitizeTerminalText(result.providerName);
    const modelRef = sanitizeTerminalText(
      result.providerId ? `${result.providerId}/${result.modelId}` : result.modelId,
    );
    this.options.append(
      `Provider ${result.reused ? 'updated' : 'added'}: ${providerName} · ${modelRef}.`,
    );
    if (selectedModel) this.warnModelCacheImpact(previousModel, selectedModel, sessionId);
    if (!selected) {
      this.options.append(
        'The provider was saved, but the active Session did not switch models. Select it in /model.',
        'warning',
      );
    }
    await this.showModelPicker('');
  }

  private warnModelCacheImpact(
    previous: TuiModel | undefined,
    selected: TuiModel,
    sessionId: string | undefined,
  ): void {
    if (!sessionId || !previous) return;
    if (previous.providerId === selected.providerId && previous.modelId === selected.modelId)
      return;
    // Local command receipts alone do not imply reusable conversation context.
    for (let index = 0; index < this.options.transcript.length; index += 1) {
      const cell = this.options.transcript.cellAt(index);
      if (cell?.kind !== 'user' && cell?.kind !== 'assistant') continue;
      this.options.append(
        'Switching models may prevent reuse of the existing prompt cache and incur additional costs.',
        'warning',
      );
      return;
    }
  }

  async showProviderManager(): Promise<void> {
    if (this.isStopped()) return;
    this.closeProviderManager();
    const loadSequence = ++this.providerLoadSequence;
    let snapshot;
    try {
      snapshot = await this.providerApplication.snapshot({ includeCodexOAuth: true });
    } catch (error) {
      if (!this.isStopped() && loadSequence === this.providerLoadSequence) {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't load providers.",
            nextStep: 'Retry /provider.',
          }),
          'warning',
        );
      }
      return;
    }
    if (this.isStopped() || loadSequence !== this.providerLoadSequence) return;
    const refresh = async () => {
      const next = await this.providerApplication.snapshot({ includeCodexOAuth: true });
      // Await the roster before repainting: disabling a provider drops its
      // models, and a stale status line would keep advertising a model the
      // Runtime no longer resolves.
      await this.modelState.refresh();
      this.options.controller.refreshStatusMetricsNow();
      return next;
    };
    const manager = new TuiProviderManager({
      snapshot,
      onRefresh: refresh,
      onTest: (providerId, modelId) => this.providerApplication.test(providerId, modelId),
      onConnectCodex: () => {
        this.closeProviderManager();
        this.showCodexLogin('provider');
      },
      onRefreshModels: (provider) => this.providerApplication.refreshModels(provider),
      onSaveCustom: (input) => this.providerApplication.saveCandidate(input),
      onSetMiniMaxApiKey: (apiKey) => this.providerApplication.setMiniMaxApiKey(apiKey),
      onSetMiniMaxSource: (source) =>
        this.providerApplication.setMiniMaxSource(source).then(() => undefined),
      ...(this.options.onStartMiniMaxLogin
        ? {
            // Sign-in takes over the surface, so the panel closes first and the
            // user reopens `/provider` once the browser round-trip finishes.
            onReLogin: () => {
              this.closeProviderManager();
              this.options.onStartMiniMaxLogin?.();
            },
          }
        : {}),
      onCancel: () => {
        this.options.surface.close(manager);
        if (this.providerManager === manager) this.providerManager = undefined;
      },
      requestRender: this.options.onChanged,
    });
    this.providerManager = manager;
    this.options.surface.show(manager);
  }

  private showCodexLogin(returnTo: 'provider' | 'model'): void {
    if (this.isStopped()) return;
    const panel = new TuiCodexLogin({
      application: this.providerApplication,
      openExternalTarget:
        this.options.openExternalTarget ?? createTuiExternalTargetOpener(this.options.workspaceDir),
      onConnected: () => {
        if (this.codexLogin !== panel || this.isStopped()) return;
        this.closeCodexLogin();
        void this.finishCodexLogin(returnTo);
      },
      onClose: () => this.closeCodexLogin(),
      requestRender: this.options.onChanged,
    });
    this.codexLogin = panel;
    this.options.surface.show(panel);
    void panel.resume();
  }

  private async finishCodexLogin(returnTo: 'provider' | 'model'): Promise<void> {
    try {
      await this.modelState.refresh();
      if (this.isStopped()) return;
      this.options.controller.refreshStatusMetricsNow();
      this.options.append('OpenAI Codex connected.');
      if (returnTo === 'model') await this.showModelPicker('');
      else await this.showProviderManager();
    } catch (error) {
      if (!this.isStopped())
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't refresh Codex models.",
            nextStep: 'Reopen /model to retry.',
          }),
          'error',
        );
    }
  }

  async showPlugins(initialQuery = ''): Promise<void> {
    if (this.isStopped() || this.pluginScreen?.isActive()) return;
    this.closePlugins();
    const loadSequence = ++this.pluginLoadSequence;
    let catalog;
    try {
      catalog = await this.pluginApplication.catalog({ includeAvailable: true });
    } catch (error) {
      if (!this.isStopped() && loadSequence === this.pluginLoadSequence) {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't load Plugins.",
            nextStep: 'Retry /plugins.',
          }),
          'warning',
        );
      }
      return;
    }
    if (this.isStopped() || loadSequence !== this.pluginLoadSequence) return;
    let handle: TuiFeatureScreenHandle | undefined;
    const loadAll = async () => {
      const next = await this.pluginApplication.catalog({ includeAvailable: true });
      return [...next.installed, ...next.available];
    };
    const refreshSkills = async (): Promise<void> => {
      try {
        await this.refreshSkillCommands();
      } catch (error) {
        if (!this.isStopped()) {
          this.options.append(
            formatTuiActionFailure(error, {
              summary: 'Plugin updated, but its Skills could not be refreshed.',
              nextStep: 'Restart MCode or retry /plugins.',
            }),
            'warning',
          );
        }
      }
    };
    const refreshSkillsAfterMutation = async (
      operation: () => Promise<McodePluginView>,
    ): Promise<McodePluginView> => {
      const plugin = await operation();
      await refreshSkills();
      return plugin;
    };
    const manager = new TuiPluginManager({
      plugins: [...catalog.installed, ...catalog.available],
      initialQuery,
      onInstall: (plugin) =>
        refreshSkillsAfterMutation(() => this.pluginApplication.install(plugin)),
      onRemove: (plugin) => refreshSkillsAfterMutation(() => this.pluginApplication.remove(plugin)),
      onSetEnabled: (plugin, enabled) =>
        refreshSkillsAfterMutation(() => this.pluginApplication.setEnabled(plugin, enabled)),
      onRefresh: async () => {
        await this.pluginApplication.refresh();
        await refreshSkills();
        return loadAll();
      },
      onCancel: () => {
        if (handle?.close()) this.pluginScreen = undefined;
      },
      requestRender: this.options.onChanged,
    });
    handle = this.options.surfaceHost.pushFeature({ screen: manager, focus: manager });
    this.pluginScreen = handle;
  }

  async appendInspection(
    label: string,
    operation: () => Promise<string | FeatureInspectionResult>,
  ): Promise<void> {
    if (this.isStopped()) return;
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    const sessionGeneration = this.sessionGeneration;
    try {
      const result = await operation();
      if (this.isCurrentSession(sessionId, sessionGeneration)) {
        if (typeof result === 'string') this.options.append(result);
        else this.options.append(result.content, 'inspection', result.inspection);
      }
    } catch (error) {
      if (this.isCurrentSession(sessionId, sessionGeneration)) {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: `Couldn't load ${label.toLocaleLowerCase()}.`,
            nextStep: 'Retry.',
          }),
          'error',
        );
      }
    }
  }

  async showConfigurationInspection(configOnly: boolean): Promise<void> {
    await this.appendInspection(
      configOnly ? 'Config inspection' : 'Configuration check',
      async () => {
        const diagnostics = await this.options.runtime.getRuntimeDiagnostics();
        return configOnly
          ? {
              content: formatTuiConfigSummary(diagnostics),
              inspection: createTuiConfigInspection(diagnostics),
            }
          : {
              content: formatTuiRuntimeDiagnostics(diagnostics),
              inspection: createTuiRuntimeInspection(diagnostics),
            };
      },
    );
  }

  async showAccountStatus(): Promise<void> {
    await this.showReportInspection(
      'MCode status',
      'Loading status…',
      async (publish) => {
        const session = this.options.controller.snapshot().session;
        const sessionId = session?.sessionId;
        const workspaceDir = session?.workspaceDir ?? this.options.workspaceDir;
        const accountRequest = this.options.runtime
          .getAccountStatus(sessionId, {
            includeMembership: true,
            forceRefresh: true,
          })
          .catch(() => undefined);
        const [permissionMode, workspaceGit, instructionSources] = await Promise.all([
          this.options.runtime.getPermissionMode().catch(() => undefined),
          this.options.runtime.getWorkspaceGitMetadata(workspaceDir).catch(() => undefined),
          this.options.runtime.getInstructionSources(workspaceDir).catch(() => undefined),
        ]);
        const presentation = {
          version: this.options.version ?? MINIMAX_CODE_VERSION,
          model: this.selectedModel(),
          effort: this.selectedEffort(),
          workspaceDir,
          permissionMode,
          session,
          workspaceGit,
          instructionSources,
          planMode: this.options.planMode?.(),
        };
        publish({
          content: formatTuiAccountStatus(undefined, { ...presentation, accountLoading: true }),
          inspection: createTuiAccountStatusInspection(undefined, {
            ...presentation,
            accountLoading: true,
          }),
        });
        const account = await accountRequest;
        return {
          content: formatTuiAccountStatus(account, presentation),
          inspection: createTuiAccountStatusInspection(account, presentation),
        };
      },
      { summary: "Couldn't load account status.", nextStep: 'Retry /status.' },
    );
  }

  async hasManagedAccountLogin(): Promise<boolean> {
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    const account = await this.options.runtime.getAccountStatus(sessionId, { forceRefresh: true });
    return account.managedTokenPresent === true;
  }

  async runDailyCheckin(): Promise<void> {
    try {
      const outcome = await this.options.runtime.runDailyCheckin();
      this.options.append(formatTuiDailyCheckinOutcome(outcome));
    } catch {
      this.options.append(
        "Couldn't complete daily check-in. Check the connection, then retry /checkin.",
        'warning',
      );
    }
  }

  async showSessionUsage(): Promise<void> {
    await this.showReportInspection(
      'Usage',
      'Loading usage…',
      async () => {
        const session = this.options.controller.snapshot().session;
        const sessionId = session?.sessionId;
        const accountRequest = this.options.runtime.getAccountStatus(sessionId, {
          includeMembership: true,
          forceRefresh: true,
        });
        const [usage, context, account] = session
          ? await Promise.all([
              this.options.runtime.getSessionUsage(session.sessionId),
              this.options.runtime.getContextSnapshot(session.sessionId).catch(() => undefined),
              accountRequest.catch(() => undefined),
            ])
          : [{ summary: undefined, rows: [] }, undefined, await accountRequest];
        const presentation = {
          context,
          model: this.selectedModel(),
          account,
          scope: session ? ('session' as const) : ('account' as const),
        };
        const inspection = createTuiUsageInspection(usage, presentation);
        return {
          content: formatTuiUsage(usage, presentation),
          ...(inspection ? { inspection } : {}),
        };
      },
      { summary: "Couldn't load usage.", nextStep: 'Retry /usage.' },
    );
  }

  private async showReportInspection(
    title: string,
    loadingMessage: string,
    operation: (
      publish: (result: ReportInspectionResult) => void,
    ) => Promise<ReportInspectionResult>,
    failure: { readonly summary: string; readonly nextStep: string },
  ): Promise<void> {
    if (this.isStopped()) return;
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    const sessionGeneration = this.sessionGeneration;
    const panel = new TuiReportInspectionPanel({
      title,
      loadingMessage,
      maxRows: () => this.inspectionMaxRows(),
      requestRender: this.options.onChanged,
      onCancel: () => this.closeInspectionPanel(panel),
      onDispose: () => {
        if (this.inspectionPanel === panel) this.inspectionPanel = undefined;
      },
    });
    this.showInspectionPanel(panel);
    try {
      const result = await operation((progress) => {
        if (this.isCurrentSession(sessionId, sessionGeneration) && this.inspectionPanel === panel) {
          panel.setResult(progress.content, progress.inspection);
        }
      });
      if (!this.isCurrentSession(sessionId, sessionGeneration)) {
        this.closeInspectionPanel(panel);
        return;
      }
      if (this.inspectionPanel === panel) panel.setResult(result.content, result.inspection);
    } catch (error) {
      if (!this.isCurrentSession(sessionId, sessionGeneration)) {
        this.closeInspectionPanel(panel);
        return;
      }
      if (this.inspectionPanel === panel) {
        panel.setError(
          formatTuiActionFailure(error, {
            summary: failure.summary,
            nextStep: failure.nextStep,
          }),
        );
      }
    }
  }

  async showSkills(filter: string): Promise<void> {
    if (this.isStopped()) return;
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    const sessionGeneration = this.sessionGeneration;
    const agentName =
      this.options.controller.snapshot().session?.agentName ?? this.options.defaultAgentName;
    try {
      const result = await this.options.runtime.listSkills(agentName, filter || undefined);
      if (
        !this.isCurrentSession(sessionId, sessionGeneration) ||
        (this.options.controller.snapshot().session?.agentName ?? this.options.defaultAgentName) !==
          agentName
      ) {
        return;
      }
      if (!filter) await this.refreshSkillCommands(result);
      if (!this.isCurrentSession(sessionId, sessionGeneration)) return;
      this.showInspectionPanel(
        createTuiSkillsInspectionPanel(
          result,
          filter,
          () => this.closeInspectionPanel(),
          () => this.inspectionMaxRows(),
        ),
      );
    } catch (error) {
      if (this.isCurrentSession(sessionId, sessionGeneration)) {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't load skills.",
            nextStep: 'Retry /skills.',
          }),
          'error',
        );
      }
    }
  }

  async showMcpServers(filter: string): Promise<void> {
    if (this.isStopped()) return;
    try {
      const session = await this.options.controller.ensureSession();
      const keyword = filter === 'reload' ? '' : filter;
      const preview = await this.options.runtime.inspectProjectMcp(session.sessionId);
      if (preview?.error) this.options.append(`${preview.error} (${preview.path})`, 'warning');
      const result = await this.options.runtime.listMcpServers(
        keyword || undefined,
        session.sessionId,
      );
      if (this.currentSessionId() !== session.sessionId) return;
      if (this.isStopped()) return;
      this.showInspectionPanel(
        createTuiMcpInspectionPanel(
          result,
          keyword,
          () => this.closeInspectionPanel(),
          () => this.inspectionMaxRows(),
        ),
      );
    } catch (error) {
      if (this.isStopped()) return;
      if (isRuntimeMethodNotImplemented(error)) {
        this.options.append(
          'MCP status is not available in this build. Configured MCP tools remain available.',
          'warning',
        );
        return;
      }
      this.options.append(
        formatTuiActionFailure(error, {
          summary: "Couldn't load MCP status.",
          nextStep: 'Retry /mcp.',
        }),
        'error',
      );
    }
  }

  async showPermissions(): Promise<void> {
    if (this.isStopped()) return;
    await this.appendInspection('Permission inspection', async () =>
      formatTuiPermissions(await this.options.runtime.listPendingPermissions()),
    );
  }

  async compactSession(customInstructions: string, hasLiveRun: boolean): Promise<void> {
    if (this.isStopped()) return;
    if (hasLiveRun) {
      this.options.append('Stop the running turn before compacting this Session.', 'warning');
      return;
    }
    const session = this.requireActiveSession();
    if (!session) return;
    const sessionGeneration = this.sessionGeneration;
    const compactionSequence = ++this.compactionSequence;
    this.setCompacting(true);
    try {
      const result = await this.options.runtime.requestCompaction(
        session.sessionId,
        session.agentName ?? this.options.defaultAgentName,
        customInstructions || undefined,
      );
      if (!this.isCurrentSession(session.sessionId, sessionGeneration)) return;
      if (result.success) return;
      if (result.code === 'NOTHING_TO_COMPACT' || result.code === 'unchanged') {
        this.options.append('No compaction is needed for this conversation yet.');
        return;
      }
      this.options.append(
        formatTuiActionFailure(result.error ?? result.code ?? 'Runtime rejected the request', {
          summary: "Couldn't compact this conversation.",
          nextStep: 'Retry /compact later.',
          preservation: 'Your messages are unchanged.',
        }),
        'error',
      );
    } catch (error) {
      if (!this.isCurrentSession(session.sessionId, sessionGeneration)) return;
      if (isRuntimeErrorCode(error, 'NOTHING_TO_COMPACT')) {
        this.options.append('No compaction is needed for this conversation yet.');
        return;
      }
      this.options.append(
        formatTuiActionFailure(error, {
          summary: "Couldn't compact this conversation.",
          nextStep: 'Retry /compact later.',
          preservation: 'Your messages are unchanged.',
        }),
        'error',
      );
    } finally {
      if (compactionSequence === this.compactionSequence) this.setCompacting(false);
    }
  }

  private setCompacting(active: boolean): void {
    if (this.compacting === active) return;
    this.compacting = active;
    this.options.setCompacting(active);
  }

  private rejectLiveSessionNavigation(command: string): boolean {
    if (!this.options.hasLiveRun?.()) return false;
    this.options.setHint(`Stop the running turn before using ${command}.`);
    this.options.onChanged();
    return true;
  }

  requireActiveSession(): TuiSession | undefined {
    const session = this.options.controller.snapshot().session;
    if (!session) {
      this.options.append('No active session. Send a message or use /sessions first.', 'warning');
    }
    return session;
  }

  private invalidateFeatureLoads(options: { readonly includeSkillRefresh?: boolean } = {}): void {
    this.sessionGeneration += 1;
    this.modelLoadSequence += 1;
    this.providerLoadSequence += 1;
    this.pluginLoadSequence += 1;
    if (options.includeSkillRefresh) this.skillRefreshSequence += 1;
    this.sessionManagerLoadSequence += 1;
    this.compactionSequence += 1;
  }

  private closeFeatureSurfaces(): void {
    this.closeModelPicker();
    this.closeProviderManager();
    this.closeCodexLogin();
    this.closeProviderOnboarding();
    this.closeInspectionPanel();
    this.closeTranscript();
    this.closePlugins();
  }

  closeOwnedPanel(panel: Component | undefined): void {
    if (panel === this.inspectionPanel) this.inspectionPanel = undefined;
    if (panel === this.modelPicker) this.modelPicker = undefined;
    if (panel === this.providerManager) this.providerManager = undefined;
    if (panel === this.codexLogin) this.codexLogin = undefined;
    if (panel === this.providerOnboarding) this.providerOnboarding = undefined;
  }

  private showInspectionPanel(panel: Component): void {
    this.closeInspectionPanel();
    this.inspectionPanel = panel;
    this.options.surface.show(panel);
  }

  private closeInspectionPanel(panel?: Component): void {
    if (panel && panel !== this.inspectionPanel) return;
    const current = this.inspectionPanel;
    this.inspectionPanel = undefined;
    if (current) this.options.surface.close(current);
  }

  private closeModelPicker(): void {
    const picker = this.modelPicker;
    this.modelPicker = undefined;
    if (picker) this.options.surface.close(picker);
  }

  private closeCodexLogin(): void {
    const panel = this.codexLogin;
    this.codexLogin = undefined;
    if (panel) this.options.surface.close(panel);
  }

  private closeProviderManager(): void {
    const manager = this.providerManager;
    this.providerManager = undefined;
    if (manager) this.options.surface.close(manager);
  }

  private closeProviderOnboarding(): void {
    const onboarding = this.providerOnboarding;
    this.providerOnboarding = undefined;
    if (onboarding) this.options.surface.close(onboarding);
  }

  private closeTranscript(): void {
    const screen = this.transcriptScreen;
    this.transcriptScreen = undefined;
    screen?.close();
  }

  private closePlugins(): void {
    const screen = this.pluginScreen;
    this.pluginScreen = undefined;
    screen?.close();
  }

  private isCurrentSession(sessionId: string | undefined, sessionGeneration: number): boolean {
    return (
      !this.isStopped() &&
      sessionGeneration === this.sessionGeneration &&
      this.options.controller.snapshot().session?.sessionId === sessionId
    );
  }

  private isCurrentSessionRequest(
    sessionId: string | undefined,
    sessionGeneration: number,
    loadSequence: number,
  ): boolean {
    return (
      loadSequence === this.modelLoadSequence && this.isCurrentSession(sessionId, sessionGeneration)
    );
  }

  private inspectionMaxRows(): number {
    const rows = this.options.terminalRows();
    return Math.max(4, rows - 4);
  }

  private sessionManagerMaxRows(): number {
    const rows = this.options.terminalRows();
    return Math.max(4, Math.min(SESSION_MANAGER_MAX_ROWS, rows - 6));
  }

  private isStopped(): boolean {
    return this.stopped || Boolean(this.options.isStopped?.());
  }
}

async function loadAllSessionMessages(
  runtime: FeatureRuntime,
  sessionId: string,
): Promise<readonly TuiMessage[]> {
  let before: string | undefined;
  const seenCursors = new Set<string>();
  let messages: TuiMessage[] = [];
  for (;;) {
    const page = await runtime.listMessagePage(sessionId, {
      limit: SESSION_EXPORT_PAGE_SIZE,
      ...(before ? { before } : {}),
    });
    messages = [...page.messages, ...messages];
    if (!page.hasMore) return messages;
    if (!page.nextCursor) {
      throw new Error('Runtime did not return a cursor for the next history page.');
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('Runtime returned a duplicate history cursor.');
    }
    seenCursors.add(page.nextCursor);
    before = page.nextCursor;
  }
}

function parseExportPath(rawPath: string): string | undefined {
  const value = rawPath.trim();
  if (!value) return undefined;
  const quoted =
    value.length >= 2 && ['"', "'"].includes(value[0] ?? '') && value.at(-1) === value[0];
  const path = quoted ? value.slice(1, -1) : value;
  if (!path.trim()) throw new Error('Usage: /export [path.md]');
  const extension = extname(path).toLocaleLowerCase();
  if (extension && extension !== '.md' && extension !== '.markdown') {
    throw new Error('Usage: /export [path.md]');
  }
  return path;
}
