import type { TuiChatSnapshot } from '../chat-controller.js';
import type { TuiActivityControl, TuiActivityLineState } from '../../shell/activity-line.js';
import type { TuiComposerState, TuiShellState, TuiSurface } from '../../shell/index.js';
import { formatTuiKeybinding, type TuiKeybindingRegistry } from '../../shell/keybindings.js';
import { resolveTuiSessionCacheMetrics } from '../../../application/session-cache-metrics.js';
import type { TuiState } from '../../state/index.js';
import type { TranscriptActivitySource } from '../../transcript/store.js';
import type { TuiAccountStatus, TuiModel } from '../../../runtime/port.js';
import { tuiAccountNeedsLoginPrompt } from '../../../application/login-gate.js';
import type { TuiPermissionModeSnapshot } from '../interaction/permission-mode-flow.js';
import { isTuiDelegatedSession } from '../../../runtime/delegation.js';
import { resolveTuiThinkingChoice } from '../../features/model/thinking.js';
import { resolveTuiEffortChoice } from '../../features/model/effort.js';
import type { TuiPlanModeSnapshot } from '../interaction/plan-mode-flow.js';
import type { TuiLlmRetryEvent } from '../../../types/runtime-events.js';
import {
  formatSideConversationLabel,
  type TuiSideConversationPresentation,
} from '../../commands/side-session.js';

export interface ResolveTuiVisiblePresentationInput {
  readonly snapshot: TuiChatSnapshot;
  readonly connection: Pick<TuiState['connection'], 'phase' | 'generation' | 'lastError'>;
  readonly surface: TuiSurface;
  readonly currentLiveRunId?: string;
  readonly runtimeStoppingRunId?: string;
  readonly llmRetry?: TuiLlmRetryEvent;
  readonly transcript: TranscriptActivitySource;
  readonly runtimeQueuedCount: number;
  readonly queueEnabled: boolean;
  readonly keybindings?: TuiKeybindingRegistry;
  readonly activePermission: boolean;
  readonly activeQuestionnaire: boolean;
  readonly compacting: boolean;
  readonly transientHint?: string;
  readonly transientHintTone?: TuiComposerState['hintTone'];
  readonly attachmentCount: number;
  readonly draftCharacterCount?: number;
  readonly draftLineCount?: number;
  readonly goalDraft?: boolean;
  readonly version: string;
  readonly workspace: string;
  readonly homeDir?: string;
  readonly selectedModel?: TuiModel;
  /** Session-scoped think effort; the roster never reports the chosen level. */
  readonly selectedEffort?: string;
  readonly permissionMode?: TuiPermissionModeSnapshot;
  readonly planMode?: TuiPlanModeSnapshot;
  /** Present while a paired BTW side conversation exists; identifies the visible half. */
  readonly sideConversation?: TuiSideConversationPresentation;
  /** Earliest observed start of a Turn, kept across Session projection switches. */
  readonly turnStartedAtMs?: (turnId: string) => number | undefined;
}

export interface TuiVisiblePresentation {
  readonly activity: TuiActivityLineState;
  readonly composer: TuiComposerState;
  readonly shell: TuiShellState;
}

export function resolveTuiVisiblePresentation(
  input: ResolveTuiVisiblePresentationInput,
): TuiVisiblePresentation {
  const resolvedActivity = resolveVisibleActivity(input);
  // Anchor the timer to the Turn's real start; the activity line would otherwise
  // restart it whenever a projection switch briefly hides the run.
  const startedAtMs = resolvedActivity.runId
    ? input.turnStartedAtMs?.(resolvedActivity.runId)
    : undefined;
  const visibleActivity =
    startedAtMs === undefined ? resolvedActivity : { ...resolvedActivity, startedAtMs };
  const activity =
    visibleActivity.phase !== 'idle' &&
    visibleActivity.phase !== 'error' &&
    typeof input.snapshot.outputTokensPerSecond === 'number' &&
    Number.isFinite(input.snapshot.outputTokensPerSecond) &&
    input.snapshot.outputTokensPerSecond > 0
      ? {
          ...visibleActivity,
          outputTokensPerSecond: input.snapshot.outputTokensPerSecond,
          outputTokensPerSecondEstimated:
            input.snapshot.outputTokensPerSecondEstimated === true ? true : undefined,
        }
      : visibleActivity;
  const composer = resolveVisibleComposer(input);
  const shell = resolveStableShell(input);
  if (!mergesComposerHeader(input, activity)) return { activity, composer, shell };
  const draftLabel = resolveDraftLabel(input);
  return {
    activity: { ...activity, ...(draftLabel ? { draftLabel } : {}) },
    composer: { ...composer, headerHidden: true },
    shell,
  };
}

/** How to defer the draft using the current queue binding. */
function resolveDraftLabel(input: ResolveTuiVisiblePresentationInput): string | undefined {
  if (!input.queueEnabled) return undefined;
  const attachment = input.attachmentCount
    ? `${String(input.attachmentCount)} attachment${input.attachmentCount === 1 ? '' : 's'}`
    : undefined;
  const queue = `${formatTuiKeybinding('run.queue-draft', input.keybindings)} queue`;
  return attachment ? `${attachment} · ${queue}` : queue;
}

function resolveVisibleActivity(input: ResolveTuiVisiblePresentationInput): TuiActivityLineState {
  const runId =
    input.snapshot.activeTurnId ??
    input.snapshot.retiringTurnId ??
    input.runtimeStoppingRunId ??
    input.currentLiveRunId;
  const error = input.snapshot.status === 'error' ? input.snapshot.error?.trim() : undefined;
  if (error) {
    // Session errors stay turn-less unless an active or matching failed turn proves ownership.
    const visibleError = input.transcript.findVisibleError(error);
    const errorRunId = runId ?? visibleError?.turnId;
    return visibleError
      ? { phase: 'error', errorSettled: true, ...(errorRunId ? { runId: errorRunId } : {}) }
      : { phase: 'error', message: error, ...(errorRunId ? { runId: errorRunId } : {}) };
  }
  // Reconciliation clears snapshot errors; retain transcript-proven failure for the latest turn.
  const settledFailure = !runId ? input.transcript.latestSettledFailure() : undefined;
  if (settledFailure) {
    return {
      phase: 'error',
      errorSettled: true,
      ...(settledFailure.turnId ? { runId: settledFailure.turnId } : {}),
    };
  }
  const controls = resolveActivityControls(input, runId);
  const reconnecting =
    input.connection.phase === 'disconnected' ||
    (input.connection.phase === 'reconciling' && input.connection.generation > 1);
  if (reconnecting) {
    return {
      phase: 'reconnecting',
      runId,
      ...controls,
      ...(input.connection.lastError ? { message: input.connection.lastError } : {}),
    };
  }
  if (input.compacting) return { phase: 'compacting', runId, ...controls };
  if (
    (input.snapshot.cancelling || input.snapshot.retiringTurnId || input.runtimeStoppingRunId) &&
    runId
  ) {
    // Stopping already consumed the interrupt and refuses new guidance: offer neither.
    return { phase: 'stopping', runId };
  }
  if (input.llmRetry) {
    const retryReason = input.llmRetry.error?.reason
      ? formatRetryReason(input.llmRetry.error.reason)
      : undefined;
    const retryCode = input.llmRetry.error?.code;
    const retryDelay = input.llmRetry.delayMs;
    return {
      phase: 'retrying',
      runId,
      ...controls,
      message: `Retrying model request · ${String(input.llmRetry.retryAttempt)}/${String(
        input.llmRetry.maxRetries,
      )}${retryDelay !== undefined ? ` · next in ${formatRetryDelay(retryDelay)}` : ''}${
        retryReason ? ` · ${retryReason}` : ''
      }${retryCode !== undefined ? ` · code ${String(retryCode)}` : ''}`,
    };
  }
  if (input.activePermission || input.activeQuestionnaire) return { phase: 'idle', runId };
  if (input.snapshot.status === 'starting') {
    return runId
      ? { phase: 'loading', runId, ...controls }
      : { phase: 'loading', loadingTarget: 'session' };
  }
  if (runId) {
    return input.transcript.hasConcreteTurnActivity(runId)
      ? { phase: 'running', runId, ...controls }
      : { phase: 'loading', runId, ...controls };
  }
  return { phase: 'idle' };
}

function formatRetryDelay(delayMs: number): string {
  if (delayMs < 1_000) return `${String(Math.max(0, Math.round(delayMs)))}ms`;
  return `${String(Math.max(1, Math.ceil(delayMs / 1_000)))}s`;
}

function formatRetryReason(reason: string): string {
  return reason
    .split('_')
    .map((part) => `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1)}`)
    .join(' ');
}

/**
 * The activity line owns the controls that act on the live run, so they are only offered while
 * such a run exists: compaction runs without one, and a blocked surface owes its answer first.
 * Steering additionally needs a Runtime that accepts an active-Turn Draft.
 */
function resolveActivityControls(
  input: ResolveTuiVisiblePresentationInput,
  runId: string | undefined,
): { controls?: readonly TuiActivityControl[] } {
  if (!runId || input.activePermission || input.activeQuestionnaire) return {};
  return {
    controls: input.queueEnabled
      ? (['guide', 'details', 'interrupt'] as const)
      : (['details', 'interrupt'] as const),
  };
}

/**
 * While the activity line is visible it carries the draft label too, so the composer header is
 * suppressed and the two rows collapse into one. A transient hint or a blocked surface keeps its
 * own row, because that text replaces the draft label rather than qualifying the run.
 */
function mergesComposerHeader(
  input: ResolveTuiVisiblePresentationInput,
  activity: TuiActivityLineState,
): boolean {
  if (activity.phase === 'idle' || activity.phase === 'error') return false;
  if (input.activePermission || input.activeQuestionnaire) return false;
  return !input.transientHint?.trim();
}

function resolveVisibleComposer(input: ResolveTuiVisiblePresentationInput): TuiComposerState {
  const blocked = input.activePermission || input.activeQuestionnaire;
  const running = Boolean(
    input.snapshot.activeTurnId ??
    input.snapshot.retiringTurnId ??
    input.runtimeStoppingRunId ??
    input.currentLiveRunId,
  );
  const mode = blocked
    ? 'blocked'
    : running
      ? input.queueEnabled
        ? 'follow-up'
        : 'working'
      : input.runtimeQueuedCount > 0
        ? 'follow-up'
        : input.goalDraft
          ? 'goal'
          : 'message';
  const hint =
    input.transientHint ??
    resolvePlanTransitionHint(input.planMode) ??
    (running
      ? input.runtimeStoppingRunId
        ? 'Stopping · draft preserved'
        : undefined
      : input.runtimeQueuedCount > 0
        ? `Message · ${formatTuiKeybinding('tui.input.submit', input.keybindings)} send`
        : undefined);
  return {
    surface: input.surface,
    mode,
    ...(input.sideConversation
      ? {
          ...(input.sideConversation.view === 'side'
            ? { placeholder: 'Ask a side question…' }
            : {}),
          contextLabel: formatSideConversationLabel(
            input.sideConversation,
            formatTuiKeybinding('app.toggle-side-session', input.keybindings),
            formatTuiKeybinding('app.clear', input.keybindings),
          ),
        }
      : {}),
    ...(hint ? { hint } : {}),
    ...(input.runtimeStoppingRunId
      ? { hintTone: 'danger' as const }
      : input.transientHint && input.transientHintTone
        ? { hintTone: input.transientHintTone }
        : {}),
    ...(blocked
      ? { attention: input.activePermission ? ('permission' as const) : ('question' as const) }
      : {}),
    attachmentCount: input.attachmentCount,
    ...(input.draftCharacterCount === undefined
      ? {}
      : { draftCharacterCount: input.draftCharacterCount }),
    ...(input.draftLineCount === undefined ? {} : { draftLineCount: input.draftLineCount }),
  };
}

function resolvePlanTransitionHint(planMode: TuiPlanModeSnapshot | undefined): string | undefined {
  if (planMode?.transition === 'next-message') {
    return planMode.displayMode === 'plan'
      ? 'Plan Mode · next message enters Plan'
      : 'Default Mode · next message exits Plan';
  }
  if (planMode?.transition === 'submitting') {
    return `${planMode.displayMode === 'plan' ? 'Plan' : 'Default'} Mode change submitting…`;
  }
  return undefined;
}

function resolveStableShell(input: ResolveTuiVisiblePresentationInput): TuiShellState {
  const session = input.snapshot.session;
  const delegatedSession = session && isTuiDelegatedSession(session) ? session : undefined;
  const parentSession = delegatedSession
    ? input.snapshot.sessions.find(
        ({ sessionId }) => sessionId === delegatedSession.parentSessionId,
      )
    : undefined;
  const sessionCacheMetrics = resolveTuiSessionCacheMetrics(input.snapshot.sessionUsage);
  return {
    version: input.version,
    workspace: session?.workspaceDir ?? input.workspace,
    homeDir: input.homeDir,
    runtimeStatus:
      input.snapshot.status === 'error'
        ? 'error'
        : input.snapshot.account?.status === 'needs-login'
          ? 'offline'
          : 'ready',
    sessionTitle: session?.title ?? 'New session',
    sessionRole: delegatedSession ? 'subagent' : 'root',
    sessionAgentName: delegatedSession?.agentName,
    parentSessionTitle: delegatedSession
      ? (parentSession?.title ?? delegatedSession.parentSessionId)
      : undefined,
    ...resolveAccountShellState(input.snapshot.account, input.selectedModel, input.selectedEffort),
    sessionCount: input.snapshot.sessions.length,
    sessionCacheReadRatio: sessionCacheMetrics?.cacheReadRatio,
    contextUsage: input.snapshot.contextSnapshot?.contextUsage,
    contextWindowTokens:
      input.snapshot.contextSnapshot?.model?.contextWindow ??
      (session ? undefined : input.selectedModel?.contextLimit),
    busy: Boolean(input.currentLiveRunId),
    permissionMode: input.permissionMode?.mode,
    permissionModeUpdating: input.permissionMode?.updating ?? false,
    planMode: input.planMode?.displayMode,
    planModeTransition: input.planMode?.transition,
  };
}

function resolveAccountShellState(
  account: TuiAccountStatus | undefined,
  selectedModel: TuiModel | undefined,
  selectedEffort: string | undefined,
): Partial<TuiShellState> {
  const tokenPlan = account?.modelSource === 'token-plan';
  const selectedModelLabel = selectedModel
    ? selectedModel.displayName?.trim() || `${selectedModel.providerId}/${selectedModel.modelId}`
    : undefined;
  const effort = selectedModel ? resolveTuiEffortChoice(selectedModel, selectedEffort) : undefined;
  const thinking = selectedModel && !effort ? resolveTuiThinkingChoice(selectedModel) : undefined;
  // Resolve rather than echo: Thinking Off suppresses effort; otherwise use
  // the saved selection, catalog default, then the catalog midpoint.
  const variant =
    selectedModel?.variant && selectedModel.variant !== 'thinking'
      ? `#${selectedModel.variant}`
      : '';
  return {
    model: selectedModel ? `${selectedModelLabel}${variant}` : account?.defaultModel,
    ...(thinking ? { thinking } : {}),
    ...(effort ? { effort } : {}),
    accountStatus: resolveWelcomeAccountStatus(account),
    tokenPlanQuotaState: tokenPlan
      ? (account.tokenPlanQuotaState ?? (account.tokenPlanQuota ? 'available' : 'unavailable'))
      : undefined,
    tokenPlanQuota: tokenPlan ? account.tokenPlanQuota : undefined,
  };
}

function resolveWelcomeAccountStatus(account: TuiAccountStatus | undefined): string {
  if (!account) return 'Checking account';
  if (tuiAccountNeedsLoginPrompt(account)) return 'Sign in with /login';
  if (account.status === 'ready') return 'Account ready';
  if (account.status === 'warning') return 'Connected with warnings';
  return 'Account unavailable';
}
