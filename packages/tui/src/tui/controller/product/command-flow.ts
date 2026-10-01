import { parsePluginMentions } from '@mavis/shared/plugin-mention';
import {
  createTuiCommandCatalog,
  matchTuiCommandInput,
  type TuiCommandCatalog,
  type TuiCommandContribution,
  type TuiCommandHandler,
  type TuiCommandReadiness,
} from '../../commands/catalog.js';
import type { TuiComposerDraft } from '../../features/composer/draft.js';
import type { TuiWorkspaceRoots } from '../../features/composer/workspace-roots.js';
import { TuiLoginRegionPicker } from '../../features/auth/login-region-picker.js';
import { TuiPermissionModePicker } from '../../features/interaction/permission-mode-picker.js';
import { TuiSettingsPicker } from '../../features/settings/picker.js';
import { TuiHotkeysPicker } from '../../features/settings/hotkeys-picker.js';
import { submittedEditorContent, submittedEditorTransport, type Editor } from '../../widgets/editor/editor.js';
import type { TuiInteractionSurface } from '../../shell/interaction-surface.js';
import type { TuiSurfaceHost } from '../../shell/surface-host.js';
import type { TuiRunProjection } from '../../state/run-projection.js';
import type { TuiActiveRunFlow } from '../run/active-run-flow.js';
import type { TuiChatController } from '../chat-controller.js';
import type { TuiFeatureFlow } from './feature-flow.js';
import type { FeedbackFlow } from './feedback-flow.js';
import type { TuiSessionMutationFlow } from './session-mutation-flow.js';
import type { TuiInteractionFlow } from '../interaction/interaction-flow.js';
import type { TuiQueueFlow } from '../run/queue-flow.js';
import { TuiTurnSubmissionRetainer } from '../run/turn-submission-retainer.js';
import type { TuiSessionFlow } from '../session-flow.js';
import type { TuiUpdateFlow } from './update-flow.js';
import type { TuiGoalFlow } from './goal-flow.js';
import type { TuiPlanModeFlow } from '../interaction/plan-mode-flow.js';
import type { TuiPermissionModeFlow } from '../interaction/permission-mode-flow.js';
import type { MavisRegion } from '@mavis/config';
import type { McodeAuthPort } from '../../../auth/application.js';
import { markTuiAuthorizationUrl } from '../../../auth/authorization-url.js';
import type { TuiMode } from '../../engine/public.js';
import type { TuiKeybindingOverride, TuiKeybindingRegistry } from '../../shell/keybindings.js';
import {
  createTuiExternalTargetOpener,
  type TuiExternalTargetOpener,
} from '../../../host/open-external.js';
import { TuiLoginRequiredError } from '../../../application/login-gate.js';
import { TuiFailure } from '../../../failure.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import {
  createTuiSubmissionSnapshot,
  type TuiSubmissionSeed,
  type TuiSubmissionSnapshot,
} from '../../features/composer/submission.js';
import { rebuildSessionMutationTransport } from '../../features/session-mutation/transport.js';
import { toTuiTranscriptAttachments } from '../../features/composer/attachments.js';
import { resolveTuiRuntimeFailure } from '../runtime/runtime-error-presentation.js';
import type { TuiEditMessageAttachment, TuiSession } from '../../../runtime/port.js';
import type { TuiAttachment, TuiTransportAttachment } from '../../../types/invocation.js';
import { sessionMutationText } from '../../features/session-mutation/copy.js';
import { parseTuiBashInput } from '../../commands/bash-input.js';
import type { TuiBashFlow } from './bash-flow.js';

export interface TuiCommandFlowOptions {
  readonly bashFlow?: TuiBashFlow;
  readonly workspaceDir: string;
  readonly contributions?: readonly TuiCommandContribution[];
  readonly controller: TuiChatController;
  readonly activeRunFlow: TuiActiveRunFlow;
  readonly featureFlow: TuiFeatureFlow;
  readonly feedbackFlow: FeedbackFlow;
  readonly sessionMutationFlow: Pick<
    TuiSessionMutationFlow,
    | 'startHistory'
    | 'startFork'
    | 'startRewind'
    | 'startEdit'
    | 'isEditing'
    | 'submitEdit'
    | 'settleEditResubmit'
  >;
  readonly updateFlow: TuiUpdateFlow;
  readonly goalFlow?: Pick<TuiGoalFlow, 'execute' | 'resumeBlocked'>;
  readonly planModeFlow?: TuiPlanModeFlow;
  readonly permissionModeFlow?: TuiPermissionModeFlow;
  readonly auth?: McodeAuthPort;
  readonly openExternalTarget?: TuiExternalTargetOpener;
  readonly interactionFlow: TuiInteractionFlow;
  readonly sessionFlow: TuiSessionFlow;
  readonly queueFlow: TuiQueueFlow;
  readonly composerDraft: TuiComposerDraft;
  readonly workspaceRoots: TuiWorkspaceRoots;
  readonly runProjection: TuiRunProjection;
  readonly editor: Editor;
  readonly surface: TuiInteractionSurface;
  readonly surfaceHost: TuiSurfaceHost;
  readonly showTasks?: () => void | Promise<void>;
  readonly showStatusLine?: () => void;
  readonly showTheme?: () => void;
  readonly persistTuiMode?: (mode: TuiMode) => void;
  readonly queueEnabled: boolean;
  readonly liveRunId: () => string | undefined;
  readonly runtimeStopping: () => boolean;
  readonly isLlmRetrying?: () => boolean;
  readonly abortLiveTurn: () => Promise<boolean>;
  readonly leaveUi: () => Promise<void>;
  readonly requestRestart?: (region?: MavisRegion, initialPrompt?: string) => void;
  readonly keybindings?: TuiKeybindingRegistry;
  readonly getTuiKeybindingOverrides?: () => Readonly<Record<string, TuiKeybindingOverride>>;
  readonly saveTuiKeybindingOverrides?: (
    overrides: Readonly<Record<string, TuiKeybindingOverride>>,
  ) => Promise<void> | void;
  readonly reloadTui?: () => Promise<void>;
  readonly notifyAuthContextChanged?: (
    authState: 'authenticated' | 'logged_out',
  ) => void | Promise<void>;
  readonly whenControllerReady?: () => Promise<void>;
  readonly whenReady: () => Promise<void>;
  readonly whenStopping?: () => Promise<void>;
  readonly isStopped?: () => boolean;
  readonly append: (content: string, kind?: 'final-summary' | 'warning' | 'error') => void;
  readonly setHint: (message: string | undefined) => void;
  readonly onChanged: () => void;
  readonly userMessageCount?: () => number;
  readonly onMessageAdmitted?: (input: {
    readonly attachmentCount: number;
    readonly isFirstMessage: boolean;
  }) => void;
}

export type TuiCommandSubmitDisposition = 'consumed' | 'retained';

export interface TuiCommandSubmitOptions {
  readonly onRuntimeAccepted?: () => void;
  /** Hidden transport restored after an Edit rewind; the editor still holds visible text. */
  readonly transportContent?: string;
  /** Submit restored user text literally, even when it starts with a slash command. */
  readonly forceMessage?: boolean;
  /** Keep an atomic restored Edit pending until Runtime durably accepts it. */
  readonly requireRuntimeAcceptance?: boolean;
  readonly onSubmissionPrepared?: (submission: TuiSubmissionSnapshot) => void;
  /** Explicit keyboard intent while a Turn is active. Enter steers; Alt+Enter queues. */
  readonly busyAction?: 'steer' | 'queue';
  readonly reviewRequest?: { readonly scope: 'local_changes' };
}

const TUI_REVIEW_PROMPT = 'Please review my uncommitted changes.';

type PreparedMessageSubmission =
  | { readonly disposition: TuiCommandSubmitDisposition }
  | {
      readonly primary: ReturnType<TuiChatController['submit']>;
      readonly currentSubmission: () => TuiSubmissionSnapshot;
      readonly atomic: boolean;
    };

type SubmissionReadinessContext = {
  readonly input: string;
  readonly command: string;
  readonly seed: TuiSubmissionSeed | undefined;
  readonly options: TuiCommandSubmitOptions;
  readonly optimisticRequestId: string | undefined;
  readonly queueAdmissionId: string | undefined;
  readonly preservePreparingHint: boolean;
};

export class TuiCommandFlow {
  readonly catalog: TuiCommandCatalog;
  private preparationTail: Promise<void> = Promise.resolve();
  private loginRegionPicker: TuiLoginRegionPicker | undefined;
  private pendingLoginContinuation: 'checkin' | undefined;
  private permissionModePicker: TuiPermissionModePicker | undefined;
  private settingsPicker: TuiSettingsPicker | undefined;
  private hotkeysPicker: TuiHotkeysPicker | undefined;
  private submissionCounter = 0;
  private preparingMessages = 0;
  private shellSubmissionPending = false;
  private readonly recoverableSubmissions = new Map<string, TuiSubmissionSnapshot>();
  private readonly sessionRetryability = new Map<string, boolean>();
  private readonly failedSubmissions = new Map<string, TuiSubmissionSnapshot>();
  private readonly turnSubmissionRetainer = new TuiTurnSubmissionRetainer();
  private readonly restoredAbortSubmissionIds = new Set<string>();
  private readonly openExternalTarget: TuiExternalTargetOpener;

  constructor(private readonly options: TuiCommandFlowOptions) {
    this.openExternalTarget =
      options.openExternalTarget ?? createTuiExternalTargetOpener(options.workspaceDir);
    this.catalog = createTuiCommandCatalog(options.contributions, this.createHandlers(), () =>
      this.commandContext(),
    );
  }

  /** The original submission retained for a still-unoutput turn, if any. */
  getRetainedSubmission(turnId: string): TuiSubmissionSnapshot | undefined {
    return this.turnSubmissionRetainer.get(turnId);
  }

  dropRetainedSubmission(turnId: string): void {
    this.turnSubmissionRetainer.drop(turnId);
  }

  /** Clears per-turn retained submissions on a session switch. */
  clearRetainedSubmissions(): void {
    this.turnSubmissionRetainer.clear();
    this.restoredAbortSubmissionIds.clear();
  }

  /** Keep a restored draft's attachment lease when its original send finishes. */
  markAbortSubmissionRestored(submissionId: string): void {
    this.restoredAbortSubmissionIds.add(submissionId);
    if (this.restoredAbortSubmissionIds.size > 8) {
      const oldest = this.restoredAbortSubmissionIds.values().next().value;
      if (oldest) this.restoredAbortSubmissionIds.delete(oldest);
    }
  }

  captureSubmissionSeed(editorDraft?: ReturnType<Editor['captureDraft']>): TuiSubmissionSeed {
    const sessionId = this.options.controller.snapshot().session?.sessionId;
    const editor = editorDraft ?? this.options.editor.captureDraft();
    const resources = this.options.composerDraft.capture();
    try {
      this.options.composerDraft.reserveSubmission(resources);
    } catch (error) {
      this.options.composerDraft.restoreSubmission(resources);
      throw error;
    }
    const recoveryKey = sessionId ?? 'new-session';
    const recoverable = this.recoverableSubmissions.get(recoveryKey);
    this.recoverableSubmissions.delete(recoveryKey);
    const visibleContent = submittedEditorContent(editor);
    const unchangedText = recoverable?.content === visibleContent;
    // Hidden context may be rebuilt for an edited session-mutation message.
    // Other opaque transport (including /review) belongs to the old text and
    // must not override the user's correction.
    const pluginTransport = recoverable?.transportContent && parsePluginMentions(recoverable.transportContent).length > 0
      ? rebuildSessionMutationTransport(recoverable.transportContent, submittedEditorTransport(editor) ?? visibleContent)
      : undefined;
    const transportContent = pluginTransport ?? (recoverable?.transportContent &&
      parsePluginMentions(recoverable.transportContent).length === 0 &&
      (unchangedText || rebuildSessionMutationTransport(recoverable.transportContent, visibleContent))
      ? recoverable.transportContent
      : undefined);
    const transportAttachments = recoverable?.transportAttachments
      ? reconcileRecoveredTransportAttachments(recoverable, resources.attachments)
      : undefined;
    return {
      ...(sessionId ? { sessionId } : {}),
      editor,
      resources,
      ...(transportContent ? { transportContent } : {}),
      ...(transportAttachments
        ? { transportAttachments }
        : {}),
      ...(unchangedText && recoverable?.clientIntent
        ? { clientIntent: recoverable.clientIntent }
        : {}),
      ...(unchangedText && recoverable?.reviewRequest
        ? { reviewRequest: recoverable.reviewRequest }
        : {}),
    };
  }

  restoreRecoverableSubmission(submission: TuiSubmissionSnapshot): void {
    this.recoverableSubmissions.set(submission.sessionId ?? 'new-session', submission);
  }

  setSessionRetryable(sessionId: string, retryable: boolean): void {
    this.sessionRetryability.set(sessionId, retryable);
    if (!retryable) this.failedSubmissions.delete(sessionId);
    this.options.onChanged();
  }

  async submit(
    input: string,
    seed?: TuiSubmissionSeed,
    options: TuiCommandSubmitOptions = {},
  ): Promise<TuiCommandSubmitDisposition> {
    const recoveryTransport = options.transportContent ?? seed?.transportContent;
    const submitOptions = recoveryTransport
      ? {
          ...options,
          forceMessage: true,
          requireRuntimeAcceptance: true,
          transportContent:
            options.transportContent ??
            rebuildSessionMutationTransport(recoveryTransport, seed ? submittedEditorTransport(seed.editor) ?? input : input) ??
            recoveryTransport,
          ...(seed?.reviewRequest && !options.reviewRequest
            ? { reviewRequest: seed.reviewRequest }
            : {}),
        }
      : options;
    const command = input.trim();
    // Local commands remain commands while editing a historical message.
    // Skills and explicit message submissions still belong to the edited prompt.
    const localCommand = !submitOptions.forceMessage && this.catalog.resolve(command);
    if (
      this.options.sessionMutationFlow?.isEditing?.() &&
      (!localCommand || localCommand.invocationKind === 'skill')
    ) {
      const editDisposition = await this.options.sessionMutationFlow.submitEdit(
        input,
        seed?.resources.attachments,
        seed?.editor,
      );
      if (editDisposition === 'consumed') {
        if (seed) await this.options.composerDraft.completeSubmission(seed.resources);
        return 'consumed';
      }
      if (editDisposition === 'retained') return this.restoreSeed(seed, input);
      if (editDisposition?.kind === 'resubmit') {
        try {
          const recoveredSeed = seed ?? this.captureSubmissionSeed();
          const disposition = await this.submit(
            input,
            {
              ...recoveredSeed,
              resources: recoveredSeed.resources,
              transportAttachments: toRecoveredEditTransportAttachments(
                editDisposition.attachments ?? [],
              ),
            },
            {
              ...submitOptions,
              forceMessage: true,
              requireRuntimeAcceptance: true,
              transportContent: editDisposition.transportContent,
            },
          );
          this.options.sessionMutationFlow.settleEditResubmit(disposition === 'consumed');
          return disposition;
        } catch (error) {
          this.options.sessionMutationFlow.settleEditResubmit(false);
          throw error;
        }
      }
    }
    if (!command && !seedHasResources(seed) && !this.options.composerDraft.hasContent()) {
      return 'consumed';
    }
    if (this.shellSubmissionPending || this.options.bashFlow?.isRunning()) {
      this.options.setHint('Shell command running · Esc or Ctrl+C to cancel');
      return this.restoreSeed(seed, input);
    }
    const bash = !submitOptions.forceMessage && parseTuiBashInput(input);
    if (bash && this.options.bashFlow) {
      if (this.options.isStopped?.()) return this.restoreSeed(seed, input);
      if (!bash.command) {
        this.options.setHint('Type a command after !');
        return this.restoreSeed(seed, input);
      }
      if (seedHasResources(seed) || this.options.composerDraft.hasContent()) {
        this.options.setHint('Remove attachments before running a shell command');
        return this.restoreSeed(seed, input);
      }
      const snapshot = this.options.controller.snapshot();
      if (this.isAgentBusyForShell()) {
        this.options.setHint(
          'Wait for the current response or interaction before running a shell command',
        );
        return this.restoreSeed(seed, input);
      }
      this.shellSubmissionPending = true;
      try {
        if (seed) await this.options.composerDraft.completeSubmission(seed.resources);
        if (this.options.isStopped?.()) return 'consumed';
        if (this.options.controller.snapshot().session?.sessionId !== snapshot.session?.sessionId) {
          this.options.setHint('Session changed; submit the shell command again');
          return this.restoreSeed(seed, input);
        }
        if (this.isAgentBusyForShell()) {
          this.options.setHint(
            'Wait for the current response or interaction before running a shell command',
          );
          return this.restoreSeed(seed, input);
        }
        await this.options.bashFlow.run(
          bash,
          snapshot.session?.workspaceDir ?? this.options.workspaceDir,
          snapshot.session?.sessionId,
        );
        return 'consumed';
      } finally {
        this.shellSubmissionPending = false;
      }
    }
    const chat = this.options.controller.snapshot();
    const canStageSubmission = this.canStageSubmission(command, seed, submitOptions, chat);
    const queueAdmissionId =
      canStageSubmission && this.shouldQueueSubmission(submitOptions.busyAction)
        ? this.nextSubmissionId()
        : undefined;
    const optimisticRequestId =
      canStageSubmission &&
      !queueAdmissionId &&
      submitOptions.busyAction !== 'steer' &&
      typeof this.options.controller.projectOptimisticUserMessage === 'function'
        ? this.nextSubmissionId()
        : undefined;
    if (optimisticRequestId) {
      this.options.controller.projectOptimisticUserMessage?.(
        optimisticRequestId,
        command,
        Date.now(),
        toTuiTranscriptAttachments(seed?.resources.attachments ?? []),
      );
    }
    if (queueAdmissionId) {
      this.options.queueFlow.beginAdmission(
        queueAdmissionId,
        command,
        seed?.resources.attachments.map((attachment) => attachment.fileName) ?? [],
      );
    }
    const commandDefinition = submitOptions.forceMessage
      ? undefined
      : this.catalog.resolve(command);
    const preparingHint = commandDefinition?.preparingHint;
    if (!commandDefinition) this.preparingMessages += 1;
    if (preparingHint) {
      this.options.setHint(preparingHint);
      this.options.onChanged();
    }
    try {
      await this.waitForReadiness(commandDefinition?.readiness ?? 'full');
      return await this.submitAfterReadiness({
        input,
        command,
        seed,
        options: submitOptions,
        optimisticRequestId,
        queueAdmissionId,
        preservePreparingHint: Boolean(preparingHint),
      });
    } finally {
      if (!commandDefinition) this.preparingMessages -= 1;
      if (preparingHint) {
        this.options.setHint(undefined);
        this.options.onChanged();
      }
      if (optimisticRequestId) {
        this.options.controller.removeOptimisticUserMessage?.(optimisticRequestId);
      }
      if (queueAdmissionId) this.options.queueFlow.cancelAdmission(queueAdmissionId);
    }
  }

  private async submitAfterReadiness({
    input,
    command,
    seed,
    options,
    optimisticRequestId,
    queueAdmissionId,
    preservePreparingHint,
  }: SubmissionReadinessContext): Promise<TuiCommandSubmitDisposition> {
    if (this.options.isStopped?.()) {
      if (seed) await this.completeStoppedSubmission(seed);
      return 'consumed';
    }
    if (this.shellSubmissionPending || this.options.bashFlow?.isRunning()) {
      this.options.setHint('Shell command running · Esc or Ctrl+C to cancel');
      return this.restoreSeed(seed, input);
    }
    if (!preservePreparingHint) this.options.setHint(undefined);
    const isFirstMessage = (this.options.userMessageCount?.() ?? 0) === 0;

    const chat = this.options.controller.snapshot();
    if (
      (chat.cancelling || chat.retiringTurnId || this.options.runtimeStopping()) &&
      !(options.forceMessage ? false : isAvailableWhileStopping(command, this.catalog))
    ) {
      this.options.setHint(
        chat.retiringTurnId
          ? 'Runtime is still stopping; your draft is preserved.'
          : 'Stopping the current response. Your draft is preserved.',
      );
      this.options.onChanged();
      return this.restoreSeed(seed, input);
    }
    const catalogCommand = !options.forceMessage && isCatalogCommand(command, this.catalog);
    if (catalogCommand) this.restoreSeedResources(seed);
    if (!options.forceMessage && (await this.options.interactionFlow.handleCommand(command))) {
      if (!catalogCommand) this.restoreSeedResources(seed);
      return 'consumed';
    }
    if (!options.forceMessage) {
      const dispatch = await this.catalog.dispatch(command);
      if (dispatch.status === 'handled') {
        if (!catalogCommand) this.restoreSeedResources(seed);
        const disposition = dispatch.disposition ?? 'consumed';
        if (disposition === 'retained' && seed) this.restoreCatalogSeedEditor(seed);
        return disposition;
      }
      if (dispatch.status === 'unavailable') {
        if (!catalogCommand) this.restoreSeedResources(seed);
        this.options.setHint(dispatch.reason);
        this.options.onChanged();
        return 'consumed';
      }
    }
    if (this.options.interactionFlow.hasPending()) {
      if (command && !seed) {
        this.options.editor.setText(input);
        this.options.surfaceHost.setChatFocus(this.options.editor);
      }
      this.options.setHint('Resolve the pending Agent interaction first.');
      this.options.interactionFlow.showPending();
      this.options.onChanged();
      return this.restoreSeed(seed, input);
    }
    let prepared: PreparedMessageSubmission;
    let preparingSubmission: TuiSubmissionSnapshot | undefined;
    let runtimeAccepted = false;
    try {
      prepared = await this.serializePreparation(async () => {
        const captureDraft = this.options.composerDraft.capture?.bind(this.options.composerDraft);
        const resources =
          seed?.resources ??
          (captureDraft ? captureDraft() : this.options.composerDraft.reserveSubmission());
        const resourcesAlreadyReserved = Boolean(seed) || (!seed && !captureDraft);
        const submissionId = this.nextSubmissionId();
        const bashContext = this.options.bashFlow?.takeContext(
          seed ? seed.sessionId : this.options.controller.snapshot().session?.sessionId,
        );
        const boundContent = seed ? submittedEditorTransport(seed.editor) : undefined;
        const messageContent = options.transportContent ?? boundContent;
        const transportContent = bashContext
          ? `${bashContext}\n\n${messageContent ?? command}`
          : messageContent;
        let submission = createTuiSubmissionSnapshot({
          submissionId,
          sessionId: seed ? seed.sessionId : this.options.controller.snapshot().session?.sessionId,
          editor: seed?.editor ?? captureEditorDraft(this.options.editor, command),
          content: command,
          resources,
          ...(seed?.transportAttachments
            ? { transportAttachments: seed.transportAttachments }
            : {}),
          ...(transportContent ? { transportContent } : {}),
          clientIntent:
            seed?.clientIntent ?? this.options.planModeFlow?.reserveClientIntent(submissionId),
          ...(options.reviewRequest ? { reviewRequest: options.reviewRequest } : {}),
        });
        preparingSubmission = submission;
        options.onSubmissionPrepared?.(submission);
        if (this.options.isStopped?.()) {
          if (seed) await this.completeStoppedSubmission(seed);
          return { disposition: 'consumed' };
        }
        const currentChat = this.options.controller.snapshot();
        if (
          currentChat.cancelling ||
          currentChat.retiringTurnId ||
          this.options.runtimeStopping()
        ) {
          this.options.planModeFlow?.rejectSubmission(submission.submissionId);
          this.options.setHint(
            currentChat.retiringTurnId
              ? 'Runtime is still stopping; your draft is preserved.'
              : 'Stopping the current response. Your draft is preserved.',
          );
          this.options.onChanged();
          return {
            disposition: await this.restorePreparedSubmission(seed, submission, input),
          };
        }
        if (this.options.interactionFlow.hasPending()) {
          this.options.planModeFlow?.rejectSubmission(submission.submissionId);
          this.options.setHint('Resolve the pending Agent interaction first.');
          this.options.interactionFlow.showPending();
          this.options.onChanged();
          return {
            disposition: await this.restorePreparedSubmission(seed, submission, input),
          };
        }
        if (
          seed?.sessionId &&
          this.options.controller.snapshot().session?.sessionId !== seed.sessionId
        ) {
          this.options.planModeFlow?.rejectSubmission(submission.submissionId);
          return {
            disposition: this.restoreSubmission(submission),
          };
        }
        if (
          this.options.liveRunId() ||
          this.options.controller.hasInProcessRun?.() ||
          (this.options.queueEnabled &&
            this.options.runProjection.snapshot().queuedCount > 0 &&
            !this.options.runProjection.snapshot().queuePaused)
        ) {
          if (options.busyAction === 'steer') {
            try {
              await this.options.controller.requireLoginForAgentAction();
              const accepted = await this.options.activeRunFlow.steer(
                submission.transportContent ?? command,
                {
                  requireActiveTurn: true,
                  ...(submission.transportContent ? { displayContent: command } : {}),
                  attachments: submission.transportAttachments ?? submission.attachments,
                  transcriptAttachments: submission.attachments,
                },
              );
              if (!accepted) {
                this.options.planModeFlow?.rejectSubmission(submission.submissionId);
                return {
                  disposition: await this.restorePreparedSubmission(seed, submission, input),
                };
              }
              options.onRuntimeAccepted?.();
              this.options.onMessageAdmitted?.({
                attachmentCount: submission.attachments.length,
                isFirstMessage,
              });
              this.options.planModeFlow?.rejectSubmission(submission.submissionId);
              await this.completeSubmittedResources(submission);
              return { disposition: 'consumed' };
            } catch (error) {
              this.options.planModeFlow?.rejectSubmission(submission.submissionId);
              this.appendProtectedActionError(
                error,
                "Couldn't send guidance to the active response.",
              );
              return {
                disposition: await this.restorePreparedSubmission(seed, submission, input),
              };
            }
          }
          if (this.options.queueEnabled) {
            if (optimisticRequestId) {
              this.options.controller.removeOptimisticUserMessage?.(optimisticRequestId);
            }
            const activeAdmissionId = queueAdmissionId ?? this.nextSubmissionId();
            if (!queueAdmissionId) {
              this.options.queueFlow.beginAdmission(
                activeAdmissionId,
                command,
                submission.attachments.map((attachment) => attachment.fileName),
              );
            }
            let queuedItemId: string | undefined;
            try {
              await this.options.controller.requireLoginForAgentAction();
              const draft = {
                attachments: submission.attachments,
              };
              if (
                seed ||
                submission.clientIntent ||
                submission.transportContent ||
                submission.reviewRequest
              ) {
                queuedItemId = await this.options.queueFlow.enqueue(
                  command,
                  draft,
                  submission,
                  activeAdmissionId,
                );
              } else {
                queuedItemId = await this.options.queueFlow.enqueue(
                  command,
                  draft,
                  undefined,
                  activeAdmissionId,
                );
              }
            } catch (error) {
              this.options.queueFlow.cancelAdmission(activeAdmissionId);
              this.options.planModeFlow?.rejectSubmission(submission.submissionId);
              this.options.append(queueSubmissionFailureMessage(error), 'warning');
              return {
                disposition: await this.restorePreparedSubmission(seed, submission, input),
              };
            }
            if (queuedItemId) {
              this.options.onMessageAdmitted?.({
                attachmentCount: submission.attachments.length,
                isFirstMessage,
              });
            }
            return { disposition: 'consumed' };
          }
          this.options.setHint('Wait for the current response or press Esc to interrupt');
          this.options.onChanged();
          return {
            disposition: await this.restorePreparedSubmission(seed, submission, input),
          };
        }

        if (queueAdmissionId) this.options.queueFlow.cancelAdmission(queueAdmissionId);
        if (!resourcesAlreadyReserved) {
          this.options.composerDraft.reserveSubmission({
            attachments: submission.attachments,
          });
        }
        await this.options.featureFlow.waitForWelcomeModelSelection();
        let retainedTurnId: string | undefined;
        try {
          return {
            primary: this.options.controller.submit(submission.transportContent ?? command, {
              ...(this.options.queueEnabled
                ? {
                    onQueuePaused: (sessionId, signal) =>
                      this.options.queueFlow.requestPausedSendDecision(sessionId, signal),
                  }
                : {}),
              attachments: submission.transportAttachments ?? submission.attachments,
              ...(submission.transportContent ? { displayContent: command } : {}),
              ...(optimisticRequestId ? { optimisticRequestId } : {}),
              ...(submission.clientIntent ? { clientIntent: submission.clientIntent } : {}),
              ...(submission.reviewRequest ? { reviewRequest: submission.reviewRequest } : {}),
              onTurnStarted: (turnId) => {
                // Retain the original submission for this turn so an early
                // abort can replay it in full instead of reconstructing a
                // lossy copy from the transcript cell.
                retainedTurnId = turnId;
                this.turnSubmissionRetainer.remember(turnId, submission);
              },
              onSessionResolved: (sessionId) => {
                submission = { ...submission, sessionId };
                preparingSubmission = submission;
                // Re-remember with the resolved session id attached.
                if (retainedTurnId !== undefined) {
                  this.turnSubmissionRetainer.remember(retainedTurnId, submission);
                }
                options.onSubmissionPrepared?.(submission);
                if (submission.clientIntent) {
                  this.options.planModeFlow?.bindSubmissionToSession(
                    submission.submissionId,
                    sessionId,
                  );
                }
              },
              beforeTurnAdmission: (sessionId) =>
                this.options.featureFlow.applyPendingModelSelection(sessionId),
              ...(options.onRuntimeAccepted ||
              options.requireRuntimeAcceptance ||
              submission.transportContent ||
              this.options.onMessageAdmitted ||
              submission.clientIntent
                ? {
                    onRuntimeAccepted: (sessionId) => {
                      runtimeAccepted = true;
                      this.options.planModeFlow?.bindSubmissionToSession(
                        submission.submissionId,
                        sessionId,
                      );
                      this.options.planModeFlow?.acceptDirect(
                        submission.clientIntent,
                        sessionId,
                        submission.submissionId,
                      );
                      void this.options.controller
                        .refreshSessionMetadata(sessionId)
                        .catch(() => undefined);
                      options.onRuntimeAccepted?.();
                      this.options.onMessageAdmitted?.({
                        attachmentCount: submission.attachments.length,
                        isFirstMessage,
                      });
                    },
                  }
                : {}),
            }),
            currentSubmission: () => submission,
            atomic: Boolean(seed || submission.transportContent),
          };
        } catch (error) {
          this.options.planModeFlow?.rejectSubmission(submission.submissionId);
          if (!seed) {
            this.options.composerDraft.restoreSubmission({
              attachments: submission.attachments,
            });
          }
          throw error;
        }
      });
    } catch (error) {
      const message = prepareSubmissionFailureMessage(error);
      this.options.append(message, 'warning');
      if (preparingSubmission?.transportContent) {
        return this.restorePreparedSubmission(seed, preparingSubmission, input);
      }
      return seed ? this.restoreSeed(seed, input) : 'retained';
    }
    if ('disposition' in prepared) return prepared.disposition;

    let submitStatus: Awaited<ReturnType<TuiChatController['submit']>>;
    try {
      submitStatus = await prepared.primary;
    } catch (error) {
      const submission = prepared.currentSubmission();
      this.options.planModeFlow?.rejectSubmission(submission.submissionId);
      const message = submitFailureMessage(error);
      if (prepared.atomic) {
        this.restoreSubmission(submission);
      } else {
        this.options.composerDraft.restoreSubmission({
          attachments: submission.attachments,
        });
      }
      this.appendProtectedActionError(error, message);
      return 'retained';
    }
    const submission = prepared.currentSubmission();
    if (
      (options.requireRuntimeAcceptance ||
        (submission.transportContent && submitStatus !== 'queue-required')) &&
      !runtimeAccepted
    ) {
      this.updateRetryState(submitStatus, submission);
      this.options.planModeFlow?.rejectSubmission(submission.submissionId);
      this.restoreSubmission(submission);
      return 'retained';
    }
    if (this.options.isStopped?.()) {
      await this.options.whenStopping?.();
      await this.completeSubmittedResources(submission);
      return 'consumed';
    }
    if (submitStatus === 'queue-required' && this.options.queueEnabled) {
      if (optimisticRequestId) {
        this.options.controller.removeOptimisticUserMessage?.(optimisticRequestId);
      }
      const fallbackAdmissionId = this.nextSubmissionId();
      this.options.queueFlow.beginAdmission(
        fallbackAdmissionId,
        command,
        submission.attachments.map((attachment) => attachment.fileName),
      );
      let fallbackItemId: string | undefined;
      try {
        const draft = {
          attachments: submission.attachments,
        };
        if (prepared.atomic || submission.clientIntent || submission.reviewRequest) {
          fallbackItemId = await this.options.queueFlow.enqueue(
            command,
            draft,
            submission,
            fallbackAdmissionId,
          );
        } else {
          fallbackItemId = await this.options.queueFlow.enqueue(
            command,
            draft,
            undefined,
            fallbackAdmissionId,
          );
        }
        if (fallbackItemId) {
          this.options.onMessageAdmitted?.({
            attachmentCount: submission.attachments.length,
            isFirstMessage,
          });
        }
        return 'consumed';
      } catch (error) {
        this.options.queueFlow.cancelAdmission(fallbackAdmissionId);
        this.options.planModeFlow?.rejectSubmission(submission.submissionId);
        const message = queueSubmissionFailureMessage(error);
        if (prepared.atomic) {
          this.restoreSubmission(submission);
        } else {
          this.options.composerDraft.restoreSubmission({
            attachments: submission.attachments,
          });
        }
        this.options.append(message, 'warning');
        return 'retained';
      }
    }
    this.updateRetryState(submitStatus, submission);
    if (
      submission.clientIntent &&
      (submitStatus === 'succeeded' || submitStatus === 'blocked' || submitStatus === 'cancelled')
    ) {
      const sessionId =
        submission.sessionId ?? this.options.controller.snapshot().session?.sessionId;
      if (sessionId) {
        await this.options.controller.refreshSessionMetadata(sessionId).catch(() => undefined);
        this.options.planModeFlow?.acceptDirect(
          submission.clientIntent,
          sessionId,
          submission.submissionId,
        );
      }
    }
    this.options.planModeFlow?.rejectSubmission(submission.submissionId);
    if (
      submitStatus === 'succeeded' ||
      submitStatus === 'blocked' ||
      submitStatus === 'cancelled' ||
      submitStatus === 'ignored'
    ) {
      await this.completeSubmittedResources(submission);
    } else if (prepared.atomic) {
      this.restoreSubmission(submission);
    } else {
      this.options.composerDraft.restoreSubmission({
        attachments: submission.attachments,
      });
    }
    // Keeping the draft finishes this attempt after restoration, so recovery can drop its pending send.
    return !['failed', 'retracted', 'queue-required'].includes(submitStatus)
      ? 'consumed'
      : 'retained';
  }

  async restoreFailedSeed(input: string, seed: TuiSubmissionSeed): Promise<void> {
    await this.restoreSeed(seed, input);
  }

  private async restoreSeed(
    seed: TuiSubmissionSeed | undefined,
    content: string,
  ): Promise<TuiCommandSubmitDisposition> {
    if (!seed) {
      if (content.trim()) {
        this.options.editor.setText(content);
        this.options.surfaceHost.setChatFocus(this.options.editor);
      }
      return 'retained';
    }
    const submission = createTuiSubmissionSnapshot({
      submissionId: this.nextSubmissionId(),
      sessionId: seed.sessionId,
      editor: seed.editor,
      content: content.trim(),
      resources: seed.resources,
      ...(seed.transportContent ? { transportContent: seed.transportContent } : {}),
      ...(seed.transportAttachments ? { transportAttachments: seed.transportAttachments } : {}),
      clientIntent: seed.clientIntent,
      reviewRequest: seed.reviewRequest,
    });
    return this.restoreSubmission(submission);
  }

  restoreSubmission(submission: TuiSubmissionSnapshot): TuiCommandSubmitDisposition {
    const hasTransportOnlyAttachment = submission.transportAttachments?.some(
      (attachment) =>
        !attachment.filePath ||
        !submission.attachments.some((draft) => draft.filePath === attachment.filePath),
    );
    this.options.editor.restoreSubmittedDraft(submission.editor);
    this.options.composerDraft.restoreSubmission({ attachments: submission.attachments });
    if (
      submission.transportContent ||
      submission.clientIntent ||
      submission.reviewRequest ||
      hasTransportOnlyAttachment
    ) {
      this.restoreRecoverableSubmission(submission);
    }
    this.options.surfaceHost.setChatFocus(this.options.editor);
    this.options.onChanged();
    return 'retained';
  }

  private async completeSubmittedResources(submission: TuiSubmissionSnapshot): Promise<void> {
    if (this.restoredAbortSubmissionIds.delete(submission.submissionId)) return;
    await this.options.composerDraft.completeSubmission({ attachments: submission.attachments });
  }

  private async completeStoppedSubmission(seed: TuiSubmissionSeed): Promise<void> {
    await this.options.whenStopping?.();
    await this.options.composerDraft.completeSubmission(seed.resources);
  }

  private restoreSeedResources(seed: TuiSubmissionSeed | undefined): void {
    if (!seed) return;
    this.options.composerDraft.restoreSubmission(seed.resources);
  }

  private restoreCatalogSeedEditor(seed: TuiSubmissionSeed): void {
    this.options.editor.restoreSubmittedDraft(seed.editor);
    this.options.surfaceHost.setChatFocus(this.options.editor);
    this.options.onChanged();
  }

  private nextSubmissionId(): string {
    this.submissionCounter += 1;
    return `${String(Date.now())}-${String(this.submissionCounter)}`;
  }

  private canStageSubmission(
    command: string,
    seed: TuiSubmissionSeed | undefined,
    options: TuiCommandSubmitOptions,
    chat: ReturnType<TuiChatController['snapshot']>,
  ): boolean {
    return Boolean(
      seed &&
      (options.forceMessage || !isCatalogCommand(command, this.catalog)) &&
      (options.forceMessage || !isBareSlashCommand(command)) &&
      !this.options.interactionFlow.hasPending() &&
      !chat.cancelling &&
      !chat.retiringTurnId &&
      !this.options.runtimeStopping(),
    );
  }

  private async restorePreparedSubmission(
    seed: TuiSubmissionSeed | undefined,
    submission: TuiSubmissionSnapshot,
    input: string,
  ): Promise<TuiCommandSubmitDisposition> {
    return seed || submission.transportContent
      ? this.restoreSubmission(submission)
      : this.restoreSeed(undefined, input);
  }

  private shouldQueueSubmission(busyAction?: 'steer' | 'queue'): boolean {
    return Boolean(
      this.options.queueEnabled &&
      busyAction !== 'steer' &&
      (this.options.liveRunId() ||
        this.options.controller.hasInProcessRun?.() ||
        (this.options.runProjection.snapshot().queuedCount > 0 &&
          !this.options.runProjection.snapshot().queuePaused)),
    );
  }

  private isAgentBusyForShell(): boolean {
    const snapshot = this.options.controller.snapshot();
    return Boolean(
      this.preparingMessages > 0 ||
      this.options.controller.hasInProcessRun?.() ||
      snapshot.activeTurnId ||
      this.options.liveRunId() ||
      snapshot.cancelling ||
      snapshot.retiringTurnId ||
      this.options.runtimeStopping() ||
      this.options.interactionFlow.hasPending(),
    );
  }

  private async waitForReadiness(readiness: TuiCommandReadiness): Promise<void> {
    if (readiness === 'immediate') return;
    if (readiness === 'controller') {
      await (this.options.whenControllerReady?.() ?? this.options.whenReady());
      return;
    }
    await this.options.whenReady();
  }

  private async serializePreparation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.preparationTail;
    let release: () => void = () => undefined;
    this.preparationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private createHandlers(): Readonly<Record<string, TuiCommandHandler>> {
    return {
      help: async () => this.options.activeRunFlow.showHelp(),
      update: async () => this.options.updateFlow.show(),
      changelog: async () => this.options.featureFlow.showChangelog(),
      new: () => this.options.sessionFlow.startNew(),
      sessions: async ({ raw, args }) => {
        if (
          /^\/resume(?:\s|$)/iu.test(raw) &&
          args &&
          looksLikeSessionReference(args) &&
          (await this.options.sessionFlow.activateSessionReference(args, { silent: true }))
        ) {
          return;
        }
        await this.options.featureFlow.showSessionManager(args);
      },
      goal: async ({ args }) => {
        if (!this.options.goalFlow) {
          this.options.append('Goal support is unavailable in this host.', 'warning');
          return 'retained';
        }
        return this.options.goalFlow.execute(args);
      },
      plan: async ({ args }) => {
        const action = args.trim().toLocaleLowerCase();
        if (!this.options.planModeFlow) {
          this.options.append('Plan Mode is unavailable in this host.', 'warning');
          return;
        }
        if (action === 'view') {
          await this.options.interactionFlow.showLatestPlanReview();
          return;
        }
        if (action !== 'status' && this.options.interactionFlow.hasPending()) {
          this.options.setHint('Resolve the pending Agent interaction before changing Plan Mode.');
          this.options.interactionFlow.showPending();
          this.options.onChanged();
          return;
        }
        if (!action) this.options.planModeFlow.toggle();
        else if (action === 'on' || action === 'plan') this.options.planModeFlow.set('plan');
        else if (action === 'off' || action === 'default') this.options.planModeFlow.set('default');
        else if (action === 'status') this.options.planModeFlow.showStatus();
        else {
          this.options.append('Usage: /plan [on | off | status | view]', 'warning');
          return 'retained';
        }
      },
      review: async () => {
        const sessionId = this.options.controller.snapshot().session?.sessionId;
        return this.submit(
          '/review',
          {
            ...(sessionId ? { sessionId } : {}),
            editor: {
              schemaVersion: 1,
              text: '/review',
              cursor: '/review'.length,
              pastes: [],
              pasteCounter: 0,
            },
            resources: { attachments: [] },
          },
          {
            forceMessage: true,
            transportContent: TUI_REVIEW_PROMPT,
            reviewRequest: { scope: 'local_changes' },
          },
        );
      },
      parent: async () => this.options.sessionFlow.activateParentSession(),
      btw: async (invocation) => {
        const side = await this.options.sessionFlow.startSideSession({
          workspaceDir: this.options.workspaceDir,
        });
        // Keep the typed command in the Composer so a rejected or failed
        // attempt stays retryable instead of losing the question.
        if (!side) return 'retained';
        const question = invocation.args.trim();
        if (question) return this.submit(question);
      },
      history: () => {
        if (this.options.interactionFlow.hasPending()) {
          this.options.setHint(sessionMutationText('sessionMutation.error.pendingInteraction'));
          this.options.interactionFlow.showPending();
          this.options.onChanged();
          return 'retained';
        }
        const current = this.options.controller.snapshot().session;
        if (this.options.planModeFlow?.snapshot().displayMode === 'plan') {
          this.options.setHint(sessionMutationText('sessionMutation.error.exitPlan'));
          this.options.onChanged();
          return 'retained';
        }
        if (current?.sessionKind === 'task' || current?.visibility === 'hidden') {
          this.options.setHint(sessionMutationText('sessionMutation.error.openParent'));
          this.options.onChanged();
          return 'retained';
        }
        this.options.sessionMutationFlow.startHistory();
      },
      fork: () => {
        this.options.sessionMutationFlow.startFork();
      },
      rewind: () => {
        if (this.options.interactionFlow.hasPending()) {
          this.options.setHint(sessionMutationText('sessionMutation.error.pendingInteraction'));
          this.options.interactionFlow.showPending();
          this.options.onChanged();
          return 'retained';
        }
        const current = this.options.controller.snapshot().session;
        if (this.options.planModeFlow?.snapshot().displayMode === 'plan') {
          this.options.setHint(sessionMutationText('sessionMutation.error.exitPlan'));
          this.options.onChanged();
          return 'retained';
        }
        if (current?.sessionKind === 'task' || current?.visibility === 'hidden') {
          this.options.setHint(sessionMutationText('sessionMutation.error.openParent'));
          this.options.onChanged();
          return 'retained';
        }
        this.options.sessionMutationFlow.startRewind();
      },
      edit: () => {
        if (this.options.interactionFlow.hasPending()) {
          this.options.setHint(sessionMutationText('sessionMutation.error.pendingInteraction'));
          this.options.interactionFlow.showPending();
          this.options.onChanged();
          return 'retained';
        }
        const current = this.options.controller.snapshot().session;
        if (this.options.planModeFlow?.snapshot().displayMode === 'plan') {
          this.options.setHint(sessionMutationText('sessionMutation.error.editExitPlan'));
          this.options.onChanged();
          return 'retained';
        }
        if (current?.sessionKind === 'task' || current?.visibility === 'hidden') {
          this.options.setHint(sessionMutationText('sessionMutation.error.editOpenParent'));
          this.options.onChanged();
          return 'retained';
        }
        this.options.sessionMutationFlow.startEdit();
      },
      retry: async () => this.retryLastFailedMessage(),
      rename: async ({ args }) => {
        if (!args) {
          const sessionId = this.options.controller.snapshot().session?.sessionId;
          if (!sessionId) {
            this.options.setHint('Start or resume a Session before renaming it.');
            this.options.onChanged();
            return 'consumed';
          }
          await this.options.featureFlow.showSessionManager('', {
            initialRenameSessionId: sessionId,
          });
          return 'consumed';
        }
        const renamed = await this.options.controller.renameCurrentSession(args);
        const title = renamed.title?.trim() || args.trim();
        this.options.setHint(`Session renamed to “${title}”.`);
        this.options.onChanged();
      },
      archive: async () => {
        if (this.hasLiveRun()) {
          this.options.append('Stop the running turn before archiving this Session.', 'warning');
          return 'retained';
        }
        const sessionId = this.options.controller.snapshot().session?.sessionId;
        if (!sessionId) throw new Error('No active session.');
        await this.options.controller.archiveCurrentSession();
        await this.options.sessionFlow.archiveCurrentProjection(sessionId);
      },
      compact: async ({ args }) =>
        this.runLoginProtectedAction(() =>
          this.options.featureFlow.compactSession(args, this.hasLiveRun()),
        ),
      status: () => this.options.featureFlow.showAccountStatus(),
      tasks: async () => {
        if (!this.options.showTasks) {
          this.options.setHint('Background task view is unavailable in this host.');
          this.options.onChanged();
          return;
        }
        await this.options.showTasks();
      },
      permission: async ({ args }) => {
        if (!this.options.permissionModeFlow) {
          this.options.append('Permission mode is unavailable in this host.', 'warning');
          return;
        }
        const action = args.trim().toLocaleLowerCase();
        if (!action) {
          this.showPermissionModePicker();
          return;
        }
        if (action === 'status') {
          this.options.permissionModeFlow.showStatus();
          return;
        }
        const modes = {
          ask: 'default',
          auto: 'auto',
          full: 'bypassPermissions',
        } as const;
        const mode = modes[action as keyof typeof modes];
        if (!mode) {
          this.options.append('Usage: /permission [status | ask | auto | full]', 'warning');
          return 'retained';
        }
        await this.options.permissionModeFlow.set(mode);
      },
      login: () => {
        this.pendingLoginContinuation = undefined;
        this.showLoginRegionPicker();
      },
      logout: () => this.runAuthCommand('logout'),
      doctor: async () => this.options.featureFlow.showConfigurationInspection(false),
      context: async () => this.options.activeRunFlow.showContext(),
      steer: async ({ raw }) => {
        if (this.options.interactionFlow.hasPending()) {
          this.options.setHint('Resolve the pending Agent interaction before steering.');
          this.options.interactionFlow.showPending();
          this.options.onChanged();
          return 'retained';
        }
        try {
          return (await this.options.activeRunFlow.handle(raw)) ? 'consumed' : 'retained';
        } catch (error) {
          this.appendProtectedActionError(error);
          return 'retained';
        }
      },
      feedback: async ({ args }) => this.options.feedbackFlow.show(args),
      checkin: async () => this.runDailyCheckinCommand(),
      settings: () => this.showSettingsPicker(),
      statusline: () => this.options.showStatusLine?.(),
      theme: () => this.options.showTheme?.(),
      hotkeys: () => this.showHotkeysPicker(),
      reload: async () => {
        if (!this.options.reloadTui) {
          this.options.append('TUI reload is unavailable in this host.', 'warning');
          return 'retained';
        }
        if (this.options.interactionFlow.hasPending()) {
          this.options.setHint('Resolve the pending Agent interaction before reloading TUI.');
          this.options.interactionFlow.showPending();
          this.options.onChanged();
          return 'retained';
        }
        if (this.options.runProjection.snapshot().queuedCount > 0) {
          this.options.setHint('Clear the Queue before reloading TUI.');
          this.options.onChanged();
          return 'retained';
        }
        this.options.setHint('Reloading TUI configuration…');
        this.options.onChanged();
        try {
          await this.options.reloadTui();
          this.options.setHint('TUI configuration reloaded.');
        } catch (error) {
          this.options.append(
            formatTuiActionFailure(error, {
              summary: "Couldn't reload TUI configuration.",
              nextStep: 'Resolve the reported configuration or plugin refresh error, then retry /reload.',
            }),
            'warning',
          );
        }
        this.options.onChanged();
      },
      model: async ({ args }) => this.options.featureFlow.showModelPicker(args),
      provider: async () => this.options.featureFlow.showProviderManager(),
      plugins: async ({ args }) => this.options.featureFlow.showPlugins(args),
      skills: async ({ args }) => this.options.featureFlow.showSkills(args),
      mcp: async ({ args }) => this.options.featureFlow.showMcpServers(args),
      'add-dir': async ({ args }) => {
        try {
          const before = this.options.workspaceRoots.list().length;
          const root = await this.options.workspaceRoots.add(args);
          const added = this.options.workspaceRoots.list().length > before;
          this.options.append(
            added
              ? `Added workspace directory: ${root.path}\nIt is available to @ path completion and future Runs in this CLI process.`
              : `Workspace directory is already available: ${root.path}`,
          );
          this.options.activeRunFlow.refreshAutocomplete();
        } catch (error) {
          this.options.append(
            formatTuiActionFailure(error, {
              summary: "Couldn't add that workspace folder.",
              nextStep: 'Check the path and permissions, then retry.',
            }),
            'warning',
          );
        }
      },
      decision: () => {
        if (this.options.interactionFlow.hasPending()) {
          this.options.interactionFlow.showPending();
        } else {
          this.options.append('No pending Agent interaction.');
        }
      },
      permissions: async () => this.options.featureFlow.showPermissions(),
      usage: async () => this.options.featureFlow.showSessionUsage(),
      export: async ({ args }) => this.options.featureFlow.exportCurrentTranscript(args),
      transcript: () => this.options.featureFlow.showTranscript(),
      copy: async () => this.options.featureFlow.copyLastAssistantReply(),
      stop: async () => {
        const hadLiveTurn = this.hasLiveRun();
        await this.options.abortLiveTurn();
        if (!hadLiveTurn) this.options.append('No turn is currently running.');
      },
      queue: async () => {
        if (this.options.interactionFlow.hasPending()) {
          this.options.setHint('Resolve the pending Agent interaction before managing the Queue.');
          this.options.interactionFlow.showPending();
          this.options.onChanged();
          return;
        }
        this.options.queueFlow.openManager();
      },
      quit: async () => this.options.leaveUi(),
    };
  }

  private commandContext() {
    const snapshot = this.options.controller.snapshot();
    const session = snapshot.session;
    return {
      hasSession: Boolean(session),
      hasParentSession: Boolean(session?.parentSessionId),
      managedTokenPresent: snapshot.account?.managedTokenPresent === true,
      queueEnabled: this.options.queueEnabled,
      hasLiveRun: this.hasLiveRun(),
      hasPendingInteraction: this.options.interactionFlow.hasPending(),
      queuedCount: this.options.runProjection.snapshot().queuedCount,
      canRetry: this.isSessionRetryable(session) && !this.options.isLlmRetrying?.(),
      sideMode: this.options.sessionFlow.isSideModeActive?.() === true,
    };
  }

  private hasLiveRun(): boolean {
    return Boolean(this.options.liveRunId() || this.options.controller.hasInProcessRun?.());
  }

  private async retryLastFailedMessage(): Promise<TuiCommandSubmitDisposition> {
    if (this.options.isLlmRetrying?.()) {
      this.options.setHint('The model request is already retrying.');
      this.options.onChanged();
      return 'consumed';
    }
    const goalRetry = await this.options.goalFlow?.resumeBlocked();
    if (goalRetry && goalRetry !== 'not-blocked') {
      if (goalRetry === 'resumed') {
        const sessionId = this.options.controller.snapshot().session?.sessionId;
        if (sessionId) this.clearSessionRetry(sessionId);
        this.options.onChanged();
      }
      return 'consumed';
    }

    const sessionId = this.options.controller.snapshot().session?.sessionId;
    const session = this.options.controller.snapshot().session;
    if (!sessionId || !this.isSessionRetryable(session)) {
      this.options.append('There is no failed response to retry in this Session.', 'warning');
      return 'consumed';
    }

    const failed = this.failedSubmissions.get(sessionId);
    this.clearSessionRetry(sessionId);
    if (failed) {
      const resources = { attachments: failed.attachments };
      this.options.composerDraft.reserveSubmission(resources);
      await this.submit(
        failed.content,
        {
          sessionId,
          editor: failed.editor,
          resources,
          ...(failed.transportContent ? { transportContent: failed.transportContent } : {}),
          ...(failed.transportAttachments?.length
            ? { transportAttachments: failed.transportAttachments }
            : {}),
          ...(failed.clientIntent ? { clientIntent: failed.clientIntent } : {}),
        },
        failed.transportContent ? { transportContent: failed.transportContent } : {},
      );
      return 'consumed';
    }

    try {
      const status = await this.options.controller.submit('', {
        clientIntent: 'retry-continuation',
        beforeTurnAdmission: (activeSessionId) =>
          this.options.featureFlow.applyPendingModelSelection(activeSessionId),
        onRuntimeAccepted: (activeSessionId) => {
          void this.options.controller
            .refreshSessionMetadata(activeSessionId)
            .catch(() => undefined);
        },
      });
      if (status === 'failed') this.setSessionRetryable(sessionId, true);
    } catch (error) {
      this.setSessionRetryable(sessionId, true);
      this.appendProtectedActionError(error);
    }
    return 'consumed';
  }

  private updateRetryState(
    submitStatus: Awaited<ReturnType<TuiChatController['submit']>>,
    submission: TuiSubmissionSnapshot,
  ): void {
    const sessionId = this.options.controller.snapshot().session?.sessionId ?? submission.sessionId;
    if (!sessionId) return;
    if (submitStatus === 'failed') {
      const snapshot = this.options.controller.snapshot();
      const retryable =
        snapshot.errorRetryable ?? resolveTuiRuntimeFailure(snapshot.error).retryable;
      if (retryable) {
        this.sessionRetryability.set(sessionId, true);
        this.failedSubmissions.set(sessionId, { ...submission, sessionId });
      } else {
        this.clearSessionRetry(sessionId);
      }
      this.options.onChanged();
      return;
    }
    if (
      submitStatus === 'succeeded' ||
      submitStatus === 'blocked' ||
      submitStatus === 'cancelled' ||
      submitStatus === 'ignored'
    ) {
      this.clearSessionRetry(sessionId);
      this.options.onChanged();
    }
  }

  private clearSessionRetry(sessionId: string): void {
    this.sessionRetryability.set(sessionId, false);
    this.failedSubmissions.delete(sessionId);
  }

  private isSessionRetryable(session: TuiSession | undefined): boolean {
    if (!session) return false;
    const observed = this.sessionRetryability.get(session.sessionId);
    if (observed !== undefined) return observed;
    if (session.status !== 'error') return false;
    return resolveTuiRuntimeFailure(session.errorMessage, session.errorCode, {
      errorSource: session.errorSource,
      errorDetail: session.errorDetail,
      errorProviderId: session.errorProviderId,
    }).retryable;
  }

  /**
   * Entry point for surfaces outside the command catalog — currently the
   * `/provider` OAuth row — so sign-in always runs the same region picker and
   * auth command as `/login`.
   */
  startMiniMaxLogin(): void {
    this.pendingLoginContinuation = undefined;
    this.showLoginRegionPicker();
  }

  private showLoginRegionPicker(): void {
    if (!this.options.auth) {
      this.pendingLoginContinuation = undefined;
      this.options.append('MiniMax authentication is unavailable in this host.', 'warning');
      return;
    }
    if (this.loginRegionPicker) this.options.surface.close(this.loginRegionPicker);
    const picker = new TuiLoginRegionPicker(
      (region) => {
        if (this.loginRegionPicker !== picker) return;
        this.options.surface.close(picker);
        this.loginRegionPicker = undefined;
        void this.runAuthCommand('login', region);
      },
      () => {
        this.options.surface.close(picker);
        if (this.loginRegionPicker === picker) this.loginRegionPicker = undefined;
        this.pendingLoginContinuation = undefined;
      },
    );
    this.loginRegionPicker = picker;
    this.options.surface.show(picker);
  }

  private async runDailyCheckinCommand(): Promise<void> {
    try {
      if (await this.options.featureFlow.hasManagedAccountLogin()) {
        await this.options.featureFlow.runDailyCheckin();
        return;
      }
    } catch {
      this.options.append(
        "Couldn't verify MiniMax sign-in. Check the connection, then retry /checkin.",
        'warning',
      );
      return;
    }
    this.pendingLoginContinuation = 'checkin';
    this.showLoginRegionPicker();
  }

  private showPermissionModePicker(): void {
    const flow = this.options.permissionModeFlow;
    if (!flow) {
      this.options.append('Permission mode is unavailable in this host.', 'warning');
      return;
    }
    const currentMode = flow.snapshot().mode;
    if (!currentMode) {
      flow.showStatus();
      return;
    }
    if (this.permissionModePicker) {
      this.options.surface.close(this.permissionModePicker);
      this.permissionModePicker = undefined;
    }
    const picker = new TuiPermissionModePicker(
      currentMode,
      (mode) => {
        if (this.permissionModePicker !== picker) return;
        this.options.surface.close(picker);
        this.permissionModePicker = undefined;
        void flow.set(mode);
      },
      () => {
        this.options.surface.close(picker);
        if (this.permissionModePicker === picker) this.permissionModePicker = undefined;
      },
      this.options.onChanged,
    );
    this.permissionModePicker = picker;
    this.options.surface.show(picker);
  }

  private showSettingsPicker(): void {
    if (this.settingsPicker) {
      this.options.surface.close(this.settingsPicker);
      this.settingsPicker = undefined;
    }
    const picker = new TuiSettingsPicker(
      this.options.surfaceHost.getChatMode(),
      (mode) => {
        if (this.settingsPicker !== picker) return false;
        const previousMode = this.options.surfaceHost.getChatMode();
        if (!this.options.surfaceHost.setChatMode(mode)) {
          this.options.setHint('Close active overlays before changing TUI mode.');
          this.options.onChanged();
          return false;
        }
        try {
          this.options.persistTuiMode?.(mode);
        } catch (error) {
          this.options.surfaceHost.setChatMode(previousMode);
          this.options.append(
            formatTuiActionFailure(error, {
              summary: "Couldn't save the TUI mode.",
              nextStep: 'Check the MCode data directory permissions, then retry /settings.',
              preservation: `The TUI remains in ${previousMode} mode.`,
            }),
            'warning',
          );
          this.options.onChanged();
          return false;
        }
        this.options.setHint(`TUI mode: ${mode}`);
        this.options.onChanged();
        return true;
      },
      () => {
        this.options.surface.close(picker);
        if (this.settingsPicker === picker) this.settingsPicker = undefined;
      },
    );
    this.settingsPicker = picker;
    this.options.surface.show(picker);
  }

  private showHotkeysPicker(): void {
    if (
      !this.options.keybindings ||
      !this.options.getTuiKeybindingOverrides ||
      !this.options.saveTuiKeybindingOverrides
    ) {
      this.options.append('TUI keyboard customization is unavailable in this host.', 'warning');
      return;
    }
    if (this.hotkeysPicker) {
      this.options.surface.close(this.hotkeysPicker);
      this.hotkeysPicker = undefined;
    }
    const picker = new TuiHotkeysPicker({
      registry: this.options.keybindings,
      getUserOverrides: this.options.getTuiKeybindingOverrides,
      saveUserOverrides: async (overrides) => {
        if (this.hasLiveRun() || this.options.interactionFlow.hasPending()) {
          throw new Error('Stop the active Turn and resolve pending interactions before saving.');
        }
        await this.options.saveTuiKeybindingOverrides?.(overrides);
      },
      onClose: () => {
        this.options.surface.close(picker);
        if (this.hotkeysPicker === picker) this.hotkeysPicker = undefined;
      },
      requestRender: this.options.onChanged,
    });
    this.hotkeysPicker = picker;
    this.options.surface.show(picker);
  }

  private async runAuthCommand(operation: 'login' | 'logout', region?: MavisRegion): Promise<void> {
    if (!this.options.auth) {
      this.options.append('MiniMax authentication is unavailable in this host.', 'warning');
      return;
    }
    this.options.setHint(operation === 'login' ? 'Starting MiniMax sign-in…' : 'Signing out…');
    this.options.onChanged();
    try {
      const result =
        operation === 'login'
          ? await this.options.auth.login((progress) => {
              const authorizationUrl = markTuiAuthorizationUrl(
                progress.verificationUriComplete ?? progress.verificationUri,
              );
              this.options.append(
                `Complete MiniMax login in your browser:\n` +
                  `${authorizationUrl}\n` +
                  `Code: ${progress.userCode}`,
              );
              this.options.setHint('Waiting for authorization…');
              this.options.onChanged();
              void this.openExternalTarget(authorizationUrl).catch(() => {
                this.options.append(
                  "Couldn't open the default browser. Open the authorization URL above manually.",
                  'warning',
                );
                this.options.onChanged();
              });
            }, region)
          : await this.options.auth.logout();
      this.options.append(result.message);
      if (operation === 'login') {
        if (result.restartRequired) {
          const initialPrompt =
            this.pendingLoginContinuation === 'checkin' ? '/checkin' : undefined;
          this.pendingLoginContinuation = undefined;
          if (initialPrompt) this.options.requestRestart?.(region, initialPrompt);
          else this.options.requestRestart?.(region);
          await this.options.leaveUi();
          return;
        }
        if (result.state === 'authenticated' || result.state === 'already-authenticated') {
          await this.notifyAuthContextChanged('authenticated');
        }
        try {
          await this.options.controller.requireLoginForAgentAction();
        } catch (error) {
          if (!(error instanceof TuiLoginRequiredError)) throw error;
          this.options.controller.refreshAccountStatusNow();
        }
        if (this.pendingLoginContinuation === 'checkin') {
          this.pendingLoginContinuation = undefined;
          await this.options.featureFlow.runDailyCheckin();
        }
      } else {
        if (result.logoutUrl) void this.openLogoutPage(result.logoutUrl);
        if (result.state === 'signed-out' || result.state === 'already-signed-out') {
          await this.notifyAuthContextChanged('logged_out');
        }
        this.options.controller.refreshAccountStatusNow();
      }
    } catch (error) {
      if (operation === 'login') this.pendingLoginContinuation = undefined;
      this.options.append(
        formatTuiActionFailure(error, {
          summary: operation === 'login' ? "Sign-in wasn't completed." : "Couldn't sign out.",
          nextStep:
            operation === 'login'
              ? 'Resolve the reported connection or service error before retrying sign-in.'
              : 'Check the connection, then retry /logout.',
        }),
        'error',
      );
    } finally {
      this.options.setHint(undefined);
      this.options.onChanged();
    }
  }

  private async openLogoutPage(logoutUrl: string): Promise<void> {
    this.options.append(`Finish signing out in your browser:\n${logoutUrl}`);
    this.options.onChanged();
    try {
      await this.openExternalTarget(logoutUrl);
    } catch {
      this.options.append(
        "Couldn't open the default browser. Open the sign-out URL above manually.",
        'warning',
      );
      this.options.onChanged();
    }
  }

  private async notifyAuthContextChanged(authState: 'authenticated' | 'logged_out'): Promise<void> {
    try {
      await this.options.notifyAuthContextChanged?.(authState);
    } catch {
      // Authentication already succeeded; Hook cleanup is best-effort and invisible to users.
    }
  }

  private async runLoginProtectedAction<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      await this.options.controller.requireLoginForAgentAction();
      return await action();
    } catch (error) {
      this.appendProtectedActionError(error);
      return undefined;
    }
  }

  private appendProtectedActionError(error: unknown, message?: string): void {
    this.options.append(
      error instanceof TuiLoginRequiredError
        ? error.message
        : (message ??
            formatTuiActionFailure(error, {
              summary: "Couldn't complete this action.",
              nextStep: 'Retry.',
            })),
      error instanceof TuiLoginRequiredError ? 'warning' : 'error',
    );
  }
}

function captureEditorDraft(editor: Editor, content: string) {
  return (
    editor.captureDraft?.() ?? {
      schemaVersion: 1 as const,
      text: content,
      cursor: content.length,
      pastes: [],
      pasteCounter: 0,
    }
  );
}

function toRecoveredEditTransportAttachments(
  attachments: readonly TuiEditMessageAttachment[],
): TuiTransportAttachment[] {
  return attachments.flatMap<TuiTransportAttachment>((attachment) => {
    const metadata = {
      type: attachment.type,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
    };
    if (attachment.filePath) {
      return [{ ...metadata, filePath: attachment.filePath, assetId: attachment.assetId }];
    }
    if (attachment.assetId) return [{ ...metadata, assetId: attachment.assetId }];
    return [];
  });
}

function reconcileRecoveredTransportAttachments(
  submission: TuiSubmissionSnapshot,
  currentAttachments: readonly TuiAttachment[],
): TuiTransportAttachment[] {
  const originalLocalPaths = new Set(submission.attachments.map((item) => item.filePath));
  const currentPaths = new Set(currentAttachments.map((item) => item.filePath));
  const retained = (submission.transportAttachments ?? []).filter(
    (item) => !item.filePath || !originalLocalPaths.has(item.filePath) || currentPaths.has(item.filePath),
  );
  const retainedPaths = new Set(retained.flatMap((item) => item.filePath ? [item.filePath] : []));
  return [
    ...retained,
    ...currentAttachments.filter((item) => !retainedPaths.has(item.filePath)),
  ];
}

function prepareSubmissionFailureMessage(error: unknown): string {
  if (error instanceof TuiLoginRequiredError) return error.message;
  return formatTuiActionFailure(error, {
    summary: "Couldn't prepare this message.",
    nextStep: 'Remove unavailable attachments, then retry.',
    preservation: 'Your draft is preserved.',
  });
}

function submitFailureMessage(error: unknown): string {
  if (error instanceof TuiLoginRequiredError) return error.message;
  if (error instanceof TuiFailure && error.category === 'config') {
    return "Couldn't send this message with the current configuration. Run /doctor, then retry. Your draft is preserved.";
  }
  return formatTuiActionFailure(error, {
    summary: "Couldn't send this message.",
    nextStep: 'Retry.',
    preservation: 'Your draft is preserved.',
  });
}

function queueSubmissionFailureMessage(error: unknown): string {
  return formatTuiActionFailure(error, {
    summary: "Couldn't add this message to the Queue.",
    nextStep: 'Retry after the current response finishes.',
    preservation: 'Your draft is preserved.',
  });
}

function seedHasResources(seed: TuiSubmissionSeed | undefined): boolean {
  return Boolean(seed && seed.resources.attachments.length > 0);
}

function isCatalogCommand(command: string, catalog: TuiCommandCatalog): boolean {
  return matchTuiCommandInput(command, catalog.inputCommands) !== undefined;
}

function looksLikeSessionReference(value: string): boolean {
  const normalized = value.trim();
  return /^\d+$/u.test(normalized) || /^(?:mvs_|ses_|session[-_:]|[0-9a-f]{8}-)/iu.test(normalized);
}

function isBareSlashCommand(input: string): boolean {
  const command = input.trim();
  return Boolean(
    command && !/\s/u.test(command) && command.startsWith('/') && !command.slice(1).includes('/'),
  );
}

function isAvailableWhileStopping(input: string, catalog: TuiCommandCatalog): boolean {
  const command = catalog.resolve(input)?.name;
  return command === 'help' || command === 'quit' || command === 'stop';
}
