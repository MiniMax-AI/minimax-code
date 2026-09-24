import type { TuiModel } from '../../../runtime/port.js';
import type { TuiLlmRetryEvent } from '../../../types/runtime-events.js';
import type { TuiChatSnapshot } from '../chat-controller.js';
import type { TuiPermissionModeSnapshot } from '../interaction/permission-mode-flow.js';
import {
  isSideParentRunning,
  resolveSideParentStatus,
  type TuiSideConversationPresentation,
} from '../../commands/side-session.js';
import type { TuiSideConversationSnapshot } from '../session-flow.js';
import {
  resolveTuiVisiblePresentation,
  type TuiVisiblePresentation,
} from '../projection/visible-presentation.js';
import type { TuiState } from '../../state/index.js';
import type { TuiRunProjectionSnapshot } from '../../state/run-projection.js';
import type { TranscriptActivitySource } from '../../transcript/store.js';
import type { TuiPlanModeSnapshot } from '../interaction/plan-mode-flow.js';
import type { TuiAgentInteractionReadback } from '../interaction/interaction-flow.js';
import { TuiAutomationStatusStore } from '../../automation/status-store.js';
import type { TuiTip } from '../../shell/tips.js';
import type { TuiKeybindingRegistry } from '../../shell/keybindings.js';
import type { TuiComposerState } from '../../shell/composer.js';
import {
  isTuiCommandDiscoverable,
  MINIMAX_CODE_COMMANDS,
  type TuiCommand,
} from '../../commands/catalog.js';
import { resolveTuiComposerInputIntent } from '../../commands/input-intent.js';
import { formatTuiTerminalTitle } from '../../platform/terminal-title.js';

type PresentationSink<K extends keyof TuiVisiblePresentation> = {
  setState(state: TuiVisiblePresentation[K]): void;
};

export class TuiChromeFlow {
  private transientHint?: string;
  private transientHintTone?: TuiComposerState['hintTone'];
  private welcomeTip?: TuiTip;
  private startupHint?: string;
  private compacting = false;
  private llmRetry?: TuiLlmRetryEvent;
  private readonly automationStatus = new TuiAutomationStatusStore();

  constructor(
    private readonly options: {
      readonly version: string;
      readonly workspace: string;
      readonly homeDir?: string;
      readonly queueEnabled: boolean;
      readonly keybindings?: TuiKeybindingRegistry;
      readonly isStarted: () => boolean;
      readonly isStopped: () => boolean;
      readonly setTerminalTitle: (title: string | undefined) => void;
      readonly terminalTitle?: readonly string[] | null;
      readonly connection: () => Pick<TuiState['connection'], 'phase' | 'generation' | 'lastError'>;
      /** Multi-Session state kernel, including the background parent Turn. */
      readonly liveRunId: (snapshot: TuiChatSnapshot) => string | undefined;
      readonly runProjection: () => TuiRunProjectionSnapshot;
      readonly transcript: TranscriptActivitySource;
      readonly shouldResumeDraftAfterLogin: () => boolean;
      readonly activePermission: () => boolean;
      readonly activeQuestionnaire: () => boolean;
      readonly agentInteraction: () => TuiAgentInteractionReadback | undefined;
      readonly agentCounts?: () => { readonly active: number; readonly total: number };
      readonly attachmentCount: () => number;
      readonly expandedDraft: () => string;
      readonly inputCommands?: () => readonly TuiCommand[];
      readonly selectedModel: () => TuiModel | undefined;
      readonly selectedEffort?: () => string | undefined;
      readonly permissionMode: () => TuiPermissionModeSnapshot | undefined;
      readonly planMode?: () => TuiPlanModeSnapshot;
      /** Paired BTW side conversation, when one exists. */
      readonly sideConversation?: () => TuiSideConversationSnapshot | undefined;
      /** Multi-Session state kernel, including the background parent Turn. */
      readonly sessionState?: () => Pick<TuiState, 'sessions'>;
      readonly welcome: PresentationSink<'shell'>;
      readonly status: PresentationSink<'shell'>;
      readonly activity: PresentationSink<'activity'>;
      readonly composer: PresentationSink<'composer'>;
    },
  ) {}

  setHint(message: string | undefined, tone?: TuiComposerState['hintTone']): void {
    this.transientHint = message;
    this.transientHintTone = message ? tone : undefined;
  }

  setWelcomeTip(tip: TuiTip | undefined): void {
    this.welcomeTip = tip;
  }

  setStartupHint(message: string | undefined): void {
    this.startupHint = message;
  }

  setCompacting(active: boolean): void {
    this.compacting = active;
  }

  setLlmRetry(event: TuiLlmRetryEvent | undefined): void {
    this.llmRetry = event;
  }

  isLlmRetrying(): boolean {
    return this.llmRetry?.status === 'waiting';
  }

  /**
   * Latch recording that the mirrored parent Session was observed with a live
   * Turn at least once since the current side conversation opened. Poll-based
   * reconciliation cannot see Codex's TurnStarted/TurnCompleted transitions,
   * so this is what separates "main finished" from "main was idle all along".
   */
  private sideParentRunningLatch: { sideSessionId: string; seenRunning: boolean } | undefined;

  private resolveSideConversationPresentation(
    snapshot: TuiChatSnapshot,
  ): TuiSideConversationPresentation | undefined {
    const side = this.options.sideConversation?.();
    if (!side) {
      this.sideParentRunningLatch = undefined;
      return undefined;
    }
    if (this.sideParentRunningLatch?.sideSessionId !== side.sideSessionId) {
      this.sideParentRunningLatch = { sideSessionId: side.sideSessionId, seenRunning: false };
    }
    const parentView = this.options.sessionState?.().sessions.get(side.parentSessionId);
    if (isSideParentRunning(parentView)) this.sideParentRunningLatch.seenRunning = true;
    const parentSession =
      snapshot.session?.sessionId === side.parentSessionId
        ? snapshot.session
        : snapshot.sessions?.find((session) => session.sessionId === side.parentSessionId);
    const parentStatus = resolveSideParentStatus({
      parentSession,
      parentView,
      seenParentRunning: this.sideParentRunningLatch.seenRunning,
    });
    return { view: side.activeView, ...(parentStatus ? { parentStatus } : {}) };
  }

  update(snapshot: TuiChatSnapshot): void {
    if (this.options.isStopped()) return;
    const sessionId = snapshot.session?.sessionId;
    if (this.llmRetry && this.llmRetry.sessionId !== sessionId) this.llmRetry = undefined;
    if (
      !snapshot.cancelling &&
      !snapshot.retiringTurnId &&
      !this.options.liveRunId(snapshot) &&
      (this.transientHint === 'Stopping the current response. Your draft is preserved.' ||
        this.transientHint === 'Runtime is still stopping; your draft is preserved.')
    ) {
      this.setHint(undefined);
    }
    const currentLiveRunId = this.options.liveRunId(snapshot);
    const runtimeProjection = this.options.runProjection();
    const connection = this.options.connection();
    const agentInteraction = this.options.agentInteraction();
    const runtimeQueuedCount = this.options.queueEnabled ? runtimeProjection.queuedCount : 0;
    const expandedDraft = this.options.expandedDraft();
    const surface =
      snapshot.session ||
      currentLiveRunId ||
      this.options.transcript.length > 0 ||
      this.options.shouldResumeDraftAfterLogin()
        ? 'conversation'
        : 'welcome';
    const presentation = resolveTuiVisiblePresentation({
      snapshot,
      connection,
      surface,
      currentLiveRunId,
      runtimeStoppingRunId: runtimeProjection.stoppingRuntimeTurnId,
      llmRetry: this.llmRetry,
      transcript: this.options.transcript,
      runtimeQueuedCount,
      queueEnabled: this.options.queueEnabled,
      keybindings: this.options.keybindings,
      activePermission: this.options.activePermission(),
      activeQuestionnaire: this.options.activeQuestionnaire(),
      compacting: this.compacting,
      transientHint: this.transientHint,
      transientHintTone: this.transientHintTone,
      attachmentCount: this.options.attachmentCount(),
      draftCharacterCount: expandedDraft.length,
      draftLineCount: expandedDraft ? expandedDraft.split('\n').length : 0,
      goalDraft: /^\/goal(?:\s|$)/iu.test(expandedDraft.trimStart()),
      version: this.options.version,
      workspace: this.options.workspace,
      homeDir: this.options.homeDir,
      selectedModel: this.options.selectedModel(),
      selectedEffort: this.options.selectedEffort?.(),
      permissionMode: this.options.permissionMode(),
      planMode: this.options.planMode?.() ?? {
        displayMode: snapshot.session?.interactionMode === 'plan' ? 'plan' : 'default',
      },
      ...(() => {
        const sideConversation = this.resolveSideConversationPresentation(snapshot);
        return sideConversation ? { sideConversation } : {};
      })(),
    });
    const agentCounts = this.options.agentCounts?.();
    const automationStatus = this.automationStatus.reconcile({
      snapshot,
      connection,
      currentLiveRunId,
      runtimeStoppingRunId: runtimeProjection.stoppingRuntimeTurnId,
      runtimeQueuedCount,
      runtimeQueueHandoffPending: runtimeProjection.queueHandoffPending,
      interaction: agentInteraction,
      compacting: this.compacting,
      retrying: this.isLlmRetrying(),
      ...(agentCounts ? { agentCounts } : {}),
    });
    if (this.options.isStarted()) {
      this.options.setTerminalTitle(
        formatTuiTerminalTitle(
          {
            title: snapshot.session?.title,
            sessionId: snapshot.session?.sessionId,
            workspace: this.options.workspace,
            status: automationStatus.status,
          },
          this.options.terminalTitle,
        ),
      );
    }
    const shell = {
      ...presentation.shell,
      agentSeq: automationStatus.seq,
      agentStatus: automationStatus.status,
      ...(automationStatus.sessionId ? { agentSessionId: automationStatus.sessionId } : {}),
      ...(automationStatus.turnId ? { agentRunId: automationStatus.turnId } : {}),
      ...(automationStatus.requestId ? { agentRequestId: automationStatus.requestId } : {}),
      agentActiveCount: automationStatus.activeAgents,
      agentTotalCount: automationStatus.totalAgents,
    };
    // The welcome header remains visible above the conversation transcript.
    this.options.welcome.setState(shell);
    this.options.status.setState(shell);
    this.options.activity.setState(this.startupHint ? { phase: 'idle' } : presentation.activity);
    const baseComposer = {
      ...presentation.composer,
      inputIntent: resolveTuiComposerInputIntent(
        expandedDraft,
        this.options.inputCommands?.() ?? MINIMAX_CODE_COMMANDS.filter(isTuiCommandDiscoverable),
      ),
    };
    const composer =
      surface === 'welcome' && this.welcomeTip
        ? { ...baseComposer, contextualTip: this.welcomeTip }
        : baseComposer;
    this.options.composer.setState(
      this.startupHint ? { ...composer, hint: this.startupHint, headerHidden: false } : composer,
    );
  }
}
