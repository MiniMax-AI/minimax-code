import { disposeComponents } from './rendering/component.js';
import {
  checkTuiApplicationUpdate,
  createTuiApplicationDraftLifecycle,
  createTuiApplicationEditor as createEditor,
  createTuiApplicationRenderer,
  createTuiApplicationSessionFeatures,
  createTuiApplicationSessionActions,
  createTuiApplicationSurface,
  createTuiApplicationWidgets,
  createTuiBusinessEventTracker,
  createTuiChatControllerComposition,
  createTuiRunIdentity,
  resolveTuiInteractionMaxRows,
} from './app-composition.js';
import { TranscriptView } from './transcript/view.js';
import { TuiChatController, type TuiChatSnapshot } from './controller/chat-controller.js';
import { TuiChromeFlow } from './controller/product/chrome-flow.js';
import type { TuiDraftLifecycle } from './features/composer/draft-lifecycle.js';
import { retainAvailableAttachmentPlaceholders } from './features/composer/draft-recovery.js';
import type { TuiSubmissionSnapshot } from './features/composer/submission.js';
import { statSync } from 'node:fs';
import type { TuiTransportAttachment } from '../types/invocation.js';
import { TuiRunProjection } from './state/run-projection.js';
import { createTuiState, TuiEffectRunner, TuiStateStore } from './state/index.js';
import { FeedbackFlow as Feedback } from './controller/product/feedback-flow.js';
import { TranscriptStore } from './transcript/store.js';
import { TranscriptVisibilityProjection } from './transcript/presentation/visibility.js';
import { createLocalTranscriptAppender } from './transcript/local-appender.js';
import { TuiBashFlow } from './controller/product/bash-flow.js';
import { TranscriptPresentationController } from './transcript/presentation/state.js';
import { TuiActiveRunFlow } from './controller/run/active-run-flow.js';
import { TuiRuntimeStateCoordinator } from './controller/runtime/runtime-state-coordinator.js';
import { TuiInteractionFlow } from './controller/interaction/interaction-flow.js';
import { TuiFeatureFlow } from './controller/product/feature-flow.js';
import { TuiRuntimeEventFlow } from './controller/runtime/runtime-event-flow.js';
import { TuiQueueFlow } from './controller/run/queue-flow.js';
import { resolveTuiEffortChoice } from './features/model/effort.js';
import { TuiSessionFlow } from './controller/session-flow.js';
import { TuiCommandFlow } from './controller/product/command-flow.js';
import { TuiInputFlow } from './controller/interaction/input-flow.js';
import { TuiPermissionModeFlow } from './controller/interaction/permission-mode-flow.js';
import { TuiPlanModeFlow } from './controller/interaction/plan-mode-flow.js';
import { createTuiAbortLiveTurn } from './controller/run/abort-live-turn.js';
import { createTuiUpdateFlow } from './controller/product/update-flow.js';
import { createTuiUpdateAdmission } from './controller/product/update-admission.js';
import { resolveTuiProductFeatures } from './product-features.js';
import { createTuiTranscriptExporter } from '../host/transcript-export.js';
import type { CreateTuiAppOptions, TuiApp, TuiStopOptions } from '../types/tui-app.js';
import { createTuiGoalComposition } from './goal-composition.js';
import type { TuiGoalFlow } from './controller/product/goal-flow.js';
import { createTuiSessionLifecycleBridge } from './controller/session-lifecycle-bridge.js';
import { parseTuiStatusLineItems as parseStatusItems } from './shell/status-line-items.js';
import { showTuiStatusLineSetup } from './controller/product/status-line-setup.js';
import { showTuiThemeSetup } from './controller/product/theme-setup.js';
import { TuiCodexHandoffFlow } from './controller/product/codex-handoff-flow.js';

export type { CreateTuiAppOptions, TuiApp, TuiStopOptions };
export function createTuiApp(options: CreateTuiAppOptions): TuiApp {
  const sessionLifecycle = createTuiSessionLifecycleBridge(options.runtime);
  const agentStatusEnabled = parseStatusItems(options.statusLineItems ?? []).includes('build-mode');
  const {
    terminal,
    renderer,
    tui,
    terminalNotifications,
    themeController,
    openExternalTarget,
    writeClipboardText,
  } = createTuiApplicationRenderer(options);
  const stateStore = new TuiStateStore(createTuiState());
  const productFeatures = resolveTuiProductFeatures(options.productFeatures);
  const exportTranscript =
    options.exportTranscript ??
    (options.dataDir ? createTuiTranscriptExporter(options.dataDir) : undefined);
  const { defaultAgentName, workspaceRoots, ...automationResultDelivery } =
    createTuiChatControllerComposition(options);
  const transcript = new TranscriptStore();
  const transcriptVisibility = new TranscriptVisibilityProjection(transcript);
  const transcriptView = new TranscriptView(transcriptVisibility, {
    displayModes: new TranscriptPresentationController(),
    workspaceDir: options.workspaceDir,
  });
  const editor = createEditor(tui, workspaceRoots, options.runtime);
  let draftLifecycle: TuiDraftLifecycle | undefined;
  let draftStopPromise: Promise<void> | undefined;
  let chromeFlow: TuiChromeFlow | undefined;
  const updateChrome = (snapshot: TuiChatSnapshot): void => chromeFlow?.update(snapshot);
  let activeRunFlow: TuiActiveRunFlow;
  let runtimeEventFlow: TuiRuntimeEventFlow;
  let commandFlow: TuiCommandFlow;
  let codexHandoffFlow: TuiCodexHandoffFlow | undefined;
  let abortLiveTurn: () => Promise<boolean>;
  let goalFlow: TuiGoalFlow | undefined;
  let followChatBottom = (): void => undefined;
  let started = false;
  let stopped = false;
  let suspended = false;
  const widgets = createTuiApplicationWidgets({
    app: options,
    tui,
    terminal,
    editor,
    requestRender: () => (started && !stopped ? tui.requestRender() : undefined),
  });
  const { welcome, updateNotice, status, activity, composer, interaction, followUp, goal, tasks } =
    widgets;
  const appendLocalCell = createLocalTranscriptAppender({
    transcript,
    isStopped: () => stopped,
    onChanged: () => tui.requestRender(),
  });
  const bashFlow = new TuiBashFlow({
    transcript,
    onChanged: () => {
      followChatBottom();
      if (!stopped) {
        updateChrome(controller.snapshot());
        tui.requestRender();
      }
    },
  });
  const controller = new TuiChatController({
    runtime: options.runtime,
    transcript,
    workspaceDir: options.workspaceDir,
    version: options.version,
    defaultAgentName,
    ...automationResultDelivery,
    onAutomationResultPublished: (result) => delegationFlow.handleAutomationResultPublished(result),
    onTodoChange: (items) => tasks.setItems(items),
    onUserSubmissionProjected: () => {
      codexHandoffFlow?.dismiss();
      if (started && !stopped) tui.renderNow();
    },
    onSessionLifecycle: (sessionId) => {
      if (!sessionId) bashFlow.clearUnboundContext();
      sessionLifecycle.onSessionLifecycle(sessionId);
    },
    onChange: (snapshot) => {
      if (stopped) return;
      const sessionId = snapshot.session?.sessionId;
      if (sessionId) draftLifecycle?.adoptCreatedSession(sessionId);
      if (stateStore.snapshot().activeSessionId !== sessionId) {
        stateStore.dispatch({ type: 'session/activate', sessionId });
        sessionMutationFlow?.reconcileSession();
        void goalFlow?.refresh(sessionId);
      }
      updateChrome(snapshot);
      activeRunFlow?.schedule(snapshot);
      if (started) tui.requestRender();
    },
  });
  const updateChromeAndRequestRender = (): void => {
    updateChrome(controller.snapshot());
    if (started && !stopped) tui.requestRender();
  };
  const runProjection = new TuiRunProjection();
  const { latestRuntimeTurnId, liveRunId } = createTuiRunIdentity(controller, runProjection);
  const hasLiveRun = () => Boolean(liveRunId() || controller.hasInProcessRun());
  const isTuiActive = (): boolean => started && !stopped && !suspended;
  let shouldResumeDraftAfterLogin = () => false;
  const { layout, surfaceHost, fullscreenLayout, themeRendering, interactionSurface } =
    createTuiApplicationSurface({
      terminal,
      tui,
      editor,
      controller,
      transcript,
      transcriptView,
      widgets,
      themeController,
      liveRunId,
      shouldResumeDraftAfterLogin: () => shouldResumeDraftAfterLogin(),
      isActive: isTuiActive,
      requestInteractionRender,
      mode: () => renderer.mode,
      switchMode: (mode) => renderer.switchMode(mode),
      chatMode: options.tuiMode ?? 'regular',
    });
  followChatBottom = () => layout.followBottom();
  renderer.setFullscreenLayoutRoot(fullscreenLayout);
  let resolveStopped: (() => void) | undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  let sessionFlow: TuiSessionFlow;
  const { sessionMutationFlow, delegationFlow } = createTuiApplicationSessionFeatures({
    app: options,
    controller,
    transcript,
    surfaceHost,
    editor,
    sessionFlow: () => sessionFlow,
    setHint: (message) => chromeFlow?.setHint(message),
    append: appendLocalCell,
    setEditTranscriptBoundary: transcriptVisibility.hideFromSourceMessage,
    onAgentTeamChanged: (snapshot) => tasks.setAgentTeam(snapshot),
    onBackgroundTasksChanged: (backgroundTasks) => tasks.setBackgroundTasks(backgroundTasks),
    onChanged: updateChromeAndRequestRender,
    hasLiveRun,
  });
  const goalComposition = createTuiGoalComposition({
    editAttachmentPlaceholders: () => sessionMutationFlow.retainedEditAttachments(),
    editAttachmentCount: () => sessionMutationFlow.editAttachmentCount(),
    app: options,
    controller,
    banner: goal,
    editor,
    surfaceHost,
    append: appendLocalCell,
    scheduleDraft: () => draftLifecycle?.schedule(),
    chrome: () => chromeFlow,
    isStopped: () => stopped,
    updateChrome: () => updateChrome(controller.snapshot()),
    onEditorChanged: () => activeRunFlow?.onEditorChanged(),
    requestRender: () => (started && !stopped ? tui.requestRender() : undefined),
  });
  const composerDraft = goalComposition.composerDraft;
  widgets.imagePreview.setAttachmentSource(() => [
    ...sessionMutationFlow.retainedEditAttachments(),
    ...composerDraft.snapshot().attachments,
  ]);
  shouldResumeDraftAfterLogin = () =>
    options.resumeDraftAfterLogin === true &&
    (editor.getExpandedText().length > 0 || composerDraft.snapshot().attachments.length > 0);
  goalFlow = goalComposition.goalFlow;
  const runtimeStateCoordinator = new TuiRuntimeStateCoordinator({
    runtime: options.runtime,
    stateStore,
    defaultAgentName,
    resolveSessionAgentName: (sessionId) => {
      const snapshot = controller.snapshot();
      if (snapshot.session?.sessionId === sessionId) return snapshot.session.agentName;
      return snapshot.sessions.find((session) => session.sessionId === sessionId)?.agentName;
    },
    permissionSessionScope: (sessionId) => delegationFlow.permissionSessionScope(sessionId),
    queueEnabled: productFeatures.queue,
  });
  const effectRunner = new TuiEffectRunner(
    (effect) => runtimeStateCoordinator.reconcile(effect),
    (action) => stateStore.dispatch(action),
  );
  const interactionFlow = new TuiInteractionFlow({
    runtime: options.runtime,
    controller,
    stateStore,
    transcript,
    surface: interactionSurface,
    defaultAgentName,
    append: appendLocalCell,
    deliverPermissionFeedback: async (feedback) => {
      const disposition = await commandFlow.submit(feedback);
      if (disposition === 'retained')
        throw new Error('MCode kept the guidance in the composer instead of sending it.');
    },
    onChanged: () => {
      updateChrome(controller.snapshot());
      if (started && !stopped) tui.requestImmediateRender();
    },
    isStopped: () => stopped,
    notify: (kind, key) => {
      terminalNotifications.notifyOnce(kind, key);
    },
    ...delegationFlow.permissionResolvers(liveRunId),
    agentStatusLineItems: options.statusLineItems,
    stopTurn: () => {
      void abortLiveTurn();
    },
  });
  const featureFlow = new TuiFeatureFlow({
    runtime: options.runtime,
    version: options.version,
    planMode: () => planModeFlow.snapshot(),
    controller,
    surface: interactionSurface,
    surfaceHost,
    editor,
    transcript,
    transcriptView,
    writeClipboardText,
    openExternalTarget,
    exportTranscript,
    workspaceDir: options.workspaceDir,
    defaultAgentName,
    terminalRows: () => terminal.rows,
    append: appendLocalCell,
    setCompacting: (active) => {
      chromeFlow?.setCompacting(active);
      updateChrome(controller.snapshot());
      if (started && !stopped) tui.requestRender();
    },
    setHint: (message) => {
      chromeFlow?.setHint(message);
    },
    onChanged: updateChromeAndRequestRender,
    onNewSession: () => sessionFlow.startNew(),
    onOpenSession: (sessionId) => sessionFlow.activateSessionById(sessionId),
    onArchivedCurrentSession: (sessionId) => sessionFlow.archiveCurrentProjection(sessionId),
    refreshAutocomplete: () => activeRunFlow?.refreshAutocomplete(),
    onStartMiniMaxLogin: () => commandFlow.startMiniMaxLogin(), // Wired below.
    isStopped: () => stopped,
    hasLiveRun,
  });
  const businessEventTracker = createTuiBusinessEventTracker({
    telemetry: options.businessTelemetry,
    workspaceDir: options.workspaceDir,
    controller,
    featureFlow,
    stateStore,
    transcript,
  });
  editor.onAutocompleteView = (suggestions) =>
    businessEventTracker?.trackAutocompleteView(suggestions);
  editor.onAutocompleteSelect = (suggestions, item) =>
    businessEventTracker?.trackAutocompleteSelection(suggestions, item);
  const feedbackFlow = new Feedback(
    options.runtime,
    controller,
    appendLocalCell,
    (panel) => interactionSurface.show(panel),
    (panel) => interactionSurface.close(panel),
    requestInteractionRender,
    () => resolveTuiInteractionMaxRows(terminal.rows),
  );
  const admitUpdate = createTuiUpdateAdmission({
    runtime: options.runtime,
    snapshot: () => controller.snapshot(),
    defaultAgentName,
    queueEnabled: productFeatures.queue,
  });
  const updateFlow = createTuiUpdateFlow(
    options,
    appendLocalCell,
    interactionSurface,
    requestInteractionRender,
    () => resolveTuiInteractionMaxRows(terminal.rows),
    async () => {
      options.requestRestart?.();
      await leaveUi();
    },
    admitUpdate,
  );
  activeRunFlow = new TuiActiveRunFlow({
    runtime: options.runtime,
    controller,
    editor,
    terminal,
    workspaceDir: options.workspaceDir,
    workspaceRoots: () => workspaceRoots.list(),
    liveRunId,
    skillCommands: () => [...featureFlow.skillCommands()],
    requireSession: () => featureFlow.requireActiveSession(),
    append: appendLocalCell,
    stage: (command) => featureFlow.stageCommand(command),
    showInteraction: (panel) => interactionSurface.show(panel),
    closeInteraction: (panel) => interactionSurface.close(panel),
    onChanged: updateChromeAndRequestRender,
    adoptRuntimeTurn: (sessionId, turnId, acceptedAtMs) =>
      runtimeEventFlow.adoptRuntimeTurn(sessionId, turnId, acceptedAtMs),
    queueEnabled: productFeatures.queue,
    keybindings: options.keybindings,
    isStopped: () => stopped,
  });
  // Turns whose prompt was already returned to the composer by the abort
  // restore; keys are runtime turn ids, unique for the app's lifetime.
  const restoredAbortTurnIds = new Set<string>();
  abortLiveTurn = createTuiAbortLiveTurn({
    controller,
    runProjection,
    stopDelegation: (sessionId) => options.runtime.stopDelegation(sessionId),
    abortSession: (req) => options.runtime.abortSession(req),
    getActiveRun: (sessionId) => options.runtime.getActiveRun(sessionId),
    latestRuntimeTurnId,
    setTransientHint: (message) => chromeFlow?.setHint(message),
    updateChrome: () => updateChrome(controller.snapshot()),
    requestRender: () => {
      if (!stopped) tui.requestRender();
    },
    append: appendLocalCell,
    onLiveTurnAborted: ({ turnId }) => {
      // Return the aborted prompt to the composer only when the turn produced
      // no user-visible output: any assistant text, tool call, or steer
      // message means the user was interacting with a live response, not
      // regretting a fresh submission. Thinking is internal model process and
      // does not disqualify: it is the most common regret moment, and nothing
      // of value is discarded by resending.
      if (sessionFlow.isSideModeActive()) return;
      const cells = transcript.snapshot().filter((cell) => cell.turnId === turnId);
      const userCell = transcript.get(`user:${turnId}`);
      if (!userCell) return; // runtime-owned or retry-continuation turns
      // A second Esc in the settle window can reach the runtime-owned branch
      // with the same turnId; track restored turns so a repeat concatenates
      // nothing. (Cell status cannot key this: abort-time markTurn also
      // cancels still-pending user cells before the first restore.)
      if (restoredAbortTurnIds.has(turnId)) return;
      const hasIrreversibleActivity = cells.some((cell) => {
        if (cell.id === `user:${turnId}`) return false;
        if (cell.kind === 'thinking' || cell.kind === 'turn-duration') return false;
        // markTurn('cancelled') synthesizes an empty assistant placeholder for
        // turns with no assistant output before this callback can run.
        if ((cell.kind === 'assistant' || cell.kind === 'assistant-preamble') && !cell.content) {
          return false;
        }
        return true;
      });
      if (hasIrreversibleActivity) return;
      // Preferred path: replay the ORIGINAL submission retained for this turn
      // (complete attachment set, transport content, client intent, editor
      // state) instead of reconstructing a lossy copy from the display cell.
      const retained = commandFlow.getRetainedSubmission(turnId);
      const retainedFiltered = retained
        ? filterRetainedSubmissionForRestore(retained)
        : undefined;
      if (retained && retainedFiltered) {
        commandFlow.restoreSubmission(retainedFiltered);
        commandFlow.markAbortSubmissionRestored(retained.submissionId);
        commandFlow.dropRetainedSubmission(turnId);
        restoredAbortTurnIds.add(turnId);
        markAbortedUserRowCancelled(transcript, turnId);
        draftLifecycle?.recordRestoredSubmission(retainedFiltered);
        chromeFlow?.setHint('Stopped · message restored to the Composer.');
        updateChrome(controller.snapshot());
        tui.requestRender();
        return;
      }
      const text = userCell.content;
      const draftAttachments = (userCell.attachments ?? []).flatMap((attachment) =>
        attachment.filePath && typeof attachment.sizeBytes === 'number'
          ? [
              {
                type: attachment.type,
                fileName: attachment.fileName,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                filePath: attachment.filePath,
              },
            ]
          : [],
      );
      // Fallback path: reconstruct from the display cell. The transport list
      // must carry BOTH halves of a mixed row (asset-backed AND file-backed
      // entries): submission-time selection is `transportAttachments ??
      // attachments`, so a partial transport list would silently drop the
      // file-backed attachments on resubmit.
      const transportAttachments: TuiTransportAttachment[] = (userCell.attachments ?? []).flatMap(
        (attachment): TuiTransportAttachment[] =>
          attachment.assetId
            ? [
                {
                  type: attachment.type,
                  fileName: attachment.fileName,
                  mimeType: attachment.mimeType,
                  ...(attachment.filePath ? { filePath: attachment.filePath } : {}),
                  assetId: attachment.assetId,
                },
              ]
            : attachment.filePath && typeof attachment.sizeBytes === 'number'
              ? [
                  {
                    type: attachment.type,
                    fileName: attachment.fileName,
                    mimeType: attachment.mimeType,
                    filePath: attachment.filePath,
                  },
                ]
              : [],
      );
      if (!text.trim() && draftAttachments.length === 0 && transportAttachments.length === 0) {
        return;
      }
      const restoredSubmission: TuiSubmissionSnapshot = {
        submissionId: `abort-restore:${turnId}`,
        sessionId: controller.snapshot().session?.sessionId,
        content: text,
        attachments: draftAttachments,
        ...(transportAttachments.length > 0 ? { transportAttachments } : {}),
        createdAtMs: Date.now(),
        editor: {
          schemaVersion: 1,
          text,
          cursor: text.length,
          pastes: [],
          pasteCounter: 0,
        },
      };
      commandFlow.restoreSubmission(restoredSubmission);
      restoredAbortTurnIds.add(turnId);
      markAbortedUserRowCancelled(transcript, turnId);
      // The restored text already carries the submission's content; a pending
      // retry for it would merge the same text again on the next hydrate.
      draftLifecycle?.recordRestoredSubmission(restoredSubmission);
      chromeFlow?.setHint('Stopped · message restored to the Composer.');
      // The funnel's updateChrome tail ran during the settle wait, before this
      // hint was set; push the chrome once more so the hint is not left
      // unpresented.
      updateChrome(controller.snapshot());
      tui.requestRender();
    },
  });
  const planModeFlow = new TuiPlanModeFlow({
    currentSession: () => controller.snapshot().session,
    loadEntryEnabled: async () => (await options.runtime.getPlanModeCapabilities()).entryEnabled,
    append: appendLocalCell,
    setHint: (message) => chromeFlow?.setHint(message),
    onChanged: updateChromeAndRequestRender,
    isStopped: () => stopped,
  });
  const queueFlow = new TuiQueueFlow({
    runtime: options.runtime,
    controller,
    composerDraft,
    runProjection,
    transcript,
    followUp,
    surface: interactionSurface,
    enabled: productFeatures.queue,
    setHint: (message) => chromeFlow?.setHint(message),
    onChanged: () => updateChrome(controller.snapshot()),
    requestRender: () => tui.requestRender(),
    selectedModel: () => {
      const model = featureFlow.selectedModel();
      if (!model) return undefined;
      // Resolve rather than echo, so the queued request carries the same level
      // the status line shows. A Session that stored no effort would otherwise
      // send a bare `thinking` variant, which makes Runtime drop the effort.
      const effort = resolveTuiEffortChoice(model, featureFlow.selectedEffort())?.trim();
      return {
        providerId: model.providerId,
        modelId: model.modelId,
        ...(model.variant !== undefined ? { variant: model.variant } : {}),
        ...(effort ? { thinking: { effort } } : {}),
      };
    },
    adoptRuntimeTurn: (sessionId, turnId, acceptedAtMs) =>
      runtimeEventFlow.adoptRuntimeTurn(sessionId, turnId, acceptedAtMs),
    isStopped: () => stopped,
    onSubmissionQueued: (itemId, sessionId, clientIntent, submissionId) =>
      planModeFlow.acceptQueued(clientIntent, sessionId, itemId, submissionId),
    onSubmissionRestored: (sessionId, clientIntent) =>
      planModeFlow.restoreQueued(clientIntent, sessionId),
    restoreSubmission: (submission) => commandFlow.restoreSubmission(submission),
  });
  draftLifecycle = createTuiApplicationDraftLifecycle({
    app: options,
    editor,
    composerDraft,
    setHint: (message) => chromeFlow?.setHint(message),
    updateChrome: () => updateChrome(controller.snapshot()),
    append: appendLocalCell,
    onRetryRestored: (submission) => commandFlow?.restoreRecoverableSubmission(submission),
  });
  sessionFlow = new TuiSessionFlow({
    observability: options.observability,
    runtime: options.runtime,
    controller,
    stateStore,
    composerDraft,
    interactionFlow,
    featureFlow,
    queueFlow,
    delegationFlow,
    activeRunFlow: {
      refresh: (force?: boolean) => activeRunFlow.refresh(force),
      currentSnapshot: () => activeRunFlow.currentSnapshot(),
    },
    goalFlow,
    runProjection,
    append: appendLocalCell,
    onChanged: () => {
      updateChrome(controller.snapshot());
      tui.requestRender();
    },
    followBottom: () => layout.forceFollowBottom(),
    requestWelcomeRebuild: () => tui.requestImmediateRender(),
    switchComposerDraft: (sessionKey) => {
      // Retained turn submissions belong to the previous session's turns.
      commandFlow.clearRetainedSubmissions();
      return draftLifecycle?.switchSession(sessionKey) ?? Promise.resolve();
    },
    detachForegroundObserver: () => runtimeEventFlow?.detachForegroundObserver(),
    adoptForegroundRun: () =>
      sessionLifecycle.adoptForegroundRun(
        controller.snapshot().session?.sessionId,
        activeRunFlow.currentSnapshot(),
        runtimeEventFlow,
      ),
    preparePluginHookSessionSwitch: sessionLifecycle.preparePluginHookSessionSwitch,
    hasLiveRun: () => hasLiveRun() || bashFlow.isRunning(),
    abortForegroundRun: () => abortLiveTurn(),
    abortSessionRun: (sessionId) =>
      options.runtime.abortSession({ id: sessionId, reason: 'user_stop' }),
    currentRunId: liveRunId,
    onSideSessionOpened: (input) => businessEventTracker?.trackBtwSessionOpened(input),
    onSideSessionClosed: (input) => businessEventTracker?.trackBtwSessionClosed(input),
    onSideConversationChanged: () => {
      updateChrome(controller.snapshot());
      tui.requestRender();
    },
  });
  const permissionModeFlow = new TuiPermissionModeFlow({
    runtime: options.runtime,
    append: appendLocalCell,
    setHint: (message) => chromeFlow?.setHint(message),
    onChanged: () => {
      updateChrome(controller.snapshot());
      tui.requestRender();
    },
    isStopped: () => stopped,
  });
  commandFlow = new TuiCommandFlow({
    bashFlow,
    workspaceDir: options.workspaceDir,
    ...(options.commandContributions ? { contributions: options.commandContributions } : {}),
    controller,
    activeRunFlow,
    featureFlow,
    feedbackFlow,
    sessionMutationFlow,
    updateFlow,
    goalFlow,
    planModeFlow,
    permissionModeFlow,
    ...(options.auth ? { auth: options.auth } : {}),
    openExternalTarget: options.openExternalTarget,
    interactionFlow,
    sessionFlow,
    queueFlow,
    composerDraft,
    workspaceRoots,
    runProjection,
    editor,
    surface: interactionSurface,
    surfaceHost,
    showTasks: () => delegationFlow.showTasks(),
    persistTuiMode: options.persistTuiMode,
    showStatusLine: () =>
      showTuiStatusLineSetup({
        statusLine: status,
        surface: interactionSurface,
        persist: options.persistStatusLineItems,
      }),
    showTheme: () =>
      showTuiThemeSetup({
        controller: themeController,
        surface: interactionSurface,
        persist: options.persistTheme,
      }),
    keybindings: options.keybindings,
    getTuiKeybindingOverrides: options.getTuiKeybindingOverrides,
    saveTuiKeybindingOverrides: options.saveTuiKeybindingOverrides,
    reloadTui: options.reloadTui,
    queueEnabled: productFeatures.queue,
    liveRunId,
    runtimeStopping: () => Boolean(runProjection.snapshot().stoppingRuntimeTurnId),
    isLlmRetrying: () => chromeFlow?.isLlmRetrying() ?? false,
    abortLiveTurn,
    leaveUi,
    requestRestart: options.requestRestart,
    notifyAuthContextChanged: options.notifyAuthContextChanged,
    whenControllerReady: () => controllerReady,
    whenReady: () => ready,
    whenStopping: () => draftStopPromise ?? Promise.resolve(),
    isStopped: () => stopped,
    append: appendLocalCell,
    setHint: (message) => chromeFlow?.setHint(message),
    onChanged: () => {
      updateChrome(controller.snapshot());
      tui.requestRender();
    },
    userMessageCount: () => transcript.snapshot().filter((cell) => cell.kind === 'user').length,
    onMessageAdmitted: (input) => {
      businessEventTracker?.trackChatSend(input);
      layout.forceFollowBottom();
    },
  });
  activeRunFlow.setCommandCatalog(commandFlow.catalog);
  runtimeEventFlow = new TuiRuntimeEventFlow({
    runtime: options.runtime,
    controller,
    stateStore,
    effectRunner,
    stateCoordinator: runtimeStateCoordinator,
    sessionFlow,
    delegationFlow,
    activeRunFlow,
    interactionFlow,
    runProjection,
    releaseQueueItem: (itemId) => queueFlow.releaseQueuedSubmission(itemId),
    transcript,
    refreshQueue: (sessionId) => queueFlow.refresh(sessionId),
    projectQueueItem: (item) => queueFlow.project(item),
    restoreFailedQueueItem: (itemId) => {
      const submission = queueFlow.takeOverFailedQueueItem(itemId);
      if (submission) commandFlow.restoreSubmission(submission);
    },
    onLlmRetryChanged: (event) => {
      chromeFlow?.setLlmRetry(event);
      updateChrome(controller.snapshot());
    },
    onRetryAvailabilityChanged: (sessionId, retryable) =>
      commandFlow.setSessionRetryable(sessionId, retryable),
    goalFlow,
    updateFollowUpPanel: () => queueFlow.updatePanel(),
    onChanged: updateChromeAndRequestRender,
    append: appendLocalCell,
    isStopped: () => stopped,
    queueEnabled: productFeatures.queue,
    observability: options.observability,
    incidentReporter: options.incidentReporter,
    notify: (kind, key) => {
      terminalNotifications.notifyOnce(kind, key);
    },
  });
  codexHandoffFlow = new TuiCodexHandoffFlow({
    app: options,
    skills: featureFlow,
    controller,
    liveRunId,
    transcript,
    editor,
    composerDraft,
    isStopped: () => stopped,
    chrome: () => chromeFlow,
    onChanged: updateChromeAndRequestRender,
  });
  const inputFlow = new TuiInputFlow({
    cancelBash: () => bashFlow.cancel(),
    tui,
    addInputListener: (listener) => renderer.addInputListener(listener),
    renderLifecycle: {
      start: () => renderer.start(),
      stop: () => renderer.stop(),
      requestRender: (force) => tui.requestRender(force),
    },
    editor,
    workspaceDir: options.workspaceDir,
    externalEditorCommand: options.externalEditorCommand,
    editDraftInExternalEditor: options.editDraftInExternalEditor,
    interaction,
    interactionSurface,
    interactionFlow,
    featureFlow,
    commandFlow,
    permissionModeFlow,
    planModeFlow,
    composerDraft,
    liveRunId,
    hasWaitingMessage: () => runProjection.snapshot().queuedCount > 0,
    restoreWaitingMessage: async () => {
      const submission = await queueFlow.restoreLatest();
      if (!submission) return false;
      editor.restoreSubmittedDraft(submission.editor);
      surfaceHost.setChatFocus(editor);
      return true;
    },
    openQueueManager: () => queueFlow.openManager(),
    toggleTasks: () => tasks.toggleExpanded(),
    isStopped: () => stopped,
    abortLiveTurn,
    cancelSessionEdit: () => sessionMutationFlow.cancelActiveEdit(),
    isEditImageAttachment: (id) =>
      sessionMutationFlow
        .retainedEditAttachments()
        .some((attachment) => attachment.id === id && attachment.type === 'image'),
    takeRecentCodexSession: () => codexHandoffFlow?.take(),
    restoreRecentCodexSession: (session) => codexHandoffFlow?.restore(session),
    dismissRecentCodexSession: () => codexHandoffFlow?.dismiss(),
    leaveUi,
    isSideModeActive: () => sessionFlow.isSideModeActive(),
    toggleSideConversation: () => sessionFlow.toggleSideConversation(),
    closeSideConversation: (exitReason) => sessionFlow.closeSideConversation(exitReason),
    requestProcessSuspend: options.requestProcessSuspend,
    keybindings: options.keybindings,
    append: appendLocalCell,
    setHint: (message, tone) => chromeFlow?.setHint(message, tone),
    onChanged: () => {
      updateChrome(controller.snapshot());
      tui.requestRender();
    },
    onSubmissionStarted: (input, seed) => draftLifecycle?.suspendForSubmission(input, seed),
    onSubmissionPrepared: (submissionToken, submission) =>
      draftLifecycle?.updatePendingSubmission(submissionToken, submission),
    onSubmissionAdmitted: (submissionToken) => draftLifecycle?.settleSubmission(submissionToken),
    onSubmissionSettled: (submissionToken) => draftLifecycle?.settleSubmission(submissionToken),
    requestInteractionRender,
  });
  const detachInputFlow = inputFlow.attach();
  chromeFlow = new TuiChromeFlow({
    keybindings: options.keybindings,
    version: options.version,
    workspace: options.workspaceDir,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    queueEnabled: productFeatures.queue,
    isStarted: () => started,
    isStopped: () => stopped,
    setTerminalTitle: (title) => terminal.setTitle(title),
    connection: () => stateStore.snapshot().connection,
    liveRunId,
    runProjection: () => runProjection.snapshot(),
    transcript,
    shouldResumeDraftAfterLogin: () => shouldResumeDraftAfterLogin(),
    activePermission: () => Boolean(interactionFlow.permission()),
    activeQuestionnaire: () => Boolean(interactionFlow.questionnaire()),
    agentInteraction: () => interactionFlow.agentReadback(),
    ...(agentStatusEnabled ? { agentCounts: () => delegationFlow.agentCounts() } : {}),
    attachmentCount: () =>
      composerDraft.snapshot().attachments.length +
      sessionMutationFlow.retainedEditAttachments().length,
    expandedDraft: () => editor.getExpandedText(),
    inputCommands: () => [...commandFlow.catalog.inputCommands, ...featureFlow.skillCommands()],
    selectedModel: () => featureFlow.selectedModel(),
    selectedEffort: () => featureFlow.selectedEffort(),
    permissionMode: () => permissionModeFlow.snapshot(),
    planMode: () => planModeFlow.snapshot(),
    sideConversation: () => sessionFlow.sideConversationSnapshot(),
    sessionState: () => stateStore.snapshot(),
    welcome,
    status,
    activity,
    composer,
  });
  function requestInteractionRender(): void {
    if (!started || stopped) return;
    tui.requestImmediateRender();
  }
  const controllerReady = controller.initialize();
  const ready = controllerReady.then(async () => {
    await featureFlow.refreshSelectedModel();
    await Promise.all([
      permissionModeFlow.refresh().catch(() => undefined),
      planModeFlow.refreshCapabilities().catch(() => undefined),
    ]);
    await goalFlow?.refresh();
  });
  const { openSession, continueLatestSession } = createTuiApplicationSessionActions({
    ready,
    sessionFlow,
    workspaceDir: options.workspaceDir,
    append: appendLocalCell,
  });
  async function stop(stopOptions: TuiStopOptions = {}): Promise<void> {
    if (stopped) return stoppedPromise;
    stateStore.dispatch({ type: 'lifecycle/leaveUi' });
    stopped = true;
    const bashStopped = bashFlow.stop();
    detachInputFlow();
    composerDraft.abortClipboardRead();
    runtimeEventFlow.stop();
    sessionFlow.stop();
    interactionFlow.deactivate();
    featureFlow.stop();
    delegationFlow.stop();
    activeRunFlow.stop();
    permissionModeFlow.stop();
    planModeFlow.stop();
    feedbackFlow.stop();
    updateFlow.stop();
    themeController.dispose();
    activity.dispose();
    widgets.imagePreview.dispose();
    renderer.prepareTranscriptExit();
    draftStopPromise ??= draftLifecycle?.stop() ?? Promise.resolve();
    disposeComponents(surfaceHost, editor, transcriptView, status, goal);
    if (stopOptions.abortActiveTurn !== false) {
      const snapshot = controller.snapshot();
      if (snapshot.activeTurnId) void controller.abort().catch(() => undefined);
      else if (latestRuntimeTurnId() && snapshot.session?.sessionId) {
        void options.runtime
          .abortSession({
            id: snapshot.session.sessionId,
            turnId: latestRuntimeTurnId(),
            reason: 'user_stop',
          })
          .catch(() => undefined);
      }
    }
    await terminal.drainInput(1000).catch(() => undefined);
    renderer.dispose();
    await draftStopPromise;
    await bashStopped;
    stateStore.dispatch({ type: 'lifecycle/stopped' });
    resolveStopped?.();
    return stoppedPromise;
  }
  async function leaveUi(): Promise<void> {
    await abortLiveTurn().catch(() => false);
    return stop({ abortActiveTurn: false });
  }
  async function suspend(): Promise<void> {
    if (!started || stopped || suspended) return;
    suspended = true;
    renderer.stop();
    await draftLifecycle?.suspend();
  }
  async function resume(): Promise<void> {
    if (!started || stopped || !suspended) return;
    suspended = false;
    renderer.start();
    runtimeEventFlow.restart();
    tui.requestRender(true);
    draftLifecycle?.resume();
  }
  return {
    tui,
    surfaceHost,
    editor,
    interaction,
    controller,
    state: stateStore,
    transcript,
    ready,
    firstFrame: renderer.firstFrame,
    stopped: stoppedPromise,
    getSurface: () => layout.getSurface(),
    start() {
      if (started || stopped) return;
      started = true;
      updateChrome(controller.snapshot());
      surfaceHost.setChatFocus(editor);
      runtimeEventFlow.start();
      renderer.start();
      themeRendering.start();
      void codexHandoffFlow.detect().catch(() => undefined);
      void featureFlow
        .refreshSelectedModel(controller.snapshot().session?.sessionId)
        .catch(() => undefined);
      void activeRunFlow.refresh().catch(() => undefined);
      void goalFlow?.refresh().catch(() => undefined);
      checkTuiApplicationUpdate(options, updateNotice, () => stopped, tui);
    },
    suspend,
    resume,
    openSession,
    continueLatestSession,
    setStartupStatus(message) {
      chromeFlow?.setStartupHint(message);
      updateChromeAndRequestRender();
    },
    submit: (input) => commandFlow.submit(input).then(() => undefined),
    /** Exposed for integration tests that submit with an explicit seed. */
    commandFlow,
    abortTurn: abortLiveTurn,
    leaveUi,
    stop,
  };
}

function fileExists(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Filters a retained submission snapshot for abort-time restore: drops
 * attachments whose backing file disappeared (asset-backed entries stay),
 * and prunes editor placeholders accordingly. Returns undefined when nothing
 * restorable remains.
 */
function filterRetainedSubmissionForRestore(
  snapshot: TuiSubmissionSnapshot,
): TuiSubmissionSnapshot | undefined {
  const attachments = snapshot.attachments.filter((attachment) =>
    fileExists(attachment.filePath),
  );
  const transportAttachments = (snapshot.transportAttachments ?? []).filter((attachment) =>
    attachment.assetId ? true : attachment.filePath ? fileExists(attachment.filePath) : false,
  );
  if (!snapshot.content.trim() && attachments.length === 0 && transportAttachments.length === 0) {
    return undefined;
  }
  return {
    ...snapshot,
    submissionId: `abort-restore:${snapshot.submissionId}`,
    attachments,
    ...(snapshot.transportAttachments ? { transportAttachments } : {}),
    editor: retainAvailableAttachmentPlaceholders(
      // Some submission paths (automation results, test seeds) submit with a
      // payload but an empty editor draft; restoring that verbatim would
      // leave the composer blank, so fall back to the visible content.
      snapshot.editor.text.trim()
        ? snapshot.editor
        : { ...snapshot.editor, text: snapshot.content, cursor: snapshot.content.length },
      attachments,
    ),
  };
}

/** Marks the aborted turn's user row cancelled so it stays visible in history. */
function markAbortedUserRowCancelled(transcript: TranscriptStore, turnId: string): void {
  const userCell = transcript.get(`user:${turnId}`);
  if (!userCell) return;
  // markTurn does not rewrite the user cell once the runtime echo flipped it
  // to 'succeeded', so upsert explicitly. createdAtMs is force-preserved by
  // the store's merge for existing cells and is intentionally omitted.
  transcript.upsert({
    id: `user:${turnId}`,
    kind: 'user',
    status: 'cancelled',
    ...(userCell.content ? { content: userCell.content } : {}),
    updatedAtMs: Date.now(),
    ...(userCell.attachments ? { attachments: userCell.attachments } : {}),
  });
}
