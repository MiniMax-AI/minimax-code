import { MINIMAX_CODE_DEFAULT_AGENT_NAME } from '../../../product-context.js';
import type {
  TuiInteractionPort,
  TuiPendingPermission,
  TuiPermissionDecision,
  TuiQuestionnaireReplyAnswer,
  TuiQuestionnaireRequest,
  TuiRuntimeEvent,
} from '../../../runtime/port.js';
import {
  createActiveQuestionnaire,
  buildQuestionnaireReplyAnswers,
  formatQuestionnaireAnswerSummary,
  isQuestionnaireComplete,
  parseQuestionAnswer,
  recordQuestionnaireAnswer,
  type ActiveTuiQuestionnaire,
} from '../../interaction/questionnaire.js';
import {
  formatPermissionRequest,
  formatPermissionResolution,
} from '../../interaction/permission.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import type { Component } from '../../rendering/component.js';
import type { TuiInteractionSurface } from '../../shell/interaction-surface.js';
import type { TuiAction } from '../../state/actions.js';
import { selectActiveSessionView, selectSessionView } from '../../state/selectors.js';
import type { TuiStateStore } from '../../state/store.js';
import type { TranscriptCellUpdate } from '../../transcript/model.js';
import type { TranscriptStore } from '../../transcript/store.js';
import {
  TuiPermissionPicker,
  TuiQuestionnairePicker,
} from '../../features/interaction/decision-picker.js';
import { QuestionnaireContinuation } from './questionnaire-continuation.js';
import { classifyQuestionnaireReplyError } from './questionnaire-reply-outcome.js';
import type { TuiChatController } from '../chat-controller.js';
import type { TuiTerminalNotificationKind } from '../../platform/terminal-notifications.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import {
  isTuiPlanReview,
  TuiPlanReviewPanel,
  type TuiPlanReviewAction,
} from '../../features/interaction/plan-review-panel.js';
import { TuiPlanViewerPanel } from '../../features/interaction/plan-viewer-panel.js';
import {
  TuiPlanEntryPanel,
  type TuiPlanEntryAction,
} from '../../features/interaction/plan-entry-panel.js';
import { parseTuiStatusLineItems } from '../../shell/status-line-items.js';

type AppendLocalCell = (content: string, kind?: 'final-summary' | 'warning' | 'error') => void;

export type TuiAgentInteractionReadback =
  | {
      readonly kind: 'permission' | 'questionnaire' | 'plan';
      readonly requestId: string;
      readonly submitting: boolean;
      readonly ownerSessionId?: string;
      readonly ownerTurnId?: string;
    }
  | {
      readonly kind: 'invalid';
      readonly requestId?: never;
      readonly submitting?: never;
      readonly ownerSessionId?: never;
      readonly ownerTurnId?: never;
    };

export interface TuiInteractionFlowOptions {
  readonly runtime: TuiInteractionPort;
  readonly controller: TuiChatController;
  readonly stateStore: TuiStateStore;
  readonly transcript: TranscriptStore;
  readonly surface: TuiInteractionSurface;
  readonly defaultAgentName?: string;
  readonly append: AppendLocalCell;
  readonly deliverPermissionFeedback?: (feedback: string) => Promise<void>;
  readonly onChanged: () => void;
  readonly isStopped?: () => boolean;
  readonly notify?: (kind: TuiTerminalNotificationKind, key: string) => void;
  readonly permissionSessionScope?: (activeSessionId: string) => ReadonlySet<string>;
  readonly permissionOwnerTurnId?: (ownerSessionId: string) => string | undefined;
  readonly agentStatusLineItems?: readonly string[];
  readonly stopTurn: () => void;
}

export class TuiInteractionFlow {
  private readonly defaultAgentName: string;
  private readonly continuation: QuestionnaireContinuation;
  private readonly agentStatusEnabled: boolean;
  private readonly questionnaireDismissals = new Set<string>();
  private panel: Component | undefined;
  private planViewRevision = 0;
  private submittingRequestId?: string;
  private submittingSessionId?: string;

  constructor(private readonly options: TuiInteractionFlowOptions) {
    this.defaultAgentName = options.defaultAgentName ?? MINIMAX_CODE_DEFAULT_AGENT_NAME;
    this.agentStatusEnabled = Boolean(
      options.agentStatusLineItems &&
      parseTuiStatusLineItems(options.agentStatusLineItems).includes('build-mode'),
    );
    this.continuation = new QuestionnaireContinuation({
      runtime: options.runtime,
      controller: options.controller,
      transcript: options.transcript,
      requestRender: options.onChanged,
      updateChrome: options.onChanged,
      hasActiveQuestionnaire: () => Boolean(this.questionnaire()),
      isStopped: options.isStopped,
    });
  }

  permission(): TuiPendingPermission | undefined {
    return this.interactions().permission;
  }

  questionnaire(): ActiveTuiQuestionnaire | undefined {
    return this.interactions().questionnaire;
  }

  hasPending(): boolean {
    return Boolean(this.permission() || this.questionnaire());
  }

  /** Whether the visible interaction actually continues this Runtime turn. */
  continuesTurn(sessionId: string, turnId: string): boolean {
    const permission = this.permission();
    if (permission) {
      const ownerSessionId =
        permission.sessionId ?? this.options.controller.snapshot().session?.sessionId;
      const ownerTurnId = ownerSessionId
        ? this.options.permissionOwnerTurnId?.(ownerSessionId)
        : undefined;
      if (interactionOwnsTurn(ownerSessionId, ownerTurnId, sessionId, turnId)) return true;
    }

    const questionnaire = this.questionnaire();
    if (questionnaire) {
      const ownerSessionId =
        questionnaire.sessionId ??
        questionnaire.request.requester?.sessionId ??
        this.options.controller.snapshot().session?.sessionId;
      if (
        interactionOwnsTurn(
          ownerSessionId,
          questionnaire.request.requester?.runId,
          sessionId,
          turnId,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /** Structured interaction state for the machine status line. */
  agentReadback(): TuiAgentInteractionReadback | undefined {
    if (!this.agentStatusEnabled) return undefined;
    const permission = this.permission();
    if (permission) {
      if (!hasPermissionRequestId(permission)) return { kind: 'invalid' };
      const activeSessionId = this.options.controller.snapshot().session?.sessionId;
      const ownerSessionId = permission.sessionId ?? activeSessionId;
      const ownerTurnId = ownerSessionId
        ? this.options.permissionOwnerTurnId?.(ownerSessionId)
        : undefined;
      return {
        kind: 'permission',
        requestId: permission.requestId,
        submitting: this.isAgentSubmission(permission.requestId),
        ...(ownerSessionId && ownerSessionId !== activeSessionId
          ? {
              ownerSessionId,
              ...(ownerTurnId ? { ownerTurnId } : {}),
            }
          : {}),
      };
    }
    const questionnaire = this.questionnaire();
    if (!questionnaire?.request.id) return undefined;
    const ownerSessionId =
      questionnaire.sessionId ??
      questionnaire.request.requester?.sessionId ??
      this.options.controller.snapshot().session?.sessionId;
    const ownerTurnId = questionnaire.request.requester?.runId;
    return {
      kind: questionnaire.request.mode === 'plan' ? 'plan' : 'questionnaire',
      requestId: questionnaire.request.id,
      submitting: this.isAgentSubmission(questionnaire.request.id),
      // Ask/Plan ends the requesting turn before the user answers. Keep its
      // durable identity instead of relying on an active controller turn.
      ...(ownerSessionId ? { ownerSessionId } : {}),
      ...(ownerTurnId ? { ownerTurnId } : {}),
    };
  }

  deactivate(): void {
    this.planViewRevision += 1;
    this.clearAgentSubmission();
    this.continuation.clear();
    this.hidePanel();
    this.options.onChanged();
  }

  replaceFromActiveSession(): void {
    this.planViewRevision += 1;
    const activeRequestId = this.permission()?.requestId ?? this.questionnaire()?.request.id;
    if (
      this.submittingRequestId !== activeRequestId ||
      this.submittingSessionId !== this.options.stateStore.snapshot().activeSessionId
    ) {
      this.clearAgentSubmission();
    }
    this.hidePanel();
    this.showPending();
    this.options.onChanged();
  }

  setQuestionnaire(request: TuiQuestionnaireRequest, sessionId?: string, agentName?: string): void {
    if (this.isStopped()) return;
    const active = createActiveQuestionnaire(request, sessionId, agentName);
    const ownerSessionId = sessionId ?? this.options.controller.snapshot().session?.sessionId;
    const previous = ownerSessionId
      ? selectSessionView(this.options.stateStore.snapshot(), ownerSessionId)?.interactions
          .questionnaire
      : undefined;
    if (ownerSessionId) {
      this.options.stateStore.dispatch({
        type: 'interaction/questionnaireReceived',
        sessionId: ownerSessionId,
        questionnaire: active,
      });
    }
    // A different questionnaire replaces the previous one client-side: drop the
    // superseded review's pending-only plan body (safe no-op when absent).
    if (previous && previous.request.id !== request.id) {
      this.clearPlanReviewBody(previous.request.id);
    }
    const projected =
      ownerSessionId === this.options.stateStore.snapshot().activeSessionId
        ? this.questionnaire()
        : ownerSessionId
          ? selectSessionView(this.options.stateStore.snapshot(), ownerSessionId)?.interactions
              .questionnaire
          : undefined;
    if (projected?.request.id !== request.id) return;
    this.projectQuestionnaire(projected, previous?.request.id !== request.id);
  }

  private projectQuestionnaire(state: ActiveTuiQuestionnaire, showPanel = true): void {
    const now = Date.now();
    const existing = this.options.transcript.get(`question:${state.request.id}`);
    const createdAt = this.createdAtOrNow(state.request.createdAt, now);
    // Plan Review surfaces the frozen plan as a separate, pending-only Markdown
    // cell (inserted above the decision receipt) so the regular renderer's native
    // scrollback -- and the Fullscreen viewport -- owns reading it. It is
    // intentionally ephemeral and lives only while the review is open: once
    // resolved, `question:<id>` records the decision and this body is removed.
    // It deliberately does NOT share the `question:<id>` id, which the durable
    // questionnaire-response projection owns and would otherwise overwrite.
    this.projectPlanReviewBody(state, now);
    this.options.transcript.upsert({
      id: `question:${state.request.id}`,
      kind: 'question',
      status: existing?.status ?? 'blocked',
      title: existing?.title ?? state.request.title ?? 'Agent needs input',
      content: existing?.content ?? '',
      detail: existing?.detail,
      turnId: existing?.turnId ?? state.request.requester?.runId,
      ...(state.request.requester?.runId
        ? {
            questionnaireRequester: {
              sessionId: state.request.requester.sessionId,
              turnId: state.request.requester.runId,
            },
          }
        : {}),
      createdAtMs: existing?.createdAtMs ?? createdAt,
      updatedAtMs: now,
    });
    if (showPanel && !this.continuation.isActive(state.request.id)) {
      this.showQuestionnairePicker();
    }
    this.notifyPendingInteraction('question-required', `question:${state.request.id}`);
  }

  private planReviewBodyId(requestId: string): string {
    return `plan-review-body:${requestId}`;
  }

  private projectPlanReviewBody(state: ActiveTuiQuestionnaire, now: number): void {
    // Gate on the payload, not the markdown text: the panel enters Plan Review
    // mode whenever `planReview` exists, so an empty snapshot must still surface
    // an explicit fallback instead of silently reviewing nothing.
    if (!state.request.modePayload?.planReview) return;
    const markdown =
      state.request.modePayload.planReview.markdown.trim() || '_Plan preview unavailable._';
    const id = this.planReviewBodyId(state.request.id);
    const existing = this.options.transcript.get(id);
    this.options.transcript.upsert({
      id,
      kind: 'question',
      status: 'blocked',
      title: 'Plan Review',
      content: markdown,
      contentFormat: 'markdown',
      ephemeral: true,
      turnId: existing?.turnId ?? state.request.requester?.runId,
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    });
  }

  private clearPlanReviewBody(requestId: string): void {
    this.options.transcript.remove(this.planReviewBodyId(requestId));
  }

  setPermission(request: TuiPendingPermission, presentationSessionId?: string): void {
    if (this.isStopped()) return;
    if (!hasPermissionRequestId(request)) return;
    const ownerSessionId =
      request.sessionId ?? this.options.controller.snapshot().session?.sessionId;
    const targetSessionId = presentationSessionId ?? ownerSessionId;
    if (targetSessionId) {
      this.options.stateStore.dispatch({
        type: 'interaction/permissionReceived',
        sessionId: targetSessionId,
        permission: request,
      });
    }
    const now = Date.now();
    const createdAt = this.createdAtOrNow(request.createdAt, now);
    this.options.transcript.upsert({
      id: `permission:${request.requestId}`,
      kind: 'permission',
      status: 'blocked',
      title: sanitizeTerminalText(request.toolName ?? 'Tool action'),
      content: formatPermissionRequest(request),
      createdAtMs: createdAt,
      updatedAtMs: now,
    });
    this.showPermissionPicker();
    this.notifyPendingInteraction('permission-required', `permission:${request.requestId}`);
  }

  async recover(sessionId: string): Promise<void> {
    if (this.isStopped()) return;
    this.hidePanel();
    const initialView = selectSessionView(this.options.stateStore.snapshot(), sessionId);
    const expectedPermissionRevision = initialView?.permissionRevision ?? 0;
    const expectedQuestionnaireRevision = initialView?.questionnaireRevision ?? 0;
    const previousQuestionnaire = initialView?.interactions.questionnaire;
    const sessionAgentName = this.resolveSessionAgentName(sessionId);
    const [questionnaireResult, permissionsResult] = await Promise.allSettled([
      this.options.runtime.getPendingQuestionnaire(sessionAgentName, sessionId),
      this.options.runtime.listPendingPermissions(),
    ]);
    if (this.isStopped() || this.options.controller.snapshot().session?.sessionId !== sessionId) {
      return;
    }

    const action: Extract<TuiAction, { type: 'interaction/snapshotReconciled' }> = {
      type: 'interaction/snapshotReconciled',
      sessionId,
      expectedPermissionRevision,
      expectedQuestionnaireRevision,
    };
    let recoveredPermission: TuiPendingPermission | undefined;
    const canApplyPermission =
      permissionsResult.status === 'fulfilled' &&
      (selectSessionView(this.options.stateStore.snapshot(), sessionId)?.permissionRevision ??
        0) === expectedPermissionRevision;
    if (permissionsResult.status === 'fulfilled') {
      const permissionScope = this.permissionSessionScope(sessionId);
      recoveredPermission = permissionsResult.value.find(
        (item) => item.sessionId !== undefined && permissionScope.has(item.sessionId),
      );
      action.permission = recoveredPermission ?? null;
    }
    const canApplyQuestionnaire =
      questionnaireResult.status === 'fulfilled' &&
      (selectSessionView(this.options.stateStore.snapshot(), sessionId)?.questionnaireRevision ??
        0) === expectedQuestionnaireRevision;
    if (questionnaireResult.status === 'fulfilled') {
      const questionnaire = questionnaireResult.value;
      action.questionnaire = questionnaire
        ? createActiveQuestionnaire(
            questionnaire,
            sessionId,
            questionnaire.requester?.agentName ?? sessionAgentName,
          )
        : null;
    }
    this.options.stateStore.dispatch(action);

    if (canApplyQuestionnaire && questionnaireResult.status === 'fulfilled') {
      const questionnaire = questionnaireResult.value;
      if (questionnaire) {
        const projected = selectSessionView(this.options.stateStore.snapshot(), sessionId)
          ?.interactions.questionnaire;
        if (projected?.request.id === questionnaire.id) this.projectQuestionnaire(projected);
      } else if (previousQuestionnaire) {
        // The question was answered or expired elsewhere: drop the pending-only
        // plan body along with settling the receipt.
        this.clearPlanReviewBody(previousQuestionnaire.request.id);
        this.updateQuestionTranscript(previousQuestionnaire.request.id, {
          status: 'resolved',
          detail: 'Question is no longer pending.',
          updatedAtMs: Date.now(),
        });
      }
    }
    if (permissionsResult.status === 'fulfilled') {
      const projectedPermission = selectSessionView(this.options.stateStore.snapshot(), sessionId)
        ?.interactions.permission;
      if (
        canApplyPermission &&
        recoveredPermission &&
        !hasPermissionRequestId(recoveredPermission)
      ) {
        this.options.append(
          'The Runtime returned a pending permission without a request id. Restart the Session or retry the task.',
          'error',
        );
      }
      if (
        canApplyPermission &&
        recoveredPermission &&
        hasPermissionRequestId(recoveredPermission) &&
        projectedPermission &&
        projectedPermission.requestId === recoveredPermission.requestId
      ) {
        this.setPermission(projectedPermission, sessionId);
      }
    }
    this.showPending();
    this.options.onChanged();
  }

  showPending(): void {
    if (this.isStopped()) return;
    const permission = this.permission();
    if (permission && hasPermissionRequestId(permission)) this.showPermissionPicker();
    else if (permission) this.hidePanel();
    else if (this.questionnaire()) this.showQuestionnairePicker();
    else this.hidePanel();
  }

  async showLatestPlanReview(): Promise<void> {
    if (this.isStopped()) return;
    if (this.hasPending()) {
      this.showPending();
      return;
    }
    const session = this.options.controller.snapshot().session;
    if (!session?.sessionId) {
      this.options.append('Start or resume a Session before viewing its Plan.', 'warning');
      return;
    }
    const revision = ++this.planViewRevision;
    const agentName = session.agentName ?? this.defaultAgentName;
    let request: TuiQuestionnaireRequest | undefined;
    try {
      request = await this.options.runtime.getLatestPlanReview(agentName, session.sessionId);
    } catch (error) {
      if (
        !this.isStopped() &&
        revision === this.planViewRevision &&
        this.options.controller.snapshot().session?.sessionId === session.sessionId
      ) {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't load the latest Plan.",
            nextStep: 'Retry /plan view.',
          }),
          'error',
        );
      }
      return;
    }
    if (
      this.isStopped() ||
      revision !== this.planViewRevision ||
      this.options.controller.snapshot().session?.sessionId !== session.sessionId
    ) {
      return;
    }
    if (this.hasPending()) {
      this.showPending();
      return;
    }
    if (!request) {
      this.options.append('No Plan has been produced for this Session yet.', 'warning');
      return;
    }
    const state = createActiveQuestionnaire(request, session.sessionId, agentName);
    if (!isTuiPlanReview(state)) {
      this.options.append('The latest Plan snapshot is unavailable.', 'warning');
      return;
    }
    this.hidePanel();
    const panel = new TuiPlanViewerPanel(
      state,
      () => {
        if (this.panel === panel) this.hidePanel();
        this.options.onChanged();
      },
      this.options.onChanged,
    );
    this.panel = panel;
    this.options.surface.show(panel);
    this.options.onChanged();
  }

  closeOwnedPanel(panel: Component | undefined): void {
    if (panel === this.panel) this.panel = undefined;
  }

  ownsPendingPanel(panel: Component | undefined): boolean {
    return panel === this.panel && this.hasPending();
  }

  async handleCommand(command: string): Promise<boolean> {
    const parsed = parseQuestionAnswer(command);
    const permissionDecisions: Record<string, TuiPermissionDecision> = {
      '/allow': 'allowOnce',
      '/always': 'allowAlways',
      '/deny': 'deny',
    };
    const permissionDecision = permissionDecisions[command.toLocaleLowerCase()];
    const questionnaireCommand =
      parsed !== undefined || command === '/ask-send' || command === '/ask-cancel';

    if (this.permission() && questionnaireCommand) {
      this.options.append('Resolve the pending permission in the decision panel first.', 'warning');
      this.showPermissionPicker();
      return true;
    }
    if (this.questionnaire() && !this.permission() && permissionDecision) {
      this.options.append(
        'Answer the pending Agent question in the decision panel first.',
        'warning',
      );
      this.showQuestionnairePicker();
      return true;
    }
    const activeQuestionnaire = this.questionnaire();
    if (activeQuestionnaire?.request.mode === 'plan' && questionnaireCommand) {
      this.options.append('Use the pending Plan decision panel first.', 'warning');
      this.showQuestionnairePicker();
      return true;
    }
    if (parsed) {
      const state = activeQuestionnaire;
      if (!state) this.options.append('No pending questionnaire.');
      else await this.handleQuestionnaireAnswer(state, parsed.index, parsed.text);
      return true;
    }
    if (command === '/ask-send') {
      const state = this.questionnaire();
      if (!state) this.options.append('No pending questionnaire.');
      else await this.submitQuestionnaire(state, true);
      return true;
    }
    if (command === '/ask-cancel') {
      const state = this.questionnaire();
      if (!state) this.options.append('No pending questionnaire.');
      else await this.requestQuestionnaireDismissal(state);
      return true;
    }
    if (permissionDecision) {
      await this.replyPermission(permissionDecision);
      return true;
    }
    return false;
  }

  async handleRuntimeEvent(event: TuiRuntimeEvent, currentSessionId: string): Promise<boolean> {
    if (this.isStopped()) return false;
    const permissionOwnerSessionId =
      event.type === 'permission.ask'
        ? (event.request.sessionId ?? event.sessionId)
        : event.sessionId;
    if (
      event.type === 'permission.ask' &&
      event.request.sessionId &&
      event.sessionId &&
      event.request.sessionId !== event.sessionId
    ) {
      return false;
    }
    const permissionPresentationSessionId =
      event.type === 'permission.ask' || event.type === 'permission.resolved'
        ? this.permissionPresentationSessionId(permissionOwnerSessionId, currentSessionId)
        : undefined;
    if (event.sessionId !== currentSessionId && !permissionPresentationSessionId) return false;
    if (await this.continuation.handleEvent(event, currentSessionId)) return true;
    if (this.isStopped()) return false;
    if (event.type === 'questionnaire.ask') {
      this.setQuestionnaire(event.request, currentSessionId, event.agentName);
      return true;
    }
    if (event.type === 'questionnaire.dismiss' || event.type === 'questionnaire.superseded') {
      const active = this.questionnaire();
      // Clear even when the request is no longer active (e.g. a newer ask already
      // replaced it): the pending-only plan body must not outlive its review.
      if (event.requestId) this.clearPlanReviewBody(event.requestId);
      if (event.requestId && active?.request.id === event.requestId) {
        this.updateQuestionTranscript(event.requestId, {
          status: 'resolved',
          detail: event.type === 'questionnaire.dismiss' ? 'Dismissed.' : 'Superseded.',
          updatedAtMs: Date.now(),
        });
        this.resolveQuestionnaire(active);
      }
      return true;
    }
    if (event.type === 'permission.ask') {
      this.setPermission(event.request, permissionPresentationSessionId ?? currentSessionId);
      return true;
    }
    if (event.type === 'permission.resolved') {
      const active = this.permission();
      const existing = this.options.transcript.get(`permission:${event.requestId}`);
      if (existing) {
        const request =
          active?.requestId === event.requestId
            ? active
            : { requestId: event.requestId, toolName: existing.title };
        this.options.transcript.upsert({
          id: `permission:${event.requestId}`,
          status: 'resolved',
          detail: event.decision
            ? formatPermissionResolution(request, event.decision)
            : existing.status === 'resolved' && existing.detail
              ? existing.detail
              : 'Permission request closed.',
          updatedAtMs: Date.now(),
        });
      }
      if (event.requestId && active?.requestId === event.requestId) {
        this.resolvePermission(active, currentSessionId);
        if (!(await this.showNextPendingPermission(currentSessionId, event.requestId))) {
          this.showQuestionnairePicker();
        }
      }
      return true;
    }
    return false;
  }

  private interactions() {
    return selectActiveSessionView(this.options.stateStore.snapshot())?.interactions ?? {};
  }

  private hidePanel(): void {
    const panel = this.panel;
    this.panel = undefined;
    if (panel) this.options.surface.close(panel);
  }

  private showPermissionPicker(): void {
    if (this.isStopped()) return;
    const request = this.permission();
    if (!request) return;
    this.hidePanel();
    const picker = new TuiPermissionPicker(
      request,
      (decision, feedback) => {
        picker.beginSubmitting(decision);
        this.options.onChanged();
        void this.replyPermission(decision, feedback).catch((error: unknown) => {
          if (!this.isStopped()) {
            this.options.append(
              formatTuiActionFailure(error, {
                summary: "Couldn't send your permission choice.",
                nextStep: 'Retry.',
                preservation: 'The request remains open.',
              }),
              'error',
            );
          }
        });
      },
      this.options.stopTurn,
    );
    this.panel = picker;
    this.options.surface.show(picker);
  }

  private showQuestionnairePicker(): void {
    if (this.isStopped()) return;
    const state = this.questionnaire();
    if (!state || this.permission()) return;
    if (isTuiPlanReview(state)) {
      this.showPlanReview(state);
      return;
    }
    if (isTuiPlanEntry(state)) {
      this.showPlanEntry(state);
      return;
    }
    this.hidePanel();
    const picker = new TuiQuestionnairePicker(
      state,
      (index, answer) => {
        void this.handleQuestionnaireAnswer(state, index, answer, { interactive: true }).catch(
          (error: unknown) => {
            if (!this.isStopped()) {
              this.options.append(
                formatTuiActionFailure(error, {
                  summary: "Couldn't save that answer.",
                  nextStep: 'Retry.',
                  preservation: 'The question remains open.',
                }),
                'error',
              );
            }
          },
        );
      },
      () => {
        void this.requestQuestionnaireDismissal(state).catch((error: unknown) => {
          if (!this.isStopped()) {
            this.options.append(
              formatTuiActionFailure(error, {
                summary: "Couldn't dismiss this question.",
                nextStep: 'Retry.',
                preservation: 'It remains open.',
              }),
              'error',
            );
          }
        });
      },
      {
        requestRender: this.options.onChanged,
        onSubmit: () => {
          picker.beginSubmitting();
          void this.submitQuestionnaire(state, false).catch((error: unknown) => {
            if (!this.isStopped()) {
              this.options.append(
                formatTuiActionFailure(error, {
                  summary: "Couldn't send your answers.",
                  nextStep: 'Retry.',
                  preservation: 'The question remains open.',
                }),
                'error',
              );
            }
          });
        },
        onDismiss: () => {
          void this.requestQuestionnaireDismissal(state).catch((error: unknown) => {
            if (!this.isStopped()) {
              this.options.append(
                formatTuiActionFailure(error, {
                  summary: "Couldn't dismiss this question.",
                  nextStep: 'Retry.',
                  preservation: 'It remains open.',
                }),
                'error',
              );
            }
          });
        },
      },
    );
    if (this.questionnaireDismissals.has(state.request.id)) picker.beginDismiss();
    this.panel = picker;
    this.options.surface.show(picker);
  }

  private showPlanEntry(state: ActiveTuiQuestionnaire): void {
    this.hidePanel();
    const step = state.request.steps.find((candidate) => candidate.id === 'plan-enter');
    const availableActions = new Set<TuiPlanEntryAction>();
    if (step?.options?.some((candidate) => candidate.id === 'confirm')) {
      availableActions.add('confirm');
    }
    if (step?.options?.some((candidate) => candidate.id === 'decline')) {
      availableActions.add('decline');
    }
    const panel = new TuiPlanEntryPanel(
      (action) => {
        void this.withAgentSubmission(state.request.id, () =>
          this.submitPlanEntry(state, action).catch((error: unknown) => {
            if (!this.isStopped()) {
              if (this.questionnaire()?.request.id === state.request.id) panel.restore();
              this.options.append(
                formatTuiActionFailure(error, {
                  summary: "Couldn't apply that Plan Mode decision.",
                  nextStep: 'Retry from the Plan Mode confirmation.',
                  preservation: 'The confirmation remains open.',
                }),
                'error',
              );
            }
          }),
        );
      },
      this.options.onChanged,
      availableActions,
    );
    this.panel = panel;
    this.options.surface.show(panel);
  }

  private async submitPlanEntry(
    state: ActiveTuiQuestionnaire,
    action: TuiPlanEntryAction,
  ): Promise<void> {
    const step = state.request.steps.find((candidate) => candidate.id === 'plan-enter');
    const option = step?.options?.find((candidate) => candidate.id === action);
    if (!step || !option) {
      throw new Error('The Runtime Plan entry confirmation is malformed.');
    }
    state.answers.set(step.id, {
      stepId: step.id,
      rawText: option.label,
      answer: {
        stepId: step.id,
        selectedOptionIds: [action],
        selectedOther: false,
      },
    });
    const ok = await this.submitPlanQuestionnaire(
      state,
      action === 'confirm' ? 'Plan Mode decision sent.' : 'Default Mode decision sent.',
    );
    if (!ok) throw new Error('Runtime did not accept the Plan Mode decision.');
  }

  private showPlanReview(state: ActiveTuiQuestionnaire): void {
    this.hidePanel();
    const panel = new TuiPlanReviewPanel(
      state,
      (action) => {
        void this.withAgentSubmission(state.request.id, () =>
          this.submitPlanReview(state, action).catch((error: unknown) => {
            if (!this.isStopped()) this.appendPlanReviewFailure(error);
          }),
        );
      },
      this.options.onChanged,
    );
    this.panel = panel;
    this.options.surface.show(panel);
  }

  private async submitPlanReview(
    state: ActiveTuiQuestionnaire,
    action: TuiPlanReviewAction,
  ): Promise<void> {
    if (action.kind === 'feedback') {
      await this.submitPlanReviewFeedback(state, action.text);
      return;
    }
    const ownerSessionId = state.sessionId ?? this.options.controller.snapshot().session?.sessionId;
    const stepId = planReviewStepId(state);
    const answer: TuiQuestionnaireReplyAnswer =
      action.kind === 'approve'
        ? { stepId, selectedOptionIds: ['approve'], selectedOther: false }
        : {
            stepId,
            selectedOptionIds: [],
            selectedOther: false,
            skipped: true,
          };
    state.answers.set(stepId, {
      stepId,
      rawText: action.kind === 'approve' ? 'Approve' : '',
      answer,
    });
    const detail =
      action.kind === 'approve'
        ? 'Approved · implementation queued'
        : 'Plan skipped · remaining in Plan Mode';
    let ok: boolean;
    try {
      ok = await this.submitPlanQuestionnaire(state, detail, '');
    } catch (error) {
      if (!this.isActiveSession(ownerSessionId)) return;
      this.restorePlanReview(state);
      throw error;
    }
    if (!this.isActiveSession(ownerSessionId)) return;
    if (!ok) {
      this.restorePlanReview(state);
      throw new Error('Runtime did not accept the Plan review decision.');
    }
  }

  private async submitPlanReviewFeedback(
    state: ActiveTuiQuestionnaire,
    rawText: string,
  ): Promise<void> {
    const ownerSessionId = state.sessionId ?? this.options.controller.snapshot().session?.sessionId;
    const stepId = planReviewStepId(state);
    const text = sanitizeTerminalText(rawText).trim();
    state.answers.set(stepId, {
      stepId,
      rawText: text,
      answer: {
        stepId,
        selectedOptionIds: [],
        selectedOther: true,
        otherText: text,
      },
    });
    this.updateQuestionTranscript(state.request.id, {
      title: 'Plan Review',
      content: text,
      ephemeral: true,
      updatedAtMs: Date.now(),
    });

    let ok: boolean;
    try {
      ok = await this.submitPlanQuestionnaire(
        state,
        'Feedback sent · continuing in Plan Mode',
        text,
      );
    } catch (error) {
      if (this.isActiveSession(ownerSessionId)) this.restorePlanReview(state);
      throw error;
    }
    if (!this.isActiveSession(ownerSessionId)) return;
    if (!ok) {
      this.restorePlanReview(state);
      throw new Error('Runtime did not accept the Plan feedback.');
    }
  }

  private async submitPlanQuestionnaire(
    state: ActiveTuiQuestionnaire,
    detail: string,
    content = formatQuestionnaireAnswerSummary(state),
  ): Promise<boolean> {
    const ownerSessionId = state.sessionId ?? this.options.controller.snapshot().session?.sessionId;
    this.updateQuestionTranscript(state.request.id, {
      status: 'pending',
      title: state.request.modePayload?.planReview ? 'Plan Review' : 'Plan Mode',
      content,
      detail: 'Sending your decision…',
      ephemeral: true,
      updatedAtMs: Date.now(),
    });
    let ok: boolean;
    try {
      ok = await this.options.runtime.replyQuestionnaire(
        state.agentName ?? state.request.requester?.agentName ?? this.defaultAgentName,
        state.request.id,
        buildQuestionnaireReplyAnswers(state, { skipUnanswered: false }),
      );
    } catch (error) {
      if (!this.isActiveSession(ownerSessionId)) return false;
      const outcome = classifyQuestionnaireReplyError(error);
      if (outcome.status === 'terminal') {
        await this.settleTerminalPlanQuestionnaire(state, outcome.detail);
        return true;
      }
      throw error;
    }
    // The Runtime accepted the decision: the review is over no matter which
    // Session is active now, so drop the pending-only plan body before any
    // active-session guard can return early (safe no-op when absent).
    if (ok) this.clearPlanReviewBody(state.request.id);
    if (!this.isActiveSession(ownerSessionId)) return ok;
    if (!ok) return false;
    if (ownerSessionId) {
      await this.options.controller.refreshSessionMetadata(ownerSessionId).catch(() => undefined);
    }
    if (!this.isActiveSession(ownerSessionId)) return true;
    this.updateQuestionTranscript(state.request.id, {
      status: 'resolved',
      title: state.request.modePayload?.planReview ? 'Plan Review' : 'Plan Mode',
      content,
      detail,
      ephemeral: true,
      updatedAtMs: Date.now(),
    });
    if (this.questionnaire()?.request.id === state.request.id) this.resolveQuestionnaire(state);
    this.options.onChanged();
    return true;
  }

  private restorePlanReview(state: ActiveTuiQuestionnaire): void {
    if (this.questionnaire()?.request.id !== state.request.id) return;
    if (this.panel instanceof TuiPlanReviewPanel) {
      this.panel.restore();
      return;
    }
    this.showPlanReview(state);
  }

  private async settleTerminalPlanQuestionnaire(
    state: ActiveTuiQuestionnaire,
    detail: string,
  ): Promise<void> {
    const ownerSessionId = state.sessionId ?? this.options.controller.snapshot().session?.sessionId;
    // The questionnaire is terminally settled on the Runtime side regardless of
    // which Session is active: drop the pending-only plan body unconditionally.
    this.clearPlanReviewBody(state.request.id);
    if (!this.isActiveSession(ownerSessionId)) return;
    const existing = this.options.transcript.get(`question:${state.request.id}`);
    if (this.questionnaire()?.request.id === state.request.id) this.resolveQuestionnaire(state);
    if (ownerSessionId) {
      await this.options.controller.refreshSessionMetadata(ownerSessionId).catch(() => undefined);
    }
    if (!this.isActiveSession(ownerSessionId)) return;
    const now = Date.now();
    this.options.transcript.upsert({
      id: `question:${state.request.id}`,
      kind: 'question',
      status: 'resolved',
      title: state.request.modePayload?.planReview
        ? 'Plan Review closed'
        : 'Plan Mode decision closed',
      content: existing?.content ?? '',
      detail,
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
    });
    this.options.onChanged();
  }

  private appendPlanReviewFailure(error: unknown): void {
    this.options.append(
      formatTuiActionFailure(error, {
        summary: "Couldn't apply that Plan decision.",
        nextStep: 'Retry from the Plan Review panel.',
        preservation: 'The frozen Plan remains pending.',
      }),
      'error',
    );
  }

  private async handleQuestionnaireAnswer(
    state: ActiveTuiQuestionnaire,
    index: number,
    text: string,
    answerOptions: { interactive?: boolean } = {},
  ): Promise<void> {
    const result = recordQuestionnaireAnswer(state, index, text);
    if (!result.ok) {
      this.options.append(result.message, 'warning');
      if (this.questionnaire()?.request.id === state.request.id) {
        this.showQuestionnairePicker();
      }
      return;
    }
    this.updateQuestionTranscript(state.request.id, {
      content: formatQuestionnaireAnswerSummary(state),
      detail: `${state.answers.size} of ${state.request.steps.length} answered`,
      updatedAtMs: Date.now(),
    });
    if (isQuestionnaireComplete(state)) {
      if (!answerOptions.interactive) await this.submitQuestionnaire(state, false);
    } else if (!answerOptions.interactive) {
      this.showQuestionnairePicker();
    }
  }

  private requestQuestionnaireDismissal(state: ActiveTuiQuestionnaire): Promise<void> {
    return this.withAgentSubmission(state.request.id, () =>
      this.settleQuestionnaireDismissal(state),
    );
  }

  private async settleQuestionnaireDismissal(state: ActiveTuiQuestionnaire): Promise<void> {
    const requestId = state.request.id;
    if (this.questionnaireDismissals.has(requestId)) return;
    this.questionnaireDismissals.add(requestId);
    if (this.questionnaire()?.request.id === requestId) {
      const panel = this.panel;
      if (panel instanceof TuiQuestionnairePicker) panel.beginDismiss();
    }
    this.options.onChanged();
    try {
      await this.dismissQuestionnaire(state);
    } finally {
      this.questionnaireDismissals.delete(requestId);
      if (this.questionnaire()?.request.id === requestId) this.showQuestionnairePicker();
      else this.options.onChanged();
    }
  }

  private async dismissQuestionnaire(state: ActiveTuiQuestionnaire): Promise<void> {
    const ownerSessionId = state.sessionId ?? this.options.controller.snapshot().session?.sessionId;
    let dismissed: boolean;
    try {
      dismissed = await this.options.runtime.dismissQuestionnaire(
        state.agentName ?? state.request.requester?.agentName ?? this.defaultAgentName,
        state.request.id,
      );
    } catch (error) {
      if (!this.isActiveSession(ownerSessionId)) return;
      const outcome = classifyQuestionnaireReplyError(error);
      if (outcome.status !== 'terminal') {
        if (this.questionnaire()?.request.id === state.request.id) {
          this.showQuestionnairePicker();
        }
        throw error;
      }
      const existing = this.options.transcript.get(`question:${state.request.id}`);
      const isCurrent = this.questionnaire()?.request.id === state.request.id;
      if (isCurrent) this.resolveQuestionnaire(state);
      if (ownerSessionId) {
        await this.options.controller.refreshSessionMetadata(ownerSessionId).catch(() => undefined);
      }
      if (!this.isActiveSession(ownerSessionId)) return;
      const now = Date.now();
      this.options.transcript.upsert({
        id: `question:${state.request.id}`,
        kind: 'question',
        status: 'resolved',
        title: 'Question closed',
        content: existing?.content ?? '',
        detail: outcome.detail,
        createdAtMs: existing?.createdAtMs ?? now,
        updatedAtMs: now,
      });
      this.options.onChanged();
      return;
    }
    if (!this.isActiveSession(ownerSessionId)) return;
    if (!dismissed) {
      this.options.append("Couldn't dismiss this question. It remains open; retry.", 'error');
      if (this.questionnaire()?.request.id === state.request.id) {
        this.showQuestionnairePicker();
      }
      return;
    }
    const isCurrent = this.questionnaire()?.request.id === state.request.id;
    if (state.request.mode === 'plan' && ownerSessionId) {
      await this.options.controller.refreshSessionMetadata(ownerSessionId).catch(() => undefined);
    }
    this.updateQuestionTranscript(state.request.id, {
      status: 'resolved',
      title: 'Question dismissed',
      content: '',
      detail: undefined,
      updatedAtMs: Date.now(),
    });
    if (isCurrent) this.resolveQuestionnaire(state);
    else this.options.onChanged();
  }

  private submitQuestionnaire(
    state: ActiveTuiQuestionnaire,
    skipUnanswered: boolean,
  ): Promise<void> {
    return this.withAgentSubmission(state.request.id, () =>
      this.settleQuestionnaireSubmission(state, skipUnanswered),
    );
  }

  private async settleQuestionnaireSubmission(
    state: ActiveTuiQuestionnaire,
    skipUnanswered: boolean,
  ): Promise<void> {
    const ownerSessionId = state.sessionId ?? this.options.controller.snapshot().session?.sessionId;
    this.updateQuestionTranscript(state.request.id, {
      title: 'Answers sent',
      content: formatQuestionnaireAnswerSummary(state),
      ephemeral: true,
      updatedAtMs: Date.now(),
    });
    let continuation: Awaited<ReturnType<QuestionnaireContinuation['reply']>>;
    try {
      continuation = await this.continuation.reply(state, skipUnanswered);
    } catch (error) {
      if (this.questionnaire()?.request.id === state.request.id) {
        this.showQuestionnairePicker();
      }
      throw error;
    }
    if (!this.isActiveSession(ownerSessionId)) return;
    if (!continuation.ok) {
      this.options.append("Couldn't send your answers. The question remains open; retry.", 'error');
      if (this.questionnaire()?.request.id === state.request.id) {
        this.showQuestionnairePicker();
      }
      return;
    }
    if (state.request.mode === 'plan' && ownerSessionId) {
      await this.options.controller.refreshSessionMetadata(ownerSessionId).catch(() => undefined);
    }
    const isCurrent = this.questionnaire()?.request.id === state.request.id;
    if (isCurrent) this.resolveQuestionnaire(state);
    if (continuation.finished) this.continuation.clear(state.request.id);
    this.options.onChanged();
  }

  private replyPermission(decision: TuiPermissionDecision, feedback?: string): Promise<void> {
    const request = this.permission();
    if (!request?.requestId) {
      this.options.append('No pending permission request.');
      return Promise.resolve();
    }
    const requestId = request.requestId;
    if (decision === 'allowAlways' && request.allowAlwaysSupported === false) {
      this.options.append(
        'This action cannot be remembered; choose Allow for this conversation or Deny.',
        'warning',
      );
      this.showPermissionPicker();
      return Promise.resolve();
    }
    return this.withAgentSubmission(requestId, () =>
      this.settlePermissionSubmission(request, requestId, decision, feedback),
    );
  }

  private async settlePermissionSubmission(
    request: TuiPendingPermission,
    requestId: string,
    decision: TuiPermissionDecision,
    feedback?: string,
  ): Promise<void> {
    const presentationSessionId = this.options.controller.snapshot().session?.sessionId;
    let ok: boolean;
    try {
      ok = await this.options.runtime.replyPermission(
        request.agentName ?? this.defaultAgentName,
        requestId,
        decision,
      );
    } catch (error) {
      if (!this.isActiveSession(presentationSessionId)) return;
      if (this.permission()?.requestId === requestId) this.showPermissionPicker();
      throw error;
    }
    if (!this.isActiveSession(presentationSessionId)) {
      if (ok && presentationSessionId) {
        this.options.stateStore.dispatch({
          type: 'interaction/permissionResolved',
          sessionId: presentationSessionId,
          requestId,
        });
      }
      return;
    }
    if (!ok) {
      if (this.permission()?.requestId !== requestId) return;
      const pending = await this.options.runtime.listPendingPermissions().catch(() => undefined);
      if (pending && !pending.some((item) => item.requestId === requestId)) {
        this.options.transcript.upsert({
          id: `permission:${requestId}`,
          status: 'resolved',
          detail: 'Resolved on another surface.',
          updatedAtMs: Date.now(),
        });
        this.resolvePermission(request, presentationSessionId);
        if (!(await this.showNextPendingPermission(presentationSessionId, requestId))) {
          this.showQuestionnairePicker();
        }
        return;
      }
      this.options.append(
        "Couldn't send your permission choice. The request remains open; retry.",
        'error',
      );
      if (this.permission()?.requestId === requestId) this.showPermissionPicker();
      return;
    }
    const isCurrent = this.permission()?.requestId === requestId;
    this.options.transcript.upsert({
      id: `permission:${requestId}`,
      status: 'resolved',
      detail: feedback
        ? `${formatPermissionResolution(request, decision)} · Guidance: ${sanitizeTerminalText(feedback)}`
        : formatPermissionResolution(request, decision),
      updatedAtMs: Date.now(),
    });
    if (!isCurrent) return;
    this.resolvePermission(request, presentationSessionId);
    if (decision === 'deny' && feedback && this.options.deliverPermissionFeedback) {
      try {
        await this.options.deliverPermissionFeedback(
          `Regarding the denied ${sanitizeTerminalText(request.toolName ?? 'tool')} action: ${sanitizeTerminalText(feedback)}`,
        );
      } catch (error) {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "The action was denied, but your guidance wasn't sent.",
            nextStep: 'Send it as a new message if needed.',
          }),
          'warning',
        );
      }
    }
    if (!(await this.showNextPendingPermission(presentationSessionId, requestId))) {
      this.showQuestionnairePicker();
    }
  }

  private withAgentSubmission<T>(requestId: string, action: () => Promise<T>): Promise<T> {
    if (!this.agentStatusEnabled) return action();
    const sessionId = this.options.stateStore.snapshot().activeSessionId;
    this.submittingRequestId = requestId;
    this.submittingSessionId = sessionId;
    this.options.onChanged();
    return action().finally(() => {
      if (this.submittingRequestId === requestId && this.submittingSessionId === sessionId) {
        this.clearAgentSubmission();
        this.options.onChanged();
      }
    });
  }

  private isAgentSubmission(requestId: string): boolean {
    return (
      this.submittingRequestId === requestId &&
      this.submittingSessionId === this.options.stateStore.snapshot().activeSessionId
    );
  }

  private clearAgentSubmission(): void {
    this.submittingRequestId = undefined;
    this.submittingSessionId = undefined;
  }

  private resolveQuestionnaire(state: ActiveTuiQuestionnaire): void {
    const sessionId = state.sessionId ?? this.options.controller.snapshot().session?.sessionId;
    // Covers every resolution path (decision, terminal settle, stale/cancel):
    // the pending-only frozen plan body never outlives the review.
    this.clearPlanReviewBody(state.request.id);
    if (sessionId) {
      this.options.stateStore.dispatch({
        type: 'interaction/questionnaireResolved',
        sessionId,
        requestId: state.request.id,
      });
    }
    if (!this.permission()) this.hidePanel();
    this.options.onChanged();
  }

  private resolvePermission(request: TuiPendingPermission, presentationSessionId?: string): void {
    const sessionId =
      presentationSessionId ?? this.options.controller.snapshot().session?.sessionId;
    if (sessionId && request.requestId) {
      this.options.stateStore.dispatch({
        type: 'interaction/permissionResolved',
        sessionId,
        requestId: request.requestId,
      });
    }
    this.hidePanel();
    this.options.onChanged();
  }

  private async showNextPendingPermission(
    sessionId?: string,
    excludeRequestId?: string,
  ): Promise<boolean> {
    if (!sessionId) return false;
    if (this.permission()) {
      this.showPermissionPicker();
      return true;
    }
    const permissions = await this.options.runtime
      .listPendingPermissions()
      .catch((error: unknown) => {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't check for the next permission request.",
            nextStep: 'Wait for the next prompt or retry the action.',
          }),
          'warning',
        );
        return [];
      });
    if (!this.isActiveSession(sessionId)) return false;
    if (this.permission()) {
      this.showPermissionPicker();
      return true;
    }
    const permissionScope = this.permissionSessionScope(sessionId);
    const next = permissions.find(
      (permission) =>
        permission.sessionId !== undefined &&
        permissionScope.has(permission.sessionId) &&
        permission.requestId !== excludeRequestId,
    );
    if (!next) return false;
    this.setPermission(next, sessionId);
    return true;
  }

  private permissionPresentationSessionId(
    ownerSessionId: string | undefined,
    activeSessionId: string,
  ): string | undefined {
    if (!ownerSessionId) return undefined;
    return this.permissionSessionScope(activeSessionId).has(ownerSessionId)
      ? activeSessionId
      : undefined;
  }

  private permissionSessionScope(activeSessionId: string): ReadonlySet<string> {
    const scope = new Set(this.options.permissionSessionScope?.(activeSessionId) ?? []);
    scope.add(activeSessionId);
    return scope;
  }

  private updateQuestionTranscript(
    requestId: string,
    update: Omit<TranscriptCellUpdate, 'id'>,
  ): void {
    const id = `question:${requestId}`;
    if (!this.options.transcript.get(id)) return;
    this.options.transcript.upsert({ id, ...update });
  }

  private createdAtOrNow(createdAt: number | undefined, now: number): number {
    return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : now;
  }

  private notifyPendingInteraction(
    kind: 'question-required' | 'permission-required',
    id: string,
  ): void {
    this.options.notify?.(kind, id);
    this.options.onChanged();
  }

  private isActiveSession(sessionId: string | undefined): boolean {
    return (
      !this.isStopped() &&
      Boolean(sessionId) &&
      this.options.controller.snapshot().session?.sessionId === sessionId
    );
  }

  private resolveSessionAgentName(sessionId: string): string {
    const snapshot = this.options.controller.snapshot();
    if (snapshot.session?.sessionId === sessionId && snapshot.session.agentName) {
      return snapshot.session.agentName;
    }
    return (
      snapshot.sessions.find((session) => session.sessionId === sessionId)?.agentName ??
      this.defaultAgentName
    );
  }

  private isStopped(): boolean {
    return Boolean(this.options.isStopped?.());
  }
}

function planReviewStepId(state: ActiveTuiQuestionnaire): string {
  return state.request.steps.find((step) => step.id === 'plan-review')?.id ?? 'plan-review';
}

function isTuiPlanEntry(state: ActiveTuiQuestionnaire): boolean {
  return state.request.mode === 'plan' && state.request.modePayload?.planReview === undefined;
}

function interactionOwnsTurn(
  ownerSessionId: string | undefined,
  ownerTurnId: string | undefined,
  sessionId: string,
  turnId: string,
): boolean {
  if (ownerSessionId && ownerSessionId !== sessionId) return false;
  return ownerTurnId === undefined || ownerTurnId === turnId;
}

function hasPermissionRequestId(
  permission: TuiPendingPermission,
): permission is TuiPendingPermission & { readonly requestId: string } {
  return Boolean(permission.requestId?.trim());
}
